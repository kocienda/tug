/**
 * `parseMarkdownToSanitizedBlocks` unit tests.
 *
 * Exercises the shared helper directly:
 *   - empty input → empty array (no WASM call needed).
 *   - simple inline formatting (bold / italic) survives sanitize.
 *   - block kinds: heading, paragraph, code, list, blockquote.
 *   - dangerous markup is stripped by DOMPurify.
 *
 * WASM init pattern mirrors the existing fence-propagation /
 * incremental-tail-update tests: load the `.wasm` bytes once at
 * module scope and `initSync` before any test runs.
 */

import { join, dirname } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, test } from "bun:test";

import { initSync } from "../../../../crates/tugmark-wasm/pkg/tugmark_wasm.js";

import { parseMarkdownToSanitizedBlocks } from "../parse-markdown-to-sanitized-blocks";

// ---------------------------------------------------------------------------
// WASM initialisation — load once
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dir = dirname(__filename);
const wasmPath = join(__dir, "../../../../crates/tugmark-wasm/pkg/tugmark_wasm_bg.wasm");

beforeAll(() => {
  const wasmBytes = readFileSync(wasmPath);
  initSync({ module: wasmBytes });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("parseMarkdownToSanitizedBlocks", () => {
  test("empty input → empty array", () => {
    expect(parseMarkdownToSanitizedBlocks("")).toEqual([]);
  });

  test("simple paragraph yields one paragraph block", () => {
    const blocks = parseMarkdownToSanitizedBlocks("Hello world.");
    expect(blocks.length).toBe(1);
    expect(blocks[0].type).toBe("paragraph");
    expect(blocks[0].html).toContain("Hello world.");
  });

  test("heading + paragraph yields two blocks", () => {
    const blocks = parseMarkdownToSanitizedBlocks("# h\n\npara");
    expect(blocks.length).toBe(2);
    expect(blocks[0].type).toBe("heading");
    expect(blocks[0].depth).toBe(1);
    expect(blocks[0].html).toContain("h");
    expect(blocks[1].type).toBe("paragraph");
    expect(blocks[1].html).toContain("para");
  });

  test("inline emphasis preserved", () => {
    const blocks = parseMarkdownToSanitizedBlocks("**bold** and *italic*");
    expect(blocks.length).toBe(1);
    expect(blocks[0].html).toMatch(/<strong>/);
    expect(blocks[0].html).toMatch(/<em>/);
  });

  test("code fence is parsed as a code block", () => {
    const blocks = parseMarkdownToSanitizedBlocks("```\nconst x = 1;\n```");
    expect(blocks.length).toBe(1);
    expect(blocks[0].type).toBe("code");
    expect(blocks[0].html).toContain("const x = 1;");
  });

  test("list block carries item count metadata", () => {
    const blocks = parseMarkdownToSanitizedBlocks("- a\n- b\n- c");
    expect(blocks.length).toBe(1);
    expect(blocks[0].type).toBe("list");
    expect(blocks[0].itemCount).toBeGreaterThanOrEqual(3);
  });

  test("dangerous <script> markup is sanitized away", () => {
    const blocks = parseMarkdownToSanitizedBlocks(
      "Hello <script>alert(1)</script> world.",
    );
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) {
      expect(block.html).not.toMatch(/<script/i);
      expect(block.html).not.toContain("alert(1)");
    }
  });

  test("a task-list checkbox survives, disabled", () => {
    const blocks = parseMarkdownToSanitizedBlocks("- [x] done\n- [ ] todo");
    expect(blocks.length).toBe(1);
    const html = blocks[0].html;
    expect(html).toMatch(/<input[^>]*type="checkbox"[^>]*checked/);
    expect((html.match(/<input/g) ?? []).length).toBe(2);
    for (const tag of html.match(/<input[^>]*>/g) ?? []) {
      expect(tag).toContain("disabled");
    }
  });

  test("an input that is not a checkbox is removed, and a live checkbox is pinned disabled", () => {
    const blocks = parseMarkdownToSanitizedBlocks(
      'Type <input type="text" name="q"> here, tick <input type="checkbox"> there.',
    );
    const html = blocks.map((b) => b.html).join("\n");
    expect(html).not.toMatch(/type="text"/);
    expect(html).not.toContain('name="q"');
    expect(html).toMatch(/<input[^>]*type="checkbox"[^>]*disabled/);
  });

  test("forbidden inline event handler is stripped", () => {
    // pulldown-cmark passes raw HTML through to the renderer; DOMPurify
    // is the line of defense for things like `onerror`.
    const blocks = parseMarkdownToSanitizedBlocks(
      '<img src="http://example.com/x.png" onerror="alert(1)">',
    );
    for (const block of blocks) {
      expect(block.html).not.toMatch(/onerror=/i);
      expect(block.html).not.toContain("alert(1)");
    }
  });

  test("char offsets line up with the source text for ASCII", () => {
    const text = "para1\n\npara2";
    const blocks = parseMarkdownToSanitizedBlocks(text);
    expect(blocks.length).toBe(2);
    expect(text.slice(blocks[0].startChar, blocks[0].endChar)).toContain("para1");
    expect(text.slice(blocks[1].startChar, blocks[1].endChar)).toContain("para2");
  });

  test("contentHash is a non-zero bigint per block, deterministic across calls", () => {
    const text = "# Heading\n\nFirst paragraph.\n\nSecond paragraph.";
    const a = parseMarkdownToSanitizedBlocks(text);
    const b = parseMarkdownToSanitizedBlocks(text);
    expect(a.length).toBe(3);
    expect(b.length).toBe(3);
    for (let i = 0; i < a.length; i += 1) {
      // Hash must be a bigint (the BigInt(hi)<<32 | BigInt(lo) reassembly
      // landed correctly) and non-zero (FNV-1a's offset basis is
      // non-zero, and the input range is non-empty).
      expect(typeof a[i].contentHash).toBe("bigint");
      expect(a[i].contentHash).not.toBe(0n);
      // Determinism: same text → same hash.
      expect(a[i].contentHash).toBe(b[i].contentHash);
    }
  });

  test("contentHash diverges when source text changes", () => {
    const before = parseMarkdownToSanitizedBlocks("# Heading A");
    const after = parseMarkdownToSanitizedBlocks("# Heading B");
    expect(before[0].contentHash).not.toBe(after[0].contentHash);
  });

  test("appending a new block preserves leading blocks' contentHash (the load-bearing reconciler invariant)", () => {
    const prior = parseMarkdownToSanitizedBlocks(
      "# Heading\n\nFirst paragraph.\n",
    );
    const later = parseMarkdownToSanitizedBlocks(
      "# Heading\n\nFirst paragraph.\n\nSecond paragraph.\n",
    );
    expect(later.length).toBeGreaterThan(prior.length);
    for (let i = 0; i < prior.length; i += 1) {
      expect(later[i].contentHash).toBe(prior[i].contentHash);
    }
  });
});
