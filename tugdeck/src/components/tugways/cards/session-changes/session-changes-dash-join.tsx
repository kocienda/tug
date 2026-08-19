/**
 * `SessionChangesDashJoin` — the dash row's join face.
 *
 * One line answering "what would joining this dash do right now?", and **the
 * one act that advances it** — never a menu of acts, and never an act the gate
 * will then refuse. Blocked shows each blocker's server-written detail beside
 * the act that clears it; conflicted shows the paths and offers the ladder;
 * resolved shows what the ladder decided and offers the review that
 * acknowledges it; and joinable shows a sentence and nothing else at all.
 *
 * That last state is the point of the shape. There is no Join button here. The
 * one it replaces read as an action and performed a mode entry, so on every
 * state that could not join it stood there greyed out — a control offering a
 * press whose refusal was computed somewhere the press never reached. Joining
 * lives in the composer (⌃⌘C, or `/dash-join`), where the message is typed and
 * where a refusal can be both computed and shown; the readiness line's job is
 * to name that route, because with no control on the row a sentence is the only
 * thing standing between the reader and a dead end.
 *
 * Every value here is read from the dash's server-owned join block, so the face
 * and the join gate answer the same question from the same bytes.
 *
 * The face belongs to the **fronted** row only — joining is a gesture on this
 * card's own dash, and the composer it routes to is this card's own.
 *
 * Laws: [L02] every value here arrives as a prop from the view's store reads;
 * [L06] tone paints through `data-outcome` and CSS; [L19] the face composes
 * `TugBadge` / `TugPushButton` rather than hand-rolling chrome; [L31] every
 * refusal is on screen as face text, next to the act that clears it.
 *
 * @module components/tugways/cards/session-changes/session-changes-dash-join
 */

import "./session-changes-dash-join.css";

import React from "react";
import { LoaderCircle } from "lucide-react";

import { TugBadge, type TugBadgeRole } from "@/components/tugways/tug-badge";
import { TugPushButton } from "@/components/tugways/tug-push-button";
import { TugDiffDocument } from "@/components/tugways/tug-diff-document";
import type {
  DashChangesetEntry,
  DashJoinBlockerWire,
  DashJoinStateWire,
  DashResolvedFileWire,
} from "@/lib/changeset-types";
import type { JoinPhase } from "@/lib/changeset-verb-store";
import type { ResolvePhase, ResolveState } from "@/lib/changeset-join-store";
import type { GitDiffFile, GitDiffPayload } from "@/lib/git-diff-store";
import {
  deriveJoinOutcome,
  evaluateJoinGate,
  joinDisabledReason,
  resolutionAwaitsReview,
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
  /** Resume an interrupted teardown from the dash's join journal. */
  resumeTeardown: (entry: DashChangesetEntry) => void;
  /** Run the resolution ladder over a conflicted join. */
  resolve: (entry: DashChangesetEntry) => void;
  /** Acknowledge what the ladder decided — the beat that clears the gate. */
  markReviewed: (entry: DashChangesetEntry) => void;
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
): ResolveFace {
  if (phase === "resolving") return "progress";
  if (candidateCommit !== null) return "resolved";
  if (phase === "error") return "error";
  return outcome === "conflicted" || outcome === "stale" ? "offer" : "none";
}

/** The `data-slot` of every control this face can mount on the join path. */
export const JOIN_CONTROL = {
  resume: "session-changes-dash-resume",
  resolve: "session-changes-dash-resolve",
  reviewed: "session-changes-dash-join-reviewed",
} as const;

export type JoinControl = (typeof JOIN_CONTROL)[keyof typeof JOIN_CONTROL];

