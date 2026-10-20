/**
 * The overlay's drawing of a body's surface: the Z2 placard a card raises
 * past its own box, drawn above every card where the in-document card would
 * have drawn it.
 *
 * Everything it draws comes from `overlay.surfaces`: the surface as the
 * body rendered it (`lib/surface-mirror.ts`), and where the card rests — its
 * content box, its pane, the visible canvas. The shell publishes an entry
 * only while its card rests and withdraws it for the length of any motion
 * (`lib/overlay-surfaces.ts`), so a panel here is drawn at a rest rect and
 * taken down when the card moves; nothing here reads where a card is.
 *
 * Each update patches the drawn tree in place, so a scroller keeps its
 * position and a running animation its phase. A press inside a panel goes
 * back as the pressed node's child-index path (`overlay.surfaceActivate`);
 * a press in this page beside the panel, or Escape here, dismisses it
 * (`overlay.surfaceDismissed`). A press anywhere else never reaches this
 * page — the host passes it through to what is beneath — and the shell and
 * the body dismiss for those, as they did when the shell drew it. Each panel
 * claims its own box (`data-overlay-claim`), so the host gives this page the
 * pointer over it and nowhere else.
 *
 * The drawn copy is the body's markup, so it is styled by the stylesheets
 * that markup is written against: the placard's, the popup list's, and the
 * Session card's telemetry surfaces, which are the surfaces a body raises.
 * The body's page loads them with its components; this page loads them here.
 *
 * Laws: [L06] (the drawn surface is DOM this page writes, never React
 * state), [L27] (`dispose` releases every listener).
 *
 * @module overlay/overlay-surface-drawer
 */

import "../components/tugways/tug-placard.css";
import "../components/tugways/tug-popup-list.css";
import "../components/tugways/cards/session-card-telemetry-renderers.css";
import "../components/tugways/cards/session-card-telemetry-popovers.css";

import type { OverlaySurfaceEntry } from "../bus/declarations/overlay";
import * as canvasOverlayRegistry from "../lib/canvas-overlay-registry";
import { isCancelChordEvent } from "../lib/keymap-source";
import { layoutPxOf } from "../lib/page-zoom-store";
import { applyAvailableHeightWithin } from "../lib/placard-available-height";
import { nodeAt, pathOf } from "../lib/surface-mirror";

/**
 * Bring `target`'s children into line with `source`'s, reusing every node
 * whose kind and tag still match, so a drawn scroller keeps its position and
 * a running animation its phase.
 */
export function patchChildren(target: Node, source: Node): void {
  const next = Array.from(source.childNodes);
  for (let i = 0; i < next.length; i++) {
    const want = next[i];
    const have = target.childNodes[i];
    if (have === undefined) {
      target.appendChild(want.cloneNode(true));
      continue;
    }
    if (have.nodeType !== want.nodeType || have.nodeName !== want.nodeName) {
      target.replaceChild(want.cloneNode(true), have);
      continue;
    }
    if (have.nodeType !== have.ELEMENT_NODE) {
      if (have.nodeValue !== want.nodeValue) have.nodeValue = want.nodeValue;
      continue;
    }
    const haveEl = have as Element;
    const wantEl = want as Element;
    for (const name of haveEl.getAttributeNames()) {
      if (!wantEl.hasAttribute(name)) haveEl.removeAttribute(name);
    }
    for (const name of wantEl.getAttributeNames()) {
      const value = wantEl.getAttribute(name) ?? "";
      if (haveEl.getAttribute(name) !== value) haveEl.setAttribute(name, value);
    }
    patchChildren(haveEl, wantEl);
  }
  while (target.childNodes.length > next.length) {
    target.removeChild(target.lastChild as Node);
  }
}

/** Inset kept between a drawn panel and its pane's left edge, and its right (past the scrollbar gutter). */
const LEFT_INSET = 8;
const RIGHT_INSET = 20;

/**
 * A scroller that keeps its newest row in view (`TugPopupListScroller`'s
 * `stickToBottom`) says so in its markup, so the drawn copy carries the
 * intent. The body's absolute `scrollTop` does not: the drawn panel is
 * clamped to its own room, a different height from the hidden copy's, and
 * the same top leaves the newest row below the fold by the difference.
 */
export const STICK_TO_BOTTOM_ATTRIBUTE = "data-stick-to-bottom";

/** Distance from the bottom within which a stuck scroller still follows (the scroller's own). */
const STICK_THRESHOLD_PX = 8;

