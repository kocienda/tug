/**
 * Unit tests for `session-assistant-renderer-dispatch.ts` — the routing
 * layer that maps a `RenderInput` to a renderer component + props.
 *
 * The dispatch is pure over a module-static registry. Each test
 * resets the registry to a known empty state, then exercises one
 * branch of the routing logic.
 *
 * Coverage:
 *  - assistant_text routes to the kind-level scaffold (today; replaced
 *    in #step-3 by the real assistant-turn renderer).
 *  - tool_call with an unknown name routes to DefaultToolBlock with
 *    a caution flag.
 *  - tool_call with an alias (`MultiEdit` / `multiedit` / `MULTIEDIT`)
 *    resolves to the canonical wrapper.
 *  - tool_call lookup is case-insensitive on the tool name.
 *  - audit-confirmed default-routed tools resolve to DefaultToolBlock
 *    *without* a caution flag (they are known to default-route by
 *    design).
 *  - registeredTools() reports the registry's coverage.
 */

import { describe, it, expect, beforeEach, spyOn } from "bun:test";
import React from "react";

import {
  KIND_RENDERERS,
  NullToolBlock,
  VALIDATED_CC_VERSION,
  _resetDriftLogForTests,
  _resetToolBlockRegistryForTests,
  checkStructuredShape,
  detectToolCallDrift,
  detectVersionDrift,
  dispatch,
  dispatchToolCallState,
  extractMetadataVersion,
  logDriftEvent,
  registerToolBlock,
  registeredTools,
  resolveToolBlock,
  summarizeDrift,
  versionDriftCaution,
  versionLine,
  type DispatchContext,
  type RenderInput,
} from "./session-assistant-renderer-dispatch";
import { DefaultToolBlock } from "./blocks/default-tool-block";
import { TaskInlineToolBlock } from "./blocks/task-inline-tool-block";
import { defaultIntentToolNames } from "./session-tool-visibility-policy";
import type { ToolBlockProps } from "../blocks/types";
import type { ToolUseMessage } from "@/lib/code-session-store";

// ---------------------------------------------------------------------------
// Test-local fakes
// ---------------------------------------------------------------------------

/**
 * Minimal context stub. The dispatch logic doesn't dereference the
 * fields in any of the routes exercised here (registry lookup is the
 * only side effect), so a typed `unknown` cast is sufficient.
 */
const fakeContext = {} as DispatchContext;

function fakeToolCall(toolName: string, overrides: Partial<ToolUseMessage> = {}): ToolUseMessage {
  return {
    kind: "tool_use",
    messageKey: "tu-1-msg",
    createdAt: 0,
    toolUseId: "tu-1",
    toolName,
    input: {},
    status: "done",
    result: null,
    structuredResult: null,
    toolWallMs: null,
    ...overrides,
  };
}

/** Stable identity for "the canonical Edit wrapper" used by alias tests. */
const FakeEditWrapper: React.FC<ToolBlockProps> = () =>
  React.createElement("div", { "data-slot": "fake-edit" });
FakeEditWrapper.displayName = "FakeEditWrapper";

beforeEach(() => {
  _resetToolBlockRegistryForTests();
  _resetDriftLogForTests();
});

// ---------------------------------------------------------------------------
// dispatch() — kind routing
// ---------------------------------------------------------------------------

describe("dispatch — kind routing", () => {
  it("routes assistant_text to KIND_RENDERERS.assistant_text", () => {
    const input: RenderInput = {
      kind: "assistant_text",
      text: "Hello",
      status: "complete",
      msgId: "m1",
    };
    const result = dispatch(input, fakeContext);
    expect(result.Component).toBe(KIND_RENDERERS.assistant_text);
    expect(result.caution).toBeUndefined();
  });

  it("routes thinking to KIND_RENDERERS.thinking", () => {
    const input: RenderInput = {
      kind: "thinking",
      text: "...",
      status: "complete",
      msgId: "m1",
    };
    expect(dispatch(input, fakeContext).Component).toBe(KIND_RENDERERS.thinking);
  });

  it("routes permission to KIND_RENDERERS.permission", () => {
    const input: RenderInput = {
      kind: "permission",
      request: {
        request_id: "r1",
        is_question: false,
      },
    };
    expect(dispatch(input, fakeContext).Component).toBe(KIND_RENDERERS.permission);
  });

  // A pending question is no longer a foot-slot `RenderInput` kind: the
  // `AskUserQuestion` tool block owns its live wizard in place, so there is
  // no `KIND_RENDERERS.question` entry to route to.
});

