/**
 * Where Claude Code keeps things — the environment-free half of the
 * TypeScript `ClaudeHome`, shared by tugcode and tugdeck.
 *
 * Claude Code keeps its user-scope state under one directory: transcripts in
 * `projects/<encoded-cwd>/`, its live-session registry in `sessions/`,
 * `settings.json`, `skills/`, `agents/`, `CLAUDE.md`. That directory is
 * `$CLAUDE_CONFIG_DIR` when the variable is set and `$HOME/.claude`
 * otherwise. This module holds the rule and the layout; it reads no
 * environment, so the deck — which runs in a browser and cannot — builds
 * its paths from the root tugcast resolved and published.
 *
 * `tugcode/src/claude-home.ts` re-exports it and adds the one call that reads
 * the process environment. The Rust half is `tugcore::claude_home`; both run
 * `tugrust/crates/tugcore/src/claude_home_cases.json`.
 *
 * @module claude-home
 */

/** The directory name Claude Code uses, under `$HOME` and under a project. */
const DIR_NAME = ".claude";

/** `base` and `parts` joined with single slashes. */
function joinPath(base: string, ...parts: string[]): string {
  return [base.replace(/\/+$/, ""), ...parts].join("/");
}

/** Claude Code's user-scope config directory, resolved once. */
export class ClaudeHome {
  private constructor(private readonly rootDir: string) {}

  /** A home rooted at `root` — the config directory itself, not `$HOME`. */
  static at(root: string): ClaudeHome {
    return new ClaudeHome(root);
  }

  /**
   * The resolution rule, with its inputs named rather than read. An empty
   * `CLAUDE_CONFIG_DIR` counts as unset; with no home either, the root is
   * `/.claude` — Claude Code cannot run without a home, so a reader pointed
   * there finds nothing, which is the true answer.
   */
  static resolve(
    configDir: string | null | undefined,
    home: string | null | undefined,
  ): ClaudeHome {
    if (configDir) return ClaudeHome.at(configDir);
    return ClaudeHome.at(joinPath(home || "/", DIR_NAME));
  }

  root(): string {
    return this.rootDir;
  }

  /** `projects/`, one transcript directory per project. */
  projectsDir(): string {
    return joinPath(this.rootDir, "projects");
  }

  /**
   * `projects/<encoded project>/`. The path is encoded as given: Claude names
   * the directory after its canonical cwd, so a caller holding another
   * spelling resolves it first.
   */
  projectDir(project: string): string {
    return joinPath(this.projectsDir(), encodeProjectDir(project));
  }

  /** `sessions/`, Claude Code's registry of live sessions. */
  sessionsDir(): string {
    return joinPath(this.rootDir, "sessions");
  }

  /** User-scope `settings.json`. */
  settingsPath(): string {
    return joinPath(this.rootDir, "settings.json");
  }

  skillsDir(): string {
    return joinPath(this.rootDir, "skills");
  }

  agentsDir(): string {
    return joinPath(this.rootDir, "agents");
  }

  /** User-scope `CLAUDE.md`. */
  memoryPath(): string {
    return joinPath(this.rootDir, "CLAUDE.md");
  }

  /** A project's auto-memory folder, `projects/<encoded project>/memory/`. */
  autoMemoryDir(project: string): string {
    return joinPath(this.projectDir(project), "memory");
  }
}

/**
 * A project's own `.claude/` — where its `settings.json` and
 * `settings.local.json` live. It does not move with `CLAUDE_CONFIG_DIR`.
 */
export function projectClaudeDir(cwd: string): string {
  return joinPath(cwd, DIR_NAME);
}

/**
 * Claude Code's project-directory name for an absolute path: every character
 * outside `[A-Za-z0-9-]` becomes `-`, so `/repo/.tugtree/a__b` is
 * `-repo--tugtree-a--b`. This is Claude Code's own regex, over UTF-16 code
 * units, so a character outside the Basic Multilingual Plane is two dashes.
 */
export function encodeProjectDir(path: string): string {
  return path.replace(/[^A-Za-z0-9-]/g, "-");
}
