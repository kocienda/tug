/**
 * Pure-logic coverage for the path-reference grammar.
 *
 * The grammar is a candidate finder, not a filter — resolution decides
 * what becomes a link. So the interesting column here is no longer "what
 * gets rejected as prose" (nothing does; `and/or` is a candidate exactly
 * like `a/b`, and only the filesystem separates them). It is:
 *
 *  - the shapes this corpus actually produces are all found, including a
 *    bare filename and a path buried inside a longer command line;
 *  - a candidate's reported range covers the path and its citation and
 *    nothing else, since that range becomes the visible link;
 *  - tokens that cannot name a file at all are skipped, so the resolvers
 *    are never asked about a decimal number or a URL.
 */

import { describe, expect, test } from "bun:test";

import {
  detectPathReference,
  scanPathReferences,
} from "../detect-path-reference";

describe("detectPathReference — a span that is entirely one path", () => {
  const accepted: ReadonlyArray<
    [
      string,
      {
        path: string;
        line?: number;
        endLine?: number;
        shape: "path" | "name";
      },
    ]
  > = [
    [
      "tugdeck/src/action-dispatch.ts",
      { path: "tugdeck/src/action-dispatch.ts", shape: "path" },
    ],
    [
      "/Users/kocienda/Mounts/u/src/tugtool/justfile",
      { path: "/Users/kocienda/Mounts/u/src/tugtool/justfile", shape: "path" },
    ],
    ["a/b", { path: "a/b", shape: "path" }],
    ["lib/foo.ts:212", { path: "lib/foo.ts", line: 212, shape: "path" }],
    ["lib/foo.ts:12:5", { path: "lib/foo.ts", line: 12, shape: "path" }],
    // A range is how prose cites a function or a docstring.
    [
      "lib/foo.ts:124-135",
      { path: "lib/foo.ts", line: 124, endLine: 135, shape: "path" },
    ],
    [
      "block-reorder.ts:1-33",
      { path: "block-reorder.ts", line: 1, endLine: 33, shape: "name" },
    ],
    ["  dash/plan.md  ", { path: "dash/plan.md", shape: "path" }],
    // The shape the old grammar threw away, and the one Claude writes most.
    ["tug-button.css", { path: "tug-button.css", shape: "name" }],
    // A directory is a reference like any other; the trailing separator is
    // a spelling, not a different thing, and resolution says which it is.
    ["tugdeck/src/", { path: "tugdeck/src", shape: "path" }],
    ["/Users/kocienda/src/tugtool", { path: "/Users/kocienda/src/tugtool", shape: "path" }],
    ["package.json", { path: "package.json", shape: "name" }],
    ["foo.ts:12", { path: "foo.ts", line: 12, shape: "name" }],
  ];

  for (const [input, expected] of accepted) {
    test(JSON.stringify(input), () => {
      expect(detectPathReference(input)).toEqual(expected);
    });
  }

  const rejected: ReadonlyArray<[string, string]> = [
    ["a url", "https://x.y/z"],
    ["a home-relative path", "~/anything"],
    ["empty", ""],
    ["whitespace only", "   "],
    ["a bare word with no extension", "sometimes"],
    ["a decimal number", "3.14"],
    ["a version", "2.0"],
    ["a sentence, even one containing a path", "see lib/foo.ts for this"],
  ];

  for (const [label, input] of rejected) {
    test(label, () => {
      expect(detectPathReference(input)).toBeNull();
    });
  }
});

