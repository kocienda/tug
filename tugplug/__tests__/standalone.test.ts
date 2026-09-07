/**
 * standalone.test.ts — the plugin works from a bundle alone.
 *
 * A user's machine has Tug.app and nothing of ours: no source checkout, no
 * tuglaws/, no CLAUDE.md, no .tugtool/, no ~/.claude, no jq, no ~/.local/bin
 * symlinks. This drives the real hook script and the real `tugtool arc` verbs
 * under exactly those conditions — a bundle-shaped directory holding the built
 * tugtool and this plugin, a scratch git project, an empty PATH, and a fresh
 * HOME — so a dependence on this checkout fails here before it fails there.
 *
 * `just test-standalone` builds tugtool first; run bare, the test says what to
 * build rather than passing vacuously.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../..");
const PLUGIN_SRC = join(ROOT, "tugplug");
const TUGTOOL_BUILT = join(ROOT, "tugrust/target/debug/tugtool");

/** What a machine with only the OS on it offers. */
const BARE_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

let lab = "";
let bundle = "";
let pluginRoot = "";
let project = "";
let home = "";
let dataDir = "";

function env(extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: BARE_PATH,
    HOME: home,
    TUG_DATA_DIR: dataDir,
    CLAUDE_PLUGIN_ROOT: pluginRoot,
    GIT_AUTHOR_NAME: "standalone",
    GIT_AUTHOR_EMAIL: "standalone@example.invalid",
    GIT_COMMITTER_NAME: "standalone",
    GIT_COMMITTER_EMAIL: "standalone@example.invalid",
    ...extra,
  };
}

