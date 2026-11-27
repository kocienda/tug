/**
 * session-cycle-shade-model — the rules that turn a cycle into what the cycle shade
 * and the CYCLE cell show, over the golden frame and small cycles built from
 * it.
 *
 * Covered: which cycle a card shows, the stand-in cycle of one, the body's two forms, here and
 * elsewhere through the session's line, a running entry bound to nobody, the
 * tiles and their steps from the arc row, the asset list under a selection,
 * the footer at start, midway and rest, and the cell's reading.
 */

import { describe, expect, test } from "bun:test";

import golden from "@/__tests__/fixtures/workspaces-changeset-snapshot.golden.json";
import { entryKey, pickOnMap, NO_PICKS, sketchKey } from "@/components/tugways/cycle-map-layout";
import type {
  ArcChangesetEntry,
  CycleEntryWire,
  CycleWire,
  WorkspacesChangesetSnapshot,
} from "@/lib/changeset-types";

import {
  arcRowsByOwner,
  chooseCycle,
  cycleAssetKeys,
  cycleCellReading,
  cycleEntryWhere,
  cycleListView,
  cycleMapSketches,
  cycleRevealTop,
  clampCycleShadeFrac,
  cycleShadeHeightKey,
  cycleMapTiles,
  cycleShadeEntries,
  cycleShadeForm,
  cycleShadeSummary,
  pressCycleAsset,
  pressCycleRow,
  sameSession,
  standInCycle,
  type CycleShadeContext,
} from "../session-cycle-shade-model";

const DATA = golden as WorkspacesChangesetSnapshot;
const GOLDEN = DATA.projects[0]!.cycles![0]!;

/** Bound on the golden's running entry, and the cycle's writer. */
const WRITER = "sess-0197a2b4-c8d1-7e02-9f3a-b5c6d7e8f901";
const OWNER = "tugarc/fix-join#1723500000000-a1b2c3";
const STRANGER = "sess-stranger";

const noLines = (): string | null => null;

/** An arc bound to the writer that no cycle holds yet. */
const BOUND = {
  ownerId: OWNER,
  name: "fix-join",
  projectDir: "/u/proj/",
  boundSession: WRITER,
  documents: {
    brief: "/u/proj/.tug/arcs/fix-join/brief.md",
    brief_title: "Fix the join",
    sketch_text: "Join should keep the branch.\n\nKeep the branch until the user discards it.\n",
  },
};

const ROWS = arcRowsByOwner(DATA);

const ctx = (over: Partial<CycleShadeContext> = {}): CycleShadeContext => ({
  sessionId: WRITER,
  boundOwnerId: OWNER,
  arcRows: ROWS,
  lineOf: noLines,
  ...over,
});

const entry = (n: number, state: CycleEntryWire["state"], over: Partial<CycleEntryWire> = {}): CycleEntryWire => ({
  n,
  brief: `briefs/${n}.md`,
  waits: [],
  added: "2026-11-20T10:00:00Z",
  state,
  ...over,
});

const cycle = (entries: CycleEntryWire[], over: Partial<CycleWire> = {}): CycleWire => ({
  ...GOLDEN,
  id: "0000beef",
  name: "Small",
  entries,
  sketches: [],
  landed: entries.filter((e) => e.state === "joined").length,
  ...over,
});

describe("which cycle a card shows", () => {
  const other = cycle([entry(1, "ready")], { id: "0000aaaa" });

  test("the bound arc's cycle comes first, wherever it is in the frame", () => {
    expect(chooseCycle([other, GOLDEN], [other, GOLDEN], OWNER)).toBe(GOLDEN);
    // And it need not be among the session's own.
    expect(chooseCycle([other, GOLDEN], [other], OWNER)).toBe(GOLDEN);
  });

  test("a bound arc no cycle holds shows no cycle", () => {
    expect(chooseCycle([other, GOLDEN], [other, GOLDEN], "tugarc/alone#1")).toBeNull();
  });

  test("with no bound arc, the session's most recently changed cycle", () => {
    expect(chooseCycle([GOLDEN, other], [other, GOLDEN], null)).toBe(other);
    expect(chooseCycle([GOLDEN, other], [], null)).toBeNull();
  });
});

