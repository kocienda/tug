/**
 * Where the reader is in the Workspaces list: the anchor's arithmetic, and the
 * anchor as one fact the shell holds for every Workspaces card's page.
 *
 * @covers tugdeck/src/lib/cards-list-anchor.ts
 * @covers tugdeck/src/bus/declarations/arrangement.ts
 */

import { afterEach, describe, expect, test } from "bun:test";

import {
  anchorAfterScroll,
  anchorForRow,
  scrollTopForAnchor,
  shareCardsListAnchor,
  type AnchorRow,
} from "../cards-list-anchor";
import { createTestBus, type TestBus } from "../../bus/test-bus";
import { cardsListAnchor } from "../../bus/declarations/arrangement";

/** Thirty rows of 28 px, one after another, ids `r0`…`r29`. */
const ROWS: AnchorRow[] = Array.from({ length: 30 }, (_, i) => ({
  id: `r${i}`,
  top: i * 28,
  height: 28,
}));
const row = (i: number): AnchorRow => ROWS[i];
const LIST_HEIGHT = 30 * 28;

describe("anchorForRow", () => {
  test("the offset is the row's distance below the scroller's top edge", () => {
    expect(anchorForRow(row(18), 200)).toEqual({ rowId: "r18", offset: 18 * 28 - 200 });
  });
});

describe("anchorAfterScroll", () => {
  test("a row the anchor names keeps it while any of it is in view", () => {
    const held = anchorAfterScroll(ROWS, 300, 400, { rowId: "r18", offset: 100 });
    expect(held).toEqual({ rowId: "r18", offset: 18 * 28 - 300 });
    // r10's top is at 280 and its bottom at 308: two pixels still show.
    expect(anchorAfterScroll(ROWS, 306, 400, { rowId: "r10", offset: 0 })?.rowId).toBe("r10");
  });

  test("once the anchored row is out of view, the first row in view takes over", () => {
    expect(anchorAfterScroll(ROWS, 400, 300, { rowId: "r2", offset: 0 })).toEqual({
      rowId: "r14",
      offset: 14 * 28 - 400,
    });
  });

  test("with no anchor yet, the first row in view — partly scrolled off — is the anchor", () => {
    expect(anchorAfterScroll(ROWS, 30, 300, null)).toEqual({ rowId: "r1", offset: -2 });
  });

  test("an anchor whose row is gone from this list falls back the same way", () => {
    expect(anchorAfterScroll(ROWS, 0, 300, { rowId: "gone", offset: 50 })?.rowId).toBe("r0");
  });

  test("a list with nothing in view has no anchor", () => {
    expect(anchorAfterScroll([], 0, 300, null)).toBeNull();
  });
});

describe("scrollTopForAnchor", () => {
  const tall = { clientHeight: 500, scrollHeight: LIST_HEIGHT };

  test("a matching box puts the row back at its offset exactly", () => {
    const before = anchorForRow(row(18), 160);
    expect(scrollTopForAnchor(before, row(18), tall)).toBe(160);
  });

  test("an arriving card that is shorter clamps the offset nearest, keeping the row in view", () => {
    // Anchored 450 px down a 500 px card; the arriving card is 200 px tall.
    const anchor = { rowId: "r18", offset: 450 };
    const short = { clientHeight: 200, scrollHeight: LIST_HEIGHT };
    const top = scrollTopForAnchor(anchor, row(18), short)!;
    const offset = row(18).top - top;
    expect(offset).toBe(200 - 28);
    expect(offset + row(18).height).toBeLessThanOrEqual(short.clientHeight);
  });

  test("near either end the scroller's range wins, leaving the row as near its offset as it goes", () => {
    expect(scrollTopForAnchor({ rowId: "r1", offset: 0 }, row(1), tall)).toBe(28);
    expect(scrollTopForAnchor({ rowId: "r1", offset: 100 }, row(1), tall)).toBe(0);
    expect(scrollTopForAnchor({ rowId: "r29", offset: 0 }, row(29), tall)).toBe(LIST_HEIGHT - 500);
  });

  test("a row this list does not draw leaves the scroller alone", () => {
    expect(scrollTopForAnchor({ rowId: "r18", offset: 10 }, null, tall)).toBeNull();
    expect(scrollTopForAnchor({ rowId: "r18", offset: 10 }, row(3), tall)).toBeNull();
  });
});

describe("the anchor is the shell's, one for every Workspaces card's page", () => {
  let bus: TestBus;
  afterEach(() => bus?.dispose());

  test("a card's proposal is what every other card reads", async () => {
    bus = createTestBus();
    const shell = bus.shell();
    shareCardsListAnchor(shell.bus);
    const one = bus.body("cards-1", "cards");
    const two = bus.body("cards-2", "cards");
    await bus.flush();

    cardsListAnchor.on(one.bus).propose({ rowId: "r18", offset: 509 });
    await bus.flush();
    expect(cardsListAnchor.on(shell.bus).getSnapshot()).toEqual({ rowId: "r18", offset: 509 });
    expect(cardsListAnchor.on(two.bus).getSnapshot()).toEqual({ rowId: "r18", offset: 509 });
  });

  test("with no Workspaces card on screen the anchor stands, and the next card to come up reads it", async () => {
    bus = createTestBus();
    const shell = bus.shell();
    shareCardsListAnchor(shell.bus);
    const one = bus.body("cards-1", "cards");
    await bus.flush();
    cardsListAnchor.on(one.bus).propose({ rowId: "r12", offset: 240 });
    await bus.flush();

    // The reader goes to a workspace with no Workspaces card: the card they
    // left goes away, and nothing reads the anchor for as long as that lasts.
    bus.detach("cards-1");
    await bus.flush();
    expect(cardsListAnchor.on(shell.bus).getSnapshot()).toEqual({ rowId: "r12", offset: 240 });

    const later = bus.body("cards-3", "cards");
    await bus.flush();
    expect(cardsListAnchor.on(later.bus).getSnapshot()).toEqual({ rowId: "r12", offset: 240 });
  });

  test("only Workspaces cards' pages are sent it", async () => {
    bus = createTestBus();
    const shell = bus.shell();
    shareCardsListAnchor(shell.bus);
    const cards = bus.body("cards-1", "cards");
    const session = bus.body("session-1", "session");
    await bus.flush();
    cardsListAnchor.on(cards.bus).propose({ rowId: "r3", offset: 0 });
    await bus.flush();
    expect(cardsListAnchor.on(session.bus).arrived()).toBe(false);
  });
});
