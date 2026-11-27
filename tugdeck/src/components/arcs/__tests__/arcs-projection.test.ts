/**
 * The Cycles & Arcs card's projection, over the shared golden snapshot.
 *
 * The golden frame holds one cycle of four entries, one in each state, with a
 * sketch; a live arc its running entry names; and two branchless arcs no
 * entry names. The rules pinned here: an arc is drawn once, a cycle of one is
 * a section like any other, every sketch has a row, and a frame with no
 * cycles projects exactly the rows the card drew before it knew of cycles.
 */

import { describe, expect, test } from "bun:test";

import golden from "@/__tests__/fixtures/workspaces-changeset-snapshot.golden.json";
import { entryKey, sketchKey } from "@/components/tugways/cycle-map-layout";
import type {
  ArcChangesetEntry,
  CycleEntryWire,
  CycleWire,
  WorkspacesChangesetSnapshot,
} from "@/lib/changeset-types";
import {
  arcRowsFromSnapshot,
  cycleChosen,
  cycleIsFolded,
  documentArcRowsFromSnapshot,
  foldCycle,
  listArcsCard,
  NO_CYCLE_VIEW,
  pressCycleMap,
  pressCycleRow,
  projectArcsCard,
  type CycleSection,
} from "../arcs-projection";

const DATA = golden as WorkspacesChangesetSnapshot;
const GOLDEN_CYCLE = DATA.projects[0]!.cycles![0]!;
/** The session bound on the golden cycle's running entry. */
const BOUND = "sess-0197a2b4-c8d1-7e02-9f3a-b5c6d7e8f901";
/** The owner key the running entry and the live arc row share. */
const RUNNING_KEY = "tugarc/fix-join#1723500000000-a1b2c3";

/** The golden frame with its first project's cycles replaced. */
function withCycles(cycles: CycleWire[]): WorkspacesChangesetSnapshot {
  return {
    ...DATA,
    projects: [{ ...DATA.projects[0]!, cycles }, ...DATA.projects.slice(1)],
  };
}

/** The golden cycle with its entries rewritten. */
function cycleWith(
  entries: CycleEntryWire[],
  rest: Partial<CycleWire> = {},
): CycleWire {
  return { ...GOLDEN_CYCLE, entries, ...rest };
}

function sectionOf(snapshot: WorkspacesChangesetSnapshot, followed: string | null = null): CycleSection {
  const item = projectArcsCard(snapshot, followed).cycles[0]!;
  if (item.kind !== "section") throw new Error("expected a section");
  return item;
}

describe("projectArcsCard — no cycles", () => {
  test("projects exactly the rows the card drew before cycles", () => {
    const bare = {
      ...DATA,
      projects: DATA.projects.map(({ cycles: _cycles, ...rest }) => rest),
    };
    const projection = projectArcsCard(bare, null);
    expect(projection.cycles).toEqual([]);
    expect(projection.arcs).toEqual(arcRowsFromSnapshot(bare));
    expect(projection.plans).toEqual(documentArcRowsFromSnapshot(bare));
    expect(projection.arcs.length).toBeGreaterThan(0);
    expect(projection.empty).toBe(false);
  });

  test("an empty frame is empty", () => {
    const projection = projectArcsCard({ projects: [] }, null);
    expect(projection).toEqual({ cycles: [], arcs: [], plans: [], empty: true });
  });
});

