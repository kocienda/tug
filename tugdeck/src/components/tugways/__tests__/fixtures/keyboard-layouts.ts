/**
 * keyboard-layouts — keydowns recorded from real keyboard layouts.
 *
 * `keyboard-layouts.json` is a lab recording: in a macOS guest, each of
 * French (AZERTY), German (QWERTZ), Greek, Russian and Dvorak – QWERTY ⌘ was
 * selected, every key a default chord uses was pressed by position — bare,
 * under ⌘, ⌃, ⌥ and ⇧, and under ⌘ with each of ⌃, ⌥ and ⇧ — and the page's
 * keydown was kept. It is written by `scripts/lab/layout-recording-fixture.ts`
 * from `tests/app-test/readings/lab-layout-recording.test.ts`, and the menu
 * tries beside the presses say which menu item AppKit's localized key
 * equivalents reached for each punctuation chord.
 *
 * {@link recordedKeydown} hands a test one of those keydowns, shaped as the
 * fields chord matching reads, so a layout test asserts on what the layout
 * delivered rather than on what anyone believed it would.
 */

import recording from "./keyboard-layouts.json";

/** The recorded layouts, by the last part of their input-source ID. */
export type RecordedLayout = "French" | "German" | "Greek" | "Russian" | "DVORAK-QWERTYCMD";

/** The modifiers a press was recorded under. */
export type RecordedModifier = "meta" | "ctrl" | "alt" | "shift";

type Row = [string, string, string | null, number | null];

interface RecordedLayoutData {
  id: string;
  presses: Row[];
  menu: RecordedMenuTry[];
}

/** One punctuation chord pressed past the deck, and the menu item AppKit reached. */
export interface RecordedMenuTry {
  command: string;
  chord: [string, string];
  keyEquivalent: string;
  why: "us-position" | "character";
  pressed: [string, string];
  event: [string, number] | null;
  fired: string | null;
}

// The JSON's inferred row type is a union of arrays, not the tuple it is.
const LAYOUTS = (recording as unknown as { layouts: RecordedLayoutData[] }).layouts;

/** The recording's own spelling of a modifier set: ⌘ first, then ⌃, ⌥, ⇧. */
function modsKey(mods: readonly RecordedModifier[]): string {
  const order: [RecordedModifier, string][] = [["meta", "cmd"], ["ctrl", "ctrl"], ["alt", "alt"], ["shift", "shift"]];
  return order.filter(([m]) => mods.includes(m)).map(([, name]) => name).join("+");
}

function layoutData(layout: RecordedLayout): RecordedLayoutData {
  const found = LAYOUTS.find((l) => l.id === `com.apple.keylayout.${layout}`);
  if (found === undefined) throw new Error(`keyboard-layouts: no recording for ${layout}`);
  return found;
}

/**
 * The keydown `layout` delivered for the key at `code` under `mods`, with the
 * six fields chord matching reads plus `key`. Throws when the press was not
 * recorded (or was skipped because it is a system shortcut), so a test cannot
 * silently assert on nothing.
 */
export function recordedKeydown(
  layout: RecordedLayout,
  code: string,
  mods: readonly RecordedModifier[] = [],
): KeyboardEvent {
  const want = modsKey(mods);
  const row = layoutData(layout).presses.find(([c, m]) => c === code && m === want);
  if (row === undefined || row[2] === null || row[3] === null) {
    throw new Error(`keyboard-layouts: ${layout} has no recorded keydown for ${code}+${want || "bare"}`);
  }
  return {
    code,
    key: row[2],
    keyCode: row[3],
    metaKey: mods.includes("meta"),
    ctrlKey: mods.includes("ctrl"),
    altKey: mods.includes("alt"),
    shiftKey: mods.includes("shift"),
  } as KeyboardEvent;
}

/** Every keydown recorded for `layout`, with its modifiers. */
export function recordedKeydowns(layout: RecordedLayout): { mods: RecordedModifier[]; event: KeyboardEvent }[] {
  const names: Record<string, RecordedModifier> = { cmd: "meta", ctrl: "ctrl", alt: "alt", shift: "shift" };
  return layoutData(layout)
    .presses.filter((r) => r[2] !== null)
    .map(([code, m]) => {
      const mods = m === "" ? [] : m.split("+").map((n) => names[n]);
      return { mods, event: recordedKeydown(layout, code, mods) };
    });
}

/** The punctuation menu tries recorded for `layout`. */
export function recordedMenuTries(layout: RecordedLayout): readonly RecordedMenuTry[] {
  return layoutData(layout).menu;
}
