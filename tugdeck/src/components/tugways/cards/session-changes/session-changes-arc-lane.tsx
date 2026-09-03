/**
 * `SessionChangesArcLane` — the Changes shade's arc lane.
 *
 * An arc is not a claim. Rendered in session-file grammar an arc branch reads
 * as one — so it gets its own species of row: one `ArcLifecycleBlock` at the
 * READING scale, the same block the Arcs card renders at the
 * rail, so the two surfaces speak one language. Line 1 is who — the arc atom
 * and one worker atom per bound session; line 2 is what the arc is doing —
 * track · fraction · note · divergence. The row keeps its per-row fold, and no
 * claim, disclaim, or hunk-election affordance appears anywhere inside it. The
 * lane's one diff affordance is the whole-range pop-out, because the server's
 * range diff takes no pathspec and the arc is the unit anyway.
 *
 * **Every arc in the project is a visible row.** The card's own arc renders
 * first and expanded; the rest follow under a plain label, each collapsed to
 * its one-line sentence. They used to hide behind a `N arcs` count, which is
 * the same mistake the unattributed-files bucket avoids by showing its rows: a
 * count is a rumor, a row is a situation you can act on. Each costs one line,
 * so showing them all costs a handful — and the fold's own cue was the control
 * at0405's chronic "did not land" click was aimed at.
 *
 * Per-row expansion stays view-scope state: the shade is a glance surface,
 * dismiss and forget, so nothing here is persisted.
 *
 * **Every row carries a join face**: the server's standing answer for that
 * arc, plus the acts that clear it. Every arc's join state rides its own feed
 * entry and the resolve store is keyed by arc, so a row's face is that row's
 * own facts throughout — none of it is borrowed from the fronted arc.
 *
 * It was the fronted row's alone, on the reasoning that joining is a gesture on
 * the card's own arc. But the register speaks on every row: a blocked arc
 * anywhere in the lane prints `blockers[0].detail` and the word `blocked`, and
 * withholding the face left exactly those rows stating a refusal beside nothing
 * that explains or clears it. Resolve is not joining — it commits base-side
 * work so a join can be attempted at all, and the arc it acts on is the one
 * named in the sentence, whatever this card happens to be bound to.
 *
 * Two things stay the fronted row's, because both really are the card's and not
 * the arc's: `aim`, which points the composer's join at an arc the reader
 * merely opened, and the join verb's own `error`, which is one round trip per
 * card and would otherwise print another row's refusal under this one.
 *
 * The two **binding** gestures go the other way. Every row carries one: Unbind
 * on the fronted row, Bind on all the rest, complements that never appear
 * together. This is the room where an arc's facts already live, so the act of
 * taking an arc on belongs beside the facts you would take it on for — and
 * "non-fronted rows stay read-only" was always a rule about *joining*, a
 * gesture on work a card never touched. Binding is how a card comes to touch
 * it.
 *
 * Binding and Discard both live behind the row's `⋯` ({@link useArcRowMenu})
 * rather than standing on it. They are rare — a card binds an arc once and
 * discards one almost never — and standing beside the pop-out and the fold cue
 * they read as peers of acts a reader performs constantly. Every row is
 * otherwise a thing to read.
 *
 * Laws: [L02] the lane takes its data as props from the view's
 * `useSyncExternalStore` reads; [L06] tone and state paint through CSS and
 * data attributes; [L19] the row composes `ArcLifecycleBlock` / `TugListRow`
 * / `BlockFoldCue` / `PopOutDiffButton` rather than hand-rolling chrome.
 *
 * @module components/tugways/cards/session-changes/session-changes-arc-lane
 */

import "./session-changes-arc-lane.css";

import React, { useEffect, useRef, useState } from "react";
import { EllipsisVertical } from "lucide-react";

