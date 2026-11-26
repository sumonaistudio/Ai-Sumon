// ============================================================
// Suman AI Studio — Phase 7: Admin Dashboard (backend)
// Role rules (enforced in code, not just in the UI):
//  * super_admin — everything, including role assignment + ban.
//  * admin — users (suspend/restore, not ban), credits, packages,
//    payments, models, content, analytics.
//  * moderator — gallery moderation ONLY (reported items, hide/
//    restore, resolve reports). No users, payments, packages.
//  * Every admin action writes an audit_logs row. Audit failure
//    never breaks the request (auth.audit swallows its own errors).
//  * Analytics: recorded figures (approved payments, ledger sums,
//    api_usage sums) are labelled RECORDED. Profit is an ESTIMATE
//    (USD->BDT at a stated approximate rate) and is labelled so.
// ============================================================
const fs = require('fs');
const path = require('path');
const db = require('./db');
const auth = require('./auth');
const credits = require('./credits');
const payments = require('./payments');
const higgsfield = require('./higgsfield');

const MODELS_PATH = path.join(__dirname, '..', 'config', 'models.json');
const USD_TO_BDT_ESTIMATE = 120; // আনুমানিক — Phase 2 সিডের মতোই; শুধু অনুমানের জন্য, হিসাবের সোর্স নয়

function dbNotConfigured(res) {
  return res.status(503).json({
    error: 'DB_NOT_CONFIGURED',
    message: 'ডেটাবেস এখনো সংযুক্ত হয়নি (DATABASE_URL নেই)। অ্যাডমিন কাজ করা যাচ্ছে না — মালিককে Supabase সংযোগ করতে হবে (README ধাপ ২)।',
  });
}

function isSuperAdmin(req) { return req.user && req.user.role === 'super_admin'; }
function parsePage(req) {
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 50);
  return { page, limit, offset: (page - 1) * limit };
}

