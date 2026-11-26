// ============================================================
// Suman AI Studio — Phase 5: My Creations (user dashboard backend)
// Rules:
//  * A user can ONLY see / download / delete their OWN generations.
//    Every query filters user_id = req.user.id — no exceptions.
//  * Private by default: nothing here publishes anything. Publishing
//    to the gallery is a separate, explicit Phase 9 action.
//  * Soft-delete: DELETE sets deleted_at (the row stays for audit /
//    ledger reference). Deleted rows never appear in lists.
//  * Expiry: expires_at = created_at + retention_days (settings,
//    default 30). If expires_at is NULL (older rows), it is computed
//    from created_at + retention_days. `expiring_soon` = expires
//    within 3 days. Expired files: download returns 410 GONE.
//  * Download is a redirect to the stored result_url AFTER the
//    ownership + expiry checks — never a direct public link.
// ============================================================
const db = require('./db');
const settings = require('./settings');

const EXPIRING_SOON_DAYS = 3;
const VALID_STATUSES = ['queued', 'in_progress', 'completed', 'failed', 'nsfw', 'canceled', 'pending', 'refunded'];
const VALID_TYPES = ['text-to-image', 'text-to-video', 'image-to-video', 'image-edit', 'video-edit'];

// ---------- pure helpers (isolated-testable) ----------
function daysUntilExpiry(expiresAt, now = new Date()) {
  if (!expiresAt) return null;
  const ms = new Date(expiresAt).getTime() - new Date(now).getTime();
  return Math.ceil(ms / (24 * 60 * 60 * 1000));
}

function expiryInfo(row, retentionDays, now = new Date()) {
  let expiresAt = row.expires_at;
  if (!expiresAt && row.created_at) {
    expiresAt = new Date(new Date(row.created_at).getTime() + retentionDays * 24 * 60 * 60 * 1000);
  }
  const daysLeft = expiresAt ? daysUntilExpiry(expiresAt, now) : null;
  return {
    expires_at: expiresAt ? new Date(expiresAt).toISOString() : null,
    days_left: daysLeft,
    expired: daysLeft !== null && daysLeft < 0,
    expiring_soon: daysLeft !== null && daysLeft >= 0 && daysLeft <= EXPIRING_SOON_DAYS,
  };
}

function publicCreation(row, retentionDays, now = new Date()) {
  return {
    id: row.id,
    type: row.type,
    model_id: row.model_id,
    prompt: row.prompt,
    status: row.status,
    credit_cost: row.credit_cost,
    created_at: row.created_at,
    completed_at: row.completed_at,
    has_result: Boolean(row.result_url),
    error_message: row.status === 'failed' ? (row.error_message || null) : null,
    ...expiryInfo(row, retentionDays, now),
  };
}

// ---------- handlers ----------
function dbNotConfigured(res) {
  return res.status(503).json({
    error: 'DB_NOT_CONFIGURED',
    message: 'ডেটাবেস এখনো সংযুক্ত হয়নি (DATABASE_URL নেই)। My Creations দেখা যাচ্ছে না — মালিককে Supabase সংযোগ করতে হবে (README ধাপ ২)।',
  });
}

async function listCreations(req, res) {
  if (!db.getPool()) return dbNotConfigured(res);
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 50);
  const offset = (page - 1) * limit;
  const status = String(req.query.status || '').trim();
  const modelId = String(req.query.model_id || '').trim();
  const type = String(req.query.type || '').trim();

  const where = ['user_id = $1', 'deleted_at IS NULL'];
  const params = [req.user.id];
  if (status) {
    if (!VALID_STATUSES.includes(status)) return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'অবস্থা (status) সঠিক নয়।' });
    params.push(status); where.push(`status = $${params.length}`);
  }
  if (type) {
    if (!VALID_TYPES.includes(type)) return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'ধরন (type) সঠিক নয়।' });
    params.push(type); where.push(`type = $${params.length}`);
  }
  if (modelId) { params.push(modelId); where.push(`model_id = $${params.length}`); }

  try {
    const retentionDays = await settings.getRetentionDays(null);
    const rows = await db.query(
      `SELECT id, type, model_id, prompt, status, credit_cost, result_url, error_message, expires_at, created_at, completed_at
       FROM generations WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );
    const count = await db.query(
      `SELECT COUNT(*)::int AS n FROM generations WHERE ${where.join(' AND ')}`, params
    );
    const total = count.rows[0].n;
    return res.json({
      creations: rows.rows.map((r) => publicCreation(r, retentionDays)),
      page, limit, total,
      total_pages: Math.max(Math.ceil(total / limit), 1),
      retention_days: retentionDays,
      expiring_soon_days: EXPIRING_SOON_DAYS,
    });
  } catch (err) {
    console.error('[creations.list]', err);
    return res.status(500).json({ error: 'SERVER_ERROR', message: 'তালিকা লোড করা যায়নি — পরে আবার চেষ্টা করুন।' });
  }
}

async function _loadOwn(req, res) {
  // Returns the generation row or sends the error response (null).
  const id = String(req.params.id || '').trim();
  const r = await db.query(
    `SELECT * FROM generations WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
    [id, req.user.id]
  );
  if (!r.rows.length) {
    res.status(404).json({ error: 'NOT_FOUND', message: 'এই তৈরি জিনিসটি পাওয়া যায়নি (হয়তো মুছে ফেলা হয়েছে)।' });
    return null;
  }
  return r.rows[0];
}

