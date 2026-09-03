/**
 * The arc among an arc's metadata facts.
 *
 * One derivation feeds every surface that names an arc — the Arcs card Arcs row,
 * the Changes shade's collapsed arc row, the ARC placard — because all of
 * them read `arcMetaFacts`. So what the arc *says* is settled here, as a pure
 * function over a wire entry, rather than three times over three DOMs.
 *
 * The claims:
 *
 *   - a hand-driven arc says nothing about arcs, because there is nothing to
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

import { arcMetaFacts } from "@/lib/arc-meta-facts";
import type { ArcRunState, ArcChangesetEntry } from "@/lib/changeset-types";

function entry(arc?: ArcRunState): ArcChangesetEntry {
  return {
    kind: "arc",
    owner_id: "tugarc/foo#1",
    display_name: "foo",
    base: "main",
    rounds: 3,
    worktree: "/tmp/foo",
    worktree_dirty: false,
    files: [],
    ...(arc !== undefined ? { arc } : {}),
  };
}

const keys = (e: ArcChangesetEntry): string[] => arcMetaFacts(e).map((f) => f.key);

describe("the run on the arc metadata line", () => {
  test("an arc nobody has run says nothing about one", () => {
    expect(keys(entry())).toEqual([]);
  });

  test("a stopped arc leads, in danger tone, naming the stage it stopped in", () => {
    const facts = arcMetaFacts(
      entry({ stage: "implement", stopped: "lint failed", stopped_stage: "review" }),
    );
    expect(facts[0]?.key).toBe("arc-stopped");
    expect(facts[0]?.tone).toBe("danger");
    expect(facts[0]?.label).toBe("arc stopped · review");
    expect(facts[0]?.tooltip).toContain("lint failed");
    // The fact, and only the fact. The tooltip used to close by naming the
    // CLI verb; the resume is the Resume button on the stop's own receipt.
    expect(facts[0]?.tooltip).not.toContain("tugtool arc run");
  });

  test("it outranks a replay conflict — nothing else here is unattended", () => {
    const e = entry({ stage: "review", stopped: "lint failed" });
    e.replay_conflict_paths = ["src/a.ts"];
    e.base_overlap = ["src/b.ts"];
    expect(keys(e)[0]).toBe("arc-stopped");
  });

  test("a stop with no stage recorded still says it stopped", () => {
    const facts = arcMetaFacts(entry({ stopped: "the document vanished" }));
    expect(facts[0]?.label).toBe("arc stopped");
  });

  test("a running arc says so last and quietly", () => {
    const e = entry({ stage: "devise" });
    e.worktree_dirty = true;
    const facts = arcMetaFacts(e);
    const last = facts[facts.length - 1];
    expect(last?.key).toBe("arc");
    expect(last?.label).toBe("arc · devise");
    expect(last?.tone).toBe("subtle");
  });

  test("a running arc's latest note rides its tooltip", () => {
    const withNote = entry({
      stage: "implement",
      note: "compacted at 0.73 > 0.60",
    });
    withNote.worktree_dirty = true;
    const fact = arcMetaFacts(withNote).find((f) => f.key === "arc");
    expect(fact?.tooltip).toContain(
      "its implement stage is in flight.\nLatest: compacted at 0.73 > 0.60",
    );

    // An arc that has done nothing worth a note says only what it always said.
    const silent = entry({ stage: "implement" });
    silent.worktree_dirty = true;
    const quiet = arcMetaFacts(silent).find((f) => f.key === "arc");
    expect(quiet?.tooltip).not.toContain("Latest:");
  });

  test("a finished arc says nothing — the join offer speaks then", () => {
    expect(keys(entry({ stage: "implement", done: true }))).toEqual([]);
  });

  test("an arc before its first rotation has no stage to name, and names none", () => {
    expect(keys(entry({}))).toEqual([]);
  });
});

/**
 * The fit on the same line.
 *
 * Two push sites in one linear sequence rather than one push with a computed
 * index: a stale fit is a caution and sits with the cautions, a current one is
 * a quiet receipt and sits with the receipts. What is under test is that the
 * fact says the right thing, wears the right tone, sits in the right place,
 * and leaves every other fact exactly where it was.
 */
describe("the fit on the arc metadata line", () => {
  test("a current fit is a quiet receipt beside the other quiet receipts", () => {
    const e = entry();
    e.fit = { head: "3f0a1c9e2b7d4f6a", base: "91c4de70f2a3b5c7", current: true };
    const facts = arcMetaFacts(e);
    expect(facts.map((f) => f.key)).toEqual(["fit"]);
    expect(facts[0]?.label).toBe("fit verified");
    expect(facts[0]?.tone).toBe("subtle");
    expect(facts[0]?.tooltip).toContain("3f0a1c9e2");
    expect(facts[0]?.tooltip).toContain("91c4de70f");
    // It states; it never says a join is blocked.
    expect(facts[0]?.tooltip).not.toContain("block");
  });

  test("a stale fit is a caution, and sits with the cautions", () => {
    const e = entry();
    e.fit = { head: "3f0a1c9e2b7d4f6a", base: "91c4de70f2a3b5c7", current: false };
    e.base_overlap = ["src/b.ts"];
    e.worktree_dirty = true;
    const facts = arcMetaFacts(e);
    expect(facts.map((f) => f.key)).toEqual(["overlap", "fit", "uncommitted"]);
    expect(facts[1]?.label).toBe("fit unverified");
    expect(facts[1]?.tone).toBe("caution");
  });

  test("an arc nobody verified says nothing about the fit", () => {
    expect(keys(entry())).toEqual([]);
    const e = entry();
    e.worktree_dirty = true;
    expect(keys(e)).toEqual(["uncommitted"]);
  });

  test("unlike `replayed`, it carries no behind-the-base gate", () => {
    // Base motion is already inside `current`, so a fit fact says its piece
    // whatever `base_ahead` reads — where `replayed` correctly goes quiet.
    const e = entry();
    e.base_ahead = 4;
    e.last_replay = "onto abc123456: d->e";
    e.fit = { head: "3f0a1c9e2b7d4f6a", base: "91c4de70f2a3b5c7", current: false };
    const facts = arcMetaFacts(e);
    expect(facts.map((f) => f.key)).toEqual(["fit", "behind"]);
  });
});
