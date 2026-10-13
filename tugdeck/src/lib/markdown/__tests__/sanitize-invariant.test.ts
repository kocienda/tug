/**
 * sanitize-invariant.test.ts — the page's half of the sanitizer invariant,
 * the exact DOMPurify pin, and tugmark's port held to the installed DOMPurify.
 *
 * The invariant (`sanitize-invariant-check.ts`): every element is in
 * `ALLOWED_TAGS`, every attribute in `ALLOWED_ATTR`, every `href`/`src`
 * relative or a safe scheme (`data:` only on `img src`), and no
 * `data-`/`aria-` attribute survives — except the vocabulary written after
 * the sanitizer, each in the one shape that writes it. tugcast's half is
 * `tugrust/crates/tugcast/tests/tugmark_invariant.rs`.
 * The cases are the golden's blocks and DOMPurify's own regression payloads
 * (`crates/tugmark/corpus/dompurify/payloads.json`), through the page's
 * markdown pipeline, through the second barrier, and through DOMPurify with
 * the shared config directly — and a seeded fuzz over random markdown and
 * HTML fragments (`crates/tugmark/corpus/fuzz/atoms.json`), whose output is
 * reparsed by jsdom rather than read off the string. Every other case's
 * output is DOMPurify's (or html5ever's) serialization, where text is escaped
 * and attribute values quoted, so the tags can be read off it without a DOM.
 *
 * The port: `sanitize.rs` hand-ports DOMPurify's URI test, its XML-breakout
 * test, its attribute whitespace class and three of its default lists. Each
 * is compared, as text, to the `purify.es.mjs` installed beside it, so a
 * DOMPurify bump that moves any of them fails here rather than diverging.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { initSync, parse_blocks_to_html } from "../../../../crates/tugmark-wasm/pkg/tugmark_wasm.js";

import { DEFAULT_BLOCK_TRANSFORMERS } from "../block-transformers";
import { getDOMPurify, SANITIZE_CONFIG } from "../dompurify-instance";
import { parseMarkdownToSanitizedBlocks } from "../parse-markdown-to-sanitized-blocks";
import { sanitizeRenderedHtml } from "../rendered-barrier";
import { type Attr, violations, violationsIn } from "./sanitize-invariant-check";

const TUGDECK = join(import.meta.dir, "../../../..");
const read = (rel: string): string => readFileSync(join(TUGDECK, rel), "utf8");

const GOLDEN = JSON.parse(read("crates/tugmark/corpus/golden.json")) as {
  cases: { blocks: { hash: string; html: string }[] }[];
};
const PAYLOADS = JSON.parse(read("crates/tugmark/corpus/dompurify/payloads.json")) as {
  version: string;
  cases: { title: string; payload: string }[];
};

beforeAll(() => {
  initSync({ module: readFileSync(join(TUGDECK, "crates/tugmark-wasm/pkg/tugmark_wasm_bg.wasm")) });
});

// ---------------------------------------------------------------------------
// The invariant
// ---------------------------------------------------------------------------

describe("the invariant", () => {
  test("catches what it names", () => {
    expect(violations("<script>x</script>")).toContain("element <script>");
    expect(violations('<p onclick="x">a</p>')).toContain("attribute onclick on <p>");
    expect(violations('<a href="javascript:alert(1)">a</a>')).toContain('url href="javascript:alert(1)" on <a>');
    expect(violations('<p data-x="1">a</p>')).toContain("attribute data-x on <p>");
    expect(violations('<p data-tugx-math="display">a</p>')).toContain("attribute data-tugx-math on <p>");
    expect(violations('<p class="tugx-katex">a</p>')).toContain('class "tugx-katex" on <p>');
    expect(violations('<span class="tugx-mermaid">a</span>')).toContain('class "tugx-mermaid" on <span>');
    expect(violations('<h1 id="top">a</h1>')).toContain('id "top" on <h1>');
    expect(violations('<div class="footnote-definition" id="1">a</div>')).toContain('id "1" on <div>');
    expect(violations('<a href="#top">a</a>')).toContain('fragment href="#top" on <a>');
    expect(
      violations(
        '<p><a href="https://x/a:b">a</a> <a href="#tugfn-1">1</a></p><div class="footnote-definition" id="tugfn-1">n</div>',
      ),
    ).toEqual([]);
  });

  test("holds over every golden block", () => {
    const failures: string[] = [];
    for (const c of GOLDEN.cases) for (const b of c.blocks) for (const v of violations(b.html)) failures.push(`${b.hash}: ${v}`);
    expect(failures).toEqual([]);
  });

  test("holds over every DOMPurify payload, through every page path", () => {
    expect(PAYLOADS.cases.length).toBeGreaterThan(200);
    const failures: string[] = [];
    const purify = getDOMPurify();
    for (const { title, payload } of PAYLOADS.cases) {
      for (const block of parseMarkdownToSanitizedBlocks(payload, { transformers: DEFAULT_BLOCK_TRANSFORMERS })) {
        for (const v of violations(block.html)) failures.push(`${title} (markdown): ${v}`);
      }
      for (const v of violations(sanitizeRenderedHtml({ p: payload }).p)) failures.push(`${title} (barrier): ${v}`);
      for (const v of violations(purify.sanitize(payload, SANITIZE_CONFIG))) failures.push(`${title} (html): ${v}`);
    }
    expect(failures).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The fuzz
// ---------------------------------------------------------------------------

const ALPHABET = JSON.parse(read("crates/tugmark/corpus/fuzz/atoms.json")) as {
  atoms: string[];
  separators: string[];
  hazards: number[];
  sample: { seed: number; cases: string[] };
};

/** The fixed seed CI runs; `just tugmark-fuzz` passes its own. */
const FUZZ_SEED = Number(process.env.TUGMARK_FUZZ_SEED ?? 20261012);
const FUZZ_CASES = Number(process.env.TUGMARK_FUZZ_CASES ?? 1000);

