/**
 * `SessionChangesDashLane` — the Changes shade's dash lane.
 *
 * A dash is not a claim. Rendered in session-file grammar a dash branch reads
 * as one — so it gets its own species of row: one `DashLifecycleBlock` at the
 * READING scale, the same block the Dashes card renders at the
 * rail, so the two surfaces speak one language. Line 1 is who — the dash atom
 * and one worker atom per bound session; line 2 is what the dash is doing —
 * track · fraction · note · divergence. The row keeps its per-row fold, and no
 * claim, disclaim, or hunk-election affordance appears anywhere inside it. The
 * lane's one diff affordance is the whole-range pop-out, because the server's
 * range diff takes no pathspec and the dash is the unit anyway.
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
 * **Every row carries a join face**: the server's standing answer for that
 * dash, plus the acts that clear it. Every dash's join state rides its own feed
 * entry and the resolve store is keyed by dash, so a row's face is that row's
 * own facts throughout — none of it is borrowed from the fronted dash.
 *
 * It was the fronted row's alone, on the reasoning that joining is a gesture on
 * the card's own dash. But the register speaks on every row: a blocked dash
 * anywhere in the lane prints `blockers[0].detail` and the word `blocked`, and
 * withholding the face left exactly those rows stating a refusal beside nothing
 * that explains or clears it. Resolve is not joining — it commits base-side
 * work so a join can be attempted at all, and the dash it acts on is the one
 * named in the sentence, whatever this card happens to be bound to.
 *
 * Two things stay the fronted row's, because both really are the card's and not
 * the dash's: `aim`, which points the composer's join at a dash the reader
 * merely opened, and the join verb's own `error`, which is one round trip per
 * card and would otherwise print another row's refusal under this one.
 *
 * The two **binding** gestures go the other way. Every row carries one: Unbind
 * on the fronted row, Bind on all the rest, complements that never appear
 * together. This is the room where a dash's facts already live, so the act of
 * taking a dash on belongs beside the facts you would take it on for — and
 * "non-fronted rows stay read-only" was always a rule about *joining*, a
 * gesture on work a card never touched. Binding is how a card comes to touch
 * it.
 *
 * Binding and Discard both live behind the row's `⋯` ({@link useDashRowMenu})
 * rather than standing on it. They are rare — a card binds a dash once and
 * discards one almost never — and standing beside the pop-out and the fold cue
 * they read as peers of acts a reader performs constantly. Every row is
 * otherwise a thing to read.
 *
 * Laws: [L02] the lane takes its data as props from the view's
 * `useSyncExternalStore` reads; [L06] tone and state paint through CSS and
 * data attributes; [L19] the row composes `DashLifecycleBlock` / `TugListRow`
 * / `BlockFoldCue` / `PopOutDiffButton` rather than hand-rolling chrome.
 *
 * @module components/tugways/cards/session-changes/session-changes-dash-lane
 */

import "./session-changes-dash-lane.css";

import React, { useEffect, useRef, useState } from "react";
import { EllipsisVertical } from "lucide-react";

import { TugPushButton } from "@/components/tugways/tug-push-button";
import { TugListRow } from "@/components/tugways/tug-list-row";
import { replayDisabledReason, useDashRowMenu } from "./dash-row-menu";
import { BlockFoldCue } from "@/components/tugways/body-kinds/affordances/block-fold-cue";
import { PopOutDiffButton } from "@/components/tugways/tug-changes-list";
import { TugSectionLabel } from "@/components/tugways/tug-section-label";
import { SessionChangesDashDocuments } from "./session-changes-dash-documents";
import { SessionChangesDashBrief } from "./session-changes-dash-brief";
import { TugConfirmPopover } from "@/components/tugways/tug-confirm-popover";
import { DashLifecycleBlock } from "@/components/tugways/dash-lifecycle-block";
import { dashLifecycleNote } from "@/components/tugways/dash-lifecycle-line";
import { dashTrackModelFromEntry } from "@/components/tugways/tug-dash-track";
import { dashMetaFacts } from "@/lib/dash-meta-facts";
import { DashJoinRegister } from "@/components/tugways/dash-join-register";
import { useChangesetJoinLand, useChangesetJoinResolve } from "@/lib/changeset-join-store";
import { dashFrontedLabel, dashRestLabel } from "./changes-section-labels";
import {
  SessionChangesDashJoin,
  discardPreflightLine,
  type DashJoinActions,
} from "./session-changes-dash-join";
import type { DiffDescriptor } from "@/lib/git-diff-store";
import type {
  DashChangesetEntry,
  DocumentDashEntry,
} from "@/lib/changeset-types";
import {
  documentDashAsEntry,
  documentDashTrackModel,
} from "@/lib/document-dash-entry";
import type { JoinState } from "@/lib/changeset-verb-store";
import type { JoinOutcome } from "@/lib/join-mode-controller";

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

