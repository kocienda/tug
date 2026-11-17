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
 * **One list per page, closed by every way out.** Escape, a pointerdown
 * outside the list, a second press on its anchor, or the figure being
 * re-rendered (`closeRefSetIn`). The document listeners a list needs are
 * added when it opens and removed by every close ([L27]). Opening ends any
 * standing hover read, since the list stands where the bubble pointed. A
 * report row's right-click menu is drawn outside the panel, so a press or
 * an Escape that belongs to an open menu closes nothing here: the menu's
 * item acts, the menu closes itself, and the next press outside closes the
 * panel.
 *
 * **The session mark's click.** A session ref in the Table view or in the
 * list is a host a `SessionCitation` chip is portaled into, and the chip
 * owns its press; the registry's `session` kind has no `primaryClick` for
 * that reason. A `.tgh` mark is the one session host no chip mounts in, so
 * the figure's own click listener gives it a press ([P07], [P10]), and
 * leaves every other stamped kind to the transcript's delegated listener.
 *
 * Laws: [L06] the open list is DOM, built and removed imperatively; [L22]
 * nothing here is React state; [L27] no listener outlives its list, and a
 * closed report's descriptor is dropped; [L31] a count form with nobody to
 * ask carries no `data-tugx-ref-set` and so opens nothing.
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
import { CHART_ANNOTATED_EVENT, chartFigureData } from "@/lib/chart/chart-figure-data";
import { endChartHoverIn } from "@/lib/chart/chart-hover";
import {
  dropReport,
  newReportId,
  registerReport,
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

/** The one list open on this page. */
interface Open {
  figure: HTMLElement;
  anchor: Element;
  list: HTMLElement;
  /** The report registered for this panel, when it is one. */
  reportId: string | null;
  release: Array<() => void>;
}

let open: Open | null = null;

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

function buildList(slot: ChartRefSlot): HTMLElement {
  const list = document.createElement("div");
  list.className = SET_LIST_CLASS;
  list.setAttribute("role", "dialog");
  list.setAttribute(NO_SCAN_ATTR, "");
  const label = slotLabel(slot);
  list.setAttribute("aria-label", label);
  const head = document.createElement("div");
  head.className = "tugx-chart-set-list-head";
  head.textContent = label;
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

/** Close the open list, if any. */
export function closeRefSet(): void {
  const o = open;
  if (o === null) return;
  open = null;
  for (const undo of o.release) undo();
  o.list.remove();
  o.anchor.removeAttribute("aria-expanded");
  if (o.reportId !== null) dropReport(o.reportId);
  if (o.figure.isConnected) announce(o.figure);
}

/** Close the open list if it belongs to `figure`, which is being replaced. */
export function closeRefSetIn(figure: HTMLElement): void {
  if (open !== null && open.figure === figure) closeRefSet();
}

/**
 * Open the report for the set `anchor` stands for, inside `figure`. A second
 * press on the open panel's anchor closes it instead. Where there is
 * somebody to ask, the panel holds a report: the recipe's, when the spec
 * names its source and the anchor has a row, else one describing the set's
 * own members. With nobody to ask it holds the plain list of the members as
 * written, and a set with no members to show opens nothing.
 */
export function openRefSet(figure: HTMLElement, anchor: Element): void {
  if (open !== null && open.anchor === anchor) {
    closeRefSet();
    return;
  }
  closeRefSet();
  const data = chartFigureData(figure);
  if (data === undefined) return;
  // A report anchor asks the recipe for something no slot holds, so it has
  // no slot of its own to read.
  const mode = anchor.getAttribute(REF_REPORT_ATTR);
  const slot = mode === null ? slotOf(anchor, data.table) : null;
  if (mode === null && slot === null) return;
  const members = slot === null ? [] : slotMembers(slot);
  const root = canAsk(data.context) ? (data.context?.commitRoot ?? null) : null;

  let list: HTMLElement;
  let reportId: string | null = null;
  if (root === null) {
    if (slot === null || members.length === 0) return;
    list = buildList(slot);
  } else {
    const address = data.source === undefined ? null : addressOf(anchor, data.table);
    if (address === null && members.length === 0) return;
    reportId = newReportId();
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
    list = buildReportPanel(reportId, reportTitle(address?.label ?? null, address?.series ?? null, count, kind, single));
  }
  endChartHoverIn(figure);
  figure.appendChild(list);
  anchor.setAttribute("aria-expanded", "true");

  // A menu raised from a report row is drawn outside the panel. While one
  // is up, the key and the press are the menu's.
  const menuOpen = (): boolean => document.querySelector('[role="menu"]') !== null;
  const onKey = (ev: KeyboardEvent): void => {
    if (ev.key === "Escape" && !menuOpen()) closeRefSet();
  };
  const onPointerDown = (ev: PointerEvent): void => {
    const target = ev.target;
    if (!(target instanceof Node)) return;
    if (list.contains(target) || anchor.contains(target)) return;
    if (target instanceof Element && target.closest('[role="menu"]') !== null) return;
    closeRefSet();
  };
  document.addEventListener("keydown", onKey, { capture: true });
  document.addEventListener("pointerdown", onPointerDown, { capture: true });
  open = {
    figure,
    anchor,
    list,
    reportId,
    release: [
      () => document.removeEventListener("keydown", onKey, { capture: true }),
      () => document.removeEventListener("pointerdown", onPointerDown, { capture: true }),
    ],
  };

  if (data.context !== undefined) annotateElement(figure, data.context);
  announce(figure);
  // The panel opens at the figure's foot, which may be below the fold.
  list.scrollIntoView({ block: "nearest" });
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