describe("the body's form", () => {
  // A cycle of one once drew the arc shade's three panels. It now draws the
  // cycle body like any other cycle: the user asked for one design for every
  // cycle, reversing [B11] of briefs/cycle-rollout-brief.md on this point.
  // An arc no cycle holds is drawn as the stand-in cycle of one, so the
  // three panels are gone from the application.
  test("any cycle with an entry draws the cycle body, and nothing draws the hint", () => {
    expect(cycleShadeForm(GOLDEN)).toBe("several");
    expect(cycleShadeForm(cycle([entry(1, "ready")]))).toBe("several");
    expect(cycleShadeForm(standInCycle(BOUND))).toBe("several");
    expect(cycleShadeForm(null)).toBe("none");
    expect(cycleShadeForm(cycle([]))).toBe("none");
  });
});

describe("the stand-in cycle of one", () => {
  test("an arc with a sketch and a brief reads A to 1, named by the brief's title", () => {
    const c = standInCycle(BOUND);
    expect(c.name).toBe("Fix the join");
    expect(c.id).toBe(`arc:${OWNER}`);
    expect(c.landed).toBe(0);
    expect(c.sketches?.map((s) => s.letter)).toEqual(["A"]);
    expect(c.sketches?.[0]?.want).toBe("Join should keep the branch.");
    expect(c.sketches?.[0]?.text).toBe(BOUND.documents?.sketch_text);
    expect(c.entries).toHaveLength(1);
    const only = c.entries[0]!;
    expect(only).toMatchObject({
      n: 1,
      brief: ".tug/arcs/fix-join/brief.md",
      brief_path: "/u/proj/.tug/arcs/fix-join/brief.md",
      brief_title: "Fix the join",
      arc: { name: "fix-join" },
      waits: [],
      from: ["A"],
      state: "running",
      owner_id: OWNER,
      bound_session: WRITER,
    });
    expect(cycleAssetKeys(c)).toEqual([sketchKey("A"), entryKey(1)]);
  });

  test("it reads as running here, with its steps from the arc row", () => {
    const [read] = cycleShadeEntries(standInCycle(BOUND), ctx());
    expect(read?.where).toBe("here");
    expect(read?.headline).toBe("Fix the join");
    expect(read?.row?.owner_id).toBe(OWNER);
  });

  test("with no sketch it is the tile alone, and with no title its file name heads it", () => {
    const bare = standInCycle({ ...BOUND, documents: { brief: "/u/proj/.tug/arcs/fix-join/brief.md" } });
    expect(bare.sketches).toEqual([]);
    expect(bare.entries[0]?.from).toEqual([]);
    expect(bare.name).toBe("brief.md");
    expect(cycleAssetKeys(bare)).toEqual([entryKey(1)]);
    const none = standInCycle({ ...BOUND, documents: undefined });
    expect(none.entries[0]?.brief).toBe("brief.md");
    expect(none.entries[0]?.brief_path).toBeUndefined();
    expect(none.name).toBe("brief.md");
  });
});

