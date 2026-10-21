/**
 * A body's dormancy decisions, over visibility snapshots: when it sleeps,
 * when it catches up, and when it wakes.
 *
 * @covers tugdeck/src/body/body-dormancy.ts
 */

import { describe, expect, test } from "bun:test";
import { AWAKE, caughtUp, nextDormancy, type DormancyState } from "../body-dormancy";

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
