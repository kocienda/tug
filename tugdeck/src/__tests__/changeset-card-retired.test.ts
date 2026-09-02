/**
 * changeset-card-retired.test.ts — the graceful-degrade path for the retired
 * Changeset card (now the rail `kind: "sessions"` section).
 *
 * A persisted deck blob written before the retirement may still name a
 * `componentId: "changeset"` card. With `registerChangesetCard` gone, that
 * componentId is no longer in the card registry, so `loadLayout`'s
 * `filterRegisteredCards` pass must drop it — the card, and any stack left
 * empty by the drop — rather than crash the boot. This exercises the real
 * filter (`filterDeckStateByRegistration`) against the real card registry.
 *
 * Not an app-test: in test mode `DeckManager` ignores the persisted layout
 * and starts empty (per at0230), so the restore path can't be driven through
 * the real app. The filter is pure over `(state, isRegistered)`, so it's
 * covered here directly on real DeckState shapes.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { filterDeckStateByRegistration } from "../deck-manager";
import { registerCard, getRegistration, _resetForTest } from "../card-registry";
import type { DeckState } from "../layout-tree";

function registerSessionLike(): void {
  registerCard({
    componentId: "session",
    contentFactory: () => null,
    defaultMeta: { title: "Session", icon: "Terminal", closable: true },
    cardFeedIds: [],
  });
}

/** A deck blob mixing a retired `changeset` card with a live `dev` card. */
function persistedBlob(): DeckState {
  return {
    cards: [
      { id: "A", componentId: "changeset", title: "Changeset", closable: true },
      { id: "B", componentId: "session", title: "Session B", closable: true },
      { id: "C", componentId: "changeset", title: "Changeset 2", closable: true },
    ],
    panes: [
      // A mixed stack: the changeset card drops, the session card survives.
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 680, height: 560 },
        cardIds: ["A", "B"],
        activeCardId: "A",
        title: "",
        acceptsFamilies: ["maker"],
      },
      // A stack whose only card is the retired changeset — drops entirely.
      {
        id: "p2",
        position: { x: 740, y: 40 },
        size: { width: 680, height: 560 },
        cardIds: ["C"],
        activeCardId: "C",
        title: "",
        acceptsFamilies: ["maker"],
      },
    ],
    activePaneId: "p2",
    imposition: { sidebars: { session: { side: "right" } } },
    hasFocus: true,
  };
}

describe("retired changeset card degrades a persisted deck blob gracefully", () => {
  afterEach(() => {
    _resetForTest();
  });

  test("drops the unregistered changeset card and its now-empty stack, keeps the rest", () => {
    _resetForTest();
    registerSessionLike();
    // The retirement invariant: "changeset" is not a registered CARD.
    expect(getRegistration("changeset")).toBeUndefined();

    const filtered = filterDeckStateByRegistration(
      persistedBlob(),
      (componentId) => getRegistration(componentId) !== undefined,
    );

    // Both changeset cards dropped; the session card survives.
    expect(filtered.cards.map((c) => c.id)).toEqual(["B"]);
    // The mixed stack survives with only the session card (active falls back to it);
    // the changeset-only stack is gone.
    expect(filtered.panes.map((p) => p.id)).toEqual(["p1"]);
    const p1 = filtered.panes[0];
    expect(p1.cardIds).toEqual(["B"]);
    expect(p1.activeCardId).toBe("B");
    // The active pane pointed at the dropped stack → cleared.
    expect(filtered.activePaneId).toBeUndefined();
  });

  test("a blob with no retired cards is returned unchanged (same reference)", () => {
    _resetForTest();
    registerSessionLike();
    const clean: DeckState = {
      cards: [{ id: "B", componentId: "session", title: "Session B", closable: true }],
      panes: [
        {
          id: "p1",
          position: { x: 0, y: 0 },
          size: { width: 400, height: 300 },
          cardIds: ["B"],
          activeCardId: "B",
          title: "",
          acceptsFamilies: ["maker"],
        },
      ],
      activePaneId: "p1",
      imposition: { sidebars: { session: { side: "right" } } },
      hasFocus: true,
    };
    expect(
      filterDeckStateByRegistration(clean, (id) => getRegistration(id) !== undefined),
    ).toBe(clean);
  });
});
