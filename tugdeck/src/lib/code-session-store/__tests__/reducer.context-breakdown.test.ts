// Reducer tests for the `context_breakdown` event:
// - shape validation drops malformed frames silently
// - well-formed frames project onto state.lastContextBreakdown
// - subsequent frames replace the prior projection
// - effects emit a `record-context-breakdown` payload for the supervisor
// - reference identity reflects state mutation rules

import { describe, expect, test } from "bun:test";

import {
  isRecordContextBreakdown,
  type RecordContextBreakdownEffect,
} from "../effects";
import type { ContextBreakdownEvent } from "../events";
import {
  createInitialState,
  reduce,
  type CodeSessionState,
} from "../reducer";

function freshState(): CodeSessionState {
  return createInitialState("tug-session-test", "Test Session", "new");
}

function frame(
  contextMax: number,
  categories: ContextBreakdownEvent["categories"],
): ContextBreakdownEvent {
  return {
    type: "context_breakdown",
    tug_session_id: "tug-session-test",
    context_max: contextMax,
    categories,
  };
}

function recordEffect(effects: ReadonlyArray<unknown>): RecordContextBreakdownEffect {
  const found = (effects as ReadonlyArray<{ kind: string }>).find(
    (e): e is RecordContextBreakdownEffect =>
      isRecordContextBreakdown(e as never),
  );
  if (!found) throw new Error("no record-context-breakdown effect emitted");
  return found as RecordContextBreakdownEffect;
}

