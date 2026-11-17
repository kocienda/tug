/**
 * `renderChartInto` — the one piece of code that turns a chart source into
 * DOM. Three doors call it: the markdown enhancer for a ` ```tugchart `
 * fence placeholder, the `ChartBlock` body kind from its layout effect, and
 * through `ChartBlock` the Bash block and any instrument. Because there is
 * one renderer there is nothing for the doors to disagree about.
 *
 * The pipeline, in order:
 *
 *  1. Stamp `data-tugx-chart-state="pending"` and put the source in a
 *     folded frame: a header naming what is being drawn, and the spec
 *     behind its fold cue. A spec is drawing commands, never prose, so no
 *     state shows it open; it is one press away in every state that has not
 *     drawn ([L32]).
 *  2. Load the engine, with a 10 s deadline. Past it the state is
 *     `unavailable`, the source stays, and a note says why ([L33]).
 *  3. Validate the source for the door's `layers`. An invalid source shows
 *     as `invalid`: the same folded frame on the caution band, every error
 *     and the source behind the fold.
 *  4. Put one hidden, empty probe per type role in the host and wait for
 *     their faces, with a 3 s deadline, after which whatever face is present
 *     is measured.
 *  5. Run the measure protocol at the host's width, read once.
 *  6. Build the figure off-document: the block header (title, Copy, a link
 *     glyph when the chart carries refs, a Table toggle), the SVG, and the
 *     `<table>` alternative built with `textContent`; the remembered view;
 *     the entrance attribute. The header is the title's one home, so the SVG
 *     is compiled without it, and an untitled chart wears quiet chrome with
 *     no placeholder word. A chart's marks read their row of that table on
 *     hover (`chart-hover`), and each mark carries its effective ref on its
 *     hit path, so a mark links as its Table atom does and a set mark opens
 *     its report (`chart-ref-set`): a panel under the figure whose head and
 *     host this module's DOM owns and whose rows are React's, mounted by
 *     `chart-report-portals` into the host the panel stamps. A dot, a span
 *     and a stacked row's Table atom are report marks of their own.
 *  7. Replace the host's children in one write and set `rendered`.
 *  8. With the surface's annotation context, annotate the figure: a chart's
 *     refs, drawn as atoms in its Table view, are resolved through the one
 *     gate every reference passes, and a diagram's locations are checked.
 *     The surface hears of it through `CHART_ANNOTATED_EVENT`, which is how
 *     a confirmed atom gets its pill or chip.
 *
 * Colour and type never appear here: the SVG carries role classes and
 * `chart-block.css` maps them to tokens, which is what lets a theme switch
 * restyle a chart already on screen with no re-render. That stylesheet is
 * the body kind's; the markdown door (`tug-markdown-block.tsx`) imports it
 * beside its own, since a lib module imports nothing from components.
 *
 * There is no recompile on resize. The SVG carries `max-width: 100%` and
 * `height: auto`, so a narrower card scales the figure down.
 *
 * **Entrances play once per source per page, and none in the dark.** The
 * first time a source hash is rendered the figure gets
 * `data-tugx-chart-animate`, under which the CSS plays the op entrances; a
 * later render of the same source is still. A host inside a space layer
 * that is not shown gets no entrance and does not spend its hash, so the
 * chart still enters the first time it is rendered where someone can see
 * it ([L23]). {@link takeEntrance} is that decision, pure.
 *
 * **A thumbnail is the figure alone, and it never moves.** It is laid out at
 * one fixed width and scaled by CSS to fit its host, so the shape stays true
 * and its small text is not meant to be read. It has no header and no table
 * alternative, shows nothing while it waits, plays no entrance, and spends no
 * hash, so the same chart in the transcript still enters.
 *
 * **A picture is the figure as it leaves the card.** The share page draws
 * one to render a figure to an image: at the figure's own width, never the
 * host's, with its title drawn in the figure since no header travels with
 * it, still, and with no header, hover or Table view. A diagram keeps its
 * keyed table beneath it, because its numbered discs refer to that table.
 * The host is given the width the picture came to ({@link pictureWidth}).
 *
 * Laws: [L06] every state is a `data-` attribute styled by CSS; [L24] the
 * DOM is structure written once, the entrance set is module-local data;
 * [L32] the source is reachable until the figure replaces it; [L33] both
 * waits have horizons.
 *
 * @module lib/chart/render-chart
 */

