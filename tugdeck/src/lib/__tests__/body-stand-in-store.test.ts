/**
 * Which body cards the shell stands a face in for: a card whose page is
 * being made, made and not painted, or evicted wears one; a painted page, a
 * page whose chrome is on screen and a failed body do not; and a face goes
 * two frames after the page paints, so the hand-off has no frame with
 * neither.
 *
 * @covers tugdeck/src/lib/body-stand-in-store.ts
 */
import { describe, expect, test } from "bun:test";

import type { BodyCardState } from "../body-cards-store";
import { BodyStandInStore, STAND_IN_LINGER_FRAMES, standInOf, type StandInFacts, type StandInSources } from "../body-stand-in-store";

function facts(over: Partial<StandInFacts> = {}): StandInFacts {
  return { state: "creating", chromeShown: false, ...over };
}

describe("whether a card wants a face", () => {
  test("a page being made, made and not painted, evicted, or never made wants one", () => {
    for (const state of ["creating", "ready", "evicted", "unmade"] as BodyCardState[]) {
      expect(standInOf(facts({ state }))).toBe(true);
    }
  });

  test("a painted page, a page whose chrome is on screen, a failed body and no body want none", () => {
    expect(standInOf(facts({ state: "painted" }))).toBe(false);
    expect(standInOf(facts({ state: "ready", chromeShown: true }))).toBe(false);
    expect(standInOf(facts({ state: "failed" }))).toBe(false);
    expect(standInOf(facts({ state: null }))).toBe(false);
  });
});

/** Plain values the test sets, and frames it runs by hand. */
class Bodies implements StandInSources {
  readonly cards = new Map<string, StandInFacts>();
  private readonly listeners = new Set<() => void>();
  private frames: Array<() => void> = [];

  cardIds = (): readonly string[] => [...this.cards.keys()];
  facts = (cardId: string): StandInFacts => this.cards.get(cardId) ?? facts({ state: null });
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  nextFrame = (fn: () => void): void => {
    this.frames.push(fn);
  };

  set(cardId: string, over: Partial<StandInFacts>): void {
    this.cards.set(cardId, facts({ ...this.cards.get(cardId), ...over }));
    for (const listener of [...this.listeners]) listener();
  }
  remove(cardId: string): void {
    this.cards.delete(cardId);
    for (const listener of [...this.listeners]) listener();
  }
  frame(): void {
    const due = this.frames;
    this.frames = [];
    for (const fn of due) fn();
  }
}

function setup(): { bodies: Bodies; store: BodyStandInStore; ticks: () => number } {
  const bodies = new Bodies();
  const store = new BodyStandInStore(bodies);
  let count = 0;
  store.subscribe(() => (count += 1));
  store.attach();
  return { bodies, store, ticks: () => count };
}

describe("the store", () => {
  test("a face stands at once and goes the frames after the page paints", () => {
    const { bodies, store } = setup();
    bodies.set("a", { state: "creating" });
    expect(store.standing("a")).toBe(true);
    bodies.set("a", { state: "painted" });
    expect(store.standing("a"), "still standing on the frame the page first paints").toBe(true);
    for (let i = 1; i < STAND_IN_LINGER_FRAMES; i++) {
      bodies.frame();
      expect(store.standing("a")).toBe(true);
    }
    bodies.frame();
    expect(store.standing("a")).toBe(false);
  });

  test("a card that wants a face again while its face is leaving keeps it", () => {
    const { bodies, store } = setup();
    bodies.set("a", { state: "creating" });
    bodies.set("a", { state: "painted" });
    bodies.frame();
    bodies.set("a", { state: "evicted" });
    for (let i = 0; i < STAND_IN_LINGER_FRAMES + 1; i++) bodies.frame();
    expect(store.standing("a")).toBe(true);
  });

  test("an evicted card stands a face through its new page's making, until that page's chrome is on screen", () => {
    const { bodies, store } = setup();
    bodies.set("a", { state: "evicted" });
    bodies.set("a", { state: "creating" });
    bodies.set("a", { state: "ready" });
    expect(store.standing("a")).toBe(true);
    bodies.set("a", { state: "ready", chromeShown: true });
    for (let i = 0; i < STAND_IN_LINGER_FRAMES; i++) bodies.frame();
    expect(store.standing("a")).toBe(false);
  });

  test("a card that goes takes its face with it, and a card that moves nothing notifies nobody", () => {
    const { bodies, store, ticks } = setup();
    bodies.set("a", { state: "creating" });
    bodies.set("b", { state: "painted" });
    const before = ticks();
    bodies.set("b", { state: "painted" });
    expect(ticks()).toBe(before);
    bodies.remove("a");
    expect(store.standing("a")).toBe(false);
  });

  test("detached, it stands nothing", () => {
    const { bodies, store } = setup();
    bodies.set("a", { state: "creating" });
    store.detach();
    expect(store.standing("a")).toBe(false);
  });
});
