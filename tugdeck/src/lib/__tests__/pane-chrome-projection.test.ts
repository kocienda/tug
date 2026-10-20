/**
 * A pane as its chrome draws it, read off the deck alone: the value the shell
 * publishes to each card's body as `pane.chrome`. Each case is one of the
 * arrangements a title bar draws differently — a two-tab content pane, a
 * pinned rail, a split column's members, a free pane — read as `TugPane`
 * reads the same pane from its props. A tab carries only its card: the page
 * names it from `deck.cards` (`deck-cards.test.ts`).
 *
 * @covers tugdeck/src/lib/pane-chrome-projection.ts
 */

import { describe, expect, test } from "bun:test";

import { registerCard } from "../../card-registry";
import type { DeckState, TugPaneState } from "../../layout-tree";
import { keepSlotGripsOf, paneChromeFor, type PaneChromeReaders } from "../pane-chrome-projection";

registerCard({
  componentId: "chrome-proj-doc",
  contentFactory: () => null,
  defaultMeta: { title: "Doc", icon: "FileText", closable: true },
});
registerCard({
  componentId: "chrome-proj-confirm",
  contentFactory: () => null,
  defaultMeta: { title: "Confirm", closable: true, confirmClose: true },
});
registerCard({
  componentId: "chrome-proj-rail",
  contentFactory: () => null,
  defaultMeta: { title: "Rail", closable: true },
  layoutRole: "sidebar",
});

const READERS: PaneChromeReaders = {
  titleOf: (id) => (id === "named" ? "notes.md" : null),
  waives: () => false,
  spaces: {
    list: [
      { id: "w1", name: "Main" },
      { id: "w2", name: "Side" },
    ],
    ownSpaceId: "w1",
  },
};

function pane(id: string, cardIds: string[], extra: Partial<TugPaneState> = {}): TugPaneState {
  return {
    id,
    position: { x: 40, y: 40 },
    size: { width: 600, height: 500 },
    cardIds,
    activeCardId: cardIds[0],
    title: "",
    acceptsFamilies: ["standard"],
    ...extra,
  };
}

function card(id: string, componentId: string) {
  return { id, componentId, title: "", closable: true };
}

