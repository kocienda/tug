/**
 * Tests for the composed Astro grammar: the outer split into frontmatter and
 * template, and that both bodies highlight through the shared tokenizer.
 */

import { test, expect } from "bun:test";
import { astroRegions } from "../astro-language";
import { tokenizeFragment, languageLabelFor, languageIdForPath } from "../language-registry";

const SOURCE = [
  "---",
  "const title: string = \"Tug\";",
  "---",
  "<h1 class=\"big\">{title}</h1>",
].join("\n");

test("astroRegions: a closed fence splits frontmatter from template", () => {
  const { fences, frontmatter, template } = astroRegions(SOURCE);
  expect(fences.length).toBe(2);
  expect(SOURCE.slice(...frontmatter!)).toBe("const title: string = \"Tug\";\n");
  expect(SOURCE.slice(...template)).toBe("\n<h1 class=\"big\">{title}</h1>");
});

test("astroRegions: no opening fence, or an unclosed one, is all template", () => {
  expect(astroRegions("<p>hi</p>").frontmatter).toBeNull();
  const unclosed = "---\nconst a = 1;\n<p/>";
  const regions = astroRegions(unclosed);
  expect(regions.frontmatter).toBeNull();
  expect(regions.template).toEqual([0, unclosed.length]);
});

test("tokenizeFragment: astro highlights the frontmatter as TypeScript and the template as HTML", async () => {
  const perLine = await tokenizeFragment(SOURCE, "astro");
  expect(perLine.length).toBe(4);
  // Line 1: `const` keyword (cols 0..5) from the TypeScript grammar.
  expect(perLine[1].some((t) => t.start === 0 && t.end === 5)).toBe(true);
  // Line 2: the closing fence is styled.
  expect(perLine[2].length).toBeGreaterThan(0);
  // Line 3: the `h1` tag name (cols 1..3) from the HTML grammar.
  expect(perLine[3].some((t) => t.start === 1 && t.end === 3)).toBe(true);
});

test("registry: .astro files are labeled Astro", () => {
  expect(languageLabelFor("src/pages/index.astro")).toBe("Astro");
  expect(languageIdForPath("src/pages/index.astro")).toBe("astro");
});
