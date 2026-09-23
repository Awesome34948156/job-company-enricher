// Precedence layer 5 (confidence 0.35): scored-DOM last resort.
//
// Returns the top 3 candidates rather than the top 1 — that's what makes the
// card's "Did you mean?" chips cheap, and it means an ambiguous page degrades to
// a one-click choice instead of a confident wrong answer.

const LEGAL = /\b(limited|ltd\.?|incorporated|inc\.?|corp(?:orat(?:ion|e))?|co\.?|holdings?|group|plc|llc|pte|gmbh)\b|有限公司|集團|集团|控股|股份/i;

const BOARD_NOISE = new Set([
  'linkedin', 'indeed', 'jobsdb', 'glassdoor', 'jobs', 'careers', 'google',
  'microsoft', 'apple', 'apply', 'save', 'share', 'easy apply', 'report this job',
  'job search', 'sign in', 'join now', 'home', 'search', 'settings', 'help',
]);

const ANCHOR_SELECTOR = 'main, article, [role="main"], section, form, div';

/** Max text nodes visited — keeps this from stalling on a huge page. */
const MAX_NODES = 4000;

export function heuristicCandidates(doc = document, jobTitle = null) {
  const scores = new Map();
  const titleLc = jobTitle?.toLowerCase() || '';

  const push = (node, text, base) => {
    const clean = text.replace(/\s+/g, ' ').trim();
    if (!clean || clean.length < 2 || clean.length > 80) return;
    const lc = clean.toLowerCase();
    if (BOARD_NOISE.has(lc)) return;
    if (titleLc && lc === titleLc) return;
    if (/^(apply|save|share|easy apply|report this job|show more|see more)/i.test(clean)) return;
    // Sentence-like text is a description, not a name.
    if (/[.!?]\s/.test(clean)) return;

    const el = node.nodeType === 1 ? node : node.parentElement;
    if (!el) return;
    const hint = `${el.className || ''} ${el.id || ''} ${el.getAttribute?.('data-testid') || ''} ${el.getAttribute?.('data-test') || ''} ${el.getAttribute?.('data-automation') || ''} ${el.getAttribute?.('itemprop') || ''}`.toLowerCase();

    let s = base;
    if (LEGAL.test(clean)) s += 4;
    if (/compan|employer|organi[sz]ation|advertiser|hirer|brand/.test(hint)) s += 3;
    if (el.tagName === 'H2' || el.tagName === 'H3' || el.tagName === 'H4') s += 1;
    if (el.tagName === 'A' && /\/company\//.test(el.getAttribute?.('href') || '')) s += 5;
    if (clean.length <= 40) s += 1;

    const prev = scores.get(clean);
    if (!prev || s > prev.score) scores.set(clean, { score: s, text: clean });
  };

  const titleEl = doc.querySelector('h1');
  const scope = titleEl?.closest(ANCHOR_SELECTOR) || doc.body;
  if (!scope) return [];

  // Anchors first — a link to a company profile is the strongest DOM signal.
  for (const a of scope.querySelectorAll('a[href*="/company/"], a[href*="/cmp/"], a[href*="/about/"]')) {
    push(a, a.textContent || '', 2);
  }

  const walker = doc.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
  let n;
  let seen = 0;
  while ((n = walker.nextNode()) && seen < MAX_NODES) {
    seen++;
    push(n, n.textContent || '', 0);
  }

  return [...scores.values()].sort((a, b) => b.score - a.score).slice(0, 3);
}