import { TugPushButton } from "@/components/tugways/tug-push-button";
import { TugListRow } from "@/components/tugways/tug-list-row";
import { replayDisabledReason, useArcRowMenu } from "./arc-row-menu";
import { BlockFoldCue } from "@/components/tugways/body-kinds/affordances/block-fold-cue";
import { PopOutDiffButton } from "@/components/tugways/tug-changes-list";
import { TugSectionLabel } from "@/components/tugways/tug-section-label";
import { SessionChangesArcDocuments } from "./session-changes-arc-documents";
import { SessionChangesArcBrief } from "./session-changes-arc-brief";
import { TugConfirmPopover } from "@/components/tugways/tug-confirm-popover";
import { ArcLifecycleBlock } from "@/components/tugways/arc-lifecycle-block";
import { arcLifecycleNote } from "@/components/tugways/arc-lifecycle-line";
import { arcTrackModelFromEntry } from "@/components/tugways/tug-arc-track";
import { arcMetaFacts } from "@/lib/arc-meta-facts";
import { ArcJoinRegister } from "@/components/tugways/arc-join-register";
import { useChangesetJoinLand, useChangesetJoinResolve } from "@/lib/changeset-join-store";
import { arcFrontedLabel, arcRestLabel } from "./changes-section-labels";
import {
  SessionChangesArcJoin,
  discardPreflightLine,
  type ArcJoinActions,
} from "./session-changes-arc-join";
import type { DiffDescriptor } from "@/lib/git-diff-store";
import type {
  ArcChangesetEntry,
  DocumentArcEntry,
} from "@/lib/changeset-types";
import {
  documentArcAsEntry,
  documentArcTrackModel,
} from "@/lib/document-arc-entry";
import type { JoinState } from "@/lib/changeset-verb-store";
import type { JoinOutcome } from "@/lib/join-mode-controller";

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

/**
 * A row that opens itself, before anybody touches it.
 *
 * Fronting is the usual reason, and a refusal is the other. A blocked arc
 * prints its first blocker's sentence and the word `blocked` in the register
 * whether the row is open or shut — but the report that says what would clear
 * it, and carries the control that does, is inside the fold. Left shut, the row
 * states a problem and hides the answer one line under it, which is the exact
 * shape of a control nobody can find. Still an override: closing it sticks.
 */
export function arcRowOpensItself(entry: ArcChangesetEntry): boolean {
  return (entry.join?.blockers ?? []).length > 0;
}

/** The lane's two groups: the card's own arc, then everything else. */
export interface ArcLaneOrder {
  /** The arc this card's session is mated to, or null when unbound. */
  fronted: ArcChangesetEntry | null;
  /** Every other arc in the project, in snapshot order. */
  rest: ArcChangesetEntry[];
}

/**
 * Split the project's arcs into the fronted one and the rest.
 *
 * The match is on the **owner key**, never the name: a stale binding to a dead
 * incarnation of a reused name must not front the wrong arc. An unmatched
 * binding is simply an unbound lane — which is also what the one-recompose
 * window after a bind that minted a new id should show.
 */
export function orderArcLane(
  arcs: readonly ArcChangesetEntry[],
  boundArcId: string | null,
): ArcLaneOrder {
  const fronted =
    boundArcId !== null
      ? (arcs.find((entry) => entry.owner_id === boundArcId) ?? null)
      : null;
  return {
    fronted,
    rest: arcs.filter((entry) => entry !== fronted),
  };
}

/** The arc's git ref — `branch`, falling back to the older sender's spelling. */
export function arcBranchRef(entry: ArcChangesetEntry): string {
  return entry.branch ?? `tugarc/${entry.display_name}`;
}


/**
 * The half of a row's join face the card owns, read once by the view and handed
 * to every row. What a join would do comes off each arc's own feed entry, and
 * the resolution ladder's progress is read per row from a store keyed by arc.
 */
export interface ArcLaneJoinFace {
  /** The card's one join round trip ([L02], read by the view) — the face
   *  shows its verb-level refusal, when one came back. Card-scoped, so only
   *  the fronted row reads it; see the module docblock. */
  join: JoinState;
  actions: ArcJoinActions;
}

/**
 * The lane's two binding gestures ([P05]).
 *
 * This bundle goes to **every** row, and a row picks Bind or Unbind from its
 * own `fronted` flag — the two are complements, so they never appear together
 * and the cluster stays one affordance wide.
 *
 * Neither callback may move `cardSessionBindingStore`. The `bind_arc_ok` /
 * `unbind_arc_ok` broadcasts are the only movers, which is what leaves a card
 * correctly bound to what it was when a bind is refused.
 */
/**
 * The lane's discard gesture, for every row the reach rule allows.
 *
 * Like {@link ArcLaneBinding}, this reaches past the fronted row: an unbound
 * arc nobody is holding is exactly the kind a shade should be able to clean
 * up, and the `empty` join outcome's own answer is discard rather than a fix.
 */
