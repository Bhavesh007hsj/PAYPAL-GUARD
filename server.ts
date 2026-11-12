/**
 * PayGuard AI - Full Stack Server
 * Runs Express backend APIs and mounts Vite development middleware.
 */

import express from 'express';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { exec } from 'child_process';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { fileURLToPath } from 'url';
import {
  DEFAULT_THRESHOLDS,
  RiskThresholds,
  Transaction,
  assessTransaction,
  AuditEntry,
  SCORING_RULES_CATALOG,
  validateAgenticProposal,
} from './src/utils/risk';
import {
  INITIAL_DEMO_TRANSACTIONS,
  PayPalSandboxService,
} from './src/server/paypalService';
import { explainRiskAssessment } from './src/server/aiService';
import { EMBEDDED_ASSETS } from './src/server/embeddedAssets';

dotenv.config();

const getAppDirname = () => {
  if (typeof __dirname !== 'undefined') return __dirname;
  try {
    return path.dirname(fileURLToPath(import.meta.url));
  } catch {
    return process.cwd();
  }
};
const appDir = getAppDirname();

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

app.use(express.json());

// Local application state, persisted between server restarts.
let currentThresholds: RiskThresholds = { ...DEFAULT_THRESHOLDS };
let transactions: Transaction[] = [...INITIAL_DEMO_TRANSACTIONS];
let auditLog: AuditEntry[] = [];
const inFlightActions = new Set<string>();

const stateDirectory = path.resolve(appDir, 'data');
const stateFile = path.join(stateDirectory, 'payguard-state.json');
let saveQueue: Promise<void> = Promise.resolve();

function recordAuditEntry(
  entry: Omit<AuditEntry, 'id' | 'timestamp'> & { id?: string; timestamp?: string }
): AuditEntry {
  const fullEntry: AuditEntry = {
    id: entry.id || `AUDIT-${Date.now()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`,
    timestamp: entry.timestamp || new Date().toISOString(),
    ...entry,
  };
  auditLog.unshift(fullEntry);
  if (auditLog.length > 1000) {
    auditLog = auditLog.slice(0, 1000);
  }
  return fullEntry;
}

async function loadPersistedState() {
  try {
    const saved = JSON.parse(await readFile(stateFile, 'utf8'));
    if (Array.isArray(saved.transactions)) transactions = saved.transactions;
    if (saved.thresholds && typeof saved.thresholds === 'object') {
      currentThresholds = { ...DEFAULT_THRESHOLDS, ...saved.thresholds };
    }
    if (Array.isArray(saved.auditLog)) {
      auditLog = saved.auditLog.slice(0, 1000);
    } else if (Array.isArray(saved.reviewAudit)) {
      // Migrate legacy reviewAudit records
      auditLog = saved.reviewAudit.map((ra: any) => ({
        id: ra.id || `MIGRATE-${Date.now()}`,
        timestamp: ra.changed_at || new Date().toISOString(),
        transaction_id: ra.transaction_id || 'UNKNOWN',
        actor: 'MERCHANT' as const,
        action_type: 'REVIEW_STATUS_CHANGE' as const,
        status: 'COMPLETED' as const,
        source: 'sandbox_demo' as const,
        summary: ra.notes || `Review status transition: ${ra.from} -> ${ra.to}`,
        notes: ra.notes,
      }));
    }
  } catch (error: any) {
    if (error?.code !== 'ENOENT') console.warn('[PayGuard AI] Saved state could not be loaded; starting with demo data.');
  }
}

function persistState() {
  const snapshot = JSON.stringify({ transactions, thresholds: currentThresholds, auditLog }, null, 2);
  saveQueue = saveQueue.then(async () => {
    await mkdir(stateDirectory, { recursive: true });
    const temporaryFile = `${stateFile}.tmp`;
    await writeFile(temporaryFile, snapshot, 'utf8');
    await rename(temporaryFile, stateFile);
  }).catch((error) => console.error('[PayGuard AI] Could not persist local state:', error));
  return saveQueue;
}

const paypalService = new PayPalSandboxService();

app.use('/api', (req, res, next) => {
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    res.on('finish', () => { if (res.statusCode < 400) void persistState(); });
  }
  next();
});

// API ROUTES

// 1. System Health & Connection Status
app.get('/api/status', (req, res) => {
  const ppStatus = paypalService.getStatus();
  const hasGeminiKey = Boolean(
    process.env.GEMINI_API_KEY &&
    process.env.GEMINI_API_KEY !== 'MY_GEMINI_API_KEY' &&
    process.env.GEMINI_API_KEY !== 'YOUR_GEMINI_API_KEY'
  );

  res.json({
    app: 'PayGuard AI',
    version: '1.0.0',
    paypal: ppStatus,
    ai: {
      provider: 'Google Gemini 2.5 Flash',
      configured: hasGeminiKey,
      mode: hasGeminiKey ? 'online' : 'deterministic_fallback',
      status: hasGeminiKey ? 'Active (API Key loaded)' : 'Deterministic Fallback Active',
    },
    thresholds: currentThresholds,
    total_transactions: transactions.length,
  });
});

// 2. Transactions list with real-time assessment
app.get('/api/transactions', (req, res) => {
  // Sort by timestamp descending
  const sorted = [...transactions].sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  );

  const evaluated = sorted.map((tx) => {
    const assessment = assessTransaction(tx, transactions, currentThresholds);
    return {
      ...tx,
      assessment,
    };
  });

  res.json({
    transactions: evaluated,
    thresholds: currentThresholds,
  });
});

// 3. Assess a single transaction
app.post('/api/assess', (req, res) => {
  const { transaction, custom_thresholds } = req.body;
  if (!transaction) {
    return res.status(400).json({ error: 'Missing transaction object' });
  }

  const th = custom_thresholds || currentThresholds;
  const assessment = assessTransaction(transaction, transactions, th);
  res.json({ assessment });
});

