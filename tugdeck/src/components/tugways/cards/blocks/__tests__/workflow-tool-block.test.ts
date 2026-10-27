/**
 * Pure-logic tests for `WorkflowToolBlock`'s wire-narrowing, the
 * script `meta` reader, header-target composition, and the dispatch
 * registration pin (`workflow` → `WorkflowToolBlock`).
 *
 * @module components/tugways/cards/blocks/__tests__/workflow-tool-block
 */

import { describe, expect, test } from "bun:test";

import {
  WorkflowToolBlock,
  composeWorkflowTarget,
  formatWorkflowArgs,
  narrowWorkflowInput,
  readWorkflowMeta,
} from "../workflow-tool-block";
import { BESPOKE_FACTORY_BY_NAME } from "../../session-assistant-renderer-registrations";

const SCRIPT = `export const meta = {
  name: 'review-changes',
  description: "Review changed files across dimensions, verify each finding",
  phases: [{ title: 'Review' }, { title: 'Verify', detail: 'name: not-this' }],
}
const DIMENSIONS = [{ key: 'bugs', name: 'also-not-this' }]
`;

describe("narrowWorkflowInput", () => {
  test("keeps the string fields and args verbatim", () => {
    expect(
      narrowWorkflowInput({
        script: SCRIPT,
        name: "saved",
        scriptPath: "/tmp/w.js",
        resumeFromRunId: "wf_abc123",
        args: { q: 1 },
      }),
    ).toEqual({
      script: SCRIPT,
      name: "saved",
      scriptPath: "/tmp/w.js",
      resumeFromRunId: "wf_abc123",
      args: { q: 1 },
    });
  });

  test("returns {} for non-object input and drops empty strings", () => {
    expect(narrowWorkflowInput(null)).toEqual({});
    expect(narrowWorkflowInput({ name: "" }).name).toBeUndefined();
  });
});

describe("readWorkflowMeta", () => {
  test("reads name and description from the meta literal only", () => {
    expect(readWorkflowMeta(SCRIPT)).toEqual({
      name: "review-changes",
      description: "Review changed files across dimensions, verify each finding",
    });
  });

  test("a name after the meta block is not read", () => {
    expect(
      readWorkflowMeta("export const meta = {\n  description: 'd'\n}\nconst name = 'x'; // name: 'y'"),
    ).toEqual({ name: undefined, description: "d" });
  });

  test("backticked values are read", () => {
    expect(readWorkflowMeta("export const meta = { name: `tick` }").name).toBe("tick");
  });

  test("no meta block yields {}", () => {
    expect(readWorkflowMeta("const x = 1")).toEqual({});
    expect(readWorkflowMeta(undefined)).toEqual({});
  });
});

describe("composeWorkflowTarget", () => {
  test("meta name wins, then the saved name, then the script path basename", () => {
    expect(composeWorkflowTarget({ name: "saved" }, { name: "meta" })).toBe("meta");
    expect(composeWorkflowTarget({ name: "saved", scriptPath: "/a/b.js" }, {})).toBe(
      "saved",
    );
    expect(composeWorkflowTarget({ scriptPath: "/a/b.js" }, {})).toBe("b.js");
    expect(composeWorkflowTarget({}, {})).toBeUndefined();
  });
});

describe("formatWorkflowArgs", () => {
  test("pretty-prints JSON and falls back to String for the unserializable", () => {
    expect(formatWorkflowArgs({ a: [1] })).toBe('{\n  "a": [\n    1\n  ]\n}');
    expect(formatWorkflowArgs(undefined)).toBe("undefined");
    expect(formatWorkflowArgs(10n)).toBe("10");
  });
});

describe("dispatch registration", () => {
  test("workflow → WorkflowToolBlock", () => {
    expect(BESPOKE_FACTORY_BY_NAME.get("workflow")).toBe(WorkflowToolBlock);
  });
});
