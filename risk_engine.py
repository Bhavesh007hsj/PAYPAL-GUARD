#!/usr/bin/env python3
"""
PayGuard AI - Risk Scoring Engine
Transparent, deterministic risk assessment for small business payment transactions.
Designed for PayPal Sandbox and merchant safety monitoring.
"""

from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
import json
import sys
from typing import Any, Dict, List, Optional


@dataclass
class RiskThresholds:
    typical_amount: float = 85.00
    high_amount_multiplier: float = 3.0
    extreme_amount_multiplier: float = 6.0
    velocity_window_minutes: int = 15
    velocity_max_count: int = 3
    duplicate_window_minutes: int = 30
    duplicate_amount_tolerance: float = 0.01
    primary_currency: str = "USD"
    high_risk_cutoff: int = 70
    medium_risk_cutoff: int = 30


@dataclass
class RiskSignal:
    id: str
    name: str
    severity: str  # "low", "medium", "high"
    points: int
    description: str
    rule_name: str
    threshold: Any
    observed: Any


@dataclass
class RiskAssessment:
    transaction_id: str
    score: int
    risk_level: str  # "LOW", "MEDIUM", "HIGH"
    signals: List[RiskSignal]
    evaluated_at: str
    thresholds_used: Dict[str, Any]
    summary: str


def parse_iso_datetime(dt_str: Optional[str]) -> datetime:
    """Parse standard ISO 8601 timestamps gracefully."""
    if not dt_str:
        return datetime.now(timezone.utc)
    try:
        # Replace Z with UTC offset
        clean_str = dt_str.replace("Z", "+00:00")
        return datetime.fromisoformat(clean_str)
    except Exception:
        return datetime.now(timezone.utc)


def check_amount_anomaly(
    tx: Dict[str, Any],
    thresholds: RiskThresholds
) -> List[RiskSignal]:
    signals = []
    amount = float(tx.get("amount", 0.0))
    typical = thresholds.typical_amount

    if typical <= 0:
        return signals

    ratio = amount / typical

    if ratio >= thresholds.extreme_amount_multiplier:
        signals.append(RiskSignal(
            id="EXTREME_AMOUNT_OUTLIER",
            name="Extreme Transaction Amount",
            severity="high",
            points=45,
            description=f"Transaction amount of ${amount:,.2f} is {ratio:.1f}x higher than your typical average ticket (${typical:,.2f}).",
            rule_name="Unusually High Amount Check",
            threshold=f">={thresholds.extreme_amount_multiplier}x typical (${typical * thresholds.extreme_amount_multiplier:,.2f})",
            observed=f"${amount:,.2f} ({ratio:.1f}x typical)"
        ))
    elif ratio >= thresholds.high_amount_multiplier:
        signals.append(RiskSignal(
            id="HIGH_AMOUNT_OUTLIER",
            name="Elevated Transaction Amount",
            severity="medium",
            points=25,
            description=f"Transaction amount of ${amount:,.2f} exceeds {thresholds.high_amount_multiplier}x your typical baseline (${typical:,.2f}).",
            rule_name="Unusually High Amount Check",
            threshold=f">={thresholds.high_amount_multiplier}x typical (${typical * thresholds.high_amount_multiplier:,.2f})",
            observed=f"${amount:,.2f} ({ratio:.1f}x typical)"
        ))

    return signals


