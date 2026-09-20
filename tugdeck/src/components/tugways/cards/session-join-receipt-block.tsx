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
 * **A join settles as two rows, and each carries its own kind** ([B01],
 * [B02]). A join lands a commit on the base, so the `Git Commit` entry it is
 * attributed to carries the commit receipt — the sha atom and the squash
 * subject on the header, the file and ± badges beside them, the message and
 * the expandable `CommitChangesList` beneath, expanded by default, exactly as
 * a `/commit` reads. A reader should not have to learn a second shape for the
 * same act. The one line a plain commit has no room for stays with it: the
 * `arc → base` identity and its fit, which are facts about this commit.
 *
 * A join also swaps the base the card sits on, so a {@link SessionBoundary}
 * follows the entry — the same shape a compaction and a stage rotation wear,
 * because all three are the ground moving underneath the conversation rather
 * than something a participant said. Its bar is `GitMerge`, the event
 * `Joined <arc> into <base>`, and the `N stages · N rounds` counts; behind
 * its fold is the arc's own record, the way the recap folds behind a
 * compaction. **No sha and no subject on the bar** — the receipt above names
 * the commit, and naming it twice is the doubling this shape ends ([B06]).
 *
 * The `/arc-run` row the arc's own ending leaves is a quiet line rather than
 * a second report of the same event ([B04]); the record it used to carry is
 * what this boundary folds.
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
 * it is now the commit receipt in the entry with the boundary beneath it, at
 * the transcript's edge.
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
import { requestCommitCard } from "@/lib/open-commit-in-card";
import { CommitChangesList } from "@/components/tugways/tug-changes-list";
import { useAnnotatedElement } from "@/components/tugways/annotation-scope";
import { SessionBoundary } from "@/components/tugways/cards/session-boundary";
import { ArcLifecycleBlock } from "@/components/tugways/arc-lifecycle-block";
import { useCardId } from "@/components/tugways/use-card-state-preservation";
import {
  ArcRecordBlock,
  arcRecordFindParts,
  finishedArcTrackModel,
  type ArcReceiptStage,
} from "./session-arc-receipt-block";
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
  /**
   * The arc's own record, from the `arc: ` lines ([B03], [B08]) — the
   * document it opened on, the stages it walked, and the plan that came out.
   * Absent for a receipt written before the lines existed and for a join
   * whose arc log had nothing to say, which arrive here as the same absence
   * and fold behind the boundary as nothing at all.
   */
  record?: {
    document: string | null;
    stages: ArcReceiptStage[];
    plan: string | null;
  };
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

/**
 * The arc record's own prefix, one token for all three of its line kinds
 * ([B08]). Every line of the record wears it, so a squash message whose first
 * word is *plan* — or *opened* — is never read as the record: only a line
 * starting `arc: ` is a candidate, and a commit subject does not reach that
 * by accident.
 */
const ARC_PREFIX = "arc: ";
/**
 * A stage line's three fields, behind the prefix. Keyed on the closed stage
 * vocabulary for the same reason `session-arc-receipt-block`'s copy is: the
 * set of stages is fixed, while a model name or an id format can change.
 */
const ARC_STAGE_RE = /^(devise|review|implement|audit) · (.+) · (\S+)$/;

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
  // The record's run, claimed by its prefix like every optional line around
  // it, and read in the order the server writes them — between `fit:` and
  // `files:`. An `arc: ` line whose remainder matches none of the three kinds
  // is consumed and dropped rather than ending the run: the prefix is the
  // server's own, so a line wearing it belongs to the record whether or not
  // this build knows what it says, and letting it fall into the message
  // would put a machine line in the middle of a commit body.
  let record: ParsedJoinReceipt["record"];
  while (lines[cursor]?.startsWith(ARC_PREFIX) === true) {
    const line = (lines[cursor] ?? "").slice(ARC_PREFIX.length);
    cursor += 1;
    record ??= { document: null, stages: [], plan: null };
    if (line.startsWith("opened on ")) {
      record.document = line.slice("opened on ".length);
      continue;
    }
    if (line.startsWith("plan ")) {
      record.plan = line.slice("plan ".length);
      continue;
    }
    const stage = ARC_STAGE_RE.exec(line);
    if (stage !== null) {
      record.stages.push({ stage: stage[1], model: stage[2], sessionId: stage[3] });
    }
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
    record,
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
    <>
      <JoinCommitReceipt
        parsed={parsed}
        cwd={props.message.cwd}
        exchangeId={props.message.exchangeId}
      />
      <JoinBoundary parsed={parsed} exchangeId={props.message.exchangeId} />
    </>
  );
}

