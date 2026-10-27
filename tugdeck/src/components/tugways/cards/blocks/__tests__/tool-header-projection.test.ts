/**
 * Pure-logic tests for `toolHeaderParts` — the store→text projection of a
 * tool call's header that the transcript search index counts, in both
 * collapse states.
 *
 * Two things are pinned here: the per-wrapper text (the name unit, then the
 * target unit, in DOM order), and the ROUTING — a hidden tool projects
 * nothing, and a drifted call projects the `DefaultToolBlock` shape (name
 * only) rather than the bespoke wrapper's target, because that is what the
 * transcript will actually mount. The DOM half of the mirror — that each
 * projected unit equals its `data-tugx-findable` container's text — is the
 * find fidelity app-test's job; this file has no DOM.
 *
 * @module components/tugways/cards/blocks/__tests__/tool-header-projection
 */

import { beforeAll, describe, expect, test } from "bun:test";

import { toolHeaderParts } from "../tool-header-projection";
import type { ToolUseMessage } from "@/lib/code-session-store/types";
import { registerToolBlock } from "../../session-assistant-renderer-dispatch";
import { BESPOKE_FACTORY_BY_NAME } from "../../session-assistant-renderer-registrations";

// The registry is process-global and the dispatch test clears it, so seed it
// here rather than relying on the registrations module's load-time pass —
// the projection must route the way the running transcript does.
beforeAll(() => {
  for (const [name, factory] of BESPOKE_FACTORY_BY_NAME) {
    registerToolBlock(name, factory);
  }
});

function call(overrides: Record<string, unknown>): ToolUseMessage {
  return {
    kind: "tool_use",
    messageKey: "m1",
    toolUseId: "tu1",
    seq: 0,
    createdAt: 0,
    toolWallMs: 1,
    status: "done",
    input: {},
    result: "",
    structuredResult: null,
    ...overrides,
  } as unknown as ToolUseMessage;
}