function run(cmd: string[], opts: { cwd?: string; env?: Record<string, string>; stdin?: string } = {}) {
  const proc = Bun.spawnSync(cmd, {
    cwd: opts.cwd ?? project,
    env: opts.env ?? env(),
    stdin: opts.stdin !== undefined ? new TextEncoder().encode(opts.stdin) : undefined,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: proc.exitCode,
    out: new TextDecoder().decode(proc.stdout),
    err: new TextDecoder().decode(proc.stderr),
  };
}

/** The hook exactly as Claude Code runs it: `sh <script>` with the payload on stdin. */
function hook(payload: unknown, extra: Record<string, string> = {}) {
  const r = run(["sh", join(pluginRoot, "hooks/pre-tool-use.sh")], {
    env: env(extra),
    stdin: JSON.stringify(payload),
  });
  expect(r.code).toBe(0);
  return r.out.trim() === "" ? null : JSON.parse(r.out);
}

/** tugtool as a session finds it once the app has seeded PATH with the bundle. */
function tugtool(args: string[], extra: Record<string, string> = {}) {
  return run([join(bundle, "Contents/MacOS/tugtool"), ...args], {
    env: env({ PATH: `${join(bundle, "Contents/MacOS")}:${BARE_PATH}`, ...extra }),
  });
}

beforeAll(() => {
  if (!existsSync(TUGTOOL_BUILT)) {
    throw new Error(`no built tugtool at ${TUGTOOL_BUILT} — run \`cd tugrust && cargo build -p tugtool\` (or \`just test-standalone\`)`);
  }
  lab = mkdtempSync(join(tmpdir(), "tug-standalone-"));
  home = join(lab, "home");
  mkdirSync(home);
  dataDir = join(lab, "data");
  mkdirSync(dataDir);

  // A bundle-shaped directory: the binary where the app puts it, and the plugin
  // where tugcode resolves it (Contents/Resources/tugplug). The plugin is a
  // copy, not a symlink — a real bundle's is a real directory.
  bundle = join(lab, "Tug.app");
  mkdirSync(join(bundle, "Contents/MacOS"), { recursive: true });
  mkdirSync(join(bundle, "Contents/Resources"), { recursive: true });
  symlinkSync(TUGTOOL_BUILT, join(bundle, "Contents/MacOS/tugtool"));
  pluginRoot = join(bundle, "Contents/Resources/tugplug");
  cpSync(PLUGIN_SRC, pluginRoot, {
    recursive: true,
    filter: (src) => !src.includes("/__tests__") && !src.includes("/node_modules") && !src.endsWith(".DS_Store"),
  });

  // A user's project: a git checkout with none of our files in it.
  project = join(lab, "proj");
  mkdirSync(join(project, "src"), { recursive: true });
  writeFileSync(join(project, "src/app.txt"), "hello\n");
  for (const cmd of [
    ["git", "init", "-q", "-b", "main"],
    ["git", "add", "."],
    ["git", "commit", "-q", "-m", "init"],
  ]) {
    const r = run(cmd);
    if (r.code !== 0) throw new Error(`${cmd.join(" ")}: ${r.err}`);
  }
});

afterAll(() => {
  if (lab !== "" && existsSync(lab)) rmSync(lab, { recursive: true, force: true });
});

describe("the lab is what a user's machine is", () => {
  test("the project carries none of this repository's files", () => {
    for (const ours of ["tuglaws", "CLAUDE.md", ".tugtool", ".claude", "justfile"]) {
      expect(existsSync(join(project, ours))).toBe(false);
    }
    expect(existsSync(join(home, ".claude"))).toBe(false);
  });

  test("the bare PATH offers no tug tool", () => {
    const r = run(["sh", "-c", "command -v tugtool; command -v tugcode; exit 0"]);
    expect(r.out.trim()).toBe("");
  });
});

describe("the hook script, from the bundle alone", () => {
  test("finds tugtool beside the plugin when PATH has nothing", () => {
    const decision = hook({ tool_name: "Skill", tool_input: { skill: "tugplug:arc" } });
    expect(decision?.hookSpecificOutput?.permissionDecision).toBe("allow");
  });

  test("allows the model-invocable brief skill", () => {
    const decision = hook({ tool_name: "Skill", tool_input: { skill: "tugplug:brief" } });
    expect(decision?.hookSpecificOutput?.permissionDecision).toBe("allow");
  });

  test("finds tugtool through TUG_BUNDLE_PATH when the plugin root is elsewhere", () => {
    const elsewhere = join(lab, "elsewhere-plugin");
    if (!existsSync(elsewhere)) cpSync(pluginRoot, elsewhere, { recursive: true });
    const r = run(["sh", join(elsewhere, "hooks/pre-tool-use.sh")], {
      env: env({ CLAUDE_PLUGIN_ROOT: elsewhere, TUG_BUNDLE_PATH: bundle }),
      stdin: JSON.stringify({ tool_name: "Bash", tool_input: { command: "ls -la" } }),
    });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).hookSpecificOutput.permissionDecision).toBe("allow");
  });

  test("denies an unreadable repo write and steers at the edit program", () => {
    const decision = hook({
      tool_name: "Bash",
      tool_input: { command: "python3 - <<'PY'\nimport pathlib\npathlib.Path('src/app.txt').write_text('x')\nPY" },
      cwd: project,
    });
    expect(decision.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(decision.hookSpecificOutput.permissionDecisionReason).toContain("tugtool file edit");
  });

  test("has no opinion on an ordinary command", () => {
    expect(hook({ tool_name: "Bash", tool_input: { command: "cargo build" }, cwd: project })).toBeNull();
  });

  test("says so, visibly, when no tugtool can be found at all", () => {
    const elsewhere = join(lab, "elsewhere-plugin");
    if (!existsSync(elsewhere)) cpSync(pluginRoot, elsewhere, { recursive: true });
    const r = run(["sh", join(elsewhere, "hooks/pre-tool-use.sh")], {
      env: env({ CLAUDE_PLUGIN_ROOT: elsewhere }),
      stdin: JSON.stringify({ tool_name: "Bash", tool_input: { command: "ls" } }),
    });
    expect(r.code).toBe(0);
    const out = JSON.parse(r.out);
    expect(out.systemMessage).toContain("tugtool was not found");
    expect(out.hookSpecificOutput).toBeUndefined();
  });

  test("hooks.json routes every matcher at that one script, and nothing else ships in hooks/", () => {
    const manifest = JSON.parse(readFileSync(join(pluginRoot, "hooks/hooks.json"), "utf8"));
    const commands = manifest.hooks.PreToolUse.flatMap((m: { hooks: { command: string }[] }) =>
      m.hooks.map((h) => h.command),
    );
    expect(new Set(commands)).toEqual(new Set(["${CLAUDE_PLUGIN_ROOT}/hooks/pre-tool-use.sh"]));
    expect(readdirSync(join(pluginRoot, "hooks")).sort()).toEqual(["hooks.json", "pre-tool-use.sh"]);
  });
});

