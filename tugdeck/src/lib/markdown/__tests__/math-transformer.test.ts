/**
 * `mathTransformer` — populated behaviour (Step 22).
 *
 * The stub-shape contract is exercised in `block-transformers.test.ts`'s
 * "stub transformers" suite: every transformer passes its argument
 * through unchanged when the input does not match its predicate. This
 * file pins the *populated* behaviour:
 *
 *  - ` ```math `, ` ```latex `, ` ```tex ` fences promote to a
 *    `tug-math-display` placeholder.
 *  - Other fenced-code blocks pass through unchanged (including
 *    language tags like `ts` and unlabeled fences).
 *  - Non-code blocks pass through unchanged.
 *  - HTML entities the parser emits inside a fence body (`&amp;`,
 *    `&lt;`, `&gt;`, `&quot;`, `&#39;`) are decoded back to their
 *    literal characters so KaTeX sees the original LaTeX source.
 *  - Streaming-aware: `isComplete: false` defers the promotion so a
 *    half-streamed expression renders as a plain code fence.
 *  - The trailing newline pulldown-cmark always emits before
 *    `</code>` is trimmed from the captured source.
 *
 * Pure-logic: no DOM, no jsdom, no WASM init required because the
 * transformer is exercised directly on synthetic block records.
 */

import { describe, expect, test } from "bun:test";

import {
  buildMathPlaceholderHtml,
  decodeFencedEntities,
  extractMathSource,
  mathTransformer,
} from "../block-transformers/math";
import type { SanitizedMarkdownBlock } from "../parse-markdown-to-sanitized-blocks";

function codeBlock(
  langClass: string,
  inner: string,
): SanitizedMarkdownBlock {
  return {
    html: `<pre><code class="language-${langClass}">${inner}</code></pre>\n`,
    type: "code",
    startChar: 0,
    endChar: inner.length,
    depth: 0,
    itemCount: 0,
    rowCount: 0,
    contentHash: 0n,
  };
}

describe("decodeFencedEntities", () => {
  test("decodes the entity set pulldown-cmark emits", () => {
    const escaped = "a &amp; b &lt; c &gt; d &quot; e &#39; f";
    expect(decodeFencedEntities(escaped)).toBe(`a & b < c > d " e ' f`);
  });

  test("decodes `&amp;` last so already-escaped entities round-trip", () => {
    expect(decodeFencedEntities("&amp;lt;")).toBe("&lt;");
    expect(decodeFencedEntities("&amp;amp;")).toBe("&amp;");
  });

  test("leaves unrelated text untouched", () => {
    expect(decodeFencedEntities("E=mc^2")).toBe("E=mc^2");
  });
});

describe("extractMathSource", () => {
  test("extracts source from a ```math fence", () => {
    const out = extractMathSource(`<pre><code class="language-math">E=mc^2\n</code></pre>\n`);
    expect(out).toEqual({ lang: "math", source: "E=mc^2" });
  });

  test("accepts latex and tex aliases", () => {
    expect(extractMathSource(`<pre><code class="language-latex">x</code></pre>\n`))
      .toEqual({ lang: "latex", source: "x" });
    expect(extractMathSource(`<pre><code class="language-tex">x</code></pre>\n`))
      .toEqual({ lang: "tex", source: "x" });
  });

  test("language match is case-insensitive", () => {
    const out = extractMathSource(`<pre><code class="language-Math">x</code></pre>\n`);
    expect(out?.lang).toBe("math");
  });

  test("returns null for non-math fences", () => {
    expect(extractMathSource(`<pre><code class="language-ts">x</code></pre>\n`))
      .toBeNull();
  });

  test("returns null for fences without a language class", () => {
    expect(extractMathSource(`<pre><code>x</code></pre>\n`)).toBeNull();
  });

  test("returns null for non-pre/code shapes", () => {
    expect(extractMathSource(`<p>$E=mc^2$</p>`)).toBeNull();
  });

  test("decodes HTML entities inside the source", () => {
    const out = extractMathSource(
      `<pre><code class="language-math">x &lt; y &amp;&amp; a &gt; b</code></pre>\n`,
    );
    expect(out?.source).toBe("x < y && a > b");
  });

  test("strips the trailing newline pulldown-cmark emits", () => {
    // pulldown-cmark always closes with `\n</code>` for fence bodies.
    const out = extractMathSource(
      `<pre><code class="language-math">line1\nline2\n</code></pre>\n`,
    );
    expect(out?.source).toBe("line1\nline2");
  });
});

