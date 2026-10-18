/**
 * Surfaces a body asks the shell to draw.
 *
 * A body's viewport is its card's content box, so a surface built to stand
 * outside that box — the Z2 placard, which opens up off the status row over
 * the masthead and the wall above the card — has nowhere to stand in a body.
 * The shell draws it instead, over everything, where the in-document card
 * would have drawn it.
 *
 * The body goes on rendering the surface exactly as it does in the shell,
 * hidden (`tug-placard-drawn-elsewhere`), so every reading, store and handler
 * behind it is the card's own and nothing about it is re-derived. What
 * crosses the bus is the content as the body rendered it: the markup, the
 * title, the panel's class, the line it hangs from and the x it centres on,
 * in the body's viewport points. A change to the rendered content, or to
 * the body's viewport (a card resized moves the line it hangs from), is
 * published once per frame. The shell draws it into the canvas overlay root,
 * so the pointer claim takes it like any surface the shell raises, patches
 * the drawn tree in place on each update so a scroller keeps its position,
 * and sends a press inside it back as `surface-activate` with the pressed
 * node's child-index path; the body clicks the same node in its own tree.
 * A pointerdown or Escape the shell sees outside the drawn panel dismisses it
 * (`surface-dismissed`), as one the body sees outside its hidden panel does
 * there.
 *
 * Laws: [L06] (the drawn surface is DOM the shell writes, never React
 * state), [L22] (the mirror observes the rendered DOM directly), [L27]
 * (every show returns its release).
 *
 * @module lib/shell-surface
 */

import type { ShellSurface } from "@tugproto/bus";
import { isCancelChordEvent } from "../components/tugways/keymap-registry";
import { applyAvailableHeight } from "../components/tugways/tug-placard";
import * as canvasOverlayRegistry from "./canvas-overlay-registry";
import { layoutPxOf, layoutRectOf } from "./page-zoom-store";
import { paneCanvasOf } from "./pane-frame-selectors";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** `node`'s child-index path from `root`, or null when it is not inside it. */
export function pathOf(root: Node, node: Node): number[] | null {
  const path: number[] = [];
  let at: Node | null = node;
  while (at !== null && at !== root) {
    const parent: Node | null = at.parentNode;
    if (parent === null) return null;
    path.unshift(Array.prototype.indexOf.call(parent.childNodes, at) as number);
    at = parent;
  }
  return at === root ? path : null;
}

/** The node at `path` under `root`, or null when the path leads nowhere. */
export function nodeAt(root: Node, path: readonly number[]): Node | null {
  let at: Node | null = root;
  for (const index of path) {
    at = at?.childNodes[index] ?? null;
    if (at === null) return null;
  }
  return at;
}

/** Every scroller under `root` that stands scrolled, by path. */
export function scrollsOf(root: Element): Array<{ path: number[]; top: number }> {
  const out: Array<{ path: number[]; top: number }> = [];
  for (const el of root.querySelectorAll("*")) {
    if (el.scrollTop <= 0) continue;
    const path = pathOf(root, el);
    if (path !== null) out.push({ path, top: el.scrollTop });
  }
  return out;
}

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

// ---------------------------------------------------------------------------
// The body's half
// ---------------------------------------------------------------------------

/** What a surface says about itself, beside its content. */
export type ShellSurfaceMeta = Omit<ShellSurface, "html" | "scroll">;

/** Where a body's deck-scope surfaces go. */
export interface ShellSurfaceHost {
  /**
   * Have the shell draw `content` — the rendered content of a hidden panel —
   * as `meta` says, until the release. `meta` is read at every publish, so
   * its line follows the body's viewport. `dismissed` runs when the shell
   * dismisses it.
   */
  show(content: HTMLElement, meta: () => ShellSurfaceMeta, dismissed: () => void): () => void;
}

let installedHost: ShellSurfaceHost | null = null;

/** Install the page's surface host — a body's, which draws through the shell. Returns the uninstall. */
export function setShellSurfaceHost(host: ShellSurfaceHost): () => void {
  installedHost = host;
  return () => {
    if (installedHost === host) installedHost = null;
  };
}

/** The page's surface host, or null where surfaces draw in place (the shell). */
export function getShellSurfaceHost(): ShellSurfaceHost | null {
  return installedHost;
}

/** The body's surface host, and the two things the shell can say back to it. */
export interface SurfaceMirror extends ShellSurfaceHost {
  /** The shell pressed the node at `path` in the drawn content. */
  activate(path: readonly number[]): void;
  /** The shell dismissed the drawn surface. */
  dismiss(): void;
}

/**
 * A body's surface host: publishes the shown surface through `send` on show
 * and on every frame its content or the page's viewport changed, and `null`
 * on release.
 */
export function createSurfaceMirror(send: (surface: ShellSurface | null) => void): SurfaceMirror {
  let current: { content: HTMLElement; dismissed: () => void } | null = null;
  return {
    show(content, meta, dismissed) {
      const shown = { content, dismissed };
      current = shown;
      let sent = meta();
      let html = content.innerHTML;
      send({ ...sent, html, scroll: scrollsOf(content) });
      let frame: number | null = null;
      const publish = (): void => {
        frame = null;
        if (current !== shown) return;
        const next = meta();
        if (content.innerHTML === html && JSON.stringify(next) === JSON.stringify(sent)) return;
        sent = next;
        html = content.innerHTML;
        send({ ...sent, html, scroll: [] });
      };
      const schedule = (): void => {
        if (frame === null) frame = requestAnimationFrame(publish);
      };
      const observer = new MutationObserver(schedule);
      observer.observe(content, { subtree: true, childList: true, attributes: true, characterData: true });
      window.addEventListener("resize", schedule);
      return () => {
        observer.disconnect();
        window.removeEventListener("resize", schedule);
        if (frame !== null) cancelAnimationFrame(frame);
        if (current !== shown) return;
        current = null;
        send(null);
      };
    },
    activate(path) {
      if (current === null) return;
      const node = nodeAt(current.content, path);
      const el = node instanceof Element ? node : (node?.parentElement ?? null);
      el?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
    },
    dismiss() {
      current?.dismissed();
    },
  };
}

