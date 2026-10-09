import { describe, expect, test } from "bun:test";

import { displayPath, memoryDestinations } from "../memory-destinations";
import { scopeOptions } from "@/components/tugways/cards/permission-rules-editor";

/** Host facts as tugcast publishes them for a default config directory. */
const DEFAULT = { home: "/Users/me", claudeHome: "/Users/me/.claude" };
/** Host facts for a `CLAUDE_CONFIG_DIR` outside the home directory. */
const MOVED = { home: "/Users/me", claudeHome: "/cfg/claude" };

describe("memoryDestinations", () => {
  test("lists project, user, auto-memory for a known cwd", () => {
    const dests = memoryDestinations("/work/repo", DEFAULT);
    expect(dests.map((d) => d.id)).toEqual(["project", "user", "auto"]);
    expect(dests.find((d) => d.id === "project")!.path).toBe("/work/repo/CLAUDE.md");
    expect(dests.find((d) => d.id === "user")!.path).toBe("/Users/me/.claude/CLAUDE.md");
    expect(dests.find((d) => d.id === "user")!.detail).toBe("Saved in ~/.claude/CLAUDE.md");
    expect(dests.find((d) => d.id === "auto")!.path).toBe(
      "/Users/me/.claude/projects/-work-repo/memory",
    );
  });

  test("a moved config directory shows its real path", () => {
    const dests = memoryDestinations("/work/repo", MOVED);
    expect(dests.find((d) => d.id === "user")!.path).toBe("/cfg/claude/CLAUDE.md");
    expect(dests.find((d) => d.id === "user")!.detail).toBe("Saved in /cfg/claude/CLAUDE.md");
    expect(dests.find((d) => d.id === "auto")!.path).toBe(
      "/cfg/claude/projects/-work-repo/memory",
    );
  });

  test("the auto-memory row is a folder; the others are files", () => {
    const dests = memoryDestinations("/work/repo", DEFAULT);
    expect(dests.find((d) => d.id === "auto")!.kind).toBe("folder");
    expect(dests.find((d) => d.id === "project")!.kind).toBe("file");
    expect(dests.find((d) => d.id === "user")!.kind).toBe("file");
  });

  test("only user memory survives when the cwd is unknown", () => {
    expect(memoryDestinations(null, DEFAULT).map((d) => d.id)).toEqual(["user"]);
    expect(memoryDestinations("", DEFAULT).map((d) => d.id)).toEqual(["user"]);
  });

  test("the config-directory rows wait for the host facts", () => {
    expect(memoryDestinations("/work/repo", null).map((d) => d.id)).toEqual(["project"]);
    expect(
      memoryDestinations("/work/repo", { home: "/Users/me", claudeHome: "" }).map((d) => d.id),
    ).toEqual(["project"]);
  });
});

describe("displayPath", () => {
  test("writes a path under home with ~", () => {
    expect(displayPath("/Users/me/.claude/CLAUDE.md", "/Users/me")).toBe("~/.claude/CLAUDE.md");
    expect(displayPath("/Users/me", "/Users/me")).toBe("~");
  });

  test("leaves a path outside home, or a sibling sharing its prefix, as is", () => {
    expect(displayPath("/cfg/claude/CLAUDE.md", "/Users/me")).toBe("/cfg/claude/CLAUDE.md");
    expect(displayPath("/Users/meg/x", "/Users/me")).toBe("/Users/meg/x");
    expect(displayPath("/a/b", "")).toBe("/a/b");
  });
});

describe("permission-rules scope options", () => {
  const user = (facts: Parameters<typeof scopeOptions>[0]) =>
    scopeOptions(facts).find((o) => o.scope === "user")!.description;

  test("the user scope names the settings file in the config directory", () => {
    expect(user(DEFAULT)).toBe("Saved at ~/.claude/settings.json");
    expect(user(MOVED)).toBe("Saved at /cfg/claude/settings.json");
  });

  test("before the host facts arrive, the user scope names no path", () => {
    expect(user(null)).toBe("Saved in your user settings");
  });

  test("the scopes keep the terminal's order", () => {
    expect(scopeOptions(DEFAULT).map((o) => o.scope)).toEqual(["local", "project", "user"]);
  });
});