describe("the arc verbs on a project that declares nothing", () => {
  test("create → config → documents → verify → discard, with no .tugtool/", () => {
    const created = tugtool(["--json", "arc", "create", "smoke"]);
    expect(created.code, created.err).toBe(0);
    const worktree = JSON.parse(created.out).data.worktree as string;
    expect(existsSync(worktree)).toBe(true);

    const config = tugtool(["--json", "arc", "config"]);
    expect(config.code, config.err).toBe(0);
    const data = JSON.parse(config.out).data;
    expect(data.build).toBeNull();
    expect(data.surfaces).toEqual([]);
    expect(data.post_create).toEqual([]);

    const documents = tugtool(["arc", "documents", "smoke", "--ensure"]);
    expect(documents.code, documents.err).toBe(0);
    expect(existsSync(join(project, ".tug/arcs/smoke"))).toBe(true);

    const verify = tugtool(["arc", "verify", "smoke"], { });
    expect(verify.code, verify.err).toBe(0);

    const discard = tugtool(["arc", "discard", "smoke"]);
    expect(discard.code, discard.err).toBe(0);
    expect(existsSync(worktree)).toBe(false);
  });

  test("the ledgers landed under the scratch data dir, not the author's", () => {
    expect(readdirSync(dataDir).length).toBeGreaterThan(0);
  });

  test("brief dir answers with the project's own briefs/ and no setting", () => {
    const dir = tugtool(["brief", "dir"]);
    expect(dir.code, dir.err).toBe(0);
    // The verb resolves the project from its own cwd, which macOS reports
    // through /private/var; the scratch project's path is the /var symlink.
    expect(dir.out.trim()).toBe(join(realpathSync(project), "briefs"));

    const json = tugtool(["--json", "brief", "dir"]);
    expect(json.code, json.err).toBe(0);
    expect(JSON.parse(json.out).data.source).toBe("default");
  });
});

describe("brief is the one skill a model may reach for", () => {
  test("only skills/brief carries no disable-model-invocation", () => {
    const skills = join(pluginRoot, "skills");
    const invocable: string[] = [];
    for (const skill of readdirSync(skills).filter((s) => statSync(join(skills, s)).isDirectory())) {
      const skillMd = join(skills, skill, "SKILL.md");
      if (!existsSync(skillMd)) continue;
      const front = readFileSync(skillMd, "utf8").split("---")[1] ?? "";
      if (!/^disable-model-invocation:\s*true$/m.test(front)) invocable.push(skill);
    }
    // The exception is singular and deliberate: a model reaching for a door
    // would start work nobody asked for, while a brief is a document written
    // where the user said to write one.
    expect(invocable).toEqual(["brief"]);
  });
});

describe("every verb a skill names is one the shipped binary has", () => {
  const namespaces = ["arc", "plan", "brief", "draft", "file", "host", "hook", "changes", "session"] as const;

  test("tugtool <namespace> <verb> mentions resolve against --help", () => {
    const help = new Map<string, string>();
    for (const ns of namespaces) {
      help.set(ns, tugtool([ns, "--help"]).out);
    }
    const top = tugtool(["--help"]).out;
    const missing: string[] = [];
    const skills = join(pluginRoot, "skills");
    for (const skill of readdirSync(skills).filter((s) => statSync(join(skills, s)).isDirectory())) {
      // A directory under skills/ that carries no SKILL.md is a resource the
      // skills ship beside them, not a skill.
      const skillMd = join(skills, skill, "SKILL.md");
      if (!existsSync(skillMd)) continue;
      const text = readFileSync(skillMd, "utf8");
      for (const m of text.matchAll(/`tugtool ([a-z-]+)(?: ([a-z-]+))?/g)) {
        const [, ns, verb] = m;
        if (!top.includes(`  ${ns}`)) {
          missing.push(`${skill}: tugtool ${ns}`);
          continue;
        }
        if (verb && help.has(ns) && !help.get(ns)!.includes(`  ${verb}`)) {
          missing.push(`${skill}: tugtool ${ns} ${verb}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  /**
   * The seat fallback lives in the two stages that work in a worktree, and
   * nowhere else. The dispatch makes the seat before it names it; the stage
   * skills keep the idempotent `arc create` as the repair they say out loud,
   * because the plugin ships beside the tugcast that composes the line and a
   * stage that can fix a missing seat in one verb is cheaper than an arc that
   * stops for it. A door names no such verb: it writes documents and hands
   * the arc to the wheel, and a door that created a worktree would be the
   * shape this test exists to keep out.
   */
  test("the stage skills carry the seat fallback and the door does not", () => {
    const skills = join(pluginRoot, "skills");
    const names = (skill: string): boolean =>
      readFileSync(join(skills, skill, "SKILL.md"), "utf8").includes("tugtool arc create");
    expect(names("arc-implement"), "arc-implement keeps the fallback").toBe(true);
    expect(names("arc-audit"), "arc-audit keeps the fallback").toBe(true);
    expect(names("arc"), "the door makes no seat").toBe(false);
  });
});
