/**
 * session-cycle-shade-model — what turns a cycle on the wire into what the Session
 * card's cycle shade and its CYCLE cell show.
 *
 * Pure: no React, no DOM, no store read but the line store's default
 * `lineOf`, which every function takes as an argument so a test passes its
 * own. The view composes `CycleMap` and existing parts from these answers and
 * derives nothing itself.
 *
 * The rules held here:
 *
 *   - **Which cycle a card shows.** The cycle holding the arc this session is
 *     bound to; a session bound to an arc no cycle holds shows no cycle, so
 *     its arc reads as it always has; a session bound to no arc shows the
 *     most recently changed cycle it belongs to.
 *   - **The body's form.** No cycle and no arc; one entry, or an arc with no
 *     cycle; two or more entries.
 *   - **Here and elsewhere.** A running entry is this session's when its arc
 *     is the one this session is bound to, or when its bound session is this
 *     session's segment or line. Bound to any other session it is elsewhere;
 *     bound to none it is running with nobody to name.
 *   - **Steps.** A running entry's steps are its arc row's, found by the
 *     owner key both wear in one frame. The cycle wire carries none.
 *
 * @module components/tugways/cards/session-cycle-shade-model
 */

import type { CycleMapSketch, CycleMapTile } from "@/components/tugways/cycle-map";
import { entryKey, sketchKey } from "@/components/tugways/cycle-map-layout";

import { arcTrackModelFromEntry } from "@/lib/arc-track-model";
import type {
  ArcChangesetEntry,
  CycleEntryWire,
  CycleSketchWire,
  CycleWire,
  WorkspacesChangesetSnapshot,
} from "@/lib/changeset-types";
import { sessionLineStore } from "@/lib/session-line-store";

// ---------------------------------------------------------------------------
// Which cycle, and which form
// ---------------------------------------------------------------------------

/**
 * The cycle a session's card shows, or null.
 *
 * `all` is every cycle in the frame and `mine` the session's own, both in
 * frame order (most recently changed first). `boundOwnerId` is the owner key
 * of the arc the session is bound to. The bound arc decides whenever there is
 * one: the shade's first job is to show the work this session is doing, so a
 * bound arc that no cycle holds shows no cycle rather than one the session
 * merely wrote.
 */
export function chooseCycle(
  all: readonly CycleWire[],
  mine: readonly CycleWire[],
  boundOwnerId: string | null,
): CycleWire | null {
  if (boundOwnerId !== null) {
    return all.find((c) => c.entries.some((e) => e.owner_id === boundOwnerId)) ?? null;
  }
  return mine[0] ?? null;
}

/**
 * The three bodies the shade draws. `several` is the cycle body: the header,
 * the map, the asset list and the footer. It is drawn for every cycle,
 * a cycle of one included, so the name is older than its meaning.
 */
export type CycleShadeForm = "none" | "one" | "several";

/**
 * The body's form: `several` for any cycle with an entry, `one` for a bound
 * arc that no cycle holds, `none` otherwise.
 */
export function cycleShadeForm(cycle: CycleWire | null, hasArc: boolean): CycleShadeForm {
  const count = cycle?.entries.length ?? 0;
  if (count >= 1) return "several";
  return hasArc ? "one" : "none";
}

// ---------------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------------

/** Where a running entry runs, as this session sees it. */
export type CycleEntryWhere = "here" | "elsewhere" | "unbound";

/** What the shade knows of the session it is drawn for. */
export interface CycleShadeContext {
  /** The card's session segment, or null before it has one. */
  sessionId: string | null;
  /** The owner key of the arc this session is bound to, or null. */
  boundOwnerId: string | null;
  /** The frame's arc rows by owner key; see {@link arcRowsByOwner}. */
  arcRows: ReadonlyMap<string, ArcChangesetEntry>;
  /** A segment's line. Defaults to the deck's line store. */
  lineOf?: (sessionId: string) => string | null;
}

