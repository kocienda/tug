/**
 * Cancelling a TugAnimation that has already settled does nothing.
 *
 * The stand-in animation follows the two WAAPI rules that made a second
 * cancel harmful: `finish()` on an IDLE animation revives it at its end
 * (under its fill, applying again), and `commitStyles()` writes whatever the
 * property computes to now. On the live deck the settle's sweep snapped a
 * height beat that had already finished, and the revived fill held a rail's
 * last card short of the floor through every resize after it.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { animate } from "@/components/tugways/tug-animator";

// `animate()` reads `--tug-motion` inline and `--tug-timing` computed off the
// root element; motion on, timing 1. Restored by assignment, never `delete`.
const style = { getPropertyValue: (name: string) => (name === "--tug-motion" ? "1" : "") };
const saved = { document: globalThis.document, getComputedStyle: globalThis.getComputedStyle };
beforeAll(() => {
  globalThis.document = { documentElement: { style } } as unknown as Document;
  globalThis.getComputedStyle = (() => style) as unknown as typeof getComputedStyle;
});
afterAll(() => {
  globalThis.document = saved.document;
  globalThis.getComputedStyle = saved.getComputedStyle;
});

function standIn() {
  const calls: string[] = [];
  let settle!: () => void;
  const raw = {
    playState: "running" as AnimationPlayState,
    finished: new Promise<void>((res) => {
      settle = res;
    }),
    finish() {
      calls.push("finish");
      raw.playState = "finished";
    },
    cancel() {
      calls.push("cancel");
      raw.playState = "idle";
    },
    commitStyles() {
      calls.push("commitStyles");
    },
  };
  const el = { animate: () => raw } as unknown as Element;
  const runOut = async (): Promise<void> => {
    raw.playState = "finished";
    settle();
    await Promise.resolve();
    await Promise.resolve();
  };
  return { el, raw, calls, runOut };
}

const KEYFRAMES = [{ height: "938px" }, { height: "793px" }];

describe("cancelling a settled TugAnimation", () => {
  test("a finished effect is committed and cancelled once, and a snap afterwards revives nothing", async () => {
    const { el, raw, calls, runOut } = standIn();
    const anim = animate(el, KEYFRAMES, { duration: 240, fill: "both" });
    await runOut();
    expect(calls).toEqual(["commitStyles", "cancel"]);
    anim.cancel("snap-to-end");
    expect(calls).toEqual(["commitStyles", "cancel"]);
    expect(raw.playState).toBe("idle");
  });

  test("a hold on a settled effect commits nothing", async () => {
    const { el, calls, runOut } = standIn();
    const anim = animate(el, KEYFRAMES, { duration: 240, fill: "both" });
    await runOut();
    anim.cancel("hold-at-current");
    expect(calls).toEqual(["commitStyles", "cancel"]);
  });

  test("an effect cancelled mid-flight is not finished by a later snap", () => {
    const { el, raw, calls } = standIn();
    raw.finished.catch(() => {});
    const anim = animate(el, KEYFRAMES, { duration: 240, fill: "both" });
    anim.finished.catch(() => {});
    anim.cancel("hold-at-current");
    anim.cancel("snap-to-end");
    expect(calls).toEqual(["commitStyles", "cancel"]);
    expect(raw.playState).toBe("idle");
  });

  test("a running effect still snaps to its end", () => {
    const { el, calls } = standIn();
    const anim = animate(el, KEYFRAMES, { duration: 240, fill: "both" });
    anim.cancel("snap-to-end");
    expect(calls).toEqual(["finish"]);
  });
});
