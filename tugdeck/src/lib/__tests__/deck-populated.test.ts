import { describe, expect, test } from "bun:test";
import type { BodyCardState } from "../body-cards-store";
import { populationOf, watchDeckPopulated, type PopulatedDeck, type Population } from "../deck-populated";
import { hmrUpdateOf } from "../hmr-landed";

function states(entries: Record<string, BodyCardState>): (cardId: string) => BodyCardState | null {
  return (cardId) => entries[cardId] ?? null;
}

describe("populationOf", () => {
  test("waits for the restore pass to settle", () => {
    expect(
      populationOf({ passSettled: false, passPending: false, expected: ["a"], stateOf: states({ a: "painted" }) }),
    ).toBeNull();
  });

  test("waits while a pass is still deciding for a card", () => {
    expect(
      populationOf({ passSettled: true, passPending: true, expected: ["a"], stateOf: states({ a: "painted" }) }),
    ).toBeNull();
  });

  test("waits on a card not yet handed off, creating, or only ready", () => {
    for (const stateOf of [states({}), states({ a: "creating" }), states({ a: "ready" })]) {
      expect(populationOf({ passSettled: true, passPending: false, expected: ["a"], stateOf })).toBeNull();
    }
  });

  test("a failed or evicted body does not hold the lap open; failures and pageless cards are counted", () => {
    expect(
      populationOf({
        passSettled: true,
        passPending: false,
        expected: ["a", "b", "c"],
        stateOf: states({ a: "painted", b: "failed", c: "evicted" }),
      }),
    ).toEqual({ bodies: 2, failed: 1, unmade: 1 });
  });
});

describe("watchDeckPopulated", () => {
  test("fires once, at the last paint, over the shown workspace's body kinds", () => {
    const listeners = new Set<() => void>();
    const notify = (): void => listeners.forEach((listener) => listener());
    const cards = [
      { id: "s1", componentId: "session" },
      { id: "s2", componentId: "session" },
      { id: "x", componentId: "shell-only" },
    ];
    const deck: PopulatedDeck = { getSnapshot: () => ({ cards }), subscribe: () => () => {} };
    const body: Record<string, BodyCardState> = {};
    let settledPass = false;
    const fired: Population[] = [];
    watchDeckPopulated(
      {
        deck,
        isBodyKind: (componentId) => componentId === "session",
        passSettled: () => settledPass,
        passPending: () => false,
        stateOf: (cardId) => body[cardId] ?? null,
        subscribe: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
      (population) => fired.push(population),
    );
    body.s1 = "painted";
    notify();
    settledPass = true;
    notify();
    expect(fired).toEqual([]);
    body.s2 = "painted";
    notify();
    notify();
    expect(fired).toEqual([{ bodies: 2, failed: 0, unmade: 0 }]);
    expect(listeners.size).toBe(0);
  });
});

describe("hmrUpdateOf", () => {
  test("reports the earliest stamp and the module count", () => {
    expect(hmrUpdateOf({ updates: [{ timestamp: 20 }, { timestamp: 10 }] })).toEqual({ viteAt: 10, modules: 2 });
  });

  test("an update with no modules reports nothing", () => {
    expect(hmrUpdateOf({ updates: [] })).toBeNull();
  });
});
