/**
 * card-plan.ts — the card plan: what a settle tells the host so a whole card
 * moves with the stand-in its beats carry.
 *
 * A card is one view the host places over the shell's paintless stand-in
 * (`card-placement.ts`), so a settle that tweens a stand-in would leave the
 * card standing where it was placed and jump it at the land. The card plan
 * closes that gap. At the moment a settle plans its beats it posts the host
 * one `cardPlan`: for each card in a carried frame, the viewport rect its
 * view starts and ends each beat at, the beat's timing on the one clock both
 * sides share, and the progress samples the chrome beat itself was built
 * from. The host runs those as Core Animation on the card's container, so
 * the render server moves the whole card on the same curve from the same
 * start ([B11]).
 *
 * **This module is the one producer of `cardPlan`.** Both settle-engine call
 * sites hand their frames to {@link runCardPlan}; the installed placer plans
 * them with {@link planCards} and posts through {@link postCardPlan}. Nothing
 * else composes or posts the message.
 *
 * Everything here is pure and reads no DOM: the settle engine and the placer
 * gather the inputs, and this module decides who is planned and where each
 * beat goes.
 *
 * ## The rect walk
 *
 * A card's view is its stand-in's rect outset by the apron and grown to whole
 * points — the same rule the placer posts it by — so there are no insets to
 * carry and no content box to mirror: the view is the frame, and a card's
 * rect at any moment is a function of its frame's. The planner walks each
 * frame's beats in order with a running frame rect that starts at First,
 * applies each beat's terms to it, and takes the view of the rect before and
 * after each beat as the card's `from` and `to`. The walk must land on the
 * frame's Last rect, or the card is refused: a plan that ends somewhere other
 * than where the chrome ends would leave the card off its pane.
 *
 * ## Who is planned
 *
 * A card is planned when it was placed visible, is still shown, stands in a
 * carried frame whose beats walk to the frame's Last rect, and its posted
 * rect is where its frame's First rect puts it (a stale placement is refused
 * rather than animated from the wrong place). One card is planned without
 * having been placed visible: an ARRIVING one, painted while its card stood
 * hidden, which rides its frame's `arrive` beat in and is shown by the host
 * in the same transaction as its tracks (`arrives`). A card whose box changes
 * size is carried, with `crossing` at its landing size: a whole card is always
 * carryable, so nothing is hidden for a motion. A card the planner refuses
 * stands where it is, and the land's measurement places it.
 *
 * ## Units
 *
 * Every rect a plan carries is viewport px, which is what the host places in.
 * The settle engine measures in layout px (`layoutRectOf` divides every
 * component of a client rect by the page-zoom factor), so the caller scales
 * its First and Last rects to viewport px with {@link viewportRect}, and the
 * planner scales the terms' sizes by the same `factor`. The apron is viewport
 * px already: the placer outsets the stand-in's client rect by it.
 *
 * Laws: [L06] the plan is appearance, computed in the settle's planning and
 * posted to the host, never React state; [D211] nothing here reads layout.
 */

import { postToHost } from "../host/channel";
import { cardPlanToHost } from "../host/declarations/geometry";
import type { PlanStarted } from "../host/declarations/lifecycle";
import type { Placement } from "./card-placement";
import type { BeatKind, SettleTerms } from "./pane-flip";

// ---------------------------------------------------------------------------
// The rect and beat vocabulary a settle hands the planner
// ---------------------------------------------------------------------------

/** A viewport rect, in px. */
export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** How close to a whole point an edge must be to count as on it. */
const WHOLE_EPSILON = 0.001;

/**
 * `r` grown outward to whole points, the rect every card is posted at. A
 * card's page takes its layout viewport in whole CSS px, which in a card's
 * view are points, so a view a fraction of a point wider than a whole one
 * leaves that fraction outside the page: the web view's backing, read as a
 * bright column at the card's edge. Whole points leave none. Outward, never
 * inward: the card's page lays its pane out at the insets the placement
 * carries, so the growth stands in the apron and never in the pane.
 */
