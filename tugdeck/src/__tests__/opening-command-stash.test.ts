/**
 * The opening-command stash — a card's first turn, held from the gesture
 * that opened it until its session binds.
 *
 * `Run in New Session` adds a card and fires the spawn in one act, and the
 * command it was opened to run has nowhere to live in between: no store yet,
 * and no wire field (the opening prompt on `session_command` belongs to the
 * wheel's rotations). These tests pin the stash's contract — hold per card,
 * hand back exactly once, and forget on demand — which is what keeps the
 * command from running twice or surfacing on an unrelated later session.
 */

import { describe, it, expect, beforeEach } from "bun:test";

import {
  clearOpeningCommand,
  drainOpeningCommand,
  stashOpeningCommand,
} from "../lib/session-restore";

const CARD = "card-opening-command-test";
const OTHER_CARD = "card-opening-command-test-other";

describe("the opening command stash", () => {
  beforeEach(() => {
    clearOpeningCommand(CARD);
    clearOpeningCommand(OTHER_CARD);
  });

  it("hands back the command stashed for the card", () => {
    stashOpeningCommand(CARD, {
      name: "arc",
      args: "brief-handoff @briefs/a-brief.md",
    });

    expect(drainOpeningCommand(CARD)).toEqual({
      name: "arc",
      args: "brief-handoff @briefs/a-brief.md",
    });
  });

  it("drains exactly once — a second read would run the command twice", () => {
    stashOpeningCommand(CARD, { name: "arc", args: "x" });

    expect(drainOpeningCommand(CARD)).toEqual({ name: "arc", args: "x" });
    expect(drainOpeningCommand(CARD)).toBeUndefined();
  });

  it("holds nothing for a card nobody stashed one for", () => {
    expect(drainOpeningCommand(CARD)).toBeUndefined();
  });

  it("keys by card, so one card's command never reaches another", () => {
    stashOpeningCommand(CARD, { name: "arc", args: "mine" });

    expect(drainOpeningCommand(OTHER_CARD)).toBeUndefined();
    expect(drainOpeningCommand(CARD)).toEqual({ name: "arc", args: "mine" });
  });

  it("forgets on demand — a closed card's command must not resurface", () => {
    stashOpeningCommand(CARD, { name: "arc", args: "x" });
    clearOpeningCommand(CARD);

    expect(drainOpeningCommand(CARD)).toBeUndefined();
  });

  it("a second stash replaces the first rather than queueing beside it", () => {
    stashOpeningCommand(CARD, { name: "arc", args: "first" });
    stashOpeningCommand(CARD, { name: "arc", args: "second" });

    expect(drainOpeningCommand(CARD)).toEqual({ name: "arc", args: "second" });
    expect(drainOpeningCommand(CARD)).toBeUndefined();
  });
});
