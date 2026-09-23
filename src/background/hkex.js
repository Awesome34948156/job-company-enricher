// HKEX ticker verification.
//
// The stock code is the field most likely to be confidently wrong: an LLM that
// pattern-matches a plausible four-digit number produces an answer that looks
// exactly like a correct one. So the code is *verified* before it is displayed,
// and an unverified code renders as "unconfirmed" rather than inline.
//
// Two independent layers:
//   1. name↔code agreement against the HKEX listed-securities dataset
//   2. a Yahoo quote probe — confirms the code exists, not that it's the right company

import {
  HKEX_DATASET_DEFAULT_URL, YAHOO_CHART_URL,
} from '../shared/constants.js';
import { tokenOverlap, acronymOverlap, padHkCode } from '../shared/normalize.js';
import { fetchJson } from './http.js';

const DATASET_KEY = 'dataset:hkex';
const DATASET_META_KEY = 'dataset:hkex:meta';
const DATASET_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Bump when the *normalized row shape* changes, so caches written by an older
 * mapping are re-downloaded rather than served. v2 fixed `en` being empty on
 * every row (the upstream field is `engName`, not `enName`).
 */
const DATASET_SHAPE = 2;

/**
 * A small built-in fallback so the very first run isn't degraded, and so a
 * failed download degrades to "unconfirmed" rather than to a wrong answer.
 * Deliberately limited to large, well-known HK employers.
 */
const FALLBACK_ROWS = [
  ['00001', 'CK Hutchison Holdings', '長和'],
  ['00002', 'CLP Holdings', '中電控股'],
  ['00003', 'Hong Kong and China Gas', '香港中華煤氣'],
  ['00005', 'HSBC Holdings', '滙豐控股'],
  ['00006', 'Power Assets Holdings', '電能實業'],
  ['00011', 'Hang Seng Bank', '恒生銀行'],
  ['00012', 'Henderson Land Development', '恒基地產'],
  ['00016', 'Sun Hung Kai Properties', '新鴻基地產'],
  ['00017', 'New World Development', '新世界發展'],
  ['00027', 'Galaxy Entertainment', '銀河娛樂'],
  ['00066', 'MTR Corporation', '港鐵公司'],
  ['00101', 'Hang Lung Properties', '恒隆地產'],
  ['00175', 'Geely Automobile', '吉利汽車'],
  ['00267', 'CITIC', '中信股份'],
  ['00288', 'WH Group', '萬洲國際'],
  ['00388', 'Hong Kong Exchanges and Clearing', '香港交易所'],
  ['00700', 'Tencent Holdings', '騰訊控股'],
  ['00762', 'China Unicom', '中國聯通'],
  ['00823', 'Link REIT', '領展房產基金'],
  ['00939', 'China Construction Bank', '建設銀行'],
  ['00941', 'China Mobile', '中國移動'],
  ['00981', 'SMIC', '中芯國際'],
  ['01044', 'Hengan International', '恒安國際'],
  ['01113', 'CK Asset Holdings', '長實集團'],
  ['01299', 'AIA Group', '友邦保險'],
  ['01810', 'Xiaomi', '小米集團'],
  ['02007', 'Country Garden Holdings', '碧桂園'],
  ['02020', 'ANTA Sports', '安踏體育'],
  ['02318', 'Ping An Insurance', '中國平安'],
  ['02382', 'Sunny Optical', '舜宇光學科技'],
  ['02388', 'BOC Hong Kong', '中銀香港'],
  ['03690', 'Meituan', '美團'],
  ['03988', 'Bank of China', '中國銀行'],
  ['06060', 'ZhongAn Online', '眾安在綫'],
  ['06618', 'JD Health', '京東健康'],
  ['09618', 'JD.com', '京東集團'],
  ['09888', 'Baidu', '百度集團'],
  ['09961', 'Trip.com Group', '攜程集團'],
  ['09988', 'Alibaba Group', '阿里巴巴'],
  ['09999', 'NetEase', '網易'],
];

// ------------------------------------------------------------------ dataset

let memory = null; // parsed index, per service-worker lifetime

