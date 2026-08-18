/**
 * spike-home.tsx — the Spikes index card.
 *
 * One row per entry in `SPIKES`: the spike's title, and under it the one-line
 * question that spike explores. Activating a row mounts that spike as a tab in
 * the same pane.
 *
 * The card holds no state of its own. `SPIKES` is a module constant, row
 * selection belongs to `TugListView`, and the mutation belongs to the pane:
 * a row emits the `add-tab` action and `TugPane`'s responder answers it with
 * `store.addCardToPane` ([L11]). That is why this card never needs to know its
 * own paneId.
 *
 * The dispatch reaching the pane at all is worth stating, because the DOM makes
 * it look impossible: `.tug-pane-content` is an empty ref'd div that card
 * content is mounted into, so a card is not a React child of the pane's
 * `ResponderScope`. `CardHost` closes the gap by registering with an explicit
 * `parentId` of its host pane, re-parenting every card's responder node onto
 * the pane it lives in.
 *
 * Rows are also the way *in* to a second spike. A pane opened straight from the
 * Maker menu holds one card, and a single-card pane's `+` picker offers only
 * the `"standard"` family — no spikes. `addCardToPane` consults no family
 * filter, so an index row mounts a spike regardless; once it has, the pane is
 * multi-card and its `+` picker lists every spike too.
 *
 * Laws: [L11] controls emit actions, responders own state; [L20] composes
 * `TugListView` / `TugListRow` rather than hand-rolling rows or list focus;
 * [L06] appearance through CSS.
 *
 * @module spikes/spike-home
 */

import "./spike-home.css";

import React, { useMemo } from "react";

import { TUG_ACTIONS } from "@/components/tugways/action-vocabulary";
import { useControlDispatch } from "@/components/tugways/use-control-dispatch";
import { TugListRow } from "@/components/tugways/tug-list-row";
import {
  TugListView,
  type TugListViewCellProps,
  type TugListViewCellRenderer,
  type TugListViewDataSource,
  type TugListViewDelegate,
} from "@/components/tugways/tug-list-view";

import { SPIKES, spikeComponentId, type SpikeDef } from "./spike-registry";

/** The index's rows: the `SPIKES` array, in declaration order. */
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
export function SpikeHome(): React.ReactElement {
  const { dispatch } = useControlDispatch();
  const dataSource = useMemo(() => new SpikeRowsDataSource(SPIKES), []);

  const delegate = useMemo<TugListViewDelegate>(
    () => ({
      onSelect: (index: number) => {
        const def = SPIKES[index];
        if (def === undefined) return;
        dispatch({
          action: TUG_ACTIONS.ADD_TAB,
          value: spikeComponentId(def.name),
          phase: "discrete",
        });
      },
    }),
    [dispatch],
  );

  if (SPIKES.length === 0) {
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
