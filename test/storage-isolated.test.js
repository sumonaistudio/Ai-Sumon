// ============================================================
// Suman AI Studio — Storage isolated tests (no DB, no Supabase)
// Run: npm test
// Covers the honest behaviour that needs no live Supabase:
//   * unconfigured -> uploadReference answers 501
//     STORAGE_NOT_CONFIGURED (never a fake success)
//   * pure helpers: filename sanitising, object-path building,
//     signed-URL parsing, isConfigured
//   * configured + stubbed Supabase fetch -> signed upload URL
//     minted, and confirm returns a signed download URL
//   * confirm rejects a path that is not the caller's own
// Live end-to-end (real bucket + real service_role key + real
// file PUT) needs the owner's Supabase setup (README ধাপ ২খ)
// and is a manual TESTING.md step, not faked here.
// ============================================================
const assert = require('node:assert');

const storage = require('../server/storage');
const generate = require('../server/generate');

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

function mockRes() {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}
const USER = { id: 'user-123' };
const META = { filename: 'photo.jpg', contentType: 'image/jpeg', sizeBytes: 12345 };

(async () => {
  console.log('Suman AI Studio — Storage isolated tests (no DB, no Supabase)');

  check('isConfigured: খালি env-এ false', () => {
    assert.strictEqual(storage._test.isConfigured({}), false);
    assert.strictEqual(storage._test.isConfigured({ SUPABASE_URL: 'https://x.supabase.co' }), false);
    assert.strictEqual(storage._test.isConfigured({ SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'k' }), true);
  });

  check('safeFilename: ../ আর স্পেস সরিয়ে দেয়', () => {
    assert.strictEqual(storage._test.safeFilename('../../etc/passwd'), 'passwd');
    assert.strictEqual(storage._test.safeFilename('my photo (1).jpg'), 'my-photo-1-.jpg');
    assert.strictEqual(storage._test.safeFilename(''), 'file');
  });

  check('buildObjectPath: নিজের ফোল্ডার + সময় + নিরাপদ নাম', () => {
    const p = storage._test.buildObjectPath('user-123', 'photo.jpg', 1700000000000, 'abcdef123456');
    assert.strictEqual(p, 'user-123/1700000000000-abcdef123456-photo.jpg');
  });

  check('fullSignedUrl: আপেক্ষিক পথে base বসে, পূর্ণ URL অপরিবর্তিত', () => {
    const base = 'https://ref.supabase.co/storage/v1';
    assert.strictEqual(
      storage._test.fullSignedUrl(base, { url: '/object/upload/sign/references/u/f.jpg?token=t' }),
      base + '/object/upload/sign/references/u/f.jpg?token=t');
    assert.strictEqual(
      storage._test.fullSignedUrl(base, { signedURL: '/object/sign/references/u/f.jpg?token=t' }),
      base + '/object/sign/references/u/f.jpg?token=t');
    assert.strictEqual(storage._test.fullSignedUrl(base, {}), null);
  });

  // Unconfigured: honest 501, file NOT uploaded.
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  await checkAsync('unconfigured: uploadReference 501 STORAGE_NOT_CONFIGURED দেয়', async () => {
    const res = mockRes();
    await generate.uploadReference({ user: USER, body: META }, res);
    assert.strictEqual(res.statusCode, 501);
    assert.strictEqual(res.body.error, 'STORAGE_NOT_CONFIGURED');
  });

  // Configured with a stubbed Supabase: mint + confirm.
  process.env.SUPABASE_URL = 'https://lskmblldgeqdzrvdazbv.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
  const calls = [];
  const stubFetch = async (url, opts) => {
    calls.push({ url, method: opts.method, body: opts.body });
    assert.ok(opts.headers.apikey === 'test-service-role-key', 'apikey header must carry the service_role key');
    assert.ok(String(opts.headers.Authorization).startsWith('Bearer '), 'Authorization Bearer required');
    if (url.includes('/object/upload/sign/')) {
      return { ok: true, status: 200, json: async () => ({ url: '/object/upload/sign/references/user-123/1-a-photo.jpg?token=up-token' }) };
    }
    return { ok: true, status: 200, json: async () => ({ signedURL: '/object/sign/references/user-123/1-a-photo.jpg?token=dl-token' }) };
  };
  const realFetch = global.fetch;
  global.fetch = stubFetch;
  try {
    let objectPath = null;
    await checkAsync('configured: uploadReference সই করা আপলোড URL দেয়', async () => {
      const res = mockRes();
      await generate.uploadReference({ user: USER, body: META }, res);
      assert.strictEqual(res.statusCode, 200);
      assert.ok(res.body.upload_url.includes('/storage/v1/object/upload/sign/references/'), res.body.upload_url);
      assert.ok(res.body.upload_url.includes('token=up-token'), 'signed URL must carry the token');
      assert.ok(res.body.path.startsWith('user-123/'), res.body.path);
      assert.ok(!res.body.upload_url.includes('test-service-role-key'), 'service_role key must NEVER leak to the browser');
      objectPath = res.body.path;
    });

    await checkAsync('confirm: নিজের ফাইলে সই করা ডাউনলোড URL দেয়', async () => {
      const res = mockRes();
      await generate.confirmUploadReference({ user: USER, body: { ...META, path: objectPath } }, res);
      assert.strictEqual(res.statusCode, 200);
      assert.ok(res.body.url.includes('/storage/v1/object/sign/references/'), res.body.url);
      assert.ok(res.body.url.includes('token=dl-token'), 'download URL must carry the token');
      assert.strictEqual(res.body.expires_in, 7 * 24 * 60 * 60);
    });

    await checkAsync('confirm: অন্যের ফাইল 403 দেয়', async () => {
      const res = mockRes();
      await generate.confirmUploadReference({ user: USER, body: { ...META, path: 'other-user/1-x-photo.jpg' } }, res);
      assert.strictEqual(res.statusCode, 403);
      assert.strictEqual(res.body.error, 'FORBIDDEN');
    });

    check('stubbed Supabase: আপলোড-সই আর ডাউনলোড-সই — দুটো আলাদা এন্ডপয়েন্ট', () => {
      assert.strictEqual(calls.length, 2);
      assert.ok(calls[0].url.includes('/object/upload/sign/'));
      assert.ok(calls[1].url.includes('/object/sign/'));
      assert.ok(JSON.parse(calls[1].body).expiresIn === 7 * 24 * 60 * 60);
    });
  } finally {
    global.fetch = realFetch;
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  }

  check('frontend: generate.html দুই ধাপের আপলোড করে', () => {
    const fs = require('node:fs');
    const html = fs.readFileSync(require('node:path').join(__dirname, '..', 'public', 'generate.html'), 'utf8');
    assert.ok(html.includes('/api/upload-reference/confirm'), 'must call the confirm endpoint');
    assert.ok(html.includes("method:'PUT'"), 'must PUT the file to the signed URL');
    assert.ok(html.includes("document.getElementById('refUrl').value = cd.url"), 'must fill the reference URL from the signed download link');
  });

  console.log(`\nStorage isolated tests: ${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
})();
