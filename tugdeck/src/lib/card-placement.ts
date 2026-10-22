/**
 * Where each card's view stands, and whether it shows — measured in the
 * shell and posted to the host.
 *
 * A card stands in the shell as a paintless stand-in frame (`TugPane`), and
 * the host stands the card's view over it, the frame outset by the apron. So
 * the shell reads each stand-in's `getBoundingClientRect()` — viewport CSS
 * px, which are the shell view's points because the shell's `pageZoom` stays
 * 1.0 — and posts `placeCards` with the whole set. Not `layoutRectOf`'s
 * layout px: the card applies View › Zoom to itself, so the host's frame is
 * the viewport rect at every zoom, grown outward to whole points
 * (`wholePoints`): a card's page lays out in whole points, and a fraction of
 * a view past it is not page at all.
 *
 * A card shows when its page has said it is painted — its first chrome frame
 * has gone to the compositor — and it is shown: the active card of its pane,
 * not arriving, in the shown workspace. A fold does not hide it: every card
 * draws its folded form in its own page — its kind's own (the Session card's
 * Z2 band, `ownsFoldedForm`) or the bar its chrome draws, the generic folded
 * form — and stays shown at the folded rect. Everything else posts
 * `visible: false`, and the host hides it.
 *
 * **The cards stand over the shell.** The shell's page lies beneath every
 * card and paints the canvas and its grid itself; a card's view is opaque
 * over its pane, so nothing the shell paints shows through a card and
 * nothing is cut for a card to show through. A card that stops showing is
 * hidden on the far side of the paint of the commit that hid it, so the
 * shell's frame and the host's hide land together.
 *
 * **When it measures.** After every deck commit, from a beacon at the deck
 * root, and on what moves a placeholder without one — a window resize, a zoom
 * change, a body becoming ready, a placeholder resizing — coalesced to one
 * measurement on the far side of the next paint. Never inside a settle: while
 * a set-up is pending a measurement is a reader outside the Last pass, which
 * pays a whole-document layout of its own, and while the settle runs the rects
 * are the tween's, not the landing's. So it waits, and measures once when the
 * settle ends, and the cards snap at the land. What does not wait is a card
 * that stopped showing — its pane closed, parked, or arriving — which is
 * hidden at the commit that started the settle, with the rect it had.
 *
 * **What moves a stand-in without a commit.** A seam drag, a flow-strip
 * preview, an autoscroll, a flow-step tween, a rail-width draft, a keep-slot
 * resize's neighbours and a window resize all move stand-ins by writing their
 * inline style or the arrangement's custom properties, and none of them
 * commits until the hand lets go. The placer watches those writes — every
 * `style` write under the canvas ({@link watchArrangementWrites}) — and each
 * wakes the one coalesced measurement, which posts `placeCards`. Nothing
 * follows a card per frame: two cards may disagree by a frame, and no card
 * can tear ([B06]).
 *
 * A set unchanged since the last post posts nothing.
 *
 * **A beat carrying a frame.** A settle's beats tween a stand-in from where
 * it stood to where the commit put it, and the placer measures nothing until
 * the land — so for the beat's length the card would stand still at its
 * First rect while its stand-in slid away from it, and jump at the land. So
 * the host carries it: in the pass that plans the beats, before their first
 * frame paints, the settle engine hands the placer the frames its beats will
 * move (`runCardPlan`), and the placer plans each card under them and posts
 * the host a `cardPlan` (`lib/card-plan.ts`, the one producer) — each beat's
 * rects, curve and delay from a start both sides know. The host runs the
 * card's container as Core Animation on it, and the planned landing is
 * adopted as posted, **named by the plan's id**, so the land's measurement
 * is not news and the host can tell the landing from a placement that takes
 * the card elsewhere without comparing rects ([B11]). A card the planner
 * refuses stands where it is until the land's measurement places it: a
 * whole card is never hidden for a motion, since a hidden card is a hole.
 *
 * **A dropped card lands by plan.** The host carries a card's view under the
 * hand, and at the release the view stands wherever the hand let go while
 * the commit puts its stand-in in its place. The gesture tells the placer
 * the released rect ({@link landCard}) before the commit, and the card lands
 * from there as a one-card plan on the settle's move curve: posted by the
 * commit's own settle when its Last pass carries the frame, else by the
 * measurement after it — so a drop home, a refusal, and a drop that moved
 * nothing else land the same way. Every landing has a horizon ([L33]): the
 * plan's length plus a guard, past which the shell lands the card itself by
 * posting the landing with no plan named, which takes it from its beats.
 *
 * Laws: [L06] (the rects are appearance, posted to the host and never React
 * state), [L03] (measured in a layout effect), [L22] (direct observation of
 * the stores), [D211] (no reader in a settle's set-up), [D212] (a parked
 * workspace's bodies hide).
 *
 * @module lib/card-placement
 */

import type { IDeckManagerStore } from "../deck-manager-store";
import { scheduleAfterPaint, type CancelAfterPaint } from "./after-paint";
import { bodyCardsStore } from "./body-cards-store";
import { hostCapabilitiesStore } from "./body-handoff";
import { postToHost } from "../host/channel";
import { placeCardsToHost } from "../host/declarations/geometry";
import { cardArrivingOf, railMembersOf } from "../deck-store-selectors";
import {
  RAIL_TRAVEL_ATTR,
  parseRailTravel,
  type RailTravel,
  type RailTravelBand,
  type RailWidthLimits,
  type ReadFlowTerms,
} from "./rail-width";
import type { SidebarSide } from "./layout-imposer";
import { subscribeOnScreenTheme } from "../contexts/theme-provider";
import { pageZoomStore } from "./page-zoom-store";
import { deferToSetUp, isSetUpPending } from "./set-up-apply";
import { IMPOSER_SETTLE_END } from "./settle-notice";
import { shellWallMs, wholePoints, type CarriedFrame, type Rect } from "./card-plan";
import {
  installCardPlanRunner,
  landingFrame,
  planCards,
  postCardPlan,
  viewOf,
  type CardPlan,
  type CardPlanOutput,
  type LandingCurve,
  type RunPlanInput,
} from "./card-plan";
import { motionKeyframes } from "./imposer-motion";
import { IMPOSITION_SETTLE_MS } from "./layout-imposer";
import { impositionGapPx } from "./layout-imposer";
import { getTugTiming } from "./scale-timing";
import { deckTrace } from "../deck-trace";
import { CARD_APRON_PX } from "./chrome-placement";
import { CANVAS_BACKGROUND_ATTRIBUTE } from "./pane-frame-selectors";
import { paneStandingOf } from "./pane-chrome-projection";
import { overlaySurfaceBook } from "./overlay-surfaces";

// ---------------------------------------------------------------------------
// The rule
// ---------------------------------------------------------------------------

/** What decides whether a body shows. */
export interface BodyShownFacts {
  /** The body has reported painted: its first frame of content is composited. */
  readonly painted: boolean;
  /** The card is its pane's active card. */
  readonly active: boolean;
  readonly arriving: boolean;
  /** The card's workspace is the shown one. */
  readonly layerShown: boolean;
}

/**
 * Whether a body with these facts is placed visible. A fold does not hide it:
 * every card draws its folded form in its own page.
 */
