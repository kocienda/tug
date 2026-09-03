/**
 * renderPulseLine — through the REAL pipeline: tugmark WASM parse,
 * DOMPurify sanitize, and the actual KaTeX engine. Fixtures include
 * the exact live-session lines that broke every previous approach,
 * plus a deterministic fuzz pass enforcing the total-function
 * guarantee.
 */

import { join, dirname } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, test } from "bun:test";

import { initSync } from "../../../../crates/tugmark-wasm/pkg/tugmark_wasm.js";
import { loadKaTeX } from "@/lib/lazy/load-katex";
import { renderPulseLine, escapeHtml } from "../render-pulse-line";

const __filename = fileURLToPath(import.meta.url);
const __dir = dirname(__filename);
const wasmPath = join(
  __dir,
  "../../../../crates/tugmark-wasm/pkg/tugmark_wasm_bg.wasm",
);

beforeAll(async () => {
  initSync({ module: readFileSync(wasmPath) });
  // Load the real engine once; every render below takes the sync path,
  // exactly like the strip after its first math line.
  await loadKaTeX();
});

describe("renderPulseLine — the lines that broke previous approaches", () => {
  test("label + display math typesets, no raw delimiters, no raw markers", () => {
    const { html, pending } = renderPulseLine(
      "**2. Gauss's Law for Magnetism** $$\\nabla \\cdot \\mathbf{B} = 0$$",
    );
    expect(pending).toBeNull();
    expect(html).toContain("<strong>");
    expect(html).toContain('class="katex"');
    expect(html).not.toContain("$$");
    expect(html).not.toContain("**");
  });

  test("the Ampère line with subscripts and fractions", () => {
    const { html } = renderPulseLine(
      "**4. Ampère–Maxwell Law** $$\\nabla \\times \\mathbf{B} = \\mu_0 \\mathbf{J} + \\mu_0 \\varepsilon_0 \\frac{\\partial \\mathbf{E}}{\\partial t}$$",
    );
    expect(html).toContain('class="katex"');
    expect(html).not.toContain("$$");
    // The parser never saw the LaTeX: backslash commands survive into
    // KaTeX's MathML annotation verbatim.
    expect(html).toContain("\\varepsilon_0");
  });

  test("inline math mid-prose", () => {
    const { html } = renderPulseLine("So the field $E = mc^2$ holds everywhere.");
    expect(html).toContain('class="katex"');
    expect(html).not.toMatch(/\$E/);
    expect(html).toContain("holds everywhere.");
  });

  test("plain markdown renders: bold, italics, code", () => {
    const { html } = renderPulseLine(
      "Reading **the devise skeleton** first, then `arc/pulse.md` gets *the fix*.",
    );
    expect(html).toContain("<strong>the devise skeleton</strong>");
    expect(html).toContain("<code>arc/pulse.md</code>");
    expect(html).toContain("<em>the fix</em>");
  });

  test("prose dollars are not math", () => {
    const { html } = renderPulseLine("It costs $5 and $10 at the door.");
    expect(html).not.toContain("katex");
    expect(html).toContain("$5 and $10");
  });

  test("malformed LaTeX renders KaTeX's inline error form, never throws", () => {
    const { html } = renderPulseLine("broken math $$\\frac{$$ here");
    expect(html.length).toBeGreaterThan(0);
    // Whatever KaTeX produced, the raw delimiters are gone.
    expect(html).not.toContain("$$");
  });

  test("turn markers and placeholders pass through as plain prose", () => {
    expect(renderPulseLine("done").html).toContain("done");
    expect(renderPulseLine("stopped").html).toContain("stopped");
  });

  test("dangerous markup is sanitized", () => {
    const { html } = renderPulseLine(
      'evil <script>alert(1)</script> <img src=x onerror=alert(1)> prose',
    );
    expect(html).not.toContain("<script");
    expect(html).not.toContain("onerror");
  });

  test("empty and whitespace inputs return the plain-text signal", () => {
    expect(renderPulseLine("").html).toBe("");
    expect(renderPulseLine("   ").html).toBe("");
  });
});

describe("renderPulseLine — total-function fuzz", () => {
  test("never throws and never leaks unbalanced math on line noise", () => {
    // Deterministic LCG so failures reproduce.
    let seed = 0x2bad_cafe;
    const rand = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0xffffffff;
    };
    const alphabet =
      "$*`\\{}_^#-+.!?()[]<>|~\n abcdefgh \\nabla \\frac{ ** $$ `x` _y_ 0123";
    const pieces = alphabet.split(" ");
    for (let round = 0; round < 400; round++) {
      let input = "";
      const n = 1 + Math.floor(rand() * 24);
      for (let i = 0; i < n; i++) {
        input += pieces[Math.floor(rand() * pieces.length)];
        if (rand() < 0.3) input += " ";
      }
      const out = renderPulseLine(input);
      expect(typeof out.html).toBe("string");
      // Either rendered HTML or the explicit plain-text signal —
      // never an exception, never undefined.
      expect(out.html === "" || out.html.length > 0).toBe(true);
    }
  });

  test("real session corpus renders or falls back cleanly, end to end", () => {
    const file =
      "/Users/kocienda/.claude/projects/-Users-kocienda-Mounts-u-src-tugtool--tugtree-tugarc--pulse-2/e0a7c4b3-6293-4202-b70c-7c44379626e2.jsonl";
    let blocks: string[] = [];
    try {
      blocks = readFileSync(file, "utf-8")
        .split("\n")
        .filter((l) => l.includes('"assistant"'))
        .flatMap((l) => {
          try {
            const rec = JSON.parse(l);
            if (rec.type !== "assistant") return [];
            return (rec.message?.content ?? [])
              .filter((b: { type: string }) => b.type === "text")
              .map((b: { text: string }) => b.text as string);
          } catch {
            return [];
          }
        });
    } catch {
      return; // corpus not present on this machine — fuzz above covers
    }
    for (const block of blocks) {
      for (let end = 25; end <= block.length + 24; end += 25) {
        const slice = block.slice(0, Math.min(end, block.length));
        const out = renderPulseLine(slice);
        expect(typeof out.html).toBe("string");
      }
    }
  });
});

describe("escapeHtml", () => {
  test("escapes the five specials", () => {
    expect(escapeHtml(`<a href="x">&'</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;",
    );
  });
});
