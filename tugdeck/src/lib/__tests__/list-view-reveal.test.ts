/**
 * list-view-reveal — the hidden-box cycle, driven end to end.
 *
 * A `display: none` scroller loses its scrollport: the browser resets
 * `scrollTop` to 0 and the component is never told. These tests stage
 * that cycle over a REAL `SmartScroll` — box loss, then reveal — and
 * assert the two things the user actually reported missing: the
 * position, and the follow-bottom intent behind it.
 *
 * The seam's other job at that moment is the in-flight wave: a subtree
 * with no box runs no animations, and the engine does not necessarily
 * replay them when the box returns.
 *
 * The geometry is stubbed because jsdom has no layout, and the animations
 * are stubbed because jsdom runs none — so what these prove about the
 * replay is the seam's choice of which animations to touch, not the
 * engine's replay, which the browser owns. Everything else is the
 * shipping code: the same `SmartScroll`, the same
 * `unattributed-scroll-up` rule, the same restore-target machinery. The
 * wiring that calls this seam from `TugListView`'s ResizeObserver has no
 * automated coverage: it is verified by hand, on the running app, by
 * folding and unfolding a Session card.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";

import { deckTrace } from "../../deck-trace";
import { SmartScroll } from "../smart-scroll";
import {
  createRevealSeam,
  replayLoopingAnimations,
  type VisibleScrollSample,
} from "../list-view-reveal";

const VIEWPORT = 200;
const CONTENT = 1000;
/** The bottom of a 1000px document in a 200px viewport. */
const AT_BOTTOM = CONTENT - VIEWPORT;

interface Rig {
  el: HTMLElement;
  smartScroll: SmartScroll;
  /** The last sample taken while the scroller had a box. */
  sample: VisibleScrollSample | null;
  top(): number;
  /** Move the scroller the way a user would, event and all. */
  userScrollTo(top: number): void;
  /** `display: none` — the scrollport is destroyed and the position with it. */
  loseBox(): void;
  /** The box comes back, at the top, exactly as the browser leaves it. */
  giveBox(): void;
  /** The reveal's own deferred scroll event, delivered late as it really is. */
  deliverDeferredScroll(): void;
  dispose(): void;
}

function makeRig(options?: { followBottom?: boolean }): Rig {
  const dom = new JSDOM("<!doctype html><div id='scroller'></div>");
  const win = dom.window as unknown as Window & typeof globalThis;
  const globals = globalThis as Record<string, unknown>;
  // Restored in `afterEach`. The DOM globals are process-wide under
  // `bun test`, so a rig that installs a jsdom window and walks away
  // hands every later file in the run a window it did not ask for.
  priorGlobals = {
    window: globals.window,
    document: globals.document,
    requestAnimationFrame: globals.requestAnimationFrame,
    cancelAnimationFrame: globals.cancelAnimationFrame,
  };
  globals.window = win;
  globals.document = win.document;
  globals.requestAnimationFrame = (cb: FrameRequestCallback): number =>
    setTimeout(() => cb(0), 0) as unknown as number;
  globals.cancelAnimationFrame = (id: number): void => {
    clearTimeout(id as unknown as ReturnType<typeof setTimeout>);
  };

  const el = win.document.getElementById("scroller") as HTMLElement;
  // A hidden element's box is gone, not zero-sized-but-present: every
  // geometry read answers 0, which is exactly what makes the position
  // unrecoverable from the live scroller.
  let hasBox = true;
  let top = 0;
  const clamp = (v: number): number =>
    hasBox ? Math.max(0, Math.min(v, CONTENT - VIEWPORT)) : 0;
  Object.defineProperty(el, "scrollHeight", { get: () => (hasBox ? CONTENT : 0) });
  Object.defineProperty(el, "clientHeight", { get: () => (hasBox ? VIEWPORT : 0) });
  Object.defineProperty(el, "clientWidth", { get: () => (hasBox ? 400 : 0) });
  Object.defineProperty(el, "offsetWidth", { get: () => (hasBox ? 400 : 0) });
  Object.defineProperty(el, "scrollTop", {
    get: () => top,
    set: (v: number) => {
      top = clamp(v);
    },
  });

  const smartScroll = new SmartScroll({
    scrollContainer: el,
    followBottom: options?.followBottom ?? false,
  });

  const rig: Rig = {
    el,
    smartScroll,
    sample: null,
    top: () => top,
    userScrollTo(next: number): void {
      top = clamp(next);
      el.dispatchEvent(new win.Event("scroll"));
    },
    loseBox(): void {
      // Sampled at the last moment it can be: the writer that keeps this
      // sample runs on commits, and commits stop when the box does.
      rig.sample = { top, following: smartScroll.isFollowingBottom };
      hasBox = false;
      top = 0;
    },
    giveBox(): void {
      hasBox = true;
    },
    deliverDeferredScroll(): void {
      el.dispatchEvent(new win.Event("scroll"));
    },
    dispose(): void {
      smartScroll.dispose();
    },
  };
  return rig;
}

