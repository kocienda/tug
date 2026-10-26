/**
 * masthead-path — a masthead path written relative to its open project.
 *
 * The rules that matter: the deepest containing project wins, a file at a
 * project's top level keeps the project's name so the line is not a copy of
 * the title, a file in no open project comes back whole, and the comparison is
 * made on the server's canonical spelling of the file's directory.
 */
import { describe, expect, it } from "bun:test";

import { projectRelativePath } from "@/lib/masthead-path";

const identity = (p: string): string => p;

describe("projectRelativePath", () => {
  it("writes a file under a project relative to it", () => {
    expect(
      projectRelativePath("/src/tug/tugdeck/src/main.tsx", ["/src/tug"], identity),
    ).toBe("tugdeck/src/main.tsx");
  });

  it("keeps the project's name for a file at its top level", () => {
    expect(projectRelativePath("/src/tug/README.md", ["/src/tug"], identity)).toBe(
      "tug/README.md",
    );
  });

  it("leaves a file in no open project whole", () => {
    expect(projectRelativePath("/etc/hosts", ["/src/tug"], identity)).toBe("/etc/hosts");
    expect(projectRelativePath("/src/tugboat/a/b.ts", ["/src/tug"], identity)).toBe(
      "/src/tugboat/a/b.ts",
    );
  });

  it("takes the deepest of nested projects, whatever their order", () => {
    const roots = ["/src/tug", "/src/tug/vendor/lib"];
    expect(projectRelativePath("/src/tug/vendor/lib/x/y.ts", roots, identity)).toBe("x/y.ts");
    expect(
      projectRelativePath("/src/tug/vendor/lib/x/y.ts", [...roots].reverse(), identity),
    ).toBe("x/y.ts");
  });

  it("compares on the canonical spelling of the file's directory", () => {
    const canonicalOf = (p: string): string => p.replace(/^\/u\//, "/Users/me/Mounts/u/");
    expect(
      projectRelativePath(
        "/u/src/tug/tugdeck/index.html",
        ["/Users/me/Mounts/u/src/tug"],
        canonicalOf,
      ),
    ).toBe("tugdeck/index.html");
  });

  it("tolerates a trailing separator on a root and returns no root's own path", () => {
    expect(projectRelativePath("/src/tug/a/b.ts", ["/src/tug/"], identity)).toBe("a/b.ts");
    expect(projectRelativePath("/src/tug", ["/src/tug"], identity)).toBe("/src/tug");
  });

  it("returns a relative or empty input unchanged", () => {
    expect(projectRelativePath("a/b.ts", ["/src/tug"], identity)).toBe("a/b.ts");
    expect(projectRelativePath("", ["/src/tug"], identity)).toBe("");
  });
});
