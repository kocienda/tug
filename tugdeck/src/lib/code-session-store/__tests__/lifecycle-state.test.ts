/**
 * Pure-logic tests for `lifecycle-state.ts` — the session-card
 * lifecycle state-to-zone matrix encoded as `deriveLifecycleSnapshot`.
 *
 * Coverage:
 *  - `state` — one assertion per distinct matrix row (the ten
 *    lifecycle states), plus the precedence between overlapping
 *    signals (errored / replaying / interruptInFlight).
 *  - `submitButtonMode` — the matrix's Z5 column for every state, plus
 *    the TRANSPORT_DOWN (`reconnecting`) overlay effect.
 *  - `overlays` — `transport_down`, `stop_stalled` and `stalled`. A
 *    question raised outside the turn stream produces no overlay here; its
 *    Awaiting reading is pinned in `session-phase-visual.test.ts`, which
 *    covers the projection the STATE cell actually reads.
 *  - `stalled` × Z5 — the table that pins the *absence*: the overlay must
 *    change no submit-button mode in any base state, because loopback is
 *    healthy and Stop is deliverable throughout a network stall.
 *  - [DT09] — `deriveLifecycleSnapshot` returns the previous reference
 *    when no matrix-relevant signal moved, a fresh one when any did.
 *  - `lifecycleSnapshotsEqual` — the structural-equality primitive.
 *
 * The derivation reads a narrow `LifecycleStoreSignals` shape (the
 * matrix-relevant subset of `CodeSessionSnapshot`); these tests supply
 * literals of that shape, the same data-in/data-out pattern
 * `end-state.test.ts` uses for `deriveContextWindows`. The hook that
 * wraps the derivation (`use-lifecycle-state.ts`) is React glue, left
 * to integration coverage per the no-fake-DOM rule.
 */

import { describe, expect, it } from "bun:test";

import {
  deriveLifecycleSnapshot,
  lifecycleSnapshotsEqual,
  type LifecycleStoreSignals,
  type SessionLifecycleSnapshot,
} from "../lifecycle-state";
import type { ApiRetryState } from "../types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** `LifecycleStoreSignals` with sane defaults (a never-used IDLE card
 *  on a healthy wire); override the fields a given row exercises. */
function signals(
  overrides: Partial<LifecycleStoreSignals> = {},
): LifecycleStoreSignals {
  return {
    phase: "idle",
    transportState: "online",
    interruptInFlight: false,
    stopStalled: false,
    streamStalled: false,
    apiRetry: null,
    transcript: [],
    ...overrides,
  };
}

/** An `api_retry` announcement in the shape the snapshot carries. */
function retry(error: string, errorStatus: number | null): ApiRetryState {
  return { attempt: 3, maxRetries: 10, deadline: 0, error, errorStatus };
}

/** A transcript with one committed turn — splits COMPLETE from IDLE. */
const ONE_TURN: ReadonlyArray<unknown> = [{}];

function derive(
  s: LifecycleStoreSignals,
  previous?: SessionLifecycleSnapshot,
): SessionLifecycleSnapshot {
  return deriveLifecycleSnapshot(s, previous);
}

// ---------------------------------------------------------------------------
// state — one per matrix row
// ---------------------------------------------------------------------------

describe("deriveLifecycleSnapshot — lifecycle state per matrix row", () => {
  it("IDLE — idle phase, no committed turn", () => {
    expect(derive(signals({ phase: "idle" })).state).toBe("idle");
  });

  it("COMPLETE — idle phase with a committed turn", () => {
    expect(
      derive(signals({ phase: "idle", transcript: ONE_TURN })).state,
    ).toBe("complete");
  });

  it("SUBMITTING", () => {
    expect(derive(signals({ phase: "submitting" })).state).toBe("submitting");
  });

  it("AWAITING_FIRST_TOKEN", () => {
    expect(
      derive(signals({ phase: "awaiting_first_token" })).state,
    ).toBe("awaiting_first_token");
  });

  it("STREAMING", () => {
    expect(derive(signals({ phase: "streaming" })).state).toBe("streaming");
  });

  it("TOOL_WORK", () => {
    expect(derive(signals({ phase: "tool_work" })).state).toBe("tool_work");
  });

  it("AWAITING_USER — awaiting_approval phase", () => {
    expect(
      derive(signals({ phase: "awaiting_approval" })).state,
    ).toBe("awaiting_user");
  });

  it("INTERRUPTING — interruptInFlight over an in-flight phase", () => {
    expect(
      derive(signals({ phase: "streaming", interruptInFlight: true })).state,
    ).toBe("interrupting");
  });

  it("REPLAYING", () => {
    expect(derive(signals({ phase: "replaying" })).state).toBe("replaying");
  });

  it("ERRORED", () => {
    expect(derive(signals({ phase: "errored" })).state).toBe("errored");
  });
});

