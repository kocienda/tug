/**
 * `selectSessionFields` — the selector behind `useSessionFields`. A
 * selection keeps its identity across every publish that moves none of the
 * fields it names, which is what spares its component the re-render; a
 * publish that moves one of them hands back a fresh selection.
 */

import { describe, it, expect } from "bun:test";

import { selectSessionFields } from "@/lib/code-session-store/hooks/use-session-fields";
import type { CodeSessionSnapshot } from "@/lib/code-session-store/types";

const FIELDS = ["phase", "transcript"] as const;

function snapshot(fields: Partial<CodeSessionSnapshot>): CodeSessionSnapshot {
  return { phase: "idle", transcript: [], activeTurn: null, ...fields } as CodeSessionSnapshot;
}

describe("selectSessionFields", () => {
  it("selects exactly the named fields", () => {
    const transcript: CodeSessionSnapshot["transcript"] = [];
    const selection = selectSessionFields(snapshot({ transcript }), FIELDS, undefined);
    expect(selection).toEqual({ phase: "idle", transcript });
    expect(selection.transcript).toBe(transcript);
  });

  it("keeps the previous selection when no named field moved", () => {
    const transcript: CodeSessionSnapshot["transcript"] = [];
    const first = snapshot({ transcript });
    const previous = selectSessionFields(first, FIELDS, undefined);
    // A publish that moved only a field the selection does not name.
    const next = { ...first, activeTurn: {} } as CodeSessionSnapshot;
    expect(selectSessionFields(next, FIELDS, previous)).toBe(previous);
  });

  it("hands back a fresh selection when a named field moved", () => {
    const first = snapshot({});
    const previous = selectSessionFields(first, FIELDS, undefined);
    const next = { ...first, transcript: [] } as CodeSessionSnapshot;
    const selection = selectSessionFields(next, FIELDS, previous);
    expect(selection).not.toBe(previous);
    expect(selection.transcript).toBe(next.transcript);
  });
});
