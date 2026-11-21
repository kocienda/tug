/**
 * arc-record-text.test.ts — a record's text read into paragraphs and lists.
 */

import { describe, expect, test } from "bun:test";

import { parseArcRecord } from "../arc-record-text";

describe("parseArcRecord", () => {
  test("sentences are one paragraph, wrapped lines joined", () => {
    expect(parseArcRecord("Give each scene a look\nyou can choose and edit.")).toEqual([
      { kind: "paragraph", text: "Give each scene a look you can choose and edit." },
    ]);
  });

  test("a sentence and the list under it are two blocks", () => {
    expect(
      parseArcRecord("Looks are files.\n\n- A picker chooses one\n- An editor changes it\n  and saves a copy"),
    ).toEqual([
      { kind: "paragraph", text: "Looks are files." },
      { kind: "list", items: ["A picker chooses one", "An editor changes it and saves a copy"] },
    ]);
  });

  test("a list straight under a sentence, with no blank line, still parts from it", () => {
    expect(parseArcRecord("The parts:\n* One\n* Two")).toEqual([
      { kind: "paragraph", text: "The parts:" },
      { kind: "list", items: ["One", "Two"] },
    ]);
  });

  test("blank lines part paragraphs, and empty text is no blocks", () => {
    expect(parseArcRecord("One.\n\nTwo.")).toEqual([
      { kind: "paragraph", text: "One." },
      { kind: "paragraph", text: "Two." },
    ]);
    expect(parseArcRecord("  \n")).toEqual([]);
  });
});
