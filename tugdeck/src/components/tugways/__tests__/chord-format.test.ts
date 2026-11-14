/**
 * chord-format — the two key alphabets, and the one place they meet.
 *
 * The conversion's failure mode is not a crash: it is a chord that renders
 * one way in the menu bar and fires another way, or never. So the round trip
 * is checked against every code the shipped table actually binds, and the
 * shifted-punctuation rule — the one genuine ambiguity — is checked against
 * the byte the shipped Zoom In item carries.
 */

import { describe, expect, test } from "bun:test";

import {
  chordFromEvent,
  chordHasKeyEquivalent,
  chordKey,
  chordMatchesEvent,
  codeToKeyEquivalent,
  effectiveCode,
  eventChordKey,
  formatChord,
} from "../chord-format";
import { COMMANDS, type Chord } from "../command-registry";

function keyEvent(code: string, mods: Partial<Record<"ctrl" | "meta" | "shift" | "alt", boolean>> = {}) {
  return {
    code,
    key: code,
    ctrlKey: mods.ctrl === true,
    metaKey: mods.meta === true,
    shiftKey: mods.shift === true,
    altKey: mods.alt === true,
  } as KeyboardEvent;
}

describe("chord identity", () => {
  test("a chord and an event agree on their key", () => {
    const chord: Chord = { key: "KeyC", meta: true, shift: true, alt: true };
    expect(eventChordKey(keyEvent("KeyC", { meta: true, shift: true, alt: true }))).toBe(
      chordKey(chord),
    );
  });

  test("modifier state is exact, so a superset is a different chord", () => {
    const copy: Chord = { key: "KeyC", meta: true };
    expect(chordMatchesEvent(keyEvent("KeyC", { meta: true }), copy)).toBe(true);
    // ⌥⇧⌘C is Copy as Plain Text, a different command entirely.
    expect(
      chordMatchesEvent(keyEvent("KeyC", { meta: true, shift: true, alt: true }), copy),
    ).toBe(false);
  });

  test("a captured chord records the layout's own character as its label", () => {
    const event = { ...keyEvent("Slash", { meta: true }), key: "/" } as KeyboardEvent;
    expect(chordFromEvent(event)).toEqual({ key: "Slash", meta: true, label: "/" });
  });
});

/**
 * One keydown as a layout delivers it: the position (`code`), the legacy
 * `keyCode` WebKit resolves against the input source, and the character
 * (`key`). Each fixture is what WebKit's `windowsKeyCodeForKeyEvent`,
 * `codeForKeyEvent` and `keyForKeyEvent` say the layout produces; none was
 * recorded from a real keyboard, so these pin the rule and not the layouts.
 */
function layoutEvent(
  code: string,
  keyCode: number,
  key: string,
  mods: Partial<Record<"ctrl" | "meta" | "shift" | "alt", boolean>> = {},
) {
  return { ...keyEvent(code, mods), keyCode, key } as KeyboardEvent;
}

