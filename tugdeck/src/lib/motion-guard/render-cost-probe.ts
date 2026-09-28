/**
 * The render-cost probe — the page measuring what the doctrine forbids.
 *
 * The gauge this whole layer reads is one number: **how long the frame's
 * rendering update took**. In the HTML event loop a frame runs its
 * `requestAnimationFrame` callbacks first, then style, layout and compositing
 * synchronously in the same rendering update, and only then does the next task
 * run. So the interval from a `performance.now()` taken inside a rAF callback
 * to the first `performance.now()` inside a `setTimeout(…, 0)` queued from it
 * is the frame's style-layout-compositing cost — the exact walk that pinned
 * the release deck's WebContent process at 100% ([F02], [B01], [P01]).
 *
 * It is measured from inside the page with `performance.now()`,
 * `requestAnimationFrame` and `setTimeout` and nothing else, which is what
 * makes it readable on a release build with no Web Inspector and no host code
 * ([B02]: no private API, ever).
 *
 * ## Two frames per sample
 *
 * {@link sampleFrame} waits two frames and reports the second. The first
 * absorbs the timer task that scheduled the sample — a frame that follows a
 * task is not a frame like any other — and the second is an ordinary frame.
 * Nothing here writes style, so the sample does not dirty the frame it is
 * measuring.
 *
 * ## The at-rest gauge: updates per second over a floor
 *
 * The cost above says what a frame costs when one runs; it cannot say how
 * many run. A deck running a 7 ms rendering update every frame with nothing
 * streaming is under budget on every sample and reads as healthy, and that
 * is the deck that starves a fold. So each sample also carries a second
 * reading, {@link sampleRest}: over a {@link REST_WINDOW_MS} window a chain
 * of short timers records the gap between consecutive fires, and a gap that
 * exceeds the chain's own median by more than {@link REST_STALL_FLOOR_MS} is
 * a rendering update (or another task) that held the main thread for that
 * long. The count per second is `updatesPerSecond`.
 *
 * It is a count of updates **over the floor**, not of updates. WebKit runs a
 * rendering update every frame for as long as any animation exists on the
 * document timeline — `shouldRunUpdateAnimationsAndSendEvents` is true while
 * `m_animations` is non-empty, compositor-resident or not — so a deck with
 * one resident dot breathing schedules sixty updates a second by
 * construction, each costing the timeline tick and nothing else. Those are
 * not what the fold is paying for. What it pays for is the update that
 * resolves animated style on the main thread and walks the compositing tree
 * behind it, and that one is priced in milliseconds, which is what a gap in
 * a timer chain can see. A resident loop reads zero; a software-ticked one
 * reads the display rate.
 *
 * The chain hops through a `MessageChannel` between fires because a timer
 * scheduled from a timer inherits its nesting level, and past five levels
 * WebKit clamps the interval to several milliseconds — coarser than the
 * updates it exists to see. A message task resets the level, so each fire
 * lands about a millisecond after the last. Six hundred fires a second for
 * one second in every three, while motion is running, is the cost of the
 * reading; a disarmed probe takes none.
 *
 * ## A finisher, not a loop
 *
 * [D7] and [B03]: the probe arms on the motion registry's rising edge and
 * disarms on its falling one, and while armed it takes one sample every
 * {@link SAMPLE_INTERVAL_MS}. One `requestAnimationFrame` pair every three
 * seconds while motion is already running is a sample; a deck at rest runs
 * nothing at all.
 *
 * **[L13] cross-check.** "`requestAnimationFrame` is not for animation" — and
 * this is not animation. The probe moves nothing and writes no style; its
 * closest sibling in the tree, `settle-frame-probe.ts`, is a rAF sampler of
 * exactly this shape. The law is honoured by the probe falling outside its
 * subject rather than by an exemption.
 *
 * ## Occlusion
 *
 * An occluded or minimised window suspends `requestAnimationFrame` outright
 * (the same hazard `settle-frame-probe.ts` names above its suspension floor).
 * A pending sample then simply waits and costs nothing, and {@link
 * RenderCostProbe.disarm} drops its result when it finally resolves.
 *
 * @module lib/motion-guard/render-cost-probe
 */

/** How often an armed probe takes a sample. */
export const SAMPLE_INTERVAL_MS = 3000;

/** How many samples the probe keeps. Older ones fall off the front. */
export const SAMPLE_RING_LIMIT = 32;

/** How long one at-rest reading watches the main thread. */
export const REST_WINDOW_MS = 1000;

/** The timer interval the at-rest chain asks for, before the engine's clamp. */
export const REST_TICK_MS = 1;

/**
 * How far past the chain's own median a gap has to reach to count as an
 * update. Two milliseconds on a millisecond-coarsened clock: a rendering
 * update that resolves animated style costs more than that on any deck
 * worth measuring, and a timer fire's own jitter costs less.
 */
