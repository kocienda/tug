/**
 * `SessionPushReceiptBlock` — the bespoke `/push` command-block renderer.
 *
 * A push lands in the transcript as a shell exchange whose `output` is the
 * server-formatted summary (Spec S01); this renderer parses that string and
 * presents it as a push receipt — where the branch went, how many commits went
 * with it, and their subjects — instead of the generic fenced
 * `ShellExchangeBlock`.
 *
 * Registration is a side effect of importing this module, exactly as the commit
 * receipt's is, so the same row renders identically live and after a restore
 * ([D111] shell-ledger replay). Every display fact is parsed from the exchange
 * row itself, so the live and restored rows are pixel-identical; a parse miss
 * falls back to the generic block so raw output always renders.
 *
 * What it does *not* carry is the commit receipt's file list, and the reason is
 * the verb's: a push moved commits that were already committed, so the files
 * belong to those commits rather than to this act. The subjects are what the
 * push has to say.
 *
 * @module components/tugways/cards/session-push-receipt-block
 */

import type React from "react";

import { CommitShaText } from "@/components/tugways/commit-sha-text";
import { useAnnotatedElement } from "@/components/tugways/annotation-scope";
import { requestCommitCard } from "@/lib/open-commit-in-card";
import { useCardId } from "@/components/tugways/use-card-state-preservation";
import { BlockChrome } from "../blocks/block-chrome";
import { ToolBlockHistoryCollapse } from "../blocks/collapse-context";
import {
  registerCommandBlock,
  type CommandBlockProps,
} from "./session-command-block-registry";
import type { ShellExchangeMessage } from "@/lib/code-session-store/types";
import { ShellExchangeBlock } from "./shell-exchange-block";
import "./session-push-receipt-block.css";

/** The display facts parsed from a Spec S01 push summary. */
export interface ParsedPushReceipt {
  branch: string;
  upstream: string;
  commits: number;
  /** The upstream's sha before the push, or the literal `(new)`. */
  before: string;
  /** HEAD after the push — the sha the upstream now points at. */
  after: string;
  /** The pushed commits' subjects, newest first; empty for a `(new)` push. */
  subjects: string[];
}

// The Spec S01 summary shape (server-formatted, the single source): a fixed
// machine header on line 0, then one subject per line.
//   pushed <branch> → <upstream> · <N> commit(s) · <before>..<after>
//   <subject, newest first>
// (`·` is U+00B7 and `→` U+2192 — matched exactly, so a hand-typed line that
// merely looks like this never false-parses.)
const HEAD_RE = /^pushed (\S+) → (\S+) · (\d+) commit\(s\) · (\S+)\.\.(\S+)$/;

/**
 * Parse a `/push` receipt from its `output` string. Returns `null` when the
 * output is not a Spec S01 summary — the caller then renders the generic block.
 */
export function parsePushReceipt(output: string): ParsedPushReceipt | null {
  const lines = output.split("\n");
  const head = HEAD_RE.exec(lines[0] ?? "");
  if (head === null) return null;
  return {
    branch: head[1],
    upstream: head[2],
    commits: Number.parseInt(head[3], 10),
    before: head[4],
    after: head[5],
    subjects: lines
      .slice(1)
      .map((l) => l.trim())
      .filter((l) => l.length > 0),
  };
}

export function SessionPushReceiptBlock(props: CommandBlockProps): React.ReactElement {
  const parsed = parsePushReceipt(props.message.output);
  if (parsed === null) {
    // Not a Spec S01 summary — let the generic exchange block render raw output.
    return <ShellExchangeBlock {...props} />;
  }
  return (
    <PushReceipt
      parsed={parsed}
      cwd={props.message.cwd}
      exchangeId={props.message.exchangeId}
    />
  );
}

/**
 * The parsed receipt: where the branch went over the subjects that went with
 * it. Folds as a whole under the chrome's header chevron, defaulting EXPANDED
 * on the commit receipt's terms — a landing reads in full without a gesture.
 */
function PushReceipt({
  parsed,
  cwd,
  exchangeId,
}: {
  parsed: ParsedPushReceipt;
  cwd: string;
  exchangeId: string;
}): React.ReactElement {
  const { branch, upstream, commits, after, subjects } = parsed;
  // The card this receipt stands in, which the pushed commit's card opens beside.
  const hostCardId = useCardId();
  // The route the push took, annotated like the commit receipt's subject: a
  // branch name is a reference a reader may want to act on.
  const routeRef = useAnnotatedElement<HTMLElement>([branch, upstream]);
  // The sha the upstream now points at stands where the commit receipt's own
  // atom does — the one thing in this receipt that can be opened.
  const identity = (
    <span className="push-receipt-header">
      <code ref={routeRef} className="push-receipt-route" data-tugx-findable="">
        {`pushed ${branch} → ${upstream}`}
      </code>
      {" "}
      <span className="push-receipt-sha">
        <CommitShaText
          sha={after}
          onActivate={() => requestCommitCard({ root: cwd, sha: after }, {}, hostCardId)}
        />
      </span>
    </span>
  );
  return (
    <ToolBlockHistoryCollapse toolUseId={exchangeId} defaultCollapsed={false}>
      {/* `BlockChrome` publishes `data-slot` rather than a test id, so the
          handle the app-tests address this receipt by rides one wrapper. */}
      <div data-testid="session-push-receipt">
        <BlockChrome
          rootSlot="push-receipt-block"
          className="tugx-push-receipt"
          variant="receipt"
          identity={identity}
          flowTrailing
          resultSummary={[{ kind: "count", count: commits, noun: "commit" }]}
          phase="success"
          status="ready"
          copyText={`${branch} → ${upstream} ${after}`.trim()}
        >
          {/* The subjects, newest first, as the push's own list. A `(new)` push
              carries none — every commit on the branch arrived, and naming them
              all would say nothing about the push. */}
          {subjects.length > 0 ? (
            <ul className="push-receipt-subjects" data-slot="push-receipt-detail">
              {subjects.map((subject, index) => (
                <li key={`${index}-${subject}`} data-tugx-findable="">
                  {subject}
                </li>
              ))}
            </ul>
          ) : null}
        </BlockChrome>
      </div>
    </ToolBlockHistoryCollapse>
  );
}

/**
 * The command-block matcher: claims a trimmed command that is exactly `/push`
 * or carries an argument. The ledger always writes `/push`; the argument form
 * is defensive, as the commit matcher's is.
 */
export function matchesPushReceipt(command: string): boolean {
  return command === "/push" || command.startsWith("/push ");
}

/**
 * The receipt's searchable text, in render order: the route line, then the
 * subjects. An output this block cannot parse falls through to
 * `ShellExchangeBlock` — `null` says so.
 */
export function pushReceiptFindParts(
  message: ShellExchangeMessage,
): string[] | null {
  const parsed = parsePushReceipt(message.output);
  if (parsed === null) return null;
  return [`pushed ${parsed.branch} → ${parsed.upstream}`, ...parsed.subjects];
}

// Registration happens at import time (the side-effect import in
// session-card-transcript.tsx loads it before the first resolve).
registerCommandBlock("push-receipt", matchesPushReceipt, SessionPushReceiptBlock, {
  // A push rides the shell ledger, but the user typed no shell command: the
  // row is a git operation and its header says so.
  attribution: "git",
  findParts: pushReceiptFindParts,
});
