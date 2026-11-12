/**
 * tug-list-row.test.ts — pure-logic coverage for `TugListRow`'s
 * exported resolvers.
 *
 * `TugListRow` is a presentational component; its render path is
 * exercised in the running app (the gallery card, and the picker once
 * it migrates). What is pure — and therefore unit-testable — is the
 * variant resolution (prop vs layout context vs default) and the
 * content-mode precedence (`children` overrides `title` / `subtitle`).
 * These two functions are the primitive's only branching logic, so
 * locking them here pins the contract the render path depends on.
 */

import { describe, expect, test } from "bun:test";
import { createElement } from "react";

import {
  DEFAULT_LIST_ROW_VARIANT,
  resolveListRowContentMode,
  resolveListRowDensity,
  resolveListRowSelectedGlyph,
  resolveListRowVariant,
} from "../tug-list-row";

describe("resolveListRowVariant", () => {
  test("an explicit prop wins over the layout context and the default", () => {
    expect(resolveListRowVariant("pill", null)).toBe("pill");
    expect(resolveListRowVariant("pill", "flush")).toBe("pill");
    expect(resolveListRowVariant("flush", "pill")).toBe("flush");
  });

  test("falls back to the layout context when no prop is given", () => {
    expect(resolveListRowVariant(undefined, "pill")).toBe("pill");
    expect(resolveListRowVariant(undefined, "flush")).toBe("flush");
  });

  test("falls back to the default when neither prop nor context is set", () => {
    expect(resolveListRowVariant(undefined, null)).toBe(DEFAULT_LIST_ROW_VARIANT);
    expect(DEFAULT_LIST_ROW_VARIANT).toBe("flush");
  });
});

describe("resolveListRowDensity", () => {
  test("an explicit prop wins over the layout context and the default", () => {
    expect(resolveListRowDensity("compact", null)).toBe("compact");
    expect(resolveListRowDensity("regular", "compact")).toBe("regular");
  });

  test("falls back to the layout context, then cozy", () => {
    expect(resolveListRowDensity(undefined, "compact")).toBe("compact");
    expect(resolveListRowDensity(undefined, null)).toBe("regular");
    expect(resolveListRowDensity(undefined, undefined)).toBe("regular");
  });
});

describe("resolveListRowContentMode", () => {
  test("renderable children take precedence over title / subtitle", () => {
    expect(resolveListRowContentMode("body", "Title", "Subtitle")).toBe(
      "children",
    );
    expect(resolveListRowContentMode("body", undefined, undefined)).toBe(
      "children",
    );
  });

  test("a title or subtitle alone yields structured mode", () => {
    expect(resolveListRowContentMode(undefined, "Title", undefined)).toBe(
      "structured",
    );
    expect(resolveListRowContentMode(undefined, undefined, "Subtitle")).toBe(
      "structured",
    );
    expect(resolveListRowContentMode(undefined, "Title", "Subtitle")).toBe(
      "structured",
    );
  });

  test("an empty title string counts as absent", () => {
    expect(resolveListRowContentMode(undefined, "", undefined)).toBe("empty");
  });

  test("no content at all yields empty mode", () => {
    expect(resolveListRowContentMode(undefined, undefined, undefined)).toBe(
      "empty",
    );
    expect(resolveListRowContentMode(null, undefined, null)).toBe("empty");
  });

  test("an empty subtitle string counts as absent", () => {
    expect(resolveListRowContentMode(undefined, undefined, "")).toBe("empty");
  });

  test("a node title yields structured mode (a highlighted title)", () => {
    const marked = createElement("mark", null, "tug");
    expect(resolveListRowContentMode(undefined, marked, undefined)).toBe(
      "structured",
    );
    expect(resolveListRowContentMode(undefined, undefined, marked)).toBe(
      "structured",
    );
  });

  test("a non-renderable children value does not claim the content column", () => {
    expect(resolveListRowContentMode(false, "Title", undefined)).toBe(
      "structured",
    );
    expect(resolveListRowContentMode(null, "Title", undefined)).toBe(
      "structured",
    );
  });
});

describe("resolveListRowSelectedGlyph", () => {
  test('"check" + selected shows the mark', () => {
    expect(resolveListRowSelectedGlyph("check", true)).toBe("shown");
  });

  test('"check" + unselected reserves the column (empty)', () => {
    expect(resolveListRowSelectedGlyph("check", false)).toBe("reserved");
    expect(resolveListRowSelectedGlyph("check", undefined)).toBe("reserved");
  });

  test('"radio" tracks selection like "check" (shown / reserved)', () => {
    expect(resolveListRowSelectedGlyph("radio", true)).toBe("shown");
    expect(resolveListRowSelectedGlyph("radio", false)).toBe("reserved");
    expect(resolveListRowSelectedGlyph("radio", undefined)).toBe("reserved");
  });

  test('"none" / omitted renders no column regardless of selection', () => {
    expect(resolveListRowSelectedGlyph("none", true)).toBe("none");
    expect(resolveListRowSelectedGlyph("none", false)).toBe("none");
    expect(resolveListRowSelectedGlyph(undefined, true)).toBe("none");
  });
});
