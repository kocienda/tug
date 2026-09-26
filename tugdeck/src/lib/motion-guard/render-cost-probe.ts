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

/**
 * What a frame's rendering update may cost before the deck is walking.
 *
 * Calibrated, not chosen. `at0629` reads two costs off the same deck — 300
 * breathing dots in a pane, 900 long-running animations — and this number sits
 * between them: at least twice the quiet p95, and below the p50 of the
 * deliberately-broken reading the forcing probe drives.
 *
 * The run it came from, on an Apple M4 Max under macOS 27.0, three passes:
 *
 * | reading | p50 | p95 |
 * |---|---|---|
 * | quiet, 60 frames | 3 | 8 / 7 / 5 |
 * | forced (a per-frame inline transform write on one dot) | 17 / 17 / 17 | 19 |
 *
 * Twice the worst quiet p95 is 16, and the forced p50 is 17, so 16 is the
 * smallest whole millisecond the rule admits. Two things are worth knowing
 * before anyone moves it. The gap is narrow at the top and wide at the bottom:
 * the forced p50 was stable to the millisecond across all three passes while
 * the quiet p95 was not, so the constant is pinned by the noisier of the two
 * readings and 2× is what absorbs that noise. And the bench is deliberately an
 * extreme population — a real deck carries a fraction of 900 loops, where a
 * broken form costs proportionally less — so this budget is a backstop against
 * the catastrophic case rather than a fine-grained detector. Three consecutive
 * samples ({@link SAMPLE_INTERVAL_MS} apart, nothing in flight) is the other
 * half of that: a single tail frame of 19 ms is not a diagnosis.
 *
 * Re-read it with `just app-test at0629-motion-render-cost.test.ts` and the
 * `Diagnostics:` section; `tuglaws/animation-doctrine.md` carries the argument.
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
        this.#record({ t: performance.now(), costMs, inFlight: this.#readInFlight() });
        this.#schedule();
      });
    }, SAMPLE_INTERVAL_MS);
  }

  #readInFlight(): boolean {
    try {
      return this.#inFlightSource();
    } catch {
      // A source that throws is a bug in the adapter, not a reason to lose
      // the reading — the cost is the measurement, `inFlight` is its label.
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