/** Whether two session ids name one session: the same segment, or one line. */
export function sameSession(
  a: string,
  b: string,
  lineOf: (sessionId: string) => string | null = sessionLineStore.lineOf,
): boolean {
  if (a === b) return true;
  const lineA = lineOf(a) ?? a;
  const lineB = lineOf(b) ?? b;
  return lineA === lineB;
}

/** Where `entry` runs, or null when it is not running. */
export function cycleEntryWhere(entry: CycleEntryWire, ctx: CycleShadeContext): CycleEntryWhere | null {
  if (entry.state !== "running") return null;
  if (ctx.boundOwnerId !== null && entry.owner_id === ctx.boundOwnerId) return "here";
  if (entry.bound_session === undefined) return "unbound";
  if (ctx.sessionId !== null && sameSession(entry.bound_session, ctx.sessionId, ctx.lineOf)) return "here";
  return "elsewhere";
}

/** Every arc row in a frame by its owner key, the key a running entry wears. */
export function arcRowsByOwner(snapshot: WorkspacesChangesetSnapshot): ReadonlyMap<string, ArcChangesetEntry> {
  const rows = new Map<string, ArcChangesetEntry>();
  for (const project of snapshot.projects) {
    for (const entry of project.changesets) {
      if (entry.kind === "arc" && !rows.has(entry.owner_id)) rows.set(entry.owner_id, entry);
    }
  }
  return rows;
}

/** One entry, read for the shade. */
export interface CycleShadeEntry {
  entry: CycleEntryWire;
  /** The key its tile and its asset share. */
  key: string;
  /** Where it runs; null when it is not running. */
  where: CycleEntryWhere | null;
  /** The waits not yet met, by number. */
  openWaits: readonly number[];
  /** How far a running entry has got, from its arc row; null without one. */
  steps: { done: number; total: number } | null;
  /** The running entry's arc row, for a surface that draws its steps. */
  row: ArcChangesetEntry | null;
  /** How the entry stands, in one sentence. */
  sentence: string;
}

/** The sentence for how an entry stands: the tile's tooltip and name. */
function sentenceOf(entry: CycleEntryWire, where: CycleEntryWhere | null, openWaits: readonly number[]): string {
  switch (entry.state) {
    case "joined":
      return "Joined";
    case "running":
      if (where === "here") return "Running in this session";
      return where === "elsewhere" ? "Running in another session" : "Running";
    case "ready":
      return entry.note ?? "Ready to start";
    default:
      return openWaits.length > 0 ? `Waits on ${openWaits.join(", ")}` : (entry.note ?? "Waiting");
  }
}

/** Every entry of `cycle`, in number order, read against the session. */
export function cycleShadeEntries(cycle: CycleWire, ctx: CycleShadeContext): CycleShadeEntry[] {
  const joined = new Set(cycle.entries.filter((e) => e.state === "joined").map((e) => e.n));
  return [...cycle.entries]
    .sort((a, b) => a.n - b.n)
    .map((entry) => {
      const where = cycleEntryWhere(entry, ctx);
      const openWaits = entry.waits.filter((n) => !joined.has(n));
      const row =
        entry.state === "running" && entry.owner_id !== undefined ? (ctx.arcRows.get(entry.owner_id) ?? null) : null;
      const track = row === null ? null : arcTrackModelFromEntry(row).steps;
      return {
        entry,
        key: entryKey(entry.n),
        where,
        openWaits,
        steps: track === null ? null : { done: track.done, total: track.total },
        row,
        sentence: sentenceOf(entry, where, openWaits),
      };
    });
}

// ---------------------------------------------------------------------------
// The map's props
// ---------------------------------------------------------------------------

/** The map's tiles: one per entry. */
export function cycleMapTiles(entries: readonly CycleShadeEntry[]): CycleMapTile[] {
  return entries.map(({ entry, where, steps, sentence }) => ({
    n: entry.n,
    waits: entry.waits,
    from: entry.from ?? [],
    state: entry.state,
    ...(where === "elsewhere" ? { elsewhere: true } : {}),
    ...(steps !== null ? { steps } : {}),
    label: sentence,
  }));
}