import { annotateElement } from "@/lib/annotator/annotate-content";
import {
  NO_SCAN_ATTR,
  REF_ATTR,
  REF_KIND_ATTR,
  REF_REPORT_ATTR,
  REF_LABEL_ATTR,
  REF_ROW_ATTR,
  REF_SET_ATTR,
} from "@/lib/annotator/chart-refs";
import type { AnnotationContext } from "@/lib/annotator/types";
import { CHART_ANNOTATED_EVENT, setChartFigureData } from "@/lib/chart/chart-figure-data";
import { attachChartHover, endChartHoverIn } from "@/lib/chart/chart-hover";
import { awaitRoleFaces, ensureRoleProbes, probeMeasurer, roleFacesLoaded, runMeasureLoop } from "@/lib/chart/chart-measure";
import { attachRefLight } from "@/lib/chart/chart-ref-light";
import { attachRefSets, detachRefSetIn, restoreRefSet } from "@/lib/chart/chart-ref-set";
import { recallChartView, rememberChartView, type ChartView } from "@/lib/chart/chart-view-memory";
import {
  canReport,
  counted,
  effectiveRef,
  foldItemSlots,
  isReportable,
  slotKind,
  slotLabel,
  wholeRowSlot,
  type RefTarget,
} from "@/lib/chart/chart-table-refs";
import { isDiagramSource, keyedRows } from "@/lib/chart/keyed-table";
import { textHash } from "@/lib/ingest/text-hash";
import {
  getTuggraphicsSync,
  loadTuggraphics,
  type ChartLayers,
  type ChartMarkRef,
  type ChartRefSlot,
  type ChartTable,
  type ChartTableRefs,
  type TuggraphicsEngine,
} from "@/lib/lazy/load-tuggraphics";
import {
  copyFigurePicture,
  figureBaseName,
  figureCopyLabel,
  figureHeaderActions,
  figureShareLabel,
  shareFigure,
} from "@/lib/chart/figure-export";
import {
  buildAsyncButton,
  buildAsyncCopyButton,
  buildBlockHeader,
  buildCopyButton,
  buildFoldButton,
  SHARE_ICON,
} from "@/lib/markdown/enhance-block-chrome";
import { isShareAvailable } from "@/lib/os-share";
import { SPACE_LAYER_CLASS, SPACE_SHOWN_ATTRIBUTE } from "@/lib/pane-frame-selectors";

/** The figure's class on every door. */
export const CHART_CLASS = "tugx-chart";
/** `pending | rendered | invalid | unavailable`. */
export const CHART_STATE_ATTR = "data-tugx-chart-state";
/** `chart | table`. */
export const CHART_VIEW_ATTR = "data-tugx-chart-view";
/** Present on a figure whose entrances play. */
export const CHART_ANIMATE_ATTR = "data-tugx-chart-animate";
/** Present on a figure with no title, whose header is quiet. */
export const CHART_UNTITLED_ATTR = "data-tugx-chart-untitled";
/** The fence transformer's flag; its presence means "not yet rendered". */
export const CHART_PENDING_ATTR = "data-tugx-chart-pending";
/** Present on a figure drawn as a thumbnail. */
export const CHART_THUMBNAIL_ATTR = "data-tugx-chart-thumbnail";
/** Present on a figure drawn as a picture. */
export const CHART_PICTURE_ATTR = "data-tugx-chart-picture";
/**
 * `diagram` on a figure drawn from a diagram spec, whose keyed table stands
 * beneath it rather than behind the Table toggle.
 */
export const CHART_KIND_ATTR = "data-tugx-chart-kind";
/**
 * Present on a diagram whose locations a resolver has been asked about. Only
 * then does a location it did not confirm wear the unresolved mark; with no
 * resolver to ask, a location is plain code, claimed neither way.
 */
export const DIAGRAM_CHECKED_ATTR = "data-tugx-where-checked";

/** The width a thumbnail is laid out at, before CSS scales it to its host. */
export const THUMBNAIL_LAYOUT_WIDTH = 480;

/**
 * The narrowest a picture with a keyed table is drawn, in px. A small
 * diagram is narrower than four columns of prose can be read at.
 */
export const PICTURE_KEYED_FLOOR = 560;

/**
 * The width a picture's host takes: the figure's own, or the keyed table's
 * floor when a table stands beneath a figure narrower than it.
 */
export function pictureWidth(figureWidth: number, keyed: boolean): number {
  const width = Math.ceil(figureWidth);
  return keyed ? Math.max(width, PICTURE_KEYED_FLOOR) : width;
}

/** The figure's record and its annotated event, which the set list shares. */
export { CHART_ANNOTATED_EVENT, chartFigureData, type ChartFigureData } from "@/lib/chart/chart-figure-data";

/** How long a chart waits for the engine before showing the source as code. */
export const ENGINE_DEADLINE_MS = 10_000;

/** How many source hashes the page remembers having entered. */
export const ENTRANCE_LIMIT = 512;

export const ENGINE_UNAVAILABLE_NOTE = "Chart engine did not load";
const MEASURE_UNAVAILABLE_NOTE = "Text measurement is not available on this page";