describe("buildMathPlaceholderHtml", () => {
  test("emits a display placeholder with the pending flag", () => {
    const html = buildMathPlaceholderHtml("E=mc^2");
    expect(html).toContain(`class="tugx-katex tugx-katex--display"`);
    expect(html).toContain(`data-tugx-math="display"`);
    expect(html).toContain(`data-tugx-math-pending="true"`);
    expect(html).toContain("E=mc^2");
  });

  test("escapes `&` and `<` so innerHTML round-trips losslessly", () => {
    const html = buildMathPlaceholderHtml("a < b && c");
    // Re-escaped for the innerHTML write so the textContent round-trip
    // reads back as the original source.
    expect(html).toContain("a &lt; b &amp;&amp; c");
  });
});

describe("mathTransformer.transform", () => {
  test("promotes a math fence to tug-math-display", () => {
    const block = codeBlock("math", "E=mc^2\n");
    const out = mathTransformer.transform(block, { isComplete: true, index: 0, source: "" });
    expect(out.length).toBe(1);
    expect(out[0].type).toBe("tug-math-display");
    expect(out[0].html).toContain(`data-tugx-math="display"`);
    expect(out[0].html).toContain("E=mc^2");
  });

  test("promotes a latex fence to tug-math-display", () => {
    const block = codeBlock("latex", "\\alpha\n");
    const out = mathTransformer.transform(block, { isComplete: true, index: 0, source: "" });
    expect(out[0].type).toBe("tug-math-display");
  });

  test("promotes a tex fence to tug-math-display", () => {
    const block = codeBlock("tex", "\\beta\n");
    const out = mathTransformer.transform(block, { isComplete: true, index: 0, source: "" });
    expect(out[0].type).toBe("tug-math-display");
  });

  test("passes a non-math fenced code block through unchanged", () => {
    const block = codeBlock("ts", "const x = 1;\n");
    const out = mathTransformer.transform(block, { isComplete: true, index: 0, source: "" });
    expect(out.length).toBe(1);
    expect(out[0]).toBe(block);
  });

  test("passes a fenced code block with no language through unchanged", () => {
    const block: SanitizedMarkdownBlock = {
      ...codeBlock("ts", "x\n"),
      html: `<pre><code>x\n</code></pre>\n`,
    };
    const out = mathTransformer.transform(block, { isComplete: true, index: 0, source: "" });
    expect(out[0]).toBe(block);
  });

  test("passes a non-code block through unchanged", () => {
    const block: SanitizedMarkdownBlock = {
      html: "<p>not a fence</p>",
      type: "paragraph",
      startChar: 0,
      endChar: 12,
      depth: 0,
      itemCount: 0,
      rowCount: 0,
      contentHash: 0n,
    };
    const out = mathTransformer.transform(block, { isComplete: true, index: 0, source: "" });
    expect(out[0]).toBe(block);
  });

  test("defers promotion while streaming (isComplete: false)", () => {
    const block = codeBlock("math", "E=mc^2\n");
    const out = mathTransformer.transform(block, { isComplete: false, index: 0, source: "" });
    expect(out.length).toBe(1);
    expect(out[0]).toBe(block);
    expect(out[0].type).toBe("code");
  });

  test("decodes HTML entities embedded in the source", () => {
    const block = codeBlock("math", "x &lt; y\n");
    const out = mathTransformer.transform(block, { isComplete: true, index: 0, source: "" });
    expect(out[0].html).toContain("x &lt; y");
    // The HTML attribute is re-escaped so the textContent round-trip
    // reads back as `x < y` — that's what KaTeX will receive.
  });
});
