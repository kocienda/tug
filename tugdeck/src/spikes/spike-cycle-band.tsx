/**
 * spike-cycle-band.tsx — can one shade at the bottom of the Session card show
 * a cycle of arcs, say at a glance what waits on what, and start the next arc
 * by filling the prompt, without a prompt of its own?
 *
 * A **cycle** is a chain of arcs, each cut from its own brief, with what each
 * waits on. The model writes it; every surface here only reads it. The fixture
 * is the eight arcs of `liven/rotund-plaid`, reshaped to one brief per arc.
 *
 * Fourth round. The shade stands over an ordinary transcript, and holds, top
 * to bottom:
 *
 *   - **A header**, pinned: the lowering control at its top left, the cycle's
 *     name, and how much of it has landed.
 *   - **The map.** The cycle drawn as a graph: each entry is a tile, each
 *     wait a wire, and a tile's column is how deep its waits run. A sketch is
 *     a seal with a wire to each entry it heads, seated in the column just
 *     before them, so a sketch added late stands beside what it added. A wire
 *     is solid once what it leaves has landed. Pointing at a tile lights the
 *     wires into it. Laid out by `spike-cycle-band-layout.ts`. The tiles and
 *     wires are drawn here because they are the thing being explored;
 *     everything else is composed.
 *   - **The assets**, one list under the map and the only other drawing of
 *     anything on it: each sketch whole, then each entry it heads. An entry
 *     is a brief, and its arc is what happens to that brief, so the entry is
 *     headed by its brief's title, on its tile's tooltip as well. Under the
 *     title: its arc once one has opened, the brief as a file atom that
 *     opens it, the session running it when that is another session, what
 *     it waits on as the numbers the map wears, and its steps once it runs.
 *     An entry no arc has opened names no arc. The list scrolls by
 *     itself. A press on the map scrolls the pressed asset to the top of the
 *     list and moves nothing else, so the point pressed stays under the
 *     pointer. Only when the shade is too short for the map and a few lines
 *     of the list does the map scroll away with the content.
 *   - **A footer** of two lines: what this session is doing now, and what is
 *     ready next, with Start.
 *
 * The status row keeps its five cells, and the one that read `ARC` reads
 * `CYCLE`: pressed, it raises and lowers the shade. The switches left are the
 * open questions:
 *
 *   - whether a lowered shade leaves its footer standing or leaves nothing;
 *   - whether another shade covers the footer or stands on it;
 *   - what the shade gives up at the card's slim width.
 *
 * Under the Session card stands the sidebar card, as Cycles & Arcs. It draws
 * the same cycle with the same parts, cut to the sidebar's width: each
 * cycle's header and map pin to the top of the card while its assets scroll
 * under them, and each asset is one row that opens in place to everything
 * the shade's asset holds — a sketch whole, an entry with its brief, its
 * session and its steps. An arc that is a cycle of one is the same row with
 * no map and no number. A press on the map opens the pressed asset and
 * scrolls it up under the map.
 *
 * Nothing here sends a frame. A Start press places a command in the prompt
 * stand-in and stops there: the press fills, the user sends. Each entry's
 * state is derived from what has joined, never stored.
 */

import "./spike.css";
import "./spike-cycle-band.css";

import React, { useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Play, Search, SquareArrowOutUpRight } from "lucide-react";

import type { SpikeDef } from "./spike-registry";
import { cycleMap, type CycleMapEntry, type CycleMapSeat } from "./spike-cycle-band-layout";
import { ArcLifecycleMark } from "@/components/tugways/arc-lifecycle-mark";
import { ArcStepItems } from "@/components/tugways/arc-step-list";
import { BlockFoldCue } from "@/components/tugways/body-kinds/affordances/block-fold-cue";
import { SessionIdentityView } from "@/components/tugways/cards/session-identity";
import { recordBody } from "@/components/tugways/cards/session-arc-record";
import { SessionTelemetryCell } from "@/components/tugways/cards/session-telemetry-cell";
import { CYCLE_MAP_MEASURES } from "@/components/tugways/cycle-map-layout";
import { TugArcAtom } from "@/components/tugways/tug-arc-atom";
import { arcTrackModel, TugArcTrack, type ArcTrackModel } from "@/components/tugways/tug-arc-track";
import { TugAtomRef } from "@/components/tugways/tug-atom-ref";
import { TugBadge } from "@/components/tugways/tug-badge";
import { TugChoiceGroup, type TugChoiceItem } from "@/components/tugways/tug-choice-group";
import { TugLabel } from "@/components/tugways/tug-label";
import { TugListRow } from "@/components/tugways/tug-list-row";
import { TugPopupListFrame, TugPopupListScroller } from "@/components/tugways/tug-popup-list";
import { TugPushButton } from "@/components/tugways/tug-push-button";
import { TugTooltip } from "@/components/tugways/tug-tooltip";
import { useResponderForm } from "@/components/tugways/use-responder-form";
import type { ArcStep } from "@/lib/changeset-types";
import { sessionNameStore } from "@/lib/session-name-store";
import { useSessionIdentity } from "@/lib/session-identity";
import { sessionTagStore } from "@/lib/session-tag-store";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ROOT = "/Users/kocienda/Mounts/u/src/liven";
const HERE = "81acbce8-0000-4000-8000-0000000c1c1e";
const OTHER = "5d2e9b10-0000-4000-8000-0000000c1c1e";

sessionNameStore.setName(HERE, "liven styles");
sessionTagStore.setTag(HERE, "rotund-plaid");
sessionNameStore.setName(OTHER, "prop rig spike");
sessionTagStore.setTag(OTHER, "glossy-bowl");

/** One entry of a cycle: a brief, the one arc cut from it, and what it waits on. */
interface Entry {
  n: number;
  arc: string;
  brief: string;
  /** The brief's title: what the work is, in a sentence. It heads the entry everywhere. */
  title: string;
  /** The entries that must have joined before this one is ready. */
  waits: readonly number[];
  /** What the user owes the entry. A note, never a state. */
  note?: string;
  /** Which of the cycle's sketches the entry came from. */
  sketch: 1 | 2;
  steps: readonly string[];
}

const STEPS_SPIKE = ["Draw the sheet", "Write up what it showed"];
const STEPS_SHIP = [
  "Take the baseline",
  "Move the role table",
  "Load the borrowed roles",
  "Update the docs",
  "Final reading",
];

const EIGHT: readonly Entry[] = [
  { n: 1, arc: "liven-tooled-ground", brief: "liven-tooled-ground-spike-brief.md", title: "Try the tooled ground on a sheet", waits: [], sketch: 1, steps: STEPS_SPIKE },
  { n: 2, arc: "liven-neomod-spike", brief: "liven-neomod-spike-brief.md", title: "Try the neomod look on a sheet", waits: [], note: "Needs your mood board", sketch: 1, steps: STEPS_SPIKE },
  { n: 3, arc: "liven-prop-rig-spike", brief: "liven-prop-rig-spike-brief.md", title: "Try a rigged prop on a sheet", waits: [], sketch: 1, steps: STEPS_SPIKE },
  { n: 4, arc: "liven-tooled-one-look", brief: "liven-tooled-one-look-brief.md", title: "The tooled style keeps one look", waits: [1], note: "After you approve the spike", sketch: 1, steps: STEPS_SHIP },
  { n: 5, arc: "liven-default-style", brief: "liven-default-manner-brief.md", title: "The default style borrows its roles from one table", waits: [4], sketch: 1, steps: STEPS_SHIP },
  { n: 6, arc: "liven-neomod-style", brief: "liven-neomod-manner-brief.md", title: "Ship the neomod style on borrowed roles", waits: [2, 5], sketch: 1, steps: STEPS_SHIP },
  { n: 7, arc: "liven-prop-rig", brief: "liven-prop-rig-brief.md", title: "Rig props on the settled edges", waits: [3, 4], sketch: 1, steps: STEPS_SHIP },
  { n: 8, arc: "liven-rigged-cast", brief: "liven-rigged-cast-brief.md", title: "Rig the cast, one batch at a time", waits: [4, 5, 7], sketch: 2, steps: STEPS_SHIP },
];

