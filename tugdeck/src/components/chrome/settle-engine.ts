/**
 * settle-engine.ts — the deck's settle, out of the canvas.
 *
 * When the arrangement changes, every frame it moves crosses to its new place
 * rather than cutting: `arm` reads where the frames stand on the near side of
 * the commit (First), the Last pass measures where they landed and plays the
 * crossing as the deck's beats — `depart`, `room`, `shrink`, `move`, `grow`,
 * `arrive` — and the window sweep, the drain and the inline restorers hand
 * back everything a settle took, on every way out of one. The whole of that is
 * here, together with the refs a settle's state lives in, because those refs
 * are shared by every part of it.
 *
 * The canvas instantiates the engine once with {@link useSettleEngine}, at the
 * point in its body the settle always ran, so the order of its hooks and its
 * effects is the order they always had. The canvas keeps its whole-snapshot
 * `useSyncExternalStore` and hands the engine the snapshot, the measured
 * runs, its container and the store; the engine hands back the two records
 * the workspace switch reads.
 *
 * Nothing here is React state ([L06]): the settle writes the DOM and drives
 * TugAnimator ([L13]).
 *
 * @module components/chrome/settle-engine
 */

import type { RefObject } from "react";
import { useCallback, useRef, useLayoutEffect } from "react";
import { afterGesture, gestureScope } from "@/lib/gesture-scope";
import {
  planBeat,
  type Beat,
  type BeatOptions,
  type BeatRow,
  type BeatTarget,
  type TugAnimation,
  timelineMark,
} from "@/components/tugways/tug-animator";
import {
  beginResizeEpisode,
  type ResizeEpisodeHandle,
} from "@/lib/resize-episode";
import {
  contentBoxHeight,
  contentBoxWidth,
  ARRIVAL_PREPARE_MS,
  FOLD_PREPARE_MS,
  adoptFoldCrossing,
  adoptStillCrossing,
  announceStillCrossingSettled,
  endFoldCrossing,
  endStillCrossing,
  FOLD_CROSSING_ATTR,
  holdStillWidth,
  markFoldCrossing,
  markStillCrossing,
  settleStillCrossing,
  STILL_SETTLED_ATTR,
} from "@/lib/fold-crossing";
import {
  getTugTiming,
  isTugMotionEnabled,
} from "@/components/tugways/scale-timing";
import {
  deckTrace,
  type CommitLanding,
} from "@/deck-trace";
import type { IDeckManagerStore } from "@/deck-manager-store";
import {
  bullseyePaneIdOf,
  deckColumnsOf,
  placeAllocationTerm,
  type PlaceRuns,
  sidebarRailsOf,
} from "@/deck-store-selectors";
import type { DeckState, TugPaneState } from "@/layout-tree";
import {
  predictHeightCrossings,
  type HeightArrangement,
} from "@/lib/height-crossing-prediction";
import { standingDeck } from "@/lib/departing";
import {
  SETTLE_TAKE_EVENT,
  SETTLE_TAKE_FLOW_EVENT,
  type SettleTakeDetail,
  type SettleTakeFlowDetail,
} from "@/lib/settle-take";
import { cardServicesStore } from "@/lib/card-services-store";
import {
  classifyLand,
  classifyMotionEvents,
  landOpensAt,
  landRecorder,
} from "@/lib/land-frame-record";
import { scheduleAfterPaint, type CancelAfterPaint } from "@/lib/after-paint";
import { useCardLifecycle } from "@/lib/card-lifecycle";
import {
  MAX_FLIP_SCALE_DISTORTION,
  BEAT_ORDER,
  beatLaunchVelocity,
  flipDelta,
  planSettleBeats,
  scaleDistortion,
  springSettleKeyframes,
  type BeatKind,
  type HeldTerms,
  type InterruptedBeat,
  type SettleBeat,
} from "@/lib/pane-flip";
import {
  classifySettleFrames,
  sampleSettleFrame,
  type SettleFrameSample,
} from "@/lib/settle-frame-probe";
import {
  dispatchImposerSettleEnd,
} from "@/lib/settle-notice";
import {
  motionDurationMs,
  motionForwardVelocityLimit,
  motionKeyframes,
  motionLaunchVelocity,
  velocityAt,
  type MotionCurve,
  type MotionRecipe,
} from "@/lib/imposer-motion";
import {
  dropPendingFlash,
} from "@/lib/flash-pane-border";
import { tugDevLogStore } from "@/lib/tug-dev-log-store/tug-dev-log-store";
import {
  FLOW_OFFSET_FRAME_READERS,
  writeCanvasFlowOffset,
} from "./flow-offset";
import {
  SHOWN_PANE_FRAMES,
  SPACE_SWITCHING_ATTRIBUTE,
} from "./space-layer";
import { mark as perfMark } from "@/lib/perf-marks";
import {
  isSidebarSide,
  type ColumnMode,
  IMPOSITION_SETTLE_MS,
  readSettleMs,
  PANE_ENTER_RISE_PX,
  impositionLayout,
  type SidebarSide,
} from "@/lib/layout-imposer";

/**
 * The registry key a side's shadow strip settles under. The strip is not a
 * pane, but it is held, measured, carried and handed back exactly as a frame
 * is — it is the depth of the rail beside it, and a shadow that moves on any
 * clock but its rail's has come away from the panel. The prefix is what lets
 * `arm` find the strips' entries among the frames'.
 */
const RAIL_SHADOW_TWEEN_PREFIX = "rail-shadow:";

/**
 * The rail shadow strips that STAND. Every side's strip is always mounted: a
 * parked rail's is hidden (`data-rail-parked`), and a side with no rail at all
 * holds an empty one (`data-rail-empty`). The settle reads both as gone — the
 * way `SHOWN_PANE_FRAMES` reads its frames — so a hide carries the strip out
 * with the panel on its own element, and the show brings it in as an arrival.
 */
const STANDING_RAIL_SHADOWS =
  "[data-rail-shadow]:not([data-rail-parked]):not([data-rail-empty])";
function railShadowTweenKey(side: SidebarSide): string {
  return `${RAIL_SHADOW_TWEEN_PREFIX}${side}`;
}

/**
 * How far a rail standing at `rect` must travel to clear `side`'s edge of the
 * canvas — negative for a left rail, positive for a right one.
 *
 * Measured to the CONTAINER's edge rather than taken as the frame's own width,
 * because a rail stands one `RAIL_EDGE_INSET` in from that edge and a slide
 * short by the inset would leave a sliver parked against the window. Past the
 * edge it is clipped, which is what makes the disappearance the edge's doing
 * rather than an opacity's.
 */
