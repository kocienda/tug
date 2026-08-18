/**
 * `SessionChangesDashLane` — the Changes shade's dash lane.
 *
 * A dash is not a claim. Rendered in session-file grammar a dash branch reads
 * as one — so it gets its own species of row: name · base · rounds · dirty ·
 * stage, its own per-row fold, and no claim, disclaim, or hunk-election
 * affordance anywhere inside it. The lane's one diff affordance is the whole-
 * range pop-out, because the server's range diff takes no pathspec and the dash
 * is the unit anyway.
 *
 * **Every dash in the project is a visible row.** The card's own dash renders
 * first and expanded; the rest follow under a plain label, each collapsed to
 * its one-line sentence. They used to hide behind a `N dashes` count, which is
 * the same mistake the unattributed-files bucket avoids by showing its rows: a
 * count is a rumor, a row is a situation you can act on. Each costs one line,
 * so showing them all costs a handful — and the fold's own cue was the control
 * at0405's chronic "did not land" click was aimed at.
 *
 * Per-row expansion stays view-scope state: the shade is a glance surface,
 * dismiss and forget, so nothing here is persisted.
 *
 * The fronted row — and only it — carries a landing face: the outcome of a
 * live `--preview` plus the act that clears it. `JoinState` is one slot per
 * card rather than per dash, so a second row previewing would overwrite the
 * first and render its blockers under the wrong name; landing is a gesture on
 * this card's own dash regardless.
 *
 * The two **binding** gestures go the other way. Every row carries one: Unbind
 * on the fronted row, Bind on all the rest, complements that never appear
 * together. This is the room where a dash's facts already live, so the act of
 * taking a dash on belongs beside the facts you would take it on for — and
 * "non-fronted rows stay read-only" was always a rule about *landing*, a
 * gesture on work a card never touched. Binding is how a card comes to touch
 * it.
 *
 * Laws: [L02] the lane takes its data as props from the view's
 * `useSyncExternalStore` reads; [L06] tone and state paint through CSS and
 * data attributes; [L19] the row composes `TugBadge` / `TugListRow` /
 * `BlockFoldCue` / `PopOutDiffButton` rather than hand-rolling chrome.
 *
 * @module components/tugways/cards/session-changes/session-changes-dash-lane
 */

import "./session-changes-dash-lane.css";

import React, { useEffect, useRef, useState } from "react";

import { TugBadge } from "@/components/tugways/tug-badge";
import { TugPushButton } from "@/components/tugways/tug-push-button";
import { TugListRow } from "@/components/tugways/tug-list-row";
import { TugStatusMark } from "@/components/tugways/tug-status-mark";
import { TugTooltip } from "@/components/tugways/tug-tooltip";
import { dashReviewPaints, dashReviewTooltip } from "@/lib/dash-review";
import { BlockFoldCue } from "@/components/tugways/body-kinds/affordances/block-fold-cue";
import { PopOutDiffButton } from "@/components/tugways/tug-changes-list";
import { TugConfirmPopover } from "@/components/tugways/tug-confirm-popover";
import {
  SessionChangesDashLanding,
  discardPreflightLine,
  type DashLandingActions,
} from "./session-changes-dash-landing";
import type { DiffDescriptor } from "@/lib/git-diff-store";
import type { DashChangesetEntry } from "@/lib/changeset-types";
import type { JoinState } from "@/lib/changeset-verb-store";
import type { ResolveState } from "@/lib/changeset-join-store";
import type { JoinOutcome } from "@/lib/join-mode-controller";

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

/** The lane's two groups: the card's own dash, then everything else. */
export interface DashLaneOrder {
  /** The dash this card's session is mated to, or null when unbound. */
  fronted: DashChangesetEntry | null;
  /** Every other dash in the project, in snapshot order. */
  rest: DashChangesetEntry[];
}

/**
 * Split the project's dashes into the fronted one and the rest.
 *
 * The match is on the **owner key**, never the name: a stale binding to a dead
 * incarnation of a reused name must not front the wrong dash. An unmatched
 * binding is simply an unbound lane — which is also what the one-recompose
 * window after a bind that minted a new id should show.
 */
