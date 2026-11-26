// ============================================================
// Suman AI Studio — Phase 9: public gallery
// Rules enforced here:
//  * NOTHING is public by default. A generation reaches the
//    gallery only when its owner explicitly publishes it with
//    is_public=true in the request body (publishToGallery).
//  * listGallery only ever returns is_public = TRUE AND
//    hidden_by_moderation = FALSE items. Private, hidden, or
//    deleted generations can never leak through this list.
//  * Like / comment / report act only on public + visible items:
//    a private or moderated-hidden item returns 404, exactly as
//    if it did not exist (no existence leak).
//  * One like per user (gallery_likes PK), toggle on/off.
//  * Comments: 1-500 chars. Reports: reason required; a report
//    creates a gallery_reports row and bumps reports_count so
//    moderators see it in /api/admin/reports — it does NOT
//    auto-hide the item (a moderator decides; see admin.js).
//  * Demo filter (?demo=true): the 001 schema has NO is_demo
//    column on gallery_items. This handler checks
//    information_schema at runtime: if the column exists it
//    filters on it, otherwise demo=true behaves exactly like the
//    plain public list (never shows private content). A future
//    migration adding `is_demo BOOLEAN DEFAULT FALSE` to
//    gallery_items enables true demo-only filtering — until then
//    no demo claim is made.
//  * No DB -> honest 503 DB_NOT_CONFIGURED. Auth is enforced by
//    server.js wiring (requireAuth) on the mutating routes; this
//    module also returns 401 when req.user is missing, so a
//    wiring mistake fails closed instead of publishing anonymously.
// ============================================================
const db = require('./db');

const COMMENT_MIN = 1;
const COMMENT_MAX = 500;
const REPORT_REASON_MAX = 500;

function dbNotConfigured(res) {
  return res.status(503).json({
    error: 'DB_NOT_CONFIGURED',
    message: 'ডেটাবেস এখনো সংযুক্ত হয়নি (DATABASE_URL নেই)। গ্যালারি দেখা/ব্যবহার করা যাচ্ছে না — মালিককে Supabase সংযোগ করতে হবে (README ধাপ ২)।',
  });
}

function requireUser(req, res) {
  if (!req.user) {
    res.status(401).json({ error: 'UNAUTHORIZED', message: 'লগইন করুন — এই কাজের জন্য অ্যাকাউন্ট লাগবে।' });
    return false;
  }
  return true;
}

function parsePage(req) {
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 50);
  return { page, limit, offset: (page - 1) * limit };
}

// Public shape: owner email is NEVER exposed — only a display name.
function publicItem(row) {
  return {
    id: row.id,
    generation_id: row.generation_id,
    type: row.type,
    model_id: row.model_id,
    prompt: row.prompt,
    result_url: row.result_url,
    owner_name: row.owner_name || null,
    likes_count: row.likes_count,
    comments_count: row.comments_count != null ? parseInt(row.comments_count, 10) : 0,
    created_at: row.created_at,
    liked_by_me: Boolean(row.liked_by_me),
  };
}

