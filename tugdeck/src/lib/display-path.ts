/**
 * display-path — the spellings a path takes when it is shown rather than
 * opened.
 *
 * A payload's path is absolute and stays absolute ([P15]); what a surface
 * *draws* is nearly always shorter — a tool header's basename, a Lens row's
 * `parent/name`, a diff header's filename. Those spellings are display
 * decisions, and they belong in one place because the alternative already
 * happened: four private `basename` helpers, three of them disagreeing about
 * a trailing slash or a backslash separator, so the same path could come out
 * two ways on two surfaces of the same card.
 *
 * `pathRelativeTo` — the other display spelling, shortening against a root —
 * lives in `lib/relative-path`.
 *
 * @module lib/display-path
 */

/**
 * The trailing segment of a path (`/a/b/c.txt` → `c.txt`).
 *
 * Trailing separators are ignored, so a directory names itself rather than
 * coming back empty (`/a/b/` → `b`). Both separators are honoured: a path
 * that reached us from a Windows-shaped tool payload still names its file.
 * A path with no separator is already a basename and returns unchanged.
 */
export function basename(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const segments = trimmed.split(/[\\/]/);
  return segments[segments.length - 1] ?? "";
}

/**
 * The directory portion of a path (`/a/b/c.txt` → `/a/b`), or `""` when the
 * path names something at the root or carries no directory at all.
 */
export function dirname(path: string): string {
  const i = path.lastIndexOf("/");
  return i > 0 ? path.slice(0, i) : "";
}
