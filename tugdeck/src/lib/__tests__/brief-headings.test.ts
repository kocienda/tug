import { describe, it, expect } from "bun:test";

import { extractBriefHeadings } from "@/lib/brief-headings";

describe("extractBriefHeadings", () => {
  it("reads findings and decisions in the order they are written", () => {
    const text = [
      "# The Arc Shade",
      "",
      "## Evidence",
      "",
      "**[F01] The popup is already a component.** `ArcPopoverContent` is the popup.",
      "",
      "**[F02] The order is fixed.** More prose.",
      "",
      "## Decisions",
      "",
      "**[B01] The term stays Arc.** No other word enters the product.",
    ].join("\n");
    expect(extractBriefHeadings(text)).toEqual([
      { tag: "F01", kind: "finding", title: "The popup is already a component" },
      { tag: "F02", kind: "finding", title: "The order is fixed" },
      { tag: "B01", kind: "decision", title: "The term stays Arc" },
    ]);
  });

  it("reads a heading whose bold ends before its sentence does", () => {
    expect(extractBriefHeadings("**[B10] The Brief card shows the arc's brief** and offers Open in Text Card.")).toEqual([
      { tag: "B10", kind: "decision", title: "The Brief card shows the arc's brief" },
    ]);
  });

  it("keeps the first heading of a tag written twice", () => {
    const text = "**[B02] First.** x\n\n**[B02] Second.** y";
    expect(extractBriefHeadings(text).map((h) => h.title)).toEqual(["First"]);
  });

  it("does not read a mention inside a sentence", () => {
    expect(extractBriefHeadings("See [B07] and **[B09] in passing** here.\n- **[F04] in a list**")).toEqual([]);
  });

  it("does not read a heading inside a fenced block", () => {
    const text = "```markdown\n**[F01] An example.** x\n```\n\n**[F02] A real one.** y";
    expect(extractBriefHeadings(text).map((h) => h.tag)).toEqual(["F02"]);
  });

  it("reads other tag letters as nothing, and handles CRLF", () => {
    expect(extractBriefHeadings("**[Q01] A question.**\r\n**[F09] Kept.** z\r\n")).toEqual([
      { tag: "F09", kind: "finding", title: "Kept" },
    ]);
  });

  it("is empty for a brief with no tagged headings", () => {
    expect(extractBriefHeadings("# A brief\n\nJust guidance.")).toEqual([]);
    expect(extractBriefHeadings("")).toEqual([]);
  });
});
