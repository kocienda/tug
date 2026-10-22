/**
 * The close advice a card's own chrome reads when it closes its pane.
 *
 * An empty Session card waives its close confirm, but only as the one card
 * of its pane: a pane of several keeps its "Close N Tabs?" confirm whatever
 * any one card says, because that confirm is about discarding every tab at
 * once. The shell's pane has held this rule; a card that draws its own chrome
 * holds the same one.
 *
 * @covers tugdeck/src/body/body-chrome.ts
 */
import { describe, expect, test } from "bun:test";

import { chromeFrameWhole, soleCardCloseAdvice } from "../body-chrome";
import type { CardMastheadPayload } from "../../lib/card-title-store";

const WAIVE = { waive: true };

describe("the close advice a card's chrome reads", () => {
  test("the sole card of its pane answers for the pane", () => {
    expect(soleCardCloseAdvice(1, () => WAIVE)).toBe(WAIVE);
    // A pane of one wears no tab bar, so its pane facts name no tabs at all.
    expect(soleCardCloseAdvice(0, () => WAIVE)).toBe(WAIVE);
  });

  test("a pane of several keeps its confirm, and never asks the card", () => {
    let asked = false;
    expect(
      soleCardCloseAdvice(2, () => {
        asked = true;
        return WAIVE;
      }),
    ).toBeNull();
    expect(asked).toBe(false);
  });
});

/**
 * When a card's own chrome frame may tell the host it has painted: the host
 * shows the card on that word, so a frame drawing its one-line bar where the
 * shell's stand-in drew a masthead would show the card with an empty title.
 */
describe("when a card's chrome frame is whole", () => {
  const MASTHEAD = { kind: "session-masthead", sessionId: "s-1" } as CardMastheadPayload;

  test("a frame drawing the masthead the shell holds is whole", () => {
    expect(chromeFrameWhole(true, true, MASTHEAD)).toBe(true);
  });

  test("a frame whose masthead has not arrived, where the shell holds one, is not", () => {
    expect(chromeFrameWhole(true, true, null)).toBe(false);
  });

  test("a card the shell holds no masthead for is whole with its chrome", () => {
    expect(chromeFrameWhole(true, false, null)).toBe(true);
  });

  test("nothing is whole before the shell's pane facts or its card facts arrive", () => {
    expect(chromeFrameWhole(false, false, null)).toBe(false);
    expect(chromeFrameWhole(true, undefined, MASTHEAD)).toBe(false);
  });
});
