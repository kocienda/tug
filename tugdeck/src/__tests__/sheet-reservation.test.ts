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
 *
 * And the chrome arithmetic between a sheet's number and the member's ([B03]).
 * A sheet reports its panel's natural height; the floor the member needs is
 * that plus everything the deck puts around it, and the deck is where that sum
 * lives now that the opening bid and the measurement both read it.
 */

import { describe, test, expect } from "bun:test";
import { sheetClaimWith, sheetReservationsWith } from "../deck-manager";
import {
  memberFloorForSheetPanel,
  sheetReservationMemberIdOf,
  PANE_TITLE_BAR_AND_CLIP_PX,
  SHEET_CANVAS_GAP,
} from "../lib/sheet-reservation";
import { CARD_TITLE_BAR_HEIGHT } from "../components/chrome/tug-pane";
import { IMPOSITION_GAP_PX } from "../lib/layout-imposer";
import { registerCard, _resetForTest } from "../card-registry";
import { serializeDeck, deserializeDeck } from "./deck-blob-helpers";
import type { DeckState } from "../layout-tree";

describe("memberFloorForSheetPanel does the chrome arithmetic once", () => {
  test("adds the chrome above and the canvas gap below, less the member gap", () => {
    // The Choose Session picker with its sessions list at the cap: the sheet
    // reports 554 and the member under it needs 618. That 64px is exactly what
    // the measured reservation used to be short by, which is why it decided
    // nothing on a Session card.
    expect(memberFloorForSheetPanel(554)).toBe(618);
    expect(memberFloorForSheetPanel(554) - 554).toBe(64);
  });

  test("is the sum of its named terms and nothing else", () => {
    // Stated as the terms rather than as 64, so a change to any one of them
    // fails here with the term named rather than with an opaque total.
    expect(memberFloorForSheetPanel(0)).toBe(
      PANE_TITLE_BAR_AND_CLIP_PX + SHEET_CANVAS_GAP - IMPOSITION_GAP_PX,
    );
  });

  test("the title-bar term is the pane's own chrome height plus the clip's drop", () => {
    // The copy that cannot drift: the constant is stated in the lib rather
    // than imported from the pane component, because the pane reaches the deck
    // manager and a lib the manager imports cannot reach back. This is what
    // keeps the two honest.
    expect(PANE_TITLE_BAR_AND_CLIP_PX).toBe(CARD_TITLE_BAR_HEIGHT + 1);
  });

  test("is monotonic in the panel it is given", () => {
    expect(memberFloorForSheetPanel(400)).toBeLessThan(
      memberFloorForSheetPanel(401),
    );
  });
});