export function bodyVisible(facts: BodyShownFacts): boolean {
  return facts.painted && facts.active && !facts.arriving && facts.layerShown;
}

/** One card's view in a placement: its viewport rect and whether it shows. */
export interface BodyPlacement {
  readonly cardId: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly visible: boolean;
  /**
   * The shell's own controls standing over the view — the place seams — as
   * viewport rects grown to whole points ({@link shellControlRects}). A
   * card's grips are its own page's, but a point on a seam is the shell's,
   * so the host keeps these for the shell.
   */
  readonly shell: readonly Rect[];
  /**
   * The pane's stacking order, its computed `z-index`: the host stacks the
   * views in the same order, so where two panes overlap the card in front
   * is in front.
   */
  readonly z: number;
  /** An inactive card of a pane: placed at the pane, hidden by opacity so it keeps painting. */
  readonly sibling?: true;
  /**
   * The card's pane, inset within its view: the apron plus whatever the
   * view's growth to whole points added on each side. The card's page lays
   * its pane out at exactly these, so it stands where the stand-in does to
   * the sub-point, whatever fraction of a point the stand-in stands on.
   */
  readonly insets: CardInsets;
  /**
   * The plan whose landing this rect is, while the host is carrying the
   * card there. The host leaves a plan's beats running under a placement
   * that names the plan, and takes the card from them under one that does
   * not — a placement elsewhere, or the rest after the plan — so the two
   * sides agree by id, never by comparing rects ([B11]).
   */
  readonly planId?: number;
}

/** A card's pane within its view, points per side. */
export interface CardInsets {
  readonly top: number;
  readonly left: number;
  readonly bottom: number;
  readonly right: number;
}

/** Every card's view, as the placer last measured or adopted it. */
export interface Placement {
  readonly bodies: readonly BodyPlacement[];
}

/**
 * One card in `placeCards`: its PANE rect, its view (the pane outset by the
 * apron, grown to whole points) and the pane's insets within it, whether it
 * shows, and what the host carries it in its hand by.
 */
export interface CardPlacementEntry {
  readonly cardId: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly view: Rect;
  readonly insets: CardInsets;
  /** The shell's controls over the view ({@link BodyPlacement.shell}). */
  readonly shell: readonly Rect[];
  readonly visible: boolean;
  readonly sibling?: true;
  readonly z: number;
  /** The edges the arrangement lets the hand resize the pane from. */
  readonly grips: readonly string[];
  /** The pane holds no slot, pin or bullseye: a drag may snap it. */
  readonly free: boolean;
  /** The pane's resize floor, layout px. */
  readonly min: { readonly width: number; readonly height: number };
  /**
   * The tallest a resize may make the pane, layout px, where the arrangement
   * holds a ceiling the canvas does not: a card holding a height in its slot
   * stands at the top of its run, so its bottom edge stops at the run's end.
   */
  readonly maxHeight?: number;
  /** The plan whose landing this view is ({@link BodyPlacement.planId}). */
  readonly planId?: number;
  /** The card's pane is a pinned rail member: which side, its order there, and how its content follows a width drag. */
  readonly rail?: RailMembership;
  /**
   * An imposed content card's travel under a rail width change
   * (`RAIL_TRAVEL_ATTR`), so the host can move it with the rail; absent for
   * a rail member and for a free pane.
   */
  readonly railTravel?: RailTravel;
}

/** A pinned rail member's place on its side. */
export interface RailMembership {
  readonly side: SidebarSide;
  /** The member's order on the side, top to bottom, from `railMembersOf`. */
  readonly index: number;
}

/** Each standing rail's width bounds, layout px; a side with no rail is absent. */
export interface RailLimitsBySide {
  readonly left?: RailWidthLimits;
  readonly right?: RailWidthLimits;
}

/**
 * The `placeCards` message body: every card, in the deck's reading order,
 * and the canvas they stand on. The host shows, hides, stacks and frames
 * each view from it, and hides a view it does not name.
 */
export interface PlaceCards {
  readonly apron: number;
  /** The canvas's viewport rect, which a drag clamps to; null when the shell shows none. */
  readonly canvas: Rect | null;
  /** The page zoom the canvas's layout is drawn at. */
  readonly zoom: number;
  /** The deck's live card gap, layout px: the air an Option-snap leaves
   *  between two adjacent card edges, so a hand-snapped pane lands on the
   *  imposer's rhythm. */
  readonly gap: number;
  readonly cards: readonly CardPlacementEntry[];
  /** Each standing rail's width bounds, layout px ({@link RailLimitsBySide}). */
  readonly rails: RailLimitsBySide;
  /** The band and the flow strip as this measurement read them: what a carried card's travel is a function of. */
  readonly band: RailTravelBand;
  /** The cards the host is holding while a rail width draft's hold stands
   *  ({@link holdCardsForHost}); absent otherwise. Their entries are the last
   *  ones posted before the hold, and the host skips every body this names. */
  readonly held?: readonly string[];
}

/** What a card's stand-in frame says of it, read at a measurement: the part of its entry no hide changes. */
type CardFrameFacts = Pick<CardPlacementEntry, "grips" | "free" | "min" | "maxHeight" | "rail" | "railTravel">;

/** The stand-in facts of every card in a placement, and the canvas, as one measurement read them. */
export interface CardFacts {
  readonly canvas: Rect | null;
  readonly zoom: number;
  readonly gap: number;
  readonly byCard: ReadonlyMap<string, CardFrameFacts>;
  readonly rails: RailLimitsBySide;
  readonly band: RailTravelBand;
}

/**
 * The facts the stand-in frames of `placement`'s cards carry (`data-grips`,
 * `data-free`, `data-min-*`, the rail attributes, written by `TugPane`), the
 * canvas's rect, and the rails' bounds and the band from the deck.
 * `ceilingOf` answers a pane's {@link CardPlacementEntry.maxHeight}, by pane
 * id; `readFlow` the flow strip's terms as the canvas last arranged them.
 */
export function readCardFacts(
  placement: Placement,
  root: ParentNode,
  ceilingOf: (paneId: string) => number | null,
  deck: IDeckManagerStore,
  readFlow: ReadFlowTerms,
): CardFacts {
  const state = deck.getSnapshot();
  const memberIndex = new Map<string, { side: SidebarSide; index: number }>();
  const rails: { left?: RailWidthLimits; right?: RailWidthLimits } = {};
  for (const side of ["left", "right"] as const) {
    const members = railMembersOf(state, side);
    members.forEach((m, index) => memberIndex.set(m.paneId, { side, index }));
    const limits = members.length > 0 ? deck.railWidthLimits(side) : null;
    if (limits !== null) rails[side] = { min: limits.min, max: limits.max };
  }
  const byCard = new Map<string, CardFrameFacts>();
  for (const b of placement.bodies) {
    const frame = root
      .querySelector(`[data-body-placeholder][data-card-id="${CSS.escape(b.cardId)}"]`)
      ?.closest<HTMLElement>(".tug-pane");
    const paneId = frame?.dataset.paneId;
    const ceiling = paneId === undefined ? null : ceilingOf(paneId);
    // A member is a pane the deck seats on a side and whose frame says so; a
    // released rail has rail chrome and no side, and is a free pane.
    const member = paneId === undefined ? undefined : memberIndex.get(paneId);
    const rail: RailMembership | undefined =
      member !== undefined && frame?.dataset.railSide === member.side
        ? member
        : undefined;
    const railTravel = rail === undefined ? parseRailTravel(frame?.getAttribute(RAIL_TRAVEL_ATTR) ?? null) : null;
    byCard.set(b.cardId, {
      grips: (frame?.dataset.grips ?? "").split(" ").filter((g) => g.length > 0),
      free: frame?.hasAttribute("data-free") ?? false,
      min: {
        width: Number(frame?.dataset.minWidth ?? 0) || 0,
        height: Number(frame?.dataset.minHeight ?? 0) || 0,
      },
      ...(ceiling !== null ? { maxHeight: ceiling } : {}),
      ...(rail !== undefined ? { rail } : {}),
      ...(railTravel !== null ? { railTravel } : {}),
    });
  }
  const canvasEl = document.querySelector<HTMLElement>(`[${CANVAS_BACKGROUND_ATTRIBUTE}]`);
  const c = canvasEl?.getBoundingClientRect();
  return {
    canvas: c === undefined ? null : { x: c.x, y: c.y, width: c.width, height: c.height },
    zoom: pageZoomStore.getFactor(),
    gap: impositionGapPx(),
    byCard,
    rails,
    band: { band: deck.getBandSpan(), flow: readFlow() },
  };
}

