/**
 * update-relaunch-warning — what *Install and Relaunch* says about the turns
 * it is about to end.
 *
 * The claims: silence when there is nothing to lose, because a warning that
 * appears every time is a warning nobody reads; names while the list is short
 * enough to read; a count once it is not, or once any of the sessions has no
 * name worth printing.
 */

import { describe, it, expect } from "bun:test";

import {
  relaunchWarningLine,
  MAX_NAMED_SESSIONS,
} from "../update-relaunch-warning";

describe("update-relaunch-warning: silence is the common case", () => {
  it("says nothing when no session is mid-turn", () => {
    expect(relaunchWarningLine([])).toBeNull();
  });
});

describe("update-relaunch-warning: a short list is named", () => {
  it("names one session in the singular", () => {
    expect(relaunchWarningLine(["tugtool — odd-kiln"])).toBe(
      "tugtool — odd-kiln is mid-turn and will be interrupted.",
    );
  });

  it("joins two with 'and'", () => {
    expect(relaunchWarningLine(["alpha", "beta"])).toBe(
      "alpha and beta are mid-turn and will be interrupted.",
    );
  });

  it("joins three in the serial form", () => {
    expect(relaunchWarningLine(["alpha", "beta", "gamma"])).toBe(
      "alpha, beta and gamma are mid-turn and will be interrupted.",
    );
  });

  it("names up to the cap", () => {
    const titles = Array.from({ length: MAX_NAMED_SESSIONS }, (_, i) => `s${i}`);
    expect(relaunchWarningLine(titles)).toContain("s0");
    expect(relaunchWarningLine(titles)).not.toMatch(/^\d/);
  });
});

describe("update-relaunch-warning: a long list is counted", () => {
  it("counts past the cap rather than listing a wall of titles", () => {
    const titles = Array.from(
      { length: MAX_NAMED_SESSIONS + 1 },
      (_, i) => `s${i}`,
    );
    expect(relaunchWarningLine(titles)).toBe(
      `${titles.length} sessions are mid-turn and will be interrupted.`,
    );
  });
});

describe("update-relaunch-warning: an unnamed session is counted, not quoted", () => {
  it("counts when any title is empty", () => {
    // "alpha and  are mid-turn" is worse than saying there are two.
    expect(relaunchWarningLine(["alpha", ""])).toBe(
      "2 sessions are mid-turn and will be interrupted.",
    );
  });

  it("counts when a title is only whitespace", () => {
    expect(relaunchWarningLine(["alpha", "   "])).toBe(
      "2 sessions are mid-turn and will be interrupted.",
    );
  });

  it("falls back to the bare noun when nothing has a name", () => {
    expect(relaunchWarningLine([""])).toBe(
      "A session is mid-turn and will be interrupted.",
    );
    expect(relaunchWarningLine(["", ""])).toBe(
      "2 sessions are mid-turn and will be interrupted.",
    );
  });
});
