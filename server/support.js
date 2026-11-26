// ============================================================
// Suman AI Studio — Phase 9: support (tickets, FAQ, announcements)
// Rules enforced here:
//  * Tickets: title + message are required, status starts 'open'.
//    A user sees ONLY their own tickets; admin / super_admin see
//    all (moderators do not — gallery moderation only, per admin.js).
//  * Replies: ticket owner or admin/super_admin only. Anyone else
//    (including another user) gets 404, not 403, so ticket
//    existence does not leak.
//  * SCHEMA GAP (honest): the 001 schema has a support_tickets
//    table but NO support_ticket_replies table. replyTicket
//    therefore checks information_schema first: if the replies
//    table exists it inserts the reply; if not, it returns 501
//    SUPPORT_REPLIES_NOT_MIGRATED with the exact SQL the owner
//    must run (see the PHASE9 report) instead of pretending the
//    reply was saved. Creating the table is a migration — outside
//    the files Phase 9 was asked to build — so it is flagged to
//    the coordinator rather than silently skipped or faked.
//  * FAQ / announcements are PUBLIC and only ever return
//    is_active = TRUE rows (admin content CRUD stays in admin.js).
//  * No DB -> honest 503 DB_NOT_CONFIGURED. No user -> 401
//    (except the two public list endpoints).
// ============================================================
const db = require('./db');

function dbNotConfigured(res) {
  return res.status(503).json({
    error: 'DB_NOT_CONFIGURED',
    message: 'ডেটাবেস এখনো সংযুক্ত হয়নি (DATABASE_URL নেই)। সাপোর্ট কাজ করছে না — মালিককে Supabase সংযোগ করতে হবে (README ধাপ ২)।',
  });
}

function isAdminUser(user) {
  return user && (user.role === 'admin' || user.role === 'super_admin');
}

function parsePage(req) {
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 50);
  return { page, limit, offset: (page - 1) * limit };
}

async function hasRepliesTable() {
  try {
    const r = await db.query(
      `SELECT 1 FROM information_schema.tables WHERE table_name = 'support_ticket_replies' LIMIT 1`
    );
    return r.rows.length > 0;
  } catch (err) {
    return false;
  }
}

// ---------- POST /api/support/tickets { title, message } ----------
// Body field is `title`; the table column is `subject` — mapped here.
function validateTicket(body) {
  const title = String((body || {}).title || (body || {}).subject || '').trim();
  const message = String((body || {}).message || '').trim();
  if (!title) return { error: 'শিরোনাম (title) লিখতে হবে।', title: null, message: null };
  if (title.length > 200) return { error: 'শিরোনাম ২০০ অক্ষরের মধ্যে হতে হবে।', title: null, message: null };
  if (!message) return { error: 'বার্তা (message) লিখতে হবে।', title: null, message: null };
  if (message.length > 5000) return { error: 'বার্তা ৫০০০ অক্ষরের মধ্যে হতে হবে।', title: null, message: null };
  return { error: null, title, message };
}

async function createTicket(req, res) {
  if (!db.getPool()) return dbNotConfigured(res);
  if (!req.user) return res.status(401).json({ error: 'UNAUTHORIZED', message: 'লগইন করুন — টিকিট খুলতে অ্যাকাউন্ট লাগবে।' });
  const v = validateTicket(req.body);
  if (v.error) return res.status(400).json({ error: 'VALIDATION_ERROR', message: v.error });
  try {
    const r = await db.query(
      `INSERT INTO support_tickets (user_id, subject, message, status)
       VALUES ($1, $2, $3, 'open') RETURNING id, subject, message, status, created_at`,
      [req.user.id, v.title, v.message]
    );
    return res.status(201).json({ message: 'টিকিট খোলা হয়েছে — সাপোর্ট দল শীঘ্রই উত্তর দেবে।', ticket: r.rows[0] });
  } catch (err) {
    console.error('[support.create]', err);
    return res.status(500).json({ error: 'SERVER_ERROR', message: 'টিকিট খোলা যায়নি — পরে আবার চেষ্টা করুন।' });
  }
}

