// Persistent cache in chrome.storage.local.
//
// Per-group TTLs, not a single record TTL. The split is the whole point:
//  - a listing code, board and date are immutable, so caching them for a year
//    avoids re-deriving facts that can never change
//  - but `isListed: false` gets only 14 days, because a company can IPO later.
//    A single 7-day TTL would be wrong in both directions at once.

import {
  CACHE_PREFIX, CACHE_INDEX_KEY, CACHE_STATS_KEY, CACHE_MAX_RECORDS,
  TTL, DATA_GROUPS,
} from '../shared/constants.js';
import { looseKey, strictKey, normalizeCompanyName } from '../shared/normalize.js';

const keyFor = (name) => CACHE_PREFIX + looseKey(name);

function ttlFor(group, data, settings) {
  if (group === 'hkListing') {
    if (data?.isListed === true) {
      const days = settings?.ttlListingDays ?? (TTL.hkListingListed / 86400000);
      return days * 86400000;
    }
    // false and null both get the short TTL: neither is a stable fact.
    return TTL.hkListingNotListed;
  }
  if (group === 'profile') {
    const days = settings?.ttlProfileDays ?? (TTL.profile / 86400000);
    return days * 86400000;
  }
  if (group === 'reputation') {
    const days = settings?.ttlReputationDays ?? (TTL.reputation / 86400000);
    return days * 86400000;
  }
  return TTL.profile;
}

// ------------------------------------------------------------------- stats

async function bumpStat(field, by = 1) {
  const got = await chrome.storage.local.get(CACHE_STATS_KEY);
  const s = got[CACHE_STATS_KEY] || { hits: 0, misses: 0, evictions: 0 };
  s[field] = (s[field] || 0) + by;
  await chrome.storage.local.set({ [CACHE_STATS_KEY]: s });
}

async function touchIndex(key) {
  const got = await chrome.storage.local.get(CACHE_INDEX_KEY);
  const index = Array.isArray(got[CACHE_INDEX_KEY]) ? got[CACHE_INDEX_KEY] : [];
  const filtered = index.filter((e) => e.key !== key);
  filtered.push({ key, lastAccess: Date.now() });

  if (filtered.length > CACHE_MAX_RECORDS) {
    // LRU eviction. `lastAccess` is updated on every read, so the head of the
    // list is the least recently used.
    filtered.sort((a, b) => a.lastAccess - b.lastAccess);
    const evict = filtered.splice(0, filtered.length - CACHE_MAX_RECORDS);
    if (evict.length) {
      await chrome.storage.local.remove(evict.map((e) => e.key));
      await bumpStat('evictions', evict.length);
    }
  }
  await chrome.storage.local.set({ [CACHE_INDEX_KEY]: filtered });
}

// ------------------------------------------------------------------ lookup

/**
 * @returns {{found: false}
 *          | {found: true, record: object, fresh: object, stale: string[],
 *             allFresh: boolean, probable: boolean}}
 */
export async function cacheLookup(name) {
  const key = keyFor(name);
  if (key === CACHE_PREFIX) return { found: false };

  const got = await chrome.storage.local.get(key);
  const record = got[key];
  if (!record || record.v !== 1) {
    await bumpStat('misses');
    return { found: false };
  }

  const now = Date.now();
  const fresh = {};
  const stale = [];
  for (const g of DATA_GROUPS) {
    const cell = record.groups?.[g];
    if (!cell || !cell.data) {
      stale.push(g);
      continue;
    }
    if (now - cell.fetchedAt < cell.ttlMs) fresh[g] = cell;
    else stale.push(g);
  }

  // Over-normalization guard: the loose key can collide ("Acme Ltd" vs "Acme
  // Group" both strip to "acme" only if the suffix list is too aggressive). If
  // our strict form isn't among the record's aliases, this is a *probable* match
  // — still returned, but the card says which name the data actually describes.
  const sk = strictKey(name);
  const aliases = record.strictKeys || [];
  const probable = aliases.length > 0 && !aliases.includes(sk);

  record.hitCount = (record.hitCount || 0) + 1;
  record.lastAccess = now;
  await chrome.storage.local.set({ [key]: record });
  await touchIndex(key);

  await bumpStat('hits');

  return {
    found: true,
    record,
    fresh,
    stale,
    allFresh: stale.length === 0,
    probable,
  };
}

// ------------------------------------------------------------------- store

/**
 * Merge freshly-derived groups into the record.
 * @param {string} name
 * @param {object} groups  { hkListing?, profile?, reputation? }  raw group data
 * @param {object} extra   { sources?, notes?, displayName? }
 */