/**
 * Pin every stuck scroller under `root` to its bottom, but those the reader
 * has scrolled away from it (`released`).
 */
export function pinStuckScrollers(
  root: Element,
  released: WeakSet<Element>,
  resized?: ResizeObserver | null,
): void {
  for (const el of root.querySelectorAll(`[${STICK_TO_BOTTOM_ATTRIBUTE}]`)) {
    // Watched as well as pinned: the scroller's box settles after the
    // draw that pinned it (the panel's clamp, a summary row below it), and
    // a box that shrinks under a pinned scroller leaves its newest row
    // short of the bottom — as the body's own scroller re-pins on resize.
    resized?.observe(el);
    if (released.has(el)) continue;
    el.scrollTop = el.scrollHeight;
  }
}

interface Drawn {
  panel: HTMLDivElement;
  title: HTMLSpanElement;
  content: HTMLDivElement;
  entry: OverlaySurfaceEntry;
  /** Stuck scrollers the reader scrolled up from their bottom in the drawn copy. */
  released: WeakSet<Element>;
  /** Re-pins a stuck scroller whose box changed after the draw. */
  resized: ResizeObserver | null;
}

/** What the drawer says back. */
export interface OverlaySurfaceDrawerOptions {
  /** A press inside `cardId`'s drawn content, at `path` from its root. */
  onActivate(cardId: string, path: number[]): void;
  /** `cardId`'s drawn surface was dismissed in this page. */
  onDismiss(cardId: string): void;
}

/** Draws each card's surface at its card's rest rect. */
export class OverlaySurfaceDrawer {
  private readonly drawn = new Map<string, Drawn>();
  private readonly options: OverlaySurfaceDrawerOptions;

  constructor(options: OverlaySurfaceDrawerOptions) {
    this.options = options;
  }

  /** Whether `cardId` has a surface drawn. */
  has(cardId: string): boolean {
    return this.drawn.has(cardId);
  }

  /** Draw exactly `entries`: each one's surface drawn or updated, every other taken down. */
  sync(entries: Readonly<Record<string, OverlaySurfaceEntry>>): void {
    for (const cardId of [...this.drawn.keys()]) {
      if (entries[cardId] === undefined) this.remove(cardId);
    }
    for (const [cardId, entry] of Object.entries(entries)) this.draw(cardId, entry);
  }

  /** Draw `cardId`'s surface, or update it. */
  draw(cardId: string, entry: OverlaySurfaceEntry): void {
    const root = canvasOverlayRegistry.getRoot();
    if (root === null) return;
    let drawn = this.drawn.get(cardId);
    const first = drawn === undefined;
    if (drawn === undefined) {
      drawn = this.create(cardId, root, entry);
      this.drawn.set(cardId, drawn);
    }
    const { surface } = entry;
    drawn.entry = entry;
    drawn.panel.className = `tug-placard ${surface.className}`;
    drawn.panel.dataset.growth = surface.growth;
    drawn.panel.setAttribute("aria-label", surface.title);
    drawn.title.textContent = surface.title;
    const template = document.createElement("template");
    template.innerHTML = surface.html;
    patchChildren(drawn.content, template.content);
    this.place(cardId);
    if (first) {
      for (const { path, top } of surface.scroll) {
        const node = nodeAt(drawn.content, path);
        if (node instanceof Element) node.scrollTop = top;
      }
    }
    // A stuck scroller follows its bottom in the box the panel is clamped
    // to — on first draw, and as rows append.
    pinStuckScrollers(drawn.content, drawn.released, drawn.resized);
  }

  /** Re-place every drawn surface: this page's window resized. */
  placeAll(): void {
    for (const cardId of this.drawn.keys()) this.place(cardId);
  }

  /** Take `cardId`'s surface down. */
  remove(cardId: string): void {
    const drawn = this.drawn.get(cardId);
    if (drawn === undefined) return;
    this.drawn.delete(cardId);
    drawn.resized?.disconnect();
    drawn.panel.remove();
    if (this.drawn.size === 0) this.unlisten();
  }

  /** Take every surface down. */
  dispose(): void {
    for (const cardId of [...this.drawn.keys()]) this.remove(cardId);
  }

