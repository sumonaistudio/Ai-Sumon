// ============================================================
// Suman AI Studio — Phase 9: prompt templates (public)
// Rules: only is_active = TRUE templates are ever listed or
// returned. A disabled / missing template is 404 either way
// (no leak about disabled content). No DB -> honest 503.
// Admin CRUD for templates stays in admin.js (content routes).
// ============================================================
const db = require('./db');

function dbNotConfigured(res) {
  return res.status(503).json({
    error: 'DB_NOT_CONFIGURED',
    message: 'ডেটাবেস এখনো সংযুক্ত হয়নি (DATABASE_URL নেই)। টেমপ্লেট দেখা যাচ্ছে না — মালিককে Supabase সংযোগ করতে হবে (README ধাপ ২)।',
  });
}

function publicTemplate(row) {
  return {
    id: row.id,
    title_bn: row.title_bn,
    title_en: row.title_en,
    type: row.type,
    prompt_template: row.prompt_template,
    model_id: row.model_id,
    thumbnail_url: row.thumbnail_url,
    created_at: row.created_at,
  };
}

// ---------- GET /api/templates (public, only enabled) ----------
async function listTemplates(req, res) {
  if (!db.getPool()) return dbNotConfigured(res);
  const type = String(req.query.type || '').trim();
  try {
    const where = ['is_active = TRUE'];
    const params = [];
    if (['text-to-image', 'text-to-video', 'image-to-video'].includes(type)) {
      params.push(type);
      where.push(`type = $${params.length}`);
    }
    const r = await db.query(
      `SELECT * FROM templates WHERE ${where.join(' AND ')} ORDER BY created_at ASC`,
      params
    );
    return res.json({ templates: r.rows.map(publicTemplate) });
  } catch (err) {
    console.error('[templates.list]', err);
    return res.status(500).json({ error: 'SERVER_ERROR', message: 'টেমপ্লেট তালিকা লোড করা যায়নি।' });
  }
}

// ---------- GET /api/templates/:id (public, only enabled) ----------
async function getTemplate(req, res) {
  if (!db.getPool()) return dbNotConfigured(res);
  try {
    const r = await db.query(
      'SELECT * FROM templates WHERE id = $1 AND is_active = TRUE',
      [String(req.params.id || '').trim()]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'NOT_FOUND', message: 'টেমপ্লেট পাওয়া যায়নি।' });
    return res.json({ template: publicTemplate(r.rows[0]) });
  } catch (err) {
    console.error('[templates.get]', err);
    return res.status(500).json({ error: 'SERVER_ERROR', message: 'টেমপ্লেট লোড করা যায়নি।' });
  }
}

module.exports = { listTemplates, getTemplate };
