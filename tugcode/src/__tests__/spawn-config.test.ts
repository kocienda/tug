import { describe, test, expect } from "bun:test";
import { buildClaudeArgs } from "../spawn-config.ts";

// Reusable default config
const defaultConfig = {
  pluginDir: "/repo",
  permissionMode: "acceptEdits",
  sessionId: null,
};

describe("buildClaudeArgs", () => {
  test("default config does NOT include -p", () => {
    const args = buildClaudeArgs(defaultConfig);
    expect(args).not.toContain("-p");
  });

  test("includes --permission-prompt-tool stdio", () => {
    const args = buildClaudeArgs(defaultConfig);
    const idx = args.indexOf("--permission-prompt-tool");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe("stdio");
  });

  test("includes --replay-user-messages", () => {
    const args = buildClaudeArgs(defaultConfig);
    expect(args).toContain("--replay-user-messages");
  });

  test("registers the Tug data root as a read dir via --add-dir", () => {
    const args = buildClaudeArgs(defaultConfig);
    const idx = args.indexOf("--add-dir");
    expect(idx).toBeGreaterThan(-1);
    // The registered path is the Tug app-data root — one entry covering every
    // per-project runtime-state subdir.
    expect(args[idx + 1].endsWith("/Tug")).toBe(true);
  });

  test("carries the nudge, then every plugin prompt in order, in the one --append-system-prompt", () => {
    const args = buildClaudeArgs({
      ...defaultConfig,
      pluginPrompts: ["GRAMMAR", "CONTRACT", "PROSE", "QUESTIONS"],
    });
    // One flag, not two: the option is a string and repeating it is not
    // documented to concatenate, so every text rides one value.
    expect(args.filter((a) => a === "--append-system-prompt").length).toBe(1);
    const value = args[args.indexOf("--append-system-prompt") + 1];
    expect(value.startsWith("The user is reading this conversation in Dev")).toBe(true);
    expect(
      value.endsWith("the next step you're about to take).\n\nGRAMMAR\n\nCONTRACT\n\nPROSE\n\nQUESTIONS"),
    ).toBe(true);
  });

  test("with no plugin prompt the appended prompt is the nudge alone, byte for byte", () => {
    for (const config of [defaultConfig, { ...defaultConfig, pluginPrompts: [] }]) {
      const args = buildClaudeArgs(config);
      expect(args.filter((a) => a === "--append-system-prompt").length).toBe(1);
      const value = args[args.indexOf("--append-system-prompt") + 1];
      expect(value.startsWith("The user is reading this conversation in Dev")).toBe(true);
      expect(value.endsWith("the next step you're about to take).")).toBe(true);
    }
  });

  test("one absent plugin prompt leaves the others in place", () => {
    const args = buildClaudeArgs({ ...defaultConfig, pluginPrompts: ["CONTRACT"] });
    const value = args[args.indexOf("--append-system-prompt") + 1];
    expect(value.endsWith("the next step you're about to take).\n\nCONTRACT")).toBe(true);
  });

  test("with sessionId includes --resume", () => {
    const args = buildClaudeArgs({ ...defaultConfig, sessionId: "abc" });
    const idx = args.indexOf("--resume");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe("abc");
  });

  test("emits a --add-dir for each additional directory (/add-dir)", () => {
    const args = buildClaudeArgs({
      ...defaultConfig,
      additionalDirectories: ["/Users/me/Desktop/a", "/Users/me/b"],
    });
    // The Tug data root --add-dir is always present; the two extra dirs add two
    // more --add-dir pairs.
    const addDirCount = args.filter((a) => a === "--add-dir").length;
    expect(addDirCount).toBe(3);
    expect(args).toContain("/Users/me/Desktop/a");
    expect(args).toContain("/Users/me/b");
  });

  test("omits extra --add-dir when no additional directories", () => {
    const args = buildClaudeArgs(defaultConfig);
    // Only the Tug data root.
    expect(args.filter((a) => a === "--add-dir").length).toBe(1);
  });

  test("with continue: true includes --continue", () => {
    const args = buildClaudeArgs({ ...defaultConfig, continue: true });
    expect(args).toContain("--continue");
  });

  test("with forkSession: true and sessionId includes --fork-session", () => {
    const args = buildClaudeArgs({ ...defaultConfig, sessionId: "sess-1", forkSession: true });
    expect(args).toContain("--fork-session");
  });

  test("with sessionIdOverride includes --session-id", () => {
    const args = buildClaudeArgs({ ...defaultConfig, sessionIdOverride: "override-id-xyz" });
    const idx = args.indexOf("--session-id");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe("override-id-xyz");
  });

  test("throws if both sessionId and continue are set", () => {
    expect(() =>
      buildClaudeArgs({ ...defaultConfig, sessionId: "sess-abc", continue: true })
    ).toThrow("Only one of sessionId, continue, or sessionIdOverride may be set");
  });

  test("throws if both sessionId and sessionIdOverride are set", () => {
    expect(() =>
      buildClaudeArgs({ ...defaultConfig, sessionId: "sess-abc", sessionIdOverride: "override-xyz" })
    ).toThrow("Only one of sessionId, continue, or sessionIdOverride may be set");
  });

  test("a fork that claims its id carries each session flag exactly once", () => {
    const args = buildClaudeArgs({
      ...defaultConfig,
      sessionId: "parent-id",
      forkSession: true,
      sessionIdOverride: "new-id",
    });
    expect(args.filter((a) => a === "--resume")).toHaveLength(1);
    expect(args.filter((a) => a === "--fork-session")).toHaveLength(1);
    expect(args.filter((a) => a === "--session-id")).toHaveLength(1);
    expect(args[args.indexOf("--resume") + 1]).toBe("parent-id");
    expect(args[args.indexOf("--session-id") + 1]).toBe("new-id");
  });

  test("sessionId and sessionIdOverride without forkSession still throw", () => {
    expect(() =>
      buildClaudeArgs({ ...defaultConfig, sessionId: "a", forkSession: false, sessionIdOverride: "b" })
    ).toThrow("Only one of sessionId, continue, or sessionIdOverride may be set");
  });

  test("continue and sessionIdOverride with forkSession still throw", () => {
    expect(() =>
      buildClaudeArgs({ ...defaultConfig, continue: true, forkSession: true, sessionIdOverride: "b" })
    ).toThrow("Only one of sessionId, continue, or sessionIdOverride may be set");
  });

  test("throws if forkSession without sessionId or continue", () => {
    expect(() =>
      buildClaudeArgs({ ...defaultConfig, forkSession: true })
    ).toThrow("forkSession requires either sessionId or continue to be set");
  });

  test("forkSession with continue does not throw", () => {
    expect(() =>
      buildClaudeArgs({ ...defaultConfig, continue: true, forkSession: true })
    ).not.toThrow();
  });

  test("all required base flags are present", () => {
    const args = buildClaudeArgs(defaultConfig);
    expect(args).toContain("--output-format");
    expect(args[args.indexOf("--output-format") + 1]).toBe("stream-json");
    expect(args).toContain("--input-format");
    expect(args[args.indexOf("--input-format") + 1]).toBe("stream-json");
    expect(args).toContain("--verbose");
    expect(args).toContain("--include-partial-messages");
    expect(args).toContain("--replay-user-messages");
  });

  test("includes --append-system-prompt with Dev rendering nudge", () => {
    const args = buildClaudeArgs(defaultConfig);
    const idx = args.indexOf("--append-system-prompt");
    expect(idx).toBeGreaterThan(-1);
    const nudge = args[idx + 1];
    expect(nudge).toBeDefined();
    // The nudge is the contract between Dev's structured tool-call
    // rendering and the model's "should I restate this?" judgment —
    // pin both the surface description and the carve-out for analysis
    // so a future edit can't quietly drop one or the other.
    expect(nudge).toContain("Dev");
    expect(nudge).toContain("tool call");
    expect(nudge).toContain("analysis");
    // Summary-shaped tools (WebFetch / Read) get an extra-force
    // carve-out because their result IS the model-readable rendering
    // of the source — restating those bullets is pure duplication.
    expect(nudge).toContain("WebFetch");
    expect(nudge).toContain("Read");
  });

  test("config values are correctly mapped to CLI flags", () => {
    const config = {
      pluginDir: "/my/plugin/dir",
      model: "claude-haiku-3-5",
      permissionMode: "bypassPermissions",
      sessionId: null,
    };
    const args = buildClaudeArgs(config);
    expect(args[args.indexOf("--plugin-dir") + 1]).toBe("/my/plugin/dir");
    expect(args[args.indexOf("--model") + 1]).toBe("claude-haiku-3-5");
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("bypassPermissions");
  });

  test("omits --model when model is not set, letting the CLI use its default", () => {
    const args = buildClaudeArgs(defaultConfig);
    expect(args).not.toContain("--model");
  });
});

