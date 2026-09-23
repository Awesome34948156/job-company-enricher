// SPA navigation detection.
//
// LinkedIn and Indeed are single-page apps: clicking between job postings does
// NOT reload the document, so the content script's initial run only ever sees
// the first job. Four overlapping signals are used because each one alone has a
// gap — the Navigation API misses SPA routers that don't use it, the history
// patch misses title-only re-renders, and the poll is the safety net that has
// rescued every extension that has ever shipped this problem.

const DEBOUNCE_MS = 400;   // LinkedIn fires 2-5 nav events per click
const SETTLE_MS = 500;     // DOM must be quiet this long before we extract
const SETTLE_TIMEOUT_MS = 8000;
const POLL_MS = 1000;

const CONTAINER_SELECTOR =
  'main, [role="main"], .job-view-layout, .jobs-details, #jobsearch-ViewJobLayout, [data-automation="jobAdDetails"], article';

/** Resolve once the job container stops mutating, or after a timeout. */
function waitForStableJobDom(timeoutMs = SETTLE_TIMEOUT_MS) {
  const root = document.querySelector(CONTAINER_SELECTOR) || document.body;
  if (!root) return Promise.resolve(false);
  return new Promise((resolve) => {
    let quiet = null;
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      clearTimeout(quiet);
      clearTimeout(bail);
      mo.disconnect();
      resolve(v);
    };
    const mo = new MutationObserver(() => {
      clearTimeout(quiet);
      quiet = setTimeout(() => finish(true), SETTLE_MS);
    });
    const bail = setTimeout(() => finish(false), timeoutMs);
    mo.observe(root, { childList: true, subtree: true, characterData: true });
    // If nothing mutates at all (cached render), don't wait the full timeout.
    quiet = setTimeout(() => finish(true), SETTLE_MS);
  });
}

/**
 * @param {(info: {href: string, reason: string}) => void} onReady
 * @returns {() => void} teardown
 */
export function installNavDetection(onReady) {
  let lastHref = location.href;
  let debounceTimer = null;
  let dirty = false;

  const fire = async (reason) => {
    dirty = false;
    lastHref = location.href;
    await waitForStableJobDom();
    try {
      onReady({ href: location.href, reason });
    } catch (e) {
      console.error('[JCE] onReady threw', e);
    }
  };

  const schedule = (reason) => {
    dirty = true;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => fire(reason), DEBOUNCE_MS);
  };

  // 1. Navigation API — primary signal; `navigatesuccess` fires once the SPA
  //    considers the navigation finished, which is stronger than pushState.
  if (window.navigation?.addEventListener) {
    try {
      window.navigation.addEventListener('navigatesuccess', () => schedule('nav-api'));
      window.navigation.addEventListener('navigate', () => { dirty = true; });
    } catch { /* not available */ }
  }

  // 2. history monkey-patch — belt and braces for routers that bypass the nav
  //    API entirely.
  for (const method of ['pushState', 'replaceState']) {
    const orig = history[method];
    if (typeof orig !== 'function') continue;
    history[method] = function patched(...args) {
      const r = orig.apply(this, args);
      schedule(`history.${method}`);
      return r;
    };
  }
  addEventListener('popstate', () => schedule('popstate'));
  addEventListener('hashchange', () => schedule('hashchange'));

  // 3. <title> mutation — catches title-only swaps and SPAs that render new
  //    content without touching the URL at all.
  const titleEl = document.querySelector('title');
  const titleObserver = titleEl
    ? new MutationObserver(() => schedule('title'))
    : null;
  titleObserver?.observe(titleEl, { childList: true, characterData: true, subtree: true });

  // 4. href poll — final safety net. Costs nothing measurable.
  const pollTimer = setInterval(() => {
    if (location.href !== lastHref) schedule('poll');
  }, POLL_MS);

  return () => {
    clearTimeout(debounceTimer);
    clearInterval(pollTimer);
    titleObserver?.disconnect();
  };
}

/** True when the URL looks like a single job posting rather than a list page. */
export function isJobDetailPage(url = new URL(location.href)) {
  const p = url.pathname;
  if (/(^|\.)linkedin\.com$/.test(url.hostname)) return /\/jobs\/view\//.test(p);
  if (/(^|\.)indeed\.com(\.\w+)?$/.test(url.hostname)) return /viewjob|\/m\/jobs\//.test(p) || /[?&]vjk=/.test(url.search);
  if (/(^|\.)jobsdb\.com$/.test(url.hostname)) {
    // Two shapes serve a posting. `/job/<id>` is the standalone page; the search
    // page renders the selected posting in a pane and carries its id in the
    // query instead. Browsing normally only ever produces the second, so
    // requiring `/job/` meant the card never appeared for the common path.
    return /\/job\//.test(p) || /[?&]jobId=\d+/.test(url.search);
  }
  if (/(^|\.)glassdoor\./.test(url.hostname)) return /job-listing|\/Job\//i.test(p);
  return true;
}
