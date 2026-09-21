/**
 * Reducer tests for the terminal chokepoint: `interruptInFlight` cannot
 * outlive its turn.
 *
 * `handleInterrupt`'s CASE B sets the flag and schedules nothing. Its only
 * clearer was `resetPerTurnTelemetry`, which in an interrupting state is
 * reachable only through `handleTurnComplete` — so the flag's sole clearer
 * was one frame type. Every terminal that ended the turn some other way left
 * it standing, and `session-phase-visual.ts` reads `interruptInFlight` *above*
 * the phase, so a card that had genuinely errored went on painting
 * "Interrupting" with nothing able to correct it.
 *
 * `enterErrored` is the chokepoint that fixes it, and these tests are its
 * pin: one row per terminal, each starting from a CASE B interrupt and
 * asserting the phase went `errored` **and** every per-interrupt field
 * cleared.
 *
 * The table is exhaustive by construction rather than by grep. It is a
 * `Record` keyed on `lastError`'s own `cause` union, which is closed and
 * lives in `types.ts` — so a new terminal, which needs a cause of its own for
 * its banner to say anything, cannot be added without a row here or the file
 * stops compiling.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";

import {
  reduce,
  createInitialState,
  type CodeSessionState,
} from "@/lib/code-session-store/reducer";
import type { CodeSessionEvent } from "@/lib/code-session-store/events";
import type { Effect } from "@/lib/code-session-store/effects";
import { sessionSessionPhaseKey } from "@/lib/code-session-store/session-phase-visual";
import { FIXTURE_IDS } from "@/lib/code-session-store/testing/golden-catalog";

/** The closed cause union every terminal's banner names itself with. */
type LastErrorCause = NonNullable<CodeSessionState["lastError"]>["cause"];

function fresh(): CodeSessionState {
  return createInitialState(FIXTURE_IDS.TUG_SESSION_ID, "test", "new");
}

function applyAll(
  state: CodeSessionState,
  events: ReadonlyArray<CodeSessionEvent>,
): { state: CodeSessionState; effects: Effect[] } {
  let current = state;
  const collected: Effect[] = [];
  for (const ev of events) {
    const r = reduce(current, ev);
    current = r.state;
    collected.push(...r.effects);
  }
  return { state: current, effects: collected };
}

let now = 0;
let originalDateNow: () => number;
beforeEach(() => {
  now = 3_000_000_000;
  originalDateNow = Date.now;
  Date.now = () => now;
});
afterEach(() => {
  Date.now = originalDateNow;
});

/**
 * A live turn whose Stop is in flight — CASE B, so the flag is up, the
 * pending-reason bridge is loaded, and the in-flight segment is open.
 */
function caseBInterrupt(): CodeSessionState {
  const streaming = applyAll(fresh(), [
    {
      type: "send",
      text: "hi",
      atoms: [],
      content: [{ type: "text" as const, text: "hi" }],
      turnKey: "k1",
    },
    {
      type: "assistant_text",
      msg_id: "m1",
      block_index: 0,
      text: "partial",
      is_partial: true,
    },
  ]).state;
  return applyAll(streaming, [
    { type: "interrupt_action", reason: "logout" },
  ]).state;
}

/**
 * One terminal's row: the event that drives it, and the phase its handler
 * requires before it will act.
 *
 * `phase` is forced onto the CASE B state rather than reached by a frame
 * sequence, and that is the point being pinned: the chokepoint's claim is
 * about the terminal, not about how the flag came to be up. A replay bracket
 * cannot be entered from a streaming turn, so no honest sequence puts the two
 * together — and the flag has to be cleared there all the same.
 */
type TerminalRow = {
  event: CodeSessionEvent;
  phase?: CodeSessionState["phase"];
} | null;

