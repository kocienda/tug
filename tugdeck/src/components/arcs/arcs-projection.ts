/**
 * arcs-projection.ts — what the Cycles & Arcs card draws, from one aggregate
 * snapshot and the session the card follows.
 *
 * Three lists, in the order the card shows them: the cycles, then the arcs no
 * cycle names, then the waiting paperwork. A cycle of two or more entries is a
 * section with a map over one row per asset; a cycle of one entry is that one
 * row. An arc is drawn once: a live arc or a branchless one whose owner key a
 * cycle's entry carries is drawn in its cycle and left out of the loose lists.
 *
 * Everything here is pure. It reads no store and holds no React; the card
 * memoizes one pass per snapshot.
 *
 * @module components/arcs/arcs-projection
 */

import type {
  CycleMapSketch,
  CycleMapTile,
} from "@/components/tugways/cycle-map";
import { entryKey, NO_PICKS, pickOnMap, sketchKey } from "@/components/tugways/cycle-map-layout";
import { compareArcEntries } from "@/lib/arc-order";
import type {
  ArcChangesetEntry,
  CycleEntryState,
  CycleEntryWire,
  CycleSketchWire,
  CycleWire,
  DocumentArcEntry,
  ProjectChangeset,
  WorkspacesChangesetSnapshot,
} from "@/lib/changeset-types";

// ---------------------------------------------------------------------------
// Arc rows
// ---------------------------------------------------------------------------

/** One arc, in any state, flattened out of the aggregate for the list. */
export interface ArcRow {
  /** The arc's owner key — this row's identity, unique per incarnation. */
  ownerId: string;
  /** The whole wire entry: the eyebrow and the meta line read it directly. */
  entry: ArcChangesetEntry;
  /** The owning project's directory — what a bind has to name. */
  projectDir: string;
  /**
   * The key this project's join traffic is addressed by.
   *
   * Distinct from {@link projectDir} on purpose ([L29]): the join store is
   * written under the `project_dir` a *request* echoed back, and every send on
   * that path carries the workspace key. Reading beats under the root's
   * spelling is a subscription to a cell nothing writes.
   */
  workspaceKey: string;
  /** The owning project's name, for Bind's refusal sentence. */
  projectLabel: string;
}

function rowFromEntry(
  entry: ArcChangesetEntry,
  project: ProjectChangeset,
): ArcRow {
  return {
    ownerId: entry.owner_id,
    entry,
    projectDir: project.project_dir,
    workspaceKey: project.workspace_key,
    projectLabel: project.display_name,
  };
}

/**
 * The section's total order: stage rank descending, then freshest first, then
 * by name — {@link compareArcEntries} over the rows' entries. The Changes
 * shade's arc lane sorts its unbound arcs with the same function, so the two
 * surfaces cannot drift apart.
 */
export function compareArcRows(a: ArcRow, b: ArcRow): number {
  return compareArcEntries(a.entry, b.entry);
}

/**
 * Every arc across every open project, in every state, ordered by
 * {@link compareArcRows}. No filter: bound and unbound alike are this
 * section's rows now, and which register a row wears is the eyebrow's
 * business, not membership's.
 *
 * Project grouping is not an ordering key: grouping by project would bury a
 * arc that is one gesture from landing under one created a week ago in
 * another repo.
 *
 * One row per owner key: two projects opening one repository — a base checkout
 * and its spelling through a firmlink — both carry the repo's arcs, and the
 * owner key is the identity that says they are the same arc. First occurrence
 * in snapshot order wins, before the sort, so which project's row survives is
 * stable across renders.
 */
export function arcRowsFromSnapshot(
  snapshot: WorkspacesChangesetSnapshot,
): ArcRow[] {
  const seen = new Set<string>();
  const rows = snapshot.projects
    .flatMap((project) =>
      project.changesets
        .filter((entry): entry is ArcChangesetEntry => entry.kind === "arc")
        .map((entry) => rowFromEntry(entry, project)),
    )
    .filter((row) => {
      if (seen.has(row.ownerId)) return false;
      seen.add(row.ownerId);
      return true;
    });
  // `filter` already allocated this array; the snapshot it was projected from
  // is never touched.
  return rows.sort(compareArcRows);
}

