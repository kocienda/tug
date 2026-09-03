/**
 * `applyMarkdownTextStyle` — the one-shot markdown styling filter.
 *
 * Drives the real grammar + the real shared highlight style; the class names
 * are generated, so the assertions are about STRUCTURE (which characters form
 * a run, which runs share a class, where a hanging indent lands) rather than
 * about the generated names themselves.
 */

import { describe, expect, test } from "bun:test";

import { highlightRunsByLine, tugHighlightStyleInner } from "@/lib/language-registry";
import {
  getMarkdownGrammarRevision,
  markdownTextStyleParser,
} from "@/lib/markdown-text-style-grammar";
import { applyMarkdownTextStyle } from "@/lib/markdown-text-styling";

/** The line's spans rejoined — must always reproduce the source verbatim. */
function rejoin(spans: readonly { text: string }[]): string {
  return spans.map((s) => s.text).join("");
}

/**
 * Every construct documented on the Markdown syntax page, in one document.
 * The scheme's central claim is that this survives styling byte-for-byte, so
 * this fixture is the input to the round-trip assertions below.
 */
const CORPUS = [
  "# ATX heading with closing hashes #",
  "",
  "Setext heading",
  "==============",
  "",
  "Another setext",
  "--------------",
  "",
  "> a blockquote",
  "> > nested deeper",
  "> - a list item inside a quote",
  "",
  "---",
  "",
  "***",
  "",
  "___",
  "",
  "A line ending in a hard break  ",
  "and its continuation.",
  "",
  "*em* and _em_ and **strong** and __strong__ and `code` and intra*word*em.",
  "",
  "An \\*escaped\\* star and an &amp; entity.",
  "",
  "An [inline link](http://example.com \"a title\"), a [reference link][ref],",
  "and an [implicit link][]. An image: ![alt](http://example.com/i.png).",
  "",
  "[ref]: http://example.com \"ref title\"",
  "[implicit link]: http://example.com",
  "",
  "Autolinks: <http://example.com> and <someone@example.com>.",
  "",
  "    an indented code block",
  "",
  "```ts",
  "const fenced = 1;",
  "```",
  "",
  "~~struck through~~",
  "",
  "| col a | col b |",
  "| ----- | ----- |",
  "| one   | two   |",
  "",
  "- [ ] an open task",
  "- [x] a done task",
  "1. ordered with a dot",
  "2) ordered with a paren",
  "-\ta tab-separated marker",
  "",
  "Inline <b>html</b> here.",
  "",
  "<!-- an html comment -->",
  "",
].join("\n");

describe("applyMarkdownTextStyle over the full construct corpus", () => {
  test("reproduces the corpus byte-for-byte", () => {
    const lines = applyMarkdownTextStyle(CORPUS);
    expect(lines.map((l) => l.text).join("\n")).toBe(CORPUS);
  });

  test("every line's spans rejoin to that line", () => {
    for (const line of applyMarkdownTextStyle(CORPUS)) {
      if (line.spans.length > 0) expect(rejoin(line.spans)).toBe(line.text);
    }
  });

  test("keeps every syntax marker in the text", () => {
    const out = applyMarkdownTextStyle(CORPUS)
      .map((l) => l.text)
      .join("\n");
    for (const marker of ["#", ">", "---", "***", "___", "~~", "```", "*", "_", "`", "[", "!["]) {
      expect(out).toContain(marker);
    }
    // The hard break's two trailing spaces survive styling.
    expect(out).toContain("hard break  \n");
  });
});

