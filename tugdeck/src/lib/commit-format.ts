/**
 * Commit formatting — the one vocabulary for stating a commit's shape.
 *
 * "What did this commit touch?" is answered on five surfaces: the hover over
 * a sha, the History shade's rows, the `/commit` receipt's stat badges, the
 * Changes sheet header, and the copy payload. Each grew its own spelling of
 * the same three facts — a status mark, a ± pair, and a file count — so the
 * same commit could read `33 files changed, +3461 −128` in one place and
 * `33 files changed +3461 −128` two inches away.
 *
 * This module owns the parts, and the sentences are assembled from them here
 * rather than at each call site. Three status vocabularies arrive at the door
 * — `git show`'s words (`modified`), porcelain's codes (`??`, `RM`), and a
 * bare letter that is already a mark — so {@link statusMark} accepts all three
 * and answers in the house's own three letters ([D118]).
 *
 * Pure and presentation-only: nothing here knows where its facts came from.
 *
 * @module lib/commit-format
 */

/**
 * A changed file, as any surface knows it. Structural on purpose — the
 * commit-files store, the receipt parser, and the annotator's facts all
 * satisfy it without importing each other's types.
 */
export interface CommitFileShape {
  /** Path relative to the repo root (rename destination when renamed). */
  path: string;
  /** A status word (`modified`) or an already-abbreviated mark (`M`). */
  status: string;
  /** Added line count; `0` for a binary file. */
  added: number;
  /** Removed line count; `0` for a binary file. */
  removed: number;
}

/** Short display form of a sha — git's own abbreviation length. */
export const COMMIT_LABEL_LENGTH = 8;

/**
 * The label a commit atom carries — `commit:<8ch>`.
 *
 * The whole app's one spelling for naming a commit: what the pill prints, what
 * `Copy Short Hash` writes, and what an atom copy's `text/plain` flavor
 * carries. Eight bare hex characters name nothing a reader can act on, and a
 * small glyph was judged not to rescue them — an atom stands with no sentence
 * around it, so the work a sentence would have done moves into the label.
 *
 * It lives here beside {@link COMMIT_LABEL_LENGTH} rather than in a component,
 * because the clipboard paths and the annotator's atom vocabulary both need it
 * and neither may import a `components/` module.
 */
export function commitAtomLabel(sha: string): string {
  return `commit:${sha.slice(0, COMMIT_LABEL_LENGTH)}`;
}

/** How many files a hover lists before it starts counting instead. */
export const HOVER_FILE_LIMIT = 8;

/**
 * The house status letters ([D118]): green **N** (new — untracked or added),
 * yellow **M** (changed — modified, moved, renamed, copied, type-changed), red
 * **D** (deleted).
 *
 * Three letters, not git's seven. A roster is a glance, and the reader's
 * question at a glance is *did this file appear, change, or go away* — which
 * is exactly three answers. A rename is a file that changed; that it changed
 * its name rather than its lines is a fact for the row's own hover, not for
 * the column two characters wide.
 */
export type StatusMark = "N" | "M" | "D";

/** Status words — `git show`'s vocabulary, and the receipt parser's. */
const STATUS_WORD_MARK: Record<string, StatusMark> = {
  created: "N",
  added: "N",
  untracked: "N",
  modified: "M",
  renamed: "M",
  moved: "M",
  copied: "M",
  deleted: "D",
};

/**
 * The house letter for a file's status, from any vocabulary that arrives at
 * the door: a status word (`created`), a porcelain code (`??`, ` M`, `RM`), or
 * a single letter that is already a mark (`A`). Falls back to `M`, the status
 * a file most often has — an unknown code still means the file is in the
 * commit, and *changed* is the honest reading of that.
 *
 * This is the one place the mapping lives. Every surface that shows a changed
 * file — the Changes shade's rows, the `/commit` receipt, a commit hover, the
 * copy payload — asks here, so none of them can invent a fourth letter.
 */
export function statusMark(status: string): StatusMark {
  const trimmed = status.trim();
  // Porcelain's untracked pair, which is not a letter and not a word.
  if (trimmed.startsWith("?")) return "N";
  const word = STATUS_WORD_MARK[trimmed.toLowerCase()];
  if (word !== undefined) return word;
  // A porcelain code is one or two letters in an XY pair; the first letter
  // that is not a dot or a space is the change that happened.
  switch (trimmed.replace(/[.\s]/g, "").charAt(0).toUpperCase()) {
    case "A":
      return "N";
    case "D":
      return "D";
    default:
      return "M";
  }
}

/**
 * `+12 −3`, dropping a side that contributed nothing, and empty when the
 * file changed no lines at all (a binary, a pure rename). Uses the real
 * minus sign (U+2212) so the pair aligns under a tabular font.
 */
export function deltaCounts(added: number, removed: number): string {
  const parts: string[] = [];
  if (added > 0) parts.push(`+${added}`);
  if (removed > 0) parts.push(`−${removed}`);
  return parts.join(" ");
}

/** `3 files` / `1 file` — the count with its noun agreeing. */
export function fileCountLabel(count: number): string {
  return `${count} ${count === 1 ? "file" : "files"}`;
}

/** The ± totals across a roster. */
export function totalsOf(files: readonly CommitFileShape[]): {
  added: number;
  removed: number;
} {
  let added = 0;
  let removed = 0;
  for (const file of files) {
    added += file.added;
    removed += file.removed;
  }
  return { added, removed };
}

/**
 * `3 files changed, +40 −12` — the commit's shape in one line, and the
 * sentence every surface states it with. The tail is dropped when nothing
 * changed textually, leaving `3 files changed`.
 */
export function statLineFrom(count: number, added: number, removed: number): string {
  const counts = deltaCounts(added, removed);
  const head = `${fileCountLabel(count)} changed`;
  return counts === "" ? head : `${head}, ${counts}`;
}

/** {@link statLineFrom} over a roster, which carries its own totals. */
export function statLine(files: readonly CommitFileShape[]): string {
  const { added, removed } = totalsOf(files);
  return statLineFrom(files.length, added, removed);
}

/** One roster line's parts: `M  path/to/file  +12 −3`. */
export interface RosterEntry {
  path: string;
  mark: StatusMark;
  /** `+12 −3`, or empty when the file changed no lines — the text spelling,
   *  for a copy payload. A rendered surface uses the two numbers instead, so
   *  its counts come from the shared `DiffSummaryBadges` atom ([P27]). */
  counts: string;
  added: number;
  removed: number;
}

/**
 * The roster a glance shows: up to `limit` files, and how many were left
 * out. A hover is a glance, not a diff — so the list is capped, and a capped
 * list says how many it dropped rather than trailing off, so the reader
 * knows the shape of what they are not seeing.
 */
export function commitRoster(
  files: readonly CommitFileShape[],
  limit: number = HOVER_FILE_LIMIT,
): { entries: RosterEntry[]; hidden: number } {
  const entries = files.slice(0, limit).map((file) => ({
    path: file.path,
    mark: statusMark(file.status),
    counts: deltaCounts(file.added, file.removed),
    added: file.added,
    removed: file.removed,
  }));
  return { entries, hidden: Math.max(0, files.length - limit) };
}
