// ===========================================================
// Suman AI Studio — Phase 8 isolated tests (no DB, no network)
// Run: node test/generate-gallery.test.js
// Tests the PURE logic only — server-side cost estimation,
// idempotency / refund key formats, watermark flag logic,
// prompt + upload-metadata validation, and the honest
// 401 / 503 / 501 responses of the handlers (mock req/res).
// Anything needing Postgres (real deduct/submit/poll/cancel)
// or a live Higgsfield key is BLOCKED without DATABASE_URL /
// HIGGSFIELD_API_KEY — recorded in the Phase 8 report, never
// faked here.
// ===========================================================
process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;
delete process.env.HIGGSFIELD_API_KEY;
delete process.env.HIGGSFIELD_KEY_ID;
delete process.env.HIGGSFIELD_KEY_SECRET;

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const generate = require('../server/generate');

let passed = 0;
let failed = 0;
function check(name, fn) {
  try { fn(); console.log(`  PASS — ${name}`); passed++; }
  catch (e) { console.log(`  FAIL — ${name}: ${e.message}`); failed++; }
}
function mockRes() {
  const res = { statusCode: 200, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (obj) => { res.body = obj; return res; };
  return res;
}

(async () => {
  console.log('Suman AI Studio — Phase 8 isolated tests (no DB, no network)');

  // 1. Cost estimation from the server-side registry.
  check('cost: Soul 2 costs 2 credits (server-side registry)', () => {
    const c = generate.estimateCost('higgsfield-ai/soul/v2/standard');
    assert.strictEqual(c.credit_cost, 2);
    assert.strictEqual(c.type, 'text-to-image');
  });
  check('cost: Kling 4.0 costs 15 credits', () => {
    assert.strictEqual(generate.estimateCost('kling-video/v4.0/image-to-video').credit_cost, 15);
  });
  check('cost: Seedance 2.5 costs 35 credits', () => {
    assert.strictEqual(generate.estimateCost('bytedance/seedance-2.5/image-to-video').credit_cost, 35);
  });
  check('cost: unknown model throws UNKNOWN_MODEL (400)', () => {
    assert.throws(
      () => generate.estimateCost('nano-banana-pro'),
      (e) => e.code === 'UNKNOWN_MODEL' && e.status === 400
    );
  });
  check('cost: disabled model throws MODEL_DISABLED (403)', () => {
    assert.throws(
      () => generate.estimateCost('higgsfield/genjutsu/motion-transfer/v1.0'),
      (e) => e.code === 'MODEL_DISABLED' && e.status === 403
    );
  });
  check('cost: unverified model throws MODEL_UNVERIFIED (400)', () => {
    const fakeList = [{ id: 'x/unverified', name: 'X', type: 'text-to-image', enabled: true, verified: false, credit_cost: 5 }];
    assert.throws(
      () => generate.estimateCost('x/unverified', fakeList),
      (e) => e.code === 'MODEL_UNVERIFIED' && e.status === 400
    );
  });
  check('cost: model with no valid credit_cost throws MODEL_COST_INVALID', () => {
    const fakeList = [{ id: 'x/nocost', name: 'X', type: 'text-to-image', enabled: true, verified: true }];
    assert.throws(
      () => generate.estimateCost('x/nocost', fakeList),
      (e) => e.code === 'MODEL_COST_INVALID'
    );
  });

  // 2. Idempotency key format + uniqueness.
  check('idempotency: format is generate:<uuid>, deterministic per input', () => {
    assert.strictEqual(generate.buildIdempotencyKey('generate', 'abc-123'), 'generate:abc-123');
    assert.strictEqual(
      generate.buildIdempotencyKey('generate', 'abc-123'),
      generate.buildIdempotencyKey('generate', 'abc-123')
    );
  });
  check('idempotency: different uuids give different keys', () => {
    assert.notStrictEqual(
      generate.buildIdempotencyKey('generate', 'uuid-1'),
      generate.buildIdempotencyKey('generate', 'uuid-2')
    );
    assert.notStrictEqual(
      generate.buildIdempotencyKey('generate', 'uuid-1'),
      generate.buildIdempotencyKey('refund', 'uuid-1')
    );
  });

  // 3. Refund key format.
  check('refund: key format is refund:<generation_id>', () => {
    assert.strictEqual(generate.refundKeyFor('gen-1'), 'refund:gen-1');
  });

  // 4. Watermark flag logic.
  check('watermark: free user (no sub, not paid) -> true', () => {
    assert.strictEqual(generate._test.watermarkRequiredForUser({ hasActiveSubscription: false, isPaid: false }), true);
  });
  check('watermark: active subscriber -> false', () => {
    assert.strictEqual(generate._test.watermarkRequiredForUser({ hasActiveSubscription: true, isPaid: false }), false);
  });
  check('watermark: paid user (is_paid, no subscription row) -> false', () => {
    assert.strictEqual(generate._test.watermarkRequiredForUser({ hasActiveSubscription: false, isPaid: true }), false);
  });
  check('watermark: DB check failed -> true (safe default)', () => {
    assert.strictEqual(generate._test.watermarkRequiredForUser({ hasActiveSubscription: true, isPaid: true, dbError: true }), true);
    assert.strictEqual(generate._test.watermarkRequiredForUser({}), true);
  });

  // 5. Prompt validation.
  check('prompt: valid prompt passes (trimmed)', () => {
    const r = generate._test.validatePrompt('  ঢাকার বৃষ্টি  ');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.prompt, 'ঢাকার বৃষ্টি');
  });
  check('prompt: empty string rejected', () => {
    assert.strictEqual(generate._test.validatePrompt('').ok, false);
    assert.strictEqual(generate._test.validatePrompt('   ').ok, false);
    assert.strictEqual(generate._test.validatePrompt('').error, 'PROMPT_REQUIRED');
  });
  check('prompt: non-string rejected', () => {
    assert.strictEqual(generate._test.validatePrompt(null).ok, false);
    assert.strictEqual(generate._test.validatePrompt(123).ok, false);
  });
  check('prompt: over 2000 chars rejected', () => {
    assert.strictEqual(generate._test.validatePrompt('x'.repeat(2001)).error, 'PROMPT_TOO_LONG');
    assert.strictEqual(generate._test.validatePrompt('x'.repeat(2000)).ok, true);
  });

  // 6. Upload-reference metadata validation (pure part).
  check('upload meta: valid image passes validation', () => {
    const r = generate._test.validateUploadReference({ filename: 'ref.png', contentType: 'image/png', sizeBytes: 1024 });
    assert.strictEqual(r.ok, true);
  });
  check('upload meta: bad type rejected', () => {
    const r = generate._test.validateUploadReference({ filename: 'a.exe', contentType: 'application/octet-stream', sizeBytes: 10 });
    assert.strictEqual(r.ok, false);
  });
  check('upload meta: over 50MB rejected', () => {
    const r = generate._test.validateUploadReference({ filename: 'big.mp4', contentType: 'video/mp4', sizeBytes: 51 * 1024 * 1024 });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(generate._test.MAX_UPLOAD_BYTES, 50 * 1024 * 1024);
  });
  check('upload meta: missing filename / size rejected', () => {
    assert.strictEqual(generate._test.validateUploadReference({ contentType: 'image/png', sizeBytes: 10 }).ok, false);
    assert.strictEqual(generate._test.validateUploadReference({ filename: 'a.png', contentType: 'image/png' }).ok, false);
  });

  // 7. Handler honesty with mock req/res (no DB, no network).
  await (async () => {
    const res401 = mockRes();
    await generate.uploadReference({ user: null, body: {} }, res401);
    check('upload: no user -> 401 UNAUTHORIZED', () => {
      assert.strictEqual(res401.statusCode, 401);
      assert.strictEqual(res401.body.error, 'UNAUTHORIZED');
    });
    const res400 = mockRes();
    await generate.uploadReference(
      { user: { id: 'u1' }, body: { filename: 'a.exe', contentType: 'application/octet-stream', sizeBytes: 10 } },
      res400
    );
    check('upload: invalid metadata -> 400, no fake success', () => {
      assert.strictEqual(res400.statusCode, 400);
    });
    const res501 = mockRes();
    await generate.uploadReference(
      { user: { id: 'u1' }, body: { filename: 'ref.png', contentType: 'image/png', sizeBytes: 2048 } },
      res501
    );
    check('upload: valid metadata still -> 501 STORAGE_NOT_CONFIGURED (never faked)', () => {
      assert.strictEqual(res501.statusCode, 501);
      assert.strictEqual(res501.body.error, 'STORAGE_NOT_CONFIGURED');
    });
    const resGen401 = mockRes();
    await generate.submitGeneration({ user: null, body: {} }, resGen401);
    check('generate: no user -> 401', () => {
      assert.strictEqual(resGen401.statusCode, 401);
    });
    const resGen503 = mockRes();
    await generate.submitGeneration(
      { user: { id: 'u1', is_paid: false }, body: { model_id: 'higgsfield-ai/soul/v2/standard', prompt: 'test' } },
      resGen503
    );
    check('generate: no DATABASE_URL -> 503 DB_NOT_CONFIGURED (no charge attempted)', () => {
      assert.strictEqual(resGen503.statusCode, 503);
      assert.strictEqual(resGen503.body.error, 'DB_NOT_CONFIGURED');
    });
    const resStatus401 = mockRes();
    await generate.checkStatus({ user: null, params: { id: 'g1' } }, resStatus401);
    check('status: no user -> 401', () => {
      assert.strictEqual(resStatus401.statusCode, 401);
    });
    const resCancel401 = mockRes();
    await generate.cancelGeneration({ user: null, params: { id: 'g1' } }, resCancel401);
    check('cancel: no user -> 401', () => {
      assert.strictEqual(resCancel401.statusCode, 401);
    });
  })();

  // 8. Higgsfield status normalisation (pure).
  check('status map: success/succeeded -> completed; error -> failed; nsfw stays nsfw', () => {
    assert.strictEqual(generate._test.normalizeHiggsfieldStatus('success'), 'completed');
    assert.strictEqual(generate._test.normalizeHiggsfieldStatus('FAILED'), 'failed');
    assert.strictEqual(generate._test.normalizeHiggsfieldStatus('nsfw'), 'nsfw');
    assert.strictEqual(generate._test.normalizeHiggsfieldStatus('canceled'), 'canceled');
    assert.strictEqual(generate._test.normalizeHiggsfieldStatus('processing'), 'in_progress');
  });

  // 9. generate.html is wired to the real routes (no fake success).
  check('frontend: generate.html posts /api/generate, polls status, has cancel, handles 402/503', () => {
    const html = fs.readFileSync(path.join(__dirname, '../public/generate.html'), 'utf8');
    assert.ok(html.includes('/api/generate'), 'must POST /api/generate');
    assert.ok(html.includes('/api/generations/'), 'must poll /api/generations/:id/status');
    assert.ok(html.includes('/cancel'), 'must offer cancel');
    assert.ok(html.includes('INSUFFICIENT_CREDITS'), 'must show honest 402');
    assert.ok(html.includes('DB_NOT_CONFIGURED'), 'must show honest 503 DB');
    assert.ok(html.includes('HIGGSFIELD_NOT_CONFIGURED'), 'must show honest 503 Higgsfield');
    assert.ok(!/HIGGSFIELD_API_KEY|JWT_SECRET|DATABASE_URL/.test(html), 'must not contain secrets');
  });
  check('frontend: generate.html sends reference metadata to /api/upload-reference', () => {
    const html = fs.readFileSync(path.join(__dirname, '../public/generate.html'), 'utf8');
    assert.ok(html.includes('/api/upload-reference'), 'must call /api/upload-reference');
    assert.ok(html.includes('STORAGE_NOT_CONFIGURED'), 'must surface the honest 501');
  });

  // 10. server/generate.js never trusts browser-sent credit amounts.
  check('server: generate.js reads cost from registry, never from req.body credit fields', () => {
    const src = fs.readFileSync(path.join(__dirname, '../server/generate.js'), 'utf8');
    assert.ok(src.includes('estimateCost(modelId)'), 'cost must come from estimateCost()');
    assert.ok(!/body\.credit_cost|body\.amount|req\.body\.credits/.test(src), 'must never read a credit amount from the request body');
    assert.ok(src.includes('refundGeneration'), 'submit failure must refund via credits.refundGeneration');
    assert.ok(src.includes('deductCredits'), 'must deduct via credits.deductCredits in the same transaction');
  });

  console.log(`\nResult: ${passed} passed, ${failed} failed (DB/Higgsfield live tests are BLOCKED, not run — see Phase 8 report).`);
  process.exit(failed ? 1 : 0);
})();
