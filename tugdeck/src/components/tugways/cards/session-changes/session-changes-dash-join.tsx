/**
 * `SessionChangesDashJoin` — the fold's **report**: the join's evidence.
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
 * Every value here is read from the dash's server-owned join block, so the
 * face and the join gate answer the same question from the same bytes.
 *
 * The face belongs to the **fronted** row only — joining is a gesture on this
 * card's own dash, and the composer it routes to is this card's own.
 *
 * Laws: [L02] every value here arrives as a prop from the view's store reads;
 * [L06] tone paints through `data-outcome` and CSS; [L19] the section
 * composes `TugSectionLabel` rather than hand-rolling an eyebrow; [L31] every
 * refusal is on screen — on the control that refuses, or as the blocker's own
 * sentence here.
 *
 * @module components/tugways/cards/session-changes/session-changes-dash-join
 */

import "./session-changes-dash-join.css";

import React from "react";
import { LoaderCircle, Lock, TriangleAlert } from "lucide-react";

import { TugSectionLabel } from "@/components/tugways/tug-section-label";
import { TugInlineDialog } from "@/components/tugways/tug-inline-dialog";
import { TugPushButton } from "@/components/tugways/tug-push-button";
import {
  QuestionWizard,
  type ParsedQuestion,
} from "@/components/tugways/chrome/session-question-dialog";
import type {
  DashChangesetEntry,
  DashJoinBlockerWire,
  DashJoinQuestionWire,
  DashJoinStateWire,
  DashResolvedFileWire,
} from "@/lib/changeset-types";
import type { ResolvePhase, ResolveState } from "@/lib/changeset-join-store";
import {
  deriveJoinOutcome,
  type JoinOutcome,
} from "@/lib/join-mode-controller";

/**
 * The lane's join gestures, supplied by the card that owns the dash.
 *
 * There is deliberately no gesture here that joins, and none that opens the
 * join editor. Joining is the composer's — ⌃⌘C, or `/dash-join` — and the
 * composer's ⬆ is the only control that fires one. A row-level button that
 * *entered a mode* while reading as an action was the resting lie this lane
 * carried: it claimed a join, and on every state that could not join it
 * greyed itself out and said so in a place the press never reached.
 */
export interface DashJoinActions {
  /** Point the join mode at this dash without entering it — the row's expand. */
  aim: (entry: DashChangesetEntry) => void;
  /**
   * Answer the intent question a blocked resolver raised ([P06]).
   *
   * `answer` is an option's label or the user's own words; both reach the
   * resolver verbatim, because deciding which one the user "really meant" is
   * not the face's call.
   */
  answerQuestion: (
    entry: DashChangesetEntry,
    requestId: string,
    answer: string,
  ) => void;
  /**
   * Clear the base-side work refusing this dash's join ([#blocker-acts]).
   *
   * One act for every resolvable blocker, because the server decides what the
   * act *is* and says so in the blocker's own remedy sentence. The control is
   * always the same word.
   */
  resolveBase: (entry: DashChangesetEntry) => void;
}

/**
 * What the resolve lane shows, derived from the ladder's phase and whether it
 * built anything joinable ([#outcome-derivation]).
 *
 * - `offer` — conflicted and untried: the ladder is the act that clears it.
 * - `progress` — running, streaming per file.
 * - `resolved` — a candidate exists; the join is joinable after all.
 * - `error` / `none` — the ladder refused or reached its dead end, or has
 *   nothing to say here.
 */
export type ResolveFace = "none" | "offer" | "progress" | "resolved" | "error";

/**
 * The candidate outranks the progress phase, and that ordering is what makes a
 * resolution survive a reload: the phase is a live overlay that dies with the
 * page, while the candidate is a git ref the server re-reports on every
 * recompute. Ranked the other way, reopening the deck after a successful
 * Resolve would show a clean dash with no review panel and join it unread.
 */
