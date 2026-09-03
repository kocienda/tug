/**
 * Pulldown-cmark extension coverage — footnotes + smart-punctuation.
 *
 * #step-3 enables `Options::ENABLE_FOOTNOTES` and
 * `Options::ENABLE_SMART_PUNCTUATION` in `tugmark-wasm`. This file
 * confirms both extensions are live in the lex/parse/sanitize pipeline
 * and that the post-DOMPurify HTML carries the expected markup.
 *
 * What this guards against:
 *  - A regression that disables either option in `parser_options`.
 *  - A DOMPurify allowlist change that strips footnote chrome (the
 *    `<div class="footnote-definition" id="N">` wrapper is the
 *    fragile piece — `id` survives only because the allowlist
 *    explicitly allows `div`).
 *
 * Smart-punctuation Unicode reference:
 *   `--`     → U+2013 EN ARC       (–)
 *   `---`    → U+2014 EM ARC       (—)
 *   `...`    → U+2026 HORIZONTAL …  (…)
 *   `"x"`    → U+201C / U+201D      (“ ”)
 *   `'x'`    → U+2018 / U+2019      (‘ ’)
 *
 * The exact characters are the test's contract: a future change that
 * (say) rewrites em-arc to a different glyph would surface here
 * instead of silently shipping different prose to users.
 */

import { join, dirname } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, test } from "bun:test";

import { initSync } from "../../../../crates/tugmark-wasm/pkg/tugmark_wasm.js";
import { parseMarkdownToSanitizedBlocks } from "../parse-markdown-to-sanitized-blocks";

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

function renderAll(text: string): string {
  return parseMarkdownToSanitizedBlocks(text)
    .map((b) => b.html)
    .join("");
}

// ---------------------------------------------------------------------------
// Footnotes
// ---------------------------------------------------------------------------

const FOOTNOTE_MD = `Here is a reference[^1] and another[^note].

[^1]: First footnote body.

[^note]: Second footnote with **emphasis** inside.
`;

describe("pulldown-cmark — footnotes", () => {
  test("inline reference renders as <sup class=\"footnote-reference\"><a href=\"#…\">", () => {
    const html = renderAll(FOOTNOTE_MD);
    expect(html).toMatch(
      /<sup class="footnote-reference"><a href="#1">1<\/a><\/sup>/,
    );
    expect(html).toMatch(
      /<sup class="footnote-reference"><a href="#note">[^<]+<\/a><\/sup>/,
    );
  });

  test("definition renders as <div class=\"footnote-definition\" id=\"…\">", () => {
    const html = renderAll(FOOTNOTE_MD);
    expect(html).toMatch(/<div class="footnote-definition" id="1">/);
    expect(html).toMatch(/<div class="footnote-definition" id="note">/);
  });

  test("definition-label sup with the back-reference number is preserved", () => {
    const html = renderAll(FOOTNOTE_MD);
    expect(html).toMatch(
      /<sup class="footnote-definition-label">1<\/sup>/,
    );
  });

  test("definition body preserves nested inline emphasis", () => {
    const html = renderAll(FOOTNOTE_MD);
    expect(html).toMatch(
      /footnote-definition[^>]*id="note"[\s\S]*<strong>emphasis<\/strong>/,
    );
  });

  test("the footnote-definition `id` survives DOMPurify (back-references hit a real anchor)", () => {
    // The reference's href="#1" depends on the corresponding
    // footnote-definition element carrying id="1". A DOMPurify
    // allowlist change that drops `div` (or strips `id`) would break
    // back-jumping silently — this assertion is the canary.
    const html = renderAll(FOOTNOTE_MD);
    const refHrefs = [...html.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]);
    const defIds = [...html.matchAll(/footnote-definition" id="([^"]+)"/g)].map(
      (m) => m[1],
    );
    for (const ref of refHrefs) {
      expect(defIds).toContain(ref);
    }
  });
});

// ---------------------------------------------------------------------------
// Smart-punctuation
// ---------------------------------------------------------------------------

describe("pulldown-cmark — smart-punctuation", () => {
  test("`--` becomes EN ARC", () => {
    expect(renderAll("range a -- b\n")).toContain("a – b");
  });

  test("`---` becomes EM ARC", () => {
    expect(renderAll("aside a --- b\n")).toContain("a — b");
  });

  test("`...` becomes HORIZONTAL ELLIPSIS", () => {
    expect(renderAll("trail a... b\n")).toContain("a… b");
  });

  test("straight double quotes become curly double quotes", () => {
    const html = renderAll('say "foo" please\n');
    // Opening + closing curly double quotes around "foo".
    expect(html).toContain("“foo”");
    // The straight ASCII double-quote should NOT appear in the body
    // text (attribute values are unaffected — pulldown-cmark only
    // converts text-node punctuation).
    expect(html).not.toContain('"foo"');
  });

  test("straight single quotes become curly single quotes", () => {
    const html = renderAll("say 'bar' please\n");
    expect(html).toContain("‘bar’");
  });
});