/** Text the face wait asks the faces for: digits and letters, which every chart has. */
const FACE_SAMPLE = "Chart 0123456789";

export interface RenderChartOptions {
  /** Which layers this door accepts. A fence takes charts only; a tool's stdout either. */
  layers?: ChartLayers;
  /** Draw the figure alone, scaled to its host and still. */
  thumbnail?: boolean;
  /**
   * Draw the figure as a picture that leaves the card: at its own width,
   * titled, still, with no header; a diagram with its keyed table.
   */
  picture?: boolean;
  /**
   * The surface's annotation context. Given, a rendered figure is annotated
   * with it — a chart's refs resolved and stamped, a diagram's locations
   * checked — and {@link CHART_ANNOTATED_EVENT} is dispatched on it. A
   * thumbnail is never annotated: it is not meant to be read.
   */
  annotation?: AnnotationContext;
}

/** The source hashes that have entered on this page, oldest first. */
const entered = new Set<string>();

/** Per host, the render that is current; an older one that resolves later writes nothing. */
const renders = new WeakMap<HTMLElement, object>();

let nextId = 0;

/**
 * Whether a chart with source hash `hash` plays its entrance now, and the
 * record of having done so. False, and `set` untouched, when `shown` is
 * false — the host is in the dark and the entrance is saved for a watcher.
 * Otherwise true exactly once per hash; past `limit` hashes the oldest is
 * forgotten, so a very long page can see a chart enter again.
 */
export function takeEntrance(set: Set<string>, hash: string, shown: boolean, limit: number = ENTRANCE_LIMIT): boolean {
  if (!shown) return false;
  if (set.has(hash)) return false;
  set.add(hash);
  while (set.size > limit) {
    const oldest = set.values().next().value;
    if (oldest === undefined) break;
    set.delete(oldest);
  }
  return true;
}

/** Whether `el` stands where someone can watch it: outside any space layer, or in a shown one. */
function isShown(el: HTMLElement): boolean {
  const layer = el.closest(`.${SPACE_LAYER_CLASS}`);
  return layer === null || layer.hasAttribute(SPACE_SHOWN_ATTRIBUTE);
}

function withDeadline<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(what)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/** The engine's load under its horizon; a loaded engine is read synchronously, not here. */
function engineWithDeadline(): Promise<TuggraphicsEngine> {
  return withDeadline(loadTuggraphics(), ENGINE_DEADLINE_MS, ENGINE_UNAVAILABLE_NOTE);
}

// ---------------------------------------------------------------------------
// Terminal states
// ---------------------------------------------------------------------------

function sourceBlock(source: string): HTMLPreElement {
  const pre = document.createElement("pre");
  pre.className = "tugx-chart-source";
  pre.textContent = source;
  return pre;
}

/** The frame attribute the block chrome's fold reads. */
const COLLAPSED_ATTR = "data-collapsed";

/**
 * The custom property a diagram's body carries its figure's natural width
 * in, in px. `chart-block.css` scales a diagram wider than its card down to
 * a floor of that width and scrolls it sideways past the floor.
 */
export const DIAGRAM_NATURAL_WIDTH_PROPERTY = "--tg-diagram-natural-w";

/**
 * A figure that has not drawn: one header line saying so, and behind its
 * fold cue the notes and the spec. The spec is drawing commands the reader
 * did not ask to see, so it starts folded in every such state and Copy
 * still reaches it. The header and the notes are Tug's words, not the
 * author's, and Find excludes both.
 */
function showUndrawn(el: HTMLElement, source: string, label: string, notes: HTMLElement | null, diagram: boolean): void {
  const identity = document.createElement("span");
  identity.className = "tugx-chart-title";
  identity.textContent = label;
  const header = buildBlockHeader({
    identity,
    actions: [
      buildCopyButton(() => source, figureCopyLabel("source", diagram)),
      buildFoldButton(el, { ariaExpand: "Show source", ariaCollapse: "Hide source" }, true),
    ],
  });
  const body = document.createElement("div");
  body.className = "tugx-md-chrome-body";
  if (notes !== null) body.appendChild(notes);
  body.appendChild(sourceBlock(source));
  el.replaceChildren(header, body);
}

function showUnavailable(el: HTMLElement, source: string, message: string, diagram: boolean): void {
  const note = document.createElement("p");
  note.className = "tugx-chart-note";
  note.textContent = message;
  showUndrawn(el, source, diagram ? "Diagram not drawn" : "Chart not drawn", note, diagram);
  el.setAttribute(CHART_STATE_ATTR, "unavailable");
}

