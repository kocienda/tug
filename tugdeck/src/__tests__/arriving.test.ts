/**
 * arriving.test.ts — the ARRIVING mark: a pane drawn in its column but not yet
 * part of its division ([B01], [B08]).
 *
 * `opening-bid.test.ts`'s shape over the third record, and for the same reason:
 * the pure core of the commit, `arrivingWith`, is testable without a live
 * DeckManager while the verb around it is not. What the record MEANS is pinned
 * here too, against the selectors that read it: a marked pane is left out of
 * `columnMembersOf`, `deckColumnsOf` and `placeMembers`, so the standing
 * members divide the run exactly as they did before the pane was appended.
 * That is the whole point of the mark — the commit that appends a hidden card
 * moves nothing the user can see — and the claim is made the way
 * `arrival-shares.test.ts` makes its own, over the HEIGHTS the division
 * produces rather than over the record.
 *
 * The serialization claim is here as well: nothing is arriving across a
 * restart, and a restored mark would hold a settled card hidden with nothing
 * to reveal it.
 */

import { describe, test, expect } from "bun:test";
import { arrivingWith } from "../deck-manager";
import {
  columnMembersOf,
  deckColumnsOf,
  placeMembers,
} from "../deck-store-selectors";
import { serialize, deserialize } from "../serialization";
import {
  sweptArriving,
  type CardState,
  type DeckState,
  type TugPaneState,
} from "../layout-tree";

// ---------------------------------------------------------------------------
// The record
// ---------------------------------------------------------------------------

describe("arrivingWith", () => {
  test("marks a pane on an absent record", () => {
    expect(arrivingWith(undefined, "pane-1", true)).toEqual({ "pane-1": true });
  });

  test("marks a second pane beside the first", () => {
    const standing = { "pane-1": true as const };
    expect(arrivingWith(standing, "pane-2", true)).toEqual({
      "pane-1": true,
      "pane-2": true,
    });
  });

  test("dropping one of two marks leaves the other", () => {
    const next = arrivingWith(
      { "pane-1": true, "pane-2": true },
      "pane-1",
      false,
    );
    expect(next).toEqual({ "pane-2": true });
  });

  test("dropping the last mark takes the field with it", () => {
    // Absent, rather than empty: absence is the one reading of "nothing
    // arriving", and an empty record would be a second one.
    expect(arrivingWith({ "pane-1": true }, "pane-1", false)).toBeUndefined();
  });

  test("returns the SAME object when nothing changes", () => {
    const standing = { "pane-1": true as const };
    expect(arrivingWith(standing, "pane-1", true)).toBe(standing);
    expect(arrivingWith(standing, "pane-2", false)).toBe(standing);
    expect(arrivingWith(undefined, "pane-2", false)).toBeUndefined();
  });

  test("never mutates the record it was handed", () => {
    const standing = { "pane-1": true as const };
    arrivingWith(standing, "pane-2", true);
    arrivingWith(standing, "pane-1", false);
    expect(standing).toEqual({ "pane-1": true });
  });
});

// ---------------------------------------------------------------------------
// The division leaves a marked pane out ([B08])
// ---------------------------------------------------------------------------

function makeCard(id: string): CardState {
  return { id, componentId: "probe", title: id, closable: true };
}

function makePane(id: string, slot: number): TugPaneState {
  return {
    id,
    position: { x: 0, y: 0 },
    size: { width: 400, height: 300 },
    cardIds: [`card-${id}`],
    activeCardId: `card-${id}`,
    title: "",
    acceptsFamilies: ["standard"],
    slot,
  };
}

/** The run these fixtures divide. The assertions compare two divisions of
 *  the same run, so any positive number does. */
const RUN = 1000;

/** A split column in slot 0 holding `paneIds` in that order, with whatever
 *  shares are standing and whatever pane is marked arriving. */
function splitColumn(
  paneIds: readonly string[],
  opts: {
    shares?: Readonly<Record<string, number>>;
    arriving?: Readonly<Record<string, true>>;
  } = {},
): DeckState {
  return {
    cards: paneIds.map((id) => makeCard(`card-${id}`)),
    panes: paneIds.map((id) => makePane(id, 0)),
    imposition: {
      kind: "two-up",
      sidebars: {},
      columns: {
        0: {
          mode: "split",
          order: [...paneIds],
          ...(opts.shares !== undefined ? { shares: opts.shares } : {}),
        },
      },
    },
    hasFocus: true,
    ...(opts.arriving !== undefined ? { arriving: opts.arriving } : {}),
  };
}

/** Each standing member's height, keyed by pane id, as the column divides
 *  `RUN` — the thing the eye sees, and so the thing the claim is about. */
function heightsOf(state: DeckState): Record<string, number> {
  const column = deckColumnsOf(state, RUN).find((c) => c.slot === 0);
  if (column === undefined || column.allocation === null) return {};
  return Object.fromEntries(
    column.allocation.ids.map((id, i) => [id, column.allocation!.heights[i]]),
  );
}

