// The report schema. This literal serves two roles:
//   1. it is stringified into the DeepSeek prompt
//   2. it is the input to validateReport()
// They live together so the prompt and the validator can never drift apart.
//
// Note: DeepSeek's json_object mode guarantees *syntactically valid* JSON, not
// schema conformance — there is no structured-outputs equivalent. Hence the
// hand-written repair pass below, which never throws.

import { padHkCode } from './normalize.js';

export const COMPANY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['companyName', 'matchedEntity', 'hkListing', 'profile', 'reputation', 'sources'],
  properties: {
    companyName: { type: 'string', description: 'Best canonical name for the employer.' },
    matchedEntity: {
      type: ['string', 'null'],
      description: 'Legal entity the data describes, if different from companyName (e.g. parent/holding company). null if the same.',
    },

    hkListing: {
      type: 'object',
      additionalProperties: false,
      required: ['isListed', 'stockCode', 'ticker', 'board', 'listingDate', 'confidence', 'evidenceUrls'],
      properties: {
        isListed: {
          type: ['boolean', 'null'],
          description: 'true = evidence of HKEX (SEHK) listing. false = evidence it is listed elsewhere or explicitly not HK-listed. null = no evidence either way.',
        },
        stockCode: {
          type: ['string', 'null'],
          description: '5-digit HKEX code as a string, e.g. "00700". null if unknown. NEVER guess.',
        },
        ticker: { type: ['string', 'null'], description: 'Yahoo-style ticker, e.g. "0700.HK". null if unknown.' },
        board: { type: ['string', 'null'], description: 'Main Board or GEM. null if unknown.' },
        listingDate: { type: ['string', 'null'], description: 'ISO YYYY-MM-DD. null if unknown.' },
        confidence: { type: 'number', minimum: 0, maximum: 1, description: 'Strength of the evidence, not familiarity with the company.' },
        evidenceUrls: { type: 'array', items: { type: 'string' }, description: 'URLs from the provided results that support the listing claim.' },
      },
    },

    profile: {
      type: 'object',
      additionalProperties: false,
      required: ['employeeBand', 'employeeCountExact', 'headquarters', 'foundedYear', 'industry', 'confidence'],
      properties: {
        employeeBand: { type: ['string', 'null'], description: 'e.g. "500-1,000 employees". Prefer a band over a point estimate.' },
        employeeCountExact: { type: ['integer', 'null'] },
        headquarters: { type: ['string', 'null'], description: 'City, Country. Prefer the operating HQ over a registered address.' },
        foundedYear: { type: ['integer', 'null'] },
        industry: { type: ['string', 'null'] },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
      },
    },

    reputation: {
      type: 'object',
      additionalProperties: false,
      required: ['glassdoorRating', 'ratingScale', 'reviewCount', 'sentiment', 'layoffs', 'lawsuits', 'redFlags', 'confidence'],
      properties: {
        glassdoorRating: { type: ['number', 'null'], description: 'Only if a result states the number. Never invent one.' },
        ratingScale: { type: ['number', 'null'], description: 'The scale the rating is on, e.g. 5 or 10.' },
        reviewCount: { type: ['integer', 'null'] },
        sentiment: { type: ['string', 'null'], description: 'positive, mixed, negative, or null. Negative requires negative evidence.' },
        layoffs: { type: 'array', items: { $ref: '#/$defs/event' } },
        lawsuits: { type: 'array', items: { $ref: '#/$defs/event' } },
        redFlags: { type: 'array', items: { type: 'string' }, description: 'Max 3 short phrases. Empty array if none.' },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
      },
    },

    sources: {
      type: 'array',
      description: '3-6 results actually used, each mapped to the field group it supports.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'url', 'usedFor'],
        properties: {
          title: { type: 'string' },
          url: { type: 'string' },
          usedFor: { type: 'string', description: 'One of: hkListing, profile, reputation, identity.' },
        },
      },
    },

    // `notes` is deliberately absent. It used to be a model-authored field, and
    // the model wrote essays in it — every lookup ended in an orange paragraph of
    // reasoning ("Results describe the employer as...", "so hkListing is left null
    // rather than guessed") that the card rendered verbatim. It restated fields
    // that were already on screen and pushed the actual report off the fold.
    //
    // The reason it existed — flagging a parent company versus the employer — is
    // carried by matchedEntity, which drives its own short line. What is left of
    // `notes` is machine-written only: the repair suffix below and the ticker
    // verification warning, both of which stay.
  },

  $defs: {
    event: {
      type: 'object',
      additionalProperties: false,
      required: ['summary', 'year', 'sourceUrl'],
      properties: {
        summary: { type: 'string' },
        year: { type: ['integer', 'null'] },
        sourceUrl: { type: ['string', 'null'] },
      },
    },
  },
};

