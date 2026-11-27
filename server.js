// ============================================================
// Suman AI Studio — v1.0.0-beta (code-complete, deployment pending)
// Node.js + Express monolith. Static frontend + JSON API.
// Phase 1: scaffold, health, model registry, Higgsfield module.
// Phase 2: migration runner + seed data.
// Phase 3: dashboard / login / register / generate pages.
// Phase 4: auth — register/login/logout/forgot/reset/me, JWT,
//   role middleware, rate limiting, audit log. Google OAuth in
//   server/google-oauth.js (501 while GOOGLE_CLIENT_ID/SECRET unset).
// Phase 5: My Creations — list/detail/download/delete, 30-day
//   retention + expiring-soon warnings, own-files-only.
// Phase 6: credits ledger + manual bKash/Nagad payments — amounts
//   always from the server-side packages table, never the browser.
// Phase 7: admin dashboard — users, credits, packages, payments,
//   models, content, gallery moderation, analytics, settings.
// Phase 8: Higgsfield generation flow — submit/status/cancel, credit
//   deduction in the same transaction as the job row, one-time refund
//   on failure, watermark flag for free users, Storage signed-upload.
// Phase 9: gallery, referrals, notifications, support, templates.
// Phase 10: security helpers + self-audit endpoint + testing docs.
// Phase 11: static caching, mobile/viewport audit.
// Phase 12: deployment prep — README, checklist, env template.
// Nothing here pretends to be connected: health reports the real
// state; DB routes without DATABASE_URL return honest 503.
// ============================================================
require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const path = require('path');

const higgsfield = require('./server/higgsfield');
const db = require('./server/db');
const auth = require('./server/auth');
const googleOAuth = require('./server/google-oauth');
const creations = require('./server/creations');
const payments = require('./server/payments');
const admin = require('./server/admin');
const generate = require('./server/generate');
const gallery = require('./server/gallery');
const referrals = require('./server/referrals');
const notifications = require('./server/notifications');
const support = require('./server/support');
const templates = require('./server/templates');
const security = require('./server/security');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(helmet({ contentSecurityPolicy: false })); // Tailwind CDN needs relaxed CSP in scaffold
app.use(cors());
app.use(express.json({ limit: '1mb' }));
// Phase 11 — static caching: HTML never cached long (fresh deploys
// must show immediately); images/css/js may cache 1 day.
app.use(express.static(path.join(__dirname, 'public'), {
  etag: true,
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache');
    } else {
      res.setHeader('Cache-Control', 'public, max-age=86400');
    }
  },
}));

// Basic abuse protection (tightened in Phase 10)
app.use('/api/', rateLimit({ windowMs: 60 * 1000, max: 120, standardHeaders: true }));

// ---------- Health ----------
app.get('/api/health', async (req, res) => {
  const database = await db.dbHealth();
  res.json({
    ok: true,
    app: 'suman-ai-studio',
    version: '1.0.0-beta',
    phase: 'All 12 phases — code-complete, deployment pending',
    time: new Date().toISOString(),
    database,
    higgsfield: higgsfield.isConfigured()
      ? { status: 'configured', base_url: higgsfield.BASE_URL }
      : { status: 'not_configured', detail: 'HIGGSFIELD_API_KEY is not set — generation is unavailable until the owner adds a key (see README)' },
  });
});

// ---------- Model registry (public: only enabled + verified models) ----------
app.get('/api/models', (req, res) => {
  const models = higgsfield.loadModels()
    .filter((m) => m.enabled && m.verified)
    .map((m) => ({ id: m.id, name: m.name, type: m.type, credit_cost: m.credit_cost }));
  res.json({ models, higgsfield_configured: higgsfield.isConfigured() });
});