describe("paneChromeFor", () => {
  test("a two-tab content pane lists both tabs by card, asks before its × closes them, and gives each card the chrome it shows in front", () => {
    const deck: DeckState = {
      cards: [card("named", "chrome-proj-doc"), card("b", "chrome-proj-confirm")],
      panes: [pane("p1", ["named", "b"], { title: "Group" })],
      imposition: { sidebars: {} },
      hasFocus: true,
    };
    const chrome = paneChromeFor(deck, "b", READERS);
    expect(chrome).not.toBeNull();
    expect(chrome!.paneId).toBe("p1");
    expect(chrome!.tabs).toEqual([{ cardId: "named" }, { cardId: "b" }]);
    // The card's own chrome, as it shows in front: its own tab active, its
    // own title under the group's name, its own icon.
    expect(chrome!.activeCardId).toBe("b");
    expect(chrome!.title).toBe("Group : Confirm");
    expect(chrome!.icon).toBeNull();
    expect(chrome!.closable).toBe(true);
    expect(chrome!.close.pane).toEqual({ confirm: true, message: "Close 2 Tabs?", label: "Close All" });
    expect(chrome!.role).toBe("content");
    expect(chrome!.acceptedFamilies).toEqual(["standard"]);
    expect(chrome!.width).toEqual({ preset: null });
    expect(chrome!.fillHeight).toBeNull();
    expect(chrome!.placeArrangement).toBeNull();
    expect(chrome!.bullseye).toBe(false);
    expect(chrome!.spaces).toEqual([...READERS.spaces.list]);
    expect(chrome!.ownSpaceId).toBe("w1");
    expect(chrome!.cardFold).toBe(true);
    // The other card reads the same pane, with its own front.
    const named = paneChromeFor(deck, "named", READERS);
    // …and ⌘W asks about its own card: the Doc in front asks nothing.
    expect(chrome!.close.card).toEqual({ confirm: true, message: "Close Confirm?", label: "Close" });
    expect(named).toEqual({
      ...chrome!,
      activeCardId: "named",
      title: "Group : notes.md",
      icon: "FileText",
      close: { ...chrome!.close, card: { confirm: false, message: "Close Doc?", label: "Close" } },
    });
  });

  test("a pinned right rail offers its one deck-facing edge and neither bullseye nor the move control", () => {
    const deck: DeckState = {
      cards: [card("r", "chrome-proj-rail")],
      panes: [pane("rail", ["r"])],
      imposition: { sidebars: { "chrome-proj-rail": { side: "right" } } },
      hasFocus: true,
    };
    const chrome = paneChromeFor(deck, "r", READERS)!;
    expect(chrome.role).toBe("sidebar");
    expect(chrome.grips).toEqual(["w"]);
    expect(chrome.bullseye).toBeNull();
    expect(chrome.spaces).toEqual([]);
    expect(chrome.width).toBeNull();
    expect(chrome.fillHeight).toBeNull();
    // A rail always asks before it closes, and draws no fold glyph.
    expect(chrome.close.pane.confirm).toBe(true);
    expect(chrome.cardFold).toBe(false);
    // A rail of one divides nothing: its badge reads the count.
    expect(chrome.placeArrangement).toEqual({ mode: "stack", kind: "rail", index: 0, band: null, count: 1 });
  });

  test("a split column's members carry their band and count, and the seam between them as grips", () => {
    const deck: DeckState = {
      cards: [card("t", "chrome-proj-doc"), card("u", "chrome-proj-doc")],
      panes: [pane("top", ["t"], { slot: 0 }), pane("bottom", ["u"], { slot: 0 })],
      imposition: { kind: "two-up", sidebars: {}, columns: { 0: { mode: "split", order: ["top", "bottom"] } } },
      hasFocus: true,
    };
    const top = paneChromeFor(deck, "t", READERS)!;
    const bottom = paneChromeFor(deck, "u", READERS)!;
    expect(top.placeArrangement).toEqual({ mode: "split", kind: "column", index: 0, band: "A", count: 2 });
    expect(bottom.placeArrangement).toEqual({ mode: "split", kind: "column", index: 1, band: "B", count: 2 });
    // In flow (the default layout) only a slot's right edge moves; the top
    // member's seam is below it and the bottom's above.
    expect(top.grips).toEqual(["s", "e"]);
    expect(bottom.grips).toEqual(["n", "e"]);
    // A split member holds no slot height of its own.
    expect(top.fillHeight).toBeNull();
    expect(top.slotStack.map((e) => e.paneId).sort()).toEqual(["bottom", "top"]);
  });

  test("a lone slotted pane offers Fill Height, and a free pane every edge", () => {
    const slotted: DeckState = {
      cards: [card("s", "chrome-proj-doc")],
      panes: [pane("slotted", ["s"], { slot: 1, widthPreset: "wide", slotHeight: 300 })],
      imposition: { kind: "two-up", layout: "fit", sidebars: {} },
      hasFocus: true,
    };
    const chrome = paneChromeFor(slotted, "s", READERS)!;
    expect(chrome.width).toEqual({ preset: "wide" });
    expect(chrome.fillHeight).toEqual({ fills: false });
    expect(chrome.placeArrangement).toEqual({ mode: "stack", kind: "column", index: 0, band: null, count: 1 });
    // In fit the last slot gives up travel to its left alone; its held height gives it a bottom edge.
    expect(chrome.grips).toEqual(["s", "w"]);
    // The slot badge's facts: two places, and this pane in the second.
    expect(chrome.slot).toEqual({ count: 2, held: 1 });

    const free: DeckState = {
      cards: [card("f", "chrome-proj-doc")],
      panes: [pane("free", ["f"])],
      imposition: { sidebars: {} },
      hasFocus: true,
    };
    expect(paneChromeFor(free, "f", READERS)!.grips).toEqual(["n", "s", "e", "w", "nw", "ne", "sw", "se"]);
    // A free pane holds no slot to name.
    expect(paneChromeFor(free, "f", READERS)!.slot).toBeNull();
    expect(paneChromeFor(free, "nowhere", READERS)).toBeNull();
  });
});

describe("keepSlotGripsOf", () => {
  test("a flow slot offers its right edge alone, and a width-locked card no side edge", () => {
    const base = { fraction: 0, column: undefined, heightHeld: false, widthPinned: false };
    expect(keepSlotGripsOf({ ...base, layout: "flow" })).toEqual(["e"]);
    expect(keepSlotGripsOf({ ...base, layout: "fit", fraction: 0.5, widthPinned: true })).toEqual([]);
    expect(keepSlotGripsOf({ ...base, layout: "fit", fraction: 0.5 })).toEqual(["e", "w"]);
  });
});
