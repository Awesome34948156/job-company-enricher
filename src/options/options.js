// Options page. Talks to the service worker over one-shot messages (this page
// is long-lived, so ports aren't needed here).

import { MSG, SETTINGS_KEY, DEFAULT_SETTINGS } from '../shared/constants.js';

const $ = (id) => document.getElementById(id);

const FIELDS = [
  'serperKey', 'deepseekKey', 'deepseekModel', 'deepseekBase',
  'timeoutMs', 'ttlProfileDays', 'ttlReputationDays', 'ttlListingDays',
  'datasetUrl', 'securityAck',
];
const CHECKS = ['autoTrigger', 'deepMode', 'securityAck'];

function send(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (res) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(res || { ok: false, error: 'No response' });
    });
  });
}

function setOut(el, text, kind = '') {
  el.textContent = text;
  el.className = `out ${kind}`;
}

// ------------------------------------------------------------------ settings

async function load() {
  const got = await chrome.storage.local.get(SETTINGS_KEY);
  const s = { ...DEFAULT_SETTINGS, ...(got[SETTINGS_KEY] || {}) };
  for (const id of FIELDS) {
    const el = $(id);
    if (!el) continue;
    if (CHECKS.includes(id)) el.checked = Boolean(s[id]);
    else el.value = s[id] ?? '';
  }
  return s;
}

