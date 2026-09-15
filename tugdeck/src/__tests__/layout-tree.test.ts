import { describe, test, expect } from "bun:test";
import {
  type DeckState,
  type CardState,
  type TugPaneState,
  type CardStateBag,
  validateDeckState,
  DeckStateInvariantError,
} from "../layout-tree";
import { serialize, deserialize, buildDefaultLayout } from "../serialization";
import {
  DEFAULT_IMPOSITION_KIND,
  isSidebarPinned,
  sidebarSide,
  slotCount,
  withSidebarPinned,
} from "../lib/layout-imposer";
import { registerCard } from "../card-registry";

// The deck invariants read `layoutRole` off the registry, so a sidebar card has
// to be registered for its pane to be a SIDEBAR pane rather than an ordinary
// one. Arcs stands in for any of them here.
registerCard({
  componentId: "dashes",
  contentFactory: () => null,
  defaultMeta: { title: "Arcs", closable: true },
  layoutRole: "sidebar",
});

// ---- DeckState / CardState / TugPaneState type tests ----

describe("DeckState", () => {
  test("DeckState with empty cards and panes is valid", () => {
    const state: DeckState = { cards: [], panes: [], imposition: { sidebars: { dashes: { side: "right" } } }, hasFocus: true };
    expect(state.cards.length).toBe(0);
    expect(state.panes.length).toBe(0);
  });
});

describe("CardState (two-table model)", () => {
  test("CardState holds id, componentId, title, closable", () => {
    const card: CardState = {
      id: "card-1",
      componentId: "terminal",
      title: "Terminal",
      closable: true,
    };
    expect(card.id).toBe("card-1");
    expect(card.componentId).toBe("terminal");
    expect(card.title).toBe("Terminal");
    expect(card.closable).toBe(true);
  });

  test("CardState accepts optional state bag", () => {
    const card: CardState = {
      id: "card-1",
      componentId: "terminal",
      title: "Terminal",
      closable: true,
      state: { scroll: { x: 10, y: 20 } },
    };
    expect(card.state?.scroll?.x).toBe(10);
  });
});

describe("TugPaneState (two-table model)", () => {
  test("TugPaneState with single cardId constructs correctly", () => {
    const stack: TugPaneState = {
      id: "stack-1",
      position: { x: 0, y: 0 },
      size: { width: 800, height: 600 },
      cardIds: ["card-1"],
      activeCardId: "card-1",
      title: "",
      acceptsFamilies: ["standard"],
    };
    expect(stack.position.x).toBe(0);
    expect(stack.size.width).toBe(800);
    expect(stack.cardIds).toEqual(["card-1"]);
    expect(stack.activeCardId).toBe("card-1");
  });

  test("TugPaneState with multiple cardIds constructs correctly", () => {
    const stack: TugPaneState = {
      id: "stack-2",
      position: { x: 100, y: 200 },
      size: { width: 400, height: 300 },
      cardIds: ["card-a", "card-b", "card-c"],
      activeCardId: "card-b",
      title: "",
      acceptsFamilies: ["standard"],
    };
    expect(stack.cardIds.length).toBe(3);
    expect(stack.activeCardId).toBe("card-b");
  });
});

// ---- the additive-optional `folded` flag ----

describe("TugPaneState.folded", () => {
  function foldedPane(): TugPaneState {
    return {
      id: "pane-min",
      position: { x: 10, y: 20 },
      size: { width: 640, height: 480 },
      cardIds: ["card-min"],
      activeCardId: "card-min",
      title: "",
      acceptsFamilies: ["standard"],
      folded: true,
    };
  }

  function foldedState(): DeckState {
    const card: CardState = {
      id: "card-min",
      componentId: "session",
      title: "Session",
      closable: true,
    };
    return {
      cards: [card],
      panes: [foldedPane()],
      imposition: { sidebars: { dashes: { side: "right" } } },
      hasFocus: true,
    };
  }

  test("a folded pane passes validateDeckState — the flag constrains nothing", () => {
    expect(() => validateDeckState(foldedState())).not.toThrow();
  });

  test("the flag survives serialize / deserialize", () => {
    const json = JSON.stringify(serialize(foldedState()));
    const restored = deserialize(json, 1920, 1080);
    expect(restored.panes.length).toBe(1);
    expect(restored.panes[0].folded).toBe(true);
  });

  test("a pane without the flag restores without the key, not with false", () => {
    const state = foldedState();
    const { folded: _dropped, ...bare } = state.panes[0];
    const json = JSON.stringify(serialize({ ...state, panes: [bare] }));
    const restored = deserialize(json, 1920, 1080);
    expect("folded" in restored.panes[0]).toBe(false);
  });

  test("a blob saved before the field restores as not folded", () => {
    // The additive-optional contract: no version bump, and an older blob
    // simply has no key to read.
    const legacy = {
      version: 4,
      cards: [
        { id: "card-old", componentId: "session", title: "S", closable: true },
      ],
      panes: [
        {
          id: "pane-old",
          position: { x: 0, y: 0 },
          size: { width: 400, height: 300 },
          cardIds: ["card-old"],
          activeCardId: "card-old",
          title: "",
          acceptsFamilies: ["standard"],
        },
      ],
      imposition: { sidebars: { dashes: { side: "right" } } },
    };
    const restored = deserialize(JSON.stringify(legacy), 1920, 1080);
    expect(restored.panes[0].folded).toBeUndefined();
  });
});

// ---- buildDefaultLayout tests ----

describe("buildDefaultLayout", () => {
  test("buildDefaultLayout returns empty DeckState (Phase 5: no pre-registered cards)", () => {
    const result = buildDefaultLayout();
    expect(result.cards.length).toBe(0);
    expect(result.panes.length).toBe(0);
  });
});

// ---- serialize / deserialize tests (v3 wire format) ----

