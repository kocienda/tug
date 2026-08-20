/**
 * The landing face as a table: one feed state in, one control and one sentence
 * out.
 *
 * This is the shape the whole rework exists for. The old face decided what to
 * mount across five independent conditionals, and the state that broke was the
 * one where they disagreed — a Join button standing greyed out beside a Resolve
 * button, its refusal computed in a place the press never reached. So the rule
 * is now a single function with a single answer, and what these cases walk is
 * every row of it: **exactly one act per state, and a sentence wherever there
 * is no act at all.**
 *
 * The second half drives the real ladder frames through the real overlay store,
 * because the one ranking that cannot be tested from a hand-built state is the
 * one that matters most: a candidate on the feed outranks whatever the overlay
 * holds, which is what makes a resolution survive a reload.
 */

import { beforeEach, describe, expect, test } from "bun:test";

import {
  attachChangesetJoinStore,
  _ingestJoinFrameForTest,
  _resetChangesetJoinStoreForTest,
} from "../changeset-join-store";
import {
  JOIN_CONTROL,
  QUESTION_DECLINED_TO_CHOOSE,
  deriveJoinFace,
  joinQuestionAsParsed,
  type JoinFace,
} from "@/components/tugways/cards/session-changes/session-changes-dash-join";
import {
  REFUSAL_REACHABILITY,
  type JoinGateReason,
} from "../join-mode-controller";
import type { DashJoinStateWire } from "@/lib/changeset-types";

const fakeConn = { onFrame: () => () => {} } as never;
const K = { project_dir: "/u/src/tugtool", dash: "demo" };

const CONFLICTED: DashJoinStateWire = { phase: "conflicted", conflicts: ["a.rs"] };
const RESOLVED: DashJoinStateWire = {
  phase: "resolved",
  conflicts: ["a.rs"],
  candidate: "cafe1234",
  resolved: [{ path: "a.rs", resolved_by: "driver" }],
};

/** The same candidate, with the project's own checks green over it. */
const VERIFIED: DashJoinStateWire = {
  ...RESOLVED,
  verification: {
    tier0: "green",
    tier1: "green",
    base_sha: "base0000",
    candidate_sha: "cafe1234",
  },
};

/** …and red, which is the state the override exists for. */
const RED: DashJoinStateWire = {
  ...RESOLVED,
  verification: {
    tier0: "red",
    tier1: "unrun",
    base_sha: "base0000",
    candidate_sha: "cafe1234",
    failures: ["cargo check: exited 101"],
  },
};

/** The face for a feed state, with everything else at rest. */
function face(
  join: DashJoinStateWire | null,
  over: Partial<Parameters<typeof deriveJoinFace>[0]> = {},
): JoinFace {
  return deriveJoinFace({
    join,
    resolvePhase: "idle",
    joinPhase: "idle",
    turnInProgress: false,
    interrupted: false,
    ...over,
  });
}

beforeEach(() => _resetChangesetJoinStoreForTest());

