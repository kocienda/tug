/**
 * memory-sheet.tsx — the `/memory` listing sheet ([#step-12a]).
 *
 * Mirrors Claude Code's `/memory`: a short list of memory destinations —
 * Project memory (`<cwd>/CLAUDE.md`), User memory (`~/.claude/CLAUDE.md`), and
 * the Auto-memory folder. Selecting a row **hands the path to the OS** (a file
 * opens in its default editor, a folder in Finder) via {@link openPathInOS}.
 * Editing happens in the OS app — there is no in-app editor and no write-back
 * (a future project).
 *
 * Pure projection ([L02]): the destinations derive from the session cwd
 * (`SessionMetadataStore.cwd`) read through `useSyncExternalStore`. Unlike the
 * read-only `/skills` / `/agents` listings, these rows ARE interactive — a
 * click is an action (open in the OS), so the list keeps its default
 * interactive affordance and routes activation through `delegate.onSelect`.
 *
 * Compositional — composes `TugSheet` (via the card's shared `showSheet`),
 * `TugSheetScaffold`, `TugListView`, `TugListRow`, `TugPushButton`; composed
 * children keep their own tokens ([L20]).
 *
 * Laws: [L02] store reads via `useSyncExternalStore`, [L06] appearance via
 *       CSS, [L20] composed children keep tokens.
 * Decisions: [D04] SessionMetadataStore hub, [D15] pane sheets are overlays.
 *
 * @module components/tugways/cards/memory-sheet
 */

import "./memory-sheet.css";

import React, { useCallback, useMemo, useSyncExternalStore } from "react";
import { ExternalLink, FolderOpen } from "lucide-react";

import { TugPushButton } from "@/components/tugways/tug-push-button";
import { TugListRow } from "@/components/tugways/tug-list-row";
import {
  TugListView,
  type TugListViewCellProps,
  type TugListViewCellRenderer,
  type TugListViewDataSource,
  type TugListViewDelegate,
} from "@/components/tugways/tug-list-view";
import type { ShowSheetOptions } from "@/components/tugways/tug-sheet";
import { TugSheetScaffold } from "@/components/tugways/tug-sheet-scaffold";
import { useSeedKeyView } from "@/components/tugways/use-focusable";
import type { SessionMetadataStore } from "@/lib/session-metadata-store";
import {
  type MemoryDestination,
  memoryDestinations,
} from "@/lib/memory-destinations";
import { openPathInOS } from "@/lib/os-open";
import { MODAL_REST_LINE } from "./modal-rest-line";

// ---------------------------------------------------------------------------
// useMemorySheet — the card-hosted /memory sheet
// ---------------------------------------------------------------------------

export interface UseMemorySheetArgs {
  /**
   * Supplies claude's resolved cwd (`system_metadata.cwd`). tugcode emits it
   * at spawn ([#step-12a]), so it's populated from the drop — the auto-memory
   * folder encodes correctly without waiting for the first turn.
   */
  sessionMetadataStore: SessionMetadataStore;
  /** The card's shared sheet host (`useTugSheet().showSheet`). */
  showSheet: (options: ShowSheetOptions) => Promise<string | undefined>;
}

export interface MemorySheetController {
  /** Present the `/memory` sheet. */
  openMemorySheet: () => void;
}

export function useMemorySheet({
  sessionMetadataStore,
  showSheet,
}: UseMemorySheetArgs): MemorySheetController {
  const openMemorySheet = useCallback(() => {
    void showSheet({
      title: "Memory",
      icon: "Brain",
      displayWidth: "md",
      presentation: "rise",
      bottomAnchorSelector: MODAL_REST_LINE,
      content: (close) => (
        <MemorySheetBody
          sessionMetadataStore={sessionMetadataStore}
          onClose={close}
        />
      ),
    });
  }, [sessionMetadataStore, showSheet]);

  return { openMemorySheet };
}

// ---------------------------------------------------------------------------
// List data source + cell — one row per memory destination
// ---------------------------------------------------------------------------

