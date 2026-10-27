/**
 * `ResolveLedgerBlocks` — the REPORT section's ledger, one `BlockChrome` per
 * act of a resolve.
 *
 * Every decision about what a block says — its identity, summary, phase and
 * body — is `ledgerBlocks`'s, made once in `lib/resolve-ledger.ts` over data.
 * This component maps each `LedgerBlock` onto the shipped block chrome and
 * decides nothing, so the transcript's tool blocks and the shade's ledger are
 * one vocabulary rather than two.
 *
 * The live block — at most one — carries the thinking wave in a progress
 * notice band, never in the header's leading slot ([B02]): the header's dot
 * says the block is running, and the band says what it is doing.
 *
 * The slots the app-tests read moved with the content they mark: the probe's
 * rows are `session-changes-arc-join-conflicts`, each path keeps
 * `-conflict-path` and `-conflict-fact` with the danger tint, the history keeps
 * `-archaeology`, and the audit keeps `-account` and `-report` with
 * `data-audit` per row.
 *
 * Laws: [L02] every value arrives as a prop; [L06] phase and status are data
 * attributes the chrome paints through CSS, and the wave holds its own motion;
 * [L19] composes `BlockChrome`, `BlockNoticeBand`, `TugProgressIndicator`,
 * `QuestionWizard` and `ArcFoldRow` rather than hand-rolling any of them.
 *
 * @module components/tugways/cards/session-changes/session-changes-resolve-ledger
 */

import "./session-changes-arc-fold.css";

import React from "react";
import { Check, GitCommitHorizontal, TriangleAlert } from "lucide-react";

import { BlockChrome } from "@/components/tugways/blocks/block-chrome";
import { BlockNoticeBand } from "@/components/tugways/blocks/block-notice";
import { TugProgressIndicator } from "@/components/tugways/tug-progress-indicator";
import {
  ArcFoldCell,
  ArcFoldRow,
} from "@/components/tugways/cards/session-changes/session-changes-arc-fold-row";
import { QuestionWizard } from "@/components/tugways/chrome/session-question-dialog";
import type { ArcJoinQuestionWire } from "@/lib/changeset-types";
import type { LedgerBlock, LedgerBody, LedgerIdentity } from "@/lib/resolve-ledger";

/** How the question body answers: the same three hands the face always had. */
export interface LedgerQuestionHandlers {
  /** The wizard's own question shape, from the join's question. */
  asParsed: (question: ArcJoinQuestionWire) => React.ComponentProps<
    typeof QuestionWizard
  >["questions"];
  onSubmit: (question: ArcJoinQuestionWire, answer: string) => void;
  onDecline: (question: ArcJoinQuestionWire, response: string) => void;
  onCancel: (question: ArcJoinQuestionWire) => void;
}

export interface ResolveLedgerBlocksProps {
  blocks: readonly LedgerBlock[];
  /** The arc's base branch — the conflict rows' fact names it. */
  base: string;
  question: LedgerQuestionHandlers;
}

/** The stale block's warning: what no longer holds, and what Resolve again does. */
function staleNotice(base: string): string {
  return `The candidate no longer applies: it was anchored on the ${base} this commit moved. Resolving again re-runs the ladder; rerere and the resolver's checkpoints carry what they can.`;
}

/** A block's identity, in the receipt's prose face rather than the command face. */
function Identity({ identity }: { identity: LedgerIdentity }): React.ReactElement {
  return (
    <span className="session-changes-ledger-identity">
      {identity.sha !== undefined ? (
        <>
          <span className="arc-fold-sha">
            <GitCommitHorizontal size={11} aria-hidden />
            {identity.sha.slice(0, 9)}
          </span>{" "}
        </>
      ) : null}
      {identity.path !== undefined ? (
        <>
          <code>{identity.path}</code>{" "}
        </>
      ) : null}
      {identity.text}
    </span>
  );
}

/** The in-flight band: the standard thinking wave, and what is happening. */
function LiveBand({ text }: { text: string }): React.ReactElement {
  return (
    <BlockNoticeBand
      tone="progress"
      maxLines={1}
      icon={<TugProgressIndicator variant="wave" state="running" role="inherit" />}
      text={text}
    />
  );
}