describe("one control per state (Table T01)", () => {
  test("blocked: the blockers are the text, and no control claims to clear them", () => {
    // Each blocker renders its own act beside its own detail, so the face
    // mounts no single control — and states nothing above them, because a
    // second sentence here would be the same refusal twice.
    const blocked = face({
      phase: "blocked",
      blockers: [{ kind: "base-dirt", detail: "commit outstanding changes", paths: ["x.ts"] }],
    });
    expect(blocked.outcome).toBe("blocked");
    expect(blocked.control).toBeNull();
    expect(blocked.line).toBeNull();
  });

  test("conflicted: the ladder, and only the ladder", () => {
    const conflicted = face(CONFLICTED);
    expect(conflicted.outcome).toBe("conflicted");
    expect(conflicted.control).toBe(JOIN_CONTROL.resolve);
    expect(conflicted.line).toBeNull();
  });

  test("stale: the server's note is the text, and the ladder is the act", () => {
    const stale = face({
      phase: "previewed",
      stale_note: "main moved since this was resolved — resolve again",
    });
    expect(stale.outcome).toBe("stale");
    expect(stale.control).toBe(JOIN_CONTROL.resolve);
    expect(stale.line).toBeNull();
  });

  test("resolving: a run in flight offers nothing, because nothing would help", () => {
    const running = face(CONFLICTED, { resolvePhase: "resolving" });
    expect(running.resolve).toBe("progress");
    expect(running.control).toBeNull();
  });

  test("resolved and unverified: a wait, named, with nothing to press", () => {
    // The pilot builds the joined tree at `built` without being asked, so an
    // unrun verdict is a run about to happen rather than a control nobody has
    // clicked. The old sentence — "Verify the joined tree first" — named a
    // button that no longer exists, which is the [L31] failure the register
    // and the reachability table exist to catch.
    const unrun = face(RESOLVED);
    expect(unrun.outcome).toBe("clean");
    expect(unrun.resolve).toBe("resolved");
    expect(unrun.control).toBeNull();
    expect(unrun.line).toBe("Building the joined tree");
  });

  test("resolved and red: no control, and a line naming the decision", () => {
    // The state that used to carry JOIN ANYWAY. The refusal it cleared is
    // gone: a red passes the gate and arms the composer's land button, so the
    // face has no act left to offer and says where the act lives instead
    // ([P05]). A "Ready to join" here would be the resting lie on exactly the
    // state that most needs reading.
    const red = face(RED);
    expect(red.control).toBeNull();
    expect(red.line).toBe(
      "Build red on the joined tree — joining is a decision, made in the composer",
    );
  });

  test("resolved and green: no control at all, and a line naming the route", () => {
    // The state the JOIN button used to occupy. With no control on the row the
    // sentence is the only thing between the reader and a dead end, so it has
    // to name where joining happens rather than merely asserting readiness.
    const verified = face(VERIFIED);
    expect(verified.control).toBeNull();
    expect(verified.line).toBe("Ready to join — ⌃⌘C, or /dash-join");
  });

  test("a red the user has overridden joins like a green", () => {
    // The override is scoped to the candidate it was decided over, so the same
    // press against a different sha does nothing — which is what stops one
    // Join anyway from blessing every candidate that follows it.
    // Read off the dash, not off this deck: the override is a durable server
    // fact now, so it arrives on the feed entry beside the verdict it defeats.
    const overridden = face({ ...RED, override_for: "cafe1234" });
    expect(overridden.control).toBeNull();
    expect(overridden.line).toBe("Ready to join — ⌃⌘C, or /dash-join");
    // An override pinned to a different sha does not cover this candidate, so
    // the row is back to stating the decision.
    const stale = face({ ...RED, override_for: "beef5678" });
    expect(stale.line).toBe(
      "Build red on the joined tree — joining is a decision, made in the composer",
    );
  });

  test("clean and verified: same — a sentence and no button", () => {
    // Verified, because a clean dash is not joinable on the strength of git
    // finding no overlapping text ([P03]). Entering join mode resolves it, the
    // server judges what that built, and the row reaches this state only once
    // there is a green verdict about the tree that would land.
    const clean = face({
      phase: "previewed",
      candidate: "cafe1234",
      verification: {
        tier0: "green",
        tier1: "green",
        base_sha: "base0000",
        candidate_sha: "cafe1234",
      },
    });
    expect(clean.outcome).toBe("clean");
    expect(clean.control).toBeNull();
    expect(clean.line).toBe("Ready to join — ⌃⌘C, or /dash-join");
  });

  test("clean and not yet judged: the exam, in the window before the candidate", () => {
    // The gap between entering join mode and the auto-resolve anchoring a
    // candidate. It used to read as ready — the verdict was "not applicable"
    // with no candidate to be about — which made the one second where nothing
    // had been built the one second a join could slip through.
    const unjudged = face({ phase: "previewed" });
    expect(unjudged.outcome).toBe("clean");
    expect(unjudged.control).toBeNull();
    expect(unjudged.line).toBe("Building the joined tree");
  });

  test("a join in flight: the wait is named, and a second press is impossible", () => {
    // No control, so nothing on the row can double-submit; the sentence is what
    // discharges the refusal.
    const joining = face({ phase: "previewed" }, { joinPhase: "pending" });
    expect(joining.control).toBeNull();
    expect(joining.line).toBe("Joining…");
  });

  test("a turn in flight names the wait over every state, and holds the act", () => {
    const midTurn = face(CONFLICTED, { turnInProgress: true });
    expect(midTurn.line).toBe("Wait for the turn to finish");
    // Resolve survives a running turn on purpose: it builds a candidate off to
    // the side and touches no checkout, so the one escape from a conflicted
    // dash is not locked behind the agent.
    expect(midTurn.control).toBe(JOIN_CONTROL.resolve);
  });

  test("an interrupted teardown outranks everything else on the row", () => {
    // It refuses every other act server-side, so offering one would be an
    // invitation to a refusal the row cannot show.
    const interrupted = face(CONFLICTED, { interrupted: true });
    expect(interrupted.control).toBe(JOIN_CONTROL.resume);
  });

  test("a dash the feed says nothing about refuses, and says so", () => {
    const silent = face(null);
    expect(silent.outcome).toBe("blocked");
    expect(silent.control).toBeNull();
    expect(silent.line).toBe("Clear what blocks this join first");
  });
});

