/**
 * csp-inline-script-hashes.test.ts — the deck's policy admits its own inline scripts
 * by hash and nothing inline besides.
 *
 * The cases run over strings, plus the real `index.html`: every inline script it
 * carries must come out admitted by hash, and the directive must still carry no
 * `'unsafe-inline'`, which is the clause that keeps a sanitizer survivor inert.
 */

import { describe, expect, test } from "bun:test";
import { createHash } from "crypto";
import { readFileSync } from "fs";
import path from "path";
import { addInlineScriptHashes, inlineScriptBodies, scriptHashSource } from "../csp-inline-script-hashes";

const INDEX_HTML = path.resolve(import.meta.dir, "..", "..", "index.html");

function page(head: string, body: string): string {
  return `<html><head><meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self';">${head}</head><body>${body}</body></html>`;
}

function scriptSrc(html: string): string {
  const m = /<meta\s+http-equiv="Content-Security-Policy"\s+content="[^"]*?\bscript-src\b([^;"]*)/i.exec(html);
  if (!m) throw new Error("no script-src");
  return m[1];
}

describe("inlineScriptBodies", () => {
  test("takes inline scripts and skips src scripts and comments", () => {
    const html = page(
      "<!-- a <script>not this</script> inside a comment -->",
      `<script>one()</script><script type="module" src="/main.tsx"></script><script type="module">two()</script>`,
    );
    expect(inlineScriptBodies(html)).toEqual(["one()", "two()"]);
  });
});

describe("addInlineScriptHashes", () => {
  test("appends one hash per distinct inline script to script-src only", () => {
    const html = page("<script>a()</script>", "<script>b()</script><script>a()</script>");
    const out = addInlineScriptHashes(html);
    const expected = (s: string) => `'sha256-${createHash("sha256").update(s).digest("base64")}'`;
    expect(scriptSrc(out)).toBe(` 'self' 'unsafe-eval' ${expected("a()")} ${expected("b()")}`);
    expect(out).toContain("style-src 'self';");
  });

  test("leaves a page with no inline script unchanged", () => {
    const html = page("", `<script src="/x.js"></script>`);
    expect(addInlineScriptHashes(html)).toBe(html);
  });

  test("refuses a page with no CSP script-src to amend", () => {
    expect(() => addInlineScriptHashes("<html><script>x()</script></html>")).toThrow();
  });

  test("the real index.html: every inline script admitted, nothing inline otherwise", () => {
    const html = readFileSync(INDEX_HTML, "utf8");
    const bodies = inlineScriptBodies(html);
    expect(bodies.length).toBeGreaterThan(0);
    const directive = scriptSrc(addInlineScriptHashes(html));
    expect(directive).not.toContain("'unsafe-inline'");
    for (const body of bodies) expect(directive).toContain(scriptHashSource(body));
  });
});