export function wholePoints(r: Rect): Rect {
  const x = Math.floor(r.x + WHOLE_EPSILON);
  const y = Math.floor(r.y + WHOLE_EPSILON);
  const right = Math.ceil(r.x + r.width - WHOLE_EPSILON);
  const bottom = Math.ceil(r.y + r.height - WHOLE_EPSILON);
  return { x, y, width: right - x, height: bottom - y };
}

/** A keyword easing a two-sample beat (a fade) carries in place of samples. */
export type BeatEasing = "linear" | "ease" | "ease-in" | "ease-out" | "ease-in-out";

/**
 * The wall-clock time of a document-timeline time `t`, in ms.
 *
 * `document.timeline.currentTime` is in `performance.now()` terms in a
 * WKWebView's main frame, so `performance.timeOrigin + t` is when `t` happens
 * on the wall clock, which is the one clock the host can also read. Every
 * conversion goes through here so there is one place to change it: if a
 * reading shows `performance.now()` drifting from `Date.now()` (a monotonic
 * clock that does not advance across sleep), the alternative is
 * `Date.now() + (t - performance.now())`, sampled at posting.
 */
export function shellWallMs(t: number): number {
  return performance.timeOrigin + t;
}

/** {@link shellWallMs}'s inverse: a wall-clock ms on the document timeline. */
export function shellTimelineMs(wallMs: number): number {
  return wallMs - performance.timeOrigin;
}

/** A layout-px rect from `layoutRectOf`, as viewport px at page-zoom `factor`: all four components, no origin term. */
export function viewportRect(layout: Rect, factor: number): Rect {
  return { x: layout.x * factor, y: layout.y * factor, width: layout.width * factor, height: layout.height * factor };
}

/** One beat of a carried frame, as the settle engine scheduled it. */
export interface FrameBeat {
  readonly kind: BeatKind;
  /** The beat's FLIP terms, in layout px. Depart carries none that move the frame; an arrive that rises or slides in carries its offset. */
  readonly terms: SettleTerms;
  readonly delayMs: number;
  readonly durationMs: number;
  readonly progress: readonly number[];
  readonly easing?: BeatEasing;
  readonly opacity?: readonly [number, number];
}

/** One frame a settle carries. */
export interface CarriedFrame {
  readonly paneId: string;
  /** The frame's visual rect before the settle, viewport px. */
  readonly first: Rect;
  /** Its rect at rest after it, viewport px. */
  readonly last: Rect;
  readonly beats: readonly FrameBeat[];
}

// ---------------------------------------------------------------------------
// The wire form
// ---------------------------------------------------------------------------

/** One beat of one card. */
export interface CardBeat {
  readonly kind: BeatKind;
  /** From the plan's `startWallMs`, already scaled by `getTugTiming()`. */
  readonly delayMs: number;
  /** Scaled. */
  readonly durationMs: number;
  readonly from: Rect;
  readonly to: Rect;
  /** Start and end opacity; omitted means 1 → 1. */
  readonly opacity?: readonly [number, number];
  /** Evenly spaced in time, first 0 and last 1; may overshoot. Two values = a fade. */
  readonly progress: readonly number[];
  /** For a two-value `progress`: the chrome's keyword easing. */
  readonly easing?: BeatEasing;
}

/** One card's beats in a plan. */
export interface PlannedCard {
  readonly cardId: string;
  /** The view's viewport rect at rest after the plan: the host's model value. */
  readonly landing: Rect;
  /** Present when the card's box changes size. */
  readonly crossing?: { readonly width: number; readonly height: number };
  /** The card was not shown before the plan: the host shows it with its tracks, held at their opening values. */
  readonly arrives?: true;
  readonly beats: readonly CardBeat[];
}

