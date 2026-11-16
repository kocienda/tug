/**
 * `chart-ref-set` — the list a set opens, and the clicks a figure's refs take
 * that no other layer serves.
 *
 * A chart's row can be about many things at once: a bar of 57 commits. Its
 * ref is a *set*, drawn as `57 commits` in the Table view and carried on the
 * bar's hit path, and a press on either opens a list of the members inside
 * the figure ([P09]). Each row of the list is an ordinary ref host, stamped
 * by the same pass that stamps the Table view's atoms, so a member commit is
 * a pill with the commit's click and the commit's menu, and nothing here
 * knows what a commit is.
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
 * standing hover read, since the list stands where the bubble pointed.
 *
 * **The session mark's click.** A session ref in the Table view or in the
 * list is a host a `SessionCitation` chip is portaled into, and the chip
 * owns its press; the registry's `session` kind has no `primaryClick` for
 * that reason. A `.tgh` mark is the one session host no chip mounts in, so
 * the figure's own click listener gives it a press ([P07], [P10]), and
 * leaves every other stamped kind to the transcript's delegated listener.
 *
 * Laws: [L06] the open list is DOM, built and removed imperatively; [L22]
 * nothing here is React state; [L27] no listener outlives its list; [L31] a
 * count-form set carries no `data-tugx-ref-set` and so opens nothing.
 *
 * @module lib/chart/chart-ref-set
 */

import { annotateElement } from "@/lib/annotator/annotate-content";
import { readAnnotation } from "@/lib/annotator/annotation-element";
import { NO_SCAN_ATTR, REF_ATTR, REF_LABEL_ATTR, REF_SET_ATTR } from "@/lib/annotator/chart-refs";
import { CHART_ANNOTATED_EVENT, chartFigureData } from "@/lib/chart/chart-figure-data";
import { endChartHoverIn } from "@/lib/chart/chart-hover";
import { effectiveRef, refLabel, slotAt, slotLabel, slotMembers, type RefTarget } from "@/lib/chart/chart-table-refs";
import type { ChartRefSlot, ChartTable } from "@/lib/lazy/load-tuggraphics";
import { openCitedSession } from "@/lib/session-open";

/** The list's class, excluded from Find ([P04]) and from the prose scan ([P05]). */
export const SET_LIST_CLASS = "tugx-chart-set-list";

/** The one list open on this page. */
interface Open {
  figure: HTMLElement;
  anchor: Element;
  list: HTMLElement;
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
  if (o.figure.isConnected) announce(o.figure);
}

/** Close the open list if it belongs to `figure`, which is being replaced. */
export function closeRefSetIn(figure: HTMLElement): void {
  if (open !== null && open.figure === figure) closeRefSet();
}

/**
 * Open the list for the set `anchor` stands for, inside `figure`. A second
 * press on the open list's anchor closes it instead. A set the figure's
 * table does not have, or one with nobody to annotate against, still lists:
 * the annotation pass is what links a member, and with no context every
 * member is shown as written.
 */
export function openRefSet(figure: HTMLElement, anchor: Element): void {
  if (open !== null && open.anchor === anchor) {
    closeRefSet();
    return;
  }
  closeRefSet();
  const data = chartFigureData(figure);
  if (data === undefined) return;
  const slot = slotOf(anchor, data.table);
  if (slot === null || slotMembers(slot).length === 0) return;
  endChartHoverIn(figure);

  const list = buildList(slot);
  figure.appendChild(list);
  anchor.setAttribute("aria-expanded", "true");

  const onKey = (ev: KeyboardEvent): void => {
    if (ev.key === "Escape") closeRefSet();
  };
  const onPointerDown = (ev: PointerEvent): void => {
    const target = ev.target;
    if (!(target instanceof Node)) return;
    if (list.contains(target) || anchor.contains(target)) return;
    closeRefSet();
  };
  document.addEventListener("keydown", onKey, { capture: true });
  document.addEventListener("pointerdown", onPointerDown, { capture: true });
  open = {
    figure,
    anchor,
    list,
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
