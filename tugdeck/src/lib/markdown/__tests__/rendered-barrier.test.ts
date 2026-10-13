/**
 * rendered-barrier.test.ts — the page's sanitize pass over tugcast's renders.
 *
 * The barrier has two obligations, and each is a case below: it changes
 * nothing tugmark legitimately emits — every golden block, highlighted code,
 * the math and mermaid placeholders — and it strips what a sanitizer miss
 * would carry: handlers, script-bearing elements, unsafe schemes, forged
 * data attributes.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

import {
  resetRenderedBarrier,
  sanitizeRenderedHtml,
  snapshotRenderedBarrier,
} from "../rendered-barrier";

const GOLDEN = join(import.meta.dir, "../../../../crates/tugmark/corpus/golden.json");

interface GoldenCase {
  blocks: { hash: string; html: string }[];
}

/** The element names in document order, and each element's attribute names. */
function shape(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<([a-zA-Z][a-zA-Z0-9]*)([^>]*)>/g)) {
    const attrs = [...m[2].matchAll(/\s([a-zA-Z][a-zA-Z0-9-]*)(?==|\s|$)/g)].map((a) => a[1]).sort();
    out.push(`${m[1].toLowerCase()}[${attrs.join(",")}]`);
  }
  return out;
}

function one(html: string): string {
  return sanitizeRenderedHtml({ h: html }).h;
}

beforeEach(() => resetRenderedBarrier());

describe("the barrier changes nothing tugmark emits", () => {
  test("every golden block keeps its elements and attributes", () => {
    const golden = JSON.parse(readFileSync(GOLDEN, "utf8")) as { cases: GoldenCase[] };
    let checked = 0;
    for (const c of golden.cases) {
      for (const b of c.blocks) {
        expect({ hash: b.hash, shape: shape(one(b.html)) }).toEqual({ hash: b.hash, shape: shape(b.html) });
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(200);
  });

  test("highlighted code keeps its spans and its highlighted stamp", () => {
    const html =
      '<pre><code class="language-rust" data-tug-highlighted=""><span class="tug-syn-keyword">let</span> x = <span class="tug-syn-number">1</span>;\n</code></pre>\n';
    expect(shape(one(html))).toEqual(shape(html));
  });

  test("math and mermaid placeholders survive for the enhancers", () => {
    const math =
      '<div class="tugx-katex tugx-katex--display" data-tugx-math="display" data-tugx-math-pending="true">a &lt; b</div>';
    const mermaid = '<div class="tugx-mermaid" data-tugx-mermaid-pending="true">graph TD\nA--&gt;B</div>';
    expect(one(math)).toBe(math);
    expect(one(mermaid)).toBe(mermaid);
  });

  test("tugcast's footnotes, already under the page's prefix, pass unchanged", () => {
    const html =
      '<p>a<sup class="footnote-reference"><a href="#tugfn-1">1</a></sup></p><div class="footnote-definition" id="tugfn-1"><sup class="footnote-definition-label">1</sup><p>n</p></div>';
    expect(one(html)).toBe(html);
  });
});

describe("the barrier strips what a first-barrier miss would carry", () => {
  const cases: [string, string, RegExp][] = [
    ["a handler attribute", '<p><img src="x.png" onerror="alert(1)"></p>', /onerror/i],
    ["a script element", "<p>a</p><script>alert(1)</script>", /<script/i],
    ["an svg with onload", '<svg onload="alert(1)"><circle/></svg>', /svg|onload/i],
    ["a javascript: link", '<p><a href="javascript:alert(1)">x</a></p>', /javascript:/i],
    ["an iframe", '<iframe src="https://example.com"></iframe>', /iframe/i],
    ["a forged enhancer attribute", '<span data-tugx-annotate="x" data-foo="y">t</span>', /data-tugx-annotate|data-foo/],
    ["a span handler", '<span class="tug-syn-keyword" onclick="alert(1)">t</span>', /onclick/i],
    ["a style element", "<style>body{display:none}</style><p>x</p>", /<style/i],
    ["a span that is not a highlight run", "<p><span>t</span><span class=\"x\">u</span></p>", /<span/],
    ["a math placeholder on another element", "<p data-tugx-math=\"display\" data-tugx-math-pending=\"true\">x</p>", /data-tugx/],
    ["a highlight stamp off code", "<pre data-tug-highlighted=\"\">x</pre>", /data-tug-highlighted/],
    ["a post-sanitize class off its element", '<p class="tugx-katex language-x">x</p>', /tugx-katex/],
    ["a class outside the parser's vocabulary", '<p class="note">x</p>', /class=/],
    ["an id outside the footnote shape", '<h2 id="top">x</h2><div id="root">y</div>', /id=/],
    ["a fragment link outside the page's prefix", '<p><a href="#top">x</a></p>', /href="#top"/],
  ];
  for (const [name, html, banned] of cases) {
    test(name, () => {
      expect(one(html)).not.toMatch(banned);
    });
  }
});

describe("counters", () => {
  test("count emissions that carried HTML, their blocks, and their time", () => {
    sanitizeRenderedHtml({});
    sanitizeRenderedHtml({ a: "<p>a</p>", b: "<p>b</p>" });
    sanitizeRenderedHtml({ c: "<p>c</p>" });
    const snap = snapshotRenderedBarrier();
    expect(snap.deltas).toBe(2);
    expect(snap.blocks).toBe(3);
    expect(snap.totalMs).toBeGreaterThanOrEqual(snap.maxMs);
  });
});
