/**
 * A `git commit` Bash call's stdout, parsed into the commit receipt's data —
 * alone in a module with no component dependency.
 *
 * `CommitBlock` renders the result and re-exports everything here; the
 * transcript search index and the tool-header projection parse with it too,
 * and the search index is a `lib` module.
 *
 * @module lib/git-commit-parse
 */

// ---------------------------------------------------------------------------
// Data shape
// ---------------------------------------------------------------------------

/** A single file's line delta in a commit. `status` mirrors git's
 *  porcelain letters (M / A / D / R). */
export interface CommitFile {
  path: string;
  status: "M" | "A" | "D" | "R";
  added: number;
  removed: number;
}

/** Parsed commit, everything the receipt needs to render. `files` is an
 *  optional enrichment — when absent the receipt shows only the
 *  aggregate diffstat. */
export interface CommitData {
  /** Short hash, e.g. `450d6b28`. */
  hash: string;
  /** Branch the commit landed on, e.g. `main`. */
  branch: string;
  /** First line of the message — the title. */
  summary: string;
  /** Remaining message lines (blank line after the summary dropped). */
  body: readonly string[];
  filesChanged: number;
  insertions: number;
  deletions: number;
  files?: readonly CommitFile[];
}

// ---------------------------------------------------------------------------
// Parser — command + stdout → CommitData
// ---------------------------------------------------------------------------

/** Pull the `-m "…"` message from a `git commit` command string. Handles
 *  single- or double-quoted messages and the `git add … && git commit …`
 *  compound form. Returns the raw message (summary + body) or `null`. */
