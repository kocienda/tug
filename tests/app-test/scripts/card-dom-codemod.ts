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

import { censusOfSource, rewriteSource } from "./card-dom";
import { APP_TEST_DIR, corpusFiles, fileContext, vocabulary } from "./card-dom-census";

const HELP = `card-dom-codemod — rewrite provable card-DOM reaches onto app.body(<id>)

usage: bun scripts/card-dom-codemod.ts [--kind <componentId>] [--into <name>] [--write] [<file>...]

  --kind <id>   only entries whose card is of this kind
  --into <name> move a reach that names no card onto the body handle <name> (a card the file opens, not seeds)
  --write       write the rewritten files (default: print and change nothing)
  <file>...     app-test files, relative to tests/app-test (default: the whole corpus)
  --help        this text
`;

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
    const result = rewriteSource(src, entries, into);
    for (const e of result.rewritten) console.log(`rewrite  ${file}:${e.line}  ${e.cardIdSource === null ? into : `${e.receiver}.body(${e.cardIdSource})`}.${e.method}`);
    for (const { entry, reason } of result.manual) console.log(`manual   ${file}:${entry.line}  ${entry.receiver}.${entry.method} [${entry.kind}] — ${reason}`);
    rewrote += result.rewritten.length;
    manual += result.manual.length;
    if (write && result.rewritten.length > 0) writeFileSync(path, result.source);
  }
  console.log(`${rewrote} rewritten${write ? "" : " (dry run)"}, ${manual} manual`);
  return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