async function hasIsDemoColumn() {
  try {
    const r = await db.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_name = 'gallery_items' AND column_name = 'is_demo' LIMIT 1`
    );
    return r.rows.length > 0;
  } catch (err) {
    return false;
  }
}

// ---------- POST /api/gallery/publish { generation_id, is_public: true } ----------
async function publishToGallery(req, res) {
  if (!db.getPool()) return dbNotConfigured(res);
  if (!requireUser(req, res)) return;
  // Explicit opt-in only: anything other than literal `true` is refused.
  if ((req.body || {}).is_public !== true) {
    return res.status(400).json({
      error: 'EXPLICIT_CONSENT_REQUIRED',
      message: 'গ্যালারিতে প্রকাশ করতে is_public: true স্পষ্টভাবে পাঠাতে হবে — ডিফল্টে কিছুই পাবলিক হয় না।',
    });
  }
  const generationId = String((req.body || {}).generation_id || '').trim();
  if (!generationId) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'generation_id দিন।' });
  }
  try {
    const g = await db.query(
      `SELECT id, user_id, status, result_url FROM generations
       WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
      [generationId, req.user.id]
    );
    const gen = g.rows[0];
    // Own + completed only. Another user's generation (or a missing one)
    // is indistinguishable: 404 either way, no ownership leak.
    if (!gen) return res.status(404).json({ error: 'NOT_FOUND', message: 'এই তৈরি জিনিসটি পাওয়া যায়নি।' });
    if (gen.status !== 'completed') {
      return res.status(409).json({ error: 'NOT_COMPLETED', message: 'শুধু সম্পূর্ণ (completed) জেনারেশনই গ্যালারিতে প্রকাশ করা যায়।' });
    }
    if (!gen.result_url) {
      return res.status(409).json({ error: 'NOT_READY', message: 'এই জেনারেশনের ফলাফল ফাইল এখনো তৈরি হয়নি।' });
    }
    const existing = await db.query(
      'SELECT id, is_public FROM gallery_items WHERE generation_id = $1', [generationId]
    );
    if (existing.rows.length) {
      if (existing.rows[0].is_public) {
        return res.json({ message: 'এই জিনিসটি ইতিমধ্যে গ্যালারিতে প্রকাশিত আছে।', item_id: existing.rows[0].id, already_published: true });
      }
      const upd = await db.query(
        'UPDATE gallery_items SET is_public = TRUE WHERE id = $1 RETURNING id',
        [existing.rows[0].id]
      );
      return res.json({ message: 'গ্যালারিতে প্রকাশ করা হয়েছে।', item_id: upd.rows[0].id });
    }
    const ins = await db.query(
      `INSERT INTO gallery_items (generation_id, user_id, is_public)
       VALUES ($1, $2, TRUE) RETURNING id`,
      [generationId, req.user.id]
    );
    return res.status(201).json({ message: 'গ্যালারিতে প্রকাশ করা হয়েছে।', item_id: ins.rows[0].id });
  } catch (err) {
    console.error('[gallery.publish]', err);
    return res.status(500).json({ error: 'SERVER_ERROR', message: 'প্রকাশ করা যায়নি — পরে আবার চেষ্টা করুন।' });
  }
}

// ---------- GET /api/gallery (public, paginated) ----------
async function listGallery(req, res) {
  if (!db.getPool()) return dbNotConfigured(res);
  const { page, limit, offset } = parsePage(req);
  const demoOnly = String(req.query.demo || '') === 'true';
  try {
    let demoFilter = '';
    if (demoOnly && (await hasIsDemoColumn())) demoFilter = ' AND gi.is_demo = TRUE';
    // NOTE: when the is_demo column does not exist (current 001 schema),
    // demo=true returns the same public list — it never widens the set.
    const params = [limit, offset];
    const rows = await db.query(
      `SELECT gi.id, gi.generation_id, gi.likes_count, gi.created_at,
              g.type, g.model_id, g.prompt, g.result_url,
              u.full_name AS owner_name,
              (SELECT COUNT(*)::int FROM gallery_comments c WHERE c.gallery_item_id = gi.id) AS comments_count
       FROM gallery_items gi
       JOIN generations g ON g.id = gi.generation_id AND g.deleted_at IS NULL
       JOIN users u ON u.id = gi.user_id
       WHERE gi.is_public = TRUE AND gi.hidden_by_moderation = FALSE ${demoFilter}
       ORDER BY gi.created_at DESC LIMIT $1 OFFSET $2`,
      params
    );
    const total = (await db.query(
      `SELECT COUNT(*)::int AS n FROM gallery_items gi
       JOIN generations g ON g.id = gi.generation_id AND g.deleted_at IS NULL
       WHERE gi.is_public = TRUE AND gi.hidden_by_moderation = FALSE ${demoFilter}`
    )).rows[0].n;
    let likedSet = new Set();
    if (req.user) {
      const liked = await db.query(
        `SELECT gallery_item_id FROM gallery_likes WHERE user_id = $1 AND gallery_item_id = ANY($2::uuid[])`,
        [req.user.id, rows.rows.map((r) => r.id)]
      ).catch(() => ({ rows: [] }));
      likedSet = new Set(liked.rows.map((r) => r.gallery_item_id));
    }
    return res.json({
      items: rows.rows.map((r) => publicItem({ ...r, liked_by_me: likedSet.has(r.id) })),
      page, limit, total,
      total_pages: Math.max(Math.ceil(total / limit), 1),
      demo: demoOnly,
    });
  } catch (err) {
    console.error('[gallery.list]', err);
    return res.status(500).json({ error: 'SERVER_ERROR', message: 'গ্যালারি লোড করা যায়নি।' });
  }
}

// Load a gallery item only if it is public + visible. Returns the row or
// sends 404 (private / hidden / missing are indistinguishable).
async function _loadVisibleItem(req, res) {
  const id = String(req.params.id || '').trim();
  const r = await db.query(
    `SELECT gi.*, g.type, g.model_id, g.prompt, g.result_url
     FROM gallery_items gi JOIN generations g ON g.id = gi.generation_id AND g.deleted_at IS NULL
     WHERE gi.id = $1 AND gi.is_public = TRUE AND gi.hidden_by_moderation = FALSE`,
    [id]
  );
  if (!r.rows.length) {
    res.status(404).json({ error: 'NOT_FOUND', message: 'গ্যালারি আইটেম পাওয়া যায়নি।' });
    return null;
  }
  return r.rows[0];
}

