/**
 * shapes.ts — deck states a test seeds with `app.seedDeckState({ state })`.
 *
 * The commonest deck in the corpus is one Session card alone in one pane, and
 * it used to be written out as a local `deckShape()` in each file that wanted
 * it — the same object literal, byte for byte, differing only in the pane's
 * size. A copied fixture is one nobody reviews; this one is.
 *
 * A file whose deck is anything else — more cards, more panes, a rail, a
 * different card kind — keeps its own `deckShape`, because that deck is the
 * test's subject rather than its furniture.
 */

/** A pane's size, in deck layout px. */
export interface PaneSize {
  width: number;
  height: number;
}

/** The corpus's default Session pane: room for a transcript and its entry. */
export const SESSION_CARD_SIZE: PaneSize = { width: 900, height: 680 };

/** A smaller Session pane, for files that want margin around it on the deck. */
export const SESSION_CARD_SIZE_COMPACT: PaneSize = { width: 820, height: 620 };

/** The default width at a shorter height. */
export const SESSION_CARD_SIZE_SHORT: PaneSize = { width: 900, height: 640 };

export interface SessionCardShapeOptions {
  /** The card's title. Default `"Session"`. */
  title?: string;
}

/**
 * One Session card, id `"A"`, alone and active in pane `"p1"` at (40, 40),
 * with the deck focused.
 */
export function sessionCardShape(
  size: PaneSize = SESSION_CARD_SIZE,
  options: SessionCardShapeOptions = {},
) {
  return {
    cards: [{ id: "A", componentId: "session", title: options.title ?? "Session", closable: true }],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: size.width, height: size.height },
        cardIds: ["A"],
        activeCardId: "A",
        title: "",
        acceptsFamilies: ["maker"],
      },
    ],
    activePaneId: "p1",
    hasFocus: true,
  };
}

/** The card a {@link priorCardDeck} holds. */
export interface PriorCard {
  componentId: string;
  title: string;
}

export interface PriorCardDeckOptions {
  /** The pane's size. Default 520×420. */
  size?: PaneSize;
  /** The card. Default the gallery Accordion. */
  card?: PriorCard;
}

/**
 * One content card, id `"A"`, alone and active in pane `"pA"` at (60, 60),
 * with the deck focused — the card a sidebar gesture leaves behind and comes
 * back to.
 */
export function priorCardDeck(options: PriorCardDeckOptions = {}) {
  const size = options.size ?? { width: 520, height: 420 };
  const card = options.card ?? { componentId: "gallery-accordion", title: "Accordion" };
  return {
    cards: [{ id: "A", componentId: card.componentId, title: card.title, closable: true }],
    panes: [
      {
        id: "pA",
        position: { x: 60, y: 60 },
        size: { width: size.width, height: size.height },
        cardIds: ["A"],
        activeCardId: "A",
        title: "",
        acceptsFamilies: ["maker"],
      },
    ],
    activePaneId: "pA",
    hasFocus: true,
  };
}
