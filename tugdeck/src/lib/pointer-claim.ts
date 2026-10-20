/**
 * The shell's claim on the pointer over its bodies.
 *
 * The shell's web view covers the window and is transparent where a body
 * shows through, and the host passes a click at a point inside a visible
 * body's frame down to the body — unless the shell has claimed the point. The
 * shell claims what it raises over the cards: every surface under the canvas
 * overlay root, which is `pointer-events: none` with children opting in, so
 * its children are exactly the surfaces that take the pointer over other
 * content; and every element portalled to `document.body` beside the deck. A
 * surface covering the whole viewport — a scrim, a modal — claims everything.
 *
 * The claim is recomputed when one of those surfaces comes, goes, opens,
 * closes or changes size — a `MutationObserver` and a `ResizeObserver`,
 * coalesced to one reading on the far side of the next paint — and posted to
 * the host (`pointerClaim`) only when it changed. A pointer drag needs no
 * claim: AppKit keeps sending its `mouseDragged` to the view that took its
 * `mouseDown`. A drag-and-drop session (a file from Finder, a jot) is routed
 * by the claim like a click: the host hands it to the body under the pointer
 * unless the claim covers the point.
 *
 * Laws: [L06] (the claim is appearance the host acts on, never React state),
 * [L22] (direct observation of the DOM the claimants live in), [L27] (the
 * tracker's start returns its release).
 *
 * @module lib/pointer-claim
 */

import { scheduleAfterPaint, type CancelAfterPaint } from "./after-paint";
import { hostCapabilitiesStore } from "./body-handoff";
import { postToHost } from "../host/channel";
import { pointerClaimToHost } from "../host/declarations/geometry";
import * as canvasOverlayRegistry from "./canvas-overlay-registry";

// ---------------------------------------------------------------------------
// The rule
// ---------------------------------------------------------------------------

export interface ClaimRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** The `pointerClaim` message body. */
export type PointerClaim = { readonly all: true } | { readonly rects: readonly ClaimRect[] };

function contains(outer: ClaimRect, inner: ClaimRect): boolean {
  return (
    outer.x <= inner.x &&
    outer.y <= inner.y &&
    outer.x + outer.width >= inner.x + inner.width &&
    outer.y + outer.height >= inner.y + inner.height
  );
}

/**
 * The claim the shell makes for these surfaces in a viewport of this size:
 * `all` when one of them covers the viewport, else the union of their rects —
 * each rect with an area, less those another already covers. No surface is an
 * empty claim.
 */
export function claimFor(
  rects: readonly ClaimRect[],
  viewport: { readonly width: number; readonly height: number },
): PointerClaim {
  const whole: ClaimRect = { x: 0, y: 0, width: viewport.width, height: viewport.height };
  const areas = rects.filter((r) => r.width > 0 && r.height > 0);
  if (areas.some((r) => contains(r, whole))) return { all: true };
  const union: ClaimRect[] = [];
  areas.forEach((r, i) => {
    const covered = areas.some(
      (other, j) => j !== i && contains(other, r) && (!contains(r, other) || j < i),
    );
    if (!covered) union.push({ x: r.x, y: r.y, width: r.width, height: r.height });
  });
  return { rects: union };
}

/** Whether two claims say the same thing to the host. */
export function sameClaim(a: PointerClaim | null, b: PointerClaim): boolean {
  if (a === null) return false;
  if ("all" in a || "all" in b) return "all" in a && "all" in b;
  if (a.rects.length !== b.rects.length) return false;
  return a.rects.every((r, i) => {
    const s = b.rects[i];
    return r.x === s.x && r.y === s.y && r.width === s.width && r.height === s.height;
  });
}

// ---------------------------------------------------------------------------
// The tracker
// ---------------------------------------------------------------------------

/** Elements beside the deck under `document.body` that are never claimants. */
const NOT_A_SURFACE = new Set(["SCRIPT", "STYLE", "LINK", "TEMPLATE", "NOSCRIPT"]);

/**
 * How far into a pass-through surface the claim looks for one that takes the
 * pointer.
 */
const CLAIM_DEPTH = 2;

/**
 * Push the rect `el` claims. A surface that takes the pointer and has an area
 * claims its box. One that passes the pointer through — a portal's wrapper
 * inheriting the overlay root's `pointer-events: none`, a zero-size mount
 * point — stands for its children, a level or two down, unless it clips them:
 * a 0×0 `overflow: hidden` holder (the sprite sheet) shows nothing at all.
 */