describe("effective code", () => {
  const selectAll: Chord = { key: "KeyA", meta: true };
  const quit: Chord = { key: "KeyQ", meta: true };

  test("AZERTY: a letter chord fires on the key that types the letter", () => {
    // The key at the US Q position types "a", and the one at the US A
    // position types "q".
    const typesA = layoutEvent("KeyQ", 65, "a", { meta: true });
    const typesQ = layoutEvent("KeyA", 81, "q", { meta: true });
    expect(effectiveCode(typesA)).toBe("KeyA");
    expect(chordMatchesEvent(typesA, selectAll)).toBe(true);
    expect(chordMatchesEvent(typesA, quit)).toBe(false);
    expect(chordMatchesEvent(typesQ, quit)).toBe(true);
    expect(chordMatchesEvent(typesQ, selectAll)).toBe(false);
    expect(eventChordKey(typesA)).toBe(chordKey(selectAll));
  });

  test("AZERTY: the rule holds under ⌃, and under ⌥ where key is composed", () => {
    const ctrlA: Chord = { key: "KeyA", ctrl: true };
    const ctrl = layoutEvent("KeyQ", 65, "a", { ctrl: true });
    expect(chordMatchesEvent(ctrl, ctrlA)).toBe(true);
    expect(chordMatchesEvent(ctrl, { key: "KeyQ", ctrl: true })).toBe(false);

    // ⌥ composes the character, so `key` cannot name the letter; `keyCode`
    // comes from the character without modifiers and still does.
    const altA: Chord = { key: "KeyA", alt: true };
    const alt = layoutEvent("KeyQ", 65, "æ", { alt: true });
    expect(chordMatchesEvent(alt, altA)).toBe(true);
    expect(chordMatchesEvent(alt, { key: "KeyQ", alt: true })).toBe(false);
  });

  test("Dvorak – QWERTY ⌘: ⌘ follows QWERTY, every other chord follows Dvorak", () => {
    const copy: Chord = { key: "KeyC", meta: true };
    // With ⌘ held the layout types QWERTY, so the US C position is C.
    expect(chordMatchesEvent(layoutEvent("KeyC", 67, "c", { meta: true }), copy)).toBe(true);
    // Without it the same position types "j", and "c" is at the US I position.
    const ctrlC: Chord = { key: "KeyC", ctrl: true };
    expect(chordMatchesEvent(layoutEvent("KeyI", 67, "c", { ctrl: true }), ctrlC)).toBe(true);
    expect(chordMatchesEvent(layoutEvent("KeyC", 74, "j", { ctrl: true }), ctrlC)).toBe(false);
  });

  test("Russian: with no Roman letter to read, keyCode follows the position", () => {
    const copy: Chord = { key: "KeyC", meta: true };
    const event = layoutEvent("KeyC", 67, "с", { meta: true });
    expect(effectiveCode(event)).toBe("KeyC");
    expect(chordMatchesEvent(event, copy)).toBe(true);
  });

  test("a digit chord stays on the number-row key", () => {
    // AZERTY's number row types "&" unshifted; the chord is still ⌘1.
    const first: Chord = { key: "Digit1", meta: true };
    const event = layoutEvent("Digit1", 49, "&", { meta: true });
    expect(effectiveCode(event)).toBe("Digit1");
    expect(chordMatchesEvent(event, first)).toBe(true);
  });

  test("punctuation stays positional whatever keyCode says", () => {
    const event = layoutEvent("Slash", 191, "/", { meta: true });
    expect(effectiveCode(event)).toBe("Slash");
    expect(chordMatchesEvent(event, { key: "Slash", meta: true })).toBe(true);
  });

  test("an event with no keyCode, or a zero one, matches by its code", () => {
    expect(effectiveCode(keyEvent("KeyQ", { meta: true }))).toBe("KeyQ");
    expect(effectiveCode(layoutEvent("KeyQ", 0, "q", { meta: true }))).toBe("KeyQ");
    expect(chordMatchesEvent(layoutEvent("KeyQ", 0, "q", { meta: true }), quit)).toBe(true);
  });

  test("capture records the effective code, so the chord matches the key pressed", () => {
    const pressed = layoutEvent("KeyQ", 65, "a", { meta: true });
    const recorded = chordFromEvent(pressed);
    expect(recorded).toEqual({ key: "KeyA", meta: true, label: "a" });
    expect(chordMatchesEvent(pressed, recorded)).toBe(true);
    expect(formatChord(recorded)).toBe("⌘A");
  });
});