export function deriveResolveFace(
  outcome: JoinOutcome,
  phase: ResolvePhase,
  candidateCommit: string | null,
  run?: string | null,
): ResolveFace {
  if (phase === "resolving") return "progress";
  // The server's own account of what it is doing right now ([P09]). The phase
  // above it is a client overlay that dies with the page, so without this a
  // reload during a resolve — or a second deck watching the same dash — renders
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
 * (`dashJoinRegister`) owns the sentence, and `evaluateJoinGate` owns the
 * press, each already one place. What remains is the pair the evidence panel
 * dispatches on: the outcome the tones follow, and which resolve face the
 * ladder's state has earned.
 */
export function deriveJoinFace(input: {
  join: DashJoinStateWire | null;
  resolvePhase: ResolvePhase;
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
  );
  return { outcome, resolve };
}

export interface SessionChangesDashJoinProps {
  /** The dash this face describes — always the card's own. */
  entry: DashChangesetEntry;
  /**
   * The dash's server-owned join state, straight off its feed entry: blockers,
   * conflicts, the candidate and what the ladder decided per path. Everything
   * this face says about a join is read from here, so the face and the join
   * gate cannot disagree.
   */
  join: DashJoinStateWire | null;
  /** A verb-level refusal from an execute, if one came back. */
  error: string | null;
  /** The resolution ladder's live state for this dash. */
  resolve: ResolveState;
  actions: DashJoinActions;
}

/**
 * Whether this blocker's Resolve can be pressed ([#blocker-acts]).
 *
 * Pure, and it reads the server's own verdict rather than deciding one: a
 * remedy with `refused` set is a blocker somebody else has to clear, and a
 * blocker with no remedy at all is a kind nothing at this card can act on —
 * an off-base checkout, a teardown left by a crash. A refusal this deck has
 * never heard of is still shown rather than swallowed (Spec S03) — as its own
 * sentence here, or as the register's line when it is the first blocker.
 */
export function remedyRefusal(blocker: DashJoinBlockerWire): string | null {
  if (blocker.remedy === undefined) return null;
  return blocker.remedy.refused ?? null;
}

/** One blocker this report has something to add about, and its place. */
export interface ReportedBlocker {
  blocker: DashJoinBlockerWire;
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
  blockers: readonly DashJoinBlockerWire[],
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
  // The entry's `files` is the dash's range diff, not worktree dirt, so the
  // line says `file` — the receipt (Spec S02) counts the same way.
  if (files > 0) parts.push(`${files} file${files === 1 ? "" : "s"}`);
  // A dash with neither is the light confirm: there is nothing to warn about,
  // and saying "discards 0 rounds" would invent a stake that is not there.
  if (parts.length === 0) return "Discards nothing — this dash has no work";
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
  question: DashJoinQuestionWire,
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
 * The icon splits on whose turn it is, not on severity: a hold somebody else
 * has to release is a lock, and the caution glyph is kept for the one the
 * reader can act on.
 */
function BlockerDialog({
  blocker,
  detailIsElsewhere,
  entry,
  resolve,
  actions,
}: {
  blocker: DashJoinBlockerWire;
  detailIsElsewhere: boolean;
  entry: DashChangesetEntry;
  resolve: ResolveState;
  actions: DashJoinActions;
}): React.ReactElement {
  const remedy = blocker.remedy;
  const refused = remedyRefusal(blocker);
  return (
    <TugInlineDialog
      className="session-changes-dash-join-blocker"
      icon={refused !== null ? <Lock /> : <TriangleAlert />}
      iconRole={refused !== null ? "default" : "caution"}
      title={blocker.title}
      description={
        <>
          {detailIsElsewhere ? null : (
            <span className="session-changes-dash-join-detail">
              {blocker.detail}
            </span>
          )}
          {remedy !== undefined ? (
            <span className="session-changes-dash-join-act">
              {remedy.explain}
            </span>
          ) : null}
        </>
      }
      {...(remedy !== undefined
        ? {
            actions: (
              <>
                {/* The remedy is never IN the button: the description carries
                    it, so the act is weighed before it is pressed, and the
                    control is always the same word. A blocker nobody here can
                    clear keeps the whole shape and wears its reason beside a
                    dead button ([L31]). */}
                {refused !== null ? (
                  <span className="session-changes-dash-join-refused">
                    {refused}
                  </span>
                ) : null}
                <TugPushButton
                  size="xs"
                  emphasis="primary"
                  role="action"
                  disabled={refused !== null || resolve.phase === "resolving"}
                  loading={resolve.phase === "resolving"}
                  onClick={() => actions.resolveBase(entry)}
                  data-slot="session-changes-dash-join-resolve-base"
                >
                  Resolve
                </TugPushButton>
              </>
            ),
          }
        : {})}
    />
  );
}

export function SessionChangesDashJoin({
  entry,
  join,
  error,
  resolve,
  actions,
}: SessionChangesDashJoinProps): React.ReactElement | null {
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
  const reported = reportedBlockers(blockers);
  // One decision, made once ({@link deriveJoinFace}) and rendered here.
  const face = deriveJoinFace({ join, resolvePhase: resolve.phase });
  const { outcome, resolve: resolveFace } = face;

  // A section renders nothing it cannot say. Measured against what will
  // actually render below, never against the outcome word — a dash whose arc
  // has not started derives `blocked` with no blockers to show, and a `report`
  // eyebrow over that silence would be a row of chrome saying nothing.
  const speaks =
    staleNote !== null ||
    outcome === "empty" ||
    reported.length > 0 ||
    resolveFace === "progress" ||
    resolveFace === "resolved" ||
    question !== null ||
    stuck !== null ||
    resolve.error !== null ||
    conflicts.length > 0 ||
    error !== null;
  if (!speaks) return null;

  return (
    <div
      className="session-changes-dash-join"
      data-slot="session-changes-dash-join"
      data-outcome={outcome}
    >
      <TugSectionLabel
        label={{ name: "report" }}
        slot="session-changes-dash-join-label"
      />
      {/* The server's own sentence for a candidate it has already dropped. It
          names which side moved, which is the whole of what the reader needs
          to decide whether to resolve again. */}
      {staleNote !== null ? (
        <div
          className="session-changes-dash-join-note"
          data-slot="session-changes-dash-join-stale"
        >
          {staleNote}
        </div>
      ) : null}
      {outcome === "empty" ? (
        <div
          className="session-changes-dash-join-note"
          data-slot="session-changes-dash-join-empty"
        >
          Nothing to join — discard this dash.
        </div>
      ) : null}
      {reported.length > 0 ? (
        <div
          className="session-changes-dash-join-blockers"
          data-slot="session-changes-dash-join-blockers"
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
      {/* A ladder run says so for its whole duration, whether or not it has
          anything to stream yet. The rungs below the AI one resolve without
          emitting a delta, so a run that succeeds algorithmically produces an
          empty progress list — and an empty list under a Resolve button that
          just vanished is a press that did nothing. This line is the act's
          receipt; the list is whatever detail the run happens to have. */}
      {resolveFace === "progress" ? (
        <div
          className="session-changes-dash-join-running"
          role="status"
          data-slot="session-changes-dash-join-running"
        >
          <LoaderCircle size={12} className="session-changes-dash-join-spin" />
          Resolving {entry.display_name}…
        </div>
      ) : null}
      {resolveFace === "progress" && resolve.progress.length > 0 ? (
        <ul
          className="session-changes-dash-join-rungs"
          data-slot="session-changes-dash-join-progress"
        >
          {resolve.progress.map((file) => (
            <li key={file.path} data-status={file.status}>
              {/* The resolver rung reports a candidate rather than a file, so
                  the column names whichever it has. It used to render the sha
                  as a path, which read as a filename nobody could find. */}
              <span className="session-changes-dash-join-rung-path">
                {file.path !== "" ? file.path : (file.candidate ?? "")}
              </span>
              <span className="session-changes-dash-join-rung-word">
                {file.rung} · {file.status}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {resolveFace === "resolved" ? (
        <ul
          className="session-changes-dash-join-rungs"
          data-slot="session-changes-dash-join-resolved"
        >
          {resolved.map((file) => (
            <li key={file.path} data-resolved-by={file.resolved_by}>
              <span className="session-changes-dash-join-rung-path">
                {file.path}
              </span>
              <span className="session-changes-dash-join-rung-word">
                {file.resolved_by}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {/* Where the review panel stood ([P07]). The human is no longer the
          auditor of machine text decisions: the resolver read every resolution
          against the dash's intent and had to account for each one ([P10]).
          So what shows here is the resolver's account, and nothing else — what
          the joined tree does was asked at the end of the run, against the
          tree that will actually land. */}
      {resolveFace === "resolved" ? (
        <div
          className="session-changes-dash-join-account"
          data-slot="session-changes-dash-join-account"
        >
          {report !== null ? (
            <ul
              className="session-changes-dash-join-report"
              data-slot="session-changes-dash-join-report"
            >
              {report.files.map((file) => (
                <li key={file.path} data-audit={file.audit ?? "finished"}>
                  <span className="session-changes-dash-join-report-path">
                    {file.path}
                  </span>
                  <span className="session-changes-dash-join-report-what">
                    {file.reconciliation}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
          {report !== null &&
          report.notes !== undefined &&
          report.notes !== "" ? (
            <div className="session-changes-dash-join-note">{report.notes}</div>
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
          className="session-changes-dash-join-question"
          data-slot="session-changes-dash-join-question"
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
          className="session-changes-dash-join-stuck"
          data-slot="session-changes-dash-join-stuck"
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
          className="session-changes-dash-join-error"
          data-slot="session-changes-dash-join-resolve-error"
          role="alert"
        >
          {resolve.error}
        </div>
      ) : null}
      {conflicts.length > 0 ? (
        <ul
          className="session-changes-dash-join-conflicts"
          data-slot="session-changes-dash-join-conflicts"
        >
          {conflicts.map((path) => {
            // What the base did to this path while the dash was away. A
            // conflict names a file and stops; this is the history that
            // explains it, and it is the difference between "resolve this"
            // and knowing what you are resolving against.
            const history = archaeology.find((h) => h.path === path) ?? null;
            const commits = history?.commits ?? [];
            const elided =
              history === null ? 0 : history.total - commits.length;
            return (
              <li key={path}>
                <span className="session-changes-dash-join-conflict-path">
                  {path}
                </span>
                {history !== null ? (
                  <ul
                    className="session-changes-dash-join-archaeology"
                    data-slot="session-changes-dash-join-archaeology"
                  >
                    {commits.map((commit) => (
                      <li key={commit.sha}>
                        <span className="session-changes-dash-join-archaeology-sha">
                          {commit.sha}
                        </span>
                        <span className="session-changes-dash-join-archaeology-subject">
                          {commit.subject}
                        </span>
                      </li>
                    ))}
                    {elided > 0 ? (
                      <li className="session-changes-dash-join-note">
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
        <div className="session-changes-dash-join-error" role="alert">
          {error}
        </div>
      ) : null}
    </div>
  );
}
