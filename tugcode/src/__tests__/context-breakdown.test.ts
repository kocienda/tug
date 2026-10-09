import { ClaudeHome } from "../claude-home.ts";
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ClaudeCodeSettings } from "../claude-code-settings.ts";
import { initTokenizer } from "../tokenizer.ts";

// The token-count helpers below drive the real tiktoken encoder, which must
// be instantiated before the first synchronous `countTokens` call.
beforeAll(async () => {
  await initTokenizer();
});
import {
  AUTOCOMPACT_BUFFER_DEFAULT_TOKENS,
  buildContextBreakdownFrame,
  computeStaticCategories,
  ContextBreakdownEmitter,
  DEFAULT_CONTEXT_MAX,
  extractContextMax,
  extractFrontmatter,
  staticTotal,
  SYSTEM_PROMPT_DEFAULT_TOKENS,
  SYSTEM_TOOLS_DEFAULT_TOKENS,
  tokenizeAgentDirCached,
  tokenizeFileCached,
  tokenizeFrontmatterCached,
  tokenizeSkillsDirCached,
  TOOL_SCHEMA_DEFAULT_TOKENS,
} from "../context-breakdown.ts";

let scratchDirs: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "tugcode-ctx-"));
  scratchDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of scratchDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  scratchDirs = [];
});

/**
 * A manifest-shaped markdown file: a small YAML frontmatter block
 * (name + description) followed by a large instruction body. Claude
 * Code loads only the frontmatter; the body is on-demand.
 */
