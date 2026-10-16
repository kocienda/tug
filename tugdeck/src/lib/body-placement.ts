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
 * viewport rect at every zoom, grown outward to whole points (`wholePoints`):
 * a body's page lays out in whole points, and a fraction of a view past it
 * is not page at all.
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
 * **The floor is the host's.** Beneath the bodies the host draws the canvas
 * colour and the grid itself, from the `floorGrid` this posts once per theme
 * and zoom, so the shell cuts no floor and nothing in it follows a body.
 * The page's own canvas stands down only once the host says its floor is on
 * screen (`floorShown`).
 *
 * **The panes are cut.** The shell paints every pane above every body, so
 * where two panes overlap the back pane's border and chrome would lie over
 * the front card's body. Each pane behind a visible body wears an even-odd
 * `clip-path` with a hole at every front body's rect, written from the
 * placement, so the shell paints nothing of a back card inside a front
 * body's rect ([F16]).
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
 * rect its placeholder now has and re-cuts the panes behind it. The host
 * places it in a transaction with no animation, so the body stands where
 * the chrome stands, frame for frame.
 *
 * **A beat carrying a frame.** A settle's beats tween a frame from where it
 * stood to where the commit put it, and the placer measures nothing until
 * the land — so for the beat's length the body would stand still at its
 * First rect while the chrome slid away from it, and jump at the land. So
 * the host carries it: in the pass that plans the beats, before their first
 * frame paints, the settle engine hands the placer the frames its beats will
 * move ({@link bodyRunPlan}), and the placer plans each body under them
 * (`lib/body-beat-plan.ts`) and posts the host a `beatPlan` — each beat's
 * rects, curve and delay from a start both sides know. The host runs the
 * body's container as Core Animation on it, and the planned landing is
 * adopted as posted, so the land's measurement is not news. A body the
 * planner refuses — one whose box changes size, one whose placement is not
 * where its frame stands — is hidden for the motion instead: at the rect it
 * had, its holes closed and its lid on, and the land's measurement shows it
 * again where the chrome stopped. A body is never shown standing still
 * under moving chrome.
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
import { subscribeOnScreenTheme } from "../contexts/theme-provider";
import { deckRootElement, pageZoomStore } from "./page-zoom-store";
import { deferToSetUp, isSetUpPending } from "./set-up-apply";
import { IMPOSER_SETTLE_END } from "./settle-notice";
import {
  PANE_CLIP_REACH_PX,
  cutWindow,
  frameRectBeats,
  paneCutKeyframes,
  planBodyBeats,
  shellWallMs,
  sweptUnionCut,
  wholePoints,
  type BeatPlan,
  type BodyBeat,
  type BodyBeats,
  type CarriedFrame,
  type CutFront,
  type FrameBeat,
  type Insets,
  type Rect,
} from "./body-beat-plan";
import type { Beat, BeatOptions, BeatRow } from "../components/tugways/tug-animator";
import { getTugTiming } from "./scale-timing";
import { deckTrace } from "../deck-trace";

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

  /**
   * Take `placement` as what the host already holds, without posting it.
   * For rects the host reaches on its own — a beat plan's landing — so the
   * measurement that reads the same rects at the land is not news.
   */
  adopt(placement: PlaceBodies): void {
    this.last = placement;
  }
}

// ---------------------------------------------------------------------------
// The floor
// ---------------------------------------------------------------------------

/**
 * The shell is a page above the bodies, and a page paints its canvas — the
 * `body` colour and the deck root's grid — over everything beneath it. So on
 * a host that makes bodies the canvas is the host's: a floor view beneath
 * the bodies (`DeckFloorView`, `BodyViewController.swift`) draws the canvas
 * colour and the grid, from the `floorGrid` the placer posts once per theme
 * and zoom. The shell cuts nothing for it, and nothing in the shell follows
 * a body across it. The page's own canvas stands down
 * (`html[data-body-host]`, `globals.css`) only once the host answers
 * `floorShown` — its floor is on screen — so no frame shows the splash or
 * the bare window where the canvas belongs.
 */
/** On `html` once the host's floor is on screen: the page's own canvas paint stands down. */
export const BODY_HOST_ATTRIBUTE = "data-body-host";
/**
 * On a body placeholder once the host has shown its body: the lid lifts.
 * Absent, the placeholder paints the pane's surface over the body's rect.
 */
export const BODY_SHOWN_ATTRIBUTE = "data-body-shown";

