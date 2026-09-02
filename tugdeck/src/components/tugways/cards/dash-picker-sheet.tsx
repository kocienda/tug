/**
 * dash-picker-sheet.tsx — bare `/dash-bind`'s picker, when the project holds
 * more than one dash.
 *
 * Picking which dash to work on is a UI-concept act with no turn and no durable
 * consequence, exactly like the `bind_dash` it performs ([P01]) — so it is a
 * sheet on the card's existing host and never transcript ink. A disposable
 * choice does not belong permanently in the record.
 *
 * The list owns its cursor: `TugListView` in `singleSelect` mode with
 * `commitOnEnter="act"` gives arrow motion, Return, and click for free ([L19]),
 * and the card's own dash seeds the selection so Return with no arrow presses
 * is a no-op rebind rather than a surprise. Nothing here mirrors the selection
 * into React state.
 *
 * The sheet resolves with no value. The bind's outcome arrives through the
 * `bind_dash_ok` broadcast and the card-scoped bind-error store, both of which
 * outlive the sheet — which is why dismissing it mid-bind is harmless.
 *
 * Laws: [L06] appearance is CSS on data attributes; [L19] composes
 * `TugListView` / `TugListRow` rather than hand-rolling list focus; [L20]
 * composed children keep their own tokens.
 *
 * @module components/tugways/cards/dash-picker-sheet
 */

import "./dash-picker-sheet.css";

import React, { useMemo, useRef } from "react";

import { TugListRow } from "@/components/tugways/tug-list-row";
import { TugDashAtom } from "@/components/tugways/tug-dash-atom";
import { DashWorkerAtom } from "@/components/tugways/dash-lifecycle-block";
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
import { dashReviewPaints } from "@/lib/dash-review";
import type { DashChangesetEntry } from "@/lib/changeset-types";

export interface DashPickerSheetProps {
  /** This project's dash entries, in the snapshot's order — the picker does
   *  not apply the Dashes card's ordering, which is that surface's presentation
   *  choice rather than a property of the dashes. */
  dashes: readonly DashChangesetEntry[];
  /** Owner key of this card's current dash: marks the row and seeds the
   *  selection. Null when the card is unbound. */
  boundDashId: string | null;
  /** Send the bind. The sheet closes immediately afterwards and awaits
   *  nothing — the ack is the mover, not this callback. */
  onPick: (entry: DashChangesetEntry) => void;
  /** Dismiss the sheet. */
  onClose: (value?: string) => void;
}

function roundsLabel(rounds: number): string {
  return rounds === 1 ? "1 round" : `${rounds} rounds`;
}

/** A flat, immutable source over one render's entries. */
class DashPickerDataSource implements TugListViewDataSource {
  constructor(
    readonly dashes: readonly DashChangesetEntry[],
    readonly boundDashId: string | null,
  ) {}
  numberOfItems(): number {
    return this.dashes.length;
  }
  idForIndex(index: number): string {
    return this.dashes[index]!.owner_id;
  }
  kindForIndex(): string {
    return "dash";
  }
  subscribe(): () => void {
    return () => {};
  }
  getVersion(): unknown {
    return this.dashes;
  }
}

const DashPickerCell: TugListViewCellRenderer<DashPickerDataSource> = ({
  index,
  dataSource,
}: TugListViewCellProps<DashPickerDataSource>) => {
  const entry = dataSource.dashes[index];
  if (entry === undefined) return null;
  const current = entry.owner_id === dataSource.boundDashId;
  return (
    <TugListRow
      variant="flush"
      density="compact"
      data-slot="dash-picker-row"
      data-dash={entry.display_name}
      data-current={current ? "true" : undefined}
      // The eyebrow's identities, in the grammar every dash surface wears: the
      // dash atom, then one worker atom per bound session. Who is working a
      // dash is the fact this picker exists to weigh, and reading it off
      // `title` as bare text made every candidate look identical in the one
      // place a reader is choosing between them.
      leading={
        <span className="dash-picker-identity">
          <TugDashAtom name={entry.display_name} />
          {(entry.bound_sessions ?? []).map((sessionId) => (
            <DashWorkerAtom key={sessionId} sessionId={sessionId} register="prose" />
          ))}
        </span>
      }
      trailing={
        current ? (
          <span className="dash-picker-current" data-slot="dash-picker-current">
            current
          </span>
        ) : undefined
      }
    >
      <TugMetaRun
        className="dash-picker-facts"
        slot="dash-picker-facts"
        parts={[
          entry.stage !== undefined ? <span>{entry.stage}</span> : null,
          <span>{roundsLabel(entry.rounds)}</span>,
          entry.worktree_dirty ? (
            <span className="dash-picker-uncommitted">uncommitted</span>
          ) : null,
          dashReviewPaints(entry.review, entry.task_list ?? false) ? (
            <span className="dash-picker-review" data-review={entry.review}>
              {entry.review === "stale" ? "plan stale" : "plan unreviewed"}
            </span>
          ) : null,
        ]}
      />
    </TugListRow>
  );
};

const DASH_PICKER_CELL_RENDERERS = { dash: DashPickerCell };

export function DashPickerSheet({
  dashes,
  boundDashId,
  onPick,
  onClose,
}: DashPickerSheetProps): React.ReactElement {
  const listRef = useRef<TugListViewHandle | null>(null);
  const focusGroup = React.useId();
  // The list IS the sheet — there is nothing else to focus — so it takes the
  // key view on open. Without this the arrows and Return go to whatever held
  // focus before the sheet rose, and the picker would be click-only.
  useSeedKeyView(`${focusGroup}:0`);
  const dataSource = useMemo(
    () => new DashPickerDataSource(dashes, boundDashId),
    [dashes, boundDashId],
  );
  // The card's own dash is where the cursor starts, so Return with no arrow
  // presses rebinds to what the card already holds — a no-op — rather than to
  // whichever dash git happened to enumerate first.
  const currentIndex = useMemo(() => {
    const found = dashes.findIndex((entry) => entry.owner_id === boundDashId);
    return found === -1 ? 0 : found;
  }, [dashes, boundDashId]);

  const delegate = useMemo<TugListViewDelegate>(() => {
    const pick = (index: number): void => {
      const entry = dashes[index];
      if (entry === undefined) return;
      onPick(entry);
      onClose();
    };
    return { onSelect: pick, onActivate: pick };
  }, [dashes, onPick, onClose]);

  return (
    <div className="dash-picker-sheet" data-slot="dash-picker-sheet">
      <TugListView<DashPickerDataSource>
        ref={listRef}
        dataSource={dataSource}
        delegate={delegate}
        cellRenderers={DASH_PICKER_CELL_RENDERERS}
        rowLayout="flush"
        focusGroup={focusGroup}
        focusOrder={0}
        singleSelect
        initialSelectedIndex={currentIndex}
        commitOnEnter="act"
        className="dash-picker-list"
      />
    </div>
  );
}