// ---------- POST /api/gallery/:id/like (toggle, one like per user) ----------
async function likeGallery(req, res) {
  if (!db.getPool()) return dbNotConfigured(res);
  if (!requireUser(req, res)) return;
  try {
    const item = await _loadVisibleItem(req, res);
    if (!item) return;
    const result = await db.withTransaction(async (client) => {
      const existing = await client.query(
        'SELECT 1 FROM gallery_likes WHERE user_id = $1 AND gallery_item_id = $2',
        [req.user.id, item.id]
      );
      if (existing.rows.length) {
        await client.query(
          'DELETE FROM gallery_likes WHERE user_id = $1 AND gallery_item_id = $2',
          [req.user.id, item.id]
        );
        const upd = await client.query(
          'UPDATE gallery_items SET likes_count = GREATEST(likes_count - 1, 0) WHERE id = $1 RETURNING likes_count',
          [item.id]
        );
        return { liked: false, likes_count: upd.rows[0].likes_count };
      }
      await client.query(
        'INSERT INTO gallery_likes (user_id, gallery_item_id) VALUES ($1, $2)',
        [req.user.id, item.id]
      );
      const upd = await client.query(
        'UPDATE gallery_items SET likes_count = likes_count + 1 WHERE id = $1 RETURNING likes_count',
        [item.id]
      );
      return { liked: true, likes_count: upd.rows[0].likes_count };
    });
    return res.json({ message: result.liked ? 'লাইক দেওয়া হয়েছে।' : 'লাইক তুলে নেওয়া হয়েছে।', ...result });
  } catch (err) {
    console.error('[gallery.like]', err);
    return res.status(500).json({ error: 'SERVER_ERROR', message: 'লাইক করা যায়নি।' });
  }
}

// ---------- GET /api/gallery/:id/comments (public, newest last) ----------
async function listGalleryComments(req, res) {
  if (!db.getPool()) return dbNotConfigured(res);
  const { page, limit, offset } = parsePage(req);
  try {
    const item = await _loadVisibleItem(req, res);
    if (!item) return;
    const rows = await db.query(
      `SELECT c.id, c.body, c.created_at, u.full_name AS author_name
       FROM gallery_comments c JOIN users u ON u.id = c.user_id
       WHERE c.gallery_item_id = $1 ORDER BY c.created_at ASC LIMIT $2 OFFSET $3`,
      [item.id, limit, offset]
    );
    const total = (await db.query(
      'SELECT COUNT(*)::int AS n FROM gallery_comments WHERE gallery_item_id = $1', [item.id]
    )).rows[0].n;
    return res.json({ comments: rows.rows, page, limit, total, total_pages: Math.max(Math.ceil(total / limit), 1) });
  } catch (err) {
    console.error('[gallery.comments.list]', err);
    return res.status(500).json({ error: 'SERVER_ERROR', message: 'মন্তব্য লোড করা যায়নি।' });
  }
}

// ---------- POST /api/gallery/:id/comments { body } : 1-500 chars ----------
function validateComment(body) {
  const text = String((body || {}).body || '').trim();
  if (text.length < COMMENT_MIN || text.length > COMMENT_MAX) {
    return { error: `মন্তব্য ${COMMENT_MIN}–${COMMENT_MAX} অক্ষরের মধ্যে হতে হবে।`, text: null };
  }
  return { error: null, text };
}

async function commentGallery(req, res) {
  if (!db.getPool()) return dbNotConfigured(res);
  if (!requireUser(req, res)) return;
  const v = validateComment(req.body);
  if (v.error) return res.status(400).json({ error: 'VALIDATION_ERROR', message: v.error });
  try {
    const item = await _loadVisibleItem(req, res);
    if (!item) return;
    const r = await db.query(
      `INSERT INTO gallery_comments (gallery_item_id, user_id, body)
       VALUES ($1, $2, $3) RETURNING id, body, created_at`,
      [item.id, req.user.id, v.text]
    );
    return res.status(201).json({
      message: 'মন্তব্য যোগ করা হয়েছে।',
      comment: { ...r.rows[0], author_name: req.user.full_name || null },
    });
  } catch (err) {
    console.error('[gallery.comment]', err);
    return res.status(500).json({ error: 'SERVER_ERROR', message: 'মন্তব্য যোগ করা যায়নি।' });
  }
}

