import { ClaudeHome } from "../claude-home.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildHooksInventory } from "../hooks-inventory.ts";

let scratchDirs: string[] = [];

function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

/** Write `<root>/.claude/<file>` containing the given settings object. */
function writeSettings(root: string, file: string, settings: unknown): void {
  const dir = join(root, ".claude");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), JSON.stringify(settings));
}

afterEach(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
  scratchDirs = [];
});

describe("buildHooksInventory", () => {
  test("parses an event's matcher groups + commands", () => {
    const home = scratch("tugcode-hooks-home-");
    const cwd = scratch("tugcode-hooks-cwd-");
    writeSettings(home, "settings.json", {
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [{ type: "command", command: "echo hi", timeout: 60 }],
          },
        ],
      },
    });

    const inv = buildHooksInventory({
      sessionId: "s",
      requestId: "h-1",
      claudeHome: ClaudeHome.resolve(null, home),
      cwd,
    });
    expect(inv.type).toBe("hooks_inventory");
    expect(inv.request_id).toBe("h-1");
    expect(Object.keys(inv.events)).toEqual(["PreToolUse"]);
    const groups = inv.events.PreToolUse;
    expect(groups).toHaveLength(1);
    expect(groups[0].matcher).toBe("Bash");
    expect(groups[0].hooks).toEqual([
      { type: "command", command: "echo hi", timeout: 60 },
    ]);
  });

  test("concatenates matcher groups for an event across scopes", () => {
    const home = scratch("tugcode-hooks-home-");
    const cwd = scratch("tugcode-hooks-cwd-");
    writeSettings(home, "settings.json", {
      hooks: { PostToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "a" }] }] },
    });
    writeSettings(cwd, "settings.json", {
      hooks: { PostToolUse: [{ matcher: "Write", hooks: [{ type: "command", command: "b" }] }] },
    });
    writeSettings(cwd, "settings.local.json", {
      hooks: { PostToolUse: [{ hooks: [{ type: "command", command: "c" }] }] },
    });

    const inv = buildHooksInventory({ sessionId: "s", requestId: "h", claudeHome: ClaudeHome.resolve(null, home), cwd });
    // User, then project, then local — concatenated.
    expect(inv.events.PostToolUse.map((g) => g.matcher)).toEqual([
      "Edit",
      "Write",
      undefined,
    ]);
  });

  test("empty / missing / malformed settings yield an empty inventory", () => {
    const home = scratch("tugcode-hooks-home-");
    const cwd = scratch("tugcode-hooks-cwd-");
    // No settings files at all.
    expect(
      buildHooksInventory({ sessionId: "s", requestId: "h", claudeHome: ClaudeHome.resolve(null, home), cwd }).events,
    ).toEqual({});
    // Malformed JSON is skipped, not thrown.
    mkdirSync(join(cwd, ".claude"), { recursive: true });
    writeFileSync(join(cwd, ".claude", "settings.json"), "{ not json");
    expect(
      buildHooksInventory({ sessionId: "s", requestId: "h", claudeHome: ClaudeHome.resolve(null, home), cwd }).events,
    ).toEqual({});
  });

  test("drops malformed matcher groups / commands defensively", () => {
    const home = scratch("tugcode-hooks-home-");
    const cwd = scratch("tugcode-hooks-cwd-");
    writeSettings(home, "settings.json", {
      hooks: {
        PreToolUse: [
          { matcher: "Bash", hooks: [{ type: "command", command: "ok" }, { command: "no-type" }] },
          { matcher: "Edit" }, // no hooks array → dropped
        ],
      },
    });
    const inv = buildHooksInventory({ sessionId: "s", requestId: "h", claudeHome: ClaudeHome.resolve(null, home), cwd });
    // The no-hooks group is dropped; the bad command (no type) is dropped.
    expect(inv.events.PreToolUse).toHaveLength(1);
    expect(inv.events.PreToolUse[0].hooks).toEqual([{ type: "command", command: "ok" }]);
  });
});
