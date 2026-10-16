/**
 * The edge the shell tells a rail card's body it stands pinned to: the side
 * the deck's imposition gives it while it is pinned, nothing once it is
 * dragged loose, and nothing for a content card — the fact the body's page
 * keys the rail's surface on.
 *
 * @covers tugdeck/src/lib/body-shell.ts
 */
import { describe, expect, test } from "bun:test";

import { registerCard } from "../../card-registry";
import type { DeckState } from "../../layout-tree";
import { pinnedRailSideOf } from "../body-shell";

registerCard({
  componentId: "rail-side-rail",
  contentFactory: () => null,
  defaultMeta: { title: "Rail", closable: true },
  layoutRole: "sidebar",
});
registerCard({
  componentId: "rail-side-content",
  contentFactory: () => null,
  defaultMeta: { title: "Content", closable: true },
});

function deck(sidebars: DeckState["imposition"]["sidebars"]): DeckState {
  return {
    cards: [
      { id: "r", componentId: "rail-side-rail", title: "", closable: true },
      { id: "c", componentId: "rail-side-content", title: "", closable: true },
    ],
    panes: [],
    imposition: { sidebars },
    hasFocus: true,
  };
}

describe("pinnedRailSideOf", () => {
  test("a pinned rail stands on the side its imposition gives it", () => {
    expect(pinnedRailSideOf(deck({ "rail-side-rail": { side: "left" } }), "r")).toBe("left");
    expect(pinnedRailSideOf(deck({ "rail-side-rail": { side: "right", pinned: true } }), "r")).toBe("right");
  });

  test("a rail dragged loose, a content card and a card the deck does not hold stand on no side", () => {
    expect(pinnedRailSideOf(deck({ "rail-side-rail": { side: "left", pinned: false } }), "r")).toBe(null);
    expect(pinnedRailSideOf(deck({}), "c")).toBe(null);
    expect(pinnedRailSideOf(deck({}), "nowhere")).toBe(null);
  });
});