export function orderDashLane(
  dashes: readonly DashChangesetEntry[],
  boundDashId: string | null,
): DashLaneOrder {
  const fronted =
    boundDashId !== null
      ? (dashes.find((entry) => entry.owner_id === boundDashId) ?? null)
      : null;
  return {
    fronted,
    rest: dashes.filter((entry) => entry !== fronted),
  };
}

/** The dash's git ref — `branch`, falling back to the older sender's spelling. */
export function dashBranchRef(entry: DashChangesetEntry): string {
  return entry.branch ?? `tugdash/${entry.display_name}`;
}

function roundsLabel(rounds: number): string {
  return rounds === 1 ? "1 round" : `${rounds} rounds`;
}

/** At most this many paths in a mark's tooltip; the count carries the rest. */
const MARK_TOOLTIP_PATHS = 8;

function pathList(paths: ReadonlyArray<string>): string {
  const shown = paths.slice(0, MARK_TOOLTIP_PATHS).join("\n");
  const rest = paths.length - MARK_TOOLTIP_PATHS;
  return rest > 0 ? `${shown}\n…and ${rest} more` : shown;
}

/**
 * How far this dash has drifted from its base, said the moment it becomes true
 * rather than at landing time.
 *
 * Four marks over the snapshot's divergence fields, most urgent first. A
 * conflicted replay is a state somebody has to resolve; base dirt overlapping
 * the dash's own files is a warning about work that is not the machine's to
 * touch; being behind is ordinary and usually transient (the engine is
 * probably replaying it as you read); a settled replay mark is the quiet
 * receipt that history moved under this dash and nothing asked you about it.
 *
 * Every state is a data attribute the CSS paints from ([L06]); the values come
 * off the changeset entry the card already subscribes to ([L02]).
 */
function DashDivergenceMarks({ entry }: { entry: DashChangesetEntry }) {
  const conflicts = entry.replay_conflict_paths ?? [];
  const overlap = entry.base_overlap ?? [];
  const ahead = entry.base_ahead ?? 0;
  const settled = entry.last_replay;
  if (
    conflicts.length === 0 &&
    overlap.length === 0 &&
    ahead === 0 &&
    (settled === undefined || settled === "")
  ) {
    return null;
  }
  return (
    <>
      {conflicts.length > 0 ? (
        <>
          <span className="session-changes-dash-sep">·</span>
          <TugTooltip
            content={`Replaying this dash onto ${entry.base} conflicts in:\n${pathList(conflicts)}`}
          >
            <span
              className="session-changes-dash-divergence"
              data-slot="session-changes-dash-divergence"
              data-divergence="conflicted"
            >
              {`replay conflicts (${conflicts.length})`}
            </span>
          </TugTooltip>
        </>
      ) : null}
      {overlap.length > 0 ? (
        <>
          <span className="session-changes-dash-sep">·</span>
          <TugTooltip
            content={`Uncommitted work on ${entry.base} touches files this dash also changes:\n${pathList(overlap)}`}
          >
            <span
              className="session-changes-dash-divergence"
              data-slot="session-changes-dash-divergence"
              data-divergence="overlap"
            >
              {`base overlap (${overlap.length})`}
            </span>
          </TugTooltip>
        </>
      ) : null}
      {ahead > 0 ? (
        <>
          <span className="session-changes-dash-sep">·</span>
          <TugTooltip
            content={`${entry.base} has gained ${ahead === 1 ? "1 commit" : `${ahead} commits`} this dash does not have yet.`}
          >
            <span
              className="session-changes-dash-divergence"
              data-slot="session-changes-dash-divergence"
              data-divergence="behind"
            >
              {`base +${ahead}`}
            </span>
          </TugTooltip>
        </>
      ) : null}
      {ahead === 0 && conflicts.length === 0 && settled !== undefined && settled !== "" ? (
        <>
          <span className="session-changes-dash-sep">·</span>
          <TugTooltip content={`Replayed ${settled}`}>
            <span
              className="session-changes-dash-divergence"
              data-slot="session-changes-dash-divergence"
              data-divergence="settled"
            >
              replayed
            </span>
          </TugTooltip>
        </>
      ) : null}
    </>
  );
}

