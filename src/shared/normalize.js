// Company-name normalization. Pure — imported by both worlds.
//
// Two keys per name:
//   normalizeCompanyName() — case/punctuation/width folded, everything else kept
//   looseKey()             — legal suffixes stripped, used as the cache key
//
// The loose key is what makes "Acme Ltd.", "ACME LIMITED" and "Acme  Ltd" hit the
// same cache record. The guard against over-normalization is strictKey(): a lookup
// whose strict form is not already in a record's alias list is only a *probable*
// match, and the card says which name the cached data actually describes.

// Only the *legal form* is stripped, never a descriptive word.
//
// "Group" and "Holdings" were originally stripped too, but that collapsed
// "Acme Ltd" and "Acme Group" onto the same cache key — two companies that may
// well be different entities (or a parent and its subsidiary). The cost of being
// too conservative here is one extra cheap lookup; the cost of being too
// aggressive is showing one company's data under another's name. Those are not
// symmetric, so this errs conservative.
const LEGAL_SUFFIX =
  /(?:^|\s)(?:limited|ltd|incorporated|inc|corporation|corp|company|co|plc|llc|pte|gmbh|sarl|nv|bv|ag|kk|pty)(?=\s|$)/g;

const CJK_SUFFIX = /(有限公司|公司)/g;

/** Words too generic to prove two company names refer to the same entity. */
const STOPWORDS = new Set([
  'the', 'and', 'of', 'for', 'a', 'an', 'group', 'holdings', 'holding',
  'international', 'intl', 'global', 'technology', 'technologies', 'tech',
  'limited', 'ltd', 'inc', 'corp', 'corporation', 'company', 'co', 'plc',
  'llc', 'pte', 'gmbh', 'services', 'solutions', 'systems', 'enterprises',
]);

const CJK_STOPCHARS = new Set([
  '有', '限', '公', '司', '集', '團', '团', '控', '股', '份', '企', '業', '业',
  '國', '国', '際', '际', '科', '技', '香', '港', '大', '小', '新', '亞', '亚',
]);

const hasCJK = (s) => /[㐀-鿿]/.test(s);

/**
 * Case/width/punctuation-folded name. NFKC handles full-width → half-width
 * (ＣＯＭＰＡＮＹ → COMPANY) which matters for Chinese-language job boards.
 */
