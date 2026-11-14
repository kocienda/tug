/**
 * claude-code-versions.test.ts — the deck's two Claude Code versions are the
 * two files in `capabilities/`, by both routes that carry them.
 *
 * A Vite build inlines them through `claudeCodeVersionDefines`; everything
 * else reads the files off the checkout. The two routes have to agree, or a
 * test would pass against a floor the shipped bundle does not enforce.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { VALIDATED_CC_VERSION } from "@/components/tugways/cards/session-assistant-renderer-dispatch";
import { compareVersions, MIN_CLAUDE_CODE_VERSION } from "@/components/tugways/configure-tug-copy";
import { CLAUDE_CODE_FLOOR_VERSION, VALIDATED_CLAUDE_CODE_VERSION } from "@/lib/claude-code-versions";

import { claudeCodeVersionDefines } from "../../../vite.config";

const CAPABILITIES_ROOT = join(import.meta.dir, "..", "..", "..", "..", "capabilities");
const onDisk = (file: string): string => readFileSync(join(CAPABILITIES_ROOT, file), "utf-8").trim();

describe("the deck's Claude Code versions", () => {
  test("the validated version is the capture pointer", () => {
    expect(VALIDATED_CLAUDE_CODE_VERSION).toBe(onDisk("LATEST"));
    expect(VALIDATED_CC_VERSION).toBe(onDisk("LATEST"));
  });

  test("the floor is the floor file", () => {
    expect(CLAUDE_CODE_FLOOR_VERSION).toBe(onDisk("FLOOR"));
    expect(MIN_CLAUDE_CODE_VERSION).toBe(onDisk("FLOOR"));
  });

  test("a build inlines the same two values the checkout holds", () => {
    expect(claudeCodeVersionDefines()).toEqual({
      __TUG_CLAUDE_CODE_VALIDATED__: JSON.stringify(VALIDATED_CLAUDE_CODE_VERSION),
      __TUG_CLAUDE_CODE_FLOOR__: JSON.stringify(CLAUDE_CODE_FLOOR_VERSION),
    });
  });

  test("the floor is not above the version the captures were taken against", () => {
    expect(compareVersions(CLAUDE_CODE_FLOOR_VERSION, VALIDATED_CLAUDE_CODE_VERSION)).toBeLessThanOrEqual(0);
  });

  test("a build refuses a floor file that does not hold a version", () => {
    const root = mkdtempSync(join(tmpdir(), "tug-claude-versions-"));
    writeFileSync(join(root, "LATEST"), "2.1.325\n");
    expect(() => claudeCodeVersionDefines(root)).toThrow(/FLOOR not found/);
    writeFileSync(join(root, "FLOOR"), "<html>\n");
    expect(() => claudeCodeVersionDefines(root)).toThrow(/not a version/);
    writeFileSync(join(root, "FLOOR"), "2.1.285\n");
    expect(claudeCodeVersionDefines(root).__TUG_CLAUDE_CODE_FLOOR__).toBe('"2.1.285"');
  });
});
