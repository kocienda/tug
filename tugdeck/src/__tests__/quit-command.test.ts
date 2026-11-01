/**
 * ⌘Q's way to the quit guard.
 *
 * A live page's funnel takes the chord ahead of AppKit, so its dispatch is the
 * door the keyboard uses, and it has to make the same request as the Quit
 * item's page call from any page that can hold the keyboard. The shell asks its
 * own guard; a card's body and the overlay mount none, so each asks the host,
 * never the shell across the bus, whose wire may be the very thing that is gone.
 *
 * @covers tugdeck/src/lib/quit-guard-store.ts
 * @covers tugdeck/src/action-dispatch.ts
 */

import { afterEach, describe, expect, test } from "bun:test";

import { isCommandLocked } from "@/components/tugways/command-registry";
import { _resetForTest, registerAction } from "../action-dispatch";
import { _resetPageForTest, installPage } from "../bus/page";
import { dispatchCommand } from "../command-dispatch";
import { liveTurnsStore } from "../lib/live-turns-store";
import { OVERLAY_CARD_ID } from "../lib/overlay-card";
import { quitGuard, requestQuit } from "../lib/quit-guard-store";

const g = globalThis as { webkit?: unknown };
const priorWebkit = g.webkit;

afterEach(async () => {
  g.webkit = priorWebkit;
  _resetPageForTest();
  _resetForTest();
  // Answer any question a test left up on the shared guard.
  await quitGuard.ask(async () => false);
  liveTurnsStore.adopt({ count: 0, titles: [] });
});

/** A turn in flight, so a request to the guard shows as a new nonce. */
function aTurnIsLive(): number {
  liveTurnsStore.adopt({ count: 1, titles: ["a"] });
  return quitGuard.getSnapshot();
}

/** Count what the page posts to the host as `quitRequested`. */
function watchQuitRequests(): () => number {
  let posted = 0;
  g.webkit = { messageHandlers: { quitRequested: { postMessage: () => (posted += 1) } } };
  return () => posted;
}

describe("quit-application", () => {
  test("stays locked now that it is routable", () => {
    expect(isCommandLocked("quit-application")).toBe(true);
  });

  test("in the shell, the chord's dispatch reaches the guard", () => {
    const before = aTurnIsLive();
    registerAction("quit-application", () => requestQuit());
    expect(dispatchCommand("quit-application")).toBe(true);
    expect(quitGuard.getSnapshot()).toBe(before + 1);
  });

  for (const [label, cardId] of [
    ["a card's body", "A"],
    ["the overlay", OVERLAY_CARD_ID],
  ] as const) {
    test(`in ${label}, the chord's dispatch asks the host`, () => {
      const posted = watchQuitRequests();
      const before = aTurnIsLive();
      installPage({ role: "body", cardId, componentId: "session" });
      registerAction("quit-application", () => requestQuit());
      expect(dispatchCommand("quit-application")).toBe(true);
      expect(posted()).toBe(1);
      expect(quitGuard.getSnapshot()).toBe(before);
    });
  }
});