describe("no state is both silent and inert", () => {
  test("every state either offers an act or states a reason", () => {
    // The invariant the dead press violated: a row that offers nothing must say
    // why, or the reader is looking at a surface with no next move and no
    // explanation — which is what "the button does nothing" felt like from the
    // outside ([L31]).
    const states: [string, JoinFace][] = [
      ["blocked", face({ phase: "blocked", blockers: [{ kind: "off-base", detail: "d" }] })],
      ["conflicted", face(CONFLICTED)],
      ["stale", face({ phase: "previewed", stale_note: "moved" })],
      ["resolving", face(CONFLICTED, { resolvePhase: "resolving" })],
      ["unread", face(RESOLVED)],
      ["read", face({ ...RESOLVED, reviewed: true })],
      ["clean", face({ phase: "previewed" })],
      ["joining", face({ phase: "previewed" }, { joinPhase: "pending" })],
      ["interrupted", face(CONFLICTED, { interrupted: true })],
      ["silent feed", face(null)],
    ];
    for (const [name, f] of states) {
      const speaks =
        f.control !== null || f.line !== null || f.statedBelow || f.resolve === "progress";
      expect(speaks, `${name} offers no act and states no reason`).toBe(true);
    }
  });
});

describe("every refusal points at the composer, or at a wait ([P09])", () => {
  // [L31] made refusals speak; this is the half it did not cover. The
  // 2026-08-18 deadlock produced a true sentence — "Review what the ladder
  // resolved first" — pointing at a Reviewed button that was not on screen,
  // because the panel holding it read a store cell nothing was writing. A
  // refusal naming an unmounted control is silence in the user's terms.
  //
  // The claim is stronger now than it was, and it is stronger *because* the
  // shade lost its controls. There is exactly one surface a refusal can point
  // at — the composer — and one honest alternative, which is to name a wait.
  // A table with no third option cannot drift back into naming a button that
  // is not there, and a reason that tried would be a type error rather than a
  // bug somebody has to notice.
  test("no row names anything but the composer or a wait", () => {
    const reasons = Object.keys(REFUSAL_REACHABILITY) as JoinGateReason[];
    // Not a hand-kept list: `satisfies Record<JoinGateReason, …>` is what makes
    // the table total, and reading the keys back is what makes this test see a
    // reason somebody adds later.
    expect(reasons.length).toBeGreaterThan(0);
    for (const reason of reasons) {
      const row = REFUSAL_REACHABILITY[reason];
      expect([`${reason}: composer`, `${reason}: time`]).toContain(
        `${reason}: ${row.where}`,
      );
      // A wait has nothing to point at, and a composer refusal points at the
      // composer. Any other pairing is a slot on a surface the arc no longer
      // has.
      if (row.where === "time") expect(row.slot).toBeNull();
      else expect(row.slot).toBe("tug-prompt-entry");
    }
  });

  test("the time-cleared reasons name the wait instead of a control", () => {
    // Not an exemption from [L31] — the reason there is nothing to point at is
    // exactly why the sentence has to carry the whole answer.
    //
    // `unverified` and `verifying` joined this set when the pilot took over:
    // the joined tree is built at `built` without a gesture, so an unrun
    // verdict is a run about to happen. `outcome` joined it when the shade was
    // disarmed — a conflicted dash is the pilot's to reconcile, a blocked one
    // is cleared outside the app, and each blocker carries its own act
    // sentence where the table used to carry a slot.
    for (const reason of ["turn", "pending", "outcome", "unverified", "verifying"] as const) {
      expect(REFUSAL_REACHABILITY[reason].slot).toBeNull();
      expect(REFUSAL_REACHABILITY[reason].where).toBe("time");
    }
    expect(face(CONFLICTED, { turnInProgress: true }).line).toBe(
      "Wait for the turn to finish",
    );
    expect(face({ phase: "previewed" }, { joinPhase: "pending" }).line).toBe("Joining…");
  });

  test("a refused state still says its own sentence, whatever the row says", () => {
    // The table says where; the face says what. Losing the controls must not
    // cost the sentences — a blocked dash still names the act that clears it,
    // and a conflicted one still names its files.
    const blocked = face({
      phase: "blocked",
      blockers: [{ kind: "off-base", detail: "check out main" }],
    });
    expect(blocked.statedBelow).toBe(true);
    expect(face(CONFLICTED).statedBelow).toBe(true);
    // The stale note is the server's own sentence and renders as its own
    // block, so `line` stays null rather than saying it twice.
    expect(
      face({ phase: "previewed", stale_note: "main moved since this was resolved" })
        .statedBelow,
    ).toBe(true);
  });

  test("the message's control is the composer, which is where it is typed", () => {
    expect(REFUSAL_REACHABILITY["empty-message"]).toEqual({
      slot: "tug-prompt-entry",
      where: "composer",
    });
  });
});