// ---------- POST /api/gallery/:id/report { reason } ----------
function validateReport(body) {
  const reason = String((body || {}).reason || '').trim();
  if (!reason) return { error: 'রিপোর্টের কারণ (reason) লিখতে হবে।', reason: null };
  if (reason.length > REPORT_REASON_MAX) return { error: `কারণ ${REPORT_REASON_MAX} অক্ষরের মধ্যে হতে হবে।`, reason: null };
  return { error: null, reason };
}

async function reportGallery(req, res) {
  if (!db.getPool()) return dbNotConfigured(res);
  if (!requireUser(req, res)) return;
  const v = validateReport(req.body);
  if (v.error) return res.status(400).json({ error: 'VALIDATION_ERROR', message: v.error });
  try {
    const item = await _loadVisibleItem(req, res);
    if (!item) return;
    const r = await db.withTransaction(async (client) => {
      const rep = await client.query(
        `INSERT INTO gallery_reports (gallery_item_id, reporter_id, reason)
         VALUES ($1, $2, $3) RETURNING id, created_at`,
        [item.id, req.user.id, v.reason]
      );
      // Flagged for moderation: reports_count rises so moderators see it
      // in /api/admin/reports. The item itself is NOT auto-hidden —
      // a moderator (hide/restore) decides that in admin.js.
      await client.query(
        'UPDATE gallery_items SET reports_count = reports_count + 1 WHERE id = $1',
        [item.id]
      );
      return rep.rows[0];
    });
    return res.status(201).json({
      message: 'রিপোর্ট জমা হয়েছে — মডারেটর যাচাই করবেন।',
      report_id: r.id,
    });
  } catch (err) {
    console.error('[gallery.report]', err);
    return res.status(500).json({ error: 'SERVER_ERROR', message: 'রিপোর্ট জমা দেওয়া যায়নি।' });
  }
}

// ---------- Moderation helpers (shared logic with admin.js) ----------
// admin.js already wires its OWN listReported / moderateGalleryItem /
// resolveReport handlers — do NOT wire these twice. These exports
// exist so other Phase 9 code (or a future route) can reuse the same
// queries without duplicating SQL. They take a pg client (or null
// for the pool) and return data instead of writing an HTTP response.
async function listReported(clientOrNull, { page = 1, limit = 20, unresolvedOnly = false } = {}) {
  const lim = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 50);
  const off = (Math.max(parseInt(page, 10) || 1, 1) - 1) * lim;
  const where = unresolvedOnly ? 'WHERE rep.resolved = FALSE' : '';
  const q = `SELECT rep.id AS report_id, rep.reason, rep.resolved, rep.created_at AS reported_at,
              gi.id AS gallery_item_id, gi.is_public, gi.hidden_by_moderation, gi.likes_count, gi.reports_count,
              g.type, g.model_id, g.prompt, g.result_url,
              u.email AS owner_email, ru.email AS reporter_email
       FROM gallery_reports rep
       JOIN gallery_items gi ON gi.id = rep.gallery_item_id
       JOIN generations g ON g.id = gi.generation_id
       JOIN users u ON u.id = gi.user_id
       JOIN users ru ON ru.id = rep.reporter_id
       ${where} ORDER BY rep.created_at DESC LIMIT $1 OFFSET $2`;
  const run = (text, params) => (clientOrNull ? clientOrNull.query(text, params) : db.query(text, params));
  const rows = await run(q, [lim, off]);
  const total = (await run(
    `SELECT COUNT(*)::int AS n FROM gallery_reports rep ${unresolvedOnly ? 'WHERE rep.resolved = FALSE' : ''}`
  )).rows[0].n;
  return { reports: rows.rows, page: Math.max(parseInt(page, 10) || 1, 1), limit: lim, total, total_pages: Math.max(Math.ceil(total / lim), 1) };
}

async function resolveReport(clientOrNull, reportId) {
  const run = (text, params) => (clientOrNull ? clientOrNull.query(text, params) : db.query(text, params));
  const r = await run(
    'UPDATE gallery_reports SET resolved = TRUE WHERE id = $1 RETURNING id, resolved',
    [String(reportId || '').trim()]
  );
  return r.rows[0] || null;
}

module.exports = {
  publishToGallery,
  listGallery,
  likeGallery,
  listGalleryComments,
  commentGallery,
  reportGallery,
  // moderation helpers (same queries as admin.js — do not wire twice):
  listReported,
  resolveReport,
  _test: { validateComment, validateReport, COMMENT_MIN, COMMENT_MAX },
};