// ---------- Higgsfield status (honest 503 when not configured) ----------
app.get('/api/higgsfield/status', (req, res) => {
  if (!higgsfield.isConfigured()) {
    return res.status(503).json({
      error: 'HIGGSFIELD_NOT_CONFIGURED',
      message: 'Higgsfield API key is not set. Generation is unavailable. Owner: add HIGGSFIELD_API_KEY in Render Environment (see README ধাপ ৪).',
      docs: 'https://docs.higgsfield.ai/docs/index',
      console: 'https://open.higgsfield.ai/',
    });
  }
  res.json({ status: 'configured', base_url: higgsfield.BASE_URL, models: higgsfield.loadModels().length });
});

// ---------- Auth (Phase 4) ----------
app.post('/api/auth/register', auth.authRateLimiter, auth.register);
app.post('/api/auth/login', auth.authRateLimiter, auth.login);
app.post('/api/auth/logout', auth.logout);
app.post('/api/auth/forgot-password', auth.authRateLimiter, auth.forgotPassword);
app.post('/api/auth/reset-password', auth.authRateLimiter, auth.resetPassword);
app.get('/api/auth/me', auth.requireAuth, auth.me);

// Google OAuth — real code flow (server/google-oauth.js). While
// GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are unset it honestly
// answers 501 GOOGLE_OAUTH_NOT_CONFIGURED, never a fake login.
app.get('/api/auth/google', auth.authRateLimiter, googleOAuth.startGoogleAuth);
app.get('/api/auth/google/callback', auth.authRateLimiter, googleOAuth.handleGoogleCallback);

// ---------- Packages & payment instructions (Phase 6) ----------
app.get('/api/packages', payments.getPackages); // public — DB needed, else honest 503
app.get('/api/payment-instructions', auth.requireAuth, payments.getPaymentInstructions);
app.post('/api/payments', auth.requireAuth, payments.paymentRateLimiter, payments.createPayment);
app.get('/api/payments', auth.requireAuth, payments.listMyPayments);
app.get('/api/payments/:id', auth.requireAuth, payments.getMyPayment);

// ---------- Credits ledger — my own history (Phase 6) ----------
app.get('/api/credits', auth.requireAuth, payments.getMyLedger);

// ---------- My Creations (Phase 5) ----------
app.get('/api/creations', auth.requireAuth, creations.listCreations);
app.get('/api/creations/:id', auth.requireAuth, creations.getCreation);
app.get('/api/creations/:id/download', auth.requireAuth, creations.downloadCreation);
app.delete('/api/creations/:id', auth.requireAuth, creations.deleteCreation);
app.get('/api/subscription/me', auth.requireAuth, creations.getMySubscription);

// ---------- Admin (Phase 7) ----------
const requireAdmin = [auth.requireAuth, auth.requireRole('admin', 'super_admin')];
const requireMod = [auth.requireAuth, auth.requireRole('moderator', 'admin', 'super_admin')];

app.get('/api/admin/analytics', requireAdmin, admin.getAnalytics);
app.get('/api/admin/users', requireAdmin, admin.listUsers);
app.get('/api/admin/users/:id', requireAdmin, admin.getUser);
app.post('/api/admin/users/:id/status', requireAdmin, admin.setUserStatus);
app.post('/api/admin/users/:id/role', requireAdmin, admin.setUserRole); // handler enforces super_admin
app.post('/api/admin/users/:id/credits', requireAdmin, admin.adjustCredits);
app.get('/api/admin/packages', requireAdmin, admin.listPackagesAdmin);
app.post('/api/admin/packages', requireAdmin, admin.createPackage);
app.put('/api/admin/packages/:id', requireAdmin, admin.updatePackage);
app.get('/api/admin/payments', requireAdmin, admin.listPaymentsAdmin);
app.post('/api/admin/payments/:id/:decision', requireAdmin, admin.reviewPayment);
app.get('/api/admin/models', requireAdmin, admin.listModelsAdmin);
// Model ids contain slashes — wildcard route, id in req.params[0].
app.put('/api/admin/models/*', requireAdmin, admin.updateModel);
app.get('/api/admin/content/:kind', requireAdmin, admin.listContent);
app.post('/api/admin/content/:kind', requireAdmin, admin.createContent);
app.delete('/api/admin/content/:kind/:id', requireAdmin, admin.deleteContent);
app.get('/api/admin/settings', requireAdmin, admin.getSettingsAdmin);
app.put('/api/admin/settings/:key', requireAdmin, admin.updateSetting);
// Phase 10 — security self-audit (admin only, live config, honest).
app.get('/api/admin/security', requireAdmin, (req, res) => res.json(security.securityAudit()));
// Gallery moderation — moderators included.
app.get('/api/admin/reports', requireMod, admin.listReported);
app.post('/api/admin/gallery/:id/moderate', requireMod, admin.moderateGalleryItem);
app.post('/api/admin/reports/:id/resolve', requireMod, admin.resolveReport);

