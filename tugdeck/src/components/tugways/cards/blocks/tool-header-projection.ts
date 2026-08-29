/**
 * tool-header-projection — the store→text projection of a tool call's
 * HEADER, the index-side mirror of the `data-tugx-findable` containers
 * `BlockHeader` renders.
 *
 * A tool block's header is on screen in BOTH collapse states — it *is* the
 * whole block when collapsed — so it is searchable in both. Only the body,
 * which `BlockChrome` unmounts while collapsed, is expansion-gated. This
 * module is what lets the whole-transcript index count a collapsed block's
 * header without any of its rows being mounted.
 *
 * Two units per block, in DOM order, matching the two marked containers:
 *
 *  1. **The name** — `.tool-call-header-name`, marked by `BlockStrip` when
 *     `BlockHeader` sets `nameFindable`. Usually the wire tool name; the
 *     verb-composing wrappers (Cron, Worktree, TaskMgmt, RemoteTrigger,
 *     ShareOnboardingGuide) and Bash's commit receipt compose their own,
 *     which this module reproduces through the SAME exported helpers.
 *  2. **The target** — the identity element each wrapper marks: the Bash
 *     command, the Grep/Glob pattern, a `TugAtomRef`'s basename, the
 *     fetched URL, the skill name. Wrappers with no target (Default,
 *     AskUserQuestion) project one unit.
 *
 * The trailing sections — result summary, live timing, caution badge — are
 * deliberately NOT marked and NOT projected. The timing clock changes under
 * the reader, and the summaries are formatted metadata rather than the
 * call's content.
 *
 * **Routing must mirror the dispatch, not the registry.** A drifted call (an
 * unknown tool, or a registered wrapper whose `structured_result` failed its
 * shape schema) renders `DefaultToolBlock` regardless of what
 * `resolveToolBlock` would return, so this module routes through
 * `renderedToolBlock` — the same decision `dispatchToolCallState` makes.
 *
 * **Adding a wrapper is a two-sided checklist**: mark the target container
 * with `data-tugx-findable`, add the matching entry here, and extend the
 * projection tests. An unmarked-but-projected target inflates the match
 * count over what can paint; a marked-but-unprojected one paints highlights
 * the count never knew about, and the k-th DOM hit stops being the k-th
 * index hit — the invariant Find's navigation rests on.
 *
 * @module components/tugways/cards/blocks/tool-header-projection
 */

import type { ToolUseMessage } from "@/lib/code-session-store/types";
import { basename } from "@/lib/display-path";
import {
  NullToolBlock,
  extractTextOutput,
  renderedToolBlock,
} from "@/components/tugways/cards/session-assistant-renderer-dispatch";

import {
  BashToolBlock,
  composeTerminalData,
  narrowBashInput,
  narrowStructured as narrowBashStructured,
} from "./bash-tool-block";
import { parseGitCommit } from "@/components/tugways/body-kinds/commit-block";
import {
  CronToolBlock,
  composeCronArgsLabel,
  composeCronToolName,
  deriveCronVerb,
  narrowCronInput,
} from "./cron-tool-block";
import { EditToolBlock, narrowEditInput, narrowEditStructured } from "./edit-tool-block";
import { GlobToolBlock, narrowGlobInput } from "./glob-tool-block";
import { GrepToolBlock, narrowGrepInput } from "./grep-tool-block";
import {
  MonitorToolBlock,
  composeMonitorHeader,
  narrowMonitorInput,
} from "./monitor-tool-block";
import {
  NotebookEditToolBlock,
  narrowNotebookEditInput,
  narrowNotebookEditStructured,
} from "./notebook-edit-tool-block";
import { ReadToolBlock, narrowReadInput } from "./read-tool-block";
import {
  RemoteTriggerToolBlock,
  composeRemoteTriggerArgsLabel,
  composeRemoteTriggerToolName,
  narrowRemoteTriggerInput,
} from "./remote-trigger-tool-block";
import {
  ShareOnboardingGuideToolBlock,
  composeShareOnboardingGuideToolName,
  narrowShareOnboardingGuideInput,
} from "./share-onboarding-guide-tool-block";
import {
  SkillToolBlock,
  composeSkillHeaderArgs,
  narrowSkillInput,
} from "./skill-tool-block";
import {
  TaskMgmtToolBlock,
  composeTaskMgmtArgsLabel,
  composeTaskMgmtToolName,
  deriveTaskMgmtVerb,
  narrowTaskMgmtInput,
} from "./task-mgmt-tool-block";
import {
  TaskToolBlock,
  narrowAgentInput,
  narrowAgentStructured,
} from "./task-tool-block";
import { TaskInlineToolBlock } from "./task-inline-tool-block";
import { WebFetchToolBlock, narrowWebFetchInput } from "./web-fetch-tool-block";
import { WebSearchToolBlock, narrowWebSearchInput } from "./web-search-tool-block";
import {
  WriteToolBlock,
  narrowWriteInput,
  narrowWriteStructured,
} from "./write-tool-block";
import {
  WorktreeToolBlock,
  composeWorktreeHeader,
  composeWorktreeToolName,
  deriveWorktreeVerb,
  narrowWorktreeInput,
} from "./worktree-tool-block";

/** The name + target a block's header displays; either may be absent. */
interface HeaderProjection {
  name?: string;
  target?: string;
}

/**
 * Bash reshapes its whole header for a commit receipt: the name becomes
 * "Git Commit" and `CommitHeaderTarget` — unmarked — replaces the command
 * row. Mirrors the wrapper's own routing via the same helpers it uses.
 */
