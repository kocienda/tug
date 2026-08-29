/**
 * tripwires-section.tsx — the **Tripwires** Lens section: the standing
 * tripwires on this machine, and what each of them has done.
 *
 * Two levels, and the second is the point. Level one is the roster — one row
 * per tripwire, saying whether it is armed, whether it is running right now,
 * and whether it has left a dash somebody has to decide about. Level two is
 * that tripwire's trip log: every firing, including the swallowed and the
 * routine ones, because a tripwire that fired and said nothing is a fact about
 * the tripwire, and this is the only surface that can show it.
 *
 * A section rather than a card because the section contract asks for the thing
 * a standing watch most wants to say: a live one-line summary in the collapsed
 * band. Armed, running, staged — that reads every time the Lens is up, which is
 * how tripwires nobody thought to look at stay legible.
 *
 * The knobs here are deliberately three. Pausing, the model, and when to post
 * are what a reader of this section reaches for without leaving it; authoring a
 * tripwire — its trigger, its scope, its brief — stays on the CLI and the
 * `/tripwire` skill [B15], because those are the parts where a wrong value
 * makes a tripwire silently useless rather than visibly wrong.
 *
 * Laws: [L02] the store enters through `useSyncExternalStore`; the level and
 * the opened tripwire are local data in `useState`; [L06] row hover and press
 * are CSS on engine attributes; both lists are `TugListView`, never a
 * hand-rolled list with hand-rolled focus.
 *
 * @module components/lens/sections/tripwires-section
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

import { registerLensSection } from "@/components/lens/lens-section-registry";
import type { LensSectionHost } from "@/components/lens/lens-section-registry";
import { setSectionContent } from "@/components/lens/lens-section-content";
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
import {
  getTripwiresStore,
  type TripRow,
  type TripwireRow,
} from "@/lib/tripwires-store";
import {
  useTripsDataSource,
  useTripwiresDataSource,
  type TripsDataSource,
  type TripwiresDataSource,
} from "./tripwires-data-source";

import "./tripwires-section.css";

/**
 * The section's `kind`, persisted in `lensStore`'s `sectionOrder` and
 * `collapsedSections` and used as the `data-lens-section` test hook. It never
 * changes, for the reason the Dashes section's never does: a new spelling
 * silently resets everyone's section order and re-expands what they collapsed.
 */
export const TRIPWIRES_SECTION_KIND = "tripwires";

/** The post policies the section offers, quietest first. */
const POST_CHOICES = [
  { value: "never", label: "Never" },
  { value: "auto", label: "Auto" },
  { value: "always", label: "Always" },
];

/**
 * How a tripwire row opens its log.
 *
 * A context rather than a prop because the cell renderer is the list view's to
 * construct — it is handed only `(dataSource, index)`, and threading a
 * callback through the data source would put a UI gesture inside the thing
 * whose whole job is to be a projection of rows.
 */
const OpenTripwireContext = React.createContext<(name: string) => void>(() => {});

/**
 * The band's live line: what the watches on this machine are doing right now.
 *
 * Every count is omitted when it is zero, so the line says only what is true —
 * and armed + paused covers every row, so a machine with tripwires on it always
 * says something. Staged is last and never elided when present, because it is
 * the one that is waiting on a person.
 */
export function tripwiresCollapsedSummary(rows: readonly TripwireRow[]): string {
  if (rows.length === 0) return "No tripwires";
  const parts: string[] = [];
  const armed = rows.filter((t) => !t.paused).length;
  const paused = rows.length - armed;
  const running = rows.filter((t) => t.running).length;
  const staged = rows.filter((t) => t.staged_dash !== null).length;
  if (armed > 0) parts.push(`${armed} armed`);
  if (paused > 0) parts.push(`${paused} paused`);
  if (running > 0) parts.push(`${running} running`);
  if (staged > 0) parts.push(`${staged} staged`);
  return parts.join(" · ");
}

function TripwiresCollapsedSummary(): React.ReactElement {
  const store = getTripwiresStore();
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  // The summary mounts only while the section is collapsed — the band renders
  // one of the two, never both — so it keeps its own hold on the poll. A
  // collapsed section whose count went stale would be a resting lie.
  useEffect(() => {
    store.retain();
    return () => store.release();
  }, [store]);
  return <>{tripwiresCollapsedSummary(snapshot.tripwires)}</>;
}

/**
 * The glyph a tripwire's last firing earned.
 *
 * A tripwire that has never fired shows nothing rather than a neutral dot: "has
 * not fired yet" and "fired and found nothing" are different facts, and one
 * glyph that meant both would mean neither.
 */