// ---------- users ----------
async function listUsers(req, res) {
  if (!db.getPool()) return dbNotConfigured(res);
  const { page, limit, offset } = parsePage(req);
  const q = String(req.query.q || '').trim();
  const role = String(req.query.role || '').trim();
  const status = String(req.query.status || '').trim();
  const where = [];
  const params = [];
  if (q) { params.push(`%${q}%`); where.push(`(email ILIKE $${params.length} OR full_name ILIKE $${params.length})`); }
  if (['user', 'moderator', 'admin', 'super_admin'].includes(role)) { params.push(role); where.push(`role = $${params.length}`); }
  if (['active', 'suspended', 'banned'].includes(status)) { params.push(status); where.push(`status = $${params.length}`); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  try {
    const rows = await db.query(
      `SELECT id, email, full_name, role, status, credit_balance, is_paid, referral_code, created_at, last_login_at
       FROM users ${clause} ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );
    const total = (await db.query(`SELECT COUNT(*)::int AS n FROM users ${clause}`, params)).rows[0].n;
    return res.json({ users: rows.rows, page, limit, total, total_pages: Math.max(Math.ceil(total / limit), 1) });
  } catch (err) {
    console.error('[admin.users]', err);
    return res.status(500).json({ error: 'SERVER_ERROR', message: 'ইউজার তালিকা লোড করা যায়নি।' });
  }
}

async function getUser(req, res) {
  if (!db.getPool()) return dbNotConfigured(res);
  try {
    const r = await db.query(
      `SELECT id, email, full_name, role, status, credit_balance, is_paid, referral_code, referred_by, language, theme, email_verified, created_at, last_login_at
       FROM users WHERE id = $1`, [String(req.params.id || '').trim()]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'NOT_FOUND', message: 'ইউজার পাওয়া যায়নি।' });
    const ledger = await credits.getLedger(null, r.rows[0].id, 10, 0);
    return res.json({ user: r.rows[0], recent_ledger: ledger.entries });
  } catch (err) {
    console.error('[admin.user]', err);
    return res.status(500).json({ error: 'SERVER_ERROR', message: 'লোড করা যায়নি।' });
  }
}

// suspend (admin+), ban (super_admin only), restore (admin+).
async function setUserStatus(req, res) {
  if (!db.getPool()) return dbNotConfigured(res);
  const targetId = String(req.params.id || '').trim();
  const status = String((req.body || {}).status || '').trim();
  if (!['active', 'suspended', 'banned'].includes(status)) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'অবস্থা active / suspended / banned হতে হবে।' });
  }
  if (status === 'banned' && !isSuperAdmin(req)) {
    return res.status(403).json({ error: 'FORBIDDEN', message: 'ব্যান করতে শুধু Super Admin পারেন।' });
  }
  if (targetId === req.user.id) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'নিজের অ্যাকাউন্টের অবস্থা নিজে বদলানো যাবে না।' });
  }
  try {
    const r = await db.query(
      'UPDATE users SET status = $1 WHERE id = $2 RETURNING id, email, status', [status, targetId]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'NOT_FOUND', message: 'ইউজার পাওয়া যায়নি।' });
    await auth.audit(null, `admin.user_${status}`, req.user.id, 'user', targetId, { status });
    return res.json({ message: `অ্যাকাউন্টের অবস্থা এখন: ${status}`, user: r.rows[0] });
  } catch (err) {
    console.error('[admin.setStatus]', err);
    return res.status(500).json({ error: 'SERVER_ERROR', message: 'অবস্থা বদলানো যায়নি।' });
  }
}

// Role assignment — super_admin ONLY, and never demote yourself.
async function setUserRole(req, res) {
  if (!db.getPool()) return dbNotConfigured(res);
  if (!isSuperAdmin(req)) {
    return res.status(403).json({ error: 'FORBIDDEN', message: 'রোল বদলাতে শুধু Super Admin পারেন।' });
  }
  const targetId = String(req.params.id || '').trim();
  const role = String((req.body || {}).role || '').trim();
  if (!['user', 'moderator', 'admin', 'super_admin'].includes(role)) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'রোল সঠিক নয়।' });
  }
  if (targetId === req.user.id) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'নিজের রোল নিজে বদলানো যাবে না।' });
  }
  try {
    const r = await db.query(
      'UPDATE users SET role = $1 WHERE id = $2 RETURNING id, email, role', [role, targetId]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'NOT_FOUND', message: 'ইউজার পাওয়া যায়নি।' });
    await auth.audit(null, 'admin.user_role', req.user.id, 'user', targetId, { role });
    return res.json({ message: `রোল এখন: ${role}`, user: r.rows[0] });
  } catch (err) {
    console.error('[admin.setRole]', err);
    return res.status(500).json({ error: 'SERVER_ERROR', message: 'রোল বদলানো যায়নি।' });
  }
}

// ---------- credits (admin add / deduct) ----------
async function adjustCredits(req, res) {
  if (!db.getPool()) return dbNotConfigured(res);
  const targetId = String(req.params.id || '').trim();
  const amount = parseInt((req.body || {}).amount, 10);
  const reason = String((req.body || {}).reason || '').trim();
  if (!Number.isInteger(amount) || amount === 0 || Math.abs(amount) > 100000) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'ক্রেডিটের পরিমাণ শূন্য নয় এমন পূর্ণসংখ্যা হতে হবে (সর্বোচ্চ ১,০০,০০০)।' });
  }
  if (!reason) return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'কারণ (reason) লিখতে হবে — অডিটের জন্য বাধ্যতামূলক।' });
  try {
    const result = await db.withTransaction(async (client) => {
      const fn = amount > 0 ? credits.addCredits : credits.deductCredits;
      const { row, replayed } = await fn(client, {
        userId: targetId,
        amount: Math.abs(amount),
        reason: amount > 0 ? 'admin_add' : 'admin_deduct',
        referenceId: null,
        idempotencyKey: `admin-adjust:${targetId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
      });
      await auth.audit(client, amount > 0 ? 'admin.credit_add' : 'admin.credit_deduct', req.user.id, 'user', targetId, { amount, reason, admin_reason: reason });
      return { row, replayed };
    });
    return res.json({ message: `ক্রেডিট ${amount > 0 ? 'যোগ' : 'কাটা'} হয়েছে। নতুন ব্যালেন্স: ${result.row.balance_after}`, ledger: result.row });
  } catch (err) {
    if (err.code === 'INSUFFICIENT_CREDITS') {
      return res.status(400).json({ error: 'INSUFFICIENT_CREDITS', message: 'ইউজারের ব্যালেন্স এর চেয়ে কম — নেগেটিভ ব্যালেন্স করা যাবে না।' });
    }
    if (err.code === 'USER_NOT_FOUND') return res.status(404).json({ error: 'NOT_FOUND', message: 'ইউজার পাওয়া যায়নি।' });
    console.error('[admin.adjustCredits]', err);
    return res.status(500).json({ error: 'SERVER_ERROR', message: 'ক্রেডিট বদলানো যায়নি।' });
  }
}

