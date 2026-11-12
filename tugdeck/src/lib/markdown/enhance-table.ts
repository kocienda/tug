/**
 * `enhanceTable` — DOM-walks a markdown block container after its
 * `innerHTML` is set and applies post-parse affordances to every
 * `<table>` produced by pulldown-cmark / DOMPurify.
 *
 * **Tier 0 — shared block chrome + two-tier sticky headers.**
 * Wraps each bare `<table>` in the same `enhance-block-chrome` frame a
 * fenced code block wears: a sticky header strip (row-count identity +
 * Copy + fold cue) that joins the transcript pin-stack via
 * `top: var(--tugx-pin-stack-top, 0)`, and the table itself as the
 * collapsible `.tugx-md-chrome-body`. There is NO inner scroll region,
 * so the page never shows a scroller-inside-a-scroller. The table's own
 * `<thead>` is the SECOND sticky tier — it stacks directly under the
 * block header (`top: calc(pin-stack + header-height)`), the same
 * chrome-header → section-header telescoping the diff block uses. The
 * CSS (in `styles/tugx-md.css`) also paints zebra striping on
 * `tbody tr:nth-child(even)`. The fold cue collapses the whole table to
 * its header strip, matching the fenced-code block exactly.
 *
 * **Tier 1 — vanilla-JS click-to-sort.** Attaches a single capture-
 * phase click listener to each table's `<thead>`. Clicking a `<th>`
 * cycles its column through `null → asc → desc → null`; clicking a
 * different column resets the new column to `asc`. Sort state is
 * stored as DOM attributes on the `<table>` element (no React state,
 * no module-level map, no preservation hooks needed — the DOM IS the
 * state per [L06]).
 *
 * Comparison uses a single shared `Intl.Collator` configured for
 * locale-aware numeric collation (`"10"` sorts after `"2"`). JS's
 * `Array.prototype.sort` is stable as of ES2019, so the original
 * row order is preserved on ties without a secondary key.
 *
 * Opt-out: a `<th>` with class `no-sort` is excluded — clicking it
 * is a no-op and its column is never sortable. Mirrors the
 * tofsjonas/sortable convention.
 *
 * Idempotent: a `<table>` already marked with
 * `data-tugx-table-enhanced="true"` is skipped on re-walks. The
 * mark sits on the `<table>` itself so the existing-DOM check
 * survives even if a future enhancer reorganizes the wrapper.
 *
 * No listener cleanup is needed — when the parent block element is
 * replaced (`el.innerHTML = ...` write, or the windowing engine's
 * prune step), the table and its single thead listener are detached
 * and garbage-collected together. Per-delta re-attachment after a
 * markdown reconciler wipe is cheap (one `addEventListener` per
 * table) — no React tree to mount, no flash to debounce.
 *
 * Laws:
 *  - [L01] no `root.render()` — pure DOM mutation, no React mount.
 *  - [L06] appearance through DOM/CSS, not React state. The sort
 *    indicator is a CSS pseudo-element keyed off the `<table>`'s
 *    `data-tugx-table-sort-*` attributes; the visible state is the
 *    DOM, not a React render.
 *  - [L19] file pair (this `.ts` + a sibling test file for the
 *    pure-logic helpers), module docstring, exported function.
 *
 * @module lib/markdown/enhance-table
 */

import {
  buildBlockHeader,
  buildCopyButton,
  buildFoldButton,
} from "./enhance-block-chrome";

const ENHANCED_ATTR = "data-tugx-table-enhanced";
const SORT_COLUMN_ATTR = "data-tugx-table-sort-column";
const SORT_DIRECTION_ATTR = "data-tugx-table-sort-direction";
const NO_SORT_CLASS = "no-sort";
const FRAME_CLASS = "tugx-md-table-block";

/**
 * Sort direction kept on a `<table>` element's
 * `data-tugx-table-sort-direction` attribute. `null` means the
 * column is unsorted (original document order).
 */
export type SortDirection = "asc" | "desc" | null;

/**
 * Sort state derived from / written back to a `<table>`'s DOM
 * attributes. The column index is `null` when no column is sorted;
 * direction follows the cycle `null → asc → desc → null`.
 */
export interface SortState {
  column: number | null;
  direction: SortDirection;
}

/** Shared collator — locale-aware numeric collation, stable on ties. */
const collator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

/**
 * Walk every `<table>` in `container` and apply the markdown-table
 * affordances described in the module docstring. Skips tables that
 * have already been enhanced.
 *
 * Safe to call on any container — if there are no tables, the walk
 * is a single `querySelectorAll` that finds zero matches.
 */
export function enhanceTable(container: HTMLElement): void {
  const tables = container.querySelectorAll<HTMLTableElement>(
    `table:not([${ENHANCED_ATTR}])`,
  );
  for (const table of tables) {
    table.setAttribute(ENHANCED_ATTR, "true");
    wrapInBlockChrome(table);
    attachSortHandler(table);
  }
}