/**
 * One plan document waiting in a project's docs directory — the front half of
 * the arc, which was invisible to every surface until now.
 *
 * A plan row is waiting paperwork **by filter, not by construction**. Presence
 * in the docs directory says nothing about ownership: adoption leaves a
 * committed, clean base copy exactly where it was, so a plan an arc is
 * implementing right now sits there for the arc's whole life with its ledger
 * frozen at all-`pending` — the run's progress goes to the worktree copy. What
 * keeps the two kinds of row from naming the same work is the producer, which
 * lists a document only when no arc has adopted it and its ledger is not
 * wholly `done`.
 */
export interface DocumentArcRow {
  /** Project dir plus arc name — unique across every open project. */
  key: string;
  /** The owning project's directory — what a Start has to name. */
  projectDir: string;
  /** The wire entry: the row reads it directly. */
  entry: DocumentArcEntry;
}

/** Nearest-to-work-starting first: a reviewed plan is one gesture from an arc. */
const PLAN_REVIEW_RANK: Record<string, number> = {
  reviewed: 2,
  stale: 1,
  "never-reviewed": 0,
};

/** An unrecognized review spelling — or none at all — sorts last. */
function reviewRank(review: string): number {
  return PLAN_REVIEW_RANK[review] ?? -1;
}

/** Work already on the ledger — done or in progress. */
export function documentArcIsBegun(entry: DocumentArcEntry): boolean {
  return entry.steps_begun > 0;
}

/**
 * The plan rows' total order: begun first, then review rank descending, then
 * by name.
 *
 * The same nearest-to-done principle {@link compareArcRows} encodes, applied
 * to the front half: work in flight is nearer done than work not started, and
 * among the unstarted a reviewed plan is one press from becoming an arc while
 * an unreviewed one still needs a turn spent on it.
 */
export function compareDocumentArcRows(
  a: DocumentArcRow,
  b: DocumentArcRow,
): number {
  const byBegun =
    Number(documentArcIsBegun(b.entry)) - Number(documentArcIsBegun(a.entry));
  if (byBegun !== 0) return byBegun;
  const byReview =
    reviewRank(b.entry.review ?? "") - reviewRank(a.entry.review ?? "");
  if (byReview !== 0) return byReview;
  return a.entry.display_name.localeCompare(b.entry.display_name);
}

/**
 * Every waiting plan document across every open project, ordered by
 * {@link compareDocumentArcRows}.
 *
 * Every project, not the followed one — the same choice
 * {@link arcRowsFromSnapshot} makes, for the same reason: a listing that
 * changed as the reader moved between cards would be the coming-and-going wart
 * this section already retired.
 *
 * One row per `owner_id`, exactly as {@link arcRowsFromSnapshot} dedupes —
 * and never on `key`, which namespaces the name under its project and so
 * differs between the very duplicates being removed. First occurrence in
 * snapshot order wins.
 */
export function documentArcRowsFromSnapshot(
  snapshot: WorkspacesChangesetSnapshot,
): DocumentArcRow[] {
  const seen = new Set<string>();
  const rows = snapshot.projects
    .flatMap((project) =>
      (project.document_arcs ?? []).map((entry) => ({
        key: `${project.project_dir}:${entry.display_name}`,
        projectDir: project.project_dir,
        entry,
      })),
    )
    .filter((row) => {
      if (seen.has(row.entry.owner_id)) return false;
      seen.add(row.entry.owner_id);
      return true;
    });
  return rows.sort(compareDocumentArcRows);
}

// ---------------------------------------------------------------------------
// Cycles
// ---------------------------------------------------------------------------