// 4. Generate AI Explanation for a transaction
app.post('/api/explain', async (req, res) => {
  const { transaction, force_engine } = req.body;
  if (!transaction) {
    return res.status(400).json({ error: 'Missing transaction data' });
  }

  // Recompute on the server; do not trust a client-supplied score or signal list.
  const currentAssessment = assessTransaction(transaction, transactions, currentThresholds);

  try {
    const result = await explainRiskAssessment(transaction, currentAssessment, force_engine);

    // Validate AI Agent proposal against allowed actions and statuses
    if (result.explanation?.agentic_proposal) {
      result.explanation.agentic_proposal = validateAgenticProposal(
        result.explanation.agentic_proposal,
        undefined,
        currentAssessment.risk_level
      );

      recordAuditEntry({
        transaction_id: transaction.id,
        actor: 'AI_AGENT',
        action_type: 'AI_PROPOSAL_GENERATED',
        status: 'PROPOSED',
        source: transaction.source || 'sandbox_demo',
        summary: `AI Agent proposed action: ${result.explanation.agentic_proposal.proposed_paypal_action} (Status: ${result.explanation.agentic_proposal.proposed_review_status})`,
        notes: result.explanation.agentic_proposal.recommended_merchant_note,
        raw_details: {
          engine: result.explanation.engine,
          score: result.explanation.score,
          risk_level: result.explanation.risk_level,
          rationale: result.explanation.agentic_proposal.confidence_rationale,
          action_prompt: result.explanation.agentic_proposal.human_action_prompt,
        },
      });
    }

    res.json(result);
  } catch (err: any) {
    console.error('[API /api/explain] Error:', err);
    res.status(500).json({ error: 'Failed to generate explanation' });
  }
});

