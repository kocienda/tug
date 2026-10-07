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
 * `pause` and `demote` mutate. The only door to them on a release
 * build is `POST /api/eval`, which is loopback-only and gated on dev mode or
 * the per-instance `diag/eval` opt-in; with the inspector off there is no
 * other caller. `tugtool deck motion` is the shell end of that door ([P05]).
 *
 * ## What it is for
 *
 * `bisect()` is the one that settles an incident. It reads **additively**:
 * every long-running animation on the page is paused first, the floor is
 * measured, and then one family at a time is woken, measured alone, and put
 * back to sleep. A family's price is what the frame costs with only that
 * family running, above the floor — the one reading that two loops dirtying
 * the same style on the same frame cannot hide, which is what the old
 * one-group-at-a-time subtraction did: pausing a dot's breath left its ring
 * dirtying the same box, so the drop read 0.00 for a family that cost 10 ms.
 *
 * A **family** is every animation sharing a figure — the target element, or
 * the ancestor that owns it. Figures are found by name rather than declared:
 * the deck's glyphs are BEM-shaped (`tug-progress-pulsing-dot` above
 * `tug-progress-pulsing-dot-dot-well` above `tug-progress-pulsing-dot-dot`),
 * so the figure root is the highest ancestor whose class shares a stem with
 * the target's, and a loop whose ancestors share nothing is its own figure.
 * Families are then split by **placement** — on screen or scrolled out of
 * view, per an `IntersectionObserver` — because that is the line the cost
 * runs along on this WebKit: an off-screen dot is not compositor-resident
 * and an on-screen one costs nothing measurable.
 *
 * Every pause and every resume of a family happens in one synchronous turn
 * over the whole family, so a figure's loops keep their weld: paused in one
 * task they hold the same phase, and played in one task they resume on the
 * same start time. The old verb paused one loop group for a second while its
 * siblings ran, and the dot and its ring came back out of phase.
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
import {
  offscreenPauseEnabled,
  offscreenPaused,
  offscreenWatched,
  setOffscreenPause,
} from "./offscreen";
import { liveMarks, type LiveMarksReading } from "./one-live-mark";
import { motionBreaker } from "./breaker";
import { adoptRecordFlagAtLoad, recordSwitch, type RecordReading } from "./record-switch";
import { settleVerdictOfDrive, type SettleEngineRows, type SettleVerdict } from "./settle-bar";
import { SHOWN_PANE_FRAMES } from "@/components/chrome/space-layer";
import {
  burst,
  renderCostProbe,
  sampleRest,
  summarize,
  type RenderCostSample,
  type RenderCostSummary,
  type RestReading,
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
import {
  armGestureFrames,
  disarmGestureFrames,
  readGestureFrames,
  type GestureFrameArmReading,
  type GestureFrameReading,
} from "./gesture-frame-probe";

/** Frames per reading in {@link TugMotionDiagnostics.cost}. */
export const COST_FRAMES_DEFAULT = 30;

/** Frames per family in {@link TugMotionDiagnostics.bisect}. */
export const BISECT_FRAMES = 20;

/**
 * Frames a bisect lets pass after every pause and play before it reads.
 *
 * `play()` on a paused animation runs it on the main thread until WebKit
 * re-accelerates it on a later rendering update, and a burst taken across
 * that transition prices the resume rather than the family: on the release
 * deck every family alone read a flat 5 ms above a 1 ms floor until the
 * settle was added. The same holds for the floor after the big pause.
 */
export const BISECT_SETTLE_FRAMES = 10;

/**
 * How many loop groups one `bisect()` reads.
 *
 * `eval_handler` on tugcast gives a call 30 seconds. The cost is
 * `families × (settle + frames) × frame-time`, and a saturated deck paints at
 * 15 fps, so 30 frames a family is ~2 s there. Eight families is ~16 s at
 * that rate, with room for the baseline and the floor. A deck with more
 * families truncates and says how many it read, rather than timing out with
 * nothing.
 */
export const BISECT_GROUP_CAP = 8;

export interface RenderCostReading extends RenderCostSummary {
  /** The frames just taken, in order. */
  burst: number[];
  /** The at-rest reading taken right after the burst. */
  rest: RestReading;
  /** What the armed probe has been recording in the background. */
  samples: RenderCostSample[];
}

/** Where a family's figures sit relative to the viewport and their clips. */
export type BisectPlacement = "on-screen" | "off-screen";

export interface BisectGroupReading {
  /** The family: the figure root's stem class, or the target's. */
  name: string;
  placement: BisectPlacement;
  /** How many animations the family runs. */
  count: number;
  /** How many figures those animations belong to. */
  figures: number;
  /** p50 render cost with only this family running. */
  aloneP50: number;
  /** {@link BisectGroupReading.aloneP50} above the floor. Bigger is guiltier. */
  price: number;
}

export interface BisectReading {
  /** p50 render cost with everything running, as the deck was found. */
  baselineP50: number;
  /** p50 render cost with every long-running loop paused. */
  floorP50: number;
  /** One row per family, sorted by price, guiltiest first. */
  groups: BisectGroupReading[];
  /** How many families the deck had, and how many this call read. */
  groupsFound: number;
  groupsRead: number;
}

export interface ProbeReading {
  armed: boolean;
  holds: number;
  demoted: boolean;
  /**
   * The calibrated per-frame render-cost reference, in milliseconds. Nothing
   * acts on it: a reading over it is a fact for whoever is reading.
   *
   * Read rather than hard-coded by anything that asserts against it, so the
   * calibrated number lands in one place.
   */
  budgetMs: number;
  /** The at-rest reference, in updates per second; read for the same reason. */
  restBudgetPerSecond: number;
  samples: RenderCostSample[];
}

export interface OffscreenReading {
  /** Whether the rule is in force. */
  enabled: boolean;
  /** Figures registered with the observer. */
  watched: number;
  /** Of those, the ones out of view and stilled right now. */
  paused: number;
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
  /** Watch the main thread for `windowMs` and count the updates over the floor. */
  rest(windowMs?: number): Promise<RestReading>;
  /** Pause everything, wake one family at a time, and price each alone. */
  bisect(options?: { frames?: number; cap?: number }): Promise<BisectReading>;
  /** The population the compositing walk pays for ([F04]). */
  layers(): LayerTreeProbe;
  /** Input-to-next-paint, where the engine reports it ([P08]). */
  input(): InputLatencyReading;
  /** What the probe is doing right now. */
  probe(): ProbeReading;
  /** Still every long-running loop, or let them run again ([P06]). The only writer. */
  demote(on: boolean): ProbeReading;
  /**
   * The record switch (`record-switch.ts`): turn the motion instruments on or
   * off, or with no argument report where they stand. MUTATES, so it has the
   * same standing as `demote` — reached only through the gated eval door or
   * the Session card's `/motion-record`.
   */
  record(on?: boolean): RecordReading;
  /**
   * The off-screen rule: how many figures are watched and how many are out of
   * view and stilled. With an argument, turn the rule off or on — diagnostics
   * only, so a bench can read one population both ways.
   */
  offscreen(on?: boolean): OffscreenReading;
  /** The one-live-mark rule: groups, members, and how many are understudies. */
  liveMarks(): LiveMarksReading;
  /**
   * The read→write→read chains under a gesture ([P03], Spec S04).
   *
   * `arm` and `disarm` MUTATE — they replace platform property descriptors —
   * so this member has the same standing as `pause` and `demote`:
   * the only door to it on a release build is the loopback eval endpoint, gated
   * on dev mode or the per-instance `diag/eval` opt-in. Nothing arms it on load,
   * and an armed probe is paying a stack capture per geometry read, so it is
   * armed around the gesture under study and disarmed after.
   * `{ stacks: false }` arms it without the capture, for a reading whose
   * milliseconds must not carry the probe's own price.
   */
  chains(
    mode: "arm" | "read" | "disarm",
    options?: { readonly stacks?: boolean },
  ): ChainArmReading | GeometryChainReading;
  /**
   * The frames a gesture actually delivered, recorded from OUTSIDE it
   * ([P03], Spec S02).
   *
   * Armed from the shell before the gesture, so the chain is already ticking
   * when the gesture lands and the dead time is a gap inside the series rather
   * than in front of it — which is the one thing the in-product `settle-frames`
   * record cannot be: it opens when the canvas arms, already past the
   * gesture's own preamble.
   *
   * It reads no DOM. A chain left armed is a loop at rest, which [D1] forbids,
   * so it stops itself after `ms` whether or not anybody reads it.
   */
  gesture(
    mode: "arm" | "read" | "disarm",
    ms?: number,
  ): GestureFrameArmReading | GestureFrameReading;
  /**
   * The settle bar over a drive's own rows (`settle-bar.ts`) — the same
   * clauses the app-tests assert, so `tugtool deck motion settle` prints the
   * verdict the page computed rather than keeping a copy of the bar. Pure: it
   * reads the rows it is handed and nothing else.
   */
  settleVerdict(
    engine: SettleEngineRows,
    gesture?: string,
    args?: { readonly open?: unknown } | null,
  ): SettleVerdict | null;
  /**
   * Every shown pane frame, id and rounded rect (`id@x,y+WxH`), as one string
   * — the band the settle bar's `arrivedIn` and `bandShrinks` read. Taken over
   * the product's own `SHOWN_PANE_FRAMES`, so a parked rail member or a
   * departing frame is not standing, exactly as the app-tests' census has it.
   * A verb that read every pane in the layer instead would see a rail's
   * frames as standing before the show that brings them in, and never earn
   * the arrived exemption.
   */
  settleBand(): string;
  /** Clear the probe's samples and the input ring, and throw the switch back. */
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
// Figures and families, for `bisect`
// ---------------------------------------------------------------------------

/** Whether class `stem` is a BEM stem of class `name`: `name` is `stem-…`. */
function isStemOf(stem: string, name: string): boolean {
  return name.length > stem.length && name.startsWith(`${stem}-`);
}

/**
 * The figure an animation's target belongs to.
 *
 * Climbs while the ancestor's classes share a stem with the target's in
 * either direction — `…-dot` under `…-dot-well` under `…-dot` — and stops at
 * the first ancestor that shares nothing. A target whose parent shares
 * nothing is its own figure.
 */
export function figureRootOf(target: Element): Element {
  const names = Array.from(target.classList);
  let root = target;
  let node = target.parentElement;
  while (node !== null && node !== document.body) {
    const classes = Array.from(node.classList);
    const owns = classes.some((c) =>
      names.some((n) => isStemOf(c, n) || isStemOf(n, c)),
    );
    if (!owns) break;
    root = node;
    node = node.parentElement;
  }
  return root;
}

/**
 * The family a figure belongs to: its shortest class that is a stem of one
 * of the loop target's classes, else its own class, else its tag. A `tug-`
 * class wins over a library's — the caret layer is `cm-layer` to CodeMirror
 * and `tug-text-editor-caret-layer` to the deck, and the deck's name is the
 * one a reader can find.
 */
export function familyNameOf(root: Element, target: Element): string {
  const names = Array.from(target.classList);
  const rank = (c: string): number => (c.startsWith("tug") ? 0 : 1);
  const own = Array.from(root.classList).sort(
    (a, b) => rank(a) - rank(b) || a.length - b.length,
  );
  const stems = own.filter((c) => names.some((n) => isStemOf(c, n)));
  if (stems.length > 0) return stems[0]!;
  return own.length > 0 ? own[0]! : root.tagName.toLowerCase();
}

/**
 * Which of `elements` intersect the viewport through every clip on the way,
 * read once through an `IntersectionObserver` — the one platform reading
 * that accounts for a scroller's clip without a `getComputedStyle` walk per
 * element.
 */
function onScreen(elements: readonly Element[]): Promise<Set<Element>> {
  return new Promise((resolve) => {
    if (elements.length === 0) {
      resolve(new Set());
      return;
    }
    const visible = new Set<Element>();
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) visible.add(entry.target);
      }
      observer.disconnect();
      resolve(visible);
    });
    for (const element of elements) observer.observe(element);
  });
}

