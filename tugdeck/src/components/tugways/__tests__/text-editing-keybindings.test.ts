/**
 * text-editing-keybindings — the gap-fill bindings are letter mnemonics, so
 * they follow the user's layout by the same rule every chord does.
 *
 * The AZERTY fixtures are what WebKit's source says that layout delivers
 * (`code` for the position, `keyCode` for the letter typed); none was
 * recorded from a real keyboard.
 */

import { describe, expect, test } from "bun:test";

import { TUG_ACTIONS } from "../action-vocabulary";
import { matchEditingKeybinding } from "../text-editing-keybindings";

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
    expect(matchEditingKeybinding(keyEvent("KeyZ", 87, { ctrl: true }))?.action).toBe(
      TUG_ACTIONS.DELETE_WORD_BACKWARD,
    );
    expect(matchEditingKeybinding(keyEvent("KeyW", 90, { ctrl: true }))).toBeNull();
  });

  test("AZERTY: ⌃U is the key that types U", () => {
    // U sits at the same position on both layouts.
    expect(matchEditingKeybinding(keyEvent("KeyU", 85, { ctrl: true }))?.action).toBe(
      TUG_ACTIONS.DELETE_TO_LINE_START,
    );
    // The key that types A is at the US Q position; ⌃A is not a gap binding.
    expect(matchEditingKeybinding(keyEvent("KeyQ", 65, { ctrl: true }))).toBeNull();
  });

  test("modifiers stay exact, and shift extends only where the binding says so", () => {
    expect(matchEditingKeybinding(keyEvent("KeyW", 87, { ctrl: true, alt: true }))).toBeNull();
    expect(matchEditingKeybinding(keyEvent("KeyW", 87, { ctrl: true, shift: true }))).toBeNull();
    expect(
      matchEditingKeybinding(keyEvent("KeyF", 70, { alt: true, shift: true }))?.action,
    ).toBe(TUG_ACTIONS.MOVE_WORD_FORWARD);
  });
});
