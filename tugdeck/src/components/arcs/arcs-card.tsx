/**
 * arcs-card.tsx — the **Arcs** card: every arc in every open project, in
 * every state, always on.
 *
 * The card is a fixed address. It used to show only unbound arcs and to
 * vanish entirely at zero — and the coming and going was the wart: a surface
 * with no fixed place cannot be glanced at. Now the card is always there, every
 * arc is a row, and the empty state is one quiet line that costs ~24px and
 * buys the card its address.
 *
 * Each arc is a two-line block in one grammar, the same grammar the Changes
 * shade's collapsed arc row wears:
 *
 *   [^arc-atom] ───────────────────────── [worker atom]
 *     track · glyph · fraction · note · divergence
 *
 * Every row is one `ArcLifecycleBlock`, the grammar every arc surface wears.
 * Its EYEBROW holds the identities and, at its end, the row's one control: the
 * arc atom at the left, the hairline, the "who" at the right — each bound
 * worker as a mini atom (no callsign, no arc run: the row already names both)
 * — and then the fold cue. The arc pill wears no review tint here: that yellow
 * is the WAITING color, and an arc is not waiting for anyone. Beneath it, the
 * lifecycle line carries everything the arc is DOING, phase glyph included.
 *
 * **And the row FOLDS to the arc's ledger.** An arc whose entry carries steps
 * wears the tool-call header's own `BlockFoldCue` at the eyebrow's end, and
 * opens over the plan's step rows — `ArcStepItems`, the very component the
 * `ARC` placard mounts, so the row and the placard cannot disagree about one
 * arc's steps ([D176]). The bit is held HERE, in `ArcsBody`, keyed by the arc's
 * owner key: a bit inside a cell would be lost the moment virtualization
 * recycled it or a changeset beat replaced the row, which on a card that
 * re-projects on every beat is a row folding itself shut while you read it.
 * An arc with no steps draws no cue at all — absent, not disabled.
 *
 * An arc with no branch yet — a brief being written, a plan being devised or
 * reviewed — is the SAME block, over `documentArcAsEntry`, with its track
 * model from `documentArcTrackModel` so a plan already under way reads
 * `implement` with the ledger's own counts. It carries no trailing control at
 * all — neither the menu, which is a live arc's, nor the fold, which reads a
 * ledger a waiting document's entry does not carry — because a plan is
 * paperwork to read.
 *
 * `ChangesetAllStore` is the account-global snapshot, so this card is a
 * projection of it and nothing more. Rows key on the arc's **owner key**, which makes two
 * incarnations of a reused name distinct for free.
 *
 * The verbs live on the row's right-click, composed from the Changes shade's own
 * {@link useArcRowMenu} so the two arc-row surfaces speak one grammar. Bind
 * mates an unbound arc to the card's followed card, or carries its refusal in
 * the item's own label ([L31]); Discard destroys it behind a confirm anchored
 * to the row element; Replay moves the arc's rounds onto a base that has
 * advanced, on the same terms for every row. None is on row activation ([D142]).
 *
 * Both destructive verbs destroy the surface they are pressed on — the success
 * path, not an edge case — so Bind reports nothing locally: a refusal arrives on
 * the card-level bind-error surface, which outlives the row, and a replay's
 * outcome on its sibling. Unbind is not here at all: it stays the fronted shade
 * row's verb, and a bound row's job is to route you to that shade.
 *
 * Rows are totally ordered: nearest-to-done first, then freshest first, then
 * by name. Stage leads because a `draft-ready` arc is one gesture from
 * landing; freshness is the tiebreak a person actually wants; name is the
 * final tiebreak rather than snapshot order, which is git-enumeration order.
 *
 * Beneath the arcs the card lists the **waiting paperwork**: plan
 * documents sitting in each project's configured docs directory, which the
 * aggregate now carries. The back half of the arc was already machine-visible —
 * an arc reads `implementing (i/N)`, the join arms itself, the shade summons —
 * while the front half was a file only `ls` could find. A plan row is the same
 * two-line block one tone quieter, and that is the whole of it.
 *
 * **A plan row carries no button.** It wore its next gesture for a while —
 * Devise, Review, Implement — a control that composed a `/tugplug:…` line and
 * submitted it into the followed card. It read as a label rather than as a
 * control, it made a row about the followed card when the card is about
 * every project, and the gesture it offered is one sentence to type. The row
 * reports; the arc is run from the composer.
 *
 * Live work outranks waiting paperwork, so arcs come first and plans follow;
 * plans are listed for every open project, exactly as arcs are.
 *
 * Laws: [L02] the aggregate enters React through `useSyncExternalStore`;
 * [L06] tones are CSS on DOM attributes, never React state; [L19] rows compose
 * `TugListView` / `TugListRow` rather than hand-rolling list focus; [L20] the
 * blocks compose `ArcLifecycleBlock`, which owns the atom, the workers, and
 * the line.
 *
 * @module components/arcs/arcs-card
 */

