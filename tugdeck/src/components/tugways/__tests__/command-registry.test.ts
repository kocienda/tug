/**
 * The command table's own invariants.
 *
 * The table is hand-maintained and joined to the native menu by item
 * identifier, so the things that can silently rot are structural: two
 * entries claiming one id, two entries claiming one menu item, an entry
 * with no way to invoke it at all. `lintCommandTable` answers all of them
 * at once; this suite is what makes it a gate rather than a courtesy.
 */

import { describe, expect, test } from "bun:test";

import {
  COMMANDS,
  COMMANDS_BY_ID,
  COMMANDS_BY_MENU_ITEM_ID,
  GLOBAL_SCOPE,
  commandAction,
  isCommandId,
  isCommandLocked,
  lintActionCoverage,
  lintCommandTable,
  lintNativeLocked,
  type CommandEntry,
} from "../command-registry";
import { TUG_ACTIONS } from "../action-vocabulary";

describe("the shipped table", () => {
  test("holds no violations", () => {
    expect(lintCommandTable()).toEqual([]);
  });

  test("indexes every entry by id", () => {
    expect(COMMANDS_BY_ID.size).toBe(COMMANDS.length);
    for (const entry of COMMANDS) {
      expect(COMMANDS_BY_ID.get(entry.id)).toBe(entry);
    }
  });

  test("indexes exactly the entries that drive a menu item", () => {
    const withMenuItem = COMMANDS.filter((e) => e.menuItemId !== undefined);
    expect(COMMANDS_BY_MENU_ITEM_ID.size).toBe(withMenuItem.length);
    for (const entry of withMenuItem) {
      expect(COMMANDS_BY_MENU_ITEM_ID.get(entry.menuItemId as string)).toBe(entry);
    }
  });

  test("every chain-routed entry resolves a chain action", () => {
    for (const entry of COMMANDS) {
      if (entry.routing === "registry" || entry.routing === "native") continue;
      expect(commandAction(entry)).not.toBeNull();
    }
  });

  test("isCommandId separates commands from data-frame wires", () => {
    expect(isCommandId(TUG_ACTIONS.CLOSE)).toBe(true);
    expect(isCommandId("session_updated")).toBe(false);
  });
});

describe("commandAction", () => {
  test("defaults to the id when the id is itself an action", () => {
    expect(commandAction({ id: TUG_ACTIONS.CLOSE, title: "Close", routing: "first-responder" }))
      .toBe(TUG_ACTIONS.CLOSE);
  });

  test("prefers an explicit action, which is what a parameterized id needs", () => {
    expect(
      commandAction({
        id: "move-to-slot:3",
        title: "Slot 3",
        routing: "first-responder",
        action: TUG_ACTIONS.MOVE_TO_SLOT,
        payload: 3,
      }),
    ).toBe(TUG_ACTIONS.MOVE_TO_SLOT);
  });

  test("answers null when the id names no action and none is declared", () => {
    expect(commandAction({ id: "quit-application", title: "Quit", routing: "native" }))
      .toBeNull();
  });
});

describe("lintCommandTable", () => {
  const door: Pick<CommandEntry, "menuItemId"> = { menuItemId: "some.item" };

  test("catches a duplicate id", () => {
    const problems = lintCommandTable([
      { id: "a", title: "A", routing: "registry", ...door },
      { id: "a", title: "A again", routing: "registry", menuItemId: "other.item" },
    ]);
    expect(problems).toEqual(["duplicate command id: a"]);
  });

  test("catches two commands claiming one menu item", () => {
    const problems = lintCommandTable([
      { id: "a", title: "A", routing: "registry", menuItemId: "file.save" },
      { id: "b", title: "B", routing: "registry", menuItemId: "file.save" },
    ]);
    expect(problems).toEqual([
      "menu item file.save is claimed by both a and b",
    ]);
  });

  test("catches a chain-routed entry with no resolvable action", () => {
    const problems = lintCommandTable([
      { id: "not-an-action", title: "Nope", routing: "first-responder", ...door },
    ]);
    expect(problems.length).toBe(1);
    expect(problems[0]).toContain("needs a chain action");
  });

  test("catches a command with no door at all", () => {
    const problems = lintCommandTable([
      { id: TUG_ACTIONS.CLOSE, title: "Close", routing: "first-responder" },
    ]);
    expect(problems).toEqual([
      "close: no menu item and no binding — no way to invoke it",
    ]);
  });

  test("a binding is a door", () => {
    const problems = lintCommandTable([
      {
        id: TUG_ACTIONS.CLOSE,
        title: "Close",
        routing: "first-responder",
        bindings: [
          { chord: { key: "KeyW", meta: true }, scope: GLOBAL_SCOPE, source: "default" },
        ],
      },
    ]);
    expect(problems).toEqual([]);
  });

  test("internal and parameterized entries are exempt from door coverage", () => {
    expect(
      lintCommandTable([
        { id: TUG_ACTIONS.CLOSE_PANE, title: "Close Pane", routing: "target", internal: true },
        { id: TUG_ACTIONS.MOVE_TO_SLOT, title: "Move to Slot", routing: "first-responder", parameterized: true },
      ]),
    ).toEqual([]);
  });
});

