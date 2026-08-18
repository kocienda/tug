/**
 * `SessionChangesDashLanding` — the dash row's landing face.
 *
 * One line answering "what would landing this dash do right now?", and the act
 * that clears whatever the answer is. The outcome word comes from
 * `deriveJoinOutcome` ([#outcome-derivation]) so the lane and the join-mode
 * controller cannot disagree; each blocker renders its server-written detail
 * plus the one act that clears it ([#blocker-acts]).
 *
 * The face belongs to the **fronted** row only. `JoinState` is one slot per
 * card, not per dash, so two rows previewing would overwrite each other and the
 * loser would render the winner's blockers under its own name — and landing is
 * a gesture on this card's own dash anyway.
 *
 * Laws: [L02] every value here arrives as a prop from the view's store reads;
 * [L06] tone paints through `data-outcome` and CSS; [L19] the face composes
 * `TugBadge` / `TugPushButton` rather than hand-rolling chrome.
 *
 * @module components/tugways/cards/session-changes/session-changes-dash-landing
 */

import "./session-changes-dash-landing.css";

import React from "react";
import { LoaderCircle } from "lucide-react";

import { TugBadge, type TugBadgeRole } from "@/components/tugways/tug-badge";
import { TugPushButton } from "@/components/tugways/tug-push-button";
import { TugDiffDocument } from "@/components/tugways/tug-diff-document";
import type { DashChangesetEntry } from "@/lib/changeset-types";
import type { ConflictHistory, JoinBlocker, JoinPhase } from "@/lib/changeset-verb-store";
import type { ResolvedFile, ResolvePhase, ResolveState } from "@/lib/changeset-join-store";
import type { GitDiffFile, GitDiffPayload } from "@/lib/git-diff-store";
import {
  evaluateJoinLandGate,
  joinDisabledReason,
  resolutionAwaitsReview,
  type JoinOutcome,
} from "@/lib/join-mode-controller";

/** The lane's landing gestures, supplied by the card that owns the dash. */
export interface DashLandingActions {
  /** Ask the server what this join would do; fired when the fronted row opens. */
  preview: (entry: DashChangesetEntry) => void;
  /** Open the join-message editor over the previewed merge. */
  join: (entry: DashChangesetEntry) => void;
  /** Resume an interrupted teardown from the dash's join journal. */
  resumeTeardown: (entry: DashChangesetEntry) => void;
  /** Run the resolution ladder over a conflicted join. */
  resolve: (entry: DashChangesetEntry) => void;
  /** Acknowledge what the ladder decided — the beat that arms Join ([P31]). */
  markReviewed: (entry: DashChangesetEntry) => void;
}

/**
 * What the resolve lane shows, derived from the ladder's phase and whether it
 * built anything landable ([#outcome-derivation]).
 *
 * - `offer` — conflicted and untried: the ladder is the act that clears it.
 * - `progress` — running, streaming per file.
 * - `resolved` — a candidate exists; the join is landable after all.
 * - `partial` — the ladder's honest dead end. Some files are still conflicting,
 *   so there is nothing to land and no button that could pretend otherwise.
 * - `error` / `none` — the ladder refused, or has nothing to say here.
 *
 * A `resolved` phase with no candidate reads as `partial` for the same reason:
 * whatever it resolved, there is no commit to land.
 */
export type ResolveFace = "none" | "offer" | "progress" | "resolved" | "partial" | "error";

export function deriveResolveFace(
  outcome: JoinOutcome,
  phase: ResolvePhase,
  candidateCommit: string | null,
): ResolveFace {
  switch (phase) {
    case "resolving":
      return "progress";
    case "resolved":
      return candidateCommit !== null ? "resolved" : "partial";
    case "partial":
      return "partial";
    case "error":
      return "error";
    default:
      return outcome === "conflicted" ? "offer" : "none";
  }
}

export interface SessionChangesDashLandingProps {
  /** The dash this face describes — always the card's own. */
  entry: DashChangesetEntry;
  /** The derived landing outcome ([#outcome-derivation]). */
  outcome: JoinOutcome;
  /** The join round trip's phase, for the pending gate. */
  joinPhase: JoinPhase;
  /** Conflicting paths from the preview or an aborted execute. */
  conflicts: readonly string[];
  /** Per-path base history behind those conflicts (Spec S03); preview only. */
  archaeology: readonly ConflictHistory[];
  /** What would refuse this join, from the preview's preflight (Spec S03). */
  blockers: readonly JoinBlocker[];
  /** A verb-level refusal from an execute, if one came back. */
  error: string | null;
  /** A candidate commit from the resolution ladder, if one was built. */
  candidateCommit: string | null;
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
  actions: DashLandingActions;
}

/** The word the face fronts for each outcome. */
const OUTCOME_WORDS: Record<JoinOutcome, string> = {
  unknown: "not previewed",
  previewing: "previewing…",
  clean: "clean",
  conflicted: "conflicted",
  blocked: "blocked",
  empty: "empty",
};

