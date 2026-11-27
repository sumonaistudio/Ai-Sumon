// ============================================================
// Suman AI Studio — Supabase Storage (reference uploads)
// Plain REST calls, no extra dependency (Node 20 global fetch).
// Mirrors the Google OAuth pattern (server/google-oauth.js):
// until the owner configures it, the upload endpoint honestly
// answers 501 STORAGE_NOT_CONFIGURED — never a fake success.
//
// What it needs from the owner (README ধাপ ২খ):
//   * Supabase Dashboard (same AiSumon project as the database)
//     -> Storage -> New bucket, name `references`, Private.
//   * Supabase Dashboard -> Settings -> API -> service_role key
//     (the SECRET key — never put it in chat, GitHub, or the
//     browser; only in Render Environment as
//     SUPABASE_SERVICE_ROLE_KEY).
//   * Render Environment: SUPABASE_URL (project URL, e.g.
//     https://lskmblldgeqdzrvdazbv.supabase.co) and
//     SUPABASE_SERVICE_ROLE_KEY, then Save / redeploy.
//   * Optional: STORAGE_BUCKET to use a different bucket name.
//
// How an upload works (file never passes through Render):
//   1. Browser sends only metadata to POST /api/upload-reference.
//   2. Server mints a signed upload URL (valid 2 hours, Supabase
//      decides the lifetime) for one private path:
//      <user-id>/<timestamp>-<random>-<safe-filename>
//   3. Browser PUTs the file straight to that signed URL.
//   4. Browser calls POST /api/upload-reference/confirm; the
//      server mints a signed DOWNLOAD URL (valid 7 days) for that
//      same private path, which becomes the generation input_url.
//      The path must start with the caller's own user id, so one
//      user can never confirm (or read) another user's file.
// Rules enforced here:
//   * The service_role key is NEVER sent to the browser — only
//     the short-lived signed URLs are.
//   * Bucket is private: no public URL is ever produced.
//   * Filenames are sanitised (no ../, no spaces/control chars).
//   * Signed download URLs last 7 days, matching Higgsfield's
//     7-day output retention — a stale reference link cannot be
//     reused forever.
// ============================================================
const crypto = require('crypto');

const DEFAULT_BUCKET = 'references';
const SIGNED_UPLOAD_TTL_HINT_SECONDS = 2 * 60 * 60; // Supabase: 2h
const SIGNED_DOWNLOAD_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

function isConfigured(env) {
  const e = env || process.env;
  return Boolean(String(e.SUPABASE_URL || '').trim())
    && Boolean(String(e.SUPABASE_SERVICE_ROLE_KEY || '').trim());
}

function storageBucket(env) {
  const e = env || process.env;
  return String(e.STORAGE_BUCKET || DEFAULT_BUCKET).trim() || DEFAULT_BUCKET;
}

function storageBase(env) {
  const e = env || process.env;
  return String(e.SUPABASE_URL || '').trim().replace(/\/$/, '') + '/storage/v1';
}

// Keep only safe characters; collapse the rest to '-'. Never lets a
// filename escape its folder (no '/' or '..' survives).
function safeFilename(filename) {
  const base = String(filename || '').split(/[\\/]/).pop() || 'file';
  const cleaned = base.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^\.+/, '').slice(0, 100);
  return cleaned || 'file';
}

function buildObjectPath(userId, filename, nowMs, randomHex) {
  const ts = Number.isFinite(nowMs) ? nowMs : Date.now();
  const rand = randomHex || crypto.randomBytes(6).toString('hex');
  return `${userId}/${ts}-${rand}-${safeFilename(filename)}`;
}

function encodeObjectPath(objectPath) {
  return String(objectPath).split('/').map((seg) => encodeURIComponent(seg)).join('/');
}

