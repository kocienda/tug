/**
 * The arc on the shared dash metadata line.
 *
 * One derivation feeds three surfaces — the Lens Dashes row, the Changes
 * shade's collapsed dash row, and the Z2 placard — because all three render
 * `DashMetaLine`. So what the arc *says* is settled here, as a pure function
 * over a wire entry, rather than three times over three DOMs.
 *
 * The claims:
 *
 *   - a hand-driven dash says nothing about arcs, because there is nothing to
 *     say and a silent field is not an absent one;
 *   - a stopped arc leads the line, in danger tone, naming the stage it
 *     stopped in — the one fact here with no gesture whose absence explains it
 *     ([P11]);
 *   - a running arc says so last and quietly, because a stage in flight is the
 *     ordinary case;
 *   - a finished arc says nothing at all, because the join offer speaks then
 *     and a second voice would compete with it ([P12]).
 */

import { describe, test, expect } from "bun:test";

import { dashMetaFacts } from "@/components/tugways/dash-meta-line";
import type { DashArcState, DashChangesetEntry } from "@/lib/changeset-types";

function entry(arc?: DashArcState): DashChangesetEntry {
  return {
    kind: "dash",
    owner_id: "tugdash/foo#1",
    display_name: "foo",
    base: "main",
    rounds: 3,
    worktree: "/tmp/foo",
    worktree_dirty: false,
    files: [],
    ...(arc !== undefined ? { arc } : {}),
  };
}

const keys = (e: DashChangesetEntry): string[] => dashMetaFacts(e).map((f) => f.key);

describe("the arc on the dash metadata line", () => {
  test("a dash nobody ran an arc on says nothing about one", () => {
    expect(keys(entry())).toEqual([]);
  });

  test("a stopped arc leads, in danger tone, naming the stage it stopped in", () => {
    const facts = dashMetaFacts(
      entry({ stage: "implement", stopped: "lint failed", stopped_stage: "review" }),
    );
    expect(facts[0]?.key).toBe("arc-stopped");
    expect(facts[0]?.tone).toBe("danger");
    expect(facts[0]?.label).toBe("arc stopped · review");
    expect(facts[0]?.tooltip).toContain("lint failed");
    expect(facts[0]?.tooltip).toContain("tugutil dash run foo");
  });

  test("it outranks a replay conflict — nothing else here is unattended", () => {
    const e = entry({ stage: "review", stopped: "lint failed" });
    e.replay_conflict_paths = ["src/a.ts"];
    e.base_overlap = ["src/b.ts"];
    expect(keys(e)[0]).toBe("arc-stopped");
  });

  test("a stop with no stage recorded still says it stopped", () => {
    const facts = dashMetaFacts(entry({ stopped: "the document vanished" }));
    expect(facts[0]?.label).toBe("arc stopped");
  });

  test("a running arc says so last and quietly", () => {
    const e = entry({ stage: "devise" });
    e.worktree_dirty = true;
    const facts = dashMetaFacts(e);
    const last = facts[facts.length - 1];
    expect(last?.key).toBe("arc");
    expect(last?.label).toBe("arc · devise");
    expect(last?.tone).toBe("subtle");
  });

  test("a finished arc says nothing — the join offer speaks then", () => {
    expect(keys(entry({ stage: "implement", done: true }))).toEqual([]);
  });

  test("an arc before its first rotation has no stage to name, and names none", () => {
    expect(keys(entry({}))).toEqual([]);
  });
});
