// ============================================================
// Suman AI Studio — Phase 8: Higgsfield generation flow
// POST /api/generate, GET /api/generations/:id/status,
// POST /api/generations/:id/cancel, POST /api/upload-reference.
// Rules enforced here (same spirit as Phase 6 credits):
//  * Amounts NEVER come from the browser: credit cost is read
//    server-side from config/models.json (verified + enabled only).
//  * Credits are deducted in the SAME transaction that creates the
//    generations row (credits.deductCredits, idempotency key
//    `generate:<generation_uuid>`). The Higgsfield call happens
//    OUTSIDE that transaction, after it commits.
//  * If submitJob throws after deduction, the row is marked failed
//    and refunded ONCE via credits.refundGeneration
//    (idempotency key `refund:<generation_id>`).
//  * Failed / NSFW jobs are refunded once; a canceled job is
//    refunded once only if it never completed. A completed job is
//    NEVER refunded.
//  * Ownership: every status/cancel query filters user_id —
//    another user's generation is a 404, never a leak.
//  * No DB (DATABASE_URL missing) -> honest 503 DB_NOT_CONFIGURED.
//    No Higgsfield key -> honest 503 HIGGSFIELD_NOT_CONFIGURED,
//    checked BEFORE any credit is deducted.
//  * Reference upload: Supabase Storage is NOT configured, so the
//    endpoint validates the metadata and always answers 501
//    STORAGE_NOT_CONFIGURED — never a fake success.
// Schema notes (honest gaps, see final Phase 8 report):
//  * `generations` has NO watermark_required column in migrations
//    001-003. The flag is computed here and stored ONLY if the
//    column exists (checked per transaction); a migration 004
//    adding `watermark_required BOOLEAN NOT NULL DEFAULT TRUE`
//    is still needed for it to persist.
//  * `api_usage` has NO estimated-cost column: the RECORDED cost
//    (from Higgsfield, else null) goes in higgsfield_cost_usd;
//    the ESTIMATED cost is generations.credit_cost and is
//    labelled separately in API responses — never mixed.
// ============================================================
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const db = require('./db');
const credits = require('./credits');
const higgsfield = require('./higgsfield');
const settings = require('./settings');
const notifications = require('./notifications'); // Phase 9: generation-completed notice

const MAX_PROMPT_CHARS = 2000;
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // 50 MB
const ALLOWED_UPLOAD_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/webm'];
const VALID_TYPES = ['text-to-image', 'text-to-video', 'image-to-video', 'image-edit', 'video-edit'];
const TERMINAL_STATUSES = ['completed', 'failed', 'nsfw', 'canceled'];

// Rate limit for generation: each call can cost real money.
// 30 generations / hour / IP (the global /api/ limiter also applies).
const generateRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'TOO_MANY_GENERATIONS', message: 'অনেক জেনারেশন চেষ্টা হয়েছে — ১ ঘণ্টা পর আবার চেষ্টা করুন।' },
});
const uploadRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'TOO_MANY_UPLOADS', message: 'অনেকবার আপলোড চেষ্টা হয়েছে — ১৫ মিনিট পর আবার চেষ্টা করুন।' },
});

// ---------- pure helpers (isolated-testable, no DB) ----------

