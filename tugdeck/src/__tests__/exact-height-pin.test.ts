/**
 * exact-height-pin.test.ts — unit tests for the transient per-member EXACT
 * height a card declares while it is nothing but the sheet it exists to raise
 * ([P01]).
 *
 * `sheet-reservation.test.ts`'s shape over the neighbouring record, and for the
 * same reason: the pure core of the commit, `exactMemberHeightsWith`, is
 * testable without a live DeckManager while the verb around it is not. What
 * differs is what the record MEANS — a reservation is a floor a taller member
 * ignores, a pin is the height the member stands at — and that difference is
 * pinned in `deck-store-selectors.test.ts`, where the allocator reads both.
 *
 * The serialization claim is here too ([P03]): a pin says what a card is worth
 * while it is UNBOUND, and a restored one would stand a bound card at a
 * picker's height with no picker on it.
 */

import { describe, test, expect } from "bun:test";
import { exactMemberHeightsWith } from "../deck-manager";
import { serialize, deserialize } from "../serialization";
import type { DeckState } from "../layout-tree";

describe("exactMemberHeightsWith", () => {
  test("writes the height on the named member, from nothing standing", () => {
    expect(exactMemberHeightsWith(undefined, "pane-1", 444)).toEqual({
      "pane-1": 444,
    });
  });

  test("writes a second member's pin beside the first", () => {
    const standing = { "pane-1": 444 };
    expect(exactMemberHeightsWith(standing, "pane-2", 444)).toEqual({
      "pane-1": 444,
      "pane-2": 444,
    });
  });

  test("overwrites a member's own standing pin", () => {
    expect(exactMemberHeightsWith({ "pane-1": 444 }, "pane-1", 470)).toEqual({
      "pane-1": 470,
    });
  });

  test("clearing one of several leaves the others standing", () => {
    const next = exactMemberHeightsWith(
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
      exactMemberHeightsWith({ "pane-1": 444 }, "pane-1", null),
    ).toBeUndefined();
  });

  test("returns by IDENTITY when the height already reads that way", () => {
    // What lets `setMemberExactHeight` short-circuit: a re-pin at the standing
    // height is not a commit, so it arms no settle over frames already where
    // they belong.
    const standing = { "pane-1": 444 };
    expect(exactMemberHeightsWith(standing, "pane-1", 444)).toBe(standing);
  });

  test("returns by IDENTITY when clearing a member that is not pinned", () => {
    // The drop path runs on every Session card teardown, bound or not, so the
    // no-op case is the common one.
    const standing = { "pane-1": 444 };
    expect(exactMemberHeightsWith(standing, "pane-2", null)).toBe(standing);
    expect(exactMemberHeightsWith(undefined, "pane-2", null)).toBeUndefined();
  });

  test("does not mutate the record it was handed", () => {
    const standing = { "pane-1": 444 };
    exactMemberHeightsWith(standing, "pane-2", 444);
    exactMemberHeightsWith(standing, "pane-1", null);
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
    exactMemberHeights: { p2: 444 },
    hasFocus: true,
  };

  test("serialize emits no pins", () => {
    // A restored pin would stand a card at a picker's height with no picker on
    // it: no card is unbound across a restart in any way the deck can know.
    const out = serialize(pinned);
    expect(JSON.stringify(out)).not.toContain("exactMemberHeights");
    // The ARRANGEMENT is serialized, and must be — only the pin against it is
    // session state.
    expect(JSON.stringify(out)).toContain('"mode":"split"');
  });

  test("a round trip comes back with the field absent", () => {
    const back = deserialize(JSON.stringify(serialize(pinned)), 1600, 1000);
    expect(back.exactMemberHeights).toBeUndefined();
  });
});
