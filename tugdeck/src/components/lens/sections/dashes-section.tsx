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
 *   [^dash-atom] ────────────────── [worker atom | Bind Discard]
 *     ring · stage icon · count · note · age · divergence
 *
 * The EYEBROW holds the identities and nothing else: the dash atom at the
 * left, the hairline, and the "who" at the right — the bound worker as a mini
 * atom (no callsign, no dash run: the row already names both), or the Bind
 * and Discard verbs for a dash nobody holds. The dash pill wears no review
 * tint here: that yellow is the WAITING color, and a dash is not waiting for
 * anyone. Beneath it, `DashMetaLine` carries everything the dash is DOING.
 *
 * The Lens is the account-global surface and `ChangesetAllStore` is the
 * account-global snapshot it already reads, so this section is a projection
 * and nothing more. Rows key on the dash's **owner key**, which makes two
 * incarnations of a reused name distinct for free.
 *
 * Bind mates an unbound dash to the Lens's followed card, or refuses with a
 * reachable reason ([L31]); Discard destroys it behind a confirm. Neither is
 * on row activation. Both verbs destroy the surface they are pressed on —
 * the success path, not an edge case — so Bind reports nothing locally (a
 * refusal arrives on the card-level bind-error surface, which outlives the
 * row) and the discard confirm anchors to the row element. A bound dash
 * carries neither: its worker's shade is where its verbs live.
 *
 * Rows are totally ordered: nearest-to-done first, then freshest first, then
 * by name. Stage leads because a `draft-ready` dash is one gesture from
 * landing; freshness is the tiebreak a person actually wants; name is the
 * final tiebreak rather than snapshot order, which is git-enumeration order.
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
 * blocks compose `DashSigil`, `TugSessionIdentity`, and `DashMetaLine`.
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
import { GitBranch } from "lucide-react";

import { LENS_LIST_PRESENTATION } from "@/components/lens/lens-list-presentation";
import { setSectionContent } from "@/components/lens/lens-section-content";
import { DashMetaLine } from "@/components/tugways/dash-meta-line";
import { DashJoinRegister } from "@/components/tugways/dash-join-register";
import { useChangesetJoinLand } from "@/lib/changeset-join-store";
import { DashSigil } from "@/components/tugways/dash-sigil";
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
import { TugSessionIdentity } from "@/components/tugways/tug-session-identity";
import { TugTooltip } from "@/components/tugways/tug-tooltip";
import { useLensFollowedCard } from "@/components/lens/lens-followed-card";
import { cardSessionBindingStore } from "@/lib/card-session-binding-store";
import { getConnection } from "@/lib/connection-singleton";
import { useChangesetAll } from "@/lib/changeset-all-store";
import { useChangesetDiscard } from "@/lib/changeset-verb-store";
import { useSessionIdentity } from "@/lib/session-identity";
import type {
  DashChangesetEntry,
  ProjectChangeset,
  WorkspacesChangesetSnapshot,
} from "@/lib/changeset-types";

const SECTION_KIND = "dashes";

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

/** The band's one-line reading when the section is collapsed. */
export function dashesCollapsedSummary(rows: readonly DashRow[]): string {
  if (rows.length === 0) return "No dashes";
  return rows.length === 1 ? "1 dash" : `${rows.length} dashes`;
}

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------

/** A flat, immutable list over one projection pass. A new projection makes a
 *  new source; there is no mutation to subscribe to. */
