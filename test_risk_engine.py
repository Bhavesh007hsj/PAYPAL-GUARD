#!/usr/bin/env python3
"""
Unit tests for PayGuard AI Python Risk Scoring Engine.
Tests all deterministic rules, threshold adjustments, scoring caps, and fallback explanations.
"""

import unittest
from datetime import datetime, timezone, timedelta
from risk_engine import (
    RiskThresholds,
    RiskSignal,
    assess_transaction,
    check_amount_anomaly,
    check_velocity_spike,
    check_duplicate_payment,
    check_currency_and_status,
    check_field_completeness,
    generate_deterministic_explanation
)


class TestPayGuardRiskEngine(unittest.TestCase):

    def setUp(self):
        self.now = datetime.now(timezone.utc)
        self.base_thresholds = RiskThresholds(
            typical_amount=80.00,
            high_amount_multiplier=3.0,     # >= 240
            extreme_amount_multiplier=6.0,  # >= 480
            velocity_window_minutes=15,
            velocity_max_count=3,
            duplicate_window_minutes=30,
            primary_currency="USD",
            high_risk_cutoff=70,
            medium_risk_cutoff=30
        )

    def test_clean_normal_transaction(self):
        """A regular purchase within normal bounds should score LOW risk."""
        tx = {
            "id": "TX_CLEAN_1",
            "amount": 75.00,
            "currency": "USD",
            "status": "COMPLETED",
            "buyer_name": "Alice Standard",
            "buyer_email": "alice@example.com",
            "billing_zip": "90210",
            "billing_country": "US",
            "shipping_country": "US",
            "timestamp": self.now.isoformat()
        }
        assessment = assess_transaction(tx, history=[], thresholds=self.base_thresholds)
        self.assertEqual(assessment.risk_level, "LOW")
        self.assertEqual(assessment.score, 0)
        self.assertEqual(len(assessment.signals), 0)

    def test_amount_anomaly_medium_and_extreme(self):
        """Amounts above 3x baseline flag medium; above 6x flag extreme."""
        tx_medium = {
            "id": "TX_MED",
            "amount": 260.00,  # 3.25x typical $80
            "currency": "USD"
        }
        signals_med = check_amount_anomaly(tx_medium, self.base_thresholds)
        self.assertEqual(len(signals_med), 1)
        self.assertEqual(signals_med[0].id, "HIGH_AMOUNT_OUTLIER")
        self.assertEqual(signals_med[0].points, 25)

        tx_extreme = {
            "id": "TX_EXTREME",
            "amount": 550.00,  # 6.8x typical $80
            "currency": "USD"
        }
        signals_ext = check_amount_anomaly(tx_extreme, self.base_thresholds)
        self.assertEqual(len(signals_ext), 1)
        self.assertEqual(signals_ext[0].id, "EXTREME_AMOUNT_OUTLIER")
        self.assertEqual(signals_ext[0].points, 45)

    def test_velocity_spike_detection(self):
        """Repeated rapid attempts within 15 minutes trigger velocity burst."""
        email = "speedy_buyer@example.com"
        now_iso = self.now.isoformat()

        # Build 3 prior transactions within 5 minutes
        history = [
            {"id": f"TX_PAST_{i}", "buyer_email": email, "timestamp": (self.now - timedelta(minutes=i*2)).isoformat()}
            for i in range(1, 4)
        ]

        current_tx = {
            "id": "TX_CURRENT",
            "buyer_email": email,
            "timestamp": now_iso
        }

        signals = check_velocity_spike(current_tx, history, self.base_thresholds)
        self.assertTrue(any(s.id == "VELOCITY_BURST" for s in signals))
        burst_signal = next(s for s in signals if s.id == "VELOCITY_BURST")
        self.assertEqual(burst_signal.points, 35)

    def test_duplicate_payment_detection(self):
        """Identical amount by same buyer within 30 minutes triggers duplicate warning."""
        email = "double_clicker@example.com"
        prior_time = (self.now - timedelta(minutes=4)).isoformat()

        history = [
            {
                "id": "TX_FIRST",
                "buyer_email": email,
                "amount": 129.99,
                "timestamp": prior_time
            }
        ]

        current_tx = {
            "id": "TX_SECOND",
            "buyer_email": email,
            "amount": 129.99,
            "timestamp": self.now.isoformat()
        }

        signals = check_duplicate_payment(current_tx, history, self.base_thresholds)
        self.assertEqual(len(signals), 1)
        self.assertEqual(signals[0].id, "SUSPECTED_DUPLICATE")
        self.assertEqual(signals[0].points, 30)

    def test_currency_and_status_anomalies(self):
        """Foreign currency and distinct statuses generate appropriate signals."""
        tx_foreign = {
            "currency": "EUR",
            "status": "PENDING"
        }
        signals = check_currency_and_status(tx_foreign, self.base_thresholds)
        signal_ids = [s.id for s in signals]
        self.assertIn("FOREIGN_CURRENCY_ANOMALY", signal_ids)
        self.assertIn("STATUS_PENDING_HOLD", signal_ids)

        # Denied status
        tx_denied = {"status": "DENIED", "currency": "USD"}
        denied_signals = check_currency_and_status(tx_denied, self.base_thresholds)
        self.assertTrue(any(s.id == "STATUS_DENIED" for s in denied_signals))

        # Reversed status
        tx_reversed = {"status": "REVERSED", "currency": "USD"}
        reversed_signals = check_currency_and_status(tx_reversed, self.base_thresholds)
        self.assertTrue(any(s.id == "STATUS_REVERSED" for s in reversed_signals))

        # Completed status has zero penalty
        tx_clean = {"status": "COMPLETED", "currency": "USD"}
        clean_signals = check_currency_and_status(tx_clean, self.base_thresholds)
        self.assertEqual(len(clean_signals), 0)

    def test_velocity_three_total_orders_triggers_threshold(self):
        """Exactly three total orders in the window trigger a threshold of three."""
        email = "speedy_exact@example.com"
        now_iso = self.now.isoformat()

        # 2 past orders + 1 current = 3 total orders
        history = [
            {"id": "PAST_1", "buyer_email": email, "timestamp": (self.now - timedelta(minutes=4)).isoformat()},
            {"id": "PAST_2", "buyer_email": email, "timestamp": (self.now - timedelta(minutes=2)).isoformat()},
        ]
        current_tx = {"id": "CURR_3", "buyer_email": email, "timestamp": now_iso}

        signals = check_velocity_spike(current_tx, history, self.base_thresholds)
        burst_signal = next((s for s in signals if s.id == "VELOCITY_BURST"), None)
        self.assertIsNotNone(burst_signal, "Three total orders must trigger VELOCITY_BURST at threshold 3")
        self.assertEqual(burst_signal.points, 35)

    def test_field_completeness_and_mismatch(self):
        """Missing required buyer data and country mismatch should be detected."""
        tx_incomplete = {
            "buyer_email": "",
            "buyer_name": "",
            "billing_country": "US",
            "shipping_country": "GB"
        }
        signals = check_field_completeness(tx_incomplete, self.base_thresholds)
        signal_ids = [s.id for s in signals]
        self.assertIn("INCOMPLETE_BUYER_METADATA", signal_ids)
        self.assertIn("COUNTRY_MISMATCH", signal_ids)

    def test_compound_high_risk_score_capped_at_100(self):
        """Multiple combined risk factors correctly aggregate into HIGH risk score up to 100."""
        email = "risky@example.com"
        history = [
            {"id": "PAST_1", "buyer_email": email, "amount": 600.00, "timestamp": (self.now - timedelta(minutes=2)).isoformat()},
            {"id": "PAST_2", "buyer_email": email, "amount": 600.00, "timestamp": (self.now - timedelta(minutes=4)).isoformat()},
            {"id": "PAST_3", "buyer_email": email, "amount": 600.00, "timestamp": (self.now - timedelta(minutes=6)).isoformat()}
        ]

        high_risk_tx = {
            "id": "TX_HIGH_COMPOUND",
            "amount": 600.00,  # Extreme amount (45 pts)
            "currency": "GBP",  # Foreign currency (15 pts)
            "status": "ON_HOLD",  # Status hold (20 pts)
            "buyer_email": email,  # Velocity burst (35 pts) & Duplicate (30 pts)
            "timestamp": self.now.isoformat(),
            "billing_country": "US",
            "shipping_country": "DE"  # Country mismatch (20 pts)
        }

        assessment = assess_transaction(high_risk_tx, history=history, thresholds=self.base_thresholds)
        self.assertEqual(assessment.risk_level, "HIGH")
        self.assertEqual(assessment.score, 100)  # Capped at 100
        self.assertGreaterEqual(len(assessment.signals), 4)

    def test_deterministic_explanation_generation(self):
        """The deterministic explanation fallback provides clear facts vs interpretations."""
        tx = {
            "id": "TX_EXP_TEST",
            "amount": 350.00,
            "currency": "USD",
            "buyer_name": "Bob Caution",
            "buyer_email": "bob@example.com"
        }
        assessment = assess_transaction(tx, history=[], thresholds=self.base_thresholds)
        explanation = generate_deterministic_explanation(tx, assessment)

        self.assertIn("detected_facts", explanation)
        self.assertIn("possible_interpretations", explanation)
        self.assertIn("recommended_merchant_actions", explanation)
        self.assertIn("disclaimer", explanation)
        self.assertTrue(len(explanation["detected_facts"]) > 0)


if __name__ == "__main__":
    unittest.main()
