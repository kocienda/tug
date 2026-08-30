#!/usr/bin/env bun
/**
 * Apply the clippy suggestions that `cargo clippy --fix` refuses to, and print
 * the ones nobody should apply unattended.
 *
 * `cargo clippy --fix` applies only suggestions rustc marked
 * `MachineApplicable`. Everything else — `MaybeIncorrect`, `Unspecified`,
 * `HasPlaceholders` — survives every `--fix` pass forever, which is what makes
 * a lint like `ptr_arg` survive every repair pass forever. This pass reads the
 * same diagnostics out of `--message-format=json` and decides for itself.
 *
 * A lint earns a place in TRUSTED by two properties, both checked by hand
 * against clippy's real JSON output rather than assumed:
 *
 *   1. SELF-CONTAINED — the replacement is the whole repair. `large_enum_variant`
 *      rewrites a field to `Box<T>` and leaves every construction site of that
 *      variant unwritten, so it fails this and stays off the list.
 *   2. LOUD WHEN WRONG — if the suggestion is bad, the crate stops compiling.
 *      It can never compile and quietly mean something else.
 *      `empty_line_after_doc_comments` fails this: deleting the blank line under
 *      an orphaned doc comment silently reattaches that doc to whatever item
 *      follows, which builds clean and documents the wrong function.
 *
 * `HasPlaceholders` is never applied — the replacement text literally contains
 * `<item>` / `<stripped>` for a human to fill in.
 *
 * Everything not applied is printed with clippy's proposal spelled out, so a
 * red gate says what the tool wanted to do instead of only that it declined.
 *
 * Usage:
 *   bun scripts/clippy-repair.ts            apply, then report what it didn't
 *   bun scripts/clippy-repair.ts --quiet    apply, report nothing
 *   bun scripts/clippy-repair.ts --explain  apply nothing, report only
 */

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const REPO_ROOT = resolve(import.meta.dir, "..");
const CARGO_DIR = join(REPO_ROOT, "tugrust");
const MAX_PASSES = 4;

/**
 * Lints whose non-machine-applicable suggestion this pass applies anyway.
 * `help` (optional) selects one of a diagnostic's several suggestion children
 * by its help text; without it, every suggestion child of the lint qualifies.
 */
const TRUSTED: Map<string, { help?: RegExp }> = new Map([
  // `&Vec<T>` -> `&[T]`, `&String` -> `&str`. Clippy has already checked the
  // body uses nothing but slice/str methods, and a caller passing `&v` still
  // coerces. Wrong -> type error at the call site.
  ["clippy::ptr_arg", {}],
  // `&Box<T>` -> `&T`, same shape and same failure mode.
  ["clippy::borrowed_box", {}],
]);

type Span = {
  file_name: string;
  byte_start: number;
  byte_end: number;
  line_start: number;
  text: { text: string }[];
  suggested_replacement: string | null;
  suggestion_applicability: string | null;
};
type Child = { message: string; spans: Span[] };
type Diagnostic = {
  code: { code: string } | null;
  level: string;
  message: string;
  spans: Span[];
  children: Child[];
};

type Candidate = {
  lint: string;
  help: string;
  applicability: string;
  file: string;
  /** The line clippy flagged, which is not always the line it would rewrite. */
  line: number;
  context: string;
  spans: Span[];
  trusted: boolean;
  reason: string;
};

/** Run clippy over the workspace and return its diagnostics. */
function clippy(): { diagnostics: Diagnostic[]; hardErrors: Diagnostic[] } {
  const out = spawnSync(
    "cargo",
    ["clippy", "--quiet", "--workspace", "--all-targets", "--message-format=json"],
    { cwd: CARGO_DIR, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
  );
  if (out.error) {
    console.error(`clippy-repair: could not run cargo: ${out.error.message}`);
    process.exit(1);
  }
  const diagnostics: Diagnostic[] = [];
  for (const line of (out.stdout ?? "").split("\n")) {
    if (!line.startsWith("{")) continue;
    let record: { reason?: string; message?: Diagnostic };
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record.reason === "compiler-message" && record.message) {
      diagnostics.push(record.message);
    }
  }
  // A genuine compile error (`E0308`, or an error carrying no lint code at all)
  // means the tree does not build; rewriting spans off a broken parse is
  // meaningless, so the caller stops.
  const hardErrors = diagnostics.filter(
    (d) => d.level === "error" && (!d.code || /^E\d+$/.test(d.code.code)),
  );
  return { diagnostics, hardErrors };
}

