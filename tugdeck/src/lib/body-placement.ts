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
 * A body shows when its body has said it is painted — its first frame of
 * real content has gone to the compositor, after `ready` — and its card is
 * shown: the active card of its pane, not folded, not arriving, and in the
 * shown workspace. Everything else posts `visible: false`, and the host
 * hides it.
 *
 * **The lid.** A body is beneath the shell page, so whatever the shell paints
 * over a body's rect is what the user sees there; and until the body is on
 * screen, what the shell paints is a LID in the pane's own surface colour —
 * the placeholder's pseudo-element (`tug-pane.css`), opaque by default and
 * lifted by `data-body-shown`. Under the lid the host places the body, cuts
 * nothing the user sees, and shows the container in full; only when the host
 * answers `shown` — its transaction gone to the render server — does the
 * shell lift the lid, in a short fade from the surface to the content. So no
 * frame shows the canvas, the grid, or the window's own background through
 * the hole: before the body, the lid; after, the body. A body that stops
 * showing is lidded again in the same commit that hides it — and the host is
 * told to hide it only on the far side of that commit's paint, the show's
 * order mirrored: the host's transaction lands at once while the shell's
 * frame is still a paint away, so a hide posted in the commit opened the
 * hole for one frame before the lid was on it (row 4's reading). Lid and
 * hole first, then the host; a lid over a body the host still shows is
 * nothing the user sees.
 *
 * **When it measures.** After every deck commit, from a beacon at the deck
 * root, and on what moves a placeholder without one — a window resize, a zoom
 * change, a body becoming ready, a placeholder resizing — coalesced to one
 * measurement on the far side of the next paint. Never inside a settle: while
 * a set-up is pending a measurement is a reader outside the Last pass, which
 * pays a whole-document layout of its own, and while the settle runs the rects
 * are the tween's, not the landing's. So it waits, and measures once when the
 * settle ends, and the bodies snap at the land. What does not wait is a body
 * that stopped showing — its pane closed, folded, parked, or arriving — which
 * is hidden at the commit that started the settle, with the rects it had: the
 * hole closes and the lid goes on in the frame the chrome starts to move, so
 * a body never stands still under moving chrome or shows the window through
 * an open hole as its chrome leaves.
 *
 * **The panes are cut the same way.** The shell paints every pane above every
 * body, so where two panes overlap the back pane's border and chrome would
 * lie over the front card's body. Each pane behind a visible body wears an
 * even-odd `clip-path` with a hole at every front body's rect, written from
 * the same placement that cuts the floor, so the shell paints nothing of a
 * back card inside a front body's rect ([F16]).
 *
 * A set unchanged since the last post posts nothing.
 *
 * **A hand carrying a frame.** A pane drag writes the frame's inline
 * transform every pointer frame, and its drop landing tweens it home; no
 * commit, resize or settle end comes with either, so nothing above would
 * post the body under it until the gesture was over — the chrome followed
 * the hand while the content stood where the last commit put it. So the
 * gesture tells the placer each frame it moves the frame
 * ({@link bodyFollowFrame}), and the placer re-posts that one body at the
 * rect its placeholder now has and moves the floor's hole with it. The host
 * places it in a transaction with no animation, so the body stands where
 * the chrome stands, frame for frame.
 *
 * **A beat carrying a frame.** A settle's beats tween a frame from where it
 * stood to where the commit put it, and the placer measures nothing until
 * the land — so for the beat's length the body would stand still at its
 * First rect while the chrome slid away from it, and jump at the land. Until
 * the host carries bodies through a beat itself, the interim is to hide:
 * the settle engine tells the placer which frames its beats will move
 * ({@link bodyHideUnder}) in the pass that plans them, before their first
 * frame paints, and the placer hides every body under those frames at the
 * rects it had, closes their holes and puts their lids on. The chrome moves
 * carrying a blank card; the land's measurement posts the body visible at
 * its new rect, the host shows it under the lid, and the lid lifts. A body
 * is never shown under moving chrome.
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
  /** The body has reported painted: its first frame of content is composited. */
  readonly painted: boolean;
  /** The card is its pane's active card. */
  readonly active: boolean;
  readonly folded: boolean;
  readonly arriving: boolean;
  /** The card's workspace is the shown one. */
  readonly layerShown: boolean;
}

