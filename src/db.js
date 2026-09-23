import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { config } from './config.js';

const { Pool } = pg;
const schemaPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'schema.sql');

export const pool = new Pool({
  connectionString: config.databaseUrl,
  max: 10,
});

const SCHEMA_LOCK_KEY = 724_191;

export async function ensureSchema() {
  const client = await pool.connect();
  try {
    // Serialize DDL so two processes starting at once don't race
    // on CREATE EXTENSION / CREATE TABLE IF NOT EXISTS.
    await client.query('SELECT pg_advisory_lock($1)', [SCHEMA_LOCK_KEY]);
    const sql = fs.readFileSync(schemaPath, 'utf8');
    await client.query(sql);
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [SCHEMA_LOCK_KEY]).catch(() => {});
    client.release();
  }
}

export async function closePool() {
  await pool.end();
}

export function serializeJob(row) {
  return {
    id: row.id,
    type: row.type,
    payload: row.payload,
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    lastError: row.last_error,
    runAt: row.run_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    idempotencyKey: row.idempotency_key,
  };
}

// `npm run db:init` → node src/db.js --init-only
if (process.argv.includes('--init-only')) {
  ensureSchema()
    .then(() => {
      console.log('[db] schema ready');
      return closePool();
    })
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[db] schema init failed:', err);
      process.exit(1);
    });
}