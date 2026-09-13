/**
 * spike-tripwires-card.tsx — what does the Tripwires card look like once it
 * wears the Arcs card's grammar, and every dead surface on it is either live
 * or gone?
 *
 * Phase 5 of `briefs/tripwires-multi-phase-brief.md` ([B09]): shared rail
 * presentation, a two-line block per row, a register band under a row with a
 * trip in flight or a question outstanding, context-menu verbs, the fold cue
 * opening in place over the tripwire's definition and its trip log, a working
 * model knob, probe output beside its exit code, trip marks painted from a
 * `data-` attribute ([L06]), an error scoped to the row that failed, and a
 * collapsed band carrying the live counts.
 *
 * Everything here is fixture data over real components. Nothing dispatches:
 * the verbs are drawn to be looked at, and the actions they name are
 * stand-ins from the vocabulary until the card's own are minted. The roster is
 * five tripwires chosen to show every row shape at once — one awaiting with
 * an arc, one awaiting with none, one running with a session, one paused
 * with a long log, one armed and silent.
 *
 * Settled on the first round (2026-09-14): the fold rather than a second
 * level; Enter opens the fold; an awaiting trip is released by its arc's
 * fate, or by a Seen act when it authored no arc ([B05]); the collapsed band
 * is the card's first line. Also from that round: the log cannot be endless —
 * it opens over five rows, rolls consecutive never-ran trips into one line,
 * pages the rest on request, and the ledger keeps five hundred per tripwire.
 *
 * Second round: quiet finishes roll up too, and the register band rides the
 * block header's new `row` altitude rather than reaching into its tokens.
 *
 * Third round: the brief is never a hover. The shipped card put the whole
 * brief in a tooltip over its gist, which is a wall of text nobody asked
 * for; here the definition row is a two-line clamp with the reveal the clamp
 * already owns, so the rest is one press away and never uninvited. The type
 * stays at the rail's one measure — the shipped log's outsized arc atom and
 * headline are not carried over. And the card speaks the focus language:
 * the roster rows are the stops, arrows walk them, Enter opens the fold, and
 * every control on a row — pause, cue, model, Seen, older — joins the
 * card's one focus group so Tab reaches it in reading order.
 *
 * @module spikes/spike-tripwires-card
 */

import "./spike.css";
import "./spike-tripwires-card.css";

import React, { useCallback, useId, useMemo, useState } from "react";
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

import { TUG_ACTIONS } from "@/components/tugways/action-vocabulary";
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
import {
  TugListView,
  type TugListViewCellProps,
  type TugListViewDataSource,
  type TugListViewDelegate,
} from "@/components/tugways/tug-list-view";
import {
  TugPopupButton,
  type TugPopupButtonItem,
} from "@/components/tugways/tug-popup-button";
import { TugProgressIndicator } from "@/components/tugways/tug-progress-indicator";
import { TugPushButton } from "@/components/tugways/tug-push-button";
import { TugSectionLabel } from "@/components/tugways/tug-section-label";
import { TugSessionIdentity } from "@/components/tugways/tug-session-identity";
import { useSeedKeyView } from "@/components/tugways/use-focusable";
import { useResponderForm } from "@/components/tugways/use-responder-form";
import {
  tripSentence,
  tripState,
  tripStateLabel,
  tripwireDefinition,
} from "@/components/tripwires/tripwire-presentation";
import {
  useTripwiresDataSource,
  type TripwiresDataSource,
} from "@/components/tripwires/tripwires-data-source";
import { formatContextualStamp } from "@/lib/contextual-stamp";
import type { SessionIdentity } from "@/lib/session-identity";
import type { TripRow, TripwireRow } from "@/lib/tripwires-store";

import type { SpikeDef } from "./spike-registry";

// ---------------------------------------------------------------------------
// Fixtures — four tripwires, one per row shape
// ---------------------------------------------------------------------------

const NOW = Date.now();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const WORKER_ID = "68ebb98b-c6dc-4395-954d-f7c7f2cdb595";