describe("serialize and deserialize (v4 wire)", () => {
  test("round-trip preserves a single-card stack", () => {
    const card: CardState = {
      id: "card-known-1",
      componentId: "terminal",
      title: "Terminal",
      closable: true,
    };
    const stack: TugPaneState = {
      id: "stack-known-1",
      position: { x: 100, y: 200 },
      size: { width: 400, height: 300 },
      cardIds: ["card-known-1"],
      activeCardId: "card-known-1",
      title: "",
      acceptsFamilies: ["standard"],
    };
    const state: DeckState = { cards: [card], panes: [stack], imposition: { sidebars: { dashes: { side: "right" } } }, hasFocus: true };

    const serialized = serialize(state);
    const json = JSON.stringify(serialized);
    const restored = deserialize(json, 1920, 1080);

    expect(restored.cards.length).toBe(1);
    expect(restored.panes.length).toBe(1);
    const rCard = restored.cards[0];
    expect(rCard.id).toBe("card-known-1");
    expect(rCard.componentId).toBe("terminal");
    const rStack = restored.panes[0];
    expect(rStack.id).toBe("stack-known-1");
    expect(rStack.position.x).toBe(100);
    expect(rStack.cardIds).toEqual(["card-known-1"]);
    expect(rStack.activeCardId).toBe("card-known-1");
  });

  test("round-trip preserves a multi-card stack", () => {
    const cards: CardState[] = [
      { id: "card-mt-1", componentId: "hello", title: "Hello", closable: true },
      { id: "card-mt-2", componentId: "hello", title: "Hello 2", closable: true },
      { id: "card-mt-3", componentId: "hello", title: "Hello 3", closable: false },
    ];
    const stack: TugPaneState = {
      id: "stack-mt",
      position: { x: 50, y: 80 },
      size: { width: 500, height: 400 },
      cardIds: ["card-mt-1", "card-mt-2", "card-mt-3"],
      activeCardId: "card-mt-2",
      title: "",
      acceptsFamilies: ["standard"],
    };
    const state: DeckState = { cards, panes: [stack], imposition: { sidebars: { dashes: { side: "right" } } }, hasFocus: true };

    const json = JSON.stringify(serialize(state));
    const restored = deserialize(json, 1920, 1080);

    expect(restored.panes.length).toBe(1);
    const r = restored.panes[0];
    expect(r.cardIds.length).toBe(3);
    expect(r.activeCardId).toBe("card-mt-2");
    expect(restored.cards.find((c) => c.id === "card-mt-3")?.closable).toBe(false);
  });

  test("legacy componentId \"dev\" restores as the current \"session\" kind", () => {
    // A deck saved when the Session card shipped as componentId "dev".
    const legacy = {
      version: 4,
      cards: [{ id: "c-dev", componentId: "dev", title: "Dev", closable: true }],
      panes: [
        {
          id: "p-dev",
          position: { x: 40, y: 40 },
          size: { width: 800, height: 600 },
          cardIds: ["c-dev"],
          activeCardId: "c-dev",
          title: "",
          acceptsFamilies: ["maker"],
        },
      ],
    };
    const restored = deserialize(JSON.stringify(legacy), 1920, 1080);
    // The card is not dropped, and its kind is migrated to "session".
    expect(restored.cards.length).toBe(1);
    expect(restored.cards[0].componentId).toBe("session");
    expect(restored.panes[0].cardIds).toEqual(["c-dev"]);
  });

  test("serialize emits version: 4", () => {
    const out = serialize({ cards: [], panes: [], imposition: { sidebars: { dashes: { side: "right" } } }, hasFocus: true }) as { version: number };
    expect(out.version).toBe(4);
  });

  test("serialize emits no bullseye key, even with one set — bullseye is session state", () => {
    const card: CardState = {
      id: "c1",
      componentId: "terminal",
      title: "T",
      closable: true,
    };
    const pane: TugPaneState = {
      id: "w1",
      position: { x: 10, y: 20 },
      size: { width: 511, height: 400 },
      cardIds: ["c1"],
      activeCardId: "c1",
      title: "",
      acceptsFamilies: ["standard"],
    };
    const out = serialize({
      cards: [card],
      panes: [pane],
      activePaneId: "w1",
      bullseyePaneId: "w1",
      imposition: { sidebars: { dashes: { side: "right" } } },
      hasFocus: true,
    });
    expect(Object.keys(out).sort()).toEqual([
      "activePaneId",
      "cards",
      "imposition",
      "panes",
      "version",
    ]);
    expect(JSON.stringify(out)).not.toContain("bullseye");
    // And the pane's own record is untouched by the posture.
    expect((out as { panes: TugPaneState[] }).panes[0].size.width).toBe(511);
  });

  test("the layout mode round-trips, and an unreadable one drops to fit", () => {
    // The mode is the deck's, so it has to survive a reload — but it is
    // additive-optional, so an absent or unreadable value must come back as
    // the deck every earlier build described: fit.
    const base = {
      cards: [],
      panes: [],
      hasFocus: true,
    };
    const withFlow = deserialize(
      JSON.stringify(
        serialize({
          ...base,
          imposition: {
            kind: "three-up" as const,
            sidebars: { dashes: { side: "right" as const } },
            layout: "flow" as const,
          },
        }),
      ),
      1920,
      1080,
    );
    expect(withFlow.imposition.layout).toBe("flow");

    const absent = deserialize(
      JSON.stringify(
        serialize({
          ...base,
          imposition: { sidebars: { dashes: { side: "right" as const } } },
        }),
      ),
      1920,
      1080,
    );
    expect(absent.imposition.layout).toBeUndefined();

    const garbled = deserialize(
      JSON.stringify({
        version: 4,
        cards: [],
        panes: [],
        imposition: { kind: "three-up", sidebars: {}, layout: "strip" },
      }),
      1920,
      1080,
    );
    expect(garbled.imposition.layout).toBeUndefined();
  });

  test("serialize emits no flow offset — the viewport is session state", () => {
    // Same rule bullseye follows above, and for the same reason: the offset
    // is derivable (activating any card re-reveals it), so a restored one
    // would be a viewport nobody asked for.
    const out = serialize({
      cards: [],
      panes: [],
      imposition: {
        sidebars: { dashes: { side: "right" } },
        layout: "flow",
      },
      flowOffset: 640,
      hasFocus: true,
    });
    expect(JSON.stringify(out)).not.toContain("flowOffset");
    expect(JSON.stringify(out)).toContain('"layout":"flow"');
  });

  test("serialize emits no column offsets either — same rule, other axis", () => {
    // A restored column slide would be worse than a restored flow one, not
    // better: the column it was measured against may have gained or lost
    // members while the deck was closed, so the number would point at a member
    // that is not there. Activating any member re-reveals it.
    const out = serialize({
      cards: [],
      panes: [],
      imposition: {
        kind: "three-up",
        sidebars: { dashes: { side: "right" } },
        columns: { 1: { mode: "split", order: ["p1", "p2", "p3"] } },
      },
      columnOffsets: { 1: 173 },
      hasFocus: true,
    });
    expect(JSON.stringify(out)).not.toContain("columnOffsets");
    // The ARRANGEMENT is serialized, and must be: the split and its order are
    // the user's choice. Only the viewport onto it is session state.
    expect(JSON.stringify(out)).toContain('"mode":"split"');
  });

  test("v4 round-trip: serialize → deserialize → serialize is stable", () => {
    const card: CardState = {
      id: "c1",
      componentId: "terminal",
      title: "T",
      closable: true,
    };
    const pane: TugPaneState = {
      id: "w1",
      // An in-bounds position (the fit clamp leaves panes that already fit
      // untouched) so the round-trip is genuinely a no-op.
      position: { x: 100, y: 100 },
      size: { width: 400, height: 300 },
      cardIds: ["c1"],
      activeCardId: "c1",
      title: "",
      acceptsFamilies: ["standard"],
    };
    const state: DeckState = {
      cards: [card],
      panes: [pane],
      activePaneId: "w1",
      // `contentWidth` spelled out because stability is a property of a state
      // that has BEEN through the reader: the reader fills an absent width with
      // its default, so a hand-built state omitting it gains a field on the
      // first pass and is stable only from the second.
      imposition: {
        kind: "one-up",
        contentWidth: "comfy",
        sidebars: { dashes: { side: "right" } },
      },
      hasFocus: true,
    };
    const first = serialize(state);
    const restored = deserialize(JSON.stringify(first), 1920, 1080);
    const second = serialize(restored);
    expect(second).toEqual(first);
  });

  test("deserialize with corrupt JSON falls back to buildDefaultLayout", () => {
    const result = deserialize("not-valid-json{{{", 1200, 800);
    expect(result.cards.length).toBe(0);
    expect(result.panes.length).toBe(0);
  });

  test("restore fits an oversized pane to a smaller canvas", () => {
    // A pane saved on a large display (900×1200 at 700,500) restored on a
    // 1280×800 laptop canvas must be capped to the canvas (less an 8px margin
    // per side) and pulled fully on-screen so its bottom (the prompt) does
    // not fall below the display.
    const card: CardState = {
      id: "card-big",
      componentId: "terminal",
      title: "Session",
      closable: true,
    };
    const pane: TugPaneState = {
      id: "pane-big",
      position: { x: 700, y: 500 },
      size: { width: 900, height: 1200 },
      cardIds: ["card-big"],
      activeCardId: "card-big",
      title: "",
      acceptsFamilies: ["standard"],
    };
    const json = JSON.stringify(serialize({ cards: [card], panes: [pane], imposition: { sidebars: { dashes: { side: "right" } } }, hasFocus: true }));
    const restored = deserialize(json, 1280, 800);
    const r = restored.panes[0];
    // Width (900) already fits the 1280 canvas; height (1200) is capped to the
    // canvas less an 8px margin per side (800 − 16 = 784).
    expect(r.size.width).toBe(900);
    expect(r.size.height).toBe(784);
    // x pulled in to keep the right edge within the margin (1280 − 8 − 900);
    // the capped height forces y to the top margin (800 − 8 − 784 = 8).
    expect(r.position.x).toBe(1280 - 8 - 900);
    expect(r.position.y).toBe(8);
    // Both edges keep an 8px margin from the canvas bounds.
    expect(r.position.x + r.size.width).toBeLessThanOrEqual(1280 - 8);
    expect(r.position.y + r.size.height).toBeLessThanOrEqual(800 - 8);
  });

  function dashesDeck(
    side: "left" | "right",
    size: { width: number; height: number },
  ): DeckState {
    const card: CardState = {
      id: "dashes",
      componentId: "dashes",
      title: "Arcs",
      closable: true,
    };
    const pane: TugPaneState = {
      id: "pane-dashes",
      // Geometry a rail card carries — width is its live width; position is
      // nominal, since the imposer pins it at render.
      position: { x: 0, y: 0 },
      size,
      cardIds: ["dashes"],
      activeCardId: "dashes",
      title: "Arcs",
      acceptsFamilies: [],
    };
    return {
      cards: [card],
      panes: [pane],
      imposition: { sidebars: { dashes: { side } } },
      hasFocus: true,
    };
  }

  test("round-trips a sidebar card's side through the imposition record", () => {
    for (const side of ["left", "right"] as const) {
      const json = JSON.stringify(
        serialize(dashesDeck(side, { width: 420, height: 1080 })),
      );
      const restored = deserialize(json, 1920, 1080);
      expect(sidebarSide(restored.imposition, "dashes")).toBe(side);
      expect(restored.panes[0].acceptsFamilies).toEqual([]);
    }
  });

  test("a legacy blob's stack fields are dropped, not honored", () => {
    // Same-side sidebars stand front-to-back now, so there is no vertical
    // order and no seam to restore. A blob written by the split build carries
    // both; reading them back would reinstate a geometry this build cannot
    // paint, so they come back as what they now are — nothing.
    const deck = dashesDeck("right", { width: 420, height: 1080 });
    const blob = serialize(deck) as Record<string, unknown>;
    const imposition = blob["imposition"] as Record<string, unknown>;
    imposition["sidebarSplit"] = { right: 0.72 };
    (imposition["sidebars"] as Record<string, Record<string, unknown>>)["dashes"][
      "order"
    ] = 1;
    const restored = deserialize(JSON.stringify(blob), 1920, 1080);
    expect(
      (restored.imposition as unknown as Record<string, unknown>)[
        "sidebarSplit"
      ],
    ).toBeUndefined();
    expect(
      (restored.imposition.sidebars["dashes"] as unknown as Record<
        string,
        unknown
      >)["order"],
    ).toBeUndefined();
    // The side, which still means something, survives.
    expect(restored.imposition.sidebars["dashes"]?.side).toBe("right");
  });

  test("a blob with no `pinned` flag reads as pinned", () => {
    // Every blob written before a sidebar could be dragged off its pin. Absent
    // must not mean floating, or an upgrade would scatter every deck's rail.
    const json = JSON.stringify(
      serialize(dashesDeck("right", { width: 420, height: 1080 })),
    );
    expect(JSON.parse(json).imposition.sidebars.dashes.pinned).toBeUndefined();
    expect(
      deserialize(json, 1920, 1080).imposition.sidebars["dashes"]?.pinned,
    ).toBeUndefined();
    expect(
      isSidebarPinned(deserialize(json, 1920, 1080).imposition, "dashes"),
    ).toBe(true);
  });

  test("round-trips a sidebar card that has been dragged off its pin", () => {
    const deck = dashesDeck("left", { width: 420, height: 1080 });
    const floating = {
      ...deck,
      imposition: withSidebarPinned(deck.imposition, "dashes", false),
    };
    const restored = deserialize(JSON.stringify(serialize(floating)), 1920, 1080);
    expect(restored.imposition.sidebars["dashes"]?.pinned).toBe(false);
    // The side survives the float, so re-pinning returns it to the same edge.
    expect(sidebarSide(restored.imposition, "dashes")).toBe("left");
  });

  test("a floating sidebar takes the canvas fit like any other free pane", () => {
    // Pinned, its geometry is derived and the clamp would be meaningless. Off
    // the pin it is an ordinary pane in the deck, and a deck restored on a
    // smaller display must not leave it hanging off the bottom.
    const deck = dashesDeck("right", { width: 500, height: 2000 });
    const floating = {
      ...deck,
      imposition: withSidebarPinned(deck.imposition, "dashes", false),
    };
    const r = deserialize(JSON.stringify(serialize(floating)), 1280, 800).panes[0];
    expect(r.size.height).toBeLessThanOrEqual(800);
  });

  test("restore pulls an off-bottom pane up so it stays fully visible", () => {
    // A pane that fits the canvas but was saved near the bottom of a taller
    // display is shifted up so its bottom edge stays within the canvas.
    const card: CardState = {
      id: "card-low",
      componentId: "terminal",
      title: "Session",
      closable: true,
    };
    const pane: TugPaneState = {
      id: "pane-low",
      position: { x: 40, y: 700 },
      size: { width: 400, height: 600 },
      cardIds: ["card-low"],
      activeCardId: "card-low",
      title: "",
      acceptsFamilies: ["standard"],
    };
    const json = JSON.stringify(serialize({ cards: [card], panes: [pane], imposition: { sidebars: { dashes: { side: "right" } } }, hasFocus: true }));
    const restored = deserialize(json, 1280, 800);
    const r = restored.panes[0];
    expect(r.size.width).toBe(400);
    expect(r.size.height).toBe(600);
    expect(r.position.x).toBe(40);
    // y pulled from 700 to 192 (800 − 8 − 600) so the bottom keeps an 8px margin.
    expect(r.position.y).toBe(192);
  });
});

