/**
 * pane-flip.ts — the math behind the imposer's settle motion.
 *
 * When the deck's arrangement changes, the frames' final geometry is committed
 * in one layout pass and the crossing is a transform tween that starts at the
 * inverse of the move and ends at nothing (FLIP). This module is the pure half
 * of that: the delta between where a frame was and where it now is, the
 * keyframes that walk one back to the other, and the keyframes for the motion
 * a transform is not allowed to fake. `deck-canvas.tsx` does the measuring and
 * the animating.
 *
 * ## The form these keyframes are written in, and why it is not negotiable
 *
 * WebKit runs a transform animation on the compositor — costing one whole-page
 * compositing walk when it starts and one when it ends, and nothing at all in
 * between — only when the effect is *completely* accelerated. An effect that
 * misses that bar is resolved on the main thread instead, and every frame of it
 * commits a style change that walks the page again. The difference is the whole
 * reason this module exists rather than a `transition` in a stylesheet; it is
 * measured and written up in `arc/jul30-perf-brief.md#i1-sparkline-exception`.
 *
 * Clearing the bar means: keyframes touching **only** transform-family
 * properties, transforms that are strictly 2D, a **keyword** easing, playback
 * rate 1, forward, finite. Every one of those is a rule about
 * {@link springSettleKeyframes}.
 *
 * The sharpest of them is the easing. A `linear(…)` with a list of stops — the
 * form {@link cssEasing} produces — cannot be expressed by Core Animation, so
 * WebKit declines to accelerate anything wearing one. The pulsing dot fought
 * this and left its receipt in `tug-progress-pulsing-dot.css`: the same loop
 * measured 18.0% of a core with a sampled `linear()` easing and 0.9% without.
 * So the spring here rides in the **keyframe offsets** instead — many frames
 * under a plain `linear` keyword trace the identical curve, and that shape a
 * compositor can run. Do not "simplify" this into an easing string.
 *
 * ## What a transform tween is allowed to carry, and what it is not
 *
 * The acceleration above has a price: the compositor rasterizes the frame once
 * and animates the *texture*. A translation of a raster is pixel-identical to
 * moving the element, so a frame that only moves is tweened honestly at any
 * distance. A **scale** is not — it resamples the raster, so every border,
 * corner radius, and glyph inside the frame is stretched rather than re-laid
 * out, and nothing inside the frame is correct at any intermediate size.
 *
 * The deck's policy is therefore a cap ([D135]): a scale term may ride in the
 * settle only while its distortion — {@link scaleDistortion}, symmetric in
 * grow and shrink — stays within {@link MAX_FLIP_SCALE_DISTORTION}. Under the
 * cap the smear reads as motion; over it, as deformation. A frame whose size
 * changes by more than the cap crosses by **real geometry** instead:
 * {@link springSettleKeyframes} walks the actual `width` or `height`, the
 * frame's subtree lays out truthfully on every frame of the motion, and the
 * cost — main-thread layout for that frame, for the length of the settle — is
 * the same one the seam drag's live path already pays. Height is never
 * smeared at all: the gestures that change a frame's height (splitting a
 * rail, stacking one, membership churn under a split) halve or double it,
 * which no cap admits.
 *
 * A frame that carries a real size term therefore forfeits acceleration, and
 * because of that its move rides in the **same keyframe list** rather than a
 * second effect — {@link springSettleKeyframes} says why an edge that must stay
 * put can only be pinned by terms sharing one clock.
 *
 * @module lib/pane-flip
 */

/** Where a frame moved to, from where it was, and how much narrower it was. */
export interface FlipDelta {
  /** Horizontal distance in CSS pixels, positive rightward. */
  dx: number;
  /** Vertical distance in CSS pixels, positive downward. */
  dy: number;
  /** The old width over the new one: the horizontal scale the frame starts at. */
  sx: number;
}

/**
 * The curve every settle keyframe list is cut against, when a caller does not
 * supply one.
 *
 * There is no longer a spring in this module: the imposer's motion is stated
 * once in `lib/imposer-motion.ts` and passed in. This constant survives only as
 * the resolution floor a hand-built curve is expected to clear — below about 32
 * stops the chords between samples start to read.
 */
export const SPRING_KEYFRAME_SAMPLES = 32;

/**
 * The most a settle tween may deform a frame's raster: a scale term whose
 * {@link scaleDistortion} exceeds this rides as a real `width` term via
 * {@link springSettleKeyframes} instead. 0.2 admits the adjacent width-preset
 * step (675↔800, 18.5%) and nothing else; both Wide jumps and a rail split
 * are over it.
 */
