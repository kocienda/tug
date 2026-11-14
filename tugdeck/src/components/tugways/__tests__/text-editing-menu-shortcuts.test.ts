/**
 * The text-editing context menu's shortcut hints must name the chords that
 * actually fire the commands.
 *
 * Two of them didn't. Copy as Plain Text advertised ⇧⌘C and Paste as Plain
 * Text advertised ⇧⌘V, both dropping the Option that the real chords carry —
 * as both the Swift Edit menu's modifier masks and the command registry have
 * always said. "…as Plain Text" is the ⌥⇧⌘ composed set, never the bare ⇧⌘
 * counterpart (tuglaws/chord-tiers.md).
 *
 * The hints are no longer authored: each row reads the command's live
 * binding, so the two cannot be two spellings of one fact any more. The
 * expectation table below stays because deriving the *wrong* binding is
 * still possible — it pins which chords those seven commands hold — and the
 * derivation test beside it pins that the menu is reading them rather than
 * carrying a copy.
 */

import { describe, expect, test } from "bun:test";

import { buildTextEditingMenuItems } from "../text-editing-menu";
import { keymapRegistry } from "../keymap-registry";
import { formatChord } from "../chord-format";
import { TUG_ACTIONS } from "../action-vocabulary";
import type { TugAction } from "../action-vocabulary";

/** action → the hint the menu renders. */
const EXPECTED_SHORTCUTS: ReadonlyArray<readonly [TugAction, string]> = [
  [TUG_ACTIONS.CUT, "⌘X"],
  [TUG_ACTIONS.COPY, "⌘C"],
  [TUG_ACTIONS.COPY_ALTERNATE, "⌥⇧⌘C"],
  [TUG_ACTIONS.PASTE, "⌘V"],
  [TUG_ACTIONS.PASTE_AS_QUOTE, "⌥⌘V"],
  [TUG_ACTIONS.PASTE_AS_PLAIN_TEXT, "⌥⇧⌘V"],
  [TUG_ACTIONS.SELECT_ALL, "⌘A"],
];

describe("text-editing menu shortcut hints", () => {
  const entries = buildTextEditingMenuItems({ hasSelection: true });

  test("every hint matches its expectation", () => {
    for (const [action, want] of EXPECTED_SHORTCUTS) {
      const entry = entries.find((e) => "action" in e && e.action === action);
      expect(entry, `${action} is in the menu`).toBeDefined();
      expect(
        (entry as { shortcut?: string }).shortcut,
        `${action} shortcut hint`,
      ).toBe(want);
    }
  });

  test("every hint agrees with the binding that actually fires the command", () => {
    // The point of the repair: the hint and the binding are two spellings of
    // one fact, and they disagreed. Compare them through the one renderer,
    // so the comparison itself cannot be a third spelling.
    for (const [action, want] of EXPECTED_SHORTCUTS) {
      const [binding] = keymapRegistry.bindingsFor(action);
      expect(binding, `${action} has a binding`).toBeDefined();
      expect(formatChord(binding.binding.chord), `${action} hint vs binding`).toBe(want);
    }
  });

  test("a rebind moves the hint with it", () => {
    // The structural claim: the menu reads the binding rather than holding a
    // copy of it. An authored string would sail through this unchanged,
    // which is exactly the regression it exists to make impossible.
    const original = keymapRegistry.bindingsOf(TUG_ACTIONS.SELECT_ALL);
    try {
      keymapRegistry.setBindings(TUG_ACTIONS.SELECT_ALL, [
        {
          chord: { key: "KeyE", meta: true, ctrl: true, label: "e" },
          scope: { kind: "global" },
          source: "user",
        },
      ]);
      const rebound = buildTextEditingMenuItems({ hasSelection: true }).find(
        (e) => "action" in e && e.action === TUG_ACTIONS.SELECT_ALL,
      ) as { shortcut?: string };
      expect(rebound.shortcut).toBe("⌃⌘E");
    } finally {
      keymapRegistry.setBindings(TUG_ACTIONS.SELECT_ALL, original.slice());
    }
  });

  test("Copy as Plain Text keeps its Option — the hint is never the bare ⇧⌘C", () => {
    const entry = entries.find(
      (e) => "action" in e && e.action === TUG_ACTIONS.COPY_ALTERNATE,
    ) as { shortcut?: string };
    expect(entry.shortcut).not.toBe("⇧⌘C");
  });
});
