/**
 * `SessionChangesArcJoin` — the fold's **report**: the join's evidence.
 *
 * The fronted row's fold opens on three labeled sections — report, rounds,
 * draft — and this is the first. It carries everything the join has to
 * show for itself, and **no act at all** ([P08]): blocked names each
 * blocker's act and the one control that performs it, on `TugInlineDialog` —
 * the same primitive `PermissionDialog` and `QuestionDialog` are built from,
 * because a refusal with one act to clear it *is* a dialog and Tug has that
 * vocabulary already. Everything a resolve did — the probe that found the
 * conflict, the ladder's rungs, the scribe, the resolver, the audit, the
 * candidate, and the stale note when the candidate stopped applying — is a
 * ledger of tool blocks, the transcript's own `BlockChrome`, folded from the
 * join facts and the run's recorded events by `ledgerBlocks`. Every one of
 * them is something to read.
 *
 * What deliberately does **not** render here ([D142]):
 *
 * - **No outcome chip.** The block's third line — the join register — already
 *   fronts the state's word, in the one vocabulary all three register
 *   surfaces share. A chip here said it a second way, one surface over.
 * - **No standing readiness or refusal line.** "Ready to join" is the
 *   register's sentence; a refusal rides the control that refuses — the
 *   composer's ⬆, or the row menu item whose label carries its reason. A
 *   refusal standing on the face was a sentence about a press nobody made.
 * - **No second copy of the first blocker's sentence.** The register fronts
 *   `blockers[0].detail` as its line, one line above this section, so the
 *   report begins at what that line does not carry: the remedy, and any
 *   blocker past the first.
 *
 * The report always opens on the arc's **fit**: what the last green verify
 * said about the tree a join would land — verified and current, verified but
 * stale naming what moved, or never verified. The join gate is reconcile-clean
 * alone, so this sentence is how the audit's all-clear is seen before the
 * press. It says; it gates nothing.
 *
 * Every value here is read from the arc's server-owned join block, so the
 * face and the join gate answer the same question from the same bytes.
 *
 * The face rides **every** row, which is what makes [P08]'s "Undo is in your
 * Changes shade" a true sentence to tell the holder of folded work: their own
 * deck shows the receipt, on the row for an arc they never pressed anything
 * on. A fold is answered rather than merely reported: the receipt is an
 * inline dialog offering Keep, which accepts the commit and hides the receipt
 * on this page, and Undo, which takes the commit back off the base. What
 * stays the fronted row's alone is `aim` — joining
 * is a gesture on this card's own arc — and the join verb's own `error`,
 * which belongs to the hand that made the press.
 *
 * Laws: [L02] every value here arrives as a prop from the view's store reads;
 * [L06] tone paints through `data-outcome` and CSS; [L19] the section
 * composes `TugSectionLabel` rather than hand-rolling an eyebrow, the ledger
 * is `BlockChrome` blocks with `BlockNoticeBand` and the wave, and every
 * line of evidence is the fold's one `ArcFoldRow`; [L31] every
 * refusal is on screen — on the control that refuses, or as the blocker's own
 * sentence here.
 *
 * @module components/tugways/cards/session-changes/session-changes-arc-join
 */

import "./session-changes-arc-fold.css";

import React from "react";
import { Check, GitCommitHorizontal, RotateCcw, TriangleAlert } from "lucide-react";

