/**
 * terminal-liveness.ts — is a claude session currently held by another
 * live process?
 *
 * Claude Code maintains a per-process registry at `~/.claude/sessions/`
 * (one `<pid>.json` per running claude, removed on clean exit). The
 * destructive in-place rewind truncates a session's JSONL on disk; if a
 * terminal process resumed the same session after our card opened it,
 * the truncate would yank live history out from under it. This module
 * is the TS mirror of tugcast's `terminal_registry.rs` liveness rule —
 * keep the two in sync:
 *
 *  - lenient parse: only `pid` (number) + `sessionId` (string) required;
 *  - pid liveness via `process.kill(pid, 0)` (EPERM = alive, not ours);
 *  - pid-reuse guard: when the entry carries `procStart` and
 *    `ps -p <pid> -o lstart=` resolves, the two must match after
 *    whitespace normalization;
 *  - fail-open: a missing/unreadable registry yields `false` — the
 *    check degrades to the pre-liveness status quo, never an error.
 *
 * Our own claude child also registers here (entrypoint `sdk-cli`), so
 * callers pass its pid via `excludePids` — holding the session
 * ourselves is the normal rewind precondition, not a conflict.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { claudeHomeFromEnv } from "./claude-home.ts";

export interface TerminalLivenessOptions {
  /** Registry root override; defaults to the Claude home's `sessions/`. */
  registryRoot?: string;
  /** Pids to ignore — our own claude subprocess. */
  excludePids?: readonly number[];
}

/** Production registry location. */
export function defaultRegistryRoot(): string {
  return claudeHomeFromEnv().sessionsDir();
}

function normalizeWhitespace(s: string): string {
  return s.split(/\s+/).filter((p) => p.length > 0).join(" ");
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Actual start time of `pid` as `ps` formats `lstart`, whitespace-
 * normalized. `null` when `ps` fails or returns nothing (treat as
 * unverifiable → accept, fail-open).
 */
function actualProcStart(pid: number): string | null {
  try {
    const proc = Bun.spawnSync(["ps", "-p", String(pid), "-o", "lstart="]);
    if (proc.exitCode !== 0) return null;
    const normalized = normalizeWhitespace(proc.stdout.toString());
    return normalized.length > 0 ? normalized : null;
  } catch {
    return null;
  }
}

function procStartMatches(recorded: unknown, pid: number): boolean {
  if (typeof recorded !== "string" || recorded.length === 0) return true;
  const actual = actualProcStart(pid);
  if (actual === null) return true;
  return normalizeWhitespace(recorded) === actual;
}

/**
 * True when a live process OTHER than the excluded pids currently holds
 * `sessionId` per the registry. Fail-open on every error path.
 */
export function isSessionHeldByOtherProcess(
  sessionId: string,
  opts: TerminalLivenessOptions = {},
): boolean {
  const root = opts.registryRoot ?? defaultRegistryRoot();
  const exclude = new Set(opts.excludePids ?? []);
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return false;
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(join(root, name), "utf-8"));
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const entry = parsed as {
      pid?: unknown;
      sessionId?: unknown;
      procStart?: unknown;
    };
    if (typeof entry.pid !== "number" || entry.sessionId !== sessionId) continue;
    if (exclude.has(entry.pid)) continue;
    if (!isPidAlive(entry.pid)) continue;
    if (!procStartMatches(entry.procStart, entry.pid)) continue;
    return true;
  }
  return false;
}
