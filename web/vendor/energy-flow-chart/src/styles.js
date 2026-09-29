// Component CSS, injected once per document. Everything is scoped under .efc and
// driven by --efc-* custom properties written by applyThemeVars().

export const css = `
.efc, .efc-cards { font-family: var(--efc-font, system-ui, -apple-system, "Segoe UI", sans-serif); color: var(--efc-ink); }
.efc { position: relative; background: var(--efc-surface); border-radius: 12px; }
.efc *, .efc-cards * { box-sizing: border-box; }

.efc-top { display: flex; align-items: center; justify-content: flex-end; gap: 12px; flex-wrap: wrap; padding: 0 4px 8px; }
.efc-legend { display: flex; flex-wrap: wrap; gap: 4px 6px; align-items: center; }
.efc-legend button {
  all: unset; display: inline-flex; align-items: center; gap: 7px; cursor: pointer;
  padding: 4px 9px 4px 7px; border-radius: 999px; font-size: 12.5px; color: var(--efc-ink2);
  border: 1px solid transparent; transition: background .15s, opacity .15s;
}
.efc-legend button:hover { background: var(--efc-band); }
.efc-legend button:focus-visible { outline: 2px solid var(--efc-accent); outline-offset: 1px; }
.efc-legend button[aria-pressed="false"] { opacity: .45; }
.efc-legend button[aria-pressed="false"] .efc-key { background: transparent !important; box-shadow: inset 0 0 0 1.5px var(--efc-muted); }
.efc-key { width: 12px; height: 12px; border-radius: 3px; flex: none; }
.efc-key.is-line { height: 0; border-radius: 0; border-top: 2px dashed var(--efc-ink); background: none !important; }
.efc-key.is-line.is-solid { border-top-style: solid; }
.efc-key.is-hatch { background-image: repeating-linear-gradient(135deg, transparent 0 2px, var(--efc-surface) 2px 4px) !important; }

.efc-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 10px; margin: 0 0 8px; font-size: 12px; }
.efc-toolbar[hidden], .efc-toolbar [hidden] { display: none !important; }
.efc-tb-spacer { flex: 1; }
.efc-seg { display: inline-flex; border: 1px solid var(--efc-border); border-radius: 8px; overflow: hidden; background: var(--efc-surface); }
.efc-seg button { all: unset; cursor: pointer; padding: 5px 10px; font-weight: 600; color: var(--efc-ink2); white-space: nowrap; }
.efc-seg button + button { border-left: 1px solid var(--efc-border); }
.efc-seg button:hover:not([aria-pressed="true"]) { background: var(--efc-band); }
.efc-seg button[aria-pressed="true"] { background: var(--efc-accent); color: var(--efc-surface); }
.efc-range { display: inline-flex; align-items: center; gap: 4px; }
.efc-period { font-weight: 650; color: var(--efc-ink); min-width: 9.5em; text-align: center; font-variant-numeric: tabular-nums; white-space: nowrap; }
.efc-step { all: unset; cursor: pointer; width: 24px; height: 24px; display: grid; place-items: center; border-radius: 6px; border: 1px solid var(--efc-border); color: var(--efc-ink2); font-size: 15px; line-height: 1; }
.efc-step:hover:not(:disabled) { background: var(--efc-band); }
.efc-step:disabled { opacity: .35; cursor: default; }
.efc-reset, .efc-export {
  all: unset; cursor: pointer; font-size: 12px; font-weight: 600; color: var(--efc-accent); white-space: nowrap;
  padding: 4px 9px; border-radius: 7px; border: 1px solid var(--efc-border); background: var(--efc-surface);
}
.efc-export { display: inline-flex; align-items: center; gap: 5px; color: var(--efc-surface); background: var(--efc-accent); border-color: var(--efc-accent); }
.efc-reset:hover { background: var(--efc-band); }
.efc-export:hover { filter: brightness(1.06); }
.efc-seg button:focus-visible, .efc-step:focus-visible, .efc-export:focus-visible { outline: 2px solid var(--efc-accent); outline-offset: 1px; }
.efc-reset[hidden] { display: none; }
.efc-lock {
  all: unset; cursor: pointer; display: inline-flex; align-items: center; gap: 6px;
  font-size: 11.5px; color: var(--efc-ink2); white-space: nowrap; padding: 2px 4px; border-radius: 6px;
}
.efc-lock[hidden] { display: none; }
.efc-switch { position: relative; width: 24px; height: 14px; border-radius: 999px; background: var(--efc-axis); transition: background .15s; flex: none; }
.efc-switch::after { content: ""; position: absolute; top: 2px; left: 2px; width: 10px; height: 10px; border-radius: 50%; background: #fff; box-shadow: 0 1px 2px rgba(0,0,0,.25); transition: transform .15s; }
.efc-lock[aria-checked="true"] .efc-switch { background: var(--efc-accent); }
.efc-lock[aria-checked="true"] .efc-switch::after { transform: translateX(10px); }
.efc-lock[aria-checked="true"] { color: var(--efc-ink); }
.efc-lock:focus-visible, .efc-reset:focus-visible { outline: 2px solid var(--efc-accent); outline-offset: 1px; }
@media (prefers-reduced-motion: reduce) { .efc-switch, .efc-switch::after { transition: none; } }

/* readout band: legend + live values, sits directly above the plot */
.efc-band {
  display: flex; align-items: stretch; gap: 0; margin: 0 0 6px; min-height: 52px;
  border: 1px solid var(--efc-border); border-radius: 10px; background: var(--efc-surface);
  font-variant-numeric: tabular-nums; transition: border-color .15s, box-shadow .15s;
}
.efc-band.is-live { border-color: color-mix(in srgb, var(--efc-accent) 55%, transparent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--efc-accent) 10%, transparent); }
.efc-band-when { flex: none; display: flex; flex-direction: column; justify-content: center; gap: 1px; padding: 6px 12px; min-width: 124px; border-right: 1px solid var(--efc-border); }
.efc-band.is-pinned { border-color: var(--efc-accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--efc-accent) 16%, transparent); }
.efc-band-when { position: relative; }
.efc-band.is-live .efc-band-when { padding-right: 28px; }
.efc-unpin { all: unset; cursor: pointer; position: absolute; top: 3px; right: 4px; width: 18px; height: 18px; border-radius: 50%; display: grid; place-items: center; font-size: 13px; line-height: 1; color: var(--efc-muted); }
.efc-unpin:hover { background: var(--efc-band); color: var(--efc-ink); }
.efc-unpin:focus-visible { outline: 2px solid var(--efc-accent); }
.efc-band-when b { font-size: 13px; font-weight: 650; color: var(--efc-ink); white-space: nowrap; }
.efc-band-when span { font-size: 11.5px; color: var(--efc-muted); white-space: nowrap; }
.efc-band-items { flex: 1; min-width: 0; display: flex; flex-wrap: wrap; align-content: center; gap: 2px 2px; padding: 4px 6px; }
.efc-band-sum { flex: none; display: flex; align-items: center; gap: 16px; padding: 6px 14px; border-left: 1px solid var(--efc-border); }
.efc-band-sum div { display: flex; flex-direction: column; gap: 1px; }
.efc-band-sum span { font-size: 11px; color: var(--efc-muted); white-space: nowrap; }
.efc-band-sum b { font-size: 13px; font-weight: 650; color: var(--efc-ink); white-space: nowrap; }
.efc-band-sum .pos b { color: var(--efc-good, #0a8a0a); }
.efc-band-sum .neg b { color: var(--efc-bad, #d03b3b); }
.efc-legend .efc-chip { padding: 4px 8px 4px 7px; border-radius: 8px; gap: 6px; }
.efc-chip-label { color: var(--efc-ink2); white-space: nowrap; }
.efc-chip-val { font-weight: 650; color: var(--efc-ink); white-space: nowrap; min-width: 4ch; }
/* priced chips stack: label / volume / price */
.efc-chip:has(.efc-chip-price) { display: inline-grid !important; grid-template-columns: 12px auto; column-gap: 6px; row-gap: 0; align-items: center; padding: 3px 8px 3px 6px; min-width: 0; }
.efc-chip:has(.efc-chip-price) .efc-chip-label { font-size: 11.5px; }
.efc-chip:has(.efc-chip-price) .efc-chip-val { grid-column: 2; font-size: 13px; }
.efc-chip-price { grid-column: 2; font-size: 11px; color: var(--efc-muted); white-space: nowrap; }
.efc-band-sum:has(> :nth-child(4)) { display: grid; grid-template-columns: repeat(3, auto); gap: 4px 16px; align-content: center; }
.efc-chip.is-zero .efc-chip-val, .efc-chip.is-zero .efc-chip-label { color: var(--efc-muted); font-weight: 500; }
.efc-chip.is-hl { background: var(--efc-band); }
.efc-legend button[aria-pressed="false"] .efc-chip-val { font-weight: 500; }
@media (max-width: 760px) {
  .efc-band { flex-wrap: wrap; }
  .efc-band-when { border-right: 0; flex-direction: row; align-items: baseline; gap: 8px; padding: 6px 10px 0; min-width: 0; width: 100%; }
  .efc-band-items { flex-wrap: nowrap; overflow-x: auto; scrollbar-width: none; width: 100%; padding: 2px 4px; }
  .efc-band-items > * { flex: none; } /* keep each reading's width inside the scroller */
  .efc-band-sum { border-left: 0; border-top: 1px solid var(--efc-border); width: 100%; justify-content: space-between; padding: 6px 10px; }
}

.efc-plot { position: relative; }
.efc { min-width: 0; }
/* percentage width → zero min-content, so the chart never props its container open when it shrinks */
.efc-plot svg, .efc-nav { display: block; overflow: visible; width: 100%; height: auto; }
.efc-hit { cursor: crosshair; touch-action: pan-y; }
.efc-hit:focus { outline: none; }
.efc-plot:focus-within .efc-focusring { opacity: 1; }
.efc-focusring { opacity: 0; transition: opacity .15s; }
.efc-area, .efc-line { transition: opacity .18s ease; }
.efc-dim { opacity: .18; }
.efc-dimline { opacity: .3; }

.efc-now circle.pulse { animation: efc-pulse 2s ease-out infinite; transform-box: fill-box; transform-origin: center; }
@keyframes efc-pulse { 0% { transform: scale(1); opacity: .55; } 100% { transform: scale(3.2); opacity: 0; } }
@media (prefers-reduced-motion: reduce) { .efc-now circle.pulse { animation: none; opacity: 0; } }

.efc-nav-wrap { position: relative; margin-top: 6px; }
.efc-nav { touch-action: none; user-select: none; }
.efc-nav .win { cursor: grab; }
.efc-nav .win:active { cursor: grabbing; }
.efc-nav .handle { cursor: ew-resize; }

.efc-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }

@media (max-width: 560px) {
  .efc-legend button { font-size: 12px; padding: 3px 7px 3px 5px; gap: 5px; }
}
.efc-table { max-height: 320px; overflow: auto; margin-top: 12px; border: 1px solid var(--efc-border); border-radius: 8px; }
.efc-table[hidden] { display: none; }
.efc-table table { border-collapse: collapse; width: 100%; font-size: 12px; font-variant-numeric: tabular-nums; }
.efc-table th, .efc-table td { padding: 6px 10px; text-align: right; border-bottom: 1px solid var(--efc-grid); white-space: nowrap; }
.efc-table th { position: sticky; top: 0; background: var(--efc-surface); color: var(--efc-ink2); font-weight: 600; }
.efc-table th:first-child, .efc-table td:first-child { text-align: left; }
.efc-table tr.is-hover td { background: var(--efc-band); }

/* ---------------- cards ---------------- */
.efc-cards { display: grid; gap: 10px; grid-template-columns: repeat(auto-fit, minmax(var(--efc-card-min, 160px), 1fr)); }
.efc-card {
  all: unset; box-sizing: border-box; position: relative; display: flex; flex-direction: column; gap: 1px; min-width: 0;
  padding: 10px 12px 8px 14px; border-radius: 10px; cursor: pointer; overflow: hidden;
  background: var(--efc-surface); border: 1px solid var(--efc-border);
  transition: transform .15s ease, box-shadow .15s ease, opacity .15s ease, border-color .15s;
}
.efc-card::before { content: ""; position: absolute; inset: 0; background: var(--card-color); opacity: .06; pointer-events: none; transition: opacity .15s; }
.efc-card::after { content: ""; position: absolute; left: 0; top: 10px; bottom: 10px; width: 3px; border-radius: 0 3px 3px 0; background: var(--card-color); }
.efc-card.is-static:hover { transform: none; box-shadow: none; }
.efc-card:hover, .efc-card.is-hl { transform: translateY(-1px); box-shadow: 0 4px 12px rgba(0,0,0,.07); border-color: color-mix(in srgb, var(--card-color) 45%, transparent); }
.efc-card:hover::before, .efc-card.is-hl::before { opacity: .12; }
.efc-card:focus-visible { outline: 2px solid var(--efc-accent); outline-offset: 2px; }
.efc-card[aria-pressed="false"] { opacity: .5; }
.efc-card[aria-pressed="false"]::after { background: var(--efc-muted); }
.efc-card.is-static { cursor: default; }
.efc-card-top { display: flex; justify-content: space-between; align-items: center; gap: 6px; }
.efc-card-period { margin-top: -1px; font-size: 10.5px; font-weight: 600; color: var(--efc-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-variant-numeric: tabular-nums; }
.efc-card-label { font-size: 11.5px; font-weight: 600; color: var(--efc-ink2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.efc-card-icon { width: 20px; height: 20px; border-radius: 6px; display: grid; place-items: center; flex: none; color: var(--efc-ink2); background: color-mix(in srgb, var(--card-color) 16%, transparent); }
.efc-card-icon svg { width: 12px; height: 12px; }
.efc-card-value { font-size: 19px; font-weight: 700; letter-spacing: -0.01em; line-height: 1.2; color: var(--efc-ink); white-space: nowrap; }
.efc-card-value small { font-size: 11.5px; font-weight: 600; color: var(--efc-ink2); margin-left: 3px; }
.efc-card-sub { font-size: 11px; color: var(--efc-muted); min-height: 1.35em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-variant-numeric: tabular-nums; }
.efc-card-sub.is-live { color: var(--efc-ink2); }
.efc-card-sub.is-live b { color: var(--efc-ink); font-weight: 650; }
.efc-card-spark { display: block; width: 100%; height: 20px; margin-top: 4px; overflow: visible; color: var(--efc-ink2); }
`;

let injected = false;
export function injectStyles(doc = typeof document !== 'undefined' ? document : null) {
  if (injected || !doc) return;
  if (doc.getElementById('efc-styles')) { injected = true; return; }
  const el = doc.createElement('style');
  el.id = 'efc-styles';
  el.textContent = css;
  doc.head.appendChild(el);
  injected = true;
}
