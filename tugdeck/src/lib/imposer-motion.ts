/**
 * imposer-motion.ts — what an imposer animation IS.
 *
 * Every way a card moves under the layout imposer is one of a small, named
 * set of operations, and each one has a stated physics. This module is that
 * statement. Before it, each call site picked a duration and an easing on its
 * own, and "smooth" was whatever the last edit happened to leave behind.
 *
 * ## The recipes
 *
 * | Recipe        | Operation class                                          | ζ   | Nominal |
 * |---------------|----------------------------------------------------------|-----|---------|
 * | `crossing`    | a settled arrangement change — frames travel and resize   | 1.0 | 1.0×    |
 * | `shrink`      | the settle's first beat — frames that get smaller do, in place | 1.0 | 0.6× |
 * | `grow`        | the settle's last beat — frames that get larger do, in place   | 1.0 | 0.6× |
 * | `landing`     | a dropped card entering its zone; a refusal's return home  | 0.9 | 0.85×   |
 * | `reveal`      | a strip sliding to show an activated member                | 1.0 | 1.0×    |
 * | `divide-join` | a member arriving in / leaving a divided place (a fade)    | —   | 0.6×    |
 *
 * ζ is the damping ratio: 1.0 is critically damped and does not overshoot;
 * below 1.0 the spring passes its target once, proportionally. Only the
 * `landing` is underdamped, and deliberately — a card released into a place
 * should arrive with a little weight, and nothing else here is a thing the
 * hand just let go of. `divide-join` carries no ζ because a fade has no
 * position to overshoot; it is a plain ease, and it appears here so that the
 * one place stating the imposer's motion states all of it.
 *
 * `shrink` and `grow` are the crossing's two resize beats. A settle that
 * carries a size term runs as up to three beats in a fixed order — shrink,
 * move, grow — so that at any instant exactly one kind of thing is moving
 * (`lib/pane-flip.ts`'s {@link planSettleBeats} does the partitioning); the
 * move beat is the `crossing` itself. A resize beat is shorter than the move
 * because it is the make-room or close-up gesture around the travel rather
 * than the travel, and a full three-beat crossing at these multiples is 2.2×
 * the nominal. Both are starting values, to be tuned by eye.
 *
 * Timing is relative. Every nominal is a multiple of the crossing's, which is
 * the deck's one tunable — `--tugx-imposer-settle-duration`, read back through
 * `readSettleMs` — so a hand on that knob retimes the whole choreography in
 * proportion rather than pulling it apart.
 *
 * ## The form the curve is delivered in, and why it is not negotiable
 *
 * {@link motionKeyframes} returns normalized progress SAMPLES, not an easing
 * string, and the call site maps them onto its own properties. That is a hard
 * constraint inherited from `lib/pane-flip.ts`: WebKit accelerates a transform
 * animation only when the effect is completely accelerable, and a sampled
 * `linear(…)` easing disqualifies it — the pulsing dot measured 18.0% of a core
 * with one and 0.9% without. So the physics rides in the keyframe values under
 * a plain `linear` KEYWORD easing. Do not "simplify" a recipe into an easing
 * string.
 *
 * Samples are evenly spaced in time, so a caller lays them out at
 * `offset: i / (frames.length - 1)` and the curve is traced by the values.
 *
 * ## Interruption
 *
 * A motion interrupted mid-flight does not stop and restart: the caller reads
 * its progress and velocity at the interruption ({@link progressAt},
 * {@link velocityAt}) and launches the replacement with that velocity, so the
 * card keeps going the way it was already going. `initialVelocity` is in
 * normalized units per second — 1.0 means "covering the whole remaining travel
 * every second" — which is what makes it portable across travels of any length.
 *
 * @module lib/imposer-motion
 */

import { SpringSolver } from "@/components/tugways/physics";

/** The named operation classes. */
export type MotionRecipe =
  | "crossing"
  | "shrink"
  | "grow"
  | "landing"
  | "reveal"
  | "divide-join";

interface RecipeSpec {
  /** Damping ratio. `null` for the fade, which has no spring. */
  zeta: number | null;
  /** This recipe's window as a multiple of the crossing's nominal. */
  timeScale: number;
}

const RECIPES: Record<MotionRecipe, RecipeSpec> = {
  crossing: { zeta: 1.0, timeScale: 1.0 },
  shrink: { zeta: 1.0, timeScale: 0.6 },
  grow: { zeta: 1.0, timeScale: 0.6 },
  landing: { zeta: 0.9, timeScale: 0.85 },
  reveal: { zeta: 1.0, timeScale: 1.0 },
  "divide-join": { zeta: null, timeScale: 0.6 },
};