/** The map's seals: one per sketch, with its want, or its letter when unread. */
export function cycleMapSketches(cycle: CycleWire): CycleMapSketch[] {
  return (cycle.sketches ?? []).map((s) => ({ letter: s.letter, want: s.want ?? `Sketch ${s.letter}` }));
}

// ---------------------------------------------------------------------------
// The asset list
// ---------------------------------------------------------------------------

/**
 * The list's assets in order, by key: each entry in number order, with every
 * sketch it came from before it the first time that sketch is met, then any
 * sketch no entry came from.
 */
export function cycleAssetKeys(cycle: CycleWire): string[] {
  const letters = new Set((cycle.sketches ?? []).map((s) => s.letter));
  const shown = new Set<string>();
  const keys: string[] = [];
  const sketch = (letter: string): void => {
    if (!letters.has(letter) || shown.has(letter)) return;
    shown.add(letter);
    keys.push(sketchKey(letter));
  };
  for (const entry of [...cycle.entries].sort((a, b) => a.n - b.n)) {
    for (const letter of entry.from ?? []) sketch(letter);
    keys.push(entryKey(entry.n));
  }
  for (const letter of letters) sketch(letter);
  return keys;
}

/**
 * What the list shows under a selection, and what it brings to its top.
 *
 * Two or more selected: only those, under Back. One selected: the whole
 * list, scrolled to that asset. A selected key the cycle no longer holds is
 * ignored.
 */
export function cycleListView(
  keys: readonly string[],
  chosen: ReadonlySet<string>,
): { shown: readonly string[]; narrowed: boolean; top: string | null } {
  const live = keys.filter((k) => chosen.has(k));
  if (live.length >= 2) return { shown: live, narrowed: true, top: null };
  return { shown: keys, narrowed: false, top: live[0] ?? null };
}

/** A sketch by its key's letter, or null. */
export function cycleSketch(cycle: CycleWire, letter: string): CycleSketchWire | null {
  return cycle.sketches?.find((s) => s.letter === letter) ?? null;
}

// ---------------------------------------------------------------------------
// The header and the footer
// ---------------------------------------------------------------------------

/** The footer's Now line. */
export type CycleNowLine =
  | { kind: "entry"; entry: CycleShadeEntry }
  | { kind: "text"; text: string };

/** The footer's Next line. */
export type CycleNextLine =
  | { kind: "entry"; entry: CycleShadeEntry; note: string | null; more: number }
  | { kind: "text"; text: string };

/** What the header and the two-line footer say. */
export interface CycleShadeSummary {
  name: string;
  landed: number;
  total: number;
  /** "2 of 5 landed". */
  landedText: string;
  /** Every entry has joined. */
  atRest: boolean;
  /** What this session is running, or that it runs nothing. */
  now: CycleNowLine;
  /** How many entries run in other sessions. */
  elsewhere: number;
  /** The sessions those entries run in, each once, in entry order: the footer's chips. */
  elsewhereSessions: readonly { id: string; tag: string | null }[];
  /** The first ready entry, or why there is none. */
  next: CycleNextLine;
}

/** "2 of 5 landed". */
export function cycleLandedText(landed: number, total: number): string {
  return `${landed} of ${total} landed`;
}

