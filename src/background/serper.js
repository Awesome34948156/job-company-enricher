// Serper client and query templates.
//
// The extension plays the role of search engine here, because DeepSeek has no
// server-side web search tool. DeepSeek only ever sees the results; it never
// issues a query.

import { SERPER_SEARCH_URL, SERPER_NEWS_URL } from '../shared/constants.js';
import { fetchJson, HttpError } from './http.js';

export class SerperError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = 'SerperError';
    this.code = code;
    this.status = status;
  }
}

/**
 * Build the query set for one company.
 *
 * Notes on the templates:
 *  - the company name is QUOTED; unquoted it tokenizes into junk
 *  - the Chinese query is not optional: HKEX filings and HK media index under
 *    Chinese names, and 股票代號 is the term that surfaces the stock code
 *  - site:hkexnews.hk is the precision lever; the display gate keys on it
 *  - the news endpoint beats organic for reputation, and tbs:qdr:y restricts to
 *    the last year with dated articles, which is what makes "recent layoffs"
 *    answerable at all
 */
export function buildQueries(name, { deep = false } = {}) {
  const q = `"${name}"`;

  // The job's location is deliberately NOT baked into the queries. It is passed
  // to the model separately (buildUserPrompt's jobLocation) as a disambiguator,
  // which is more useful there than as a search term — adding "Kwun Tong" to a
  // quoted-name query narrows the result set without improving name matching.

  const queries = [
    {
      key: 'profile',
      q: `${q} company headquarters employees founded industry`,
      gl: 'hk',
      hl: 'en',
      num: 10,
    },
    {
      key: 'hkListing',
      q: `${q} 港交所 上市 股票代號`,
      gl: 'hk',
      hl: 'zh-hk',
      num: 10,
    },
    {
      key: 'hkListing',
      q: `${q} (site:hkexnews.hk OR site:hkex.com.hk)`,
      gl: 'hk',
      hl: 'en',
      num: 10,
    },
  ];

  if (deep) {
    queries.push(
      {
        key: 'reputation',
        q: `${q} (layoffs OR lawsuit OR 裁員 OR 訴訟 OR 欠薪)`,
        gl: 'hk',
        hl: 'en',
        endpoint: 'news',
        tbs: 'qdr:y',
        num: 10,
      },
      {
        key: 'reputation',
        q: `${q} Glassdoor reviews rating`,
        gl: 'hk',
        hl: 'en',
        num: 6,
      },
    );
  }

  return queries;
}

async function runOne(apiKey, spec, timeoutMs) {
  const url = spec.endpoint === 'news' ? SERPER_NEWS_URL : SERPER_SEARCH_URL;
  const payload = { q: spec.q, gl: spec.gl, hl: spec.hl, num: spec.num };
  if (spec.tbs) payload.tbs = spec.tbs;

  const json = await fetchJson(url, {
    method: 'POST',
    headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
    body: payload,
    timeoutMs,
    label: 'serper',
  });

  return { ...json, query: spec.q, key: spec.key };
}

/**
 * Run the whole set. `Promise.allSettled` on purpose: one failing query must not
 * sink the batch, because a partial bundle is still useful to the model.
 *
 * @returns {{bundle: object[], calls: number, failures: object[]}}
 */
export async function searchCompany(apiKey, name, { deep = false, timeoutMs = 20000 } = {}) {
  const specs = buildQueries(name, { deep });

  const settled = await Promise.allSettled(
    specs.map((s) => runOne(apiKey, s, timeoutMs)),
  );

  const bundle = [];
  const failures = [];
  settled.forEach((res, i) => {
    if (res.status === 'fulfilled') {
      const hasContent = res.value.organic?.length || res.value.news?.length
        || res.value.knowledgeGraph || res.value.answerBox;
      if (hasContent) bundle.push(res.value);
      else failures.push({ query: specs[i].q, reason: 'no-results' });
    } else {
      const e = res.reason;
      failures.push({
        query: specs[i].q,
        reason: e?.message || String(e),
        status: e instanceof HttpError ? e.status : undefined,
      });
    }
  });

  // Surface auth/quota problems rather than silently returning an empty bundle.
  const hard = settled.find((r) => r.status === 'rejected' && r.reason instanceof HttpError
    && [401, 403, 402].includes(r.reason.status));
  if (hard) {
    throw new SerperError(
      'SERPER_HTTP',
      `Serper rejected the request (${hard.reason.status}). Check the API key and credits.`,
      hard.reason.status,
    );
  }

  if (!bundle.length) {
    throw new SerperError('SERPER_NO_RESULTS', 'No search results found for this company name.');
  }

  return { bundle, calls: specs.length, failures };
}

/** Minimal connectivity probe for the options page. */
export async function testKey(apiKey, timeoutMs = 10000) {
  const started = Date.now();
  try {
    await runOne(apiKey, { q: '"test"', gl: 'hk', hl: 'en', num: 1 }, timeoutMs);
    return { ok: true, ms: Date.now() - started };
  } catch (e) {
    const status = e instanceof HttpError ? e.status : undefined;
    const detail = status === 401 || status === 403
      ? 'Serper rejected the API key'
      : e.message || String(e);
    return { ok: false, ms: Date.now() - started, error: detail, status };
  }
}