/**
 * Wrap a `<table>` in the shared block chrome if it isn't already inside
 * one: a `.tugx-md-table-block` frame holding a sticky header strip
 * (row-count identity + Copy + fold cue) above the table, which becomes
 * the collapsible `.tugx-md-chrome-body`. No `overflow` is set anywhere,
 * so there is no nested scroller and the table's `<thead>` sticks to the
 * transcript scroller (stacking under the block header).
 *
 * Exported for tests.
 */
export function wrapInBlockChrome(table: HTMLTableElement): void {
  const parent = table.parentElement;
  if (parent === null) return;
  if (parent.classList.contains("tugx-md-chrome-body")) return;

  const rowCount = table.tBodies[0]?.rows.length ?? 0;

  const frame = document.createElement("div");
  frame.className = FRAME_CLASS;
  // The `data` block variant — the DOM-substrate citizen of the block
  // contract ([P04], [P07]). It shares the `--tugx-block-*` token surface and
  // affordance shapes with the React `BlockChrome`; stamping `data-variant`
  // marks it as a contract member so a variant-scoped token change reaches it.
  frame.dataset.variant = "data";

  // Row-count identity, styled like the fence's language label.
  const title = document.createElement("span");
  title.className = "tugx-md-table-title";
  title.textContent = `${rowCount} ${rowCount === 1 ? "row" : "rows"}`;

  const header = buildBlockHeader({
    identity: title,
    actions: [
      buildCopyButton(() => tableToMarkdown(table), "Copy table"),
      buildFoldButton(frame, {
        ariaExpand: "Expand table",
        ariaCollapse: "Collapse table",
      }),
    ],
  });

  // The table is the collapsible body the fold cue hides. The body div
  // (not the table) carries the chrome-body class so the frame's
  // `> .tugx-md-chrome-body` collapse rule has a direct child to hide,
  // and the table keeps `<thead>`/`<tbody>` as its only children.
  const body = document.createElement("div");
  body.className = "tugx-md-chrome-body";

  parent.insertBefore(frame, table);
  body.appendChild(table);
  frame.appendChild(header);
  frame.appendChild(body);
}

/**
 * Serialize a `<table>` back to a GFM markdown table for the Copy
 * control — markdown is the source format, so a paste round-trips. Cell
 * text is taken from `textContent` (the rendered cell), pipes are
 * escaped, and the column count follows the header row.
 */
export function tableToMarkdown(table: HTMLTableElement): string {
  const escape = (s: string): string =>
    (s ?? "").trim().replace(/\|/g, "\\|").replace(/\n/g, " ");
  const rowCells = (row: HTMLTableRowElement): string[] =>
    Array.from(row.cells).map((c) => escape(c.textContent ?? ""));

  const headerRow = table.tHead?.rows[0];
  const headers = headerRow ? rowCells(headerRow) : [];
  const columnCount = headers.length;
  if (columnCount === 0) return "";

  const lines: string[] = [];
  lines.push(`| ${headers.join(" | ")} |`);
  lines.push(`| ${headers.map(() => "---").join(" | ")} |`);
  const tbody = table.tBodies[0];
  if (tbody) {
    for (const row of Array.from(tbody.rows)) {
      const cells = rowCells(row);
      while (cells.length < columnCount) cells.push("");
      lines.push(`| ${cells.slice(0, columnCount).join(" | ")} |`);
    }
  }
  return lines.join("\n");
}

/**
 * Attach a click listener on the table's `<thead>` that dispatches
 * sort cycles per-column. Initializes the `aria-sort` attribute on
 * every sortable header to `"none"` so screen readers can read the
 * column as sortable before the user has clicked.
 *
 * Exported for tests.
 */
export function attachSortHandler(table: HTMLTableElement): void {
  const thead = table.tHead;
  if (thead === null) return;
  const headerRow = thead.rows[0];
  if (headerRow === undefined) return;

  for (const th of Array.from(headerRow.cells)) {
    if (th.classList.contains(NO_SORT_CLASS)) continue;
    th.setAttribute("aria-sort", "none");
  }

  thead.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const th = target.closest("th");
    if (th === null) return;
    if (th.classList.contains(NO_SORT_CLASS)) return;
    if (th.parentElement !== headerRow) return;
    const columnIndex = Array.from(headerRow.cells).indexOf(
      th as HTMLTableCellElement,
    );
    if (columnIndex < 0) return;
    applySort(table, columnIndex);
  });
}

/**
 * Apply one sort click to a `<table>`. Reads the current sort state
 * off the `<table>`'s DOM attributes, computes the next state via
 * {@link nextSort}, rewrites the `<tbody>` rows in place, and writes
 * the new state back to the DOM (attributes + `aria-sort`).
 *
 * Exported for tests.
 */
