/**
 * What a settled tool call claims about the filesystem.
 *
 * The claim is what the path resolver's third door rests on, so the bar here
 * is not "does it find paths" but "does it find only the paths that landed":
 * an errored write claims nothing, and a `deleted` receipt op names a file
 * that is now gone.
 */

import { describe, expect, test } from "bun:test";

import { receiptPaths, writtenPaths } from "../written-paths";

const BRIEF = "/repo/briefs/grab-dots-brief.md";

describe("a writing tool's own input names the file it wrote", () => {
  test("a Write that returned names its file_path", () => {
    expect(
      writtenPaths("Write", { file_path: BRIEF }, "File created", false),
    ).toEqual([BRIEF]);
  });

  test("an Edit and a MultiEdit are read the same way", () => {
    expect(writtenPaths("Edit", { file_path: BRIEF }, "done", false)).toEqual([
      BRIEF,
    ]);
    expect(
      writtenPaths("MultiEdit", { file_path: BRIEF }, "done", false),
    ).toEqual([BRIEF]);
  });

  test("an errored write claims nothing — the tool refuses rather than half-writes", () => {
    expect(
      writtenPaths("Write", { file_path: BRIEF }, "permission denied", true),
    ).toEqual([]);
  });

  test("a Read names a path and wrote nothing, so it says nothing", () => {
    expect(writtenPaths("Read", { file_path: BRIEF }, "…", false)).toEqual([]);
  });

  test("an input with no file_path is not guessed at", () => {
    expect(writtenPaths("Write", { path: BRIEF }, "done", false)).toEqual([]);
    expect(writtenPaths("Write", null, "done", false)).toEqual([]);
  });
});

describe("a TUG-FILE-RECEIPT names every file its verb moved", () => {
  const receipt = (ops: unknown[]) =>
    `TUG-FILE-RECEIPT: ${JSON.stringify({ ops })}`;

  test("created, modified and renamed all leave a file standing", () => {
    const output = receipt([
      { op: "created", path: "/repo/a.ts" },
      { op: "modified", path: "/repo/b.ts", hunks: ["abc"] },
      { op: "renamed", path: "/repo/d.ts", orig_path: "/repo/c.ts" },
    ]);
    expect(receiptPaths(output)).toEqual([
      "/repo/a.ts",
      "/repo/b.ts",
      "/repo/d.ts",
    ]);
  });

  test("a deleted op names a path that is gone, and is never confirmed", () => {
    expect(receiptPaths(receipt([{ op: "deleted", path: "/repo/a.ts" }]))).toEqual(
      [],
    );
  });

  test("a renamed op says nothing about the origin it left", () => {
    const paths = receiptPaths(
      receipt([{ op: "renamed", path: "/repo/new.md", orig_path: "/repo/old.md" }]),
    );
    expect(paths).toEqual(["/repo/new.md"]);
  });

  test("a receipt is found among the command's own output", () => {
    const output = [
      "--- a/repo/a.ts",
      "+++ b/repo/a.ts",
      receipt([{ op: "modified", path: "/repo/a.ts" }]),
    ].join("\n");
    expect(receiptPaths(output)).toEqual(["/repo/a.ts"]);
  });

  test("several receipts on one result are all read", () => {
    const output = [
      receipt([{ op: "modified", path: "/repo/a.ts" }]),
      "…",
      receipt([{ op: "created", path: "/repo/b.ts" }]),
    ].join("\n");
    expect(receiptPaths(output)).toEqual(["/repo/a.ts", "/repo/b.ts"]);
  });

  test("a line that does not parse costs the rest of the result nothing", () => {
    const output = [
      "TUG-FILE-RECEIPT: {not json",
      receipt([{ op: "created", path: "/repo/b.ts" }]),
    ].join("\n");
    expect(receiptPaths(output)).toEqual(["/repo/b.ts"]);
  });

  test("output with no receipt in it claims nothing", () => {
    expect(receiptPaths("ok\n2 files changed\n")).toEqual([]);
  });

  test("a shell result reaches the receipt reader through writtenPaths", () => {
    const output = receipt([{ op: "created", path: BRIEF }]);
    expect(writtenPaths("Bash", { command: "tugtool file edit" }, output, false))
      .toEqual([BRIEF]);
  });

  test("an errored shell result claims nothing, whatever it printed", () => {
    const output = receipt([{ op: "created", path: BRIEF }]);
    expect(writtenPaths("Bash", {}, output, true)).toEqual([]);
  });

  test("a non-string result is nothing to read", () => {
    expect(writtenPaths("Bash", {}, { ops: [] }, false)).toEqual([]);
  });
});
