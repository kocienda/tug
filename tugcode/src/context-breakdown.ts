// Produces the static-category half of a `/context`-style token
// breakdown — system prompt, tool schemas, custom agents, memory
// files, skills. Tokenizes each category from disk and emits a
// {@link ContextBreakdown} wire frame for the popover.
//
// Everything is read from the FILESYSTEM — `~/.claude/agents/`,
// `~/.claude/skills/`, the memory files, and the project's plugin
// directory (which tugcode itself resolves). So the breakdown is
// computable the moment the session opens, BEFORE claude has emitted
// `system:init` (claude is silent until it receives the first input).
// The lone thing the filesystem cannot reveal is the built-in tool
// COUNT — the tool schemas live inside the claude binary — so
// `system_tools` falls back to a flat heuristic until `system:init`
// reports the real count.
//
// What this module does NOT compute: the `messages` slice or the
// breakdown total. Sub-step J's `sessionInitTokens` is a feed-exact
// bootstrap and `window(latest)` a feed-exact total — both known on
// the tugdeck side. tugdeck assembles the final breakdown: it scales
// these five static categories so they sum to the feed-exact
// `sessionInit`, then appends `messages = window - sessionInit`. So
// this estimate only needs sane *relative* proportions among the five
// categories — its absolute total seeds only the pre-turn-1
// fresh-session display.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ClaudeHome } from "./claude-home.ts";

import { countTokens } from "./tokenizer.ts";

import type { ClaudeCodeSettings } from "./claude-code-settings.ts";
import type { ContextBreakdown, ContextBreakdownCategory } from "./types.ts";
import { IPC_VERSION } from "./types.ts";

/**
 * Heuristic estimate of the CLI's internal system prompt in tokens.
 * The actual bytes are CLI-internal and not addressable from the SDK
 * (see spike S1).
 */
export const SYSTEM_PROMPT_DEFAULT_TOKENS = 3_500;

/**
 * Per-tool schema-token estimate. Calibrated against Claude Code's own
 * `/context` (`system_tools` ÷ tool count ≈ 235). Used once
 * `system:init` reports the real tool count.
 */
export const TOOL_SCHEMA_DEFAULT_TOKENS = 235;

/**
 * Flat `system_tools` estimate for the window before `system:init`
 * has reported the tool count — the tool schemas live inside the
 * claude binary, so the count is not filesystem-derivable. Sized to
 * the observed `system_tools` total (~31 built-in tools × ~235).
 * Superseded by `toolCount × TOOL_SCHEMA_DEFAULT_TOKENS` once the
 * first turn delivers `system:init`.
 */
export const SYSTEM_TOOLS_DEFAULT_TOKENS = 7_300;

/**
 * Default reserved-buffer size when the user has autocompact enabled.
 * Per spike S5: current Claude Code reserves ~33k tokens when the
 * `autoCompactEnabled` setting is true.
 */
export const AUTOCOMPACT_BUFFER_DEFAULT_TOKENS = 33_000;

/**
 * Fallback context window cap when `modelUsage` does not carry one
 * (e.g., the first emit before any `cost_update` has landed).
 */
export const DEFAULT_CONTEXT_MAX = 200_000;

interface CacheEntry {
  mtimeMs: number;
  tokens: number;
}

/**
 * Read a file's text and return its token count, using a per-path
 * (mtime-keyed) cache. Returns 0 if the file does not exist or is
 * unreadable. Safe to call across HMR boundaries — the mtime in the
 * cache key invalidates on file edit.
 */
export function tokenizeFileCached(
  absPath: string,
  cache: Map<string, CacheEntry>,
): number {
  let stat;
  try {
    stat = statSync(absPath);
  } catch {
    return 0;
  }
  const cached = cache.get(absPath);
  if (cached && cached.mtimeMs === stat.mtimeMs) {
    return cached.tokens;
  }
  let text: string;
  try {
    text = readFileSync(absPath, "utf-8");
  } catch {
    return 0;
  }
  const tokens = countTokens(text);
  cache.set(absPath, { mtimeMs: stat.mtimeMs, tokens });
  return tokens;
}

/**
 * Extract the YAML frontmatter block from a markdown file's text — the
 * lines between an opening `---` fence (which must be the file's first
 * line) and the next `---` fence. Returns the block's inner text
 * (fences excluded), or `null` when the file carries no frontmatter.
 */
export function extractFrontmatter(text: string): string | null {
  if (!text.startsWith("---\n") && !text.startsWith("---\r\n")) {
    return null;
  }
  const afterOpen = text.slice(text.indexOf("\n") + 1);
  const close = afterOpen.search(/^---[ \t]*\r?$/m);
  if (close < 0) {
    return null;
  }
  return afterOpen.slice(0, close);
}

