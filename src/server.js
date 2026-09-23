import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { config } from './config.js';
import { ensureSchema, pool, serializeJob } from './db.js';
import { startSweeper } from './sweeper.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, '..', 'public');

const INSERT_SQL = `
  INSERT INTO jobs (type, payload, status, attempts, max_attempts, run_at, idempotency_key)
  VALUES ($1, $2, 'pending', 0, $3, $4, $5)
  ON CONFLICT (idempotency_key) DO NOTHING
  RETURNING *
`;

const SELECT_BY_KEY_SQL = `
  SELECT * FROM jobs WHERE idempotency_key = $1
`;

const SELECT_BY_ID_SQL = `
  SELECT * FROM jobs WHERE id = $1
`;

const LIST_SQL = `
  SELECT * FROM jobs
  WHERE ($1::text IS NULL OR status = $1)
  ORDER BY run_at DESC
  LIMIT $2
`;

const RETRY_SQL = `
  UPDATE jobs
  SET status        = 'pending',
      attempts      = 0,
      last_error    = NULL,
      run_at        = now(),
      started_at    = NULL,
      finished_at   = NULL
  WHERE id = $1 AND status IN ('dead', 'failed')
  RETURNING *
`;

const COUNTS_SQL = `
  SELECT status, COUNT(*)::int AS count
  FROM jobs
  GROUP BY status
`;

function validateKey(key) {
  return typeof key === 'string' && key.length > 0 && key.length <= 255;
}

function validateType(type) {
  return typeof type === 'string' && type.length > 0 && type.length <= 128;
}

export function createApp() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.get('/', (_req, res) => res.sendFile(path.join(publicDir, 'dlq.html')));

  // Enqueue a job: validates idempotencyKey, writes a pending row,
  // returns the existing job if the key was already used.
  app.post('/api/jobs', async (req, res) => {
    try {
      const { type, payload, idempotencyKey, runAt } = req.body ?? {};

      if (!validateKey(idempotencyKey)) {
        return res.status(400).json({ error: 'idempotencyKey is required (1-255 chars)' });
      }
      if (!validateType(type)) {
        return res.status(400).json({ error: 'type is required (1-128 chars)' });
      }
      if (payload !== undefined && (typeof payload !== 'object' || payload === null || Array.isArray(payload))) {
        return res.status(400).json({ error: 'payload must be a JSON object' });
      }

      const runAtDate = runAt ? new Date(runAt) : new Date();
      if (Number.isNaN(runAtDate.getTime())) {
        return res.status(400).json({ error: 'runAt must be a valid timestamp' });
      }

      const insert = await pool.query(INSERT_SQL, [
        type,
        JSON.stringify(payload ?? {}),
        config.maxAttempts,
        runAtDate,
        idempotencyKey,
      ]);

      if (insert.rows.length > 0) {
        const job = serializeJob(insert.rows[0]);
        return res.status(202).json({ job, message: 'accepted' });
      }

      const existing = await pool.query(SELECT_BY_KEY_SQL, [idempotencyKey]);
      const job = serializeJob(existing.rows[0]);
      return res.status(200).json({ job, message: 'idempotencyKey already used, returning existing job' });
    } catch (err) {
      console.error('[api] enqueue error:', err);
      return res.status(500).json({ error: 'failed to enqueue job' });
    }
  });

  // Per-status job counts (used by the DLQ UI dashboard).
  // Registered before /api/jobs/:id so "counts" is not treated as an id.
  app.get('/api/jobs/counts', async (_req, res) => {
    try {
      const { rows } = await pool.query(COUNTS_SQL);
      const counts = { pending: 0, processing: 0, succeeded: 0, failed: 0, dead: 0 };
      for (const row of rows) counts[row.status] = row.count;
      return res.json({ counts });
    } catch (err) {
      console.error('[api] counts error:', err);
      return res.status(500).json({ error: 'failed to count jobs' });
    }
  });

  // Status polling endpoint.
  app.get('/api/jobs/:id', async (req, res) => {
    try {
      const { rows } = await pool.query(SELECT_BY_ID_SQL, [req.params.id]);
      if (rows.length === 0) return res.status(404).json({ error: 'job not found' });
      return res.json({ job: serializeJob(rows[0]) });
    } catch (err) {
      console.error('[api] get job error:', err);
      return res.status(500).json({ error: 'failed to load job' });
    }
  });

  // DLQ listing: /api/jobs?status=dead&limit=50
  app.get('/api/jobs', async (req, res) => {
    try {
      const { status = null, limit = 50 } = req.query;
      const parsedLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 200);
      const parsedStatus = typeof status === 'string' && status.length > 0 ? status : null;
      const { rows } = await pool.query(LIST_SQL, [parsedStatus, parsedLimit]);
      return res.json({ jobs: rows.map(serializeJob) });
    } catch (err) {
      console.error('[api] list jobs error:', err);
      return res.status(500).json({ error: 'failed to list jobs' });
    }
  });

  // Manual retry from the DLQ.
  app.post('/api/jobs/:id/retry', async (req, res) => {
    try {
      const { rows } = await pool.query(RETRY_SQL, [req.params.id]);
      if (rows.length === 0) {
        return res.status(404).json({ error: 'job not found or not retryable (only dead/failed)' });
      }
      return res.json({ job: serializeJob(rows[0]), message: 'requeued' });
    } catch (err) {
      console.error('[api] retry error:', err);
      return res.status(500).json({ error: 'failed to retry job' });
    }
  });

  app.use('/public', express.static(publicDir));

  return app;
}

async function main() {
  await ensureSchema();
  startSweeper();
  const app = createApp();
  app.listen(config.port, () => {
    console.log(`[api] listening on http://localhost:${config.port}`);
    console.log(`[api] DLQ UI: http://localhost:${config.port}/`);
  });
}

main().catch((err) => {
  console.error('[api] failed to start:', err);
  process.exit(1);
});