// ---------- GET /api/support/tickets (own; admin sees all) ----------
async function listTickets(req, res) {
  if (!db.getPool()) return dbNotConfigured(res);
  if (!req.user) return res.status(401).json({ error: 'UNAUTHORIZED', message: 'লগইন করুন।' });
  const { page, limit, offset } = parsePage(req);
  const status = String(req.query.status || '').trim();
  try {
    const admin = isAdminUser(req.user);
    const where = [];
    const params = [];
    if (!admin) { params.push(req.user.id); where.push(`t.user_id = $${params.length}`); }
    if (['open', 'in_progress', 'closed'].includes(status)) { params.push(status); where.push(`t.status = $${params.length}`); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const rows = await db.query(
      `SELECT t.id, t.user_id, t.subject, t.message, t.status, t.created_at, u.email AS user_email
       FROM support_tickets t LEFT JOIN users u ON u.id = t.user_id
       ${clause} ORDER BY t.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );
    const total = (await db.query(
      `SELECT COUNT(*)::int AS n FROM support_tickets t ${clause}`, params
    )).rows[0].n;
    // Non-admins never see another user's email.
    const tickets = rows.rows.map((t) => (admin ? t : { ...t, user_email: undefined }));
    return res.json({ tickets, page, limit, total, total_pages: Math.max(Math.ceil(total / limit), 1) });
  } catch (err) {
    console.error('[support.list]', err);
    return res.status(500).json({ error: 'SERVER_ERROR', message: 'টিকিট তালিকা লোড করা যায়নি।' });
  }
}

// Load one ticket the caller is allowed to see (owner or admin).
// Returns the row or sends 404 and returns null.
async function _loadVisibleTicket(req, res) {
  const id = String(req.params.id || '').trim();
  const r = await db.query('SELECT * FROM support_tickets WHERE id = $1', [id]);
  const ticket = r.rows[0];
  if (!ticket) {
    res.status(404).json({ error: 'NOT_FOUND', message: 'টিকিট পাওয়া যায়নি।' });
    return null;
  }
  const admin = isAdminUser(req.user);
  if (!admin && String(ticket.user_id) !== String(req.user.id)) {
    res.status(404).json({ error: 'NOT_FOUND', message: 'টিকিট পাওয়া যায়নি।' });
    return null;
  }
  return ticket;
}

// ---------- GET /api/support/tickets/:id/replies ----------
async function listTicketReplies(req, res) {
  if (!db.getPool()) return dbNotConfigured(res);
  if (!req.user) return res.status(401).json({ error: 'UNAUTHORIZED', message: 'লগইন করুন।' });
  try {
    const ticket = await _loadVisibleTicket(req, res);
    if (!ticket) return;
    if (!(await hasRepliesTable())) return res.json({ ticket_id: ticket.id, replies: [], replies_not_migrated: true });
    const rows = await db.query(
      `SELECT r.id, r.body, r.created_at, r.user_id, u.full_name AS author_name, u.role AS author_role
       FROM support_ticket_replies r JOIN users u ON u.id = r.user_id
       WHERE r.ticket_id = $1 ORDER BY r.created_at ASC LIMIT 100`,
      [ticket.id]
    );
    return res.json({ ticket_id: ticket.id, replies: rows.rows });
  } catch (err) {
    console.error('[support.replies.list]', err);
    return res.status(500).json({ error: 'SERVER_ERROR', message: 'উত্তর লোড করা যায়নি।' });
  }
}

// ---------- POST /api/support/tickets/:id/replies { body } ----------
function validateReply(body) {
  const text = String((body || {}).body || (body || {}).message || '').trim();
  if (!text) return { error: 'উত্তরের বার্তা লিখতে হবে।', text: null };
  if (text.length > 5000) return { error: 'উত্তর ৫০০০ অক্ষরের মধ্যে হতে হবে।', text: null };
  return { error: null, text };
}

async function replyTicket(req, res) {
  if (!db.getPool()) return dbNotConfigured(res);
  if (!req.user) return res.status(401).json({ error: 'UNAUTHORIZED', message: 'লগইন করুন।' });
  const v = validateReply(req.body);
  if (v.error) return res.status(400).json({ error: 'VALIDATION_ERROR', message: v.error });
  try {
    const ticket = await _loadVisibleTicket(req, res);
    if (!ticket) return;
    if (ticket.status === 'closed') {
      return res.status(409).json({ error: 'TICKET_CLOSED', message: 'এই টিকিটটি বন্ধ হয়ে গেছে — নতুন টিকিট খুলুন।' });
    }
    if (!(await hasRepliesTable())) {
      // Honest failure, not a fake success: the reply has nowhere to go.
      return res.status(501).json({
        error: 'SUPPORT_REPLIES_NOT_MIGRATED',
        message: 'টিকিটের উত্তর সংরক্ষণের টেবিল (support_ticket_replies) এখনো ডেটাবেসে নেই — মালিককে মাইগ্রেশন চালাতে হবে। উত্তরটি সংরক্ষণ করা হয়নি।',
        migration_sql: "CREATE TABLE IF NOT EXISTS support_ticket_replies (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), ticket_id UUID NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE, user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE, body TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now());",
      });
    }
    const reply = await db.withTransaction(async (client) => {
      const r = await client.query(
        `INSERT INTO support_ticket_replies (ticket_id, user_id, body)
         VALUES ($1, $2, $3) RETURNING id, body, created_at`,
        [ticket.id, req.user.id, v.text]
      );
      // An admin reply moves an open ticket to in_progress.
      if (isAdminUser(req.user) && ticket.status === 'open') {
        await client.query("UPDATE support_tickets SET status = 'in_progress' WHERE id = $1", [ticket.id]);
      }
      return r.rows[0];
    });
    return res.status(201).json({
      message: 'উত্তর যোগ করা হয়েছে।',
      reply: { ...reply, author_name: req.user.full_name || null, author_role: req.user.role },
    });
  } catch (err) {
    console.error('[support.reply]', err);
    return res.status(500).json({ error: 'SERVER_ERROR', message: 'উত্তর যোগ করা যায়নি।' });
  }
}

// ---------- GET /api/faqs (public, only active) ----------
async function listFaqs(req, res) {
  if (!db.getPool()) return dbNotConfigured(res);
  try {
    const r = await db.query(
      `SELECT id, question_bn, question_en, answer_bn, answer_en, sort_order
       FROM faqs WHERE is_active = TRUE ORDER BY sort_order ASC, id ASC`
    );
    return res.json({ faqs: r.rows });
  } catch (err) {
    console.error('[support.faqs]', err);
    return res.status(500).json({ error: 'SERVER_ERROR', message: 'FAQ লোড করা যায়নি।' });
  }
}

// ---------- GET /api/announcements (public, only active) ----------
async function listAnnouncements(req, res) {
  if (!db.getPool()) return dbNotConfigured(res);
  try {
    const r = await db.query(
      `SELECT id, title_bn, title_en, body_bn, body_en, created_at
       FROM announcements WHERE is_active = TRUE ORDER BY created_at DESC LIMIT 20`
    );
    return res.json({ announcements: r.rows });
  } catch (err) {
    console.error('[support.announcements]', err);
    return res.status(500).json({ error: 'SERVER_ERROR', message: 'ঘোষণা লোড করা যায়নি।' });
  }
}

module.exports = {
  createTicket,
  listTickets,
  listTicketReplies,
  replyTicket,
  listFaqs,
  listAnnouncements,
  _test: { validateTicket, validateReply, isAdminUser },
};
