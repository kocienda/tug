/**
 * land-by-deadline.test.ts — a commit parked on an animation lands exactly
 * once, however the animation ends, and lands even if it never ticks.
 */

import { describe, expect, test } from "bun:test";

import { landByDeadline, type LandCause } from "../land-by-deadline";

/** A `finished` the test settles by hand, or never. */
function pending(): {
  finished: Promise<void>;
  resolve: () => void;
  reject: () => void;
} {
  let resolve!: () => void;
  let reject!: () => void;
  const finished = new Promise<void>((res, rej) => {
    resolve = res;
    reject = () => rej(new Error("cancelled"));
  });
  return { finished, resolve, reject };
}

const wait = (ms: number): Promise<void> =>
  new Promise((res) => setTimeout(res, ms));

describe("landByDeadline", () => {
  test("lands once when the animation finishes", async () => {
    const anim = pending();
    const causes: LandCause[] = [];
    landByDeadline(anim.finished, 30, (c) => causes.push(c));
    anim.resolve();
    await wait(60);
    expect(causes).toEqual(["finished"]);
  });

  test("lands once when the animation is cancelled", async () => {
    const anim = pending();
    const causes: LandCause[] = [];
    landByDeadline(anim.finished, 30, (c) => causes.push(c));
    anim.reject();
    await wait(60);
    expect(causes).toEqual(["cancelled"]);
  });

  test("lands at the deadline when the animation never ticks", async () => {
    const anim = pending();
    const causes: LandCause[] = [];
    landByDeadline(anim.finished, 20, (c) => causes.push(c));
    await wait(5);
    expect(causes).toEqual([]);
    await wait(40);
    expect(causes).toEqual(["deadline"]);
    // A frame that arrives after the deadline lands nothing twice.
    anim.resolve();
    await wait(5);
    expect(causes).toEqual(["deadline"]);
  });

  test("lands at once when the owner asks, and never again", async () => {
    const anim = pending();
    const causes: LandCause[] = [];
    const landNow = landByDeadline(anim.finished, 20, (c) => causes.push(c));
    landNow();
    landNow();
    expect(causes).toEqual(["now"]);
    anim.reject();
    await wait(40);
    expect(causes).toEqual(["now"]);
  });
});
