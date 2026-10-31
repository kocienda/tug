/**
 * The gesture check: every chord and slash command the three help documents
 * name has to exist in the code. A document is written from its sources once
 * and read for years, so a rebound chord or a retired command fails here
 * rather than in front of someone following a recipe.
 *
 * @covers docs/recipes.md
 * @covers docs/features.md
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
const DOCUMENTS = ["recipes", "features", "glossary"] as const;

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
  "←": "ArrowLeft",
  "→": "ArrowRight",
  "↑": "ArrowUp",
  "↓": "ArrowDown",
  "'": "Quote",
  ",": "Comma",
  ".": "Period",
  "/": "Slash",
  "[": "BracketLeft",
  "]": "BracketRight",
  "=": "Equal",
  "+": "Equal",
  "-": "Minus",
  "−": "Minus",
  Return: "Enter",
  Tab: "Tab",
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
 * not one this check can read. `+` is the shifted `=`, which is what the
 * keyboard makes of ⌘+.
 */
function readWrittenChord(written: string): string | null {
  const parts = /^([⌃⌥⇧⌘]+)(.+)$/u.exec(written);
  if (parts === null) return null;
  const code = keyCode(parts[2]);
  if (code === null) return null;
  return canonical(code, {
    ctrl: parts[1].includes("⌃"),
    alt: parts[1].includes("⌥"),
    shift: parts[1].includes("⇧") || parts[2] === "+",
    meta: parts[1].includes("⌘"),
  });
}

const FAMILIES: Readonly<Record<string, readonly string[]>> = {
  digit: ["1", "2", "3", "4", "5", "6"],
  arrow: ["←", "→", "↑", "↓"],
};

/**
 * Every chord a text names, as written. "⌥⌘ with an arrow key" and "⌘ with a
 * digit" name the whole family. Anything else after a run of modifiers is
 * kept as written, so a chord this reader cannot parse is refused rather than
 * skipped.
 */
function chordsIn(text: string): string[] {
  const found: string[] = [];
  const run = /([⌃⌥⇧⌘]+)( with (?:an?|the same) (digit|arrow))?([A-Za-z]\w*|[^\sA-Za-z][A-Za-z]*)?/gu;
  for (const match of text.matchAll(run)) {
    const family = match[3];
    if (family !== undefined) {
      for (const key of FAMILIES[family]) found.push(`${match[1]}${key}`);
    } else {
      found.push(`${match[1]}${match[4] ?? ""}`);
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
    const code = keyCode(match[1].toUpperCase());
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
    chords: ["⌥↑", "⌥↓", "⌘↑", "⌘↓"],
    file: COMPOSER_KEYMAP,
    reads: "(event.altKey || event.metaKey)",
  },
  {
    chords: ["⇧Return"],
    file: COMPOSER_KEYMAP,
    reads: "resolveEnterAction(config, isNumpad, event.shiftKey)",
  },
  {
    chords: ["⇧Tab"],
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
    expect(chordsIn("Press ⌃⌘/, or ⌘, and then ⇧Return.")).toEqual(["⌃⌘/", "⌘,", "⇧Return"]);
    expect(chordsIn("⌥⌘ with an arrow key")).toEqual(["⌥⌘←", "⌥⌘→", "⌥⌘↑", "⌥⌘↓"]);
    expect(chordsIn("⌘-click")).toEqual(["⌘-click"]);
    expect(slashCommandsIn("`/` then `/cd <path>` or `/tugplug:brief`, not `/usr/bin`.")).toEqual([
      "cd",
      "tugplug:brief",
    ]);

    const chords = documents.flatMap(({ text }) => chordsIn(text));
    expect(chords).toEqual(expect.arrayContaining(["⌘N", "⌃⌘L", "⌥⌘[", "⌘+", "⌘−"]));
    const commands = documents.flatMap(({ text }) => slashCommandsIn(text));
    expect(commands).toEqual(expect.arrayContaining(["arc", "commit", "tugplug:brief", "cd"]));
  });

  test("the sources are read, so an unbound chord is refused", () => {
    const known = knownChords();
    expect(known.has(readWrittenChord("⌘N") ?? "")).toBe(true);
    expect(known.has(readWrittenChord("⌃⌘L") ?? "")).toBe(true);
    expect(known.has(readWrittenChord("⌘S") ?? "")).toBe(true);
    expect(known.has(readWrittenChord("⌃⌥⇧⌘Z") ?? "")).toBe(false);
    expect(readWrittenChord("⌘-click")).toBeNull();
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
