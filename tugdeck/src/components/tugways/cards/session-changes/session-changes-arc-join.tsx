/**
 * `SessionChangesArcJoin` — the fold's **report**: the join's evidence.
 *
 * The fronted row's fold opens on three labeled sections — report, rounds,
 * draft — and this is the first. It carries everything the join has to
 * show for itself, and **no act at all** ([P08]): blocked names each
 * blocker's act and the one control that performs it, on `TugInlineDialog` —
 * the same primitive `PermissionDialog` and `QuestionDialog` are built from,
 * because a refusal with one act to clear it *is* a dialog and Tug has that
 * vocabulary already; conflicted names the paths; resolved shows what the
 * ladder decided. Every one of them is something to read.
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
 * With nothing to report the section renders nothing at all — a `report`
 * eyebrow over silence would be a row of chrome saying nothing.
 *
 * Every value here is read from the arc's server-owned join block, so the
 * face and the join gate answer the same question from the same bytes.
 *
 * The face rides **every** row, which is what makes [P08]'s "Undo is in your
 * Changes shade" a true sentence to tell the holder of folded work: their own
 * deck shows the receipt and its Undo, on the row for an arc they never
 * pressed anything on. What stays the fronted row's alone is `aim` — joining
 * is a gesture on this card's own arc — and the join verb's own `error`,
 * which belongs to the hand that made the press.
 *
 * Laws: [L02] every value here arrives as a prop from the view's store reads;
 * [L06] tone paints through `data-outcome` and CSS; [L19] the section
 * composes `TugSectionLabel` rather than hand-rolling an eyebrow; [L31] every
 * refusal is on screen — on the control that refuses, or as the blocker's own
 * sentence here.
 *
 * @module components/tugways/cards/session-changes/session-changes-arc-join
 */

import "./session-changes-arc-join.css";

import React from "react";
import { LoaderCircle, TriangleAlert } from "lucide-react";

import { TugSectionLabel } from "@/components/tugways/tug-section-label";
import { TugInlineDialog } from "@/components/tugways/tug-inline-dialog";
import { TugPushButton } from "@/components/tugways/tug-push-button";
import {
  QuestionWizard,
  type ParsedQuestion,
} from "@/components/tugways/chrome/session-question-dialog";
import type {
  ArcChangesetEntry,
  ArcJoinBlockerWire,
  ArcJoinQuestionWire,
  ArcJoinStateWire,
  ArcResolvedFileWire,
} from "@/lib/changeset-types";
import type { ResolvePhase, ResolveState } from "@/lib/changeset-join-store";
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

/**
 * What a discard would destroy, as one clause. Pure, so the sentence the
 * confirm is measured against is testable without a surface. The lane's
 * `discardConfirmMessage` composes it into the popover's fact sheet.
 */