/** The session a running trip is in, as the chip beside the name shows it. */
const WORKER: SessionIdentity = {
  project: "tug",
  branch: null,
  tag: "kind-visor",
  customName: null,
  description: "Diagnosing why at0492 went red on 34f4e4dd1",
  state: null,
  id: WORKER_ID,
  shortId: WORKER_ID.slice(0, 8),
  resolved: true,
};

function tripwire(over: Partial<TripwireRow> & { name: string }): TripwireRow {
  return {
    trigger: '{"fact":{"kind":"edit_failed"}}',
    scope: "/Users/kocienda/Mounts/u/src/tug",
    probe: null,
    brief:
      "Diagnose the failure and say whether the tool or the caller was wrong. " +
      "Read the program against the current bytes of the files it names before judging.",
    model: null,
    branch: "main",
    permission_mode: "acceptEdits",
    paused: false,
    running: false,
    adopted: false,
    running_session: null,
    awaiting: false,
    awaiting_arc: null,
    last_trip: null,
    trip_log_revision: 1,
    ...over,
  };
}

let nextTripId = 1;
function trip(over: Partial<TripRow> & { at_ms: number; status: string }): TripRow {
  return {
    id: nextTripId++,
    tripwire_id: 1,
    event_key: "landing:34f4e4dd1",
    instance: "this",
    swallow_reason: null,
    event_payload: null,
    probe_exit: null,
    probe_tail: null,
    session_id: null,
    arc: null,
    headline: null,
    refs: null,
    settled_at_ms: null,
    author_ask: null,
    ...over,
  };
}

const EDITS_ARC = "tripwire-edits-a1b2c3d4";

const TRIPWIRES: readonly TripwireRow[] = [
  tripwire({
    name: "edits",
    probe: "just tugplug-lint",
    awaiting: true,
    awaiting_arc: EDITS_ARC,
    last_trip: {
      at_ms: NOW - 1 * HOUR,
      status: "awaiting",
      headline: "The patch hunk was squared off under the op line; a fix is on its arc.",
    },
  }),
  tripwire({
    name: "ci-confidence",
    trigger: '{"fact":{"kind":"commit"}}',
    probe: "just test-quick",
    model: "opus",
    permission_mode: "plan",
    running: true,
    running_session: WORKER_ID,
    last_trip: { at_ms: NOW - 4 * MIN, status: "running", headline: null },
  }),
  tripwire({
    name: "lint-drift",
    trigger: '{"fact":{"kind":"commit","where":{"paths":{"prefix":"tugdeck/"}}}}',
    probe: "bun run lint",
    paused: true,
    last_trip: { at_ms: NOW - 3 * DAY, status: "settled", headline: null },
  }),
  tripwire({
    name: "stale-docs",
    trigger: '{"fact":{"kind":"commit","where":{"paths":{"prefix":"tuglaws/"}}}}',
    branch: "release",
    model: "haiku",
  }),
  tripwire({
    name: "flaky-tests",
    trigger: '{"fact":{"kind":"apptest_failed"}}',
    permission_mode: "plan",
    awaiting: true,
    last_trip: {
      at_ms: NOW - 20 * MIN,
      status: "awaiting",
      headline: "at0287 failed twice on the same commit and passed alone; nothing to author.",
    },
  }),
];

