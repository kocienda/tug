/**
 * Unit tests for the legacy fake-compaction replay recognition helpers ([P06]).
 * The producers that once wrote these markers are gone (native `/compact`
 * compacts in place); these tests pin that OLD JSONLs carrying the markers
 * still reconstruct — the seed block splits back to its summary and the
 * canceled-summarize marker is recognized. Seed / summarize strings are inlined
 * literals (the builders are deleted), matching the exact bytes legacy JSONLs
 * hold.
 */

import { describe, it, expect } from "bun:test";

import {
  splitCompactionSeed,
  isCompactionSummarizeText,
} from "@/lib/compaction-request";

const SEED_MARKER = "<!-- tug:compact-seed -->";
const SEED_FRAMING =
  "The earlier conversation was compacted to save context. Here is the " +
  "summary of everything so far — treat it as established context and " +
  "continue seamlessly:";

/** A legacy seed block exactly as an old JSONL persisted it. */
const legacySeedBlock = (summary: string): string =>
  `${SEED_MARKER}\n${SEED_FRAMING}\n\n${summary}`;

describe("isCompactionSummarizeText", () => {
  it("recognizes a legacy canceled-summarize turn by its marker", () => {
    expect(
      isCompactionSummarizeText("<!-- tug:compact-summarize -->\nplease summarize"),
    ).toBe(true);
  });

  it("returns false for ordinary user text", () => {
    expect(isCompactionSummarizeText("an ordinary message")).toBe(false);
  });
});

describe("splitCompactionSeed", () => {
  it("round-trips a legacy seed block back to the raw summary", () => {
    const summary = "# Recap\n\n- chose SQLite\n- binary is `tlist`";
    expect(splitCompactionSeed(legacySeedBlock(summary))).toBe(summary);
  });

  it("returns null for ordinary user text (no marker)", () => {
    expect(splitCompactionSeed("start the arc")).toBeNull();
    expect(splitCompactionSeed("")).toBeNull();
  });

  it("recovers the body even if the framing is absent after the marker", () => {
    expect(splitCompactionSeed(`${SEED_MARKER}\njust a body`)).toBe("just a body");
  });
});