/** One entry of a cycle, as its row and its tile read it. */
export interface CycleEntryRow {
  /** The asset's key: `entryKey(n)`, the key the map reports a press by. */
  key: string;
  entry: CycleEntryWire;
  /** What the row is called: the arc's name, else the brief's title, else its file. */
  title: string;
  /** The sentence saying where the entry stands. The tile's tooltip is the same one. */
  sentence: string;
  /** The entries this one waits on that have not joined, in the record's order. */
  openWaits: readonly number[];
  /**
   * The running arc's own row in the same frame, found by owner key: the row
   * the steps, the lifecycle mark and the verbs are read from. Null when the
   * entry is not running, or its arc has no branch yet.
   */
  arc: ArcRow | null;
  /** The running arc's paperwork row, when the arc has documents and no branch. */
  plan: DocumentArcRow | null;
  /** Running, and not in the session the card follows. */
  elsewhere: boolean;
  /** How far a running entry has got, when its arc's ledger says. */
  steps: { done: number; total: number } | null;
}

/** One sketch of a cycle, as its row reads it. */
export interface CycleSketchRow {
  /** The asset's key: `sketchKey(letter)`. */
  key: string;
  letter: string;
  /** What the sketch wants, on one line's worth; empty when the store holds no text. */
  want: string;
  /** The whole sketch; empty when the store holds no text. */
  text: string;
  /** The numbers of the entries that came from it. */
  entries: readonly number[];
}

/** One row under a cycle's pin. */
export type CycleAsset =
  | { kind: "sketch"; key: string; sketch: CycleSketchRow }
  | { kind: "entry"; key: string; row: CycleEntryRow };

/** A cycle of two or more entries: a pinned header and map over its assets. */
export interface CycleSection {
  kind: "section";
  /** The cycle's id: the key its fold and its selection are held under. */
  id: string;
  cycle: CycleWire;
  name: string;
  /** "N of M landed", or "At rest · M arcs". */
  landedText: string;
  /** Every entry has joined. A cycle at rest starts folded. */
  atRest: boolean;
  tiles: readonly CycleMapTile[];
  sketches: readonly CycleMapSketch[];
  /** Each sketch's row before the entries that came from it; a sketch no entry came from, last. */
  assets: readonly CycleAsset[];
  /** One state per entry, in entry order: the folded cycle's strip. */
  strip: readonly CycleEntryState[];
}

/** A cycle of one entry: that entry's row, with no header, map, number or sketch row. */
export interface CycleSingle {
  kind: "single";
  id: string;
  cycle: CycleWire;
  row: CycleEntryRow;
}

export type CycleItem = CycleSection | CycleSingle;

/** Everything the card draws, in the order it draws it. */
export interface ArcsCardProjection {
  /** The cycles, in the order the frame sends them: most recently changed first. */
  cycles: readonly CycleItem[];
  /** The arcs no cycle's running entry names, in {@link compareArcRows} order. */
  arcs: readonly ArcRow[];
  /** The waiting paperwork no cycle's running entry names. */
  plans: readonly DocumentArcRow[];
  /** Nothing at all to draw: the card shows its one `None` line. */
  empty: boolean;
}

/** The last segment of a path. */
function basename(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? path : path.slice(cut + 1);
}

/**
 * How far an arc's ledger has got: rows reading `done` over the rows the arc
 * will walk. A withdrawn row is not walked, so it is in neither number. Null
 * when the arc carries no ledger.
 */
function stepsOfArc(entry: ArcChangesetEntry): { done: number; total: number } | null {
  const walked = (entry.steps ?? []).filter((s) => s.status !== "withdrawn");
  if (walked.length === 0) return null;
  return {
    done: walked.filter((s) => s.status === "done").length,
    total: walked.length,
  };
}

/** The same reading off a branchless arc's counters. */
function stepsOfPlan(entry: DocumentArcEntry): { done: number; total: number } | null {
  return entry.step_total > 0
    ? { done: entry.steps_done, total: entry.step_total }
    : null;
}

/**
 * The sentence for an entry. A running entry names the followed session only
 * when the card follows one: "this session" is a claim about the card beside
 * this one, and with none followed there is no such card.
 */
