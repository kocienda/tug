/**
 * claude-home.ts — where the app under test's Claude Code keeps things.
 *
 * Re-exports tugcode's `ClaudeHome`, so a fixture seeds transcripts exactly
 * where tugcode will read them: `$CLAUDE_CONFIG_DIR` when set, otherwise
 * `$HOME/.claude`. Tug.app inherits this process's environment, so the two
 * resolve to the same directory. Build every Claude Code path through this
 * module — the literal ban in `tugcode/src/__tests__/claude-home.test.ts`
 * covers `tests/app-test`.
 */

import { claudeHomeFromEnv } from "../../../tugcode/src/claude-home";

export {
  ClaudeHome,
  claudeHomeFromEnv,
  encodeProjectDir,
  projectClaudeDir,
} from "../../../tugcode/src/claude-home";

/**
 * `projects/<encoded dir>/` in the user's config directory — where a fixture
 * seeds a transcript for a session the app will resume in `dir`. `dir` is
 * encoded as given, so resolve it first (`realpathSync`) when it may be a
 * symlinked spelling such as macOS's `/var/folders/…`.
 */
export function claudeProjectDir(dir: string): string {
  return claudeHomeFromEnv().projectDir(dir);
}