describe("an arriving pane is left out of its column's division", () => {
  const SHARES = { "pane-a": 3, "pane-b": 1 };

  test("columnMembersOf and deckColumnsOf list the standing members only", () => {
    const state = splitColumn(["pane-a", "pane-b", "pane-c"], {
      arriving: { "pane-c": true },
    });
    expect(columnMembersOf(state, 0)).toEqual(["pane-a", "pane-b"]);
    const column = deckColumnsOf(state, RUN).find((c) => c.slot === 0);
    expect(column?.members).toEqual(["pane-a", "pane-b"]);
    expect(column?.allocation?.ids).toEqual(["pane-a", "pane-b"]);
    // And the seams: one gap between the two standing members, not two.
    expect(column?.seams.length).toBe(1);
  });

  test("every standing rect is exactly what it was before the pane was appended", () => {
    // The claim the mark exists for: the commit that appends a hidden card
    // changes no neighbour's height. Two states — the column before the
    // arrival, and the column with the arrival appended and marked — divide
    // the run identically.
    const before = splitColumn(["pane-a", "pane-b"], { shares: SHARES });
    const withArrival = splitColumn(["pane-a", "pane-b", "pane-c"], {
      shares: SHARES,
      arriving: { "pane-c": true },
    });
    const standing = heightsOf(before);
    const marked = heightsOf(withArrival);
    expect(Object.keys(standing)).toEqual(["pane-a", "pane-b"]);
    expect(marked).toEqual(standing);
    // The arriving pane took no share of the run at all.
    expect(marked["pane-c"]).toBeUndefined();
  });

  test("the same pane unmarked joins the division and moves its neighbours", () => {
    // The control: without the mark a third member takes its share and the
    // standing rects shrink. This is the motion the mark defers to the reveal.
    const before = splitColumn(["pane-a", "pane-b"], { shares: SHARES });
    const revealed = splitColumn(["pane-a", "pane-b", "pane-c"], {
      shares: SHARES,
    });
    const standing = heightsOf(before);
    const joined = heightsOf(revealed);
    expect(Object.keys(joined)).toEqual(["pane-a", "pane-b", "pane-c"]);
    expect(joined["pane-c"]).toBeGreaterThan(0);
    expect(joined["pane-a"]).toBeLessThan(standing["pane-a"]);
  });

  test("placeMembers handed an arriving id returns the standing members only", () => {
    // Belt to the selectors' braces: a caller that reads membership some
    // other way and hands the marked id in still gets a division that never
    // saw it.
    const state = splitColumn(["pane-a", "pane-b", "pane-c"], {
      arriving: { "pane-c": true },
    });
    const members = placeMembers(
      state,
      "column",
      ["pane-a", "pane-b", "pane-c"],
      undefined,
    );
    expect(members.map((m) => m.id)).toEqual(["pane-a", "pane-b"]);
  });

  test("a mark on a pane in another slot changes nothing here", () => {
    const state: DeckState = {
      ...splitColumn(["pane-a", "pane-b"], { shares: SHARES }),
      arriving: { "pane-elsewhere": true },
    };
    expect(heightsOf(state)).toEqual(
      heightsOf(splitColumn(["pane-a", "pane-b"], { shares: SHARES })),
    );
  });
});

// ---------------------------------------------------------------------------
// A mark does not outlive its pane
// ---------------------------------------------------------------------------

describe("sweptArriving", () => {
  test("returns the SAME object when every marked pane is live", () => {
    const state = splitColumn(["pane-a", "pane-b"], {
      arriving: { "pane-b": true },
    });
    expect(sweptArriving(state)).toBe(state);
    // And when nothing is marked at all.
    const unmarked = splitColumn(["pane-a"]);
    expect(sweptArriving(unmarked)).toBe(unmarked);
  });

  test("drops a mark whose pane is gone and keeps the rest", () => {
    // A card closed between its hidden commit and its reveal: the pane is
    // removed by the close, and the mark is swept at the next commit point.
    const state: DeckState = {
      ...splitColumn(["pane-a", "pane-b"]),
      arriving: { "pane-b": true, "pane-gone": true },
    };
    expect(sweptArriving(state).arriving).toEqual({ "pane-b": true });
  });

  test("the field goes away with its last stale mark", () => {
    const state: DeckState = {
      ...splitColumn(["pane-a"]),
      arriving: { "pane-gone": true },
    };
    const swept = sweptArriving(state);
    expect(swept.arriving).toBeUndefined();
    expect("arriving" in swept).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The mark does not survive serialization
// ---------------------------------------------------------------------------

describe("a mark does not survive serialization", () => {
  const marked: DeckState = {
    ...splitColumn(["p1", "p2"]),
    arriving: { p2: true },
  };

  test("serialize emits no mark", () => {
    const out = serialize(marked);
    expect(JSON.stringify(out)).not.toContain("arriving");
    // The ARRANGEMENT is serialized, and must be — only the mark against it
    // is session state.
    expect(JSON.stringify(out)).toContain('"mode":"split"');
  });

  test("a round trip comes back with the field absent", () => {
    const back = deserialize(JSON.stringify(serialize(marked)), 1600, 1000);
    expect(back.arriving).toBeUndefined();
  });
});
