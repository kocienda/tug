/**
 * Pure-logic tests for the static fragment tokenizer. We assert the
 * *structure* of the per-line runs (which spans get a class, and that
 * distinct tag classes differ) rather than the generated class strings,
 * which are opaque CodeMirror-internal names.
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  TUG_SYNTAX_SLOTS,
  tokenizeFragment,
  tokenizeFragmentByLangId,
  highlightFragmentToHtml,
} from "../language-registry";

test("tokenizeFragment: keyword + comment land on their lines with distinct classes", async () => {
  const perLine = await tokenizeFragment("const x = 1\n// c", "ts");
  expect(perLine.length).toBe(2);

  // Line 0: a run covering `const` (cols 0..5).
  const kw = perLine[0].find((t) => t.start === 0 && t.end === 5);
  expect(kw).toBeDefined();
  expect(kw!.className.length).toBeGreaterThan(0);

  // Line 1: the comment carries a run with a different class than the keyword.
  expect(perLine[1].length).toBeGreaterThan(0);
  const comment = perLine[1][0];
  expect(comment.className.length).toBeGreaterThan(0);
  expect(comment.className).not.toBe(kw!.className);
});

test("tokenizeFragment: a block comment spanning lines splits per line", async () => {
  const perLine = await tokenizeFragment("/* a\n b */\nx", "ts");
  expect(perLine.length).toBe(3);
  // Both comment lines carry runs (the multi-line node was split).
  expect(perLine[0].length).toBeGreaterThan(0);
  expect(perLine[1].length).toBeGreaterThan(0);
});

test("tokenizeFragment: unknown extension yields per-line empty arrays", async () => {
  const perLine = await tokenizeFragment("anything here\nsecond", "made-up-ext");
  expect(perLine).toEqual([[], []]);
});

test("tokenizeFragmentByLangId: aliases resolve (typescript -> ts)", async () => {
  const perLine = await tokenizeFragmentByLangId("const x = 1", "typescript");
  expect(perLine[0].some((t) => t.start === 0 && t.end === 5)).toBe(true);
});

test("highlightFragmentToHtml: emits slot-class spans and escapes HTML", async () => {
  const html = await highlightFragmentToHtml("const a = '<b>'", "ts");
  expect(html).toContain('<span class="tug-syn-keyword">const</span>');
  expect(html).toContain("&lt;b&gt;"); // the string literal's angle brackets escaped
  expect(html).not.toContain("<b>"); // never raw markup
});

test("highlightFragmentToHtml: unknown language returns escaped, uncolored text", async () => {
  const html = await highlightFragmentToHtml("a < b && c", "not-a-language");
  expect(html).toBe("a &lt; b &amp;&amp; c");
});

/** The page's escape for a span body, so a token is found as written. */
function escaped(token: string): string {
  return token
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** The `tug-syn-*` slots on the span wrapping exactly `token`, or null. */
function slotsOf(html: string, token: string): string[] | null {
  const re = new RegExp(`<span class="([^"]*)">${escaped(token).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}</span>`);
  const m = re.exec(html);
  if (m === null) return null;
  return m[1].split(" ").filter((c) => c.startsWith("tug-syn-")).map((c) => c.slice("tug-syn-".length));
}

const TUGMARK = join(import.meta.dir, "../../../crates/tugmark");

describe("the fence highlighter shares tugcast's slots", () => {
  // tugmark's `highlight.rs` reads the same file: one fixture per grammar
  // tugcast carries, with the salient tokens both highlighters must slot alike.
  const fixtures = JSON.parse(readFileSync(join(TUGMARK, "corpus/highlight/fixtures.json"), "utf8")) as {
    lang: string;
    source: string;
    salient: [string, string][];
  }[];

  for (const fixture of fixtures) {
    test(`${fixture.lang}: salient tokens carry tugcast's slot`, async () => {
      const html = await highlightFragmentToHtml(fixture.source, fixture.lang);
      for (const [token, slot] of fixture.salient) {
        expect({ token, slots: slotsOf(html, token) }).toEqual({ token, slots: [slot] });
      }
    });
  }

  test("a markdown fence keeps its heading, emphasis, monospace and link slots", async () => {
    const html = await highlightFragmentToHtml("# Title\n\nSome *em* and `code` with [a link](https://x.dev).\n", "md");
    for (const slot of ["heading", "emphasis", "monospace", "link"]) {
      expect(html).toContain(`tug-syn-${slot}`);
    }
  });
});

describe("tug-syntax-classes.css", () => {
  const css = readFileSync(join(import.meta.dir, "../../components/tugways/tug-syntax-classes.css"), "utf8");
  const rules = new Map<string, string>();
  for (const m of css.matchAll(/\.tug-syn-([a-z-]+)\s*\{([^}]*)\}/g)) rules.set(m[1], m[2]);
  const kebab = (prop: string): string => prop.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

  test("has one rule per slot, carrying every property the slot sets", () => {
    expect([...rules.keys()].sort()).toEqual(TUG_SYNTAX_SLOTS.map((s) => s.slot).sort());
    for (const { slot, style } of TUG_SYNTAX_SLOTS) {
      const decls = new Map(
        rules
          .get(slot)!
          .split(";")
          .map((d) => d.trim())
          .filter((d) => d !== "")
          .map((d) => {
            const colon = d.indexOf(":");
            return [d.slice(0, colon).trim(), d.slice(colon + 1).trim()] as const;
          }),
      );
      const expected = new Map(Object.entries(style).map(([prop, value]) => [kebab(prop), value as string]));
      expect({ slot, decls: Object.fromEntries(decls) }).toEqual({ slot, decls: Object.fromEntries(expected) });
    }
  });
});
