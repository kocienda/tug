/**
 * Where each body stands, and whether it shows — measured in the shell and
 * posted to the host.
 *
 * A body card stands in the shell as an empty placeholder filling its pane's
 * content box (`CardHost`); the host puts the body's view at that box. So the
 * shell reads each placeholder's `getBoundingClientRect()` — viewport CSS px,
 * which are the shell view's points because the shell's `pageZoom` stays 1.0
 * — and posts `placeBodies` with the whole set. Not `layoutRectOf`'s layout
 * px: the body applies View › Zoom to itself, so the host's frame is the
 * viewport rect at every zoom.
 *
 * A body shows when its body has said it is ready and its card is shown: the
 * active card of its pane, not folded, not arriving, and in the shown
 * workspace. Everything else posts `visible: false`, and the host hides it.
 *
 * **When it measures.** After every deck commit, from a beacon at the deck
 * root, and on what moves a placeholder without one — a window resize, a zoom
 * change, a body becoming ready, a placeholder resizing — coalesced to one
 * measurement on the far side of the next paint. Never inside a settle: while
 * a set-up is pending a measurement is a reader outside the Last pass, which
 * pays a whole-document layout of its own, and while the settle runs the rects
 * are the tween's, not the landing's. So it waits, and measures once when the
 * settle ends, and the bodies snap at the land.
 *
 * A set unchanged since the last post posts nothing.
 *
 * Laws: [L06] (the rects are appearance, posted to the host and never React
 * state), [L03] (measured in a layout effect), [L22] (direct observation of
 * the stores), [D211] (no reader in a settle's set-up), [D212] (a parked
 * workspace's bodies hide).
 *
 * @module lib/body-placement
 */

import type { IDeckManagerStore } from "../deck-manager-store";
import { scheduleAfterPaint, type CancelAfterPaint } from "./after-paint";
import { bodyCardsStore } from "./body-cards-store";
import { hostCapabilitiesStore, postToHost } from "./body-handoff";
import { cardArrivingOf, cardFoldedOf } from "../deck-store-selectors";
import { pageZoomStore } from "./page-zoom-store";
import { deferToSetUp, isSetUpPending } from "./set-up-apply";
import { IMPOSER_SETTLE_END } from "./settle-notice";

// ---------------------------------------------------------------------------
// The rule
// ---------------------------------------------------------------------------

/** What decides whether a body shows. */
export interface BodyShownFacts {
  /** The body has reported ready. */
  readonly ready: boolean;
  /** The card is its pane's active card. */
  readonly active: boolean;
  readonly folded: boolean;
  readonly arriving: boolean;
  /** The card's workspace is the shown one. */
  readonly layerShown: boolean;
}

/** Whether a body with these facts is placed visible. */
export function bodyVisible(facts: BodyShownFacts): boolean {
  return facts.ready && facts.active && !facts.folded && !facts.arriving && facts.layerShown;
}

/** One body's entry in `placeBodies`: a viewport rect and whether it shows. */
export interface BodyPlacement {
  readonly cardId: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly visible: boolean;
  /**
   * The pane's stacking order, its computed `z-index`: the host stacks the
   * bodies in the same order, so where two panes overlap the body of the
   * one in front is in front.
   */
  readonly z: number;
}

/** The `placeBodies` message body. */
export interface PlaceBodies {
  /** The pane's corner radius in px, which the host clips each body to. */
  readonly radius: number;
  readonly bodies: readonly BodyPlacement[];
}

