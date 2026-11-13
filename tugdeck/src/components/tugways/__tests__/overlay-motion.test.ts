/**
 * The overlays' exit contract (`internal/overlay-motion.ts`): motion dresses
 * the close and never decides whether it happens.
 *
 * The hazard these pin is the one `tug-alert.css` records: an exit that waits
 * on an animation which never settles (a covered window suspends rAF, so
 * `finished` stays pending) keeps the surface up forever — and for a Radix
 * app-modal that holds `pointer-events: none` on `<body>`, a dead app. So the
 * close must come at the deadline when `finished` does not, exactly once, and
 * a surface re-opened mid-exit must not be closed by the exit it called off.
 *
 * The deadline's timer is captured rather than waited out, so nothing here
 * depends on how fast the machine is.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  OVERLAY_EXIT_DEADLINE_MARGIN_MS,
  alertPanelExitFrames,
  runOverlayExit,
} from "@/components/tugways/internal/overlay-motion";

// `animate()` reads `--tug-motion` inline and `--tug-timing` computed off the
// root element; motion on, timing 1. Restored by assignment, never `delete`.
const style = { getPropertyValue: (name: string) => (name === "--tug-motion" ? "1" : "") };

interface Timer {
  fn: () => void;
  ms: number;
  cleared: boolean;
}
let timers: Timer[] = [];

const saved = {
  document: globalThis.document,
  getComputedStyle: globalThis.getComputedStyle,
  setTimeout: globalThis.setTimeout,
  clearTimeout: globalThis.clearTimeout,
};
beforeAll(() => {
  globalThis.document = { documentElement: { style } } as unknown as Document;
  globalThis.getComputedStyle = (() => style) as unknown as typeof getComputedStyle;
  globalThis.setTimeout = ((fn: () => void, ms: number) => {
    const t: Timer = { fn, ms, cleared: false };
    timers.push(t);
    return t;
  }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = ((t: Timer | undefined) => {
    if (t !== undefined) t.cleared = true;
  }) as unknown as typeof clearTimeout;
});
afterAll(() => {
  globalThis.document = saved.document;
  globalThis.getComputedStyle = saved.getComputedStyle;
  globalThis.setTimeout = saved.setTimeout;
  globalThis.clearTimeout = saved.clearTimeout;
});
beforeEach(() => {
  timers = [];
});

/** An element whose `animate()` returns a WAAPI stand-in the test settles by hand. */
function standIn() {
  const attrs = new Map<string, string>();
  let settle!: () => void;
  const raw = {
    playState: "running" as AnimationPlayState,
    cancelled: false,
    finished: new Promise<void>((res) => {
      settle = res;
    }),
    finish() {
      raw.playState = "finished";
    },
    cancel() {
      raw.cancelled = true;
      raw.playState = "idle";
    },
    commitStyles() {},
  };
  const el = {
    animate: () => raw,
    setAttribute: (name: string, value: string) => attrs.set(name, value),
    removeAttribute: (name: string) => attrs.delete(name),
  } as unknown as Element;
  const runOut = async (): Promise<void> => {
    raw.playState = "finished";
    settle();
    for (let i = 0; i < 6; i++) await Promise.resolve();
  };
  return { el, raw, attrs, runOut };
}

const FADE = [{ opacity: 1 }, { opacity: 0 }];

describe("runOverlayExit", () => {
  test("the close comes when the exit finishes, once, and the deadline is stood down", async () => {
    const panel = standIn();
    let finished = 0;
    runOverlayExit({
      closing: [panel.el],
      tracks: [{ el: panel.el, frames: FADE, key: "panel" }],
      finish: () => finished++,
    });
    expect(panel.attrs.has("data-closing")).toBe(true);
    expect(finished).toBe(0);
    await panel.runOut();
    expect(finished).toBe(1);
    expect(timers).toHaveLength(1);
    expect(timers[0]!.cleared).toBe(true);
  });

  test("an exit whose animation never settles still closes, at the deadline", () => {
    const panel = standIn();
    let finished = 0;
    runOverlayExit({
      tracks: [{ el: panel.el, frames: FADE, key: "panel" }],
      finish: () => finished++,
    });
    // `moderate` is 200ms at timing 1; the deadline sits one margin past it.
    expect(timers).toHaveLength(1);
    expect(timers[0]!.ms).toBe(200 + OVERLAY_EXIT_DEADLINE_MARGIN_MS);
    timers[0]!.fn();
    expect(finished).toBe(1);
  });

  test("a finish after the deadline does not close twice", async () => {
    const panel = standIn();
    let finished = 0;
    runOverlayExit({
      tracks: [{ el: panel.el, frames: FADE, key: "panel" }],
      finish: () => finished++,
    });
    timers[0]!.fn();
    await panel.runOut();
    expect(finished).toBe(1);
  });

  test("the deadline waits for the longest track", () => {
    const panel = standIn();
    const scrim = standIn();
    runOverlayExit({
      duration: 100,
      tracks: [
        { el: panel.el, frames: FADE, key: "panel" },
        { el: scrim.el, frames: FADE, key: "scrim", duration: 300 },
      ],
      finish: () => {},
    });
    expect(timers[0]!.ms).toBe(300 + OVERLAY_EXIT_DEADLINE_MARGIN_MS);
  });

  test("a cancelled exit never closes, drops its effect uncommitted, and takes the closing mark off", async () => {
    const panel = standIn();
    let finished = 0;
    const exit = runOverlayExit({
      closing: [panel.el],
      tracks: [{ el: panel.el, frames: FADE, key: "panel" }],
      finish: () => finished++,
    });
    exit.cancel();
    expect(exit.settled).toBe(true);
    expect(panel.raw.cancelled).toBe(true);
    expect(panel.attrs.has("data-closing")).toBe(false);
    expect(timers[0]!.cleared).toBe(true);
    timers[0]!.fn();
    await panel.runOut();
    expect(finished).toBe(0);
  });

  test("with nothing to animate the close is immediate", () => {
    let finished = 0;
    const exit = runOverlayExit({
      tracks: [{ el: null, frames: FADE, key: "panel" }],
      finish: () => finished++,
    });
    expect(finished).toBe(1);
    expect(exit.settled).toBe(true);
    expect(timers).toHaveLength(0);
  });
});

describe("alertPanelExitFrames", () => {
  test("a centred alert leaves by scale-fade with its centring restated", () => {
    const frames = alertPanelExitFrames({ dataset: {} } as unknown as HTMLElement);
    expect(frames[0]!.transform).toBe("translate(-50%, -50%) scale(1)");
    expect(frames[1]!.transform).toBe("translate(-50%, -50%) scale(0.96)");
    expect(frames[1]!.opacity).toBe(0);
  });

  test("an alert on a card's rest line leaves by rise, back down the sheets' roll", () => {
    const frames = alertPanelExitFrames({
      dataset: { verticalAnchor: "rest-line" },
    } as unknown as HTMLElement);
    expect(frames[0]!.transform).toBe("translateX(-50%) translateY(0)");
    expect(frames[1]!.transform).toBe("translateX(-50%) translateY(28px)");
  });
});
