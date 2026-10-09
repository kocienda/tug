import { ClaudeHome } from "../claude-home.ts";
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildSkillsInventory,
  readFrontmatterField,
} from "../skills-inventory.ts";
import { initTokenizer } from "../tokenizer.ts";

// `buildSkillsInventory` counts frontmatter tokens via the real tiktoken
// encoder, which must be instantiated before the first `countTokens` call.
beforeAll(async () => {
  await initTokenizer();
});

let scratchDirs: string[] = [];

function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

/** Write `<root>/skills/<dir>/SKILL.md` with the given frontmatter body. */
function writeSkill(root: string, dirName: string, frontmatter: string): void {
  const skillDir = join(root, "skills", dirName);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, "SKILL.md"),
    `---\n${frontmatter}\n---\n\n## Body\n\nbody text\n`,
  );
}

afterEach(() => {
  for (const dir of scratchDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  scratchDirs = [];
});

describe("readFrontmatterField", () => {
  test("reads a bare field", () => {
    expect(readFrontmatterField("name: audit\ndescription: x", "name")).toBe(
      "audit",
    );
  });

  test("strips surrounding quotes", () => {
    expect(
      readFrontmatterField(`argument-hint: "[plan-path]"`, "argument-hint"),
    ).toBe("[plan-path]");
    expect(readFrontmatterField("name: 'commit'", "name")).toBe("commit");
  });

  test("returns undefined for an absent or empty field", () => {
    expect(readFrontmatterField("name: audit", "description")).toBeUndefined();
    expect(readFrontmatterField("name:   ", "name")).toBeUndefined();
  });

  test("does not match a field name that is a substring of another", () => {
    // `name:` must not be matched by a query for `na`.
    expect(readFrontmatterField("name: audit", "na")).toBeUndefined();
  });
});

describe("buildSkillsInventory", () => {
  test("lists plugin skills as locked, namespaced, with tokens + description", () => {
    const home = scratch("tugcode-skills-home-");
    const project = scratch("tugcode-skills-proj-");
    const pluginDir = join(project, "tugplug");
    writeSkill(
      pluginDir,
      "audit",
      "name: audit\ndescription: Audit the implementation work",
    );
    writeSkill(
      pluginDir,
      "commit",
      "name: commit\ndescription: Stage and commit now",
    );

    const frame = buildSkillsInventory({
      sessionId: "sess-1",
      requestId: "req-1",
      claudeHome: ClaudeHome.resolve(null, home),
      pluginDir,
    });

    expect(frame.type).toBe("skills_inventory");
    expect(frame.tug_session_id).toBe("sess-1");
    expect(frame.request_id).toBe("req-1");
    expect(frame.skills.map((s) => s.name)).toEqual([
      "tugplug:audit",
      "tugplug:commit",
    ]);
    const audit = frame.skills.find((s) => s.name === "tugplug:audit")!;
    expect(audit.source).toBe("tugplug");
    expect(audit.locked).toBe(true);
    expect(audit.description).toBe("Audit the implementation work");
    expect(audit.tokens).toBeGreaterThan(0);
  });

  test("lists user skills as unlocked, bare-named, after plugin skills", () => {
    const home = scratch("tugcode-skills-home-");
    const project = scratch("tugcode-skills-proj-");
    const pluginDir = join(project, "tugplug");
    writeSkill(pluginDir, "vet", "name: vet\ndescription: Quick assessment");
    // User skills live under `~/.claude/skills`.
    writeSkill(join(home, ".claude"), "mine", "name: mine\ndescription: A personal skill");

    const frame = buildSkillsInventory({
      sessionId: "s",
      requestId: "r",
      claudeHome: ClaudeHome.resolve(null, home),
      pluginDir,
    });

    // Plugin skills first, then user skills.
    expect(frame.skills.map((s) => s.name)).toEqual(["tugplug:vet", "mine"]);
    const mine = frame.skills.find((s) => s.name === "mine")!;
    expect(mine.source).toBe("user");
    expect(mine.locked).toBe(false);
  });

  test("falls back to the directory name when frontmatter has no name", () => {
    const home = scratch("tugcode-skills-home-");
    const project = scratch("tugcode-skills-proj-");
    const pluginDir = join(project, "tugplug");
    writeSkill(pluginDir, "nameless", "description: No name field here");

    const frame = buildSkillsInventory({
      sessionId: "s",
      requestId: "r",
      claudeHome: ClaudeHome.resolve(null, home),
      pluginDir,
    });
    expect(frame.skills[0].name).toBe("tugplug:nameless");
  });

  test("missing skill dirs yield an empty (not failing) inventory", () => {
    const home = scratch("tugcode-skills-home-");
    const project = scratch("tugcode-skills-proj-");
    const frame = buildSkillsInventory({
      sessionId: "s",
      requestId: "r",
      claudeHome: ClaudeHome.resolve(null, home),
      pluginDir: join(project, "tugplug"),
    });
    expect(frame.skills).toEqual([]);
  });

  test("a directory without a SKILL.md is skipped", () => {
    const home = scratch("tugcode-skills-home-");
    const project = scratch("tugcode-skills-proj-");
    const pluginDir = join(project, "tugplug");
    // A stray directory under skills/ with no SKILL.md.
    mkdirSync(join(pluginDir, "skills", "not-a-skill"), { recursive: true });
    writeSkill(pluginDir, "real", "name: real\ndescription: A real skill");

    const frame = buildSkillsInventory({
      sessionId: "s",
      requestId: "r",
      claudeHome: ClaudeHome.resolve(null, home),
      pluginDir,
    });
    expect(frame.skills.map((s) => s.name)).toEqual(["tugplug:real"]);
  });
});
