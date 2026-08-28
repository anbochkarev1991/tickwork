/**
 * `<LiveTable>`'s stylesheet, shipped as a string and injected once per
 * document. A single `<style>` tag keeps the package dependency-free (no CSS
 * build step for consumers, no CSS-in-JS runtime) while still looking like
 * something you would put in front of a user.
 *
 * Everything is scoped under `.tickwork-table` and driven by custom properties,
 * so overriding is a matter of setting variables rather than fighting
 * specificity.
 */
export const LIVE_TABLE_STYLES = `
.tickwork-table-wrap {
  --tickwork-bg: #0e1117;
  --tickwork-bg-alt: #141922;
  --tickwork-border: #232a36;
  --tickwork-text: #e6edf3;
  --tickwork-muted: #8b98a9;
  --tickwork-up: #21c07a;
  --tickwork-down: #ef5350;
  --tickwork-flash-up: rgba(33, 192, 122, 0.17);
  --tickwork-flash-down: rgba(239, 83, 80, 0.17);
  --tickwork-radius: 10px;
  --tickwork-font: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;

  background: var(--tickwork-bg);
  border: 1px solid var(--tickwork-border);
  border-radius: var(--tickwork-radius);
  overflow: auto;
  color: var(--tickwork-text);
}
.tickwork-table {
  width: 100%;
  border-collapse: collapse;
  font-family: var(--tickwork-font);
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}
.tickwork-table thead th {
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--tickwork-bg-alt);
  color: var(--tickwork-muted);
  font-weight: 600;
  font-size: 11px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  text-align: left;
  padding: 9px 12px;
  border-bottom: 1px solid var(--tickwork-border);
  white-space: nowrap;
}
.tickwork-table tbody td {
  padding: 7px 12px;
  border-bottom: 1px solid color-mix(in srgb, var(--tickwork-border) 55%, transparent);
  white-space: nowrap;
  transition: background-color 320ms ease-out;
}
.tickwork-table tbody tr:last-child td { border-bottom: none; }
.tickwork-table tbody tr:hover td { background: color-mix(in srgb, var(--tickwork-bg-alt) 70%, transparent); }
.tickwork-align-right { text-align: right; }
.tickwork-align-center { text-align: center; }
.tickwork-row-clickable { cursor: pointer; }
.tickwork-empty {
  padding: 28px 12px;
  text-align: center;
  color: var(--tickwork-muted);
  font-family: var(--tickwork-font);
  font-size: 13px;
}
.tickwork-flash-up { background-color: var(--tickwork-flash-up); transition: none; }
.tickwork-flash-down { background-color: var(--tickwork-flash-down); transition: none; }
@media (prefers-reduced-motion: reduce) {
  .tickwork-table tbody td { transition: none; }
  .tickwork-flash-up, .tickwork-flash-down { background-color: transparent; }
}
`;

const STYLE_ELEMENT_ID = 'tickwork-live-table-styles';

/**
 * Inject the stylesheet once. Safe to call from every `<LiveTable>` on the page
 * and safe on the server (where it does nothing).
 */
export function ensureLiveTableStyles(): void {
  if (typeof document === 'undefined') return;
  if (document.getElementById(STYLE_ELEMENT_ID) !== null) return;
  const style = document.createElement('style');
  style.id = STYLE_ELEMENT_ID;
  style.textContent = LIVE_TABLE_STYLES;
  document.head.appendChild(style);
}
