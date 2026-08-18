/**
 * The session → dash projection, over the shared golden snapshot.
 *
 * What is worth pinning is the inversion itself (a dash lists its sessions;
 * every one of them must find its way back), the tie rule when a malformed
 * snapshot claims a session twice, and the memo's observable contract — same
 * snapshot, same map, so an aggregate beat costs one build rather than one
 * per reader.
 */

import { describe, expect, test } from "bun:test";

import golden from "@/__tests__/fixtures/workspaces-changeset-snapshot.golden.json";
import type {
  DashChangesetEntry,
  ProjectChangeset,
  WorkspacesChangesetSnapshot,
} from "@/lib/changeset-types";
import {
  buildDashSessionIndex,
  dashForSession,
  dashSessionIndex,
} from "../dash-session-index";

const DATA = golden as WorkspacesChangesetSnapshot;

const GOLDEN_PROJECT = DATA.projects[0]!;
const GOLDEN_DASH = DATA.projects
  .flatMap((project) => project.changesets)
  .find((entry): entry is DashChangesetEntry => entry.kind === "dash")!;

/** The golden project, with `changesets` replaced wholesale. */
function projectWith(entries: ProjectChangeset["changesets"]): ProjectChangeset {
  return { ...GOLDEN_PROJECT, changesets: entries };
}

describe("buildDashSessionIndex", () => {
  test("an empty snapshot yields an empty map", () => {
    expect(buildDashSessionIndex({ projects: [] }).size).toBe(0);
  });

  test("the golden dash's bound session finds its way back", () => {
    const bound = GOLDEN_DASH.bound_sessions!;
    expect(bound.length).toBeGreaterThan(0);
    const index = buildDashSessionIndex(DATA);
    const fact = index.get(bound[0]!)!;
    expect(fact.ownerId).toBe(GOLDEN_DASH.owner_id);
    expect(fact.name).toBe(GOLDEN_DASH.display_name);
    expect(fact.stage).toBe(GOLDEN_DASH.stage ?? null);
    expect(fact.projectDir).toBe(GOLDEN_PROJECT.project_dir);
  });

  test("two sessions on one dash share one fact object", () => {
    const shared: DashChangesetEntry = {
      ...GOLDEN_DASH,
      bound_sessions: ["sess-a", "sess-b"],
    };
    const index = buildDashSessionIndex({ projects: [projectWith([shared])] });
    expect(index.size).toBe(2);
    expect(index.get("sess-a")).toBe(index.get("sess-b")!);
  });

  test("a session claimed by two dashes takes the first in snapshot order", () => {
    const first: DashChangesetEntry = {
      ...GOLDEN_DASH,
      owner_id: "tugdash/first#1",
      display_name: "first",
      bound_sessions: ["sess-a"],
    };
    const second: DashChangesetEntry = {
      ...GOLDEN_DASH,
      owner_id: "tugdash/second#2",
      display_name: "second",
      bound_sessions: ["sess-a"],
    };
    const index = buildDashSessionIndex({
      projects: [projectWith([first, second])],
    });
    expect(index.get("sess-a")!.name).toBe("first");
  });

  test("an entry with no bound_sessions contributes nothing", () => {
    const unbound: DashChangesetEntry = { ...GOLDEN_DASH, bound_sessions: [] };
    const older: DashChangesetEntry = {
      ...GOLDEN_DASH,
      owner_id: "tugdash/older#2",
      bound_sessions: undefined,
    };
    expect(
      buildDashSessionIndex({ projects: [projectWith([unbound, older])] }).size,
    ).toBe(0);
  });

  test("session entries are never dashes, however many sessions they name", () => {
    const sessions = GOLDEN_PROJECT.changesets.filter(
      (entry) => entry.kind === "session",
    );
    expect(sessions.length).toBeGreaterThan(0);
    expect(buildDashSessionIndex({ projects: [projectWith(sessions)] }).size).toBe(0);
  });

  test("steps read only when both counters arrive", () => {
    const half: DashChangesetEntry = {
      ...GOLDEN_DASH,
      bound_sessions: ["sess-a"],
      step_current: 2,
    };
    expect(
      buildDashSessionIndex({ projects: [projectWith([half])] }).get("sess-a")!.steps,
    ).toBeNull();
    const both: DashChangesetEntry = { ...half, step_total: 5 };
    expect(
      buildDashSessionIndex({ projects: [projectWith([both])] }).get("sess-a")!.steps,
    ).toBe("step 2/5");
  });

  test("the step's title rides the fact, and absence reads as null", () => {
    const bare: DashChangesetEntry = {
      ...GOLDEN_DASH,
      bound_sessions: ["sess-a"],
    };
    delete bare.step_title;
    expect(
      buildDashSessionIndex({ projects: [projectWith([bare])] }).get("sess-a")!
        .stepTitle,
    ).toBeNull();
    const titled: DashChangesetEntry = {
      ...bare,
      step_current: 2,
      step_total: 5,
      step_title: "Wire the feed",
    };
    expect(
      buildDashSessionIndex({ projects: [projectWith([titled])] }).get("sess-a")!
        .stepTitle,
    ).toBe("Wire the feed");
  });
});

describe("dashSessionIndex", () => {
  test("the same snapshot yields the same map; a new snapshot a new one", () => {
    expect(dashSessionIndex(DATA)).toBe(dashSessionIndex(DATA));
    expect(dashSessionIndex({ ...DATA })).not.toBe(dashSessionIndex(DATA));
  });
});

describe("dashForSession", () => {
  test("answers null for an unbound session and for no session at all", () => {
    expect(dashForSession(DATA, "nobody-here")).toBeNull();
    expect(dashForSession(DATA, null)).toBeNull();
    expect(dashForSession(DATA, "")).toBeNull();
  });

  test("answers the dash for a bound session", () => {
    const bound = GOLDEN_DASH.bound_sessions![0]!;
    expect(dashForSession(DATA, bound)!.name).toBe(GOLDEN_DASH.display_name);
  });
});
