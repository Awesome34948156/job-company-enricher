// The enrichment pipeline: cache → search → analyze → verify → cache.
//
// This is hop 2 of the three-hop design. Because DeepSeek has no server-side web
// search, the service worker is the search engine's client: it fans out to
// Serper, trims the results, and hands them to the model as context.
//
// Every failure here is designed to degrade to a *usable* card rather than a
// broken one — a Serper failure still renders, with the affected rows marked
// "Not found" and the reason attached.

import { ERR, DATA_GROUPS, SETTINGS_KEY, DEFAULT_SETTINGS } from '../shared/constants.js';
import { buildUserPrompt, systemPrompt, hkexEvidenceUrls } from '../shared/prompts.js';
import { emptyReport } from '../shared/schema.js';
import { cacheLookup, cacheStore, recordToReport } from './cache.js';
import { takeToken, refundToken, takeBudget } from './ratelimit.js';
import { searchCompany, SerperError } from './serper.js';
import { callDeepSeek, DeepSeekError } from './deepseek.js';
import { verifyListing } from './hkex.js';

const INFLIGHT_PREFIX = 'inflight:';
const INFLIGHT_STALE_MS = 90 * 1000;
const ERROR_LOG_KEY = 'diagnostics:errors';

// Same-worker dedupe: if two requests for the same company arrive while one is
// in flight, the second awaits the first instead of double-spending a search.
// Module scope is fine to lose on worker restart — a port disconnect already
// tells the content script to retry.
const inflight = new Map();

export async function loadSettings() {
  const got = await chrome.storage.local.get(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...(got[SETTINGS_KEY] || {}) };
}

export async function recordError(code, message, context = {}) {
  try {
    const got = await chrome.storage.local.get(ERROR_LOG_KEY);
    const log = Array.isArray(got[ERROR_LOG_KEY]) ? got[ERROR_LOG_KEY] : [];
    log.unshift({ at: Date.now(), code, message, ...context });
    await chrome.storage.local.set({ [ERROR_LOG_KEY]: log.slice(0, 20) });
  } catch { /* diagnostics are best-effort */ }
}

/**
 * Claim a lookup, returning an existing in-flight promise when there is one.
 *
 * `chrome.storage.session` is used only to *observe* that another tab is working
 * on the same company — there is no way to await another tab's promise, so this
 * is logged for diagnostics rather than used as a lock. Same-worker requests are
 * genuinely coalesced by the Map.
 */
async function claimInflight(key) {
  const existing = inflight.get(key);
  if (existing) return { existing };

  let anotherTab = false;
  try {
    const got = await chrome.storage.session.get(INFLIGHT_PREFIX + key);
    const at = got[INFLIGHT_PREFIX + key];
    anotherTab = Boolean(at) && Date.now() - at < INFLIGHT_STALE_MS;
    await chrome.storage.session.set({ [INFLIGHT_PREFIX + key]: Date.now() });
  } catch { /* session storage may be unavailable */ }

  return { existing: null, anotherTab };
}

async function releaseInflight(key) {
  inflight.delete(key);
  try {
    await chrome.storage.session.remove(INFLIGHT_PREFIX + key);
  } catch { /* session storage may be unavailable */ }
}

function err(code, message, extra = {}) {
  return { code, message, ...extra };
}

/**
 * @param {object} payload { name, jobTitle, location, site, href, candidates, force }
 * @param {{onProgress?: Function, onPartial?: Function}} handlers
 * @returns {Promise<{report: object, meta: object}>}
 */