function bashHeader(message: ToolUseMessage): HeaderProjection {
  const command = narrowBashInput(message.input).command;
  const terminal = composeTerminalData(
    narrowBashStructured(message.structuredResult),
    extractTextOutput(message.result),
    message.status === "error",
  );
  if (
    message.status === "done" &&
    command !== undefined &&
    /\bgit\b[\s\S]*\bcommit\b/.test(command) &&
    parseGitCommit(command, terminal.stdout ?? "") !== null
  ) {
    return { name: "Git Commit" };
  }
  return {
    name: message.toolName,
    target: command !== undefined && command !== "" ? command : undefined,
  };
}

/** The Agent header's args span — the agent type and description, adjacent. */
function agentHeader(message: ToolUseMessage): HeaderProjection {
  const input = narrowAgentInput(message.input);
  const structured = narrowAgentStructured(message.structuredResult);
  const agentType = structured.agentType ?? input.subagentType;
  const description = input.description;
  const target = `${agentType ?? ""}${description ?? ""}`;
  return {
    name: message.toolName,
    target: target === "" ? undefined : target,
  };
}

/** A file tool's header identity — `TugAtomRef` displays the basename. */
function fileRefHeader(
  message: ToolUseMessage,
  path: string | undefined,
): HeaderProjection {
  return {
    name: message.toolName,
    target:
      path !== undefined && path.length > 0 ? basename(path) : undefined,
  };
}

/**
 * The header text of one top-level tool call, in DOM order. Empty for a
 * hidden tool (no ink at all) and for `TaskInlineToolBlock`, which renders a
 * quiet marker line rather than a block header.
 */
export function toolHeaderParts(message: ToolUseMessage): string[] {
  const factory = renderedToolBlock(message);
  const projection = projectHeader(factory, message);
  const parts: string[] = [];
  if (projection.name !== undefined && projection.name !== "") {
    parts.push(projection.name);
  }
  if (projection.target !== undefined && projection.target !== "") {
    parts.push(projection.target);
  }
  return parts;
}

function projectHeader(
  factory: ReturnType<typeof renderedToolBlock>,
  message: ToolUseMessage,
): HeaderProjection {
  const name = message.toolName;
  switch (factory) {
    case BashToolBlock:
      return bashHeader(message);
    case ReadToolBlock:
      return fileRefHeader(message, narrowReadInput(message.input).file_path);
    case WriteToolBlock: {
      const structured = narrowWriteStructured(message.structuredResult);
      const input = narrowWriteInput(message.input);
      return fileRefHeader(message, structured.filePath ?? input.file_path);
    }
    case EditToolBlock: {
      const structured = narrowEditStructured(message.structuredResult);
      const input = narrowEditInput(message.input);
      return fileRefHeader(message, structured.filePath ?? input.file_path);
    }
    case NotebookEditToolBlock: {
      const structured = narrowNotebookEditStructured(message.structuredResult);
      const input = narrowNotebookEditInput(message.input);
      return fileRefHeader(message, structured.notebookPath ?? input.notebook_path);
    }
    case GlobToolBlock:
      return { name, target: narrowGlobInput(message.input).pattern };
    case GrepToolBlock:
      return { name, target: narrowGrepInput(message.input).pattern };
    case TaskToolBlock:
      return agentHeader(message);
    case SkillToolBlock:
      return {
        name,
        target: composeSkillHeaderArgs(narrowSkillInput(message.input).skill)
          ?.label,
      };
    case MonitorToolBlock:
      return {
        name,
        target: composeMonitorHeader(narrowMonitorInput(message.input))?.label,
      };
    case WebFetchToolBlock:
      return { name, target: narrowWebFetchInput(message.input).url };
    case WebSearchToolBlock:
      return { name, target: narrowWebSearchInput(message.input).query };
    case CronToolBlock: {
      const verb = deriveCronVerb(name);
      return {
        name: composeCronToolName(verb),
        target: composeCronArgsLabel(verb, narrowCronInput(message.input))?.label,
      };
    }
    case WorktreeToolBlock: {
      const input = narrowWorktreeInput(message.input);
      return {
        name: composeWorktreeToolName(deriveWorktreeVerb(name)),
        target: composeWorktreeHeader(input)?.label,
      };
    }
    case TaskMgmtToolBlock: {
      const verb = deriveTaskMgmtVerb(name);
      return {
        name: composeTaskMgmtToolName(verb),
        target: composeTaskMgmtArgsLabel(verb, narrowTaskMgmtInput(message.input))
          ?.label,
      };
    }
    case RemoteTriggerToolBlock: {
      const input = narrowRemoteTriggerInput(message.input);
      return {
        name: composeRemoteTriggerToolName(input.action),
        target: composeRemoteTriggerArgsLabel(input)?.label,
      };
    }
    case ShareOnboardingGuideToolBlock: {
      const input = narrowShareOnboardingGuideInput(message.input);
      return {
        name: composeShareOnboardingGuideToolName(input.mode),
        target:
          input.short_code !== undefined ? `#${input.short_code}` : undefined,
      };
    }
    case TaskInlineToolBlock:
      // A quiet marker line (`TugQuietLine`), not a block header — nothing
      // is marked, so nothing is projected.
      return {};
    case NullToolBlock:
      // Hidden policy ([D101]) — the call paints no ink at all.
      return {};
    default:
      // `DefaultToolBlock` and every other route render the name alone.
      return { name };
  }
}