/** The header's and footer's reading of a cycle. */
export function cycleShadeSummary(cycle: CycleWire, entries: readonly CycleShadeEntry[]): CycleShadeSummary {
  const total = entries.length;
  const landed = entries.filter((e) => e.entry.state === "joined").length;
  const landedText = cycleLandedText(landed, total);
  const atRest = total > 0 && landed === total;
  const current = entries.find((e) => e.where === "here") ?? null;
  const ready = entries.filter((e) => e.entry.state === "ready");
  const first = ready[0];
  return {
    name: cycle.name,
    landed,
    total,
    landedText,
    atRest,
    now:
      current !== null
        ? { kind: "entry", entry: current }
        : { kind: "text", text: atRest ? `At rest, ${landedText}` : "No arc in this session" },
    elsewhere: entries.filter((e) => e.where === "elsewhere").length,
    elsewhereSessions: entries.reduce<{ id: string; tag: string | null }[]>((sessions, e) => {
      const id = e.entry.bound_session;
      if (e.where !== "elsewhere" || id === undefined || sessions.some((s) => s.id === id)) return sessions;
      return [...sessions, { id, tag: e.entry.bound_callsign ?? null }];
    }, []),
    next:
      first !== undefined
        ? { kind: "entry", entry: first, note: first.entry.note ?? null, more: ready.length - 1 }
        : { kind: "text", text: atRest ? "Nothing waiting" : "Nothing is ready until an arc lands" },
  };
}

// ---------------------------------------------------------------------------
// A cycle of one, whose arc is not this session's
// ---------------------------------------------------------------------------

/** How the one entry's arc stands, for the Arc panel of a cycle of one. */
export interface CycleEntryStanding {
  state: "done" | "active" | "pending";
  title: string;
  detail: string | null;
}

/**
 * The one line that stands in for the Arc panel when the entry's arc is not
 * bound to this session, and so has no verbs here.
 */
export function cycleEntryStanding(read: CycleShadeEntry): CycleEntryStanding {
  const { entry, sentence } = read;
  switch (entry.state) {
    case "joined":
      return { state: "done", title: "Joined", detail: "Landed. Its rounds and commit stay on record." };
    case "running":
      return { state: "active", title: sentence, detail: entry.note ?? null };
    case "ready":
      return { state: "pending", title: "Ready to start", detail: entry.note ?? "Nothing is in its way." };
    default:
      return { state: "pending", title: sentence, detail: sentence === entry.note ? null : (entry.note ?? null) };
  }
}

/** The text of the first readable sketch an entry came from, or null. */
export function cycleEntrySketchText(cycle: CycleWire, entry: CycleEntryWire): string | null {
  for (const letter of entry.from ?? []) {
    const text = cycleSketch(cycle, letter)?.text;
    if (text !== undefined) return text;
  }
  return null;
}

// ---------------------------------------------------------------------------
// The CYCLE:ARC cell
// ---------------------------------------------------------------------------

/**
 * The cycle's half of the CYCLE:ARC cell: how many of its entries have
 * landed of how many there are, and the sentence a screen reader hears for
 * it. Every cycle has one, a cycle of one included, which reads 0/1 or 1/1.
 * The arc's half is the cell's own reading of this session's arc, which
 * stands beside this one whenever the session has an arc; a session with
 * neither reads `None`.
 */
export interface CycleCellReading {
  text: string;
  label: string;
}

/**
 * The widest cycle fraction the cell sizes its box for. Digits are
 * `tabular-nums`, so the shape is what matters; a cycle past nine entries
 * reads wider, and no cycle has one.
 */
export const CYCLE_CELL_WIDEST_FRACTION = "0/0";

/**
 * What joins the cell's two readings, as `0/3 : 2/5`: a colon with a
 * non-breaking space on each side. Ordinary spaces would be trimmed, since
 * the colon sits in its own flex item; the sizing faces use the same joiner
 * so the box matches what is drawn.
 */
export const CYCLE_ARC_JOINER = "\u00a0:\u00a0";

/** The cycle's fraction for the cycle a card shows, or null with no cycle. */
export function cycleCellReading(cycle: CycleWire | null): CycleCellReading | null {
  if (cycle === null || cycle.entries.length === 0) return null;
  const total = cycle.entries.length;
  return {
    text: `${cycle.landed}/${total}`,
    label: `cycle ${cycle.name}, ${cycleLandedText(cycle.landed, total)}`,
  };
}
