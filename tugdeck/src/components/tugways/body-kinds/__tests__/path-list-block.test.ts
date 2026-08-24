/**
 * Pure-logic tests for `PathListBlock`'s exported helpers.
 *
 * `PathListBlock` is decoration over composition (`TugListView` in
 * `inline` mode + a `[icon] MiddleEllipsisPath` row cell) — its
 * behaviour *is* these pure helpers:
 *
 *  - `sortPaths` — the `found` / `name` sort modes; `found` never
 *    aliases the input, `name` is case-insensitive + numeric-aware.
 *  - `iconKindForPath` — extension → icon family classification.
 *  - `composePathCountLabel` / `composeTruncationLabel` — the
 *    standalone-header annotations.
 *
 * Path *truncation* is delegated to the shared, CSS-driven
 * `MiddleEllipsisPath` (no JS-side, width-blind segment trimming), so
 * there is nothing path-shortening to pin here.
 *
 * No DOM: per the project's testing policy these are `bun:test`
 * pure-logic assertions.
 */

import { describe, expect, test } from "bun:test";

import {
  composePathCountLabel,
  composeTruncationLabel,
  iconKindForPath,
  sortPaths,
} from "../path-list-block";

// ---------------------------------------------------------------------------
// sortPaths
// ---------------------------------------------------------------------------

describe("sortPaths", () => {
  const FOUND = ["src/zeta.ts", "src/Alpha.ts", "src/beta10.ts", "src/beta2.ts"];

  test("found mode preserves producer order", () => {
    expect(sortPaths(FOUND, "found")).toEqual(FOUND);
  });

  test("found mode returns a fresh array — never aliases the input", () => {
    const result = sortPaths(FOUND, "found");
    expect(result).not.toBe(FOUND);
  });

  test("name mode sorts case-insensitively and numeric-aware", () => {
    expect(sortPaths(FOUND, "name")).toEqual([
      "src/Alpha.ts",
      "src/beta2.ts",
      "src/beta10.ts",
      "src/zeta.ts",
    ]);
  });

  test("name mode does not mutate the input array", () => {
    const input = [...FOUND];
    sortPaths(input, "name");
    expect(input).toEqual(FOUND);
  });

  test("empty input is handled in both modes", () => {
    expect(sortPaths([], "found")).toEqual([]);
    expect(sortPaths([], "name")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// iconKindForPath
// ---------------------------------------------------------------------------

describe("iconKindForPath", () => {
  test("code extensions classify as code", () => {
    for (const p of ["src/main.ts", "a/b.rs", "x.py", "style.css"]) {
      expect(iconKindForPath(p)).toBe("code");
    }
  });

  test("structured-data extensions classify as data", () => {
    for (const p of ["package.json", "config.yaml", "Cargo.toml"]) {
      expect(iconKindForPath(p)).toBe("data");
    }
  });

  test("document extensions classify as doc", () => {
    for (const p of ["dash/x.md", "notes.txt", "README.markdown"]) {
      expect(iconKindForPath(p)).toBe("doc");
    }
  });

  test("image extensions classify as image", () => {
    for (const p of ["logo.svg", "shot.png", "photo.jpeg"]) {
      expect(iconKindForPath(p)).toBe("image");
    }
  });

  test("unknown / extensionless paths fall through to file", () => {
    expect(iconKindForPath("justfile")).toBe("file");
    expect(iconKindForPath("bin/tugcast")).toBe("file");
    expect(iconKindForPath("archive.weirdext")).toBe("file");
    // A leading-dot dotfile has no extension — the dot is at index 0.
    expect(iconKindForPath(".gitignore")).toBe("file");
  });

  test("classification is case-insensitive on the extension", () => {
    expect(iconKindForPath("IMAGE.PNG")).toBe("image");
    expect(iconKindForPath("Main.TS")).toBe("code");
  });

  test("trailing path slashes do not break classification", () => {
    // `pathBasename` ignores trailing slashes — a directory-shaped
    // entry still classifies by its last named segment.
    expect(iconKindForPath("src/components/")).toBe("file");
  });
});

// ---------------------------------------------------------------------------
// composePathCountLabel / composeTruncationLabel
// ---------------------------------------------------------------------------

describe("composePathCountLabel", () => {
  test("pluralizes on the count", () => {
    expect(composePathCountLabel(0)).toBe("0 paths");
    expect(composePathCountLabel(1)).toBe("1 path");
    expect(composePathCountLabel(100)).toBe("100 paths");
  });
});

describe("composeTruncationLabel", () => {
  test("undefined truncatedAt yields no label", () => {
    expect(composeTruncationLabel(undefined)).toBeUndefined();
  });

  test("a truncatedAt total composes the indicator", () => {
    expect(composeTruncationLabel(100)).toBe("truncated at 100");
  });
});
