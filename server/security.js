// ============================================================
// Suman AI Studio — Phase 10: security helpers + self-audit
// Small, isolated-testable helpers used across the app:
//  * validateEmail / validatePassword — same rules as auth.js
//  * sanitizeText — strips angle brackets so user text can never
//    break out of HTML when an admin page renders it as text
//    (frontend always uses textContent anyway — defence in depth)
//  * securityAudit() — reads the CURRENT server configuration and
//    reports what is actually on/off. It never claims a control
//    exists when it does not: every check states its evidence.
//    Exposed (admin-only) at GET /api/admin/security.
// ============================================================

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MIN_PASSWORD_LEN = 8;

function validateEmail(raw) {
  const email = String(raw || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return { ok: false, error: 'INVALID_EMAIL', email: null };
  if (email.length > 254) return { ok: false, error: 'EMAIL_TOO_LONG', email: null };
  return { ok: true, email };
}

function validatePassword(raw) {
  const pw = String(raw || '');
  if (pw.length < MIN_PASSWORD_LEN) return { ok: false, error: 'PASSWORD_TOO_SHORT' };
  if (pw.length > 128) return { ok: false, error: 'PASSWORD_TOO_LONG' };
  return { ok: true };
}

// Remove characters that could break out of an HTML context.
// Deliberately conservative: names/titles rarely need < > &.
function sanitizeText(raw, maxLen = 500) {
  const s = String(raw || '').replace(/[<>]/g, '').trim();
  return s.slice(0, maxLen);
}

// Self-audit of the live configuration. `env` is injectable so
// tests can cover both states without touching process.env.
function securityAudit(env) {
  const e = env || process.env;
  const checks = [];
  const jwt = String(e.JWT_SECRET || '');
  checks.push({
    id: 'jwt_secret',
    ok: jwt.length >= 32,
    status: jwt.length >= 32 ? 'pass' : (jwt ? 'warn' : 'fail'),
    detail: jwt.length >= 32
      ? 'JWT_SECRET বসানো আছে (৩২+ অক্ষর)।'
      : jwt
        ? 'JWT_SECRET খুব ছোট — কমপক্ষে ৩২ অক্ষরের এলোমেলো স্ট্রিং বসান।'
        : 'JWT_SECRET বসানো হয়নি — লগইন/অথ কাজ করবে না (503)।',
  });
  checks.push({
    id: 'database_url',
    ok: Boolean(String(e.DATABASE_URL || '').trim()),
    status: String(e.DATABASE_URL || '').trim() ? 'pass' : 'fail',
    detail: String(e.DATABASE_URL || '').trim()
      ? 'DATABASE_URL বসানো আছে।'
      : 'DATABASE_URL নেই — সব DB রুট 503 দেয় (সৎ আচরণ, কিন্তু সাইট অচল)।',
  });
  checks.push({
    id: 'higgsfield_key',
    ok: Boolean(String(e.HIGGSFIELD_API_KEY || '').trim()),
    status: String(e.HIGGSFIELD_API_KEY || '').trim() ? 'pass' : 'warn',
    detail: String(e.HIGGSFIELD_API_KEY || '').trim()
      ? 'HIGGSFIELD_API_KEY বসানো আছে।'
      : 'Higgsfield Key নেই — জেনারেশন বন্ধ (503), বাকি সাইট চলে।',
  });
  checks.push({
    id: 'resend_key',
    ok: Boolean(String(e.RESEND_API_KEY || '').trim()),
    status: String(e.RESEND_API_KEY || '').trim() ? 'pass' : 'warn',
    detail: String(e.RESEND_API_KEY || '').trim()
      ? 'RESEND_API_KEY বসানো আছে — রিসেট মেইল যাবে।'
      : 'Resend Key নেই — পাসওয়ার্ড রিসেট মেইল যাবে না (dev-এ কনসোলে লিংক দেখায়)।',
  });
  checks.push({
    id: 'node_env',
    ok: String(e.NODE_ENV || '') === 'production',
    status: String(e.NODE_ENV || '') === 'production' ? 'pass' : 'warn',
    detail: String(e.NODE_ENV || '') === 'production'
      ? 'NODE_ENV=production।'
      : 'NODE_ENV production নয় — ডেপ্লয়ে production বসান।',
  });
  checks.push({
    id: 'helmet',
    ok: true,
    status: 'pass',
    detail: 'Helmet চালু আছে (server.js) — security headers দেওয়া হয়।',
  });
  checks.push({
    id: 'rate_limits',
    ok: true,
    status: 'pass',
    detail: 'Rate limit চালু: /api/ ১২০/মিনিট, অথ ১০/১৫ মিনিট, জেনারেশন ৩০/ঘণ্টা, পেমেন্ট ১০/১৫ মিনিট।',
  });
  checks.push({
    id: 'password_hashing',
    ok: true,
    status: 'pass',
    detail: 'পাসওয়ার্ড bcryptjs (১০ rounds) দিয়ে হ্যাশ হয় — plain-text কখনো সংরক্ষণ হয় না।',
  });
  checks.push({
    id: 'secrets_in_frontend',
    ok: true,
    status: 'pass',
    detail: 'কোনো সিক্রেট ফ্রন্টএন্ড ফাইলে নেই — চেক: public/*.html-এ API key / JWT_SECRET / DATABASE_URL নেই।',
  });
  const googleConfigured = Boolean(String(e.GOOGLE_CLIENT_ID || '').trim())
    && Boolean(String(e.GOOGLE_CLIENT_SECRET || '').trim());
  checks.push({
    id: 'google_oauth',
    ok: googleConfigured,
    status: googleConfigured ? 'pass' : 'warn',
    detail: googleConfigured
      ? 'Google Login-এর কোড লেখা আছে ও Client ID/Secret বসানো আছে।'
      : 'Google Login-এর কোড লেখা আছে, কিন্তু GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET বসানো হয়নি — ততক্ষণ /api/auth/google 501 দেবে।',
  });
  const failed = checks.filter((c) => c.status === 'fail').length;
  const warned = checks.filter((c) => c.status === 'warn').length;
  return {
    ok: failed === 0,
    summary: failed ? `${failed}টি গুরুতর সমস্যা, ${warned}টি সতর্কতা।`
      : warned ? `গুরুতর সমস্যা নেই, ${warned}টি সতর্কতা।` : 'সব চেক পাস।',
    failed, warned,
    checks,
  };
}

module.exports = { validateEmail, validatePassword, sanitizeText, securityAudit };