// 4b. Execute or simulate a PayPal Sandbox Merchant Action (Refund, Hold, Capture, 2FA)
app.post('/api/paypal/action', async (req, res) => {
  const { id, action, amount, note } = req.body;
  if (!id || !action) {
    return res.status(400).json({ error: 'Missing transaction id or action' });
  }

  // Concurrency Lock: Prevent race conditions & simultaneous action collisions
  if (inFlightActions.has(id)) {
    return res.status(409).json({
      error: `An action is already in progress for transaction ${id}. Please wait for it to complete.`,
    });
  }

  const idx = transactions.findIndex((t) => t.id === id);
  if (idx === -1) {
    return res.status(404).json({ error: 'Transaction not found' });
  }

  const tx = transactions[idx];

  // Prevent duplicate actions
  if (action === 'REFUND' && tx.status === 'REFUNDED') {
    return res.status(409).json({
      error: `Duplicate action rejected: Transaction ${tx.id} has already been refunded. Duplicate refunds are prevented.`,
    });
  }
  if (action === 'CAPTURE' && tx.status === 'COMPLETED' && tx.review_status === 'SAFE') {
    return res.status(409).json({
      error: `Duplicate action rejected: Transaction ${tx.id} has already been approved and captured.`,
    });
  }

  // Validate amount if supplied
  if (amount !== undefined) {
    const numAmt = Number(amount);
    if (!Number.isFinite(numAmt) || numAmt <= 0) {
      return res.status(400).json({ error: 'Action amount must be a positive number.' });
    }
  }

  inFlightActions.add(id);

  let actionResult: any;

  try {
    switch (action) {
      case 'REFUND': {
        const refundAmt = amount ? Number(amount) : tx.amount;
        const isLive = tx.source === 'sandbox_live';

        if (isLive && !tx.capture_id) {
          return res.status(400).json({
            success: false,
            error: `Live PayPal refund cannot be processed: Transaction ${tx.id} has no valid PayPal Capture ID recorded. Only captured transactions with a verified settlement capture ID can be refunded on PayPal Sandbox.`,
          });
        }

        const targetCaptureId = isLive ? tx.capture_id! : (tx.capture_id || tx.id);
        const result = await paypalService.refundCapture(targetCaptureId, refundAmt, tx.currency, note, isLive);
        actionResult = {
          action: 'REFUND',
          timestamp: new Date().toISOString(),
          reference_id: result.refundId || 'N/A',
          status: result.status,
          details: result.details,
          is_live: result.isLive,
          mode: result.mode,
          failure_reason: result.failureReason,
          disclaimer: result.disclaimer,
          raw_response: result.rawResponse,
        };

        if (!result.success) {
          // Record failed attempt in audit ledger
          recordAuditEntry({
            transaction_id: tx.id,
            actor: 'MERCHANT',
            action_type: 'PAYPAL_REFUND',
            status: 'FAILED',
            source: tx.source,
            summary: `PayPal Sandbox refund failed for $${refundAmt.toFixed(2)} ${tx.currency}`,
            reference_id: result.refundId || undefined,
            notes: note || undefined,
            error_message: result.failureReason || 'PayPal Sandbox API rejected the refund request.',
            raw_details: result.rawResponse,
          });

          tx.paypal_action_result = actionResult;

          return res.status(422).json({
            success: false,
            error: result.failureReason || 'PayPal Sandbox API rejected the refund request.',
            actionResult,
            transaction: tx,
          });
        }

        tx.status = 'REFUNDED';
        tx.review_status = 'FLAGGED';

        recordAuditEntry({
          transaction_id: tx.id,
          actor: 'MERCHANT',
          action_type: 'PAYPAL_REFUND',
          status: 'COMPLETED',
          source: result.isLive ? 'sandbox_live' : 'sandbox_demo',
          summary: `Merchant issued ${result.isLive ? 'Live PayPal Sandbox' : 'Simulated'} refund: $${refundAmt.toFixed(2)} ${tx.currency}`,
          reference_id: result.refundId,
          notes: note || undefined,
          raw_details: result.rawResponse,
        });

        break;
      }
      case 'HOLD': {
        const result = await paypalService.holdAuthorization(tx.id, note);
        actionResult = {
          action: 'HOLD',
          timestamp: new Date().toISOString(),
          reference_id: result.referenceId,
          status: result.status,
          details: result.details,
          is_live: result.isLive,
          mode: result.mode,
          disclaimer: result.disclaimer,
          raw_response: result.rawResponse,
        };
        tx.status = 'ON_HOLD';
        tx.review_status = 'HOLD';

        recordAuditEntry({
          transaction_id: tx.id,
          actor: 'MERCHANT',
          action_type: 'PAYPAL_HOLD',
          status: 'COMPLETED',
          source: tx.source,
          summary: `Merchant placed order on fulfillment hold. Ref: ${result.referenceId}`,
          reference_id: result.referenceId,
          notes: note || undefined,
          raw_details: result.rawResponse,
        });

        break;
      }
      case 'CAPTURE': {
        const isLive = tx.source === 'sandbox_live';
        const result = await paypalService.captureOrder(tx.id, isLive);
        actionResult = {
          action: 'CAPTURE',
          timestamp: new Date().toISOString(),
          reference_id: result.referenceId,
          status: result.status,
          details: result.details,
          is_live: result.isLive,
          mode: result.mode,
          failure_reason: result.failureReason,
          raw_response: result.rawResponse,
        };

        if (!result.success) {
          recordAuditEntry({
            transaction_id: tx.id,
            actor: 'MERCHANT',
            action_type: 'PAYPAL_CAPTURE',
            status: 'FAILED',
            source: tx.source,
            summary: `PayPal Sandbox capture failed for order ${tx.id}`,
            notes: note || undefined,
            error_message: result.failureReason,
            raw_details: result.rawResponse,
          });

          tx.paypal_action_result = actionResult;

          return res.status(422).json({
            success: false,
            error: result.failureReason || 'PayPal Sandbox API rejected order capture.',
            actionResult,
            transaction: tx,
          });
        }

        tx.status = 'COMPLETED';
        tx.review_status = 'SAFE';

        recordAuditEntry({
          transaction_id: tx.id,
          actor: 'MERCHANT',
          action_type: 'PAYPAL_CAPTURE',
          status: 'COMPLETED',
          source: result.isLive ? 'sandbox_live' : 'sandbox_demo',
          summary: `Merchant captured & approved order for fulfillment. Ref: ${result.referenceId}`,
          reference_id: result.referenceId,
          notes: note || undefined,
          raw_details: result.rawResponse,
        });

        break;
      }
      case 'REQUEST_2FA': {
        const refId = `2FA-SIM-${Date.now().toString(36).toUpperCase()}`;
        actionResult = {
          action: 'REQUEST_2FA',
          timestamp: new Date().toISOString(),
          reference_id: refId,
          status: 'PENDING_BUYER_CONFIRMATION',
          details: 'Simulated Buyer Verification: Dispatched mock 2FA confirmation prompt to buyer email.',
          is_live: false,
          mode: 'simulated_local',
          disclaimer: 'Simulation only. Simulates customer security verification prompt.',
          raw_response: {
            notification_id: refId,
            destination: tx.buyer_email,
            status: 'SENT_SIMULATED',
          },
        };
        tx.review_status = 'HOLD';

        recordAuditEntry({
          transaction_id: tx.id,
          actor: 'MERCHANT',
          action_type: 'REQUEST_2FA',
          status: 'COMPLETED',
          source: 'sandbox_demo',
          summary: `Merchant requested simulated customer 2FA verification for ${tx.buyer_email}`,
          reference_id: refId,
          notes: note || undefined,
          raw_details: actionResult.raw_response,
        });

        break;
      }
      default:
        return res.status(400).json({ error: 'Unsupported action' });
    }

    tx.paypal_action_result = actionResult;
    if (note?.trim()) {
      tx.merchant_notes = (tx.merchant_notes ? `${tx.merchant_notes} | ` : '') + note.trim();
    }

    const reevaluated = {
      ...tx,
      assessment: assessTransaction(tx, transactions, currentThresholds),
    };

    res.json({
      success: true,
      actionResult,
      transaction: reevaluated,
      message: `PayPal Sandbox action "${action}" completed.`,
    });
  } catch (err: any) {
    console.error('[API /api/paypal/action] Error:', err);
    res.status(500).json({ error: err.message || 'Action failed' });
  } finally {
    inFlightActions.delete(id);
  }
});

// 4b-1. Lookup live PayPal Sandbox Order by ID
app.get('/api/paypal/order/:id', async (req, res) => {
  const orderId = req.params.id;
  if (!orderId) {
    return res.status(400).json({ error: 'Missing order ID' });
  }

  const result = await paypalService.fetchOrder(orderId);
  if (!result.success || !result.order) {
    return res.status(result.statusCode || 404).json({
      success: false,
      error: result.error || `Could not find order ${orderId} in PayPal Sandbox`,
      rawResponse: result.rawResponse,
    });
  }

  // Assess order in risk engine
  const assessment = assessTransaction(result.order, transactions, currentThresholds);

  // If not already present in memory, add it
  const existingIdx = transactions.findIndex((t) => t.id === result.order!.id);
  if (existingIdx === -1) {
    transactions.unshift(result.order);
  } else {
    transactions[existingIdx] = result.order;
  }

  recordAuditEntry({
    transaction_id: result.order.id,
    actor: 'MERCHANT',
    action_type: 'ORDER_LOOKUP',
    status: 'COMPLETED',
    source: 'sandbox_live',
    summary: `Fetched live PayPal Sandbox Order: ${result.order.id} ($${result.order.amount.toFixed(2)} ${result.order.currency})`,
    reference_id: result.order.id,
    raw_details: result.rawResponse,
  });

  res.json({
    success: true,
    isLive: result.isLive,
    order: {
      ...result.order,
      assessment,
    },
    rawResponse: result.rawResponse,
  });
});

