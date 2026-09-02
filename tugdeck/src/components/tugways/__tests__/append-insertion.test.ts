/**
 * The prompt entry's end-of-doc insertion rule, pinned through the pure
 * `applyAppendInsertion` helper: text arriving from outside the editor (a
 * Jots card snippet dropped with no resolvable offset) lands as-is on an empty
 * editor and appended on its own line over a mid-compose draft.
 */
import { describe, expect, test } from "bun:test";

import { applyAppendInsertion } from "@/components/tugways/tug-prompt-entry";

const TEXT = "```\n$ ls\nout\n[exit 0]\n```\n";

describe("applyAppendInsertion", () => {
  test("empty editor: the text is the insertion, at offset 0", () => {
    const insertion = applyAppendInsertion(TEXT, {
      length: 0,
      isEffectivelyEmpty: true,
    });
    expect(insertion).toEqual({ from: 0, insert: TEXT });
  });

  test("mid-compose draft: appended at end of doc on its own line, never clobbered", () => {
    const insertion = applyAppendInsertion(TEXT, {
      length: 12,
      isEffectivelyEmpty: false,
    });
    expect(insertion).toEqual({ from: 12, insert: `\n${TEXT}` });
  });

  test("zero-length but not flagged empty still inserts as-is at offset 0", () => {
    const insertion = applyAppendInsertion(TEXT, {
      length: 0,
      isEffectivelyEmpty: false,
    });
    expect(insertion).toEqual({ from: 0, insert: TEXT });
  });
});