/**
 * Read a file, extract its YAML frontmatter block, and return that
 * block's token count, mtime-cached.
 *
 * Agent `.md` and `SKILL.md` files carry a frontmatter block (name +
 * description + tool/model config) followed by an instruction body.
 * Claude Code loads only the frontmatter into the system prompt; the
 * body loads on demand and is NOT resident context. Tokenizing the
 * whole file over-counts `custom_agents` / `skills` by 17-52×.
 *
 * Returns 0 when the file is missing, unreadable, or carries no
 * frontmatter fence. The cache key is suffixed so a path tokenized
 * both whole-file and frontmatter-only never collides.
 */
export function tokenizeFrontmatterCached(
  absPath: string,
  cache: Map<string, CacheEntry>,
): number {
  const cacheKey = `${absPath} frontmatter`;
  let stat;
  try {
    stat = statSync(absPath);
  } catch {
    return 0;
  }
  const cached = cache.get(cacheKey);
  if (cached && cached.mtimeMs === stat.mtimeMs) {
    return cached.tokens;
  }
  let text: string;
  try {
    text = readFileSync(absPath, "utf-8");
  } catch {
    return 0;
  }
  const frontmatter = extractFrontmatter(text);
  const tokens = frontmatter === null ? 0 : countTokens(frontmatter);
  cache.set(cacheKey, { mtimeMs: stat.mtimeMs, tokens });
  return tokens;
}

/**
 * Sum the frontmatter token counts of every `*.md` file directly
 * inside `dirPath`. Best-effort: a missing or unreadable directory
 * returns 0 silently. Used for both `~/.claude/agents/` and a
 * plugin's `agents/` directory.
 */
export function tokenizeAgentDirCached(
  dirPath: string,
  cache: Map<string, CacheEntry>,
): number {
  let entries: string[];
  try {
    entries = readdirSync(dirPath);
  } catch {
    return 0;
  }
  let total = 0;
  for (const name of entries) {
    if (!name.endsWith(".md")) continue;
    total += tokenizeFrontmatterCached(join(dirPath, name), cache);
  }
  return total;
}

/**
 * Sum the frontmatter token counts of every `<name>/SKILL.md` under
 * `skillsRoot`. Best-effort: a missing directory returns 0. Used for
 * both `~/.claude/skills/` and a plugin's `skills/` directory.
 */
export function tokenizeSkillsDirCached(
  skillsRoot: string,
  cache: Map<string, CacheEntry>,
): number {
  let entries: string[];
  try {
    entries = readdirSync(skillsRoot);
  } catch {
    return 0;
  }
  let total = 0;
  for (const skillDirName of entries) {
    total += tokenizeFrontmatterCached(
      join(skillsRoot, skillDirName, "SKILL.md"),
      cache,
    );
  }
  return total;
}

/**
 * Per-category token estimates for the session-stable categories.
 * `messages` is excluded — it is feed-exact (`window - sessionInit`)
 * and assembled on the tugdeck side, not tokenized here.
 */
export interface StaticCategoryEstimates {
  system_prompt: number;
  system_tools: number;
  custom_agents: number;
  memory_files: number;
  skills: number;
}

/**
 * Sum of the per-category estimates.
 */
export function staticTotal(s: StaticCategoryEstimates): number {
  return (
    s.system_prompt +
    s.system_tools +
    s.custom_agents +
    s.memory_files +
    s.skills
  );
}

/**
 * Inputs for {@link computeStaticCategories}.
 *
 * `toolCount` is the built-in tool count from `system:init`, or `null`
 * before `system:init` has arrived — `system_tools` then uses the
 * flat {@link SYSTEM_TOOLS_DEFAULT_TOKENS} heuristic. `pluginDir` is
 * the project's plugin directory (tugcode resolves it itself); its
 * `agents/` and `skills/` subdirs fold into the corresponding
 * categories. `cache` is the per-(path, mtime) tokenization cache.
 */
export interface ComputeStaticCategoriesOptions {
  claudeHome: ClaudeHome;
  cwd: string;
  pluginDir: string;
  toolCount: number | null;
  cache: Map<string, CacheEntry>;
}

