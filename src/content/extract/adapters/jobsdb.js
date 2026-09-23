// JobsDB (Hong Kong) — the SEEK-platform job board.
//
// JobsDB is the most stable of the four sites: it uses explicit
// data-automation attributes rather than generated class names. That makes it
// the best adapter to test against — if extraction fails here, the bug is in
// the extractor logic, not in rotted selectors.
//
// A posting is served under two different URL shapes:
//
//   /job/74221881                            the standalone posting
//   /jobs/in-Sha-Tin-District?jobId=74221881 the search page, which renders the
//                                            selected posting in a pane beside
//                                            the results list
//
// The second is how you reach a posting by browsing, so it has to work. Its
// hazard is document order: the results list comes *first* and every card in it
// names a different employer, so a document-wide query returns whichever company
// happens to be first in the left column — a confidently wrong answer.
//
// The fix is scoped to that shape only. `/job/<id>` carries a single posting, so
// the document-wide query has always been right there and is left untouched;
// running the pane search on it could only add a way to get it wrong.

import { firstText } from './shared.js';

export const id = 'jobsdb';

/** Company hooks. Deliberately excludes the hook a search-results card uses. */
const NAME_SEL = [
  '[data-automation="advertiser-name"]',
  '[data-automation="company-name"]',
  '[data-automation="jobAdvertiser"]',
  '[data-automation="job-detail-company-name"]',
  'a[data-automation="job-detail-company-profile-link"]',
  '[class*="advertiser"] a',
];

/**
 * Title hooks, used to locate the pane rather than to read the title.
 *
 * `job-detail-title` and `h1` are pane-only; `jobTitle` is what a *card* uses,
 * so it comes last and is only reached when neither of the others exists.
 */
const TITLE_SEL = [
  '[data-automation="job-detail-title"]',
  'h1',
  '[data-automation="jobTitle"]',
];

const LOCATION_SEL = [
  '[data-automation="job-detail-location"]',
  '[data-automation="jobLocation"]',
  '[data-automation="job-detail-company-location"]',
];

/** Hops to walk up before giving up on finding a pane. */
const MAX_HOPS = 12;

export function match(url) {
  // `/jobs/…` as well as `/job/…` — the search page serves a posting too.
  return /(^|\.)jobsdb\.com$/.test(location.hostname) && /\/jobs?\//.test(url.pathname);
}

/** The search-page shape: a posting selected inside a list, not a page of its own. */
function isSearchShape(url) {
  if (!url) return false;
  return !/\/job\//.test(url.pathname) && /[?&]jobId=\d+/.test(url.search);
}

/**
 * Whether the document `<title>` may be read for an employer name on this shape.
 *
 * On the search shape it may not. That title describes the *search*, and its
 * trailing segment is the listing period:
 *
 *   Data Centre Jobs in Sha Tin District - Sep 2026 | Jobsdb
 *
 * The title pattern takes the last dash-separated segment before the board
 * suffix, so reading it here yields a date — this is the bug that put "Sep 2026"
 * on the card. `/job/<id>` is the opposite case: one posting, one employer, and
 * the title names it.
 */
export function titleIsReliable(url) {
  return !isSearchShape(url);
}

/**
 * The tightest ancestor of `titleEl` that also holds a company hook — the pane,
 * rather than the page or a card.
 *
 * Walks up, never down, so it cannot escape into the results list: the list sits
 * *beside* the pane, so no ancestor of the title that contains a company hook
 * can also contain the list.
 */
function paneScope(doc, titleEl) {
  let node = titleEl?.parentElement;
  for (let hops = 0; node && node !== doc.body && hops < MAX_HOPS; hops++) {
    if (NAME_SEL.some((s) => node.querySelector(s))) return node;
    node = node.parentElement;
  }
  return null;
}

/**
 * The pane holding the selected posting.
 *
 * A candidate must carry *both* a company hook and a location hook — the two
 * things a posting header has and a search card does not. Requiring the pair,
 * rather than the company hook alone, is what keeps a card out of range when it
 * reuses the pane's company attribute: a card may well borrow `advertiser-name`,
 * but it does not carry `job-detail-location`.
 *
 * Among the survivors the largest wins, since the real pane is the one holding
 * the description and the apply UI.
 *
 * Returns null when nothing qualifies. The caller must treat that as "name
 * nothing" rather than "search the document", because the document is exactly
 * where the other companies are.
 */
function findPane(doc) {
  let best = null;
  let bestSize = -1;
  for (const t of doc.querySelectorAll(TITLE_SEL.join(','))) {
    const pane = paneScope(doc, t);
    if (!pane) continue;
    if (!firstText(pane, NAME_SEL, { max: 100 })) continue;
    if (!firstText(pane, LOCATION_SEL, { max: 100 })) continue;
    const size = (pane.textContent || '').length;
    if (size > bestSize) { bestSize = size; best = pane; }
  }
  return best;
}

/**
 * @param {Document} doc
 * @param {URL|null} url  Passed by the caller so the shape check doesn't depend
 *   on module-global `location`, which keeps this testable against a fake DOM.
 */
export function extract(doc = document, url = null) {
  const root = isSearchShape(url) ? findPane(doc) : doc;

  // A search page we cannot read a pane out of. Naming any company would be a
  // guess between postings, so name none: the card falls back to its editable
  // field, one keystroke from correct, where a guess would be quietly wrong.
  if (!root) return { name: null, jobTitle: null, location: null };

  return {
    name: firstText(root, NAME_SEL, { max: 100 }),
    jobTitle: firstText(root, TITLE_SEL, { max: 160 }),
    location: firstText(root, LOCATION_SEL, { max: 100 }),
  };
}
