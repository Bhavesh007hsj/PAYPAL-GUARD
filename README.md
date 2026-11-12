# PayGuard AI — Small Business Payment Safety Assistant
### PayPal AI Hackathon Official Submission

PayGuard AI is an intelligent payment safety assistant built specifically for small businesses (SMBs). It combines **PayPal Developer Sandbox REST API integration** with a **dual-layer explainability engine**—pairing transparent deterministic arithmetic rules with grounded generative AI (Google Gemini 2.5 Flash) and an **Agentic Commerce triage co-pilot** to help small merchants detect anomalous checkout activity, understand risk signals in plain English, and execute decisive merchant review actions (Refund, Hold, Capture, 2FA) directly in the PayPal Sandbox.

> **Hackathon Prototype Notice & Responsible AI Disclaimer:**  
> PayGuard AI runs strictly in the PayPal Developer Sandbox and safe demo mode. It processes sandbox data only and never initiates real financial transfers or live charges. It provides merchant decision-support signals and does **not** claim to prove fraud or replace formal financial underwriting.

---

## Key Features & Actual Capabilities

### 1. Real PayPal Sandbox Checkout Flow
- **Order Creation:** Creates authentic sandbox checkout orders via PayPal Orders v2 REST API (`POST /v2/checkout/orders` with `intent: 'CAPTURE'`).
- **Buyer Approval:** Retrieves the authentic PayPal Sandbox approval URL (`https://www.sandbox.paypal.com/checkoutnow?token=...`), directing the buyer to authorize the payment using sandbox credentials.
- **Server-Side Capture:** Once approved, the merchant backend triggers server-side capture (`POST /v2/checkout/orders/{id}/capture`), securing settlement authorization.
- **Actual Capture ID Retention:** Extracts and persists the actual settlement `capture_id` from PayPal's response. This exact capture ID is stored on the transaction record and displayed in the audit trail.
- **Live Capture-ID-Bound Refunds:** Live PayPal refunds (`POST /v2/payments/captures/{capture_id}/refund`) use the verified capture ID. If an order lacks a valid capture ID, live refunds are **strictly disabled** in the UI and rejected server-side to protect financial integrity.

### 2. Clearly Labeled Synthetic Demo Fallback
- **Demo Mode Transparency:** When live PayPal credentials are not supplied or when offline testing is desired, PayGuard AI provides an explicitly labeled **Synthetic Demo Fallback**.
- **Clear Demarcation:** The UI and audit logs prominently distinguish real PayPal actions (`[Confirmed Live PayPal Sandbox API Response]`, `mode: live_sandbox_api`) from local store simulations (`[Local Store Simulation (Demo Mode)]`, `mode: simulated_local`).
- **Safety Safeguard:** Synthetic demo transactions can never trigger live external refund API calls.

### 3. Calibrated Velocity & Settlement Status Mapping
- **Calibrated Velocity Scoring:** Accurately accounts for total transactions in the rolling velocity window. When the threshold is set to 3, three total orders (2 past + 1 current) immediately trigger the `VELOCITY_BURST` rule (+35 pts). Two total orders trigger `ELEVATED_VELOCITY` (+15 pts).
- **Distinct Status Mapping:** Accurately maps PayPal API status codes into four distinct risk categories:
  - **Success (`COMPLETED`):** 0 risk penalty points.
  - **Pending (`PENDING`, `ON_HOLD`):** Flags `STATUS_PENDING_HOLD` (+20 pts).
  - **Denied (`DENIED`, `FAILED`, `VOIDED`):** Flags `STATUS_DENIED` (+40 pts).
  - **Reversed (`REVERSED`, `REFUNDED`):** Flags `STATUS_REVERSED` (+40 pts).

### 4. Security & Server Boundaries
- **Loopback Binding (`127.0.0.1`):** The Express server binds strictly to `127.0.0.1` (localhost loopback) instead of `0.0.0.0`, mitigating external network probing and securing local execution.
- **Server-Side Secret Isolation:** All PayPal client credentials and Gemini API keys remain strictly server-side. Neither secret keys nor unmasked customer data are ever exposed to client bundles or browser logs.
- **AI Proposal Guardrails:** AI-generated triage proposals are strictly validated server-side against an allowlist of supported actions (`REFUND`, `HOLD`, `CAPTURE`, `REQUEST_2FA`) and review statuses (`PENDING`, `SAFE`, `HOLD`, `FLAGGED`), rejecting any model hallucinations or out-of-bounds actions.

---

