/**
 * tripwires-card.tsx — the **Tripwires** card: the standing tripwires on this
 * machine, and what each of them has done.
 *
 * Doctrine: `tuglaws/tripwires.md` — the lifecycle the marks paint, the release
 * rule the register band states, and why authoring is not a form on this card.
 *
 * One level, and a fold. Each tripwire is a two-line block — line one the name,
 * a hairline, the session working its trip when one is running, and the row's
 * controls; line two a fixed-width mark, the lifecycle sentence, and the branch
 * it lands on. A row with a trip in flight or a question outstanding carries a
 * register band beneath. The fold opens in place over the tripwire's definition
 * and its trip log, which is the Arcs card's own gesture and replaces the
 * second level this card used to push to ([B02]).
 *
 * A sidebar card, standing on the rail machinery like Jots: the roster is the
 * whole of what a standing watch has to say, and a card the reader can leave
 * open says it without a band's summary line standing in for it.
 *
 * The fold leads with what the tripwire IS — trigger, scope, probe, brief,
 * model, permissions, each stated in English rather than in the JSON and the
 * enums the ledger holds — and only then shows what it has done. Those rows are
 * read-only but for the model knob: authoring a tripwire stays on the CLI and
 * the `/tripwire` skill [B15], because those are the parts where a wrong value
 * makes a tripwire silently useless rather than visibly wrong. The two knobs
 * that are writable here, pause and model, are the ones a reader of the log
 * reaches for without leaving it.
 *
 * **Nothing on this card is a hover** ([B05]). The brief is the whole
 * instruction a trip runs on, and a good one is paragraphs; it stands behind a
 * two-line `TugClamp` whose own reveal is the door, rather than in a tooltip
 * that covers the rail with text nobody asked for.
 *
 * Laws: [L02] the store enters through `useSyncExternalStore`; the open folds
 * are view-scope local data in `useState`; [L06] every mark's colour is CSS on
 * a `data-state` attribute the component stamps, never a class it computes;
 * [L11] every verb is a typed action dispatched to the row's own responder;
 * [L20] the block, the band, the fold cue, the clamp and the popup are composed
 * from the shared components that own them, never hand-rolled.
 *
 * @module components/tripwires/tripwires-card
 */