async function save() {
  const got = await chrome.storage.local.get(SETTINGS_KEY);
  const prev = got[SETTINGS_KEY] || {};
  const next = { ...prev };

  for (const id of FIELDS) {
    const el = $(id);
    if (!el) continue;
    if (CHECKS.includes(id)) {
      next[id] = el.checked;
    } else if (el.type === 'number') {
      const n = Number(el.value);
      next[id] = Number.isFinite(n) ? n : DEFAULT_SETTINGS[id];
    } else {
      next[id] = el.value.trim();
    }
  }

  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

// -------------------------------------------------------------------- status

async function refreshStatus() {
  const res = await send({ t: MSG.GET_STATUS });
  if (!res.ok) return;
  const { usage, stats, bytes, dataset, version } = res;

  $('usage').textContent =
    `Serper ${usage.serper}/${usage.limits.serper} · DeepSeek ${usage.deepseek}/${usage.limits.deepseek} · ${usage.date}`;

  $('cacheStats').textContent =
    `${stats.size} records · ${(bytes / 1024).toFixed(1)} KB · `
    + `${stats.hits} hits, ${stats.misses} misses, ${stats.evictions} evictions · v${version}`;

  const ds = [];
  if (dataset.cached) ds.push(`${dataset.cachedCount} rows cached`);
  else ds.push('not downloaded (using built-in fallback)');
  if (dataset.fetchedAt) ds.push(`fetched ${new Date(dataset.fetchedAt).toLocaleString()}`);
  if (dataset.error) ds.push(`last error: ${dataset.error}`);
  $('datasetStatus').textContent = ds.join(' · ');
}

async function refreshRecords() {
  const res = await send({ t: MSG.GET_RECORDS });
  const tbody = $('records').querySelector('tbody');
  tbody.innerHTML = '';
  if (!res.ok || !res.records?.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="out">No cached companies yet.</td></tr>';
    return;
  }

  const filter = ($('recordFilter').value || '').toLowerCase();
  const rows = res.records.filter((r) => !filter || r.name.toLowerCase().includes(filter));

  for (const r of rows) {
    const tr = document.createElement('tr');

    const age = r.ageMs < 3600e3
      ? `${Math.round(r.ageMs / 60e3)}m`
      : r.ageMs < 86400e3
        ? `${Math.round(r.ageMs / 3600e3)}h`
        : `${Math.round(r.ageMs / 86400e3)}d`;

    tr.innerHTML = `
      <td>${escapeHtml(r.name)}</td>
      <td>${age}</td>
      <td>${r.hits}</td>
      <td>${r.stale.length ? escapeHtml(r.stale.join(', ')) : '—'}</td>
      <td></td>`;
    const btn = document.createElement('button');
    btn.textContent = 'Delete';
    btn.className = 'danger';
    btn.addEventListener('click', async () => {
      await send({ t: MSG.DELETE_RECORD, name: r.name });
      refreshRecords();
      refreshStatus();
    });
    tr.lastElementChild.append(btn);
    tbody.append(tr);
  }
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// --------------------------------------------------------------------- wiring

document.querySelectorAll('.reveal').forEach((btn) => {
  btn.addEventListener('click', () => {
    const input = $(btn.dataset.for);
    const showing = input.type === 'text';
    input.type = showing ? 'password' : 'text';
    btn.textContent = showing ? 'Show' : 'Hide';
  });
});

$('save').addEventListener('click', async () => {
  const s = await save();
  setOut($('testOut'), 'Saved.', 'ok');
  if (s.serperKey && s.deepseekKey) refreshStatus();
});

$('test').addEventListener('click', async () => {
  await save();
  setOut($('testOut'), 'Testing…');
  const res = await send({ t: MSG.TEST_KEYS });
  if (!res.ok) {
    setOut($('testOut'), res.error || 'Test failed', 'bad');
    return;
  }
  const parts = [];
  let allOk = true;
  for (const [name, r] of [['Serper', res.serper], ['DeepSeek', res.deepseek]]) {
    if (r?.ok) parts.push(`${name} ok (${r.ms}ms)`);
    else {
      allOk = false;
      parts.push(`${name}: ${r?.error || 'failed'}`);
    }
  }
  setOut($('testOut'), parts.join(' · '), allOk ? 'ok' : 'bad');
});

$('clearCache').addEventListener('click', async () => {
  const res = await send({ t: MSG.CLEAR_CACHE });
  setOut($('cacheOut'), res.ok ? `Cleared ${res.cleared} records.` : (res.error || 'Failed'), res.ok ? 'ok' : 'bad');
  refreshRecords();
  refreshStatus();
});

$('refreshRecords').addEventListener('click', refreshRecords);
$('recordFilter').addEventListener('input', refreshRecords);

$('refreshDataset').addEventListener('click', async () => {
  await save();
  setOut($('datasetOut'), 'Downloading…');
  const res = await send({ t: MSG.REFRESH_DATASET });
  if (res.ok) setOut($('datasetOut'), `Loaded ${res.count} rows.`, 'ok');
  else setOut($('datasetOut'), `Failed: ${res.error || 'unknown error'}`, 'bad');
  refreshStatus();
});

$('loadErrors').addEventListener('click', async () => {
  const got = await chrome.storage.local.get('diagnostics:errors');
  const errors = got['diagnostics:errors'] || [];
  const box = $('errors');
  if (!errors.length) {
    box.innerHTML = '<p class="out">No errors recorded.</p>';
    return;
  }
  box.innerHTML = errors.map((e) => `
    <div class="e">
      <span class="code">${escapeHtml(e.code)}</span>
      ${e.company ? `— ${escapeHtml(e.company)}` : ''}
      <div>${escapeHtml(e.message)}</div>
      <div class="when">${new Date(e.at).toLocaleString()}</div>
    </div>`).join('');
  setOut($('diagOut'), `${errors.length} recent errors.`, '');
});

$('exportDiag').addEventListener('click', async () => {
  const [settings, status, errs] = await Promise.all([
    chrome.storage.local.get(SETTINGS_KEY),
    send({ t: MSG.GET_STATUS }),
    chrome.storage.local.get('diagnostics:errors'),
  ]);
  // Redact secrets before exporting.
  const s = { ...(settings[SETTINGS_KEY] || {}) };
  for (const k of ['serperKey', 'deepseekKey']) if (s[k]) s[k] = `[set, ${String(s[k]).length} chars]`;

  const blob = new Blob([JSON.stringify({
    exportedAt: new Date().toISOString(),
    settings: s,
    status,
    errors: errs['diagnostics:errors'] || [],
  }, null, 2)], { type: 'application/json' });

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'job-company-enricher-diagnostics.json';
  a.click();
  URL.revokeObjectURL(url);
  setOut($('diagOut'), 'Exported.', 'ok');
});

// -------------------------------------------------------------------- init

load().then(() => {
  refreshStatus();
  refreshRecords();
  // Warn once, visibly, if keys are missing.
  chrome.storage.local.get(SETTINGS_KEY).then((got) => {
    const s = { ...DEFAULT_SETTINGS, ...(got[SETTINGS_KEY] || {}) };
    if (!s.serperKey || !s.deepseekKey) {
      setOut($('testOut'), 'Add both API keys, then click Test keys.', '');
    } else if (!s.securityAck) {
      setOut($('testOut'), 'Both keys are set. Please confirm the security notice below.', '');
    } else {
      setOut($('testOut'), 'Keys are set.', 'ok');
    }
  });
});