export const REST_STALL_FLOOR_MS = 2;

/**
 * How many updates per second a deck may run at rest before the breaker
 * reads it as a loop that never left the main thread.
 *
 * Not zero, because a still deck is not a silent one: a store sweep, a
 * telemetry text commit or a garbage collection is a stall the chain sees
 * and none of them is a loop. A handful a second is that noise; a loop is
 * the display rate, sixty.
 *
 * Calibrated, not chosen, and this is the detector — the constant below is
 * the backstop. The rule is the same as the cost budget's: at least twice
 * the worst quiet reading, and below the broken one. `at0629` on an Apple
 * M4 Max under macOS 27.0, three passes per column, the off-screen rule on
 * where it says so:
 *
 * | updates/s over a 2 ms floor | 100 glyphs, all in view | 300, rule on (169 in view) | 300, every dot running |
 * |---|---|---|---|
 * | quiet | 3 / 2 / 2 | 2 / 2 / 2 | 3 / 3 / 3 |
 * | on-screen dots only, the 131 clipped dots paused by hand | — | — | 5 / 4 / 4 |
 * | forced (a per-frame inline transform write on one dot) | 60 | 60 | 60 |
 *
 * Twice the worst quiet reading, 5, is 10, and the forced reading is the
 * display rate at every population, so 10 is the smallest whole number the
 * rule admits with the broken reading six times above it. It is what
 * convicts the walk now: the forced frame on the 3-stop dot costs 3 ms at
 * 100 glyphs and 8 at 300, inside the quiet tail either way, so the cost
 * gauge cannot see it — and it reads 60 a second against 2 or 3 on the same
 * deck in the same run. The release deck before the off-screen rule read 59
 * to 60 here at rest with 54 dots on it.
 *
 * Re-read it with `just app-test at0629-motion-render-cost.test.ts` and the
 * `Diagnostics:` section; `tuglaws/animation-doctrine.md` carries the two
 * tables and the argument.
 */
export const REST_UPDATES_BUDGET_PER_S = 10;

/**
 * What a frame's rendering update may cost before the deck is walking.
 *
 * Calibrated, not chosen, and it is the backstop: the constant above is the
 * detector. `at0629` reads two costs off the same deck, and the rule was that
 * this number sits between them — at least twice the quiet p95, and below
 * the p50 of the deliberately-broken reading the forcing probe drives.
 *
 * Re-read on 2026-09-28 from the bench as it ships — the off-screen rule on,
 * so the dots the pane clips carry no animation — on an Apple M4 Max under
 * macOS 27.0, three passes per column, the 3-stop dot:
 *
 * | ms | 100 glyphs, all in view | 300, rule on (169 in view) | 300, every dot running |
 * |---|---|---|---|
 * | quiet p50 | 2 / 2 / 2 | 3 / 2 / 4 | 3 / 3 / 3 |
 * | quiet p95 | 3 / 3 / 3 | 5 / 5 / 5 | 7 / 7 / 7 |
 * | forced p50 | 3 / 3 / 3 | — | 8 / 8 / 8 |
 *
 * The rule's two ends have crossed: twice the worst shipped quiet p95 is 10
 * and the forced p50 is 8. The walk got cheap — it is priced per keyframe
 * per layer, and the dot went from 21 stops to 3, so the driver that cost
 * 17 ms a frame on the first calibration costs 8 — and the cost gauge can
 * no longer tell it from the quiet tail. The at-rest count can, at every
 * population, which is why that constant is the detector. So this one
 * stands by its lower bound alone: twice the worst quiet p95 ever recorded
 * on this bench is 16 (8 on the first calibration, 7 now with every dot
 * running), and a budget the quiet tail can reach fires on nothing — single
 * frames of 13, 14 and 19 ms sit in the max column of these passes on a
 * deck doing nothing. It stills the deck on the catastrophic frame, the
 * whole-page walk back in the frame loop at a price that starves a fold, and
 * it counts every sample, in flight or not, because an over-budget frame
 * during a stream is the loops' bill rather than the stream's alibi. Three
 * consecutive samples ({@link SAMPLE_INTERVAL_MS} apart) is the other half:
 * a single tail frame is not a diagnosis.
 *
 * The first calibration — 21-stop dot, every dot running, no off-screen
 * rule — read a quiet p95 of 8 / 7 / 5 and a forced p50 of 17 / 17 / 17;
 * `tuglaws/animation-doctrine.md` keeps it as the record of what was
 * accepted, beside the argument. Re-read either constant with
 * `just app-test at0629-motion-render-cost.test.ts` and the `Diagnostics:`
 * section, and move the two together.
 */
export const RENDER_COST_BUDGET_MS = 16;