/**
 * Everything the fronted row's landing face needs, read once by the view and
 * handed down. Absent on every other row — see the module docblock for why the
 * face is the fronted row's alone.
 */
export interface DashLaneLanding {
  /** The card's one join round trip ([L02], read by the view). */
  join: JoinState;
  /** The derived outcome ([#outcome-derivation]). */
  outcome: JoinOutcome;
  /** A candidate commit from the resolution ladder, if one was built. */
  candidateCommit: string | null;
  /** A Claude turn is in flight — durable acts wait. */
  turnInProgress: boolean;
  /** The resolution ladder's live state for the fronted dash. */
  resolve: ResolveState;
  actions: DashLandingActions;
}

/**
 * The lane's two binding gestures ([P05]).
 *
 * Unlike {@link DashLaneLanding}, this bundle goes to **every** row: Bind's
 * whole population is the rows the landing face never reaches, and a row picks
 * Bind or Unbind from its own `fronted` flag — the two are complements, so they
 * never appear together and the cluster stays one affordance wide.
 *
 * Neither callback may move `cardSessionBindingStore`. The `bind_dash_ok` /
 * `unbind_dash_ok` broadcasts are the only movers, which is what leaves a card
 * correctly bound to what it was when a bind is refused.
 */
/**
 * The lane's discard gesture, for every row the reach rule allows.
 *
 * Like {@link DashLaneBinding} and unlike {@link DashLaneLanding}, this reaches
 * past the fronted row: an unbound dash nobody is holding is exactly the kind a
 * shade should be able to clean up, and the `empty` landing outcome's own
 * answer is discard rather than a fix.
 */
export interface DashLaneDiscard {
  /** Whether this shade may discard this dash ({@link canDiscardFromHere}). */
  canDiscard: (entry: DashChangesetEntry) => boolean;
  /** Send `changeset_discard`. Called by the confirm popover, never a button. */
  discard: (entry: DashChangesetEntry) => void;
  /**
   * Why every Discard on this lane is unavailable right now, or null.
   *
   * Folds two gates. A turn in flight is the owner's rule — a dash is only
   * discarded when no turn is running in the session bound to it, which is
   * always *this* card's turn, because the reach rule renders no control for a
   * dash another live session holds. And a discard already in flight, because
   * `DiscardState` is one slot per card: arming a second row would let the two
   * render each other's phase.
   */
  disabledReason: string | null;
}

export interface DashLaneBinding {
  /** Send `bind_dash` for this row's dash. */
  bind: (entry: DashChangesetEntry) => void;
  /** Send `unbind_dash` for this card's session. */
  unbind: (entry: DashChangesetEntry) => void;
  /** Why both are unavailable right now, or null when they are available.
   *  Disabled with a reason rather than silently bouncing. */
  disabledReason: string | null;
}

/**
 * Whether this shade may discard this dash.
 *
 * A shade may discard its own dash, and any dash no live session is holding. A
 * dash bound to *another* live session is that session's to discard, and this
 * one renders no control for it at all.
 *
 * `bound_sessions` already means exactly "live sessions mated to this dash" —
 * the server computes it that way and a test pins that a closed session's row
 * is never reported — so this introduces no second definition of bound-ness.
 * An older sender that omits the field entirely reads as unbound, which is the
 * safe direction: the popover still names the stake, and the server still
 * refuses the one destructive case it can see.
 *
 * Absent, not disabled, when the answer is false: nothing the reader does
 * *here* will ever make it available, and a disabled control invites waiting
 * for something that is not coming.
 */
