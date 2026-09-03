/**
 * agents-sheet.tsx — the `/agents` read-only listing sheet ([#step-12b]).
 *
 * Mirrors Claude Code's `/agents`: a **Running** section (subagents executing
 * right now) above a **Library** section (the agents Claude can delegate to).
 * Both are read-only — creating / editing agents is out of scope (you ask
 * Claude to write the agent file directly), so there is no "Create new agent",
 * no editor. The two sections live in one `TugListView` via its section-header
 * role rather than a tab control, so both lists are visible at once.
 *
 * Two pure sources, no tugcode round-trip ([L02]):
 *  - **Running** from the live transcript ({@link selectRunningAgents} over the
 *    card's `CodeSessionStore` — pending `Task` calls).
 *  - **Library** from {@link selectLibraryAgents} (the built-in roster +
 *    plugin/user agents in the card's `SessionMetadataStore.slashCommands`).
 *
 * Compositional — composes `TugSheet` (via the card's shared `showSheet`),
 * `TugSheetScaffold`, `TugListView`, `TugListRow`, `TugPushButton`; composed
 * children keep their own tokens ([L20]).
 *
 * Laws: [L02] store reads via `useSyncExternalStore`, [L06] appearance via
 *       CSS, [L20] composed children keep tokens.
 * Decisions: [D04] SessionMetadataStore hub, [D15] pane sheets are overlays.
 *
 * @module components/tugways/cards/agents-sheet
 */

import "./agents-sheet.css";

import React, { useCallback, useMemo, useSyncExternalStore } from "react";

import { TugPushButton } from "@/components/tugways/tug-push-button";
import { TugListRow } from "@/components/tugways/tug-list-row";
import {
  TugListView,
  type TugListViewCellProps,
  type TugListViewCellRenderer,
  type TugListViewCellRole,
  type TugListViewDataSource,
} from "@/components/tugways/tug-list-view";
import type { ShowSheetOptions } from "@/components/tugways/tug-sheet";
import { TugSheetScaffold } from "@/components/tugways/tug-sheet-scaffold";
import { useSeedKeyView } from "@/components/tugways/use-focusable";
import type { SessionMetadataStore } from "@/lib/session-metadata-store";
import type { CodeSessionStore } from "@/lib/code-session-store";
import type { Message } from "@/lib/code-session-store/types";
import {
  type AgentEntry,
  type RunningAgentEntry,
  agentTrailingLabel,
  selectLibraryAgents,
  selectRunningAgents,
} from "@/lib/agents-list";
import { MODAL_REST_LINE } from "./modal-rest-line";

// ---------------------------------------------------------------------------
// useAgentsSheet — the card-hosted /agents sheet
// ---------------------------------------------------------------------------

export interface UseAgentsSheetArgs {
  /** Supplies the Library agent names (`slashCommands` category `"agent"`). */
  sessionMetadataStore: SessionMetadataStore;
  /** Supplies the live transcript for the Running section. */
  codeSessionStore: CodeSessionStore;
  /** The card's shared sheet host (`useTugSheet().showSheet`). */
  showSheet: (options: ShowSheetOptions) => Promise<string | undefined>;
}

export interface AgentsSheetController {
  /** Present the `/agents` sheet. */
  openAgentsSheet: () => void;
}

export function useAgentsSheet({
  sessionMetadataStore,
  codeSessionStore,
  showSheet,
}: UseAgentsSheetArgs): AgentsSheetController {
  const openAgentsSheet = useCallback(() => {
    void showSheet({
      title: "Agents",
      icon: "Bot",
      displayWidth: "lg",
      presentation: "rise",
      bottomAnchorSelector: MODAL_REST_LINE,
      content: (close) => (
        <AgentsSheetBody
          sessionMetadataStore={sessionMetadataStore}
          codeSessionStore={codeSessionStore}
          onClose={close}
        />
      ),
    });
  }, [sessionMetadataStore, codeSessionStore, showSheet]);

  return { openAgentsSheet };
}

// ---------------------------------------------------------------------------
// Sectioned row model + data source
// ---------------------------------------------------------------------------

type AgentRowKind = "section" | "running" | "running-empty" | "library";

interface AgentRow {
  id: string;
  kind: AgentRowKind;
  role: TugListViewCellRole;
  label?: string;
  running?: RunningAgentEntry;
  agent?: AgentEntry;
}

/** Lay out the Running section (rows or empty) above the Library section. */
function buildRows(
  running: readonly RunningAgentEntry[],
  library: readonly AgentEntry[],
): AgentRow[] {
  const rows: AgentRow[] = [
    { id: "sec-running", kind: "section", role: "header", label: "Running" },
  ];
  if (running.length === 0) {
    rows.push({
      id: "running-empty",
      kind: "running-empty",
      role: "cell",
      label: "No subagents are currently running.",
    });
  } else {
    for (const r of running) {
      rows.push({ id: `run-${r.toolUseId}`, kind: "running", role: "cell", running: r });
    }
  }
  rows.push({ id: "sec-library", kind: "section", role: "header", label: "Library" });
  for (const a of library) {
    rows.push({ id: `lib-${a.name}`, kind: "library", role: "cell", agent: a });
  }
  return rows;
}

