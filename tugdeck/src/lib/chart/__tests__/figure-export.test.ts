/**
 * The choice of actions a figure's header makes, and the names it gives them.
 */

import { describe, expect, test } from "bun:test";

import {
  FIGURE_BASE_NAME_LIMIT,
  figureBaseName,
  figureCopyLabel,
  figureHeaderActions,
  figureShareLabel,
} from "../figure-export";

describe("figureHeaderActions", () => {
  test("a drawn figure in the app copies the picture and offers Share", () => {
    expect(figureHeaderActions({ drawn: true, hostShares: true, sharePage: false })).toEqual({
      copy: "picture",
      share: true,
    });
  });

  test("with no host to render, Copy copies the source and there is no Share", () => {
    expect(figureHeaderActions({ drawn: true, hostShares: false, sharePage: false })).toEqual({
      copy: "source",
      share: false,
    });
  });

  test("a figure that did not draw keeps Copy source, host or no host", () => {
    for (const hostShares of [true, false]) {
      expect(figureHeaderActions({ drawn: false, hostShares, sharePage: false })).toEqual({
        copy: "source",
        share: false,
      });
    }
  });

  test("the share page offers neither picture action", () => {
    expect(figureHeaderActions({ drawn: true, hostShares: true, sharePage: true })).toEqual({
      copy: "source",
      share: false,
    });
  });

  test("Share is offered exactly where Copy copies the picture", () => {
    for (const drawn of [true, false]) {
      for (const hostShares of [true, false]) {
        for (const sharePage of [true, false]) {
          const actions = figureHeaderActions({ drawn, hostShares, sharePage });
          expect(actions.share).toBe(actions.copy === "picture");
        }
      }
    }
  });
});

describe("the header's labels", () => {
  test("Copy says what it copies", () => {
    expect(figureCopyLabel("picture", false)).toBe("Copy chart");
    expect(figureCopyLabel("picture", true)).toBe("Copy diagram");
    expect(figureCopyLabel("source", false)).toBe("Copy chart source");
    expect(figureCopyLabel("source", true)).toBe("Copy diagram source");
  });

  test("Share names the figure's kind", () => {
    expect(figureShareLabel(false)).toBe("Share chart");
    expect(figureShareLabel(true)).toBe("Share diagram");
  });
});

describe("figureBaseName", () => {
  test("a caption becomes hyphenated lowercase words", () => {
    expect(figureBaseName("Build time doubled this week", false)).toBe("build-time-doubled-this-week");
  });

  test("punctuation and path separators never reach the name", () => {
    expect(figureBaseName("  A/B: 50% faster… (really) ", true)).toBe("a-b-50-faster-really");
  });

  test("letters beyond ASCII are kept", () => {
    expect(figureBaseName("Zeit über Größe", false)).toBe("zeit-über-größe");
  });

  test("an empty or wordless caption falls back to the figure's kind", () => {
    expect(figureBaseName("", false)).toBe("chart");
    expect(figureBaseName("—", true)).toBe("diagram");
  });

  test("a long caption is cut at the limit, with no trailing hyphen", () => {
    const name = figureBaseName("word ".repeat(40), false);
    expect(name.length).toBeLessThanOrEqual(FIGURE_BASE_NAME_LIMIT);
    expect(name.endsWith("-")).toBe(false);
  });
});
