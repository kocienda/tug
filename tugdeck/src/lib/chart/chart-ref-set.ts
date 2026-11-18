/**
 * `chart-ref-set` — the report a set opens, and the clicks a figure's refs
 * take that no other layer serves.
 *
 * A chart's row can be about many things at once: a bar of 57 commits. Its
 * ref is a *set*, drawn as `57 commits` in the Table view and carried on the
 * bar's hit path, and a press on either opens a report of the members inside
 * the figure. This module builds the panel and one empty host in it, and
 * registers what the report asks (`chart-report-store`); the surface the
 * figure stands in portals the report's component into the host, and that
 * component reads the rows a page at a time. Nothing here knows what a
 * commit is.
 *
 * **Who is asked.** A spec that names its `source` has its recipe asked for
 * the mark's members, by the mark's address, which is how a count form (a
 * bar of 340 commits, folded to a number) opens at all. A spec with no
 * source has the members it carried described instead. A column's atom and
 * a mark annotation's have no row to address, so they are described from
 * their members whatever the spec names.
 *
 * **With nobody to ask, the plain list.** A figure with no annotation
 * context, one whose context cannot answer (the share page), or one bound
 * to no repository has no reader for a report, so its set opens the list of
 * ref hosts instead: each row an ordinary ref host, stamped by the same pass
 * that stamps the Table view's atoms. A count form there stays inert.
 *
 * **A panel of the figure, in flow.** The list is appended to the figure
 * and laid out under its plot (or its table, in the Table view), so the
 * figure grows to hold it. It is never floated over the figure: the figure
 * clips to its radius, so a list placed under a bar ran past the figure's
 * bottom edge and was cut off, and a heat strip is too short to hold one at
 * any placement. Opening scrolls the panel into view when the figure's foot
 * is off screen.
 *
 * **Inside the figure, on purpose.** The figure stands in the transcript
 * root, so the transcript's delegated click and its context menu serve the
 * list's rows unchanged and the surface's portals give them pills and chips.
 * A list in the canvas overlay, where the hover bubble lives, would sit
 * outside every listener. Both doors render through `renderChartInto`, so a
 * module the renderer attaches serves both; a React popover would need a
 * React parent the fence door does not have.
 *
 * **One panel per figure, held until the reader closes it.** A panel is
 * closed by its Close button, by a second press on the mark that opened it,
 * or by a press on another mark of the same figure, which opens that mark's
 * instead. Nothing else closes it: not a press elsewhere, not a key, not a
 * panel opening in another figure. This reverses the module's first rule
 * ("one list per page, closed by every way out"), under which a press in
 * the prompt entry took the report away from a reader still using it. The
 * module adds no document listener. Opening ends any standing hover read,
 * since the panel stands where the bubble pointed.
 *
 * **The open mark is marked.** For as long as its panel stands, the pressed
 * anchor carries `data-tugx-ref-open`, and so does every other anchor of the
 * figure that stands for the same thing (the bar and its Table atom) and the
 * label rule of a marked mark's row. CSS draws the rest ([L06]).
 *
 * **A re-render brings the panel back.** A figure is rebuilt under its
 * reader: a transcript cell remounts as it scrolls into view. The renderer
 * detaches the panel before it builds (`detachRefSetIn`), which keeps the
 * report and its pages, and asks for it again once the figure stands
 * (`restoreRefSet`). Which mark is open is kept by the chart's source hash
 * (`chart-open-memory`); a report is dropped only by a close, or when its
 * entry falls out of that memory.
 *
 * **The session mark's click.** A session ref in the Table view or in the
 * list is a host a `SessionCitation` chip is portaled into, and the chip
 * owns its press; the registry's `session` kind has no `primaryClick` for
 * that reason. A `.tgh` mark is the one session host no chip mounts in, so
 * the figure's own click listener gives it a press ([P07], [P10]), and
 * leaves every other stamped kind to the transcript's delegated listener.
 *
 * Laws: [L06] the open list is DOM, built and removed imperatively, and the
 * open mark is an attribute; [L22] nothing here is React state; [L23] what
 * the reader opened survives the figure being rebuilt; [L27] a closed
 * report's descriptor is dropped, and so is one whose memory entry is
 * evicted; [L31] a count form with nobody to ask carries no
 * `data-tugx-ref-set` and so opens nothing.
 *
 * @module lib/chart/chart-ref-set
 */

