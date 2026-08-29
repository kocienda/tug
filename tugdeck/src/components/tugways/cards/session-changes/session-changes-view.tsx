/**
 * `SessionChangesView` — the read-only changes glance ([P02]). Rides the
 * bottom-anchored passive TugSheet `shade` over the live transcript and shows
 * the card's changed files: the session's attributed files plus the project's
 * unattributed files, per-file inline diffs, and the non-repo git-init
 * affordance. It answers "what's changed?" — glanceable, dismiss-and-forget.
 *
 * The sheet is passive ([P17]): the composer below keeps focus (⌃⌘C is the
 * toggle; landing a commit lives in the composer's commit mode) and the view
 * seeds no key view. The file rows are `TugChangesList` ([P01]); the header's
 * trailing cluster is the fold-all cue, the whole-diff pop-out, and the
 * dismiss X — three same-sized icon buttons, the card-header idiom. The
 * git-init affordance sits in the body.
 *
 * The list IS this session's diff — every row expands into its own hunks — so
 * the view mounts no second whole-session document above it. The repo-wide
 * view is a different surface entirely: the Project Diff card (`/diff`).
 *
 * Below the file rows sits the `SessionChangesDashLane` — the project's dashes
 * in their own grammar, with their own fold. The header's fold-all cue and
 * combined pop-out keep acting on the head entries only; the lane owns its
 * own folding, because a dash is a different species from a claimed file.
 *
 * Laws: [L02] the controller + git-init verb store enter React through
 * `useSyncExternalStore`; [L06] no appearance state in React (status tones and
 * hover affordances paint via CSS); [L26] per-file diff bodies collapse by
 * unmount inside `TugChangesList`'s rows.
 *
 * @module components/tugways/cards/session-changes/session-changes-view
 */

import "./session-changes-view.css";

