/**
 * `SessionJoinReceiptBlock` / `SessionDiscardReceiptBlock` — the bespoke
 * `/arc-join` and `/arc-discard` command-block renderers ([P06]).
 *
 * A landed join and a discarded arc each leave one shell-exchange row whose
 * `output` is the server-formatted summary (Specs S01 / S02). These renderers
 * parse that string and present it as a receipt — instead of the generic
 * fenced `ShellExchangeBlock`.
 *
 * The two are deliberately different shapes, because the two acts are.
 *
 * A join swaps the base the card sits on, so the row it settles into the
 * transcript is a {@link SessionBoundary} — the same shape a compaction and a
 * stage rotation wear, because all three are the ground moving underneath the
 * conversation rather than something a participant said. The bar is the row a
 * reader meets: `GitMerge`, the event `Joined <arc> into <base>`, the sha and
 * the squash subject as its detail, and the file / ± / round badges trailing.
 * The commit receipt folds behind it, the way the recap folds behind a
 * compaction — and it is still the commit receipt, because a join IS a commit
 * on the base and a reader should not have to learn a second shape for it:
 * the `arc → base` identity line and its fit, the message, and the same
 * expandable `CommitChangesList` rows. The receipt's own chrome is gone
 * rather than nested inside the boundary's; the fold is built from its body
 * pieces, so there is one frame on screen and not a block inside a block.
 *
 * A discard lands nothing — it is not a boundary, since no ground moved — so
 * it keeps the bespoke receipt shape: its identity is the arc that stopped
 * existing and its body is what went with it.
 *
 * The live `ArcJoinRegister` is untouched by all of this. It narrates the
 * join's beats at the transcript's live edge, on the Arcs card row and on the
 * composer's status row, and status stays a register ([D142], [D111]). What
 * changed is only the row that SETTLES here afterwards: it used to be a second
 * register wearing a command's outcome idiom at the body column's inset, and
 * it is now the boundary, at the transcript's edge.
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

import { GitMerge } from "lucide-react";

import { CommitShaText } from "@/components/tugways/commit-sha-text";
import { CommitMessage } from "@/components/tugways/commit-presentation";
import { markdownTextParts } from "@/components/tugways/tug-markdown-text";
import { useCommitIdentityMenu } from "@/components/tugways/commit-identity-menu";
import { CommitChangesList } from "@/components/tugways/tug-changes-list";
import { useAnnotatedElement } from "@/components/tugways/annotation-scope";
import { SessionBoundary } from "@/components/tugways/cards/session-boundary";
import { BlockChrome } from "../blocks/block-chrome";
import { ToolBlockHistoryCollapse } from "../blocks/collapse-context";
import "@/components/tugways/commit-presentation.css";
import {
  registerCommandBlock,
  type CommandBlockProps,
} from "./session-command-block-registry";
import type { ShellExchangeMessage } from "@/lib/code-session-store/types";
import {
  FILES_PREFIX,
  parseFilesLine,
  type CommitReceiptFile,
} from "./session-commit-receipt-block";
import { ShellExchangeBlock } from "./shell-exchange-block";
import { matchesJoinReceipt } from "@/lib/landing-mode";
import "./session-join-receipt-block.css";

/** The display facts parsed from an S01 join summary. */
export interface ParsedJoinReceipt {
  /** The landing commit on the base branch. */
  sha: string;
  arc: string;
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
  /**
   * What the last green verify said about the tree this join landed, from the
   * `fit:` line. Absent for a receipt written before the line existed, and for
   * an arc nothing verified — the server omits the line rather than writing an
   * empty one, so both arrive here as the same absence.
   */
  fit?: { verified: boolean; head: string; base: string };
}

/** The display facts parsed from an S02 discard summary. */
export interface ParsedDiscardReceipt {
  arc: string;
  rounds: number;
  /** Files the arc touched, from its range diff; 0 when the header omits them. */
  files: number;
  /** The round subjects the discard preflight showed. */
  subjects: string[];
}

// The S01 / S02 headers, matched exactly — `·` is U+00B7 and `→` U+2192, so a
// hand-typed arrow or dot never false-parses into a receipt.
//   joined <sha> · <arc> → <base> · <N> round(s)
//   discarded <arc> · <N> round(s)[, <M> file(s)]
const JOIN_HEAD_RE = /^joined (\S+) · (\S+) → (\S+) · (\d+) round\(s\)$/;
const DISCARD_HEAD_RE = /^discarded (\S+) · (\d+) round\(s\)(?:, (\d+) file\(s\))?$/;

