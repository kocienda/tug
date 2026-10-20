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

import { soleCardCloseAdvice } from "../body-chrome";

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
