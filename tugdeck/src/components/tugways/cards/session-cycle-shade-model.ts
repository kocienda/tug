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
 *     bound to; a session bound to an arc no cycle holds shows the cycle of
 *     one that arc is about to be, composed from the arc's own facts and
 *     written nowhere; a session bound to no arc shows the most recently
 *     changed cycle it belongs to.
 *   - **The body's form.** The cycle body for any cycle, a cycle of one
 *     included, and the hint for no cycle at all.
 *   - **Here and elsewhere.** A running entry is this session's when its arc
 *     is the one this session is bound to, or when its bound session is this
 *     session's segment or line. Bound to any other session it is elsewhere;
 *     bound to none it is running with nobody to name.
 *   - **The headline.** An entry is headed by its brief's title, else its
 *     brief's file name, and never by its arc's name: the entry is the brief,
 *     and the arc is what happens to it.
 *   - **Open and closed.** Every asset starts closed, the session's own
 *     entry included. A press on its row or on its mark on the map opens it
 *     alone, and a second press on the one open asset closes it; a shift-press
 *     on the map adds or removes one. The selected assets are the open ones.
 *   - **Steps.** A running entry's steps are its arc row's, found by the
 *     owner key both wear in one frame. The cycle wire carries none.
 *
 * @module components/tugways/cards/session-cycle-shade-model
 */

import type { CycleMapSketch, CycleMapTile } from "@/components/tugways/cycle-map";
import { entryKey, NO_PICKS, pickOnMap, sketchKey } from "@/components/tugways/cycle-map-layout";

import { parseArcRecord } from "@/lib/arc-record-text";
import { arcTrackModelFromEntry } from "@/lib/arc-track-model";
import type {
  ArcChangesetEntry,
  ArcDocuments,
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
 * bound arc that no cycle holds finds no cycle here rather than one the
 * session merely wrote, and {@link standInCycle} stands in for it.
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
 * The two bodies the shade draws. `several` is the cycle body: the header,
 * the map, the asset list and the footer. It is drawn for every cycle,
 * a cycle of one included, so the name is older than its meaning. `none` is
 * the hint, for a session with no cycle and no arc.
 */
export type CycleShadeForm = "none" | "several";

/** The body's form: `several` for any cycle with an entry, `none` otherwise. */
export function cycleShadeForm(cycle: CycleWire | null): CycleShadeForm {
  return (cycle?.entries.length ?? 0) >= 1 ? "several" : "none";
}

/**
 * The tallest a cycle shade stands, as a fraction of the transcript it covers:
 * the top fifth always shows. A height the user sets by its grip is held to it.
 */
export const CYCLE_SHADE_MAX_FRAC = 0.8;

/** The shortest height the grip sets: enough for the header, the map and the footer. */
export const CYCLE_SHADE_MIN_FRAC = 0.25;

/** A height the grip sets, held between the floor and the cap. */
export function clampCycleShadeFrac(frac: number): number {
  return Math.min(CYCLE_SHADE_MAX_FRAC, Math.max(CYCLE_SHADE_MIN_FRAC, frac));
}

/**
 * The key a card's cycle-shade height is kept under, in the shade-height
 * domain. One per card, so each Session card keeps the height its user set.
 */
export function cycleShadeHeightKey(cardId: string): string {
  return `cycle-shade:${cardId}`;
}

/** What a bound arc carries that its stand-in cycle of one is composed from. */
export interface StandInArc {
  ownerId: string;
  name: string;
  projectDir: string;
  boundSession: string;
  documents: ArcDocuments | undefined;
}

/**
 * The cycle of one a bound arc is about to be, while no cycle holds it.
 *
 * The `/arc` door creates the arc and binds the session before it puts the
 * arc on its cycle, so every arc spends a moment on none. Composed from the
 * arc's own facts, the shade draws the ordinary cycle body from it: the
 * arc's record of where the work came from as sketch `A` when it has one,
 * and its brief as entry 1, running in this session. It is named by the
 * brief's title, and the real cycle takes its place when the attach lands.
 * Nothing is written.
 */
export function standInCycle(arc: StandInArc): CycleWire {
  const docs = arc.documents;
  const briefPath = docs?.brief;
  const prefix = `${arc.projectDir.replace(/\/+$/, "")}/`;
  let brief = "brief.md";
  if (briefPath !== undefined) brief = briefPath.startsWith(prefix) ? briefPath.slice(prefix.length) : briefPath;
  const text = docs?.sketch_text;
  const record = text !== undefined && text.trim() !== "" ? text : null;
  const lead = record === null ? undefined : parseArcRecord(record).find((b) => b.kind === "paragraph");
  const entry: CycleEntryWire = {
    n: 1,
    brief,
    ...(briefPath !== undefined ? { brief_path: briefPath } : {}),
    ...(docs?.brief_title !== undefined ? { brief_title: docs.brief_title } : {}),
    arc: { name: arc.name },
    waits: [],
    from: record === null ? [] : ["A"],
    added: "",
    state: "running",
    owner_id: arc.ownerId,
    bound_session: arc.boundSession,
  };
  const sketches: CycleSketchWire[] =
    record === null
      ? []
      : [{ letter: "A", id: "", added: "", ...(lead?.kind === "paragraph" ? { want: lead.text } : {}), text: record }];
  return {
    id: `arc:${arc.ownerId}`,
    name: cycleEntryHeadline(entry),
    created: "",
    updated: "",
    project_dir: arc.projectDir,
    entries: [entry],
    sketches,
    landed: 0,
  };
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
  /** What the entry is called: its brief's title, else its file name. */
  headline: string;
  /** How the entry stands, in one sentence. */
  sentence: string;
}

/**
 * What an entry is called on every surface: its brief's title, else the
 * brief's file name when the title is not on the wire. Never the arc's name.
 */
export function cycleEntryHeadline(entry: CycleEntryWire): string {
  if (entry.brief_title !== undefined && entry.brief_title !== "") return entry.brief_title;
  const cut = entry.brief.lastIndexOf("/");
  return cut === -1 ? entry.brief : entry.brief.slice(cut + 1);
}

/** A tile's tooltip and, after its number, its accessible name: the work, then where it stands. */
export function cycleTileLabel(headline: string, sentence: string): string {
  return `${headline} · ${sentence}`;
}

/** The sentence for how an entry stands, which a tile's label carries after the headline. */
function sentenceOf(entry: CycleEntryWire, where: CycleEntryWhere | null, openWaits: readonly number[]): string {
  switch (entry.state) {
    case "joined":
      return "Joined";
    case "running":
      if (where === "here") return "Running in this session";
      return where === "elsewhere" ? "Running in another session" : "Running";
    case "dropped":
      return "Dropped";
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
        headline: cycleEntryHeadline(entry),
        sentence: sentenceOf(entry, where, openWaits),
      };
    });
}

