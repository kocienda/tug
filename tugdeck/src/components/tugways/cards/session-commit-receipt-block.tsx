/**
 * `SessionCommitReceiptBlock` — the bespoke `/commit` command-block renderer
 * ([P08]). A committed `/commit` row lands in the transcript as a shell
 * exchange whose `output` is the server-formatted standard summary (S02); this
 * renderer parses that string and presents it as a commit receipt (up to three
 * message lines, sha badge, file + one combined ± count badge) instead of the
 * generic fenced `ShellExchangeBlock`.
 *
 * Registration is a side effect of importing this module — the matcher claims
 * trimmed commands that are `/commit` or start with `"/commit "`, so the same
 * row renders identically live and after a restore ([D111] shell-ledger
 * replay). Every display fact is parsed from the exchange row itself — the
 * `output` string plus the ledger-persisted `cwd` (the repo dir the commit
 * diff fetch resolves against) — so the live and restored rows are
 * pixel-identical; a parse miss falls back to the generic block so raw output
 * always renders.
 *
 * The receipt carries one fold: the chrome's header chevron, which folds the
 * message body and the file list away behind the identity line. It defaults
 * expanded.
 *
 * @module components/tugways/cards/session-commit-receipt-block
 */

import type React from "react";

import { CommitShaText } from "@/components/tugways/commit-sha-text";
import { CommitMessage } from "@/components/tugways/commit-presentation";
import { markdownTextParts } from "@/components/tugways/tug-markdown-text";
import { useCommitIdentityMenu } from "@/components/tugways/commit-identity-menu";
import { CommitChangesList } from "@/components/tugways/tug-changes-list";
import { useAnnotatedElement } from "@/components/tugways/annotation-scope";
import { BlockChrome } from "../blocks/block-chrome";
import { ToolBlockHistoryCollapse } from "../blocks/collapse-context";
import "@/components/tugways/commit-presentation.css";
import {
  registerCommandBlock,
  type CommandBlockProps,
} from "./session-command-block-registry";
import type { ShellExchangeMessage } from "@/lib/code-session-store/types";
import { ShellExchangeBlock } from "./shell-exchange-block";
import "./session-commit-receipt-block.css";

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

export function SessionCommitReceiptBlock(props: CommandBlockProps): React.ReactElement {
  const parsed = parseCommitReceipt(props.message.output);
  if (parsed === null) {
    // Not an S02 summary — let the generic exchange block render raw output.
    return <ShellExchangeBlock {...props} />;
  }
  return (
    <CommitReceipt
      parsed={parsed}
      cwd={props.message.cwd}
      exchangeId={props.message.exchangeId}
    />
  );
}

/**
 * The parsed receipt: the commit's summary line over its file list. The block
 * owns its own whole-block fold — it wraps itself in
 * {@link ToolBlockHistoryCollapse}, which is what makes `BlockChrome` render
 * the header chevron on the far right — so the message body and the file list
 * can be folded away behind the identity line. It defaults EXPANDED: a landed
 * commit reads in full without a gesture, and collapsing is the reader's
 * choice. Keyed on the exchange id, so that choice survives a windowed remount
 * and a restore.
 */