// ---------- packages CRUD ----------
function validatePackage(body) {
  const errors = {};
  const kind = String(body.kind || '').trim();
  const nameBn = String(body.name_bn || '').trim();
  const nameEn = String(body.name_en || '').trim();
  const priceBdt = parseInt(body.price_bdt, 10);
  const priceUsd = parseFloat(body.price_usd);
  const creditsN = parseInt(body.credits, 10);
  if (!['credit_pack', 'monthly', 'yearly'].includes(kind)) errors.kind = 'ধরন credit_pack / monthly / yearly হতে হবে।';
  if (!nameBn || !nameEn) errors.name = 'বাংলা ও ইংরেজি নাম দুটোই লাগবে।';
  if (!Number.isInteger(priceBdt) || priceBdt < 0) errors.price_bdt = 'BDT দাম ০ বা তার বেশি পূর্ণসংখ্যা হতে হবে।';
  if (!Number.isFinite(priceUsd) || priceUsd < 0) errors.price_usd = 'USD দাম ০ বা তার বেশি হতে হবে।';
  if (!Number.isInteger(creditsN) || creditsN < 0) errors.credits = 'ক্রেডিট ০ বা তার বেশি পূর্ণসংখ্যা হতে হবে।';
  return { errors, kind, nameBn, nameEn, priceBdt, priceUsd, credits: creditsN, isActive: body.is_active !== false };
}

async function listPackagesAdmin(req, res) {
  if (!db.getPool()) return dbNotConfigured(res);
  try {
    const r = await db.query('SELECT * FROM packages ORDER BY sort_order ASC, price_bdt ASC');
    return res.json({ packages: r.rows });
  } catch (err) {
    console.error('[admin.packages]', err);
    return res.status(500).json({ error: 'SERVER_ERROR', message: 'প্যাকেজ তালিকা লোড করা যায়নি।' });
  }
}