let rig: Rig;
let priorGlobals: Record<string, unknown> | null = null;

beforeEach(() => {
  deckTrace.clear();
});

afterEach(() => {
  rig?.dispose();
  if (priorGlobals !== null) {
    const globals = globalThis as Record<string, unknown>;
    for (const [key, value] of Object.entries(priorGlobals)) {
      if (value === undefined) delete globals[key];
      else globals[key] = value;
    }
    priorGlobals = null;
  }
});

function seamFor(r: Rig, opts?: { resolver?: () => number | null }) {
  return createRevealSeam({
    getScroll: () => r.smartScroll,
    getLastVisible: () => r.sample,
    makeResolver: () => opts?.resolver ?? null,
  });
}

describe("the defect the seam exists to fix", () => {
  test("without the seam, a reveal strands the reader at the top with follow-bottom released", () => {
    rig = makeRig({ followBottom: true });
    rig.userScrollTo(AT_BOTTOM);
    expect(rig.smartScroll.isFollowingBottom).toBe(true);

    const mark = deckTrace.mark();
    rig.loseBox();
    rig.giveBox();
    rig.deliverDeferredScroll();

    // This is [F04] caught in the act rather than inferred: the reveal's
    // own event is read as the user scrolling up and away from the live
    // edge, by the one rule whose comment names the browser clamp as the
    // case it gets wrong without an attribution bracket.
    const flips = deckTrace
      .since(mark)
      .filter((e) => e.kind === "follow-bottom");
    expect(flips.map((e) => [e.following, e.source])).toEqual([
      [false, "unattributed-scroll-up"],
    ]);
    expect(rig.top()).toBe(0);
  });
});

describe("a reader who was following the live edge", () => {
  test("comes back at the bottom, still following", () => {
    rig = makeRig({ followBottom: true });
    rig.userScrollTo(AT_BOTTOM);

    const seam = seamFor(rig);
    rig.loseBox();
    seam.noteBoxLost();
    rig.giveBox();
    expect(seam.noteRevealed()).toBe("followed");

    expect(rig.top()).toBe(AT_BOTTOM);
    expect(rig.smartScroll.isFollowingBottom).toBe(true);
  });

  test("the reveal's deferred event does not undo the restore", () => {
    rig = makeRig({ followBottom: true });
    rig.userScrollTo(AT_BOTTOM);

    const seam = seamFor(rig);
    rig.loseBox();
    seam.noteBoxLost();
    rig.giveBox();
    seam.noteRevealed();

    const mark = deckTrace.mark();
    rig.deliverDeferredScroll();

    // The bracket's whole job. `noteExternalWrite` synced the baseline to
    // the restored position, so the late event carries no upward delta
    // and never reaches the disengage rule.
    expect(
      deckTrace.since(mark).filter((e) => e.kind === "follow-bottom"),
    ).toEqual([]);
    expect(rig.smartScroll.isFollowingBottom).toBe(true);
    expect(rig.top()).toBe(AT_BOTTOM);
  });
});

