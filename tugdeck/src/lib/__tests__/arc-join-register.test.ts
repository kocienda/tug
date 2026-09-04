/**
 * arc-join-register — the one sentence the join says, state by state.
 *
 * Three surfaces render this: the Arcs card Arcs row, the Changes shade's arc
 * row, and the composer's status row. They agree because they all call this
 * derivation — so what is pinned here is the whole state→sentence table, and,
 * just as load-bearing, the ORDER the arms are tried in. Precedence is where a
 * status derivation goes wrong: a green verdict announced over a blocker, or a
 * "ready to join" shown while the wire is down, is a true fact in a place where
 * it reads as a lie.
 */

import { describe, test, expect } from "bun:test";

import { arcJoinRegister } from "../arc-join-register";
import type { ArcJoinStateWire } from "../changeset-types";

const BASE = { arc: "imposer2", base: "main", stage: "built" };

const reg = (
  join: ArcJoinStateWire | null,
  over: Partial<Parameters<typeof arcJoinRegister>[0]> = {},
): ReturnType<typeof arcJoinRegister> =>
  arcJoinRegister({ ...BASE, join, ...over });

/** An arc the pilot has reconciled — a candidate stands, and that is all the
 *  readiness there is to have. */
const reconciled = (): ArcJoinStateWire => ({
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

  test("an arc whose session is still working is not offered", () => {
    // The same arc, same standing candidate — the only difference is that
    // whoever built it has not stopped. A turn ends when the model stops
    // speaking; the tests it backgrounded are still deciding whether the work
    // is any good, and "Ready to join" in that window invites the user to land
    // something nobody has finished checking.
    const working = reg(reconciled(), { holdersBusy: true });
    expect(working?.phase).toBe("in_flight");
    expect(working?.line).toBe("imposer2 is still working — the join waits for it to finish");
    expect(working?.word).toBe("working");

    // And it holds the pre-candidate arm shut too, which is the one a freshly
    // finished arc actually passes through.
    expect(reg(null, { holdersBusy: true })?.word).toBe("working");
  });

  test("a join already in motion outranks the holder still working", () => {
    // Busyness gates an *offer*. A join in flight, a blocker, a question and a
    // stated refusal each report something that has already happened, and none
    // of them is an offer — so none of them is held.
    expect(
      reg(reconciled(), {
        holdersBusy: true,
        landBeat: { beat: "squash", status: "ok" },
      })?.word,
    ).toBe("joining");
    expect(
      reg({ phase: "blocked", blockers: [{ kind: "base-dirt", title: "Base work in the way", detail: "commit or stash main's changes first" }] }, {
        holdersBusy: true,
      })?.word,
    ).toBe("blocked");
    expect(
      reg({ phase: "conflicted", run: "resolve" }, { holdersBusy: true })?.word,
    ).toBe("reconciling");
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

  test("a live join names the arc, the base, and the beat", () => {
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
      blockers: [{ kind: "base-dirt", title: "Base work in the way", detail: "commit or stash main's changes first" }],
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

  test("a joinable arc with no candidate reads as the reconcile about to happen", () => {
    // The gap between the recompute and the pilot's dispatch landing. Calling
    // it "nothing to reconcile" would be a lie with a very short shelf life.
    const gap = reg({ phase: "previewed" });
    expect(gap?.word).toBe("reconciling");
  });

  test("an arc still being worked has no join, and mounts nothing", () => {
    expect(reg(null, { stage: "implementing" })).toBeNull();
    expect(reg({ phase: "previewed" }, { stage: "implementing" })).toBeNull();
  });

  test("a `ready` arc has the same arc a `built` one does", () => {
    // The gate this pins used to be `stage === "built"`, which meant an arc
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

  test("an unbound joinable arc says nothing rather than promising a reconcile", () => {
    // The pilot never runs for an arc nobody holds, so naming a reconcile on
    // the Arcs card row would be a promise the machine has already declined to
    // keep — standing there forever.
    expect(reg({ phase: "previewed" }, { stage: "ready", bound: false })).toBeNull();
    // A candidate that DID land (from a `/arc-join` on demand, or from a bind
    // since withdrawn) is a fact and still reported.
    expect(
      reg(reconciled(), { stage: "ready", bound: false })?.word,
    ).toBe("ready");
  });

  test("a fresh arc's `empty` blocker is not a join refusal", () => {
    // An arc created a moment ago has no rounds, so the board reports an
    // `empty` blocker meaning "nothing here yet". Read as a join failure it
    // would put a red register on every new arc in the Arcs card — the arc has not
    // begun, so the register says nothing at all.
    const fresh = reg(
      {
        phase: "blocked",
        blockers: [{ kind: "empty", title: "Nothing to join", detail: "nothing to join" }],
      },
      { stage: "created" },
    );
    expect(fresh).toBeNull();

    // The same blocker on an arc that IS built is a real refusal.
    const built = reg({
      phase: "blocked",
      blockers: [{ kind: "empty", title: "Nothing to join", detail: "nothing to join" }],
    });
    expect(built?.word).toBe("blocked");
  });

  test("anything that implies somebody acted speaks whatever the stage says", () => {
    // A live run, a beat, a standing question and a stated refusal cannot
    // happen to an arc nobody has touched, so each is worth saying even before
    // the arc reaches `built`.
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
      blockers: [{ kind: "base-dirt", title: "Base work in the way", detail: "commit or stash main's changes first" }],
    });
    expect(both?.word).toBe("blocked");
  });

  test("a live join outranks a blocker", () => {
    // The 2026-08-24 flash: a join writes its own resume journal while it runs,
    // the server reported that journal as "a previous join is incomplete", and
    // the register painted the refusal red over a join that was seconds from
    // landing. The server no longer sends that blocker, and the arm order means
    // no future blocker can paint over a run in flight either — a blocker
    // answers whether a join may start, which a running join has settled.
    const midJoin = reg(
      {
        ...reconciled(),
        run: "join",
        blockers: [
          {
            kind: "stale-journal",
            title: "A join left a teardown behind",
            detail: "A previous join of arc 'd' is incomplete.",
          },
        ],
      },
      { landBeat: { beat: "squash", status: "start" } },
    );
    expect(midJoin?.word).toBe("joining");
    expect(midJoin?.phase).toBe("in_flight");

    // A blocker with no join running still speaks — the arm moved, it did not
    // go away.
    const notJoining = reg({
      ...reconciled(),
      blockers: [
        { kind: "stale-journal", title: "A join left a teardown behind", detail: "A previous join of arc 'd' is incomplete." },
      ],
    });
    expect(notJoining?.word).toBe("blocked");
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
        blockers: [{ kind: "base-dirt", title: "Base work in the way", detail: "Commit or stash src/x.ts" }],
      },
      { landBeat: { beat: "failed", status: "error", terminal: true } },
    );
    expect(blocked?.word).toBe("blocked");
    expect(blocked?.line).toContain("src/x.ts");
  });
});

/**
 * The receipt's register — what a join leaves behind once the live one is gone.
 *
 * `SessionJoinReceiptBlock` mounts the register over facts parsed from the
 * persisted receipt, so a reader scrolling back finds the same row that stood
 * while the join ran, settled, immediately above the commit it presaged. It
 * passes no wire state at all: the receipt's existence IS the terminal beat.
 */
describe("the register a landed receipt reproduces", () => {
  test("a terminal ok beat with nothing else settles on the joined sentence", () => {
    const settled = arcJoinRegister({
      arc: "imposer2",
      base: "main",
      stage: "ready",
      landBeat: { beat: "record", status: "ok", terminal: true },
    });
    expect(settled?.phase).toBe("success");
    expect(settled?.line).toBe("Joined imposer2 into main");
    expect(settled?.word).toBe("joined");
  });
});

/**
 * The arc's own word — what the register says while a wheel is still seated.
 *
 * The arm sits immediately above the candidate arm, and that position is the
 * whole of it: a running audit commits fixup rounds, so a candidate that stands
 * is describing a tree that is still moving. The tests below make the position
 * falsifiable rather than leaving it to be read off the `if`s.
 */
describe("a live arc holds the offer", () => {
  test("an audit in flight outranks a standing candidate", () => {
    const auditing = reg(reconciled(), { run: { stage: "audit" } });
    expect(auditing?.phase).toBe("in_flight");
    expect(auditing?.line).toBe("imposer2 is being audited — the join waits for it");
    expect(auditing?.word).toBe("auditing");
  });

  test("another live stage names itself and still waits for the audit", () => {
    const implementing = reg(reconciled(), { run: { stage: "implement" } });
    expect(implementing?.phase).toBe("in_flight");
    expect(implementing?.line).toBe("imposer2 is in implement — the join waits for the audit");
  });

  test("a stopped wheel does not hold the surface hostage", () => {
    // A stop before the audit: the join never needed a wheel, and the offer
    // the wheel was holding is released as it always was.
    const stopped = reg(reconciled(), {
      run: { stage: "implement", stopped: "stalled", stopped_stage: "implement" },
    });
    expect(stopped?.line).toBe("Ready to join");
    expect(stopped?.word).toBe("ready");
  });

  test("a stopped audit is unaudited, not ready", () => {
    // The stop means the audit did not mark. The word is the caution pulse the
    // register already uses for work waiting on a person, and the sentence
    // names both ways out — neither of which is `Ready to join`.
    for (const stopped of ["audit did not mark", "stalled", "stopped by user"]) {
      const unaudited = reg(reconciled(), {
        run: { stage: "audit", stopped, stopped_stage: "audit" },
      });
      expect(unaudited?.phase).toBe("awaiting");
      expect(unaudited?.line).toBe("imposer2's audit stopped — resume it, or land it unaudited");
      expect(unaudited?.word).toBe("unaudited");
    }
  });

  test("a stopped audit speaks below the joinable stages, where the server now holds it", () => {
    // `join_ready` is shut over a stopped audit, so the feed's stage reads
    // `implementing` and there is no candidate. The early gate would answer
    // null for that stage on any other arc; here the stop is the act, and the
    // sentence is the point.
    const held = reg(null, {
      stage: "implementing",
      run: { stage: "audit", stopped: "stopped by user", stopped_stage: "audit" },
    });
    expect(held?.phase).toBe("awaiting");
    expect(held?.word).toBe("unaudited");
    // And a stop before the audit at the same stage stays silent, as before.
    const early = reg(null, {
      stage: "implementing",
      run: { stage: "implement", stopped: "stopped by user", stopped_stage: "implement" },
    });
    expect(early).toBeNull();
  });

  test("a stopped audit that had already signed off is still ready", () => {
    // The derived stage is `audited` only for the declaration that arms the
    // join, so a stop landing after the mark changes nothing about the offer.
    const signed = reg(reconciled(), {
      stage: "audited",
      run: { stage: "audit", stopped: "stopped by user", stopped_stage: "audit" },
    });
    expect(signed?.line).toBe("Ready to join");
    expect(signed?.word).toBe("ready");
  });

  test("a finished wheel reads ready, which is what the audit signing off means", () => {
    const done = reg(reconciled(), { run: { stage: "audit", done: true } });
    expect(done?.line).toBe("Ready to join");
  });

  test("an unbound arc under a live wheel says so, where today it says nothing", () => {
    // The `Reconciling` fall-through is silent for an unbound arc because the
    // pilot never runs for one. A running audit is a fact about the work, not a
    // promise about the pilot, so it speaks whoever is holding the arc.
    expect(reg(null, { bound: false })).toBeNull();
    const auditing = reg(null, { bound: false, run: { stage: "audit" } });
    expect(auditing?.word).toBe("auditing");
  });

  test("no arc at all leaves every other reading exactly as it was", () => {
    expect(reg(reconciled())?.line).toBe("Ready to join");
    expect(reg(reconciled(), { run: null })?.line).toBe("Ready to join");
    expect(reg(reconciled(), { run: undefined })?.line).toBe("Ready to join");
  });

  test("an audit that has signed off does not go on holding its own offer", () => {
    // `derive_stage` returns `audited` for a declared `audited` and nothing
    // else, and that is the same declaration [P05]'s gate arms the join on. So
    // the record is still live here — `arc-done` lands a tick or more later,
    // and on a run whose arc was stopped and resumed it may never land — while
    // the server has already made the offer. Holding it shut over that window
    // would be this arm telling the user to wait for a stage that is finished.
    const signed = reg(reconciled(), { stage: "audited", run: { stage: "audit" } });
    expect(signed?.line).toBe("Ready to join");
    expect(signed?.word).toBe("ready");
  });

  test("a record with no rotated stage names nothing, because nothing is seated", () => {
    // The window between `arc-start` and the first `arc-stage` line: the record
    // is live and has no seat. The arm must not fire, or the sentence
    // interpolates the absent stage into the user's face.
    const unseated = reg(reconciled(), { run: { done: false } });
    expect(unseated?.line).toBe("Ready to join");
    expect(reg(reconciled(), { run: { stage: "" } })?.line).toBe("Ready to join");
  });

  test("a busy holder still outranks the arc, and a blocker outranks both", () => {
    const busy = reg(reconciled(), { run: { stage: "audit" }, holdersBusy: true });
    expect(busy?.word).toBe("working");

    const blocked = reg(
      {
        phase: "blocked",
        blockers: [
          { kind: "base_dirty", title: "Base is dirty", detail: "main has uncommitted src/x.ts" },
        ],
      },
      { run: { stage: "audit" } },
    );
    expect(blocked?.word).toBe("blocked");
  });
});

describe("the fold has its own sentence ([P07])", () => {
  const dirt = (paths: string[]) => ({
    kind: "base-dirt",
    title: "Base work in the way",
    detail: `main has uncommitted ${paths.join(", ")}`,
    paths,
  });

  test("a fold in flight reads as committing base work, above the blocker", () => {
    // The blocker is still on the entry — the recompute that removes it is the
    // one that ends the fold — and the refusal must not paint over the act
    // clearing it. Same precedence a live join has, for the same reason.
    const folding = reg({
      phase: "blocked",
      run: "resolve-base",
      blockers: [dirt(["a.ts", "b.ts", "c.ts"])],
    });
    expect(folding?.phase).toBe("in_flight");
    expect(folding?.line).toBe("Committing base work · 3 files");
    expect(folding?.word).toBe("committing");

    // One file is one file.
    const single = reg({
      phase: "blocked",
      run: "resolve-base",
      blockers: [dirt(["a.ts"])],
    });
    expect(single?.line).toBe("Committing base work · 1 file");

    // And a fold with no paths to count says what it is doing rather than
    // claiming a count it does not have.
    const countless = reg({ phase: "blocked", run: "resolve-base" });
    expect(countless?.line).toBe("Committing base work");
  });

  test("the client's own act stands in before the feed shows the hold", () => {
    // The press goes out, the server takes the hold, the recompute follows.
    // Between the first and the third the entry says nothing is running, and a
    // register that waited for it would leave the blocker's refusal standing
    // over an act already under way.
    const pressed = reg(
      { phase: "blocked", blockers: [dirt(["a.ts", "b.ts"])] },
      { resolveAct: "resolve-base", resolvePhase: "resolving" },
    );
    expect(pressed?.line).toBe("Committing base work · 2 files");
    expect(pressed?.word).toBe("committing");
  });

  test("a fold speaks on an arc whose stage would not have spoken at all", () => {
    // `acted` is what lets a not-yet-joinable arc say anything, and a press is
    // somebody acting. Without the act in that predicate the register returns
    // null and the fold runs behind a silent row.
    const working = arcJoinRegister({
      arc: "imposer2",
      base: "main",
      stage: "implementing",
      join: { phase: "blocked", blockers: [dirt(["a.ts"])] },
      resolveAct: "resolve-base",
      resolvePhase: "resolving",
    });
    expect(working?.word).toBe("committing");
  });

  test("a fold outranks the blocker but not a dropped wire", () => {
    const offline = reg(
      { phase: "blocked", run: "resolve-base", blockers: [dirt(["a.ts"])] },
      { connected: false },
    );
    expect(offline?.word).toBe("offline");
  });

  test("the ladder's resolve still reads as reconciling", () => {
    const ladder = reg({
      phase: "conflicted",
      run: "resolve",
      conflicts: ["a.rs"],
    });
    expect(ladder?.word).toBe("reconciling");
    expect(ladder?.line).toBe("Reconciling with main — resolving 1 file");
  });
});