describe("projectArcsCard — an arc is drawn once", () => {
  test("a live arc a running entry names is in its cycle and not in the loose list", () => {
    const projection = projectArcsCard(DATA, null);
    expect(arcRowsFromSnapshot(DATA).map((r) => r.ownerId)).toContain(RUNNING_KEY);
    expect(projection.arcs.map((r) => r.ownerId)).not.toContain(RUNNING_KEY);

    const section = sectionOf(DATA);
    const running = section.assets.find((a) => a.key === entryKey(2));
    expect(running?.kind === "entry" && running.row.arc?.ownerId).toBe(RUNNING_KEY);
  });

  test("the loose arcs keep their order, less the one drawn", () => {
    const projection = projectArcsCard(DATA, null);
    expect(projection.arcs).toEqual(
      arcRowsFromSnapshot(DATA).filter((r) => r.ownerId !== RUNNING_KEY),
    );
    // No golden entry names a branchless arc, so every paperwork row stays.
    expect(projection.plans).toEqual(documentArcRowsFromSnapshot(DATA));
  });

  test("the match is on the owner key, never on the arc's name", () => {
    // The same name under another generation's key is another arc.
    const other = cycleWith(
      GOLDEN_CYCLE.entries.map((e) =>
        e.n === 2 ? { ...e, owner_id: "tugarc/fix-join#999-ffffff" } : e,
      ),
    );
    const projection = projectArcsCard(withCycles([other]), null);
    expect(projection.arcs.map((r) => r.ownerId)).toContain(RUNNING_KEY);
    const running = sectionOf(withCycles([other])).assets.find((a) => a.key === entryKey(2));
    expect(running?.kind === "entry" && running.row.arc).toBeNull();
  });

  test("a branchless arc a running entry names leaves the paperwork list", () => {
    const planKey = DATA.projects[0]!.document_arcs![0]!.owner_id;
    const cycle = cycleWith(
      GOLDEN_CYCLE.entries.map((e) =>
        e.n === 2 ? { ...e, owner_id: planKey } : e,
      ),
    );
    const snapshot = withCycles([cycle]);
    const projection = projectArcsCard(snapshot, null);
    expect(projection.plans.map((r) => r.entry.owner_id)).not.toContain(planKey);
    expect(projection.plans.length).toBe(documentArcRowsFromSnapshot(snapshot).length - 1);

    const running = sectionOf(snapshot).assets.find((a) => a.key === entryKey(2));
    if (running?.kind !== "entry") throw new Error("expected the entry");
    expect(running.row.plan?.entry.owner_id).toBe(planKey);
    // Its pips come from the paperwork's counters.
    expect(running.row.steps).toEqual({ done: 1, total: 5 });
  });

  test("a cycle carried by two projects is one section", () => {
    const twice: WorkspacesChangesetSnapshot = {
      ...DATA,
      projects: [
        DATA.projects[0]!,
        { ...DATA.projects[1]!, cycles: [GOLDEN_CYCLE] },
      ],
    };
    expect(projectArcsCard(twice, null).cycles.length).toBe(1);
  });
});

describe("projectArcsCard — a section", () => {
  test("carries the header text and the strip, and counts a dropped entry as not landed", () => {
    const section = sectionOf(DATA);
    expect(section.id).toBe("3f9a1c2e");
    expect(section.name).toBe("Arc hardening");
    expect(section.landedText).toBe("1 of 4 landed");
    expect(section.strip).toEqual(["joined", "running", "ready", "waiting"]);

    // An entry given up stays in its place, in the strip, on the map and in
    // the total, and is never one of the landed.
    const dropped = cycleWith(
      GOLDEN_CYCLE.entries.map((e) => (e.n === 3 ? { ...e, state: "dropped" as const } : e)),
    );
    const given = sectionOf(withCycles([dropped]));
    expect(given.landedText).toBe("1 of 4 landed");
    expect(given.strip).toEqual(["joined", "running", "dropped", "waiting"]);
    expect(given.tiles.map((t) => t.state)).toEqual(["joined", "running", "dropped", "waiting"]);
    const third = given.assets.find((a) => a.key === entryKey(3));
    expect(third?.kind === "entry" && third.row.sentence).toBe("Dropped");
  });

  test("lists the sketch before the entries that came from it, then every entry", () => {
    const section = sectionOf(DATA);
    expect(section.assets.map((a) => a.key)).toEqual([
      sketchKey("A"),
      entryKey(1),
      entryKey(2),
      entryKey(3),
      entryKey(4),
    ]);
    const sketch = section.assets[0]!;
    if (sketch.kind !== "sketch") throw new Error("expected the sketch");
    expect(sketch.sketch.entries).toEqual([1]);
    expect(sketch.sketch.want.length).toBeGreaterThan(0);
    expect(sketch.sketch.text.startsWith(sketch.sketch.want)).toBe(true);
    expect(section.sketches).toEqual([{ letter: "A", want: sketch.sketch.want }]);
  });

  test("a sketch no entry came from is listed after the entries", () => {
    const cycle = cycleWith(GOLDEN_CYCLE.entries, {
      sketches: [
        ...GOLDEN_CYCLE.sketches!,
        { letter: "B", id: "0b0b0b0b", added: "2026-11-22T10:00:00Z" },
      ],
    });
    const section = sectionOf(withCycles([cycle]));
    expect(section.assets.map((a) => a.key)).toEqual([
      sketchKey("A"),
      entryKey(1),
      entryKey(2),
      entryKey(3),
      entryKey(4),
      sketchKey("B"),
    ]);
    const last = section.assets[section.assets.length - 1]!;
    // The store holds no text for it: the row has a letter and no words.
    expect(last.kind === "sketch" && last.sketch).toMatchObject({
      letter: "B",
      want: "",
      text: "",
      entries: [],
    });
    expect(section.sketches.map((s) => s.letter)).toEqual(["A", "B"]);
  });

  test("a later sketch stands before the first entry that came from it", () => {
    const cycle = cycleWith(
      GOLDEN_CYCLE.entries.map((e) => (e.n === 3 ? { ...e, from: ["B", "A"] } : e)),
      {
        sketches: [
          ...GOLDEN_CYCLE.sketches!,
          { letter: "B", id: "0b0b0b0b", added: "2026-11-22T10:00:00Z" },
        ],
      },
    );
    expect(sectionOf(withCycles([cycle])).assets.map((a) => a.key)).toEqual([
      sketchKey("A"),
      entryKey(1),
      entryKey(2),
      sketchKey("B"),
      entryKey(3),
      entryKey(4),
    ]);
  });

  test("a letter an entry names that the cycle does not record still has a row and a seal", () => {
    const cycle = cycleWith(
      GOLDEN_CYCLE.entries.map((e) => (e.n === 4 ? { ...e, from: ["C"] } : e)),
    );
    const section = sectionOf(withCycles([cycle]));
    expect(section.sketches.map((s) => s.letter)).toEqual(["A", "C"]);
    expect(section.assets.map((a) => a.key)).toContain(sketchKey("C"));
  });
});