import React, {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import {
  ChevronDown,
  CircleAlert,
  CircleDot,
  CircleMinus,
  Clock,
  Pause,
  Play,
  Radar,
} from "lucide-react";

import { BlockHeader } from "@/components/tugways/blocks/block-header";
import { BlockFoldCue } from "@/components/tugways/body-kinds/affordances/block-fold-cue";
import { RAIL_LIST_PRESENTATION } from "@/components/tugways/rail-list-presentation";
import { TugAtomRef } from "@/components/tugways/tug-atom-ref";
import { TugBadge } from "@/components/tugways/tug-badge";
import { TugClamp } from "@/components/tugways/tug-clamp";
import {
  TugEditorContextMenu,
  type TugEditorContextMenuEntry,
} from "@/components/tugways/tug-editor-context-menu";
import { TugIconButton } from "@/components/tugways/tug-icon-button";
import { TugLabel } from "@/components/tugways/tug-label";
import { TugListRow } from "@/components/tugways/tug-list-row";
import { TugListView } from "@/components/tugways/tug-list-view";
import {
  TugPopupButton,
  type TugPopupButtonItem,
} from "@/components/tugways/tug-popup-button";
import { TugProgressIndicator } from "@/components/tugways/tug-progress-indicator";
import { TugPushButton } from "@/components/tugways/tug-push-button";
import { TugSectionLabel } from "@/components/tugways/tug-section-label";
import { TugSessionIdentity } from "@/components/tugways/tug-session-identity";
import { SessionPhaseDot } from "@/components/tugways/session-phase-dot";
import { useSeedKeyView } from "@/components/tugways/use-focusable";
import { useOptionalResponder } from "@/components/tugways/use-responder";
import type { ActionEvent } from "@/components/tugways/responder-chain";
import type {
  TugListViewCellProps,
  TugListViewDataSource,
  TugListViewDelegate,
} from "@/components/tugways/tug-list-view";
import { getRegistryHandler } from "@/action-dispatch";
import { dispatchCommand } from "@/command-dispatch";
import { TUG_ACTIONS } from "@/components/tugways/action-vocabulary";
import { useCardIdForSession } from "@/lib/card-session-binding-store";
import { CardIdContext } from "@/lib/card-id-context";
import { useCitedSession } from "@/lib/session-citation-store";
import { formatContextualStamp } from "@/lib/contextual-stamp";
import { useSessionIdentity } from "@/lib/session-identity";
import {
  getTripwiresStore,
  type TripRow,
  type TripwireRow,
} from "@/lib/tripwires-store";
import {
  MODEL_CHOICES,
  modelKnobValue,
  tripDot,
  tripSentence,
  tripState,
  tripStateLabel,
  tripwireDot,
  tripwireDefinition,
  type TripwireDot,
} from "./tripwire-presentation";
import {
  useTripwiresDataSource,
  type TripwiresDataSource,
} from "./tripwires-data-source";
import {
  LOG_PAGE,
  LOG_WINDOW,
  olderCueLabel,
  rollUp,
  rollupSentence,
  type RollupKind,
} from "./trip-log";

import "./tripwires-card.css";

/**
 * The card's focus group — every stop it offers lives here, so the Tab walk
 * runs the roster and, on an open row, every control the fold carries: pause,
 * the cue, the model knob, Seen, and the older-trips cue ([B08]).
 */
const TRIPWIRES_FOCUS_GROUP = "tripwires-card";

/** The label of the definition row the model knob stands in. */
const MODEL_ROW_LABEL = "Model";

const MODEL_ITEMS: TugPopupButtonItem<string>[] = MODEL_CHOICES.map((label) => ({
  action: TUG_ACTIONS.SET_TRIPWIRE_MODEL,
  value: label,
  label,
}));

/** The dot's glyph box. The row's other accessories are drawn at 11–12px, and
 *  a mark that is the row's loudest thing should not also be its largest. */
const DOT_SIZE = 12;

/** The mark box's own size, so a dot, a glyph and nothing all occupy one width. */
const MARK_SIZE = 11;

/**
 * How a tripwire row opens its fold, and what its controls do.
 *
 * A context rather than props because the cell renderer is the list view's to
 * construct — it is handed only `(dataSource, index)`, and threading callbacks
 * through the data source would put UI gestures inside the thing whose whole
 * job is to be a projection of rows.
 */
interface TripwireRowHost {
  readonly expanded: ReadonlySet<string>;
  readonly toggle: (name: string) => void;
  /** The reason one tripwire's log could not be read, if it could not ([B10]). */
  readonly logErrors: Readonly<Record<string, string>>;
  readonly trips: Readonly<Record<string, readonly TripRow[]>>;
}

const TripwireRowHostContext = React.createContext<TripwireRowHost>({
  expanded: new Set(),
  toggle: () => {},
  logErrors: {},
  trips: {},
});

// ---------------------------------------------------------------------------
// Per-row readings — the line beneath the eyebrow, and its mark
// ---------------------------------------------------------------------------

type RowState = "running" | "awaiting" | "paused" | "armed";

function rowState(tripwire: TripwireRow): RowState {
  if (tripwire.running) return "running";
  if (tripwire.awaiting) return "awaiting";
  if (tripwire.paused) return "paused";
  return "armed";
}

/** What the tripwire is DOING, one line — the lifecycle line's job. */
function lifecycleSentence(tripwire: TripwireRow): string {
  const last = tripwire.last_trip;
  const ago = last === null ? null : formatContextualStamp(last.at_ms, {});
  switch (rowState(tripwire)) {
    case "running":
      return `Running — started ${ago ?? "just now"}`;
    case "awaiting":
      return "Found something — waiting for you to look";
    case "paused":
      return last === null ? "Paused" : `Paused — last trip ${ago}`;
    case "armed":
      return last === null
        ? "Armed — never tripped"
        : `Armed — last trip ${ago}, nothing to report`;
  }
}

/**
 * The one gesture that reaches a trip's session, and the two doors onto it:
 * the running row's live dot, and the row menu's Open session item ([B09]).
 *
 * A hook rather than a callback inside the dot, because the menu item is the
 * same act under the keyboard's name and an item that only raised an
 * already-open card would be dead on every row whose session no card holds —
 * which is most of them, since a trip's session is worked in the background.
 * One implementation means the two cannot answer the same row differently.
 *
 * The branch is `session-identity-menu.tsx`'s, composed the same way rather
 * than re-derived ([L30]): a card already holding this session is raised, and
 * a session no card holds is seated on one through the resume the deck
 * already ships. There is no third case and no refusal — a background
 * session's row carries `background: true`, which is what unblocked the
 * gesture, and the supervisor admits a live one without re-spawning it.
 *
 * `sessionId` is `null` on a row with no trip running, and the hook still runs
 * every read it has: its callers are unconditional and its hooks must be too.
 */
function useOpenTripwireSession(sessionId: string | null): {
  /** Whether a card already holds it, which is what the two doors label. */
  readonly heldByCard: boolean;
  readonly open: () => void;
} {
  const id = sessionId ?? "";
  const openCardId = useCardIdForSession(id);
  // The card this dot is mounted in, so the seated card lands in the slot
  // beside it rather than beside whatever card happened to hold the key view
  // when the dot was pressed.
  const hostCardId = React.useContext(CardIdContext);
  // Only asked when no card holds it: the resolver answers where the session's
  // project is, which is the one thing seating a card needs and the one thing
  // a raise does not ([L02] — the ask is the hook's, not a component's).
  const cited = useCitedSession(openCardId === null ? id : "");

  const open = useCallback((): void => {
    if (id.length === 0) return;
    if (openCardId !== null) {
      // The registry's own raise — the same funnel a Cards card row's click
      // and a chip's click go through, so three gestures cannot drift into
      // three raises ([L30]).
      dispatchCommand("focus-session-card", { cardId: openCardId });
      return;
    }
    if (cited.status !== "found" || cited.projectDir.length === 0) return;
    getRegistryHandler(TUG_ACTIONS.RESUME_SESSION)?.({
      sessionId: cited.sessionId,
      projectDir: cited.projectDir,
      originCardId: hostCardId ?? undefined,
    });
  }, [id, openCardId, cited, hostCardId]);

  return { heldByCard: openCardId !== null, open };
}

/**
 * The live dot over a session, and the door its press opens.
 *
 * Its own component, and that is not a stylistic split: the marks below open
 * with a branch on the dot's kind, so the hooks here called inside one of them
 * would be conditional hook calls — correct until a row's dot changes kind,
 * and then not. Here they run unconditionally, the way `SessionPhaseDot` is
 * delegated to for the same reason.
 */
function TripwireSessionDot({ sessionId }: { sessionId: string }): React.ReactElement {
  const { heldByCard, open } = useOpenTripwireSession(sessionId);

  return (
    <button
      type="button"
      className="tripwires-dot-button"
      onClick={open}
      data-tripwire-adopt={sessionId}
      aria-label={
        !heldByCard
          ? "Open this tripwire's session in a card"
          : "Show the card holding this tripwire's session"
      }
    >
      <SessionPhaseDot sessionId={sessionId} size={DOT_SIZE} drift />
    </button>
  );
}

/**
 * The interest dot — the one thing on a tripwire row that moves ([P08]).
 *
 * Three meanings, one wrapper, and nothing hand-drawn: `TugProgressIndicator`
 * owns the glyph, its motion, and its tokens [L13] [L20], and
 * `SessionPhaseDot` is that indicator already keyed on a session's liveness.
 *
 * `drift` is on for the session dot because these are separate sessions doing
 * separate work: on one exact period a column of them reads as one mechanism
 * with several heads.
 */
function StateDot({ dot }: { dot: Exclude<TripwireDot, null> }): React.ReactElement {
  if (dot.kind === "session") return <TripwireSessionDot sessionId={dot.sessionId} />;
  return (
    <TugProgressIndicator
      variant="pulsing-dot"
      size={MARK_SIZE}
      // Awaiting is held, not happening: a still dot in the caution tone the
      // Overview already uses for the same idea. Working is the action tone,
      // breathing, which is the pose every other in-flight indicator takes.
      state={dot.kind === "working" ? "running" : "stopped"}
      role={dot.kind === "working" ? "action" : "caution"}
      aria-hidden
    />
  );
}

/**
 * The mark on the lifecycle line: a dot for the two live states, a glyph for
 * paused, and an empty box at rest so the sentence stands at one x on every
 * row. The state rides the wrapper and the colour is CSS on it ([L06]).
 */
function RowMark({ tripwire }: { tripwire: TripwireRow }): React.ReactElement {
  const dot = tripwireDot(tripwire);
  const state = rowState(tripwire);
  return (
    <span className="tripwires-mark" data-state={state}>
      {dot !== null ? (
        <StateDot dot={dot} />
      ) : state === "paused" ? (
        <CircleMinus size={MARK_SIZE} />
      ) : null}
    </span>
  );
}

/** A trip's mark in the log — state on the wrapper, colour in CSS ([L06]). */
function TripMark({ trip }: { trip: TripRow }): React.ReactElement {
  const state = tripState(trip);
  const dot = tripDot(trip);
  return (
    <span className="tripwires-mark" data-state={state}>
      {dot !== null ? (
        <StateDot dot={dot} />
      ) : state === "failed" ? (
        <CircleAlert size={MARK_SIZE} />
      ) : state === "skipped" ? (
        <CircleMinus size={MARK_SIZE} />
      ) : state === "waiting" ? (
        <Clock size={MARK_SIZE} />
      ) : (
        <CircleDot size={MARK_SIZE} />
      )}
    </span>
  );
}

// ---------------------------------------------------------------------------
// The row's verbs — every one an action, dispatched to the row's own responder
// ---------------------------------------------------------------------------

/**
 * The row's five verbs and the one responder they land on.
 *
 * The responder is per row, so each item's dispatch carries its target by
 * construction rather than by a sampled id: the menu and the model popup both
 * live inside this scope, and the handlers close over the tripwire the row is.
 *
 * **A disabled item still says why.** A disabled item takes no pointer events,
 * so a tooltip on one can never fire ([L31] — a refusal that cannot be read is
 * a silent one). The reason therefore rides the item's own label, the way the
 * arc row's menu states its own: `Trip now — already working a trip`. The item
 * stays present rather than vanishing, so the menu's height does not change
 * with the row's state.
 */
function useTripwireRowVerbs(tripwire: TripwireRow): {
  onContextMenu: (e: React.MouseEvent) => void;
  ResponderScope: React.FC<{ children: React.ReactNode }>;
  responderRef: (el: Element | null) => void;
  menu: React.ReactNode;
} {
  const store = getTripwiresStore();
  const name = tripwire.name;
  const session = tripwire.running_session;
  // The dot's own gesture, not a second reading of it: the menu item is the
  // keyboard's name for the press, and `focus-session-card` raises a card by
  // id — handed a session id it warns and does nothing, which is how this item
  // was dead on every row whose session no card was already holding.
  const openSession = useOpenTripwireSession(session);
  const [openAt, setOpenAt] = useState<{ x: number; y: number } | null>(null);
  const close = useCallback(() => setOpenAt(null), []);
  const onContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setOpenAt({ x: e.clientX, y: e.clientY });
  }, []);

  const responderId = useId();
  const { ResponderScope, responderRef } = useOptionalResponder({
    id: responderId,
    actions: {
      [TUG_ACTIONS.PAUSE_TRIPWIRE]: () => void store.setKnobs(name, { paused: true }),
      [TUG_ACTIONS.RESUME_TRIPWIRE]: () => void store.setKnobs(name, { paused: false }),
      [TUG_ACTIONS.TRIP_TRIPWIRE]: () => void store.trip(name),
      // Release and the fold's Seen act are one verb under two names: the
      // engine settles an awaiting trip and discards the arc it authored as
      // one act, and this is the door for the trip that authored none ([B03]).
      [TUG_ACTIONS.RELEASE_TRIPWIRE]: () => void store.dismiss(name),
      [TUG_ACTIONS.OPEN_TRIPWIRE_SESSION]: () => openSession.open(),
      [TUG_ACTIONS.SET_TRIPWIRE_MODEL]: (event: ActionEvent) => {
        if (typeof event.value !== "string") return;
        const knobs = modelKnobValue(event.value);
        if (knobs === null) return;
        void store.setKnobs(name, knobs);
      },
    },
  });

  const items = useMemo<TugEditorContextMenuEntry[]>(
    () => [
      {
        action: tripwire.paused ? TUG_ACTIONS.RESUME_TRIPWIRE : TUG_ACTIONS.PAUSE_TRIPWIRE,
        label: tripwire.paused ? "Resume" : "Pause",
      },
      {
        action: TUG_ACTIONS.TRIP_TRIPWIRE,
        label: tripwire.running ? "Trip now — already working a trip" : "Trip now",
        disabled: tripwire.running,
      },
      { type: "separator" },
      {
        action: TUG_ACTIONS.OPEN_TRIPWIRE_SESSION,
        label:
          session === null
            ? "Open session — no trip is running"
            : openSession.heldByCard
              ? "Show session"
              : "Open session",
        disabled: session === null,
      },
      {
        action: TUG_ACTIONS.RELEASE_TRIPWIRE,
        label: tripwire.awaiting ? "Release" : "Release — nothing is awaiting",
        disabled: !tripwire.awaiting,
      },
    ],
    [tripwire.paused, tripwire.running, tripwire.awaiting, session, openSession.heldByCard],
  );

  const menu = (
    <span data-slot="tripwire-row-menu">
      <TugEditorContextMenu
        open={openAt !== null}
        x={openAt?.x ?? 0}
        y={openAt?.y ?? 0}
        items={items}
        onClose={close}
      />
    </span>
  );

  return { onContextMenu, ResponderScope, responderRef, menu };
}