function sentenceOf(
  entry: CycleEntryWire,
  openWaits: readonly number[],
  followedSession: string | null,
): string {
  switch (entry.state) {
    case "joined":
      return "Joined";
    case "running":
      if (entry.bound_session === undefined) return "Running";
      return followedSession !== null && entry.bound_session === followedSession
        ? "Running in this session"
        : "Running in another session";
    case "ready":
      return entry.note ?? "Ready to start";
    case "waiting":
      return openWaits.length > 0
        ? `Waits on ${openWaits.join(", ")}`
        : (entry.note ?? "Waiting");
  }
}

interface ArcLookup {
  arcs: ReadonlyMap<string, ArcRow>;
  plans: ReadonlyMap<string, DocumentArcRow>;
}

function entryRow(
  cycle: CycleWire,
  entry: CycleEntryWire,
  lookup: ArcLookup,
  followedSession: string | null,
): CycleEntryRow {
  const joined = new Set(
    cycle.entries.filter((e) => e.state === "joined").map((e) => e.n),
  );
  const present = new Set(cycle.entries.map((e) => e.n));
  // A wait on a number the cycle does not hold is not something to wait for.
  const openWaits = entry.waits.filter((n) => present.has(n) && !joined.has(n));
  const arc =
    entry.owner_id !== undefined ? (lookup.arcs.get(entry.owner_id) ?? null) : null;
  const plan =
    entry.owner_id !== undefined ? (lookup.plans.get(entry.owner_id) ?? null) : null;
  const running = entry.state === "running";
  return {
    key: entryKey(entry.n),
    entry,
    title: entry.arc?.name ?? entry.brief_title ?? basename(entry.brief),
    sentence: sentenceOf(entry, openWaits, followedSession),
    openWaits,
    arc,
    plan,
    elsewhere:
      running && followedSession !== null && entry.bound_session !== followedSession,
    steps: !running
      ? null
      : arc !== null
        ? stepsOfArc(arc.entry)
        : plan !== null
          ? stepsOfPlan(plan.entry)
          : null,
  };
}

function tileOf(row: CycleEntryRow): CycleMapTile {
  return {
    n: row.entry.n,
    waits: row.entry.waits,
    from: row.entry.from ?? [],
    state: row.entry.state,
    ...(row.elsewhere ? { elsewhere: true } : {}),
    ...(row.steps !== null ? { steps: row.steps } : {}),
    label: row.sentence,
  };
}

/**
 * A cycle's sketches as rows: the ones the record names, in its order, then
 * any letter an entry names that the record does not, in the order the
 * entries name them. The map seals its sketches by the same rule, so every
 * seal has a row.
 */
function sketchRows(cycle: CycleWire): CycleSketchRow[] {
  const named = new Map<string, CycleSketchWire>(
    (cycle.sketches ?? []).map((s) => [s.letter, s]),
  );
  const letters: string[] = [];
  for (const letter of [
    ...named.keys(),
    ...cycle.entries.flatMap((e) => e.from ?? []),
  ]) {
    if (!letters.includes(letter)) letters.push(letter);
  }
  return letters.map((letter) => ({
    key: sketchKey(letter),
    letter,
    want: named.get(letter)?.want ?? "",
    text: named.get(letter)?.text ?? "",
    entries: cycle.entries
      .filter((e) => (e.from ?? []).includes(letter))
      .map((e) => e.n),
  }));
}

/** Entries in order, each sketch before the first entry that came from it, the rest last. */
function assetsOf(
  rows: readonly CycleEntryRow[],
  sketches: readonly CycleSketchRow[],
): CycleAsset[] {
  const placed = new Set<string>();
  const assets: CycleAsset[] = [];
  const place = (sketch: CycleSketchRow): void => {
    placed.add(sketch.letter);
    assets.push({ kind: "sketch", key: sketch.key, sketch });
  };
  for (const row of rows) {
    const from = row.entry.from ?? [];
    for (const sketch of sketches) {
      if (from.includes(sketch.letter) && !placed.has(sketch.letter)) place(sketch);
    }
    assets.push({ kind: "entry", key: row.key, row });
  }
  for (const sketch of sketches) {
    if (!placed.has(sketch.letter)) place(sketch);
  }
  return assets;
}