  private create(cardId: string, root: HTMLElement, entry: OverlaySurfaceEntry): Drawn {
    const panel = document.createElement("div");
    panel.dataset.slot = "tug-placard";
    panel.dataset.overlaySurface = cardId;
    panel.dataset.tugFocus = "refuse";
    // The host gives this page the pointer over the panel, and only there.
    panel.setAttribute("data-overlay-claim", "");
    panel.setAttribute("role", "region");
    // The overlay root passes the pointer through; a surface opts back in.
    panel.style.pointerEvents = "auto";
    const header = document.createElement("div");
    header.className = "tug-placard-header";
    header.dataset.slot = "tug-placard-header";
    const title = document.createElement("span");
    title.className = "tug-placard-title";
    header.appendChild(title);
    const content = document.createElement("div");
    content.className = "tug-placard-body";
    content.dataset.slot = "tug-placard-body";
    panel.append(header, content);
    // A press is the body's: it clicks the same node in the tree it renders.
    panel.addEventListener("click", (event) => {
      const path = event.target instanceof Node ? pathOf(content, event.target) : null;
      if (path === null) return;
      event.preventDefault();
      this.options.onActivate(cardId, path);
    });
    // A reader who scrolls a stuck scroller up from its bottom stops its
    // follow until they come back to it, as the body's own scroller does.
    const released = new WeakSet<Element>();
    content.addEventListener(
      "scroll",
      (event) => {
        const el = event.target;
        if (!(el instanceof Element) || !el.hasAttribute(STICK_TO_BOTTOM_ATTRIBUTE)) return;
        if (el.scrollHeight - (el.scrollTop + el.clientHeight) > STICK_THRESHOLD_PX) released.add(el);
        else released.delete(el);
      },
      true,
    );
    const resized =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver((entries) => {
            for (const { target } of entries) {
              if (!target.isConnected || released.has(target)) continue;
              target.scrollTop = target.scrollHeight;
            }
          });
    root.appendChild(panel);
    if (this.drawn.size === 0) this.listen();
    return { panel, title, content, entry, released, resized };
  }

  /**
   * Hang `cardId`'s panel off its line where the card rests: the body's
   * viewport origin is its content box's, and the panel lives in this page's
   * overlay root, whose layout px are the deck's under a zoom. Centred on the
   * anchor and kept inside the card's pane horizontally; bounded by the
   * visible canvas in the way it grows, as an in-document placard is.
   */
  private place(cardId: string): void {
    const drawn = this.drawn.get(cardId);
    const root = canvasOverlayRegistry.getRoot();
    if (drawn === undefined || root === null) return;
    const { panel, entry } = drawn;
    const { surface, body, pane, bound } = entry;
    const rootRect = root.getBoundingClientRect();
    const x = layoutPxOf(body.x + surface.anchorX - rootRect.left);
    const y = layoutPxOf(body.y + surface.lineY - rootRect.top);
    const line = surface.growth === "up" ? root.clientHeight - y : y;
    panel.style.setProperty("--tugx-placard-line", `${line}px`);
    const rootLeft = layoutPxOf(rootRect.left);
    const minLeft = (pane === null ? 0 : layoutPxOf(pane.x) - rootLeft) + LEFT_INSET;
    const maxLeft =
      (pane === null ? root.clientWidth : layoutPxOf(pane.x + pane.width) - rootLeft) - panel.offsetWidth - RIGHT_INSET;
    const left = Math.max(minLeft, Math.min(maxLeft, x - panel.offsetWidth / 2));
    panel.style.left = `${left}px`;
    panel.style.right = "auto";
    applyAvailableHeightWithin(
      panel,
      surface.growth,
      bound === null ? null : { top: layoutPxOf(bound.y), bottom: layoutPxOf(bound.y + bound.height) },
    );
    // A re-clamp (a resize, a card that rests somewhere new) changes the box
    // a stuck scroller's bottom is read against.
    pinStuckScrollers(drawn.content, drawn.released, drawn.resized);
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    for (const [cardId, { panel }] of [...this.drawn]) {
      if (event.target instanceof Node && panel.contains(event.target)) continue;
      this.remove(cardId);
      this.options.onDismiss(cardId);
    }
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== "Escape" && !isCancelChordEvent(event)) return;
    for (const cardId of [...this.drawn.keys()]) {
      this.remove(cardId);
      this.options.onDismiss(cardId);
    }
  };

  private readonly onResize = (): void => this.placeAll();

  private listen(): void {
    document.addEventListener("pointerdown", this.onPointerDown, true);
    document.addEventListener("keydown", this.onKeyDown, true);
    window.addEventListener("resize", this.onResize);
  }

  private unlisten(): void {
    document.removeEventListener("pointerdown", this.onPointerDown, true);
    document.removeEventListener("keydown", this.onKeyDown, true);
    window.removeEventListener("resize", this.onResize);
  }
}