describe("the locked policy", () => {
  test("names only real commands", () => {
    expect(lintNativeLocked()).toEqual([]);
  });

  test("covers the macOS conventions a user needs to get out of trouble", () => {
    for (const id of ["quit-application", "hide-application", TUG_ACTIONS.COPY]) {
      expect(isCommandLocked(id)).toBe(true);
    }
  });

  test("leaves everything else the user's to change", () => {
    for (const id of [TUG_ACTIONS.CLOSE, TUG_ACTIONS.FIND, "next-theme"]) {
      expect(isCommandLocked(id)).toBe(false);
    }
  });

  test("catches a lock left pointing at a deleted command", () => {
    expect(lintNativeLocked([])).toContain(
      "NATIVE_LOCKED names quit-application, which is not a command",
    );
  });
});

describe("Settings has one command", () => {
  test("the menu item and the chord are two doors on one entry", () => {
    const settings = COMMANDS_BY_ID.get(TUG_ACTIONS.SHOW_SETTINGS);
    expect(settings?.menuItemId).toBe("app.settings");
    expect(settings?.routing).toBe("first-responder");
    expect(settings?.bindings?.length).toBe(1);
  });

  test("no other command claims the Settings item", () => {
    expect(COMMANDS_BY_MENU_ITEM_ID.get("app.settings")?.id).toBe(
      TUG_ACTIONS.SHOW_SETTINGS,
    );
  });
});

describe("the vocabulary is fully accounted for", () => {
  test("every action name is a command or declared outside the table", () => {
    expect(lintActionCoverage()).toEqual([]);
  });

  test("catches a name that is neither", () => {
    // With no entries at all, every non-excluded action is unaccounted for.
    const problems = lintActionCoverage([]);
    expect(problems).toContain(
      "close is neither a command nor declared outside the table",
    );
    for (const excluded of [TUG_ACTIONS.SET_VALUE, TUG_ACTIONS.MOVE_WORD_FORWARD]) {
      expect(problems.join("\n")).not.toContain(`${excluded} is neither`);
    }
  });

  test("the newly named verbs are in the table", () => {
    for (const id of [
      TUG_ACTIONS.CENTER_PANE,
      TUG_ACTIONS.PIN_SIDEBAR,
      TUG_ACTIONS.SHOW_SIDEBAR_PANE,
      TUG_ACTIONS.HIDE_SIDEBAR_PANE,
      TUG_ACTIONS.MOVE_PANE,
      TUG_ACTIONS.EXIT_COMMIT_MODE,
      TUG_ACTIONS.LAND_COMMIT,
    ]) {
      expect(COMMANDS_BY_ID.has(id)).toBe(true);
    }
  });

  test("the rail verbs are registry-routed and bind no chord", () => {
    // Both are named verbs a menu row and a Lens control dispatch, and neither
    // takes a default binding ([L30]) — the deck's chord budget is not spent on
    // an arrangement the user reaches by pointing at it.
    for (const id of [TUG_ACTIONS.SET_RAIL_MODE, TUG_ACTIONS.EQUALIZE_RAIL]) {
      const entry = COMMANDS_BY_ID.get(id);
      expect(entry?.routing).toBe("registry");
      expect(entry?.bindings ?? []).toEqual([]);
    }
  });

  test("the PDF verbs are one command per value", () => {
    const fits = COMMANDS.filter((e) => e.action === TUG_ACTIONS.ZOOM_TO_FIT);
    const modes = COMMANDS.filter((e) => e.action === TUG_ACTIONS.SET_PAGE_MODE);
    expect(fits.map((e) => e.payload)).toEqual(["width", "page"]);
    expect(modes.map((e) => e.payload)).toEqual(["continuous", "single", "two"]);
  });

  test("every entry with no host door declares which case it is", () => {
    // The lint is only honest if the declaration is a deliberate row rather
    // than a catch-all. Two cases, and they are opposites: `internal` says
    // nothing opens this yet, `paneChrome` says a card's own chrome (a title-bar control, or a composer route segment) does and the
    // lint simply cannot see that door. An entry that said neither would be
    // invocable by nobody with no one having noticed.
    const doorless = COMMANDS.filter(
      (e) =>
        e.menuItemId === undefined &&
        (e.bindings === undefined || e.bindings.length === 0) &&
        !e.parameterized,
    );
    for (const entry of doorless) {
      expect(
        entry.internal === true || entry.paneChrome === true,
        `${entry.id} declares internal or paneChrome`,
      ).toBe(true);
      expect(
        entry.internal === true && entry.paneChrome === true,
        `${entry.id} is not both at once`,
      ).toBe(false);
    }
  });
});

