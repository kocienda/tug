/**
 * overview-body-segments.ts — does the prose already name this ref?
 *
 * A Overview post carries refs the model listed beside its prose. Those two
 * are written independently, so they overlap only by accident: a post can
 * mention three files and list a fourth. The prose's own mentions are
 * atomized by the **content annotator** — the same pass that marks paths
 * and shas anywhere else in the app — which scans the text and needs no
 * ref list at all. What the ref list is still good for is the remainder:
 * provenance the sentence never got around to naming, shown as trailing
 * chips.
 *
 * This module is the filter between the two, and nothing more. It answers
 * one question — *is this ref already in the prose?* — so a ref the reader
 * can already see and click in the sentence does not also appear as a chip
 * underneath it. (An earlier version of this file tried to do the placing
 * as well, matching ref targets against the body and rendering the hits
 * inline. That is why mentions the ref list happened not to contain stayed
 * dead text: the matcher could only ever find what the model had listed.
 * The annotator finds them all, so the placing is gone and only the
 * suppression is left.)
 *
 * **The match runs against the markdown SOURCE**, which is what a post's
 * `body` is and what this is handed. Rendering does not enter into it: a
 * path the model backticked is `` `tugdeck/src/x.ts` `` in the source and a
 * `<code>` span on screen, and this sees the source, so the backticks
 * around a target no more hide it than the sentence around it does.
 *
 * Matching is deliberately generous, because a near-miss here costs a
 * duplicate chip rather than a lost link: a file ref counts as mentioned
 * when the body contains its full target *or* its basename, and a commit
 * ref when the body holds a hex run that is a prefix of its sha or that it
 * is a prefix of — the two spell the same commit at different lengths.
 * Boundaries are checked so `foo.ts` is not claimed by `other/foo.ts` or
 * by `foo.ts.bak`. A session ref is never suppressed: its citation is a
 * different surface with a different gesture, not a duplicate of anything
 * in the prose.
 *
 * Pure.
 *
 * @module lib/overview-body-segments
 */

import type { OverviewRef } from "@/protocol";

/** Characters that continue a path or name token — a match that touches one
 *  of these on either side is a fragment of something else, not a mention. */
const TOKEN_CHAR = /[A-Za-z0-9._~-]/;

/** A run of hex long enough to be a spelled commit sha. */
const HEX_RUN = /[0-9a-f]{7,40}/g;

/**
 * Whether a match at `[start, end)` stands on its own feet: the characters
 * beside it are not token characters or path separators. One reprieve on
 * the trailing side — a `.` that ends the mention is a sentence period, not
 * a longer name, when nothing token-like follows it, so
 * `…layout-imposer.ts.` at the end of a sentence still counts.
 */
function boundaryOk(body: string, start: number, end: number): boolean {
  const before = start > 0 ? body[start - 1]! : "";
  if (before === "/" || TOKEN_CHAR.test(before)) return false;
  const after = end < body.length ? body[end]! : "";
  if (after === "/") return false;
  if (after === ".") {
    const next = end + 1 < body.length ? body[end + 1]! : "";
    return next === "" || !TOKEN_CHAR.test(next);
  }
  return !TOKEN_CHAR.test(after);
}

/** Whether `text` appears in `body` on its own token boundaries. */
function containsToken(body: string, text: string): boolean {
  let from = 0;
  for (;;) {
    const start = body.indexOf(text, from);
    if (start === -1) return false;
    const end = start + text.length;
    if (boundaryOk(body, start, end)) return true;
    from = end;
  }
}

/** Whether `body` spells this commit at any length that means the same sha. */
function mentionsCommit(body: string, target: string): boolean {
  HEX_RUN.lastIndex = 0;
  for (const hit of body.matchAll(HEX_RUN)) {
    const run = hit[0];
    if (!target.startsWith(run) && !run.startsWith(target)) continue;
    if (boundaryOk(body, hit.index, hit.index + run.length)) return true;
  }
  return false;
}

/**
 * Whether the post's prose already names `ref`, and the annotator has
 * therefore already made it clickable where the reader is reading.
 */
export function bodyMentionsRef(body: string, ref: OverviewRef): boolean {
  const target = ref.target;
  if (target.length === 0) return false;
  // A session citation is its own surface with its own gesture; the prose
  // naming the session does not make the chip a duplicate.
  if (ref.kind === "session") return false;
  if (ref.kind === "commit") return mentionsCommit(body, target);
  if (containsToken(body, target)) return true;
  const base = target.split("/").pop() ?? "";
  return base !== "" && base !== target && containsToken(body, base);
}

/** The refs whose targets the prose has *not* already named — the chips. */
export function unmentionedRefs(
  body: string,
  refs: readonly OverviewRef[],
): OverviewRef[] {
  return refs.filter((ref) => !bodyMentionsRef(body, ref));
}
