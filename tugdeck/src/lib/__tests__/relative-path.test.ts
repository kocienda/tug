/**
 * relative-path — display shortening against a workspace root.
 *
 * The rule that matters is the refusal: a path that does not sit under the
 * root comes back whole. Half-stripping one would draw a row that reads like
 * a workspace file and opens something else.
 */
import { describe, expect, it } from "bun:test";

import { pathRelativeTo } from "@/lib/relative-path";

describe("pathRelativeTo", () => {
  it("drops the root's prefix", () => {
    expect(pathRelativeTo("/proj/src/a.ts", "/proj")).toBe("src/a.ts");
  });

  it("tolerates a trailing separator on the root", () => {
    expect(pathRelativeTo("/proj/src/a.ts", "/proj/")).toBe("src/a.ts");
  });

  it("leaves a path from outside the root alone", () => {
    expect(pathRelativeTo("/elsewhere/a.ts", "/proj")).toBe("/elsewhere/a.ts");
  });

  it("does not treat a sibling with a shared prefix as inside", () => {
    // `/project-papers` starts with `/proj`, and is not under it.
    expect(pathRelativeTo("/project-papers/a.ts", "/proj")).toBe(
      "/project-papers/a.ts",
    );
  });

  it("leaves the root itself whole — there is no remainder to show", () => {
    expect(pathRelativeTo("/proj", "/proj")).toBe("/proj");
  });

  it("passes everything through when there is no root", () => {
    expect(pathRelativeTo("/proj/src/a.ts", "")).toBe("/proj/src/a.ts");
  });
});
