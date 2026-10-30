/**
 * Block-transformer pass — composition contract.
 *
 * `parseMarkdownToSanitizedBlocks(text, { transformers, isComplete })`
 * runs every transformer over the post-sanitize block list in order.
 * Each transformer is a pure `(block, context) → block[]` function and
 * may:
 *
 *  - return `[block]`            — pass through unchanged
 *  - return `[]`                  — drop the block
 *  - return `[modified]`          — replace it (e.g., promote `code` →
 *                                   `tug-chart` based on lang hint)
 *  - return `[a, b, c]`           — split into siblings
 *
 * This file exercises composition behavior with synthetic transformers
 * — the real transformers' per-transformer behaviour is covered in
 * their own files; `diff` and `large-json` are still pass-through
 * stubs and are pinned as such here.
 *
 * Also confirms:
 *  - Empty `transformers` array is a no-op.
 *  - `isComplete: false` propagates into every `BlockTransformContext`
 *    so streaming-aware transformers can defer promotion until a
 *    fence's source has reached completion ([D07]).
 *  - Transformer order is preserved when chained (the second
 *    transformer sees the output of the first).
 */

import { join, dirname } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, test } from "bun:test";

import { initSync } from "../../../../crates/tugmark-wasm/pkg/tugmark_wasm.js";

import {
  applyBlockTransformers,
  type BlockTransformer,
} from "../block-transformers";
import {
  diffTransformer,
  largeJsonTransformer,
} from "../block-transformers";
import {
  parseMarkdownToSanitizedBlocks,
  type SanitizedMarkdownBlock,
} from "../parse-markdown-to-sanitized-blocks";

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
// Synthetic transformer factories
// ---------------------------------------------------------------------------

/** Records which blocks it sees and passes them through unchanged. */
function noopTransformer(): BlockTransformer & {
  seen: SanitizedMarkdownBlock[];
} {
  const seen: SanitizedMarkdownBlock[] = [];
  return {
    name: "noop",
    seen,
    transform(block) {
      seen.push(block);
      return [block];
    },
  };
}

/** Rewrites the `type` of every code block to `tug-chart`. */
function swapCodeToChartTransformer(): BlockTransformer {
  return {
    name: "swap-code-to-chart",
    transform(block) {
      if (block.type !== "code") return [block];
      return [{ ...block, type: "tug-chart" }];
    },
  };
}

/** Splits paragraph blocks into two siblings — useful for "did the
 *  pipeline really flat-map?" assertions. */
function paragraphSplitterTransformer(): BlockTransformer {
  return {
    name: "paragraph-splitter",
    transform(block) {
      if (block.type !== "paragraph") return [block];
      return [
        { ...block, html: "<p>part-a</p>" },
        { ...block, html: "<p>part-b</p>" },
      ];
    },
  };
}

/** Drops blocks whose `type` matches a target. */
function dropTransformer(targetType: string): BlockTransformer {
  return {
    name: `drop-${targetType}`,
    transform(block) {
      return block.type === targetType ? [] : [block];
    },
  };
}

/** Captures the `BlockTransformContext` for assertion. */
function contextCapturingTransformer(): BlockTransformer & {
  contexts: Array<{ isComplete: boolean; index: number; source: string }>;
} {
  const contexts: Array<{ isComplete: boolean; index: number; source: string }> = [];
  return {
    name: "context-capture",
    contexts,
    transform(block, ctx) {
      contexts.push({ isComplete: ctx.isComplete, index: ctx.index, source: ctx.source });
      return [block];
    },
  };
}

// ---------------------------------------------------------------------------
// Composition tests — through the public entry point.
// ---------------------------------------------------------------------------

