/**
 * model-respawn.test.ts — the user's model selection survives every respawn
 * tugcode performs for its own reasons.
 *
 * Setting a model is a live `set_model` control request to the running claude.
 * But tugcode kills and respawns that process on its own initiative — to apply
 * an `--effort` change, to apply an `/add-dir`, to fork, to continue — and the
 * new process has never seen that control request. Unless tugcode re-applies
 * the selection as `--model`, every one of those respawns silently reverts the
 * user to the account default.
 *
 * These tests capture the argv of the process each path actually launches, by
 * stubbing only the two spawn primitives (`Bun.which` to locate claude,
 * `Bun.spawn` to launch it) — the handler code under test runs for real.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SessionManager, buildClaudeArgs } from "../session.ts";

const SID = "33333333-3333-3333-3333-333333333333";
const FAKE_CLAUDE = "/usr/local/bin/claude-under-test";

const realWhich = Bun.which;
const realSpawn = Bun.spawn;

/** Every argv `Bun.spawn` was handed since the last reset, in launch order. */
let spawns: string[][] = [];

/**
 * A claude stand-in with just the surface `killAndCleanup` touches: a stdin it
 * can close, an `exited` that is already settled, and a `kill` that does
 * nothing. The stdout drain is stubbed off per manager, so no stream is needed.
 */
function fakeProcess(): unknown {
  return {
    stdin: { write: () => {}, flush: () => {}, end: () => {} },
    stdout: null,
    exited: Promise.resolve(0),
    kill: () => {},
    pid: 4242,
  };
}

beforeEach(() => {
  spawns = [];
  (Bun as unknown as { which: unknown }).which = (cmd: string) =>
    cmd === "claude" ? FAKE_CLAUDE : null;
  (Bun as unknown as { spawn: unknown }).spawn = (cmd: string[]) => {
    spawns.push(cmd.slice(1));
    return fakeProcess();
  };
});

afterEach(() => {
  (Bun as unknown as { which: unknown }).which = realWhich;
  (Bun as unknown as { spawn: unknown }).spawn = realSpawn;
});

/**
 * A manager with a live (fake) claude attached, its version already resolved
 * (so no `claude --version` subprocess is attempted) and its stdout drain
 * stubbed off.
 */
function manager(): any {
  const m = new SessionManager(
    "/tmp/tugcode-model-respawn-" + SID,
    SID,
    "new",
    undefined,
    { sessionsDbPath: null },
  ) as any;
  m.claudeCodeVersion = "2.1.195";
  m.startStdoutDrain = () => {};
  m.claudeProcess = fakeProcess();
  return m;
}

/** The value following `--model` in an argv, or null when the flag is absent. */
function modelFlag(args: string[]): string | null {
  const idx = args.indexOf("--model");
  return idx === -1 ? null : args[idx + 1];
}

describe("buildClaudeArgs --model", () => {
  const base = { pluginDir: "/repo", permissionMode: "default", sessionId: null };

  test("a selector emits --model", () => {
    expect(modelFlag(buildClaudeArgs({ ...base, model: "sonnet" }))).toBe("sonnet");
  });

  test("null omits the flag — the account default needs no selector", () => {
    expect(buildClaudeArgs({ ...base, model: null })).not.toContain("--model");
  });
});

describe("handleModelChange records the selection", () => {
  test("a selector is recorded", () => {
    const m = manager();
    m.handleModelChange("sonnet");
    expect(m.currentModel).toBe("sonnet");
  });

  test("the default selector records as null — it names no particular model", () => {
    const m = manager();
    m.handleModelChange("sonnet");
    m.handleModelChange("default");
    expect(m.currentModel).toBeNull();
  });

  test("a model set before claude is up is still recorded", () => {
    // The record lives above the no-process bail, so a selection made before
    // the first spawn reaches that spawn rather than evaporating.
    const m = manager();
    m.claudeProcess = null;
    m.handleModelChange("fable");
    expect(m.currentModel).toBe("fable");
  });
});

describe("the recorded model reaches every respawn path", () => {
  test("an effort respawn carries both --model and --effort", async () => {
    const m = manager();
    m.handleModelChange("sonnet");
    await m.handleEffortChange("max");

    expect(spawns.length).toBe(1);
    const args = spawns[0];
    expect(modelFlag(args)).toBe("sonnet");
    expect(args[args.indexOf("--effort") + 1]).toBe("max");
  });

  test("a fork carries --model", async () => {
    const m = manager();
    m.handleModelChange("fable");
    await m.handleSessionFork();

    expect(spawns.length).toBe(1);
    expect(spawns[0]).toContain("--fork-session");
    expect(modelFlag(spawns[0])).toBe("fable");
  });

  test("a continue carries --model", async () => {
    const m = manager();
    m.handleModelChange("fable");
    await m.handleSessionContinue();

    expect(spawns.length).toBe(1);
    expect(spawns[0]).toContain("--continue");
    expect(modelFlag(spawns[0])).toBe("fable");
  });

  test("with no model chosen, no path invents a --model flag", async () => {
    const m = manager();
    await m.handleEffortChange("high");
    await m.handleSessionFork();
    await m.handleSessionContinue();

    expect(spawns.length).toBe(3);
    for (const args of spawns) {
      expect(args).not.toContain("--model");
    }
  });

  test("reverting to the account default drops the flag on the next respawn", async () => {
    const m = manager();
    m.handleModelChange("sonnet");
    m.handleModelChange("default");
    await m.handleEffortChange("low");

    expect(spawns.length).toBe(1);
    expect(spawns[0]).not.toContain("--model");
  });
});