export const MAX_FLIP_SCALE_DISTORTION = 0.2;

/**
 * How far a scale is from the identity, symmetric in grow and shrink: a
 * halving and a doubling both read 1.0. Zero or negative input — a frame
 * measured mid-teardown — reads as no distortion at all.
 */
export function scaleDistortion(s: number): number {
  if (s <= 0) return 0;
  return Math.max(s, 1 / s) - 1;
}

/**
 * The distance from a frame's old position to its new one, and the ratio of its
 * old width to its new one.
 *
 * Width is carried as a **scale** rather than a length because that is what
 * keeps the tween inside the transform-only form: `scaleX` is transform-family,
 * a `width` keyframe is not, and a single non-accelerable property in the effect
 * puts the whole thing back on the main thread — where it would re-run layout
 * for the frame's entire subtree on every frame of the motion. Whether the
 * scale may actually ride is the caller's cap check ([D135]); this function
 * only reports it.
 *
 * Height is not carried. A height change is never smeared — the module header
 * says why — so the settle reads the two rects' heights directly and hands them to
 * {@link springSettleKeyframes} as a real term when they differ.
 *
 * A zero or absent final width reads as no scale at all, so a frame measured
 * mid-teardown yields a plain move rather than a division by zero.
 */
export function flipDelta(
  first: DOMRectReadOnly,
  last: DOMRectReadOnly,
): FlipDelta {
  return {
    dx: first.left - last.left,
    dy: first.top - last.top,
    sx: last.width > 0 ? first.width / last.width : 1,
  };
}

/** One frame's whole settle: where it starts relative to where it committed,
 *  and the sizes it crosses by real geometry. Every term is optional except the
 *  move, and every term omitted is a term the frame genuinely does not need. */
export interface SettleTerms {
  /** Horizontal inverse offset in CSS pixels. */
  dx: number;
  /** Vertical inverse offset in CSS pixels. */
  dy: number;
  /** A width ratio ridden as a raster smear. 1 — the default — when the width
   *  does not change, or crosses by real geometry instead. */
  sx?: number;
  /** Real `width`, from → to, when the scale is over the cap. */
  width?: readonly [number, number];
  /** Real `height`, from → to. Height never smears, so any change lands here. */
  height?: readonly [number, number];
}

/**
 * The keyframes that carry one frame through one beat of a settle: back from
 * `(dx, dy)` at scale `sx` to where it committed, or across a real `width`
 * or `height` it is crossing — whichever terms the beat carries, **in a
 * single keyframe list**.
 *
 * The offsets are evenly spaced and the values follow a critically damped
 * spring, so the frame accelerates away, decelerates onto its place, and stops
 * there without running past it. Both endpoints of every term are pinned rather
 * than sampled: a curve a hair off at its ends leaves a frame a hair off its
 * place, and a final keyframe that is exactly `translate(0px, 0px)` at exactly
 * the committed size is what makes cancelling the tween safe at any moment —
 * there is no wrong pose to snap to.
 *
 * ## Why one list, and why one kind of term in it
 *
 * This builder accepts every term at once and cuts one list from them, and
 * the caller never hands it a translate and a size together. A settle that
 * carries a size runs as beats — shrink, then move, then grow, planned by
 * {@link planSettleBeats} — and each beat is one effect carrying one kind of
 * term, so at any instant exactly one kind of thing is moving ([D135] as
 * amended by `three-beat-settle`).
 *
 * The earlier argument for one list was a seam: an edge pinned by the *sum*
 * of a translate and a size — a member growing up into a rail's full run,
 * whose bottom edge stays put only while both terms advance on one clock. That
 * argument constrains a frame carrying both terms at once, and only that. A
 * frame that shrinks in one beat and translates in the next has no sum to
 * keep honest, so the seam concern is met by the sequencing rather than by a
 * shared clock; the air that opens between members during the shrink is the
 * make-room beat being legible, not a seam failing, and the beats are not to
 * be collapsed back into one effect to close it.
 *
 * What the one list protects, per beat: a move beat is transform-only and
 * stays on the compositor, which is every everyday gesture; a resize beat
 * carries a real `width` or `height`, re-lays out its subtree every frame
 * regardless, and is main-thread by construction — the module header says
 * what a non-transform property costs an effect. Both axes are floored at
 * half a pixel by the caller, so a measurement a hair different is not a size
 * change, and height never smears: any height delta is a real term.
 *
 * When there IS a scale, the caller must have anchored the frame's
 * `transform-origin` at its top-left: `dx`/`dy` are measured between those
 * corners, and a scale about the centre would pull them off the measurement.
 */
