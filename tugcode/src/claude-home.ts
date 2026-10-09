/**
 * Where Claude Code keeps things — the one answer every tugcode reader uses.
 *
 * The rule and the layout are `@tugproto/claude-home`, shared with the deck,
 * which cannot read an environment. This module re-exports them and adds the
 * one call that reads this process's: {@link claudeHomeFromEnv} resolves
 * `$CLAUDE_CONFIG_DIR`, else `$HOME/.claude`, so the `claude` tugcode spawns —
 * which inherits the same environment — writes where tugcode reads.
 *
 * The Rust half is `tugcore::claude_home`. Both run the cases in
 * `tugrust/crates/tugcore/src/claude_home_cases.json`, which is what keeps
 * the two from drifting.
 */

import { homedir } from "node:os";

import { ClaudeHome } from "@tugproto/claude-home";

export {
  ClaudeHome,
  encodeProjectDir,
  projectClaudeDir,
} from "@tugproto/claude-home";

/** The directory this process's environment points Claude Code at. */
export function claudeHomeFromEnv(
  env: Record<string, string | undefined> = process.env,
): ClaudeHome {
  return ClaudeHome.resolve(env.CLAUDE_CONFIG_DIR, homedir());
}