describe("applyMarkdownTextStyle", () => {
  test("reproduces the source text verbatim", () => {
    const src = "# Heading\n\n- one **bold** item\n\nplain tail\n";
    const lines = applyMarkdownTextStyle(src);
    expect(lines.map((l) => l.text).join("\n")).toBe(src);
    for (const line of lines) {
      if (line.spans.length > 0) expect(rejoin(line.spans)).toBe(line.text);
    }
  });

  test("keeps the raw syntax markers in the text", () => {
    const [heading] = applyMarkdownTextStyle("# Heading");
    expect(heading.text).toBe("# Heading");
    expect(rejoin(heading.spans)).toContain("#");
  });

  test("styles a strong run and its markers", () => {
    const [line] = applyMarkdownTextStyle("a **bold** b");
    const styled = line.spans.filter((s) => s.className !== "");
    // The `**` markers and the word between them all carry a class; the
    // surrounding prose does not.
    expect(styled.map((s) => s.text)).toEqual(["**", "bold", "**"]);
    expect(line.spans[0].className).toBe("");
  });

  test("styles an inline-code run distinctly from surrounding prose", () => {
    const [line] = applyMarkdownTextStyle("see `theft-gate` here");
    const code = line.spans.find((s) => s.text === "theft-gate");
    expect(code).toBeDefined();
    expect(code?.className).not.toBe("");
    expect(code?.className).not.toBe(line.spans[0].className);
  });

  test("hangs a list item under its content", () => {
    const lines = applyMarkdownTextStyle("- item one\n1. item two\n   - nested\nplain");
    expect(lines.map((l) => l.indent)).toEqual([2, 3, 5, 0]);
  });

  test("hangs a list item nested in a blockquote", () => {
    // The anchored regex cannot see a marker that isn't at the line start,
    // so this leans on the marker-end fallback the editor has always had.
    const [line] = applyMarkdownTextStyle("> - item");
    expect(line.indent).toBeGreaterThan(0);
  });

  test("hangs a list item whose marker is followed by a tab", () => {
    const [line] = applyMarkdownTextStyle("-\titem");
    expect(line.indent).toBeGreaterThan(0);
  });

  test("a lone arc under a paragraph starts a list, not a setext heading", () => {
    // The keystroke that opens a list item is also a valid setext underline,
    // which would repaint the whole paragraph above as a heading between the
    // marker and the item's first character.
    const lines = applyMarkdownTextStyle("some prose:\n- ");
    expect(lines[0].spans.every((s) => s.className === "")).toBe(true);
    expect(lines[1].indent).toBe(2);
  });

  test("a two-arc underline is still a setext heading", () => {
    const lines = applyMarkdownTextStyle("some prose:\n--");
    expect(lines[0].spans.some((s) => s.className !== "")).toBe(true);
    expect(lines[1].indent).toBe(0);
  });

  test("does not mistake a code-block line for a list item", () => {
    const lines = applyMarkdownTextStyle("```\n- not a list\n```");
    expect(lines[1].indent).toBe(0);
  });

  test("preserves blank lines as their own entries", () => {
    const lines = applyMarkdownTextStyle("a\n\n\nb");
    expect(lines).toHaveLength(4);
    expect(lines[1].text).toBe("");
    expect(lines[1].spans).toEqual([]);
  });

  test("empty input yields one empty line", () => {
    expect(applyMarkdownTextStyle("")).toEqual([
      { text: "", indent: 0, code: false, spans: [] },
    ]);
  });

  test("marks every line of a fenced block as code, delimiters included", () => {
    const lines = applyMarkdownTextStyle("prose\n\n```ts\nconst x = 1;\n```\n\nafter");
    expect(lines.map((l) => l.code)).toEqual([
      false, // prose
      false, // blank
      true, //  ```ts
      true, //  const x = 1;
      true, //  ```
      false, // blank
      false, // after
    ]);
  });

  test("marks an indented code block as code", () => {
    const lines = applyMarkdownTextStyle("prose\n\n    indented code\n\nafter");
    expect(lines[2].code).toBe(true);
    expect(lines[0].code).toBe(false);
  });

  test("a line with inline code is not a code line", () => {
    const [line] = applyMarkdownTextStyle("see `foo` here");
    expect(line.code).toBe(false);
  });

  test("styles GFM constructs — the dialect both forms now parse", () => {
    const [task] = applyMarkdownTextStyle("- [ ] a task");
    const marker = task.spans.find((s) => s.text === "[ ]");
    expect(marker).toBeDefined();
    expect(marker?.className).not.toBe("");

    const [struck] = applyMarkdownTextStyle("a ~~gone~~ b");
    const delimiters = struck.spans.filter((s) => s.text === "~~");
    expect(delimiters).toHaveLength(2);
    for (const d of delimiters) expect(d.className).not.toBe("");
  });

  test("styles inline HTML", () => {
    const [line] = applyMarkdownTextStyle("text <b>bold</b> text");
    const tagNames = line.spans.filter((s) => s.text === "b" && s.className !== "");
    expect(tagNames.length).toBeGreaterThan(0);
    const brackets = line.spans.filter((s) => s.text.includes("<") && s.className !== "");
    expect(brackets.length).toBeGreaterThan(0);
    expect(rejoin(line.spans)).toBe("text <b>bold</b> text");
  });

  test("tones a blockquote body apart from plain prose", () => {
    const lines = applyMarkdownTextStyle("> quoted\n\nplain");
    const quoted = lines[0].spans.find((s) => s.text.includes("quoted"));
    const plain = lines[2].spans.find((s) => s.text.includes("plain"));
    expect(quoted?.className).not.toBe("");
    expect(quoted?.className).not.toBe(plain?.className ?? "");
    // The marker is still in the text.
    expect(lines[0].text).toBe("> quoted");
  });

  test("tones a horizontal rule across its whole line", () => {
    for (const rule of ["---", "***", "___"]) {
      const [line] = applyMarkdownTextStyle(`para\n\n${rule}\n`).slice(2);
      const styled = line.spans.filter((s) => s.className !== "");
      expect(rejoin(styled)).toBe(rule);
    }
  });

  test("strikes through a strikethrough body", () => {
    const [line] = applyMarkdownTextStyle("keep ~~gone~~ keep");
    const struck = line.spans.find((s) => s.text === "gone");
    expect(struck?.className).not.toBe("");
    expect(struck?.className).not.toBe(line.spans[0].className);
    expect(line.text).toBe("keep ~~gone~~ keep");
  });

  test("marks a hard line break without consuming its spaces", () => {
    const lines = applyMarkdownTextStyle("first  \nsecond");
    const styled = lines[0].spans.filter((s) => s.className !== "");
    expect(styled).toHaveLength(1);
    expect(styled[0].text).toBe("  ");
    // The spaces are still in the buffer, not replaced by an affordance.
    expect(lines[0].text).toBe("first  ");
    expect(rejoin(lines[0].spans)).toBe("first  ");
  });

  test("a single trailing space is not a hard break", () => {
    const lines = applyMarkdownTextStyle("first \nsecond");
    expect(lines[0].spans.filter((s) => s.className !== "")).toEqual([]);
  });

  test("highlights a fence body once its declared grammar has loaded", async () => {
    // A language no other test in this file uses: the descriptions are cached
    // module-wide, so a grammar an earlier test already pulled in would be
    // loaded before this one's "before" pass ran.
    const src = "```rust\nlet x = 1;\n```";
    // The first pass kicks the lazy load and returns a flat body.
    const before = applyMarkdownTextStyle(src)[1];
    const flat = new Set(before.spans.map((s) => s.className));
    expect(flat.size).toBe(1);

    // Wait for the grammar to arrive, then re-run: the description caches its
    // support, so the same parser now tokenizes the body.
    const revisionBefore = getMarkdownGrammarRevision();
    for (let i = 0; i < 200 && getMarkdownGrammarRevision() === revisionBefore; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(getMarkdownGrammarRevision()).not.toBe(revisionBefore);

    const after = applyMarkdownTextStyle(src)[1];
    const keyword = after.spans.find((s) => s.text === "let");
    expect(keyword).toBeDefined();
    expect(keyword?.className).not.toBe("");
    expect(flat.has(keyword?.className ?? "")).toBe(false);
    // The fence is still a code block and the text is still verbatim.
    expect(after.code).toBe(true);
    expect(rejoin(after.spans)).toBe("let x = 1;");
  });

  test("leaves an unknown fence language flat and throws nothing", () => {
    const lines = applyMarkdownTextStyle("```nosuchlang\nbody here\n```");
    expect(lines[1].text).toBe("body here");
    expect(lines[1].code).toBe(true);
  });

  test("the grammar revision is stable between arrivals", () => {
    const a = getMarkdownGrammarRevision();
    expect(getMarkdownGrammarRevision()).toBe(a);
    expect(getMarkdownGrammarRevision()).toBe(a);
  });

  test("the filter and the editor bundle parse one grammar", () => {
    // Walk both sides with `tugHighlightStyleInner`: the editing variant
    // generates a different class for link/url (no underline), so mixing the
    // two styles would fail on links for a reason unrelated to parser parity.
    const src = "# H\n\n> quoted\n\n- [ ] task\n\n~~gone~~ and `code`\n\n[a](http://x.y)\n";
    const viaFilter = applyMarkdownTextStyle(src);
    const runs = highlightRunsByLine(
      markdownTextStyleParser.parse(src),
      src,
      tugHighlightStyleInner,
    );
    const lines = src.split("\n");
    for (const [i, line] of lines.entries()) {
      const direct = (runs[i] ?? []).map((r) => ({
        text: line.slice(r.start, r.end),
        className: r.className,
      }));
      // Compare the styling alone: `code` is a separate reading of the same
      // runs (from the parse tree, not the highlighter) and has no
      // counterpart in `highlightRunsByLine`'s output.
      const filtered = viaFilter[i].spans
        .filter((s) => s.className !== "")
        .map((s) => ({ text: s.text, className: s.className }));
      expect(filtered).toEqual(direct);
    }
  });
});
