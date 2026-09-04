/**
 * arc-picker-sheet.tsx — bare `/arc-bind`'s picker, when the project holds
 * more than one arc.
 *
 * Picking which arc to work on is a UI-concept act with no turn and no durable
 * consequence, exactly like the `bind_arc` it performs ([P01]) — so it is a
 * sheet on the card's existing host and never transcript ink. A disposable
 * choice does not belong permanently in the record.
 *
 * The list owns its cursor: `TugListView` in `singleSelect` mode with
 * `commitOnEnter="act"` gives arrow motion, Return, and click for free ([L19]),
 * and the card's own arc seeds the selection so Return with no arrow presses
 * is a no-op rebind rather than a surprise. Nothing here mirrors the selection
 * into React state.
 *
 * The sheet resolves with no value. The bind's outcome arrives through the
 * `bind_arc_ok` broadcast and the card-scoped bind-error store, both of which
 * outlive the sheet — which is why dismissing it mid-bind is harmless.
 *
 * Laws: [L06] appearance is CSS on data attributes; [L19] composes
 * `TugListView` / `TugListRow` rather than hand-rolling list focus; [L20]
 * composed children keep their own tokens.
 *
 * @module components/tugways/cards/arc-picker-sheet
 */

import "./arc-picker-sheet.css";

import React, { useMemo, useRef } from "react";

import { TugListRow } from "@/components/tugways/tug-list-row";
import { TugArcAtom } from "@/components/tugways/tug-arc-atom";
import { ArcWorkerAtom } from "@/components/tugways/arc-lifecycle-block";
import { TugMetaRun } from "@/components/tugways/tug-meta-run";
import {
  TugListView,
  type TugListViewCellProps,
  type TugListViewCellRenderer,
  type TugListViewDataSource,
  type TugListViewDelegate,
  type TugListViewHandle,
} from "@/components/tugways/tug-list-view";
import { useSeedKeyView } from "@/components/tugways/use-focusable";
import { arcReviewPaints } from "@/lib/arc-review";
import type { ArcChangesetEntry } from "@/lib/changeset-types";

export interface ArcPickerSheetProps {
  /** This project's arc entries, in the snapshot's order — the picker does
   *  not apply the Arcs card's ordering, which is that surface's presentation
   *  choice rather than a property of the arcs. */
  arcs: readonly ArcChangesetEntry[];
  /** Owner key of this card's current arc: marks the row and seeds the
   *  selection. Null when the card is unbound. */
  boundArcId: string | null;
  /** Send the bind. The sheet closes immediately afterwards and awaits
   *  nothing — the ack is the mover, not this callback. */
  onPick: (entry: ArcChangesetEntry) => void;
  /** Dismiss the sheet. */
  onClose: (value?: string) => void;
}

function roundsLabel(rounds: number): string {
  return rounds === 1 ? "1 round" : `${rounds} rounds`;
}

/** A flat, immutable source over one render's entries. */
class ArcPickerDataSource implements TugListViewDataSource {
  constructor(
    readonly arcs: readonly ArcChangesetEntry[],
    readonly boundArcId: string | null,
  ) {}
  numberOfItems(): number {
    return this.arcs.length;
  }
  idForIndex(index: number): string {
    return this.arcs[index]!.owner_id;
  }
  kindForIndex(): string {
    return "arc";
  }
  subscribe(): () => void {
    return () => {};
  }
  getVersion(): unknown {
    return this.arcs;
  }
}

const ArcPickerCell: TugListViewCellRenderer<ArcPickerDataSource> = ({
  index,
  dataSource,
}: TugListViewCellProps<ArcPickerDataSource>) => {
  const entry = dataSource.arcs[index];
  if (entry === undefined) return null;
  const current = entry.owner_id === dataSource.boundArcId;
  return (
    <TugListRow
      variant="flush"
      density="compact"
      data-slot="arc-picker-row"
      data-arc={entry.display_name}
      data-current={current ? "true" : undefined}
      // The eyebrow's identities, in the grammar every arc surface wears: the
      // arc atom, then one worker atom per bound session. Who is working a
      // arc is the fact this picker exists to weigh, and reading it off
      // `title` as bare text made every candidate look identical in the one
      // place a reader is choosing between them.
      leading={
        <span className="arc-picker-identity">
          <TugArcAtom name={entry.display_name} />
          {(entry.bound_sessions ?? []).map((sessionId) => (
            <ArcWorkerAtom key={sessionId} sessionId={sessionId} />
          ))}
        </span>
      }
      trailing={
        current ? (
          <span className="arc-picker-current" data-slot="arc-picker-current">
            current
          </span>
        ) : undefined
      }
    >
      <TugMetaRun
        className="arc-picker-facts"
        slot="arc-picker-facts"
        parts={[
          entry.stage !== undefined ? <span>{entry.stage}</span> : null,
          <span>{roundsLabel(entry.rounds)}</span>,
          entry.worktree_dirty ? (
            <span className="arc-picker-uncommitted">uncommitted</span>
          ) : null,
          arcReviewPaints(entry.review, entry.task_list ?? false) ? (
            <span className="arc-picker-review" data-review={entry.review}>
              {entry.review === "stale" ? "plan stale" : "plan unreviewed"}
            </span>
          ) : null,
        ]}
      />
    </TugListRow>
  );
};

const ARC_PICKER_CELL_RENDERERS = { arc: ArcPickerCell };

export function ArcPickerSheet({
  arcs,
  boundArcId,
  onPick,
  onClose,
}: ArcPickerSheetProps): React.ReactElement {
  const listRef = useRef<TugListViewHandle | null>(null);
  const focusGroup = React.useId();
  // The list IS the sheet — there is nothing else to focus — so it takes the
  // key view on open. Without this the arrows and Return go to whatever held
  // focus before the sheet rose, and the picker would be click-only.
  useSeedKeyView(`${focusGroup}:0`);
  const dataSource = useMemo(
    () => new ArcPickerDataSource(arcs, boundArcId),
    [arcs, boundArcId],
  );
  // The card's own arc is where the cursor starts, so Return with no arrow
  // presses rebinds to what the card already holds — a no-op — rather than to
  // whichever arc git happened to enumerate first.
  const currentIndex = useMemo(() => {
    const found = arcs.findIndex((entry) => entry.owner_id === boundArcId);
    return found === -1 ? 0 : found;
  }, [arcs, boundArcId]);

  const delegate = useMemo<TugListViewDelegate>(() => {
    const pick = (index: number): void => {
      const entry = arcs[index];
      if (entry === undefined) return;
      onPick(entry);
      onClose();
    };
    return { onSelect: pick, onActivate: pick };
  }, [arcs, onPick, onClose]);

  return (
    <div className="arc-picker-sheet" data-slot="arc-picker-sheet">
      <TugListView<ArcPickerDataSource>
        ref={listRef}
        dataSource={dataSource}
        delegate={delegate}
        cellRenderers={ARC_PICKER_CELL_RENDERERS}
        rowLayout="flush"
        focusGroup={focusGroup}
        focusOrder={0}
        singleSelect
        initialSelectedIndex={currentIndex}
        commitOnEnter="act"
        className="arc-picker-list"
      />
    </div>
  );
}
