/**
 * `tugchartTransformer` — the chart fence's promotion.
 *
 * Mirrors `math-transformer.test.ts`, with the one gate that differs:
 * promotion follows the block's own source being a closed fence, never
 * `isComplete`. The expected strings here are the ones the `tugmark`
 * port's tests (`tugdeck/crates/tugmark/src/transform.rs`) assert, so
 * the two sides are held to the same bytes.
 *
 * Pure-logic: synthetic block records, no DOM, no WASM.
 */

import { describe, expect, test } from "bun:test";

import {
  buildChartPlaceholderHtml,
  decodeTugchartEntities,
  extractTugchartSource,
  fenceIsClosed,
  tugchartTransformer,
} from "../block-transformers/tugchart";
import type { SanitizedMarkdownBlock } from "../parse-markdown-to-sanitized-blocks";

function codeBlock(langClass: string, inner: string): SanitizedMarkdownBlock {
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

const CLOSED = "```tugchart\n{}\n```\n";
const OPEN = "```tugchart\n{}\n";

describe("decodeTugchartEntities", () => {
  test("decodes the entity set pulldown-cmark emits, `&amp;` last", () => {
    expect(decodeTugchartEntities("a &amp; b &lt; c &gt; d &quot; e &#39; f")).toBe(`a & b < c > d " e ' f`);
    expect(decodeTugchartEntities("&amp;lt;")).toBe("&lt;");
  });
});

describe("extractTugchartSource", () => {
  test("extracts and decodes a ```tugchart fence", () => {
    const out = extractTugchartSource(
      `<pre><code class="language-tugchart">{&quot;a&quot;: &quot;x &lt; y&quot;}\n</code></pre>\n`,
    );
    expect(out).toEqual({ lang: "tugchart", source: `{"a": "x < y"}` });
  });

  test("language match is case-insensitive and exact", () => {
    expect(extractTugchartSource(`<pre><code class="language-TugChart">{}\n</code></pre>\n`)?.lang).toBe("tugchart");
    expect(extractTugchartSource(`<pre><code class="language-tugchartx">x\n</code></pre>\n`)).toBeNull();
    expect(extractTugchartSource(`<pre><code class="language-json">x\n</code></pre>\n`)).toBeNull();
    expect(extractTugchartSource(`<pre><code>x</code></pre>\n`)).toBeNull();
    expect(extractTugchartSource(`<p>{}</p>`)).toBeNull();
  });
});

describe("fenceIsClosed", () => {
  test("a closing run of the opening character, at least as long", () => {
    expect(fenceIsClosed("```tugchart\n{}\n```")).toBe(true);
    expect(fenceIsClosed(CLOSED)).toBe(true);
    expect(fenceIsClosed("```tugchart\n{}\n   ````  \n\n")).toBe(true);
    expect(fenceIsClosed("~~~tugchart\n{}\n~~~")).toBe(true);
  });

  test("anything short of that is still open", () => {
    expect(fenceIsClosed(OPEN)).toBe(false);
    expect(fenceIsClosed("```tugchart\n{}")).toBe(false);
    expect(fenceIsClosed("```tugchart")).toBe(false);
    expect(fenceIsClosed("```tugchart\n```x\n")).toBe(false);
    expect(fenceIsClosed("```tugchart\n    ```\n")).toBe(false);
    expect(fenceIsClosed("```tugchart\n{}\n~~~\n")).toBe(false);
    expect(fenceIsClosed("")).toBe(false);
  });

  test("a four-backtick fence holds a three-backtick line open", () => {
    expect(fenceIsClosed("````tugchart\n{}\n```\n")).toBe(false);
    expect(fenceIsClosed("````tugchart\n{}\n```\n````\n")).toBe(true);
  });
});

describe("buildChartPlaceholderHtml", () => {
  test("is byte-exact, escaping `&` and `<` only", () => {
    expect(buildChartPlaceholderHtml(`{"a": "x < y & z"}`)).toBe(
      `<div class="tugx-chart" data-tugx-chart-pending="true">{"a": "x &lt; y &amp; z"}</div>`,
    );
  });
});

describe("tugchartTransformer.transform", () => {
  test("promotes a closed fence, whatever isComplete says", () => {
    const block = codeBlock("tugchart", "{}\n");
    for (const isComplete of [true, false]) {
      const out = tugchartTransformer.transform(block, { isComplete, index: 0, source: CLOSED });
      expect(out.length).toBe(1);
      expect(out[0].type).toBe("tug-chart");
      expect(out[0].html).toBe(`<div class="tugx-chart" data-tugx-chart-pending="true">{}</div>`);
    }
  });

  test("leaves an unclosed fence as code, whatever isComplete says", () => {
    const block = codeBlock("tugchart", "{}\n");
    for (const isComplete of [true, false]) {
      const out = tugchartTransformer.transform(block, { isComplete, index: 0, source: OPEN });
      expect(out.length).toBe(1);
      expect(out[0]).toBe(block);
      expect(out[0].type).toBe("code");
    }
  });

  test("with no source, a fence is open", () => {
    const out = tugchartTransformer.transform(codeBlock("tugchart", "{}\n"), { isComplete: true, index: 0, source: "" });
    expect(out[0].type).toBe("code");
  });

  test("passes other fences and non-code blocks through unchanged", () => {
    const ctx = { isComplete: true, index: 0, source: CLOSED };
    const ts = codeBlock("ts", "const x = 1;\n");
    expect(tugchartTransformer.transform(ts, ctx)[0]).toBe(ts);
    const json = codeBlock("json", "{}\n");
    expect(tugchartTransformer.transform(json, ctx)[0]).toBe(json);
    const paragraph: SanitizedMarkdownBlock = { ...codeBlock("ts", "x"), html: "<p>not a fence</p>", type: "paragraph" };
    expect(tugchartTransformer.transform(paragraph, ctx)[0]).toBe(paragraph);
  });

  test("decodes entities in the source and re-escapes for innerHTML", () => {
    const block = codeBlock("tugchart", "{&quot;t&quot;: &quot;a &lt; b &amp; c&quot;}\n");
    const out = tugchartTransformer.transform(block, { isComplete: true, index: 0, source: CLOSED });
    expect(out[0].html).toBe(
      `<div class="tugx-chart" data-tugx-chart-pending="true">{"t": "a &lt; b &amp; c"}</div>`,
    );
  });
});