describe("toolHeaderParts — per-wrapper header text", () => {
  test("Bash projects the name and the command", () => {
    expect(
      toolHeaderParts(
        call({ toolName: "Bash", input: { command: "just app-test" } }),
      ),
    ).toEqual(["Bash", "just app-test"]);
  });

  test("a git-commit receipt projects its composed name and no target", () => {
    expect(
      toolHeaderParts(
        call({
          toolName: "Bash",
          input: { command: 'git commit -m "land it"' },
          result: "[main abc1234] land it\n 1 file changed",
        }),
      ),
    ).toEqual(["Git Commit"]);
  });

  test("file tools project the basename their TugAtomRef displays", () => {
    expect(
      toolHeaderParts(
        call({ toolName: "Read", input: { file_path: "/u/src/tug/main.rs" } }),
      ),
    ).toEqual(["Read", "main.rs"]);
    expect(
      toolHeaderParts(
        call({ toolName: "Write", input: { file_path: "/tmp/notes.md" } }),
      ),
    ).toEqual(["Write", "notes.md"]);
    expect(
      toolHeaderParts(
        call({ toolName: "Edit", input: { file_path: "/tmp/notes.md" } }),
      ),
    ).toEqual(["Edit", "notes.md"]);
  });

  test("a structured result's path wins over the input path, as it does in the header", () => {
    expect(
      toolHeaderParts(
        call({
          toolName: "Write",
          input: { file_path: "/tmp/stale.md" },
          structuredResult: { filePath: "/tmp/actual.md" },
        }),
      ),
    ).toEqual(["Write", "actual.md"]);
  });

  test("search tools project their pattern / query", () => {
    expect(
      toolHeaderParts(call({ toolName: "Grep", input: { pattern: "TODO\\b" } })),
    ).toEqual(["Grep", "TODO\\b"]);
    expect(
      toolHeaderParts(call({ toolName: "Glob", input: { pattern: "**/*.rs" } })),
    ).toEqual(["Glob", "**/*.rs"]);
    expect(
      toolHeaderParts(
        call({ toolName: "WebSearch", input: { query: "tugtool find" } }),
      ),
    ).toEqual(["WebSearch", "tugtool find"]);
    expect(
      toolHeaderParts(
        call({ toolName: "WebFetch", input: { url: "https://example.com/a" } }),
      ),
    ).toEqual(["WebFetch", "https://example.com/a"]);
  });

  test("Agent projects the type and description adjacently, as the args span renders them", () => {
    expect(
      toolHeaderParts(
        call({
          toolName: "Task",
          input: { subagent_type: "Explore", description: "find the callers" },
        }),
      ),
    ).toEqual(["Task", "Explorefind the callers"]);
  });

  test("Skill projects the slash-prefixed skill name", () => {
    expect(
      toolHeaderParts(call({ toolName: "Skill", input: { skill: "draft" } })),
    ).toEqual(["Skill", "/draft"]);
  });

  test("verb-composing wrappers project their composed name", () => {
    expect(
      toolHeaderParts(
        call({ toolName: "CronCreate", input: { cron: "0 9 * * *" } }),
      ),
    ).toEqual(["Cron · create", "0 9 * * *"]);
    expect(
      toolHeaderParts(call({ toolName: "TaskGet", input: { task_id: "t7" } })),
    ).toEqual(["Background Task · get", "#t7"]);
  });

  test("SendMessage projects recipient and label as one adjacent unit", () => {
    expect(
      toolHeaderParts(
        call({
          toolName: "SendMessage",
          input: { to: "worker", message: "Re-run the suite.\nThen report.", summary: "re-run suite" },
        }),
      ),
    ).toEqual(["SendMessage", "workerre-run suite"]);
    expect(
      toolHeaderParts(
        call({
          toolName: "SendMessage",
          input: { to: "worker", message: "Re-run the suite.\nThen report." },
        }),
      ),
    ).toEqual(["SendMessage", "workerRe-run the suite."]);
  });

  test("ListAgents projects the name alone", () => {
    expect(toolHeaderParts(call({ toolName: "ListAgents" }))).toEqual([
      "ListAgents",
    ]);
  });

  test("ReportFindings projects the level as its target", () => {
    expect(
      toolHeaderParts(
        call({ toolName: "ReportFindings", input: { findings: [], level: "high" } }),
      ),
    ).toEqual(["ReportFindings", "high"]);
  });

  test("Workflow projects the script's meta name", () => {
    expect(
      toolHeaderParts(
        call({
          toolName: "Workflow",
          input: { script: "export const meta = { name: 'review-changes', description: 'd' }" },
        }),
      ),
    ).toEqual(["Workflow", "review-changes"]);
  });

  test("DesignSync projects its composed name and the path", () => {
    expect(
      toolHeaderParts(
        call({
          toolName: "DesignSync",
          input: { method: "get_file", projectId: "p", path: "c/button.html" },
        }),
      ),
    ).toEqual(["Design Sync · get_file", "c/button.html"]);
  });

  test("a tool with no header target projects the name alone", () => {
    expect(toolHeaderParts(call({ toolName: "AskUserQuestion" }))).toEqual([
      "AskUserQuestion",
    ]);
  });

  test("a hidden tool projects nothing — it paints no ink", () => {
    expect(toolHeaderParts(call({ toolName: "ToolSearch" }))).toEqual([]);
  });

  test("a drifted call projects the DefaultToolBlock shape, not the wrapper's", () => {
    // An unknown tool name is drift: the transcript mounts `DefaultToolBlock`
    // (a JsonTree over the payload), whose header carries the name and no
    // target — even though the input looks like a Grep.
    expect(
      toolHeaderParts(
        call({ toolName: "NotARealTool", input: { pattern: "TODO" } }),
      ),
    ).toEqual(["NotARealTool"]);
  });
});
