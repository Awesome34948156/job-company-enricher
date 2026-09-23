// MV3 service worker entry point.
//
// This worker is event-driven and gets killed when idle, so nothing important
// lives in module scope: settings are read from storage on every request, and
// the cache is entirely in chrome.storage.

import { MSG, PORT_NAME, ERR } from '../shared/constants.js';
import { runPipeline, loadSettings, recordError } from './pipeline.js';
import { clearCache, listRecords, deleteRecord, cacheStats, cacheBytes } from './cache.js';
import { usageToday, pruneOldCounters } from './ratelimit.js';
import { testKey as testSerper } from './serper.js';
import { testKey as testDeepSeek } from './deepseek.js';
import { loadDataset, datasetStatus } from './hkex.js';

const ALARM_PRUNE = 'jce-prune';
const ALARM_DATASET = 'jce-dataset';

// ------------------------------------------------------------------- ports

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== PORT_NAME) return;

  // Tracks in-flight lookups on this port so the cancel message can abort the
  // *rendering* of a superseded request (the network calls are allowed to finish;
  // their results are still cache-worthy).
  const cancelled = new Set();

  port.onMessage.addListener(async (msg) => {
    if (!msg || typeof msg !== 'object') return;
    const { t, reqId } = msg;

    if (t === MSG.PING) {
      safePost(port, { t: MSG.PONG, reqId });
      return;
    }

    if (t === MSG.CANCEL) {
      cancelled.add(reqId);
      return;
    }

    if (t !== MSG.ENRICH) return;

    const onProgress = (p) => {
      if (cancelled.has(reqId)) return;
      safePost(port, { t: MSG.PROGRESS, reqId, stage: p.stage, detail: p.detail });
    };
    const onPartial = (p) => {
      if (cancelled.has(reqId)) return;
      safePost(port, {
        t: MSG.PARTIAL, reqId, ok: true, report: p.report, meta: p.meta,
      });
    };

    try {
      const { report, meta } = await runPipeline(msg, { onProgress, onPartial });
      if (cancelled.has(reqId)) return;
      safePost(port, { t: MSG.RESULT, reqId, ok: true, report, meta });
    } catch (e) {
      const code = e?.code || ERR.NETWORK;
      const message = e?.message || 'Lookup failed.';
      if (!e?.code) await recordError(code, message, { company: msg.name });
      if (cancelled.has(reqId)) return;
      safePost(port, {
        t: MSG.RESULT,
        reqId,
        ok: false,
        error: { code, message, retryAfterMs: e?.retryAfterMs },
      });
    } finally {
      cancelled.delete(reqId);
    }
  });
});

/** Ports close without warning when the tab navigates — posting must not throw. */
function safePost(port, msg) {
  try {
    port.postMessage(msg);
  } catch {
    /* port already disconnected */
  }
}

// ------------------------------------------------------- control messages

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg !== 'object' || !msg.t) return false;

  (async () => {
    try {
      switch (msg.t) {
        case MSG.GET_STATUS: {
          const [settings, stats, usage, bytes, dataset] = await Promise.all([
            loadSettings(), cacheStats(), usageToday(), cacheBytes(), datasetStatus(),
          ]);
          sendResponse({
            ok: true,
            version: chrome.runtime.getManifest().version,
            keys: {
              deepseek: Boolean(settings.deepseekKey),
              serper: Boolean(settings.serperKey),
            },
            model: settings.deepseekModel,
            stats,
            usage,
            bytes,
            dataset,
          });
          return;
        }

        case MSG.GET_RECORDS:
          sendResponse({ ok: true, records: await listRecords() });
          return;

        case MSG.DELETE_RECORD:
          await deleteRecord(msg.name);
          sendResponse({ ok: true });
          return;

        case MSG.CLEAR_CACHE:
          sendResponse({ ok: true, cleared: await clearCache() });
          return;

        case MSG.TEST_KEYS: {
          const settings = await loadSettings();
          const out = {};
          if (settings.serperKey) out.serper = await testSerper(settings.serperKey);
          else out.serper = { ok: false, error: 'No Serper key set' };
          if (settings.deepseekKey) out.deepseek = await testDeepSeek(settings);
          else out.deepseek = { ok: false, error: 'No DeepSeek key set' };
          sendResponse({ ok: true, ...out });
          return;
        }

        case MSG.REFRESH_DATASET: {
          const settings = await loadSettings();
          const ds = await loadDataset(settings.datasetUrl, { force: true });
          const status = await datasetStatus();
          sendResponse({
            ok: !ds.degraded,
            count: ds.count ?? status.cachedCount,
            ...status,
          });
          return;
        }

        default:
          sendResponse({ ok: false, error: `Unknown message: ${msg.t}` });
      }
    } catch (e) {
      console.error('[JCE] control message failed', msg.t, e);
      sendResponse({ ok: false, error: e?.message || String(e) });
    }
  })();

  return true; // keep the channel open for the async response
});

// --------------------------------------------------------------- lifecycle

chrome.action?.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage();
});

chrome.runtime.onInstalled.addListener(async (details) => {
  try {
    await chrome.alarms.create(ALARM_PRUNE, { periodInMinutes: 60 });
    await chrome.alarms.create(ALARM_DATASET, { periodInMinutes: 60 * 24 * 7 });
    if (details.reason === 'install') {
      chrome.runtime.openOptionsPage();
    }
  } catch (e) {
    console.warn('[JCE] alarm setup failed', e);
  }
});

chrome.alarms?.onAlarm.addListener(async (alarm) => {
  try {
    if (alarm.name === ALARM_PRUNE) {
      await pruneOldCounters();
    }
    if (alarm.name === ALARM_DATASET) {
      const settings = await loadSettings();
      if (settings.datasetUrl) await loadDataset(settings.datasetUrl);
    }
  } catch (e) {
    console.warn('[JCE] alarm handler failed', alarm.name, e);
  }
});

// ------------------------------------------------------- manual testing hook
//
// Drives the pipeline straight from the service-worker console, which is how the
// search/analyze stages get tested without a page:
//     await __jce_enrich('Tencent Holdings')
//     await __jce_enrich('Acme Widgets')      // must return all-null, no ticker

globalThis.__jce_enrich = async (name, opts = {}) => {
  const res = await runPipeline({ name, ...opts }, {
    onProgress: (p) => console.log('[JCE] stage', p.stage, p.detail || ''),
  });
  console.log('[JCE] report', res.report, '\nmeta', res.meta);
  return res;
};

globalThis.__jce_storage = () => chrome.storage.local.get(null);