/** Every suggestion clippy offered that `--fix` did not already apply. */
function candidates(diagnostics: Diagnostic[]): Candidate[] {
  const found: Candidate[] = [];
  const seen = new Set<string>();
  for (const d of diagnostics) {
    const lint = d.code?.code;
    if (!lint) continue;
    const trust = TRUSTED.get(lint);
    for (const child of d.children ?? []) {
      const spans = (child.spans ?? []).filter((s) => s.suggested_replacement !== null);
      if (spans.length === 0) continue;
      const applicability = spans[0].suggestion_applicability ?? "Unspecified";
      // `--fix` already handled these; seeing one means it could not be applied
      // (overlapping spans, a `--fix` bail-out), not that it needs deciding.
      if (applicability === "MachineApplicable") continue;

      const file = spans[0].file_name;
      const key = `${file}:${spans.map((s) => `${s.byte_start}-${s.byte_end}:${s.suggested_replacement}`).join(",")}`;
      if (seen.has(key)) continue; // lib and lib-test targets report the same span twice
      seen.add(key);

      let trusted = trust !== undefined;
      let reason = trusted ? "" : `${lint} is not on the trusted list`;
      if (trusted && trust!.help && !trust!.help.test(child.message)) {
        trusted = false;
        reason = `${lint}: this is not the suggestion the trusted list names`;
      }
      if (trusted && applicability === "HasPlaceholders") {
        trusted = false;
        reason = "the replacement text has placeholders for a human to fill in";
      }
      if (applicability === "HasPlaceholders" && !trusted) {
        reason = "the replacement text has placeholders for a human to fill in";
      }
      if (trusted && spans.some((s) => s.file_name !== file)) {
        trusted = false;
        reason = "the suggestion spans more than one file";
      }
      const site = d.spans[0];
      found.push({
        lint,
        help: child.message,
        applicability,
        file,
        line: site?.line_start ?? spans[0].line_start,
        context: site?.text?.[0]?.text?.trim() ?? "",
        spans,
        trusted,
        reason,
      });
    }
  }
  return found;
}

/**
 * Splice the trusted replacements into their files' bytes and return the
 * rewritten contents per file. Byte offsets are rustc's, so the edit is applied
 * to a Buffer — a string index would be wrong on every line holding an em dash.
 */
function rewrite(trusted: Candidate[]): Map<string, { before: Buffer; after: Buffer }> {
  const byFile = new Map<string, Span[]>();
  for (const c of trusted) {
    const list = byFile.get(c.file) ?? [];
    list.push(...c.spans);
    byFile.set(c.file, list);
  }

  const rewritten = new Map<string, { before: Buffer; after: Buffer }>();
  for (const [file, spans] of byFile) {
    const abs = join(CARGO_DIR, file);
    if (!existsSync(abs)) continue;
    const before = readFileSync(abs);
    let after = before;
    let lastStart = Infinity;
    // Descending, so each splice leaves the offsets of the ones still to come
    // untouched. Overlapping spans are skipped rather than stacked.
    for (const span of [...spans].sort((a, b) => b.byte_start - a.byte_start)) {
      if (span.byte_end > lastStart) continue;
      after = Buffer.concat([
        after.subarray(0, span.byte_start),
        Buffer.from(span.suggested_replacement ?? "", "utf8"),
        after.subarray(span.byte_end),
      ]);
      lastStart = span.byte_start;
    }
    if (!after.equals(before)) rewritten.set(file, { before, after });
  }
  return rewritten;
}

/**
 * Land the rewrites as a patch through `tugtool file edit`, so the files carry
 * a receipt and stay attributed to this session. Falls back to a direct write —
 * saying so — when no tugtool can be found.
 */
