/**
 * lab-layout-recording.test.ts — what five keyboard layouts deliver to the
 * deck, and which menu items AppKit's localized key equivalents reach.
 *
 * Chord matching reads a keydown's `code`, `keyCode` and modifier flags, and
 * the rule it applies on a non-US layout (`effectiveCode` in `chord-format.ts`)
 * was written from WebKit's source, not from a keyboard. This reading records
 * the real thing in a lab guest: for French (AZERTY), German (QWERTZ), Greek,
 * Russian and Dvorak – QWERTY ⌘, every key the default chords use is pressed
 * by position, bare and under ⌘, ⌃, ⌥ and ⇧, and the page's keydown is kept —
 * `key`, `code`, `keyCode` and the four flags. Then, for every punctuation
 * chord the menu bar carries, the chord is pressed on its US position and on
 * the key that types its character on the layout, with the deck out of the
 * way, and the menu item AppKit fires (if any) is kept.
 *
 * Both posting modes are recorded — the harness's pid mode and the session
 * tap a real keyboard uses — because whether pid-mode events translate
 * through the current layout as hardware does was an open question.
 *
 * Nothing fires: the page's listener sits ahead of the deck's in the capture
 * phase and stops every keydown there, and in the record pass it also
 * prevents the default, so neither the deck nor the menu sees the key. In the
 * menu pass it lets the default stand, so WebKit hands the key on to AppKit,
 * and the harness's menu key probe records the item instead of performing it.
 *
 * Some presses are never made. A system shortcut is not a menu item of this
 * app, so the probe cannot withhold it, and the menu pass would otherwise reach
 * them: on Dvorak – QWERTY ⌘ the key that types `"` sits at the US Q position,
 * which under ⌘ is QWERTY again, so ⌘⇧ there is the system's Log Out — the
 * first run of this reading logged its guest out that way. So ⌘⇧ and ⌃⌘ on the
 * key where ⌘ types `q` (Log Out, Lock Screen), and ⌘⇧ on Digit3–Digit6 (the
 * screenshot chords), are recorded as skipped instead of pressed.
 *
 * A dead key (`key` "Dead") leaves a composition pending, and the next key
 * would read as the composed character; so after one, Space is pressed and its
 * keydown dropped, which ends the composition before the next press.
 *
 * A key no menu item holds falls through to AppKit's no-responder beep, which
 * the harness counts as a red. Here that beep is the answer "nothing holds this
 * key", so each launch's beeps are taken into its recording (`beeps`) instead.
 *
 * Each mode is a test of its own and writes its own file as it ends, so one
 * mode's failure keeps the other's recording:
 * `tests/app-test/logs/lab-layout-recording-pid.json` and `…-session.json`
 * (in `TUG_LAB_RECORDING_DIR` if set). Fetch both with
 * `just lab-app-test golden-gate --fetch tests/app-test/logs/lab-layout-recording-pid.json --fetch tests/app-test/logs/lab-layout-recording-session.json readings/lab-layout-recording.test.ts`.
 * The committed copy is `tugdeck/src/components/tugways/__tests__/fixtures/keyboard-layouts.json`.
 *
 * It selects input sources, so it runs only in a lab guest.
 *
 * @lab
 * @foreground activation
 * @covers tugdeck/src/components/tugways/chord-format.ts
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";

import { launchTugApp, note, type App, type MenuKeyFire, type NativeModifier } from "../_harness";
import { takeBeeps } from "../_harness/beep-report";
import { SHOULD_RUN, removeOverlay, seedOverlay, waitForPaintSettled } from "../harness-smoke/smoke-native-fixture";
import { COMMANDS, type Chord } from "../../../tugdeck/src/components/tugways/command-registry";

const IN_LAB = process.env.TUG_LAB === "1";
const OUT_DIR = process.env.TUG_LAB_RECORDING_DIR ?? join(import.meta.dir, "..", "logs");
const TEST_TIMEOUT_MS = 1_200_000;

/**
 * `codeToKeyEquivalent`, the conversion the menu push uses, loaded at run time:
 * `chord-format.ts` reads Vite's `import.meta.env`, which this tree's compiler
 * does not type, so a static import would fail the type check over a line this
 * reading never reaches.
 */