// 4b-2. Lookup live PayPal Sandbox Capture by ID
app.get('/api/paypal/capture/:id', async (req, res) => {
  const captureId = req.params.id;
  if (!captureId) {
    return res.status(400).json({ error: 'Missing capture ID' });
  }

  const result = await paypalService.fetchCapture(captureId);
  if (!result.success) {
    return res.status(result.statusCode || 404).json({
      success: false,
      error: result.error || `Could not find capture ${captureId} in PayPal Sandbox`,
      rawResponse: result.rawResponse,
    });
  }

  res.json({
    success: true,
    isLive: result.isLive,
    capture: result.capture,
    rawResponse: result.rawResponse,
  });
});

// 4b-3. Create real test order directly in live PayPal Sandbox
app.post('/api/paypal/order/create', async (req, res) => {
  const { amount, currency, description } = req.body;
  const numAmount = Math.max(1, parseFloat(amount) || 50.0);
  const curr = (currency || 'USD').toUpperCase();

  const result = await paypalService.createSandboxOrder(numAmount, curr, description);
  if (!result.success) {
    return res.status(422).json({
      success: false,
      error: result.error || 'Failed to create PayPal Sandbox order.',
      rawResponse: result.rawResponse,
    });
  }

  // Create corresponding transaction
  const newTx: Transaction = {
    id: result.orderId || `PP-SANDBOX-${Date.now()}`,
    order_id: result.orderId || undefined,
    amount: numAmount,
    currency: curr,
    status: 'PENDING',
    timestamp: new Date().toISOString(),
    buyer_name: 'PayPal Sandbox Test Buyer',
    buyer_email: 'sb-buyer@business.example.com',
    billing_country: 'US',
    billing_zip: '95131',
    shipping_country: 'US',
    payment_method: 'PayPal Sandbox Checkout Order',
    source: 'sandbox_live',
    review_status: 'PENDING',
  };

  transactions.unshift(newTx);
  const assessment = assessTransaction(newTx, transactions, currentThresholds);

  recordAuditEntry({
    transaction_id: newTx.id,
    actor: 'MERCHANT',
    action_type: 'TRANSACTION_SYNC',
    status: 'COMPLETED',
    source: 'sandbox_live',
    summary: `Created new live PayPal Sandbox Order ${newTx.id} ($${newTx.amount.toFixed(2)} ${newTx.currency})`,
    reference_id: newTx.id,
    raw_details: result.rawResponse,
  });

  res.json({
    success: true,
    isLive: true,
    orderId: result.orderId,
    approvalUrl: result.approvalUrl,
    transaction: {
      ...newTx,
      assessment,
    },
    rawResponse: result.rawResponse,
    message: result.details || 'PayPal Sandbox order created successfully.',
  });
});

// 4b-4. Capture live PayPal Sandbox Order
app.post('/api/paypal/order/capture', async (req, res) => {
  const { orderId } = req.body;
  if (!orderId) {
    return res.status(400).json({ error: 'Missing orderId' });
  }

  const result = await paypalService.captureOrder(orderId, true);
  if (!result.success) {
    return res.status(422).json({
      success: false,
      error: result.failureReason || 'Capture failed.',
      rawResponse: result.rawResponse,
    });
  }

  const actualCaptureId = result.captureId || result.referenceId;
  const idx = transactions.findIndex((t) => t.id === orderId || t.order_id === orderId);
  if (idx !== -1) {
    transactions[idx].capture_id = actualCaptureId;
    transactions[idx].status = 'COMPLETED';
    transactions[idx].review_status = 'SAFE';
  }

  recordAuditEntry({
    transaction_id: orderId,
    actor: 'MERCHANT',
    action_type: 'PAYPAL_CAPTURE',
    status: 'COMPLETED',
    source: result.isLive ? 'sandbox_live' : 'sandbox_demo',
    summary: `Captured live PayPal Sandbox Order ${orderId}. Capture ID: ${actualCaptureId}`,
    reference_id: actualCaptureId,
    raw_details: result.rawResponse,
  });

  const updatedTx = idx !== -1 ? transactions[idx] : null;

  res.json({
    success: true,
    isLive: result.isLive,
    captureId: actualCaptureId,
    actionResult: result,
    transaction: updatedTx
      ? {
          ...updatedTx,
          assessment: assessTransaction(updatedTx, transactions, currentThresholds),
        }
      : undefined,
    message: result.details,
  });
});

