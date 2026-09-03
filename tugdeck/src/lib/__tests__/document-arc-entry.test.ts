/**
 * The branchless arc, in the two shapes the surfaces read.
 *
 * What is worth pinning is the line the module holds: the entry adapter fills
 * the required fields with what an arc with no branch honestly has and passes
 * the optional ones through only when the wire carried them, and the track
 * model reports the plan's real step counts without ever inventing the titles
 * the wire does not carry.
 */

import { describe, expect, test } from "bun:test";

import type { ArcRunState, DocumentArcEntry } from "@/lib/changeset-types";
import {
  documentArcAsEntry,
  documentArcTrackModel,
} from "../document-arc-entry";

function arc(over: Partial<DocumentArcEntry> = {}): DocumentArcEntry {
  return {
    owner_id: "tugarc/planning#1",
    display_name: "planning",
    documents: { brief: "/repo/.tug/arcs/planning/brief.md" },
    step_total: 0,
    steps_done: 0,
    steps_begun: 0,
    ...over,
  };
}

const WITH_PLAN = {
  brief: "/repo/.tug/arcs/planning/brief.md",
  plan: "/repo/.tug/arcs/planning/plan.md",
};

describe("documentArcAsEntry", () => {
  test("the required fields are what a branchless arc has", () => {
    const entry = documentArcAsEntry(arc());
    expect(entry.kind).toBe("arc");
    expect(entry.owner_id).toBe("tugarc/planning#1");
    expect(entry.display_name).toBe("planning");
    expect(entry.documents).toEqual({
      brief: "/repo/.tug/arcs/planning/brief.md",
    });
    expect(entry.base).toBe("");
    expect(entry.rounds).toBe(0);
    expect(entry.worktree).toBe("");
    expect(entry.worktree_dirty).toBe(false);
    expect(entry.files).toEqual([]);
  });

  test("absent optional fields stay absent rather than becoming empty ones", () => {
    const entry = documentArcAsEntry(arc());
    expect("review" in entry).toBe(false);
    expect("arc" in entry).toBe(false);
    expect("bound_sessions" in entry).toBe(false);
    expect(entry.steps).toBeUndefined();
    expect(entry.stage).toBeUndefined();
    expect(entry.last_activity).toBeUndefined();
  });

  test("review, arc, and bound sessions pass through when the wire carried them", () => {
    const run: ArcRunState = { stage: "devise" };
    const entry = documentArcAsEntry(
      arc({ review: "stale", arc: run, bound_sessions: ["sess-a"] }),
    );
    expect(entry.review).toBe("stale");
    expect(entry.arc).toEqual(run);
    expect(entry.bound_sessions).toEqual(["sess-a"]);
  });
});

describe("documentArcTrackModel", () => {
  test("a brief with no plan reads brief, with no steps to count", () => {
    const model = documentArcTrackModel(arc());
    expect(model.phase).toBe("brief");
    expect(model.steps).toBeNull();
    expect(model.direct).toBe(false);
  });

  test("a plan nobody has touched reads review", () => {
    const model = documentArcTrackModel(
      arc({
        documents: WITH_PLAN,
        step_total: 3,
        steps_done: 0,
        steps_begun: 0,
      }),
    );
    expect(model.phase).toBe("review");
    expect(model.steps).toEqual({
      total: 3,
      done: 0,
      current: null,
      withdrawn: new Set(),
      closed: new Set(),
    });
  });

  test("a begun plan reads implement, with the ledger's own counts", () => {
    const model = documentArcTrackModel(
      arc({
        documents: WITH_PLAN,
        step_total: 3,
        steps_done: 1,
        steps_begun: 2,
      }),
    );
    expect(model.phase).toBe("implement");
    expect(model.steps).toEqual({
      total: 3,
      done: 1,
      current: 2,
      withdrawn: new Set(),
      closed: new Set([1]),
    });
  });

  test("a first row in progress with nothing finished has begun", () => {
    const model = documentArcTrackModel(
      arc({
        documents: WITH_PLAN,
        step_total: 3,
        steps_done: 0,
        steps_begun: 1,
      }),
    );
    expect(model.phase).toBe("implement");
    expect(model.steps).toEqual({
      total: 3,
      done: 0,
      current: 1,
      withdrawn: new Set(),
      closed: new Set(),
    });
  });

  test("no row in progress leaves `current` null rather than guessing one", () => {
    const model = documentArcTrackModel(
      arc({
        documents: WITH_PLAN,
        step_total: 3,
        steps_done: 2,
        steps_begun: 2,
      }),
    );
    expect(model.steps).toEqual({
      total: 3,
      done: 2,
      current: null,
      withdrawn: new Set(),
      closed: new Set([1, 2]),
    });
  });

  test("the counter-fed surface can never place a withdrawn tick, and says so with an empty set", () => {
    // Deliberately blind rather than accidentally broken: this entry carries
    // counters and no per-row statuses, and `step_in` refuses a withdrawal on
    // an arc with no worktree, so no withdrawn row can reach here at all.
    const model = documentArcTrackModel(
      arc({
        documents: WITH_PLAN,
        step_total: 8,
        steps_done: 8,
        steps_begun: 8,
      }),
    );
    expect(model.steps?.withdrawn).toEqual(new Set());
    expect(model.steps?.done).toBe(8);
  });

  test("a plan with no rows counts none", () => {
    const model = documentArcTrackModel(
      arc({ documents: WITH_PLAN, step_total: 0 }),
    );
    expect(model.steps).toBeNull();
    expect(model.phase).toBe("review");
  });

  test("an open arc's stage outranks the counts", () => {
    const model = documentArcTrackModel(
      arc({
        documents: WITH_PLAN,
        arc: { stage: "review" },
        step_total: 3,
        steps_done: 1,
        steps_begun: 2,
      }),
    );
    expect(model.phase).toBe("review");
    expect(model.steps).toEqual({
      total: 3,
      done: 1,
      current: 2,
      withdrawn: new Set(),
      closed: new Set([1]),
    });
  });

  test("a stopped arc says so, in the stage it stopped in", () => {
    const model = documentArcTrackModel(
      arc({
        documents: WITH_PLAN,
        arc: {
          stage: "devise",
          stopped: "the plan lints red",
          stopped_stage: "devise",
        },
        step_total: 3,
        steps_done: 1,
        steps_begun: 2,
      }),
    );
    expect(model.phase).toBe("devise");
    expect(model.stopped).toBe("the plan lints red");
  });
});
