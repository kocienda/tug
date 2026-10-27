/**
 * Pure-logic tests for `ListAgentsToolBlock`'s listing count and the
 * dispatch registration pin (`listagents` → `ListAgentsToolBlock`).
 *
 * @module components/tugways/cards/blocks/__tests__/list-agents-tool-block
 */

import { describe, expect, test } from "bun:test";

import {
  ListAgentsToolBlock,
  countListAgentsRows,
} from "../list-agents-tool-block";
import { BESPOKE_FACTORY_BY_NAME } from "../../session-assistant-renderer-registrations";

describe("countListAgentsRows", () => {
  test("counts dash, star, bullet and numbered rows", () => {
    const listing = [
      "Agents you can message:",
      "",
      "- worker [3fa9c1] — subagent, idle",
      "* researcher — teammate, busy",
      "• other-session — local session",
      "1. cloud-run — cloud session",
      "  2) remote — Remote Control",
    ].join("\n");
    expect(countListAgentsRows(listing)).toBe(5);
  });

  test("a bare marker with nothing after it is not a row", () => {
    expect(countListAgentsRows("-\n- \n")).toBe(0);
  });

  test("an absent or prose-only listing counts zero", () => {
    expect(countListAgentsRows(undefined)).toBe(0);
    expect(countListAgentsRows("No agents are available to message.")).toBe(0);
  });
});

describe("dispatch registration", () => {
  test("listagents → ListAgentsToolBlock", () => {
    expect(BESPOKE_FACTORY_BY_NAME.get("listagents")).toBe(ListAgentsToolBlock);
  });
});