export const USED_FOR = ['hkListing', 'profile', 'reputation', 'identity'];

// ------------------------------------------------------------------ helpers

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function str(v) {
  if (typeof v === 'string') return v.trim() || null;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}

function int(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === 'string') {
    const n = Number(v.replace(/[,\s]/g, ''));
    if (Number.isFinite(n)) return Math.trunc(n);
  }
  return null;
}

function num(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v.replace(/[,\s]/g, ''));
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function confidence(v) {
  const n = num(v);
  if (n === null) return 0;
  return Math.min(1, Math.max(0, n));
}

/** Three-state boolean. Anything that isn't clearly a boolean becomes null. */
function triBool(v) {
  if (v === true || v === false) return v;
  if (typeof v === 'string') {
    const s = v.toLowerCase().trim();
    if (['true', 'yes', 'y'].includes(s)) return true;
    if (['false', 'no', 'n'].includes(s)) return false;
  }
  return null;
}

function eventList(v, repairs, label) {
  if (!Array.isArray(v)) {
    if (v != null) repairs.push(`${label}: expected array, got ${typeof v}`);
    return [];
  }
  return v
    .filter((e) => isObj(e) || typeof e === 'string')
    .map((e) => (typeof e === 'string'
      ? { summary: e.slice(0, 200), year: null, sourceUrl: null }
      : { summary: str(e.summary) ?? '', year: int(e.year), sourceUrl: str(e.sourceUrl) }))
    .filter((e) => e.summary);
}

function dateStr(v) {
  const s = str(v);
  if (!s) return null;
  // Tolerate "2021-06", "June 2021", "2021/06/30" — normalize what we can.
  let m = s.match(/^(\d{4})-(\d{2})(?:-(\d{2}))?$/);
  if (m) return m[3] ? `${m[1]}-${m[2]}-${m[3]}` : `${m[1]}-${m[2]}`;
  m = s.match(/^(\d{4})[/.](\d{1,2})(?:[/.](\d{1,2}))?$/);
  if (m) {
    const mm = m[2].padStart(2, '0');
    return m[3] ? `${m[1]}-${mm}-${m[3].padStart(2, '0')}` : `${m[1]}-${mm}`;
  }
  m = s.match(/\b(19|20)\d{2}\b/);
  return m ? m[0] : null;
}