describe("the overlay never outranks what is in git", () => {
  test("a live run shows progress, and its result comes back from the feed", () => {
    const store = attachChangesetJoinStore(fakeConn);
    const phase = (): Parameters<typeof deriveJoinFace>[0]["resolvePhase"] =>
      store.state(K.project_dir, K.dash).phase;

    expect(face(CONFLICTED, { resolvePhase: phase() }).control).toBe(JOIN_CONTROL.resolve);

    _ingestJoinFrameForTest({
      action: "changeset_join_resolve_delta",
      ...K,
      path: "a.rs",
      rung: "ai",
      status: "streaming",
      text: "merging",
    });
    expect(face(CONFLICTED, { resolvePhase: phase() }).resolve).toBe("progress");

    _ingestJoinFrameForTest({
      action: "changeset_join_resolve_ok",
      ...K,
      resolved: [{ path: "a.rs", resolved_by: "driver" }],
      unresolved: [],
      candidate_commit: "cafe1234",
      shape: "squash",
    });
    // The overlay is back to idle; the resolved face is the feed's doing.
    expect(phase()).toBe("idle");
    expect(face(RESOLVED, { resolvePhase: phase() }).resolve).toBe("resolved");
  });

  test("a resolution survives the overlay it was built under", () => {
    // The reload beat at the derivation layer: the page is new, so the store
    // holds nothing, and the only thing saying a candidate exists is the feed.
    // Ranked the other way this reads `none` — a clean dash with no review
    // panel, landing an unread machine merge.
    expect(face(RESOLVED, { resolvePhase: "idle" }).resolve).toBe("resolved");
  });

  test("a run that ends still conflicting says so, and re-offers the ladder", () => {
    const store = attachChangesetJoinStore(fakeConn);
    _ingestJoinFrameForTest({
      action: "changeset_join_resolve_ok",
      ...K,
      resolved: [{ path: "a.rs", resolved_by: "rerere" }],
      unresolved: ["b.rs"],
      shape: "squash",
    });
    const state = store.state(K.project_dir, K.dash);
    expect(state.error).toContain("b.rs");
    const f = face(CONFLICTED, { resolvePhase: state.phase });
    expect(f.resolve).toBe("error");
    expect(f.control).toBe(JOIN_CONTROL.resolve);
  });
});

describe("the escalation, narrowed for the wizard", () => {
  test("a resolver question becomes one single-select question", () => {
    // Single-select and never multi: the resolver asks which reconciliation to
    // make, and two incompatible intents cannot both be taken. The description
    // rides along because it is what makes an option a *concrete resolution*
    // rather than a label the reader has to decode.
    const [parsed] = joinQuestionAsParsed({
      request_id: "join-demo-7",
      question: "Which name wins?",
      options: [
        { label: "the dash", description: "keep the dash's rename" },
        { label: "the base", description: "keep what main renamed it to" },
      ],
    });
    expect(parsed.question).toBe("Which name wins?");
    expect(parsed.multiSelect).toBe(false);
    expect(parsed.options).toEqual([
      { label: "the dash", description: "keep the dash's rename" },
      { label: "the base", description: "keep what main renamed it to" },
    ]);
  });

  test("declining to choose is an answer, not a silence", () => {
    // The wizard always offers Cancel, and a blocked resolver has no turn to
    // interrupt — so Cancel has to *say something*, or the resolve waits out
    // its whole deadline over a dialog nobody is looking at any more.
    expect(QUESTION_DECLINED_TO_CHOOSE).toContain("declined to choose");
    expect(QUESTION_DECLINED_TO_CHOOSE).toContain("without guessing");
  });
});
