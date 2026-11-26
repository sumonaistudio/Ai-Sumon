// ============================================================
// Suman AI Studio — Phase 5-7: settings helpers
// settings.value is JSONB, so pg returns it already parsed:
//   '100'   -> number 100,  '""' -> '',  '"text"' -> 'text', 'true' -> true.
// Never trust a raw row value — unwrap it here, in ONE place.
// ============================================================
const db = require('./db');

function unwrap(value, fallback) {
  if (value === undefined || value === null) return fallback;
  return value;
}

function asInt(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function asString(value, fallback) {
  if (value === undefined || value === null) return fallback;
  return String(value);
}

// Read one setting. Pass a pg client (inside a transaction) or null.
async function getSetting(client, key, fallback) {
  const q = 'SELECT value FROM settings WHERE key = $1';
  const r = client ? await client.query(q, [key]) : await db.query(q, [key]);
  if (!r.rows.length) return fallback;
  return unwrap(r.rows[0].value, fallback);
}

async function getIntSetting(client, key, fallback) {
  const v = await getSetting(client, key, fallback);
  return asInt(v, fallback);
}

async function getStringSetting(client, key, fallback) {
  const v = await getSetting(client, key, fallback);
  return asString(v, fallback);
}

// Retention (days) for creations — admin-controlled, default 30.
async function getRetentionDays(client) {
  const d = await getIntSetting(client, 'retention_days', 30);
  return d > 0 ? d : 30;
}

// Payment instructions + numbers — read from settings, NEVER hardcoded.
async function getPaymentSettings(client) {
  const [bkash, nagad, insBn, insEn] = await Promise.all([
    getStringSetting(client, 'bkash_number', ''),
    getStringSetting(client, 'nagad_number', ''),
    getStringSetting(client, 'payment_instructions_bn', ''),
    getStringSetting(client, 'payment_instructions_en', ''),
  ]);
  return { bkash_number: bkash, nagad_number: nagad, instructions_bn: insBn, instructions_en: insEn };
}

module.exports = { getSetting, getIntSetting, getStringSetting, getRetentionDays, getPaymentSettings, unwrap, asInt, asString };
