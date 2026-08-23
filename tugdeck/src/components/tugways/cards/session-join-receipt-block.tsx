/**
 * `SessionJoinReceiptBlock` / `SessionDiscardReceiptBlock` — the bespoke
 * `/dash-join` and `/dash-discard` command-block renderers ([P06]).
 *
 * A landed join and a discarded dash each leave one shell-exchange row whose
 * `output` is the server-formatted summary (Specs S01 / S02). These renderers
 * parse that string and present it as a receipt — instead of the generic
 * fenced `ShellExchangeBlock`.
 *
 * The two receipts are deliberately different shapes, because the two acts
 * are. A join lands a commit on the base, so its receipt IS the commit
 * receipt: the same sha-led header, the same badges, the same expandable file
 * rows, plus the one line a plain commit cannot carry (`dash → base`). A
 * discard lands nothing, so it keeps the bespoke shape — its identity is the
 * dash that stopped existing and its body is what went with it.
 *
 * Everything on screen is parsed from the row itself, so the live append and
 * the ledger restore render byte-identically; a parse miss falls back to the
 * generic block, which is the same discipline the commit receipt keeps. The
 * summary string is the single source: it is formatted once, on the server,
 * and never rebuilt here.
 *
 * @module components/tugways/cards/session-join-receipt-block
 */

import type React from "react";

import { CommitShaText } from "@/components/tugways/commit-sha-text";
import { CommitMessage } from "@/components/tugways/commit-presentation";
import { CommitChangesList } from "@/components/tugways/tug-changes-list";
import { useAnnotatedElement } from "@/components/tugways/annotation-scope";
import { BlockChrome } from "../blocks/block-chrome";
import { ToolBlockHistoryCollapse } from "../blocks/collapse-context";
import "@/components/tugways/commit-presentation.css";
import {
  registerCommandBlock,
  type CommandBlockProps,
} from "./session-command-block-registry";
import {
  FILES_PREFIX,
  parseFilesLine,
  type CommitReceiptFile,
} from "./session-commit-receipt-block";
import { ShellExchangeBlock } from "./shell-exchange-block";
import "./session-join-receipt-block.css";

/** The display facts parsed from an S01 join summary. */
export interface ParsedJoinReceipt {
  /** The landing commit on the base branch. */
  sha: string;
  dash: string;
  base: string;
  rounds: number;
  /** The squash message the join landed with, verbatim. */
  message: string;
  /**
   * The files the join landed (from the `files:` line). Empty for a receipt
   * written before the line existed, and for a non-squash join — the server
   * omits the line rather than writing a partial list, so both arrive here as
   * the same absence and render the same way.
   */
  files: CommitReceiptFile[];
}

/** The display facts parsed from an S02 discard summary. */
export interface ParsedDiscardReceipt {
  dash: string;
  rounds: number;
  /** Files the dash touched, from its range diff; 0 when the header omits them. */
  files: number;
  /** The round subjects the discard preflight showed. */
  subjects: string[];
}

// The S01 / S02 headers, matched exactly — `·` is U+00B7 and `→` U+2192, so a
// hand-typed arrow or dot never false-parses into a receipt.
//   joined <sha> · <dash> → <base> · <N> round(s)
//   discarded <dash> · <N> round(s)[, <M> file(s)]
const JOIN_HEAD_RE = /^joined (\S+) · (\S+) → (\S+) · (\d+) round\(s\)$/;
const DISCARD_HEAD_RE = /^discarded (\S+) · (\d+) round\(s\)(?:, (\d+) file\(s\))?$/;

// The header the verb wrote before it was renamed, when it led with `released`
// and then said `discarded` again in front of the count. A transcript is
// replayed from its JSONL on every card reload, so every receipt already
// written keeps arriving here forever; this pattern is read and never written.
const HISTORICAL_DISCARD_HEAD_RE =
  /^released (\S+) · discarded (\d+) round\(s\)(?:, (\d+) file\(s\))?$/;