/** What the face shows for one state: the words, and the single act. */
export interface JoinFace {
  outcome: JoinOutcome;
  resolve: ResolveFace;
  /**
   * The one control that advances this join, or `null` where the state
   * advances by itself — a run in flight, a join in flight, a turn to wait
   * out, and the joinable state, whose act is the composer's ⬆.
   */
  control: JoinControl | null;
  /**
   * What the face states about joining, or `null` where the state's own block
   * already is that sentence — see {@link JoinFace.statedBelow}.
   */
  line: string | null;
  /**
   * The state's own block carries the refusal, so `line` deliberately does not
   * repeat it: the blockers name their causes and their acts, the conflicted
   * paths name themselves, the stale note is the server's own sentence.
   *
   * It is computed from the content that will actually render, not from the
   * outcome word, and that distinction is the whole reason it exists. A dash
   * whose join state never reached this deck derives `blocked` with *no*
   * blockers to show, so suppressing the line on the word alone left a row with
   * no control, no explanation, and no way to tell that from a working one.
   */
  statedBelow: boolean;
}

/**
 * Table T01 as a function: one feed state in, one act and one sentence out.
 *
 * Pure and exported so the face's shape is testable without a DOM, and — more
 * to the point — so there is one place that decides which control is on screen.
 * The old face decided that inline across five independent conditionals, which
 * is how it ended up mounting a disabled Join beside a Resolve beside a review
 * panel and leaving the reader to guess which one it wanted.
 */
export function deriveJoinFace(input: {
  join: DashJoinStateWire | null;
  resolvePhase: ResolvePhase;
  joinPhase: JoinPhase;
  turnInProgress: boolean;
  /** The dash is mid-teardown from an interrupted join (`stage === "joining"`). */
  interrupted: boolean;
}): JoinFace {
  const { join, resolvePhase, joinPhase, turnInProgress, interrupted } = input;
  const outcome = deriveJoinOutcome(join);
  const candidate =
    typeof join?.candidate === "string" && join.candidate !== "" ? join.candidate : null;
  const staleNote =
    typeof join?.stale_note === "string" && join.stale_note !== "" ? join.stale_note : null;
  const resolve = deriveResolveFace(outcome, resolvePhase, candidate);
  const gate = evaluateJoinGate({
    turnInProgress,
    joinPhase,
    outcome,
    candidateCommit: candidate,
    unreviewedResolution: resolutionAwaitsReview(join),
    // The message lives in the composer, so the row asks the gate everything
    // except that: opening the editor is what supplies it.
    message: "x",
  });
  const reason = gate.ok ? null : joinDisabledReason(gate.reason, outcome, staleNote);

  // An interrupted teardown outranks everything: it refuses every other act
  // server-side, so it is the only door out of this state.
  const control: JoinControl | null = interrupted
    ? JOIN_CONTROL.resume
    : (join?.blockers ?? []).length > 0
      ? null
      : resolve === "offer" || resolve === "error"
        ? JOIN_CONTROL.resolve
        : resolve === "resolved" && resolutionAwaitsReview(join)
          ? JOIN_CONTROL.reviewed
          : null;

  // Measured against what will render, never against the outcome word.
  const statedBelow =
    !gate.ok &&
    gate.reason === "outcome" &&
    ((outcome === "blocked" && (join?.blockers ?? []).length > 0) ||
      (outcome === "conflicted" && (join?.conflicts ?? []).length > 0) ||
      (outcome === "stale" && staleNote !== null) ||
      outcome === "empty");
  const line = gate.ok
    ? "Ready to join — ⌃⌘C, or /dash-join"
    : statedBelow
      ? null
      : reason;

  return { outcome, resolve, control, line, statedBelow };
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
  /** The join round trip's phase, for the pending gate. */
  joinPhase: JoinPhase;
  /** A verb-level refusal from an execute, if one came back. */
  error: string | null;
  /** A Claude turn is in flight — durable acts wait. */
  turnInProgress: boolean;
  /** The resolution ladder's live state for this dash. */
  resolve: ResolveState;
  /** What refuses the binding control on the row above, named so the face can
   *  say which control it is — the row calls it Bind or Unbind by binding. */
  bindingRefusal: { control: string; reason: string } | null;
  /** Whether this shade may discard this dash at all. False renders no Discard
   *  control — the reach rule's refusal is permanent, and a disabled control
   *  would invite waiting for something that is not coming. */
  discardAvailable: boolean;
  /** Why Discard is unavailable right now, or null. Read from the lane's one
   *  discard bundle so the turn gate and the in-flight gate cannot disagree
   *  with the same gates on the other rows. */
  discardDisabledReason: string | null;
  /** Arm the lane's discard confirm for this dash. The face never discards
   *  directly — one popover serves every row, and the lane owns it. */
  onRequestDiscard: () => void;
  actions: DashJoinActions;
}