function cycleItem(
  cycle: CycleWire,
  lookup: ArcLookup,
  followedSession: string | null,
): CycleItem | null {
  const rows = cycle.entries.map((entry) =>
    entryRow(cycle, entry, lookup, followedSession),
  );
  // A cycle with no entry names no work yet, so there is nothing to draw.
  if (rows.length === 0) return null;
  if (rows.length === 1) {
    return { kind: "single", id: cycle.id, cycle, row: rows[0]! };
  }
  const sketches = sketchRows(cycle);
  const landed = rows.filter((r) => r.entry.state === "joined").length;
  const atRest = landed === rows.length;
  return {
    kind: "section",
    id: cycle.id,
    cycle,
    name: cycle.name,
    landedText: atRest
      ? `At rest · ${rows.length} arcs`
      : `${landed} of ${rows.length} landed`,
    atRest,
    tiles: rows.map(tileOf),
    sketches: sketches.map((s) => ({ letter: s.letter, want: s.want })),
    assets: assetsOf(rows, sketches),
    strip: rows.map((r) => r.entry.state),
  };
}

/**
 * Project a snapshot into what the card draws.
 *
 * `followedSession` is the session of the card this one follows, or null. It
 * decides only which running entries read as elsewhere.
 *
 * One section per cycle id: two projects opening one repository both carry
 * its cycles, as they do its arcs, and the first in snapshot order wins.
 */
export function projectArcsCard(
  snapshot: WorkspacesChangesetSnapshot,
  followedSession: string | null,
): ArcsCardProjection {
  const allArcs = arcRowsFromSnapshot(snapshot);
  const allPlans = documentArcRowsFromSnapshot(snapshot);
  const lookup: ArcLookup = {
    arcs: new Map(allArcs.map((row) => [row.ownerId, row])),
    plans: new Map(allPlans.map((row) => [row.entry.owner_id, row])),
  };

  const seen = new Set<string>();
  const cycles: CycleItem[] = [];
  // The owner keys cycles draw. Matched on the key and never on the arc's
  // name, which is unique only inside one generation.
  const drawn = new Set<string>();
  for (const project of snapshot.projects) {
    for (const cycle of project.cycles ?? []) {
      if (seen.has(cycle.id)) continue;
      seen.add(cycle.id);
      const item = cycleItem(cycle, lookup, followedSession);
      if (item === null) continue;
      cycles.push(item);
      for (const entry of cycle.entries) {
        if (entry.owner_id !== undefined) drawn.add(entry.owner_id);
      }
    }
  }

  const arcs = allArcs.filter((row) => !drawn.has(row.ownerId));
  const plans = allPlans.filter((row) => !drawn.has(row.entry.owner_id));
  return {
    cycles,
    arcs,
    plans,
    empty: cycles.length === 0 && arcs.length === 0 && plans.length === 0,
  };
}

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------

/**
 * What the reader has done to the cycles since the card opened: which are
 * folded, and which assets are selected in each. Keyed by cycle id. A cycle
 * with no entry in `folded` takes its start from whether it is at rest.
 */
export interface CycleViewState {
  folded: ReadonlyMap<string, boolean>;
  chosen: ReadonlyMap<string, ReadonlySet<string>>;
}

/** The view of a card nobody has touched. */
export const NO_CYCLE_VIEW: CycleViewState = {
  folded: new Map(),
  chosen: new Map(),
};

/** Whether a section is folded: the reader's choice, else folded at rest. */
export function cycleIsFolded(view: CycleViewState, section: CycleSection): boolean {
  return view.folded.get(section.id) ?? section.atRest;
}

