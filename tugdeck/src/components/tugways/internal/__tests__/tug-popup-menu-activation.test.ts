/**
 * tug-popup-menu-activation.test.ts — the two `onSelect` timings a
 * TugPopupMenu item pick can take against its confirmation blink.
 *
 * The blink is a promise this test resolves or rejects by hand, so each
 * assertion reads the order of `select` and `finish` at a known point in the
 * blink: before it settles, and after.
 */

import { describe, expect, test } from "bun:test";

import { sequencePopupMenuActivation } from "../tug-popup-menu-activation";

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
  reject: (e: unknown) => void;
} {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function run(selectAtBlinkStart: boolean) {
  const blink = deferred();
  const log: string[] = [];
  const done = sequencePopupMenuActivation(blink.promise, {
    selectAtBlinkStart,
    select: () => log.push("select"),
    finish: () => log.push("finish"),
  });
  return { blink, log, done };
}

describe("sequencePopupMenuActivation", () => {
  test("default timing selects at the blink's end, then finishes", async () => {
    const { blink, log, done } = run(false);
    await Promise.resolve();
    expect(log).toEqual([]);
    blink.resolve();
    await done;
    expect(log).toEqual(["select", "finish"]);
  });

  test("selectAtBlinkStart selects at once and finishes at the blink's end", async () => {
    const { blink, log, done } = run(true);
    expect(log).toEqual(["select"]);
    await Promise.resolve();
    expect(log).toEqual(["select"]);
    blink.resolve();
    await done;
    expect(log).toEqual(["select", "finish"]);
  });

  test("a rejected blink still selects once and finishes, in either timing", async () => {
    for (const atStart of [false, true]) {
      const { blink, log, done } = run(atStart);
      blink.reject(new Error("detached"));
      await done;
      expect(log).toEqual(["select", "finish"]);
    }
  });

  test("a throwing select still finishes at the blink's end, in either timing", async () => {
    for (const atStart of [false, true]) {
      const blink = deferred();
      const log: string[] = [];
      let done!: Promise<void>;
      const start = () => {
        done = sequencePopupMenuActivation(blink.promise, {
          selectAtBlinkStart: atStart,
          select: () => {
            log.push("select");
            throw new Error("handler failed");
          },
          finish: () => log.push("finish"),
        });
      };
      if (atStart) expect(start).toThrow("handler failed");
      else start();
      blink.resolve();
      if (atStart) {
        await blink.promise;
        await Promise.resolve();
      } else {
        await expect(done).rejects.toThrow("handler failed");
      }
      expect(log).toEqual(["select", "finish"]);
    }
  });
});
