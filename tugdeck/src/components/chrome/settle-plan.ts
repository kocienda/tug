/**
 * settle-plan.ts — the settle's decisions, as data in and a plan out.
 *
 * What a commit settles, in what order, and under what budget, with nothing
 * read off the DOM and no ref in sight: the arrangement signature a commit is
 * read against, what the commit changed, which path the arm takes (cut,
 * prelaunched slide, or measured settle), which beats launch, and each beat's
 * delay and the windows that cap them. `settle-engine.ts` is the React half —
 * the refs, the layout effects, the measurement and the animations — and calls
 * these at the points it always decided them, so the order of its work is the
 * order it always had.
 *
 * @module components/chrome/settle-plan
 */

import {
  bullseyePaneIdOf,
  deckColumnsOf,
  placeAllocationTerm,
  type PlaceRuns,
  sidebarRailsOf,
} from "@/deck-store-selectors";
import type { DeckState } from "@/layout-tree";
import { standingDeck } from "@/lib/departing";
import { ARRIVAL_PREPARE_MS, FOLD_PREPARE_MS } from "@/lib/fold-crossing";
import { motionDurationMs, type MotionRecipe } from "@/lib/imposer-motion";
import { impositionLayout } from "@/lib/layout-imposer";
import { BEAT_ORDER, type BeatKind } from "@/lib/pane-flip";

// ---- The signature: what a commit is read against ----

/**
 * The arrangement signature, in its two readings.
 *
 * `full` is the whole of it — every term, the one the settle arms on. `size`
 * is the same string with the two terms a PURE SLIDE moves taken out: the flow
 * offset, and each pane's slot. Two commits with the same `size` put every
 * frame at the same WIDTH and in the same tier, however far they have
 * travelled across the band, which is the exact predicate for "is this a
 * resize?" ([P07], [B06]).
 *
 * It cannot go stale by construction: `size` is built from the same terms
 * `full` is, in the same pass, so a width-bearing term added to one is added
 * to the other by the act of adding it.
 */
export interface ArrangementSignature {
  /** Every term. What the settle arms on. */
  readonly full: string;
  /** Every term except the flow offset and each pane's slot. */
  readonly size: string;
  /** Every term except the flow offset. Equal across a pure flow slide. */
  readonly sansOffset: string;
}

