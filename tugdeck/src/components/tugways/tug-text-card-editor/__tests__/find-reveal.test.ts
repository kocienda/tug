/**
 * How far a Text card find landing may move the view.
 *
 * Pinned because the clipped-top-line case was centred once: on a file where
 * every line matches, the landing is the scrollport's top line, and treating
 * a line clipped by a few pixels as off screen ran the view half a viewport
 * above the reader.
 */

import { describe, expect, test } from "bun:test";

import { findRevealFor, type FindRevealRect } from "../find-reveal";

const PORT: FindRevealRect = { top: 100, bottom: 700, left: 0, right: 600 };

function at(top: number, bottom: number, left = 40, right = 120): FindRevealRect {
  return { top, bottom, left, right };
}

describe("findRevealFor", () => {
  test("a match wholly inside the scrollport does not move the view", () => {
    expect(findRevealFor(at(300, 320), PORT)).toBe("none");
    expect(findRevealFor(at(100, 120), PORT)).toBe("none");
    expect(findRevealFor(at(680, 700), PORT)).toBe("none");
  });

  test("a match clipped at the top edge is revealed by the least motion", () => {
    expect(findRevealFor(at(93, 113), PORT)).toBe("nearest");
    expect(findRevealFor(at(81, 101), PORT)).toBe("nearest");
  });

  test("a match clipped at the bottom edge is revealed by the least motion", () => {
    expect(findRevealFor(at(690, 710), PORT)).toBe("nearest");
    expect(findRevealFor(at(699, 719), PORT)).toBe("nearest");
  });

  test("a vertically visible match panned out sideways only pans", () => {
    expect(findRevealFor(at(300, 320, 580, 680), PORT)).toBe("nearest");
    expect(findRevealFor(at(300, 320, 900, 980), PORT)).toBe("nearest");
  });

  test("a match with no part on screen is centred", () => {
    expect(findRevealFor(at(40, 60), PORT)).toBe("center");
    expect(findRevealFor(at(900, 920), PORT)).toBe("center");
    expect(findRevealFor(null, PORT)).toBe("center");
  });

  test("a match only touching an edge shows nothing, so it is off screen", () => {
    expect(findRevealFor(at(80, 100), PORT)).toBe("center");
    expect(findRevealFor(at(700, 720), PORT)).toBe("center");
  });
});
