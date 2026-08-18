/**
 * `SessionJoinReceiptBlock` / `SessionDiscardReceiptBlock` — the bespoke
 * `/dash-join` and `/dash-discard` command-block renderers ([P06]).
 *
 * A landed join and a discarded dash each leave one shell-exchange row whose
 * `output` is the server-formatted summary (Specs S01 / S02). These renderers
 * parse that string and present it as a receipt — the landing sha and the dash
 * it came from, the message it landed with; or the dash and exactly what the
 * discard destroyed — instead of the generic fenced `ShellExchangeBlock`.
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
import { BlockChrome } from "../blocks/block-chrome";
import { ToolBlockHistoryCollapse } from "../blocks/collapse-context";
import "@/components/tugways/commit-presentation.css";
import {
  registerCommandBlock,
  type CommandBlockProps,
} from "./session-command-block-registry";
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
 */
export function parseJoinReceipt(output: string): ParsedJoinReceipt | null {
  const lines = output.split("\n");
  const head = JOIN_HEAD_RE.exec(lines[0] ?? "");
  if (head === null) return null;
  return {
    sha: head[1],
    dash: head[2],
    base: head[3],
    rounds: Number.parseInt(head[4], 10),
    // A trailing blank line would paint as an empty row under `pre-wrap`.
    message: lines.slice(1).join("\n").replace(/\s+$/, ""),
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
  const { sha, dash, base, rounds, message } = parsed;
  // The landing sha leads, exactly where the commit receipt puts it — a join
  // IS a commit on the base, and the reader should not have to learn a second
  // skeleton for it. The dash and its base follow as the identity that commit
  // alone could not carry.
  const identity = (
    <span className="join-receipt-header">
      <CommitShaText sha={sha} />
      {" "}
      <code className="join-receipt-summary">
        {dash} → {base}
      </code>
    </span>
  );
  return (
    <ToolBlockHistoryCollapse toolUseId={props.message.exchangeId} defaultCollapsed={false}>
      <BlockChrome
        rootSlot="join-receipt-block"
        variant="receipt"
        identity={identity}
        resultSummary={[{ kind: "count", count: rounds, noun: "round" }]}
        phase="success"
        status="ready"
        copyText={`${sha} ${message}`.trim()}
      >
        {message.length > 0 ? (
          <CommitMessage body={message} dataSlot="join-receipt-detail" />
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