// ---------------------------------------------------------------------------
// The fold — definition, then the log
// ---------------------------------------------------------------------------

/**
 * What this tripwire IS, before what it has done. The log below is a list of
 * answers, and the trigger, the scope and the brief are the question they
 * answer — a reader who cannot see those is reading verdicts about an event
 * they cannot name.
 */
function Definition({ tripwire }: { tripwire: TripwireRow }): React.ReactElement {
  return (
    <dl className="tripwires-definition" data-slot="tripwire-definition">
      {tripwireDefinition(tripwire).map((row) => (
        <React.Fragment key={row.label}>
          <dt>
            <TugLabel size="2xs" emphasis="calm">
              {row.label}
            </TugLabel>
          </dt>
          <dd data-mono={row.mono === true ? "" : undefined}>
            {row.label === MODEL_ROW_LABEL ? (
              // The one knob beside pause that is writable from the card. A
              // popup rather than a text field: the values are a short list.
              // Wrapped, because `TugPopupButton` takes no passthrough props
              // and a `data-` attribute written on it would reach no element —
              // the slot has to be on something the DOM actually carries.
              <span data-slot="tripwire-model" data-tripwires-model={tripwire.name}>
                <TugPopupButton
                  size="xs"
                  label={row.value}
                  items={MODEL_ITEMS}
                  focusGroup={TRIPWIRES_FOCUS_GROUP}
                />
              </span>
            ) : row.clamp === true ? (
              // The brief, whole, behind a two-line clamp — never a hover. A
              // brief is paragraphs, and a tooltip carrying paragraphs is the
              // wart this card shipped with; the clamp's own reveal is the
              // door ([B05]).
              <TugClamp lines={2} showMoreLabel="More" showLessLabel="Less">
                <TugLabel size="2xs">{row.value}</TugLabel>
              </TugClamp>
            ) : (
              <TugLabel size="2xs">{row.value}</TugLabel>
            )}
          </dd>
        </React.Fragment>
      ))}
    </dl>
  );
}