function railTravelPx(rect: DOMRect, side: SidebarSide, canvas: DOMRect): number {
  return side === "left"
    ? -(rect.right - canvas.left)
    : canvas.right - rect.left;
}

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
interface ArrangementSignature {
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
function arrangementSignature(
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

/**
 * Capture a frame's own inline value for `property` and return the hand-back.
 *
 * The settle's size and fade tweens ride real properties, and TugAnimator
 * commits an animation's final value into `el.style` on completion — a baked
 * pixel length where React rendered `auto` or a `calc()` would freeze the
 * frame against the live expressions its geometry keeps reading (a seam drag,
 * a window resize). The restorer runs in the settle's completion handler,
 * after that commit lands.
 *
 * It is the only inline hand-back on this canvas now. The switch used to need a
 * second one that YIELDED — a frame whose workspace came back on screen mid-beat
 * belongs to React, not to the writer that froze it — and the cut removed the
 * freeze and with it the only caller ([B01], [P04]).
 */
function inlineRestorer(
  el: HTMLElement,
  property: "width" | "height" | "opacity" | "transform" | "transform-origin",
): () => void {
  const prev = el.style.getPropertyValue(property);
  return () => {
    if (prev === "") el.style.removeProperty(property);
    else el.style.setProperty(property, prev);
  };
}

/**
 * Take the settle's marks off the container and its frames — after ONE forced
 * style flush.
 *
 * The flush is the whole of this function, and it is not a tidiness: the
 * settle's LAST write is the inline residue coming off its frames, and that
 * write lands in the same task as these marks. `chrome.css` stands the frame's
 * window-shade `transition: height` down for exactly the length of this window
 * (`.tug-pane[data-imposer-settling]`) so no second clock runs on a height
 * the settle is tweening — but a style recalc that sees the hand-back also
 * sees the marks gone, so the transition it resolves against is the LIVE one
 * and it arms on the hand-back itself.
 *
 * What that looked like is the fold: the frame is held inline at its open
 * height for the crossing's length ([B01] of `three-beat-settle` holds every
 * size term at First until its beat runs), the tween carries the edge down to
 * the tier, and the hand-back then walks the frame from the one to the other
 * on the shade's own 100ms — a card that has finished folding flashing back to
 * full height and collapsing a second time, after the settle was over.
 *
 * Reading a layout property flushes style and layout, so the hand-back is
 * resolved while the stand-down still stands: the frame settles at its
 * committed height with no transition to arm, and taking the marks off after
 * changes no property anybody can transition. One flush per settle, at a
 * moment nothing else is pending.
 */
function endSettleMarks(el: HTMLElement): void {
  void el.offsetHeight;
  takeSettlingMarkOff(el);
  el.removeAttribute("data-imposer-beat");
}

/**
 * The settle's mark goes on the container, for every reader that asks "is a
 * settle in flight", AND on each shown frame, for the one stylesheet rule that
 * keys on it (`chrome.css`, `.tug-pane[data-imposer-settling]`: the height
 * shade standing down).
 *
 * The frame carries its own copy because of what the rule used to cost. Keyed
 * on the CONTAINER's attribute — `[data-imposer-settling] .tug-pane` — a rule
 * that restyles descendants on an ancestor's attribute makes the engine walk
 * every descendant of that ancestor to find the ones to invalidate, on every
 * toggle. On a six-session deck of 23,000 elements that walk read 25ms each
 * way, paid inside the gesture's own task at the arm and again in the frame
 * that lands the settle — the two frames a fold could least afford. A rule
 * whose attribute is on the element it styles invalidates that element alone,
 * and toggling the container's copy, which no stylesheet reads any more,
 * costs nothing.
 */
function putSettlingMarkOn(el: HTMLElement): void {
  el.setAttribute("data-imposer-settling", "");
  for (const frame of el.querySelectorAll<HTMLElement>(SHOWN_PANE_FRAMES)) {
    frame.setAttribute("data-imposer-settling", "");
  }
}

/** {@link putSettlingMarkOn}'s inverse: the container's mark and every frame's. */
function takeSettlingMarkOff(el: HTMLElement): void {
  el.removeAttribute("data-imposer-settling");
  for (const frame of el.querySelectorAll<HTMLElement>(
    ".tug-pane[data-imposer-settling]",
  )) {
    frame.removeAttribute("data-imposer-settling");
  }
}

/** One pane's in-flight settle: its tweens and the inline residue they owe back. */
interface SettleTween {
  el: HTMLElement;
  anims: TugAnimation[];
  restores: Array<() => void>;
}

/**
 * One element the `depart` beat carries out ([P06]). `closing` is a closed
 * pane's own frame, kept mounted by the store until the settle lands;
 * `parked` is a rail frame whose rail was hidden whole, shown only for its
 * exit; `strip` is a side's rail shadow. `restores` hands back every inline
 * write and mark the Last pass made on it.
 */
interface DepartingTarget {
  el: HTMLElement;
  kind: "closing" | "parked" | "strip";
  launched: boolean;
  restores: Array<() => void>;
  /** The depart beat's animation on this target, once it is launched. */
  anims?: TugAnimation[];
}

/** The mark a departing target wears for the length of its beat — the one
 *  selector every reader of a departure finds it by. */
const SETTLE_DEPARTING_ATTR = "data-settle-departing";

/**
 * The most ticks the land's tail reads past the release while it waits for a
 * settled mark to come off. The mark comes off in the land's own task, so the
 * tail is two ticks unless a hand-back was deferred; eight frames is room for
 * any deferral worth reading and short enough that a stranded mark cannot keep
 * the tail alive.
 */
const LAND_TAIL_CAP_TICKS = 8;

/**
 * A departing target's landing ([P06], Spec S02 step 7). A CLOSING frame
 * keeps its hold and goes to an inline `opacity: 0`: its fade has ended (or
 * never ran) and `fill: none` would otherwise hand it back at full opacity
 * until the store's land unmounts it. Its mark comes off with the beat, so
 * `[data-settle-departing]` names exactly what a beat is carrying. Every
 * other kind runs its restorers, which take the mark and the holds off.
 */
function landDepartingTarget(target: DepartingTarget): void {
  if (target.kind === "closing") {
    target.el.style.opacity = "0";
    target.el.removeAttribute(SETTLE_DEPARTING_ATTR);
    return;
  }
  for (const restore of target.restores) restore();
}

/**
 * End the crossing on every frame a retarget took over that the settle
 * replacing it does not carry on, and forget them all.
 *
 * A crossing is ended by the completion of the settle that opened or adopted
 * it, and a retarget's generation bump turns the interrupted settle's
 * completion into a no-op. So a frame the replacement settle takes over has
 * exactly two futures: the new Last pass adopts its crossing under a fresh id
 * — it carries the frame with a height term — or nothing ever ends it, and the
 * card stands held at a box it no longer has with its end never announced.
 * A covered member of a flipped column, a frame that only slides, an arrival
 * and a departure are all the second case. `carried` is the first: every
 * frame this settle holds a still crossing for, which every adopted fold is
 * too ([L32]: one path ends a crossing on every exit).
 */
function endCrossingsNotCarried(
  frames: Set<HTMLElement>,
  carried: ReadonlySet<HTMLElement> = new Set(),
): void {
  for (const frame of frames) {
    if (carried.has(frame)) continue;
    endFoldCrossing(frame);
    endStillCrossing(frame);
  }
  frames.clear();
}

/**
 * End the still crossing `arm` opened on every frame the Last pass did not go
 * on to carry, and forget them all.
 *
 * `arm` holds a frame from the store's word alone: the frame the new
 * arrangement will resize is held at its First content height before React
 * commits that arrangement, so the commit's height change never reaches the
 * interior. The Last pass confirms each with a re-mark (never lowering) when
 * the frame really carries a height term, and from then on the tween that
 * carries it owns the end. A frame it never confirmed — the prediction
 * over-marked it, or a path out of the pass carried nothing — is ended here,
 * on that path, and announces its end like every other ([L32]).
 *
 * Each frame is ended by the door `arm` opened it with: a frame whose folded
 * state flips was opened as a fold crossing — both marks, so a fold's still
 * mark is never on without its fold mark and the card's picture never hangs
 * from the wrong edge — and is ended as one, which announces the fold's end
 * to whatever is waiting on it. Every other frame was opened as a still
 * crossing, and a fold standing from an earlier settle is that settle's to end.
 */
function endArmHeldNotCarried(
  frames: Map<HTMLElement, "fold" | "still">,
  carried: ReadonlySet<HTMLElement> = new Set(),
): void {
  for (const [frame, kind] of frames) {
    if (carried.has(frame)) continue;
    if (kind === "fold") endFoldCrossing(frame);
    else endStillCrossing(frame);
  }
  frames.clear();
}

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
const BEAT_RECIPE: Record<BeatKind, MotionRecipe> = {
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

/** Where a settle's beats write their rows: the deck's trace, beside the
 *  settle's own frame record. */
function recordBeat(row: BeatRow): void {
  deckTrace.record({ kind: "settle-beat", ...row });
}

/**
 * What a beat holds still, as the frame's inline style: the constant
 * transform a resize beat wears while the move has not yet run, and the First
 * size of an axis whose grow beat is still to come. Inline rather than a
 * keyframe, so a move beat's effect stays transform-only and accelerated. The
 * settle's restorers and `clearFlip` take every one of these off at the end.
 */
function heldPose(held: HeldTerms): Record<string, string> {
  const pose: Record<string, string> = {};
  if (held.transform !== undefined) {
    const { dx, dy, sx } = held.transform;
    const move = `translate(${dx}px, ${dy}px)`;
    pose.transform = sx === 1 ? move : `${move} scaleX(${sx})`;
  }
  if (held.width !== undefined) pose.width = `${held.width}px`;
  if (held.height !== undefined) pose.height = `${held.height}px`;
  return pose;
}

function applyHolds(frame: HTMLElement, held: HeldTerms): void {
  for (const [prop, value] of Object.entries(heldPose(held))) {
    frame.style.setProperty(prop, value);
  }
}

/** What the canvas hands the settle: the snapshot it rendered, the runs it
 *  measured, the element the settle marks, and the store `arm` subscribes to. */
export interface SettleEngineDeps {
  store: IDeckManagerStore;
  deckState: DeckState;
  placeRuns: PlaceRuns;
  containerRef: RefObject<HTMLDivElement | null>;
  /**
   * The arrangement the canvas rendered `deckState` with — the near side of
   * the height prediction `arm` makes.
   */
  shownArrangement: HeightArrangement<TugPaneState>;
  /**
   * The canvas's own derivation, for the far side: the arrangement a deck will
   * render at the given run heights. Handed in rather than imported, so the
   * settle reads exactly what the canvas will render.
   */
  deriveArrangement: (
    deck: DeckState,
    placeRuns: PlaceRuns,
  ) => HeightArrangement<TugPaneState>;
}

/**
 * The deck's settle. Called once, by the canvas, where the settle has always
 * run in its body.
 *
 * Returns the two records the canvas's workspace switch reads: the arrivals
 * still pending their beat, which the switch sweeps, and the count of
 * arrangement commits `arm` has seen, which the switch's quiet gate reads.
 */
export function useSettleEngine({
  store,
  deckState,
  placeRuns,
  containerRef,
  shownArrangement,
  deriveArrangement,
}: SettleEngineDeps) {
  // ---------------------------------------------------------------------------
  // Settling into a new arrangement
  // ---------------------------------------------------------------------------
  // A change to the ARRANGEMENT moves derived frames without anyone touching
  // them: a rail crossing to the other side, an N-up swap, the pin coming
  // back, a card sent to another slot. The frames cross to their new places
  // rather than cutting, and the crossing is FLIP: React commits the final
  // geometry in one layout pass, and each moved frame is then tweened by a
  // transform that starts at the inverse of the move and ends at nothing.
  // Appearance only, written straight to the DOM, never through React state
  // ([L06]); the motion itself goes through TugAnimator ([L13]).
  //
  // FLIP rather than a transition on `left`/`top`/`width` because transitioning
  // layout properties re-runs layout for every moving frame on every frame of
  // the motion. A transform tween in the accelerated form (`lib/pane-flip.ts`
  // holds the rules) costs one compositing walk when it starts, one when it
  // ends, and nothing in between — see
  // `arc/jul30-perf-brief.md#i1-sparkline-exception`.
  //
  // The trigger is a signature over exactly what the imposer reads — the
  // record, plus which pane holds which slot. Watching the record alone would
  // make a slot assignment animate or cut depending on whether it happened to
  // land inside some earlier change's window, and a gesture that sometimes
  // crosses and sometimes jumps is worse than one that always jumps.
  //
  // The work is split across a store subscriber and a layout effect because
  // FLIP needs both sides of the commit. A store subscriber runs BEFORE the
  // re-render it causes, so it is the only place that can see where the frames
  // are now (First); the layout effect runs after the commit and before paint,
  // so it is where they can be measured in their new places (Last). Nothing is
  // painted between the two, which is what makes the inversion invisible.
  //
  // The timing lives in one place: `IMPOSITION_SETTLE_MS` reaches CSS as
  // `--tugx-imposer-settle-duration` and the resolved value is read back, so an
  // override on the container retimes the tween and the attribute together.
  // What `animate()` is handed is that RAW number, because TugAnimator scales
  // its own durations by `getTugTiming()`; the window timer is handed the
  // scaled product, so the two can never disagree.
  const arrangementSig = arrangementSignature(deckState, placeRuns);
  // The placement memo reads the FULL signature: it re-places every frame, and
  // a pure slide is exactly a re-placement.
  const arrangement = arrangementSig.full;
  const arrangementRef = useRef(arrangement);
  /**
   * The size half, as `arm` last saw it. What decides whether a commit is a
   * RESIZE — and therefore whether the scrollers under it are walked and
   * anchored ([P07], [B06]). A pure flow slide leaves this string alone and
   * raises no episode.
   */
  const sizeSignatureRef = useRef(arrangementSig.size);
  /** The offset-less signature as `arm` last saw it. */
  const sansOffsetRef = useRef(arrangementSig.sansOffset);
  /** The flow offset as `arm` last saw it, rounded as it is written. */
  const flowOffsetRef = useRef(Math.round(store.getSnapshot().flowOffset ?? 0));
  /** The move beat `arm` launched ahead of React, if one is up ([D204]), and
   *  how to take the strip from it: hold it where it is on screen, land the
   *  settle there, and answer the offset that pose is. */
  const prelaunchRef = useRef<{ token: object; take: () => number } | null>(
    null,
  );
  const settleTimerRef = useRef<number | null>(null);
  /**
   * Re-arms the settle's window sweep — the timer that takes the settling
   * mark off and snaps whatever is still in flight. `arm` writes it and arms
   * the sweep at the crossing's nominal; the Last pass re-arms it once it
   * knows the choreography, whose window is the sum of its beats and can be
   * longer than any one recipe's. Takes SCALED milliseconds.
   */
  const settleSweepRef = useRef<((windowMs: number) => void) | null>(null);
  /**
   * Releases the session stores' notification hold, once per settle, and
   * records which clock did it. The settle's own completion is the release
   * on the normal path — after the final beat's last tween, on the far side
   * of every frame's residue, fold crossing and resize episode ([B04] of
   * `three-beat-settle`); the window sweep and the unmount are the guards
   * behind it. `settleReleasedRef` is what makes the three one release:
   * whichever fires first releases, and the others find nothing to do.
   */
  const settleReleaseRef = useRef<
    ((source: "completion" | "sweep" | "unmount") => void) | null
  >(null);
  const settleReleasedRef = useRef(true);
  /**
   * The settle's own frame-gap sampler ([B10], [P09]).
   *
   * `samples` collects one reading per rendering opportunity for the length of
   * a settle and nothing else; `raf` is the pump's handle, and its being
   * `null` at rest is the whole of this record's [D1] compliance — the pump
   * is armed by the same commit that marks the canvas and is cancelled by the
   * release, so a settled deck holds no timer and no animation frame on its
   * account.
   */
  const settleFramesRef = useRef<{
    samples: SettleFrameSample[];
    raf: number | null;
    /** When the pump started, and when the user asked — the record's two
     *  origins, held on the RECORD because they belong to the window rather
     *  than to whichever arm happened last ([P01], [P02]). */
    armedAt: number | null;
    gestureAt: number | null;
    /**
     * The stamp this record has already spent, so no second settle can spend
     * it again.
     *
     * The store's stamp is written by a committing fold and never retired —
     * nothing knows when it has been read. The staleness guard below cannot
     * stand in for that: it rejects a stamp older than five seconds, and the
     * settle that follows a fold by a second or two carries one that is
     * fresh and belongs to somebody else. Left unguarded, a pane drag a
     * second after a fold reports a second of dead lead it never had, in the
     * one row [D9]'s guard and the settle app-tests both read.
     */
    consumedGestureAt: number | null;
    /**
     * The land's tail: the two ticks after the release that close the frame
     * the hand-back paid for (`lib/land-frame-record.ts`). `finish` writes the
     * `settle-land` row early, with whatever ticks it has, when another
     * settle arms before the tail is done — the recorder is one per document.
     */
    land: { raf: number | null; finish: (() => void) | null };
    /**
     * When the motion gate last closed — the beats' launch, the motion's own
     * origin — or `null` when no gate closed in this window. The motion is
     * the beats that landed, so a retarget's later close is the one kept.
     */
    motionAt: number | null;
  }>({
    samples: [],
    raf: null,
    armedAt: null,
    gestureAt: null,
    consumedGestureAt: null,
    land: { raf: null, finish: null },
    motionAt: null,
  });

  /**
   * The motion gate ([B05] of set-up-and-go): every store's React-facing
   * notify is held from the first frame to the land, through the one door
   * they all go through (`lib/gesture-scope.ts`). It closes when the beats
   * launch — the set-up's commit is in by then, since the Last pass is that
   * commit's layout effect — and opens on three edges:
   *
   * - **The land**, after the land's frame and the one that pays for it, so
   *   what was held lands after the hand-back rather than in it: the land
   *   task runs ahead of the frame callbacks, and the first paint after it
   *   still carries the layout it dirtied (`lib/land-frame-record.ts`).
   * - **A retarget**, at once: a gesture that arrives mid-motion runs its own
   *   set-up, and what the gate held joins it rather than its motion.
   * - **Unmount**, at once: nobody is left to land.
   *
   * The deck store keeps its own tells out of the door, so it checks the
   * gate itself: a deck commit that moves a settle opens the gate in its
   * arm, and one that moves none — the same gate still closed after its
   * arm — is held behind it (`DeckManager.notify`).
   */
  const motionGateRef = useRef<{
    release: (() => void) | null;
    cancelOpen: CancelAfterPaint | null;
    cancelClose: CancelAfterPaint | null;
  }>({ release: null, cancelOpen: null, cancelClose: null });
  const openMotionGate = useCallback((): void => {
    const gate = motionGateRef.current;
    gate.cancelOpen?.();
    gate.cancelOpen = null;
    gate.cancelClose?.();
    gate.cancelClose = null;
    const release = gate.release;
    gate.release = null;
    release?.();
    if (release !== null) deckTrace.record({ kind: "settle-gate", phase: "open" });
  }, []);
  const closeMotionGate = useCallback(
    (capMs: number): void => {
      openMotionGate();
      // The cap drops the handle too, so a capped gate leaves the state an
      // opened one does and the trace records one open per close.
      const release = gestureScope.holdMotion(capMs, () => {
        const gate = motionGateRef.current;
        if (gate.release !== release) return;
        gate.cancelOpen?.();
        gate.cancelOpen = null;
        gate.release = null;
        deckTrace.record({ kind: "settle-gate", phase: "open" });
      });
      motionGateRef.current.release = release;
      // The motion's origin is stamped after the closing task's synchronous
      // work, not here. The Last pass closes the gate from inside the set-up
      // commit's layout effects, and the commit census stamps that commit
      // when it ends — after this line — so an origin taken here would read
      // the set-up's own commit as the motion's first.
      queueMicrotask(() => {
        if (motionGateRef.current.release === null) return;
        settleFramesRef.current.motionAt = performance.now();
        deckTrace.record({ kind: "settle-gate", phase: "close" });
      });
    },
    [openMotionGate],
  );
  /**
   * Close the gate two paints late, for a settle whose set-up runs into its
   * first frames: an arrival's revealed card is laid out for the first time
   * in the frame after its commit, and the observers its passive effects
   * attach after that paint deliver in the frame after that. The beats are
   * held off by the arrival's prepare beat across both, so those frames stand
   * at First and the motion opens on the frame after, sealed.
   */
  const closeMotionGateAfterPaint = useCallback(
    (capMs: number): void => {
      openMotionGate();
      const gate = motionGateRef.current;
      // And not while the gesture's own scope is still pending: its release
      // runs after a paint too, and the store tells it holds commit there —
      // set-up work, which would otherwise land just behind the gate.
      const tryClose = (): void => {
        if (gestureScope.isPending()) {
          gate.cancelClose = scheduleAfterPaint(tryClose);
          return;
        }
        gate.cancelClose = null;
        closeMotionGate(capMs);
      };
      gate.cancelClose = scheduleAfterPaint(() => {
        gate.cancelClose = scheduleAfterPaint(tryClose);
      });
    },
    [openMotionGate, closeMotionGate],
  );
  const openMotionGateAfterLand = useCallback((): void => {
    const gate = motionGateRef.current;
    // A late close still waiting on its paints is owed nothing now: the
    // settle it was for has landed. Left standing, it would close the gate
    // after the motion, and every tell would wait out the cap.
    gate.cancelClose?.();
    gate.cancelClose = null;
    if (gate.release === null) return;
    gate.cancelOpen?.();
    // Three paints, not two: a release fires from an animation's finish,
    // inside a frame's update, so the first paint is that same frame's. Two
    // let the held work in at the start of the frame that closes the land,
    // which the land then paid for ([B05] of set-up-and-go-fixups).
    gate.cancelOpen = scheduleAfterPaint(() => {
      gate.cancelOpen = scheduleAfterPaint(() => {
        gate.cancelOpen = scheduleAfterPaint(openMotionGate);
      });
    });
  }, [openMotionGate]);
  /**
   * Which launch the running choreography belongs to. A beat's completion
   * launches the next beat, and a retarget that landed in between has already
   * cancelled, restored and re-planned every frame — so a chain that outlives
   * its launch must stop rather than put a stale beat on a frame another
   * settle now owns. Bumped by every Last pass that launches.
   */
  const settleGenerationRef = useRef(0);
  /** Where each non-gesturing frame sat before the commit, by pane id. */
  const settleFirstRectsRef = useRef<Map<string, DOMRect>>(new Map());
  /**
   * The fold facts each frame carried before the commit, by pane id — whether
   * it was folded, and how tall its content box was.
   *
   * Kept apart from `settleFirstRectsRef` because the rect map is read by the
   * departing targets and by `flipDelta`, and neither has anything to do with
   * the fold. These two are read once, by the tween pass, to decide whether a
   * frame is crossing the fold and what height to hold its interior at
   * ([B04] of `session-fold-still-interior`).
   *
   * The content height is the box's, not the frame's, because that is the box
   * the held interior overflows; the difference between the two is chrome that
   * the fold does not move.
   */
  const settleFirstFoldsRef = useRef<
    Map<
      string,
      { folded: boolean; contentHeight: number | null; contentWidth: number | null }
    >
  >(new Map());
  /**
   * Which edge each frame stood pinned to before the commit, by pane id —
   * `data-rail-side`, read at arm and absent for every frame that is not a
   * rail.
   *
   * Read by the depart beat alone, and read there because that is the one
   * question a departing frame cannot answer for itself: a parked frame has
   * already left the arrangement and a closing one is outside the solver, so
   * the side it stood on is only knowable from the near side of the commit.
   * An arriving rail is not in this map and does not need to be — its own
   * frame is in the document and carries the attribute.
   */
  const settleFirstRailSidesRef = useRef<Map<string, SidebarSide>>(new Map());
  /**
   * Where each side's rail shadow stood before the commit, by side.
   *
   * The shadow strip is the canvas's, not the pane's ([D183]'s one-per-side
   * rule), and it always stands: a side whose rail departs keeps its strip
   * mounted, parked or empty. This is the rect a departing strip is held at
   * for its beat, read on the near side of the commit for the same reason
   * every other First fact is.
   */
  const settleFirstRailShadowsRef = useRef<Map<SidebarSide, DOMRect>>(
    new Map(),
  );
  /**
   * The tweens running on each frame, by pane id — DOM zone, never React
   * state. At most two per settle: the one effect carrying every geometry term
   * the frame crosses ([D135] — move and size share a clock or a pinned edge
   * is not pinned), and a hold when a column mode flip commits it behind the
   * survivor.
   */
  /**
   * The tweens a settle has in flight, by pane.
   *
   * `restores` rides along with them because a cancelled tween's inline residue
   * has to be handed back on the SAME tick as the cancel. TugAnimator commits
   * an animation's final value into `el.style` when it finishes — and
   * `snap-to-end` finishes it — so a frame whose tween is retargeted mid-flight
   * is left wearing a baked pixel `width`/`height` from the arrangement it was
   * leaving. The completion handler that would normally take those back runs a
   * microtask later, and a microtask is long enough to paint: the frame renders
   * once at a stale size against fresh `calc()` geometry, which is a flash on
   * exactly the gesture that is already the most confusing one to watch.
   */
  const settleTweensRef = useRef<Map<string, SettleTween>>(new Map());
  /**
   * The frames a retarget's `arm` took over mid-settle, from the cancel until
   * the next Last pass says which of their crossings it carries on. That pass
   * ends every other one ({@link endCrossingsNotCarried}); the sweep and the
   * unmount teardown end whatever a Last pass never reached.
   */
  const retargetedFramesRef = useRef<Set<HTMLElement>>(new Set());
  /**
   * The frames `arm` holds on the store's word, before the commit that
   * resizes them, from that `arm` until a Last pass confirms or ends
   * each ({@link endArmHeldNotCarried}). The sweep, a later `arm` and the
   * unmount teardown end whatever no Last pass reached.
   */
  const armHeldRef = useRef<Map<HTMLElement, "fold" | "still">>(new Map());
  /**
   * What the canvas last rendered — the deck, its arrangement, and how it
   * derives one — read by `arm` for the near side of its prediction. Written
   * after every commit, so `arm`, which runs in a later task's notify, reads
   * the arrangement that is on screen.
   */
  const renderedRef = useRef({ deck: deckState, arrangement: shownArrangement, deriveArrangement });
  useLayoutEffect(() => {
    renderedRef.current = { deck: deckState, arrangement: shownArrangement, deriveArrangement };
  });
  /**
   * The frames a pointer gesture took from a running settle, each against the
   * generation of the settle it took it from. That settle's later landings and
   * its completion leave a taken frame alone: the gesture owns its transform
   * from the threshold on ([L32]), and a write from the settle would hide or
   * wipe it. A later settle has a later generation, so a frame dropped and
   * carried again is that settle's like any other.
   */
  const takenFramesRef = useRef<WeakMap<HTMLElement, number>>(new WeakMap());
  /**
   * Every DEPARTING TARGET this settle is carrying out, keyed by pane id — or
   * by `rail-shadow:<side>` for a side's strip ([P06]).
   *
   * A target is a real element that already stood at rest: a CLOSING pane's
   * own frame, which the store keeps mounted and `inert` for this settle
   * (`data-departing`); a PARKED rail frame, whose rail was hidden whole and
   * which the engine shows for the length of its exit; or a side's STRIP.
   * The `depart` beat fades or slides each one where it stood, and nothing
   * is created inside the window to do it ([D9]).
   *
   * The one owner of a target's holds, because a target is in none of the
   * records `arm` walks. A departing or
   * parked frame is out of `SHOWN_PANE_FRAMES`, so no later First pass
   * measures it and no later Last pass collects it, and this map is the only
   * thing that can hand it back — at the `depart` beat's landing, the window
   * sweep, a retarget's `arm`, and the canvas unmount ([B05]).
   *
   * Handing back differs by kind. A CLOSING frame keeps its hold and is given
   * an inline `opacity: 0`, because `fill: none` would otherwise return it at
   * full opacity until the store's land unmounts it; its id is then free to
   * land. A PARKED frame or a strip runs its restorers, which take the mark
   * and the holds off, and the stylesheet hides it again.
   *
   * `launched` is what makes the retarget's exit precise rather than blunt.
   * A target whose `depart` beat is in flight already has a landing coming
   * that runs UNCONDITIONAL on the generation, so `arm` leaves it to finish as
   * the reader is watching it. A target whose beat never launched has nothing
   * coming for it at all, and that is the one `arm` takes. Taking both would
   * cut a departure the instant a second close landed beside it — two cards
   * closed in one gesture is an ordinary thing to do, and each is owed its
   * own beat ([B06]).
   */
  const departingTargetsRef = useRef<Map<string, DepartingTarget>>(new Map());
  /**
   * Hand departing targets back. Idempotent, and safe to call from a path
   * that has already been swept — the map is the record, and an empty one is
   * the answer that nothing is being carried.
   *
   * `which` says how far it reaches. `"all"` is for the paths where nothing
   * is coming for anything — the window sweep and the canvas unmount. `"unlaunched"`
   * is the retarget's, and takes only the targets whose beat never started.
   */
  const releaseDepartingTargets = useCallback(
    (which: "all" | "unlaunched"): void => {
      for (const [key, entry] of [...departingTargetsRef.current]) {
        if (which === "unlaunched" && entry.launched) continue;
        landDepartingTarget(entry);
        departingTargetsRef.current.delete(key);
      }
    },
    [],
  );
  const releaseDepartingTargetsRef = useRef(releaseDepartingTargets);
  releaseDepartingTargetsRef.current = releaseDepartingTargets;
  /**
   * Tell the store which departures are over: every pane its snapshot marks
   * `departing` that this registry is no longer carrying ([P06]).
   *
   * Stated over the SNAPSHOT rather than over the targets a settle planned,
   * because a departing pane can reach no target at all — a parked rail
   * member closed from the Cards list, a pane closed while its arrival was
   * still pending, a close whose Last pass took an early return — and each of
   * those would otherwise stand in the published deck until the next
   * workspace switch. Called at a settle's finish, at both of the Last pass's
   * early returns, and by a beat that lands with no settle in flight; the
   * sweep and the unmount land everything.
   */
  const landSettledDepartures = useCallback((): void => {
    const marks = store.getPicture().departing;
    if (marks === undefined) return;
    const ids = Object.keys(marks).filter(
      (paneId) => !departingTargetsRef.current.has(paneId),
    );
    if (ids.length > 0) store.landDepartures(ids);
  }, [store]);
  const landSettledDeparturesRef = useRef(landSettledDepartures);
  landSettledDeparturesRef.current = landSettledDepartures;
  // The settle is the deck's departure host: with it registered, a close
  // leaves the pane in the published deck for this engine to carry out, and
  // without it a close removes outright ([P07]). A layout effect, because a
  // close landing between mount and a passive effect would remove outright
  // with a canvas standing ready to carry it ([L03]).
  useLayoutEffect(() => store.registerDepartureHost(), [store]);
  /**
   * The hold plan for the columns whose mode flipped this settle, computed
   * when the settle arms and consumed by the Last pass.
   *
   * A column mode flip is a cover, not a fade ([B02] of
   * `briefs/column-flip-cover-brief.md`). Exactly one member — the
   * **survivor** — moves, and it moves as one fused beat, because its
   * translate and its height change are the same edge (Stack Column from the
   * bottom tile: the top edge rises to the column top and the bottom edge
   * stays), and playing them in sequence opens an interval in which the
   * survivor has left one tile and not yet claimed the other ([B01]). Every
   * other member is **covered**: committed behind the survivor, animating
   * nothing, wearing `data-imposer-covered` so the cut census can read a move
   * it could not see. On a stack the covered members are also **held**:
   * each keeps its old tile inline until the survivor has grown over it,
   * because the commit has already moved it to the full run and letting that
   * landing show would be the card sliding across the column. On a split
   * nothing is held — a revealed member is simply at its tile behind the
   * survivor, uncovered as the survivor retreats ([F06]).
   *
   * Every hold and every cover is released at the beat chain's one completion
   * and never on a clock of its own ([B03]): a hold that ends before the
   * survivor has covered the frame is the frame reappearing.
   *
   * The survivor is the column's **z-frontmost** member, because that is the one
   * a stack actually shows: stacked members all draw the same rect and z-order
   * alone decides which of them you see. Picking by column order instead would
   * animate the top tile into the full run while the card the stack goes on to
   * display is a different one entirely — the growth would belong to a frame
   * that ends up hidden, and the visible card would arrive by a cut.
   *
   * The survivor is therefore not always the top tile, and on the way out of a
   * split it may have to travel: a frontmost BOTTOM member crosses up to the
   * run's top as it grows. That is a real translate plus a real height tween —
   * no smear either way ([D135]) — so the correct card being the moving one
   * costs nothing but the motion the eye was already expecting.
   */
  const settleHoldPlanRef = useRef<{
    /** One per flipped column: plans a fused beat. */
    survivors: Set<string>;
    /** Every other member of a flipped column: covered until the chain's end. */
    covered: Set<string>;
    /** The covered members leaving a tile (a stack): held at it inline. */
    held: Set<string>;
  }>({ survivors: new Set(), covered: new Set(), held: new Set() });
  /** Each column's mode as of the last settle, keyed by slot, so a mode flip is
   *  detectable when the next one arms. A rail keeps no such record: it is
   *  always divided ([B01]), so its mode never flips. */
  const prevColumnModesRef = useRef<Map<number, ColumnMode> | null>(null);
  /** The raw (unscaled) settle duration read back for the current gesture. */
  const settleDurationRef = useRef(IMPOSITION_SETTLE_MS);
  /**
   * What a velocity-matched retarget needs ([P04]), across beats.
   *
   * `settleBeatRef` is the beat the running settle is on — its kind, when it
   * launched, and the velocity it was launched with — written by the Last
   * pass as each beat starts and cleared when the settle finishes. `arm`
   * reads the interrupted velocity off THAT beat's recipe at that beat's
   * elapsed time, never off the crossing regardless of which beat was up,
   * and leaves it in `settleLaunchRef` with the kind it belongs to; the Last
   * pass consumes it and resets it, so a settle that was NOT interrupted
   * always launches from rest. The velocity goes only to the replacement
   * choreography's beat of the same kind — `beatLaunchVelocity` in
   * `lib/pane-flip.ts` says why the other kinds launch from rest ([B06]).
   *
   * One record for the whole settle rather than one per frame, because every
   * frame in a beat rides the same curve — they were all launched together
   * and interrupted together.
   */
  const settleLaunchRef = useRef<InterruptedBeat | null>(null);
  const settleBeatRef = useRef<{
    kind: BeatKind;
    launchedAt: number;
    initialVelocity: number;
    /** Every tween this beat launched, so an arm can ask whether it is over. */
    anims: readonly TugAnimation[];
    /**
     * Land the beat: take off what it held and leave every frame exactly
     * where the beat put it. Idempotent, and the ONE place that work lives —
     * the beat's own completion handler calls it a promise hop after the
     * tweens end, and `arm` calls it first when it finds the tweens already
     * over. That second door is load-bearing: under `fill: none` an effect
     * stops contributing the instant its time is up, but the promise that
     * takes the hold off lands in the NEXT rendering update. A commit landing
     * in between — a close pressed as the arrival finishes — reads a frame
     * whose screen shows the end pose and whose DOM says the start pose.
     * `commitStyles()` writes what the DOM says, and the frame cuts a card's
     * width to a place it was already standing ([P08]).
     */
    land: () => void;
  } | null>(null);
  /**
   * The open resize episode on each frame, by pane id — DOM zone, never React
   * state.
   *
   * A settle that changes a frame's width re-wraps everything inside it, and
   * the `scrollTop` a scroller was left at names different content afterwards.
   * The episode brackets that: armed with the OLD geometry still on screen, so
   * each scroller captures what the user is looking at before it moves, and
   * ended once the new geometry has settled.
   */
  const settleEpisodesRef = useRef<Map<string, ResizeEpisodeHandle>>(new Map());

  /**
   * Whether the arm that opened the settle now in hand saw a switch epoch
   * ([P02], Spec S02).
   *
   * `arm` reads {@link SPACE_SWITCHING_ATTRIBUTE} off the canvas and the Last
   * pass has to take the same answer, because the two run at different
   * moments: `arm` is a store subscriber, synchronous inside `notify`, and the
   * Last pass is a layout effect after the commit. Re-reading the attribute
   * there would work today and would depend on this component declaring its
   * effects in an order nothing states — the crossfade effect, which sweeps
   * the mark, is declared below the settle's. A ref says the coupling out
   * loud, exactly as `isTugMotionEnabled()` being re-read in both places
   * would not.
   */
  const settleSwitchingRef = useRef(false);

  /**
   * How many arrangement commits `arm` has seen, ever.
   *
   * The quiet gate's third input, and the one the recording says cannot be
   * left out ([Q01]): a first show produced four post-swap commits over about
   * 100ms, and a counter watching only pane rects could call quiet in a gap
   * between two of them. A monotonic number rather than a callback because
   * the gate is not always open — `arm` bumps it whether or not anybody is
   * counting, and the gate reads a difference.
   */
  const settleCommitSeqRef = useRef(0);

  // Hold every session card's notifications for the length of the
  // gesture, and release them on the same edges the tweens land on.
  //
  // A React commit landing INSIDE the window is not merely one more
  // commit: measured on release, the settle alone cost 343 walk samples
  // and a commit stream alone 654, but the two together cost 1809 —
  // 81% above their sum, with median frame delivery going 17ms to 20ms
  // and four times the dropped frames
  // (`arc/jul30-perf-brief.md#s5-imposer`). A commit while a
  // transform animation is running dirties compositing with the
  // animation's extent already reserved, which forces exactly the
  // recompute that reservation exists to avoid.
  //
  // Nothing is dropped — the events reduce and run their effects as
  // they arrive, and only the React notification waits, flushing once
  // at release. The cap is the store's own guard against a holder that
  // never comes back; release below is what normally ends it.
  const holdSessions = useCallback((capMs: number) => {
    cardServicesStore.forEachCodeSessionStore((store) => {
      store.holdNotifications(capMs);
    });
  }, []);
  const releaseSessions = useCallback(() => {
    cardServicesStore.forEachCodeSessionStore((store) => {
      store.releaseNotifications();
    });
  }, []);

  // The lifecycle, on a ref so the settle's effects do not re-key on it. The
  // canvas renders inside `CardLifecycleContext.Provider` (see the provider
  // list in `DeckManager`'s `reactRoot.render`), so this is non-null in the
  // app and null in a fixture that mounts the canvas alone.
  const cardLifecycle = useCardLifecycle();
  const cardLifecycleRef = useRef(cardLifecycle);
  cardLifecycleRef.current = cardLifecycle;

  /**
   * The frames that are ARRIVING — held invisible by a Last pass and not yet
   * launched into their arrive beat.
   *
   * A frame is arriving until its arrive beat runs, and a retarget in between
   * does not change that. Without this record it did: `arm` measured the held
   * frame's First rect like any other, so the replacement Last pass read it as
   * TRAVELLING — it had a First rect now — planned no arrive beat, ran the
   * unfused shrink/move/grow chain because nothing was arriving any more, and
   * the retarget's own restorers had already taken the opacity hold off, so
   * the card popped in at full opacity a beat before the room was made. One
   * arrangement change landing inside the arrival window was enough: three
   * motions and a pop where the contract is two ([P08]).
   *
   * So `arm` skips a pending frame — no First rect, no restore, no cancel —
   * and the Last pass finds it exactly as an arrival again: still held, still
   * owed its beat, and enough to keep the replacement settle fused.
   *
   * **An entry leaves when its arrive beat BEGINS, not when its effect is
   * created ([B03]).** The beats of a chain are all created up front, each
   * with its own delay, so an effect's existence says nothing about whether
   * its beat has started: `runBeat("arrive")` builds the fades synchronously
   * inside the Last pass, a whole `room` beat before the fade's active phase.
   * Dropping the id there left the frame unprotected for that window — a
   * close landing during `room` measured the held frame, `hold-at-current`
   * committed the underlying `opacity: 0`, the restorers handed the pre-hold
   * opacity back, and the card popped to full opacity with no arrival at all
   * ([F04]). So the delete rides `whenBeatBegins`, which resolves on the
   * beat's own first active frame and never before it, and which a retarget
   * cancels along with the settle — an interrupted arrival stays pending and
   * is found as an arrival again.
   *
   * The whole set is emptied when a settle releases, since nothing is pending
   * past the end of the settle; the reduced-motion Last pass hands a pending
   * arrival's hold back on its early return, and the switch sweep drops ids
   * for panes no beat is ever coming for ([P05]).
   *
   * **It carries the hold's restorers, and it is the ONLY record that does
   * while the frame is pending ([B10]).** An arriving frame used to be
   * written down three times — here, in the `arrivals` array the Last pass
   * builds, and in a `settleTweensRef` entry with an empty `anims` array
   * whose whole job was to hold the restorers so `arm`, the sweep and the
   * unmount teardown could hand the opacity back. That third record was a
   * tween record naming no tween, and every reader of `settleTweensRef` had
   * to know it might be one. Now the pending map holds the frame and its
   * restorers, and the `settleTweensRef` entry is written when the arrive
   * beat BEGINS — the same instant the id leaves here, with the live fade
   * already in it. One record at a time, and which one says which half of
   * the arrival the frame is in.
   */
  const pendingArrivalsRef = useRef<
    Map<string, { frame: HTMLElement; restores: Array<() => void> }>
  >(new Map());

  /**
   * Fire `cardDidArrive` for every card the deck holds that is still marked
   * arriving — the UNCONDITIONAL DRAIN, and the whole of [R01]'s answer.
   *
   * A mark is made in `addCard` and is meant to be cleared by the arrive beat
   * ending. The beat is not guaranteed to run. `arm` measures a First rect for
   * an arriving frame like any other, so a second arrangement change landing
   * inside the settle re-reads that frame as TRAVELLING rather than arriving —
   * it has a First rect now — and no arrive beat will ever be planned for it.
   * The card is on screen and still, and the caller waiting on its arrival
   * waits forever: a picker that never opens, a deck that never travels.
   *
   * So the drain is called from every place a settle can end rather than from
   * the one that normally ends it — the completion, both early returns, the
   * window sweep, and the unmount. It is idempotent (`notifyCardDidArrive`
   * clears the mark before firing, and the one-shot subscribers unsubscribe
   * themselves), so calling it from five places costs nothing and reasoning
   * about which place owns a given arrival costs a defect.
   */
  const drainArrivals = useCallback(() => {
    const lifecycle = cardLifecycleRef.current;
    if (lifecycle === null) return;
    // Off the store rather than the rendered snapshot: the drain runs from
    // timers and teardowns, and what it wants is the panes the deck holds NOW.
    for (const pane of store.getSnapshot().panes) {
      for (const cardId of pane.cardIds) {
        lifecycle.notifyCardDidArrive(cardId);
      }
    }
  }, [store]);
  const drainArrivalsRef = useRef(drainArrivals);
  drainArrivalsRef.current = drainArrivals;

  // Drop a frame's tween registration and, crucially, the inline `transform`
  // TugAnimator leaves on it — along with the `transform-origin` the tween was
  // anchored by, which is the settle's to write and the settle's to take away.
  //
  // TugAnimator commits an animation's final value into `el.style` when it
  // completes — unconditionally, whatever `fill` says, and `cancel()` in
  // snap-to-end mode takes the same path. Here that final value is
  // `translate(0px, 0px)`, and React will never remove it: `transform` is not
  // among the style keys TugPane renders, and React only clears keys it set
  // itself. A frame left wearing any transform is a containing block for its
  // `position: fixed` descendants — but that is no longer what makes the
  // residue a hazard, because every frame is a containing block by design now:
  // `.tug-pane` carries a standing `will-change: transform` and nothing with
  // `position: fixed` lives inside a frame ([B01], [B02]).
  //
  // The residue is still removed, for the reason the paragraph above already
  // gave: the frame's geometry is the store's to own ([L09]). A committed
  // `translate(0px, 0px)` is the settle's leftover opinion about where the
  // frame sits, outliving the settle that formed it, and the next reader of
  // the frame's box — a measurement, a hit test, the settle after this one —
  // has no way to tell it from a pose somebody meant.
  //
  // The size and fade tweens leave residue of their own — a committed pixel
  // length where React rendered `auto` or a `calc()`, a committed opacity —
  // and each settle's completion handler hands those back itself, because it
  // is the one holder of the values it displaced. This function owns only
  // what every settle writes the same way.
  //
  // Idempotent by construction, because it runs more than once per frame: the
  // completion handler, the window sweep, and effect teardown all call it, and
  // a cancelled tween's handler lands a microtask later — after a replacement
  // settle may already have been registered, which is why the registry entry
  // is only dropped when it still belongs to the settle that finished.
  const clearFlipRef = useRef(
    (paneId: string, el: HTMLElement, anims: readonly TugAnimation[]): void => {
      const entry = settleTweensRef.current.get(paneId);
      if (entry?.anims === anims) {
        settleTweensRef.current.delete(paneId);
      }
      el.style.removeProperty("transform");
      el.style.removeProperty("transform-origin");
      // The cover a column mode flip put on a revealed member — committed
      // behind its survivor, uncovered as the survivor retreats. It comes
      // off with the survivor's release, and here so that every path that
      // ends a settle (the sweep, a retarget's cancel, teardown) takes it
      // off too: a mark that outlived its settle would blind the cut census
      // to that frame for good.
      el.removeAttribute("data-imposer-covered");
    },
  );

  // A pointer gesture taking a frame from the settle (`lib/settle-take.ts`).
  // Synchronous, because the gesture's first transform write follows the
  // dispatch on the same tick: every running tween on the frame is cancelled
  // at the pose on screen — measured there, for `arm`'s reason — and then its
  // holds, its transform, its crossing and its episode are handed back, which
  // is everything the settle's own completion would have taken off. What the
  // gesture is told is the distance between that pose and the committed one,
  // so it can start from where the eye had the frame. A layout effect, for
  // [L03]: a drag that begins before a passive effect lands would find no one
  // listening.
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (el === null) return;
    const onTake = (event: Event): void => {
      const frame = event.target;
      if (!(frame instanceof HTMLElement)) return;
      const paneId = frame.getAttribute("data-pane-id");
      if (paneId === null) return;
      takenFramesRef.current.set(frame, settleGenerationRef.current);
      const running = settleTweensRef.current.get(paneId);
      if (running === undefined || running.el !== frame) return;
      for (const anim of running.anims) anim.cancel("hold-at-current");
      const seen = frame.getBoundingClientRect();
      for (const restore of running.restores) restore();
      clearFlipRef.current(paneId, frame, running.anims);
      endFoldCrossing(frame);
      endStillCrossing(frame);
      retargetedFramesRef.current.delete(frame);
      const episode = settleEpisodesRef.current.get(paneId);
      if (episode !== undefined) {
        episode.end();
        settleEpisodesRef.current.delete(paneId);
      }
      const committed = frame.getBoundingClientRect();
      const detail = (event as CustomEvent<SettleTakeDetail>).detail;
      detail.dx = seen.left - committed.left;
      detail.dy = seen.top - committed.top;
    };
    el.addEventListener(SETTLE_TAKE_EVENT, onTake);
    return () => el.removeEventListener(SETTLE_TAKE_EVENT, onTake);
  }, [containerRef]);

  // A hand taking the whole flow strip from a running slide
  // (`takeFlowFromSettle`). Synchronous for `onTake`'s reason: the gesture
  // draws the answer in the same task, so no frame paints between the slide
  // letting go and the hand holding it.
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (el === null) return;
    const onTakeFlow = (event: Event): void => {
      const running = prelaunchRef.current;
      if (running === null) return;
      (event as CustomEvent<SettleTakeFlowDetail>).detail.offset = running.take();
    };
    el.addEventListener(SETTLE_TAKE_FLOW_EVENT, onTakeFlow);
    return () => el.removeEventListener(SETTLE_TAKE_FLOW_EVENT, onTakeFlow);
  }, [containerRef]);

  // First, and the arming. A LAYOUT effect, not a passive one ([L03]): this
  // registers the store subscriber that measures every frame's outgoing
  // geometry, and a subscription that lands after paint is a subscription that
  // was not there for whatever the mount raced. An arrangement change committed
  // in that gap arms nothing, and the frames it moves cut — the one defect on
  // this surface that only ever shows up on a fresh mount, which is exactly
  // where it is hardest to see.
  useLayoutEffect(() => {
    const clearFlip = clearFlipRef.current;
    // **A canvas inherits no residue.** A departing target's mark and holds
    // and a rail shadow's slide are inline writes, so none of them is
    // anything a re-render can take back — and a
    // canvas that comes up over a previous one's leavings shows them for the
    // rest of its life. That is the ordinary case under HMR, where the module
    // is replaced and the DOM is not: a stripe stranded by the code being
    // edited stays on screen through every update that fixes it, which reads
    // as the fix not working.
    //
    // Swept at MOUNT for that reason, against the document rather than against
    // the records — the records belong to the instance that just went away.
    {
      const canvas = containerRef.current;
      if (canvas !== null) {
        for (const frame of canvas.querySelectorAll<HTMLElement>(
          `.tug-pane[${SETTLE_DEPARTING_ATTR}]`,
        )) {
          frame.removeAttribute(SETTLE_DEPARTING_ATTR);
          frame.style.removeProperty("transform");
          frame.style.removeProperty("opacity");
        }
        for (const strip of canvas.querySelectorAll<HTMLElement>(
          ".tug-rail-shadow",
        )) {
          strip.removeAttribute(SETTLE_DEPARTING_ATTR);
          strip.style.removeProperty("transform");
          strip.style.removeProperty("opacity");
        }
      }
    }
    /**
     * Arm the settle's own frame-gap record, and stop it.
     *
     * The pump is a finisher in [D7]'s sense: started by the commit that
     * marked the canvas, stopped by the release on every path the release can
     * take — completion, sweep, and the unmount teardown. Nothing here runs
     * on a settled deck, which is what lets the product measure itself
     * without spending anything to do it ([D1], [B10]).
     *
     * And nothing here runs on a deck nobody is measuring ([B07]). The pump
     * is cost-bearing in {@link DeckTrace.enableKind}'s sense — a rAF loop
     * for the length of every settle, a computed style per shown frame per
     * tick — so it is armed by name like `space-switch-frames` rather than
     * riding the global trace flag. The release still records `settle-arm`
     * and `settle-release` on a shipping instance; the frame-by-frame row is
     * for the bench that asked for it.
     */
    const startSettleFrameRecord = (el: HTMLElement): void => {
      if (!deckTrace.isKindEnabled("settle-frames")) return;
      const record = settleFramesRef.current;
      // A retarget arms again inside a window that is already being recorded,
      // and the record belongs to the WINDOW rather than to the arm: the
      // release fires once for the whole chain, and a reader asking how the
      // gesture went is asking about every frame of it. So a pump already
      // running is left alone rather than restarted over a fresh array,
      // which would silently drop the gaps before the retarget.
      if (record.raf !== null) return;
      // A land still waiting on its ticks is written now, with what it has,
      // and its recorder handed to this settle.
      record.land.finish?.();
      landRecorder.arm();
      record.samples = [];
      // The record's origins, captured AFTER the retarget guard and not
      // before it. The window belongs to the arm that started the pump, so a
      // retarget arming inside a running window must not overwrite them —
      // doing so would hand the window the LAST gesture's stamp and report a
      // lead shorter than the one the reader waited through, which is the one
      // number this record was changed to see ([P01]).
      record.armedAt = performance.now();
      // The fold's own stamp ([P02]), read with the staleness guard the switch
      // sampler already uses: a stamp older than a few seconds belongs to some
      // earlier gesture — an imposition that never passes through
      // `setPaneFolded` leaves none — and the arm is the honest origin then.
      const stampedAt = store.getImpositionGestureAt();
      // …and spent once. A stamp this record has already measured a window
      // from belongs to a gesture that is over; the settle in hand is some
      // other imposition, and its honest origin is its own arm.
      const fresh =
        stampedAt !== null &&
        stampedAt !== record.consumedGestureAt &&
        record.armedAt - stampedAt < 5000;
      record.gestureAt = fresh ? stampedAt : record.armedAt;
      if (fresh) record.consumedGestureAt = stampedAt;
      const tick = (): void => {
        // The plain reading, which is the one that costs a bounded amount:
        // a computed style per shown frame and that frame's own effects,
        // which is everything the row below carries. NOT the
        // fixed-descendant sweep, which walks every element under every
        // frame asking each for its computed style — R01's runtime half,
        // which the bench probe asks for by name and Spec S03's row carries
        // no field for — and NOT the frames' rects, a forced layout per tick
        // feeding `rectsChangedAfterLanding`, which the row has no field for
        // either. Either would put a cost inside the one window [D9] forbids
        // main-thread work in, to compute a number nothing here reads.
        if (record.samples.length === 0) perfMark("tug:first-tick");
        // Read as the instrument's own: the sampler's style read pays the
        // frame's flush, which the land record names as the sampler's.
        record.samples.push(
          landRecorder.aside("settle sampler", () => sampleSettleFrame(el)),
        );
        record.raf = requestAnimationFrame(tick);
      };
      record.raf = requestAnimationFrame(tick);
    };

    /**
     * Close the frame record at the release. `landed` is a release the deck
     * stays mounted through — completion or the sweep — and only those have a
     * land worth reading, so only they start its tail.
     */
    const stopSettleFrameRecord = (landed: boolean): void => {
      const record = settleFramesRef.current;
      if (record.raf !== null) {
        cancelAnimationFrame(record.raf);
        record.raf = null;
      }
      if (record.samples.length === 0) {
        if (record.land.finish === null) landRecorder.disarm();
        return;
      }
      const landAt = performance.now();
      const motionAt = record.motionAt ?? undefined;
      record.motionAt = null;
      const reading = classifySettleFrames(
        record.samples,
        record.armedAt ?? undefined,
        record.gestureAt ?? record.armedAt ?? undefined,
        motionAt,
      );
      const panes = record.samples[0]?.frames.length ?? 0;
      const ticks = record.samples.map((sample) => sample.t);
      const gestureAt = record.gestureAt ?? record.armedAt ?? ticks[0];
      record.samples = [];
      // What ran inside the motion, from the land record's own events: the
      // gate's three zero clauses. A settle that closed no gate has no
      // motion to read them over, and says so with empty lists.
      const motion =
        motionAt === undefined
          ? { commits: [], forcedLayouts: [], deliveries: [] }
          : classifyMotionEvents(landRecorder.take(motionAt), motionAt, landOpensAt(ticks, landAt));
      deckTrace.record({
        kind: "settle-frames",
        panes,
        ticks: reading.ticks,
        longestGapMs: reading.longestGapMs,
        longestGapFrames: reading.longestGapFrames,
        gapsOverOneFrame: reading.gapsOverOneFrame,
        motionLongestGapMs: reading.motionLongestGapMs,
        motionLongestGapFrames: reading.motionLongestGapFrames,
        motionGapsOverOneFrame: reading.motionGapsOverOneFrame,
        motionAtMs: reading.motionAtMs,
        motionCommits: motion.commits,
        motionForcedLayouts: motion.forcedLayouts,
        motionDeliveries: motion.deliveries,
        firstPaintDelayMs: reading.firstPaintDelayMs,
        commitDelayMs: reading.commitDelayMs,
        moveFirstPaintDelayMs: reading.moveFirstPaintDelayMs,
        pendingTicks: reading.pendingTicks,
        offCurveTicks: reading.offCurveTicks,
        offCurvePaneIds: reading.offCurvePaneIds,
        strandedTicks: reading.strandedTicks,
        strandedPaneIds: reading.strandedPaneIds,
        cutPaneIds: reading.cutPaneIds,
        longestOffCurveRunTicks: reading.longestOffCurveRunTicks,
        longestOffCurveRunOffsetMs: reading.longestOffCurveRunOffsetMs,
        violations: reading.violations,
      });
      // [D9]'s runtime guard. One row per offending pane/property, split out
      // of the same reading rather than sampled a second time — a guard that
      // read the deck on its own clock could disagree with the record beside
      // it, and then neither would be evidence.
      for (const violation of reading.violations) {
        const colon = violation.indexOf(":");
        if (colon < 0) continue;
        deckTrace.record({
          kind: "settle-motion-violation",
          paneId: violation.slice(0, colon),
          property: violation.slice(colon + 1),
        });
      }
      if (landed) startLandTail(ticks, landAt, gestureAt, reading.framePeriodMs);
      else landRecorder.disarm();
    };

    /**
     * Read the land: two more ticks after the release, then the `settle-land`
     * row ([B03] of set-up-and-go). The first tick after the land runs ahead
     * of the style, layout and observer deliveries the hand-back dirtied, so
     * it is the second that closes the land's frame — see
     * `lib/land-frame-record.ts`. Two frame callbacks and done: nothing here
     * outlives the settle by more than the frame it is measuring ([D1]).
     *
     * Unless a settled mark is still on when the tail starts. Then the
     * hand-back is not all paid in the land's task, and the tail reads on
     * until the mark has come off and two ticks past it, so the late cost is
     * the land's frame rather than one the record closed before ([B04] of
     * `set-up-and-go-fixups`). Capped, so a mark nobody takes off cannot keep
     * a frame callback alive.
     */
    const startLandTail = (
      settleTicks: readonly number[],
      landAt: number,
      gestureAt: number,
      framePeriodMs: number,
    ): void => {
      const land = settleFramesRef.current.land;
      const ticks = [...settleTicks];
      let after = 0;
      const marked = (): boolean =>
        document.querySelector(`[${STILL_SETTLED_ATTR}]`) !== null;
      // `undefined` while nothing is owed; `null` while a mark is still on;
      // the moment just before it was seen gone, once it is.
      let shedAt: number | null | undefined = marked() ? null : undefined;
      let pastShed = 0;
      const finish = (): void => {
        if (land.raf !== null) cancelAnimationFrame(land.raf);
        land.raf = null;
        land.finish = null;
        const reading = classifyLand({
          ticks,
          landAt,
          shedAt: shedAt ?? undefined,
          gestureAt,
          framePeriodMs,
          ...landRecorder.take(ticks[0] ?? landAt),
        });
        landRecorder.disarm();
        deckTrace.record({ kind: "settle-land", ...reading });
      };
      const tick = (): void => {
        const previous = ticks[ticks.length - 1] ?? landAt;
        const now = performance.now();
        ticks.push(now);
        after += 1;
        // The mark came off somewhere since the previous tick, so the shed is
        // placed just after it: this tick may run ahead of what it dirtied,
        // and the next one closes the frame that paid.
        if (shedAt === null && !marked()) shedAt = previous + 0.001;
        if (typeof shedAt === "number") pastShed += 1;
        const owed = shedAt === null || (typeof shedAt === "number" && pastShed < 2);
        if ((after >= 2 && !owed) || after >= LAND_TAIL_CAP_TICKS) finish();
        else land.raf = requestAnimationFrame(tick);
      };
      land.finish = finish;
      land.raf = requestAnimationFrame(tick);
    };

    const releaseSettle = (
      source: "completion" | "sweep" | "unmount",
    ): void => {
      if (settleReleasedRef.current) return;
      settleReleasedRef.current = true;
      releaseSessions();
      // Before the release row, so a reader scanning the trace meets the
      // numbers and then the release that ended them.
      stopSettleFrameRecord(source !== "unmount");
      if (source === "unmount") openMotionGate();
      else openMotionGateAfterLand();
      deckTrace.record({ kind: "settle-release", source });
      // The hold comes off with the id, always ([B10]). The pending map is
      // the ONLY record of an arriving frame whose beat never began, so
      // emptying it without running its restorers leaves the frame wearing
      // the inline `opacity: 0` the Last pass wrote and nothing left that
      // knows about it — a card nobody can see, for the life of the canvas.
      //
      // It is a backstop rather than the only site: the sweep and the
      // reduced-motion Last pass hand the hold back themselves, because both
      // need it back BEFORE they take the settle's marks off. The path this
      // catches is the one that has neither — a Last pass that finds no First
      // rect at all (a switch epoch, motion turned off mid-settle) and
      // releases on the spot because no tween record stands. Before [B10] the
      // pending arrival WAS such a record, which is what used to hold that
      // release back. The restorers are idempotent, so running them here
      // after a caller already did costs a write of the same value.
      for (const { restores } of pendingArrivalsRef.current.values()) {
        for (const restore of restores) restore();
      }
      pendingArrivalsRef.current.clear();
    };
    settleReleaseRef.current = releaseSettle;
    // The window sweep. Every tween should have finished and swept itself by
    // the time this fires; the sweep is what guarantees no frame keeps the
    // inline residue if one didn't. Armed by `arm` at the crossing's nominal
    // and re-armed by the Last pass at the choreography's total, so it can
    // never fire in the middle of a beat and snap every frame to its end. It
    // no longer carries the release on the normal path — the settle's own
    // completion does — so the release here is the guard for a settle whose
    // completion never landed.
    const scheduleSweep = (windowMs: number): void => {
      const el = containerRef.current;
      if (el === null) return;
      if (settleTimerRef.current !== null) {
        window.clearTimeout(settleTimerRef.current);
      }
      settleTimerRef.current = window.setTimeout(() => {
        settleTimerRef.current = null;
        for (const [paneId, entry] of [...settleTweensRef.current]) {
          for (const anim of entry.anims) anim.cancel("snap-to-end");
          // The residue, handed back HERE rather than left to the cancelled
          // tweens' own completions: those land a microtask later, on the far
          // side of the marks below, and a height handed back there would arm
          // the shade transition the marks are standing down (see
          // {@link endSettleMarks}). Idempotent — the completion hands back
          // the same captured value again and writes nothing new.
          for (const restore of entry.restores) restore();
          clearFlip(paneId, entry.el, entry.anims);
          // Same sweep for the fold mark: a crossing whose completion handler
          // never landed would leave the interior held and the card waiting on
          // an end that is not coming. Unguarded by id, because the window is
          // over and no crossing of any vintage should outlive it. The still
          // crossing too: a fold's end takes it off, but most held frames
          // were never folding.
          endFoldCrossing(entry.el);
          endStillCrossing(entry.el);
        }
        // And a frame a retarget took over that no Last pass has read since.
(retargetedFramesRef.current);
(armHeldRef.current);
        // After the frames, so the flush inside carries their hand-back.
        //
        // And the frames that never reached a tween record: an arrival whose
        // beat had not begun when this window ran out is in the pending map
        // and nowhere else ([B10]), still wearing the inline `opacity: 0`
        // the Last pass wrote. `releaseSettle` below empties the map, so the
        // restorers have to run before it or the hold outlives the settle.
        for (const { restores } of pendingArrivalsRef.current.values()) {
          for (const restore of restores) restore();
        }
        endSettleMarks(el);
        // Every target this window was still carrying, and then every
        // departure the store still holds. The sweep is the net for a settle
        // whose completion never landed, and a departing target is the one
        // thing in a settle that no later pass can ever collect ([B05]).
        releaseDepartingTargetsRef.current("all");
        landSettledDeparturesRef.current();
        // Paired with the marks coming off, here as at every other point they
        // do: "the settle is over" and "the notice went out" are one
        // condition, and a sheet clamped against a frame this sweep just
        // snapped is owed the same measure a completion would have earned it.
        dispatchImposerSettleEnd(el);
        releaseSettle("sweep");
        // Same sweep, for the same reason: an episode the Last pass never
        // reached (no tween on that frame, a window with no animation clock
        // at all) closes here rather than waiting for its own net.
        for (const [, handle] of settleEpisodesRef.current) handle.end();
        settleEpisodesRef.current.clear();
        // Outside every guard above, because the window is over: an arrival
        // still marked here has no beat coming for it, whoever owns the marks.
        drainArrivalsRef.current();
      }, windowMs);
    };
    settleSweepRef.current = scheduleSweep;
    prevColumnModesRef.current = new Map(
      deckColumnsOf(store.getSnapshot(), null).map((c) => [c.slot, c.mode]),
    );
    const arm = (landing: CommitLanding): void => {
      const el = containerRef.current;
      if (el === null) return;
      // Before every early return below, because the gate's question is "has
      // anything committed since the last frame" rather than "has anything
      // moved" — a commit the imposer reads as unchanged is still a commit
      // the arriving layer may have taken geometry from.
      settleCommitSeqRef.current += 1;
      // The switch epoch ([P02], Spec S02). Read off the canvas the manager
      // wrote it on, every arm, because an arm cannot know from `landing`
      // alone whether it is one of the several commits a switch produces:
      // only the SWAP commit spells itself `"cut"`, and the ones after it —
      // `activateCard`'s reveal, and every geometry the arriving layer could
      // not take while it was hidden — arrive as ordinary `"cross"` commits.
      const switching = el.hasAttribute(SPACE_SWITCHING_ATTRIBUTE);
      settleSwitchingRef.current = switching;
      const state = store.getSnapshot();
      const next = arrangementSignature(state, {
        rail: store.getRailRunHeight(),
        column: store.getColumnRunHeight(),
      });
      if (next.full === arrangementRef.current) {
        // Nothing the imposer reads moved. Recorded rather than passed over,
        // because "the subscriber ran and found nothing" and "the subscriber
        // never ran" are the same silence otherwise, and only one of them is
        // a defect ([B06]).
        deckTrace.record({
          kind: "settle-arm",
          signature: next.full,
          panes: 0,
          armed: false,
          landing,
          outcome: "unchanged",
        });
        return;
      }
      arrangementRef.current = next.full;
      // Is this commit a resize? Read once, here, off data the arm has
      // already computed — and banked BEFORE the cut's early return below, so
      // a cut cannot leave the next commit reading itself against a shore two
      // arrangements old. `[B06]`: the anchor discovery of `[F06]` belongs to
      // the moment an episode actually needs to re-anchor, which is a resize
      // and not a translate.
      const sizeChanged = next.size !== sizeSignatureRef.current;
      sizeSignatureRef.current = next.size;
      // Is this commit a pure flow slide, and by how much?
      const flowOnly = next.sansOffset === sansOffsetRef.current && !sizeChanged;
      sansOffsetRef.current = next.sansOffset;
      const prevFlowOffset = flowOffsetRef.current;
      const nextFlowOffset = Math.round(state.flowOffset ?? 0);
      flowOffsetRef.current = nextFlowOffset;
      // Where the strip is DRAWN, when a gesture has been drawing it: the
      // per-frame writer's own record, standing only between a preview and
      // the commit that consumes it. The flow slide below starts from here
      // rather than from `prevFlowOffset`, which is the store's last word and,
      // after a swipe, the place the strip stood before the hand touched it —
      // a slide from there snaps every frame back and replays the swipe. A
      // First rect would read the drawn place off the DOM for free; the
      // prelaunch plans from the store's delta alone and has to be told.
      const flowOrigin = store.getDrawnFlowOffset() ?? prevFlowOffset;
      // And how fast the hand was moving it when it let go, when a trackpad
      // lift handed that over with the commit — the prelaunch slide launches
      // at it. Read here for the same reason: the commit consumes it.
      const flowHandVelocity = store.getDrawnFlowVelocity();

      // The commit said the frames are already drawn where it puts them — a
      // per-frame writer catching the store up after the fact ([B01]). There
      // is nothing to carry, so this arm takes the new arrangement as its
      // baseline and launches no settle. It is the whole of what the landing
      // buys: the settle used to have to infer this from proxies, and the only
      // way for a writer to say it was to stay out of the store entirely
      // ([F03]).
      //
      // The mode records still advance, for the same reason they advance under
      // reduced motion: they are the shore the NEXT flip is read against, and
      // one left behind by a cut would read that flip against the wrong one.
      //
      // The switch epoch is deliberately NOT here — see `motion` below. A cut
      // means the frames are already drawn where the commit puts them, so
      // returning before the episodes are raised costs nothing. A commit under
      // a switch epoch is the opposite: the geometry really did move and the
      // epoch's claim is only that it must not be ANIMATED.
      //
      // Two things this early return skips are owed on that path and not on a
      // cut's. The First pass's own first act is to end and clear any episode
      // a previous arm left open; returning here leaves one standing for the
      // sweep to close later, against geometry the switch has since moved. And
      // `scheduleSweep` below never runs, so the wedge guard behind the settle
      // is not re-armed for a commit that really did change the layout.
      if (landing === "cut") {
        // A cut ends whatever motion it lands in, so the gate opens with it:
        // a switch is a gesture with its own set-up, and the motion it cuts
        // short has nothing left to keep React out of.
        openMotionGate();
        prevColumnModesRef.current = new Map(
          deckColumnsOf(state, null).map((column) => [column.slot, column.mode]),
        );
        deckTrace.record({
          kind: "settle-arm",
          signature: next.full,
          panes: 0,
          armed: false,
          landing,
          outcome: "declined",
          reason: "cut",
        });
        return;
      }

      // The beat this arm interrupts and the velocity it was carrying, in
      // travels per second. Null when it interrupts nothing, which is the
      // ordinary case now that a release is one commit ([P01]).
      let interrupted: InterruptedBeat | null = null;

      // A retarget: past the signature guard, so this runs only when the
      // arrangement really moved. A target whose depart beat never launched
      // has nothing coming for it — the chain that owned it returns out of
      // `runBeat` on the generation check and no completion ever runs, so its
      // holds would stand for the life of the canvas ([B05], [F04]). One whose
      // beat IS in flight keeps it: its landing is unconditional, and cutting
      // it would take the departure off the screen mid-beat. A closing frame
      // handed back here is held at `opacity: 0`, and the settle this arm
      // starts lands it with the store at its finish.
      releaseDepartingTargetsRef.current("unlaunched");
      // Every arm supersedes the Last pass before it. Under the
      // deferral there is a painted frame between this arm and its own Last
      // pass, and a beat this arm cancels lands its completion in that
      // frame — with the generation unbumped it read as the settle's own
      // completion and released the window early (the eight-card column leg
      // read one tick and no height rows).
      settleGenerationRef.current += 1;

      // First: where every frame the imposer may move is right now. A running
      // tween's transform is included in the rect, which is the point — a
      // second arrangement change mid-motion starts its tween from where the
      // eye actually is. Cancelling comes after the measurement, and is safe at
      // any moment because the tween's last keyframe is no transform at all:
      // there is no wrong pose to snap to.
      // Under reduced motion there will be no tween: the layout snap IS the
      // settle. Measuring would force a layout for rects nobody reads, and
      // holding would defer session notifications against a commit-during-
      // animation cost that cannot arise without an animation — so both are
      // skipped, while cancelling any straggler tween stays unconditional.
      //
      // A switch epoch is reduced motion for the length of one switch, and
      // that is the whole of [P02]'s enforcement. It reaches the same branch
      // rather than the cut's because the two say different things: a cut says
      // the frames have not moved, and this says they have moved and must not
      // be seen to. So the episodes are still raised, the imposer's settle-end
      // notice still goes out, and only the tweens are refused.
      const motion = isTugMotionEnabled() && !switching;
      // Launch the move from here only for a strip a HAND let go of: a
      // trackpad lift that handed its velocity over with the commit, when
      // nothing else is in flight and the whole change is the strip's offset.
      // The beat starts inside the gesture's task, from the drawn offset at
      // the hand's speed, before React renders, and the Last pass adopts it
      // rather than planning one. Measuring is skipped for a pre-launched
      // settle: the Last pass finds no First rects and leaves the marks and
      // the hold to this beat's own landing.
      //
      // Every other slide — a click, a key, a wheel that ended on its quiet —
      // is set up and then goes, like every other gesture ([B06] of
      // set-up-and-go): it measures here, React commits the new offset, and
      // the Last pass launches the move after that commit, so the commit is
      // paid in the set-up and never lands under the moving strip. The lift is
      // the one exception, and it is a different gesture rather than a slower
      // click: the hand was already moving the strip, the curve continues
      // that motion at the hand's speed (`flow-swipe-one-move` [B02]), and a
      // set-up frame between the two would stand the strip still between the
      // fingers leaving and the curve taking over.
      const prelaunch =
        motion &&
        flowOnly &&
        flowHandVelocity !== null &&
        flowOrigin !== nextFlowOffset &&
        settleTweensRef.current.size === 0 &&
        // Nothing MEASURED and unrendered ([B02]). A First rect standing here
        // is an earlier arm in this same task whose Last pass has not run —
        // two commits in one task produce two synchronous arms and, under the
        // deferral, ONE coalesced React commit. Without this clause the
        // second arm passes on "no running tweens" (there are none yet: the
        // Last pass has not launched them), takes the prelaunch path, and
        // `firstRects.clear()` throws away the first arm's measurement — so
        // the coalesced Last pass finds nothing to plan and every frame the
        // first commit moved CUTS. `hideSidebarRail` and the flow retune
        // after a rail retune are the shapes that do it ([F03]).
        //
        // A prelaunch is a beat planned from the store delta alone, and it is
        // only valid when no beat is waiting on the DOM. That is the
        // definition the Beat primitive will need too.
        settleFirstRectsRef.current.size === 0 &&
        pendingArrivalsRef.current.size === 0;
      if (!prelaunch) prelaunchRef.current = null;
      const measure = motion && !prelaunch;
      const firstRects = settleFirstRectsRef.current;
      // Under `measure` only, for the clause above's reason: a prelaunch must
      // never discard a measurement somebody is still waiting on. It cannot
      // reach a non-empty map any more, so this is the guard restated where
      // the damage used to happen rather than a second condition. Every Last
      // pass clears on every path out, so nothing accumulates.
      if (measure) firstRects.clear();
      const firstFolds = settleFirstFoldsRef.current;
      firstFolds.clear();
      const firstRailSides = settleFirstRailSidesRef.current;
      firstRailSides.clear();
      const firstRailShadows = settleFirstRailShadowsRef.current;
      firstRailShadows.clear();
      // Open the episodes here, on the near side of the commit, because this
      // is the last moment the old layout is still on screen — a scroller
      // cannot say what the user is looking at once the content has already
      // re-wrapped. Unconditional on `motion`: reduced motion still changes
      // the width, it just changes it in one step, and a step the eye cannot
      // follow is exactly the one worth anchoring.
      //
      // Conditional on the SIZE half of the signature, though ([P07]). An
      // episode is a promise to hold the reader's place across a reflow, and
      // a frame that only travels does not reflow: its scrollers keep every
      // line where it was. Raising one anyway is what `[F06]` measured —
      // `discoverScrollers` → `watchGeneric` → `firstBoxReaching`, a
      // `getComputedStyle` and a `getBoundingClientRect` per candidate up to
      // twelve deep, per frame, inside the click task that is about to hand
      // the compositor its first frame. The gate is read from `sizeChanged`
      // above; the ORDER is untouched, because when an episode does run it
      // must still open on the near side of the commit after every
      // measurement (#settle-invariants).
      const episodes = settleEpisodesRef.current;
      for (const [, handle] of episodes) handle.end();
      episodes.clear();
      // The episode's own safety net is sized from the window it brackets.
      // Read once: the custom property survives from the previous settle, and
      // falls back to the constant before the first one has written it.
      const episodeWindowMs = readSettleMs(el) * getTugTiming();
      // A beat whose tweens are already over is landed HERE, before any
      // frame is measured. Its effects stopped contributing the instant their
      // time was up (`fill: none`), but the handler that takes the holds off
      // runs a promise hop later, in the next rendering update — so a commit
      // landing in that window finds every frame of the beat with the end
      // pose on screen and the START pose in its inline style. Measured like
      // that, First equals Last, the Last pass plans nothing, and the whole
      // beat's worth of frames cut a card's width to where they already were.
      // `playState` answers "finished" from the timeline alone, so the
      // question is answerable synchronously and the record on
      // `settleBeatRef` says what landing means for each kind of beat.
      const beatUp = settleBeatRef.current;
      if (
        beatUp !== null &&
        beatUp.anims.length > 0 &&
        beatUp.anims.every((anim) => anim.raw.playState === "finished")
      ) {
        beatUp.land();
      }
      // The frames this arm carries, in DOM order, each beside the settle it
      // interrupted — collected by a pass that HOLDS and MEASURES, and a
      // second pass below that hands the residue back.
      //
      // The split is what the two writes cost. `hold-at-current` is
      // `commitStyles()` — the running pose written into inline style — and
      // it is layout-neutral by construction: the value it writes is the one
      // already on screen. A RESTORER is the opposite: it puts back the value
      // the frame had before the settle, and a width handed back re-lays out
      // every frame beside it in the strip. Interleaved, that write landed
      // between one frame's `getBoundingClientRect` and the next one's.
      const armed: Array<{
        paneId: string;
        frame: HTMLElement;
        running: SettleTween | undefined;
      }> = [];
      for (const frame of el.querySelectorAll<HTMLElement>(
        SHOWN_PANE_FRAMES,
      )) {
        // A pane the pointer positions writes its own `left`/`top` every
        // frame; motion on top of a pointer lags the pointer. The mark is
        // `data-pointer-owned`, not `data-gesture`: the latter goes on at the
        // press, and a press that never travels leaves the frame the
        // imposer's, so a commit landing during it — the click's reveal —
        // must still carry the frame rather than cut it.
        if (frame.hasAttribute("data-pointer-owned")) continue;
        const paneId = frame.getAttribute("data-pane-id");
        if (paneId === null) continue;
        // Still arriving: not on screen as far as this settle is concerned,
        // so it has no First rect to measure and nothing to hand back yet.
        // The Last pass finds it as an arrival again ([P08]).
        if (pendingArrivalsRef.current.has(paneId)) continue;
        // Hidden and arriving — appended to its column but not yet part of
        // its division ([B01]). Not on screen either, for the same reasons:
        // no First rect, no restore, no cancel. The commit that clears the
        // mark leaves the attribute off the new DOM, so the Last pass of THAT
        // settle finds the frame with no First rect and plays its arrival.
        if (frame.hasAttribute("data-arriving")) continue;
        // A frame caught mid-settle is HELD BEFORE it is measured, and that
        // order is the whole of this branch.
        //
        // It is not snapped to the end it never reached — `hold-at-current`
        // is `commitStyles()` and then a cancel, so the pose the tween is
        // showing this instant becomes the frame's own inline style, and the
        // velocity it was carrying is handed to the beat of the same kind
        // this arm is about to launch, so the card continues rather than
        // stopping and starting again ([P04]). A frame caught mid-resize is
        // held at the size the eye has too, and its First rect is that size,
        // so it is re-planned from where it is.
        //
        // Measuring FIRST is what this used to do, on the reasoning that the
        // rect is measured through the running transform and the hold leaves
        // that transform exactly as measured. The first half of that is not
        // reliable: an accelerated transform lives on the compositor, and
        // `getBoundingClientRect` reads the style the main thread last
        // resolved — which, for a frame whose inline style still carries the
        // START pose of the tween now playing over it, is that start pose
        // rather than the pose on screen. One frame per gesture read that
        // way: its First came back equal to its Last, the Last pass planned
        // no tween for it, and it CUT to its new place while every frame
        // beside it glided — the close-during-an-arrival jump ([P08]).
        //
        // `commitStyles()` is exactly the repair, because it resolves the
        // animation's current value itself rather than asking layout what it
        // thinks. Measuring after it reads a pose that is inline, resolved,
        // and the one on screen. The hand-back stays in the second pass: it
        // writes a value the frame does NOT have, which is a relayout, and a
        // relayout between two frames' measurements is a First rect nobody saw.
        const running = settleTweensRef.current.get(paneId);
        if (running !== undefined) {
          const beat = settleBeatRef.current;
          if (interrupted === null && beat !== null) {
            // Read once: every frame in a beat rides the same curve, and the
            // velocity is the beat's own recipe at the beat's own elapsed
            // time, off the spring it was actually launched with.
            interrupted = {
              kind: beat.kind,
              velocity: velocityAt(
                BEAT_RECIPE[beat.kind],
                {
                  nominalMs: settleDurationRef.current,
                  initialVelocity: beat.initialVelocity,
                },
                performance.now() - beat.launchedAt,
              ),
            };
          }
          deckTrace.record({
            kind: "settle-retarget",
            paneId,
            mode: "matched",
            beat: beat?.kind ?? null,
          });
          for (const anim of running.anims) anim.cancel("hold-at-current");
        }
        if (measure) firstRects.set(paneId, frame.getBoundingClientRect());
        // The fold's near side. Read for every frame rather than only the
        // ones that turn out to cross, because which frames those are is not
        // knowable until the Last pass has the other side: `data-folded` is an
        // attribute read, and the content rect costs nothing extra in a loop
        // that has already flushed layout for the frame's own rect above.
        if (measure) {
          firstFolds.set(paneId, {
            folded: frame.hasAttribute("data-folded"),
            contentHeight: contentBoxHeight(frame),
            contentWidth: contentBoxWidth(frame),
          });
        }
        // The edge, for the departure this frame may make. Read for every
        // frame for `firstFolds`' reason — which ones depart is not knowable
        // until the Last pass — and it is one attribute read.
        if (measure) {
          const side = frame.getAttribute("data-rail-side");
          if (side === "left" || side === "right") {
            firstRailSides.set(paneId, side);
          }
        }
        armed.push({ paneId, frame, running });
      }

      // A column whose mode flipped moves the one member the stack shows and
      // holds every other one behind it — `settleHoldPlanRef` says why the
      // survivor is the z-frontmost rather than the top tile. Skipped under
      // reduced motion with the rest of the choreography, but the mode record
      // always advances — a stale record would read the next flip against
      // the wrong shore. Planned here, ahead of the hold at arm below, which
      // reads it: a covered member's height changes in the store, but the
      // settle never tweens it — it stands at its tile behind the survivor and
      // snaps at release under the cover — so it has no crossing to hold.
      const holdPlan = settleHoldPlanRef.current;
      holdPlan.survivors.clear();
      holdPlan.covered.clear();
      holdPlan.held.clear();
      // A COLUMN whose mode flipped gets the cover choreography: the frame the
      // stack actually shows is the z-frontmost member, not the top of the
      // column's order, so that is the one that moves and every other one
      // is covered. Picking the top member instead would grow a frame that
      // ends up hidden while the card the stack goes on to display arrived by
      // a cut.
      //
      // A rail has no such flip — it is always divided.
      const columns = deckColumnsOf(state, null);
      const prevColumnModes = prevColumnModesRef.current;
      if (motion && prevColumnModes !== null) {
        for (const column of columns) {
          const prevMode = prevColumnModes.get(column.slot);
          if (prevMode === undefined || prevMode === column.mode) continue;
          if (column.members.length < 2) continue;
          const members = new Set(column.members);
          let survivor: string | undefined;
          for (const pane of state.panes) {
            if (members.has(pane.id)) survivor = pane.id;
          }
          if (survivor !== undefined) holdPlan.survivors.add(survivor);
          for (const paneId of column.members) {
            if (paneId === survivor) continue;
            holdPlan.covered.add(paneId);
            if (column.mode === "stack") holdPlan.held.add(paneId);
          }
        }
      }
      prevColumnModesRef.current = new Map(
        columns.map((column) => [column.slot, column.mode]),
      );

      // THE HOLD AT ARM. The frames the new arrangement resizes are
      // held at their First content height HERE, in the store's notify,
      // before React commits the arrangement. Held in the Last pass instead —
      // the canvas's layout effect, which React runs after its children's —
      // the hold arrived after every card's own layout effects had already
      // seen the frame at its new height, unheld, and relaid the transcript
      // out inside the commit that plans the motion. Which frames change
      // height is a pure function of the store (`predictHeightCrossings`),
      // so no DOM is read for it; the height held is the one this loop just
      // measured into `firstFolds`.
      //
      // The Last pass confirms each hold with a re-mark that never lowers,
      // or ends one the frame turned out not to need. A hold an earlier
      // `arm` left unconfirmed — two arms in one task, one coalesced commit —
      // is re-made here if this arm predicts it again and ended if not.
      // Only when measuring: a prelaunched flow slide changes no heights, and
      // under reduced motion there is no tween for a hold to stand under.
      {
        const stale = new Map(armHeldRef.current);
        armHeldRef.current.clear();
        if (measure) {
          const rendered = renderedRef.current;
          const afterDeck = store.getPicture();
          const after = rendered.deriveArrangement(afterDeck, {
            rail: store.getRailRunHeight(),
            column: store.getColumnRunHeight(),
          });
          const beforeById = new Map(rendered.deck.panes.map((p) => [p.id, p]));
          const afterById = new Map(afterDeck.panes.map((p) => [p.id, p]));
          const frameById = new Map(armed.map((a) => [a.paneId, a.frame]));
          const pairs: Array<{ before: TugPaneState; after: TugPaneState }> = [];
          for (const { paneId } of armed) {
            const before = beforeById.get(paneId);
            const afterPane = afterById.get(paneId);
            if (before !== undefined && afterPane !== undefined) {
              pairs.push({ before, after: afterPane });
            }
          }
          for (const paneId of predictHeightCrossings(rendered.arrangement, after, pairs)) {
            const frame = frameById.get(paneId);
            const height = firstFolds.get(paneId)?.contentHeight ?? 0;
            if (frame === undefined || height <= 0) continue;
            if (holdPlan.covered.has(paneId)) continue;
            const wasFolded = beforeById.get(paneId)?.folded === true;
            const willFold = afterById.get(paneId)?.folded === true;
            // An UNFOLD is left to the Last pass. The card is folded on screen
            // until the commit, so its open interior has no First picture to
            // hold: held here, it would be laid out at the folded box, and the
            // crossing's first frame would be a folded card. Its hold opens in
            // the Last pass, at the open height, as it always has ([R02]).
            if (wasFolded && !willFold) continue;
            // A fold opens the fold crossing, which sets the still mark beside
            // its own: the two are one crossing, on for the same frames.
            const folds = wasFolded !== willFold;
            if (folds) markFoldCrossing(frame, height);
            else markStillCrossing(frame, height);
            armHeldRef.current.set(frame, folds ? "fold" : "still");
            stale.delete(frame);
          }
        }
        endArmHeldNotCarried(stale);
      }

      // The shadow strips, once rather than per frame: there is one per SIDE,
      // and a rail's members all cast the same one.
      //
      // A strip is HELD BEFORE IT IS MEASURED, for the frames' reason above,
      // and by the same hold: the strip is the depth of the rail beside it,
      // so a rail caught mid-slide and re-planned from the pose the eye has
      // needs its strip held and measured at the pose the eye has too, or the
      // Last pass plans the two different journeys and the shadow comes away
      // from its panel. A strip still HELD for an arrive beat that has not
      // launched (no anims) is left exactly as a pending arrival is: not on
      // screen, nothing to hand back, and the Last pass holds it again. An
      // entry whose strip has left the document is a record of nothing.
      const armedStrips: Array<{
        key: string;
        strip: HTMLElement;
        running: SettleTween;
      }> = [];
      for (const [key, entry] of [...settleTweensRef.current]) {
        if (!key.startsWith(RAIL_SHADOW_TWEEN_PREFIX)) continue;
        if (!entry.el.isConnected) settleTweensRef.current.delete(key);
      }
      if (measure) {
        for (const strip of el.querySelectorAll<HTMLElement>(
          STANDING_RAIL_SHADOWS,
        )) {
          const side = strip.getAttribute("data-rail-shadow");
          if (side !== "left" && side !== "right") continue;
          const running = settleTweensRef.current.get(railShadowTweenKey(side));
          if (
            running !== undefined &&
            running.el === strip &&
            running.anims.length > 0
          ) {
            for (const anim of running.anims) anim.cancel("hold-at-current");
            armedStrips.push({
              key: railShadowTweenKey(side),
              strip,
              running,
            });
          }
          firstRailShadows.set(side, strip.getBoundingClientRect());
        }
      }

      perfMark("tug:arm-measured");
      // Second pass: the episodes. A begin is a READ — `discoverScrollers`
      // asks `scrollHeight`, and every unclaimed scroller it finds is then
      // measured down to twelve boxes deep — so it belongs with the
      // measurements, not with the hand-backs, and this pass is where the
      // measuring half of the arm ends.
      //
      // It used to share the write pass below, one frame at a time: begin,
      // restore, begin, restore. The restore in the middle is the relayout
      // the write pass exists to isolate, so every frame after the first read
      // a tree the frame before it had just dirtied — nine forced style
      // resolutions on a fold, one per pane, and about eighty milliseconds of
      // the lead. Hoisted here they all read the tree the First pass already
      // flushed, and nothing writes between them.
      //
      // Every episode now anchors against the same outgoing geometry — the
      // pose the eye has, held by the cancel above — rather than against
      // whatever the frames beside it had been handed back so far, which is
      // the anchor contract `resize-episode.ts` states and the interleaved
      // order could only keep for the first frame.
      //
      // `deferStamp` is the other half, and the half the chain probe actually
      // named. A begin's own `data-resize-episode` write is the style-dirtying
      // write in all nine chains — read (frame 1) → stamp (frame 2) → read
      // (frame 2) — so hoisting the loop alone would have moved the chains
      // rather than removed them. Held back to the write pass, the reads here
      // run with nothing written between them at all.
      const stamps: Array<() => void> = [];
      if (sizeChanged) {
        for (const { paneId, frame } of armed) {
          const handle = beginResizeEpisode(frame, episodeWindowMs, {
            deferStamp: true,
          });
          episodes.set(paneId, handle);
          stamps.push(() => handle.stamp());
        }
      }
      perfMark("tug:arm-episodes-end");

      // Third pass: the frames caught mid-settle. Every write below — a
      // restored width, a cleared transform, an episode's stamp — happens
      // after the last measurement above. The residue still goes back on the
      // SAME tick as the cancel that earned it, which is what the registry's
      // own doc asks for; it goes back a few lines later in that tick.
      //
      // "Nothing paints in between" is the claim that used to close this
      // sentence, and under [D204] it is NOT true on its own: the deck's
      // notify lands a painted frame later, so on a retarget the frame would
      // paint once at the interrupted settle's end pose. What makes it true
      // is the flush after the strips, which is why that flush is a rule
      // rather than an optimization — see "A RETARGET IS NEVER DEFERRED"
      // below, which is the whole of the argument.
      for (const apply of stamps) apply();
      // Did the arm cancel anything? Every branch below that hands residue
      // back is a retarget, and a retarget is never deferred — see the flush
      // after the strips.
      let retargeted = armedStrips.length > 0;
      for (const { paneId, frame, running } of armed) {
        if (running !== undefined) {
          retargeted = true;
          // The `snap-to-end` the hold above replaces committed the tween's
          // FINAL value into inline style instead, and the microtask that took
          // it back was long enough to paint — one frame at a stale size
          // against fresh calc geometry, which is the flash the census counts.
          for (const restore of running.restores) restore();
          clearFlip(paneId, frame, running.anims);
          // Its crossing, if it has one, is the next Last pass's to carry on
          // or to end: the cancel just made the old completion a no-op.
          retargetedFramesRef.current.add(frame);
        }
      }
      // The strips' residue goes back on the same tick, after the last
      // measurement, for the frames' reason.
      for (const { key, strip, running } of armedStrips) {
        for (const restore of running.restores) restore();
        clearFlip(key, strip, running.anims);
      }

      // A RETARGET IS NEVER DEFERRED ([B01]).
      //
      // "Nothing paints in between" above is a claim about this tick, and it
      // only holds while React commits on this tick too. Under [D204] the
      // deck's notify lands a painted frame later, so the residue comes off
      // here, the frame paints once at the interrupted settle's END pose
      // carrying no tween at all, and only then does the Last pass measure
      // Last and tween from the mid pose it inverted. The eye gets
      // mid → old end → mid → new end, and the bench cannot see it: the
      // frame has no effect on that tick, so the off-curve classifier has no
      // curve to compare it against.
      //
      // The flush asks the store to tell React inline instead. `arm` is a
      // synchronous subscriber, so this commit has not scheduled its
      // deferral yet and the call is a VOTE rather than a flush; the store
      // reads it a few lines after `arm` returns and the Last pass follows
      // the restores before anything paints, exactly as it did before [D204].
      // The cost is that a retarget pays the commit in-task — the price a
      // retarget always paid. The deferral's win was the first gesture's,
      // and it keeps it.
      //
      // Moving the third pass into the Last pass was the alternative and is
      // rejected: it changes what First measures on the next retarget and
      // reopens the stale-size flash this pass was written to close.
      if (retargeted) store.flushPendingNotify?.();
      // A gesture arriving mid-motion runs its own set-up at once: whatever
      // the motion gate held joins it here, before this arm's first frame.
      openMotionGate();

      // The census closes the arm. `panes` is the number of frames this
      // settle will carry; `armed` is false when the signature changed but
      // nothing will tween — reduced motion, or a deck whose every frame is
      // gesture-owned — which is what separates "nothing moved" from "the
      // move went uncarried".
      deckTrace.record({
        kind: "settle-arm",
        signature: next.full,
        panes: firstRects.size,
        armed: motion && firstRects.size > 0,
        landing,
        outcome: motion && firstRects.size > 0 ? "carried" : "unarmed",
        ...(switching ? { reason: "switching" as const } : {}),
      });
      tugDevLogStore.debug("arrival", "settle ARM", {
        panes: firstRects.size,
        armed: motion && firstRects.size > 0,
        landing,
      });
      // Handed to the beat of the same kind the Last pass builds. The beat
      // that was running is over either way: its frames are held and
      // re-planned, and nothing is on a beat until the Last pass starts one.
      settleLaunchRef.current = interrupted;
      settleBeatRef.current = null;

      el.style.setProperty(
        "--tugx-imposer-settle-duration",
        `${IMPOSITION_SETTLE_MS}ms`,
      );
      putSettlingMarkOn(el);
      const settleMs = readSettleMs(el);
      settleDurationRef.current = settleMs;
      if (prelaunch) {
        // Hold every store's React notify past the tween's first frame, so
        // no commit later in this task lands in it.
        gestureScope.open("prelaunch");
        // And past the land: the slide's beats launch here, so this is its
        // motion's first frame ([B05]).
        closeMotionGate(Math.max(2 * settleMs * getTugTiming(), 1000));
        // The strip's new place, written now on every reader so every pane's
        // `left` is at its destination in the frame the tween's inverse holds
        // it at its origin. The layer's own effect writes the same value after
        // React commits, which is a no-op by then.
        writeCanvasFlowOffset(el, nextFlowOffset);
        // `left = C - offset`, so First - Last = next - origin.
        const dx = nextFlowOffset - flowOrigin;
        // A lifted hand's speed seeds the slide, so it continues the hand's
        // motion rather than restarting from rest: travels per second over
        // the slide's own `dx`, converted so the first frames move at the
        // hand's measured rate, and only toward the stop. It changes the
        // curve's shape, never where it ends, and it is held under the
        // recipe's forward limit — the crossing must not carry past the stop
        // and come back, which is the one motion a swipe's release forbids.
        const handTravels =
          flowHandVelocity !== null && dx !== 0 ? flowHandVelocity / dx : 0;
        const forwardLimit =
          motionForwardVelocityLimit(BEAT_RECIPE.move, settleMs) ?? 0;
        const launchVelocity = Math.min(
          motionLaunchVelocity(BEAT_RECIPE.move, settleMs, Math.max(handTravels, 0)),
          forwardLimit,
        );
        const curve = motionKeyframes(BEAT_RECIPE.move, {
          nominalMs: settleMs,
          initialVelocity: launchVelocity,
        });
        const keyframes = springSettleKeyframes({ dx, dy: 0 }, curve.progress);
        const token = {};
        // A prelaunched slide bumps no generation — the Last pass it stands
        // in for measures nothing and plans nothing — so a frame a pointer
        // gesture takes while it runs is marked against the one in force
        // now, and the landing below leaves that frame to the gesture.
        const generation = settleGenerationRef.current;
        // Only a frame whose `left` reads the strip's offset moved, so only
        // it has a delta to invert. A rail pane stands where it stood: the
        // slots changing never moves a sidebar card, and a tween launched
        // on one throws it `dx` off its place and glides it back.
        const movers = armed.filter(({ frame }) =>
          frame.matches(FLOW_OFFSET_FRAME_READERS),
        );
        // The first beat. Its start pose is the origin the inverse is scaled
        // about; the inverse itself is held by the effect's `backwards` fill,
        // from the store's own delta rather than a measurement.
        const move = planBeat({
          recipe: "move",
          targets: movers.map(({ frame }) => ({
            el: frame,
            keyframes,
            pose: { "transform-origin": "0 0" },
          })),
          durationMs: curve.durationMs,
          fill: "backwards",
          composite: "replace",
          slotCancelMode: "hold-at-current",
          easing: "linear",
          key: "imposer-flip-move",
          record: recordBeat,
          onLand: () => {
            if (prelaunchRef.current?.token !== token) return;
            land();
          },
        });
        const land = (): void => {
          prelaunchRef.current = null;
          for (const { paneId, frame, anims } of launched) {
            if (takenFramesRef.current.get(frame) === generation) continue;
            clearFlip(paneId, frame, anims);
          }
          settleBeatRef.current = null;
          endSettleMarks(el);
          dispatchImposerSettleEnd(el);
          settleReleaseRef.current?.("completion");
          drainArrivalsRef.current();
        };
        // One registry entry per frame, each holding the array `clearFlip`
        // later matches by identity.
        const launched = movers.map(({ paneId, frame }, i) => {
          const anims = [move.anims[i] as TugAnimation];
          settleTweensRef.current.set(paneId, { el: frame, anims, restores: [] });
          return { paneId, frame, anims };
        });
        // A hand catching the strip mid-slide. One frame is measured where
        // the slide has it, then every frame is held and the landing takes
        // the holds off, and the frame is measured again at its committed
        // place; the difference is how far short of the stop the strip
        // stood: `left = C - offset`, so the live offset is the stop less it.
        //
        // Measured BEFORE the hold, against the pane-take's order. A take
        // here is followed in the same task by the hand drawing the answer,
        // so it must agree with the pose the last frame showed, and the
        // rect is that pose — it is what every reading of this slide has
        // reported. Read after `commitStyles` it came back as much as nine
        // pixels behind the frame before, and the strip stepped back at the
        // touch. A prelaunched slide carries no inline transform for the
        // rect to mistake for the pose, which is the hazard that order
        // guards against elsewhere.
        const take = (): number => {
          const lead = launched[0]?.frame;
          const seen = lead?.getBoundingClientRect();
          for (const { anims } of launched) {
            for (const anim of anims) anim.cancel("hold-at-current");
          }
          land();
          const committed = lead?.getBoundingClientRect();
          if (seen === undefined || committed === undefined) return nextFlowOffset;
          return nextFlowOffset - (seen.left - committed.left);
        };
        prelaunchRef.current = { token, take };
        settleBeatRef.current = {
          kind: "move",
          launchedAt: move.plannedAt,
          initialVelocity: launchVelocity,
          anims: move.anims,
          land: move.land,
        };
        el.setAttribute("data-imposer-beat", "move");
        tugDevLogStore.debug("arrival", "settle PRELAUNCH", {
          panes: launched.length,
          dx,
          launchVelocity,
        });
      }
      const windowMs = settleMs * getTugTiming();

      // The cap is generous against the window it guards — it is a
      // wedge guard, not a second clock, and firing it early would
      // reintroduce the very commit the hold is here to keep out. Sized
      // here against the crossing's nominal; the Last pass re-holds against
      // the choreography's total once it knows the beats.
      perfMark("tug:arm-planned");
      if (motion) {
        settleReleasedRef.current = false;
        holdSessions(Math.max(2 * windowMs, 1000));
        startSettleFrameRecord(el);
      }

      // Generous against the window it guards, like the hold's cap: the
      // sweep is a wedge guard behind the settle's own completion, and one
      // armed at exactly the crossing's duration would win the race with the
      // last tween's `finished` by a frame and release from the wrong clock.
      scheduleSweep(Math.max(2 * windowMs, 1000));
      perfMark("tug:arm-end");
    };
    const unsubscribe = store.subscribeSync?.(arm, "canvas-arm") ?? store.subscribe(arm);
    return () => {
      unsubscribe();
      settleSweepRef.current = null;
      settleReleaseRef.current = null;
      if (settleTimerRef.current !== null) {
        window.clearTimeout(settleTimerRef.current);
      }
      // Unmounting mid-gesture leaves neither a running tween nor a
      // transform — nor a card whose notifications nobody will release.
      // A pending arrival's hold comes off inside `releaseSettle` on every
      // path, this one included ([B10]): the effect's teardown re-runs
      // whenever `store` or a hold callback changes identity, and there the
      // frames outlive it.
      releaseSettle("unmount");
      // A land still waiting on its ticks has no deck left to read.
      {
        const land = settleFramesRef.current.land;
        if (land.raf !== null) cancelAnimationFrame(land.raf);
        land.raf = null;
        land.finish = null;
        landRecorder.disarm();
      }
      settleBeatRef.current = null;
      settleLaunchRef.current = null;
      for (const [paneId, entry] of [...settleTweensRef.current]) {
        for (const anim of entry.anims) anim.cancel("snap-to-end");
        clearFlip(paneId, entry.el, entry.anims);
        endFoldCrossing(entry.el);
        endStillCrossing(entry.el);
      }
(retargetedFramesRef.current);
(armHeldRef.current);
      for (const [, handle] of settleEpisodesRef.current) handle.end();
      settleEpisodesRef.current.clear();
      settleFirstRectsRef.current.clear();
      settleFirstFoldsRef.current.clear();
      settleHoldPlanRef.current.survivors.clear();
      settleHoldPlanRef.current.covered.clear();
      settleHoldPlanRef.current.held.clear();
      // The canvas is coming down, and a target's holds and marks are inline
      // writes rather than React's ([L06]): handed back here, and every
      // departure the store holds landed, since nothing is left to carry one.
      releaseDepartingTargetsRef.current("all");
      store.landDepartures();
      // Nothing is left to run an arrive beat, so nothing is left to clear a
      // mark. A caller still waiting would wait past the canvas itself.
      drainArrivalsRef.current();
      if (containerRef.current !== null) {
        takeSettlingMarkOff(containerRef.current);
      }
      containerRef.current?.removeAttribute("data-imposer-beat");
      // No settle-end notice here, and that is the one place the pairing does
      // not hold. This is the arm effect's teardown: the canvas is coming
      // down, every sheet listening on it is coming down with it, and the
      // notice's only answer is a clamp measure against a container that is
      // about to leave the document.
      //
      // One listener does NOT come down with it, because it is not a sheet's
      // and not React's: a flash parked on the settle that was running when
      // this canvas was taken away. Its record is module-local, so nothing
      // collects it and the next canvas's first settle would ring a pane this
      // one no longer holds. This teardown being the one path with no notice
      // is exactly why the drop has to be made here by hand.
      dropPendingFlash();
    };
  }, [store, holdSessions, releaseSessions, openMotionGate, openMotionGateAfterLand, closeMotionGate]);

  // Last, and the tween. Declared AFTER the inset effect above, and that order
  // is load-bearing: React runs layout effects in declaration order, and the
  // inset effect writes the `--tug-imposer-inset-*` values every imposed
  // frame's `left` calc resolves against. Measuring Last before the fresh
  // insets land would tween every rail side flip from a stale delta.
  useLayoutEffect(() => {
    perfMark("tug:last-pass");
    const el = containerRef.current;
    const firstRects = settleFirstRectsRef.current;
    const firstFolds = settleFirstFoldsRef.current;
    const firstRailSides = settleFirstRailSidesRef.current;
    const firstRailShadows = settleFirstRailShadowsRef.current;
    // Every episode this commit does not go on to hand a tween is finished
    // here: the new geometry is in the DOM, so ending lands each anchor
    // against the layout the user is about to see. The tweened ones are
    // ended by their own completion below, after the inline residue is
    // handed back.
    const endEpisode = (paneId: string): void => {
      const handle = settleEpisodesRef.current.get(paneId);
      if (handle === undefined) return;
      settleEpisodesRef.current.delete(paneId);
      handle.end();
    };
    const endAllEpisodes = (): void => {
      for (const [, handle] of settleEpisodesRef.current) handle.end();
      settleEpisodesRef.current.clear();
    };
    // A pending arrival that closed before its arrive beat ran (Spec S02 step
    // 0): its frame now wears `data-departing`, still at the `opacity: 0` the
    // arrival hold put on it. It leaves the pending map WITHOUT its restorers,
    // so nothing hands it back to full opacity before the store unmounts it,
    // and it plans no beat — nobody ever saw it. A pass of its own, ahead of
    // everything else, because `arm` skips a pending arrival and so its id is
    // never among the First rects the departure loop below walks.
    for (const [paneId, pending] of [...pendingArrivalsRef.current]) {
      if (pending.frame.hasAttribute("data-departing")) {
        pendingArrivalsRef.current.delete(paneId);
      }
    }
    // A FRAME STILL DEPARTING IS NOT AN ARRIVAL ([B04]). A rail shown again
    // while its hide's depart beat is still carrying it out is back among
    // the shown frames with no First rect — it was parked when `arm` ran —
    // and the arrival branch below would hold it invisible and slide it in
    // from the edge while the depart beat still owns it, and the depart's
    // landing would then hand back holds captured before the hide. So it is
    // released from its depart target here, before anything asks who is
    // arriving and before an empty First pass is read as nothing to carry:
    // the beat is cut where the eye has it, the frame is measured there, its
    // holds and its mark go back, and that pose is its First rect. From
    // there it is planned as the show it is — a frame carried from where it
    // stands to where the commit put it — and the strip of its side the same
    // way, so the panel and its depth travel together.
    if (el !== null) {
      const releaseDeparting = (target: HTMLElement, key: string): DOMRect | null => {
        if (!target.hasAttribute(SETTLE_DEPARTING_ATTR)) return null;
        const entry = departingTargetsRef.current.get(key);
        if (entry === undefined || entry.el !== target) return null;
        for (const anim of entry.anims ?? []) anim.cancel("hold-at-current");
        const seen = target.getBoundingClientRect();
        for (const restore of entry.restores) restore();
        departingTargetsRef.current.delete(key);
        return seen;
      };
      for (const frame of el.querySelectorAll<HTMLElement>(SHOWN_PANE_FRAMES)) {
        const paneId = frame.getAttribute("data-pane-id");
        if (paneId === null || firstRects.has(paneId)) continue;
        const seen = releaseDeparting(frame, paneId);
        if (seen !== null) firstRects.set(paneId, seen);
      }
      for (const strip of el.querySelectorAll<HTMLElement>(STANDING_RAIL_SHADOWS)) {
        const side = strip.getAttribute("data-rail-shadow");
        if (side !== "left" && side !== "right") continue;
        const seen = releaseDeparting(strip, railShadowTweenKey(side));
        if (seen !== null) firstRailShadows.set(side, seen);
      }
    }
    if (el === null || firstRects.size === 0) {
      // Nothing is carried on, so every frame a retarget took is ended here.
(retargetedFramesRef.current);
(armHeldRef.current);
      firstRects.clear();
      firstFolds.clear();
      firstRailSides.clear();
      firstRailShadows.clear();
      endAllEpisodes();
      // A settle with nothing to carry is over the moment it is read: the
      // hold taken at arm comes off now, on the settle's own clock, rather
      // than at the sweep — unless a settle an earlier pass launched is still
      // running, in which case the marks and the hold are its own and this
      // pass has nothing to end.
      if (settleTweensRef.current.size === 0) {
        if (el !== null) takeSettlingMarkOff(el);
        el?.removeAttribute("data-imposer-beat");
        if (el !== null) dispatchImposerSettleEnd(el);
        settleReleaseRef.current?.("completion");
      }
      // OUTSIDE that guard, unlike the marks above it. Those are conditional
      // because they may belong to an earlier pass still running, which will
      // take them off itself. An arrival marked and never drained is stranded
      // whoever owns the marks, and this pass has nothing that will run a beat.
      drainArrivalsRef.current();
      // And a departure with nothing to carry it is over now, for the same
      // reason: no beat will run here, and no later pass collects it ([P06]).
      landSettledDeparturesRef.current();
      return;
    }
    // Reduced motion: the layout has already snapped, and that IS the settle.
    // The check is made here rather than left to TugAnimator, which would
    // strip the spatial keyframes and substitute an opacity fade — a flash on
    // every frame, all of which already sit where they belong.
    //
    // The episodes still close here, and closing them is the whole of the
    // preservation on this path: no tween ran, so there was nothing to
    // re-anchor per frame, and the one apply at the end is exact.
    //
    // A switch epoch takes the same branch, for the same reason and with the
    // same effect: the arm that opened this settle saw the mark and measured
    // no First rects, so there is nothing here to carry and every frame would
    // otherwise read as an arrival and be faded up ([P02]).
    if (!isTugMotionEnabled() || settleSwitchingRef.current) {
(retargetedFramesRef.current);
(armHeldRef.current);
      firstRects.clear();
      firstFolds.clear();
      firstRailSides.clear();
      firstRailShadows.clear();
      endAllEpisodes();
      // A pending arrival's hold comes off HERE rather than at the sweep
      // ([B03]). Under reduced motion no arrive beat will ever run, so the
      // `whenBeatBegins` delete that ends an arrival is never reached and the
      // frame stays at inline `opacity: 0` until the settle window timer —
      // up to a second of an invisible card. The restorers are what hand the
      // pre-hold opacity back, so they run with the id: dropping the id alone
      // would leave the frame invisible rather than merely unfaded.
      for (const [paneId, pending] of [...pendingArrivalsRef.current]) {
        pendingArrivalsRef.current.delete(paneId);
        for (const restore of pending.restores) restore();
      }
      if (settleTweensRef.current.size === 0) {
        takeSettlingMarkOff(el);
        el.removeAttribute("data-imposer-beat");
        dispatchImposerSettleEnd(el);
        settleReleaseRef.current?.("completion");
      }
      // Outside the guard, for the reason the other early return states: under
      // reduced motion no beat runs at all, so nothing else will ever clear a
      // mark this pass found standing.
      drainArrivalsRef.current();
      landSettledDeparturesRef.current();
      return;
    }
    const clearFlip = clearFlipRef.current;
    const duration = settleDurationRef.current;
    const holdPlan = settleHoldPlanRef.current;
    /**
     * The frames this settle committed behind a flipped column's survivor —
     * the hold plan's `covered`, with what each one holds and hands back.
     * Released together at the chain's one completion ([B03]); the doc on
     * `settleHoldPlanRef` says why.
     */
    const covered: Array<{
      paneId: string;
      frame: HTMLElement;
      anims: TugAnimation[];
      restores: Array<() => void>;
    }> = [];
    // The choreography, for this settle. The move beat IS the crossing;
    // `shrink` and `grow` are the resize beats' shorter windows, and
    // `divide-join` is the one the outer fades run on. All are stated
    // relative to `duration` — the one tunable — in `lib/imposer-motion.ts`,
    // and no call site here picks a curve of its own ([P02] of
    // arc/layout-imposer-polish.md).
    //
    // A retarget hands the interrupted beat's velocity to the beat of the
    // SAME kind here — a move's to the move, a shrink's to the shrink — and
    // every other beat launches from rest ([B06]), so a frame caught
    // mid-settle carries on rather than stopping and restarting, and a card
    // that was closing up is never thrown across the deck at that speed.
    const launch = settleLaunchRef.current;
    settleLaunchRef.current = null;
    // The three beats' curves. A settle that carries a size term runs as up to
    // three beats in a fixed order — shrink, move, grow — each on its own
    // recipe, so that at any instant exactly one kind of thing is moving.
    // Built lazily, because the everyday settle has no resize beat and a
    // curve nobody plays is a spring solved for nothing.
    const beatCurves: Partial<Record<BeatKind, MotionCurve>> = {};
    const beatCurve = (kind: BeatKind): MotionCurve => {
      const cached = beatCurves[kind];
      if (cached !== undefined) return cached;
      const built = motionKeyframes(BEAT_RECIPE[kind], {
        nominalMs: duration,
        initialVelocity: beatLaunchVelocity(kind, launch),
      });
      beatCurves[kind] = built;
      return built;
    };
    const crossing = beatCurve("move");
    const fadeCurve = motionKeyframes("divide-join", { nominalMs: duration });
    /**
     * The frames this settle carries by beats, in the order the pass found
     * them. `next` is the index of the beat this frame has not yet run; the
     * `anims` array is the SAME one registered in `settleTweensRef`, and each
     * beat pushes into it, so a retarget mid-choreography cancels whatever is
     * actually in flight and `clearFlip`'s identity check still holds.
     */
    interface Choreographed {
      paneId: string;
      frame: HTMLElement;
      beats: SettleBeat[];
      next: number;
      anims: TugAnimation[];
      restores: Array<() => void>;
      /**
       * The frame's own inline size values as REACT rendered them, keyed by
       * axis — the same closures `restores` holds, reachable one at a time.
       *
       * A beat hands its axis back the moment it ends, and what it hands back
       * has to be the committed value rather than nothing: the imposer writes
       * its hold onto the very property React rendered the frame's height
       * into, so `removeProperty` there takes React's number away with the
       * hold and leaves the frame standing at its content's own height until
       * the settle's completion restores it. On a fold that is the folded card
       * at its OPEN floor for the whole of the move beat.
       */
      handBack: { width?: () => void; height?: () => void };
      crossingId: number | null;
      /** The still crossing's id — set on every frame with a height term, folding or not. */
      stillCrossingId: number | null;
      /**
       * Whether the frame's interior is held at its STARTING width — a width
       * shrink — so it re-flows only when the hold comes off at the land, and
       * its resize episode has to outlive that re-flow.
       */
      reflowsAtLand?: boolean;
    }
    const choreography: Choreographed[] = [];
    // Whether this settle OPENED a fold crossing — a fold or an unfold it is
    // the first to carry, not one it adopted mid-travel. Read where the beats
    // launch, which is where the fold's prepare beat is paid.
    let opensFoldCrossing = false;
    /**
     * The frames arriving in this settle, and the targets carrying out the
     * panes leaving it — collected by the passes below and launched by the
     * chain's outer beats ([P05]).
     *
     * Neither is a `Choreographed`: a `SettleBeat` is a partition of one
     * frame's FLIP terms, and these two have none — an arrival has no First
     * rect to invert and a departure has no Last one. They are collected as
     * what they are and the chain gives each its beat.
     */
    const arrivals: Array<{
      paneId: string;
      frame: HTMLElement;
      restores: Array<() => void>;
    }> = [];
    const departures: Array<{
      paneId: string;
      el: HTMLElement;
      /**
       * The start pose's inverse translate, which the target is held at for
       * its whole beat: where it stood at First, from where it stands now.
       * For a strip, the offset from where it stood at First to its parked
       * or empty box.
       */
      dx: number;
      dy: number;
      /**
       * A rail leaves by the edge it stands on, and this is how far ([B10]).
       * `undefined` for a frame in the band, which has no edge of its own
       * and fades where it stands.
       */
      travelPx?: number;
    }> = [];
    /**
     * Which side each departing RAIL left by, keyed by the target's name.
     *
     * Collected while the targets are found and read once afterwards, when
     * the travel per side can be measured against the canvas. A band frame is
     * absent from it, which is what "this exit is a fade" means.
     */
    const railSideOfDeparture = new Map<string, SidebarSide>();
    /**
     * The shadow strips of the sides whose rails are ALL arriving, held
     * invisible with their rails and slid in on the arrive beat.
     */
    const arrivingStrips: Array<{
      key: string;
      strip: HTMLElement;
      side: SidebarSide;
      restores: Array<() => void>;
    }> = [];
    // This launch. Every completion below — a fade's, an entrance's, the
    // beat choreography's — checks it before touching anything, because a
    // retarget that landed in between has already cancelled, restored and
    // re-planned every frame, and a later Last pass owns them now.
    const generation = ++settleGenerationRef.current;
    // A frame a pointer gesture took from THIS settle is the gesture's from
    // then on: nothing below that would write it — a beat's landing, the
    // completion's hand-back — touches it again.
    const taken = (frame: HTMLElement): boolean =>
      takenFramesRef.current.get(frame) === generation;
    // ONE release for the whole settle, on the settle's own clock: the hold
    // taken at arm comes off when the last of this pass's completions has
    // landed — after the final beat's last tween, never from the window
    // timer — so the one publish lands on settled geometry ([B04]).
    let outstanding = 0;
    const finish = (): void => {
      // The settle is over: the marks come off here, on the settle's own
      // clock, and the sweep behind it finds nothing left to do. Through
      // {@link endSettleMarks}, because the restores ran a few statements ago
      // and the window has to outlast the style recalc that sees them.
      endSettleMarks(el);
      // The settle's own clock announcing its own end. Every sheet up on this
      // canvas measures its clamp here, and nowhere in between ([P07]).
      dispatchImposerSettleEnd(el);
      settleReleaseRef.current?.("completion");
      // Every card the deck holds that is still marked has arrived, whether or
      // not an arrive beat is what brought it: this is the moment the settle
      // is over, and the drain is what makes the event unmissable ([R01]).
      drainArrivalsRef.current();
      // And every departure is over: the store removes each closed pane, its
      // cards and its mark in one commit, outside the window, where its
      // teardown is nobody's frame ([P03], [P06]).
      landSettledDeparturesRef.current();
    };
    const settled = (): void => {
      outstanding -= 1;
      if (outstanding === 0 && settleGenerationRef.current === generation) {
        finish();
      }
    };
    const settleOpts = {
      // Raw ms: TugAnimator scales by getTugTiming() itself.
      duration: crossing.durationMs,
      // **A frame's start pose is held by the FRAME, never by the animation's
      // clock.** That is the rule, and `backwards` is what enforces it.
      //
      // The move beat inverts: keyframe 0 is `translate(first - last)`, so the
      // pose that holds a frame at its ORIGIN is the effect's own first
      // keyframe. `el.animate()` returns a PLAY-PENDING animation whose start
      // time stays unresolved until the compositor has been handed the effect,
      // and under `fill: "none"` an effect whose local time is unresolved
      // applies NOTHING. Every tick inside that window painted the frame where
      // the commit had already put it — at the END of the travel, with none of
      // it shown. A gap counter cannot see that: the frames arrived on time,
      // they simply arrived carrying the wrong pose.
      //
      // This does not break [D6], which forbids a RETAINED effect after the
      // tween. A backwards fill applies only in the BEFORE phase; in the after
      // phase it applies nothing, exactly as `none` does. So what TugAnimator
      // commits at an effect's end is unchanged, and so is every hand-back
      // that reads it.
      fill: "backwards",
      composite: "replace",
      // Cancelled by the arm above, which reads progress and velocity off the
      // curve before it does — holding where the eye is, never snapping to an
      // end the frame never reached ([P04]).
      slotCancelMode: "hold-at-current",
    } as const;
    // Which frames this pass actually found. Whatever `arm` measured and this
    // loop never reaches has left the DOM during the commit, which is the only
    // notice a departing pane gives: by the time an effect could run on it,
    // there is no element to run one on.
    const survivors = new Set<string>();
    // Whether this settle carries an arrival or a departure, answered BEFORE
    // anything is planned, because every frame's plan depends on it ([P08]).
    //
    // The pass below discovers both while it walks — a frame with no First
    // rect is arriving, and a First rect with no survivor departed — but by
    // then the first frames have already been planned, and a settle cannot
    // fuse half its frames. Both questions are answerable from what is
    // already in hand: the frames in the DOM now, and the rects `arm`
    // measured. So they are asked here, on one walk of each, and the answer
    // is one boolean for the whole settle.
    //
    // `data-pointer-owned` is excluded on the arrival side for the reason the
    // walk below states: a zone drop has no First rect and is not arriving.
    for (const frame of el.querySelectorAll<HTMLElement>(
      SHOWN_PANE_FRAMES,
    )) {
      const paneId = frame.getAttribute("data-pane-id");
      if (paneId !== null) survivors.add(paneId);
    }
    const hasArrival = Array.from(
      el.querySelectorAll<HTMLElement>(SHOWN_PANE_FRAMES),
    ).some(
      (frame) =>
        !frame.hasAttribute("data-pointer-owned") &&
        !frame.hasAttribute("data-arriving") &&
        !firstRects.has(frame.getAttribute("data-pane-id") ?? ""),
    );
    const hasDeparture = Array.from(firstRects.keys()).some(
      (paneId) => !survivors.has(paneId),
    );
    // One gesture, one beat. An arrival's or a departure's room is made or
    // given up once, and the deck reads as making it once rather than as a
    // survivor shrinking, then sliding, then a newcomer appearing ([P08]).
    // The everyday arrangement change — neither arriving nor departing — is
    // never fused and keeps its shrink/move/grow partition exactly.
    const fused = hasArrival || hasDeparture;
    const traveled: Array<Record<string, number | string>> = [];
    // The frames this pass holds at their final height, announced to their
    // interiors once every hold is written, so what each reads is the
    // geometry of the first frame.
    const settledFrames: HTMLElement[] = [];
    // A frame whose interior width is settled at its final size this pass.
    let widthSettles = false;
    for (const frame of el.querySelectorAll<HTMLElement>(
      SHOWN_PANE_FRAMES,
    )) {
      const paneId = frame.getAttribute("data-pane-id");
      if (paneId === null) continue;
      survivors.add(paneId);
      // A pointer-owned frame is never the settle's to carry, whatever the
      // First pass knew about it. Checked before the entrance test because a
      // zone drop is the case where the two collide: the arm skipped the
      // frame (no First rect, exactly like an arrival), but it is not
      // arriving — it is mid-landing under `zone-drop-landing`, and an
      // entrance played here replaces that landing's transform, snapping the
      // card to its tile and fading it in for no reason. The drag or the
      // landing owns its geometry, and its own episode owns the scroll
      // under it.
      if (frame.hasAttribute("data-pointer-owned")) {
        endEpisode(paneId);
        continue;
      }
      // A frame still hidden and arriving is not this settle's either: it
      // has no First rect because `arm` skipped it, and it is not arriving
      // in the settle's sense until the commit that clears its mark. Nothing
      // to plan, nothing to hold, and no episode was opened on it.
      if (frame.hasAttribute("data-arriving")) continue;
      const firstRect = firstRects.get(paneId);
      if (firstRect === undefined) {
        // A frame that was not on screen when this settle armed: it is
        // arriving, not travelling. FLIP has nothing to say about it — there
        // is no First rect to invert — but the promise the settle keeps for
        // every other frame is that a card never changes places in one frame,
        // and a card that materializes at full opacity has broken it just as
        // plainly as one that jumped. So it enters under its own effect,
        // played at the geometry the commit already gave it: a fade up and a
        // short rise, which reads as arriving without pretending it came from
        // anywhere in particular.
        //
        // Reaching this branch at all means a settle is genuinely in flight —
        // the guard above returns when no First rects were measured, which is
        // the mount case, so a deck restoring at launch does not fade every
        // card in.
        //
        // Its own slot key, because this is not the geometry effect and must
        // not cancel one: a frame can arrive into a settle that is also moving
        // its neighbours, and the two effects belong to different frames.
        // The entrance bakes an opacity on its way out, exactly as the
        // geometry effect bakes a width — so it is handed back the same way,
        // and by the same restorer a cancel would run.
        //
        // The entrance is now the chain's LAST beat rather than an effect
        // launched alongside it ([P05]), so what happens here is the opening
        // pose and nothing else: the frame is held invisible until its arrive
        // beat comes round, which is the same rule `applyHolds` states for an
        // axis whose grow beat is still to come. The hold's restorers go in
        // the PENDING map and nowhere else ([B10]) — `arm`, the sweep and the
        // unmount teardown all read them there, and the `settleTweensRef`
        // entry is written when the arrive beat begins, with its fade already
        // in it. A frame left wearing the hold would be a card nobody can
        // see, so exactly one of the two records owns it at every instant.
        //
        // No `outstanding += 1` here: the chain accounts for the arrive beat,
        // and counting it twice would leave the settle's hold outstanding
        // forever.
        // A frame this settle found still ARRIVING — held invisible by the
        // settle a retarget just replaced, its arrive beat never launched —
        // keeps the restorer that knows the opacity it had before any hold.
        // Capturing a fresh one here would record the hold itself as the
        // value to hand back, and the card would end its arrival invisible.
        //
        // The pending map is where that restorer lives now ([B10]), and it
        // answers the question exactly: an id still in it is a frame whose
        // arrive beat never began, which is the one case worth carrying. A
        // frame whose beat DID begin is out of the map and in
        // `settleTweensRef`, where a retarget's `arm` has already cancelled
        // its fade and run its restorers — so a fresh capture is right there.
        const prior = pendingArrivalsRef.current.get(paneId);
        const restores = prior?.restores ?? [inlineRestorer(frame, "opacity")];
        frame.style.opacity = "0";
        pendingArrivalsRef.current.set(paneId, { frame, restores });
        arrivals.push({ paneId, frame, restores });
        continue;
      }
      const lastRect = frame.getBoundingClientRect();
      traveled.push({
        paneId,
        firstY: Math.round(firstRect.top),
        firstH: Math.round(firstRect.height),
        lastY: Math.round(lastRect.top),
        lastH: Math.round(lastRect.height),
      });
      const anims: TugAnimation[] = [];
      const restores: Array<() => void> = [];
      // The fold crossing this frame opened, if it is crossing at all. Read by
      // the completion handler, which is the only thing that may close it, and
      // only by this id: a cancelled tween's handler lands after a replacement
      // settle has already re-marked the frame.
      let crossingId: number | null = null;
      let stillCrossingId: number | null = null;
      let reflowsAtLand = false;
      if (holdPlan.covered.has(paneId)) {
        // A member a column mode flip committed behind its survivor. It does
        // not travel and it does not fade ([B02] of
        // `briefs/column-flip-cover-brief.md`): a stack is the survivor
        // covering its neighbours and a split is the survivor uncovering
        // them, and z-order already puts the survivor in front. Nothing on
        // the frame animates; it wears the cover, and the mark rides the
        // settle's own registry so a retarget cancels it through the same
        // door as everything else.
        //
        // On a split the frame is at its tile, which the commit has already
        // put it at behind the survivor's held full run — the stacked rect it
        // was measured at was never a pose the user saw — so there is nothing
        // to hold. On a stack it is HELD: the commit has already moved it to
        // the full run it will occupy behind the survivor, and letting that
        // landing show would be the card sliding across the column, so it
        // keeps the tile it is leaving as a static inverse. One inline write,
        // so nothing interpolates, for exactly the survivor's crossing: the
        // chain's completion takes it off with the cover. The snap to the
        // full run at release lands under the survivor, which is what the
        // cover tells the census.
        if (holdPlan.held.has(paneId)) {
          const { dx, dy } = flipDelta(firstRect, lastRect);
          frame.style.transformOrigin = "0 0";
          restores.push(inlineRestorer(frame, "height"));
          applyHolds(frame, {
            transform: { dx, dy, sx: 1 },
            height: firstRect.height,
          });
        }
        frame.setAttribute("data-imposer-covered", "");
        settleTweensRef.current.set(paneId, { el: frame, anims, restores });
        covered.push({ paneId, frame, anims, restores });
        continue;
      } else {
        const { dx, dy, sx } = flipDelta(firstRect, lastRect);
        // Whether the width change is small enough to ride the transform
        // as a raster smear, or crosses by real geometry ([D135]).
        // Height never smears: the gestures that change it halve or double
        // it, which no cap admits, so any height delta is a real term.
        //
        // Both axes are floored at half a pixel, so a measurement that came
        // back a hair different is not a size change. Without the floor a rail
        // mode flip — which does not touch width at all — can still read
        // `sx !== 1` off sub-pixel rounding and pick up a `scaleX` term for a
        // deformation of about one ten-millionth: invisible, but it is a frame
        // being told to do something it does not have to.
        const widthChanges = Math.abs(firstRect.width - lastRect.width) >= 0.5;
        const heightTweens = Math.abs(firstRect.height - lastRect.height) >= 0.5;
        const widthSmears =
          widthChanges && scaleDistortion(sx) <= MAX_FLIP_SCALE_DISTORTION;
        const widthTweens = widthChanges && !widthSmears;
        // A FOLD CROSSING: the frame's `data-folded` differs between the two
        // sides of the commit and its height is a real term. That pair is the
        // whole of the detection ([B04] of `session-fold-still-interior`) —
        // the imposer already holds both sides, so nothing is cached, nothing
        // is watched, and nothing inside the card is measured.
        //
        // The held height is the LARGER of the two content heights, which is
        // the open one in both directions: First on the fold in, Last on the
        // unfold ([F06]). The card is laid out once at that height and the
        // content box clips it, so no top inside the card moves while the
        // edge sweeps ([B01]).
        //
        // Marked before the tween starts and taken off in the completion
        // handler below, which is also where the crossing's end is announced
        // — the imposer's spring is the crossing's only clock ([B03], [B05]).
        const firstFold = firstFolds.get(paneId);
        // The far side's content height, read ONCE for both marks below. The
        // fold's mark writes the held height onto the content box's children
        // and the mark onto the frame, so a second `contentBoxHeight` after it
        // is a forced layout of the card at its far-side height — 3–4ms on a
        // 1630px session card, paid in the frame that launches the motion.
        const lastContentHeight = heightTweens ? contentBoxHeight(frame) : null;
        // A width term holds the interior too, so its height is read here
        // whether or not it tweens, and its width beside it — both before any
        // mark below is written.
        const heldContentHeight = heightTweens
          ? lastContentHeight
          : widthTweens
            ? contentBoxHeight(frame)
            : null;
        const lastContentWidth = widthTweens ? contentBoxWidth(frame) : null;
        if (
          heightTweens &&
          firstFold !== undefined &&
          firstFold.folded !== frame.hasAttribute("data-folded")
        ) {
          const heldHeight = Math.max(
            firstFold.contentHeight ?? 0,
            lastContentHeight ?? 0,
          );
          if (heldHeight > 0) {
            crossingId = markFoldCrossing(frame, heldHeight);
            opensFoldCrossing = true;
          }
        }
        // A crossing this settle did not open, on a frame it is taking over.
        // The edge has not stopped — this settle is carrying the rest of the
        // same travel — so the crossing continues, under an id belonging to
        // the tween that will actually finish it. Without this the cancelled
        // tween's completion would close it here, with the whole rest of the
        // travel still to come, and the card would land in its terminal form
        // mid-sweep. Every deck change that shares a window with a fold is
        // this case, which is most of them in a wall.
        if (crossingId === null && heightTweens) {
          crossingId = adoptFoldCrossing(frame);
        }
        // A STILL CROSSING: the height term alone. The fold's argument never
        // depended on the fold — a subtree held at one definite height is not
        // dirtied by its frame's tween — so every frame whose height is a
        // real term is held at the larger of its two content heights, by the
        // same two reads the fold uses and nothing inside the card. A stack
        // or a split marks its survivor, a join or a leave every member whose
        // tile resizes; a covered member carries no height term and never
        // reaches here.
        //
        // One mark call covers all three cases. A fold above has already set
        // this mark, and a retarget finds one standing: both are re-marks,
        // which take a fresh id — so the cancelled tween's completion cannot
        // release it — and never lower the height already held, which is what
        // makes First measured mid-tween safe to pass.
        //
        // A frame that is not folding is held at its FINAL height instead —
        // a settled crossing ([B04]). The larger height kept a picture laid
        // out at its open size while the edge swept, and paid for it at the
        // land: the hold came off, the interior re-laid itself out at the
        // size it landed at, and the list view paid its owed pin there, 35–49
        // ms on a real transcript in the one frame that hands back. Laid out
        // at its final height in the set-up, the interior has nothing left
        // to do when the hold comes off. A fold keeps the open picture: its
        // interior must stay laid out open while it folds.
        //
        // So does a SHRINK. Held at its final height, a shrinking interior is
        // shorter than the box until the edge arrives, and the strip it does
        // not cover is bare background: on a following transcript, 576px of
        // rows gone at the first frame of a column join, under the chrome,
        // where no neighbour can cover it. A growth's final height is its
        // larger one, so the settled hold costs it nothing; a shrink holds its
        // starting height and pays its land.
        //
        // A WIDTH term is held on the same terms ([B05] of
        // set-up-and-go-fixups): a list view under a widening frame
        // re-windowed its rows at every width the tween passed through, one
        // commit per frame. Held at the final width on a growth — settled,
        // so its pin is paid in the set-up — and at the starting width on a
        // shrink, for the shrink's reason above.
        if (heightTweens || widthTweens) {
          const folding =
            opensFoldCrossing || frame.hasAttribute(FOLD_CROSSING_ATTR);
          const heightShrinks =
            heightTweens &&
            firstFold?.contentHeight != null &&
            lastContentHeight !== null &&
            lastContentHeight < firstFold.contentHeight;
          const widthShrinks =
            widthTweens &&
            firstFold?.contentWidth != null &&
            lastContentWidth !== null &&
            lastContentWidth < firstFold.contentWidth;
          const shrinks = heightShrinks || widthShrinks;
          if (
            !folding &&
            !shrinks &&
            heldContentHeight !== null &&
            heldContentHeight > 0
          ) {
            stillCrossingId = settleStillCrossing(frame, heldContentHeight);
            settledFrames.push(frame);
          } else {
            const stillHeight = Math.max(
              firstFold?.contentHeight ?? 0,
              heldContentHeight ?? 0,
            );
            stillCrossingId =
              stillHeight > 0
                ? markStillCrossing(frame, stillHeight)
                : adoptStillCrossing(frame);
          }
          if (widthTweens && stillCrossingId !== null) {
            if (!widthShrinks) widthSettles = true;
            else reflowsAtLand = true;
            holdStillWidth(
              frame,
              Math.max(
                widthShrinks ? (firstFold?.contentWidth ?? 0) : 0,
                lastContentWidth ?? 0,
              ),
              heightTweens,
            );
          }
        }
        // A frame that did not move and did not change size gets no animation
        // at all.
        if (dx === 0 && dy === 0 && !widthChanges && !heightTweens) {
          endEpisode(paneId);
          continue;
        }
        // Captured BEFORE `applyHolds` writes this settle's holds, so what
        // each one hands back is React's committed value and not a hold —
        // `arm` has already run any in-flight settle's restores, so nothing
        // older is standing on these properties either.
        const handBack: { width?: () => void; height?: () => void } = {};
        if (widthTweens) {
          handBack.width = inlineRestorer(frame, "width");
          restores.push(handBack.width);
        }
        if (heightTweens) {
          handBack.height = inlineRestorer(frame, "height");
          restores.push(handBack.height);
        }
        // The beats this frame runs — shrink, move, grow, skipping any it has
        // nothing for — so that no beat carries a size term and a translate
        // together ([B01] of `three-beat-settle`). A frame with no size term
        // plans to exactly one move beat carrying today's terms, which is the
        // stack move, unchanged ([B02]).
        const beats = planSettleBeats(
          {
            dx,
            dy,
            sx: widthSmears ? sx : 1,
            width: widthTweens ? [firstRect.width, lastRect.width] : undefined,
            height: heightTweens
              ? [firstRect.height, lastRect.height]
              : undefined,
          },
          // Fused per frame, not per settle: a column mode flip's survivor
          // rides one `room` beat because its move and its height change are
          // one edge ([B01] of `briefs/column-flip-cover-brief.md`), while every
          // other frame this settle carries keeps its shrink/move/grow plan.
          { fused: fused || holdPlan.survivors.has(paneId) },
        );
        if (beats.length === 0) {
          endEpisode(paneId);
          continue;
        }
        // The scale anchors the frame's top-left corner, which is the corner
        // `dx` and `dy` were measured from. Set for every settle that carries a
        // transform, scaling or not, so the property has one value and one
        // owner rather than depending on which kind of gesture wrote it last;
        // `clearFlip` takes it off with the transform.
        const moves = dx !== 0 || dy !== 0 || widthSmears;
        if (moves) {
          frame.style.transformOrigin = "0 0";
        }
        // The opening pose, written now, before this commit paints: the frame
        // is committed at Last, and until its move beat runs it must stand at
        // First — a constant translate (and smear), held inline — and until
        // its grow beat runs a growing axis must stay at its First size. It
        // is the frame's, not its first beat's: the beats launch below, after
        // every frame is planned, and a beat is all frames' together, so a
        // frame whose own first beat is the move or the grow waits in this
        // pose while its neighbours make room.
        // The RULE, in both directions: every size term this frame's FIRST
        // beat carries is held at its First value until that beat runs,
        // alongside the inverse transform.
        //
        // It used to hold a GROWING axis only, and that was correct for one
        // reason and one only — the shrink beat was the settle's first beat,
        // so a shrinking axis had nothing to wait through and could be left
        // at the Last size the commit already gave it. That is no longer
        // true. With `room` in {@link BEAT_ORDER} the fused beat is not first
        // whenever a departure is present, so in the combined settle
        // (`["depart","room","arrive"]`) a survivor whose height shrinks
        // would stand at its shrunken size from the launch and the beat would
        // then animate a height from Last to Last.
        //
        // Reading the planned beats is necessary but not sufficient, which is
        // why the direction asymmetry goes with it: what matters is not which
        // way an axis moves but whether its beat has run, and until it has,
        // the frame belongs at First.
        const firstBeat = beats[0];
        applyHolds(frame, {
          ...(moves ? { transform: { dx, dy, sx: widthSmears ? sx : 1 } } : {}),
          // What the first beat itself holds — the axis whose own beat is
          // later still — and what the first beat ANIMATES, held at its start
          // until it does. A beat never holds an axis it animates, so the two
          // spreads can never fight over one property, and together they are
          // every size term the frame carries.
          ...(firstBeat?.held.width !== undefined
            ? { width: firstBeat.held.width }
            : {}),
          ...(firstBeat?.held.height !== undefined
            ? { height: firstBeat.held.height }
            : {}),
          ...(firstBeat?.terms.width !== undefined
            ? { width: firstBeat.terms.width[0] }
            : {}),
          ...(firstBeat?.terms.height !== undefined
            ? { height: firstBeat.terms.height[0] }
            : {}),
        });
        settleTweensRef.current.set(paneId, { el: frame, anims, restores });
        choreography.push({
          paneId,
          frame,
          beats,
          next: 0,
          anims,
          restores,
          handBack,
          crossingId,
          stillCrossingId,
          reflowsAtLand,
        });
        continue;
      }
    }
    // Every frame a retarget took over whose crossing the loop above did not
    // adopt — covered, sliding, arriving or gone — has its crossing ended
    // now, while the rest of the settle is planned.
    // And every frame `arm` held on the store's word that this pass found
    // carrying no height term: the prediction over-marked it, and its hold
    // comes off here, in the pass that knows.
    const carriedStill = new Set(
      choreography
        .filter((c) => c.stillCrossingId !== null)
        .map((c) => c.frame),
    );
    endCrossingsNotCarried(retargetedFramesRef.current, carriedStill);
    endArmHeldNotCarried(armHeldRef.current, carriedStill);
    // The shadow strips, planned AFTER every frame so the answer to "did this
    // side's rail survive?" is in hand. A strip is the rail's depth, and it
    // moves exactly as the rail does or it is not that — every case below is
    // one way of keeping the two on one clock.
    //
    // A side whose rails are ALL arriving — none survived the commit with a
    // First rect — is a rail sliding in from its edge. The commit drew the
    // strip at home, where it would stand alone through every beat before the
    // arrive while the rail is still held invisible: that is the stripe seen
    // standing in the middle of a card a beat before the rail comes in. So
    // the strip is held invisible WITH the rail, and slides in on the arrive
    // beat on the rail's own number. A side whose strip moved between First
    // and Last while a rail survived — the rail was caught mid-slide and
    // re-planned from where it was — is a strip travelling with its rail's
    // move, and it is choreographed like a frame: held at First, carried on
    // the side's beat, its transform taken off when the beat lands. A side
    // whose rails all left keeps its strip parked or empty, and it is carried
    // out below with the rail's frames. React writes neither opacity nor
    // transform on a strip, so handing either back is taking it off.
    const railArrivingSides = new Set<SidebarSide>();
    for (const { frame } of arrivals) {
      const side = frame.getAttribute("data-rail-side");
      if (side === "left" || side === "right") railArrivingSides.add(side);
    }
    for (const frame of el.querySelectorAll<HTMLElement>(SHOWN_PANE_FRAMES)) {
      const paneId = frame.getAttribute("data-pane-id");
      if (paneId === null || !firstRects.has(paneId)) continue;
      const side = frame.getAttribute("data-rail-side");
      if (side === "left" || side === "right") railArrivingSides.delete(side);
    }
    for (const strip of el.querySelectorAll<HTMLElement>(STANDING_RAIL_SHADOWS)) {
      const side = strip.getAttribute("data-rail-shadow");
      if (side !== "left" && side !== "right") continue;
      const key = railShadowTweenKey(side);
      const restores = [
        (): void => {
          strip.style.removeProperty("opacity");
        },
        (): void => {
          strip.style.removeProperty("transform");
        },
      ];
      if (railArrivingSides.has(side)) {
        strip.style.opacity = "0";
        settleTweensRef.current.set(key, { el: strip, anims: [], restores });
        arrivingStrips.push({ key, strip, side, restores });
        continue;
      }
      const firstRect = firstRailShadows.get(side);
      if (firstRect === undefined) continue;
      const dx = firstRect.left - strip.getBoundingClientRect().left;
      if (Math.abs(dx) < 0.5) continue;
      const beats = planSettleBeats({ dx, dy: 0, sx: 1 }, { fused });
      if (beats.length === 0) continue;
      const anims: TugAnimation[] = [];
      strip.style.transformOrigin = "0 0";
      applyHolds(strip, { transform: { dx, dy: 0, sx: 1 } });
      settleTweensRef.current.set(key, { el: strip, anims, restores });
      choreography.push({
        paneId: key,
        frame: strip,
        beats,
        next: 0,
        anims,
        restores,
        handBack: {},
        crossingId: null,
        stillCrossingId: null,
      });
    }
    // The departures (Spec S02). A pane `arm` measured that no longer stands
    // among the shown frames has left the arrangement during this commit, and
    // the depart beat carries it out on its OWN frame, which already stood at
    // rest: nothing is created inside the window to stand in for it ([D9]).
    //
    // Two kinds of frame are still in the DOM to carry. A CLOSE leaves the
    // pane mounted, `inert` and outside the solver for this settle, wearing
    // `data-departing`; the store removes it at the settle's land ([P01]). A
    // rail HIDDEN WHOLE leaves its frames mounted at their pinned box, parked
    // and hidden; the engine shows each for the length of its exit and hides
    // it again at the land ([P05]). A pane that left through any other writer
    // — a move to another workspace, the emptied source of a tab merge — has
    // no frame left here, and its card lives on elsewhere: it gets no depart
    // beat, and the survivors' beats run alone ([P04]).
    //
    // Each target is held at its First rect from here to its beat's end: the
    // inverse translate of where the commit put it, and its First width and
    // height where its box changed (a parked rail's width variable drops to
    // zero when it parks). Static holds, written in this pass like every
    // survivor's ([P09]); its beat animates only `transform` and `opacity`.
    //
    // ONE animation is unconditional on the settle generation, and it is the
    // depart beat's LANDING — the `depart` branch below says so at its own
    // site. A target is in no record `arm` walks, so a generation check there
    // would strand its holds for the life of the canvas.
    //
    // Every read here is behind a departure. The survivors' holds are already
    // written by this point, so a geometry read is a forced layout, and one
    // paid on a settle with nothing leaving lands in the lead of every
    // arrival and every walk across the band.
    for (const [paneId, firstRect] of firstRects) {
      if (survivors.has(paneId)) continue;
      endEpisode(paneId);
      const frame = el.querySelector<HTMLElement>(
        `.tug-pane[data-pane-id="${CSS.escape(paneId)}"]`,
      );
      if (frame === null) continue;
      const kind = frame.hasAttribute("data-departing")
        ? "closing"
        : frame.hasAttribute("data-rail-parked")
          ? "parked"
          : null;
      if (kind === null) continue;
      const lastRect = frame.getBoundingClientRect();
      const { dx, dy } = flipDelta(firstRect, lastRect);
      const restores: Array<() => void> = [
        inlineRestorer(frame, "transform"),
        inlineRestorer(frame, "transform-origin"),
        inlineRestorer(frame, "opacity"),
        inlineRestorer(frame, "width"),
        inlineRestorer(frame, "height"),
        () => frame.removeAttribute(SETTLE_DEPARTING_ATTR),
      ];
      frame.setAttribute(SETTLE_DEPARTING_ATTR, paneId);
      frame.style.transformOrigin = "0 0";
      applyHolds(frame, {
        transform: { dx, dy, sx: 1 },
        ...(Math.abs(firstRect.width - lastRect.width) >= 0.5
          ? { width: firstRect.width }
          : {}),
        ...(Math.abs(firstRect.height - lastRect.height) >= 0.5
          ? { height: firstRect.height }
          : {}),
      });
      // Registered the instant it is held, so every exit can hand it back by
      // name. Unlaunched until its beat is running ([B10]).
      departingTargetsRef.current.set(paneId, {
        el: frame,
        kind,
        launched: false,
        restores,
      });
      departures.push({ paneId, el: frame, dx, dy });
      const railSide = firstRailSides.get(paneId);
      if (railSide !== undefined) railSideOfDeparture.set(paneId, railSide);
    }
    // A rail leaves by the edge it stands on, and it takes its SHADOW with
    // it. The shadow is one strip per side drawn by the canvas rather than by
    // any pane ([D183]), and it always stands: a side whose rails all left
    // keeps its strip mounted, parked or empty and hidden, so its depth would
    // blink out while the panel slides away — a panel and its depth are one
    // object as the eye reads them. That strip is shown for the beat and
    // carried out with the rail, on its own element, exactly as a parked
    // frame is ([P05]). A rail losing one of two members keeps its standing
    // strip, which the survivors' pass above already carries.
    //
    // Every target on a side travels the RAIL's distance, never its own,
    // measured from where it stood at First. The strip stands ten pixels
    // inboard, so measuring it against the edge separately would give it a
    // longer journey and the two would drift apart over the crossing.
    if (railSideOfDeparture.size > 0) {
      const canvasRect = el.getBoundingClientRect();
      const travelBySide = new Map<SidebarSide, number>();
      for (const departure of departures) {
        const side = railSideOfDeparture.get(departure.paneId);
        if (side === undefined || travelBySide.has(side)) continue;
        const firstRect = firstRects.get(departure.paneId);
        if (firstRect === undefined) continue;
        travelBySide.set(side, railTravelPx(firstRect, side, canvasRect));
      }
      for (const departure of departures) {
        const side = railSideOfDeparture.get(departure.paneId);
        if (side === undefined) continue;
        departure.travelPx = travelBySide.get(side) ?? 0;
      }
      for (const [side, px] of travelBySide) {
        const firstRect = firstRailShadows.get(side);
        if (firstRect === undefined) continue;
        const strip = el.querySelector<HTMLElement>(
          `[data-rail-shadow="${side}"]`,
        );
        if (
          strip === null ||
          !(
            strip.hasAttribute("data-rail-parked") ||
            strip.hasAttribute("data-rail-empty")
          )
        ) {
          continue;
        }
        const key = railShadowTweenKey(side);
        const restores: Array<() => void> = [
          inlineRestorer(strip, "transform"),
          inlineRestorer(strip, "opacity"),
          () => strip.removeAttribute(SETTLE_DEPARTING_ATTR),
        ];
        const dx = firstRect.left - strip.getBoundingClientRect().left;
        strip.setAttribute(SETTLE_DEPARTING_ATTR, key);
        applyHolds(strip, { transform: { dx, dy: 0, sx: 1 } });
        // In the same registry as the frames, so the teardown's "take them
        // all" sweep reaches it too, and unlaunched with its rail, because it
        // rides the same beat ([B10]).
        departingTargetsRef.current.set(key, {
          el: strip,
          kind: "strip",
          launched: false,
          restores,
        });
        departures.push({ paneId: key, el: strip, dx, dy: 0, travelPx: px });
      }
    }
    // The beats. Every frame's shrink tweens together; on their joint
    // completion every frame's move tweens; then every frame's grow tweens —
    // and a beat no frame has a term in is skipped, so the everyday stack move
    // is one move beat and nothing else ([B01], [B02]). Each beat's keyframes
    // are cut from that beat's terms alone on that beat's recipe, and the
    // container names the running beat in `data-imposer-beat` so a sampled
    // frame can be read against the beat it belongs to.
    if (choreography.length + arrivals.length + departures.length > 0) {
      tugDevLogStore.debug("arrival", "settle LAST → beats", {
        fused,
        arrivals: arrivals.map((a) => a.paneId),
        departures: departures.length,
        traveled,
      });
      outstanding += 1;
      const present = (kind: BeatKind): Choreographed[] =>
        choreography.filter((c) => c.beats[c.next]?.kind === kind);
      // The sweep's window is the choreography's whole window — the sum of
      // the non-empty beats' — never the crossing's nominal alone, which would
      // fire mid-choreography and snap every frame to its end. The store
      // hold's cap is re-sized against the same total, for the same reason:
      // a cap that fired mid-choreography would publish into a beat.
      //
      // A kind counts when some frame has a beat of it OR — for the outer two,
      // which no frame plans — when anything is arriving or departing. Leaving
      // them out of the sum would size the window to the middle three alone and
      // fire the sweep and the hold's cap mid-choreography.
      const launched = BEAT_ORDER.filter((kind) => {
        if (kind === "depart") return departures.length > 0;
        if (kind === "arrive") return arrivals.length > 0;
        return choreography.some((c) => c.beats.some((b) => b.kind === kind));
      });
      // A FOLD'S PREPARE BEAT: one move at a time. A fold's commit changes the
      // card's interior — on an unfold the transcript slot comes back from
      // `display: none` — and what answers that change arrives a frame later:
      // observers' rAF-coalesced writes, the after-paint React notify. Left to
      // land under the tween they held the main thread 30–47ms right after
      // the first moving frame, where the spring covers most of its travel, so
      // the edge crossed half the card in a hole. So a settle that opens a
      // fold crossing holds every beat off by this much: the frame stands at
      // First for the frame those answers land in — nothing visible changes,
      // the held interior is clipped by a frame that has not moved — and the
      // edge starts on the frame after. One and a half display frames rather
      // than two, so the second frame is always inside it and the third never
      // is. A crossing this settle merely adopted is already travelling and
      // pays nothing.
      //
      // An ARRIVAL takes a prepare beat for the same reason, one frame
      // longer: the revealed card is laid out for the first time in the frame
      // after its commit, and the observers its passive effects attach after
      // that paint deliver in the frame after that ([B05] of
      // set-up-and-go-fixups). Its gate closes after both, so what lands in
      // them is the set-up's.
      //
      // So does a frame whose WIDTH settles at its final size: its interior
      // re-flows at the new width in the set-up, and the observers inside it
      // answer that in the same two frames an arrival's do.
      const lateClose = arrivals.length > 0 || widthSettles;
      const prepareMs =
        lateClose
          ? ARRIVAL_PREPARE_MS
          : opensFoldCrossing
            ? FOLD_PREPARE_MS
            : 0;
      const totalMs =
        prepareMs +
        launched.reduce(
          (sum, kind) => sum + motionDurationMs(BEAT_RECIPE[kind], duration),
          0,
        );
      if (totalMs > crossing.durationMs) {
        const totalWindowMs = totalMs * getTugTiming();
        settleSweepRef.current?.(Math.max(2 * totalWindowMs, 1000));
        holdSessions(Math.max(2 * totalWindowMs, 1000));
      }
      // The land, pre-paid ([B04]): each settled interior pays its pin, its
      // restore, its extent rebase and its re-window now, inside the set-up
      // commit, against the geometry the first frame paints — so the land
      // owes nothing. Before the gate closes, because what it commits is
      // the set-up's.
      for (const frame of settledFrames) announceStillCrossingSettled(frame);
      // The motion gate closes behind the beats ([B05]): this pass is the
      // set-up commit's layout effect, so that commit is in, and nothing
      // after it may tell React before the land. The cap is the hold's, a
      // wedge guard behind the release that normally opens it.
      const gateCapMs = Math.max(2 * totalMs * getTugTiming(), 1000);
      if (lateClose) closeMotionGateAfterPaint(gateCapMs);
      else closeMotionGate(gateCapMs);
      // Every launched beat's effect is created in THIS frame, each held off
      // by the sum of the durations of the launched beats before it, and the
      // chain that used to sequence them is gone. That chain cost a frame at
      // every hand-off: the next beat's effect was created in a microtask
      // after the previous one had already committed and cancelled, so it was
      // play-pending for the frame that followed and the frame wore the
      // finished pose through it. `at0566` measured the hole at both seams —
      // `shrink=64..237ms` then `move=254..653ms`, and `move=23..414ms` then
      // `grow=433..664ms` — and the off-curve probe read it as a single tick
      // at an offset near the first beat's end.
      //
      // What closes that hole is the CREATION, not a fill. A delayed beat
      // fills `none` — `runBeat` says why, and it is not a detail — so it
      // applies nothing through its delay and its opening pose is held by
      // the inline start pose its Beat writes when it is planned, for every
      // beat at once, exactly as it always was. What a beat no longer arrives
      // at its boundary needing is a COMPOSITOR: its animation was created frames
      // earlier and its start time resolved long before its active phase
      // begins, so its first active frame paints its own keyframe 0 with
      // nothing pending. That window, once per seam, was the whole hole.
      //
      // What remains of the chain is a NOTIFIER: each beat still lands itself
      // off its own `Promise.allSettled`, and the settle's one completion
      // waits on all of them.
      const beatMarkers: Animation[] = [];
      // A beat's own clock starts when its ACTIVE PHASE does, not when its
      // effect is created. The retarget reads velocity off the beat that is
      // UP, and with a delayed launch that is a function of elapsed time
      // rather than of which promise resolved — so `settleBeatRef` and the
      // container's `data-imposer-beat` are advanced at the moment the beat's
      // active phase begins.
      //
      // On the ANIMATION clock rather than on a timer, and the difference is
      // measurable: a `setTimeout` sized to the delay fires whenever the task
      // queue gets to it, which under a settle's own load is tens of ms late,
      // and `data-imposer-beat` would then name the previous beat for frames
      // in which this one is already painting — `at0566` reads the beat
      // windows off that attribute and measured the lag as a resident's top
      // edge travelling 37px "during the shrink". An empty effect of exactly
      // the delay's length shares the document timeline with the beat it
      // announces, so it resolves on the beat's own first active frame and
      // never after it.
      //
      // `stale` runs instead of `begin` when a later arm has superseded this
      // settle by the time the beat would have begun: the beat never runs,
      // and whatever it launched that nothing else owns is the caller's to
      // take back.
      const whenBeatBegins = (
        delayMs: number,
        begin: () => void,
        stale?: () => void,
      ): void => {
        if (delayMs <= 0) {
          begin();
          return;
        }
        const marker = timelineMark(el, delayMs);
        beatMarkers.push(marker);
        void marker.finished.then(
          () => {
            if (settleGenerationRef.current !== generation) {
              stale?.();
              return;
            }
            begin();
          },
          () => {
            /* cancelled with the settle; the beat it announced never ran */
          },
        );
      };
      // Every beat of the settle is planned here, and lands its frames once.
      // Its own completion lands them while this settle is still the deck's —
      // a beat cancelled or outlived by a later settle leaves them to that
      // one — and `arm` lands them when it finds the beat over before it
      // measures, having already moved the generation on by then. A departure
      // lands whatever the generation says: its targets are in no record a
      // later settle reads.
      const planSettleBeat = (
        options: Omit<BeatOptions, "onLand" | "record">,
        landFrames: () => void,
        unconditional = false,
      ): { beat: Beat; land: () => void } => {
        let landedByArm = false;
        const beat = planBeat({
          ...options,
          record: recordBeat,
          onLand: () => {
            if (
              unconditional ||
              landedByArm ||
              settleGenerationRef.current === generation
            ) {
              landFrames();
            }
          },
        });
        return {
          beat,
          land: () => {
            landedByArm = true;
            beat.land();
          },
        };
      };
      const runBeat = (kind: BeatKind, delayMs: number): Promise<void> => {
        // A backwards fill is for the FIRST beat and nothing else, and the
        // distinction is what keeps the delayed shape honest.
        //
        // What `backwards` buys is the play-pending window: `el.animate()`
        // returns an animation whose start time is unresolved until the
        // compositor has the effect, and under `none` an unresolved local time
        // applies nothing — the frame paints at its committed destination for
        // that window. Only a beat launched at delay 0 has such a window; a
        // delayed beat's animation is long since started by the time its
        // active phase begins, so its first active frame paints its own
        // keyframe 0 with nothing pending.
        //
        // And `backwards` on a DELAYED beat costs something real: the effect
        // is in effect for the whole delay, so a grow beat's `height` is
        // animating — in WebKit's sense — through the move beat that precedes
        // it, and the move stops being transform-only. That is the three-beat
        // settle's central promise ([P08]: at any instant exactly one kind of
        // thing is moving), and `at0566` read the loss of it as a 2.8px drift
        // between a frame and the transcript inside it during the move. So a
        // delayed beat fills `none` and its opening pose is held the way it
        // always was, by the inline hold the beat writes as its start pose
        // (`heldPose`) when it is planned.
        const beatFill: FillMode = delayMs > 0 ? "none" : settleOpts.fill;
        const launches = present(kind);
        // The outer two are not planned beats, so they are launched from what
        // the passes above collected rather than from `present`.
        if (kind === "depart" || kind === "arrive") {
          // A RAIL returns by the edge it stands on, and that is the one
          // entrance in the deck that is a slide rather than a fade: a left
          // rail is a panel pinned to the left edge, so it comes back in
          // moving right, and the right rail is its mirror. A card in the band
          // has no edge of its own and keeps the fade — it is not travelling
          // from anywhere, it is beginning to be here ([D135]). The way OUT is
          // the mirror of it, and it is here too now ([B10]): a rail's parked
          // frames slide off the edge they came in by, on this beat, with its
          // shadow strip beside them on the same keyframes.
          const canvasRect = el.getBoundingClientRect();
          // **One travel per side, and the shadow takes the pane's** — the
          // exit's rule, for the exit's reason.
          const railTravelBySide = new Map<SidebarSide, number>();
          const travelFor = (el2: HTMLElement, side: SidebarSide): number => {
            const known = railTravelBySide.get(side);
            if (known !== undefined) return known;
            const px = railTravelPx(el2.getBoundingClientRect(), side, canvasRect);
            railTravelBySide.set(side, px);
            return px;
          };
          const slideIn = (px: number) => ({
            // Opaque for the whole crossing, against the `opacity: 0` hold the
            // Last pass wrote: the card is travelling in from outside the
            // window rather than materializing, so there is nothing for a fade
            // to say. `land` takes the hold off when the slide arrives.
            opacity: [1, 1],
            transform: [`translateX(${px}px)`, "translateX(0px)"],
          });
          // The beat's layers, each on its own keyframes and slot: a
          // departing target or an arrival's frame. A band target fades where
          // it stands and keeps its inline hold; a rail target slides off its
          // edge from the same held translate, so the hold and keyframe 0
          // agree and nothing jumps when the beat begins.
          const targets: BeatTarget[] =
            kind === "depart"
              ? departures.map(({ el: target, dx, dy, travelPx }) => ({
                  el: target,
                  keyframes:
                    travelPx === undefined
                      ? { opacity: [1, 0] }
                      : {
                          transform: [
                            `translate(${dx}px, ${dy}px)`,
                            `translate(${dx + travelPx}px, ${dy}px)`,
                          ],
                        },
                  key: "imposer-depart",
                }))
              : arrivals.map(({ frame }) => {
                  const attr = frame.getAttribute("data-rail-side");
                  const side = isSidebarSide(attr) ? attr : undefined;
                  return {
                    el: frame,
                    keyframes:
                      side === undefined
                        ? {
                            opacity: [0, 1],
                            transform: [
                              `translateY(${PANE_ENTER_RISE_PX}px)`,
                              "translateY(0px)",
                            ],
                          }
                        : slideIn(travelFor(frame, side)),
                    key: "imposer-enter",
                  };
                });
          // The arriving sides' strips, after the frames so the positional
          // pairing below — `arrivals[i]` to `fades[i]` — is untouched. Each
          // is the LIVE strip the Last pass held invisible with its rail, and
          // it rides the rail's own number — one travel per side, the exit's
          // rule for the exit's reason — on the rail's own keyframes, so the
          // two cannot be a pixel apart on any frame of the crossing.
          //
          // Registered on its own entry, as a frame's slide is on the frame's:
          // a retarget's `arm` holds it where it is and measures it there, the
          // sweep hands it back, and `land` takes the hold off with the rails'.
          // Nothing here snaps to an end or lands on its own — a strip that
          // snapped home while its rail was held mid-slide would be the shadow
          // standing away from the panel that this whole passage forbids.
          const stripKeys: string[] = [];
          if (kind === "arrive") {
            for (const { key, strip, side } of arrivingStrips) {
              const px = railTravelBySide.get(side);
              if (px === undefined) continue;
              targets.push({
                el: strip,
                keyframes: slideIn(px),
                key: "imposer-enter-rail-shadow",
              });
              stripKeys.push(key);
            }
          }
          if (targets.length === 0) return Promise.resolve();
          // What the beat leaves behind when it lands. A departing target is
          // landed by its kind (`landDepartingTarget`): a closing frame held
          // at `opacity: 0` until the store unmounts it, a parked frame or a
          // strip handed back and hidden again. An arrival's opacity hold
          // comes off for the move and grow beats' reason: `fill: none` means
          // the effect's end value is the underlying inline style, and a frame
          // left wearing the hold would snap back to invisible.
          //
          // Only the targets THIS beat launched. A show inside the beat cuts
          // a target and drops it from the registry ([B04]), and a hide after
          // that registers a new one under the same key; this beat lands once
          // all of its effects settle, which can be after that, and landing
          // the newer target would hand back its holds mid-departure.
          const launchedTargets = new Map<string, DepartingTarget>();
          const landFades = (): void => {
            if (kind === "depart") {
              // Through the ref rather than through this closure's array: the
              // ref is the owner, and a hand-back that bypassed it would leave
              // an entry naming holds that are already gone.
              for (const { paneId } of departures) {
                const entry = departingTargetsRef.current.get(paneId);
                if (entry === undefined || entry !== launchedTargets.get(paneId)) continue;
                landDepartingTarget(entry);
                departingTargetsRef.current.delete(paneId);
              }
              // A beat that lands after its settle was superseded, with no
              // settle in flight, is the last word on these departures: the
              // store is told now. While a settle IS in flight, its own finish
              // lands them ([P06]).
              if (settleReleasedRef.current) landSettledDeparturesRef.current();
              return;
            }
            for (const { frame } of arrivals) {
              frame.style.removeProperty("opacity");
            }
            for (const { strip } of arrivingStrips) {
              strip.style.removeProperty("opacity");
              strip.style.removeProperty("transform");
            }
          };
          // A fade is `divide-join`: carried by opacity rather than by travel,
          // so its window is that recipe's and its easing is the plain one the
          // recipe states — there is no position to spring.
          //
          // A departure lands unconditionally on the generation, and it is the
          // only beat that does. Every other frame here is still on screen and
          // still registered in `settleTweensRef`, so a retarget's `arm`
          // cancels its tween, runs its restorers, and a later Last pass owns
          // it. A departing target is in neither: it is out of the shown
          // frames, so `arm` never measures it and no later pass will ever
          // collect it again. Left un-landed, its holds would stand for the
          // life of the canvas, one per close interrupted mid-fade.
          const { beat, land } = planSettleBeat(
            {
              recipe: kind,
              targets,
              durationMs: fadeCurve.durationMs,
              delayMs,
              fill: beatFill,
              composite: settleOpts.composite,
              slotCancelMode: settleOpts.slotCancelMode,
              easing: "ease-out",
            },
            landFades,
            kind === "depart",
          );
          const fades = beat.anims;
          for (const [i, key] of stripKeys.entries()) {
            const slide = fades[arrivals.length + i];
            if (slide !== undefined) settleTweensRef.current.get(key)?.anims.push(slide);
          }
          if (kind === "depart") {
            // The beat is running, so each of these targets now has a landing
            // coming that is unconditional on the generation. That is what
            // lets a retarget's `arm` leave them alone and take only the ones
            // nothing will ever collect.
            for (const [i, { paneId }] of departures.entries()) {
              const entry = departingTargetsRef.current.get(paneId);
              if (entry === undefined) continue;
              entry.launched = true;
              launchedTargets.set(paneId, entry);
              // Kept so a show that lands inside this beat can cut it where
              // it stands rather than wait for it ([B04]).
              const anim = fades[i];
              if (anim !== undefined) entry.anims = [anim];
            }
          }
          whenBeatBegins(delayMs, () => {
            el.setAttribute("data-imposer-beat", kind);
            settleBeatRef.current = {
              kind,
              launchedAt: performance.now(),
              initialVelocity: beatLaunchVelocity(kind, launch),
              anims: fades,
              land,
            };
            // An arriving frame stops being pending HERE — on the arrive
            // beat's own first active frame — rather than at the moment its
            // fade was constructed ([B03]). The doc on `pendingArrivalsRef`
            // says what the old placement cost. A retarget before this point
            // cancels the marker with the settle, so `begin` never runs, the
            // id stays in the set, and the replacement arm leaves the frame
            // alone: no First rect, hold kept, no restore.
            //
            // And it becomes a `settleTweensRef` entry in the same breath,
            // carrying the fade that is now running and the restorers the
            // pending map was holding ([B10]). The two records hand the frame
            // to each other rather than both describing it: while the beat is
            // still to come the pending map owns it, and from its first
            // active frame the tween record does — which is exactly when
            // there is a tween to record.
            if (kind === "arrive") {
              for (const [i, { paneId, frame, restores }] of arrivals.entries()) {
                pendingArrivalsRef.current.delete(paneId);
                const anim = fades[i];
                settleTweensRef.current.set(paneId, {
                  el: frame,
                  anims: anim === undefined ? [] : [anim],
                  restores,
                });
              }
            }
          }, () => {
            // Superseded before the beat began, so no record owns these
            // fades: the frame was never handed to `settleTweensRef`, and
            // the pending map has either let it go (a workspace switch swept
            // it, hold handed back) or carried it into the settle that
            // superseded this one, which launches a fade of its own. Left to
            // run, the fade lands anyway, and TugAnimator commits its end
            // value — an inline `opacity: 1` nothing will ever take off, or
            // written over the replacement's hold. Cancelled raw, so nothing
            // is committed. The frames' fades only: the rail strips' slides
            // are on their own `settleTweensRef` entries, which the
            // superseding arm has already answered for.
            if (kind !== "arrive") return;
            for (const anim of fades.slice(0, arrivals.length)) {
              anim.raw.cancel();
            }
          });
          // The settle's completion waits on the beat; the beat has landed
          // itself by the time this resolves.
          return Promise.allSettled(fades.map((anim) => anim.finished)).then(
            () => undefined,
          );
        }
        if (launches.length === 0) return Promise.resolve();
        const curve = beatCurve(kind);
        const launchedBeats: Array<[Choreographed, SettleBeat]> = [];
        for (const c of launches) {
          const beat = c.beats[c.next];
          c.next += 1;
          launchedBeats.push([c, beat]);
        }
        // The hold this beat replaced comes off when the beat LANDS, not at
        // the settle's completion. TugAnimator commits an effect's value at
        // its end, and under `fill: backwards` — as under `fill: none`, which
        // is the point — that value is the underlying inline style, the
        // opening pose, so a frame left wearing it would snap back to its hold
        // for the length of the next beat. A backwards fill applies only
        // BEFORE the active phase and nothing after it, so the commit reads
        // the same underlying value either way and none of the reasoning below
        // has to be re-derived for the fill mode.
        //
        // How it comes off differs by property, and that is the whole of the
        // care here. A TRANSFORM is the imposer's own and nothing underlies
        // it, so it is removed. An AXIS is not: React renders the frame's
        // committed size into the same inline property the hold was written
        // over, so removing it takes React's number away too and drops the
        // frame to whatever its content makes of it — for a folded card, its
        // OPEN floor, held there for every beat between its own and the
        // settle's completion. So an axis is HANDED BACK (`handBack`) rather
        // than removed: the beat ended at the committed size, which is
        // exactly the value React rendered, so the write leaves the frame
        // where the beat put it and the frame keeps a height for the rest of
        // the settle.
        //
        // Run once, by the beat's landing, which has two callers: the
        // completion, a promise hop after the tweens end, and `arm`, which
        // lands the beat itself when a commit finds the tweens already over —
        // the record on `settleBeatRef` says why that door exists.
        const landFrames = (): void => {
          for (const [c, beat] of launchedBeats) {
            if (taken(c.frame)) continue;
            // Stated as a rule over what the beat ANIMATED rather than as a
            // list of kinds: a beat ends at the value it animated to, which
            // is identity for a transform and the committed size for an
            // axis, so every property this beat carried can be settled here
            // and leave the frame exactly where the beat put it. The fused
            // `room` beat carries all three at once, which a per-kind list
            // could only have covered by naming it in both branches.
            if (
              beat.terms.dx !== 0 ||
              beat.terms.dy !== 0 ||
              (beat.terms.sx ?? 1) !== 1
            ) {
              c.frame.style.removeProperty("transform");
            }
            if (beat.terms.width !== undefined) {
              c.handBack.width?.();
            }
            if (beat.terms.height !== undefined) {
              c.handBack.height?.();
            }
          }
        };
        // An axis a beat resizes is the transform/opacity rule's standing
        // breach, and the beat says so by name: the shrink and the grow, and
        // the fused `room` beat that carries both.
        const declares = (["height", "width"] as const).filter((axis) =>
          launchedBeats.some(([, beat]) => beat.terms[axis] !== undefined),
        );
        const { beat, land } = planSettleBeat(
          {
            recipe: kind,
            // Each frame's start pose is what this beat holds still — the
            // constant transform a resize beat wears while the move has not
            // yet run, the First size of an axis whose grow is still to come.
            targets: launchedBeats.map(([c, settleBeat]) => ({
              el: c.frame,
              keyframes: springSettleKeyframes(settleBeat.terms, curve.progress),
              pose: heldPose(settleBeat.held),
            })),
            durationMs: curve.durationMs,
            delayMs,
            fill: beatFill,
            composite: settleOpts.composite,
            slotCancelMode: settleOpts.slotCancelMode,
            // A keyword easing, because the curve rides in the keyframe
            // offsets — `lib/pane-flip.ts` says why a sampled `linear()`
            // cannot be used here.
            easing: "linear",
            // One slot PER BEAT, and the reason is the whole of this
            // change: a named slot cancels whatever is already in it with
            // `snap-to-end`, so a single `imposer-flip` key meant the move
            // beat's creation finished the shrink beat outright. Under the
            // old chain that was invisible — the shrink was already over
            // when the move was created — and it is exactly what made the
            // chain load-bearing. With every beat created in one frame the
            // shared key snapped each beat to its end as the next was made,
            // and `at0566` read it as a shrink that travelled nothing at
            // all. The beats of one settle are a sequence, not rivals for
            // one slot, and a retarget still cancels them through
            // `settleTweensRef`, which holds every one of them.
            key: `imposer-flip-${kind}`,
            declares,
          },
          landFrames,
        );
        for (const [i, [c]] of launchedBeats.entries()) {
          const anim = beat.anims[i];
          if (anim !== undefined) c.anims.push(anim);
        }
        // The beat the settle is on, for the arm that may interrupt it: it
        // reads the velocity off this recipe at the time since this launch,
        // and lands the beat itself if the launch is already over.
        whenBeatBegins(delayMs, () => {
          el.setAttribute("data-imposer-beat", kind);
          settleBeatRef.current = {
            kind,
            launchedAt: performance.now(),
            initialVelocity: beatLaunchVelocity(kind, launch),
            anims: beat.anims,
            land,
          };
        });
        // `allSettled` because `finished` rejects under hold-at-current — the
        // retarget's cancel — and the generation check in the landing is
        // what tells that apart from a beat that landed. TugAnimator resolves
        // `finished` after committing, so a landing always runs on the far
        // side of the residue it takes back.
        return Promise.allSettled(beat.anims.map((anim) => anim.finished)).then(
          () => undefined,
        );
      };
      // One launch point, one generation check — the plan's move of the
      // per-beat guard. A retarget that lands after this frame is the cancel
      // paths' to take back: `arm` cancels every animation registered on the
      // frames and re-plans them, which is exactly what it already did for a
      // beat that was in flight, and now does for beats that are merely
      // delayed.
      let beatDelayMs = prepareMs;
      const beatRuns: Array<Promise<void>> = [];
      if (settleGenerationRef.current === generation) {
        for (const kind of BEAT_ORDER) {
          beatRuns.push(runBeat(kind, beatDelayMs));
          if (launched.includes(kind)) {
            beatDelayMs += motionDurationMs(BEAT_RECIPE[kind], duration);
          }
        }
      }
      void Promise.all(beatRuns)
        .then(() => {
          for (const marker of beatMarkers) marker.cancel();
          if (settleGenerationRef.current !== generation) return;
          // The settle's one completion, after the final beat's last tween,
          // in this order ([B04]): every frame's inline residue handed back
          // and its transform taken off; then every frame's fold crossing
          // ended — guarded by id, so an interrupted settle does not close
          // the one that replaced it — so the card can land what CSS cannot
          // write ([B05]); then every frame's resize episode ended, after the
          // restorers so the final anchor is read against the geometry the
          // frame actually keeps; and then, through `settled`, the stores'
          // hold released, so the one publish and the one pin land on
          // settled geometry.
          for (const c of choreography) {
            if (taken(c.frame)) continue;
            for (const restore of c.restores) restore();
            clearFlip(c.paneId, c.frame, c.anims);
          }
          // The arrivals take the same three, in the same order, because the
          // arrive beat replaced the effect that used to do this in its own
          // completion handler. An arriving frame has no fold crossing — it was
          // not on screen to open one — so it joins at the restore and the
          // episode, not in the crossing loop between them.
          for (const { paneId, frame, restores } of arrivals) {
            if (taken(frame)) continue;
            for (const restore of restores) restore();
            clearFlip(paneId, frame, settleTweensRef.current.get(paneId)?.anims ?? []);
          }
          for (const { key, strip, restores } of arrivingStrips) {
            for (const restore of restores) restore();
            clearFlip(key, strip, settleTweensRef.current.get(key)?.anims ?? []);
          }
          // The covered members' holds and marks come off here and nowhere
          // earlier: the survivor has covered a retiring member, or retreated
          // off a revealed one, only when the chain is done ([B03]).
          for (const c of covered) {
            if (taken(c.frame)) continue;
            for (const restore of c.restores) restore();
            clearFlip(c.paneId, c.frame, c.anims);
          }
          for (const c of choreography) {
            if (taken(c.frame)) continue;
            if (c.crossingId !== null) endFoldCrossing(c.frame, c.crossingId);
            if (c.stillCrossingId === null) continue;
            // A settled crossing's mark comes off here, in the land's own
            // task, like every other: its interior already stands where it
            // lands, and the held height lives on the card root alone, under
            // a property that does not inherit (`lib/fold-crossing.ts`), so
            // taking it off restyles one element rather than the card. The
            // `overflow` and `position` the mark flips back cost about a
            // millisecond between them at the same size.
            endStillCrossing(c.frame, c.stillCrossingId);
          }
          for (const c of choreography) {
            if (!c.reflowsAtLand) {
              endEpisode(c.paneId);
              continue;
            }
            // A width shrink re-flows its interior only now, as its hold
            // comes off, and a scroller's anchor (CodeMirror's line, the
            // generic element anchor) can only land a re-flow its episode
            // is still open for. The re-wrap is laid out in the next frame,
            // CodeMirror measures it in the frame after, and its observers
            // may be held until the gate opens — so the episode ends two
            // frames past the gate's release. Its own handle, never its pane
            // id: a settle armed in between owns the pane's next episode.
            const handle = settleEpisodesRef.current.get(c.paneId);
            if (handle === undefined) continue;
            settleEpisodesRef.current.delete(c.paneId);
            afterGesture(() =>
              requestAnimationFrame(() => requestAnimationFrame(() => handle.end())),
            );
          }
          for (const { paneId } of arrivals) endEpisode(paneId);
          for (const { paneId } of covered) endEpisode(paneId);
          settleBeatRef.current = null;
          settled();
        });
    } else {
      // No chain to ride, so nothing is coming to release these: the survivor
      // never moved, and a hold with no release would be a frame left standing
      // at a tile the deck no longer has.
      for (const c of covered) {
        for (const restore of c.restores) restore();
        clearFlip(c.paneId, c.frame, c.anims);
        endEpisode(c.paneId);
      }
    }
    // Nothing this pass launched is left to finish — a settle whose every
    // frame was gesture-owned, or moved nowhere — so the hold comes off now
    // rather than at the sweep.
    if (outstanding === 0) finish();
    firstRects.clear();
    firstFolds.clear();
    firstRailSides.clear();
    firstRailShadows.clear();
    holdPlan.survivors.clear();
    holdPlan.covered.clear();
    holdPlan.held.clear();
  }, [arrangement]);

  return { pendingArrivalsRef, settleCommitSeqRef };
}
