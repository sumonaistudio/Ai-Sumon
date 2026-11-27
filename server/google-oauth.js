// ============================================================
// Suman AI Studio — Google OAuth login (replaces the 501 stub)
// Plain OAuth2 code flow, no extra dependency (Node 20 fetch).
// What it needs from the owner (README ধাপ ২ক):
//   * Google Cloud Console-এ OAuth Client (Web application) —
//     Authorized redirect URI: <PUBLIC_URL>/api/auth/google/callback
//     (যেমন https://ai-sumon.onrender.com/api/auth/google/callback)
//   * Render Environment-এ GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET.
// Until those are set, /api/auth/google honestly answers 501
// GOOGLE_OAUTH_NOT_CONFIGURED — never a fake login.
// Rules enforced here:
//   * `state` is a random value in a short-lived HttpOnly cookie
//     (SameSite=Lax) and must match on callback — CSRF protection.
//   * Google must confirm email_verified=true before any account
//     is created or linked to that email.
//   * Existing email account + Google login with the same verified
//     email -> the accounts are LINKED (google_id set), not duplicated.
//   * Google-only accounts have password_hash NULL (the users table
//     already allows this) and email_verified=TRUE.
//   * New Google users get the same starter bonus as register, in
//     the SAME transaction, with the same idempotency key
//     `signup-bonus:<user_id>` — a retry can never credit twice.
//   * The JWT is handed to the browser in the URL FRAGMENT
//     (#google_token=...), never in a query string — fragments are
//     not sent to the server or written to server logs. login.html
//     stores it as sas_token (same key as password login) and goes
//     to /dashboard.html.
//   * Client secret is NEVER sent to the browser.
// ============================================================
const crypto = require('crypto');
const db = require('./db');
const auth = require('./auth');

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';
const STATE_COOKIE = 'sas_oauth_state';
const STATE_TTL_SECONDS = 600; // 10 minutes
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function isConfigured(env) {
  const e = env || process.env;
  return Boolean(String(e.GOOGLE_CLIENT_ID || '').trim())
    && Boolean(String(e.GOOGLE_CLIENT_SECRET || '').trim());
}

// The redirect URI must match EXACTLY what the owner registered in
// Google Cloud Console. PUBLIC_URL is the site address (Render);
// without it, fall back to the request's own host (local dev).
function googleRedirectUri(req) {
  const base = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
  if (base) return `${base}/api/auth/google/callback`;
  return `${req.protocol}://${req.get('host')}/api/auth/google/callback`;
}

