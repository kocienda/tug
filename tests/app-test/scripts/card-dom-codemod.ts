/**
 * card-dom-codemod.ts — move the provable card-DOM reaches onto the card's body.
 *
 *   bun scripts/card-dom-codemod.ts [--kind <id>] [--write] [<file>...]
 *
 * For each census entry (`card-dom-census.ts`) of the given kind in the given
 * files (default: every file), it rewrites `app.<verb>(<expr>, …)` to
 * `app.body(<id>).<verb>(<expr>, …)` when the shape proves it right: every
 * card selector in `<expr>` names one card, that card's id is a string
 * literal or a `const` bound to one in the file, `<expr>` reads nothing from
 * the shell's deck (`window.__tug`, `window.tugdeck`), and the receiver is a
 * plain name. Every other entry is reported `manual`, with the reason, and
 * left as it is — a mixed expression is split by hand into its shell half
 * and its body half.
 *
 * Without `--write` it prints what it would do and changes nothing. Run it
 * with `--write` under `tugtool file run`, which receipts the files it moves.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { censusOfSource, rewriteSource, type CensusEntry } from "./card-dom";
import { APP_TEST_DIR, corpusFiles, fileContext, vocabulary } from "./card-dom-census";

const HELP = `card-dom-codemod — rewrite provable card-DOM reaches onto app.body(<id>)

usage: bun scripts/card-dom-codemod.ts [--kind <componentId>] [--into <name>] [--write] [<file>...]

  --kind <id>   only entries whose card is of this kind
  --into <name> move a reach that names no card onto the body handle <name> (a card the file opens, not seeds)
  --into-kind   move a reach that names no card, of a known kind, onto kindBody(<receiver>, "<kind>") and import it
  --write       write the rewritten files (default: print and change nothing)
  <file>...     app-test files, relative to tests/app-test (default: the whole corpus)
  --help        this text
`;

/** `src` importing `kindBody` from the harness when it calls it and does not yet. */
function withKindBodyImport(file: string, src: string): string {
  if (!/\bkindBody\(/.test(src) || /\bimport\s*\{[^}]*\bkindBody\b[^}]*\}\s*from/.test(src)) return src;
  const depth = file.split("/").length - 1;
  const specifier = `${depth === 0 ? "./" : "../".repeat(depth)}_harness/card-reach`;
  const existing = new RegExp(`^import \\{([^}]*)\\} from "${specifier.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}";$`, "m");
  const m = existing.exec(src);
  if (m !== null) {
    const names = m[1].split(",").map((s) => s.trim()).filter((s) => s.length > 0);
    names.push("kindBody");
    return src.replace(m[0], `import { ${[...new Set(names)].sort().join(", ")} } from "${specifier}";`);
  }
  const imports = [...src.matchAll(/^import [^;]*;$/gm)];
  const last = imports[imports.length - 1];
  if (last === undefined) return `import { kindBody } from "${specifier}";\n\n${src}`;
  const at = (last.index ?? 0) + last[0].length;
  return `${src.slice(0, at)}\nimport { kindBody } from "${specifier}";${src.slice(at)}`;
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
  const write = argv.includes("--write");
  const intoAt = argv.indexOf("--into");
  const into = intoAt === -1 ? null : (argv[intoAt + 1] ?? null);
  const intoKind = argv.includes("--into-kind");
  const named = argv.filter((a, i) => !a.startsWith("--") && !(kindAt !== -1 && i === kindAt + 1) && !(intoAt !== -1 && i === intoAt + 1));
  const files = named.length > 0 ? named : corpusFiles();
  const vocab = vocabulary();
  let rewrote = 0;
  let manual = 0;
  for (const file of files) {
    const path = join(APP_TEST_DIR, file);
    const src = readFileSync(path, "utf8");
    const entries = censusOfSource(file, src, vocab, fileContext(APP_TEST_DIR, file, src)).filter((e) => kind === null || e.kind === kind);
    if (entries.length === 0) continue;
    const handle = intoKind
      ? (e: CensusEntry): string | null => (e.kind === "unknown" || e.cardIds.length > 0 ? null : `kindBody(${e.receiver}, ${JSON.stringify(e.kind)})`)
      : into;
    const result = rewriteSource(src, entries, handle);
    for (const e of result.rewritten) console.log(`rewrite  ${file}:${e.line}  ${e.cardIdSource === null ? (typeof handle === "function" ? handle(e) : handle) : `${e.receiver}.body(${e.cardIdSource})`}.${e.method}`);
    for (const { entry, reason } of result.manual) console.log(`manual   ${file}:${entry.line}  ${entry.receiver}.${entry.method} [${entry.kind}] — ${reason}`);
    rewrote += result.rewritten.length;
    manual += result.manual.length;
    if (write && result.rewritten.length > 0) writeFileSync(path, withKindBodyImport(file, result.source));
  }
  console.log(`${rewrote} rewritten${write ? "" : " (dry run)"}, ${manual} manual`);
  return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
