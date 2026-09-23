import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';

export class PermanentJobError extends Error {
  constructor(message) {
    super(message);
    this.permanent = true;
  }
}

const RESERVED = new Set(['id', 'type', 'idempotencyKey']);

const registry = new Map();

export function register(type, handler) {
  if (registry.has(type)) {
    throw new Error(`Handler already registered for type "${type}"`);
  }
  registry.set(type, handler);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function outputPathFor(jobId) {
  return path.join(config.outputDir, `${jobId}.json`);
}

async function runBuiltIn(job) {
  const { delayMs = 1000, failRate = 0, message = null } = job.payload;
  await sleep(delayMs);
  if (failRate > 0 && Math.random() < failRate) {
    throw new Error(`simulated failure for job ${job.id}${message ? `: ${message}` : ''}`);
  }
  return { produced: true, message: message ?? `output for ${job.type}` };
}

/**
 * Executes a job idempotently: before doing any work it checks whether the
 * output already exists on disk, keyed by the job ID. If it does, the job is
 * considered already produced and no work is performed.
 */
export async function executeJob(job) {
  const outputPath = outputPathFor(job.id);

  if (fs.existsSync(outputPath)) {
    const existing = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
    return { alreadyProduced: true, outputPath, ...existing };
  }

  const handler = registry.get(job.type) || runBuiltIn;
  const result = await handler(job);

  await fsp.mkdir(config.outputDir, { recursive: true });
  await fsp.writeFile(
    outputPath,
    JSON.stringify({
      jobId: job.id,
      type: job.type,
      keyedBy: 'job id',
      producedAt: new Date().toISOString(),
      ...result,
    }, null, 2),
  );

  return { alreadyProduced: false, outputPath, ...result };
}

// --- built-in handlers -------------------------------------------------------

register('echo', async (job) => {
  const keys = Object.keys(job.payload).filter((k) => !RESERVED.has(k));
  const echoed = {};
  for (const key of keys) echoed[key] = job.payload[key];
  return { echoed };
});