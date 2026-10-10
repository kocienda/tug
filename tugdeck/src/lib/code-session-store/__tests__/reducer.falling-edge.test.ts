/**
 * The falling-edge audit: every way a turn can die must put the session
 * back on a phase that stops the in-flight indicators.
 *
 * The Z1C wave and the Z2 STATE dot are pure functions of `phase` (and
 * `interruptInFlight`) — nothing else gates them. So a wave still bowing
 * on a settled deck is never a CSS bug and never a mount bug: it is a
 * turn that ended without any event moving `phase` off a live value.
 * That is the defect this file exists to make impossible.
 *
 * The matrix is live phase × terminal event. Each live phase is reached
 * by driving the real reducer with real events (no hand-built states —
 * a fabricated `phase` would test the assertion, not the machine), then
 * each terminal event is dispatched and the resulting phase checked
 * against {@link QUIET_PHASES}.
 *
 * `interrupt_action` is the one terminal that legitimately leaves the
 * phase live: CASE B dooms the turn but waits for the wire's
 * `turn_complete(error)` to commit it. It stops the indicators anyway,
 * via `interruptInFlight` — so it is audited on that gate instead, and
 * on the requirement that the turn actually reaches quiet once the echo
 * lands.
 */

import { describe, it, expect } from "bun:test";

import {
  reduce,
  createInitialState,
  type CodeSessionState,
} from "@/lib/code-session-store/reducer";
import type { CodeSessionEvent } from "@/lib/code-session-store/events";
import type { CodeSessionPhase } from "@/lib/code-session-store/types";
import { FIXTURE_IDS } from "@/lib/code-session-store/testing/golden-catalog";
import { sessionZ1CContent } from "@/components/tugways/cards/session-card-z1c";

/** Phases on which no in-flight indicator may animate. */
const QUIET_PHASES: ReadonlySet<CodeSessionPhase> = new Set<CodeSessionPhase>([
  "idle",
  "errored",
  "awaiting_approval",
  "replaying",
]);

function fresh(): CodeSessionState {
  return createInitialState(FIXTURE_IDS.TUG_SESSION_ID, "test", "new");
}

function applyAll(
  state: CodeSessionState,
  events: ReadonlyArray<CodeSessionEvent>,
): CodeSessionState {
  let current = state;
  for (const ev of events) current = reduce(current, ev).state;
  return current;
}

const SEND: CodeSessionEvent = {
  type: "send",
  text: "hi",
  atoms: [],
  content: [{ type: "text", text: "hi" }],
  turnKey: "k1",
};

function delta(text: string): CodeSessionEvent {
  return {
    type: "assistant_text",
    msg_id: "m1",
    block_index: 0,
    text,
    is_partial: true,
    seq: 0,
    rev: 0,
    status: "partial",
  };
}

/**
 * Reach each live phase through the real event ladder. The value is a
 * state the machine actually produces, not one assembled by hand.
 */
const LIVE_PHASE_ROUTES: ReadonlyArray<{
  phase: CodeSessionPhase;
  reach: () => CodeSessionState;
}> = [
  {
    phase: "submitting",
    reach: () => applyAll(fresh(), [SEND]),
  },
  {
    // The phase ladder past `submitting` is an assistant-text event
    // count: the first delta reaches `awaiting_first_token`, the second
    // `streaming`.
    phase: "awaiting_first_token",
    reach: () => applyAll(fresh(), [SEND, delta("one")]),
  },
  {
    phase: "streaming",
    reach: () => applyAll(fresh(), [SEND, delta("one"), delta("two")]),
  },
  {
    phase: "tool_work",
    reach: () =>
      applyAll(fresh(), [
        SEND,
        delta("one"),
        delta("two"),
        {
          type: "tool_use",
          msg_id: "m1",
          tool_use_id: "t1",
          tool_name: "Bash",
          input: { command: "true" },
          seq: 0,
        },
      ]),
  },
];

/**
 * Every event that means "this turn is over, badly". Each arrives already
 * routed to this card by `acceptFrame`'s tsid match, so each must end the
 * turn from whatever phase the turn is in.
 *
 * `interrupt_action` is deliberately absent — it is the one terminal that
 * legitimately leaves the phase live (see the module docstring).
 */