import { TugSectionLabel } from "@/components/tugways/tug-section-label";
import { TugInlineDialog } from "@/components/tugways/tug-inline-dialog";
import { TugPushButton } from "@/components/tugways/tug-push-button";
import {
  ArcFoldCell,
  ArcFoldRow,
} from "@/components/tugways/cards/session-changes/session-changes-arc-fold-row";
import type { ParsedQuestion } from "@/components/tugways/chrome/session-question-dialog";
import type {
  ArcChangesetEntry,
  ArcJoinBlockerWire,
  ArcJoinQuestionWire,
  ArcJoinStateWire,
} from "@/lib/changeset-types";
import type { ResolvePhase, ResolveState } from "@/lib/changeset-join-store";
import {
  foldReceiptKeepStore,
  useFoldReceiptKept,
} from "@/lib/fold-receipt-keep-store";
import {
  foldReceiptText,
  ledgerBlocks,
  offersResolveAgain,
  type LedgerInput,
} from "@/lib/resolve-ledger";
import { arcFitSentence } from "@/lib/arc-fit";
import { ResolveLedgerBlocks } from "@/components/tugways/cards/session-changes/session-changes-resolve-ledger";
import { BlockNoticeBand } from "@/components/tugways/blocks/block-notice";
import { JoinRefusalBlock } from "@/components/tugways/cards/session-changes/session-changes-join-refusal";
import { parseJoinRefusal } from "@/lib/join-refusal";
import {
  deriveJoinOutcome,
  type JoinOutcome,
} from "@/lib/join-mode-controller";

/**
 * The lane's join gestures, supplied by the card that owns the arc.
 *
 * There is deliberately no gesture here that joins, and none that opens the
 * join editor. Joining is the composer's — ⌃⌘C, or `/arc-join` — and the
 * composer's ⬆ is the only control that fires one. A row-level button that
 * *entered a mode* while reading as an action was the resting lie this lane
 * carried: it claimed a join, and on every state that could not join it
 * greyed itself out and said so in a place the press never reached.
 */
export interface ArcJoinActions {
  /** Point the join mode at this arc without entering it — the row's expand. */
  aim: (entry: ArcChangesetEntry) => void;
  /**
   * Answer the intent question a blocked resolver raised ([P06]).
   *
   * `answer` is an option's label or the user's own words; both reach the
   * resolver verbatim, because deciding which one the user "really meant" is
   * not the face's call.
   */
  answerQuestion: (
    entry: ArcChangesetEntry,
    requestId: string,
    answer: string,
  ) => void;
  /**
   * Clear the base-side work refusing this arc's join.
   *
   * One act for every resolvable blocker, because the server decides what the
   * act *is* and says so in the blocker's own remedy sentence. The control is
   * always the same word.
   */
  resolveBase: (entry: ArcChangesetEntry) => void;
  /**
   * Put back the base work a fold committed ([P06]).
   *
   * It can only ever reverse a fold: the server refuses the press by name
   * when the arc's newest operation is anything else, so the control beside
   * a receipt cannot un-land a join the receipt has already outlived.
   */
  undoResolveBase: (entry: ArcChangesetEntry) => void;
  /**
   * Run the resolve again over a ledger that stands but no longer applies
   * ([B07]): the candidate went stale, or the last run is recorded with no
   * candidate left on the arc. The server stamps the pilot's head-pair mark
   * and runs the same ladder a first Resolve runs.
   */
  resolveAgain: (entry: ArcChangesetEntry) => void;
}

/**
 * What the resolve lane shows, derived from the ladder's phase and whether it
 * built anything joinable ([#outcome-derivation]).
 *
 * - `offer` — conflicted and untried: the ladder is the act that clears it.
 * - `progress` — running, streaming per file.
 * - `folding` — the base-work fold is running. Its own face rather than a
 *   second `progress`, because the two acts say different things: the ladder
 *   streams per-file rungs, and a fold has paths and nothing to stream.
 * - `resolved` — a candidate exists; the join is joinable after all.
 * - `error` / `none` — the ladder refused or reached its dead end, or has
 *   nothing to say here.
 */
export type ResolveFace =
  | "none"
  | "offer"
  | "progress"
  | "folding"
  | "resolved"
  | "error";

/**
 * The candidate outranks the progress phase, and that ordering is what makes a
 * resolution survive a reload: the phase is a live overlay that dies with the
 * page, while the candidate is a git ref the server re-reports on every
 * recompute. Ranked the other way, reopening the deck after a successful
 * Resolve would show a clean arc with no review panel and join it unread.
 */
