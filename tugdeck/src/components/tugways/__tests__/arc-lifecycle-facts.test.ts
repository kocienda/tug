/**
 * arc-lifecycle-facts.test.ts — the second half of the line's one clause.
 *
 * `arcMetaFacts` derives what is in an arc's way, ranked loudest first; the
 * line paints exactly one of them ([B03]), because two clauses at rail width
 * pushed the row off its edge. Nothing is lost by painting one: every
 * applicable clause's sentence stacks into the one clause's hover, and a
 * reader who sees red hovers it.
 *
 * Pure, so the rule is a table rather than a screenshot.
 */

import { describe, expect, test } from "bun:test";

import { arcTroubleClause } from "@/components/tugways/arc-lifecycle-line";
import { arcCellTip, arcReading, arcTrackModel } from "@/components/tugways/tug-arc-track";
import { arcMetaFacts, PLANNED_KIND_SENTENCE, type ArcMetaFact } from "@/lib/arc-meta-facts";
import type { ArcChangesetEntry } from "@/lib/changeset-types";

const fact = (key: string, tooltip = key): ArcMetaFact => ({
  key,
  label: key,
  tooltip,
  tone: "muted",
});

describe("arcTroubleClause", () => {
  test("an arc with nothing in its way has no clause", () => {
    expect(arcTroubleClause([])).toBeNull();
  });

  test("one clause is itself, hover and all", () => {
    const only = fact("overlap", "Uncommitted work on main touches…");
    expect(arcTroubleClause([only])).toEqual(only);
  });

  test("two clauses paint the loudest and stack both sentences into its hover", () => {
    const clause = arcTroubleClause([
      fact("conflicts", "Replaying onto main stops on:\nsrc/a.ts"),
      fact("overlap", "Uncommitted work on main touches files this arc changes:\nsrc/b.ts"),
    ]);
    expect(clause?.key).toBe("conflicts");
    expect(clause?.label).toBe("conflicts");
    expect(clause?.tooltip).toBe(
      "Replaying onto main stops on:\nsrc/a.ts\n\n" +
        "Uncommitted work on main touches files this arc changes:\nsrc/b.ts",
    );
  });

  // The realistic pair, off a real entry rather than off synthetic facts: the
  // line shows the conflict and the overlap's sentence is still reachable.
  test("over a real entry, the conflict leads and the overlap is on its hover", () => {
    const entry = {
      kind: "arc",
      owner_id: "tugarc/foo#1",
      display_name: "foo",
      base: "main",
      rounds: 3,
      worktree: "/tmp/foo",
      worktree_dirty: false,
      files: [],
      replay_conflict_paths: ["src/a.ts", "src/b.ts"],
      base_overlap: ["src/c.ts"],
    } as unknown as ArcChangesetEntry;
    const clause = arcTroubleClause(arcMetaFacts(entry));
    expect(clause?.label).toBe("2 files conflict with main");
    expect(clause?.tone).toBe("danger");
    expect(clause?.tooltip).toContain("Replaying onto main stops on:");
    expect(clause?.tooltip).toContain("Uncommitted work on main touches files this arc changes:");
    expect(clause?.tooltip).toContain("src/c.ts");
  });
});

/**
 * The row the brief was written over: a planned arc whose audit stopped. The
 * line used to read `stopped · audit did not mark planned` — the stop's own
 * words with a stray adjective after them, because a mechanism that appends
 * words will append any word. The kind's sentence is the Devise cell's hover
 * now, the cell a planned arc has and a plain one does not.
 */
describe("a planned arc stopped in its audit", () => {
  const ledger = [1, 2, 3].map((n) => ({ title: `s${n}`, status: "done" }));
  const entry = {
    id: "arc:x",
    name: "x",
    documents: { brief: "/b", plan: "/p" },
    arc_kind: "planned",
    stage: "ready",
    steps: ledger,
    arc: {
      stage: "audit",
      stopped: "audit did not mark",
      stopped_stage: "audit",
      stopped_why: "the audit ended without marking the arc audited",
    },
  } as unknown as ArcChangesetEntry;
  const model = arcTrackModel({
    documents: entry.documents,
    arc: entry.arc,
    arcKind: entry.arc_kind,
    steps: entry.steps,
    stage: entry.stage,
  });

  test("reads the stop as the whole clause, capitalised, with no fraction", () => {
    expect(model.planned).toBe(true);
    expect(model.phase).toBe("audit");
    expect(arcReading(model)).toEqual({
      word: "Stopped · audit did not mark",
      fraction: null,
    });
  });

  test("puts no kind span after it, because none is derived", () => {
    // It used to be derived and then filtered off before paint. Nothing read
    // it, so the fact is gone rather than hidden — which is why there is no
    // filter left to check here.
    expect(arcMetaFacts(entry)).toEqual([]);
    expect(arcTroubleClause(arcMetaFacts(entry))).toBeNull();
  });

  test("says what planned means on the Devise cell, and nowhere else", () => {
    expect(arcCellTip(model, "devise", "done")).toBe(`Devised\n${PLANNED_KIND_SENTENCE}`);
    expect(arcCellTip(model, "review", "done")).toBe("Reviewed");
    const plain = arcTrackModel({ documents: entry.documents, arcKind: "plain", steps: ledger, stage: "ready" });
    expect(arcCellTip(plain, "devise", "pending")).toBe("Not yet devised");
  });
});
