-- ============================================================
-- Suman AI Studio — Migration 005 (Phase 9)
-- Run after 001-004 (npm run migrate does 001 -> 005 in order).
-- 1) gallery_items.is_demo — lets the landing page show a true
--    demo-only gallery (?demo=true). Without this column the
--    gallery code degrades to the full public list (never private).
-- 2) support_ticket_replies — ticket replies. Without this table
--    replyTicket answers 501 SUPPORT_REPLIES_NOT_MIGRATED.
-- Idempotent: safe to run more than once.
-- ============================================================

ALTER TABLE gallery_items
  ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS support_ticket_replies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id UUID NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ticket_replies_ticket
  ON support_ticket_replies(ticket_id, created_at ASC);
