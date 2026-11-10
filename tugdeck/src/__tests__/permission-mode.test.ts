/**
 * permission-mode.test.ts — pure-logic coverage for the permission-mode
 * cycle, label formatting, and persisted-value parsing.
 *
 * No store, no DOM — these are the unit-testable halves of Step 1; the
 * chip rendering and the IPC / tugbank round-trip are covered by the
 * real-app test (`at0088-permission-mode-chip.test.ts`).
 */

import { describe, expect, test } from "bun:test";
import type { TaggedValue } from "@/lib/tugbank-client";
import {
  PERMISSION_MODE_CYCLE,
  PERMISSION_MODE_MENU,
  cyclePermissionMode,
  formatPermissionMode,
  parsePersistedPermissionMode,
  resolveSeedPermissionMode,
} from "@/lib/permission-mode";

describe("cyclePermissionMode", () => {
  test("steps through the 4-way cycle and wraps", () => {
    expect(cyclePermissionMode("default")).toBe("acceptEdits");
    expect(cyclePermissionMode("acceptEdits")).toBe("plan");
    expect(cyclePermissionMode("plan")).toBe("auto");
    expect(cyclePermissionMode("auto")).toBe("default");
  });

  test("a full round trip returns to the start", () => {
    let mode: string = PERMISSION_MODE_CYCLE[0];
    for (let i = 0; i < PERMISSION_MODE_CYCLE.length; i++) {
      mode = cyclePermissionMode(mode);
    }
    expect(mode).toBe(PERMISSION_MODE_CYCLE[0]);
  });

  test("null and out-of-cycle modes reset to default", () => {
    expect(cyclePermissionMode(null)).toBe("default");
    expect(cyclePermissionMode("bypassPermissions")).toBe("default");
    expect(cyclePermissionMode("dontAsk")).toBe("default");
    expect(cyclePermissionMode("delegate")).toBe("default");
    expect(cyclePermissionMode("nonsense")).toBe("default");
  });
});

describe("formatPermissionMode", () => {
  test("known modes render their label", () => {
    expect(formatPermissionMode("default")).toBe("Default");
    expect(formatPermissionMode("acceptEdits")).toBe("Accept Edits");
    expect(formatPermissionMode("plan")).toBe("Plan");
    expect(formatPermissionMode("auto")).toBe("Auto");
    expect(formatPermissionMode("bypassPermissions")).toBe("Bypass");
  });

  test("null renders the transient ellipsis", () => {
    expect(formatPermissionMode(null)).toBe("…");
  });

  test("an unknown mode falls back to its raw string", () => {
    expect(formatPermissionMode("futureMode")).toBe("futureMode");
  });
});

describe("PERMISSION_MODE_MENU", () => {
  test("contains every cycle mode plus bypassPermissions", () => {
    for (const mode of PERMISSION_MODE_CYCLE) {
      expect(PERMISSION_MODE_MENU).toContain(mode);
    }
    expect(PERMISSION_MODE_MENU).toContain("bypassPermissions");
  });

  test("every menu entry has a human label", () => {
    for (const mode of PERMISSION_MODE_MENU) {
      expect(formatPermissionMode(mode)).not.toBe("…");
      expect(formatPermissionMode(mode)).not.toBe(mode);
    }
  });
});

describe("resolveSeedPermissionMode", () => {
  test("per-card persisted mode wins over the global default", () => {
    expect(resolveSeedPermissionMode("plan", "acceptEdits")).toBe("plan");
  });

  test("falls back to the global default when nothing is persisted", () => {
    expect(resolveSeedPermissionMode(null, "acceptEdits")).toBe("acceptEdits");
  });

  test("falls back to the built-in default (auto) when neither is set", () => {
    expect(resolveSeedPermissionMode(null, null)).toBe("auto");
  });
});

describe("parsePersistedPermissionMode", () => {
  test("reads a string-kinded tagged value", () => {
    const entry: TaggedValue = { kind: "string", value: "plan" };
    expect(parsePersistedPermissionMode(entry)).toBe("plan");
  });

  test("returns null for undefined or non-string kinds", () => {
    expect(parsePersistedPermissionMode(undefined)).toBeNull();
    expect(parsePersistedPermissionMode({ kind: "number", value: 3 })).toBeNull();
    expect(parsePersistedPermissionMode({ kind: "string", value: 42 })).toBeNull();
  });
});