describe("a reader parked in history", () => {
  test("comes back where they were, not following", () => {
    rig = makeRig({ followBottom: true });
    rig.userScrollTo(AT_BOTTOM);
    rig.userScrollTo(320);
    expect(rig.smartScroll.isFollowingBottom).toBe(false);

    const seam = seamFor(rig);
    rig.loseBox();
    seam.noteBoxLost();
    rig.giveBox();
    expect(seam.noteRevealed()).toBe("positioned");

    expect(rig.top()).toBe(320);
    expect(rig.smartScroll.isFollowingBottom).toBe(false);
  });

  test("an anchor resolver is preferred over the remembered pixel offset", () => {
    // The case the anchor exists for: cells above the reader re-measured
    // while the box was gone, so the position they were reading is no
    // longer the pixel offset it was saved at.
    rig = makeRig({ followBottom: true });
    rig.userScrollTo(AT_BOTTOM);
    rig.userScrollTo(320);

    const seam = seamFor(rig, { resolver: () => 480 });
    rig.loseBox();
    seam.noteBoxLost();
    rig.giveBox();
    expect(seam.noteRevealed()).toBe("anchored");

    expect(rig.top()).toBe(480);
    expect(rig.smartScroll.isFollowingBottom).toBe(false);
  });

  test("the restore keeps landing as revealed cells settle", () => {
    rig = makeRig({ followBottom: true });
    rig.userScrollTo(AT_BOTTOM);
    rig.userScrollTo(320);

    let resolved = 320;
    const seam = seamFor(rig, { resolver: () => resolved });
    rig.loseBox();
    seam.noteBoxLost();
    rig.giveBox();
    seam.noteRevealed();

    // The list view's per-commit heartbeat, with the anchor resolving
    // further down as the cells above it re-measure taller.
    resolved = 560;
    rig.smartScroll.applyRestoreTarget();
    expect(rig.top()).toBe(560);
  });
});

describe("what the seam declines to do", () => {
  test("a reveal with nothing remembered writes nothing", () => {
    rig = makeRig({ followBottom: false });
    rig.userScrollTo(320);

    const seam = seamFor(rig);
    expect(seam.noteRevealed()).toBe("none");
    expect(rig.top()).toBe(320);
  });

  test("a second zero-box delivery does not overwrite the memo", () => {
    // A pane resized behind a folded card fires the observer again. The
    // sample source stopped updating at the fold, so a re-read is at best
    // the same value — and the seam must not take a worse one.
    rig = makeRig({ followBottom: false });
    rig.userScrollTo(320);

    const seam = seamFor(rig);
    rig.loseBox();
    seam.noteBoxLost();
    rig.sample = { top: 0, following: false };
    seam.noteBoxLost();

    expect(seam.pending).toEqual({ top: 320, following: false });
    rig.giveBox();
    seam.noteRevealed();
    expect(rig.top()).toBe(320);
  });

  test("the memo is consumed once — a later resize is not a second reveal", () => {
    rig = makeRig({ followBottom: true });
    rig.userScrollTo(AT_BOTTOM);

    const seam = seamFor(rig);
    rig.loseBox();
    seam.noteBoxLost();
    rig.giveBox();
    seam.noteRevealed();
    expect(seam.pending).toBeNull();

    rig.userScrollTo(120);
    expect(seam.noteRevealed()).toBe("none");
    expect(rig.top()).toBe(120);
  });

  test("`forget` drops a memo without applying it", () => {
    rig = makeRig({ followBottom: false });
    rig.userScrollTo(320);

    const seam = seamFor(rig);
    rig.loseBox();
    seam.noteBoxLost();
    seam.forget();
    rig.giveBox();

    expect(seam.noteRevealed()).toBe("none");
    expect(rig.top()).toBe(0);
  });

  test("`forget` leaves the hidden state standing", () => {
    // A data source swapped behind a fold spoils the position and
    // nothing else. The reveal still has to happen — the loops that went
    // dark with the box are stuck whatever list they belong to now.
    rig = makeRig({ followBottom: false });
    rig.userScrollTo(320);
    const wave = {
      calls: [] as string[],
      effect: { getTiming: () => ({ iterations: Number.POSITIVE_INFINITY }) },
      cancel(): void {
        wave.calls.push("cancel");
      },
      play(): void {
        wave.calls.push("play");
      },
    };
    const seam = createRevealSeam({
      getScroll: () => rig.smartScroll,
      getRevealRoot: () => ({ getAnimations: () => [wave] }) as unknown as Element,
      getLastVisible: () => rig.sample,
    });

    rig.loseBox();
    seam.noteBoxLost();
    seam.forget();
    expect(seam.isHidden).toBe(true);

    rig.giveBox();
    expect(seam.noteRevealed()).toBe("none");
    expect(wave.calls).toEqual(["cancel", "play"]);
  });
});

