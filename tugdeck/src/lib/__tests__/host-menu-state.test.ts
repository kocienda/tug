import { describe, expect, test } from "bun:test";

import {
  computeEditCapabilities,
  computeFileMenuGates,
  EMPTY_EDIT_CAPABILITIES,
  HostMenuStatePublisher,
  projectDeckState,
  registerMenuCapsRefresher,
  requestMenuStateRefresh,
  type MenuStateSessionBlock,
  type MenuStateEditBlock,
  type MenuStateFileBlock,
  type MenuStatePayload,
} from "../host-menu-state";
import { TUG_ACTIONS } from "../../components/tugways/action-vocabulary";
import { cardTitleStore } from "../card-title-store";
import { registerCard } from "../../card-registry";
import type { CardState, DeckState, TugPaneState } from "../../layout-tree";
import type { SpacesSnapshot } from "../../spaces";

function card(id: string, overrides: Partial<CardState> = {}): CardState {
  return {
    id,
    componentId: "session",
    title: `Card ${id}`,
    closable: true,
    ...overrides,
  };
}

function pane(
  id: string,
  cardIds: string[],
  overrides: Partial<TugPaneState> = {},
): TugPaneState {
  return {
    id,
    position: { x: 0, y: 0 },
    size: { width: 400, height: 300 },
    cardIds,
    activeCardId: cardIds[0],
    title: "",
    acceptsFamilies: ["standard"],
    ...overrides,
  };
}

function deck(cards: CardState[], panes: TugPaneState[]): DeckState {
  return { cards, panes, imposition: { sidebars: { dashes: { side: "right" } } }, hasFocus: true };
}

/**
 * A spaces snapshot for the projection. The mounted fields are the canvas's
 * ([B06]) and the Window menu's projection reads neither, so they are empty
 * here rather than repeated at every call.
 */
function spacesOf(
  spaces: readonly { id: string; name: string }[],
  activeSpaceId: string,
): SpacesSnapshot {
  return { spaces, activeSpaceId, mountedSpaceIds: [], mountedDecks: new Map() };
}

// Pane names resolve through the card registry now, so the projection tests
// need two kinds registered: one whose name is baked in, and one (the Session
// card's shape) whose registry title is empty because its identity is only
// ever a runtime override.
registerCard({
  componentId: "menu-state-titled",
  contentFactory: () => null,
  defaultMeta: { title: "File", closable: true },
});
registerCard({
  componentId: "menu-state-dynamic",
  contentFactory: () => null,
  defaultMeta: { title: "", closable: true },
});
// A rail, for the card-width projection: a sidebar pane has no preset to set.
registerCard({
  componentId: "menu-state-rail",
  contentFactory: () => null,
  defaultMeta: { title: "Rail", closable: true },
  layoutRole: "sidebar",
});

