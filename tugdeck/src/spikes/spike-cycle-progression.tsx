/**
 * spike-cycle-progression.tsx — what does the cycle shade need so that it
 * still says where the user is when a cycle is a long run of arcs that a
 * session listed in its answers?
 *
 * This is the shipped cycle shade, evolved, and nothing else. Its header, its
 * map, its asset rows and its Now and Next footer are the shade's own: the
 * same `CycleMap`, the same model, the same stylesheet. The Cycle Band spike
 * settled those, and this spike starts where it stopped.
 *
 * The fixture is the real record: the cycle "Hundred more cast members" in
 * liven, and `liven/rotund-plaid`, the session that wrote its briefs and
 * listed its arcs six times as `/arc <name> @<brief>` lines. Two switches set
 * what is being compared:
 *
 *   - **The record.** As it is kept today, an entry exists only once an arc
 *     has opened on it, so the cycle holds five entries and is closed, and so
 *     on no surface, between arcs. With the session's list read into it, the
 *     cycle holds every listed arc in order, each waiting on the one before,
 *     and the two review rounds that were on no list.
 *   - **The shade.** As shipped, mounted unchanged on that record. Evolved,
 *     with the changes below.
 *
 * What the evolved shade changes, each a small step from the shipped one:
 *
 *   - **The map wraps.** A run of entries that each wait on the one before is
 *     one long line. The same tiles and wires are drawn six to a row.
 *   - **An entry is headed by its own part of the brief.** Twelve entries
 *     share one brief, so the brief's title heads all twelve alike. The entry
 *     is headed by what the list called it, with the brief's title beside it.
 *   - **A landed entry is the way back.** Closed, it adds its join commit to
 *     its arc. Open, it shows how long it ran, the session that ran it and
 *     its steps, in place of one sentence saying they are on record.
 *   - **Landed entries fold.** Above the work in hand they are one row, and a
 *     press on the row or on a landed tile opens them.
 *   - **A ready entry has Start**, as the Cycle Band spike drew it.
 *   - **The footer gains a List line** under Now and Next: the session that
 *     keeps the list, when it last stated it, and whether work has landed
 *     since. That is the review between arcs the user asked for by hand.
 *   - **The header says the pace**: how long an arc has taken and how many
 *     are ahead.
 *
 * The card drawn is the steward's own, so the running arc is in another
 * session. Nothing here sends a frame: Start and Ask fill a prompt and stop.
 */

import "./spike.css";
import "./spike-cycle-progression.css";
import "@/components/tugways/cards/session-cycle-shade.css";

import React, { useCallback, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Play, SquareArrowOutUpRight } from "lucide-react";

import type { SpikeDef } from "./spike-registry";
import { ArcLifecycleMark } from "@/components/tugways/arc-lifecycle-mark";
import { ArcStepItems } from "@/components/tugways/arc-step-list";
import { recordBody } from "@/components/tugways/cards/session-arc-record";
import { SessionCycleShade } from "@/components/tugways/cards/session-cycle-shade";
import {
  cycleAssetKeys,
  cycleListView,
  cycleMapSketches,
  cycleMapTiles,
  cycleRevealTop,
  cycleShadeEntries,
  cycleShadeSummary,
  pressCycleAsset,
  pressCycleRow,
  type CycleShadeEntry,
} from "@/components/tugways/cards/session-cycle-shade-model";
import { SessionIdentityView } from "@/components/tugways/cards/session-identity";
import { CycleMap, type CycleMapTile } from "@/components/tugways/cycle-map";
import { headsOf, NO_PICKS, sketchKey } from "@/components/tugways/cycle-map-layout";
import { TugArcAtom } from "@/components/tugways/tug-arc-atom";
import { arcTrackModel, type ArcTrackModel } from "@/components/tugways/tug-arc-track";
import { TugAtomRef } from "@/components/tugways/tug-atom-ref";
import { TugBadge } from "@/components/tugways/tug-badge";
import { TugChoiceGroup, type TugChoiceItem } from "@/components/tugways/tug-choice-group";
import { TugCommitAtom } from "@/components/tugways/tug-commit-atom";
import { TugLabel } from "@/components/tugways/tug-label";
import { TugListRow } from "@/components/tugways/tug-list-row";
import { TugPopupListFrame, TugPopupListScroller } from "@/components/tugways/tug-popup-list";
import { TugPushButton } from "@/components/tugways/tug-push-button";
import { TugTooltip } from "@/components/tugways/tug-tooltip";
import { useResponderForm } from "@/components/tugways/use-responder-form";
import type { ArcStep, CycleEntryWire, CycleSketchWire, CycleWire } from "@/lib/changeset-types";
import { sessionNameStore } from "@/lib/session-name-store";
import { useSessionIdentity } from "@/lib/session-identity";
import { sessionTagStore } from "@/lib/session-tag-store";

