/**
 * `attachChartHover` — a pointer resting on a chart mark reads that mark's row
 * of the chart's table, in the app's tooltip bubble.
 *
 * The compiler writes the marks' invisible targets: a `.tgh` path carrying
 * `data-row` and, where one value in the row is the mark's own, `data-col`.
 * This module holds no numbers of its own. It reads the row out of the same
 * `ChartTable` the Table view shows, so the bubble cannot disagree with it.
 *
 * **Why the bubble is built here rather than by `TugTooltip`.** `TugTooltip`
 * wraps a React child, and a figure is built off-document by a renderer that
 * three doors call, one of them a markdown enhancer with no React parent to
 * portal from. A trigger per mark would also mean a React tree per bar, and
 * a figure holds hundreds of marks. So this writes the same DOM the bubble is
 * made of (`tug-tooltip-content`, whose stylesheet the deck and the body page
 * both load) and takes part in the three rules that make a tooltip a tooltip
 * here: the one-bubble registry, the input gestures that end a hover, and the
 * open menu that a bubble gives way to.
 *
 * It opens faster than a control's tip. That delay exists so a pointer crossing
 * a toolbar raises nothing, and a reader resting on a bar is asking the question.
 * Moving from one mark to the next retargets the standing bubble at once.
 *
 * Laws: [L06] the bubble and the active target are DOM and attributes, styled
 * by CSS, and no React state moves; [L22] this lives outside the React tree.
 *
 * @module lib/chart/chart-hover
 */

import * as canvasOverlayRegistry from "@/lib/canvas-overlay-registry";
import type { ChartTable } from "@/lib/lazy/load-tuggraphics";
import { anyMenuOpen, observeOpenMenus } from "@/lib/open-menu-registry";
import { claimSoleTooltip, releaseSoleTooltip, type TooltipClaim } from "@/lib/open-tooltip-registry";
import { deckRootElement, layoutPxOf } from "@/lib/page-zoom-store";
import { observeTooltipDismiss } from "@/lib/tooltip-dismiss";

/** The class the compiler writes on a hit target. */
const HIT_SELECTOR = ".tgh";
/** On the target being read, which is what shows a band's crosshair. */
const ACTIVE_ATTR = "data-tgh-active";

/** How long a pointer rests on a mark before the bubble opens. */
export const HOVER_DELAY_MS = 150;
/** The bubble's distance from the mark, and from the window's edge. */
const SIDE_OFFSET_PX = 6;
const EDGE_PX = 4;
/** A target wider than this is a row: the bubble follows the pointer along it. */
const WIDE_TARGET_PX = 60;

/** One value in the bubble. A `name` of `""` is a value the header already names. */
export interface TipRow {
  name: string;
  value: string;
  current: boolean;
}

export interface TipContent {
  label: string;
  rows: TipRow[];
}

/**
 * What the bubble says for row `row`: the row's first cell, then every other
 * column that holds a value, with `col` marked as the one the mark draws. A
 * column named by the chart's own title, as a single-valued form's is, shows its
 * value alone. Null for a row the table does not have.
 */
export function tipContent(table: ChartTable, row: number, col: number | null): TipContent | null {
  const cells = table.rows[row];
  if (cells === undefined) return null;
  const rows: TipRow[] = [];
  for (let c = 1; c < cells.length; c++) {
    const value = cells[c] ?? "";
    if (value === "") continue;
    const head = table.head[c] ?? "";
    rows.push({ name: head === table.caption ? "" : head, value, current: c === col });
  }
  return { label: cells[0] ?? "", rows };
}

/** The `(row, col)` a hit target carries, or null for one that names no row. */
function readTarget(hit: Element): { row: number; col: number | null } | null {
  const row = hit.getAttribute("data-row");
  if (row === null) return null;
  const col = hit.getAttribute("data-col");
  return { row: Number(row), col: col === null ? null : Number(col) };
}

function buildArrow(): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "tug-tooltip-arrow");
  svg.setAttribute("width", "10");
  svg.setAttribute("height", "5");
  svg.setAttribute("viewBox", "0 0 30 10");
  svg.setAttribute("preserveAspectRatio", "none");
  const point = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
  point.setAttribute("points", "0,0 30,0 15,10");
  svg.appendChild(point);
  return svg;
}

function fillBubble(bubble: HTMLElement, content: TipContent): void {
  const children: Node[] = [];
  if (content.label !== "") {
    const label = document.createElement("div");
    label.className = "tugx-chart-tip-label";
    label.textContent = content.label;
    children.push(label);
  }
  for (const row of content.rows) {
    const line = document.createElement("div");
    line.className = "tugx-chart-tip-row";
    if (row.current) line.setAttribute("data-current", "");
    const name = document.createElement("span");
    name.textContent = row.name;
    const value = document.createElement("span");
    value.textContent = row.value;
    line.append(name, value);
    children.push(line);
  }
  children.push(buildArrow());
  bubble.replaceChildren(...children);
}

/**
 * Places the bubble over the target, under it when the window has no room above,
 * and inside the window either way. A rect and a pointer are viewport px, and the
 * bubble sits in the zoomed deck, so both are converted.
 */
