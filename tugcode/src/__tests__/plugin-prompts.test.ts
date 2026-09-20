/**
 * plugin-prompts.test.ts — reading the prompt files the plugin ships.
 *
 * These texts reach every session through the system prompt, so the thing
 * worth pinning is what happens when one is not there: a bundle built without
 * a file must still spawn, with whatever it does carry. Absence is a state
 * rather than an error, each file is read independently, and the order is the
 * list's.
 */
import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPluginPrompts } from "../session.ts";

function withPluginDir(files: Record<string, string>, body: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "plugin-prompts-"));
  try {
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
    body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("readPluginPrompts", () => {
  test("returns each file's trimmed text, in the list's order", () => {
    withPluginDir(
      {
        "ask-user-question.md": "# AskUserQuestion\n",
        "transcript-prose.md": "\n# Writing prose\n",
        "file-editing.md": "\n# Editing project files\n",
        "work-grammar.md": "\n# The work grammar\n\nfour words\n",
      },
      (dir) => {
        expect(readPluginPrompts(dir)).toEqual([
          "# The work grammar\n\nfour words",
          "# Editing project files",
          "# Writing prose",
          "# AskUserQuestion",
        ]);
      },
    );
  });

  test("an absent file is skipped and the others still arrive", () => {
    withPluginDir({ "file-editing.md": "# Editing project files\n" }, (dir) => {
      expect(readPluginPrompts(dir)).toEqual(["# Editing project files"]);
    });
  });

  test("returns nothing when the plugin carries none of them", () => {
    withPluginDir({}, (dir) => {
      expect(readPluginPrompts(dir)).toEqual([]);
    });
  });
});
