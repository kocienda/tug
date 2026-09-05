/**
 * The path-face audit's rule, stated as a claim.
 *
 * The DOM walk that gathers the faces needs a real document and is exercised
 * through `window.__tug.auditPathFaces` by the app-test that names a file and
 * then creates it. What is pure — and what the audit is actually *for* — is
 * the grouping: one spelling that appears both marked and plain in one frame
 * is the defect, and nothing else is.
 */

import { describe, expect, test } from "bun:test";

import { conflictingFaces, type PathFace } from "../path-face-audit";

const marked = (text: string): PathFace => ({ text, marked: true });
const plain = (text: string): PathFace => ({ text, marked: false });

describe("conflictingFaces", () => {
  test("agreement is silence, whichever face they agree on", () => {
    expect(
      conflictingFaces([marked("notes/a.md"), marked("notes/a.md")]),
    ).toEqual([]);
    expect(
      conflictingFaces([plain("notes/a.md"), plain("notes/a.md")]),
    ).toEqual([]);
  });

  test("one spelling drawn two ways is the whole defect", () => {
    expect(
      conflictingFaces([marked("notes/a.md"), plain("notes/a.md")]),
    ).toEqual([{ text: "notes/a.md", marked: 1, plain: 1 }]);
  });

  test("two files disagreeing with each other is not a conflict", () => {
    // The screenshots that opened this arc: two paths, one lit, one not. That
    // is only a defect when the two are the SAME file — which the audit
    // decides by what the ink says, since a plain run carries no verdict to
    // compare. Different spellings are two questions with two answers.
    expect(
      conflictingFaces([marked("notes/a.md"), plain("notes/b.md")]),
    ).toEqual([]);
  });

  test("it counts both sides, so a report says how lopsided the frame is", () => {
    expect(
      conflictingFaces([
        marked("notes/a.md"),
        plain("notes/a.md"),
        plain("notes/a.md"),
      ]),
    ).toEqual([{ text: "notes/a.md", marked: 1, plain: 2 }]);
  });

  test("every conflicting spelling is reported, not just the first", () => {
    const conflicts = conflictingFaces([
      marked("notes/a.md"),
      plain("notes/a.md"),
      marked("src/b.ts"),
      plain("src/b.ts"),
      marked("src/c.ts"),
    ]);
    expect(conflicts.map((c) => c.text).sort()).toEqual([
      "notes/a.md",
      "src/b.ts",
    ]);
  });

  test("an empty frame holds the invariant vacuously", () => {
    expect(conflictingFaces([])).toEqual([]);
  });
});