// Cost from the server-side registry. `models` is injectable so
// tests can cover the unverified case (the live registry currently
// has no unverified model in its `models` array).
// Throws an Error with .code / .status — never returns a fake cost.
function estimateCost(modelId, models) {
  const list = models || higgsfield.loadModels();
  const model = list.find((m) => m.id === modelId) || null;
  if (!model) {
    const err = new Error(`Unknown model: ${modelId}`);
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
  if (!Number.isInteger(model.credit_cost) || model.credit_cost < 0) {
    const err = new Error(`Model has no valid credit_cost in registry: ${modelId}`);
    err.code = 'MODEL_COST_INVALID'; err.status = 500; throw err;
  }
  return { model_id: model.id, name: model.name, type: model.type, credit_cost: model.credit_cost };
}

function buildIdempotencyKey(prefix, id) {
  return credits.makeIdempotencyKey(prefix, id);
}

function refundKeyFor(generationId) {
  return credits.makeIdempotencyKey('refund', generationId);
}

// Prompt: non-empty string, max 2000 chars (after trim).
// Returns { ok, prompt } or { ok:false, error } — never throws.
function validatePrompt(raw) {
  if (typeof raw !== 'string') return { ok: false, error: 'PROMPT_REQUIRED' };
  const prompt = raw.trim();
  if (!prompt) return { ok: false, error: 'PROMPT_REQUIRED' };
  if (prompt.length > MAX_PROMPT_CHARS) return { ok: false, error: 'PROMPT_TOO_LONG' };
  return { ok: true, prompt };
}

// Watermark: free user -> true. Watermark-free only when the user
// has an ACTIVE paid subscription OR users.is_paid is true (a
// credit-pack purchase sets is_paid — see payments.js). Any DB
// error / unknown state defaults to TRUE (safe side: watermark on).
function watermarkRequiredForUser({ hasActiveSubscription = false, isPaid = false, dbError = false } = {}) {
  if (dbError) return true;
  return !(hasActiveSubscription || isPaid);
}

// Reference-upload metadata validation (JSON body only — no real
// multipart parser dependency). Returns { ok } or { ok:false, error, message }.
function validateUploadReference(body) {
  const b = body || {};
  const filename = typeof b.filename === 'string' ? b.filename.trim() : '';
  const contentType = typeof b.contentType === 'string' ? b.contentType.trim().toLowerCase() : '';
  const sizeBytes = b.sizeBytes;
  if (!filename) return { ok: false, error: 'VALIDATION_ERROR', message: 'ফাইলের নাম (filename) দিন।' };
  if (!ALLOWED_UPLOAD_TYPES.includes(contentType)) {
    return { ok: false, error: 'VALIDATION_ERROR', message: 'শুধু JPG, PNG, WebP ছবি বা MP4/WebM ভিডিও দেওয়া যাবে।' };
  }
  if (!Number.isInteger(sizeBytes) || sizeBytes <= 0) {
    return { ok: false, error: 'VALIDATION_ERROR', message: 'ফাইলের সাইজ (sizeBytes) সঠিক নয়।' };
  }
  if (sizeBytes > MAX_UPLOAD_BYTES) {
    return { ok: false, error: 'VALIDATION_ERROR', message: 'ফাইল ৫০ MB-এর বেশি হতে পারবে না।' };
  }
  return { ok: true, filename, contentType, sizeBytes };
}

// ---------- shared response helpers ----------
function dbNotConfigured(res) {
  return res.status(503).json({
    error: 'DB_NOT_CONFIGURED',
    message: 'ডেটাবেস এখনো সংযুক্ত হয়নি (DATABASE_URL নেই)। জেনারেশন করা যাচ্ছে না — মালিককে Supabase সংযোগ করতে হবে (README ধাপ ২)।',
  });
}

function unauthorized(res) {
  return res.status(401).json({ error: 'UNAUTHORIZED', message: 'লগইন করুন — টোকেন পাওয়া যায়নি।' });
}

function publicGeneration(row) {
  return {
    id: row.id,
    type: row.type,
    model_id: row.model_id,
    prompt: row.prompt,
    status: row.status,
    credit_cost: row.credit_cost,
    higgsfield_request_id: row.higgsfield_request_id || null,
    result_url: row.result_url || null,
    watermark_required: row.watermark_required !== undefined ? row.watermark_required : undefined,
    error_message: row.status === 'failed' || row.status === 'nsfw' ? (row.error_message || null) : null,
    created_at: row.created_at,
    completed_at: row.completed_at || null,
  };
}

// Does the generations table have a watermark_required column?
// (Migrations 001-003 do not add it — see header note.)
async function _hasWatermarkColumn(client) {
  try {
    const r = await client.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_name = 'generations' AND column_name = 'watermark_required'`
    );
    return r.rows.length > 0;
  } catch {
    return false;
  }
}

// Active paid subscription? Any error -> null (caller defaults watermark to true).
async function _hasActiveSubscription(client, userId) {
  try {
    const r = await client.query(
      `SELECT id FROM subscriptions
       WHERE user_id = $1 AND status = 'active' AND ends_at > now() LIMIT 1`,
      [userId]
    );
    return r.rows.length > 0;
  } catch {
    return null; // unknown — caller treats as "default watermark on"
  }
}

// Refund ONCE inside a transaction, for statuses refundGeneration()
// refuses (nsfw / canceled): addCredits with the same
// `refund:<generation_id>` key is idempotent — a replay returns
// { replayed: true } and credits nothing twice.
async function _refundOnce(client, gen) {
  if (!gen || !gen.credit_cost || gen.credit_cost <= 0) return { refunded: false, reason: 'NO_CREDIT_CHARGED' };
  const { row, replayed } = await credits.addCredits(client, {
    userId: gen.user_id,
    amount: gen.credit_cost,
    reason: 'refund',
    referenceId: gen.id,
    idempotencyKey: refundKeyFor(gen.id),
  });
  if (replayed) return { refunded: false, reason: 'ALREADY_REFUNDED', row };
  return { refunded: true, row };
}

async function _loadOwnGeneration(req, res) {
  const id = String(req.params.id || '').trim();
  const r = await db.query(
    'SELECT * FROM generations WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL',
    [id, req.user.id]
  );
  if (!r.rows.length) {
    res.status(404).json({ error: 'NOT_FOUND', message: 'এই জেনারেশনটি পাওয়া যায়নি (অন্যের জেনারেশন হলে এভাবেই দেখাবে)।' });
    return null;
  }
  return r.rows[0];
}

function _truncateError(err, max = 500) {
  return String((err && (err.message || err)) || 'Unknown error').slice(0, max);
}

// Map a Higgsfield status string to our job_status enum.
function normalizeHiggsfieldStatus(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (['completed', 'complete', 'success', 'succeeded'].includes(s)) return 'completed';
  if (['failed', 'error'].includes(s)) return 'failed';
  if (['nsfw', 'content_filtered', 'rejected'].includes(s)) return 'nsfw';
  if (['canceled', 'cancelled'].includes(s)) return 'canceled';
  if (['queued', 'pending'].includes(s)) return 'queued';
  return 'in_progress'; // processing / running / generating / unknown-but-alive
}

function _extractResultUrl(data) {
  if (!data || typeof data !== 'object') return null;
  return data.output_url || data.result_url || data.url
    || (data.output && data.output.url) || (data.result && data.result.url)
    || (Array.isArray(data.outputs) && data.outputs[0] && (data.outputs[0].url || data.outputs[0]))
    || (Array.isArray(data.results) && data.results[0] && (data.results[0].url || data.results[0]))
    || null;
}

function _extractRecordedCostUsd(data) {
  if (!data || typeof data !== 'object') return null;
  const v = data.cost_usd ?? data.higgsfield_cost_usd ?? data.cost
    ?? (data.usage && data.usage.cost_usd) ?? null;
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return Number.isFinite(n) ? n : null;
}

// ---------- POST /api/generate ----------
async function submitGeneration(req, res) {
  if (!req.user) return unauthorized(res);
  if (!db.getPool()) return dbNotConfigured(res);

  const body = req.body || {};
  const modelId = typeof body.model_id === 'string' ? body.model_id.trim() : '';
  if (!modelId) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'মডেল বাছুন (model_id আবশ্যক)।' });
  }
  const promptCheck = validatePrompt(body.prompt);
  if (!promptCheck.ok) {
    return res.status(400).json({
      error: 'VALIDATION_ERROR',
      message: promptCheck.error === 'PROMPT_TOO_LONG'
        ? `প্রম্পট ${MAX_PROMPT_CHARS} অক্ষরের বেশি হতে পারবে না।`
        : 'প্রম্পট লিখুন।',
    });
  }
  const prompt = promptCheck.prompt;
  const inputUrl = typeof body.input_url === 'string' ? body.input_url.trim() : '';

  let cost;
  try {
    cost = estimateCost(modelId);
  } catch (err) {
    const status = err.status || 400;
    return res.status(status).json({ error: err.code || 'MODEL_ERROR', message: err.message });
  }
  // The browser may send a `type`, but the model's type wins — and
  // it must fit the generations CHECK constraint.
  if (body.type && body.type !== cost.type) {
    return res.status(400).json({
      error: 'MODEL_TYPE_MISMATCH',
      message: `এই মডেলটি ${cost.type} ধরনের — ${body.type} ধরনের জেনারেশন এতে হবে না।`,
    });
  }
  if (!VALID_TYPES.includes(cost.type)) {
    return res.status(400).json({
      error: 'MODEL_TYPE_UNSUPPORTED',
      message: `এই মডেলের ধরন (${cost.type}) এখনো সাপোর্ট করা হয়নি।`,
    });
  }
  if (cost.type === 'image-to-video' && !inputUrl) {
    return res.status(400).json({
      error: 'INPUT_URL_REQUIRED',
      message: 'Image-to-Video-র জন্য একটি রেফারেন্স ছবির URL (input_url) আবশ্যক — আপলোড এখনো চালু হয়নি, হোস্ট করা ছবির লিংক দিন।',
    });
  }
  // Never charge when the provider is unavailable.
  if (!higgsfield.isConfigured()) {
    return res.status(503).json({
      error: 'HIGGSFIELD_NOT_CONFIGURED',
      message: 'Higgsfield API Key এখনো বসানো হয়নি — জেনারেশন চালু হবে না। মালিককে HIGGSFIELD_API_KEY বসাতে হবে (README ধাপ ৪)। কোনো ক্রেডিট কাটা হয়নি।',
      docs: 'https://docs.higgsfield.ai/docs/index',
    });
  }

  const generationId = crypto.randomUUID();
  const idemKey = buildIdempotencyKey('generate', generationId);
  const payload = { prompt };
  if (inputUrl) payload.image_url = inputUrl;
  if (Number.isInteger(body.duration) && body.duration >= 3 && body.duration <= 30) payload.duration = body.duration;
  if (typeof body.aspect_ratio === 'string' && body.aspect_ratio.trim()) payload.aspect_ratio = body.aspect_ratio.trim();

  // 1) Deduct + create row in ONE transaction.
  let created;
  try {
    created = await db.withTransaction(async (client) => {
      const hasSub = await _hasActiveSubscription(client, req.user.id);
      const watermarkRequired = watermarkRequiredForUser({
        hasActiveSubscription: hasSub === true,
        isPaid: req.user.is_paid === true,
        dbError: hasSub === null,
      });
      const { row: ledgerRow } = await credits.deductCredits(client, {
        userId: req.user.id,
        amount: cost.credit_cost,
        reason: 'generation',
        referenceId: generationId,
        idempotencyKey: idemKey,
      });
      const retentionDays = await settings.getRetentionDays(client).catch(() => 30);
      const hasWmCol = await _hasWatermarkColumn(client);
      const cols = ['id', 'user_id', 'type', 'model_id', 'prompt', 'input_url', 'status',
        'credit_cost', 'idempotency_key', 'expires_at'];
      const vals = [generationId, req.user.id, cost.type, modelId, prompt, inputUrl || null,
        'queued', cost.credit_cost, idemKey,
        new Date(Date.now() + retentionDays * 24 * 60 * 60 * 1000)];
      if (hasWmCol) { cols.push('watermark_required'); vals.push(watermarkRequired); }
      const placeholders = vals.map((_, i) => `$${i + 1}`).join(',');
      const r = await client.query(
        `INSERT INTO generations (${cols.join(',')}) VALUES (${placeholders}) RETURNING *`,
        vals
      );
      return { row: r.rows[0], balanceAfter: ledgerRow.balance_after, watermarkRequired };
    });
  } catch (err) {
    if (err.code === 'INSUFFICIENT_CREDITS' || err.code === '23514') {
      return res.status(402).json({
        error: 'INSUFFICIENT_CREDITS',
        message: `ক্রেডিট যথেষ্ট নয় — এই মডেলে ${cost.credit_cost} ক্রেডিট লাগবে। প্যাকেজ কিনে ক্রেডিট যোগ করুন।`,
        required_credits: cost.credit_cost,
      });
    }
    if (err.code === '23505') {
      return res.status(409).json({ error: 'DUPLICATE_GENERATION', message: 'এই জেনারেশনটি ইতিমধ্যে জমা হয়েছে — আবার পাঠাবেন না।' });
    }
    console.error('[generate.submit] tx failed:', err);
    return res.status(500).json({ error: 'SERVER_ERROR', message: 'জেনারেশন জমা দেওয়া যায়নি — পরে আবার চেষ্টা করুন। কোনো ক্রেডিট কাটা হয়নি।' });
  }

  // 2) Call Higgsfield OUTSIDE the transaction.
  let hf;
  try {
    hf = await higgsfield.submitJob(modelId, payload, { idempotencyKey: idemKey });
  } catch (err) {
    // 3) Provider failed AFTER deduction: mark failed + refund ONCE.
    let refunded = false;
    try {
      const out = await db.withTransaction(async (client) => {
        await client.query(
          `UPDATE generations SET status = 'failed', error_message = $2 WHERE id = $1`,
          [generationId, _truncateError(err)]
        );
        return credits.refundGeneration(client, generationId);
      });
      refunded = out.refunded === true;
    } catch (refundErr) {
      console.error('[generate.submit] refund failed for', generationId, refundErr);
    }
    if (err.code === 'HIGGSFIELD_NOT_CONFIGURED' || err.status === 503) {
      return res.status(503).json({
        error: 'HIGGSFIELD_NOT_CONFIGURED',
        message: 'Higgsfield সংযুক্ত হয়নি — জেনারেশন হয়নি। ক্রেডিট ফেরত দেওয়া হয়েছে।',
        generation_id: generationId, refunded,
      });
    }
    return res.status(502).json({
      error: 'HIGGSFIELD_ERROR',
      message: 'Higgsfield-এ জেনারেশন জমা দেওয়া যায়নি — ক্রেডিট ফেরত দেওয়া হয়েছে। পরে আবার চেষ্টা করুন।',
      detail: _truncateError(err, 200),
      generation_id: generationId, refunded,
    });
  }

  // 4) Submitted: store the provider request id.
  const requestId = (hf && (hf.request_id || hf.id)) || null;
  const statusUrl = (hf && (hf.status_url || hf.statusUrl)) || null;
  const providerStatus = normalizeHiggsfieldStatus(hf && hf.status);
  try {
    const r = await db.query(
      `UPDATE generations SET higgsfield_request_id = $2, higgsfield_status_url = $3,
         status = $4 WHERE id = $1 RETURNING *`,
      [generationId, requestId, statusUrl, providerStatus === 'queued' ? 'queued' : 'in_progress']
    );
    return res.status(201).json({
      message: 'জেনারেশন জমা হয়েছে — তৈরি হচ্ছে।',
      generation: publicGeneration({ ...r.rows[0], watermark_required: created.watermarkRequired }),
      higgsfield_request_id: requestId,
      credit_cost: cost.credit_cost,
      balance_after: created.balanceAfter,
      watermark_required: created.watermarkRequired,
    });
  } catch (err) {
    console.error('[generate.submit] store request id failed:', err);
    // Credits were deducted and the job WAS submitted — do NOT
    // refund here; the row still exists with the request id in the
    // provider response returned below for status polling.
    return res.status(201).json({
      message: 'জেনারেশন জমা হয়েছে (সার্ভারে request id সংরক্ষণে সমস্যা হয়েছে — স্ট্যাটাস দিয়ে খুঁজুন)।',
      generation: publicGeneration({ ...created.row, watermark_required: created.watermarkRequired }),
      higgsfield_request_id: requestId,
      credit_cost: cost.credit_cost,
      balance_after: created.balanceAfter,
      watermark_required: created.watermarkRequired,
    });
  }
}

// ---------- GET /api/generations/:id/status ----------
async function checkStatus(req, res) {
  if (!req.user) return unauthorized(res);
  if (!db.getPool()) return dbNotConfigured(res);

  let row;
  try {
    row = await _loadOwnGeneration(req, res);
    if (!row) return; // 404 already sent
  } catch (err) {
    console.error('[generate.status] load failed:', err);
    return res.status(500).json({ error: 'SERVER_ERROR', message: 'স্ট্যাটাস দেখা যায়নি — পরে আবার চেষ্টা করুন।' });
  }

  // Terminal already: no need to poll the provider again.
  if (TERMINAL_STATUSES.includes(row.status)) {
    return res.json({
      generation: publicGeneration(row),
      estimated_credit_cost: row.credit_cost,
      recorded_cost_usd: row.higgsfield_cost_usd !== undefined ? row.higgsfield_cost_usd : null,
    });
  }
  if (!row.higgsfield_request_id && !row.higgsfield_status_url) {
    return res.status(409).json({
      error: 'NOT_SUBMITTED',
      message: 'এই জেনারেশনটি এখনো Higgsfield-এ জমা দেওয়া হয়নি।',
      generation: publicGeneration(row),
    });
  }

  let data;
  try {
    data = await higgsfield.getStatus(row.higgsfield_status_url || row.higgsfield_request_id);
  } catch (err) {
    if (err.code === 'HIGGSFIELD_NOT_CONFIGURED' || err.status === 503) {
      return res.status(503).json({ error: 'HIGGSFIELD_NOT_CONFIGURED', message: 'Higgsfield সংযুক্ত হয়নি — স্ট্যাটাস দেখা যাচ্ছে না।', generation: publicGeneration(row) });
    }
    return res.status(502).json({ error: 'HIGGSFIELD_ERROR', message: 'Higgsfield থেকে স্ট্যাটাস আনা যায়নি — পরে আবার চেষ্টা করুন।', generation: publicGeneration(row) });
  }

  const status = normalizeHiggsfieldStatus(data && data.status);
  try {
    if (status === 'completed') {
      const resultUrl = _extractResultUrl(data);
      const recordedUsd = _extractRecordedCostUsd(data);
      const updated = await db.withTransaction(async (client) => {
        const r = await client.query(
          `UPDATE generations SET status = 'completed', result_url = $2,
             higgsfield_cost_usd = $3, completed_at = now()
           WHERE id = $1 RETURNING *`,
          [row.id, resultUrl, recordedUsd]
        );
        // One api_usage row per generation — never duplicate on re-polls.
        const ex = await client.query('SELECT id FROM api_usage WHERE generation_id = $1', [row.id]);
        if (!ex.rows.length) {
          await client.query(
            'INSERT INTO api_usage (generation_id, model_id, higgsfield_cost_usd) VALUES ($1,$2,$3)',
            [row.id, row.model_id, recordedUsd]
          );
          // Notify once (same guard as the api_usage row above).
          await notifications.createNotification(
            client, row.user_id, 'generation_completed',
            'জেনারেশন সম্পূর্ণ হয়েছে ✅',
            `আপনার ${row.model_id} জেনারেশন তৈরি হয়েছে — My Creations থেকে ডাউনলোড করুন।`
          );
        }
        return r.rows[0];
      });
      return res.json({
        generation: publicGeneration(updated),
        estimated_credit_cost: row.credit_cost, // server-side estimate (credits)
        recorded_cost_usd: recordedUsd,         // what Higgsfield actually reported (null if absent)
      });
    }

    if (status === 'failed' || status === 'nsfw') {
      const errMsg = _truncateError((data && (data.error || data.message)) || (status === 'nsfw' ? 'Content filtered (NSFW)' : 'Generation failed'));
      let refunded = false;
      const updated = await db.withTransaction(async (client) => {
        const r = await client.query(
          `UPDATE generations SET status = $2, error_message = $3 WHERE id = $1 RETURNING *`,
          [row.id, status, errMsg]
        );
        const gen = r.rows[0];
        // refundGeneration() only refunds status='failed'; NSFW
        // uses the same once-only key via _refundOnce.
        const out = status === 'failed'
          ? await credits.refundGeneration(client, row.id)
          : await _refundOnce(client, gen);
        refunded = out.refunded === true;
        return gen;
      });
      return res.json({
        generation: publicGeneration(updated),
        refunded,
        estimated_credit_cost: row.credit_cost,
        recorded_cost_usd: _extractRecordedCostUsd(data),
      });
    }

    if (status === 'canceled') {
      let refunded = false;
      const updated = await db.withTransaction(async (client) => {
        const r = await client.query(
          `UPDATE generations SET status = 'canceled' WHERE id = $1 RETURNING *`,
          [row.id]
        );
        const out = await _refundOnce(client, r.rows[0]);
        refunded = out.refunded === true;
        return r.rows[0];
      });
      return res.json({ generation: publicGeneration(updated), refunded, estimated_credit_cost: row.credit_cost });
    }

    // Still running: record the in-progress state and report it.
    const r = await db.query(
      `UPDATE generations SET status = $2 WHERE id = $1 RETURNING *`,
      [row.id, status === 'queued' ? 'queued' : 'in_progress']
    );
    return res.json({ generation: publicGeneration(r.rows[0]), estimated_credit_cost: row.credit_cost });
  } catch (err) {
    console.error('[generate.status] update failed:', err);
    return res.status(500).json({ error: 'SERVER_ERROR', message: 'স্ট্যাটাস সংরক্ষণ করা যায়নি — পরে আবার চেষ্টা করুন।', generation: publicGeneration(row) });
  }
}

// ---------- POST /api/generations/:id/cancel ----------
async function cancelGeneration(req, res) {
  if (!req.user) return unauthorized(res);
  if (!db.getPool()) return dbNotConfigured(res);

  let row;
  try {
    row = await _loadOwnGeneration(req, res);
    if (!row) return; // 404 already sent
  } catch (err) {
    console.error('[generate.cancel] load failed:', err);
    return res.status(500).json({ error: 'SERVER_ERROR', message: 'বাতিল করা যায়নি — পরে আবার চেষ্টা করুন।' });
  }
  if (TERMINAL_STATUSES.includes(row.status)) {
    return res.status(409).json({
      error: 'ALREADY_TERMINAL',
      message: `এই জেনারেশনটি ইতিমধ্যে ${row.status} — আর বাতিল করা যাবে না।`,
      generation: publicGeneration(row),
    });
  }

  // Never reached the provider: cancel locally + refund once.
  if (!row.higgsfield_request_id && !row.higgsfield_status_url) {
    try {
      const updated = await db.withTransaction(async (client) => {
        const r = await client.query(
          `UPDATE generations SET status = 'canceled' WHERE id = $1 RETURNING *`, [row.id]
        );
        const out = await _refundOnce(client, r.rows[0]);
        return { gen: r.rows[0], refunded: out.refunded === true };
      });
      return res.json({ message: 'বাতিল হয়েছে — ক্রেডিট ফেরত দেওয়া হয়েছে।', generation: publicGeneration(updated.gen), refunded: updated.refunded });
    } catch (err) {
      console.error('[generate.cancel] local cancel failed:', err);
      return res.status(500).json({ error: 'SERVER_ERROR', message: 'বাতিল করা যায়নি — পরে আবার চেষ্টা করুন।' });
    }
  }

  try {
    await higgsfield.cancelJob(row.higgsfield_status_url || row.higgsfield_request_id);
  } catch (err) {
    if (err.code === 'HIGGSFIELD_NOT_CONFIGURED' || err.status === 503) {
      return res.status(503).json({ error: 'HIGGSFIELD_NOT_CONFIGURED', message: 'Higgsfield সংযুক্ত হয়নি — বাতিল করা যাচ্ছে না। জেনারেশনটি চলমানই আছে।', generation: publicGeneration(row) });
    }
    return res.status(502).json({ error: 'HIGGSFIELD_ERROR', message: 'Higgsfield-এ বাতিল করা যায়নি — পরে আবার চেষ্টা করুন।', detail: _truncateError(err, 200), generation: publicGeneration(row) });
  }

  try {
    const updated = await db.withTransaction(async (client) => {
      const r = await client.query(
        `UPDATE generations SET status = 'canceled' WHERE id = $1 RETURNING *`, [row.id]
      );
      const out = await _refundOnce(client, r.rows[0]);
      return { gen: r.rows[0], refunded: out.refunded === true };
    });
    return res.json({ message: 'বাতিল হয়েছে — ক্রেডিট ফেরত দেওয়া হয়েছে।', generation: publicGeneration(updated.gen), refunded: updated.refunded });
  } catch (err) {
    console.error('[generate.cancel] mark canceled failed:', err);
    return res.status(500).json({ error: 'SERVER_ERROR', message: 'Higgsfield-এ বাতিল হয়েছে, কিন্তু সার্ভারে সংরক্ষণ করা যায়নি — সাপোর্টে জানান।' });
  }
}

// ---------- POST /api/upload-reference ----------
// No multipart parser, no storage: JSON metadata only, validated,
// then an honest 501 — Supabase Storage is not configured.
async function uploadReference(req, res) {
  if (!req.user) return unauthorized(res);
  const check = validateUploadReference(req.body);
  if (!check.ok) {
    return res.status(400).json({ error: check.error, message: check.message });
  }
  return res.status(501).json({
    error: 'STORAGE_NOT_CONFIGURED',
    message: 'রেফারেন্স ফাইল আপলোড এখনো চালু হয়নি — Supabase Storage সংযুক্ত হয়নি। ফাইলটি আপলোড হয়নি। Image-to-Video-র জন্য আপাতত হোস্ট করা ছবির URL (input_url) ব্যবহার করুন।',
    filename: check.filename,
    content_type: check.contentType,
    size_bytes: check.sizeBytes,
    docs: 'https://supabase.com/docs/guides/storage',
  });
}

module.exports = {
  estimateCost,
  buildIdempotencyKey,
  refundKeyFor,
  submitGeneration,
  checkStatus,
  cancelGeneration,
  uploadReference,
  generateRateLimiter,
  uploadRateLimiter,
  // exported for isolated tests (no DB needed):
  _test: {
    validatePrompt,
    validateUploadReference,
    watermarkRequiredForUser,
    normalizeHiggsfieldStatus,
    MAX_PROMPT_CHARS,
    MAX_UPLOAD_BYTES,
    ALLOWED_UPLOAD_TYPES,
    VALID_TYPES,
    TERMINAL_STATUSES,
  },
};