// 4b-5. Real PayPal Sandbox Checkout Flow: Create Order & get Buyer Approval URL
app.post('/api/paypal/checkout/create-order', async (req, res) => {
  const { amount, currency, buyer_name, buyer_email, description } = req.body;
  const numAmount = Math.max(1, parseFloat(amount) || 50.0);
  const curr = (currency || 'USD').toUpperCase();

  const result = await paypalService.createSandboxOrder(numAmount, curr, description || 'PayPal Sandbox Checkout');
  if (!result.success || !result.orderId) {
    return res.status(422).json({
      success: false,
      error: result.error || 'Failed to create PayPal Sandbox order.',
      rawResponse: result.rawResponse,
    });
  }

  const newTx: Transaction = {
    id: result.orderId,
    order_id: result.orderId,
    amount: numAmount,
    currency: curr,
    status: 'PENDING',
    timestamp: new Date().toISOString(),
    buyer_name: buyer_name || 'PayPal Sandbox Customer',
    buyer_email: buyer_email || 'sb-buyer@business.example.com',
    billing_country: 'US',
    billing_zip: '95131',
    shipping_country: 'US',
    payment_method: 'PayPal Sandbox Express Checkout',
    source: 'sandbox_live',
    review_status: 'PENDING',
  };

  transactions.unshift(newTx);
  const assessment = assessTransaction(newTx, transactions, currentThresholds);

  recordAuditEntry({
    transaction_id: newTx.id,
    actor: 'MERCHANT',
    action_type: 'TRANSACTION_SYNC',
    status: 'COMPLETED',
    source: 'sandbox_live',
    summary: `Initiated PayPal Sandbox checkout order ${newTx.id} ($${newTx.amount.toFixed(2)} ${newTx.currency}). Awaiting buyer approval.`,
    reference_id: newTx.id,
    raw_details: result.rawResponse,
  });

  res.json({
    success: true,
    isLive: true,
    orderId: result.orderId,
    approvalUrl: result.approvalUrl,
    transaction: {
      ...newTx,
      assessment,
    },
    message: 'PayPal Sandbox Order created. Buyer approval required before capturing.',
  });
});

// 4b-6. Real PayPal Sandbox Checkout Flow: Server-side Capture of Approved Order
app.post('/api/paypal/checkout/capture-order', async (req, res) => {
  const { orderId } = req.body;
  if (!orderId) {
    return res.status(400).json({ error: 'Missing orderId' });
  }

  const result = await paypalService.captureOrder(orderId, true);
  if (!result.success) {
    return res.status(422).json({
      success: false,
      error: result.failureReason || 'Failed to capture PayPal Sandbox order.',
      rawResponse: result.rawResponse,
    });
  }

  const actualCaptureId = result.captureId || result.referenceId;
  const idx = transactions.findIndex((t) => t.id === orderId || t.order_id === orderId);

  if (idx !== -1) {
    transactions[idx].capture_id = actualCaptureId;
    transactions[idx].status = 'COMPLETED';
    transactions[idx].review_status = 'SAFE';
  } else {
    // If not found, fetch order or create transaction entry
    const newTx: Transaction = {
      id: orderId,
      order_id: orderId,
      capture_id: actualCaptureId,
      amount: 50.0,
      currency: 'USD',
      status: 'COMPLETED',
      timestamp: new Date().toISOString(),
      buyer_name: 'PayPal Sandbox Customer',
      buyer_email: 'sb-buyer@business.example.com',
      billing_country: 'US',
      shipping_country: 'US',
      payment_method: 'PayPal Sandbox Express Checkout',
      source: 'sandbox_live',
      review_status: 'SAFE',
    };
    transactions.unshift(newTx);
  }

  const finalTx = transactions.find((t) => t.id === orderId || t.order_id === orderId)!;
  const assessment = assessTransaction(finalTx, transactions, currentThresholds);

  recordAuditEntry({
    transaction_id: orderId,
    actor: 'MERCHANT',
    action_type: 'PAYPAL_CAPTURE',
    status: 'COMPLETED',
    source: 'sandbox_live',
    summary: `Captured PayPal Sandbox order ${orderId} server-side. Settlement Capture ID: ${actualCaptureId}`,
    reference_id: actualCaptureId,
    raw_details: result.rawResponse,
  });

  res.json({
    success: true,
    isLive: true,
    orderId,
    captureId: actualCaptureId,
    transaction: {
      ...finalTx,
      assessment,
    },
    message: `PayPal Sandbox Order captured successfully. Actual Capture ID: ${actualCaptureId}`,
  });
});

// 4c. Update PayPal Sandbox Credentials dynamically
app.post('/api/paypal/credentials', async (req, res) => {
  const { clientId, clientSecret } = req.body;
  paypalService.setCredentials(clientId || '', clientSecret || '');
  let connected = false;
  let authResult: any = null;
  if (clientId && clientSecret) {
    authResult = await paypalService.authenticate();
    connected = Boolean(authResult.success);
  }
  res.json({
    success: true,
    connected,
    status: paypalService.getStatus(),
    message: connected
      ? 'Successfully connected to live PayPal Sandbox!'
      : (clientId ? `Credentials saved, but authentication failed: ${authResult?.error || 'Check credentials'}` : 'Reset to Sandbox Demo Mode.'),
  });
});

// 4c-2. Update Google Gemini API Key dynamically
app.post('/api/ai/key', (req, res) => {
  const { apiKey } = req.body;
  if (typeof apiKey === 'string') {
    process.env.GEMINI_API_KEY = apiKey.trim();
  }
  const hasGeminiKey = Boolean(
    process.env.GEMINI_API_KEY &&
    process.env.GEMINI_API_KEY !== 'MY_GEMINI_API_KEY' &&
    process.env.GEMINI_API_KEY !== 'YOUR_GEMINI_API_KEY'
  );
  res.json({
    success: true,
    configured: hasGeminiKey,
    mode: hasGeminiKey ? 'online' : 'deterministic_fallback',
    status: hasGeminiKey ? 'Active (API Key loaded)' : 'Deterministic Fallback Active',
    message: hasGeminiKey
      ? 'Google Gemini 2.5 Flash API key connected successfully!'
      : 'Running in Zero-Key Deterministic Fallback mode.',
  });
});

