// Content-script entry point. Loaded as an ES module by bootstrap.js.

import { extractCompany, describeExtraction } from './extract/index.js';
import { installNavDetection, isJobDetailPage } from './nav.js';
import { enrich } from './port.js';
import { createCard } from './ui/card.js';
import { normalizeCompanyName, looseKey } from '../shared/normalize.js';
import { SETTINGS_KEY, DEFAULT_SETTINGS, ERR } from '../shared/constants.js';

const DEBUG = false;

/**
 * Set `window.__jce_debug = true` in the page console to turn these on without a
 * source edit.
 *
 * Worth knowing because a wrong company name is invisible in its cause: the card
 * shows what it searched for, never which of the five layers produced it. Every
 * layer looks like a plain string by the time it reaches the card — that is how a
 * date off a page title showed up as an employer.
 */
const log = (...a) => { if (DEBUG || window.__jce_debug) console.log('[JCE]', ...a); };

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

/**
 * How long to keep waiting for an employer name to appear, and how often to look.
 *
 * Bounded on purpose: this runs only when a pass found nothing, so the common
 * named page never pays it, and a page that genuinely has no company still
 * degrades to the editable field rather than hanging.
 */
const NAME_WAIT_MS = 4000;
const NAME_POLL_MS = 250;

/**
 * Poll until an employer name appears, or give up.
 *
 * Extraction is triggered when the SPA settles, which is not the same moment the
 * posting is painted — JobsDB renders the selected posting's pane client-side. A
 * pass that lands early reads a DOM with no advertiser in it, and that emptiness
 * is what made a weak layer reachable: the title layer answered with a date.
 *
 * Re-running the whole pipeline is the point — the retry has to be able to find
 * the adapter-layer name the first pass missed. Returns null if none arrives.
 */
async function waitForName() {
  const deadline = Date.now() + NAME_WAIT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, NAME_POLL_MS));
    const next = extractCompany();
    if (next.name) return next;
  }
  return null;
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
  let extractGen = 0;       // invalidates in-flight extractions after a nav
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
      // The user's name outranks a pending extraction — drop it rather than let
      // it land afterwards and undo the edit.
      extractGen++;
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

    // The wait below means a slower navigation can finish after a newer one has
    // begun. The loser must not overwrite the winner's result.
    const gen = ++extractGen;
    let extraction = extractCompany();
    const blank = !extraction.name;

    // An empty pass is not conclusive — it may just be a pane that has not
    // painted. Put the editable card up now rather than after the wait, so a page
    // with genuinely no company is not four seconds of blank, and let a name that
    // arrives during the wait replace it.
    //
    // `current` is assigned *before* that render, and the ordering is
    // load-bearing: it is what an edit typed into the empty field lands on. Such
    // an edit bumps `extractGen`, which is what stops this extraction from
    // arriving afterwards and undoing what the user typed.
    if (blank) {
      // With auto-trigger off a nameless page shows nothing at all, so there is
      // nothing to wait for.
      if (!settings.autoTrigger) return;

      current = extraction;
      card.render({ state: 'needs-name', jobTitle: extraction.jobTitle });
      const late = await waitForName();
      if (gen !== extractGen) {
        log('extraction superseded, dropping', href);
        return;
      }
      if (late) extraction = late;
    }

    current = extraction;
    log('extracted:', describeExtraction(current), 'via', reason);

    if (!settings.autoTrigger && !isSuppressed(looseKey(current.name))) {
      // Auto-trigger is off: show an editable card but don't spend a lookup.
      card.render({ state: 'needs-name', jobTitle: current.jobTitle });
      return;
    }

    if (!current.name) {
      // Reached only when the empty card is already on screen (see above), so
      // there is nothing to render — and re-rendering would wipe whatever the
      // user has typed into the field since it went up.
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