/** The word the face fronts for each outcome. */
const OUTCOME_WORDS: Record<JoinOutcome, string> = {
  clean: "clean",
  conflicted: "conflicted",
  blocked: "blocked",
  empty: "empty",
  stale: "out of date",
};

const OUTCOME_ROLES: Record<JoinOutcome, TugBadgeRole> = {
  clean: "success",
  conflicted: "danger",
  blocked: "caution",
  empty: "data",
  stale: "caution",
};

/**
 * The act that clears a blocker ([#blocker-acts]). Pure, and `null` for a kind
 * this deck has never heard of — an unknown blocker still renders its `detail`,
 * so a new server-side refusal is shown rather than swallowed (Spec S03).
 */
export function blockerAct(blocker: DashJoinBlockerWire, base: string): string | null {
  const paths = blocker.paths ?? [];
  switch (blocker.kind) {
    case "off-base":
      return `Check out ${base} first`;
    case "base-dirt":
      return paths.length > 0
        ? `Commit or stash ${paths.join(", ")}`
        : "Commit or stash the overlapping changes";
    case "stale-journal":
      return "Resume the interrupted teardown";
    case "empty":
      return "Discard this dash";
    default:
      return null;
  }
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

/**
 * The status a resolution's own diff header declares. git says so explicitly for
 * a create and a delete; everything else is a modification.
 */
function resolutionStatus(unified: string): GitDiffFile["status"] {
  if (/^new file mode /m.test(unified)) return "added";
  if (/^deleted file mode /m.test(unified)) return "deleted";
  return "modified";
}

/**
 * The ladder's resolutions as one diff document — what joining this candidate
 * would do to each file it decided ([P31]).
 *
 * The server sends one unified chunk per resolved path, which is exactly
 * `GitDiffFile.unified`, so the review renders through the same
 * {@link TugDiffDocument} the Changes shade and the Diff card use rather than a
 * private diff surface. Pure, so what the review shows is testable without
 * mounting the shade. A resolution with no diff is dropped: it changes nothing
 * on the base, and an empty accordion row would read as one that does.
 *
 * The stat is the server's, which is git's. It is deliberately not counted off
 * the `unified` text beside it: that text is capped, and counting a capped view
 * reports `+0 −395` for a resolution that removed 2050 lines and added one —
 * wrong exactly when the diff is large enough for a reviewer to need the number
 * instead of reading it.
 */
export function resolutionDiffPayload(
  resolved: readonly DashResolvedFileWire[],
  workspaceKey: string,
): GitDiffPayload {
  const files: GitDiffFile[] = resolved
    .filter(
      (file): file is DashResolvedFileWire & { diff: string } =>
        typeof file.diff === "string" && file.diff !== "",
    )
    .map((file) => ({
      path: file.path,
      status: resolutionStatus(file.diff),
      added: file.added ?? 0,
      removed: file.removed ?? 0,
      binary: false,
      unified: file.diff,
    }));
  return {
    request_id: "dash-resolution-review",
    workspace_key: workspaceKey,
    base: "candidate",
    no_repo: false,
    file_count: files.length,
    total_added: files.reduce((sum, f) => sum + f.added, 0),
    total_removed: files.reduce((sum, f) => sum + f.removed, 0),
    files,
  };
}

/** The review's own header line — what the ladder did, and by which rungs. */
export function resolutionReviewLine(resolved: readonly DashResolvedFileWire[]): string {
  const count = resolved.length;
  const rungs = [...new Set(resolved.map((f) => f.resolved_by))].sort();
  return `${count} file${count === 1 ? "" : "s"} resolved by ${rungs.join(", ")} — read this before it joins`;
}

export function SessionChangesDashJoin({
  entry,
  join,
  joinPhase,
  error,
  turnInProgress,
  resolve,
  bindingRefusal,
  discardAvailable,
  discardDisabledReason,
  onRequestDiscard,
  actions,
}: SessionChangesDashJoinProps): React.ReactElement {
  const conflicts = join?.conflicts ?? [];
  const archaeology = join?.archaeology ?? [];
  const blockers = join?.blockers ?? [];
  const resolved = join?.resolved ?? [];
  const staleNote =
    typeof join?.stale_note === "string" && join.stale_note !== "" ? join.stale_note : null;
  const reviewed = join?.reviewed === true;
  // A stale journal refuses every other act server-side, so the resume is the
  // one gesture that can make the rest reachable.
  const interrupted = entry.stage === "joining";
  // One decision, made once ({@link deriveJoinFace}) and rendered here.
  const face = deriveJoinFace({
    join,
    resolvePhase: resolve.phase,
    joinPhase,
    turnInProgress,
    interrupted,
  });
  const { outcome, resolve: resolveFace, control, line: joinLine } = face;
  const reviewPayload = React.useMemo(
    () => resolutionDiffPayload(resolved, entry.owner_id),
    [resolved, entry.owner_id],
  );
  const resumeHint =
    joinPhase === "pending"
      ? "A join is in flight"
      : turnInProgress
        ? "Wait for the turn to finish"
        : null;
  // Every refusal on this surface, said out loud. A disabled button takes no
  // pointer events, so a `title` on one can never be read — the reason has to
  // arrive as face text or it does not arrive at all.
  const refusals: { control: string; reason: string }[] = [];
  if (interrupted && resumeHint !== null) {
    refusals.push({ control: "Resume teardown", reason: resumeHint });
  }
  if (discardAvailable && discardDisabledReason !== null) {
    refusals.push({ control: "Discard", reason: discardDisabledReason });
  }
  if (bindingRefusal !== null) refusals.push(bindingRefusal);

  return (
    <div
      className="session-changes-dash-join"
      data-slot="session-changes-dash-join"
      data-outcome={outcome}
    >
      <div className="session-changes-dash-join-head">
        <TugBadge
          emphasis="tinted"
          role={OUTCOME_ROLES[outcome]}
          size="2xs"
          data-slot="session-changes-dash-join-outcome"
        >
          {OUTCOME_WORDS[outcome]}
        </TugBadge>
        <span className="session-changes-dash-join-acts">
          {/* Offered while the ladder is the act that clears the conflict, and
              offered AGAIN after a run that failed — a refusal the user cannot
              answer is a dead end, and the ladder is the only door out of a
              conflicted dash. The ladder's own dead end — some files still
              conflicting — arrives as an error carrying their names. */}
          {control === JOIN_CONTROL.resolve ? (
            <TugPushButton
              size="xs"
              emphasis="outlined"
              role="action"
              // Ungated by the turn: resolving builds a candidate commit off
              // to the side and touches no checkout. Gating it locked a
              // conflicted dash's only escape hatch behind the agent.
              onClick={() => actions.resolve(entry)}
              data-slot="session-changes-dash-resolve"
            >
              {resolveFace === "error" ? "Resolve again" : "Resolve"}
            </TugPushButton>
          ) : null}
          {control === JOIN_CONTROL.resume ? (
            <TugPushButton
              size="xs"
              emphasis="filled"
              role="accent"
              onClick={() => actions.resumeTeardown(entry)}
              disabled={resumeHint !== null}
              data-slot="session-changes-dash-resume"
            >
              Resume teardown
            </TugPushButton>
          ) : null}
          {/* Shade-only, on the row: a discard is not a thing to reach by
              chord or by typing a verb. One beat — it opens the lane's confirm
              popover, which names what the discard destroys and where the
              worktree's uncommitted files go. */}
          {discardAvailable ? (
            <TugPushButton
              size="xs"
              emphasis="outlined"
              role="danger"
              onClick={onRequestDiscard}
              disabled={discardDisabledReason !== null}
              data-slot="session-changes-dash-discard"
            >
              Discard
            </TugPushButton>
          ) : null}
        </span>
      </div>
      {joinLine !== null ? (
        <div
          className="session-changes-dash-join-note"
          data-slot="session-changes-dash-join-ready"
          data-ready={control === null && outcome === "clean" ? "true" : "false"}
        >
          {joinLine}
        </div>
      ) : null}
      {refusals.length > 0 ? (
        <ul
          className="session-changes-dash-join-refusals"
          data-slot="session-changes-dash-join-refusals"
        >
          {refusals.map((refusal) => (
            <li key={refusal.control}>
              <span className="session-changes-dash-join-refusal-control">
                {refusal.control}
              </span>
              <span className="session-changes-dash-join-note">{refusal.reason}</span>
            </li>
          ))}
        </ul>
      ) : null}
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
      {blockers.length > 0 ? (
        <ul
          className="session-changes-dash-join-blockers"
          data-slot="session-changes-dash-join-blockers"
        >
          {blockers.map((blocker, index) => {
            const act = blockerAct(blocker, entry.base);
            return (
              <li key={`${index}:${blocker.kind}`} data-blocker={blocker.kind}>
                <span className="session-changes-dash-join-detail">
                  {blocker.detail}
                </span>
                {act !== null ? (
                  <span className="session-changes-dash-join-act">{act}</span>
                ) : null}
              </li>
            );
          })}
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
              <span className="session-changes-dash-join-rung-path">{file.path}</span>
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
              <span className="session-changes-dash-join-rung-path">{file.path}</span>
              <span className="session-changes-dash-join-rung-word">
                {file.resolved_by}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {/* The review ([D115]). A candidate built out of per-file resolutions is
          a machine decision nobody has read: rerere replays a cache that can be
          stale, the driver and the AI rung guess. So the diffs render, and the
          the join stays refused until the second beat acknowledges them — the
          same shape as the discard above, for the same reason. A rung-1 replay
          resolves no files and never joins here. */}
      {resolveFace === "resolved" && resolved.length > 0 ? (
        <div
          className="session-changes-dash-join-review"
          data-slot="session-changes-dash-join-review"
          data-reviewed={reviewed ? "true" : "false"}
        >
          {control !== JOIN_CONTROL.reviewed ? (
            <div className="session-changes-dash-join-note">
              Reviewed — {resolved.length} resolved file
              {resolved.length === 1 ? "" : "s"} ready to join.
            </div>
          ) : (
            <>
              <div className="session-changes-dash-join-note">
                {resolutionReviewLine(resolved)}
              </div>
              {/* Open, not collapsed: an acknowledgement over a folded-away
                  diff is a checkbox, which is the thing this replaces. */}
              <TugDiffDocument payload={reviewPayload} openAllByDefault />
              <TugPushButton
                size="xs"
                emphasis="filled"
                role="action"
                onClick={() => actions.markReviewed(entry)}
                data-slot="session-changes-dash-join-reviewed"
              >
                Reviewed
              </TugPushButton>
            </>
          )}
        </div>
      ) : null}
      {resolveFace === "error" ? (
        <div className="session-changes-dash-join-error" role="alert">
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
            const elided = history === null ? 0 : history.total - commits.length;
            return (
              <li key={path}>
                <span className="session-changes-dash-join-conflict-path">{path}</span>
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