export interface ArcLaneDiscard {
  /** Whether this shade may discard this arc ({@link canDiscardFromHere}). */
  canDiscard: (entry: ArcChangesetEntry) => boolean;
  /** Send `changeset_discard`. Called by the confirm popover, never a button. */
  discard: (entry: ArcChangesetEntry) => void;
  /**
   * Why every Discard on this lane is unavailable right now, or null.
   *
   * Folds two gates. A turn in flight is the owner's rule — an arc is only
   * discarded when no turn is running in the session bound to it, which is
   * always *this* card's turn, because the reach rule renders no control for a
   * arc another live session holds. And a discard already in flight, because
   * `DiscardState` is one slot per card: arming a second row would let the two
   * render each other's phase.
   */
  disabledReason: string | null;
}

export interface ArcLaneReplay {
  /** Send `changeset_replay` for this row's arc. */
  replay: (entry: ArcChangesetEntry) => void;
  /** Why every Replay on this lane is unavailable right now, or null. Folds
   *  only the in-flight gate; the per-arc terms are
   *  {@link replayDisabledReason}'s, computed from the row's own facts. */
  disabledReason: string | null;
}

export interface ArcLaneBinding {
  /** Send `bind_arc` for this row's arc. */
  bind: (entry: ArcChangesetEntry) => void;
  /** Send `unbind_arc` for this card's session. */
  unbind: (entry: ArcChangesetEntry) => void;
  /** Why both are unavailable right now, or null when they are available.
   *  Disabled with a reason rather than silently bouncing. */
  disabledReason: string | null;
}

/**
 * Whether this shade may discard this arc.
 *
 * A shade may discard its own arc, and any arc no live session is holding. A
 * arc bound to *another* live session is that session's to discard, and this
 * one renders no control for it at all.
 *
 * `bound_sessions` already means exactly "live sessions mated to this arc" —
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
  entry: ArcChangesetEntry,
  ownTugSessionId: string | undefined,
  boundArcId: string | null,
): boolean {
  if (entry.owner_id === boundArcId) return true;
  const bound = entry.bound_sessions ?? [];
  if (bound.length === 0) return true;
  // Not redundant with the first arm: a card can be mated to arc A while arc
  // B also lists this session. The predicate answers by fact, not by fronting.
  return ownTugSessionId !== undefined && bound.includes(ownTugSessionId);
}

/**
 * The discard confirm's message: a fact sheet, never "are you sure".
 *
 * Every clause names something the reader cannot see by looking at the row.
 * The hand-back sentence is the one that must never be dropped — `arc discard`
 * deliberately writes the worktree's uncommitted files back into the base
 * checkout rather than destroying them, and a person who has not been told that
 * has not agreed to it. The plan sentence is the same kind of fact:
 * `restore_plan_to_base` runs before teardown, unconditionally, so discarding a
 * arc never destroys the authored plan document.
 *
 * The round subjects are deliberately absent: the row already lists them in
 * `session-changes-arc-subjects` when expanded, and `TugConfirmPopover`'s
 * message is one flat string that would size itself off the longest subject.
 *
 * Pure, so the sentence is testable without mounting the lane.
 */
export function discardConfirmMessage(entry: ArcChangesetEntry): string {
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
    clauses.push(`Its documents stay at .tug/arcs/${entry.display_name}/.`);
  }
  return clauses.join(" ");
}

// ---------------------------------------------------------------------------
// The row
// ---------------------------------------------------------------------------

