/**
 * dash-join-register — the one sentence the join arc says, state by state.
 *
 * Three surfaces render this: the Lens Dashes row, the Changes shade's dash
 * row, and the composer's status row. They agree because they all call this
 * derivation — so what is pinned here is the whole state→sentence table, and,
 * just as load-bearing, the ORDER the arms are tried in. Precedence is where a
 * status derivation goes wrong: a green verdict announced over a blocker, or a
 * "ready to join" shown while the wire is down, is a true fact in a place where
 * it reads as a lie.
 */

import { describe, test, expect } from "bun:test";

import { dashJoinRegister } from "../dash-join-register";
import type { DashJoinStateWire } from "../changeset-types";

const BASE = { dash: "imposer2", base: "main", stage: "built" };

const reg = (
  join: DashJoinStateWire | null,
  over: Partial<Parameters<typeof dashJoinRegister>[0]> = {},
): ReturnType<typeof dashJoinRegister> =>
  dashJoinRegister({ ...BASE, join, ...over });

const verified = (tier0: string): DashJoinStateWire => ({
  phase: "resolved",
  candidate: "cafe1234",
  verification: {
    tier0,
    tier1: "unrun",
    base_sha: "base0000",
    candidate_sha: "cafe1234",
  },
});

describe("what the register says", () => {
  test("reconciling names the base and counts the files", () => {
    const running = reg({ phase: "conflicted", run: "resolve", conflicts: ["a.rs", "b.rs"] });
    expect(running?.phase).toBe("in_flight");
    expect(running?.line).toBe("Reconciling with main — resolving 2 files");
    expect(running?.word).toBe("reconciling");

    // One file is one file, not "1 files".
    const single = reg({ phase: "conflicted", run: "resolve", conflicts: ["a.rs"] });
    expect(single?.line).toBe("Reconciling with main — resolving 1 file");

    // A reconcile with no conflict list still says what it is doing rather
    // than claiming a count it does not have.
    const countless = reg({ phase: "conflicted", run: "resolve" });
    expect(countless?.line).toBe("Reconciling with main");
  });

  test("checking is the joined tree being built", () => {
    const checking = reg({ phase: "resolved", candidate: "cafe1234", run: "verify" });
    expect(checking?.phase).toBe("in_flight");
    expect(checking?.line).toBe("Building the joined tree");
    expect(checking?.word).toBe("checking");

    expect(reg(verified("running"))?.word).toBe("checking");
  });

  test("ready is a settled green", () => {
    const ready = reg(verified("green"));
    expect(ready?.phase).toBe("success");
    expect(ready?.line).toBe("Ready to join");
    expect(ready?.word).toBe("ready");
  });

  test("a question waits on a person, and says which prompt", () => {
    const asked = reg({
      phase: "conflicted",
      question: { request_id: "r1", question: "which side?", options: [] },
    });
    // `awaiting` is the caution pulse — work that has stopped for somebody.
    expect(asked?.phase).toBe("awaiting");
    expect(asked?.line).toBe("The resolver needs a decision — answer the prompt");
    expect(asked?.word).toBe("question");
  });

  test("a red is a decision, not an error report", () => {
    const red = reg(verified("red"));
    expect(red?.phase).toBe("error");
    expect(red?.line).toBe("Build red on the joined tree — join is a decision now");
    expect(red?.word).toBe("checks-red");
  });

  test("a live join names the dash, the base, and the beat", () => {
    const joining = reg(verified("green"), {
      landBeat: { beat: "teardown", status: "start" },
    });
    expect(joining?.phase).toBe("in_flight");
    expect(joining?.line).toBe("Joining imposer2 into main — tearing down the workshop");
    expect(joining?.word).toBe("joining");

    // A beat this table has not learned still renders as itself rather than
    // disappearing: an unknown beat is a real thing happening.
    const unknown = reg(verified("green"), { landBeat: { beat: "polishing", status: "start" } });
    expect(unknown?.line).toBe("Joining imposer2 into main — polishing");
  });

  test("blocked speaks the blocker's own sentence", () => {
    // Composing a sentence here would be a second, worse copy of one the
    // server already wrote — and the server's names the act that clears it.
    const blocked = reg({
      phase: "blocked",
      blockers: [{ kind: "base-dirt", detail: "commit or stash main's changes first" }],
    });
    expect(blocked?.phase).toBe("error");
    expect(blocked?.line).toBe("commit or stash main's changes first");
    expect(blocked?.word).toBe("blocked");
  });

  test("a stuck resolve states the refusal it already made", () => {
    const stuck = reg({ phase: "conflicted", stuck: "the resolver exhausted its budget" });
    expect(stuck?.phase).toBe("error");
    expect(stuck?.line).toBe("the resolver exhausted its budget");
    expect(stuck?.word).toBe("stuck");
  });

  test("a dropped wire says so, and does not claim the run died", () => {
    const offline = reg(verified("green"), { connected: false });
    expect(offline?.phase).toBe("idle");
    expect(offline?.line).toBe("Connection dropped — the run continues on the server");
    expect(offline?.word).toBe("offline");
  });

  test("a built dash with no verdict reads as the check about to happen", () => {
    // The gap between the recompute and the pilot's dispatch landing. Calling
    // it "nothing to reconcile" would be a lie with a very short shelf life.
    const gap = reg({ phase: "previewed" });
    expect(gap?.word).toBe("checking");
  });

  test("a dash still being worked has no join arc, and mounts nothing", () => {
    expect(reg(null, { stage: "implementing" })).toBeNull();
    expect(reg({ phase: "previewed" }, { stage: "implementing" })).toBeNull();
  });
});

describe("precedence — the part that gets re-derived wrongly", () => {
  test("a wire drop outranks a running resolve", () => {
    const dropped = reg({ phase: "conflicted", run: "resolve", conflicts: ["a.rs"] }, {
      connected: false,
    });
    expect(dropped?.word).toBe("offline");
  });

  test("a blocker outranks a green verdict", () => {
    // A tree that builds still cannot land onto a dirty base, and announcing
    // "Ready to join" over a blocker is how a press comes to be refused by
    // something the row never mentioned.
    const both = reg({
      ...verified("green"),
      blockers: [{ kind: "base-dirt", detail: "commit or stash main's changes first" }],
    });
    expect(both?.word).toBe("blocked");
  });

  test("a live join outranks everything but a wire drop", () => {
    const overQuestion = reg(
      {
        phase: "conflicted",
        question: { request_id: "r1", question: "which side?", options: [] },
      },
      { landBeat: { beat: "squash", status: "start" } },
    );
    expect(overQuestion?.word).toBe("joining");

    const overDrop = reg(verified("green"), {
      landBeat: { beat: "squash", status: "start" },
      connected: false,
    });
    expect(overDrop?.word).toBe("offline");
  });

  test("a question outranks the run it belongs to", () => {
    // A run that is waiting on a person is not progressing, and rendering it
    // as progress is how an unanswered prompt goes unnoticed.
    const waiting = reg({
      phase: "conflicted",
      run: "resolve",
      conflicts: ["a.rs"],
      question: { request_id: "r1", question: "which side?", options: [] },
    });
    expect(waiting?.word).toBe("question");
  });

  test("the client's own overlay stands in when the feed has not caught up", () => {
    // The press sends and the store flips to `resolving` immediately; the
    // feed's `run` fact arrives on the next recompute. Without this arm the
    // row reads idle for the gap between them.
    const overlay = reg({ phase: "conflicted", conflicts: ["a.rs"] }, {
      resolvePhase: "resolving",
    });
    expect(overlay?.word).toBe("reconciling");
  });
});