class DashRowsDataSource implements TugListViewDataSource {
  constructor(readonly rows: readonly DashRow[]) {}
  numberOfItems(): number {
    return this.rows.length;
  }
  idForIndex(index: number): string {
    return this.rows[index]!.ownerId;
  }
  kindForIndex(): string {
    return "dash";
  }
  subscribe(): () => void {
    return () => {};
  }
  getVersion(): unknown {
    return this.rows;
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
}

const DashVerbsContext = React.createContext<DashVerbs | null>(null);

/**
 * Take this dash on.
 *
 * The press reports **nothing locally**, and that is the point: on success the
 * worker's atom replaces the verbs, so a pending state on the button would be
 * reporting into a control that is about to leave. A server-side refusal
 * arrives on the card-level `dash-bind-error-store` surface, which outlives it.
 */
function BindControl({ row }: { row: DashRow }): React.ReactElement {
  const target = useBindTarget(row);
  const name = row.entry.display_name;
  return (
    // The tooltip wraps a SPAN, not the button: a disabled button takes no
    // pointer events, so its own tooltip would never fire — and an unreachable
    // reason is not a reason ([L31]).
    <TugTooltip content={target.reason ?? `Bind ${name} to the focused session`}>
      <span className="lens-dashes-bind">
        <TugPushButton
          size="2xs"
          subtype="text"
          disabled={target.reason !== null}
          data-slot="lens-bind"
          onClick={() => {
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
          }}
        >
          Bind
        </TugPushButton>
      </span>
    </TugTooltip>
  );
}

/** Let this dash go. Arms the section's one confirm, anchored to the row. */
function DiscardControl({ row }: { row: DashRow }): React.ReactElement | null {
  const verbs = React.useContext(DashVerbsContext);
  if (verbs === null) return null;
  return (
    <TugTooltip content={`Discard ${row.entry.display_name} — its branch and worktree`}>
      <span className="lens-dashes-discard">
        <TugPushButton
          size="2xs"
          subtype="text"
          role="danger"
          data-slot="lens-discard"
          onClick={(event) => {
            // The anchor is the ROW element, never this button: the confirm
            // outlives the press, and a control in a trailing cluster can
            // unmount under its own popover.
            const button = event?.currentTarget as HTMLElement | undefined;
            verbs.requestDiscard(
              row,
              button?.closest(".tug-list-view-cell") as HTMLElement | null,
            );
          }}
        >
          Discard
        </TugPushButton>
      </span>
    </TugTooltip>
  );
}

// ---------------------------------------------------------------------------
// The block
// ---------------------------------------------------------------------------

/**
 * The eyebrow's "who": one bound worker as a mini atom — the session's
 * display name behind its live dot, with no callsign and no dash run. The
 * callsign removal is `sessionTitleParts`' own rule; the dash suppression is
 * this surface's, because the eyebrow's leading atom already names the dash.
 */
function WorkerAtom({ sessionId }: { sessionId: string }): React.ReactElement {
  const identity = useSessionIdentity(sessionId);
  return (
    <TugSessionIdentity
      identity={identity}
      tier="chip"
      size="2xs"
      dash={false}
      tooltip={false}
      className="lens-dashes-worker"
      data-slot="lens-dashes-worker"
    />
  );
}

const DashCell: TugListViewCellRenderer<DashRowsDataSource> = ({
  index,
  dataSource,
}: TugListViewCellProps<DashRowsDataSource>) => {
  const row = dataSource.rows[index];
  if (row === undefined) return null;
  const entry = row.entry;
  const workers = entry.bound_sessions ?? [];
  return (
    <TugListRow
      className="lens-dashes-row"
      variant="flush"
      density="compact"
      data-slot="lens-dashes-row"
      data-dash={entry.display_name}
      data-bound={workers.length > 0 ? "true" : undefined}
    >
      <span className="lens-dashes-block">
        {/* The eyebrow holds the identities and nothing else: the dash atom,
            the hairline, the "who". The pill wears no review tint — that
            yellow means WAITING, and a dash is not waiting for anyone. */}
        <span className="lens-dashes-eyebrow">
          <DashSigil
            name={entry.display_name}
            review={null}
            slot="lens-dashes-name"
            atom
            atomSize="2xs"
          />
          <span className="lens-dashes-eyebrow-rule" />
          {workers.length > 0 ? (
            workers.map((sessionId) => (
              <WorkerAtom key={sessionId} sessionId={sessionId} />
            ))
          ) : (
            <span className="lens-dashes-verbs" data-slot="lens-dashes-verbs">
              <BindControl row={row} />
              <DiscardControl row={row} />
            </span>
          )}
        </span>
        {/* Everything the dash is DOING, in the one shared metadata line. */}
        <span className="lens-dashes-meta-line">
          <DashMetaLine entry={entry} />
        </span>
        {/* And what its JOIN is doing, in the one shared register — the same
            sentence the shade and the composer show, because all three call
            one derivation. Renders nothing until there is a join arc. */}
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
        altitude="section"
      />
    </span>
  );
}

const DASH_CELL_RENDERERS = { dash: DashCell };

function useDashRows(): DashRow[] {
  const snapshot = useChangesetAll();
  return useMemo(() => dashRowsFromSnapshot(snapshot), [snapshot]);
}

function DashesCollapsedSummary(): React.ReactElement {
  return <>{dashesCollapsedSummary(useDashRows())}</>;
}

/**
 * The section's one discard round trip, keyed by the section rather than by
 * row: one discard at a time is the right number, and the state lives in a
 * module store that outlives this body.
 */
const DASHES_DISCARD_KEY = "lens-unbound-dashes";

function DashesSectionBody({ host }: { host: LensSectionHost }): React.ReactElement {
  const rows = useDashRows();
  const dataSource = useMemo(() => new DashRowsDataSource(rows), [rows]);
  const populated = rows.length > 0;

  const discardVerb = useChangesetDiscard(DASHES_DISCARD_KEY);
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
    }),
    [],
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

  // Activation moves the cursor and nothing else; the row's verbs are named
  // controls on the eyebrow ([L31]).
  const delegate = useMemo<TugListViewDelegate>(() => ({}), []);

  // The empty state keeps the band, at the shared empty label's height and
  // tone — but it names the way in rather than saying "None".
  //
  // An empty Cards section is self-evident and self-correcting: the reader has
  // no cards and knows how to open one. An empty Dashes band is the one place
  // a reader may not know the verb at all, and a section whose whole argument
  // is that it holds a fixed address is worth one sentence that earns it.
  if (!populated) {
    return (
      <div
        className="lens-section-empty lens-dashes-empty"
        data-slot="lens-dashes-empty"
      >
        <span>
          No dashes. <code>tugutil dash create</code> starts one.
        </span>
      </div>
    );
  }

  return (
    <DashVerbsContext value={verbs}>
      <div className="lens-dashes-section" data-slot="lens-dashes-section">
        <TugListView<DashRowsDataSource>
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
