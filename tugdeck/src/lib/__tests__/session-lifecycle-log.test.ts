/**
 * The browser leg of the `[dev::session-lifecycle]` stream reaches a
 * durable surface.
 *
 * tugcode's copy of these lines lands in `tugcast.log` through its
 * stderr and tugcast's own are `tracing::info!`; the deck's go to a
 * console that, in a release host, forwards nowhere. The mirror into
 * the deck-trace ring is what makes a cold restore's perf story
 * (`perf.replay_ingest`, `perf.replay_render`, `perf.row_parse` — all
 * emitted in the seconds before anyone could attach an inspector)
 * readable afterwards.
 *
 * The load-bearing half is that the mirror does not wait to be turned
 * on: recording is opt-in per kind, and the launches worth reading are
 * the ones nobody opted into. These pin both halves against the real
 * ring.
 */

import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";

import { deckTrace } from "@/deck-trace";
import { logSessionLifecycle } from "@/lib/session-lifecycle-log";

describe("logSessionLifecycle — deck-trace mirror", () => {
  let logSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    deckTrace.clear();
    deckTrace.enable(false);
    logSpy = spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    deckTrace.clear();
  });

  it("records with trace recording OFF — the launch nobody opted into", () => {
    logSessionLifecycle("perf.replay_ingest", { frames: 3396, dispatchMs: 11 });

    const events = deckTrace.dump();
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.kind).toBe("session-lifecycle");
    if (event.kind !== "session-lifecycle") throw new Error("narrowing");
    expect(event.event).toBe("perf.replay_ingest");
    expect(event.fields).toEqual({ frames: 3396, dispatchMs: 11 });
    expect(typeof event.timestamp).toBe("number");
  });

  it("copies the fields, so a caller reusing its object cannot rewrite the record", () => {
    const fields: Record<string, unknown> = { frames: 1 };
    logSessionLifecycle("perf.replay_ingest", fields);
    fields.frames = 999;

    const event = deckTrace.dump()[0]!;
    if (event.kind !== "session-lifecycle") throw new Error("narrowing");
    expect(event.fields).toEqual({ frames: 1 });
  });

  it("still writes the greppable console line", () => {
    logSessionLifecycle("perf.row_parse", { parses: 12 });

    expect(logSpy).toHaveBeenCalledWith(
      "[dev::session-lifecycle] event=perf.row_parse parses=12",
    );
  });
});
