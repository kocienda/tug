/**
 * `renderChartInto` — the one piece of code that turns a chart source into
 * DOM. Three doors call it: the markdown enhancer for a ` ```tugchart `
 * fence placeholder, the `ChartBlock` body kind from its layout effect, and
 * through `ChartBlock` the Bash block and any instrument. Because there is
 * one renderer there is nothing for the doors to disagree about.
 *
 * The pipeline, in order:
 *
 *  1. Stamp `data-tugx-chart-state="pending"` and leave the source as text,
 *     so the reader has the content before any beat runs ([L32]).
 *  2. Load the engine, with a 10 s deadline. Past it the state is
 *     `unavailable`, the source stays, and a note says why ([L33]).
 *  3. Validate the source for the door's `layers`. An invalid source shows
 *     as `invalid`: the source in a `<pre>`, every error beneath it.
 *  4. Put one hidden, empty probe per type role in the host and wait for
 *     their faces, with a 3 s deadline, after which whatever face is present
 *     is measured.
 *  5. Run the measure protocol at the host's width, read once.
 *  6. Build the figure off-document: the block header (title, Copy, a Table
 *     toggle), the SVG, and the `<table>` alternative built with
 *     `textContent`; the remembered view; the entrance attribute. The header
 *     is the title's one home, so the SVG is compiled without it, and an
 *     untitled chart wears quiet chrome with no placeholder word.
 *  7. Replace the host's children in one write and set `rendered`.
 *
 * Colour and type never appear here: the SVG carries role classes and
 * `chart-block.css` maps them to tokens, which is what lets a theme switch
 * restyle a chart already on screen with no re-render. That stylesheet is
 * the body kind's; the markdown doors (`tug-markdown-block.tsx`,
 * `tug-markdown-view.tsx`) import it beside their own, since a lib module
 * imports nothing from components.
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
 * Laws: [L06] every state is a `data-` attribute styled by CSS; [L24] the
 * DOM is structure written once, the entrance set is module-local data;
 * [L32] the source is on screen until the figure replaces it; [L33] both
 * waits have horizons.
 *
 * @module lib/chart/render-chart
 */

import { awaitRoleFaces, ensureRoleProbes, probeMeasurer, roleFacesLoaded, runMeasureLoop } from "@/lib/chart/chart-measure";
import { recallChartView, rememberChartView, type ChartView } from "@/lib/chart/chart-view-memory";
import { textHash } from "@/lib/ingest/text-hash";
import {
  getTuggraphicsSync,
  loadTuggraphics,
  type ChartLayers,
  type ChartTable,
  type TuggraphicsEngine,
} from "@/lib/lazy/load-tuggraphics";
import { buildBlockHeader, buildCopyButton } from "@/lib/markdown/enhance-block-chrome";
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

/** The source as code and one note beneath it. Tug's words, not the author's: the note is excluded from Find. */
function showUnavailable(el: HTMLElement, source: string, message: string): void {
  const note = document.createElement("p");
  note.className = "tugx-chart-note";
  note.textContent = message;
  el.replaceChildren(sourceBlock(source), note);
  el.setAttribute(CHART_STATE_ATTR, "unavailable");
}

function showInvalid(el: HTMLElement, source: string, errors: ReadonlyArray<{ path: string; message: string }>): void {
  const list = document.createElement("ul");
  list.className = "tugx-chart-note";
  for (const error of errors) {
    const item = document.createElement("li");
    item.textContent = error.path === "" ? error.message : `${error.path}: ${error.message}`;
    list.appendChild(item);
  }
  el.replaceChildren(sourceBlock(source), list);
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

/** The table alternative, every cell written with `textContent`. */
function buildTable(table: ChartTable): HTMLTableElement {
  const el = document.createElement("table");
  el.className = "tugx-chart-table";
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
  for (const row of table.rows) {
    const tr = document.createElement("tr");
    for (const cell of row) {
      const td = document.createElement("td");
      td.textContent = cell;
      tr.appendChild(td);
    }
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
  const token = {};
  renders.set(el, token);
  const current = (): boolean => renders.get(el) === token;

  el.classList.add(CHART_CLASS);
  el.removeAttribute(CHART_PENDING_ATTR);
  el.removeAttribute(CHART_ANIMATE_ATTR);
  el.removeAttribute(CHART_VIEW_ATTR);
  el.removeAttribute(CHART_UNTITLED_ATTR);
  el.setAttribute(CHART_STATE_ATTR, "pending");
  el.textContent = source;

  let engine: TuggraphicsEngine;
  try {
    engine = getTuggraphicsSync() ?? (await engineWithDeadline());
  } catch {
    if (current()) showUnavailable(el, source, ENGINE_UNAVAILABLE_NOTE);
    return;
  }
  if (!current()) return;

  const verdict = engine.validate(source, layers);
  if (verdict.status === "invalid") {
    showInvalid(el, source, verdict.errors);
    return;
  }

  const probes = ensureRoleProbes(el);
  if (!roleFacesLoaded(probes, FACE_SAMPLE)) {
    await awaitRoleFaces(probes, FACE_SAMPLE);
    if (!current()) return;
  }

  const measure = probeMeasurer(probes);
  if (measure === null) {
    showUnavailable(el, source, MEASURE_UNAVAILABLE_NOTE);
    return;
  }

  const hash = textHash(source);
  const animate = takeEntrance(entered, hash, isShown(el));
  nextId += 1;
  const idPrefix = `tgc${nextId}`;
  const avail = el.clientWidth;
  const round = runMeasureLoop(
    (table) =>
      engine.compile_round(
        source,
        { width: avail > 0 ? avail : undefined, id_prefix: idPrefix, motion: animate, layers, figure_title: false },
        table,
      ),
    measure,
  );
  if (!current()) return;
  if (round.status === "invalid") {
    showInvalid(el, source, round.errors);
    return;
  }

  // Build off-document, then land it in one write.
  const view = recallChartView(hash);
  if (view === "table") el.setAttribute(CHART_VIEW_ATTR, "table");
  else el.setAttribute(CHART_VIEW_ATTR, "chart");

  const actions: HTMLElement[] = [buildCopyButton(() => source, "Copy chart source")];
  const withTable = hasTable(round.table);
  if (withTable) actions.push(buildViewToggle(el, hash));
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

  const children: Node[] = [header, body];
  if (withTable) children.push(buildTable(round.table));

  if (animate) el.setAttribute(CHART_ANIMATE_ATTR, "");
  el.replaceChildren(...children);
  el.setAttribute(CHART_STATE_ATTR, "rendered");
}
