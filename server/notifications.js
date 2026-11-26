// ============================================================
// Suman AI Studio — Phase 9: notifications
// The notifications table (001 schema) has columns:
//   user_id, title, body, kind, is_read, created_at
// This module's helper therefore maps its arguments onto those
// columns: type -> kind, message -> body. `kind` values written
// here are the five Phase 9 types below; older code (payments.js)
// writes kind='payment' directly — that stays valid, it is just
// a different kind value, not a conflict.
// Types: generation_completed | payment_approved |
//   payment_rejected | credit_added | announcement
// (Anything else is rejected — no free-form kind injection.)
// Rules: a user only ever sees their OWN notifications
// (user_id = req.user.id on every query). No DB -> honest 503.
// No user -> 401.
// ============================================================
const db = require('./db');

const NOTIFICATION_TYPES = [
  'generation_completed',
  'payment_approved',
  'payment_rejected',
  'credit_added',
  'announcement',
];

function dbNotConfigured(res) {
  return res.status(503).json({
    error: 'DB_NOT_CONFIGURED',
    message: 'ডেটাবেস এখনো সংযুক্ত হয়নি (DATABASE_URL নেই)। নোটিফিকেশন দেখা যাচ্ছে না — মালিককে Supabase সংযোগ করতে হবে (README ধাপ ২)।',
  });
}

function validateNotification(type, title, message) {
  if (!NOTIFICATION_TYPES.includes(type)) return { error: `ধরন (type) সঠিক নয় — হতে হবে: ${NOTIFICATION_TYPES.join(', ')}।` };
  if (!String(title || '').trim()) return { error: 'শিরোনাম (title) লাগবে।' };
  if (!String(message || '').trim()) return { error: 'বার্তা (message) লাগবে।' };
  return { error: null };
}

// ---------- helper: insert one notification ----------
// client: a pg client inside a transaction, or null (uses the pool).
// Returns the inserted row, or null if the insert failed (the caller
// decides whether that is fatal — notification failure must never
// break the payment/generation flow that triggered it).
async function createNotification(client, userId, type, title, message) {
  const v = validateNotification(type, title, message);
  if (v.error) throw new Error(v.error);
  const q = `INSERT INTO notifications (user_id, title, body, kind)
             VALUES ($1, $2, $3, $4) RETURNING id, user_id, title, body, kind, is_read, created_at`;
  try {
    const r = client ? await client.query(q, [userId, String(title).trim(), String(message).trim(), type])
                     : await db.query(q, [userId, String(title).trim(), String(message).trim(), type]);
    return r.rows[0];
  } catch (err) {
    console.error('[notifications.create] failed:', err.message);
    return null;
  }
}

// ---------- GET /api/notifications (own only, paginated) ----------
async function listNotifications(req, res) {
  if (!db.getPool()) return dbNotConfigured(res);
  if (!req.user) return res.status(401).json({ error: 'UNAUTHORIZED', message: 'লগইন করুন।' });
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 50);
  const offset = (page - 1) * limit;
  const unreadOnly = String(req.query.unread_only || '') === 'true';
  try {
    const where = unreadOnly ? 'user_id = $1 AND is_read = FALSE' : 'user_id = $1';
    const rows = await db.query(
      `SELECT id, title, body, kind, is_read, created_at FROM notifications
       WHERE ${where} ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [req.user.id, limit, offset]
    );
    const total = (await db.query(
      `SELECT COUNT(*)::int AS n FROM notifications WHERE ${where}`, [req.user.id]
    )).rows[0].n;
    const unread = (await db.query(
      'SELECT COUNT(*)::int AS n FROM notifications WHERE user_id = $1 AND is_read = FALSE', [req.user.id]
    )).rows[0].n;
    return res.json({
      notifications: rows.rows, page, limit, total,
      total_pages: Math.max(Math.ceil(total / limit), 1),
      unread_count: unread,
    });
  } catch (err) {
    console.error('[notifications.list]', err);
    return res.status(500).json({ error: 'SERVER_ERROR', message: 'নোটিফিকেশন লোড করা যায়নি।' });
  }
}

// ---------- POST /api/notifications/:id/read ----------
async function markRead(req, res) {
  if (!db.getPool()) return dbNotConfigured(res);
  if (!req.user) return res.status(401).json({ error: 'UNAUTHORIZED', message: 'লগইন করুন।' });
  try {
    const r = await db.query(
      `UPDATE notifications SET is_read = TRUE WHERE id = $1 AND user_id = $2
       RETURNING id, is_read`,
      [String(req.params.id || '').trim(), req.user.id]
    );
    // Another user's notification (or a missing one) is 404 either way.
    if (!r.rows.length) return res.status(404).json({ error: 'NOT_FOUND', message: 'নোটিফিকেশন পাওয়া যায়নি।' });
    return res.json({ message: 'পড়া হয়েছে বলে চিহ্নিত করা হয়েছে।', notification: r.rows[0] });
  } catch (err) {
    console.error('[notifications.read]', err);
    return res.status(500).json({ error: 'SERVER_ERROR', message: 'চিহ্নিত করা যায়নি।' });
  }
}

module.exports = {
  createNotification,
  listNotifications,
  markRead,
  NOTIFICATION_TYPES,
  _test: { validateNotification },
};
