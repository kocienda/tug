/**
 * text-editing-keybindings — the gap-fill bindings are letter mnemonics, so
 * they follow the user's layout by the same rule every chord does.
 *
 * The AZERTY cases are keydowns recorded from that layout in a lab guest
 * (`fixtures/keyboard-layouts.json`).
 */

import { describe, expect, test } from "bun:test";

import { TUG_ACTIONS } from "../action-vocabulary";
import { matchEditingKeybinding } from "../text-editing-keybindings";
import { recordedKeydown } from "./fixtures/keyboard-layouts";

function keyEvent(
  code: string,
  keyCode: number,
  mods: Partial<Record<"ctrl" | "meta" | "shift" | "alt", boolean>> = {},
) {
  return {
    code,
    keyCode,
    key: code,
    ctrlKey: mods.ctrl === true,
    metaKey: mods.meta === true,
    shiftKey: mods.shift === true,
    altKey: mods.alt === true,
  } as KeyboardEvent;
}

describe("matchEditingKeybinding", () => {
  test("a US event matches each default binding", () => {
    expect(matchEditingKeybinding(keyEvent("KeyU", 85, { ctrl: true }))?.action).toBe(
      TUG_ACTIONS.DELETE_TO_LINE_START,
    );
    expect(matchEditingKeybinding(keyEvent("KeyW", 87, { ctrl: true }))?.action).toBe(
      TUG_ACTIONS.DELETE_WORD_BACKWARD,
    );
    expect(matchEditingKeybinding(keyEvent("KeyF", 70, { alt: true }))?.action).toBe(
      TUG_ACTIONS.MOVE_WORD_FORWARD,
    );
    expect(matchEditingKeybinding(keyEvent("KeyB", 66, { alt: true }))?.action).toBe(
      TUG_ACTIONS.MOVE_WORD_BACKWARD,
    );
  });

  test("an event with no keyCode still matches by its code", () => {
    expect(matchEditingKeybinding(keyEvent("KeyW", 0, { ctrl: true }))?.action).toBe(
      TUG_ACTIONS.DELETE_WORD_BACKWARD,
    );
  });

  test("AZERTY: ⌃W is the key that types W, not the key at the US W position", () => {
    // AZERTY types "w" at the US Z position and "z" at the US W position.
    expect(recordedKeydown("French", "KeyZ", ["ctrl"]).key).toBe("w");
    expect(matchEditingKeybinding(recordedKeydown("French", "KeyZ", ["ctrl"]))?.action).toBe(
      TUG_ACTIONS.DELETE_WORD_BACKWARD,
    );
    expect(matchEditingKeybinding(recordedKeydown("French", "KeyW", ["ctrl"]))).toBeNull();
  });

  test("AZERTY: ⌃U is the key that types U", () => {
    // U sits at the same position on both layouts.
    expect(matchEditingKeybinding(recordedKeydown("French", "KeyU", ["ctrl"]))?.action).toBe(
      TUG_ACTIONS.DELETE_TO_LINE_START,
    );
    // The key that types A is at the US Q position; ⌃A is not a gap binding.
    expect(matchEditingKeybinding(recordedKeydown("French", "KeyQ", ["ctrl"]))).toBeNull();
  });

  test("modifiers stay exact, and shift extends only where the binding says so", () => {
    expect(matchEditingKeybinding(keyEvent("KeyW", 87, { ctrl: true, alt: true }))).toBeNull();
    expect(matchEditingKeybinding(keyEvent("KeyW", 87, { ctrl: true, shift: true }))).toBeNull();
    expect(
      matchEditingKeybinding(keyEvent("KeyF", 70, { alt: true, shift: true }))?.action,
    ).toBe(TUG_ACTIONS.MOVE_WORD_FORWARD);
  });
});
