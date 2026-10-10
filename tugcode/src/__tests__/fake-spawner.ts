/**
 * Test helpers for the `spawner` constructor option of {@link SessionManager}.
 *
 * A fake child is a plain object carrying only the fields a test exercises,
 * not a full `Bun.Subprocess`, so the one cast from the fake's shape to
 * {@link ClaudeSpawner} lives here rather than at every call site.
 */

import type { ClaudeSpawner } from "../session.ts";

/** Wrap a function returning a fake child as a {@link ClaudeSpawner}. */
export function fakeSpawner(
  spawn: (args: string[], env: Record<string, string | undefined>) => unknown,
): ClaudeSpawner {
  return spawn as ClaudeSpawner;
}

/**
 * The session id and mode a claude argv was composed for: `--resume <id>` is
 * a resume, `--session-id <id>` claims a new id. An argv with neither carries
 * no id.
 */
export function spawnedAs(args: readonly string[]): {
  id: string | null;
  mode: "session-id" | "resume";
} {
  const resume = args.indexOf("--resume");
  if (resume >= 0) return { id: args[resume + 1] ?? null, mode: "resume" };
  const claim = args.indexOf("--session-id");
  if (claim >= 0) return { id: args[claim + 1] ?? null, mode: "session-id" };
  return { id: null, mode: "session-id" };
}