function showInvalid(
  el: HTMLElement,
  source: string,
  errors: ReadonlyArray<{ path: string; message: string }>,
  diagram: boolean,
): void {
  const list = document.createElement("ul");
  list.className = "tugx-chart-note";
  for (const error of errors) {
    const item = document.createElement("li");
    item.textContent = error.path === "" ? error.message : `${error.path}: ${error.message}`;
    list.appendChild(item);
  }
  showUndrawn(el, source, diagram ? "Diagram not drawn" : "Chart not drawn", list, diagram);
  el.setAttribute(CHART_STATE_ATTR, "invalid");
}

// ---------------------------------------------------------------------------
// The figure
// ---------------------------------------------------------------------------

const SVG_NS = "http://www.w3.org/2000/svg";

/** Lucide `Table` (24×24 viewBox), in the chrome's stroke style. */
function buildTableIcon(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  const shapes: [string, Record<string, string>][] = [
    ["path", { d: "M12 3v18" }],
    ["rect", { width: "18", height: "18", x: "3", y: "3", rx: "2" }],
    ["path", { d: "M3 9h18" }],
    ["path", { d: "M3 15h18" }],
  ];
  for (const [tag, attrs] of shapes) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    svg.appendChild(node);
  }
  return svg;
}

/** Lucide `Link` (24×24 viewBox), in the chrome's stroke style. */
function buildLinkIcon(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  for (const d of [
    "M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71",
    "M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71",
  ]) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.appendChild(path);
  }
  return svg;
}

/**
 * The header's link glyph: the resting sign that this figure links
 * somewhere, shown only once the annotation pass has confirmed a ref or
 * found an actionable set (`data-tugx-chart-linked`, CSS reveals it). A
 * press shows the Table view, where every link is an atom; it presses the
 * Table toggle itself, so the toggle's state, its label and the view memory
 * all move together. In the Table view already, it does nothing more.
 */
function buildLinksButton(figure: HTMLElement, toggle: HTMLButtonElement): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "tugx-md-chrome-btn tugx-chart-links";
  button.setAttribute("aria-label", "Show links as table");
  button.appendChild(buildLinkIcon());
  button.addEventListener("click", (e) => {
    e.preventDefault();
    if (figure.getAttribute(CHART_VIEW_ATTR) !== "table") toggle.click();
  });
  return button;
}

/**
 * Write each mark's effective ref (Spec S03) on its hit path, so the
 * annotation pass stamps a mark exactly as it stamps a Table atom, and a set
 * mark opens its list ([P07]). A count form is a set a press can open only
 * where `reports` holds; elsewhere its mark stays unstamped ([L31]). A mark
 * whose ref is its row's says so, which is what lights the row's label rule.
 *
 * In a `dots` or a `spans` chart the recipe can be asked about, a mark with
 * a ref is a report mark instead: a press reads the dot's run or the span's
 * stage from the recipe, a report of one row, where the single ref could
 * only have opened what it names. A `dots` hit with no dot of its own
 * stands for the file's whole run history.
 */
function markHits(body: HTMLElement, refs: ChartTableRefs, reports: boolean, form: string): void {
  for (const hit of body.querySelectorAll<SVGElement>(".tgh[data-row]")) {
    const col = hit.getAttribute("data-col");
    const item = hit.getAttribute("data-item");
    const mark = hit.getAttribute("data-mark");
    const row = Number(hit.getAttribute("data-row"));
    const target: RefTarget = {
      row,
      ...(col === null ? {} : { col: Number(col) }),
      ...(item === null ? {} : { item: Number(item) }),
      ...(mark === null ? {} : { mark: Number(mark) }),
    };
    const slot = effectiveRef(refs, target);
    if (slot === null) continue;
    if (typeof slot === "string") {
      if (reports && mark === null && (form === "dots" || form === "spans")) {
        hit.setAttribute(REF_SET_ATTR, "");
        hit.setAttribute(REF_REPORT_ATTR, form === "dots" && item === null ? "runs" : "one");
        hit.setAttribute(REF_KIND_ATTR, form === "dots" ? "run" : "span");
        hit.setAttribute(REF_ROW_ATTR, String(row));
        continue;
      }
      hit.setAttribute(REF_ATTR, slot);
    }
    // A mark annotation has no row for the recipe to be asked about.
    else if (isReportable(slot, reports && mark === null)) {
      hit.setAttribute(REF_SET_ATTR, "");
      hit.setAttribute(REF_KIND_ATTR, slotKind(slot));
    } else continue;
    if (Object.is(slot, refs.rows[row] ?? null)) hit.setAttribute(REF_ROW_ATTR, String(row));
  }
}

/** The `form` a validated source names, or `""` when it does not read. */
function chartForm(source: string): string {
  try {
    const form = (JSON.parse(source) as { form?: unknown }).form;
    return typeof form === "string" ? form : "";
  } catch {
    return "";
  }
}