function CommitReceipt({
  parsed,
  cwd,
  exchangeId,
}: {
  parsed: ParsedCommitReceipt;
  cwd: string;
  exchangeId: string;
}): React.ReactElement {
  const { sha, message, fileCount, added, removed, files } = parsed;
  // The header carries the subject — the message's first line — so it reads
  // like the Bash header's command line; the body (when there is one) follows
  // below it, above the file list.
  const subject = message.split("\n", 1)[0];
  // A commit subject names what it touched (`tugarc(annotator-perf): …`), and
  // the scope tag often IS a path. Annotated like the Bash header's command
  // line, whose `<code>` this mirrors. The sha beside it is deliberately NOT
  // annotated — `CommitShaText` already owns every pointer gesture on it, and
  // the identity line around both owns the right-click.
  const subjectRef = useAnnotatedElement<HTMLElement>([subject]);
  const body = message.slice(subject.length).replace(/^\n+/, "").replace(/\s+$/, "");
  // The same menu the History shade's rows carry, minus the fold they alone
  // have: a commit reads identically wherever it appears, and so should the
  // press on it. Claimed by the ATOM alone, not the whole identity line — the
  // subject beside it is transcript text a reader selects, and its right-click
  // belongs to the standard editing block. The atom stands its own single-item
  // Copy down in favor of this one.
  const menu = useCommitIdentityMenu({
    commit: { sha, subject, body, files, paths: files.map((f) => f.path) },
  });
  // The commit atom stands where a tool block's verb would: the commit names
  // itself — `commit:<8>`, glyph and all — then a single space, then the
  // subject. The same identity line the History shade's rows lead with, so a
  // commit reads identically wherever it appears. The atom's glyph and word
  // are what separate the two; a heavier delimiter only spent width.
  const identity = (
    <span className="commit-receipt-header">
      <span
        className="commit-receipt-sha"
        ref={menu.ref}
        onContextMenu={menu.onContextMenu}
      >
        <CommitShaText sha={sha} menu={false} />
        {menu.contextMenu}
      </span>
      {" "}
      <code
        ref={subjectRef}
        className="commit-receipt-summary"
        data-tugx-findable=""
      >
        {subject}
      </code>
    </span>
  );
  return (
    <ToolBlockHistoryCollapse toolUseId={exchangeId} defaultCollapsed={false}>
      <BlockChrome
        rootSlot="commit-receipt-block"
        variant="receipt"
        identity={identity}
        // The file count and diff stat as standard header result summaries —
        // the same pipe-sectioned ghost badges every tool block reports with.
        resultSummary={[
          { kind: "count", count: fileCount, noun: "file" },
          { kind: "diff", added, removed },
        ]}
        phase="success"
        status="ready"
        copyText={`${sha} ${message}`.trim()}
      >
        {/* The message body reads exactly as it does in an expanded History
            row — same `.tugx-commit-message` scale — and sits ABOVE the file
            list, which can run arbitrarily long. Both fold together under the
            header chevron; expanded is the default. */}
        {body.length > 0 ? (
          <CommitMessage body={body} dataSlot="commit-receipt-detail" findable />
        ) : null}
        {/* The committed files as sha-backed changes rows ([P08]) — the same
            compact rows as the live list, each expanding into the committed
            hunks (lazy per-row `commit`-flavor fetch). `cwd` is the repo dir
            the `/commit` ran in — persisted in the ledger, so live and
            restored rows resolve the same workspace. */}
        {files.length > 0 ? (
          <CommitChangesList root={cwd} sha={sha} files={files} />
        ) : null}
      </BlockChrome>
    </ToolBlockHistoryCollapse>
  );
}

/**
 * The command-block matcher: claims a trimmed command that is exactly
 * `/commit` or carries an argument (`/commit <message>`). The ledger always
 * writes `/commit`; the argument form is defensive.
 */
export function matchesCommitReceipt(command: string): boolean {
  return command === "/commit" || command.startsWith("/commit ");
}

/**
 * The receipt's searchable text, in render order: the subject on the
 * identity line, then the message body as the markdown styler lays it out —
 * the two containers the block marks `data-tugx-findable`. An output this
 * block cannot parse falls through to `ShellExchangeBlock` — `null` says so,
 * and the index projects that row as the plain exchange it renders as.
 *
 * The file list is deliberately absent, on the refs block's terms: which
 * rows it shows is a fold state the index cannot observe, so counting them
 * would desync the badge from the paint the first time a reader folds one.
 */
export function commitReceiptFindParts(
  message: ShellExchangeMessage,
): string[] | null {
  const parsed = parseCommitReceipt(message.output);
  if (parsed === null) return null;
  const subject = parsed.message.split("\n", 1)[0] ?? "";
  const body = parsed.message
    .slice(subject.length)
    .replace(/^\n+/, "")
    .replace(/\s+$/, "");
  return [subject, ...markdownTextParts(body)];
}

// Registration happens at import time (the side-effect import in
// session-card-transcript.tsx loads it before the first resolve, [P08]).
registerCommandBlock("commit-receipt", matchesCommitReceipt, SessionCommitReceiptBlock, {
  // A commit rides the shell ledger, but the user typed no shell command: the
  // row is a git operation and its header says so.
  attribution: "git",
  findParts: commitReceiptFindParts,
});