describe("here and elsewhere", () => {
  const running = GOLDEN.entries[1]!;

  test("the bound arc's entry is here, whatever segment the frame names", () => {
    expect(cycleEntryWhere(running, ctx({ sessionId: "sess-rotated" }))).toBe("here");
  });

  test("an entry bound to this session's segment is here", () => {
    expect(cycleEntryWhere(running, ctx({ boundOwnerId: null }))).toBe("here");
  });

  test("an entry bound to a sibling segment is here through the line", () => {
    const lineOf = (id: string): string | null => (id === WRITER || id === "sess-sibling" ? "line-1" : null);
    expect(cycleEntryWhere(running, ctx({ sessionId: "sess-sibling", boundOwnerId: null, lineOf }))).toBe("here");
    expect(sameSession("sess-sibling", WRITER, lineOf)).toBe(true);
    expect(sameSession("sess-sibling", STRANGER, lineOf)).toBe(false);
    // A segment whose line is the other id itself.
    expect(sameSession("line-1", WRITER, lineOf)).toBe(true);
  });

  test("an entry bound to another session is elsewhere", () => {
    expect(cycleEntryWhere(running, ctx({ sessionId: STRANGER, boundOwnerId: null }))).toBe("elsewhere");
    expect(cycleEntryWhere(running, ctx({ sessionId: null, boundOwnerId: null }))).toBe("elsewhere");
  });

  test("a running entry bound to nobody is running with no one to name", () => {
    const { bound_session: _s, bound_callsign: _c, ...unbound } = running;
    expect(cycleEntryWhere(unbound, ctx({ sessionId: STRANGER, boundOwnerId: null }))).toBe("unbound");
    const [read] = cycleShadeEntries(cycle([unbound]), ctx({ sessionId: STRANGER, boundOwnerId: null }));
    expect(read!.sentence).toBe("Running");
    expect(cycleMapTiles([read!])[0]!.elsewhere).toBeUndefined();
  });

  test("an entry that is not running is nowhere", () => {
    expect(cycleEntryWhere(GOLDEN.entries[0]!, ctx())).toBeNull();
  });
});

describe("entries and tiles", () => {
  test("each entry's sentence says how it stands", () => {
    const here = cycleShadeEntries(GOLDEN, ctx());
    expect(here.map((e) => e.sentence)).toEqual([
      "Joined",
      "Running in this session",
      "after the release",
      "Waits on 2, 3",
    ]);
    const away = cycleShadeEntries(GOLDEN, ctx({ sessionId: STRANGER, boundOwnerId: null }));
    expect(away[1]!.sentence).toBe("Running in another session");
    // A met wait is not named: entry 3 waits on 1, which has joined.
    expect(here[2]!.openWaits).toEqual([]);
    expect(here[3]!.openWaits).toEqual([2, 3]);
  });

  test("a ready entry with no note is ready to start, and entries read in number order", () => {
    const read = cycleShadeEntries(cycle([entry(2, "waiting", { waits: [1] }), entry(1, "ready")]), ctx());
    expect(read.map((e) => e.key)).toEqual([entryKey(1), entryKey(2)]);
    expect(read.map((e) => e.sentence)).toEqual(["Ready to start", "Waits on 1"]);
  });

  test("tiles carry state, waits and sketches, and mark elsewhere only", () => {
    const here = cycleMapTiles(cycleShadeEntries(GOLDEN, ctx()));
    expect(here.map((t) => t.state)).toEqual(["joined", "running", "ready", "waiting"]);
    expect(here[0]!.from).toEqual(["A"]);
    expect(here[1]!.from).toEqual([]);
    expect(here[3]!.waits).toEqual([2, 3]);
    expect(here.some((t) => t.elsewhere === true)).toBe(false);
    const away = cycleMapTiles(cycleShadeEntries(GOLDEN, ctx({ sessionId: STRANGER, boundOwnerId: null })));
    expect(away.map((t) => t.elsewhere)).toEqual([undefined, true, undefined, undefined]);
  });

  test("an entry is headed by its brief's title, else its file, and a tile names it before its sentence", () => {
    const titled = cycle([
      entry(1, "running", { brief_title: "The tooled style keeps one look" }),
      entry(2, "ready"),
    ]);
    const entries = cycleShadeEntries(titled, ctx({ boundOwnerId: null }));
    expect(entries.map((e) => e.headline)).toEqual(["The tooled style keeps one look", "2.md"]);
    expect(cycleMapTiles(entries).map((t) => t.label)).toEqual([
      `The tooled style keeps one look · ${entries[0]!.sentence}`,
      "2.md · Ready to start",
    ]);
  });

  test("a running entry's steps are its arc row's, found by owner key", () => {
    // The golden's row declares no steps, so the tile draws no pips.
    const bare = cycleShadeEntries(GOLDEN, ctx());
    expect(bare[1]!.row?.owner_id).toBe(OWNER);
    expect(bare[1]!.steps).toBeNull();
    expect(cycleMapTiles(bare)[1]!.steps).toBeUndefined();

    const row: ArcChangesetEntry = {
      ...(ROWS.get(OWNER) as ArcChangesetEntry),
      steps: [
        { title: "one", status: "done" },
        { title: "two", status: "withdrawn" },
        { title: "three", status: "in progress" },
        { title: "four", status: "pending" },
      ],
    };
    const stepped = cycleShadeEntries(GOLDEN, ctx({ arcRows: new Map([[OWNER, row]]) }));
    expect(stepped[1]!.steps).toEqual({ done: 2, total: 4 });
    expect(cycleMapTiles(stepped)[1]!.steps).toEqual({ done: 2, total: 4 });
    // Only a running entry reads a row.
    expect(stepped[0]!.row).toBeNull();
    // A running entry whose row is not in the frame has no steps.
    expect(cycleShadeEntries(GOLDEN, ctx({ arcRows: new Map() }))[1]!.steps).toBeNull();
  });

  test("a seal's want is the sketch's, or its letter when the sketch was not read", () => {
    expect(cycleMapSketches(GOLDEN)).toEqual([
      { letter: "A", want: "See every arc of a cycle from the session working one of them." },
    ]);
    const unread = cycle([], { sketches: [{ letter: "B", id: "0a0a0a0a", added: "2026-11-20T10:00:00Z" }] });
    expect(cycleMapSketches(unread)).toEqual([{ letter: "B", want: "Sketch B" }]);
  });
});