export function deriveResolveFace(
  outcome: JoinOutcome,
  phase: ResolvePhase,
  candidateCommit: string | null,
  run?: string | null,
  act?: "resolve" | "resolve-base",
): ResolveFace {
  // Above the ladder's own face, because the two share the resolving phase:
  // read only `phase`, a fold would wear the ladder's face and narrate rungs
  // it has none of. The client's act stands in until the recompute that puts
  // `run` on the entry arrives.
  if (run === "resolve-base" || act === "resolve-base") return "folding";
  if (phase === "resolving") return "progress";
  // The server's own account of what it is doing right now ([P09]). The phase
  // above it is a client overlay that dies with the page, so without this a
  // reload during a resolve — or a second deck watching the same arc — renders
  // minutes of real work as nothing at all.
  if (run === "resolve") return "progress";
  if (candidateCommit !== null) return "resolved";
  if (phase === "error") return "error";
  return outcome === "conflicted" || outcome === "stale" ? "offer" : "none";
}

/** What the face shows for one state — evidence, and no acts at all ([P08]). */
export interface JoinFace {
  outcome: JoinOutcome;
  resolve: ResolveFace;
}

/**
 * Table T01 as a function: one feed state in, one face out.
 *
 * Pure and exported so the face's shape is testable without a DOM. It used to
 * also yield the standing readiness line and the ready boolean; both left
 * with the standing line itself ([D142]) — the register derivation
 * (`arcJoinRegister`) owns the sentence, and `evaluateJoinGate` owns the
 * press, each already one place. What remains is the pair the evidence panel
 * dispatches on: the outcome the tones follow, and which resolve face the
 * ladder's state has earned.
 */
export function deriveJoinFace(input: {
  join: ArcJoinStateWire | null;
  resolvePhase: ResolvePhase;
  resolveAct?: "resolve" | "resolve-base";
}): JoinFace {
  const { join, resolvePhase } = input;
  const outcome = deriveJoinOutcome(join);
  const candidate =
    typeof join?.candidate === "string" && join.candidate !== ""
      ? join.candidate
      : null;
  const resolve = deriveResolveFace(
    outcome,
    resolvePhase,
    candidate,
    join?.run ?? null,
    input.resolveAct,
  );
  return { outcome, resolve };
}

/**
 * What the resolve's ledger is folded from, for one arc: the join facts, the
 * durable ledger off the entry, and the store's live half, running only while
 * the face has earned its progress state. One builder, so the report's ledger
 * and the shade's run line read the same run.
 */
export function joinLedgerInput(input: {
  join: ArcJoinStateWire | null;
  base: string;
  resolve: ResolveState;
}): LedgerInput {
  const { join, base, resolve } = input;
  const face = deriveJoinFace({
    join,
    resolvePhase: resolve.phase,
    ...(resolve.act !== undefined ? { resolveAct: resolve.act } : {}),
  });
  return {
    join,
    durable: join?.ledger ?? null,
    // The store's run is the ledger's live half: what this page heard of
    // the run since it started, merged past what the entry already holds.
    live: resolve,
    base,
    running: face.resolve === "progress",
  };
}

/** How many lines the refusal band shows before it clamps. */
const REFUSAL_MAX_LINES = 8;

/**
 * The band's clamp, grown by one line per path the stuck line names: the
 * paths are rows inside the band, and a clamp that cut the list would hide
 * the files the refusal is about.
 */
export function refusalMaxLines(stuck: string | null): number {
  return REFUSAL_MAX_LINES + (stuck === null ? 0 : parseJoinRefusal(stuck).paths.length);
}

/** One reason the join will not proceed, under the slot that names its source. */
export interface RefusalReason {
  slot:
    | "session-changes-arc-join-stuck"
    | "session-changes-arc-join-resolve-error"
    | "session-changes-arc-join-error";
  text: string;
}

/**
 * The reasons the refusal band carries, in order — why the last resolve
 * stopped, a refused resolve verb, a refused join verb — each sentence once:
 * a reason already said by an earlier source is not said again.
 */
