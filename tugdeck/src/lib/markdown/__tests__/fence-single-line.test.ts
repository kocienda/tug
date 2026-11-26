/**
 * Which fences soft-wrap: a one-line fence (a prompt to paste, a sentence)
 * wraps instead of scrolling off to the right; a fence of several lines
 * keeps its columns.
 */

import { describe, expect, test } from "bun:test";
import { isSingleLineFence } from "../enhance-fenced-code";

describe("isSingleLineFence", () => {
  test("one line, with or without the closing newline, is single", () => {
    expect(isSingleLineFence("Read briefs/cycle-rollout-brief.md and write a brief.\n")).toBe(true);
    expect(isSingleLineFence("Read briefs/cycle-rollout-brief.md and write a brief.")).toBe(true);
    expect(isSingleLineFence("")).toBe(true);
  });

  test("two or more lines are not", () => {
    expect(isSingleLineFence("a\nb\n")).toBe(false);
    expect(isSingleLineFence("+---+\n| x |\n+---+")).toBe(false);
  });
});