function parseCookies(req) {
  const out = {};
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function stateCookieHeader(req, value, maxAge) {
  const secure = (process.env.PUBLIC_URL || '').startsWith('https://') || req.secure;
  return `${STATE_COOKIE}=${encodeURIComponent(value)}; HttpOnly; Path=/api/auth/google/callback; Max-Age=${maxAge}; SameSite=Lax${secure ? '; Secure' : ''}`;
}

function failToLogin(res, code) {
  return res.redirect(`/login.html#google_error=${encodeURIComponent(code)}`);
}

// ---------- GET /api/auth/google ----------
function startGoogleAuth(req, res) {
  if (!isConfigured()) {
    return res.status(501).json({
      error: 'GOOGLE_OAUTH_NOT_CONFIGURED',
      message: 'Google Login এখনো চালু হয়নি — মালিককে Google Cloud Console-এ OAuth Client বানিয়ে GOOGLE_CLIENT_ID ও GOOGLE_CLIENT_SECRET বসাতে হবে (README ধাপ ২ক দেখুন)।',
      docs: 'https://console.cloud.google.com/apis/credentials',
    });
  }
  const state = crypto.randomBytes(16).toString('hex');
  res.setHeader('Set-Cookie', stateCookieHeader(req, state, STATE_TTL_SECONDS));
  const params = new URLSearchParams({
    client_id: String(process.env.GOOGLE_CLIENT_ID).trim(),
    redirect_uri: googleRedirectUri(req),
    response_type: 'code',
    scope: 'openid email profile',
    state,
    prompt: 'select_account',
  });
  return res.redirect(`${GOOGLE_AUTH_URL}?${params.toString()}`);
}

// ---------- Google account -> our user (find, link, or create) ----------
async function findOrCreateGoogleUser(profile) {
  const email = String(profile.email || '').trim().toLowerCase();
  const fullName = String(profile.name || '').trim().slice(0, 100);

  const user = await db.withTransaction(async (client) => {
    const byGoogle = await client.query('SELECT * FROM users WHERE google_id = $1', [profile.sub]);
    let existing = byGoogle.rows[0];
    if (!existing) {
      const byEmail = await client.query('SELECT * FROM users WHERE email = $1', [email]);
      existing = byEmail.rows[0];
    }
    if (existing) {
      if (existing.status === 'suspended') {
        const err = new Error('ACCOUNT_SUSPENDED');
        err.status = 403;
        throw err;
      }
      if (existing.status === 'banned') {
        const err = new Error('ACCOUNT_BANNED');
        err.status = 403;
        throw err;
      }
      const r = await client.query(
        'UPDATE users SET google_id = $1, email_verified = TRUE, last_login_at = now() WHERE id = $2 RETURNING *',
        [profile.sub, existing.id]
      );
      await auth.audit(client, 'auth.google_login', existing.id, 'user', existing.id, null);
      return r.rows[0];
    }

    // New user — same starter bonus as email register, same transaction.
    const s = await client.query("SELECT value FROM settings WHERE key = 'signup_bonus_credits'");
    const bonus = Math.max(0, parseInt(s.rows[0] ? s.rows[0].value : '100', 10) || 0);
    const userId = crypto.randomUUID();
    let referralCode = auth._test.makeReferralCode();
    let created = null;
    for (let attempt = 0; attempt < 5 && !created; attempt++) {
      try {
        const r = await client.query(
          `INSERT INTO users (id, email, password_hash, google_id, full_name, referral_code, email_verified, credit_balance)
           VALUES ($1,$2,NULL,$3,$4,$5,TRUE,$6) RETURNING *`,
          [userId, email, profile.sub, fullName, referralCode, bonus]
        );
        created = r.rows[0];
      } catch (e) {
        if (e.code === '23505' && attempt < 4) { referralCode = auth._test.makeReferralCode(); continue; }
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
    await auth.audit(client, 'auth.google_signup', userId, 'user', userId, { bonus });
    return created;
  });
  return user;
}

// ---------- GET /api/auth/google/callback ----------
async function handleGoogleCallback(req, res) {
  if (!isConfigured()) {
    return res.status(501).json({
      error: 'GOOGLE_OAUTH_NOT_CONFIGURED',
      message: 'Google Login এখনো চালু হয়নি — দেখুন /api/auth/google।',
    });
  }
  // State cookie is single-use: clear it whatever happens next.
  res.setHeader('Set-Cookie', stateCookieHeader(req, '', 0));

  if (req.query.error) {
    return failToLogin(res, req.query.error === 'access_denied' ? 'access_denied' : 'google_error');
  }
  const cookies = parseCookies(req);
  const state = String(req.query.state || '');
  if (!state || !cookies[STATE_COOKIE] || cookies[STATE_COOKIE] !== state) {
    return failToLogin(res, 'invalid_state');
  }
  const code = String(req.query.code || '');
  if (!code) return failToLogin(res, 'missing_code');
  if (!db.getPool()) {
    return res.status(503).json({
      error: 'DB_NOT_CONFIGURED',
      message: 'ডেটাবেস এখনো সংযুক্ত হয়নি (DATABASE_URL নেই)।',
    });
  }
  if (!String(process.env.JWT_SECRET || '').trim()) {
    return res.status(503).json({ error: 'JWT_NOT_CONFIGURED', message: 'JWT_SECRET সেট করা হয়নি।' });
  }

  try {
    // 1. Code -> access token (server-to-server; secret never leaves here).
    const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: String(process.env.GOOGLE_CLIENT_ID).trim(),
        client_secret: String(process.env.GOOGLE_CLIENT_SECRET).trim(),
        redirect_uri: googleRedirectUri(req),
        grant_type: 'authorization_code',
      }),
    });
    if (!tokenRes.ok) {
      console.error('[google-oauth] token exchange failed:', tokenRes.status);
      return failToLogin(res, 'token_failed');
    }
    const tokens = await tokenRes.json();
    if (!tokens.access_token) return failToLogin(res, 'token_failed');

    // 2. Access token -> verified profile.
    const meRes = await fetch(GOOGLE_USERINFO_URL, {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    if (!meRes.ok) {
      console.error('[google-oauth] userinfo failed:', meRes.status);
      return failToLogin(res, 'userinfo_failed');
    }
    const profile = await meRes.json();
    const email = String(profile.email || '').trim().toLowerCase();
    if (!profile.sub || !EMAIL_RE.test(email) || profile.email_verified !== true) {
      return failToLogin(res, 'email_not_verified');
    }

    // 3. Find, link, or create — then sign our own JWT.
    let user;
    try {
      user = await findOrCreateGoogleUser(profile);
    } catch (err) {
      // Rare race: two callbacks created the same email at once.
      // Re-read instead of failing — the account now exists.
      if (err.code === '23505') {
        const r = await db.query('SELECT * FROM users WHERE google_id = $1 OR email = $2', [profile.sub, email]);
        if (r.rows[0]) user = r.rows[0];
      }
      if (!user) throw err;
    }
    const token = auth.signToken(user);
    return res.redirect(`/login.html#google_token=${encodeURIComponent(token)}`);
  } catch (err) {
    if (err.status === 403 && err.message === 'ACCOUNT_SUSPENDED') return failToLogin(res, 'account_suspended');
    if (err.status === 403 && err.message === 'ACCOUNT_BANNED') return failToLogin(res, 'account_banned');
    console.error('[google-oauth] callback failed:', err);
    return failToLogin(res, 'server_error');
  }
}

module.exports = {
  startGoogleAuth,
  handleGoogleCallback,
  findOrCreateGoogleUser,
  // exported for isolated tests (no DB, no network):
  _test: { isConfigured, googleRedirectUri, parseCookies },
};