describe("projectDeckState", () => {
  test("empty deck projects no panes and a null activeCard", () => {
    const projection = projectDeckState(deck([], []));
    expect(projection.panes).toEqual([]);
    expect(projection.activeCard).toBeNull();
  });

  test("focused pane is the last in z-order; list is reversed to topmost-first", () => {
    const state = deck(
      [card("a"), card("b")],
      [pane("p1", ["a"]), pane("p2", ["b"])],
    );
    const projection = projectDeckState(state);
    expect(projection.panes.map((p) => p.id)).toEqual(["p2", "p1"]);
    expect(projection.panes[0].focused).toBe(true);
    expect(projection.panes[1].focused).toBe(false);
  });

  test("no spaces snapshot projects an empty workspace list", () => {
    expect(projectDeckState(deck([], [])).spaces).toEqual([]);
  });

  test("every workspace is projected in order, the rendered one marked", () => {
    const projection = projectDeckState(
      deck([], []),
      spacesOf(
        [
          { id: "s1", name: "Main" },
          { id: "s2", name: "Second" },
        ],
        "s2",
      ),
    );
    expect(projection.spaces).toEqual([
      { id: "s1", name: "Main", active: false },
      { id: "s2", name: "Second", active: true },
    ]);
  });

  test("pane entries carry cardCount and the active card's closable", () => {
    const state = deck(
      [card("a", { closable: false }), card("b")],
      [pane("p1", ["a", "b"], { activeCardId: "a" })],
    );
    const [entry] = projectDeckState(state).panes;
    expect(entry.cardCount).toBe(2);
    expect(entry.closable).toBe(false);
  });

  test("a pane is named the way its own title bar names it", () => {
    // The Window menu's pane list, the slot-stack picker, and the title bar
    // all resolve a pane's name through `paneTitleBarTextFor`, so this asserts
    // the projection has adopted that rule rather than a private one. The
    // previous rule here was a `CardState.title` fallback chain, which read
    // `Untitled` for exactly the cards whose title bars are most informative:
    // a Session card's name lives entirely in its live override.
    const cards = [card("a", { componentId: "menu-state-titled" })];
    const named = deck(cards, [pane("p1", ["a"])]);
    expect(projectDeckState(named).panes[0].title).toBe("File");

    // `CardState.title` is NOT the name — the old rule's input is ignored.
    expect(projectDeckState(named).panes[0].title).not.toContain("Card a");

    // A multi-tab pane's group name prefixes it, as on the title bar.
    const grouped = deck(
      [
        card("a", { componentId: "menu-state-titled" }),
        card("b", { componentId: "menu-state-titled" }),
      ],
      [pane("p1", ["a", "b"], { title: "Notes" })],
    );
    expect(projectDeckState(grouped).panes[0].title).toBe("Notes : File");

    // A card whose identity is dynamic is named by its override, and by
    // nothing at all before it publishes one.
    const dynamic = deck(
      [card("a", { componentId: "menu-state-dynamic" })],
      [pane("p1", ["a"])],
    );
    expect(projectDeckState(dynamic).panes[0].title).toBe("Untitled");
    cardTitleStore.set("a", "test-repo/petit-thaw");
    try {
      expect(projectDeckState(dynamic).panes[0].title).toBe(
        "test-repo/petit-thaw",
      );
    } finally {
      cardTitleStore.clear("a");
    }
  });

  test("activeCard reflects the focused pane's active card component", () => {
    const state = deck(
      [card("a", { componentId: "git" }), card("b", { componentId: "session", closable: false })],
      [pane("p1", ["a"]), pane("p2", ["b"])],
    );
    expect(projectDeckState(state).activeCard).toEqual({
      component: "session",
      closable: false,
    });
  });

  test("selectionActive tracks activePaneId (deselect clears it)", () => {
    const base = deck([card("a")], [pane("p1", ["a"])]);
    // Deselected — no active pane (a click on the empty canvas).
    expect(projectDeckState(base).selectionActive).toBe(false);
    // A card is selected.
    expect(
      projectDeckState({ ...base, activePaneId: "p1" }).selectionActive,
    ).toBe(true);
  });

  test("stackDepth counts the panes sharing the focused pane's slot", () => {
    // p2 is last in the array, so it is the focused (z-order top) pane, and it
    // shares slot 0 with p1.
    const state: DeckState = {
      ...deck(
        [card("a"), card("b")],
        [pane("p1", ["a"], { slot: 0 }), pane("p2", ["b"], { slot: 0 })],
      ),
      activePaneId: "p2",
    };
    expect(projectDeckState(state).stackDepth).toBe(2);
  });

  test("stackDepth is 1 for a focused pane alone in its slot", () => {
    const state: DeckState = {
      ...deck(
        [card("a"), card("b")],
        [pane("p1", ["a"], { slot: 0 }), pane("p2", ["b"], { slot: 1 })],
      ),
      activePaneId: "p2",
    };
    expect(projectDeckState(state).stackDepth).toBe(1);
  });

  test("stackDepth is 0 for a focused free pane — it holds no slot", () => {
    const state: DeckState = {
      ...deck(
        [card("a"), card("b")],
        [pane("p1", ["a"], { slot: 0 }), pane("p2", ["b"])],
      ),
      activePaneId: "p2",
    };
    expect(projectDeckState(state).stackDepth).toBe(0);
  });

  test("stackDepth is 0 when nothing is selected, even with a stack present", () => {
    // The guard for the invariant the formula rests on: `focusedStack` is
    // the array's last element while the chord dispatches to `activePaneId`'s
    // pane. A deselected deck is the one state where those part.
    const state = deck(
      [card("a"), card("b")],
      [pane("p1", ["a"], { slot: 0 }), pane("p2", ["b"], { slot: 0 })],
    );
    expect(state.activePaneId).toBeUndefined();
    expect(projectDeckState(state).stackDepth).toBe(0);
  });

  test("cardWidth carries the focused pane's stamp, and null where the popup would not draw", () => {
    const base = deck([card("a")], [pane("p1", ["a"], { widthPreset: "wide" })]);
    expect(projectDeckState({ ...base, activePaneId: "p1" }).cardWidth).toEqual({
      preset: "wide",
    });

    // Dragged to a width of its own: settable, no preset stamped.
    const unstamped = deck([card("a")], [pane("p1", ["a"])]);
    expect(projectDeckState({ ...unstamped, activePaneId: "p1" }).cardWidth).toEqual({
      preset: null,
    });

    // Deselected: no pane to set a width on.
    expect(projectDeckState(base).cardWidth).toBeNull();

    // A rail takes its width from the allocator, so the commands do not
    // apply — the same condition the title bar hides its width popup behind.
    const rail = deck(
      [card("s", { componentId: "menu-state-rail" })],
      [pane("p1", ["s"])],
    );
    expect(projectDeckState({ ...rail, activePaneId: "p1" }).cardWidth).toBeNull();
  });

  test("bullseye gates on selection and refuses a rail, and reads the derived id", () => {
    const base = deck([card("a")], [pane("p1", ["a"])]);

    // Selected content pane, not bullseyed.
    expect(projectDeckState({ ...base, activePaneId: "p1" }).bullseye).toEqual({
      on: false,
    });

    // Bullseyed and focused.
    expect(
      projectDeckState({
        ...base,
        activePaneId: "p1",
        bullseyePaneId: "p1",
      }).bullseye,
    ).toEqual({ on: true });

    // Deselected: no pane to put in bullseye.
    expect(projectDeckState(base).bullseye).toBeNull();

    // A rail refuses both facts. `cardWidth` has no preset to set; bullseye
    // would take the rail off the edge it is holding a place open on, which
    // the store refuses outright — so the row reads inapplicable rather than
    // offering a press that lands nowhere.
    const rail = deck(
      [card("s", { componentId: "menu-state-rail" })],
      [pane("p1", ["s"])],
    );
    expect(projectDeckState({ ...rail, activePaneId: "p1" }).cardWidth).toBeNull();
    expect(projectDeckState({ ...rail, activePaneId: "p1" }).bullseye).toBeNull();
    // Even with a raw id parked on the rail's pane: the row is not the rail's
    // to check.
    expect(
      projectDeckState({
        ...rail,
        activePaneId: "p1",
        bullseyePaneId: "p1",
      }).bullseye,
    ).toBeNull();
  });

  test("bullseye reads off, not on, for a stale id whose pane lost focus", () => {
    // The tell that the fact reads the DERIVED id rather than the raw field:
    // a focus move ends bullseye without clearing anything, and the menu's
    // check mark has to agree with the geometry.
    const state: DeckState = {
      ...deck([card("a"), card("b")], [pane("p1", ["a"]), pane("p2", ["b"])]),
      activePaneId: "p2",
      bullseyePaneId: "p1",
    };
    expect(projectDeckState(state).bullseye).toEqual({ on: false });
  });

  test("sidebars carry the three readings of one card, and its side", () => {
    // Hidden. The side is answered anyway, because `sidebarSide` is total:
    // it is where the card WOULD stand if the row's radios were live.
    expect(projectDeckState(deck([], [])).sidebars["menu-state-rail"]).toEqual({
      showing: false,
      side: "right",
      pinned: true,
      focused: false,
    });

    // Showing without holding the keyboard: the rail's pane is not the
    // focused one, which is the middle rung a plain check could not say.
    const showing: DeckState = {
      ...deck(
        [card("s", { componentId: "menu-state-rail" }), card("a")],
        [pane("p1", ["s"]), pane("p2", ["a"])],
      ),
      activePaneId: "p2",
    };
    expect(projectDeckState(showing).sidebars["menu-state-rail"]).toEqual({
      showing: true,
      side: "right",
      pinned: true,
      focused: false,
    });

    // Showing AND holding it — the same deck with the rail's pane last in
    // z-order, which is the projection's own reading of "focused".
    const focused: DeckState = {
      ...deck(
        [card("a"), card("s", { componentId: "menu-state-rail" })],
        [pane("p2", ["a"]), pane("p1", ["s"])],
      ),
      activePaneId: "p1",
    };
    expect(projectDeckState(focused).sidebars["menu-state-rail"]).toEqual({
      showing: true,
      side: "right",
      pinned: true,
      focused: true,
    });

    // The side is the imposition's, not a constant.
    const left: DeckState = {
      ...focused,
      imposition: { sidebars: { "menu-state-rail": { side: "left" } } },
    };
    expect(projectDeckState(left).sidebars["menu-state-rail"].side).toBe("left");

    // And `pinned` is the imposition's too: a card dragged loose of the edge
    // is on the deck without standing on a rail, which is the difference Hide
    // Sidebars reads — it takes rails away, and a free pane is not one.
    const loose: DeckState = {
      ...focused,
      imposition: {
        sidebars: { "menu-state-rail": { side: "right", pinned: false } },
      },
    };
    expect(projectDeckState(loose).sidebars["menu-state-rail"]).toEqual({
      showing: true,
      side: "right",
      pinned: false,
      focused: true,
    });
  });

  test("a deselected deck holds no sidebar card's keyboard", () => {
    // The one state where the z-frontmost pane and the FIRST RESPONDER part:
    // the array still has a last element, and `activePaneId` is unset, so
    // `getFirstResponderCardId()` — the ladder's own top-rung test — answers
    // null. Read off the z-frontmost instead, the row would draw the mixed
    // mark and say "Hide", over a click that shows and activates.
    const deselected: DeckState = deck(
      [card("s", { componentId: "menu-state-rail" })],
      [pane("p1", ["s"])],
    );
    expect(deselected.activePaneId).toBeUndefined();
    expect(projectDeckState(deselected).sidebars["menu-state-rail"]).toEqual({
      showing: true,
      side: "right",
      pinned: true,
      focused: false,
    });
  });
});

