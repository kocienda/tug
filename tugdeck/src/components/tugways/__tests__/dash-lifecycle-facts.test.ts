/**
 * dash-lifecycle-facts.test.ts — which of a dash's facts reach the line.
 *
 * `dashMetaFacts` derives everything the wire entry says about a dash; the
 * line prints the subset that is about the DASH. The checkout's git
 * bookkeeping — a dirty worktree, a base that has moved, a replay that
 * settled — is read where a gesture turns on it (the picker, the Replay
 * item's label, the discard confirmation, the replay bulletin), never as a
 * word riding the state line.
 *
 * Pure, so the rule is a table rather than a screenshot.
 */

import { describe, expect, test } from "bun:test";

import { dashLifecycleFacts } from "@/components/tugways/dash-lifecycle-line";
import type { DashMetaFact } from "@/lib/dash-meta-facts";

const fact = (key: string): DashMetaFact => ({
  key,
  label: key,
  tooltip: key,
  tone: "muted",
});

describe("dashLifecycleFacts", () => {
  test("drops the checkout's git bookkeeping", () => {
    const kept = dashLifecycleFacts(
      ["uncommitted", "behind", "replayed"].map(fact),
    );
    expect(kept).toEqual([]);
  });

  test("drops the arc's two, which the track and the note already say", () => {
    expect(dashLifecycleFacts(["arc", "arc-stopped"].map(fact))).toEqual([]);
  });

  test("keeps the facts about the dash's own standing, in order", () => {
    const kept = dashLifecycleFacts(
      ["conflicts", "uncommitted", "overlap", "behind", "fit"].map(fact),
    );
    expect(kept.map((f) => f.key)).toEqual(["conflicts", "overlap", "fit"]);
  });
});
