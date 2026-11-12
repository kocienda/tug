/**
 * The `from` a door sends on New's and Duplicate's payload: read back as a
 * rect with its card id, or as none when the door has no place on screen.
 *
 * @covers tugdeck/src/lib/workspace-name-zoom.ts
 */

import { describe, expect, test } from "bun:test";

import { readZoomSource, zoomSourceInWindow } from "../workspace-name-zoom";

const RECT = { top: 30, left: 260, width: 20, height: 20 };

describe("readZoomSource", () => {
  test("reads the card id and rect the `+` sent", () => {
    expect(readZoomSource({ from: { cardId: "cards-1", rect: RECT } })).toEqual({ cardId: "cards-1", rect: RECT });
  });

  test("reads it beside Duplicate's spaceId", () => {
    expect(readZoomSource({ spaceId: "s2", from: { cardId: "cards-1", rect: RECT } })).toEqual({
      cardId: "cards-1",
      rect: RECT,
    });
  });

  test("is none for a door with no place on screen: no payload, or one with no from", () => {
    expect(readZoomSource(undefined)).toBeNull();
    expect(readZoomSource({})).toBeNull();
    expect(readZoomSource({ spaceId: "s2" })).toBeNull();
  });

  test("is none for a from that is not a rect with a card id", () => {
    expect(readZoomSource({ from: { rect: RECT } })).toBeNull();
    expect(readZoomSource({ from: { cardId: "cards-1" } })).toBeNull();
    expect(readZoomSource({ from: { cardId: "cards-1", rect: { ...RECT, top: "30" } } })).toBeNull();
    expect(readZoomSource({ from: { cardId: "cards-1", rect: { ...RECT, left: Number.NaN } } })).toBeNull();
  });

  test("is none for an empty rect: there is nothing to run from", () => {
    expect(readZoomSource({ from: { cardId: "cards-1", rect: { ...RECT, width: 0 } } })).toBeNull();
  });
});

describe("zoomSourceInWindow", () => {
  test("is none with no source", () => {
    expect(zoomSourceInWindow(null)).toBeNull();
  });

  test("stands as it is for a card the shell draws, which shares the shell's viewport", () => {
    expect(zoomSourceInWindow({ cardId: "not-a-body-card", rect: RECT })).toEqual(RECT);
  });
});
