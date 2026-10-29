import { describe, expect, test } from "bun:test";

import { documentDisplayPath, foldReceiptText } from "@/lib/arc-join-fold";

describe("documentDisplayPath", () => {
  test("a path under the checkout reads relative to it", () => {
    expect(documentDisplayPath("/u/src/tug/.tug/arcs/x/brief.md", "/u/src/tug")).toBe(
      ".tug/arcs/x/brief.md",
    );
  });

  test("a path outside the checkout keeps its full spelling", () => {
    expect(documentDisplayPath("/elsewhere/.tug/arcs/x/plan.md", "/u/src/tug")).toBe(
      "/elsewhere/.tug/arcs/x/plan.md",
    );
    // A sibling whose name merely begins with the root's is not under it.
    expect(documentDisplayPath("/u/src/tugdeck/plan.md", "/u/src/tug")).toBe(
      "/u/src/tugdeck/plan.md",
    );
  });

  test("a trailing slash on the root is tolerated", () => {
    expect(documentDisplayPath("/u/src/tug/.tug/arcs/x/tasks.md", "/u/src/tug/")).toBe(
      ".tug/arcs/x/tasks.md",
    );
  });

  test("no root shows the path whole", () => {
    expect(documentDisplayPath("/u/src/tug/brief.md", undefined)).toBe("/u/src/tug/brief.md");
    expect(documentDisplayPath("/u/src/tug/brief.md", "")).toBe("/u/src/tug/brief.md");
  });
});

describe("foldReceiptText", () => {
  test("one folded path held by another session names the holder", () => {
    const text = foldReceiptText({
      seq: 4,
      commit: "abc1234def",
      base: "main",
      folded: ["src/a.ts"],
      folded_from: { "src/a.ts": "curly-apple" },
    });
    expect(text.title).toBe("curly-apple's edit to src/a.ts is now a commit on main");
    expect(text.sentence).toContain("Keep leaves the commit on main");
    expect(text.sentence).toContain("Undo takes it back off main");
    expect(text.sentence).toContain("blocks the join again");
  });

  test("one folded path of the user's own says it is theirs", () => {
    const text = foldReceiptText({ seq: 1, commit: "abc1234", base: "main", folded: ["Justfile"] });
    expect(text.title).toBe("Your edit to Justfile is now a commit on main");
    expect(text.sentence).toContain("returns the edit uncommitted");
  });

  test("several folded paths are counted", () => {
    const text = foldReceiptText({
      seq: 2,
      commit: "abc1234",
      base: "dev",
      folded: ["a", "b", "c"],
      folded_from: { a: "odd-kiln" },
    });
    expect(text.title).toBe("Committed 3 files of base work on dev");
    expect(text.sentence).toContain("returns the edits uncommitted");
  });

  test("a fold that only dropped copies says so, and Undo restores them", () => {
    expect(foldReceiptText({ seq: 3, base: "main", dropped: ["x"] }).title).toBe(
      "Dropped 1 identical file",
    );
    const text = foldReceiptText({ seq: 3, base: "main", dropped: ["x", "y"] });
    expect(text.title).toBe("Dropped 2 identical files");
    expect(text.sentence).toContain("Undo restores the dropped copies");
  });
});
