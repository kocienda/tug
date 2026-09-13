/**
 * sheet-reservation.test.ts — unit tests for the transient per-member height
 * reservation a modal surface states and a place's allocator reads as a floor
 * ([B01]).
 *
 * Two things are held here. The pure core of the commit,
 * `sheetReservationsWith` — what the record becomes on a set, a clear, and the
 * clear that takes the last entry with it — which is testable without a live
 * DeckManager, as `pane-folded.test.ts` explains that the verb around it is
 * not. And the fact that nothing about a reservation survives a round trip
 * through the settings blob ([B03]): a claim is held for a sheet that is up,
 * and no sheet is up across a restart.
 *
 * And the resolver that decides WHICH member a card's claim is made under —
 * the pane hosting it in a slot, its componentId on a rail ([B04]) — which is
 * the one thing the two places differ by and the one thing a claim published
 * under the wrong name would be silently ignored for.
 */

import { describe, test, expect } from "bun:test";
import { sheetReservationsWith } from "../deck-manager";
import { sheetReservationMemberIdOf } from "../lib/sheet-reservation";
import { registerCard, _resetForTest } from "../card-registry";
import { serialize, deserialize } from "../serialization";
import type { DeckState } from "../layout-tree";

describe("sheetReservationsWith", () => {
  test("writes the height on the named member, from nothing standing", () => {
    expect(sheetReservationsWith(undefined, "pane-1", 340)).toEqual({
      "pane-1": 340,
    });
  });

  test("writes a second member's claim beside the first", () => {
    const standing = { "pane-1": 340 };
    expect(sheetReservationsWith(standing, "tripwires", 280)).toEqual({
      "pane-1": 340,
      tripwires: 280,
    });
  });

  test("overwrites a member's own standing claim", () => {
    expect(sheetReservationsWith({ "pane-1": 340 }, "pane-1", 366)).toEqual({
      "pane-1": 366,
    });
  });

  test("clearing one of several leaves the others standing", () => {
    const next = sheetReservationsWith(
      { "pane-1": 340, tripwires: 280 },
      "pane-1",
      null,
    );
    expect(next).toEqual({ tripwires: 280 });
  });

  test("clearing the LAST entry gives undefined, never an empty record", () => {
    // Absence is the one reading of "nobody is claiming". An empty record
    // standing where the field used to be absent would be a second spelling of
    // the resting state, and the two would then have to agree forever.
    expect(sheetReservationsWith({ "pane-1": 340 }, "pane-1", null)).toBeUndefined();
  });

  test("returns by IDENTITY when the height already reads that way", () => {
    // A sheet re-reports its height on every resize of its own panel. Each of
    // those would otherwise be a commit that arms a settle over frames already
    // where they belong.
    const standing = { "pane-1": 340 };
    expect(sheetReservationsWith(standing, "pane-1", 340)).toBe(standing);
  });

  test("returns by IDENTITY when clearing a member that claims nothing", () => {
    const standing = { "pane-1": 340 };
    expect(sheetReservationsWith(standing, "pane-2", null)).toBe(standing);
    expect(sheetReservationsWith(undefined, "pane-2", null)).toBeUndefined();
  });

  test("does not mutate the record it was handed", () => {
    const standing = { "pane-1": 340 };
    sheetReservationsWith(standing, "pane-2", 280);
    sheetReservationsWith(standing, "pane-1", null);
    expect(standing).toEqual({ "pane-1": 340 });
  });
});

describe("a reservation does not survive serialization", () => {
  const reserving: DeckState = {
    cards: [],
    panes: [],
    imposition: {
      kind: "two-up",
      sidebars: {},
      columns: { 0: { mode: "split", order: ["p1", "p2"] } },
    },
    sheetReservations: { p2: 340 },
    hasFocus: true,
  };

  test("serialize emits no reservations", () => {
    // A restored claim would be a floor held for a surface nobody raised: the
    // sheet that justified it cannot be up, and the card would come back
    // taller than the division the hand set with the sash.
    const out = serialize(reserving);
    expect(JSON.stringify(out)).not.toContain("sheetReservations");
    // The ARRANGEMENT is serialized, and must be: the split and its order are
    // the user's own choice. Only the claim against it is session state.
    expect(JSON.stringify(out)).toContain('"mode":"split"');
  });

  test("a round trip comes back with the field absent", () => {
    const back = deserialize(JSON.stringify(serialize(reserving)), 1600, 1000);
    expect(back.sheetReservations).toBeUndefined();
  });
});

describe("sheetReservationMemberIdOf names the member the allocator looks up", () => {
  function makePane(id: string, cardIds: string[]) {
    return {
      id,
      position: { x: 0, y: 0 },
      size: { width: 400, height: 300 },
      cardIds,
      activeCardId: cardIds[0],
      title: "",
      acceptsFamilies: ["standard"],
    };
  }

  function register(componentId: string, sidebar: boolean): void {
    registerCard({
      componentId,
      contentFactory: () => null,
      defaultMeta: { title: componentId, closable: true },
      ...(sidebar ? { layoutRole: "sidebar" as const } : {}),
      sizePolicy: {
        min: { width: 300, height: 200 },
        preferred: { width: 600, height: 900 },
      },
    });
  }

  test("a card in a slot claims under the PANE hosting it", () => {
    _resetForTest();
    register("plain", false);
    const state: DeckState = {
      cards: [{ id: "card-a", componentId: "plain", title: "A", closable: true }],
      panes: [makePane("pane-a", ["card-a"])],
      imposition: { sidebars: {} },
      hasFocus: true,
    };
    expect(sheetReservationMemberIdOf(state, "card-a")).toBe("pane-a");
  });

  test("a card PINNED TO A RAIL claims under its componentId", () => {
    // `placeMembers` is handed componentIds for a rail, so a claim published
    // under the pane's id there would be looked up by a name that is not in
    // the record and would never bind ([B04]).
    _resetForTest();
    register("tripwires", true);
    const state: DeckState = {
      cards: [
        { id: "card-t", componentId: "tripwires", title: "T", closable: true },
      ],
      panes: [makePane("pane-t", ["card-t"])],
      imposition: { sidebars: { tripwires: { side: "right" } } },
      hasFocus: true,
    };
    expect(sheetReservationMemberIdOf(state, "card-t")).toBe("tripwires");
  });

  test("an UNPINNED sidebar card is an ordinary slot member again", () => {
    // The role is what makes it rail-eligible; the pin is what puts it on one.
    // Off the rail it stands in a pane like anything else. Absent reads as
    // PINNED (`isSidebarPinned`), so unpinning has to be said explicitly —
    // which is the same reading `railMembersOf` takes of its own membership.
    _resetForTest();
    register("tripwires", true);
    const state: DeckState = {
      cards: [
        { id: "card-t", componentId: "tripwires", title: "T", closable: true },
      ],
      panes: [makePane("pane-t", ["card-t"])],
      imposition: {
        sidebars: { tripwires: { side: "right", pinned: false } },
      },
      hasFocus: true,
    };
    expect(sheetReservationMemberIdOf(state, "card-t")).toBe("pane-t");
  });

  test("a card standing in nothing names no member", () => {
    // The card torn down while its sheet was up. The drop still has to land,
    // which is why the gesture remembers the member rather than re-deriving it.
    _resetForTest();
    register("plain", false);
    const state: DeckState = {
      cards: [],
      panes: [],
      imposition: { sidebars: {} },
      hasFocus: true,
    };
    expect(sheetReservationMemberIdOf(state, "card-a")).toBeNull();
  });
});