## PayPal Sandbox Integration: Real API vs Local Simulations

PayGuard AI is completely transparent about what operations interact with PayPal's live Sandbox servers versus local store workflow simulations:

| Action / Feature | Execution Mode | Behavior & Verification |
| :--- | :--- | :--- |
| **OAuth2 Token Generation** | `Live PayPal Sandbox API` | Calls `POST https://api-m.sandbox.paypal.com/v1/oauth2/token` when credentials exist in `.env`. Falls back to demo status if unconfigured. |
| **Checkout Order Creation** | `Live PayPal Sandbox API` | Calls `POST https://api-m.sandbox.paypal.com/v2/checkout/orders` to initiate authentic sandbox payment. |
| **Buyer Approval** | `Live PayPal Sandbox API` | Directs customer to sandbox approval window (`/checkoutnow?token=...`). |
| **Server-Side Capture** | `Live PayPal Sandbox API` | Calls `POST https://api-m.sandbox.paypal.com/v2/checkout/orders/{id}/capture` and extracts actual `capture_id`. |
| **Capture Refund** (`REFUND`) | `Live PayPal Sandbox API` *(Conditional)* | Calls `POST https://api-m.sandbox.paypal.com/v2/payments/captures/{capture_id}/refund` using the verified capture ID.<br>• Disabled when capture ID is missing or when in demo mode.<br>• If PayPal returns an error, it is returned honestly (`success: false`, HTTP 422). |
| **Transaction Reporting Sync** | `Live PayPal Sandbox API` | Fetches transactions from `GET https://api-m.sandbox.paypal.com/v1/reporting/transactions`. |
| **Fulfillment Hold** (`HOLD`) | `Local Store Simulation` | Flags the order in the merchant's local fulfillment queue and halts shipping. Labeled `mode: 'simulated_local'`. |
| **Capture Approval** (`CAPTURE`) | `Local Store Simulation` | Approves the order for standard fulfillment in the merchant queue. Labeled `mode: 'simulated_local'`. |
| **Identity 2FA Request** (`REQUEST_2FA`) | `Local Store Simulation` | Simulates an out-of-band customer verification challenge and records the hold in the local audit log. |

> **Audit Trail Integrity:**  
> Every merchant action records an immutable audit entry labeled `[Confirmed Live PayPal Sandbox API Response]` or `[Local Store Simulation (Demo Mode)]` with a reference ID, timestamp, and explanation of funds impact.

---

## Data Provenance Architecture

PayGuard AI maintains strict technical separation between native PayPal data and contextual risk telemetry:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       DATA PROVENANCE SEPARATION                            │
├──────────────────────────────────────┬──────────────────────────────────────┤
│      PAYPAL SANDBOX NATIVE           │     PAYGUARD ENRICHED TELEMETRY      │
│  (Direct from PayPal REST API)       │     (Contextual / Computed)          │
├──────────────────────────────────────┼──────────────────────────────────────┤
│ • transaction_id / order_id          │ • ip_address (Simulated client IP)   │
│ • capture_id (Actual settlement ID)  │ • velocity_counter (15-min window)   │
│ • amount & currency ($720.00 USD)    │ • baseline_multiplier (8.5x baseline)│
│ • status (COMPLETED, ON_HOLD, etc.)  │ • geo_match (Billing vs shipping)    │
│ • buyer_name (Payer identity)        │ • duplicate_flag (30-min window)     │
│ • buyer_email (Privacy-masked)       │ • risk_score (0-100 arithmetic sum)  │
│ • billing_country / zip              │ • triggered_rules (Signal breakdown) │
│ • shipping_country                   │ • grounded_ai_explanation            │
└──────────────────────────────────────┴──────────────────────────────────────┘
```

Judges can inspect data provenance directly inside the **"Data Provenance Matrix"** tab of the PayPal Status Modal, or via the **Data Provenance Badge** (`PayPal Native` vs `AI Inferred`) on any transaction detail inspector.

---

## Dual-Layer AI & Explainability Architecture

PayGuard AI addresses the key flaws of pure LLM approaches (hallucinations, stochastic scoring, and privacy leaks) through a strict **Dual-Engine** design:

```
                          ┌─────────────────────────────┐
                          │   PayPal Sandbox Order /    │
                          │   Customer Ingestion Event  │
                          └──────────────┬──────────────┘
                                         │
                                         ▼
                 ┌───────────────────────────────────────────────┐
                 │       LAYER 1: DETERMINISTIC RISK ENGINE      │
                 │   (TypeScript Engine: src/utils/risk.ts)      │
                 │  - Unusually High Amount Check (3x, 6x mult)  │
                 │  - Rapid Velocity Burst Rule (15 min window)  │
                 │  - Duplicate Charge Check (30 min window)     │
                 │  - Foreign Currency & Distinct Status Checks  │
                 │  - Missing Metadata & Country Mismatches      │
                 └──────────────┬─────────────────┬──────────────┘
                                │                 │
               Deterministic    │                 │ Privacy-Masked
               Points (0–100)   │                 │ Telemetry Payload
                                │                 ▼
                                │     ┌───────────────────────────────┐
                                │     │  LAYER 2: EXPLAINABILITY AI   │
                                │     │  Google Gemini 2.5 Flash OR   │
                                │     │  Deterministic Fallback Engine│
                                │     └───────────────┬───────────────┘
                                │                     │ Plain-English
                                │                     │ Guidance & Proposal
                                ▼                     ▼
                 ┌───────────────────────────────────────────────┐
                 │          SMB DECISION SUPPORT DASHBOARD       │
                 │  - Visual Score Gauge & Auditable Signal List │
                 │  - Confirmed Facts vs Possible Interpretations│
                 │  - Validated Agentic Triage Proposal          │
                 │  - 1-Click PayPal Sandbox Merchant Action     │
                 └───────────────────────────────────────────────┘
