/**
 * spike-session-chooser.tsx — what does Choose Session look like with no
 * project step at all: one list of sessions grouped by project, the workspace's
 * group open, each group carrying its own New session row?
 *
 * The shipped sheet seeds its path field from the globally most-recent project
 * (`seedPathFrom`), so a workspace for one project opens new sessions in
 * another; and it offers three live affordances — Browse, a typed completing
 * path, a chevron menu — for a choice that is nearly always one of four known
 * folders whose paths differ only at their tails.
 *
 * This spike draws the sheet as it would ship. It is built from the picker's
 * own parts rather than stand-ins: the sheet panel and header are the shipped
 * `.tug-sheet-*` markup at the picker's `lg` width; the body wears the
 * picker's `session-card-picker-*` classes; the filter field is `TugFilterField`
 * attached to the list the way the picker attaches it; the session rows are
 * `SessionIdentityRow` with the picker's exact knobs (stack dot, title-aligned
 * sub-lines, no tape, no pace, bounded description), fed mock ledger rows; the
 * trailing live badge and trash control, the Move-all-to-Trash row, and the
 * Cancel/Open actions are the picker's own. What is new is only what the design
 * adds: the project group row, the per-group New session row, the Other-folder
 * row, the Open button naming its project, and a taller list cap.
 *
 * Not drawn: the arc cluster on a row's title (`^arc`, phase pill, step
 * fraction), which needs a live arc track; mock rows ride with `arc={null}`.
 *
 * Interactions that work here: click a group row to fold or unfold it; type in
 * the filter to trim rows across every group (filtering unfolds all of them);
 * click a row to select it; the Open button follows the selection's project.
 */

import "./spike.css";
import "./spike-session-chooser.css";
import "@/components/tugways/tug-sheet.css";
import "@/components/tugways/cards/session-card.css";

import React, { useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, FolderOpen, FolderPlus, Trash2 } from "lucide-react";

import { useAttachedFilter } from "@/components/tugways/attached-filter";
import { SessionIdentityRow } from "@/components/tugways/session-identity-row";
import { TugBadge } from "@/components/tugways/tug-badge";
import { TugFilterField } from "@/components/tugways/tug-filter-field";
import { TugLabel } from "@/components/tugways/tug-label";
import { TugListRow } from "@/components/tugways/tug-list-row";
import {
  TugListView,
  type TugListViewCellProps,
  type TugListViewCellRenderer,
  type TugListViewDataSource,
  type TugListViewDelegate,
  type TugListViewHandle,
} from "@/components/tugways/tug-list-view";
import { TugPath } from "@/components/tugways/tug-path";
import { TugPushButton } from "@/components/tugways/tug-push-button";
import { TUG_SESSION_ROW_STACK_DOT_SIZE } from "@/components/tugways/tug-session-row";
import { caseInsensitiveSubstring } from "@/lib/text-match";
import type { SessionRow } from "@/protocol";

import type { SpikeDef } from "./spike-registry";

// ---------------------------------------------------------------------------
// Mock ledger — four projects, the first bound by a card in this workspace
// ---------------------------------------------------------------------------

