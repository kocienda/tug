/**
 * space-layer-loops.test.ts — nothing loops in the dark, and nothing else is
 * touched.
 *
 * The rule is pure over an animation's timing, its element's layer, and what
 * CSS says about its play state, so it is tested here over fakes; the canvas
 * hands it `root.getAnimations({ subtree: true })` and a real
 * `getComputedStyle`, and `at0641` is where that wiring is proved on the live
 * deck.
 */

import { describe, expect, test } from "bun:test";

import {
  isLoop,
  layerStateOf,
  reconcileLoop,
  stillLoops,
  type LoopLike,
} from "@/components/chrome/space-layer-loops";

interface FakeLayer {
  shown: boolean;
}

/** An element that knows which layer it is in, and nothing else. */
function elementIn(layer: FakeLayer | null): Element {
  const layerEl =
    layer === null
      ? null
      : ({ hasAttribute: () => layer.shown } as unknown as Element);
  return { closest: () => layerEl } as unknown as Element;
}

interface FakeLoop extends LoopLike {
  playState: AnimationPlayState;
  log: string[];
}

function animation(
  target: Element | null,
  iterations: number,
  playState: AnimationPlayState = "running",
): FakeLoop {
  const log: string[] = [];
  const fake: FakeLoop = {
    playState,
    log,
    effect:
      target === null
        ? null
        : ({
            target,
            getTiming: () => ({ iterations }),
          } as unknown as AnimationEffect),
    pause() {
      this.playState = "paused";
      log.push("pause");
    },
    play() {
      this.playState = "running";
      log.push("play");
    },
  };
  return fake;
}

const never = (): boolean => false;
const always = (): boolean => true;

describe("layerStateOf", () => {
  test("hidden, shown, and outside every layer", () => {
    expect(layerStateOf(elementIn({ shown: false }))).toBe("hidden");
    expect(layerStateOf(elementIn({ shown: true }))).toBe("shown");
    expect(layerStateOf(elementIn(null))).toBe("none");
  });
});

describe("isLoop", () => {
  test("only an infinite iteration count is a loop", () => {
    const el = elementIn({ shown: false });
    expect(isLoop(animation(el, Infinity))).toBe(true);
    expect(isLoop(animation(el, 1))).toBe(false);
    expect(isLoop(animation(el, 3))).toBe(false);
    expect(isLoop(animation(null, Infinity))).toBe(false);
  });
});

describe("reconcileLoop", () => {
  test("a running loop under a hidden layer is paused", () => {
    const a = animation(elementIn({ shown: false }), Infinity);
    expect(reconcileLoop(a, "hidden", never)).toBe("stilled");
    expect(a.log).toEqual(["pause"]);
  });

  test("a finite animation under a hidden layer is left to run out", () => {
    // A settle's tween or an entrance: somebody is awaiting its `finished`
    // promise, and a paused one never resolves it.
    const a = animation(elementIn({ shown: false }), 1);
    expect(reconcileLoop(a, "hidden", never)).toBe("left");
    expect(a.log).toEqual([]);
  });

  test("a loop already paused by somebody else is left alone, and never resumed by us", () => {
    const a = animation(elementIn({ shown: false }), Infinity, "paused");
    expect(reconcileLoop(a, "hidden", never)).toBe("left");
    // Its layer is shown again: we did not pause it, so we do not play it.
    expect(reconcileLoop(a, "shown", never)).toBe("left");
    expect(a.log).toEqual([]);
  });

  test("a loop we stilled is resumed when its layer is shown", () => {
    const a = animation(elementIn({ shown: false }), Infinity);
    reconcileLoop(a, "hidden", never);
    expect(reconcileLoop(a, "shown", never)).toBe("resumed");
    expect(a.log).toEqual(["pause", "play"]);
    // And only once: the set forgets it on the resume.
    expect(reconcileLoop(a, "shown", never)).toBe("left");
  });

  test("a resume is declined while CSS holds the loop paused, and retried after", () => {
    // The breaker's demotion outranks the layer's hold, so the resume is
    // declined — but the record stays, because this module is the only thing
    // that can ever hand the loop back. The pause was taken through the API,
    // which outranks `animation-play-state`, so the breaker recovering does
    // not resume it; a loop dropped here would be paused for good.
    const a = animation(elementIn({ shown: false }), Infinity);
    reconcileLoop(a, "hidden", never);
    expect(reconcileLoop(a, "shown", always)).toBe("left");
    expect(a.log).toEqual(["pause"]);
    expect(reconcileLoop(a, "shown", never)).toBe("resumed");
    expect(a.log).toEqual(["pause", "play"]);
  });

  test("a loop outside every layer is never touched", () => {
    const a = animation(elementIn(null), Infinity);
    expect(reconcileLoop(a, "none", never)).toBe("left");
    expect(a.log).toEqual([]);
  });
});

describe("stillLoops", () => {
  test("one pass: hidden loops paused, our shown ones resumed, the rest left", () => {
    const hidden: FakeLayer = { shown: false };
    const shown: FakeLayer = { shown: true };
    const hiddenLoop = animation(elementIn(hidden), Infinity);
    const hiddenFinite = animation(elementIn(hidden), 1);
    const shownLoop = animation(elementIn(shown), Infinity);
    const outside = animation(elementIn(null), Infinity);
    const noTarget = animation(null, Infinity);

    const first = stillLoops(
      [hiddenLoop, hiddenFinite, shownLoop, outside, noTarget],
      never,
    );
    expect(first).toEqual({ stilled: 1, resumed: 0 });
    expect(hiddenLoop.log).toEqual(["pause"]);
    expect(hiddenFinite.log).toEqual([]);
    expect(shownLoop.log).toEqual([]);
    expect(outside.log).toEqual([]);

    // The switch: the hidden layer is shown and the shown one hidden.
    hidden.shown = true;
    shown.shown = false;
    const second = stillLoops(
      [hiddenLoop, hiddenFinite, shownLoop, outside, noTarget],
      never,
    );
    expect(second).toEqual({ stilled: 1, resumed: 1 });
    expect(hiddenLoop.log).toEqual(["pause", "play"]);
    expect(shownLoop.log).toEqual(["pause"]);
    expect(outside.log).toEqual([]);
  });
});
