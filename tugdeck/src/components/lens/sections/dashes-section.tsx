/**
 * dashes-section.tsx — the Lens **Dashes** section: one row per inflight dash,
 * across every open project.
 *
 * The Lens is the account-global surface and `ChangesetAllStore` is the
 * account-global snapshot it already reads, so this section is a projection
 * and nothing more — no feed, no store of record, no second copy of anything.
 * Rows key on the dash's **owner key**, which makes two incarnations of a
 * reused name distinct for free.
 *
 * A dash reads in dash grammar here too — name, stage, and whether anyone is
 * on it — never in the grammar of a card or a file. A dash with live bound
 * sessions wears a phase dot; a dash with none wears the parked mark, which is
 * a quiet glyph rather than a dot, because "nobody is working this" is not a
 * state of work.
 *
 * **This is the roster, not the workbench.** The Cards section nests a dash
 * sub-row under the session working it — that is where a reader asks "what is
 * this session doing". This section answers the other question, account-
 * globally: what dashes exist, and which of them need attention. A worked dash
 * therefore appears in both places, and that is two surfaces answering two
 * questions rather than a duplication. It is also why this section is the one
 * that cannot be dropped: a **parked** dash has no session to nest under, and
 * every dash has to stay findable in the Lens.
 *
 * The per-session jump chips this row used to carry are gone for the same
 * reason: they were how you got TO the session working a dash, and the sub-row
 * is already there. The facts run — name, stage, steps, review mark — is shared
 * with that sub-row ({@link DashFactsRun}), so the two cannot drift.
 *
 * **Liveness is a leaf.** Phase lives on per-card `codeSessionStore` snapshots
 * that move on every transcript event; a row projection subscribed to that
 * would wake the whole section per event. So {@link DashPhaseDot} mounts the
 * subscription at the dot, the section's data pass never reads phase, and a
 * reducer wake repaints one glyph.
 *
 * Read-only, deliberately: the binding verbs live in the Changes shade, beside
 * the facts you would take a dash on for, and this row offers no join, no
 * release, and no adopt. It says what is true and gets out of the way.
 *
 * Rows are totally ordered ([P02]): worked before parked, then nearest-to-done
 * first, then by name. The first reading is the useful one that way, and the
 * order does not reshuffle when an unrelated branch is created.
 *
 * Laws: [L02] the aggregate and the bindings enter React through
 * `useSyncExternalStore`; [L03] the section's content declaration is a
 * `useLayoutEffect`; [L06] the parked mark and the row's tone are CSS on DOM
 * attributes, never React state; [L11] row activation dispatches
 * `focus-session-card` rather than reaching into a card; [L13] the dot's
 * motion is the progress indicator's; [L19] rows compose `TugListView` /
 * `TugListRow` rather than hand-rolling list focus.
 *
 * @module components/lens/sections/dashes-section
 */

import "./dashes-section.css";

import React, { useLayoutEffect, useMemo, useSyncExternalStore } from "react";
import { CircleDashed, GitBranch } from "lucide-react";

import { dispatchCommand } from "@/command-dispatch";
import { LENS_LIST_PRESENTATION } from "@/components/lens/lens-list-presentation";
import { setSectionContent } from "@/components/lens/lens-section-content";
import { DashFactsRun } from "@/components/lens/sections/dash-facts";
import { registerLensSection } from "@/components/lens/lens-section-registry";
import type { LensSectionHost } from "@/components/lens/lens-section-registry";
import { SessionPhaseDot } from "@/components/tugways/session-phase-dot";
import { TugListRow } from "@/components/tugways/tug-list-row";
import { TugListView } from "@/components/tugways/tug-list-view";
import type {
  TugListViewCellProps,
  TugListViewCellRenderer,
  TugListViewDataSource,
  TugListViewDelegate,
} from "@/components/tugways/tug-list-view";
import { TugTooltip } from "@/components/tugways/tug-tooltip";
import { cardIdForSession } from "@/lib/card-session-binding-store";
import { useChangesetAll } from "@/lib/changeset-all-store";
import type {
  DashChangesetEntry,
  WorkspacesChangesetSnapshot,
} from "@/lib/changeset-types";

const SECTION_KIND = "dashes";

/** The dot's box in the Lens rail — the compact tier, matched to the row's
 *  single line rather than to the Cards section's monitor rows. */
const DASH_DOT_SIZE = 10;

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

