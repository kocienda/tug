/**
 * tugmark-drift.test — the page's markdown pipeline against the drift golden.
 *
 * tugcast renders streamed markdown natively (`tugmark::render_blocks`) and
 * the page draws what it ships, so the two pipelines must agree block for
 * block. Neither runtime can run the other, so both are held to one
 * checked-in artifact, `tugdeck/crates/tugmark/corpus/golden.json`, which
 * `tugrust/crates/tugcast/tests/tugmark_drift.rs` derives from the corpus and
 * asserts byte for byte on the native side.
 *
 * Here every case prefix in the golden is rendered with
 * `parseMarkdownToSanitizedBlocks` and `DEFAULT_BLOCK_TRANSFORMERS`, and the
 * blocks must carry the same hash, kind, character offsets and counts. HTML
 * is compared canonically: both strings are parsed into a DOM and
 * re-serialized with attributes sorted, so the comparison sees the tree each
 * produces rather than how each serializer spells it.
 */

import { join, dirname } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";

import { initSync } from "../../../../crates/tugmark-wasm/pkg/tugmark_wasm.js";

import { DEFAULT_BLOCK_TRANSFORMERS } from "../block-transformers";
import { parseMarkdownToSanitizedBlocks } from "../parse-markdown-to-sanitized-blocks";

const __dir = dirname(fileURLToPath(import.meta.url));
const wasmPath = join(__dir, "../../../../crates/tugmark-wasm/pkg/tugmark_wasm_bg.wasm");
const goldenPath = join(__dir, "../../../../crates/tugmark/corpus/golden.json");

interface GoldenBlock {
  hash: string;
  kind: string;
  startChar: number;
  endChar: number;
  depth: number;
  itemCount: number;
  rowCount: number;
  html: string;
}

interface GoldenCase {
  name: string;
  text: string;
  blocks: GoldenBlock[];
  prefixes: { end: number; blocks: number[] }[];
}

const golden = JSON.parse(readFileSync(goldenPath, "utf8")) as { cases: GoldenCase[] };

// ---------------------------------------------------------------------------
// Canonical HTML
// ---------------------------------------------------------------------------

const VOID = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr",
]);

const { document: scratchDocument } = new JSDOM("<!DOCTYPE html>").window;

function escapeText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/ /g, "&nbsp;");
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/ /g, "&nbsp;");
}

function serialize(node: Node): string {
  if (node.nodeType === 3) return escapeText((node as Text).data);
  if (node.nodeType === 8) return `<!--${(node as Comment).data}-->`;
  if (node.nodeType !== 1) return "";
  const el = node as Element;
  const name = el.localName;
  const attrs = Array.from(el.attributes)
    .map((a) => `${a.name}="${escapeAttr(a.value)}"`)
    .sort()
    .join(" ");
  const open = attrs === "" ? `<${name}>` : `<${name} ${attrs}>`;
  if (VOID.has(name)) return open;
  const children = Array.from(el.childNodes).map(serialize).join("");
  return `${open}${children}</${name}>`;
}

/** `html` parsed as a `<body>` fragment and re-serialized, attributes sorted. */
function canonical(html: string): string {
  const host = scratchDocument.createElement("div");
  host.innerHTML = html;
  return Array.from(host.childNodes).map(serialize).join("");
}

// ---------------------------------------------------------------------------
// The comparison
// ---------------------------------------------------------------------------

/** The first 16 hex digits of a block hash, as the golden spells it. */
function hashHex(hash: bigint): string {
  return hash.toString(16).padStart(16, "0");
}

function differences(c: GoldenCase): string[] {
  const out: string[] = [];
  for (const prefix of c.prefixes) {
    const text = c.text.slice(0, prefix.end);
    const page = parseMarkdownToSanitizedBlocks(text, {
      transformers: DEFAULT_BLOCK_TRANSFORMERS,
      isComplete: true,
    });
    const expected = prefix.blocks.map((i) => c.blocks[i]);
    const at = `${c.name} @ ${prefix.end}`;
    if (page.length !== expected.length) {
      out.push(`${at}: page ${page.length} blocks, golden ${expected.length}`);
      continue;
    }
    for (let i = 0; i < page.length; i += 1) {
      const p = page[i];
      const g = expected[i];
      const facts = (b: { kind: string; startChar: number; endChar: number; depth: number; itemCount: number; rowCount: number; hash: string }) =>
        `${b.hash} ${b.kind} ${b.startChar}-${b.endChar} d${b.depth} i${b.itemCount} r${b.rowCount}`;
      const pageFacts = facts({ ...p, kind: p.type, hash: hashHex(p.contentHash) });
      const goldenFacts = facts(g);
      if (pageFacts !== goldenFacts) {
        out.push(`${at}, block ${i}: page ${pageFacts} / golden ${goldenFacts}`);
      }
      const pageHtml = canonical(p.html);
      const goldenHtml = canonical(g.html);
      if (pageHtml !== goldenHtml) {
        out.push(`${at}, block ${i} html:\n    page:   ${JSON.stringify(pageHtml)}\n    golden: ${JSON.stringify(goldenHtml)}`);
      }
    }
  }
  return out;
}

beforeAll(() => {
  initSync({ module: readFileSync(wasmPath) });
});

describe("tugmark drift golden", () => {
  test("covers the constructs, the hostile documents and the catalog streams", () => {
    const groups = new Set(golden.cases.map((c) => c.name.split("/")[0]));
    expect([...groups].sort()).toEqual(["constructs", "hostile", "streams"]);
  });

  for (const c of golden.cases) {
    test(c.name, () => {
      expect(differences(c)).toEqual([]);
    });
  }
});