export function springSettleKeyframes(
  terms: SettleTerms,
  curve: readonly number[],
): Keyframe[] {
  const { dx, dy, sx = 1, width, height } = terms;
  const steps = Math.max(2, curve.length - 1);
  const frames: Keyframe[] = [];
  for (let i = 0; i <= steps; i += 1) {
    const offset = i / steps;
    // The ends are pinned rather than taken from the curve: a sample a hair
    // off leaves the frame a hair off its place, and an exactly-zero final
    // transform is what makes cancelling safe at any moment.
    const progress = i === 0 ? 0 : i === steps ? 1 : (curve[i] ?? 1);
    const remaining = 1 - progress;
    const frame: Keyframe = { offset };
    if (dx !== 0 || dy !== 0 || sx !== 1) {
      const move = `translate(${formatPx(dx * remaining)}px, ${formatPx(dy * remaining)}px)`;
      frame.transform =
        sx === 1
          ? move
          : `${move} scaleX(${formatScale(1 + (sx - 1) * remaining)})`;
    }
    if (width !== undefined) {
      frame.width = `${formatPx(width[0] + (width[1] - width[0]) * progress)}px`;
    }
    if (height !== undefined) {
      frame.height = `${formatPx(height[0] + (height[1] - height[0]) * progress)}px`;
    }
    frames.push(frame);
  }
  return frames;
}

/** The beats a settle runs in, in the order it runs them. */
export type BeatKind = "depart" | "shrink" | "move" | "grow" | "arrive";

/**
 * The order the canvas chains them in — the one place the order lives, so a
 * chain folded over this array cannot disagree with the kinds above it.
 *
 * A frame's departure opens the settle and its arrival closes it: the room is
 * given up before anything moves into it, and nothing appears until every
 * frame that was already on screen has finished going where it is going.
 */
export const BEAT_ORDER: readonly BeatKind[] = [
  "depart",
  "shrink",
  "move",
  "grow",
  "arrive",
];

/**
 * What a beat keeps still while it runs — applied as constant inline style by
 * the caller, never as keyframes, so a move beat's effect stays transform-only
 * and accelerated.
 *
 * A resize beat holds the frame's transform: the constant translate (and
 * smear) that keeps it where the eye has it until the move beat carries it.
 * The shrink beat and the move beat hold any size whose change is still to
 * come — a growing axis is held at First until the grow beat — because the
 * frame's committed layout already has the Last size, and without the hold the
 * axis would jump to it the moment the settle launched.
 *
 * These are a beat's holds, for the beat's own length. The pose a frame wears
 * from the launch until its FIRST beat is the caller's to write, because in a
 * settle of many frames a beat is every frame's together: a frame whose own
 * first beat is the grow waits, at First, through its neighbours' shrink and
 * move, and no beat of its own is running to hold it there.
 */
export interface HeldTerms {
  /** The transform the frame wears for the whole beat. Absent in the move beat
   *  (it animates the transform) and when there is no move at all. */
  transform?: { dx: number; dy: number; sx: number };
  /** An inline `width`, in CSS pixels, held for the beat. */
  width?: number;
  /** An inline `height`, in CSS pixels, held for the beat. */
  height?: number;
}

/** One beat of a settle: what it animates and what it holds still. */
export interface SettleBeat {
  kind: BeatKind;
  /** The argument to {@link springSettleKeyframes} for this beat alone. */
  terms: SettleTerms;
  held: HeldTerms;
}

/**
 * Partition one frame's settle into the beats it runs as — shrink, then move,
 * then grow, skipping any the frame has nothing for — so that no beat carries
 * a size term and a translate together.
 *
 * The move beat carries `dx`, `dy` and the smear `sx`: everything that rides
 * the transform, which is what keeps it on the compositor. A real `width` or
 * `height` whose target is smaller goes to the shrink beat, one whose target
 * is larger to the grow beat. Each resize beat wears the constant transform
 * the move beat has not yet run (or has already finished), and every beat
 * before the grow holds a growing axis at its First size.
 *
 * A frame with no size term plans to exactly one move beat carrying its terms
 * unchanged, so the stack move — the settle the whole design is measured
 * against — produces the same transform-only list it always has. A frame with
 * only a size term plans to no move beat at all.
 *
 * The seam [D135] argued from — an edge pinned by the sum of a translate and a
 * size on one clock — does not arise here, because no beat ever carries the
 * sum. Air opening between members during the shrink is the make-room beat
 * being legible, not a seam failing.
 *
 * It emits only the MIDDLE three of {@link BEAT_ORDER}, and the outer two are
 * not an omission. This function partitions one frame's FLIP terms, and the
 * outer beats have no FLIP terms to partition: an arrival has no First rect to
 * invert and a departure has no Last one. They are the canvas's to author
 * because the canvas is the only thing that knows they happened — a frame that
 * was not on screen when the settle armed, and a pane `arm` measured whose
 * frame the commit took away.
 */