// 4d. Interactive Customer Checkout Simulator
app.post('/api/paypal/checkout', (req, res) => {
  const { amount, currency, buyer_name, buyer_email, billing_country, shipping_country, ip_address, payment_method } = req.body;
  const numAmount = Math.max(1, parseFloat(amount) || 45.0);
  const now = new Date();
  const idNum = Math.floor(100000 + Math.random() * 900000);

  const newTx: Transaction = {
    id: `PP-CHECKOUT-${idNum}`,
    amount: numAmount,
    currency: currency || 'USD',
    status: 'COMPLETED',
    timestamp: now.toISOString(),
    buyer_name: buyer_name || 'Simulated Customer',
    buyer_email: buyer_email || `buyer_${idNum}@example.com`,
    ip_address: ip_address || `198.51.100.${Math.floor(Math.random() * 200 + 10)}`,
    billing_zip: '10001',
    billing_country: billing_country || 'US',
    shipping_country: shipping_country || 'US',
    payment_method: payment_method || 'Synthetic Demo Checkout (Local Fallback)',
    source: 'sandbox_demo',
    review_status: 'PENDING',
  };

  transactions.unshift(newTx);
  const assessment = assessTransaction(newTx, transactions, currentThresholds);

  recordAuditEntry({
    transaction_id: newTx.id,
    actor: 'SYSTEM',
    action_type: 'TRANSACTION_SYNC',
    status: 'COMPLETED',
    source: 'sandbox_demo',
    summary: `Simulated synthetic demo checkout order ${newTx.id} ($${newTx.amount.toFixed(2)} ${newTx.currency})`,
    reference_id: newTx.id,
  });

  res.json({
    success: true,
    isLive: false,
    mode: 'synthetic_demo_fallback',
    transaction: {
      ...newTx,
      assessment,
    },
    message: `Synthetic demo checkout order ${newTx.id} evaluated locally (Demo Fallback).`,
  });
});

// 5. Update Merchant Review Status & Notes
app.post('/api/transactions/review', (req, res) => {
  const { id, review_status, merchant_notes } = req.body;
  if (!id) {
    return res.status(400).json({ error: 'Missing transaction id' });
  }

  const idx = transactions.findIndex((t) => t.id === id);
  if (idx === -1) {
    return res.status(404).json({ error: 'Transaction not found' });
  }

  const validStatuses = ['PENDING', 'SAFE', 'HOLD', 'FLAGGED'];
  if (review_status && !validStatuses.includes(review_status)) {
    return res.status(400).json({ error: 'Invalid review status' });
  }
  if (merchant_notes !== undefined && (typeof merchant_notes !== 'string' || merchant_notes.length > 2000)) {
    return res.status(400).json({ error: 'Merchant notes must be text under 2,000 characters' });
  }
  if (review_status) {
    const prevStatus = transactions[idx].review_status || 'PENDING';
    transactions[idx].review_status = review_status;

    recordAuditEntry({
      transaction_id: id,
      actor: 'MERCHANT',
      action_type: 'REVIEW_STATUS_CHANGE',
      status: 'COMPLETED',
      source: transactions[idx].source || 'sandbox_demo',
      summary: `Merchant changed review status: ${prevStatus} -> ${review_status}`,
      notes: merchant_notes?.trim() || undefined,
    });
  }
  if (merchant_notes !== undefined) {
    transactions[idx].merchant_notes = merchant_notes.trim();
  }

  res.json({
    success: true,
    transaction: transactions[idx],
  });
});

app.get('/api/audit', (req, res) => {
  let events = [...auditLog];
  if (req.query.transaction_id) {
    events = events.filter((e) => e.transaction_id === req.query.transaction_id);
  }
  if (req.query.actor) {
    events = events.filter((e) => e.actor === req.query.actor);
  }
  if (req.query.action_type) {
    events = events.filter((e) => e.action_type === req.query.action_type);
  }
  if (req.query.source) {
    events = events.filter((e) => e.source === req.query.source);
  }
  const limit = parseInt(req.query.limit as string, 10) || 100;
  res.json({
    events: events.slice(0, limit),
    total: events.length,
  });
});

// 5b. Documented Scoring Rules Catalog
app.get('/api/rules', (_req, res) => {
  res.json({
    rules: SCORING_RULES_CATALOG,
    thresholds: currentThresholds,
    defaultThresholds: DEFAULT_THRESHOLDS,
  });
});

// 6. Sync PayPal Sandbox
app.post('/api/paypal/sync', async (req, res) => {
  try {
    const result = await paypalService.fetchTransactions();
    if (result.isLive && result.transactions.length > 0) {
      // Merge or update with live sandbox records
      transactions = [...result.transactions];
    }
    res.json({
      success: true,
      isLive: result.isLive,
      message: result.isLive
        ? `Successfully synchronized ${result.transactions.length} records from live PayPal Sandbox.`
        : (result.error || 'Running with synthetic PayPal Sandbox demo records.'),
      count: transactions.length,
      status: paypalService.getStatus(),
    });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Sync error' });
  }
});

// 7. Reset or Reload Demo Transactions
app.post('/api/transactions/reset', (req, res) => {
  transactions = [...INITIAL_DEMO_TRANSACTIONS];
  res.json({
    success: true,
    message: 'Reset to initial PayPal Sandbox demo dataset.',
    count: transactions.length,
  });
});

