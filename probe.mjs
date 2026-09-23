import { pool } from './src/db.js';

const id = process.argv[2];
const reset = process.argv[3] === 'reset';

if (reset && id) {
  const r = await pool.query(
    `UPDATE jobs SET status='pending', attempts=0, run_at=now()
     WHERE id=$1
     RETURNING id, type, payload, attempts, max_attempts, run_at`,
    [id],
  );
  const row = r.rows[0];
  console.log('claim-row keys:', Object.keys(row || {}).join(','));
  console.log('max_attempts:', row?.max_attempts, typeof row?.max_attempts);
} else if (id) {
  const r = await pool.query(
    'SELECT id, status, attempts, max_attempts, run_at, started_at, finished_at, last_error FROM jobs WHERE id=$1',
    [id],
  );
  console.log(JSON.stringify(r.rows[0], null, 2));
} else {
  const r = await pool.query(
    "SELECT id, type, status, attempts, max_attempts, run_at, started_at, finished_at FROM jobs ORDER BY run_at DESC LIMIT 10",
  );
  console.table(r.rows);
}

await pool.end();
