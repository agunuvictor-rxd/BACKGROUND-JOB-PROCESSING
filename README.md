# Background Job Processing System

An asynchronous background job processing system that offloads slow or
unreliable work. It provides an enqueue API, a separate worker process with
atomic job claiming, exponential backoff with jitter, stuck-job recovery, and
a dead-letter queue (DLQ) UI with manual retry.

Built with Node.js, Express, and PostgreSQL.

## Architecture

```
                 HTTP 202 + job id
  ┌─────────┐ ───────────────────► ┌──────────────────┐
  │ client  │   POST /api/jobs      │  API server       │  Front door only: validates,
  └─────────┘ ◄─────────────────── │  (server.js)      │  writes a 'pending' row, never
                                   └──────────────────┘   waits for execution.
                                            │
  ┌─────────┐  atomic claim      ┌─────────▼─────────┐  fail → backoff → dead
  │ worker  │ ◄─ FOR UPDATE SKIP │      jobs DB       │  (workers/jobs)
  │ (separate process)          └────────────────────┘
  └─────────┘
                                   ┌──────────────────┐
  ┌─────────┐  sweep stuck jobs    │  sweeper          │
  └─────────┘  (runs inside API)  └──────────────────┘
```

- **API server** (`npm start`): enqueue, status polling, DLQ listing/retry, DLQ UI, and the sweeper.
- **Worker** (`npm run worker`): a **separate background process** that claims and executes jobs.
- **PostgreSQL**: single source of truth for job state; claiming is atomic via `FOR UPDATE SKIP LOCKED`.

## Prerequisites

- Node.js >= 18
- PostgreSQL (>= 12 for `FOR UPDATE SKIP LOCKED` and JSONB)

## Setup

```bash
npm install
cp .env.example .env      # edit DATABASE_URL to point at your Postgres
npm run db:init           # optional: inits schema (also auto-runs at startup)
```

The schema is created automatically on first startup of the API or worker
(startup DDL is serialized behind a Postgres advisory lock so multiple
processes never race on `CREATE EXTENSION`/`CREATE TABLE`).

## Configuration (.env)

| Variable            | Default             | Description                                                      |
| ------------------- | ------------------- | ---------------------------------------------------------------- |
| `PORT`              | `3000`              | API server port (DLQ UI + REST).                                 |
| `DATABASE_URL`      | `postgres://...`    | Postgres connection string.                                      |
| `CONCURRENCY`       | `4`                 | `N` — max jobs a worker processes simultaneously.                |
| `MAX_ATTEMPTS`      | `3`                 | Retries before a job moves to `dead`.                            |
| `BASE_BACKOFF_MS`   | `1000`              | Backoff base.                                                    |
| `MAX_BACKOFF_MS`    | `300000`            | Ceiling on the exponential backoff.                              |
| `MAX_JITTER_MS`     | `1000`              | Random jitter added to each backoff.                             |
| `STUCK_TIMEOUT_MS`  | `60000`             | `processing` jobs older than this are swept.                     |
| `SWEEP_INTERVAL_MS` | `10000`             | Sweeper scan interval.                                           |
| `POLL_INTERVAL_MS`  | `200`               | Worker claim-loop poll interval.                                 |
| `OUTPUT_DIR`        | `./outputs`         | Idempotent job output directory.                                 |

## Running

Terminal 1 — API server + sweeper + DLQ UI:

```bash
npm start
```

Terminal 2 — worker(s). Run as many as you like; each is capped at
`CONCURRENCY` in-flight jobs and claims atomically, so they never double-run
a job:

```bash
npm run worker
```

All config can be overridden with environment variables, e.g.:
`CONCURRENCY=8 npm run worker`.

## Database schema (`src/schema.sql`)

```sql
jobs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type            TEXT        NOT NULL,
  payload         JSONB       NOT NULL DEFAULT '{}',
  status          TEXT        NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','processing','succeeded','failed','dead')),
  attempts        INTEGER     NOT NULL DEFAULT 0,
  max_attempts    INTEGER     NOT NULL,        -- from config at enqueue time
  last_error      TEXT,
  run_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at      TIMESTAMPTZ,
  finished_at     TIMESTAMPTZ,
  idempotency_key TEXT        NOT NULL UNIQUE
)
```

Indexes exist for claiming (`pending, run_at`), stuck-job detection
(`processing, started_at`), and DLQ listing (`dead`).

## API

| Method | Path                     | Description                                                                  |
| ------ | ------------------------ | ---------------------------------------------------------------------------- |
| POST   | `/api/jobs`              | Enqueue a job. Returns **202** + job id without waiting. If `idempotencyKey` already exists, returns the existing job (200). |
| GET    | `/api/jobs/:id`          | Status polling endpoint — job, status, attempts, timestamps, error.           |
| GET    | `/api/jobs/counts`       | Per-status job counts (DLQ dashboard).                                        |
| GET    | `/api/jobs?status=dead`  | List jobs by status (used by the DLQ UI).                                     |
| POST   | `/api/jobs/:id/retry`    | Manually requeue a `dead`/`failed` job back to `pending` (resets attempts).   |
| GET    | `/`                      | Dead Letter Queue UI.                                                         |

### Enqueueing a job

```bash
curl -X POST http://localhost:3000/api/jobs \
  -H "content-type: application/json" \
  -d '{"type":"echo","payload":{"echo":"hello"},"idempotencyKey":"my-unique-key-1"}'
```

→ `202 Accepted` with `{ "job": { "id": "...", "status": "pending", ... } }`.

Resending the same `idempotencyKey` returns the already-existing job with
HTTP 200 instead of creating a duplicate.

Required fields: `type` (string), `idempotencyKey` (string). Optional:
`payload` (JSON object), `runAt` (timestamp — job is not claimable until then).

### Status polling

```bash
curl http://localhost:3000/api/jobs/<job-id>
```

## Worker behavior

1. Claims pending jobs whose `run_at` is in the past, honoring a concurrency
   cap `N` read from config.
2. Claiming is a single atomic statement — `UPDATE ... WHERE id = (SELECT ...
   FOR UPDATE SKIP LOCKED) RETURNING *` — so two workers never claim the same
   job.
3. **Exponential backoff + jitter** on failure: increments `attempts`, records
   `last_error`, and requeues with `run_at = now + base * 2^attempts + jitter`.
   When `attempts >= maxAttempts` the job is marked `dead`.
4. **Work idempotency**: before producing anything the executor checks whether
   the output already exists on disk, keyed by job id (`outputs/<job-id>.json`).
   If present, the job is marked succeeded without redoing the work.

A handler may throw `PermanentJobError` to be marked `failed` immediately
(no retry/backoff).

## Stuck job recovery (sweeper)

Runs inside the API server. Every `SWEEP_INTERVAL_MS` it finds jobs stuck in
`processing` for longer than `STUCK_TIMEOUT_MS` and resets them to `pending`
with an incremented attempt count (and backoff). If that pushes attempts past
`maxAttempts`, the job is moved to `dead`.

## Dead Letter Queue (DLQ)

Open `http://localhost:3000/`. The UI lists `dead` jobs with their payload
and full error log, shows queue status counts, exposes a manual **Retry**
button per job, and supports auto-refresh.

## Demo

With the API and worker running run the command:

```bash
npm run demo
```

Enqueues a happy-path job, verifies idempotent duplicate submission, and a
flaky job (60% fail rate) that backs off and eventually lands in the DLQ.