export function planSettleBeats(terms: SettleTerms): SettleBeat[] {
  const { dx, dy, sx = 1 } = terms;
  const width = sizeTerm(terms.width);
  const height = sizeTerm(terms.height);
  const moves = dx !== 0 || dy !== 0 || sx !== 1;
  const shrinks = width?.direction === "shrink" || height?.direction === "shrink";
  const grows = width?.direction === "grow" || height?.direction === "grow";

  // A frame carrying no size term at all is the everyday case, and its plan is
  // today's tween, untouched: one transform-only beat.
  if (!shrinks && !grows) {
    return moves ? [{ kind: "move", terms: { dx, dy, sx }, held: {} }] : [];
  }

  // The transform a resize beat wears while the move has not yet happened.
  // The grow beat runs after the move and wears none.
  const preMove: HeldTerms["transform"] = moves ? { dx, dy, sx } : undefined;
  // A growing axis is held at First by every beat before the grow.
  const growHolds: Pick<HeldTerms, "width" | "height"> = {};
  if (width?.direction === "grow") growHolds.width = width.pair[0];
  if (height?.direction === "grow") growHolds.height = height.pair[0];

  const beats: SettleBeat[] = [];
  if (shrinks) {
    beats.push({
      kind: "shrink",
      terms: {
        dx: 0,
        dy: 0,
        width: width?.direction === "shrink" ? width.pair : undefined,
        height: height?.direction === "shrink" ? height.pair : undefined,
      },
      held: { ...(preMove ? { transform: preMove } : {}), ...growHolds },
    });
  }
  if (moves) {
    beats.push({ kind: "move", terms: { dx, dy, sx }, held: { ...growHolds } });
  }
  if (grows) {
    beats.push({
      kind: "grow",
      terms: {
        dx: 0,
        dy: 0,
        width: width?.direction === "grow" ? width.pair : undefined,
        height: height?.direction === "grow" ? height.pair : undefined,
      },
      held: {},
    });
  }
  return beats;
}

/**
 * What a retarget interrupted: the beat that was running when a second
 * arrangement change landed, and the velocity its frames were carrying, in
 * travels per second — read off that beat's own recipe at that beat's own
 * elapsed time, never off the crossing regardless of which beat was up.
 */
export interface InterruptedBeat {
  kind: BeatKind;
  velocity: number;
}

/**
 * The velocity a beat of the replacement choreography launches with.
 *
 * A retarget hands the interrupted beat's velocity to the FIRST beat of the
 * same kind in the choreography that replaces it — a shrink's into the
 * shrink, a move's into the move, a grow's into the grow — and every other
 * beat launches from rest ([B06] of `three-beat-settle`). The kinds are
 * different motions in different units: a move's velocity is travels of a
 * translate per second and a shrink's is travels of a width, and handing one
 * to the other would throw a frame that was closing up across the deck at
 * the speed it was closing. A choreography runs each kind at most once, so
 * the first beat of a kind is the only one.
 *
 * A settle nothing interrupted has no interrupted beat, and every beat of it
 * launches from rest.
 *
 * The two outer beats are fades, and 0 is the right answer for them however a
 * retarget landed: `planSettleBeats` never emits either kind, so nothing can
 * ever be recorded as having interrupted one, and a fade has no position to
 * carry velocity into in any case.
 */
export function beatLaunchVelocity(
  kind: BeatKind,
  interrupted: InterruptedBeat | null,
): number {
  if (interrupted === null || interrupted.kind !== kind) return 0;
  return interrupted.velocity;
}

/** Which way a real size term goes, or nothing when it does not move: an equal
 *  pair is a term the caller should not have carried, and it is dropped
 *  rather than planned into a beat that would animate nothing. */
function sizeTerm(
  pair: readonly [number, number] | undefined,
): { pair: readonly [number, number]; direction: "shrink" | "grow" } | null {
  if (pair === undefined || pair[0] === pair[1]) return null;
  return { pair, direction: pair[1] < pair[0] ? "shrink" : "grow" };
}

/** Three decimals is finer than a device pixel, and the rest is only length. */
function formatPx(value: number): string {
  return String(Number(value.toFixed(3)));
}

/** A scale multiplies a width, so it is carried finer than the length it makes:
 *  five decimals is under a thousandth of a pixel across the widest pane. */
function formatScale(value: number): string {
  return String(Number(value.toFixed(5)));
}