import { annotateElement } from "@/lib/annotator/annotate-content";
import { readAnnotation } from "@/lib/annotator/annotation-element";
import {
  NO_SCAN_ATTR,
  REF_ATTR,
  REF_KIND_ATTR,
  REF_LABEL_ATTR,
  REF_REPORT_ATTR,
  REF_SET_ATTR,
  REPORT_HOST_ATTR,
} from "@/lib/annotator/chart-refs";
import { CHART_ANNOTATED_EVENT, chartFigureData, type ChartFigureData } from "@/lib/chart/chart-figure-data";
import { endChartHoverIn } from "@/lib/chart/chart-hover";
import { forgetOpenMark, recallOpenMark, rememberOpenMark, type OpenMark } from "@/lib/chart/chart-open-memory";
import {
  dropReport,
  newReportId,
  registerReport,
  reportState,
  reportTitle,
  type ReportAddress,
} from "@/lib/chart/chart-report-store";
import {
  canAsk,
  effectiveRef,
  refLabel,
  slotAt,
  slotCount,
  slotKind,
  slotLabel,
  slotMembers,
  wholeRowSlot,
  type RefTarget,
} from "@/lib/chart/chart-table-refs";
import type { ChartRefSlot, ChartTable } from "@/lib/lazy/load-tuggraphics";
import { openCitedSession } from "@/lib/session-open";

/** The list's class, excluded from Find ([P04]) and from the prose scan ([P05]). */
export const SET_LIST_CLASS = "tugx-chart-set-list";

/** The attribute an anchor carries while its panel stands, and its row's label rule with it. */
export const REF_OPEN_ATTR = "data-tugx-ref-open";

const SVG_NS = "http://www.w3.org/2000/svg";

/** The panel open in one figure. */
interface Open {
  figure: HTMLElement;
  list: HTMLElement;
  /** The report registered for this panel, when it is one. */
  reportId: string | null;
  /** The figure's source hash, which the open memory is keyed by. */
  hash: string;
  /** What the pressed anchor stands for, as `targetKey` writes it. */
  target: string;
}

/** The panel each figure holds; an entry goes with its figure ([L24]). */
const opens = new WeakMap<HTMLElement, Open>();

/** The set an anchor stands for: a mark by its hit address, a Table atom by the address `buildTable` wrote. */
function slotOf(anchor: Element, table: ChartTable): ChartRefSlot | null {
  const row = anchor.getAttribute("data-row");
  if (row !== null) {
    const col = anchor.getAttribute("data-col");
    const item = anchor.getAttribute("data-item");
    const mark = anchor.getAttribute("data-mark");
    const target: RefTarget = {
      row: Number(row),
      ...(col === null ? {} : { col: Number(col) }),
      ...(item === null ? {} : { item: Number(item) }),
      ...(mark === null ? {} : { mark: Number(mark) }),
    };
    return effectiveRef(table.refs, target);
  }
  const at = anchor.getAttribute("data-tugx-ref-at");
  if (at === null) return null;
  return slotAt(table.refs, at, anchor.getAttribute("data-tugx-ref-kind"));
}

/** The panel's own Close, for a panel no React component stands in. */
function buildCloseButton(onClose: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "tugx-md-chrome-btn tugx-chart-set-close";
  button.setAttribute("aria-label", "Close");
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "12");
  svg.setAttribute("height", "12");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", "M18 6 6 18M6 6l12 12");
  svg.appendChild(path);
  button.appendChild(svg);
  button.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    onClose();
  });
  return button;
}