async function createPackage(req, res) {
  if (!db.getPool()) return dbNotConfigured(res);
  const v = validatePackage(req.body || {});
  if (Object.keys(v.errors).length) return res.status(400).json({ error: 'VALIDATION_ERROR', errors: v.errors });
  try {
    const r = await db.query(
      `INSERT INTO packages (kind, name_bn, name_en, price_bdt, price_usd, credits, is_active, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [v.kind, v.nameBn, v.nameEn, v.priceBdt, v.priceUsd, v.credits, v.isActive, parseInt(req.body.sort_order, 10) || 0]
    );
    await auth.audit(null, 'admin.package_create', req.user.id, 'package', r.rows[0].id, { kind: v.kind, price_bdt: v.priceBdt });
    return res.status(201).json({ message: 'প্যাকেজ তৈরি হয়েছে।', package: r.rows[0] });
  } catch (err) {
    console.error('[admin.packageCreate]', err);
    return res.status(500).json({ error: 'SERVER_ERROR', message: 'প্যাকেজ তৈরি করা যায়নি।' });
  }
}

async function updatePackage(req, res) {
  if (!db.getPool()) return dbNotConfigured(res);
  const v = validatePackage(req.body || {});
  if (Object.keys(v.errors).length) return res.status(400).json({ error: 'VALIDATION_ERROR', errors: v.errors });
  try {
    const r = await db.query(
      `UPDATE packages SET kind=$1, name_bn=$2, name_en=$3, price_bdt=$4, price_usd=$5, credits=$6, is_active=$7, sort_order=$8
       WHERE id=$9 RETURNING *`,
      [v.kind, v.nameBn, v.nameEn, v.priceBdt, v.priceUsd, v.credits, v.isActive, parseInt(req.body.sort_order, 10) || 0, String(req.params.id || '').trim()]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'NOT_FOUND', message: 'প্যাকেজ পাওয়া যায়নি।' });
    await auth.audit(null, 'admin.package_update', req.user.id, 'package', r.rows[0].id, { kind: v.kind, price_bdt: v.priceBdt });
    return res.json({ message: 'প্যাকেজ আপডেট হয়েছে।', package: r.rows[0] });
  } catch (err) {
    console.error('[admin.packageUpdate]', err);
    return res.status(500).json({ error: 'SERVER_ERROR', message: 'প্যাকেজ আপডেট করা যায়নি।' });
  }
}

// ---------- payments (admin) ----------
async function listPaymentsAdmin(req, res) {
  if (!db.getPool()) return dbNotConfigured(res);
  const { page, limit, offset } = parsePage(req);
  const status = String(req.query.status || '').trim();
  const where = [];
  const params = [];
  if (['pending', 'approved', 'rejected'].includes(status)) { params.push(status); where.push(`pay.status = $${params.length}`); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  try {
    const rows = await db.query(
      `SELECT pay.*, u.email AS user_email, p.kind, p.name_bn, p.name_en, p.credits
       FROM payments pay JOIN users u ON u.id = pay.user_id LEFT JOIN packages p ON p.id = pay.package_id
       ${clause} ORDER BY pay.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );
    const total = (await db.query(`SELECT COUNT(*)::int AS n FROM payments pay ${clause}`, params)).rows[0].n;
    return res.json({ payments: rows.rows, page, limit, total, total_pages: Math.max(Math.ceil(total / limit), 1) });
  } catch (err) {
    console.error('[admin.payments]', err);
    return res.status(500).json({ error: 'SERVER_ERROR', message: 'পেমেন্ট তালিকা লোড করা যায়নি।' });
  }
}

async function reviewPayment(req, res) {
  if (!db.getPool()) return dbNotConfigured(res);
  const decision = String(req.params.decision || '').trim(); // approve | reject
  if (!['approve', 'reject'].includes(decision)) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'সিদ্ধান্ত approve বা reject হতে হবে।' });
  }
  const note = String((req.body || {}).note || (req.body || {}).review_note || '').trim().slice(0, 500) || null;
  try {
    const result = await db.withTransaction(async (client) => {
      if (decision === 'approve') return payments.approvePayment(client, String(req.params.id || '').trim(), req.user.id, note);
      return payments.rejectPayment(client, String(req.params.id || '').trim(), req.user.id, note);
    });
    return res.json({ message: decision === 'approve' ? 'পেমেন্ট অনুমোদিত — ক্রেডিট/সাবস্ক্রিপশন যোগ করা হয়েছে।' : 'পেমেন্ট প্রত্যাখ্যান করা হয়েছে।', ...result });
  } catch (err) {
    if (err.status === 404) return res.status(404).json({ error: 'NOT_FOUND', message: 'পেমেন্টটি পাওয়া যায়নি।' });
    if (err.status === 409) return res.status(409).json({ error: 'ALREADY_REVIEWED', message: 'এই পেমেন্টটি আগেই যাচাই করা হয়েছে — দুবার অনুমোদন/প্রত্যাখ্যান করা যাবে না।' });
    console.error('[admin.reviewPayment]', err);
    return res.status(500).json({ error: 'SERVER_ERROR', message: 'যাচাই করা যায়নি।' });
  }
}

