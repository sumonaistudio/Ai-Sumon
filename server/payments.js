// ============================================================
// Suman AI Studio — Phase 6: credits + manual payments (bKash/Nagad)
// Manual-payment workflow (owner has PERSONAL bKash/Nagad, no
// merchant account — nothing here claims automatic verification):
//   1. User picks a package (server-side, from packages table).
//   2. Site shows the payment numbers from SETTINGS (admin-set).
//   3. User sends money, submits method + transaction_id + sender no.
//   4. Status = pending. Admin approves/rejects (server/admin.js).
//   5. Approve = credits/subscription in ONE transaction + ledger
//      row + notification. Reject = reason recorded, no credits.
// Rules:
//  * Amount ALWAYS comes from the package row — a browser-submitted
//    amount is ignored (never trusted).
//  * (method, transaction_id) is UNIQUE — one trx id, one payment.
//  * Sender number must be a Bangladeshi mobile (01XXXXXXXXX).
//  * Payment numbers/instructions are NEVER hardcoded in code or
//    frontend — they come from the settings table.
// ============================================================
const rateLimit = require('express-rate-limit');
const db = require('./db');
const settings = require('./settings');
const credits = require('./credits');
const auth = require('./auth');
const referrals = require('./referrals'); // Phase 9: bonus after first approved payment

const METHODS = ['bkash', 'nagad'];
const TRX_RE = /^[A-Z0-9]{6,30}$/;
const BD_MOBILE_RE = /^01[3-9]\d{8}$/;

// ---------- pure helpers (isolated-testable) ----------
function normalizeSenderNumber(raw) {
  let n = String(raw || '').replace(/[\s\-()]/g, '');
  if (n.startsWith('+88')) n = n.slice(3);
  if (n.startsWith('88') && n.length === 13) n = n.slice(2);
  return n;
}

function normalizeTransactionId(raw) {
  return String(raw || '').trim().toUpperCase().replace(/[\s\-]/g, '');
}

function validatePaymentInput(body) {
  const errors = {};
  const method = String(body.method || '').trim().toLowerCase();
  const transactionId = normalizeTransactionId(body.transaction_id);
  const senderNumber = normalizeSenderNumber(body.sender_number);
  const packageId = String(body.package_id || '').trim();
  if (!METHODS.includes(method)) errors.method = 'পেমেন্ট মাধ্যম bkash বা nagad হতে হবে।';
  if (!packageId) errors.package_id = 'প্যাকেজ বেছে নিন।';
  if (!TRX_RE.test(transactionId)) errors.transaction_id = 'Transaction ID সঠিক নয় (৬–৩০ অক্ষরের অক্ষর/সংখ্যা)।';
  if (!BD_MOBILE_RE.test(senderNumber)) errors.sender_number = 'সঠিক বাংলাদেশি মোবাইল নম্বর দিন (01XXXXXXXXX)।';
  return { errors, method, transactionId, senderNumber, packageId };
}

// Server-side package lookup: the amount/credits ALWAYS come from here.
function findPackageById(packages, packageId) {
  return (packages || []).find((p) => String(p.id) === String(packageId)) || null;
}

function amountForPackage(pkg) {
  if (!pkg) return null;
  return { amount_bdt: pkg.price_bdt, credits: pkg.credits, kind: pkg.kind };
}

// ---------- shared ----------
function dbNotConfigured(res) {
  return res.status(503).json({
    error: 'DB_NOT_CONFIGURED',
    message: 'ডেটাবেস এখনো সংযুক্ত হয়নি (DATABASE_URL নেই)। পেমেন্ট করা যাচ্ছে না — মালিককে Supabase সংযোগ করতে হবে (README ধাপ ২)।',
  });
}

const paymentRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'TOO_MANY_ATTEMPTS', message: 'অনেকবার পেমেন্ট জমা দেওয়া হয়েছে — ১৫ মিনিট পর আবার চেষ্টা করুন।' },
});

async function listActivePackages(clientOrNull) {
  const q = `SELECT id, kind, name_bn, name_en, price_bdt, price_usd, credits
             FROM packages WHERE is_active = TRUE ORDER BY sort_order ASC, price_bdt ASC`;
  const r = clientOrNull ? await clientOrNull.query(q) : await db.query(q);
  return r.rows;
}

async function getPackages(req, res) {
  if (!db.getPool()) return dbNotConfigured(res);
  try {
    return res.json({ packages: await listActivePackages(null) });
  } catch (err) {
    console.error('[payments.packages]', err);
    return res.status(500).json({ error: 'SERVER_ERROR', message: 'প্যাকেজ তালিকা লোড করা যায়নি।' });
  }
}

