/**
 * `ClaudeHome` against the shared case table, and the ban that keeps a
 * hand-built Claude Code path from coming back.
 *
 * The table is the Rust half's (`tugcore::claude_home` runs every row too),
 * so a row that fails here is the two halves disagreeing about where Claude
 * Code keeps things.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import {
  ClaudeHome,
  claudeHomeFromEnv,
  encodeProjectDir,
  projectClaudeDir,
} from "../claude-home.ts";

const REPO = resolve(import.meta.dir, "../../..");
const CASES = join(REPO, "tugrust/crates/tugcore/src/claude_home_cases.json");

interface Case {
  name: string;
  config_dir: string | null;
  home: string | null;
  call: string;
  arg?: string;
  expected: string;
}

function run(c: Case): string {
  const home = ClaudeHome.resolve(c.config_dir, c.home);
  const arg = (): string => {
    if (c.arg === undefined) throw new Error(`case ${c.name} names no arg`);
    return c.arg;
  };
  switch (c.call) {
    case "root": return home.root();
    case "projects_dir": return home.projectsDir();
    case "project_dir": return home.projectDir(arg());
    case "sessions_dir": return home.sessionsDir();
    case "settings_path": return home.settingsPath();
    case "skills_dir": return home.skillsDir();
    case "agents_dir": return home.agentsDir();
    case "memory_path": return home.memoryPath();
    case "auto_memory_dir": return home.autoMemoryDir(arg());
    case "project_claude_dir": return projectClaudeDir(arg());
    case "encode_project_dir": return encodeProjectDir(arg());
    default: throw new Error(`case ${c.name}: unknown call ${c.call}`);
  }
}

describe("ClaudeHome shared cases", () => {
  const { cases } = JSON.parse(readFileSync(CASES, "utf-8")) as { cases: Case[] };

  test("the table is not empty", () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  for (const c of cases) {
    test(c.name, () => {
      expect(run(c)).toBe(c.expected);
    });
  }

  test("fromEnv reads CLAUDE_CONFIG_DIR", () => {
    expect(claudeHomeFromEnv({ CLAUDE_CONFIG_DIR: "/cfg" }).root()).toBe("/cfg");
  });
});

// ── The ban ──────────────────────────────────────────────────────────────────

/**
 * Source trees whose files may not build a Claude Code path by hand. Unit
 * tests (`__tests__/`) are exempt, as the Rust ban exempts test modules: a
 * fixture laid out under a temp home states Claude Code's layout rather than
 * reading the user's. The app-tests are not exempt, because their fixtures
 * seed the user's real config directory, which tugcode reads through
 * `ClaudeHome`; they build paths through `tests/app-test/_harness/claude-home.ts`.
 */
const BANNED_ROOTS = ["tugcode/src", "tugproto/src", "tugdeck/src", "tests/app-test"];

/** The one TypeScript file allowed to spell the directory name. */
const ALLOWED = new Set(["tugproto/src/claude-home.ts"]);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name === "__tests__" || name === "node_modules" || name === "logs") continue;
      out.push(...sourceFiles(path));
    } else if (/\.tsx?$/.test(name)) {
      out.push(path);
    }
  }
  return out;
}

/** The line with any `//` comment removed; a `//` inside a string is kept. */
function codePart(line: string): string {
  const trimmed = line.trimStart();
  if (trimmed.startsWith("*") || trimmed.startsWith("/*")) return "";
  let from = 0;
  for (;;) {
    const at = line.indexOf("//", from);
    if (at < 0) return line;
    const quotes = (line.slice(0, at).match(/["'`]/g) ?? []).length;
    if (quotes % 2 === 0) return line.slice(0, at);
    from = at + 2;
  }
}

/** True when `code` holds `.claude` as a whole path component in a string. */
function namesClaudeDir(code: string): boolean {
  return /["'`/]\.claude(?=["'`/])/.test(code);
}

describe("no hand-built Claude Code paths", () => {
  test("the matcher sees the shapes it exists for", () => {
    expect(namesClaudeDir('join(home, ".claude", "skills")')).toBe(true);
    expect(namesClaudeDir("`${home}/.claude/projects`")).toBe(true);
    expect(namesClaudeDir("'~/.claude/settings.json'")).toBe(true);
    expect(namesClaudeDir('"https://downloads.claude.ai"')).toBe(false);
    expect(namesClaudeDir("entry.claudeSessionId")).toBe(false);
    expect(codePart("const x = 1; // ~/.claude/projects")).toBe("const x = 1; ");
    expect(codePart(" * `~/.claude/skills` is the user scope.")).toBe("");
    expect(codePart('"https://a/b"')).toBe('"https://a/b"');
  });

  test("production sources go through ClaudeHome", () => {
    const offenders: string[] = [];
    for (const root of BANNED_ROOTS) {
      for (const file of sourceFiles(join(REPO, root))) {
        const rel = relative(REPO, file);
        if (ALLOWED.has(rel)) continue;
        readFileSync(file, "utf-8").split("\n").forEach((line, i) => {
          if (namesClaudeDir(codePart(line))) {
            offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
          }
        });
      }
    }
    expect(offenders).toEqual([]);
  });
});
