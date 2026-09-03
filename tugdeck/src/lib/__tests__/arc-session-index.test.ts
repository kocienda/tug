/**
 * The session → arc projection, over the shared golden snapshot.
 *
 * What is worth pinning is the inversion itself (an arc lists its sessions;
 * every one of them must find its way back), the tie rule when a malformed
 * snapshot claims a session twice, and the memo's observable contract — same
 * snapshot, same map, so an aggregate beat costs one build rather than one
 * per reader.
 */

import { describe, expect, test } from "bun:test";

import golden from "@/__tests__/fixtures/workspaces-changeset-snapshot.golden.json";
import type {
  ArcChangesetEntry,
  DocumentArcEntry,
  ProjectChangeset,
  WorkspacesChangesetSnapshot,
} from "@/lib/changeset-types";
import {
  buildArcSessionIndex,
  arcForSession,
  arcSessionIndex,
} from "../arc-session-index";
import { cardSessionBindingStore } from "../card-session-binding-store";
import { sessionLineStore } from "../session-line-store";

const DATA = golden as WorkspacesChangesetSnapshot;

const GOLDEN_PROJECT = DATA.projects[0]!;
const GOLDEN_ARC = DATA.projects
  .flatMap((project) => project.changesets)
  .find((entry): entry is ArcChangesetEntry => entry.kind === "arc")!;

/** The golden project, with `changesets` replaced wholesale. */
function projectWith(entries: ProjectChangeset["changesets"]): ProjectChangeset {
  return { ...GOLDEN_PROJECT, changesets: entries };
}

describe("buildArcSessionIndex", () => {
  test("an empty snapshot yields an empty map", () => {
    expect(buildArcSessionIndex({ projects: [] }).size).toBe(0);
  });

  test("the golden arc's bound session finds its way back", () => {
    const bound = GOLDEN_ARC.bound_sessions!;
    expect(bound.length).toBeGreaterThan(0);
    const index = buildArcSessionIndex(DATA);
    const fact = index.get(bound[0]!)!;
    expect(fact.ownerId).toBe(GOLDEN_ARC.owner_id);
    expect(fact.name).toBe(GOLDEN_ARC.display_name);
    expect(fact.stage).toBe(GOLDEN_ARC.stage ?? null);
    expect(fact.projectDir).toBe(GOLDEN_PROJECT.project_dir);
  });

  test("two sessions on one arc share one fact object", () => {
    const shared: ArcChangesetEntry = {
      ...GOLDEN_ARC,
      bound_sessions: ["sess-a", "sess-b"],
    };
    const index = buildArcSessionIndex({ projects: [projectWith([shared])] });
    expect(index.size).toBe(2);
    expect(index.get("sess-a")).toBe(index.get("sess-b")!);
  });

  test("a session claimed by two arcs takes the first in snapshot order", () => {
    const first: ArcChangesetEntry = {
      ...GOLDEN_ARC,
      owner_id: "tugarc/first#1",
      display_name: "first",
      bound_sessions: ["sess-a"],
    };
    const second: ArcChangesetEntry = {
      ...GOLDEN_ARC,
      owner_id: "tugarc/second#2",
      display_name: "second",
      bound_sessions: ["sess-a"],
    };
    const index = buildArcSessionIndex({
      projects: [projectWith([first, second])],
    });
    expect(index.get("sess-a")!.name).toBe("first");
  });

  test("an entry with no bound_sessions contributes nothing", () => {
    const unbound: ArcChangesetEntry = { ...GOLDEN_ARC, bound_sessions: [] };
    const older: ArcChangesetEntry = {
      ...GOLDEN_ARC,
      owner_id: "tugarc/older#2",
      bound_sessions: undefined,
    };
    expect(
      buildArcSessionIndex({ projects: [projectWith([unbound, older])] }).size,
    ).toBe(0);
  });

  test("session entries are never arcs, however many sessions they name", () => {
    const sessions = GOLDEN_PROJECT.changesets.filter(
      (entry) => entry.kind === "session",
    );
    expect(sessions.length).toBeGreaterThan(0);
    expect(buildArcSessionIndex({ projects: [projectWith(sessions)] }).size).toBe(0);
  });

  test("the counters ride as raw numbers, each half independently", () => {
    const half: ArcChangesetEntry = {
      ...GOLDEN_ARC,
      bound_sessions: ["sess-a"],
      step_current: 2,
    };
    delete half.step_total;
    const halfFact = buildArcSessionIndex({
      projects: [projectWith([half])],
    }).get("sess-a")!;
    expect(halfFact.stepCurrent).toBe(2);
    expect(halfFact.stepTotal).toBeNull();

    const both: ArcChangesetEntry = { ...half, step_total: 5 };
    const bothFact = buildArcSessionIndex({
      projects: [projectWith([both])],
    }).get("sess-a")!;
    expect(bothFact.stepCurrent).toBe(2);
    expect(bothFact.stepTotal).toBe(5);
  });

  test("the run's counters ride beside the plan's, without replacing them", () => {
    // Step 6 of a ten-row plan, second of a three-step selection. Both pairs
    // reach the fact: the numerals will count the run, the ring the plan.
    const stepped: ArcChangesetEntry = {
      ...GOLDEN_ARC,
      bound_sessions: ["sess-a"],
      step_current: 6,
      step_total: 10,
      run_position: 2,
      run_length: 3,
    };
    const fact = buildArcSessionIndex({
      projects: [projectWith([stepped])],
    }).get("sess-a")!;
    expect(fact.stepCurrent).toBe(6);
    expect(fact.stepTotal).toBe(10);
    expect(fact.runPosition).toBe(2);
    expect(fact.runLength).toBe(3);

    // A sender that declared no run leaves the run half null rather than
    // guessing it from the plan's.
    const undeclared: ArcChangesetEntry = { ...stepped };
    delete undeclared.run_position;
    delete undeclared.run_length;
    const plain = buildArcSessionIndex({
      projects: [projectWith([undeclared])],
    }).get("sess-a")!;
    expect(plain.runPosition).toBeNull();
    expect(plain.runLength).toBeNull();
    expect(plain.stepCurrent).toBe(6);
  });

  test("plan presence rides the fact — it is what makes a missing step loud", () => {
    const planless: ArcChangesetEntry = {
      ...GOLDEN_ARC,
      bound_sessions: ["sess-a"],
    };
    delete planless.documents;
    expect(
      buildArcSessionIndex({ projects: [projectWith([planless])] }).get(
        "sess-a",
      )!.hasPlan,
    ).toBe(false);

    const planned: ArcChangesetEntry = {
      ...planless,
      documents: { plan: "/repo/.tug/arcs/some/plan.md" },
    };
    expect(
      buildArcSessionIndex({ projects: [projectWith([planned])] }).get(
        "sess-a",
      )!.hasPlan,
    ).toBe(true);
  });

  test("the step's title rides the fact, and absence reads as null", () => {
    const bare: ArcChangesetEntry = {
      ...GOLDEN_ARC,
      bound_sessions: ["sess-a"],
    };
    delete bare.step_title;
    expect(
      buildArcSessionIndex({ projects: [projectWith([bare])] }).get("sess-a")!
        .stepTitle,
    ).toBeNull();
    const titled: ArcChangesetEntry = {
      ...bare,
      step_current: 2,
      step_total: 5,
      step_title: "Wire the feed",
    };
    expect(
      buildArcSessionIndex({ projects: [projectWith([titled])] }).get("sess-a")!
        .stepTitle,
    ).toBe("Wire the feed");
  });
});