function manifest(name: string, description: string, bodyReps: number): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n${"instruction body ".repeat(bodyReps)}`;
}

// ---- tokenizeFileCached --------------------------------------------------

describe("tokenizeFileCached", () => {
  test("returns 0 for a missing file", () => {
    const cache = new Map();
    expect(tokenizeFileCached("/no/such/path/here.md", cache)).toBe(0);
    expect(cache.size).toBe(0);
  });

  test("tokenizes a present file and caches the result", () => {
    const dir = scratch();
    const path = join(dir, "doc.md");
    writeFileSync(path, "hello world this is a test\n".repeat(40));
    const cache = new Map();
    const t1 = tokenizeFileCached(path, cache);
    expect(t1).toBeGreaterThan(0);
    expect(cache.size).toBe(1);
    expect(tokenizeFileCached(path, cache)).toBe(t1);
  });

  test("invalidates the cache when the file's mtime changes", () => {
    const dir = scratch();
    const path = join(dir, "doc.md");
    writeFileSync(path, "first version of the content\n");
    const cache = new Map();
    const t1 = tokenizeFileCached(path, cache);
    writeFileSync(path, "second version of content ".repeat(100));
    const future = new Date(Date.now() + 60_000);
    utimesSync(path, future, future);
    expect(tokenizeFileCached(path, cache)).toBeGreaterThan(t1);
  });
});

// ---- extractFrontmatter --------------------------------------------------

describe("extractFrontmatter", () => {
  test("returns the inner block between the two --- fences", () => {
    expect(
      extractFrontmatter("---\nname: foo\ndescription: bar\n---\nbody text"),
    ).toBe("name: foo\ndescription: bar\n");
  });

  test("returns null when the file has no opening fence", () => {
    expect(extractFrontmatter("no frontmatter here\njust body")).toBeNull();
  });

  test("returns null when the opening fence is never closed", () => {
    expect(extractFrontmatter("---\nname: foo\ndescription: bar\n")).toBeNull();
  });

  test("tolerates a CRLF opening fence", () => {
    expect(extractFrontmatter("---\r\nname: foo\r\n---\r\nbody")).toBe(
      "name: foo\r\n",
    );
  });
});

// ---- tokenizeFrontmatterCached -------------------------------------------

describe("tokenizeFrontmatterCached", () => {
  test("counts only the frontmatter, not the on-demand body", () => {
    const dir = scratch();
    const path = join(dir, "agent.md");
    writeFileSync(path, manifest("coder", "Writes code.", 2_000));
    const cache = new Map();
    const frontmatterTokens = tokenizeFrontmatterCached(path, cache);
    const wholeFileTokens = tokenizeFileCached(path, cache);
    expect(frontmatterTokens).toBeGreaterThan(0);
    expect(wholeFileTokens).toBeGreaterThan(frontmatterTokens * 10);
  });

  test("returns 0 for a missing file", () => {
    expect(tokenizeFrontmatterCached("/no/such/file.md", new Map())).toBe(0);
  });

  test("returns 0 for a file with no frontmatter", () => {
    const dir = scratch();
    const path = join(dir, "bodyonly.md");
    writeFileSync(path, "just a body, no frontmatter ".repeat(50));
    expect(tokenizeFrontmatterCached(path, new Map())).toBe(0);
  });

  test("caches by (path, mtime) and invalidates on edit", () => {
    const dir = scratch();
    const path = join(dir, "agent.md");
    writeFileSync(path, manifest("a", "short", 5));
    const cache = new Map();
    const t1 = tokenizeFrontmatterCached(path, cache);
    expect(tokenizeFrontmatterCached(path, cache)).toBe(t1);
    writeFileSync(
      path,
      manifest("a", "a much much longer description than before", 5),
    );
    const future = new Date(Date.now() + 60_000);
    utimesSync(path, future, future);
    expect(tokenizeFrontmatterCached(path, cache)).toBeGreaterThan(t1);
  });
});

// ---- tokenizeAgentDirCached / tokenizeSkillsDirCached --------------------

describe("tokenizeAgentDirCached", () => {
  test("sums the frontmatter of every *.md in the directory", () => {
    const dir = scratch();
    writeFileSync(
      join(dir, "coder-agent.md"),
      manifest("coder-agent", "Implements plan steps.", 800),
    );
    writeFileSync(
      join(dir, "reviewer-agent.md"),
      manifest("reviewer-agent", "Reviews code quality.", 800),
    );
    writeFileSync(join(dir, "notes.txt"), "not a markdown file");
    const total = tokenizeAgentDirCached(dir, new Map());
    expect(total).toBeGreaterThan(0);
    // Frontmatter-only — two ~800-rep bodies stay well under the body mass.
    expect(total).toBeLessThan(400);
  });

  test("returns 0 for a missing directory", () => {
    expect(tokenizeAgentDirCached("/no/such/dir", new Map())).toBe(0);
  });
});

describe("tokenizeSkillsDirCached", () => {
  test("sums the frontmatter of every <name>/SKILL.md", () => {
    const root = scratch();
    mkdirSync(join(root, "plan"), { recursive: true });
    mkdirSync(join(root, "merge"), { recursive: true });
    writeFileSync(
      join(root, "plan", "SKILL.md"),
      manifest("plan", "Author a plan document.", 800),
    );
    writeFileSync(
      join(root, "merge", "SKILL.md"),
      manifest("merge", "Merge a plan's implementation.", 800),
    );
    const total = tokenizeSkillsDirCached(root, new Map());
    expect(total).toBeGreaterThan(0);
    expect(total).toBeLessThan(400);
  });

  test("returns 0 for a missing directory", () => {
    expect(tokenizeSkillsDirCached("/no/such/skills", new Map())).toBe(0);
  });

  test("a skill subdir without SKILL.md contributes 0", () => {
    const root = scratch();
    mkdirSync(join(root, "empty-skill"), { recursive: true });
    expect(tokenizeSkillsDirCached(root, new Map())).toBe(0);
  });
});

// ---- computeStaticCategories --------------------------------------------

describe("computeStaticCategories", () => {
  test("system_tools uses the exact count when toolCount is supplied", () => {
    const dir = scratch();
    const result = computeStaticCategories({
      claudeHome: ClaudeHome.resolve(null, dir),
      cwd: dir,
      pluginDir: dir,
      toolCount: 12,
      cache: new Map(),
    });
    expect(result.system_prompt).toBe(SYSTEM_PROMPT_DEFAULT_TOKENS);
    expect(result.system_tools).toBe(12 * TOOL_SCHEMA_DEFAULT_TOKENS);
  });

  test("system_tools falls back to the flat heuristic when toolCount is null", () => {
    const dir = scratch();
    const result = computeStaticCategories({
      claudeHome: ClaudeHome.resolve(null, dir),
      cwd: dir,
      pluginDir: dir,
      toolCount: null,
      cache: new Map(),
    });
    expect(result.system_tools).toBe(SYSTEM_TOOLS_DEFAULT_TOKENS);
  });

  test("custom_agents reads ~/.claude/agents and the plugin's agents/", () => {
    const home = scratch();
    const plugin = scratch();
    mkdirSync(join(home, ".claude", "agents"), { recursive: true });
    mkdirSync(join(plugin, "agents"), { recursive: true });
    writeFileSync(
      join(home, ".claude", "agents", "reviewer-agent.md"),
      manifest("reviewer-agent", "Checks for clarity and bugs.", 1_000),
    );
    writeFileSync(
      join(plugin, "agents", "coder-agent.md"),
      manifest("coder-agent", "Implements steps.", 1_000),
    );
    const result = computeStaticCategories({
      claudeHome: ClaudeHome.resolve(null, home),
      cwd: scratch(),
      pluginDir: plugin,
      toolCount: 0,
      cache: new Map(),
    });
    expect(result.custom_agents).toBeGreaterThan(0);
    // Frontmatter-only — the 1000-rep bodies are excluded.
    expect(result.custom_agents).toBeLessThan(400);
  });

  test("skills reads ~/.claude/skills and the plugin's skills/", () => {
    const home = scratch();
    const plugin = scratch();
    mkdirSync(join(home, ".claude", "skills", "plan"), { recursive: true });
    mkdirSync(join(plugin, "skills", "merge"), { recursive: true });
    writeFileSync(
      join(home, ".claude", "skills", "plan", "SKILL.md"),
      manifest("plan", "Build implementation plans.", 1_000),
    );
    writeFileSync(
      join(plugin, "skills", "merge", "SKILL.md"),
      manifest("merge", "Merge implementation.", 1_000),
    );
    const result = computeStaticCategories({
      claudeHome: ClaudeHome.resolve(null, home),
      cwd: scratch(),
      pluginDir: plugin,
      toolCount: 0,
      cache: new Map(),
    });
    expect(result.skills).toBeGreaterThan(0);
    expect(result.skills).toBeLessThan(400);
  });

  test("memory_files counts CLAUDE.md + MEMORY.md, not the per-entry files", () => {
    const home = scratch();
    const cwd = scratch();
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(
      join(home, ".claude", "CLAUDE.md"),
      "home-level memory content here ".repeat(30),
    );
    writeFileSync(
      join(cwd, "CLAUDE.md"),
      "project-level memory content here ".repeat(30),
    );
    const encoded = cwd.replace(/[^A-Za-z0-9-]/g, "-");
    const memoryDir = join(home, ".claude", "projects", encoded, "memory");
    mkdirSync(memoryDir, { recursive: true });
    writeFileSync(join(memoryDir, "MEMORY.md"), "MEMORY index entry ".repeat(40));
    // A huge per-entry recall file — must NOT be counted (on-demand).
    writeFileSync(
      join(memoryDir, "feedback_one.md"),
      "on-demand recall content ".repeat(5_000),
    );
    const result = computeStaticCategories({
      claudeHome: ClaudeHome.resolve(null, home),
      cwd,
      pluginDir: scratch(),
      toolCount: 0,
      cache: new Map(),
    });
    expect(result.memory_files).toBeGreaterThan(0);
    // The 5000-rep entry file would dominate if the walk counted it.
    expect(result.memory_files).toBeLessThan(5_000);
  });

  test("absent agent/skill/plugin/memory paths contribute 0", () => {
    const result = computeStaticCategories({
      claudeHome: ClaudeHome.resolve(null, scratch()),
      cwd: scratch(),
      pluginDir: "/no/such/plugin",
      toolCount: 0,
      cache: new Map(),
    });
    expect(result.custom_agents).toBe(0);
    expect(result.skills).toBe(0);
    expect(result.memory_files).toBe(0);
  });
});

// ---- staticTotal ----------------------------------------------------------

describe("staticTotal", () => {
  test("sums the five static fields", () => {
    expect(
      staticTotal({
        system_prompt: 1000,
        system_tools: 500,
        custom_agents: 200,
        memory_files: 50,
        skills: 250,
      }),
    ).toBe(2000);
  });
});

// ---- extractContextMax ----------------------------------------------------

describe("extractContextMax", () => {
  test("reads contextWindow from the first model in modelUsage", () => {
    expect(
      extractContextMax({ "claude-sonnet-4-5": { contextWindow: 1_000_000 } }),
    ).toBe(1_000_000);
  });

  test("falls back to DEFAULT_CONTEXT_MAX when modelUsage is undefined", () => {
    expect(extractContextMax(undefined)).toBe(DEFAULT_CONTEXT_MAX);
  });

  test("falls back to DEFAULT_CONTEXT_MAX when no model has a contextWindow", () => {
    expect(extractContextMax({ foo: { other: 1 } })).toBe(DEFAULT_CONTEXT_MAX);
  });
});

// ---- buildContextBreakdownFrame ------------------------------------------

describe("buildContextBreakdownFrame", () => {
  const baseStatics = {
    system_prompt: 3_000,
    system_tools: 5_000,
    custom_agents: 2_000,
    memory_files: 500,
    skills: 1_000,
  };

  test("emits the five static categories unmodified", () => {
    const frame = buildContextBreakdownFrame({
      sessionId: "s1",
      contextMax: 200_000,
      staticEstimates: baseStatics,
      autocompactEnabled: false,
    });
    const findCat = (id: string) => frame.categories.find((c) => c.id === id)!;
    expect(findCat("system_prompt").tokens).toBe(3_000);
    expect(findCat("system_tools").tokens).toBe(5_000);
    expect(findCat("custom_agents").tokens).toBe(2_000);
    expect(findCat("memory_files").tokens).toBe(500);
    expect(findCat("skills").tokens).toBe(1_000);
  });

  test("never emits a messages category — it is feed-derived tugdeck-side", () => {
    const frame = buildContextBreakdownFrame({
      sessionId: "s1",
      contextMax: 200_000,
      staticEstimates: baseStatics,
      autocompactEnabled: true,
    });
    expect(
      frame.categories.find((c) => (c.id as string) === "messages"),
    ).toBeUndefined();
  });

  test("omits autocompact_buffer when the setting is disabled", () => {
    const frame = buildContextBreakdownFrame({
      sessionId: "s1",
      contextMax: 200_000,
      staticEstimates: baseStatics,
      autocompactEnabled: false,
    });
    expect(
      frame.categories.find((c) => c.id === "autocompact_buffer"),
    ).toBeUndefined();
  });

  test("includes autocompact_buffer with default reserved tokens when enabled", () => {
    const frame = buildContextBreakdownFrame({
      sessionId: "s1",
      contextMax: 200_000,
      staticEstimates: baseStatics,
      autocompactEnabled: true,
    });
    const buf = frame.categories.find((c) => c.id === "autocompact_buffer")!;
    expect(buf.tokens).toBe(AUTOCOMPACT_BUFFER_DEFAULT_TOKENS);
  });

  test("never emits an mcp_tools category", () => {
    const frame = buildContextBreakdownFrame({
      sessionId: "s1",
      contextMax: 200_000,
      staticEstimates: baseStatics,
      autocompactEnabled: true,
    });
    for (const c of frame.categories) {
      expect(c.id).not.toBe("mcp_tools");
    }
  });

  test("wire shape carries type, tug_session_id, context_max, ipc_version", () => {
    const frame = buildContextBreakdownFrame({
      sessionId: "sess-42",
      contextMax: 1_000_000,
      staticEstimates: baseStatics,
      autocompactEnabled: false,
    });
    expect(frame.type).toBe("context_breakdown");
    expect(frame.tug_session_id).toBe("sess-42");
    expect(frame.context_max).toBe(1_000_000);
    expect(frame.ipc_version).toBe(2);
  });
});

// ---- ContextBreakdownEmitter (lifecycle) ---------------------------------

describe("ContextBreakdownEmitter", () => {
  const settingsOff: ClaudeCodeSettings = { autoCompactEnabled: false };
  const settingsOn: ClaudeCodeSettings = { autoCompactEnabled: true };

  function fresh(settings: ClaudeCodeSettings): ContextBreakdownEmitter {
    return new ContextBreakdownEmitter({
      sessionId: "test-session",
      claudeHome: ClaudeHome.resolve(null, scratch()),
      cwd: scratch(),
      pluginDir: scratch(),
      settings,
    });
  }

  function sysTools(frame: { categories: ReadonlyArray<{ id: string; tokens: number }> }): number {
    return frame.categories.find((c) => c.id === "system_tools")!.tokens;
  }

  test("onSpawn returns the static frame computed from disk — fires before any turn", () => {
    const frame = fresh(settingsOff).onSpawn();
    expect(frame.type).toBe("context_breakdown");
    expect(frame.tug_session_id).toBe("test-session");
    expect(
      frame.categories.find((c) => (c.id as string) === "messages"),
    ).toBeUndefined();
    // Pre-`system:init`, `system_tools` is the flat heuristic.
    expect(sysTools(frame)).toBe(SYSTEM_TOOLS_DEFAULT_TOKENS);
  });

  test("onSessionInit replaces the tool heuristic with the exact count", () => {
    const emitter = fresh(settingsOff);
    emitter.onSpawn();
    const f = emitter.onSessionInit(20);
    expect(sysTools(f)).toBe(20 * TOOL_SCHEMA_DEFAULT_TOKENS);
  });

  test("onCostUpdate before onSpawn returns null (defensive)", () => {
    expect(fresh(settingsOff).onCostUpdate(undefined)).toBeNull();
  });

  test("onCostUpdate refreshes context_max from modelUsage; tool count sticks", () => {
    const emitter = fresh(settingsOff);
    emitter.onSpawn();
    emitter.onSessionInit(20);
    const f = emitter.onCostUpdate({
      "claude-sonnet-4-5": { contextWindow: 1_000_000 },
    })!;
    expect(f.context_max).toBe(1_000_000);
    // The tool count captured at `onSessionInit` persists.
    expect(sysTools(f)).toBe(20 * TOOL_SCHEMA_DEFAULT_TOKENS);
  });

  test("autocompact-on emits the autocompact_buffer slice", () => {
    const frame = fresh(settingsOn).onSpawn();
    const buf = frame.categories.find((c) => c.id === "autocompact_buffer")!;
    expect(buf.tokens).toBe(AUTOCOMPACT_BUFFER_DEFAULT_TOKENS);
  });

  test("autocompact-off omits the autocompact_buffer slice", () => {
    const frame = fresh(settingsOff).onSpawn();
    expect(
      frame.categories.find((c) => c.id === "autocompact_buffer"),
    ).toBeUndefined();
  });

  test("onCompactBoundary is a no-op; subsequent cost_update still emits", () => {
    const emitter = fresh(settingsOff);
    emitter.onSpawn();
    emitter.onCompactBoundary();
    const f = emitter.onCostUpdate(undefined)!;
    expect(f.type).toBe("context_breakdown");
  });
});
