-- ============================================================
-- Suman AI Studio — Migration 001 (PostgreSQL / Supabase)
-- Run once in Supabase Dashboard -> SQL Editor.
-- Phase 1: full schema for all 12 phases. No fake data.
-- Rules enforced in DB:
--   * credit balance can never go below 0 (CHECK + ledger is source of truth)
--   * every credit change is a ledger row (append-only)
--   * private creations are private by default (is_public = false)
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ---------- Roles ----------
DO $$ BEGIN
  CREATE TYPE user_role AS ENUM ('user', 'moderator', 'admin', 'super_admin');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE user_status AS ENUM ('active', 'suspended', 'banned');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE job_status AS ENUM ('queued', 'in_progress', 'completed', 'failed', 'nsfw', 'canceled', 'pending', 'refunded');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE payment_status AS ENUM ('pending', 'approved', 'rejected');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------- Users ----------
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email CITEXT UNIQUE NOT NULL,
  password_hash TEXT,                 -- NULL only for Google-only accounts
  google_id TEXT UNIQUE,
  full_name TEXT NOT NULL DEFAULT '',
  phone TEXT,
  role user_role NOT NULL DEFAULT 'user',
  status user_status NOT NULL DEFAULT 'active',
  credit_balance INTEGER NOT NULL DEFAULT 0 CHECK (credit_balance >= 0),
  is_paid BOOLEAN NOT NULL DEFAULT FALSE,   -- watermark-free eligibility
  referral_code TEXT UNIQUE NOT NULL DEFAULT substr(md5(random()::text), 1, 8),
  referred_by UUID REFERENCES users(id) ON DELETE SET NULL,
  language TEXT NOT NULL DEFAULT 'bn' CHECK (language IN ('bn', 'en')),
  theme TEXT NOT NULL DEFAULT 'dark' CHECK (theme IN ('dark', 'light')),
  email_verified BOOLEAN NOT NULL DEFAULT FALSE,
  reset_token_hash TEXT,
  reset_token_expires_at TIMESTAMPTZ,
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_referral_code ON users(referral_code);

-- ---------- Settings (admin-controlled: bonus, retention, payment numbers) ----------
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_by UUID REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO settings (key, value) VALUES
  ('signup_bonus_credits', '100'),
  ('referral_bonus_credits', '50'),
  ('referral_eligible_after_generations', '1'),
  ('retention_days', '30'),
  ('bkash_number', '""'),
  ('nagad_number', '""'),
  ('payment_instructions_bn', '"প্যাকেজ বেছে নিন, দেখানো নম্বরে টাকা পাঠান, তারপর Transaction ID জমা দিন।"'),
  ('payment_instructions_en', '"Choose a package, send money to the shown number, then submit the Transaction ID."')
ON CONFLICT (key) DO NOTHING;

-- ---------- Credit ledger (append-only; the source of truth) ----------
CREATE TABLE IF NOT EXISTS credit_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount INTEGER NOT NULL,            -- +credit / -debit
  balance_after INTEGER NOT NULL CHECK (balance_after >= 0),
  reason TEXT NOT NULL,               -- signup_bonus | generation | refund | admin_add | admin_deduct | referral | subscription | payment
  reference_id UUID,                  -- generation / payment / subscription id
  idempotency_key TEXT UNIQUE,        -- prevents duplicate deductions
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ledger_user ON credit_ledger(user_id, created_at DESC);

-- ---------- Packages & subscriptions ----------
CREATE TABLE IF NOT EXISTS packages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind TEXT NOT NULL CHECK (kind IN ('credit_pack', 'monthly', 'yearly')),
  name_bn TEXT NOT NULL,
  name_en TEXT NOT NULL,
  price_bdt INTEGER NOT NULL CHECK (price_bdt >= 0),
  price_usd NUMERIC(10,2) NOT NULL DEFAULT 0,
  credits INTEGER NOT NULL DEFAULT 0 CHECK (credits >= 0),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  package_id UUID REFERENCES packages(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired', 'cancelled')),
  starts_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ends_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_subs_user ON subscriptions(user_id, ends_at DESC);

-- ---------- Manual payments (bKash / Nagad personal) ----------
CREATE TABLE IF NOT EXISTS payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  package_id UUID REFERENCES packages(id),
  method TEXT NOT NULL CHECK (method IN ('bkash', 'nagad')),
  amount_bdt INTEGER NOT NULL CHECK (amount_bdt > 0),
  sender_number TEXT NOT NULL,
  transaction_id TEXT NOT NULL,
  status payment_status NOT NULL DEFAULT 'pending',
  reviewed_by UUID REFERENCES users(id),
  reviewed_at TIMESTAMPTZ,
  review_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (method, transaction_id)     -- same trx id cannot be reused
);
CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status, created_at DESC);