describe("the asset list", () => {
  const sketches = ["A", "B", "C"].map((letter) => ({ letter, id: "0a0a0a0a", added: "2026-11-20T10:00:00Z" }));
  const three = cycle(
    [entry(1, "joined", { from: ["A"] }), entry(2, "ready", { from: ["A", "B"] }), entry(3, "waiting", { waits: [2] })],
    { sketches },
  );
  const keys = cycleAssetKeys(three);

  test("each sketch sits before the first entry that came from it, the rest last", () => {
    expect(keys).toEqual([sketchKey("A"), entryKey(1), sketchKey("B"), entryKey(2), entryKey(3), sketchKey("C")]);
    expect(cycleAssetKeys(GOLDEN)).toEqual([sketchKey("A"), entryKey(1), entryKey(2), entryKey(3), entryKey(4)]);
  });

  test("no selection shows the whole list and brings nothing to the top", () => {
    expect(cycleListView(keys, NO_PICKS)).toEqual({ shown: keys, narrowed: false, top: null });
  });

  test("one selected shows the whole list and brings that asset to the top", () => {
    const one = pickOnMap(NO_PICKS, entryKey(2), false);
    expect(cycleListView(keys, one)).toEqual({ shown: keys, narrowed: false, top: entryKey(2) });
  });

  test("a shift-press narrows the list to the selected, in list order", () => {
    const two = pickOnMap(pickOnMap(NO_PICKS, entryKey(3), false), sketchKey("A"), true);
    expect(cycleListView(keys, two)).toEqual({ shown: [sketchKey("A"), entryKey(3)], narrowed: true, top: null });
    // Shift-pressing one of them again leaves one, and the list is whole.
    const back = pickOnMap(two, sketchKey("A"), true);
    expect(cycleListView(keys, back)).toEqual({ shown: keys, narrowed: false, top: entryKey(3) });
  });

  test("every asset starts closed; a press opens one alone and a second press closes it", () => {
    expect(NO_PICKS.size, "nothing is open before a press").toBe(0);
    const one = pressCycleAsset(NO_PICKS, entryKey(2), false);
    expect([...one]).toEqual([entryKey(2)]);
    // A press on another asset opens that one alone.
    expect([...pressCycleAsset(one, sketchKey("A"), false)]).toEqual([sketchKey("A")]);
    // A second press on the open asset closes it, by its mark or its row.
    expect(pressCycleAsset(one, entryKey(2), false).size).toBe(0);
    expect(pressCycleRow(one, entryKey(2)).size).toBe(0);
    expect([...pressCycleRow(NO_PICKS, entryKey(3))]).toEqual([entryKey(3)]);
    // The map's ground closes everything.
    expect(pressCycleAsset(one, null, false).size).toBe(0);
  });

  test("a shift-press adds or removes one, and a row in a narrowed list keeps the selection", () => {
    const two = pressCycleAsset(pressCycleAsset(NO_PICKS, entryKey(2), false), entryKey(3), true);
    expect([...two].sort()).toEqual([entryKey(2), entryKey(3)].sort());
    expect(pressCycleRow(two, entryKey(2))).toBe(two);
    expect([...pressCycleAsset(two, entryKey(3), true)]).toEqual([entryKey(2)]);
    // A plain press on one of several opens that one alone.
    expect([...pressCycleAsset(two, entryKey(3), false)]).toEqual([entryKey(3)]);
  });

  test("an asset is brought into view by the least scroll, never to the top for its own sake", () => {
    // A list 200 tall, scrolled to 100: it shows 100 to 300.
    expect(cycleRevealTop(100, 200, 150, 50), "already in view: the list stays").toBe(100);
    expect(cycleRevealTop(100, 200, 40, 30), "above the view: its top is brought to the top").toBe(40);
    expect(cycleRevealTop(100, 200, 280, 60), "below: brought up until its bottom shows").toBe(140);
    expect(cycleRevealTop(100, 200, 280, 400), "taller than the view: its top shows").toBe(280);
    // A list that does not scroll at all shows everything, so nothing moves.
    expect(cycleRevealTop(0, 500, 300, 120)).toBe(0);
  });

  test("a height set by the grip stays between the floor and the four-fifths cap, kept per card", () => {
    expect(clampCycleShadeFrac(0.5)).toBe(0.5);
    expect(clampCycleShadeFrac(0.95), "the top fifth always shows").toBe(0.8);
    expect(clampCycleShadeFrac(0.05), "room for the header, the map and the footer").toBe(0.25);
    expect(cycleShadeHeightKey("A")).not.toBe(cycleShadeHeightKey("B"));
  });

  test("a selected key the cycle no longer holds is ignored", () => {
    const stale = new Set([entryKey(9), entryKey(1)]);
    expect(cycleListView(keys, stale)).toEqual({ shown: keys, narrowed: false, top: entryKey(1) });
  });
});