/**
 * Static-per-render data source over the assembled rows. A store tick rebuilds
 * the rows (via the body's `useMemo`) → a fresh data source, so `subscribe` is
 * a no-op and `getVersion` returns the rows array reference.
 */
class AgentsDataSource implements TugListViewDataSource {
  private readonly rows: readonly AgentRow[];

  constructor(rows: readonly AgentRow[]) {
    this.rows = rows;
  }

  numberOfItems(): number {
    return this.rows.length;
  }

  idForIndex(index: number): string {
    return this.rows[index].id;
  }

  kindForIndex(index: number): string {
    return this.rows[index].kind;
  }

  roleForIndex(index: number): TugListViewCellRole {
    return this.rows[index].role;
  }

  /** Cell-renderer accessor — the row at `index`. */
  rowAt(index: number): AgentRow {
    return this.rows[index];
  }

  subscribe(): () => void {
    return () => {};
  }

  getVersion(): unknown {
    return this.rows;
  }
}

// ---------------------------------------------------------------------------
// Cell renderers
// ---------------------------------------------------------------------------

const SectionCell: TugListViewCellRenderer<AgentsDataSource> = function SectionCell({
  index,
  dataSource,
}: TugListViewCellProps<AgentsDataSource>): React.ReactElement {
  return (
    <div className="agents-sheet-section" data-testid="agents-section">
      {dataSource.rowAt(index).label}
    </div>
  );
};

const RunningEmptyCell: TugListViewCellRenderer<AgentsDataSource> =
  function RunningEmptyCell({
    index,
    dataSource,
  }: TugListViewCellProps<AgentsDataSource>): React.ReactElement {
    return (
      <div className="agents-sheet-empty" role="status">
        {dataSource.rowAt(index).label}
      </div>
    );
  };

const RunningCell: TugListViewCellRenderer<AgentsDataSource> = function RunningCell({
  index,
  dataSource,
}: TugListViewCellProps<AgentsDataSource>): React.ReactElement {
  const r = dataSource.rowAt(index).running!;
  return (
    <TugListRow
      variant="flush"
      title={r.subagentType}
      subtitle={r.description}
      data-testid="agent-running-row"
    />
  );
};

const LibraryCell: TugListViewCellRenderer<AgentsDataSource> = function LibraryCell({
  index,
  dataSource,
}: TugListViewCellProps<AgentsDataSource>): React.ReactElement {
  const agent = dataSource.rowAt(index).agent!;
  return (
    <TugListRow
      variant="flush"
      title={agent.name}
      trailing={
        <span className="agents-sheet-meta">{agentTrailingLabel(agent)}</span>
      }
      data-testid="agent-row"
      data-agent={agent.name}
    />
  );
};

const AGENTS_CELL_RENDERERS: Record<
  string,
  TugListViewCellRenderer<AgentsDataSource>
> = {
  section: SectionCell,
  "running-empty": RunningEmptyCell,
  running: RunningCell,
  library: LibraryCell,
};

// ---------------------------------------------------------------------------
// Sheet body — Running + Library sections
// ---------------------------------------------------------------------------

interface AgentsSheetBodyProps {
  sessionMetadataStore: SessionMetadataStore;
  codeSessionStore: CodeSessionStore;
  onClose: (value?: string) => void;
}

function AgentsSheetBody({
  sessionMetadataStore,
  codeSessionStore,
  onClose,
}: AgentsSheetBodyProps): React.ReactElement {
  const meta = useSyncExternalStore(
    sessionMetadataStore.subscribe,
    sessionMetadataStore.getSnapshot,
  );
  const code = useSyncExternalStore(
    codeSessionStore.subscribe,
    codeSessionStore.getSnapshot,
  );

  const library = useMemo(
    () => selectLibraryAgents(meta.slashCommands),
    [meta.slashCommands],
  );
  const running = useMemo(() => {
    const messages: Message[] = [
      ...code.transcript.flatMap((t) => t.messages),
      ...(code.activeTurn?.messages ?? []),
    ];
    return selectRunningAgents(messages);
  }, [code.transcript, code.activeTurn]);

  const rows = useMemo(() => buildRows(running, library), [running, library]);
  const dataSource = useMemo(() => new AgentsDataSource(rows), [rows]);

  // Seed the Done button as the sheet's live default (filled+ring) on open.
  const doneFocusGroup = React.useId();
  useSeedKeyView(`${doneFocusGroup}:0`);

  return (
    <TugSheetScaffold
      className="agents-sheet"
      footer={
        <div className="tug-sheet-actions">
          <TugPushButton
            size="sm"
            emphasis="primary"
            onClick={() => onClose()}
            data-testid="agents-done"
            focusGroup={doneFocusGroup}
            focusOrder={0}
          >
            Done
          </TugPushButton>
        </div>
      }
    >
      <TugListView<AgentsDataSource>
        dataSource={dataSource}
        cellRenderers={AGENTS_CELL_RENDERERS}
        rowLayout="flush"
        inline
        interactive={false}
        className="agents-sheet-list"
      />
    </TugSheetScaffold>
  );
}
