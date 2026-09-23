// schema.org JobPosting extraction from <script type="application/ld+json">.
//
// This is precedence layer 1 (confidence 0.95) because the markup is published
// for Google Jobs and therefore survives the CSS refactors that break every
// DOM-selector-based approach.

/** Parse every ld+json block on the page. Bad blocks are skipped, not fatal. */
export function collectJsonLd(doc = document) {
  const out = [];
  for (const s of doc.querySelectorAll('script[type="application/ld+json"]')) {
    const raw = s.textContent?.trim();
    if (!raw) continue;
    try {
      out.push(JSON.parse(raw));
    } catch {
      // Some boards HTML-escape the payload inside the script tag.
      try {
        const unescaped = raw
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'")
          .replace(/&apos;/g, "'")
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&amp;/g, '&');
        out.push(JSON.parse(unescaped));
      } catch {
        /* give up on this block only */
      }
    }
  }
  return out;
}

const typeMatches = (node, want) => {
  const t = node['@type'];
  const types = Array.isArray(t) ? t : [t];
  return types.some((x) => typeof x === 'string' && x.toLowerCase() === want);
};

/** Depth-first search for every JobPosting node, through @graph and arrays. */
export function findJobPostings(doc = document) {
  const blocks = collectJsonLd(doc);
  const acc = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const n of node) walk(n);
      return;
    }
    if (typeMatches(node, 'jobposting')) acc.push(node);
    if (node['@graph']) walk(node['@graph']);
    // A listing page sometimes nests postings under itemListElement.
    if (node.itemListElement) walk(node.itemListElement);
  };
  for (const b of blocks) walk(b);
  return { postings: acc, blocks };
}

/** Find a node by its local `@id` reference (e.g. "#organization") anywhere in a block. */
function findByAtId(node, id) {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const n of node) {
      const hit = findByAtId(n, id);
      if (hit) return hit;
    }
    return null;
  }
  if (node['@id'] === `#${id}`) return node;
  for (const key of ['@graph', 'itemListElement', 'mainEntity', 'about']) {
    if (node[key]) {
      const hit = findByAtId(node[key], id);
      if (hit) return hit;
    }
  }
  return null;
}

/**
 * hiringOrganization can be a string, an object with `name`, an array, or
 * `{"@id": "#org"}` resolvable elsewhere in @graph. That last shape is common
 * on WordPress/ATS-generated pages and is why this can't be a one-liner.
 */
export function orgNameFrom(jobPosting, blocks = []) {
  if (!jobPosting) return null;
  let org = jobPosting.hiringOrganization;
  if (Array.isArray(org)) org = org[0];
  if (typeof org === 'string') return org.trim() || null;
  if (org && typeof org.name === 'string') return org.name.trim() || null;
  if (org && typeof org['@id'] === 'string') {
    const id = org['@id'].replace(/^#/, '');
    for (const b of blocks) {
      const found = findByAtId(b, id);
      if (found?.name) return String(found.name).trim() || null;
    }
  }
  return null;
}

/** "Kwun Tong, Hong Kong" from jobLocation.address, tolerating all its shapes. */
export function locationFrom(jobPosting) {
  if (!jobPosting) return null;
  let loc = jobPosting.jobLocation;
  if (Array.isArray(loc)) loc = loc[0];
  if (!loc) return null;
  const addr = Array.isArray(loc.address) ? loc.address[0] : loc.address;
  if (typeof addr === 'string') return addr.trim() || null;
  if (!addr || typeof addr !== 'object') {
    return typeof loc.name === 'string' ? loc.name.trim() || null : null;
  }
  const parts = [
    addr.addressLocality,
    addr.addressRegion,
    addr.addressCountry && (typeof addr.addressCountry === 'string' ? addr.addressCountry : addr.addressCountry.name),
  ].filter((p) => typeof p === 'string' && p.trim());
  // Dedupe: HK postings very often repeat "Hong Kong, Hong Kong".
  const seen = new Set();
  const uniq = parts.filter((p) => {
    const k = p.trim().toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return uniq.length ? uniq.join(', ') : null;
}

/**
 * Layer 1. Prefers a posting whose title matches the visible <h1>, so that a
 * listing page containing many postings doesn't return an arbitrary one.
 */
export function extractFromJsonLd(doc = document) {
  const { postings, blocks } = findJobPostings(doc);
  if (!postings.length) return null;

  const h1 = doc.querySelector('h1')?.textContent?.trim().toLowerCase() || '';
  let best = postings[0];
  if (h1 && postings.length > 1) {
    const match = postings.find((p) => typeof p.title === 'string' && p.title.trim().toLowerCase() === h1);
    if (match) best = match;
  }

  const name = orgNameFrom(best, blocks);
  if (!name) return null;

  return {
    name,
    jobTitle: typeof best.title === 'string' ? best.title.trim() || null : null,
    location: locationFrom(best),
    datePosted: typeof best.datePosted === 'string' ? best.datePosted : null,
  };
}