export async function cacheStore(name, groups, extra = {}, settings = {}) {
  const key = keyFor(name);
  if (key === CACHE_PREFIX) return null;

  const got = await chrome.storage.local.get(key);
  const now = Date.now();
  const record = got[key]?.v === 1 ? got[key] : {
    v: 1,
    looseKey: looseKey(name),
    strictKeys: [],
    displayName: name,
    updatedAt: now,
    groups: {},
    sources: [],
    notes: null,
    hitCount: 0,
    lastAccess: now,
  };

  const sk = strictKey(name);
  if (sk && !record.strictKeys.includes(sk)) record.strictKeys.push(sk);

  for (const [group, data] of Object.entries(groups)) {
    if (!data) continue;
    record.groups[group] = {
      fetchedAt: now,
      ttlMs: ttlFor(group, data, settings),
      data,
    };
  }

  if (extra.sources?.length) record.sources = extra.sources;
  if (extra.notes !== undefined) record.notes = extra.notes;
  if (extra.verification !== undefined) record.verification = extra.verification;
  if (extra.displayName) record.displayName = extra.displayName;

  record.updatedAt = now;
  record.lastAccess = now;

  await chrome.storage.local.set({ [key]: record });
  await touchIndex(key);
  return record;
}

/** Flatten a record back into a report shape for the card. */
export function recordToReport(record, groups = null) {
  const pick = (g) => (groups && !groups.includes(g) ? null : record.groups?.[g]?.data) || null;
  return {
    companyName: record.displayName || record.looseKey || '',
    matchedEntity: record.matchedEntity ?? null,
    hkListing: pick('hkListing') || {
      isListed: null, stockCode: null, ticker: null, board: null,
      listingDate: null, confidence: 0, evidenceUrls: [],
    },
    profile: pick('profile') || {
      employeeBand: null, employeeCountExact: null, headquarters: null,
      foundedYear: null, industry: null, confidence: 0,
    },
    reputation: pick('reputation') || {
      glassdoorRating: null, ratingScale: null, reviewCount: null,
      sentiment: null, layoffs: [], lawsuits: [], redFlags: [], confidence: 0,
    },
    sources: record.sources || [],
    notes: record.notes ?? null,
  };
}

// --------------------------------------------------------------- management

export async function clearCache() {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter((k) => k.startsWith(CACHE_PREFIX));
  if (keys.length) await chrome.storage.local.remove(keys);
  await chrome.storage.local.set({ [CACHE_INDEX_KEY]: [], [CACHE_STATS_KEY]: { hits: 0, misses: 0, evictions: 0 } });
  return keys.length;
}

export async function deleteRecord(name) {
  const key = keyFor(name);
  await chrome.storage.local.remove(key);
  const got = await chrome.storage.local.get(CACHE_INDEX_KEY);
  const index = (got[CACHE_INDEX_KEY] || []).filter((e) => e.key !== key);
  await chrome.storage.local.set({ [CACHE_INDEX_KEY]: index });
  return true;
}

/** Records for the options-page table, newest first. */
export async function listRecords() {
  const all = await chrome.storage.local.get(null);
  const now = Date.now();
  return Object.entries(all)
    .filter(([k, v]) => k.startsWith(CACHE_PREFIX) && v?.v === 1)
    .map(([k, v]) => ({
      key: k,
      name: v.displayName || k.slice(CACHE_PREFIX.length),
      updatedAt: v.updatedAt,
      ageMs: now - (v.updatedAt || 0),
      hits: v.hitCount || 0,
      stale: DATA_GROUPS.filter((g) => {
        const cell = v.groups?.[g];
        return !cell || now - cell.fetchedAt >= cell.ttlMs;
      }),
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function cacheStats() {
  const got = await chrome.storage.local.get([CACHE_STATS_KEY, CACHE_INDEX_KEY]);
  const index = got[CACHE_INDEX_KEY] || [];
  return {
    ...(got[CACHE_STATS_KEY] || { hits: 0, misses: 0, evictions: 0 }),
    size: index.length,
  };
}

/** Approximate bytes used by cache records, for the options page. */
export async function cacheBytes() {
  const all = await chrome.storage.local.get(null);
  let bytes = 0;
  for (const [k, v] of Object.entries(all)) {
    if (k.startsWith(CACHE_PREFIX)) bytes += JSON.stringify(v).length;
  }
  return bytes;
}

export { keyFor, normalizeCompanyName };
