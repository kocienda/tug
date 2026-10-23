/**
 * arc-lifecycle-facts.test.ts — what a planned arc's line says, and where.
 *
 * The line is one clause: what the arc is doing. A planned arc's kind is the
 * strip's own cell set, and the sentence saying what "planned" means lives on
 * the Devise cell's hover rather than as a word on the line.
 *
 * Pure, so the rule is a table rather than a screenshot.
 */

import { describe, expect, test } from "bun:test";

import { arcCellTip, arcReading, arcTrackModel } from "@/components/tugways/tug-arc-track";
import { PLANNED_KIND_SENTENCE } from "@/lib/arc-meta-facts";
import type { ArcChangesetEntry } from "@/lib/changeset-types";

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

  test("says what planned means on the Devise cell, and nowhere else", () => {
    expect(arcCellTip(model, "devise", "done")).toBe(`Devised\n${PLANNED_KIND_SENTENCE}`);
    expect(arcCellTip(model, "review", "done")).toBe("Reviewed");
    const plain = arcTrackModel({ documents: entry.documents, arcKind: "plain", steps: ledger, stage: "ready" });
    expect(arcCellTip(plain, "devise", "pending")).toBe("Not yet devised");
  });
});