export function canDiscardFromHere(
  entry: DashChangesetEntry,
  ownTugSessionId: string | undefined,
  boundDashId: string | null,
): boolean {
  if (entry.owner_id === boundDashId) return true;
  const bound = entry.bound_sessions ?? [];
  if (bound.length === 0) return true;
  // Not redundant with the first arm: a card can be mated to dash A while dash
  // B also lists this session. The predicate answers by fact, not by fronting.
  return ownTugSessionId !== undefined && bound.includes(ownTugSessionId);
}

/**
 * The discard confirm's message: a fact sheet, never "are you sure".
 *
 * Every clause names something the reader cannot see by looking at the row.
 * The hand-back sentence is the one that must never be dropped — `dash discard`
 * deliberately writes the worktree's uncommitted files back into the base
 * checkout rather than destroying them, and a person who has not been told that
 * has not agreed to it. The plan sentence is the same kind of fact:
 * `restore_plan_to_base` runs before teardown, unconditionally, so discarding a
 * dash never destroys the authored plan document.
 *
 * The round subjects are deliberately absent: the row already lists them in
 * `session-changes-dash-subjects` when expanded, and `TugConfirmPopover`'s
 * message is one flat string that would size itself off the longest subject.
 *
 * Pure, so the sentence is testable without mounting the lane.
 */
export function discardConfirmMessage(entry: DashChangesetEntry): string {
  const clauses = [
    `Discard ${entry.display_name}: deletes the branch and worktree.`,
  ];
  if (entry.rounds > 0 || entry.files.length > 0) {
    clauses.push(`${discardPreflightLine(entry.rounds, entry.files.length)}.`);
  }
  if (entry.worktree_dirty) {
    clauses.push(
      `Uncommitted files in the worktree are handed back to ${entry.base}.`,
    );
  }
  if (entry.plan_path !== undefined) {
    clauses.push(`The plan is restored to ${entry.base}.`);
  }
  return clauses.join(" ");
}

// ---------------------------------------------------------------------------
// The row
// ---------------------------------------------------------------------------