function land(rewritten: Map<string, { before: Buffer; after: Buffer }>): void {
  const scratch = mkdtempSync(join(tmpdir(), "clippy-repair."));
  const chunks: string[] = [];
  for (const [file, { before, after }] of rewritten) {
    const rel = join("tugrust", file);
    const a = join(scratch, "a");
    const b = join(scratch, "b");
    writeFileSync(a, before);
    writeFileSync(b, after);
    const diff = spawnSync("diff", ["-u", "-L", `a/${rel}`, "-L", `b/${rel}`, a, b], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    if (diff.stdout) chunks.push(diff.stdout);
  }
  if (chunks.length === 0) return;

  const applied = spawnSync(tugtool(), ["file", "edit", "--patch", "-"], {
    cwd: REPO_ROOT,
    input: chunks.join(""),
    encoding: "utf8",
    stdio: ["pipe", "inherit", "inherit"],
  });
  if (applied.status === 0) return;

  console.error("clippy-repair: tugtool could not apply the patch; writing the files directly");
  console.error("clippy-repair: the rewrites will land UNATTRIBUTED — claim them in the Changes card");
  for (const [file, { after }] of rewritten) writeFileSync(join(CARGO_DIR, file), after);
}

/**
 * The repo's own tugtool, not whatever `~/.local/bin` points at — that symlink
 * resolves to the main checkout, which is the wrong binary from a worktree.
 */
function tugtool(): string {
  const fromEnv = process.env.TUGTOOL;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const local = join(CARGO_DIR, "target", "debug", "tugtool");
  return existsSync(local) ? local : "tugtool";
}

/** One line of the file, for showing what a proposal would replace. */
function excerpt(file: string, span: Span): string {
  const abs = join(CARGO_DIR, file);
  if (!existsSync(abs)) return "";
  const text = readFileSync(abs).subarray(span.byte_start, span.byte_end).toString("utf8");
  return text.split("\n")[0].trim();
}

function report(untrusted: Candidate[]): void {
  if (untrusted.length === 0) return;
  console.log();
  console.log("UNAPPLIED — clippy proposed a rewrite this pass does not apply unattended:");
  console.log();
  for (const c of untrusted) {
    const span = c.spans[0];
    const rel = join("tugrust", c.file);
    console.log(`  ${rel}:${c.line}  ${c.lint}  [${c.applicability}]`);
    if (c.context) console.log(`    at: ${c.context}`);
    console.log(`    help: ${c.help}`);
    const from = excerpt(c.file, span);
    const to = (span.suggested_replacement ?? "").split("\n")[0].trim();
    console.log(`      - ${from || `(line ${span.line_start}, empty)`}`);
    console.log(`      + ${to || "(deleted)"}`);
    console.log(`    held back: ${c.reason}`);
    console.log();
  }
  console.log(`  ${untrusted.length} proposal(s). Apply one by hand, or add its lint to`);
  console.log("  TRUSTED in scripts/clippy-repair.ts once it is self-contained and loud when wrong.");
}

const flags = new Set(process.argv.slice(2));
const explainOnly = flags.has("--explain");
const quiet = flags.has("--quiet");

let applied = 0;
let survivors: Candidate[] = [];

for (let pass = 0; pass < MAX_PASSES; pass++) {
  const { diagnostics, hardErrors } = clippy();
  if (hardErrors.length > 0) {
    console.error("clippy-repair: the workspace does not compile; repairing nothing.");
    for (const e of hardErrors.slice(0, 3)) console.error(`  ${e.message}`);
    process.exit(1);
  }
  const found = candidates(diagnostics);
  survivors = found.filter((c) => !c.trusted);
  const trusted = found.filter((c) => c.trusted);
  if (explainOnly || trusted.length === 0) break;

  const rewritten = rewrite(trusted);
  if (rewritten.size === 0) break;
  land(rewritten);
  applied += trusted.length;
  for (const c of trusted) {
    console.log(`clippy-repair: ${join("tugrust", c.file)}:${c.spans[0].line_start}  ${c.lint}`);
  }
  // Loop: a rewrite can expose a lint the previous shape hid.
}

if (applied > 0) console.log(`clippy-repair: applied ${applied} suggestion(s) --fix skips.`);
if (!quiet) report(survivors);