// The optional fit line, between the header and `files:`:
//   fit: verified <head> onto <base>
const FIT_RE = /^fit: (verified|stale) (\S+) onto (\S+)$/;

// The header the verb wrote before it was renamed, when it led with `released`
// and then said `discarded` again in front of the count. A transcript is
// replayed from its JSONL on every card reload, so every receipt already
// written keeps arriving here forever; this pattern is read and never written.
const HISTORICAL_DISCARD_HEAD_RE =
  /^released (\S+) · discarded (\d+) round\(s\)(?:, (\d+) file\(s\))?$/;

/**
 * Parse a `/arc-join` receipt from its `output` string, or `null` when the
 * output is not an S01 summary — a truncated row, or one written before the
 * format existed. The caller then renders the raw output rather than nothing.
 *
 * Every line after the header is claimed by its own **prefix**, and the
 * message begins wherever the cursor stops. That is what makes every join
 * receipt already in JSONL keep parsing forever: a transcript replays from its
 * record on every card reload, so a parser that read `files:` at a fixed index
 * would orphan the file list of every past join the moment a line was added
 * above it. An unrecognized line ends the optional block and belongs to the
 * message; only a header that does not match yields `null`, which is what
 * sends the row to the generic shell block.
 */
export function parseJoinReceipt(output: string): ParsedJoinReceipt | null {
  const lines = output.split("\n");
  const head = JOIN_HEAD_RE.exec(lines[0] ?? "");
  if (head === null) return null;
  let cursor = 1;
  let files: CommitReceiptFile[] = [];
  let fit: ParsedJoinReceipt["fit"];
  const fitLine = FIT_RE.exec(lines[cursor] ?? "");
  if (fitLine !== null) {
    fit = { verified: fitLine[1] === "verified", head: fitLine[2], base: fitLine[3] };
    cursor += 1;
  }
  if (lines[cursor]?.startsWith(FILES_PREFIX) === true) {
    files = parseFilesLine(lines[cursor] ?? "");
    cursor += 1;
  }
  const messageStart = cursor;
  return {
    sha: head[1],
    arc: head[2],
    base: head[3],
    rounds: Number.parseInt(head[4], 10),
    // A trailing blank line would paint as an empty row under `pre-wrap`.
    message: lines.slice(messageStart).join("\n").replace(/\s+$/, ""),
    files,
    fit,
  };
}

/**
 * Parse an `/arc-discard` receipt, or `null` on a non-matching first line.
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
    arc: head[1],
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
    <JoinBoundary
      parsed={parsed}
      cwd={props.message.cwd}
      exchangeId={props.message.exchangeId}
    />
  );
}

/**
 * The settled join, as a boundary with its receipt folded behind it.
 *
 * The bar carries what a reader wants without opening anything: the event
 * names the two branches, the detail carries the landing sha and the squash
 * subject, and the trailing badges carry the files, the ± and the round count.
 * Behind the fold is the commit receipt's own body — a join IS a commit on the
 * base, so the reader who opens it meets the shape a `/commit` receipt has,
 * plus the one line a plain commit has no room for (`arc → base`, with the fit
 * beside it).
 *
 * The sha keeps `useCommitIdentityMenu` on the way up to the bar: a join
 * answers with the same four copies a `/commit` receipt and a History row
 * offer ([D142]'s one vocabulary), and the menu rides the atom alone because
 * the subject beside it is selectable transcript text whose right-click is the
 * standard editing block's.
 *
 * Composition, not re-implementation ([L19], [L20]): every part here is the
 * commit presentation's own component or the shared boundary, and this block
 * adds no rule that reaches inside their slots.
 */
