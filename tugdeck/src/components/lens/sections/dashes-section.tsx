/**
 * dashes-section.tsx — the Lens **Unbound Dashes** section: the inbox of
 * unattended work, across every open project.
 *
 * **A dash appears in the Lens exactly once.** Worked ⇒ its session's row in
 * the Cards section, which carries `#<dash>` in the identity run and the
 * stage/step line beneath it. Unworked ⇒ here. The two surfaces partition the
 * dash universe, and membership is exactly `bound_sessions.length === 0` —
 * nothing curated, nothing about which stages are interesting.
 *
 * The partition is what makes this section keep its band. `bound_sessions` is
 * read live-sessions-only, so a dash whose cards have all closed has no session,
 * therefore no card, therefore no row in a section keyed by cards. That is a
 * structural gap in the Cards section rather than a shortfall to be improved
 * away: no amount of enriching a card row produces a row for a dash that has no
 * card. Everything else the roster used to say — name, stage, steps, review —
 * the session's own row already says, which is why saying it twice went away
 * rather than the section.
 *
 * An empty section renders **nothing at all**, band included ([P03]). The
 * everyday state is zero unbound dashes, and an inbox at zero should cost zero
 * rail height. Presence is published by a probe mounted outside this body,
 * because a body cannot decide it should not exist (see
 * `lens-section-presence.ts`).
 *
 * The Lens is the account-global surface and `ChangesetAllStore` is the
 * account-global snapshot it already reads, so this section is a projection
 * and nothing more — no feed, no store of record, no second copy of anything.
 * Rows key on the dash's **owner key**, which makes two incarnations of a
 * reused name distinct for free.
 *
 * **The row carries verbs**, which the roster it replaced deliberately did not.
 * The old reasoning was that the binding verbs live in the Changes shade beside
 * the facts you would take a dash on for — true, and it does not cover an unbound
 * dash, which has no session and therefore no shade to hold them. Bind mates
 * the dash to the Lens's followed card, or refuses with a reachable reason
 * ([L31]); Discard destroys it behind a confirm. Neither is on row activation:
 * fronting is what activating a row means everywhere else in the Lens, and one
 * list where Enter rebinds instead would be worse than the silence it replaced.
 *
 * Both verbs **destroy the surface they are pressed on** — that is the success
 * path, not an edge case, and on the last unbound dash it takes the whole
 * section with it. So Bind reports nothing locally (a refusal arrives on the
 * card-level bind-error surface, which outlives the row) and the discard
 * confirm anchors to the row element rather than to the button inside it.
 *
 * Rows are totally ordered: nearest-to-done first, then freshest first, then by
 * name. Stage leads because an unbound `draft-ready` dash is one gesture from
 * landing; freshness is the tiebreak a person actually wants, since the dash
 * unbound an hour ago is the one they were just in. Name is the final tiebreak
 * rather than snapshot order, which is git-enumeration order — stable,
 * arbitrary, and reshuffled by any branch created or deleted.
 *
 * The section's `kind` stays `"dashes"` though its title is Unbound Dashes.
 * The kind is the registry key and the key `sectionOrder` and
 * `collapsedSections` persist under in tugbank, so renaming it would silently
 * reset every saved Lens order and re-expand a section somebody had collapsed
 * — a real cost for a string nobody reads. The title is what a person reads,
 * and the title is what moved.
 *
 * Laws: [L02] the aggregate enters React through `useSyncExternalStore`;
 * [L03] the section's content declaration is a `useLayoutEffect`; [L06] the
 * unbound mark and the row's tone are CSS on DOM attributes, never React state;
 * [L19] rows compose `TugListView` / `TugListRow` rather than hand-rolling list
 * focus.
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
import { CircleDashed, GitBranch } from "lucide-react";

import { LENS_LIST_PRESENTATION } from "@/components/lens/lens-list-presentation";
import { setSectionContent } from "@/components/lens/lens-section-content";
import { DashReviewMark } from "@/components/lens/sections/dash-facts";
import { formatDashAge } from "@/components/lens/sections/dash-age";
import { DashSigil } from "@/components/tugways/dash-sigil";
import { dashReviewPaints } from "@/lib/dash-review";
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
import { TugTooltip } from "@/components/tugways/tug-tooltip";
import { useLensFollowedCard } from "@/components/lens/lens-followed-card";
import { cardSessionBindingStore } from "@/lib/card-session-binding-store";
import { getConnection } from "@/lib/connection-singleton";
import { useChangesetAll } from "@/lib/changeset-all-store";
import { useChangesetDiscard } from "@/lib/changeset-verb-store";
import type {
  DashChangesetEntry,
  ProjectChangeset,
  WorkspacesChangesetSnapshot,
} from "@/lib/changeset-types";

const SECTION_KIND = "dashes";

/** The dot's box in the Lens rail — the compact tier, matched to the row's
 *  single line rather than to the Cards section's monitor rows. */
const DASH_DOT_SIZE = 10;

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

