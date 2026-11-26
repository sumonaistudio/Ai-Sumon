// ============================================================
// Suman AI Studio — Phase 2-4 isolated tests (no DB, no network)
// Run: npm test
// Tests bcrypt hashing, JWT sign/verify, input validation,
// referral-code format, and the honest NOT_CONFIGURED behaviour
// of mail + Higgsfield when keys are absent.
// Live DB tests (register/login/forgot against Supabase) are NOT
// possible here — DATABASE_URL is not set — and are recorded as
// BLOCKED in PHASE2-4-REPORT.md, not faked.
// ============================================================
process.env.JWT_SECRET = 'test-only-secret-do-not-use-in-production-123456';
process.env.NODE_ENV = 'test';
delete process.env.RESEND_API_KEY;
delete process.env.HIGGSFIELD_API_KEY;
delete process.env.DATABASE_URL;

const assert = require('node:assert');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const auth = require('../server/auth');
const mail = require('../server/mail');
const higgsfield = require('../server/higgsfield');

let passed = 0;
let failed = 0;
function check(name, fn) {
  try { fn(); console.log(`  PASS — ${name}`); passed++; }
  catch (e) { console.log(`  FAIL — ${name}: ${e.message}`); failed++; }
}
async function checkAsync(name, fn) {
  try { await fn(); console.log(`  PASS — ${name}`); passed++; }
  catch (e) { console.log(`  FAIL — ${name}: ${e.message}`); failed++; }
}

(async () => {
  console.log('Suman AI Studio — Phase 2-4 isolated tests (no DB)');

  // 1. bcrypt: hash is not the plain password; compare works; wrong password fails.
  const hash = await bcrypt.hash('MySecret123', 10);
  check('bcrypt hash != plain password', () => assert.notStrictEqual(hash, 'MySecret123'));
  check('bcrypt hash starts with $2', () => assert.ok(hash.startsWith('$2')));
  await checkAsync('bcrypt compare accepts correct password', async () => assert.strictEqual(await bcrypt.compare('MySecret123', hash), true));
  await checkAsync('bcrypt compare rejects wrong password', async () => assert.strictEqual(await bcrypt.compare('WrongPass999', hash), false));

  // 2. JWT: sign + verify round-trip, 7-day expiry, wrong secret rejected.
  const user = { id: '00000000-0000-0000-0000-000000000001', email: 'test@example.com', role: 'user' };
  const token = auth._test.signToken(user);
  check('JWT token has 3 parts', () => assert.strictEqual(token.split('.').length, 3));
  check('JWT verify returns sub/email/role', () => {
    const p = jwt.verify(token, process.env.JWT_SECRET);
    assert.strictEqual(p.sub, user.id);
    assert.strictEqual(p.email, user.email);
    assert.strictEqual(p.role, 'user');
  });
  check('JWT expires in 7 days', () => {
    const p = jwt.decode(token);
    assert.ok(Math.abs((p.exp - p.iat) - 7 * 24 * 3600) <= 5, `exp-iat=${p.exp - p.iat}`);
  });
  check('JWT verify rejects wrong secret', () => assert.throws(() => jwt.verify(token, 'wrong-secret')));

  // 3. Validation
  check('validation rejects bad email', () => {
    const { errors } = auth._test.validateRegister({ email: 'not-an-email', password: 'longenough123' });
    assert.ok(errors.email);
  });
  check('validation rejects short password (<8)', () => {
    const { errors } = auth._test.validateRegister({ email: 'a@b.com', password: 'short' });
    assert.ok(errors.password);
  });
  check('validation accepts good input', () => {
    const { errors, email } = auth._test.validateRegister({ email: '  User@Example.com ', password: 'longenough123', full_name: 'Test' });
    assert.deepStrictEqual(errors, {});
    assert.strictEqual(email, 'user@example.com'); // lowercased + trimmed
  });

  // 4. Referral codes: format + uniqueness over 200 samples.
  check('referral code: 8 chars, allowed charset, 200 unique', () => {
    const seen = new Set();
    for (let i = 0; i < 200; i++) {
      const c = auth._test.makeReferralCode();
      assert.match(c, /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/);
      seen.add(c);
    }
    assert.strictEqual(seen.size, 200);
  });

  // 5. publicUser never leaks password_hash / reset token.
  check('publicUser strips password_hash + reset_token_hash', () => {
    const pub = auth._test.publicUser({ id: '1', email: 'a@b.com', password_hash: 'SECRET', reset_token_hash: 'SECRET2', credit_balance: 100, role: 'user', status: 'active', full_name: 'A', is_paid: false, referral_code: 'ABCDEFGH', language: 'bn', theme: 'dark', email_verified: false, created_at: '2026-01-01' });
    assert.strictEqual(pub.password_hash, undefined);
    assert.strictEqual(pub.reset_token_hash, undefined);
    assert.strictEqual(pub.credit_balance, 100);
  });

  // 6. Mail: no Resend key -> honest NOT_CONFIGURED, no fake send.
  await checkAsync('mail without RESEND_API_KEY returns EMAIL_NOT_CONFIGURED', async () => {
    assert.strictEqual(mail.isConfigured(), false);
    const r = await mail.sendMail({ to: 'a@b.com', subject: 'x', html: '<p>x</p>' });
    assert.deepStrictEqual(r, { sent: false, reason: 'EMAIL_NOT_CONFIGURED' });
  });

  // 7. Higgsfield: no key -> not configured.
  check('higgsfield without key reports not configured', () => assert.strictEqual(higgsfield.isConfigured(), false));

  // 8. Seed + migration files exist and contain no secrets.
  const fs = require('node:fs');
  const path = require('node:path');
  check('002_seed.sql exists, has packages/templates/faqs, no password', () => {
    const sql = fs.readFileSync(path.join(__dirname, '../db/migrations/002_seed.sql'), 'utf8');
    assert.ok(sql.includes('INSERT INTO packages'));
    assert.ok(sql.includes('INSERT INTO templates'));
    assert.ok(sql.includes('INSERT INTO faqs'));
    assert.ok(!/password_hash/i.test(sql) || sql.includes('কোনো আসল ইউজার, পাসওয়ার্ড'));
    assert.ok(!sql.toLowerCase().includes('password123'));
  });
  check('run-migrations.js exists', () => assert.ok(fs.existsSync(path.join(__dirname, '../db/run-migrations.js'))));

  console.log(`\nResult: ${passed} passed, ${failed} failed (DB-dependent tests are BLOCKED, not run — see PHASE2-4-REPORT.md).`);
  process.exit(failed ? 1 : 0);
})();
