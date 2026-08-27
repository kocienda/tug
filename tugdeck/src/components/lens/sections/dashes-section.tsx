/**
 * dashes-section.tsx — the Lens **Dashes** section: every dash in every open
 * project, in every state, always on.
 *
 * The section is a fixed address. It used to show only unbound dashes and to
 * vanish entirely at zero — and the coming and going was the wart: no other
 * Lens section works like that, and a section with no fixed place cannot be
 * glanced at. Now the band is always there, every dash is a row, and the
 * empty state is one quiet line that costs ~24px and buys the section its
 * address.
 *
 * Each dash is a two-line block in one grammar, the same grammar the Changes
 * shade's collapsed dash row wears:
 *
 *   [^dash-atom] ──────────────────────── [worker atom] ⋯
 *     track · fraction · note · divergence
 *
 * Every row is one `DashLifecycleBlock`, the grammar every dash surface wears.
 * Its EYEBROW holds the identities and the row's own trailing control: the
 * dash atom at the left, the hairline, the "who" at the right — each bound
 * worker as a mini atom (no callsign, no dash run: the row already names
 * both). The dash pill wears no review tint here: that yellow is the WAITING
 * color, and a dash is not waiting for anyone. Beneath it, the lifecycle line
 * carries everything the dash is DOING.
 *
 * A dash with no branch yet — a brief being written, a plan being devised or
 * reviewed — is the SAME block, over `documentDashAsEntry`, with its track
 * model from `documentDashTrackModel` so a plan already under way reads
 * `implement` with the ledger's own counts. Its trailing control is the next
 * gesture rather than the row menu; the two never share an eyebrow.
 *
 * The Lens is the account-global surface and `ChangesetAllStore` is the
 * account-global snapshot it already reads, so this section is a projection
 * and nothing more. Rows key on the dash's **owner key**, which makes two
 * incarnations of a reused name distinct for free.
 *
 * The verbs live behind the `⋯`, composed from the Changes shade's own
 * {@link useDashRowMenu} so the two dash-row surfaces speak one grammar. Bind
 * mates an unbound dash to the Lens's followed card, or carries its refusal in
 * the item's own label ([L31]); Discard destroys it behind a confirm anchored
 * to the row element; Replay moves the dash's rounds onto a base that has
 * advanced, on the same terms for every row. None is on row activation ([D142]).
 *
 * Both destructive verbs destroy the surface they are pressed on — the success
 * path, not an edge case — so Bind reports nothing locally: a refusal arrives on
 * the card-level bind-error surface, which outlives the row, and a replay's
 * outcome on its sibling. Unbind is not here at all: it stays the fronted shade
 * row's verb, and a bound row's job is to route you to that shade.
 *
 * Rows are totally ordered: nearest-to-done first, then freshest first, then
 * by name. Stage leads because a `draft-ready` dash is one gesture from
 * landing; freshness is the tiebreak a person actually wants; name is the
 * final tiebreak rather than snapshot order, which is git-enumeration order.
 *
 * Beneath the dashes the section lists the **waiting paperwork**: plan
 * documents sitting in each project's configured docs directory, which the
 * aggregate now carries. The back half of the arc was already machine-visible —
 * a dash reads `implementing (i/N)`, the join arms itself, the shade summons —
 * while the front half was a file only `ls` could find. A plan row is the same
 * two-line block one tone quieter, and its trailing button is its next gesture:
 * Review for a plan nothing vouches for, Implement for one a review covers.
 *
 * That button, like every affordance this section grows, **produces a prompt**.
 * It submits a `/tugplug:…` line into the followed card's session and fronts
 * that card; it never calls machinery. `tugutil` is the engine's tool and the
 * models', so a graphical control that ran one would be doing the machine's job
 * behind the reader's back — and the model, not this surface, is what runs the
 * arc. The templates and the target ladder live in `lib/dash-prompts.ts`.
 *
 * Live work outranks waiting paperwork, so dashes come first and plans follow;
 * plans are listed for every open project, exactly as dashes are, and a plan
 * whose project is not the followed one wears its refusal on its own button.
 *
 * The section's `kind` stays `"dashes"` whatever the title says: the kind is
 * the registry key that `sectionOrder` and `collapsedSections` persist under
 * in tugbank, so renaming it would silently reset every saved Lens order.
 * The title is what a person reads, and the title is what moved.
 *
 * Laws: [L02] the aggregate enters React through `useSyncExternalStore`;
 * [L03] the section's content declaration is a `useLayoutEffect`; [L06] tones
 * are CSS on DOM attributes, never React state; [L19] rows compose
 * `TugListView` / `TugListRow` rather than hand-rolling list focus; [L20] the
 * blocks compose `DashLifecycleBlock`, which owns the atom, the workers, and
 * the line.
 *
 * @module components/lens/sections/dashes-section
 */