describe("arcSessionIndex", () => {
  test("the same snapshot yields the same map; a new snapshot a new one", () => {
    expect(arcSessionIndex(DATA)).toBe(arcSessionIndex(DATA));
    expect(arcSessionIndex({ ...DATA })).not.toBe(arcSessionIndex(DATA));
  });
});

describe("arcForSession", () => {
  test("answers null for an unbound session and for no session at all", () => {
    expect(arcForSession(DATA, "nobody-here")).toBeNull();
    expect(arcForSession(DATA, null)).toBeNull();
    expect(arcForSession(DATA, "")).toBeNull();
  });

  test("answers the arc for a bound session", () => {
    const bound = GOLDEN_ARC.bound_sessions![0]!;
    expect(arcForSession(DATA, bound)!.name).toBe(GOLDEN_ARC.display_name);
  });
});

describe("the documents-only half of an arc's life", () => {
  /** A branchless arc: documents on disk, no `tugarc/<name>` branch yet. */
  function documentArc(
    over: Partial<DocumentArcEntry> = {},
  ): DocumentArcEntry {
    return {
      owner_id: "tugarc/planning#1",
      display_name: "planning",
      documents: { brief: "/repo/.tug/arcs/planning/brief.md" },
      step_total: 0,
      steps_done: 0,
      steps_begun: 0,
      bound_sessions: ["sess-d"],
      ...over,
    };
  }

  test("a session bound before the branch exists still finds its arc", () => {
    const index = buildArcSessionIndex({
      projects: [
        {
          ...projectWith([]),
          document_arcs: [documentArc()],
        },
      ],
    });
    const fact = index.get("sess-d");
    expect(fact).toBeDefined();
    expect(fact!.name).toBe("planning");
    expect(fact!.entry.display_name).toBe("planning");
    expect(fact!.stage).toBeNull();
    expect(fact!.hasPlan).toBe(false);
    expect(fact!.stepTotal).toBe(0);
  });

  test("`hasPlan` and `stepTotal` are the plan's own, not invented", () => {
    const index = buildArcSessionIndex({
      projects: [
        {
          ...projectWith([]),
          document_arcs: [
            documentArc({
              documents: {
                brief: "/repo/.tug/arcs/planning/brief.md",
                plan: "/repo/.tug/arcs/planning/plan.md",
              },
              step_total: 3,
              steps_done: 1,
              steps_begun: 2,
            }),
          ],
        },
      ],
    });
    const fact = index.get("sess-d")!;
    expect(fact.hasPlan).toBe(true);
    expect(fact.stepTotal).toBe(3);
    // Plan-absolute run counters are positions within a declared run, which a
    // branchless arc has none of.
    expect(fact.stepCurrent).toBeNull();
    expect(fact.runPosition).toBeNull();
    expect(fact.runLength).toBeNull();
    expect(fact.stepTitle).toBeNull();
  });

  test("a document arc with no bound session claims nothing", () => {
    const index = buildArcSessionIndex({
      projects: [
        {
          ...projectWith([]),
          document_arcs: [documentArc({ bound_sessions: [] })],
        },
      ],
    });
    expect(index.size).toBe(0);
  });

  test("a live entry outranks a document entry claiming the same session", () => {
    const live: ArcChangesetEntry = {
      ...GOLDEN_ARC,
      display_name: "live-one",
      stage: "working",
      bound_sessions: ["sess-d"],
    };
    const index = buildArcSessionIndex({
      projects: [
        {
          ...projectWith([live]),
          document_arcs: [documentArc()],
        },
      ],
    });
    expect(index.get("sess-d")!.name).toBe("live-one");
  });
});

