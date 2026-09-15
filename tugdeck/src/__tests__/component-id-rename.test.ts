/**
 * component-id-rename.test.ts — a deck saved before a card's registry kind was
 * renamed still finds its card.
 *
 * The Session card shipped as componentId `"dev"`. After the rename that id is
 * no longer registered, and `filterDeckStateByRegistration` drops any card
 * whose componentId is unregistered — along with any pane the drop leaves
 * empty. So without the rename-history entry in `serialization.ts`, the first
 * launch after the rename deletes the user's Session rail: a data loss wearing
 * the costume of a cosmetic change.
 *
 * The blob below is the real on-disk v4 shape, and it names `"dev"` in all
 * four places a saved layout can: the card table, the rail `order`, the rail
 * `shares` weights, and the `sidebars` record that holds which side the card
 * stands on. A rewrite that misses any one of them loses that part of the
 * arrangement while appearing to work.
 *
 * Not an app-test: `DeckManager` ignores the persisted layout in test mode
 * (per at0230), so the restore path cannot be driven through the real app.
 * Both halves here are pure over their inputs, and the second half runs
 * against the real card registry — the same posture as
 * `changeset-card-retired.test.ts`.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { deserialize } from "../serialization";
import { filterDeckStateByRegistration } from "../deck-manager";
import { registerCard, getRegistration, _resetForTest } from "../card-registry";
import { OVERVIEW_CARD_ID } from "../lib/overview-card-id";

const CANVAS_W = 1600;
const CANVAS_H = 1000;

/** A v4 layout blob written by a build from before the rename. */
function preRenameBlob(): string {
  return JSON.stringify({
    version: 4,
    cards: [
      { id: "cardA", componentId: "dev", title: "Dev", closable: true },
      { id: "cardB", componentId: "overview", title: "Overview", closable: true },
    ],
    panes: [
      {
        id: "paneA",
        position: { x: 0, y: 0 },
        size: { width: 400, height: 1000 },
        cardIds: ["cardA"],
        activeCardId: "cardA",
        title: "",
        acceptsFamilies: [],
      },
      {
        id: "paneB",
        position: { x: 420, y: 0 },
        size: { width: 900, height: 1000 },
        cardIds: ["cardB"],
        activeCardId: "cardB",
        title: "",
        acceptsFamilies: ["maker"],
      },
    ],
    activePaneId: "paneB",
    imposition: {
      sidebars: { dev: { side: "left" }, dashes: { side: "right" } },
      rails: {
        left: { mode: "split", order: ["dev"], shares: { dev: 1.25 } },
      },
    },
  });
}

function registerSessionLike(): void {
  registerCard({
    componentId: "session",
    contentFactory: () => null,
    defaultMeta: { title: "Session", icon: "Terminal", closable: true },
    cardFeedIds: [],
  });
  registerCard({
    componentId: OVERVIEW_CARD_ID,
    contentFactory: () => null,
    defaultMeta: { title: "Overview", icon: "Newspaper", closable: true },
    cardFeedIds: [],
  });
}

describe("a deck saved before the rename still finds its Session card", () => {
  afterEach(() => {
    _resetForTest();
  });

  test("every place the old id appears is rewritten on load", () => {
    const state = deserialize(preRenameBlob(), CANVAS_W, CANVAS_H);

    // The card table.
    expect(state.cards.map((c) => c.componentId).sort()).toEqual([
      "overview",
      "session",
    ]);
    // The sidebars record — which side the card stands on.
    expect(state.imposition.sidebars["session"]?.side).toBe("left");
    expect(state.imposition.sidebars["dev"]).toBeUndefined();
    // The rail arrangement — position among its neighbours, and its share.
    expect(state.imposition.rails?.left?.order).toEqual(["session"]);
    expect(state.imposition.rails?.left?.shares).toEqual({ session: 1.25 });
  });

  test("the rewritten card survives registration filtering, rail and all", () => {
    _resetForTest();
    registerSessionLike();
    // The premise: the id the blob was written with is not registered now.
    expect(getRegistration("dev")).toBeUndefined();
    expect(getRegistration("session")).toBeDefined();

    const state = deserialize(preRenameBlob(), CANVAS_W, CANVAS_H);
    const filtered = filterDeckStateByRegistration(
      state,
      (componentId) => getRegistration(componentId) !== undefined,
    );

    // Both panes survive — the Session card's pane is the one that would have
    // evaporated, since the card it holds is its only member.
    expect(filtered.panes.map((p) => p.id).sort()).toEqual(["paneA", "paneB"]);
    const sessionPane = filtered.panes.find((p) => p.id === "paneA");
    expect(sessionPane?.cardIds).toEqual(["cardA"]);
    expect(filtered.cards.find((c) => c.id === "cardA")?.componentId).toBe(
      "session",
    );
    expect(filtered.imposition.sidebars["session"]?.side).toBe("left");
  });

  test("without the rewrite the pane is exactly what would be lost", () => {
    _resetForTest();
    registerSessionLike();
    // Same blob, same registry — but naming the card by an id no rename map
    // knows. This is the failure the entry above exists to prevent, and it
    // is what the first launch after an unmigrated rename would have done.
    const orphaned = deserialize(
      preRenameBlob().replace(/"dev"/g, '"devise"'),
      CANVAS_W,
      CANVAS_H,
    );
    const filtered = filterDeckStateByRegistration(
      orphaned,
      (componentId) => getRegistration(componentId) !== undefined,
    );

    expect(filtered.panes.map((p) => p.id)).toEqual(["paneB"]);
    expect(filtered.cards.map((c) => c.id)).toEqual(["cardB"]);
  });
});
