// Port lifecycle between content script and service worker.
//
// A port (rather than one-shot sendMessage) is used for two reasons:
//   1. an open port resets the MV3 service worker's idle timer, and the
//      keepalive ping means a 15-second lookup can't let the worker die mid-flight
//   2. progress stages can be pushed to the card, so a slow lookup shows
//      "Searching… → Analyzing 12 results… → Verifying ticker…" instead of an
//      opaque spinner

import { PORT_NAME, MSG, ERR } from '../shared/constants.js';

const KEEPALIVE_MS = 20000;

let port = null;
const pending = new Map(); // reqId -> {resolve, reject}
let keepalive = null;

function rejectAll(error) {
  for (const [, p] of pending) p.reject(error);
  pending.clear();
}

function connect() {
  port = chrome.runtime.connect({ name: PORT_NAME });

  port.onMessage.addListener((msg) => {
    if (!msg || !msg.t) return;
    if (msg.t === MSG.PONG) return;
    const entry = pending.get(msg.reqId);
    if (!entry) return;

    if (msg.t === MSG.PROGRESS) {
      entry.onProgress?.(msg);
      return;
    }
    if (msg.t === MSG.PARTIAL) {
      // An early render from cache while the stale groups are still in flight.
      // Deliberately does NOT settle the promise — the final result still arrives.
      entry.onPartial?.(msg);
      return;
    }
    if (msg.t === MSG.RESULT) {
      pending.delete(msg.reqId);
      stopKeepaliveIfIdle();
      if (msg.ok) entry.resolve(msg);
      else entry.reject(msg.error || { code: ERR.NETWORK, message: 'Unknown error' });
    }
  });

  port.onDisconnect.addListener(() => {
    // The service worker was killed mid-flight. Fail every in-flight request
    // with a retryable code; the caller retries once and usually hits a warm cache.
    const err = { code: ERR.SW_RESTARTED, message: 'Extension worker restarted', retryAfterMs: 1500 };
    port = null;
    stopKeepalive();
    rejectAll(err);
  });

  return port;
}

function stopKeepalive() {
  if (keepalive) {
    clearInterval(keepalive);
    keepalive = null;
  }
}

function stopKeepaliveIfIdle() {
  if (pending.size === 0) stopKeepalive();
}

function ensureKeepalive() {
  if (keepalive) return;
  keepalive = setInterval(() => {
    if (!port) return stopKeepalive();
    try {
      port.postMessage({ t: MSG.PING });
    } catch {
      stopKeepalive();
    }
  }, KEEPALIVE_MS);
}

/**
 * Request enrichment. Resolves with `{report, meta}`, rejects with `{code, message}`.
 * @param {object} payload  { name, jobTitle, site, href, location, candidates, force }
 * @param {{onProgress?: Function, onPartial?: Function}} [handlers]
 */
export function enrich(payload, handlers = {}) {
  const p = port || connect();
  const reqId = (crypto.randomUUID?.() || String(Math.random()).slice(2));

  return new Promise((resolve, reject) => {
    pending.set(reqId, { resolve, reject, ...handlers });
    ensureKeepalive();
    try {
      p.postMessage({ t: MSG.ENRICH, reqId, ...payload });
    } catch (e) {
      pending.delete(reqId);
      stopKeepaliveIfIdle();
      reject({ code: ERR.NETWORK, message: String(e?.message || e) });
    }
  });
}

export function isConnected() {
  return port !== null;
}