/**
 * Everything the imposer reads, as one string — and that string again with the
 * two purely positional terms dropped ({@link ArrangementSignature}). The
 * imposition record, which pane holds which slot, and the pinned rail's width.
 * Two decks with the same `full` signature put every derived frame in the same
 * place, so a change to it is exactly the set of moments the deck should cross
 * to a new arrangement rather than cut.
 *
 * The pane terms are sorted, so the signature is blind to the panes array's
 * ORDER — which is z-order, and z-order moves nothing: `imposeRect` reads a
 * pane's slot, its width, and the span, never its place in the array. Order
 * sensitivity here would make every pane activation — a click on a title bar —
 * arm a settle window with no frame to move in it, holding session
 * notifications for the length of a motion that never happens.
 *
 * The rail widths are terms because the space allocator can change them with
 * the arrangement otherwise untouched — a settled window resize re-solves them
 * and nothing else — and every imposed frame moves when they do. Without the
 * terms that motion would cut. They change on a rail edge drag too, which arms
 * a window whose tweens are all no-ops: the drag wrote the width live, so each
 * frame's first and last rects are the same one.
 *
 * A pane's own WIDTH is a term for the same reason: `imposeRect` reads it, so a
 * width preset — the deck-wide one from the Layouts section, or one card's from
 * its title bar — moves every seam in the chain and resizes the panes it lands
 * on. It is the one arrangement input a pointer also writes: a hand-dragged
 * edge changes it too, and arms a window whose tweens are the same no-ops a
 * rail drag's are, for the same reason.
 *
 * A pane's FOLDED flag is a term, and the frame's stored height is still
 * not one. The two facts belong together. A stored height moves only when a
 * pointer is already writing the frame live, so a term for it would arm
 * windows full of no-ops; but folding is an arrangement gesture in every
 * sense that matters here — it re-pins the frame from the open card's tier to
 * the folded one ([P04]), and in a split column it re-allocates every
 * sibling — and the Last pass has always been willing to interpolate a real
 * height delta.
 *
 * Without the term the fold armed nothing except where some OTHER term
 * happened to move: a split column's allocation changes, so a wall folded on
 * the settle's clock, while the same card on a free pane or alone in a stacked
 * slot cut. The free pane looked animated only because `.tug-pane` carries the
 * [D07] window-shade ease, a 100ms snap underneath a 400ms interior collapse;
 * the stacked slot, whose height the imposer writes as geometry with no
 * transition, did not even have that. One gesture drew three different ways
 * depending on where the card happened to be standing.
 *
 * The flag rather than the resolved height, because the flag is what the
 * gesture writes and the height is what the layout derives from it: a term
 * reading the derived value would have to be recomputed here against the size
 * policy, the slot, and the column's allocation — three answers this function
 * does not otherwise need — and would go wrong exactly when one of them
 * changed. The frame's real before-and-after height is measured by the First
 * and Last passes, which is where a height belongs.
 *
 * The rail terms are read through `sidebarRailsOf`, which orders its members by
 * the imposition and by registration — never by the panes array. Until a rail
 * could be split that ordering was z-derived, which made this function's
 * documented z-blindness false of the rail term: activating a rail member
 * reordered `state.panes`, changed the term, and armed a settle window with no
 * frame to move in it. The same fix that keeps a split rail's members from
 * trading places on a click is what finally makes the claim above true here.
 *
 * A side's MODE and its ALLOCATED HEIGHTS are terms because both move frames: a
 * mode flip changes every member's height, and a seam drag changes two. The
 * heights are rounded to the pixel so sub-pixel allocation arithmetic cannot
 * arm a settle nobody can see — and they are the heights themselves rather
 * than the weights behind them, because that is what the frames are pinned at:
 * a rail crossing between sharing its run and stacking a strip moves every
 * member without any weight changing at all. A seam drag's own commit arms a
 * window whose tweens are all no-ops — the drag wrote the properties live, so
 * each frame's first and last rects are the same one — which is the
 * coexistence the rail width terms already have.
 *
 * A side's OFFSET is a term for the reason a column's is: past two members a
 * rail stops dividing and starts scrolling, and a reveal that slides its strip
 * moves every member's `top` while side, width, mode and order all hold still.
 *
 * The bullseye term is the DERIVED id, not the raw field, because that is
 * what the render path places from. Entering and leaving bullseye re-places
 * and re-widths a frame — a one-up placement at comfy on the way in, the
 * pane's own mode and width on the way out — which is exactly the kind of
 * moment the settle exists for. Reading the raw field would miss every
 * focus-shaped exit: clicking another pane ends bullseye through the
 * derivation with the field untouched, and that exit would cut rather than
 * cross. Deriving also keeps activation from arming a pointless window — the
 * term only moves while bullseye is actually on, which is exactly when there
 * is a frame to move.
 */