/**
 * One firing. The agent's headline when there is one, and otherwise a sentence
 * saying what happened instead — a trip that never ran gives its reason in
 * English rather than as the ledger's own status word. Every row says
 * something, because the whole value of the log is that a firing which produced
 * no post is still visible here [B11].
 *
 * Every line reads at the rail's own measure ([B06]): the arc atom sits inside
 * the meta line at its size, not a step above it.
 */
function TripLogRow({ trip }: { trip: TripRow }): React.ReactElement {
  const headline = trip.headline;
  const stateLabel = headline === null ? null : tripStateLabel(trip);
  return (
    <TugListRow
      variant="flush"
      density="compact"
      className="tripwires-trip"
      data-slot="tripwire-trip"
      data-trip-id={trip.id}
      data-trip-status={trip.status}
      data-trip-state={tripState(trip)}
    >
      <span className="tripwires-trip-body">
        <span className="tripwires-trip-head">
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
            <TugBadge
              size="2xs"
              emphasis="ghost"
              role={trip.probe_exit === 0 ? "success" : "danger"}
            >
              {`probe ${trip.probe_exit}`}
            </TugBadge>
          ) : null}
          {trip.arc !== null ? <TugAtomRef entity={{ kind: "arc", name: trip.arc }} /> : null}
        </span>
        {/* The probe's tail sits beside its exit code, not in a tooltip: the
            number says it failed, and this is the line that says why. */}
        {trip.probe_tail !== null ? (
          <pre className="tripwires-probe-tail" data-slot="tripwire-probe-tail">
            {trip.probe_tail}
          </pre>
        ) : null}
      </span>
    </TugListRow>
  );
}

