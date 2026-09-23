// Enqueues several jobs against a running API to demonstrate the system.
// Usage: node src/demo.js   (start `npm start` and `npm run worker` first)
const BASE = process.env.API_URL || 'http://localhost:3000';

async function enqueue(type, payload, idempotencyKey) {
  const res = await fetch(`${BASE}/api/jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type, payload, idempotencyKey }),
  });
  const body = await res.json();
  return { http: res.status, ...body };
}

async function poll(id, maxWaitMs = 30_000) {
  const started = Date.now();
  while (Date.now() - started < maxWaitMs) {
    const res = await fetch(`${BASE}/api/jobs/${id}`);
    const { job } = await res.json();
    if (job.status !== 'pending' && job.status !== 'processing') return job;
    await new Promise((r) => setTimeout(r, 300));
  }
  return null;
}

const key = (s) => `demo-${s}-${Date.now()}`;

const results = {};

// 1. Happy path — succeeds on first try.
{
  const r = await enqueue('echo', { echo: 'hello world' }, key('hello'));
  results.hello = r;
  const job = await poll(r.job.id);
  results.hello.final = job;
}

// 2. Idempotent duplicate — same key returns the existing job (200).
{
  const k = key('dup');
  const first = await enqueue('echo', { echo: 'once' }, k);
  const second = await enqueue('echo', { echo: 'once' }, k);
  results.idempotent = { firstHttp: first.http, secondHttp: second.http, sameId: first.job.id === second.job.id };
}

// 3. Unreliable job — 60% fail rate, will back off and eventually die.
{
  const r = await enqueue('echo', { failRate: 0.6, delayMs: 800, message: 'flaky' }, key('flaky'));
  results.flaky = r;
  const job = await poll(r.job.id, 40_000);
  results.flaky.final = job;
}

console.log(JSON.stringify(results, null, 2));