interface Family {
  name: string;
  placement: BisectPlacement;
  animations: Animation[];
  figures: Set<Element>;
}

/** Group the long-running animations into families, by figure and placement. */
async function familiesOf(animations: readonly Animation[]): Promise<Family[]> {
  const rootOf = new Map<Animation, Element>();
  for (const animation of animations) {
    const target = targetOf(animation);
    if (target !== null) rootOf.set(animation, figureRootOf(target));
  }
  const visible = await onScreen(Array.from(new Set(rootOf.values())));
  const families = new Map<string, Family>();
  for (const animation of animations) {
    const root = rootOf.get(animation);
    const target = targetOf(animation);
    if (root === undefined || target === null) continue;
    const name = familyNameOf(root, target);
    const placement: BisectPlacement = visible.has(root) ? "on-screen" : "off-screen";
    const key = `${name} ${placement}`;
    let family = families.get(key);
    if (family === undefined) {
      family = { name, placement, animations: [], figures: new Set() };
      families.set(key, family);
    }
    family.animations.push(animation);
    family.figures.add(root);
  }
  return Array.from(families.values());
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
    // After the burst, never during it: the burst's own rAF pairs would read
    // as stalls in the chain.
    const rest = await sampleRest();
    return {
      burst: readings,
      ...summarize(readings),
      rest,
      samples: renderCostProbe.samples(),
    };
  },

  rest(windowMs) {
    return sampleRest(windowMs);
  },

  async bisect(options) {
    const frames = options?.frames ?? BISECT_FRAMES;
    const cap = options?.cap ?? BISECT_GROUP_CAP;

    const all = longRunningAnimations();
    // An animation already paused before the bisect began is put back
    // exactly as it was found; the reading is about what running costs,
    // not a licence to restart something somebody else stopped.
    const running = all.filter((animation) => animation.playState === "running");
    const families = (await familiesOf(running)).sort(
      (a, b) => b.animations.length - a.animations.length,
    );
    const read = families.slice(0, cap);

    const baselineP50 = summarize(await burst(frames)).p50;

    // Everything down in one turn, so every figure's loops hold one phase.
    for (const animation of running) animation.pause();
    await burst(BISECT_SETTLE_FRAMES);
    const floorP50 = summarize(await burst(frames)).p50;

    const groups: BisectGroupReading[] = [];
    for (const family of read) {
      // Up in one turn, down in one turn: a figure's loops resume on one
      // start time and pause on one phase, and the weld survives.
      for (const animation of family.animations) animation.play();
      await burst(BISECT_SETTLE_FRAMES);
      const aloneP50 = summarize(await burst(frames)).p50;
      for (const animation of family.animations) animation.pause();
      groups.push({
        name: family.name,
        placement: family.placement,
        count: family.animations.length,
        figures: family.figures.size,
        aloneP50,
        price: aloneP50 - floorP50,
      });
    }

    for (const animation of running) animation.play();
    groups.sort((a, b) => b.price - a.price);

    return {
      baselineP50,
      floorP50,
      groups,
      groupsFound: families.length,
      groupsRead: read.length,
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
      budgetMs: motionBreaker.budgetMs,
      restBudgetPerSecond: motionBreaker.restBudgetPerSecond,
      samples: renderCostProbe.samples(),
    };
  },

  demote(on) {
    motionBreaker.demote(on);
    return tugMotion.probe();
  },

  record(on) {
    return recordSwitch(on);
  },

  offscreen(on) {
    if (on !== undefined) setOffscreenPause(on);
    return {
      enabled: offscreenPauseEnabled(),
      watched: offscreenWatched(),
      paused: offscreenPaused(),
    };
  },

  liveMarks() {
    return liveMarks();
  },

  chains(mode, options) {
    if (mode === "arm") return armGeometryChains(options);
    if (mode === "disarm") return disarmGeometryChains();
    return readGeometryChains();
  },

  gesture(mode, ms) {
    if (mode === "arm") return armGestureFrames(ms);
    if (mode === "disarm") return disarmGestureFrames();
    return readGestureFrames();
  },

  settleVerdict(engine, gesture, args) {
    return settleVerdictOfDrive(engine, gesture, args);
  },

  settleBand() {
    return Array.from(document.querySelectorAll(SHOWN_PANE_FRAMES), (el) => {
      const r = el.getBoundingClientRect();
      return (
        `${el.getAttribute("data-pane-id")}@${Math.round(r.left)},${Math.round(r.top)}` +
        `+${Math.round(r.width)}x${Math.round(r.height)}`
      );
    }).join(" ");
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
  adoptRecordFlagAtLoad();
}
