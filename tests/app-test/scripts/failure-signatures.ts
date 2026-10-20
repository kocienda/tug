/**
 * failure-signatures.ts — group an app-test run's reds by what they say.
 *
 *   bun scripts/failure-signatures.ts <report.json>… [--json] [--min <n>]
 *
 * Reads the document `TUG_APPTEST_JSON=<path>` writes and prints every red
 * file grouped by the signature of its failures, biggest cluster first: a
 * run of five hundred files reds by cause, and a cause shows as many files
 * failing the same way. A file that stalled or errored with no failure of its
 * own groups by its status.
 *
 * Several reports read as one run: a corpus run in batches, each batch its own
 * invocation and its own document, groups across all of them.
 *
 * The signature of a failure is its error's first line with the parts that
 * vary from file to file blanked — numbers, quoted literals — plus, for a
 * timeout, the cause the harness named (`_harness/timeout-cause.ts`) and the
 * most telling selector token in the script it waited on. A file's
 * signature is its first failure's: the first failure is usually the cause
 * and the rest its consequences.
 *
 * Each file in a cluster carries its history from the report — `green@<sha>`
 * when it was green before, `red×N` when it has been red for the last N
 * recorded runs — so a cluster of files that were already red reads as the
 * old news it is.
 */

import { readFileSync } from "node:fs";

/** One failure as the report records it. */
export interface ReportFailure {
  readonly title: string;
  readonly message: string;
  readonly location?: string;
}

/** One file as the report records it. */
export interface ReportFile {
  readonly file: string;
  readonly status: string;
  readonly seconds?: number;
  readonly failures?: readonly ReportFailure[];
  /** `apptest_ledger.rs`'s `History`: `last-green` (`sha`), `red-streak` (`count`, `lastGreen`), `no-history`. */
  readonly history?: { answer?: string; sha?: string; count?: number; lastGreen?: { sha?: string } } & Record<string, unknown>;
}

/** A cluster: one signature and the files that fail with it. */
export interface Cluster {
  readonly signature: string;
  readonly files: Array<{ file: string; seconds: number; history: string; location: string; title: string }>;
  /** One failure's message, whole, as an example. */
  readonly example: string;
}

/** The first line of `message`, with what varies between files blanked. */
export function normalizeLine(message: string): string {
  const first = (message.split("\n").find((l) => l.trim() !== "") ?? "").trim();
  return first
    .replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g, "‹…›")
    .replace(/\b\d+(?:\.\d+)?(?:ms|s|px)?\b/g, "N")
    .replace(/\s+/g, " ");
}

/** The most telling selector token in a waited-on script: a testid, then a slot, then a class. */
export function selectorToken(message: string): string | null {
  const unescaped = message.replace(/\\+"/g, '"');
  const testid = /data-testid="([^"]+)"/.exec(unescaped);
  if (testid !== null) return `testid=${testid[1]}`;
  const slot = /data-slot="([^"]+)"/.exec(unescaped);
  if (slot !== null) return `slot=${slot[1]}`;
  const cls = /\.([a-z][\w-]{3,})/.exec(unescaped);
  return cls === null ? null : `.${cls[1]}`;
}

/** The signature of one failure. */
export function signatureOf(failure: ReportFailure): string {
  const line = normalizeLine(failure.message);
  if (!/TimeoutError|exceeded/.test(failure.message)) return line;
  const body = /evaluated in the shell, but (?:card .* (?:is a body|are bodies)|the condition holds in card|.* matches only in card)/.test(failure.message)
    ? " [shell reach into a body]"
    : "";
  const token = selectorToken(failure.message);
  const head = line.replace(/ — evaluated in the shell.*$/, "");
  return `${head}${body}${token === null ? "" : ` @ ${token}`}`;
}

/** A file's history, in a few characters. */
export function historyTag(history: ReportFile["history"]): string {
  switch (history?.answer) {
    case "last-green":
      return `green@${history.sha ?? "?"}`;
    case "red-streak": {
      const before = history.lastGreen?.sha;
      return `red×${history.count ?? "?"}${before === undefined ? "" : `, green@${before}`}`;
    }
    default:
      return "no history";
  }
}

/** The reds of `files`, grouped, biggest cluster first. */
export function clustersOf(files: readonly ReportFile[]): Cluster[] {
  const byKey = new Map<string, Cluster>();
  for (const f of files) {
    if (f.status === "PASS" || f.status === "SKIP") continue;
    const first = f.failures?.[0];
    const signature = first === undefined ? `[${f.status}] no failure recorded` : signatureOf(first);
    let cluster = byKey.get(signature);
    if (cluster === undefined) {
      cluster = { signature, files: [], example: first?.message ?? f.status };
      byKey.set(signature, cluster);
    }
    cluster.files.push({
      file: f.file,
      seconds: f.seconds ?? 0,
      history: historyTag(f.history),
      location: first?.location ?? "",
      title: first?.title ?? "",
    });
  }
  return [...byKey.values()].sort((a, b) => b.files.length - a.files.length || a.signature.localeCompare(b.signature));
}

function main(argv: string[]): number {
  const minAt = argv.indexOf("--min");
  const paths = argv.filter((a, i) => !a.startsWith("--") && !(minAt !== -1 && i === minAt + 1));
  if (paths.length === 0 || argv.includes("--help")) {
    process.stdout.write("usage: bun scripts/failure-signatures.ts <report.json>… [--json] [--min <n>]\n");
    return paths.length === 0 ? 2 : 0;
  }
  const min = minAt === -1 ? 1 : Number(argv[minAt + 1] ?? "1");
  const files = paths.flatMap((p) => (JSON.parse(readFileSync(p, "utf8")) as { files: ReportFile[] }).files);
  const clusters = clustersOf(files).filter((c) => c.files.length >= min);
  if (argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(clusters, null, 2)}\n`);
    return 0;
  }
  const reds = clusters.reduce((n, c) => n + c.files.length, 0);
  process.stdout.write(`${reds} red file(s) in ${clusters.length} signature(s), of ${files.length} run\n\n`);
  clusters.forEach((c, i) => {
    process.stdout.write(`#${i + 1}  ${c.files.length} file(s)  ${c.signature}\n`);
    for (const f of c.files) {
      // A harness frame (`rpc.ts:296`) says where it threw, not which test: lead with the file.
      const where = f.location.startsWith(f.file) ? f.location : f.location === "" ? f.file : `${f.file} (${f.location})`;
      process.stdout.write(`      ${where}  (${f.seconds}s, ${f.history})\n`);
    }
    process.stdout.write("\n");
  });
  return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