function buildIndex(rows) {
  const byCode = new Map();
  for (const r of rows) {
    const code = String(r.code ?? r[0] ?? '').replace(/\D/g, '').padStart(5, '0');
    if (code.length !== 5) continue;
    const en = String(r.en ?? r.engName ?? r.enName ?? r.englishName ?? r.name ?? r[1] ?? '').trim();
    const zh = String(r.zh ?? r.zhName ?? r.chineseName ?? r.nameZh ?? r[2] ?? '').trim();
    byCode.set(code, { code, en, zh });
  }
  return { byCode, count: byCode.size };
}

function fallbackIndex() {
  return buildIndex(FALLBACK_ROWS.map(([code, en, zh]) => ({ code, en, zh })));
}

/** Load the dataset, downloading it if stale. Never throws. */
export async function loadDataset(url = HKEX_DATASET_DEFAULT_URL, { force = false } = {}) {
  if (memory && !force) return memory;

  const got = await chrome.storage.local.get([DATASET_KEY, DATASET_META_KEY]);
  const meta = got[DATASET_META_KEY];
  // A cache written by an older version of the mapping is worse than no cache:
  // it is shaped wrongly and would be served for another 30 days. Shape mismatch
  // forces a re-download instead.
  const usable = Boolean(got[DATASET_KEY]) && meta?.shape === DATASET_SHAPE;
  const fresh = usable && Date.now() - meta.fetchedAt < DATASET_MAX_AGE_MS;

  if (fresh && !force) {
    memory = buildIndex(got[DATASET_KEY]);
    return memory;
  }

  try {
    const raw = await fetchJson(url, { timeoutMs: 20000, retries: 1, label: 'hkex-dataset' });
    const rows = Array.isArray(raw) ? raw : (raw?.data || raw?.list || raw?.rows || []);
    if (!Array.isArray(rows) || rows.length < 100) {
      throw new Error(`dataset looked wrong (${Array.isArray(rows) ? rows.length : typeof rows} rows)`);
    }
    const normalized = rows.map((r) => (Array.isArray(r)
      ? { code: r[0], en: r[1], zh: r[2] }
      : {
        code: r.code ?? r.symbol ?? r.stockCode,
        // `engName`, not `enName` — the upstream file spells it with the g.
        // Getting this wrong is silent and expensive: `en` comes back empty for
        // every row, so a search in English can only ever be checked against the
        // Chinese name and always fails as a name-mismatch. Both spellings are
        // accepted here because the dataset URL is user-editable.
        en: r.en ?? r.engName ?? r.enName ?? r.englishName ?? r.name,
        zh: r.zh ?? r.zhName ?? r.chineseName ?? r.nameZh ?? r.name,
      }));
    await chrome.storage.local.set({
      [DATASET_KEY]: normalized,
      [DATASET_META_KEY]: { fetchedAt: Date.now(), count: normalized.length, url, error: null, shape: DATASET_SHAPE },
    });
    memory = buildIndex(normalized);
    return memory;
  } catch (e) {
    console.warn('[JCE] HKEX dataset download failed:', e?.message);
    await chrome.storage.local.set({
      [DATASET_META_KEY]: {
        fetchedAt: meta?.fetchedAt || 0,
        count: meta?.count || 0,
        url,
        error: e?.message || String(e),
        // Carry the shape through: dropping it here would invalidate a cache
        // that is still perfectly good, forcing a re-download on every lookup
        // for as long as the network stays down.
        shape: meta?.shape,
      },
    });
    // Only fall back to the cached copy when it is the right shape; a cache
    // written by an older mapping would silently reintroduce the bug it was
    // re-downloading to fix.
    memory = usable ? buildIndex(got[DATASET_KEY]) : fallbackIndex();
    memory.degraded = true;
    return memory;
  }
}

export async function datasetStatus() {
  const got = await chrome.storage.local.get([DATASET_KEY, DATASET_META_KEY]);
  const meta = got[DATASET_META_KEY] || {};
  return {
    ...meta,
    cached: Boolean(got[DATASET_KEY]),
    cachedCount: Array.isArray(got[DATASET_KEY]) ? got[DATASET_KEY].length : 0,
  };
}

// --------------------------------------------------------------- verify

/**
 * HKEX uses 5-digit codes ("00700"); Yahoo uses 4-digit ("0700.HK").
 *
 * Routes through padHkCode first rather than length-checking the raw digits:
 * "700" (Tencent) is 3 digits but perfectly valid, and yahooConfirms() calls
 * this directly, so a length check here would silently skip the layer-2 probe
 * for every unpadded code the model returns. It also correctly rejects
 * over-long input that the old version would have truncated into a real code.
 */