/**
 * Parse a `/dash-join` receipt from its `output` string, or `null` when the
 * output is not an S01 summary — a truncated row, or one written before the
 * format existed. The caller then renders the raw output rather than nothing.
 *
 * Line 1 is the file list only when it carries the `files: ` prefix, which is
 * exactly `parseCommitReceipt`'s discipline. That one test is what makes every
 * join receipt already in JSONL keep parsing forever: a transcript replays
 * from its record on every card reload, so a format change that orphaned the
 * old shape would turn every recorded join back into a raw shell row.
 */
export function parseJoinReceipt(output: string): ParsedJoinReceipt | null {
  const lines = output.split("\n");
  const head = JOIN_HEAD_RE.exec(lines[0] ?? "");
  if (head === null) return null;
  let messageStart = 1;
  let files: CommitReceiptFile[] = [];
  if (lines[1]?.startsWith(FILES_PREFIX) === true) {
    files = parseFilesLine(lines[1]);
    messageStart = 2;
  }
  return {
    sha: head[1],
    dash: head[2],
    base: head[3],
    rounds: Number.parseInt(head[4], 10),
    // A trailing blank line would paint as an empty row under `pre-wrap`.
    message: lines.slice(messageStart).join("\n").replace(/\s+$/, ""),
    files,
  };
}

/**
 * Parse a `/dash-discard` receipt, or `null` on a non-matching first line.
 *
 * The current header is tried first and the historical one second. Both yield
 * the same facts in the same capture positions, but they are written as two
 * patterns rather than one alternation because only one of them is a shape
 * this code still produces.
 */
export function parseDiscardReceipt(output: string): ParsedDiscardReceipt | null {
  const lines = output.split("\n");
  const head =
    DISCARD_HEAD_RE.exec(lines[0] ?? "") ??
    HISTORICAL_DISCARD_HEAD_RE.exec(lines[0] ?? "");
  if (head === null) return null;
  return {
    dash: head[1],
    rounds: Number.parseInt(head[2], 10),
    files: head[3] === undefined ? 0 : Number.parseInt(head[3], 10),
    subjects: lines
      .slice(1)
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
  };
}

export function SessionJoinReceiptBlock(props: CommandBlockProps): React.ReactElement {
  const parsed = parseJoinReceipt(props.message.output);
  if (parsed === null) return <ShellExchangeBlock {...props} />;
  return (
    <JoinReceipt
      parsed={parsed}
      cwd={props.message.cwd}
      exchangeId={props.message.exchangeId}
    />
  );
}

/**
 * The parsed join receipt, on the commit receipt's skeleton — a join IS a
 * commit on the base, and the reader should not have to learn a second shape
 * for the same kind of fact. So the sha and the squash subject lead the header
 * exactly as they do on a `/commit`, the file and ± badges ride the header's
 * trailing summaries, and the landed files are the same expandable
 * `CommitChangesList` rows.
 *
 * One line is the join's own: `dash → base`, the identity a plain commit has
 * no room for. It sits above the message body rather than in the header,
 * because the header seat belongs to the subject under commit parity.
 *
 * Composition, not re-implementation ([L19], [L20]): every part here is the
 * commit presentation's own component, and this block adds no rule that
 * reaches inside their slots.
 */
