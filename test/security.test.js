// ============================================================
// Suman AI Studio — Phase 10 security isolated tests
// (no DB, no network). Run: node test/security.test.js
// ============================================================
const assert = require('node:assert');
const security = require('../server/security');

let passed = 0;
function check(name, fn) {
  try { fn(); passed += 1; console.log(`  PASS — ${name}`); }
  catch (err) { console.log(`  FAIL — ${name}: ${err.message}`); process.exitCode = 1; }
}

console.log('Phase 10 security isolated tests (DB ছাড়া):');

check('email: সঠিক ইমেইল পাস', () => {
  assert.strictEqual(security.validateEmail('sumon@example.com').ok, true);
});
check('email: ভুল ইমেইল বাতিল', () => {
  assert.strictEqual(security.validateEmail('not-an-email').ok, false);
  assert.strictEqual(security.validateEmail('a@b').ok, false);
});
check('email: বড় হাতের ইমেইল ছোট হাতে normalise হয়', () => {
  assert.strictEqual(security.validateEmail('Sumon@Example.COM').email, 'sumon@example.com');
});
check('password: ৮ অক্ষরের কম বাতিল', () => {
  assert.strictEqual(security.validatePassword('short').ok, false);
});
check('password: ৮+ অক্ষর পাস', () => {
  assert.strictEqual(security.validatePassword('s0meStrong!').ok, true);
});
check('sanitize: < > সরিয়ে দেয়', () => {
  assert.strictEqual(security.sanitizeText('<script>alert(1)</script>'), 'scriptalert(1)/script');
});
check('sanitize: সাধারণ বাংলা লেখা অপরিবর্তিত থাকে', () => {
  assert.strictEqual(security.sanitizeText('রহিমা'), 'রহিমা');
});
check('audit: কিছুই সেট না থাকলে fail ধরা পড়ে', () => {
  const a = security.securityAudit({});
  assert.strictEqual(a.ok, false);
  assert.ok(a.checks.find((c) => c.id === 'jwt_secret').status === 'fail');
  assert.ok(a.checks.find((c) => c.id === 'database_url').status === 'fail');
});
check('audit: সব সেট থাকলে গুরুতর সমস্যা নেই', () => {
  const a = security.securityAudit({
    JWT_SECRET: 'x'.repeat(40), DATABASE_URL: 'postgres://u:p@h:5432/db',
    HIGGSFIELD_API_KEY: 'id:secret', RESEND_API_KEY: 're_123', NODE_ENV: 'production',
  });
  assert.strictEqual(a.failed, 0);
  assert.strictEqual(a.ok, true);
});
check('audit: Google OAuth এখনো warn হিসেবে দেখায় (সৎ)', () => {
  const a = security.securityAudit({ JWT_SECRET: 'x'.repeat(40), DATABASE_URL: 'postgres://u:p@h:5432/db' });
  assert.strictEqual(a.checks.find((c) => c.id === 'google_oauth').status, 'warn');
});

console.log(`\nResult: ${passed} passed, ${process.exitCode ? 1 : 0} failed.`);
