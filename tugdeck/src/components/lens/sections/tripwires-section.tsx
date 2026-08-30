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
 * The detail level leads with what the tripwire IS — trigger, scope, probe,
 * brief, model, permissions, each stated in English rather than in
 * the JSON and the enums the ledger holds — and only then shows what it has
 * done. Those rows are read-only: authoring a tripwire stays on the CLI and the
 * `/tripwire` skill [B15], because those are the parts where a wrong value
 * makes a tripwire silently useless rather than visibly wrong. The one knob
 * that is writable here, pause, is the one a reader of the log reaches for
 * without leaving it.
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
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import {
  ChevronRight,
  CircleAlert,
  CircleDot,
  CircleMinus,
  Clock,
  Pause,
  Play,
  X,
  Zap,
} from "lucide-react";

import { registerLensSection } from "@/components/lens/lens-section-registry";
import type { LensSectionHost } from "@/components/lens/lens-section-registry";
import { setSectionContent } from "@/components/lens/lens-section-content";
import { TugAtomRef } from "@/components/tugways/tug-atom-ref";
import { TugIconButton } from "@/components/tugways/tug-icon-button";
import { TugLabel } from "@/components/tugways/tug-label";
import { TugListRow } from "@/components/tugways/tug-list-row";
import { TugListView } from "@/components/tugways/tug-list-view";
import { TugSectionLabel } from "@/components/tugways/tug-section-label";
import { TugTooltip } from "@/components/tugways/tug-tooltip";
import { SessionPhaseDot } from "@/components/tugways/session-phase-dot";
import { TugProgressIndicator } from "@/components/tugways/tug-progress-indicator";
import type {
  TugListViewCellProps,
  TugListViewDataSource,
  TugListViewDelegate,
} from "@/components/tugways/tug-list-view";
import { formatContextualStamp } from "@/lib/contextual-stamp";
import {
  getTripwiresStore,
  type TripRow,
  type TripwireRow,
} from "@/lib/tripwires-store";
import {
  describeTrigger,
  tripDot,
  tripSentence,
  tripState,
  tripStateLabel,
  tripwireDot,
  tripwireDefinition,
  type TripwireDot,
} from "./tripwire-presentation";
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
 * says something. Awaiting is last and never elided when present, because it is
 * the one that is waiting on a person.
 */