/** Trip logs keyed by name — what the fold opens over. */
const TRIPS: Readonly<Record<string, readonly TripRow[]>> = {
  edits: [
    trip({
      at_ms: NOW - 1 * HOUR,
      status: "awaiting",
      probe_exit: 1,
      probe_tail:
        "tugplug-lint: skills/tripwire/SKILL.md:41 names `just` — checkout-only shape\n" +
        "error: Recipe `tugplug-lint` failed on line 12 with exit code 1",
      arc: EDITS_ARC,
      headline: "The patch hunk was squared off under the op line; a fix is on its arc.",
      author_ask: "Fix the hunk's indentation and add the receipt test.",
    }),
    trip({
      at_ms: NOW - 3 * HOUR,
      status: "swallowed",
      swallow_reason: "busy",
    }),
    trip({
      at_ms: NOW - 1 * DAY,
      status: "failed",
      swallow_reason: "instance restarted",
      probe_exit: 1,
      probe_tail: "error: Recipe `tugplug-lint` failed on line 12 with exit code 1",
    }),
    trip({
      at_ms: NOW - 2 * DAY,
      status: "settled",
      probe_exit: 0,
      probe_tail: "tugplug-lint: ok",
      settled_at_ms: NOW - 2 * DAY + 3 * MIN,
    }),
  ],
  "ci-confidence": [
    trip({
      at_ms: NOW - 4 * MIN,
      status: "running",
      probe_exit: 1,
      probe_tail: "FAIL at0492-tripwires-card.test.ts › roster order\n1 failed, 19 passed",
      session_id: WORKER_ID,
    }),
  ],
  // A tripwire that has fired a great many times: the shape the log has to
  // survive. Forty-eight trips: a run of quiet finishes, then mostly swallowed.
  "lint-drift": Array.from({ length: 48 }, (_, i) => {
    const at = NOW - 3 * DAY - i * 5 * HOUR;
    // The first eight are a run of quiet finishes; after that, mostly
    // swallowed, with the odd finish and one that found something.
    if (i < 8 || i % 9 === 0) {
      return trip({ at_ms: at, status: "settled", probe_exit: 0, probe_tail: "ok" });
    }
    if (i % 13 === 0) {
      return trip({
        at_ms: at,
        status: "settled",
        probe_exit: 1,
        probe_tail: "tugdeck/src/spikes/spike-home.tsx:12 unused import",
        headline: "One unused import, already removed by the author before this ran.",
      });
    }
    return trip({
      at_ms: at,
      status: "swallowed",
      swallow_reason: i % 3 === 0 ? "no-match" : "busy",
    });
  }),
  "stale-docs": [],
  "flaky-tests": [
    trip({
      at_ms: NOW - 20 * MIN,
      status: "awaiting",
      headline: "at0287 failed twice on the same commit and passed alone; nothing to author.",
    }),
  ],
};

const MODEL_ITEMS: TugPopupButtonItem<string>[] = [
  "The session default",
  "opus",
  "sonnet",
  "haiku",
].map((label) => ({ action: TUG_ACTIONS.SET_VALUE, value: label, label }));

/** The card's one focus group: every stop the card offers, rows and controls. */
const FOCUS_GROUP = "spike-tripwires";

// ---------------------------------------------------------------------------
// Per-row readings — the line beneath the eyebrow, and its mark
// ---------------------------------------------------------------------------

type RowState = "running" | "awaiting" | "paused" | "armed";

function rowState(t: TripwireRow): RowState {
  if (t.running) return "running";
  if (t.awaiting) return "awaiting";
  if (t.paused) return "paused";
  return "armed";
}