export function arrangementSignature(
  state: DeckState,
  runs: PlaceRuns,
): ArrangementSignature {
  // A DEPARTING pane is no term either: it has already left the arrangement
  // the survivors cross to, and the commit that finally unmounts it at the
  // land must arm no settle of its own.
  state = standingDeck(state);
  const paneTerms = state.panes
    // A pane still marked ARRIVING is no term of the arrangement, on the same
    // rule that keeps it out of its column's division ([B08]) and out of the
    // strip: it is drawn hidden at the seat it will take, so nothing about it
    // is on screen to cross to. With a term here the HIDDEN commit changed the
    // signature and armed a settle of its own — a whole arm, with First rects
    // measured and a beat launched over frames that had nowhere to go — a
    // commit before the arrival the reader actually watches. Its term appears
    // when its mark clears, which is the reveal, which is the one settle an
    // arrival is.
    .filter((pane) => state.arriving?.[pane.id] !== true)
    .map(
      (pane) => ({
        id: pane.id,
        slot: pane.slot ?? "",
        // Everything about the pane that is not its slot: the two terms that
        // decide how big the frame is drawn.
        size: `${pane.size.width}:${pane.folded === true ? "m" : ""}`,
      }),
    )
    // By id alone, which is exactly what the string sort here always was —
    // every term starts with the id and ids are unique, so no term after it
    // ever reached the comparison.
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const panes = paneTerms.map((pane) => `${pane.id}:${pane.slot}:${pane.size}`);
  const panesSize = paneTerms.map((pane) => `${pane.id}:${pane.size}`);
  const bullseye = bullseyePaneIdOf(state) ?? "";
  const rails = sidebarRailsOf(state, runs)
    .map(
      (rail) =>
        `${rail.side}:${rail.width}:${rail.members
          .map((m) => m.componentId)
          .join("+")}:${placeAllocationTerm(rail.allocation)}:${Math.round(
          state.railOffsets?.[rail.side] ?? 0,
        )}`,
    )
    .join(";");
  // The layout MODE is a term of its own, and the offset does not cover it.
  // Toggling fit↔flow moves every pane's `left` while kind, slots, widths,
  // rails and bullseye all hold still — and at rest the offset is 0 on both
  // sides of the toggle, so without this term the signature would not move,
  // no settle would arm, and the mode flip would CUT: the one gesture flow
  // exists to offer ([P10]).
  const layout = impositionLayout(state.imposition);
  // The offset, rounded to the pixel it is written at. Sub-pixel churn is not
  // an arrangement change, and the property carries the rounded value anyway.
  const flow = `${layout}:${Math.round(state.flowOffset ?? 0)}`;
  // The size half takes the mode and leaves the offset. A fit↔flow toggle
  // re-solves the chain and can land a frame at a different width; a slide
  // along the band is the gesture this arc exists for and changes no size at
  // all.
  const flowSize = layout;
  // A slot's MODE and its ALLOCATED HEIGHTS are terms for exactly the reasons a
  // rail's are: a split flip changes every member's height, and a seam drag
  // changes two. The pane terms above would not cover either — a flip moves no
  // pane between slots and changes no stored width, so without this the one
  // gesture the feature exists for would CUT.
  //
  // The MEMBER ORDER is a term too, and it is not redundant with the pane
  // terms: reordering a split column swaps two frames' vertical pins while
  // every pane keeps its slot and its width, so the sorted pane list is
  // identical either side of the move.
  //
  // And the OFFSET is a term for the reason flow's is: an overflowing column
  // reveals a member by sliding its strip, which moves every member's `top`
  // while slot, width and order all hold still. Rounded to the pixel it is
  // written at, so a reveal that computes no move arms nothing ([P12]).
  const columns = deckColumnsOf(state, runs.column)
    .filter((column) => column.mode === "split")
    .map(
      (column) =>
        `${column.slot}:${column.members.join("+")}:${placeAllocationTerm(
          column.allocation,
        )}:${Math.round(state.columnOffsets?.[column.slot] ?? 0)}`,
    )
    .join(";");
  const kind = state.imposition.kind ?? "";
  return {
    full: `${kind}|${flow}|${bullseye}|${rails}|${columns}|${panes.join(",")}`,
    // The rail and column terms stay in whole. Each carries an offset of its
    // own, and a strip that slides moves no frame's size — but each also
    // carries a mode and an allocation that move every member's HEIGHT, and
    // the terms are one string apiece. Keeping them is the conservative side
    // of the gate: an episode raised where none was needed costs what today
    // costs, where one skipped costs the reader their place.
    size: `${kind}|${flowSize}|${bullseye}|${rails}|${columns}|${panesSize.join(",")}`,
    sansOffset: `${kind}|${layout}|${bullseye}|${rails}|${columns}|${panes.join(",")}`,
  };
}
// ---- The arm: whether a commit settles, and how ----

/**
 * What a commit changed, read against the signature the last arm banked.
 * `unchanged` is a commit nothing the imposer reads moved in: the arm records
 * it and returns, and banks nothing.
 */
export type ArmChange =
  | { readonly unchanged: true }
  | {
      readonly unchanged: false;
      /**
       * The size half moved: a RESIZE, whose scrollers are walked and anchored
       * ([P07], [B06]). A pure flow slide leaves it alone and raises no episode.
       */
      readonly sizeChanged: boolean;
      /** Nothing moved but the flow offset: a pure slide along the band. */
      readonly flowOnly: boolean;
    };

export function readArmChange(
  banked: ArrangementSignature,
  next: ArrangementSignature,
): ArmChange {
  if (next.full === banked.full) return { unchanged: true };
  const sizeChanged = next.size !== banked.size;
  return {
    unchanged: false,
    sizeChanged,
    flowOnly: next.sansOffset === banked.sansOffset && !sizeChanged,
  };
}

