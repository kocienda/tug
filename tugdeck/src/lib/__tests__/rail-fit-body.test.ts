/**
 * A rail card drawn in its own body has its content in that page: the
 * shell's pane holds only the body's placeholder, so *Resize Sidebars to Fit*
 * reads the card's natural from what its body published (`card.content`) —
 * the content's height and what its scroller shows — and adds the pane's
 * chrome above it. The body is a page of the test bus, and the shell's is
 * this page's bus.
 *
 * jsdom lays nothing out, so the boxes are stated on the elements.
 *
 * @covers tugdeck/src/lib/rail-fit.ts
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";

import { cardContent } from "../../bus/declarations/card";
import { createTestBus, type TestBus } from "../../bus/test-bus";
import { railNaturalOf, readPageContent } from "../rail-fit";

const dom = new JSDOM("<!doctype html><body></body>");
const doc = dom.window.document;

const GLOBALS = ["document", "window", "CSS", "getComputedStyle"] as const;
const saved: Record<string, unknown> = {};
const scope = globalThis as unknown as Record<string, unknown>;

beforeAll(() => {
  for (const name of GLOBALS) saved[name] = scope[name];
  scope.document = doc;
  scope.window = dom.window;
  scope.CSS = { escape: (value: string) => value };
  scope.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
});

afterAll(() => {
  // Restored by assignment: deleting a global slows every later file.
  for (const name of GLOBALS) scope[name] = saved[name];
});

let bus: TestBus;
afterEach(() => {
  doc.body.innerHTML = "";
  bus?.dispose();
});

function sized(el: Element, height: number): void {
  (el as HTMLElement).getBoundingClientRect = () =>
    ({ x: 0, y: 0, width: 300, height, top: 0, left: 0, right: 300, bottom: height }) as DOMRect;
}

/** A shell rail pane holding card `J`'s body placeholder, `paneHeight` tall. */
function bodyPane(paneHeight: number): void {
  doc.body.innerHTML =
    `<div class="tug-pane" data-rail-member="jots">` +
    `<div data-body-placeholder data-card-id="J"></div></div>`;
  sized(doc.querySelector(".tug-pane")!, paneHeight);
}

describe("railNaturalOf, for a card in its own body", () => {
  test("is the body's content plus the pane's chrome above what the body shows", async () => {
    bodyPane(400);
    bus = createTestBus();
    bus.install(bus.shell());
    const body = bus.body("J", "jots");
    cardContent.on(body.bus).set({ content: 220, shown: 370 });
    await bus.flush();
    // 400 − 370 = 30 of chrome over the body's scroller.
    expect(railNaturalOf("jots", 1000)).toBe(250);
  });

  test("is unread while the body has published no reading", () => {
    bodyPane(400);
    expect(railNaturalOf("jots", 1000)).toBeNull();
  });
});

describe("readPageContent, in a body's page", () => {
  test("publishes the content's height and its scroller's shown height", () => {
    doc.body.innerHTML =
      `<div class="scroller" style="overflow-y: auto"><div data-card-content></div></div>`;
    sized(doc.querySelector("[data-card-content]")!, 220);
    Object.defineProperty(doc.querySelector(".scroller")!, "clientHeight", { value: 370 });
    expect(readPageContent()).toEqual({ content: 220, shown: 370 });
  });

  test("publishes nothing from a page with no card content", () => {
    expect(readPageContent()).toBeNull();
  });
});