// ---------------------------------------------------------------------------
// dispatch() — tool_call routing
// ---------------------------------------------------------------------------

describe("dispatch — tool_call routing", () => {
  it("routes a known tool to its registered wrapper, no caution", () => {
    registerToolBlock("edit", FakeEditWrapper);
    const input: RenderInput = {
      kind: "tool_call",
      toolCall: fakeToolCall("Edit"),
    };
    const result = dispatch(input, fakeContext);
    expect(result.Component).toBe(FakeEditWrapper);
    expect(result.caution).toBeUndefined();
  });

  it("routes an unknown tool to DefaultToolBlock with caution.reason='unknown_tool'", () => {
    const input: RenderInput = {
      kind: "tool_call",
      toolCall: fakeToolCall("ZzzUnknownTool"),
    };
    const result = dispatch(input, fakeContext);
    expect(result.Component).toBe(DefaultToolBlock);
    expect(result.caution).toEqual({
      reason: "unknown_tool",
      detail: "ZzzUnknownTool",
    });
    // The caution is also threaded into props so the wrapper can render
    // its inline badge.
    expect((result.props as { caution?: unknown }).caution).toEqual({
      reason: "unknown_tool",
      detail: "ZzzUnknownTool",
    });
  });

  it("routes audit-confirmed default tools to DefaultToolBlock without caution", () => {
    // Per [D101] policy contract: a tool in the `default-intent`
    // bucket of `TOOL_VISIBILITY_POLICY` routes through
    // `DefaultToolBlock` without raising a drift caution. The set of
    // default-intent tools shrinks as bespoke wrappers ship; this
    // canary re-points at whatever name is currently classified
    // default-intent. When the bucket is empty (every tool covered
    // by a bespoke wrapper), the contract is preserved by the
    // policy-file invariants and this assertion becomes informational
    // — there is no real-world target to canary against.
    const sample = defaultIntentToolNames().values().next().value;
    if (sample === undefined) {
      // No default-intent tools today — bucket is currently empty.
      // The policy-file governance test covers the structural
      // invariants; this canary has nothing to assert against.
      expect(defaultIntentToolNames().size).toBe(0);
      return;
    }
    const input: RenderInput = {
      kind: "tool_call",
      toolCall: fakeToolCall(sample),
    };
    const result = dispatch(input, fakeContext);
    expect(result.Component).toBe(DefaultToolBlock);
    expect(result.caution).toBeUndefined();
  });

  it("routes TaskCreate / TaskUpdate to TaskInlineToolBlock per the amended [D100] — second surface, no caution", () => {
    // Canary for the [D100] two-surface decision: the TASKS cell is
    // the canonical surface for *current state*, the inline marker
    // is the second surface for *event-in-context*. Before
    // [#step-24-3-5] this assertion pinned routing to `NullToolBlock`
    // (the original hide-everything-per-D100 reading). After the
    // step, both names are bespoke — registered via
    // `BESPOKE_REGISTRATIONS` against `TaskInlineToolBlock`. If a
    // future change reverses the second-surface decision (back to
    // hidden, or to two different wrappers), this test fails loudly
    // rather than letting the routing drift quietly.
    //
    // The file-wide `beforeEach` clears `TOOL_BLOCK_REGISTRY` for
    // isolation; bespoke routing depends on the registry, so we
    // re-register the two names here before asserting. (Hidden tools
    // didn't need this because they short-circuit ahead of the
    // registry via `HIDDEN_TOOL_NAMES`, which is built at module
    // load and unaffected by the per-test reset.)
    registerToolBlock("taskcreate", TaskInlineToolBlock);
    registerToolBlock("taskupdate", TaskInlineToolBlock);
    for (const toolName of ["TaskCreate", "TaskUpdate"]) {
      const result = dispatch(
        { kind: "tool_call", toolCall: fakeToolCall(toolName), },
        fakeContext,
      );
      expect(result.Component).toBe(TaskInlineToolBlock);
      expect(result.caution).toBeUndefined();
      const props = result.props as Record<string, unknown>;
      expect(props.caution).toBeUndefined();
    }
  });

  it("threads tool fields onto the wrapper props", () => {
    registerToolBlock("edit", FakeEditWrapper);
    const input: RenderInput = {
      kind: "tool_call",
      toolCall: fakeToolCall("Edit", {
        toolUseId: "tu-42",
        input: { file_path: "/x.ts", old_string: "a", new_string: "b" },
        status: "done",
      }),
    };
    const result = dispatch(input, fakeContext);
    const props = result.props as Record<string, unknown>;
    expect(props.toolUseId).toBe("tu-42");
    expect(props.toolName).toBe("Edit");
    // Per [D16], `msgId` is no longer a prop on tool-block dispatch —
    // the Message is the identity; tool blocks read what they need
    // from the `ToolUseMessage` they receive.
    expect(props.msgId).toBeUndefined();
    expect(props.status).toBe("ready");
    expect(props.isError).toBe(false);
    expect(props.input).toEqual({
      file_path: "/x.ts",
      old_string: "a",
      new_string: "b",
    });
  });

  it("maps store status pending → wrapper status streaming", () => {
    registerToolBlock("bash", FakeEditWrapper);
    const input: RenderInput = {
      kind: "tool_call",
      toolCall: fakeToolCall("Bash", { status: "pending" }),
    };
    const props = dispatch(input, fakeContext).props as { status: string };
    expect(props.status).toBe("streaming");
  });

  it("maps store status error → wrapper status error and isError=true", () => {
    registerToolBlock("bash", FakeEditWrapper);
    const input: RenderInput = {
      kind: "tool_call",
      toolCall: fakeToolCall("Bash", { status: "error" }),
    };
    const props = dispatch(input, fakeContext).props as {
      status: string;
      isError: boolean;
    };
    expect(props.status).toBe("error");
    expect(props.isError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// dispatchToolCallState — header-dot phase derivation ([D03], #step-6)
// ---------------------------------------------------------------------------

describe("dispatchToolCallState — phase", () => {
  it("pending call defaults to in_flight", () => {
    registerToolBlock("bash", FakeEditWrapper);
    const props = dispatchToolCallState(
      fakeToolCall("Bash", { status: "pending" }),
    ).props as { phase: string };
    expect(props.phase).toBe("in_flight");
  });

  it("done call is success", () => {
    registerToolBlock("bash", FakeEditWrapper);
    const props = dispatchToolCallState(
      fakeToolCall("Bash", { status: "done" }),
    ).props as { phase: string };
    expect(props.phase).toBe("success");
  });

  it("error call is error", () => {
    registerToolBlock("bash", FakeEditWrapper);
    const props = dispatchToolCallState(
      fakeToolCall("Bash", { status: "error" }),
    ).props as { phase: string };
    expect(props.phase).toBe("error");
  });

  it("structured-result interrupted flag wins over a done status", () => {
    registerToolBlock("bash", FakeEditWrapper);
    const props = dispatchToolCallState(
      fakeToolCall("Bash", {
        status: "done",
        structuredResult: { interrupted: true },
      }),
    ).props as { phase: string };
    expect(props.phase).toBe("interrupted");
  });

  it("awaiting=true id-join paints a pending call awaiting", () => {
    registerToolBlock("bash", FakeEditWrapper);
    const props = dispatchToolCallState(
      fakeToolCall("Bash", { status: "pending" }),
      0,
      undefined,
      undefined,
      true,
    ).props as { phase: string };
    expect(props.phase).toBe("awaiting");
  });

  it("awaiting defaults false — a normal pending call is not awaiting", () => {
    registerToolBlock("bash", FakeEditWrapper);
    const props = dispatchToolCallState(
      fakeToolCall("Bash", { status: "pending" }),
    ).props as { phase: string };
    expect(props.phase).toBe("in_flight");
  });

  it("turnInterrupted flips a still-pending call from in_flight to interrupted", () => {
    registerToolBlock("bash", FakeEditWrapper);
    const props = dispatchToolCallState(
      fakeToolCall("Bash", { status: "pending" }),
      0,
      undefined,
      undefined,
      false,
      true,
    ).props as { phase: string; turnInterrupted?: boolean };
    expect(props.phase).toBe("interrupted");
    // Forwarded on the props so a recursing wrapper can carry it down.
    expect(props.turnInterrupted).toBe(true);
  });

  it("turnInterrupted leaves an already-done call as success", () => {
    registerToolBlock("bash", FakeEditWrapper);
    const props = dispatchToolCallState(
      fakeToolCall("Bash", { status: "done" }),
      0,
      undefined,
      undefined,
      false,
      true,
    ).props as { phase: string };
    expect(props.phase).toBe("success");
  });

  it("turnInterrupted leaves an errored call as error", () => {
    registerToolBlock("bash", FakeEditWrapper);
    const props = dispatchToolCallState(
      fakeToolCall("Bash", { status: "error" }),
      0,
      undefined,
      undefined,
      false,
      true,
    ).props as { phase: string };
    expect(props.phase).toBe("error");
  });
});

// ---------------------------------------------------------------------------
// resolveToolBlock — alias and case-insensitive lookup
// ---------------------------------------------------------------------------

describe("resolveToolBlock", () => {
  it("returns DefaultToolBlock for an empty registry", () => {
    expect(resolveToolBlock("Anything")).toBe(DefaultToolBlock);
  });

  it("looks up by exact lowercase name", () => {
    registerToolBlock("read", FakeEditWrapper);
    expect(resolveToolBlock("read")).toBe(FakeEditWrapper);
  });

  it("is case-insensitive on the input name", () => {
    registerToolBlock("read", FakeEditWrapper);
    expect(resolveToolBlock("Read")).toBe(FakeEditWrapper);
    expect(resolveToolBlock("READ")).toBe(FakeEditWrapper);
    expect(resolveToolBlock("reAd")).toBe(FakeEditWrapper);
  });

  it("resolves the multiedit → edit alias", () => {
    registerToolBlock("edit", FakeEditWrapper);
    expect(resolveToolBlock("MultiEdit")).toBe(FakeEditWrapper);
    expect(resolveToolBlock("multiedit")).toBe(FakeEditWrapper);
    expect(resolveToolBlock("MULTIEDIT")).toBe(FakeEditWrapper);
  });

  it("resolves the task → agent alias (historical rename)", () => {
    const FakeAgent: React.FC<ToolBlockProps> = () =>
      React.createElement("div");
    FakeAgent.displayName = "FakeAgent";
    registerToolBlock("agent", FakeAgent);
    expect(resolveToolBlock("Task")).toBe(FakeAgent);
    expect(resolveToolBlock("task")).toBe(FakeAgent);
    expect(resolveToolBlock("Agent")).toBe(FakeAgent);
  });

  it("falls back to DefaultToolBlock when an alias's canonical isn't registered", () => {
    // multiedit aliases to edit, but edit isn't in the registry yet.
    expect(resolveToolBlock("MultiEdit")).toBe(DefaultToolBlock);
  });
});

// ---------------------------------------------------------------------------
// registeredTools — coverage enumeration
// ---------------------------------------------------------------------------

describe("registeredTools", () => {
  it("returns an empty array for an empty registry", () => {
    expect(registeredTools()).toEqual([]);
  });

  it("returns canonical (lowercased) names, sorted, no aliases", () => {
    registerToolBlock("Edit", FakeEditWrapper);
    registerToolBlock("read", FakeEditWrapper);
    registerToolBlock("bash", FakeEditWrapper);
    expect(registeredTools()).toEqual(["bash", "edit", "read"]);
  });

  it("does not include DefaultToolBlock or aliases", () => {
    registerToolBlock("agent", FakeEditWrapper);
    // `task` is an alias for `agent`; should not appear.
    const names = registeredTools();
    expect(names).toEqual(["agent"]);
    expect(names).not.toContain("task");
  });
});

// ---------------------------------------------------------------------------
// Drift detection — shallow structured-result shape check
// ---------------------------------------------------------------------------

describe("checkStructuredShape", () => {
  it("returns null when every required field is present and well-typed", () => {
    expect(checkStructuredShape({ file: {} }, { file: "object" })).toBeNull();
    expect(
      checkStructuredShape(
        { file: { content: "x" }, type: "text" },
        { file: "object" },
      ),
    ).toBeNull();
  });

  it("reports a missing required field", () => {
    expect(checkStructuredShape({ type: "text" }, { file: "object" })).toBe(
      "file: missing",
    );
  });

  it("reports a wrong-typed field, naming the actual type", () => {
    expect(checkStructuredShape({ file: "x" }, { file: "object" })).toBe(
      "file: expected object, got string",
    );
    // An array is not an `object` (the schema's "object" excludes arrays).
    expect(checkStructuredShape({ file: [] }, { file: "object" })).toBe(
      "file: expected object, got array",
    );
    // `null` is reported distinctly from a plain object.
    expect(checkStructuredShape({ file: null }, { file: "object" })).toBe(
      "file: expected object, got null",
    );
  });

  it("checks the `array` type via Array.isArray", () => {
    expect(checkStructuredShape({ items: [] }, { items: "array" })).toBeNull();
    expect(checkStructuredShape({ items: {} }, { items: "array" })).toBe(
      "items: expected array, got object",
    );
  });

  it("returns the first mismatch across a multi-field schema", () => {
    const schema = { file: "object", type: "string" } as const;
    expect(checkStructuredShape({ type: "text" }, schema)).toBe("file: missing");
    expect(checkStructuredShape({ file: {}, type: 42 }, schema)).toBe(
      "type: expected string, got number",
    );
  });
});

// ---------------------------------------------------------------------------
// Drift detection — version drift
// ---------------------------------------------------------------------------

describe("extractMetadataVersion", () => {
  it("pulls a string `version` from a metadata object", () => {
    expect(extractMetadataVersion({ version: "2.1.105" })).toBe("2.1.105");
  });

  it("returns null for a non-string version or a non-object payload", () => {
    expect(extractMetadataVersion({ version: 42 })).toBeNull();
    expect(extractMetadataVersion({})).toBeNull();
    expect(extractMetadataVersion(null)).toBeNull();
    expect(extractMetadataVersion("system_metadata")).toBeNull();
  });
});

describe("versionLine", () => {
  it("reduces a version to its major.minor line", () => {
    expect(versionLine("2.1.148")).toBe("2.1");
    expect(versionLine("2.1.105")).toBe("2.1");
    expect(versionLine("2.2.0")).toBe("2.2");
    expect(versionLine("3.0.17")).toBe("3.0");
  });

  it("returns a sub-two-segment version whole", () => {
    expect(versionLine("2")).toBe("2");
    expect(versionLine("")).toBe("");
  });
});

describe("versionDriftCaution", () => {
  it("returns null when the version is on the validated minor line", () => {
    expect(versionDriftCaution(VALIDATED_CC_VERSION)).toBeNull();
  });

  it("returns null for a patch difference within the validated line", () => {
    // The validated baseline is a `2.1.x` line; a different patch on
    // the same line is normal daily churn, not drift.
    const samePatchLine = `${versionLine(VALIDATED_CC_VERSION)}.99999`;
    expect(versionDriftCaution(samePatchLine)).toBeNull();
  });

  it("returns null when no version has been captured yet", () => {
    expect(versionDriftCaution(null)).toBeNull();
  });

  it("flags a version on a different minor line, both versions in the detail", () => {
    expect(versionDriftCaution("2.2.0")).toEqual({
      reason: "version_drift",
      detail: `2.2.0 ≠ ${VALIDATED_CC_VERSION}`,
    });
  });
});

describe("detectVersionDrift", () => {
  it("flags a `system_metadata` payload on a different minor line", () => {
    expect(detectVersionDrift({ version: "2.2.0" })).toEqual({
      reason: "version_drift",
      detail: `2.2.0 ≠ ${VALIDATED_CC_VERSION}`,
    });
  });

  it("returns null for a same-line version or a versionless payload", () => {
    expect(detectVersionDrift({ version: VALIDATED_CC_VERSION })).toBeNull();
    expect(
      detectVersionDrift({ version: `${versionLine(VALIDATED_CC_VERSION)}.0` }),
    ).toBeNull();
    expect(detectVersionDrift({})).toBeNull();
    expect(detectVersionDrift(null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Drift detection — per-tool-call detector
// ---------------------------------------------------------------------------

describe("detectToolCallDrift", () => {
  it("flags an unknown tool name", () => {
    expect(detectToolCallDrift(fakeToolCall("ZzzUnknown"))).toEqual({
      reason: "unknown_tool",
      detail: "ZzzUnknown",
    });
  });

  it("does not flag a policy default-intent tool", () => {
    // Per [D101]: a tool in the `default-intent` bucket of
    // `TOOL_VISIBILITY_POLICY` does not raise a drift caution. The
    // set shrinks as bespoke wrappers ship; this canary re-points at
    // whatever name is currently classified default-intent. When the
    // bucket is empty, the policy invariants in
    // `session-tool-visibility-policy.test.ts` carry the contract.
    const sample = defaultIntentToolNames().values().next().value;
    if (sample === undefined) {
      expect(defaultIntentToolNames().size).toBe(0);
      return;
    }
    expect(detectToolCallDrift(fakeToolCall(sample))).toBeNull();
  });

  it("does not flag SubagentHandback, and routes it to NullToolBlock", () => {
    // Subagent-only: it is absent from the session's init tool list,
    // so no capabilities capture can classify it — the policy must.
    expect(detectToolCallDrift(fakeToolCall("SubagentHandback"))).toBeNull();
    expect(resolveToolBlock("SubagentHandback")).toBe(NullToolBlock);
  });

  it("does not flag a registered wrapper with no shape schema", () => {
    registerToolBlock("edit", FakeEditWrapper);
    expect(detectToolCallDrift(fakeToolCall("Edit"))).toBeNull();
  });

  it("does not flag a registered Read with a well-shaped structured result", () => {
    registerToolBlock("read", FakeEditWrapper);
    expect(
      detectToolCallDrift(
        fakeToolCall("Read", { structuredResult: { file: { content: "x" } } }),
      ),
    ).toBeNull();
  });

  it("flags a registered Read whose structured result fails the shape schema", () => {
    registerToolBlock("read", FakeEditWrapper);
    expect(
      detectToolCallDrift(
        fakeToolCall("Read", { structuredResult: { type: "text" } }),
      ),
    ).toEqual({ reason: "unknown_shape", detail: "Read: file: missing" });
  });

  it("does not shape-check an absent (null) structured result — that is the streaming window", () => {
    registerToolBlock("read", FakeEditWrapper);
    expect(
      detectToolCallDrift(fakeToolCall("Read", { structuredResult: null })),
    ).toBeNull();
  });

  it("does not shape-check an errored tool call — an error result is allowed to diverge", () => {
    registerToolBlock("read", FakeEditWrapper);
    expect(
      detectToolCallDrift(
        fakeToolCall("Read", {
          status: "error",
          structuredResult: { type: "text" },
        }),
      ),
    ).toBeNull();
  });

  it("treats an unregistered Read as unknown_tool, not unknown_shape", () => {
    // `read` is not in the registry (reset in beforeEach) — a registry
    // miss is unknown_tool; the shape schema only governs registered tools.
    expect(
      detectToolCallDrift(
        fakeToolCall("Read", { structuredResult: { type: "text" } }),
      ),
    ).toEqual({ reason: "unknown_tool", detail: "Read" });
  });
});

// ---------------------------------------------------------------------------
// Drift detection — dispatch wiring (shape drift + version drift)
// ---------------------------------------------------------------------------

describe("dispatch — shape drift routing", () => {
  it("routes a registered Read with a bad structured shape to DefaultToolBlock + caution", () => {
    registerToolBlock("read", FakeEditWrapper);
    const input: RenderInput = {
      kind: "tool_call",
      toolCall: fakeToolCall("Read", { structuredResult: { file: 42 } }),
    };
    const result = dispatch(input, fakeContext);
    expect(result.Component).toBe(DefaultToolBlock);
    expect(result.caution).toEqual({
      reason: "unknown_shape",
      detail: "Read: file: expected object, got number",
    });
    // The caution is threaded onto the props so the chrome paints the
    // inline `SessionCautionBadge`.
    expect((result.props as { caution?: unknown }).caution).toEqual(
      result.caution,
    );
  });

  it("routes a registered Read with a good structured shape to its bespoke wrapper", () => {
    registerToolBlock("read", FakeEditWrapper);
    const result = dispatchToolCallState(
      fakeToolCall("Read", { structuredResult: { file: { content: "x" } } }),
    );
    expect(result.Component).toBe(FakeEditWrapper);
    expect(result.caution).toBeUndefined();
  });
});

describe("dispatch — system_metadata version drift", () => {
  it("raises a version_drift caution for a different-minor system_metadata version", () => {
    const input: RenderInput = {
      kind: "system_metadata",
      metadata: { type: "system_metadata", version: "2.2.0" },
    };
    const result = dispatch(input, fakeContext);
    expect(result.Component).toBe(KIND_RENDERERS.system_metadata);
    expect(result.caution).toEqual({
      reason: "version_drift",
      detail: `2.2.0 ≠ ${VALIDATED_CC_VERSION}`,
    });
    // Threaded onto props so the #step-29 SessionInitBanner can paint
    // the inline marker.
    expect((result.props as { caution?: unknown }).caution).toEqual(
      result.caution,
    );
  });

  it("raises no caution for a version on the validated minor line", () => {
    const input: RenderInput = {
      kind: "system_metadata",
      metadata: {
        type: "system_metadata",
        version: `${versionLine(VALIDATED_CC_VERSION)}.0`,
      },
    };
    const result = dispatch(input, fakeContext);
    expect(result.caution).toBeUndefined();
    expect((result.props as { caution?: unknown }).caution).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Drift detection — transcript-wide aggregate
// ---------------------------------------------------------------------------

describe("summarizeDrift", () => {
  it("returns a zero summary for a clean transcript", () => {
    registerToolBlock("edit", FakeEditWrapper);
    expect(
      summarizeDrift({
        toolCalls: [fakeToolCall("Edit")],
        version: VALIDATED_CC_VERSION,
      }),
    ).toEqual({ count: 0, events: [] });
  });

  it("counts tool-call drift and version drift across the session", () => {
    registerToolBlock("edit", FakeEditWrapper);
    registerToolBlock("read", FakeEditWrapper);
    const summary = summarizeDrift({
      toolCalls: [
        fakeToolCall("ZzzUnknown", { toolUseId: "tu-a" }),
        fakeToolCall("Edit", { toolUseId: "tu-b" }),
        fakeToolCall("Read", {
          toolUseId: "tu-c",
          structuredResult: { type: "text" },
        }),
      ],
      version: "2.2.0",
    });
    expect(summary.count).toBe(3);
    // Tool drift in transcript order, version drift appended last.
    expect(summary.events.map((e) => e.caution.reason)).toEqual([
      "unknown_tool",
      "unknown_shape",
      "version_drift",
    ]);
    expect(summary.events[0]).toMatchObject({
      toolName: "ZzzUnknown",
      toolUseId: "tu-a",
    });
    expect(summary.events[2]).toMatchObject({ version: "2.2.0" });
  });

  it("omits version drift on the validated minor line or an absent version", () => {
    expect(summarizeDrift({ toolCalls: [], version: null }).count).toBe(0);
    expect(
      summarizeDrift({ toolCalls: [], version: VALIDATED_CC_VERSION }).count,
    ).toBe(0);
    expect(
      summarizeDrift({
        toolCalls: [],
        version: `${versionLine(VALIDATED_CC_VERSION)}.0`,
      }).count,
    ).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Drift detection — triage logging
// ---------------------------------------------------------------------------

describe("logDriftEvent", () => {
  it("logs a drift event once, with reason / toolName / version / summary", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      logDriftEvent({
        caution: { reason: "unknown_tool", detail: "ZzzUnknown" },
        toolName: "ZzzUnknown",
        toolUseId: "tu-1",
      });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[1]).toEqual({
        reason: "unknown_tool",
        toolName: "ZzzUnknown",
        version: undefined,
        summary: "ZzzUnknown",
      });
    } finally {
      warn.mockRestore();
    }
  });

  it("dedupes a repeated drift occurrence — logged once, not on every re-detect", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const event = {
        caution: { reason: "unknown_shape" as const, detail: "Read: file: missing" },
        toolName: "Read",
        toolUseId: "tu-7",
      };
      logDriftEvent(event);
      logDriftEvent(event);
      logDriftEvent(event);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("logs version drift keyed on the version string", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      logDriftEvent({
        caution: { reason: "version_drift", detail: `2.2.0 ≠ ${VALIDATED_CC_VERSION}` },
        version: "2.2.0",
      });
      logDriftEvent({
        caution: { reason: "version_drift", detail: `2.2.0 ≠ ${VALIDATED_CC_VERSION}` },
        version: "2.2.0",
      });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[1]).toMatchObject({
        reason: "version_drift",
        version: "2.2.0",
      });
    } finally {
      warn.mockRestore();
    }
  });
});
