/**
 * The gesture check: every chord and slash command the guide, the
 * getting-started walk, the recipes and the glossary name has to exist in the
 * code. The release notes stay out, since
 * they describe each version as it was. A document is written from its sources once
 * and read for years, so a rebound chord or a retired command fails here
 * rather than in front of someone following a recipe.
 *
 * @covers docs/recipes.md
 * @covers docs/features.md
 * @covers docs/getting-started.md
 * @covers docs/glossary.md
 * @covers tugdeck/src/components/tugways/command-registry.ts
 * @covers tugdeck/src/lib/slash-commands.ts
 * @covers tugapp/Sources/MenuBarBuilder.swift
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { COMMANDS } from "@/components/tugways/command-registry";
import {
  LOCAL_SLASH_COMMAND_ALIASES,
  LOCAL_SLASH_COMMANDS,
} from "@/lib/slash-commands";

const REPO = join(import.meta.dir, "../../../..");
const DECK_SRC = join(REPO, "tugdeck/src");
const DOCUMENTS = ["recipes", "features", "getting-started", "glossary"] as const;

function readRepo(path: string): string {
  return readFileSync(join(REPO, path), "utf8");
}

/** A document as a reader gets it: a comment owning its line reaches nobody. */
function readDocument(name: string): string {
  return readRepo(`docs/${name}.md`).replace(/^[ \t]*<!--.*-->[ \t]*$/gm, "");
}

/* ---------------------------------------------------------------------------
 * Chords, as `KeyboardEvent.code` plus the modifiers held
 * ------------------------------------------------------------------------- */

const KEY_CODES: Readonly<Record<string, string>> = {
  "Left Arrow": "ArrowLeft",
  "Right Arrow": "ArrowRight",
  "Up Arrow": "ArrowUp",
  "Down Arrow": "ArrowDown",
  Apostrophe: "Quote",
  Comma: "Comma",
  Period: "Period",
  Slash: "Slash",
  "Left Bracket": "BracketLeft",
  "Right Bracket": "BracketRight",
  "Equal Sign": "Equal",
  "Plus Sign": "Equal",
  "Minus Sign": "Minus",
  Return: "Enter",
  Tab: "Tab",
};

/** The key names a document may write: the menu bar's own (`+`, `[`) and the spelled ones. */
const MENU_KEY_NAMES: Readonly<Record<string, string>> = {
  "'": "Apostrophe",
  ",": "Comma",
  ".": "Period",
  "/": "Slash",
  "[": "Left Bracket",
  "]": "Right Bracket",
  "=": "Equal Sign",
  "+": "Plus Sign",
  "-": "Minus Sign",
};

function keyCode(written: string): string | null {
  if (/^[A-Z]$/.test(written)) return `Key${written}`;
  if (/^[0-9]$/.test(written)) return `Digit${written}`;
  return KEY_CODES[written] ?? null;
}

function canonical(
  code: string,
  mods: { ctrl?: boolean; alt?: boolean; shift?: boolean; meta?: boolean },
): string {
  return [
    mods.ctrl === true ? "⌃" : "",
    mods.alt === true ? "⌥" : "",
    mods.shift === true ? "⇧" : "",
    mods.meta === true ? "⌘" : "",
    code,
  ].join("");
}

/**
 * The canonical form of a chord as a document writes it, or null when it is
 * not one this check can read. A document spells a chord the way the Apple
 * Style Guide does, its keys joined by hyphens with the modifiers in the order
 * Control, Option, Shift, Command: `Control-Command-Left Arrow`. Any other
 * order is refused, so the documents stay in the one spelling.
 */
function readWrittenChord(written: string): string | null {
  const parts = /^((?:Control-)?(?:Option-)?(?:Shift-)?(?:Command-)?)(.+)$/u.exec(written);
  if (parts === null || parts[1] === "") return null;
  const code = keyCode(parts[2]);
  if (code === null) return null;
  return canonical(code, {
    ctrl: parts[1].includes("Control-"),
    alt: parts[1].includes("Option-"),
    shift: parts[1].includes("Shift-"),
    meta: parts[1].includes("Command-"),
  });
}

const FAMILIES: Readonly<Record<string, readonly string[]>> = {
  digit: ["1", "2", "3", "4", "5", "6"],
  arrow: ["Left Arrow", "Right Arrow", "Up Arrow", "Down Arrow"],
};

/**
 * Every chord a text names, as written. "Option-Command with an arrow key" and
 * "Command with a digit" name the whole family. Anything else hyphenated onto
 * a run of modifiers is kept as written, so a chord this reader cannot parse
 * is refused rather than skipped. A modifier's symbol in running text is kept
 * too, and so refused: the documents spell their keys out.
 */
