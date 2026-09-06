/**
 * work-grammar.test.ts — reading the work grammar the plugin ships.
 *
 * The grammar reaches every session through the system prompt, so the one
 * thing worth pinning is what happens when it is not there: a bundle built
 * without the file must still spawn, with the nudge alone. Absence is a state
 * rather than an error, and `null` is how the spawn config says so.
 */
import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readWorkGrammar, WORK_GRAMMAR_FILE } from "../session.ts";

describe("readWorkGrammar", () => {
  test("returns the file's trimmed text when the plugin carries it", () => {
    const dir = mkdtempSync(join(tmpdir(), "work-grammar-"));
    try {
      writeFileSync(join(dir, WORK_GRAMMAR_FILE), "\n# The work grammar\n\nfour words\n");
      expect(readWorkGrammar(dir)).toBe("# The work grammar\n\nfour words");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("returns null when the plugin carries no grammar", () => {
    const dir = mkdtempSync(join(tmpdir(), "work-grammar-"));
    try {
      expect(readWorkGrammar(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