export function normalizeCompanyName(raw) {
  if (!raw) return '';
  let s = String(raw).normalize('NFKC').toLowerCase().replace(/　/g, ' ');
  s = s.replace(/&/g, ' and ');
  s = s.replace(/[.,'"”“()（）\[\]{}·•|/\\!?;:*_~^+=<>@#$%`-]/g, ' ');
  s = s.replace(/[^a-z0-9㐀-鿿 ]/g, ' ');
  return s.replace(/\s+/g, ' ').trim();
}

/** Cache key: normalized with legal suffixes removed. */
export function looseKey(raw) {
  const base = normalizeCompanyName(raw);
  if (!base) return '';
  const stripped = base
    .replace(LEGAL_SUFFIX, ' ')
    .replace(CJK_SUFFIX, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // If stripping removed everything (e.g. the name was literally "Holdings"),
  // fall back to the un-stripped form rather than producing an empty key.
  return stripped || base;
}

/** Full normalized form, legal suffix intact. Used to detect probable matches. */
export function strictKey(raw) {
  return normalizeCompanyName(raw);
}

/**
 * Significant tokens for name↔name agreement scoring. Latin names split on
 * whitespace; CJK names split per character (no word boundaries available)
 * minus the boilerplate characters every HK company name shares.
 */
export function sigTokens(raw) {
  const norm = normalizeCompanyName(raw);
  if (!norm) return [];

  if (hasCJK(norm)) {
    const out = [];
    for (const ch of norm) {
      // Keep CJK; drop Latin noise that rides along in a Chinese name.
      if (!/[㐀-鿿]/.test(ch)) continue;
      if (CJK_STOPCHARS.has(ch)) continue;
      out.push(ch);
    }
    if (out.length) return [...new Set(out)];
    // Every CJK character was boilerplate — "CAI控股" leaves only 控 and 股,
    // "OSL集團有限公司" leaves only 集團有限公司. Returning [] here would make
    // tokenOverlap() report 0, which the ticker gate reads as "different
    // company" when it actually means "couldn't compare", and a correct code
    // gets hidden. Keep the boilerplate instead.
    const cjk = [...norm].filter((ch) => /[㐀-鿿]/.test(ch));
    return [...new Set(cjk.length ? cjk : [...norm].filter((c) => /[a-z0-9]/.test(c)))];
  }

  const words = norm.split(' ');
  const long = words.filter((t) => t.length > 1 && !STOPWORDS.has(t));
  if (long.length) return [...new Set(long)];

  // Names built entirely from initials and boilerplate — "S E A Holdings
  // Limited", "K & P International Holdings Limited", "V.S. International
  // Group Limited". Nothing survives the length filter, so fall back to the
  // initials rather than to an empty set, for the same reason as above.
  const short = words.filter((t) => t.length > 0 && !STOPWORDS.has(t));
  return [...new Set(short.length ? short : words.filter(Boolean))];
}

/**
 * Fraction of `a`'s significant tokens present in `b`. Asymmetric on purpose:
 * "Tencent" vs "Tencent Holdings Ltd" should score 1.0, not 0.5.
 */
export function tokenOverlap(a, b) {
  const ta = sigTokens(a);
  if (!ta.length) return 0;
  const tb = new Set(sigTokens(b));
  let hit = 0;
  for (const t of ta) if (tb.has(t)) hit++;
  return hit / ta.length;
}

/** A token that could be an initialism: all letters, 2–5 of them. */
const ACRONYM_SHAPED = /^[a-z]{2,5}$/;

/** Longest run of words a short initialism is allowed to stand for. */
const MAX_ACRONYM_RUN = 8;

/** Every word of a name — stopwords and legal suffixes included. */
function wordsOf(raw) {
  return normalizeCompanyName(raw).split(' ').filter(Boolean);
}

/**
 * The initialisms a run of words could stand for: from all of them, and from the
 * significant ones only.
 *
 * Both are needed, and the difference is not cosmetic. "Bank of China" is
 * initialised from every word (boc) while "Industrial and Commercial Bank of
 * China" is initialised from the significant ones (icbc) — nobody writes the
 * "and". Testing only the first misses ICBC; only the second misses BOC.
 */
function acronymsOf(run) {
  const all = run.map((w) => w[0]).join('');
  const sig = run.filter((w) => w.length > 1 && !STOPWORDS.has(w)).map((w) => w[0]).join('');
  const out = new Set([all]);
  if (sig.length >= 2) out.add(sig);
  return out;
}

/**
 * The run of `words` that best explains `token`, or null.
 *
 * Scored by how many of `wanted` it accounts for rather than by length, because
 * the goal is coverage: a long run that only re-covers tokens the other side
 * already matched explains nothing new. A run that explains none of them is a
 * coincidence and is rejected outright — that is what stops any five-letter word
 * from being read as somebody's initials.
 */
function bestRun(token, words, wanted) {
  const max = Math.min(MAX_ACRONYM_RUN, words.length);
  let best = null;
  let bestHits = 0;
  for (let len = 2; len <= max; len++) {
    for (let i = 0; i + len <= words.length; i++) {
      const run = words.slice(i, i + len);
      if (!acronymsOf(run).has(token)) continue;
      const hits = run.reduce((n, w) => n + (wanted.has(w) ? 1 : 0), 0);
      if (hits > bestHits) { bestHits = hits; best = run; }
    }
  }
  return best;
}

/**
 * 1 when one name is the other's initialism, 0 otherwise.
 *
 * This exists for a specific, observed failure. "Bank of China (Hong Kong)" and
 * "BOC Hong Kong (Holdings) Limited" are the same company, but they share only
 * two of four and two of three significant tokens, so every token metric scores
 * them 0.5 and the ticker gate hid a *correct* 02388. No threshold fixes that:
 * raising the bar admits China Bohai Bank, lowering it admits everything. The
 * missing fact isn't statistical, it's lexical — BOC stands for Bank of China —
 * so it has to be supplied rather than tuned for.
 *
 * Acceptance is all-or-nothing, and that is the whole design. A bridge fires
 * only when every significant token on *both* sides is accounted for, either by
 * a direct match or by an initialism expansion, so:
 *
 *   Bank of China (Hong Kong)  ↔  BOC Hong Kong (Holdings) Limited   → 1
 *   Bank of China              ↔  BOC Hong Kong (Holdings)           → 0
 *   Industrial & Commercial Bank of China (Asia)  ↔  ICBC            → 0
 *
 * The second and third are the point. Partial coverage is exactly the signature
 * of a parent and its listed subsidiary — "Hong Kong" and "Asia" are the parts
 * left over — and conflating those is the failure this gate exists to prevent.
 * Requiring the leftovers to be empty costs some true positives on sloppily
 * named subsidiaries and buys the guarantee that an acronym alone can never
 * carry a ticker across from a parent to its child.
 *
 * @returns {number} 1 or 0, so it can be `Math.max`ed against a token score
 */
export function acronymOverlap(a, b) {
  if (!a || !b) return 0;
  const sigA = new Set(sigTokens(a));
  const sigB = new Set(sigTokens(b));
  if (!sigA.size || !sigB.size) return 0;

  // Whatever already matches directly needs no bridge, and if one side is fully
  // contained in the other there is nothing left to explain.
  const pendingA = new Set([...sigA].filter((t) => !sigB.has(t)));
  const pendingB = new Set([...sigB].filter((t) => !sigA.has(t)));
  if (!pendingA.size || !pendingB.size) return 0;

  // One direction or the other, never a mixture of both. A name split half
  // across each reading is not an abbreviation, it is two different names, and
  // requiring one side to do all the explaining keeps that distinction.
  const sweep = (pending, other, otherWords) => {
    const rest = new Set(pending);
    for (let pass = 0; pass < rest.size + 1; pass++) {
      let changed = false;
      for (const token of [...rest]) {
        if (!ACRONYM_SHAPED.test(token)) continue;
        const run = bestRun(token, otherWords, other);
        if (!run) continue;
        rest.delete(token);
        for (const w of run) other.delete(w);
        changed = true;
      }
      if (!changed) break;
    }
    return rest.size === 0 && other.size === 0;
  };

  if (sweep(new Set(pendingB), new Set(pendingA), wordsOf(a))) return 1;
  if (sweep(new Set(pendingA), new Set(pendingB), wordsOf(b))) return 1;
  return 0;
}

/** True when two names are plausibly the same company. */
export function sameCompany(a, b, threshold = 0.5) {
  if (!a || !b) return false;
  if (looseKey(a) === looseKey(b)) return true;
  const ab = tokenOverlap(a, b);
  const ba = tokenOverlap(b, a);
  return Math.max(ab, ba) >= threshold;
}

/** Hostname for display in the card's Sources footer. */
export function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/**
 * Canonical HKEX stock code.
 *
 * HKEX codes run from 1 to 99999 and are conventionally written 5 digits, but
 * "700" (Tencent), "5" (HSBC) and "16" (Sun Hung Kai) are all real and are all
 * commonly written unpadded — including by the model. Rejecting those as
 * "too short" would silently drop correct answers, so short codes are padded
 * rather than discarded.
 *
 * @returns {string|null} e.g. "00700", or null if not a plausible code
 */
export function padHkCode(value) {
  const digits = String(value ?? '').replace(/\D/g, '');
  if (!digits) return null;
  const n = Number(digits);
  if (!Number.isFinite(n) || n < 1 || n > 99999) return null;
  return String(n).padStart(5, '0');
}

/** Collapse whitespace and truncate, for prompt context and card text. */
export function clip(s, n) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

/** "500-1,000 employees" for a band, or a formatted exact count. */
export function formatSize(profile) {
  if (!profile) return null;
  if (profile.employeeBand) return profile.employeeBand;
  if (Number.isFinite(profile.employeeCountExact)) {
    return `${profile.employeeCountExact.toLocaleString()} employees`;
  }
  return null;
}