/**
 * The `placeCards` a placement and the facts its last measurement read say.
 * Pure: a hide or a plan's landing changes the placement, never the facts,
 * so it is composed again here with no reading of its own ([D211]).
 */
export function placeCardsOf(placement: Placement, facts: CardFacts): PlaceCards {
  const none: CardFrameFacts = { grips: [], free: false, min: { width: 0, height: 0 } };
  return {
    apron: CARD_APRON_PX,
    canvas: facts.canvas,
    zoom: facts.zoom,
    gap: facts.gap,
    rails: facts.rails,
    band: facts.band,
    cards: placement.bodies.map((b) => {
      const f = facts.byCard.get(b.cardId) ?? none;
      return {
        cardId: b.cardId,
        ...paneRectOf(b),
        view: { x: b.x, y: b.y, width: b.width, height: b.height },
        insets: b.insets,
        shell: b.shell,
        visible: b.visible,
        ...(b.sibling === true ? { sibling: true as const } : {}),
        z: b.z,
        grips: f.grips,
        free: f.free,
        min: f.min,
        ...(f.maxHeight !== undefined ? { maxHeight: f.maxHeight } : {}),
        ...(b.planId !== undefined ? { planId: b.planId } : {}),
        ...(f.rail !== undefined ? { rail: f.rail } : {}),
        ...(f.railTravel !== undefined ? { railTravel: f.railTravel } : {}),
      };
    }),
  };
}

/** Whether two placements say the same thing to the host. */
export function samePlacement(a: Placement | null, b: Placement): boolean {
  if (a === null) return false;
  if (a.bodies.length !== b.bodies.length) return false;
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
      p.z !== q.z ||
      p.sibling !== q.sibling ||
      p.planId !== q.planId ||
      !sameInsets(p.insets, q.insets) ||
      !sameRects(p.shell, q.shell)
    ) {
      return false;
    }
  }
  return true;
}

function sameInsets(a: CardInsets, b: CardInsets): boolean {
  return a.top === b.top && a.left === b.left && a.bottom === b.bottom && a.right === b.right;
}

/** `pane`'s insets within `view`, to the thousandth of a point. */
function insetsOf(pane: Rect, view: Rect): CardInsets {
  const r = (n: number): number => Math.round(n * 1000) / 1000;
  return {
    top: r(pane.y - view.y),
    left: r(pane.x - view.x),
    bottom: r(view.y + view.height - (pane.y + pane.height)),
    right: r(view.x + view.width - (pane.x + pane.width)),
  };
}

/** A card's pane rect: its view rect, the apron taken back off. */
function paneRectOf(view: Rect): Rect {
  return { x: view.x + CARD_APRON_PX, y: view.y + CARD_APRON_PX, width: view.width - 2 * CARD_APRON_PX, height: view.height - 2 * CARD_APRON_PX };
}

function sameRects(a: readonly Rect[], b: readonly Rect[]): boolean {
  return a.length === b.length && a.every((r, i) => r.x === b[i].x && r.y === b[i].y && r.width === b[i].width && r.height === b[i].height);
}

/**
 * The shell's own controls standing over a card's view — the place seams,
 * which stand between the members they divide and over their edges — as
 * viewport rects grown to whole points. A card's grips are its own page's,
 * but a point on a seam is the shell's, so its placement carries these as
 * the points the host keeps for the shell.
 */
export function shellControlRects(view: Rect): Rect[] {
  const out: Rect[] = [];
  for (const seam of document.querySelectorAll(".tug-place-seam")) {
    const r = wholePoints(seam.getBoundingClientRect());
    if (r.width <= 0 || r.height <= 0) continue;
    const meets = r.x < view.x + view.width && view.x < r.x + r.width && r.y < view.y + view.height && view.y < r.y + r.height;
    if (meets) out.push(r);
  }
  return out;
}

/**
 * Posts a placement only when it differs from the last one posted. An empty
 * set before anything was posted is not news either: a deck with no cards
 * says nothing to the host.
 */
export class PlacementPoster {
  private last: Placement | null = null;

  constructor(private readonly post: (placement: Placement) => void) {}

  /** Whether anything has been posted yet. */
  get posted(): boolean {
    return this.last !== null;
  }

  /** The last placement posted, or null. */
  get lastPosted(): Placement | null {
    return this.last;
  }

  /** Post `placement` if it is news; returns whether it was. */
  offer(placement: Placement): boolean {
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
  adopt(placement: Placement): void {
    this.last = placement;
  }

  /** Forget what was posted, so the next offer is news whatever it says. */
  forget(): void {
    this.last = null;
  }
}

/**
 * The `placeCards` the placer has posted, and the cards the host holds.
 *
 * While the host carries a rail's width drag it moves the members' and the
 * carried cards' views itself, and the shell's draft moves their stand-ins
 * to match. Those stand-ins are measured like any other, so a placement in
 * the drag would carry the preview's rects; the host would ignore them, but
 * every frame would post. So while a hold stands each held card's entry is
 * the last one posted before it, the message names the held cards, and a
 * placement that differs only in what the hand is moving is no news. The
 * release forgets what was posted, since the landing it is followed by reads
 * exactly what the preview last showed and must be posted all the same.
 */
export class PlaceCardsGate {
  private lastJson: string | null = null;
  private last: PlaceCards | null = null;
  private held: ReadonlySet<string> = new Set();

  /** What to post for `cards`, or null when it says nothing new. */
  offer(cards: PlaceCards): PlaceCards | null {
    if (cards.cards.length === 0 && this.lastJson === null) return null;
    const out = this.held.size === 0 ? cards : this.withHeld(cards);
    const json = JSON.stringify(out);
    if (json === this.lastJson) return null;
    this.lastJson = json;
    this.last = out;
    return out;
  }

  /** The host holds `cardIds` from now until {@link release}. */
  hold(cardIds: Iterable<string>): void {
    this.held = new Set(cardIds);
  }

  /** The last `placeCards` posted, or null before one and after a release. */
  get posted(): PlaceCards | null {
    return this.last;
  }