/** The `cardPlan` message body, shell → host. */
export interface CardPlan {
  /** Monotonic per shell page: the id a placement names the plan by. */
  readonly planId: number;
  /** `shellWallMs(T)`: the settle's t = 0 on the wall clock, ms. */
  readonly startWallMs: number;
  /**
   * Some card's box changes size: the host lays each such card's page out at
   * its crossing size before the motion starts, and says when it started
   * (`planStarted`).
   */
  readonly solves: boolean;
  readonly cards: readonly PlannedCard[];
}

/** Post `plan` to the host. The one place `cardPlan` is sent. */
export function postCardPlan(plan: CardPlan): void {
  postToHost(cardPlanToHost, plan);
}

// ---------------------------------------------------------------------------
// The settle's hand-off
// ---------------------------------------------------------------------------

/** One frame a settle hands {@link runCardPlan}. */
export interface RunPlanFrame {
  readonly frame: HTMLElement;
  /** Its visual rect before the settle, viewport px; null when the settle measured none, and the placer's last box stands in. */
  readonly first: Rect | null;
  /** Its rect at rest after the settle, viewport px, or how far it travels from `first` across the page. */
  readonly last: Rect | { readonly dx: number };
  readonly beats: readonly FrameBeat[];
  /** The frame is arriving on this settle: its cards were never shown, and ride its arrive beat in. */
  readonly arrives?: boolean;
}

/** What a settle hands {@link runCardPlan}. */
export interface RunPlanInput {
  readonly frames: readonly RunPlanFrame[];
  /** The settle's start on the document timeline (ms): every chrome beat's `startTime`. */
  readonly startTime: number;
  /** The page-zoom factor the frames' terms scale by. */
  readonly factor: number;
}

/**
 * How long the host waits for a solving plan's cards before it starts the
 * plan without them, ms. The host's `BodyViewController.solveGuardMs` is the
 * source; the shell mirrors it to size what it arms from the plan's posting.
 */
export const SOLVE_GUARD_MS = 250;

/** What a posted plan says of itself to the settle that asked for it. */
export interface PostedPlan {
  readonly planId: number;
  /** The plan waits on the host's `planStarted` before anything moves. */
  readonly solves: boolean;
}

let runner: ((input: RunPlanInput) => PostedPlan | null) | null = null;

/** The placer installs itself here; `null` uninstalls. */
export function installCardPlanRunner(run: ((input: RunPlanInput) => PostedPlan | null) | null): void {
  runner = run;
}

/**
 * A settle is about to move `input.frames`: the installed placer plans the
 * cards under them to move with their stand-ins and posts the plan, and
 * says which plan it posted and whether it solves. Null when nothing was
 * posted — no placer, because the host makes no card views, or no card to
 * plan.
 */
export function runCardPlan(input: RunPlanInput): PostedPlan | null {
  return runner?.(input) ?? null;
}

let planStartListener: ((started: PlanStarted) => void) | null = null;

/** The settle installs what hears a solving plan start; `null` uninstalls. */
export function installPlanStartListener(listen: ((started: PlanStarted) => void) | null): void {
  planStartListener = listen;
}

/** The host started a solving plan: the placer forwards its `planStarted` here. */
export function notePlanStarted(started: PlanStarted): void {
  planStartListener?.(started);
}

// ---------------------------------------------------------------------------
// The planner
// ---------------------------------------------------------------------------

/** How far two rects may differ and still be the same place, in px. */
const SAME_PX = 0.5;

/**
 * How far a posted view may stand from where its frame's First rect puts it
 * and still be that frame's, in px: a whole point of growth on either side,
 * which is all two readings of one stand-in can disagree by.
 */
const STALE_PX = 1;

export interface CardPlanInput {
  readonly frames: readonly CarriedFrame[];
  /** The placer's last posted placement. */
  readonly placement: Placement | null;
  /** Each carried frame's cards: those whose stand-in it is. */
  readonly cardsInFrame: ReadonlyMap<string, readonly string[]>;
  /** Whether a card is still shown by the deck's facts (`hiddenSince`'s rule). */
  readonly stillShown: (cardId: string) => boolean;
  /** The page-zoom factor the terms' layout px scale by. */
  readonly factor: number;
  /** How far a card's view reaches past its frame on every side, viewport px. */
  readonly apron: number;
  /** Cards arriving with their frame: planned though never placed visible. */
  readonly arriving?: ReadonlySet<string>;
}

