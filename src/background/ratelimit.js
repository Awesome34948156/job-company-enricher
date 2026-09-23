// Token buckets and daily budgets.
//
// Auto-trigger means rapidly clicking through job postings would otherwise burn
// the Serper free tier in an afternoon. Both limits are persisted, because the
// MV3 service worker is killed when idle and module-level counters would reset.

import { BUCKETS, DAILY_BUDGET } from '../shared/constants.js';

const RL_PREFIX = 'rl:';
const BUDGET_PREFIX = 'budget:';

// Serializes the read-modify-write on a bucket. Without this, two concurrent
// enrichments both read `tokens: 1` and both spend it.
let chain = Promise.resolve();

function serialize(fn) {
  const next = chain.then(fn, fn);
  // Keep the chain alive even if a link rejects.
  chain = next.catch(() => {});
  return next;
}

function todayKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Take one token from a bucket.
 * @returns {Promise<{ok: true} | {ok: false, retryAfterMs: number}>}
 */
export function takeToken(name) {
  const cfg = BUCKETS[name];
  if (!cfg) return Promise.resolve({ ok: true });

  return serialize(async () => {
    const KEY = RL_PREFIX + name;
    const now = Date.now();
    const got = await chrome.storage.local.get(KEY);
    const b = got[KEY] || { tokens: cfg.capacity, ts: now };

    const elapsedMin = Math.max(0, (now - b.ts) / 60000);
    b.tokens = Math.min(cfg.capacity, b.tokens + elapsedMin * cfg.refillPerMin);
    b.ts = now;

    if (b.tokens < 1) {
      const retryAfterMs = Math.ceil(((1 - b.tokens) / cfg.refillPerMin) * 60000);
      await chrome.storage.local.set({ [KEY]: b });
      return { ok: false, retryAfterMs };
    }

    b.tokens -= 1;
    await chrome.storage.local.set({ [KEY]: b });
    return { ok: true };
  });
}

/** Give a token back — used when a request fails before reaching the provider. */
export function refundToken(name) {
  const cfg = BUCKETS[name];
  if (!cfg) return Promise.resolve();
  return serialize(async () => {
    const KEY = RL_PREFIX + name;
    const got = await chrome.storage.local.get(KEY);
    const b = got[KEY] || { tokens: cfg.capacity, ts: Date.now() };
    b.tokens = Math.min(cfg.capacity, b.tokens + 1);
    b.ts = Date.now();
    await chrome.storage.local.set({ [KEY]: b });
  });
}

/**
 * Check and consume daily budget for one provider.
 * @returns {Promise<{ok: true} | {ok: false, used: number, limit: number}>}
 */
export function takeBudget(name, cost = 1) {
  const limit = DAILY_BUDGET[name] ?? Infinity;
  return serialize(async () => {
    const KEY = BUDGET_PREFIX + todayKey();
    const got = await chrome.storage.local.get(KEY);
    const day = got[KEY] || { serper: 0, deepseek: 0 };
    const used = day[name] || 0;
    if (used + cost > limit) return { ok: false, used, limit };
    day[name] = used + cost;
    await chrome.storage.local.set({ [KEY]: day });
    return { ok: true, used: day[name], limit };
  });
}

export async function usageToday() {
  const KEY = BUDGET_PREFIX + todayKey();
  const got = await chrome.storage.local.get(KEY);
  const day = got[KEY] || { serper: 0, deepseek: 0 };
  return {
    date: todayKey(),
    serper: day.serper || 0,
    deepseek: day.deepseek || 0,
    limits: { ...DAILY_BUDGET },
  };
}

/** Drop budget counters and buckets from previous days. */
export async function pruneOldCounters() {
  const all = await chrome.storage.local.get(null);
  const today = BUDGET_PREFIX + todayKey();
  const stale = Object.keys(all).filter((k) => k.startsWith(BUDGET_PREFIX) && k !== today);
  if (stale.length) await chrome.storage.local.remove(stale);
  return stale.length;
}
