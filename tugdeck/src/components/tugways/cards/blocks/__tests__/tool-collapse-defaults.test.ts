/**
 * tool-collapse-defaults.test.ts — the collapse policy ([P06]/[P07]):
 * tool blocks mount COLLAPSED by default; only the EXPANDED_BY_DEFAULT
 * allowlist mounts expanded; lookup is case-insensitive; unknown /
 * future / MCP tools collapse.
 */

import { describe, expect, test } from "bun:test";
import {
  collapseDefaultFor,
  EXPANDED_BY_DEFAULT,
} from "../tool-collapse-defaults";

describe("collapseDefaultFor", () => {
  test("collapses by default — file/shell and ops tools", () => {
    for (const name of [
      "Read", "Grep", "Glob", "Bash", "Edit", "MultiEdit", "Write",
      "Monitor", "Worktree", "Cron", "TaskMgmt", "NotebookEdit",
      "RemoteTrigger", "Skill", "WebFetch", "WebSearch",
    ]) {
      expect(collapseDefaultFor(name)).toBe(true);
    }
  });

  test("leaves the allowlisted content + agent tools expanded", () => {
    expect(collapseDefaultFor("AskUserQuestion")).toBe(false);
    // An Agent run opens so it reads as an indented transcript; its
    // children collapse per this same policy. `Task` is the pre-rename
    // wire name and resolves to the same block, so it opens too.
    expect(collapseDefaultFor("Agent")).toBe(false);
    expect(collapseDefaultFor("Task")).toBe(false);
  });

  test("unknown / future / MCP tools collapse by default", () => {
    expect(collapseDefaultFor("SomeFutureTool")).toBe(true);
    expect(collapseDefaultFor("mcp__server__do_thing")).toBe(true);
    expect(collapseDefaultFor("")).toBe(true);
  });

  test("lookup is case-insensitive", () => {
    expect(collapseDefaultFor("BASH")).toBe(true);
    expect(collapseDefaultFor("ReAd")).toBe(true);
    expect(collapseDefaultFor("ASKUSERQUESTION")).toBe(false);
  });

  test("the expanded allowlist is exactly the intended set", () => {
    expect([...EXPANDED_BY_DEFAULT].sort()).toEqual([
      "agent",
      "askuserquestion",
      "reportfindings",
      "task",
    ]);
  });
});