async function getPaymentInstructions(req, res) {
  if (!db.getPool()) return dbNotConfigured(res);
  try {
    const s = await settings.getPaymentSettings(null);
    return res.json({ payment: s, methods: METHODS });
  } catch (err) {
    console.error('[payments.instructions]', err);
    return res.status(500).json({ error: 'SERVER_ERROR', message: 'পেমেন্ট নির্দেশনা লোড করা যায়নি।' });
  }
}

async function createPayment(req, res) {
  if (!db.getPool()) return dbNotConfigured(res);
  const { errors, method, transactionId, senderNumber, packageId } = validatePaymentInput(req.body || {});
  if (Object.keys(errors).length) return res.status(400).json({ error: 'VALIDATION_ERROR', errors });
  try {
    const pkg = (await db.query(
      'SELECT * FROM packages WHERE id = $1 AND is_active = TRUE', [packageId]
    )).rows[0];
    if (!pkg) return res.status(400).json({ error: 'INVALID_PACKAGE', message: 'প্যাকেজটি পাওয়া যায়নি বা চালু নেই।' });
    // Amount from the PACKAGE row — the browser's amount (if any) is ignored.
    const amountBdt = pkg.price_bdt;
    const r = await db.query(
      `INSERT INTO payments (user_id, package_id, method, amount_bdt, sender_number, transaction_id, status)
       VALUES ($1,$2,$3,$4,$5,$6,'pending')
       RETURNING id, package_id, method, amount_bdt, sender_number, transaction_id, status, created_at`,
      [req.user.id, pkg.id, method, amountBdt, senderNumber, transactionId]
    );
    return res.status(201).json({
      message: 'পেমেন্ট জমা হয়েছে — অবস্থা: Pending। অ্যাডমিন যাচাই করে জানাবেন।',
      payment: r.rows[0],
    });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({
        error: 'DUPLICATE_TRANSACTION',
        message: 'এই Transaction ID দিয়ে ইতিমধ্যে একটি পেমেন্ট জমা আছে — একই ID দুবার ব্যবহার করা যাবে না।',
      });
    }
    console.error('[payments.create]', err);
    return res.status(500).json({ error: 'SERVER_ERROR', message: 'পেমেন্ট জমা দেওয়া যায়নি — পরে আবার চেষ্টা করুন।' });
  }
}

async function listMyPayments(req, res) {
  if (!db.getPool()) return dbNotConfigured(res);
  try {
    const r = await db.query(
      `SELECT pay.id, pay.method, pay.amount_bdt, pay.transaction_id, pay.status, pay.review_note, pay.created_at, pay.reviewed_at,
              p.kind, p.name_bn, p.name_en, p.credits
       FROM payments pay LEFT JOIN packages p ON p.id = pay.package_id
       WHERE pay.user_id = $1 ORDER BY pay.created_at DESC LIMIT 50`,
      [req.user.id]
    );
    return res.json({ payments: r.rows });
  } catch (err) {
    console.error('[payments.mine]', err);
    return res.status(500).json({ error: 'SERVER_ERROR', message: 'পেমেন্টের তালিকা লোড করা যায়নি।' });
  }
}

async function getMyPayment(req, res) {
  if (!db.getPool()) return dbNotConfigured(res);
  try {
    const r = await db.query(
      `SELECT pay.*, p.kind, p.name_bn, p.name_en, p.credits
       FROM payments pay LEFT JOIN packages p ON p.id = pay.package_id
       WHERE pay.id = $1 AND pay.user_id = $2`,
      [String(req.params.id || '').trim(), req.user.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'NOT_FOUND', message: 'পেমেন্টটি পাওয়া যায়নি।' });
    return res.json({ payment: r.rows[0] });
  } catch (err) {
    console.error('[payments.get]', err);
    return res.status(500).json({ error: 'SERVER_ERROR', message: 'লোড করা যায়নি।' });
  }
}

async function getMyLedger(req, res) {
  if (!db.getPool()) return dbNotConfigured(res);
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 50);
    const data = await credits.getLedger(null, req.user.id, limit, (page - 1) * limit);
    return res.json({ ...data, page });
  } catch (err) {
    console.error('[payments.ledger]', err);
    return res.status(500).json({ error: 'SERVER_ERROR', message: 'লেনদেনের হিসাব লোড করা যায়নি।' });
  }
}