export function refusalReasons(
  stuck: string | null,
  resolveError: string | null,
  joinError: string | null,
): RefusalReason[] {
  const out: RefusalReason[] = [];
  const said = new Set<string>();
  const add = (slot: RefusalReason["slot"], text: string | null): void => {
    if (text === null || text === "" || said.has(text)) return;
    said.add(text);
    out.push({ slot, text });
  };
  add("session-changes-arc-join-stuck", stuck);
  add("session-changes-arc-join-resolve-error", resolveError);
  add("session-changes-arc-join-error", joinError);
  return out;
}

export interface SessionChangesArcJoinProps {
  /** The arc this face describes — always the card's own. */
  entry: ArcChangesetEntry;
  /**
   * The arc's server-owned join state, straight off its feed entry: blockers,
   * conflicts, the candidate and what the ladder decided per path. Everything
   * this face says about a join is read from here, so the face and the join
   * gate cannot disagree.
   */
  join: ArcJoinStateWire | null;
  /** A verb-level refusal from an execute, if one came back. */
  error: string | null;
  /** The resolution ladder's live state for this arc. */
  resolve: ResolveState;
  actions: ArcJoinActions;
}

/** One blocker this report has something to add about, and its place. */
export interface ReportedBlocker {
  blocker: ArcJoinBlockerWire;
  /** Its index in the server's list — 0 is the one the register fronts. */
  index: number;
}

/**
 * The blockers worth a row here, out of everything the server sent.
 *
 * The join register — the row's own line, standing directly above this
 * section — takes `blockers[0].detail` as its line. So the first blocker
 * earns a row only for the one thing that line cannot carry, its remedy; a
 * first blocker with no remedy is already wholly said, and repeating it a
 * line down was the same sentence twice. Every blocker past the first has no
 * other voice and always speaks.
 */
export function reportedBlockers(
  blockers: readonly ArcJoinBlockerWire[],
): ReportedBlocker[] {
  return blockers
    .map((blocker, index) => ({ blocker, index }))
    .filter(({ blocker, index }) => index > 0 || blocker.remedy !== undefined);
}

export const QUESTION_DECLINED_TO_CHOOSE =
  "The user declined to choose. Stop and report what you found, without guessing past this conflict.";

/**
 * The resolver's escalation, narrowed to the one question the wizard walks.
 *
 * Single-select and never multi: the resolver is asking which reconciliation
 * to make, and two incompatible intents cannot both be taken.
 */
export function joinQuestionAsParsed(
  question: ArcJoinQuestionWire,
): ParsedQuestion[] {
  return [
    {
      question: question.question,
      multiSelect: false,
      options: question.options.map((option) => ({
        label: option.label,
        description: option.description,
      })),
    },
  ];
}

/**
 * One blocker, as an inline dialog.
 *
 * A refusal with one act to clear it is a dialog, and Tug already has that
 * vocabulary — icon, title, body, trailing actions — in
 * `TugInlineDialog`, where `PermissionDialog` and `QuestionDialog` also live.
 * So this composes it rather than stacking spans into a fourth reading of the
 * same idea. The mapping is the primitive's own: the situation names the title
 * row, the paths and the sentence that says what will happen are the body, and
 * the one control sits in `actions` where `Allow` and `Deny` sit.
 *
 * The fact sheet rides the body slot, never the description. The primitive
 * centres a description and caps its width, which is right for a permission
 * prompt's one line and wrong for a sheet that is read rather than announced;
 * the body slot is already left-aligned and inset to the title text's edge, so
 * the sheet takes that edge from the primitive itself and this shade reaches
 * into none of its tokens ([L20]).
 *
 * `detailIsElsewhere` is true for the blocker the join register already fronts
 * — its sentence is the row's own line, one line above, so the sheet begins at
 * the remedy instead of repeating it.
 *
 * Every remedy the server sends is pressable ([L31]): a blocker either
 * carries an act or carries no remedy at all, so the dialog never renders a
 * control it refuses to honor.
 */
