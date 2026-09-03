/**
 * `computeCommandCapabilities` — the registry's projection into the host's
 * per-item menu gates.
 *
 * The projection's whole job is to ask each command the question its own
 * routing implies: a first-responder command is validated from the first
 * responder, a key-card command from the key card's content responder, and a
 * command carrying its own predicate is validated by that predicate and
 * nothing else. Getting the walk wrong is invisible in a type checker and
 * shows up as a menu item lit by a responder that will never receive the
 * dispatch.
 *
 * Real `ResponderChainManager`, real registrations; the entries are local so
 * a table edit can't quietly rewrite what these assert.
 */

import { describe, expect, test } from "bun:test";

import { ResponderChainManager } from "../../components/tugways/responder-chain";
import { TUG_ACTIONS } from "../../components/tugways/action-vocabulary";
import type {
  CommandEntry,
  CommandMenuFacts,
  CommandValidationSource,
} from "../../components/tugways/command-registry";
import { COMMANDS, EMPTY_MENU_FACTS } from "../../components/tugways/command-registry";
import { computeCommandCapabilities } from "../host-menu-state";

/**
 * The two halves a predicate reads, joined the way the publisher joins them
 * at flush time: the live chain, and the published menu facts.
 */
function source(
  chain: ResponderChainManager,
  facts: Partial<CommandMenuFacts> = {},
): CommandValidationSource {
  return {
    validateAction: (action) => chain.validateAction(action),
    validateActionInKeyCard: (action) => chain.validateActionInKeyCard(action),
    queryActionState: (action) => chain.queryActionState(action),
    queryActionStateInKeyCard: (action) => chain.queryActionStateInKeyCard(action),
    menu: { ...EMPTY_MENU_FACTS, ...facts },
  };
}