/** mulberry32, the stream tugcast's fuzz draws from too. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (t ^ (t >>> 14)) >>> 0;
  };
}

/**
 * `count` cases from `seed`: one to ten atoms joined by separators, each atom
 * cut short, spliced with a hazard, uppercased, or left whole. The draws are
 * made in the order tugcast's `fuzz_cases` makes them, over code points.
 */
function fuzzCases(seed: number, count: number): string[] {
  const next = mulberry32(seed);
  const pick = <T,>(list: readonly T[]): T => list[next() % list.length];
  const out: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const atoms = 1 + (next() % 10);
    let text = "";
    for (let j = 0; j < atoms; j += 1) {
      if (j > 0) text += pick(ALPHABET.separators);
      let atom = Array.from(pick(ALPHABET.atoms));
      const mutation = next() % 8;
      if (mutation === 0) {
        atom = atom.slice(0, next() % (atom.length + 1));
      } else if (mutation === 1) {
        const at = next() % (atom.length + 1);
        atom.splice(at, 0, String.fromCodePoint(pick(ALPHABET.hazards)));
      } else if (mutation === 2) {
        atom = atom.map((c) => (c >= "a" && c <= "z" ? c.toUpperCase() : c));
      }
      text += atom.join("");
    }
    out.push(text);
  }
  return out;
}

let reparseRoot: HTMLElement | null = null;

/** Every element jsdom's parser builds from `html`, with its attributes. */
function reparse(html: string): { tag: string; attrs: Attr[] }[] {
  if (reparseRoot === null) {
    const { JSDOM } = require("jsdom") as typeof import("jsdom");
    reparseRoot = new JSDOM("<!DOCTYPE html><body><div></div>").window.document.querySelector("div")!;
  }
  reparseRoot.innerHTML = html;
  return Array.from(reparseRoot.querySelectorAll("*"), (el) => ({
    tag: el.localName,
    attrs: Array.from(el.attributes, (a): Attr => [a.name, a.value]),
  }));
}

