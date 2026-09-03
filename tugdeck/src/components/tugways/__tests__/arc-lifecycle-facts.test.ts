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

import { arcLifecycleFacts } from "@/components/tugways/arc-lifecycle-line";
import type { ArcMetaFact } from "@/lib/arc-meta-facts";

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

  test("keeps the facts about the arc's own standing, in order", () => {
    const kept = arcLifecycleFacts(
      ["conflicts", "uncommitted", "overlap", "behind", "fit"].map(fact),
    );
    expect(kept.map((f) => f.key)).toEqual(["conflicts", "overlap", "fit"]);
  });
});