interface MockProject {
  name: string;
  path: string;
  /** Bound by a card in the workspace the sheet opened from. */
  inWorkspace: boolean;
  sessions: SessionRow[];
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = Date.now();

function row(
  project: string,
  tag: string,
  prompt: string,
  opts: {
    turns: number;
    bytes: number;
    ago: number;
    live?: boolean;
    synopsis?: string;
  },
): SessionRow {
  return {
    session_id: `${project}-${tag}`,
    line_id: `${project}-${tag}`,
    workspace_key: project,
    project_dir: project,
    created_at: NOW - opts.ago - 3 * HOUR,
    last_used_at: NOW - opts.ago,
    turn_count: opts.turns,
    last_user_prompt: prompt,
    state: opts.live === true ? "live" : "closed",
    card_id: null,
    background: false,
    name: null,
    name_user_set: false,
    tag,
    synopsis: opts.synopsis ?? null,
    origin: "tug",
    terminal_live: null,
    file_size: opts.bytes,
  };
}

const PROJECTS: readonly MockProject[] = [
  {
    name: "tug",
    path: "/Users/kocienda/Mounts/u/src/tug",
    inWorkspace: true,
    sessions: [
      row("tug", "happy-tunic", "Move card chrome out of the shell and into each card", {
        turns: 3, bytes: 6_000_000, ago: 4 * MIN, live: true,
      }),
      row("tug", "spruce-latte", "Audit the host channel and body deck arc before its join", {
        turns: 21, bytes: 34_000_000, ago: 9 * MIN,
      }),
      row("tug", "quiet-harbor", "Seed the session picker from the workspace's project", {
        turns: 8, bytes: 2_100_000, ago: 14 * HOUR,
      }),
      row("tug", "iron-pelican", "Why does the fold's last frame land late on the user deck?", {
        turns: 44, bytes: 61_000_000, ago: DAY + 2 * HOUR,
      }),
      row("tug", "velvet-crane", "Write a brief for the Window menu sidebar rows", {
        turns: 5, bytes: 900_000, ago: 2 * DAY,
      }),
    ],
  },
  {
    name: "eucit",
    path: "/Users/kocienda/Mounts/u/src/eucit",
    inWorkspace: false,
    sessions: [
      row("eucit", "curly-apple", "Index the 1921 register and link it from the archive page", {
        turns: 12, bytes: 9_300_000, ago: 2 * DAY, live: true,
      }),
      row("eucit", "brass-fern", "Fix the archive importer's date parsing for pre-1900 entries", {
        turns: 4, bytes: 1_200_000, ago: 3 * DAY,
      }),
      row("eucit", "mild-otter", "Add a search box to the people index", {
        turns: 16, bytes: 7_800_000, ago: 6 * DAY,
      }),
    ],
  },
  {
    name: "kocienda.com",
    path: "/Users/kocienda/Sites/kocienda.com",
    inWorkspace: false,
    sessions: [
      row("kocienda.com", "pale-reef", "Rewrite the About page", {
        turns: 6, bytes: 800_000, ago: 8 * DAY,
      }),
    ],
  },
  {
    name: "notes",
    path: "/Users/kocienda/Documents/notes",
    inWorkspace: false,
    sessions: [],
  },
];

function liveCount(p: MockProject): number {
  return p.sessions.filter((s) => s.state === "live").length;
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

type ChooserRow =
  | { kind: "group"; id: string; project: MockProject; expanded: boolean }
  | { kind: "new"; id: string; project: MockProject }
  | { kind: "session"; id: string; project: MockProject; session: SessionRow }
  | { kind: "other"; id: string };

class RowsDataSource implements TugListViewDataSource {
  constructor(readonly rows: readonly ChooserRow[]) {}
  numberOfItems(): number {
    return this.rows.length;
  }
  idForIndex(index: number): string {
    return this.rows[index]!.id;
  }
  kindForIndex(index: number): string {
    return this.rows[index]!.kind;
  }
  subscribe(): () => void {
    return () => {};
  }
  getVersion(): unknown {
    return this.rows;
  }
}

interface CellContextValue {
  selection: string | null;
  filterQuery: string;
}
const CellContext = React.createContext<CellContextValue>({
  selection: null,
  filterQuery: "",
});

function useRow<K extends ChooserRow["kind"]>(
  props: TugListViewCellProps<RowsDataSource>,
  kind: K,
): Extract<ChooserRow, { kind: K }> {
  const r = props.dataSource.rows[props.index];
  if (r === undefined || r.kind !== kind) {
    throw new Error(`spike-session-chooser: row ${props.index} is not ${kind}`);
  }
  return r as Extract<ChooserRow, { kind: K }>;
}

/**
 * The project band. A row in the list rather than a header outside it, so the
 * keyboard cursor reaches it and a click folds the group. The name is the
 * basename, in the sans face at title weight; the path is the mono run that
 * the shipped sheet made the whole control, here dimmed beneath where a reader
 * confirms rather than reads it.
 */
const GroupCell: TugListViewCellRenderer<RowsDataSource> = (props) => {
  const r = useRow(props, "group");
  const live = liveCount(r.project);
  const count = r.project.sessions.length;
  return (
    <TugListRow
      variant="flush"
      className="sp-sc-group"
      data-expanded={r.expanded ? "true" : "false"}
      data-workspace={r.project.inWorkspace ? "true" : undefined}
      leading={
        <span className="sp-sc-group-chevron" aria-hidden="true">
          {r.expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </span>
      }
      trailing={
        <span className="sp-sc-group-facts">
          {r.project.inWorkspace ? (
            <TugBadge emphasis="tinted" role="action" size="sm">
              this workspace
            </TugBadge>
          ) : null}
          <span className="sp-sc-group-count">
            {live > 0 ? `${live} live · ` : ""}
            {count === 0 ? "no sessions" : count === 1 ? "1 session" : `${count} sessions`}
          </span>
        </span>
      }
      trailingReveal="always"
    >
      {/* The row's own title/subtitle slots clamp through a `TugLabel`, and a
          clamped label sizes a path to fit rather than to the line. The band
          composes the two lines itself: a one-line label for the name, and
          `TugPath` straight in the content column, where it takes the column's
          width and ellipsizes in the middle only when the sheet is narrower
          than the path — the same mount the masthead gives a path. */}
      <TugLabel className="sp-sc-group-name" size="md" maxLines={1}>
        {r.project.name}
      </TugLabel>
      <TugPath className="sp-sc-group-path" path={r.project.path} />
    </TugListRow>
  );
};

const NewCell: TugListViewCellRenderer<RowsDataSource> = (props) => {
  const r = useRow(props, "new");
  const { selection } = React.useContext(CellContext);
  return (
    <TugListRow
      className="sp-sc-new"
      title={`New session in ${r.project.name}`}
      selected={selection === r.id}
    />
  );
};

/** The shipped resume cell, with its context read from this spike's own. */
const SessionCell: TugListViewCellRenderer<RowsDataSource> = (props) => {
  const r = useRow(props, "session");
  const { selection, filterQuery } = React.useContext(CellContext);
  const s = r.session;
  const isLive = s.state === "live";
  const badge = isLive ? (
    <TugBadge emphasis="tinted" role="action">
      live
    </TugBadge>
  ) : null;
  const trash = !isLive ? (
    <TugPushButton
      subtype="icon"
      emphasis="ghost"
      role="danger"
      icon={<Trash2 size={14} aria-hidden="true" />}
      aria-label={`Move session ${s.tag} to Trash`}
      title={`Move session ${s.tag} to Trash`}
      className="session-card-picker-session-trash"
    />
  ) : null;
  return (
    <SessionIdentityRow
      className="session-card-picker-session-row"
      sessionId={s.session_id}
      identityContext={{
        projectDir: r.project.path,
        state: s.state,
        recordedTag: s.tag,
        recordedProject: r.project.name,
      }}
      row={s}
      arc={null}
      dotSize={TUG_SESSION_ROW_STACK_DOT_SIZE}
      subAlign="title"
      tape={false}
      pace={false}
      beats={false}
      currency={false}
      descriptionMaxChars={96}
      highlight={filterQuery}
      selected={selection === r.id}
      disabled={isLive}
      trailing={
        badge !== null || trash !== null ? (
          <>
            {badge}
            {trash}
          </>
        ) : undefined
      }
      trailingReveal={badge !== null ? "always" : "engaged"}
      data-state={s.state}
    />
  );
};

/** The one door left to a folder the list does not know. */
const OtherCell: TugListViewCellRenderer<RowsDataSource> = (props) => {
  useRow(props, "other");
  return (
    <TugListRow
      className="sp-sc-other"
      leading={<FolderPlus size={14} aria-hidden="true" />}
      title="New session in another folder…"
      subtitle="Type a path, or choose one with Browse"
    />
  );
};

const CELL_RENDERERS = {
  group: GroupCell,
  new: NewCell,
  session: SessionCell,
  other: OtherCell,
};

// ---------------------------------------------------------------------------
// The sheet
// ---------------------------------------------------------------------------

function sessionMatches(s: SessionRow, project: MockProject, q: string): boolean {
  if (q === "") return true;
  const hay = [
    `${project.name}/${s.tag ?? ""}`,
    s.last_user_prompt ?? "",
    s.synopsis ?? "",
  ];
  return hay.some((h) => caseInsensitiveSubstring(q, h) !== null);
}

function ChooseSessionSheet(): React.ReactElement {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set(PROJECTS.filter((p) => p.inWorkspace).map((p) => p.name)),
  );
  const [selection, setSelection] = useState<string | null>(
    `new:${PROJECTS[0]!.name}`,
  );
  const [filterQuery, setFilterQuery] = useState("");

  const listRef = useRef<TugListViewHandle>(null);
  const filter = useAttachedFilter(() => listRef.current);
  const filterDelegate = useMemo(
    () => ({
      filterFieldDidChangeQuery: setFilterQuery,
      ...filter.delegate,
    }),
    [filter],
  );

  const q = filterQuery.trim();
  const rows = useMemo<ChooserRow[]>(() => {
    const out: ChooserRow[] = [];
    for (const p of PROJECTS) {
      const sessions = p.sessions.filter((s) => sessionMatches(s, p, q));
      // A filter unfolds every group it matches in, and hides the ones it
      // does not: the reader asked for rows, not for structure.
      if (q !== "" && sessions.length === 0) continue;
      const open = q !== "" || expanded.has(p.name);
      out.push({ kind: "group", id: `g:${p.name}`, project: p, expanded: open });
      if (!open) continue;
      if (q === "") out.push({ kind: "new", id: `new:${p.name}`, project: p });
      for (const s of sessions) {
        out.push({ kind: "session", id: `s:${s.session_id}`, project: p, session: s });
      }
    }
    if (q === "") out.push({ kind: "other", id: "other" });
    return out;
  }, [expanded, q]);

  const dataSource = useMemo(() => new RowsDataSource(rows), [rows]);
  const delegate = useMemo<TugListViewDelegate>(
    () => ({
      onSelect: (index: number) => {
        const r = rows[index];
        if (r === undefined) return;
        if (r.kind === "group") {
          setExpanded((prev) => {
            const next = new Set(prev);
            if (next.has(r.project.name)) next.delete(r.project.name);
            else next.add(r.project.name);
            return next;
          });
          return;
        }
        if (r.kind === "other") return;
        setSelection(r.id);
      },
    }),
    [rows],
  );

  const cellContext = useMemo<CellContextValue>(
    () => ({ selection, filterQuery: q }),
    [selection, q],
  );

  const chosen =
    rows.find(
      (r): r is Extract<ChooserRow, { kind: "new" | "session" }> =>
        (r.kind === "new" || r.kind === "session") && r.id === selection,
    )?.project ?? null;
  const nonLive = chosen === null ? 0 : chosen.sessions.filter((s) => s.state !== "live").length;

  return (
    <div className="tug-sheet-content sp-sc-sheet" data-display-width="lg">
      <div className="tug-sheet-header">
        <div className="tug-sheet-icon" aria-hidden="true">
          <FolderOpen />
        </div>
        <div className="tug-sheet-heading">
          <h2 className="tug-sheet-title">Choose Session</h2>
        </div>
      </div>
      <div className="session-card-picker-form">
        <CellContext.Provider value={cellContext}>
          <div className="session-card-picker-section">
            <span className="session-card-picker-label">
              Sessions
              <TugFilterField
                className="session-card-picker-filter"
                delegate={filterDelegate}
                attachment={filter}
                placeholder="Filter sessions"
              />
            </span>
            <div className="session-card-picker-sessions-host">
              <TugListView<RowsDataSource>
                ref={listRef}
                dataSource={dataSource}
                delegate={delegate}
                cellRenderers={CELL_RENDERERS}
                scrollKey="sp-sc-sessions"
                rowLayout="flush"
                className="session-card-picker-sessions-list session-card-picker-list-view sp-sc-list"
                attachedFilter={filter}
              />
            </div>
            <div
              className="session-card-picker-trash-all"
              data-disabled={nonLive === 0 ? "true" : undefined}
            >
              <TugLabel emphasis="proposal">
                {chosen === null
                  ? "Move all sessions to Trash"
                  : `Move all sessions in ${chosen.name} to Trash`}
              </TugLabel>
              <TugPushButton
                subtype="icon"
                emphasis="ghost"
                role="danger"
                icon={<Trash2 size={16} aria-hidden="true" />}
                disabled={nonLive === 0}
                aria-label="Move all sessions to Trash"
              />
            </div>
          </div>
        </CellContext.Provider>
        <div className="tug-sheet-actions">
          <TugPushButton size="sm" emphasis="outlined" role="action">
            Cancel
          </TugPushButton>
          <TugPushButton
            size="sm"
            emphasis="primary"
            role="action"
            disabled={chosen === null}
            persistentDefaultRing
          >
            {chosen === null ? "Open" : `Open in ${chosen.name}`}
          </TugPushButton>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The spike
// ---------------------------------------------------------------------------

function SpikeSessionChooser(): React.ReactElement {
  return (
    <div className="sp-content sp-sc-content">
      <section className="sp-section">
        <h2 className="sp-section-title">Choose Session, grouped by project</h2>
        <p className="sp-sc-blurb">
          No project step. The list is every session the ledger knows, grouped
          by project, the workspace&apos;s own group open and the rest folded.
          Each group carries its own New session row, so creating a session
          always names where it goes, and Open says the same. The folder the
          list does not know is the last row. Click a group to fold or unfold
          it; type to filter across every group.
        </p>
      </section>
      <section className="sp-section">
        <ChooseSessionSheet />
      </section>
    </div>
  );
}

export const spike: SpikeDef = {
  name: "session-chooser",
  title: "Session Chooser",
  blurb:
    "Choose Session with no project step: sessions grouped by project, the workspace's group open, each group with its own New session row.",
  icon: "FolderOpen",
  size: {
    min: { width: 600, height: 480 },
    preferred: { width: 820, height: 820 },
  },
  component: () => <SpikeSessionChooser />,
};