describe("HostMenuStatePublisher", () => {
  /** Drain the microtask queue so a scheduled flush runs. */
  const settle = () => Promise.resolve();

  test("posts the merged payload after a microtask", async () => {
    const posted: MenuStatePayload[] = [];
    const publisher = new HostMenuStatePublisher((p) => posted.push(p));
    publisher.setDeckProjection(
      projectDeckState(deck([card("a")], [pane("p1", ["a"])])),
    );
    expect(posted).toHaveLength(0); // not synchronous
    await settle();
    expect(posted).toHaveLength(1);
    expect(posted[0].panes[0].id).toBe("p1");
    expect(posted[0].session).toBeNull();
  });

  test("coalesces multiple same-tick updates into one post", async () => {
    const posted: MenuStatePayload[] = [];
    const publisher = new HostMenuStatePublisher((p) => posted.push(p));
    publisher.setDeckProjection(projectDeckState(deck([], [])));
    publisher.setDeckProjection(
      projectDeckState(deck([card("a")], [pane("p1", ["a"])])),
    );
    await settle();
    expect(posted).toHaveLength(1);
    expect(posted[0].panes).toHaveLength(1);
  });

  test("a workspace rename re-publishes", async () => {
    const posted: MenuStatePayload[] = [];
    const publisher = new HostMenuStatePublisher((p) => posted.push(p));
    const state = deck([card("a")], [pane("p1", ["a"])]);
    publisher.setDeckProjection(
      projectDeckState(state, spacesOf([{ id: "s1", name: "Main" }], "s1")),
    );
    await settle();
    // Nothing about the deck moved — only the name one level up, which is
    // exactly the change the menu's own subscription exists to carry.
    publisher.setDeckProjection(
      projectDeckState(state, spacesOf([{ id: "s1", name: "Renamed" }], "s1")),
    );
    await settle();
    expect(posted).toHaveLength(2);
    expect(posted[1].spaces).toEqual([
      { id: "s1", name: "Renamed", active: true },
    ]);
  });

  test("suppresses identical consecutive payloads", async () => {
    const posted: MenuStatePayload[] = [];
    const publisher = new HostMenuStatePublisher((p) => posted.push(p));
    const state = deck([card("a")], [pane("p1", ["a"])]);
    publisher.setDeckProjection(projectDeckState(state));
    await settle();
    publisher.setDeckProjection(projectDeckState(state));
    await settle();
    expect(posted).toHaveLength(1);
  });

  const sessionBlock = (
    cardId: string,
    overrides: Partial<MenuStateSessionBlock> = {},
  ): MenuStateSessionBlock => ({
    cardId,
    sessionBound: true,
    canInterrupt: false,
    canChangeSettings: true,
    permissionMode: "default",
    aiSummary: "Opus 5 · High · Default",
    hasAssistantMessage: false,
    hasTurns: false,
    changesVisible: false,
    historyVisible: false,
    folded: false,
    commitReady: false,
    hasCustomName: false,
    ...overrides,
  });

  test("attaches the session block only for the focused pane's active session card", async () => {
    const posted: MenuStatePayload[] = [];
    const publisher = new HostMenuStatePublisher((p) => posted.push(p));
    publisher.setDeckProjection(
      projectDeckState(deck([card("a", { componentId: "session" })], [pane("p1", ["a"])])),
    );
    publisher.setSessionBlock("a", sessionBlock("a"));
    await settle();
    expect(posted).toHaveLength(1);
    expect(posted[0].session).toEqual(sessionBlock("a"));
  });

  test("the Shade-visibility booleans (Spec S04) ride the session block", async () => {
    const posted: MenuStatePayload[] = [];
    const publisher = new HostMenuStatePublisher((p) => posted.push(p));
    publisher.setDeckProjection(
      projectDeckState(deck([card("a", { componentId: "session" })], [pane("p1", ["a"])])),
    );
    publisher.setSessionBlock("a", sessionBlock("a", { changesVisible: true }));
    await settle();
    expect(posted[0].session?.changesVisible).toBe(true);
    expect(posted[0].session?.historyVisible).toBe(false);
  });

  test("non-session active card rides with session: null even when a block exists", async () => {
    const posted: MenuStatePayload[] = [];
    const publisher = new HostMenuStatePublisher((p) => posted.push(p));
    publisher.setSessionBlock("b", sessionBlock("b"));
    publisher.setDeckProjection(
      projectDeckState(
        deck(
          [card("a", { componentId: "git" }), card("b", { componentId: "session" })],
          [pane("p2", ["b"]), pane("p1", ["a"])],
        ),
      ),
    );
    await settle();
    expect(posted).toHaveLength(1);
    expect(posted[0].activeCard?.component).toBe("git");
    expect(posted[0].session).toBeNull();
  });

  test("a session block for a non-active card does not ride the payload", async () => {
    const posted: MenuStatePayload[] = [];
    const publisher = new HostMenuStatePublisher((p) => posted.push(p));
    publisher.setSessionBlock("other", sessionBlock("other"));
    publisher.setDeckProjection(
      projectDeckState(deck([card("a", { componentId: "session" })], [pane("p1", ["a"])])),
    );
    await settle();
    expect(posted[0].session).toBeNull();
  });

  test("clearing the session block reverts the payload to session: null", async () => {
    const posted: MenuStatePayload[] = [];
    const publisher = new HostMenuStatePublisher((p) => posted.push(p));
    publisher.setDeckProjection(
      projectDeckState(deck([card("a", { componentId: "session" })], [pane("p1", ["a"])])),
    );
    publisher.setSessionBlock("a", sessionBlock("a"));
    await settle();
    publisher.clearSessionBlock("a");
    await settle();
    expect(posted).toHaveLength(2);
    expect(posted[1].session).toBeNull();
    // Clearing an unknown card is a no-op (no extra post).
    publisher.clearSessionBlock("a");
    await settle();
    expect(posted).toHaveLength(2);
  });

  const fileBlock = (cardId: string): MenuStateFileBlock => ({
    cardId,
    mode: "manual",
    dirty: true,
    untitled: false,
    readOnly: false,
    hasPath: true,
    conflict: false,
  });

  test("attaches the file block only for the focused pane's active text card", async () => {
    const posted: MenuStatePayload[] = [];
    const publisher = new HostMenuStatePublisher((p) => posted.push(p));
    publisher.setDeckProjection(
      projectDeckState(deck([card("a", { componentId: "text" })], [pane("p1", ["a"])])),
    );
    publisher.setFileBlock("a", fileBlock("a"));
    await settle();
    expect(posted[0].file).toEqual(fileBlock("a"));
  });

  test("non-file active card rides with file: null even when a block exists", async () => {
    const posted: MenuStatePayload[] = [];
    const publisher = new HostMenuStatePublisher((p) => posted.push(p));
    publisher.setFileBlock("b", fileBlock("b"));
    publisher.setDeckProjection(
      projectDeckState(deck([card("a", { componentId: "session" })], [pane("p1", ["a"])])),
    );
    await settle();
    expect(posted[0].file).toBeNull();
  });

  test("clearing the file block reverts the payload to file: null", async () => {
    const posted: MenuStatePayload[] = [];
    const publisher = new HostMenuStatePublisher((p) => posted.push(p));
    publisher.setDeckProjection(
      projectDeckState(deck([card("a", { componentId: "text" })], [pane("p1", ["a"])])),
    );
    publisher.setFileBlock("a", fileBlock("a"));
    await settle();
    publisher.clearFileBlock("a");
    await settle();
    expect(posted[1].file).toBeNull();
  });

  test("posts again when the projection actually changes", async () => {
    const posted: MenuStatePayload[] = [];
    const publisher = new HostMenuStatePublisher((p) => posted.push(p));
    publisher.setDeckProjection(
      projectDeckState(deck([card("a")], [pane("p1", ["a"])])),
    );
    await settle();
    publisher.setDeckProjection(
      projectDeckState(deck([card("a"), card("b")], [pane("p1", ["a", "b"])])),
    );
    await settle();
    expect(posted).toHaveLength(2);
    expect(posted[1].panes[0].cardCount).toBe(2);
  });

  test("the payload carries an all-disabled edit block by default", async () => {
    const posted: MenuStatePayload[] = [];
    const publisher = new HostMenuStatePublisher((p) => posted.push(p));
    publisher.setDeckProjection(projectDeckState(deck([card("a")], [pane("p1", ["a"])])));
    await settle();
    expect(posted[0].edit).toEqual(EMPTY_EDIT_CAPABILITIES);
  });

  test("setEditCapabilities rides the payload and flips on change", async () => {
    const posted: MenuStatePayload[] = [];
    const publisher = new HostMenuStatePublisher((p) => posted.push(p));
    publisher.setDeckProjection(projectDeckState(deck([card("a")], [pane("p1", ["a"])])));
    const caps: MenuStateEditBlock = { ...EMPTY_EDIT_CAPABILITIES, copy: true, selectAll: true };
    publisher.setEditCapabilities(caps);
    await settle();
    expect(posted).toHaveLength(1);
    expect(posted[0].edit).toEqual(caps);

    // Same caps again → suppressed; a changed cap → new post.
    publisher.setEditCapabilities({ ...caps });
    await settle();
    expect(posted).toHaveLength(1);
    publisher.setEditCapabilities({ ...caps, paste: true });
    await settle();
    expect(posted).toHaveLength(2);
    expect(posted[1].edit.paste).toBe(true);
  });
});