function RollupRow({
  roll,
  rows,
}: {
  roll: RollupKind;
  rows: readonly TripRow[];
}): React.ReactElement {
  const sentence = rollupSentence(roll, rows);
  const oldest = rows[rows.length - 1];
  const newest = rows[0];
  return (
    <TugListRow
      variant="flush"
      density="compact"
      className="tripwires-trip"
      data-slot="tripwire-rollup"
      data-trip-state={roll === "skipped" ? "skipped" : "finished"}
      data-rollup-count={rows.length}
    >
      <span className="tripwires-trip-body">
        <span className="tripwires-trip-head">
          <span className="tripwires-mark" data-state={roll === "skipped" ? "skipped" : "finished"}>
            {roll === "skipped" ? <CircleMinus size={MARK_SIZE} /> : <CircleDot size={MARK_SIZE} />}
          </span>
          <TugLabel size="xs" emphasis="calm">
            {sentence}
          </TugLabel>
        </span>
        <span className="tripwires-trip-meta">
          <TugLabel size="2xs" emphasis="calm">
            {`${formatContextualStamp(oldest.at_ms, {})} – ${formatContextualStamp(newest.at_ms, {})}`}
          </TugLabel>
        </span>
      </span>
    </TugListRow>
  );
}

function Fold({ tripwire }: { tripwire: TripwireRow }): React.ReactElement {
  const host = React.useContext(TripwireRowHostContext);
  const trips = host.trips[tripwire.name] ?? [];
  const entries = useMemo(() => rollUp(trips), [trips]);
  const [shown, setShown] = useState(LOG_WINDOW);
  const visible = entries.slice(0, shown);
  const olderLabel = olderCueLabel(entries.length, shown);
  const logError = host.logErrors[tripwire.name];
  return (
    <span className="tripwires-fold" data-slot="tripwire-fold">
      <Definition tripwire={tripwire} />
      <TugSectionLabel
        label={{ name: "Trip log", qualifier: "every firing, posted or not" }}
        slot="tripwires-trip-log"
        className="tripwires-log-label"
      />
      {entries.length === 0 ? (
        <span className="tripwires-log-empty">None</span>
      ) : (
        visible.map((e) =>
          e.kind === "trip" ? (
            <TripLogRow key={e.row.id} trip={e.row} />
          ) : (
            <RollupRow key={`rollup-${e.rows[0].id}`} roll={e.roll} rows={e.rows} />
          ),
        )
      )}
      {/* The rest of the log, on request, a page at a time. The ledger keeps
          the most recent five hundred per tripwire, so this cue bottoms out. */}
      {olderLabel !== null ? (
        <span className="tripwires-log-older">
          <TugPushButton
            size="2xs"
            emphasis="ghost"
            icon={<ChevronDown size={11} />}
            label={olderLabel}
            onClick={() => setShown((n) => n + LOG_PAGE)}
            focusGroup={TRIPWIRES_FOCUS_GROUP}
            data-tripwires-older={tripwire.name}
          />
        </span>
      ) : null}
      {/* An error scoped to the thing that failed — this log, under this row —
          rather than a strip over the whole card ([B10]). */}
      {logError !== undefined ? (
        <span className="tripwires-log-error" data-slot="tripwire-log-error">
          <TugLabel size="2xs" role="danger">
            {logError}
          </TugLabel>
        </span>
      ) : null}
    </span>
  );
}