function DashRow({
  entry,
  projectRoot,
  fronted,
  bound,
  expanded,
  onToggle,
  landing,
  binding,
  discard,
  onRequestDiscard,
}: {
  entry: DashChangesetEntry;
  projectRoot: string;
  fronted: boolean;
  /** This card is mated to this dash — which is what Unbind-vs-Bind reads,
   *  and is not the same question as which row is fronted. */
  bound: boolean;
  expanded: boolean;
  onToggle: (next: boolean) => void;
  landing: DashLaneLanding | null;
  binding: DashLaneBinding | null;
  /** Discard, for every row the reach rule allows; omitted leaves the lane
   *  read-only. */
  discard: DashLaneDiscard | null;
  /** Arm the lane's discard confirm against this row's element. The row is the
   *  anchor, never the button: a button inside a hover-revealed cluster can
   *  unmount under its own popover, which is the shape `TugConfirmPopover`'s
   *  docblock warns about. */
  onRequestDiscard: (entry: DashChangesetEntry, anchor: HTMLElement | null) => void;
}): React.ReactElement {
  const rowRef = useRef<HTMLDivElement | null>(null);
  // Previewing costs a `merge-tree` run, so it is spent on the expand gesture
  // rather than on every lane render: the effect fires on the closed → open
  // edge (and on mount, since the fronted row opens with the shade). Reopening
  // a row is a deliberate re-ask, and answers for the repository as it is now.
  const preview = landing?.actions.preview ?? null;
  const wasExpandedRef = useRef(false);
  useEffect(() => {
    const wasExpanded = wasExpandedRef.current;
    wasExpandedRef.current = expanded;
    if (preview === null || !expanded || wasExpanded) return;
    preview(entry);
  }, [preview, expanded, entry]);

  const descriptor: DiffDescriptor = {
    kind: "range",
    root: projectRoot,
    worktree: entry.worktree,
    base: entry.base,
    branch: dashBranchRef(entry),
  };
  // A dash with nothing past its base and a clean worktree has no range to
  // show; offering the pop-out would open an empty card.
  const hasRange = entry.rounds > 0 || entry.worktree_dirty;
  // Absent, not disabled, when this shade has no business discarding this dash.
  const canDiscard = discard !== null && discard.canDiscard(entry);
  const subjects = entry.round_subjects ?? [];
  const steps =
    entry.step_current !== undefined && entry.step_total !== undefined
      ? `step ${entry.step_current}/${entry.step_total}`
      : null;

  return (
    <div
      ref={rowRef}
      className="session-changes-dash-row"
      data-slot="session-changes-dash-row"
      data-dash={entry.display_name}
      data-fronted={fronted ? "true" : undefined}
      data-expanded={expanded ? "true" : undefined}
    >
      <TugListRow
        variant="flush"
        density="compact"
        leading={
          <TugBadge emphasis="tinted" role="data" size="2xs">
            {entry.display_name}
          </TugBadge>
        }
        trailing={
          <span className="session-changes-dash-row-trailing">
            {binding !== null ? (
              <TugPushButton
                size="2xs"
                subtype="text"
                disabled={binding.disabledReason !== null}
                data-slot={
                  bound
                    ? "session-changes-dash-unbind"
                    : "session-changes-dash-bind"
                }
                onClick={() =>
                  bound ? binding.unbind(entry) : binding.bind(entry)
                }
              >
                {bound ? "Unbind" : "Bind"}
              </TugPushButton>
            ) : null}
            {/* Discard, on the rows the landing face never reaches. The fronted
                row's own Discard lives in that face, beside Join, where the
                acts that end a dash belong together.

                Wrapped in a tooltip rather than carrying a `title`: a disabled
                button takes no pointer events, so its own tooltip would never
                fire, and the reason has to be reachable or it is not a reason
                ([L06]). The fronted row says the same thing in its refusals
                list, which is face text for the same purpose. */}
            {!fronted && canDiscard ? (
              <TugTooltip
                content={discard.disabledReason ?? "Discard this dash"}
              >
                <span className="session-changes-dash-row-discard">
                  <TugPushButton
                    size="2xs"
                    subtype="text"
                    role="danger"
                    disabled={discard.disabledReason !== null}
                    data-slot="session-changes-dash-discard"
                    onClick={() => onRequestDiscard(entry, rowRef.current)}
                  >
                    Discard
                  </TugPushButton>
                </span>
              </TugTooltip>
            ) : null}
            {hasRange ? (
              <PopOutDiffButton
                descriptor={descriptor}
                label={`Open the ${entry.display_name} dash diff in a card`}
              />
            ) : null}
            <BlockFoldCue
              collapsed={!expanded}
              onToggle={(nextCollapsed) => onToggle(!nextCollapsed)}
              collapsedLabel="Expand dash"
              ariaLabelExpand={`Show details for dash ${entry.display_name}`}
              ariaLabelCollapse={`Hide details for dash ${entry.display_name}`}
              size="2xs"
              subtype="icon"
              stabilizeScroll={false}
              data-slot="session-changes-dash-fold"
            />
          </span>
        }
      >
        <span className="session-changes-dash-facts">
          <span className="session-changes-dash-base">{entry.base}</span>
          <span className="session-changes-dash-sep">·</span>
          <span className="session-changes-dash-rounds">
            {roundsLabel(entry.rounds)}
          </span>
          {entry.worktree_dirty ? (
            <>
              <span className="session-changes-dash-sep">·</span>
              <span className="session-changes-dash-dirty">dirty</span>
            </>
          ) : null}
          {entry.stage !== undefined ? (
            <>
              <span className="session-changes-dash-sep">·</span>
              <span className="session-changes-dash-stage">{entry.stage}</span>
            </>
          ) : null}
          {steps !== null ? (
            <>
              <span className="session-changes-dash-sep">·</span>
              <span className="session-changes-dash-step">{steps}</span>
            </>
          ) : null}
          {entry.step_title !== undefined ? (
            <span className="session-changes-dash-step-title">
              {entry.step_title}
            </span>
          ) : null}
          {dashReviewPaints(entry.review) ? (
            <>
              <span className="session-changes-dash-sep">·</span>
              <TugTooltip
                content={dashReviewTooltip(
                  entry.review!,
                  entry.plan_path ?? null,
                )}
              >
                <span
                  className="session-changes-dash-review"
                  data-slot="session-changes-dash-review"
                  data-review={entry.review}
                >
                  {entry.review === "stale" ? "plan stale" : "plan unreviewed"}
                </span>
              </TugTooltip>
            </>
          ) : null}
          <DashDivergenceMarks entry={entry} />
        </span>
      </TugListRow>
      {expanded ? (
        <div className="session-changes-dash-detail">
          {landing !== null ? (
            <SessionChangesDashLanding
              entry={entry}
              outcome={landing.outcome}
              joinPhase={landing.join.phase}
              conflicts={landing.join.conflicts}
              archaeology={landing.join.archaeology}
              blockers={landing.join.blockers}
              error={landing.join.error}
              candidateCommit={landing.candidateCommit}
              turnInProgress={landing.turnInProgress}
              resolve={landing.resolve}
              bindingRefusal={
                binding === null || binding.disabledReason === null
                  ? null
                  : { control: bound ? "Unbind" : "Bind", reason: binding.disabledReason }
              }
              discardAvailable={canDiscard}
              discardDisabledReason={discard?.disabledReason ?? null}
              onRequestDiscard={() => onRequestDiscard(entry, rowRef.current)}
              actions={landing.actions}
            />
          ) : null}
          {subjects.length > 0 ? (
            <ul
              className="session-changes-dash-subjects"
              data-slot="session-changes-dash-subjects"
            >
              {subjects.map((subject, index) => (
                <li key={`${index}:${subject}`}>{subject}</li>
              ))}
            </ul>
          ) : null}
          {entry.files.length > 0 ? (
            <ul
              className="session-changes-dash-files"
              data-slot="session-changes-dash-files"
            >
              {entry.files.map((file) => (
                <li key={file.path}>
                  <TugStatusMark status={file.git_status} />
                  <span className="session-changes-dash-file-path">{file.path}</span>
                </li>
              ))}
            </ul>
          ) : null}
          {entry.draft !== undefined ? (
            <div
              className="session-changes-dash-draft"
              data-slot="session-changes-dash-draft"
            >
              <div className="session-changes-dash-draft-label">Join draft</div>
              <div className="session-changes-dash-draft-message">
                {entry.draft.message}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The lane
// ---------------------------------------------------------------------------

export interface SessionChangesDashLaneProps {
  /** The project's dash entries, in snapshot order. */
  dashes: readonly DashChangesetEntry[];
  /** The owner key of the dash this card's session is mated to, if any. It
   *  decides which row offers **Unbind** rather than **Bind**. */
  boundDashId: string | null;
  /** The owner key of the row to front, when that is not the bound one — a
   *  landing aimed by name (`/dash-join <name>`) fronts its target so the
   *  landing face has somewhere to mount. Defaults to `boundDashId`.
   *
   *  The two are deliberately separate: fronting is about *what is being
   *  landed*, the binding is about *what this card is working*, and a join
   *  aimed at a dash the card never bound must not offer to Unbind it. */
  frontedDashId?: string | null;
  /** Absolute checkout root — the range descriptor's `root`. */
  projectRoot: string;
  /** The fronted row's landing face; omitted leaves the lane read-only. */
  landing?: DashLaneLanding;
  /** Bind / Unbind, for every row; omitted leaves the lane read-only. */
  binding?: DashLaneBinding;
  /** Discard, for every row the reach rule allows; omitted leaves the lane
   *  read-only. */
  discard?: DashLaneDiscard;
}

export function SessionChangesDashLane({
  dashes,
  boundDashId,
  frontedDashId,
  projectRoot,
  landing,
  binding,
  discard,
}: SessionChangesDashLaneProps): React.ReactElement | null {
  // Per-dash expansion overrides. The default is "expanded exactly when this
  // is the card's own dash", so a bind that arrives while the shade is open
  // fronts and opens the new dash without the reader touching anything.
  const [overrides, setOverrides] = useState<Readonly<Record<string, boolean>>>({});
  // Which row's discard is armed, and the element the confirm hangs off.
  // View-scope state ([L24]): a half-armed confirm is not something to
  // remember, so nothing here is persisted and dismissing the shade forgets it.
  //
  // One popover instance serves every row — the documented in-list confirmation
  // shape — which is what makes widening Discard past the fronted row cost no
  // per-row state.
  const [pendingDiscard, setPendingDiscard] = useState<{
    entry: DashChangesetEntry;
    anchor: HTMLElement | null;
  } | null>(null);
  const requestDiscard = (
    entry: DashChangesetEntry,
    anchor: HTMLElement | null,
  ): void => {
    setPendingDiscard({ entry, anchor });
  };

  if (dashes.length === 0) return null;

  const { fronted, rest } = orderDashLane(
    dashes,
    frontedDashId ?? boundDashId,
  );
  const isExpanded = (entry: DashChangesetEntry): boolean =>
    overrides[entry.owner_id] ?? entry === fronted;
  const toggle = (entry: DashChangesetEntry, next: boolean): void => {
    setOverrides((prev) => ({ ...prev, [entry.owner_id]: next }));
  };
  const restLabel =
    fronted !== null
      ? `Also on this project: ${rest.length} ${rest.length === 1 ? "dash" : "dashes"}`
      : `Dashes: ${rest.length}`;

  return (
    <div className="session-changes-dash-lane" data-slot="session-changes-dash-lane">
      {fronted !== null ? (
        <>
          <div
            className="session-changes-dash-lane-label"
            data-slot="session-changes-dash-lane-fronted-label"
          >
            This card&rsquo;s dash
          </div>
          <DashRow
            // Keyed so a rebind swaps the row rather than reusing it: the
            // landing face's preview fires on mount, and a reused instance
            // would show the new dash under the old dash's verdict.
            key={fronted.owner_id}
            entry={fronted}
            projectRoot={projectRoot}
            fronted
            bound={fronted.owner_id === boundDashId}
            expanded={isExpanded(fronted)}
            onToggle={(next) => toggle(fronted, next)}
            landing={landing ?? null}
            binding={binding ?? null}
            discard={discard ?? null}
            onRequestDiscard={requestDiscard}
          />
        </>
      ) : null}
      {rest.length > 0 ? (
        <>
          <div
            className="session-changes-dash-lane-label"
            data-slot="session-changes-dash-lane-rest-label"
          >
            <span>{restLabel}</span>
          </div>
          {rest.map((entry) => (
            <DashRow
              key={entry.owner_id}
              entry={entry}
              projectRoot={projectRoot}
              fronted={false}
              bound={entry.owner_id === boundDashId}
              expanded={isExpanded(entry)}
              onToggle={(next) => toggle(entry, next)}
              landing={null}
              // Unlike `landing`, this reaches every row — Bind's whole
              // population is exactly the rows the landing face skips.
              binding={binding ?? null}
              discard={discard ?? null}
              onRequestDiscard={requestDiscard}
            />
          ))}
        </>
      ) : null}
      {/* One controlled confirm for the whole lane, anchored to whichever row
          armed it. `confirmRole="danger"` puts default focus on Cancel, so a
          reflexive Return can never destroy a dash. */}
      <TugConfirmPopover
        open={pendingDiscard !== null}
        anchorEl={pendingDiscard?.anchor ?? null}
        message={
          pendingDiscard !== null ? discardConfirmMessage(pendingDiscard.entry) : ""
        }
        confirmLabel="Discard"
        confirmRole="danger"
        side="top"
        onConfirm={() => {
          const armed = pendingDiscard;
          setPendingDiscard(null);
          if (armed !== null) discard?.discard(armed.entry);
        }}
        onCancel={() => setPendingDiscard(null)}
      />
    </div>
  );
}
