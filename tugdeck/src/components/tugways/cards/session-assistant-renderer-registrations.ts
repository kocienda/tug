/**
 * session-assistant-renderer-registrations.ts — the registration *wiring*
 * for the tool-block dispatch, split from the dispatch *mechanism*
 * (`session-assistant-renderer-dispatch.ts`).
 *
 * This module imports every bespoke block component and registers it
 * against its canonical tool name at module load. The dispatch module
 * imports NO block components — it holds only the registry, lookup,
 * routing, and drift-detection mechanism. That one-directional split
 * breaks the module cycle
 * `task-tool-block → agent-transcript-block → dispatch → TaskToolBlock`
 * that otherwise turns into a TDZ `ReferenceError` when a block module
 * loads before the dispatch finishes evaluating.
 *
 * The render root (`session-card-transcript.tsx`) side-effect-imports this
 * module so the registration loop runs before the first
 * `resolveToolBlock` call. Tests that need the frozen bespoke
 * inventory (`BESPOKE_TOOL_NAMES`, `BESPOKE_FACTORY_BY_NAME`,
 * `hasBespokeWrapper`) import it from here.
 *
 * @module components/tugways/cards/session-assistant-renderer-registrations
 */

import { BashToolBlock } from "./blocks/bash-tool-block";
import { ReadToolBlock } from "./blocks/read-tool-block";
import { EditToolBlock } from "./blocks/edit-tool-block";
import { GlobToolBlock } from "./blocks/glob-tool-block";
import { GrepToolBlock } from "./blocks/grep-tool-block";
import { TaskToolBlock } from "./blocks/task-tool-block";
import { AskUserQuestionToolBlock } from "./blocks/ask-user-question-tool-block";
import { SkillToolBlock } from "./blocks/skill-tool-block";
import { MonitorToolBlock } from "./blocks/monitor-tool-block";
import { WorktreeToolBlock } from "./blocks/worktree-tool-block";
import { TaskMgmtToolBlock } from "./blocks/task-mgmt-tool-block";
import { CronToolBlock } from "./blocks/cron-tool-block";
import { ShareOnboardingGuideToolBlock } from "./blocks/share-onboarding-guide-tool-block";
import { RemoteTriggerToolBlock } from "./blocks/remote-trigger-tool-block";
import { TaskInlineToolBlock } from "./blocks/task-inline-tool-block";
import { WebFetchToolBlock } from "./blocks/web-fetch-tool-block";
import { WebSearchToolBlock } from "./blocks/web-search-tool-block";
import { WriteToolBlock } from "./blocks/write-tool-block";
import { NotebookEditToolBlock } from "./blocks/notebook-edit-tool-block";
import { SendMessageToolBlock } from "./blocks/send-message-tool-block";
import { ListAgentsToolBlock } from "./blocks/list-agents-tool-block";
import { ReportFindingsToolBlock } from "./blocks/report-findings-tool-block";
import { WorkflowToolBlock } from "./blocks/workflow-tool-block";
import { DesignSyncToolBlock } from "./blocks/design-sync-tool-block";
import {
  TOOL_ALIASES,
  registerToolBlock,
} from "./session-assistant-renderer-dispatch";
import type { ToolBlockFactory } from "../blocks/types";

/**
 * Single source of truth for the bespoke wrappers — the (name,
 * factory) pairs registered at module load. Driving the bottom-of-file
 * registration loop AND `BESPOKE_TOOL_NAMES` from the same array means
 * adding a new wrapper is one line (here) instead of two (here + an
 * inventory const).
 *
 * Notes on entries:
 *  - `agent` is the canonical name; the historical `task` name
 *    resolves here via the `task → agent` alias in `TOOL_ALIASES`
 *    ([D16]).
 *  - `askuserquestion`'s wrapper owns BOTH surfaces in place: while a
 *    question is pending it renders the live `QuestionWizard` inside its
 *    `BlockChrome`, then morphs the same chrome to the durable Q&A
 *    artifact once the user answers ([D13]). No separate foot-slot dialog.
 *  - `taskcreate` / `taskupdate` register the SAME `TaskInlineToolBlock`
 *    factory under both wire names ([#step-24-3-5]). No alias: the
 *    wrapper branches on the original `toolName` internally to pick
 *    `"Created: …"` vs the `Started / Completed / Reset` `TaskUpdate`
 *    verb. Two registrations is cleaner than aliasing because both
 *    names ARE the canonical names — neither is a synonym for the
 *    other; they're two distinct wire tools that happen to render
 *    via the same inline-marker wrapper.
 */
const BESPOKE_REGISTRATIONS: ReadonlyArray<
  readonly [string, ToolBlockFactory]
