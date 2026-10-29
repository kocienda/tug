
/**
 * The evidence face as a table: one feed state in, one face out.
 *
 * The sentence is the register's — `arc-join-register.test.ts` walks that
 * table, state by state — and a refusal rides the control that refuses,
 * which `REFUSAL_REACHABILITY` below pins to the composer or to a named wait.
 * What this file owns is the pair the report section dispatches on: the
 * outcome the tones follow, and whether a base fold is running.
 */

import { describe, expect, test } from "bun:test";

import {
  deriveJoinFace,
  type JoinFace,
} from "@/components/tugways/cards/session-changes/session-changes-arc-join";
import {
  REFUSAL_REACHABILITY,
  joinDisabledReason,
  type JoinGateReason,
} from "../join-mode-controller";
import type { ArcJoinStateWire } from "@/lib/changeset-types";

const CONFLICTED: ArcJoinStateWire = { phase: "conflicted", conflicts: ["a.rs"] };

/** The face for a feed state, with everything else at rest. */
function face(
  join: ArcJoinStateWire | null,
  over: Partial<Parameters<typeof deriveJoinFace>[0]> = {},
): JoinFace {
  return deriveJoinFace({
    join,
    resolvePhase: "idle",
    ...over,
  });
}

describe("the outcome and the fold face, per state", () => {
  test("blocked derives blocked, and the blockers are the evidence", () => {
    const blocked = face({
      phase: "blocked",
      blockers: [{ kind: "base-dirt", title: "Base work in the way", detail: "commit outstanding changes", paths: ["x.ts"] }],
    });
    expect(blocked.outcome).toBe("blocked");
    expect(blocked.resolve).toBe("none");
  });

  test("conflicted is the audit's to resolve, and the face offers nothing", () => {
    const conflicted = face(CONFLICTED);
    expect(conflicted.outcome).toBe("conflicted");
    expect(conflicted.resolve).toBe("none");
  });

  test("a clean preview is clean", () => {
    expect(face({ phase: "previewed" }).outcome).toBe("clean");
  });

  test("a fold reads folding, from the press or from the server's run", () => {
    expect(face(null, { resolvePhase: "resolving", resolveAct: "resolve-base" }).resolve).toBe(
      "folding",
    );
    // The overlay dies with the page; `run` is the feed's account of what it
    // is doing right now, so a reload still sees the fold.
    expect(face({ phase: "blocked", run: "resolve-base" }).resolve).toBe("folding");
  });

  test("a refused fold reads error", () => {
    expect(face({ phase: "blocked" }, { resolvePhase: "error" }).resolve).toBe("error");
  });

  test("an arc the feed says nothing about derives blocked", () => {
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
    // `outcome` joined it when the shade was disarmed — a conflicted arc is
    // the re-audit's to reconcile, a blocked one is cleared outside the app, and
    // each blocker carries its own act sentence where the table used to carry
    // a slot.
    for (const reason of ["turn", "pending", "outcome"] as const) {
      expect(REFUSAL_REACHABILITY[reason].slot).toBeNull();
      expect(REFUSAL_REACHABILITY[reason].where).toBe("time");
    }
    // The sentences themselves, where the control that refuses shows them.
    expect(joinDisabledReason("turn", "clean")).toBe(
      "Wait for the turn to finish",
    );
    expect(joinDisabledReason("pending", "clean")).toBe("Joining…");
  });

  test("the message's control is the composer, which is where it is typed", () => {
    expect(REFUSAL_REACHABILITY["empty-message"]).toEqual({
      slot: "tug-prompt-entry",
      where: "composer",
    });
  });
});