describe("the wave that comes back motionless", () => {
  /**
   * A stand-in for the engine's `Animation`. jsdom runs no animations, so
   * what is under test is the seam's *choice* — which animations it
   * replays and which it leaves alone — not the engine's replay itself,
   * which the browser owns.
   */
  function fakeAnimation(iterations: number) {
    const calls: string[] = [];
    return {
      calls,
      effect: { getTiming: () => ({ iterations }) },
      cancel(): void {
        calls.push("cancel");
      },
      play(): void {
        calls.push("play");
      },
    };
  }

  function rootWith(...animations: ReturnType<typeof fakeAnimation>[]) {
    return {
      getAnimations: () => animations,
    } as unknown as Element;
  }

  test("a looping animation is cancelled and played", () => {
    const loop = fakeAnimation(Number.POSITIVE_INFINITY);
    expect(replayLoopingAnimations(rootWith(loop))).toBe(1);
    expect(loop.calls).toEqual(["cancel", "play"]);
  });

  test("a finite animation is left alone", () => {
    // It either finished while the box was gone — replaying it would show
    // a completion the user already missed — or somebody else owns it.
    const oneShot = fakeAnimation(1);
    expect(replayLoopingAnimations(rootWith(oneShot))).toBe(0);
    expect(oneShot.calls).toEqual([]);
  });

  test("an engine that cannot enumerate animations is not an error", () => {
    expect(replayLoopingAnimations({} as unknown as Element)).toBe(0);
    expect(replayLoopingAnimations(null)).toBe(0);
  });

  test("the reveal replays the transcript's loops", () => {
    rig = makeRig({ followBottom: true });
    rig.userScrollTo(AT_BOTTOM);
    const wave = fakeAnimation(Number.POSITIVE_INFINITY);
    const seam = createRevealSeam({
      getScroll: () => rig.smartScroll,
      getRevealRoot: () => rootWith(wave),
      getLastVisible: () => rig.sample,
    });

    rig.loseBox();
    seam.noteBoxLost();
    rig.giveBox();
    seam.noteRevealed();

    expect(wave.calls).toEqual(["cancel", "play"]);
  });

  test("a resize that is not a reveal replays nothing", () => {
    // Every card resize and pane drag reaches the same observer. A
    // transcript whose glyphs restarted on each one would stutter for a
    // reason the user could not see.
    rig = makeRig({ followBottom: true });
    const wave = fakeAnimation(Number.POSITIVE_INFINITY);
    const seam = createRevealSeam({
      getScroll: () => rig.smartScroll,
      getRevealRoot: () => rootWith(wave),
      getLastVisible: () => rig.sample,
    });

    expect(seam.isHidden).toBe(false);
    expect(seam.noteRevealed()).toBe("none");
    expect(wave.calls).toEqual([]);
  });

  test("a fold with no position to remember still replays the loops", () => {
    // A card folded before its transcript ever committed has no sample,
    // so there is no position to put back — the wave is still stuck, and
    // the two repairs are independent.
    rig = makeRig({ followBottom: true });
    const wave = fakeAnimation(Number.POSITIVE_INFINITY);
    const seam = createRevealSeam({
      getScroll: () => rig.smartScroll,
      getRevealRoot: () => rootWith(wave),
      getLastVisible: () => null,
    });

    seam.noteBoxLost();
    expect(seam.isHidden).toBe(true);
    expect(seam.noteRevealed()).toBe("none");
    expect(wave.calls).toEqual(["cancel", "play"]);
  });
});