describe("projectArcsCard — rows and tiles", () => {
  test("a row is called by its brief's title, else its file, never its arc", () => {
    const rows = sectionOf(DATA).assets.flatMap((a) => (a.kind === "entry" ? [a.row] : []));
    // The first two carry arcs and are still headed by their briefs' titles.
    expect(rows.map((r) => r.title)).toEqual([
      "The arc cockpit",
      "Fix the join",
      "arc-hardening-brief.md",
      "arc-polish-brief.md",
    ]);
    const titled = cycleWith(
      GOLDEN_CYCLE.entries.map((e) =>
        e.n === 3 ? { ...e, brief_title: "Harden the arc" } : e,
      ),
    );
    const third = sectionOf(withCycles([titled])).assets.find((a) => a.key === entryKey(3));
    expect(third?.kind === "entry" && third.row.title).toBe("Harden the arc");
  });

  test("each tile names its entry, then says where it stands", () => {
    const tiles = sectionOf(DATA, BOUND).tiles;
    expect(tiles.map((t) => t.label)).toEqual([
      "The arc cockpit · Joined",
      "Fix the join · Running in this session",
      "arc-hardening-brief.md · after the release",
      "arc-polish-brief.md · Waits on 2, 3",
    ]);
    expect(tiles.map((t) => t.state)).toEqual(["joined", "running", "ready", "waiting"]);
    expect(tiles[0]!.from).toEqual(["A"]);
    expect(tiles[3]!.waits).toEqual([2, 3]);
  });

  test("a wait already joined is not one the sentence names", () => {
    const cycle = cycleWith(
      GOLDEN_CYCLE.entries.map((e) =>
        e.n === 4 ? { ...e, waits: [1, 3, 9] } : e,
      ),
    );
    const fourth = sectionOf(withCycles([cycle])).assets.find((a) => a.key === entryKey(4));
    if (fourth?.kind !== "entry") throw new Error("expected the entry");
    // 1 has joined, and 9 is not in the cycle.
    expect(fourth.row.openWaits).toEqual([3]);
    expect(fourth.row.sentence).toBe("Waits on 3");
  });

  test("a running tile is elsewhere only when a followed session is not its own", () => {
    const running = (followed: string | null) => sectionOf(DATA, followed).tiles[1]!;
    expect(running(BOUND).elsewhere).toBeUndefined();
    expect(running("sess-other").elsewhere).toBe(true);
    expect(running("sess-other").label).toBe("Fix the join · Running in another session");
    // With nothing followed, no tile draws the dot.
    expect(running(null).elsewhere).toBeUndefined();
    expect(sectionOf(DATA, "sess-other").tiles.filter((t) => t.elsewhere).length).toBe(1);
  });

  test("a running tile's pips are its arc row's ledger, withdrawn rows left out", () => {
    // The golden arc carries no ledger, so its tile draws no pips.
    expect(sectionOf(DATA).tiles[1]!.steps).toBeUndefined();

    const stepped: WorkspacesChangesetSnapshot = {
      ...DATA,
      projects: [
        {
          ...DATA.projects[0]!,
          changesets: DATA.projects[0]!.changesets.map((entry) =>
            entry.kind === "arc" && entry.owner_id === RUNNING_KEY
              ? ({
                  ...entry,
                  steps: [
                    { title: "One", status: "done" },
                    { title: "Two", status: "withdrawn" },
                    { title: "Three", status: "in progress" },
                    { title: "Four", status: "pending" },
                  ],
                } satisfies ArcChangesetEntry)
              : entry,
          ),
        },
        ...DATA.projects.slice(1),
      ],
    };
    const tiles = sectionOf(stepped).tiles;
    expect(tiles[1]!.steps).toEqual({ done: 1, total: 3 });
    // Only a running entry draws pips.
    expect(tiles.filter((t) => t.steps !== undefined).length).toBe(1);
  });
});