// ---------------------------------------------------------------------------
// Fixtures — the real progression of liven/rotund-plaid
// ---------------------------------------------------------------------------

const ROOT = "/Users/kocienda/Mounts/u/src/liven";
const STEWARD = "81acbce8-0000-4000-8000-00000c1c9e01";
const RUNNER = "59d6daa4-0000-4000-8000-00000c1c9e02";
const REVIEW_A = "d9beb898-0000-4000-8000-00000c1c9e03";
const REVIEW_B = "66fd066b-0000-4000-8000-00000c1c9e04";

const TAGS: Record<string, string> = {
  [STEWARD]: "rotund-plaid",
  [RUNNER]: "brisk-fern",
  [REVIEW_A]: "cozy-lawn",
  [REVIEW_B]: "large-mochi",
};

sessionNameStore.setName(STEWARD, "cast build-out");
sessionNameStore.setName(RUNNER, "cast batches");
sessionNameStore.setName(REVIEW_A, "rig fixes");
sessionNameStore.setName(REVIEW_B, "people and animals round");
for (const [id, tag] of Object.entries(TAGS)) sessionTagStore.setTag(id, tag);

type BriefKey = "animals" | "cast" | "flora" | "round";

const BRIEFS: Record<BriefKey, { file: string; title: string }> = {
  animals: { file: "liven-cast-animals-brief.md", title: "Twelve rigged animals" },
  cast: { file: "liven-rigged-cast-brief.md", title: "The cast: 100 more members, rigged, in all three styles" },
  flora: { file: "liven-cast-flora-brief.md", title: "Sixteen plants, led by Tooled's sunflower" },
  round: { file: "liven-people-animals-round-brief.md", title: "People and animals as one cast" },
};

/** One arc of the progression: its part of a brief, and what its run left on record. */
interface Item {
  /** What the list called it: the part of the brief this arc carries. */
  label: string;
  arc: string;
  brief: BriefKey;
  from: string;
  /** False for work that landed in the middle of the list and was never on it. */
  listed: boolean;
  sha: string;
  /** Wall time from open to join, in minutes. */
  mins: number;
  rounds: number;
  session: string;
}

function listed(key: string, label: string, brief: BriefKey, sha = "", mins = 0, rounds = 0): Item {
  return { label, arc: `liven-cast-${key}`, brief, from: "A", listed: true, sha, mins, rounds, session: RUNNER };
}

/** In the order it runs or ran. The two unlisted rounds sit where they landed. */
const ITEMS: readonly Item[] = [
  listed("birds", "Birds", "animals", "864b7e9", 71, 3),
  listed("beasts", "Beasts", "animals", "b2d0414", 84, 4),
  listed("conversation", "Conversation", "cast", "1f8ffa5", 62, 3),
  listed("devices", "Devices", "cast", "a70135c", 55, 3),
  listed("interface", "Interface", "cast", "5c82781", 61, 3),
  {
    label: "Rig fixes",
    arc: "liven-cast-rig-fixes",
    brief: "cast",
    from: "A",
    listed: false,
    sha: "71d48c7",
    mins: 38,
    rounds: 2,
    session: REVIEW_A,
  },
  {
    label: "People and animals round",
    arc: "liven-people-animals-round",
    brief: "round",
    from: "B",
    listed: false,
    sha: "524c261",
    mins: 92,
    rounds: 5,
    session: REVIEW_B,
  },
  listed("files", "Files", "cast", "e41b0a7", 58, 3),
  listed("hardware", "Hardware", "cast", "0d93c52", 64, 3),
  listed("making", "Making", "cast", "7b2f6e1", 60, 3),
  listed("ideas", "Ideas", "cast", "c58a013", 57, 3),
  listed("signs", "Signs", "cast", "19e7d4a", 52, 2),
  listed("numbers", "Numbers", "cast", "a3306bf", 66, 3),
  listed("media", "Media", "cast", "f02c9d8", 59, 3),
  listed("places", "Places", "cast"),
  listed("people", "People", "cast"),
  listed("trees", "Trees", "flora"),
  listed("flowers", "Flowers", "flora"),
];

const SKETCHES: readonly CycleSketchWire[] = [
  {
    letter: "A",
    id: "2d031925",
    added: "2026-11-27T02:05:11Z",
    want: "Add a hundred more members to the built-in cast, rigged from the start, in all three styles, a batch at a time.",
    text: "Add a hundred more members to the built-in cast, rigged from the start, in all three styles, a batch at a time.\n\nEach batch is one arc on the cast brief. A batch names every member's feature before it is drawn, and is read three across before the small sizes.",
  },
  {
    letter: "B",
    id: "c1624f0b",
    added: "2026-11-27T16:00:35Z",
    want: "Redraw the built-in people and animals as one cast across the three manners.",
    text: "Redraw the built-in people and animals as one cast across the three manners.\n\nOne identity table and one color map hold across Default, Tooled and Neomod.",
  },
];

