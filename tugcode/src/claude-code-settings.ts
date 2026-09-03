// Read Claude Code's per-user settings file (`~/.claude/settings.json`).
//
// Today this surfaces a single bit — whether the user has the autocompact
// buffer enabled — but the shape is generalizable: any field tugcode needs
// from Claude Code's user-level configuration lives here.
//
// Spike S5 in the assistant-turns context-breakdown spikes record
// established that the SDK does not expose this setting; tugcode reads the
// settings file directly. Missing file, malformed JSON, and absent field
// all degrade to Claude Code's documented default (`autoCompactEnabled:
// true`) rather than failing the session, since the breakdown popover is
// resilient to a wrong-by-one-slice value and a session that boots
// without context_breakdown for a malformed-config edge case would be
// strictly worse.

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ClaudeCodeSettings {
  /**
   * Claude Code's `autoCompactEnabled` setting. Defaults to `true` —
   * matches Claude Code's documented behavior when the field is absent.
   * When `true`, the popover renders a reserved-buffer slice; when
   * `false`, the slice is omitted and the breakdown's free-space
   * remainder grows.
   */
  autoCompactEnabled: boolean;
}

/**
 * Default settings used when the file is missing, unreadable, or its
 * contents cannot be parsed. Safer to default to the Claude Code CLI's
 * own defaults than to fail the session — the breakdown popover can
 * recover from a wrong autocompact slice, but it cannot recover from
 * not having a frame at all.
 */
export const DEFAULT_CLAUDE_CODE_SETTINGS: ClaudeCodeSettings = {
  autoCompactEnabled: true,
};

/**
 * Default on-disk path: `<HOME>/.claude/settings.json`. Exposed so
 * tests can compose an override path without re-implementing the
 * resolution logic.
 */
export function defaultClaudeCodeSettingsPath(): string {
  return join(homedir(), ".claude", "settings.json");
}

/**
 * Read and parse Claude Code's user-level settings. Best-effort: on
 * any error (missing file, IO error, JSON parse failure, unexpected
 * field type) returns {@link DEFAULT_CLAUDE_CODE_SETTINGS}.
 *
 * The optional `path` parameter is for tests; production callers
 * use the default location.
 */
export async function readClaudeCodeSettings(
  path: string = defaultClaudeCodeSettingsPath(),
): Promise<ClaudeCodeSettings> {
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch {
    return DEFAULT_CLAUDE_CODE_SETTINGS;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return DEFAULT_CLAUDE_CODE_SETTINGS;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return DEFAULT_CLAUDE_CODE_SETTINGS;
  }
  const record = parsed as Record<string, unknown>;
  const autoCompactEnabled =
    typeof record.autoCompactEnabled === "boolean"
      ? record.autoCompactEnabled
      : DEFAULT_CLAUDE_CODE_SETTINGS.autoCompactEnabled;
  return { autoCompactEnabled };
}
