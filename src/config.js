import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const DEFAULT_ENV = '.env';
const envPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', DEFAULT_ENV);

loadEnvFile(envPath);

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  const content = fs.readFileSync(file, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

function int(name, fallback) {
  const raw = process.env[name];
  const parsed = raw === undefined ? NaN : Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const config = {
  port: int('PORT', 3000),
  databaseUrl: process.env.DATABASE_URL || 'postgres://postgres@127.0.0.1:5432/jobsdb',

  concurrency: int('CONCURRENCY', 4),
  maxAttempts: int('MAX_ATTEMPTS', 3),
  baseBackoffMs: int('BASE_BACKOFF_MS', 1000),
  maxBackoffMs: int('MAX_BACKOFF_MS', 5 * 60 * 1000),
  maxJitterMs: int('MAX_JITTER_MS', 1000),

  stuckTimeoutMs: int('STUCK_TIMEOUT_MS', 60_000),
  sweepIntervalMs: int('SWEEP_INTERVAL_MS', 10_000),

  pollIntervalMs: int('POLL_INTERVAL_MS', 200),
  outputDir: process.env.OUTPUT_DIR || './outputs',
};