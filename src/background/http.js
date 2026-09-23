// fetch with a timeout and one retry on transient failures.
//
// Every non-2xx logs the status, the URL and the first 300 chars of the body.
// This matters: a Serper 401 (bad key), 429 (out of credits) and 402 (DeepSeek
// insufficient balance) are indistinguishable from a generic failure without
// the body, and the body is what tells you which one you're looking at.

import { HTTP_RETRIES } from '../shared/constants.js';

const RETRY_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export class HttpError extends Error {
  constructor(status, url, body) {
    super(`HTTP ${status}`);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * @returns {Promise<any>} parsed JSON
 * @throws {HttpError} on non-2xx after retries
 * @throws {Error} on network failure / timeout
 */
export async function fetchJson(url, { method = 'GET', headers = {}, body, timeoutMs = 20000, retries = HTTP_RETRIES, label = 'http' } = {}) {
  let lastErr = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(300 * 2 ** (attempt - 1));

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method,
        headers,
        body: body == null ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
        signal: ctrl.signal,
      });
      clearTimeout(timer);

      const text = await res.text();

      if (!res.ok) {
        console.warn(`[JCE] ${label}`, res.status, url, text.slice(0, 300));
        const err = new HttpError(res.status, url, text.slice(0, 600));
        // Retry only transient statuses.
        if (RETRY_STATUS.has(res.status) && attempt < retries) {
          lastErr = err;
          continue;
        }
        throw err;
      }

      try {
        return JSON.parse(text);
      } catch {
        throw new HttpError(res.status, url, text.slice(0, 600));
      }
    } catch (e) {
      clearTimeout(timer);
      if (e instanceof HttpError && !RETRY_STATUS.has(e.status)) throw e;
      if (e?.name === 'AbortError') {
        lastErr = new Error('Timed out');
        continue;
      }
      lastErr = e;
      // A hard network error (DNS, offline) — retrying is still worth one shot.
      if (attempt >= retries) throw e;
    }
  }

  throw lastErr || new Error('Request failed');
}
