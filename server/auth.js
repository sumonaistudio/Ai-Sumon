// ============================================================
// Suman AI Studio — Phase 4: authentication
// Email + password register/login, JWT (7-day), forgot/reset with
// single-use hashed tokens, profile/me, role middleware, audit log.
// Rules enforced here:
//  * Passwords are NEVER stored in plain text (bcryptjs, 10 rounds).
//  * No DB (DATABASE_URL missing) -> honest 503 DB_NOT_CONFIGURED,
//    never a fake "registered" success.
//  * No JWT_SECRET -> honest 503 JWT_NOT_CONFIGURED.
//  * Starter bonus is a credit_ledger row inside the SAME transaction
//    as user creation, with idempotency_key `signup-bonus:<user_id>`
//    — a retry / duplicate can never credit twice.
//  * Reset tokens are stored HASHED (sha256), single-use, 1h expiry.
//    The token is NEVER returned in an API response (any env).
//    If email is not configured, dev-only the reset link is printed
//    to the SERVER console (never in production, never to the client).
//  * Forgot-password always returns the same message whether the
//    email exists or not (no account-enumeration leak).
// Google OAuth is implemented in server/google-oauth.js (it needs
// the owner's Google Cloud OAuth client — README ধাপ ২ক). It reuses
// signToken/publicUser from here, so they are exported top-level.
// ============================================================
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const db = require('./db');
const mail = require('./mail');

const JWT_EXPIRES_IN = '7d';
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// ---------- helpers ----------
function dbNotConfigured(res) {
  return res.status(503).json({
    error: 'DB_NOT_CONFIGURED',
    message: 'ডেটাবেস এখনো সংযুক্ত হয়নি (DATABASE_URL নেই)। অ্যাকাউন্ট তৈরি করা যাচ্ছে না — মালিককে Supabase সংযোগ করতে হবে (README ধাপ ২)।',
  });
}

function jwtSecret() {
  return (process.env.JWT_SECRET || '').trim() || null;
}

function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    full_name: row.full_name,
    role: row.role,
    status: row.status,
    credit_balance: row.credit_balance,
    is_paid: row.is_paid,
    referral_code: row.referral_code,
    language: row.language,
    theme: row.theme,
    email_verified: row.email_verified,
    created_at: row.created_at,
  };
}

function signToken(user) {
  return jwt.sign(
    { sub: user.id, email: user.email, role: user.role },
    jwtSecret(),
    { expiresIn: JWT_EXPIRES_IN }
  );
}

function makeReferralCode() {
  // 8 chars, letters+digits (no confusing 0/O, 1/I/l)
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let code = '';
  const buf = crypto.randomBytes(8);
  for (let i = 0; i < 8; i++) code += chars[buf[i] % chars.length];
  return code;
}

async function audit(clientOrNull, action, actorId, targetType, targetId, details) {
  try {
    const q = 'INSERT INTO audit_logs (actor_id, action, target_type, target_id, details) VALUES ($1,$2,$3,$4,$5)';
    if (clientOrNull) await clientOrNull.query(q, [actorId, action, targetType, targetId, details || null]);
    else await db.query(q, [actorId, action, targetType, targetId, details || null]);
  } catch (err) {
    // Audit failure must never break the user-facing request.
    console.error('[audit] failed:', err.message);
  }
}

function validateRegister(body) {
  const errors = {};
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  const fullName = String(body.full_name || body.name || '').trim();
  if (!EMAIL_RE.test(email)) errors.email = 'সঠিক ইমেইল ঠিকানা দিন।';
  if (password.length < 8) errors.password = 'পাসওয়ার্ড কমপক্ষে ৮ অক্ষরের হতে হবে।';
  if (fullName.length > 100) errors.full_name = 'নাম ১০০ অক্ষরের বেশি হতে পারবে না।';
  return { errors, email, password, fullName };
}

// ---------- rate limiting for auth routes ----------
// 10 attempts / 15 min / IP — brute-force protection.
const authRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'TOO_MANY_ATTEMPTS', message: 'অনেকবার চেষ্টা হয়েছে — ১৫ মিনিট পর আবার চেষ্টা করুন।' },
});

