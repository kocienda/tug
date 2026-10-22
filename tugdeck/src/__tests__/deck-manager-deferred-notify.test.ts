/**
 * The deck store's React tell, held past a motion its sync subscriber
 * launched from the store's delta alone.
 *
 * A hand-lift's flow slide is planned in the canvas's `arm`, inside the
 * commit's sync-subscriber pass, and reads nothing React would lay out. So
 * that arm closes the motion gate and votes the commit held behind it
 * (`holdNotifyPastMotion`), and React is told when the gate opens, after the
 * land, rather than one paint in, inside the motion. A commit whose arm
 * closed a gate and voted nothing keeps the ordinary deferral: React is told
 * past the next paint, which is a measured settle's set-up.
 *
 * Read over a real `DeckManager` mounted into a jsdom container.
 *
 * @covers tugdeck/src/deck-manager.ts
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import type { DeckManager } from "../deck-manager";
import type { gestureScope as GestureScope } from "../lib/gesture-scope";
import { installJsdom, mountDeck, onePaneDeck, settle, unmountDeck } from "./jsdom-deck";

// Installed before any deck module loads; the deck is imported in `beforeAll`.
const substrate = installJsdom();

let manager: DeckManager;
let scope: typeof GestureScope;

beforeAll(async () => {
  manager = await mountDeck(substrate, onePaneDeck("hello", ["card-1"]), { focusCardId: "card-1" });
  scope = (await import("../lib/gesture-scope")).gestureScope;
  // Motion on, so the gate closes and the store defers at all.
  document.documentElement.style.setProperty("--tug-motion", "1");
});

afterAll(async () => {
  document.documentElement.style.removeProperty("--tug-motion");
  await unmountDeck(substrate, manager);
});

/**
 * Commit once with a sync subscriber that closes a gate, as the arm does,
 * and votes the hold when `hold` says so. Returns the gate's release and a
 * count of React-side tells.
 */
function commitUnderGate(hold: boolean): { open: () => void; told: () => number; done: () => void } {
  let release: () => void = () => {};
  let told = 0;
  const unsync = manager.subscribeSync(() => {
    release = scope.holdMotion(10_000);
    if (hold) manager.holdNotifyPastMotion();
  }, "test-arm");
  const unsubscribe = manager.subscribe(() => {
    told += 1;
  });
  manager.refresh();
  unsync();
  return {
    open: () => release(),
    told: () => told,
    done: () => {
      release();
      unsubscribe();
    },
  };
}

describe("the deck store's tell under a motion its arm launched", () => {
  test("is held behind the gate when the arm votes it past the motion, and told when the gate opens", async () => {
    const run = commitUnderGate(true);
    try {
      await settle();
      expect(run.told(), "React is not told while the gate stands closed").toBe(0);
      run.open();
      await settle();
      expect(run.told(), "React is told once, after the gate opens").toBe(1);
    } finally {
      run.done();
    }
  });

  test("keeps the ordinary deferral when the arm votes nothing: told past the next paint, gate or no gate", async () => {
    const run = commitUnderGate(false);
    try {
      await settle();
      expect(run.told(), "a measured settle's commit is its set-up, told before the motion").toBe(1);
    } finally {
      run.done();
    }
  });
});
