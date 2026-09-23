// The floating card. Rendered inside a Shadow DOM so the host page's CSS (and
// LinkedIn's in particular) can't reach it, with `all: initial` on the host so
// nothing leaks in either direction.

import { CARD_CSS } from './styles.js';
import { ROWS, groupConfidence, sourceHosts, escapeHtml } from './rows.js';
import { ERROR_TEXT, RETRYABLE, STAGE } from '../../shared/constants.js';

// The card's width lives in the stylesheet (`width: 360px`), not here — a second
// copy in JS is just a second value to let drift.
const MARGIN = 12;
const CONF_LOW = 0.4;

const STAGE_TEXT = {
  [STAGE.CACHE_HIT]: 'Loaded from cache',
  [STAGE.CACHE_MISS]: 'Looking up…',
  [STAGE.SEARCHING]: 'Searching the web…',
  [STAGE.ANALYZING]: 'Reading results…',
  [STAGE.VERIFYING]: 'Verifying listing…',
};

const sheet = new CSSStyleSheet();
sheet.replaceSync(CARD_CSS);

// ---------------------------------------------------------------- positioning

/** Movement, in px, before a press on the header counts as a drag and not a click. */
const DRAG_THRESHOLD = 4;

/** How much of the card must stay on screen, so it can always be dragged back. */
const KEEP_VISIBLE = 48;

const POS_KEY = 'ui:cardPos';

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

/**
 * Position the card, and let the user move it.
 *
 * Default placement is the right edge, vertically centred. This used to anchor
 * to the job title's *right edge* and follow its top, which reads like "put it
 * in the gutter" but isn't: on a wide page with a short title the <h1> ends
 * somewhere around the middle of the screen, so the card landed mid-page. The
 * viewport is the only thing that reliably knows where the right edge is.
 *
 * Once dragged, the user's position wins for good and is remembered across
 * sessions. Every position is clamped so some of the card always stays on
 * screen — a floating panel you can't reach and can't reset is worse than one
 * that won't go quite where you put it.
 *
 * `card` is passed in because the drag is delegated from it: the header element
 * is replaced on every render, so a listener bound to the header would be gone
 * by the first re-render.
 */
function installPositioning(host, card) {
  let userPos = null; // set once the card has been dragged
  let drag = null;

  const bounds = () => {
    const w = host.offsetWidth || 0;
    return {
      loX: KEEP_VISIBLE - w,
      hiX: innerWidth - KEEP_VISIBLE,
      loY: 0,
      hiY: Math.max(0, innerHeight - KEEP_VISIBLE),
    };
  };

  const apply = (p) => {
    const b = bounds();
    userPos = { left: clamp(p.left, b.loX, b.hiX), top: clamp(p.top, b.loY, b.hiY) };
    host.style.left = `${userPos.left}px`;
    host.style.top = `${userPos.top}px`;
    host.style.right = 'auto';
  };

  const place = () => {
    if (userPos) { apply(userPos); return; }
    const top = Math.max(MARGIN, (innerHeight - (host.offsetHeight || 0)) / 2);
    host.style.top = `${top}px`;
    host.style.left = 'auto';
    host.style.right = `${MARGIN}px`;
  };

  // A remembered position is a nicety; failing to read it must not throw.
  Promise.resolve()
    .then(() => chrome.storage.local.get(POS_KEY))
    .then((got) => {
      const p = got?.[POS_KEY];
      if (!p || !Number.isFinite(p.left) || !Number.isFinite(p.top)) return;
      apply(p);
    })
    .catch(() => {});

  card.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const t = e.target;
    if (!(t instanceof Element)) return;
    // The header is the handle, but `.co` is click-to-edit and `.x` dismisses,
    // so a press on either has to stay a click. That is why the drag doesn't
    // begin here: it waits for the pointer to actually move.
    if (!t.closest('.hd') || t.closest('.co') || t.closest('.x')) return;
    const r = host.getBoundingClientRect();
    drag = { id: e.pointerId, x0: e.clientX, y0: e.clientY, left: r.left, top: r.top, moved: false };
  });

  function onMove(e) {
    if (!drag || e.pointerId !== drag.id) return;

    if (!drag.moved) {
      if (Math.abs(e.clientX - drag.x0) < DRAG_THRESHOLD
        && Math.abs(e.clientY - drag.y0) < DRAG_THRESHOLD) return;
      // Re-base on the pointer's position and the card's position *now*: a
      // pending re-layout between the press and the threshold would otherwise
      // be measured against a stale origin and jump.
      const r = host.getBoundingClientRect();
      drag.left = r.left;
      drag.top = r.top;
      drag.x0 = e.clientX;
      drag.y0 = e.clientY;
      drag.moved = true;
      host.style.right = 'auto';
      card.querySelector('.hd')?.classList.add('dragging');
    }

    e.preventDefault();
    apply({ left: drag.left + (e.clientX - drag.x0), top: drag.top + (e.clientY - drag.y0) });
  }

  function endDrag(e) {
    if (!drag || (e && e.pointerId !== drag.id)) return;
    const moved = drag.moved;
    drag = null;
    card.querySelector('.hd')?.classList.remove('dragging');
    if (moved && userPos) {
      try { chrome.storage.local.set({ [POS_KEY]: userPos }); } catch { /* ignore */ }
    }
  }

  // Double-clicking the header returns the card to its default corner. The
  // clamp means it can never be lost, but a position sticks across sessions, so
  // there has to be a way back that doesn't involve dragging it there.
  card.addEventListener('dblclick', (e) => {
    const t = e.target;
    if (!(t instanceof Element) || !t.closest('.hd') || t.closest('.co') || t.closest('.x')) return;
    e.preventDefault();
    userPos = null;
    try { chrome.storage.local.remove(POS_KEY); } catch { /* ignore */ }
    place();
  });

  addEventListener('resize', place, { passive: true });
  // Not `{ passive: true }` — a drag has to be able to preventDefault a text
  // selection while the pointer is down.
  addEventListener('pointermove', onMove, { passive: false });
  addEventListener('pointerup', endDrag);
  addEventListener('pointercancel', endDrag);

  // Observe the host, not the page. The card's height changes twice per lookup
  // (skeleton → populated) and each change moves the centre line; observing the
  // job title instead watched the one element whose size never affected it.
  let ro = null;
  if (typeof ResizeObserver === 'function') {
    ro = new ResizeObserver(place);
    ro.observe(host);
  }

  place();
  return { place, teardown: () => ro?.disconnect() };
}