// ---------- Gallery (Phase 9) — public list; actions need login ----------
app.post('/api/gallery/publish', auth.requireAuth, gallery.publishToGallery);
app.get('/api/gallery', gallery.listGallery);
app.post('/api/gallery/:id/like', auth.requireAuth, gallery.likeGallery);
app.get('/api/gallery/:id/comments', gallery.listGalleryComments);
app.post('/api/gallery/:id/comments', auth.requireAuth, gallery.commentGallery);
app.post('/api/gallery/:id/report', auth.requireAuth, gallery.reportGallery);
// NOTE: gallery.listReported / resolveReport are NOT wired here —
// admin.js already wires its own versions on /api/admin/reports.

// ---------- Referrals (Phase 9) ----------
app.get('/api/referrals/me', auth.requireAuth, referrals.getReferralInfo);

// ---------- Notifications (Phase 9) ----------
app.get('/api/notifications', auth.requireAuth, notifications.listNotifications);
app.post('/api/notifications/:id/read', auth.requireAuth, notifications.markRead);

// ---------- Support / FAQ / announcements (Phase 9) ----------
app.post('/api/support/tickets', auth.requireAuth, support.createTicket);
app.get('/api/support/tickets', auth.requireAuth, support.listTickets);
app.get('/api/support/tickets/:id/replies', auth.requireAuth, support.listTicketReplies);
app.post('/api/support/tickets/:id/replies', auth.requireAuth, support.replyTicket);
app.get('/api/faqs', support.listFaqs);
app.get('/api/announcements', support.listAnnouncements);

// ---------- Templates (Phase 9, public) ----------
app.get('/api/templates', templates.listTemplates);
app.get('/api/templates/:id', templates.getTemplate);

// ---------- Generation (Phase 8) — Higgsfield flow, credits deducted first ----------
app.post('/api/generate', auth.requireAuth, generate.generateRateLimiter, generate.submitGeneration);
app.get('/api/generations/:id/status', auth.requireAuth, generate.checkStatus);
app.post('/api/generations/:id/cancel', auth.requireAuth, generate.cancelGeneration);
app.post('/api/upload-reference', auth.requireAuth, generate.uploadRateLimiter, generate.uploadReference);
app.post('/api/upload-reference/confirm', auth.requireAuth, generate.uploadRateLimiter, generate.confirmUploadReference);

app.use((req, res) => res.status(404).json({ error: 'NOT_FOUND', message: 'Route not found' }));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'SERVER_ERROR', message: 'Something went wrong' });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Suman AI Studio v1.0.0-beta running on port ${PORT}`);
    console.log(`Higgsfield: ${higgsfield.isConfigured() ? 'configured' : 'NOT CONFIGURED (generation unavailable)'}`);
    console.log(`Database: ${process.env.DATABASE_URL ? 'DATABASE_URL set' : 'NOT CONFIGURED (Supabase — see README)'}`);
    console.log(`JWT: ${process.env.JWT_SECRET ? 'JWT_SECRET set' : 'NOT CONFIGURED (auth will return 503 until set)'}`);
  });
}

module.exports = app;