/**
 * A row that opens itself, before anybody touches it.
 *
 * Fronting is the usual reason, and a refusal is the other. A blocked dash
 * prints its first blocker's sentence and the word `blocked` in the register
 * whether the row is open or shut — but the report that says what would clear
 * it, and carries the control that does, is inside the fold. Left shut, the row
 * states a problem and hides the answer one line under it, which is the exact
 * shape of a control nobody can find. Still an override: closing it sticks.
 */
export function dashRowOpensItself(entry: DashChangesetEntry): boolean {
  return (entry.join?.blockers ?? []).length > 0;
}

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


/**
 * The half of a row's join face the card owns, read once by the view and handed
 * to every row. What a join would do comes off each dash's own feed entry, and
 * the resolution ladder's progress is read per row from a store keyed by dash.
 */
export interface DashLaneJoinFace {
  /** The card's one join round trip ([L02], read by the view) — the face
   *  shows its verb-level refusal, when one came back. Card-scoped, so only
   *  the fronted row reads it; see the module docblock. */
  join: JoinState;
  actions: DashJoinActions;
}

/**
 * The lane's two binding gestures ([P05]).
 *
 * This bundle goes to **every** row, and a row picks Bind or Unbind from its
 * own `fronted` flag — the two are complements, so they never appear together
 * and the cluster stays one affordance wide.
 *
 * Neither callback may move `cardSessionBindingStore`. The `bind_dash_ok` /
 * `unbind_dash_ok` broadcasts are the only movers, which is what leaves a card
 * correctly bound to what it was when a bind is refused.
 */
/**
 * The lane's discard gesture, for every row the reach rule allows.
 *
 * Like {@link DashLaneBinding}, this reaches past the fronted row: an unbound
 * dash nobody is holding is exactly the kind a shade should be able to clean
 * up, and the `empty` join outcome's own answer is discard rather than a fix.
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

export interface DashLaneReplay {
  /** Send `changeset_replay` for this row's dash. */
  replay: (entry: DashChangesetEntry) => void;
  /** Why every Replay on this lane is unavailable right now, or null. Folds
   *  only the in-flight gate; the per-dash terms are
   *  {@link replayDisabledReason}'s, computed from the row's own facts. */
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
  if (entry.documents !== undefined) {
    clauses.push(`Its documents stay at .tug/dashes/${entry.display_name}/.`);
  }
  return clauses.join(" ");
}

// ---------------------------------------------------------------------------
// The row
// ---------------------------------------------------------------------------