// ---------- models (registry in config/models.json) ----------
function readModelsFile() {
  const raw = JSON.parse(fs.readFileSync(MODELS_PATH, 'utf8'));
  return raw;
}

async function listModelsAdmin(req, res) {
  try {
    const reg = readModelsFile();
    return res.json({ models: reg.models || [], unverified_or_not_on_api: reg.unverified_or_not_on_api || [], verified_on: reg._verified_on || null });
  } catch (err) {
    console.error('[admin.models]', err);
    return res.status(500).json({ error: 'SERVER_ERROR', message: 'মডেল রেজিস্ট্রি পড়া যায়নি।' });
  }
}

// Validate a model update — pure, testable.
function validateModelUpdate(registry, modelId, body) {
  const model = (registry.models || []).find((m) => m.id === modelId);
  if (!model) return { error: 'MODEL_NOT_FOUND' };
  const errors = {};
  let enabled = model.enabled;
  let creditCost = model.credit_cost;
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') errors.enabled = 'enabled সত্য/মিথ্যা (boolean) হতে হবে।';
    else enabled = body.enabled;
  }
  if (body.credit_cost !== undefined) {
    const n = parseInt(body.credit_cost, 10);
    if (!Number.isInteger(n) || n < 0) errors.credit_cost = 'ক্রেডিট খরচ ০ বা তার বেশি পূর্ণসংখ্যা হতে হবে।';
    else creditCost = n;
  }
  return { model, errors, enabled, creditCost };
}

async function updateModel(req, res) {
  // Model ids contain slashes (e.g. higgsfield-ai/soul/v2/standard),
  // so the route uses a wildcard and the id arrives in req.params[0].
  const raw = (req.params && req.params[0]) || req.params.id || '';
  let modelId = String(raw).trim();
  try { modelId = decodeURIComponent(modelId); } catch { /* keep raw */ }
  try {
    const reg = readModelsFile();
    const v = validateModelUpdate(reg, modelId, req.body || {});
    if (v.error === 'MODEL_NOT_FOUND') return res.status(404).json({ error: 'MODEL_NOT_FOUND', message: 'এই মডেল রেজিস্ট্রিতে নেই — বানিয়ে যোগ করা যাবে না, শুধু যাচাই করা মডেলই চালু/বন্ধ করা যায়।' });
    if (Object.keys(v.errors).length) return res.status(400).json({ error: 'VALIDATION_ERROR', errors: v.errors });
    v.model.enabled = v.enabled;
    v.model.credit_cost = v.creditCost;
    // Atomic write: temp file + rename, so a crash never leaves a half-written registry.
    const tmp = MODELS_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(reg, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, MODELS_PATH);
    await auth.audit(null, 'admin.model_update', req.user.id, 'model', null, { model_id: modelId, enabled: v.enabled, credit_cost: v.creditCost });
    return res.json({ message: 'মডেল আপডেট হয়েছে।', model: v.model });
  } catch (err) {
    console.error('[admin.modelUpdate]', err);
    return res.status(500).json({ error: 'SERVER_ERROR', message: 'মডেল আপডেট করা যায়নি।' });
  }
}

// ---------- content CRUD (templates / announcements / faqs) ----------
function contentTable(kind) {
  return { templates: 'templates', announcements: 'announcements', faqs: 'faqs' }[kind] || null;
}

async function listContent(req, res) {
  if (!db.getPool()) return dbNotConfigured(res);
  const table = contentTable(String(req.params.kind || ''));
  if (!table) return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'ধরন templates / announcements / faqs হতে হবে।' });
  try {
    const r = await db.query(`SELECT * FROM ${table} ORDER BY created_at DESC LIMIT 100`);
    return res.json({ items: r.rows });
  } catch (err) {
    console.error('[admin.content]', err);
    return res.status(500).json({ error: 'SERVER_ERROR', message: 'তালিকা লোড করা যায়নি।' });
  }
}