export interface CardPlanOutput {
  readonly cards: PlannedCard[];
  /** Some planned card carries a `crossing`, so the plan solves before it starts. */
  readonly solves: boolean;
  /** Every card in a carried frame the planner did not plan, in frame order. */
  readonly refused: string[];
  /** Why each refused card was refused, for the trace. */
  readonly reasons: Readonly<Record<string, string>>;
}

/** The curve a landing rides: a beat's duration and progress samples. */
export interface LandingCurve {
  readonly durationMs: number;
  readonly progress: readonly number[];
}

/**
 * A carried frame for a card the hand released with its pane at `released`
 * and whose stand-in now stands at `last`: one move beat on `curve`, whose
 * terms take the walk from the released rect to the stand-in's — origin and,
 * where it differs, size — so the planner lands the view where the pane is
 * rather than snapping it there ([B11]). Rects are viewport px; the terms
 * are layout px, as every beat's are.
 */
export function landingFrame(paneId: string, released: Rect, last: Rect, curve: LandingCurve, factor: number): CarriedFrame {
  const terms: SettleTerms = {
    dx: (released.x - last.x) / factor,
    dy: (released.y - last.y) / factor,
    ...(Math.abs(released.width - last.width) >= SAME_PX ? { width: [released.width / factor, last.width / factor] as const } : {}),
    ...(Math.abs(released.height - last.height) >= SAME_PX ? { height: [released.height / factor, last.height / factor] as const } : {}),
  };
  return {
    paneId,
    first: released,
    last,
    beats: [{ kind: "move", terms, delayMs: 0, durationMs: curve.durationMs, progress: curve.progress }],
  };
}

/** The view a frame at `r` is placed as: outset by the apron, grown to whole points. */
export function viewOf(r: Rect, apron: number): Rect {
  return wholePoints({ x: r.x - apron, y: r.y - apron, width: r.width + 2 * apron, height: r.height + 2 * apron });
}

function sameRect(a: Rect, b: Rect, within: number = SAME_PX): boolean {
  return (
    Math.abs(a.x - b.x) < within &&
    Math.abs(a.y - b.y) < within &&
    Math.abs(a.width - b.width) < within &&
    Math.abs(a.height - b.height) < within
  );
}

/**
 * The frame's rect after one beat, from the rect before it. A beat that moves
 * the frame (`dx`, `dy` or a smear) takes it to Last's origin, top-left
 * anchored as `springSettleKeyframes` measures; a smear also takes Last's
 * width. A real `width` or `height` term takes the term's target, in viewport
 * px. A fade moves nothing.
 */
function applyBeat(running: Rect, beat: FrameBeat, last: Rect, factor: number): Rect {
  if (beat.kind === "depart") return running;
  const { dx, dy, sx = 1, width, height } = beat.terms;
  // An arrival rises (or a rail slides) from its offset to where it lands.
  if (beat.kind === "arrive") return dx !== 0 || dy !== 0 ? { ...running, x: last.x, y: last.y } : running;
  let next: Rect = running;
  if (dx !== 0 || dy !== 0 || sx !== 1) {
    next = { ...next, x: last.x, y: last.y };
    if (sx !== 1) next = { ...next, width: last.width };
  }
  if (width !== undefined) next = { ...next, width: width[1] * factor };
  if (height !== undefined) next = { ...next, height: height[1] * factor };
  return next;
}

/** A fade's opacity: the beat's own, or what its kind means. */
function opacityOf(beat: FrameBeat): readonly [number, number] | undefined {
  if (beat.opacity !== undefined) return beat.opacity;
  if (beat.kind === "depart") return [1, 0];
  if (beat.kind === "arrive") return [0, 1];
  return undefined;
}