/** The canvas colour and grid the host's floor draws, in viewport points. */
export interface FloorGrid {
  /** `#rrggbb`. */
  readonly canvas: string;
  /** `#rrggbb`, or `rgba(r, g, b, a)` for a grid with alpha. */
  readonly grid: string;
  /** The grid's cell, layout px. */
  readonly cellPx: number;
  /** The line's width, layout px. */
  readonly linePx: number;
  /** The deck root's scale. */
  readonly zoom: number;
  /** The deck root's viewport origin, where the first lines fall. */
  readonly originX: number;
  readonly originY: number;
}

/** The grid's cell and line, as `globals.css` paints them on the deck root. */
const GRID_CELL_PX = 24;
const GRID_LINE_PX = 1;

const CANVAS_TOKEN = "--tug7-surface-global-primary-normal-canvas-rest";
const GRID_TOKEN = "--tug7-surface-global-primary-normal-grid-rest";

/**
 * A CSS colour as the host can draw it: `#rrggbb` when opaque, else
 * `rgba(r, g, b, a)`, or null for an empty value. The tokens are `oklch()`
 * strings, which the host does not parse, so the colour is resolved the way
 * the page paints it, through a 2D canvas's sRGB pixel.
 */
function resolveColor(value: string): string | null {
  if (value.trim() === "") return null;
  const ctx = document.createElement("canvas").getContext("2d");
  if (ctx === null) return null;
  ctx.fillStyle = value;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
  if (a === 255) return `#${[r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
  return `rgba(${r}, ${g}, ${b}, ${Math.round((a / 255) * 1000) / 1000})`;
}

/** Whether two `floorGrid`s say the same thing to the host. */
export function sameFloorGrid(a: FloorGrid | null, b: FloorGrid): boolean {
  return (
    a !== null &&
    a.canvas === b.canvas &&
    a.grid === b.grid &&
    a.cellPx === b.cellPx &&
    a.linePx === b.linePx &&
    a.zoom === b.zoom &&
    a.originX === b.originX &&
    a.originY === b.originY
  );
}

/** A hole a body cuts in a pane behind it, in the pane's own px. */
export interface BodyHole {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * A pane's `clip-path` for these holes, in the pane's own px: an even-odd
 * `path()` that is an outer ring far past the pane's box as one subpath and
 * each hole as another, or `""` (no clip) when there is none. A `path()`,
 * never a `polygon()`: a polygon is ONE closed ring, so a box and its holes
 * listed as one would be a single zigzag whose even-odd fill cuts triangles
 * between the holes — which is what three cards on a deck showed. Each hole
 * is clamped to the ring, and one with no area is dropped.
 */
export function paneClipPath(holes: readonly BodyHole[]): string {
  const r = PANE_CLIP_REACH_PX;
  return evenOddClip(holes, -r, -r, r, r);
}

function evenOddClip(holes: readonly BodyHole[], x0: number, y0: number, x1: number, y1: number): string {
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
 * The holes a placement's visible bodies cut, in viewport px: the union of
 * their rects, as disjoint pieces. Even-odd closes what two holes cover
 * twice, and two bodies can stand on one rect — two panes laid over each
 * other, a card measured twice — so the rects are first cut along every
 * edge into cells and each covered cell is one hole, none overlapping
 * another.
 */
export function bodyHoles(placement: PlaceBodies): BodyHole[] {
  const rects = placement.bodies
    .filter((b) => b.visible && b.width > 0 && b.height > 0)
    .map((b) => ({ x1: b.x, y1: b.y, x2: b.x + b.width, y2: b.y + b.height }));
  if (rects.length === 0) return [];
  const xs = [...new Set(rects.flatMap((r) => [r.x1, r.x2]))].sort((a, b) => a - b);
  const ys = [...new Set(rects.flatMap((r) => [r.y1, r.y2]))].sort((a, b) => a - b);
  const holes: BodyHole[] = [];
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
  /** The edge a pinned rail stood on when it was measured (`data-rail-side`); absent for any other pane. */
  readonly railSide?: string | null;
}

/**
 * The holes a pane behind body cards wears, in its own px: one per visible
 * body in front of it (a higher `z`) whose rect meets its box. The shell
 * paints every pane above every body, so a back pane's chrome would lie
 * over a front card's body; cut at the front bodies' rects, the pane
 * paints nothing inside them ([F16]). A pane in no body's way, or in front
 * of them all, wears none.
 */
export function paneHoles(placement: PlaceBodies, pane: PaneBox): BodyHole[] {
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
  return bodyHoles({ radius: placement.radius, bodies: fronts }).map((h) => ({
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
 * `bodies` in the order a reader takes the deck: left to right, then top to
 * bottom within a column. The host reads the posted order as the window's
 * VoiceOver order, after the shell's own view; the placeholders' document
 * order is the canvas's pane-id order, which says nothing about where a
 * pane stands.
 */
export function inReadingOrder(bodies: readonly BodyPlacement[]): BodyPlacement[] {
  return [...bodies].sort((a, b) => a.x - b.x || a.y - b.y);
}

/**
 * Read every body placeholder under `root` once, and decide each one's
 * visibility from the deck. The bodies are posted in reading order
 * (`inReadingOrder`).
 */
export function measurePlacements(deck: IDeckManagerStore, root: ParentNode, exact?: Map<string, Rect>): PlaceBodies {
  const bodies: BodyPlacement[] = [];
  let radius = 0;
  for (const el of root.querySelectorAll<HTMLElement>("[data-body-placeholder][data-card-id]")) {
    const cardId = el.dataset.cardId;
    if (cardId === undefined || !bodyCardsStore.has(cardId)) continue;
    const facts = shownFactsOf(deck, cardId);
    const measured = el.getBoundingClientRect();
    exact?.set(cardId, { x: measured.x, y: measured.y, width: measured.width, height: measured.height });
    const rect = wholePoints(measured);
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
  return { radius, bodies: inReadingOrder(bodies) };
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

/**
 * The shell's placer: measures when asked, unless a settle holds the
 * geometry, and posts what changed. One per deck, started by the deck's
 * placement beacon with the canvas container it measures under.
 */
export class BodyPlacer {
  private readonly poster = new PlacementPoster((p) => postToHost("placeBodies", p));
  private container: HTMLElement | null = null;
  /** The last `floorGrid` posted, so a re-post that says nothing new is not sent. */
  private floorGrid: FloorGrid | null = null;
  /** The host's first `floorShown`, for {@link bodyPlacementDiag}. */
  private floorReport: FloorShownReport | null = null;
  /** Every pane's box and order, read in the last measurement, and the cut each wears. */
  private paneBoxes = new Map<HTMLElement, PaneBox>();
  /**
   * Each placeholder's rect as the last measurement read it, before it was
   * grown to the whole points it is posted at. A plan's insets are taken
   * from these: an inset taken from a grown rect carries the growth, and a
   * frame that stood on a half point lands its body a point off.
   */
  private readonly exactRects = new Map<string, Rect>();
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
  /** The last beat plan's id; each plan takes the next. */
  private planSerial = 0;
  /** The bodies a posted plan is carrying, until the host says it landed or was cancelled. */
  private readonly inFlight = new Map<string, { planId: number; landing: Rect }>();
  /** What the last {@link runPlan} decided, and what the host has said of it since. */
  private lastPlan: BeatPlanReport | null = null;
  /** How many times {@link runPlan} has run, so a reader can tell its last report is new. */
  private planRuns = 0;
  /**
   * The moving cut each back pane wears through a plan, and the static cut
   * it lands on. A newer plan or any placement cancels it; a cut that runs
   * out writes its landing cut, since the animator commits the last keyframe.
   */
  private readonly cutBeats = new Map<HTMLElement, { beat: Beat; landClip: string }>();
  /** How the last plan cut each pane it touched, for {@link bodyPlacementDiag}. */
  private lastCuts: Record<string, "moving" | "union"> = {};

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

  /**
   * Re-post the floor and measure, once, on the far side of the next paint.
   * Coalesces. The floor is posted here rather than in {@link measure} so
   * a deck with no bodies still has one, and so the per-commit measurement
   * pays no token read.
   */
  schedule = (): void => {
    if (this.cancelScheduled !== null) return;
    this.cancelScheduled = scheduleAfterPaint(() => {
      this.cancelScheduled = null;
      this.postFloor();
      this.measure();
    });
  };

  /**
   * Measure, unless a settle holds the geometry; post what changed. A
   * measurement a settle's set-up declines is queued for the set-up's end
   * rather than dropped: it may be the one that clears a gesture's last cut,
   * and a set-up that turns into no settle sends no land to measure at.
   */
  measure = (): void => {
    const container = this.container;
    if (container === null) return;
    if (bodyCardsStore.cardIds().length === 0 && !this.poster.posted) return;
    if (isSetUpPending()) {
      this.lastSkip = "set-up pending";
      this.hideWhatLeft();
      deferToSetUp(this, this.schedule);
      return;
    }
    if (container.hasAttribute(SETTLING_ATTRIBUTE)) {
      this.lastSkip = "settling";
      this.hideWhatLeft();
      return;
    }
    this.lastSkip = null;
    this.measures += 1;
    this.exactRects.clear();
    const placement = measurePlacements(this.deck, container, this.exactRects);
    this.paneBoxes = this.readPaneBoxes(container);
    this.poster.offer(placement);
    // A measurement is the whole truth: a body it shows is no longer one a
    // pending hide may take back after the paint, and `shown` may lift its lid.
    for (const b of placement.bodies) if (b.visible) this.hiding.delete(b.cardId);
    this.cutPanes(placement);
    this.lidHidden(placement, container);
    this.observePlaceholders(container);
  };

  /**
   * Hide, now, every body the last placement showed whose facts no longer
   * show it: post the placement with those marked hidden, close the holes
   * they cut in the panes behind them, and put their lids on. No DOM is
   * read — the rects are the last posted, the panes' boxes the last
   * measured — so this runs inside a settle's set-up without a layout of
   * its own ([D211]).
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
   * placeholder stands in the frame at the rect it has now, and re-cut the
   * panes behind it to match. Reads the placeholders' rects, which is the
   * one answer that cannot drift from what the user sees under the hand; a
   * frame carrying no posted body posts nothing.
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
      const measured = el.getBoundingClientRect();
      this.exactRects.set(cardId, { x: measured.x, y: measured.y, width: measured.width, height: measured.height });
      const rect = wholePoints(measured);
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
    this.cutPanes(next);
  }

  /**
   * A gesture that moved `frame` without a commit has ended — a drop's
   * landing, a cancel, a free drop. Re-post the frame's bodies where it
   * stands, then measure every body and every pane box once on the far side
   * of the paint, so no pane keeps a cut a frame of the gesture gave it: the
   * gesture re-read only its own frame, and the deck around it may have
   * moved while it ran.
   */
  land(frame: HTMLElement): void {
    this.follow(frame);
    this.schedule();
  }

  /**
   * A settle is about to move `frames`: hide, now, every shown body whose
   * placeholder stands in one of them, at the rect it had, and lid it. No
   * layout is read — the rects are the last posted — so this runs inside
   * the set-up's Last pass before the beat's first frame ([D211]). The
   * land's measurement shows them again where the chrome has come to rest.
   */
  hideUnder(frames: readonly HTMLElement[]): void {
    const under = new Set<string>();
    for (const frame of frames) {
      for (const cardId of bodiesIn(frame)) under.add(cardId);
    }
    this.hideCards(under);
  }

  /** Hide, now, every shown body named in `under`, at the rect it had, and lid it ([D211]: no layout). */
  private hideCards(under: ReadonlySet<string>): void {
    const last = this.poster.lastPosted;
    const container = this.container;
    if (last === null || container === null) return;
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
   * A settle is about to move `input.frames`: plan the bodies under them to
   * move with the chrome, post the plan, and hide only the bodies the
   * planner refuses, as {@link hideUnder} hides every one.
   *
   * The planned bodies' landing rects are adopted as posted — the host
   * reaches them on its own — so the land's measurement, which reads the
   * same rects, posts nothing and nothing snaps. No layout is read: the
   * placement and the panes' boxes are the last measurement's ([D211]).
   */
  runPlan(input: RunPlanInput): void {
    const last = this.poster.lastPosted;
    if (last === null || this.container === null) return;
    this.planRuns += 1;
    const frames: CarriedFrame[] = [];
    const bodiesInFrame = new Map<string, string[]>();
    const insets = new Map<string, Insets>();
    const landingInsets = new Map<string, Insets>();
    const unplannable = new Set<string>();
    input.frames.forEach((f, i) => {
      const cardIds = bodiesIn(f.frame);
      if (cardIds.length === 0) return;
      const box = this.paneBoxes.get(f.frame);
      const first = f.first ?? (box === undefined ? null : { x: box.x, y: box.y, width: box.width, height: box.height });
      if (first === null) {
        for (const cardId of cardIds) unplannable.add(cardId);
        return;
      }
      const paneId = `frame-${i}`;
      const lastRect = "dx" in f.last ? { ...first, x: first.x + f.last.dx } : f.last;
      frames.push({ paneId, first, last: lastRect, beats: f.beats });
      bodiesInFrame.set(paneId, cardIds);
      if (box === undefined) return;
      // A rail's border is on its inner edge, so a rail carried to the other
      // edge lands with its content box mirrored inside its frame. The
      // attribute is the commit's, read with no layout ([D211]).
      const mirrored = railSideFlipped(box.railSide ?? null, f.frame.getAttribute("data-rail-side"));
      for (const cardId of cardIds) {
        const b = this.exactRects.get(cardId) ?? last.bodies.find((p) => p.cardId === cardId);
        if (b === undefined) continue;
        const measured = {
          top: b.y - box.y,
          left: b.x - box.x,
          right: box.x + box.width - (b.x + b.width),
          bottom: box.y + box.height - (b.y + b.height),
        };
        insets.set(cardId, measured);
        if (mirrored) landingInsets.set(cardId, mirrorInsets(measured));
      }
    });
    const out = planBodyBeats({
      frames,
      placement: last,
      insets,
      landingInsets,
      bodiesInFrame,
      stillShown: (cardId) => {
        const facts = shownFactsOf(this.deck, cardId);
        return facts !== null && bodyVisible(facts);
      },
      factor: input.factor,
      allowCrossing: input.allowCrossing === true,
    });
    let planId: number | null = null;
    if (out.plan.length > 0) {
      planId = ++this.planSerial;
      const plan: BeatPlan = { planId, startWallMs: shellWallMs(input.startTime), bodies: out.plan };
      postToHost("beatPlan", plan);
      for (const b of out.plan) {
        deckTrace.record({
          kind: "body-beat",
          cardId: b.cardId,
          planId,
          beats: b.beats.length,
          startWallMs: plan.startWallMs,
          spanMs: Math.max(0, ...b.beats.map((beat) => beat.delayMs + beat.durationMs)),
          landed: null,
          lateMs: null,
        });
      }
      const landings = new Map(out.plan.map((b) => [b.cardId, b.landing]));
      for (const b of out.plan) this.inFlight.set(b.cardId, { planId, landing: b.landing });
      this.poster.adopt({
        radius: last.radius,
        bodies: last.bodies.map((b) => {
          const r = landings.get(b.cardId);
          return r === undefined ? b : { ...b, x: r.x, y: r.y, width: r.width, height: r.height };
        }),
      });
    }
    this.lastPlan = {
      planId,
      planned: out.plan.map((b) => b.cardId),
      landings: Object.fromEntries(out.plan.map((b) => [b.cardId, b.landing])),
      refused: [...out.refused, ...unplannable],
      reasons: out.reasons,
      landed: [],
      cancelled: [],
    };
    const refused = new Set([...out.refused, ...unplannable]);
    this.hideCards(refused);
    this.cutMoving(input, out.plan, last, refused);
  }

  /**
   * Cut every back pane the plan moves geometry around: a pane behind a
   * planned body whose rect meets it at any sample, or a pane that moves
   * under a body standing still. Each gets a `clip-path` beat on the plan's
   * start, keyed to the samples of the beat that moves the geometry, so the
   * hole rides with the body as the host carries it ([B04]); where two front
   * bodies overlap inside one pane, even-odd would close what both cover,
   * and the pane wears the swept union for the motion's length instead.
   */
  private cutMoving(input: RunPlanInput, plan: readonly BodyBeats[], last: PlaceBodies, refused: ReadonlySet<string>): void {
    this.cancelCuts();
    this.lastCuts = {};
    const timing = getTugTiming();
    const planned = new Map(plan.map((b) => [b.cardId, b]));
    // Every moving frame's own walk, whether or not it holds a body.
    const own = new Map<HTMLElement, BodyBeat[]>();
    input.frames.forEach((f, i) => {
      const box = this.paneBoxes.get(f.frame);
      const first = f.first ?? (box === undefined ? null : { x: box.x, y: box.y, width: box.width, height: box.height });
      if (first === null) return;
      const lastRect = "dx" in f.last ? { ...first, x: first.x + f.last.dx } : f.last;
      const beats = frameRectBeats({ paneId: `frame-${i}`, first, last: lastRect, beats: f.beats }, input.factor);
      if (beats !== null) own.set(f.frame, beats);
    });
    // Where the bodies stand when the plan lands: the planned at their
    // landings, the rest where they are, the refused hidden.
    const landed: PlaceBodies = {
      radius: last.radius,
      bodies: last.bodies.map((b) => {
        const p = planned.get(b.cardId);
        if (p !== undefined) return { ...b, ...p.landing };
        return refused.has(b.cardId) ? { ...b, visible: false } : b;
      }),
    };
    for (const [pane, box] of this.paneBoxes) {
      if (!pane.isConnected) continue;
      const fronts = last.bodies.filter((b) => b.visible && b.z > box.z && !refused.has(b.cardId));
      const moving: CutFront[] = fronts.map((b) => planned.get(b.cardId) ?? { x: b.x, y: b.y, width: b.width, height: b.height });
      const paneBeats = own.get(pane);
      const window = cutWindow([...(paneBeats ?? []), ...moving.flatMap((f) => ("beats" in f ? f.beats : []))], input.periodMs);
      if (window === null) continue;
      // A period's reach either side: the cut is the main thread's, the body the compositor's.
      const keyframes = paneCutKeyframes({ box, ...(paneBeats !== undefined ? { beats: paneBeats } : {}) }, moving, window, input.periodMs);
      if (keyframes === null) continue;
      const name = pane.dataset.paneId ?? `pane-${box.z}`;
      if (keyframes === "union") {
        // The fronts' First and Last in the pane's own frame, which moves.
        const end = paneBeats?.[paneBeats.length - 1]?.to;
        const dx = end === undefined ? 0 : end.x - box.x;
        const dy = end === undefined ? 0 : end.y - box.y;
        const union = sweptUnionCut(
          box,
          moving.map((f) => {
            if (!("beats" in f)) return { first: f, last: { ...f, x: f.x - dx, y: f.y - dy } };
            const first = f.beats.length > 0 ? f.beats[0].from : f.landing;
            return { first, last: { ...f.landing, x: f.landing.x - dx, y: f.landing.y - dy } };
          }),
        );
        pane.style.clipPath = union;
        if (union === "") this.paneClips.delete(pane);
        else this.paneClips.set(pane, union);
        this.lastCuts[name] = "union";
        continue;
      }
      if (!(timing > 0)) continue;
      const end = paneBeats?.[paneBeats.length - 1]?.to;
      const landBox: PaneBox = end === undefined ? box : { ...box, x: end.x, y: end.y, width: end.width, height: end.height };
      const landClip = paneClipPath(paneHoles(landed, landBox));
      // `planBeat` scales its own times; the plan's are scaled already.
      const beat = input.planBeat({
        recipe: "body-cut",
        targets: [{ el: pane, keyframes: keyframes.map((k) => ({ offset: k.offset, clipPath: k.clipPath })) }],
        declares: ["clip-path"],
        durationMs: window.durationMs / timing,
        delayMs: window.delayMs / timing,
        easing: "linear",
        fill: "both",
        startTime: input.startTime,
        key: "body-cut",
        ...(input.record !== undefined ? { record: input.record } : {}),
      });
      this.cutBeats.set(pane, { beat, landClip });
      this.lastCuts[name] = "moving";
      void beat.anims[0].finished.then(
        () => {
          // The animator committed the last keyframe; the pane lands on its static cut.
          if (this.cutBeats.get(pane)?.beat !== beat) return;
          this.cutBeats.delete(pane);
          pane.style.clipPath = landClip;
          if (landClip === "") this.paneClips.delete(pane);
          else this.paneClips.set(pane, landClip);
        },
        () => {
          /* cancelled: whoever cancelled it writes the static cut */
        },
      );
    }
  }

  /** Stop every moving cut where it stands; the caller writes the static cut. */
  private cancelCuts(): void {
    for (const { beat } of this.cutBeats.values()) {
      for (const anim of beat.anims) anim.raw.cancel();
    }
    this.cutBeats.clear();
  }

  /** The host ran `cardId`'s beats of plan `planId` to their end. */
  landed(cardId: string, planId: number, lateMs: number | null): void {
    this.traceAnswer(cardId, planId, true, lateMs);
    if (this.inFlight.get(cardId)?.planId === planId) this.inFlight.delete(cardId);
    if (this.lastPlan?.planId === planId) this.lastPlan.landed.push({ cardId, lateMs });
  }

  /** A placement or a newer plan took `cardId` before plan `planId` landed it. */
  beatsCancelled(cardId: string, planId: number): void {
    this.traceAnswer(cardId, planId, false, null);
    if (this.inFlight.get(cardId)?.planId === planId) this.inFlight.delete(cardId);
    if (this.lastPlan?.planId === planId) this.lastPlan.cancelled.push(cardId);
  }

  /** The `body-beat` row that closes the one `runPlan` wrote for `cardId`. */
  private traceAnswer(cardId: string, planId: number, landed: boolean, lateMs: number | null): void {
    deckTrace.record({
      kind: "body-beat",
      cardId,
      planId,
      beats: 0,
      startWallMs: 0,
      spanMs: 0,
      landed,
      lateMs,
    });
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

  /**
   * The host's floor is on screen: the page's own canvas stands down. Until
   * now the page painted it, so no frame between showed anything else.
   */
  floorShown(sinceRevealMs: number | null): void {
    if (this.container === null) return;
    this.floorReport ??= { sinceRevealMs };
    document.documentElement.setAttribute(BODY_HOST_ATTRIBUTE, "");
  }

  /**
   * Post `floorGrid` — the canvas and grid colours, the deck root's zoom and
   * its viewport origin — when it says something new. Reads the tokens and
   * the deck root's rect, so never inside a settle's set-up: there it waits
   * for the set-up's end ([D211]).
   */
  private postFloor(): void {
    if (this.container === null) return;
    if (deferToSetUp(this.postFloorKey, () => this.postFloor())) return;
    const root = deckRootElement();
    // The theme files declare their tokens on `body`.
    const styles = getComputedStyle(document.body);
    const canvas = resolveColor(styles.getPropertyValue(CANVAS_TOKEN));
    const grid = resolveColor(styles.getPropertyValue(GRID_TOKEN));
    if (canvas === null || grid === null) return;
    const origin = root.getBoundingClientRect();
    const next: FloorGrid = {
      canvas,
      grid,
      cellPx: GRID_CELL_PX,
      linePx: GRID_LINE_PX,
      zoom: pageZoomStore.getFactor(),
      originX: origin.x,
      originY: origin.y,
    };
    if (sameFloorGrid(this.floorGrid, next)) return;
    this.floorGrid = next;
    postToHost("floorGrid", next);
  }

  /** The key {@link postFloor} defers under, apart from the measurement's. */
  private readonly postFloorKey = {};

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
        railSide: pane.getAttribute("data-rail-side"),
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
    this.cancelCuts();
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
    // The floor is the host's: post its grid now, and again on a theme or
    // zoom change. The page's own canvas stands down on `floorShown`.
    this.floorGrid = null;
    this.postFloor();
    this.resizes = new ResizeObserver(this.schedule);
    container.addEventListener(IMPOSER_SETTLE_END, this.measure);
    window.addEventListener("resize", this.schedule);
    const releaseZoom = pageZoomStore.subscribe(this.schedule);
    const releaseBodies = bodyCardsStore.subscribe(this.schedule);
    const releaseTheme = subscribeOnScreenTheme(this.schedule);
    return () => {
      container.removeEventListener(IMPOSER_SETTLE_END, this.measure);
      window.removeEventListener("resize", this.schedule);
      releaseZoom();
      releaseBodies();
      releaseTheme();
      this.resizes?.disconnect();
      this.resizes = null;
      this.observed.clear();
      this.cancelScheduled?.();
      this.cancelScheduled = null;
      this.cancelHidePost?.();
      this.cancelHidePost = null;
      this.hiding.clear();
      this.container = null;
      this.floorGrid = null;
      this.floorReport = null;
      this.cancelCuts();
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
      floorGrid: this.floorGrid,
      floorShown: this.floorReport,
      lastPlan: this.lastPlan,
      lastCuts: this.lastCuts,
      cutsRunning: this.cutBeats.size,
      planRuns: this.planRuns,
      inFlight: [...this.inFlight.keys()],
    };
  }
}

/** The placer's own account of itself, for `tugdeck.diag`. */
export interface BodyPlacementDiag {
  readonly lastPosted: PlaceBodies | null;
  readonly lastSkip: string | null;
  readonly measures: number;
  /** The last `floorGrid` posted, or null before one. */
  readonly floorGrid: FloorGrid | null;
  /** The host's first `floorShown`, or null before it came. */
  readonly floorShown: FloorShownReport | null;
  /** The last beat plan the placer ran, or null before one. */
  readonly lastPlan: BeatPlanReport | null;
  /** How many settles have handed the placer frames to plan. */
  readonly planRuns: number;
  /** The bodies a plan is carrying now. */
  readonly inFlight: readonly string[];
  /** How the last plan cut each back pane it touched, by `data-pane-id`. */
  readonly lastCuts: Readonly<Record<string, "moving" | "union">>;
  /** Moving cuts still running. */
  readonly cutsRunning: number;
}

/** What one {@link BodyPlacer.runPlan} decided and what the host has said of it. */
export interface BeatPlanReport {
  /** Null when nothing was planned and nothing posted. */
  readonly planId: number | null;
  readonly planned: readonly string[];
  /** Where the plan lands each planned body, viewport px: the rect the host carries it to. */
  readonly landings: Readonly<Record<string, Rect>>;
  readonly refused: readonly string[];
  readonly reasons: Readonly<Record<string, string>>;
  readonly landed: { cardId: string; lateMs: number | null }[];
  readonly cancelled: string[];
}

/** One frame a settle hands {@link bodyRunPlan}. */
export interface RunPlanFrame {
  readonly frame: HTMLElement;
  /** Its visual rect before the settle, viewport px; null when the settle measured none, and the placer's last box stands in. */
  readonly first: Rect | null;
  /** Its rect at rest after the settle, viewport px, or how far it travels from `first` across the page. */
  readonly last: Rect | { readonly dx: number };
  readonly beats: readonly FrameBeat[];
}

/** What a settle hands {@link bodyRunPlan}. */
export interface RunPlanInput {
  readonly frames: readonly RunPlanFrame[];
  /** The settle's start on the document timeline (ms): every chrome beat's `startTime`. */
  readonly startTime: number;
  /** The page-zoom factor the frames' terms scale by. */
  readonly factor: number;
  /** The display period (ms) a cut spanning beats of different windows is sampled at. */
  readonly periodMs: number;
  /** Where a moving cut's beat row goes: the settle's own beat rows. */
  readonly record?: (row: BeatRow) => void;
  /**
   * Plans a moving cut's beat: the animator's `planBeat`, handed in because
   * the animator is the component layer and `lib` sits below it.
   */
  readonly planBeat: (options: BeatOptions) => Beat;
  /** Whether a body whose box changes size is carried as a crossing; refused when false. */
  readonly allowCrossing?: boolean;
}

/** Whether a rail measured standing on `measured` stands, at the plan, on the other edge. */
export function railSideFlipped(measured: string | null, now: string | null): boolean {
  return measured !== null && now !== null && measured !== now;
}

/** `insets` mirrored left for right: a rail's content box once it stands on the other edge. */
export function mirrorInsets(insets: Insets): Insets {
  return { top: insets.top, bottom: insets.bottom, left: insets.right, right: insets.left };
}

/** The body cards whose placeholder stands in `frame`. Reads no layout. */
function bodiesIn(frame: HTMLElement): string[] {
  const ids: string[] = [];
  for (const el of frame.querySelectorAll<HTMLElement>("[data-body-placeholder][data-card-id]")) {
    if (el.dataset.cardId !== undefined) ids.push(el.dataset.cardId);
  }
  return ids;
}

/**
 * What the host's first `floorShown` said: how long after the window's
 * reveal began its floor showed — never negative, since a floor shown
 * before the reveal would have covered the splash — or null when the
 * floor was already up (a reloaded shell).
 */
export interface FloorShownReport {
  readonly sinceRevealMs: number | null;
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

/** The host's floor is on screen: the installed placer stands the page's canvas down. */
export function floorShown(sinceRevealMs: number | null): void {
  installed?.floorShown(sinceRevealMs);
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
 * A gesture that moved `frame` without a commit has ended: the installed
 * placer re-posts it and re-measures the deck. A no-op when the host makes
 * no bodies.
 */
export function bodyFrameLanded(frame: HTMLElement): void {
  installed?.land(frame);
}

/**
 * A settle is about to move `frames`: the installed placer hides every body
 * under them until the land. A no-op when the host makes no bodies.
 */
export function bodyHideUnder(frames: readonly HTMLElement[]): void {
  installed?.hideUnder(frames);
}

/**
 * A settle is about to move `input.frames`: the installed placer plans the
 * bodies under them to move with the chrome and hides only those it cannot
 * carry. A no-op when the host makes no bodies.
 */
export function bodyRunPlan(input: RunPlanInput): void {
  installed?.runPlan(input);
}

/** The host ran a body's planned beats to their end. */
export function bodyBeatsLanded(cardId: string, planId: number, lateMs: number | null): void {
  installed?.landed(cardId, planId, lateMs);
}

/** The host gave up a body's planned beats before they landed. */
export function bodyBeatsCancelled(cardId: string, planId: number): void {
  installed?.beatsCancelled(cardId, planId);
}