export function tripwiresCollapsedSummary(rows: readonly TripwireRow[]): string {
  if (rows.length === 0) return "No tripwires";
  const parts: string[] = [];
  const armed = rows.filter((t) => !t.paused).length;
  const paused = rows.length - armed;
  const running = rows.filter((t) => t.running).length;
  const awaiting = rows.filter((t) => t.awaiting).length;
  if (armed > 0) parts.push(`${armed} armed`);
  if (paused > 0) parts.push(`${paused} paused`);
  if (running > 0) parts.push(`${running} running`);
  if (awaiting > 0) parts.push(`${awaiting} awaiting`);
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
 * Arm or pause, in the row's leading column — the one knob a reader of the
 * roster reaches for without opening anything.
 *
 * The same control at both levels, in the same slot, so the title beside it
 * sits at the same x whether the tripwire is open or closed. It replaces the
 * status dot that used to stand here: a dot that said "has fired" was a fact
 * the subtitle beneath it already carried in words.
 */
function PauseToggle({ tripwire }: { tripwire: TripwireRow }): React.ReactElement {
  const store = getTripwiresStore();
  return (
    <TugIconButton
      icon={tripwire.paused ? <Play size={12} /> : <Pause size={12} />}
      size="xs"
      aria-label={tripwire.paused ? `Arm ${tripwire.name}` : `Pause ${tripwire.name}`}
      // Swallowed, or the press that pauses would also open the log: the row
      // itself is a door, and a control standing on a door has to say it was
      // pressed instead of the door.
      onClick={(e) => {
        e?.stopPropagation();
        void store.setKnobs(tripwire.name, { paused: !tripwire.paused });
      }}
      data-tripwires-pause={tripwire.name}
    />
  );
}

/** The dot's glyph box. The row's other accessories are drawn at 12–13px, and
 *  a mark that is the row's loudest thing should not also be its largest. */
const DOT_SIZE = 12;

/**
 * The interest dot — the one thing on a tripwire row that moves ([P08]).
 *
 * Three meanings, one wrapper, and nothing hand-drawn: `TugProgressIndicator`
 * owns the glyph, its motion, and its tokens [L13] [L20], and
 * `SessionPhaseDot` is that indicator already keyed on a session's liveness.
 * The wrapper carries the meaning as an attribute so the surface can be read
 * from outside without sampling a keyframe mid-pulse.
 *
 * `drift` is on for the session dot because these are separate sessions doing
 * separate work: on one exact period a column of them reads as one mechanism
 * with several heads.
 */
function TripwireStateDot({ dot }: { dot: TripwireDot }): React.ReactElement | null {
  if (dot === null) return null;
  return (
    <span className="tripwires-dot" data-tripwire-dot={dot.kind}>
      {dot.kind === "session" ? (
        <SessionPhaseDot sessionId={dot.sessionId} size={DOT_SIZE} drift />
      ) : (
        <TugProgressIndicator
          variant="pulsing-dot"
          size={DOT_SIZE}
          // Awaiting is held, not happening: a still dot in the caution tone
          // the Overview already uses for the same idea. Working is the
          // action tone, breathing, which is the pose every other in-flight
          // indicator in the app takes.
          state={dot.kind === "working" ? "running" : "stopped"}
          role={dot.kind === "working" ? "action" : "caution"}
          aria-hidden
        />
      )}
    </span>
  );
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
      leading={<PauseToggle tripwire={tripwire} />}
      title={tripwire.name}
      // The session rows in the Cards section are the house shape for a
      // name-over-a-line-of-status row, and this is the same shape: their
      // size, not the row default's larger one.
      titleSize="sm"
      // Before it has fired, what it watches for — a brief can be a paragraph,
      // and the trigger is the shorter answer to "what is this one for?".
      subtitle={tripwire.last_trip?.headline ?? describeTrigger(tripwire.trigger)}
      data-tripwire={tripwire.name}
      data-tripwire-paused={tripwire.paused ? "true" : "false"}
      data-tripwire-running={tripwire.running ? "true" : "false"}
      data-tripwire-awaiting={tripwire.awaiting ? "true" : "false"}
      trailing={
        <span className="tripwires-row-trailing">
          {/* The branch is the wire's other half: the same trigger onto two
              branches is two different watches, and a roster that named only
              the trigger could not tell them apart. */}
          <TugLabel size="2xs" emphasis="calm" data-tripwire-branch={tripwire.branch}>
            {tripwire.branch}
          </TugLabel>
          <TripwireStateDot dot={tripwireDot(tripwire)} />
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
 * The mark a trip's state earns, so the log reads at a glance before any of it
 * is read as prose.
 *
 * The two live states are dots and the terminal ones are glyphs, which is the
 * same division the roster makes: a dot means something is still true about
 * this trip, and a glyph is how it ended.
 */
function TripMark({ trip }: { trip: TripRow }): React.ReactElement | null {
  const dot = tripDot(trip);
  if (dot !== null) return <TripwireStateDot dot={dot} />;
  const state = tripState(trip);
  const className = `tripwires-glyph tripwires-glyph-${state === "finished" ? "routine" : state}`;
  switch (state) {
    case "failed":
      return <CircleAlert size={12} className={className} />;
    case "skipped":
      return <CircleMinus size={12} className={className} />;
    case "waiting":
      return <Clock size={12} className={className} />;
    default:
      return <CircleDot size={12} className={className} />;
  }
}

/**
 * One firing. The agent's headline when there is one, and otherwise a sentence
 * saying what happened instead — a trip that never ran gives its reason in
 * English rather than as the ledger's own status word. Every row says
 * something, because the whole value of the log is that a firing which
 * produced no post is still visible here [B11].
 *
 * The state word beside the time is omitted exactly when the body already
 * carries the state ({@link tripStateLabel}), so no row says it twice.
 */
function TripCell({
  dataSource,
  index,
}: TugListViewCellProps<TripsDataSource>): React.ReactElement {
  const trip = dataSource.rowAt(index);
  const headline = trip.headline;
  const stateLabel = headline === null ? null : tripStateLabel(trip);
  return (
    <TugListRow
      data-trip-id={trip.id}
      data-trip-status={trip.status}
      data-trip-state={tripState(trip)}
    >
      <span className="tripwires-trip">
        <span className="tripwires-trip-body">
          <TripMark trip={trip} />
          <TugLabel size="xs" maxLines={3}>
            {headline ?? tripSentence(trip)}
          </TugLabel>
        </span>
        <span className="tripwires-trip-meta">
          <TugLabel size="2xs" emphasis="calm">
            {formatContextualStamp(trip.at_ms, { seconds: true, ratioSeparator: true })}
          </TugLabel>
          {stateLabel !== null ? (
            <TugLabel size="2xs" emphasis="calm">
              {stateLabel}
            </TugLabel>
          ) : null}
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
  const dataSource = useTripsDataSource(trips);

  return (
    <>
      <div className="tripwires-detail" data-tripwire-detail={tripwire.name}>
        {/*
          The roster row again, not a head that resembles one: the same
          `TugListRow`, the same leading control, the same title size. A head
          assembled out of its own parts is a head whose title lands a few
          pixels off the closed row's, and the name appears to jump on open.

          The trailing slot closes where it opened. A back chevron on the left
          would put the same shape on the opposite edge from the one that
          brought the reader here, which reads as the affordance moving.
        */}
        <TugListRow
          className="tripwires-detail-head"
          density="compact"
          leading={<PauseToggle tripwire={tripwire} />}
          title={tripwire.name}
          titleSize="sm"
          trailing={
            <TugIconButton
              icon={<X size={13} />}
              aria-label="Back to the tripwire list"
              onClick={onBack}
              data-tripwires-back=""
            />
          }
        />
        {/*
          What this tripwire IS, before what it has done. The log below is a
          list of answers, and the trigger, the scope and the brief are the
          question they answer — a reader who cannot see those is reading
          verdicts about an event they cannot name.
        */}
        <dl className="tripwires-definition" data-tripwires-definition="">
          {tripwireDefinition(tripwire).map((row) => (
            <React.Fragment key={row.label}>
              <dt>
                <TugLabel size="2xs" emphasis="calm">
                  {row.label}
                </TugLabel>
              </dt>
              <dd data-mono={row.mono === true ? "" : undefined}>
                {/* Whole when it fits, and the brief's gist when it does not —
                    with the full text on hover, the same way a session row
                    shows a description too long for its line. `truncated` does
                    the measuring, so a row already showing everything opens
                    nothing ([L06]). */}
                {row.full === undefined ? (
                  <TugLabel size="2xs">{row.value}</TugLabel>
                ) : (
                  <TugTooltip
                    content={row.full}
                    side="bottom"
                    align="start"
                    arrow={false}
                  >
                    <TugLabel size="2xs" data-tripwires-gist="">
                      {row.value}
                    </TugLabel>
                  </TugTooltip>
                )}
              </dd>
            </React.Fragment>
          ))}
        </dl>
        {tripwire.awaiting_dash !== null ? (
          <div className="tripwires-detail-knobs">
            <TugAtomRef entity={{ kind: "dash", name: tripwire.awaiting_dash }} />
          </div>
        ) : null}
        <TugSectionLabel
          label={{ name: "Trip log", qualifier: "every firing, posted or not" }}
          slot="tripwires-trip-log"
        />
        <TugListView
          dataSource={dataSource as unknown as TugListViewDataSource}
          cellRenderers={TRIP_CELLS as never}
          rowDensity="compact"
          className="tripwires-trips"
          focusGroup={focusGroup}
          scrollKey={`tripwire-trips:${tripwire.name}`}
        />
      </div>
    </>
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

  // One strip, rendered at both levels. The one writable knob is pause, which
  // stands at both, so an error shown only on the list would reach a surface
  // nobody looking at it could see [L31].
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
          // The shared word, centered, on one row's worth of height — the same
          // empty state every other Lens section shows, because "empty" should
          // not look like a different thing in each band.
          <div className="lens-section-empty" data-tripwires-empty="">
            {/* Only once the ledger has answered. "None are laid" and "nobody
                has asked yet" are different facts, and the first read is fast
                enough that saying the wrong one would be a flash of a lie. */}
            {snapshot.loaded ? "None" : null}
          </div>
        ) : (
          <TugListView
            dataSource={dataSource as unknown as TugListViewDataSource}
            cellRenderers={TRIPWIRE_CELLS as never}
            delegate={delegate}
            rowDensity="compact"
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
