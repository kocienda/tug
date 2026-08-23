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

/** A dash the pilot has reconciled — a candidate stands, and that is all the
 *  readiness there is to have. */
const reconciled = (): DashJoinStateWire => ({
  phase: "resolved",
  candidate: "cafe1234",
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

  test("ready is a candidate that stands — nothing is built here", () => {
    const ready = reg(reconciled());
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

  test("a live join names the dash, the base, and the beat", () => {
    const joining = reg(reconciled(), {
      landBeat: { beat: "teardown", status: "start" },
    });
    expect(joining?.phase).toBe("in_flight");
    expect(joining?.line).toBe("Joining imposer2 into main — tearing down the workshop");
    expect(joining?.word).toBe("joining");

    // A beat this table has not learned still renders as itself rather than
    // disappearing: an unknown beat is a real thing happening.
    const unknown = reg(reconciled(), { landBeat: { beat: "polishing", status: "start" } });
    expect(unknown?.line).toBe("Joining imposer2 into main — polishing");
  });

  test("the front of the run has words too, and they outrank the standing offer", () => {
    // Both beats describe the span before the squash: `requested` is written
    // by the press itself, `preflight` by the server the moment it accepts
    // one. Without them this same input rests on the standing candidate and
    // reads "Ready to join" while the join is running.
    const pressed = reg(reconciled(), {
      landBeat: { beat: "requested", status: "start" },
    });
    expect(pressed?.phase).toBe("in_flight");
    expect(pressed?.line).toBe("Joining imposer2 into main — starting");

    const accepted = reg(reconciled(), {
      landBeat: { beat: "preflight", status: "start" },
    });
    expect(accepted?.line).toBe("Joining imposer2 into main — checking the base");
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
    const offline = reg(reconciled(), { connected: false });
    expect(offline?.phase).toBe("idle");
    expect(offline?.line).toBe("Connection dropped — the run continues on the server");
    expect(offline?.word).toBe("offline");
  });

  test("a joinable dash with no candidate reads as the reconcile about to happen", () => {
    // The gap between the recompute and the pilot's dispatch landing. Calling
    // it "nothing to reconcile" would be a lie with a very short shelf life.
    const gap = reg({ phase: "previewed" });
    expect(gap?.word).toBe("reconciling");
  });

  test("a dash still being worked has no join arc, and mounts nothing", () => {
    expect(reg(null, { stage: "implementing" })).toBeNull();
    expect(reg({ phase: "previewed" }, { stage: "implementing" })).toBeNull();
  });

  test("a `ready` dash has the same arc a `built` one does", () => {
    // The gate this pins used to be `stage === "built"`, which meant a dash
    // that armed from its own recorded facts ([D147]) got the modal and a dark
    // register — a face contradicting the arc. All three joinable words reach
    // the same states now.
    for (const stage of ["ready", "built", "audited"]) {
      expect(reg(reconciled(), { stage })?.word).toBe("ready");
      // And with no candidate yet, the beat rather than null: the pilot's
      // dispatch is one recompute away, not absent.
      expect(reg({ phase: "previewed" }, { stage })?.word).toBe("reconciling");
    }
  });

  test("an unbound joinable dash says nothing rather than promising a reconcile", () => {
    // The pilot never runs for a dash nobody holds, so naming a reconcile on
    // the Lens row would be a promise the machine has already declined to
    // keep — standing there forever.
    expect(reg({ phase: "previewed" }, { stage: "ready", bound: false })).toBeNull();
    // A candidate that DID land (from a `/join` on demand, or from a bind
    // since withdrawn) is a fact and still reported.
    expect(
      reg(reconciled(), { stage: "ready", bound: false })?.word,
    ).toBe("ready");
  });

  test("a fresh dash's `empty` blocker is not a join refusal", () => {
    // A dash created a moment ago has no rounds, so the board reports an
    // `empty` blocker meaning "nothing here yet". Read as a join failure it
    // would put a red register on every new dash in the Lens — the arc has not
    // begun, so the register says nothing at all.
    const fresh = reg(
      {
        phase: "blocked",
        blockers: [{ kind: "empty", detail: "nothing to join" }],
      },
      { stage: "created" },
    );
    expect(fresh).toBeNull();

    // The same blocker on a dash that IS built is a real refusal.
    const built = reg({
      phase: "blocked",
      blockers: [{ kind: "empty", detail: "nothing to join" }],
    });
    expect(built?.word).toBe("blocked");
  });

  test("anything that implies somebody acted speaks whatever the stage says", () => {
    // A live run, a beat, a standing question and a stated refusal cannot
    // happen to a dash nobody has touched, so each is worth saying even before
    // the dash reaches `built`.
    const running = reg({ phase: "conflicted", run: "resolve" }, { stage: "implementing" });
    expect(running?.word).toBe("reconciling");

    const asked = reg(
      {
        phase: "conflicted",
        question: { request_id: "r1", question: "which side?", options: [] },
      },
      { stage: "implementing" },
    );
    expect(asked?.word).toBe("question");

    const joining = reg(null, {
      stage: "implementing",
      landBeat: { beat: "squash", status: "start" },
    });
    expect(joining?.word).toBe("joining");

    const stuck = reg({ phase: "conflicted", stuck: "the resolver gave up" }, {
      stage: "implementing",
    });
    expect(stuck?.word).toBe("stuck");
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
      ...reconciled(),
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

    const overDrop = reg(reconciled(), {
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
  test("a join that finished says so, and keeps saying so", () => {
    // The whole reason the terminal beat settles instead of clearing: frames
    // arrive in batches, so on a join fast enough to finish inside one, every
    // in-flight beat is overwritten before a single paint. The settled state
    // is the one reading that survives batching — and it is also simply the
    // most useful sentence the register ever shows.
    const landed = reg(reconciled(), {
      landBeat: { beat: "joined", status: "done", terminal: true },
    });
    expect(landed?.word).toBe("joined");
    expect(landed?.phase).toBe("success");
    expect(landed?.line).toContain("main");
  });

  test("a settled failure outranks the verdict that permitted the press", () => {
    // A green left standing over a join that did not land reads as an
    // invitation to do the thing that just failed.
    const failed = reg(reconciled(), {
      landBeat: { beat: "failed", status: "error", terminal: true },
    });
    expect(failed?.word).toBe("join-failed");
    expect(failed?.phase).toBe("error");
  });

  test("but a blocker outranks the failure, because it explains it", () => {
    const blocked = reg(
      {
        phase: "previewed",
        blockers: [{ kind: "base-dirt", detail: "Commit or stash src/x.ts" }],
      },
      { landBeat: { beat: "failed", status: "error", terminal: true } },
    );
    expect(blocked?.word).toBe("blocked");
    expect(blocked?.line).toContain("src/x.ts");
  });
});
