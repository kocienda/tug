/**
 * `window.__tugMotion` — the release deck, answerable about its own motion.
 *
 * The host keeps `developerExtrasEnabled` and `isInspectable` off in every
 * build by decision ([F07]), so the build the user is actually running is the
 * one build nobody can ask what is ticking. This object is the answer: a
 * handle bound in **every** build, on the same reasoning `deck-trace.ts` binds
 * `window.__deckTrace` — a handle that exists only in dev is unreachable in
 * exactly the sessions that carry the evidence.
 *
 * Everything on it is public platform API: `document.getAnimations()`,
 * `Animation.pause()`, `performance.now()`, `PerformanceObserver`. Nothing
 * here reaches for a private surface, in the page or in the host ([B02]).
 *
 * ## It adds no capability to a release build
 *
 * `pause`, `demote` and `setBudget` mutate. The only door to them on a release
 * build is `POST /api/eval`, which is loopback-only and gated on dev mode or
 * the per-instance `diag/eval` opt-in; with the inspector off there is no
 * other caller. `tugtool deck motion` is the shell end of that door ([P05]).
 *
 * ## What it is for
 *
 * `bisect()` is the one that settles an incident: it pauses each loop group in
 * turn, measures the render cost with it paused, resumes it, and sorts by the
 * drop. The group whose pause collapses the cost is the culprit, named in
 * seconds on the build in front of the user, rather than by elimination over
 * the source ([F03], [B04]).
 *
 * @module lib/motion-guard/diagnostics
 */

import {
  animationCensus,
  layerTreeProbe,
  type AnimationCensus,
  type LayerTreeProbe,
} from "@/lib/perf-monitor";

import { motionHolds } from "./registry";
import { motionBreaker } from "./breaker";
import {
  burst,
  renderCostProbe,
  summarize,
  type RenderCostSample,
  type RenderCostSummary,
} from "./render-cost-probe";
import {
  clearInputLatency,
  inputLatency,
  type InputLatencyReading,
} from "./input-latency";
import {
  armGeometryChains,
  disarmGeometryChains,
  readGeometryChains,
  type ChainArmReading,
  type GeometryChainReading,
} from "./geometry-chain-probe";

/** Frames per reading in {@link TugMotionDiagnostics.cost}. */
export const COST_FRAMES_DEFAULT = 30;

/** Frames per group in {@link TugMotionDiagnostics.bisect}. */
export const BISECT_FRAMES = 20;

/**
 * How many loop groups one `bisect()` reads.
 *
 * `eval_handler` on tugcast gives a call 30 seconds. The cost is
 * `groups × frames × frame-time`, and a saturated deck paints at 15 fps, so
 * 20 frames a group is ~1.3 s there. Eight groups is ~11 s at that rate, with
 * room for the baseline. A deck with more loop names truncates and says how
 * many it read, rather than timing out with nothing.
 */
export const BISECT_GROUP_CAP = 8;

export interface RenderCostReading extends RenderCostSummary {
  /** The frames just taken, in order. */
  burst: number[];
  /** What the armed probe has been recording in the background. */
  samples: RenderCostSample[];
}

export interface BisectGroupReading {
  /** The animation name the group shares. */
  name: string;
  /** How many animations carry that name. */
  count: number;
  /** p50 render cost with the group paused. */
  pausedP50: number;
  /** Baseline p50 minus {@link BisectGroupReading.pausedP50}. Bigger is guiltier. */
  drop: number;
}

export interface BisectReading {
  /** p50 render cost with everything running. */
  baselineP50: number;
  /** One row per group, sorted by drop, guiltiest first. */
  groups: BisectGroupReading[];
  /** How many groups the deck had, and how many this call read. */
  groupsFound: number;
  groupsRead: number;
}

export interface ProbeReading {
  armed: boolean;
  holds: number;
  demoted: boolean;
  /** Whether the demotion has latched until `reset()` or a reload. */
  latched: boolean;
  trips: number;
  /**
   * The per-frame render-cost budget, in milliseconds.
   *
   * Read rather than hard-coded by anything that asserts against it, so the
   * calibrated number lands in one place.
   */
  budgetMs: number;
  samples: RenderCostSample[];
}

