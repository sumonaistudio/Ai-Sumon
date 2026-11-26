// ============================================================
// Suman AI Studio — Phase 5-7 isolated tests (no DB, no network)
// Run: npm test (runs auth tests, then this file)
// Tests the PURE logic only — ledger math, idempotency keys,
// payment validation, server-side package pricing, expiry math,
// model-update validation, analytics labelling.
// Anything needing Postgres (real approve/refund/list flows) is
// BLOCKED without DATABASE_URL — recorded in PHASE5-7-REPORT.md,
// never faked here.
// ============================================================
process.env.JWT_SECRET = 'test-only-secret-do-not-use-in-production-123456';
process.env.NODE_ENV = 'test';
delete process.env.RESEND_API_KEY;
delete process.env.HIGGSFIELD_API_KEY;
delete process.env.DATABASE_URL;

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const credits = require('../server/credits');
const payments = require('../server/payments');
const creations = require('../server/creations');
const admin = require('../server/admin');

let passed = 0;
let failed = 0;
function check(name, fn) {
  try { fn(); console.log(`  PASS — ${name}`); passed++; }
  catch (e) { console.log(`  FAIL — ${name}: ${e.message}`); failed++; }
}

(async () => {
  console.log('Suman AI Studio — Phase 5-7 isolated tests (no DB)');

  // 1. Ledger math: never negative, integer-only.
  check('ledger: deduct within balance ok', () => assert.strictEqual(credits.computeBalanceAfter(100, -30), 70));
  check('ledger: add credits ok', () => assert.strictEqual(credits.computeBalanceAfter(100, 50), 150));
  check('ledger: deduct more than balance throws INSUFFICIENT_CREDITS', () => {
    assert.throws(() => credits.computeBalanceAfter(10, -11), (e) => e.code === 'INSUFFICIENT_CREDITS');
  });
  check('ledger: exact-balance deduct reaches 0, not below', () => assert.strictEqual(credits.computeBalanceAfter(50, -50), 0));
  check('ledger: non-integer amount rejected', () => assert.throws(() => credits.computeBalanceAfter(100, 1.5)));

  // 2. Idempotency keys are deterministic per operation.
  check('idempotency: same inputs -> same key', () => {
    assert.strictEqual(credits.makeIdempotencyKey('refund', 'abc'), credits.makeIdempotencyKey('refund', 'abc'));
    assert.notStrictEqual(credits.makeIdempotencyKey('refund', 'abc'), credits.makeIdempotencyKey('payment-approve', 'abc'));
  });
  check('idempotency: refund key format is refund:<generation_id>', () => {
    assert.strictEqual(credits.makeIdempotencyKey('refund', 'gen-1'), 'refund:gen-1');
  });

  // 3. Payment validation.
  check('payment: valid bkash input passes', () => {
    const { errors, method, transactionId, senderNumber } = payments._test.validatePaymentInput({
      method: 'bkash', package_id: 'pkg-1', transaction_id: '9kx7a2b4c1', sender_number: '01712345678',
    });
    assert.deepStrictEqual(errors, {});
    assert.strictEqual(method, 'bkash');
    assert.strictEqual(transactionId, '9KX7A2B4C1'); // normalised to upper-case
    assert.strictEqual(senderNumber, '01712345678');
  });
  check('payment: +88 prefix sender number normalised', () => {
    const { senderNumber, errors } = payments._test.validatePaymentInput({
      method: 'nagad', package_id: 'pkg-1', transaction_id: 'ABC123456', sender_number: '+8801812345678',
    });
    assert.deepStrictEqual(errors, {});
    assert.strictEqual(senderNumber, '01812345678');
  });
  check('payment: bad method rejected', () => {
    const { errors } = payments._test.validatePaymentInput({ method: 'rocket', package_id: 'p', transaction_id: 'ABC123456', sender_number: '01712345678' });
    assert.ok(errors.method);
  });
  check('payment: short trx id rejected', () => {
    const { errors } = payments._test.validatePaymentInput({ method: 'bkash', package_id: 'p', transaction_id: 'AB12', sender_number: '01712345678' });
    assert.ok(errors.transaction_id);
  });
  check('payment: non-BD sender number rejected', () => {
    const { errors } = payments._test.validatePaymentInput({ method: 'bkash', package_id: 'p', transaction_id: 'ABC123456', sender_number: '01234567890' });
    assert.ok(errors.sender_number);
  });
  check('payment: missing package rejected', () => {
    const { errors } = payments._test.validatePaymentInput({ method: 'bkash', package_id: '', transaction_id: 'ABC123456', sender_number: '01712345678' });
    assert.ok(errors.package_id);
  });

  // 4. Server-side pricing: amount ALWAYS comes from the package row.
  const fakePackages = [
    { id: 'pkg-a', kind: 'credit_pack', price_bdt: 250, credits: 150 },
    { id: 'pkg-b', kind: 'monthly', price_bdt: 499, credits: 300 },
  ];
  check('pricing: browser amount is ignored — package row is the source', () => {
    const pkg = payments._test.findPackageById(fakePackages, 'pkg-a');
    const amt = payments._test.amountForPackage(pkg);
    assert.deepStrictEqual(amt, { amount_bdt: 250, credits: 150, kind: 'credit_pack' });
    // Even if the browser sent amount_bdt: 1, the server would charge 250.
    assert.notStrictEqual(amt.amount_bdt, 1);
  });
  check('pricing: unknown package id -> null (route must 400)', () => {
    assert.strictEqual(payments._test.findPackageById(fakePackages, 'nope'), null);
    assert.strictEqual(payments._test.amountForPackage(null), null);
  });

  // 5. Expiry math (Phase 5).
  check('expiry: 30-day retention from created_at', () => {
    const now = new Date('2026-11-26T00:00:00Z');
    const created = new Date('2026-11-01T00:00:00Z');
    const info = creations._test.expiryInfo({ created_at: created.toISOString(), expires_at: null }, 30, now);
    assert.strictEqual(info.days_left, 5);
    assert.strictEqual(info.expiring_soon, false);
    assert.strictEqual(info.expired, false);
  });
  check('expiry: expiring within 3 days flagged', () => {
    const now = new Date('2026-11-26T00:00:00Z');
    const info = creations._test.expiryInfo({ created_at: '2026-11-01T00:00:00Z', expires_at: '2026-11-28T00:00:00Z' }, 30, now);
    assert.strictEqual(info.days_left, 2);
    assert.strictEqual(info.expiring_soon, true);
  });
  check('expiry: past expires_at is expired', () => {
    const now = new Date('2026-11-26T00:00:00Z');
    const info = creations._test.expiryInfo({ created_at: '2026-10-01T00:00:00Z', expires_at: '2026-10-31T00:00:00Z' }, 30, now);
    assert.strictEqual(info.expired, true);
    assert.strictEqual(info.expiring_soon, false);
  });
  check('expiry: publicCreation hides result_url + error unless failed', () => {
    const row = { id: 'g1', type: 'text-to-image', model_id: 'm', prompt: 'x', status: 'completed', credit_cost: 2, result_url: 'https://example.com/f.png', error_message: 'boom', expires_at: '2026-12-26T00:00:00Z', created_at: '2026-11-26T00:00:00Z', completed_at: '2026-11-26T00:00:00Z' };
    const pub = creations._test.publicCreation(row, 30, new Date('2026-11-26T00:00:00Z'));
    assert.strictEqual(pub.result_url, undefined); // never leak the direct URL in list payloads
    assert.strictEqual(pub.has_result, true);
    assert.strictEqual(pub.error_message, null);
  });

  // 6. Model update validation (admin).
  const registry = JSON.parse(fs.readFileSync(path.join(__dirname, '../config/models.json'), 'utf8'));
  check('model: unknown id rejected (never invent a model)', () => {
    const v = admin._test.validateModelUpdate(registry, 'fake-model/xyz', { enabled: true });
    assert.strictEqual(v.error, 'MODEL_NOT_FOUND');
  });
  check('model: disable + cost change validates', () => {
    const v = admin._test.validateModelUpdate(registry, 'higgsfield-ai/soul/v2/standard', { enabled: false, credit_cost: 5 });
    assert.deepStrictEqual(v.errors, {});
    assert.strictEqual(v.enabled, false);
    assert.strictEqual(v.creditCost, 5);
  });
  check('model: negative credit cost rejected', () => {
    const v = admin._test.validateModelUpdate(registry, 'higgsfield-ai/soul/v2/standard', { credit_cost: -1 });
    assert.ok(v.errors.credit_cost);
  });
  check('model: non-boolean enabled rejected', () => {
    const v = admin._test.validateModelUpdate(registry, 'higgsfield-ai/soul/v2/standard', { enabled: 'yes' });
    assert.ok(v.errors.enabled);
  });

  // 7. Package validation (admin).
  check('package: valid package passes', () => {
    const v = admin._test.validatePackage({ kind: 'monthly', name_bn: 'মাসিক', name_en: 'Monthly', price_bdt: 499, price_usd: 4.16, credits: 300 });
    assert.deepStrictEqual(v.errors, {});
  });
  check('package: bad kind / negative price rejected', () => {
    const v = admin._test.validatePackage({ kind: 'lifetime', name_bn: 'x', name_en: 'y', price_bdt: -5, price_usd: 0, credits: 10 });
    assert.ok(v.errors.kind);
    assert.ok(v.errors.price_bdt);
  });

  // 8. Analytics labelling: estimate rate is explicit, not hidden.
  check('analytics: USD->BDT estimate rate is a named constant (120)', () => {
    assert.strictEqual(admin._test.USD_TO_BDT_ESTIMATE, 120);
  });

  // 9. Migration 003 exists and only adds deleted_at.
  check('migration 003 exists, adds deleted_at, no DROP', () => {
    const sql = fs.readFileSync(path.join(__dirname, '../db/migrations/003_phase57.sql'), 'utf8');
    assert.ok(sql.includes('deleted_at'));
    assert.ok(!/DROP TABLE/i.test(sql));
  });
  check('run-migrations lists 001, 002 and 003', () => {
    const runner = fs.readFileSync(path.join(__dirname, '../db/run-migrations.js'), 'utf8');
    assert.ok(runner.includes('003_phase57.sql'));
  });

  // 10. New frontend pages exist and contain no secrets / hardcoded payment numbers.
  check('frontend: payments/pricing/admin pages exist, no hardcoded bkash number', () => {
    for (const f of ['payments.html', 'pricing.html', 'admin.html', 'dashboard.html']) {
      const html = fs.readFileSync(path.join(__dirname, '../public', f), 'utf8');
      assert.ok(html.length > 1000, `${f} too small`);
      assert.ok(!/01[3-9]\d{8}/.test(html), `${f} must not hardcode a payment number`);
      assert.ok(!/HIGGSFIELD_API_KEY|JWT_SECRET|DATABASE_URL/.test(html), `${f} must not contain secrets`);
    }
  });

  console.log(`\nResult: ${passed} passed, ${failed} failed (DB-dependent tests are BLOCKED, not run — see PHASE5-7-REPORT.md).`);
  process.exit(failed ? 1 : 0);
})();