/** The frame's beats in time order, its running rect before and after each, or why it cannot be walked. */
function walkFrame(frame: CarriedFrame, factor: number): { steps: { beat: FrameBeat; from: Rect; to: Rect }[] } | { reason: string } {
  if (frame.beats.length === 0) return { reason: "the frame carries no beat" };
  const ordered = [...frame.beats].sort((a, b) => a.delayMs - b.delayMs);
  let running = frame.first;
  const steps: { beat: FrameBeat; from: Rect; to: Rect }[] = [];
  for (const beat of ordered) {
    if (beat.progress.length < 2) return { reason: `a ${beat.kind} beat has fewer than two progress samples` };
    const to = applyBeat(running, beat, frame.last, factor);
    steps.push({ beat, from: running, to });
    running = to;
  }
  if (!sameRect(running, frame.last)) {
    return { reason: `the walk ends at ${JSON.stringify(running)}, not the frame's Last ${JSON.stringify(frame.last)}` };
  }
  return { steps };
}

/**
 * Plan the cards a settle carries.
 *
 * A card is planned when it was placed visible, is still shown, stands in a
 * carried frame whose beats walk to the frame's Last rect, and its posted
 * view is where the frame's First rect puts it. A card whose box changes
 * size carries `crossing` at its landing size, and makes the plan one that
 * solves. Every other card in a carried frame is refused, with its reason.
 */
export function planCards(input: CardPlanInput): CardPlanOutput {
  const cards: PlannedCard[] = [];
  const refused: string[] = [];
  const reasons: Record<string, string> = {};
  const refuse = (cardId: string, reason: string): void => {
    refused.push(cardId);
    reasons[cardId] = reason;
  };
  const posted = new Map((input.placement?.bodies ?? []).map((b) => [b.cardId, b]));
  const view = (r: Rect): Rect => viewOf(r, input.apron);

  for (const frame of input.frames) {
    const cardIds = input.cardsInFrame.get(frame.paneId) ?? [];
    if (cardIds.length === 0) continue;
    const walk = walkFrame(frame, input.factor);
    for (const cardId of cardIds) {
      if ("reason" in walk) {
        refuse(cardId, walk.reason);
        continue;
      }
      const placed = posted.get(cardId);
      const arrives = input.arriving?.has(cardId) === true;
      if (placed === undefined || (!placed.visible && !arrives)) {
        refuse(cardId, "not placed visible");
        continue;
      }
      if (!input.stillShown(cardId)) {
        refuse(cardId, "hidden since the placement");
        continue;
      }
      // A card that was shown starts where it was placed, and a placement
      // anywhere else is stale. An arrival was never shown: it is placed at
      // its landing, wherever the hidden pane happened to stand.
      if (!arrives && !sameRect(view(frame.first), placed, STALE_PX)) {
        refuse(cardId, "its placement is not where its frame's First rect stands");
        continue;
      }
      const beats: CardBeat[] = walk.steps.map(({ beat, from, to }) => {
        const opacity = opacityOf(beat);
        return {
          kind: beat.kind,
          delayMs: beat.delayMs,
          durationMs: beat.durationMs,
          from: view(from),
          to: view(to),
          ...(opacity !== undefined ? { opacity } : {}),
          progress: beat.progress,
          ...(beat.easing !== undefined ? { easing: beat.easing } : {}),
        };
      });
      const start = beats[0].from;
      const landing = beats[beats.length - 1].to;
      const resized = Math.abs(landing.width - start.width) >= SAME_PX || Math.abs(landing.height - start.height) >= SAME_PX;
      cards.push({
        cardId,
        landing,
        ...(resized ? { crossing: { width: landing.width, height: landing.height } } : {}),
        ...(arrives ? { arrives: true as const } : {}),
        beats,
      });
    }
  }
  return { cards, solves: cards.some((c) => c.crossing !== undefined), refused, reasons };
}