/**
 * The landing commit, in the `Git Commit` entry it is named for ([B01]).
 *
 * This is the `/commit` receipt's own shape, part for part: the sha atom and
 * the squash subject on the header, the file and ± badges beside them, the
 * message body and the expandable `CommitChangesList` beneath, expanded by
 * default. A join IS a commit on the base, and the entry the transcript
 * attributes to git is where a commit's content belongs — the empty entry it
 * replaces was the cost of putting that content on the boundary instead.
 *
 * The one thing a plain commit receipt has no room for stays here rather than
 * moving to the bar: the `arc → base` identity line and the fit beside it.
 * Those are facts about *this* commit — which branch it squashed and what the
 * last green verify said about the tree — not about the arc's life, which is
 * the boundary's fold.
 *
 * **Its fold is its own** (`<exchange>:commit`), separate from the boundary's,
 * because the two default oppositely: a receipt reads in full without a
 * gesture and a boundary reads folded. One key with two defaults is not a
 * thing, and a shared key would make one chevron move both.
 *
 * Composition, not re-implementation ([L19], [L20]): every part is the commit
 * presentation's own component, and nothing here reaches inside their slots.
 */
function JoinCommitReceipt({
  parsed,
  cwd,
  exchangeId,
}: {
  parsed: ParsedJoinReceipt;
  cwd: string;
  exchangeId: string;
}): React.ReactElement {
  // The card this receipt stands in, which a commit's card opens beside.
  const hostCardId = useCardId();
  const { sha, arc, base, message, files, fit } = parsed;
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
    // The base repo the join ran in — what lets the header's pill raise the
    // commit's card.
    root: cwd,
  });
  const identity = (
    <span className="commit-receipt-header">
      <span
        className="commit-receipt-sha"
        ref={menu.ref}
        onContextMenu={menu.onContextMenu}
      >
        <CommitShaText
          sha={sha}
          menu={false}
          onActivate={() =>
            requestCommitCard({ root: cwd, sha }, { subject: headline }, hostCardId)
          }
        />
        {menu.contextMenu}
      </span>
      {" "}
      <code
        ref={subjectRef}
        className="commit-receipt-summary"
        data-tugx-findable=""
      >
        {headline}
      </code>
    </span>
  );
  return (
    <ToolBlockHistoryCollapse toolUseId={`${exchangeId}:commit`} defaultCollapsed={false}>
      <BlockChrome
        rootSlot="join-receipt-block"
        // The receipt face: the subject in the header and the message body in
        // the chrome's body both read as prose, from the one scope class worn
        // on the root that contains them.
        className="tugx-commit-receipt"
        variant="receipt"
        identity={identity}
        flowTrailing
        // The file and ± badges only when there is a list behind them — a
        // non-squash join and a legacy row have none, and `0 file(s)` would be
        // a claim the receipt cannot make.
        resultSummary={
          files.length > 0
            ? [
                { kind: "count" as const, count: files.length, noun: "file" },
                { kind: "diff" as const, added, removed },
              ]
            : []
        }
        phase="success"
        status="ready"
        copyText={`${sha} ${message}`.trim()}
      >
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
      </BlockChrome>
    </ToolBlockHistoryCollapse>
  );
}

