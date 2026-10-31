#!/usr/bin/env bun
/**
 * operator-eval — does the Operator find the help passage a question rests on?
 *
 * Each question in `tests/operator-eval/questions.json` names the one help
 * anchor its answer must rest on. This asks every question through the real
 * pipeline, `tugcast operator-ask`, and counts the answers whose kept refs cite
 * that anchor, so an improvement to retrieval is a score rather than an
 * impression.
 *
 * A citation can survive a poor search, because the model reads on until it finds
 * the passage, and it can name a heading it never read. So beside the score the
 * run reports how many questions had the passage returned by a verb, and how many
 * verbs an answer took, which is where a better search shows first.
 *
 * Every question gets its own fresh ledger: a question about the app must not
 * lean on what any session happens to hold, and redirecting every ledger the
 * command might touch keeps the run off the machine's own.
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
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const QUESTIONS = join(ROOT, "tests/operator-eval/questions.json");
const TUGCAST = join(ROOT, "tugrust/target/debug/tugcast");
const LABEL = "operator-eval";

/** Three at once: each is up to two `claude` workers, and they mostly wait. */
const CONCURRENCY = 3;
/** Past this a question has hung rather than thought. */
const QUESTION_TIMEOUT_MS = 240_000;

interface Question {
  question: string;
  anchor: string;
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

/** The help refs under the `REFS:` heading, which are the ones the card would keep. */
export function citedAnchors(output: string): string[] {
  const start = output.lastIndexOf("\nREFS:\n");
  if (start < 0) return [];
  const anchors: string[] = [];
  for (const line of output.slice(start + "\nREFS:\n".length).split("\n")) {
    const match = /^ {2}(\S+) (.+)$/.exec(line);
    if (!match) break;
    if (match[1] === "help") anchors.push(match[2]);
  }
  return anchors;
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

async function ask(item: Question, index: number, runDir: string): Promise<Result> {
  const dir = join(runDir, String(index + 1).padStart(2, "0"));
  mkdirSync(dir);
  const project = join(dir, "project");
  mkdirSync(project);
  const transcript = join(dir, "output.txt");
  const started = Date.now();
  const proc = Bun.spawn(
    [
      TUGCAST,
      "operator-ask",
      item.question,
      "--db",
      join(dir, "sessions.db"),
      "--project-dir",
      project,
      "--session-index-db",
      join(dir, "session_index.db"),
      "--docs-dir",
      join(ROOT, "docs"),
      "--semantic-db",
      join(runDir, "semantic.db"),
      "--show-rounds",
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
      timeout: QUESTION_TIMEOUT_MS,
      env: {
        ...process.env,
        TUG_SESSION_INDEX_DB: join(dir, "session_index.db"),
        TUG_REPORT_GAPS_DB: join(dir, "report_gaps.db"),
      },
    },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  writeFileSync(transcript, `${stdout}\n--- stderr, exit ${code} ---\n${stderr}`);
  const cited = citedAnchors(stdout);
  const retrieved = retrievedAnchors(stdout);
  return {
    ...item,
    status: code !== 0 ? "error" : cited.includes(item.anchor) ? "cited" : "missed",
    cited,
    retrieved: retrieved.includes(item.anchor) || retrieved.includes(`${item.anchor.split("#")[0]}#*`),
    search: /^search: (.*)$/m.exec(stdout)?.[1] ?? "unknown",
    verbs: verbsChosen(stdout),
    secs: (Date.now() - started) / 1000,
    transcript,
  };
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

  const all: Question[] = await Bun.file(QUESTIONS).json();
  const questions = only ? all.filter((item) => item.question.toLowerCase().includes(only)) : all;
  const runDir = mkdtempSync(join(tmpdir(), "operator-eval-"));
  const names = questions.map((item) => item.question);
  report("plan", LABEL, "--unit", "question", "--of", ...names);

  const results: Result[] = new Array(questions.length);
  let next = 0;
  const worker = async (alone = false) => {
    while (next < questions.length) {
      const index = next++;
      const item = questions[index];
      report("start", LABEL, item.question);
      const result = await ask(item, index, runDir);
      results[index] = result;
      const line = `${String(index + 1).padStart(2)}/${questions.length} ${result.status.padEnd(6)} ${result.retrieved ? "read " : "unread"} ${String(result.verbs.length).padStart(2)} verbs ${result.secs.toFixed(0).padStart(4)}s  ${item.question}`;
      console.log(line);
      if (result.status === "cited") {
        report("done", LABEL, item.question, "pass");
      } else {
        const title = `expected ${item.anchor}`;
        const message = result.cited.length ? `cited ${result.cited.join(", ")}` : "cited no help passage";
        report("done", LABEL, item.question, result.status === "error" ? "error" : "fail", "--title", title, "--message", message);
      }
      if (alone) return;
    }
  };
  // The first question builds the run's one index, which a writer beside it would
  // find locked, and the rest only read it.
  await worker(true);
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  const scored = results.filter((r) => r.status === "cited").length;
  const failed = results.filter((r) => r.status !== "cited");
  const errors = results.filter((r) => r.status === "error").length;
  const retrieved = results.filter((r) => r.retrieved).length;
  const verbs = results.reduce((sum, r) => sum + r.verbs.length, 0) / Math.max(results.length, 1);
  writeFileSync(join(runDir, "results.json"), `${JSON.stringify(results, null, 2)}\n`);

  const unread = results.filter((r) => r.status === "cited" && !r.retrieved);
  if (failed.length + unread.length > 0) console.log("\nMisses, and citations of a passage no verb returned:");
  for (const r of [...failed, ...unread]) {
    console.log(`\n  ${r.question}`);
    console.log(`    expected: ${r.anchor}`);
    console.log(`    cited:    ${r.cited.length ? r.cited.join(", ") : "no help passage"}${r.status === "error" ? " (no answer)" : ""}`);
    console.log(`    verbs:    ${r.verbs.length ? r.verbs.join("; ") : "none"}`);
    console.log(`    output:   ${r.transcript}`);
  }

  const verdict = `operator-eval: ${scored}/${results.length} answers cited the expected passage, ${retrieved}/${results.length} had it returned by a verb, ${verbs.toFixed(1)} verbs an answer${errors ? `, ${errors} got no answer` : ""}`;
  report("finish", LABEL, verdict);
  console.log(`\nEvery answer and results.json: ${runDir}`);
  const searches = [...new Set(results.map((r) => r.search))];
  console.log(`Search measured: ${searches.join("; ")}`);
  console.log(verdict);
  return errors > 0 ? 1 : 0;
}

if (import.meta.main) process.exit(await main());
