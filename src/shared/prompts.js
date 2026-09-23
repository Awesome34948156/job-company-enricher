// Prompt construction and Serper-context trimming. Pure — imported by the SW,
// and by nothing in the content script (kept here so the schema and the prompt
// that embeds it live side by side).

import { COMPANY_SCHEMA } from './schema.js';
import { clip, sigTokens, normalizeCompanyName, hostOf } from './normalize.js';
import { CONTEXT_ORGANIC_LIMIT } from './constants.js';

const HKEX_HOSTS = ['hkexnews.hk', 'hkex.com.hk'];

export function isHkexUrl(url) {
  const h = hostOf(url);
  return HKEX_HOSTS.some((d) => h === d || h.endsWith('.' + d));
}

// The word "JSON" must appear in the prompt for JSON-mode to be accepted.
export const SYSTEM_PROMPT = `You are a corporate research analyst filling a structured profile of a hiring company.

You will receive SEARCH RESULTS from Google for one company. You must answer ONLY from those results.

Respond with a single JSON object matching the schema exactly. Do not wrap it in prose or a code fence.

Hard rules:
1. NEVER guess. If the provided results do not state a fact, return null for that field.
2. For hkListing.stockCode: report any HKEX code that a result ties to this company, and put the supporting URL in hkListing.evidenceUrls. Report it even when you are unsure, and even when the match is by a translated or registered name — a Chinese registered name such as 「騰訊控股有限公司」 and the English trading name "Tencent Holdings" are the same company, as are "騰訊控股" and "Tencent". Do NOT withhold a code you found because it looks uncertain: a separate verifier checks every code against the official HKEX list and hides any it cannot confirm, so withholding only destroys a signal that could have been confirmed. What you must never do is invent a code that no result states, or transfer one from a different company with a similar name — that is the failure this rule exists to prevent.
3. isListed has THREE states: true (evidence of HKEX listing), false (evidence the company is listed elsewhere or explicitly not HK-listed), null (no evidence either way). Use null liberally.
4. Set confidence per field group (0.0-1.0) to reflect the STRENGTH OF THE EVIDENCE in the results, not your general familiarity with the company.
5. Distinguish the employing entity from its parent. If the results describe a listed parent or holding company rather than the employer itself, put the parent's name in matchedEntity. Do not narrate your reasoning anywhere in the response — fill in the fields and stop; the card renders every field you return.
6. For employeeBand, prefer a band ("500-1,000 employees") over a point estimate.
7. For reputation: only report layoffs or lawsuits that have a date AND a source in the results. Negative sentiment requires negative evidence, not the absence of positive evidence. Never invent a Glassdoor rating — report it only if a result states the number.
8. Weight recent results more heavily for reputation.
9. sources must be URLs that appear in the provided results, never from memory.
10. The current date is {AS_OF}. If a result is older than about two years, treat it as stale for reputation and size.

The response must be valid JSON.`;

export function systemPrompt(asOf) {
  return SYSTEM_PROMPT.replace('{AS_OF}', asOf);
}

/**
 * Trim one Serper response down to what's worth spending tokens on.
 * Returns null for responses that carry nothing.
 */
export function trimSerperResponse(r, { companyName } = {}) {
  if (!r) return null;
  const kg = r.knowledgeGraph;
  const ab = r.answerBox;

  // `organic` for /search, `news` for /news.
  const raw = r.organic || r.news || [];
  let items = raw.map((o) => ({
    title: clip(o.title, 140),
    link: o.link,
    snippet: clip(o.snippet ?? o.description ?? '', 280),
    date: o.date ? clip(o.date, 30) : undefined,
  }));

  if (companyName) items = filterByRelevance(items, companyName);

  const out = {
    query: r.query,
    knowledgeGraph: kg
      ? {
        title: clip(kg.title, 120),
        type: kg.type || null,
        description: clip(kg.description, 500),
        // Frequently carries Founded / Headquarters / Stock exchange.
        attributes: kg.attributes || {},
      }
      : null,
    answerBox: ab
      ? { title: clip(ab.title, 120), answer: clip(ab.answer ?? ab.snippet, 400) }
      : null,
    results: items.slice(0, CONTEXT_ORGANIC_LIMIT),
  };

  const empty = !out.knowledgeGraph && !out.answerBox && out.results.length === 0;
  return empty ? null : out;
}

/**
 * Drop organic results whose text shares no significant token with the company
 * name. Typically removes 30-40% of the noise, and it measurably improves
 * HK-ticker precision by removing *other companies with similar names* before
 * the model ever sees them.
 *
 * Knowledge-graph and answer-box results are never filtered — they are
 * already name-anchored by the search engine.
 */
export function filterByRelevance(items, companyName) {
  const tokens = new Set(sigTokens(companyName));
  if (!tokens.size) return items;
  return items.filter((it) => {
    const hay = normalizeCompanyName(`${it.title} ${it.snippet}`);
    if (!hay) return true;
    for (const t of tokens) if (hay.includes(t)) return true;
    return false;
  });
}

/**
 * Build the user turn. `searchBundle` is an array of raw-ish Serper responses
 * (already carrying their `query`).
 */
export function buildUserPrompt({ companyName, jobTitle, site, location, candidates, asOf, searchBundle }) {
  const context = (searchBundle || []).map((r) => trimSerperResponse(r, { companyName })).filter(Boolean);
  return JSON.stringify({
    task: 'Build a company profile JSON for the employer below, using ONLY the search results below.',
    asOf,
    target: {
      companyName,
      jobTitle: jobTitle || null,
      sourceSite: site || null,
      jobLocation: location || null,
      otherNameCandidates: candidates || [],
    },
    schema: COMPANY_SCHEMA,
    searchResults: context,
    // Leaving this visible to the model makes rule 3 concrete rather than abstract.
    reminder: 'Return null for anything the results do not state. A wrong stock code is worse than null.',
  });
}

/**
 * Which Serper responses contributed an HKEX-domain URL — used by the display
 * gate to decide whether a ticker may render inline.
 */
export function hkexEvidenceUrls(searchBundle, evidenceUrls = []) {
  const urls = [...evidenceUrls];
  for (const r of searchBundle || []) {
    for (const o of r?.organic || r?.news || []) if (o?.link) urls.push(o.link);
  }
  return urls.filter(isHkexUrl);
}