const STEPS = [
  "Write down each member's naming feature",
  "Draw the batch in Default",
  "Draw the batch in Tooled",
  "Draw the batch in Neomod",
  "Read the batch three across and at small sizes",
];

type MomentKey = "between" | "cleared" | "running" | "late";

/** One moment of the day: how far the work has landed, and what the list has seen of it. */
interface Moment {
  /** How many items, from the top, have landed. */
  landed: number;
  /** Steps the running arc has finished, or null when nothing is running. */
  stepsDone: number | null;
  /** How many landed items the newest statement of the list had seen. */
  seen: number;
  stated: string;
  /** The commit that revised the briefs ahead at the newest statement, when one did. */
  revised: string | null;
}

const MOMENTS: Record<MomentKey, Moment> = {
  between: { landed: 7, stepsDone: null, seen: 2, stated: "yesterday, 5:52 PM", revised: null },
  cleared: { landed: 7, stepsDone: null, seen: 7, stated: "today, 9:59 AM", revised: "f8d2862" },
  running: { landed: 7, stepsDone: 2, seen: 7, stated: "today, 9:59 AM", revised: "f8d2862" },
  late: { landed: 14, stepsDone: 3, seen: 7, stated: "today, 9:59 AM", revised: "f8d2862" },
};

type RecordKind = "today" | "captured";

function wireOf(item: Item, n: number, state: CycleEntryWire["state"], waits: number[]): CycleEntryWire {
  const brief = BRIEFS[item.brief];
  const opened = state === "joined" || state === "running";
  return {
    n,
    brief: `briefs/${brief.file}`,
    brief_path: `${ROOT}/briefs/${brief.file}`,
    brief_title: brief.title,
    ...(opened ? { arc: { name: item.arc, created: "2026-11-27T02:05:04Z" } } : {}),
    waits,
    from: [item.from],
    added: "2026-11-27T02:05:11Z",
    state,
    ...(state === "running" ? { bound_session: item.session, bound_callsign: TAGS[item.session] } : {}),
  };
}

/**
 * The cycle on record at a moment, and the item behind each entry number.
 * Null is a closed cycle, which no surface shows.
 */
function recordAt(kind: RecordKind, moment: Moment): { cycle: CycleWire; items: ReadonlyMap<number, Item> } | null {
  const entries: CycleEntryWire[] = [];
  const items = new Map<number, Item>();
  const running = moment.stepsDone === null ? -1 : moment.landed;
  if (kind === "today") {
    // An entry exists once an arc has opened on it. The record began with the
    // third batch, and one review round was never put on it.
    ITEMS.forEach((item, index) => {
      if (index < 2 || item.arc === "liven-cast-rig-fixes" || index > Math.max(running, moment.landed - 1)) return;
      const n = entries.length + 1;
      entries.push(wireOf(item, n, index === running ? "running" : "joined", []));
      items.set(n, item);
    });
    if (running === -1) return null;
  } else {
    // The list read in: each listed arc waits on the listed arc before it.
    let before: number | null = null;
    ITEMS.forEach((item, index) => {
      const n = index + 1;
      const waits: number[] = item.listed && before !== null ? [before] : [];
      const met = waits.every((w) => w <= moment.landed);
      const state = index < moment.landed ? "joined" : index === running ? "running" : met ? "ready" : "waiting";
      entries.push(wireOf(item, n, state, waits));
      items.set(n, item);
      if (item.listed) before = n;
    });
  }
  return {
    items,
    cycle: {
      id: "bb8f39b5",
      name: "Hundred more cast members",
      created: "2026-11-27T02:05:07Z",
      updated: "2026-11-27T18:04:36Z",
      project_dir: ROOT,
      entries,
      sketches: [...SKETCHES],
      landed: entries.filter((e) => e.state === "joined").length,
    },
  };
}

function stepsOf(done: number): ArcStep[] {
  return STEPS.map((title, i) => ({
    title,
    status: i < done ? "done" : i === done ? "in progress" : "pending",
  }));
}

function trackOf(item: Item, done: number): ArcTrackModel {
  const dir = `${ROOT}/.tug/arcs/${item.arc}`;
  return arcTrackModel({
    documents: { brief: `${dir}/brief.md`, plan: `${dir}/plan.md` },
    arcKind: "planned",
    arc: { stage: "implement" },
    stage: "implementing",
    steps: stepsOf(done),
    holdersBusy: true,
  });
}