function JoinBoundary({
  parsed,
  cwd,
  exchangeId,
}: {
  parsed: ParsedJoinReceipt;
  cwd: string;
  exchangeId: string;
}): React.ReactElement {
  const { sha, arc, base, rounds, message, files, fit } = parsed;
  const subject = message.split("\n", 1)[0];
  // A squash subject names what it touched and the scope tag is often a path —
  // annotated like the commit receipt's subject, whose `<code>` this mirrors.
  // The sha beside it is deliberately not annotated: `CommitShaText` owns every
  // pointer gesture on it, and the identity line around both owns the
  // right-click.
  const subjectRef = useAnnotatedElement<HTMLElement>([subject]);
  const body = message.slice(subject.length).replace(/^\n+/, "").replace(/\s+$/, "");
  const added = files.reduce((sum, f) => sum + f.added, 0);
  const removed = files.reduce((sum, f) => sum + f.removed, 0);
  // A receipt with no file list (legacy, or a non-squash join) falls back to
  // the identity in the header seat, so the header is never a bare sha.
  const headline = subject.length > 0 ? subject : `${arc} → ${base}`;
  const menu = useCommitIdentityMenu({
    commit: {
      sha,
      subject: headline,
      body,
      files,
      paths: files.map((f) => f.path),
    },
  });
  // The bar's detail: the landing sha, then the squash subject, continuing the
  // event's inline run so a long subject's second line returns flush under it.
  const detail = (
    <span className="session-boundary-detail join-boundary-detail">
      <span
        className="join-receipt-sha"
        ref={menu.ref}
        onContextMenu={menu.onContextMenu}
      >
        <CommitShaText sha={sha} menu={false} />
        {menu.contextMenu}
      </span>
      {" "}
      <code
        ref={subjectRef}
        className="join-receipt-summary"
        data-tugx-findable=""
      >
        {headline}
      </code>
    </span>
  );
  // The receipt, as the boundary's fold body: the commit receipt's own pieces
  // with no chrome of their own, so the boundary's bar is the only frame.
  const receipt = (
    <div className="join-receipt-body" data-slot="join-receipt-block">
      {subject.length > 0 ? (
        <div className="join-receipt-identity" data-slot="join-receipt-identity">
          <code data-tugx-findable="">
            {arc} → {base}
          </code>
          {fit !== undefined ? (
            <code
              data-slot="join-receipt-fit"
              data-verified={fit.verified}
              data-tugx-findable=""
            >
              fit {fit.verified ? "verified" : "stale"} {fit.head} onto {fit.base}
            </code>
          ) : null}
        </div>
      ) : null}
      {body.length > 0 ? (
        <CommitMessage body={body} dataSlot="join-receipt-detail" findable />
      ) : null}
      {/* The landed files as sha-backed rows, each expanding into the join
          commit's own hunks. `cwd` is the base repo dir the join ran in,
          persisted in the ledger by the same writer the commit receipt
          already resolves against ([L29] — passed through verbatim). */}
      {files.length > 0 ? (
        <CommitChangesList root={cwd} sha={sha} files={files} />
      ) : null}
    </div>
  );
  return (
    <SessionBoundary
      kind="join"
      // The receipt face: a receipt reads as prose, so the boundary's whole
      // subtree — the bar's subject and the fold's message body alike — takes
      // the proportional family the scope publishes. Worn on the root that
      // contains both, so the two can't part.
      className="tugx-commit-receipt"
      glyph={<GitMerge size={16} aria-hidden="true" />}
      // The register's own terminal sentence, in the boundary's voice — the
      // same two names `ArcJoinRegister` derives it from, off the receipt the
      // ledger already carries, so it reads identically live and on restore.
      event={`Joined ${arc} into ${base}`}
      detail={detail}
      // The file and ± badges only when there is a list behind them; the round
      // count is the join's own fact and always rides last.
      summary={[
        ...(files.length > 0
          ? [
              { kind: "count" as const, count: files.length, noun: "file" },
              { kind: "diff" as const, added, removed },
            ]
          : []),
        { kind: "count" as const, count: rounds, noun: "round" },
      ]}
      fold={receipt}
      // The receipt's own collapse key, kept across the move, so a reader who
      // opened a join finds it open on the next replay of the transcript.
      collapseKey={exchangeId}
      copyText={`${sha} ${message}`.trim()}
      // The receipt is rendered by the `$` cell, inside the entry's body
      // column; a boundary belongs to the transcript, so it pulls to the edge.
      inTurn
    />
  );
}

