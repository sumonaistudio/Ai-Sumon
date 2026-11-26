// ============================================================
// Suman AI Studio — Phase 9 isolated tests (no DB, no network)
// Covers the pure validators/helpers of gallery, support,
// notifications and referrals. Run: node test/phase9.test.js
// Live DB behaviour is BLOCKED (no DATABASE_URL) — see
// PHASE8-12-REPORT.md. These tests prove the validation logic
// only; they never claim a live flow passed.
// ============================================================
const assert = require('node:assert');
const gallery = require('../server/gallery');
const support = require('../server/support');
const notifications = require('../server/notifications');
const referrals = require('../server/referrals');

let passed = 0;
function check(name, fn) {
  try { fn(); passed += 1; console.log(`  PASS — ${name}`); }
  catch (err) { console.log(`  FAIL — ${name}: ${err.message}`); process.exitCode = 1; }
}

console.log('Phase 9 isolated tests (DB ছাড়া):');

// --- gallery validators ---
check('gallery comment: খালি কমেন্ট বাতিল', () => {
  assert.strictEqual(gallery._test.validateComment({ body: '   ' }).error !== null, true);
});
check('gallery comment: ৫০০ অক্ষরের বেশি বাতিল', () => {
  assert.strictEqual(gallery._test.validateComment({ body: 'x'.repeat(501) }).error !== null, true);
});
check('gallery comment: সাধারণ কমেন্ট পাস', () => {
  const v = gallery._test.validateComment({ body: 'খুব সুন্দর হয়েছে!' });
  assert.strictEqual(v.error, null);
  assert.strictEqual(v.text, 'খুব সুন্দর হয়েছে!');
});
check('gallery report: কারণ ছাড়া বাতিল', () => {
  assert.strictEqual(gallery._test.validateReport({}).error !== null, true);
});
check('gallery report: কারণসহ পাস', () => {
  assert.strictEqual(gallery._test.validateReport({ reason: 'spam' }).error, null);
});

// --- support validators ---
check('support ticket: শিরোনাম ছাড়া বাতিল', () => {
  assert.strictEqual(support._test.validateTicket({ message: 'সাহায্য চাই' }).error !== null, true);
});
check('support ticket: বার্তা ছাড়া বাতিল', () => {
  assert.strictEqual(support._test.validateTicket({ title: 'সমস্যা' }).error !== null, true);
});
check('support ticket: শিরোনাম+বার্তা পাস', () => {
  const v = support._test.validateTicket({ title: 'লগইন হচ্ছে না', message: 'পাসওয়ার্ড দিলেও ঢুকছে না।' });
  assert.strictEqual(v.error, null);
  assert.strictEqual(v.title, 'লগইন হচ্ছে না');
});
check('support ticket: ২০০ অক্ষরের বেশি শিরোনাম বাতিল', () => {
  assert.strictEqual(support._test.validateTicket({ title: 'x'.repeat(201), message: 'm' }).error !== null, true);
});
check('support reply: খালি উত্তর বাতিল', () => {
  assert.strictEqual(support._test.validateReply({}).error !== null, true);
});
check('support reply: সাধারণ উত্তর পাস', () => {
  assert.strictEqual(support._test.validateReply({ body: 'ঠিক করে দেওয়া হয়েছে।' }).error, null);
});
check('support: moderator অ্যাডমিন নয় (টিকিট দেখতে পাবে না)', () => {
  assert.strictEqual(support._test.isAdminUser({ role: 'moderator' }), false);
  assert.strictEqual(support._test.isAdminUser({ role: 'admin' }), true);
  assert.strictEqual(support._test.isAdminUser({ role: 'super_admin' }), true);
});

// --- notification validator ---
check('notification: ভুল ধরন বাতিল', () => {
  assert.strictEqual(notifications._test.validateNotification('generation_failed', 't', 'm').error !== null, true);
});
check('notification: সঠিক ধরন পাস', () => {
  assert.strictEqual(notifications._test.validateNotification('generation_completed', 'হয়েছে', 'তৈরি হয়েছে।').error, null);
});
check('notification: শিরোনাম ছাড়া বাতিল', () => {
  assert.strictEqual(notifications._test.validateNotification('credit_added', '', 'm').error !== null, true);
});

// --- referral helpers ---
check('referral: ইমেইল মাস্ক করা হয় (পুরো ইমেইল ফাঁস হয় না)', () => {
  const masked = referrals._test.maskEmail('sumon@example.com');
  assert.ok(!masked.includes('sumon'));
  assert.ok(masked.includes('@example.com'));
  assert.strictEqual(masked[0], 's');
});
check('referral: ছোট/ভুল ইমেইল মাস্কে *** হয়', () => {
  assert.strictEqual(referrals._test.maskEmail('a@b.com'), '***');
});
check('referral: PUBLIC_URL থাকলে লিংক সেটা ব্যবহার করে', () => {
  const base = referrals._test.referralLinkBase({ protocol: 'https', get: () => 'example.com' });
  assert.strictEqual(base, 'https://example.com');
});

console.log(`\nResult: ${passed} passed, ${process.exitCode ? 1 : 0} failed (লাইভ DB টেস্ট BLOCKED — DATABASE_URL নেই)।`);
