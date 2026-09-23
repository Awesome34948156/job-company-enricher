// Precedence layer 4 (confidence 0.6): parse the company out of <title> and
// og:title. Refactor-resistant — the document title changes far less often than
// the DOM around it. Also serves as an independent cross-check on layer 1.

const NOISE = /^(linkedin|indeed|jobsdb|glassdoor|jobs?|careers?|hiring|job search)\b/i;

/** Ordered patterns; first capture group is the company name. */
const PATTERNS = [
  // "Senior Engineer - Acme HK Ltd | LinkedIn"  /  "... at Acme HK Ltd"
  /\s[-–—|]\s*([^|–—]{2,60}?)\s*(?:\||$)/,
  /\bat\s+([A-Z][^|–—(]{1,60}?)\s*(?:\||[-–—(]|$)/,
  // "Acme HK Ltd hiring Senior Engineer"
  /^(.{2,60}?)\s+(?:hiring|is hiring|vacancy|job opening)/i,
  // "Senior Engineer job in Kwun Tong - Acme HK Ltd"
  /\bjob in .*?[-–—]\s*(.{2,60}?)\s*(?:\||$)/i,
];

function candidatesFromString(s) {
  if (!s) return [];
  const out = [];
  for (const re of PATTERNS) {
    const m = s.match(re);
    if (m?.[1]) {
      const cleaned = m[1].replace(/\s+/g, ' ').trim().replace(/[.,;:]+$/, '');
      if (cleaned && cleaned.length >= 2 && !NOISE.test(cleaned)) out.push(cleaned);
    }
  }
  return out;
}

export function extractFromTitle(doc = document) {
  const title = doc.title || '';
  const og = doc.querySelector('meta[property="og:title"]')?.getAttribute('content') || '';
  const ogSite = doc.querySelector('meta[property="og:site_name"]')?.getAttribute('content') || '';

  const pool = [title, og].flatMap(candidatesFromString).filter((c) => {
    // The board's own name is not the employer.
    if (ogSite && c.toLowerCase() === ogSite.toLowerCase()) return false;
    return true;
  });

  if (!pool.length) return null;
  return { candidates: [...new Set(pool)].slice(0, 3) };
}

/**
 * The <h1> is usually the job title, not the company — but on a couple of
 * boards it's the company. Kept separate so the caller can decide.
 */
export function visibleJobTitle(doc = document) {
  const h1 = doc.querySelector('h1');
  const t = h1?.textContent?.replace(/\s+/g, ' ').trim();
  return t && t.length < 160 ? t : null;
}