/**
 * Tokenize the session's static categories — entirely from the
 * filesystem, with no dependency on claude's `system:init`.
 *
 * - `system_prompt`: a heuristic constant for the CLI-internal bytes.
 * - `system_tools`: `toolCount × TOOL_SCHEMA_DEFAULT_TOKENS` once the
 *   count is known; the flat {@link SYSTEM_TOOLS_DEFAULT_TOKENS}
 *   heuristic before then (`toolCount === null`).
 * - `custom_agents` / `skills`: the *frontmatter* of each agent `.md`
 *   and `SKILL.md` under `~/.claude/{agents,skills}/` and the
 *   project plugin's `{agents,skills}/` — name + description, the part
 *   Claude Code loads into the system prompt. Bodies are on-demand
 *   and excluded.
 * - `memory_files`: the user `~/.claude/CLAUDE.md`, the project
 *   `cwd/CLAUDE.md`, and the auto-memory index `MEMORY.md` — the three
 *   files resident in full. Per-entry memory `*.md` files are
 *   on-demand recall and excluded.
 */
export function computeStaticCategories(
  options: ComputeStaticCategoriesOptions,
): StaticCategoryEstimates {
  const { claudeHome, cwd, pluginDir, toolCount, cache } = options;

  const system_prompt = SYSTEM_PROMPT_DEFAULT_TOKENS;

  const system_tools =
    toolCount === null
      ? SYSTEM_TOOLS_DEFAULT_TOKENS
      : toolCount * TOOL_SCHEMA_DEFAULT_TOKENS;

  const custom_agents =
    tokenizeAgentDirCached(claudeHome.agentsDir(), cache) +
    tokenizeAgentDirCached(join(pluginDir, "agents"), cache);

  let memory_files = 0;
  memory_files += tokenizeFileCached(claudeHome.memoryPath(), cache);
  memory_files += tokenizeFileCached(join(cwd, "CLAUDE.md"), cache);
  // The auto-memory index. Only the index is resident — the per-entry
  // `*.md` files beside it load on demand, so the directory is NOT
  // walked.
  memory_files += tokenizeFileCached(
    join(claudeHome.autoMemoryDir(cwd), "MEMORY.md"),
    cache,
  );

  const skills =
    tokenizeSkillsDirCached(claudeHome.skillsDir(), cache) +
    tokenizeSkillsDirCached(join(pluginDir, "skills"), cache);

  return { system_prompt, system_tools, custom_agents, memory_files, skills };
}

const CATEGORY_LABELS: Record<keyof StaticCategoryEstimates | "autocompact_buffer", string> = {
  system_prompt: "System prompt",
  system_tools: "System tools",
  custom_agents: "Custom agents",
  memory_files: "Memory files",
  skills: "Skills",
  autocompact_buffer: "Autocompact buffer",
};

export interface BuildFrameInput {
  sessionId: string;
  contextMax: number;
  staticEstimates: StaticCategoryEstimates;
  autocompactEnabled: boolean;
  autocompactBufferTokens?: number;
}

/**
 * Assemble the {@link ContextBreakdown} wire frame — the five static
 * categories plus, when the setting is enabled, the reserved
 * `autocompact_buffer` slice. There is no `messages` category and no
 * total: the frame is the *static estimate* only; tugdeck derives
 * `messages` and the total from the feed (`window` / `sessionInit`).
 */
export function buildContextBreakdownFrame(
  input: BuildFrameInput,
): ContextBreakdown {
  const { sessionId, contextMax, staticEstimates, autocompactEnabled } = input;
  const bufferTokens =
    input.autocompactBufferTokens ?? AUTOCOMPACT_BUFFER_DEFAULT_TOKENS;

  const categories: ContextBreakdownCategory[] = [
    {
      id: "system_prompt",
      label: CATEGORY_LABELS.system_prompt,
      tokens: staticEstimates.system_prompt,
    },
    {
      id: "system_tools",
      label: CATEGORY_LABELS.system_tools,
      tokens: staticEstimates.system_tools,
    },
    {
      id: "custom_agents",
      label: CATEGORY_LABELS.custom_agents,
      tokens: staticEstimates.custom_agents,
    },
    {
      id: "memory_files",
      label: CATEGORY_LABELS.memory_files,
      tokens: staticEstimates.memory_files,
    },
    {
      id: "skills",
      label: CATEGORY_LABELS.skills,
      tokens: staticEstimates.skills,
    },
  ];

  if (autocompactEnabled && bufferTokens > 0) {
    categories.push({
      id: "autocompact_buffer",
      label: CATEGORY_LABELS.autocompact_buffer,
      tokens: bufferTokens,
    });
  }

  return {
    type: "context_breakdown",
    tug_session_id: sessionId,
    context_max: contextMax,
    categories,
    ipc_version: IPC_VERSION,
  };
}

/**
 * Extract the context-window cap from `modelUsage`. The SDK's
 * `modelUsage` is `{ [modelName]: { contextWindow, ... } }`; we read
 * the first model's cap. Falls back to {@link DEFAULT_CONTEXT_MAX}
 * when modelUsage is absent or carries no contextWindow.
 */