describe("the fuzz", () => {
  test("a seed builds the cases tugcast's fuzz builds", () => {
    expect(fuzzCases(ALPHABET.sample.seed, ALPHABET.sample.cases.length)).toEqual(ALPHABET.sample.cases);
  });

  test(`holds the invariant over ${FUZZ_CASES} cases at seed ${FUZZ_SEED}, reparsed by jsdom`, () => {
    const failures: string[] = [];
    for (const [i, text] of fuzzCases(FUZZ_SEED, FUZZ_CASES).entries()) {
      const outputs: [string, string][] = [
        ...parseMarkdownToSanitizedBlocks(text, { transformers: DEFAULT_BLOCK_TRANSFORMERS }).map(
          (b): [string, string] => ["markdown", b.html],
        ),
        ["barrier", sanitizeRenderedHtml({ p: text }).p],
        ...(parse_blocks_to_html(text) as string[]).map((h): [string, string] => [
          "barrier over an unsanitized parse",
          sanitizeRenderedHtml({ p: h }).p,
        ]),
      ];
      for (const [path, html] of outputs) {
        for (const v of violationsIn(reparse(html))) failures.push(`case ${i} (${path}): ${v} in ${JSON.stringify(text)}`);
      }
      if (failures.length >= 20) break;
    }
    expect(failures).toEqual([]);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// The pin, and the port held to it
// ---------------------------------------------------------------------------

const SANITIZE_RS = read("crates/tugmark/src/sanitize.rs");
const PURIFY = read("node_modules/dompurify/dist/purify.es.mjs");

/** The string items of a Rust `const NAME: &[&str] = &[ … ];`. */
function rustList(name: string): string[] {
  const m = new RegExp(`const ${name}: &\\[&str\\] = &\\[([\\s\\S]*?)\\];`).exec(SANITIZE_RS);
  if (!m) throw new Error(`sanitize.rs has no list ${name}`);
  return [...m[1].matchAll(/"([^"]*)"/g)].map((s) => s[1]);
}

/** The items of DOMPurify's `const NAME = addToSet({}, [ … ]);`. */
function purifyList(name: string): string[] {
  const m = new RegExp(`const ${name} = addToSet\\(\\{\\}, \\[([^\\]]*)\\]\\)`).exec(PURIFY);
  if (!m) throw new Error(`purify.es.mjs has no list ${name}`);
  return [...m[1].matchAll(/'([^']*)'/g)].map((s) => s[1]);
}

/** The regex literal sanitize.rs quotes in the doc comment that opens with `opener`. */
function rustQuotedRegex(opener: string): string {
  const at = SANITIZE_RS.indexOf(opener);
  if (at < 0) throw new Error(`sanitize.rs has no doc opening ${opener}`);
  const m = /`(\/[^`]+\/[a-z]*)`/.exec(SANITIZE_RS.slice(at));
  if (!m) throw new Error(`no quoted regex after ${opener}`);
  return m[1];
}

const BACKSLASH = String.fromCharCode(92);

/** The code points of a set written as `lo..=hi` and single chars in Rust `'\u{…}'` form. */
function rustCodePoints(body: string): Set<number> {
  const out = new Set<number>();
  const char = `'${BACKSLASH}${BACKSLASH}u\\{([0-9a-fA-F]+)\\}'`;
  for (const m of body.matchAll(new RegExp(`${char}(?:\\.\\.=${char})?`, "g"))) {
    const lo = parseInt(m[1], 16);
    const hi = m[2] ? parseInt(m[2], 16) : lo;
    for (let c = lo; c <= hi; c += 1) out.add(c);
  }
  return out;
}

/** The code points of a JS regex character class written in four-digit escapes. */
function classCodePoints(cls: string): Set<number> {
  const out = new Set<number>();
  const esc = `${BACKSLASH}${BACKSLASH}u([0-9A-Fa-f]{4})`;
  for (const m of cls.matchAll(new RegExp(`${esc}(?:-${esc})?`, "g"))) {
    const lo = parseInt(m[1], 16);
    const hi = m[2] ? parseInt(m[2], 16) : lo;
    for (let c = lo; c <= hi; c += 1) out.add(c);
  }
  return out;
}

describe("the DOMPurify pin", () => {
  test("package.json pins the installed version exactly, and the vendored payloads match it", () => {
    const pinned = (JSON.parse(read("package.json")) as { dependencies: Record<string, string> }).dependencies.dompurify;
    const installed = (JSON.parse(read("node_modules/dompurify/package.json")) as { version: string }).version;
    expect(pinned).toMatch(/^\d+\.\d+\.\d+$/);
    expect(installed).toBe(pinned);
    expect(PAYLOADS.version).toBe(pinned);
  });
});

describe("sanitize.rs's port, against the installed purify.es.mjs", () => {
  test("IS_ALLOWED_URI: the quoted regex is DOMPurify's, and SAFE_URI_SCHEMES is its scheme list", () => {
    const quoted = rustQuotedRegex("/// `IS_ALLOWED_URI`:");
    expect(PURIFY).toContain(`const IS_ALLOWED_URI = seal(${quoted}`);
    const alternation = /^\/\^\(\?:\(\?:\(\?:f\|ht\)tps\?\|([a-z|]+)\):/.exec(quoted);
    expect(alternation).not.toBeNull();
    const schemes = ["http", "https", "ftp", "ftps", ...alternation![1].split("|")];
    expect([...rustList("SAFE_URI_SCHEMES")].sort()).toEqual(schemes.sort());
  });

  test("SAFE_FOR_XML: the quoted regex is DOMPurify's, and the raw-text names are its alternation", () => {
    const quoted = rustQuotedRegex("/// DOMPurify's `SAFE_FOR_XML` attribute test:");
    expect(PURIFY).toContain(`SAFE_FOR_XML && regExpTest(${quoted}, value)`);
    const names = /<\\\/\(([a-z|]+)\)/.exec(quoted)![1].split("|");
    const fn = SANITIZE_RS.slice(SANITIZE_RS.indexOf("fn breaks_out_of_xml"));
    const raw = /const RAW_TEXT: &\[&str\] = &\[([\s\S]*?)\];/.exec(fn)![1];
    expect([...raw.matchAll(/"([^"]*)"/g)].map((s) => s[1])).toEqual(names);
  });

  test("ATTR_WHITESPACE: is_attr_whitespace matches DOMPurify's class", () => {
    const m = /const ATTR_WHITESPACE = seal\(\/\[([^\]]*)\]\/g/.exec(PURIFY);
    expect(m).not.toBeNull();
    const body = /fn is_attr_whitespace[\s\S]*?matches!\(([\s\S]*?)\)\s*\}/.exec(SANITIZE_RS)![1];
    expect([...rustCodePoints(body)].sort((a, b) => a - b)).toEqual([...classCodePoints(m![1])].sort((a, b) => a - b));
  });

  test("the default lists are DOMPurify's", () => {
    expect(rustList("URI_SAFE_ATTRIBUTES")).toEqual(purifyList("DEFAULT_URI_SAFE_ATTRIBUTES"));
    expect(rustList("DATA_URI_TAGS")).toEqual(purifyList("DEFAULT_DATA_URI_TAGS"));
    expect(rustList("FORBID_CONTENTS")).toEqual(purifyList("DEFAULT_FORBID_CONTENTS"));
  });
});
