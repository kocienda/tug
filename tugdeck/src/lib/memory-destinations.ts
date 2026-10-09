/**
 * memory-destinations.ts — the memory files/folders `/memory` offers to open
 * ([#step-12a]).
 *
 * Mirrors Claude Code's `/memory`: the project memory (`<cwd>/CLAUDE.md`,
 * checked in), the user memory (`CLAUDE.md` in Claude Code's config
 * directory), and the auto-memory folder (`projects/<encoded-cwd>/memory`
 * there). Selecting a row hands the path to the OS (see {@link openPathInOS})
 * — read-only here, editing happens in the OS editor.
 *
 * Pure: paths are derived from the session cwd and the host facts tugcast
 * publishes. The web layer cannot read the environment, so the config
 * directory is tugcast's resolved `claudeHome` — `$CLAUDE_CONFIG_DIR`, else
 * `$HOME/.claude` — and the layout under it is the shared `ClaudeHome`, whose
 * encoder is Claude Code's own, so the auto-memory folder resolves to the
 * directory Claude Code writes.
 *
 * @module lib/memory-destinations
 */

import { ClaudeHome } from "@tugproto/claude-home";

/** A memory file or folder `/memory` can open in the OS. */
export interface MemoryDestination {
  /** Stable list key. */
  id: string;
  /** Row title, e.g. "Project memory". */
  label: string;
  /** Row subtitle — where it lives, e.g. "Checked in at ./CLAUDE.md". */
  detail: string;
  /** Path to open — absolute, or `~`-relative for the host to expand. */
  path: string;
  /** Whether the path is a file (opens in an editor) or a folder (Finder). */
  kind: "file" | "folder";
}

/** The host facts a destination is formatted from. */
export interface ClaudeHostFacts {
  /** The backend user's home, for writing paths under it as `~/…`. */
  home: string;
  /** Claude Code's config directory, as tugcast resolved it. */
  claudeHome: string;
}

/**
 * `path` as a person reads it: under `home`, written `~/…`; anywhere else
 * (a `CLAUDE_CONFIG_DIR` outside home), written as is.
 */
export function displayPath(path: string, home: string): string {
  if (home.length === 0) return path;
  if (path === home) return "~";
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/**
 * The memory destinations for the session's `cwd`. The project and
 * auto-memory rows need the cwd (Claude Code's real resolved cwd —
 * `system_metadata.cwd`), and the user and auto-memory rows need the config
 * directory tugcast publishes; each is omitted while what it needs is
 * unknown. Order matches Claude Code's `/memory`: project, user, auto-memory.
 */
export function memoryDestinations(
  cwd: string | null,
  facts: ClaudeHostFacts | null,
): MemoryDestination[] {
  const dests: MemoryDestination[] = [];
  const knownCwd = cwd !== null && cwd.length > 0 ? cwd : null;
  const claudeHome =
    facts !== null && facts.claudeHome.length > 0 ? ClaudeHome.at(facts.claudeHome) : null;
  const home = facts?.home ?? "";
  if (knownCwd !== null) {
    dests.push({
      id: "project",
      label: "Project memory",
      detail: "Checked in at ./CLAUDE.md",
      path: `${knownCwd}/CLAUDE.md`,
      kind: "file",
    });
  }
  if (claudeHome !== null) {
    const path = claudeHome.memoryPath();
    dests.push({
      id: "user",
      label: "User memory",
      detail: `Saved in ${displayPath(path, home)}`,
      path,
      kind: "file",
    });
  }
  if (claudeHome !== null && knownCwd !== null) {
    dests.push({
      id: "auto",
      label: "Auto-memory folder",
      detail: "Per-conversation memory entries",
      path: claudeHome.autoMemoryDir(knownCwd),
      kind: "folder",
    });
  }
  return dests;
}
