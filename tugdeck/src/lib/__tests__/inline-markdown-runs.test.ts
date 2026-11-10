import { describe, expect, test } from "bun:test";

import {
  decodeHtmlEntities,
  inlineMarkdownPlainText,
  inlineMarkdownRuns,
} from "@/lib/inline-markdown-runs";

describe("inlineMarkdownRuns", () => {
  test("plain text is one text run", () => {
    expect(inlineMarkdownRuns("Run the full suite")).toEqual([
      { kind: "text", text: "Run the full suite" },
    ]);
  });

  test("backticks become code and are consumed", () => {
    expect(inlineMarkdownRuns("Fix `foo.ts` and `just ci`")).toEqual([
      { kind: "text", text: "Fix " },
      { kind: "code", text: "foo.ts" },
      { kind: "text", text: " and " },
      { kind: "code", text: "just ci" },
    ]);
  });

  test("a code span keeps its content verbatim", () => {
    expect(inlineMarkdownRuns("Grep `a **b** &amp; <c>`")).toEqual([
      { kind: "text", text: "Grep " },
      { kind: "code", text: "a **b** &amp; <c>" },
    ]);
  });

  test("double backticks hold a backtick", () => {
    expect(inlineMarkdownRuns("Quote `` a`b `` here")).toEqual([
      { kind: "text", text: "Quote " },
      { kind: "code", text: "a`b" },
      { kind: "text", text: " here" },
    ]);
  });

  test("an unclosed backtick is text", () => {
    expect(inlineMarkdownPlainText("It's a ` stray")).toBe("It's a ` stray");
  });

  test("strong and em", () => {
    expect(inlineMarkdownRuns("Make **this** *count*")).toEqual([
      { kind: "text", text: "Make " },
      { kind: "strong", children: [{ kind: "text", text: "this" }] },
      { kind: "text", text: " " },
      { kind: "em", children: [{ kind: "text", text: "count" }] },
    ]);
  });

  test("emphasis may hold code", () => {
    expect(inlineMarkdownRuns("**Fix `x`** now")).toEqual([
      {
        kind: "strong",
        children: [
          { kind: "text", text: "Fix " },
          { kind: "code", text: "x" },
        ],
      },
      { kind: "text", text: " now" },
    ]);
    expect(inlineMarkdownRuns("*`a.ts`*")).toEqual([
      { kind: "em", children: [{ kind: "code", text: "a.ts" }] },
    ]);
  });

  test("arithmetic and identifiers stay text", () => {
    expect(inlineMarkdownPlainText("a * b * c")).toBe("a * b * c");
    expect(inlineMarkdownPlainText("rename snake_case_name now")).toBe(
      "rename snake_case_name now",
    );
    expect(inlineMarkdownPlainText("glob src/**/*.ts")).toBe("glob src/**/*.ts");
  });

  test("angle brackets, headings and list markers are text", () => {
    expect(inlineMarkdownPlainText("Handle <Tab> key in a < b")).toBe(
      "Handle <Tab> key in a < b",
    );
    expect(inlineMarkdownPlainText("Check <div> wrapper")).toBe("Check <div> wrapper");
    expect(inlineMarkdownPlainText("1. Step one")).toBe("1. Step one");
    expect(inlineMarkdownPlainText("# heading")).toBe("# heading");
    expect(inlineMarkdownPlainText("Print $HOME and $PATH")).toBe("Print $HOME and $PATH");
  });

  test("entities decode outside code", () => {
    expect(inlineMarkdownPlainText("Build &amp; test &lt;app&gt; &#8212; &#x2192; done")).toBe(
      "Build & test <app> — → done",
    );
  });

  test("backslash escapes", () => {
    expect(inlineMarkdownPlainText("literal \\*star\\* and \\`tick\\`")).toBe(
      "literal *star* and `tick`",
    );
  });

  test("an unmatched opener is text", () => {
    expect(inlineMarkdownPlainText("**open only")).toBe("**open only");
    expect(inlineMarkdownPlainText("*a **b c")).toBe("*a **b c");
  });
});

describe("decodeHtmlEntities", () => {
  test("unknown names and bad code points stay as written", () => {
    expect(decodeHtmlEntities("&bogus; &#0; &#xD800; & alone")).toBe(
      "&bogus; &#0; &#xD800; & alone",
    );
  });

  test("double-escaped decodes one level", () => {
    expect(decodeHtmlEntities("&amp;amp;")).toBe("&amp;");
  });
});
