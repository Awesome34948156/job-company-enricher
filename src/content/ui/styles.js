// Card CSS. Applied as a constructable stylesheet (adoptedStyleSheets) rather
// than an injected <style> tag, because adoptedStyleSheets is not subject to the
// page's CSP whereas an inline <style> can be refused on strict-CSP pages.

export const CARD_CSS = `
:host { all: initial; }

.card {
  --bg: #ffffff;
  --fg: #1a1a2e;
  --muted: #6b7280;
  --line: #e5e7eb;
  --accent: #312e81;
  --ok: #047857;
  --warn: #b45309;
  --bad: #b91c1c;
  --chip: #f3f4f6;

  box-sizing: border-box;
  width: 360px;
  max-height: 70vh;
  overflow-y: auto;
  font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "PingFang HK", "Microsoft JhengHei", sans-serif;
  color: var(--fg);
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: 10px;
  box-shadow: 0 8px 28px rgba(0,0,0,.16), 0 1px 3px rgba(0,0,0,.08);
  overflow-wrap: anywhere;
}
@media (prefers-color-scheme: dark) {
  .card {
    --bg: #1c1c22;
    --fg: #ececf1;
    --muted: #9ca3af;
    --line: #34343d;
    --accent: #a5b4fc;
    --ok: #34d399;
    --warn: #fbbf24;
    --bad: #f87171;
    --chip: #2a2a33;
    box-shadow: 0 8px 28px rgba(0,0,0,.5), 0 1px 3px rgba(0,0,0,.4);
  }
}

.hd {
  display: flex; align-items: flex-start; gap: 8px;
  padding: 10px 12px; border-bottom: 1px solid var(--line);
  /* The header is the drag handle. "touch-action: none" keeps a touch drag from
     being cancelled into a page scroll; ".co" overrides the cursor with "text"
     so the editable name still reads as editable rather than draggable.

     No backticks anywhere in this file: CARD_CSS is a template literal, so one
     would close it here and the rest of the stylesheet would parse as JS. */
  cursor: grab; touch-action: none;
}
.hd.dragging { cursor: grabbing; user-select: none; }
.hd .titles { flex: 1; min-width: 0; }
.job {
  font-size: 11px; color: var(--muted); margin-bottom: 2px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.co {
  font-size: 14px; font-weight: 650; line-height: 1.3;
  cursor: text; border-bottom: 1px dashed transparent;
}
.co:hover { border-bottom-color: var(--muted); }
.co .pencil { font-size: 10px; color: var(--muted); margin-left: 5px; opacity: 0; }
.co:hover .pencil { opacity: 1; }

.co-input {
  font: inherit; font-size: 14px; font-weight: 650; width: 100%;
  padding: 2px 4px; border: 1px solid var(--accent); border-radius: 4px;
  background: var(--bg); color: var(--fg);
}
.co-input:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
.hint { font-size: 10px; color: var(--muted); margin-top: 2px; }

.x {
  flex: none; border: 0; background: transparent; color: var(--muted);
  font-size: 16px; line-height: 1; cursor: pointer; padding: 2px 4px;
  border-radius: 4px;
}
.x:hover { background: var(--chip); color: var(--fg); }

.body { padding: 4px 0; }
.row { display: flex; gap: 10px; padding: 5px 12px; align-items: baseline; }
.row .k {
  flex: none; width: 74px; color: var(--muted); font-size: 11.5px;
  text-transform: uppercase; letter-spacing: .03em;
}
.row .v { flex: 1; min-width: 0; }
.row.miss .v { color: var(--muted); font-style: italic; }
.row.stale .v { opacity: .55; }

.ok { color: var(--ok); font-weight: 600; }
.bad { color: var(--bad); font-weight: 600; }
.muted { color: var(--muted); }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }

.dot {
  display: inline-block; width: 6px; height: 6px; border-radius: 50%;
  background: var(--warn); margin-left: 5px; vertical-align: middle;
}

.chips { padding: 6px 12px 2px; display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.chips .lbl { font-size: 10.5px; color: var(--muted); width: 100%; }
.chip {
  border: 1px solid var(--line); background: var(--chip); color: var(--fg);
  border-radius: 999px; padding: 2px 9px; font: inherit; font-size: 11.5px; cursor: pointer;
}
.chip:hover { border-color: var(--accent); color: var(--accent); }

.events { padding: 4px 12px; }
.event { font-size: 11.5px; color: var(--muted); padding: 1px 0; }
.event b { color: var(--fg); font-weight: 600; }

.ft {
  padding: 8px 12px; border-top: 1px solid var(--line);
  font-size: 11px; color: var(--muted);
}
.ft a { color: var(--accent); text-decoration: none; }
.ft a:hover { text-decoration: underline; }
.why { margin-top: 5px; }
.why summary { cursor: pointer; font-size: 11px; }
.why table { border-collapse: collapse; margin-top: 4px; width: 100%; }
.why td { padding: 1px 4px; vertical-align: top; font-size: 10.5px; }

.skel {
  height: 11px; border-radius: 4px; background: var(--chip);
  animation: pulse 1.3s ease-in-out infinite;
}
@keyframes pulse { 0%,100% { opacity: 1 } 50% { opacity: .45 } }
.stage { padding: 8px 12px; color: var(--muted); font-size: 11.5px; }

.err { padding: 10px 12px; color: var(--bad); font-size: 12px; }
.err .code { font-size: 10px; color: var(--muted); display: block; margin-top: 3px; }
.retry {
  margin: 0 12px 10px; border: 1px solid var(--line); background: var(--chip);
  color: var(--fg); border-radius: 6px; padding: 4px 10px; font: inherit;
  font-size: 11.5px; cursor: pointer;
}
.retry:hover { border-color: var(--accent); color: var(--accent); }

.note {
  padding: 6px 12px; font-size: 11px; color: var(--warn);
  background: color-mix(in srgb, var(--warn) 10%, transparent);
}
`;
