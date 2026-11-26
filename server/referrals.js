// ============================================================
// Suman AI Studio — Phase 9: referrals
// Rules enforced here:
//  * A referral is recorded at signup ONLY (see applyReferralOnSignup).
//    Self-referral is blocked: referrer_id must differ from
//    referred_id — a user can never earn a bonus for inviting
//    themselves. (At real signup this cannot happen anyway: the
//    code belongs to an existing user and the new user is a fresh
//    UUID — the check below is defence in depth.)
//  * The bonus is granted ONLY after the referred user's FIRST
//    approved payment — never at signup, never for a pending or
//    rejected payment, never twice. One bonus per referred user.
//  * Bonus amount always comes from settings
//    `referral_bonus_credits` (seed default 50) — never from a
//    request body.
//  * Idempotency: ledger key `referral-bonus:<referred_user_id>`
//    (via credits.js) — a replay returns the original row and the
//    referrals row is still marked granted exactly once.
//  * NOTE on wiring: auth.js was NOT edited (it belongs to earlier
//    phases). Its register() already does the equivalent inline —
//    validates the code exists and inserts the referrals row with
//    bonus_granted=FALSE — so applyReferralOnSignup below is the
//    extracted, reusable form of that same logic for the
//    coordinator to wire in if auth.js is ever refactored. Do not
//    call it twice for one signup (ON CONFLICT DO NOTHING guards
//    the duplicate, but a single call site is the intent).
//  * No DB -> honest 503 DB_NOT_CONFIGURED. No user -> 401.
// ============================================================
const db = require('./db');
const credits = require('./credits');
const settings = require('./settings');

function dbNotConfigured(res) {
  return res.status(503).json({
    error: 'DB_NOT_CONFIGURED',
    message: 'ডেটাবেস এখনো সংযুক্ত হয়নি (DATABASE_URL নেই)। রেফারেল তথ্য দেখা যাচ্ছে না — মালিককে Supabase সংযোগ করতে হবে (README ধাপ ২)।',
  });
}

// Referral link base: PUBLIC_URL when set, otherwise this request's origin.
function referralLinkBase(req) {
  const base = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
  if (base) return base;
  if (req && req.protocol && req.get) return `${req.protocol}://${req.get('host')}`;
  return '';
}

// ---------- GET /api/referrals/me ----------
// Own referral code + shareable link + counts + total earned.
async function getReferralInfo(req, res) {
  if (!db.getPool()) return dbNotConfigured(res);
  if (!req.user) return res.status(401).json({ error: 'UNAUTHORIZED', message: 'লগইন করুন।' });
  try {
    const me = req.user;
    const code = me.referral_code;
    const base = referralLinkBase(req);
    const link = code ? `${base}/register.html?ref=${encodeURIComponent(code)}` : null;
    const stats = await db.query(
      `SELECT COUNT(*)::int AS referred_count,
              COUNT(*) FILTER (WHERE bonus_granted = TRUE)::int AS bonuses_granted,
              COALESCE(SUM(bonus_credits) FILTER (WHERE bonus_granted = TRUE), 0)::int AS total_earned_credits
       FROM referrals WHERE referrer_id = $1`,
      [me.id]
    );
    const referred = await db.query(
      `SELECT r.referred_id, r.bonus_granted, r.bonus_credits, r.created_at,
              u.email AS referred_email
       FROM referrals r JOIN users u ON u.id = r.referred_id
       WHERE r.referrer_id = $1 ORDER BY r.created_at DESC LIMIT 50`,
      [me.id]
    );
    // Never expose a referred user's full email to the referrer —
    // only a masked hint.
    const masked = referred.rows.map((r) => ({
      referred_id: r.referred_id,
      referred_email_masked: maskEmail(r.referred_email),
      bonus_granted: r.bonus_granted,
      bonus_credits: r.bonus_credits,
      created_at: r.created_at,
    }));
    return res.json({
      referral_code: code,
      referral_link: link,
      ...stats.rows[0],
      referred_users: masked,
      note: 'বোনাস শুধু তখনই দেওয়া হয় যখন আপনার রেফার করা বন্ধুর প্রথম পেমেন্ট অ্যাডমিন অনুমোদন করেন।',
    });
  } catch (err) {
    console.error('[referrals.me]', err);
    return res.status(500).json({ error: 'SERVER_ERROR', message: 'রেফারেল তথ্য লোড করা যায়নি।' });
  }
}