// ---------------------------------------------------------------------------
// The map's props
// ---------------------------------------------------------------------------

/** The map's tiles: one per entry. */
export function cycleMapTiles(entries: readonly CycleShadeEntry[]): CycleMapTile[] {
  return entries.map(({ entry, where, steps, headline, sentence }) => ({
    n: entry.n,
    waits: entry.waits,
    from: entry.from ?? [],
    state: entry.state,
    ...(where === "elsewhere" ? { elsewhere: true } : {}),
    ...(steps !== null ? { steps } : {}),
    label: cycleTileLabel(headline, sentence),
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
 * list, with that asset brought into view. A selected key the cycle no
 * longer holds is ignored.
 */
export function cycleListView(
  keys: readonly string[],
  chosen: ReadonlySet<string>,
): { shown: readonly string[]; narrowed: boolean; top: string | null } {
  const live = keys.filter((k) => chosen.has(k));
  if (live.length >= 2) return { shown: live, narrowed: true, top: null };
  return { shown: keys, narrowed: false, top: live[0] ?? null };
}

/**
 * Where a list scrolled to `scrollTop`, showing `viewHeight` of itself,
 * should scroll to bring an asset at `assetTop` of height `assetHeight` into
 * view, moving as little as it can. An asset already in view leaves the list
 * where it is; one above it is brought to the top; one below it is brought
 * up until its bottom shows, or its top when it is taller than the view.
 */
export function cycleRevealTop(scrollTop: number, viewHeight: number, assetTop: number, assetHeight: number): number {
  const assetBottom = assetTop + assetHeight;
  if (assetTop < scrollTop) return assetTop;
  if (assetBottom <= scrollTop + viewHeight) return scrollTop;
  return Math.min(assetTop, assetBottom - viewHeight);
}

/**
 * The selection after a press on an asset's mark on the map. A plain press
 * opens that asset alone, and a plain press on the one asset already open
 * closes it; a shift-press adds or removes one; a press on the map's ground
 * (`key` null) closes everything.
 */
export function pressCycleAsset(chosen: ReadonlySet<string>, key: string | null, shift: boolean): ReadonlySet<string> {
  if (key !== null && !shift && chosen.size === 1 && chosen.has(key)) return NO_PICKS;
  return pickOnMap(chosen, key, shift);
}

/**
 * The selection after a press on an asset's row: the same as a plain press on
 * its mark, except that a list narrowed to several assets keeps its
 * selection, since every row it shows is already open.
 */
export function pressCycleRow(chosen: ReadonlySet<string>, key: string): ReadonlySet<string> {
  if (chosen.size > 1) return chosen;
  return pressCycleAsset(chosen, key, false);
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
  /** Every entry is settled: joined or dropped. Only a pending sketch keeps such a cycle open. */
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
  const atRest = total > 0 && entries.every((e) => e.entry.state === "joined" || e.entry.state === "dropped");
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