describe("codeToKeyEquivalent", () => {
  test("a letter is lowercase; AppKit renders shift from the mask", () => {
    expect(codeToKeyEquivalent({ key: "KeyS", meta: true })).toEqual({
      keyEquivalent: "s",
      command: true,
    });
    expect(codeToKeyEquivalent({ key: "KeyG", meta: true, shift: true })).toEqual({
      keyEquivalent: "g",
      command: true,
      shift: true,
    });
  });

  test("shifted punctuation spends the shift on the character, not the mask", () => {
    // The shipped Zoom In item is NSMenuItem(keyEquivalent: "+") with a bare
    // .command mask. A naive "=" plus ⇧⌘ would still match at runtime, but
    // the menu would render ⇧⌘= instead of ⌘+.
    expect(codeToKeyEquivalent({ key: "Equal", meta: true, shift: true })).toEqual({
      keyEquivalent: "+",
      command: true,
    });
    // ⌘= is a second binding on the unshifted code, which is what the
    // shipped hidden alias item models.
    expect(codeToKeyEquivalent({ key: "Equal", meta: true })).toEqual({
      keyEquivalent: "=",
      command: true,
    });
    expect(codeToKeyEquivalent({ key: "Slash", meta: true, shift: true })).toEqual({
      keyEquivalent: "?",
      command: true,
    });
  });

  test("the function keys use AppKit's private-use characters", () => {
    expect(codeToKeyEquivalent({ key: "ArrowUp", meta: true, alt: true })).toEqual({
      keyEquivalent: "\u{F700}",
      command: true,
      option: true,
    });
    expect(codeToKeyEquivalent({ key: "Escape" })).toEqual({ keyEquivalent: "\u{1B}" });
    expect(codeToKeyEquivalent({ key: "Tab", alt: true })).toEqual({
      keyEquivalent: "\t",
      option: true,
    });
    expect(codeToKeyEquivalent({ key: "F5" })?.keyEquivalent).toBe("\u{F708}");
  });

  test("every code the shipped table binds converts", () => {
    // The table is the only list of codes that matter; adding rows for
    // codes nothing binds would test the table against itself.
    const codes = new Set(
      COMMANDS.flatMap((e) => (e.bindings ?? []).map((b) => b.chord.key)),
    );
    expect(codes.size).toBeGreaterThan(10);
    for (const key of codes) {
      expect(codeToKeyEquivalent({ key }), `${key} converts`).not.toBeNull();
    }
  });

  test("an untabled code throws rather than mis-assigning a chord", () => {
    // A binding nothing can render is a mistake to see immediately, not one
    // to discover as a chord that never fires.
    expect(() => codeToKeyEquivalent({ key: "MediaPlayPause" })).toThrow(
      /no key equivalent/,
    );
  });

  test("chordHasKeyEquivalent answers without throwing", () => {
    // The capture surface's probe: a user-pressed code that the menu bar
    // cannot represent is a fact to note, never an exception to hit.
    expect(chordHasKeyEquivalent({ key: "KeyA", meta: true })).toBe(true);
    expect(chordHasKeyEquivalent({ key: "Equal", meta: true, shift: true })).toBe(true);
    expect(chordHasKeyEquivalent({ key: "IntlBackslash", meta: true })).toBe(false);
    expect(chordHasKeyEquivalent({ key: "NumpadAdd", meta: true })).toBe(false);
    expect(chordHasKeyEquivalent({ key: "MediaPlayPause" })).toBe(false);
  });
});

describe("formatChord", () => {
  test("modifiers render in macOS order", () => {
    expect(formatChord({ key: "KeyC", meta: true })).toBe("⌘C");
    expect(formatChord({ key: "KeyC", meta: true, shift: true, alt: true })).toBe("⌥⇧⌘C");
    expect(formatChord({ key: "KeyV", meta: true, shift: true, alt: true })).toBe("⌥⇧⌘V");
    expect(formatChord({ key: "KeyP", ctrl: true, meta: true })).toBe("⌃⌘P");
  });

  test("named keys render as glyphs, not as their code", () => {
    expect(formatChord({ key: "ArrowUp", meta: true, alt: true })).toBe("⌥⌘↑");
    expect(formatChord({ key: "ArrowDown", meta: true, alt: true, shift: true })).toBe(
      "⌥⇧⌘↓",
    );
    expect(formatChord({ key: "Escape" })).toBe("⎋");
    expect(formatChord({ key: "Tab", alt: true })).toBe("⌥⇥");
  });

  test("a shifted character carries its own shift, matching the menu bar", () => {
    expect(formatChord({ key: "Equal", meta: true, shift: true })).toBe("⌘+");
    expect(formatChord({ key: "Equal", meta: true })).toBe("⌘=");
    expect(formatChord({ key: "BracketLeft", meta: true, shift: true })).toBe("⌘{");
  });

  test("every shipped binding renders to something a user could press", () => {
    for (const entry of COMMANDS) {
      for (const binding of entry.bindings ?? []) {
        const rendered = formatChord(binding.chord);
        expect(rendered.length, `${entry.id} renders`).toBeGreaterThan(0);
        expect(rendered, `${entry.id} does not render a raw code`).not.toContain("Key");
        expect(rendered, `${entry.id} does not render a raw code`).not.toContain("Arrow");
      }
    }
  });
});
