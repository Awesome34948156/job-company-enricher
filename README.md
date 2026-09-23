# Job Company Enricher

A Chrome extension (Manifest V3) that reads the company name off a job posting and shows a
floating card with the things you actually want to know before applying:

- **Company size** — employee band, HQ, founded year, industry
- **HK listing status** — is it listed on HKEX, and under what stock code
- **Reputation** — rating, sentiment, layoffs, lawsuits, red flags

Every claim is sourced, and the company name is always click-to-edit when extraction gets it
wrong. Works on LinkedIn Jobs, Indeed, JobsDB (HK), and Glassdoor.

---

## Setup

1. **Load it.** `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select
   this folder.
2. **Get two API keys.**
   - [Serper](https://serper.dev) — web search. Free tier is 2,500 credits (~830 companies).
   - [DeepSeek](https://platform.deepseek.com) — the model that reads the search results.
3. **Add them.** Click the extension's toolbar icon (or *Details → Extension options*), paste
   both keys, read and tick the security notice, then **Test keys**.

After any source edit: reload the extension **and then reload the target tab**. Content scripts
don't hot-reload, and an already-open LinkedIn tab keeps running the old one.

### What leaves your browser

The **company name and job title are sent** to Serper (as a search query) and to DeepSeek (as
prompt context). That's the unavoidable cost of the feature. Nothing else about you or the page
is transmitted, there's no analytics, and there's no server of ours in the path.

### Security notice

- Keys are stored in `chrome.storage.local`, **deliberately not `chrome.storage.sync`** — `sync`
  replicates them to every Chrome profile signed into the same Google account.
- They are stored **unencrypted** in your browser profile. This is built for **personal, local
  use**.
- **Do not publish this in its current form.** An extension that ships an API key ships that key
  to everyone who installs it. Fixing that properly means a backend proxy that holds the keys and
  the extension talks to that instead — obfuscating the key in the client only raises the effort,
  it doesn't solve it.

---

## How it works

The one architectural fact everything follows from: **DeepSeek has no server-side web search.**
(Anthropic's API has a `web_search` tool that would make this a single call; DeepSeek does not.)
So the extension has to be the search client itself, and the pipeline is three hops:

```
content script                     service worker                          content script
──────────────                     ──────────────                          ──────────────
extract company name   ──────▶  cache hit? ──yes──▶ return instantly
(Port, not sendMessage)              │ no
                                     ▼
                                Serper fan-out (3 queries, Promise.allSettled)
                                     ▼
                                trim to ~3k tokens + drop irrelevant results
                                     ▼
                                DeepSeek JSON mode (temperature 0.1)
                                     ▼
                                validateReport() → repair, never throw
                                     ▼
                                verify ticker against HKEX dataset
                                     ▼
                                 cache per group    ──────────────────▶  render card