function BlockerDialog({
  blocker,
  detailIsElsewhere,
  entry,
  resolve,
  actions,
}: {
  blocker: ArcJoinBlockerWire;
  detailIsElsewhere: boolean;
  entry: ArcChangesetEntry;
  resolve: ResolveState;
  actions: ArcJoinActions;
}): React.ReactElement {
  const remedy = blocker.remedy;
  // `paths` is optional on the wire — an off-base checkout or a stale
  // teardown names none — so the absent case and the empty case are one.
  const paths = blocker.paths ?? [];
  return (
    <TugInlineDialog
      className="session-changes-arc-join-blocker"
      icon={<TriangleAlert />}
      iconRole="caution"
      title={blocker.title}
      {...(remedy !== undefined
        ? {
            actions: (
              /* The remedy is never IN the button: the sheet carries it, so
                 the act is weighed before it is pressed, and the control is
                 always the same word — and always live ([L31]). */
              <TugPushButton
                size="xs"
                emphasis="primary"
                role="action"
                disabled={resolve.phase === "resolving"}
                loading={resolve.phase === "resolving"}
                onClick={() => actions.resolveBase(entry)}
                data-slot="session-changes-arc-join-resolve-base"
              >
                Resolve
              </TugPushButton>
            ),
          }
        : {})}
    >
      {/* The files themselves, above the sentence that counts them ([P10]).
          The sentence can say "these 3 files" only because they are named
          right here; a count with nothing to check it against is a number the
          reader has to take on trust, which is not what a fact sheet is for.
          No leading cell: the path stands on the title text's own edge. */}
      {paths.length > 0 ? (
        <div
          className="session-changes-arc-join-paths"
          data-slot="session-changes-arc-join-paths"
        >
          {paths.map((path) => (
            <ArcFoldRow key={path}>
              <span className="arc-fold-path">{path}</span>
            </ArcFoldRow>
          ))}
        </div>
      ) : null}
      {detailIsElsewhere ? null : (
        <span className="session-changes-arc-join-detail">
          {blocker.detail}
        </span>
      )}
      {remedy !== undefined ? (
        <span className="session-changes-arc-join-act">{remedy.explain}</span>
      ) : null}
    </TugInlineDialog>
  );
}