const TERMINAL_EVENTS: ReadonlyArray<{
  name: string;
  event: CodeSessionEvent;
}> = [
  {
    name: "turn_complete(error)",
    event: { type: "turn_complete", msg_id: "m1", result: "error", seq: 0 },
  },
  {
    // The wire's own error frame — tagged `error`, not `wire_error`
    // (`wire_error` is the `lastError.cause` it stamps, not the event).
    name: "wire error frame",
    event: { type: "error", message: "boom", recoverable: false, site: "drain_eof_open_turn" },
  },
  {
    name: "session_state_errored",
    event: { type: "session_state_errored", detail: "errored" },
  },
  {
    name: "transport_close",
    event: { type: "transport_close" },
  },
  {
    name: "session_unknown",
    event: { type: "session_unknown" },
  },
  {
    name: "session_not_owned",
    event: { type: "session_not_owned" },
  },
];

describe("every terminal event lands a live turn on a quiet phase", () => {
  for (const route of LIVE_PHASE_ROUTES) {
    it(`reaches ${route.phase} through the real ladder`, () => {
      expect(route.reach().phase).toBe(route.phase);
    });

    for (const terminal of TERMINAL_EVENTS) {
      it(`${route.phase} + ${terminal.name} → quiet`, () => {
        const after = applyAll(route.reach(), [terminal.event]);
        expect([terminal.name, after.phase, QUIET_PHASES.has(after.phase)]).toEqual(
          [terminal.name, after.phase, true],
        );
      });
    }
  }
});

describe("a write rejected mid-turn still ends the turn", () => {
  it("ends a turn whose approval response was rejected", () => {
    // The write that dies here is the approval decision, and answering an
    // approval restores the phase to `streaming` / `tool_work` BEFORE the
    // rejection can arrive. A gate that only recognized the
    // waiting-for-first-token phases could never see this one.
    const gated = applyAll(LIVE_PHASE_ROUTES[3].reach(), [
      {
        type: "control_request_forward",
        request_id: "r1",
        is_question: false,
        tool_name: "Bash",
        tool_use_id: "t1",
        input: { command: "true" },
      },
    ]);
    expect(gated.phase).toBe("awaiting_approval");

    const answered = applyAll(gated, [
      { type: "respond_approval", request_id: "r1", decision: "allow" },
    ]);
    expect(QUIET_PHASES.has(answered.phase)).toBe(false);

    const rejected = applyAll(answered, [{ type: "session_not_owned" }]);
    expect(rejected.phase).toBe("errored");
    expect(
      sessionZ1CContent(rejected.phase, rejected.interruptInFlight),
    ).toBeNull();
  });
});

describe("the wave itself falls with the phase", () => {
  it("shows on every live phase and on no quiet one", () => {
    for (const route of LIVE_PHASE_ROUTES) {
      expect([route.phase, sessionZ1CContent(route.phase, false) !== null]).toEqual(
        [route.phase, true],
      );
    }
    for (const phase of QUIET_PHASES) {
      expect([phase, sessionZ1CContent(phase, false)]).toEqual([phase, null]);
    }
  });

  it("stops the moment an interrupt is in flight, before the echo lands", () => {
    // CASE B leaves the phase live on purpose — the turn is not committed
    // until the wire answers. The wave must not bow through that window.
    const mid = applyAll(LIVE_PHASE_ROUTES[2].reach(), [
      { type: "interrupt_action" },
    ]);
    expect(mid.interruptInFlight).toBe(true);
    expect(QUIET_PHASES.has(mid.phase)).toBe(false);
    expect(sessionZ1CContent(mid.phase, mid.interruptInFlight)).toBeNull();
  });

  it("reaches a quiet phase once the interrupt's echo lands", () => {
    const done = applyAll(LIVE_PHASE_ROUTES[2].reach(), [
      { type: "interrupt_action" },
      { type: "turn_complete", msg_id: "m1", result: "error", seq: 0 },
    ]);
    expect(QUIET_PHASES.has(done.phase)).toBe(true);
    expect(done.interruptInFlight).toBe(false);
    expect(sessionZ1CContent(done.phase, done.interruptInFlight)).toBeNull();
  });

  it("pulls a no-content turn straight back to idle", () => {
    // CASE A: interrupted before any answer content — no wire round-trip,
    // no committed entry, and the wave is gone immediately.
    const after = applyAll(applyAll(fresh(), [SEND]), [
      { type: "interrupt_action" },
    ]);
    expect(after.phase).toBe("idle");
    expect(sessionZ1CContent(after.phase, after.interruptInFlight)).toBeNull();
  });
});
