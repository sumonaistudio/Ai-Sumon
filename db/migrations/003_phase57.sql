-- ============================================================
-- Suman AI Studio — Migration 003 (Phase 5)
-- Soft-delete for generations (My Creations): DELETE sets
-- deleted_at instead of removing the row, so the credit ledger
-- and audit trail still have their reference. Deleted rows are
-- excluded from every list (deleted_at IS NULL).
-- Safe to run twice (IF NOT EXISTS).
-- ============================================================

ALTER TABLE generations ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_gen_deleted ON generations(deleted_at) WHERE deleted_at IS NULL;

-- Backfill: generations created before this migration keep the
-- retention rule from settings (30 days) via expires_at computed
-- in code when expires_at IS NULL — no data change needed here.