/** One unbound dash, flattened out of the aggregate for the section's list. */
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
  /** When the dash was last touched, ISO-8601 UTC, or null for a dash whose
   *  generation has logged nothing. Sorted on raw, formatted at render. */
  lastActivity: string | null;
  /** The dash plan's review state (`reviewed` | `stale` | `never-reviewed`),
   *  or null when the dash records no plan or the server had nothing to say. */
  review: string | null;
  /** The owning project's directory — what a bind has to name, and the test
   *  for whether a given card's session may take this dash on. */
  projectDir: string;
  /** The owning project's name. Always present: an unbound dash may belong to a
   *  project with nothing else on screen, so the label is orientation rather
   *  than disambiguation. */
  projectLabel: string;
}

function rowFromEntry(
  entry: DashChangesetEntry,
  project: ProjectChangeset,
): DashRow {
  return {
    ownerId: entry.owner_id,
    name: entry.display_name,
    stage: entry.stage ?? null,
    steps:
      entry.step_current !== undefined && entry.step_total !== undefined
        ? `step ${entry.step_current}/${entry.step_total}`
        : null,
    stepTitle: entry.step_title ?? null,
    lastActivity: entry.last_activity ?? null,
    review: entry.review ?? null,
    projectDir: project.project_dir,
    projectLabel: project.display_name,
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
 * Two ISO-8601 UTC instants, newest first, with absent sorting **last**.
 *
 * A raw string comparison is the whole implementation: the timestamps are UTC
 * with a fixed-width layout, so lexical order is chronological order and no
 * `Date` is ever parsed here. Absent-last keeps dashes created before creation
 * wrote a birth record from claiming the top of every stage band.
 */
function compareIsoDesc(a: string | null, b: string | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return b.localeCompare(a);
}

/**
 * The section's total order: stage rank descending, then freshest first, then
 * by name.
 */
export function compareDashRows(a: DashRow, b: DashRow): number {
  const byStage = stageRank(b.stage) - stageRank(a.stage);
  if (byStage !== 0) return byStage;
  const byAge = compareIsoDesc(a.lastActivity, b.lastActivity);
  if (byAge !== 0) return byAge;
  return a.name.localeCompare(b.name);
}

/**
 * Every **unbound** dash across every open project, ordered by
 * {@link compareDashRows}.
 *
 * The filter is the partition law: a dash with any live bound session is the
 * Cards section's to show, and never appears here. An older sender omits
 * `bound_sessions` entirely, which reads as unbound — the honest answer, since
 * nothing has claimed anybody is working it.
 *
 * Project grouping is not an ordering key: the project label rides each row,
 * and grouping by project would bury a dash that is one gesture from landing
 * under one created a week ago in another repo.
 */
export function dashRowsFromSnapshot(
  snapshot: WorkspacesChangesetSnapshot,
): DashRow[] {
  const rows = snapshot.projects.flatMap((project) =>
    project.changesets
      .filter((entry): entry is DashChangesetEntry => entry.kind === "dash")
      .filter((entry) => (entry.bound_sessions ?? []).length === 0)
      .map((entry) => rowFromEntry(entry, project)),
  );
  // `flatMap` already allocated this array; the snapshot it was projected from
  // is never touched.
  return rows.sort(compareDashRows);
}

/** The band's one-line reading when the section is collapsed. */
export function dashesCollapsedSummary(rows: readonly DashRow[]): string {
  // Unreachable while the section hides itself when empty ([P03]), and kept
  // anyway: a summary that reads as a crash when its own premise changes is
  // worse than one sentence nobody sees.
  if (rows.length === 0) return "No unbound dashes";
  return `${rows.length} unbound`;
}

// ---------------------------------------------------------------------------
// Leaves
// ---------------------------------------------------------------------------

/** The unbound mark: a quiet glyph, deliberately not a dot at rest — a dash
 *  nobody is working is not a state of work. Unconditional here, because every
 *  row in this section is unbound by construction. */
function DashUnboundMark(): React.ReactElement {
  return (
    <TugTooltip content="Unbound — no live session is working this dash">
      <span
        className="lens-dashes-unbound"
        data-slot="lens-dashes-unbound"
        aria-label="Unbound"
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
interface UnboundVerbs {
  requestDiscard: (row: DashRow, anchor: HTMLElement | null) => void;
}

const UnboundVerbsContext = React.createContext<UnboundVerbs | null>(null);

/**
 * Take this dash on.
 *
 * The press reports **nothing locally**, and that is the point: on success the
 * row leaves the section, and on the last unbound dash the section unmounts —
 * so a pending state or an error slot on the row would be reporting into a
 * component that is already gone. Success is legible as the row leaving;
 * a server-side refusal arrives on the card-level `dash-bind-error-store`
 * surface, which outlives both.
 */
function BindControl({ row }: { row: DashRow }): React.ReactElement {
  const target = useBindTarget(row);
  return (
    // The tooltip wraps a SPAN, not the button: a disabled button takes no
    // pointer events, so its own tooltip would never fire — and an unreachable
    // reason is not a reason ([L31]).
    <TugTooltip content={target.reason ?? `Bind ${row.name} to the focused session`}>
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
              dash: row.name,
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
  const verbs = React.useContext(UnboundVerbsContext);
  if (verbs === null) return null;
  return (
    <TugTooltip content={`Discard ${row.name} — its branch and worktree`}>
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

const DashCell: TugListViewCellRenderer<DashRowsDataSource> = ({
  index,
  dataSource,
}: TugListViewCellProps<DashRowsDataSource>) => {
  const row = dataSource.rows[index];
  if (row === undefined) return null;
  // Read at render, with no ticker ([P08]): the value changes at most hourly at
  // these units, and the aggregate's own recompute repaints the row.
  const age = formatDashAge(row.lastActivity, Date.now());
  return (
    <TugListRow
      className="lens-dashes-row"
      variant="flush"
      density="compact"
      data-slot="lens-dashes-row"
      data-dash={row.name}
      data-unbound="true"
      data-age={age ?? undefined}
      leading={<DashUnboundMark />}
      trailing={
        <span className="lens-dashes-verbs" data-slot="lens-unbound-verbs">
          <BindControl row={row} />
          <DiscardControl row={row} />
        </span>
      }
    >
      <span className="lens-dashes-facts">
        {/* The name reads first and wears its sigil, the same run a session
            identity carries — a dash is named one way everywhere. */}
        <DashSigil
          name={row.name}
          review={row.review}
          slot="lens-unbound-name"
        />
        {row.steps !== null ? (
          <span className="lens-dashes-step">{row.steps}</span>
        ) : null}
        {row.stepTitle !== null ? (
          <span className="lens-dashes-step-title">{row.stepTitle}</span>
        ) : null}
        {/* Everything the reader needs to place the dash, and nothing they
            need to read first: stage, staleness, whose project, and the
            review advisory when it has something to say. */}
        <span className="lens-dashes-meta" data-slot="lens-unbound-meta">
          {row.stage !== null ? (
            <span className="lens-dashes-stage">{row.stage}</span>
          ) : null}
          {age !== null ? (
            <span className="lens-dashes-age" data-slot="lens-unbound-age">
              {age}
            </span>
          ) : null}
          <span className="lens-dashes-project">{row.projectLabel}</span>
          {dashReviewPaints(row.review) ? (
            <DashReviewMark review={row.review!} size={DASH_DOT_SIZE + 2} />
          ) : null}
        </span>
      </span>
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

/**
 * The section's one discard round trip, keyed by the section rather than by
 * row.
 *
 * Section-keyed on purpose, matching the Changes lane's card-keyed slot: one
 * discard at a time is the right number, and the state lives in a module store
 * that outlives this body — which matters here more than it does there, because
 * discarding the last unbound dash takes the whole section away.
 */
const UNBOUND_DISCARD_KEY = "lens-unbound-dashes";

function DashesSectionBody({ host }: { host: LensSectionHost }): React.ReactElement {
  const rows = useDashRows();
  const dataSource = useMemo(() => new DashRowsDataSource(rows), [rows]);
  const populated = rows.length > 0;

  const discardVerb = useChangesetDiscard(UNBOUND_DISCARD_KEY);
  // Which row's discard is armed, and the element the confirm hangs off. View
  // scope ([L24]): a half-armed confirm is not worth remembering, and closing
  // the Lens forgets it.
  const [pendingDiscard, setPendingDiscard] = useState<{
    row: DashRow;
    anchor: HTMLElement | null;
  } | null>(null);
  const verbs = useMemo<UnboundVerbs>(
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

  // Activation moves the cursor and nothing else. The walk this replaced went
  // looking for a card working the dash — which for an unbound dash is by
  // definition none, so it was a guaranteed silent no-op on every row this
  // section now holds ([L31]). Its verbs are named controls on the row instead.
  const delegate = useMemo<TugListViewDelegate>(() => ({}), []);

  // Unreachable while the section's `presence` hook hides it when empty; a body
  // that renders nothing is still the honest answer if that ever changes.
  if (!populated) return <></>;

  return (
    <UnboundVerbsContext value={verbs}>
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
              ? `Discard ${pendingDiscard.row.name}? Its branch and worktree go with it, and any uncommitted work in the worktree is handed back to the base checkout.`
              : ""
          }
          confirmLabel="Discard"
          confirmRole="danger"
          side="top"
          onConfirm={() => {
            const armed = pendingDiscard;
            setPendingDiscard(null);
            if (armed !== null) {
              discardVerb.discard(armed.row.projectDir, armed.row.name);
            }
          }}
          onCancel={() => setPendingDiscard(null)}
        />
      </div>
    </UnboundVerbsContext>
  );
}

/** Register the Unbound Dashes section. Called once at boot from `main.tsx`. */
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
    title: "Unbound Dashes",
    collapsedSummary: () => <DashesCollapsedSummary />,
    body: (host) => <DashesSectionBody host={host} />,
    // No unbound dashes is the everyday state, and an inbox at zero costs zero
    // rail height ([P03]). Evaluated by the always-mounted probe, never here.
    presence: () => useDashRows().length > 0,
  });
}