// 8. Simulate Distinct Risk Scenarios for Live Testing
app.post('/api/simulate', (req, res) => {
  const { scenario } = req.body;
  const now = new Date();
  const idSuffix = Math.floor(1000 + Math.random() * 9000);

  let newTx: Transaction;

  switch (scenario) {
    case 'velocity_burst': {
      // Create 3 rapid payments within 2-4 minutes from same buyer
      const email = `speedy_${idSuffix}@velocitydemo.com`;
      const ip = `198.51.100.${Math.floor(Math.random() * 200 + 10)}`;
      const simList: Transaction[] = [
        {
          id: `PP-SIM-V1-${idSuffix}`,
          amount: 55.0,
          currency: 'USD',
          status: 'COMPLETED',
          timestamp: new Date(now.getTime() - 4 * 60 * 1000).toISOString(),
          buyer_name: 'Rapid Buyer',
          buyer_email: email,
          ip_address: ip,
          billing_zip: '10001',
          billing_country: 'US',
          shipping_country: 'US',
          payment_method: 'PayPal Balance',
          source: 'sandbox_demo',
          review_status: 'PENDING',
        },
        {
          id: `PP-SIM-V2-${idSuffix}`,
          amount: 55.0,
          currency: 'USD',
          status: 'COMPLETED',
          timestamp: new Date(now.getTime() - 2 * 60 * 1000).toISOString(),
          buyer_name: 'Rapid Buyer',
          buyer_email: email,
          ip_address: ip,
          billing_zip: '10001',
          billing_country: 'US',
          shipping_country: 'US',
          payment_method: 'PayPal Balance',
          source: 'sandbox_demo',
          review_status: 'PENDING',
        },
        {
          id: `PP-SIM-V3-${idSuffix}`,
          amount: 55.0,
          currency: 'USD',
          status: 'COMPLETED',
          timestamp: now.toISOString(),
          buyer_name: 'Rapid Buyer',
          buyer_email: email,
          ip_address: ip,
          billing_zip: '10001',
          billing_country: 'US',
          shipping_country: 'US',
          payment_method: 'PayPal Balance',
          source: 'sandbox_demo',
          review_status: 'PENDING',
        },
      ];
      transactions.unshift(...simList);
      return res.json({
        success: true,
        message: 'Injected 3 rapid transactions demonstrating Velocity Spike detection.',
        primary_id: simList[2].id,
      });
    }

    case 'extreme_amount': {
      newTx = {
        id: `PP-SIM-AMT-${idSuffix}`,
        amount: 890.0, // > 10x baseline of $85
        currency: 'USD',
        status: 'COMPLETED',
        timestamp: now.toISOString(),
        buyer_name: 'High Roller Ltd',
        buyer_email: `bulk_${idSuffix}@luxurygoods.org`,
        ip_address: '203.0.113.44',
        billing_zip: '90210',
        billing_country: 'US',
        shipping_country: 'US',
        payment_method: 'Credit Card via PayPal',
        source: 'sandbox_demo',
        review_status: 'PENDING',
      };
      break;
    }

    case 'duplicate_charge': {
      // First transaction 3 minutes ago
      const priorTx: Transaction = {
        id: `PP-SIM-DUP1-${idSuffix}`,
        amount: 189.5,
        currency: 'USD',
        status: 'COMPLETED',
        timestamp: new Date(now.getTime() - 3 * 60 * 1000).toISOString(),
        buyer_name: 'Arthur Pendelton',
        buyer_email: `arthur_${idSuffix}@clicker.com`,
        ip_address: '198.51.100.99',
        billing_zip: '30301',
        billing_country: 'US',
        shipping_country: 'US',
        payment_method: 'PayPal Wallet',
        source: 'sandbox_demo',
        review_status: 'PENDING',
      };
      newTx = {
        id: `PP-SIM-DUP2-${idSuffix}`,
        amount: 189.5,
        currency: 'USD',
        status: 'COMPLETED',
        timestamp: now.toISOString(),
        buyer_name: 'Arthur Pendelton',
        buyer_email: `arthur_${idSuffix}@clicker.com`,
        ip_address: '198.51.100.99',
        billing_zip: '30301',
        billing_country: 'US',
        shipping_country: 'US',
        payment_method: 'PayPal Wallet',
        source: 'sandbox_demo',
        review_status: 'PENDING',
      };
      transactions.unshift(priorTx, newTx);
      return res.json({
        success: true,
        message: 'Injected duplicate payment pair (identical amount 3 minutes apart).',
        primary_id: newTx.id,
      });
    }

    case 'foreign_and_mismatch': {
      newTx = {
        id: `PP-SIM-INTL-${idSuffix}`,
        amount: 340.0,
        currency: 'EUR',
        status: 'ON_HOLD',
        timestamp: now.toISOString(),
        buyer_name: 'Klaus Schmidt',
        buyer_email: `klaus_${idSuffix}@berlin-tech.de`,
        ip_address: '192.0.2.115',
        billing_zip: '10115',
        billing_country: 'DE',
        shipping_country: 'US', // Country mismatch
        payment_method: 'PayPal Balance',
        source: 'sandbox_demo',
        review_status: 'PENDING',
      };
      break;
    }

    case 'missing_fields': {
      newTx = {
        id: `PP-SIM-ANON-${idSuffix}`,
        amount: 195.0,
        currency: 'USD',
        status: 'PENDING',
        timestamp: now.toISOString(),
        buyer_name: '',
        buyer_email: '',
        ip_address: '203.0.113.200',
        billing_zip: '',
        billing_country: '',
        shipping_country: 'US',
        payment_method: 'Guest Checkout',
        source: 'sandbox_demo',
        review_status: 'PENDING',
      };
      break;
    }

    case 'clean_normal':
    default: {
      newTx = {
        id: `PP-SIM-CLEAN-${idSuffix}`,
        amount: 68.5,
        currency: 'USD',
        status: 'COMPLETED',
        timestamp: now.toISOString(),
        buyer_name: 'Emily Watson',
        buyer_email: `emily_${idSuffix}@gmail.com`,
        ip_address: '198.51.100.15',
        billing_zip: '94016',
        billing_country: 'US',
        shipping_country: 'US',
        payment_method: 'PayPal Wallet',
        source: 'sandbox_demo',
        review_status: 'SAFE',
      };
      break;
    }
  }

  transactions.unshift(newTx);
  res.json({
    success: true,
    message: `Generated scenario "${scenario}" transaction.`,
    primary_id: newTx.id,
  });
});

// 9. Configurable Thresholds
app.get('/api/thresholds', (req, res) => {
  res.json({ thresholds: currentThresholds });
});