const ONE: readonly Entry[] = [
  { n: 1, arc: "window-menu-sections", brief: "window-menu-sections-brief.md", title: "The Window menu groups its panes in sections", waits: [], sketch: 1, steps: STEPS_SHIP },
];

/** A cycle's sketches, in the order they were kept. */
const SKETCHES: Record<1 | 2, string> = {
  1: [
    "Each drawing style keeps one look, and a style borrows its colors from another in one stated way.",
    "",
    "Settle what each style borrows by trying it on a sheet first, then ship the styles in the order their borrowing depends on.",
    "",
    "- A spike sheet for each new ground",
    "- One role table every style reads",
    "- Borrowed roles load the same in every look",
    "- A prop is rigged on the settled edges",
  ].join("\n"),
  2: [
    "The whole cast moves on the rig, one batch of figures at a time.",
    "",
    "Once the rig and the styles have landed, rig the cast in batches, each batch its own pass.",
    "",
    "- One batch per pass",
    "- Every figure drawn on the settled edges",
    "- The old poses are kept until a batch is approved",
  ].join("\n"),
};

function wantOf(sketch: 1 | 2): string {
  return SKETCHES[sketch].split("\n")[0] ?? "";
}

type CycleKind = "none" | "one" | "eight";
type Moment = "start" | "midway" | "rest";

/** What the arc log says of one entry's arc. An entry it never names has no run. */
type Run = "joined" | "here" | "elsewhere";

function runsAt(kind: CycleKind, moment: Moment): ReadonlyMap<number, Run> {
  const runs = new Map<number, Run>();
  if (moment === "start" || kind === "none") return runs;
  if (kind === "one") {
    runs.set(1, moment === "rest" ? "joined" : "here");
    return runs;
  }
  if (moment === "rest") {
    for (const entry of EIGHT) runs.set(entry.n, "joined");
    return runs;
  }
  runs.set(1, "joined");
  runs.set(3, "elsewhere");
  runs.set(4, "here");
  return runs;
}

type EntryState = "joined" | "running" | "ready" | "waiting";

/** An entry's state, read from the runs. Nothing about it is stored. */
function stateOf(entry: Entry, runs: ReadonlyMap<number, Run>): EntryState {
  const run = runs.get(entry.n);
  if (run === "joined") return "joined";
  if (run !== undefined) return "running";
  return entry.waits.every((n) => runs.get(n) === "joined") ? "ready" : "waiting";
}

/** How many steps an entry's arc has finished, by where it runs. */
function doneOf(entry: Entry, runs: ReadonlyMap<number, Run>): number {
  return runs.get(entry.n) === "here" ? 2 : 1;
}

function stepsOf(entry: Entry, done: number): ArcStep[] {
  return entry.steps.map((title, i) => ({
    title,
    status: i < done ? "done" : i === done ? "in progress" : "pending",
  }));
}

function runningModel(entry: Entry, done: number): { model: ArcTrackModel; steps: ArcStep[] } {
  const steps = stepsOf(entry, done);
  const dir = `${ROOT}/.tug/arcs/${entry.arc}`;
  return {
    steps,
    model: arcTrackModel({
      documents: { brief: `${dir}/brief.md`, plan: `${dir}/plan.md` },
      arcKind: "planned",
      arc: { stage: "implement" },
      stage: "implementing",
      steps,
      holdersBusy: true,
    }),
  };
}

function command(entry: Entry): string {
  return `/arc ${entry.arc} @briefs/${entry.brief}`;
}

interface Reading {
  entries: readonly Entry[];
  runs: ReadonlyMap<number, Run>;
}

interface Presses {
  start: (entry: Entry, where: "here" | "new") => void;
  goTo: (session: string) => void;
}

function sentenceOf(entry: Entry, reading: Reading): string {
  const state = stateOf(entry, reading.runs);
  if (state === "joined") return "Joined";
  if (state === "running") {
    return reading.runs.get(entry.n) === "here" ? "Running in this session" : "Running in another session";
  }
  if (state === "ready") return entry.note ?? "Ready to start";
  const open = entry.waits.filter((n) => reading.runs.get(n) !== "joined");
  return `Waits on ${open.join(", ")}`;
}

// ---------------------------------------------------------------------------
// The map — the cycle as a graph
// ---------------------------------------------------------------------------

/**
 * A session, as the chip it is everywhere else, and pressable as it is
 * everywhere else: a press brings that session's card forward. There is no
 * separate "go to" control.
 */
function SessionChip({ session, presses }: { session: string; presses: Presses }): React.ReactElement {
  const identity = useSessionIdentity(session);
  return (
    <SessionIdentityView
      identity={identity}
      tier="chip"
      arc={false}
      tooltip={false}
      onOpen={() => presses.goTo(session)}
    />
  );
}

/** No selection. One set holds it: a press selects one, a shift-press joins or leaves. */
const NO_PICKS: ReadonlySet<string> = new Set();

function togglePick(picked: ReadonlySet<string>, key: string): ReadonlySet<string> {
  const next = new Set(picked);
  if (!next.delete(key)) next.add(key);
  return next;
}

/** Under a map whose assets are narrowed to the picked ones: the way back. */
function OnlyBar({ count, onBack }: { count: number; onBack: () => void }): React.ReactElement {
  return (
    <div className="sp-cycle-only" data-slot="sp-cycle-only">
      <TugPushButton size="2xs" subtype="text" emphasis="outlined" onClick={onBack}>
        Back
      </TugPushButton>
      <TugLabel size="2xs" emphasis="calm">
        {`Showing ${count} · Shift-click to add or remove, click the map's ground to clear`}
      </TugLabel>
    </div>
  );
}

/** The map's measures. The sidebar draws the same map at a smaller set. */
interface MapDims {
  colW: number;
  rowH: number;
  tileW: number;
  tileH: number;
  pad: number;
}

// The shipped map's measures, whose tiles are sized to hold the arc's track.
const MAP_FULL: MapDims = CYCLE_MAP_MEASURES.full;
const MAP_COMPACT: MapDims = CYCLE_MAP_MEASURES.compact;

const xOf = (d: MapDims, seat: CycleMapSeat): number => d.pad + seat.col * d.colW;
const yOf = (d: MapDims, seat: CycleMapSeat): number => d.pad + seat.row * d.rowH + d.tileH / 2;