// ---------------------------------------------------------------------------
// The register band — what the live trip is doing, in the transcript's chrome
// ---------------------------------------------------------------------------

/**
 * What releases an awaiting trip ([B03]), settled: the arc's own fate when the
 * trip authored one — the band names the arc and says it holds until that arc
 * is joined or discarded — and a "Seen" act on the band when it authored
 * nothing, because then nothing else can end the hold.
 *
 * The engine already settles an awaiting trip whose arc has gone, so a band
 * over an arc-bearing trip states a rule that holds rather than offering a
 * button that duplicates the Join sheet.
 */
function RegisterBand({ tripwire }: { tripwire: TripwireRow }): React.ReactElement | null {
  const worker = useSessionIdentity(tripwire.running_session);
  const state = rowState(tripwire);

  if (state === "running") {
    return (
      <span className="tripwires-register" data-slot="tripwire-register" data-word="running">
        <BlockHeader
          ariaName="trip"
          phase="in_flight"
          target={worker?.description ?? tripwire.last_trip?.headline ?? "Working"}
          summary={{ kind: "text", text: "running" }}
          altitude="row"
        />
      </span>
    );
  }

  if (state === "awaiting") {
    const arc = tripwire.awaiting_arc;
    return (
      <span className="tripwires-register" data-slot="tripwire-register" data-word="awaiting">
        <BlockHeader
          ariaName="trip"
          phase="awaiting"
          target={
            arc !== null ? (
              <span className="tripwires-register-target">
                <span>Holding until</span>
                <TugAtomRef entity={{ kind: "arc", name: arc }} />
                <span>is joined or discarded</span>
              </span>
            ) : (
              (tripwire.last_trip?.headline ?? "Found something")
            )
          }
          summary={{ kind: "text", text: "awaiting" }}
          altitude="row"
          {...(arc === null
            ? {
                actionsTrailing: (
                  <TugPushButton
                    size="2xs"
                    emphasis="ghost"
                    label="Seen"
                    aria-label="Release this trip"
                    action={TUG_ACTIONS.RELEASE_TRIPWIRE}
                    focusGroup={TRIPWIRES_FOCUS_GROUP}
                    data-tripwires-seen={tripwire.name}
                  />
                ),
              }
            : {})}
        />
      </span>
    );
  }

  return null;
}

// ---------------------------------------------------------------------------
// The row
// ---------------------------------------------------------------------------