export function extractContextMax(
  modelUsage: Record<string, unknown> | undefined,
): number {
  if (!modelUsage) return DEFAULT_CONTEXT_MAX;
  for (const v of Object.values(modelUsage)) {
    if (typeof v === "object" && v !== null) {
      const cw = (v as Record<string, unknown>).contextWindow;
      if (typeof cw === "number" && Number.isFinite(cw) && cw > 0) return cw;
    }
  }
  return DEFAULT_CONTEXT_MAX;
}

/**
 * Per-session stateful emitter for `context_breakdown` frames.
 * Constructed once per SessionManager; methods are invoked as events
 * flow through the dispatcher.
 *
 * Emit cadence:
 * - {@link onSpawn}: tokenizes the static categories from disk and
 *   returns the initial frame — fires at session spawn, BEFORE claude
 *   has emitted `system:init`, so the Context surface is populated the
 *   moment the session opens. `system_tools` uses the flat heuristic.
 * - {@link onSessionInit}: re-emits with the real tool count once
 *   `system:init` arrives (the first turn).
 * - {@link onCostUpdate}: re-emits with a refreshed `context_max`;
 *   static categories re-tokenize through the mtime cache.
 * - {@link onCompactBoundary}: a no-op.
 *
 * The caller writes the returned frame to the wire. All methods are
 * synchronous; file IO is best-effort `readFileSync` against small
 * manifest-shaped paths — sub-millisecond on first call, cache-hit
 * thereafter.
 */
export class ContextBreakdownEmitter {
  private readonly sessionId: string;
  private readonly claudeHome: ClaudeHome;
  private readonly cwd: string;
  private readonly pluginDir: string;
  private readonly settings: ClaudeCodeSettings;

  private staticEstimates: StaticCategoryEstimates | null = null;
  private contextMax: number = DEFAULT_CONTEXT_MAX;
  /** Built-in tool count from `system:init`; `null` until it lands. */
  private toolCount: number | null = null;
  private readonly tokenizationCache: Map<string, CacheEntry> = new Map();

  constructor(opts: {
    sessionId: string;
    claudeHome: ClaudeHome;
    cwd: string;
    pluginDir: string;
    settings: ClaudeCodeSettings;
  }) {
    this.sessionId = opts.sessionId;
    this.claudeHome = opts.claudeHome;
    this.cwd = opts.cwd;
    this.pluginDir = opts.pluginDir;
    this.settings = opts.settings;
  }

  /**
   * Tokenize the static categories from disk and return the frame.
   * Fires at session spawn — before `system:init` — so the Context
   * surface is never blank on a fresh session.
   */
  onSpawn(): ContextBreakdown {
    this.recompute();
    return this.buildCurrentFrame();
  }

  /**
   * Re-emit once `system:init` reports the real built-in tool count,
   * replacing the {@link SYSTEM_TOOLS_DEFAULT_TOKENS} heuristic.
   */
  onSessionInit(toolCount: number): ContextBreakdown {
    this.toolCount = toolCount;
    this.recompute();
    return this.buildCurrentFrame();
  }

  /**
   * Refresh `context_max` from `modelUsage` and re-emit. Returns
   * `null` only if {@link onSpawn} never ran (defensive).
   */
  onCostUpdate(
    modelUsage?: Record<string, unknown>,
  ): ContextBreakdown | null {
    if (this.staticEstimates === null) return null;
    this.contextMax = extractContextMax(modelUsage);
    this.recompute();
    return this.buildCurrentFrame();
  }

  /**
   * A no-op. Compaction changes the message history, not the static
   * categories this module tokenizes; tugdeck's feed-derived
   * `messages` slice reflects the post-compaction window on its own.
   */
  onCompactBoundary(): void {
    // Intentionally empty; see method docstring.
  }

  private recompute(): void {
    this.staticEstimates = computeStaticCategories({
      claudeHome: this.claudeHome,
      cwd: this.cwd,
      pluginDir: this.pluginDir,
      toolCount: this.toolCount,
      cache: this.tokenizationCache,
    });
  }

  private buildCurrentFrame(): ContextBreakdown {
    return buildContextBreakdownFrame({
      sessionId: this.sessionId,
      contextMax: this.contextMax,
      staticEstimates:
        this.staticEstimates ?? {
          system_prompt: 0,
          system_tools: 0,
          custom_agents: 0,
          memory_files: 0,
          skills: 0,
        },
      autocompactEnabled: this.settings.autoCompactEnabled,
      autocompactBufferTokens: AUTOCOMPACT_BUFFER_DEFAULT_TOKENS,
    });
  }
}