describe("projectArcsCard — a cycle of one", () => {
  test("is a section like any other: its name, its map and its sketch", () => {
    const solo = cycleWith([GOLDEN_CYCLE.entries[1]!]);
    const section = sectionOf(withCycles([solo]));
    expect(section.id).toBe(GOLDEN_CYCLE.id);
    expect(section.name).toBe(GOLDEN_CYCLE.name);
    expect(section.landedText).toBe("0 of 1 landed");
    expect(section.tiles.map((t) => t.n)).toEqual([GOLDEN_CYCLE.entries[1]!.n]);
    expect(section.sketches.length).toBe(GOLDEN_CYCLE.sketches?.length ?? 0);
    expect(section.assets.filter((a) => a.kind === "sketch").length).toBe(section.sketches.length);
    const entry = section.assets.find((a) => a.kind === "entry");
    expect(entry?.kind === "entry" && entry.row.title).toBe("Fix the join");
    expect(entry?.kind === "entry" && entry.row.arc?.ownerId).toBe(RUNNING_KEY);
    // Its arc is still drawn once.
    expect(
      projectArcsCard(withCycles([solo]), null).arcs.map((r) => r.ownerId),
    ).not.toContain(RUNNING_KEY);
  });

  test("a second entry makes it a cycle of two, in the same shape", () => {
    const two = cycleWith(GOLDEN_CYCLE.entries.slice(0, 2));
    expect(sectionOf(withCycles([two])).landedText).toBe("1 of 2 landed");
  });

  test("a cycle with no entry draws nothing", () => {
    const projection = projectArcsCard(withCycles([cycleWith([])]), null);
    expect(projection.cycles).toEqual([]);
  });

  test("cycles keep the frame's order", () => {
    const first = cycleWith([GOLDEN_CYCLE.entries[0]!], { id: "aaaaaaaa" });
    const projection = projectArcsCard(withCycles([first, GOLDEN_CYCLE]), null);
    expect(projection.cycles.map((c) => [c.kind, c.id])).toEqual([
      ["section", "aaaaaaaa"],
      ["section", "3f9a1c2e"],
    ]);
  });
});