```

### Engine Attribution:
- **Live Web Application Engine:** Powered by **TypeScript** (`src/utils/risk.ts`). All scoring, risk breakdowns, data provenance tagging, and deterministic triage proposals in the dashboard and Express backend run directly on this engine.
- **Reference Implementation:** A standalone **Python reference engine** (`risk_engine.py`) with its own unit tests (`test_risk_engine.py`) provides mathematical parity and serves as an independent benchmark.

### Strict AI Grounding & Privacy Principles:
- **Signal-Bounded Grounding:** The Gemini prompt strictly limits the model to synthesizing the server-calculated risk signals. It is instructed never to invent risk factors outside the provided data.
- **Separation of Facts vs. Interpretations:** Clearly distinguishes confirmed mathematical observations (e.g. *"Transaction amount is 8.5x higher than average ticket"*) from possible business explanations (e.g. *"Could indicate wholesale inquiry or unauthorized bulk order"*).
- **Privacy-First Data Sanitization:** Payer emails are masked (`m.***g@velocity-corp.org`) and zero card numbers (PANs) or CVVs are ever sent to the model.
- **Deterministic Fallback:** When `GEMINI_API_KEY` is not provided, the application generates structured, signal-specific explanations and triage proposals entirely deterministically.

---

## Transparent Risk Rules Matrix

| Rule Name | Trigger Condition | Points | Default Threshold |
| :--- | :--- | :--- | :--- |
| **Extreme Amount Outlier** | Basket size >= 6x store baseline | **+45 pts** | Baseline: $85.00, Cutoff: $510.00 |
| **High Amount Outlier** | Basket size >= 3x store baseline | **+25 pts** | Baseline: $85.00, Cutoff: $255.00 |
| **Rapid Velocity Burst** | >= 3 total orders from same buyer/IP in 15 mins | **+35 pts** | Rolling 15-minute window |
| **Elevated Velocity** | 2 total orders from same buyer/IP in 15 mins | **+15 pts** | Rolling 15-minute window |
| **Suspected Duplicate Payment** | Identical amount from same buyer within 30 mins | **+30 pts** | Window: 30 mins, Tolerance: $0.01 |
| **Geographic Mismatch** | Billing country differs from shipping country | **+20 pts** | Country code comparison |
| **Foreign Currency** | Currency code differs from store primary (USD) | **+15 pts** | Store primary: USD |
| **Denied or Voided Settlement** | PayPal status is DENIED, FAILED, or VOIDED | **+40 pts** | Non-completed authorization |
| **Reversed or Refunded Settlement** | PayPal status is REVERSED or REFUNDED | **+40 pts** | Settled reversal / refund |
| **Pending / Held Settlement** | PayPal status is ON_HOLD or PENDING | **+20 pts** | Awaiting capture or approval |
| **Incomplete Metadata** | Missing customer name, email, or billing address | **+10 to +20 pts** | Guest / incomplete checkout |

*All thresholds are dynamically configurable in **Rule Settings** with immediate storewide recalculation.*

---

## Concise 5-Step Live Demo Walkthrough (< 3 Minutes)

Evaluators can follow this walkthrough using the interactive **"Judge Walkthrough"** button in the app header:

### Step 1: Small-Business Problem & PayPal Architecture
- Open the application at `http://127.0.0.1:3000`.
- In the header, click **PayPal: Sandbox Demo**.
- Observe the active sandbox environment (`api-m.sandbox.paypal.com`), the OAuth2 status, and the **Data Provenance Matrix** separating PayPal native fields from contextual synthetic telemetry.

