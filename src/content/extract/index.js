// Layered company-name extraction.
//
// All layers run, not just until the first hit: the runner-ups become LLM hints
// and the card's "Did you mean?" chips. Layers are cheap (one DOM pass each), so
// the extra information is nearly free and it's what lets an ambiguous page
// degrade to a one-click choice instead of a confident wrong answer.

import { extractFromJsonLd } from './jsonld.js';
import { extractFromTitle, visibleJobTitle } from './title.js';
import { heuristicCandidates } from './heuristic.js';
import * as linkedin from './adapters/linkedin.js';
import * as indeed from './adapters/indeed.js';
import * as jobsdb from './adapters/jobsdb.js';
import * as glassdoor from './adapters/glassdoor.js';
import { sameCompany, looseKey, isPlausibleCompanyName } from '../../shared/normalize.js';

const ADAPTERS = [linkedin, indeed, jobsdb, glassdoor];

/** Layer confidences. Ordering here is the precedence order. */
const CONF = {
  jsonld: 0.95,
  adapter: 0.85,
  linkSlug: 0.65,
  title: 0.6,
  heuristic: 0.35,
};

export function activeAdapter(url = new URL(location.href)) {
  return ADAPTERS.find((a) => {
    try {
      return a.match(url);
    } catch {
      return false;
    }
  }) || null;
}

/**
 * @returns {{
 *   name: string|null, jobTitle: string|null, location: string|null,
 *   source: string|null, confidence: number,
 *   candidates: string[], ambiguous: boolean, disagreement: boolean
 * }}
 */