// ---- v2 wire → v4 (via v3 pre-v4 field names on load) ----

describe("v2 → v4 migration", () => {
  test("hand-authored v2 blob deserializes to the same DeckState as equivalent v3 blob", () => {
    const v2 = {
      version: 2 as const,
      cards: [
        { id: "c1", componentId: "hello", title: "C1", closable: true },
        { id: "c2", componentId: "hello", title: "C2", closable: true },
      ],
      stacks: [
        {
          id: "s1",
          position: { x: 10, y: 20 },
          size: { width: 400, height: 300 },
          cardIds: ["c1", "c2"],
          activeCardId: "c1",
          title: "",
          acceptsFamilies: ["standard"],
        },
      ],
      activeStackId: "s1",
    };
    const v3 = {
      version: 3 as const,
      cards: v2.cards,
      windows: [
        {
          id: "s1",
          position: { x: 10, y: 20 },
          size: { width: 400, height: 300 },
          cardIds: ["c1", "c2"],
          activeCardId: "c1",
          title: "",
          acceptsFamilies: ["standard"],
        },
      ],
      activeWindowId: "s1",
    };
    expect(deserialize(JSON.stringify(v2), 1920, 1080)).toEqual(
      deserialize(JSON.stringify(v3), 1920, 1080),
    );
  });

  test("hand-authored v3 blob (pre-v4 on-disk shape) deserializes to the same DeckState as equivalent v4 blob", () => {
    const v3 = {
      version: 3 as const,
      cards: [
        { id: "c1", componentId: "hello", title: "C1", closable: true },
        { id: "c2", componentId: "hello", title: "C2", closable: true },
      ],
      windows: [
        {
          id: "s1",
          position: { x: 10, y: 20 },
          size: { width: 400, height: 300 },
          cardIds: ["c1", "c2"],
          activeCardId: "c1",
          title: "",
          acceptsFamilies: ["standard"],
        },
      ],
      activeWindowId: "s1",
    };
    const v4 = {
      version: 4 as const,
      cards: v3.cards,
      panes: v3.windows,
      activePaneId: "s1",
    };
    expect(deserialize(JSON.stringify(v3), 1920, 1080)).toEqual(
      deserialize(JSON.stringify(v4), 1920, 1080),
    );
  });
});

// ---- Legacy single-table (v1) migration ----

describe("v1 → two-table migration", () => {
  test("legacy v5 single-card blob migrates to a single-card stack", () => {
    const v1Blob = {
      version: 5,
      cards: [
        {
          id: "legacy-card-1",
          position: { x: 100, y: 200 },
          size: { width: 400, height: 300 },
          tabs: [
            { id: "legacy-tab-1", componentId: "terminal", title: "T", closable: true },
          ],
          activeTabId: "legacy-tab-1",
          title: "",
          acceptsFamilies: ["standard"],
        },
      ],
    };
    const restored = deserialize(JSON.stringify(v1Blob), 1920, 1080);
    expect(restored.panes.length).toBe(1);
    expect(restored.cards.length).toBe(1);
    // Stack id preserved from legacy card id.
    expect(restored.panes[0].id).toBe("legacy-card-1");
    // Card id preserved from legacy tab id.
    expect(restored.cards[0].id).toBe("legacy-tab-1");
    expect(restored.panes[0].cardIds).toEqual(["legacy-tab-1"]);
    expect(restored.panes[0].activeCardId).toBe("legacy-tab-1");
  });

  test("legacy multi-tab card migrates to a multi-card stack preserving order", () => {
    const v1Blob = {
      version: 5,
      cards: [
        {
          id: "legacy-card",
          position: { x: 0, y: 0 },
          size: { width: 400, height: 300 },
          tabs: [
            { id: "t1", componentId: "hello", title: "T1", closable: true },
            { id: "t2", componentId: "hello", title: "T2", closable: true },
            { id: "t3", componentId: "hello", title: "T3", closable: false },
          ],
          activeTabId: "t2",
          title: "",
          acceptsFamilies: ["standard"],
        },
      ],
    };
    const restored = deserialize(JSON.stringify(v1Blob), 1920, 1080);
    expect(restored.panes.length).toBe(1);
    expect(restored.cards.length).toBe(3);
    expect(restored.panes[0].cardIds).toEqual(["t1", "t2", "t3"]);
    expect(restored.panes[0].activeCardId).toBe("t2");
    expect(restored.cards.find((c) => c.id === "t3")?.closable).toBe(false);
  });

  test("v1 → two-table round-trip: hand-authored v1 loads, save emits version: 4", () => {
    const v1 = {
      version: 5,
      cards: [
        {
          id: "L1",
          position: { x: 20, y: 30 },
          size: { width: 400, height: 300 },
          tabs: [
            { id: "T1a", componentId: "hello", title: "A", closable: true },
            { id: "T1b", componentId: "hello", title: "B", closable: true },
          ],
          activeTabId: "T1b",
          title: "",
          acceptsFamilies: ["standard"],
        },
      ],
      focusedCardId: "T1b",
    };
    const loaded = deserialize(JSON.stringify(v1), 1920, 1080);
    expect(loaded.panes.length).toBe(1);
    // `focusedCardId` is persisted separately via putFocusedCardId — it
    // does not round-trip through the layout blob.
    expect((loaded as { focusedCardId?: string }).focusedCardId).toBeUndefined();
    const saved = serialize(loaded) as {
      version: number;
      focusedCardId?: string;
    };
    expect(saved.version).toBe(4);
    expect(saved.focusedCardId).toBeUndefined();
  });

  test("legacy blob without a `version` field still migrates", () => {
    const v1 = {
      cards: [
        {
          id: "noversion-card",
          position: { x: 0, y: 0 },
          size: { width: 400, height: 300 },
          tabs: [{ id: "nv-tab", componentId: "hello", title: "X", closable: true }],
          activeTabId: "nv-tab",
        },
      ],
    };
    const restored = deserialize(JSON.stringify(v1), 1920, 1080);
    expect(restored.panes.length).toBe(1);
    expect(restored.cards[0].id).toBe("nv-tab");
  });
});

