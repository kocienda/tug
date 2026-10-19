/**
 * A press in a body page places the engine at what it landed on, by the
 * interpreter's own placement rule read for the page's one card: the target
 * itself on the key card, only a text-entry target on a card the press is
 * about to activate, and nothing on a focus-refusing control. The shell and a
 * bare provider place nothing this way.
 *
 * jsdom: the rule reads the press's target's ancestry.
 *
 * @covers tugdeck/src/gesture-interpreter.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";

import { bodyPointerPlacementCard } from "../../gesture-interpreter";
import { _resetPageForTest, installPage } from "../../bus/page";

/** This page is `cardId`'s body, or the shell with null. */
function pageIs(cardId: string | null): void {
  _resetPageForTest();
  if (cardId !== null) installPage({ role: "body", cardId, componentId: null });
}

const dom = new JSDOM(
  `<!doctype html><body><div data-card-id="C">
     <input id="field" />
     <div id="row" data-tug-focusable="row"></div>
     <button id="refuser" data-tug-focus="refuse"></button>
   </div></body>`,
);
const doc = dom.window.document;
const GLOBALS = ["document", "window", "Element", "Node", "HTMLElement"] as const;
const saved: Record<string, unknown> = {};
const scope = globalThis as unknown as Record<string, unknown>;

beforeAll(() => {
  for (const name of GLOBALS) saved[name] = scope[name];
  scope.document = doc;
  scope.window = dom.window;
  scope.Element = dom.window.Element;
  scope.Node = dom.window.Node;
  scope.HTMLElement = dom.window.HTMLElement;
});

afterAll(() => {
  pageIs(null);
  // Restored by assignment: deleting a global slows every later file.
  for (const name of GLOBALS) scope[name] = saved[name];
});

const press = (id: string, over: Partial<{ button: number; metaKey: boolean }> = {}) => ({
  target: doc.getElementById(id),
  button: 0,
  metaKey: false,
  ...over,
});

describe("bodyPointerPlacementCard", () => {
  test("a page that is no body places nothing", () => {
    pageIs(null);
    expect(bodyPointerPlacementCard(press("field"), "C")).toBe(null);
  });

  test("on the key card, the press places what it landed on", () => {
    // A field already holding DOM focus fires no focusin on a click, so this
    // is what moves the key view back onto it (at0582).
    pageIs("C");
    expect(bodyPointerPlacementCard(press("field"), "C")).toBe("C");
    expect(bodyPointerPlacementCard(press("row"), "C")).toBe("C");
  });

  test("on a card about to activate, only a text-entry target drills down", () => {
    pageIs("C");
    expect(bodyPointerPlacementCard(press("field"), "other")).toBe("C");
    expect(bodyPointerPlacementCard(press("row"), "other")).toBe(null);
    expect(bodyPointerPlacementCard(press("field", { button: 2 }), "other")).toBe(null);
    expect(bodyPointerPlacementCard(press("field", { metaKey: true }), "other")).toBe(null);
  });

  test("a focus-refusing control places nothing", () => {
    pageIs("C");
    expect(bodyPointerPlacementCard(press("refuser"), "C")).toBe(null);
  });
});