def check_velocity_spike(
    tx: Dict[str, Any],
    history: List[Dict[str, Any]],
    thresholds: RiskThresholds
) -> List[RiskSignal]:
    signals = []
    tx_time = parse_iso_datetime(tx.get("timestamp"))
    tx_id = tx.get("id")
    buyer_email = (tx.get("buyer_email") or "").strip().lower()
    ip_address = (tx.get("ip_address") or "").strip()

    if not history or (not buyer_email and not ip_address):
        return signals

    # Count recent transactions matching same email or IP within window
    window_secs = thresholds.velocity_window_minutes * 60
    matching_count = 0

    for past_tx in history:
        if past_tx.get("id") == tx_id:
            continue
        past_time = parse_iso_datetime(past_tx.get("timestamp"))
        delta = abs((tx_time - past_time).total_seconds())

        if delta <= window_secs:
            past_email = (past_tx.get("buyer_email") or "").strip().lower()
            past_ip = (past_tx.get("ip_address") or "").strip()
            if (buyer_email and past_email == buyer_email) or (ip_address and past_ip == ip_address):
                matching_count += 1

    total_orders = matching_count + 1

    if total_orders >= thresholds.velocity_max_count:
        signals.append(RiskSignal(
            id="VELOCITY_BURST",
            name="Rapid Transaction Velocity",
            severity="high",
            points=35,
            description=f"Detected {total_orders} total orders from the same buyer or IP address within {thresholds.velocity_window_minutes} minutes (threshold: {thresholds.velocity_max_count}).",
            rule_name="Rapid Activity Burst Rule",
            threshold=f">={thresholds.velocity_max_count} total orders in {thresholds.velocity_window_minutes}m",
            observed=f"{total_orders} orders"
        ))
    elif total_orders >= 2:
        signals.append(RiskSignal(
            id="ELEVATED_VELOCITY",
            name="Frequent Activity",
            severity="low",
            points=15,
            description=f"Detected {total_orders} total orders recorded from this buyer/IP within {thresholds.velocity_window_minutes} minutes.",
            rule_name="Rapid Activity Burst Rule",
            threshold=f"2-{thresholds.velocity_max_count - 1} total orders in {thresholds.velocity_window_minutes}m",
            observed=f"{total_orders} orders"
        ))

    return signals


