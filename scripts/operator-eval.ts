#!/usr/bin/env bun
/**
 * operator-eval — does the Operator find what a question rests on?
 *
 * Each question in `tests/operator-eval/questions.json` names the one help
 * anchor its answer must rest on. This asks every question through the real
 * pipeline, `tugcast operator-ask`, and counts the answers whose kept refs cite
 * that anchor, so an improvement to retrieval is a score rather than an
 * impression.
 *
 * Each question in `tests/operator-eval/history-questions.json` names instead the
 * session or document its answer must cite, from a fixture of recorded transcripts
 * and briefs in `tests/operator-eval/history/`. The two halves score apart, on
 * indexes of their own, so a help score is never read through history.
 *
 * A citation can survive a poor search, because the model reads on until it finds
 * the passage, and it can name a heading it never read. So beside the score the
 * run reports how many questions had the passage returned by a verb, and how many
 * verbs an answer took, which is where a better search shows first.
 *
 * Every help question gets its own fresh ledger: a question about the app must not
 * lean on what any session happens to hold. The history questions share one, since
 * the fixture is what they ask about. Redirecting every ledger the command might
 * touch keeps the run off the machine's own.
 *
 * A miss is a reading, not a failure, so a run that asked everything exits 0
 * whatever it scored. A question that got no answer at all exits 1, because that
 * score measures the machine rather than the Operator.
 *
 * The run spends real model turns, which is why it stays out of `just ci`.
 *
 *   just operator-eval
 *   just operator-eval --only arc     # the questions containing "arc"
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { encodeProjectDir } from "../tugproto/src/claude-home";

const ROOT = resolve(import.meta.dir, "..");
const QUESTIONS = join(ROOT, "tests/operator-eval/questions.json");
const HISTORY_QUESTIONS = join(ROOT, "tests/operator-eval/history-questions.json");
const HISTORY = join(ROOT, "tests/operator-eval/history");
const TUGCAST = join(ROOT, "tugrust/target/debug/tugcast");
const LABEL = "operator-eval";

/** Three at once: each is up to two `claude` workers, and they mostly wait. */
const CONCURRENCY = 3;
/** Past this a question has hung rather than thought. */
const QUESTION_TIMEOUT_MS = 240_000;

/** A ref an answer has to cite. */
export interface Expected {
  kind: string;
  target: string;
}

interface Question {
  question: string;
  anchor?: string;
  expect?: Expected;
}

interface Result extends Question {
  status: "cited" | "missed" | "error";
  cited: string[];
  retrieved: boolean;
  search: string;
  verbs: string[];
  secs: number;
  transcript: string;
}

const workspaceTugtool = join(ROOT, "tugrust/target/debug/tugtool");
const TUGTOOL = existsSync(workspaceTugtool) ? workspaceTugtool : Bun.which("tugtool");

/** One question's move on the block's panel: `tugtool report unit <args>`. */
function report(...args: string[]): void {
  if (TUGTOOL) Bun.spawnSync([TUGTOOL, "report", "unit", ...args], { stdout: "ignore", stderr: "ignore" });
}

/** The refs under the `REFS:` heading, which are the ones the card would keep. */
export function citedRefs(output: string): Expected[] {
  const start = output.lastIndexOf("\nREFS:\n");
  if (start < 0) return [];
  const refs: Expected[] = [];
  for (const line of output.slice(start + "\nREFS:\n".length).split("\n")) {
    const match = /^ {2}(\S+) (.+)$/.exec(line);
    if (!match) break;
    refs.push({ kind: match[1], target: match[2] });
  }
  return refs;
}

/** The help refs among them. */
export function citedAnchors(output: string): string[] {
  return citedRefs(output)
    .filter((ref) => ref.kind === "help")
    .map((ref) => ref.target);
}

/** A file ref with the line it opens at dropped, since the file is what was asked for. */
function withoutLine(ref: Expected): string {
  return ref.kind === "file" ? ref.target.replace(/:\d+(-\d+)?$/, "") : ref.target;
}

/** Whether an answer's refs hold the one it had to cite. */
export function citesExpected(refs: Expected[], expected: Expected): boolean {
  return refs.some((ref) => ref.kind === expected.kind && withoutLine(ref) === withoutLine(expected));
}

/**
 * The passages a verb returned, read from the JSON `--show-rounds` prints under
 * each round. A whole document counts as every passage in it, spelled `<doc>#*`.
 */
export function retrievedAnchors(output: string): string[] {
  const end = output.indexOf("\nANSWER:\n");
  const found: string[] = [];
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) return value.forEach(walk);
    if (typeof value !== "object" || value === null) return;
    const row = value as Record<string, unknown>;
    if (typeof row.doc === "string" && typeof row.text === "string") {
      found.push(`${row.doc}#${typeof row.anchor === "string" ? row.anchor : "*"}`);
    }
    Object.values(row).forEach(walk);
  };
  for (const block of (end < 0 ? output : output.slice(0, end)).split(/^ {2}round \d+: .*$/m).slice(1)) {
    const start = block.indexOf("\n{");
    if (start < 0) continue;
    try {
      walk(JSON.parse(block.slice(start, block.lastIndexOf("}") + 1)));
    } catch {
      // A round line with no JSON under it is a verb that errored.
    }
  }
  return found;
}

