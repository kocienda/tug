/**
 * `argsFilePath` — which argument of a slash command names a file.
 *
 * The menu's two run rows dim when the command's arguments name a file the
 * resolver looked for and did not find, so what counts as naming a file
 * decides which commands can be dimmed at all. A rule of its own here would
 * drift from the grammar the same transcript paints paths with; these pin
 * that it is the annotator's grammar being asked, and that the shapes which
 * merely carry a slash are not paths.
 */

import { describe, it, expect } from "bun:test";

import { argsFilePath } from "@/components/tugways/use-annotation-menu";

describe("argsFilePath", () => {
  it("finds the mention the brief hand-off writes", () => {
    expect(argsFilePath("a-thing @briefs/a-thing-brief.md")).toBe(
      "briefs/a-thing-brief.md",
    );
  });

  it("finds a path written without the mention marker", () => {
    expect(argsFilePath("a-thing briefs/a-thing-brief.md")).toBe(
      "briefs/a-thing-brief.md",
    );
  });

  it("finds an absolute path", () => {
    expect(argsFilePath("/tmp/notes/plan.md")).toBe("/tmp/notes/plan.md");
  });

  it("says nothing about arguments that name no file", () => {
    expect(argsFilePath("")).toBeNull();
    expect(argsFilePath("ultra")).toBeNull();
    expect(argsFilePath("a-thing")).toBeNull();
  });

  it("a URL is not a path — dimming a run over one would be a false reason", () => {
    expect(argsFilePath("https://example.com/a/b")).toBeNull();
  });

  it("a slashed argument that is not a path is not one", () => {
    expect(argsFilePath("vendor/name")).toBeNull();
    expect(argsFilePath("~/notes/plan.md")).toBeNull();
  });

  it("the mention marker declares a file the shape alone would not", () => {
    expect(argsFilePath("@vendor/name")).toBe("vendor/name");
  });

  it("takes the first path when the arguments carry several", () => {
    expect(argsFilePath("@briefs/one.md @briefs/two.md")).toBe("briefs/one.md");
  });

  it("leaves a trailing line citation off the path it asks about", () => {
    expect(argsFilePath("@src/thing.ts:14")).toBe("src/thing.ts");
  });
});