// Generic content create/update use a strict allow-list per table so no
// client-supplied column name can ever reach SQL.
const CONTENT_FIELDS = {
  templates: ['title_bn', 'title_en', 'type', 'prompt_template', 'model_id', 'thumbnail_url', 'is_active'],
  announcements: ['title_bn', 'title_en', 'body_bn', 'body_en', 'is_active'],
  faqs: ['question_bn', 'question_en', 'answer_bn', 'answer_en', 'sort_order', 'is_active'],
};

async function createContent(req, res) {
  if (!db.getPool()) return dbNotConfigured(res);
  const table = contentTable(String(req.params.kind || ''));
  if (!table) return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'ধরন সঠিক নয়।' });
  const fields = CONTENT_FIELDS[table].filter((f) => req.body && req.body[f] !== undefined);
  if (!fields.length) return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'কোনো তথ্য দেওয়া হয়নি।' });
  try {
    const cols = fields.join(', ');
    const placeholders = fields.map((_, i) => `$${i + 1}`).join(', ');
    const values = fields.map((f) => req.body[f]);
    const r = await db.query(`INSERT INTO ${table} (${cols}) VALUES (${placeholders}) RETURNING *`, values);
    await auth.audit(null, `admin.${table}_create`, req.user.id, table, r.rows[0].id, null);
    return res.status(201).json({ item: r.rows[0] });
  } catch (err) {
    console.error('[admin.contentCreate]', err);
    return res.status(500).json({ error: 'SERVER_ERROR', message: 'তৈরি করা যায়নি।' });
  }
}

async function deleteContent(req, res) {
  if (!db.getPool()) return dbNotConfigured(res);
  const table = contentTable(String(req.params.kind || ''));
  if (!table) return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'ধরন সঠিক নয়।' });
  try {
    const r = await db.query(`DELETE FROM ${table} WHERE id = $1 RETURNING id`, [String(req.params.id || '').trim()]);
    if (!r.rows.length) return res.status(404).json({ error: 'NOT_FOUND', message: 'পাওয়া যায়নি।' });
    await auth.audit(null, `admin.${table}_delete`, req.user.id, table, r.rows[0].id, null);
    return res.json({ message: 'মুছে ফেলা হয়েছে।' });
  } catch (err) {
    console.error('[admin.contentDelete]', err);
    return res.status(500).json({ error: 'SERVER_ERROR', message: 'মোছা যায়নি।' });
  }
}

