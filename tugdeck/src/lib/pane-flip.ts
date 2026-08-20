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
 * measured and written up in `roadmap/jul30-perf-brief.md#i1-sparkline-exception`.
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
 * The keyframes that carry one frame through the whole settle: back from
 * `(dx, dy)` at scale `sx` to where it committed, and across whatever real
 * `width` and `height` it is crossing, **all in a single keyframe list**.
 *
 * The offsets are evenly spaced and the values follow a critically damped
 * spring, so the frame accelerates away, decelerates onto its place, and stops
 * there without running past it. Both endpoints of every term are pinned rather
 * than sampled: a curve a hair off at its ends leaves a frame a hair off its
 * place, and a final keyframe that is exactly `translate(0px, 0px)` at exactly
 * the committed size is what makes cancelling the tween safe at any moment —
 * there is no wrong pose to snap to.
 *
 * ## Why one list and not two
 *
 * A frame that both moves and resizes has its terms in **one effect** because
 * an edge that must stay put is pinned by the *sum* of them. A member growing
 * into a rail's full run from the bottom tile translates up by exactly the
 * height it gains: its top edge travels, its bottom edge does not move at all —
 * but only while the translate and the height advance on the same clock. Split
 * across two effects, the transform is accelerated and the height is not, so
 * the compositor can run one ahead of the other and the edge that was supposed
 * to be nailed down slides. That is a card moving when it does not have to,
 * which is the one thing this settle exists to avoid ([D135]).
 *
 * The cost is real and is paid deliberately: a single non-transform property
 * revokes the whole effect's compositor acceleration (the module header says
 * what that is worth). But a frame carrying a real size term is re-laying out
 * its subtree every frame *regardless* — the main-thread work is already being
 * done — so the acceleration was never actually on the table for these frames.
 * All the split bought was two clocks. A frame that only moves still gets a
 * transform-only list and stays accelerated, which is every everyday gesture.
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

/** Three decimals is finer than a device pixel, and the rest is only length. */
function formatPx(value: number): string {
  return String(Number(value.toFixed(3)));
}

/** A scale multiplies a width, so it is carried finer than the length it makes:
 *  five decimals is under a thousandth of a pixel across the widest pane. */
function formatScale(value: number): string {
  return String(Number(value.toFixed(5)));
}
