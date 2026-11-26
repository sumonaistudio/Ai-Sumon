// ============================================================
// Higgsfield API integration — server-side only.
// Docs (verified 2026-11-26): https://docs.higgsfield.ai/docs/index
//   Base URL: https://api.higgsfield.ai
//   Auth:     Authorization: Key KEY_ID:KEY_SECRET  (server-side only!)
//   Flow:     POST <model endpoint> -> { request_id, status_url, cancel_url }
//             GET <status_url> (or /requests/{id}/status) -> poll until terminal
//             Terminal states: completed | failed | nsfw | canceled
//             Outputs are kept at least 7 days — download to our own storage.
//   Estimate: POST /estimate/<model-path> with the same body (reported by
//             multiple secondary sources; verify live with a real key).
//   Upload:   POST /files/generate-upload-url -> presigned PUT (secondary
//             source; verify live before relying on it).
// No API key? Every call returns a clear 503 NOT_CONFIGURED error —
// the app never pretends the API is connected.
// ============================================================

const BASE_URL = (process.env.HIGGSFIELD_API_BASE || 'https://api.higgsfield.ai').replace(/\/$/, '');

function getCredentials() {
  // Preferred: one env value "KEY_ID:KEY_SECRET" (as the docs show).
  const combined = (process.env.HIGGSFIELD_API_KEY || '').trim();
  if (combined && combined.includes(':')) {
    const i = combined.indexOf(':');
    return { keyId: combined.slice(0, i), secret: combined.slice(i + 1) };
  }
  const keyId = (process.env.HIGGSFIELD_KEY_ID || '').trim();
  const secret = (process.env.HIGGSFIELD_KEY_SECRET || '').trim();
  if (keyId && secret) return { keyId, secret };
  return null;
}

function isConfigured() {
  return getCredentials() !== null;
}

function authHeader() {
  const c = getCredentials();
  return c ? `Key ${c.keyId}:${c.secret}` : null;
}

function notConfiguredError() {
  const err = new Error(
    'Higgsfield API is not configured. Set HIGGSFIELD_API_KEY (KEY_ID:KEY_SECRET) in the server environment. Get a key at https://open.higgsfield.ai/'
  );
  err.code = 'HIGGSFIELD_NOT_CONFIGURED';
  err.status = 503;
  return err;
}

async function hfFetch(url, { method = 'GET', body = null, idempotencyKey = null } = {}) {
  const auth = authHeader();
  if (!auth) throw notConfiguredError();
  const headers = { Authorization: auth, 'Content-Type': 'application/json' };
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : null,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!res.ok) {
    const err = new Error((data && (data.message || data.error)) || `Higgsfield API error: HTTP ${res.status}`);
    err.status = res.status;
    err.code = 'HIGGSFIELD_API_ERROR';
    err.details = data;
    throw err;
  }
  return data;
}

// Load the model registry (admin-editable, no rebuild needed).
function loadModels() {
  try {
    // eslint-disable-next-line global-require
    const reg = require('../config/models.json');
    return reg.models || [];
  } catch {
    return [];
  }
}

function findModel(modelId) {
  return loadModels().find((m) => m.id === modelId) || null;
}

// Submit a generation. Returns { request_id, status, status_url, cancel_url }.
// Pass an idempotencyKey (uuid) so a retry never bills twice.
async function submitJob(modelId, payload, { idempotencyKey = null } = {}) {
  if (!isConfigured()) throw notConfiguredError();
  const model = findModel(modelId);
  if (!model) {
    const err = new Error(`Unknown model: ${modelId}. Check config/models.json — only verified models are listed.`);
    err.code = 'UNKNOWN_MODEL'; err.status = 400; throw err;
  }
  if (!model.enabled) {
    const err = new Error(`Model is disabled by admin: ${modelId}`);
    err.code = 'MODEL_DISABLED'; err.status = 403; throw err;
  }
  if (!model.verified) {
    const err = new Error(`Model is UNVERIFIED, cannot submit: ${modelId}`);
    err.code = 'MODEL_UNVERIFIED'; err.status = 400; throw err;
  }
  return hfFetch(model.endpoint, { method: 'POST', body: payload, idempotencyKey });
}

// Poll status. Accepts a full status_url or a bare request_id.
async function getStatus(requestIdOrUrl) {
  if (!isConfigured()) throw notConfiguredError();
  const url = requestIdOrUrl.startsWith('http')
    ? requestIdOrUrl
    : `${BASE_URL}/requests/${encodeURIComponent(requestIdOrUrl)}/status`;
  return hfFetch(url, { method: 'GET' });
}

// Cancel a job (works only while queued, per docs).
async function cancelJob(requestIdOrUrl) {
  if (!isConfigured()) throw notConfiguredError();
  const url = requestIdOrUrl.startsWith('http')
    ? requestIdOrUrl.replace(/\/status$/, '/cancel')
    : `${BASE_URL}/requests/${encodeURIComponent(requestIdOrUrl)}/cancel`;
  return hfFetch(url, { method: 'POST' });
}

// Price a job before submitting (verify live with a real key).
async function estimate(modelId, payload) {
  if (!isConfigured()) throw notConfiguredError();
  const model = findModel(modelId);
  if (!model) {
    const err = new Error(`Unknown model: ${modelId}`);
    err.code = 'UNKNOWN_MODEL'; err.status = 400; throw err;
  }
  return hfFetch(`${BASE_URL}/estimate/${modelId}`, { method: 'POST', body: payload });
}

module.exports = {
  BASE_URL,
  isConfigured,
  loadModels,
  findModel,
  submitJob,
  getStatus,
  cancelJob,
  estimate,
};