/** What the tripwire is DOING, one line, the lifecycle line's job. */
function lifecycleSentence(t: TripwireRow): string {
  const last = t.last_trip;
  const ago = last === null ? null : formatContextualStamp(last.at_ms, {});
  switch (rowState(t)) {
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

/** The mark on the line: a dot for the two live states, a glyph for paused,
 *  and an empty box at rest so the sentence stands at one x on every row. */
function RowMark({ state }: { state: RowState }): React.ReactElement {
  return (
    <span className="sp-tw-mark" data-state={state}>
      {state === "running" || state === "awaiting" ? (
        <TugProgressIndicator
          variant="pulsing-dot"
          size={11}
          state={state === "running" ? "running" : "stopped"}
          role={state === "running" ? "action" : "caution"}
          aria-hidden
        />
      ) : state === "paused" ? (
        <CircleMinus size={11} />
      ) : null}
    </span>
  );
}

/** A trip's mark in the log — state on the wrapper, color in CSS ([L06]). */
function TripMark({ row }: { row: TripRow }): React.ReactElement {
  const state = tripState(row);
  return (
    <span className="sp-tw-mark" data-state={state}>
      {state === "running" ? (
        <TugProgressIndicator variant="pulsing-dot" size={11} state="running" role="action" aria-hidden />
      ) : state === "awaiting" ? (
        <TugProgressIndicator variant="pulsing-dot" size={11} state="stopped" role="caution" aria-hidden />
      ) : state === "failed" ? (
        <CircleAlert size={11} />
      ) : state === "skipped" ? (
        <CircleMinus size={11} />
      ) : state === "waiting" ? (
        <Clock size={11} />
      ) : (
        <CircleDot size={11} />
      )}
    </span>
  );
}

// ---------------------------------------------------------------------------
// The row's verbs — right-click, as the Arcs card does it
// ---------------------------------------------------------------------------

function useTripwireRowMenu(t: TripwireRow): {
  onContextMenu: (e: React.MouseEvent) => void;
  menu: React.ReactNode;
} {
  const [openAt, setOpenAt] = useState<{ x: number; y: number } | null>(null);
  const close = useCallback(() => setOpenAt(null), []);
  const onContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setOpenAt({ x: e.clientX, y: e.clientY });
  }, []);
  const items = useMemo<TugEditorContextMenuEntry[]>(
    () => [
      { action: TUG_ACTIONS.SET_VALUE, value: "toggle", label: t.paused ? "Resume" : "Pause" },
      {
        action: TUG_ACTIONS.SET_VALUE,
        value: "trip",
        label: t.running ? "Trip now — already working a trip" : "Trip now",
        disabled: t.running,
      },
      { type: "separator" },
      {
        action: TUG_ACTIONS.SET_VALUE,
        value: "open",
        label: t.running_session === null ? "Open session — no trip is running" : "Open session",
        disabled: t.running_session === null,
      },
      {
        action: TUG_ACTIONS.SET_VALUE,
        value: "release",
        label: t.awaiting ? "Release" : "Release — nothing is awaiting",
        disabled: !t.awaiting,
      },
    ],
    [t.paused, t.running, t.running_session, t.awaiting],
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
  return { onContextMenu, menu };
}

// ---------------------------------------------------------------------------
// The fold — definition, then the log
// ---------------------------------------------------------------------------

function Definition({ t }: { t: TripwireRow }): React.ReactElement {
  const host = React.useContext(RowHostContext);
  return (
    <dl className="sp-tw-definition" data-slot="tripwire-definition">
      {tripwireDefinition(t).map((row) => (
        <React.Fragment key={row.label}>
          <dt>
            <TugLabel size="2xs" emphasis="calm">
              {row.label}
            </TugLabel>
          </dt>
          <dd data-mono={row.mono === true ? "" : undefined}>
            {row.label === "Model" ? (
              // The one knob beside pause that is writable from the card. A
              // popup rather than a text field: the values are a short list.
              <TugPopupButton
                size="xs"
                label={host.model}
                items={MODEL_ITEMS}
                senderId={host.modelSenderId}
                focusGroup={FOCUS_GROUP}
              />
            ) : row.full !== undefined ? (
              // The brief, whole, behind a two-line clamp — never a hover. A
              // brief is paragraphs, and a tooltip carrying paragraphs is the
              // shipped card's wart; the clamp's own reveal is the door.
              <TugClamp lines={2} showMoreLabel="More" showLessLabel="Less">
                <TugLabel size="2xs">{row.full}</TugLabel>
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

function TripLogRow({ row }: { row: TripRow }): React.ReactElement {
  const state = tripState(row);
  const headline = row.headline;
  const word = headline === null ? null : tripStateLabel(row);
  return (
    <TugListRow
      variant="flush"
      density="compact"
      className="sp-tw-trip"
      data-slot="tripwire-trip"
      data-trip-state={state}
    >
      <span className="sp-tw-trip-body">
        <span className="sp-tw-trip-head">
          <TripMark row={row} />
          <TugLabel size="xs" maxLines={3}>
            {headline ?? tripSentence(row)}
          </TugLabel>
        </span>
        <span className="sp-tw-trip-meta">
          <TugLabel size="2xs" emphasis="calm">
            {formatContextualStamp(row.at_ms, { seconds: true, ratioSeparator: true })}
          </TugLabel>
          {word !== null ? (
            <TugLabel size="2xs" emphasis="calm">
              {word}
            </TugLabel>
          ) : null}
          {row.probe_exit !== null ? (
            <TugBadge size="2xs" emphasis="ghost" role={row.probe_exit === 0 ? "success" : "danger"}>
              {`probe ${row.probe_exit}`}
            </TugBadge>
          ) : null}
          {row.arc !== null ? <TugAtomRef entity={{ kind: "arc", name: row.arc }} /> : null}
        </span>
        {/* The probe's tail sits beside its exit code, not in a tooltip: the
            number says it failed, and this is the line that says why. */}
        {row.probe_tail !== null ? (
          <pre className="sp-tw-probe-tail" data-slot="tripwire-probe-tail">
            {row.probe_tail}
          </pre>
        ) : null}
      </span>
    </TugListRow>
  );
}

/**
 * The log as rows: consecutive trips that never ran fold into one quiet row,
 * and so do consecutive trips that ran and found nothing, because nine
 * "didn't run — busy" lines say one thing nine times, and so do nine
 * "finished with nothing to report". A trip with a headline, a failure, or
 * a question is never folded: those are the rows the log exists for.
 */
type RollupKind = "skipped" | "quiet";
type LogEntry =
  | { kind: "trip"; row: TripRow }
  | { kind: "rollup"; roll: RollupKind; rows: readonly TripRow[] };

function rollupKind(row: TripRow): RollupKind | null {
  const state = tripState(row);
  if (state === "skipped") return "skipped";
  if (state === "finished" && row.headline === null) return "quiet";
  return null;
}

function rollUp(trips: readonly TripRow[]): LogEntry[] {
  const out: LogEntry[] = [];
  for (const row of trips) {
    const last = out[out.length - 1];
    const roll = rollupKind(row);
    if (roll !== null) {
      if (last !== undefined && last.kind === "rollup" && last.roll === roll) {
        out[out.length - 1] = { kind: "rollup", roll, rows: [...last.rows, row] };
      } else {
        out.push({ kind: "rollup", roll, rows: [row] });
      }
    } else {
      out.push({ kind: "trip", row });
    }
  }
  // A run of one is just a trip.
  return out.map((e) =>
    e.kind === "rollup" && e.rows.length === 1 ? { kind: "trip", row: e.rows[0] } : e,
  );
}

function RollupRow({
  roll,
  rows,
}: {
  roll: RollupKind;
  rows: readonly TripRow[];
}): React.ReactElement {
  // The one thing a folded run still has to say: why, for the skipped, and
  // how the probe went, for the quiet.
  const counts = new Map<string, number>();
  for (const r of rows) {
    const key =
      roll === "skipped"
        ? (r.swallow_reason ?? "superseded")
        : r.probe_exit === null
          ? "no probe"
          : `probe ${r.probe_exit}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const detail = [...counts.entries()].map(([k, n]) => `${k} ×${n}`).join(", ");
  const sentence =
    roll === "skipped"
      ? `Didn't run ×${rows.length} — ${detail}`
      : `Finished with nothing to report ×${rows.length} — ${detail}`;
  const first = rows[rows.length - 1];
  const last = rows[0];
  return (
    <TugListRow
      variant="flush"
      density="compact"
      className="sp-tw-trip"
      data-slot="tripwire-rollup"
      data-trip-state={roll === "skipped" ? "skipped" : "finished"}
    >
      <span className="sp-tw-trip-body">
        <span className="sp-tw-trip-head">
          <span className="sp-tw-mark" data-state={roll === "skipped" ? "skipped" : "finished"}>
            {roll === "skipped" ? <CircleMinus size={11} /> : <CircleDot size={11} />}
          </span>
          <TugLabel size="xs" emphasis="calm">
            {sentence}
          </TugLabel>
        </span>
        <span className="sp-tw-trip-meta">
          <TugLabel size="2xs" emphasis="calm">
            {`${formatContextualStamp(first.at_ms, {})} – ${formatContextualStamp(last.at_ms, {})}`}
          </TugLabel>
        </span>
      </span>
    </TugListRow>
  );
}

/** How many log rows a fold opens over before asking. */
const LOG_WINDOW = 5;
/** How many more each press of the older cue adds. */
const LOG_PAGE = 25;

function Fold({ t }: { t: TripwireRow }): React.ReactElement {
  const entries = useMemo(() => rollUp(TRIPS[t.name] ?? []), [t.name]);
  const [shown, setShown] = useState(LOG_WINDOW);
  const visible = entries.slice(0, shown);
  const older = entries.length - visible.length;
  return (
    <span className="sp-tw-fold" data-slot="tripwire-fold">
      <Definition t={t} />
      <TugSectionLabel
        label={{ name: "Trip log", qualifier: "every firing, posted or not" }}
        slot="tripwire-trip-log"
        className="sp-tw-log-label"
      />
      {entries.length === 0 ? (
        <span className="sp-tw-log-empty">None</span>
      ) : (
        visible.map((e) =>
          e.kind === "trip" ? (
            <TripLogRow key={e.row.id} row={e.row} />
          ) : (
            <RollupRow key={`rollup-${e.rows[0].id}`} roll={e.roll} rows={e.rows} />
          ),
        )
      )}
      {/* The rest of the log, on request, a page at a time. The ledger keeps
          the most recent five hundred per tripwire, so this cue bottoms out. */}
      {older > 0 ? (
        <span className="sp-tw-log-older">
          <TugPushButton
            size="2xs"
            emphasis="ghost"
            icon={<ChevronDown size={11} />}
            label={`Show ${Math.min(older, LOG_PAGE)} older${older > LOG_PAGE ? ` of ${older}` : ""}`}
            onClick={() => setShown((n) => n + LOG_PAGE)}
            focusGroup={FOCUS_GROUP}
          />
        </span>
      ) : null}
      {/* An error scoped to the thing that failed — this log, under this row —
          rather than a strip over the whole card. Drawn on one row only. */}
      {t.name === "lint-drift" ? (
        <span className="sp-tw-scoped-error" data-slot="tripwire-log-error">
          <TugLabel size="2xs" role="danger">
            Couldn't read this log: GET /api/tripwires/lint-drift/trips answered 503.
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
 * What releases an awaiting trip ([B05]), settled: the arc's own fate when
 * the trip authored one — the band names the arc and says it holds until
 * that arc is joined or discarded — and a "Seen" act on the band when it
 * authored nothing, because then nothing else can end the hold.
 */
function RegisterBand({ t }: { t: TripwireRow }): React.ReactElement | null {
  const state = rowState(t);
  if (state === "running") {
    return (
      <span className="sp-tw-register" data-slot="tripwire-register" data-word="running">
        <BlockHeader
          ariaName="trip"
          phase="in_flight"
          target="Diagnosing why at0492 went red on 34f4e4dd1"
          summary={{ kind: "text", text: "running" }}
          altitude="row"
        />
      </span>
    );
  }
  if (state === "awaiting") {
    const arc = t.awaiting_arc;
    return (
      <span className="sp-tw-register" data-slot="tripwire-register" data-word="awaiting">
        <BlockHeader
          ariaName="trip"
          phase="awaiting"
          target={
            arc !== null ? (
              <span className="sp-tw-register-target">
                <span>Holding until</span>
                <TugAtomRef entity={{ kind: "arc", name: arc }} />
                <span>is joined or discarded</span>
              </span>
            ) : (
              (t.last_trip?.headline ?? "Found something")
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
                    focusGroup={FOCUS_GROUP}
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

interface RowHost {
  expanded: ReadonlySet<string>;
  toggle: (name: string) => void;
  paused: ReadonlySet<string>;
  togglePaused: (name: string) => void;
  model: string;
  modelSenderId: string;
}

const RowHostContext = React.createContext<RowHost>({
  expanded: new Set(),
  toggle: () => {},
  paused: new Set(),
  togglePaused: () => {},
  model: "The session default",
  modelSenderId: "",
});

function TripwireCell({
  dataSource,
  index,
}: TugListViewCellProps<TripwiresDataSource>): React.ReactElement {
  const host = React.useContext(RowHostContext);
  const base = dataSource.rowAt(index);
  // Pause is the spike's one live knob: the fixture is re-read through it so
  // the row, its line, and its menu all move together on a press.
  const paused = host.paused.has(base.name);
  const t: TripwireRow = paused === base.paused ? base : { ...base, paused };
  const state = rowState(t);
  const expanded = host.expanded.has(t.name);
  const verbs = useTripwireRowMenu(t);
  const trips = TRIPS[t.name] ?? [];
  const foldWord = trips.length === 0 ? "the definition" : `${trips.length} trip${trips.length === 1 ? "" : "s"}`;

  return (
    <TugListRow
      className="sp-tw-row"
      variant="flush"
      density="compact"
      data-slot="tripwire-row"
      data-tripwire={t.name}
      data-state={state}
      data-activatable={t.running_session !== null ? "true" : undefined}
      onContextMenu={verbs.onContextMenu}
    >
      <span className="sp-tw-block">
        {/* Line one: WHO. The tripwire's name, the hairline, and the session
            working its trip when there is one — the Arcs eyebrow, with a
            tripwire where the arc atom stands. Then the row's controls. */}
        <span className="sp-tw-eyebrow" data-slot="tripwire-eyebrow">
          <span className="sp-tw-name">
            <Radar size={12} aria-hidden />
            <TugLabel size="sm">{t.name}</TugLabel>
          </span>
          <span className="sp-tw-rule" aria-hidden="true" />
          {t.running_session !== null ? (
            <TugSessionIdentity
              identity={WORKER}
              tier="chip"
              arc={false}
              tooltip={false}
              data-slot="tripwire-worker"
            />
          ) : null}
          <span className="sp-tw-controls">
            <TugIconButton
              icon={t.paused ? <Play size={12} /> : <Pause size={12} />}
              size="xs"
              aria-label={t.paused ? `Resume ${t.name}` : `Pause ${t.name}`}
              onClick={(e) => {
                e?.stopPropagation();
                host.togglePaused(t.name);
              }}
              focusGroup={FOCUS_GROUP}
            />
            <BlockFoldCue
              collapsed={!expanded}
              onToggle={() => host.toggle(t.name)}
              collapsedLabel="Expand"
              expandedLabel="Collapse"
              ariaLabelExpand={`Expand ${t.name}`}
              ariaLabelCollapse={`Collapse ${t.name}`}
              tooltip={expanded ? `Hide ${foldWord}` : `Show ${foldWord}`}
              size="xs"
              subtype="icon"
              data-slot="tripwire-fold-cue"
              focusGroup={FOCUS_GROUP}
            />
          </span>
        </span>
        {/* Line two: WHAT. The mark, the sentence, and the branch it lands on,
            at the row's own size, with the mark's box held apart from the text
            so which dot belongs to which line is never in doubt. */}
        <span className="sp-tw-line" data-slot="tripwire-line">
          <RowMark state={state} />
          <TugLabel size="xs" className="sp-tw-sentence">
            {lifecycleSentence(t)}
          </TugLabel>
          <TugLabel size="xs" emphasis="calm" className="sp-tw-branch">
            {t.branch}
          </TugLabel>
        </span>
        {/* Line three, only when there is something live to register. */}
        <RegisterBand t={t} />
        {expanded ? <Fold t={t} /> : null}
        {verbs.menu}
      </span>
    </TugListRow>
  );
}

const CELLS = { tripwire: TripwireCell };

// ---------------------------------------------------------------------------
// The collapsed band — the live counts, on one line
// ---------------------------------------------------------------------------

function CollapsedBand({ rows }: { rows: readonly TripwireRow[] }): React.ReactElement {
  const running = rows.filter((r) => r.running).length;
  const awaiting = rows.filter((r) => r.awaiting).length;
  const paused = rows.filter((r) => r.paused).length;
  const armed = rows.length - paused;
  return (
    <span className="sp-tw-band" data-slot="tripwire-band">
      <Radar size={12} aria-hidden />
      <TugLabel size="xs">{`${armed} armed`}</TugLabel>
      {running > 0 ? (
        <span className="sp-tw-band-count" data-state="running">
          <TugProgressIndicator variant="pulsing-dot" size={9} state="running" role="action" aria-hidden />
          <TugLabel size="xs">{`${running} running`}</TugLabel>
        </span>
      ) : null}
      {awaiting > 0 ? (
        <span className="sp-tw-band-count" data-state="awaiting">
          <TugProgressIndicator variant="pulsing-dot" size={9} state="stopped" role="caution" aria-hidden />
          <TugLabel size="xs">{`${awaiting} awaiting`}</TugLabel>
        </span>
      ) : null}
      {paused > 0 ? (
        <span className="sp-tw-band-count" data-state="paused">
          <CircleMinus size={11} aria-hidden />
          <TugLabel size="xs" emphasis="calm">{`${paused} paused`}</TugLabel>
        </span>
      ) : null}
    </span>
  );
}

// ---------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------

function Caption({ children }: { children: React.ReactNode }): React.ReactElement {
  return <p className="sp-tw-caption">{children}</p>;
}

function SpikeTripwiresCard(): React.ReactElement {
  const dataSource = useTripwiresDataSource(TRIPWIRES);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set(["edits"]));
  const [paused, setPaused] = useState<ReadonlySet<string>>(
    () => new Set(TRIPWIRES.filter((t) => t.paused).map((t) => t.name)),
  );
  const [model, setModel] = useState("The session default");
  // One sender id for every model popup on the card, so one binding reads
  // them all: the spike has one model, and which row's fold it was set from
  // is not a fact it keeps.
  const modelSenderId = useId();
  const form = useResponderForm({
    setValueString: { [modelSenderId]: (v: string) => setModel(v) },
  });

  const host = useMemo<RowHost>(
    () => ({
      expanded,
      toggle: (name) =>
        setExpanded((prev) => {
          const next = new Set(prev);
          if (next.has(name)) next.delete(name);
          else next.add(name);
          return next;
        }),
      paused,
      togglePaused: (name) =>
        setPaused((prev) => {
          const next = new Set(prev);
          if (next.has(name)) next.delete(name);
          else next.add(name);
          return next;
        }),
      model,
      modelSenderId,
    }),
    [expanded, paused, model, modelSenderId],
  );

  // The opening key view lands on the first row, so the arrows walk the
  // roster the moment the card is key ([P02]).
  useSeedKeyView(`${FOCUS_GROUP}:0`);

  // Enter on a row opens its fold — settled in the first round.
  const delegate = useMemo<TugListViewDelegate>(
    () => ({
      onActivate: (index: number) => {
        const t = TRIPWIRES[index];
        if (t !== undefined) host.toggle(t.name);
      },
    }),
    [host],
  );

  return (
    <form.ResponderScope>
      <div
        className="sp-content sp-tw"
        ref={form.responderRef as (el: HTMLDivElement | null) => void}
      >
        <section className="sp-section">
          <h2 className="sp-section-title">The card</h2>
          <Caption>
            The collapsed band is the card's first line: the live counts, wearing the rows'
            own dots. Each tripwire is a two-line block; a row with a trip in flight or a
            question outstanding carries the register band beneath, at the row's own size.
            An awaiting trip that authored an arc holds until that arc is joined or
            discarded; one that authored nothing offers Seen. Enter and the cue open the
            fold in place. The log shows five rows, folds runs of trips that never ran into
            one line, and reaches the rest a page at a time. Right-click a row for its verbs.
            The pause control is live; nothing else dispatches.
          </Caption>
          <RowHostContext.Provider value={host}>
            <div className="sp-tw-frame sp-tw-frame-list">
              <CollapsedBand rows={TRIPWIRES} />
              <TugListView
                dataSource={dataSource as unknown as TugListViewDataSource}
                cellRenderers={CELLS as never}
                delegate={delegate}
                inline
                rowLayout="flush"
                focusGroup={FOCUS_GROUP}
                scrollKey="spike-tripwires"
                selectionRequired
                {...RAIL_LIST_PRESENTATION}
                className="sp-tw-list"
              />
            </div>
          </RowHostContext.Provider>
        </section>
      </div>
    </form.ResponderScope>
  );
}

export const spike: SpikeDef = {
  name: "tripwires-card",
  title: "Tripwires Card",
  blurb:
    "The Tripwires card in the Arcs card's grammar: two-line rows, a register band, a fold over the log, verbs, and the awaiting act.",
  icon: "Radar",
  // The card's rows are engine focus stops and the arrows are how it is
  // read, so it wears the focus rings at rest, as the rail cards do ([P10]).
  kbfAtRest: true,
  size: {
    min: { width: 420, height: 400 },
    preferred: { width: 520, height: 900 },
  },
  component: () => <SpikeTripwiresCard />,
};