export function extractCompany(doc = document, url = new URL(location.href)) {
  const found = []; // { name, source, confidence, jobTitle, location }

  // ---- layer 1: JSON-LD (published for Google Jobs; survives CSS refactors)
  try {
    const j = extractFromJsonLd(doc);
    if (j?.name) found.push({ ...j, source: 'jsonld', confidence: CONF.jsonld });
  } catch (e) {
    console.debug('[JCE] jsonld layer failed', e);
  }

  const adapter = activeAdapter(url);

  // ---- layer 2: site adapter (stable data-* hooks)
  let adapterResult = null;
  if (adapter) {
    try {
      // `url` is passed through because JobsDB serves a posting under two URL
      // shapes and only the search-page one needs scoping to a pane.
      adapterResult = adapter.extract(doc, url);
      if (adapterResult?.name) {
        found.push({ ...adapterResult, source: `adapter:${adapter.id}`, confidence: CONF.adapter });
      }
    } catch (e) {
      console.debug('[JCE] adapter layer failed', e);
    }
  }

  // ---- layer 3: company-profile link slug (machine-readable, refactor-proof)
  try {
    const a = doc.querySelector('a[href*="/company/"], a[href*="/cmp/"], a[href*="/Overview/"], a[href*="/Working-at-"]');
    const slug = a ? (a.getAttribute('href') || '') : '';
    if (slug) {
      const m = slug.match(/\/(?:company|cmp|Overview|Working-at-)[/-]?([^/?#]+?)(?:-EI_IE\d+)?\.htm|(?:company|cmp)\/([^/?#]+)/i);
      const raw = m?.[1] || m?.[2];
      if (raw) {
        const name = decodeURIComponent(raw).replace(/-\d+$/, '').split(/[-_+]+/).filter(Boolean)
          .map((w) => (/^[a-z]/.test(w) ? w[0].toUpperCase() + w.slice(1) : w)).join(' ');
        if (name.length >= 2) found.push({ name, source: 'link-slug', confidence: CONF.linkSlug });
      }
    }
  } catch (e) {
    console.debug('[JCE] link-slug layer failed', e);
  }

  // ---- layer 4: <title> parsing (also an independent cross-check on layer 1)
  //
  // Skipped outright when the adapter says the title describes the page rather
  // than the posting — a search-results title names the query, not the employer.
  // On JobsDB that title ends in a listing period, and reading it is how a date
  // became a company name.
  const titleReliable = adapter?.titleIsReliable ? adapter.titleIsReliable(url) : true;
  let titleCandidates = [];
  if (titleReliable) {
    try {
      const t = extractFromTitle(doc);
      titleCandidates = t?.candidates || [];
      for (const name of titleCandidates) {
        found.push({ name, source: 'title', confidence: CONF.title });
      }
    } catch (e) {
      console.debug('[JCE] title layer failed', e);
    }
  }

  const jobTitle = found.find((f) => f.jobTitle)?.jobTitle
    || adapterResult?.jobTitle
    || visibleJobTitle(doc);
  const location = found.find((f) => f.location)?.location
    || adapterResult?.location
    || null;

  // ---- layer 5: scored-DOM heuristic (last resort; top 3)
  let heuristic = [];
  try {
    // Filtered here as well as in `add` because the ambiguity check below reads
    // the top two directly.
    heuristic = heuristicCandidates(doc, jobTitle)
      .filter((h) => isPlausibleCompanyName(h.text));
  } catch (e) {
    console.debug('[JCE] heuristic layer failed', e);
  }

  // Highest-confidence *plausible* name wins.
  //
  // The plausibility gate is applied once, here, rather than inside each layer:
  // junk arrives by every route — a selector, a title regex, the DOM heuristic —
  // so one filter in front of the sort covers all of them. Filtering before the
  // sort rather than after is the point: a rejected name must not merely lose to
  // the winner, it must not be promoted into its place.
  const usable = found.filter((f) => isPlausibleCompanyName(f.name));
  usable.sort((a, b) => b.confidence - a.confidence);
  const winner = usable[0] || null;

  // Build the deduped candidate list: winner first, then heuristic suggestions,
  // then any remaining cross-source names.
  const candidates = [];
  const seen = new Set();
  const add = (name, source, confidence) => {
    if (!isPlausibleCompanyName(name)) return;
    const k = looseKey(name);
    if (!k || seen.has(k)) return;
    // Don't offer variants of a name we already have.
    if (candidates.some((c) => sameCompany(c.name, name, 0.8))) return;
    seen.add(k);
    candidates.push({ name, source, confidence });
  };

  if (winner) add(winner.name, winner.source, winner.confidence);
  for (const h of heuristic) add(h.text, 'heuristic', CONF.heuristic);
  for (const f of usable) add(f.name, f.source, f.confidence);

  // Ambiguity: the two best heuristic candidates are effectively tied.
  let ambiguous = false;
  if (heuristic.length >= 2 && !winner) {
    ambiguous = Math.abs(heuristic[0].score - heuristic[1].score) <= 1;
  }

  // Disagreement between JSON-LD and title is a signal, not an error — it means
  // the page probably names a parent company somewhere. Surfaced as a chip.
  let disagreement = false;
  if (winner && titleCandidates.length) {
    disagreement = !titleCandidates.some((t) => sameCompany(t, winner.name, 0.6));
  }

  // What the card should offer as alternatives, decided here rather than there
  // because this is the only place that knows *why* extraction was unsure.
  //
  // Each trigger has its own answer, and mixing them is what produced the noise:
  // `ambiguous` means the heuristics were tied, so their contenders are the
  // alternatives; `disagreement` means the title names something else, so the
  // title's reading is. Emitting the raw candidate list instead — which is what
  // the card used to do — offered the last-resort heuristic's runner-ups on
  // every page, and that layer scores DOM shape rather than company-ness, so on
  // a JobsDB posting it surfaced the "View all jobs" link text and a page title.
  const suggestions = [];
  if (ambiguous) for (const h of heuristic) suggestions.push(h.text);
  if (disagreement) suggestions.push(...titleCandidates);

  const wantKey = looseKey(winner?.name || '');
  const unique = [];
  for (const s of suggestions) {
    const k = looseKey(s);
    if (!k || k === wantKey || unique.includes(k)) continue;
    unique.push(k);
  }

  return {
    name: winner?.name || null,
    jobTitle: jobTitle || null,
    location: location || null,
    source: winner?.source || null,
    confidence: winner?.confidence || 0,
    candidates: candidates.slice(0, 4),
    ambiguous,
    disagreement,
    // The vetted chip list. Empty is the common and correct case.
    suggestions: unique.slice(0, 3).map((k) => suggestions.find((s) => looseKey(s) === k)),
  };
}

/** Which precedence layer won — for logging and the debug badge. */
export function describeExtraction(ex) {
  return `${ex.name ?? '(none)'} | ${ex.source ?? 'no-source'} | ${ex.confidence.toFixed(2)}`;
}