// ---- CardStateBag + focusedCardId / CollapsedState ----

describe("TugPaneState widthPreset field", () => {
  test("serialize -> deserialize round-trip preserves widthPreset", () => {
    const card: CardState = { id: "c", componentId: "hello", title: "H", closable: true };
    const stack: TugPaneState = {
      id: "s",
      position: { x: 0, y: 0 },
      size: { width: 675, height: 300 },
      cardIds: ["c"],
      activeCardId: "c",
      title: "",
      acceptsFamilies: ["standard"],
      widthPreset: "slim",
    };
    const json = JSON.stringify(
      serialize({ cards: [card], panes: [stack], imposition: { sidebars: { dashes: { side: "right" } } }, hasFocus: true }),
    );
    const restored = deserialize(json, 1920, 1080);
    expect(restored.panes[0].widthPreset).toBe("slim");
  });

  test("a garbage widthPreset is dropped rather than restored", () => {
    // The stamp drives a check mark; a value outside the three would show a
    // check on no row and read as a control that lost track of itself.
    const blob = {
      version: 4,
      cards: [{ id: "c", componentId: "hello", title: "H", closable: true }],
      panes: [
        {
          id: "s",
          position: { x: 0, y: 0 },
          size: { width: 400, height: 300 },
          cardIds: ["c"],
          activeCardId: "c",
          widthPreset: "roomy",
        },
      ],
      imposition: { sidebars: { dashes: { side: "right" } } },
    };
    const restored = deserialize(JSON.stringify(blob), 1920, 1080);
    expect(restored.panes[0].widthPreset).toBeUndefined();
  });
});

describe("CardStateBag type", () => {
  test("CardStateBag with only scroll field is valid", () => {
    const bag: CardStateBag = { scroll: { x: 100, y: 250 } };
    expect(bag.scroll?.x).toBe(100);
  });

  test("empty CardStateBag is valid", () => {
    const bag: CardStateBag = {};
    expect(bag.scroll).toBeUndefined();
  });
});

describe("DeckState focusedCardId persistence", () => {
  test("serialize does not emit focusedCardId in the layout blob", () => {
    const state: DeckState = { cards: [], panes: [], imposition: { sidebars: { dashes: { side: "right" } } }, hasFocus: true };
    const blob = serialize(state) as Record<string, unknown>;
    expect("focusedCardId" in blob).toBe(false);
  });

  test("parseV4 ignores focusedCardId if present in a v4 blob", () => {
    const withFocused = {
      version: 4,
      cards: [],
      panes: [],
      focusedCardId: "card-abc",
    };
    const restored = deserialize(JSON.stringify(withFocused), 1920, 1080);
    expect((restored as { focusedCardId?: string }).focusedCardId).toBeUndefined();
  });

  test("v2 migration path ignores focusedCardId (not part of DeckState)", () => {
    const withFocused = {
      version: 2,
      cards: [],
      stacks: [],
      focusedCardId: "card-abc",
    };
    const restored = deserialize(JSON.stringify(withFocused), 1920, 1080);
    expect((restored as { focusedCardId?: string }).focusedCardId).toBeUndefined();
  });
});

// ---- Additional coverage ported from the pre-Card/CardStack test suite ----

describe("deserialize edge cases", () => {
  test("falls back activeCardId to cardIds[0] when activeCardId is missing", () => {
    const v2 = {
      version: 2,
      cards: [
        { id: "a", componentId: "hello", title: "A", closable: true },
        { id: "b", componentId: "hello", title: "B", closable: true },
      ],
      stacks: [
        {
          id: "s1",
          position: { x: 0, y: 0 },
          size: { width: 400, height: 300 },
          cardIds: ["a", "b"],
          // activeCardId intentionally omitted
        },
      ],
    };
    const restored = deserialize(JSON.stringify(v2), 1920, 1080);
    expect(restored.panes[0].activeCardId).toBe("a");
  });

  test("falls back activeCardId when it references a non-existent card", () => {
    const v2 = {
      version: 2,
      cards: [
        { id: "a", componentId: "hello", title: "A", closable: true },
        { id: "b", componentId: "hello", title: "B", closable: true },
      ],
      stacks: [
        {
          id: "s1",
          position: { x: 0, y: 0 },
          size: { width: 400, height: 300 },
          cardIds: ["a", "b"],
          activeCardId: "not-in-stack",
        },
      ],
    };
    const restored = deserialize(JSON.stringify(v2), 1920, 1080);
    expect(restored.panes[0].activeCardId).toBe("a");
  });

  test("round-trip with two multi-card stacks preserves both", () => {
    const cards: CardState[] = [
      { id: "a1", componentId: "hello", title: "A1", closable: true },
      { id: "a2", componentId: "hello", title: "A2", closable: true },
      { id: "b1", componentId: "hello", title: "B1", closable: true },
      { id: "b2", componentId: "hello", title: "B2", closable: false },
      { id: "b3", componentId: "hello", title: "B3", closable: true },
    ];
    const paneList: TugPaneState[] = [
      {
        id: "sa",
        position: { x: 10, y: 20 },
        size: { width: 400, height: 300 },
        cardIds: ["a1", "a2"],
        activeCardId: "a2",
        title: "",
        acceptsFamilies: ["standard"],
      },
      {
        id: "sb",
        position: { x: 200, y: 100 },
        size: { width: 450, height: 320 },
        cardIds: ["b1", "b2", "b3"],
        activeCardId: "b3",
        title: "",
        acceptsFamilies: ["standard"],
      },
    ];
    const json = JSON.stringify(
      serialize({ cards, panes: paneList, imposition: { sidebars: { dashes: { side: "right" } } }, hasFocus: true }),
    );
    const restored = deserialize(json, 1920, 1080);
    expect(restored.panes.length).toBe(2);
    expect(restored.panes[0].activeCardId).toBe("a2");
    expect(restored.panes[1].activeCardId).toBe("b3");
    expect(restored.cards.find((c) => c.id === "b2")?.closable).toBe(false);
  });

  test("deserialize with version:3 data falls back to buildDefaultLayout", () => {
    const json = JSON.stringify({ version: 3, root: {}, floating: [] });
    const result = deserialize(json, 1200, 800);
    expect(result.cards.length).toBe(0);
    expect(result.panes.length).toBe(0);
  });

  test("deserialize with version:4 data falls back to buildDefaultLayout", () => {
    const json = JSON.stringify({ version: 4, root: {}, floating: [] });
    const result = deserialize(json, 1200, 800);
    expect(result.cards.length).toBe(0);
    expect(result.panes.length).toBe(0);
  });

  test("deserialize pulls an off-canvas pane fully on-screen", () => {
    const v2 = {
      version: 2,
      cards: [{ id: "c1", componentId: "hello", title: "C", closable: true }],
      stacks: [
        {
          id: "s1",
          position: { x: 5000, y: 5000 },
          size: { width: 400, height: 300 },
          cardIds: ["c1"],
          activeCardId: "c1",
        },
      ],
    };
    const restored = deserialize(JSON.stringify(v2), 1920, 1080);
    expect(restored.panes.length).toBe(1);
    // Position is clamped so the whole pane (not just its title bar) fits,
    // keeping an 8px margin from the right and bottom edges.
    expect(restored.panes[0].position.x).toBe(1920 - 8 - 400);
    expect(restored.panes[0].position.y).toBe(1080 - 8 - 300);
  });

  test("deserialize enforces 100px minimum sizes", () => {
    const v2 = {
      version: 2,
      cards: [{ id: "c1", componentId: "hello", title: "C", closable: true }],
      stacks: [
        {
          id: "s1",
          position: { x: 0, y: 0 },
          size: { width: 50, height: 30 },
          cardIds: ["c1"],
          activeCardId: "c1",
        },
      ],
    };
    const restored = deserialize(JSON.stringify(v2), 1920, 1080);
    expect(restored.panes[0].size.width).toBe(100);
    expect(restored.panes[0].size.height).toBe(100);
  });
});