/**
 * **The seat walk** — asked of a segment, answered for the line.
 *
 * A rotation moves the binding onto the segment the wheel just minted
 * (`seat_line_binding`), so the aggregate names *that* one — while every
 * surface asking is still holding the id it was minted with: a card's spawn
 * address, a citation's cited id. The direct lookup answers those two only
 * while they are the same string, which is until the first rotation, and the
 * incident is what a blank masthead sigil and a blank Z2 ARC cell look like
 * when they are not ([D167]).
 *
 * Over the binding-store singleton, because the walk is segment → card → the
 * card's announced seat: a line's seat is inferred from whichever frame moved
 * it last, and a card's is stated.
 */
describe("arcForSession – over a rotation", () => {
  const ROOT = "dsi-root";
  const STAGE = "dsi-stage";
  const LINE = "dsi-line";
  const CARD = "dsi-card";

  function snapshotBinding(bound: string[]): WorkspacesChangesetSnapshot {
    return {
      projects: [
        projectWith([
          { ...GOLDEN_ARC, display_name: "rotating", bound_sessions: bound },
        ]),
      ],
    };
  }

  test("the pre-rotation id still finds the arc the fresh segment holds", () => {
    sessionLineStore.forgetSession(ROOT);
    sessionLineStore.forgetSession(STAGE);
    sessionLineStore.seat(ROOT, LINE);
    cardSessionBindingStore.setBinding(CARD, {
      tugSessionId: ROOT,
      lineId: LINE,
      workspaceKey: "/work/alpha",
      projectDir: "/work/alpha",
      sessionMode: "resume",
    });
    // The rotation: the ledger seated the line on a segment the aggregate now
    // names, the card was told, and the pre-rotation id is bound to nothing.
    sessionLineStore.seat(STAGE, LINE);
    cardSessionBindingStore.setSeatedSegment(CARD, STAGE, LINE);

    const snapshot = snapshotBinding([STAGE]);
    expect(arcForSession(snapshot, STAGE)!.name).toBe("rotating");
    expect(arcForSession(snapshot, ROOT)!.name).toBe("rotating");
    expect(arcForSession(snapshot, ROOT)).toBe(arcForSession(snapshot, STAGE)!);

    cardSessionBindingStore.clearBinding(CARD);
  });

  test("a segment no card holds, and a card on no arc, both answer null", () => {
    sessionLineStore.forgetSession(ROOT);
    sessionLineStore.forgetSession(STAGE);
    const snapshot = snapshotBinding([STAGE]);
    expect(arcForSession(snapshot, "dsi-stranger")).toBeNull();

    sessionLineStore.seat("dsi-other", "dsi-other-line");
    expect(arcForSession(snapshot, "dsi-other")).toBeNull();
    sessionLineStore.forgetSession("dsi-other");
  });
});