export function SessionChangesArcJoin({
  entry,
  join,
  error,
  resolve,
  actions,
}: SessionChangesArcJoinProps): React.ReactElement {
  const blockers = join?.blockers ?? [];
  const stuck =
    typeof join?.stuck === "string" && join.stuck !== "" ? join.stuck : null;
  const reasons = refusalReasons(stuck, resolve.error, error);
  // The fold that stands over this arc, if one does. Durable — read off the
  // entry rather than out of the overlay — so a reload and a second deck show
  // the same receipt as the deck that pressed.
  const resolvedBase = join?.resolved_base ?? null;
  // A receipt the reader has kept hides on this page ([P07]). The hook runs
  // on every render, receipt or not, so its order never moves.
  const receiptKey =
    resolvedBase !== null ? `${entry.owner_id}|${resolvedBase.seq}` : "";
  const receiptKept = useFoldReceiptKept(receiptKey);
  const receipt =
    resolvedBase !== null && !receiptKept
      ? {
          key: receiptKey,
          base: resolvedBase,
          text: foldReceiptText(resolvedBase),
        }
      : null;
  const reported = reportedBlockers(blockers);
  // One decision, made once ({@link deriveJoinFace}) and rendered here.
  const face = deriveJoinFace({
    join,
    resolvePhase: resolve.phase,
    resolveAct: resolve.act,
  });
  const { outcome, resolve: resolveFace } = face;
  // The resolve's ledger: one block per act, from the join facts and whatever
  // the run has recorded. One pure decision ({@link ledgerBlocks}); the live
  // block's wave holds its own motion, so nothing here holds one for it.
  const blocks = ledgerBlocks(joinLedgerInput({ join, base: entry.base, resolve }));
  // Resolve again rides under the ledger it would redo, and only when that
  // ledger no longer applies (Spec S05).
  const again = offersResolveAgain(resolveFace, join);

  // The fit always has something to say — "not verified" is a reading too —
  // so the section always renders, and opens on it.
  const fit = arcFitSentence(entry.fit);

  return (
    <div
      className="session-changes-arc-join"
      data-slot="session-changes-arc-join"
      data-outcome={outcome}
    >
      <TugSectionLabel
        label={{ name: "report" }}
        slot="session-changes-arc-join-label"
      />
      <div
        className="session-changes-arc-join-note"
        data-slot="session-changes-arc-join-fit"
        data-fit={fit.reading}
      >
        {fit.text}
      </div>
      {outcome === "empty" ? (
        <div
          className="session-changes-arc-join-note"
          data-slot="session-changes-arc-join-empty"
        >
          Nothing to join — discard this arc.
        </div>
      ) : null}
      {reported.length > 0 ? (
        <div
          className="session-changes-arc-join-blockers"
          data-slot="session-changes-arc-join-blockers"
        >
          {reported.map(({ blocker, index }) => (
            <div key={`${index}:${blocker.kind}`} data-blocker={blocker.kind}>
              <BlockerDialog
                blocker={blocker}
                detailIsElsewhere={index === 0}
                entry={entry}
                resolve={resolve}
                actions={actions}
              />
            </div>
          ))}
        </div>
      ) : null}
      {/* What a fold did, once it has done it. Read off the arc's entry rather
          than out of the overlay that pressed, which is what makes it survive a
          reload and reach a second deck — it names a commit made on the user's
          own base out of their uncommitted work, so "you had to be watching" is
          not an acceptable way to learn about it. It retires by itself: a join
          lands the arc and the fold stops being the newest thing that happened,
          an undo marks the op reversed. */}
      {receipt !== null ? (
        <div
          className="session-changes-arc-join-fold-receipt-frame"
          data-slot="session-changes-arc-join-resolve-receipt"
        >
          <TugInlineDialog
            className="session-changes-arc-join-fold-receipt"
            icon={<Check />}
            iconRole="success"
            title={receipt.text.title}
            actions={
              <>
                {/* Keep is the reader's acknowledgement, and it is deck-local
                    ([P07]): the receipt hides on this page, and the fold
                    stands as it is. */}
                <TugPushButton
                  size="xs"
                  emphasis="primary"
                  role="action"
                  data-slot="session-changes-arc-join-keep-resolve-base"
                  onClick={() => foldReceiptKeepStore.keep(receipt.key)}
                >
                  Keep
                </TugPushButton>
                {/* The way back ([P08] is what buys the exception to [D142]'s
                    no-acts rule): a receipt that reports a commit made out of
                    somebody's uncommitted work has to carry the way back, or
                    the report is a notification and not a remedy.

                    It is disabled while a FOLD is running — the op it would
                    reverse is the one being written — and the act is what the
                    guard reads, not the phase. The two acts share `resolving`,
                    and the ladder is the one that runs *after* a fold: the
                    fold puts the base and the arc on divergent history, which
                    is the collision the resolver exists for. A guard on the
                    phase alone therefore switched the Undo off for the whole
                    of the run that a successful fold provokes, which is
                    precisely when a reader has just been told their work was
                    committed and wants it back. */}
                <TugPushButton
                  size="xs"
                  emphasis="outlined"
                  data-slot="session-changes-arc-join-undo-resolve-base"
                  disabled={resolve.phase === "resolving" && resolve.act === "resolve-base"}
                  onClick={() => actions.undoResolveBase(entry)}
                >
                  Undo
                </TugPushButton>
              </>
            }
          >
            {/* The fact sheet rides the body slot, never the description, so
                it reads left-aligned on the title's edge ([P09]). */}
            {receipt.base.commit !== undefined ? (
              <span className="arc-fold-sha session-changes-arc-join-fold-sha">
                <GitCommitHorizontal size={11} aria-hidden />
                {receipt.base.commit.slice(0, 7)}
              </span>
            ) : null}
            <span className="session-changes-arc-join-fold-sentence">
              {receipt.text.sentence}
            </span>
            {Object.keys(receipt.base.folded_from ?? {}).length > 0 ? (
              <div className="session-changes-arc-join-paths">
                {Object.entries(receipt.base.folded_from ?? {}).map(
                  ([path, holder]) => (
                    <ArcFoldRow
                      key={path}
                      wrapperProps={{
                        "data-slot": "session-changes-arc-join-resolve-holder",
                      }}
                      trailing={
                        <span className="arc-fold-fact">
                          work in progress from {holder}
                        </span>
                      }
                    >
                      <span className="arc-fold-path">{path}</span>
                    </ArcFoldRow>
                  ),
                )}
              </div>
            ) : null}
          </TugInlineDialog>
        </div>
      ) : null}
      {/* A fold in flight, and no second sentence about it. The register is
          already saying `Committing base work · N files` above this row, so
          what belongs here is the detail that line cannot carry: which paths
          the fold is taking. Two lines with two words for one act is the whole
          defect the register exists to prevent. */}
      {resolveFace === "folding" ? (
        <div
          className="session-changes-arc-join-rungs"
          data-slot="session-changes-arc-join-folding"
        >
          {blockers
            .filter((blocker) => blocker.kind === "base-dirt")
            .flatMap((blocker) => blocker.paths ?? [])
            .map((path) => (
              <ArcFoldRow key={path} leading={<ArcFoldCell />}>
                <span className="arc-fold-path">{path}</span>
              </ArcFoldRow>
            ))}
        </div>
      ) : null}
      {/* The ledger: one block per act of the resolve — the probe that found
          the conflict, the ladder's rungs, the scribe, the resolver and its
          question, the audit, the candidate — and the stale note when the
          candidate stopped applying. A running resolve has exactly one live
          block, carrying the thinking wave; its press has a receipt from the
          first frame even before any rung reports. */}
      {blocks.length > 0 ? (
        <div className="session-changes-ledger" data-slot="session-changes-ledger">
          <ResolveLedgerBlocks
            blocks={blocks}
            base={entry.base}
            question={{
              asParsed: joinQuestionAsParsed,
              onSubmit: (question, answer) =>
                actions.answerQuestion(entry, question.request_id, answer),
              onDecline: (question, response) =>
                actions.answerQuestion(entry, question.request_id, response),
              onCancel: (question) =>
                actions.answerQuestion(
                  entry,
                  question.request_id,
                  QUESTION_DECLINED_TO_CHOOSE,
                ),
            }}
          />
        </div>
      ) : null}
      {again ? (
        <div className="session-changes-arc-join-acts">
          <TugPushButton
            size="xs"
            emphasis="primary"
            role="action"
            subtype="icon-text"
            icon={<RotateCcw size={12} />}
            disabled={resolve.phase === "resolving"}
            onClick={() => actions.resolveAgain(entry)}
            data-slot="session-changes-arc-join-resolve-again"
          >
            Resolve again
          </TugPushButton>
        </div>
      ) : null}
      {/* Why the join will not proceed, as one error band at the face's body
          size: the stuck line, a refused resolve verb, and a refused join verb,
          each in its own slot and a sentence said once however many of them
          carry it. The stuck line is drawn as the refusal block — its sentence,
          then one row per path it names — because a resolver's refusal lists
          files, and twenty of them in a paragraph is a wall with no red in it.
          It is durable and server-written, so unlike the
          overlay's errors it survives a reload — a resolve is minutes long and
          the deck that started it is often not the deck that comes back to
          it. Rendered on the reasons, not on the face: a refused answer or
          override arrives while a candidate stands, and keying this off
          `resolveFace` swallowed exactly the refusals that have no other way
          to be seen. A join that will not proceed and cannot say why is the
          one state this face must never render ([L31]). */}
      {reasons.length > 0 ? (
        <div
          className="session-changes-arc-join-refusal"
          data-slot="session-changes-arc-join-refusal"
          role="alert"
        >
          <BlockNoticeBand
            tone="error"
            maxLines={refusalMaxLines(stuck)}
            text={reasons.map(({ slot, text }) =>
              slot === "session-changes-arc-join-stuck" ? (
                <JoinRefusalBlock key={slot} detail={text} slot={slot} />
              ) : (
                <span key={slot} className="session-changes-arc-join-reason" data-slot={slot}>
                  {text}
                </span>
              ),
            )}
          />
        </div>
      ) : null}
    </div>
  );
}
