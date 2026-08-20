/**
 * The migration's drift guard.
 *
 * Converting the re-dispatch loops in `action-dispatch.ts` into table rows
 * is mechanical but voluminous, and a mis-transcribed `routing` turns a
 * working command into a silent no-op that no type checker catches. The
 * table below records, per command, the mechanism the pre-funnel call site
 * used — read off `action-dispatch.ts` before the loops were deleted — and
 * asserts the entry still routes that way.
 *
 * The second half is the coverage question from the other side: every wire
 * `AppDelegate.swift` can send has to land somewhere. The fixture is the
 * deduplicated `sendControl(` list from the Swift source; each wire is
 * declared a command, a bridge (a wire whose parameter selects a per-value
 * command), or a data frame, and the test holds the registry to it.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  COMMANDS,
  COMMANDS_BY_ID,
  commandWire,
  type CommandRouting,
} from "../command-registry";
import { type Chord } from "../command-registry";
import { formatChord } from "../chord-format";
import { keymapRegistry } from "../keymap-registry";
import { TUG_ACTIONS } from "../action-vocabulary";

/**
 * command id → the mechanism the pre-migration code used.
 *
 * `first-responder` was `sendToFirstResponder` or, for the menu-command
 * adapter group, `sendToFirstResponderForContinuation` with the
 * continuation invoked immediately. `key-card` was `sendToKeyCard`.
 * `registry` means the body lived in `action-dispatch.ts` itself.
 */
const PRE_MIGRATION_MECHANISM: Readonly<Record<string, CommandRouting>> = {
  // The save-verb loop.
  [TUG_ACTIONS.SAVE]: "first-responder",
  [TUG_ACTIONS.SAVE_AS]: "first-responder",
  [TUG_ACTIONS.SAVE_A_COPY]: "first-responder",
  [TUG_ACTIONS.REVERT_TO_SAVED]: "first-responder",
  [TUG_ACTIONS.RELOAD_FROM_DISK]: "first-responder",
  // The zoom loop.
  [TUG_ACTIONS.ZOOM_IN]: "first-responder",
  [TUG_ACTIONS.ZOOM_OUT]: "first-responder",
  [TUG_ACTIONS.ZOOM_ACTUAL]: "first-responder",
  // The menu-command adapter loop (continuation-aware).
  [TUG_ACTIONS.FIND]: "first-responder",
  [TUG_ACTIONS.FIND_NEXT]: "first-responder",
  [TUG_ACTIONS.FIND_PREVIOUS]: "first-responder",
  [TUG_ACTIONS.UNDO]: "first-responder",
  [TUG_ACTIONS.REDO]: "first-responder",
  [TUG_ACTIONS.NEXT_TAB]: "first-responder",
  [TUG_ACTIONS.PREVIOUS_TAB]: "first-responder",
  [TUG_ACTIONS.PASTE_AS_QUOTE]: "first-responder",
  [TUG_ACTIONS.PASTE_AS_PLAIN_TEXT]: "first-responder",
  [TUG_ACTIONS.COPY_AS_PLAIN_TEXT]: "first-responder",
  // The key-card loop.
  [TUG_ACTIONS.FOCUS_PROMPT]: "key-card",
  [TUG_ACTIONS.CYCLE_PERMISSION_MODE]: "key-card",
  [TUG_ACTIONS.INTERRUPT_SESSION]: "key-card",
  [TUG_ACTIONS.TOGGLE_CHANGES_VIEW]: "key-card",
  [TUG_ACTIONS.TOGGLE_HISTORY_VIEW]: "key-card",
  // Standalone first-responder adapters.
  [TUG_ACTIONS.CLAIM_ALL_CHANGES]: "first-responder",
  [TUG_ACTIONS.DISCLAIM_ALL_CHANGES]: "first-responder",
  [TUG_ACTIONS.CLOSE]: "first-responder",
  [TUG_ACTIONS.CLOSE_ALL]: "first-responder",
  [TUG_ACTIONS.ADD_CARD_TO_ACTIVE_PANE]: "first-responder",
  [TUG_ACTIONS.SHOW_COMPONENT_GALLERY]: "first-responder",
  [TUG_ACTIONS.FOCUS_LENS]: "first-responder",
  [TUG_ACTIONS.REVEAL_STACK]: "first-responder",
  // The depth pair replaced Cycle Stack in the Window-menu rework; both are
  // pane-answered like the rest of the stack family.
  [TUG_ACTIONS.PREVIOUS_STACK_CARD]: "first-responder",
  [TUG_ACTIONS.NEXT_STACK_CARD]: "first-responder",
  // Wires with real bodies in action-dispatch.ts.
  "new-text-card": "registry",
  [TUG_ACTIONS.OPEN_FILE]: "registry",
  [TUG_ACTIONS.OPEN_DIFF]: "registry",
  "open-quickly": "registry",
  "clear-recent-documents": "registry",
  "next-theme": "registry",
  "set-theme": "registry",
  "show-card": "registry",
  "focus-pane": "registry",
  "configure-tug": "registry",
  logout: "registry",
  reload: "registry",
  "toggle-lens": "registry",
  // The coverage pass found this one is senderless: the wire has a registry
  // body, but Maker ▸ Source Tree… runs its panel in the host and never
  // sends it, so the entry claims no menu item.
  "source-tree": "registry",
  "set-imposition": "registry",
  // Was `set-imposition-lens` before sidebars became a taxonomy: same command,
  // same routing, a payload that now names which sidebar card it moves.
  "set-sidebar-side": "registry",
  "assign-slot": "registry",
  "focus-session-card": "registry",
};

