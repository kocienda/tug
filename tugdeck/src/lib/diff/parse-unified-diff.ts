/**
 * `parseUnifiedDiffText` — JS port of `tugdiff-wasm`'s
 * `parse_unified_diff_text`, used for synchronous first-paint while the
 * WASM module is still loading (or as a permanent path for plain
 * unified-diff inputs, which don't need the line-level diff engine).
 *
 * Stays in sync with the Rust implementation at
 * `tugdeck/crates/tugdiff-wasm/src/lib.rs`. Both consume the same
 * fixtures and produce the same `DiffHunk[]` shape.
 *
 * @module lib/diff/parse-unified-diff
 */

import type { DiffHunk } from "./types";

interface HunkHeaderInfo {
  beforeStart: number;
  beforeCount: number;
  afterStart: number;
  afterCount: number;
  header: string;
}

/**
 * Parse a unified-diff string into structured hunks.
 *
 * Tolerates:
 *  - `---` / `+++` file headers (skipped before any `@@` is seen).
 *  - `\ No newline at end of file` markers (skipped).
 *  - Empty lines inside a hunk treated as empty context lines (matching
 *    git's behavior of emitting a bare blank line instead of " \n").
 *
 * Malformed `@@` headers cause the parser to skip until the next valid
 * one; existing accumulated hunks are preserved.
 */
export function parseUnifiedDiffText(text: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let current: DiffHunk | null = null;
  let beforeLineno = 0;
  let afterLineno = 0;

  for (const rawLine of splitLinesPreservingEmpty(text)) {
    if (rawLine.startsWith("@@")) {
      if (current !== null) {
        hunks.push(current);
        current = null;
      }
      const info = parseHunkHeader(rawLine.slice(2));
      if (info !== null) {
        beforeLineno = info.beforeStart;
        afterLineno = info.afterStart;
        current = {
          before_start: info.beforeStart,
          before_count: info.beforeCount,
          after_start: info.afterStart,
          after_count: info.afterCount,
          header: info.header,
          lines: [],
        };
      }
      continue;
    }

    if (current === null) continue;
    if (rawLine.startsWith("\\")) continue;

    if (rawLine.startsWith("+")) {
      current.lines.push({
        kind: "add",
        content: rawLine.slice(1),
        before_lineno: null,
        after_lineno: afterLineno,
      });
      afterLineno += 1;
    } else if (rawLine.startsWith("-")) {
      current.lines.push({
        kind: "remove",
        content: rawLine.slice(1),
        before_lineno: beforeLineno,
        after_lineno: null,
      });
      beforeLineno += 1;
    } else if (rawLine.startsWith(" ")) {
      current.lines.push({
        kind: "context",
        content: rawLine.slice(1),
        before_lineno: beforeLineno,
        after_lineno: afterLineno,
      });
      beforeLineno += 1;
      afterLineno += 1;
    } else if (rawLine.length === 0) {
      current.lines.push({
        kind: "context",
        content: "",
        before_lineno: beforeLineno,
        after_lineno: afterLineno,
      });
      beforeLineno += 1;
      afterLineno += 1;
    }
  }

  if (current !== null) hunks.push(current);

  return hunks;
}

/**
 * Split `text` into lines but, unlike `String.split("\n")`, drop the
 * trailing-empty entry that a final newline produces. We split-then-strip
 * rather than scanning for `\n` so that lone CR (`\r`) endings are also
 * stripped from each line.
 */
function splitLinesPreservingEmpty(text: string): string[] {
  if (text.length === 0) return [];
  const parts = text.split("\n");
  if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
  return parts.map((part) =>
    part.endsWith("\r") ? part.slice(0, -1) : part,
  );
}

/**
 * Parse the body of a hunk header (everything after the leading `@@`).
 * Expected shape: ` -<n>[,<n>] +<n>[,<n>] @@[ <header>]`.
 */
function parseHunkHeader(rest: string): HunkHeaderInfo | null {
  const trimmed = rest.replace(/^\s+/, "");
  const closeIdx = trimmed.indexOf("@@");
  if (closeIdx < 0) return null;
  const info = trimmed.slice(0, closeIdx).trim();
  const header = trimmed.slice(closeIdx + 2).trim();

  const parts = info.split(/\s+/);
  if (parts.length < 2) return null;
  const beforePart = parts[0];
  const afterPart = parts[1];
  if (!beforePart.startsWith("-")) return null;
  if (!afterPart.startsWith("+")) return null;

  const before = parseRange(beforePart.slice(1));
  const after = parseRange(afterPart.slice(1));
  if (before === null || after === null) return null;

  return {
    beforeStart: before.start,
    beforeCount: before.count,
    afterStart: after.start,
    afterCount: after.count,
    header,
  };
}

