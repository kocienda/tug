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
import { recordedKeydown, recordedMenuTries } from "./fixtures/keyboard-layouts";

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
 * A keydown no keyboard sends: `keyCode` set by hand, for the synthesized
 * events the rule must still match by position.
 */
function syntheticEvent(
  code: string,
  keyCode: number,
  key: string,
  mods: Partial<Record<"ctrl" | "meta" | "shift" | "alt", boolean>> = {},
) {
  return { ...keyEvent(code, mods), keyCode, key } as KeyboardEvent;
}

/**
 * The layout cases read real keydowns: `fixtures/keyboard-layouts.json` was
 * recorded in a lab guest with each layout selected, and the menu tries in it
 * say which item AppKit's localized key equivalents reached for the same key.
 */
describe("effective code", () => {
  const selectAll: Chord = { key: "KeyA", meta: true };
  const quit: Chord = { key: "KeyQ", meta: true };

  test("AZERTY: a letter chord fires on the key that types the letter", () => {
    // The key at the US Q position types "a", and the one at the US A
    // position types "q".
    const typesA = recordedKeydown("French", "KeyQ", ["meta"]);
    const typesQ = recordedKeydown("French", "KeyA", ["meta"]);
    expect([typesA.key, typesA.keyCode, typesQ.key, typesQ.keyCode]).toEqual(["a", 65, "q", 81]);
    expect(effectiveCode(typesA)).toBe("KeyA");
    expect(chordMatchesEvent(typesA, selectAll)).toBe(true);
    expect(chordMatchesEvent(typesA, quit)).toBe(false);
    expect(chordMatchesEvent(typesQ, quit)).toBe(true);
    expect(chordMatchesEvent(typesQ, selectAll)).toBe(false);
    expect(eventChordKey(typesA)).toBe(chordKey(selectAll));
  });

  test("AZERTY: the rule holds under ⌃, and under ⌥ where key is composed", () => {
    const ctrlA: Chord = { key: "KeyA", ctrl: true };
    const ctrl = recordedKeydown("French", "KeyQ", ["ctrl"]);
    expect(chordMatchesEvent(ctrl, ctrlA)).toBe(true);
    expect(chordMatchesEvent(ctrl, { key: "KeyQ", ctrl: true })).toBe(false);

    // ⌥ composes the character, so `key` cannot name the letter; `keyCode`
    // comes from the character without modifiers and still does.
    const altA: Chord = { key: "KeyA", alt: true };
    const alt = recordedKeydown("French", "KeyQ", ["alt"]);
    expect(alt.key).toBe("æ");
    expect(chordMatchesEvent(alt, altA)).toBe(true);
    expect(chordMatchesEvent(alt, { key: "KeyQ", alt: true })).toBe(false);
  });

  test("Dvorak – QWERTY ⌘: ⌘ follows QWERTY, alone or with ⌥ or ⇧; ⌃ and ⌃⌘ follow Dvorak", () => {
    const copy: Chord = { key: "KeyC", meta: true };
    // With ⌘ held the layout types QWERTY, so the US C position is C.
    expect(chordMatchesEvent(recordedKeydown("DVORAK-QWERTYCMD", "KeyC", ["meta"]), copy)).toBe(true);
    expect(effectiveCode(recordedKeydown("DVORAK-QWERTYCMD", "KeyC", ["meta", "alt"]))).toBe("KeyC");
    expect(effectiveCode(recordedKeydown("DVORAK-QWERTYCMD", "KeyC", ["meta", "shift"]))).toBe("KeyC");
    // Without it the same position types "j", and "c" is at the US I position.
    const ctrlC: Chord = { key: "KeyC", ctrl: true };
    expect(chordMatchesEvent(recordedKeydown("DVORAK-QWERTYCMD", "KeyI", ["ctrl"]), ctrlC)).toBe(true);
    expect(chordMatchesEvent(recordedKeydown("DVORAK-QWERTYCMD", "KeyC", ["ctrl"]), ctrlC)).toBe(false);
    // ⌃ with ⌘ is Dvorak too: the layout types "j" at the US C position.
    expect(effectiveCode(recordedKeydown("DVORAK-QWERTYCMD", "KeyC", ["meta", "ctrl"]))).toBe("KeyJ");
    expect(effectiveCode(recordedKeydown("DVORAK-QWERTYCMD", "KeyI", ["meta", "ctrl"]))).toBe("KeyC");
  });

  test("Russian and Greek: with no Roman letter to read, a letter follows the position", () => {
    const copy: Chord = { key: "KeyC", meta: true };
    for (const layout of ["Russian", "Greek"] as const) {
      expect(effectiveCode(recordedKeydown(layout, "KeyC", ["meta"]))).toBe("KeyC");
      expect(chordMatchesEvent(recordedKeydown(layout, "KeyC", ["meta"]), copy)).toBe(true);
      expect(effectiveCode(recordedKeydown(layout, "KeyC", ["ctrl"]))).toBe("KeyC");
    }
    expect(recordedKeydown("Russian", "KeyC", ["ctrl"]).key).toBe("с");
  });

  test("a digit chord stays on the number-row key", () => {
    // AZERTY's number row types "&" unshifted; the chord is still ⌘1. Its 4
    // key types "'" and reports the US quote key's 222; it is still ⌘4.
    const first: Chord = { key: "Digit1", meta: true };
    const one = recordedKeydown("French", "Digit1", ["meta"]);
    expect(one.key).toBe("&");
    expect(effectiveCode(one)).toBe("Digit1");
    expect(chordMatchesEvent(one, first)).toBe(true);
    const four = recordedKeydown("French", "Digit4", ["meta"]);
    expect([four.key, four.keyCode]).toEqual(["'", 222]);
    expect(effectiveCode(four)).toBe("Digit4");
  });

  test("a punctuation key the layout leaves in place matches by position", () => {
    for (const layout of ["Russian", "Greek"] as const) {
      const slash = recordedKeydown(layout, "Slash", ["meta"]);
      expect(effectiveCode(slash)).toBe("Slash");
      expect(chordMatchesEvent(slash, { key: "Slash", meta: true })).toBe(true);
    }
  });

  test("AZERTY and QWERTZ: a moved punctuation chord fires on the key that types it, as the menu does", () => {
    const zoomOut: Chord = { key: "Minus", meta: true };
    const zoomInAlias: Chord = { key: "Equal", meta: true };
    // AZERTY types "-" at the US Equal position; QWERTZ types it at Slash.
    for (const [layout, code] of [["French", "Equal"], ["German", "Slash"]] as const) {
      const minus = recordedKeydown(layout, code, ["meta"]);
      expect([minus.key, minus.keyCode]).toEqual(["-", 189]);
      expect(chordMatchesEvent(minus, zoomOut)).toBe(true);
      expect(chordMatchesEvent(minus, { key: code, meta: true })).toBe(false);
      // The localized menu reached Zoom Out on the same key.
      const menuTry = recordedMenuTries(layout).find(
        (t) => t.command === "zoom-out" && t.pressed[0] === code && t.pressed[1] === "cmd",
      );
      expect(menuTry?.fired).toBe("view.zoomOut");
    }
    // AZERTY types "=" at the US Slash position, and "+" there with ⇧.
    expect(chordMatchesEvent(recordedKeydown("French", "Slash", ["meta"]), zoomInAlias)).toBe(true);
    expect(chordMatchesEvent(recordedKeydown("French", "Slash", ["meta", "shift"]), { ...zoomInAlias, shift: true })).toBe(true);
    // Under ⌥ the character is composed ("≠"); the key code still names it.
    expect(effectiveCode(recordedKeydown("French", "Slash", ["meta", "alt"]))).toBe("Equal");
  });

  test("AZERTY: a letter position that types punctuation answers to the punctuation", () => {
    // The US M position types ","; "m" is at the US Semicolon position.
    expect(effectiveCode(recordedKeydown("French", "KeyM", ["meta"]))).toBe("Comma");
    expect(effectiveCode(recordedKeydown("French", "Semicolon", ["meta"]))).toBe("KeyM");
  });

  test("a key code its character does not confirm leaves the key positional", () => {
    // AZERTY's "<" key reports the US comma key's 188 and its ":" key the
    // US semicolon key's 186; neither types the character the chord means.
    const lessThan = recordedKeydown("French", "Backquote", ["meta"]);
    expect([lessThan.key, lessThan.keyCode]).toEqual(["<", 188]);
    expect(effectiveCode(lessThan)).toBe("Backquote");
    expect(chordMatchesEvent(lessThan, { key: "Comma", meta: true })).toBe(false);
    expect(effectiveCode(recordedKeydown("French", "Period", ["meta"]))).toBe("Period");
  });

  test("an event with no keyCode, or a zero one, matches by its code", () => {
    expect(effectiveCode(keyEvent("KeyQ", { meta: true }))).toBe("KeyQ");
    expect(effectiveCode(syntheticEvent("KeyQ", 0, "q", { meta: true }))).toBe("KeyQ");
    expect(chordMatchesEvent(syntheticEvent("KeyQ", 0, "q", { meta: true }), quit)).toBe(true);
    // A punctuation key code with no `key` to confirm it stays positional.
    expect(effectiveCode({ code: "Equal", keyCode: 189 })).toBe("Equal");
  });

  test("capture records the effective code, so the chord matches the key pressed", () => {
    const pressed = recordedKeydown("French", "KeyQ", ["meta"]);
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
