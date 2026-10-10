/**
 * The deck canvas's focus-order census, under jsdom.
 *
 * `DeckCanvas` renders its panes in STABLE ID ORDER and carries activation in
 * z-index alone, so a focus change never reorders the DOM. That is what keeps
 * the keyboard's Tab walk the same walk before and after a card comes forward,
 * and what the deck's app-tests enumerate a census against (a Tab walk that
 * lands where it did, a stop count that does not grow). Those cost a Tug.app
 * launch each; this is the same census over a real `DeckManager` mounted into
 * a jsdom container, in a second.
 *
 * The census is read three ways off one seeded deck of three free panes whose
 * store order (z order) deliberately disagrees with their id order:
 *   - the pane frames, in DOM order, are the panes sorted by id;
 *   - the Tab stops, in DOM order, are each pane's stops contiguous, panes in
 *     id order, and their count is one per card;
 *   - activating a different card changes z-index and the first responder,
 *     and leaves both of the above exactly as they were.
 *
 * @covers tugdeck/src/components/chrome/deck-canvas.tsx
 * @covers tugdeck/src/deck-manager.ts
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import React from "react";

import type { DeckManager as DeckManagerType } from "../deck-manager";
import type { DeckState } from "../layout-tree";
import { errorBannerText, installJsdom, mountDeck, settle, unmountDeck } from "./jsdom-deck";

// Installed before any deck module loads; the deck is imported in `beforeAll`.
const substrate = installJsdom();

// ---- The deck under test ----

const COMPONENT = "focus-census-probe";

/** Free panes in STORE order c, a, b — z order — so id order (a, b, c) differs. */
function seededDeck(): DeckState {
  const pane = (id: string, x: number) => ({
    id: `pane-${id}`,
    position: { x, y: 20 },
    size: { width: 300, height: 200 },
    cardIds: [`card-${id}`],
    activeCardId: `card-${id}`,
    title: "",
    acceptsFamilies: ["standard"],
  });
  return {
    cards: ["c", "a", "b"].map((id) => ({
      id: `card-${id}`,
      componentId: COMPONENT,
      title: `Card ${id}`,
      closable: true,
    })),
    panes: [pane("c", 640), pane("a", 20), pane("b", 330)],
    activePaneId: "pane-c",
    imposition: { sidebars: {} },
    hasFocus: true,
  };
}

/** Tab stops in one single-card pane: four in its chrome, one in the probe. */
const STOPS_PER_PANE = 5;


let manager: DeckManagerType;
const container = substrate.container;

beforeAll(async () => {
  const { registerCard } = await import("../card-registry");
  registerCard({
    componentId: COMPONENT,
    // One focusable control per card: the census counts these.
    contentFactory: (cardId) => (
      <button type="button" data-census-stop={cardId}>
        {cardId}
      </button>
    ),
    defaultMeta: { title: "Census", closable: true },
  });
  manager = await mountDeck(substrate, seededDeck());
});

afterAll(() => unmountDeck(substrate, manager));

// ---- Readings ----

function paneFrameOrder(): string[] {
  return Array.from(container.querySelectorAll<HTMLElement>(".tug-pane[data-pane-id]")).map(
    (el) => el.getAttribute("data-pane-id") ?? "",
  );
}

/** Tab stops in DOM order: what a keyboard walk visits, tagged by card. */
function censusStops(): string[] {
  return Array.from(container.querySelectorAll<HTMLElement>("[data-census-stop]")).map(
    (el) => el.getAttribute("data-census-stop") ?? "",
  );
}

/**
 * Every Tab stop in the deck, in DOM order, tagged by the pane it sits in
 * ("deck" for chrome outside any pane): an element the keyboard reaches with
 * Tab is one with a non-negative tab index that is not disabled and not
 * inside an inert or `aria-hidden` subtree.
 */
function tabWalk(): string[] {
  const candidates = container.querySelectorAll<HTMLElement>(
    "a[href], button, input, select, textarea, [tabindex], [contenteditable='true']",
  );
  const walk: string[] = [];
  for (const el of Array.from(candidates)) {
    if (el.tabIndex < 0) continue;
    if ((el as HTMLButtonElement).disabled === true) continue;
    if (el.closest("[inert], [aria-hidden='true']") !== null) continue;
    walk.push(el.closest(".tug-pane[data-pane-id]")?.getAttribute("data-pane-id") ?? "deck");
  }
  return walk;
}

/** The walk with runs collapsed: the order panes are visited in. */
function paneVisitOrder(walk: readonly string[]): string[] {
  return walk.filter((p, i) => p !== "deck" && p !== walk[i - 1]);
}

function zIndexOf(paneId: string): number {
  const el = container.querySelector<HTMLElement>(`.tug-pane[data-pane-id="${paneId}"]`);
  return Number(el?.style.zIndex ?? NaN);
}

// ---- The census ----

describe("deck-canvas focus-order census", () => {
  test("the deck mounted without an error banner", () => {
    expect(errorBannerText(container)).toBeNull();
  });

  test("pane frames render in stable id order, not store (z) order", () => {
    expect(paneFrameOrder()).toEqual(["pane-a", "pane-b", "pane-c"]);
  });

  test("Tab stops follow the panes: one per card, in id order", () => {
    expect(censusStops()).toEqual(["card-a", "card-b", "card-c"]);
  });

  test("the whole Tab walk visits each pane once, in id order, with a fixed stop count", () => {
    const walk = tabWalk();
    expect(paneVisitOrder(walk)).toEqual(["pane-a", "pane-b", "pane-c"]);
    // Pinned like the app-tests' stop counts: a pane's chrome stops plus the
    // probe's one button. A new always-live control in the pane chrome lands
    // here first — update the count in the same change and say why.
    for (const pane of ["pane-a", "pane-b", "pane-c"]) {
      expect(walk.filter((p) => p === pane).length).toBe(STOPS_PER_PANE);
    }
    expect(walk.length).toBe(3 * STOPS_PER_PANE);
  });

  test("z-index carries the store order: the last pane is frontmost", () => {
    expect(zIndexOf("pane-b")).toBeGreaterThan(zIndexOf("pane-a"));
    expect(zIndexOf("pane-a")).toBeGreaterThan(zIndexOf("pane-c"));
  });

  test("activating a card moves z and nothing in the walk", async () => {
    const framesBefore = paneFrameOrder();
    const stopsBefore = censusStops();
    const walkBefore = tabWalk();
    manager.activateCard("card-c");
    await settle();
    // The activated pane comes forward...
    expect(zIndexOf("pane-c")).toBeGreaterThan(zIndexOf("pane-a"));
    expect(zIndexOf("pane-c")).toBeGreaterThan(zIndexOf("pane-b"));
    // ...and the Tab walk is the walk it was.
    expect(paneFrameOrder()).toEqual(framesBefore);
    expect(censusStops()).toEqual(stopsBefore);
    expect(tabWalk()).toEqual(walkBefore);
  });
});
