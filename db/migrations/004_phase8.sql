-- ============================================================
-- Suman AI Studio — Migration 004 (Phase 8)
-- Run after 001-003 (npm run migrate does 001 -> 004 in order).
-- Adds the watermark flag to generations so the Phase 8
-- watermark rule (free user -> watermark_required = TRUE,
-- active paid subscription / is_paid -> FALSE) persists.
-- Idempotent: safe to run more than once.
-- ============================================================

ALTER TABLE generations
  ADD COLUMN IF NOT EXISTS watermark_required BOOLEAN NOT NULL DEFAULT TRUE;