describe("computeCommandCapabilities", () => {
  test("a first-responder entry reflects the chain's validateAction", () => {
    const entries: CommandEntry[] = [
      {
        id: TUG_ACTIONS.SAVE,
        title: "Save",
        routing: "first-responder",
        menuItemId: "file.save",
        mirrored: true,
      },
    ];
    const chain = new ResponderChainManager();
    let canSave = false;
    chain.register({
      id: "editor",
      parentId: null,
      actions: { [TUG_ACTIONS.SAVE]: () => {} },
      validateAction: () => canSave,
    });
    chain.makeFirstResponder("editor");

    expect(computeCommandCapabilities(source(chain), entries)["file.save"].enabled).toBe(false);
    canSave = true;
    expect(computeCommandCapabilities(source(chain), entries)["file.save"].enabled).toBe(true);
  });

  test("an unhandled action leaves its item disabled", () => {
    const entries: CommandEntry[] = [
      {
        id: TUG_ACTIONS.SAVE,
        title: "Save",
        routing: "first-responder",
        menuItemId: "file.save",
        mirrored: true,
      },
    ];
    const chain = new ResponderChainManager();
    chain.register({ id: "canvas", parentId: null, actions: {} });
    chain.makeFirstResponder("canvas");

    expect(computeCommandCapabilities(source(chain), entries)["file.save"].enabled).toBe(false);
  });

  test("a key-card entry asks the key-card walk, not the first responder", () => {
    // The first responder would happily answer yes. A key-card-routed
    // command must not borrow that answer: with no key card there is no
    // content responder to ask, so the item is disabled.
    const entries: CommandEntry[] = [
      {
        id: TUG_ACTIONS.INTERRUPT_SESSION,
        title: "Stop",
        routing: "key-card",
        menuItemId: "session.stop",
        mirrored: true,
      },
    ];
    const chain = new ResponderChainManager();
    chain.register({
      id: "focused",
      parentId: null,
      actions: { [TUG_ACTIONS.INTERRUPT_SESSION]: () => {} },
      validateAction: () => true,
    });
    chain.makeFirstResponder("focused");

    expect(chain.validateAction(TUG_ACTIONS.INTERRUPT_SESSION)).toBe(true);
    expect(computeCommandCapabilities(source(chain), entries)["session.stop"].enabled).toBe(false);
  });

  test("an explicit predicate wins over the chain walk", () => {
    const entries: CommandEntry[] = [
      {
        id: "next-theme",
        title: "Next Theme",
        routing: "registry",
        menuItemId: "view.nextTheme",
        mirrored: true,
        validate: () => false,
      },
    ];
    const chain = new ResponderChainManager();
    expect(computeCommandCapabilities(source(chain), entries)["view.nextTheme"].enabled).toBe(false);
  });

  test("a registry-routed entry with no predicate is enabled", () => {
    // There is no responder to ask and no predicate to consult; an entry
    // that publishes a gate at all has to answer something, and "available"
    // is the answer that matches an unconditional command.
    const entries: CommandEntry[] = [
      {
        id: "open-quickly",
        title: "Open Quickly",
        routing: "registry",
        menuItemId: "file.openQuickly",
        mirrored: true,
      },
    ];
    const chain = new ResponderChainManager();
    expect(computeCommandCapabilities(source(chain), entries)["file.openQuickly"].enabled).toBe(true);
  });

  test("state narrows to a boolean; a value string does not ride the wire", () => {
    const currentWidth = "comfy";
    const entries: CommandEntry[] = [
      {
        id: `${TUG_ACTIONS.SET_PANE_WIDTH}:comfy`,
        title: "Comfy",
        routing: "key-card",
        action: TUG_ACTIONS.SET_PANE_WIDTH,
        payload: "comfy",
        menuItemId: "window.paneWidth.comfy",
        mirrored: true,
        state: () => currentWidth === "comfy",
      },
      {
        id: `${TUG_ACTIONS.SET_PANE_WIDTH}:wide`,
        title: "Wide",
        routing: "key-card",
        action: TUG_ACTIONS.SET_PANE_WIDTH,
        payload: "wide",
        menuItemId: "window.paneWidth.wide",
        mirrored: true,
        // The wider return type the hook keeps for off-menu readers: a
        // value, not a check state. The mirror drops it rather than
        // coercing it into a checkmark.
        state: () => currentWidth,
      },
    ];
    const chain = new ResponderChainManager();
    const gates = computeCommandCapabilities(source(chain), entries);

    expect(gates["window.paneWidth.comfy"].state).toBe(true);
    expect(gates["window.paneWidth.wide"].state).toBeUndefined();
  });

  test("a dynamic title rides the gate, and its absence leaves the item's own", () => {
    const entries: CommandEntry[] = [
      {
        id: TUG_ACTIONS.TOGGLE_CHANGES_VIEW,
        title: "Show Changes",
        routing: "key-card",
        menuItemId: "session.toggleChanges",
        mirrored: true,
        dynamicTitle: () => "Hide Changes",
      },
      {
        id: TUG_ACTIONS.TOGGLE_HISTORY_VIEW,
        title: "Show History",
        routing: "key-card",
        menuItemId: "session.toggleHistory",
        mirrored: true,
      },
    ];
    const chain = new ResponderChainManager();
    const gates = computeCommandCapabilities(source(chain), entries);

    expect(gates["session.toggleChanges"].title).toBe("Hide Changes");
    expect(gates["session.toggleHistory"].title).toBeUndefined();
  });

  test("only mirrored, non-parameterized entries with a menu item are published", () => {
    const entries: CommandEntry[] = [
      // Not mirrored: its enablement still belongs to a hand-rolled tier.
      { id: "a", title: "A", routing: "registry", menuItemId: "menu.a" },
      // Mirrored but parameterized: rebuilt at menu-open time, outside the
      // static mirror by construction.
      {
        id: "set-theme",
        title: "Theme",
        routing: "registry",
        menuItemId: "view.theme",
        parameterized: true,
        mirrored: true,
      },
      // Mirrored with no menu item: nothing to key a gate by.
      { id: "c", title: "C", routing: "registry", mirrored: true, internal: true },
      { id: "d", title: "D", routing: "registry", menuItemId: "menu.d", mirrored: true },
    ];
    const chain = new ResponderChainManager();

    expect(Object.keys(computeCommandCapabilities(source(chain), entries))).toEqual(["menu.d"]);
  });

  test("the shipped table's session gates follow the frontmost card's state", () => {
    const chain = new ResponderChainManager();
    const idle = {
      sessionBound: true,
      canInterrupt: false,
      canChangeSettings: true,
      permissionMode: "plan",
      aiSummary: "Opus 5 · High · Plan",
      hasAssistantMessage: false,
      hasTurns: false,
      changesVisible: false,
      historyVisible: false,
      commitReady: false,
      hasCustomName: false,
    };

    // No session card frontmost: the whole Session surface is dark.
    const none = computeCommandCapabilities(source(chain));
    expect(none["session.stop"].enabled).toBe(false);
    expect(none["session.focusPrompt"].enabled).toBe(false);
    expect(none["session.rewind"].enabled).toBe(false);

    // A bound, idle session: the composer and the AI item are live, Stop is
    // not (nothing to interrupt), and Rewind has nowhere to go.
    const bound = computeCommandCapabilities(
      source(chain, { sessionCardFrontmost: true, session: idle }),
    );
    expect(bound["session.focusPrompt"].enabled).toBe(true);
    expect(bound["session.stop"].enabled).toBe(false);
    expect(bound["session.rewind"].enabled).toBe(false);
    expect(bound["session.ai"].enabled).toBe(true);
    // The menu item is a state display, not just a door: the gate carries the
    // same summary the chip shows.
    expect(bound["session.ai"].title).toBe("AI: Opus 5 · High · Plan…");

    // Mid-turn: Stop lights, and the AI item goes dark so a settings change
    // cannot race the running turn — the honest gate, where the AI Model… item
    // it replaces stayed enabled and bounced after the fact.
    const running = computeCommandCapabilities(
      source(chain, {
        sessionCardFrontmost: true,
        session: { ...idle, canInterrupt: true, canChangeSettings: false, hasTurns: true },
      }),
    );
    expect(running["session.stop"].enabled).toBe(true);
    expect(running["session.ai"].enabled).toBe(false);
    expect(running["session.rewind"].enabled).toBe(true);

    // With no summary published yet, the gate carries NO title, so the Swift
    // item's static "AI…" stands rather than being overwritten with a stub.
    const unpublished = computeCommandCapabilities(
      source(chain, {
        sessionCardFrontmost: true,
        session: { ...idle, aiSummary: "" },
      }),
    );
    expect(unpublished["session.ai"].title).toBeUndefined();
  });

  test("the Show/Hide verbs follow the Shade's live visibility", () => {
    const chain = new ResponderChainManager();
    const session = {
      sessionBound: true,
      canInterrupt: false,
      canChangeSettings: true,
      permissionMode: "default",
      aiSummary: "Opus 5 · High · Default",
      hasAssistantMessage: false,
      hasTurns: false,
      changesVisible: false,
      historyVisible: true,
      commitReady: false,
      hasCustomName: false,
    };
    const gates = computeCommandCapabilities(
      source(chain, { sessionCardFrontmost: true, session }),
    );

    expect(gates["session.toggleChanges"].title).toBe("Show Session Changes");
    expect(gates["session.toggleHistory"].title).toBe("Hide Commit History");
  });

  test("Unname is enabled only when there is a name to clear", () => {
    // A menu item that does nothing is its own small lie, so the gate is the
    // fact rather than the surface's presence.
    const chain = new ResponderChainManager();
    const session = {
      sessionBound: true,
      canInterrupt: false,
      canChangeSettings: true,
      permissionMode: "default",
      aiSummary: "Opus 5 · High · Default",
      hasAssistantMessage: false,
      hasTurns: false,
      changesVisible: false,
      historyVisible: false,
      commitReady: false,
      hasCustomName: false,
    };

    const unnamed = computeCommandCapabilities(
      source(chain, { sessionCardFrontmost: true, session }),
    );
    expect(unnamed["session.unname"].enabled).toBe(false);

    const named = computeCommandCapabilities(
      source(chain, {
        sessionCardFrontmost: true,
        session: { ...session, hasCustomName: true },
      }),
    );
    expect(named["session.unname"].enabled).toBe(true);

    // No session card frontmost at all: nothing to unname.
    const dark = computeCommandCapabilities(
      source(chain, { sessionCardFrontmost: false, session: null }),
    );
    expect(dark["session.unname"].enabled).toBe(false);
  });

  test("the deck gates follow pane shape, including the deselected-deck hatch", () => {
    const chain = new ResponderChainManager();

    // One pane, one card, selected: nowhere to navigate, nothing to close all
    // of, and no stack to rotate.
    const single = computeCommandCapabilities(
      source(chain, {
        paneCount: 1,
        focusedPaneCardCount: 1,
        visibleCardCount: 1,
        focusedPaneActiveCardClosable: true,
        selectionActive: true,
        stackDepth: 1,
      }),
    );
    expect(single["file.closeCard"].enabled).toBe(true);
    expect(single["file.closeAllCardTabs"].enabled).toBe(false);
    expect(single["window.nextCard"].enabled).toBe(false);
    expect(single["window.nextCardInStack"].enabled).toBe(false);
    expect(single["window.revealStack"].enabled).toBe(false);

    // Same deck, deselected by a canvas click: navigation stays live so the
    // user can re-enter a card without the mouse.
    const deselected = computeCommandCapabilities(
      source(chain, {
        paneCount: 1,
        focusedPaneCardCount: 0,
        visibleCardCount: 1,
        selectionActive: false,
        stackDepth: 0,
      }),
    );
    expect(deselected["window.nextCard"].enabled).toBe(true);
    // The stack items take no such hatch: they act on a specific pane's
    // stack, and there is no such pane.
    expect(deselected["window.nextCardInStack"].enabled).toBe(false);
    expect(deselected["window.previousCardInStack"].enabled).toBe(false);
    expect(deselected["window.revealStack"].enabled).toBe(false);
  });

  test("the card-width radio checks the stamped preset, and none at a dragged width", () => {
    const chain = new ResponderChainManager();

    // A rail, or nothing selected: no pane has a preset to set.
    const unsettable = computeCommandCapabilities(source(chain, { cardWidth: null }));
    expect(unsettable["window.cardWidth.slim"].enabled).toBe(false);
    expect(unsettable["window.cardWidth.comfy"].enabled).toBe(false);
    expect(unsettable["window.cardWidth.wide"].enabled).toBe(false);

    const comfy = computeCommandCapabilities(
      source(chain, { cardWidth: { preset: "comfy" } }),
    );
    expect(comfy["window.cardWidth.slim"].enabled).toBe(true);
    expect(comfy["window.cardWidth.slim"].state).toBe(false);
    expect(comfy["window.cardWidth.comfy"].state).toBe(true);
    expect(comfy["window.cardWidth.wide"].state).toBe(false);

    // Dragged to a width of its own: still settable, but no row claims the
    // check — the settled control shows what the geometry holds.
    const custom = computeCommandCapabilities(
      source(chain, { cardWidth: { preset: null } }),
    );
    expect(custom["window.cardWidth.comfy"].enabled).toBe(true);
    expect(custom["window.cardWidth.slim"].state).toBe(false);
    expect(custom["window.cardWidth.comfy"].state).toBe(false);
    expect(custom["window.cardWidth.wide"].state).toBe(false);
  });

  test("a sidebar row's mark is the toggle's three-rung ladder, read back", () => {
    const chain = new ResponderChainManager();
    const jots = (facts: Parameters<typeof source>[1]) =>
      computeCommandCapabilities(source(chain, facts));

    // Hidden: the empty mark, the row still live (it has a card to show),
    // and the side pair dark, because there is nothing standing to move.
    const hidden = jots({
      sidebars: { jots: { showing: false, side: "right", focused: false } },
    });
    expect(hidden["window.sidebar.jots.show"].enabled).toBe(true);
    expect(hidden["window.sidebar.jots.show"].state).toBe(false);
    expect(hidden["window.sidebar.jots.show"].title).toBe("Show Jots");
    expect(hidden["window.sidebar.jots.left"].enabled).toBe(false);
    expect(hidden["window.sidebar.jots.right"].enabled).toBe(false);

    // Showing without the keyboard: the plain check, and the next click
    // brings the keyboard rather than taking the card away.
    const showing = jots({
      sidebars: { jots: { showing: true, side: "right", focused: false } },
    });
    expect(showing["window.sidebar.jots.show"].state).toBe(true);
    expect(showing["window.sidebar.jots.show"].title).toBe("Activate Jots");
    expect(showing["window.sidebar.jots.left"].enabled).toBe(true);
    expect(showing["window.sidebar.jots.left"].state).toBe(false);
    expect(showing["window.sidebar.jots.right"].state).toBe(true);

    // Showing and holding it: the mixed mark — the reading a two-state check
    // could not tell from the one above, and the rung where a click hides.
    const focused = jots({
      sidebars: { jots: { showing: true, side: "left", focused: true } },
    });
    expect(focused["window.sidebar.jots.show"].state).toBe("mixed");
    expect(focused["window.sidebar.jots.show"].title).toBe("Hide Jots");
    expect(focused["window.sidebar.jots.left"].state).toBe(true);
    expect(focused["window.sidebar.jots.right"].state).toBe(false);

    // A fact that names no sidebar card at all reads as hidden rather than
    // throwing, so a row is never left with no answer.
    const unknown = computeCommandCapabilities(source(chain));
    expect(unknown["window.sidebar.overview.show"].state).toBe(false);
    expect(unknown["window.sidebar.overview.left"].enabled).toBe(false);
  });

  test("the Go to Slot row lights for the arrangement, not for the selection", () => {
    const chain = new ResponderChainManager();

    // Under fit — and on a deck with no imposition at all — nothing travels:
    // every anchor is inside the band already, so the whole row is dark.
    const still = computeCommandCapabilities(
      source(chain, { reachableSlots: 0 }),
    );
    for (let n = 1; n <= 6; n += 1) {
      expect(still[`window.goToSlot.${n}`].enabled).toBe(false);
    }

    // A three-up flow deck lights exactly its own three. Slot 4 is not a place
    // this arrangement has, and a row for a place that does not exist would be
    // a row that lies.
    const threeUp = computeCommandCapabilities(
      source(chain, { reachableSlots: 3 }),
    );
    expect(threeUp["window.goToSlot.1"].enabled).toBe(true);
    expect(threeUp["window.goToSlot.3"].enabled).toBe(true);
    expect(threeUp["window.goToSlot.4"].enabled).toBe(false);
    expect(threeUp["window.goToSlot.6"].enabled).toBe(false);

    // And it takes NONE of the selection gates the rest of the Window menu
    // takes: centering moves the band, so a deselected deck can still be sent
    // to slot 3. This is the assertion that would catch someone "fixing" the
    // row by pairing it with `cardWidth`.
    const deselected = computeCommandCapabilities(
      source(chain, { reachableSlots: 3, selectionActive: false, cardWidth: null }),
    );
    expect(deselected["window.goToSlot.3"].enabled).toBe(true);
  });

  test("the save family follows the frontmost Text card's gates", () => {
    const chain = new ResponderChainManager();

    const noCard = computeCommandCapabilities(source(chain));
    expect(noCard["file.save"].enabled).toBe(false);
    expect(noCard["file.saveAs"].enabled).toBe(false);
    expect(noCard["file.revertToSaved"].enabled).toBe(false);

    const dirty = computeCommandCapabilities(
      source(chain, {
        fileGates: { save: true, saveAs: true, saveACopy: true, revert: true, reload: true },
      }),
    );
    expect(dirty["file.save"].enabled).toBe(true);
    expect(dirty["file.revertToSaved"].enabled).toBe(true);
  });

  describe("the chord half", () => {
    const gated: CommandEntry = {
      id: TUG_ACTIONS.NEXT_TURN,
      title: "Next Turn",
      routing: "first-responder",
      menuItemId: "session.nextTurn",
      mirrored: true,
      validate: (chain) => chain.menu.session?.hasTurns ?? false,
      disabledChord: "detach",
    };
    const kept: CommandEntry = { ...gated, disabledChord: "keep" };
    const spec = { keyEquivalent: "\u{F701}", command: true, option: true };
    const chords = { "session.nextTurn": spec };

    test("an item the keymap has not claimed keeps the host's literal", () => {
      const gates = computeCommandCapabilities(
        source(new ResponderChainManager()),
        [gated],
        {},
      );
      // Absent, not null: null would clear a key equivalent the host chose.
      expect("chord" in gates["session.nextTurn"]).toBe(false);
    });

    test("a claimed item carries the chord while its command is applicable", () => {
      const facts = {
        sessionCardFrontmost: true,
        session: {
          sessionBound: true,
          canInterrupt: false,
          canChangeSettings: true,
          permissionMode: "default",
          aiSummary: "Opus 5 · High · Default",
          hasAssistantMessage: true,
          hasTurns: true,
          changesVisible: false,
          historyVisible: false,
          commitReady: false,
          hasCustomName: false,
        },
      };
      const gates = computeCommandCapabilities(
        source(new ResponderChainManager(), facts),
        [gated],
        chords,
      );
      expect(gates["session.nextTurn"].chord).toEqual(spec);
    });

    test("a detaching command releases the chord when it dims", () => {
      // A chord on a dimmed item is eaten at the menu bar with a beep, so
      // detaching is the difference between "inapplicable here" and "dead".
      const gates = computeCommandCapabilities(
        source(new ResponderChainManager()),
        [gated],
        chords,
      );
      expect(gates["session.nextTurn"].enabled).toBe(false);
      expect(gates["session.nextTurn"].chord).toBeNull();
    });

    test("a keeping command holds the chord even when it dims", () => {
      const gates = computeCommandCapabilities(
        source(new ResponderChainManager()),
        [kept],
        chords,
      );
      expect(gates["session.nextTurn"].enabled).toBe(false);
      expect(gates["session.nextTurn"].chord).toEqual(spec);
    });

    test("chordActive releases the chord without dimming the item", () => {
      // Save As… is the shipped case: enabled and chordless are not the same
      // state, so the question the chord asks is its own.
      const entry: CommandEntry = {
        id: TUG_ACTIONS.SAVE_AS,
        title: "Save As…",
        routing: "first-responder",
        menuItemId: "file.saveAs",
        mirrored: true,
        validate: () => true,
        chordActive: (chain) => chain.menu.fileGates !== null,
      };
      const saveAsChord = { keyEquivalent: "s", command: true, shift: true };
      const gates = computeCommandCapabilities(
        source(new ResponderChainManager()),
        [entry],
        { "file.saveAs": saveAsChord },
      );
      expect(gates["file.saveAs"].enabled).toBe(true);
      expect(gates["file.saveAs"].chord).toBeNull();
    });
  });

  test("the shipped table publishes a gate for every item it has moved", () => {
    // Every mirrored entry in the real table must be keyed and answerable —
    // a mirrored entry that produced no gate would leave its item on a tier
    // that the same change deleted.
    const chain = new ResponderChainManager();
    const gates = computeCommandCapabilities(source(chain));
    const mirrored = COMMANDS.filter(
      (entry) =>
        entry.mirrored === true &&
        entry.menuItemId !== undefined &&
        entry.parameterized !== true,
    );

    for (const entry of mirrored) {
      expect(gates[entry.menuItemId as string], `${entry.id} publishes a gate`).toBeDefined();
      expect(gates[entry.menuItemId as string].enabled, `${entry.id} answers`).toBeBoolean();
    }

    // The rest of the block is chord-only: entries whose key equivalent the
    // keymap states while their enablement stays the host's. Each must say
    // nothing about enablement, or it would light an item its own tier gates.
    const chordOnly = Object.entries(gates).filter(
      ([id]) => !mirrored.some((entry) => entry.menuItemId === id),
    );
    for (const [id, gate] of chordOnly) {
      expect(gate.enabled, `${id} carries a chord and no verdict`).toBeUndefined();
      expect("chord" in gate, `${id} carries a chord`).toBe(true);
    }
  });
});
