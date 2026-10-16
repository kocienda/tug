/**
 * card-dom-census.ts — every app-test call that reaches into a card's DOM
 * through the shell's page.
 *
 *   bun scripts/card-dom-census.ts                 # per file: line, verb, card, kind
 *   bun scripts/card-dom-census.ts --json          # the entries as JSON
 *   bun scripts/card-dom-census.ts --kind <id>     # only entries of one kind
 *   bun scripts/card-dom-census.ts --check         # exit 1 on an entry card-dom-allow.json does not allow
 *   bun scripts/card-dom-census.ts --seed          # print the allow-list today's entries need
 *
 * A card that is a body keeps its DOM in its own page, and `App.body(cardId)`
 * is the only way a test reaches it. An entry is a call to a page-evaluating
 * verb (`evalJS`, `waitForCondition`, `getElementScreenBounds`,
 * `getElementState`, `getComputedStyleValue`, `getSelection`, `screenshot`)
 * whose text holds a card selector, on a receiver that is not a body. The
 * allow-list names the `{file, kind}` pairs not yet migrated: a file moves
 * with the kind whose card it reaches, so its pair leaves the list in that
 * kind's change, and the list is empty once every kind is a body.
 * A call that reads the shell's page on purpose — to show the shell's
 * document did not take what a body did — says so with a `card-dom: shell`
 * comment on its line or the line above, and is not an entry.
 *
 * The scan itself is `card-dom.ts`. `just app-test-body-scope-check` runs
 * `--check`.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { CARD_KINDS } from "../body-grounding/_kinds";
import {
  censusOfSource,
  importedBindings,
  pairsOf,
  stalePairs,
  unallowed,
  type AllowedPair,
  type CensusEntry,
  type CensusVocabulary,
} from "./card-dom";

export const APP_TEST_DIR = resolve(import.meta.dir, "..");
export const ALLOW_PATH = join(import.meta.dir, "card-dom-allow.json");

const HELP = `card-dom-census — app-test calls that reach a card's DOM through the shell

usage: bun scripts/card-dom-census.ts [--json] [--kind <componentId>] [--check] [--seed]

  --json        print the entries as JSON
  --kind <id>   only entries whose card is of this kind
  --check       exit 1 when an entry's {file, kind} is not in scripts/card-dom-allow.json
  --seed        print the allow-list that covers every entry today
  --help        this text
`;

/** The app-test files the corpus runs: top level, `harness-smoke/`, `body-grounding/`. */
export function corpusFiles(dir = APP_TEST_DIR): string[] {
  const at = (sub: string): string[] =>
    readdirSync(join(dir, sub))
      .filter((n) => n.endsWith(".test.ts"))
      .sort()
      .map((n) => (sub === "." ? n : `${sub}/${n}`));
  return [...at("harness-smoke"), ...at("."), ...at("body-grounding")];
}

