/**
 * plugin-commands — unit tests for the turn-free plugin-command catalog
 * augmentation: enumerating a plugin's commands from disk and merging them
 * into the `session_capabilities` catalog. See `capabilities.ts`.
 */

import { describe, expect, test, afterAll } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  enumeratePluginCommands,
  mergePluginCommands,
} from "../capabilities.ts";
import type { SessionCapabilities } from "../types.ts";

const created: string[] = [];

function makePlugin(
  name: string,
  skills: Array<{ dir: string; frontmatter?: string }>,
  commands: string[] = [],
): string {
  const root = mkdtempSync(join(tmpdir(), "plugincmd-"));
  created.push(root);
  const dir = join(root, name);
  mkdirSync(join(dir, "skills"), { recursive: true });
  for (const s of skills) {
    mkdirSync(join(dir, "skills", s.dir), { recursive: true });
    const body = s.frontmatter ? `---\n${s.frontmatter}\n---\nbody` : "body";
    writeFileSync(join(dir, "skills", s.dir, "SKILL.md"), body);
  }
  if (commands.length > 0) {
    mkdirSync(join(dir, "commands"), { recursive: true });
    for (const c of commands) writeFileSync(join(dir, "commands", `${c}.md`), "cmd");
  }
  return dir;
}

afterAll(() => {
  for (const r of created) rmSync(r, { recursive: true, force: true });
});

describe("enumeratePluginCommands", () => {
  test("namespaces skills as <plugin>:<name> with description + arg hint", () => {
    const dir = makePlugin("tugplug", [
      {
        dir: "commit",
        frontmatter: "name: commit\ndescription: Make a commit.",
      },
      {
        dir: "devise",
        frontmatter: "name: devise\ndescription: Plan.\nargument-hint: <idea>",
      },
    ]);
    const cmds = enumeratePluginCommands(dir);
    expect(cmds).toContainEqual({
      name: "tugplug:commit",
      description: "Make a commit.",
    });
    expect(cmds).toContainEqual({
      name: "tugplug:devise",
      description: "Plan.",
      argumentHint: "<idea>",
    });
  });

  test("falls back to the directory name when frontmatter lacks `name`", () => {
    const dir = makePlugin("tugplug", [{ dir: "audit" }]);
    expect(enumeratePluginCommands(dir)).toEqual([{ name: "tugplug:audit" }]);
  });

  test("includes commands/*.md files", () => {
    const dir = makePlugin("tugplug", [], ["release"]);
    expect(enumeratePluginCommands(dir)).toContainEqual({
      name: "tugplug:release",
    });
  });

  test("returns [] for a missing plugin dir (never throws)", () => {
    expect(enumeratePluginCommands("/no/such/plugin")).toEqual([]);
  });

  // The rest of this describe block builds its own plugins in a temp dir. This
  // one reads the repository's real `tugplug/`, because the fact worth pinning
  // is that the shipped skill is catalogued at all: the bare `/arc` a user
  // types resolves to `tugplug:arc` by unique namespace-suffix match
  // (`resolveRemoteCommand`, tugdeck), and a second catalog entry whose leaf is
  // also `arc` would make that resolution ambiguous — which reads to the user
  // as "Unknown command" rather than as anything nameable.
  test("the repository's own plugin catalogues tugplug:arc and tugplug:arc-plan, unambiguously", () => {
    const pluginDir = join(import.meta.dir, "..", "..", "..", "tugplug");
    if (!existsSync(join(pluginDir, "skills"))) return; // not a full checkout.

    const cmds = enumeratePluginCommands(pluginDir);
    const arc = cmds.find((c) => c.name === "tugplug:arc");
    expect(arc).toBeDefined();
    // The frontmatter's own words, so a fabricated entry could not pass —
    // but *which* words is not this test's business. Pinning a phrase made
    // this red the moment the skill's own sentence was rewritten, which is a
    // sentence the skill is entitled to rewrite. So the claim is that the
    // description was read out of the file: a non-empty string that occurs in
    // the shipped `SKILL.md` verbatim. A fabricated entry still cannot pass,
    // and a reworded one no longer has to.
    const arcDescription = arc?.description ?? "";
    expect(arcDescription.length).toBeGreaterThan(0);
    const source = readFileSync(join(pluginDir, "skills", "arc", "SKILL.md"), "utf8");
    expect(source).toContain(arcDescription);
    expect(arc!.argumentHint).toBe("[name] [instruction…]");

    const arcLeaves = cmds.filter((c) => c.name.split(":").pop() === "arc");
    expect(arcLeaves.map((c) => c.name)).toEqual(["tugplug:arc"]);

    // The other door, on the same terms: a second catalog entry whose leaf is
    // also `arc-plan` is what would make a bare `/arc-plan` ambiguous.
    const arcPlan = cmds.find((c) => c.name === "tugplug:arc-plan");
    expect(arcPlan).toBeDefined();
    const arcPlanDescription = arcPlan?.description ?? "";
    expect(arcPlanDescription.length).toBeGreaterThan(0);
    const arcPlanSource = readFileSync(join(pluginDir, "skills", "arc-plan", "SKILL.md"), "utf8");
    expect(arcPlanSource).toContain(arcPlanDescription);

    const arcPlanLeaves = cmds.filter((c) => c.name.split(":").pop() === "arc-plan");
    expect(arcPlanLeaves.map((c) => c.name)).toEqual(["tugplug:arc-plan"]);
  });
});

describe("mergePluginCommands", () => {
  function caps(commands: SessionCapabilities["commands"]): SessionCapabilities {
    return {
      type: "session_capabilities",
      models: [],
      commands,
      agents: [],
      available_output_styles: [],
      output_style: "",
      account: null,
      effort: null,
      version: null,
      ipc_version: 2,
    };
  }

  test("replaces claude's bare leaf with the qualified form (no duplicate)", () => {
    // claude's handshake reports the plugin skill bare; enumeration supplies
    // the qualified twin. Result: qualified only.
    const merged = mergePluginCommands(
      caps([{ name: "compact" }, { name: "commit" }, { name: "code-review" }]),
      [{ name: "tugplug:commit", description: "Make a commit." }],
    );
    const names = merged.commands.map((c) => c.name);
    expect(names).not.toContain("commit");
    expect(names).toContain("tugplug:commit");
    // Genuine bare user skills / built-ins are untouched.
    expect(names).toContain("compact");
    expect(names).toContain("code-review");
  });

  test("does not double-add when the qualified form is already present", () => {
    const merged = mergePluginCommands(
      caps([{ name: "tugplug:commit" }]),
      [{ name: "tugplug:commit", description: "Make a commit." }],
    );
    expect(merged.commands.map((c) => c.name)).toEqual(["tugplug:commit"]);
  });

  test("returns the same caps when there is nothing to add", () => {
    const c = caps([{ name: "compact" }]);
    expect(mergePluginCommands(c, [])).toBe(c);
  });
});