```

Design rule: a failure in hop 2 degrades to a *usable* card, and a failure in hop 1 degrades to a
*user-editable field* — never to a confident wrong answer.

The content script and service worker talk over a **long-lived port** (`chrome.runtime.connect`),
not one-shot `sendMessage`, for two reasons: a lookup takes 3–15s so an open port with a 20s
keepalive stops the MV3 worker being killed mid-flight, and progress stages can render
("Searching…" → "Analyzing 12 results…" → "Verifying ticker…") instead of an opaque spinner.

### Source layout

```
manifest.json
icons/
src/
├── shared/          imported by BOTH worlds — pure ESM, no chrome.*, no DOM
│   ├── constants.js   URLs, TTLs, caps, message + error enums
│   ├── normalize.js   name normalization → looseKey/strictKey, padHkCode
│   ├── schema.js      COMPANY_SCHEMA literal + validateReport()
│   └── prompts.js     system prompt, context trimming, relevance filter
├── background/
│   ├── service-worker.js  entry: port + control-message wiring
│   ├── pipeline.js        orchestrates cache → search → LLM → verify → cache
│   ├── cache.js           per-group TTL records + LRU index
│   ├── ratelimit.js       token buckets + daily budgets
│   ├── serper.js          search client + query templates
│   ├── deepseek.js        chat client + retry
│   ├── http.js            fetch with timeout + retry + logged error bodies
│   └── hkex.js            dataset download/cache + ticker verification
├── content/
│   ├── bootstrap.js   the ONLY classic script; dynamic-imports main.js
│   ├── main.js        nav detect → extract → request → render
│   ├── nav.js         SPA navigation detection + DOM-settle debounce
│   ├── port.js        port lifecycle, keepalive, retry-on-disconnect
│   ├── extract/       layered extractor: jsonld · adapter · linkSlug · title · heuristic
│   └── ui/            card.js · rows.js · styles.js (Shadow DOM)
└── options/           options.html · options.css · options.js
```

**No build step.** Plain JS, no bundler, no npm. `src/shared/*` must stay pure — it's the only
code that runs in both the page and the worker, so a stray `chrome.*` or `document` there breaks
one of them.

---

## The decisions worth knowing

### `bootstrap.js` exists because MV3 content scripts can't be ES modules

`"type": "module"` is valid on `background` only. So `bootstrap.js` is a classic script whose
whole job is a dynamic import:

```js
const url = chrome.runtime.getURL('src/content/main.js');
try { (await import(url)).start(); }
catch (err) { console.error('[JCE] content module failed to load', url, err); }
```

Two consequences that bite silently:

- Every module reachable from `main.js` must be listed in `web_accessible_resources`. **A wrong
  glob fails at runtime with no load-time error** — the extension loads fine, the card just never
  appears. If you add a directory, add it to that array.
- `"use_dynamic_url": false` is required. With the default, Chrome rotates the extension origin
  per session, which can break `import(chrome.runtime.getURL(...))` with a CSP error.

### `isListed` is a three-state boolean

`true` / `false` / `null`. A two-state boolean forces the model to guess, and a confident `false`
("not listed") is exactly as damaging as a wrong ticker when the truth is "we didn't find the
annual report". The card renders the difference; `Not HK-listed` and `Not found` are not the same
statement.

### Per-group cache TTLs, not one record-level TTL

A single TTL would be wrong in both directions — re-fetching immutable listing dates forever, and
serving "not listed" for a company that IPO'd last week.

| Group | TTL | Why |
|---|---|---|
| `profile` | 7 days | Size/HQ/founded change slowly |
| `hkListing` when `true` | 365 days | Code, board and date are immutable |
| `hkListing` when `false` | **14 days** | **A company can IPO later** |
| `hkListing` when `null` | 14 days | "No evidence" isn't stable either |
| `reputation` | 3 days | Layoffs are news; a month-old "no negative news" is a lie |

Partially-stale lookups answer **twice**: immediately with the fresh groups (card renders
instantly, stale rows pulse "refreshing…"), then again over the port when the missing groups land.
That two-phase response is what makes repeat views feel instant.

Cache keys use `looseKey()` (legal form stripped), so `"Acme Ltd."`, `"ACME LIMITED"` and
`"Acme  Ltd"` collide. Records keep a `strictKeys[]` alias list: a lookup whose strict form isn't
already in it is only a *probable* match — still returned, but the card shows which name the
cached data actually describes.

`Group` and `Holdings` are **not** stripped. Stripping them collapsed `"Acme Ltd"` and
`"Acme Group"` onto one key — two companies that may well be different entities. The cost of being
too conservative here is one extra cheap lookup; the cost of being too aggressive is showing one
company's data under another company's name. Those aren't symmetric.

### A name is checked for plausibility, not just for confidence

Precedence answers *which layer to trust*. It does not answer *whether the string is a name at
all* — and conflating those two questions is what put **`Sep 2026`** on the card as a company.

JobsDB stamps its search-results `<title>` with the listing period:

```
Data Centre Jobs in Sha Tin District - Sep 2026 | Jobsdb
```

The title pattern takes the last dash-separated segment, so it read a date as the employer. Every
layer above it had stayed silent — which is precisely when the title layer speaks — and nothing
objected, because the string was the right *length*, in the right *place*, and only its *meaning*
was wrong. A confidently wrong name is also an API call spent on a nonsense query.

`isPlausibleCompanyName()` in [src/shared/normalize.js](src/shared/normalize.js) now sits in front
of the precedence sort and rejects what is certainly not an employer: dates (`Sep 2026`,
`2026-09-23`, `30d+ ago`), amounts (`HK$370,000`, `370,000 HKD`), and bare numbers. It is applied
**once, before the sort**, rather than inside each layer — a rejected name must not merely lose to
the winner, it must not be *promoted* into its place. Two consequences follow:

- A **JobsDB search page never consults the title layer.** That title describes the search, not
  the posting; an adapter declares this with the optional `titleIsReliable(url)` hook.
- Extraction **retries for up to 4 s when a pass finds no name.** JobsDB renders the posting pane
  client-side, so the first pass can read a DOM with no advertiser in it — the emptiness that made
  a weak fallback reachable in the first place. A page that yields a name never pays this.

The costs aren't symmetric, so the gate errs toward rejecting: a false rejection leaves an editable
empty field, one keystroke from correct, while a false accept is a confident wrong answer.

### The ticker is verified, never trusted

The stock code is the field most likely to be confidently wrong: a pattern-matched 4-digit number
looks exactly like a correct answer. Two layers gate it:

1. **Name↔code agreement** against the HKEX listed-securities dataset — significant-token overlap
   of **≥0.8 in both directions** with the dataset's English *or* Chinese name. Two-way matters:
   one-way containment scored `"Bank of China"` as a 1.0 match for `China Bohai Bank` (09668),
   because every token of the short name appears in the longer one — a *wrong* ticker shown as
   verified, the worst outcome this file exists to prevent. Two-way agreement cuts the number of
   cross-matching pairs across the real dataset from **49,860 to 61**, and the survivors are
   genuinely confusable namesakes (`Swire Pacific 'A'`/`'B'`, `Poly Property Group`/`Poly Property
   Services`).
2. **A Yahoo quote probe** — confirms the code exists. Note the padding mismatch: HKEX is 5-digit
   (`00700`), Yahoo is 4-digit (`0700.HK`). Layer 2 runs only if layer 1 failed for a reason other
   than a name mismatch, so the common case costs no extra request.

The ticker renders inline only when one of: layer 1 passed, **or** `confidence ≥ 0.8` with an
`hkexnews.hk`/`hkex.com.hk` URL in `evidenceUrls`, **or** layer 2 passed with `confidence ≥ 0.7`.
Below that there are two more tiers: a proposed code at `confidence ≥ 0.5` renders as
`HK listed ✓ Ticker unconfirmed` with the code in a tooltip only, and below 0.5 the code isn't
shown at all. The full gate is `listingGate()` in [src/content/ui/rows.js](src/content/ui/rows.js).

Note the padding tolerance: `700` (Tencent), `5` (HSBC) and `16` (Sun Hung Kai) are real codes commonly
written unpadded — including by the model — so short codes are **padded, not rejected**. There's a
test for this; rejecting them silently dropped correct answers.

### The page CSP can't break the card

The card mounts in a **Shadow DOM** with `all: initial`, and styles come from a
**constructable stylesheet** (`adoptedStyleSheets`) rather than an injected `<style>` tag.
`adoptedStyleSheets` isn't subject to page CSP, so a strict-CSP site can't refuse the styling.
Dark mode is free via `@media (prefers-color-scheme: dark)` inside the shadow root.

---

## Adding a site adapter

Adapters are the *second* extraction layer (confidence 0.85), after schema.org JSON-LD and before
`<title>` parsing. Adding one takes two files plus a manifest edit.

**1. Write the adapter** — `src/content/extract/adapters/example.js`:

```js
import { firstText } from './shared.js';

export const id = 'example';

export function match(url) {
  return /(^|\.)example\.com$/.test(location.hostname) && /\/job\//.test(url.pathname);
}

export function extract(doc = document) {
  return {
    name:     firstText(doc, ['[data-testid="company-name"]', 'h1 + a'], { max: 100 }),
    jobTitle: firstText(doc, ['[data-testid="job-title"]', 'h1'],     { max: 160 }),
    location: firstText(doc, ['[data-testid="location"]'],            { max: 100 }),
  };
}
```

`shared.js` gives you `firstText(doc, selectors, {max})` (first non-empty match, truncated),
`companyLinkText`, `nameFromCompanySlug`, and `stripBoardSuffix`.

`extract` is called as `extract(doc, url)` — JobsDB reads the URL to scope a search page to the
selected posting's pane. One further export is optional:

```js
// Return false when <title> describes the page rather than the posting, so the
// title layer is skipped for this shape. Defaults to true when omitted.
export function titleIsReliable(url) {
  return !isSearchShape(url);
}
```

Only JobsDB needs it. Add it if your board puts anything other than the employer in the page
title — a search term, a location, a date.

**2. Register it** in `src/content/extract/index.js`:

```js
import * as example from './adapters/example.js';
const ADAPTERS = [linkedin, indeed, jobsdb, glassdoor, example];
```

**3. Widen the manifest.** The adapter file is inside `src/content/extract/adapters/*.js`, which is
already a `web_accessible_resources` glob, so that part needs nothing. But you must add the site's
URL patterns to **both** the `content_scripts[0].matches` array and the
`web_accessible_resources[0].matches` array. Missing the second one means the module can't be
dynamic-imported and the card silently never appears.

**How to find selectors that survive:** prefer `data-testid` / `data-test` / `data-automation` /
`aria-label` attributes over class names. LinkedIn's `css-*` classes are generated and change
constantly — the LinkedIn adapter deliberately never touches them. Company-profile links
(`a[href*="/company/"]`) are a good fallback since the slug is machine-readable.

**Test against JobsDB first.** It uses explicit `data-automation` attributes and has by far the
most stable DOM of the four. If extraction fails there, the bug is in the extractor logic, not in
rotted selectors — which is exactly what you want when debugging a new site.

Selectors will rot. All four sites ship DOM changes continuously; budget for patching adapters
every few months. JSON-LD usually wins anyway, and the editable name field is the backstop.

---

## Debugging

| What | Where |
|---|---|
| Service worker | `chrome://extensions` → the *service worker* link. Reads "inactive" when idle — click to wake. |
| Content script | The page's own DevTools console, filtered to `[JCE]`. Off by default — run `window.__jce_debug = true` in that console to enable it without editing the source. |
| Storage | SW console → `await chrome.storage.local.get(null)` |
| Errors | Options page → **Diagnostics** (last 20, exportable as JSON with keys redacted) |

Two manual hooks are exposed on the service worker for driving the pipeline by hand:

```js
await __jce_enrich('Tencent Holdings')   // run a full lookup, returns the report
await __jce_storage()                    // dump cache + dataset state
```

`http.js` logs `[JCE] <status> <url> <first 300 chars of body>` on every non-2xx. This is
deliberate — 401 (bad key), 429 (rate limited) and 402 (DeepSeek out of credit) are
indistinguishable without the response body.

### Checks worth running

- **Cache:** enrich Tencent twice. Second returns in <50ms with `meta.fromCache: true`.
- **Negative case — the one that matters:** enrich a *fictional* company. Every field `null`, no
  invented ticker. A model that invents a ticker for a fictional company has failed, no matter how
  good it looks on Tencent.
- **SPA:** click through 5 LinkedIn jobs without reloading. Exactly 5 enrichments, no duplicates,
  and job N never shows job N−1's company.
- **Error surfacing:** revoke the Serper key. The card must read "Serper rejected the API key (401)"
  and Diagnostics must gain a matching row. Never "Something went wrong."
- **Gate:** hand-edit a cached record to a wrong stock code. The card must drop to "unconfirmed",
  not display it.
- **Which layer won:** set `window.__jce_debug = true`, then load a job page. The console prints
  `<name> | <source> | <confidence>`, e.g. `Rm Staffing Bv | adapter:jobsdb | 0.85`. Read it
  whenever a name looks wrong — the source is the whole diagnosis. A `jsonld` or `adapter` source is
  a real DOM hit; `title` means every stronger layer was silent, and `heuristic` should be rare
  enough to be worth a look on its own.

---

## Known limitations

- **Milestones A and B are both implemented** — extraction, options, the full pipeline, the card,
  SPA navigation, all four adapters, HKEX verification, per-group TTLs, budgets and LRU eviction.
  The card is **draggable** by its header and remembers where you put it; double-clicking the
  header returns it to the default (middle-right). One thing is deliberately **not** built: the
  optional **Phase 11** "look up selected company" context menu on any site — that one needs
  `contextMenus` + `scripting` + `tabs`, which is a real permission increase, so it's a
  deliberate step rather than a default.
- The HKEX dataset carries **no listing date and no board** — it's code + English name + Chinese
  name only. Its job is deliberately narrow (name↔code agreement); dates and boards come from the
  model's reading of HKEX evidence URLs, and render only when that evidence exists.
- The dataset URL is a **setting, not a constant** — upstream is a CI-refreshed file with a
  generated-looking name, so it can move. On download failure the extension falls back to a
  built-in 40-company list and degrades to "unconfirmed" rather than to a wrong answer.
- Free-tier budgets default to 400 Serper / 150 DeepSeek per day, surfaced on the options page so
  consumption is never a surprise. Reset at local midnight via `chrome.alarms`.
- Keys in `chrome.storage.local` means this is a single-user tool. See the security notice above.

---

## Verification status

**The pipeline is verified end to end against live Serper and DeepSeek.** A real lookup on
Tencent Holdings returns `isListed: true`, `stockCode: "00700"`, `board: "Main Board"`, and
`meta.verification` of `{ok: true, code: "00700", overlap: 1, layer: 1}` — ticker confirmed
against the official HKEX list.

The ticker gate is tested against **all 2384 rows of the real HKEX dataset**, not a sample:
every company verifies against its own English name *and* its own Chinese name, and a different
company on a real code is still rejected. That bulk test is what caught two bugs a spot-check
never would have — see below.

The 19-assertion gate suite also pins the precision side: wrong tickers that used to pass
(`China Bohai Bank` for `Bank of China`, `JD.com` for `JD Health`, `Kingsoft Corp` for
`Kingsoft Cloud`) are now rejected, while the correct codes still verify.

Static checks: all 29 modules parse clean under JavaScriptCore, a lexical balance checker reports
0 problems, and a 67-assertion logic suite covers name normalization, ticker verification and
padding, schema repair and coercion, and context trimming.

`test/extraction.js` covers extraction and is committed: run it from the repo root with
`osascript -l JavaScript test/extraction.js`. It pins the name-plausibility gate and the JobsDB
title-shape rule — including the exact search-page title that shipped `Sep 2026`, so the pattern
that caused it stays documented as the thing under test rather than as a story in a commit message.

### Three bugs worth knowing about

All three were found by running the ticker gate against the real dataset rather than spot-checking
it. The first two share a shape — an honest "couldn't tell" being reported as a confident "no", so
a *correct* ticker got hidden. The third is the opposite and worse: a confident "yes" for a
*wrong* ticker.

1. **`engName`, not `enName`.** The upstream dataset spells the English field with a **g**. The
   lookup used `enName`, so `en` came back empty for all 2384 rows and a search in English could
   only ever be compared against the Chinese name — meaning **every English-language lookup failed
   verification** and hid a correct ticker. The normalized cache carries a `DATASET_SHAPE` version
   so a cache written by the old mapping re-downloads instead of being served for 30 days.
2. **`sigTokens()` could return an empty set.** Names built from initials and boilerplate
   (`S E A Holdings Limited`, `K & P International Holdings Limited`) or from CJK boilerplate alone
   (`CAI控股`) left nothing after filtering. `tokenOverlap()` returns `0` for an empty set, which the
   gate reads as "different company" when it means "couldn't compare". It now falls back to the
   initials/boilerplate rather than to nothing.
3. **One-way name matching accepted wrong companies.** `tokenOverlap(a, b)` asked only how much of
   `a` appeared in `b`, so a short query made of generic words scored 1.0 against any name
   containing them — `"Bank of China"` matched `China Bohai Bank` (09668) perfectly. Reachable in
   practice: BOC and BOC Hong Kong (02388) are different listed entities that both get written as
   "Bank of China" on job ads. Now requires ≥0.8 agreement in both directions.
4. **Two-way matching broke the other BOC listing** — the fix for (3) is what caused this, and it
   is the one worth reading if you touch the gate. `"Bank of China (Hong Kong)"` against the real
   dataset name `"BOC Hong Kong (Holdings) Limited"` shares only two of four and two of three
   significant tokens, so two-way agreement is `min(0.5, 0.67) = 0.5` and a **correct** `02388` was
   hidden. No threshold rescues this: (3)'s false positive scores 0.67, this true positive scores
   0.5, so the two are not separable by any cut. The missing fact is lexical, not statistical — BOC
   *is* Bank of China — so `acronymOverlap()` supplies it instead of tuning for it. It returns 1
   only when **every** significant token on both sides is accounted for, directly or by expanding
   an initialism into a run of words. That all-or-nothing rule is the design: partial coverage is
   the signature of a parent and its listed subsidiary, so `"Bank of China"` ↔ `"BOC Hong Kong
   (Holdings)"` (leftover: Hong Kong) and `"ICBC Asia"` ↔ `"ICBC"` (leftover: Asia) both stay
   rejected while the real pair passes. It also fixes `"Industrial and Commercial Bank of China"`
   ↔ `"ICBC"`, which the initialism comes from the significant words only — nobody writes the "and".

Known gap, deliberately left rejected: `"CK Hutchison"` ↔ `"CKH"` needs `CK` to count as an
abbreviation *inside* one. Safe direction — the ticker falls back to unconfirmed, it is never
shown wrong.

If you change the dataset URL, check the field names first — a silent mismatch here does not throw,
it just makes the headline feature answer "no" for everyone.

Exercised against live pages: the card on a JobsDB posting (both URL shapes) and SPA navigation
between postings. Not yet exercised: the error paths (revoked key, rate limit, budget exhausted)
and LinkedIn/Indeed/Glassdoor, which have never been loaded by a real browser.