/** Whether a body with these facts is placed visible. */
export function bodyVisible(facts: BodyShownFacts): boolean {
  return facts.painted && facts.active && !facts.folded && !facts.arriving && facts.layerShown;
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
/**
 * On a body placeholder once the host has shown its body: the lid lifts.
 * Absent, the placeholder paints the pane's surface over the body's rect.
 */
export const BODY_SHOWN_ATTRIBUTE = "data-body-shown";

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
  return evenOddClip(holes, 0, 0, width, height);
}

/**
 * How far past a pane's box its clip's outer ring reaches, in px: a pane's
 * clip exists only for its holes, so the ring must cut nothing a pane
 * paints outside its own box — a popover, a ring, a shadow.
 */
const PANE_CLIP_REACH_PX = 100_000;

/**
 * A pane's `clip-path` for these holes, in the pane's own px: the same
 * even-odd path as the floor's, with an outer ring far past the pane's
 * box, or `""` when there is no hole.
 */
export function paneClipPath(holes: readonly FloorHole[]): string {
  const r = PANE_CLIP_REACH_PX;
  return evenOddClip(holes, -r, -r, r, r);
}

function evenOddClip(holes: readonly FloorHole[], x0: number, y0: number, x1: number, y1: number): string {
  const n = (v: number): number => Math.round(v * 100) / 100;
  const subpaths: string[] = [];
  for (const hole of holes) {
    const hx1 = Math.max(x0, hole.x);
    const hy1 = Math.max(y0, hole.y);
    const hx2 = Math.min(x1, hole.x + hole.width);
    const hy2 = Math.min(y1, hole.y + hole.height);
    if (!(hx2 > hx1 && hy2 > hy1)) continue;
    subpaths.push(`M${n(hx1)} ${n(hy1)}H${n(hx2)}V${n(hy2)}H${n(hx1)}Z`);
  }
  if (subpaths.length === 0) return "";
  return `path(evenodd, "M${n(x0)} ${n(y0)}H${n(x1)}V${n(y1)}H${n(x0)}Z${subpaths.join("")}")`;
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

/** A pane's viewport box, its layout width, and its stacking order, as the last measurement read them. */
export interface PaneBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly layoutWidth: number;
  readonly z: number;
}

/**
 * The holes a pane behind body cards wears, in its own px: one per visible
 * body in front of it (a higher `z`) whose rect meets its box. The shell
 * paints every pane above every body, so a back pane's chrome would lie
 * over a front card's body; cut at the front bodies' rects, the pane
 * paints nothing inside them ([F16]). A pane in no body's way, or in front
 * of them all, wears none.
 */
