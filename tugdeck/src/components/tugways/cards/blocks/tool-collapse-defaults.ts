/**
 * `tool-collapse-defaults.ts` — the single, plainly-editable source of
 * truth for which tool blocks mount **expanded** in the transcript
 * ([P06]/[P07]).
 *
 * The transcript dispatch site (`CodeRowBody` in `session-card-transcript`)
 * reads `collapseDefaultFor(toolName)` and wraps a block in
 * `ToolBlockHistoryCollapse` (default-collapsed, body materializes on
 * expand) when it returns `true` — applied **live and historical**, the
 * same for an in-flight call and a replayed one.
 *
 * Policy: tool blocks mount **collapsed by default**. The collapsed
 * header alone (tool + target + one-line result badge) is enough to scan
 * a transcript; the body is one click away. Only the few content-bearing
 * tools the user is meant to read or act on *as it arrives* mount
 * expanded — the {@link EXPANDED_BY_DEFAULT} allowlist. Everything else,
 * including every tool not yet known here (new wrappers, unknown / MCP
 * tools routed through `DefaultToolBlock`), collapses; a new tool is
 * quiet by default and opts into expansion explicitly.
 *
 * This governs **whole-block** collapse only (header vs header+body). It
 * is deliberately separate from a tool block's own *body-internal* fold
 * (`BlockChrome`'s `fold` / a body kind's size-threshold collapse),
 * which is a finer affordance keyed on content size, not tool kind.
 *
 * Keys are lowercased wire tool names (`message.toolName`).
 *
 * @module components/tugways/cards/blocks/tool-collapse-defaults
 */

import type { ToolUseMessage } from "@/lib/code-session-store/types";
import { parseGitCommit } from "@/components/tugways/body-kinds/commit-block";

/**
 * The tools that mount **expanded**. Everything else collapses by
 * default — file/shell I/O, ops tools (monitor / worktree / cron /
 * task-mgmt / remote-trigger), notebook edits, web fetch / search, and
 * any unknown tool all arrive collapsed to their self-describing header.
 *
 * Add a lowercased wire name here to keep a tool open on arrival.
 */
export const EXPANDED_BY_DEFAULT: ReadonlySet<string> = new Set([
  // The Q&A decision artifact — the user reads it and acts on it, so it
  // arrives open rather than behind a click.
  "askuserquestion",
  // An Agent run — its sub-tool calls each collapse per this same policy,
  // so an expanded Agent reads as the normal transcript indented one
  // level (its own well), while the noisy children stay folded. `task` is
  // the pre-rename wire name (Claude Code renamed `Task` → `Agent`); both
  // resolve to the same block, so both open.
  "agent",
  "task",
  // A review's findings — the call's input IS the report the user reads
  // and acts on, so it arrives open like the Q&A artifact.
  "reportfindings",
]);

/**
 * Whether a tool block of `toolName` mounts collapsed by default.
 * Case-insensitive. Collapse is the default; only {@link
 * EXPANDED_BY_DEFAULT} tools mount expanded.
 */
export function collapseDefaultFor(toolName: string): boolean {
  return !EXPANDED_BY_DEFAULT.has(toolName.toLowerCase());
}

/**
 * Whole-block collapse default for a tool-call message. Same policy as
 * {@link collapseDefaultFor}, plus one content-aware case the tool name
 * alone can't see: a `Bash` call that rendered the commit receipt
 * (`parseGitCommit` recognizes a successful `git commit`) mounts expanded
 * — the user reads and acts on it, like the AskUserQuestion artifact.
 */
export function collapseDefaultForMessage(message: ToolUseMessage): boolean {
  if (message.toolName.toLowerCase() === "bash") {
    const command = (message.input as { command?: unknown } | null)?.command;
    // Mirror the receipt's own stdout source (`composeTerminalData`):
    // structured stdout first, else the bare/ wrapped text result.
    const structuredStdout = (
      message.structuredResult as { stdout?: unknown } | null
    )?.stdout;
    const stdout =
      typeof structuredStdout === "string"
        ? structuredStdout
        : typeof message.result === "string"
          ? message.result
          : typeof (message.result as { output?: unknown } | null)?.output ===
              "string"
            ? (message.result as { output: string }).output
            : "";
    if (typeof command === "string" && parseGitCommit(command, stdout) !== null) {
      return false;
    }
  }
  return collapseDefaultFor(message.toolName);
}