function extractCommitMessage(command: string): string | null {
  // Match -m / --message followed by a quoted string. Non-greedy body,
  // closing quote must match the opener. Newlines allowed inside.
  const m = command.match(/-m\s+(["'])([\s\S]*?)\1(?:\s|$)/);
  return m ? m[2] : null;
}

/** Split a raw commit message into a summary line and the remaining body
 *  lines (the blank line separating them is dropped). */
function splitMessage(message: string): { summary: string; body: string[] } {
  const lines = message.split("\n");
  const summary = (lines.shift() ?? "").trim();
  while (lines.length > 0 && lines[0]!.trim() === "") lines.shift();
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") {
    lines.pop();
  }
  return { summary, body: lines };
}

/**
 * Git's C-quoted display form, back to the path's real name.
 *
 * Every other path in the deck arrives as a typed field from Rust, read
 * through a `-z` listing that is never quoted. This block is the one
 * exception, and not by choice: it scrapes the stdout of a `git commit` some
 * agent ran in its own shell — text Tug does not author and cannot ask for in
 * another shape. Git quotes there whenever a path holds a non-ASCII byte, a
 * `"`, a `\`, a tab or a newline, so `01_Stanisław.jpg` is printed
 * `"01_Stanis\305\202aw.jpg"` and would paint that way.
 *
 * Reading it back is display-only and safe *because* it is display-only: the
 * result is rendered and never handed to git, so a path this gets wrong costs
 * a wrong-looking row rather than a wrong file. An unquoted string is returned
 * untouched — git quotes only when it must, and the opening `"` is the tell.
 *
 * Octal escapes are the individual BYTES of the name's UTF-8, so they are
 * collected and decoded together; a decoder run per escape would turn one
 * two-byte `ł` into two replacement characters.
 */
export function unquoteGitPath(raw: string): string {
  if (raw.length < 2 || !raw.startsWith('"') || !raw.endsWith('"')) return raw;
  const chars = Array.from(raw.slice(1, -1));
  const encoder = new TextEncoder();
  const simple: Record<string, number> = {
    a: 0x07,
    b: 0x08,
    f: 0x0c,
    n: 0x0a,
    r: 0x0d,
    t: 0x09,
    v: 0x0b,
    '"': 0x22,
    "\\": 0x5c,
  };
  const bytes: number[] = [];
  const push = (text: string): void => {
    for (const byte of encoder.encode(text)) bytes.push(byte);
  };
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]!;
    if (ch !== "\\") {
      push(ch);
      continue;
    }
    const next = chars[++i];
    if (next === undefined) {
      push("\\");
      break;
    }
    const mapped = simple[next];
    if (mapped !== undefined) {
      bytes.push(mapped);
      continue;
    }
    const octal = chars.slice(i, i + 3).join("");
    if (/^[0-7]{3}$/.test(octal)) {
      bytes.push(Number.parseInt(octal, 8));
      i += 2;
      continue;
    }
    // Not an escape git writes. Keep both characters rather than guess.
    push("\\");
    push(next);
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/**
 * Parse a per-file breakdown from a commit's stdout, or `undefined` when
 * none is present. Two complementary sources:
 *
 *  - `git show --numstat` lines (`<added>\t<removed>\t<path>`) — exact per-
 *    file counts. Only present when the commit command appended a
 *    numstat-producing call (the `/tugplug:commit` skill does); a plain
 *    `git commit` has none, so the receipt simply shows no file list.
 *  - the `create mode` / `delete mode` / `rename …` lines `git commit`
 *    prints — they upgrade a file's status to A / D / R (everything else
 *    in the numstat is a modification, M).
 *
 * Binary files report `-` for both counts; treated as 0 / 0.
 *
 * Every path either source names is read back through {@link unquoteGitPath}
 * first, so the two maps are keyed by the same real name.
 */
function parseCommitFiles(stdout: string): CommitFile[] | undefined {
  const statusByPath = new Map<string, CommitFile["status"]>();
  for (const m of stdout.matchAll(/^ create mode \d+ (.+)$/gm)) {
    statusByPath.set(unquoteGitPath(m[1]!.trim()), "A");
  }
  for (const m of stdout.matchAll(/^ delete mode \d+ (.+)$/gm)) {
    statusByPath.set(unquoteGitPath(m[1]!.trim()), "D");
  }

  const files: CommitFile[] = [];
  for (const m of stdout.matchAll(/^([0-9]+|-)\t([0-9]+|-)\t(.+)$/gm)) {
    const path = unquoteGitPath(m[3]!.trim());
    const added = m[1] === "-" ? 0 : Number(m[1]);
    const removed = m[2] === "-" ? 0 : Number(m[2]);
    // A numstat rename path carries `=>` (e.g. `a => b` or `d/{a => b}`).
    const status: CommitFile["status"] = path.includes("=>")
      ? "R"
      : (statusByPath.get(path) ?? "M");
    files.push({ path, status, added, removed });
  }
  return files.length > 0 ? files : undefined;
}

/**
 * Parse a `git commit` Bash call into `CommitData`. `command` is the
 * shell command (for the full message via `-m`); `stdout` is the commit
 * output (for branch / hash / diffstat, and an optional per-file
 * `--numstat` block — see {@link parseCommitFiles}). Returns `null` when
 * `stdout` carries no recognizable `[branch hash] …` line — the signal
 * that this was not a successful commit.
 *
 * Recognized stdout shape:
 *   [main 450d6b28] Add separating space when accepting a completion
 *    2 files changed, 32 insertions(+), 14 deletions(-)
 */
export function parseGitCommit(
  command: string,
  stdout: string,
): CommitData | null {
  const head = stdout.match(/^\[([^\]\s]+)\s+([0-9a-f]{7,40})\]\s*(.*)$/m);
  if (head === null) return null;
  const branch = head[1]!;
  const hash = head[2]!;
  const stdoutSummary = head[3]!.trim();

  // Prefer the full message from the command (it carries the body);
  // fall back to the summary echoed in stdout when `-m` isn't parseable
  // (e.g. a `-F file` or editor commit).
  const message = extractCommitMessage(command);
  const { summary, body } =
    message !== null
      ? splitMessage(message)
      : { summary: stdoutSummary, body: [] as string[] };

  const stat = stdout.match(
    /(\d+)\s+files?\s+changed(?:,\s+(\d+)\s+insertions?\(\+\))?(?:,\s+(\d+)\s+deletions?\(-\))?/,
  );
  const filesChanged = stat ? Number(stat[1]) : 0;
  const insertions = stat && stat[2] ? Number(stat[2]) : 0;
  const deletions = stat && stat[3] ? Number(stat[3]) : 0;

  return {
    hash,
    branch,
    summary: summary || stdoutSummary,
    body,
    filesChanged,
    insertions,
    deletions,
    files: parseCommitFiles(stdout),
  };
}
