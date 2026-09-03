import { describe, expect, test } from "bun:test";

import {
  encodeProjectDir,
  memoryDestinations,
} from "../memory-destinations";

describe("encodeProjectDir", () => {
  test("replaces every slash with an arc (Claude Code's convention)", () => {
    expect(encodeProjectDir("/Users/kocienda/Mounts/u/src/tugtool")).toBe(
      "-Users-kocienda-Mounts-u-src-tugtool",
    );
  });
});

describe("memoryDestinations", () => {
  test("lists project, user, auto-memory for a known cwd", () => {
    const dests = memoryDestinations("/work/repo");
    expect(dests.map((d) => d.id)).toEqual(["project", "user", "auto"]);
    expect(dests.find((d) => d.id === "project")!.path).toBe("/work/repo/CLAUDE.md");
    expect(dests.find((d) => d.id === "user")!.path).toBe("~/.claude/CLAUDE.md");
    expect(dests.find((d) => d.id === "auto")!.path).toBe(
      "~/.claude/projects/-work-repo/memory",
    );
  });

  test("the auto-memory row is a folder; the others are files", () => {
    const dests = memoryDestinations("/work/repo");
    expect(dests.find((d) => d.id === "auto")!.kind).toBe("folder");
    expect(dests.find((d) => d.id === "project")!.kind).toBe("file");
    expect(dests.find((d) => d.id === "user")!.kind).toBe("file");
  });

  test("only user memory survives when the cwd is unknown", () => {
    expect(memoryDestinations(null).map((d) => d.id)).toEqual(["user"]);
    expect(memoryDestinations("").map((d) => d.id)).toEqual(["user"]);
  });
});