const CHORD_FORMAT = "../../../tugdeck/src/components/tugways/chord-format";
const { codeToKeyEquivalent } = (await import(CHORD_FORMAT)) as {
  codeToKeyEquivalent: (chord: Chord) => {
    keyEquivalent: string;
    command?: boolean;
    shift?: boolean;
    option?: boolean;
    control?: boolean;
  } | null;
};

/** The layouts, and the keyboard type each is recorded under: AZERTY and QWERTZ boards are ISO. */
const LAYOUTS: readonly { id: string; keyboardType: "iso" | null }[] = [
  { id: "com.apple.keylayout.French", keyboardType: "iso" },
  { id: "com.apple.keylayout.German", keyboardType: "iso" },
  { id: "com.apple.keylayout.Greek", keyboardType: null },
  { id: "com.apple.keylayout.Russian", keyboardType: null },
  { id: "com.apple.keylayout.DVORAK-QWERTYCMD", keyboardType: null },
];

/** The punctuation positions, the ones a default chord uses and the rest of the row. */
const PUNCTUATION = [
  "Minus", "Equal", "BracketLeft", "BracketRight", "Backslash", "Semicolon",
  "Quote", "Backquote", "Comma", "Period", "Slash", "IntlBackslash",
];

/** The single modifiers, then the pairs the default chords hold with ⌘; ⌘ alone comes before any pair. */
const MOD_SETS: readonly (readonly NativeModifier[])[] = [
  [], ["cmd"], ["ctrl"], ["alt"], ["shift"], ["cmd", "ctrl"], ["cmd", "alt"], ["cmd", "shift"],
];

interface Pressed {
  key: string;
  code: string;
  keyCode: number;
  meta: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
}

interface Press {
  /** The position pressed, and the modifiers held. */
  code: string;
  mods: string[];
  /** The page's keydown, or null when none arrived. */
  event: Pressed | null;
  /** Set, with nothing pressed, when the press could reach a system shortcut. */
  skipped?: string;
}

interface MenuTry {
  chord: { key: string; mods: string[]; command: string; keyEquivalent: string };
  /** Why this position: the chord's US position, or the key that types its character here. */
  why: "us-position" | "character";
  pressed: { code: string; mods: string[] };
  event: Pressed | null;
  fired: MenuKeyFire[];
  /** Set, with nothing pressed, when the press could reach a system shortcut. */
  skipped?: string;
}

/**
 * Whether a press could reach a system-wide shortcut the probe cannot withhold:
 * ⌘⇧ or ⌃⌘ on the key where ⌘ types `q` on this layout (Log Out, Lock Screen),
 * or ⌘⇧ on Digit3–Digit6 (the screenshot chords). `cmdKeys` is the layout's
 * ⌘-alone `key` per position, which the record pass reads before any pair.
 */
function systemRisk(code: string, mods: readonly NativeModifier[], cmdKeys: ReadonlyMap<string, string>): boolean {
  if (!mods.includes("cmd")) return false;
  if (mods.includes("shift") && /^Digit[3-6]$/.test(code)) return true;
  return (mods.includes("shift") || mods.includes("ctrl")) && (cmdKeys.get(code) ?? "").toLowerCase() === "q";
}

/** Press `code` for the menu pass, or record it as skipped. */
async function menuTry(
  app: App,
  chord: MenuTry["chord"],
  why: MenuTry["why"],
  code: string,
  mods: NativeModifier[],
  cmdKeys: ReadonlyMap<string, string>,
): Promise<MenuTry> {
  if (systemRisk(code, mods, cmdKeys)) {
    return { chord, why, pressed: { code, mods }, event: null, fired: [], skipped: "system shortcut risk" };
  }
  const event = await press(app, code, mods);
  return { chord, why, pressed: { code, mods }, event, fired: await firedAfter(app) };
}

/** Every code a default chord uses, and the punctuation row. */
function recordedCodes(): string[] {
  const codes = new Set<string>(PUNCTUATION);
  for (const c of COMMANDS) {
    for (const b of c.bindings ?? []) {
      if (/^(Key[A-Z]|Digit\d)$/.test(b.chord.key)) codes.add(b.chord.key);
    }
  }
  for (let i = 0; i < 26; i++) codes.add(`Key${String.fromCharCode(65 + i)}`);
  return [...codes].sort();
}