export async function runPipeline(payload, handlers = {}) {
  const settings = await loadSettings();
  const name = (payload?.name || '').trim();
  const { onProgress = () => {}, onPartial = () => {} } = handlers;

  if (!name) throw err(ERR.BAD_REQUEST, 'No company name supplied.');

  if (!settings.serperKey || !settings.deepseekKey) {
    const missing = [!settings.serperKey && 'Serper', !settings.deepseekKey && 'DeepSeek']
      .filter(Boolean).join(' and ');
    throw err(ERR.NO_KEYS, `Add your ${missing} API key in settings to enable lookups.`);
  }

  const cacheKey = name.toLowerCase();
  const force = Boolean(payload.force);

  // ---------------------------------------------------------------- cache
  let cached = { found: false };
  if (!force) {
    onProgress({ stage: 'cache-miss' });
    cached = await cacheLookup(name);

    if (cached.found && cached.allFresh) {
      onProgress({ stage: 'cache-hit' });
      return {
        report: recordToReport(cached.record),
        meta: {
          fromCache: true,
          displayName: cached.record.displayName,
          verification: cached.record.verification || null,
          groupsFresh: DATA_GROUPS,
          serperCalls: 0,
          usage: null,
        },
      };
    }

    // Partial hit: render what's fresh right now so repeat views feel instant,
    // then continue fetching only the stale groups.
    if (cached.found && Object.keys(cached.fresh).length) {
      onPartial({
        report: recordToReport(cached.record, Object.keys(cached.fresh)),
        meta: {
          fromCache: true,
          partial: true,
          displayName: cached.record.displayName,
          verification: cached.record.verification || null,
          groupsFresh: Object.keys(cached.fresh),
          pendingGroups: cached.stale,
          serperCalls: 0,
          usage: null,
        },
      });
    }
  }

  // Only fetch what's actually missing. We can only reach here with a cache hit
  // if something was stale, so a hit means "fetch the stale groups"; a miss means
  // a cold lookup for all three.
  const needed = cached.found ? cached.stale : [...DATA_GROUPS];
  const deep = Boolean(settings.deepMode) || needed.includes('reputation');

  // --------------------------------------------------------- in-flight guard
  const claim = await claimInflight(cacheKey);
  if (claim.existing) {
    console.debug('[JCE] coalescing duplicate lookup for', cacheKey);
    return claim.existing;
  }
  if (claim.anotherTab) {
    console.debug('[JCE] another tab is already enriching', cacheKey);
  }

  const run = fetchAndAnalyze({ payload, name, settings, needed, deep, onProgress, cached });
  inflight.set(cacheKey, run);
  try {
    return await run;
  } finally {
    await releaseInflight(cacheKey);
  }
}

