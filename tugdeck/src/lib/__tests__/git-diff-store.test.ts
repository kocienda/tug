/**
 * `git-diff-store` — pure-logic tests for the `/diff` presentation
 * mapping ([#step-10b]): stat / status / summary formatting and the
 * GIT_DIFF payload parse. The store's wire I/O (connection send,
 * FeedStore subscribe) is exercised by the app-test; this file pins the
 * pure helpers that the accordion renders from.
 */

import { describe, expect, test } from "bun:test";

import {
  type DiffDescriptor,
  type GitDiffFile,
  diffDescriptorKey,
  diffStatusLabel,
  diffStatusLetter,
  diffSummaryLine,
  fileStatLabel,
  formatDiffStat,
  parseGitDiffPayload,
} from "../git-diff-store";

function file(over: Partial<GitDiffFile>): GitDiffFile {
  return {
    path: "src/main.rs",
    status: "modified",
    added: 0,
    removed: 0,
    binary: false,
    unified: "",
    ...over,
  };
}

describe("formatDiffStat", () => {
  test("uses a true minus sign", () => {
    expect(formatDiffStat(10, 2)).toBe("+10 −2");
    expect(formatDiffStat(0, 0)).toBe("+0 −0");
  });
});

describe("diffStatusLabel / diffStatusLetter", () => {
  test("labels", () => {
    expect(diffStatusLabel("added")).toBe("Added");
    expect(diffStatusLabel("modified")).toBe("Modified");
    expect(diffStatusLabel("deleted")).toBe("Deleted");
    expect(diffStatusLabel("renamed")).toBe("Renamed");
  });
  test("letters (git porcelain style)", () => {
    expect(diffStatusLetter("added")).toBe("A");
    expect(diffStatusLetter("modified")).toBe("M");
    expect(diffStatusLetter("deleted")).toBe("D");
    expect(diffStatusLetter("renamed")).toBe("R");
  });
});

describe("fileStatLabel", () => {
  test("text file shows the +N −M counts", () => {
    expect(fileStatLabel(file({ added: 3, removed: 1 }))).toBe("+3 −1");
  });
  test("binary file shows 'binary' (no counts)", () => {
    expect(fileStatLabel(file({ binary: true, added: 0, removed: 0 }))).toBe(
      "binary",
    );
  });
});

describe("diffSummaryLine", () => {
  // The sentence is the shared one (`lib/commit-format`), so the header over
  // a diff and the tip over the sha that landed it read identically.
  test("pluralizes and appends the totals", () => {
    expect(diffSummaryLine(3, 12, 5)).toBe("3 files changed, +12 −5");
  });
  test("singular for one file", () => {
    expect(diffSummaryLine(1, 10, 2)).toBe("1 file changed, +10 −2");
  });
  test("empty tree", () => {
    expect(diffSummaryLine(0, 0, 0)).toBe("No uncommitted changes");
  });
});

describe("parseGitDiffPayload", () => {
  test("parses a well-formed payload", () => {
    const parsed = parseGitDiffPayload({
      request_id: "gd-1",
      workspace_key: "/work/repo",
      base: "HEAD",
      file_count: 1,
      total_added: 2,
      total_removed: 1,
      files: [file({ added: 2, removed: 1 })],
    });
    expect(parsed).not.toBeNull();
    expect(parsed?.request_id).toBe("gd-1");
    expect(parsed?.files).toHaveLength(1);
    expect(parsed?.base).toBe("HEAD");
  });

  test("preserves file order", () => {
    const parsed = parseGitDiffPayload({
      request_id: "gd-2",
      files: [
        file({ path: "a.rs" }),
        file({ path: "b.rs" }),
        file({ path: "c.rs" }),
      ],
    });
    expect(parsed?.files.map((f) => f.path)).toEqual(["a.rs", "b.rs", "c.rs"]);
  });

  test("defaults base/totals/no_repo when absent, file_count falls back to files.length", () => {
    const parsed = parseGitDiffPayload({
      request_id: "gd-3",
      files: [file({}), file({})],
    });
    expect(parsed?.base).toBe("HEAD");
    expect(parsed?.total_added).toBe(0);
    expect(parsed?.file_count).toBe(2);
    expect(parsed?.no_repo).toBe(false);
  });

  test("carries no_repo when the project dir is not a git repo", () => {
    const parsed = parseGitDiffPayload({
      request_id: "gd-4",
      no_repo: true,
      file_count: 0,
      files: [],
    });
    expect(parsed?.no_repo).toBe(true);
    expect(parsed?.files).toHaveLength(0);
  });

  test("rejects malformed payloads", () => {
    expect(parseGitDiffPayload(null)).toBeNull();
    expect(parseGitDiffPayload("nope")).toBeNull();
    expect(parseGitDiffPayload({ files: [] })).toBeNull(); // no request_id
    expect(parseGitDiffPayload({ request_id: "x" })).toBeNull(); // no files
  });
});

describe("diffDescriptorKey", () => {
  test("range keys are stable and distinct per (root, worktree, base, branch)", () => {
    const a: DiffDescriptor = {
      kind: "range",
      root: "/repo",
      worktree: ".tug/worktrees/demo",
      base: "main",
      branch: "tugarc/demo",
    };
    expect(diffDescriptorKey(a)).toBe(
      "range:/repo:.tug/worktrees/demo:main:tugarc/demo",
    );
    const b: DiffDescriptor = { ...a, branch: "tugarc/other" };
    expect(diffDescriptorKey(b)).not.toBe(diffDescriptorKey(a));
  });

  test("head keys sort paths so order does not perturb identity", () => {
    const a: DiffDescriptor = { kind: "head", root: "/repo", paths: ["b.ts", "a.ts"] };
    const b: DiffDescriptor = { kind: "head", root: "/repo", paths: ["a.ts", "b.ts"] };
    expect(diffDescriptorKey(a)).toBe(diffDescriptorKey(b));
    expect(diffDescriptorKey(a)).toBe("head:/repo:a.ts\nb.ts");
  });

  test("whole-tree head key omits paths", () => {
    expect(diffDescriptorKey({ kind: "head" })).toBe("head::");
  });

  test("commit keys carry the sha and sort paths", () => {
    const a: DiffDescriptor = {
      kind: "commit",
      root: "/repo",
      sha: "abc123",
      paths: ["b.ts", "a.ts"],
    };
    const b: DiffDescriptor = { ...a, paths: ["a.ts", "b.ts"] };
    expect(diffDescriptorKey(a)).toBe(diffDescriptorKey(b));
    expect(diffDescriptorKey(a)).toBe("commit:/repo:abc123:a.ts\nb.ts");
    const other: DiffDescriptor = { ...a, sha: "def456" };
    expect(diffDescriptorKey(other)).not.toBe(diffDescriptorKey(a));
  });
});