function commandOf(item: Item): string {
  return `/arc ${item.arc} @briefs/${BRIEFS[item.brief].file}`;
}

function span(mins: number): string {
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

interface Presses {
  start: (item: Item, where: "here" | "new") => void;
  ask: () => void;
  goTo: (session: string) => void;
}

const NO_ROWS = new Map<string, never>();
const noLine = (): null => null;

// ---------------------------------------------------------------------------
// The evolved shade's parts
// ---------------------------------------------------------------------------

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

/** How many tiles the wrapped map draws to a row. */
const MAP_ROW = 6;

/**
 * The shipped map, wrapped: the same tiles and wires, six entries to a row. A
 * row after the first keeps only the waits and the sketches that are in it,
 * so its first tile starts the row instead of reaching back for its wire.
 */
function WrappedMap({
  tiles,
  cycle,
  chosen,
  onPress,
  onClear,
}: {
  tiles: readonly CycleMapTile[];
  cycle: CycleWire;
  chosen: ReadonlySet<string>;
  onPress: (key: string, shift: boolean) => void;
  onClear: () => void;
}): React.ReactElement {
  const seals = useMemo(() => cycleMapSketches(cycle), [cycle]);
  const rows = useMemo(() => {
    const out: CycleMapTile[][] = [];
    for (let i = 0; i < tiles.length; i += MAP_ROW) {
      const slice = tiles.slice(i, i + MAP_ROW);
      const here = new Set(slice.map((t) => t.n));
      out.push(
        i === 0
          ? slice
          : slice.map((t) => ({
              ...t,
              waits: t.waits.filter((w) => here.has(w)),
              from: t.waits.length === 0 ? t.from : [],
            })),
      );
    }
    return out;
  }, [tiles]);
  return (
    <div className="session-cycle-shade-map sp-prog-map">
      {rows.map((row, i) => {
        const letters = new Set(row.flatMap((t) => t.from));
        return (
          <CycleMap
            key={i}
            tiles={row}
            sketches={seals.filter((s) => letters.has(s.letter))}
            size="full"
            chosen={chosen}
            onPress={onPress}
            onClear={onClear}
          />
        );
      })}
    </div>
  );
}

/** How an entry stands, at its row's trailing edge, with Start on a ready one. */
function EntryMark({
  read,
  item,
  done,
  presses,
}: {
  read: CycleShadeEntry;
  item: Item;
  done: number;
  presses: Presses;
}): React.ReactElement | null {
  const state = read.entry.state;
  if (state === "joined") {
    return (
      <TugBadge size="xs" emphasis="ghost" role="success">
        Joined
      </TugBadge>
    );
  }
  if (state === "running") {
    return <ArcLifecycleMark model={trackOf(item, done)} name={item.arc} size="rail" showWord />;
  }
  if (state !== "ready") return null;
  return <StartButtons item={item} presses={presses} />;
}

function StartButtons({ item, presses }: { item: Item; presses: Presses }): React.ReactElement {
  return (
    <>
      <TugPushButton
        size="xs"
        subtype="icon-text"
        emphasis="outlined"
        icon={<Play size={12} />}
        aria-label={`Start ${item.arc}`}
        onClick={(e) => {
          e?.stopPropagation();
          presses.start(item, "here");
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
          aria-label={`Start ${item.arc} in a new session`}
          onClick={(e) => {
            e?.stopPropagation();
            presses.start(item, "new");
          }}
        />
      </TugTooltip>
    </>
  );
}

/** The shipped sketch row, unchanged. */
function SketchAsset({
  sketch,
  heads,
  selected,
  onChoose,
}: {
  sketch: CycleSketchWire;
  heads: readonly number[];
  selected: boolean;
  onChoose: (key: string) => void;
}): React.ReactElement {
  const key = sketchKey(sketch.letter);
  return (
    <div
      className="session-cycle-shade-asset"
      data-asset={key}
      data-kind="sketch"
      data-chosen={selected || undefined}
      data-open={selected || undefined}
    >
      <TugListRow
        selected={selected}
        leading={<span className="session-cycle-shade-seal">{sketch.letter}</span>}
        title={<span className="session-cycle-shade-sketch-label">{`Sketch ${sketch.letter}`}</span>}
        description={
          !selected ? (
            <span className="session-cycle-shade-sketch-want session-cycle-shade-quiet">{sketch.want}</span>
          ) : undefined
        }
        trailing={
          heads.length > 0 ? (
            <span className="session-cycle-shade-waits">
              <span>Heads</span>
              {heads.map((n) => (
                <span key={n} className="session-cycle-shade-wait" data-met>
                  {n}
                </span>
              ))}
            </span>
          ) : undefined
        }
        trailingReveal="always"
        onClick={() => onChoose(key)}
      />
      {selected ? <div className="session-cycle-shade-sketch-body">{recordBody(sketch.text ?? "")}</div> : null}
    </div>
  );
}

/**
 * The shipped entry row, with three changes: it is headed by its own part of
 * the brief, a landed one names its join commit and opens to its run, and a
 * ready one has Start.
 */
function EntryAsset({
  read,
  item,
  done,
  selected,
  onChoose,
  presses,
}: {
  read: CycleShadeEntry;
  item: Item;
  done: number;
  selected: boolean;
  onChoose: (key: string) => void;
  presses: Presses;
}): React.ReactElement {
  const { entry, key } = read;
  const state = entry.state;
  const opened = state === "joined" || state === "running";
  return (
    <div
      className="session-cycle-shade-asset"
      data-asset={key}
      data-kind="entry"
      data-state={state}
      data-chosen={selected || undefined}
      data-open={selected || undefined}
    >
      <TugListRow
        selected={selected}
        leading={<span className="session-cycle-shade-number">{entry.n}</span>}
        title={
          <span className="session-cycle-shade-title">
            <span className="session-cycle-shade-headline">{item.label}</span>
            <span className="session-cycle-shade-quiet sp-prog-of">{BRIEFS[item.brief].title}</span>
          </span>
        }
        description={
          selected || opened ? (
            <span className="session-cycle-shade-facts">
              {opened ? <TugArcAtom name={item.arc} /> : null}
              {state === "joined" ? <TugCommitAtom sha={item.sha} /> : null}
              {state === "running" ? <SessionChip session={item.session} presses={presses} /> : null}
              {item.listed ? null : (
                <TugBadge size="xs" emphasis="ghost" role="caution">
                  On no list
                </TugBadge>
              )}
              {selected ? (
                <>
                  <TugAtomRef entity={{ kind: "file", path: `${ROOT}/briefs/${BRIEFS[item.brief].file}` }} />
                  {state === "joined" ? (
                    <>
                      <SessionChip session={item.session} presses={presses} />
                      <TugLabel size="2xs" emphasis="calm">
                        {`${span(item.mins)} · ${item.rounds} rounds`}
                      </TugLabel>
                    </>
                  ) : null}
                  {state === "waiting" ? (
                    <span className="session-cycle-shade-quiet">{read.sentence}</span>
                  ) : null}
                </>
              ) : null}
            </span>
          ) : undefined
        }
        descriptionMaxLines={0}
        trailing={
          <span className="session-cycle-shade-trailing">
            <EntryMark read={read} item={item} done={done} presses={presses} />
          </span>
        }
        trailingReveal="always"
        onClick={() => onChoose(key)}
      />
      {!selected ? null : opened ? (
        <div className="session-cycle-shade-steps">
          <TugPopupListFrame kind="item" layout="inline">
            <TugPopupListScroller>
              <ArcStepItems steps={stepsOf(state === "joined" ? STEPS.length : done)} live={state === "running"} />
            </TugPopupListScroller>
          </TugPopupListFrame>
        </div>
      ) : (
        <p className="session-cycle-shade-asset-line sp-prog-command">{commandOf(item)}</p>
      )}
    </div>
  );
}

/** The landed entries above the work in hand, as one row. */
function LandedFold({
  reads,
  items,
  onOpen,
}: {
  reads: readonly CycleShadeEntry[];
  items: ReadonlyMap<number, Item>;
  onOpen: () => void;
}): React.ReactElement {
  const first = reads[0]?.entry.n ?? 0;
  const last = reads[reads.length - 1]?.entry.n ?? 0;
  return (
    <div className="session-cycle-shade-asset" data-kind="fold">
      <TugListRow
        leading={
          <span className="session-cycle-shade-number">
            <ChevronRight size={16} aria-hidden />
          </span>
        }
        title={
          <span className="session-cycle-shade-title">
            <span className="session-cycle-shade-headline">{`${first} to ${last}`}</span>
            <span className="session-cycle-shade-quiet sp-prog-of">
              {reads.map((r) => items.get(r.entry.n)?.label ?? "").join(", ")}
            </span>
          </span>
        }
        trailing={
          <span className="session-cycle-shade-trailing">
            <TugBadge size="xs" emphasis="ghost" role="success">
              {`${reads.length} joined`}
            </TugBadge>
          </span>
        }
        trailingReveal="always"
        onClick={onOpen}
      />
    </div>
  );
}

/** The shipped Now and Next lines, with Start on Next, and the List line under them. */
function Footer({
  reads,
  items,
  cycle,
  moment,
  captured,
  presses,
}: {
  reads: readonly CycleShadeEntry[];
  items: ReadonlyMap<number, Item>;
  cycle: CycleWire;
  moment: Moment;
  captured: boolean;
  presses: Presses;
}): React.ReactElement {
  const summary = cycleShadeSummary(cycle, reads);
  const done = moment.stepsDone ?? 0;
  const runs = reads.filter((r) => r.entry.state === "running");
  const next = summary.next.kind === "entry" ? items.get(summary.next.entry.entry.n) : undefined;
  const unseen = moment.landed - moment.seen;
  return (
    <div className="session-cycle-shade-footer">
      <div className="session-cycle-shade-footer-line" data-line="now">
        <span className="session-cycle-shade-footer-word">Now</span>
        {runs.length === 0 ? (
          <span className="session-cycle-shade-quiet">No arc is running</span>
        ) : (
          runs.map((r) => {
            const item = items.get(r.entry.n);
            return item === undefined ? null : (
              <span key={r.key} className="session-cycle-shade-footer-what">
                <span className="session-cycle-shade-headline">{item.label}</span>
                <ArcLifecycleMark model={trackOf(item, done)} name={item.arc} size="rail" showWord />
                <span className="session-cycle-shade-quiet">in</span>
                <SessionChip session={item.session} presses={presses} />
              </span>
            );
          })
        )}
      </div>
      <div className="session-cycle-shade-footer-line" data-line="next">
        <span className="session-cycle-shade-footer-word">Next</span>
        {next !== undefined ? (
          <span className="session-cycle-shade-footer-what">
            <span className="session-cycle-shade-headline">{next.label}</span>
            <StartButtons item={next} presses={presses} />
          </span>
        ) : (
          <span className="session-cycle-shade-quiet">
            {summary.next.kind === "text" ? summary.next.text : ""}
          </span>
        )}
      </div>
      {captured ? (
        <div className="session-cycle-shade-footer-line" data-line="list">
          <span className="session-cycle-shade-footer-word">List</span>
          <span className="session-cycle-shade-footer-what">
            <SessionChip session={STEWARD} presses={presses} />
            <span className="session-cycle-shade-quiet">{`stated it ${moment.stated}`}</span>
            {unseen > 0 ? (
              <>
                <TugBadge size="xs" emphasis="tinted" role="caution">
                  {`${unseen} landed since`}
                </TugBadge>
                <TugPushButton size="xs" subtype="text" emphasis="outlined" onClick={() => presses.ask()}>
                  Ask to review
                </TugPushButton>
              </>
            ) : moment.revised !== null && moment.seen === moment.landed ? (
              <>
                <TugBadge size="xs" emphasis="ghost" role="success">
                  Up to date
                </TugBadge>
                <span className="session-cycle-shade-quiet">briefs ahead revised in</span>
                <TugCommitAtom sha={moment.revised} />
              </>
            ) : (
              <span className="session-cycle-shade-quiet">{`${unseen === 0 ? "nothing" : unseen} landed since`}</span>
            )}
          </span>
        </div>
      ) : null}
    </div>
  );
}

/** The shipped shade's body, evolved. */
function EvolvedShade({
  cycle,
  items,
  moment,
  captured,
  fold,
  presses,
}: {
  cycle: CycleWire;
  items: ReadonlyMap<number, Item>;
  moment: Moment;
  captured: boolean;
  fold: boolean;
  presses: Presses;
}): React.ReactElement {
  const done = moment.stepsDone ?? 0;
  const reads = useMemo(
    () => cycleShadeEntries(cycle, { sessionId: STEWARD, boundOwnerId: null, arcRows: NO_ROWS, lineOf: noLine }),
    [cycle],
  );
  const tiles = useMemo(
    () =>
      cycleMapTiles(reads).map((tile) =>
        tile.state === "running" ? { ...tile, steps: { done, total: STEPS.length } } : tile,
      ),
    [reads, done],
  );
  const keys = useMemo(() => cycleAssetKeys(cycle), [cycle]);
  const sources = useMemo(() => cycle.entries.map((e) => ({ n: e.n, waits: e.waits, from: e.from ?? [] })), [cycle]);
  const summary = useMemo(() => cycleShadeSummary(cycle, reads), [cycle, reads]);

  const [chosen, setChosen] = useState<ReadonlySet<string>>(NO_PICKS);
  const [unfolded, setUnfolded] = useState(false);
  const view = cycleListView(keys, chosen);
  const listRef = useRef<HTMLDivElement | null>(null);
  const scrollOwed = useRef(false);
  const pressOnMap = useCallback((key: string, shift: boolean) => {
    scrollOwed.current = true;
    setChosen((prev) => pressCycleAsset(prev, key, shift));
  }, []);
  const clear = useCallback(() => setChosen(NO_PICKS), []);
  const chooseRow = useCallback((key: string) => setChosen((prev) => pressCycleRow(prev, key)), []);
  useLayoutEffect(() => {
    if (!scrollOwed.current) return;
    scrollOwed.current = false;
    const list = listRef.current;
    const asset = view.top !== null ? list?.querySelector<HTMLElement>(`[data-asset="${view.top}"]`) : null;
    if (list === null || asset === null || asset === undefined) return;
    const top = cycleRevealTop(list.scrollTop, list.clientHeight, asset.offsetTop, asset.offsetHeight);
    if (top !== list.scrollTop) list.scrollTo({ top });
  });

  const readByKey = useMemo(() => new Map(reads.map((r) => [r.key, r])), [reads]);
  const sketchByKey = useMemo(() => new Map((cycle.sketches ?? []).map((s) => [sketchKey(s.letter), s])), [cycle]);

  // Landed entries fold into one row unless the user opened the fold, picked
  // one on the map, or the list is narrowed to a selection.
  const folding = fold && !unfolded && !view.narrowed;
  const folded = folding ? reads.filter((r) => r.entry.state === "joined" && !chosen.has(r.key)) : [];
  const foldedKeys = new Set(folded.map((r) => r.key));
  const foldAt = folded[0]?.key ?? null;

  // The pace: the middle time of the listed arcs that have landed.
  const times = reads
    .filter((r) => r.entry.state === "joined")
    .map((r) => items.get(r.entry.n))
    .filter((i): i is Item => i !== undefined && i.listed)
    .map((i) => i.mins)
    .sort((a, b) => a - b);
  const pace = times[Math.floor(times.length / 2)] ?? 0;
  const ahead = reads.filter((r) => r.entry.state === "ready" || r.entry.state === "waiting").length;

  return (
    <div className="session-cycle-shade" data-narrowed={view.narrowed || undefined}>
      <div className="session-cycle-shade-header">
        <TugPushButton size="xs" subtype="icon" emphasis="ghost" icon={<ChevronDown size={16} />} aria-label="Lower the cycle" />
        <span className="session-cycle-shade-eyebrow">Cycle</span>
        <span className="session-cycle-shade-name">{summary.name}</span>
        <span className="session-cycle-shade-spacer" />
        {pace > 0 ? (
          <span className="session-cycle-shade-quiet sp-prog-pace">
            {ahead > 0 ? `About ${span(pace)} an arc · ${ahead} ahead` : `About ${span(pace)} an arc`}
          </span>
        ) : null}
        <span className="session-cycle-shade-landed">{summary.landedText}</span>
      </div>
      <WrappedMap tiles={tiles} cycle={cycle} chosen={chosen} onPress={pressOnMap} onClear={clear} />
      {view.narrowed ? (
        <div className="session-cycle-shade-back">
          <TugPushButton size="2xs" subtype="text" emphasis="outlined" onClick={clear}>
            Back
          </TugPushButton>
          <TugLabel size="2xs" emphasis="calm">
            {`Showing ${view.shown.length} · Shift-click to add or remove, click the map's ground to clear`}
          </TugLabel>
        </div>
      ) : null}
      <div className="session-cycle-shade-list" ref={listRef}>
        {view.shown.map((key) => {
          const read = readByKey.get(key);
          if (read !== undefined) {
            const item = items.get(read.entry.n);
            if (item === undefined) return null;
            if (foldedKeys.has(key)) {
              return key === foldAt ? (
                <LandedFold key="fold" reads={folded} items={items} onOpen={() => setUnfolded(true)} />
              ) : null;
            }
            return (
              <EntryAsset
                key={key}
                read={read}
                item={item}
                done={done}
                selected={chosen.has(key)}
                onChoose={chooseRow}
                presses={presses}
              />
            );
          }
          const sketch = sketchByKey.get(key);
          return sketch !== undefined ? (
            <SketchAsset
              key={key}
              sketch={sketch}
              heads={headsOf(sketch.letter, sources)}
              selected={chosen.has(key)}
              onChoose={chooseRow}
            />
          ) : null;
        })}
      </div>
      <Footer reads={reads} items={items} cycle={cycle} moment={moment} captured={captured} presses={presses} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// The spike
// ---------------------------------------------------------------------------

const RECORD_ITEMS: TugChoiceItem[] = [
  { value: "today", label: "Record as kept today" },
  { value: "captured", label: "With the list read in" },
];

const SHADE_ITEMS: TugChoiceItem[] = [
  { value: "shipped", label: "Shade as shipped" },
  { value: "evolved", label: "Evolved" },
];

const MOMENT_ITEMS: TugChoiceItem[] = [
  { value: "between", label: "Between arcs, list behind" },
  { value: "cleared", label: "Between arcs, reviewed" },
  { value: "running", label: "Files running" },
  { value: "late", label: "Two from the end" },
];

const FOLD_ITEMS: TugChoiceItem[] = [
  { value: "folded", label: "Landed folded" },
  { value: "listed", label: "Landed listed" },
];

function SpikeCycleProgression(): React.ReactElement {
  const [kind, setKind] = useState<RecordKind>("captured");
  const [shade, setShade] = useState<"shipped" | "evolved">("evolved");
  const [momentKey, setMomentKey] = useState<MomentKey>("between");
  const [fold, setFold] = useState(true);
  const [last, setLast] = useState("nothing yet");
  const kindId = useId();
  const shadeId = useId();
  const momentId = useId();
  const foldId = useId();
  const { ResponderScope, responderRef } = useResponderForm({
    selectValue: {
      [kindId]: (v) => setKind(v as RecordKind),
      [shadeId]: (v) => setShade(v as "shipped" | "evolved"),
      [momentId]: (v) => setMomentKey(v as MomentKey),
      [foldId]: (v) => setFold(v === "folded"),
    },
  });
  const moment = MOMENTS[momentKey];
  const record = useMemo(() => recordAt(kind, moment), [kind, moment]);
  const presses = useMemo<Presses>(
    () => ({
      start: (item, where) =>
        setLast(
          where === "here"
            ? `Start ${item.label}: "${commandOf(item)}" is in this card's prompt, unsent`
            : `Start ${item.label}: a new session opens with "${commandOf(item)}" in its prompt, unsent`,
        ),
      ask: () =>
        setLast(
          "Ask to review: a request naming the arcs landed since the list was stated, and the briefs still ahead, is in this card's prompt, unsent",
        ),
      goTo: (session) => setLast(`Session chip pressed: the card of liven/${TAGS[session] ?? session} comes forward`),
    }),
    [],
  );

  return (
    <ResponderScope>
      <div className="sp-content sp-prog" ref={responderRef as (el: HTMLDivElement | null) => void}>
        <section className="sp-section">
          <h2 className="sp-section-title">The cycle shade, on a long run of arcs a session listed</h2>
          <div className="sp-prog-controls">
            <TugChoiceGroup items={RECORD_ITEMS} value={kind} senderId={kindId} size="sm" />
            <TugChoiceGroup items={SHADE_ITEMS} value={shade} senderId={shadeId} size="sm" />
            <TugChoiceGroup items={MOMENT_ITEMS} value={momentKey} senderId={momentId} size="sm" />
            <TugChoiceGroup items={FOLD_ITEMS} value={fold ? "folded" : "listed"} senderId={foldId} size="sm" />
          </div>
          <p className="sp-prog-caption">
            Last press: <span className="sp-prog-readout">{last}</span>
          </p>
        </section>

        <section className="sp-section">
          <h2 className="sp-section-title">Session card of liven/rotund-plaid · the cycle shade, raised</h2>
          <div className="sp-prog-card">
            {record === null ? (
              <p className="sp-prog-closed">
                No cycle shows. Every entry on record has landed, so the cycle is closed, and a closed cycle is on
                no surface. The eleven arcs still listed are in the transcript and nowhere else.
              </p>
            ) : shade === "shipped" ? (
              <SessionCycleShade
                key={`${kind}-${momentKey}`}
                cycle={record.cycle}
                sessionId={STEWARD}
                boundOwnerId={null}
                onLower={() => setLast("Lower pressed")}
              />
            ) : (
              <EvolvedShade
                key={`${kind}-${momentKey}`}
                cycle={record.cycle}
                items={record.items}
                moment={moment}
                captured={kind === "captured"}
                fold={fold}
                presses={presses}
              />
            )}
          </div>
          <p className="sp-prog-caption">
            The order a session lists its arcs in is read as waits, each arc on the one before, so the shade's own
            Ready, Waiting and Next say where the run stands and the record needs no new kind of order. An entry
            marked On no list landed in the middle of the run without being listed, and waits on nothing.
          </p>
        </section>
      </div>
    </ResponderScope>
  );
}

export const spike: SpikeDef = {
  name: "cycle-progression",
  title: "Cycle Progression",
  blurb:
    "What does the cycle shade need so it still says where the user is when a cycle is a long run of arcs a session listed?",
  icon: "ListOrdered",
  size: {
    min: { width: 480, height: 420 },
    preferred: { width: 860, height: 1120 },
  },
  component: () => <SpikeCycleProgression />,
};