describe("the header and the footer", () => {
  const summaryOf = (c: CycleWire, over: Partial<CycleShadeContext> = {}) =>
    cycleShadeSummary(c, cycleShadeEntries(c, ctx({ boundOwnerId: null, sessionId: STRANGER, ...over })));

  test("a dropped entry is in the total, never landed, and waits on nothing", () => {
    const given = cycle([entry(1, "joined"), entry(2, "dropped", { waits: [1] }), entry(3, "ready")]);
    const s = summaryOf(given);
    expect(s.landedText).toBe("1 of 3 landed");
    expect(s.atRest).toBe(false);
    const entries = cycleShadeEntries(given, ctx({ boundOwnerId: null, sessionId: STRANGER }));
    expect(entries[1]!.sentence).toBe("Dropped");
    expect(cycleMapTiles(entries).map((t) => t.state)).toEqual(["joined", "dropped", "ready"]);
  });

  test("at the start: nothing landed, nothing here, the first ready entry next", () => {
    const start = cycle([entry(1, "ready"), entry(2, "ready"), entry(3, "waiting", { waits: [1] })]);
    const s = summaryOf(start);
    expect(s.name).toBe("Small");
    expect(s.landedText).toBe("0 of 3 landed");
    expect(s.atRest).toBe(false);
    expect(s.now).toEqual({ kind: "text", text: "No arc in this session" });
    expect(s.elsewhere).toBe(0);
    expect(s.next.kind).toBe("entry");
    if (s.next.kind === "entry") {
      expect(s.next.entry.entry.n).toBe(1);
      expect(s.next.note).toBeNull();
      expect(s.next.more).toBe(1);
    }
  });

  test("midway, in the running session: its entry now, the noted ready entry next", () => {
    const s = cycleShadeSummary(GOLDEN, cycleShadeEntries(GOLDEN, ctx()));
    expect(s.landedText).toBe("1 of 4 landed");
    expect(s.now.kind).toBe("entry");
    if (s.now.kind === "entry") expect(s.now.entry.entry.n).toBe(2);
    expect(s.elsewhere).toBe(0);
    expect(s.next.kind).toBe("entry");
    if (s.next.kind === "entry") {
      expect(s.next.entry.entry.n).toBe(3);
      expect(s.next.note).toBe("after the release");
      expect(s.next.more).toBe(0);
    }
  });

  test("midway, from another session: no arc here, one running elsewhere", () => {
    const s = summaryOf(GOLDEN);
    expect(s.now).toEqual({ kind: "text", text: "No arc in this session" });
    expect(s.elsewhere).toBe(1);
    // The footer names the session that work runs in, with its chip.
    expect(s.elsewhereSessions.map((x) => x.id)).toEqual([GOLDEN.entries[1]!.bound_session!]);
  });

  test("the footer names each other session once, in entry order", () => {
    const two = cycle([
      entry(1, "running", { owner_id: "tugarc/a#1", bound_session: "sess-a", bound_callsign: "able-ant" }),
      entry(2, "running", { owner_id: "tugarc/b#1", bound_session: "sess-b" }),
      entry(3, "running", { owner_id: "tugarc/c#1", bound_session: "sess-a", bound_callsign: "able-ant" }),
    ]);
    const s = summaryOf(two);
    expect(s.elsewhere).toBe(3);
    expect(s.elsewhereSessions).toEqual([
      { id: "sess-a", tag: "able-ant" },
      { id: "sess-b", tag: null },
    ]);
    expect(summaryOf(two, { sessionId: "sess-a", boundOwnerId: null }).elsewhereSessions).toEqual([
      { id: "sess-b", tag: null },
    ]);
  });

  test("midway with nothing ready: nothing until an arc lands", () => {
    const stuck = cycle([
      entry(1, "running", { owner_id: "tugarc/x#1", bound_session: WRITER }),
      entry(2, "waiting", { waits: [1] }),
    ]);
    expect(summaryOf(stuck).next).toEqual({ kind: "text", text: "Nothing is ready until an arc lands" });
  });

  test("at rest: everything landed, nothing waiting", () => {
    const rest = cycle([entry(1, "joined"), entry(2, "joined", { waits: [1] })]);
    const s = summaryOf(rest);
    expect(s.atRest).toBe(true);
    expect(s.now).toEqual({ kind: "text", text: "At rest, 2 of 2 landed" });
    expect(s.next).toEqual({ kind: "text", text: "Nothing waiting" });
  });

  test("at rest with one landed and one dropped: nothing is waiting on a landing", () => {
    const rest = cycle([entry(1, "joined"), entry(2, "dropped")]);
    const s = summaryOf(rest);
    expect(s.atRest).toBe(true);
    expect(s.now).toEqual({ kind: "text", text: "At rest, 1 of 2 landed" });
    expect(s.next).toEqual({ kind: "text", text: "Nothing waiting" });
  });
});

describe("the cell's reading", () => {
  test("a cycle reads landed over its entries and names the cycle", () => {
    expect(cycleCellReading(GOLDEN)).toEqual({
      text: "1/4",
      label: "cycle Arc hardening, 1 of 4 landed",
    });
  });

  test("a cycle of one reads 0/1 or 1/1 like any other", () => {
    expect(cycleCellReading(cycle([entry(1, "running")]))?.text).toBe("0/1");
    expect(cycleCellReading(cycle([entry(1, "joined")], { landed: 1 }))?.text).toBe("1/1");
  });

  test("no cycle has no cycle fraction, whatever the arc", () => {
    expect(cycleCellReading(null)).toBeNull();
  });
});