function TripwireCell({
  dataSource,
  index,
}: TugListViewCellProps<TripwiresDataSource>): React.ReactElement {
  const host = React.useContext(TripwireRowHostContext);
  const tripwire = dataSource.rowAt(index);
  const worker = useSessionIdentity(tripwire.running_session);
  const verbs = useTripwireRowVerbs(tripwire);
  const state = rowState(tripwire);
  const expanded = host.expanded.has(tripwire.name);
  const store = getTripwiresStore();
  const trips = host.trips[tripwire.name];
  const foldWord =
    trips === undefined || trips.length === 0
      ? "the definition"
      : `${trips.length} trip${trips.length === 1 ? "" : "s"}`;

  return (
    <TugListRow
      className="tripwires-row"
      variant="flush"
      density="compact"
      data-slot="tripwire-row"
      data-tripwire={tripwire.name}
      data-state={state}
      data-tripwire-paused={tripwire.paused ? "true" : "false"}
      data-tripwire-running={tripwire.running ? "true" : "false"}
      data-tripwire-awaiting={tripwire.awaiting ? "true" : "false"}
      onContextMenu={verbs.onContextMenu}
    >
      {/* The row's own responder, so the menu's items and the model popup
          dispatch to handlers that already know which tripwire they are on —
          no sampled target, and no callback reaching around the chain [L11]. */}
      <verbs.ResponderScope>
        <span
          className="tripwires-block"
          ref={verbs.responderRef as (el: HTMLSpanElement | null) => void}
        >
          {/* Line one: WHO. The tripwire's name, the hairline, and the session
              working its trip when there is one — the Arcs eyebrow, with a
              tripwire where the arc atom stands. Then the row's controls. */}
          <span className="tripwires-eyebrow" data-slot="tripwire-eyebrow">
            <span className="tripwires-name">
              <Radar size={12} aria-hidden />
              <TugLabel size="sm">{tripwire.name}</TugLabel>
            </span>
            <span className="tripwires-rule" aria-hidden="true" />
            {worker !== null ? (
              <TugSessionIdentity
                identity={worker}
                tier="chip"
                arc={false}
                tooltip={false}
                data-slot="tripwire-worker"
              />
            ) : null}
            <span className="tripwires-controls">
              <TugIconButton
                icon={tripwire.paused ? <Play size={12} /> : <Pause size={12} />}
                size="xs"
                aria-label={
                  tripwire.paused ? `Resume ${tripwire.name}` : `Pause ${tripwire.name}`
                }
                // Swallowed, or the press that pauses would also open the fold:
                // the row itself is a door, and a control standing on a door has
                // to say it was pressed instead of the door.
                onClick={(e) => {
                  e?.stopPropagation();
                  void store.setKnobs(tripwire.name, { paused: !tripwire.paused });
                }}
                focusGroup={TRIPWIRES_FOCUS_GROUP}
                data-tripwires-pause={tripwire.name}
              />
              {/* Wrapped for the same reason the model knob is: `BlockFoldCue`
                  forwards no passthrough props, so its slot has to stand on an
                  element of this card's own. */}
              <span data-slot="tripwire-fold-cue" data-tripwires-open={tripwire.name}>
                <BlockFoldCue
                  collapsed={!expanded}
                  onToggle={() => host.toggle(tripwire.name)}
                  collapsedLabel="Expand"
                  expandedLabel="Collapse"
                  ariaLabelExpand={`Expand ${tripwire.name}`}
                  ariaLabelCollapse={`Collapse ${tripwire.name}`}
                  tooltip={expanded ? `Hide ${foldWord}` : `Show ${foldWord}`}
                  size="xs"
                  subtype="icon"
                  focusGroup={TRIPWIRES_FOCUS_GROUP}
                />
              </span>
            </span>
          </span>
          {/* Line two: WHAT. The mark, the sentence, and the branch it lands
              on, at the row's own size, with the mark's box held apart from the
              text so which dot belongs to which line is never in doubt. */}
          <span className="tripwires-line" data-slot="tripwire-line">
            <RowMark tripwire={tripwire} />
            <TugLabel size="xs" className="tripwires-sentence">
              {lifecycleSentence(tripwire)}
            </TugLabel>
            <TugLabel
              size="xs"
              emphasis="calm"
              className="tripwires-branch"
              data-tripwire-branch={tripwire.branch}
            >
              {tripwire.branch}
            </TugLabel>
          </span>
          {/* Line three, only when there is something live to register. */}
          <RegisterBand tripwire={tripwire} />
          {expanded ? <Fold tripwire={tripwire} /> : null}
          {verbs.menu}
        </span>
      </verbs.ResponderScope>
    </TugListRow>
  );
}

const TRIPWIRE_CELLS = { tripwire: TripwireCell };

// ---------------------------------------------------------------------------
// The collapsed band — the live counts, on one line
// ---------------------------------------------------------------------------

/**
 * The card's first line: what the roster amounts to, wearing the rows' own
 * dots so the band and the rows beneath it cannot read as two vocabularies.
 */
