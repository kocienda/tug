/**
 * The evidence face as a table: one feed state in, one face out.
 *
 * The face used to also yield the standing readiness line and the ready
 * boolean; both left with the standing line itself ([D142]). The sentence is
 * the register's — `dash-join-register.test.ts` walks that table, state by
 * state — and a refusal rides the control that refuses, which
 * `REFUSAL_REACHABILITY` below pins to the composer or to a named wait. What
 * this file still owns is the pair the report section dispatches on: the
 * outcome the tones follow, and which resolve face the ladder's state has
 * earned.
 *
 * The second half drives the real ladder frames through the real overlay
 * store, because the one ranking that cannot be tested from a hand-built
 * state is the one that matters most: a candidate on the feed outranks
 * whatever the overlay holds, which is what makes a resolution survive a
 * reload.
 */

import { beforeEach, describe, expect, test } from "bun:test";

import {
  attachChangesetJoinStore,
  _ingestJoinFrameForTest,
  _resetChangesetJoinStoreForTest,
} from "../changeset-join-store";
import {
  QUESTION_DECLINED_TO_CHOOSE,
  deriveJoinFace,
  joinQuestionAsParsed,
  type JoinFace,
} from "@/components/tugways/cards/session-changes/session-changes-dash-join";
import {
  REFUSAL_REACHABILITY,
  joinDisabledReason,
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

/** The face for a feed state, with everything else at rest. */
function face(
  join: DashJoinStateWire | null,
  over: Partial<Parameters<typeof deriveJoinFace>[0]> = {},
): JoinFace {
  return deriveJoinFace({
    join,
    resolvePhase: "idle",
    ...over,
  });
}

beforeEach(() => _resetChangesetJoinStoreForTest());

describe("the outcome and the resolve face, per state", () => {
  test("blocked derives blocked, and the blockers are the evidence", () => {
    // The face states nothing above the blockers — each carries its own act
    // sentence beside its own detail, and the register fronts the word.
    const blocked = face({
      phase: "blocked",
      blockers: [{ kind: "base-dirt", detail: "commit outstanding changes", paths: ["x.ts"] }],
    });
    expect(blocked.outcome).toBe("blocked");
    expect(blocked.resolve).toBe("none");
  });

  test("conflicted and untried offers the ladder", () => {
    const conflicted = face(CONFLICTED);
    expect(conflicted.outcome).toBe("conflicted");
    expect(conflicted.resolve).toBe("offer");
  });

  test("stale demotes itself, and re-offers", () => {
    const stale = face({
      phase: "previewed",
      stale_note: "main moved since this was resolved — resolve again",
    });
    expect(stale.outcome).toBe("stale");
    expect(stale.resolve).toBe("offer");
  });

  test("resolving: a run in flight is progress", () => {
    const running = face(CONFLICTED, { resolvePhase: "resolving" });
    expect(running.resolve).toBe("progress");
  });

  test("a candidate reads resolved, whatever its history was", () => {
    // A resolved conflict is a joinable dash even though its history is
    // `conflicted` — the candidate is what would land.
    const resolved = face(RESOLVED);
    expect(resolved.outcome).toBe("clean");
    expect(resolved.resolve).toBe("resolved");
  });

  test("the server's own run fact reads as progress after a reload", () => {
    // The overlay phase dies with the page; `run` is the feed's account of
    // what it is doing right now, so a second deck watching the same dash
    // still sees the minutes of real work.
    const running = face({ ...CONFLICTED, run: "resolve" });
    expect(running.resolve).toBe("progress");
  });

  test("a dash the feed says nothing about derives blocked", () => {
    const silent = face(null);
    expect(silent.outcome).toBe("blocked");
    expect(silent.resolve).toBe("none");
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
  // face lost its standing line ([D142]). There is exactly one surface a
  // refusal can appear on — the control that refuses — and one honest
  // alternative, which is to name a wait. A table with no third option cannot
  // drift back into naming a button that is not there, and a reason that
  // tried would be a type error rather than a bug somebody has to notice.
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
    // The sentences themselves, where the control that refuses shows them.
    expect(joinDisabledReason("turn", "clean", null)).toBe(
      "Wait for the turn to finish",
    );
    expect(joinDisabledReason("pending", "clean", null)).toBe("Joining…");
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

    expect(face(CONFLICTED, { resolvePhase: phase() }).resolve).toBe("offer");

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