describe("listArcsCard — the rows the arrows walk", () => {
  const projection = projectArcsCard(DATA, null);
  const section = sectionOf(DATA);
  const kinds = (view = NO_CYCLE_VIEW): string[] =>
    listArcsCard(projection, view).map((item) => item.kind);

  test("a cycle's pin leads its assets, then the loose arcs, then the paperwork", () => {
    const items = listArcsCard(projection, NO_CYCLE_VIEW);
    expect(items[0]!.kind).toBe("cycle-pin");
    expect(items.filter((i) => i.kind === "cycle-asset")).toHaveLength(section.assets.length);
    expect(items.filter((i) => i.kind === "arc")).toHaveLength(projection.arcs.length);
    expect(items.filter((i) => i.kind === "plan")).toHaveLength(projection.plans.length);
    // Kinds never interleave: the card's order is the list's order.
    const order = ["cycle-pin", "cycle-asset", "arc", "plan"];
    const ranks = kinds().map((k) => order.indexOf(k));
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  });

  test("every row has an id of its own, and an arc row keeps its bare owner key", () => {
    const items = listArcsCard(projection, NO_CYCLE_VIEW);
    expect(new Set(items.map((i) => i.id)).size).toBe(items.length);
    for (const item of items) {
      if (item.kind === "arc") expect(item.id).toBe(item.row.ownerId);
    }
  });

  test("with no cycles the list is the arcs and the paperwork, from index 0", () => {
    const bare = projectArcsCard(withCycles([]), null);
    const items = listArcsCard(bare, NO_CYCLE_VIEW);
    expect(items.map((i): string => i.kind)).toEqual([
      ...bare.arcs.map(() => "arc"),
      ...bare.plans.map(() => "plan"),
    ]);
  });

  test("a folded cycle lists its pin and no assets", () => {
    const view = foldCycle(NO_CYCLE_VIEW, section);
    expect(cycleIsFolded(view, section)).toBe(true);
    expect(kinds(view).filter((k) => k === "cycle-asset")).toEqual([]);
    expect(kinds(view)[0]).toBe("cycle-pin");
    // Flipping it again brings them back.
    expect(cycleIsFolded(foldCycle(view, section), section)).toBe(false);
  });

  test("every cycle starts open, and the reader's fold holds", () => {
    expect(cycleIsFolded(NO_CYCLE_VIEW, section)).toBe(false);
    expect(cycleIsFolded(foldCycle(NO_CYCLE_VIEW, section), section)).toBe(true);
  });

  test("a press on the map selects one asset and opens its row", () => {
    const key = entryKey(2);
    const view = pressCycleMap(NO_CYCLE_VIEW, section.id, key, false);
    const assets = listArcsCard(projection, view).filter((i) => i.kind === "cycle-asset");
    // One selected: every asset still shows, and only the selected one is open.
    expect(assets).toHaveLength(section.assets.length);
    expect(assets.filter((a) => a.open).map((a) => a.asset.key)).toEqual([key]);
  });

  test("two selected narrow the list to those two, both open", () => {
    let view = pressCycleMap(NO_CYCLE_VIEW, section.id, entryKey(1), false);
    view = pressCycleMap(view, section.id, entryKey(3), true);
    const assets = listArcsCard(projection, view).filter((i) => i.kind === "cycle-asset");
    expect(assets.map((a) => a.asset.key)).toEqual([entryKey(1), entryKey(3)]);
    expect(assets.every((a) => a.open)).toBe(true);
    // A shift-press on one of them takes it back out.
    view = pressCycleMap(view, section.id, entryKey(3), true);
    expect([...cycleChosen(view, section.id)]).toEqual([entryKey(1)]);
  });

  test("a press on the map's ground clears the selection", () => {
    const view = pressCycleMap(
      pressCycleMap(NO_CYCLE_VIEW, section.id, entryKey(1), false),
      section.id,
      null,
      false,
    );
    expect(cycleChosen(view, section.id).size).toBe(0);
    expect(view.chosen.size).toBe(0);
  });

  test("a press on a row selects it alone, and changes nothing while narrowed", () => {
    const one = pressCycleRow(NO_CYCLE_VIEW, section.id, sketchKey("A"));
    expect([...cycleChosen(one, section.id)]).toEqual([sketchKey("A")]);
    const moved = pressCycleRow(one, section.id, entryKey(2));
    expect([...cycleChosen(moved, section.id)]).toEqual([entryKey(2)]);
    const narrowed = pressCycleMap(moved, section.id, entryKey(3), true);
    expect(pressCycleRow(narrowed, section.id, entryKey(1))).toBe(narrowed);
  });

  test("each cycle holds its own selection", () => {
    const other = cycleWith(GOLDEN_CYCLE.entries, { id: "bbbbbbbb" });
    const two = projectArcsCard(withCycles([GOLDEN_CYCLE, other]), null);
    const view = pressCycleMap(NO_CYCLE_VIEW, "bbbbbbbb", entryKey(1), false);
    const open = listArcsCard(two, view).filter((i) => i.kind === "cycle-asset" && i.open);
    expect(open.map((i) => i.id)).toEqual([`cycle:bbbbbbbb:${entryKey(1)}`]);
  });

  test("a cycle of one lists its pin and its assets, and a press opens its entry", () => {
    const solo = withCycles([cycleWith([GOLDEN_CYCLE.entries[0]!])]);
    const soloProjection = projectArcsCard(solo, null);
    const id = GOLDEN_CYCLE.id;
    // A cycle at rest starts folded, as any cycle does; unfold it to list its assets.
    const unfolded = { ...NO_CYCLE_VIEW, folded: new Map([[id, false]]) };
    const rows = listArcsCard(soloProjection, unfolded);
    expect(rows[0]!.kind).toBe("cycle-pin");
    const key = entryKey(GOLDEN_CYCLE.entries[0]!.n);
    const opened = pressCycleRow(unfolded, id, key);
    const entry = listArcsCard(soloProjection, opened).find((i) => i.kind === "cycle-asset" && i.asset.key === key);
    expect(entry?.kind === "cycle-asset" && entry.open).toBe(true);
  });
});