function chordsIn(text: string): string[] {
  const found: string[] = [];
  const mods = "(?:Control|Option|Shift|Command)";
  const run = new RegExp(
    `\\b(${mods}(?:-${mods})*) with (?:an?|the same) (digit|arrow)` +
      `|\\b((?:${mods}-)+)((?:Left|Right|Up|Down) Arrow|(?:Plus|Minus|Equal) Sign|(?:Left|Right) Bracket|\\w+)` +
      `|[⌃⌥⇧⌘]+\\S*`,
    "gu",
  );
  for (const match of text.matchAll(run)) {
    if (match[2] !== undefined) {
      for (const key of FAMILIES[match[2]]) found.push(`${match[1]}-${key}`);
    } else if (match[3] !== undefined) {
      found.push(`${match[3]}${match[4]}`);
    } else {
      found.push(match[0]);
    }
  }
  return found;
}

/** What the command registry binds by default, in every scope. */
function registryChords(): Set<string> {
  const chords = new Set<string>();
  for (const command of COMMANDS) {
    for (const { chord } of command.bindings ?? []) {
      chords.add(canonical(chord.key, chord));
    }
  }
  return chords;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((path) => /\.tsx?$/.test(path) && !path.includes("__tests__"))
    .map((path) => join(dir, path));
}

/**
 * The literal chords of the `useKeybindings` registrants. A registrant whose
 * chords come from the registry has nothing to add here. The gallery's demo
 * chord is not a gesture anyone is told about, so its file is passed over.
 */
function scopedKeybindingChords(): Set<string> {
  const chords = new Set<string>();
  for (const file of sourceFiles(DECK_SRC)) {
    if (file.includes("gallery-")) continue;
    const source = readFileSync(file, "utf8");
    if (!source.includes("useKeybindings(")) continue;
    for (const [literal, code] of source.matchAll(/\{\s*key: "(\w+)",[^}]*\}/g)) {
      chords.add(
        canonical(code, {
          ctrl: literal.includes("ctrl: true"),
          alt: literal.includes("alt: true"),
          shift: literal.includes("shift: true"),
          meta: literal.includes("meta: true"),
        }),
      );
    }
  }
  return chords;
}

/** The key equivalents the native menu declares; ⌘ alone unless a mask says. */
function menuChords(): Set<string> {
  const chords = new Set<string>();
  const source = readRepo("tugapp/Sources/MenuBarBuilder.swift");
  const item = /keyEquivalent: "([^"]+)"(?:, modifierMask: \[([^\]]*)\])?/g;
  for (const match of source.matchAll(item)) {
    const key = match[1].toUpperCase();
    const code = keyCode(MENU_KEY_NAMES[key] ?? key);
    if (code === null) continue;
    const mask = match[2] ?? ".command";
    chords.add(
      canonical(code, {
        ctrl: mask.includes(".control"),
        alt: mask.includes(".option"),
        shift: mask.includes(".shift"),
        meta: mask.includes(".command"),
      }),
    );
  }
  return chords;
}

/**
 * Chords a component reads off the key event itself, with neither a registry
 * row nor a menu item. Each names the file and the text that establishes it,
 * so the file changing shape fails here too.
 */
const COMPOSER_KEYMAP = "tugdeck/src/components/tugways/tug-text-editor/keymap.ts";
const COMPONENT_CHORDS: readonly {
  chords: readonly string[];
  file: string;
  reads: string;
}[] = [
  {
    chords: ["Option-Up Arrow", "Option-Down Arrow", "Command-Up Arrow", "Command-Down Arrow"],
    file: COMPOSER_KEYMAP,
    reads: "(event.altKey || event.metaKey)",
  },
  {
    chords: ["Shift-Return"],
    file: COMPOSER_KEYMAP,
    reads: "resolveEnterAction(config, isNumpad, event.shiftKey)",
  },
  {
    chords: ["Shift-Tab"],
    file: "tugdeck/src/components/tugways/responder-chain-provider.tsx",
    reads: 'event.key !== "Tab" || event.metaKey || event.ctrlKey || event.altKey',
  },
];

function knownChords(): Set<string> {
  const known = new Set([
    ...registryChords(),
    ...scopedKeybindingChords(),
    ...menuChords(),
  ]);
  for (const { chords } of COMPONENT_CHORDS) {
    for (const chord of chords) known.add(readWrittenChord(chord) ?? chord);
  }
  return known;
}

/* ---------------------------------------------------------------------------
 * Slash commands
 * ------------------------------------------------------------------------- */