// ------------------------------------------------------------------- render

function skeletonRows(n = 5) {
  let html = '';
  for (let i = 0; i < n; i++) {
    const w = [60, 40, 75, 50, 65][i % 5];
    html += `<div class="row"><div class="k"><div class="skel" style="width:52px"></div></div>
      <div class="v"><div class="skel" style="width:${w}%"></div></div></div>`;
  }
  return html;
}

function rowsHtml(report, ctx) {
  let html = '';
  for (const row of ROWS) {
    const data = report?.[row.group];
    let value = null;
    try {
      value = row.get(data || {}, ctx);
    } catch (e) {
      console.debug('[JCE] row render failed', row.id, e);
    }
    const missing = value == null || value === '';
    const lowConf = groupConfidence(report, row.group) < CONF_LOW && groupConfidence(report, row.group) > 0;
    const cls = ['row', missing ? 'miss' : '', lowConf ? 'lowconf' : ''].filter(Boolean).join(' ');
    const dot = lowConf
      ? `<span class="dot" title="Low confidence (${groupConfidence(report, row.group).toFixed(2)})"></span>`
      : '';
    const inner = missing
      ? 'Not found'
      : (row.html ? value : escapeHtml(value));
    html += `<div class="${cls}"><div class="k">${escapeHtml(row.label)}</div>
      <div class="v">${inner}${dot}</div></div>`;
  }
  return html;
}

function eventsHtml(rep) {
  const items = [...(rep.layoffs || []), ...(rep.lawsuits || [])].slice(0, 4);
  if (!items.length) return '';
  return `<div class="events">${items.map((e) => {
    const link = e.sourceUrl
      ? ` <a href="${escapeHtml(e.sourceUrl)}" target="_blank" rel="noopener noreferrer">source</a>`
      : '';
    const year = e.year ? ` <b>${e.year}</b>` : '';
    return `<div class="event">• ${escapeHtml(e.summary)}${year}${link}</div>`;
  }).join('')}</div>`;
}