export function discardPreflightLine(rounds: number, files: number): string {
  const parts: string[] = [];
  if (rounds > 0) parts.push(`${rounds} round${rounds === 1 ? "" : "s"}`);
  // The entry's `files` is the arc's range diff, not worktree dirt, so the
  // line says `file` — the receipt (Spec S02) counts the same way.
  if (files > 0) parts.push(`${files} file${files === 1 ? "" : "s"}`);
  // An arc with neither is the light confirm: there is nothing to warn about,
  // and saying "discards 0 rounds" would invent a stake that is not there.
  if (parts.length === 0) return "Discards nothing — this arc has no work";
  return `Discards ${parts.join(" · ")}`;
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
 * vocabulary — icon, title, description, trailing actions — in
 * `TugInlineDialog`, where `PermissionDialog` and `QuestionDialog` also live.
 * So this composes it rather than stacking spans into a fourth reading of the
 * same idea. The mapping is the primitive's own: the situation names the title
 * row, the sentence that says what will happen is the description, and the one
 * control sits in `actions` where `Allow` and `Deny` sit.
 *
 * `detailIsElsewhere` is true for the blocker the join register already fronts
 * — its sentence is the row's own line, one line above, so the description
 * begins at the remedy instead of repeating it.
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
      description={
        <>
          {/* The files themselves, above the sentence that counts them
              ([P10]). The sentence can say "these 3 files" only because they
              are named right here; a count with nothing to check it against
              is a number the reader has to take on trust, which is not what a
              fact sheet is for. */}
          {paths.length > 0 ? (
            <ul
              className="session-changes-arc-join-paths"
              data-slot="session-changes-arc-join-paths"
            >
              {paths.map((path) => (
                <li key={path}>{path}</li>
              ))}
            </ul>
          ) : null}
          {detailIsElsewhere ? null : (
            <span className="session-changes-arc-join-detail">
              {blocker.detail}
            </span>
          )}
          {remedy !== undefined ? (
            <span className="session-changes-arc-join-act">
              {remedy.explain}
            </span>
          ) : null}
        </>
      }
      {...(remedy !== undefined
        ? {
            actions: (
              /* The remedy is never IN the button: the description carries
                 it, so the act is weighed before it is pressed, and the
                 control is always the same word — and always live ([L31]). */
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
    />
  );
}

export function SessionChangesArcJoin({
  entry,
  join,
  error,
  resolve,
  actions,
}: SessionChangesArcJoinProps): React.ReactElement | null {
  const conflicts = join?.conflicts ?? [];
  const archaeology = join?.archaeology ?? [];
  const blockers = join?.blockers ?? [];
  const resolved = join?.resolved ?? [];
  const staleNote =
    typeof join?.stale_note === "string" && join.stale_note !== ""
      ? join.stale_note
      : null;
  const question = join?.question ?? null;
  const stuck =
    typeof join?.stuck === "string" && join.stuck !== "" ? join.stuck : null;
  const report = join?.report ?? null;
  // The fold that stands over this arc, if one does. Durable — read off the
  // entry rather than out of the overlay — so a reload and a second deck show
  // the same receipt as the deck that pressed.
  const resolvedBase = join?.resolved_base ?? null;
  const reported = reportedBlockers(blockers);
  // One decision, made once ({@link deriveJoinFace}) and rendered here.
  const face = deriveJoinFace({
    join,
    resolvePhase: resolve.phase,
    resolveAct: resolve.act,
  });
  const { outcome, resolve: resolveFace } = face;

  // What the resolved face actually has to show. `resolved` is the face every
  // standing candidate wears, and the ordinary clean join reaches it having
  // resolved nothing and filed no account — so the word is not evidence, and
  // taking it for evidence put a `report` eyebrow over an empty box on every
  // arc that merged without a conflict.
  const resolvedRows = resolveFace === "resolved" && resolved.length > 0;
  const account =
    resolveFace === "resolved" &&
    report !== null &&
    (report.files.length > 0 ||
      (report.notes !== undefined && report.notes !== ""));

  // A section renders nothing it cannot say. Measured against what will
  // actually render below, never against the outcome word — an arc whose arc
  // has not started derives `blocked` with no blockers to show, and a `report`
  // eyebrow over that silence would be a row of chrome saying nothing.
  const speaks =
    staleNote !== null ||
    outcome === "empty" ||
    reported.length > 0 ||
    resolveFace === "progress" ||
    resolveFace === "folding" ||
    resolvedBase !== null ||
    resolvedRows ||
    account ||
    question !== null ||
    stuck !== null ||
    resolve.error !== null ||
    conflicts.length > 0 ||
    error !== null;
  if (!speaks) return null;

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
      {/* The server's own sentence for a candidate it has already dropped. It
          names which side moved, which is the whole of what the reader needs
          to decide whether to resolve again. */}
      {staleNote !== null ? (
        <div
          className="session-changes-arc-join-note"
          data-slot="session-changes-arc-join-stale"
        >
          {staleNote}
        </div>
      ) : null}
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
      {resolvedBase !== null ? (
        <div
          className="session-changes-arc-join-note"
          data-slot="session-changes-arc-join-resolve-receipt"
        >
          {resolvedBase.commit !== undefined
            ? `Committed base work as ${resolvedBase.commit.slice(0, 7)} · ${
                (resolvedBase.folded ?? []).length
              } ${(resolvedBase.folded ?? []).length === 1 ? "file" : "files"}`
            : `Dropped ${(resolvedBase.dropped ?? []).length} identical ${
                (resolvedBase.dropped ?? []).length === 1 ? "file" : "files"
              }`}
          {Object.entries(resolvedBase.folded_from ?? {}).map(
            ([path, holder]) => (
              <div
                key={path}
                className="session-changes-arc-join-detail"
                data-slot="session-changes-arc-join-resolve-holder"
              >
                {path} — work in progress from {holder}
              </div>
            ),
          )}
          {/* The one act on this face ([P08] is what buys the exception to
              [D142]'s no-acts rule): a receipt that reports a commit made out
              of somebody's uncommitted work has to carry the way back, or the
              report is a notification and not a remedy.

              It is disabled while a FOLD is running — the op it would reverse
              is the one being written — and the act is what the guard reads,
              not the phase. The two acts share `resolving`, and the ladder is
              the one that runs *after* a fold: the fold puts the base and the
              arc on divergent history, which is the collision the resolver
              exists for. A guard on the phase alone therefore switched the
              Undo off for the whole of the run that a successful fold
              provokes, which is precisely when a reader has just been told
              their work was committed and wants it back. */}
          <TugPushButton
            size="xs"
            emphasis="ghost"
            role="action"
            data-slot="session-changes-arc-join-undo-resolve-base"
            disabled={resolve.phase === "resolving" && resolve.act === "resolve-base"}
            onClick={() => actions.undoResolveBase(entry)}
          >
            Undo
          </TugPushButton>
        </div>
      ) : null}
      {/* A fold in flight, and no second sentence about it. The register is
          already saying `Committing base work · N files` above this row, so
          what belongs here is the detail that line cannot carry: which paths
          the fold is taking. Two lines with two words for one act is the whole
          defect the register exists to prevent. */}
      {resolveFace === "folding" ? (
        <ul
          className="session-changes-arc-join-rungs"
          data-slot="session-changes-arc-join-folding"
        >
          {blockers
            .filter((blocker) => blocker.kind === "base-dirt")
            .flatMap((blocker) => blocker.paths ?? [])
            .map((path) => (
              <li key={path}>{path}</li>
            ))}
        </ul>
      ) : null}
      {/* A ladder run says so for its whole duration, whether or not it has
          anything to stream yet. The rungs below the AI one resolve without
          emitting a delta, so a run that succeeds algorithmically produces an
          empty progress list — and an empty list under a Resolve button that
          just vanished is a press that did nothing. This line is the act's
          receipt; the list is whatever detail the run happens to have. */}
      {resolveFace === "progress" ? (
        <div
          className="session-changes-arc-join-running"
          role="status"
          data-slot="session-changes-arc-join-running"
        >
          <LoaderCircle size={12} className="session-changes-arc-join-spin" />
          Resolving {entry.display_name}…
        </div>
      ) : null}
      {resolveFace === "progress" && resolve.progress.length > 0 ? (
        <ul
          className="session-changes-arc-join-rungs"
          data-slot="session-changes-arc-join-progress"
        >
          {resolve.progress.map((file) => (
            <li key={file.path} data-status={file.status}>
              {/* The resolver rung reports a candidate rather than a file, so
                  the column names whichever it has. It used to render the sha
                  as a path, which read as a filename nobody could find. */}
              <span className="session-changes-arc-join-rung-path">
                {file.path !== "" ? file.path : (file.candidate ?? "")}
              </span>
              <span className="session-changes-arc-join-rung-word">
                {file.rung} · {file.status}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {resolvedRows ? (
        <ul
          className="session-changes-arc-join-rungs"
          data-slot="session-changes-arc-join-resolved"
        >
          {resolved.map((file) => (
            <li key={file.path} data-resolved-by={file.resolved_by}>
              <span className="session-changes-arc-join-rung-path">
                {file.path}
              </span>
              <span className="session-changes-arc-join-rung-word">
                {file.resolved_by}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {/* Where the review panel stood ([P07]). The human is no longer the
          auditor of machine text decisions: the resolver read every resolution
          against the arc's intent and had to account for each one ([P10]).
          So what shows here is the resolver's account, and nothing else — what
          the joined tree does was asked at the end of the run, against the
          tree that will actually land. */}
      {account ? (
        <div
          className="session-changes-arc-join-account"
          data-slot="session-changes-arc-join-account"
        >
          {report !== null && report.files.length > 0 ? (
            <ul
              className="session-changes-arc-join-report"
              data-slot="session-changes-arc-join-report"
            >
              {report.files.map((file) => (
                <li key={file.path} data-audit={file.audit ?? "finished"}>
                  <span className="session-changes-arc-join-report-path">
                    {file.path}
                  </span>
                  <span className="session-changes-arc-join-report-what">
                    {file.reconciliation}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
          {report !== null &&
          report.notes !== undefined &&
          report.notes !== "" ? (
            <div className="session-changes-arc-join-note">{report.notes}</div>
          ) : null}
        </div>
      ) : null}
      {/* The escalation ([P06]). The resolver reconciles from intent and asks
          only when the two sides want incompatible things — so what mounts
          here is the question, never a diff. `QuestionWizard` is the shipped
          surface for exactly this shape, taken through its host seam: the join
          supplies the transport, the wizard supplies the surface. */}
      {question !== null ? (
        <div
          className="session-changes-arc-join-question"
          data-slot="session-changes-arc-join-question"
        >
          <QuestionWizard
            requestId={question.request_id}
            questions={joinQuestionAsParsed(question)}
            isPending
            onSubmit={(answers) => {
              const answer = answers[question.question];
              if (typeof answer !== "string" || answer === "") return;
              actions.answerQuestion(entry, question.request_id, answer);
            }}
            onDecline={(response) =>
              actions.answerQuestion(entry, question.request_id, response)
            }
            onCancel={() =>
              actions.answerQuestion(
                entry,
                question.request_id,
                QUESTION_DECLINED_TO_CHOOSE,
              )
            }
          />
        </div>
      ) : null}
      {/* Why the last resolve stopped short. Durable and server-written, so
          unlike the overlay's error below it survives a reload — which matters
          because a resolve is minutes long and the deck that started it is
          often not the deck that comes back to it. A join that will not
          proceed and cannot say why is the one state this face must never
          render ([L31]). */}
      {stuck !== null ? (
        <div
          className="session-changes-arc-join-stuck"
          data-slot="session-changes-arc-join-stuck"
          role="alert"
        >
          {stuck}
        </div>
      ) : null}
      {/* Rendered on the reason, not on the face. A refused answer or a refused
          override arrives while a candidate stands, and the resolved face
          outranks the error one — so keying this off `resolveFace` swallowed
          exactly the refusals that have no other way to be seen ([L31]). */}
      {resolve.error !== null ? (
        <div
          className="session-changes-arc-join-error"
          data-slot="session-changes-arc-join-resolve-error"
          role="alert"
        >
          {resolve.error}
        </div>
      ) : null}
      {conflicts.length > 0 ? (
        <ul
          className="session-changes-arc-join-conflicts"
          data-slot="session-changes-arc-join-conflicts"
        >
          {conflicts.map((path) => {
            // What the base did to this path while the arc was away. A
            // conflict names a file and stops; this is the history that
            // explains it, and it is the difference between "resolve this"
            // and knowing what you are resolving against.
            const history = archaeology.find((h) => h.path === path) ?? null;
            const commits = history?.commits ?? [];
            const elided =
              history === null ? 0 : history.total - commits.length;
            return (
              <li key={path}>
                <span className="session-changes-arc-join-conflict-path">
                  {path}
                </span>
                {history !== null ? (
                  <ul
                    className="session-changes-arc-join-archaeology"
                    data-slot="session-changes-arc-join-archaeology"
                  >
                    {commits.map((commit) => (
                      <li key={commit.sha}>
                        <span className="session-changes-arc-join-archaeology-sha">
                          {commit.sha}
                        </span>
                        <span className="session-changes-arc-join-archaeology-subject">
                          {commit.subject}
                        </span>
                      </li>
                    ))}
                    {elided > 0 ? (
                      <li className="session-changes-arc-join-note">
                        +{elided} earlier
                      </li>
                    ) : null}
                  </ul>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      {error !== null ? (
        <div className="session-changes-arc-join-error" role="alert">
          {error}
        </div>
      ) : null}
    </div>
  );
}