/**
 * Commands deliberately re-homed after the behavior-neutral migration.
 *
 * Each had its body in `action-dispatch.ts` and so existed nowhere the
 * responder chain could see: not dispatchable in browser dev, not askable
 * for validity, not shadowable. Each acts on the deck, and DeckCanvas is the
 * deck's responder, so the body moved there and the routing moved with it.
 *
 * This is a routing change, which is exactly what the table above exists to
 * catch — so it is declared here rather than by editing the history. The
 * pre-migration column stays honest, and a move nobody declared still fails.
 */
const RE_HOMED_ONTO_THE_CHAIN: ReadonlySet<string> = new Set([
  TUG_ACTIONS.NEW_TEXT_CARD,
  TUG_ACTIONS.OPEN_FILE,
  TUG_ACTIONS.OPEN_QUICKLY,
  TUG_ACTIONS.CLEAR_RECENT_DOCUMENTS,
  TUG_ACTIONS.FOCUS_PANE,
]);

describe("routing matches the pre-migration mechanism", () => {
  for (const [id, mechanism] of Object.entries(PRE_MIGRATION_MECHANISM)) {
    const expected = RE_HOMED_ONTO_THE_CHAIN.has(id) ? "first-responder" : mechanism;
    const why = RE_HOMED_ONTO_THE_CHAIN.has(id)
      ? `routes ${expected}, re-homed from ${mechanism}`
      : `still routes ${mechanism}`;
    test(`${id} ${why}`, () => {
      expect(COMMANDS_BY_ID.get(id)?.routing).toBe(expected);
    });
  }

  test("every re-homed command is one the pre-migration table records", () => {
    // A re-homing declared for a command the drift guard never covered
    // would be a claim about a migration that did not happen to it.
    for (const id of RE_HOMED_ONTO_THE_CHAIN) {
      expect(PRE_MIGRATION_MECHANISM[id], `${id} is in the drift table`).toBe("registry");
    }
  });

  test("the per-value families inherit the mechanism their wire used", () => {
    // The slash bridges were one key-card re-dispatch each before they were
    // rows. The four permission-mode rows were the other such family; they
    // left with the submenu whose checkmarks were their only reason to exist.
    const perValue = COMMANDS.filter((e) => e.id.includes(":"));
    const slash = perValue.filter((e) => commandWire(e) === TUG_ACTIONS.RUN_SLASH_COMMAND);

    expect(slash.length).toBe(19);
    for (const entry of slash) {
      expect(entry.routing).toBe("key-card");
      expect(entry.menuItemId).toBeDefined();
    }
  });

  test("the nine slot commands carry their own digit and dispatch one action", () => {
    const slots = COMMANDS.filter((e) => commandWire(e) === TUG_ACTIONS.MOVE_TO_SLOT);
    expect(slots.length).toBe(9);
    for (const entry of slots) {
      expect(entry.routing).toBe("first-responder");
      expect(entry.action).toBe(TUG_ACTIONS.MOVE_TO_SLOT);
    }
    expect(slots.map((e) => e.payload)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });
});

/**
 * Every `sendControl(` wire in `AppDelegate.swift`, deduplicated.
 *
 * - `command` — the wire is itself a registry id.
 * - `{ bridgeFor }` — the wire's parameter selects a per-value command; the
 *   entries are `<bridgeFor>:<value>`, which for `run-card-command` is a
 *   different name than the wire's own (it bridges to `run-slash-command`).
 * - `data` — a tugcast/host data frame, deliberately outside the table
 *   ([P03]).
 */
type WireKind = "command" | "data" | { readonly bridgeFor: string };

const SWIFT_WIRES: Readonly<Record<string, WireKind>> = {
  "app-lifecycle": "data",
  "voiceover-changed": "data",
  "open-file": "command",
  "show-card": "command",
  "show-settings": "command",
  "show-keyboard-shortcuts": "command",
  "configure-tug": "command",
  logout: "command",
  "set-theme": "command",
  reload: "command",
  "toggle-lens": "command",
  "toggle-jots": "command",
  "toggle-overview": "command",
  "new-jot": "command",
  "focus-lens": "command",
  "zoom-actual": "command",
  "zoom-in": "command",
  "zoom-out": "command",
  "focus-pane": "command",
  "show-component-gallery": "command",
  "open-quickly": "command",
  "clear-recent-documents": "command",
  save: "command",
  "save-as": "command",
  "save-a-copy": "command",
  "revert-to-saved": "command",
  "reload-from-disk": "command",
  "new-text-card": "command",
  "next-theme": "command",
  "add-card-to-active-pane": "command",
  close: "command",
  "close-all": "command",
  "focus-prompt": "command",
  "insert-file": "command",
  "interrupt-session": "command",
  "cycle-permission-mode": "command",
  "toggle-history-view": "command",
  "toggle-changes-view": "command",
  undo: "command",
  redo: "command",
  "copy-as-plain-text": "command",
  "paste-as-quote": "command",
  "paste-as-plain-text": "command",
  "make-uppercase": "command",
  "make-lowercase": "command",
  find: "command",
  "find-next": "command",
  "find-previous": "command",
  "find-selection": "command",
  "previous-tab": "command",
  "next-tab": "command",
  "reveal-stack": "command",
  "previous-stack-card": "command",
  "next-stack-card": "command",
  "previous-turn": "command",
  "next-turn": "command",
  "first-turn": "command",
  "last-turn": "command",
  "open-command-picker": "command",
  "next-keyboard-focus": "command",
  "previous-keyboard-focus": "command",
  "cycle-focus-mode": "command",
  "show-devtools": "command",
  // The parameter picks the command.
  "run-card-command": { bridgeFor: TUG_ACTIONS.RUN_SLASH_COMMAND },
  "set-pane-width": { bridgeFor: TUG_ACTIONS.SET_PANE_WIDTH },
  "toggle-bullseye": "command",
};

describe("SWIFT_WIRES is derived, not remembered", () => {
  // The fixture's completeness claim is checked against the Swift source
  // itself: every `sendControl("…")` literal in AppDelegate.swift must be
  // classified above, so a new wire added in Swift fails here instead of
  // silently under-covering the sweep. (This is the drift that actually
  // happened: the step-16 promotions added seven wires the fixture missed.)
  const swift = readFileSync(
    join(import.meta.dir, "../../../../../tugapp/Sources/AppDelegate.swift"),
    "utf8",
  );

  test("every sendControl literal in AppDelegate.swift is classified", () => {
    // `\s*` because two frames pass the wire on the call's next line; the
    // one non-literal send (a ternary choosing between two wires) is caught
    // by the reverse check below instead.
    const wires = new Set<string>();
    for (const match of swift.matchAll(/sendControl\(\s*"([^"]+)"/g)) {
      wires.add(match[1]);
    }
    expect(wires.size).toBeGreaterThan(40);
    const unclassified = [...wires].filter((wire) => !(wire in SWIFT_WIRES));
    expect(unclassified).toEqual([]);
  });

  test("no fixture wire has vanished from the Swift source", () => {
    // Loose on purpose (any quoted occurrence): a wire may be sent through
    // a ternary rather than a literal call, and the point here is only to
    // keep dead rows from accreting in the fixture.
    const stale = Object.keys(SWIFT_WIRES).filter(
      (wire) => !swift.includes(`"${wire}"`),
    );
    expect(stale).toEqual([]);
  });
});

describe("every Swift wire lands somewhere", () => {
  const wiresWithEntries = new Set(COMMANDS.map(commandWire));

  for (const [wire, kind] of Object.entries(SWIFT_WIRES)) {
    const label = typeof kind === "string" ? kind : `bridge to ${kind.bridgeFor}`;
    test(`${wire} resolves as a ${label}`, () => {
      if (kind === "command") {
        expect(COMMANDS_BY_ID.has(wire)).toBe(true);
      } else if (kind === "data") {
        expect(COMMANDS_BY_ID.has(wire)).toBe(false);
      } else {
        // Not a command itself; its per-value entries carry the family.
        expect(COMMANDS_BY_ID.has(wire)).toBe(false);
        expect(wiresWithEntries.has(kind.bridgeFor)).toBe(true);
      }
    });
  }
});


/**
 * Every chord the deleted static map held, and the command it must reach.
 *
 * The map was the key pipeline's only source of chords; the table is now.
 * That is a migration of forty facts, and a mis-transcribed modifier turns a
 * working chord into one that fires the wrong command — or nothing — with
 * nothing to catch it. So the map's contents are transcribed here as an
 * expectation, read off the file before it was deleted, and resolved through
 * the pipeline's actual entry point rather than by reading the table back.
 */
const SHIPPED_CHORDS: ReadonlyArray<readonly [chord: string, commandId: string]> = [
  ["⌃`", "cycle-card"],
  ["⌘A", TUG_ACTIONS.SELECT_ALL],
  ["⌘X", TUG_ACTIONS.CUT],
  ["⌘C", TUG_ACTIONS.COPY],
  ["⌥⇧⌘C", TUG_ACTIONS.COPY_AS_PLAIN_TEXT],
  ["⌘V", TUG_ACTIONS.PASTE],
  ["⌥⌘V", TUG_ACTIONS.PASTE_AS_QUOTE],
  ["⌥⇧⌘V", TUG_ACTIONS.PASTE_AS_PLAIN_TEXT],
  ["⌘Z", TUG_ACTIONS.UNDO],
  ["⇧⌘Z", TUG_ACTIONS.REDO],
  ["⌘W", TUG_ACTIONS.CLOSE],
  ["⌥⌘W", TUG_ACTIONS.CLOSE_ALL],
  ["⌘T", TUG_ACTIONS.ADD_CARD_TO_ACTIVE_PANE],
  ["⌘K", TUG_ACTIONS.FOCUS_PROMPT],
  ["⌘,", TUG_ACTIONS.SHOW_SETTINGS],
  ["⌘L", TUG_ACTIONS.FOCUS_LENS],
  ["⌥⌘L", TUG_ACTIONS.TOGGLE_LENS],
  ["⌘.", TUG_ACTIONS.CANCEL_DIALOG],
  ["⎋", TUG_ACTIONS.CANCEL_DIALOG],
  ["⌘F", TUG_ACTIONS.FIND],
  ["⌘G", TUG_ACTIONS.FIND_NEXT],
  ["⇧⌘G", TUG_ACTIONS.FIND_PREVIOUS],
  ["⌘S", TUG_ACTIONS.SAVE],
  ["⌘{", TUG_ACTIONS.PREVIOUS_TAB],
  ["⌘}", TUG_ACTIONS.NEXT_TAB],
  ["⌃⌘P", `${TUG_ACTIONS.SELECT_COMPOSER_ROUTE}:prompt`],
  ["⌃⌥⌘P", TUG_ACTIONS.CYCLE_PERMISSION_MODE],
  ["⌘/", TUG_ACTIONS.OPEN_COMMAND_PICKER],
  ["⌥⌘/", TUG_ACTIONS.SHOW_DEVTOOLS],
  ["⌃⌘C", TUG_ACTIONS.TOGGLE_CHANGES_VIEW],
  ["⌃⌘H", TUG_ACTIONS.TOGGLE_HISTORY_VIEW],
  ["⌃⌘T", "next-theme"],
  ["⌃⌘I", TUG_ACTIONS.INSERT_FILE],
  ["⌃⌘K", TUG_ACTIONS.SHOW_KEYBOARD_SHORTCUTS],
  ["⌥⇥", TUG_ACTIONS.CYCLE_FOCUS_MODE],
  ["⌥⌘↑", TUG_ACTIONS.PREVIOUS_TURN],
  ["⌥⌘↓", TUG_ACTIONS.NEXT_TURN],
  ["⌥⇧⌘↑", TUG_ACTIONS.FIRST_TURN],
  ["⌥⇧⌘↓", TUG_ACTIONS.LAST_TURN],
  ...Array.from(
    { length: 9 },
    (_unused, i) => [`⌘${i + 1}`, `${TUG_ACTIONS.MOVE_TO_SLOT}:${i + 1}`] as const,
  ),
];

/**
 * Chords that have moved since the map was transcribed, keyed by command.
 *
 * Declared here rather than edited into `SHIPPED_CHORDS`, for the same reason
 * `RE_HOMED_ONTO_THE_CHAIN` is declared rather than back-written: the
 * historical column is only worth having while it stays historical, and a move
 * nobody declared should still fail.
 *
 * Show Lens moved off ⌥⌘L so the two sidebar toggles could share one grammar —
 * ⌃⌘⟨letter⟩ — which is what makes ⌃⌘L and ⌃⌘J teach each other.
 *
 * Insert File gave the ⌃ seat on I to AI Model and kept the letter, moving to
 * ⇧⌘I. Sharing a letter is deliberate: both are composer gestures reached from
 * the same seat, and neither has a better initial than I.
 */
const MOVED_SINCE_THE_MAP: ReadonlyMap<string, string> = new Map([
  [TUG_ACTIONS.TOGGLE_LENS, "⌃⌘L"],
  [TUG_ACTIONS.INSERT_FILE, "⇧⌘I"],
]);

/**
 * Commands retired since the map — their chords bind nothing today. Cycle
 * Panes (`cycle-card`, ⌃`) fell with the Window-menu rework: the lateral /
 * depth card-navigation quartet supersedes it, and its removal returned the
 * ⌃-backtick grandfathered exception to the closed set.
 */
const RETIRED_SINCE_THE_MAP: ReadonlySet<string> = new Set(["cycle-card"]);

/**
 * Chords added after the map, which by construction it cannot record: their
 * commands did not exist when it was written.
 */
const ADDED_SINCE_THE_MAP: ReadonlyArray<readonly [chord: string, commandId: string]> = [
  ["⌘J", TUG_ACTIONS.NEW_JOT],
  ["⌃⌘J", TUG_ACTIONS.TOGGLE_JOTS],
  ["⌃⌘O", TUG_ACTIONS.TOGGLE_OVERVIEW],
  ["⌥⌘[", TUG_ACTIONS.PREVIOUS_STACK_CARD],
  ["⌥⌘]", TUG_ACTIONS.NEXT_STACK_CARD],
  // The slash bridges that earned a chord. The family is reachable by typing
  // its names, which is why the rest carry none; these two are reached often
  // enough that typing the name is the slow path.
  // ⌃⌘I opened the model picker until the three AI settings became one sheet;
  // the chord kept its letter and moved to the sheet that now owns the model.
  ["⌃⌘I", `${TUG_ACTIONS.RUN_SLASH_COMMAND}:ai`],
  ["⌃⌘U", `${TUG_ACTIONS.RUN_SLASH_COMMAND}:usage`],
  // The card-width row. ⌘ digits are places on the deck, ⌃⌘ digits are
  // sizes for the card — one tier apart, both indexing an ordered set.
  ["⌃⌘1", `${TUG_ACTIONS.SET_PANE_WIDTH}:slim`],
  ["⌃⌘2", `${TUG_ACTIONS.SET_PANE_WIDTH}:comfy`],
  ["⌃⌘3", `${TUG_ACTIONS.SET_PANE_WIDTH}:wide`],
  // Bullseye — a card's POSTURE on the deck, one tier-mate of the width row
  // above: ⌃⌘ carries Tug's layout and card-posture vocabulary generally,
  // of which the sidebar toggles are one family.
  ["⌃⌘B", TUG_ACTIONS.TOGGLE_BULLSEYE],
  // The nudge pair. ⇧⌘[/] moves attention across the cards and ⌥⌘[/] moves it
  // through one slot's stack; ⌥⇧⌘[/] is both twists at once — the same lateral
  // verb with the object altered, so it moves the card itself. It RENDERS as
  // ⌥⌘{ / ⌥⌘} because a shifted-pair key spends its ⇧ on the character, the
  // rule Zoom In (⌘+) and Previous Card (⌘{) already read by.
  //
  // Reaching the web view past the promoted ⌥⌘[/] neighbours is the part worth
  // pinning: AppKit's key-equivalent scan matches modifier masks exactly, so a
  // promoted chord shadows itself and not the chords one modifier away from it.
  ["⌥⌘{", `${TUG_ACTIONS.NUDGE_SLOT}:left`],
  ["⌥⌘}", `${TUG_ACTIONS.NUDGE_SLOT}:right`],
  // The case pair — an anomaly by the algebra (⌥ composes on no base) and
  // recorded as one in chord-tiers.md; a mnemonic pair, U for upper and L
  // for lower.
  ["⌥⌘U", TUG_ACTIONS.MAKE_UPPERCASE],
  ["⌥⌘L", TUG_ACTIONS.MAKE_LOWERCASE],
  // The split family. ⌃⌘ is the layout tier the width row and Bullseye
  // already sit in, and S is unoccupied there. The arrows are R1-exempt, and
  // ⌃⌘ arrows are neither bound in Tug nor on the macOS never-bind list,
  // which reserves plain ⌃-arrows for Spaces rather than the ⌘ composition.
  // ⌃⇧⌘ is the counterpart set of the ⌃⌘ base — top/bottom is the ⇧-extreme
  // of up/down, the same shape ⌥⇧⌘↑/↓ First/Last Turn has one tier over.
  ["⌃⌘S", TUG_ACTIONS.TOGGLE_COLUMN_SPLIT],
  ["⌃⌘↑", `${TUG_ACTIONS.MOVE_IN_COLUMN}:up`],
  ["⌃⌘↓", `${TUG_ACTIONS.MOVE_IN_COLUMN}:down`],
  ["⌃⇧⌘↑", `${TUG_ACTIONS.MOVE_IN_COLUMN}:top`],
  ["⌃⇧⌘↓", `${TUG_ACTIONS.MOVE_IN_COLUMN}:bottom`],
];

/** The map as it reads today: transcription, minus retirements, plus moves and additions. */
const EXPECTED_CHORDS: ReadonlyArray<readonly [chord: string, commandId: string]> = [
  ...SHIPPED_CHORDS.filter(([, commandId]) => !RETIRED_SINCE_THE_MAP.has(commandId)).map(
    ([rendering, commandId]) =>
      [MOVED_SINCE_THE_MAP.get(commandId) ?? rendering, commandId] as const,
  ),
  ...ADDED_SINCE_THE_MAP,
];

describe("every chord the static map held reaches the same command", () => {
  // Keyed by the rendered chord rather than by a modifier record, so the
  // expectation reads the way the keymap pane will show it and a wrong
  // modifier is visible in the row itself.
  const byRendering = new Map<string, { commandId: string; chord: Chord }>();
  for (const entry of COMMANDS) {
    for (const binding of entry.bindings ?? []) {
      if (binding.scope.kind !== "global") continue;
      byRendering.set(formatChord(binding.chord), {
        commandId: entry.id,
        chord: binding.chord,
      });
    }
  }

  for (const [rendering, commandId] of EXPECTED_CHORDS) {
    test(`${rendering} fires ${commandId}`, () => {
      const found = byRendering.get(rendering);
      expect(found, `${rendering} is bound`).toBeDefined();
      expect(found?.commandId).toBe(commandId);
      // …and the pipeline's own lookup agrees, so this is a statement about
      // what the app does rather than about what the table says.
      const chord = found!.chord;
      const event = {
        code: chord.key,
        ctrlKey: chord.ctrl === true,
        metaKey: chord.meta === true,
        shiftKey: chord.shift === true,
        altKey: chord.alt === true,
      } as KeyboardEvent;
      expect(keymapRegistry.matchChord(event)?.commandId).toBe(commandId);
    });
  }

  /**
   * Chords AppKit performs while the table states them, so the sweep can
   * write them onto the item. Most got here by migration — spelled as an
   * `NSMenuItem` key equivalent and nowhere else until the table claimed
   * them — and each gained a JS twin as a consequence, which is the point:
   * one table, both sides. ⌘I was authored this way from the start: the
   * open panel that produces its path is the host's, so the item has to
   * be what the chord reaches.
   */
  const HOST_DERIVED_CHORDS: ReadonlyMap<string, string> = new Map([
    ["⌘I", TUG_ACTIONS.INSERT_FILE],
    // ⌘E arrived after the static map was retired, so it was never in it:
    // Edit ▸ Find ▸ Use Selection for Find spells the key equivalent the way
    // the rest of that submenu does, and the table states the same chord so
    // the keymap pane can show it.
    ["⌘E", TUG_ACTIONS.FIND_SELECTION],
    ["⇧⌘S", TUG_ACTIONS.SAVE_AS],
    ["⌘R", TUG_ACTIONS.REVEAL_STACK],
    ["⌘+", TUG_ACTIONS.ZOOM_IN],
    ["⌘=", TUG_ACTIONS.ZOOM_IN],
    ["⌘-", TUG_ACTIONS.ZOOM_OUT],
    ["⌘0", TUG_ACTIONS.ZOOM_ACTUAL],
  ]);

  test("the global layer holds nothing the map did not, except the host's own", () => {
    // The table also names Quit, Hide, Minimize and Full Screen so the keymap
    // UI can show them. They are `native`: represented, never JS-routed.
    const extra = [...byRendering.entries()].filter(
      ([rendering]) => !EXPECTED_CHORDS.some(([r]) => r === rendering),
    );
    for (const [rendering, { commandId }] of extra) {
      const derived = HOST_DERIVED_CHORDS.get(rendering);
      if (derived !== undefined) {
        expect(commandId, `${rendering} is the host's, swept from the table`).toBe(derived);
        continue;
      }
      expect(COMMANDS_BY_ID.get(commandId)?.routing, `${commandId} is AppKit's`).toBe(
        "native",
      );
    }
  });
});

describe("every registry-routed command has a body to run", () => {
  // `routing: "registry"` means `dispatchCommand` looks the wire up in the
  // action-dispatch registry — a handler declared nowhere else. A command
  // with the routing and no `registerAction` is a chord and a menu item that
  // both warn and do nothing, which is exactly the drift that happened when
  // the Overview toggle shipped with only its chain handler: the deck-canvas
  // actions map serves the responder chain, and registry routing never
  // consults it.
  //
  // Derived from the source rather than a fixture, for the same reason
  // SWIFT_WIRES is: a remembered list is one nobody updates.
  const dispatchSource = readFileSync(
    join(import.meta.dir, "../../../action-dispatch.ts"),
    "utf8",
  );

  const registered = new Set<string>();
  for (const match of dispatchSource.matchAll(
    /registerAction\(\s*(?:"([^"]+)"|TUG_ACTIONS\.([A-Z_]+))/g,
  )) {
    if (match[1] !== undefined) registered.add(match[1]);
    else if (match[2] !== undefined) {
      const wire = (TUG_ACTIONS as Record<string, string>)[match[2]];
      if (wire !== undefined) registered.add(wire);
    }
  }

  test("the scan found the registry it is checking against", () => {
    // A regex that stopped matching would otherwise turn this whole suite
    // green by finding nothing to contradict.
    expect(registered.size).toBeGreaterThan(20);
  });

  for (const entry of COMMANDS.filter((c) => c.routing === "registry")) {
    const wire = commandWire(entry);
    test(`${wire} is registered in action-dispatch`, () => {
      expect(registered.has(wire)).toBe(true);
    });
  }

});

/**
 * The other end of the same wire, and the one that actually bit.
 *
 * `dispatchCommand` looks its id up in `COMMANDS_BY_ID` FIRST and
 * warns-and-returns-false on a miss — so a `registerAction` body with no entry
 * beside it is unreachable through the call every chain handler uses to reach
 * it. The handler exists, a direct `dispatchAction` finds it, and the chord
 * does nothing. `nudge-slot-selection` shipped that way for an afternoon.
 *
 * The check is NOT "every registered wire needs an entry": most of them are
 * host-originated control frames (`app-lifecycle`, `voiceover-changed`, …)
 * that arrive through `dispatchAction`, which resolves the handler map
 * directly and never consults the registry. The invariant is narrower and
 * exact — every id tugdeck hands to `dispatchCommand` as a literal must
 * resolve.
 */
describe("every dispatchCommand literal names a real command", () => {
  const root = join(import.meta.dir, "../../..");
  const ids = new Map<string, string>();
  for (const rel of new Bun.Glob("**/*.{ts,tsx}").scanSync({ cwd: root })) {
    if (rel.includes("__tests__")) continue;
    const text = readFileSync(join(root, rel), "utf8");
    // Both spellings a call site uses: a bare wire string for the internal
    // registry actions, and `TUG_ACTIONS.NAME` for the ones with a vocabulary
    // constant. Template forms (`${TUG_ACTIONS.X}:${runtime}`) resolve to an
    // id nothing static can name and are left to their own tests.
    for (const m of text.matchAll(
      /dispatchCommand\(\s*(?:"([^"]+)"|TUG_ACTIONS\.([A-Z_]+))\s*[,)]/g,
    )) {
      const id =
        m[1] ?? (TUG_ACTIONS as Record<string, string>)[m[2] as string];
      if (id !== undefined) ids.set(id, rel);
    }
  }

  test("the scan found call sites to check", () => {
    // A canary on the regex, not a target: a rewrite that stopped matching
    // would otherwise turn every assertion below into a loop over nothing.
    expect(ids.size).toBeGreaterThan(10);
  });

  for (const [id, rel] of ids) {
    test(`${id} resolves (${rel})`, () => {
      expect(
        COMMANDS.some((c) => c.id === id),
        `dispatchCommand("${id}") in ${rel} has no CommandEntry — it warns and returns false`,
      ).toBe(true);
    });
  }
});
