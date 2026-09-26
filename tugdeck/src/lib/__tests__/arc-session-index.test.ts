/**
 * The session → arc projection, over the shared golden snapshot.
 *
 * What is worth pinning is the inversion itself (an arc names the session
 * holding it; that session must find its way back), the tie rule when a malformed
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
    const bound = GOLDEN_ARC.bound_session!;
    expect(bound).toBeDefined();
    const index = buildArcSessionIndex(DATA);
    const fact = index.get(bound)!;
    expect(fact.ownerId).toBe(GOLDEN_ARC.owner_id);
    expect(fact.name).toBe(GOLDEN_ARC.display_name);
    expect(fact.stage).toBe(GOLDEN_ARC.stage ?? null);
    expect(fact.projectDir).toBe(GOLDEN_PROJECT.project_dir);
  });

  test("a session claimed by two arcs takes the first in snapshot order", () => {
    const first: ArcChangesetEntry = {
      ...GOLDEN_ARC,
      owner_id: "tugarc/first#1",
      display_name: "first",
      bound_session: "sess-a",
    };
    const second: ArcChangesetEntry = {
      ...GOLDEN_ARC,
      owner_id: "tugarc/second#2",
      display_name: "second",
      bound_session: "sess-a",
    };
    const index = buildArcSessionIndex({
      projects: [projectWith([first, second])],
    });
    expect(index.get("sess-a")!.name).toBe("first");
  });

  test("an entry with no bound_session contributes nothing", () => {
    const unbound: ArcChangesetEntry = {
      ...GOLDEN_ARC,
      bound_session: undefined,
    };
    const older: ArcChangesetEntry = {
      ...GOLDEN_ARC,
      owner_id: "tugarc/older#2",
      bound_session: undefined,
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
      bound_session: "sess-a",
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
      bound_session: "sess-a",
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
      bound_session: "sess-a",
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
      bound_session: "sess-a",
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
    const bound = GOLDEN_ARC.bound_session!;
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
      bound_session: "sess-d",
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
    expect(fact!.boundSession).toBe("sess-d");
    expect(fact!.documents).toEqual({
      brief: "/repo/.tug/arcs/planning/brief.md",
    });
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

  test("the track counts the plan's steps — the two lists draw one strip", () => {
    // The regression this pins: the index used to store a documents-only arc
    // adapted into a branch entry, which carries no `steps` at all, so every
    // surface reading the fact drew a plan half walked as bare stage cells
    // while the Arcs card — reading the counters directly — drew the ticks.
    // One arc, two strips, no way for a reader to reconcile them.
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
              step_total: 6,
              steps_done: 2,
              steps_begun: 3,
            }),
          ],
        },
      ],
    });
    const fact = index.get("sess-d")!;
    expect(fact.track.steps).not.toBeNull();
    expect(fact.track.steps!.total).toBe(6);
    expect(fact.track.steps!.done).toBe(2);
    expect(fact.track.steps!.current).toBe(3);
    // A plan under way reads `implement`, not the `review` the stage ladder
    // falls to when it can see no steps.
    expect(fact.track.phase).toBe("implement");
  });

  test("a branchless arc has nothing in its way, and no titles to show", () => {
    const index = buildArcSessionIndex({
      projects: [
        {
          ...projectWith([]),
          document_arcs: [documentArc({ step_total: 4, steps_done: 1, steps_begun: 1 })],
        },
      ],
    });
    const fact = index.get("sess-d")!;
    // No base to diverge from, so no clause can apply — and the counters say
    // how far the plan got without claiming to know what any row is called.
    expect(fact.facts).toEqual([]);
    expect(fact.steps).toEqual([]);
  });

  test("a document arc with no bound session claims nothing", () => {
    const index = buildArcSessionIndex({
      projects: [
        {
          ...projectWith([]),
          document_arcs: [documentArc({ bound_session: undefined })],
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
      bound_session: "sess-d",
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

  function snapshotBinding(bound: string): WorkspacesChangesetSnapshot {
    return {
      projects: [
        projectWith([
          { ...GOLDEN_ARC, display_name: "rotating", bound_session: bound },
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

    const snapshot = snapshotBinding(STAGE);
    expect(arcForSession(snapshot, STAGE)!.name).toBe("rotating");
    expect(arcForSession(snapshot, ROOT)!.name).toBe("rotating");
    expect(arcForSession(snapshot, ROOT)).toBe(arcForSession(snapshot, STAGE)!);

    cardSessionBindingStore.clearBinding(CARD);
  });

  test("a segment no card holds, and a card on no arc, both answer null", () => {
    sessionLineStore.forgetSession(ROOT);
    sessionLineStore.forgetSession(STAGE);
    const snapshot = snapshotBinding(STAGE);
    expect(arcForSession(snapshot, "dsi-stranger")).toBeNull();

    sessionLineStore.seat("dsi-other", "dsi-other-line");
    expect(arcForSession(snapshot, "dsi-other")).toBeNull();
    sessionLineStore.forgetSession("dsi-other");
  });
});

/**
 * The line key ([B02]). The seat walk above needs a card binding to walk
 * through, and the failure this arc is about is precisely a lost seat: a
 * reconnect wipes the binding store, re-spawns under the address the bridge is
 * keyed by, and — before the ack carried the seat — nothing put the seat back.
 * The line is the answer the deck can still derive, because both segments'
 * pairs are on the line store from the row push and the ack.
 */