export function applySort(table: HTMLTableElement, columnIndex: number): void {
  const current = readSortState(table);
  const next = nextSort(current, columnIndex);
  writeSortState(table, next);
  renderSortedRows(table, next);
}

/**
 * Pure state transition: given the current sort state and the
 * clicked column index, return the next state.
 *
 *  - Click a *different* column → `(columnIndex, "asc")`.
 *  - Click the *same* column unsorted → `("asc")`.
 *  - Click the *same* column asc → `("desc")`.
 *  - Click the *same* column desc → unsorted (`null` direction,
 *    `null` column).
 *
 * Exported for tests.
 */
export function nextSort(current: SortState, columnIndex: number): SortState {
  if (current.column !== columnIndex) {
    return { column: columnIndex, direction: "asc" };
  }
  if (current.direction === "asc") {
    return { column: columnIndex, direction: "desc" };
  }
  if (current.direction === "desc") {
    return { column: null, direction: null };
  }
  return { column: columnIndex, direction: "asc" };
}

/**
 * Locale-aware comparator over two cell text values. Numeric option
 * means `"10"` sorts after `"2"`; `sensitivity: "base"` ignores case
 * and diacritics so `"Étoile"` sits next to `"Etoile"`.
 *
 * Direction is the caller's concern — pass `"asc"` to get ascending
 * order, `"desc"` to flip the sign.
 *
 * Exported for tests.
 */
export function compareCells(
  a: string,
  b: string,
  direction: Exclude<SortDirection, null>,
): number {
  const cmp = collator.compare(a, b);
  if (cmp === 0) return 0;
  return direction === "asc" ? cmp : -cmp;
}

function readSortState(table: HTMLTableElement): SortState {
  const columnRaw = table.getAttribute(SORT_COLUMN_ATTR);
  const directionRaw = table.getAttribute(SORT_DIRECTION_ATTR);
  const column = columnRaw === null ? null : Number.parseInt(columnRaw, 10);
  const direction: SortDirection =
    directionRaw === "asc" || directionRaw === "desc" ? directionRaw : null;
  if (column === null || Number.isNaN(column) || direction === null) {
    return { column: null, direction: null };
  }
  return { column, direction };
}

function writeSortState(table: HTMLTableElement, state: SortState): void {
  if (state.column === null || state.direction === null) {
    table.removeAttribute(SORT_COLUMN_ATTR);
    table.removeAttribute(SORT_DIRECTION_ATTR);
  } else {
    table.setAttribute(SORT_COLUMN_ATTR, String(state.column));
    table.setAttribute(SORT_DIRECTION_ATTR, state.direction);
  }
  syncAriaSort(table, state);
}

function syncAriaSort(table: HTMLTableElement, state: SortState): void {
  const headerRow = table.tHead?.rows[0];
  if (headerRow === undefined) return;
  const cells = Array.from(headerRow.cells);
  for (let i = 0; i < cells.length; i += 1) {
    const th = cells[i];
    if (th.classList.contains(NO_SORT_CLASS)) continue;
    if (state.column === i && state.direction === "asc") {
      th.setAttribute("aria-sort", "ascending");
    } else if (state.column === i && state.direction === "desc") {
      th.setAttribute("aria-sort", "descending");
    } else {
      th.setAttribute("aria-sort", "none");
    }
  }
}

/**
 * Reorder the `<tbody>` rows in place to match the requested sort
 * state. For an unsorted state, restores the original document order
 * captured from `data-tugx-table-original-index` (stamped on each
 * row the first time the table is sorted).
 */
function renderSortedRows(table: HTMLTableElement, state: SortState): void {
  const tbody = table.tBodies[0];
  if (tbody === undefined) return;
  const rows = Array.from(tbody.rows);
  if (rows.length === 0) return;

  stampOriginalIndices(rows);

  if (state.column === null || state.direction === null) {
    rows.sort((a, b) => readOriginalIndex(a) - readOriginalIndex(b));
  } else {
    const column = state.column;
    const direction = state.direction;
    rows.sort((a, b) =>
      compareCells(cellText(a, column), cellText(b, column), direction),
    );
  }

  for (const row of rows) {
    tbody.appendChild(row);
  }
}

function stampOriginalIndices(rows: ReadonlyArray<HTMLTableRowElement>): void {
  for (let i = 0; i < rows.length; i += 1) {
    if (!rows[i].hasAttribute("data-tugx-table-original-index")) {
      rows[i].setAttribute("data-tugx-table-original-index", String(i));
    }
  }
}

function readOriginalIndex(row: HTMLTableRowElement): number {
  const raw = row.getAttribute("data-tugx-table-original-index");
  if (raw === null) return 0;
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function cellText(row: HTMLTableRowElement, column: number): string {
  const cell = row.cells[column];
  if (cell === undefined) return "";
  return (cell.textContent ?? "").trim();
}
