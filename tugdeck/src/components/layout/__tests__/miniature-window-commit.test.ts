/**
 * The flow window's commit keeps the bracket's transitions off until the
 * commit itself has been heard.
 *
 * In a card's body the deck is the shell's: the commit goes over the bus and
 * comes back with the shell's next context, and other notifications land in
 * between. A stamp taken off on the first notification of any kind is off
 * before the bracket re-pins, and the re-pin tweens against the slide it
 * replaces — the bracket hops back and glides forward after the hand lets go
 * (`at0661`). These pin that only the notification carrying the commit
 * starts the two-frame clear, and that a commit nobody answers is cleared by
 * the deadline.
 *
 * @covers tugdeck/src/components/layout/use-miniature-window-drag.ts
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";

import { COMMIT_ANSWER_MS, commitUnderStamp } from "../use-miniature-window-drag";

type Listener = (landing: "cut") => void;

/** A deck whose commit lands later, as a body's does. */
function remoteDeck(start: number) {
  let flowOffset = start;
  const listeners = new Set<Listener>();
  const committed: number[] = [];
  return {
    committed,
    store: {
      getSnapshot: () => ({ flowOffset }) as never,
      subscribe: (fn: Listener) => {
        listeners.add(fn);
        return () => {
          listeners.delete(fn);
        };
      },
      setFlowOffset: (offset: number) => {
        committed.push(offset);
      },
    },
    /** A notification that carries nothing new — a context about something else. */
    notify: () => {
      for (const fn of [...listeners]) fn("cut");
    },
    /** The shell's answer: the commit, in the snapshot, then the notification. */
    land: (offset: number) => {
      flowOffset = offset;
      for (const fn of [...listeners]) fn("cut");
    },
  };
}

let frames: Array<() => void> = [];
const runFrame = (): void => {
  const due = frames;
  frames = [];
  for (const fn of due) fn();
};
let prior: { raf: unknown } | null = null;

beforeEach(() => {
  const globals = globalThis as Record<string, unknown>;
  prior = { raf: globals.requestAnimationFrame };
  globals.requestAnimationFrame = (fn: () => void): number => {
    frames.push(fn);
    return frames.length;
  };
});

afterEach(() => {
  // Restored by assignment: deleting a global slows every later file.
  (globalThis as Record<string, unknown>).requestAnimationFrame = prior?.raf;
  frames = [];
});

function figure(): HTMLElement {
  const el = new JSDOM("<!doctype html><span></span>").window.document.querySelector("span") as unknown as HTMLElement;
  el.setAttribute("data-window-drag", "");
  return el;
}

describe("commitUnderStamp", () => {
  test("a notification that does not carry the commit leaves the stamp on", () => {
    const deck = remoteDeck(0);
    const el = figure();
    const done: unknown[] = [];
    commitUnderStamp(deck.store, el, 740, (p) => done.push(p));
    expect(deck.committed).toEqual([740]);

    deck.notify();
    runFrame();
    runFrame();
    expect(el.hasAttribute("data-window-drag")).toBe(true);

    deck.land(740);
    runFrame();
    expect(el.hasAttribute("data-window-drag")).toBe(true);
    runFrame();
    expect(el.hasAttribute("data-window-drag")).toBe(false);
    expect(done).toHaveLength(1);
  });

  test("a commit that never comes back is cleared by the deadline", async () => {
    const deck = remoteDeck(0);
    const el = figure();
    const done: unknown[] = [];
    const pending = commitUnderStamp(deck.store, el, 740, (p) => done.push(p));
    expect(pending.deadline).not.toBeNull();
    await new Promise((r) => setTimeout(r, COMMIT_ANSWER_MS + 50));
    expect(el.hasAttribute("data-window-drag")).toBe(false);
    expect(done).toEqual([pending]);
    expect(pending.unsubscribe).toBeNull();
  });
});
