// ============================================================
// Suman AI Studio — Phase 6: credit ledger (server-side only)
// Rules enforced here, and NOWHERE else trusts the browser:
//  * Amounts always come from the server (packages table / model
//    registry / settings) — never from a request body.
//  * Every change is ONE credit_ledger row + users.credit_balance
//    update inside the SAME transaction, with the balance locked
//    (SELECT ... FOR UPDATE) so two concurrent requests cannot
//    both spend the same credits.
//  * balance_after can never go below 0 (DB CHECK + this check).
//  * idempotency_key is UNIQUE — replaying the same key returns
//    the ORIGINAL ledger row instead of charging twice.
//  * Refunds only for failed generations, once per generation
//    (idempotency_key `refund:<generation_id>`).
// ============================================================
const db = require('./db');

const REASONS = ['signup_bonus', 'generation', 'refund', 'admin_add', 'admin_deduct', 'referral', 'subscription', 'payment'];

// ---------- pure helpers (isolated-testable, no DB) ----------
function computeBalanceAfter(currentBalance, amount) {
  const after = currentBalance + amount;
  if (!Number.isInteger(currentBalance) || !Number.isInteger(amount)) {
    throw new Error('BALANCE_NOT_INTEGER');
  }
  if (after < 0) {
    const err = new Error('INSUFFICIENT_CREDITS');
    err.code = 'INSUFFICIENT_CREDITS';
    throw err;
  }
  return after;
}

function makeIdempotencyKey(prefix, id) {
  return `${prefix}:${id}`;
}

// ---------- DB helpers (need a pg client inside a transaction) ----------
async function _findLedgerByKey(client, key) {
  const r = await client.query('SELECT * FROM credit_ledger WHERE idempotency_key = $1', [key]);
  return r.rows[0] || null;
}

// Core: apply one ledger change. Returns the ledger row.
// If the idempotency key already exists, returns the original row
// (idempotent replay — no second charge / credit).
async function applyLedgerChange(client, { userId, amount, reason, referenceId = null, idempotencyKey = null }) {
  if (!REASONS.includes(reason)) throw new Error(`UNKNOWN_LEDGER_REASON: ${reason}`);
  if (!Number.isInteger(amount) || amount === 0) throw new Error('LEDGER_AMOUNT_INVALID');

  if (idempotencyKey) {
    const existing = await _findLedgerByKey(client, idempotencyKey);
    if (existing) return { row: existing, replayed: true };
  }

  const u = await client.query('SELECT credit_balance FROM users WHERE id = $1 FOR UPDATE', [userId]);
  if (!u.rows.length) {
    const err = new Error('USER_NOT_FOUND');
    err.code = 'USER_NOT_FOUND';
    throw err;
  }
  const balanceAfter = computeBalanceAfter(u.rows[0].credit_balance, amount);
  await client.query('UPDATE users SET credit_balance = $1 WHERE id = $2', [balanceAfter, userId]);
  const r = await client.query(
    `INSERT INTO credit_ledger (user_id, amount, balance_after, reason, reference_id, idempotency_key)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [userId, amount, balanceAfter, reason, referenceId, idempotencyKey]
  );
  return { row: r.rows[0], replayed: false };
}

async function deductCredits(client, { userId, amount, reason, referenceId = null, idempotencyKey = null }) {
  if (amount <= 0) throw new Error('DEDUCT_AMOUNT_MUST_BE_POSITIVE');
  return applyLedgerChange(client, { userId, amount: -amount, reason, referenceId, idempotencyKey });
}

async function addCredits(client, { userId, amount, reason, referenceId = null, idempotencyKey = null }) {
  if (amount <= 0) throw new Error('ADD_AMOUNT_MUST_BE_POSITIVE');
  return applyLedgerChange(client, { userId, amount, reason, referenceId, idempotencyKey });
}

// Refund a FAILED generation once. Returns { refunded, row, reason }.
// refunded=false when the generation was not failed / cost 0 /
// already refunded — the caller must NOT treat that as an error
// that hides the real generation failure.
async function refundGeneration(client, generationId) {
  const g = await client.query('SELECT * FROM generations WHERE id = $1', [generationId]);
  const gen = g.rows[0];
  if (!gen) return { refunded: false, reason: 'GENERATION_NOT_FOUND' };
  if (gen.status !== 'failed') return { refunded: false, reason: 'GENERATION_NOT_FAILED' };
  if (!gen.credit_cost || gen.credit_cost <= 0) return { refunded: false, reason: 'NO_CREDIT_CHARGED' };
  const key = makeIdempotencyKey('refund', generationId);
  const existing = await _findLedgerByKey(client, key);
  if (existing) return { refunded: false, reason: 'ALREADY_REFUNDED', row: existing };
  const { row } = await addCredits(client, {
    userId: gen.user_id,
    amount: gen.credit_cost,
    reason: 'refund',
    referenceId: generationId,
    idempotencyKey: key,
  });
  return { refunded: true, row };
}

async function getLedger(clientOrNull, userId, limit = 20, offset = 0) {
  const lim = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 50);
  const off = Math.max(parseInt(offset, 10) || 0, 0);
  const q = `SELECT id, amount, balance_after, reason, reference_id, created_at
             FROM credit_ledger WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`;
  const r = clientOrNull ? await clientOrNull.query(q, [userId, lim, off]) : await db.query(q, [userId, lim, off]);
  const c = clientOrNull
    ? await clientOrNull.query('SELECT COUNT(*)::int AS n FROM credit_ledger WHERE user_id = $1', [userId])
    : await db.query('SELECT COUNT(*)::int AS n FROM credit_ledger WHERE user_id = $1', [userId]);
  return { entries: r.rows, total: c.rows[0].n, limit: lim, offset: off };
}

module.exports = {
  REASONS,
  computeBalanceAfter,
  makeIdempotencyKey,
  applyLedgerChange,
  deductCredits,
  addCredits,
  refundGeneration,
  getLedger,
};