export function toYahooSymbol(code) {
  const canonical = padHkCode(code);
  if (!canonical) return null;
  return `${canonical.replace(/^0+/, '').padStart(4, '0')}.HK`;
}

export function normalizeCode(code) {
  return padHkCode(code);
}

/**
 * Minimum two-way name agreement before a proposed code is trusted.
 *
 * Raised from a one-way 0.5 because one-way containment is far too permissive
 * for short names built from generic words: every token of "Bank of China"
 * appears in "China Bohai Bank", so the gate scored them 1.0 — a wrong ticker
 * shown as verified, which is the worst outcome this file exists to prevent.
 * Requiring both directions to clear the bar rejects that pair while leaving
 * "Tencent" vs "Tencent Holdings Limited" at a clean 1.0.
 */
const NAME_MATCH_THRESHOLD = 0.8;

/**
 * Layer 1: does the proposed code exist in the HKEX list, and does its name
 * agree with the company we searched for?
 */
export function verifyTicker(proposedCode, companyName, dataset) {
  const code = normalizeCode(proposedCode);
  if (!code) return { ok: false, reason: 'no-code' };
  if (!dataset?.byCode) return { ok: false, reason: 'dataset-unavailable' };

  const row = dataset.byCode.get(code);
  if (!row) return { ok: false, reason: 'code-not-in-hkex-list' };

  // Both directions must agree, per language, then the better language wins.
  // Taking the max across languages is what lets an English query match an
  // English row while a Chinese query matches the Chinese row — the two never
  // have to agree with each other, since a name is only ever in one script.
  //
  // `acronymOverlap` is a hard 1 or 0 rather than a score, so folding it in with
  // max() reads as "does this count as agreement", not "how much". It has to sit
  // here rather than inside the token metric because the fact it supplies is
  // lexical, not statistical — see its comment for the pair that forced it.
  const score = (a, b) => Math.max(
    Math.min(tokenOverlap(a, b), tokenOverlap(b, a)),
    acronymOverlap(a, b),
  );
  const overlap = Math.max(score(companyName, row.en), score(companyName, row.zh));

  return overlap >= NAME_MATCH_THRESHOLD
    ? { ok: true, code, datasetName: row.en || row.zh, overlap }
    : { ok: false, reason: 'name-mismatch', datasetName: row.en || row.zh, overlap };
}

/** Layer 2: does the code actually trade? Confirms existence, not identity. */
export async function yahooConfirms(code) {
  const sym = toYahooSymbol(code);
  if (!sym) return false;
  try {
    const json = await fetchJson(`${YAHOO_CHART_URL}/${sym}?range=1d&interval=1d`, {
      timeoutMs: 8000,
      retries: 0,
      label: 'yahoo',
    });
    const price = json?.chart?.result?.[0]?.meta?.regularMarketPrice;
    return Number.isFinite(price) || typeof json?.chart?.result?.[0]?.meta?.symbol === 'string';
  } catch {
    return false;
  }
}

/**
 * Full verification for a report. Layer 2 runs only when layer 1 couldn't
 * confirm, so the common case costs no extra request.
 *
 * @returns {{ok: boolean, code: string|null, reason: string, datasetName?: string, layer?: number}}
 */
export async function verifyListing(hkListing, companyName, datasetUrl) {
  if (!hkListing?.stockCode) return { ok: false, code: null, reason: 'no-code' };

  const dataset = await loadDataset(datasetUrl);
  const l1 = verifyTicker(hkListing.stockCode, companyName, dataset);
  if (l1.ok) return { ...l1, layer: 1 };

  // Layer 2 is a weaker signal, so it only counts when the model was fairly
  // confident and layer 1 failed for a reason other than a name mismatch.
  if (l1.reason === 'name-mismatch') return { ...l1, layer: 1 };
  if (hkListing.confidence >= 0.7) {
    const traded = await yahooConfirms(hkListing.stockCode);
    if (traded) {
      return {
        ok: true,
        code: normalizeCode(hkListing.stockCode),
        reason: 'yahoo-confirmed',
        layer: 2,
      };
    }
  }
  return { ...l1, layer: 1 };
}

export { fallbackIndex, FALLBACK_ROWS };
