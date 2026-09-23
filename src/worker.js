import { config } from './config.js';
import { ensureSchema, pool } from './db.js';
import { executeJob, PermanentJobError } from './work.js';
import { backoffDelayMs, nowPlusMs, jsonifyError } from './backoff.js';

const N = config.concurrency;
const running = new Set();
let shuttingDown = false;

const CLAIM_SQL = `
  UPDATE jobs
  SET status = 'processing',
      started_at = now()
  WHERE id = (
    SELECT id
    FROM jobs
    WHERE status = 'pending'
      AND run_at <= now()
    ORDER BY run_at
    LIMIT 1
    FOR UPDATE SKIP LOCKED
  )
  RETURNING id, type, payload, attempts, max_attempts, run_at
`;

const SUCCEED_SQL = `
  UPDATE jobs
  SET status = 'succeeded', finished_at = now()
  WHERE id = $1
`;

const FAIL_SQL = `
  UPDATE jobs
  SET status = $2,
      attempts = $3,
      last_error = $4,
      finished_at = CASE WHEN $2 = 'pending' THEN finished_at ELSE now() END,
      run_at     = CASE WHEN $2 = 'pending' THEN $5 ELSE run_at END
  WHERE id = $1
`;

export async function claimOne() {
  const { rows } = await pool.query(CLAIM_SQL);
  return rows[0] || null;
}

async function markSucceeded(id) {
  await pool.query(SUCCEED_SQL, [id]);
}

async function recordFailure(job, error) {
  const attempts = job.attempts + 1;
  const maxAttempts = job.maxAttempts;
  let status;
  let runAt = null;

  if (error instanceof PermanentJobError) {
    status = 'failed';
  } else if (attempts >= maxAttempts) {
    status = 'dead';
  } else {
    status = 'pending';
    runAt = nowPlusMs(backoffDelayMs(attempts));
  }

  await pool.query(FAIL_SQL, [job.id, status, attempts, jsonifyError(error), runAt]);
}

async function processJob(row) {
  const job = {
    id: row.id,
    type: row.type,
    payload: row.payload,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
  };

  try {
    const result = await executeJob(job);
    await markSucceeded(job.id);
    console.log(`[worker] ok     ${job.id} (${job.type})${result.alreadyProduced ? ' [already produced, idempotent skip]' : ''}`);
  } catch (err) {
    await recordFailure(job, err);
    console.error(`[worker] failed ${job.id} (${job.type}) attempt ${job.attempts + 1}/${job.maxAttempts} — ${err.message}`);
  }
}

async function tick() {
  while (!shuttingDown && running.size < N) {
    let row;
    try {
      row = await claimOne();
    } catch (err) {
      console.error('[worker] claim error:', err.message);
      break;
    }
    if (!row) break;

    const task = processJob(row).finally(() => running.delete(task));
    running.add(task);
  }
}

export function startWorker() {
  console.log(`[worker] starting, concurrency cap N=${N}, poll=${config.pollIntervalMs}ms`);
  const timer = setInterval(tick, config.pollIntervalMs);
  timer.unref();
  tick().catch((err) => console.error('[worker] fatal tick error:', err));

  const shutdown = async () => {
    shuttingDown = true;
    clearInterval(timer);
    await Promise.allSettled([...running]);
    await pool.end();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function main() {
  await ensureSchema();
  startWorker();
}

main().catch((err) => {
  console.error('[worker] failed to start:', err);
  process.exit(1);
});