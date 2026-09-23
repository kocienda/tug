/**
 * macos-support unit tests (pure — no jsdom, no React render).
 *
 * Covers:
 * - parseMacosVersion / compareMacosVersion.
 * - isHostBelowFloor across below / at / above floor, unknown old + future
 *   lines, and unknown/unparseable host (fail-open).
 * - deriveConfigureTugOpen precedence: false whenever the gate is open.
 * - Drift: SUPPORTED_MACOS matches scripts/lab/matrix.json min_version.
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseMacosVersion,
  compareMacosVersion,
  isHostBelowFloor,
  deriveConfigureTugOpen,
  requiredMinimumLabel,
  SUPPORTED_MACOS,
} from "../lib/macos-support";
import type { HostInfo } from "../lib/host-info-store";

const mac = (version: string): HostInfo => ({ os: "macos", version });

describe("parseMacosVersion", () => {
  test("parses N / N.N / N.N.N with zero-fill", () => {
    expect(parseMacosVersion("15.7.7")).toEqual({ major: 15, minor: 7, patch: 7 });
    expect(parseMacosVersion("15.6")).toEqual({ major: 15, minor: 6, patch: 0 });
    expect(parseMacosVersion("26")).toEqual({ major: 26, minor: 0, patch: 0 });
  });
  test("rejects non-numeric / malformed", () => {
    expect(parseMacosVersion("")).toBeNull();
    expect(parseMacosVersion("15.x")).toBeNull();
    expect(parseMacosVersion("v15")).toBeNull();
  });
});

describe("compareMacosVersion", () => {
  test("orders by major, then minor, then patch", () => {
    expect(compareMacosVersion({ major: 15, minor: 6, patch: 0 }, { major: 15, minor: 6, patch: 0 })).toBe(0);
    expect(compareMacosVersion({ major: 15, minor: 5, patch: 9 }, { major: 15, minor: 6, patch: 0 })).toBeLessThan(0);
    expect(compareMacosVersion({ major: 26, minor: 0, patch: 0 }, { major: 15, minor: 9, patch: 9 })).toBeGreaterThan(0);
  });
});

describe("isHostBelowFloor", () => {
  test("below its line's floor → true", () => {
    expect(isHostBelowFloor(mac("15.5"))).toBe(true); // Sequoia min is 15.6
    expect(isHostBelowFloor(mac("15.5.9"))).toBe(true);
  });
  test("at or above its line's floor → false", () => {
    expect(isHostBelowFloor(mac("15.6"))).toBe(false);
    expect(isHostBelowFloor(mac("15.7.7"))).toBe(false);
    expect(isHostBelowFloor(mac("26.0"))).toBe(false);
    // The three versions certified in the VM lab on 2026-09-23. 27.0 is the
    // 27 line's floor exactly, and was the first real Golden Gate host — the
    // boundary the other two lines already cover at 15.6 and 26.0.
    expect(isHostBelowFloor(mac("26.6.2"))).toBe(false);
    expect(isHostBelowFloor(mac("27.0"))).toBe(false);
    expect(isHostBelowFloor(mac("27.1"))).toBe(false);
  });
  test("line older than anything supported → true (block)", () => {
    expect(isHostBelowFloor(mac("14.6"))).toBe(true); // Sonoma
    expect(isHostBelowFloor(mac("13.0"))).toBe(true); // Ventura
  });
  test("line newer than anything supported → false (fail-open)", () => {
    expect(isHostBelowFloor(mac("28.0"))).toBe(false);
  });
  test("unknown / unparseable host → false (fail-open, [R02])", () => {
    expect(isHostBelowFloor(null)).toBe(false);
    expect(isHostBelowFloor(mac("not-a-version"))).toBe(false);
  });
});

describe("requiredMinimumLabel", () => {
  test("names the host line's minimum; falls back to lowest line", () => {
    expect(requiredMinimumLabel(mac("15.3"))).toBe("15.6");
    expect(requiredMinimumLabel(mac("26.0"))).toBe("26.0");
    expect(requiredMinimumLabel(mac("14.0"))).toBe("15.6"); // old line → lowest
    expect(requiredMinimumLabel(null)).toBe("15.6");
  });
});

describe("deriveConfigureTugOpen (gate precedence, Spec S02)", () => {
  test("gate open suppresses setup regardless of would-open", () => {
    expect(deriveConfigureTugOpen(true, true)).toBe(false);
    expect(deriveConfigureTugOpen(true, false)).toBe(false);
  });
  test("gate closed passes setup's own would-open through", () => {
    expect(deriveConfigureTugOpen(false, true)).toBe(true);
    expect(deriveConfigureTugOpen(false, false)).toBe(false);
  });
});

describe("drift: SUPPORTED_MACOS ↔ matrix.json", () => {
  test("every matrix min_version matches the policy entry for its major", () => {
    const matrixPath = join(import.meta.dir, "../../../scripts/lab/matrix.json");
    const matrix = JSON.parse(readFileSync(matrixPath, "utf8")) as Array<{
      key: string;
      min_version: string;
    }>;
    expect(matrix.length).toBeGreaterThan(0);
    for (const entry of matrix) {
      const v = parseMacosVersion(entry.min_version);
      expect(v).not.toBeNull();
      const line = SUPPORTED_MACOS[v!.major];
      expect(line, `policy has an entry for major ${v!.major} (${entry.key})`).toBeDefined();
      expect({ minor: line!.minor, patch: line!.patch }).toEqual({
        minor: v!.minor,
        patch: v!.patch,
      });
    }
  });
  test("every policy line has a matrix entry (no orphan policy)", () => {
    const matrixPath = join(import.meta.dir, "../../../scripts/lab/matrix.json");
    const matrix = JSON.parse(readFileSync(matrixPath, "utf8")) as Array<{
      min_version: string;
    }>;
    const matrixMajors = new Set(
      matrix.map((e) => parseMacosVersion(e.min_version)!.major),
    );
    for (const major of Object.keys(SUPPORTED_MACOS).map(Number)) {
      expect(matrixMajors.has(major), `matrix covers policy major ${major}`).toBe(true);
    }
  });
});