import "./arcs-card.css";

import React, {
  useCallback,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";

import { RAIL_LIST_PRESENTATION } from "@/components/tugways/rail-list-presentation";
import { ArcLifecycleBlock } from "@/components/tugways/arc-lifecycle-block";
import { arcLifecycleNote } from "@/components/tugways/arc-lifecycle-line";
import { ArcStepItems } from "@/components/tugways/arc-step-list";
import { arcTrackModelFromEntry } from "@/components/tugways/tug-arc-track";
import { arcMetaFacts } from "@/lib/arc-meta-facts";
import { compareArcEntries } from "@/lib/arc-order";
import {
  documentArcAsEntry,
  documentArcTrackModel,
} from "@/lib/document-arc-entry";
import { ArcJoinRegister } from "@/components/tugways/arc-join-register";
import { BlockFoldCue } from "@/components/tugways/body-kinds/affordances/block-fold-cue";
import { useChangesetJoinLand } from "@/lib/changeset-join-store";
import { TugListRow } from "@/components/tugways/tug-list-row";
import { TugListView } from "@/components/tugways/tug-list-view";
import type {
  TugListViewCellProps,
  TugListViewCellRenderer,
  TugListViewDataSource,
  TugListViewDelegate,
} from "@/components/tugways/tug-list-view";
import { TugConfirmPopover } from "@/components/tugways/tug-confirm-popover";
import { TugPushButton } from "@/components/tugways/tug-push-button";
import {
  FollowedCardContext,
  useFollowedCard,
  useTrackFollowedCard,
} from "@/components/tugways/followed-card";
import { useSeedKeyView } from "@/components/tugways/use-focusable";
import { useResponderChain } from "@/components/tugways/responder-chain-provider";
import { TUG_ACTIONS } from "@/components/tugways/action-vocabulary";
import { dispatchCommand } from "@/command-dispatch";
import { cardSessionBindingStore } from "@/lib/card-session-binding-store";
import { getConnection } from "@/lib/connection-singleton";
import { useChangesetAll } from "@/lib/changeset-all-store";
import { useChangesetDiscard, useChangesetReplay } from "@/lib/changeset-verb-store";
import {
  replayDisabledReason,
  useArcRowMenu,
} from "@/components/tugways/cards/session-changes/arc-row-menu";
import type {
  ArcChangesetEntry,
  DocumentArcEntry,
  ProjectChangeset,
  WorkspacesChangesetSnapshot,
} from "@/lib/changeset-types";

/** The card's focus group — every stop it offers lives here. */
const ARCS_FOCUS_GROUP = "arcs-card";

/** A stable subscribe for a card that has no session store yet ([L02]). */
const NOOP_SUBSCRIBE = (): (() => void) => () => {};

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

/** One arc, in any state, flattened out of the aggregate for the list. */
export interface ArcRow {
  /** The arc's owner key — this row's identity, unique per incarnation. */
  ownerId: string;
  /** The whole wire entry: the eyebrow and the meta line read it directly. */
  entry: ArcChangesetEntry;
  /** The owning project's directory — what a bind has to name. */
  projectDir: string;
  /**
   * The key this project's join traffic is addressed by.
   *
   * Distinct from {@link projectDir} on purpose ([L29]): the join store is
   * written under the `project_dir` a *request* echoed back, and every send on
   * that path carries the workspace key. Reading beats under the root's
   * spelling is a subscription to a cell nothing writes.
   */
  workspaceKey: string;
  /** The owning project's name, for Bind's refusal sentence. */
  projectLabel: string;
}

function rowFromEntry(
  entry: ArcChangesetEntry,
  project: ProjectChangeset,
): ArcRow {
  return {
    ownerId: entry.owner_id,
    entry,
    projectDir: project.project_dir,
    workspaceKey: project.workspace_key,
    projectLabel: project.display_name,
  };
}

/** The stage table the order reads ([P02], Table T01) — re-exported so the
 *  card's table test keeps its address. The table lives in `lib/arc-order`. */
export { ARC_STAGE_RANK } from "@/lib/arc-order";

/**
 * The section's total order: stage rank descending, then freshest first, then
 * by name — {@link compareArcEntries} over the rows' entries. The Changes
 * shade's arc lane sorts its unbound arcs with the same function, so the two
 * surfaces cannot drift apart.
 */
export function compareArcRows(a: ArcRow, b: ArcRow): number {
  return compareArcEntries(a.entry, b.entry);
}

/**
 * Every arc across every open project, in every state, ordered by
 * {@link compareArcRows}. No filter: bound and unbound alike are this
 * section's rows now, and which register a row wears is the eyebrow's
 * business, not membership's.
 *
 * Project grouping is not an ordering key: grouping by project would bury a
 * arc that is one gesture from landing under one created a week ago in
 * another repo.
 *
 * One row per owner key: two projects opening one repository — a base checkout
 * and its spelling through a firmlink — both carry the repo's arcs, and the
 * owner key is the identity that says they are the same arc. First occurrence
 * in snapshot order wins, before the sort, so which project's row survives is
 * stable across renders.
 */
export function arcRowsFromSnapshot(
  snapshot: WorkspacesChangesetSnapshot,
): ArcRow[] {
  const seen = new Set<string>();
  const rows = snapshot.projects
    .flatMap((project) =>
      project.changesets
        .filter((entry): entry is ArcChangesetEntry => entry.kind === "arc")
        .map((entry) => rowFromEntry(entry, project)),
    )
    .filter((row) => {
      if (seen.has(row.ownerId)) return false;
      seen.add(row.ownerId);
      return true;
    });
  // `filter` already allocated this array; the snapshot it was projected from
  // is never touched.
  return rows.sort(compareArcRows);
}

/**
 * One plan document waiting in a project's docs directory — the front half of
 * the arc, which was invisible to every surface until now.
 *
 * A plan row is waiting paperwork **by filter, not by construction**. Presence
 * in the docs directory says nothing about ownership: adoption leaves a
 * committed, clean base copy exactly where it was, so a plan an arc is
 * implementing right now sits there for the arc's whole life with its ledger
 * frozen at all-`pending` — the run's progress goes to the worktree copy. What
 * keeps the two kinds of row from naming the same work is the producer, which
 * lists a document only when no arc has adopted it and its ledger is not
 * wholly `done`.
 */
export interface DocumentArcRow {
  /** Project dir plus arc name — unique across every open project. */
  key: string;
  /** The wire entry: the row reads it directly. */
  entry: DocumentArcEntry;
}

/** Nearest-to-work-starting first: a reviewed plan is one gesture from an arc. */
const PLAN_REVIEW_RANK: Record<string, number> = {
  reviewed: 2,
  stale: 1,
  "never-reviewed": 0,
};

/** An unrecognized review spelling — or none at all — sorts last. */
function reviewRank(review: string): number {
  return PLAN_REVIEW_RANK[review] ?? -1;
}

/** Work already on the ledger — done or in progress. */
export function documentArcIsBegun(entry: DocumentArcEntry): boolean {
  return entry.steps_begun > 0;
}

/**
 * The plan rows' total order: begun first, then review rank descending, then
 * by name.
 *
 * The same nearest-to-done principle {@link compareArcRows} encodes, applied
 * to the front half: work in flight is nearer done than work not started, and
 * among the unstarted a reviewed plan is one press from becoming an arc while
 * an unreviewed one still needs a turn spent on it.
 */
export function compareDocumentArcRows(
  a: DocumentArcRow,
  b: DocumentArcRow,
): number {
  const byBegun =
    Number(documentArcIsBegun(b.entry)) - Number(documentArcIsBegun(a.entry));
  if (byBegun !== 0) return byBegun;
  const byReview =
    reviewRank(b.entry.review ?? "") - reviewRank(a.entry.review ?? "");
  if (byReview !== 0) return byReview;
  return a.entry.display_name.localeCompare(b.entry.display_name);
}

/**
 * Every waiting plan document across every open project, ordered by
 * {@link comparePlanRows}.
 *
 * Every project, not the followed one — the same choice
 * {@link arcRowsFromSnapshot} makes, for the same reason: a listing that
 * changed as the reader moved between cards would be the coming-and-going wart
 * this section already retired.
 *
 * One row per `owner_id`, exactly as {@link arcRowsFromSnapshot} dedupes —
 * and never on `key`, which namespaces the name under its project and so
 * differs between the very duplicates being removed. First occurrence in
 * snapshot order wins.
 */
export function documentArcRowsFromSnapshot(
  snapshot: WorkspacesChangesetSnapshot,
): DocumentArcRow[] {
  const seen = new Set<string>();
  const rows = snapshot.projects
    .flatMap((project) =>
      (project.document_arcs ?? []).map((entry) => ({
        key: `${project.project_dir}:${entry.display_name}`,
        entry,
      })),
    )
    .filter((row) => {
      if (seen.has(row.entry.owner_id)) return false;
      seen.add(row.entry.owner_id);
      return true;
    });
  return rows.sort(compareDocumentArcRows);
}

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------

/**
 * A flat, immutable list over one projection pass, carrying both kinds of row.
 * A new projection makes a new source; there is no mutation to subscribe to.
 *
 * Arcs first, then plans: live work outranks waiting paperwork, so the index
 * split is the ordering — no interleaving and no comparator across kinds.
 *
 * The expansion bit rides here too, because it is the host's: the set
 * of expanded arcs and the toggle that moves it are `ArcsBody`'s, and this
 * source is how a cell reaches them. A new `expanded` set makes a new source,
 * which is exactly the version the list needs to re-render the row that grew.
 */
class CockpitRowsDataSource implements TugListViewDataSource {
  constructor(
    readonly rows: readonly ArcRow[],
    readonly plans: readonly DocumentArcRow[],
    /** The owner keys whose steps are showing. */
    readonly expanded: ReadonlySet<string>,
    /** Flip one arc's bit, by the same owner key the rows are identified by. */
    readonly toggle: (ownerId: string) => void,
  ) {}
  numberOfItems(): number {
    return this.rows.length + this.plans.length;
  }
  idForIndex(index: number): string {
    const arc = this.rows[index];
    if (arc !== undefined) return arc.ownerId;
    // Namespaced so an owner key and a document-arc key can never collide.
    return `doc:${this.plans[index - this.rows.length]!.key}`;
  }
  kindForIndex(index: number): string {
    return index < this.rows.length ? "arc" : "plan";
  }
  /** The document-only arc at a list index, or undefined for an arc index. */
  planAt(index: number): DocumentArcRow | undefined {
    return this.plans[index - this.rows.length];
  }
  subscribe(): () => void {
    return () => {};
  }
  getVersion(): unknown {
    // The source itself: one instance per projection pass, so identity is
    // exactly the version the list needs.
    return this;
  }
}

// ---------------------------------------------------------------------------
// The verbs
// ---------------------------------------------------------------------------

/** Where a Bind press would send this arc, or why it cannot. Exactly one of
 *  the two is non-null. */
export interface BindTarget {
  tugSessionId: string | null;
  reason: string | null;
}

/**
 * Resolve Bind's target from the Arcs card's followed card (Table T01) — pure, so
 * its whole truth table is a unit test rather than a DOM one.
 *
 * The ladder stops at the followed card deliberately. Reaching past it to some
 * other open card would make Bind succeed more often at the cost of making its
 * destination invisible: a press could bind an arc into a card the reader was
 * not looking at. Every refusal names what is missing, because a control that
 * declines without saying why is the failure this section already had.
 */
export function resolveBindTarget(input: {
  followedCardId: string | null;
  binding: { tugSessionId: string; projectDir: string } | undefined;
  projectDir: string;
  projectLabel: string;
}): BindTarget {
  if (input.followedCardId === null) {
    return { tugSessionId: null, reason: "Focus a session card to bind this arc" };
  }
  if (input.binding === undefined) {
    return { tugSessionId: null, reason: "The focused card has no session" };
  }
  // An arc can only be bound by a session in its own project — the bind names a
  // project dir, and the server resolves the arc within it.
  if (input.binding.projectDir !== input.projectDir) {
    return {
      tugSessionId: null,
      reason: `This arc belongs to ${input.projectLabel}`,
    };
  }
  return { tugSessionId: input.binding.tugSessionId, reason: null };
}

/**
 * The open card working this arc, or null — the destination a row activation
 * routes to.
 *
 * Pure, so its whole truth table is a unit test rather than a DOM one. First
 * match wins: `bound_sessions` is live sessions mated to the arc, and a card
 * bound to one of them is a card whose Changes shade shows this arc's lane. In
 * the ordinary case there is exactly one; where there are several, any of them
 * is a correct room to open, and picking the first keeps the answer stable
 * across renders rather than depending on iteration luck.
 *
 * Null is the common case, not an error: the Arcs card lists every arc in every
 * open project, so an arc nobody holds — or one whose worker's card is closed —
 * simply has no room to open. That is what makes the row inert, and what the
 * row's own affordance has to advertise.
 */
export function resolveWorkerCard(
  boundSessions: readonly string[],
  bindings: ReadonlyMap<string, { tugSessionId: string }>,
): string | null {
  if (boundSessions.length === 0) return null;
  const held = new Set(boundSessions);
  for (const [cardId, binding] of bindings) {
    if (held.has(binding.tugSessionId)) return cardId;
  }
  return null;
}

/** {@link resolveWorkerCard} against the live binding snapshot. */
function useWorkerCard(entry: ArcChangesetEntry): string | null {
  const bindings = useSyncExternalStore(
    cardSessionBindingStore.subscribe,
    cardSessionBindingStore.getSnapshot,
  );
  return resolveWorkerCard(entry.bound_sessions ?? [], bindings);
}

/**
 * The tug session of the card the Arcs card is following, or null.
 *
 * Where this section's answers go. Bind's target is narrower — it refuses a
 * card in another project — but a replay's outcome has to reach a reader even
 * when a bind from the same row would be refused, so the notice is aimed at the
 * followed card itself rather than at Bind's resolved target.
 */
function useFollowedSessionId(): string | null {
  const followedCardId = useFollowedCard();
  const bindings = useSyncExternalStore(
    cardSessionBindingStore.subscribe,
    cardSessionBindingStore.getSnapshot,
  );
  if (followedCardId === null) return null;
  return bindings.get(followedCardId)?.tugSessionId ?? null;
}

/** {@link resolveBindTarget} against the live followed card and its binding. */
function useBindTarget(row: ArcRow): BindTarget {
  const followedCardId = useFollowedCard();
  const bindings = useSyncExternalStore(
    cardSessionBindingStore.subscribe,
    cardSessionBindingStore.getSnapshot,
  );
  const binding =
    followedCardId !== null ? bindings.get(followedCardId) : undefined;
  return resolveBindTarget({
    followedCardId,
    binding,
    projectDir: row.projectDir,
    projectLabel: row.projectLabel,
  });
}

/** What a row may ask of the section around it. */
interface ArcVerbs {
  requestDiscard: (row: ArcRow, anchor: HTMLElement | null) => void;
  /** Send `changeset_replay`; the outcome speaks on the followed card. */
  requestReplay: (row: ArcRow, tugSessionId: string | null) => void;
  /** Why every Replay in this section is unavailable right now, or null. */
  replayDisabledReason: string | null;
}

const ArcVerbsContext = React.createContext<ArcVerbs | null>(null);

/**
 * The row's rare verbs, on the row's own right-click — the same set the Changes
 * shade's arc lane offers, composed from the same hook ({@link useArcRowMenu}).
 *
 * They used to stand here as Bind and Discard text buttons, then behind a `⋯`
 * on the eyebrow. Both spent the eyebrow's right end on verbs a reader almost
 * never presses: an arc is bound once, discarded almost never, and replayed
 * only when the automatic engine's gates have skipped it. The eyebrow is now
 * the identities alone — the arc, the hairline, the worker — and the verbs are
 * where a list row's rare verbs live everywhere else in the app, under the
 * pointer's second button.
 *
 * Bind's refusals arrive here as the item's own disabled reason, verbatim from
 * {@link resolveBindTarget} ([L31]). Unbind is deliberately absent: it stays the
 * fronted shade row's verb, and an Arcs card row routes you there.
 *
 * The press reports **nothing locally** for a bind: on success the worker's atom
 * arrives on the eyebrow, so a pending state would be reporting into a control
 * that is about to leave. A server-side refusal arrives on the card-level
 * `arc-bind-error-store` surface, which outlives the row — and a replay's
 * outcome on its sibling, for the same reason.
 */
function useArcRowVerbsMenu(row: ArcRow): {
  onContextMenu: (event: React.MouseEvent) => void;
  menu: React.ReactNode;
} {
  const verbs = React.useContext(ArcVerbsContext);
  const target = useBindTarget(row);
  const followedSessionId = useFollowedSessionId();
  const entry = row.entry;
  const name = entry.display_name;
  const bound = (entry.bound_sessions ?? []).length > 0;
  const rowRef = React.useRef<HTMLElement | null>(null);

  const rowMenu = useArcRowMenu({
    // Bind only, and only while nobody holds the arc: Unbind belongs to the
    // shade, and a bound row's binding item would offer a verb this surface
    // has decided not to carry.
    binding: bound
      ? null
      : {
          bound: false,
          disabledReason: target.reason,
          perform: () => {
            if (target.tugSessionId === null) return;
            // The same frame the Changes shade's lane sends, so there is one
            // binding path. `bind_arc_ok` stays the only mover of
            // `cardSessionBindingStore`: a refused bind leaves the card bound
            // to whatever it was.
            getConnection()?.sendControlFrame("bind_arc", {
              tug_session_id: target.tugSessionId,
              project_dir: row.projectDir,
              arc: name,
            });
          },
        },
    discard:
      verbs === null
        ? null
        : {
            disabledReason: null,
            // The anchor is the ROW cell, never the menu item: the confirm
            // outlives the press, and the menu unmounts on selection, so a
            // popover anchored to the item would be destroyed as it opened.
            perform: () =>
              verbs.requestDiscard(
                row,
                rowRef.current?.closest(
                  ".tug-list-view-cell",
                ) as HTMLElement | null,
              ),
          },
    replay:
      verbs === null
        ? null
        : {
            label: `Replay onto ${entry.base}`,
            disabledReason:
              verbs.replayDisabledReason ?? replayDisabledReason(entry),
            // The outcome reports on the followed card — the same card a Bind
            // from this row aims at, so the section's two verbs answer in one
            // place rather than sending the reader hunting.
            perform: () => verbs.requestReplay(row, followedSessionId),
          },
  });

  const onContextMenu = React.useCallback(
    (event: React.MouseEvent): void => {
      if (rowMenu.menu === null) return;
      event.preventDefault();
      event.stopPropagation();
      rowRef.current = event.currentTarget as HTMLElement;
      rowMenu.openMenuAt(event.clientX, event.clientY);
    },
    [rowMenu],
  );

  return {
    onContextMenu,
    menu:
      rowMenu.menu === null ? null : (
        <span
          className="arcs-verbs"
          data-slot="arcs-verbs"
          aria-label={`Actions for arc ${name}`}
        >
          {rowMenu.menu}
        </span>
      ),
  };
}

// ---------------------------------------------------------------------------
// The block
// ---------------------------------------------------------------------------

const ArcCell: TugListViewCellRenderer<CockpitRowsDataSource> = ({
  index,
  dataSource,
}: TugListViewCellProps<CockpitRowsDataSource>) => {
  const row = dataSource.rows[index];
  if (row === undefined) return null;
  const entry = row.entry;
  const workers = entry.bound_sessions ?? [];
  // What a click on this row would do — and therefore what the row is allowed
  // to look like. A row with no open worker card has no room to open, and a
  // dead click on something that presented as live is the failure this
  // attribute exists to prevent ([L06]: the pointer and hover treatment are
  // CSS on this bit, never React state). An inert row never invited the press,
  // so it owes no refusal.
  const activatable = useWorkerCard(entry) !== null;
  const model = arcTrackModelFromEntry(entry);
  // The ledger the row can fold open to, and whether it is open. An arc with a
  // brief alone — or one still being devised — carries no steps, and a row with
  // nothing to fold draws no cue at all: a disabled chevron would be a promise
  // about a future the row does not know it has.
  const steps = entry.steps ?? [];
  const expanded = dataSource.expanded.has(row.ownerId);
  // Bind / Discard / Replay, on the row's second button — the eyebrow carries
  // no opener of its own any more.
  const verbsMenu = useArcRowVerbsMenu(row);
  return (
    <TugListRow
      className="arcs-row"
      variant="flush"
      density="compact"
      data-slot="arcs-row"
      data-arc={entry.display_name}
      data-bound={workers.length > 0 ? "true" : undefined}
      data-activatable={activatable ? "true" : undefined}
      onContextMenu={verbsMenu.onContextMenu}
    >
      <span className="arcs-block">
        {/* The arc's whole life in the one block: line one the identities,
            line two the track, the phase glyph, the fraction, the word, and
            the divergence facts. The pill wears no review tint — that yellow
            means WAITING, and an arc is not waiting for anyone.

            Every row answers the same menu, held or not: Replay reaches a
            bound arc on the same terms as an unbound one, and a menu that
            came and went with the binding would be the section's old wart in
            miniature. */}
        <ArcLifecycleBlock
          name={entry.display_name}
          workers={workers}
          model={model}
          note={arcLifecycleNote(model)}
          stepTitle={entry.step_title ?? null}
          facts={arcMetaFacts(entry)}
          size="read"
          trailing={
            steps.length > 0 ? (
              // The tool-call header's own cue, in the slot the block reserved
              // for it: same icon pair, same `xs` icon-only shape, and the
              // default scroll stabilization, because this list scrolls exactly
              // as the transcript does. No `stopPropagation` and no selection
              // guard — the list excuses any descendant that refuses focus, so
              // a press here never picks the row.
              <BlockFoldCue
                collapsed={!expanded}
                onToggle={() => dataSource.toggle(row.ownerId)}
                collapsedLabel="Expand"
                expandedLabel="Collapse"
                ariaLabelExpand={`Expand steps for arc ${entry.display_name}`}
                ariaLabelCollapse={`Collapse steps for arc ${entry.display_name}`}
                size="xs"
                subtype="icon"
                data-slot="arcs-steps-fold"
              />
            ) : undefined
          }
        />
        {verbsMenu.menu}
        {/* And what its JOIN is doing, in the one shared register — the same
            sentence the shade and the composer show, because all three call
            one derivation. Renders nothing until there is a join. */}
        <ArcJoinRow row={row} />
        {/* And, folded open, the plan's own ledger — the same component the
            `ARC` placard mounts, so the row and the placard cannot disagree
            about one arc's steps. Structure rather than appearance: the rows
            mount while open and unmount when folded, so an arc nobody has
            opened costs no ledger DOM at all. */}
        {expanded && steps.length > 0 ? (
          <span className="arcs-steps" data-slot="arcs-steps">
            <ArcStepItems steps={steps} idle={entry.holders_busy !== true} />
          </span>
        ) : null}
      </span>
    </TugListRow>
  );
};

/**
 * The arc's join register, with the beats its own store read supplies.
 *
 * A separate component so the `useSyncExternalStore` subscription belongs to
 * the row that needs it ([L02]) rather than re-rendering every row in the
 * section on every beat of one arc's join.
 */
function ArcJoinRow({ row }: { row: ArcRow }): React.ReactElement | null {
  const entry = row.entry;
  const landBeat = useChangesetJoinLand(row.workspaceKey, entry.display_name);
  return (
    <span className="arcs-register">
      <ArcJoinRegister
        arc={entry.display_name}
        base={entry.base ?? "main"}
        stage={entry.stage}
        join={entry.join}
        holdersBusy={entry.holders_busy === true}
        landBeat={landBeat}
        // The Arcs card is the one surface that renders arcs nobody is holding,
        // so it is the one that has to hand the register that fact ([D147]).
        bound={(entry.bound_sessions ?? []).length > 0}
        // A live wheel outranks the offer: the section shows the stage that is
        // running rather than a readiness the audit has not signed off on.
        run={entry.arc ?? null}
        altitude="section"
      />
    </span>
  );
}

/**
 * A waiting plan document, in the section's own two-line grammar: an eyebrow
 * naming the document and carrying its one affordance, over a meta line saying
 * what it is and how far it goes.
 *
 * The affordance is an explicit control, never row activation ([D142]): a plan
 * row has no room to open, and pressing anywhere on it must not submit a
 * prompt. Its label is the next gesture — Resume for a plan with work already
 * on its ledger, Review for a plan nothing vouches for, Implement for one a
 * review covers — and a press that cannot land is disabled wearing the
 * ladder's own sentence ([L31]).
 */
const PlanCell: TugListViewCellRenderer<CockpitRowsDataSource> = ({
  index,
  dataSource,
}: TugListViewCellProps<CockpitRowsDataSource>) => {
  const row = dataSource.planAt(index);
  if (row === undefined) return null;
  const entry = row.entry;
  const begun = documentArcIsBegun(entry);
  // The counted steps, never the composed ones: `arcTrackModelFromEntry` over
  // the adapted entry would find no `steps` at all and read `review` for a
  // plan already half walked.
  const model = documentArcTrackModel(entry);
  return (
    <TugListRow
      className="arcs-row"
      variant="flush"
      density="compact"
      data-slot="arc-document-row"
      data-arc={entry.display_name}
      data-review={entry.review}
      data-begun={begun ? "true" : "false"}
    >
      <span className="arcs-block">
        <ArcLifecycleBlock
          name={entry.display_name}
          workers={entry.bound_sessions ?? []}
          model={model}
          note={arcLifecycleNote(model)}
          facts={arcMetaFacts(documentArcAsEntry(entry))}
          size="read"
        />
      </span>
    </TugListRow>
  );
};

const ARC_CELL_RENDERERS = { arc: ArcCell, plan: PlanCell };

function useArcRows(): ArcRow[] {
  const snapshot = useChangesetAll();
  return useMemo(() => arcRowsFromSnapshot(snapshot), [snapshot]);
}

function usePlanRows(): DocumentArcRow[] {
  const snapshot = useChangesetAll();
  return useMemo(() => documentArcRowsFromSnapshot(snapshot), [snapshot]);
}

/**
 * The card's verb round trips, keyed by the card rather than by row: one
 * discard and one replay at a time is the right number, and the state lives in
 * a module store that outlives this body.
 */
const ARCS_VERB_KEY = "arcs-card";

export interface ArcsContentProps {
  /** The Arcs card's id. */
  cardId: string;
}

export function ArcsContent({ cardId }: ArcsContentProps): React.ReactElement {
  // The card this one is contextually about — tracked once here, mounted the
  // whole time the pane is open, and published so every reader inside agrees
  // ([P11]).
  const followedCardId = useTrackFollowedCard(cardId);
  return (
    <FollowedCardContext value={followedCardId}>
      <ArcsBody />
    </FollowedCardContext>
  );
}

function ArcsBody(): React.ReactElement {
  const rows = useArcRows();
  const plans = usePlanRows();
  // Which arcs are showing their steps. Card-local view scope: closing the
  // card forgets every fold, which is the right lifetime for a reading. The
  // set is keyed by the arc's owner key — the same key the list identifies its
  // cells by — and it lives up here rather than in the cell because a cell
  // recycled by virtualization, or replaced when a changeset beat recomputes
  // the snapshot, would drop a bit held inside it, and a rail card that
  // re-projects on every beat would be a row folding itself shut while you
  // read it.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const toggle = useCallback((ownerId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(ownerId)) next.add(ownerId);
      return next;
    });
  }, []);
  const dataSource = useMemo(
    () => new CockpitRowsDataSource(rows, plans, expanded, toggle),
    [rows, plans, expanded, toggle],
  );
  // Both kinds, not the arc count. This one value decides two things — whether
  // the keyboard has anything to walk onto, and whether the body is the empty
  // state — so a project with plans and no arcs would otherwise render
  // "No arcs" over rows that never mounted.
  const populated = rows.length + plans.length > 0;

  const discardVerb = useChangesetDiscard(ARCS_VERB_KEY);
  // One replay round trip for the section, for the reason the discard has one:
  // the state is a slot per key, and a second press would render the first's
  // phase.
  const replayVerb = useChangesetReplay(ARCS_VERB_KEY);
  // Which row's discard is armed, and the element the confirm hangs off. View
  // scope ([L24]): a half-armed confirm is not worth remembering, and closing
  // the card forgets it.
  const [pendingDiscard, setPendingDiscard] = useState<{
    row: ArcRow;
    anchor: HTMLElement | null;
  } | null>(null);
  const verbs = useMemo<ArcVerbs>(
    () => ({
      requestDiscard: (row, anchor) => setPendingDiscard({ row, anchor }),
      // No confirm: a replay destroys nothing, and its every refusal path
      // leaves the repository exactly as it found it. What it needs instead is
      // a voice, which is the session id — the outcome posts on that card's
      // pane bulletin, and nothing else on any surface reports a replay at
      // all. The card the user is working in is the first choice; a card that
      // is following nothing falls back to the session working the arc,
      // which is the other card this outcome is about.
      requestReplay: (row, tugSessionId) => {
        const voice = tugSessionId ?? (row.entry.bound_sessions ?? [])[0] ?? null;
        replayVerb.replay(
          row.workspaceKey,
          row.entry.display_name,
          voice ?? undefined,
        );
      },
      replayDisabledReason:
        replayVerb.phase === "pending" ? "A replay is in flight" : null,
    }),
    [replayVerb],
  );

  // The opening key view lands on a real row, never on emptiness: an empty list
  // is not a focus stop, and `useSeedKeyView` re-arms while the key is null, so
  // the first arc to arrive takes the cursor ([P02]).
  useSeedKeyView(populated ? `${ARCS_FOCUS_GROUP}:0` : null);

  // Activation opens the arc's ROOM: it fronts the card working the arc and
  // reveals that card's Changes shade, which is where every decision about a
  // arc already lives ([D152]). Navigation, never a verb — the mutating acts
  // stay on the row's context menu, because status is not a control ([D142]).
  //
  // Click and Enter are the same act here, unlike the Cards card's split:
  // there, a click both selects and fronts, so the two doors differ. An arc row
  // has one destination and no second meaning to give the keyboard.
  //
  // A row with no open worker card does nothing — and says so before the press
  // rather than after, through the row's own activatable attribute.
  const chain = useResponderChain();
  const delegate = useMemo<TugListViewDelegate>(() => {
    const activate = (index: number): void => {
      const row = dataSource.rows[index];
      if (row === undefined) return;
      const cardId = resolveWorkerCard(
        row.entry.bound_sessions ?? [],
        cardSessionBindingStore.getSnapshot(),
      );
      if (cardId === null) return;
      // The card-content scope, not the bare card id: `sendToTarget` walks
      // upward from its target, the bare id is `card-host`'s, and the session
      // card's handlers live one scope beneath it — a miss there fails
      // silently. The guard doubles as the liveness check, since only a
      // mounted session card registers this responder.
      const target = `${cardId}-card-content`;
      if (chain === null || !chain.hasResponder(target)) return;
      dispatchCommand("focus-session-card", { cardId });
      chain.sendToTarget(target, {
        action: TUG_ACTIONS.REVEAL_CHANGES,
        phase: "discrete",
      });
    };
    return { onSelect: activate, onActivate: activate };
  }, [chain, dataSource]);

  // The empty state keeps the card, reading exactly as every other rail card's
  // does: the shared word, centered, on one row's worth of height.
  // An arc starts in a session card, so there is nothing to press here and no
  // way in to name — the card is a fixed address to glance at, not a door.
  if (!populated) {
    return (
      <div className="arcs-empty" data-slot="arcs-empty">
        None
      </div>
    );
  }

  return (
    <ArcVerbsContext value={verbs}>
      <div className="arcs-section" data-slot="arcs-section">
        <TugListView<CockpitRowsDataSource>
          dataSource={dataSource}
          delegate={delegate}
          cellRenderers={ARC_CELL_RENDERERS}
          scrollKey="dashes"
          inline
          rowLayout="flush"
          focusGroup={ARCS_FOCUS_GROUP}
          {...RAIL_LIST_PRESENTATION}
          className="arcs-list"
        />
        {/* One controlled confirm for the whole card, anchored to whichever
            row armed it. `confirmRole="danger"` puts default focus on Cancel,
            so a reflexive Return can never destroy an arc. */}
        <TugConfirmPopover
          open={pendingDiscard !== null}
          anchorEl={pendingDiscard?.anchor ?? null}
          message={
            pendingDiscard !== null
              ? `Discard ${pendingDiscard.row.entry.display_name}? Its branch and worktree go with it, and any uncommitted work in the worktree is handed back to the base checkout.`
              : ""
          }
          confirmLabel="Discard"
          confirmRole="danger"
          side="top"
          onConfirm={() => {
            const armed = pendingDiscard;
            setPendingDiscard(null);
            if (armed !== null) {
              discardVerb.discard(
                armed.row.projectDir,
                armed.row.entry.display_name,
              );
            }
          }}
          onCancel={() => setPendingDiscard(null)}
        />
      </div>
    </ArcVerbsContext>
  );
}