// ---------------------------------------------------------------------------
// The shell's half
// ---------------------------------------------------------------------------

/** Inset kept between a drawn panel and its pane's left edge, and its right (past the scrollbar gutter). */
const LEFT_INSET = 8;
const RIGHT_INSET = 20;

/**
 * A scroller that keeps its newest row in view (`TugPopupListScroller`'s
 * `stickToBottom`) says so in its markup, so the drawn copy carries the
 * intent. The body's absolute `scrollTop` does not: the shell's panel is
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
  surface: ShellSurface;
  /** Stuck scrollers the reader scrolled up from their bottom in the drawn copy. */
  released: WeakSet<Element>;
  /** Re-pins a stuck scroller whose box changed after the draw. */
  resized: ResizeObserver | null;
}

/** What the drawer needs from the shell. */
export interface ShellSurfaceDrawerOptions {
  /** A press inside `cardId`'s drawn content, at `path` from its root. */
  onActivate(cardId: string, path: number[]): void;
  /** The shell dismissed `cardId`'s drawn surface. */
  onDismiss(cardId: string): void;
}

/** Draws each body card's deck-scope surface over the shell's deck. */
export class ShellSurfaceDrawer {
  private readonly drawn = new Map<string, Drawn>();
  private readonly options: ShellSurfaceDrawerOptions;

  constructor(options: ShellSurfaceDrawerOptions) {
    this.options = options;
  }

  /** Whether `cardId` has a surface drawn. */
  has(cardId: string): boolean {
    return this.drawn.has(cardId);
  }

  /** Draw `cardId`'s surface, update it, or (`null`) take it down. */
  draw(cardId: string, surface: ShellSurface | null): void {
    if (surface === null) {
      this.remove(cardId);
      return;
    }
    const root = canvasOverlayRegistry.getRoot();
    if (root === null) return;
    let drawn = this.drawn.get(cardId);
    const first = drawn === undefined;
    if (drawn === undefined) {
      drawn = this.create(cardId, root);
      this.drawn.set(cardId, drawn);
    }
    drawn.surface = surface;
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
    // A stuck scroller follows its bottom in the box the shell clamped it
    // to — on first draw, and as rows append.
    pinStuckScrollers(drawn.content, drawn.released, drawn.resized);
  }

  /** Re-place every drawn surface against where its card stands now. */
  placeAll(): void {
    for (const cardId of this.drawn.keys()) this.place(cardId);
  }

  /**
   * Dismiss every drawn surface but `cardId`'s. An in-document placard
   * closes on any press outside it, and a press in another body is one the
   * shell never sees — but it makes that body's card the first responder,
   * which the shell does see.
   */
  dismissAllBut(cardId: string | null): void {
    for (const drawnId of [...this.drawn.keys()]) {
      if (drawnId === cardId) continue;
      this.remove(drawnId);
      this.options.onDismiss(drawnId);
    }
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

  private create(cardId: string, root: HTMLElement): Drawn {
    const panel = document.createElement("div");
    panel.dataset.slot = "tug-placard";
    panel.dataset.shellSurface = cardId;
    panel.dataset.tugFocus = "refuse";
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
    return { panel, title, content, surface: null as unknown as ShellSurface, released, resized };
  }

  /**
   * Hang `cardId`'s panel off its line where the card stands in the shell:
   * the body's viewport origin is its placeholder's, and the panel lives in
   * the overlay root, whose layout px are the deck's under a zoom. Centred
   * on the anchor and kept inside the card's pane horizontally; bounded by
   * the visible canvas in the way it grows, as an in-document placard is.
   */
  private place(cardId: string): void {
    const drawn = this.drawn.get(cardId);
    const root = canvasOverlayRegistry.getRoot();
    if (drawn === undefined || root === null) return;
    const placeholder = document.querySelector<HTMLElement>(
      `[data-body-placeholder][data-card-id="${CSS.escape(cardId)}"]`,
    );
    if (placeholder === null) return;
    const { panel, surface } = drawn;
    const origin = placeholder.getBoundingClientRect();
    const rootRect = root.getBoundingClientRect();
    const x = layoutPxOf(origin.left + surface.anchorX - rootRect.left);
    const y = layoutPxOf(origin.top + surface.lineY - rootRect.top);
    const line = surface.growth === "up" ? root.clientHeight - y : y;
    panel.style.setProperty("--tugx-placard-line", `${line}px`);
    const pane = placeholder.closest<HTMLElement>(".tug-pane");
    const paneRect = pane === null ? null : layoutRectOf(pane);
    const rootLayout = layoutRectOf(root);
    const minLeft = (paneRect === null ? 0 : paneRect.left - rootLayout.left) + LEFT_INSET;
    const maxLeft =
      (paneRect === null ? root.clientWidth : paneRect.right - rootLayout.left) -
      panel.offsetWidth -
      RIGHT_INSET;
    const left = Math.max(minLeft, Math.min(maxLeft, x - panel.offsetWidth / 2));
    panel.style.left = `${left}px`;
    panel.style.right = "auto";
    applyAvailableHeight(panel, surface.growth, pane === null ? null : paneCanvasOf(pane));
    // A re-clamp (a resize, a card that moved) changes the box a stuck
    // scroller's bottom is read against.
    pinStuckScrollers(drawn.content, drawn.released, drawn.resized);
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    for (const [cardId, { panel }] of this.drawn) {
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