function buildList(slot: ChartRefSlot, onClose: () => void): HTMLElement {
  const list = document.createElement("div");
  list.className = SET_LIST_CLASS;
  list.setAttribute("role", "dialog");
  list.setAttribute(NO_SCAN_ATTR, "");
  const label = slotLabel(slot);
  list.setAttribute("aria-label", label);
  const head = document.createElement("div");
  head.className = "tugx-chart-set-list-head";
  const title = document.createElement("span");
  title.className = "tugx-chart-set-list-title";
  title.textContent = label;
  head.append(title, buildCloseButton(onClose));
  const rows = document.createElement("ul");
  rows.className = "tugx-chart-set-list-rows";
  for (const member of slotMembers(slot)) {
    const row = document.createElement("li");
    const host = document.createElement("span");
    host.className = "tugx-chart-ref";
    host.setAttribute(REF_ATTR, member);
    const words = refLabel(member);
    host.setAttribute(REF_LABEL_ATTR, words);
    host.textContent = words;
    row.appendChild(host);
    rows.appendChild(row);
  }
  list.append(head, rows);
  return list;
}

/**
 * Where `anchor` sits in the table, as the report endpoint addresses it, or
 * null for an anchor with no row (a column's atom, a mark annotation's).
 * The table's column index counts the label column and the endpoint counts
 * series from 0, so a column is sent one less; the row's label and the
 * series' name ride along, and they are what decide when the axis has moved.
 * A column is named only when the set is the cell's own: a bar of a
 * one-series chart sits in a column and stands for its row, and its report
 * is the row's. An anchor that stands for its row across every series says
 * so (`whole_row`).
 */
export function addressOf(anchor: Element, table: ChartTable): ReportAddress | null {
  let row: number | null = null;
  let col: number | null = null;
  let item: number | null = null;
  const hitRow = anchor.getAttribute("data-row");
  if (hitRow !== null) {
    if (anchor.hasAttribute("data-mark")) return null;
    row = Number(hitRow);
    const hitCol = anchor.getAttribute("data-col");
    const hitItem = anchor.getAttribute("data-item");
    if (hitCol !== null) col = Number(hitCol);
    if (hitItem !== null) item = Number(hitItem);
  } else {
    const parts = (anchor.getAttribute("data-tugx-ref-at") ?? "").split(":");
    if (parts[0] === "row" || parts[0] === "items") row = Number(parts[1]);
    else if (parts[0] === "cell") {
      row = Number(parts[1]);
      col = Number(parts[2]);
    } else return null;
  }
  const label = row === null ? undefined : table.rows[row]?.[0];
  if (row === null || !Number.isInteger(row) || label === undefined) return null;
  if (col !== null && (table.refs?.cells[row]?.[col] ?? null) === null) col = null;
  const series = col === null ? null : (table.head[col] ?? null);
  return {
    row,
    label,
    col: col === null ? null : col - 1,
    series,
    item,
    whole_row: anchor.getAttribute(REF_REPORT_ATTR) === "row",
  };
}

/**
 * An anchor's own name within its figure, from the attributes the renderer
 * wrote on it: what the open memory keeps, and what finds the same anchor
 * again in a figure built afresh from the same source.
 */
export function anchorKey(anchor: Element): string {
  const mode = anchor.getAttribute(REF_REPORT_ATTR) ?? "";
  const at = anchor.getAttribute("data-tugx-ref-at");
  if (at !== null) return ["at", at, anchor.getAttribute(REF_KIND_ATTR) ?? "", mode].join("|");
  return [
    "hit",
    anchor.getAttribute("data-row") ?? "",
    anchor.getAttribute("data-col") ?? "",
    anchor.getAttribute("data-item") ?? "",
    anchor.getAttribute("data-mark") ?? "",
    mode,
  ].join("|");
}