// ---------- approve / reject (called by admin routes; ONE transaction) ----------
// Approve: payment must be pending. Credits/subscription + ledger +
// notification + payment status update all commit together — or none do.
async function approvePayment(client, paymentId, adminId, note) {
  const pay = (await client.query('SELECT * FROM payments WHERE id = $1 FOR UPDATE', [paymentId])).rows[0];
  if (!pay) {
    const err = new Error('PAYMENT_NOT_FOUND'); err.status = 404; throw err;
  }
  if (pay.status !== 'pending') {
    const err = new Error('PAYMENT_ALREADY_REVIEWED'); err.status = 409; throw err;
  }
  const pkg = (await client.query('SELECT * FROM packages WHERE id = $1', [pay.package_id])).rows[0];
  if (!pkg) {
    const err = new Error('PACKAGE_NOT_FOUND'); err.status = 400; throw err;
  }
  const key = credits.makeIdempotencyKey('payment-approve', paymentId);
  if (pkg.credits > 0) {
    await credits.addCredits(client, {
      userId: pay.user_id, amount: pkg.credits, reason: 'payment',
      referenceId: paymentId, idempotencyKey: key,
    });
  }
  let subscription = null;
  if (pkg.kind === 'monthly' || pkg.kind === 'yearly') {
    const days = pkg.kind === 'monthly' ? 30 : 365;
    subscription = (await client.query(
      `INSERT INTO subscriptions (user_id, package_id, status, starts_at, ends_at)
       VALUES ($1,$2,'active', now(), now() + ($3 || ' days')::interval) RETURNING *`,
      [pay.user_id, pkg.id, String(days)]
    )).rows[0];
    await client.query('UPDATE users SET is_paid = TRUE WHERE id = $1', [pay.user_id]);
  } else if (pkg.credits > 0) {
    // A credit-pack purchase also marks the user as paid (watermark-free
    // eligibility) — see settings.watermark_free_requires_paid.
    await client.query('UPDATE users SET is_paid = TRUE WHERE id = $1', [pay.user_id]);
  }
  await client.query(
    `UPDATE payments SET status = 'approved', reviewed_by = $1, reviewed_at = now(), review_note = $2 WHERE id = $3`,
    [adminId, note || null, paymentId]
  );
  await client.query(
    `INSERT INTO notifications (user_id, title, body, kind) VALUES ($1,$2,$3,'payment')`,
    [pay.user_id, 'পেমেন্ট অনুমোদিত হয়েছে ✅',
     `আপনার ${pay.method} পেমেন্ট (${pay.amount_bdt}৳) অনুমোদিত হয়েছে। ${pkg.credits > 0 ? pkg.credits + ' ক্রেডিট যোগ করা হয়েছে।' : ''}`]
  );
  // Phase 9: referral bonus, if this was the referred user's FIRST
  // approved payment. Best-effort inside the same transaction — a
  // bonus failure must never block the approval itself.
  try {
    await referrals.grantReferralBonusIfEligible(client, pay.user_id, paymentId);
  } catch (bonusErr) {
    console.error('[payments.approve] referral bonus failed (approval unaffected):', bonusErr.message);
  }
  await auth.audit(client, 'payment.approve', adminId, 'payment', paymentId, { package_id: pkg.id, credits: pkg.credits, amount_bdt: pay.amount_bdt });
  return { payment_id: paymentId, credits: pkg.credits, subscription };
}

async function rejectPayment(client, paymentId, adminId, note) {
  const pay = (await client.query('SELECT * FROM payments WHERE id = $1 FOR UPDATE', [paymentId])).rows[0];
  if (!pay) {
    const err = new Error('PAYMENT_NOT_FOUND'); err.status = 404; throw err;
  }
  if (pay.status !== 'pending') {
    const err = new Error('PAYMENT_ALREADY_REVIEWED'); err.status = 409; throw err;
  }
  await client.query(
    `UPDATE payments SET status = 'rejected', reviewed_by = $1, reviewed_at = now(), review_note = $2 WHERE id = $3`,
    [adminId, note || 'অ্যাডমিন প্রত্যাখ্যান করেছেন।', paymentId]
  );
  await client.query(
    `INSERT INTO notifications (user_id, title, body, kind) VALUES ($1,$2,$3,'payment')`,
    [pay.user_id, 'পেমেন্ট প্রত্যাখ্যান হয়েছে ❌',
     `আপনার ${pay.method} পেমেন্ট (${pay.amount_bdt}৳) প্রত্যাখ্যান হয়েছে। কারণ: ${note || 'জানানো হয়নি'} — সঠিক Transaction ID দিয়ে আবার জমা দিন।`]
  );
  await auth.audit(client, 'payment.reject', adminId, 'payment', paymentId, { amount_bdt: pay.amount_bdt, note: note || null });
  return { payment_id: paymentId };
}

module.exports = {
  paymentRateLimiter,
  getPackages, getPaymentInstructions, createPayment, listMyPayments, getMyPayment, getMyLedger,
  approvePayment, rejectPayment, listActivePackages,
  _test: { validatePaymentInput, normalizeSenderNumber, normalizeTransactionId, findPackageById, amountForPackage, METHODS },
};
