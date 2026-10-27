/**
 * spike-home.tsx — the Spikes index card.
 *
 * One row per entry in `SPIKES`: the spike's title, and under it the one-line
 * question that spike explores. Activating a row opens that spike in a card of
 * its own, placed beside the index.
 *
 * The card holds no state of its own. `SPIKES` is a module constant the
 * registry hands in as a prop — passed rather than imported, because the
 * registry imports this card to register it — row selection belongs to
 * `TugListView`, and the mutation belongs to the deck: a row dispatches the
 * `show-card` command with the spike's componentId and the index's own card id
 * as `originCardId` ([L11]). `show-card` is registry-routed, so from a body
 * page it is handed to the shell, whose deck adds the card.
 *
 * Laws: [L11] controls emit actions, responders own state; [L20] composes
 * `TugListView` / `TugListRow` rather than hand-rolling rows or list focus;
 * [L06] appearance through CSS.
 *
 * @module spikes/spike-home
 */

import "./spike-home.css";

import React, { useMemo } from "react";

import { dispatchCommand } from "@/command-dispatch";
import { useCardId } from "@/components/tugways/use-card-state-preservation";
import { TugListRow } from "@/components/tugways/tug-list-row";
import {
  TugListView,
  type TugListViewCellProps,
  type TugListViewCellRenderer,
  type TugListViewDataSource,
  type TugListViewDelegate,
} from "@/components/tugways/tug-list-view";

import type { SpikeDef } from "./spike-registry";

/**
 * The componentId a spike's `name` resolves to. Defined here rather than in
 * the registry so this card can name a row's spike without importing the
 * registry that imports it; the registry re-exports it.
 */
export function spikeComponentId(name: string): string {
  return `spike-${name}`;
}

/** The index's rows: the `SPIKES` array, alphabetized by title. */
class SpikeRowsDataSource implements TugListViewDataSource {
  constructor(readonly rows: readonly SpikeDef[]) {}
  numberOfItems(): number {
    return this.rows.length;
  }
  idForIndex(index: number): string {
    return this.rows[index]!.name;
  }
  kindForIndex(): string {
    return "spike";
  }
  subscribe(): () => void {
    return () => {};
  }
  getVersion(): unknown {
    return this.rows;
  }
}

const SpikeCell: TugListViewCellRenderer<SpikeRowsDataSource> = ({
  index,
  dataSource,
}: TugListViewCellProps<SpikeRowsDataSource>) => {
  const row = dataSource.rows[index];
  if (row === undefined) return null;
  return (
    <TugListRow
      className="spike-home-row"
      variant="flush"
      data-slot="spike-home-row"
      data-spike={row.name}
      title={row.title}
      subtitle={row.blurb}
    />
  );
};

const SPIKE_CELL_RENDERERS = { spike: SpikeCell };

/**
 * The Spikes index. Registered as `spike-home` — a singleton, since a second
 * index is never useful.
 */
export function SpikeHome({
  spikes,
}: {
  /** The registry's `SPIKES`, alphabetized by title. */
  spikes: readonly SpikeDef[];
}): React.ReactElement {
  // The index's own card, which an opened spike is placed beside.
  const hostCardId = useCardId();
  const dataSource = useMemo(() => new SpikeRowsDataSource(spikes), [spikes]);

  const delegate = useMemo<TugListViewDelegate>(
    () => ({
      onSelect: (index: number) => {
        const def = spikes[index];
        if (def === undefined) return;
        dispatchCommand("show-card", {
          component: spikeComponentId(def.name),
          ...(hostCardId !== null ? { originCardId: hostCardId } : {}),
        });
      },
    }),
    [hostCardId, spikes],
  );

  if (spikes.length === 0) {
    return (
      <div className="spike-home" data-slot="spike-home">
        <p className="spike-home-empty">
          No spikes yet. A spike is one file in <code>tugdeck/src/spikes/</code>{" "}
          plus two lines in <code>spike-registry.tsx</code> — see the README
          there, or run <code>/tugplug:spike-card</code>.
        </p>
      </div>
    );
  }

  return (
    <div className="spike-home" data-slot="spike-home">
      <TugListView<SpikeRowsDataSource>
        dataSource={dataSource}
        delegate={delegate}
        cellRenderers={SPIKE_CELL_RENDERERS}
        scrollKey="spike-home"
        rowLayout="flush"
        className="spike-home-list"
      />
    </div>
  );
}
