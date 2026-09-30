/**
 * `enhance-mermaid` — pure-logic helpers.
 *
 * The DOM-mutating render path is HMR-vetted (per project test
 * policy: no fake-DOM render tests). The pure helpers that drive
 * the theme pick are unit-tested here:
 *
 *  - {@link readColorLuminance} — parses a CSS colour and returns
 *    a `[0, 1]` luma value (Rec. 709 weights). Used by
 *    `pickMermaidTheme` to bucket the host canvas as dark or light.
 */

import { describe, expect, test } from "bun:test";

import { readColorLuminance } from "../enhance-mermaid";

describe("readColorLuminance — hex parsing", () => {
  test("#000000 reads as 0", () => {
    expect(readColorLuminance("#000000")).toBe(0);
  });

  test("#ffffff reads as 1", () => {
    expect(readColorLuminance("#ffffff")).toBeCloseTo(1, 6);
  });

  test("ironclad canvas (#16181a) reads dark (< 0.5)", () => {
    expect(readColorLuminance("#16181a")).toBeLessThan(0.5);
  });

  test("sloop canvas (#71888e) reads dark-leaning but mid-tone", () => {
    // Sloop's host canvas is a mid-grey; on the Rec. 709 weights
    // it sits below the 0.5 threshold but well above ironclad's depth.
    const l = readColorLuminance("#71888e");
    expect(l).toBeGreaterThan(readColorLuminance("#16181a"));
  });

  test("3-digit shorthand is expanded correctly (#fff)", () => {
    expect(readColorLuminance("#fff")).toBeCloseTo(1, 6);
  });

  test("3-digit shorthand (#000)", () => {
    expect(readColorLuminance("#000")).toBe(0);
  });

  test("hex parsing is case-insensitive", () => {
    expect(readColorLuminance("#FFFFFF")).toBeCloseTo(1, 6);
    expect(readColorLuminance("#FFF")).toBeCloseTo(1, 6);
  });
});

describe("readColorLuminance — rgb() parsing", () => {
  test("rgb(0,0,0) reads as 0", () => {
    expect(readColorLuminance("rgb(0, 0, 0)")).toBe(0);
  });

  test("rgb(255,255,255) reads as 1", () => {
    expect(readColorLuminance("rgb(255, 255, 255)")).toBeCloseTo(1, 6);
  });

  test("rgb tolerates whitespace variants", () => {
    expect(readColorLuminance("rgb(  0  ,0,0  )")).toBe(0);
  });
});

describe("readColorLuminance — unparseable inputs", () => {
  test("empty string falls back to 0.5", () => {
    expect(readColorLuminance("")).toBe(0.5);
  });

  test("unknown format falls back to 0.5", () => {
    expect(readColorLuminance("oklch(0.5 0.1 200)")).toBe(0.5);
    expect(readColorLuminance("rebeccapurple")).toBe(0.5);
  });

  test("whitespace-only falls back to 0.5", () => {
    expect(readColorLuminance("   ")).toBe(0.5);
  });
});