/** Whether two placements say the same thing to the host. */
export function samePlacement(a: PlaceBodies | null, b: PlaceBodies): boolean {
  if (a === null) return false;
  if (a.radius !== b.radius || a.bodies.length !== b.bodies.length) return false;
  for (let i = 0; i < a.bodies.length; i++) {
    const p = a.bodies[i];
    const q = b.bodies[i];
    if (
      p.cardId !== q.cardId ||
      p.x !== q.x ||
      p.y !== q.y ||
      p.width !== q.width ||
      p.height !== q.height ||
      p.visible !== q.visible ||
      p.z !== q.z
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Posts a placement only when it differs from the last one posted. An empty
 * set before anything was posted is not news either: a deck with no bodies
 * says nothing to the host.
 */
export class PlacementPoster {
  private last: PlaceBodies | null = null;

  constructor(private readonly post: (placement: PlaceBodies) => void) {}

  /** Whether anything has been posted yet. */
  get posted(): boolean {
    return this.last !== null;
  }

  /** The last placement posted, or null. */
  get lastPosted(): PlaceBodies | null {
    return this.last;
  }

  /** Post `placement` if it is news; returns whether it was. */
  offer(placement: PlaceBodies): boolean {
    if (this.last === null && placement.bodies.length === 0) return false;
    if (samePlacement(this.last, placement)) return false;
    this.last = placement;
    this.post(placement);
    return true;
  }
}

// ---------------------------------------------------------------------------
// The floor
// ---------------------------------------------------------------------------

/**
 * The shell is a page above the bodies, and a page paints its canvas — the
 * `body` colour and the deck root's grid — over everything beneath it. So on
 * a host that makes bodies the page's own canvas goes transparent
 * (`html[data-body-host]`, `globals.css`) and the canvas is painted instead
 * by a floor the placer stands under the deck, cut with a hole at every
 * visible body's rect so the body shows through. The hole is a `clip-path`
 * polygon with the even-odd rule: the floor's whole box, then one square
 * per body, each traced inside it — cheap to composite, and only rewritten
 * when a placement changes.
 */
export const FLOOR_ATTRIBUTE = "data-deck-canvas-floor";
/** On `html` while a floor stands: the page's own canvas paint stands down. */
export const BODY_HOST_ATTRIBUTE = "data-body-host";

/** A hole in the floor, in the floor's own px. */
export interface FloorHole {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * The floor's `clip-path` for these holes: an even-odd `path()` that is the
 * whole box as one subpath and each hole as another, or `""` (no clip) when
 * there is none. A `path()`, never a `polygon()`: a polygon is ONE closed
 * ring, so a box and its holes listed as one would be a single zigzag whose
 * even-odd fill cuts triangles between the holes — which is what three cards
 * on a deck showed. Each hole is clamped to the box, and one with no area is
 * dropped.
 */
export function floorClipPath(holes: readonly FloorHole[], width: number, height: number): string {
  const n = (v: number): number => Math.round(v * 100) / 100;
  const subpaths: string[] = [];
  for (const hole of holes) {
    const x1 = Math.max(0, hole.x);
    const y1 = Math.max(0, hole.y);
    const x2 = Math.min(width, hole.x + hole.width);
    const y2 = Math.min(height, hole.y + hole.height);
    if (!(x2 > x1 && y2 > y1)) continue;
    subpaths.push(`M${n(x1)} ${n(y1)}H${n(x2)}V${n(y2)}H${n(x1)}Z`);
  }
  if (subpaths.length === 0) return "";
  return `path(evenodd, "M0 0H${n(width)}V${n(height)}H0Z${subpaths.join("")}")`;
}

/**
 * The holes a placement cuts: the union of every visible body's rect, as
 * disjoint pieces. Even-odd closes what two holes cover twice, and two
 * bodies can stand on one rect — two panes laid over each other, a card
 * measured twice — so the rects are first cut along every edge into cells
 * and each covered cell is one hole, none overlapping another.
 */
export function floorHoles(placement: PlaceBodies): FloorHole[] {
  const rects = placement.bodies
    .filter((b) => b.visible && b.width > 0 && b.height > 0)
    .map((b) => ({ x1: b.x, y1: b.y, x2: b.x + b.width, y2: b.y + b.height }));
  if (rects.length === 0) return [];
  const xs = [...new Set(rects.flatMap((r) => [r.x1, r.x2]))].sort((a, b) => a - b);
  const ys = [...new Set(rects.flatMap((r) => [r.y1, r.y2]))].sort((a, b) => a - b);
  const holes: FloorHole[] = [];
  for (let j = 0; j + 1 < ys.length; j++) {
    for (let i = 0; i + 1 < xs.length; i++) {
      const cx = (xs[i] + xs[i + 1]) / 2;
      const cy = (ys[j] + ys[j + 1]) / 2;
      if (rects.some((r) => cx > r.x1 && cx < r.x2 && cy > r.y1 && cy < r.y2)) {
        holes.push({ x: xs[i], y: ys[j], width: xs[i + 1] - xs[i], height: ys[j + 1] - ys[j] });
      }
    }
  }
  return holes;
}

// ---------------------------------------------------------------------------
// The measurement
// ---------------------------------------------------------------------------

const SETTLING_ATTRIBUTE = "data-imposer-settling";

/** The pane radius token, resolved where the placeholder stands. */
function radiusAt(el: Element): number {
  const value = parseFloat(getComputedStyle(el).getPropertyValue("--tug-radius-md"));
  return Number.isFinite(value) ? value : 0;
}

/**
 * Read every body placeholder under `root` once, and decide each one's
 * visibility from the deck.
 */
export function measurePlacements(deck: IDeckManagerStore, root: ParentNode): PlaceBodies {
  const state = deck.getSnapshot();
  const activeSpaceId = deck.getSpacesSnapshot().activeSpaceId;
  const bodies: BodyPlacement[] = [];
  let radius = 0;
  for (const el of root.querySelectorAll<HTMLElement>("[data-body-placeholder][data-card-id]")) {
    const cardId = el.dataset.cardId;
    if (cardId === undefined || !bodyCardsStore.has(cardId)) continue;
    const pane = state.panes.find((p) => p.cardIds.includes(cardId));
    if (pane === undefined) continue;
    const rect = el.getBoundingClientRect();
    const spaceId = deck.spaceOf(cardId);
    if (bodies.length === 0) radius = radiusAt(el);
    const z = parseInt(getComputedStyle(el.closest(".tug-pane") ?? el).zIndex, 10);
    bodies.push({
      cardId,
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      visible: bodyVisible({
        ready: bodyCardsStore.stateOf(cardId) === "ready",
        active: pane.activeCardId === cardId,
        folded: cardFoldedOf(state, cardId),
        arriving: cardArrivingOf(state, cardId),
        layerShown: spaceId === null || spaceId === activeSpaceId,
      }),
      z: Number.isFinite(z) ? z : 0,
    });
  }
  return { radius, bodies };
}

/**
 * The shell's placer: measures when asked, unless a settle holds the
 * geometry, and posts what changed. One per deck, started by the deck's
 * placement beacon with the canvas container it measures under.
 */
export class BodyPlacer {
  private readonly poster = new PlacementPoster((p) => postToHost("placeBodies", p));
  private container: HTMLElement | null = null;
  private floor: HTMLElement | null = null;
  private floorClip = "";
  private cancelScheduled: CancelAfterPaint | null = null;
  private resizes: ResizeObserver | null = null;
  private readonly observed = new Set<Element>();
  /** Why the last measurement was declined, for {@link bodyPlacementDiag}. */
  private lastSkip: string | null = null;
  private measures = 0;

  constructor(private readonly deck: IDeckManagerStore) {}

  /**
   * Measure now, from a commit's layout effect. In a settle's set-up the
   * measurement waits for the set-up's end instead and is coalesced there;
   * if a settle is then running it measures at the land.
   */
  afterCommit = (): void => {
    if (this.container === null) return;
    if (isSetUpPending()) {
      deferToSetUp(this, this.schedule);
      return;
    }
    this.measure();
  };

  /** Measure once on the far side of the next paint. Coalesces. */
  schedule = (): void => {
    if (this.cancelScheduled !== null) return;
    this.cancelScheduled = scheduleAfterPaint(() => {
      this.cancelScheduled = null;
      this.measure();
    });
  };

  /** Measure, unless a settle holds the geometry; post what changed. */
  measure = (): void => {
    const container = this.container;
    if (container === null) return;
    if (bodyCardsStore.cardIds().length === 0 && !this.poster.posted) return;
    if (isSetUpPending()) {
      this.lastSkip = "set-up pending";
      return;
    }
    if (container.hasAttribute(SETTLING_ATTRIBUTE)) {
      this.lastSkip = "settling";
      return;
    }
    this.lastSkip = null;
    this.measures += 1;
    const placement = measurePlacements(this.deck, container);
    this.poster.offer(placement);
    this.cutFloor(placement);
    this.observePlaceholders(container);
  };

  /**
   * Cut the floor at every visible body. The placement's rects are viewport
   * px; the floor lies inside the zoomed deck root, so they are taken into
   * its own px through its viewport rect and layout width.
   */
  private cutFloor(placement: PlaceBodies): void {
    const floor = this.floor;
    if (floor === null) return;
    const holes = floorHoles(placement);
    let clip = "";
    if (holes.length > 0) {
      const box = floor.getBoundingClientRect();
      const width = floor.offsetWidth;
      const height = floor.offsetHeight;
      const scale = width > 0 ? box.width / width : 1;
      clip = floorClipPath(
        holes.map((h) => ({
          x: (h.x - box.x) / scale,
          y: (h.y - box.y) / scale,
          width: h.width / scale,
          height: h.height / scale,
        })),
        width,
        height,
      );
    }
    if (clip === this.floorClip) return;
    this.floorClip = clip;
    floor.style.clipPath = clip;
  }

  /**
   * Start the standing wakes under `container` — the settle's land, a window
   * resize, a zoom change, a body's state, a placeholder's size — and return
   * the uninstall. A no-op when the host makes no bodies.
   */
  install(container: HTMLElement): () => void {
    if (!hostCapabilitiesStore.get().bodyViews) return () => {};
    this.container = container;
    setInstalled(this);
    // The floor: the canvas paint, under everything in the container, with
    // a hole per visible body. The page's own canvas stands down for it.
    const floor = document.createElement("div");
    floor.setAttribute(FLOOR_ATTRIBUTE, "");
    container.prepend(floor);
    this.floor = floor;
    this.floorClip = "";
    document.documentElement.setAttribute(BODY_HOST_ATTRIBUTE, "");
    this.resizes = new ResizeObserver(this.schedule);
    container.addEventListener(IMPOSER_SETTLE_END, this.measure);
    window.addEventListener("resize", this.schedule);
    const releaseZoom = pageZoomStore.subscribe(this.schedule);
    const releaseBodies = bodyCardsStore.subscribe(this.schedule);
    return () => {
      container.removeEventListener(IMPOSER_SETTLE_END, this.measure);
      window.removeEventListener("resize", this.schedule);
      releaseZoom();
      releaseBodies();
      this.resizes?.disconnect();
      this.resizes = null;
      this.observed.clear();
      this.cancelScheduled?.();
      this.cancelScheduled = null;
      this.container = null;
      floor.remove();
      this.floor = null;
      this.floorClip = "";
      document.documentElement.removeAttribute(BODY_HOST_ATTRIBUTE);
      if (installed === this) installed = null;
    };
  }

  /** Watch each placeholder's size, which can move without a deck commit. */
  private observePlaceholders(container: HTMLElement): void {
    const resizes = this.resizes;
    if (resizes === null) return;
    for (const el of container.querySelectorAll("[data-body-placeholder]")) {
      if (this.observed.has(el)) continue;
      this.observed.add(el);
      resizes.observe(el);
    }
    for (const el of [...this.observed]) {
      if (el.isConnected) continue;
      this.observed.delete(el);
      resizes.unobserve(el);
    }
  }

  /** What {@link bodyPlacementDiag} reports. */
  diag(): BodyPlacementDiag {
    return {
      lastPosted: this.poster.lastPosted,
      lastSkip: this.lastSkip,
      measures: this.measures,
    };
  }
}

/** The placer's own account of itself, for `tugdeck.diag`. */
export interface BodyPlacementDiag {
  readonly lastPosted: PlaceBodies | null;
  readonly lastSkip: string | null;
  readonly measures: number;
}

let installed: BodyPlacer | null = null;

function setInstalled(placer: BodyPlacer): void {
  installed = placer;
}

/** The installed placer's account, or null when none is installed. Read-only. */
export function bodyPlacementDiag(): BodyPlacementDiag | null {
  return installed?.diag() ?? null;
}
