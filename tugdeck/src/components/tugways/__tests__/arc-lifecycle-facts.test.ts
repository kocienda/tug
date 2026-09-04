/**
 * arc-lifecycle-facts.test.ts — which of an arc's facts reach the line.
 *
 * `arcMetaFacts` derives everything the wire entry says about an arc; the
 * line prints the subset that is about the ARC. The checkout's git
 * bookkeeping — a dirty worktree, a base that has moved, a replay that
 * settled — is read where a gesture turns on it (the picker, the Replay
 * item's label, the discard confirmation, the replay bulletin), never as a
 * word riding the state line.
 *
 * Pure, so the rule is a table rather than a screenshot.
 */

import { describe, expect, test } from "bun:test";

import {
  arcLifecycleFacts,
  arcLifecycleNote,
} from "@/components/tugways/arc-lifecycle-line";
import { arcCellTip, arcTrackModel } from "@/components/tugways/tug-arc-track";
import { arcMetaFacts, PLANNED_KIND_SENTENCE, type ArcMetaFact } from "@/lib/arc-meta-facts";
import type { ArcChangesetEntry } from "@/lib/changeset-types";

const fact = (key: string): ArcMetaFact => ({
  key,
  label: key,
  tooltip: key,
  tone: "muted",
});

describe("arcLifecycleFacts", () => {
  test("drops the checkout's git bookkeeping", () => {
    const kept = arcLifecycleFacts(
      ["uncommitted", "behind", "replayed"].map(fact),
    );
    expect(kept).toEqual([]);
  });

  test("drops the arc's two, which the track and the note already say", () => {
    expect(arcLifecycleFacts(["arc", "arc-stopped"].map(fact))).toEqual([]);
  });

  test("drops the kind, which the track's cell set already draws", () => {
    expect(arcLifecycleFacts(["kind"].map(fact))).toEqual([]);
  });

  test("keeps the facts about the arc's own standing, in order", () => {
    const kept = arcLifecycleFacts(
      ["conflicts", "uncommitted", "overlap", "behind", "fit"].map(fact),
    );
    expect(kept.map((f) => f.key)).toEqual(["conflicts", "overlap", "fit"]);
  });
});

/**
 * The row the brief was written over: a planned arc whose audit stopped. The
 * note is the stop and nothing trails it — the word `planned` used to, with
 * nothing between them, and read as the stop's last word. The kind's sentence
 * moved to the Devise cell's hover, the cell a planned arc has and a plain one
 * does not.
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
    },
  } as unknown as ArcChangesetEntry;
  const model = arcTrackModel({
    documents: entry.documents,
    arc: entry.arc,
    arcKind: entry.arc_kind,
    steps: entry.steps,
    stage: entry.stage,
  });

  test("reads the stop as the note, spelled audit", () => {
    expect(model.planned).toBe(true);
    expect(model.phase).toBe("audit");
    expect(arcLifecycleNote(model)).toBe("stopped · audit did not mark");
  });

  test("puts no kind span after the note", () => {
    const facts = arcMetaFacts(entry);
    expect(facts.some((f) => f.key === "kind")).toBe(true);
    expect(arcLifecycleFacts(facts).map((f) => f.key)).not.toContain("kind");
  });

  test("says what planned means on the Devise cell, and nowhere else", () => {
    expect(arcCellTip(model, "devise", "done")).toBe(`devise · done\n${PLANNED_KIND_SENTENCE}`);
    expect(arcCellTip(model, "review", "done")).toBe("review · done");
    const plain = arcTrackModel({ documents: entry.documents, arcKind: "plain", steps: ledger, stage: "ready" });
    expect(arcCellTip(plain, "devise", "pending")).toBe("devise · pending");
  });
});