export interface TugMotionDiagnostics {
  /** Every long-running animation, with its target, properties and violations. */
  list(options?: { within?: string }): AnimationCensus;
  /** Pause every animation whose target matches, or sits inside a match. */
  pause(selector: string): { paused: number };
  /** Resume them. */
  resume(selector: string): { resumed: number };
  /** Take `frames` readings now, and hand back the probe's recent ones too. */
  cost(frames?: number): Promise<RenderCostReading>;
  /** Pause each loop group in turn and report which one's absence is felt. */
  bisect(options?: { frames?: number; cap?: number }): Promise<BisectReading>;
  /** The population the compositing walk pays for ([F04]). */
  layers(): LayerTreeProbe;
  /** Input-to-next-paint, where the engine reports it ([P08]). */
  input(): InputLatencyReading;
  /** What the probe is doing right now. */
  probe(): ProbeReading;
  /** Still every long-running loop, or let them run again ([P06], [P07]). */
  demote(on: boolean): ProbeReading;
  /** Move the breaker's budget. Takes effect on the next sample. */
  setBudget(ms: number): ProbeReading;
  /**
   * The read→write→read chains under a gesture ([P03], Spec S04).
   *
   * `arm` and `disarm` MUTATE — they replace platform property descriptors —
   * so this member has the same standing as `pause`, `demote` and `setBudget`:
   * the only door to it on a release build is the loopback eval endpoint, gated
   * on dev mode or the per-instance `diag/eval` opt-in. Nothing arms it on load,
   * and an armed probe is paying a stack capture per geometry read, so it is
   * armed around the gesture under study and disarmed after.
   */
  chains(mode: "arm" | "read" | "disarm"): ChainArmReading | GeometryChainReading;
  /** Clear the probe's samples and the input ring, and un-latch the breaker. */
  reset(): void;
  /** Test-mode only: the driver that lights the walk ([D5], #forcing-probe). */
  __force?(on: boolean): { forcing: boolean };
  /** Test-mode only: one innocent style commit per frame ([P06]). */
  __stream?(on: boolean): { streaming: boolean };
}

declare global {
  interface Window {
    __tugMotion?: TugMotionDiagnostics;
  }
}

// ---------------------------------------------------------------------------
// Selector matching over the animation list
// ---------------------------------------------------------------------------

function targetOf(animation: Animation): Element | null {
  const effect = animation.effect;
  if (!(effect instanceof KeyframeEffect)) return null;
  return effect.target;
}

function matching(selector: string): Animation[] {
  return document.getAnimations().filter((animation) => {
    const target = targetOf(animation);
    if (target === null) return false;
    return target.matches(selector) || target.closest(selector) !== null;
  });
}

function animationName(animation: Animation): string {
  // `CSSAnimation.animationName` is the loop's name; a script-driven
  // animation has only its `id`, and an anonymous one groups under `<waapi>`.
  const css = animation as Animation & { animationName?: string };
  if (typeof css.animationName === "string" && css.animationName !== "") {
    return css.animationName;
  }
  return animation.id !== "" ? animation.id : "<waapi>";
}

function longRunningAnimations(): Animation[] {
  return document.getAnimations().filter((animation) => {
    const effect = animation.effect;
    if (!(effect instanceof KeyframeEffect)) return false;
    if (effect.target === null) return false;
    const timing = effect.getTiming();
    return (timing.iterations ?? 1) === Infinity;
  });
}

// ---------------------------------------------------------------------------
// The forcing probe ([D5], #forcing-probe)
// ---------------------------------------------------------------------------

/**
 * A per-frame inline transform write on one dot — the disqualifying form,
 * installed on purpose.
 *
 * [D5]: a green reading is unfalsifiable without a driver that lights the
 * walk. This is that driver, and it is exactly what [L13] forbids — which is
 * why it is installed only when `window.__tugTestMode === true`, exists to
 * *be* the counter-example, and ships on no path a user can reach.
 */
let forcingFrame: number | null = null;

function setForcing(on: boolean): { forcing: boolean } {
  if (!on) {
    if (forcingFrame !== null) {
      cancelAnimationFrame(forcingFrame);
      forcingFrame = null;
    }
    const target = document.querySelector<HTMLElement>(
      ".tug-progress-pulsing-dot-dot",
    );
    if (target !== null) target.style.transform = "";
    return { forcing: false };
  }
  if (forcingFrame !== null) return { forcing: true };
  const tick = (t: number): void => {
    const target = document.querySelector<HTMLElement>(
      ".tug-progress-pulsing-dot-dot",
    );
    if (target !== null) {
      // `scale()` alone: since the well split the figure's own pose space is
      // the scale and the centering translate lives on its well, so writing a
      // translate here would double it. What makes this the disqualifying
      // form is the per-frame inline style write, not the pose it writes.
      target.style.transform = `scale(${0.5 + 0.5 * Math.sin(t / 200)})`;
    }
    forcingFrame = requestAnimationFrame(tick);
  };
  forcingFrame = requestAnimationFrame(tick);
  return { forcing: true };
}

/**
 * One attribute write per frame on an element that animates nothing — what a
 * streaming transcript's React commit does to this page, in miniature.
 *
 * It is deliberately **not** {@link setForcing}. That driver writes an inline
 * `transform` on a dot, which is the disqualifying form: it demotes that one
 * animation to main-thread ticking, so the cost it lights is partly the cost
 * of having broken the thing under test. This one writes a `data-*` attribute
 * on a `<span>` with no animation and no transition on it. Nothing about the
 * dots changes; what changes is that style is dirty every frame, which is
 * what schedules a rendering update, and the compositing walk inside that
 * update is priced by every running transform animation on the page ([P06]).
 *
 * That is the whole point of having it. A quiet bench pays for no walks, so a
 * green render-cost reading on one says nothing about what the loops cost —
 * the dots do not cause the walks, they set the price of each one. The value
 * written is irrelevant and is never read; the commit is the instrument.
 */
