/**
 * The commit receipt's parser — the server-formatted `/commit` summary (S02)
 * the shell ledger records, and the `files:` line the join receipt carries
 * identically.
 *
 * Pure: `SessionCommitReceiptBlock` renders what this reads and re-exports it,
 * and `lib/join-receipt.ts` reads the `files:` line through
 * {@link parseFilesLine} so the two receipts cannot drift.
 *
 * @module lib/commit-receipt
 */

/** One committed file, frozen into the durable record for the expandable list. */
export interface CommitReceiptFile {
  path: string;
  /** `modified` | `created` | `deleted` | `renamed` (git name-status word). */
  status: string;
  added: number;
  removed: number;
}

/** The display facts parsed from an S02 commit summary. */
export interface ParsedCommitReceipt {
  sha: string;
  /** The full commit message (subject + body); the receipt clamps it to 3 lines. */
  message: string;
  fileCount: number;
  added: number;
  removed: number;
  /** The committed files (from the `files:` line); empty for a legacy record. */
  files: CommitReceiptFile[];
}

// The S02 summary shape (server-formatted, the single source): a fixed machine
// header on line 0, an optional `files:` JSON line, then the verbatim commit
// message.
//   committed <sha> · <N> file(s) · +<added> −<removed>
//   files: [{"path":"…","status":"modified","added":16,"removed":1}, …]
//   <full message>
// (`·` is U+00B7, `−` U+2212 — matched exactly so a hand-typed arc never
// false-parses.)
const HEAD_RE = /^committed (\S+) · (\d+) file\(s\) · \+(\d+) −(\d+)$/;

/**
 * The `files:` line's prefix — the one marker that decides whether line 1 is a
 * file list or the start of the message. Exported with {@link parseFilesLine}
 * because the join receipt carries the identical line (Spec S01) and the two
 * receipts must read it with one parser, not two that could drift.
 */
export const FILES_PREFIX = "files: ";

export function parseFilesLine(line: string): CommitReceiptFile[] {
  try {
    const raw = JSON.parse(line.slice(FILES_PREFIX.length)) as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((f): CommitReceiptFile[] => {
      if (typeof f !== "object" || f === null) return [];
      const r = f as Record<string, unknown>;
      if (typeof r.path !== "string") return [];
      return [
        {
          path: r.path,
          status: typeof r.status === "string" ? r.status : "modified",
          added: typeof r.added === "number" ? r.added : 0,
          removed: typeof r.removed === "number" ? r.removed : 0,
        },
      ];
    });
  } catch {
    return [];
  }
}

/**
 * Parse a `/commit` receipt from its `output` string. Returns `null` when the
 * output isn't an S02 summary (an older ad-hoc receipt, or a truncated row) —
 * the caller then renders the generic block. A legacy record with no `files:`
 * line parses with an empty {@link ParsedCommitReceipt.files}.
 */
export function parseCommitReceipt(output: string): ParsedCommitReceipt | null {
  const lines = output.split("\n");
  const head = HEAD_RE.exec(lines[0] ?? "");
  if (head === null) return null;
  let messageStart = 1;
  let files: CommitReceiptFile[] = [];
  if (lines[1]?.startsWith(FILES_PREFIX) === true) {
    files = parseFilesLine(lines[1]);
    messageStart = 2;
  }
  return {
    sha: head[1],
    // Drop a trailing newline/blank line the record may carry — under
    // `white-space: pre-wrap` it would paint as an empty row beneath the
    // message, reading as an oversized header ("no extra blank row").
    message: lines.slice(messageStart).join("\n").replace(/\s+$/, ""),
    fileCount: Number.parseInt(head[2], 10),
    added: Number.parseInt(head[3], 10),
    removed: Number.parseInt(head[4], 10),
    files,
  };
}