describe("computeEditCapabilities", () => {
  /** A chain stub that handles exactly the given actions. */
  function chainHandling(...handled: string[]) {
    const set = new Set<string>(handled);
    return { validateAction: (action: string) => set.has(action) };
  }

  test("maps each edit action to the chain's validateAction", () => {
    const caps = computeEditCapabilities(
      chainHandling(TUG_ACTIONS.COPY, TUG_ACTIONS.SELECT_ALL),
    );
    expect(caps.copy).toBe(true);
    expect(caps.selectAll).toBe(true);
    expect(caps.cut).toBe(false);
    expect(caps.paste).toBe(false);
    expect(caps.undo).toBe(false);
    expect(caps.redo).toBe(false);
    expect(caps.find).toBe(false);
  });

  test("undo/redo follow the focused editor's depth-gated validateAction", () => {
    // An editor that handles UNDO/REDO but whose history holds only an
    // undoable step (depth-gated validator: undo yes, redo no).
    const caps = computeEditCapabilities(
      chainHandling(TUG_ACTIONS.UNDO),
    );
    expect(caps.undo).toBe(true);
    expect(caps.redo).toBe(false);
  });

  test("nothing focused → every capability is false", () => {
    expect(computeEditCapabilities(chainHandling())).toEqual(EMPTY_EDIT_CAPABILITIES);
  });

  test("a find-capable surface enables the find items", () => {
    const caps = computeEditCapabilities(
      chainHandling(TUG_ACTIONS.FIND, TUG_ACTIONS.FIND_NEXT, TUG_ACTIONS.FIND_PREVIOUS),
    );
    expect(caps.find).toBe(true);
    expect(caps.findNext).toBe(true);
    expect(caps.findPrevious).toBe(true);
  });
});