/** One dash, flattened out of the aggregate for the section's list. */
export interface DashRow {
  /** The dash's owner key — this row's identity, unique per incarnation. */
  ownerId: string;
  /** The dash's short name. */
  name: string;
  /** The derived stage word, or null from a sender that sends none. */
  stage: string | null;
  /** `step i/N`, only when the server sent both halves. */
  steps: string | null;
  /** What the current step *is* — the latest declaration's title, or null. */
  stepTitle: string | null;
  /** Live sessions mated to this dash — empty is how *parked* reads. */
  boundSessions: string[];
  /** True when no live session is working this dash. */
  parked: boolean;
  /** The dash plan's review state (`reviewed` | `stale` | `never-reviewed`),
   *  or null when the dash records no plan or the server had nothing to say. */
  review: string | null;
  /** The owning project's name, when more than one project has dashes. */
  projectLabel: string | null;
}

function rowFromEntry(
  entry: DashChangesetEntry,
  projectLabel: string | null,
): DashRow {
  const boundSessions = entry.bound_sessions ?? [];
  return {
    ownerId: entry.owner_id,
    name: entry.display_name,
    stage: entry.stage ?? null,
    steps:
      entry.step_current !== undefined && entry.step_total !== undefined
        ? `step ${entry.step_current}/${entry.step_total}`
        : null,
    stepTitle: entry.step_title ?? null,
    boundSessions,
    // Absence of evidence renders the quiet mark, never a live claim: an older
    // sender omits `bound_sessions` entirely, and that is not a reason to say
    // somebody is working.
    parked: boundSessions.length === 0,
    review: entry.review ?? null,
    projectLabel,
  };
}

/**
 * How far along a dash is, as a sortable rank ([P02], Table T01).
 *
 * Nearest-to-done ranks highest, because the actionable dash is the one about
 * to land rather than the one just created. `landing` tops the table because it
 * means an interrupted teardown — the one state that actively needs a person.
 * Exported so its test can be a table test rather than a DOM assertion.
 */
export const DASH_STAGE_RANK: Record<string, number> = {
  landing: 6,
  "draft-ready": 5,
  audited: 4,
  built: 3,
  implementing: 2,
  working: 1,
  created: 0,
};

/** An absent or unrecognized stage sorts last, and never throws: an older or
 *  newer sender must not be able to break the section's render. */
function stageRank(stage: string | null): number {
  return stage === null ? -1 : (DASH_STAGE_RANK[stage] ?? -1);
}

/**
 * The section's total order ([P02], Spec S02): worked before parked, then by
 * stage rank descending, then by name.
 *
 * Worked-before-parked dominates because it is the question the section exists
 * to answer — an ordering that ignores *whether anyone is on it* contradicts
 * the section's own premise. Name is the tiebreak rather than snapshot order,
 * which is git-enumeration order: stable, arbitrary, and reshuffled by any
 * branch created or deleted.
 */
export function compareDashRows(a: DashRow, b: DashRow): number {
  if (a.parked !== b.parked) return a.parked ? 1 : -1;
  const byStage = stageRank(b.stage) - stageRank(a.stage);
  if (byStage !== 0) return byStage;
  return a.name.localeCompare(b.name);
}

/**
 * Every inflight dash across every open project, ordered by
 * {@link compareDashRows}.
 *
 * Project grouping is not an ordering key: the project label already rides each
 * row when more than one project has dashes, and grouping by project would bury
 * the dash somebody is working under one created a week ago in another repo.
 *
 * The project disambiguator only appears when it disambiguates: with one
 * project holding dashes, every row's suffix would say the same thing.
 */
export function dashRowsFromSnapshot(
  snapshot: WorkspacesChangesetSnapshot,
): DashRow[] {
  const withDashes = snapshot.projects.filter((project) =>
    project.changesets.some((entry) => entry.kind === "dash"),
  );
  const disambiguate = withDashes.length > 1;
  const rows = withDashes.flatMap((project) =>
    project.changesets
      .filter((entry): entry is DashChangesetEntry => entry.kind === "dash")
      .map((entry) =>
        rowFromEntry(entry, disambiguate ? project.display_name : null),
      ),
  );
  // `flatMap` already allocated this array; the snapshot it was projected from
  // is never touched.
  return rows.sort(compareDashRows);
}

/** The band's one-line reading when the section is collapsed. */
export function dashesCollapsedSummary(rows: readonly DashRow[]): string {
  if (rows.length === 0) return "No dashes";
  const parked = rows.filter((row) => row.parked).length;
  const dashes = `${rows.length} ${rows.length === 1 ? "dash" : "dashes"}`;
  return parked > 0 ? `${dashes} · ${parked} parked` : dashes;
}