function CollapsedBand({ rows }: { rows: readonly TripwireRow[] }): React.ReactElement {
  const running = rows.filter((r) => r.running).length;
  const awaiting = rows.filter((r) => r.awaiting).length;
  const paused = rows.filter((r) => r.paused).length;
  const armed = rows.length - paused;
  return (
    <span className="tripwires-band" data-slot="tripwire-band">
      <Radar size={12} aria-hidden />
      <TugLabel size="xs">{`${armed} armed`}</TugLabel>
      {running > 0 ? (
        <span className="tripwires-band-count" data-state="running">
          <TugProgressIndicator
            variant="pulsing-dot"
            size={9}
            state="running"
            role="action"
            aria-hidden
          />
          <TugLabel size="xs">{`${running} running`}</TugLabel>
        </span>
      ) : null}
      {awaiting > 0 ? (
        <span className="tripwires-band-count" data-state="awaiting">
          <TugProgressIndicator
            variant="pulsing-dot"
            size={9}
            state="stopped"
            role="caution"
            aria-hidden
          />
          <TugLabel size="xs">{`${awaiting} awaiting`}</TugLabel>
        </span>
      ) : null}
      {paused > 0 ? (
        <span className="tripwires-band-count" data-state="paused">
          <CircleMinus size={MARK_SIZE} aria-hidden />
          <TugLabel size="xs" emphasis="calm">{`${paused} paused`}</TugLabel>
        </span>
      ) : null}
    </span>
  );
}

// ---------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------

export interface TripwiresContentProps {
  /** The Tripwires card's id. */
  cardId: string;
}

export function TripwiresContent(_props: TripwiresContentProps): React.ReactElement {
  const store = getTripwiresStore();
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());

  // A fold that opens asks for its log once; the roster's own revision token
  // re-asks it after that, with no timer anywhere ([D05]).
  useEffect(() => {
    for (const name of expanded) void store.loadTrips(name);
  }, [store, expanded]);

  const dataSource = useTripwiresDataSource(snapshot.tripwires);
  const tripwires = snapshot.tripwires;
  const populated = tripwires.length > 0;

  const toggle = useCallback((name: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }, []);

  const host = useMemo<TripwireRowHost>(
    () => ({ expanded, toggle, logErrors: snapshot.logErrors, trips: snapshot.trips }),
    [expanded, toggle, snapshot.logErrors, snapshot.trips],
  );

  // The opening key view lands on a real row, never on emptiness: an empty list
  // is not a focus stop, and seeding one would arm a pending restore that paints
  // a ring on nothing. `useSeedKeyView` re-arms while the key is null, so the
  // first tripwire to arrive takes the cursor ([P02]).
  useSeedKeyView(populated ? `${TRIPWIRES_FOCUS_GROUP}:0` : null);

  // Enter on a row opens its fold — the Arcs card's gesture, and the one that
  // replaced this card's second level ([B02]). Opening the session a running
  // trip is in stays on the session dot and on the context menu, never on
  // activation, because a row with no session would then have a dead Enter.
  const delegate = useMemo<TugListViewDelegate>(
    () => ({
      onActivate: (index: number) => {
        const tripwire = tripwires[index];
        if (tripwire !== undefined) toggle(tripwire.name);
      },
    }),
    [tripwires, toggle],
  );

  // The roster's own failure, and a write refused against it. A log that would
  // not read is not here — it is under the row whose log it is ([B10]).
  const errorStrip =
    snapshot.error !== null ? (
      <div className="tripwires-error" data-tripwires-error="">
        <TugLabel size="2xs" role="danger">
          {snapshot.error}
        </TugLabel>
      </div>
    ) : null;

  return (
    <TripwireRowHostContext.Provider value={host}>
      <div className="tripwires-card">
        {/* The content element ([B01]): everything the card draws, as one
            in-flow column inside the scroller ([B02]). */}
        <div
          className="tripwires-card-content"
          data-testid="tripwires-card-content"
          data-card-content=""
        >
          {!populated ? (
            // No list until there is a row for it. A `TugListView` over zero rows
            // still registers its stop, and a stop that appears at mount and
            // vanishes when the first answer lands leaves the card's walk
            // pointing at a group that holds nothing.
            <div className="tripwires-empty" data-tripwires-empty="">
              {/* Only once the ledger has answered. "None are laid" and "nobody
                  has asked yet" are different facts, and the first read is fast
                  enough that saying the wrong one would be a flash of a lie. */}
              {snapshot.loaded ? "None" : null}
            </div>
          ) : (
            <>
              <CollapsedBand rows={tripwires} />
              <TugListView
                dataSource={dataSource as unknown as TugListViewDataSource}
                cellRenderers={TRIPWIRE_CELLS as never}
                delegate={delegate}
                inline
                rowLayout="flush"
                className="tripwires-list"
                focusGroup={TRIPWIRES_FOCUS_GROUP}
                scrollKey="tripwires-list"
                selectionRequired
                // Enter on the cursor row opens its fold. The opt-in is
                // required: a list authored into a focus group lets Enter
                // bubble to the scope's default button unless it says the list
                // IS the surface's act, and here it is — the fold is the only
                // thing a row's activation does ([B02]).
                commitOnEnter="act"
                {...RAIL_LIST_PRESENTATION}
              />
            </>
          )}
          {errorStrip}
        </div>
      </div>
    </TripwireRowHostContext.Provider>
  );
}