describe("a retired collapsed flag deserializes to an expanded pane", () => {
  // Window-shade collapse is gone. What an old blob's `collapsed: true` costs
  // is exactly one thing — the pane comes back expanded — and these pin that it
  // costs nothing else: the pane still loads, with its geometry intact and no
  // stray field riding along.
  const collapsedPane = {
    id: "s1",
    position: { x: 12, y: 34 },
    size: { width: 400, height: 300 },
    cardIds: ["c1"],
    activeCardId: "c1",
    collapsed: true,
  };

  test("a v2 blob's collapsed pane loads with its geometry and no collapsed field", () => {
    const v2 = {
      version: 2,
      cards: [{ id: "c1", componentId: "hello", title: "C", closable: true }],
      stacks: [collapsedPane],
    };
    const restored = deserialize(JSON.stringify(v2), 1920, 1080);
    expect(restored.panes.length).toBe(1);
    expect(restored.panes[0].size).toEqual({ width: 400, height: 300 });
    expect("collapsed" in restored.panes[0]).toBe(false);
  });

  test("a v4 blob's collapsed pane does the same", () => {
    const v4 = {
      version: 4,
      cards: [{ id: "c1", componentId: "hello", title: "C", closable: true }],
      panes: [collapsedPane],
      imposition: { sidebars: { dashes: { side: "right" } } },
    };
    const restored = deserialize(JSON.stringify(v4), 1920, 1080);
    expect(restored.panes.length).toBe(1);
    expect(restored.panes[0].size).toEqual({ width: 400, height: 300 });
    expect("collapsed" in restored.panes[0]).toBe(false);
  });
});

describe("CardStateBag type — additional coverage", () => {
  test("CardStateBag with all fields is valid", () => {
    const bag: CardStateBag = {
      scroll: { x: 0, y: 50 },
      content: { someKey: "someValue" },
      formControls: {
        name: { value: "hello", scrollTop: 10, scrollLeft: 0 },
      },
      regionScroll: null,
      domSelection: null,
      focus: null,
      components: { done: true },
    };
    expect(bag.scroll?.y).toBe(50);
    expect((bag.content as Record<string, string>)["someKey"]).toBe("someValue");
    expect(bag.formControls?.["name"].value).toBe("hello");
    expect(bag.regionScroll).toBeNull();
    expect(bag.domSelection).toBeNull();
    expect(bag.focus).toBeNull();
    expect(bag.components?.["done"]).toBe(true);
  });

  test("CardStateBag axes round-trip through JSON", () => {
    const bag: CardStateBag = {
      scroll: { x: 12, y: 34 },
      content: { text: "hi" },
      formControls: {
        query: { value: "abc", scrollTop: 0, scrollLeft: 5 },
      },
      regionScroll: null,
      domSelection: null,
      focus: null,
    };
    const round = JSON.parse(JSON.stringify(bag)) as CardStateBag;
    expect(round.scroll).toEqual({ x: 12, y: 34 });
    expect(round.content).toEqual({ text: "hi" });
    expect(round.formControls?.["query"].value).toBe("abc");
    expect(round.formControls?.["query"].scrollLeft).toBe(5);
    expect(round.regionScroll).toBeNull();
    expect(round.domSelection).toBeNull();
    expect(round.focus).toBeNull();
  });

  test("CardStateBag empty-axis cases round-trip cleanly", () => {
    const bag: CardStateBag = {};
    const round = JSON.parse(JSON.stringify(bag)) as CardStateBag;
    expect(round.scroll).toBeUndefined();
    expect(round.content).toBeUndefined();
    expect(round.formControls).toBeUndefined();
    expect(round.regionScroll).toBeUndefined();
    expect(round.domSelection).toBeUndefined();
    expect(round.focus).toBeUndefined();
  });

  test("FormControlSnapshot round-trip preserves value + scroll", () => {
    const bag: CardStateBag = {
      formControls: {
        a: { value: "x" },
        b: { value: "y", scrollTop: 3 },
        c: { value: "z", scrollLeft: 4 },
      },
    };
    const round = JSON.parse(JSON.stringify(bag)) as CardStateBag;
    expect(round.formControls?.["a"]).toEqual({ value: "x" });
    expect(round.formControls?.["b"]).toEqual({ value: "y", scrollTop: 3 });
    expect(round.formControls?.["c"]).toEqual({ value: "z", scrollLeft: 4 });
  });

  test("components axis round-trips with heterogeneous per-key payloads", () => {
    // bag.components is the Component State Preservation Protocol axis
    // ([D13], [A9]): framework harvests opt-in components keyed by
    // scoped componentStatePreservationKey. Values are serializable but
    // otherwise opaque to the framework — round-trip must preserve
    // arbitrary shapes.
    const bag: CardStateBag = {
      components: {
        "checkbox.done": true,
        "slider.volume": 0.42,
        "accordion.panel-a": { expanded: true, lastOpenedAt: 123 },
        "tab-bar": { activeId: "settings" },
      },
    };
    const round = JSON.parse(JSON.stringify(bag)) as CardStateBag;
    expect(round.components?.["checkbox.done"]).toBe(true);
    expect(round.components?.["slider.volume"]).toBe(0.42);
    expect(round.components?.["accordion.panel-a"]).toEqual({
      expanded: true,
      lastOpenedAt: 123,
    });
    expect(round.components?.["tab-bar"]).toEqual({ activeId: "settings" });
  });

  test("components axis round-trips when absent", () => {
    const bag: CardStateBag = { scroll: { x: 0, y: 0 } };
    const round = JSON.parse(JSON.stringify(bag)) as CardStateBag;
    expect(round.components).toBeUndefined();
  });

  test("components axis round-trips when empty", () => {
    const bag: CardStateBag = { components: {} };
    const round = JSON.parse(JSON.stringify(bag)) as CardStateBag;
    expect(round.components).toEqual({});
  });
});

describe("Two-table invariants via the parser", () => {
  test("stacks with zero cardIds after filtering are dropped", () => {
    // If cardIds contains only ids that don't exist in `cards`, the stack
    // should be dropped entirely (no empty windows invariant).
    const v2 = {
      version: 2,
      cards: [{ id: "real", componentId: "hello", title: "R", closable: true }],
      stacks: [
        {
          id: "s1",
          position: { x: 0, y: 0 },
          size: { width: 400, height: 300 },
          cardIds: ["real"],
          activeCardId: "real",
        },
        {
          id: "phantom",
          position: { x: 0, y: 0 },
          size: { width: 400, height: 300 },
          cardIds: ["missing"],
          activeCardId: "missing",
        },
      ],
    };
    const restored = deserialize(JSON.stringify(v2), 1920, 1080);
    expect(restored.panes.length).toBe(1);
    expect(restored.panes[0].id).toBe("s1");
  });

  test("orphan cards (not referenced by any stack) are dropped during deserialize", () => {
    // A card that no stack references should not be retained.
    const v2 = {
      version: 2,
      cards: [
        { id: "a", componentId: "hello", title: "A", closable: true },
        { id: "orphan", componentId: "hello", title: "Orphan", closable: true },
      ],
      stacks: [
        {
          id: "s1",
          position: { x: 0, y: 0 },
          size: { width: 400, height: 300 },
          cardIds: ["a"],
          activeCardId: "a",
        },
      ],
    };
    const restored = deserialize(JSON.stringify(v2), 1920, 1080);
    expect(restored.cards.length).toBe(1);
    expect(restored.cards[0].id).toBe("a");
  });
});

// ---------------------------------------------------------------------------
// validateDeckState — invariant checker
// ---------------------------------------------------------------------------

