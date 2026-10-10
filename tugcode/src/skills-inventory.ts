// Build the `/skills` inventory ([#step-12d]) — the read-only listing of the
// **plugin + user** skills (the on-disk, user-manageable set). This mirrors
// Claude Code's own `/skills`, which lists plugin/user skills and excludes
// built-in skills (those live inside the claude package and surface in
// `/context` instead).
//
// Every column the sheet shows is sourced here from each skill's `SKILL.md` —
// the same frontmatter the context breakdown tokenizes (see
// `context-breakdown.ts`): the display name, the description, the originating
// plugin (or user scope), the frontmatter token estimate, and whether the
// skill is plugin-managed (author-locked).
//
// Pure + best-effort: a missing or unreadable directory / file contributes no
// entry rather than failing the inventory. Invoked once per
// `skills_inventory_query`, reading a handful of small files — no caching.

import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { ClaudeHome } from "./claude-home.ts";

import { countTokens } from "./tokenizer.ts";

import { extractFrontmatter } from "./context-breakdown.ts";
import type { SkillInventoryEntry, SkillsInventory } from "./types.ts";
import { IPC_VERSION } from "./types.ts";

/**
 * Read a single `field: value` line out of a SKILL.md frontmatter block.
 * Returns `undefined` when the field is absent or empty. Strips one layer of
 * surrounding single/double quotes (frontmatter values are often quoted).
 * Frontmatter is flat `key: value` YAML in practice — a line scan is exact
 * and avoids pulling in a YAML dependency.
 */
export function readFrontmatterField(
  frontmatter: string,
  field: string,
): string | undefined {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^${escaped}:[ \\t]*(.*)$`, "m").exec(frontmatter);
  if (match === null) return undefined;
  let value = match[1].trim();
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    value = value.slice(1, -1);
  }
  return value.length > 0 ? value : undefined;
}

/** Read one `<dir>/SKILL.md` into an entry, or `null` when it can't be read. */
function readSkillEntry(
  skillDir: string,
  dirName: string,
  source: string,
  locked: boolean,
): SkillInventoryEntry | null {
  let text: string;
  try {
    text = readFileSync(join(skillDir, "SKILL.md"), "utf-8");
  } catch {
    return null; // no SKILL.md here — not a skill directory.
  }
  const frontmatter = extractFrontmatter(text);
  // The skill's own `name:` wins; the directory name is the fallback.
  const skillName = frontmatter
    ? (readFrontmatterField(frontmatter, "name") ?? dirName)
    : dirName;
  const description = frontmatter
    ? (readFrontmatterField(frontmatter, "description") ?? "")
    : "";
  const tokens = frontmatter === null ? 0 : countTokens(frontmatter);
  // Plugin skills are namespaced `<plugin>:<name>` (matching the wire's
  // `skills[]`); user skills carry no prefix.
  const name = source === "user" ? skillName : `${source}:${skillName}`;
  return { name, description, source, locked, tokens };
}

/** Enumerate `<root>/<dir>/SKILL.md` entries under a skills root. */
function readSkillsRoot(
  skillsRoot: string,
  source: string,
  locked: boolean,
): SkillInventoryEntry[] {
  let dirs: string[];
  try {
    dirs = readdirSync(skillsRoot);
  } catch {
    return []; // no skills dir at this scope — fine.
  }
  const entries: SkillInventoryEntry[] = [];
  for (const dirName of dirs) {
    const entry = readSkillEntry(
      join(skillsRoot, dirName),
      dirName,
      source,
      locked,
    );
    if (entry !== null) entries.push(entry);
  }
  return entries;
}

export interface BuildSkillsInventoryOptions {
  /** The session this inventory answers for (echoed on the frame). */
  sessionId: string;
  /** The correlating request id from the {@link SkillsInventoryQuery}. */
  requestId: string;
  /** Where Claude Code keeps things — its `skills/` is the user scope. */
  claudeHome: ClaudeHome;
  /**
   * The project plugin dir (e.g. `<cwd>/tugplug`) — its `skills/` subdir holds
   * the plugin skills. Mirrors `SessionManager.getPluginDir()` /
   * `ContextBreakdownEmitter`'s `pluginDir`.
   */
  pluginDir: string;
}

/**
 * Assemble the {@link SkillsInventory} frame: plugin skills under
 * `<pluginDir>/skills` (author-locked, named `<plugin>:<skill>`) followed by
 * user skills under `~/.claude/skills` (editable, bare-named), each sorted by
 * name so the listing is stable. Built-in skills are excluded by construction
 * (no on-disk SKILL.md to read).
 */
export function buildSkillsInventory(
  options: BuildSkillsInventoryOptions,
): SkillsInventory {
  const { sessionId, requestId, claudeHome, pluginDir } = options;
  const pluginName = basename(pluginDir);

  const pluginSkills = readSkillsRoot(
    join(pluginDir, "skills"),
    pluginName,
    true,
  ).sort((a, b) => a.name.localeCompare(b.name));
  const userSkills = readSkillsRoot(
    claudeHome.skillsDir(),
    "user",
    false,
  ).sort((a, b) => a.name.localeCompare(b.name));

  return {
    type: "skills_inventory",
    tug_session_id: sessionId,
    request_id: requestId,
    skills: [...pluginSkills, ...userSkills],
    ipc_version: IPC_VERSION,
  };
}