### Step 2: Spot a Suspicious Outlier Transaction
- On the main dashboard, observe the operational KPI summary cards: Total Evaluated Volume, Flagged Activity, High-Risk Exposure, and Action Queue.
- Locate transaction **`PP-SANDBOX-948102`** ($720.00, buyer `m.***g@velocity-corp.org`).
- Click **Inspect** to open the risk analysis inspector.

### Step 3: Examine the Underlying Deterministic Risk Signals
- Observe the risk score gauge: **High Risk Score: 70/100**.
- Inspect the **Deterministic Signals Breakdown**:
  - `EXTREME_AMOUNT_OUTLIER`: **+45 pts** — Amount of $720.00 is **8.5x** higher than the store baseline ($85.00), exceeding the 6.0x extreme cutoff.
  - Transparent formula: observed $720.00 vs threshold >= $510.00.

### Step 4: Grounded AI Explanation & Agentic Triage Proposal
- Review the **AI Plain-Language Risk Explanation**:
  - **Confirmed Facts:** Mathematical baseline comparison and currency verification.
  - **Plausible Interpretations:** Why this occurred (wholesale purchase vs unauthorized card testing).
  - **Recommended Next Steps:** Practical verification guidance before order fulfillment.
- Review the **Validated AI Agent Triage Proposal (Agentic Commerce)**:
  - Proposed Status: `FLAGGED` or `HOLD` | Action: `HOLD` or `REFUND`.
  - Click **"Apply AI Note"** to automatically populate the merchant review note.

### Step 5: Execute Merchant Action with Audit Trail
- In the Merchant Review Decision card, click **Issue PayPal Refund** (or Hold).
- Notice that for live transactions, refunds require a valid settlement **Capture ID**; if absent, live refunds are safely disabled.
- View the confirmed action banner:
  - If using live sandbox credentials on a live captured order: `[Confirmed Live PayPal Sandbox API Response]`.
  - If using demo mode: `[Local Store Simulation (Demo Mode)]` with explicit confirmation that no live funds were moved.
- Verify the persistent **Audit Trail** entry with timestamp, user note, and execution status.

### Bonus: Interactive Checkout Simulator
- Click **Checkout Sim** in the header.
- Choose between **Real PayPal Sandbox Checkout** (3-step live flow: Create Order → Buyer Approval → Server Capture) or **Synthetic Demo Fallback**.
- In the live flow, observe the generation of the real PayPal Order ID, open the buyer approval link, capture the order server-side, and retrieve the actual Capture ID.

---

## Installation & Setup

### Prerequisites
- **Node.js (v18+)**
- **Python 3.8+** (for running the Python reference engine tests)

### 1. Install Dependencies

```bash
# Install Node dependencies
npm install

# (Optional) Install Python dependencies for reference engine
pip install -r requirements.txt
```

### 2. Configure Environment (Optional)

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

`.env.example` contains placeholders only:

```env
# Optional: Google Gemini API key for generative explanations (falls back to deterministic engine if empty)
GEMINI_API_KEY=""
GEMINI_MODEL="gemini-2.5-flash"

# Optional: PayPal Developer Sandbox REST credentials (falls back to demo mode if empty)
PAYPAL_CLIENT_ID=""
PAYPAL_CLIENT_SECRET=""
PAYPAL_ENV="sandbox"

# Server Configuration
PORT=3000
AUTO_OPEN="true"
NODE_ENV="development"
```

> **Clean Setup Guarantee:**  
> PayGuard AI is **100% operational out of the box** without any `.env` file or API keys. If keys are omitted, the app runs seamlessly using rich synthetic sandbox data and deterministic explainability.

### 3. Run Automated Tests

Both the TypeScript engine and the Python reference engine are accompanied by automated test suites:

```bash
# Run TypeScript Risk Engine & Workflow unit tests (25 tests passing)
npm test

# Run Python Reference Risk Engine unit tests (9 tests passing)
python test_risk_engine.py

# Run TypeScript static type check
npm run lint
```

### 4. Build & Launch (Development / Server)

