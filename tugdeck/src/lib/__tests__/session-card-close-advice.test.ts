/**
 * session-card-close-advice.test.ts — the rule behind the Session card's
 * close confirm: what waives, what stands, and what the popover says.
 */

import { describe, test, expect } from "bun:test";
import {
  sessionCloseAdviceFor,
  UNSENT_DRAFT_CLOSE_MESSAGE,
  type SessionCardCloseState,
} from "@/lib/session-card-close-advice";

/** An attached session holding nothing: opened, never spoken to. */
const EMPTY_SESSION = {
  transcriptLength: 0,
  hasActiveTurn: false,
  queuedSendCount: 0,
  phase: "idle",
} as const;

function state(over: Partial<SessionCardCloseState> = {}): SessionCardCloseState {
  return {
    holdsDraft: false,
    session: null,
    restorePassSettled: true,
    restorePending: false,
    ...over,
  };
}

describe("session card close advice", () => {
  test("a card that never attached waives — nothing to protect", () => {
    expect(sessionCloseAdviceFor(state())).toEqual({ waive: true });
  });

  test("an unattached card holds the guard until the restore pass settles", () => {
    // Before the pass settles, a blank-looking card may be one whose
    // session is still on its way back.
    expect(
      sessionCloseAdviceFor(state({ restorePassSettled: false })).waive,
    ).toBe(false);
  });

  test("an unattached card with a restore inbound does not waive", () => {
    expect(sessionCloseAdviceFor(state({ restorePending: true })).waive).toBe(
      false,
    );
  });

  test("attached but never sent waives", () => {
    expect(sessionCloseAdviceFor(state({ session: EMPTY_SESSION }))).toEqual({
      waive: true,
    });
  });

  test("a transcript keeps the guard, in the pane's own words", () => {
    const advice = sessionCloseAdviceFor(
      state({ session: { ...EMPTY_SESSION, transcriptLength: 4 } }),
    );
    expect(advice.waive).toBe(false);
    expect(advice.message ?? null).toBeNull();
  });

  test("a turn in flight, a queued send, or a busy phase all keep the guard", () => {
    expect(
      sessionCloseAdviceFor(
        state({ session: { ...EMPTY_SESSION, hasActiveTurn: true } }),
      ).waive,
    ).toBe(false);
    expect(
      sessionCloseAdviceFor(
        state({ session: { ...EMPTY_SESSION, queuedSendCount: 1 } }),
      ).waive,
    ).toBe(false);
    expect(
      sessionCloseAdviceFor(
        state({ session: { ...EMPTY_SESSION, phase: "replaying" } }),
      ).waive,
    ).toBe(false);
  });

  test("an unsent draft never waives, and names itself in the confirm", () => {
    // The composer is the one thing on an otherwise-empty card that only
    // the editor holds: closing over it is data loss.
    for (const session of [null, EMPTY_SESSION]) {
      expect(sessionCloseAdviceFor(state({ holdsDraft: true, session }))).toEqual({
        waive: false,
        message: UNSENT_DRAFT_CLOSE_MESSAGE,
      });
    }
  });
});