app.post('/api/thresholds', (req, res) => {
  const { thresholds } = req.body;
  if (!thresholds) {
    return res.status(400).json({ error: 'Missing thresholds' });
  }

  const numericKeys: (keyof RiskThresholds)[] = [
    'typical_amount', 'high_amount_multiplier', 'extreme_amount_multiplier',
    'velocity_window_minutes', 'velocity_max_count', 'duplicate_window_minutes',
    'duplicate_amount_tolerance', 'high_risk_cutoff', 'medium_risk_cutoff',
  ];
  for (const key of numericKeys) {
    if (thresholds[key] !== undefined && !Number.isFinite(Number(thresholds[key]))) {
      return res.status(400).json({ error: `Invalid numeric threshold: ${key}` });
    }
  }
  const nextThresholds = {
    ...currentThresholds,
    ...thresholds,
    ...Object.fromEntries(numericKeys.filter((key) => thresholds[key] !== undefined).map((key) => [key, Number(thresholds[key])])),
  };
  if (nextThresholds.typical_amount <= 0 || nextThresholds.high_amount_multiplier <= 0 ||
      nextThresholds.extreme_amount_multiplier < nextThresholds.high_amount_multiplier ||
      nextThresholds.velocity_window_minutes <= 0 || nextThresholds.velocity_max_count < 1 ||
      nextThresholds.duplicate_window_minutes <= 0 || nextThresholds.duplicate_amount_tolerance < 0 ||
      nextThresholds.medium_risk_cutoff < 0 || nextThresholds.medium_risk_cutoff > 100 ||
      nextThresholds.high_risk_cutoff < 0 || nextThresholds.high_risk_cutoff > 100 ||
      nextThresholds.medium_risk_cutoff >= nextThresholds.high_risk_cutoff) {
    return res.status(400).json({ error: 'Thresholds must be positive, ordered, and within supported score ranges.' });
  }
  currentThresholds = nextThresholds;

  res.json({
    success: true,
    thresholds: currentThresholds,
    message: 'Risk thresholds updated and reapplied to all transactions.',
  });
});

function startListening(initialPort: number, maxAttempts: number = 10): Promise<{ port: number; server: any }> {
  return new Promise((resolve, reject) => {
    function tryPort(p: number, attemptsLeft: number) {
      const s = app.listen(p, '127.0.0.1');

      s.once('listening', () => {
        resolve({ port: p, server: s });
      });

      s.once('error', (err: any) => {
        if (err.code === 'EADDRINUSE' && attemptsLeft > 0) {
          console.log(`[PayGuard AI] Port ${p} is already in use. Retrying on port ${p + 1}...`);
          tryPort(p + 1, attemptsLeft - 1);
        } else {
          reject(err);
        }
      });
    }

    tryPort(initialPort, maxAttempts);
  });
}

// STARTUP & VITE INTEGRATION
async function startServer() {
  await loadPersistedState();
  if (process.env.NODE_ENV === 'production') {
    // Serve production build: prefer disk if present, otherwise serve from embedded memory
    const diskDist = path.resolve(appDir, 'dist');
    const cwdDist = path.resolve(process.cwd(), 'dist');

    if (fs.existsSync(path.join(diskDist, 'index.html'))) {
      app.use(express.static(diskDist));
      app.get('*', (req, res) => {
        res.sendFile(path.join(diskDist, 'index.html'));
      });
    } else if (fs.existsSync(path.join(cwdDist, 'index.html'))) {
      app.use(express.static(cwdDist));
      app.get('*', (req, res) => {
        res.sendFile(path.join(cwdDist, 'index.html'));
      });
    } else {
      // In-memory embedded assets (for standalone zero-dependency .exe)
      app.get('*', (req, res) => {
        let reqPath = req.path;
        if (reqPath.startsWith('/')) reqPath = reqPath.slice(1);
        if (!reqPath || reqPath === '') reqPath = 'index.html';

        const asset = EMBEDDED_ASSETS[reqPath] || EMBEDDED_ASSETS['index.html'];
        if (asset) {
          res.setHeader('Content-Type', asset.contentType);
          res.send(Buffer.from(asset.dataBase64, 'base64'));
        } else {
          res.status(404).send('Not Found');
        }
      });
    }
  } else {
    // Mount Vite development middlewares
    const { createServer } = await import('vite');
    const vite = await createServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  const { port: boundPort } = await startListening(PORT);
  const url = `http://127.0.0.1:${boundPort}`;
  console.log(`
==================================================================
              PayGuard AI - Small Business Payment Safety
                  PayPal AI Hackathon Official Submission
==================================================================
* URL:          ${url}
* PayPal Mode:  Developer Sandbox Demo Mode (Safe)
* AI Engine:    Google Gemini 2.5 Flash + Deterministic Rules
* Platform:     Portable Standalone Executable
------------------------------------------------------------------
Opening web browser at ${url}...
Press Ctrl+C in this terminal window to stop the server.
==================================================================
`);

  if (process.env.AUTO_OPEN !== 'false' && process.env.NODE_ENV === 'production') {
    try {
      if (process.platform === 'win32') {
        exec(`start "" "${url}"`);
      } else if (process.platform === 'darwin') {
        exec(`open "${url}"`);
      } else {
        exec(`xdg-open "${url}"`);
      }
    } catch {
      // Ignore browser open errors
    }
  }
}

startServer().catch((err) => {
  console.error('\n[PayGuard AI] Fatal server error:', err);
  console.log('\nPress any key or close this window to exit...');
  if (process.stdin.isTTY) {
    try {
      process.stdin.setRawMode?.(true);
      process.stdin.resume();
      process.stdin.on('data', () => process.exit(1));
    } catch {
      setTimeout(() => process.exit(1), 10000);
    }
  } else {
    setTimeout(() => process.exit(1), 10000);
  }
});