describe("scanPathReferences — paths found inside longer text", () => {
  test("a path inside a command line, which is how tool headers write them", () => {
    const text = "bun test tugdeck/src/components/tugways/block-reorder.ts --watch";
    const found = scanPathReferences(text);
    expect(found.map((m) => m.path)).toEqual([
      "tugdeck/src/components/tugways/block-reorder.ts",
    ]);
    const [only] = found;
    expect(text.slice(only.start, only.end)).toBe(
      "tugdeck/src/components/tugways/block-reorder.ts",
    );
  });

  test("bare filenames in prose", () => {
    const found = scanPathReferences(
      "I changed tug-button.css and tug-history-list.css to match.",
    );
    expect(found.map((m) => m.path)).toEqual([
      "tug-button.css",
      "tug-history-list.css",
    ]);
    expect(found.every((m) => m.shape === "name")).toBe(true);
  });

  test("a trailing sentence period stays out of the link", () => {
    const text = "It lives in dash/plan.md.";
    const [only] = scanPathReferences(text);
    expect(only.path).toBe("dash/plan.md");
    expect(text.slice(only.start, only.end)).toBe("dash/plan.md");
  });

  test("wrapping punctuation stays out of the link", () => {
    const text = "the helper (lib/foo.ts:12) does it";
    const [only] = scanPathReferences(text);
    expect(only).toMatchObject({ path: "lib/foo.ts", line: 12 });
    expect(text.slice(only.start, only.end)).toBe("lib/foo.ts:12");
  });

  test("a cited range survives the parentheses around it", () => {
    const text =
      "Model A (/Users/k/src/tugdeck/lens-content.tsx:124-135) wires it";
    const [only] = scanPathReferences(text);
    expect(only).toMatchObject({
      path: "/Users/k/src/tugdeck/lens-content.tsx",
      line: 124,
      endLine: 135,
    });
    expect(text.slice(only.start, only.end)).toBe(
      "/Users/k/src/tugdeck/lens-content.tsx:124-135",
    );
  });

  test("a bare name with a citation keeps both", () => {
    const text = "A caret sits in the container (lens-content.tsx:166).";
    const [only] = scanPathReferences(text);
    expect(only).toMatchObject({ path: "lens-content.tsx", line: 166 });
    expect(text.slice(only.start, only.end)).toBe("lens-content.tsx:166");
  });

  test("a backwards range is not a citation, and its text is not part of the run", () => {
    const text = "lib/foo.ts:135-124";
    const [only] = scanPathReferences(text);
    expect(only.line).toBeUndefined();
    expect(text.slice(only.start, only.end)).toBe("lib/foo.ts");
  });

  test("a citation that cites line zero is not part of the reference", () => {
    const text = "lib/foo.ts:0";
    const [only] = scanPathReferences(text);
    expect(only.line).toBeUndefined();
    expect(text.slice(only.start, only.end)).toBe("lib/foo.ts");
  });

  test("URLs are left to the link kind", () => {
    expect(
      scanPathReferences("see https://example.com/a/b for details"),
    ).toEqual([]);
  });

  test("ranges are reported in order and never overlap", () => {
    const found = scanPathReferences("a/b c/d e/f");
    expect(found.map((m) => m.path)).toEqual(["a/b", "c/d", "e/f"]);
    for (let i = 1; i < found.length; i += 1) {
      expect(found[i].start).toBeGreaterThanOrEqual(found[i - 1].end);
    }
  });
});

describe("prose and code produce the same candidates", () => {
  const found = (text: string) => scanPathReferences(text)[0];

  test("a bare filename mid-sentence is a candidate like any other", () => {
    // No prose license to earn: the resolver is the only gate, so the
    // shape a sentence writes is read exactly as the shape backticks do.
    expect(found("I changed tug-button.css today").path).toBe(
      "tug-button.css",
    );
    expect(found("look in tugdeck/src for it").path).toBe("tugdeck/src");
  });

  test("a line citation is carried through from running text", () => {
    expect(found("see lens-content.tsx:166 there")).toMatchObject({
      path: "lens-content.tsx",
      line: 166,
    });
    expect(found("the docstring (block-reorder.ts:1-33)")).toMatchObject({
      path: "block-reorder.ts",
      line: 1,
      endLine: 33,
    });
  });
});

describe("what the grammar leaves to resolution", () => {
  test("prose shaped like a relative path is a candidate, not a conclusion", () => {
    // Identical in shape to the accepted `a/b`; only the filesystem can
    // tell them apart, which is why nothing is actionable until resolved.
    expect(detectPathReference("and/or")).toEqual({
      path: "and/or",
      shape: "path",
    });
  });
});
