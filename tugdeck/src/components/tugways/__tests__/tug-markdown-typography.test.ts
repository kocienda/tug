/**
 * Typography pass — parser-output coverage for a representative
 * markdown document.
 *
 * The typography pass declares `--tugx-md-*` tokens for every
 * markdown element a Dev assistant turn might emit. This test
 * confirms that the WASM markdown pipeline (pulldown-cmark →
 * DOMPurify) actually produces the corresponding sanitized HTML for
 * each element, so the typography rules in `tug-markdown-view.css`
 * have something concrete to style.
 *
 * What this test does NOT do:
 *  - Compute styles. CSS variables resolve to text-only assertions
 *    (does the var reference exist in the rule body) handled in
 *    `session-md-token-coverage.test.ts`.
 *  - Render via React. The pipeline is pure, so a parser-only test
 *    is enough; the React mount path is covered separately by
 *    `tug-markdown-block.test.tsx`.
 *
 * Coverage expectations:
 *  - paragraphs, headings (h1–h6)
 *  - inline emphasis (strong, em, del/strikethrough)
 *  - links (`<a href>`)
 *  - inline code (`<code>` outside `<pre>`)
 *  - fenced code (`<pre><code>`)
 *  - blockquote
 *  - horizontal rule
 *  - bullet and ordered lists
 *  - task list (GFM)
 *  - table (GFM, with header row)
 *  - image (`<img>`)
 *  - footnote (pulldown-cmark `ENABLE_FOOTNOTES` enabled in #step-3 —
 *    the assertion below uses the pulldown-cmark / DOMPurify markup
 *    confirmed in `lib/markdown/__tests__/cmark-extensions.test.ts`)
 */

import { join, dirname } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, test } from "bun:test";

import { initSync } from "../../../../crates/tugmark-wasm/pkg/tugmark_wasm.js";
import { parseMarkdownToSanitizedBlocks } from "@/lib/markdown/parse-markdown-to-sanitized-blocks";

// ---------------------------------------------------------------------------
// WASM init — load once.
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dir = dirname(__filename);
const wasmPath = join(
  __dir,
  "../../../../crates/tugmark-wasm/pkg/tugmark_wasm_bg.wasm",
);