describe("validateDeckState", () => {
  function makeCard(id: string, componentId = "hello"): CardState {
    return { id, componentId, title: id, closable: true };
  }

  function makeStack(
    id: string,
    cardIds: string[],
    activeCardId: string,
  ): TugPaneState {
    return {
      id,
      position: { x: 0, y: 0 },
      size: { width: 400, height: 300 },
      cardIds,
      activeCardId,
      title: "",
      acceptsFamilies: ["standard"],
    };
  }

  test("accepts the empty deck", () => {
    expect(() => validateDeckState({ cards: [], panes: [], imposition: { sidebars: { dashes: { side: "right" } } }, hasFocus: true })).not.toThrow();
  });

  test("accepts a well-formed single-card, single-pane deck", () => {
    const state: DeckState = {
      cards: [makeCard("c1")],
      panes: [makeStack("s1", ["c1"], "c1")],
      imposition: { sidebars: { dashes: { side: "right" } } },
      hasFocus: true,
    };
    expect(() => validateDeckState(state)).not.toThrow();
  });

  test("accepts a well-formed multi-card pane with activePaneId set", () => {
    const state: DeckState = {
      cards: [makeCard("c1"), makeCard("c2"), makeCard("c3")],
      panes: [
        makeStack("s1", ["c1", "c2"], "c2"),
        makeStack("s2", ["c3"], "c3"),
      ],
      activePaneId: "s2",
      imposition: { sidebars: { dashes: { side: "right" } } },
      hasFocus: true,
    };
    expect(() => validateDeckState(state)).not.toThrow();
  });

  test("rejects a pane referencing a missing card id (invariant 1)", () => {
    const state: DeckState = {
      cards: [makeCard("c1")],
      panes: [makeStack("s1", ["c1", "ghost"], "c1")],
      imposition: { sidebars: { dashes: { side: "right" } } },
      hasFocus: true,
    };
    expect(() => validateDeckState(state)).toThrow(DeckStateInvariantError);
    expect(() => validateDeckState(state)).toThrow(/missing card id "ghost"/);
  });

  test("rejects a card appearing in two panes (invariant 2: no duplicates)", () => {
    const state: DeckState = {
      cards: [makeCard("c1"), makeCard("c2")],
      panes: [
        makeStack("s1", ["c1", "c2"], "c1"),
        makeStack("s2", ["c2"], "c2"),
      ],
      imposition: { sidebars: { dashes: { side: "right" } } },
      hasFocus: true,
    };
    expect(() => validateDeckState(state)).toThrow(DeckStateInvariantError);
    expect(() => validateDeckState(state)).toThrow(/appears in both pane/);
  });

  test("rejects an orphan card (invariant 2: every card has a host)", () => {
    const state: DeckState = {
      cards: [makeCard("c1"), makeCard("orphan")],
      panes: [makeStack("s1", ["c1"], "c1")],
      imposition: { sidebars: { dashes: { side: "right" } } },
      hasFocus: true,
    };
    expect(() => validateDeckState(state)).toThrow(DeckStateInvariantError);
    expect(() => validateDeckState(state)).toThrow(/"orphan" is orphaned/);
  });

  test("rejects an empty pane (invariant 3)", () => {
    const state: DeckState = {
      cards: [makeCard("c1")],
      panes: [
        makeStack("s1", ["c1"], "c1"),
        makeStack("s-empty", [], "x"),
      ],
      imposition: { sidebars: { dashes: { side: "right" } } },
      hasFocus: true,
    };
    expect(() => validateDeckState(state)).toThrow(DeckStateInvariantError);
    expect(() => validateDeckState(state)).toThrow(/empty cardIds/);
  });

  test("rejects activeCardId that is not in cardIds (invariant 4)", () => {
    const state: DeckState = {
      cards: [makeCard("c1"), makeCard("c2")],
      panes: [makeStack("s1", ["c1", "c2"], "ghost")],
      imposition: { sidebars: { dashes: { side: "right" } } },
      hasFocus: true,
    };
    expect(() => validateDeckState(state)).toThrow(DeckStateInvariantError);
    expect(() => validateDeckState(state)).toThrow(
      /activeCardId "ghost" is not in cardIds/,
    );
  });

  test("rejects activePaneId that references no real pane (invariant 5)", () => {
    const state: DeckState = {
      cards: [makeCard("c1")],
      panes: [makeStack("s1", ["c1"], "c1")],
      activePaneId: "no-such-stack",
      imposition: { sidebars: { dashes: { side: "right" } } },
      hasFocus: true,
    };
    expect(() => validateDeckState(state)).toThrow(DeckStateInvariantError);
    expect(() => validateDeckState(state)).toThrow(
      /activePaneId "no-such-stack" does not reference a real pane/,
    );
  });

  test("rejects duplicate card ids in deckState.cards", () => {
    const state: DeckState = {
      cards: [makeCard("c1"), makeCard("c1", "terminal")],
      panes: [makeStack("s1", ["c1"], "c1")],
      imposition: { sidebars: { dashes: { side: "right" } } },
      hasFocus: true,
    };
    expect(() => validateDeckState(state)).toThrow(/duplicate card id "c1"/);
  });

  test("rejects duplicate pane ids in deckState.panes", () => {
    const state: DeckState = {
      cards: [makeCard("c1"), makeCard("c2")],
      panes: [
        makeStack("s1", ["c1"], "c1"),
        makeStack("s1", ["c2"], "c2"),
      ],
      imposition: { sidebars: { dashes: { side: "right" } } },
      hasFocus: true,
    };
    expect(() => validateDeckState(state)).toThrow(/duplicate pane id "s1"/);
  });

  test("rejects a bullseyePaneId naming no real pane (invariant 8)", () => {
    const state: DeckState = {
      cards: [makeCard("c1")],
      panes: [makeStack("s1", ["c1"], "c1")],
      activePaneId: "s1",
      bullseyePaneId: "ghost",
      imposition: { sidebars: { dashes: { side: "right" } } },
      hasFocus: true,
    };
    expect(() => validateDeckState(state)).toThrow(DeckStateInvariantError);
    expect(() => validateDeckState(state)).toThrow(
      /bullseyePaneId "ghost" does not reference a real pane/,
    );
  });

  test("accepts a bullseyePaneId naming a sidebar pane (invariant 8)", () => {
    // A rail bullseyes like any other pane. Nothing about its record changes
    // while it does — it keeps the side and the width the band is inset by —
    // so the state that says "a rail card is in bullseye" is a legal one, and
    // the rail returns to the place that stayed reserved for it.
    const state: DeckState = {
      cards: [makeCard("dashes-card", "dashes")],
      panes: [makeStack("s-dashes", ["dashes-card"], "dashes-card")],
      activePaneId: "s-dashes",
      bullseyePaneId: "s-dashes",
      imposition: { sidebars: { dashes: { side: "right" } } },
      hasFocus: true,
    };
    expect(() => validateDeckState(state)).not.toThrow();
  });

  test("accepts a stale-but-real bullseyePaneId whose pane no longer holds focus", () => {
    // The raw id is allowed to outlive the focus that justified it — the
    // accessor derives it away. Asserting the responder relationship here
    // would throw on the normal path.
    const state: DeckState = {
      cards: [makeCard("c1"), makeCard("c2")],
      panes: [makeStack("s1", ["c1"], "c1"), makeStack("s2", ["c2"], "c2")],
      activePaneId: "s2",
      bullseyePaneId: "s1",
      imposition: { sidebars: { dashes: { side: "right" } } },
      hasFocus: true,
    };
    expect(() => validateDeckState(state)).not.toThrow();
  });

  /** Two slotted panes and a column arrangement over them — the shape every
   *  invariant-9 case below varies one thing in. */
  function columnState(
    columns: NonNullable<DeckState["imposition"]["columns"]>,
    slots: [number | undefined, number | undefined] = [0, 0],
  ): DeckState {
    const s1 = { ...makeStack("s1", ["c1"], "c1"), slot: slots[0] };
    const s2 = { ...makeStack("s2", ["c2"], "c2"), slot: slots[1] };
    return {
      cards: [makeCard("c1"), makeCard("c2")],
      panes: [s1, s2],
      imposition: { sidebars: { dashes: { side: "right" } }, columns },
      hasFocus: true,
    };
  }

  test("accepts a column naming the panes that stand in its slot (invariant 9)", () => {
    expect(() =>
      validateDeckState(columnState({ 0: { mode: "split", order: ["s1", "s2"] } })),
    ).not.toThrow();
  });

  test("accepts residue — an order naming a pane that is gone (invariant 9)", () => {
    // A column is keyed by pane id and nothing ever cleans it up, so an order
    // naming a closed pane is the resting state of a deck that has been used,
    // not a violation. Throwing here would make normal use crash dev builds.
    expect(() =>
      validateDeckState(
        columnState({ 0: { mode: "split", order: ["s1", "closed-long-ago"] } }),
      ),
    ).not.toThrow();
  });

  test("rejects a live pane recorded in another slot's column (invariant 9)", () => {
    // The one thing residue tolerance must not cover: a pane that IS standing,
    // named by a column it does not stand in. That member would be laid out
    // down a run its pane is nowhere near.
    const state = columnState({ 0: { order: ["s1", "s2"] } }, [0, 1]);
    expect(() => validateDeckState(state)).toThrow(DeckStateInvariantError);
    expect(() => validateDeckState(state)).toThrow(
      /column 0 names pane "s2" as a member, but that pane stands in slot 1/,
    );
  });

  test("rejects a column naming a pane that stands outside the chain (invariant 9)", () => {
    const state = columnState({ 0: { order: ["s1", "s2"] } }, [0, undefined]);
    expect(() => validateDeckState(state)).toThrow(
      /names pane "s2" as a member, but that pane stands outside the chain/,
    );
  });

  test("a stacked column is held to the same rule as a split one (invariant 9)", () => {
    // The order survives re-stacking, so it must stay truthful across the
    // flip — otherwise a wrong member would only surface on the next split.
    expect(() =>
      validateDeckState(
        columnState({ 0: { mode: "stack", order: ["s1", "s2"] } }, [0, 1]),
      ),
    ).toThrow(DeckStateInvariantError);
  });

  test("a deck persisted with a stranded member comes back usable (invariant 9)", () => {
    // The shape that actually shipped: a card moved out of a split slot, the
    // columns record was committed untouched, and the deck was saved naming a
    // pane in a slot it no longer stood in. Every launch after that threw on
    // the first validate and came up on the error overlay — so healing the
    // live mutation is not enough, the load has to heal what is already on
    // disk. `deserialize` sweeps, and the restored state validates.
    const stranded = columnState({ 0: { mode: "split", order: ["s1", "s2"] } }, [0, 1]);
    expect(() => validateDeckState(stranded)).toThrow(DeckStateInvariantError);

    const restored = deserialize(JSON.stringify(serialize(stranded)), 1920, 1080);
    expect(() => validateDeckState(restored)).not.toThrow();
    expect(restored.imposition.columns?.[0]?.order).toEqual(["s1"]);
    // The slot keeps how it stands; only the lie about membership is removed.
    expect(restored.imposition.columns?.[0]?.mode).toBe("split");
  });
});

