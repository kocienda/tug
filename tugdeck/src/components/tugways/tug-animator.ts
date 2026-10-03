/**
 * tug-animator.ts -- Programmatic animation engine for Tugways.
 *
 * Wraps the Web Animations API (WAAPI) with:
 *   - Named animation slots (WeakMap-based, GC-safe)
 *   - Three cancellation modes: snap-to-end, hold-at-current, reverse-from-current
 *   - Duration token resolution from tug.css base values, scaled by getTugTiming()
 *   - Reduced-motion awareness via isTugMotionEnabled()
 *   - Animation groups via group()
 *   - Beats via planBeat(): motion that moves a layer the deck arranges, with
 *     its start pose, its transform/opacity contract, one landing and its own
 *     record row (see the Beat section below)
 *   - Timeline marks via timelineMark(): a clock on the document timeline that
 *     animates nothing
 *
 * Singleton module export pattern matching scale-timing.ts convention.
 * Callers: import { animate, group } from './tug-animator'
 *
 * Cross-reference: DURATION_TOKEN_MAP values must stay in sync with
 * tug.css --tug-motion-duration-* definitions.
 *
 * Re-exports physics solvers for convenience.
 */

import { getTugTiming, isTugMotionEnabled } from "./scale-timing";
export { SpringSolver, GravitySolver, FrictionSolver } from "./physics";

// ---------------------------------------------------------------------------
// Duration token lookup map
// ---------------------------------------------------------------------------

/**
 * Maps --tug-motion-duration-* token names to their unscaled base ms values.
 * Mirrors tug.css. Must be updated if new duration tokens are added there.
 *
 * These are base (unscaled) values. getTugTiming() is applied at call time to
 * get the final scaled duration, so runtime timing changes propagate to new
 * animations without double-scaling.
 */
