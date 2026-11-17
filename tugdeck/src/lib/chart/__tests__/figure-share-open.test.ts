/**
 * Which card a figure's Share button reaches, and how wide its sheet opens.
 */

import { describe, expect, test } from "bun:test";

import {
  figureShareSheetWidth,
  openFigureShare,
  registerFigureShareOpener,
  type FigureShareRequest,
} from "../figure-share-open";

const REQUEST: FigureShareRequest = {
  source: '{"tugchart":1}',
  layers: "chart",
  diagram: false,
  baseName: "chart",
  naturalWidth: 488,
};

/** A figure's element standing under the card `cardId`'s root, or under none. */
function figureIn(cardId: string | null): Element {
  const host = { getAttribute: (name: string) => (name === "data-card-id" ? cardId : null) };
  return { closest: () => (cardId === null ? null : host) } as unknown as Element;
}

/** A pane frame that contains exactly `held`. */
function frameHolding(held: Element | null): () => Element | null {
  return () => ({ contains: (el: Element) => el === held }) as unknown as Element;
}

describe("openFigureShare", () => {
  test("the card whose root holds the figure answers, and no other", () => {
    const opened: string[] = [];
    const releases = ["A", "B"].map((cardId) =>
      registerFigureShareOpener({ cardId, frame: () => null, open: () => opened.push(cardId) }),
    );
    try {
      expect(openFigureShare(figureIn("B"), REQUEST)).toBe(true);
      expect(opened).toEqual(["B"]);
    } finally {
      for (const release of releases) release();
    }
  });

  test("a figure outside every card's root reaches the card whose pane frame contains it", () => {
    const figure = figureIn(null);
    const opened: string[] = [];
    const releases = [
      registerFigureShareOpener({ cardId: "A", frame: frameHolding(null), open: () => opened.push("A") }),
      registerFigureShareOpener({ cardId: "B", frame: frameHolding(figure), open: () => opened.push("B") }),
    ];
    try {
      expect(openFigureShare(figure, REQUEST)).toBe(true);
      expect(opened).toEqual(["B"]);
    } finally {
      for (const release of releases) release();
    }
  });

  test("the request reaches the opener as given", () => {
    const got: FigureShareRequest[] = [];
    const release = registerFigureShareOpener({ cardId: "A", frame: () => null, open: (request) => got.push(request) });
    try {
      openFigureShare(figureIn("A"), REQUEST);
      expect(got).toEqual([REQUEST]);
    } finally {
      release();
    }
  });

  test("no card answering is false, and an unregistered card no longer answers", () => {
    expect(openFigureShare(figureIn("A"), REQUEST)).toBe(false);
    const opened: string[] = [];
    const release = registerFigureShareOpener({ cardId: "A", frame: () => null, open: () => opened.push("A") });
    release();
    expect(openFigureShare(figureIn("A"), REQUEST)).toBe(false);
    expect(opened).toEqual([]);
  });
});

describe("figureShareSheetWidth", () => {
  test("a figure opens the narrowest sheet that shows it at its own size", () => {
    expect(figureShareSheetWidth(320)).toBe("sm");
    expect(figureShareSheetWidth(406)).toBe("sm");
    expect(figureShareSheetWidth(407)).toBe("md");
    expect(figureShareSheetWidth(520)).toBe("lg");
    expect(figureShareSheetWidth(640)).toBe("xl");
  });

  test("a figure wider than every tier, or of unknown width, opens the widest", () => {
    expect(figureShareSheetWidth(1400)).toBe("xl");
    expect(figureShareSheetWidth(0)).toBe("xl");
    expect(figureShareSheetWidth(Number.NaN)).toBe("xl");
  });
});
