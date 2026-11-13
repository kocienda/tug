/**
 * A hidden page is stale exactly when a value it draws moved: its card's
 * theme, its pane's chrome, its context, its own card entry, or the zoom,
 * keyboard-access and motion facts — and, for a kind that renders other
 * cards, any card's entry and the arrangement. The screen's theme, the
 * modifier latch and app activity move nothing it draws.
 *
 * @covers tugdeck/src/body/body-staleness.ts
 */
import { describe, expect, test } from "bun:test";

import type { DeckFactsValue } from "../../bus/declarations/deck";
import { drawnSignature, movedParts, staleAfter, type DrawnValues } from "../body-staleness";

const FACTS: DeckFactsValue = {
  theme: "ironclad",
  zoom: 1,
  keyboardAccess: false,
  modifierLatch: [],
  focusRingModality: "pointer",
  appActive: true,
  motionDemoted: false,
};

const BASE: DrawnValues = {
  cardTheme: "caravel",
  paneChrome: { tabs: ["me"] },
  cardContext: { project: "/p" },
  deckCards: { me: { title: "Me" }, other: { title: "Other" } },
  deckFacts: FACTS,
  arrangement: null,
  cardsList: { anchor: null, cursor: null },
};

const sig = (values: DrawnValues, rendersOthers = false) => drawnSignature("me", values, rendersOthers);

describe("the Workspaces list", () => {
  test("a move in the list's anchor or cursor is stale, whatever the kind", () => {
    const hidden = sig(BASE);
    expect(staleAfter(hidden, sig({ ...BASE, cardsList: { anchor: { rowId: "a", offset: 12 }, cursor: null } }))).toBe(true);
    expect(staleAfter(hidden, sig({ ...BASE, cardsList: { anchor: null, cursor: "a" } }))).toBe(true);
    expect(movedParts(hidden, sig({ ...BASE, cardsList: { anchor: null, cursor: "a" } }))).toEqual(["cardsList"]);
  });
});

describe("drawnSignature", () => {
  test("a card theme or pane chrome move is stale", () => {
    const hidden = sig(BASE);
    expect(staleAfter(hidden, sig({ ...BASE, cardTheme: "sloop" }))).toBe(true);
    expect(staleAfter(hidden, sig({ ...BASE, paneChrome: { tabs: ["me", "new"] } }))).toBe(true);
    expect(staleAfter(hidden, sig({ ...BASE, deckCards: { ...BASE.deckCards, me: { title: "Renamed" } } }))).toBe(true);
    expect(staleAfter(hidden, sig({ ...BASE, deckFacts: { ...FACTS, zoom: 1.25 } }))).toBe(true);
  });

  test("the screen's theme, the modifier latch or app activity alone is not", () => {
    const hidden = sig(BASE);
    expect(staleAfter(hidden, sig({ ...BASE, deckFacts: { ...FACTS, theme: "sloop" } }))).toBe(false);
    expect(staleAfter(hidden, sig({ ...BASE, deckFacts: { ...FACTS, modifierLatch: ["cmd"] } }))).toBe(false);
    expect(staleAfter(hidden, sig({ ...BASE, deckFacts: { ...FACTS, appActive: false, focusRingModality: "keyboard" } }))).toBe(false);
  });

  test("another card's entry moves the signature only for a kind that renders other cards", () => {
    const moved = { ...BASE, deckCards: { ...BASE.deckCards, other: { title: "Moved" } } };
    expect(staleAfter(sig(BASE), sig(moved))).toBe(false);
    expect(staleAfter(sig(BASE, true), sig(moved, true))).toBe(true);
    const arranged = { ...BASE, arrangement: { deck: 1, spaces: 1 } };
    expect(staleAfter(sig(arranged), sig({ ...arranged, arrangement: { deck: 2, spaces: 1 } }))).toBe(false);
    expect(staleAfter(sig(arranged, true), sig({ ...arranged, arrangement: { deck: 2, spaces: 1 } }, true))).toBe(true);
  });

  test("a switch's keyboard move or shown flag alone is not, its own key-ness or focus is", () => {
    const ctx = { folded: false, focused: false, firstResponderCardId: "a", layerShown: false };
    const hidden = sig({ ...BASE, cardContext: ctx });
    expect(staleAfter(hidden, sig({ ...BASE, cardContext: { ...ctx, firstResponderCardId: "b", layerShown: true } }))).toBe(false);
    expect(staleAfter(hidden, sig({ ...BASE, cardContext: { ...ctx, firstResponderCardId: "me" } }))).toBe(true);
    expect(staleAfter(hidden, sig({ ...BASE, cardContext: { ...ctx, focused: true } }))).toBe(true);
  });

  test("a page with no signature taken is never stale", () => {
    expect(staleAfter(null, sig(BASE))).toBe(false);
  });

  test("the moved parts name what made a page stale", () => {
    expect(movedParts(sig(BASE), sig({ ...BASE, cardTheme: "sloop", deckFacts: { ...FACTS, zoom: 2 } }))).toEqual(["cardTheme", "deckFacts"]);
    expect(movedParts(sig(BASE), sig(BASE))).toEqual([]);
  });
});