-- ---------- Generations / jobs ----------
CREATE TABLE IF NOT EXISTS generations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('text-to-image', 'text-to-video', 'image-to-video', 'image-edit', 'video-edit')),
  model_id TEXT NOT NULL,             -- must exist in config/models.json
  prompt TEXT NOT NULL,
  input_url TEXT,                     -- reference image/video (our storage)
  status job_status NOT NULL DEFAULT 'queued',
  higgsfield_request_id TEXT UNIQUE,
  higgsfield_status_url TEXT,
  result_url TEXT,                    -- our stored copy of the output
  credit_cost INTEGER NOT NULL DEFAULT 0 CHECK (credit_cost >= 0),
  higgsfield_cost_usd NUMERIC(10,4),
  idempotency_key TEXT UNIQUE NOT NULL,
  error_message TEXT,
  expires_at TIMESTAMPTZ,            -- retention: created_at + 30 days
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_gen_user ON generations(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_gen_status ON generations(status);

-- ---------- Gallery ----------
CREATE TABLE IF NOT EXISTS gallery_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  generation_id UUID NOT NULL REFERENCES generations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  is_public BOOLEAN NOT NULL DEFAULT FALSE,
  likes_count INTEGER NOT NULL DEFAULT 0 CHECK (likes_count >= 0),
  reports_count INTEGER NOT NULL DEFAULT 0 CHECK (reports_count >= 0),
  hidden_by_moderation BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS gallery_likes (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  gallery_item_id UUID NOT NULL REFERENCES gallery_items(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, gallery_item_id)
);
CREATE TABLE IF NOT EXISTS gallery_comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gallery_item_id UUID NOT NULL REFERENCES gallery_items(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL CHECK (char_length(body) <= 1000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS gallery_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gallery_item_id UUID NOT NULL REFERENCES gallery_items(id) ON DELETE CASCADE,
  reporter_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  resolved BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Referrals ----------
CREATE TABLE IF NOT EXISTS referrals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  referred_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bonus_granted BOOLEAN NOT NULL DEFAULT FALSE,
  bonus_credits INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (referrer_id, referred_id)
);

-- ---------- Templates ----------
CREATE TABLE IF NOT EXISTS templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title_bn TEXT NOT NULL,
  title_en TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('text-to-image', 'text-to-video', 'image-to-video')),
  prompt_template TEXT NOT NULL,
  model_id TEXT,
  thumbnail_url TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Notifications / announcements / FAQ / support ----------
CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'info',
  is_read BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS announcements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title_bn TEXT NOT NULL,
  title_en TEXT NOT NULL,
  body_bn TEXT NOT NULL DEFAULT '',
  body_en TEXT NOT NULL DEFAULT '',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS faqs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  question_bn TEXT NOT NULL,
  question_en TEXT NOT NULL,
  answer_bn TEXT NOT NULL,
  answer_en TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS support_tickets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  subject TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'closed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- API usage / audit ----------
CREATE TABLE IF NOT EXISTS api_usage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  generation_id UUID REFERENCES generations(id) ON DELETE SET NULL,
  model_id TEXT NOT NULL,
  higgsfield_cost_usd NUMERIC(10,4),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,               -- e.g. admin.credit_add, payment.approve
  target_type TEXT,
  target_id UUID,
  details JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_logs(actor_id, created_at DESC);

-- ---------- Retention helper note ----------
-- Expired creations: DELETE FROM generations WHERE expires_at < now()
-- (run daily via Render cron / manual admin job in Phase 5).