/**
 * What an anchor stands for. A bar and the Table atom of its row have
 * different names and one address, so they share a target: a press on
 * either is a press on the same thing, and both are marked while its panel
 * stands. An anchor with no address is its own target.
 */
export function targetKey(anchor: Element, table: ChartTable): string {
  const address = addressOf(anchor, table);
  if (address === null) return anchorKey(anchor);
  return `${JSON.stringify(address)}|${anchor.getAttribute(REF_KIND_ATTR) ?? ""}`;
}

/**
 * The panel a report stands in: the dialog, and inside it the one empty
 * host the surface's portal fills. The host is born empty and stays this
 * module's only child of the panel; everything under it is React's.
 */
function buildReportPanel(id: string, title: string): HTMLElement {
  const list = document.createElement("div");
  list.className = SET_LIST_CLASS;
  list.setAttribute("role", "dialog");
  list.setAttribute(NO_SCAN_ATTR, "");
  list.setAttribute("aria-label", title);
  const host = document.createElement("div");
  host.className = "tugx-chart-report";
  host.setAttribute(REPORT_HOST_ATTR, id);
  list.appendChild(host);
  return list;
}

function announce(figure: HTMLElement): void {
  figure.dispatchEvent(new CustomEvent(CHART_ANNOTATED_EVENT, { bubbles: true }));
}

/** Mark every anchor of `figure` standing for `target`, and the label rule of a marked mark's row. */
function mark(figure: HTMLElement, target: string, table: ChartTable): void {
  for (const el of figure.querySelectorAll(`[${REF_SET_ATTR}]`)) {
    if (targetKey(el, table) !== target) continue;
    el.setAttribute(REF_OPEN_ATTR, "");
    el.setAttribute("aria-expanded", "true");
    const row = el.classList.contains("tgh") ? el.getAttribute("data-row") : null;
    if (row !== null) figure.querySelector(`.tgl[data-row="${row}"]`)?.setAttribute(REF_OPEN_ATTR, "");
  }
}

function unmark(figure: HTMLElement): void {
  for (const el of figure.querySelectorAll(`[${REF_OPEN_ATTR}]`)) {
    el.removeAttribute(REF_OPEN_ATTR);
    el.removeAttribute("aria-expanded");
  }
}

/** Take a figure's panel down and leave its report, and the memory of it, as they are. */
function detach(o: Open): void {
  if (opens.get(o.figure) === o) opens.delete(o.figure);
  o.list.remove();
  unmark(o.figure);
}

/** The figures on this page whose panel shows report `reportId`. */
function figuresShowing(reportId: string): HTMLElement[] {
  const figures: HTMLElement[] = [];
  for (const host of document.querySelectorAll(`[${REPORT_HOST_ATTR}="${reportId}"]`)) {
    const figure = host.closest(`.${SET_LIST_CLASS}`)?.parentElement;
    if (figure instanceof HTMLElement && opens.get(figure)?.reportId === reportId) figures.push(figure);
  }
  return figures;
}

/** Drop report `reportId`, and take down every panel still showing it. */
function retire(reportId: string): void {
  for (const figure of figuresShowing(reportId)) {
    const o = opens.get(figure);
    if (o === undefined) continue;
    detach(o);
    announce(figure);
  }
  dropReport(reportId);
}

/** Close a panel for good: its report is dropped and the chart no longer remembers it. */
function close(o: Open): void {
  detach(o);
  const kept = recallOpenMark(o.hash);
  if (kept !== null && kept.reportId === o.reportId) forgetOpenMark(o.hash);
  if (o.reportId !== null) retire(o.reportId);
  if (o.figure.isConnected) announce(o.figure);
}

/** Close `figure`'s panel, if it has one. */
export function closeRefSetIn(figure: HTMLElement): void {
  const o = opens.get(figure);
  if (o !== undefined) close(o);
}

