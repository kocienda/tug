/**
 * `currentLineForSession` — the selector the description ladder's top rung
 * rests on ([B03], [B04]).
 *
 * Over plain maps, with no store and no connection. What is pinned here is the
 * clearing: the line is a fact about a turn, so a line written before the turn
 * in flight began belongs to a turn that is over and must not be shown. That
 * is the whole of "cleared when the turn ends" — the store holds the line, and
 * the turn decides whether it is still true, because the turn is a fact the
 * digest holds and the channel does not.
 */

import { describe, expect, it } from "bun:test";

import {
  currentLineForSession,
  type SessionCurrentLineEntry,
} from "@/lib/overview-store";

function currents(
  entries: Record<string, SessionCurrentLineEntry>,
): ReadonlyMap<string, SessionCurrentLineEntry> {
  return new Map(Object.entries(entries));
}

const HELD = currents({
  s1: { text: "Chase the wedge in the download resume path", atMs: 2_000 },
  s2: { text: "Rework how a session names itself", atMs: 2_000 },
});

describe("currentLineForSession", () => {
  it("answers with the line written during the turn in flight", () => {
    expect(currentLineForSession(HELD, "s1", 1_000)).toBe(
      "Chase the wedge in the download resume path",
    );
    // Written in the same instant the turn began is written during it.
    expect(currentLineForSession(HELD, "s1", 2_000)).toBe(
      "Chase the wedge in the download resume path",
    );
  });

  // The clearing. A line from the previous turn is exactly the staleness this
  // work exists to end, so it must not survive into the next one.
  it("declines a line older than the turn in flight", () => {
    expect(currentLineForSession(HELD, "s1", 3_000)).toBeNull();
  });

  // At rest the line under a session's name is its through-line: a per-turn
  // line has nothing to say about a session that is not in a turn.
  it("answers nothing when no turn is in flight", () => {
    expect(currentLineForSession(HELD, "s1", null)).toBeNull();
  });

  it("answers nothing for a session nobody has written a line about", () => {
    expect(currentLineForSession(HELD, "s3", 1_000)).toBeNull();
    expect(currentLineForSession(new Map(), "s1", 1_000)).toBeNull();
  });

  // One line per session, and never another session's: the map is keyed by
  // the same id an Observer post carries.
  it("never answers with another session's line", () => {
    expect(currentLineForSession(HELD, "s2", 1_000)).toBe(
      "Rework how a session names itself",
    );
    expect(currentLineForSession(HELD, "", 1_000)).toBeNull();
  });
});
