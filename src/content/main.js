// Content-script entry point. Loaded as an ES module by bootstrap.js.

import { extractCompany, describeExtraction } from './extract/index.js';
import { installNavDetection, isJobDetailPage } from './nav.js';
import { enrich } from './port.js';
import { createCard } from './ui/card.js';
import { normalizeCompanyName, looseKey } from '../shared/normalize.js';
import { SETTINGS_KEY, DEFAULT_SETTINGS, ERR } from '../shared/constants.js';

const DEBUG = false;
const log = (...a) => { if (DEBUG) console.log('[JCE]', ...a); };

/** Suppressed companies for this tab session. `×` writes here. */
const SUPPRESS_PREFIX = 'jce:suppress:';

function isSuppressed(key) {
  try {
    return sessionStorage.getItem(SUPPRESS_PREFIX + key) === '1';
  } catch {
    return false;
  }
}

function suppress(key) {
  try {
    sessionStorage.setItem(SUPPRESS_PREFIX + key, '1');
  } catch { /* private mode */ }
}

async function loadSettings() {
  try {
    const got = await chrome.storage.local.get(SETTINGS_KEY);
    return { ...DEFAULT_SETTINGS, ...(got[SETTINGS_KEY] || {}) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function siteId() {
  const h = location.hostname;
  if (/linkedin\.com$/.test(h)) return 'linkedin';
  if (/indeed\.com/.test(h)) return 'indeed';
  if (/jobsdb\.com$/.test(h)) return 'jobsdb';
  if (/glassdoor\./.test(h)) return 'glassdoor';
  return h;
}

export function start() {
  if (window.__jceStarted) return; // guard against double injection
  window.__jceStarted = true;

  log('content script started', location.href);

  let lastKey = null;
  let current = null;      // current extraction
  let currentReport = null;
  let currentVerification = null;
  let currentRequestId = 0; // invalidates in-flight renders after a nav
  let settings = { ...DEFAULT_SETTINGS };

  const card = createCard({
    onDismiss() {
      card.unmount();
      // Reset the dedupe key so the card can come back if the user revisits
      // this company later in the same tab.
      if (current?.name) suppress(looseKey(current.name));
      lastKey = null;
    },
    onEditName(name) {
      if (!name || !current) return;
      current = { ...current, name, source: 'user', confidence: 1, candidates: [] };
      lastKey = null;
      run(true);
    },
    onRetry() {
      lastKey = null;
      run(true);
    },
    onRerender() {
      if (currentReport) renderReady(currentReport, current);
      else card.unmount();
    },
  });

  function renderReady(report, extraction) {
    card.render({
      state: 'ready',
      company: extraction.name,
      jobTitle: extraction.jobTitle,
      report,
      verification: currentVerification,
      // Only ever the extractor's vetted alternatives, never the raw candidate
      // list — see the note in extract/index.js for why.
      suggestions: extraction.suggestions,
      staleName: extraction.staleName || null,
    });
  }

  async function run(force = false) {
    const extraction = current;
    if (!extraction?.name) {
      card.render({ state: 'needs-name', jobTitle: extraction?.jobTitle ?? null });
      return;
    }

    const key = looseKey(extraction.name);
    if (!force && isSuppressed(key)) {
      card.unmount();
      return;
    }

    const reqId = ++currentRequestId;
    card.render({
      state: 'loading',
      company: extraction.name,
      jobTitle: extraction.jobTitle,
      progress: 'cache-miss',
    });

    try {
      const res = await withRetry(() => enrich({
        name: extraction.name,
        jobTitle: extraction.jobTitle,
        location: extraction.location,
        site: siteId(),
        href: location.href.split('?')[0],
        candidates: (extraction.candidates || []).map((c) => c.name),
        force,
      }, {
        onProgress: (p) => {
          if (reqId !== currentRequestId) return;
          card.render({
            state: 'loading',
            company: extraction.name,
            jobTitle: extraction.jobTitle,
            progress: p.stage,
          });
        },
        // Partial cache hit: render what's known immediately, then let the final
        // result replace it when the stale groups land.
        onPartial: (p) => {
          if (reqId !== currentRequestId) return;
          currentVerification = p.meta?.verification || null;
          renderReady(p.report, extraction);
        },
      }));

      if (reqId !== currentRequestId) return; // superseded by a newer navigation

      currentReport = res.report;
      currentVerification = res.meta?.verification || null;

      // A probable cache match: the record's stored name differs from ours, so
      // say which name the data actually describes rather than silently showing it.
      const recordName = res.meta?.displayName;
      if (recordName && normalizeCompanyName(recordName) !== normalizeCompanyName(extraction.name)) {
        extraction.staleName = recordName;
      } else {
        extraction.staleName = null;
      }

      renderReady(res.report, extraction);
    } catch (err) {
      if (reqId !== currentRequestId) return;
      card.render({
        state: 'error',
        company: extraction.name,
        jobTitle: extraction.jobTitle,
        error: err,
      });
    }
  }

  /** One retry on SW_RESTARTED — the retry usually hits a warm cache. */
  async function withRetry(fn) {
    try {
      return await fn();
    } catch (e) {
      if (e?.code === ERR.SW_RESTARTED) {
        await new Promise((r) => setTimeout(r, e.retryAfterMs || 1500));
        return fn();
      }
      throw e;
    }
  }

  async function handleReady({ href, reason }) {
    if (!isJobDetailPage(new URL(href))) {
      log('not a job detail page, skipping', href);
      return;
    }

    current = extractCompany();
    log('extracted:', describeExtraction(current), 'via', reason);

    if (!settings.autoTrigger && !current.name) return;
    if (!settings.autoTrigger && !isSuppressed(looseKey(current.name))) {
      // Auto-trigger is off: show an editable card but don't spend a lookup.
      card.render({ state: 'needs-name', jobTitle: current.jobTitle });
      return;
    }

    if (!current.name) {
      // No name found — still useful: an empty editable field is one edit from working.
      card.render({ state: 'needs-name', jobTitle: current.jobTitle });
      currentRequestId++; // cancel any in-flight render from the previous page
      return;
    }

    // Dedupe on the extracted company plus the path, so navigating between two
    // jobs at the same employer doesn't refetch. The query string is stripped
    // because LinkedIn appends ?trackingId=... to every click.
    // The query string is stripped because LinkedIn appends ?trackingId=... to
    // every click. JobsDB's search page is the exception: there the job id is
    // the identity of what's on screen, so it has to survive the strip — without
    // it, two postings at the same employer in the same district collide and the
    // second never re-renders.
    const jid = (href.match(/[?&]jobId=([^&]+)/) || [])[1] || '';
    const key = `${looseKey(current.name)}|${href.split('?')[0]}|${jid}`;
    if (key === lastKey) {
      log('dedupe hit, skipping', key);
      return;
    }
    lastKey = key;

    await run(false);
  }

  settings = { ...DEFAULT_SETTINGS };
  loadSettings().then((s) => {
    settings = s;
    installNavDetection(handleReady);
    // The nav detector only fires on change, so kick off the first extraction.
    handleReady({ href: location.href, reason: 'init' });
  });

  // React to settings changes without requiring a page reload.
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes[SETTINGS_KEY]) {
        settings = { ...DEFAULT_SETTINGS, ...(changes[SETTINGS_KEY].newValue || {}) };
      }
    });
  } catch { /* storage events unavailable */ }
}
