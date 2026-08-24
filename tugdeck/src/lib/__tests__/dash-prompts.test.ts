/**
 * The cockpit's prompt templates and its target ladder.
 *
 * Both halves are pure by design so their whole truth tables live here rather
 * than in a DOM assertion. The templates matter because a programmatic send
 * skips the composer's bare-name canonicalization: what these functions return
 * is exactly what reaches the resolver, so the qualified spelling is the
 * contract. The ladder matters because every rung's sentence is what a disabled
 * control wears ([L31]) — a refusal nobody can read is the failure the whole
 * cockpit exists to retire.
 */

import { describe, expect, test } from "bun:test";

import {
  planNextGestureLabel,
  planNextGesturePrompt,
  resolvePromptTarget,
  startDashPrompt,
} from "../dash-prompts";

describe("startDashPrompt", () => {
  test("an idea alone invokes the on-ramp with the sentence", () => {
    expect(startDashPrompt("make the Lens list waiting plans")).toBe(
      "/tugplug:dash make the Lens list waiting plans",
    );
  });

  test("a name rides as prose, because the receiver reads English", () => {
    expect(startDashPrompt("list waiting plans", "plan-rows")).toBe(
      "/tugplug:dash list waiting plans — name it plan-rows",
    );
  });

  test("both fields are trimmed, and an all-space name is no name", () => {
    expect(startDashPrompt("  an idea  ", "   ")).toBe("/tugplug:dash an idea");
    expect(startDashPrompt("an idea", null)).toBe("/tugplug:dash an idea");
    expect(startDashPrompt("an idea", "  spaced  ")).toBe(
      "/tugplug:dash an idea — name it spaced",
    );
  });
});

describe("planNextGesturePrompt — the next gesture ladder (Table T01)", () => {
  test("a reviewed plan is one press from a dash", () => {
    expect(planNextGesturePrompt("reviewed", "dash/x.md", false)).toBe(
      "/tugplug:dash-implement dash/x.md",
    );
    expect(planNextGestureLabel("reviewed", false)).toBe("Implement");
  });

  // Stale and never-reviewed get the same answer: a review that predates an
  // edit vouches for a document that no longer exists.
  test("anything short of reviewed wants the review turn", () => {
    for (const review of ["never-reviewed", "stale"]) {
      expect(planNextGesturePrompt(review, "dash/x.md", false)).toBe(
        "/tugplug:plan-review dash/x.md",
      );
      expect(planNextGestureLabel(review, false)).toBe("Review");
    }
  });

  // Work already on the ledger outranks every review state: `dash-implement`
  // resumes at the first row that is not done, and its own setup gate re-asks
  // about a review that went stale.
  test("a begun plan wants resuming, whatever its review says", () => {
    for (const review of ["reviewed", "stale", "never-reviewed"]) {
      expect(planNextGesturePrompt(review, "dash/x.md", true)).toBe(
        "/tugplug:dash-implement dash/x.md",
      );
      expect(planNextGestureLabel(review, true)).toBe("Resume");
    }
  });

  test("the path is cited verbatim", () => {
    expect(planNextGesturePrompt("reviewed", "docs/plans/a b.md", false)).toBe(
      "/tugplug:dash-implement docs/plans/a b.md",
    );
  });
});

describe("resolvePromptTarget — every refusal is a sentence", () => {
  const binding = { tugSessionId: "sess-1", projectDir: "/repo" };

  test("no followed card names the gesture that fixes it", () => {
    expect(
      resolvePromptTarget({
        followedCardId: null,
        binding: undefined,
        phase: "idle",
      }),
    ).toEqual({ cardId: null, reason: "Focus a session card to send this" });
  });

  test("a followed card with no session says so", () => {
    expect(
      resolvePromptTarget({
        followedCardId: "card-1",
        binding: undefined,
        phase: "idle",
      }),
    ).toEqual({ cardId: null, reason: "The focused card has no session" });
  });

  test("a plan may only be handed to a session in its own project", () => {
    expect(
      resolvePromptTarget({
        followedCardId: "card-1",
        binding,
        requireProjectDir: "/other",
        projectLabel: "other",
        phase: "idle",
      }),
    ).toEqual({ cardId: null, reason: "This plan belongs to other" });
  });

  test("a project-free act skips the project rung entirely", () => {
    // The start sheet passes no `requireProjectDir`: a new dash belongs to
    // whatever project the followed session is in.
    expect(
      resolvePromptTarget({ followedCardId: "card-1", binding, phase: "idle" }),
    ).toEqual({ cardId: "card-1", reason: null });
  });

  test("a card whose session has no live store is not ready", () => {
    expect(
      resolvePromptTarget({
        followedCardId: "card-1",
        binding,
        phase: null,
      }),
    ).toEqual({
      cardId: null,
      reason: "The focused card's session is not ready",
    });
  });

  test("replaying is the one phase that refuses — it is the one that drops", () => {
    expect(
      resolvePromptTarget({
        followedCardId: "card-1",
        binding,
        phase: "replaying",
      }),
    ).toEqual({
      cardId: null,
      reason: "The focused card is replaying its transcript",
    });
  });

  // A mid-turn send is not dropped, it is enqueued as a visible ghost row that
  // flushes at turn completion. Queueing the next gesture behind a running turn
  // is a feature, so the ladder must not forbid it — a can-submit gate here
  // would disable every affordance for the length of every turn.
  test("a live turn does not refuse: the send queues", () => {
    for (const phase of [
      "submitting",
      "awaiting_first_token",
      "streaming",
      "tool_work",
      "awaiting_approval",
      "waking",
      "errored",
    ] as const) {
      expect(
        resolvePromptTarget({ followedCardId: "card-1", binding, phase }),
      ).toEqual({ cardId: "card-1", reason: null });
    }
  });

  test("the project rung passes when the projects match", () => {
    expect(
      resolvePromptTarget({
        followedCardId: "card-1",
        binding,
        requireProjectDir: "/repo",
        projectLabel: "repo",
        phase: "idle",
      }),
    ).toEqual({ cardId: "card-1", reason: null });
  });
});