export interface ArmPathInputs {
  /** The deck's motion setting: off is reduced motion. */
  readonly motionEnabled: boolean;
  /** A space switch is under way ([P02], Spec S02). */
  readonly switching: boolean;
  /** {@link ArmChange}'s `flowOnly`. */
  readonly flowOnly: boolean;
  /** The hand's velocity a trackpad lift handed over with the commit, or null. */
  readonly handVelocity: number | null;
  /** Where the strip is drawn: the per-frame writer's offset, or the store's last. */
  readonly flowOrigin: number;
  /** The offset the commit puts the strip at, rounded to the pixel. */
  readonly nextFlowOffset: number;
  /** Settle tweens still running. */
  readonly tweensRunning: number;
  /** First rects measured by an earlier arm whose Last pass has not run. */
  readonly firstRectsPending: number;
  /** Arrivals waiting on a Last pass. */
  readonly arrivalsPending: number;
}

/**
 * The path an arm that is not a cut takes. `motion` is whether anything
 * animates; `prelaunch` is a slide launched from the arm itself; `measure` is
 * the ordinary settle, which reads First rects here and launches its beats
 * from the Last pass.
 */
export interface ArmPath {
  readonly motion: boolean;
  readonly prelaunch: boolean;
  readonly measure: boolean;
}

export function armPath(inputs: ArmPathInputs): ArmPath {
  // Under reduced motion there will be no tween: the layout snap IS the
  // settle, and nothing is measured.
  //
  // A switch epoch is reduced motion for the length of one switch, and that
  // is the whole of [P02]'s enforcement. It reaches the same branch rather
  // than the cut's because the two say different things: a cut says the
  // frames have not moved, and this says they have moved and must not be
  // seen to.
  const motion = inputs.motionEnabled && !inputs.switching;
  // Launch the move from the arm only for a strip a HAND let go of: a
  // trackpad lift that handed its velocity over with the commit, when nothing
  // else is in flight and the whole change is the strip's offset. Every other
  // slide — a click, a key, a wheel that ended on its quiet — is set up and
  // then goes, like every other gesture ([B06] of set-up-and-go).
  const prelaunch =
    motion &&
    inputs.flowOnly &&
    inputs.handVelocity !== null &&
    inputs.flowOrigin !== inputs.nextFlowOffset &&
    inputs.tweensRunning === 0 &&
    // Nothing MEASURED and unrendered ([B02]). A First rect standing here is
    // an earlier arm in this same task whose Last pass has not run — two
    // commits in one task produce two synchronous arms and, under the
    // deferral, ONE coalesced React commit. Without this clause the second
    // arm takes the prelaunch path and throws away the first arm's
    // measurement, so every frame the first commit moved CUTS
    // (`hideSidebarRail`, and the flow retune after a rail retune [F03]).
    //
    // A prelaunch is a beat planned from the store delta alone, and it is
    // only valid when no beat is waiting on the DOM.
    inputs.firstRectsPending === 0 &&
    inputs.arrivalsPending === 0;
  return { motion, prelaunch, measure: motion && !prelaunch };
}

// ---- The beats: what launches, in what order, under what budget ----

/**
 * The recipe each beat of a settle plays on. The move beat IS the crossing —
 * the settle the whole choreography is measured against — and the two resize
 * beats have recipes of their own in `lib/imposer-motion.ts`.
 *
 * The two outer beats are fades and share `divide-join`: a frame appearing in
 * a place or leaving one is carried by opacity rather than by travel, so what
 * it needs from a recipe is a window rather than a spring. A column mode flip
 * is not one of them — it is a cover, not a fade ([B02] of
 * `briefs/column-flip-cover-brief.md`), so its survivor rides the fused beat
 * and its other members hold still.
 */
export const BEAT_RECIPE: Record<BeatKind, MotionRecipe> = {
  depart: "divide-join",
  // The fused beat IS the crossing, for the move beat's reason: it is the one
  // motion the settle is measured against, and a settle that carries an
  // arrival or a departure runs its whole geometry on that one clock ([P08]).
  room: "crossing",
  shrink: "shrink",
  move: "crossing",
  grow: "grow",
  arrive: "divide-join",
};