// ---------- gallery moderation (moderator + admin + super_admin) ----------
async function listReported(req, res) {
  if (!db.getPool()) return dbNotConfigured(res);
  const { page, limit, offset } = parsePage(req);
  const onlyUnresolved = String(req.query.unresolved || '') === 'true';
  try {
    const where = onlyUnresolved ? 'WHERE rep.resolved = FALSE' : '';
    const rows = await db.query(
      `SELECT rep.id AS report_id, rep.reason, rep.resolved, rep.created_at AS reported_at,
              gi.id AS gallery_item_id, gi.is_public, gi.hidden_by_moderation, gi.likes_count, gi.reports_count,
              g.type, g.model_id, g.prompt, g.result_url,
              u.email AS owner_email, ru.email AS reporter_email
       FROM gallery_reports rep
       JOIN gallery_items gi ON gi.id = rep.gallery_item_id
       JOIN generations g ON g.id = gi.generation_id
       JOIN users u ON u.id = gi.user_id
       JOIN users ru ON ru.id = rep.reporter_id
       ${where} ORDER BY rep.created_at DESC LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    const total = (await db.query(
      `SELECT COUNT(*)::int AS n FROM gallery_reports rep ${onlyUnresolved ? 'WHERE rep.resolved = FALSE' : ''}`
    )).rows[0].n;
    return res.json({ reports: rows.rows, page, limit, total, total_pages: Math.max(Math.ceil(total / limit), 1) });
  } catch (err) {
    console.error('[admin.reported]', err);
    return res.status(500).json({ error: 'SERVER_ERROR', message: 'রিপোর্ট তালিকা লোড করা যায়নি।' });
  }
}

async function moderateGalleryItem(req, res) {
  if (!db.getPool()) return dbNotConfigured(res);
  const itemId = String(req.params.id || '').trim();
  const action = String((req.body || {}).action || '').trim(); // hide | restore
  if (!['hide', 'restore'].includes(action)) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'কাজ hide বা restore হতে হবে।' });
  }
  try {
    const hidden = action === 'hide';
    const r = await db.query(
      'UPDATE gallery_items SET hidden_by_moderation = $1 WHERE id = $2 RETURNING id, hidden_by_moderation',
      [hidden, itemId]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'NOT_FOUND', message: 'গ্যালারি আইটেম পাওয়া যায়নি।' });
    await auth.audit(null, `admin.gallery_${action}`, req.user.id, 'gallery_item', itemId, null);
    return res.json({ message: hidden ? 'আইটেমটি গ্যালারি থেকে লুকানো হয়েছে।' : 'আইটেমটি আবার দেখানো হচ্ছে।', item: r.rows[0] });
  } catch (err) {
    console.error('[admin.moderate]', err);
    return res.status(500).json({ error: 'SERVER_ERROR', message: 'মডারেশন করা যায়নি।' });
  }
}

async function resolveReport(req, res) {
  if (!db.getPool()) return dbNotConfigured(res);
  try {
    const r = await db.query(
      'UPDATE gallery_reports SET resolved = TRUE WHERE id = $1 RETURNING id, resolved',
      [String(req.params.id || '').trim()]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'NOT_FOUND', message: 'রিপোর্ট পাওয়া যায়নি।' });
    await auth.audit(null, 'admin.report_resolve', req.user.id, 'gallery_report', r.rows[0].id, null);
    return res.json({ message: 'রিপোর্ট সমাধান হয়েছে বলে চিহ্নিত করা হয়েছে।', report: r.rows[0] });
  } catch (err) {
    console.error('[admin.resolveReport]', err);
    return res.status(500).json({ error: 'SERVER_ERROR', message: 'চিহ্নিত করা যায়নি।' });
  }
}

// ---------- settings (admin: payment numbers, bonus, retention) ----------
async function getSettingsAdmin(req, res) {
  if (!db.getPool()) return dbNotConfigured(res);
  try {
    const r = await db.query('SELECT key, value FROM settings ORDER BY key ASC');
    const out = {};
    for (const row of r.rows) out[row.key] = row.value;
    return res.json({ settings: out });
  } catch (err) {
    console.error('[admin.settings]', err);
    return res.status(500).json({ error: 'SERVER_ERROR', message: 'সেটিংস লোড করা যায়নি।' });
  }
}

async function updateSetting(req, res) {
  if (!db.getPool()) return dbNotConfigured(res);
  const key = String(req.params.key || '').trim();
  const value = req.body ? req.body.value : undefined;
  if (!key || value === undefined) return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'key ও value দুটোই লাগবে।' });
  // Only known keys may be changed — no arbitrary settings injection.
  const ALLOWED = ['signup_bonus_credits', 'referral_bonus_credits', 'referral_eligible_after_generations', 'retention_days', 'bkash_number', 'nagad_number', 'payment_instructions_bn', 'payment_instructions_en', 'site_name_bn', 'site_name_en', 'watermark_free_requires_paid'];
  if (!ALLOWED.includes(key)) return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'এই সেটিং বদলানো যাবে না।' });
  try {
    await db.query(
      `INSERT INTO settings (key, value, updated_by) VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [key, JSON.stringify(value), req.user.id]
    );
    await auth.audit(null, 'admin.setting_update', req.user.id, 'setting', null, { key });
    return res.json({ message: 'সেটিং আপডেট হয়েছে।', key, value });
  } catch (err) {
    console.error('[admin.setting]', err);
    return res.status(500).json({ error: 'SERVER_ERROR', message: 'সেটিং আপডেট করা যায়নি।' });
  }
}

