// ============================================================
// Suman AI Studio — Google OAuth isolated tests (no DB, no network)
// Run: npm test
// Covers the honest behaviour that needs no live Google account:
//   * unconfigured -> 501 GOOGLE_OAUTH_NOT_CONFIGURED (never fake)
//   * configured -> 302 to accounts.google.com with the exact
//     redirect_uri the owner registers in Google Cloud Console,
//     plus a HttpOnly state cookie (CSRF protection)
//   * callback with missing/wrong state -> login page with
//     #google_error=invalid_state (no DB, no Google call)
//   * callback with valid state but no code -> missing_code
//   * callback with Google's access_denied -> access_denied
// Live end-to-end (real code -> real user -> JWT) needs a real
// OAuth Client + Render env vars and is a manual TESTING.md step,
// not faked here.
// ============================================================
const assert = require('node:assert');

// Require the app first (it loads dotenv), then force the test env —
// handlers read process.env live, so this controls every request.
const app = require('../server');
const googleOAuth = require('../server/google-oauth');

process.env.JWT_SECRET = 'test-jwt-secret-that-is-long-enough-123456';
process.env.NODE_ENV = 'test';
process.env.PUBLIC_URL = 'https://ai-sumon.onrender.com';
delete process.env.DATABASE_URL;
delete process.env.GOOGLE_CLIENT_ID;
delete process.env.GOOGLE_CLIENT_SECRET;

let passed = 0;
let failed = 0;
function check(name, fn) {
  try { fn(); console.log(`  PASS — ${name}`); passed++; }
  catch (e) { console.log(`  FAIL — ${name}: ${e.message}`); failed++; process.exitCode = 1; }
}
async function checkAsync(name, fn) {
  try { await fn(); console.log(`  PASS — ${name}`); passed++; }
  catch (e) { console.log(`  FAIL — ${name}: ${e.message}`); failed++; process.exitCode = 1; }
}

function cookieValue(setCookieHeaders, name) {
  for (const h of setCookieHeaders || []) {
    const m = h.match(new RegExp(`^${name}=([^;]*)`));
    if (m) return decodeURIComponent(m[1]);
  }
  return null;
}

(async () => {
  console.log('Suman AI Studio — Google OAuth isolated tests (no DB, no network)');
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;

  check('isConfigured: খালি env-এ false', () => {
    assert.strictEqual(googleOAuth._test.isConfigured({}), false);
    assert.strictEqual(googleOAuth._test.isConfigured({ GOOGLE_CLIENT_ID: 'x' }), false);
    assert.strictEqual(googleOAuth._test.isConfigured({ GOOGLE_CLIENT_SECRET: 'y' }), false);
  });
  check('isConfigured: দুটোই থাকলে true', () => {
    assert.strictEqual(googleOAuth._test.isConfigured({ GOOGLE_CLIENT_ID: 'x', GOOGLE_CLIENT_SECRET: 'y' }), true);
  });

  await checkAsync('unconfigured: /api/auth/google 501 দেয়', async () => {
    const r = await fetch(`${base}/api/auth/google`, { redirect: 'manual' });
    assert.strictEqual(r.status, 501);
    const d = await r.json();
    assert.strictEqual(d.error, 'GOOGLE_OAUTH_NOT_CONFIGURED');
  });

  // Configure for the rest of the tests.
  process.env.GOOGLE_CLIENT_ID = 'test-id.apps.googleusercontent.com';
  process.env.GOOGLE_CLIENT_SECRET = 'test-secret';

  let stateCookie = null;
  await checkAsync('configured: Google-এর দিকে 302 + সঠিক redirect_uri + state কুকি', async () => {
    const r = await fetch(`${base}/api/auth/google`, { redirect: 'manual' });
    assert.strictEqual(r.status, 302);
    const loc = r.headers.get('location');
    assert.ok(loc.startsWith('https://accounts.google.com/o/oauth2/v2/auth?'), loc);
    const u = new URL(loc);
    assert.strictEqual(u.searchParams.get('client_id'), 'test-id.apps.googleusercontent.com');
    assert.strictEqual(u.searchParams.get('redirect_uri'), 'https://ai-sumon.onrender.com/api/auth/google/callback');
    assert.strictEqual(u.searchParams.get('response_type'), 'code');
    assert.ok(u.searchParams.get('scope').includes('openid'));
    assert.ok(u.searchParams.get('scope').includes('email'));
    assert.ok(u.searchParams.get('state'), 'state param missing');
    const cookies = r.headers.getSetCookie();
    stateCookie = cookieValue(cookies, 'sas_oauth_state');
    assert.ok(stateCookie, 'state cookie missing');
    assert.ok(cookies.some((c) => c.includes('HttpOnly')), 'state cookie must be HttpOnly');
    assert.ok(cookies.some((c) => c.includes('SameSite=Lax')), 'state cookie must be SameSite=Lax');
    assert.ok(cookies.some((c) => c.includes('Secure')), 'state cookie must be Secure on https');
  });

  await checkAsync('callback: state কুকি ছাড়া invalid_state', async () => {
    const r = await fetch(`${base}/api/auth/google/callback?code=x&state=y`, { redirect: 'manual' });
    assert.strictEqual(r.status, 302);
    assert.ok(r.headers.get('location').includes('/login.html#google_error=invalid_state'), r.headers.get('location'));
  });

  await checkAsync('callback: ভুল state-এ invalid_state', async () => {
    const r = await fetch(`${base}/api/auth/google/callback?code=x&state=wrong-state`, {
      redirect: 'manual',
      headers: { cookie: 'sas_oauth_state=some-other-state' },
    });
    assert.strictEqual(r.status, 302);
    assert.ok(r.headers.get('location').includes('/login.html#google_error=invalid_state'));
  });

  await checkAsync('callback: সঠিক state কিন্তু code নেই — missing_code', async () => {
    const r = await fetch(`${base}/api/auth/google/callback?state=${stateCookie}`, {
      redirect: 'manual',
      headers: { cookie: `sas_oauth_state=${stateCookie}` },
    });
    assert.strictEqual(r.status, 302);
    assert.ok(r.headers.get('location').includes('/login.html#google_error=missing_code'), r.headers.get('location'));
  });

  await checkAsync('callback: Google access_denied — লগইন পাতায় ফেরত', async () => {
    const r = await fetch(`${base}/api/auth/google/callback?error=access_denied&state=${stateCookie}`, {
      redirect: 'manual',
      headers: { cookie: `sas_oauth_state=${stateCookie}` },
    });
    assert.strictEqual(r.status, 302);
    assert.ok(r.headers.get('location').includes('/login.html#google_error=access_denied'), r.headers.get('location'));
  });

  server.close();
  console.log(`\nResult: ${passed} passed, ${failed} failed.`);
})();