/**
 * The beat kinds a settle launches, in {@link BEAT_ORDER}. A beat no frame has
 * a term in is skipped, so the everyday stack move is one move beat and
 * nothing else ([B01], [B02]).
 *
 * A kind counts when some frame plans a beat of it OR — for the outer two,
 * which no frame plans — when anything is arriving or departing. Leaving them
 * out would size the window to the middle three alone and fire the sweep and
 * the hold's cap mid-choreography.
 */
export function launchedBeats(
  planned: readonly (readonly { readonly kind: BeatKind }[])[],
  arrivals: number,
  departures: number,
): BeatKind[] {
  return BEAT_ORDER.filter((kind) => {
    if (kind === "depart") return departures > 0;
    if (kind === "arrive") return arrivals > 0;
    return planned.some((beats) => beats.some((b) => b.kind === kind));
  });
}

export interface ScheduleInputs {
  /** {@link launchedBeats}. */
  readonly launched: readonly BeatKind[];
  /** Panes arriving in this settle. */
  readonly arrivals: number;
  /** A frame's interior width settles at its final size in this settle. */
  readonly widthSettles: boolean;
  /** This settle OPENED a fold crossing, rather than adopting one mid-travel. */
  readonly opensFoldCrossing: boolean;
  /** The settle's nominal duration (ms), unscaled by the deck's timing. */
  readonly durationMs: number;
}

/** One beat of {@link BEAT_ORDER}, with the delay it is created at. */
export interface ScheduledBeat {
  readonly kind: BeatKind;
  /** Whether any frame is on this beat; an unlaunched beat runs empty. */
  readonly launched: boolean;
  /** Held off by the prepare beat and every launched beat before it (ms). */
  readonly delayMs: number;
}

export interface SettleSchedule {
  /**
   * The gate closes after the prepare's frames rather than in this one: an
   * arrival's, or a frame whose width settles.
   */
  readonly lateClose: boolean;
  /** The prepare beat the frames stand at First for, before any beat (ms). */
  readonly prepareMs: number;
  /** Every kind of {@link BEAT_ORDER}, in order, with its delay. */
  readonly beats: readonly ScheduledBeat[];
  /** The prepare beat plus every launched beat's duration (ms, unscaled). */
  readonly totalMs: number;
}

/**
 * The settle's timeline. Every beat's effect is created in the same frame,
 * each held off by the sum of the durations of the launched beats before it,
 * so beat N+1's first active frame is the frame beat N's last one ends in —
 * no seam between them waits on a compositor (`at0566`).
 */
export function planSettleSchedule(inputs: ScheduleInputs): SettleSchedule {
  // A FOLD'S PREPARE BEAT: a fold's commit changes the card's interior, and
  // what answers that change arrives a frame later — observers' rAF-coalesced
  // writes, the after-paint React notify. Left to land under the tween they
  // held the main thread 30–47ms right after the first moving frame. So a
  // settle that opens a fold crossing holds every beat off by this much: the
  // frame stands at First for the frame those answers land in, and the edge
  // starts on the frame after. A crossing this settle merely adopted is
  // already travelling and pays nothing.
  //
  // An ARRIVAL takes a prepare beat for the same reason, one frame longer:
  // the revealed card is laid out for the first time in the frame after its
  // commit, and the observers its passive effects attach after that paint
  // deliver in the frame after that ([B05] of set-up-and-go-fixups). So does
  // a frame whose WIDTH settles at its final size: its interior re-flows at
  // the new width in the set-up, and its observers answer in the same frames.
  const lateClose = inputs.arrivals > 0 || inputs.widthSettles;
  const prepareMs = lateClose
    ? ARRIVAL_PREPARE_MS
    : inputs.opensFoldCrossing
      ? FOLD_PREPARE_MS
      : 0;
  const beats: ScheduledBeat[] = [];
  let delayMs = prepareMs;
  for (const kind of BEAT_ORDER) {
    const launched = inputs.launched.includes(kind);
    beats.push({ kind, launched, delayMs });
    if (launched) delayMs += motionDurationMs(BEAT_RECIPE[kind], inputs.durationMs);
  }
  return { lateClose, prepareMs, beats, totalMs: delayMs };
}

/**
 * The cap on a hold sized against `windowMs` of motion: twice the window at
 * the deck's timing scale, and never under a second. A wedge guard behind the
 * release that normally opens the hold, so it must never fire mid-motion.
 */
export function holdCapMs(windowMs: number, timing: number): number {
  return Math.max(2 * windowMs * timing, 1000);
}
