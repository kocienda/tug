/**
 * session-picker-format — pure formatters for the Dev project picker.
 *
 * Used by the picker's session-resume cells. No React, no JSX —
 * pure string formatting, unit-test-friendly. Lives in its own
 * module so callers in `session-card.tsx` and `session-picker-cells.tsx`
 * can both import without forming an import cycle.
 */

import type { SessionRow } from "@/protocol";

/**
 * Truncate a single-line snippet for display in a picker row. Honors
 * Unicode-scalar boundaries (no mid-codepoint slice) and adds an
 * ellipsis when the source exceeds the budget. Newlines and runs of
 * whitespace collapse to single spaces so multi-line prompts read
 * as a single line in the row's title.
 */
export function truncateForDisplay(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  if (flat.length === 0) return "";
  const chars = Array.from(flat);
  if (chars.length <= max) return flat;
  return chars.slice(0, max).join("") + "…";
}

/*
 * `formatRelativeTimestamp` lived here too — "just now", "3h ago", "yesterday" —
 * as the subtitle's leading segment. It went with the subtitle: the activity
 * line dates itself with an absolute `Last updated: <stamp>` instead, because a
 * relative age beside a turn count and a size left the reader working out which
 * of the three it was measuring. `formatRestingStamp` in
 * `lib/session-activity-line.ts` is what composes that stamp now.
 */

/**
 * Format a byte count as a compact human-readable size: "B", "KB", "MB".
 * One decimal under 10 of a unit (e.g. "3.4 KB"), whole numbers above.
 */
export function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  const mb = kb / 1024;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

/*
 * `formatSessionRowSubtitle` lived here, composing the picker's fourth line as
 * `<when> · <turns> · <size> · id <short>`. That line is gone: those facts are
 * the activity line's rest form now (`lib/session-activity-line.ts`), stated as
 * a sentence on the surface every session shares rather than as a dot-joined run
 * the picker alone wore. `formatByteSize` above is what survived, and the new
 * formatter borrows it rather than re-deriving a second spelling of a size.
 */

/**
 * Subtitle for a `state: "failed"` row. The old copy hard-coded
 * "Couldn't resume — JSONL missing" for every failed row, which was routinely a
 * lie: the 2026-07-22 commit-xp row showed it while a 40 MB transcript sat on
 * disk. Only assert the transcript is gone when the on-disk scan actually found
 * it empty/absent (`file_size === 0`); an intact transcript — or a row not yet
 * scanned (`file_size` null/absent) — is resumable, so invite a retry instead
 * of fabricating a cause.
 */
export function formatFailedRowSubtitle(row: SessionRow): string {
  return row.file_size === 0
    ? "Couldn’t resume — transcript missing"
    : "Resume failed — select to retry";
}