describe("arcForSession – the line key, when no seat is there to walk", () => {
  const ROOT = "line-key-root";
  const STAGE = "line-key-stage";
  const LINE = "line-key-line";

  function snapshotBinding(bound: string): WorkspacesChangesetSnapshot {
    return {
      projects: [
        projectWith([
          { ...GOLDEN_ARC, display_name: "line-keyed", bound_session: bound },
        ]),
      ],
    };
  }

  test("an address a rotation left behind still finds the arc", () => {
    sessionLineStore.forgetSession(ROOT);
    sessionLineStore.forgetSession(STAGE);
    // Both segments of the line are known, the line sits on the fresh one, and
    // no card holds a binding at all — the state a reconnect's `clearAll`
    // leaves behind.
    sessionLineStore.bind(ROOT, LINE);
    sessionLineStore.seat(STAGE, LINE);

    const snapshot = snapshotBinding(STAGE);
    expect(arcForSession(snapshot, ROOT)!.name).toBe("line-keyed");
    expect(arcForSession(snapshot, ROOT)).toBe(arcForSession(snapshot, STAGE)!);

    sessionLineStore.forgetSession(ROOT);
    sessionLineStore.forgetSession(STAGE);
  });

  test("a segment of another line is not answered for", () => {
    sessionLineStore.forgetSession(STAGE);
    sessionLineStore.seat(STAGE, LINE);
    sessionLineStore.seat("line-key-elsewhere", "line-key-other-line");

    expect(
      arcForSession(snapshotBinding(STAGE), "line-key-elsewhere"),
    ).toBeNull();

    sessionLineStore.forgetSession(STAGE);
    sessionLineStore.forgetSession("line-key-elsewhere");
  });

  test("the index files the fact under the line as well as the segment", () => {
    const index = buildArcSessionIndex(snapshotBinding(STAGE), (id) =>
      id === STAGE ? LINE : null,
    );
    expect(index.get(STAGE)!.name).toBe("line-keyed");
    expect(index.get(LINE)).toBe(index.get(STAGE)!);
  });

  test("a line whose segment the store has never heard of adds no key", () => {
    const index = buildArcSessionIndex(snapshotBinding(STAGE), () => null);
    expect(index.size).toBe(1);
    expect(index.get(STAGE)!.name).toBe("line-keyed");
  });

  test("the memo rebuilds when a line pair lands after the projection", () => {
    sessionLineStore.forgetSession(STAGE);
    const snapshot = snapshotBinding(STAGE);
    // Built before the deck learns the pair: the line key cannot be there.
    expect(arcSessionIndex(snapshot).has(LINE)).toBe(false);
    sessionLineStore.seat(STAGE, LINE);
    // The store's version moved, so the next read rebuilds rather than
    // handing back a map that is missing the key.
    expect(arcSessionIndex(snapshot).get(LINE)!.name).toBe("line-keyed");
    sessionLineStore.forgetSession(STAGE);
  });
});