function ArcRow({
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
  entry: ArcChangesetEntry;
  projectRoot: string;
  /** The key the join store is written under — never the root ([L29]). */
  workspaceKey: string;
  fronted: boolean;
  /** This card is mated to this arc — which is what Unbind-vs-Bind reads,
   *  and is not the same question as which row is fronted. */
  bound: boolean;
  expanded: boolean;
  onToggle: (next: boolean) => void;
  joinFace: ArcLaneJoinFace | null;
  binding: ArcLaneBinding | null;
  /** Discard, for every row the reach rule allows; omitted leaves the lane
   *  read-only. */
  discard: ArcLaneDiscard | null;
  /** Replay, on the same terms for every row; omitted leaves the lane
   *  read-only. */
  replay: ArcLaneReplay | null;
  /** Arm the lane's discard confirm against this row's element. The row is the
   *  anchor, never the button: a button inside a hover-revealed cluster can
   *  unmount under its own popover, which is the shape `TugConfirmPopover`'s
   *  docblock warns about. */
  onRequestDiscard: (entry: ArcChangesetEntry, anchor: HTMLElement | null) => void;
}): React.ReactElement {
  const rowRef = useRef<HTMLDivElement | null>(null);
  // The beats of a join in flight on THIS arc ([L02], [P03]). Subscribed per
  // row so one arc landing does not re-render every other row in the lane.
  // Keyed on the WORKSPACE KEY, never the project root. The beat frames echo
  // back the `project_dir` the request sent, and every send on this path sends
  // the workspace key — so a read under the root's spelling is a subscription
  // to a cell nothing ever writes ([L29]). That is not a hypothetical: it is
  // the exact shape of the bug at0441 was written for, one field over.
  const landBeat = useChangesetJoinLand(workspaceKey, entry.display_name);
  // The resolution ladder's progress for THIS arc ([L02]), on the same terms
  // and for the same reason as the beats above: the store is keyed by arc, so
  // a row reading the fronted arc's key would paint another arc's ladder.
  const resolve = useChangesetJoinResolve(workspaceKey, entry.display_name);
  // Opening a row points the join mode at its arc and asks the server nothing:
  // the answer is already on the entry. The effect fires on the closed → open
  // edge (and on mount, since the fronted row opens with the shade), so the
  // composer's ⌃⌘C lands on the arc the reader is looking at.
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
    branch: arcBranchRef(entry),
  };
  // An arc with nothing past its base and a clean worktree has no range to
  // show; offering the pop-out would open an empty card.
  const hasRange = entry.rounds > 0 || entry.worktree_dirty;
  // Absent, not disabled, when this shade has no business discarding this arc.
  const canDiscard = discard !== null && discard.canDiscard(entry);
  const menuButtonRef = useRef<HTMLButtonElement | null>(null);
  const rowMenu = useArcRowMenu({
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
    // engine's gate never reads boundness either, so a bound diverged arc is
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
  const model = arcTrackModelFromEntry(entry);

  return (
    <div
      ref={rowRef}
      className="session-changes-arc-row"
      data-slot="session-changes-arc-row"
      data-arc={entry.display_name}
      data-fronted={fronted ? "true" : undefined}
      data-expanded={expanded ? "true" : undefined}
    >
      <TugListRow
        variant="flush"
        density="compact"
      >
        {/* The arc's whole life in the one block the Arcs card's rows wear, here
            at the reading scale — the shade is the surface you came to read,
            and a line a step smaller than the register beneath it would read
            as a footnote to its own block. Line 1 is who: the arc atom and
            one worker atom per bound session, an unbound arc showing none.
            Line 2 is what the arc is DOING.

            The entry is passed rather than looked up: this row IS that arc,
            so making the block re-derive it from the changeset store would
            put a fact the row was built from behind a feed arriving. */}
        <ArcLifecycleBlock
          name={entry.display_name}
          workers={entry.bound_sessions ?? []}
          model={model}
          note={arcLifecycleNote(model)}
          stepTitle={entry.step_title ?? null}
          facts={arcMetaFacts(entry)}
          size="read"
          trailing={
          <span className="session-changes-arc-row-trailing">
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
                aria-label={`Actions for arc ${entry.display_name}`}
                data-slot="session-changes-arc-row-menu-open"
                icon={<EllipsisVertical size={14} />}
                onClick={() => rowMenu.openMenu(menuButtonRef.current)}
              />
            ) : null}
            {rowMenu.menu}
            {hasRange ? (
              <PopOutDiffButton
                descriptor={descriptor}
                label={`Open the ${entry.display_name} arc diff in a card`}
              />
            ) : null}
            <BlockFoldCue
              collapsed={!expanded}
              onToggle={(nextCollapsed) => onToggle(!nextCollapsed)}
              collapsedLabel="Expand arc"
              ariaLabelExpand={`Show details for arc ${entry.display_name}`}
              ariaLabelCollapse={`Hide details for arc ${entry.display_name}`}
              size="2xs"
              subtype="icon"
              stabilizeScroll={false}
              data-slot="session-changes-arc-fold"
            />
          </span>
          }
        />
      </TugListRow>
      {/* What the JOIN is doing, in the one shared register — the same
          sentence the Arcs card row and the composer show, because all three call
          one derivation. It states and never asks: every act in the arc lives
          in Z5 or in the prompt. */}
      <span className="session-changes-arc-register">
        <ArcJoinRegister
          arc={entry.display_name}
          base={entry.base ?? "main"}
          stage={entry.stage}
          join={entry.join ?? null}
          // The join is an offer, and an offer waits for the work behind it:
          // an arc whose session is still running its background tests is not
          // finished, whatever its committed rounds say.
          holdersBusy={entry.holders_busy === true}
          resolvePhase={resolve.phase}
          landBeat={landBeat}
          // The lane shows unfronted, unheld arcs too, and the pilot never
          // works one ([D147]) — so this is the difference between "the check
          // is a beat away" and a promise nothing will ever keep.
          bound={(entry.bound_sessions ?? []).length > 0}
          // The shade is where the offer is actually pressed, so a stage the
          // wheel still has seated is named here rather than read around.
          run={entry.arc ?? null}
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
        <div className="session-changes-arc-detail">
          {/* The arc's own documents, first: what it was asked for and what
              it decided to do outrank what it has done so far. They were
              readable because they were files in the tree, and they still are
              files — the strip is the same act on the same bytes ([B08]). */}
          {entry.documents !== undefined ? (
            <div
              className="session-changes-arc-documents-block"
              data-slot="session-changes-arc-documents-block"
            >
              <TugSectionLabel
                label={{ name: "documents" }}
                slot="session-changes-arc-documents-label"
              />
              <SessionChangesArcDocuments
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
            <SessionChangesArcJoin
              entry={entry}
              join={entry.join ?? null}
              // The join verb is one round trip per card. Its refusal belongs
              // under the row that made the request and nowhere else.
              error={fronted ? joinFace.join.error : null}
              resolve={resolve}
              actions={joinFace.actions}
            />
          ) : null}
          <SessionChangesArcBrief entry={entry} />
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The lane
// ---------------------------------------------------------------------------

/**
 * The fronted row for an arc that has documents and no branch yet — the
 * planning phase, on the card that is working it.
 *
 * It is deliberately not a {@link ArcRow}: a branchless arc has no worktree,
 * no base, no rounds and no files, so the diff, the join and the discard
 * affordances would every one of them be a control over nothing. What it does
 * have is an identity, an arc, and its documents, and those are what it shows.
 * Unbind stands because binding is the one thing a card can still undo here.
 */
function DocumentArcRow({
  entry,
  binding,
}: {
  entry: DocumentArcEntry;
  binding: ArcLaneBinding | null;
}): React.ReactElement {
  const asEntry = documentArcAsEntry(entry);
  const model = documentArcTrackModel(entry);

  return (
    <div
      className="session-changes-arc-row"
      data-slot="session-changes-arc-row"
      data-arc={entry.display_name}
      data-fronted="true"
      data-branchless="true"
      data-expanded="true"
    >
      <TugListRow variant="flush" density="compact">
        {/* The same block a branch row wears, over the same counted model the
            Arcs card's documents-only row uses — never `arcTrackModelFromEntry`
            over the adapted entry, which carries no steps and would read
            `review` for a plan already half walked. */}
        <ArcLifecycleBlock
          name={entry.display_name}
          workers={entry.bound_sessions ?? []}
          model={model}
          note={arcLifecycleNote(model)}
          facts={arcMetaFacts(asEntry)}
          size="read"
          trailing={
            binding !== null ? (
              <TugPushButton
                size="2xs"
                emphasis="ghost"
                data-slot="session-changes-arc-unbind"
                aria-label={`Unbind the arc ${entry.display_name}`}
                onClick={() => binding.unbind(asEntry)}
              >
                Unbind
              </TugPushButton>
            ) : undefined
          }
        />
      </TugListRow>
      <div className="session-changes-arc-detail">
        <div
          className="session-changes-arc-documents-block"
          data-slot="session-changes-arc-documents-block"
        >
          <TugSectionLabel
            label={{ name: "documents" }}
            slot="session-changes-arc-documents-label"
          />
          <SessionChangesArcDocuments
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

export interface SessionChangesArcLaneProps {
  /** The project's arc entries, in snapshot order. */
  arcs: readonly ArcChangesetEntry[];
  /** The owner key of the arc this card's session is mated to, if any. It
   *  decides which row offers **Unbind** rather than **Bind**. */
  boundArcId: string | null;
  /** The owner key of the row to front, when that is not the bound one — a
   *  join aimed by name (`/arc-join <name>`) fronts its target so the
   *  join face has somewhere to mount. Defaults to `boundArcId`.
   *
   *  The two are deliberately separate: fronting is about *what is being
   *  landed*, the binding is about *what this card is working*, and a join
   *  aimed at an arc the card never bound must not offer to Unbind it. */
  frontedArcId?: string | null;
  /** Absolute checkout root — the range descriptor's `root`. */
  projectRoot: string;
  /**
   * The workspace key this card addresses the project by — what every send on
   * the join path carries, and therefore the only spelling the join store is
   * ever written under. Distinct from { projectRoot} on purpose ([L29]).
   */
  workspaceKey: string;
  /** The fronted row's join face; omitted leaves the lane read-only. */
  joinFace?: ArcLaneJoinFace;
  /** Bind / Unbind, for every row; omitted leaves the lane read-only. */
  binding?: ArcLaneBinding;
  /** Discard, for every row the reach rule allows; omitted leaves the lane
   *  read-only. */
  discard?: ArcLaneDiscard;
  /** Replay, on the same terms for every row; omitted leaves the lane
   *  read-only. */
  replay?: ArcLaneReplay;
  /** The bound arc when it has documents and no branch yet — the planning
   *  phase. Fronted in place of an arc row, since there is no branch to show. */
  documentArc?: DocumentArcEntry | null;
}

export function SessionChangesArcLane({
  arcs,
  boundArcId,
  frontedArcId,
  projectRoot,
  workspaceKey,
  joinFace,
  binding,
  discard,
  replay,
  documentArc,
}: SessionChangesArcLaneProps): React.ReactElement | null {
  // Per-arc expansion overrides. The default is "expanded exactly when this
  // is the card's own arc", so a bind that arrives while the shade is open
  // fronts and opens the new arc without the reader touching anything.
  const [overrides, setOverrides] = useState<Readonly<Record<string, boolean>>>({});
  // Which row's discard is armed, and the element the confirm hangs off.
  // View-scope state ([L24]): a half-armed confirm is not something to
  // remember, so nothing here is persisted and dismissing the shade forgets it.
  //
  // One popover instance serves every row — the documented in-list confirmation
  // shape — which is what makes widening Discard past the fronted row cost no
  // per-row state.
  const [pendingDiscard, setPendingDiscard] = useState<{
    entry: ArcChangesetEntry;
    anchor: HTMLElement | null;
  } | null>(null);
  const requestDiscard = (
    entry: ArcChangesetEntry,
    anchor: HTMLElement | null,
  ): void => {
    setPendingDiscard({ entry, anchor });
  };

  // A branchless bound arc is a lane with something to say and no arc
  // entries at all — the planning phase, before any branch is cut.
  if (arcs.length === 0 && documentArc == null) return null;

  const { fronted, rest } = orderArcLane(
    arcs,
    frontedArcId ?? boundArcId,
  );
  const isExpanded = (entry: ArcChangesetEntry): boolean =>
    overrides[entry.owner_id] ?? (entry === fronted || arcRowOpensItself(entry));
  const toggle = (entry: ArcChangesetEntry, next: boolean): void => {
    setOverrides((prev) => ({ ...prev, [entry.owner_id]: next }));
  };
  const restLabel = arcRestLabel(rest.length, fronted !== null);

  return (
    <div className="session-changes-arc-lane" data-slot="session-changes-arc-lane">
      {fronted === null && documentArc != null ? (
        <>
          <TugSectionLabel
            label={arcFrontedLabel(true)}
            slot="session-changes-arc-lane-fronted-label"
          />
          <DocumentArcRow
            key={documentArc.owner_id}
            entry={documentArc}
            binding={binding ?? null}
          />
        </>
      ) : null}
      {fronted !== null ? (
        <>
          <TugSectionLabel
            label={arcFrontedLabel(fronted.owner_id === boundArcId)}
            slot="session-changes-arc-lane-fronted-label"
          />
          <ArcRow
            // Keyed so a rebind swaps the row rather than reusing it: the
            // join face's preview fires on mount, and a reused instance
            // would show the new arc under the old arc's verdict.
            key={fronted.owner_id}
            entry={fronted}
            projectRoot={projectRoot}
            workspaceKey={workspaceKey}
            fronted
            bound={fronted.owner_id === boundArcId}
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
            slot="session-changes-arc-lane-rest-label"
          />
          {rest.map((entry) => (
            <ArcRow
              key={entry.owner_id}
              entry={entry}
              projectRoot={projectRoot}
              workspaceKey={workspaceKey}
              fronted={false}
              bound={entry.owner_id === boundArcId}
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
          reflexive Return can never destroy an arc. */}
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