// ---------------------------------------------------------------------------
// state — precedence between overlapping signals
// ---------------------------------------------------------------------------

describe("deriveLifecycleSnapshot — state precedence", () => {
  it("ERRORED outranks an in-flight interrupt", () => {
    expect(
      derive(signals({ phase: "errored", interruptInFlight: true })).state,
    ).toBe("errored");
  });

  it("REPLAYING outranks an in-flight interrupt", () => {
    expect(
      derive(signals({ phase: "replaying", interruptInFlight: true })).state,
    ).toBe("replaying");
  });

  it("INTERRUPTING outranks AWAITING_USER (user is stopping the turn)", () => {
    expect(
      derive(
        signals({ phase: "awaiting_approval", interruptInFlight: true }),
      ).state,
    ).toBe("interrupting");
  });

  it("a committed transcript does not promote a non-idle phase to COMPLETE", () => {
    expect(
      derive(signals({ phase: "streaming", transcript: ONE_TURN })).state,
    ).toBe("streaming");
  });
});

// ---------------------------------------------------------------------------
// submitButtonMode — the Z5 column
// ---------------------------------------------------------------------------

describe("deriveLifecycleSnapshot — submitButtonMode (Z5 column)", () => {
  it("IDLE / COMPLETE / ERRORED → enabled Submit", () => {
    for (const s of [
      signals({ phase: "idle" }),
      signals({ phase: "idle", transcript: ONE_TURN }),
      signals({ phase: "errored" }),
    ]) {
      expect(derive(s).submitButtonMode).toEqual({
        kind: "submit",
        disabled: false,
      });
    }
  });

  it("SUBMITTING / AWAITING_FIRST_TOKEN / STREAMING / TOOL_WORK → Stop", () => {
    for (const phase of [
      "submitting",
      "awaiting_first_token",
      "streaming",
      "tool_work",
    ] as const) {
      expect(derive(signals({ phase })).submitButtonMode).toEqual({
        kind: "stop",
      });
    }
  });

  it("AWAITING_USER → awaiting_user (disabled)", () => {
    expect(
      derive(signals({ phase: "awaiting_approval" })).submitButtonMode,
    ).toEqual({ kind: "awaiting_user" });
  });

  it("INTERRUPTING → stopping (disabled)", () => {
    expect(
      derive(signals({ phase: "streaming", interruptInFlight: true }))
        .submitButtonMode,
    ).toEqual({ kind: "stopping" });
  });

  it("REPLAYING → restoring (disabled)", () => {
    expect(
      derive(signals({ phase: "replaying" })).submitButtonMode,
    ).toEqual({ kind: "restoring" });
  });

  it("TRANSPORT_DOWN overlay → reconnecting, overriding the base state", () => {
    // The wire is unusable — neither submit nor stop can reach it —
    // so `reconnecting` overrides whatever the base state would show.
    for (const transportState of ["offline", "restoring"] as const) {
      expect(
        derive(signals({ phase: "streaming", transportState }))
          .submitButtonMode,
      ).toEqual({ kind: "reconnecting" });
      expect(
        derive(signals({ phase: "idle", transportState })).submitButtonMode,
      ).toEqual({ kind: "reconnecting" });
    }
  });

});

// ---------------------------------------------------------------------------
// overlays
// ---------------------------------------------------------------------------

