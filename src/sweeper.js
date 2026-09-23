import { config } from './config.js';
import { pool } from './db.js';
import { backoffDelayMs, nowPlusMs } from './backoff.js';

const STUCK_SELECT_SQL = `
  SELECT id, attempts, max_attempts
  FROM jobs
  WHERE status = 'processing'
    AND started_at <= now() - make_interval(secs => $1)
  ORDER BY started_at
  FOR UPDATE SKIP LOCKED
`;

const SWEEP_SQL = `
  UPDATE jobs
  SET attempts     = $2,
      last_error   = $3,
      started_at   = NULL,
      run_at       = CASE WHEN $4 = 'dead' THEN run_at ELSE $5 END,
      finished_at  = CASE WHEN $4 = 'dead' THEN now() ELSE finished_at END,
      status       = $4
  WHERE id = $1
`;

function sweepOne(client, id, attempts, maxAttempts) {
  const nextAttempts = attempts + 1;
  const status = nextAttempts >= maxAttempts ? 'dead' : 'pending';
  const runAt = status === 'dead' ? null : nowPlusMs(backoffDelayMs(nextAttempts));
  const message = `swept: stuck in 'processing' beyond ${config.stuckTimeoutMs}ms timeout (attempt ${nextAttempts}/${maxAttempts})`;
  return client.query(SWEEP_SQL, [id, nextAttempts, message, status, runAt]);
}

export async function sweepStuckJobs() {
  const timeoutSec = config.stuckTimeoutMs / 1000;
  const client = await pool.connect();
  let swept = 0;
  try {
    // Select + reset inside one transaction so the FOR UPDATE SKIP LOCKED
    // locks stay held for the whole sweep and two sweepers never both
    // increment the same stuck job.
    await client.query('BEGIN');
    const { rows } = await client.query(STUCK_SELECT_SQL, [timeoutSec]);
    for (const row of rows) {
      try {
        await sweepOne(client, row.id, row.attempts, row.max_attempts);
        swept += 1;
        console.log(`[sweeper] requeued ${row.id} (attempt ${row.attempts + 1}/${row.max_attempts})`);
      } catch (err) {
        console.error(`[sweeper] could not sweep ${row.id}:`, err.message);
      }
    }
    await client.query('COMMIT');
    return swept;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export function startSweeper() {
  let timer;
  const run = () =>
    sweepStuckJobs().catch((err) => console.error('[sweeper] error:', err.message));

  timer = setInterval(run, config.sweepIntervalMs);
  timer.unref();
  run();
}