/** Close the panel showing report `reportId`: the report's own Close. */
export function closeReport(reportId: string): void {
  for (const figure of figuresShowing(reportId)) closeRefSetIn(figure);
}

/**
 * Take `figure`'s panel down because the figure is being rebuilt. The report
 * and the memory of which mark is open both stay, and `restoreRefSet` puts
 * the panel back once the new figure stands.
 */
export function detachRefSetIn(figure: HTMLElement): void {
  const o = opens.get(figure);
  if (o !== undefined) detach(o);
}

/** A panel built for an anchor, and the report it holds. */
interface Panel {
  list: HTMLElement;
  reportId: string | null;
}

/**
 * Build the panel for the set `anchor` stands for, or null when the set
 * opens nothing. Where there is somebody to ask, the panel holds a report:
 * the recipe's, when the spec names its source and the anchor has a row,
 * else one describing the set's own members. With nobody to ask it holds
 * the plain list of the members as written. `resume` names a report already
 * registered for this anchor; while the store still holds it the panel takes
 * it up, pages and all, and registers nothing.
 */
function buildPanel(figure: HTMLElement, anchor: Element, data: ChartFigureData, resume: string | null): Panel | null {
  // A report anchor asks the recipe for something no slot holds, so it has
  // no slot of its own to read.
  const mode = anchor.getAttribute(REF_REPORT_ATTR);
  const slot = mode === null ? slotOf(anchor, data.table) : null;
  if (mode === null && slot === null) return null;
  const members = slot === null ? [] : slotMembers(slot);
  const root = canAsk(data.context) ? (data.context?.commitRoot ?? null) : null;

  // A report the store already holds is taken up before anyone is asked,
  // which is how the share page shows one: seeded from the card's, sealed,
  // with nobody to ask.
  const kept = resume === null ? null : reportState(resume).descriptor;
  if (resume !== null && kept !== null) {
    const title = reportTitle(kept.rowLabel, kept.seriesName, kept.slotCount, kept.kind, kept.single === true);
    return { list: buildReportPanel(resume, title), reportId: resume };
  }
  if (root === null) {
    if (slot === null || members.length === 0) return null;
    return { list: buildList(slot, () => closeRefSetIn(figure)), reportId: null };
  }
  const address = data.source === undefined ? null : addressOf(anchor, data.table);
  if (address === null && members.length === 0) return null;
  const reportId = newReportId();
  const kind = slot === null ? (anchor.getAttribute(REF_KIND_ATTR) ?? "") : slotKind(slot);
  const refs = data.table.refs;
  const count =
    slot !== null
      ? slotCount(slot)
      : mode === "row" && address !== null
        ? (wholeRowSlot(refs, address.row)?.count ?? 0)
        : mode === "runs" && address !== null
          ? (refs?.items[address.row]?.length ?? 0)
          : 1;
  const single = mode === "one";
  registerReport({
    id: reportId,
    projectDir: root,
    kind,
    rowLabel: address?.label ?? null,
    seriesName: address?.series ?? null,
    slotCount: count,
    ...(single ? { single } : {}),
    ...(address !== null && data.source !== undefined ? { source: data.source, address } : { refs: members }),
  });
  const title = reportTitle(address?.label ?? null, address?.series ?? null, count, kind, single);
  return { list: buildReportPanel(reportId, title), reportId };
}

/** Stand `panel` in `figure` and mark what it is about. */
function install(figure: HTMLElement, anchor: Element, data: ChartFigureData, panel: Panel): void {
  const target = targetKey(anchor, data.table);
  figure.appendChild(panel.list);
  mark(figure, target, data.table);
  opens.set(figure, { figure, list: panel.list, reportId: panel.reportId, hash: data.hash, target });
}

/** The memory let `gone` go: its report is dropped, and any panel still showing it comes down. */
function retireMark(gone: OpenMark): void {
  if (gone.reportId !== null) retire(gone.reportId);
}