function maskEmail(email) {
  const e = String(email || '');
  const at = e.indexOf('@');
  if (at <= 1) return '***';
  return e[0] + '***' + e.slice(at);
}

// ---------- applyReferralOnSignup (helper, used inside register's transaction) ----------
// client: pg client inside the signup transaction. referralCode: the
// code the new user typed (already upper-cased/trimmed by the caller,
// or null). newUserId: the just-created user's id.
// Returns { referredBy } or throws an error with .status (400/409)
// for the caller to translate. Self-referral -> 400.
async function applyReferralOnSignup(client, referralCode, newUserId) {
  const code = String(referralCode || '').trim().toUpperCase() || null;
  if (!code) return { referredBy: null };
  const ref = await client.query('SELECT id FROM users WHERE referral_code = $1', [code]);
  if (!ref.rows.length) {
    const err = new Error('INVALID_REFERRAL_CODE');
    err.status = 400;
    throw err;
  }
  const referrerId = ref.rows[0].id;
  if (String(referrerId) === String(newUserId)) {
    const err = new Error('SELF_REFERRAL_NOT_ALLOWED');
    err.status = 400;
    throw err;
  }
  await client.query(
    `INSERT INTO referrals (referrer_id, referred_id, bonus_granted, bonus_credits)
     VALUES ($1, $2, FALSE, 0) ON CONFLICT (referrer_id, referred_id) DO NOTHING`,
    [referrerId, newUserId]
  );
  return { referredBy: referrerId };
}

// ---------- grantReferralBonusIfEligible ----------
// Called (inside the payment-approve transaction) AFTER a payment is
// approved. client: pg client in that transaction.
// referredUserId: the user whose payment was just approved.
// paymentId: the approved payment's id (for the notification text).
// Returns { granted, reason, bonus_credits?, referrer_id? }.
// granted=false is NOT an error — it means no referral exists, the
// bonus was already granted, or the user has no approved payment yet.
async function grantReferralBonusIfEligible(client, referredUserId, paymentId) {
  const ref = await client.query(
    'SELECT * FROM referrals WHERE referred_id = $1 FOR UPDATE', [referredUserId]
  );
  const row = ref.rows[0];
  if (!row) return { granted: false, reason: 'NO_REFERRAL' };
  if (row.bonus_granted) return { granted: false, reason: 'ALREADY_GRANTED' };
  // Bonus only after the FIRST approved payment. (The payment being
  // approved in this same transaction is already 'approved' by the
  // time the caller invokes this — see payments.approvePayment —
  // so count approved payments for this user.)
  const approved = await client.query(
    `SELECT COUNT(*)::int AS n FROM payments WHERE user_id = $1 AND status = 'approved'`,
    [referredUserId]
  );
  if (approved.rows[0].n < 1) return { granted: false, reason: 'NO_APPROVED_PAYMENT_YET' };

  const bonus = await settings.getIntSetting(client, 'referral_bonus_credits', 50);
  if (!bonus || bonus <= 0) return { granted: false, reason: 'BONUS_DISABLED' };

  const key = credits.makeIdempotencyKey('referral-bonus', referredUserId);
  const { row: ledgerRow, replayed } = await credits.addCredits(client, {
    userId: row.referrer_id,
    amount: bonus,
    reason: 'referral',
    referenceId: paymentId || null,
    idempotencyKey: key,
  });
  await client.query(
    'UPDATE referrals SET bonus_granted = TRUE, bonus_credits = $1 WHERE id = $2',
    [bonus, row.id]
  );
  // Notify the referrer (best-effort inside the same transaction;
  // the notifications table exists in the 001 schema).
  try {
    await client.query(
      `INSERT INTO notifications (user_id, title, body, kind) VALUES ($1, $2, $3, 'credit_added')`,
      [row.referrer_id, 'রেফারেল বোনাস পেয়েছেন 🎉', `আপনার রেফার করা বন্ধুর প্রথম পেমেন্ট অনুমোদিত হয়েছে — ${bonus} ক্রেডিট বোনাস যোগ করা হয়েছে।`]
    );
  } catch (e) {
    console.error('[referrals.notify] failed:', e.message);
  }
  return { granted: true, replayed: Boolean(replayed), bonus_credits: bonus, referrer_id: row.referrer_id, ledger: ledgerRow };
}

module.exports = {
  getReferralInfo,
  applyReferralOnSignup,
  grantReferralBonusIfEligible,
  _test: { maskEmail, referralLinkBase },
};