/** The assets selected in one cycle. */
export function cycleChosen(view: CycleViewState, id: string): ReadonlySet<string> {
  return view.chosen.get(id) ?? NO_PICKS;
}

/** The view after a section's fold is flipped. */
export function foldCycle(view: CycleViewState, section: CycleSection): CycleViewState {
  const folded = new Map(view.folded);
  folded.set(section.id, !cycleIsFolded(view, section));
  return { ...view, folded };
}

function withChosen(view: CycleViewState, id: string, next: ReadonlySet<string>): CycleViewState {
  const chosen = new Map(view.chosen);
  if (next.size === 0) chosen.delete(id);
  else chosen.set(id, next);
  return { ...view, chosen };
}

/**
 * The view after a press on a cycle's map: one asset selected, one toggled by
 * a shift-press, or none after a press on the map's ground (`key` null).
 */
export function pressCycleMap(
  view: CycleViewState,
  id: string,
  key: string | null,
  shift: boolean,
): CycleViewState {
  return withChosen(view, id, pickOnMap(cycleChosen(view, id), key, shift));
}

/**
 * The view after a press on an asset's row: that asset selected alone. While
 * the list is narrowed to several assets a row press changes nothing.
 */
export function pressCycleRow(view: CycleViewState, id: string, key: string): CycleViewState {
  const chosen = cycleChosen(view, id);
  if (chosen.size > 1) return view;
  return withChosen(view, id, new Set([key]));
}

/** The view after a press on a cycle of one: its row opens, or closes. */
export function pressCycleSingle(view: CycleViewState, single: CycleSingle): CycleViewState {
  const open = cycleChosen(view, single.id).has(single.row.key);
  return withChosen(view, single.id, open ? NO_PICKS : new Set([single.row.key]));
}

/** One row of the card's list. */
export type ArcsCardItem =
  | {
      kind: "cycle-pin";
      id: string;
      section: CycleSection;
      folded: boolean;
      chosen: ReadonlySet<string>;
    }
  | { kind: "cycle-asset"; id: string; section: CycleSection; asset: CycleAsset; open: boolean }
  | { kind: "cycle-single"; id: string; single: CycleSingle; open: boolean }
  | { kind: "arc"; id: string; row: ArcRow }
  | { kind: "plan"; id: string; row: DocumentArcRow };

/**
 * The card's rows, in the order the arrows walk them: each cycle's pin and
 * the assets showing under it, each cycle of one, then the loose arcs, then
 * the waiting paperwork.
 *
 * A folded cycle lists no assets. With two or more assets selected only those
 * are listed; a selected asset is open.
 *
 * Row ids are namespaced by kind, so a cycle id, an owner key and a document
 * key can never collide. An arc row's id is its bare owner key, as it was
 * before the card knew of cycles.
 */
export function listArcsCard(
  projection: ArcsCardProjection,
  view: CycleViewState,
): ArcsCardItem[] {
  const items: ArcsCardItem[] = [];
  for (const cycle of projection.cycles) {
    const chosen = cycleChosen(view, cycle.id);
    if (cycle.kind === "single") {
      items.push({
        kind: "cycle-single",
        id: `cycle:${cycle.id}`,
        single: cycle,
        open: chosen.has(cycle.row.key),
      });
      continue;
    }
    const folded = cycleIsFolded(view, cycle);
    items.push({ kind: "cycle-pin", id: `cycle:${cycle.id}`, section: cycle, folded, chosen });
    if (folded) continue;
    for (const asset of cycle.assets) {
      if (chosen.size > 1 && !chosen.has(asset.key)) continue;
      items.push({
        kind: "cycle-asset",
        id: `cycle:${cycle.id}:${asset.key}`,
        section: cycle,
        asset,
        open: chosen.has(asset.key),
      });
    }
  }
  for (const row of projection.arcs) items.push({ kind: "arc", id: row.ownerId, row });
  for (const row of projection.plans) items.push({ kind: "plan", id: `doc:${row.key}`, row });
  return items;
}