/** A wire's path: a curve across each gap, and a straight run across a held seat. */
function wirePath(d: MapDims, seats: readonly CycleMapSeat[]): string {
  const first = seats[0]!;
  let x = xOf(d, first) + d.tileW;
  let y = yOf(d, first);
  let path = `M ${x} ${y}`;
  for (let i = 1; i < seats.length; i += 1) {
    const seat = seats[i]!;
    const last = i === seats.length - 1;
    const toX = xOf(d, seat) - (last ? 5 : 0);
    const toY = yOf(d, seat);
    const mid = (x + toX) / 2;
    path += ` C ${mid} ${y} ${mid} ${toY} ${toX} ${toY}`;
    x = toX;
    y = toY;
    if (!last) {
      x = xOf(d, seat) + d.tileW;
      path += ` L ${x} ${y}`;
    }
  }
  return path;
}

function wireHead(d: MapDims, seats: readonly CycleMapSeat[]): string {
  const end = seats[seats.length - 1]!;
  const x = xOf(d, end);
  const y = yOf(d, end);
  return `M ${x} ${y} L ${x - 6} ${y - 3.5} L ${x - 6} ${y + 3.5} Z`;
}

/** A sketch's number on the map: negated, so it never meets an entry's. */
const sealOf = (sketch: 1 | 2): number => -sketch;

/** An asset's key, shared by its tile or seal on the map and its place in the list. */
const entryKey = (n: number): string => `e${n}`;
const sketchKey = (sketch: 1 | 2): string => `s${sketch}`;

/**
 * A sketch's name on the map and in the list. Sketches are lettered and
 * entries numbered, so a digit always means work that can land and a letter
 * always means where it came from.
 */
const letterOf = (sketch: 1 | 2): string => String.fromCharCode(64 + sketch);

/** The entries a sketch heads: its own, less those that wait on another of its own. */
function headsOf(sketch: 1 | 2, entries: readonly Entry[]): Entry[] {
  return entries.filter(
    (e) => e.sketch === sketch && !e.waits.some((w) => entries.find((o) => o.n === w)?.sketch === sketch),
  );
}

/** What the map lays out: every entry, and every sketch as a seal its heads wait on. */
function mapEntries(entries: readonly Entry[]): CycleMapEntry[] {
  const sketches = [...new Set(entries.map((e) => e.sketch))];
  const heads = new Set(sketches.flatMap((s) => headsOf(s, entries).map((e) => e.n)));
  return [
    ...sketches.map((s) => ({ n: sealOf(s), waits: [], late: true })),
    ...entries.map((e) => ({ n: e.n, waits: heads.has(e.n) ? [...e.waits, sealOf(e.sketch)] : e.waits })),
  ];
}

