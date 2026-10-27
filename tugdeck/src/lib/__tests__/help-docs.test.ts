/**
 * The help card's naming, titling and link reading, over the strings the two
 * shipped documents actually contain.
 *
 * @covers tugdeck/src/lib/help-docs.ts
 * @covers tugdeck/src/lib/open-help-in-card.ts
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  helpAnchorSlug,
  helpDocTitle,
  helpRefLabel,
  isHelpDocName,
  readHelpLink,
  readHelpRefTarget,
} from "@/lib/help-docs";
import { parseOverviewPost } from "@/protocol";
import { coerceHelpSeed } from "@/lib/open-help-in-card";

const DOCS = join(import.meta.dir, "..", "..", "..", "..", "docs");
const shipped = (name: string) => readFileSync(join(DOCS, name), "utf8");

describe("help document names", () => {
  test("only the two documents are names", () => {
    expect(isHelpDocName("features")).toBe(true);
    expect(isHelpDocName("glossary")).toBe(true);
    for (const other of ["", "Glossary", "glossary.md", "../CLAUDE", 3, null]) {
      expect(isHelpDocName(other)).toBe(false);
    }
  });

  test("a seed keeps its document and drops an empty anchor", () => {
    expect(coerceHelpSeed({ doc: "glossary", anchor: "fold" })).toEqual({
      doc: "glossary",
      anchor: "fold",
    });
    expect(coerceHelpSeed({ doc: "features", anchor: "" })).toEqual({ doc: "features" });
    expect(coerceHelpSeed({ doc: "readme" })).toBeNull();
    expect(coerceHelpSeed(null)).toBeNull();
  });
});

describe("help card titles", () => {
  test("the title is the shipped document's own heading", () => {
    expect(helpDocTitle("glossary", shipped("glossary.md"))).toBe("Tug glossary");
    expect(helpDocTitle("features", shipped("features.md"))).toBe(
      "Tug: what it does and how to use it",
    );
  });

  test("before the document loads, the title is the menu item's", () => {
    expect(helpDocTitle("features", null)).toBe("Tug Help");
    expect(helpDocTitle("glossary", null)).toBe("Glossary");
  });
});

describe("help anchors", () => {
  test("headings and glossary terms slug the way GitHub spells them", () => {
    expect(helpAnchorSlug("Fit and Flow")).toBe("fit-and-flow");
    expect(helpAnchorSlug("Getting help")).toBe("getting-help");
    expect(helpAnchorSlug("Join draft.")).toBe("join-draft");
    expect(helpAnchorSlug("Changes (tab, shade).")).toBe("changes-tab-shade");
    expect(helpAnchorSlug("Tug-Arc trailer.")).toBe("tug-arc-trailer");
  });

  test("links read as a jump within, a jump to the other document, or neither", () => {
    expect(readHelpLink("#getting-help")).toEqual({ kind: "anchor", anchor: "getting-help" });
    expect(readHelpLink("glossary.md")).toEqual({ kind: "doc", doc: "glossary", anchor: null });
    expect(readHelpLink("./features.md#fit-and-flow")).toEqual({
      kind: "doc",
      doc: "features",
      anchor: "fit-and-flow",
    });
    for (const outside of ["https://tugtool.dev", "mailto:a@b.c", "README.md", "#", "docs/glossary.md"]) {
      expect(readHelpLink(outside)).toBeNull();
    }
  });

  test("the feature guide's link to the glossary reads as a help link", () => {
    const hrefs = [...shipped("features.md").matchAll(/\]\(([^)]+)\)/g)].map((m) => m[1]);
    expect(hrefs).toContain("glossary.md");
    expect(readHelpLink("glossary.md")?.kind).toBe("doc");
  });
});

describe("help refs", () => {
  test("a target reads as the document and the passage it opens", () => {
    expect(readHelpRefTarget("glossary#split")).toEqual({ doc: "glossary", anchor: "split" });
    expect(readHelpRefTarget("features#stack-and-split")).toEqual({
      doc: "features",
      anchor: "stack-and-split",
    });
    expect(readHelpRefTarget("glossary")).toEqual({ doc: "glossary" });
    expect(readHelpRefTarget("glossary#")).toEqual({ doc: "glossary" });
    for (const other of ["", "#split", "readme#intro", "Glossary#split", "glossary.md#split"]) {
      expect(readHelpRefTarget(other)).toBeNull();
    }
  });

  test("a chip reads the passage as words, or the document by its menu name", () => {
    expect(helpRefLabel({ doc: "glossary", anchor: "join-draft" })).toBe("join draft");
    expect(helpRefLabel({ doc: "glossary" })).toBe("Glossary");
    expect(helpRefLabel({ doc: "features" })).toBe("Tug Help");
  });

  test("a post's help ref survives the wire", () => {
    const post = parseOverviewPost({
      at_ms: 1,
      author: "operator",
      body: "A split slot is cut into bands.",
      refs: [
        { kind: "help", target: "glossary#split" },
        { kind: "portent", target: "x" },
      ],
    });
    expect(post?.refs).toEqual([{ kind: "help", target: "glossary#split" }]);
  });
});
