/**
 * Pure-logic tests for `DesignSyncToolBlock`'s wire-narrowing and
 * header composition, plus the dispatch registration pin
 * (`designsync` → `DesignSyncToolBlock`).
 *
 * @module components/tugways/cards/blocks/__tests__/design-sync-tool-block
 */

import { describe, expect, test } from "bun:test";

import {
  DesignSyncToolBlock,
  composeDesignSyncTarget,
  composeDesignSyncToolName,
  narrowDesignSyncInput,
} from "../design-sync-tool-block";
import { BESPOKE_FACTORY_BY_NAME } from "../../session-assistant-renderer-registrations";

describe("narrowDesignSyncInput", () => {
  test("keeps the identifying strings and counts the list fields present", () => {
    expect(
      narrowDesignSyncInput({
        method: "finalize_plan",
        projectId: "proj-1",
        localDir: "/work",
        writes: ["a.html", "b/**/*.html"],
        deletes: [],
        files: "not-a-list",
      }),
    ).toEqual({
      method: "finalize_plan",
      projectId: "proj-1",
      path: undefined,
      planId: undefined,
      name: undefined,
      localDir: "/work",
      counts: [
        ["writes", 2],
        ["deletes", 0],
      ],
    });
  });

  test("returns the empty shape for non-object input", () => {
    expect(narrowDesignSyncInput(undefined)).toEqual({ counts: [] });
  });
});

describe("composeDesignSyncToolName / composeDesignSyncTarget", () => {
  test("verb-qualified name when a method is present", () => {
    expect(composeDesignSyncToolName("get_file")).toBe("Design Sync · get_file");
    expect(composeDesignSyncToolName(undefined)).toBe("Design Sync");
  });

  test("target prefers path, then name, then project id", () => {
    const base = narrowDesignSyncInput({ projectId: "p" });
    expect(composeDesignSyncTarget(base)).toBe("p");
    expect(composeDesignSyncTarget({ ...base, name: "New kit" })).toBe("New kit");
    expect(
      composeDesignSyncTarget({ ...base, name: "New kit", path: "c/button.html" }),
    ).toBe("c/button.html");
    expect(composeDesignSyncTarget(narrowDesignSyncInput({}))).toBeUndefined();
  });
});

describe("dispatch registration", () => {
  test("designsync → DesignSyncToolBlock", () => {
    expect(BESPOKE_FACTORY_BY_NAME.get("designsync")).toBe(DesignSyncToolBlock);
  });
});