/**
 * The largest initial velocity a recipe will launch with, in normalized units
 * per second.
 *
 * A flick is a real input and the landing should honor it, but a hand can move
 * a card across the deck in a tenth of a second, and a spring seeded with that
 * would fling the frame well past its zone before coming back. Three whole
 * travels per second is fast enough to read as thrown and slow enough that the
 * overshoot stays inside the deck.
 */
export const MAX_INITIAL_VELOCITY = 3.0;

/**
 * The frequency every recipe's spring is integrated at.
 *
 * This is a SHAPE parameter, not a speed. The spring is solved in its own
 * time, sampled over however long it actually takes to settle, and those
 * samples are then played back over the recipe's window — so the window
 * stretches the curve rather than stiffening the spring.
 *
 * Doing it the other way round does not work, and the failure is worth
 * recording. `SpringSolver` integrates forward Euler at a fixed 60Hz step, so
 * its accuracy is governed by ωΔt. Choosing ω to make the spring physically
 * settle inside a 360ms window needs ω ≈ 20, where ωΔt ≈ 0.33 and the
 * integration is no longer tracking a spring: the first sampled frame covered
 * 47% of the travel and the rest crawled, ζ stopped producing any overshoot at
 * all, and an initial velocity barely moved the curve. At ω = 6, ωΔt = 0.1 and
 * all three behave.
 *
 * Sampling over the settle also fixes the sample count: about 66 frames for a
 * critically damped curve, which is plenty of resolution for a keyframe list
 * whatever window it ends up played over.
 */
const SHAPE_OMEGA = 6;

/**
 * How long this damping ratio's spring takes to settle in its own time, from
 * rest — the span the shape is sampled over before being replayed at the
 * recipe's window.
 *
 * Measured with {@link SpringSolver.settleTimeMs} rather than assumed, and
 * cached: there are two ζ values in the whole table and the answer for each
 * never changes.
 */
function shapeWindowMs(zeta: number): number {
  const cached = SHAPE_WINDOW_CACHE.get(zeta);
  if (cached !== undefined) return cached;
  const measured =
    new SpringSolver({
      mass: 1,
      stiffness: SHAPE_OMEGA * SHAPE_OMEGA,
      damping: 2 * zeta * SHAPE_OMEGA,
    }).settleTimeMs() ?? 2000;
  SHAPE_WINDOW_CACHE.set(zeta, measured);
  return measured;
}

const SHAPE_WINDOW_CACHE = new Map<number, number>();

export interface MotionKeyframesOptions {
  /**
   * The crossing's window in milliseconds — the resolved
   * `--tugx-imposer-settle-duration`, via `readSettleMs`. Every recipe's own
   * window is a multiple of this.
   */
  nominalMs: number;
  /**
   * Normalized velocity at launch, in units of the travel per second. Clamped
   * to {@link MAX_INITIAL_VELOCITY}. Defaults to 0 — a motion that starts from
   * rest, which is every motion nobody's hand was on.
   */
  initialVelocity?: number;
}

export interface MotionCurve {
  /**
   * Normalized progress, evenly spaced in time, first value 0 and last exactly
   * 1. Values may exceed 1 in between when the recipe overshoots.
   */
  progress: readonly number[];
  /** How long to play them over, in raw milliseconds (TugAnimator scales). */
  durationMs: number;
}

/**
 * Build one recipe's curve.
 *
 * The returned progress runs 0 → 1; the call site owns the mapping onto its
 * properties, which is what lets one curve carry a translate, a width and a
 * height on one clock ([D135]) instead of three effects drifting apart.
 */
export function motionKeyframes(
  recipe: MotionRecipe,
  opts: MotionKeyframesOptions,
): MotionCurve {
  const spec = RECIPES[recipe];
  const durationMs = Math.max(1, opts.nominalMs * spec.timeScale);
  if (spec.zeta === null) {
    // A fade. Two stops and a keyword easing at the call site — sampling a
    // straight line would be all cost and no shape.
    return { progress: [0, 1], durationMs };
  }
  const solver = solverFor(spec.zeta, durationMs, opts.initialVelocity ?? 0);
  // Sampled over the spring's OWN settle, then played over the recipe's
  // window: the shape is the physics, the window is the tempo.
  const progress = solver.keyframes(shapeWindowMs(spec.zeta));
  // `keyframes` clamps its last value to exactly 1 but can return a single
  // sample for a very short window; a curve needs two ends.
  if (progress.length < 2) return { progress: [0, 1], durationMs };
  return { progress, durationMs };
}

