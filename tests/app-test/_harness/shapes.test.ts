/**
 * shapes.test.ts — the shared Session-card deck is the literal the corpus used
 * to copy, so a file that switched to it seeds exactly what it seeded before.
 */

import { describe, expect, test } from "bun:test";

import {
  priorCardDeck,
  SESSION_CARD_SIZE_COMPACT,
  sessionCardShape,
} from "./shapes";

describe("priorCardDeck", () => {
  test("is the one-Accordion deck the corpus copied", () => {
    expect(priorCardDeck()).toEqual({
      cards: [{ id: "A", componentId: "gallery-accordion", title: "Accordion", closable: true }],
      panes: [
        {
          id: "pA",
          position: { x: 60, y: 60 },
          size: { width: 520, height: 420 },
          cardIds: ["A"],
          activeCardId: "A",
          title: "",
          acceptsFamilies: ["maker"],
        },
      ],
      activePaneId: "pA",
      hasFocus: true,
    });
  });

  test("takes the size and the card", () => {
    const deck = priorCardDeck({ size: { width: 900, height: 700 }, card: { componentId: "text", title: "File" } });
    expect(deck.panes[0].size).toEqual({ width: 900, height: 700 });
    expect(deck.cards[0]).toEqual({ id: "A", componentId: "text", title: "File", closable: true });
  });
});

describe("sessionCardShape", () => {
  test("is the one-Session-card deck the corpus copied, at the default size", () => {
    expect(sessionCardShape()).toEqual({
      cards: [{ id: "A", componentId: "session", title: "Session", closable: true }],
      panes: [
        {
          id: "p1",
          position: { x: 40, y: 40 },
          size: { width: 900, height: 680 },
          cardIds: ["A"],
          activeCardId: "A",
          title: "",
          acceptsFamilies: ["maker"],
        },
      ],
      activePaneId: "p1",
      hasFocus: true,
    });
  });

  test("takes the size and the title, and changes nothing else", () => {
    const shape = sessionCardShape(SESSION_CARD_SIZE_COMPACT, { title: "Session A" });
    expect(shape.panes[0].size).toEqual({ width: 820, height: 620 });
    expect(shape.cards[0].title).toBe("Session A");
    expect({ ...shape, cards: [], panes: [] }).toEqual({ ...sessionCardShape(), cards: [], panes: [] });
  });

  test("hands out a fresh size, so a test that mutates its deck cannot move the constant", () => {
    const shape = sessionCardShape(SESSION_CARD_SIZE_COMPACT);
    shape.panes[0].size.width = 1;
    expect(SESSION_CARD_SIZE_COMPACT.width).toBe(820);
  });
});