function LastTripGlyph({ tripwire }: { tripwire: TripwireRow }): React.ReactElement | null {
  if (tripwire.running) {
    return <Zap size={13} className="tripwires-glyph tripwires-glyph-running" />;
  }
  const last = tripwire.last_trip;
  if (last === null) return null;
  const tone =
    last.status === "failed"
      ? "failed"
      : last.interest === "interesting"
        ? "interesting"
        : "routine";
  return <CircleDot size={13} className={`tripwires-glyph tripwires-glyph-${tone}`} />;
}

function TripwireCell({
  dataSource,
  index,
}: TugListViewCellProps<TripwiresDataSource>): React.ReactElement {
  const tripwire = dataSource.rowAt(index);
  // Two doors into the same level, because a rail is walked both ways: Enter
  // on the cursor row (the list's `onActivate`) and this chevron for the
  // pointer. Neither is the other's fallback.
  const open = React.useContext(OpenTripwireContext);
  return (
    <TugListRow
      leading={<LastTripGlyph tripwire={tripwire} />}
      title={tripwire.name}
      subtitle={tripwire.last_trip?.headline ?? tripwire.brief}
      data-tripwire={tripwire.name}
      data-tripwire-paused={tripwire.paused ? "true" : "false"}
      data-tripwire-running={tripwire.running ? "true" : "false"}
      data-tripwire-staged={tripwire.staged_dash === null ? "false" : "true"}
      trailing={
        <span className="tripwires-row-trailing">
          {tripwire.staged_dash !== null ? (
            <TugBadge size="2xs" role="accent">
              staged
            </TugBadge>
          ) : null}
          {tripwire.paused ? (
            <Pause size={12} className="tripwires-glyph tripwires-glyph-paused" />
          ) : null}
          <TugIconButton
            icon={<ChevronRight size={13} />}
            aria-label={`Open ${tripwire.name}'s trip log`}
            onClick={() => open(tripwire.name)}
            data-tripwires-open={tripwire.name}
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
      <span className="tripwires-trip">
        <TugLabel size="sm" maxLines={2}>
          {body}
        </TugLabel>
        <span className="tripwires-trip-meta">
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

const TRIPWIRE_CELLS = { tripwire: TripwireCell };
const TRIP_CELLS = { trip: TripCell };

/** The detail level: one tripwire's knobs and its trip log. */
function TripwireDetail({
  tripwire,
  trips,
  focusGroup,
  onBack,
}: {
  tripwire: TripwireRow;
  trips: readonly TripRow[];
  focusGroup: string;
  onBack: () => void;
}): React.ReactElement {
  const store = getTripwiresStore();
  const postSender = useId();
  const { ResponderScope, responderRef } = useResponderForm({
    selectValue: {
      // The write is fire-and-adopt: the store replaces the row with the one
      // the server answers with, so the settled control shows the ledger
      // rather than the click.
      [postSender]: (value: string) => void store.setKnobs(tripwire.name, { post: value }),
    },
  });
  const dataSource = useTripsDataSource(trips);

  return (
    <ResponderScope>
      <div
        className="tripwires-detail"
        ref={responderRef}
        data-tripwire-detail={tripwire.name}
      >
        <div className="tripwires-detail-head">
          <TugIconButton
            icon={<ChevronLeft size={14} />}
            aria-label="Back to the tripwire list"
            onClick={onBack}
            data-tripwires-back=""
          />
          <TugLabel emphasis="strong">{tripwire.name}</TugLabel>
          <TugIconButton
            icon={tripwire.paused ? <Play size={13} /> : <Pause size={13} />}
            aria-label={tripwire.paused ? "Arm this tripwire" : "Pause this tripwire"}
            onClick={() => void store.setKnobs(tripwire.name, { paused: !tripwire.paused })}
            data-tripwires-pause=""
          />
        </div>
        <div className="tripwires-detail-brief">
          <TugLabel size="sm" maxLines={4}>
            {tripwire.brief}
          </TugLabel>
        </div>
        <div className="tripwires-detail-knobs">
          <TugChoiceGroup
            items={POST_CHOICES}
            value={tripwire.post}
            senderId={postSender}
            size="2xs"
            data-tripwires-post=""
          />
          {tripwire.model !== null ? (
            <TugLabel size="2xs" emphasis="calm" data-tripwires-model="">
              {tripwire.model}
            </TugLabel>
          ) : null}
          {tripwire.staged_dash !== null ? (
            <TugAtomRef entity={{ kind: "dash", name: tripwire.staged_dash }} />
          ) : null}
        </div>
        <TugListView
          dataSource={dataSource as unknown as TugListViewDataSource}
          cellRenderers={TRIP_CELLS as never}
          rowDensity="compact"
          className="tripwires-trips"
          focusGroup={focusGroup}
          scrollKey={`tripwire-trips:${tripwire.name}`}
        />
      </div>
    </ResponderScope>
  );
}

function TripwiresSectionBody({ host }: { host: LensSectionHost }): React.ReactElement {
  const store = getTripwiresStore();
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [openTripwire, setOpenTripwire] = useState<string | null>(null);

  // The body's own hold, balanced independently of the summary's. The count is
  // what carries one poll across a fold: React mounts the arriving surface
  // before it unmounts the departing one, so the second `retain` lands before
  // the first `release` and the interval never stops and restarts [L27].
  useEffect(() => {
    store.retain();
    return () => store.release();
  }, [store]);

  useEffect(() => {
    if (openTripwire !== null) void store.loadTrips(openTripwire);
  }, [store, openTripwire]);

  const dataSource = useTripwiresDataSource(snapshot.tripwires);
  const tripwires = snapshot.tripwires;
  const populated = tripwires.length > 0;

  useEffect(() => {
    setSectionContent(host.focusGroup, { navigable: populated, populated });
    return () =>
      setSectionContent(host.focusGroup, { navigable: false, populated: false });
  }, [host.focusGroup, populated]);

  const delegate = useMemo<TugListViewDelegate>(
    () => ({
      onActivate: (index: number) => {
        const tripwire = tripwires[index];
        if (tripwire !== undefined) setOpenTripwire(tripwire.name);
      },
    }),
    [tripwires],
  );

  const open = useMemo(
    () => tripwires.find((t) => t.name === openTripwire) ?? null,
    [tripwires, openTripwire],
  );
  const back = useCallback(() => setOpenTripwire(null), []);

  // One strip, rendered at both levels. Both writable knobs — pause, and the
  // post policy — are on the detail, so an error shown only on the list would
  // reach a surface nobody looking at it could see [L31].
  const errorStrip =
    snapshot.error !== null ? (
      <div className="tripwires-error" data-tripwires-error="">
        <TugLabel size="2xs" role="danger">
          {snapshot.error}
        </TugLabel>
      </div>
    ) : null;

  if (open !== null) {
    return (
      <div className="tripwires-section" data-tripwires-level="detail">
        <TripwireDetail
          tripwire={open}
          trips={snapshot.trips[open.name] ?? []}
          focusGroup={host.focusGroup}
          onBack={back}
        />
        {errorStrip}
      </div>
    );
  }

  return (
    <OpenTripwireContext.Provider value={setOpenTripwire}>
      <div className="tripwires-section" data-tripwires-level="list">
        {!populated ? (
          // No list until there is a row for it. A `TugListView` over zero rows
          // still registers its stop, and a stop that appears at mount and
          // vanishes when the first answer lands leaves the Lens's arrow plane
          // pointing at it — the plane is rebuilt from what each section holds,
          // and this section holds the same nothing before and after, so
          // nothing tells it to look again.
          <div className="tripwires-empty" data-tripwires-empty="">
            {snapshot.loaded ? (
              // Only once the ledger has answered. "None are laid" and "nobody
              // has asked yet" are different facts, and the first read is fast
              // enough that saying the wrong one would be a flash of a lie.
              <TugLabel size="sm" emphasis="calm">
                No tripwires are laid.
              </TugLabel>
            ) : null}
          </div>
        ) : (
          <TugListView
            dataSource={dataSource as unknown as TugListViewDataSource}
            cellRenderers={TRIPWIRE_CELLS as never}
            delegate={delegate}
            className="tripwires-list"
            focusGroup={host.focusGroup}
            scrollKey="tripwires-list"
            selectionRequired
          />
        )}
        {errorStrip}
      </div>
    </OpenTripwireContext.Provider>
  );
}

/** Register the Tripwires section. Called once at boot from `main.tsx`. */
export function registerTripwiresSection(): void {
  registerLensSection({
    kind: TRIPWIRES_SECTION_KIND,
    glyph: <Zap size={14} />,
    title: "Tripwires",
    collapsedSummary: () => <TripwiresCollapsedSummary />,
    body: (host) => <TripwiresSectionBody host={host} />,
    // No `presence`: the section is always on. A watch facility whose band
    // disappeared when nothing was laid would be undiscoverable exactly when
    // somebody wants to lay the first one.
  });
}