> = [
  ["bash", BashToolBlock],
  ["read", ReadToolBlock],
  ["edit", EditToolBlock],
  ["glob", GlobToolBlock],
  ["grep", GrepToolBlock],
  ["agent", TaskToolBlock],
  ["askuserquestion", AskUserQuestionToolBlock],
  ["skill", SkillToolBlock],
  ["monitor", MonitorToolBlock],
  // Canonical `worktree`; `enterworktree` and `exitworktree` resolve
  // here via `TOOL_ALIASES`. The wrapper branches on the original
  // `toolName` to pick the `enter` / `exit` verb. ([#step-24-3-2])
  ["worktree", WorktreeToolBlock],
  // Canonical `taskmgmt`; `tasklist` / `taskget` / `taskoutput` /
  // `taskstop` resolve here via `TOOL_ALIASES`. The wrapper branches
  // on the original `toolName` to pick the `list` / `get` / `output`
  // / `stop` verb and the per-verb body shape. The canonical name is
  // wrapper-internal — there is no Anthropic wire tool named
  // `TaskMgmt`. ([#step-24-3-3])
  ["taskmgmt", TaskMgmtToolBlock],
  // Canonical `cron`; `croncreate` / `crondelete` / `cronlist`
  // resolve here via `TOOL_ALIASES`. The wrapper branches on the
  // original `toolName` to pick the `create` / `delete` / `list`
  // verb. The canonical name is wrapper-internal. ([#step-24-3-4])
  ["cron", CronToolBlock],
  // Singletons from the management trio ([#step-24-3-4]) — one
  // wire tool, one wrapper, no aliases. Registered by their
  // lowercased wire names.
  ["shareonboardingguide", ShareOnboardingGuideToolBlock],
  ["remotetrigger", RemoteTriggerToolBlock],
  // [D100] two-surface task list ([#step-24-3-5]) — TaskInlineToolBlock
  // is the second surface (the TASKS status-bar cell is the first).
  // Both `taskcreate` and `taskupdate` point at the same wrapper;
  // the wrapper branches on the original `toolName` to pick the
  // event reading. These names were previously hidden via
  // TOOL_VISIBILITY_POLICY — removed from the policy in the same
  // change that lands the wrapper.
  ["taskcreate", TaskInlineToolBlock],
  ["taskupdate", TaskInlineToolBlock],
  // Web tools — `WebFetch` and `WebSearch` were previously
  // `default-intent` per the visibility policy; the policy entries
  // are removed in the same change that lands these wrappers
  // ([#step-25]).
  ["webfetch", WebFetchToolBlock],
  ["websearch", WebSearchToolBlock],
  // File-mutation tools — `Write` and `NotebookEdit` were previously
  // `default-intent`; promoted to bespoke at [#step-26].
  ["write", WriteToolBlock],
  ["notebookedit", NotebookEditToolBlock],
  // Agent messaging — `SendMessage` continues a spawned agent or
  // writes to another session, and `ListAgents` names the targets.
  // Both arrived in Claude Code 2.1.241 and wore the `unknown tool`
  // caution until the 2.1.311 classification landed these wrappers.
  ["sendmessage", SendMessageToolBlock],
  ["listagents", ListAgentsToolBlock],
  // `ReportFindings` is a review's typed output — the findings are
  // the input, so the wrapper renders them and mounts expanded.
  ["reportfindings", ReportFindingsToolBlock],
  // `Workflow` launches a multi-agent script; `DesignSync` drives a
  // claude.ai design-system project under `/design-sync`.
  ["workflow", WorkflowToolBlock],
  ["designsync", DesignSyncToolBlock],
];

/**
 * Lowercased canonical names of every bespoke wrapper registered at
 * module load. Frozen at module load and unaffected by test-time
 * mutations of the registry (`_resetToolBlockRegistryForTests` clears
 * `TOOL_BLOCK_REGISTRY` but does not touch this constant).
 *
 * Consumed by the policy-file governance test ([D101]) — the test
 * verifies that the union of bespoke + policy covers the v2.1.311
 * canonical tool set. Exporting a frozen constant lets the test stay
 * deterministic across test files; a runtime `registeredTools()`
 * snapshot is fragile because the dispatch test's `beforeEach` clears
 * the registry, and bun runs each test file's tests before loading
 * the next.
 */
export const BESPOKE_TOOL_NAMES: ReadonlySet<string> = new Set(
  BESPOKE_REGISTRATIONS.map(([name]) => name),
);

/**
 * Frozen name → factory map derived from `BESPOKE_REGISTRATIONS` at
 * module load. Same rationale as `BESPOKE_TOOL_NAMES`: the runtime
 * `TOOL_BLOCK_REGISTRY` is mutable (the dispatch test resets it per
 * `beforeEach`), so per-wrapper tests can't safely assert "Skill
 * resolves to SkillToolBlock" via `resolveToolBlock(...)` — by the
 * time they run, the registry may be empty. `BESPOKE_FACTORY_BY_NAME`
 * is the immutable source of truth that mirrors the bottom-of-file
 * registrations and stays correct across test files.
 *
 * Keys are lowercased canonical names (aliases are NOT included —
 * use `resolveToolBlock` for alias resolution in tests that need
 * it). Tests that want to verify "`X` is registered to factory `Y`"
 * import this map and assert directly.
 */
export const BESPOKE_FACTORY_BY_NAME: ReadonlyMap<string, ToolBlockFactory> =
  new Map(BESPOKE_REGISTRATIONS);

/**
 * Pure: is `toolName` covered by a bespoke wrapper? Case-insensitive
 * + alias-resolving. Returns `true` if the resolved canonical name
 * has a registered factory, `false` otherwise.
 *
 * Consults the immutable `BESPOKE_FACTORY_BY_NAME` snapshot (frozen
 * at module load) — NOT the mutable `TOOL_BLOCK_REGISTRY` that the
 * dispatch test's `beforeEach` clears. Consumers get a deterministic
 * answer that survives test-suite isolation regardless of which test
 * file runs first under `bun test`.
 *
 * The `Default` shim and the `hidden` policy bucket return `false` —
 * "bespoke" here means "has a dedicated wrapper registered against
 * its name," not "resolves to a non-null component" (a hidden tool
 * resolves to `NullToolBlock` but isn't bespoke in the policy
 * sense). [D101]
 */
export function hasBespokeWrapper(toolName: string): boolean {
  const lower = toolName.toLowerCase();
  const canonical = TOOL_ALIASES.get(lower) ?? lower;
  return BESPOKE_FACTORY_BY_NAME.has(canonical);
}

for (const [name, factory] of BESPOKE_REGISTRATIONS) {
  registerToolBlock(name, factory);
}