describe("deriveLifecycleSnapshot — overlays", () => {
  it("no overlays on a healthy idle card", () => {
    expect(derive(signals()).overlays.size).toBe(0);
  });

  it("transport_down for offline and restoring", () => {
    for (const transportState of ["offline", "restoring"] as const) {
      const { overlays } = derive(signals({ transportState }));
      expect(overlays.has("transport_down")).toBe(true);
      expect(overlays.size).toBe(1);
    }
  });

  it("stop_stalled when a stop went unanswered", () => {
    const { overlays } = derive(signals({ phase: "streaming", stopStalled: true }));
    expect(overlays.has("stop_stalled")).toBe(true);
    expect(overlays.size).toBe(1);
  });

  it("both overlays stand together — neither suppresses the other", () => {
    const { overlays } = derive(
      signals({ phase: "streaming", transportState: "offline", stopStalled: true }),
    );
    expect(overlays.has("transport_down")).toBe(true);
    expect(overlays.has("stop_stalled")).toBe(true);
    expect(overlays.size).toBe(2);
  });

  it("stalled when a live turn has gone silent", () => {
    const { overlays } = derive(
      signals({ phase: "streaming", streamStalled: true }),
    );
    expect(overlays.has("stalled")).toBe(true);
    expect(overlays.size).toBe(1);
  });

  it("stalled when claude reports a connection-category retry", () => {
    const { overlays } = derive(
      signals({ phase: "streaming", apiRetry: retry("ECONNRESET", null) }),
    );
    expect(overlays.has("stalled")).toBe(true);
  });

  it("not stalled for a retry that is not the network's fault", () => {
    // The discriminator doing its job. A rate limit and a billing failure
    // are claude's problems; neither says the network stopped answering,
    // and each has its own reading elsewhere.
    for (const [error, status] of [
      ["rate_limit", 429],
      ["overloaded", 529],
      ["billing_error", 402],
      // A status-bearing failure is the server's, whatever its words say.
      ["connection reset upstream", 503],
    ] as ReadonlyArray<readonly [string, number | null]>) {
      const { overlays } = derive(
        signals({ phase: "streaming", apiRetry: retry(error, status) }),
      );
      expect(overlays.has("stalled")).toBe(false);
    }
  });

  it("stalled stands alongside the other two rather than replacing them", () => {
    const { overlays } = derive(
      signals({
        phase: "streaming",
        transportState: "offline",
        stopStalled: true,
        streamStalled: true,
      }),
    );
    expect(overlays.has("transport_down")).toBe(true);
    expect(overlays.has("stop_stalled")).toBe(true);
    expect(overlays.has("stalled")).toBe(true);
    expect(overlays.size).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// stalled — the overlay that deliberately changes no button
// ---------------------------------------------------------------------------

describe("deriveLifecycleSnapshot — stalled leaves Z5 alone", () => {
  const BASE_PHASES = [
    "idle",
    "submitting",
    "awaiting_first_token",
    "streaming",
    "tool_work",
    "awaiting_approval",
    "replaying",
    "errored",
  ] as const;

  it("every base state's submit mode is unchanged by the overlay", () => {
    // The whole claim of the state, as a table: a network stall leaves
    // loopback healthy, so every Stop stays Stop and nothing becomes inert.
    // A disabled stop button over work that will not end is the defect this
    // arc began from.
    for (const phase of BASE_PHASES) {
      const without = derive(signals({ phase })).submitButtonMode;
      const withStall = derive(
        signals({ phase, streamStalled: true }),
      ).submitButtonMode;
      expect(withStall).toEqual(without);
    }
  });

  it("the retry arm changes no button either", () => {
    for (const phase of BASE_PHASES) {
      const without = derive(signals({ phase })).submitButtonMode;
      const withStall = derive(
        signals({ phase, apiRetry: retry("ECONNRESET", null) }),
      ).submitButtonMode;
      expect(withStall).toEqual(without);
    }
  });

  it("an in-flight turn still reads Stop while stalled", () => {
    // Said directly, because it is the sentence the state exists for.
    for (const phase of [
      "submitting",
      "awaiting_first_token",
      "streaming",
      "tool_work",
    ] as const) {
      expect(
        derive(signals({ phase, streamStalled: true })).submitButtonMode,
      ).toEqual({ kind: "stop" });
    }
  });
});

// ---------------------------------------------------------------------------
// force_stop — the Z5 mode an unanswered stop produces
// ---------------------------------------------------------------------------

describe("deriveLifecycleSnapshot — force_stop", () => {
  it("stopStalled yields force_stop from every in-flight state", () => {
    for (const phase of [
      "submitting",
      "awaiting_first_token",
      "streaming",
      "tool_work",
      "awaiting_approval",
    ] as const) {
      expect(
        derive(signals({ phase, stopStalled: true })).submitButtonMode,
      ).toEqual({ kind: "force_stop" });
    }
  });

  it("it wins over transport_down", () => {
    // The one place something beats the wire in this function: the card has
    // work to force-stop whatever the transport is doing, and the frame is
    // deliverable the moment the wire returns. An inert "Reconnecting…"
    // here would be the dead stop button this arc exists to remove.
    expect(
      derive(
        signals({
          phase: "streaming",
          transportState: "offline",
          stopStalled: true,
        }),
      ).submitButtonMode,
    ).toEqual({ kind: "force_stop" });
  });

  it("it wins over an in-flight interrupt's `stopping`", () => {
    // Not a live combination — the deadline's tick clears one flag as it
    // raises the other — but the order is what keeps a race from parking
    // the card back on the inert glyph.
    expect(
      derive(
        signals({
          phase: "streaming",
          interruptInFlight: true,
          stopStalled: true,
        }),
      ).submitButtonMode,
    ).toEqual({ kind: "force_stop" });
  });

  it("every base state is unchanged while stopStalled is false", () => {
    // The matrix gains a column value, not a rewrite.
    for (const phase of [
      "idle",
      "submitting",
      "awaiting_first_token",
      "streaming",
      "tool_work",
      "awaiting_approval",
      "replaying",
      "errored",
    ] as const) {
      const withFlag = derive(signals({ phase, stopStalled: false }));
      expect(withFlag.submitButtonMode).not.toEqual({ kind: "force_stop" });
    }
  });

  it("[DT09] reference stability holds with two overlays in the set", () => {
    // `overlaySetsEqual` has only ever seen a one-member union; a set of
    // two is the case that would expose a size-only or first-member-only
    // comparison.
    const base = signals({
      phase: "streaming",
      transportState: "offline",
      stopStalled: true,
    });
    const first = derive(base);
    const second = derive({ ...base, transcript: [] }, first);
    expect(second).toBe(first);

    // …and a set that differs by one member is not equal, so the snapshot
    // really does move when the overlay does.
    const third = derive(
      { ...base, transportState: "online", transcript: [] },
      second,
    );
    expect(third).not.toBe(second);
    expect(third.overlays.size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// [DT09] — reference stability
// ---------------------------------------------------------------------------

describe("deriveLifecycleSnapshot — [DT09] reference stability", () => {
  it("returns the previous reference when no matrix-relevant signal moved", () => {
    const first = derive(signals({ phase: "streaming" }));
    // A streaming `assistant_delta` mutates content but not the
    // matrix-relevant signals — modelled here as a second call with an
    // equal-but-distinct signals object (a fresh `transcript` array).
    const second = derive(signals({ phase: "streaming", transcript: [] }), first);
    expect(second).toBe(first);
  });

  it("returns a fresh reference when a matrix-relevant signal changes", () => {
    const first = derive(signals({ phase: "streaming" }));
    const afterPhase = derive(signals({ phase: "idle" }), first);
    expect(afterPhase).not.toBe(first);
    expect(afterPhase.state).toBe("idle");
  });

  it("a new overlay breaks reference stability", () => {
    const first = derive(signals({ phase: "streaming" }));
    const afterTransport = derive(
      signals({ phase: "streaming", transportState: "offline" }),
      first,
    );
    expect(afterTransport).not.toBe(first);
  });

  it("omitting `previous` always yields a fresh reference", () => {
    const a = derive(signals({ phase: "streaming" }));
    const b = derive(signals({ phase: "streaming" }));
    expect(b).not.toBe(a);
    expect(lifecycleSnapshotsEqual(a, b)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// lifecycleSnapshotsEqual
// ---------------------------------------------------------------------------

describe("lifecycleSnapshotsEqual", () => {
  it("equal across distinct objects with the same matrix row", () => {
    expect(
      lifecycleSnapshotsEqual(
        derive(signals({ phase: "streaming" })),
        derive(signals({ phase: "streaming" })),
      ),
    ).toBe(true);
  });

  it("unequal on a different state", () => {
    expect(
      lifecycleSnapshotsEqual(
        derive(signals({ phase: "streaming" })),
        derive(signals({ phase: "tool_work" })),
      ),
    ).toBe(false);
  });

  it("unequal on a different overlay set", () => {
    expect(
      lifecycleSnapshotsEqual(
        derive(signals({ phase: "streaming" })),
        derive(signals({ phase: "streaming", transportState: "offline" })),
      ),
    ).toBe(false);
  });
});