function placeBubble(bubble: HTMLElement, hit: Element, pointerX: number): void {
  const rect = hit.getBoundingClientRect();
  const anchorX = layoutPxOf(rect.width > WIDE_TARGET_PX ? pointerX : rect.left + rect.width / 2);
  const windowW = layoutPxOf(window.innerWidth);
  const w = bubble.offsetWidth;
  const h = bubble.offsetHeight;
  const above = layoutPxOf(rect.top) - h - SIDE_OFFSET_PX;
  const below = layoutPxOf(rect.bottom) + SIDE_OFFSET_PX;
  const side = above >= EDGE_PX ? "top" : "bottom";
  const left = Math.max(EDGE_PX, Math.min(anchorX - w / 2, windowW - w - EDGE_PX));
  bubble.setAttribute("data-side", side);
  bubble.style.left = `${left}px`;
  bubble.style.top = `${side === "top" ? above : below}px`;
  bubble.style.setProperty("--tugx-chart-tip-arrow-x", `${anchorX - left}px`);
}

/** The one read standing on this page: its target, its bubble if open, and what ends it. */
interface Standing {
  hit: Element;
  table: ChartTable;
  /** Where the pointer entered `hit`, which is what a wide target's bubble points at. */
  pointerX: number;
  claim: TooltipClaim;
  bubble: HTMLElement | null;
  timer: ReturnType<typeof setTimeout> | null;
  release: Array<() => void>;
}

let standing: Standing | null = null;

/** End the read standing on this page, if any. */
function endHover(): void {
  const s = standing;
  if (s === null) return;
  standing = null;
  if (s.timer !== null) clearTimeout(s.timer);
  s.hit.removeAttribute(ACTIVE_ATTR);
  for (const undo of s.release) undo();
  releaseSoleTooltip(s.claim);
  s.bubble?.remove();
}

/** End the read standing on this page if it belongs to `figure`, which is being replaced. */
export function endChartHoverIn(figure: HTMLElement): void {
  if (standing !== null && figure.contains(standing.hit)) endHover();
}

/** Show the row of the standing target in its bubble, building the bubble if this is the open. */
function showRow(s: Standing): void {
  const target = readTarget(s.hit);
  const content = target === null ? null : tipContent(s.table, target.row, target.col);
  if (content === null) {
    endHover();
    return;
  }
  if (s.bubble === null) {
    const bubble = document.createElement("div");
    bubble.setAttribute("data-slot", "tug-tooltip");
    bubble.setAttribute("data-variant", "entity");
    bubble.setAttribute("data-state", "delayed-open");
    // The table is the screen reader's route to these numbers.
    bubble.setAttribute("aria-hidden", "true");
    bubble.className = "tug-tooltip-content tugx-chart-tip";
    s.bubble = bubble;
    fillBubble(bubble, content);
    (canvasOverlayRegistry.getRoot() ?? deckRootElement()).appendChild(bubble);
  } else {
    fillBubble(s.bubble, content);
  }
  placeBubble(s.bubble, s.hit, s.pointerX);
}

/**
 * The bubble opens: claim the one place on screen, and listen for what ends it.
 * A read that cannot open ends here, so the next mark entered starts a fresh one
 * rather than retargeting a read with no bubble and no timer.
 */
function openBubble(s: Standing): void {
  s.timer = null;
  s.claim.trigger = s.hit;
  if (!s.hit.isConnected || anyMenuOpen() || !claimSoleTooltip(s.claim)) {
    endHover();
    return;
  }
  s.release.push(
    observeTooltipDismiss((ev) => {
      // A scroller the mark is not in has not moved it out from under the pointer.
      if (ev !== null && ev.type === "scroll" && ev.target instanceof Node && !ev.target.contains(s.hit)) return;
      endHover();
    }),
    observeOpenMenus(() => {
      if (anyMenuOpen()) endHover();
    }),
  );
  // The chain's dispatches are not reachable from here, and a chord is the one
  // deliberate act the gestures above do not hear. A figure unmounted under a
  // still pointer sends no leave, so the next motion checks that it stands.
  const onKey = (): void => endHover();
  const onMove = (): void => {
    if (!s.hit.isConnected) endHover();
  };
  document.addEventListener("keydown", onKey, { capture: true, passive: true });
  document.addEventListener("pointermove", onMove, { capture: true, passive: true });
  s.release.push(() => {
    document.removeEventListener("keydown", onKey, { capture: true });
    document.removeEventListener("pointermove", onMove, { capture: true });
  });
  showRow(s);
}

/**
 * Listens over `body`, the element holding a compiled figure's SVG. The listeners
 * go with it: a re-render replaces the element, and a form with no targets never
 * sees a pointer here do anything.
 */
export function attachChartHover(body: HTMLElement, table: ChartTable): void {
  body.addEventListener("pointerover", (ev) => {
    const hit = ev.target instanceof Element ? ev.target.closest(HIT_SELECTOR) : null;
    if (hit === null) {
      endHover();
      return;
    }
    if (standing !== null && standing.table === table) {
      if (standing.hit === hit) return;
      standing.hit.removeAttribute(ACTIVE_ATTR);
      standing.hit = hit;
      standing.pointerX = ev.clientX;
      hit.setAttribute(ACTIVE_ATTR, "");
      if (standing.bubble !== null) {
        standing.claim.trigger = hit;
        showRow(standing);
      }
      return;
    }
    endHover();
    const s: Standing = {
      hit,
      table,
      pointerX: ev.clientX,
      claim: { trigger: hit, close: endHover },
      bubble: null,
      timer: null,
      release: [],
    };
    standing = s;
    hit.setAttribute(ACTIVE_ATTR, "");
    s.timer = setTimeout(() => openBubble(s), HOVER_DELAY_MS);
  });
  body.addEventListener("pointerleave", endHover);
}