function urlList(v, repairs, label) {
  if (!Array.isArray(v)) {
    if (v != null) repairs.push(`${label}: expected array, got ${typeof v}`);
    return [];
  }
  return v.map(str).filter((u) => u && /^https?:\/\//i.test(u)).slice(0, 8);
}

/**
 * Tolerant validation/repair. Coerces where safe, fills gaps with null/[]/0,
 * clamps confidences, drops unknown keys. Never throws — a report that needed
 * repairs still renders, with the repairs appended to `notes`.
 *
 * @returns {{report: object, repairs: string[]}}
 */
export function validateReport(raw) {
  const repairs = [];
  let r = raw;

  if (typeof r === 'string') {
    try {
      r = JSON.parse(r);
    } catch {
      return { report: emptyReport(), repairs: ['response was not JSON at all'] };
    }
  }
  // Some models wrap the object in a single-element array or an envelope.
  if (Array.isArray(r)) {
    repairs.push('top level was an array; used first element');
    r = r[0];
  }
  if (isObj(r) && isObj(r.report)) {
    repairs.push('unwrapped a nested "report" object');
    r = r.report;
  }
  if (!isObj(r)) return { report: emptyReport(), repairs: ['top level was not an object'] };

  const hk = isObj(r.hkListing) ? r.hkListing : (repairs.push('hkListing missing'), {});
  const pr = isObj(r.profile) ? r.profile : (repairs.push('profile missing'), {});
  const rep = isObj(r.reputation) ? r.reputation : (repairs.push('reputation missing'), {});

  let stockCode = str(hk.stockCode);
  if (stockCode) {
    const padded = padHkCode(stockCode);
    if (padded) {
      if (padded !== stockCode) repairs.push(`stockCode normalized ${stockCode} → ${padded}`);
      stockCode = padded;
    } else {
      repairs.push(`stockCode "${stockCode}" is not a plausible HKEX code; dropped`);
      stockCode = null;
    }
  }

  let ticker = str(hk.ticker);
  if (!ticker && stockCode) {
    ticker = `${stockCode.replace(/^0+/, '').padStart(4, '0')}.HK`;
    repairs.push('ticker derived from stockCode');
  }

  const board = /main/i.test(hk.board ?? '') ? 'Main Board'
    : /gem/i.test(hk.board ?? '') ? 'GEM'
      : (str(hk.board) ? (repairs.push(`board "${hk.board}" not Main/GEM; kept as-is`), str(hk.board)) : null);

  const sources = Array.isArray(r.sources)
    ? r.sources
      .filter(isObj)
      .map((s) => ({
        title: str(s.title) ?? '',
        url: str(s.url) ?? '',
        usedFor: USED_FOR.includes(s.usedFor) ? s.usedFor : (repairs.push(`source usedFor "${s.usedFor}" invalid; → identity`), 'identity'),
      }))
      .filter((s) => s.url && /^https?:\/\//i.test(s.url))
      .slice(0, 8)
    : [];

  const report = {
    companyName: str(r.companyName) ?? '',
    matchedEntity: str(r.matchedEntity),
    hkListing: {
      isListed: triBool(hk.isListed),
      stockCode,
      ticker,
      board,
      listingDate: dateStr(hk.listingDate),
      confidence: confidence(hk.confidence),
      evidenceUrls: urlList(hk.evidenceUrls, repairs, 'hkListing.evidenceUrls'),
    },
    profile: {
      employeeBand: str(pr.employeeBand),
      employeeCountExact: int(pr.employeeCountExact),
      headquarters: str(pr.headquarters),
      foundedYear: int(pr.foundedYear),
      industry: str(pr.industry),
      confidence: confidence(pr.confidence),
    },
    reputation: {
      glassdoorRating: num(rep.glassdoorRating),
      ratingScale: num(rep.ratingScale),
      reviewCount: int(rep.reviewCount),
      sentiment: ['positive', 'mixed', 'negative'].includes(rep.sentiment) ? rep.sentiment : null,
      layoffs: eventList(rep.layoffs, repairs, 'reputation.layoffs'),
      lawsuits: eventList(rep.lawsuits, repairs, 'reputation.lawsuits'),
      redFlags: Array.isArray(rep.redFlags)
        ? rep.redFlags.map(str).filter(Boolean).slice(0, 3)
        : [],
      confidence: confidence(rep.confidence),
    },
    sources,
    // Discarded, not carried: the model is no longer asked for `notes`, and one
    // that volunteers it anyway must not reach the card. Everything below this
    // line is machine-written.
    notes: null,
  };

  if (repairs.length) {
    const suffix = `[repaired: ${repairs.join('; ')}]`;
    report.notes = report.notes ? `${report.notes} ${suffix}` : suffix;
  }

  return { report, repairs };
}

/** A report with every field explicitly absent — used for hard failures. */
export function emptyReport(companyName = '') {
  return {
    companyName,
    matchedEntity: null,
    hkListing: { isListed: null, stockCode: null, ticker: null, board: null, listingDate: null, confidence: 0, evidenceUrls: [] },
    profile: { employeeBand: null, employeeCountExact: null, headquarters: null, foundedYear: null, industry: null, confidence: 0 },
    reputation: {
      glassdoorRating: null, ratingScale: null, reviewCount: null, sentiment: null,
      layoffs: [], lawsuits: [], redFlags: [], confidence: 0,
    },
    sources: [],
    notes: null,
  };
}
