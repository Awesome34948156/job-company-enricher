// Shared constants. This module is imported by BOTH the content script and the
// service worker, so it must stay pure — no `chrome.*`, no DOM access.

export const VERSION = '0.1.0';

// ---------------------------------------------------------------- providers

export const DEEPSEEK_DEFAULT_BASE = 'https://api.deepseek.com';
export const DEEPSEEK_DEFAULT_MODEL = 'deepseek-flash';

export const SERPER_SEARCH_URL = 'https://google.serper.dev/search';
export const SERPER_NEWS_URL = 'https://google.serper.dev/news';

// HKEX listed-securities dataset (code + English name + Chinese name).
// Upstream is a CI-refreshed file with a generated-looking filename, so this is
// treated as a user-editable setting rather than a hard constant.
export const HKEX_DATASET_DEFAULT_URL =
  'https://raw.githubusercontent.com/jacktth/ga-hk_stock_info/main/hk-listings/date.json';

export const YAHOO_CHART_URL = 'https://query1.finance.yahoo.com/v8/finance/chart';

// -------------------------------------------------------------------- cache

export const CACHE_PREFIX = 'co:';
export const CACHE_INDEX_KEY = 'cache:index';
export const CACHE_STATS_KEY = 'cache:stats';
export const CACHE_MAX_RECORDS = 500;

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

/**
 * Per-group TTLs. The split is the whole point: a single record-level TTL would
 * be wrong in both directions — it would re-fetch immutable listing dates
 * forever, and keep serving "not listed" for a company that IPO'd last week.
 */
export const TTL = {
  /** Size/HQ/founded/industry change slowly. */
  profile: 7 * DAY,
  /** A listing code, board and date are immutable facts. */
  hkListingListed: 365 * DAY,
  /** A company can IPO later — this case punishes a long TTL. */
  hkListingNotListed: 14 * DAY,
  /** "No evidence" is not a stable fact either. */
  hkListingUnknown: 14 * DAY,
  /** Layoffs and lawsuits are news. */
  reputation: 3 * DAY,
};

export const DATA_GROUPS = ['hkListing', 'profile', 'reputation'];

// ---------------------------------------------------------------- rate limit

export const BUCKETS = {
  serper: { capacity: 6, refillPerMin: 6 },
  deepseek: { capacity: 8, refillPerMin: 8 },
};

export const DAILY_BUDGET = {
  serper: 400,
  deepseek: 150,
};

export const INFLIGHT_TTL_MS = 90 * 1000;

// ------------------------------------------------------------------ network

export const REQUEST_TIMEOUT_MS = 20 * 1000;
export const HTTP_RETRIES = 2;

/** Max organic results kept per Serper query when building LLM context. */
export const CONTEXT_ORGANIC_LIMIT = 6;

/**
 * Output cap for the report request.
 *
 * This is a *cap*, not a reservation — you're billed only for tokens actually
 * generated, so a generous ceiling costs nothing and removes truncation risk
 * entirely. It has to cover reasoning tokens as well as the JSON, because a
 * reasoning model spends from the same budget before it answers: at 1500,
 * deepseek-flash ran out mid-thought and returned an empty `content` with its
 * entire answer still sitting in `reasoning_content`. The retry masked it, at
 * the cost of two DeepSeek calls per lookup.
 */
export const DEEPSEEK_MAX_TOKENS = 8000;

export const ERROR_HISTORY_MAX = 20;

// ------------------------------------------------------------------ messages

/** Requests: content script → service worker. */
export const MSG = {
  ENRICH: 'enrich',
  CANCEL: 'cancel',
  PING: 'ping',
  PONG: 'pong',
  PROGRESS: 'progress',
  /** An early render from cache while the stale groups are still being fetched. */
  PARTIAL: 'partial',
  RESULT: 'result',
  // One-shot control messages (options page → service worker)
  GET_STATUS: 'GET_STATUS',
  GET_RECORDS: 'GET_RECORDS',
  CLEAR_CACHE: 'CLEAR_CACHE',
  TEST_KEYS: 'TEST_KEYS',
  REFRESH_DATASET: 'REFRESH_DATASET',
  DELETE_RECORD: 'DELETE_RECORD',
};

export const PORT_NAME = 'enrich';

export const STAGE = {
  CACHE_HIT: 'cache-hit',
  CACHE_MISS: 'cache-miss',
  SEARCHING: 'searching',
  ANALYZING: 'analyzing',
  VERIFYING: 'verifying',
};

/** Error codes. Each maps 1:1 to a card message AND an options-page diagnostic row. */
export const ERR = {
  NO_KEYS: 'NO_KEYS',
  BAD_REQUEST: 'BAD_REQUEST',
  RATE_LIMITED: 'RATE_LIMITED',
  DAILY_BUDGET: 'DAILY_BUDGET',
  SERPER_HTTP: 'SERPER_HTTP',
  SERPER_NO_RESULTS: 'SERPER_NO_RESULTS',
  DEEPSEEK_HTTP: 'DEEPSEEK_HTTP',
  DEEPSEEK_BAD_JSON: 'DEEPSEEK_BAD_JSON',
  NETWORK: 'NETWORK',
  TIMEOUT: 'TIMEOUT',
  SW_RESTARTED: 'SW_RESTARTED',
};

/** Retryable codes — the card renders a Retry button for these. */
export const RETRYABLE = new Set([
  ERR.RATE_LIMITED,
  ERR.SERPER_HTTP,
  ERR.DEEPSEEK_HTTP,
  ERR.NETWORK,
  ERR.TIMEOUT,
  ERR.SW_RESTARTED,
  ERR.DEEPSEEK_BAD_JSON,
]);

/** Human-readable, actionable messages. Never "Something went wrong." */
export const ERROR_TEXT = {
  [ERR.NO_KEYS]: 'Add your DeepSeek and Serper API keys in settings to enable lookups.',
  [ERR.BAD_REQUEST]: 'The lookup request was malformed.',
  [ERR.RATE_LIMITED]: 'Too many lookups at once — slowed down to protect your quota.',
  [ERR.DAILY_BUDGET]: "Today's lookup budget is used up. It resets at midnight.",
  [ERR.SERPER_HTTP]: 'Serper request failed.',
  [ERR.SERPER_NO_RESULTS]: 'No search results found for this company name.',
  [ERR.DEEPSEEK_HTTP]: 'DeepSeek request failed.',
  [ERR.DEEPSEEK_BAD_JSON]: 'DeepSeek returned a malformed response.',
  [ERR.NETWORK]: 'Network request failed. Check your connection.',
  [ERR.TIMEOUT]: 'The lookup timed out.',
  [ERR.SW_RESTARTED]: 'The extension worker restarted mid-lookup. Retrying…',
};

export const SETTINGS_KEY = 'settings';

export const DEFAULT_SETTINGS = {
  deepseekKey: '',
  deepseekModel: DEEPSEEK_DEFAULT_MODEL,
  deepseekBase: DEEPSEEK_DEFAULT_BASE,
  serperKey: '',
  autoTrigger: true,
  deepMode: false,
  timeoutMs: REQUEST_TIMEOUT_MS,
  datasetUrl: HKEX_DATASET_DEFAULT_URL,
  ttlProfileDays: 7,
  ttlReputationDays: 3,
  ttlListingDays: 365,
  securityAck: false,
};