let streamFrame: number | null = null;
let streamNode: HTMLElement | null = null;

function setStreaming(on: boolean): { streaming: boolean } {
  if (!on) {
    if (streamFrame !== null) {
      cancelAnimationFrame(streamFrame);
      streamFrame = null;
    }
    streamNode?.remove();
    streamNode = null;
    return { streaming: false };
  }
  if (streamFrame !== null) return { streaming: true };
  const node = document.createElement("span");
  // Off-screen and inert. It must not animate, must not transition, and must
  // not be something a layout pass has an opinion about — the reading is
  // supposed to be about the dots, not about this.
  node.setAttribute("data-tug-stream-node", "");
  node.style.cssText =
    "position:fixed;left:-1px;top:-1px;width:1px;height:1px;" +
    "opacity:0;pointer-events:none";
  document.body.appendChild(node);
  streamNode = node;
  let tick = 0;
  const step = (): void => {
    node.setAttribute("data-tug-stream-tick", String(++tick));
    streamFrame = requestAnimationFrame(step);
  };
  streamFrame = requestAnimationFrame(step);
  return { streaming: true };
}

// ---------------------------------------------------------------------------
// The object
// ---------------------------------------------------------------------------

export const tugMotion: TugMotionDiagnostics = {
  list(options) {
    return animationCensus(options);
  },

  pause(selector) {
    const animations = matching(selector);
    for (const animation of animations) animation.pause();
    return { paused: animations.length };
  },

  resume(selector) {
    const animations = matching(selector);
    for (const animation of animations) animation.play();
    return { resumed: animations.length };
  },

  async cost(frames = COST_FRAMES_DEFAULT) {
    const readings = await burst(frames);
    return {
      burst: readings,
      ...summarize(readings),
      samples: renderCostProbe.samples(),
    };
  },

  async bisect(options) {
    const frames = options?.frames ?? BISECT_FRAMES;
    const cap = options?.cap ?? BISECT_GROUP_CAP;

    const byName = new Map<string, Animation[]>();
    for (const animation of longRunningAnimations()) {
      const name = animationName(animation);
      const group = byName.get(name);
      if (group === undefined) byName.set(name, [animation]);
      else group.push(animation);
    }
    const names = Array.from(byName.keys()).slice(0, cap);

    const baselineP50 = summarize(await burst(frames)).p50;

    const groups: BisectGroupReading[] = [];
    for (const name of names) {
      const group = byName.get(name) ?? [];
      // A group already paused before the bisect began is put back exactly
      // as it was found; the reading is about what pausing changes, not a
      // licence to restart something somebody else stopped.
      const wasRunning = group.map((animation) => animation.playState === "running");
      for (const animation of group) animation.pause();
      const pausedP50 = summarize(await burst(frames)).p50;
      group.forEach((animation, i) => {
        if (wasRunning[i] === true) animation.play();
      });
      groups.push({
        name,
        count: group.length,
        pausedP50,
        drop: baselineP50 - pausedP50,
      });
    }
    groups.sort((a, b) => b.drop - a.drop);

    return {
      baselineP50,
      groups,
      groupsFound: byName.size,
      groupsRead: names.length,
    };
  },

  layers() {
    return layerTreeProbe();
  },

  input() {
    return inputLatency();
  },

  probe() {
    return {
      armed: renderCostProbe.armed,
      holds: motionHolds(),
      demoted: motionBreaker.demoted,
      latched: motionBreaker.latched,
      trips: motionBreaker.trips,
      budgetMs: motionBreaker.budgetMs,
      samples: renderCostProbe.samples(),
    };
  },

  demote(on) {
    motionBreaker.demote(on);
    return tugMotion.probe();
  },

  setBudget(ms) {
    motionBreaker.setBudget(ms);
    return tugMotion.probe();
  },

  chains(mode) {
    if (mode === "arm") return armGeometryChains();
    if (mode === "disarm") return disarmGeometryChains();
    return readGeometryChains();
  },

  reset() {
    motionBreaker.reset();
    renderCostProbe.clear();
    clearInputLatency();
  },
};

/**
 * Bind the handle. Called once from `installMotionGuard()`.
 *
 * The test-mode member is attached here rather than declared on the object so
 * a release bundle carries the property only when the harness has set
 * `__tugTestMode`.
 */
export function installMotionDiagnostics(): void {
  if (typeof window === "undefined") return;
  if (window.__tugTestMode === true) {
    tugMotion.__force = setForcing;
    tugMotion.__stream = setStreaming;
  }
  window.__tugMotion = tugMotion;
}