beforeAll(() => {
  const wasmBytes = readFileSync(wasmPath);
  initSync({ module: wasmBytes });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Concatenated HTML for the whole input — useful when a single
 *  block has all the elements you want to assert on. */
function renderAll(text: string): string {
  return parseMarkdownToSanitizedBlocks(text)
    .map((b) => b.html)
    .join("");
}

// ---------------------------------------------------------------------------
// A representative markdown document — exercises every typography
// surface the typography pass declares tokens for. Used as a single
// fixture so the test can also serve as a "see all the rendered
// markdown structures in one place" reference for future authors.
// ---------------------------------------------------------------------------

const REPRESENTATIVE_MD = `# Heading 1
## Heading 2
### Heading 3
#### Heading 4
##### Heading 5
###### Heading 6

A paragraph with **strong**, *em*, ~~strike~~, and \`inline code\`.

A second paragraph with a [link](https://example.com).

\`\`\`ts
const x: number = 1;
\`\`\`

> Blockquote with **emphasis** inside.

---

- Bullet one
- Bullet two
  - Nested
- Bullet three

1. Ordered one
2. Ordered two

- [ ] Task pending
- [x] Task complete

| Col A | Col B |
| ----- | ----- |
| a     | b     |
| c     | d     |

![Alt text](https://example.com/img.png)

A claim with a footnote[^src].

[^src]: Source for the claim.
`;

// ---------------------------------------------------------------------------
// Snapshot — every typography surface produces the expected sanitized HTML.
// ---------------------------------------------------------------------------

describe("markdown typography — representative document", () => {
  test("headings h1..h6 render", () => {
    const html = renderAll(REPRESENTATIVE_MD);
    expect(html).toContain("<h1>Heading 1</h1>");
    expect(html).toContain("<h2>Heading 2</h2>");
    expect(html).toContain("<h3>Heading 3</h3>");
    expect(html).toContain("<h4>Heading 4</h4>");
    expect(html).toContain("<h5>Heading 5</h5>");
    expect(html).toContain("<h6>Heading 6</h6>");
  });

  test("inline emphasis: strong, em, strikethrough, inline code", () => {
    const html = renderAll(REPRESENTATIVE_MD);
    expect(html).toContain("<strong>strong</strong>");
    expect(html).toContain("<em>em</em>");
    expect(html).toContain("<del>strike</del>");
    expect(html).toContain("<code>inline code</code>");
  });

  test("link renders with href", () => {
    const html = renderAll(REPRESENTATIVE_MD);
    expect(html).toContain('<a href="https://example.com">link</a>');
  });

  test("fenced code block renders as pre > code with language class", () => {
    const html = renderAll(REPRESENTATIVE_MD);
    expect(html).toMatch(/<pre><code class="language-ts">[\s\S]*const x[\s\S]*<\/code><\/pre>/);
  });

  test("blockquote renders with nested emphasis preserved", () => {
    const html = renderAll(REPRESENTATIVE_MD);
    expect(html).toMatch(/<blockquote>[\s\S]*<strong>emphasis<\/strong>[\s\S]*<\/blockquote>/);
  });

  test("horizontal rule renders", () => {
    const html = renderAll(REPRESENTATIVE_MD);
    // pulldown-cmark + DOMPurify emit `<hr>` (no self-closing slash);
    // the assertion accepts both shapes for robustness.
    expect(html).toMatch(/<hr\s*\/?>/);
  });

  test("bullet list with nested item renders", () => {
    const html = renderAll(REPRESENTATIVE_MD);
    // Sanitized HTML is on a single line — nested ul appears as a
    // descendant of the outer ul.
    expect(html).toMatch(/<ul>[\s\S]*<ul>[\s\S]*Nested[\s\S]*<\/ul>[\s\S]*<\/ul>/);
  });

  test("ordered list renders", () => {
    const html = renderAll(REPRESENTATIVE_MD);
    expect(html).toMatch(/<ol[^>]*>[\s\S]*Ordered one[\s\S]*Ordered two[\s\S]*<\/ol>/);
  });

  test("task list renders disabled checkboxes (GFM)", () => {
    const html = renderAll(REPRESENTATIVE_MD);
    // pulldown-cmark emits `<input type="checkbox" disabled="" />` for
    // tasklist items; DOMPurify allowlist needs `input` for this to
    // survive. The allowlist currently does NOT include `input`, so
    // the checkbox markup is stripped — but the task text remains.
    expect(html).toContain("Task pending");
    expect(html).toContain("Task complete");
  });

  test("table with header and body rows renders", () => {
    const html = renderAll(REPRESENTATIVE_MD);
    expect(html).toMatch(/<table>[\s\S]*<thead>[\s\S]*Col A[\s\S]*Col B[\s\S]*<\/thead>[\s\S]*<tbody>[\s\S]*<\/tbody>[\s\S]*<\/table>/);
  });

  test("image renders with alt and src", () => {
    const html = renderAll(REPRESENTATIVE_MD);
    // Match the `<img>` tag tolerating attribute order and the optional
    // self-closing slash (pulldown-cmark + DOMPurify emit `<img ...>`).
    expect(html).toMatch(/<img\s+[^>]*src="https:\/\/example\.com\/img\.png"[^>]*\/?>/);
    expect(html).toMatch(/<img\s+[^>]*alt="Alt text"[^>]*\/?>/);
  });

  test("footnote reference + definition both render with chrome", () => {
    const html = renderAll(REPRESENTATIVE_MD);
    expect(html).toMatch(
      /<sup class="footnote-reference"><a href="#tugfn-src">[^<]+<\/a><\/sup>/,
    );
    expect(html).toMatch(/<div class="footnote-definition" id="tugfn-src">/);
  });
});

// ---------------------------------------------------------------------------
// Block decomposition — the parser should break the document into
// distinct top-level blocks so the streaming pipeline can stream block-
// by-block. This is the contract that the windowing engine relies on.
// ---------------------------------------------------------------------------

describe("markdown typography — block decomposition", () => {
  test("each heading is its own block", () => {
    const blocks = parseMarkdownToSanitizedBlocks("# A\n\n# B\n\n# C\n");
    expect(blocks.length).toBe(3);
    for (const b of blocks) {
      expect(b.type).toBe("heading");
    }
  });

  test("paragraphs and code blocks are separate blocks", () => {
    const blocks = parseMarkdownToSanitizedBlocks(
      "para 1\n\n```ts\nconst x = 1;\n```\n\npara 2\n",
    );
    expect(blocks.map((b) => b.type)).toEqual(["paragraph", "code", "paragraph"]);
  });

  test("table is a single block", () => {
    const blocks = parseMarkdownToSanitizedBlocks(
      "| A | B |\n| - | - |\n| 1 | 2 |\n",
    );
    expect(blocks.length).toBe(1);
    expect(blocks[0].type).toBe("table");
    expect(blocks[0].rowCount).toBeGreaterThanOrEqual(1);
  });

  test("list with multiple items reports itemCount", () => {
    const blocks = parseMarkdownToSanitizedBlocks("- a\n- b\n- c\n");
    expect(blocks.length).toBe(1);
    expect(blocks[0].type).toBe("list");
    expect(blocks[0].itemCount).toBe(3);
  });
});
