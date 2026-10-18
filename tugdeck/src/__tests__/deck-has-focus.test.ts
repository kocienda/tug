/**
 * The deck's `hasFocus` follows the app's activity, never the page's own
 * focus.
 *
 * Every card is a body — a web view of its own beneath the shell page — so
 * the shell page blurs whenever a card takes the keyboard, with the app as
 * active as it was. The bit is a delegate of the app lifecycle the host's
 * `app-lifecycle` frames drive ([L28]): a resign or a hide clears it, after
 * the first-responder card's pre-resign save; becoming active or unhiding
 * sets it again. A window `blur` leaves it alone, which is the case the old
 * window listeners got wrong — the deck went quiet, and every body was told
 * the app was inactive, whenever a card held the keyboard.
 *
 * Read over a real `DeckManager` mounted into a jsdom container, driving its
 * own `appLifecycle` as the action dispatcher does on a frame.
 *
 * @covers tugdeck/src/deck-manager.ts
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import type { DeckManager } from "../deck-manager";
import { installJsdom, mountDeck, onePaneDeck, unmountDeck } from "./jsdom-deck";

// Installed before any deck module loads; the deck is imported in `beforeAll`.
const substrate = installJsdom();
const { win } = substrate;

const CARD = "card-1";

let manager: DeckManager;

beforeAll(async () => {
  manager = await mountDeck(substrate, onePaneDeck("hello", [CARD]), { focusCardId: CARD });
});

afterAll(async () => {
  await unmountDeck(substrate, manager);
});

const hasFocus = (): boolean => manager.getSnapshot().hasFocus;

describe("the deck's hasFocus", () => {
  test("stays true when the page blurs and the app is still active", () => {
    manager.appLifecycle.notifyApplicationDidBecomeActive();
    expect(hasFocus()).toBe(true);
    win.dispatchEvent(new Event("blur"));
    expect(hasFocus(), "a card's body taking the keyboard is not the app resigning").toBe(true);
  });

  test("goes false on a resign, after the first-responder card's save", () => {
    manager.appLifecycle.notifyApplicationDidBecomeActive();
    const seen: Array<{ source: string | undefined; hasFocus: boolean }> = [];
    manager.registerSaveCallback(CARD, (source) => {
      seen.push({ source, hasFocus: hasFocus() });
    });
    manager.appLifecycle.notifyApplicationWillResignActive();
    expect(hasFocus()).toBe(false);
    expect(seen, "the save ran while the bit was still true").toEqual([{ source: "window-blur", hasFocus: true }]);
  });

  test("goes true when the app becomes active, and on a page focus alone it does not", () => {
    manager.appLifecycle.notifyApplicationWillResignActive();
    win.dispatchEvent(new Event("focus"));
    expect(hasFocus(), "the page's focus is not the app's activity").toBe(false);
    manager.appLifecycle.notifyApplicationDidBecomeActive();
    expect(hasFocus()).toBe(true);
  });

  test("follows a hide and an unhide", () => {
    manager.appLifecycle.notifyApplicationDidBecomeActive();
    manager.appLifecycle.notifyApplicationWillHide();
    expect(hasFocus()).toBe(false);
    manager.appLifecycle.notifyApplicationDidUnhide();
    expect(hasFocus()).toBe(true);
  });
});
