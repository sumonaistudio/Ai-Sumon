// ============================================================
// Suman AI Studio — Migration runner
// Usage:  npm run migrate   (needs DATABASE_URL in .env / env)
// Runs db/migrations/001_init.sql then 002_seed.sql, in order.
// Honest behaviour: if DATABASE_URL is missing or the DB is
// unreachable, it prints a clear error and exits non-zero —
// it NEVER prints a fake "success".
// ============================================================
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const MIGRATIONS = ['001_init.sql', '002_seed.sql', '003_phase57.sql', '004_phase8.sql', '005_phase9.sql'];

async function main() {
  const url = (process.env.DATABASE_URL || '').trim();
  if (!url) {
    console.error('[migrate] FAILED — DATABASE_URL is not set.');
    console.error('[migrate] Supabase-এ প্রজেক্ট বানিয়ে Settings → Database থেকে');
    console.error('[migrate] connection string নিয়ে .env-এ DATABASE_URL= বসান (README ধাপ ২)।');
    console.error('[migrate] No migration was run. Nothing was changed.');
    process.exitCode = 1;
    return;
  }
  const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  try {
    await client.connect();
    console.log('[migrate] Connected to PostgreSQL.');
  } catch (err) {
    console.error('[migrate] FAILED — could not connect to database:', err.message);
    console.error('[migrate] DATABASE_URL-টি ঠিক আছে কি না, Supabase প্রজেক্ট pause হয়ে আছে কি না — দেখুন।');
    console.error('[migrate] No migration was run.');
    process.exitCode = 1;
    return;
  }
  try {
    for (const file of MIGRATIONS) {
      const full = path.join(__dirname, 'migrations', file);
      const sql = fs.readFileSync(full, 'utf8');
      console.log(`[migrate] Running ${file} ...`);
      await client.query(sql);
      console.log(`[migrate] OK — ${file}`);
    }
    console.log('[migrate] All migrations completed successfully.');
  } catch (err) {
    console.error('[migrate] FAILED during migration:', err.message);
    console.error('[migrate] The migration that failed may have partially applied — check Supabase SQL Editor / logs.');
    process.exitCode = 1;
  } finally {
    await client.end().catch(() => {});
  }
}

if (require.main === module) main();
module.exports = { main };