function parseRange(s: string): { start: number; count: number } | null {
  const comma = s.indexOf(",");
  if (comma < 0) {
    const start = Number.parseInt(s, 10);
    if (Number.isNaN(start)) return null;
    return { start, count: 1 };
  }
  const start = Number.parseInt(s.slice(0, comma), 10);
  const count = Number.parseInt(s.slice(comma + 1), 10);
  if (Number.isNaN(start) || Number.isNaN(count)) return null;
  return { start, count };
}

// ---------------------------------------------------------------------------
// Word-level intra-line diff via diff-match-patch.
// ---------------------------------------------------------------------------

/**
 * Tag for a span produced by `wordLevelDiff`.
 *
 *   - `equal` — text unchanged between `before` and `after`.
 *   - `delete` — present in `before`, absent in `after`.
 *   - `insert` — absent in `before`, present in `after`.
 */
export type WordDiffTag = "equal" | "delete" | "insert";

/**
 * One contiguous segment from a word-level diff.
 *
 * Each variant carries the half-open `[start, end)` ranges in the
 * texts where it applies. `equal` segments live in *both* the
 * before and after streams; `delete` only in before; `insert` only
 * in after. The merge into Shiki syntax tokens (see `render-line.ts`)
 * keys on these ranges to emit double-classed spans.
 */
export type WordDiffSegment =
  | {
      tag: "equal";
      text: string;
      beforeStart: number;
      beforeEnd: number;
      afterStart: number;
      afterEnd: number;
    }
  | {
      tag: "delete";
      text: string;
      beforeStart: number;
      beforeEnd: number;
    }
  | {
      tag: "insert";
      text: string;
      afterStart: number;
      afterEnd: number;
    };

/**
 * Word-level (technically character-level with semantic cleanup) diff
 * between two single-line texts. Used by `<DiffBlock>` to highlight
 * which characters within a paired remove/add line actually changed,
 * rather than painting the entire line as a delete/insert.
 *
 * The implementation lazy-loads `diff-match-patch` and runs
 * `diff_cleanupSemantic` to coalesce the raw character runs into
 * human-readable word-ish chunks. Each returned segment is enriched
 * with per-side `[start, end)` ranges so consumers can merge with
 * Shiki syntax tokens (see `render-line.ts`).
 */
export async function wordLevelDiff(
  before: string,
  after: string,
): Promise<WordDiffSegment[]> {
  // Static import would land diff-match-patch in the boot bundle;
  // dynamic import keeps it on the diff-render path only.
  const mod = await import("diff-match-patch");
  type Ctor = new () => {
    diff_main(a: string, b: string): Array<[number, string]>;
    diff_cleanupSemantic(diffs: Array<[number, string]>): void;
  };
  const Engine = (mod.default ?? mod) as unknown as Ctor;
  return wordLevelDiffSync(before, after, Engine);
}

/**
 * Synchronous flavor of `wordLevelDiff`, for callers that have already
 * loaded the engine (e.g. tests, or after a one-shot async preload).
 * Pass the imported `diff-match-patch` module's default export.
 */
export function wordLevelDiffSync(
  before: string,
  after: string,
  Engine: new () => {
    diff_main(a: string, b: string): Array<[number, string]>;
    diff_cleanupSemantic(diffs: Array<[number, string]>): void;
  },
): WordDiffSegment[] {
  const engine = new Engine();
  const raw = engine.diff_main(before, after);
  engine.diff_cleanupSemantic(raw);

  let beforePos = 0;
  let afterPos = 0;
  const segments: WordDiffSegment[] = [];
  for (const [op, text] of raw) {
    const len = text.length;
    if (op === 1) {
      segments.push({
        tag: "insert",
        text,
        afterStart: afterPos,
        afterEnd: afterPos + len,
      });
      afterPos += len;
    } else if (op === -1) {
      segments.push({
        tag: "delete",
        text,
        beforeStart: beforePos,
        beforeEnd: beforePos + len,
      });
      beforePos += len;
    } else {
      segments.push({
        tag: "equal",
        text,
        beforeStart: beforePos,
        beforeEnd: beforePos + len,
        afterStart: afterPos,
        afterEnd: afterPos + len,
      });
      beforePos += len;
      afterPos += len;
    }
  }
  return segments;
}