// ---- Imposition: the additive-optional `imposition` / `slot` wire fields ----

describe("imposition wire format", () => {
  function impositionCard(id: string): CardState {
    return { id, componentId: "terminal", title: "Session", closable: true };
  }

  function impositionPane(
    id: string,
    cardId: string,
    extra: Partial<TugPaneState> = {},
  ): TugPaneState {
    return {
      id,
      position: { x: 40, y: 40 },
      size: { width: 600, height: 900 },
      cardIds: [cardId],
      activeCardId: cardId,
      title: "",
      acceptsFamilies: ["standard"],
      ...extra,
    };
  }

  test("round-trips the kind and every pane's slot", () => {
    const state: DeckState = {
      cards: [impositionCard("c1"), impositionCard("c2"), impositionCard("c3")],
      panes: [
        impositionPane("p1", "c1", { slot: 0 }),
        impositionPane("p2", "c2", { slot: 1 }),
        impositionPane("p3", "c3", { slot: 2 }),
      ],
      imposition: { kind: "three-up", sidebars: { dashes: { side: "right" } } },
      hasFocus: true,
    };
    const restored = deserialize(JSON.stringify(serialize(state)), 1920, 1080);
    expect(restored.imposition).toEqual({
      kind: "three-up",
      contentWidth: "comfy",
      sidebars: { dashes: { side: "right" } },
    });
    expect(restored.panes.map((p) => p.slot)).toEqual([0, 1, 2]);
  });

  test("does not fit-clamp a slotted pane (geometry derives at render)", () => {
    // Saved on a tall display, restored on a short one. A free pane would be
    // height-clamped and pulled inside the margins; a slotted pane keeps its
    // stored geometry exactly as an anchored one does.
    const state: DeckState = {
      cards: [impositionCard("c1")],
      panes: [
        impositionPane("p1", "c1", {
          slot: 1,
          position: { x: 900, y: 700 },
          size: { width: 800, height: 2000 },
        }),
      ],
      imposition: { kind: "three-up", sidebars: { dashes: { side: "right" } } },
      hasFocus: true,
    };
    const r = deserialize(JSON.stringify(serialize(state)), 1280, 800).panes[0];
    expect(r.position).toEqual({ x: 900, y: 700 });
    expect(r.size).toEqual({ width: 800, height: 2000 });
  });

  test("a blob with no kind restores under the default arrangement", () => {
    const state: DeckState = {
      cards: [impositionCard("c1")],
      panes: [impositionPane("p1", "c1")],
      imposition: { sidebars: { dashes: { side: "right" } } },
      hasFocus: true,
    };
    const blob = serialize(state) as Record<string, unknown>;
    expect(blob["imposition"]).toEqual({
      sidebars: { dashes: { side: "right" } },
    });
    const restored = deserialize(JSON.stringify(blob), 1920, 1080);
    expect(restored.imposition.kind).toBe(DEFAULT_IMPOSITION_KIND);
    expect(restored.panes[0].slot).toBeUndefined();
  });

  test("an unreadable kind restores under the default arrangement", () => {
    const blob = {
      version: 4,
      imposition: "seven-up",
      cards: [impositionCard("c1")],
      panes: [impositionPane("p1", "c1", { slot: 1 })],
    };
    const restored = deserialize(JSON.stringify(blob), 1920, 1080);
    expect(restored.imposition.kind).toBe(DEFAULT_IMPOSITION_KIND);
    // The stored slot clamps into the default arrangement's slot range rather
    // than being dropped: a deck always stands under an arrangement.
    expect(restored.panes[0].slot).toBe(
      Math.min(1, slotCount(DEFAULT_IMPOSITION_KIND) - 1),
    );
  });

  test("an out-of-range slot clamps to the kind's last slot", () => {
    const blob = {
      version: 4,
      imposition: "two-up",
      cards: [impositionCard("c1")],
      panes: [impositionPane("p1", "c1", { slot: 7 })],
    };
    expect(deserialize(JSON.stringify(blob), 1920, 1080).panes[0].slot).toBe(1);
  });

  test("a malformed slot is dropped rather than coerced", () => {
    for (const bogus of [-1, 1.5, "1", null, Number.NaN]) {
      const blob = {
        version: 4,
        imposition: "three-up",
        cards: [impositionCard("c1")],
        panes: [{ ...impositionPane("p1", "c1"), slot: bogus }],
      };
      const restored = deserialize(JSON.stringify(blob), 1920, 1080);
      expect(restored.panes[0].slot).toBeUndefined();
    }
  });

  test("validateDeckState rejects a slotted sidebar pane (invariant 6)", () => {
    const state: DeckState = {
      cards: [
        { id: "dashes", componentId: "dashes", title: "Arcs", closable: true },
      ],
      panes: [impositionPane("p1", "dashes", { slot: 1 })],
      imposition: { kind: "three-up", sidebars: { dashes: { side: "right" } } },
      hasFocus: true,
    };
    expect(() => validateDeckState(state)).toThrow(DeckStateInvariantError);
    expect(() => validateDeckState(state)).toThrow(
      /sidebar pane "p1" carries slot 1/,
    );
  });

  test("validateDeckState rejects two panes hosting one sidebar card (invariant 6)", () => {
    const state: DeckState = {
      cards: [
        { id: "dashes-a", componentId: "dashes", title: "Arcs", closable: true },
        { id: "dashes-b", componentId: "dashes", title: "Arcs", closable: true },
      ],
      panes: [
        impositionPane("p1", "dashes-a"),
        impositionPane("p2", "dashes-b"),
      ],
      imposition: { sidebars: { dashes: { side: "right" } } },
      hasFocus: true,
    };
    expect(() => validateDeckState(state)).toThrow(
      /panes "p1" and "p2" both host the "dashes" sidebar card/,
    );
  });

  test("a slotted pane on its own passes validation", () => {
    const state: DeckState = {
      cards: [impositionCard("c1")],
      panes: [impositionPane("p1", "c1", { slot: 2 })],
      imposition: { kind: "three-up", sidebars: { dashes: { side: "right" } } },
      hasFocus: true,
    };
    expect(() => validateDeckState(state)).not.toThrow();
  });
});

// ---- The imposition record: defaults, and entries that do not read ----

describe("imposition record defaults", () => {
  function blobWith(imposition: unknown): string {
    return JSON.stringify({
      version: 4,
      ...(imposition !== undefined ? { imposition } : {}),
      cards: [{ id: "c1", componentId: "terminal", title: "", closable: true }],
      panes: [
        {
          id: "p1",
          position: { x: 0, y: 0 },
          size: { width: 400, height: 300 },
          cardIds: ["c1"],
          activeCardId: "c1",
          title: "",
          acceptsFamilies: ["standard"],
        },
      ],
    });
  }

  test("an absent contentWidth reads as comfy", () => {
    // Comfy IS the width content cards have always opened at, so a blob written
    // before the presets existed migrates to exactly its own behavior.
    const restored = deserialize(blobWith({ kind: "two-up" }), 1920, 1080);
    expect(restored.imposition.contentWidth).toBe("comfy");
  });

  test("a sidebars entry with no readable side is dropped, not defaulted", () => {
    // An unplaced sidebar takes its default at the moment it opens; inventing
    // an entry here would record that default as though the user chose it.
    const json = blobWith({ sidebars: { jots: { side: "sideways" } } });
    expect(
      deserialize(json, 1920, 1080).imposition.sidebars["jots"],
    ).toBeUndefined();
  });

  test("an unparseable blob comes back as the default layout", () => {
    // Nothing parsed, so nothing is placed: the default layout is what the
    // deck opens under, and it is what records the rail's frontmost card.
    expect(deserialize("{{{", 1920, 1080)).toEqual(buildDefaultLayout());
    expect(sidebarSide(buildDefaultLayout().imposition, "cards")).toBe("right");
  });
});

// ---- imposition.rails: how each side's cards stand against one another ----

