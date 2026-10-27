/**
 * `BaseMotionReceiptBlock` — what a base-motion notice reports, drawn as a
 * receipt in the transcript rather than as a paragraph.
 *
 * Base motion speaks into a bound session when the base moves under its arc:
 * either the arc's rounds were replayed onto the new base while the session
 * was between turns, or the replay stopped on a conflict and the session is
 * being handed the job of finishing it. The server sends the outcome twice —
 * once as words, which the agent reads, and once as facts (Spec S06), which
 * this block draws. So the transcript shows the same thing a resolve's ledger
 * shows: a block whose identity says what happened, whose summary counts it,
 * whose notice says what (if anything) is asked, and whose body lists the
 * files.
 *
 * Laws: [L02] the facts arrive as a prop off the store's note; [L06] tone
 * paints through the chrome's `phase`/`status` and CSS; [L19] the block is
 * `BlockChrome` with its notice band, and every row is the fold's one
 * `ArcFoldRow` — this file adds no visual primitive.
 *
 * @module components/tugways/cards/base-motion-receipt-block
 */

import "./base-motion-receipt-block.css";

import React from "react";
import { GitCommitHorizontal } from "lucide-react";

import { BlockChrome } from "@/components/tugways/blocks/block-chrome";
import type { ToolResultSummary } from "@/components/tugways/blocks/tool-result-summary";
import {
  ArcFoldCell,
  ArcFoldRow,
} from "@/components/tugways/cards/session-changes/session-changes-arc-fold-row";
import type { BaseMotionNoticeFacts } from "@tugproto/outbound-decoders";

export interface BaseMotionReceiptBlockProps {
  facts: BaseMotionNoticeFacts;
}

/** The short sha, with the commit glyph the fold's shas wear. */
function Sha({ sha }: { sha: string }): React.ReactElement {
  return (
    <span className="arc-fold-sha base-motion-receipt-sha">
      <GitCommitHorizontal size={11} aria-hidden />
      {sha.slice(0, 7)}
    </span>
  );
}

const REPLAYED_NOTICE =
  "No action is required. Re-read any of these files before editing them — what you have in context predates the move.";

const STOPPED_NOTICE =
  "Resolve it on the arc's own worktree, then record the moved rounds and verify the fit. If the conflict is a real design collision, abort the rebase and say so.";

export function BaseMotionReceiptBlock({
  facts,
}: BaseMotionReceiptBlockProps): React.ReactElement {
  if (facts.kind === "replayed") {
    const summary: ToolResultSummary[] = [
      { kind: "count", count: facts.paths.length, noun: "file" },
      { kind: "count", count: facts.rounds, noun: "round" },
    ];
    return (
      <BlockChrome
        variant="receipt"
        toolName="Replayed"
        rootSlot="base-motion-receipt-replayed"
        flowTrailing
        identity={
          <span className="base-motion-receipt-identity">
            <code>^{facts.arc}</code> onto {facts.base} at <Sha sha={facts.sha} /> while you were
            between turns
          </span>
        }
        resultSummary={summary}
        notice={{ tone: "info", text: REPLAYED_NOTICE }}
      >
        {facts.paths.length === 0 ? (
          <div className="base-motion-receipt-words">the base brought in no file changes</div>
        ) : (
          <div className="base-motion-receipt-rows">
            {facts.paths.map((path) => (
              <ArcFoldRow key={path} leading={<ArcFoldCell tone="muted" />}>
                <span className="arc-fold-path">{path}</span>
              </ArcFoldRow>
            ))}
          </div>
        )}
      </BlockChrome>
    );
  }

  const steps = [
    `git -C ${facts.worktree} rebase ${facts.base}`,
    `tugtool arc replay ${facts.arc} --json`,
    `tugtool arc verify ${facts.arc}`,
  ];
  return (
    <BlockChrome
      variant="receipt"
      toolName="Replay stopped"
      rootSlot="base-motion-receipt-stopped"
      phase="error"
      status="error"
      flowTrailing
      identity={
        <span className="base-motion-receipt-identity">
          <code>^{facts.arc}</code> — {facts.base} moved to <Sha sha={facts.sha} /> and{" "}
          {facts.round_index !== undefined ? `round ${facts.round_index}, ` : ""}
          &ldquo;{facts.round_subject}&rdquo;, conflicts
        </span>
      }
      resultSummary={{ kind: "count", count: facts.paths.length, noun: "file" }}
      notice={{ tone: "warning", text: STOPPED_NOTICE }}
    >
      <div className="base-motion-receipt-rows">
        {facts.paths.map((path) => (
          <ArcFoldRow
            key={path}
            leading={<ArcFoldCell tone="danger" />}
            trailing={<span className="arc-fold-fact">conflicts with {facts.base}</span>}
          >
            <span className="arc-fold-path arc-fold-path-danger">{path}</span>
          </ArcFoldRow>
        ))}
        {steps.map((step, i) => (
          <ArcFoldRow key={step} leading={<ArcFoldCell tone="muted">{i + 1}</ArcFoldCell>}>
            <span className="arc-fold-path">{step}</span>
          </ArcFoldRow>
        ))}
      </div>
    </BlockChrome>
  );
}
