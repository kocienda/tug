/**
 * fixtures.ts — the small helpers the corpus used to copy into each file.
 *
 * Each one here was defined, byte for byte or differing only in a value, in
 * several test files and exported by none. A helper with the same name that
 * does something different in each file — `seed`, `census`, `arcReport`,
 * `standUp` — is not here: those files keep their own, with a comment saying
 * why, because the name is shared and the function is not.
 *
 * Import by name from `./_harness/fixtures`; `_harness/index.ts` does not
 * re-export this module.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Gallery input
// ---------------------------------------------------------------------------

/** The persist key of the gallery card's small text input. */
export const INPUT_PERSIST_KEY = "gallery-input/size/sm";

/** The gallery's small text input inside the card `cardId`. */
export function inputSelectorFor(cardId: string): string {
  return `[data-card-id="${cardId}"] [data-tug-state-key="${INPUT_PERSIST_KEY}"]`;
}

// ---------------------------------------------------------------------------
// A file on disk for a Text card
// ---------------------------------------------------------------------------

export interface TextFixtureOptions {
  /** The file's name inside the temp directory. Default `"sample.txt"`. */
  name?: string;
  /**
   * Resolve the temp directory through its symlinks. On macOS `os.tmpdir()`
   * is under `/var`, a link to `/private/var`, and a card holds and reports
   * the resolved path: a test that compares a path the card hands back, or
   * keys a watch by it, needs the resolved spelling too. Default `false`.
   */
  realpath?: boolean;
}

/**
 * A fresh temp directory, named from `prefix` the way `mkdtempSync` names
 * one, holding one file with `content`. The caller removes `dir`.
 */
export function mkTextFixture(
  prefix: string,
  content: string,
  options: TextFixtureOptions = {},
): { dir: string; file: string } {
  const made = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const dir = options.realpath ? fs.realpathSync(made) : made;
  const file = path.join(dir, options.name ?? "sample.txt");
  fs.writeFileSync(file, content, "utf8");
  return { dir, file };
}

// ---------------------------------------------------------------------------
// A resumable Claude transcript
// ---------------------------------------------------------------------------

/**
 * A two-line Claude Code transcript — one user prompt and its assistant
 * reply, ten minutes old — for session `sessionId` in project `cwd`. The
 * message uuids are derived from the session id, so two sessions written
 * into one projects directory never collide.
 */
export function oneTurnSessionJsonl(cwd: string, sessionId: string): string {
  const t0 = new Date(Date.now() - 600_000).toISOString();
  const t1 = new Date(Date.now() - 599_000).toISOString();
  const base = {
    isSidechain: false,
    userType: "external",
    cwd,
    sessionId,
    version: "2.1.105",
    gitBranch: "main",
  };
  const head = `00000000-0000-4000-8000-0000000${sessionId.slice(-5)}`;
  const lines = [
    {
      ...base,
      parentUuid: null,
      type: "user",
      uuid: head,
      timestamp: t0,
      message: { role: "user", content: [{ type: "text", text: "hello" }] },
    },
    {
      ...base,
      parentUuid: head,
      type: "assistant",
      uuid: `00000000-0000-4000-8000-0000001${sessionId.slice(-5)}`,
      timestamp: t1,
      message: {
        id: `msg-${sessionId.slice(-6)}`,
        type: "message",
        role: "assistant",
        model: "claude-opus-4-8",
        content: [{ type: "text", text: "hi there" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: {
          input_tokens: 1200,
          output_tokens: 50,
          cache_creation_input_tokens: 100,
          cache_read_input_tokens: 8000,
        },
      },
    },
  ];
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}
