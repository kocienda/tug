/**
 * landing-receipt — the Tug-Arc trailer parser the History join badge reads.
 */

import { describe, expect, test } from "bun:test";

import { arcNameFromTrailer } from "@/lib/landing-receipt";

describe("arcNameFromTrailer", () => {
  test("reads the arc short name from a tugarc ref", () => {
    expect(arcNameFromTrailer("tugarc/snippets onto main")).toBe("snippets");
    expect(arcNameFromTrailer("tugarc/fix-join")).toBe("fix-join");
    expect(arcNameFromTrailer("  tugarc/x onto main  ")).toBe("x");
  });

  test("returns null when the value carries no arc ref", () => {
    expect(arcNameFromTrailer(undefined)).toBeNull();
    expect(arcNameFromTrailer(null)).toBeNull();
    expect(arcNameFromTrailer("")).toBeNull();
    expect(arcNameFromTrailer("main")).toBeNull();
    expect(arcNameFromTrailer("tugarc/")).toBeNull();
  });
});