export function SessionDiscardReceiptBlock(props: CommandBlockProps): React.ReactElement {
  const parsed = parseDiscardReceipt(props.message.output);
  if (parsed === null) return <ShellExchangeBlock {...props} />;
  const { arc, rounds, files, subjects } = parsed;
  // No sha: a discard lands nothing. Its identity is the arc that stopped
  // existing, and its body is what went with it.
  const identity = (
    <span className="join-receipt-header">
      <code className="join-receipt-summary" data-tugx-findable="">{arc}</code>
    </span>
  );
  return (
    <ToolBlockHistoryCollapse toolUseId={props.message.exchangeId} defaultCollapsed={false}>
      <BlockChrome
        rootSlot="discard-receipt-block"
        className="tugx-commit-receipt"
        variant="receipt"
        identity={identity}
        flowTrailing
        resultSummary={[
          { kind: "count", count: rounds, noun: "round" },
          ...(files > 0 ? [{ kind: "count" as const, count: files, noun: "file" }] : []),
        ]}
        phase="success"
        status="ready"
        copyText={props.message.output}
      >
        {subjects.length > 0 ? (
          <CommitMessage
            body={subjects.join("\n")}
            dataSlot="discard-receipt-detail"
            findable
          />
        ) : null}
      </BlockChrome>
    </ToolBlockHistoryCollapse>
  );
}

/**
 * Claims `/arc-discard`, on the same terms — and `/dash-discard` and
 * `/dash-release`, the commands the verb wrote under its two earlier names.
 * Those rows are in session JSONL and are replayed on every card reload, so
 * dropping either retired spelling would turn every discard already recorded
 * back into a raw shell row ([F19]).
 */
export function matchesDiscardReceipt(command: string): boolean {
  return (
    command === "/arc-discard" ||
    command.startsWith("/arc-discard ") ||
    command === "/dash-discard" ||
    command.startsWith("/dash-discard ") ||
    command === "/dash-release" ||
    command.startsWith("/dash-release ")
  );
}

/**
 * The join boundary's searchable text, in render order and gated on the fold.
 *
 * The bar is always on screen, so the headline always projects — it is the
 * detail run's marked `<code>`, beside the sha. Everything else is the fold
 * body and is unmounted while the boundary is collapsed: the `arc → base`
 * line, its fit note, and the message. Projecting those while folded would
 * count matches no painter could reach, which is the failure the whole
 * declare-both-halves rule exists to prevent — and the reason this function
 * is handed the fold state rather than reading the parse alone.
 *
 * `null` when the output does not parse: the row renders as a plain exchange
 * then, and projects as one.
 *
 * The landed-files list is deliberately absent, on the refs block's terms —
 * its rows are a fold state the index cannot observe.
 */
export function joinReceiptFindParts(
  message: ShellExchangeMessage,
  collapsed: boolean,
): string[] | null {
  const parsed = parseJoinReceipt(message.output);
  if (parsed === null) return null;
  const subject = parsed.message.split("\n", 1)[0] ?? "";
  const body = parsed.message
    .slice(subject.length)
    .replace(/^\n+/, "")
    .replace(/\s+$/, "");
  const headline = subject.length > 0 ? subject : `${parsed.arc} → ${parsed.base}`;
  // The event names both branches and is a marked container in its own right,
  // so a reader searching for either finds the row whether or not it is open.
  const parts = [`Joined ${parsed.arc} into ${parsed.base}`, headline];
  if (collapsed) return parts;
  // The identity line renders only when there IS a subject — otherwise the
  // headline already carries `arc → base` and the line would repeat it.
  if (subject.length > 0) {
    parts.push(`${parsed.arc} → ${parsed.base}`);
    if (parsed.fit !== undefined) {
      parts.push(
        `fit ${parsed.fit.verified ? "verified" : "stale"} ${parsed.fit.head} onto ${parsed.fit.base}`,
      );
    }
  }
  return [...parts, ...markdownTextParts(body)];
}

/** The discard receipt's: the arc it ended, then the subjects that went
 *  with it — the two containers that block marks findable. */
export function discardReceiptFindParts(
  message: ShellExchangeMessage,
): string[] | null {
  const parsed = parseDiscardReceipt(message.output);
  if (parsed === null) return null;
  return [parsed.arc, ...markdownTextParts(parsed.subjects.join("\n"))];
}

// Registration is a side effect of importing this module (the import sits
// beside the commit block's in `session-card-transcript.tsx`, so both are
// registered before the first resolve).
registerCommandBlock("arc-join-receipt", matchesJoinReceipt, SessionJoinReceiptBlock, {
  // A join squashes the arc onto the base and commits it. That is the same
  // act `/commit` performs, differently started, so it wears the same
  // attribution — the discard below deletes a branch and commits nothing, so
  // it keeps the shell default.
  attribution: "git",
  findParts: joinReceiptFindParts,
});
registerCommandBlock(
  "arc-discard-receipt",
  matchesDiscardReceipt,
  SessionDiscardReceiptBlock,
  { findParts: discardReceiptFindParts },
);