def check_duplicate_payment(
    tx: Dict[str, Any],
    history: List[Dict[str, Any]],
    thresholds: RiskThresholds
) -> List[RiskSignal]:
    signals = []
    tx_time = parse_iso_datetime(tx.get("timestamp"))
    tx_id = tx.get("id")
    amount = float(tx.get("amount", 0.0))
    buyer_email = (tx.get("buyer_email") or "").strip().lower()

    if not history or not buyer_email or amount <= 0:
        return signals

    dup_window_secs = thresholds.duplicate_window_minutes * 60

    for past_tx in history:
        if past_tx.get("id") == tx_id:
            continue
        past_email = (past_tx.get("buyer_email") or "").strip().lower()
        if past_email != buyer_email:
            continue

        past_amount = float(past_tx.get("amount", 0.0))
        if abs(past_amount - amount) <= thresholds.duplicate_amount_tolerance:
            past_time = parse_iso_datetime(past_tx.get("timestamp"))
            delta = abs((tx_time - past_time).total_seconds())
            if delta <= dup_window_secs:
                minutes_apart = max(1, int(delta // 60))
                signals.append(RiskSignal(
                    id="SUSPECTED_DUPLICATE",
                    name="Potential Duplicate Payment",
                    severity="medium",
                    points=30,
                    description=f"Identical amount (${amount:,.2f}) submitted by {buyer_email} within {minutes_apart} minutes of transaction {past_tx.get('id')}.",
                    rule_name="Duplicate Charge Safety Rule",
                    threshold=f"Identical amount within {thresholds.duplicate_window_minutes}m",
                    observed=f"${past_amount:,.2f} recorded {minutes_apart}m prior"
                ))
                break

    return signals


def check_currency_and_status(
    tx: Dict[str, Any],
    thresholds: RiskThresholds
) -> List[RiskSignal]:
    signals = []
    currency = (tx.get("currency") or "USD").upper()
    status = (tx.get("status") or "COMPLETED").upper()

    # Currency anomaly
    if currency != thresholds.primary_currency.upper():
        signals.append(RiskSignal(
            id="FOREIGN_CURRENCY_ANOMALY",
            name="Unusual Billing Currency",
            severity="low",
            points=15,
            description=f"Transaction billed in {currency}, differing from your standard store default ({thresholds.primary_currency}).",
            rule_name="Currency Consistency Rule",
            threshold=thresholds.primary_currency,
            observed=currency
        ))

    # Payment Status anomaly
    if status == "COMPLETED":
        pass  # Success status: 0 penalty points
    elif status in ["PENDING", "ON_HOLD", "HELD_BY_PAYPAL"]:
        signals.append(RiskSignal(
            id="STATUS_PENDING_HOLD",
            name="Payment Settlement Pending",
            severity="medium",
            points=20,
            description=f"PayPal status is currently '{status}'. Funds are pending buyer approval or settlement capture.",
            rule_name="Payment Status Verification",
            threshold="COMPLETED",
            observed=status
        ))
    elif status in ["DENIED", "FAILED", "VOIDED", "DECLINED"]:
        signals.append(RiskSignal(
            id="STATUS_DENIED",
            name="Payment Denied or Voided",
            severity="high",
            points=40,
            description=f"PayPal status is currently '{status}'. Payment authorization was declined, voided, or denied by PayPal.",
            rule_name="Payment Status Verification",
            threshold="COMPLETED",
            observed=status
        ))
    elif status in ["REVERSED", "REFUNDED", "PARTIALLY_REFUNDED"]:
        signals.append(RiskSignal(
            id="STATUS_REVERSED",
            name="Payment Reversed or Refunded",
            severity="high",
            points=40,
            description=f"PayPal status is currently '{status}'. Funds have been reversed, disputed, or refunded.",
            rule_name="Payment Status Verification",
            threshold="COMPLETED",
            observed=status
        ))

    return signals


def check_field_completeness(
    tx: Dict[str, Any],
    thresholds: RiskThresholds
) -> List[RiskSignal]:
    signals = []
    missing_fields = []

    buyer_name = (tx.get("buyer_name") or "").strip()
    buyer_email = (tx.get("buyer_email") or "").strip()
    billing_zip = (tx.get("billing_zip") or "").strip()
    billing_country = (tx.get("billing_country") or "").strip()
    shipping_country = (tx.get("shipping_country") or "").strip()

    if not buyer_email:
        missing_fields.append("buyer_email")
    if not buyer_name:
        missing_fields.append("buyer_name")
    if not billing_zip and not billing_country:
        missing_fields.append("billing_address")

    if missing_fields:
        count = len(missing_fields)
        points = 20 if count > 1 else 10
        severity = "medium" if count > 1 else "low"
        signals.append(RiskSignal(
            id="INCOMPLETE_BUYER_METADATA",
            name="Incomplete Transaction Metadata",
            severity=severity,
            points=points,
            description=f"Missing vital transaction fields: {', '.join(missing_fields)}. Makes order verification harder.",
            rule_name="Field Completeness Check",
            threshold="All core fields present (email, name, address)",
            observed=f"Missing {count} field(s)"
        ))

    # Billing vs Shipping Country mismatch
    if billing_country and shipping_country and billing_country.upper() != shipping_country.upper():
        signals.append(RiskSignal(
            id="COUNTRY_MISMATCH",
            name="Billing & Shipping Country Mismatch",
            severity="medium",
            points=20,
            description=f"Billing address country ({billing_country.upper()}) differs from shipping destination ({shipping_country.upper()}).",
            rule_name="Geographic Consistency Rule",
            threshold="Matching billing and shipping countries",
            observed=f"Billing: {billing_country.upper()}, Shipping: {shipping_country.upper()}"
        ))

    return signals


def assess_transaction(
    tx: Dict[str, Any],
    history: Optional[List[Dict[str, Any]]] = None,
    thresholds: Optional[RiskThresholds] = None
) -> RiskAssessment:
    """
    Evaluates a transaction against transparent deterministic rules.
    Returns calculated score, level, signals list, and structured summary.
    """
    if thresholds is None:
        thresholds = RiskThresholds()
    if history is None:
        history = []

    all_signals: List[RiskSignal] = []

    # Run individual deterministic rules
    all_signals.extend(check_amount_anomaly(tx, thresholds))
    all_signals.extend(check_velocity_spike(tx, history, thresholds))
    all_signals.extend(check_duplicate_payment(tx, history, thresholds))
    all_signals.extend(check_currency_and_status(tx, thresholds))
    all_signals.extend(check_field_completeness(tx, thresholds))

    # Sum points and cap at 100
    raw_score = sum(s.points for s in all_signals)
    score = min(100, max(0, raw_score))

    # Determine risk level
    if score >= thresholds.high_risk_cutoff:
        risk_level = "HIGH"
    elif score >= thresholds.medium_risk_cutoff:
        risk_level = "MEDIUM"
    else:
        risk_level = "LOW"

    # Create summary description
    if not all_signals:
        summary = "Standard transaction pattern. Amount and details align with normal store history."
    else:
        signal_names = [s.name for s in all_signals]
        summary = f"Flagged with {len(all_signals)} risk signal(s): {', '.join(signal_names)}."

    tx_id = str(tx.get("id", "TX_UNKNOWN"))
    now_iso = datetime.now(timezone.utc).isoformat()

    return RiskAssessment(
        transaction_id=tx_id,
        score=score,
        risk_level=risk_level,
        signals=all_signals,
        evaluated_at=now_iso,
        thresholds_used=asdict(thresholds),
        summary=summary
    )


def generate_deterministic_explanation(
    tx: Dict[str, Any],
    assessment: RiskAssessment
) -> Dict[str, Any]:
    """
    Deterministic plain-language explanation generator for small businesses.
    Serves as an instant, reliable fallback whenever AI model services are unavailable.
    Explicitly separates detected facts from possible interpretations.
    """
    amount = float(tx.get("amount", 0.0))
    currency = tx.get("currency", "USD")
    buyer = tx.get("buyer_name") or tx.get("buyer_email") or "Customer"
    signals = assessment.signals

    detected_facts = [
        f"Transaction amount: ${amount:,.2f} {currency} from {buyer}.",
        f"Evaluated against standard store baseline of ${assessment.thresholds_used['typical_amount']:,.2f}."
    ]

    for s in signals:
        detected_facts.append(f"{s.name}: {s.description}")

    interpretations = []
    recommended_actions = []

    if assessment.risk_level == "HIGH":
        interpretations.append(
            "Multiple elevated indicators combined suggest reviewing this order manually before shipping items or providing services."
        )
        if any(s.id == "SUSPECTED_DUPLICATE" for s in signals):
            interpretations.append("The customer may have accidentally clicked 'Pay' multiple times or refreshed during checkout.")
            recommended_actions.append("Check your PayPal Sandbox activity log for matching duplicate captures to avoid unintended double billing.")
        if any("AMOUNT" in s.id for s in signals):
            interpretations.append("An unusually large basket could indicate a legitimate wholesale order, or an attempt to purchase high-value goods.")
            recommended_actions.append("Confirm customer contact details or verify business identity before dispatching goods.")
        if any(s.id == "VELOCITY_BURST" for s in signals):
            interpretations.append("A burst of multiple card attempts in quick succession can occur with automated bots testing numbers.")
            recommended_actions.append("Delay fulfillment for 24-48 hours to ensure payment settles without a dispute or chargeback.")
    elif assessment.risk_level == "MEDIUM":
        interpretations.append(
            "This payment has slight deviations from your typical orders, but may well be normal customer behavior."
        )
        recommended_actions.append("Perform a quick verification of shipping address and email validity before fulfillment.")
    else:
        interpretations.append(
            "The transaction metrics match standard customer purchasing patterns for your business."
        )
        recommended_actions.append("Standard fulfillment: no additional precautions required.")

    return {
        "engine": "PayGuard Rule Engine (Deterministic Fallback)",
        "risk_level": assessment.risk_level,
        "score": assessment.score,
        "overview": (
            f"PayGuard scored this transaction at {assessment.score}/100 ({assessment.risk_level} Risk). "
            f"{'No anomalies were detected.' if not signals else f'Identified {len(signals)} specific signal(s) requiring merchant awareness.'}"
        ),
        "detected_facts": detected_facts,
        "possible_interpretations": interpretations,
        "recommended_merchant_actions": recommended_actions,
        "disclaimer": (
            "PayGuard AI provides decision support signals based on configurable rules. "
            "These signals do not prove fraud; always apply merchant judgment."
        )
    }


def main():
    """CLI interface for pipe-based scoring: reads JSON from stdin and prints assessment JSON."""
    if len(sys.argv) > 1 and sys.argv[1] == "--version":
        print("PayGuard AI Risk Engine v1.0.0")
        return

    try:
        raw_input = sys.stdin.read()
        if not raw_input.strip():
            print(json.dumps({"error": "Empty input"}))
            sys.exit(1)

        payload = json.loads(raw_input)
        tx = payload.get("transaction", {})
        history = payload.get("history", [])
        thresholds_dict = payload.get("thresholds", {})
        thresholds = RiskThresholds(**thresholds_dict) if thresholds_dict else RiskThresholds()

        assessment = assess_transaction(tx, history, thresholds)
        explanation = generate_deterministic_explanation(tx, assessment)

        result = {
            "assessment": asdict(assessment),
            "explanation": explanation
        }
        print(json.dumps(result, indent=2))
    except Exception as e:
        print(json.dumps({"error": str(e)}), file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