describe("buildClaudeArgs session commands", () => {
  test("buildClaudeArgs with continue + forkSession produces --continue --fork-session", () => {
    const args = buildClaudeArgs({
      pluginDir: "/repo",
      model: "claude-opus-4-6",
      permissionMode: "acceptEdits",
      sessionId: null,
      continue: true,
      forkSession: true,
    });
    expect(args).toContain("--continue");
    expect(args).toContain("--fork-session");
    expect(args).not.toContain("--resume");
  });

  test("buildClaudeArgs with continue only produces --continue without --fork-session", () => {
    const args = buildClaudeArgs({
      pluginDir: "/repo",
      model: "claude-opus-4-6",
      permissionMode: "acceptEdits",
      sessionId: null,
      continue: true,
    });
    expect(args).toContain("--continue");
    expect(args).not.toContain("--fork-session");
    expect(args).not.toContain("--resume");
  });

  test("session commands compose claude args without --resume for the fresh path", () => {
    // handleSessionFork uses continue: true, forkSession: true.
    const forkArgs = buildClaudeArgs({
      pluginDir: "/repo",
      permissionMode: "acceptEdits", sessionId: null,
      continue: true, forkSession: true,
    });
    expect(forkArgs).toContain("--continue");
    expect(forkArgs).toContain("--fork-session");

    // handleSessionContinue uses continue: true only.
    const continueArgs = buildClaudeArgs({
      pluginDir: "/repo",
      permissionMode: "acceptEdits", sessionId: null,
      continue: true,
    });
    expect(continueArgs).toContain("--continue");
    expect(continueArgs).not.toContain("--fork-session");

    // handleNewSession uses no session flags.
    const newArgs = buildClaudeArgs({
      pluginDir: "/repo",
      permissionMode: "acceptEdits", sessionId: null,
    });
    expect(newArgs).not.toContain("--continue");
    expect(newArgs).not.toContain("--fork-session");
    expect(newArgs).not.toContain("--resume");
  });
});