// Parse a Supabase signed-URL response: { url } or { signedURL } —
// both are RELATIVE paths, so prepend the storage base URL.
function fullSignedUrl(base, data) {
  const rel = (data && (data.url || data.signedURL)) || '';
  if (!rel) return null;
  if (/^https?:\/\//i.test(rel)) return rel;
  return base + (rel.startsWith('/') ? rel : '/' + rel);
}

function storageHeaders(env) {
  const key = String((env || process.env).SUPABASE_SERVICE_ROLE_KEY || '').trim();
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
  };
}

function _truncateError(err, n) {
  const s = err && err.message ? String(err.message) : String(err || '');
  return s.length > n ? s.slice(0, n) + '…' : s;
}

// Mint a signed upload URL for one private object path.
// fetchImpl is injectable so isolated tests can stub Supabase.
async function createSignedUploadUrl(objectPath, options) {
  const opts = options || {};
  const env = opts.env || process.env;
  const fetchImpl = opts.fetchImpl || fetch;
  const bucket = storageBucket(env);
  const base = storageBase(env);
  const url = `${base}/object/upload/sign/${bucket}/${encodeObjectPath(objectPath)}`;
  let r;
  try {
    r = await fetchImpl(url, { method: 'POST', headers: storageHeaders(env), body: '{}' });
  } catch (err) {
    const e = new Error(`Storage-এ পৌঁছানো যায়নি: ${_truncateError(err, 150)}`);
    e.code = 'STORAGE_ERROR'; e.status = 502; throw e;
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(`Storage সই করা লিংক দিতে পারেনি (${r.status}): ${_truncateError(data.message || data.error || '', 150)}`);
    e.code = 'STORAGE_ERROR'; e.status = 502; throw e;
  }
  const uploadUrl = fullSignedUrl(base, data);
  if (!uploadUrl) {
    const e = new Error('Storage সই করা লিংক দেয়নি — বাকেট `references` আছে কি না দেখুন।');
    e.code = 'STORAGE_ERROR'; e.status = 502; throw e;
  }
  return { upload_url: uploadUrl, path: objectPath, bucket, expires_in: SIGNED_UPLOAD_TTL_HINT_SECONDS };
}

// Mint a signed download URL for an already-uploaded private path.
async function createSignedDownloadUrl(objectPath, options) {
  const opts = options || {};
  const env = opts.env || process.env;
  const fetchImpl = opts.fetchImpl || fetch;
  const bucket = storageBucket(env);
  const base = storageBase(env);
  const url = `${base}/object/sign/${bucket}/${encodeObjectPath(objectPath)}`;
  let r;
  try {
    r = await fetchImpl(url, {
      method: 'POST',
      headers: storageHeaders(env),
      body: JSON.stringify({ expiresIn: SIGNED_DOWNLOAD_TTL_SECONDS }),
    });
  } catch (err) {
    const e = new Error(`Storage-এ পৌঁছানো যায়নি: ${_truncateError(err, 150)}`);
    e.code = 'STORAGE_ERROR'; e.status = 502; throw e;
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(`Storage ডাউনলোড লিংক দিতে পারেনি (${r.status}): ${_truncateError(data.message || data.error || '', 150)}`);
    e.code = 'STORAGE_ERROR'; e.status = 502; throw e;
  }
  const signedUrl = fullSignedUrl(base, data);
  if (!signedUrl) {
    const e = new Error('Storage ডাউনলোড লিংক দেয়নি — ফাইলটি আপলোড হয়েছে কি না দেখুন।');
    e.code = 'STORAGE_ERROR'; e.status = 502; throw e;
  }
  return { url: signedUrl, path: objectPath, bucket, expires_in: SIGNED_DOWNLOAD_TTL_SECONDS };
}

module.exports = {
  isConfigured,
  storageBucket,
  storageBase,
  safeFilename,
  buildObjectPath,
  createSignedUploadUrl,
  createSignedDownloadUrl,
  SIGNED_UPLOAD_TTL_HINT_SECONDS,
  SIGNED_DOWNLOAD_TTL_SECONDS,
  _test: { isConfigured, storageBucket, safeFilename, buildObjectPath, encodeObjectPath, fullSignedUrl },
};