class MemoryDataSource implements TugListViewDataSource {
  private readonly dests: readonly MemoryDestination[];

  constructor(dests: readonly MemoryDestination[]) {
    this.dests = dests;
  }

  numberOfItems(): number {
    return this.dests.length;
  }

  idForIndex(index: number): string {
    return this.dests[index].id;
  }

  kindForIndex(): string {
    return "memory";
  }

  /** Cell-renderer accessor — the destination at `index`. */
  destAt(index: number): MemoryDestination {
    return this.dests[index];
  }

  subscribe(): () => void {
    return () => {};
  }

  getVersion(): unknown {
    return this.dests;
  }
}

/**
 * One memory-destination row — a flush `TugListRow`: the label over its
 * detail, with a trailing glyph cueing what activation does (an external-link
 * for a file → editor, a folder-open for the auto-memory folder → Finder).
 */
const MemoryCell: TugListViewCellRenderer<MemoryDataSource> = function MemoryCell({
  index,
  dataSource,
}: TugListViewCellProps<MemoryDataSource>): React.ReactElement {
  const dest = dataSource.destAt(index);
  return (
    <TugListRow
      variant="flush"
      title={dest.label}
      subtitle={dest.detail}
      trailing={
        <span className="memory-sheet-open" aria-hidden>
          {dest.kind === "folder" ? (
            <FolderOpen size={15} />
          ) : (
            <ExternalLink size={15} />
          )}
        </span>
      }
      data-testid="memory-row"
      data-memory={dest.id}
    />
  );
};

const MEMORY_CELL_RENDERERS: Record<
  string,
  TugListViewCellRenderer<MemoryDataSource>
> = {
  memory: MemoryCell,
};

// ---------------------------------------------------------------------------
// Sheet body — the destination list
// ---------------------------------------------------------------------------

interface MemorySheetBodyProps {
  sessionMetadataStore: SessionMetadataStore;
  onClose: (value?: string) => void;
}

function MemorySheetBody({
  sessionMetadataStore,
  onClose,
}: MemorySheetBodyProps): React.ReactElement {
  const meta = useSyncExternalStore(
    sessionMetadataStore.subscribe,
    sessionMetadataStore.getSnapshot,
  );
  // `meta.cwd` is claude's resolved cwd, emitted by tugcode at spawn — so the
  // auto-memory folder encodes to the exact on-disk directory from the drop.
  const dests = useMemo(() => memoryDestinations(meta.cwd), [meta.cwd]);
  const dataSource = useMemo(() => new MemoryDataSource(dests), [dests]);
  const delegate = useMemo<TugListViewDelegate>(
    () => ({ onSelect: (index) => openPathInOS(dests[index].path, dests[index].kind) }),
    [dests],
  );

  const header = (
    <div className="memory-sheet-header">
      <span className="memory-sheet-summary">
        Open a memory file in your editor, or the auto-memory folder in Finder.
      </span>
    </div>
  );

  // Author the controls into the sheet's trapped focus mode: Tab walks the file
  // list → Done, with Done seeded as the live default (filled+ring) on open.
  const focusGroup = React.useId();
  const LIST_ORDER = 0;
  const DONE_ORDER = 1;
  useSeedKeyView(`${focusGroup}:${DONE_ORDER}`);

  return (
    <TugSheetScaffold
      className="memory-sheet"
      header={header}
      footer={
        <div className="tug-sheet-actions">
          <TugPushButton
            size="sm"
            emphasis="primary"
            onClick={() => onClose()}
            data-testid="memory-done"
            focusGroup={focusGroup}
            focusOrder={DONE_ORDER}
          >
            Done
          </TugPushButton>
        </div>
      }
    >
      <TugListView<MemoryDataSource>
        dataSource={dataSource}
        delegate={delegate}
        cellRenderers={MEMORY_CELL_RENDERERS}
        rowLayout="flush"
        inline
        className="memory-sheet-list"
        focusGroup={focusGroup}
        focusOrder={LIST_ORDER}
      />
    </TugSheetScaffold>
  );
}
