/**
 * two-text-diff — a `GitDiffPayload` built from two strings, so the Text
 * card's conflict surface can show what actually differs.
 *
 * "This file changed on disk while you were editing" is a claim the user has
 * no way to check. Reload and Keep Mine each discard one side's work, and
 * nothing on the banner says which side is worth keeping. So the card offers
 * a diff — and the diff viewer the app already has (`TugDiffDocument`) reads
 * a `GitDiffPayload`, whose `unified` field is plain unified-diff text.
 *
 * Nothing here talks to git. The payload is synthesized locally from the disk
 * text and the live buffer, with the fields `TugDiffDocument` reads filled in
 * and the request/workspace correlation fields left empty — it is a view, not
 * a request's answer, and it is never persisted or sent anywhere.
 *
 * The output is standard unified diff with three lines of context, built from
 * the same `diffLines` Myers pass the editor's reloads use, so what the sheet
 * shows and what a merge would reason about are the same decomposition. A
 * diff past `MAX_EDIT_DISTANCE` degrades to one whole-file hunk rather than
 * failing: the reader still gets to see both versions.
 *
 * @module lib/diff/two-text-diff
 */

import {
  MAX_EDIT_DISTANCE,
  diffLines,
  splitLines,
} from "../minimal-text-changes";
import type { GitDiffFile, GitDiffPayload } from "../git-diff-store";

/** Lines of unchanged text kept around each change, as git's default does. */
const CONTEXT_LINES = 3;

/**
 * A one-file diff payload: `before` (the disk text) against `after` (the
 * live buffer), under `fileName`.
 *
 * Both sides are LF-normalized first — the buffer is always `\n`-only and a
 * CRLF file would otherwise differ on every single line.
 */
export function buildTwoTextDiffPayload(
  fileName: string,
  before: string,
  after: string,
): GitDiffPayload {
  const a = splitLines(normalizeLf(before));
  const b = splitLines(normalizeLf(after));
  const raw = diffLines(a, b, MAX_EDIT_DISTANCE) ?? [
    // Too different to decompose finely. One hunk covering both sides is
    // still an honest answer, and it is the one git itself falls back to.
    [0, a.length, 0, b.length] as [number, number, number, number],
  ];

  const lines: string[] = [`--- a/${fileName}`, `+++ b/${fileName}`];
  let added = 0;
  let removed = 0;

  for (const group of groupHunks(raw)) {
    const first = group[0];
    const last = group[group.length - 1];
    if (first === undefined || last === undefined) continue;
    const aStart = Math.max(0, first[0] - CONTEXT_LINES);
    const aEnd = Math.min(a.length, last[1] + CONTEXT_LINES);
    // Context lines are common to both sides, so the leading and trailing
    // context shift `b` by exactly what they shift `a` by.
    const bStart = first[2] - (first[0] - aStart);
    const bEnd = last[3] + (aEnd - last[1]);

    const body: string[] = [];
    let ai = aStart;
    for (const [h0, h1, hb0, hb1] of group) {
      for (; ai < h0; ai++) body.push(...emit(" ", a, ai));
      for (let k = h0; k < h1; k++) body.push(...emit("-", a, k));
      for (let k = hb0; k < hb1; k++) body.push(...emit("+", b, k));
      removed += h1 - h0;
      added += hb1 - hb0;
      ai = h1;
    }
    for (; ai < aEnd; ai++) body.push(...emit(" ", a, ai));

    lines.push(
      `@@ -${range(aStart, aEnd)} +${range(bStart, bEnd)} @@`,
      ...body,
    );
  }

  const file: GitDiffFile = {
    path: fileName,
    status: "modified",
    added,
    removed,
    binary: false,
    // No `hunks`: hunk ids are the landing engine's election keys, and
    // nothing here is electable — this diff is a view of two buffers.
    unified: `${lines.join("\n")}\n`,
  };
  return {
    request_id: "",
    workspace_key: "",
    base: "disk",
    no_repo: false,
    file_count: 1,
    total_added: added,
    total_removed: removed,
    files: [file],
  };
}

/**
 * Merge hunks whose context windows would overlap or abut into one emitted
 * hunk, so the output never repeats a line or prints a one-line `@@` island
 * between two changes three lines apart.
 */
function groupHunks(
  hunks: ReadonlyArray<[number, number, number, number]>,
): Array<Array<[number, number, number, number]>> {
  const groups: Array<Array<[number, number, number, number]>> = [];
  for (const hunk of hunks) {
    const last = groups[groups.length - 1];
    const tail = last?.[last.length - 1];
    if (last !== undefined && tail !== undefined && hunk[0] - tail[1] <= CONTEXT_LINES * 2) {
      last.push(hunk);
    } else {
      groups.push([hunk]);
    }
  }
  return groups;
}

/**
 * One body line, plus git's no-newline marker when the line it names is the
 * last of its side and carries no terminator. Without the marker a reader
 * cannot tell "the file ends here" from "the file ends with a blank line",
 * and applying the diff would silently add a newline.
 */
function emit(prefix: string, lines: string[], index: number): string[] {
  const line = lines[index] ?? "";
  const out = [prefix + stripTerminator(line)];
  if (index === lines.length - 1 && !line.endsWith("\n")) {
    out.push("\\ No newline at end of file");
  }
  return out;
}

/**
 * A `@@` range. A zero-length side starts at the line BEFORE it, which is
 * git's convention and what `parseUnifiedDiffText` reads back.
 */
function range(start: number, end: number): string {
  const count = end - start;
  return `${count === 0 ? start : start + 1},${count}`;
}

function stripTerminator(line: string): string {
  return line.endsWith("\n") ? line.slice(0, -1) : line;
}

function normalizeLf(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}