/**
 * The solver a recipe runs on, for callers that need more than the curve —
 * the settle's retarget reads {@link progressAt} and {@link velocityAt} off
 * the spring a running tween was launched with.
 */
export function motionSolver(
  recipe: MotionRecipe,
  opts: MotionKeyframesOptions,
): SpringSolver | null {
  const spec = RECIPES[recipe];
  if (spec.zeta === null) return null;
  const durationMs = Math.max(1, opts.nominalMs * spec.timeScale);
  return solverFor(spec.zeta, durationMs, opts.initialVelocity ?? 0);
}

/** How long a recipe plays for, without building its curve. */
export function motionDurationMs(
  recipe: MotionRecipe,
  nominalMs: number,
): number {
  return Math.max(1, nominalMs * RECIPES[recipe].timeScale);
}

function solverFor(
  zeta: number,
  durationMs: number,
  initialVelocity: number,
): SpringSolver {
  const clamped = Math.max(
    -MAX_INITIAL_VELOCITY,
    Math.min(MAX_INITIAL_VELOCITY, initialVelocity),
  );
  // The caller's velocity is travels per REAL second; the spring runs in its
  // own, slower time. One real second is `shapeWindow / duration` spring
  // seconds, so the velocity converts by the same factor — without it a flick
  // would read as a crawl and the inheritance would be decorative.
  const toSpringTime = shapeWindowMs(zeta) / durationMs;
  return new SpringSolver({
    mass: 1,
    stiffness: SHAPE_OMEGA * SHAPE_OMEGA,
    damping: 2 * zeta * SHAPE_OMEGA,
    initialVelocity: clamped * toSpringTime,
  });
}

/**
 * The normalized progress a curve had reached `elapsedMs` into its playback.
 *
 * Read at an interruption so the replacement motion starts from where the eye
 * is rather than from where the old motion was aiming.
 */
export function progressAt(curve: MotionCurve, elapsedMs: number): number {
  const n = curve.progress.length;
  if (n === 0) return 1;
  if (elapsedMs <= 0) return curve.progress[0];
  if (elapsedMs >= curve.durationMs) return curve.progress[n - 1];
  // Samples are evenly spaced across the window, so the index is a plain
  // proportion; interpolate between the two it falls between.
  const t = (elapsedMs / curve.durationMs) * (n - 1);
  const i = Math.floor(t);
  const frac = t - i;
  return curve.progress[i] + (curve.progress[i + 1] - curve.progress[i]) * frac;
}

/**
 * The normalized velocity a recipe's spring has `elapsedMs` in, in units of
 * the travel per second — what to hand the replacement motion so the card
 * keeps its momentum through the retarget.
 *
 * Zero for a fade, which has no velocity to inherit.
 */
export function velocityAt(
  recipe: MotionRecipe,
  opts: MotionKeyframesOptions,
  elapsedMs: number,
): number {
  const spec = RECIPES[recipe];
  if (spec.zeta === null) return 0;
  const solver = motionSolver(recipe, opts);
  if (solver === null) return 0;
  // Callers count in playback milliseconds and want travels per real second;
  // the spring counts in its own, slower time. Convert going in and coming
  // back out, so the ratio never leaks past this module's edge.
  const durationMs = motionDurationMs(recipe, opts.nominalMs);
  const toSpringTime = shapeWindowMs(spec.zeta) / durationMs;
  return solver.velocityAt(elapsedMs * toSpringTime) / toSpringTime;
}

/**
 * Project a pointer's release velocity onto a travel and normalize it.
 *
 * The landing inherits the hand ([P05] of the imposer-polish plan): a card let
 * go while still moving toward its zone arrives carrying that motion, and one
 * let go moving away arrives having been slowed by it. The projection is what
 * makes those different — only the component along the travel is momentum
 * toward the destination — and dividing by the travel's own length is what
 * makes the number portable between a two-pixel nudge and a cross-deck throw.
 *
 * `pointerPxPerS` is the release velocity in CSS px/s; `travel` is the vector
 * the frame is about to cover. A zero-length travel inherits nothing, there
 * being no direction to inherit along.
 */
export function velocityAlongTravel(
  pointerPxPerS: { x: number; y: number },
  travel: { x: number; y: number },
): number {
  const distance = Math.hypot(travel.x, travel.y);
  if (distance < 1) return 0;
  const along =
    (pointerPxPerS.x * travel.x + pointerPxPerS.y * travel.y) / distance;
  return Math.max(
    -MAX_INITIAL_VELOCITY,
    Math.min(MAX_INITIAL_VELOCITY, along / distance),
  );
}