const TERMINALS: Record<LastErrorCause, TerminalRow> = {
  session_state_errored: {
    event: { type: "session_state_errored", detail: "session errored" },
  },
  wire_error: {
    event: { type: "error", message: "protocol error", site: "drain_eof" },
  },
  session_unknown: {
    event: { type: "session_unknown", detail: "session unknown" },
  },
  session_not_owned: {
    event: { type: "session_not_owned", detail: "not owned" },
  },
  transport_closed: {
    // The one terminal that enters errored stamping nothing — a wire blip
    // heals itself, and the "Reconnecting…" bulletin already says so.
    event: { type: "transport_close" },
  },
  replay_stalled: {
    event: { type: "tick_replay_silence" },
    phase: "replaying",
  },
  replay_bracket_timeout: {
    // The bracket's absolute cap. Its own row rather than a variant of
    // the one above, because the two say different things about what
    // went wrong and this table's claim is per-terminal.
    event: { type: "tick_replay_bracket" },
    phase: "replaying",
  },
  // `handleResumeFailed` stamps this cause and does NOT enter errored: the
  // phase flip arrives separately, as the supervisor's
  // `SESSION_STATE = errored { detail: "resume_failed" }`, which is the
  // `session_state_errored` row above. So there is no terminal to drive here,
  // and the null is the assertion — not an omission.
  resume_failed: null,
};

function drive(row: NonNullable<TerminalRow>) {
  const base = caseBInterrupt();
  const seeded: CodeSessionState =
    row.phase === undefined ? base : { ...base, phase: row.phase };
  return applyAll(seeded, [row.event]);
}

describe("reducer — every terminal clears the per-interrupt fields", () => {
  it("the CASE B state under test has every per-interrupt field set", () => {
    const mid = caseBInterrupt();
    expect(mid.interruptInFlight).toBe(true);
    expect(mid.pendingInterruptReason).toBe("logout");
    expect(mid.interruptInFlightSegmentStartedAt).not.toBeNull();
  });

  for (const [cause, row] of Object.entries(TERMINALS) as ReadonlyArray<
    [LastErrorCause, TerminalRow]
  >) {
    if (row === null) continue;
    it(`${cause}: enters errored and clears every per-interrupt field`, () => {
      const { state } = drive(row);
      expect(state.phase).toBe("errored");
      expect(state.interruptInFlight).toBe(false);
      expect(state.pendingInterruptReason).toBeNull();
      expect(state.interruptInFlightSegmentStartedAt).toBeNull();
      // Shared with the per-interrupt clears because it has the same
      // shape of defect: no bracket-close is coming after a terminal.
      expect(state.wakeTrigger).toBeNull();
    });

    it(`${cause}: the phase projection reads errored, not interrupting`, () => {
      // The [F05] symptom, pinned where it showed: `interruptInFlight` sits
      // above the phase in this projection, so a lying flag is what put
      // "Interrupting" on a card that had errored.
      const { state } = drive(row);
      const key = sessionSessionPhaseKey({
        phase: state.phase,
        transportState: state.transportState,
        interruptInFlight: state.interruptInFlight,
      });
      expect(key).not.toBe("interrupting");
      // `transport_closed` also takes the wire offline, and `offline`
      // outranks `errored` in this projection — correctly, since that is
      // the more specific truth about the card. Every other terminal
      // leaves the wire alone and reads `errored`.
      expect(key).toBe(
        state.transportState === "online" ? "errored" : "offline",
      );
    });
  }

  it("each terminal keeps its own lastError cause", () => {
    for (const [cause, row] of Object.entries(TERMINALS) as ReadonlyArray<
      [LastErrorCause, TerminalRow]
    >) {
      if (row === null) continue;
      const { state } = drive(row);
      if (cause === "transport_closed") {
        // This one stamps nothing on the way in, deliberately: a stamp here
        // would be sticky, since nothing on the recovery path clears it.
        expect(state.lastError).toBeNull();
        continue;
      }
      expect(state.lastError?.cause).toBe(cause);
    }
  });

  it("the wire_error row keeps the bridge's emit site", () => {
    const { state } = drive(TERMINALS.wire_error!);
    expect(state.lastError?.site).toBe("drain_eof");
  });

  it("transport_close keeps its own extra state", () => {
    const { state } = drive(TERMINALS.transport_closed!);
    expect(state.transportState).toBe("offline");
  });

  it("the replay terminal keeps its own bracket teardown", () => {
    const { state } = drive(TERMINALS.replay_stalled!);
    expect(state.pendingTurn).toBeNull();
    expect(state.scratch.size).toBe(0);
    expect(state.replayPrependActive).toBe(false);
  });
});