function Body({
  body,
  base,
  question,
}: {
  body: LedgerBody;
  base: string;
  question: LedgerQuestionHandlers;
}): React.ReactElement | null {
  switch (body.kind) {
    case "none":
      return null;
    case "commits":
      return (
        <div
          className="session-changes-ledger-rows session-changes-arc-join-conflicts"
          data-slot="session-changes-arc-join-conflicts"
        >
          {body.conflicts.map(({ path, history }) => {
            const commits = history?.commits ?? [];
            const elided = history === null ? 0 : history.total - commits.length;
            return (
              <React.Fragment key={path}>
                {/* One tint for the whole fact ([B07]): the mark, the path and
                    the sentence take the tone the lifecycle line's own danger
                    clause takes. */}
                <ArcFoldRow
                  leading={
                    <ArcFoldCell tone="danger">
                      <TriangleAlert size={12} aria-hidden />
                    </ArcFoldCell>
                  }
                  trailing={
                    <span
                      className="arc-fold-fact arc-fold-fact-danger"
                      data-slot="session-changes-arc-join-conflict-fact"
                    >
                      conflicts with {base}
                    </span>
                  }
                >
                  <span
                    className="arc-fold-path arc-fold-path-danger session-changes-arc-join-conflict-path"
                    data-slot="session-changes-arc-join-conflict-path"
                  >
                    {path}
                  </span>
                </ArcFoldRow>
                {history !== null ? (
                  <div
                    className="session-changes-arc-join-archaeology"
                    data-slot="session-changes-arc-join-archaeology"
                  >
                    {commits.map((commit) => (
                      <ArcFoldRow key={commit.sha} leading={<ArcFoldCell />}>
                        <span className="arc-fold-sha">{commit.sha}</span>
                        <span className="arc-fold-prose arc-fold-muted">
                          {commit.subject}
                        </span>
                      </ArcFoldRow>
                    ))}
                    {elided > 0 ? (
                      <ArcFoldRow leading={<ArcFoldCell />}>
                        <span className="arc-fold-prose arc-fold-muted">
                          +{elided} earlier
                        </span>
                      </ArcFoldRow>
                    ) : null}
                  </div>
                ) : null}
              </React.Fragment>
            );
          })}
        </div>
      );
    case "rungs":
      return (
        <div className="session-changes-ledger-rows" data-slot="session-changes-ledger-rungs">
          {body.rows.map((row, i) => (
            <ArcFoldRow
              key={`${i}:${row.rung}:${row.path ?? ""}`}
              wrapperProps={{ "data-outcome": row.outcome }}
              leading={<ArcFoldCell tone="muted">{i + 1}</ArcFoldCell>}
              trailing={<span className="arc-fold-fact">{row.rung}</span>}
            >
              {row.path !== undefined ? (
                <span className="arc-fold-path">{row.path}</span>
              ) : null}
              <span className="arc-fold-prose session-changes-ledger-said">{row.said}</span>
            </ArcFoldRow>
          ))}
        </div>
      );
    case "scribe-tail":
      return (
        <div className="session-changes-ledger-words session-changes-ledger-tail">
          {body.text}
        </div>
      );
    case "words":
      return <div className="session-changes-ledger-words">{body.text}</div>;
    case "question":
      return (
        <>
          {body.text !== undefined ? (
            <div className="session-changes-ledger-words">{body.text}</div>
          ) : null}
          <div
            className="session-changes-arc-join-question"
            data-slot="session-changes-arc-join-question"
          >
            <QuestionWizard
              requestId={body.question.request_id}
              questions={question.asParsed(body.question)}
              isPending
              onSubmit={(answers) => {
                const answer = answers[body.question.question];
                if (typeof answer !== "string" || answer === "") return;
                question.onSubmit(body.question, answer);
              }}
              onDecline={(response) => question.onDecline(body.question, response)}
              onCancel={() => question.onCancel(body.question)}
            />
          </div>
        </>
      );
    case "audit":
      return (
        <div
          className="session-changes-arc-join-account"
          data-slot="session-changes-arc-join-account"
        >
          {body.files.length > 0 ? (
            <div
              className="session-changes-ledger-rows session-changes-arc-join-report"
              data-slot="session-changes-arc-join-report"
            >
              {body.files.map((file) => (
                <ArcFoldRow
                  key={file.path}
                  wrapperProps={{ "data-audit": file.audit ?? "finished" }}
                  leading={<ArcFoldCell />}
                  trailing={
                    <span className="arc-fold-fact session-changes-arc-join-report-what">
                      {file.reconciliation}
                    </span>
                  }
                >
                  <span className="arc-fold-path">{file.path}</span>
                </ArcFoldRow>
              ))}
            </div>
          ) : null}
          {body.notes !== undefined ? (
            <div className="session-changes-ledger-words">{body.notes}</div>
          ) : null}
        </div>
      );
    case "files":
      return (
        <div
          className="session-changes-ledger-rows"
          data-slot="session-changes-arc-join-resolved"
        >
          {body.files.map((file) => (
            <ArcFoldRow
              key={file.path}
              wrapperProps={{ "data-resolved-by": file.fact }}
              leading={
                <ArcFoldCell tone="muted">
                  <Check size={11} aria-hidden />
                </ArcFoldCell>
              }
              trailing={<span className="arc-fold-fact">{file.fact}</span>}
            >
              <span className="arc-fold-path">{file.path}</span>
            </ArcFoldRow>
          ))}
        </div>
      );
  }
}

export function ResolveLedgerBlocks({
  blocks,
  base,
  question,
}: ResolveLedgerBlocksProps): React.ReactElement {
  return (
    <>
      {blocks.map((block) => (
        <BlockChrome
          key={block.key}
          rootSlot={
            // The stale block keeps the slot the stale note always wore.
            block.kind === "stale"
              ? "session-changes-arc-join-stale"
              : `session-changes-ledger-${block.kind}`
          }
          variant={block.variant}
          toolName={block.toolName}
          identity={<Identity identity={block.identity} />}
          resultSummary={block.summary}
          phase={block.phase}
          status={block.status}
          flowTrailing
          forceExpanded={block.phase === "awaiting"}
          {...(block.live !== undefined ? { liveBand: <LiveBand text={block.live} /> } : {})}
          {...(block.kind === "stale"
            ? { notice: { tone: "warning" as const, text: staleNotice(base) } }
            : {})}
        >
          <Body body={block.body} base={base} question={question} />
        </BlockChrome>
      ))}
    </>
  );
}