/**
 * The `Joined` boundary — the arc's life, folded behind the compaction's own
 * anatomy ([B02]).
 *
 * Rule, sunken bar, `GitMerge`, the bold event naming both branches, the
 * `N stages · N rounds` badges, and a chevron because something folds. What
 * folds is the arc's record: the lifecycle strip reading `Finished · N
 * stages`, the document it opened on, one row per stage with its model and
 * what it cost, and the plan that came out — which is what the Wheel's own
 * entry used to carry, in one place instead of two.
 *
 * **No sha and no subject on the bar.** The receipt above names the commit,
 * and naming it twice is the doubling this shape ends. That also settles the
 * pill's baseline question by removing the pill: the bar carries the event and
 * the counts, and the commit atom lives where commits are named ([B06]).
 *
 * The record's rows are {@link ArcRecordBlock} — the same composition the
 * `/arc-run` receipt renders — so a reader who learned the record there has
 * learned it here, and neither seat can drift.
 */
function JoinBoundary({
  parsed,
  exchangeId,
}: {
  parsed: ParsedJoinReceipt;
  exchangeId: string;
}): React.ReactElement {
  const { arc, base, rounds, record } = parsed;
  const stages = record?.stages ?? [];
  // A receipt with no record folds nothing: the boundary is then a bar and a
  // rule, which is the whole of what a pre-record join has to say and is the
  // same degradation the `fit:` and `files:` lines take.
  const fold =
    record === undefined ? undefined : (
      <div className="arc-receipt-body join-boundary-record" data-slot="join-boundary-record">
        <div className="join-boundary-record-strip">
          <ArcLifecycleBlock
            name={arc}
            worker={null}
            model={finishedArcTrackModel(record.document, record.plan)}
            note={`Finished · ${stages.length} ${stages.length === 1 ? "stage" : "stages"}`}
            layout="row"
          />
        </div>
        <ArcRecordBlock
          document={record.document}
          stages={stages}
          plan={record.plan}
        />
      </div>
    );
  return (
    <SessionBoundary
      kind="join"
      // The receipt face: the record's lines read as prose, so the boundary's
      // subtree takes the proportional family the scope publishes.
      className="tugx-commit-receipt"
      glyph={<GitMerge size={16} aria-hidden="true" />}
      // The register's own terminal sentence, in the boundary's voice — the
      // same two names `ArcJoinRegister` derives it from, off the receipt the
      // ledger already carries, so it reads identically live and on restore.
      event={`Joined ${arc} into ${base}`}
      // The stage count only when the record carried stages; the round count
      // is the join's own fact and always rides last.
      summary={[
        ...(stages.length > 0
          ? [{ kind: "count" as const, count: stages.length, noun: "stage" }]
          : []),
        { kind: "count" as const, count: rounds, noun: "round" },
      ]}
      fold={fold}
      // The row's fold state, and the one the search index resolves against —
      // `transcript-search-index.ts` reads the exchange id with the boundary's
      // own default, so this key is what `joinReceiptFindParts` is told about.
      collapseKey={exchangeId}
      copyText={`Joined ${arc} into ${base}`}
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
 * The landing row's searchable text, in render order and gated on the fold.
 *
 * The row is two things in document order — the commit receipt in the entry's
 * body column, then the boundary at the transcript's edge — and this projects
 * them in that order, because units pair POSITIONALLY with the containers the
 * painter walks.
 *
 * **The `collapsed` it is handed is the BOUNDARY's**, and only the boundary's:
 * `transcript-search-index.ts` resolves the exchange id with the boundary's
 * own `defaultCollapsed`, which is the key {@link JoinBoundary} carries. So
 * the arc record — the one thing behind that fold — is the one thing gated on
 * it. Projecting the record while folded would count matches no painter could
 * reach, the failure the declare-both-halves rule exists to prevent.
 *
 * The receipt's parts are ungated, on the same terms `/commit`'s own receipt
 * projects on: its fold is a separate key the index does not resolve, it
 * defaults expanded, and its identity line is on the chrome's header and
 * mounted either way.
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
  // The receipt, first: the header's subject, then the body regions beneath.
  const parts = [headline];
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
  parts.push(...markdownTextParts(body));
  // Then the boundary: the event names both branches and is a marked
  // container in its own right, so a reader searching for either finds the row
  // whether or not it is open.
  parts.push(`Joined ${parsed.arc} into ${parsed.base}`);
  if (collapsed || parsed.record === undefined) return parts;
  return [...parts, ...arcRecordFindParts(parsed.record)];
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