function JoinReceipt({
  parsed,
  cwd,
  exchangeId,
}: {
  parsed: ParsedJoinReceipt;
  cwd: string;
  exchangeId: string;
}): React.ReactElement {
  const { sha, dash, base, rounds, message, files } = parsed;
  const subject = message.split("\n", 1)[0];
  // A squash subject names what it touched and the scope tag is often a path —
  // annotated like the commit receipt's subject, whose `<code>` this mirrors.
  // The sha beside it is deliberately not annotated: `CommitShaText` owns every
  // pointer gesture on it for its own copy menu.
  const subjectRef = useAnnotatedElement<HTMLElement>([subject]);
  const body = message.slice(subject.length).replace(/^\n+/, "").replace(/\s+$/, "");
  const added = files.reduce((sum, f) => sum + f.added, 0);
  const removed = files.reduce((sum, f) => sum + f.removed, 0);
  // A receipt with no file list (legacy, or a non-squash join) falls back to
  // the identity in the header seat, so the header is never a bare sha.
  const headline = subject.length > 0 ? subject : `${dash} → ${base}`;
  const identity = (
    <span className="join-receipt-header">
      <CommitShaText sha={sha} />
      {" "}
      <code ref={subjectRef} className="join-receipt-summary">{headline}</code>
    </span>
  );
  return (
    <ToolBlockHistoryCollapse toolUseId={exchangeId} defaultCollapsed={false}>
      <BlockChrome
        rootSlot="join-receipt-block"
        variant="receipt"
        identity={identity}
        // The file and ± badges only when there is a list behind them; the
        // round count is the join's own fact and always rides last.
        resultSummary={[
          ...(files.length > 0
            ? [
                { kind: "count" as const, count: files.length, noun: "file" },
                { kind: "diff" as const, added, removed },
              ]
            : []),
          { kind: "count" as const, count: rounds, noun: "round" },
        ]}
        phase="success"
        status="ready"
        copyText={`${sha} ${message}`.trim()}
      >
        {subject.length > 0 ? (
          <div className="join-receipt-identity" data-slot="join-receipt-identity">
            <code>
              {dash} → {base}
            </code>
          </div>
        ) : null}
        {body.length > 0 ? (
          <CommitMessage body={body} dataSlot="join-receipt-detail" />
        ) : null}
        {/* The landed files as sha-backed rows, each expanding into the join
            commit's own hunks. `cwd` is the base repo dir the join ran in,
            persisted in the ledger by the same writer the commit receipt
            already resolves against ([L29] — passed through verbatim). */}
        {files.length > 0 ? (
          <CommitChangesList root={cwd} sha={sha} files={files} />
        ) : null}
      </BlockChrome>
    </ToolBlockHistoryCollapse>
  );
}

export function SessionDiscardReceiptBlock(props: CommandBlockProps): React.ReactElement {
  const parsed = parseDiscardReceipt(props.message.output);
  if (parsed === null) return <ShellExchangeBlock {...props} />;
  const { dash, rounds, files, subjects } = parsed;
  // No sha: a discard lands nothing. Its identity is the dash that stopped
  // existing, and its body is what went with it.
  const identity = (
    <span className="join-receipt-header join-receipt-header-discard">
      <code className="join-receipt-summary">{dash}</code>
    </span>
  );
  return (
    <ToolBlockHistoryCollapse toolUseId={props.message.exchangeId} defaultCollapsed={false}>
      <BlockChrome
        rootSlot="discard-receipt-block"
        variant="receipt"
        identity={identity}
        resultSummary={[
          { kind: "count", count: rounds, noun: "round" },
          ...(files > 0 ? [{ kind: "count" as const, count: files, noun: "file" }] : []),
        ]}
        phase="success"
        status="ready"
        copyText={props.message.output}
      >
        {subjects.length > 0 ? (
          <CommitMessage body={subjects.join("\n")} dataSlot="discard-receipt-detail" />
        ) : null}
      </BlockChrome>
    </ToolBlockHistoryCollapse>
  );
}

/** Claims `/dash-join`, with or without the argument form the verb accepts. */
export function matchesJoinReceipt(command: string): boolean {
  return command === "/dash-join" || command.startsWith("/dash-join ");
}

/**
 * Claims `/dash-discard`, on the same terms — and `/dash-release`, the command
 * the verb wrote under its old name. Those rows are in session JSONL and are
 * replayed on every card reload, so dropping the second spelling would turn
 * every discard already recorded back into a raw shell row.
 */
export function matchesDiscardReceipt(command: string): boolean {
  return (
    command === "/dash-discard" ||
    command.startsWith("/dash-discard ") ||
    command === "/dash-release" ||
    command.startsWith("/dash-release ")
  );
}

// Registration is a side effect of importing this module (the import sits
// beside the commit block's in `session-card-transcript.tsx`, so both are
// registered before the first resolve).
registerCommandBlock("dash-join-receipt", matchesJoinReceipt, SessionJoinReceiptBlock);
registerCommandBlock(
  "dash-discard-receipt",
  matchesDiscardReceipt,
  SessionDiscardReceiptBlock,
);