  /** Whether a hold stands. */
  get holding(): boolean {
    return this.held.size > 0;
  }

  /** The hold is over: the next offer posts every card where it stands. */
  release(): void {
    this.held = new Set();
    this.forget();
  }

  /** Forget what was posted. */
  forget(): void {
    this.lastJson = null;
    this.last = null;
  }

  private withHeld(cards: PlaceCards): PlaceCards {
    const before = new Map((this.last?.cards ?? []).map((c) => [c.cardId, c]));
    const held: string[] = [];
    const entries = cards.cards.map((c) => {
      if (!this.held.has(c.cardId)) return c;
      held.push(c.cardId);
      return before.get(c.cardId) ?? c;
    });
    return held.length === 0 ? cards : { ...cards, cards: entries, held };
  }
}

/**
 * Where a card's view stands, in viewport px before it is grown to whole
 * points: its stand-in frame outset by the apron. A card's inactive siblings
 * stand at the same rect, which their hidden placeholders cannot say.
 */
function measuredRectOf(frame: HTMLElement): Rect {
  const r = frame.getBoundingClientRect();
  return { x: r.x - CARD_APRON_PX, y: r.y - CARD_APRON_PX, width: r.width + 2 * CARD_APRON_PX, height: r.height + 2 * CARD_APRON_PX };
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

// ---------------------------------------------------------------------------
// The measurement
// ---------------------------------------------------------------------------

const SETTLING_ATTRIBUTE = "data-imposer-settling";

/**
 * How long past a landing plan's own length the shell waits for the host to
 * report before landing the card itself: a few frames, for a report that is
 * on its way, and no longer, because past it the card is standing short of
 * its pane ([L33]).
 */
const LANDING_GUARD_MS = 250;

/**
 * The facts that decide whether `cardId`'s body shows, read from the deck
 * and the body store alone — no DOM — or null when the card is in no pane.
 */
export function shownFactsOf(deck: IDeckManagerStore, cardId: string): BodyShownFacts | null {
  const state = deck.getSnapshot();
  const pane = state.panes.find((p) => p.cardIds.includes(cardId));
  if (pane === undefined) return null;
  const spaceId = deck.spaceOf(cardId);
  const activeSpaceId = deck.getSpacesSnapshot().activeSpaceId;
  return {
    // A card shows at its first chrome frame, its content lidded in its own
    // page until that has painted — and a revived card from the host's
    // `covered`, under the cover of its last frame the host stands until
    // then. A revived card with no cover waits for its paint like any other.
    painted:
      bodyCardsStore.stateOf(cardId) === "painted" ||
      bodyCardsStore.chromeShown(cardId) ||
      bodyCardsStore.revivedNow(cardId),
    active: pane.activeCardId === cardId,
    arriving: cardArrivingOf(state, cardId),
    layerShown: spaceId === null || spaceId === activeSpaceId,
  };
}

/**
 * Whether `cardId`'s body would be placed visible were it painted: its card
 * is its pane's active one, in the shown workspace, not arriving. An
 * evicted card the deck wants this way is asked for again.
 */
export function wantsBodyShown(deck: IDeckManagerStore, cardId: string): boolean {
  const facts = shownFactsOf(deck, cardId);
  return facts !== null && bodyVisible({ ...facts, painted: true });
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
 * Read every card's stand-in under `root` once, and decide each one's
 * visibility from the deck. The cards are posted in reading order
 * (`inReadingOrder`).
 */
export function measurePlacements(deck: IDeckManagerStore, root: ParentNode): Placement {
  const bodies: BodyPlacement[] = [];
  for (const el of root.querySelectorAll<HTMLElement>("[data-body-placeholder][data-card-id]")) {
    const cardId = el.dataset.cardId;
    if (cardId === undefined || !bodyCardsStore.has(cardId)) continue;
    const frame = el.closest<HTMLElement>(".tug-pane");
    if (frame === null) continue;
    const facts = shownFactsOf(deck, cardId);
    const measured = measuredRectOf(frame);
    const rect = wholePoints(measured);
    const z = parseInt(getComputedStyle(frame).zIndex, 10);
    const visible = facts !== null && bodyVisible(facts);
    bodies.push({
      cardId,
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      shell: shellControlRects(rect),
      // A card in no pane of the shown deck — a parked workspace's card —
      // is a view to hide.
      visible,
      z: Number.isFinite(z) ? z : 0,
      insets: insetsOf(paneRectOf(measured), rect),
      // An inactive card of a pane that would show were it the active one:
      // placed at the pane and kept painting, so a tab switch shows a page
      // that has already drawn its new chrome.
      ...(!visible && facts !== null && !facts.active && bodyVisible({ ...facts, active: true })
        ? { sibling: true as const }
        : {}),
    });
  }
  return { bodies: inReadingOrder(bodies) };
}

/**
 * `placement` with every body whose facts no longer show it marked hidden,
 * at the rect it had — or null when nothing changed. The commit-time half of
 * placement: what a settle may not measure, it may still hide.
 *
 * A body a plan is carrying in (`carriedIn`) is shown by its plan, not by
 * the deck's `arriving`, which stands until the settle lands: only a fact
 * that would hide it anyway — its pane closed, folded, parked — hides it.
 */
export function hiddenSince(
  deck: IDeckManagerStore,
  placement: Placement,
  carriedIn: ReadonlySet<string> = new Set(),
): Placement | null {
  let changed = false;
  const bodies = placement.bodies.map((b) => {
    if (!b.visible) return b;
    const read = bodyCardsStore.has(b.cardId) ? shownFactsOf(deck, b.cardId) : null;
    const facts = read !== null && carriedIn.has(b.cardId) ? { ...read, arriving: false } : read;
    if (facts !== null && bodyVisible(facts)) return b;
    changed = true;
    return { ...b, visible: false };
  });
  return changed ? { bodies } : null;
}

/**
 * A measurement that takes a shown card's view down, held one paint: `next`
 * with every body `last` showed and `next` does not — hidden, or gone from
 * it — still shown where `last` had it; and `releasing`, the same placement
 * with those bodies as `next` has them (hidden where it has none), for the
 * hide posted after the paint. Null when `next` takes nothing down.
 *
 * A view whose place a view `next` shows takes — a tab put behind the card
 * chosen in its pane — is not held: the shown view covers it, and the tab
 * choice is the host's to stack.
 *
 * The measurement runs on the far side of the commit's paint, but the host
 * applies a hide at once while the commit's frame may not have reached the
 * screen: a view taken down a frame early shows what lies beneath it, which
 * on a workspace switch is the canvas, before the switch's own stand-ins
 * have composited. Held one paint, the old view stands until they have.
 */
export function heldForThePaint(
  last: Placement | null,
  next: Placement,
): { held: Placement; releasing: Placement } | null {
  if (last === null) return null;
  const shownNext = next.bodies.filter((b) => b.visible);
  const shown = new Set(shownNext.map((b) => b.cardId));
  const takenBy = (b: BodyPlacement): boolean =>
    shownNext.some((s) => s.x === b.x && s.y === b.y && s.width === b.width && s.height === b.height);
  const leaving = last.bodies.filter((b) => b.visible && !shown.has(b.cardId) && !takenBy(b));
  if (leaving.length === 0) return null;
  const leavingIds = new Set(leaving.map((b) => b.cardId));
  const kept = next.bodies.filter((b) => !leavingIds.has(b.cardId));
  const nextOf = new Map(next.bodies.map((b) => [b.cardId, b]));
  return {
    held: { bodies: [...kept, ...leaving] },
    releasing: { bodies: [...kept, ...leaving.map((b) => nextOf.get(b.cardId) ?? { ...b, visible: false })] },
  };
}

/** What the placer remembers of a card a posted plan is carrying, until the host says it landed or was cancelled. */
export interface InFlightPlan {
  readonly planId: number;
  /** The view rect the plan lands the card at, viewport px. */
  readonly landing: Rect;
  readonly arrives: boolean;
  /** The plan is a dropped card's landing: the deck's landing mark comes off when it ends ({@link CardPlacer.noteRelease}). */
  readonly lands: boolean;
}

/**
 * `placement` with every card a plan is carrying to the very rect it was
 * measured at named by that plan — the land's measurement, which reads the
 * landing the plan already adopted — so the host leaves the plan's beats
 * running under it. A card measured anywhere else names no plan, and the
 * host takes it from its beats. Pure; the rects are compared exactly, since
 * both are the same stand-in grown to the same whole points.
 */
export function namePlans(placement: Placement, inFlight: ReadonlyMap<string, InFlightPlan>): Placement {
  if (inFlight.size === 0) return placement;
  let changed = false;
  const bodies = placement.bodies.map((b) => {
    const f = inFlight.get(b.cardId);
    if (f === undefined) return b;
    const l = f.landing;
    if (l.x !== b.x || l.y !== b.y || l.width !== b.width || l.height !== b.height) return b;
    changed = true;
    return { ...b, planId: f.planId };
  });
  return changed ? { bodies } : placement;
}

/** The watch {@link watchArrangementWrites} returns. */
export interface ArrangementWrites {
  /** Stop watching. */
  release(): void;
  /**
   * Forget the writes already queued in this task: the caller's own, made
   * after the measurement they would wake. Records are delivered at the end
   * of the task that queued them, so nothing a later task writes is lost.
   */
  drop(): void;
}

/**
 * Call `wake` on every inline `style` write under `container`, itself
 * included: the stand-ins' own geometry and pins, and the arrangement's
 * custom properties on the canvas, its layers and a column's readers. That is
 * the whole of how a gesture moves a stand-in without a commit, so it is the
 * one wake the placer needs for all of them ([B06]). A write of the value
 * already standing queues a record too; the measurement it wakes posts
 * nothing new, and posts nothing.
 */
export function watchArrangementWrites(container: HTMLElement, wake: () => void): ArrangementWrites {
  const observer = new MutationObserver(() => wake());
  observer.observe(container, { subtree: true, attributes: true, attributeFilter: ["style"] });
  return {
    release: () => observer.disconnect(),
    drop: () => {
      observer.takeRecords();
    },
  };
}

/**
 * The shell's placer: measures when asked, unless a settle holds the
 * geometry, and posts what changed. One per deck, started by the deck's
 * placement beacon with the canvas container it measures under.
 */
export class CardPlacer {
  private readonly poster = new PlacementPoster((p) => this.postCards(p));
  /** The last `placeCards` posted, so a re-post that says nothing new is not sent, and the cards the host holds. */
  private readonly cards = new PlaceCardsGate();
  /** What the last measurement read of the stand-ins, which every `placeCards` is composed with. */
  private facts: CardFacts | null = null;
  private container: HTMLElement | null = null;
  /** The flow strip's terms as the canvas arranged them, which a carried card's travel reads. */
  private readFlow: ReadFlowTerms = () => null;
  /** Every pane's box and order, read in the last measurement. */
  private paneBoxes = new Map<HTMLElement, PaneBox>();
  private cancelScheduled: CancelAfterPaint | null = null;
  /** Cards hidden this frame whose hide the host has not yet been told; posted after the paint. */
  private readonly hiding = new Set<string>();
  private cancelHidePost: CancelAfterPaint | null = null;
  private resizes: ResizeObserver | null = null;
  /** The wake on every arrangement write under the canvas ({@link watchArrangementWrites}). */
  private writes: ArrangementWrites | null = null;
  private readonly observed = new Set<Element>();
  /** Why the last measurement was declined, for {@link cardPlacementDiag}. */
  private lastSkip: string | null = null;
  /** Each card the hand let go of, by the pane rect it was released at (viewport px), until a plan lands it ({@link noteRelease}). */
  private readonly released = new Map<string, Rect>();
  /** The horizon armed over each landing in flight: past it the shell lands the card itself ([L33]). */
  private readonly horizons = new Map<string, ReturnType<typeof setTimeout>>();
  private measures = 0;
  /** The last beat plan's id; each plan takes the next. */
  private planSerial = 0;
  /** The cards a posted plan is carrying, until the host says it landed or was cancelled. */
  private readonly inFlight = new Map<string, InFlightPlan>();
  /** What the last {@link runPlan} decided, and what the host has said of it since. */
  private lastPlan: CardPlanReport | null = null;
  /** How many times {@link runPlan} has run, so a reader can tell its last report is new. */
  private planRuns = 0;

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
   * The hand let go of `cardId` with its pane at `paneRect` (viewport px):
   * the view stands there now, so the placement adopts it — the host holds
   * it there already — and the card lands from it by plan: the commit's
   * settle plans it in {@link runPlan}, or the measurement after the commit
   * does in {@link landReleased}. Told before the commit, so whichever runs
   * first sees the released rect.
   */
  noteRelease(cardId: string, paneRect: Rect): void {
    this.released.set(cardId, paneRect);
    // The deck's landing mark: a reveal the commit schedules waits for the
    // landing as well as for the settle, and every path out takes it off.
    this.deck.noteCardWillLand(cardId);
    const last = this.poster.lastPosted;
    if (last !== null) {
      const view = viewOf(paneRect, CARD_APRON_PX);
      this.poster.adopt({
        bodies: last.bodies.map((b) => (b.cardId === cardId ? { ...b, x: view.x, y: view.y, width: view.width, height: view.height } : b)),
      });
    }
    this.schedule();
  }

  /**
   * Measure, once, on the far side of the next paint. Coalesces.
   */
  schedule = (): void => {
    if (this.cancelScheduled !== null) return;
    this.cancelScheduled = scheduleAfterPaint(() => {
      this.cancelScheduled = null;
      this.measure();
    });
  };

  /**
   * Measure, unless a settle holds the geometry; post what changed. A
   * measurement a settle's set-up declines is queued for the set-up's end
   * rather than dropped: it may be the one that lands a gesture's last
   * move, and a set-up that turns into no settle sends no land to measure at.
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
    // A measurement outside a settle is the deck at rest: every card a plan
    // carried has landed, and its overlay surface stands again ([B07]) — but
    // for a card whose plan is still in flight, a landing that started late
    // and is landing now; its surface waits for the host's word.
    overlaySurfaceBook.releaseAll("plan");
    for (const cardId of this.inFlight.keys()) overlaySurfaceBook.hold(cardId, "plan");
    // A card a plan is carrying to the rect this measurement reads names its
    // plan, so the host leaves the plan's beats to land it ([B11]).
    const placement = namePlans(measurePlacements(this.deck, container), this.inFlight);
    this.paneBoxes = this.readPaneBoxes(container);
    const state = this.deck.getSnapshot();
    const run = this.deck.getColumnRunHeight();
    this.facts = readCardFacts(
      placement,
      container,
      (paneId) => (run !== null && paneStandingOf(state, paneId).keepSlot?.heightHeld === true ? run : null),
      this.deck,
      this.readFlow,
    );
    // A card the hand let go of elsewhere than this measurement puts it
    // lands by a plan of its own, posted ahead of the placement that names it.
    const landed = this.landReleased(placement);
    // A view this measurement takes down stands one paint more, so the host
    // never shows what lies beneath it before the commit has composited.
    const hold = heldForThePaint(this.poster.lastPosted, landed);
    const offered = hold?.held ?? landed;
    this.poster.offer(offered);
    // The stand-ins' facts can move with no rect moving (a slot taking a
    // grip away), so the cards are offered whether or not the rects are news.
    this.postCards(offered);
    // A measurement is the whole truth: a card it shows is no longer one a
    // pending hide may take back after the paint.
    for (const b of landed.bodies) if (b.visible) this.hiding.delete(b.cardId);
    if (hold !== null) this.hideNow(hold.releasing);
    this.observePlaceholders(container);
  };

  /**
   * Post `placeCards` for `placement` when it says something new: every
   * card's view, its showing and stacking, and the gesture envelope and hit
   * shape the host reads beside them. Composed from the last measurement's
   * facts, so a hide inside a settle's set-up reads nothing ([D211]).
   */
  private postCards(placement: Placement): void {
    if (this.facts === null) return;
    const cards = this.cards.offer(placeCardsOf(placement, this.facts));
    if (cards !== null) postToHost(placeCardsToHost, cards);
  }

  /**
   * The host is carrying `cardIds` (a rail width drag's members and the
   * cards it carries): until {@link releaseHostHold}, each placement names
   * them with the entries last posted before the hold ({@link PlaceCardsGate}).
   */
  holdForHost(cardIds: Iterable<string>): void {
    this.cards.hold(cardIds);
  }

  /**
   * The hold is over. What was posted is forgotten, both here and by the
   * poster, and a measurement is scheduled, so the landing is posted even
   * when it reads exactly what the drag's preview last showed.
   */
  releaseHostHold(): void {
    if (!this.cards.holding) return;
    this.cards.release();
    this.poster.forget();
    this.schedule();
  }

  /**
   * Hide, now, every body the last placement showed whose facts no longer
   * show it: post the placement with those marked hidden. No DOM is read —
   * the rects are the last posted — so this runs inside a settle's set-up
   * without a layout of its own ([D211]).
   */
  private hideWhatLeft(): void {
    const last = this.poster.lastPosted;
    const container = this.container;
    if (last === null || container === null) return;
    const carriedIn = new Set([...this.inFlight].filter(([, f]) => f.arrives).map(([cardId]) => cardId));
    const next = hiddenSince(this.deck, last, carriedIn);
    if (next === null) return;
    this.hideNow(next);
  }

  /**
   * Hide the cards `next` marks hidden: the host is told on the far side of
   * the paint after this commit's — the commit's own frame has reached the
   * screen by then, so a view the host takes down never leaves what lies
   * beneath it on show for a frame before the commit's stand-ins composite —
   * against whatever was posted by then, so a measurement in between is not
   * overwritten with these rects. Coalesces.
   */
  private hideNow(next: Placement): void {
    const last = this.poster.lastPosted;
    for (const b of next.bodies) {
      if (!b.visible && (last?.bodies.some((p) => p.cardId === b.cardId && p.visible) ?? false)) this.hiding.add(b.cardId);
    }
    this.cancelHidePost ??= scheduleAfterPaint(() => {
      this.cancelHidePost = scheduleAfterPaint(() => {
        this.cancelHidePost = null;
        const posted = this.poster.lastPosted;
        if (posted !== null && this.hiding.size > 0) {
          const bodies = posted.bodies.map((b) => (b.visible && this.hiding.has(b.cardId) ? { ...b, visible: false } : b));
          this.poster.offer({ bodies });
        }
        this.hiding.clear();
      });
    });
  }

  /**
   * A settle is about to move `input.frames`: plan the cards under them to
   * move with their stand-ins and post the plan through `lib/card-plan.ts`.
   *
   * The planned cards' landing rects are adopted as posted, each named by
   * the plan — the host reaches them on its own — so the land's measurement,
   * which reads the same rects and names the same plan, posts nothing and
   * nothing snaps. A card the planner refuses is left where it stands for
   * the land's measurement to place: a whole card is never hidden for a
   * motion ([B11]). No layout is read: the placement and the panes' boxes
   * are the last measurement's ([D211]).
   */
  runPlan(input: RunPlanInput): void {
    const last = this.poster.lastPosted;
    if (last === null || this.container === null) return;
    this.planRuns += 1;
    const frames: CarriedFrame[] = [];
    const cardsInFrame = new Map<string, string[]>();
    const unplannable: string[] = [];
    const reasons: Record<string, string> = {};
    const arriving = new Set<string>();
    const landings = new Set<string>();
    input.frames.forEach((f, i) => {
      const cardIds = bodiesIn(f.frame);
      if (cardIds.length === 0) return;
      // A card a plan names is moving until it rests: its overlay surface comes off now ([B07]).
      for (const cardId of cardIds) overlaySurfaceBook.hold(cardId, "plan");
      if (f.arrives === true) for (const cardId of cardIds) arriving.add(cardId);
      const box = this.paneBoxes.get(f.frame);
      const first = f.first ?? (box === undefined ? null : { x: box.x, y: box.y, width: box.width, height: box.height });
      if (first === null) {
        for (const cardId of cardIds) {
          unplannable.push(cardId);
          reasons[cardId] = "its frame was never measured";
        }
        return;
      }
      const paneId = `frame-${i}`;
      const lastRect = "dx" in f.last ? { ...first, x: first.x + f.last.dx } : f.last;
      // A card the hand let go of in this frame lands from where it was
      // released, as a one-card plan on the frame's move curve, rather
      // than riding the frame's beats from a First rect its view never
      // stood at ([B11]).
      const carried: string[] = [];
      for (const cardId of cardIds) {
        const released = this.released.get(cardId);
        const beat = f.beats.find((b) => b.kind === "move") ?? f.beats[0];
        if (released === undefined || beat === undefined) {
          carried.push(cardId);
          continue;
        }
        this.released.delete(cardId);
        const landingId = `${paneId}-landing-${cardId}`;
        frames.push(landingFrame(landingId, released, lastRect, beat, input.factor));
        cardsInFrame.set(landingId, [cardId]);
        landings.add(cardId);
      }
      if (carried.length === 0) return;
      frames.push({ paneId, first, last: lastRect, beats: f.beats });
      cardsInFrame.set(paneId, carried);
    });
    const out = planCards({
      frames,
      placement: last,
      cardsInFrame,
      stillShown: (cardId) => {
        const facts = shownFactsOf(this.deck, cardId);
        return facts !== null && bodyVisible(facts);
      },
      factor: input.factor,
      apron: CARD_APRON_PX,
      arriving,
    });
    const planId = this.postPlan(out, input.startTime, landings);
    // A landing the planner refused has no plan to end it: its mark comes off here.
    for (const cardId of landings) if (out.refused.includes(cardId)) this.deck.noteCardDidLand(cardId);
    if (planId !== null) {
      const landings = new Map(out.cards.map((c) => [c.cardId, c.landing]));
      const arrived = new Set(out.cards.filter((c) => c.arrives === true).map((c) => c.cardId));
      // Each carried card's rect is its landing, named by the plan. A carried
      // arrival is shown by the host with its tracks, so it is posted visible
      // from here: the frame it rides in on is what the reader sees arrive.
      //
      // And every card's shell controls are read again here. The place seams
      // stand at their Last positions from the commit the settle plans, while
      // the placement standing carries them where the last measurement at
      // rest read them — and no measurement runs until the settle ends. The
      // host keeps a seam's points for the shell, so a stale strip lying
      // across a card that is moving under it takes that card's presses for
      // the length of the settle. Posted at once, naming the plan, so the
      // host keeps its beats and only learns where the seams are.
      const adopted: Placement = {
        bodies: last.bodies.map((b) => {
          const r = landings.get(b.cardId);
          const placed = r === undefined ? b : { ...b, x: r.x, y: r.y, width: r.width, height: r.height, planId, ...(arrived.has(b.cardId) ? { visible: true } : {}) };
          const shell = shellControlRects(placed);
          return sameRects(shell, placed.shell) ? placed : { ...placed, shell };
        }),
      };
      this.poster.adopt(adopted);
      this.postCards(adopted);
    }
    this.lastPlan = {
      planId,
      planned: out.cards.map((c) => c.cardId),
      landings: Object.fromEntries(out.cards.map((c) => [c.cardId, c.landing])),
      refused: [...out.refused, ...unplannable],
      reasons: { ...out.reasons, ...reasons },
      landed: [],
      cancelled: [],
      shellLanded: [],
    };
  }

  /**
   * Post `out`'s cards as one plan starting at `startTime` (document
   * timeline ms), record each in flight, and arm a horizon over every card
   * in `landings`: the plan's own length plus a guard, past which the shell
   * lands the card itself where the host never reported ([L33]). Returns the
   * plan's id, or null when nothing was planned and nothing posted. Adopting
   * the landings into the placement is the caller's.
   */
  private postPlan(out: CardPlanOutput, startTime: number, landings: ReadonlySet<string>): number | null {
    if (out.cards.length === 0) return null;
    const planId = ++this.planSerial;
    // Never a start already past. `startTime` is the settle's frame clock,
    // which stands still through the task that commits a drop and plans
    // its settle, so by the time a long commit posts its plan that start
    // can be a hundred milliseconds gone — and a track that begins in the
    // past begins mid-curve, which is the first-frame hop `at0597` reads.
    // The stand-ins paint nothing, so the cards starting at the real now
    // and landing that much after them costs nothing the eye can see.
    const plan: CardPlan = { planId, startWallMs: shellWallMs(Math.max(startTime, performance.now())), cards: out.cards };
    postCardPlan(plan);
    for (const c of out.cards) {
      const spanMs = Math.max(0, ...c.beats.map((beat) => beat.delayMs + beat.durationMs));
      deckTrace.record({
        kind: "body-beat",
        cardId: c.cardId,
        planId,
        beats: c.beats.length,
        startWallMs: plan.startWallMs,
        spanMs,
        landed: null,
        lateMs: null,
      });
      this.inFlight.set(c.cardId, { planId, landing: c.landing, arrives: c.arrives === true, lands: landings.has(c.cardId) });
      if (!landings.has(c.cardId)) continue;
      this.clearHorizon(c.cardId);
      this.horizons.set(
        c.cardId,
        setTimeout(() => this.shellLand(c.cardId, planId), spanMs + LANDING_GUARD_MS),
      );
    }
    return planId;
  }

  /**
   * Land every card the hand let go of that `placement` measures elsewhere
   * than it was released: one plan from the released rect to the measured
   * one, on the settle's move curve, named on the card's entry so the host
   * keeps the plan's beats under the placement that follows. A card measured
   * where it was released needs nothing; one no longer measured, or no
   * longer shown, is forgotten.
   */
  private landReleased(placement: Placement): Placement {
    if (this.released.size === 0) return placement;
    const factor = pageZoomStore.getFactor();
    const curve = motionKeyframes("crossing", { nominalMs: IMPOSITION_SETTLE_MS });
    const beat: LandingCurve = { durationMs: curve.durationMs * getTugTiming(), progress: curve.progress };
    const bodies = new Map(placement.bodies.map((b) => [b.cardId, b]));
    const frames: CarriedFrame[] = [];
    const cardsInFrame = new Map<string, string[]>();
    const standing: BodyPlacement[] = [];
    for (const [cardId, released] of [...this.released]) {
      this.released.delete(cardId);
      const b = bodies.get(cardId);
      if (b === undefined || !b.visible) {
        this.deck.noteCardDidLand(cardId);
        continue;
      }
      const from = viewOf(released, CARD_APRON_PX);
      if (from.x === b.x && from.y === b.y && from.width === b.width && from.height === b.height) {
        // Measured where it was released: the view is home already.
        this.deck.noteCardDidLand(cardId);
        continue;
      }
      const paneId = `landing-${cardId}`;
      frames.push(landingFrame(paneId, released, paneRectOf(b), beat, factor));
      cardsInFrame.set(paneId, [cardId]);
      // The view stands where it was released: the plan starts there.
      standing.push({ ...b, x: from.x, y: from.y, width: from.width, height: from.height });
    }
    if (frames.length === 0) return placement;
    const out = planCards({
      frames,
      placement: { bodies: standing },
      cardsInFrame,
      stillShown: () => true,
      factor,
      apron: CARD_APRON_PX,
    });
    const now = document.timeline.currentTime;
    const planId = this.postPlan(out, typeof now === "number" ? now : performance.now(), new Set(out.cards.map((c) => c.cardId)));
    for (const cardId of out.refused) this.deck.noteCardDidLand(cardId);
    this.lastPlan = {
      planId,
      planned: out.cards.map((c) => c.cardId),
      landings: Object.fromEntries(out.cards.map((c) => [c.cardId, c.landing])),
      refused: out.refused,
      reasons: out.reasons,
      landed: [],
      cancelled: [],
      shellLanded: [],
    };
    if (planId === null) return placement;
    const planned = new Set(out.cards.map((c) => c.cardId));
    return { bodies: placement.bodies.map((b) => (planned.has(b.cardId) ? { ...b, planId } : b)) };
  }

  /**
   * The horizon passed with the host silent on plan `planId`'s landing of
   * `cardId`: the shell lands it — the landing is posted with no plan named,
   * which takes the card from its beats and places it there ([L33]).
   */
  private shellLand(cardId: string, planId: number): void {
    this.horizons.delete(cardId);
    const flight = this.inFlight.get(cardId);
    if (flight?.planId !== planId) return;
    this.inFlight.delete(cardId);
    if (flight.lands) this.deck.noteCardDidLand(cardId);
    overlaySurfaceBook.release(cardId, "plan");
    if (this.lastPlan?.planId === planId) this.lastPlan.shellLanded.push(cardId);
    this.traceAnswer(cardId, planId, false, null);
    const last = this.poster.lastPosted;
    if (last === null) return;
    this.poster.offer({
      bodies: last.bodies.map((b) => {
        if (b.cardId !== cardId || b.planId === undefined) return b;
        const { planId: named, ...rest } = b;
        void named;
        return rest;
      }),
    });
  }

  private clearHorizon(cardId: string): void {
    const horizon = this.horizons.get(cardId);
    if (horizon === undefined) return;
    clearTimeout(horizon);
    this.horizons.delete(cardId);
  }

  /** The host ran `cardId`'s beats of plan `planId` to their end. */
  landed(cardId: string, planId: number, lateMs: number | null): void {
    this.traceAnswer(cardId, planId, true, lateMs);
    overlaySurfaceBook.release(cardId, "plan");
    const flight = this.inFlight.get(cardId);
    if (flight?.planId === planId) {
      this.inFlight.delete(cardId);
      this.clearHorizon(cardId);
      if (flight.lands) this.deck.noteCardDidLand(cardId);
      this.measureAtRest();
    }
    if (this.lastPlan?.planId === planId) this.lastPlan.landed.push({ cardId, lateMs });
  }

  /** A placement or a newer plan took `cardId` before plan `planId` landed it. */
  beatsCancelled(cardId: string, planId: number): void {
    this.traceAnswer(cardId, planId, false, null);
    const flight = this.inFlight.get(cardId);
    if (flight?.planId === planId) {
      this.inFlight.delete(cardId);
      this.clearHorizon(cardId);
      if (flight.lands) this.deck.noteCardDidLand(cardId);
      this.measureAtRest();
    }
    if (this.lastPlan?.planId === planId) this.lastPlan.cancelled.push(cardId);
  }

  /**
   * The last card a plan carried is down: measure the deck at rest, once.
   * The settle's own end measured while a body was still in flight, so the
   * placement standing names the plan and carries what the shell read then —
   * a place seam where it stood mid-settle, before its final write. The host
   * keeps a seam's points for the shell, so a stale one over a card takes
   * that card's presses until something else happens to re-measure.
   */
  private measureAtRest(): void {
    if (this.inFlight.size === 0) this.schedule();
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
   * Start the standing wakes under `container` — the settle's land, a window
   * resize, a zoom change, a body's state, a placeholder's size — and return
   * the uninstall. A no-op when the host makes no bodies. `readFlow` answers
   * the flow strip's terms, which every placement carries in its band.
   */
  install(container: HTMLElement, readFlow: ReadFlowTerms): () => void {
    if (!hostCapabilitiesStore.get().bodyViews) return () => {};
    this.container = container;
    this.readFlow = readFlow;
    setInstalled(this);
    installCardPlanRunner((input) => this.runPlan(input));
    this.resizes = new ResizeObserver(this.schedule);
    this.writes = watchArrangementWrites(container, this.schedule);
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
      this.writes?.release();
      this.writes = null;
      this.observed.clear();
      this.cancelScheduled?.();
      this.cancelScheduled = null;
      this.cancelHidePost?.();
      this.cancelHidePost = null;
      this.hiding.clear();
      this.container = null;
      this.cards.release();
      this.facts = null;
      this.paneBoxes.clear();
      // Every landing mark comes off with the placer: nothing is left to take it off.
      for (const cardId of this.released.keys()) this.deck.noteCardDidLand(cardId);
      this.released.clear();
      for (const [cardId, flight] of this.inFlight) if (flight.lands) this.deck.noteCardDidLand(cardId);
      // Nothing is left to answer for a plan in flight, and a plan remembered
      // past the uninstall would hold its card's overlay surface off at every
      // measurement of the next install.
      this.inFlight.clear();
      for (const cardId of [...this.horizons.keys()]) this.clearHorizon(cardId);
      if (installed === this) {
        installed = null;
        installCardPlanRunner(null);
      }
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

  /** What {@link cardPlacementDiag} reports. */
  diag(): CardPlacementDiag {
    return {
      lastPosted: this.poster.lastPosted,
      lastCards: this.cards.posted,
      lastSkip: this.lastSkip,
      measures: this.measures,
      lastPlan: this.lastPlan,
      planRuns: this.planRuns,
      inFlight: [...this.inFlight.keys()],
    };
  }
}

/** The placer's own account of itself, for `tugdeck.diag`. */
export interface CardPlacementDiag {
  readonly lastPosted: Placement | null;
  /** The last `placeCards` message posted: the rail facts, the band and each card's travel as the host was told them. */
  readonly lastCards: PlaceCards | null;
  readonly lastSkip: string | null;
  readonly measures: number;
  /** The last beat plan the placer ran, or null before one. */
  readonly lastPlan: CardPlanReport | null;
  /** How many settles have handed the placer frames to plan. */
  readonly planRuns: number;
  /** The bodies a plan is carrying now. */
  readonly inFlight: readonly string[];
}

/** What one {@link CardPlacer.runPlan} decided and what the host has said of it. */
export interface CardPlanReport {
  /** Null when nothing was planned and nothing posted. */
  readonly planId: number | null;
  readonly planned: readonly string[];
  /** Where the plan lands each planned body, viewport px: the rect the host carries it to. */
  readonly landings: Readonly<Record<string, Rect>>;
  readonly refused: readonly string[];
  readonly reasons: Readonly<Record<string, string>>;
  readonly landed: { cardId: string; lateMs: number | null }[];
  readonly cancelled: string[];
  /** Cards whose landing the shell posted itself, the horizon having passed with the host silent ([L33]). */
  readonly shellLanded: string[];
}

/** The body cards whose placeholder stands in `frame`. Reads no layout. */
function bodiesIn(frame: HTMLElement): string[] {
  const ids: string[] = [];
  for (const el of frame.querySelectorAll<HTMLElement>("[data-body-placeholder][data-card-id]")) {
    if (el.dataset.cardId !== undefined) ids.push(el.dataset.cardId);
  }
  return ids;
}

let installed: CardPlacer | null = null;

function setInstalled(placer: CardPlacer): void {
  installed = placer;
}

/** The hand let go of `cardId` with its pane at `paneRect` (viewport px): the installed placer lands it by plan ({@link CardPlacer.noteRelease}). */
export function landCard(cardId: string, paneRect: Rect): void {
  installed?.noteRelease(cardId, paneRect);
}

/** The host is carrying `cardIds` until {@link releaseCardsHeldForHost} ({@link CardPlacer.holdForHost}). */
export function holdCardsForHost(cardIds: Iterable<string>): void {
  installed?.holdForHost(cardIds);
}

/** The host's hold is over: the next placement names every card where it stands ({@link CardPlacer.releaseHostHold}). */
export function releaseCardsHeldForHost(): void {
  installed?.releaseHostHold();
}

/** The installed placer's account, or null when none is installed. Read-only. */
export function cardPlacementDiag(): CardPlacementDiag | null {
  return installed?.diag() ?? null;
}

/** The host ran a body's planned beats to their end. */
export function cardPlanLanded(cardId: string, planId: number, lateMs: number | null): void {
  installed?.landed(cardId, planId, lateMs);
}

/** The host gave up a body's planned beats before they landed. */
export function cardPlanCancelled(cardId: string, planId: number): void {
  installed?.beatsCancelled(cardId, planId);
}