async function getCreation(req, res) {
  if (!db.getPool()) return dbNotConfigured(res);
  try {
    const row = await _loadOwn(req, res);
    if (!row) return;
    const retentionDays = await settings.getRetentionDays(null);
    return res.json({ creation: publicCreation(row, retentionDays) });
  } catch (err) {
    console.error('[creations.get]', err);
    return res.status(500).json({ error: 'SERVER_ERROR', message: 'লোড করা যায়নি — পরে আবার চেষ্টা করুন।' });
  }
}

async function downloadCreation(req, res) {
  if (!db.getPool()) return dbNotConfigured(res);
  try {
    const row = await _loadOwn(req, res);
    if (!row) return;
    const retentionDays = await settings.getRetentionDays(null);
    const info = expiryInfo(row, retentionDays);
    if (info.expired) {
      return res.status(410).json({
        error: 'EXPIRED',
        message: 'এই ফাইলের মেয়াদ শেষ হয়ে গেছে (৩০ দিনের retention)। মেয়াদ শেষের আগে ডাউনলোড করতে হয় — এখন আর পাওয়া যাবে না।',
        expires_at: info.expires_at,
      });
    }
    if (!row.result_url) {
      return res.status(409).json({ error: 'NOT_READY', message: 'এই জেনারেশনটি এখনো সম্পূর্ণ হয়নি — ডাউনলোড করার মতো ফাইল নেই।' });
    }
    // Ownership + expiry checked above; only then redirect to the stored file.
    return res.redirect(302, row.result_url);
  } catch (err) {
    console.error('[creations.download]', err);
    return res.status(500).json({ error: 'SERVER_ERROR', message: 'ডাউনলোড শুরু করা যায়নি — পরে আবার চেষ্টা করুন।' });
  }
}

async function deleteCreation(req, res) {
  if (!db.getPool()) return dbNotConfigured(res);
  try {
    const row = await _loadOwn(req, res);
    if (!row) return;
    await db.query('UPDATE generations SET deleted_at = now() WHERE id = $1', [row.id]);
    return res.json({ message: 'মুছে ফেলা হয়েছে।', id: row.id });
  } catch (err) {
    console.error('[creations.delete]', err);
    return res.status(500).json({ error: 'SERVER_ERROR', message: 'মোছা যায়নি — পরে আবার চেষ্টা করুন।' });
  }
}

// My active subscription (for the dashboard header). Null when none.
async function getMySubscription(req, res) {
  if (!db.getPool()) return dbNotConfigured(res);
  try {
    const r = await db.query(
      `SELECT s.id, s.status, s.starts_at, s.ends_at, p.kind, p.name_bn, p.name_en, p.credits
       FROM subscriptions s LEFT JOIN packages p ON p.id = s.package_id
       WHERE s.user_id = $1 AND s.status = 'active' AND s.ends_at > now()
       ORDER BY s.ends_at DESC LIMIT 1`,
      [req.user.id]
    );
    return res.json({ subscription: r.rows[0] || null });
  } catch (err) {
    console.error('[creations.subscription]', err);
    return res.status(500).json({ error: 'SERVER_ERROR', message: 'সাবস্ক্রিপশন দেখা যায়নি — পরে আবার চেষ্টা করুন।' });
  }
}

module.exports = {
  listCreations, getCreation, downloadCreation, deleteCreation, getMySubscription,
  _test: { daysUntilExpiry, expiryInfo, publicCreation, EXPIRING_SOON_DAYS },
};