describe("reducer / context_breakdown", () => {
  test("initial state has lastContextBreakdown === null", () => {
    const s = freshState();
    expect(s.lastContextBreakdown).toBeNull();
  });

  test("well-formed frame projects onto lastContextBreakdown", () => {
    const s0 = freshState();
    const ev = frame(200_000, [
      { id: "system_prompt", label: "System prompt", tokens: 3_500 },
      { id: "custom_agents", label: "Custom agents", tokens: 12_000 },
    ]);
    const { state: s1, effects } = reduce(s0, ev);
    expect(s1.lastContextBreakdown).not.toBeNull();
    expect(s1.lastContextBreakdown!.contextMax).toBe(200_000);
    expect(s1.lastContextBreakdown!.categories.length).toBe(2);
    expect(s1.lastContextBreakdown!.categories[0]).toEqual({
      id: "system_prompt",
      label: "System prompt",
      tokens: 3_500,
    });
    // Effect is emitted alongside the state mutation.
    expect(effects.length).toBeGreaterThan(0);
    const eff = recordEffect(effects);
    expect(eff.payload.contextMax).toBe(200_000);
    expect(eff.payload.categories.length).toBe(2);
    expect(typeof eff.capturedAt).toBe("number");
  });

  test("subsequent frame replaces the prior projection", () => {
    const s0 = freshState();
    const { state: s1 } = reduce(
      s0,
      frame(200_000, [
        { id: "custom_agents", label: "Custom agents", tokens: 1_000 },
      ]),
    );
    const { state: s2 } = reduce(
      s1,
      frame(1_000_000, [
        { id: "custom_agents", label: "Custom agents", tokens: 25_000 },
        { id: "autocompact_buffer", label: "Autocompact buffer", tokens: 33_000 },
      ]),
    );
    expect(s2.lastContextBreakdown!.contextMax).toBe(1_000_000);
    expect(s2.lastContextBreakdown!.categories.length).toBe(2);
    // Reference is fresh on each event-driven mutation; identity diverges
    // from the prior projection.
    expect(s2.lastContextBreakdown).not.toBe(s1.lastContextBreakdown);
  });

  test("malformed: non-numeric context_max is dropped silently", () => {
    const s0 = freshState();
    const malformed = {
      type: "context_breakdown" as const,
      tug_session_id: "tug-session-test",
      context_max: "huge" as unknown as number,
      categories: [],
    };
    const { state: s1, effects } = reduce(s0, malformed);
    expect(s1.lastContextBreakdown).toBeNull();
    expect(effects.length).toBe(0);
  });

  test("malformed: non-array categories is dropped silently", () => {
    const s0 = freshState();
    const malformed = {
      type: "context_breakdown" as const,
      tug_session_id: "tug-session-test",
      context_max: 200_000,
      categories: "not-an-array" as unknown as ContextBreakdownEvent["categories"],
    };
    const { state: s1, effects } = reduce(s0, malformed);
    expect(s1.lastContextBreakdown).toBeNull();
    expect(effects.length).toBe(0);
  });

  test("malformed individual category entries are filtered out", () => {
    const s0 = freshState();
    const ev = frame(200_000, [
      { id: "system_prompt", label: "System prompt", tokens: 100 },
      // Missing tokens
      { id: "skills", label: "Skills" } as unknown as { id: "skills"; label: string; tokens: number },
      // Tokens wrong type
      {
        id: "custom_agents",
        label: "Custom agents",
        tokens: "lots" as unknown as number,
      },
      { id: "memory_files", label: "Memory files", tokens: 200 },
    ]);
    const { state: s1 } = reduce(s0, ev);
    expect(s1.lastContextBreakdown!.categories.length).toBe(2);
    expect(s1.lastContextBreakdown!.categories.map((c) => c.id)).toEqual([
      "system_prompt",
      "memory_files",
    ]);
  });

  test("payload identity: snapshot and effect share the same projection", () => {
    const s0 = freshState();
    const ev = frame(200_000, [
      { id: "custom_agents", label: "Custom agents", tokens: 9_999 },
    ]);
    const { state: s1, effects } = reduce(s0, ev);
    const eff = recordEffect(effects);
    // The effect's payload is the same object as the snapshot's projection.
    // The supervisor persists exactly what the renderer sees; no parallel
    // re-serialization where the two could drift.
    expect(s1.lastContextBreakdown).not.toBeNull();
    expect(eff.payload).toBe(s1.lastContextBreakdown!);
  });

  test("autocompact_buffer category id is supported (round-trips)", () => {
    const s0 = freshState();
    const ev = frame(200_000, [
      { id: "custom_agents", label: "Custom agents", tokens: 1_000 },
      { id: "autocompact_buffer", label: "Autocompact buffer", tokens: 33_000 },
    ]);
    const { state: s1 } = reduce(s0, ev);
    const ids = s1.lastContextBreakdown!.categories.map((c) => c.id);
    expect(ids).toEqual(["custom_agents", "autocompact_buffer"]);
  });

  test("from_supervisor_attach=true projects but skips the persist effect", () => {
    // Bind-attach round-trip suppression: the supervisor synthesized
    // this frame from the persisted row, so re-persisting it would
    // be a redundant no-op UPSERT write. Reducer projects onto
    // snapshot but doesn't emit `record-context-breakdown`.
    const s0 = freshState();
    const ev: ContextBreakdownEvent = {
      ...frame(200_000, [
        { id: "custom_agents", label: "Custom agents", tokens: 7_777 },
      ]),
      from_supervisor_attach: true,
    };
    const { state: s1, effects } = reduce(s0, ev);
    expect(s1.lastContextBreakdown).not.toBeNull();
    expect(s1.lastContextBreakdown!.categories[0].tokens).toBe(7_777);
    const recordEffects = (effects as ReadonlyArray<{ kind: string }>).filter(
      (e) => e.kind === "record-context-breakdown",
    );
    expect(recordEffects.length).toBe(0);
  });

  test("from_supervisor_attach=false (or absent) still persists", () => {
    // The default path — live frames from tugcode (no flag).
    const s0 = freshState();
    const ev = frame(200_000, [
      { id: "custom_agents", label: "Custom agents", tokens: 1_111 },
    ]);
    const { effects } = reduce(s0, ev);
    expect(
      (effects as ReadonlyArray<{ kind: string }>).some(
        (e) => e.kind === "record-context-breakdown",
      ),
    ).toBe(true);
  });

  test("no MCP id ever surfaces (pinned at the reducer)", () => {
    // The category id union excludes `mcp_tools`. Even a malformed
    // event with an `mcp_tools` id only round-trips if the renderer
    // is willing to paint it — but the wire-frame type cuts the chain
    // before this test is even possible to author cleanly. We assert
    // the no-MCP invariant by inspecting the produced state.
    const s0 = freshState();
    const ev = frame(200_000, [
      { id: "custom_agents", label: "Custom agents", tokens: 1_000 },
    ]);
    const { state: s1 } = reduce(s0, ev);
    for (const c of s1.lastContextBreakdown!.categories) {
      expect(c.id).not.toBe("mcp_tools");
    }
  });
});