describe("promoted commands", () => {
  /**
   * The commands that traded a chord-only existence for a menu door, and
   * the two decisions each promotion carries: which item it drives, and
   * what happens to its chord while the item validates disabled.
   *
   * A promotion is not free — a menu item's key equivalent is resolved by
   * AppKit before the web view sees a keydown, so the chord leaves the JS
   * funnel and is claimed unconditionally. Both columns are therefore
   * checked-in judgments rather than derivable facts, which is exactly the
   * kind of thing that drifts silently.
   */
  const PROMOTED: ReadonlyArray<[id: string, menuItemId: string, disabled: "keep" | "detach"]> = [
    [TUG_ACTIONS.PREVIOUS_TURN, "session.previousTurn", "detach"],
    [TUG_ACTIONS.NEXT_TURN, "session.nextTurn", "detach"],
    [TUG_ACTIONS.FIRST_TURN, "session.firstTurn", "detach"],
    [TUG_ACTIONS.LAST_TURN, "session.lastTurn", "detach"],
    [TUG_ACTIONS.OPEN_COMMAND_PICKER, "session.commandPicker", "detach"],
    [TUG_ACTIONS.SHOW_DEVTOOLS, "maker.devTools", "keep"],
    [TUG_ACTIONS.TOGGLE_COLUMN_SPLIT, "window.columnSplit", "keep"],
    [`${TUG_ACTIONS.MOVE_IN_COLUMN}:up`, "window.columnMoveUp", "keep"],
    [`${TUG_ACTIONS.MOVE_IN_COLUMN}:down`, "window.columnMoveDown", "keep"],
    [`${TUG_ACTIONS.MOVE_IN_COLUMN}:top`, "window.columnMoveTop", "keep"],
    [`${TUG_ACTIONS.MOVE_IN_COLUMN}:bottom`, "window.columnMoveBottom", "keep"],
  ];

  test("each drives its item and records its disabled-state chord", () => {
    for (const [id, menuItemId, disabled] of PROMOTED) {
      const entry = COMMANDS_BY_ID.get(id);
      expect(entry, `${id} is in the table`).toBeDefined();
      expect(entry?.menuItemId, `${id} drives ${menuItemId}`).toBe(menuItemId);
      expect(entry?.disabledChord, `${id} decided its disabled-state chord`).toBe(disabled);
    }
  });

  test("each publishes a gate, so the item is not left to the default-true tier", () => {
    for (const [id] of PROMOTED) {
      expect(COMMANDS_BY_ID.get(id)?.mirrored, `${id} is mirrored`).toBe(true);
    }
  });

  test("each marks the binding the native menu is to carry", () => {
    for (const [id] of PROMOTED) {
      const bindings = COMMANDS_BY_ID.get(id)?.bindings ?? [];
      expect(bindings.length, `${id} still has its chord`).toBeGreaterThan(0);
      expect(
        bindings.some((b) => b.menuEligible === true),
        `${id} names a menu-eligible binding for the sweep to apply`,
      ).toBe(true);
    }
  });

  test("a detaching command is one that can actually dim", () => {
    // "detach" only means anything on an item that validates disabled
    // sometimes; on an always-enabled item it is a promise nothing tests.
    for (const [id, , disabled] of PROMOTED) {
      if (disabled !== "detach") continue;
      const entry = COMMANDS_BY_ID.get(id);
      const gateable =
        entry?.validate !== undefined ||
        entry?.routing === "key-card" ||
        entry?.routing === "first-responder";
      expect(gateable, `${id} has a gate that can answer false`).toBe(true);
    }
  });

  test("the slot commands stayed chord-only", () => {
    // ⌘1–⌘9 are deliberately unpromoted: nine Window-menu items would take
    // nine digit chords out of the JS funnel at once, above every surface
    // that wants its digits.
    for (let n = 1; n <= 9; n += 1) {
      const entry = COMMANDS_BY_ID.get(`${TUG_ACTIONS.MOVE_TO_SLOT}:${n}`);
      expect(entry?.menuItemId, `slot ${n} has no menu item`).toBeUndefined();
      expect(entry?.bindings?.length, `slot ${n} keeps its chord`).toBe(1);
    }
  });

  test("no menu-eligible binding shares a chord with another command", () => {
    // The seed of the collision lint: a promoted chord that another entry
    // also claims is a chord one of them silently loses.
    const key = (b: { chord: { key: string; ctrl?: boolean; meta?: boolean; shift?: boolean; alt?: boolean } }) =>
      [b.chord.key, b.chord.ctrl, b.chord.meta, b.chord.shift, b.chord.alt].join("|");
    const eligible = new Map<string, string>();
    const collisions: string[] = [];
    for (const entry of COMMANDS) {
      for (const binding of entry.bindings ?? []) {
        if (binding.menuEligible !== true) continue;
        const k = key(binding);
        const owner = eligible.get(k);
        if (owner !== undefined) collisions.push(`${k}: ${owner} and ${entry.id}`);
        eligible.set(k, entry.id);
      }
    }
    expect(collisions).toEqual([]);

    for (const entry of COMMANDS) {
      for (const binding of entry.bindings ?? []) {
        if (binding.menuEligible === true) continue;
        const owner = eligible.get(key(binding));
        if (owner !== undefined && owner !== entry.id) {
          collisions.push(`${entry.id} is shadowed by menu-eligible ${owner}`);
        }
      }
    }
    expect(collisions).toEqual([]);
  });
});