function CycleMapView({
  reading,
  chosen,
  onPress,
  onClear,
  compact = false,
}: {
  reading: Reading;
  /** The selected assets' keys. With more than one, the rest of the map draws back. */
  chosen: ReadonlySet<string>;
  /** A press on a tile or a seal; `shift` is whether Shift was held. */
  onPress: (key: string, shift: boolean) => void;
  /** A press on the map's ground, which clears the selection. */
  onClear: () => void;
  /** Draw at the sidebar's measures: the same tiles and wires, smaller. */
  compact?: boolean;
}): React.ReactElement {
  const dims = compact ? MAP_COMPACT : MAP_FULL;
  const map = useMemo(() => cycleMap(mapEntries(reading.entries)), [reading.entries]);
  const [pointed, setPointed] = useState<number | null>(null);
  const chosenEntry = chosen.size === 1 ? (reading.entries.find((e) => chosen.has(entryKey(e.n)))?.n ?? null) : null;
  const hot = pointed ?? chosenEntry;
  const width = dims.pad * 2 + map.cols * dims.colW - (dims.colW - dims.tileW);
  const height = dims.pad * 2 + map.rows * dims.rowH - (dims.rowH - dims.tileH);
  return (
    <div
      className="sp-cycle-map-scroll"
      data-slot="sp-cycle-map"
      data-compact={compact || undefined}
      onClick={(e) => {
        // The ground only: a tile's own press has its own meaning.
        if (!(e.target as HTMLElement).closest("button")) onClear();
      }}
    >
      <div className="sp-cycle-map" data-filtering={chosen.size > 1 || undefined} style={{ width, height }}>
        <svg className="sp-cycle-wires" width={width} height={height} aria-hidden>
          {map.wires.map((wire) => (
            <g
              key={`${wire.from}-${wire.to}`}
              className="sp-cycle-wire"
              data-sketch={wire.from < 0 || undefined}
              data-met={reading.runs.get(wire.from) === "joined" || undefined}
              data-hot={hot === wire.to || undefined}
            >
              <path className="sp-cycle-wire-line" d={wirePath(dims, wire.seats)} />
              <path className="sp-cycle-wire-head" d={wireHead(dims, wire.seats)} />
            </g>
          ))}
        </svg>
        {map.nodes.map((node) => {
          if (node.n < 0) {
            const sketch = -node.n as 1 | 2;
            return (
              <TugTooltip key={node.n} content={wantOf(sketch)}>
                <button
                  type="button"
                  className="sp-cycle-sketch-seal"
                  data-chosen={chosen.has(sketchKey(sketch)) || undefined}
                  aria-label={`Sketch ${letterOf(sketch)}`}
                  style={{
                    left: xOf(dims, node) + dims.tileW - dims.tileH,
                    top: dims.pad + node.row * dims.rowH,
                    width: dims.tileH,
                    height: dims.tileH,
                  }}
                  onClick={(e) => onPress(sketchKey(sketch), e.shiftKey)}
                >
                  {letterOf(sketch)}
                </button>
              </TugTooltip>
            );
          }
          const entry = reading.entries.find((e) => e.n === node.n)!;
          const state = stateOf(entry, reading.runs);
          const done = doneOf(entry, reading.runs);
          return (
            <TugTooltip key={node.n} content={`${entry.title} · ${sentenceOf(entry, reading)}`}>
              <button
                type="button"
                className="sp-cycle-tile"
                data-state={state}
                data-chosen={chosen.has(entryKey(node.n)) || undefined}
                data-elsewhere={reading.runs.get(node.n) === "elsewhere" || undefined}
                aria-label={`${node.n}, ${entry.title}, ${sentenceOf(entry, reading)}`}
                style={{
                  left: xOf(dims, node),
                  top: dims.pad + node.row * dims.rowH,
                  width: dims.tileW,
                  height: dims.tileH,
                }}
                onClick={(e) => onPress(entryKey(node.n), e.shiftKey)}
                onPointerEnter={() => setPointed(node.n)}
                onPointerLeave={() => setPointed(null)}
              >
                <span className="sp-cycle-tile-number">{node.n}</span>
                <span className="sp-cycle-tile-mark">
                  {state === "joined" ? (
                    <Check size={14} aria-hidden />
                  ) : state === "ready" ? (
                    <Play size={12} aria-hidden />
                  ) : state === "running" ? (
                    <TugArcTrack model={runningModel(entry, done).model} />
                  ) : null}
                </span>
              </button>
            </TugTooltip>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The assets — the one list under the map
// ---------------------------------------------------------------------------

function EntryMark({ entry, reading }: { entry: Entry; reading: Reading }): React.ReactElement | null {
  const state = stateOf(entry, reading.runs);
  if (state === "joined") {
    return (
      <TugBadge size="xs" emphasis="ghost" role="success">
        Joined
      </TugBadge>
    );
  }
  if (state === "running") {
    const { model } = runningModel(entry, doneOf(entry, reading.runs));
    return <ArcLifecycleMark model={model} name={entry.arc} size="rail" showWord />;
  }
  if (state === "ready") {
    return (
      <TugBadge size="xs" emphasis="tinted" role="action">
        Ready
      </TugBadge>
    );
  }
  return null;
}

function EntryLead({
  entry,
  reading,
  presses,
}: {
  entry: Entry;
  reading: Reading;
  presses: Presses;
}): React.ReactElement | null {
  if (stateOf(entry, reading.runs) !== "ready") return null;
  return (
    <>
      <TugPushButton
        size="xs"
        subtype="icon-text"
        emphasis="outlined"
        icon={<Play size={12} />}
        aria-label={`Start ${entry.arc}`}
        onClick={(e) => {
          e?.stopPropagation();
          presses.start(entry, "here");
        }}
      >
        Start
      </TugPushButton>
      <TugTooltip content="Start in a new session">
        <TugPushButton
          size="xs"
          subtype="icon"
          emphasis="ghost"
          icon={<SquareArrowOutUpRight size={12} />}
          aria-label={`Start ${entry.arc} in a new session`}
          onClick={(e) => {
            e?.stopPropagation();
            presses.start(entry, "new");
          }}
        />
      </TugTooltip>
    </>
  );
}

/** What an entry waits on, as the numbers the map's tiles wear. */
function Waits({ entry, reading }: { entry: Entry; reading: Reading }): React.ReactElement | null {
  if (entry.waits.length === 0 || stateOf(entry, reading.runs) === "joined") return null;
  return (
    <span className="sp-cycle-waits">
      <span>Waits on</span>
      {entry.waits.map((n) => {
        const met = reading.runs.get(n) === "joined";
        return (
          <span key={n} className="sp-cycle-wait" data-met={met || undefined}>
            {n}
            {met ? <Check size={10} aria-hidden /> : null}
          </span>
        );
      })}
    </span>
  );
}

/** A sketch in the list: whole, with the entries it heads. */
function SketchAsset({
  sketch,
  reading,
  chosen,
  onChoose,
}: {
  sketch: 1 | 2;
  reading: Reading;
  chosen: ReadonlySet<string>;
  onChoose: (key: string) => void;
}): React.ReactElement {
  const key = sketchKey(sketch);
  return (
    <div className="sp-cycle-asset" data-asset={key} data-kind="sketch" data-chosen={chosen.has(key) || undefined}>
      <TugListRow
        selected={chosen.has(key)}
        leading={<span className="sp-cycle-seal-mini">{letterOf(sketch)}</span>}
        title={<span className="sp-cycle-sketch-label">{`Sketch ${letterOf(sketch)}`}</span>}
        trailing={
          <span className="sp-cycle-waits">
            <span>Heads</span>
            {headsOf(sketch, reading.entries).map((e) => (
              <span key={e.n} className="sp-cycle-wait" data-met>
                {e.n}
              </span>
            ))}
          </span>
        }
        trailingReveal="always"
        onClick={() => onChoose(key)}
      />
      <div className="sp-cycle-sketch-body">{recordBody(SKETCHES[sketch])}</div>
    </div>
  );
}

/** An entry in the list: everything about it, in one place. */
function EntryAsset({
  entry,
  reading,
  presses,
  chosen,
  onChoose,
}: {
  entry: Entry;
  reading: Reading;
  presses: Presses;
  chosen: ReadonlySet<string>;
  onChoose: (key: string) => void;
}): React.ReactElement {
  const key = entryKey(entry.n);
  const run = reading.runs.get(entry.n);
  const state = stateOf(entry, reading.runs);
  return (
    <div className="sp-cycle-asset" data-asset={key} data-kind="entry" data-chosen={chosen.has(key) || undefined}>
      <TugListRow
        selected={chosen.has(key)}
        leading={<span className="sp-cycle-number">{entry.n}</span>}
        title={<span className="sp-cycle-brief-title">{entry.title}</span>}
        description={
          <span className="sp-cycle-facts">
            {run !== undefined ? <TugArcAtom name={entry.arc} /> : null}
            {run === "elsewhere" ? (
              <SessionChip session={OTHER} presses={presses} />
            ) : run === "here" ? (
              <TugLabel size="2xs" emphasis="calm">
                this session
              </TugLabel>
            ) : null}
            <TugAtomRef entity={{ kind: "file", path: `${ROOT}/briefs/${entry.brief}` }} />
            <Waits entry={entry} reading={reading} />
            {entry.note !== undefined && state !== "joined" ? (
              <span className="sp-cycle-note">{entry.note}</span>
            ) : null}
          </span>
        }
        trailing={
          <span className="sp-cycle-trailing">
            <EntryMark entry={entry} reading={reading} />
            <EntryLead entry={entry} reading={reading} presses={presses} />
          </span>
        }
        trailingReveal="always"
        onClick={() => onChoose(key)}
      />
      {state === "running" ? (
        <div className="sp-cycle-steps">
          <TugPopupListFrame kind="item" layout="inline">
            <TugPopupListScroller>
              <ArcStepItems steps={stepsOf(entry, doneOf(entry, reading.runs))} live />
            </TugPopupListScroller>
          </TugPopupListFrame>
        </div>
      ) : state === "joined" ? (
        <p className="sp-cycle-asset-line">Landed on main. Its rounds and commit stay on record.</p>
      ) : null}
    </div>
  );
}

/** Every asset of the cycle, in order: each sketch, then the entries it brought. */
function Assets({
  reading,
  presses,
  chosen,
  onChoose,
}: {
  reading: Reading;
  presses: Presses;
  chosen: ReadonlySet<string>;
  onChoose: (key: string) => void;
}): React.ReactElement {
  // Several selected: only those show. One or none: the whole list.
  const shows = (key: string): boolean => chosen.size <= 1 || chosen.has(key);
  return (
    <>
      {reading.entries.map((entry, index) => (
        <React.Fragment key={entry.n}>
          {(index === 0 || reading.entries[index - 1]?.sketch !== entry.sketch) &&
          shows(sketchKey(entry.sketch)) ? (
            <SketchAsset
              sketch={entry.sketch}
              reading={reading}
              chosen={chosen}
              onChoose={onChoose}
            />
          ) : null}
          {shows(entryKey(entry.n)) ? (
            <EntryAsset entry={entry} reading={reading} presses={presses} chosen={chosen} onChoose={onChoose} />
          ) : null}
        </React.Fragment>
      ))}
    </>
  );
}

// ---------------------------------------------------------------------------
// The shade's header and footer
// ---------------------------------------------------------------------------

type Keeps = "nothing" | "footer";
type Cover = "none" | "covers" | "stands";

interface Summary {
  name: string;
  landed: number;
  total: number;
  current: Entry | null;
  elsewhere: number;
  next: Entry | null;
  readyCount: number;
}

function summarize(kind: CycleKind, reading: Reading): Summary {
  const { entries, runs } = reading;
  const ready = entries.filter((e) => stateOf(e, runs) === "ready");
  return {
    name: kind === "one" ? "window-menu-sections" : "liven-styles",
    landed: entries.filter((e) => runs.get(e.n) === "joined").length,
    total: entries.length,
    current: entries.find((e) => runs.get(e.n) === "here") ?? null,
    elsewhere: entries.filter((e) => runs.get(e.n) === "elsewhere").length,
    next: ready[0] ?? null,
    readyCount: ready.length,
  };
}

function landedText(summary: Summary): string {
  if (summary.total === 1) return summary.landed === 1 ? "Landed" : "One arc";
  return `${summary.landed} of ${summary.total} landed`;
}

function ShadeHeader({ summary, onCollapse }: { summary: Summary; onCollapse: () => void }): React.ReactElement {
  return (
    <div className="sp-cycle-header" data-slot="sp-cycle-header">
      <TugTooltip content="Lower the cycle">
        <TugPushButton
          size="xs"
          subtype="icon"
          emphasis="ghost"
          icon={<ChevronDown size={16} />}
          aria-label="Lower the cycle"
          onClick={onCollapse}
        />
      </TugTooltip>
      <span className="sp-cycle-eyebrow">Cycle</span>
      <span className="sp-cycle-name">{summary.name}</span>
      <span className="sp-cycle-spacer" />
      <span className="sp-cycle-landed">{landedText(summary)}</span>
    </div>
  );
}

/** Two lines: what this session is doing now, and what is ready next. */
function ShadeFooter({ summary, presses }: { summary: Summary; presses: Presses }): React.ReactElement {
  const { current, next } = summary;
  const atRest = summary.landed === summary.total;
  return (
    <div className="sp-cycle-footer" data-slot="sp-cycle-footer">
      <div className="sp-cycle-footer-line">
        <span className="sp-cycle-footer-word">Now</span>
        {current !== null ? (
          <span className="sp-cycle-footer-what">
            <span className="sp-cycle-brief-title">{current.title}</span>
            <ArcLifecycleMark model={runningModel(current, 2).model} name={current.arc} size="rail" showWord />
          </span>
        ) : (
          <span className="sp-cycle-footer-quiet">
            {atRest ? `At rest, ${landedText(summary).toLowerCase()}` : "No arc in this session"}
          </span>
        )}
        <span className="sp-cycle-spacer" />
        {summary.elsewhere > 0 ? (
          <span className="sp-cycle-footer-else">
            <span>{`${summary.elsewhere} more in`}</span>
            <SessionChip session={OTHER} presses={presses} />
          </span>
        ) : null}
      </div>
      <div className="sp-cycle-footer-line">
        <span className="sp-cycle-footer-word">Next</span>
        {next !== null ? (
          <span className="sp-cycle-footer-what">
            <span className="sp-cycle-brief-title">{next.title}</span>
            {next.note !== undefined ? (
              <span className="sp-cycle-note">{next.note}</span>
            ) : summary.readyCount > 1 ? (
              <span className="sp-cycle-footer-quiet">{`and ${summary.readyCount - 1} more ready`}</span>
            ) : null}
          </span>
        ) : (
          <span className="sp-cycle-footer-quiet">
            {atRest ? "Nothing waiting. An arc can be added at any time." : "Nothing is ready until an arc lands"}
          </span>
        )}
        <span className="sp-cycle-spacer" />
        {next !== null ? (
          <TugPushButton
            size="xs"
            subtype="icon-text"
            emphasis="outlined"
            icon={<Play size={12} />}
            aria-label={`Start ${next.arc}`}
            onClick={() => presses.start(next, "here")}
          >
            Start
          </TugPushButton>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The Session card stand-in
// ---------------------------------------------------------------------------

/** The status row as it ships, its fourth cell reading `CYCLE` where it read `ARC`. */
function StatusRow({
  summary,
  raised,
  onToggle,
}: {
  summary: Summary | null;
  raised: boolean;
  onToggle: () => void;
}): React.ReactElement {
  const value = (text: string) => <span className="session-telemetry-status-value">{text}</span>;
  const cycle =
    summary === null ? (
      value("None")
    ) : summary.total > 1 ? (
      value(`${summary.landed}/${summary.total}`)
    ) : summary.current !== null ? (
      <ArcLifecycleMark
        model={runningModel(summary.current, 2).model}
        name={summary.current.arc}
        size="rail"
        showWord
      />
    ) : (
      value(summary.landed === 1 ? "Landed" : "Ready")
    );
  return (
    <div className="sp-cycle-status">
      <div className="session-telemetry-status-row">
        <SessionTelemetryCell priority="state" label="State">
          {value("Idle")}
        </SessionTelemetryCell>
        <SessionTelemetryCell priority="time" label="Time">
          {value("12m 04s")}
        </SessionTelemetryCell>
        <SessionTelemetryCell priority="context" label="Context">
          {value("41%")}
        </SessionTelemetryCell>
        <SessionTelemetryCell
          priority="arc"
          label="Cycle"
          valueEmpty={summary === null}
          pressed={raised}
          onActivate={onToggle}
          aria-label={raised ? "Lower the cycle" : "Raise the cycle"}
        >
          {cycle}
        </SessionTelemetryCell>
        <SessionTelemetryCell priority="jobs" label="Jobs">
          {value("0")}
        </SessionTelemetryCell>
      </div>
    </div>
  );
}

/** An ordinary stretch of transcript for the shade to stand over. */
const TRANSCRIPT: ReadonlyArray<{ who: "user" | "assistant"; text: string }> = [
  { who: "user", text: "Where does the Tooled ground get its edge color from today?" },
  {
    who: "assistant",
    text: "From the style that lends it. Tooled has no edge role of its own, so it reads the lender's table when a sheet is drawn and takes whatever edge that style declares.",
  },
  {
    who: "assistant",
    text: "That is why the same figure draws with a darker edge on a light ground: the lender changes with the look, and the edge changes with it.",
  },
  { who: "user", text: "And if Tooled kept one look?" },
  {
    who: "assistant",
    text: "Then the edge would be a single value, and the styles that borrow from Tooled could name it directly. The prop readers would no longer need to ask which look is showing.",
  },
  {
    who: "assistant",
    text: "The docs describe the borrowing in two places, and both would shrink to one paragraph. I can show you the two passages side by side.",
  },
  { who: "user", text: "Yes, show me." },
  {
    who: "assistant",
    text: "The first is under Styles, where each style lists its roles. The second is under Looks, where the borrowing is described again from the other side.",
  },
];

function CardFrame({
  kind,
  reading,
  keeps,
  cover,
  raised,
  setRaised,
  chosen,
  onChoose,
  presses,
  prompt,
}: {
  kind: CycleKind;
  reading: Reading;
  keeps: Keeps;
  cover: Cover;
  raised: boolean;
  setRaised: (raised: boolean) => void;
  chosen: ReadonlySet<string>;
  onChoose: (next: ReadonlySet<string>) => void;
  presses: Presses;
  prompt: string;
}): React.ReactElement {
  const summary = kind !== "none" ? summarize(kind, reading) : null;
  const many = reading.entries.length > 1;
  const assetsRef = useRef<HTMLDivElement | null>(null);
  const [mapPress, setMapPress] = useState(0);
  const handledPress = useRef(0);
  // A plain press on the map selects that asset alone. A shift-press joins it
  // to what is selected, or takes it out. A press on the map's ground clears
  // the selection. With one selected the list is whole and scrolls it to the
  // top; with several the list shows only those. Only the list scrolls, so
  // the map and the point pressed hold still.
  const pressOnMap = (key: string, shift: boolean) => {
    onChoose(shift ? togglePick(chosen, key) : new Set([key]));
    setMapPress((n) => n + 1);
  };
  // After the commit, since the selection decides which assets are there.
  useLayoutEffect(() => {
    if (mapPress === handledPress.current) return;
    handledPress.current = mapPress;
    const list = assetsRef.current;
    if (!list) return;
    const [first] = chosen;
    const asset = chosen.size === 1 ? list.querySelector<HTMLElement>(`[data-asset="${first}"]`) : null;
    list.scrollTo({ top: asset ? asset.offsetTop : 0, behavior: "smooth" });
  }, [mapPress, chosen]);
  const footer =
    summary !== null && (raised || keeps === "footer") ? <ShadeFooter summary={summary} presses={presses} /> : null;
  return (
    <div className="sp-cycle-card" data-slot="sp-cycle-card">
      <div className="sp-cycle-stage" data-cover={cover}>
        <div className="sp-cycle-slot">
          <div className="sp-cycle-transcript">
            {TRANSCRIPT.map((turn) => (
              <p key={turn.text} className="sp-cycle-turn" data-who={turn.who}>
                {turn.text}
              </p>
            ))}
          </div>
          <div
            className="sp-cycle-body"
            data-slot="sp-cycle-body"
            data-raised={raised}
            data-many={many || undefined}
            inert={!raised}
          >
            {summary === null ? (
              <div className="sp-cycle-none">
                <span className="sp-cycle-name">No cycle</span>
                <p>
                  A cycle is a chain of arcs, each cut from its own brief. Ask for one in the prompt, or bind this
                  session to one that is already open.
                </p>
                <div className="sp-cycle-none-doors">
                  <TugPushButton size="sm" subtype="text" emphasis="outlined">
                    New Cycle
                  </TugPushButton>
                  <TugPushButton size="sm" subtype="text" emphasis="ghost">
                    Bind
                  </TugPushButton>
                  <span className="sp-cycle-spacer" />
                  <TugPushButton size="sm" subtype="text" emphasis="ghost" onClick={() => setRaised(false)}>
                    Done
                  </TugPushButton>
                </div>
              </div>
            ) : (
              <>
                <ShadeHeader summary={summary} onCollapse={() => setRaised(false)} />
                {/* A cycle of one is drawn as any other: the map and the list. */}
                <CycleMapView
                  reading={reading}
                  chosen={chosen}
                  onPress={pressOnMap}
                  onClear={() => onChoose(NO_PICKS)}
                />
                {chosen.size > 1 ? <OnlyBar count={chosen.size} onBack={() => onChoose(NO_PICKS)} /> : null}
                <div className="sp-cycle-assets" data-slot="sp-cycle-assets" ref={assetsRef}>
                  <Assets
                    reading={reading}
                    presses={presses}
                    chosen={chosen}
                    onChoose={(key) => {
                      // A press on a row in the narrowed list keeps the selection.
                      if (chosen.size <= 1) onChoose(new Set([key]));
                    }}
                  />
                  {chosen.size <= 1 ? <div className="sp-cycle-assets-tail" aria-hidden /> : null}
                </div>
              </>
            )}
          </div>
        </div>
        {footer}
        {cover !== "none" ? (
          <div className="sp-cycle-cover" data-slot="sp-cycle-cover" data-footed={footer !== null || undefined}>
            <Search size={14} aria-hidden />
            <TugLabel size="xs">Find shade, standing in for any other shade</TugLabel>
          </div>
        ) : null}
      </div>
      <StatusRow summary={summary} raised={raised} onToggle={() => setRaised(!raised)} />
      <div className="sp-cycle-prompt" data-slot="sp-cycle-prompt" data-filled={prompt !== "" || undefined}>
        <span className="sp-cycle-prompt-text">{prompt === "" ? "Message" : prompt}</span>
        <TugLabel size="2xs" emphasis="calm">
          {prompt === "" ? "the only place a turn is sent from" : "placed here, not sent"}
        </TugLabel>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The sidebar card, as Cycles & Arcs
//
// The same cycle the Session card's shade shows, at the sidebar's width: the
// same map at smaller measures, and under it one compact row per asset under
// the same letters and numbers. What the sidebar adds is the view across
// sessions: every running entry names the session running it, whichever one
// that is, and a folded cycle keeps a strip of its entries' states.
// ---------------------------------------------------------------------------

const SOLO: Entry = {
  n: 1,
  arc: "caret-blink-rate",
  brief: "caret-blink-rate-brief.md",
  title: "Set the caret's blink rate",
  waits: [],
  sketch: 1,
  steps: STEPS_SHIP,
};

/** An arc on a cycle of one, running in another session. */
const SOLO_READING: Reading = { entries: [SOLO], runs: new Map<number, Run>([[1, "elsewhere"]]) };

/** A cycle that has come to rest: three arcs, all landed. */
const RESTED: Reading = {
  entries: [
    { n: 1, arc: "contrast-audit", brief: "contrast-audit-brief.md", title: "Audit contrast across the themes", waits: [], sketch: 1, steps: STEPS_SPIKE },
    { n: 2, arc: "contrast-dark-ships", brief: "contrast-dark-ships-brief.md", title: "Bring the dark ships inside the contrast budget", waits: [1], sketch: 1, steps: STEPS_SHIP },
    { n: 3, arc: "contrast-light-boats", brief: "contrast-light-boats-brief.md", title: "Bring the light boats inside the contrast budget", waits: [1], sketch: 1, steps: STEPS_SHIP },
  ],
  runs: new Map<number, Run>([
    [1, "joined"],
    [2, "joined"],
    [3, "joined"],
  ]),
};

/** A folded cycle at a glance: one segment per entry, in the state's tone. */
function CycleStrip({ reading }: { reading: Reading }): React.ReactElement {
  return (
    <span className="sp-cycle-strip" aria-hidden>
      {reading.entries.map((entry) => (
        <span key={entry.n} data-state={stateOf(entry, reading.runs)} />
      ))}
    </span>
  );
}

/**
 * An entry in the sidebar: one row, and the only drawing of the entry there.
 * Closed, it is the brief's title and one line of where it stands. Open, the
 * same row holds its session, its arc, its brief, what it waits on and its
 * steps.
 */
function SidebarEntry({
  entry,
  reading,
  presses,
  open,
  onPress,
  numbered = true,
}: {
  entry: Entry;
  reading: Reading;
  presses: Presses;
  open: boolean;
  onPress: () => void;
  /** False for a cycle of one, whose single entry needs no number. */
  numbered?: boolean;
}): React.ReactElement {
  const run = reading.runs.get(entry.n);
  const state = stateOf(entry, reading.runs);
  const session = run === "elsewhere" ? OTHER : HERE;
  const worker =
    state === "running" ? (
      <span className="sp-cycle-side-line">
        <span>in</span>
        <SessionChip session={session} presses={presses} />
      </span>
    ) : null;
  const waits =
    state === "waiting" || (state === "ready" && entry.note !== undefined) ? (
      <span className="sp-cycle-side-line">
        <Waits entry={entry} reading={reading} />
        {entry.note !== undefined ? <span className="sp-cycle-note">{entry.note}</span> : null}
      </span>
    ) : null;
  return (
    <div className="sp-cycle-side-asset" data-asset={entryKey(entry.n)} data-open={open || undefined}>
      <TugListRow
        density="compact"
        selected={open}
        leading={numbered ? <span className="sp-cycle-side-lead sp-cycle-side-number">{entry.n}</span> : undefined}
        trailing={
          <span className="sp-cycle-trailing">
            <EntryMark entry={entry} reading={reading} />
            {state === "ready" ? (
              <TugTooltip content="Start in a new session">
                <TugPushButton
                  size="2xs"
                  subtype="icon"
                  emphasis="ghost"
                  icon={<Play size={12} />}
                  aria-label={`Start ${entry.arc} in a new session`}
                  onClick={(e) => {
                    e?.stopPropagation();
                    presses.start(entry, "new");
                  }}
                />
              </TugTooltip>
            ) : null}
          </span>
        }
        trailingReveal="always"
        onClick={onPress}
      >
        <span className="sp-cycle-side-content">
          <span className="sp-cycle-brief-title">{entry.title}</span>
          {open ? null : worker}
          {waits}
          {open ? (
            <>
              {state === "running" ? (
                <span className="sp-cycle-side-steps">
                  <TugPopupListFrame kind="item" layout="inline">
                    <TugPopupListScroller>
                      <ArcStepItems steps={stepsOf(entry, doneOf(entry, reading.runs))} live />
                    </TugPopupListScroller>
                  </TugPopupListFrame>
                </span>
              ) : state === "joined" ? (
                <span className="sp-cycle-side-line">Landed on main. Its rounds and commit stay on record.</span>
              ) : state === "ready" ? (
                <span className="sp-cycle-side-line">Ready to start. Its steps appear once it runs.</span>
              ) : (
                <span className="sp-cycle-side-line">Not ready. Its steps appear once it runs.</span>
              )}
              {worker}
              {run !== undefined ? (
                <span className="sp-cycle-side-line">
                  <TugArcAtom name={entry.arc} />
                </span>
              ) : null}
              <span className="sp-cycle-side-line">
                <TugAtomRef entity={{ kind: "file", path: `${ROOT}/briefs/${entry.brief}` }} />
              </span>
            </>
          ) : null}
        </span>
      </TugListRow>
    </div>
  );
}

/** A sketch in the sidebar: one row, its first line closed and the whole of it open. */
function SidebarSketch({
  sketch,
  reading,
  open,
  onPress,
}: {
  sketch: 1 | 2;
  reading: Reading;
  open: boolean;
  onPress: () => void;
}): React.ReactElement {
  return (
    <div
      className="sp-cycle-side-asset"
      data-asset={sketchKey(sketch)}
      data-kind="sketch"
      data-open={open || undefined}
    >
      <TugListRow
        density="compact"
        selected={open}
        leading={
          <span className="sp-cycle-side-lead">
            <span className="sp-cycle-seal-mini">{letterOf(sketch)}</span>
          </span>
        }
        trailing={
          <span className="sp-cycle-waits">
            <span>Heads</span>
            {headsOf(sketch, reading.entries).map((e) => (
              <span key={e.n} className="sp-cycle-wait" data-met>
                {e.n}
              </span>
            ))}
          </span>
        }
        trailingReveal="always"
        onClick={onPress}
      >
        <span className="sp-cycle-side-content">
          <span className="sp-cycle-sketch-label">{`Sketch ${letterOf(sketch)}`}</span>
          {open ? (
            <span className="sp-cycle-side-sketch">{recordBody(SKETCHES[sketch])}</span>
          ) : (
            <span className="sp-cycle-side-want">{wantOf(sketch)}</span>
          )}
        </span>
      </TugListRow>
    </div>
  );
}

/**
 * One cycle in the sidebar. Its header and map are pinned to the top of the
 * card for as long as its assets are in view; the assets scroll under them.
 */
function SidebarCycle({
  name,
  reading,
  presses,
  startFolded = false,
}: {
  name: string;
  reading: Reading;
  presses: Presses;
  startFolded?: boolean;
}): React.ReactElement {
  const [folded, setFolded] = useState(startFolded);
  const [chosen, setChosen] = useState<ReadonlySet<string>>(NO_PICKS);
  const [mapPress, setMapPress] = useState(0);
  const handledPress = useRef(0);
  const sectionRef = useRef<HTMLElement | null>(null);
  const landed = reading.entries.filter((e) => reading.runs.get(e.n) === "joined").length;
  // Several selected: only those assets show. Every selected asset is open.
  const shows = (key: string): boolean => chosen.size <= 1 || chosen.has(key);
  const opens = (key: string): boolean => chosen.has(key);
  // A press on a row selects it alone, and in the narrowed list changes nothing.
  const pressRow = (key: string): void => {
    if (chosen.size <= 1) setChosen(new Set([key]));
  };

  // A press on the map opens the asset, then brings it up under the pinned
  // map. It waits for the commit, since opening one asset closes another and
  // that moves every asset below it. Only a map press scrolls: a press on a
  // row must leave the row under the pointer.
  useLayoutEffect(() => {
    if (mapPress === handledPress.current || chosen.size !== 1) return;
    handledPress.current = mapPress;
    const section = sectionRef.current;
    const scroller = section?.closest<HTMLElement>(".sp-cycle-sidebar-scroll");
    const pin = section?.querySelector<HTMLElement>(".sp-cycle-side-pin");
    const [first] = chosen;
    const asset = section?.querySelector<HTMLElement>(`[data-asset="${first}"]`);
    if (scroller && pin && asset) {
      scroller.scrollTo({ top: asset.offsetTop - pin.offsetHeight, behavior: "smooth" });
    }
  }, [mapPress, chosen]);

  return (
    <section className="sp-cycle-side-cycle" ref={sectionRef}>
      <div className="sp-cycle-side-pin">
        <div className="sp-cycle-sidebar-head">
          <BlockFoldCue
            collapsed={folded}
            onToggle={setFolded}
            collapsedLabel="Open"
            expandedLabel="Fold"
            ariaLabelExpand={`Open ${name}`}
            ariaLabelCollapse={`Fold ${name}`}
            size="xs"
            subtype="icon"
          />
          <span className="sp-cycle-sidebar-name">{name}</span>
          <span className="sp-cycle-spacer" />
          <TugLabel size="2xs" emphasis="calm">
            {landed === reading.entries.length ? `At rest · ${landed} arcs` : `${landed} of ${reading.entries.length} landed`}
          </TugLabel>
        </div>
        {folded ? (
          <CycleStrip reading={reading} />
        ) : (
          <CycleMapView
            reading={reading}
            chosen={chosen}
            onPress={(key, shift) => {
              setChosen((was) => (shift ? togglePick(was, key) : new Set([key])));
              setMapPress((n) => n + 1);
            }}
            onClear={() => setChosen(NO_PICKS)}
            compact
          />
        )}
        {!folded && chosen.size > 1 ? <OnlyBar count={chosen.size} onBack={() => setChosen(NO_PICKS)} /> : null}
      </div>
      {folded
        ? null
        : reading.entries.map((entry, index) => (
            <React.Fragment key={entry.n}>
              {(index === 0 || reading.entries[index - 1]?.sketch !== entry.sketch) &&
              shows(sketchKey(entry.sketch)) ? (
                <SidebarSketch
                  sketch={entry.sketch}
                  reading={reading}
                  open={opens(sketchKey(entry.sketch))}
                  onPress={() => pressRow(sketchKey(entry.sketch))}
                />
              ) : null}
              {shows(entryKey(entry.n)) ? (
                <SidebarEntry
                  entry={entry}
                  reading={reading}
                  presses={presses}
                  open={opens(entryKey(entry.n))}
                  onPress={() => pressRow(entryKey(entry.n))}
                />
              ) : null}
            </React.Fragment>
          ))}
    </section>
  );
}

function SidebarFrame({ reading, presses }: { reading: Reading; presses: Presses }): React.ReactElement {
  const [soloOpen, setSoloOpen] = useState(false);
  return (
    <div className="sp-cycle-sidebar" data-slot="sp-cycle-sidebar">
      <div className="sp-cycle-sidebar-scroll">
        <SidebarCycle name="liven-styles" reading={reading} presses={presses} />
        <section className="sp-cycle-side-cycle">
          <SidebarEntry
            entry={SOLO}
            reading={SOLO_READING}
            presses={presses}
            open={soloOpen}
            onPress={() => setSoloOpen(true)}
            numbered={false}
          />
        </section>
        <SidebarCycle name="theme-contrast-pass" reading={RESTED} presses={presses} startFolded />
        <div className="sp-cycle-sidebar-tail" />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The spike
// ---------------------------------------------------------------------------

const KINDS: TugChoiceItem[] = [
  { value: "none", label: "No cycle" },
  { value: "one", label: "One arc" },
  { value: "eight", label: "Eight arcs" },
];

const MOMENTS: TugChoiceItem[] = [
  { value: "start", label: "Nothing started" },
  { value: "midway", label: "Midway" },
  { value: "rest", label: "All landed" },
];

const SHADES: TugChoiceItem[] = [
  { value: "raised", label: "Raised" },
  { value: "lowered", label: "Lowered" },
];

const KEEPS: TugChoiceItem[] = [
  { value: "footer", label: "Lowered keeps the footer" },
  { value: "nothing", label: "Lowered keeps nothing" },
];

const COVERS: TugChoiceItem[] = [
  { value: "none", label: "No other shade" },
  { value: "covers", label: "Shade covers the footer" },
  { value: "stands", label: "Shade stands on the footer" },
];

const WIDTHS: TugChoiceItem[] = [
  { value: "slim", label: "Slim" },
  { value: "wide", label: "Wide" },
];

const KEEPS_BLURB: Record<Keeps, string> = {
  footer:
    "Lowered, the shade leaves its two-line footer in the card's layout: what this session is doing and the next Start stay one glance away, for two lines of the card.",
  nothing:
    "Lowered, the shade leaves nothing. The CYCLE cell in the status row is the whole of the cycle: its fraction, and the way back.",
};

function SpikeCycleBand(): React.ReactElement {
  const [kind, setKind] = useState<CycleKind>("eight");
  const [moment, setMoment] = useState<Moment>("midway");
  const [raised, setRaised] = useState(true);
  const [keeps, setKeeps] = useState<Keeps>("footer");
  const [cover, setCover] = useState<Cover>("none");
  const [width, setWidth] = useState<"slim" | "wide">("wide");
  const [chosen, setChosen] = useState<ReadonlySet<string>>(NO_PICKS);
  const [prompt, setPrompt] = useState("");
  const [last, setLast] = useState("nothing yet");
  const kindId = useId();
  const momentId = useId();
  const shadeId = useId();
  const keepsId = useId();
  const coverId = useId();
  const widthId = useId();
  const { ResponderScope, responderRef } = useResponderForm({
    selectValue: {
      [kindId]: (v) => setKind(v as CycleKind),
      [momentId]: (v) => setMoment(v as Moment),
      [shadeId]: (v) => setRaised(v === "raised"),
      [keepsId]: (v) => setKeeps(v as Keeps),
      [coverId]: (v) => setCover(v as Cover),
      [widthId]: (v) => setWidth(v as "slim" | "wide"),
    },
  });
  const reading = useMemo<Reading>(
    () => ({
      entries: kind === "eight" ? EIGHT : kind === "one" ? ONE : [],
      runs: runsAt(kind, moment),
    }),
    [kind, moment],
  );
  const sidebarReading = useMemo<Reading>(
    () => ({ entries: EIGHT, runs: runsAt("eight", moment) }),
    [moment],
  );
  const presses = useMemo<Presses>(
    () => ({
      start: (entry, where) => {
        if (where === "here") {
          setPrompt(command(entry));
          setLast(`Start ${entry.arc}: the command is in this card's prompt, unsent`);
        } else {
          setLast(`Start ${entry.arc}: a new session opens with "${command(entry)}" in its prompt, unsent`);
        }
      },
      goTo: (session) =>
        setLast(
          `Session chip pressed: the card of liven/${session === OTHER ? "glossy-bowl" : "rotund-plaid"} comes forward`,
        ),
    }),
    [],
  );

  return (
    <ResponderScope>
      <div className="sp-content sp-cycle" ref={responderRef as (el: HTMLDivElement | null) => void}>
        <section className="sp-section">
          <h2 className="sp-section-title">A cycle, read from the bottom of the Session card</h2>
          <div className="sp-cycle-controls">
            <TugChoiceGroup items={KINDS} value={kind} senderId={kindId} size="sm" />
            <TugChoiceGroup items={MOMENTS} value={moment} senderId={momentId} size="sm" />
            <TugChoiceGroup items={SHADES} value={raised ? "raised" : "lowered"} senderId={shadeId} size="sm" />
            <TugChoiceGroup items={KEEPS} value={keeps} senderId={keepsId} size="sm" />
            <TugChoiceGroup items={COVERS} value={cover} senderId={coverId} size="sm" />
            <TugChoiceGroup items={WIDTHS} value={width} senderId={widthId} size="sm" />
          </div>
          <p className="sp-cycle-caption">{KEEPS_BLURB[keeps]}</p>
          <p className="sp-cycle-caption">
            Last press: <span className="sp-cycle-readout">{last}</span>
            {prompt !== "" ? (
              <>
                {" "}
                <TugPushButton size="2xs" subtype="text" emphasis="ghost" onClick={() => setPrompt("")}>
                  Clear the prompt
                </TugPushButton>
              </>
            ) : null}
          </p>
        </section>

        <section className="sp-section">
          <h2 className="sp-section-title">Session card</h2>
          <div className="sp-cycle-width" data-width={width}>
            <CardFrame
              kind={kind}
              reading={reading}
              keeps={keeps}
              cover={cover}
              raised={raised}
              setRaised={setRaised}
              chosen={chosen}
              onChoose={setChosen}
              presses={presses}
              prompt={prompt}
            />
          </div>
          <p className="sp-cycle-caption">
            On the map, a column is what a join in the column before it frees. A solid wire leaves an arc that has
            landed; a dashed one is still waited on. Point at a tile to light what it waits on; press it, or a
            sketch's seal, and the list beneath the map scrolls it to the top while the map holds still.
          </p>
        </section>

        <section className="sp-section">
          <h2 className="sp-section-title">Cycles &amp; Arcs · sidebar width</h2>
          <SidebarFrame reading={sidebarReading} presses={presses} />
        </section>
      </div>
    </ResponderScope>
  );
}

export const spike: SpikeDef = {
  name: "cycle-band",
  title: "Cycle Band",
  blurb:
    "Can one shade at the bottom of the Session card show a cycle of arcs, what waits on what, and start the next one by filling the prompt?",
  icon: "RefreshCw",
  size: {
    min: { width: 480, height: 420 },
    preferred: { width: 860, height: 1080 },
  },
  component: () => <SpikeCycleBand />,
};