// ---------------------------------------------------------------------------
// Leaves
// ---------------------------------------------------------------------------

/**
 * The row's liveness mark ([P05]).
 *
 * Reads the first bound session — the dot answers "is someone working this
 * dash right now", not "who", and `bound_sessions` carries live sessions only,
 * so the first one is as good an answer as the set. `useSessionPhase` reports
 * `idle` for a session this deck cannot reach, which is the honest reading for
 * a dash being worked in another window.
 */
function DashPhaseDot({ sessionId }: { sessionId: string }): React.ReactElement {
  return <SessionPhaseDot sessionId={sessionId} size={DASH_DOT_SIZE} drift />;
}

/** The parked mark: a quiet glyph, deliberately not a dot at rest — a dash
 *  nobody is working is not a state of work. */
function DashParkedMark(): React.ReactElement {
  return (
    <TugTooltip content="Parked — no live session is working this dash">
      <span
        className="lens-dashes-parked"
        data-slot="lens-dashes-parked"
        aria-label="Parked"
      >
        <CircleDashed size={DASH_DOT_SIZE + 2} />
      </span>
    </TugTooltip>
  );
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

const DashCell: TugListViewCellRenderer<DashRowsDataSource> = ({
  index,
  dataSource,
}: TugListViewCellProps<DashRowsDataSource>) => {
  const row = dataSource.rows[index];
  if (row === undefined) return null;
  return (
    <TugListRow
      className="lens-dashes-row"
      variant="flush"
      density="compact"
      data-slot="lens-dashes-row"
      data-dash={row.name}
      data-parked={row.parked ? "true" : undefined}
      leading={
        row.parked ? (
          <DashParkedMark />
        ) : (
          <DashPhaseDot sessionId={row.boundSessions[0]!} />
        )
      }
    >
      <DashFactsRun
        name={row.name}
        stage={row.stage}
        steps={row.steps}
        stepTitle={row.stepTitle}
        review={row.review}
        markSize={DASH_DOT_SIZE + 2}
        trailing={
          row.projectLabel !== null ? (
            <span className="lens-dashes-project">{row.projectLabel}</span>
          ) : undefined
        }
      />
    </TugListRow>
  );
};

const DASH_CELL_RENDERERS = { dash: DashCell };

function useDashRows(): DashRow[] {
  const snapshot = useChangesetAll();
  return useMemo(() => dashRowsFromSnapshot(snapshot), [snapshot]);
}

function DashesCollapsedSummary(): React.ReactElement {
  return <>{dashesCollapsedSummary(useDashRows())}</>;
}

function DashesSectionBody({ host }: { host: LensSectionHost }): React.ReactElement {
  const rows = useDashRows();
  const dataSource = useMemo(() => new DashRowsDataSource(rows), [rows]);
  const populated = rows.length > 0;

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

  // Activating a row fronts the card working this dash. A dash nobody's card
  // holds has nowhere to go, so activation is a no-op rather than a guess.
  const delegate = useMemo<TugListViewDelegate>(() => {
    const activate = (index: number): void => {
      const row = rows[index];
      if (row === undefined) return;
      for (const sessionId of row.boundSessions) {
        const cardId = cardIdForSession(sessionId);
        if (cardId !== null) {
          dispatchCommand("focus-session-card", { cardId });
          return;
        }
      }
    };
    return { onSelect: activate, onActivate: activate };
  }, [rows]);

  if (!populated) {
    return (
      <div className="lens-section-empty" data-slot="lens-dashes-empty">
        None
      </div>
    );
  }

  return (
    <div className="lens-dashes-section" data-slot="lens-dashes-section">
      <TugListView<DashRowsDataSource>
        dataSource={dataSource}
        delegate={delegate}
        cellRenderers={DASH_CELL_RENDERERS}
        scrollKey="lens-dashes"
        inline
        rowLayout="flush"
        focusGroup={host.focusGroup}
        commitOnEnter="act"
        {...LENS_LIST_PRESENTATION}
        className="lens-dashes-list"
      />
    </div>
  );
}

/** Register the Dashes section. Called once at boot from `main.tsx`. */
export function registerDashesSection(): void {
  registerLensSection({
    kind: SECTION_KIND,
    // A dash IS a branch plus a worktree, and this is the glyph that says so.
    glyph: <GitBranch size={14} />,
    title: "Dashes",
    collapsedSummary: () => <DashesCollapsedSummary />,
    body: (host) => <DashesSectionBody host={host} />,
  });
}
