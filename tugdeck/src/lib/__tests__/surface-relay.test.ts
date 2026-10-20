/**
 * The shell relays a body's raised surface to the overlay with where its
 * card rests, and dismisses it for the presses only the shell sees: one on
 * the canvas, Escape, and the keyboard going to another card.
 */

import { afterAll, describe, expect, test } from "bun:test";
import type { CardSurface } from "../../bus/declarations/card";
import type { OverlaySurfaceEntry } from "../../bus/declarations/overlay";
import { installJsdom } from "../../__tests__/jsdom-deck";

const substrate = installJsdom();
afterAll(() => substrate.restore());

const { OverlaySurfaceBook } = await import("../overlay-surfaces");
const { createSurfaceRelay } = await import("../surface-relay");

const SURFACE: CardSurface = { title: "Time", className: "", growth: "up", anchorX: 120, lineY: 580, html: "<b>1:00</b>", scroll: [] };
const AT = { body: { x: 40, y: 40, width: 480, height: 620 }, pane: null, bound: null };

function rig() {
  const shown: Array<Record<string, OverlaySurfaceEntry>> = [];
  const book = new OverlaySurfaceBook((s) => shown.push(s));
  const dismissed: string[] = [];
  let where: typeof AT | null = AT;
  const relay = createSurfaceRelay({ book, measure: () => where, dismiss: (cardId) => dismissed.push(cardId) });
  return { book, relay, shown, dismissed, at: (next: typeof AT | null) => (where = next) };
}

describe("createSurfaceRelay", () => {
  test("publishes a raised surface with its card's rest geometry, and takes it down with the surface", () => {
    const { book, relay } = rig();
    relay.set("A", SURFACE);
    expect(book.snapshot()).toEqual({ A: { surface: SURFACE, ...AT } });
    relay.set("A", null);
    expect(book.snapshot()).toEqual({});
    relay.dispose();
  });

  test("a card that shows nowhere publishes nothing until it does", () => {
    const { book, relay, at } = rig();
    at(null);
    relay.set("A", SURFACE);
    expect(book.snapshot()).toEqual({});
    at(AT);
    relay.placeAll();
    expect(Object.keys(book.snapshot())).toEqual(["A"]);
    relay.dispose();
  });

  test("a press on the shell's page and Escape dismiss every raised surface", () => {
    const { book, relay, dismissed } = rig();
    relay.set("A", SURFACE);
    relay.set("B", SURFACE);
    document.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true }));
    expect(dismissed).toEqual(["A", "B"]);
    expect(book.snapshot()).toEqual({});
    relay.set("A", SURFACE);
    document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(dismissed).toEqual(["A", "B", "A"]);
    relay.dispose();
  });

  test("the keyboard going to a card dismisses every other card's surface", () => {
    const { book, relay, dismissed } = rig();
    relay.set("A", SURFACE);
    relay.set("B", SURFACE);
    relay.dismissAllBut("B");
    expect(dismissed).toEqual(["A"]);
    expect(Object.keys(book.snapshot())).toEqual(["B"]);
    relay.dispose();
  });

  test("an overlay dismissal tells the body, once", () => {
    const { relay, dismissed } = rig();
    relay.set("A", SURFACE);
    relay.dismissed("A");
    relay.dismissed("A");
    expect(dismissed).toEqual(["A"]);
    relay.dispose();
  });

  test("a card coming to rest is re-measured before its entry is shown again", () => {
    const { book, relay, at } = rig();
    relay.set("A", SURFACE);
    book.hold("A", "gesture");
    at({ ...AT, body: { ...AT.body, x: 400 } });
    book.release("A", "gesture");
    expect(book.snapshot().A.body.x).toBe(400);
    relay.dispose();
  });
});
