// Helpers shared by the site adapters.

/**
 * LinkedIn/Glassdoor/Indeed all encode the employer in a profile link slug:
 *   /company/acme-hk-ltd  →  "Acme HK Ltd"
 * This is machine-readable and survives far more refactors than CSS classes,
 * which is why it's its own precedence layer.
 */
export function nameFromCompanySlug(href) {
  if (!href) return null;
  const m = String(href).match(/\/(?:company|cmp|organi[sz]ations?|employer)\/([^/?#]+)/i);
  if (!m) return null;
  const slug = decodeURIComponent(m[1]).replace(/-\d+$/, '');
  if (!slug || /^\d+$/.test(slug)) return null;
  const words = slug
    .split(/[-_+]+/)
    .filter(Boolean)
    .map((w) => (/^[a-z]/.test(w) ? w[0].toUpperCase() + w.slice(1) : w));
  const name = words.join(' ').trim();
  // Slugs like "acme-hk-ltd" decode cleanly; single tokens are usually noise.
  return name.length >= 2 ? name : null;
}

/** First non-empty, non-absurd text among a list of selectors. */
export function firstText(doc, selectors, { max = 120 } = {}) {
  for (const sel of selectors) {
    let el;
    try {
      el = doc.querySelector(sel);
    } catch {
      continue; // invalid selector in some engine version — skip, don't throw
    }
    if (!el) continue;
    const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
    if (t && t.length >= 2 && t.length <= max) return t;
  }
  return null;
}

/** First anchor matching a company-profile href, preferring one with visible text. */
export function companyLinkText(doc, scopeSelector = 'main, [role="main"], body') {
  const scope = doc.querySelector(scopeSelector) || doc.body;
  if (!scope) return null;
  const anchors = scope.querySelectorAll('a[href*="/company/"], a[href*="/cmp/"]');
  let slugName = null;
  for (const a of anchors) {
    const text = (a.textContent || '').replace(/\s+/g, ' ').trim();
    if (text && text.length >= 2 && text.length <= 80) return { name: text, from: 'link-text' };
    if (!slugName) slugName = nameFromCompanySlug(a.getAttribute('href'));
  }
  return slugName ? { name: slugName, from: 'link-slug' } : null;
}

/** Strip a trailing "| LinkedIn" / "- JobsDB" style board suffix. */
export function stripBoardSuffix(s, boards = []) {
  if (!s) return s;
  let out = s.trim();
  for (const b of boards) {
    const re = new RegExp(`\\s*[|–—\\-]\\s*${b}\\s*$`, 'i');
    out = out.replace(re, '');
  }
  return out.trim();
}