```bash
# Build the production bundle
npm run build

# Start the full-stack Express server (API + Vite frontend bound to 127.0.0.1)
npm start
```

Open `http://127.0.0.1:3000` in your browser.

### 5. Portable Windows Standalone Executable (.exe)

PayGuard AI can be packaged into a **single, 100% self-contained Windows executable** (`payguard-ai.exe`). It embeds the Node runtime, Express backend API, and the entire compiled React web interface into a single portable binary:

```bash
# Compile the portable Windows executable
npm run build:exe

# Launch the standalone executable
dist-exe\payguard-ai.exe
# (or double-click run-portable.bat)
```

> **Zero-Dependency Judge Evaluation:**  
> Evaluators and judges can run `dist-exe/payguard-ai.exe` on any Windows PC without having Node.js, npm, or Python installed! Double-clicking the `.exe` starts the local server on `127.0.0.1` and automatically launches the web browser.

---

## Project Structure

```
payguard-ai/
├── src/
│   ├── components/
│   │   ├── Header.tsx                       # Navigation, walkthrough launcher, sandbox status
│   │   ├── MetricCards.tsx                  # SMB Operations KPI cards
│   │   ├── TransactionTable.tsx             # Activity table with risk badges, capture IDs & sorting
│   │   ├── TransactionFilters.tsx           # Multi-criteria filtering, search, CSV export
│   │   ├── TransactionDetailModal.tsx       # Provenance badges, capture ID, AI proposal, PayPal actions
│   │   ├── ConfirmationModal.tsx            # Strict financial confirmation dialog
│   │   ├── DashboardCharts.tsx              # Analytics charts & distinct status breakdowns
│   │   ├── JudgeWalkthroughModal.tsx        # Interactive 5-step live hackathon tour
│   │   ├── PayPalCheckoutSimulatorModal.tsx # Real PayPal checkout flow & synthetic demo fallback
│   │   ├── PayPalSyncModal.tsx              # Sandbox connection manager & credential config
│   │   ├── ThresholdSettingsModal.tsx       # Dynamic threshold customization modal
│   │   ├── AuditLogView.tsx                 # Persistent immutable audit ledger
│   │   ├── ScoringRulesView.tsx             # Documented scoring rules catalog
│   │   └── HowItWorksModal.tsx              # Problem, impact, innovation, & limitations tabs
│   ├── server/
│   │   ├── paypalService.ts                 # PayPal Sandbox OAuth2, Orders v2, captures & refunds
│   │   ├── aiService.ts                     # Gemini 2.5 Flash with privacy masking & fallback
│   │   └── embeddedAssets.ts                # In-memory bundle of compiled client assets for standalone EXE
│   ├── utils/
│   │   ├── risk.ts                          # Deterministic TypeScript risk engine, status map & validator
│   │   ├── risk.test.ts                     # Regression & unit tests for risk engine, status & velocity
│   │   └── workflow.test.ts                 # End-to-end workflow and PayPal integration tests
│   ├── App.tsx                              # Root application component
│   └── main.tsx                             # Application entry point
├── scripts/
│   ├── build-exe.ts                         # Standalone SEA executable build script
│   └── embed-dist.ts                        # Assets packager for embedded executable serving
├── risk_engine.py                           # Standalone Python reference risk engine
├── test_risk_engine.py                      # Standalone Python unit tests (9 tests)
├── server.ts                                # Full-stack Express server bound to 127.0.0.1
├── run-portable.bat                         # Portable Windows 1-click launcher
├── LICENSE                                  # MIT Open Source License
├── .env.example                             # Placeholder-only configuration template
├── package.json                             # Dependencies & build scripts
└── README.md                                # Hackathon submission documentation
```

---

## Limitations & Project Boundaries

- **Decision-Support Focus:** PayGuard AI is an operational decision-support tool for merchants. It does not claim 99.9% fraud accuracy or replace bank-level cardholder 3D-Secure underwriting.
- **Sandbox Environment:** All payment interactions run against the PayPal Developer Sandbox or local safe simulations. Real financial disbursements or live card charges are never initiated.
- **Capture ID Prerequisite for Refunds:** In live sandbox mode, refunds require an actual PayPal settlement Capture ID. If an order has not been captured or lacks a capture ID, live refunds are disabled.
- **Local Host Security:** The server binds to loopback interface `127.0.0.1` by default to avoid accidental exposure on open local networks.
- **Human Authority:** The AI agent acts as a co-pilot by proposing triage recommendations and drafting review notes; the human merchant retains ultimate authority to approve, edit, or reject actions.