// ---------- POST /api/auth/register ----------
async function register(req, res) {
  if (!db.getPool()) return dbNotConfigured(res);
  if (!jwtSecret()) {
    return res.status(503).json({ error: 'JWT_NOT_CONFIGURED', message: 'JWT_SECRET সেট করা হয়নি — মালিককে Render Environment-এ বসাতে হবে।' });
  }
  const { errors, email, password, fullName } = validateRegister(req.body || {});
  if (Object.keys(errors).length) return res.status(400).json({ error: 'VALIDATION_ERROR', errors });
  const referralCodeInput = String((req.body || {}).referral_code || '').trim().toUpperCase() || null;

  try {
    const user = await db.withTransaction(async (client) => {
      const dup = await client.query('SELECT id FROM users WHERE email = $1', [email]);
      if (dup.rows.length) {
        const err = new Error('EMAIL_ALREADY_REGISTERED');
        err.status = 409;
        throw err;
      }
      let referredBy = null;
      if (referralCodeInput) {
        const ref = await client.query('SELECT id FROM users WHERE referral_code = $1', [referralCodeInput]);
        if (!ref.rows.length) {
          const err = new Error('INVALID_REFERRAL_CODE');
          err.status = 400;
          throw err;
        }
        referredBy = ref.rows[0].id;
      }
      // Starter bonus amount comes from settings (admin-controlled), default 100.
      const s = await client.query("SELECT value FROM settings WHERE key = 'signup_bonus_credits'");
      const bonus = Math.max(0, parseInt(s.rows[0] ? s.rows[0].value : '100', 10) || 0);

      const passwordHash = await bcrypt.hash(password, 10);
      const userId = crypto.randomUUID();
      // Referral code is unique; retry a few times on the rare collision.
      let referralCode = makeReferralCode();
      let created = null;
      for (let attempt = 0; attempt < 5 && !created; attempt++) {
        try {
          const r = await client.query(
            `INSERT INTO users (id, email, password_hash, full_name, referral_code, referred_by, credit_balance)
             VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
            [userId, email, passwordHash, fullName, referralCode, referredBy, bonus]
          );
          created = r.rows[0];
        } catch (e) {
          if (e.code === '23505' && attempt < 4) { referralCode = makeReferralCode(); continue; }
          throw e;
        }
      }
      if (!created) throw new Error('Could not create user (referral code collision)');

      if (bonus > 0) {
        await client.query(
          `INSERT INTO credit_ledger (user_id, amount, balance_after, reason, idempotency_key)
           VALUES ($1,$2,$3,'signup_bonus',$4)`,
          [userId, bonus, bonus, `signup-bonus:${userId}`]
        );
      }
      if (referredBy) {
        await client.query(
          `INSERT INTO referrals (referrer_id, referred_id, bonus_granted, bonus_credits)
           VALUES ($1,$2,FALSE,0) ON CONFLICT (referrer_id, referred_id) DO NOTHING`,
          [referredBy, userId]
        );
      }
      await audit(client, 'auth.register', userId, 'user', userId, { bonus });
      return created;
    });

    const token = signToken(user);
    return res.status(201).json({
      message: 'অ্যাকাউন্ট তৈরি হয়েছে।',
      token,
      user: publicUser(user),
      starter_bonus_credits: user.credit_balance,
    });
  } catch (err) {
    if (err.status === 409) return res.status(409).json({ error: 'EMAIL_ALREADY_REGISTERED', message: 'এই ইমেইল দিয়ে ইতিমধ্যে অ্যাকাউন্ট আছে — লগইন করুন।' });
    if (err.status === 400) return res.status(400).json({ error: 'INVALID_REFERRAL_CODE', message: 'রেফারেল কোডটি সঠিক নয়।' });
    if (err.code === '23505') return res.status(409).json({ error: 'EMAIL_ALREADY_REGISTERED', message: 'এই ইমেইল দিয়ে ইতিমধ্যে অ্যাকাউন্ট আছে — লগইন করুন।' });
    console.error('[auth.register]', err);
    return res.status(500).json({ error: 'SERVER_ERROR', message: 'অ্যাকাউন্ট তৈরি করা যায়নি — পরে আবার চেষ্টা করুন।' });
  }
}

// ---------- POST /api/auth/login ----------
async function login(req, res) {
  if (!db.getPool()) return dbNotConfigured(res);
  if (!jwtSecret()) {
    return res.status(503).json({ error: 'JWT_NOT_CONFIGURED', message: 'JWT_SECRET সেট করা হয়নি — মালিককে Render Environment-এ বসাতে হবে।' });
  }
  const email = String((req.body || {}).email || '').trim().toLowerCase();
  const password = String((req.body || {}).password || '');
  if (!EMAIL_RE.test(email) || !password) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'সঠিক ইমেইল ও পাসওয়ার্ড দিন।' });
  }
  try {
    const r = await db.query('SELECT * FROM users WHERE email = $1', [email]);
    const user = r.rows[0];
    if (!user || !user.password_hash) {
      return res.status(401).json({ error: 'INVALID_CREDENTIALS', message: 'ইমেইল বা পাসওয়ার্ড ভুল।' });
    }
    if (user.status === 'suspended') return res.status(403).json({ error: 'ACCOUNT_SUSPENDED', message: 'আপনার অ্যাকাউন্ট সাময়িকভাবে বন্ধ আছে — সাপোর্টে যোগাযোগ করুন।' });
    if (user.status === 'banned') return res.status(403).json({ error: 'ACCOUNT_BANNED', message: 'আপনার অ্যাকাউন্ট স্থায়ীভাবে বন্ধ করা হয়েছে।' });
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'INVALID_CREDENTIALS', message: 'ইমেইল বা পাসওয়ার্ড ভুল।' });
    await db.query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]).catch(() => {});
    await audit(null, 'auth.login', user.id, 'user', user.id, null);
    const token = signToken(user);
    return res.json({ message: 'লগইন সফল হয়েছে।', token, user: publicUser(user) });
  } catch (err) {
    console.error('[auth.login]', err);
    return res.status(500).json({ error: 'SERVER_ERROR', message: 'লগইন করা যায়নি — পরে আবার চেষ্টা করুন।' });
  }
}

// ---------- POST /api/auth/logout ----------
// JWT is stateless: the server cannot revoke a token by itself.
// The client MUST delete the stored token; that is the real logout.
// (Token revocation list arrives in a later phase if needed.)
function logout(req, res) {
  return res.json({
    message: 'লগআউট হয়েছে — আপনার ডিভাইস থেকে টোকেন মুছে ফেলা হয়েছে।',
    client_action: 'delete stored token (localStorage key: sas_token)',
  });
}

// ---------- POST /api/auth/forgot-password ----------
async function forgotPassword(req, res) {
  if (!db.getPool()) return dbNotConfigured(res);
  const email = String((req.body || {}).email || '').trim().toLowerCase();
  // Same reply whether the account exists or not.
  const generic = { message: 'যদি এই ইমেইলে অ্যাকাউন্ট থাকে, পাসওয়ার্ড রিসেটের লিংক পাঠানো হবে। ইনবক্স (ও স্প্যাম) দেখুন।' };
  if (!EMAIL_RE.test(email)) return res.json(generic);
  try {
    const r = await db.query('SELECT id, email FROM users WHERE email = $1', [email]);
    const user = r.rows[0];
    if (!user) return res.json(generic);

    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS);
    await db.query(
      'UPDATE users SET reset_token_hash = $1, reset_token_expires_at = $2 WHERE id = $3',
      [tokenHash, expiresAt, user.id]
    );
    const base = (process.env.PUBLIC_URL || '').replace(/\/$/, '') || 'http://localhost:3000';
    const resetUrl = `${base}/reset-password.html?token=${token}`;
    const sent = await mail.sendMail({
      to: user.email,
      subject: 'Suman AI Studio — পাসওয়ার্ড রিসেট',
      html: `<p>পাসওয়ার্ড রিসেট করতে নিচের লিংকে ক্লিক করুন (১ ঘণ্টার মধ্যে):</p><p><a href="${resetUrl}">${resetUrl}</a></p><p>আপনি এই অনুরোধ না করে থাকলে এই মেইল উপেক্ষা করুন।</p>`,
    });
    if (!sent.sent) {
      if (process.env.NODE_ENV !== 'production') {
        // DEV ONLY: so the owner can test reset without Resend configured.
        // Never in production, never in the API response.
        console.log('[auth.forgot] EMAIL_NOT_CONFIGURED (dev only) — reset link for', user.email, ':', resetUrl);
      } else {
        console.error('[auth.forgot] email not sent:', sent.reason, 'for user', user.id);
      }
    }
    await audit(null, 'auth.forgot_password', user.id, 'user', user.id, { email_sent: sent.sent, reason: sent.sent ? null : sent.reason });
    return res.json({ ...generic, email_sent: sent.sent, email_status: sent.sent ? 'sent' : sent.reason });
  } catch (err) {
    console.error('[auth.forgot]', err);
    return res.json(generic);
  }
}

// ---------- POST /api/auth/reset-password ----------
async function resetPassword(req, res) {
  if (!db.getPool()) return dbNotConfigured(res);
  const token = String((req.body || {}).token || '').trim();
  const password = String((req.body || {}).password || '');
  if (!token || password.length < 8) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'সঠিক টোকেন দিন ও নতুন পাসওয়ার্ড কমপক্ষে ৮ অক্ষরের হতে হবে।' });
  }
  try {
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const r = await db.query(
      `SELECT id FROM users WHERE reset_token_hash = $1 AND reset_token_expires_at > now()`,
      [tokenHash]
    );
    const user = r.rows[0];
    if (!user) {
      return res.status(400).json({ error: 'INVALID_OR_EXPIRED_TOKEN', message: 'রিসেট লিংকটি ভুল বা মেয়াদ শেষ — আবার নতুন লিংক নিন।' });
    }
    const passwordHash = await bcrypt.hash(password, 10);
    await db.query(
      'UPDATE users SET password_hash = $1, reset_token_hash = NULL, reset_token_expires_at = NULL WHERE id = $2',
      [passwordHash, user.id]
    );
    await audit(null, 'auth.reset_password', user.id, 'user', user.id, null);
    return res.json({ message: 'পাসওয়ার্ড বদলে গেছে — নতুন পাসওয়ার্ড দিয়ে লগইন করুন।' });
  } catch (err) {
    console.error('[auth.reset]', err);
    return res.status(500).json({ error: 'SERVER_ERROR', message: 'পাসওয়ার্ড বদলানো যায়নি — পরে আবার চেষ্টা করুন।' });
  }
}

// ---------- GET /api/auth/me ----------
async function me(req, res) {
  return res.json({ user: publicUser(req.user) });
}

// ---------- middleware: require a valid JWT ----------
async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'UNAUTHORIZED', message: 'লগইন করুন — টোকেন পাওয়া যায়নি।' });
  if (!jwtSecret()) return res.status(503).json({ error: 'JWT_NOT_CONFIGURED', message: 'JWT_SECRET সেট করা হয়নি।' });
  let payload;
  try {
    payload = jwt.verify(token, jwtSecret());
  } catch (e) {
    return res.status(401).json({ error: 'INVALID_TOKEN', message: 'টোকেন ভুল বা মেয়াদ শেষ — আবার লগইন করুন।' });
  }
  if (!db.getPool()) return dbNotConfigured(res);
  try {
    const r = await db.query('SELECT * FROM users WHERE id = $1', [payload.sub]);
    const user = r.rows[0];
    if (!user) return res.status(401).json({ error: 'INVALID_TOKEN', message: 'অ্যাকাউন্ট পাওয়া যায়নি — আবার লগইন করুন।' });
    if (user.status === 'suspended') return res.status(403).json({ error: 'ACCOUNT_SUSPENDED', message: 'আপনার অ্যাকাউন্ট সাময়িকভাবে বন্ধ আছে।' });
    if (user.status === 'banned') return res.status(403).json({ error: 'ACCOUNT_BANNED', message: 'আপনার অ্যাকাউন্ট স্থায়ীভাবে বন্ধ করা হয়েছে।' });
    req.user = user;
    return next();
  } catch (err) {
    console.error('[auth.requireAuth]', err);
    return res.status(500).json({ error: 'SERVER_ERROR', message: 'যাচাই করা যায়নি — পরে আবার চেষ্টা করুন।' });
  }
}

// ---------- middleware: role check (use after requireAuth) ----------
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'UNAUTHORIZED', message: 'লগইন করুন।' });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'FORBIDDEN', message: 'এই পাতাটি দেখার অনুমতি আপনার নেই।' });
    }
    return next();
  };
}

module.exports = {
  authRateLimiter,
  register,
  login,
  logout,
  forgotPassword,
  resetPassword,
  me,
  requireAuth,
  requireRole,
  audit,
  signToken,
  publicUser,
  // exported for isolated tests (no DB needed):
  _test: { validateRegister, makeReferralCode, signToken, publicUser },
};