async function fetchAndAnalyze({ payload, name, settings, needed, deep, onProgress, cached }) {
  // ------------------------------------------------------------ rate limits
  const budget = await takeBudget('serper', 3);
  if (!budget.ok) {
    const e = err(ERR.DAILY_BUDGET, `Daily Serper budget reached (${budget.used}/${budget.limit}). It resets at midnight.`);
    await recordError(e.code, e.message, { company: name });
    throw e;
  }

  const bucket = await takeToken('serper');
  if (!bucket.ok) {
    const e = err(ERR.RATE_LIMITED, 'Slowing down to protect your search quota.', { retryAfterMs: bucket.retryAfterMs });
    await recordError(e.code, e.message, { company: name });
    throw e;
  }

  // ---------------------------------------------------------------- search
  onProgress({ stage: 'searching', detail: deep ? 'deep queries' : '3 queries' });
  let search;
  try {
    search = await searchCompany(settings.serperKey, name, {
      deep,
      timeoutMs: settings.timeoutMs,
    });
  } catch (e) {
    await refundToken('serper');
    const code = e instanceof SerperError ? e.code : ERR.SERPER_HTTP;
    const message = e?.message || 'Search failed.';
    await recordError(code, message, { company: name });
    throw err(code, message);
  }

  // --------------------------------------------------------------- analyze
  const budget2 = await takeBudget('deepseek', 1);
  if (!budget2.ok) {
    const e = err(ERR.DAILY_BUDGET, `Daily DeepSeek budget reached (${budget2.used}/${budget2.limit}). It resets at midnight.`);
    await recordError(e.code, e.message, { company: name });
    throw e;
  }

  const dsBucket = await takeToken('deepseek');
  if (!dsBucket.ok) {
    const e = err(ERR.RATE_LIMITED, 'Slowing down DeepSeek requests.', { retryAfterMs: dsBucket.retryAfterMs });
    await recordError(e.code, e.message, { company: name });
    throw e;
  }

  onProgress({
    stage: 'analyzing',
    detail: `${search.bundle.reduce((n, r) => n + (r.organic?.length || r.news?.length || 0), 0)} results`,
  });

  const asOf = new Date().toISOString().slice(0, 10);
  const userPrompt = buildUserPrompt({
    companyName: name,
    jobTitle: payload.jobTitle,
    site: payload.site,
    location: payload.location,
    candidates: payload.candidates,
    asOf,
    searchBundle: search.bundle,
  });

  let analysis;
  try {
    analysis = await callDeepSeek(settings, {
      system: systemPrompt(asOf),
      user: userPrompt,
      timeoutMs: Math.max(settings.timeoutMs, 30000),
    });
  } catch (e) {
    await refundToken('deepseek');
    const code = e instanceof DeepSeekError ? e.code : ERR.DEEPSEEK_HTTP;
    const message = e?.message || 'Analysis failed.';
    await recordError(code, message, { company: name });
    throw err(code, message);
  }

  const report = analysis.report || emptyReport(name);
  if (!report.companyName) report.companyName = name;
  if (!report.sources?.length && search.bundle.length) {
    // Give the card something to cite even if the model omitted sources.
    report.sources = search.bundle
      .flatMap((r) => (r.organic || r.news || []).slice(0, 2).map((o) => ({
        title: o.title || o.link, url: o.link, usedFor: r.key || 'identity',
      })))
      .filter((s) => s.url)
      .slice(0, 5);
  }

  // ---------------------------------------------------------------- verify
  onProgress({ stage: 'verifying' });
  let verification = null;
  if (report.hkListing?.stockCode) {
    try {
      verification = await verifyListing(report.hkListing, name, settings.datasetUrl);
      // An unverified code must not render inline. Blank it out and let the
      // display gate show "ticker unconfirmed" instead of a wrong number.
      if (!verification.ok && verification.reason === 'name-mismatch') {
        report.notes = [
          report.notes,
          `A HKEX code ${report.hkListing.stockCode} was found but its registered name `
          + `("${verification.datasetName}") does not match — treat as unverified.`,
        ].filter(Boolean).join(' ');
      }
    } catch (e) {
      console.warn('[JCE] verification failed', e);
    }
  }

  // Surface HKEX-domain evidence found in the raw results, since the display
  // gate keys on it.
  const hkexUrls = hkexEvidenceUrls(search.bundle, report.hkListing?.evidenceUrls);
  if (hkexUrls.length) {
    report.hkListing.evidenceUrls = [...new Set([...(report.hkListing.evidenceUrls || []), ...hkexUrls])];
  }

  // ----------------------------------------------------------------- cache
  const groups = {
    hkListing: report.hkListing,
    profile: report.profile,
    reputation: report.reputation,
  };
  // Only persist groups we actually fetched — never overwrite fresh data with
  // a group we skipped.
  const toStore = Object.fromEntries(
    Object.entries(groups).filter(([g]) => needed.includes(g)),
  );

  const record = await cacheStore(name, toStore, {
    sources: report.sources,
    notes: report.notes,
    verification,
    displayName: report.companyName || name,
  }, settings);

  return {
    report,
    meta: {
      fromCache: false,
      displayName: record?.displayName || name,
      verification,
      groupsFresh: Object.keys(toStore),
      partial: false,
      serperCalls: search.calls,
      failures: search.failures,
      repairs: analysis.repairs,
      usage: analysis.usage,
      attempts: analysis.attempts,
    },
  };
}
