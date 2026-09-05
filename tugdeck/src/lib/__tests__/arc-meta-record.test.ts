/**
 * The four clauses that say what is in an arc's way.
 *
 * One derivation feeds every surface that names an arc — the Arcs card Arcs
 * row, the Changes shade's collapsed arc row, the ARC placard — because all of
 * them read `arcMetaFacts`. So what an arc *says* is settled here, as a pure
 * function over a wire entry, rather than three times over three DOMs.
 *
 * The claims:
 *
 *   - each clause is a sentence a person would say aloud, counted with its
 *     number agreeing with its verb, and `main` spelled as the entry spells it;
 *   - they rank loudest first — a conflict somebody has to resolve, then base
 *     dirt over the arc's own files, then a fit nobody has re-verified, then
 *     the quiet receipt that somebody has;
 *   - an arc with nothing in its way says nothing, and the arc's own state —
 *     what it is doing, where it stopped, which kind it is — is said by the
 *     phase clause and the strip, never here.
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

describe("the clauses", () => {
  test("an arc with nothing in its way says nothing", () => {
    expect(keys(entry())).toEqual([]);
  });

  test("a conflict leads, in danger, with its paths behind it", () => {
    const e = entry();
    e.replay_conflict_paths = ["src/a.ts", "src/b.ts"];
    const facts = arcMetaFacts(e);
    expect(facts.map((f) => f.key)).toEqual(["conflicts"]);
    expect(facts[0]?.label).toBe("2 files conflict with main");
    expect(facts[0]?.tone).toBe("danger");
    expect(facts[0]?.tooltip).toBe("Replaying onto main stops on:\nsrc/a.ts\nsrc/b.ts");
  });

  // The count agrees with its verb, which is the whole reason the clause is
  // composed rather than a label with a number in brackets after it.
  test("one conflicting file conflicts", () => {
    const e = entry();
    e.replay_conflict_paths = ["src/a.ts"];
    expect(arcMetaFacts(e)[0]?.label).toBe("1 file conflicts with main");
  });

  test("base dirt over the arc's own files is a caution", () => {
    const e = entry();
    e.base_overlap = ["src/b.ts"];
    const facts = arcMetaFacts(e);
    expect(facts.map((f) => f.key)).toEqual(["overlap"]);
    expect(facts[0]?.label).toBe("1 file also edited on main");
    expect(facts[0]?.tone).toBe("caution");
    expect(facts[0]?.tooltip).toBe(
      "Uncommitted work on main touches files this arc changes:\nsrc/b.ts",
    );
  });

  test("and three of them are three files", () => {
    const e = entry();
    e.base_overlap = ["a", "b", "c"];
    expect(arcMetaFacts(e)[0]?.label).toBe("3 files also edited on main");
  });

  // `main` is the entry's own base, spelled as it is: an arc off a release
  // branch says that branch's name, and nothing here knows a default.
  test("the base is spelled as the entry spells it", () => {
    const e = entry();
    e.base = "release/8.2";
    e.replay_conflict_paths = ["src/a.ts"];
    e.base_overlap = ["src/b.ts"];
    const facts = arcMetaFacts(e);
    expect(facts[0]?.label).toBe("1 file conflicts with release/8.2");
    expect(facts[1]?.label).toBe("1 file also edited on release/8.2");
  });

  test("a stale fit is a caution, and says which two shas moved apart", () => {
    const e = entry();
    e.fit = { head: "3f0a1c9e2b7d4f6a", base: "91c4de70f2a3b5c7", current: false };
    const facts = arcMetaFacts(e);
    expect(facts.map((f) => f.key)).toEqual(["fit"]);
    expect(facts[0]?.label).toBe("unverified");
    expect(facts[0]?.tone).toBe("caution");
    expect(facts[0]?.tooltip).toBe(
      "Verified at 3f0a1c9e2 onto 91c4de70f; one of those has moved since.",
    );
  });

  test("a current fit is the quiet receipt that somebody verified it", () => {
    const e = entry();
    e.fit = { head: "3f0a1c9e2b7d4f6a", base: "91c4de70f2a3b5c7", current: true };
    const facts = arcMetaFacts(e);
    expect(facts.map((f) => f.key)).toEqual(["fit"]);
    expect(facts[0]?.label).toBe("verified");
    expect(facts[0]?.tone).toBe("subtle");
    expect(facts[0]?.tooltip).toBe(
      "The tree a join would land was verified at 3f0a1c9e2 onto 91c4de70f.",
    );
    // It states; it never says a join is blocked.
    expect(facts[0]?.tooltip).not.toContain("block");
    // "Fit" is `tugtool arc verify`'s word and stays in the hover — never a
    // CLI line for the reader to retype.
    expect(facts[0]?.tooltip).not.toContain("tugtool");
  });

  test("an arc nobody verified says nothing about the fit", () => {
    expect(keys(entry())).toEqual([]);
  });

  test("they rank loudest first", () => {
    const e = entry();
    e.replay_conflict_paths = ["src/a.ts"];
    e.base_overlap = ["src/b.ts"];
    e.fit = { head: "3f0a1c9e2b7d4f6a", base: "91c4de70f2a3b5c7", current: false };
    expect(keys(e)).toEqual(["conflicts", "overlap", "fit"]);
  });
});

/**
 * The six that were deleted rather than filtered.
 *
 * No surface read them: the arc's own state is the phase clause's subject and
 * the strip's lit cell, and the checkout's bookkeeping — a dirty worktree, a
 * base that has moved, a replay that settled — reaches the eye where a
 * gesture turns on it (the picker, the Replay item's label, the discard
 * confirmation, the replay bulletin).
 */
describe("what is no longer derived", () => {
  test("a stopped arc says nothing here — the phase clause says Stopped", () => {
    expect(keys(entry({ stage: "implement", stopped: "lint", stopped_stage: "review" }))).toEqual(
      [],
    );
  });

  test("a running arc says nothing here — the strip says which stage", () => {
    expect(keys(entry({ stage: "devise", note: "compacted at 0.73 > 0.60" }))).toEqual([]);
  });

  test("a finished arc says nothing — the join offer speaks then", () => {
    expect(keys(entry({ stage: "implement", done: true }))).toEqual([]);
  });

  test("the kind says nothing — the strip's cell set draws it", () => {
    const e: ArcChangesetEntry = { ...entry(), arc_kind: "planned" };
    expect(keys(e)).toEqual([]);
  });

  test("a dirty worktree and a moved base say nothing", () => {
    const e = entry();
    e.worktree_dirty = true;
    e.base_ahead = 4;
    e.last_replay = "onto abc123456: d->e";
    expect(keys(e)).toEqual([]);
  });

  // Base motion is already inside `current`, so the fit says its piece
  // whatever `base_ahead` reads — and it is now the only thing that does.
  test("a stale fit carries no behind-the-base gate", () => {
    const e = entry();
    e.base_ahead = 4;
    e.last_replay = "onto abc123456: d->e";
    e.fit = { head: "3f0a1c9e2b7d4f6a", base: "91c4de70f2a3b5c7", current: false };
    expect(keys(e)).toEqual(["fit"]);
  });
});