/**
 * Open the report for the set `anchor` stands for, inside `figure`. A press
 * on the mark whose panel already stands closes it instead, and a press on
 * another mark of the figure closes the standing panel and opens its own. A
 * set with no members to show opens nothing.
 */
export function openRefSet(figure: HTMLElement, anchor: Element): void {
  const data = chartFigureData(figure);
  if (data === undefined) return;
  const standing = opens.get(figure);
  if (standing !== undefined) {
    close(standing);
    if (standing.target === targetKey(anchor, data.table)) return;
  }
  const panel = buildPanel(figure, anchor, data, null);
  if (panel === null) return;
  endChartHoverIn(figure);
  install(figure, anchor, data, panel);
  const evicted = rememberOpenMark(data.hash, { anchor: anchorKey(anchor), reportId: panel.reportId });
  for (const gone of evicted) retireMark(gone);

  if (data.context !== undefined) annotateElement(figure, data.context);
  announce(figure);
  // The panel opens at the figure's foot, which may be below the fold.
  panel.list.scrollIntoView({ block: "nearest" });
}

/**
 * Put back the panel `figure`'s chart had open before the figure was
 * rebuilt. Called by the renderer once the new figure stands and before it
 * is annotated, so the one annotation pass and the one announcement that
 * follow serve the panel too. The reader's scroll is left alone: nothing is
 * brought into view.
 */
export function restoreRefSet(figure: HTMLElement): void {
  const data = chartFigureData(figure);
  if (data === undefined || opens.has(figure)) return;
  const kept = recallOpenMark(data.hash);
  if (kept === null) return;
  let anchor: Element | null = null;
  for (const el of figure.querySelectorAll(`[${REF_SET_ATTR}]`)) {
    if (anchorKey(el) === kept.anchor) {
      anchor = el;
      break;
    }
  }
  // A surface that cannot ask leaves a count form unstamped; the chart's
  // other figures may still hold the mark, so the memory is left alone.
  if (anchor === null) return;
  const panel = buildPanel(figure, anchor, data, kept.reportId);
  if (panel === null) return;
  install(figure, anchor, data, panel);
  if (panel.reportId === kept.reportId) return;
  // The report the memory named is gone, or this surface cannot ask.
  const evicted = rememberOpenMark(data.hash, { anchor: kept.anchor, reportId: panel.reportId });
  for (const gone of [kept, ...evicted]) retireMark(gone);
}

/** Figures whose listeners are attached; a figure is attached once. */
const attached = new WeakSet<HTMLElement>();

/**
 * Listen on `figure` for the presses this module serves: a click or an
 * Enter/Space on an actionable set host opens its list, and a click on a
 * session **mark** fronts or seats the session. Attached once per figure;
 * a re-render replaces the figure's children, never the figure.
 */
export function attachRefSets(figure: HTMLElement): void {
  if (attached.has(figure)) return;
  attached.add(figure);
  figure.addEventListener("click", (ev) => {
    if (ev.button !== 0) return;
    const target = ev.target instanceof Element ? ev.target : null;
    if (target === null) return;
    const set = target.closest(`[${REF_SET_ATTR}]`);
    if (set !== null && figure.contains(set)) {
      ev.preventDefault();
      openRefSet(figure, set);
      return;
    }
    const mark = target.closest(".tgh");
    if (mark === null || !(mark instanceof SVGElement)) return;
    const payload = readAnnotation(mark);
    if (payload !== null && payload.kind === "session") openCitedSession(payload.target);
  });
  figure.addEventListener("keydown", (ev) => {
    if (ev.key !== "Enter" && ev.key !== " ") return;
    const target = ev.target instanceof Element ? ev.target : null;
    if (target === null || !target.hasAttribute(REF_SET_ATTR)) return;
    ev.preventDefault();
    openRefSet(figure, target);
  });
}
