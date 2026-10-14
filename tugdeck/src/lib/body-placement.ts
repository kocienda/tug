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
      p.visible !== q.visible
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
    this.poster.offer(measurePlacements(this.deck, container));
    this.observePlaceholders(container);
  };

  /**
   * Start the standing wakes under `container` — the settle's land, a window
   * resize, a zoom change, a body's state, a placeholder's size — and return
   * the uninstall. A no-op when the host makes no bodies.
   */
  install(container: HTMLElement): () => void {
    if (!hostCapabilitiesStore.get().bodyViews) return () => {};
    this.container = container;
    installed = this;
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

/** The installed placer's account, or null when none is installed. Read-only. */
export function bodyPlacementDiag(): BodyPlacementDiag | null {
  return installed?.diag() ?? null;
}