describe("parseMarkdownToSanitizedBlocks — block-transformer pass", () => {
  test("absent / empty transformers → identity behavior", () => {
    const md = "# h\n\npara\n";
    const baseline = parseMarkdownToSanitizedBlocks(md);
    const empty = parseMarkdownToSanitizedBlocks(md, { transformers: [] });
    const undef = parseMarkdownToSanitizedBlocks(md, { transformers: undefined });
    expect(empty.length).toBe(baseline.length);
    expect(undef.length).toBe(baseline.length);
    expect(empty.map((b) => b.type)).toEqual(baseline.map((b) => b.type));
    expect(empty.map((b) => b.html)).toEqual(baseline.map((b) => b.html));
  });

  test("a no-op transformer leaves the block list unchanged but sees every block", () => {
    const md = "# h\n\npara\n\n```ts\nx\n```\n";
    const baseline = parseMarkdownToSanitizedBlocks(md);
    const tr = noopTransformer();
    const out = parseMarkdownToSanitizedBlocks(md, { transformers: [tr] });
    expect(out.map((b) => b.type)).toEqual(baseline.map((b) => b.type));
    expect(out.map((b) => b.html)).toEqual(baseline.map((b) => b.html));
    expect(tr.seen.length).toBe(baseline.length);
  });

  test("a swap-type transformer replaces the block's type", () => {
    const out = parseMarkdownToSanitizedBlocks(
      "para\n\n```ts\nconst x = 1;\n```\n",
      { transformers: [swapCodeToChartTransformer()] },
    );
    expect(out.map((b) => b.type)).toEqual(["paragraph", "tug-chart"]);
    // The replacement preserves the html — the renderer is responsible
    // for picking a different surface based on type alone.
    expect(out[1].html).toContain("const x = 1;");
  });

  test("a split transformer produces multiple sibling blocks", () => {
    const out = parseMarkdownToSanitizedBlocks(
      "first\n\nsecond\n",
      { transformers: [paragraphSplitterTransformer()] },
    );
    expect(out.length).toBe(4);
    expect(out.map((b) => b.html)).toEqual([
      "<p>part-a</p>",
      "<p>part-b</p>",
      "<p>part-a</p>",
      "<p>part-b</p>",
    ]);
  });

  test("a drop transformer removes a block from the output", () => {
    const out = parseMarkdownToSanitizedBlocks(
      "# heading\n\npara\n",
      { transformers: [dropTransformer("paragraph")] },
    );
    expect(out.length).toBe(1);
    expect(out[0].type).toBe("heading");
  });

  test("transformer order is preserved when chained — second sees first's output", () => {
    // First transformer: code → tug-chart.
    // Second transformer: drop tug-chart.
    // Net effect: code blocks disappear; non-code blocks pass through.
    const out = parseMarkdownToSanitizedBlocks(
      "para\n\n```ts\nx\n```\n",
      {
        transformers: [
          swapCodeToChartTransformer(),
          dropTransformer("tug-chart"),
        ],
      },
    );
    expect(out.map((b) => b.type)).toEqual(["paragraph"]);
  });

  test("isComplete propagates into every BlockTransformContext", () => {
    const tr = contextCapturingTransformer();
    parseMarkdownToSanitizedBlocks(
      "# a\n\n# b\n\n# c\n",
      { transformers: [tr], isComplete: false },
    );
    expect(tr.contexts.length).toBe(3);
    expect(tr.contexts.every((c) => c.isComplete === false)).toBe(true);
    // index reflects position in the (current) block list.
    expect(tr.contexts.map((c) => c.index)).toEqual([0, 1, 2]);
  });

  test("isComplete defaults to true when omitted", () => {
    const tr = contextCapturingTransformer();
    parseMarkdownToSanitizedBlocks("# a\n", { transformers: [tr] });
    expect(tr.contexts.length).toBe(1);
    expect(tr.contexts[0].isComplete).toBe(true);
  });

  test("each block's source is its own slice of the text", () => {
    const tr = contextCapturingTransformer();
    const text = "# a\n\n```tugchart\n{}\n```\n\nlast ✓ para\n";
    parseMarkdownToSanitizedBlocks(text, { transformers: [tr] });
    // A fenced block's range ends at its closing fence, before the newline.
    expect(tr.contexts.map((c) => c.source)).toEqual(["# a\n", "```tugchart\n{}\n```", "last ✓ para\n"]);
    // Through the helper with no text, source is "".
    const bare = contextCapturingTransformer();
    const block: SanitizedMarkdownBlock = {
      html: "<p>a</p>",
      type: "paragraph",
      startChar: 0,
      endChar: 1,
      depth: 0,
      itemCount: 0,
      rowCount: 0,
      contentHash: 0n,
    };
    applyBlockTransformers([block], [bare]);
    expect(bare.contexts[0].source).toBe("");
  });
});

// ---------------------------------------------------------------------------
// `applyBlockTransformers` direct unit — the helper is also exported
// for callers that want to apply transformers to a hand-built block
// list (e.g., incremental update paths in `TugMarkdownView`).
// ---------------------------------------------------------------------------

describe("applyBlockTransformers", () => {
  function makeBlock(type: string, html: string): SanitizedMarkdownBlock {
    return {
      html,
      type,
      startChar: 0,
      endChar: html.length,
      depth: 0,
      itemCount: 0,
      rowCount: 0,
      contentHash: 0n,
    };
  }

  test("empty transformers list returns the same array reference", () => {
    const blocks = [makeBlock("paragraph", "<p>x</p>")];
    expect(applyBlockTransformers(blocks, [])).toBe(blocks);
  });

  test("flat-maps results from each transformer in turn", () => {
    const initial = [makeBlock("paragraph", "<p>x</p>")];
    const out = applyBlockTransformers(initial, [
      paragraphSplitterTransformer(),
    ]);
    expect(out.length).toBe(2);
    expect(out.map((b) => b.html)).toEqual(["<p>part-a</p>", "<p>part-b</p>"]);
  });
});

// ---------------------------------------------------------------------------
// Stub transformers — they ship as no-ops in #step-3 so the dispatch
// contract compiles. Confirm the no-op shape so a future change to
// any of them shows up here.
// ---------------------------------------------------------------------------

describe("stub transformers (#step-3 ship-as-no-op contract)", () => {
  function makeBlock(type: string, html: string): SanitizedMarkdownBlock {
    return {
      html,
      type,
      startChar: 0,
      endChar: html.length,
      depth: 0,
      itemCount: 0,
      rowCount: 0,
      contentHash: 0n,
    };
  }

  test.each([
    ["diff", diffTransformer],
    ["large-json", largeJsonTransformer],
  ])("`%s` transformer is a pass-through stub", (_label, transformer) => {
    const block = makeBlock("code", "<pre><code>x</code></pre>");
    const out = transformer.transform(block, { isComplete: true, index: 0, source: "" });
    expect(out.length).toBe(1);
    expect(out[0]).toBe(block);
  });
});
