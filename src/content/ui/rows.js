// Declarative row configuration.
//
// Keeping the rows as data (rather than hardcoded DOM in card.js) is what makes
// adding a field later a one-line change. The Funding row is present but
// commented out, because funding/investors was explicitly out of scope — the
// layout slot exists, the data path doesn't.

import { formatSize } from '../../shared/normalize.js';
import { isHkexUrl } from '../../shared/prompts.js';

const CONF_LOW = 0.4;

/**
 * The display gate for the HK ticker.
 *
 * This field is the one most likely to be confidently wrong, so it is verified
 * rather than trusted. A ticker renders inline only when the number is backed by
 * something checkable; otherwise it is shown as unconfirmed.
 */
export function listingGate(hk, verification) {
  if (verification?.ok) return { tier: 'verified', code: verification.code, note: null };
  if (hk.confidence >= 0.8 && (hk.evidenceUrls || []).some(isHkexUrl)) {
    return { tier: 'verified', code: hk.stockCode, note: 'HKEX source cited' };
  }
  if (hk.stockCode && hk.confidence >= 0.5) {
    return { tier: 'unconfirmed', code: null, proposed: hk.stockCode, note: null };
  }
  return { tier: 'none', code: null, note: null };
}

function renderListing(hk, ctx) {
  const isListed = hk.isListed;
  const gate = listingGate(hk, ctx.verification);

  if (isListed === true) {
    const parts = ['HK listed'];
    if (gate.tier === 'verified' && gate.code) {
      parts.push(`<span class="mono">${escapeHtml(gate.code)}</span>`);
      if (gate.note) parts.push(`<span class="muted">(${escapeHtml(gate.note)})</span>`);
    } else if (gate.tier === 'unconfirmed') {
      parts.push('<span class="muted">ticker unconfirmed</span>');
    }
    const dot = hk.confidence < CONF_LOW ? '<span class="dot"></span>' : '';
    const tip = gate.proposed ? ` title="Unverified candidate: ${escapeHtml(gate.proposed)}"` : '';
    return `<span class="ok"${tip}>✓</span> ${parts.join(' ')}${dot}`;
  }

  if (isListed === false) {
    // "Not found" and "Not listed" are different claims and must stay different.
    return hk.confidence >= 0.6
      ? '<span class="bad">Not HK-listed</span>'
      : '<span class="muted">Not found</span>';
  }
  return '<span class="muted">Unknown</span>';
}

function renderListingMeta(hk, ctx) {
  // Date and board are LLM-sourced only — the HKEX dataset carries neither — so
  // they are gated on an HKEX-domain evidence URL.
  const backed = (hk.evidenceUrls || []).some(isHkexUrl) || ctx.verification?.ok;
  if (!backed) return null;
  return [hk.listingDate, hk.board].filter(Boolean).join(' · ') || null;
}

function renderRating(rep) {
  if (!Number.isFinite(rep.glassdoorRating)) return null;
  const scale = Number.isFinite(rep.ratingScale) ? rep.ratingScale : 5;
  const count = Number.isFinite(rep.reviewCount) ? ` (${rep.reviewCount.toLocaleString()})` : '';
  return `${rep.glassdoorRating}/${scale}${count}`;
}

function renderFlags(rep) {
  const items = [
    ...(rep.redFlags || []),
    ...(rep.layoffs || []).map((l) => l.summary),
    ...(rep.lawsuits || []).map((l) => l.summary),
  ].filter(Boolean);
  if (!items.length) return null;
  return items.slice(0, 3).join('; ');
}

/**
 * Each row: { id, group, label, get(groupData, ctx) -> string|null, html? }
 * A null return renders the dimmed "Not found" placeholder — never a blank line,
 * because blank is indistinguishable from a rendering bug.
 */
export const ROWS = [
  {
    id: 'size',
    group: 'profile',
    label: 'Size',
    get: (p) => formatSize(p),
  },
  {
    id: 'listed',
    group: 'hkListing',
    label: 'HK listed',
    get: (hk, ctx) => renderListing(hk, ctx),
    html: true,
  },
  {
    id: 'listing',
    group: 'hkListing',
    label: 'Listed',
    get: (hk, ctx) => renderListingMeta(hk, ctx),
  },
  {
    id: 'hq',
    group: 'profile',
    label: 'HQ',
    get: (p) => p.headquarters,
  },
  {
    id: 'founded',
    group: 'profile',
    label: 'Founded',
    get: (p) => (Number.isFinite(p.foundedYear) ? String(p.foundedYear) : null),
  },
  {
    id: 'industry',
    group: 'profile',
    label: 'Industry',
    get: (p) => p.industry,
  },
  {
    id: 'rating',
    group: 'reputation',
    label: 'Rating',
    get: (rep) => renderRating(rep),
  },
  {
    id: 'flags',
    group: 'reputation',
    label: 'Flags',
    get: (rep) => renderFlags(rep),
  },
  // Funding was explicitly out of scope. Re-adding it is one line once the
  // schema carries the data:
  // { id: 'funding', group: 'profile', label: 'Funding', get: (p) => p.funding || null },
];

/** Group confidence, for the low-confidence amber dot. */
export function groupConfidence(report, group) {
  return report?.[group]?.confidence ?? 0;
}

/** Deduped source hostnames for the footer. */
export function sourceHosts(sources, max = 4) {
  const seen = [];
  for (const s of sources || []) {
    try {
      const h = new URL(s.url).hostname.replace(/^www\./, '');
      if (!seen.includes(h)) seen.push(h);
    } catch { /* skip unparseable */ }
  }
  return seen.slice(0, max);
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