/**
 * The Table toggle, built in the block chrome's style. It flips the
 * figure's view attribute and writes the choice to the view memory; CSS
 * does the showing ([L06]).
 */
function buildViewToggle(figure: HTMLElement, hash: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "tugx-md-chrome-btn tugx-chart-view-toggle";
  button.setAttribute("aria-label", "Show as table");
  button.appendChild(buildTableIcon());
  const reflect = (view: ChartView): void => {
    button.setAttribute("aria-pressed", view === "table" ? "true" : "false");
    button.setAttribute("aria-label", view === "table" ? "Show as chart" : "Show as table");
  };
  reflect(figure.getAttribute(CHART_VIEW_ATTR) === "table" ? "table" : "chart");
  button.addEventListener("click", (e) => {
    e.preventDefault();
    const next: ChartView = figure.getAttribute(CHART_VIEW_ATTR) === "table" ? "chart" : "table";
    figure.setAttribute(CHART_VIEW_ATTR, next);
    rememberChartView(hash, next);
    reflect(next);
  });
  return button;
}

/**
 * One ref slot drawn as an atom, appended after its cell's own text, which
 * is left as it is ([P04]).
 *
 *  - A single ref is a `.tugx-chart-ref` host carrying the ref. The
 *    annotation pass stamps it when the ref resolves, and it stays plain
 *    text when it does not.
 *  - A set with members is a `.tugx-chart-set` button reading `57 commits`;
 *    its members are read from the figure's table when it is pressed.
 *  - A count form reads the same. Where the recipe that drew the chart can
 *    be asked (`reports`), it is a button like any set and a press reads
 *    the list from the recipe; elsewhere it offers nothing: no role, no
 *    focus, no act, so it makes no promise it cannot keep ([L31]).
 *
 * `address` says where in the table the slot lives (`row:3`, `cell:3:2`,
 * `col:2`, `items:3`, `mark:0`), which is how a press finds the members.
 */
function buildRefAtom(slot: ChartRefSlot, address: string, row: number | null, reports: boolean): HTMLSpanElement {
  const span = document.createElement("span");
  const label = slotLabel(slot);
  span.textContent = label;
  span.setAttribute(REF_LABEL_ATTR, label);
  span.setAttribute("data-tugx-ref-at", address);
  if (row !== null) span.setAttribute(REF_ROW_ATTR, String(row));
  if (typeof slot === "string") {
    span.className = "tugx-chart-ref";
    span.setAttribute(REF_ATTR, slot);
    return span;
  }
  span.className = "tugx-chart-set";
  span.setAttribute(REF_KIND_ATTR, slotKind(slot));
  if (isReportable(slot, reports)) {
    span.setAttribute(REF_SET_ATTR, "");
    span.setAttribute("role", "button");
    span.tabIndex = 0;
  }
  return span;
}

/**
 * A set atom whose press asks the recipe for more than a slot holds: a row
 * across all its series (`row`), or a file's run history (`runs`). Built
 * only where the recipe can be asked.
 */
function buildReportAtom(label: string, address: string, row: number, kind: string, mode: "row" | "runs"): HTMLSpanElement {
  const span = document.createElement("span");
  span.className = "tugx-chart-set";
  span.textContent = label;
  span.setAttribute(REF_LABEL_ATTR, label);
  span.setAttribute("data-tugx-ref-at", address);
  span.setAttribute(REF_ROW_ATTR, String(row));
  span.setAttribute(REF_KIND_ATTR, kind);
  span.setAttribute(REF_REPORT_ATTR, mode);
  span.setAttribute(REF_SET_ATTR, "");
  span.setAttribute("role", "button");
  span.tabIndex = 0;
  return span;
}

/** Append `slot`'s atom to `cell` when there is one. */
function appendAtom(
  cell: HTMLElement,
  slot: ChartRefSlot | null | undefined,
  address: string,
  row: number | null,
  reports: boolean,
): void {
  if (slot === null || slot === undefined) return;
  cell.appendChild(buildRefAtom(slot, address, row, reports));
}

/**
 * The table alternative, every cell written with `textContent`, and the
 * atoms of whatever its refs name appended after the text they stand
 * beside. The table is read only through those refs: it carries
 * `data-tugx-no-scan`, so the prose scan never reads a clipped label as a
 * path ([P05]).
 *
 * Where the recipe can be asked, two rows gain an atom no slot holds: a row
 * of a stacked chart whose refs are per cell gets one for the whole row,
 * reading its cells' summed count, and a `dots` row gets one for the file's
 * run history in place of its dots' folded commits.
 */