/** One reading: when it was taken, what it cost, and what the deck was doing. */
export interface RenderCostSample {
  /** `performance.now()` at the moment the reading resolved. */
  t: number;
  /** The frame's style-layout-compositing cost, in milliseconds. */
  costMs: number;
  /**
   * Whether any session was mid-turn when the sample was taken, per the
   * source installed with {@link RenderCostProbe.setInFlightSource}. A frame
   * that lays out a streaming transcript is expensive for a reason ([D4]);
   * the breaker only counts samples taken with nothing in flight ([P07]).
   */
  inFlight: boolean;
  /**
   * Whether a gesture — a settle, a fold, a switch — was running when the
   * sample was taken, per {@link RenderCostProbe.setGestureSource}. A
   * gesture legitimately schedules updates every frame for its length; the
   * at-rest trip only counts samples taken with none in flight.
   */
  gesture: boolean;
  /**
   * Rendering updates per second that held the main thread past
   * {@link REST_STALL_FLOOR_MS}, from the at-rest reading taken right after
   * the cost reading. Zero on a deck whose loops are all resident.
   */
  updatesPerSecond: number;
}

/** One at-rest reading: what the timer chain saw over its window. */
export interface RestReading {
  /** Updates per second over the floor, normalized to one second. */
  updatesPerSecond: number;
  /** Main-thread milliseconds per second those updates held, past the median. */
  busyMsPerSecond: number;
  /** How long the chain actually ran. */
  windowMs: number;
  /** How many times the chain fired. */
  ticks: number;
  /** The chain's own cadence — the median gap between fires. */
  medianGapMs: number;
  /** The longest gap: the single worst stall in the window. */
  maxGapMs: number;
  /** The floor the count was taken over, so a reader can re-derive it. */
  floorMs: number;
}

/** Summary statistics over a set of readings. */
export interface RenderCostSummary {
  p50: number;
  p95: number;
  max: number;
}

/**
 * Take one reading: two frames, reporting the second.
 *
 * Resolves with the milliseconds the frame's rendering update took.
 */
export function sampleFrame(): Promise<number> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const start = performance.now();
        setTimeout(() => resolve(performance.now() - start), 0);
      });
    });
  });
}

/**
 * Take `frames` readings back to back.
 *
 * `burst(0)` resolves to an empty array without touching the frame clock, so a
 * caller that computed its own frame count from something empty costs nothing.
 */
export async function burst(frames: number): Promise<number[]> {
  const readings: number[] = [];
  for (let i = 0; i < frames; i += 1) {
    readings.push(await sampleFrame());
  }
  return readings;
}

/**
 * p50, p95 and max over a set of readings.
 *
 * Nearest-rank over a sorted copy — the input is never reordered. An empty
 * input summarizes as zeros rather than `NaN`, so a reader that renders the
 * summary before any sample has landed prints numbers.
 */
export function summarize(values: readonly number[]): RenderCostSummary {
  if (values.length === 0) return { p50: 0, p95: 0, max: 0 };
  const sorted = Array.from(values).sort((a, b) => a - b);
  const rank = (p: number): number =>
    sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))]!;
  return {
    p50: rank(0.5),
    p95: rank(0.95),
    max: sorted[sorted.length - 1]!,
  };
}

/**
 * Fold a chain's gaps into an at-rest reading.
 *
 * Pure over the gaps so the arithmetic is testable without a main thread:
 * the median is the chain's cadence, a gap more than `floorMs` past it is a
 * stall, and the count and the busy time are normalized to a second so two
 * readings over different windows compare. An empty chain reads as zeros.
 */
export function restFromGaps(
  gaps: readonly number[],
  windowMs: number,
  floorMs: number = REST_STALL_FLOOR_MS,
): RestReading {
  if (gaps.length === 0 || windowMs <= 0) {
    return {
      updatesPerSecond: 0,
      busyMsPerSecond: 0,
      windowMs: Math.max(0, windowMs),
      ticks: 0,
      medianGapMs: 0,
      maxGapMs: 0,
      floorMs,
    };
  }
  const sorted = Array.from(gaps).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)]!;
  let stalls = 0;
  let busy = 0;
  for (const gap of gaps) {
    if (gap > median + floorMs) {
      stalls += 1;
      busy += gap - median;
    }
  }
  const perSecond = 1000 / windowMs;
  return {
    updatesPerSecond: Math.round(stalls * perSecond),
    busyMsPerSecond: Math.round(busy * perSecond),
    windowMs,
    ticks: gaps.length,
    medianGapMs: median,
    maxGapMs: sorted[sorted.length - 1]!,
    floorMs,
  };
}

/**
 * Take one at-rest reading: watch the main thread for `windowMs` and count
 * the updates that held it past the floor.
 *
 * The chain writes no style and touches no element; what it perturbs is the
 * timer queue, by about six hundred one-millisecond fires. See the module
 * docblock for why it hops through a `MessageChannel`.
 */