export const DURATION_TOKEN_MAP: Record<string, number> = {
  "--tug-motion-duration-instant": 0,
  "--tug-motion-duration-fast": 100,
  "--tug-motion-duration-moderate": 200,
  "--tug-motion-duration-slow": 350,
  "--tug-motion-duration-glacial": 500,
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type CancelMode = "snap-to-end" | "hold-at-current" | "reverse-from-current";

/** Options for animate(). */
export interface AnimateOptions {
  /** Duration token name (e.g. '--tug-motion-duration-moderate') or raw ms. Default: 200ms. */
  duration?: string | number;
  /** Raw CSS easing string. Passed directly to WAAPI. Default: 'ease'. */
  easing?: string;
  /** Named slot key. If provided, a previous animation with the same key on the same element is cancelled. */
  key?: string;
  /** How to cancel the previous animation when reusing a named slot. Default: 'snap-to-end'. */
  slotCancelMode?: "snap-to-end" | "hold-at-current";
  /** WAAPI composite operation. Default: 'replace'. */
  composite?: CompositeOperation;
  /** WAAPI fill mode. Default: 'forwards'. */
  fill?: FillMode;
  /**
   * Raw ms to wait before the active phase begins. Default: 0.
   *
   * Scaled by getTugTiming() exactly as {@link AnimateOptions.duration} is, so
   * a caller that sizes a delay from an unscaled duration gets a sequence that
   * stays in step at every timing scale.
   *
   * A delay is what lets a caller create a whole SEQUENCE of effects in one
   * frame rather than chaining each on the previous one's `finished`. That
   * chain costs a frame at every hand-off: the next effect is created in a
   * microtask after the previous one has already committed and cancelled, so
   * it is play-pending for the frame that follows and the element wears the
   * finished pose through it. A delayed effect's start time resolves during
   * its delay instead, so its first active frame paints its own keyframe 0
   * with nothing pending. What holds the element WHILE it waits is the
   * caller's business — a fill of `backwards`, or an inline pose the caller
   * wrote itself.
   */
  delay?: number;
}

/**
 * A handle to a running animation. Wraps a WAAPI Animation object with
 * a stable .finished promise and structured cancellation modes.
 */
export interface TugAnimation {
  /**
   * Resolves when the animation completes visually.
   * - Natural completion: resolves.
   * - snap-to-end cancel: resolves (finish() resolves the WAAPI promise).
   * - hold-at-current cancel: rejects (animation is cancelled mid-flight).
   * - reverse-from-current cancel: re-wired to resolve when the reversal completes.
   */
  finished: Promise<void>;
  /**
   * Cancel with the specified mode. Defaults to 'snap-to-end'.
   * opts.reverseEasing: CSS easing for the reverse animation (reverse-from-current only).
   */
  cancel(
    mode?: CancelMode,
    opts?: { reverseEasing?: string }
  ): void;
  /** The underlying WAAPI Animation object (escape hatch). */
  raw: Animation;
}

/**
 * A coordinated group of animations. All animations share default duration/easing
 * but can be individually overridden. group.finished resolves when ALL complete.
 */
export interface TugAnimationGroup {
  /** Add an animation to this group. Returns TugAnimation for individual control. */
  animate(
    el: Element,
    keyframes: Keyframe[] | PropertyIndexedKeyframes,
    options?: AnimateOptions
  ): TugAnimation;
  /** Resolves when ALL animations in the group complete (Promise.all semantics). */
  finished: Promise<void>;
  /** Cancel all animations in the group. */
  cancel(mode?: CancelMode): void;
}

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

/**
 * Tracks named animation slots per element.
 * WeakMap keys are held weakly -- GC'd elements don't leak slot maps.
 * Declared with `let` so _resetSlots() can replace it (WeakMap has no .clear()).
 */
let _slots: WeakMap<Element, Map<string, TugAnimation>> = new WeakMap();

/** Spatial CSS properties that trigger reduced-motion replacement. */
const SPATIAL_PROPERTIES = new Set([
  "transform",
  "translate",
  "translateX",
  "translateY",
  "scale",
  "scaleX",
  "scaleY",
  "rotate",
]);

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a duration option (token string or raw ms) to a scaled ms value.
 * Applies getTugTiming() exactly once.
 */
function resolveDuration(duration: string | number | undefined): number {
  const timing = getTugTiming();
  if (duration === undefined) {
    return 200 * timing; // default: moderate
  }
  if (typeof duration === "string") {
    if (!(duration in DURATION_TOKEN_MAP)) {
      throw new Error(
        `TugAnimator: unrecognized duration token "${duration}". ` +
          `Valid tokens: ${Object.keys(DURATION_TOKEN_MAP).join(", ")}`
      );
    }
    return DURATION_TOKEN_MAP[duration] * timing;
  }
  return duration * timing;
}

/**
 * Check whether a keyframes argument contains any spatial properties.
 * Handles both Keyframe[] and PropertyIndexedKeyframes formats.
 */
function hasSpatialProperties(
  keyframes: Keyframe[] | PropertyIndexedKeyframes
): boolean {
  if (Array.isArray(keyframes)) {
    return keyframes.some((kf) =>
      Object.keys(kf).some((k) => SPATIAL_PROPERTIES.has(k))
    );
  }
  return Object.keys(keyframes).some((k) => SPATIAL_PROPERTIES.has(k));
}

/**
 * Strip spatial properties from keyframes, preserving all non-spatial properties.
 * If opacity values are already present in the result, they are preserved.
 * If no opacity remains after stripping (i.e. the keyframes were purely spatial),
 * the result is replaced with a default fade-in: [{ opacity: 0 }, { opacity: 1 }].
 *
 * Always returns Keyframe[] (WAAPI accepts both formats for playback).
 */
function stripSpatialAndFade(
  keyframes: Keyframe[] | PropertyIndexedKeyframes
): Keyframe[] {
  let stripped: Keyframe[];

  if (Array.isArray(keyframes)) {
    // Keyframe[] format: remove spatial keys from each keyframe object.
    stripped = keyframes.map((kf) => {
      const out: Keyframe = {};
      for (const [k, v] of Object.entries(kf)) {
        if (!SPATIAL_PROPERTIES.has(k)) {
          (out as Record<string, unknown>)[k] = v;
        }
      }
      return out;
    });
  } else {
    // PropertyIndexedKeyframes format: remove spatial top-level keys, then
    // convert to Keyframe[] by distributing array values across frames.
    const nonSpatial: PropertyIndexedKeyframes = {};
    for (const [k, v] of Object.entries(keyframes)) {
      if (!SPATIAL_PROPERTIES.has(k)) {
        (nonSpatial as Record<string, unknown>)[k] = v;
      }
    }
    // Determine frame count from the longest value array.
    const frameCount = Math.max(
      ...Object.values(nonSpatial).map((v) =>
        Array.isArray(v) ? v.length : 1
      ),
      0
    );
    if (frameCount === 0) {
      // No non-spatial properties at all -- fall through to fade-in default.
      stripped = [];
    } else {
      stripped = Array.from({ length: frameCount }, (_, i) => {
        const kf: Keyframe = {};
        for (const [k, v] of Object.entries(nonSpatial)) {
          const arr = Array.isArray(v) ? v : [v];
          (kf as Record<string, unknown>)[k] = arr[Math.min(i, arr.length - 1)];
        }
        return kf;
      });
    }
  }

  // Check whether any keyframe in the result has an opacity value.
  const hasOpacity = stripped.some(
    (kf) => (kf as Record<string, unknown>).opacity !== undefined
  );

  // If opacity is present, the fade direction is already defined -- use as-is.
  // If not, default to a standard fade-in to communicate the state change visually.
  if (!hasOpacity) {
    return [{ opacity: 0 }, { opacity: 1 }];
  }

  return stripped;
}

/**
 * Extract the "start values" snapshot from keyframes for reverse-from-current support.
 * Returns a Record<string, string> with the first value of each animated property.
 */
function extractStartValues(
  keyframes: Keyframe[] | PropertyIndexedKeyframes
): Record<string, string> {
  const result: Record<string, string> = {};
  if (Array.isArray(keyframes)) {
    if (keyframes.length === 0) return result;
    const first = keyframes[0];
    for (const [k, v] of Object.entries(first)) {
      if (k !== "offset" && k !== "easing" && k !== "composite") {
        result[k] = String(v);
      }
    }
  } else {
    for (const [k, v] of Object.entries(keyframes)) {
      if (k !== "offset" && k !== "easing" && k !== "composite") {
        const arr = Array.isArray(v) ? v : [v];
        if (arr.length > 0) {
          result[k] = String(arr[0]);
        }
      }
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Core animate() implementation
// ---------------------------------------------------------------------------

/**
 * Animate an element using WAAPI, with named slots, cancellation modes,
 * token-aware duration, and reduced-motion awareness.
 */
export function animate(
  el: Element,
  keyframes: Keyframe[] | PropertyIndexedKeyframes,
  options?: AnimateOptions
): TugAnimation {
  const {
    duration,
    easing,
    key,
    slotCancelMode = "snap-to-end",
    composite = "replace",
    fill = "forwards",
    delay = 0,
  } = options ?? {};

  // Reduced-motion: strip spatial properties and fade instead. [D06]
  // Only activates when isTugMotionEnabled() returns false AND the keyframes
  // contain at least one spatial property. Non-spatial animations play unchanged.
  let resolvedKeyframes: Keyframe[] | PropertyIndexedKeyframes = keyframes;
  let resolvedDuration: number;

  if (!isTugMotionEnabled() && hasSpatialProperties(keyframes)) {
    resolvedKeyframes = stripSpatialAndFade(keyframes);
    resolvedDuration = resolveDuration("--tug-motion-duration-fast");
  } else {
    resolvedDuration = resolveDuration(duration);
  }

  // Named slot: cancel existing animation for this key on this element.
  if (key !== undefined) {
    const slotMap = _slots.get(el);
    if (slotMap !== undefined) {
      const existing = slotMap.get(key);
      if (existing !== undefined) {
        if (slotCancelMode === "hold-at-current") {
          // Absorb the expected rejection before cancelling.
          existing.finished.catch(() => {
            /* intentional no-op: rejection is expected on hold-at-current */
          });
          existing.cancel("hold-at-current");
        } else {
          existing.cancel("snap-to-end");
        }
      }
    }
  }

  // Store start values for reverse-from-current support.
  const startValues = extractStartValues(resolvedKeyframes);

  // Create the WAAPI animation.
  const wapiAnim = el.animate(resolvedKeyframes, {
    duration: resolvedDuration,
    // The one place the scale is applied to a delay, for the reason
    // `resolveDuration` applies it to a duration exactly once.
    delay: delay * getTugTiming(),
    easing: easing ?? "ease",
    composite,
    fill,
  });

  // Build a stable .finished promise that the TugAnimation owns.
  // We wrap the WAAPI .finished so we can re-wire it for reverse-from-current.
  let resolveFinished!: () => void;
  let rejectFinished!: (reason?: unknown) => void;
  let finishedPromise = new Promise<void>((res, rej) => {
    resolveFinished = res;
    rejectFinished = rej;
  });

  // Wire the WAAPI animation's .finished to our promise.
  // On natural completion: commit the final values into el.style so the element
  // *owns* them, then remove the animation. No lingering fill: forwards ghost.
  //
  // `commitStyles()` throws `InvalidStateError` if the target element is
  // no longer being rendered (detached from the document or display:none
  // by the time the animation's .finished promise resolves). When that
  // happens there is nothing useful to commit — the element is on its
  // way out — so swallow the error and proceed to cancel + resolve.
  // Without this guard the throw escapes as an unhandled rejection of
  // the `.then(...)` chain itself (the `(err) => rejectFinished(err)`
  // arm only handles rejection of the *incoming* promise).
  wapiAnim.finished.then(
    () => {
      try {
        wapiAnim.commitStyles();
      } catch {
        /* target detached; nothing to commit */
      }
      wapiAnim.cancel();
      resolveFinished();
    },
    (err) => rejectFinished(err)
  );

  // Build the TugAnimation wrapper.
  const tugAnim: TugAnimation = {
    get finished() {
      return finishedPromise;
    },
    raw: wapiAnim,
    cancel(mode: CancelMode = "snap-to-end", opts?: { reverseEasing?: string }) {
      switch (mode) {
        case "snap-to-end":
          wapiAnim.finish();
          break;

        case "hold-at-current":
          try {
            wapiAnim.commitStyles();
          } catch {
            /* target detached; nothing to commit */
          }
          wapiAnim.cancel();
          break;

        case "reverse-from-current": {
          // Bake current interpolated values into inline styles.
          try {
            wapiAnim.commitStyles();
          } catch {
            /* target detached; nothing to commit */
          }
          // Read current computed values for each animated property.
          const computed = getComputedStyle(el);
          const currentValues: Record<string, string> = {};
          for (const prop of Object.keys(startValues)) {
            currentValues[prop] = computed.getPropertyValue(prop) || (computed as unknown as Record<string, string>)[prop] || "";
          }

          // Silence the original finishedPromise (P1) before cancelling the
          // underlying WAAPI animation. wapiAnim.cancel() synchronously rejects
          // P1 via the wired .then() handler; without this guard P1 would be an
          // orphaned rejected promise and bun/Node would surface an unhandled
          // rejection error. Analogous to the .catch() guard used for
          // slotCancelMode 'hold-at-current'. [D05]
          finishedPromise.catch(() => {
            /* intentional no-op: rejection is expected and handled below */
          });
          // Null out the callbacks so they cannot fire into the stale P1 after
          // we replace finishedPromise with the re-wired promise below.
          resolveFinished = () => { /* no-op: P1 abandoned */ };
          rejectFinished = () => { /* no-op: P1 abandoned */ };

          // Cancel the original animation.
          wapiAnim.cancel();

          // Start a new reversal animation: from current values back to start values.
          const reverseKeyframes: Keyframe[] = [
            { ...currentValues },
            { ...startValues },
          ];
          const reversalWapi = el.animate(reverseKeyframes, {
            duration: resolvedDuration,
            easing: opts?.reverseEasing ?? "ease",
            composite,
            fill,
          });

          // Re-wire .finished to resolve when the reversal completes.
          finishedPromise = new Promise<void>((res, rej) => {
            reversalWapi.finished.then(
              () => res(),
              (err) => rej(err)
            );
          });
          break;
        }
      }
    },
  };

  // Register in named slot map.
  if (key !== undefined) {
    let slotMap = _slots.get(el);
    if (slotMap === undefined) {
      slotMap = new Map();
      _slots.set(el, slotMap);
    }
    slotMap.set(key, tugAnim);
  }

  // On natural completion, remove from slot map.
  if (key !== undefined) {
    wapiAnim.finished.then(
      () => {
        const slotMap = _slots.get(el);
        if (slotMap !== undefined) {
          slotMap.delete(key);
          if (slotMap.size === 0) {
            _slots.delete(el);
          }
        }
      },
      () => {
        /* cancelled -- slot may have already been replaced; do not remove */
      }
    );
  }

  return tugAnim;
}

// ---------------------------------------------------------------------------
// group() implementation
// ---------------------------------------------------------------------------

/**
 * Create an animation group. All animations added via group.animate() share
 * the group's default duration and easing, with per-animation overrides supported.
 * group.finished resolves when ALL constituent animations complete.
 */
export function group(options?: {
  duration?: string | number;
  easing?: string;
}): TugAnimationGroup {
  const groupDuration = options?.duration;
  const groupEasing = options?.easing;
  const animations: TugAnimation[] = [];
  let finishedPromise: Promise<void> = Promise.resolve();

  const g: TugAnimationGroup = {
    animate(
      el: Element,
      keyframes: Keyframe[] | PropertyIndexedKeyframes,
      animOptions?: AnimateOptions
    ): TugAnimation {
      const merged: AnimateOptions = {
        duration: groupDuration,
        easing: groupEasing,
        ...animOptions,
      };
      const tugAnim = animate(el, keyframes, merged);
      animations.push(tugAnim);
      // Silence the previous finishedPromise before replacing it. When an
      // animation is cancelled the old Promise.all rejects; without a handler
      // it becomes an orphaned rejected promise and surfaces as an unhandled
      // rejection error. The new Promise.all (below) is the authoritative
      // promise that callers hold a reference to via the getter.
      finishedPromise.catch(() => { /* superseded promise -- rejection handled by new Promise.all */ });
      // Rebuild finished as Promise.all over all accumulated .finished promises.
      finishedPromise = Promise.all(
        animations.map((a) => a.finished)
      ).then(() => undefined);
      return tugAnim;
    },

    get finished(): Promise<void> {
      return finishedPromise;
    },

    cancel(mode: CancelMode = "snap-to-end"): void {
      for (const anim of animations) {
        anim.cancel(mode);
      }
    },
  };

  return g;
}

// ---------------------------------------------------------------------------
// Timeline mark
// ---------------------------------------------------------------------------

/**
 * A clock on the document timeline: an empty effect of `durationMs` on `el`,
 * whose `finished` resolves on the first frame its time is up.
 *
 * It animates nothing. What it is for is timing a callback against effects
 * that share the same timeline — a delayed beat's first active frame — where a
 * `setTimeout` of the same length fires whenever the task queue gets to it,
 * which under a settle's own load is tens of ms late. `durationMs` is raw and
 * scaled by getTugTiming(), as animate()'s is. The caller owns the returned
 * animation and cancels it when the thing it times is called off.
 */
export function timelineMark(el: Element, durationMs: number): Animation {
  return el.animate(null, {
    duration: Math.max(1, durationMs * getTugTiming()),
    fill: "none",
  });
}

// ---------------------------------------------------------------------------
// Beat
// ---------------------------------------------------------------------------
//
// One object above `animate()` for motion that moves a layer the deck
// arranges. A group (above) is how everything else tweens; a Beat is the
// group's stricter sibling, and it owns five things no caller has to remember:
//
//  1. **The start pose, written when the beat is planned.** Each target's pose
//     goes into its inline style before any effect exists, so the DOM says
//     where the frame starts before there is a clock to ask.
//  2. **A start tied to a painted frame, never to a task.** The effects are
//     created synchronously when the beat is planned, so their start time
//     resolves at the rendering update the planning task ends in — the frame
//     the pose is painted in. A beat planned inside a gesture's task starts in
//     that task's own frame, which is what launching ahead of React relies on.
//  3. **Transform and opacity only, on layers that already stand.** Every
//     target must be in the document when the beat is planned, and every
//     keyframe may move only `transform` and `opacity`. A beat that carries a
//     known breach of that rule — a division's `height`, a width past the
//     raster cap — declares it, so the record names which beat paid; an
//     undeclared one is refused when the beat is planned.
//  4. **One landing.** `land` is idempotent and is the only place the end of
//     the beat is handled: the effects' own completion calls it, and so may
//     anybody who finds them already over. Whoever arrives second does nothing.
//  5. **Its own row.** At its landing the beat writes one row carrying its
//     recipe name, how many layers it moved, when its clock started against
//     when it was planned, and what it declared.
//
// **Where the start pose comes from.** A beat takes a pose — a set of inline
// style values per target — and not a function that produces one. The two
// callers derive their poses differently: the pre-launched move from the
// store's delta, the Last pass from what it measured on either side of the
// commit. Both are derivations the settle owns, and both have to finish before
// anything is written, because a measurement taken after a write reads a
// layout somebody dirtied. So the caller derives the pose and the beat writes
// it, and the beat is the one place a start pose is ever written.
//
// **Why the row goes through a recorder.** The animator sits below the deck and
// imports nothing of it; the deck's trace pulls in the store and its
// selectors. So the caller hands the beat the sink its row goes to, and the
// beat composes the row and calls it exactly once.

/** The CSS properties a beat may animate without declaring anything. */
const BEAT_PROPERTIES: ReadonlySet<string> = new Set(["transform", "opacity"]);

/** Keyframe keys that are timing and composition, not animated properties. */
const KEYFRAME_META_KEYS: ReadonlySet<string> = new Set([
  "offset",
  "easing",
  "composite",
]);

/** A property a beat animates knowing it breaks the transform/opacity rule. */
export type BeatDeclaredProperty = "height" | "width";

/**
 * The properties a keyframe list animates, sorted. Timing and composition keys
 * (`offset`, `easing`, `composite`) are not properties and are left out.
 */
export function beatAnimatedProperties(
  keyframes: Keyframe[] | PropertyIndexedKeyframes,
): string[] {
  const props = new Set<string>();
  const frames = Array.isArray(keyframes) ? keyframes : [keyframes];
  for (const frame of frames) {
    for (const key of Object.keys(frame)) {
      if (!KEYFRAME_META_KEYS.has(key)) props.add(key);
    }
  }
  return [...props].sort();
}

/**
 * The properties in `keyframes` a beat may not animate: anything but
 * `transform` and `opacity` that the beat has not declared. Empty is the
 * answer a beat must get before it is planned.
 */
export function undeclaredBeatProperties(
  keyframes: Keyframe[] | PropertyIndexedKeyframes,
  declares: readonly BeatDeclaredProperty[],
): string[] {
  const declared = new Set<string>(declares);
  return beatAnimatedProperties(keyframes).filter(
    (prop) => !BEAT_PROPERTIES.has(prop) && !declared.has(prop),
  );
}

/** How a beat came to land. */
export type BeatLanding =
  /** Every effect ran out its time. */
  | "finished"
  /** Landed while an effect was still running — cancelled, or handed back
   *  early by a settle that superseded it. */
  | "cut";

/** The row a beat writes at its landing. */
export interface BeatRow {
  /** The recipe the beat ran, by name. */
  recipe: string;
  /** How many layers the beat moved. */
  targets: number;
  /** The beat's scaled duration, in ms. */
  durationMs: number;
  /**
   * Planning to the first frame the beat's clock ran in, in ms, from the
   * effects' own resolved start time. `-1` when no effect's clock ever started
   * — a beat landed before its first frame.
   */
  startDelayMs: number;
  /** The breaches of the transform/opacity rule this beat carries. */
  declares: readonly BeatDeclaredProperty[];
  landing: BeatLanding;
}

/**
 * Compose a beat's row from what it knows at its landing. Pure: `plannedAt` and
 * `startTimes` are document-timeline milliseconds, and a `null` start time is
 * an effect whose clock never started.
 */
export function beatRow(args: {
  recipe: string;
  targets: number;
  durationMs: number;
  declares: readonly BeatDeclaredProperty[];
  plannedAt: number | null;
  startTimes: readonly (number | null)[];
  allFinished: boolean;
}): BeatRow {
  const started = args.startTimes.filter((t): t is number => t !== null);
  const startDelayMs =
    args.plannedAt === null || started.length === 0
      ? -1
      : Math.max(0, Math.round(Math.min(...started) - args.plannedAt));
  return {
    recipe: args.recipe,
    targets: args.targets,
    durationMs: Math.round(args.durationMs),
    startDelayMs,
    declares: [...args.declares],
    landing: args.allFinished ? "finished" : "cut",
  };
}

/** One layer a beat moves. */
export interface BeatTarget {
  el: HTMLElement;
  /** The motion, from the start pose to rest. */
  keyframes: Keyframe[] | PropertyIndexedKeyframes;
  /**
   * The start pose: inline style values written to `el` when the beat is
   * planned, by CSS property name (`transform-origin`, not `transformOrigin`).
   */
  pose?: Readonly<Record<string, string>>;
  /** This target's slot, when it is not the beat's: a layer that rides the
   *  beat beside another one, on a slot of its own. */
  key?: string;
}

/** What a beat is planned from. */
export interface BeatOptions {
  /** The recipe's name, carried on the beat's row. */
  recipe: string;
  targets: readonly BeatTarget[];
  /** Raw (unscaled) duration in ms; scaled by getTugTiming() like animate()'s. */
  durationMs: number;
  /** Raw (unscaled) delay in ms before the active phase. Default 0. */
  delayMs?: number;
  easing?: string;
  fill?: FillMode;
  composite?: CompositeOperation;
  /** The named slot each target's effect takes, as animate()'s `key`. */
  key?: string;
  slotCancelMode?: "snap-to-end" | "hold-at-current";
  /** Known breaches of the transform/opacity rule this beat carries. */
  declares?: readonly BeatDeclaredProperty[];
  /** Called once, at the landing, before the row is written. */
  onLand?: (landing: BeatLanding) => void;
  /** Where the beat's row goes. */
  record?: (row: BeatRow) => void;
}

/** A planned beat. */
export interface Beat {
  readonly recipe: string;
  /** Each target with the effect the beat made for it, in target order. */
  readonly entries: readonly { el: HTMLElement; anim: TugAnimation }[];
  /** Every effect the beat made, in target order. */
  readonly anims: readonly TugAnimation[];
  /** `performance.now()` when the beat was planned. */
  readonly plannedAt: number;
  /** Whether every effect has run out its time. Answered from the timeline
   *  alone, so it is true the instant the last effect stops contributing —
   *  a promise hop before its completion lands. False for a beat with none. */
  isOver(): boolean;
  /** Land the beat. Idempotent: the first call lands, every later one is a
   *  no-op. */
  land(): void;
}

/**
 * Plan a beat: write every target's start pose, then create every effect.
 *
 * Throws, before writing anything, when a target is not in the document or a
 * target's keyframes animate an undeclared property — both are a caller's
 * error, and a beat that started anyway would break the rule it exists to keep.
 */
export function planBeat(options: BeatOptions): Beat {
  const declares = options.declares ?? [];
  for (const target of options.targets) {
    if (!target.el.isConnected) {
      throw new Error(
        `TugAnimator: beat "${options.recipe}" planned on a layer that is not in the document`,
      );
    }
    const undeclared = undeclaredBeatProperties(target.keyframes, declares);
    if (undeclared.length > 0) {
      throw new Error(
        `TugAnimator: beat "${options.recipe}" animates ${undeclared.join(", ")} ` +
          `without declaring it; a beat moves only transform and opacity`,
      );
    }
  }

  // The pose first, for every target, and only then the effects: nothing is
  // created against a layer whose start pose is not yet in its style.
  for (const target of options.targets) {
    if (target.pose === undefined) continue;
    for (const [prop, value] of Object.entries(target.pose)) {
      target.el.style.setProperty(prop, value);
    }
  }

  const plannedAt = performance.now();
  const plannedTimeline = document.timeline.currentTime;
  const entries = options.targets.map((target) => ({
    el: target.el,
    anim: animate(target.el, target.keyframes, {
      duration: options.durationMs,
      delay: options.delayMs,
      easing: options.easing,
      fill: options.fill,
      composite: options.composite,
      key: target.key ?? options.key,
      slotCancelMode: options.slotCancelMode,
    }),
  }));
  const anims = entries.map((entry) => entry.anim);

  // Each effect's start time, once its clock resolves. A cancelled effect's
  // `ready` rejects, and it then simply has no start time to report.
  const startTimes: (number | null)[] = anims.map(() => null);
  anims.forEach((anim, i) => {
    anim.raw.ready.then(
      () => {
        const t = anim.raw.startTime;
        startTimes[i] = typeof t === "number" ? t : null;
      },
      () => {
        /* cancelled before its first frame */
      },
    );
  });

  const isOver = (): boolean =>
    anims.length > 0 && anims.every((anim) => anim.raw.playState === "finished");

  let landed = false;
  const landAs = (allFinished: boolean): void => {
    if (landed) return;
    landed = true;
    options.onLand?.(allFinished ? "finished" : "cut");
    options.record?.(
      beatRow({
        recipe: options.recipe,
        targets: entries.length,
        durationMs: options.durationMs * getTugTiming(),
        declares,
        plannedAt: typeof plannedTimeline === "number" ? plannedTimeline : null,
        startTimes,
        allFinished,
      }),
    );
  };
  // The effects' own completion. Read from the promises rather than from
  // `playState`: animate() commits and cancels an effect as it finishes, so
  // by the time this lands a finished effect reads `idle`. A rejection is an
  // effect that was cancelled mid-flight.
  void Promise.allSettled(anims.map((anim) => anim.finished)).then((results) =>
    landAs(results.every((r) => r.status === "fulfilled")),
  );
  // Anybody else who lands the beat finds it over or not from the timeline.
  const land = (): void => landAs(isOver());

  return {
    recipe: options.recipe,
    entries,
    anims,
    plannedAt,
    isOver,
    land,
  };
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Reset the module-level named slot WeakMap. Call in afterEach to prevent
 * cross-test pollution. Test-only -- do not call in production code.
 */
export function _resetSlots(): void {
  _slots = new WeakMap();
}