function buildTable(table: ChartTable, reports: boolean, form: string): HTMLTableElement {
  const refs = table.refs;
  const el = document.createElement("table");
  el.className = "tugx-chart-table";
  el.setAttribute(NO_SCAN_ATTR, "");
  const caption = document.createElement("caption");
  caption.textContent = table.caption;
  el.appendChild(caption);
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  table.head.forEach((cell, j) => {
    const th = document.createElement("th");
    th.scope = "col";
    th.textContent = cell;
    // A column has no row for the recipe to be asked about, so its count
    // form opens nothing whatever the figure can report.
    if (j > 0) appendAtom(th, refs?.cols[j], `col:${j}`, null, false);
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  el.appendChild(thead);
  const tbody = document.createElement("tbody");
  table.rows.forEach((row, i) => {
    const tr = document.createElement("tr");
    row.forEach((cell, j) => {
      const td = document.createElement("td");
      td.textContent = cell;
      if (j === 0) {
        appendAtom(td, refs?.rows[i], `row:${i}`, i, reports);
        const whole = reports ? wholeRowSlot(refs, i) : null;
        if (whole !== null) {
          td.appendChild(buildReportAtom(counted(whole.count, whole.kind), `row:${i}`, i, whole.kind, "row"));
        }
        const dots = refs?.items[i]?.length ?? 0;
        if (reports && form === "dots" && dots > 0) {
          td.appendChild(buildReportAtom(counted(dots, "run"), `items:${i}`, i, "run", "runs"));
        } else {
          for (const folded of foldItemSlots(refs?.items[i])) appendAtom(td, folded, `items:${i}`, null, reports);
        }
      } else {
        appendAtom(td, refs?.cells[i]?.[j], `cell:${i}:${j}`, null, reports);
      }
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  el.appendChild(tbody);
  if (refs !== undefined && refs.marks.length > 0) {
    el.appendChild(buildRefsFoot(refs.marks, Math.max(table.head.length, 2)));
  }
  return el;
}

/**
 * The mark annotations that carry a ref, one footer row each: the mark's
 * label and its atom. A mark's label is drawn in the figure, not in a cell,
 * so this is where the Table view reaches its ref.
 */
function buildRefsFoot(marks: readonly ChartMarkRef[], columns: number): HTMLTableSectionElement {
  const foot = document.createElement("tfoot");
  foot.className = "tugx-chart-refs-foot";
  foot.setAttribute(NO_SCAN_ATTR, "");
  for (const mark of marks) {
    const tr = document.createElement("tr");
    const label = document.createElement("td");
    label.textContent = mark.label;
    const atom = document.createElement("td");
    atom.colSpan = columns - 1;
    appendAtom(atom, mark.slot, `mark:${mark.index}`, null, false);
    tr.append(label, atom);
    foot.appendChild(tr);
  }
  return foot;
}

/**
 * A diagram's keyed table: number, name, what it does, where it is. It is
 * the figure's own, shown beneath it by default, so it has no toggle. The
 * text is in the order the engine's `find_text` reads, and the location is
 * an inline `<code>` the annotator resolves once the figure has landed; a
 * location it cannot confirm is marked unresolved by CSS and never links.
 */
function buildKeyedTable(table: ChartTable): HTMLTableElement {
  const el = document.createElement("table");
  el.className = "tugx-chart-table tugx-diagram-table";
  const caption = document.createElement("caption");
  caption.textContent = table.caption;
  el.appendChild(caption);
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const cell of table.head) {
    const th = document.createElement("th");
    th.scope = "col";
    th.textContent = cell;
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  el.appendChild(thead);
  const tbody = document.createElement("tbody");
  for (const row of keyedRows(table)) {
    const tr = document.createElement("tr");
    const key = document.createElement("td");
    key.className = "tugx-diagram-key";
    const disc = document.createElement("span");
    disc.className = "tugx-diagram-disc";
    disc.textContent = row.key;
    key.appendChild(disc);
    const name = document.createElement("td");
    name.className = "tugx-diagram-name";
    name.textContent = row.name;
    const what = document.createElement("td");
    what.textContent = row.what;
    const where = document.createElement("td");
    where.className = "tugx-diagram-where";
    if (row.where !== "") {
      const code = document.createElement("code");
      code.textContent = row.where;
      where.appendChild(code);
    }
    tr.append(key, name, what, where);
    tbody.appendChild(tr);
  }
  el.appendChild(tbody);
  return el;
}

/** A compile whose table is empty is a drawing: it has no alternative and no toggle. */
function hasTable(table: ChartTable): boolean {
  return table.head.length > 0 || table.rows.length > 0;
}

// ---------------------------------------------------------------------------
// renderChartInto
// ---------------------------------------------------------------------------

/**
 * Render `source` into `el`, through every step above. Never rejects: each
 * failure is a terminal state on the element. A second call on the same
 * element supersedes the first — whichever finishes later writes nothing
 * if it is not the current one.
 *
 * On a warm page — engine loaded, faces loaded — nothing here is awaited,
 * so the figure stands in `el` when this call returns: a chart remounting
 * as the reader scrolls never shows its pending source, and a Find
 * comparison run from the same commit reads the table. The two waits are
 * taken only when they would actually wait.
 */
export async function renderChartInto(el: HTMLElement, source: string, options: RenderChartOptions = {}): Promise<void> {
  const layers: ChartLayers = options.layers ?? "chart";
  const thumbnail = options.thumbnail ?? false;
  const picture = !thumbnail && (options.picture ?? false);
  const token = {};
  renders.set(el, token);
  const current = (): boolean => renders.get(el) === token;
  endChartHoverIn(el);
  detachRefSetIn(el);

  el.classList.add(CHART_CLASS);
  el.removeAttribute(CHART_PENDING_ATTR);
  el.removeAttribute(CHART_ANIMATE_ATTR);
  el.removeAttribute(CHART_VIEW_ATTR);
  el.removeAttribute(CHART_UNTITLED_ATTR);
  el.removeAttribute(CHART_KIND_ATTR);
  el.removeAttribute(DIAGRAM_CHECKED_ATTR);
  el.toggleAttribute(CHART_THUMBNAIL_ATTR, thumbnail);
  el.toggleAttribute(CHART_PICTURE_ATTR, picture);
  el.setAttribute(CHART_STATE_ATTR, "pending");
  el.removeAttribute(COLLAPSED_ATTR);
  const diagram = isDiagramSource(source, layers);
  if (thumbnail || picture) el.textContent = "";
  else showUndrawn(el, source, diagram ? "Drawing diagram…" : "Drawing chart…", null, diagram);

  let engine: TuggraphicsEngine;
  try {
    engine = getTuggraphicsSync() ?? (await engineWithDeadline());
  } catch {
    if (current()) showUnavailable(el, source, ENGINE_UNAVAILABLE_NOTE, diagram);
    return;
  }
  if (!current()) return;

  const verdict = engine.validate(source, layers);
  if (verdict.status === "invalid") {
    showInvalid(el, source, verdict.errors, diagram);
    return;
  }

  const probes = ensureRoleProbes(el);
  if (!roleFacesLoaded(probes, FACE_SAMPLE)) {
    await awaitRoleFaces(probes, FACE_SAMPLE);
    if (!current()) return;
  }

  const measure = probeMeasurer(probes);
  if (measure === null) {
    showUnavailable(el, source, MEASURE_UNAVAILABLE_NOTE, diagram);
    return;
  }

  const hash = textHash(source);
  const animate = !thumbnail && !picture && takeEntrance(entered, hash, isShown(el));
  nextId += 1;
  const idPrefix = `tgc${nextId}`;
  const avail = el.clientWidth;
  // A picture names no width: a chart takes its spec's or its form's default.
  const width = thumbnail ? THUMBNAIL_LAYOUT_WIDTH : !picture && avail > 0 ? avail : undefined;
  const round = runMeasureLoop(
    (table) =>
      engine.compile_round(
        source,
        { width, id_prefix: idPrefix, motion: animate, layers, figure_title: picture },
        table,
      ),
    measure,
  );
  if (!current()) return;
  if (round.status === "invalid") {
    showInvalid(el, source, round.errors, diagram);
    return;
  }

  if (thumbnail) {
    const body = document.createElement("div");
    body.className = "tugx-chart-body";
    body.innerHTML = round.svg;
    if (hasTable(round.table)) attachChartHover(body, round.table);
    el.removeAttribute(COLLAPSED_ATTR);
    el.replaceChildren(body);
    el.setAttribute(CHART_STATE_ATTR, "rendered");
    return;
  }

  if (picture) {
    const body = document.createElement("div");
    body.className = "tugx-chart-body";
    body.innerHTML = round.svg;
    const keyed = diagram && hasTable(round.table);
    if (diagram) el.setAttribute(CHART_KIND_ATTR, "diagram");
    el.style.width = `${pictureWidth(round.width, keyed)}px`;
    el.removeAttribute(COLLAPSED_ATTR);
    el.replaceChildren(body, ...(keyed ? [buildKeyedTable(round.table)] : []));
    el.setAttribute(CHART_STATE_ATTR, "rendered");
    return;
  }

  // Build off-document, then land it in one write.
  // A diagram has no Table view: its table already stands beneath it.
  if (diagram) el.setAttribute(CHART_KIND_ATTR, "diagram");
  const view = diagram ? "chart" : recallChartView(hash);
  if (view === "table") el.setAttribute(CHART_VIEW_ATTR, "table");
  else el.setAttribute(CHART_VIEW_ATTR, "chart");

  // The share page is recognised by its annotation context, which answers
  // nothing, and by the mark its root wears.
  const offered = figureHeaderActions({
    drawn: true,
    hostShares: isShareAvailable(),
    sharePage: options.annotation?.unanswerable === true || document.documentElement.hasAttribute("data-share-page"),
  });
  const figure = { source, layers };
  const actions: HTMLElement[] = [
    offered.copy === "picture"
      ? buildAsyncCopyButton(() => copyFigurePicture(figure), figureCopyLabel("picture", diagram))
      : buildCopyButton(() => source, figureCopyLabel("source", diagram)),
  ];
  if (offered.share) {
    actions.push(
      buildAsyncButton({
        icon: SHARE_ICON,
        name: "tugx-chart-share",
        ariaLabel: figureShareLabel(diagram),
        action: async () =>
          shareFigure(el, figure, {
            diagram,
            baseName: figureBaseName(round.table.caption, diagram),
            naturalWidth: round.width,
          }),
      }),
    );
  }
  const withTable = hasTable(round.table);
  const refs = round.table.refs;
  if (withTable && !diagram) {
    const toggle = buildViewToggle(el, hash);
    if (refs !== undefined) actions.push(buildLinksButton(el, toggle));
    actions.push(toggle);
  }
  let identity: HTMLElement | null = null;
  if (round.table.caption !== "") {
    identity = document.createElement("span");
    identity.className = "tugx-chart-title";
    identity.textContent = round.table.caption;
  } else {
    el.setAttribute(CHART_UNTITLED_ATTR, "");
  }
  const header = buildBlockHeader({ identity, actions });

  const body = document.createElement("div");
  body.className = "tugx-chart-body";
  body.innerHTML = round.svg;
  // A diagram takes its natural width whatever the card's, so the CSS needs
  // that width to hold the figure at a size its text can be read at ([L06]).
  if (diagram) body.style.setProperty(DIAGRAM_NATURAL_WIDTH_PROPERTY, `${round.width}px`);
  if (withTable) attachChartHover(body, round.table);
  // One answer for the whole figure: whether the recipe that drew it can be
  // asked for a mark's members from this surface.
  const reports = canReport(round.table.source, options.annotation);
  const form = chartForm(source);
  if (refs !== undefined) markHits(body, refs, reports, form);

  const children: Node[] = [header, body];
  if (withTable) children.push(diagram ? buildKeyedTable(round.table) : buildTable(round.table, reports, form));

  if (animate) el.setAttribute(CHART_ANIMATE_ATTR, "");
  el.removeAttribute(COLLAPSED_ATTR);
  el.replaceChildren(...children);
  el.setAttribute(CHART_STATE_ATTR, "rendered");
  setChartFigureData(el, {
    table: round.table,
    context: options.annotation,
    source: round.table.source,
    canReport: reports,
    hash,
  });
  if (refs !== undefined) {
    attachRefSets(el);
    attachRefLight(el);
    // The panel the reader had open on this chart, before the figure was rebuilt.
    restoreRefSet(el);
  }
  annotateFigure(el, options.annotation, diagram);
}

/**
 * Annotate a figure that has just landed, with the surface's context.
 *
 * A chart's refs are resolved and stamped; a diagram's keyed table names
 * where each mark is in the code, and its locations are resolved the same
 * way. The table was written after the surface's own annotation pass ran over
 * the placeholder, so the figure is annotated again here, and the pass files
 * what it consulted, so a verdict that lands later re-marks it.
 *
 * A diagram's table says a resolver was asked (`DIAGRAM_CHECKED_ATTR`),
 * which is what lets a location nobody confirmed wear its "unresolved" mark,
 * only where one could answer. On a page with nobody to ask
 * (`unanswerable`, the share page) every location would wear the mark, so
 * there the table shows each location as written.
 *
 * Then {@link CHART_ANNOTATED_EVENT} goes out, in a microtask: the surface
 * fills the hosts this pass marked with their portals, and a render that
 * finished inside React's commit would otherwise announce from within it.
 * A microtask still runs before the paint.
 */
function annotateFigure(el: HTMLElement, annotation: AnnotationContext | undefined, diagram: boolean): void {
  if (annotation === undefined || !el.isConnected) return;
  if (diagram && annotation.unanswerable !== true) el.setAttribute(DIAGRAM_CHECKED_ATTR, "");
  annotateElement(el, annotation);
  queueMicrotask(() => {
    if (el.isConnected) el.dispatchEvent(new CustomEvent(CHART_ANNOTATED_EVENT, { bubbles: true }));
  });
}