const OUTCOME_ROLES: Record<JoinOutcome, TugBadgeRole> = {
  unknown: "data",
  previewing: "data",
  clean: "success",
  conflicted: "danger",
  blocked: "caution",
  empty: "data",
};

/**
 * The act that clears a blocker ([#blocker-acts]). Pure, and `null` for a kind
 * this deck has never heard of — an unknown blocker still renders its `detail`,
 * so a new server-side refusal is shown rather than swallowed (Spec S03).
 */
export function blockerAct(blocker: JoinBlocker, base: string): string | null {
  switch (blocker.kind) {
    case "off-base":
      return `Check out ${base} first`;
    case "base-dirt":
      return blocker.paths.length > 0
        ? `Commit or stash ${blocker.paths.join(", ")}`
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
 * The ladder's resolutions as one diff document — what landing this candidate
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
  resolved: readonly ResolvedFile[],
  workspaceKey: string,
): GitDiffPayload {
  const files: GitDiffFile[] = resolved
    .filter((file): file is ResolvedFile & { diff: string } => file.diff !== null)
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
export function resolutionReviewLine(resolved: readonly ResolvedFile[]): string {
  const count = resolved.length;
  const rungs = [...new Set(resolved.map((f) => f.resolvedBy))].sort();
  return `${count} file${count === 1 ? "" : "s"} resolved by ${rungs.join(", ")} — read this before it lands`;
}

export function SessionChangesDashLanding({
  entry,
  outcome,
  joinPhase,
  conflicts,
  archaeology,
  blockers,
  error,
  candidateCommit,
  turnInProgress,
  resolve,
  bindingRefusal,
  discardAvailable,
  discardDisabledReason,
  onRequestDiscard,
  actions,
}: SessionChangesDashLandingProps): React.ReactElement {
  // The message lives in the composer, not here, so the affordance asks the
  // gate everything *except* the message — opening the editor is what supplies
  // it. Same gate as the land itself ([P05]), so the two never disagree.
  const gate = evaluateJoinLandGate({
    turnInProgress,
    joinPhase,
    outcome,
    candidateCommit,
    unreviewedResolution: resolutionAwaitsReview(resolve),
    message: "x",
  });
  const disabledReason = gate.ok ? null : joinDisabledReason(gate.reason, outcome);
  // A stale journal blocks every other act, so the resume renders whatever the
  // outcome says — it is the one gesture that can make the rest reachable.
  const interrupted = entry.stage === "landing";
  const resolveFace = deriveResolveFace(outcome, resolve.phase, resolve.candidateCommit);
  const reviewPayload = React.useMemo(
    () => resolutionDiffPayload(resolve.resolved, entry.owner_id),
    [resolve.resolved, entry.owner_id],
  );
  const resumeHint =
    joinPhase === "pending"
      ? "A landing is in flight"
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
  if (disabledReason !== null) refusals.push({ control: "Join", reason: disabledReason });
  if (discardAvailable && discardDisabledReason !== null) {
    refusals.push({ control: "Discard", reason: discardDisabledReason });
  }
  if (bindingRefusal !== null) refusals.push(bindingRefusal);

  return (
    <div
      className="session-changes-dash-landing"
      data-slot="session-changes-dash-landing"
      data-outcome={outcome}
    >
      <div className="session-changes-dash-landing-head">
        <TugBadge
          emphasis="tinted"
          role={OUTCOME_ROLES[outcome]}
          size="2xs"
          data-slot="session-changes-dash-landing-outcome"
        >
          {OUTCOME_WORDS[outcome]}
        </TugBadge>
        <span className="session-changes-dash-landing-acts">
          {/* Offered while the ladder is the act that clears the conflict, and
              offered AGAIN after a run that failed — a refusal the user cannot
              answer is a dead end, and the ladder is the only door out of a
              conflicted dash. `partial` keeps no button on purpose: the ladder
              reached its honest end and re-running it decides nothing new. */}
          {resolveFace === "offer" || resolveFace === "error" ? (
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
          {interrupted ? (
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
          <TugPushButton
            size="xs"
            emphasis="filled"
            role="action"
            onClick={() => actions.join(entry)}
            disabled={disabledReason !== null}
            data-slot="session-changes-dash-join"
          >
            Join
          </TugPushButton>
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
      {refusals.length > 0 ? (
        <ul
          className="session-changes-dash-landing-refusals"
          data-slot="session-changes-dash-landing-refusals"
        >
          {refusals.map((refusal) => (
            <li key={refusal.control}>
              <span className="session-changes-dash-landing-refusal-control">
                {refusal.control}
              </span>
              <span className="session-changes-dash-landing-note">{refusal.reason}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {outcome === "empty" ? (
        <div
          className="session-changes-dash-landing-note"
          data-slot="session-changes-dash-landing-empty"
        >
          Nothing to join — discard this dash.
        </div>
      ) : null}
      {blockers.length > 0 ? (
        <ul
          className="session-changes-dash-landing-blockers"
          data-slot="session-changes-dash-landing-blockers"
        >
          {blockers.map((blocker, index) => {
            const act = blockerAct(blocker, entry.base);
            return (
              <li key={`${index}:${blocker.kind}`} data-blocker={blocker.kind}>
                <span className="session-changes-dash-landing-detail">
                  {blocker.detail}
                </span>
                {act !== null ? (
                  <span className="session-changes-dash-landing-act">{act}</span>
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
          className="session-changes-dash-landing-running"
          role="status"
          data-slot="session-changes-dash-landing-running"
        >
          <LoaderCircle size={12} className="session-changes-dash-landing-spin" />
          Resolving {entry.display_name}…
        </div>
      ) : null}
      {resolveFace === "progress" && resolve.progress.length > 0 ? (
        <ul
          className="session-changes-dash-landing-rungs"
          data-slot="session-changes-dash-landing-progress"
        >
          {resolve.progress.map((file) => (
            <li key={file.path} data-status={file.status}>
              <span className="session-changes-dash-landing-rung-path">{file.path}</span>
              <span className="session-changes-dash-landing-rung-word">
                {file.rung} · {file.status}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {resolveFace === "resolved" || resolveFace === "partial" ? (
        <ul
          className="session-changes-dash-landing-rungs"
          data-slot="session-changes-dash-landing-resolved"
        >
          {resolve.resolved.map((file) => (
            <li key={file.path} data-resolved-by={file.resolvedBy}>
              <span className="session-changes-dash-landing-rung-path">{file.path}</span>
              <span className="session-changes-dash-landing-rung-word">
                {file.resolvedBy}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {/* The review ([P31]). A candidate built out of per-file resolutions is a
          machine decision nobody has read: rerere replays a cache that can be
          stale, the driver and the AI rung guess. So the diffs render, and Join
          stays refused until the second beat acknowledges them — the same
          shape as the discard above, for the same reason. A rung-1 replay
          resolves no files and never lands here. */}
      {resolveFace === "resolved" && resolve.resolved.length > 0 ? (
        <div
          className="session-changes-dash-landing-review"
          data-slot="session-changes-dash-landing-review"
          data-reviewed={resolve.reviewed ? "true" : "false"}
        >
          {resolve.reviewed ? (
            <div className="session-changes-dash-landing-note">
              Reviewed — {resolve.resolved.length} resolved file
              {resolve.resolved.length === 1 ? "" : "s"} ready to land.
            </div>
          ) : (
            <>
              <div className="session-changes-dash-landing-note">
                {resolutionReviewLine(resolve.resolved)}
              </div>
              {/* Open, not collapsed: an acknowledgement over a folded-away
                  diff is a checkbox, which is the thing this replaces. */}
              <TugDiffDocument payload={reviewPayload} openAllByDefault />
              <TugPushButton
                size="xs"
                emphasis="filled"
                role="action"
                onClick={() => actions.markReviewed(entry)}
                data-slot="session-changes-dash-landing-reviewed"
              >
                Reviewed
              </TugPushButton>
            </>
          )}
        </div>
      ) : null}
      {resolveFace === "partial" ? (
        <div
          className="session-changes-dash-landing-note"
          data-slot="session-changes-dash-landing-partial"
        >
          Still conflicting — resolve by hand:{" "}
          {resolve.unresolved.join(", ")}
        </div>
      ) : null}
      {resolveFace === "error" ? (
        <div className="session-changes-dash-landing-error" role="alert">
          {resolve.error}
        </div>
      ) : null}
      {conflicts.length > 0 ? (
        <ul
          className="session-changes-dash-landing-conflicts"
          data-slot="session-changes-dash-landing-conflicts"
        >
          {conflicts.map((path) => {
            // What the base did to this path while the dash was away. A
            // conflict names a file and stops; this is the history that
            // explains it, and it is the difference between "resolve this"
            // and knowing what you are resolving against.
            const history = archaeology.find((h) => h.path === path) ?? null;
            const elided = history === null ? 0 : history.total - history.commits.length;
            return (
              <li key={path}>
                <span className="session-changes-dash-landing-conflict-path">{path}</span>
                {history !== null ? (
                  <ul
                    className="session-changes-dash-landing-archaeology"
                    data-slot="session-changes-dash-landing-archaeology"
                  >
                    {history.commits.map((commit) => (
                      <li key={commit.sha}>
                        <span className="session-changes-dash-landing-archaeology-sha">
                          {commit.sha}
                        </span>
                        <span className="session-changes-dash-landing-archaeology-subject">
                          {commit.subject}
                        </span>
                      </li>
                    ))}
                    {elided > 0 ? (
                      <li className="session-changes-dash-landing-note">
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
        <div className="session-changes-dash-landing-error" role="alert">
          {error}
        </div>
      ) : null}
    </div>
  );
}
