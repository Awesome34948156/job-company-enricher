// Extraction regression tests. Run from the repo root:
//
//   osascript -l JavaScript test/extraction.js
//
// JavaScriptCore is the only JS runtime on this machine, so the harness loads the
// real modules by stripping their `import`/`export` keywords and evaluating them
// together in one scope. The tests therefore point at the shipped source rather
// than at a copy of it.
//
// The case that matters is the first block. A real JobsDB search-results <title>
// ends in the listing period, the title pattern reads the last dash-separated
// segment, and "Sep 2026" once went out as a company name to be searched for.

ObjC.import('Foundation');

function read(path) {
  const s = $.NSString.stringWithContentsOfFileEncodingError(path, $.NSUTF8StringEncoding, null);
  if (s.isNil()) throw new Error('cannot read ' + path + ' — run this from the repo root');
  return ObjC.unwrap(s);
}

/** Strip module syntax so the sources can share a single eval scope. */
const strip = (src) => src.replace(/^import .*?;\s*$/gm, '').replace(/^export /gm, '');

const SOURCES = [
  'src/shared/normalize.js',
  'src/shared/schema.js',
  'src/content/extract/title.js',
  'src/content/extract/adapters/jobsdb.js',
];

const api = new Function(
  SOURCES.map((p) => strip(read(p))).join('\n') + '\n' +
  'return { isPlausibleCompanyName, looksLikeDate, looksLikeAmount, candidatesFromString, PATTERNS, titleIsReliable, POSTING_PATH, validateReport };'
)();

const { isPlausibleCompanyName, looksLikeDate, looksLikeAmount,
        candidatesFromString, PATTERNS, titleIsReliable, POSTING_PATH, validateReport } = api;

let fails = 0;
let total = 0;

function ok(cond, label, detail) {
  total++;
  if (!cond) { fails++; console.log('FAIL  ' + label + (detail ? '   [' + detail + ']' : '')); }
}
function eq(got, want, label) {
  ok(got === want, label, 'got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want));
}
function all(list, pred, label) {
  for (const s of list) ok(pred(s), label + ': ' + JSON.stringify(s));
}

// ---------- the shipped bug, verbatim from the live page ----------
const REAL_TITLE = 'Data Centre Jobs in Sha Tin District - Sep 2026 | Jobsdb';

// The old behaviour, pinned so the test proves the pattern was the cause.
eq((REAL_TITLE.match(PATTERNS[0]) || [])[1], 'Sep 2026',
   'pattern[0] alone still reads the date — this is what shipped');

eq(candidatesFromString(REAL_TITLE).length, 0, 'real title now yields no candidates');
eq(candidatesFromString('Jobs in Sha Tin District - Sep 2026 | Jobsdb').length, 0,
   'the other real search-page title shape yields none');

// ---------- dates are rejected ----------
all(['Sep 2026', 'September 2026', 'sep-2026', 'Sep. 2026', '2026 Sep', '2026',
     '2026-09-23', '23/09/2026', '09-2026', '2026/09', 'Sep - Oct 2026',
     'Sep 2026 - Oct 2026', '30d+ ago', 'Posted 30d+ ago', 'Posted 2 weeks ago',
     '3 days ago', 'just posted', 'Posted'],
    (s) => looksLikeDate(s) && !isPlausibleCompanyName(s), 'date rejected');

// ---------- amounts are rejected ----------
all(['HK$370,000', '$1.2M', '370,000 HKD', 'HK$30,000', '$85,000'],
    (s) => looksLikeAmount(s) && !isPlausibleCompanyName(s), 'amount rejected');

// ---------- real employers survive ----------
all(['Rm Staffing Bv', 'Tai Hing Worldwide Development Ltd', 'Tencent Holdings Ltd',
     'BOC Hong Kong (Holdings) Limited', 'OSL集團有限公司', 'CAI控股',
     'K & P International Holdings Limited', 'S E A Holdings Limited', '3M', '7-Eleven',
     'Bank of China (Hong Kong)', 'ABC Limited', 'May Chow Limited', '1,000 Islands Ltd'],
    (s) => !looksLikeDate(s) && !looksLikeAmount(s) && isPlausibleCompanyName(s), 'name survives');

// ---------- the model does not get to write on the card ----------
//
// `notes` was a model-authored field and the model wrote essays in it: every
// lookup ended in an orange paragraph restating the fields already on screen.
// It is now machine-only. The field still carries the repair suffix, so the two
// halves are asserted separately — dropping the model's prose must not drop the
// diagnostics with it.
const MODEL_ESSAY =
  'Results describe the employer as the Hong Kong-based mobile game developer '
  + "commonly known as 'Madhead' (developer of 神魔之塔), with jobs in Sha Tin "
  + 'District; no HKEX stock code appears, so hkListing is left null rather than guessed.';

const clean = validateReport({
  companyName: 'Madhead', matchedEntity: null,
  hkListing: {}, profile: {}, reputation: {}, sources: [],
  notes: MODEL_ESSAY,
});
eq(clean.report.notes, null, "a model-authored notes field is dropped");
ok(!String(clean.report.notes || '').includes('Madhead'),
   'the essay text does not survive into the report');

// A repair must still reach the card, even though the model's prose no longer does.
// `hkListing: null` is the trigger — a non-object there is a repair, where `{}` is not.
const repaired = validateReport({
  companyName: 'Madhead', hkListing: null, profile: {}, reputation: {}, sources: [],
  notes: MODEL_ESSAY,
});
ok(repaired.repairs.length > 0, 'the malformed payload is still reported as repaired');
ok(/^\[repaired: /.test(repaired.report.notes || ''),
   'repairs still land in notes, now without the prose', JSON.stringify(repaired.report.notes));

// ---------- junk ----------
all(['2026', '30', '', ' ', '12345', '$'], (s) => !isPlausibleCompanyName(s), 'junk rejected');

// ---------- which paths serve a posting ----------
//
// `/jobs/` has a trailing slash and the company job list is a slug ending in
// `-jobs` with none, so one `\/jobs?\//` covered the first and missed the second
// entirely. The pane was on screen with its hooks populated and the card still
// asked for a name it could have read — confirmed against the live page.
all(['/job/74221881', '/jobs/in-Sha-Tin-District', '/jobs/in-Sha-Tin-District/',
     '/Advanced-Biomedical-Instrumentation-Centre-Limited-jobs'],
    (p) => POSTING_PATH.test(p), 'path serves a posting');
all(['/', '/jobs', '/job', '/companies/Advanced-Biomedical', '/career-advice',
     '/Advanced-Biomedical-jobs-old'],
    (p) => !POSTING_PATH.test(p), 'path does not serve a posting');

// ---------- title reliability by URL shape ----------
const U = (href) => {
  const m = href.match(/^([^?#]*)(\?.*)?$/);
  return { pathname: m[1], search: m[2] || '' };
};
eq(titleIsReliable(U('/jobs/in-Sha-Tin-District?jobId=74221881')), false,
   'search shape: title describes the search, not the posting');
eq(titleIsReliable(U('/job/74221881')), true, 'standalone posting: title names the employer');
eq(titleIsReliable(U('/jobs/in-Sha-Tin-District')), true, 'no jobId: not the search shape');
eq(titleIsReliable(null), true, 'no URL: default to reading the title');

console.log(fails === 0
  ? 'extraction: all ' + total + ' assertions pass'
  : 'extraction: ' + fails + ' of ' + total + ' FAILED');
if (fails !== 0) throw new Error('extraction tests failed');
