/**
 * Pure-logic tests for `deriveColdRestoreActive` — the snapshot-
 * derivable half of the cold-restore reveal gate.
 *
 * The predicate decides whether `SessionCardServicesGate` holds the
 * `SessionRestoring` placeholder (true) or mounts `SessionCardBody` (false).
 * Each test supplies a `ColdRestoreSignals` literal — the narrow
 * matrix-relevant subset of `CodeSessionSnapshot` the predicate reads.
 * The `revealed` one-shot latch the gate ANDs in is component state,
 * exercised by the manual HMR vet, not here.
 */

import { describe, it, expect } from "bun:test";

import {
  deriveColdRestoreActive,
  type ColdRestoreSignals,
} from "@/components/tugways/cards/session-card-restore-gate";

/** `ColdRestoreSignals` for a healthy idle card; override per case. */
function signals(
  overrides: Partial<ColdRestoreSignals> = {},
): ColdRestoreSignals {
  return {
    phase: "idle",
    sessionMode: "resume",
    replayPreflightActive: false,
    lastError: null,
    ...overrides,
  };
}

const ERROR: ColdRestoreSignals["lastError"] = {
  cause: "session_state_errored",
  message: "boom",
  at: 1_700_000_000_000,
};

describe("deriveColdRestoreActive", () => {
  it("false for an idle card with no preflight and no replay", () => {
    expect(deriveColdRestoreActive(signals())).toBe(false);
  });

  it("true during the cold-boot preflight beat", () => {
    expect(
      deriveColdRestoreActive(signals({ replayPreflightActive: true })),
    ).toBe(true);
  });

  it("true while phase is replaying on a resume binding", () => {
    expect(
      deriveColdRestoreActive(
        signals({ phase: "replaying", sessionMode: "resume" }),
      ),
    ).toBe(true);
  });

  it("false while phase is replaying on a new binding", () => {
    // A fresh new-mode binding's JSONL-missing round-trip is a brief
    // no-op — not a cold restore to hold the placeholder across.
    expect(
      deriveColdRestoreActive(
        signals({ phase: "replaying", sessionMode: "new" }),
      ),
    ).toBe(false);
  });

  it("false once replay completes — phase returns to idle", () => {
    expect(
      deriveColdRestoreActive(signals({ phase: "idle", sessionMode: "resume" })),
    ).toBe(false);
  });

  it("a non-null lastError forces the predicate false (preflight)", () => {
    // Any error must mount the body so its banner shows and
    // useSessionCardObserver can route a resume failure to the picker —
    // the placeholder never swallows a failure.
    expect(
      deriveColdRestoreActive(
        signals({ replayPreflightActive: true, lastError: ERROR }),
      ),
    ).toBe(false);
  });

  it("a non-null lastError forces the predicate false (mid-replay)", () => {
    expect(
      deriveColdRestoreActive(
        signals({
          phase: "replaying",
          sessionMode: "resume",
          lastError: ERROR,
        }),
      ),
    ).toBe(false);
  });

  it("false for an errored phase", () => {
    expect(deriveColdRestoreActive(signals({ phase: "errored" }))).toBe(false);
  });

  it("the cap's own error takes the placeholder down too", () => {
    // With the app-modal gone, this clause is the whole of the exit
    // besides `replay_complete`: both deadlines — the silence one and
    // the absolute `replay_bracket` cap — end a bracket by raising a
    // `lastError`, and nothing else ends one at all. A cause this
    // predicate did not fall under would be a card held on its
    // placeholder with no wire frame left that could free it.
    expect(
      deriveColdRestoreActive(
        signals({
          phase: "replaying",
          sessionMode: "resume",
          lastError: {
            cause: "replay_bracket_timeout",
            message: "gave up",
            at: 1_700_000_000_000,
          },
        }),
      ),
    ).toBe(false);
  });

  it("false for a live in-flight phase (streaming) — not a restore", () => {
    expect(
      deriveColdRestoreActive(signals({ phase: "streaming" })),
    ).toBe(false);
  });
});