/** The selectors `_harness/transcript.ts` exports as string constants, by name and by value. */
function transcriptSelectors(dir: string): string[] {
  const src = readFileSync(join(dir, "_harness/transcript.ts"), "utf8");
  const out: string[] = [];
  for (const m of src.matchAll(/^export const ([A-Z_][A-Z0-9_]*)\s*=\s*(["'])([^"']+)\2/gm)) out.push(m[1], m[3]);
  return out;
}

export function vocabulary(dir = APP_TEST_DIR): CensusVocabulary {
  return {
    kindRoots: CARD_KINDS.flatMap((k) => k.marks.map((root) => ({ componentId: k.componentId, root }))),
    extraSelectors: transcriptSelectors(dir),
    coversKinds: COVERS_KINDS,
  };
}

/**
 * A file whose cards name no kind of their own (a card opened by a chord, a
 * deck shape the file does not spell) takes the kind of the surface it
 * covers. First match wins, so the narrower fragments come first.
 */
const COVERS_KINDS: ReadonlyArray<readonly [string, string]> = [
  ["components/overview/", "overview"],
  ["components/jots/", "jots"],
  ["components/arcs/", "dashes"],
  ["components/cards/", "cards"],
  ["components/layout/", "layout"],
  ["components/devtools/", "devtools"],
  ["cards/text-card", "text"],
  ["cards/file-view-card", "file-view"],
  ["cards/diff-card", "diff"],
  ["cards/commit-card", "commit"],
  ["cards/settings-", "settings"],
  ["cards/keyboard-card", "keyboard"],
  ["cards/about-card", "about"],
  ["cards/hello-world-card", "hello"],
  ["cards/session-card", "session"],
  ["tug-prompt-entry", "session"],
];

/** The bindings `file` imports from the corpus's own modules. */
export function fileContext(dir: string, file: string, src: string): { imported: Map<string, string> } {
  const from = dirname(join(dir, file));
  const read = (specifier: string): string | null => {
    const base = resolve(from, specifier);
    for (const path of [base, `${base}.ts`, join(base, "index.ts")]) {
      if (path.endsWith(".ts") && existsSync(path)) return readFileSync(path, "utf8");
    }
    return null;
  };
  return { imported: importedBindings(src, read) };
}

/** Every entry across the corpus. */
export function census(dir = APP_TEST_DIR): CensusEntry[] {
  const vocab = vocabulary(dir);
  return corpusFiles(dir).flatMap((file) => {
    const src = readFileSync(join(dir, file), "utf8");
    return censusOfSource(file, src, vocab, fileContext(dir, file, src));
  });
}

export function readAllowList(path = ALLOW_PATH): AllowedPair[] {
  return JSON.parse(readFileSync(path, "utf8")) as AllowedPair[];
}

function printEntries(entries: readonly CensusEntry[]): void {
  let file = "";
  for (const e of entries) {
    if (e.file !== file) {
      file = e.file;
      console.log(file);
    }
    const card = e.cardId === null ? "" : ` card ${e.cardId}`;
    console.log(`  ${String(e.line).padStart(5)}  ${e.receiver}.${e.method}${card}  [${e.kind}]  ${e.selectors.join(" ")}`);
  }
  const files = new Set(entries.map((e) => e.file)).size;
  console.log(`${entries.length} entr${entries.length === 1 ? "y" : "ies"} in ${files} file${files === 1 ? "" : "s"}`);
}

function main(argv: string[]): number {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(HELP);
    return 0;
  }
  const kindAt = argv.indexOf("--kind");
  const kind = kindAt === -1 ? null : argv[kindAt + 1];
  if (kindAt !== -1 && (kind === null || kind === undefined || kind.startsWith("--"))) {
    process.stderr.write("--kind needs a componentId\n");
    return 2;
  }
  const all = census();
  const entries = kind === null ? all : all.filter((e) => e.kind === kind);
  if (argv.includes("--seed")) {
    console.log(JSON.stringify(pairsOf(all), null, 2));
    return 0;
  }
  if (argv.includes("--check")) {
    const allowed = readAllowList();
    const outside = unallowed(entries, allowed);
    const stale = stalePairs(all, allowed);
    for (const p of stale) console.log(`note: ${p.file} [${p.kind}] is allowed and no longer reaches a card; remove it from card-dom-allow.json`);
    if (outside.length > 0) {
      console.log("These calls reach a card's DOM through the shell; reach it with app.body(cardId):");
      printEntries(outside);
      return 1;
    }
    console.log(`card-dom census: ${entries.length} entries, all allowed (${allowed.length} file/kind pairs not yet migrated)`);
    return 0;
  }
  if (argv.includes("--json")) {
    console.log(JSON.stringify(entries.map(({ file, line, method, receiver, cardId, kind: k, selectors }) => ({ file, line, method, receiver, cardId, kind: k, selectors })), null, 2));
    return 0;
  }
  printEntries(entries);
  return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