describe("sheetReservationsWith", () => {
  test("writes the height on the named member, from nothing standing", () => {
    expect(sheetReservationsWith(undefined, "pane-1", 340)).toEqual({
      "pane-1": 340,
    });
  });

  test("writes a second member's claim beside the first", () => {
    const standing = { "pane-1": 340 };
    expect(sheetReservationsWith(standing, "dashes", 280)).toEqual({
      "pane-1": 340,
      dashes: 280,
    });
  });

  test("overwrites a member's own standing claim", () => {
    expect(sheetReservationsWith({ "pane-1": 340 }, "pane-1", 366)).toEqual({
      "pane-1": 366,
    });
  });

  test("clearing one of several leaves the others standing", () => {
    const next = sheetReservationsWith(
      { "pane-1": 340, dashes: 280 },
      "pane-1",
      null,
    );
    expect(next).toEqual({ dashes: 280 });
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
    const out = serializeDeck(reserving);
    expect(JSON.stringify(out)).not.toContain("sheetReservations");
    // The ARRANGEMENT is serialized, and must be: the split and its order are
    // the user's own choice. Only the claim against it is session state.
    expect(JSON.stringify(out)).toContain('"mode":"split"');
  });

  test("a round trip comes back with the field absent", () => {
    const back = deserializeDeck(JSON.stringify(serializeDeck(reserving)), 1600, 1000);
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
    register("dashes", true);
    const state: DeckState = {
      cards: [
        { id: "card-t", componentId: "dashes", title: "T", closable: true },
      ],
      panes: [makePane("pane-t", ["card-t"])],
      imposition: { sidebars: { dashes: { side: "right" } } },
      hasFocus: true,
    };
    expect(sheetReservationMemberIdOf(state, "card-t")).toBe("dashes");
  });

  test("an UNPINNED sidebar card is an ordinary slot member again", () => {
    // The role is what makes it rail-eligible; the pin is what puts it on one.
    // Off the rail it stands in a pane like anything else. Absent reads as
    // PINNED (`isSidebarPinned`), so unpinning has to be said explicitly —
    // which is the same reading `railMembersOf` takes of its own membership.
    _resetForTest();
    register("dashes", true);
    const state: DeckState = {
      cards: [
        { id: "card-t", componentId: "dashes", title: "T", closable: true },
      ],
      panes: [makePane("pane-t", ["card-t"])],
      imposition: {
        sidebars: { dashes: { side: "right", pinned: false } },
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

// ---------------------------------------------------------------------------
// sheetClaimWith — a measurement supersedes the opening bid ([B02])
// ---------------------------------------------------------------------------

describe("sheetClaimWith: a measurement supersedes the opening bid", () => {
  test("a claim at the bid's own height writes the reservation and clears the bid", () => {
    // The whole of [B02] in one call. The bid was what the card DECLARED
    // before it was laid out, so that the arrival could be one motion; the
    // sheet now on the member is the thing that knows, and its first claim is
    // what ends the bid rather than any later card-state transition.
    const next = sheetClaimWith(
      { sheetReservations: undefined, openingBids: { "pane-1": 618 } },
      "pane-1",
      618,
    );
    expect(next.sheetReservations).toEqual({ "pane-1": 618 });
    expect(next.openingBids).toBeUndefined();
  });

  test("and does it in ONE pair, so the two records move in one commit", () => {
    // A bid cleared a commit after the claim that replaced it would be a
    // second settle over the same fact — the judder the bid exists to prevent.
    const next = sheetClaimWith(
      {
        sheetReservations: { "pane-2": 300 },
        openingBids: { "pane-1": 618, "pane-2": 400 },
      },
      "pane-1",
      700,
    );
    expect(next.sheetReservations).toEqual({ "pane-2": 300, "pane-1": 700 });
    // Only the claiming member's bid. Its neighbour's is untouched.
    expect(next.openingBids).toEqual({ "pane-2": 400 });
  });

  test("a claim LARGER than the bid supersedes it — the case the bid exists for", () => {
    // A bid too small is the failure [F06] is about: read as a ceiling it was
    // a permanent clip, and read as a floor the larger measurement wins the
    // same `Math.max` and the bid has nothing left to say.
    const next = sheetClaimWith(
      { sheetReservations: undefined, openingBids: { "pane-1": 618 } },
      "pane-1",
      700,
    );
    expect(next.sheetReservations).toEqual({ "pane-1": 700 });
    expect(next.openingBids).toBeUndefined();
  });

  test("a claim BELOW the bid supersedes nothing — the member does not shrink under a standing sheet", () => {
    // The one asymmetry, and the reason for it: a claim that is smaller than
    // the bid corrects nothing, because the panel it measured already fits.
    // Dropping the bid for it would shrink the member under a sheet still
    // standing on it, for no gain. A bid that was too generous costs air, and
    // air is the price the declaration names for itself.
    const bids = { "pane-1": 618 };
    const next = sheetClaimWith(
      { sheetReservations: undefined, openingBids: bids },
      "pane-1",
      444,
    );
    expect(next.sheetReservations).toEqual({ "pane-1": 444 });
    expect(next.openingBids).toBe(bids);
  });

  test("the sheet GOING clears the bid whatever it was — which is what ends a generous one", () => {
    // The other half of the one rule, and what replaced the binding-commit
    // drop: binding is what makes the picker go, so the sheet going is the
    // condition ending, read here rather than in a card-state transition.
    const bids = { "pane-1": 618 };
    const next = sheetClaimWith(
      { sheetReservations: { "pane-1": 444 }, openingBids: bids },
      "pane-1",
      null,
    );
    expect(next.sheetReservations).toBeUndefined();
    expect(next.openingBids).toBeUndefined();
  });

  test("both halves come back by IDENTITY when nothing changes", () => {
    // What lets the verb short-circuit on the pair: a sheet re-reports the
    // height it already reported on every resize of its own panel, and by then
    // the bid has either been cleared or been left standing once already.
    const reservations = { "pane-1": 444 };
    const bids = { "pane-2": 618 };
    const next = sheetClaimWith(
      { sheetReservations: reservations, openingBids: bids },
      "pane-1",
      444,
    );
    expect(next.sheetReservations).toBe(reservations);
    expect(next.openingBids).toBe(bids);
  });

  test("a claim on a member with no bid touches no bids", () => {
    const bids = { "pane-2": 618 };
    const next = sheetClaimWith(
      { sheetReservations: undefined, openingBids: bids },
      "pane-1",
      444,
    );
    expect(next.openingBids).toBe(bids);
  });
});
