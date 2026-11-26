// ============================================================
// Database layer — PostgreSQL (Supabase free tier) via `pg`.
// Phase 1: connection helper + health check only. Tables are created
// by db/migrations/001_init.sql (run once in Supabase SQL Editor).
// If DATABASE_URL is missing, the app still boots in "no-database"
// mode and /api/health reports db: "not_configured" honestly.
// ============================================================
const { Pool } = require('pg');

let pool = null;

function getPool() {
  if (pool) return pool;
  const url = (process.env.DATABASE_URL || '').trim();
  if (!url) return null;
  pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false }, max: 5 });
  pool.on('error', (err) => console.error('[db] pool error:', err.message));
  return pool;
}

async function dbHealth() {
  const p = getPool();
  if (!p) return { status: 'not_configured', detail: 'DATABASE_URL is not set (Supabase Postgres — see README ধাপ ৩)' };
  try {
    await p.query('SELECT 1');
    return { status: 'ok', detail: 'PostgreSQL reachable' };
  } catch (err) {
    return { status: 'error', detail: err.message };
  }
}

async function query(text, params) {
  const p = getPool();
  if (!p) throw new Error('DATABASE_URL is not set');
  return p.query(text, params);
}

// Run fn(client) inside a single transaction; rolls back on error.
// Used for register + starter-bonus ledger (must be atomic).
async function withTransaction(fn) {
  const p = getPool();
  if (!p) throw new Error('DATABASE_URL is not set');
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { getPool, dbHealth, query, withTransaction };
