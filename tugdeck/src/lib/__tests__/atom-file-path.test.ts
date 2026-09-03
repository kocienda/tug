import { describe, expect, test } from "bun:test";

import { resolveAtomFilePath } from "../atom-file-path";

describe("resolveAtomFilePath", () => {
  test("joins a mention's project-relative value onto the project root", () => {
    expect(
      resolveAtomFilePath("arc/kbf-mode.md", {
        projectDir: "/Users/tester/src/tugtool",
        cwd: "/Users/tester",
      }),
    ).toBe("/Users/tester/src/tugtool/arc/kbf-mode.md");
  });

  test("falls back to the session cwd when the card has no project binding", () => {
    expect(
      resolveAtomFilePath("docs/plan.md", {
        projectDir: null,
        cwd: "/Users/tester/work",
      }),
    ).toBe("/Users/tester/work/docs/plan.md");
  });

  test("normalizes an absolute value and leaves its target alone", () => {
    expect(
      resolveAtomFilePath("/Users/tester/./src//main.ts", {
        projectDir: "/elsewhere",
        cwd: null,
      }),
    ).toBe("/Users/tester/src/main.ts");
  });

  test("returns the value as written when there is no root to join onto", () => {
    expect(
      resolveAtomFilePath("docs/plan.md", { projectDir: null, cwd: null }),
    ).toBe("docs/plan.md");
  });
});