/** The default punctuation chords the menu bar carries, with their key equivalents. */
function menuPunctuationChords(): { chord: Chord; command: string; keyEquivalent: string; mods: NativeModifier[] }[] {
  const out: { chord: Chord; command: string; keyEquivalent: string; mods: NativeModifier[] }[] = [];
  for (const c of COMMANDS) {
    for (const b of c.bindings ?? []) {
      if (b.source !== "default" || b.menuEligible !== true) continue;
      if (!PUNCTUATION.includes(b.chord.key)) continue;
      const spec = codeToKeyEquivalent(b.chord);
      if (spec === null) continue;
      const mods: NativeModifier[] = [];
      if (spec.command) mods.push("cmd");
      if (spec.control) mods.push("ctrl");
      if (spec.option) mods.push("alt");
      if (spec.shift) mods.push("shift");
      out.push({ chord: b.chord, command: c.id, keyEquivalent: spec.keyEquivalent, mods });
    }
  }
  return out;
}

function chordMods(chord: Chord): string[] {
  return [
    ...(chord.meta ? ["cmd"] : []),
    ...(chord.ctrl ? ["ctrl"] : []),
    ...(chord.alt ? ["alt"] : []),
    ...(chord.shift ? ["shift"] : []),
  ];
}

const LISTENER = `
  (function () {
    if (window.__lab !== undefined) return;
    window.__lab = { mode: "record", events: [] };
    window.addEventListener("keydown", function (e) {
      if (/^(Meta|Shift|Alt|Control|OS)(Left|Right)?$/.test(e.code)) return;
      window.__lab.events.push({
        key: e.key, code: e.code, keyCode: e.keyCode,
        meta: e.metaKey, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey,
      });
      // Ahead of the deck's capture listeners on document: nothing past here hears it.
      e.stopPropagation();
      if (window.__lab.mode === "record") e.preventDefault();
    }, true);
  })();
`;

async function press(app: App, code: string, mods: readonly NativeModifier[]): Promise<Pressed | null> {
  const before = await app.evalJS<number>("window.__lab.events.length");
  await app.nativeKeyCode(code, mods);
  try {
    await app.waitForCondition(`window.__lab.events.length > ${before}`, { timeoutMs: 1500 });
  } catch {
    return null;
  }
  const event = await app.evalJS<Pressed>(`window.__lab.events[${before}]`);
  if (event.key === "Dead") {
    // End the pending composition so it does not bleed into the next press.
    const pending = await app.evalJS<number>("window.__lab.events.length");
    const mode = await app.evalJS<string>("window.__lab.mode");
    await app.evalJS(`window.__lab.mode = "record"`);
    await app.nativeKeyCode("Space", []);
    try {
      await app.waitForCondition(`window.__lab.events.length > ${pending}`, { timeoutMs: 1500 });
    } catch {
      // nothing arrived; the next press will show whether the composition held
    }
    await app.evalJS(`window.__lab.mode = ${JSON.stringify(mode)}`);
  }
  return event;
}

/** The menu items a press reached: polled briefly, since AppKit sees the key after the page. */
async function firedAfter(app: App): Promise<MenuKeyFire[]> {
  const deadline = Date.now() + 400;
  for (;;) {
    const fired = await app.takeMenuKeyFires();
    if (fired.length > 0 || Date.now() > deadline) return fired;
    await Bun.sleep(25);
  }
}

function launchName(foreground: boolean): string {
  return `lab-layout-recording-${foreground ? "session" : "pid"}`;
}

