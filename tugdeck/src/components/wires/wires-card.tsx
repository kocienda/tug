/**
 * wires-card.tsx — the **Wires** card: the standing tripwires on this machine,
 * and what each of them has done.
 *
 * Two levels, and the second is the point. Level one is the roster — one row
 * per wire, saying whether it is armed, whether it is running right now, and
 * whether it has left a dash somebody has to decide about. Level two is that
 * wire's trip log: every firing, including the swallowed and the routine ones,
 * because a wire that fired and said nothing is a fact about the wire, and this
 * is the only surface that can show it.
 *
 * The knobs here are deliberately three. Pausing, the model, and when to post
 * are what a reader of this card reaches for without leaving it; authoring a
 * wire — its trigger, its scope, its brief — stays on the CLI and the `/wire`
 * skill [B15], because those are the parts where a wrong value makes a wire
 * silently useless rather than visibly wrong.
 *
 * Laws: [L02] the store enters through `useSyncExternalStore`; the level and
 * the opened wire are local data in `useState`; [L06] row hover and press are
 * CSS on engine attributes; both lists are `TugListView`, never a hand-rolled
 * list with hand-rolled focus.
 *
 * @module components/wires/wires-card
 */

import React, {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import { ChevronLeft, ChevronRight, CircleDot, Pause, Play, Zap } from "lucide-react";

import { TugAtomRef } from "@/components/tugways/tug-atom-ref";
import { TugBadge } from "@/components/tugways/tug-badge";
import { TugChoiceGroup } from "@/components/tugways/tug-choice-group";
import { TugIconButton } from "@/components/tugways/tug-icon-button";
import { TugLabel } from "@/components/tugways/tug-label";
import { TugListRow } from "@/components/tugways/tug-list-row";
import { TugListView } from "@/components/tugways/tug-list-view";
import type {
  TugListViewCellProps,
  TugListViewDataSource,
  TugListViewDelegate,
} from "@/components/tugways/tug-list-view";
import { useResponderForm } from "@/components/tugways/use-responder-form";
import { getWiresStore, type TripRow, type WireRow } from "@/lib/wires-store";
import {
  useTripsDataSource,
  useWiresDataSource,
  type TripsDataSource,
  type WiresDataSource,
} from "./wires-data-source";

import "./wires-card.css";

/** The post policies the card offers, quietest first. */
const POST_CHOICES = [
  { value: "never", label: "Never" },
  { value: "auto", label: "Auto" },
  { value: "always", label: "Always" },
];

/**
 * How a wire row opens its log.
 *
 * A context rather than a prop because the cell renderer is the list view's to
 * construct — it is handed only `(dataSource, index)`, and threading a
 * callback through the data source would put a UI gesture inside the thing
 * whose whole job is to be a projection of rows.
 */
const OpenWireContext = React.createContext<(name: string) => void>(() => {});

/**
 * The glyph a wire's last firing earned.
 *
 * A wire that has never fired shows nothing rather than a neutral dot: "has
 * not fired yet" and "fired and found nothing" are different facts, and one
 * glyph that meant both would mean neither.
 */
function LastTripGlyph({ wire }: { wire: WireRow }): React.ReactElement | null {
  if (wire.running) {
    return <Zap size={13} className="wires-glyph wires-glyph-running" />;
  }
  const last = wire.last_trip;
  if (last === null) return null;
  const tone =
    last.status === "failed"
      ? "failed"
      : last.interest === "interesting"
        ? "interesting"
        : "routine";
  return <CircleDot size={13} className={`wires-glyph wires-glyph-${tone}`} />;
}

function WireCell({
  dataSource,
  index,
}: TugListViewCellProps<WiresDataSource>): React.ReactElement {
  const wire = dataSource.rowAt(index);
  // Two doors into the same level, because a rail is walked both ways: Enter
  // on the cursor row (the list's `onActivate`) and this chevron for the
  // pointer. Neither is the other's fallback.
  const open = React.useContext(OpenWireContext);
  return (
    <TugListRow
      leading={<LastTripGlyph wire={wire} />}
      title={wire.name}
      subtitle={wire.last_trip?.headline ?? wire.brief}
      data-wire={wire.name}
      data-wire-paused={wire.paused ? "true" : "false"}
      data-wire-running={wire.running ? "true" : "false"}
      data-wire-staged={wire.staged_dash === null ? "false" : "true"}
      trailing={
        <span className="wires-row-trailing">
          {wire.staged_dash !== null ? (
            <TugBadge size="2xs" role="accent">
              staged
            </TugBadge>
          ) : null}
          {wire.paused ? <Pause size={12} className="wires-glyph wires-glyph-paused" /> : null}
          <TugIconButton
            icon={<ChevronRight size={13} />}
            aria-label={`Open ${wire.name}'s trip log`}
            onClick={() => open(wire.name)}
            data-wires-open={wire.name}
          />
        </span>
      }
    />
  );
}

/**
 * One firing. The headline when there is one, and otherwise the reason there
 * is not: a swallowed trip says what swallowed it, and a trip still running
 * says so. Every row says something, because the whole value of the log is
 * that a firing which produced no post is still visible here [B11].
 */
function TripCell({
  dataSource,
  index,
}: TugListViewCellProps<TripsDataSource>): React.ReactElement {
  const trip = dataSource.rowAt(index);
  const body =
    trip.headline ??
    (trip.swallow_reason !== null ? `swallowed: ${trip.swallow_reason}` : trip.status);
  return (
    <TugListRow data-trip-id={trip.id} data-trip-status={trip.status}>
      <span className="wires-trip">
        <TugLabel size="sm" maxLines={2}>
          {body}
        </TugLabel>
        <span className="wires-trip-meta">
          <TugLabel size="2xs" emphasis="calm">
            {trip.status}
          </TugLabel>
          {trip.probe_exit !== null ? (
            <TugLabel size="2xs" emphasis="calm">
              {`probe ${trip.probe_exit}`}
            </TugLabel>
          ) : null}
          {trip.dash !== null ? (
            <TugAtomRef entity={{ kind: "dash", name: trip.dash }} />
          ) : null}
        </span>
      </span>
    </TugListRow>
  );
}

const WIRE_CELLS = { wire: WireCell };
const TRIP_CELLS = { trip: TripCell };

/** The detail level: one wire's knobs and its trip log. */
function WireDetail({
  wire,
  trips,
  onBack,
}: {
  wire: WireRow;
  trips: readonly TripRow[];
  onBack: () => void;
}): React.ReactElement {
  const store = getWiresStore();
  const postSender = useId();
  const { ResponderScope, responderRef } = useResponderForm({
    selectValue: {
      // The write is fire-and-adopt: the store replaces the row with the one
      // the server answers with, so the settled control shows the ledger
      // rather than the click.
      [postSender]: (value: string) => void store.setKnobs(wire.name, { post: value }),
    },
  });
  const dataSource = useTripsDataSource(trips);

  return (
    <ResponderScope>
      <div className="wires-detail" ref={responderRef} data-wire-detail={wire.name}>
        <div className="wires-detail-head">
          <TugIconButton
            icon={<ChevronLeft size={14} />}
            aria-label="Back to the wire list"
            onClick={onBack}
            data-wires-back=""
          />
          <TugLabel emphasis="strong">{wire.name}</TugLabel>
          <TugIconButton
            icon={wire.paused ? <Play size={13} /> : <Pause size={13} />}
            aria-label={wire.paused ? "Arm this wire" : "Pause this wire"}
            onClick={() => void store.setKnobs(wire.name, { paused: !wire.paused })}
            data-wires-pause=""
          />
        </div>
        <div className="wires-detail-brief">
          <TugLabel size="sm" maxLines={4}>
            {wire.brief}
          </TugLabel>
        </div>
        <div className="wires-detail-knobs">
          <TugChoiceGroup
            items={POST_CHOICES}
            value={wire.post}
            senderId={postSender}
            size="2xs"
            data-wires-post=""
          />
          {wire.model !== null ? (
            <TugLabel size="2xs" emphasis="calm" data-wires-model="">
              {wire.model}
            </TugLabel>
          ) : null}
          {wire.staged_dash !== null ? (
            <TugAtomRef entity={{ kind: "dash", name: wire.staged_dash }} />
          ) : null}
        </div>
        <TugListView
          dataSource={dataSource as unknown as TugListViewDataSource}
          cellRenderers={TRIP_CELLS as never}
          rowDensity="compact"
          className="wires-trips"
          focusGroup="wires"
          scrollKey={`wire-trips:${wire.name}`}
        />
      </div>
    </ResponderScope>
  );
}

export interface WiresContentProps {
  cardId: string;
}

export function WiresContent(_props: WiresContentProps): React.ReactElement {
  const store = getWiresStore();
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [openWire, setOpenWire] = useState<string | null>(null);

  // Poll only while the card is mounted. A deck with no Wires card open makes
  // no requests at all, which is what makes the poll affordable at five
  // seconds.
  useEffect(() => {
    store.retain();
    return () => store.release();
  }, [store]);

  useEffect(() => {
    if (openWire !== null) void store.loadTrips(openWire);
  }, [store, openWire]);

  const dataSource = useWiresDataSource(snapshot.wires);
  const wires = snapshot.wires;
  const delegate = useMemo<TugListViewDelegate>(
    () => ({
      onActivate: (index: number) => {
        const wire = wires[index];
        if (wire !== undefined) setOpenWire(wire.name);
      },
    }),
    [wires],
  );

  const open = useMemo(
    () => wires.find((w) => w.name === openWire) ?? null,
    [wires, openWire],
  );
  const back = useCallback(() => setOpenWire(null), []);

  if (open !== null) {
    return (
      <div className="wires-card" data-wires-level="detail">
        <WireDetail wire={open} trips={snapshot.trips[open.name] ?? []} onBack={back} />
      </div>
    );
  }

  return (
    <OpenWireContext.Provider value={setOpenWire}>
    <div className="wires-card" data-wires-level="list">
      {snapshot.loaded && wires.length === 0 ? (
        <div className="wires-empty" data-wires-empty="">
          <TugLabel size="sm" emphasis="calm">
            No wires are laid.
          </TugLabel>
        </div>
      ) : (
        <TugListView
          dataSource={dataSource as unknown as TugListViewDataSource}
          cellRenderers={WIRE_CELLS as never}
          delegate={delegate}
          className="wires-list"
          focusGroup="wires"
          scrollKey="wires-list"
          selectionRequired
        />
      )}
      {snapshot.error !== null ? (
        <div className="wires-error" data-wires-error="">
          <TugLabel size="2xs" role="danger">
            {snapshot.error}
          </TugLabel>
        </div>
      ) : null}
    </div>
    </OpenWireContext.Provider>
  );
}
