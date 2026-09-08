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
 *
 * The line has two faces of that one clause: the sentence, and — on a host
 * that renders every sentence below its steps — a tone-colored mark in its
 * slot with the same stacked hover. Both are read off the element tree the
 * component returns, which is legitimate here because `ArcLifecycleLine`
 * calls no hooks: reading its output is reading what the DOM would get,
 * without a fake DOM to render into.
 */

import { describe, expect, test } from "bun:test";

import {
  ArcLifecycleLine,
  arcTroubleClause,
} from "@/components/tugways/arc-lifecycle-line";
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

/**
 * The two faces of the one clause: a sentence on the line, or a mark with the
 * sentences below the steps.
 *
 * The mechanism the second face fixes is the first face's packing, not its
 * wording — the sentence is `flex: 0 0 auto` and the reading beside it is the
 * line's only elastic run, so a long fact takes the phase word down to `I…`.
 * What is checked here is what the line EMITS, which is the whole of what the
 * placement prop decides: which run stands in the clause's slot, whether the
 * `·` before it is there, and that the stacked hover survives either way.
 */
describe("the trouble clause's placement", () => {
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
  const model = arcTrackModel({
    documents: { brief: "/b" },
    arcKind: "plain",
    steps: [1, 2, 3].map((n) => ({ title: `s${n}`, status: "pending" })),
    stage: "implementing",
  });
  const facts = arcMetaFacts(entry);

  /**
   * Every element's props in the tree the line returns.
   *
   * `ArcLifecycleLine` calls no hooks, so its output is an ordinary value and
   * walking it is reading what the DOM would get — the idiom
   * `atom-identity-attributes.test.tsx` uses, and not a fake-DOM render.
   */
  function propsInTree(node: unknown, out: Array<Record<string, unknown>> = []): Array<Record<string, unknown>> {
    if (Array.isArray(node)) {
      for (const child of node) propsInTree(child, out);
      return out;
    }
    if (node === null || typeof node !== "object") return out;
    const props = (node as { props?: Record<string, unknown> }).props;
    if (props === undefined) return out;
    out.push(props);
    return propsInTree(props["children"], out);
  }

  const slots = (placement?: "clause" | "mark"): Array<Record<string, unknown>> =>
    propsInTree(
      ArcLifecycleLine({
        model,
        facts,
        ...(placement !== undefined ? { troublePlacement: placement } : {}),
      }),
    );

  const bySlot = (
    all: Array<Record<string, unknown>>,
    slot: string,
  ): Record<string, unknown> | undefined => all.find((p) => p["data-slot"] === slot);

  test("by default the clause is a sentence, after the separator", () => {
    const all = slots();
    const clause = bySlot(all, "tug-arc-lifecycle-fact");
    expect(clause?.["children"]).toBe("2 files conflict with main");
    expect(clause?.["data-tone"]).toBe("danger");
    expect(bySlot(all, "tug-arc-lifecycle-sep")).toBeDefined();
    expect(bySlot(all, "tug-arc-lifecycle-fact-mark")).toBeUndefined();
  });

  test("opted in, the clause is a mark and the separator goes with the words", () => {
    const all = slots("mark");
    const mark = bySlot(all, "tug-arc-lifecycle-fact-mark");
    expect(mark?.["data-tone"]).toBe("danger");
    expect(mark?.["data-fact"]).toBe("conflicts");
    // The sentence is not lost — it is the mark's accessible name, and the
    // host paints it in full below its steps.
    expect(mark?.["aria-label"]).toBe("2 files conflict with main");
    expect(bySlot(all, "tug-arc-lifecycle-fact")).toBeUndefined();
    expect(bySlot(all, "tug-arc-lifecycle-sep")).toBeUndefined();
  });

  test("either face wears every applicable sentence on its hover", () => {
    const stacked = arcTroubleClause(facts)?.tooltip;
    for (const all of [slots(), slots("mark")]) {
      const hover = all.filter((p) => typeof p["content"] === "string" && p["content"] === stacked);
      expect(hover.length).toBe(1);
      expect(stacked).toContain("Uncommitted work on main touches files this arc changes:");
    }
  });

  test("an arc with nothing in its way paints neither face", () => {
    const quiet = propsInTree(ArcLifecycleLine({ model, facts: [], troublePlacement: "mark" }));
    expect(bySlot(quiet, "tug-arc-lifecycle-fact-mark")).toBeUndefined();
    expect(bySlot(quiet, "tug-arc-lifecycle-fact")).toBeUndefined();
  });
});
