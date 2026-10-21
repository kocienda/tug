/**
 * A body's dormancy decisions, over visibility snapshots: when it sleeps,
 * when it catches up, and when it wakes; and the effects the installer
 * carries out for each, in order.
 *
 * @covers tugdeck/src/body/body-dormancy.ts
 */

import { describe, expect, test } from "bun:test";
import { BodyVisibilityStore, type DormantClock } from "../../lib/body-visibility-store";
import { AWAKE, caughtUp, installBodyDormancy, nextDormancy, type BodyDormancyEffects, type DormancyState } from "../body-dormancy";

const ASLEEP: DormancyState = { asleep: true, catchingUp: false };
const CATCHING_UP: DormancyState = { asleep: false, catchingUp: true };

describe("nextDormancy", () => {
  test("an awake body sleeps once the store calls it dormant while hidden", () => {
    expect(nextDormancy(AWAKE, { shown: false, dormant: true })).toEqual({ state: ASLEEP, act: "sleep" });
  });

  test("hidden but not yet dormant, nothing happens", () => {
    expect(nextDormancy(AWAKE, { shown: false, dormant: false })).toEqual({ state: AWAKE, act: null });
  });

  test("a sleeping body shown again catches up, still dormant", () => {
    expect(nextDormancy(ASLEEP, { shown: true, dormant: true })).toEqual({ state: CATCHING_UP, act: "catch-up" });
  });

  test("a sleeping body stays asleep while hidden", () => {
    expect(nextDormancy(ASLEEP, { shown: false, dormant: true })).toEqual({ state: ASLEEP, act: null });
  });

  test("a catch-up runs to its end even if the body is hidden again meanwhile", () => {
    expect(nextDormancy(CATCHING_UP, { shown: false, dormant: true })).toEqual({ state: CATCHING_UP, act: null });
  });

  test("a shown body the store calls dormant — shown before it caught up — does not sleep", () => {
    expect(nextDormancy(AWAKE, { shown: true, dormant: true })).toEqual({ state: AWAKE, act: null });
  });
});

describe("caughtUp", () => {
  test("a catch-up's close wakes the body", () => {
    expect(caughtUp(CATCHING_UP)).toEqual({ state: AWAKE, act: "wake" });
  });

  test("a close with no catch-up outstanding changes nothing", () => {
    expect(caughtUp(AWAKE)).toEqual({ state: AWAKE, act: null });
    expect(caughtUp(ASLEEP)).toEqual({ state: ASLEEP, act: null });
  });
});

/** A clock the test moves by hand. */
function handClock(): DormantClock & { advance(ms: number): void } {
  let now = 1_000;
  let pending: { at: number; fire: () => void } | null = null;
  return {
    now: () => now,
    setTimeout: (fire, ms) => (pending = { at: now + ms, fire }),
    clearTimeout: (handle) => {
      if (pending === handle) pending = null;
    },
    advance(ms) {
      now += ms;
      const due = pending;
      if (due !== null && due.at <= now) {
        pending = null;
        due.fire();
      }
    },
  };
}

/** Effects that record what was done, and a catch-up the test closes by hand. */
function recordingEffects(): { effects: BodyDormancyEffects; log: string[]; closeCatchUp(): void } {
  const log: string[] = [];
  let done: (() => void) | null = null;
  return {
    log,
    effects: {
      rescope: () => log.push("rescope"),
      stillLoops: (on) => log.push(`stillLoops ${on}`),
      lidContent: (on) => log.push(`lidContent ${on}`),
      withholdSurface: (on) => log.push(`withholdSurface ${on}`),
      saveBag: () => log.push("saveBag"),
      catchUp: (d) => {
        log.push("catchUp");
        done = d;
        return () => {};
      },
    },
    closeCatchUp: () => done?.(),
  };
}

describe("installBodyDormancy", () => {
  test("going dormant writes the bag once, before anything else is stilled", () => {
    const clock = handClock();
    const store = new BodyVisibilityStore(clock, 500);
    const { effects, log } = recordingEffects();
    const installed = installBodyDormancy(effects, store);
    store.apply({ shown: false, since: clock.now() });
    clock.advance(499);
    expect(log).toEqual([]);
    clock.advance(1);
    expect(installed.asleep).toBe(true);
    expect(log).toEqual(["saveBag", "stillLoops true", "lidContent true", "withholdSurface true", "rescope"]);
    installed.release();
  });

  test("a body hidden and shown before its delay writes nothing", () => {
    const clock = handClock();
    const store = new BodyVisibilityStore(clock, 500);
    const { effects, log } = recordingEffects();
    const installed = installBodyDormancy(effects, store);
    store.apply({ shown: false, since: clock.now() });
    clock.advance(200);
    store.apply({ shown: true, since: clock.now() });
    clock.advance(1_000);
    expect(log).toEqual([]);
    installed.release();
  });

  test("the catch-up and the wake write no bag; a second sleep writes it again", () => {
    const clock = handClock();
    const store = new BodyVisibilityStore(clock, 500);
    const { effects, log, closeCatchUp } = recordingEffects();
    const installed = installBodyDormancy(effects, store);
    store.apply({ shown: false, since: clock.now() });
    clock.advance(500);
    store.apply({ shown: true, since: clock.now() });
    closeCatchUp();
    expect(installed.asleep).toBe(false);
    expect(log.filter((e) => e === "saveBag")).toHaveLength(1);
    expect(log.slice(5)).toEqual(["rescope", "catchUp", "stillLoops false", "lidContent false", "withholdSurface false"]);
    store.apply({ shown: false, since: clock.now() });
    clock.advance(500);
    expect(log.filter((e) => e === "saveBag")).toHaveLength(2);
    installed.release();
  });
});