function DashRow({
  entry,
  projectRoot,
  workspaceKey,
  fronted,
  bound,
  expanded,
  onToggle,
  joinFace,
  binding,
  discard,
  replay,
  onRequestDiscard,
}: {
  entry: DashChangesetEntry;
  projectRoot: string;
  /** The key the join store is written under — never the root ([L29]). */
  workspaceKey: string;
  fronted: boolean;
  /** This card is mated to this dash — which is what Unbind-vs-Bind reads,
   *  and is not the same question as which row is fronted. */
  bound: boolean;
  expanded: boolean;
  onToggle: (next: boolean) => void;
  joinFace: DashLaneJoinFace | null;
  binding: DashLaneBinding | null;
  /** Discard, for every row the reach rule allows; omitted leaves the lane
   *  read-only. */
  discard: DashLaneDiscard | null;
  /** Replay, on the same terms for every row; omitted leaves the lane
   *  read-only. */
  replay: DashLaneReplay | null;
  /** Arm the lane's discard confirm against this row's element. The row is the
   *  anchor, never the button: a button inside a hover-revealed cluster can
   *  unmount under its own popover, which is the shape `TugConfirmPopover`'s
   *  docblock warns about. */
  onRequestDiscard: (entry: DashChangesetEntry, anchor: HTMLElement | null) => void;
}): React.ReactElement {
  const rowRef = useRef<HTMLDivElement | null>(null);
  // The beats of a join in flight on THIS dash ([L02], [P03]). Subscribed per
  // row so one dash landing does not re-render every other row in the lane.
  // Keyed on the WORKSPACE KEY, never the project root. The beat frames echo
  // back the `project_dir` the request sent, and every send on this path sends
  // the workspace key — so a read under the root's spelling is a subscription
  // to a cell nothing ever writes ([L29]). That is not a hypothetical: it is
  // the exact shape of the bug at0441 was written for, one field over.
  const landBeat = useChangesetJoinLand(workspaceKey, entry.display_name);
  // The resolution ladder's progress for THIS dash ([L02]), on the same terms
  // and for the same reason as the beats above: the store is keyed by dash, so
  // a row reading the fronted dash's key would paint another dash's ladder.
  const resolve = useChangesetJoinResolve(workspaceKey, entry.display_name);
  // Opening a row points the join mode at its dash and asks the server nothing:
  // the answer is already on the entry. The effect fires on the closed → open
  // edge (and on mount, since the fronted row opens with the shade), so the
  // composer's ⌃⌘C lands on the dash the reader is looking at.
  // Fronted-only, and deliberately: aiming is what the composer's join acts
  // on, so opening a row the card is not landing must not retarget it.
  const aim = fronted ? (joinFace?.actions.aim ?? null) : null;
  const wasExpandedRef = useRef(false);
  useEffect(() => {
    const wasExpanded = wasExpandedRef.current;
    wasExpandedRef.current = expanded;
    if (aim === null || !expanded || wasExpanded) return;
    aim(entry);
  }, [aim, expanded, entry]);

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
  const menuButtonRef = useRef<HTMLButtonElement | null>(null);
  const rowMenu = useDashRowMenu({
    binding:
      binding === null
        ? null
        : {
            bound,
            disabledReason: binding.disabledReason,
            perform: () => (bound ? binding.unbind(entry) : binding.bind(entry)),
          },
    discard: !canDiscard
      ? null
      : {
          disabledReason: discard.disabledReason,
          // The lane's one confirm, armed against the ROW rather than the
          // opener: the opener is inside a menu that closes on activation, and
          // a popover anchored to an element that unmounts under it is the
          // shape `TugConfirmPopover`'s docblock warns about.
          perform: () => onRequestDiscard(entry, rowRef.current),
        },
    // Offered on every row on identical terms, bound or not: the automatic
    // engine's gate never reads boundness either, so a bound diverged dash is
    // exactly as stuck as an unbound one ({@link replayDisabledReason}).
    replay:
      replay === null
        ? null
        : {
            label: `Replay onto ${entry.base}`,
            disabledReason: replay.disabledReason ?? replayDisabledReason(entry),
            perform: () => replay.replay(entry),
          },
  });
  const model = dashTrackModelFromEntry(entry);

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
      >
        {/* The dash's whole life in the one block the Dashes card's rows wear, here
            at the reading scale — the shade is the surface you came to read,
            and a line a step smaller than the register beneath it would read
            as a footnote to its own block. Line 1 is who: the dash atom and
            one worker atom per bound session, an unbound dash showing none.
            Line 2 is what the dash is DOING.

            The entry is passed rather than looked up: this row IS that dash,
            so making the block re-derive it from the changeset store would
            put a fact the row was built from behind a feed arriving. */}
        <DashLifecycleBlock
          name={entry.display_name}
          workers={entry.bound_sessions ?? []}
          model={model}
          note={dashLifecycleNote(model)}
          stepTitle={entry.step_title ?? null}
          facts={dashMetaFacts(entry)}
          size="read"
          trailing={
          <span className="session-changes-dash-row-trailing">
            {/* The row's rare verbs, behind one opener. Bind/Unbind and
                Discard are real and reachable and almost never pressed, and
                standing on the row they read as peers of the acts a reader
                performs constantly. The join is deliberately not among them:
                it is a decision, made in the composer. */}
            {rowMenu.menu !== null ? (
              <TugPushButton
                ref={menuButtonRef}
                size="2xs"
                subtype="icon"
                emphasis="ghost"
                aria-label={`Actions for dash ${entry.display_name}`}
                data-slot="session-changes-dash-row-menu-open"
                icon={<EllipsisVertical size={14} />}
                onClick={() => rowMenu.openMenu(menuButtonRef.current)}
              />
            ) : null}
            {rowMenu.menu}
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
        />
      </TugListRow>
      {/* What the JOIN is doing, in the one shared register — the same
          sentence the Dashes card row and the composer show, because all three call
          one derivation. It states and never asks: every act in the arc lives
          in Z5 or in the prompt. */}
      <span className="session-changes-dash-register">
        <DashJoinRegister
          dash={entry.display_name}
          base={entry.base ?? "main"}
          stage={entry.stage}
          join={entry.join ?? null}
          // The join is an offer, and an offer waits for the work behind it:
          // a dash whose session is still running its background tests is not
          // finished, whatever its committed rounds say.
          holdersBusy={entry.holders_busy === true}
          resolvePhase={resolve.phase}
          landBeat={landBeat}
          // The lane shows unfronted, unheld dashes too, and the pilot never
          // works one ([D147]) — so this is the difference between "the check
          // is a beat away" and a promise nothing will ever keep.
          bound={(entry.bound_sessions ?? []).length > 0}
          altitude="entry"
        />
      </span>
      {/* The fold, ranked: documents · report (the join's evidence, advisories
          included) · the brief (what would land, as a briefing: the message's
          subject and summary, the change's shape, the paths and rounds one
          fold down) — each under the shade's own `TugSectionLabel` eyebrow,
          the same component the file buckets above render, so the fold is
          not a third dialect. A section renders nothing it cannot say. */}
      {expanded ? (
        <div className="session-changes-dash-detail">
          {/* The dash's own documents, first: what it was asked for and what
              it decided to do outrank what it has done so far. They were
              readable because they were files in the tree, and they still are
              files — the strip is the same act on the same bytes ([B08]). */}
          {entry.documents !== undefined ? (
            <div
              className="session-changes-dash-documents-block"
              data-slot="session-changes-dash-documents-block"
            >
              <TugSectionLabel
                label={{ name: "documents" }}
                slot="session-changes-dash-documents-label"
              />
              <SessionChangesDashDocuments
                documents={entry.documents}
                review={entry.review}
                taskList={entry.task_list ?? false}
                steps={
                  entry.steps === undefined || entry.steps.length === 0
                    ? undefined
                    : {
                        done: entry.steps.filter((s) => s.status === "done").length,
                        total: entry.steps.length,
                      }
                }
              />
            </div>
          ) : null}
          {joinFace !== null ? (
            <SessionChangesDashJoin
              entry={entry}
              join={entry.join ?? null}
              // The join verb is one round trip per card. Its refusal belongs
              // under the row that made the request and nowhere else.
              error={fronted ? joinFace.join.error : null}
              resolve={resolve}
              actions={joinFace.actions}
            />
          ) : null}
          <SessionChangesDashBrief entry={entry} />
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The lane
// ---------------------------------------------------------------------------

/**
 * The fronted row for a dash that has documents and no branch yet — the
 * planning phase, on the card that is working it.
 *
 * It is deliberately not a {@link DashRow}: a branchless dash has no worktree,
 * no base, no rounds and no files, so the diff, the join and the discard
 * affordances would every one of them be a control over nothing. What it does
 * have is an identity, an arc, and its documents, and those are what it shows.
 * Unbind stands because binding is the one thing a card can still undo here.
 */
function DocumentDashRow({
  entry,
  binding,
}: {
  entry: DocumentDashEntry;
  binding: DashLaneBinding | null;
}): React.ReactElement {
  const asEntry = documentDashAsEntry(entry);
  const model = documentDashTrackModel(entry);

  return (
    <div
      className="session-changes-dash-row"
      data-slot="session-changes-dash-row"
      data-dash={entry.display_name}
      data-fronted="true"
      data-branchless="true"
      data-expanded="true"
    >
      <TugListRow variant="flush" density="compact">
        {/* The same block a branch row wears, over the same counted model the
            Dashes card's documents-only row uses — never `dashTrackModelFromEntry`
            over the adapted entry, which carries no steps and would read
            `review` for a plan already half walked. */}
        <DashLifecycleBlock
          name={entry.display_name}
          workers={entry.bound_sessions ?? []}
          model={model}
          note={dashLifecycleNote(model)}
          facts={dashMetaFacts(asEntry)}
          size="read"
          trailing={
            binding !== null ? (
              <TugPushButton
                size="2xs"
                emphasis="ghost"
                data-slot="session-changes-dash-unbind"
                aria-label={`Unbind the dash ${entry.display_name}`}
                onClick={() => binding.unbind(asEntry)}
              >
                Unbind
              </TugPushButton>
            ) : undefined
          }
        />
      </TugListRow>
      <div className="session-changes-dash-detail">
        <div
          className="session-changes-dash-documents-block"
          data-slot="session-changes-dash-documents-block"
        >
          <TugSectionLabel
            label={{ name: "documents" }}
            slot="session-changes-dash-documents-label"
          />
          <SessionChangesDashDocuments
            documents={entry.documents}
            review={entry.review}
            taskList={entry.task_list ?? false}
            steps={
              entry.step_total > 0
                ? { done: entry.steps_done, total: entry.step_total }
                : undefined
            }
          />
        </div>
      </div>
    </div>
  );
}

export interface SessionChangesDashLaneProps {
  /** The project's dash entries, in snapshot order. */
  dashes: readonly DashChangesetEntry[];
  /** The owner key of the dash this card's session is mated to, if any. It
   *  decides which row offers **Unbind** rather than **Bind**. */
  boundDashId: string | null;
  /** The owner key of the row to front, when that is not the bound one — a
   *  join aimed by name (`/dash-join <name>`) fronts its target so the
   *  join face has somewhere to mount. Defaults to `boundDashId`.
   *
   *  The two are deliberately separate: fronting is about *what is being
   *  landed*, the binding is about *what this card is working*, and a join
   *  aimed at a dash the card never bound must not offer to Unbind it. */
  frontedDashId?: string | null;
  /** Absolute checkout root — the range descriptor's `root`. */
  projectRoot: string;
  /**
   * The workspace key this card addresses the project by — what every send on
   * the join path carries, and therefore the only spelling the join store is
   * ever written under. Distinct from { projectRoot} on purpose ([L29]).
   */
  workspaceKey: string;
  /** The fronted row's join face; omitted leaves the lane read-only. */
  joinFace?: DashLaneJoinFace;
  /** Bind / Unbind, for every row; omitted leaves the lane read-only. */
  binding?: DashLaneBinding;
  /** Discard, for every row the reach rule allows; omitted leaves the lane
   *  read-only. */
  discard?: DashLaneDiscard;
  /** Replay, on the same terms for every row; omitted leaves the lane
   *  read-only. */
  replay?: DashLaneReplay;
  /** The bound dash when it has documents and no branch yet — the planning
   *  phase. Fronted in place of a dash row, since there is no branch to show. */
  documentDash?: DocumentDashEntry | null;
}

export function SessionChangesDashLane({
  dashes,
  boundDashId,
  frontedDashId,
  projectRoot,
  workspaceKey,
  joinFace,
  binding,
  discard,
  replay,
  documentDash,
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

  // A branchless bound dash is a lane with something to say and no dash
  // entries at all — the planning phase, before any branch is cut.
  if (dashes.length === 0 && documentDash == null) return null;

  const { fronted, rest } = orderDashLane(
    dashes,
    frontedDashId ?? boundDashId,
  );
  const isExpanded = (entry: DashChangesetEntry): boolean =>
    overrides[entry.owner_id] ?? (entry === fronted || dashRowOpensItself(entry));
  const toggle = (entry: DashChangesetEntry, next: boolean): void => {
    setOverrides((prev) => ({ ...prev, [entry.owner_id]: next }));
  };
  const restLabel = dashRestLabel(rest.length, fronted !== null);

  return (
    <div className="session-changes-dash-lane" data-slot="session-changes-dash-lane">
      {fronted === null && documentDash != null ? (
        <>
          <TugSectionLabel
            label={dashFrontedLabel(true)}
            slot="session-changes-dash-lane-fronted-label"
          />
          <DocumentDashRow
            key={documentDash.owner_id}
            entry={documentDash}
            binding={binding ?? null}
          />
        </>
      ) : null}
      {fronted !== null ? (
        <>
          <TugSectionLabel
            label={dashFrontedLabel(fronted.owner_id === boundDashId)}
            slot="session-changes-dash-lane-fronted-label"
          />
          <DashRow
            // Keyed so a rebind swaps the row rather than reusing it: the
            // join face's preview fires on mount, and a reused instance
            // would show the new dash under the old dash's verdict.
            key={fronted.owner_id}
            entry={fronted}
            projectRoot={projectRoot}
            workspaceKey={workspaceKey}
            fronted
            bound={fronted.owner_id === boundDashId}
            expanded={isExpanded(fronted)}
            onToggle={(next) => toggle(fronted, next)}
            joinFace={joinFace ?? null}
            binding={binding ?? null}
            discard={discard ?? null}
            replay={replay ?? null}
            onRequestDiscard={requestDiscard}
          />
        </>
      ) : null}
      {rest.length > 0 ? (
        <>
          <TugSectionLabel
            label={restLabel}
            slot="session-changes-dash-lane-rest-label"
          />
          {rest.map((entry) => (
            <DashRow
              key={entry.owner_id}
              entry={entry}
              projectRoot={projectRoot}
              workspaceKey={workspaceKey}
              fronted={false}
              bound={entry.owner_id === boundDashId}
              expanded={isExpanded(entry)}
              onToggle={(next) => toggle(entry, next)}
              joinFace={joinFace ?? null}
              binding={binding ?? null}
              discard={discard ?? null}
              replay={replay ?? null}
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