describe("imposition rails", () => {
  function railBlob(imposition: Record<string, unknown>): string {
    return JSON.stringify({
      version: 4,
      imposition,
      cards: [
        { id: "dashes-1", componentId: "dashes", title: "Arcs", closable: true },
      ],
      panes: [
        {
          id: "dashes-pane",
          position: { x: 0, y: 0 },
          size: { width: 420, height: 900 },
          cardIds: ["dashes-1"],
          activeCardId: "dashes-1",
          title: "Arcs",
          acceptsFamilies: [],
        },
      ],
    });
  }

  const railsOf = (imposition: Record<string, unknown>) =>
    deserialize(railBlob(imposition), 1920, 1080).imposition.rails;

  const sidebars = { dashes: { side: "right" }, jots: { side: "right" } };

  test("a divided rail round-trips whole, and a stored mode is dropped", () => {
    const imposition = {
      kind: "three-up",
      contentWidth: "comfy",
      sidebars,
      rails: {
        right: {
          // A pre-[B01] blob's `mode`: read past and gone from the next write.
          mode: "split",
          order: ["jots", "dashes"],
          shares: { jots: 1.4, dashes: 1 },
        },
      },
    };
    const restored = deserialize(railBlob(imposition), 1920, 1080);
    expect(restored.imposition.rails).toEqual({
      right: {
        order: ["jots", "dashes"],
        shares: { jots: 1.4, dashes: 1 },
      },
    });
    // serialize() emits the imposition whole, so the record survives a save.
    const saved = serialize(restored) as { imposition: { rails?: unknown } };
    expect(saved.imposition.rails).toEqual(restored.imposition.rails);
    // And the saved blob restores to the same arrangement, so a split survives
    // relaunch rather than only surviving the session that made it.
    expect(
      deserialize(JSON.stringify(saved), 1920, 1080).imposition,
    ).toEqual(restored.imposition);
  });

  test("a pre-split blob has no rails at all — every side is a stack", () => {
    expect(railsOf({ kind: "three-up", sidebars })).toBeUndefined();
  });

  test("an unreadable mode is read past, leaving the order standing", () => {
    // A rail is always divided ([B01]), so a `mode` from an older blob says
    // nothing about the side either way — readable or not, it is skipped and
    // the order and shares beside it come back whole.
    expect(
      railsOf({
        sidebars,
        rails: { right: { mode: "sideways", order: ["jots", "dashes"] } },
      }),
    ).toEqual({ right: { order: ["jots", "dashes"] } });
  });


  test("shares are dropped per key, not per side", () => {
    expect(
      railsOf({
        sidebars,
        rails: {
          right: {
            shares: {
              dashes: 2,
              jots: -1,
              overview: 0,
              a: Number.NaN,
              b: "3",
              c: null,
            },
          },
        },
      }),
    ).toEqual({ right: { shares: { dashes: 2 } } });
  });

  test("non-string order entries are dropped", () => {
    expect(
      railsOf({
        sidebars,
        rails: { right: { order: ["jots", 4, null, "dashes"] } },
      }),
    ).toEqual({ right: { order: ["jots", "dashes"] } });
  });

  test("a record nothing survives is an absent side", () => {
    expect(
      railsOf({
        sidebars,
        rails: { right: { order: [], shares: { dashes: -1 } } },
      }),
    ).toBeUndefined();
    expect(railsOf({ sidebars, rails: {} })).toBeUndefined();
    expect(railsOf({ sidebars, rails: "split" })).toBeUndefined();
    expect(railsOf({ sidebars, rails: null })).toBeUndefined();
  });

  test("componentIds in order and shares migrate through the kind-rename history", () => {
    // The Session card shipped as `"dev"`; a rail that named a member by its
    // old id would otherwise drop that member's place on the first rename.
    expect(
      railsOf({
        sidebars,
        rails: {
          right: {
            order: ["dev", "dashes"],
            shares: { dev: 2, dashes: 1 },
          },
        },
      }),
    ).toEqual({
      right: {
        order: ["session", "dashes"],
        shares: { session: 2, dashes: 1 },
      },
    });
  });

  test("a first-split-era blob keeps its per-entry order dropped and invents no rails", () => {
    // The rejected automatic split wrote `order` inside each SidebarEntry.
    // That field has been dropped on read since the stack shipped, and the new
    // record is a sibling of `sidebars` — it is not built from that fossil.
    const restored = deserialize(
      railBlob({
        kind: "three-up",
        sidebars: {
          dashes: { side: "right", order: 1 },
          jots: { side: "right", order: 0 },
        },
      }),
      1920,
      1080,
    );
    expect(restored.imposition.rails).toBeUndefined();
    expect(restored.imposition.sidebars).toEqual({
      dashes: { side: "right" },
      jots: { side: "right" },
    });
  });
});

describe("imposition columns", () => {
  function columnBlob(imposition: Record<string, unknown>): string {
    return JSON.stringify({
      version: 4,
      imposition,
      cards: [
        { id: "c1", componentId: "hello", title: "One", closable: true },
      ],
      panes: [
        {
          id: "pane-1",
          position: { x: 0, y: 0 },
          size: { width: 800, height: 900 },
          cardIds: ["c1"],
          activeCardId: "c1",
          title: "One",
          acceptsFamilies: [],
          slot: 0,
        },
      ],
    });
  }

  const columnsOf = (imposition: Record<string, unknown>) =>
    deserialize(columnBlob(imposition), 1920, 1080).imposition.columns;

  const sidebars = { dashes: { side: "right" } };

  test("a split column round-trips whole", () => {
    const imposition = {
      kind: "three-up",
      contentWidth: "comfy",
      sidebars,
      columns: {
        0: {
          mode: "split",
          order: ["pane-1", "pane-2"],
          shares: { "pane-1": 1.5, "pane-2": 1 },
        },
      },
    };
    const restored = deserialize(columnBlob(imposition), 1920, 1080);
    expect(restored.imposition.columns).toEqual({
      0: {
        mode: "split",
        order: ["pane-1", "pane-2"],
        shares: { "pane-1": 1.5, "pane-2": 1 },
      },
    });
    // serialize() emits the imposition whole, so the record survives a save,
    // and the saved blob restores to the same arrangement — a split column
    // survives relaunch rather than only the session that made it.
    const saved = serialize(restored) as { imposition: { columns?: unknown } };
    expect(saved.imposition.columns).toEqual(restored.imposition.columns);
    expect(deserialize(JSON.stringify(saved), 1920, 1080).imposition).toEqual(
      restored.imposition,
    );
  });

  test("a pre-column blob has no columns at all — every slot is a stack", () => {
    expect(columnsOf({ kind: "three-up", sidebars })).toBeUndefined();
  });

  test("an unreadable mode drops the whole column", () => {
    // Same reading as a rail's: the order and heights describe an arrangement,
    // and applying them under a guessed mode shows the user a division nobody
    // chose.
    expect(
      columnsOf({
        sidebars,
        columns: { 0: { mode: "sideways", order: ["pane-1"] } },
      }),
    ).toBeUndefined();
  });

  test("one bad column leaves the others standing", () => {
    expect(
      columnsOf({
        sidebars,
        columns: { 0: { mode: "split" }, 1: { mode: 7 } },
      }),
    ).toEqual({ 0: { mode: "split" } });
  });

  test("a key that is not a slot index is dropped", () => {
    // The keys come back from JSON as strings and are read as slot numbers.
    // Anything that is not a non-negative integer names no slot the imposer
    // will ever ask about, so keeping it would be storing garbage forever.
    expect(
      columnsOf({
        sidebars,
        columns: {
          0: { mode: "split" },
          left: { mode: "split" },
          "1.5": { mode: "split" },
          "-1": { mode: "split" },
        },
      }),
    ).toEqual({ 0: { mode: "split" } });
  });

  test("a slot the current kind does not reach is KEPT", () => {
    // A deck dropped from six-up to three-up must remember how its fifth
    // column stood, and get it back on the way up. The imposer only ever asks
    // about slots it has, so an out-of-range entry costs nothing to keep and
    // pruning it would destroy an arrangement the user chose.
    expect(
      columnsOf({
        kind: "three-up",
        sidebars,
        columns: { 5: { mode: "split", order: ["pane-9"] } },
      }),
    ).toEqual({ 5: { mode: "split", order: ["pane-9"] } });
  });

  test("shares are dropped per key, not per column", () => {
    expect(
      columnsOf({
        sidebars,
        columns: {
          0: {
            mode: "split",
            shares: {
              "pane-1": 2,
              "pane-2": -1,
              "pane-3": 0,
              "pane-4": Number.NaN,
              "pane-5": "3",
              "pane-6": null,
            },
          },
        },
      }),
    ).toEqual({ 0: { mode: "split", shares: { "pane-1": 2 } } });
  });

  test("non-string order entries are dropped", () => {
    expect(
      columnsOf({
        sidebars,
        columns: { 0: { order: ["pane-1", 4, null, "pane-2"] } },
      }),
    ).toEqual({ 0: { order: ["pane-1", "pane-2"] } });
  });

  test("pane ids do NOT run through the componentId rename history", () => {
    // A rail's members are componentIds and migrate; a column's are pane ids,
    // which have no rename history. A pane that happened to be called "dev"
    // must come back called "dev" — migrating it would rename a member to an
    // id no pane has.
    expect(
      columnsOf({ sidebars, columns: { 0: { order: ["dev", "dashes"] } } }),
    ).toEqual({ 0: { order: ["dev", "dashes"] } });
  });

  test("a record nothing survives is an absent column set", () => {
    expect(
      columnsOf({
        sidebars,
        columns: { 0: { order: [], shares: { "pane-1": -1 } } },
      }),
    ).toBeUndefined();
    expect(columnsOf({ sidebars, columns: {} })).toBeUndefined();
    expect(columnsOf({ sidebars, columns: "split" })).toBeUndefined();
    expect(columnsOf({ sidebars, columns: null })).toBeUndefined();
  });
});