/** Every `/command` a text names in code spans, with its arguments dropped. */
function slashCommandsIn(text: string): string[] {
  const span = /`\/([a-zA-Z][\w:-]*)(?:\s[^`]*)?`/g;
  return [...text.matchAll(span)].map((match) => match[1]);
}

function knownSlashCommands(): Set<string> {
  const known = new Set<string>([
    ...LOCAL_SLASH_COMMANDS.map((command) => command.name),
    ...LOCAL_SLASH_COMMAND_ALIASES.keys(),
  ]);
  const skills = join(REPO, "tugplug/skills");
  for (const skill of readdirSync(skills)) {
    if (!existsSync(join(skills, skill, "SKILL.md"))) continue;
    known.add(skill);
    known.add(`tugplug:${skill}`);
  }
  return known;
}

/**
 * Commands a recipe says do not exist. A receipt row carries these words, so
 * people type them, and the recipe has to say so by name.
 */
const STATED_ABSENT: readonly string[] = ["arc-stop", "arc-run", "arc-discard"];

/* ---------------------------------------------------------------------------
 * The check
 * ------------------------------------------------------------------------- */

describe("the help documents name real gestures", () => {
  const documents = DOCUMENTS.map((name) => ({ name, text: readDocument(name) }));

  test("the readers find the gestures the documents are known to name", () => {
    expect(
      chordsIn("Press Control-Command-Slash, or Command-Comma and then Shift-Return."),
    ).toEqual(["Control-Command-Slash", "Command-Comma", "Shift-Return"]);
    expect(chordsIn("Option-Command with an arrow key")).toEqual([
      "Option-Command-Left Arrow",
      "Option-Command-Right Arrow",
      "Option-Command-Up Arrow",
      "Option-Command-Down Arrow",
    ]);
    expect(chordsIn("Command-click, then ⌘N")).toEqual(["Command-click", "⌘N"]);
    expect(slashCommandsIn("`/` then `/cd <path>` or `/tugplug:brief`, not `/usr/bin`.")).toEqual([
      "cd",
      "tugplug:brief",
    ]);

    const chords = documents.flatMap(({ text }) => chordsIn(text));
    expect(chords).toEqual(
      expect.arrayContaining([
        "Command-N",
        "Control-Command-L",
        "Option-Command-Left Bracket",
        "Shift-Command-Plus Sign",
        "Command-Minus Sign",
      ]),
    );
    const commands = documents.flatMap(({ text }) => slashCommandsIn(text));
    expect(commands).toEqual(expect.arrayContaining(["arc", "commit", "tugplug:brief", "cd"]));
  });

  test("the sources are read, so an unbound chord is refused", () => {
    const known = knownChords();
    expect(known.has(readWrittenChord("Command-N") ?? "")).toBe(true);
    expect(known.has(readWrittenChord("Control-Command-L") ?? "")).toBe(true);
    expect(known.has(readWrittenChord("Command-S") ?? "")).toBe(true);
    expect(known.has(readWrittenChord("Control-Option-Shift-Command-Z") ?? "")).toBe(false);
    expect(readWrittenChord("Command-click")).toBeNull();
    // The Apple Style Guide's order, and no symbols.
    expect(readWrittenChord("Command-Shift-N")).toBeNull();
    expect(readWrittenChord("⌘N")).toBeNull();
  });

  test("every chord a document names exists in the code", () => {
    const known = knownChords();
    const refused: string[] = [];
    for (const { name, text } of documents) {
      for (const written of chordsIn(text)) {
        const chord = readWrittenChord(written);
        if (chord === null || !known.has(chord)) refused.push(`${name}: ${written}`);
      }
    }
    expect([...new Set(refused)]).toEqual([]);
  });

  test("every chord read off a key event is still read there", () => {
    for (const { file, reads } of COMPONENT_CHORDS) {
      expect(readRepo(file)).toContain(reads);
    }
  });

  test("every slash command a document names exists in the code", () => {
    const known = knownSlashCommands();
    const refused: string[] = [];
    for (const { name, text } of documents) {
      for (const command of slashCommandsIn(text)) {
        if (!known.has(command) && !STATED_ABSENT.includes(command)) {
          refused.push(`${name}: /${command}`);
        }
      }
    }
    expect([...new Set(refused)]).toEqual([]);
  });

  test("a command stated absent is absent, and is only ever named as absent", () => {
    const known = knownSlashCommands();
    for (const command of STATED_ABSENT) expect(known.has(command)).toBe(false);

    const refused: string[] = [];
    for (const { name, text } of documents) {
      for (const sentence of text.split(/(?<=[.:])\s+/)) {
        for (const command of slashCommandsIn(sentence)) {
          if (STATED_ABSENT.includes(command) && !sentence.includes("There is no")) {
            refused.push(`${name}: ${sentence}`);
          }
        }
      }
    }
    expect(refused).toEqual([]);
  });
});
