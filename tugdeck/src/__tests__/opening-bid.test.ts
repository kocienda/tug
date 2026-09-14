/**
 * opening-bid.test.ts — unit tests for the transient per-member height a card
 * declares while it is nothing but the sheet it exists to raise ([B02]).
 *
 * `sheet-reservation.test.ts`'s shape over the neighbouring record, and for the
 * same reason: the pure core of the commit, `openingBidsWith`, is
 * testable without a live DeckManager while the verb around it is not. What
 * differs is what the record MEANS — both are floors the larger of which binds
 * ([B01]), but a reservation is measured off a sheet that is on screen and a
 * bid is declared before the card was laid out, and cleared by the first such
 * measurement — and that difference is pinned in
 * `deck-store-selectors.test.ts`, where the allocator reads both, and in
 * `sheet-reservation.test.ts`, where the measurement supersedes.
 *
 * The serialization claim is here too ([P03]): a bid is what a card declared
 * before it was laid out, nothing is arriving across a restart, and a restored
 * one would hold a settled card's floor at a height nothing on screen asked
 * for.
 */

import { describe, test, expect } from "bun:test";
import { openingBidsWith } from "../deck-manager";
import { serialize, deserialize } from "../serialization";
import type { DeckState } from "../layout-tree";

describe("openingBidsWith", () => {
  test("writes the height on the named member, from nothing standing", () => {
    expect(openingBidsWith(undefined, "pane-1", 444)).toEqual({
      "pane-1": 444,
    });
  });

  test("writes a second member's bid beside the first", () => {
    const standing = { "pane-1": 444 };
    expect(openingBidsWith(standing, "pane-2", 444)).toEqual({
      "pane-1": 444,
      "pane-2": 444,
    });
  });

  test("overwrites a member's own standing bid", () => {
    expect(openingBidsWith({ "pane-1": 444 }, "pane-1", 470)).toEqual({
      "pane-1": 470,
    });
  });

  test("clearing one of several leaves the others standing", () => {
    const next = openingBidsWith(
      { "pane-1": 444, "pane-2": 444 },
      "pane-1",
      null,
    );
    expect(next).toEqual({ "pane-2": 444 });
  });

  test("clearing the LAST entry gives undefined, never an empty record", () => {
    // Absence is the one reading of "nothing is pinned", exactly as it is for
    // a reservation: an empty record standing where the field used to be
    // absent would be a second spelling of the resting state.
    expect(
      openingBidsWith({ "pane-1": 444 }, "pane-1", null),
    ).toBeUndefined();
  });

  test("returns by IDENTITY when the height already reads that way", () => {
    // What lets `setOpeningBid` short-circuit: a re-bid at the standing
    // height is not a commit, so it arms no settle over frames already where
    // they belong.
    const standing = { "pane-1": 444 };
    expect(openingBidsWith(standing, "pane-1", 444)).toBe(standing);
  });

  test("returns by IDENTITY when clearing a member that is not bidding", () => {
    // The drop path runs on every Session card teardown, bound or not, so the
    // no-op case is the common one.
    const standing = { "pane-1": 444 };
    expect(openingBidsWith(standing, "pane-2", null)).toBe(standing);
    expect(openingBidsWith(undefined, "pane-2", null)).toBeUndefined();
  });

  test("does not mutate the record it was handed", () => {
    const standing = { "pane-1": 444 };
    openingBidsWith(standing, "pane-2", 444);
    openingBidsWith(standing, "pane-1", null);
    expect(standing).toEqual({ "pane-1": 444 });
  });
});

describe("a pin does not survive serialization", () => {
  const pinned: DeckState = {
    cards: [],
    panes: [],
    imposition: {
      kind: "two-up",
      sidebars: {},
      columns: { 0: { mode: "split", order: ["p1", "p2"] } },
    },
    openingBids: { p2: 444 },
    hasFocus: true,
  };

  test("serialize emits no pins", () => {
    // A restored bid would hold a card's floor at a height nothing on screen
    // asked for: nothing is arriving across a restart.
    const out = serialize(pinned);
    expect(JSON.stringify(out)).not.toContain("openingBids");
    // The ARRANGEMENT is serialized, and must be — only the bid against it is
    // session state.
    expect(JSON.stringify(out)).toContain('"mode":"split"');
  });

  test("a round trip comes back with the field absent", () => {
    const back = deserialize(JSON.stringify(serialize(pinned)), 1600, 1000);
    expect(back.openingBids).toBeUndefined();
  });
});