export function sampleRest(windowMs = REST_WINDOW_MS): Promise<RestReading> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const gaps: number[] = [];
    const started = performance.now();
    let last = started;
    const step = (): void => {
      const now = performance.now();
      gaps.push(now - last);
      last = now;
      if (now - started < windowMs) {
        channel.port2.postMessage(0);
      } else {
        channel.port1.onmessage = null;
        channel.port1.close();
        channel.port2.close();
        resolve(restFromGaps(gaps, now - started));
      }
    };
    channel.port1.onmessage = () => {
      window.setTimeout(step, REST_TICK_MS);
    };
    window.setTimeout(step, REST_TICK_MS);
  });
}

/** Called with each sample as it lands. The breaker's subscription ([P07]). */
export type RenderCostSampleListener = (sample: RenderCostSample) => void;

export interface RenderCostProbe {
  /** Start sampling. Idempotent: arming an armed probe does nothing. */
  arm(): void;
  /** Stop sampling and drop any reading still in flight. Idempotent. */
  disarm(): void;
  readonly armed: boolean;
  /** The last {@link SAMPLE_RING_LIMIT} samples, oldest first. */
  samples(): RenderCostSample[];
  /** Subscribe to samples as they land. Returns an unsubscribe. */
  onSample(listener: RenderCostSampleListener): () => void;
  /**
   * Install the "is anything mid-turn?" source.
   *
   * Injected rather than imported so this module never reaches into the
   * session stores — the probe is a measuring instrument and has no business
   * knowing what a session is. Defaults to "nothing in flight".
   */
  setInFlightSource(source: () => boolean): void;
  /**
   * Install the "is a gesture running?" source. Injected for the same
   * reason as the in-flight one: the probe does not know what a settle is.
   * Defaults to "no gesture".
   */
  setGestureSource(source: () => boolean): void;
  /** Drop every recorded sample. Diagnostics `reset()` and tests. */
  clear(): void;
}

class RenderCostProbeImpl implements RenderCostProbe {
  #armed = false;
  #timer: number | null = null;
  /**
   * Bumped by every `disarm`. A reading that resolves after its generation
   * has been retired is dropped — an occluded window can hold a rAF pair for
   * minutes, and the deck may well have gone quiet by the time it lands.
   */
  #generation = 0;
  #ring: RenderCostSample[] = [];
  #listeners = new Set<RenderCostSampleListener>();
  #inFlightSource: () => boolean = () => false;
  #gestureSource: () => boolean = () => false;

  get armed(): boolean {
    return this.#armed;
  }

  arm(): void {
    if (this.#armed) return;
    this.#armed = true;
    this.#schedule();
  }

  disarm(): void {
    if (!this.#armed) return;
    this.#armed = false;
    this.#generation += 1;
    if (this.#timer !== null) {
      window.clearTimeout(this.#timer);
      this.#timer = null;
    }
  }

  samples(): RenderCostSample[] {
    return Array.from(this.#ring);
  }

  onSample(listener: RenderCostSampleListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  setInFlightSource(source: () => boolean): void {
    this.#inFlightSource = source;
  }

  setGestureSource(source: () => boolean): void {
    this.#gestureSource = source;
  }

  clear(): void {
    this.#ring = [];
  }

  #schedule(): void {
    const generation = this.#generation;
    this.#timer = window.setTimeout(() => {
      this.#timer = null;
      if (!this.#armed || generation !== this.#generation) return;
      void sampleFrame().then((costMs) => {
        if (!this.#armed || generation !== this.#generation) return;
        // The two readings run back to back rather than at once: the cost
        // reading's own rAF pair would register as a stall in the chain.
        void sampleRest().then((rest) => {
          if (!this.#armed || generation !== this.#generation) return;
          this.#record({
            t: performance.now(),
            costMs,
            inFlight: this.#readSource(this.#inFlightSource),
            gesture: this.#readSource(this.#gestureSource),
            updatesPerSecond: rest.updatesPerSecond,
          });
          this.#schedule();
        });
      });
    }, SAMPLE_INTERVAL_MS);
  }

  #readSource(source: () => boolean): boolean {
    try {
      return source();
    } catch {
      // A source that throws is a bug in the adapter, not a reason to lose
      // the reading — the cost is the measurement, the flag is its label.
      return false;
    }
  }

  #record(sample: RenderCostSample): void {
    this.#ring.push(sample);
    if (this.#ring.length > SAMPLE_RING_LIMIT) this.#ring.shift();
    for (const listener of Array.from(this.#listeners)) listener(sample);
  }
}

/** The one probe. Armed by the motion registry's edges; see `index.ts`. */
export const renderCostProbe: RenderCostProbe = new RenderCostProbeImpl();