describe("edit-caps refresher registry", () => {
  test("requestMenuStateRefresh invokes the registered refresher; clearing stops it", () => {
    let calls = 0;
    registerMenuCapsRefresher(() => {
      calls += 1;
    });
    requestMenuStateRefresh();
    expect(calls).toBe(1);
    registerMenuCapsRefresher(null);
    requestMenuStateRefresh(); // no registered refresher → no-op
    expect(calls).toBe(1);
  });
});

describe("computeFileMenuGates (Spec S02)", () => {
  const base: MenuStateFileBlock = {
    cardId: "c",
    mode: "manual",
    dirty: false,
    untitled: false,
    readOnly: false,
    hasPath: true,
    conflict: false,
  };

  test("automatic-mode Save stays enabled even when clean (no-beep guard)", () => {
    expect(computeFileMenuGates({ ...base, mode: "automatic" }).save).toBe(true);
  });

  test("a clean titled manual card disables Save", () => {
    expect(computeFileMenuGates(base).save).toBe(false);
  });

  test("a dirty or untitled manual card enables Save", () => {
    expect(computeFileMenuGates({ ...base, dirty: true }).save).toBe(true);
    expect(computeFileMenuGates({ ...base, untitled: true, hasPath: false }).save).toBe(true);
  });

  test("read-only disables Save in either mode", () => {
    expect(computeFileMenuGates({ ...base, mode: "automatic", readOnly: true }).save).toBe(false);
    expect(computeFileMenuGates({ ...base, dirty: true, readOnly: true }).save).toBe(false);
  });

  test("a conflict disables automatic Save but keeps manual Save live", () => {
    // Automatic: flush no-ops on conflict, so an enabled Save would be a
    // live shortcut to a stub. Manual: Save is the re-entry to the conflict
    // sheet after a Cancel — gating it off would strand Save Anyway.
    expect(computeFileMenuGates({ ...base, mode: "automatic", conflict: true }).save).toBe(false);
    expect(computeFileMenuGates({ ...base, dirty: true, conflict: true }).save).toBe(true);
    expect(computeFileMenuGates({ ...base, conflict: true }).save).toBe(true);
    expect(
      computeFileMenuGates({ ...base, conflict: true, readOnly: true }).save,
    ).toBe(false);
  });

  test("Revert needs dirty + a path; Reload needs a path", () => {
    expect(computeFileMenuGates(base).revert).toBe(false);
    expect(computeFileMenuGates({ ...base, dirty: true }).revert).toBe(true);
    expect(computeFileMenuGates({ ...base, dirty: true, hasPath: false }).revert).toBe(false);
    expect(computeFileMenuGates(base).reload).toBe(true);
    expect(computeFileMenuGates({ ...base, hasPath: false }).reload).toBe(false);
  });

  test("Save As… and Save a Copy… are always enabled for a bound card", () => {
    const gates = computeFileMenuGates(base);
    expect(gates.saveAs).toBe(true);
    expect(gates.saveACopy).toBe(true);
  });
});