async function recordMode(foreground: boolean): Promise<unknown> {
  const app = await launchTugApp({
    testName: launchName(foreground),
    ...(foreground ? { foreground: true } : {}),
  });
  const fixtureId = "lab-layout-recording";
  const codes = recordedCodes();
  const menuChords = menuPunctuationChords();
  const layouts: unknown[] = [];
  try {
    await waitForPaintSettled(app);
    await seedOverlay(app, fixtureId, `<input id="lab-input" type="text" style="width: 300px; height: 32px;" />`);
    await waitForPaintSettled(app);
    await app.evalJS(LISTENER);
    await app.nativeClickAtElement("#lab-input");
    await app.waitForCondition(`document.activeElement === document.getElementById("lab-input")`);
    await app.armMenuKeyProbe();
    const system = (await app.setKeyboardType(null)).system;
    const installed = await app.inputSources();

    for (const layout of LAYOUTS) {
      const selected = await app.selectInputSource(layout.id);
      const keyboardType = (await app.setKeyboardType(layout.keyboardType)).current;
      await app.evalJS(`window.__lab.mode = "record"`);
      const presses: Press[] = [];
      const cmdKeys = new Map<string, string>();
      for (const mods of MOD_SETS) {
        for (const code of codes) {
          if (systemRisk(code, mods, cmdKeys)) {
            presses.push({ code, mods: [...mods], event: null, skipped: "system shortcut risk" });
            continue;
          }
          const event = await press(app, code, mods);
          presses.push({ code, mods: [...mods], event });
          if (mods.length === 1 && mods[0] === "cmd" && event !== null) cmdKeys.set(code, event.key);
        }
      }
      // A record-pass key never reaches the menu; anything here is a leak worth seeing.
      const leaked = await app.takeMenuKeyFires();

      await app.evalJS(`window.__lab.mode = "menu"`);
      const menu: MenuTry[] = [];
      for (const m of menuChords) {
        const chord = { key: m.chord.key, mods: chordMods(m.chord), command: m.command, keyEquivalent: m.keyEquivalent };
        const usMods: NativeModifier[] = chordMods(m.chord) as NativeModifier[];
        menu.push(await menuTry(app, chord, "us-position", m.chord.key, usMods, cmdKeys));
        // The keys that type the key equivalent's character on this layout, bare or shifted.
        for (const p of presses) {
          if (p.event === null || p.event.key !== m.keyEquivalent) continue;
          const shifted = p.mods.length === 1 && p.mods[0] === "shift";
          if (p.mods.length > 0 && !shifted) continue;
          const mods: NativeModifier[] = [...m.mods.filter((x) => x !== "shift"), ...(shifted ? (["shift"] as const) : [])];
          if (p.code === m.chord.key && !shifted && !m.mods.includes("shift")) continue;
          menu.push(await menuTry(app, chord, "character", p.code, mods, cmdKeys));
        }
      }
      layouts.push({
        id: layout.id,
        selected: selected.current,
        name: installed.sources.find((s) => s.id === layout.id)?.name ?? null,
        keyboardType,
        presses,
        leakedToMenu: leaked,
        menu,
      });
      const missing = presses.filter((p) => p.event === null && p.skipped === undefined).length;
      note(`${foreground ? "session" : "pid"} ${layout.id}: ${presses.length} presses, ${missing} with no keydown; ${menu.length} menu tries, ${menu.filter((t) => t.fired.length > 0).length} fired`);
    }
    return { systemKeyboardType: system, layouts };
  } finally {
    try {
      await app.disarmMenuKeyProbe();
      await removeOverlay(app, fixtureId);
    } catch {
      // best-effort cleanup
    }
    await app.close();
  }
}

describe.skipIf(!SHOULD_RUN || !IN_LAB)("keyboard layout recording", () => {
  for (const mode of ["pid", "session"] as const) {
    test(
      `records five layouts in ${mode} mode`,
      async () => {
        const recorded = (await recordMode(mode === "session")) as { layouts: unknown[] };
        const beeps = takeBeeps(launchName(mode === "session")).map((b) => ({ origin: b.origin, verb: b.verb, key: b.key }));
        const out = join(OUT_DIR, `lab-layout-recording-${mode}.json`);
        mkdirSync(dirname(out), { recursive: true });
        writeFileSync(
          out,
          `${JSON.stringify({
            schema: 1,
            mode,
            recorded: new Date().toISOString(),
            guest: execFileSync("sw_vers", ["-productVersion"]).toString().trim(),
            ...recorded,
            beeps,
          })}\n`,
        );
        note(`recording written to ${out}; ${beeps.length} unclaimed-key beeps kept in it`);
        expect(recorded.layouts.length).toBe(LAYOUTS.length);
      },
      TEST_TIMEOUT_MS,
    );
  }
});