/** Each verb the rounds chose, with its arguments, as the observer printed it. */
export function verbsChosen(output: string): string[] {
  const verbs: string[] = [];
  for (const line of output.split("\n")) {
    const match = /^ {2}round \d+: (.+?) → /.exec(line);
    if (match) verbs.push(match[1]);
  }
  return verbs;
}

/** The files one question runs against. */
interface Ledgers {
  db: string;
  project: string;
  sessionIndexDb: string;
  reportGapsDb: string;
  semanticDb: string;
  claudeHome?: string;
  indexHistory?: boolean;
}

/** A fresh ledger of a question's own, beside the run's one help index. */
function helpLedgers(dir: string, runDir: string): Ledgers {
  const project = join(dir, "project");
  mkdirSync(project);
  return {
    db: join(dir, "sessions.db"),
    project,
    sessionIndexDb: join(dir, "session_index.db"),
    reportGapsDb: join(dir, "report_gaps.db"),
    semanticDb: join(runDir, "semantic.db"),
  };
}

/**
 * The history fixture, placed once: the briefs in a project, and each transcript under
 * a Claude home of its own at the directory Claude Code would have written it to. The
 * project is spelled as its real path, which is what a transcript's `cwd` would carry.
 */
export function placeHistory(source: string, runDir: string): Ledgers {
  const root = join(runDir, "history");
  const project = join(root, "project");
  mkdirSync(project, { recursive: true });
  cpSync(join(source, "briefs"), join(project, "briefs"), { recursive: true });
  const realProject = realpathSync(project);
  const claudeHome = join(root, "claude");
  const sessions = join(claudeHome, "projects", encodeProjectDir(realProject));
  mkdirSync(sessions, { recursive: true });
  for (const name of readdirSync(join(source, "transcripts"))) {
    const text = readFileSync(join(source, "transcripts", name), "utf8");
    writeFileSync(join(sessions, name), text.replaceAll("{{PROJECT}}", realProject));
  }
  return {
    db: join(root, "sessions.db"),
    project: realProject,
    sessionIndexDb: join(root, "session_index.db"),
    reportGapsDb: join(root, "report_gaps.db"),
    semanticDb: join(root, "semantic.db"),
    claudeHome,
  };
}

/** What the question had to cite, for a reader. */
function expectedLabel(item: Question): string {
  return item.expect ? `${item.expect.kind} ${item.expect.target}` : (item.anchor ?? "");
}