// ---------- analytics ----------
async function getAnalytics(req, res) {
  if (!db.getPool()) return dbNotConfigured(res);
  try {
    const [users, gens, pay, ledger, api] = await Promise.all([
      db.query(`SELECT COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE created_at >= now() - interval '30 days')::int AS new_30d,
        COUNT(*) FILTER (WHERE last_login_at >= now() - interval '30 days')::int AS active_30d,
        COUNT(*) FILTER (WHERE status = 'suspended')::int AS suspended,
        COUNT(*) FILTER (WHERE status = 'banned')::int AS banned FROM users`),
      db.query(`SELECT COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE type = 'text-to-image')::int AS images,
        COUNT(*) FILTER (WHERE type IN ('text-to-video','image-to-video'))::int AS videos,
        COUNT(*) FILTER (WHERE status = 'completed')::int AS completed,
        COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
        COUNT(*) FILTER (WHERE created_at >= CURRENT_DATE)::int AS today FROM generations WHERE deleted_at IS NULL`),
      db.query(`SELECT COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
        COUNT(*) FILTER (WHERE status = 'approved')::int AS approved,
        COALESCE(SUM(amount_bdt) FILTER (WHERE status = 'approved'), 0)::int AS revenue_bdt_recorded,
        COALESCE(SUM(amount_bdt) FILTER (WHERE status = 'approved' AND created_at >= CURRENT_DATE), 0)::int AS revenue_today_bdt_recorded FROM payments`),
      db.query(`SELECT COALESCE(SUM(amount) FILTER (WHERE amount < 0), 0)::int AS credits_spent,
        COALESCE(SUM(amount) FILTER (WHERE amount > 0), 0)::int AS credits_granted,
        COALESCE(SUM(amount) FILTER (WHERE reason = 'refund'), 0)::int AS credits_refunded FROM credit_ledger`),
      db.query(`SELECT COUNT(*)::int AS jobs, COALESCE(SUM(higgsfield_cost_usd), 0)::numeric AS cost_usd_recorded FROM api_usage`),
    ]);
    const revenueBdt = pay.rows[0].revenue_bdt_recorded;
    const aiCostUsd = parseFloat(api.rows[0].cost_usd_recorded || 0);
    const aiCostBdtEstimated = Math.round(aiCostUsd * USD_TO_BDT_ESTIMATE);
    return res.json({
      users: users.rows[0],
      generations: gens.rows[0],
      payments: pay.rows[0],
      credits: ledger.rows[0],
      higgsfield: { jobs: api.rows[0].jobs, cost_usd_recorded: aiCostUsd },
      // RECORDED vs ESTIMATED — kept separate on purpose:
      revenue: { amount_bdt_recorded: revenueBdt, note: 'শুধু approved পেমেন্টের যোগফল (রেকর্ড করা টাকা)।' },
      estimated_profit: {
        amount_bdt_estimated: revenueBdt - aiCostBdtEstimated,
        ai_cost_bdt_estimated: aiCostBdtEstimated,
        usd_to_bdt_rate_used: USD_TO_BDT_ESTIMATE,
        note: 'অনুমান মাত্র — AI খরচ USD-কে আনুমানিক ১২০৳ ধরে BDT-তে রূপান্তর করা হয়েছে। আসল লাভ ব্যাংক/বিকাশের আসল হিসাবে মেলান।',
      },
    });
  } catch (err) {
    console.error('[admin.analytics]', err);
    return res.status(500).json({ error: 'SERVER_ERROR', message: 'অ্যানালিটিক্স লোড করা যায়নি।' });
  }
}

module.exports = {
  listUsers, getUser, setUserStatus, setUserRole, adjustCredits,
  listPackagesAdmin, createPackage, updatePackage,
  listPaymentsAdmin, reviewPayment,
  listModelsAdmin, updateModel, validateModelUpdate,
  listContent, createContent, deleteContent,
  listReported, moderateGalleryItem, resolveReport,
  getSettingsAdmin, updateSetting,
  getAnalytics,
  _test: { validateModelUpdate, validatePackage, USD_TO_BDT_ESTIMATE },
};