import React, { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import { GitCommitHorizontal, LoaderCircle, X } from "lucide-react";

import { TugNonRepoNotice } from "@/components/tugways/tug-non-repo-notice";
import {
  ORPHANED_LABEL,
  SESSION_LABEL,
  UNATTRIBUTED_DEGRADED_LABEL,
  UNATTRIBUTED_LABEL,
} from "./changes-section-labels";
import { TugPushButton } from "@/components/tugways/tug-push-button";
import { TugTooltip } from "@/components/tugways/tug-tooltip";
import { BlockStrip } from "@/components/tugways/blocks/block-strip";
import { BlockFoldCue } from "@/components/tugways/body-kinds/affordances/block-fold-cue";
import {
  TugChangesList,
  PopOutDiffButton,
  diffablePathsOf,
  fileExpandKey,
  type TugChangesListEntry,
} from "@/components/tugways/tug-changes-list";
import {
  SessionChangesDashLane,
  canDiscardFromHere,
  type DashLaneBinding,
  type DashLaneJoinFace,
  type DashLaneDiscard,
  type DashLaneReplay,
} from "./session-changes-dash-lane";
import type { DashJoinActions } from "./session-changes-dash-join";
import type { JoinOutcome } from "@/lib/join-mode-controller";
import {
  useChangesetJoinResolve,
  useChangesetLandingDashes,
} from "@/lib/changeset-join-store";
import type { DiffDescriptor } from "@/lib/git-diff-store";
import { cardSessionBindingStore } from "@/lib/card-session-binding-store";
import { getConnection } from "@/lib/connection-singleton";
import {
  useChangesetClaim,
  useChangesetDisclaim,
  useChangesetJoin,
  useChangesetDiscard,
  useChangesetReplay,
} from "@/lib/changeset-verb-store";
import type { ChangesRouteController } from "@/lib/changes-route-controller";
import type { CodeSessionStore } from "@/lib/code-session-store";

// ---------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------

export interface SessionChangesViewProps {
  /** The host card's id — the key into the session-binding store, read for
   *  the card's own dash so the lane can front it. */
  cardId: string;
  /** Repo-relative project directory the card is bound to. */
  projectDir: string | null;
  /** The per-card Changes controller — the changeset snapshot ([P07]). */
  changesController: ChangesRouteController;
  /**
   * The card's Claude session store — read for the turn-in-progress signal
   * that gates the git-init verb while a turn runs. Viewing changes mid-turn
   * is free; only the durable git-init waits.
   */
  codeSessionStore: CodeSessionStore;
  /**
   * The half of the fronted row's join face only the card knows — which
   * dash the join is about, and the gestures. What a join would do comes
   * off the dash's own feed entry. Absent leaves the lane read-only, which is
   * what an unbound card shows.
   */
  dashJoin?: DashJoinSource;
  /**
   * The shade's own dismissal, at the trailing edge of the header. Absent
   * leaves the header without one, which is what a host that has no way to
   * close the shade renders.
   */
  dismiss?: SessionChangesDismiss;
}

/** The header X — what it does, and what it is called while it does it. */
export interface SessionChangesDismiss {
  /**
   * What the gesture is called here — "Cancel commit", "Cancel join",
   * "Cancel auto-message", or "Close Changes". Composed by the host, which is
   * the only thing that knows which landing (if any) the shade is carrying.
   */
  label: string;
  /** Abort the draft, leave the landing, or close a bare glance. */
  onDismiss: () => void;
}

/** What the card hands the view for the fronted dash row's join face. */
export interface DashJoinSource {
  /** Owner key of the dash the join is about, or null when none is aimed.
   *  It outranks the card's binding for fronting: `/dash-join <name>` aims
   *  without binding, and the face has to appear on the dash being landed. */
  dashId: string | null;
  actions: DashJoinActions;
}

export function SessionChangesView({
  cardId,
  projectDir,
  changesController,
  codeSessionStore,
  dashJoin,
  dismiss,
}: SessionChangesViewProps): React.ReactElement {
  const snap = useSyncExternalStore(
    changesController.subscribe,
    changesController.getSnapshot,
  );
  const project = snap.project;
  // The card's own dash, by owner key ([L02]). A string snapshot is
  // reference-stable by construction, so the store's every-binding-changed
  // notification only re-renders when this card's dash actually moved.
  const boundDashId = useSyncExternalStore(
    cardSessionBindingStore.subscribe,
    () => cardSessionBindingStore.getBinding(cardId)?.dash?.id ?? null,
  );
  // `canInterrupt` is true exactly while a turn can be stopped (one is
  // running), so it is the turn-in-progress signal ([L02]).
  const turnInProgress = useSyncExternalStore(
    codeSessionStore.subscribe,
    () => codeSessionStore.getSnapshot().canInterrupt === true,
  );

  // The claim round trip's state ([L02]). The failure detail is surfaced by
  // the card's `ClaimErrorNoticeController` (a bulletin, not view chrome); the
  // view reads it only to hold the Claim affordances while one is in flight.
  const claim = useChangesetClaim(changesController.entryKey);
  const claimPending = claim.phase === "pending";
  // Claim's inverse, read the same way and for the same reason.
  const disclaim = useChangesetDisclaim(changesController.entryKey);
  const disclaimPending = disclaim.phase === "pending";
  // The card's one join round trip ([L02]). It is keyed by the card's entry,
  // not by dash, which is exactly why the join face belongs to the fronted
  // row alone — two rows previewing would share this slot.
  const join = useChangesetJoin(changesController.entryKey);
  // The card's one discard round trip ([L02]), keyed by the card's entry like
  // the join above. That is why every row's Discard is held while one is in
  // flight: two rows sharing this slot would render each other's phase.
  const discardVerb = useChangesetDiscard(changesController.entryKey);
  const replayVerb = useChangesetReplay(changesController.entryKey);
  // The resolution ladder's overlay, keyed by dash rather than by card. The
  // fronted dash is resolved from the same snapshot the lane orders by; an
  // unbound card watches the empty key, which is idle by construction.
  // A join in flight decides the fronted row; the card's binding decides it
  // the rest of the time. `/dash-join <name>` aims at a dash without binding to
  // it, and the join face — outcome, blockers, the resolve ladder — is the
  // fronted row's alone, so fronting by the binding would leave a named join
  // live in the composer with nothing in the room to explain a refusal.
  const frontedDashId = dashJoin?.dashId ?? boundDashId;
  // A card can be bound to a dash before its branch exists — the planning
  // phase. It has no changeset entry, so the lane fronts its document row
  // instead of falling silent about the dash the card is working.
  const documentDash =
    boundDashId === null ||
    snap.dashes.some((entry) => entry.owner_id === boundDashId)
      ? null
      : (snap.documentDashes.find((row) => row.owner_id === boundDashId) ?? null);
  const frontedDash =
    frontedDashId !== null
      ? (snap.dashes.find((entry) => entry.owner_id === frontedDashId) ?? null)
      : null;
  // Keyed by the workspace's canonical spelling ([L29]) — the same key the
  // card's resolve and review sends use, so the overlay a press starts is the
  // overlay this row reads.
  const resolveState = useChangesetJoinResolve(
    project.workspace_key,
    frontedDash?.display_name ?? "",
  );

  // A dash whose join is RUNNING is no longer offered here ([P05]).
  //
  // The press spends every act this room held for that dash: there is nothing
  // left to resolve, review, discard, or press again. Left on offer it invited
  // exactly one gesture — a second press — and the only answer that gesture
  // can get is `Joining…` as a refusal, which is how a join in progress came
  // to read as a join that had failed. Where the join is *narrated* is the
  // transcript's live edge, in front of the reader, not behind a panel.
  //
  // A failed join brings its dash straight back: the beat turns terminal and
  // the row returns with its blockers, because a failure is the one outcome
  // that still wants somebody. A landed one never returns — the server drops
  // it from the feed.
  const landingDashes = useChangesetLandingDashes(project.workspace_key);
  const offeredDashes = useMemo(
    () =>
      landingDashes.size === 0
        ? snap.dashes
        : snap.dashes.filter((entry) => !landingDashes.has(entry.display_name)),
    [snap.dashes, landingDashes],
  );

  const sessionFiles = snap.entry?.files ?? [];

  // Per-file collapse state is owned HERE (view scope), keyed by
  // `${entryId}|${path}`, so the Expand All / Collapse All / Diff controls
  // live once in the shade banner and act across every head entry.
  const [expandedKeys, setExpandedKeys] = useState<ReadonlySet<string>>(new Set());
  const onToggleFile = useCallback(
    (entryId: string, path: string, collapsed: boolean) => {
      setExpandedKeys((prev) => {
        const next = new Set(prev);
        const key = fileExpandKey(entryId, path);
        if (collapsed) next.delete(key);
        else next.add(key);
        return next;
      });
    },
    [],
  );

  // The shade header is the section band chrome ([P02]) — a `BlockStrip` at
  // `altitude="section"`, grip-less: the Changes glyph + title on the left,
  // the fold-all cue + Diff pop-out + dismiss X on the right. The X trails the
  // cluster and closes the shade, which is where every other close in the deck
  // sits; ⌃⌘C still toggles.
  const dismissButton =
    dismiss !== undefined ? (
      <TugTooltip content={dismiss.label}>
        <TugPushButton
          className="session-changes-dismiss"
          subtype="icon"
          icon={<X size={14} strokeWidth={2.5} />}
          size="xs"
          emphasis="ghost"
          role="action"
          aria-label={dismiss.label}
          data-testid="session-changes-dismiss"
          onClick={(event) => {
            event?.stopPropagation();
            dismiss.onDismiss();
          }}
        />
      </TugTooltip>
    ) : null;
  const buildHeader = (actions?: React.ReactNode): React.ReactElement => (
    <BlockStrip
      altitude="section"
      className="tool-call-header"
      dataTestid="session-changes-header"
      leading={
        <span className="tool-call-header-leading" aria-hidden="true">
          <GitCommitHorizontal size={14} />
        </span>
      }
      name="Changes"
      // The X rides every case of the shade — empty, non-repo, scanning — so
      // it is composed here rather than in the per-case `actions`.
      actions={
        actions !== undefined || dismissButton !== null ? (
          <>
            {actions}
            {dismissButton}
          </>
        ) : undefined
      }
    />
  );

  // The view fills the sheet's shade body ([P17]): the header strip pinned
  // above, the scrolling view below. The passive shade seeds no key view and
  // carries no action row — landing a commit lives in the composer's Z5. The
  // shade panel (geometry, scrim, grabber, modality) is
  // `TugSheetContent presentation="shade"` — mounted by the Session card.
  const shell = (
    children: React.ReactNode,
    actions?: React.ReactNode,
  ): React.ReactElement => (
    <>
      <div className="tug-sheet-shade-header">{buildHeader(actions)}</div>
      <div
        className="session-changes-view"
        data-slot="session-changes-view"
        data-tug-focus="refuse"
      >
        {children}
      </div>
    </>
  );

  if (project.no_repo) {
    return shell(
      <TugNonRepoNotice
        projectDir={projectDir ?? project.project_dir}
        turnInProgress={turnInProgress}
      />,
    );
  }

  const sessionItem: TugChangesListEntry | null =
    snap.entry !== null
      ? { kind: "session", id: changesController.entryKey, project, entry: snap.entry }
      : null;
  const unattributedItem: TugChangesListEntry | null =
    snap.unattributed.length > 0
      ? {
          kind: "unattributed",
          id: `unattributed:${project.project_dir}`,
          project,
          files: snap.unattributed,
        }
      : null;
  const orphanedItem: TugChangesListEntry | null =
    snap.orphaned.length > 0
      ? {
          kind: "orphaned",
          id: `orphaned:${project.project_dir}`,
          project,
          files: snap.orphaned,
        }
      : null;
  const hasSessionFiles = sessionFiles.length > 0;
  // Dashes count against emptiness: a project whose only news is a dash is
  // not an all-clear, and "None" over a rendered dash lane would contradict
  // the rows below it.
  const isEmpty =
    !hasSessionFiles &&
    unattributedItem === null &&
    orphanedItem === null &&
    snap.dashes.length === 0;
  // An empty view is only a verified all-clear once the aggregate has actually
  // composed this workspace ([P02]). Before the first emit `project` is the
  // pre-scan placeholder, so an empty-and-uncomposed view says "scanning"
  // rather than a false "No changes" green.
  const isCleanAllClear = isEmpty && snap.composed;
  const isAwaitingScan = isEmpty && !snap.composed;

  // The head entries (session + unattributed) the banner controls act on.
  // Every diffable file across them yields one expand key; the whole-view Diff
  // pop-out is a `head` diff over their union of paths.
  const headEntries: TugChangesListEntry[] = [
    ...(sessionItem !== null && hasSessionFiles ? [sessionItem] : []),
    ...(unattributedItem !== null ? [unattributedItem] : []),
    ...(orphanedItem !== null ? [orphanedItem] : []),
  ];
  const combinedKeys: string[] = headEntries.flatMap((entry) =>
    diffablePathsOf(entry).map((path) => fileExpandKey(entry.id, path)),
  );
  const combinedDiffPaths: string[] = headEntries.flatMap((entry) =>
    diffablePathsOf(entry),
  );
  const combinedDescriptor: DiffDescriptor | null =
    combinedDiffPaths.length > 0
      ? { kind: "head", root: project.project_dir, paths: combinedDiffPaths }
      : null;

  // Fold-all cue: the standard section chevron, but it expands / collapses
  // ALL files rather than accordioning the header. `allExpanded` derives the
  // chevron direction; the toggle sets the whole key set at once.
  const allExpanded =
    combinedKeys.length > 0 && combinedKeys.every((k) => expandedKeys.has(k));
  const headerActions =
    combinedKeys.length > 1 || combinedDescriptor !== null ? (
      <>
        {combinedKeys.length > 1 ? (
          <BlockFoldCue
            collapsed={!allExpanded}
            onToggle={(nextCollapsed) =>
              setExpandedKeys(nextCollapsed ? new Set() : new Set(combinedKeys))
            }
            collapsedLabel="Expand all"
            expandedLabel="Collapse all"
            ariaLabelExpand="Expand all files"
            ariaLabelCollapse="Collapse all files"
            size="xs"
            subtype="icon"
            stabilizeScroll={false}
            data-slot="session-changes-fold-all"
          />
        ) : null}
        {combinedDescriptor !== null ? (
          <PopOutDiffButton
            descriptor={combinedDescriptor}
            label="Open the whole diff in a card"
            size="xs"
          />
        ) : null}
      </>
    ) : undefined;

  // Bind and Unbind ([P05]). Both are CONTROL frames on the existing
  // connection, and **neither touches `cardSessionBindingStore`** — the
  // `bind_dash_ok` / `unbind_dash_ok` broadcasts are the only movers, which is
  // what leaves a card correctly bound to what it was when a bind is refused.
  //
  // The gate is *a join in flight*, and deliberately not the Join
  // affordance's `evaluateJoinGate`: that one refuses on outcome and on
  // blockers, and a dash that is off-base or conflicted is precisely one
  // somebody should be able to take on. The only thing worth blocking is a
  // binding change that would move the lane's fronting out from under an open
  // join.
  const tugSessionId = cardSessionBindingStore.getBinding(cardId)?.tugSessionId;
  const laneBinding: DashLaneBinding | undefined =
    tugSessionId === undefined || project === null
      ? undefined
      : {
          bind: (entry) => {
            getConnection()?.sendControlFrame("bind_dash", {
              tug_session_id: tugSessionId,
              project_dir: project.workspace_key,
              dash: entry.display_name,
            });
          },
          unbind: () => {
            getConnection()?.sendControlFrame("unbind_dash", {
              tug_session_id: tugSessionId,
            });
          },
          // Binding or unbinding changes only which dash this card is bound
          // to — no branch moves, nothing is checked out — so a turn in
          // flight is no reason to refuse it. A join already in flight
          // is: rebinding under it would strand the join.
          disabledReason: join.phase === "pending" ? "A join is in flight" : null,
        };

  // Discard, for every row the reach rule allows ([P06]/[P12]). The reach is a
  // pure function of data already in this snapshot — no store, no subscription,
  // no new wire field — and the two gates are folded into one sentence so the
  // fronted row's Discard and an unbound row's can never disagree.
  //
  // `discard_in` is deliberately left unguarded: `tugutil dash discard` is a
  // power tool the app-test preamble's stranded-fixture sweep depends on, and
  // the one genuinely irreversible case — base dirt overlapping the dash's own
  // files — is already refused server-side before anything moves.
  const laneDiscard: DashLaneDiscard | undefined =
    project === null
      ? undefined
      : {
          canDiscard: (entry) =>
            canDiscardFromHere(entry, changesController.tugSessionId, boundDashId),
          discard: (entry) =>
            discardVerb.discard(
              project.workspace_key,
              entry.display_name,
              changesController.tugSessionId,
            ),
          disabledReason:
            discardVerb.phase === "pending"
              ? "A discard is in flight"
              : turnInProgress
                ? "Wait for the turn to finish"
                : null,
        };

  // Replay, on every row on identical terms. The per-dash terms are the row's
  // own facts ({@link replayDisabledReason}); what the lane folds in is only
  // the in-flight gate, since `ReplayState` is one slot per card and a second
  // press would render the first one's phase.
  const laneReplay: DashLaneReplay | undefined =
    project === null
      ? undefined
      : {
          replay: (entry) =>
            replayVerb.replay(
              project.workspace_key,
              entry.display_name,
              changesController.tugSessionId,
            ),
          disabledReason:
            replayVerb.phase === "pending" ? "A replay is in flight" : null,
        };

  const laneJoinFace: DashLaneJoinFace | undefined =
    dashJoin !== undefined
      ? {
          join,
          resolve: resolveState,
          actions: dashJoin.actions,
        }
      : undefined;

  return shell(
    <div className="session-changes-view-body">
      {isCleanAllClear ? (
        <div className="session-changes-clean" role="status">
          None
        </div>
      ) : null}
      {isAwaitingScan ? (
        <div
          className="session-changes-scanning"
          role="status"
          data-testid="session-changes-scanning"
        >
          <LoaderCircle size={14} className="session-changes-scanning-spin" />
          Waiting for project scan…
        </div>
      ) : null}
      {snap.ledgerDegraded ? (
        <div
          className="session-changes-scanning"
          role="alert"
          data-testid="session-changes-ledger-degraded"
        >
          Attribution ledger damaged — claims are unavailable, not empty.
          Restart Tug to rebuild it.
        </div>
      ) : null}
      {headEntries.length > 0 ? (
        <TugChangesList
          entries={headEntries}
          ownSessionId={changesController.tugSessionId}
          expandedKeys={expandedKeys}
          onToggleFile={onToggleFile}
          unattributedLabel={
            snap.ledgerDegraded ? UNATTRIBUTED_DEGRADED_LABEL : UNATTRIBUTED_LABEL
          }
          onClaimUnattributed={(path) => changesController.claim([path])}
          onClaimAllUnattributed={(paths) => changesController.claim(paths)}
          orphanedLabel={ORPHANED_LABEL}
          onClaimOrphaned={(path) => changesController.claim([path])}
          onClaimAllOrphaned={(paths) => changesController.claim(paths)}
          claimPending={claimPending}
          sessionLabel={SESSION_LABEL}
          onReleaseShared={(path) => changesController.claim([path])}
          onDisclaimFile={(path) => changesController.disclaim([path])}
          onDisclaimAllFiles={(paths) => changesController.disclaim(paths)}
          disclaimPending={disclaimPending}
          hunkElection={changesController.hunkElection()}
          onElectHunks={(path, ids) => changesController.electHunks(path, ids)}
        />
      ) : null}
      <SessionChangesDashLane
        dashes={offeredDashes}
        boundDashId={boundDashId}
        frontedDashId={frontedDashId}
        projectRoot={project.project_dir}
        workspaceKey={changesController.workspaceKey}
        joinFace={laneJoinFace}
        binding={laneBinding}
        discard={laneDiscard}
        replay={laneReplay}
        documentDash={documentDash}
      />
    </div>,
    headerActions,
  );
}
