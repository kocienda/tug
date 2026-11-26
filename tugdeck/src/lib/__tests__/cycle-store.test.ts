/**
 * The cycle projection, over the shared golden snapshot.
 *
 * Its three questions — every cycle, one by id, a session's cycles — and the
 * two rules behind the third: a session belongs to a cycle it wrote, is bound
 * on, or ran a stage of, and it is found by its line as well as by the segment
 * the frame names. Plus the memo's contract, and the frozen empties a reader
 * gets when the frame carries no cycles.
 */

import { describe, expect, test } from "bun:test";

import golden from "@/__tests__/fixtures/workspaces-changeset-snapshot.golden.json";
import {
  isWorkspacesChangesetSnapshot,
  type CycleWire,
  type WorkspacesChangesetSnapshot,
} from "@/lib/changeset-types";
import {
  buildCycleIndex,
  cycleById,
  cycleIndex,
  cyclesForSession,
} from "../cycle-store";
import { sessionLineStore } from "../session-line-store";

const DATA = golden as WorkspacesChangesetSnapshot;
const GOLDEN_CYCLE = DATA.projects[0]!.cycles![0]!;

/** The writer, who is also bound on the running entry. */
const WRITER = "sess-0197a2b4-c8d1-7e02-9f3a-b5c6d7e8f901";
/** The session that ran the running entry's earlier stage, and nothing else. */
const STAGE_ONLY = "sess-0197a2b4-aaaa-7e02-9f3a-b5c6d7e8f901";

const noLines = (): string | null => null;

describe("the golden frame", () => {
  test("passes the snapshot guard with its cycle, and without one", () => {
    expect(isWorkspacesChangesetSnapshot(golden)).toBe(true);
    const stripped = {
      ...DATA,
      projects: DATA.projects.map(({ cycles: _cycles, ...rest }) => rest),
    };
    expect(isWorkspacesChangesetSnapshot(stripped)).toBe(true);
  });

  test("a cycle entry in an unknown state fails the guard", () => {
    const bad = structuredClone(DATA);
    (bad.projects[0]!.cycles![0]!.entries[0] as { state: string }).state =
      "finished";
    expect(isWorkspacesChangesetSnapshot(bad)).toBe(false);
  });

  test("a sketch carries its text and want, and passes the guard with neither", () => {
    const sketch = GOLDEN_CYCLE.sketches![0]!;
    expect(sketch.text?.startsWith("# Sketch\n\n")).toBe(true);
    expect(sketch.want).toBe(
      "See every arc of a cycle from the session working one of them.",
    );
    expect(sketch.text).toContain(sketch.want!);

    // A sketch the server could not read travels as its letter and id alone.
    const bare = structuredClone(DATA);
    const { text: _text, want: _want, ...rest } = bare.projects[0]!.cycles![0]!
      .sketches![0]!;
    bare.projects[0]!.cycles![0]!.sketches = [rest];
    expect(isWorkspacesChangesetSnapshot(bare)).toBe(true);

    const bad = structuredClone(DATA);
    (bad.projects[0]!.cycles![0]!.sketches![0] as { text: unknown }).text = 7;
    expect(isWorkspacesChangesetSnapshot(bad)).toBe(false);
  });
});

describe("buildCycleIndex", () => {
  test("lists every cycle in frame order and finds each by id", () => {
    const second: CycleWire = { ...GOLDEN_CYCLE, id: "0000beef", entries: [] };
    const snapshot: WorkspacesChangesetSnapshot = {
      ...DATA,
      projects: [DATA.projects[0]!, { ...DATA.projects[1]!, cycles: [second] }],
    };
    const index = buildCycleIndex(snapshot, noLines);
    expect(index.all.map((c) => c.id)).toEqual(["3f9a1c2e", "0000beef"]);
    expect(index.byId.get("0000beef")).toBe(second);
  });

  test("files a cycle under its writer, its bound session and its stage sessions, once each", () => {
    const index = buildCycleIndex(DATA, noLines);
    // The writer is also bound on the running entry and ran its stage, and is
    // still filed once.
    expect(index.bySession.get(WRITER)).toEqual([GOLDEN_CYCLE]);
    expect(index.bySession.get(STAGE_ONLY)).toEqual([GOLDEN_CYCLE]);
    expect(index.bySession.get("sess-nobody")).toBeUndefined();
  });

  test("files each session under its line as well", () => {
    const lineOf = (id: string): string | null =>
      id === STAGE_ONLY ? "line-of-stage" : null;
    const index = buildCycleIndex(DATA, lineOf);
    expect(index.bySession.get("line-of-stage")).toEqual([GOLDEN_CYCLE]);
  });

  test("a frame with no cycles answers with frozen empties", () => {
    const index = buildCycleIndex({ projects: [] }, noLines);
    expect(index.all).toEqual([]);
    expect(Object.isFrozen(index.all)).toBe(true);
    expect(index.byId.size).toBe(0);
  });
});

describe("the memoized readers", () => {
  test("one snapshot builds one index", () => {
    expect(cycleIndex(DATA)).toBe(cycleIndex(DATA));
  });

  test("cycleById answers the golden cycle and null for anything else", () => {
    expect(cycleById(DATA, "3f9a1c2e")).toBe(GOLDEN_CYCLE);
    expect(cycleById(DATA, "ffffffff")).toBeNull();
    expect(cycleById(DATA, null)).toBeNull();
  });

  test("cyclesForSession finds a sibling segment by its line", () => {
    const sibling = "sess-sibling-segment";
    const line = "line-cycle-store-test";
    sessionLineStore.seat(STAGE_ONLY, line);
    sessionLineStore.seat(sibling, line);
    try {
      expect(cyclesForSession(DATA, STAGE_ONLY)).toEqual([GOLDEN_CYCLE]);
      // The frame never names the sibling; its line does.
      expect(cyclesForSession(DATA, sibling)).toEqual([GOLDEN_CYCLE]);
    } finally {
      sessionLineStore.forgetSession(STAGE_ONLY);
      sessionLineStore.forgetSession(sibling);
    }
  });

  test("a session in no cycle, or no session, gets the same frozen empty", () => {
    const none = cyclesForSession(DATA, "sess-nobody");
    expect(none).toEqual([]);
    expect(Object.isFrozen(none)).toBe(true);
    expect(cyclesForSession(DATA, null)).toBe(none);
    expect(cyclesForSession({ projects: [] }, WRITER)).toBe(none);
  });
});
