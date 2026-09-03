/**
 * A disabled menu item still has to say why.
 *
 * This is the one part of the row menu that can go wrong silently. A disabled
 * item takes no pointer events, so a `title` on it can never be read and a
 * tooltip on it never fires — which is how a blocked verb turns into a dead
 * word with no explanation ([L31]). The reason therefore rides the label, and
 * that composition is what this pins.
 */

import { describe, test, expect } from "bun:test";

import {
  arcRowMenuLabel,
  replayDisabledReason,
} from "@/components/tugways/cards/session-changes/arc-row-menu";

describe("the label carries its own refusal", () => {
  test("an available verb is the bare word", () => {
    expect(arcRowMenuLabel("Unbind", null)).toBe("Unbind");
    expect(arcRowMenuLabel("Discard", null)).toBe("Discard");
  });

  test("a blocked verb names the block beside the word", () => {
    expect(arcRowMenuLabel("Discard", "a turn is running")).toBe(
      "Discard — a turn is running",
    );
  });

  test("the empty reason is still a reason, and still shows", () => {
    // Not `?? null`-collapsed into the available case: a caller that hands over
    // an empty string has a blocked verb with nothing to say, and rendering it
    // as available would offer a press the gate refuses.
    expect(arcRowMenuLabel("Bind", "")).toBe("Bind — ");
  });

  test("the replay item composes its destination and its refusal", () => {
    expect(arcRowMenuLabel("Replay onto main", null)).toBe("Replay onto main");
    expect(arcRowMenuLabel("Replay onto main", "already current with main")).toBe(
      "Replay onto main — already current with main",
    );
  });
});

/**
 * Replay's reach, which is the part of this verb most likely to be got wrong.
 *
 * The first design gated it on boundness, on the theory that the machine tends
 * a bound arc. It does not: the base-motion engine's gate never reads
 * boundness, so a bound diverged arc in a repository with autoreplay off is
 * exactly as stuck as an unbound one — and an unbound *dirty* one would have
 * offered a button the server declines every time.
 */
describe("replay's reach", () => {
  const arc = {
    base: "main",
    base_ahead: 0,
    worktree_dirty: false,
    replay_conflict_paths: [] as string[],
  };

  test("a diverged arc can replay", () => {
    expect(replayDisabledReason({ ...arc, base_ahead: 3 })).toBeNull();
  });

  test("an arc whose last replay conflicted can replay again", () => {
    expect(
      replayDisabledReason({ ...arc, replay_conflict_paths: ["src/a.ts"] }),
    ).toBeNull();
  });

  test("a current arc says so rather than offering a no-op", () => {
    expect(replayDisabledReason(arc)).toBe("already current with main");
  });

  test("a dirty worktree is a readable refusal, not a dead press", () => {
    expect(
      replayDisabledReason({ ...arc, base_ahead: 2, worktree_dirty: true }),
    ).toBe("its worktree has uncommitted changes");
  });

  test("boundness is not in the predicate — it takes no such field", () => {
    // The regression guard: a diverged arc reads the same whoever holds it,
    // because the entry a caller passes carries no holder at all.
    const diverged = { ...arc, base_ahead: 1 };
    expect(replayDisabledReason(diverged)).toBeNull();
    expect(replayDisabledReason({ ...diverged, base: "trunk" })).toBeNull();
  });

  test("an older sender's absent fields read as current, never as diverged", () => {
    expect(replayDisabledReason({ base: "main", worktree_dirty: false })).toBe(
      "already current with main",
    );
  });
});