function collectClaim(el: Element, depth: number, out: ClaimRect[]): void {
  const style = getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden") return;
  const r = el.getBoundingClientRect();
  const hasArea = r.width > 0 && r.height > 0;
  if (style.pointerEvents !== "none" && hasArea) {
    out.push({ x: r.x, y: r.y, width: r.width, height: r.height });
    return;
  }
  if (depth >= CLAIM_DEPTH || (!hasArea && style.overflow !== "visible")) return;
  for (const child of el.children) collectClaim(child, depth + 1, out);
}

/**
 * Watches the shell's raised surfaces and posts the claim they make. Start it
 * once the deck has mounted; a no-op when the host makes no bodies.
 */
export class PointerClaimTracker {
  private last: PointerClaim | null = null;
  private cancelScheduled: CancelAfterPaint | null = null;
  private readonly sized = new Set<Element>();
  private resizes: ResizeObserver | null = null;
  private overlayRoot: HTMLElement | null = null;
  private overlayMutations: MutationObserver | null = null;

  start(): () => void {
    if (!hostCapabilitiesStore.get().bodyViews) return () => {};
    this.resizes = new ResizeObserver(this.schedule);
    const bodyMutations = new MutationObserver(this.schedule);
    bodyMutations.observe(document.body, { childList: true });
    const releaseRoot = canvasOverlayRegistry.subscribe(this.watchOverlayRoot);
    this.watchOverlayRoot();
    window.addEventListener("resize", this.schedule);
    this.schedule();
    return () => {
      window.removeEventListener("resize", this.schedule);
      releaseRoot();
      bodyMutations.disconnect();
      this.overlayMutations?.disconnect();
      this.overlayMutations = null;
      this.overlayRoot = null;
      this.resizes?.disconnect();
      this.resizes = null;
      this.sized.clear();
      this.cancelScheduled?.();
      this.cancelScheduled = null;
    };
  }

  /** Read the claim once on the far side of the next paint. Coalesces. */
  schedule = (): void => {
    if (this.cancelScheduled !== null) return;
    this.cancelScheduled = scheduleAfterPaint(() => {
      this.cancelScheduled = null;
      this.read();
    });
  };

  private watchOverlayRoot = (): void => {
    const root = canvasOverlayRegistry.getRoot();
    if (root === this.overlayRoot) return;
    this.overlayMutations?.disconnect();
    this.overlayRoot = root;
    if (root !== null) {
      this.overlayMutations = new MutationObserver(this.schedule);
      // Popovers and menus open and close by attribute as well as by mount.
      this.overlayMutations.observe(root, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["data-state", "hidden", "open"],
      });
    }
    this.schedule();
  };

  /** Every raised surface: the overlay root's children and `document.body`'s beside the deck. */
  private surfaces(): HTMLElement[] {
    const out: HTMLElement[] = [];
    if (this.overlayRoot !== null) {
      for (const el of this.overlayRoot.children) {
        if (el instanceof HTMLElement) out.push(el);
      }
    }
    for (const el of document.body.children) {
      if (!(el instanceof HTMLElement)) continue;
      if (el.id === "deck-container" || NOT_A_SURFACE.has(el.tagName)) continue;
      if (el === this.overlayRoot) continue;
      out.push(el);
    }
    return out;
  }

  private read(): void {
    const rects: ClaimRect[] = [];
    const surfaces = this.surfaces();
    for (const el of surfaces) collectClaim(el, 0, rects);
    this.track(surfaces);
    const claim = claimFor(rects, { width: window.innerWidth, height: window.innerHeight });
    if (sameClaim(this.last, claim)) return;
    if (this.last === null && "rects" in claim && claim.rects.length === 0) {
      this.last = claim;
      return;
    }
    this.last = claim;
    postToHost(pointerClaimToHost, claim);
  }

  /** Watch each surface's size, which can change with no mutation the observers see. */
  private track(surfaces: readonly HTMLElement[]): void {
    const resizes = this.resizes;
    if (resizes === null) return;
    const now = new Set<Element>(surfaces);
    for (const el of surfaces) {
      if (this.sized.has(el)) continue;
      this.sized.add(el);
      resizes.observe(el);
    }
    for (const el of [...this.sized]) {
      if (now.has(el)) continue;
      this.sized.delete(el);
      resizes.unobserve(el);
    }
  }
}