import "./dashes-section.css";

import React, {
  useLayoutEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import { EllipsisVertical, GitBranch } from "lucide-react";

import { LENS_LIST_PRESENTATION } from "@/components/lens/lens-list-presentation";
import { setSectionContent } from "@/components/lens/lens-section-content";
import { DashLifecycleBlock } from "@/components/tugways/dash-lifecycle-block";
import { dashLifecycleNote } from "@/components/tugways/dash-lifecycle-line";
import { dashTrackModelFromEntry } from "@/components/tugways/tug-dash-track";
import { dashMetaFacts } from "@/lib/dash-meta-facts";
import {
  documentDashAsEntry,
  documentDashTrackModel,
} from "@/lib/document-dash-entry";
import { DashJoinRegister } from "@/components/tugways/dash-join-register";
import { useChangesetJoinLand } from "@/lib/changeset-join-store";
import { registerLensSection } from "@/components/lens/lens-section-registry";
import type { LensSectionHost } from "@/components/lens/lens-section-registry";
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
import { useLensFollowedCard } from "@/components/lens/lens-followed-card";
import { useResponderChain } from "@/components/tugways/responder-chain-provider";
import { TUG_ACTIONS } from "@/components/tugways/action-vocabulary";
import { dispatchCommand } from "@/command-dispatch";
import { cardSessionBindingStore } from "@/lib/card-session-binding-store";
import { usePromptTarget } from "./dash-prompt-target";
import {
  documentDashNextGestureLabel,
  documentDashNextGesturePrompt,
  submitPromptToCard,
} from "@/lib/dash-prompts";
import { getConnection } from "@/lib/connection-singleton";
import { useChangesetAll } from "@/lib/changeset-all-store";
import { useChangesetDiscard, useChangesetReplay } from "@/lib/changeset-verb-store";
import {
  replayDisabledReason,
  useDashRowMenu,
} from "@/components/tugways/cards/session-changes/dash-row-menu";
import type {
  DashChangesetEntry,
  DocumentDashEntry,
  ProjectChangeset,
  WorkspacesChangesetSnapshot,
} from "@/lib/changeset-types";

const SECTION_KIND = "dashes";

/** A stable subscribe for a card that has no session store yet ([L02]). */
const NOOP_SUBSCRIBE = (): (() => void) => () => {};

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

/** One dash, in any state, flattened out of the aggregate for the list. */
export interface DashRow {
  /** The dash's owner key — this row's identity, unique per incarnation. */
  ownerId: string;
  /** The whole wire entry: the eyebrow and the meta line read it directly. */
  entry: DashChangesetEntry;
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
  entry: DashChangesetEntry,
  project: ProjectChangeset,
): DashRow {
  return {
    ownerId: entry.owner_id,
    entry,
    projectDir: project.project_dir,
    workspaceKey: project.workspace_key,
    projectLabel: project.display_name,
  };
}

/**
 * How far along a dash is, as a sortable rank ([P02], Table T01).
 *
 * Nearest-to-done ranks highest, because the actionable dash is the one about
 * to land rather than the one just created. `joining` tops the table because
 * it is the state that most needs a person. Exported so its test can be a
 * table test rather than a DOM assertion.
 */
export const DASH_STAGE_RANK: Record<string, number> = {
  joining: 6,
  "draft-ready": 5,
  audited: 4,
  built: 3,
  implementing: 2,
  working: 1,
  created: 0,
};

/** An absent or unrecognized stage sorts last, and never throws: an older or
 *  newer sender must not be able to break the section's render. */
function stageRank(stage: string | null | undefined): number {
  return stage == null ? -1 : (DASH_STAGE_RANK[stage] ?? -1);
}

/**
 * Two ISO-8601 UTC instants, newest first, with absent sorting **last**.
 *
 * A raw string comparison is the whole implementation: the timestamps are UTC
 * with a fixed-width layout, so lexical order is chronological order and no
 * `Date` is ever parsed here. Absent-last keeps dashes created before creation
 * wrote a birth record from claiming the top of every stage band.
 */
function compareIsoDesc(
  a: string | null | undefined,
  b: string | null | undefined,
): number {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return b.localeCompare(a);
}

/**
 * The section's total order: stage rank descending, then freshest first, then
 * by name.
 */
export function compareDashRows(a: DashRow, b: DashRow): number {
  const byStage = stageRank(b.entry.stage) - stageRank(a.entry.stage);
  if (byStage !== 0) return byStage;
  const byAge = compareIsoDesc(a.entry.last_activity, b.entry.last_activity);
  if (byAge !== 0) return byAge;
  return a.entry.display_name.localeCompare(b.entry.display_name);
}

/**
 * Every dash across every open project, in every state, ordered by
 * {@link compareDashRows}. No filter: bound and unbound alike are this
 * section's rows now, and which register a row wears is the eyebrow's
 * business, not membership's.
 *
 * Project grouping is not an ordering key: grouping by project would bury a
 * dash that is one gesture from landing under one created a week ago in
 * another repo.
 */
export function dashRowsFromSnapshot(
  snapshot: WorkspacesChangesetSnapshot,
): DashRow[] {
  const rows = snapshot.projects.flatMap((project) =>
    project.changesets
      .filter((entry): entry is DashChangesetEntry => entry.kind === "dash")
      .map((entry) => rowFromEntry(entry, project)),
  );
  // `flatMap` already allocated this array; the snapshot it was projected from
  // is never touched.
  return rows.sort(compareDashRows);
}

/**
 * One plan document waiting in a project's docs directory — the front half of
 * the arc, which was invisible to every surface until now.
 *
 * A plan row is waiting paperwork **by filter, not by construction**. Presence
 * in the docs directory says nothing about ownership: adoption leaves a
 * committed, clean base copy exactly where it was, so a plan a dash is
 * implementing right now sits there for the dash's whole life with its ledger
 * frozen at all-`pending` — the run's progress goes to the worktree copy. What
 * keeps the two kinds of row from naming the same work is the producer, which
 * lists a document only when no dash has adopted it and its ledger is not
 * wholly `done`.
 */
export interface DocumentDashRow {
  /** Project dir plus dash name — unique across every open project. */
  key: string;
  /** The wire entry: the row reads it directly. */
  entry: DocumentDashEntry;
  /** The project the path is relative to — what the prompt's target must match. */
  projectDir: string;
  /** That project's name, for the cross-project refusal sentence. */
  projectLabel: string;
}

/** Nearest-to-work-starting first: a reviewed plan is one gesture from a dash. */
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
export function documentDashIsBegun(entry: DocumentDashEntry): boolean {
  return entry.steps_begun > 0;
}

/**
 * The plan rows' total order: begun first, then review rank descending, then
 * by name.
 *
 * The same nearest-to-done principle {@link compareDashRows} encodes, applied
 * to the front half: work in flight is nearer done than work not started, and
 * among the unstarted a reviewed plan is one press from becoming a dash while
 * an unreviewed one still needs a turn spent on it.
 */
export function compareDocumentDashRows(
  a: DocumentDashRow,
  b: DocumentDashRow,
): number {
  const byBegun =
    Number(documentDashIsBegun(b.entry)) - Number(documentDashIsBegun(a.entry));
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
 * {@link dashRowsFromSnapshot} makes, for the same reason: a listing that
 * changed as the reader moved between cards would be the coming-and-going wart
 * this section already retired. A plan whose project is not the followed one is
 * inert now and actionable the moment a card in that project is followed, and
 * its affordance says exactly that ([L31]).
 */
export function documentDashRowsFromSnapshot(
  snapshot: WorkspacesChangesetSnapshot,
): DocumentDashRow[] {
  const rows = snapshot.projects.flatMap((project) =>
    (project.document_dashes ?? []).map((entry) => ({
      key: `${project.project_dir}:${entry.display_name}`,
      entry,
      projectDir: project.project_dir,
      projectLabel: project.display_name,
    })),
  );
  return rows.sort(compareDocumentDashRows);
}

/**
 * The band's one-line reading when the section is collapsed.
 *
 * Counts both kinds, because counting only dashes would hide the front half of
 * the arc exactly when the band is folded — which is the state a reader leaves
 * it in. A zero bucket drops rather than reading "0 plans".
 */
export function dashesCollapsedSummary(
  rows: readonly DashRow[],
  planning: readonly DocumentDashRow[] = [],
): string {
  const parts: string[] = [];
  if (rows.length > 0) {
    parts.push(rows.length === 1 ? "1 dash" : `${rows.length} dashes`);
  }
  if (planning.length > 0) {
    parts.push(`${planning.length} planning`);
  }
  return parts.length === 0 ? "No dashes" : parts.join(" · ");
}

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------

/**
 * A flat, immutable list over one projection pass, carrying both kinds of row.
 * A new projection makes a new source; there is no mutation to subscribe to.
 *
 * Dashes first, then plans: live work outranks waiting paperwork, so the index
 * split is the ordering — no interleaving and no comparator across kinds.
 */
class CockpitRowsDataSource implements TugListViewDataSource {
  constructor(
    readonly rows: readonly DashRow[],
    readonly plans: readonly DocumentDashRow[],
  ) {}
  numberOfItems(): number {
    return this.rows.length + this.plans.length;
  }
  idForIndex(index: number): string {
    const dash = this.rows[index];
    if (dash !== undefined) return dash.ownerId;
    // Namespaced so an owner key and a document-dash key can never collide.
    return `doc:${this.plans[index - this.rows.length]!.key}`;
  }
  kindForIndex(index: number): string {
    return index < this.rows.length ? "dash" : "plan";
  }
  /** The document-only dash at a list index, or undefined for a dash index. */
  planAt(index: number): DocumentDashRow | undefined {
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

/** Where a Bind press would send this dash, or why it cannot. Exactly one of
 *  the two is non-null. */
export interface BindTarget {
  tugSessionId: string | null;
  reason: string | null;
}

/**
 * Resolve Bind's target from the Lens's followed card (Table T01) — pure, so
 * its whole truth table is a unit test rather than a DOM one.
 *
 * The ladder stops at the followed card deliberately. Reaching past it to some
 * other open card would make Bind succeed more often at the cost of making its
 * destination invisible: a press could bind a dash into a card the reader was
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
    return { tugSessionId: null, reason: "Focus a session card to bind this dash" };
  }
  if (input.binding === undefined) {
    return { tugSessionId: null, reason: "The focused card has no session" };
  }
  // A dash can only be bound by a session in its own project — the bind names a
  // project dir, and the server resolves the dash within it.
  if (input.binding.projectDir !== input.projectDir) {
    return {
      tugSessionId: null,
      reason: `This dash belongs to ${input.projectLabel}`,
    };
  }
  return { tugSessionId: input.binding.tugSessionId, reason: null };
}

/**
 * The open card working this dash, or null — the destination a row activation
 * routes to.
 *
 * Pure, so its whole truth table is a unit test rather than a DOM one. First
 * match wins: `bound_sessions` is live sessions mated to the dash, and a card
 * bound to one of them is a card whose Changes shade shows this dash's lane. In
 * the ordinary case there is exactly one; where there are several, any of them
 * is a correct room to open, and picking the first keeps the answer stable
 * across renders rather than depending on iteration luck.
 *
 * Null is the common case, not an error: the Lens lists every dash in every
 * open project, so a dash nobody holds — or one whose worker's card is closed —
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
function useWorkerCard(entry: DashChangesetEntry): string | null {
  const bindings = useSyncExternalStore(
    cardSessionBindingStore.subscribe,
    cardSessionBindingStore.getSnapshot,
  );
  return resolveWorkerCard(entry.bound_sessions ?? [], bindings);
}

/**
 * The tug session of the card the Lens is following, or null.
 *
 * Where this section's answers go. Bind's target is narrower — it refuses a
 * card in another project — but a replay's outcome has to reach a reader even
 * when a bind from the same row would be refused, so the notice is aimed at the
 * followed card itself rather than at Bind's resolved target.
 */
function useFollowedSessionId(): string | null {
  const followedCardId = useLensFollowedCard();
  const bindings = useSyncExternalStore(
    cardSessionBindingStore.subscribe,
    cardSessionBindingStore.getSnapshot,
  );
  if (followedCardId === null) return null;
  return bindings.get(followedCardId)?.tugSessionId ?? null;
}

/** {@link resolveBindTarget} against the live followed card and its binding. */
function useBindTarget(row: DashRow): BindTarget {
  const followedCardId = useLensFollowedCard();
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
interface DashVerbs {
  requestDiscard: (row: DashRow, anchor: HTMLElement | null) => void;
  /** Send `changeset_replay`; the outcome speaks on the followed card. */
  requestReplay: (row: DashRow, tugSessionId: string | null) => void;
  /** Why every Replay in this section is unavailable right now, or null. */
  replayDisabledReason: string | null;
}

const DashVerbsContext = React.createContext<DashVerbs | null>(null);

/**
 * The row's rare verbs, behind one opener — the same `⋯` grammar the Changes
 * shade's dash lane wears, composed from the same hook ({@link useDashRowMenu}).
 *
 * They used to stand here as Bind and Discard text buttons. Standing on the
 * eyebrow they read as peers of the acts a reader performs constantly, which
 * they are not: a dash is bound once, discarded almost never, and replayed only
 * when the automatic engine's gates have skipped it. The eyebrow goes back to
 * being read, and the two dash-row surfaces stop speaking two grammars.
 *
 * Bind's refusals arrive here as the item's own disabled reason, verbatim from
 * {@link resolveBindTarget} ([L31]). Unbind is deliberately absent: it stays the
 * fronted shade row's verb, and a Lens row routes you there.
 *
 * The press reports **nothing locally** for a bind: on success the worker's atom
 * replaces the opener's neighbours, so a pending state would be reporting into a
 * control that is about to leave. A server-side refusal arrives on the card-level
 * `dash-bind-error-store` surface, which outlives it — and a replay's outcome on
 * its sibling, for the same reason.
 */
function DashRowMenuControl({ row }: { row: DashRow }): React.ReactElement | null {
  const verbs = React.useContext(DashVerbsContext);
  const target = useBindTarget(row);
  const followedSessionId = useFollowedSessionId();
  const entry = row.entry;
  const name = entry.display_name;
  const bound = (entry.bound_sessions ?? []).length > 0;
  const openerRef = React.useRef<HTMLButtonElement | null>(null);

  const rowMenu = useDashRowMenu({
    // Bind only, and only while nobody holds the dash: Unbind belongs to the
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
            // binding path. `bind_dash_ok` stays the only mover of
            // `cardSessionBindingStore`: a refused bind leaves the card bound
            // to whatever it was.
            getConnection()?.sendControlFrame("bind_dash", {
              tug_session_id: target.tugSessionId,
              project_dir: row.projectDir,
              dash: name,
            });
          },
        },
    discard:
      verbs === null
        ? null
        : {
            disabledReason: null,
            // The anchor is the ROW cell, never the opener: the confirm
            // outlives the press, and the menu unmounts on selection, so a
            // popover anchored to the item would be destroyed as it opened.
            perform: () =>
              verbs.requestDiscard(
                row,
                openerRef.current?.closest(
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

  if (rowMenu.menu === null) return null;
  return (
    <span className="lens-dashes-verbs" data-slot="lens-dashes-verbs">
      <TugPushButton
        ref={openerRef}
        size="2xs"
        subtype="icon"
        emphasis="ghost"
        aria-label={`Actions for dash ${name}`}
        data-slot="lens-dashes-row-menu-open"
        icon={<EllipsisVertical size={14} />}
        onClick={() => rowMenu.openMenu(openerRef.current)}
      />
      {rowMenu.menu}
    </span>
  );
}

// ---------------------------------------------------------------------------
// The block
// ---------------------------------------------------------------------------

const DashCell: TugListViewCellRenderer<CockpitRowsDataSource> = ({
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
  const model = dashTrackModelFromEntry(entry);
  return (
    <TugListRow
      className="lens-dashes-row"
      variant="flush"
      density="compact"
      data-slot="lens-dashes-row"
      data-dash={entry.display_name}
      data-bound={workers.length > 0 ? "true" : undefined}
      data-activatable={activatable ? "true" : undefined}
    >
      <span className="lens-dashes-block">
        {/* The dash's whole life in the one block: the atom and the workers
            over the track, the fraction, the note, and the divergence facts.
            The pill wears no review tint — that yellow means WAITING, and a
            dash is not waiting for anyone.

            Every row carries the menu opener, held or not: Replay reaches a
            bound dash on the same terms as an unbound one, and a menu that
            came and went with the binding would be the section's old wart in
            miniature. */}
        <DashLifecycleBlock
          name={entry.display_name}
          workers={workers}
          model={model}
          note={dashLifecycleNote(model, entry.step_title ?? null)}
          facts={dashMetaFacts(entry)}
          size="rail"
          trailing={<DashRowMenuControl row={row} />}
        />
        {/* And what its JOIN is doing, in the one shared register — the same
            sentence the shade and the composer show, because all three call
            one derivation. Renders nothing until there is a join. */}
        <DashJoinRow row={row} />
      </span>
    </TugListRow>
  );
};

/**
 * The dash's join register, with the beats its own store read supplies.
 *
 * A separate component so the `useSyncExternalStore` subscription belongs to
 * the row that needs it ([L02]) rather than re-rendering every row in the
 * section on every beat of one dash's join.
 */
function DashJoinRow({ row }: { row: DashRow }): React.ReactElement | null {
  const entry = row.entry;
  const landBeat = useChangesetJoinLand(row.workspaceKey, entry.display_name);
  return (
    <span className="lens-dashes-register">
      <DashJoinRegister
        dash={entry.display_name}
        base={entry.base ?? "main"}
        stage={entry.stage}
        join={entry.join}
        landBeat={landBeat}
        // The Lens is the one surface that renders dashes nobody is holding,
        // so it is the one that has to hand the register that fact ([D147]).
        bound={(entry.bound_sessions ?? []).length > 0}
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
  const target = usePromptTarget({
    requireProjectDir: row?.projectDir ?? null,
    projectLabel: row?.projectLabel,
  });
  if (row === undefined) return null;
  const entry = row.entry;
  const begun = documentDashIsBegun(entry);
  const hasPlan = entry.documents.plan !== undefined;
  const label = documentDashNextGestureLabel(entry.review, begun, hasPlan);
  const prompt = documentDashNextGesturePrompt(
    entry.review,
    entry.display_name,
    begun,
    hasPlan,
  );
  // The counted steps, never the composed ones: `dashTrackModelFromEntry` over
  // the adapted entry would find no `steps` at all and read `review` for a
  // plan already half walked.
  const model = documentDashTrackModel(entry);
  return (
    <TugListRow
      className="lens-dashes-row"
      variant="flush"
      density="compact"
      data-slot="lens-document-dash-row"
      data-dash={entry.display_name}
      data-review={entry.review}
      data-begun={begun ? "true" : "false"}
    >
      <span className="lens-dashes-block">
        <DashLifecycleBlock
          name={entry.display_name}
          workers={entry.bound_sessions ?? []}
          model={model}
          note={dashLifecycleNote(model, null)}
          facts={dashMetaFacts(documentDashAsEntry(entry))}
          size="rail"
          trailing={
            <span className="lens-dashes-verbs">
              <TugPushButton
                size="2xs"
                emphasis="ghost"
                data-slot="lens-plans-gesture"
                // The exact line a press submits, carried on the control rather
                // than composed at press time — one string, rendered once, so
                // what the button says it will do and what it does cannot drift.
                data-prompt={prompt}
                disabled={target.cardId === null}
                title={target.reason ?? undefined}
                aria-label={
                  target.reason ?? `${label} the dash ${entry.display_name}`
                }
                onClick={() => {
                  if (target.cardId === null) return;
                  submitPromptToCard(target.cardId, prompt);
                }}
              >
                {label}
              </TugPushButton>
            </span>
          }
        />
      </span>
    </TugListRow>
  );
};

const DASH_CELL_RENDERERS = { dash: DashCell, plan: PlanCell };

function useDashRows(): DashRow[] {
  const snapshot = useChangesetAll();
  return useMemo(() => dashRowsFromSnapshot(snapshot), [snapshot]);
}

function usePlanRows(): DocumentDashRow[] {
  const snapshot = useChangesetAll();
  return useMemo(() => documentDashRowsFromSnapshot(snapshot), [snapshot]);
}

function DashesCollapsedSummary(): React.ReactElement {
  return <>{dashesCollapsedSummary(useDashRows(), usePlanRows())}</>;
}

/**
 * The section's verb round trips, keyed by the section rather than by row: one
 * discard and one replay at a time is the right number, and the state lives in
 * a module store that outlives this body.
 */
const DASHES_VERB_KEY = "lens-unbound-dashes";

function DashesSectionBody({ host }: { host: LensSectionHost }): React.ReactElement {
  const rows = useDashRows();
  const plans = usePlanRows();
  const dataSource = useMemo(
    () => new CockpitRowsDataSource(rows, plans),
    [rows, plans],
  );
  // Both kinds, not the dash count. This one value decides two things — whether
  // the band's arrow walk has anything to walk onto, and whether the body is
  // the empty state — so a project with plans and no dashes would otherwise
  // render "No dashes" over rows that never mounted.
  const populated = rows.length + plans.length > 0;

  const discardVerb = useChangesetDiscard(DASHES_VERB_KEY);
  // One replay round trip for the section, for the reason the discard has one:
  // the state is a slot per key, and a second press would render the first's
  // phase.
  const replayVerb = useChangesetReplay(DASHES_VERB_KEY);
  // Which row's discard is armed, and the element the confirm hangs off. View
  // scope ([L24]): a half-armed confirm is not worth remembering, and closing
  // the Lens forgets it.
  const [pendingDiscard, setPendingDiscard] = useState<{
    row: DashRow;
    anchor: HTMLElement | null;
  } | null>(null);
  const verbs = useMemo<DashVerbs>(
    () => ({
      requestDiscard: (row, anchor) => setPendingDiscard({ row, anchor }),
      // No confirm: a replay destroys nothing, and its every refusal path
      // leaves the repository exactly as it found it. What it needs instead is
      // a voice, which is the session id — the outcome posts on that card's
      // pane bulletin, and the common outcomes move nothing else.
      requestReplay: (row, tugSessionId) =>
        replayVerb.replay(
          row.workspaceKey,
          row.entry.display_name,
          tugSessionId ?? undefined,
        ),
      replayDisabledReason:
        replayVerb.phase === "pending" ? "A replay is in flight" : null,
    }),
    [replayVerb],
  );

  // The band's arrow walk needs to know whether there is anything in here to
  // walk onto, and it needs to know it before the first key event — hence
  // layout effect, not effect ([L03]).
  useLayoutEffect(() => {
    setSectionContent(host.focusGroup, {
      navigable: populated,
      populated,
    });
    return () =>
      setSectionContent(host.focusGroup, { navigable: false, populated: false });
  }, [host.focusGroup, populated]);

  // Activation opens the dash's ROOM: it fronts the card working the dash and
  // reveals that card's Changes shade, which is where every decision about a
  // dash already lives ([D152]). Navigation, never a verb — the mutating acts
  // stay behind the `⋯`, because status is not a control ([D142]).
  //
  // Click and Enter are the same act here, unlike the Cards section's split:
  // there, a click both selects and fronts, so the two doors differ. A dash row
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

  // The empty state keeps the band, reading exactly as every other Lens
  // section's does: the shared word, centered, on one row's worth of height.
  // A dash starts in a session card, so there is nothing to press here and no
  // way in to name — the band is a fixed address to glance at, not a door.
  if (!populated) {
    return (
      <div className="lens-section-empty" data-slot="lens-dashes-empty">
        None
      </div>
    );
  }

  return (
    <DashVerbsContext value={verbs}>
      <div className="lens-dashes-section" data-slot="lens-dashes-section">
        <TugListView<CockpitRowsDataSource>
          dataSource={dataSource}
          delegate={delegate}
          cellRenderers={DASH_CELL_RENDERERS}
          scrollKey="lens-dashes"
          inline
          rowLayout="flush"
          focusGroup={host.focusGroup}
          {...LENS_LIST_PRESENTATION}
          className="lens-dashes-list"
        />
        {/* One controlled confirm for the whole section, anchored to whichever
            row armed it. `confirmRole="danger"` puts default focus on Cancel,
            so a reflexive Return can never destroy a dash. */}
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
    </DashVerbsContext>
  );
}

/** Register the Dashes section. Called once at boot from `main.tsx`. */
export function registerDashesSection(): void {
  registerLensSection({
    // The `kind` stays `"dashes"` and always will: it is persisted in
    // `lensStore`'s `sectionOrder` and `collapsedSections`, so changing it
    // would silently reset everyone's section order and re-expand a section
    // they had collapsed. It is also the `data-lens-section` test hook. The
    // title is what a person reads.
    kind: SECTION_KIND,
    // A dash IS a branch plus a worktree, and this is the glyph that says so.
    glyph: <GitBranch size={14} />,
    title: "Dashes",
    collapsedSummary: () => <DashesCollapsedSummary />,
    body: (host) => <DashesSectionBody host={host} />,
    // No `presence`: the section is always on. A band that comes and goes has
    // no fixed address, and no other Lens section works that way.
  });
}
