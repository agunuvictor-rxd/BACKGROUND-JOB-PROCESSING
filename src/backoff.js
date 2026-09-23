import { config, } from './config.js';

export function jitter() {
  return Math.floor(Math.random() * (config.maxJitterMs + 1));
}

/**
 * runAt = now + (base * 2^attempts) + randomJitter, capped for sanity.
 */
export function backoffDelayMs(attempts) {
  const exponential = config.baseBackoffMs * Math.pow(2, attempts);
  return Math.min(exponential, config.maxBackoffMs) + jitter();
}

export function nowPlusMs(ms) {
  return new Date(Date.now() + ms);
}

export function jsonifyError(err) {
  return `${err && err.message ? `${err.message}\n` : ''}${(err && err.stack) || String(err)}`;
}