export function paneHoles(placement: PlaceBodies, pane: PaneBox): FloorHole[] {
  if (!(pane.width > 0 && pane.height > 0 && pane.layoutWidth > 0)) return [];
  const scale = pane.width / pane.layoutWidth;
  const fronts = placement.bodies.filter(
    (b) =>
      b.visible &&
      b.z > pane.z &&
      b.width > 0 &&
      b.height > 0 &&
      b.x < pane.x + pane.width &&
      b.x + b.width > pane.x &&
      b.y < pane.y + pane.height &&
      b.y + b.height > pane.y,
  );
  return floorHoles({ radius: placement.radius, bodies: fronts }).map((h) => ({
    x: (h.x - pane.x) / scale,
    y: (h.y - pane.y) / scale,
    width: h.width / scale,
    height: h.height / scale,
  }));
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
 * The facts that decide whether `cardId`'s body shows, read from the deck
 * and the body store alone — no DOM — or null when the card is in no pane.
 */
function shownFactsOf(deck: IDeckManagerStore, cardId: string): BodyShownFacts | null {
  const state = deck.getSnapshot();
  const pane = state.panes.find((p) => p.cardIds.includes(cardId));
  if (pane === undefined) return null;
  const spaceId = deck.spaceOf(cardId);
  const activeSpaceId = deck.getSpacesSnapshot().activeSpaceId;
  return {
    painted: bodyCardsStore.stateOf(cardId) === "painted",
    active: pane.activeCardId === cardId,
    folded: cardFoldedOf(state, cardId),
    arriving: cardArrivingOf(state, cardId),
    layerShown: spaceId === null || spaceId === activeSpaceId,
  };
}

/**
 * Read every body placeholder under `root` once, and decide each one's
 * visibility from the deck.
 */
export function measurePlacements(deck: IDeckManagerStore, root: ParentNode): PlaceBodies {
  const bodies: BodyPlacement[] = [];
  let radius = 0;
  for (const el of root.querySelectorAll<HTMLElement>("[data-body-placeholder][data-card-id]")) {
    const cardId = el.dataset.cardId;
    if (cardId === undefined || !bodyCardsStore.has(cardId)) continue;
    const facts = shownFactsOf(deck, cardId);
    const rect = el.getBoundingClientRect();
    if (bodies.length === 0) radius = radiusAt(el);
    const z = parseInt(getComputedStyle(el.closest(".tug-pane") ?? el).zIndex, 10);
    bodies.push({
      cardId,
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      // A placeholder whose card is in no pane of the shown deck — a parked
      // workspace's card — is a body to hide and a lid to put back on.
      visible: facts !== null && bodyVisible(facts),
      z: Number.isFinite(z) ? z : 0,
    });
  }
  return { radius, bodies };
}

/**
 * `placement` with every body whose facts no longer show it marked hidden,
 * at the rect it had — or null when nothing changed. The commit-time half of
 * placement: what a settle may not measure, it may still hide.
 */
export function hiddenSince(deck: IDeckManagerStore, placement: PlaceBodies): PlaceBodies | null {
  let changed = false;
  const bodies = placement.bodies.map((b) => {
    if (!b.visible) return b;
    const facts = bodyCardsStore.has(b.cardId) ? shownFactsOf(deck, b.cardId) : null;
    if (facts !== null && bodyVisible(facts)) return b;
    changed = true;
    return { ...b, visible: false };
  });
  return changed ? { radius: placement.radius, bodies } : null;
}

/** The floor's viewport box and its layout size, as the last measurement read them. */
interface FloorBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly layoutWidth: number;
  readonly layoutHeight: number;
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
  /** The floor's box and layout size, read in the last measurement. */
  private floorBox: FloorBox | null = null;
  /** Every pane's box and order, read in the last measurement, and the cut each wears. */
  private paneBoxes = new Map<HTMLElement, PaneBox>();
  private readonly paneClips = new Map<HTMLElement, string>();
  private cancelScheduled: CancelAfterPaint | null = null;
  /** Bodies lidded this frame whose hide the host has not yet been told; posted after the paint. */
  private readonly hiding = new Set<string>();
  private cancelHidePost: CancelAfterPaint | null = null;
  private resizes: ResizeObserver | null = null;
  private readonly observed = new Set<Element>();
  /** Why the last measurement was declined, for {@link bodyPlacementDiag}. */
  private lastSkip: string | null = null;
  private measures = 0;

  constructor(private readonly deck: IDeckManagerStore) {}

  /**
   * Measure now, from a commit's layout effect. In a settle's set-up the
   * measurement waits for the set-up's end instead and is coalesced there;
   * if a settle is then running it measures at the land. What a settle holds
   * is the rects, not the hiding: a body whose facts no longer show it is
   * hidden now, at the commit, with the rect it had.
   */
  afterCommit = (): void => {
    if (this.container === null) return;
    if (isSetUpPending()) {
      this.hideWhatLeft();
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
      this.hideWhatLeft();
      return;
    }
    if (container.hasAttribute(SETTLING_ATTRIBUTE)) {
      this.lastSkip = "settling";
      this.hideWhatLeft();
      return;
    }
    this.lastSkip = null;
    this.measures += 1;
    const placement = measurePlacements(this.deck, container);
    this.floorBox = this.readFloorBox();
    this.paneBoxes = this.readPaneBoxes(container);
    this.poster.offer(placement);
    // A measurement is the whole truth: a body it shows is no longer one a
    // pending hide may take back after the paint, and `shown` may lift its lid.
    for (const b of placement.bodies) if (b.visible) this.hiding.delete(b.cardId);
    this.cutFloor(placement);
    this.cutPanes(placement);
    this.lidHidden(placement, container);
    this.observePlaceholders(container);
  };

  /**
   * Hide, now, every body the last placement showed whose facts no longer
   * show it: post the placement with those marked hidden, close their holes,
   * and put their lids on. No DOM is read — the rects are the last posted,
   * the floor's box the last measured — so this runs inside a settle's
   * set-up without a layout of its own ([D211]).
   */
  private hideWhatLeft(): void {
    const last = this.poster.lastPosted;
    const container = this.container;
    if (last === null || container === null) return;
    const next = hiddenSince(this.deck, last);
    if (next === null) return;
    this.hideNow(next, container);
  }

  /**
   * Hide the bodies `next` marks hidden: the lid goes on and the hole
   * closes now, in this commit, and the host is told on the far side of
   * the paint — against whatever was posted by then, so a measurement in
   * between is not overwritten with these rects. Coalesces.
   */
  private hideNow(next: PlaceBodies, container: HTMLElement): void {
    const last = this.poster.lastPosted;
    for (const b of next.bodies) {
      if (!b.visible && (last?.bodies.some((p) => p.cardId === b.cardId && p.visible) ?? false)) this.hiding.add(b.cardId);
    }
    this.cutFloor(next);
    this.cutPanes(next);
    this.lidHidden(next, container);
    this.cancelHidePost ??= scheduleAfterPaint(() => {
      this.cancelHidePost = null;
      const posted = this.poster.lastPosted;
      if (posted !== null && this.hiding.size > 0) {
        const bodies = posted.bodies.map((b) => (b.visible && this.hiding.has(b.cardId) ? { ...b, visible: false } : b));
        this.poster.offer({ radius: posted.radius, bodies });
      }
      this.hiding.clear();
    });
  }

  /** Put the lid back on every placeholder whose body the placement hides. */
  private lidHidden(placement: PlaceBodies, container: HTMLElement): void {
    for (const b of placement.bodies) {
      if (b.visible) continue;
      container
        .querySelector(`[data-body-placeholder][data-card-id="${b.cardId}"]`)
        ?.removeAttribute(BODY_SHOWN_ATTRIBUTE);
    }
  }

  /**
   * A gesture moved `frame` without a commit: a pane drag's pointer frame,
   * its cancel, or its drop landing's tween. Re-post every body whose
   * placeholder stands in the frame at the rect it has now, and cut the
   * floor to match. Reads the placeholders' rects, which is the one answer
   * that cannot drift from what the user sees under the hand; a frame
   * carrying no posted body posts nothing.
   */
  follow(frame: HTMLElement): void {
    const last = this.poster.lastPosted;
    const container = this.container;
    if (last === null || container === null) return;
    let bodies: BodyPlacement[] | null = null;
    for (const el of frame.querySelectorAll<HTMLElement>("[data-body-placeholder][data-card-id]")) {
      const cardId = el.dataset.cardId;
      if (cardId === undefined) continue;
      const i = last.bodies.findIndex((b) => b.cardId === cardId);
      if (i < 0) continue;
      const rect = el.getBoundingClientRect();
      const b = last.bodies[i];
      if (b.x === rect.x && b.y === rect.y && b.width === rect.width && b.height === rect.height) continue;
      bodies ??= [...last.bodies];
      bodies[i] = { ...b, x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    }
    if (bodies === null) return;
    const next: PlaceBodies = { radius: last.radius, bodies };
    this.poster.offer(next);
    const box = this.paneBoxes.get(frame);
    if (box !== undefined) {
      const rect = frame.getBoundingClientRect();
      this.paneBoxes.set(frame, { ...box, x: rect.x, y: rect.y, width: rect.width, height: rect.height });
    }
    this.cutFloor(next);
    this.cutPanes(next);
  }

  /**
   * A settle is about to move `frames`: hide, now, every shown body whose
   * placeholder stands in one of them, at the rect it had, and lid it. No
   * layout is read — the rects are the last posted — so this runs inside
   * the set-up's Last pass before the beat's first frame ([D211]). The
   * land's measurement shows them again where the chrome has come to rest.
   */
  hideUnder(frames: readonly HTMLElement[]): void {
    const last = this.poster.lastPosted;
    const container = this.container;
    if (last === null || container === null) return;
    const under = new Set<string>();
    for (const frame of frames) {
      for (const el of frame.querySelectorAll<HTMLElement>("[data-body-placeholder][data-card-id]")) {
        if (el.dataset.cardId !== undefined) under.add(el.dataset.cardId);
      }
    }
    if (under.size === 0) return;
    let changed = false;
    const bodies = last.bodies.map((b) => {
      if (!b.visible || !under.has(b.cardId)) return b;
      changed = true;
      return { ...b, visible: false };
    });
    if (!changed) return;
    const next: PlaceBodies = { radius: last.radius, bodies };
    this.hideNow(next, container);
  }

  /**
   * The host has shown `cardId`'s body — its container is placed, opaque and
   * gone to the render server. Lift the lid, unless the shell has since
   * posted the body hidden, in which case the lid stays and the host's next
   * placement hides the container.
   */
  shown(cardId: string): void {
    const container = this.container;
    if (container === null) return;
    if (this.hiding.has(cardId)) return;
    if (!(this.poster.lastPosted?.bodies.some((b) => b.cardId === cardId && b.visible) ?? false)) return;
    container
      .querySelector(`[data-body-placeholder][data-card-id="${cardId}"]`)
      ?.setAttribute(BODY_SHOWN_ATTRIBUTE, "");
  }

  private readFloorBox(): FloorBox | null {
    const floor = this.floor;
    if (floor === null) return null;
    const box = floor.getBoundingClientRect();
    return {
      x: box.x,
      y: box.y,
      width: box.width,
      height: box.height,
      layoutWidth: floor.offsetWidth,
      layoutHeight: floor.offsetHeight,
    };
  }

  /**
   * Cut the floor at every visible body. The placement's rects are viewport
   * px; the floor lies inside the zoomed deck root, so they are taken into
   * its own px through its viewport rect and layout width, both read in the
   * last measurement.
   */
  private cutFloor(placement: PlaceBodies): void {
    const floor = this.floor;
    if (floor === null) return;
    const holes = floorHoles(placement);
    let clip = "";
    const box = this.floorBox;
    if (holes.length > 0 && box !== null) {
      const width = box.layoutWidth;
      const height = box.layoutHeight;
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

  /** Every pane's box, layout width and stacking order, read once. */
  private readPaneBoxes(container: HTMLElement): Map<HTMLElement, PaneBox> {
    const boxes = new Map<HTMLElement, PaneBox>();
    for (const pane of container.querySelectorAll<HTMLElement>(".tug-pane")) {
      const rect = pane.getBoundingClientRect();
      const z = parseInt(getComputedStyle(pane).zIndex, 10);
      boxes.set(pane, {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        layoutWidth: pane.offsetWidth,
        z: Number.isFinite(z) ? z : 0,
      });
    }
    return boxes;
  }

  /**
   * Cut every pane behind a visible body at that body's rect, and clear the
   * cut on every other. The boxes are the last measurement's, so this runs
   * with no layout of its own where a hide does ([D211]): a hide only
   * closes holes, and a drag re-reads the one frame it moved.
   */
  private cutPanes(placement: PlaceBodies): void {
    for (const [pane, box] of this.paneBoxes) {
      const clip = pane.isConnected ? paneClipPath(paneHoles(placement, box)) : "";
      if ((this.paneClips.get(pane) ?? "") === clip) continue;
      if (clip === "") this.paneClips.delete(pane);
      else this.paneClips.set(pane, clip);
      pane.style.clipPath = clip;
    }
    for (const pane of [...this.paneClips.keys()]) {
      if (this.paneBoxes.has(pane)) continue;
      pane.style.clipPath = "";
      this.paneClips.delete(pane);
    }
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
    this.floorBox = null;
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
      this.cancelHidePost?.();
      this.cancelHidePost = null;
      this.hiding.clear();
      this.container = null;
      floor.remove();
      this.floor = null;
      this.floorClip = "";
      this.floorBox = null;
      for (const pane of this.paneClips.keys()) pane.style.clipPath = "";
      this.paneClips.clear();
      this.paneBoxes.clear();
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

/** The host has shown `cardId`'s body: the installed placer lifts its lid. */
export function bodyShown(cardId: string): void {
  installed?.shown(cardId);
}

/**
 * A gesture moved `frame` without a commit: the installed placer re-posts
 * the bodies under it at the rects they have now. A no-op when the host
 * makes no bodies.
 */
export function bodyFollowFrame(frame: HTMLElement): void {
  installed?.follow(frame);
}

/**
 * A settle is about to move `frames`: the installed placer hides every body
 * under them until the land. A no-op when the host makes no bodies.
 */
export function bodyHideUnder(frames: readonly HTMLElement[]): void {
  installed?.hideUnder(frames);
}