function footerHtml(report) {
  const hosts = sourceHosts(report?.sources);
  const byHost = new Map();
  for (const s of report?.sources || []) {
    try {
      const h = new URL(s.url).hostname.replace(/^www\./, '');
      if (!byHost.has(h)) byHost.set(h, s.url);
    } catch { /* skip */ }
  }
  if (!hosts.length) return '';
  const links = hosts
    .map((h) => `<a href="${escapeHtml(byHost.get(h))}" target="_blank" rel="noopener noreferrer">${escapeHtml(h)}</a>`)
    .join(' · ');

  const why = report.sources.length
    ? `<details class="why"><summary>Why these sources?</summary><table>${
      report.sources.map((s) => `<tr><td>${escapeHtml(s.usedFor)}</td><td><a href="${escapeHtml(s.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(s.title || s.url)}</a></td></tr>`).join('')
    }</table></details>`
    : '';

  return `<div class="ft">Sources: ${links}${why}</div>`;
}

/**
 * `names` are already vetted by the extractor — this only renders them.
 *
 * The filter that used to live here (dropping any name equal to the current
 * one) was a symptom of being handed the raw candidate list and having to guess
 * which entries were worth showing. The extractor decides that now, and a
 * second opinion here would only be a second place to get it wrong.
 */
function chipsHtml(names) {
  const list = (names || []).filter(Boolean).slice(0, 3);
  if (!list.length) return '';
  return `<div class="chips"><span class="lbl">Did you mean?</span>${
    list.map((n) => `<button class="chip" data-name="${escapeHtml(n)}">${escapeHtml(n)}</button>`).join('')
  }</div>`;
}

// --------------------------------------------------------------------- card

export function createCard(handlers = {}) {
  const host = document.createElement('div');
  host.id = 'jce-host';
  host.style.cssText = 'all: initial; position: fixed; z-index: 2147483647; top: 80px; right: 12px;';
  const root = host.attachShadow({ mode: 'open' });
  root.adoptedStyleSheets = [sheet];
  const card = document.createElement('div');
  card.className = 'card';
  card.setAttribute('role', 'complementary');
  card.setAttribute('aria-label', 'Company information');
  root.append(card);

  const pos = installPositioning(host, card);
  let visible = false;

  function mount() {
    if (!host.isConnected) document.body.append(host);
    visible = true;
    card.style.display = '';
    pos.place();
  }

  function unmount() {
    visible = false;
    card.style.display = 'none';
  }

  /** Swap the company name heading for an input. The escape hatch is always available. */
  function startEditing(current) {
    const h = card.querySelector('.co');
    if (!h || card.querySelector('.co-input')) return;
    const input = document.createElement('input');
    input.className = 'co-input';
    input.value = current || '';
    input.setAttribute('aria-label', 'Company name');
    h.replaceWith(input);
    input.focus();
    input.select();

    let committed = false;
    const commit = () => {
      if (committed) return;
      committed = true;
      const v = input.value.trim();
      if (v && v !== current) handlers.onEditName?.(v);
      else handlers.onRerender?.();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      if (e.key === 'Escape') { committed = true; handlers.onRerender?.(); }
    });
    input.addEventListener('blur', commit);
  }

  // Event delegation — survives re-renders without re-binding.
  card.addEventListener('click', (e) => {
    const t = e.target;
    if (!(t instanceof Element)) return;
    if (t.closest('.x')) { handlers.onDismiss?.(); return; }
    if (t.closest('.co')) { startEditing(t.closest('.co').dataset.name || ''); return; }
    if (t.closest('.retry')) { handlers.onRetry?.(); return; }
    const chip = t.closest('.chip');
    if (chip) { handlers.onEditName?.(chip.dataset.name); return; }
  });

  card.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !card.querySelector('.co-input')) handlers.onDismiss?.();
  });

  function headerHtml({ company, jobTitle, stale }) {
    const job = jobTitle ? `<div class="job">${escapeHtml(jobTitle)}</div>` : '';
    const staleNote = stale
      ? `<div class="hint">Showing cached data for <b>${escapeHtml(company)}</b></div>`
      : '';
    return `<div class="hd"><div class="titles">${job}
      <div class="co" data-name="${escapeHtml(company || '')}" tabindex="0" role="button"
           title="Click to edit">${escapeHtml(company || 'Unknown company')}<span class="pencil">✎</span></div>
      ${staleNote}</div>
      <button class="x" aria-label="Dismiss">×</button></div>`;
  }

  return {
    host,
    root,
    card,
    get visible() { return visible; },
    mount,
    unmount,

    /** @param {object} s  { state, company, jobTitle, report, error, progress, suggestions, verification, meta, staleName } */
    render(s) {
      mount();
      const { state } = s;

      if (state === 'loading') {
        card.innerHTML = headerHtml(s) + skeletonRows()
          + `<div class="stage" aria-live="polite">${escapeHtml(STAGE_TEXT[s.progress] || 'Looking up…')}</div>`;
        return;
      }

      if (state === 'needs-name') {
        card.innerHTML = headerHtml({ company: '', jobTitle: s.jobTitle })
          + '<div class="stage">Enter the company name to look it up.</div>';
        startEditing('');
        return;
      }

      if (state === 'error') {
        const code = s.error?.code || 'NETWORK';
        const text = s.error?.message || ERROR_TEXT[code] || 'Lookup failed.';
        const retry = RETRYABLE.has(code) ? '<button class="retry">Retry</button>' : '';
        card.innerHTML = headerHtml(s)
          + `<div class="err" role="alert">${escapeHtml(text)}<span class="code">${escapeHtml(code)}</span></div>${retry}`;
        return;
      }

      // state === 'ready'
      const report = s.report || {};
      const ctx = { verification: s.verification || null };
      const note = report.notes
        ? `<div class="note">${escapeHtml(report.notes)}</div>`
        : '';
      const mismatch = report.matchedEntity
        ? `<div class="note">Data describes <b>${escapeHtml(report.matchedEntity)}</b>, not the employer directly.</div>`
        : '';
      const stale = s.staleName ? { stale: true, company: s.staleName } : s;
      const ambiguous = chipsHtml(s.suggestions);

      card.innerHTML = headerHtml(stale)
        + `<div class="body">${rowsHtml(report, ctx)}</div>`
        + eventsHtml(report.reputation || {})
        + ambiguous
        + note + mismatch
        + footerHtml(report);
    },
  };
}