async function ask(item: Question, dir: string, ledgers: Ledgers): Promise<Result> {
  const transcript = join(dir, "output.txt");
  const started = Date.now();
  const proc = Bun.spawn(
    [
      TUGCAST,
      "operator-ask",
      item.question,
      "--db",
      ledgers.db,
      "--project-dir",
      ledgers.project,
      "--session-index-db",
      ledgers.sessionIndexDb,
      "--docs-dir",
      join(ROOT, "docs"),
      "--semantic-db",
      ledgers.semanticDb,
      ...(ledgers.claudeHome ? ["--claude-home", ledgers.claudeHome] : []),
      ...(ledgers.indexHistory ? ["--index-history"] : []),
      "--show-rounds",
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
      timeout: QUESTION_TIMEOUT_MS,
      env: {
        ...process.env,
        TUG_SESSION_INDEX_DB: ledgers.sessionIndexDb,
        TUG_REPORT_GAPS_DB: ledgers.reportGapsDb,
      },
    },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  writeFileSync(transcript, `${stdout}\n--- stderr, exit ${code} ---\n${stderr}`);
  const refs = citedRefs(stdout);
  const answerAt = stdout.indexOf("\nANSWER:\n");
  const rounds = answerAt < 0 ? stdout : stdout.slice(0, answerAt);
  const found = item.expect
    ? citesExpected(refs, item.expect)
    : refs.some((ref) => ref.kind === "help" && ref.target === item.anchor);
  const anchors = retrievedAnchors(stdout);
  return {
    ...item,
    status: code !== 0 ? "error" : found ? "cited" : "missed",
    cited: refs.filter((ref) => item.expect || ref.kind === "help").map((ref) => (item.expect ? `${ref.kind} ${ref.target}` : ref.target)),
    retrieved: item.expect
      ? rounds.includes(withoutLine(item.expect))
      : anchors.includes(item.anchor ?? "") || anchors.includes(`${(item.anchor ?? "").split("#")[0]}#*`),
    search: /^search: (.*)$/m.exec(stdout)?.[1] ?? "unknown",
    verbs: verbsChosen(stdout),
    secs: (Date.now() - started) / 1000,
    transcript,
  };
}

/** Ask one half's questions, the first alone since it is what builds the half's index. */
async function askAll(
  questions: Question[],
  runDir: string,
  name: string,
  ledgersFor: (dir: string, first: boolean) => Ledgers,
): Promise<Result[]> {
  const results: Result[] = new Array(questions.length);
  let next = 0;
  const worker = async (alone = false) => {
    while (next < questions.length) {
      const index = next++;
      const item = questions[index];
      report("start", LABEL, item.question);
      const dir = join(runDir, `${name}${String(index + 1).padStart(2, "0")}`);
      mkdirSync(dir);
      const result = await ask(item, dir, ledgersFor(dir, index === 0));
      results[index] = result;
      const line = `${String(index + 1).padStart(2)}/${questions.length} ${result.status.padEnd(6)} ${result.retrieved ? "read " : "unread"} ${String(result.verbs.length).padStart(2)} verbs ${result.secs.toFixed(0).padStart(4)}s  ${item.question}`;
      console.log(line);
      if (result.status === "cited") {
        report("done", LABEL, item.question, "pass");
      } else {
        const title = `expected ${expectedLabel(item)}`;
        const message = result.cited.length ? `cited ${result.cited.join(", ")}` : "cited nothing it had to";
        report("done", LABEL, item.question, result.status === "error" ? "error" : "fail", "--title", title, "--message", message);
      }
      if (alone) return;
    }
  };
  // A writer beside the first question would find the index locked, and the rest only
  // read it.
  await worker(true);
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  return results;
}

/** What a half scored, as its misses and its verdict line. */
function verdictOf(results: Result[], what: string): string {
  const scored = results.filter((r) => r.status === "cited").length;
  const errors = results.filter((r) => r.status === "error").length;
  const retrieved = results.filter((r) => r.retrieved).length;
  const verbs = results.reduce((sum, r) => sum + r.verbs.length, 0) / Math.max(results.length, 1);
  return `operator-eval: ${what.replace("{}", `${scored}/${results.length}`)}, ${retrieved}/${results.length} had it returned by a verb, ${verbs.toFixed(1)} verbs an answer${errors ? `, ${errors} got no answer` : ""}`;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const onlyAt = argv.indexOf("--only");
  const only = onlyAt >= 0 ? argv[onlyAt + 1]?.toLowerCase() : undefined;
  if (onlyAt >= 0 && !only) {
    console.error("operator-eval: --only needs some text to match");
    return 2;
  }
  if (!existsSync(TUGCAST)) {
    console.error(`operator-eval: no ${TUGCAST}; run it through \`just operator-eval\`, which builds it`);
    return 2;
  }

  const narrowed = (all: Question[]) => (only ? all.filter((item) => item.question.toLowerCase().includes(only)) : all);
  const help = narrowed(await Bun.file(QUESTIONS).json());
  const history = narrowed(await Bun.file(HISTORY_QUESTIONS).json());
  const runDir = mkdtempSync(join(tmpdir(), "operator-eval-"));
  const names = [...help, ...history].map((item) => item.question);
  report("plan", LABEL, "--unit", "question", "--of", ...names);

  const helpResults = help.length ? await askAll(help, runDir, "help-", (dir) => helpLedgers(dir, runDir)) : [];
  const placed = history.length ? placeHistory(HISTORY, runDir) : undefined;
  const historyResults = placed
    ? await askAll(history, runDir, "history-", (_dir, first) => ({ ...placed, indexHistory: first }))
    : [];

  const results = [...helpResults, ...historyResults];
  const failed = results.filter((r) => r.status !== "cited");
  const errors = results.filter((r) => r.status === "error").length;
  writeFileSync(join(runDir, "results.json"), `${JSON.stringify(results, null, 2)}\n`);

  const unread = results.filter((r) => r.status === "cited" && !r.retrieved);
  if (failed.length + unread.length > 0) console.log("\nMisses, and citations of a passage no verb returned:");
  for (const r of [...failed, ...unread]) {
    console.log(`\n  ${r.question}`);
    console.log(`    expected: ${expectedLabel(r)}`);
    console.log(`    cited:    ${r.cited.length ? r.cited.join(", ") : "nothing it had to"}${r.status === "error" ? " (no answer)" : ""}`);
    console.log(`    verbs:    ${r.verbs.length ? r.verbs.join("; ") : "none"}`);
    console.log(`    output:   ${r.transcript}`);
  }

  const verdicts: string[] = [];
  if (help.length) verdicts.push(verdictOf(helpResults, "{} answers cited the expected passage"));
  if (history.length) verdicts.push(verdictOf(historyResults, "history {} answers cited the expected ref"));
  const verdict = verdicts.join("\n");
  report("finish", LABEL, verdict);
  console.log(`\nEvery answer and results.json: ${runDir}`);
  const searches = [...new Set(results.map((r) => r.search))];
  console.log(`Search measured: ${searches.join("; ")}`);
  console.log(verdict);
  return errors > 0 ? 1 : 0;
}

if (import.meta.main) process.exit(await main());
