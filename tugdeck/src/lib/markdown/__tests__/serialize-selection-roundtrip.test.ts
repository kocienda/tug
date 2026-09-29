/**
 * serialize-selection-roundtrip.test — the copy re-renders to what was copied.
 *
 * The oracle is the pipeline's own renderer: a markdown fixture is rendered
 * through `renderIncremental` into the same `.tugx-md-block` wrappers the
 * transcript walks (fence chrome, table chrome and all), selected whole, put
 * through `selectionToTranscriptMarkdown`, and the result is rendered again.
 * The two renders must be the same HTML — `transcriptMarkdownToHtml` is the
 * `text/html` flavor's own rendering, so passing here is passing on both
 * flavors at once.
 *
 * One small fixture per construct, plus partial selections whose expected
 * markdown is spelled out because a slice has no fixture to round-trip to.
 *
 * A case marked `test.failing` is a construct the serializer does not carry
 * yet; the tag beside each names the finding it enumerates. The mark is what
 * turns a fix into a required edit here: a failing case that starts passing
 * fails the run until it is un-marked.
 */

import { join, dirname } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";

import { initSync } from "../../../../crates/tugmark-wasm/pkg/tugmark_wasm.js";

import { renderIncremental } from "../render-incremental";
import { selectionToTranscriptMarkdown } from "../serialize-selection";
import { transcriptMarkdownToHtml } from "../transcript-copy-html";

// ---------------------------------------------------------------------------
// Rig — WASM once, a jsdom window installed as the process globals
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dir = dirname(__filename);
const wasmPath = join(__dir, "../../../../crates/tugmark-wasm/pkg/tugmark_wasm_bg.wasm");

const DOM_GLOBALS = [
  "window",
  "document",
  "Node",
  "NodeFilter",
  "Range",
  "Selection",
  "HTMLElement",
  "Element",
  "Text",
  "requestAnimationFrame",
  "cancelAnimationFrame",
] as const;

let priorGlobals: Record<string, unknown> = {};
let dom: JSDOM;

beforeAll(() => {
  initSync({ module: readFileSync(wasmPath) });
  dom = new JSDOM("<!doctype html><body></body>");
  const win = dom.window as unknown as Record<string, unknown>;
  const globals = globalThis as Record<string, unknown>;
  // The DOM globals are process-wide under `bun test`; restored in
  // `afterAll` so no later file inherits a window it did not ask for.
  priorGlobals = {};
  for (const key of DOM_GLOBALS) priorGlobals[key] = globals[key];
  for (const key of DOM_GLOBALS) globals[key] = win[key];
  globals.requestAnimationFrame = (cb: FrameRequestCallback): number =>
    setTimeout(() => cb(0), 0) as unknown as number;
  globals.cancelAnimationFrame = (id: number): void => {
    clearTimeout(id as unknown as ReturnType<typeof setTimeout>);
  };
});

afterAll(() => {
  const globals = globalThis as Record<string, unknown>;
  for (const key of DOM_GLOBALS) globals[key] = priorGlobals[key];
  dom.window.close();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Render `md` the way the transcript does, into a fresh container. */
function render(md: string): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  renderIncremental(container, md);
  return container;
}

function select(range: Range): Selection {
  const sel = document.getSelection();
  if (sel === null) throw new Error("jsdom has no Selection");
  sel.removeAllRanges();
  sel.addRange(range);
  return sel;
}

/** Copy the whole container, as ⌘A ⌘C would. */
function copyAll(container: HTMLElement): string {
  const range = document.createRange();
  range.selectNodeContents(container);
  const md = selectionToTranscriptMarkdown(select(range), container);
  container.remove();
  return md ?? "";
}

/** The text node holding `needle` inside `root`, and where it starts. */
function findText(root: HTMLElement, needle: string): { node: Text; at: number } {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
    const at = (n as Text).data.indexOf(needle);
    if (at !== -1) return { node: n as Text, at };
  }
  throw new Error(`no text node holds ${JSON.stringify(needle)}`);
}

/**
 * Copy from the start of `from` to the end of `to`, both found by text.
 * `toOffset` narrows the end to that many characters into `to`.
 */
function copyBetween(
  container: HTMLElement,
  from: string,
  to: string,
  toOffset: number = to.length,
): string {
  const start = findText(container, from);
  const end = findText(container, to);
  const range = document.createRange();
  range.setStart(start.node, start.at);
  range.setEnd(end.node, end.at + toOffset);
  const md = selectionToTranscriptMarkdown(select(range), container);
  container.remove();
  return md ?? "";
}

/** The oracle: render, copy all, and the copy renders to the same HTML. */
function expectRoundTrip(md: string): void {
  const copied = copyAll(render(md));
  expect(transcriptMarkdownToHtml(copied)).toBe(transcriptMarkdownToHtml(md));
}

// ---------------------------------------------------------------------------
// Whole-fixture round trips — one construct each
// ---------------------------------------------------------------------------

describe("round trip — constructs the serializer already carries", () => {
  test("heading, paragraph and inline marks", () => {
    expectRoundTrip(
      "## Title\n\nSome **bold** and *em* and ~~gone~~ and `code` and [a link](https://example.invalid/x).",
    );
  });

  test("two paragraphs stay two paragraphs", () => {
    expectRoundTrip("First paragraph.\n\nSecond paragraph.");
  });

  test("a single-paragraph blockquote", () => {
    expectRoundTrip("> quoted words");
  });

  test("a hard break survives", () => {
    // The pipeline renders a newline inside a paragraph as `<br>`, so the
    // newline the walk already carries between the two text nodes IS the
    // hard break on the way back in. Nothing to add for this construct.
    expectRoundTrip("line one\\\nline two");
  });
});

describe("round trip — the reported shape", () => {
  // The turn the report was written from: a heading, a paragraph, and a
  // six-item numbered list, with the inline marks such a list really carries.
  test("a heading, a paragraph and a numbered list", () => {
    expectRoundTrip(
      "## Heading\n\nA paragraph of **prose** with a [link](https://example.invalid/x).\n\n"
        + "1. first **item**\n2. second `item`\n3. third *item*\n"
        + "4. fourth item\n5. fifth item\n6. sixth item",
    );
  });
});

describe("round trip — findings beyond the brief's enumeration", () => {
  // The fence chrome's language label (`code` when the fence names none) is
  // a text node inside the wrapper, so a range spanning the block copies it
  // as a paragraph of its own. Not in [F01]–[F04]; the walk skips
  // `.tugx-md-chrome-header`, which is what lets a fence or table round-trip.
  test("fenced code without a language", () => {
    expectRoundTrip("```\nplain text\nsecond line\n```");
  });
});

describe("round trip — lists", () => {
  // [F01] every item was written as a bullet; the ordinal was lost.
  test("a tight ordered list keeps its numbers", () => {
    expectRoundTrip("1. one\n2. two\n3. three");
  });

  // [F02] items are top-level blocks joined by a blank line.
  test("a tight unordered list has no blank line between items", () => {
    expectRoundTrip("- alpha\n- beta\n- gamma");
  });

  // [F03] loose items are wrapped in <p>, so no marker is written at all.
  test("a loose unordered list keeps its markers", () => {
    expectRoundTrip("- alpha\n\n- beta");
  });

  // [F01] + [F03]
  test("a loose ordered list keeps its numbers", () => {
    expectRoundTrip("1. one\n\n2. two");
  });

  // [F04] no list depth is recorded, so nesting flattens.
  test("a nested list indents its inner items", () => {
    expectRoundTrip("- outer\n  - inner one\n  - inner two\n- outer two");
  });

  // [F04] the checkbox had no text node and contributed nothing.
  test("a task list keeps its checkboxes", () => {
    expectRoundTrip("- [ ] todo\n- [x] done");
  });

  test("a loose task list keeps its checkboxes", () => {
    expectRoundTrip("- [ ] todo\n\n- [x] done");
  });

  // [F01] `start` is never read.
  test("a list starting above one keeps its start", () => {
    expectRoundTrip("4. four\n5. five");
  });

  // A tight item holds its text directly, so the leaf is the item itself —
  // and an inline element inside it must stay transparent. When it did not,
  // every styled span became a leaf of its own and the item came apart into
  // one line per span, which is the shape nearly every real list has.
  test("a tight item keeps its inline marks on one line", () => {
    expectRoundTrip("- alpha **bee** gamma\n- delta `eps` zeta");
  });

  test("a tight ordered item keeps its inline marks on one line", () => {
    expectRoundTrip("1. one [a link](https://example.invalid/x) tail\n2. two *em* tail");
  });

  test("a nested tight list keeps its inline marks at every depth", () => {
    expectRoundTrip("- a **x**\n  - b *y*\n    - c `z`");
  });

  test("a task item keeps its inline marks", () => {
    expectRoundTrip("- [x] **done** now\n- [ ] todo");
  });
});

describe("round trip — blockquotes", () => {
  // [F04] `emitBlock` tests heading before inQuote, dropping the `>`.
  test("a heading inside a blockquote keeps its prefix", () => {
    expectRoundTrip("> ## Quoted heading\n>\n> quoted body");
  });

  // [F04] one `>` at most, never two.
  test("a nested blockquote is prefixed at every depth", () => {
    expectRoundTrip("> outer\n>\n> > inner");
  });
});

describe("round trip — tables", () => {
  // [F04] TD/TH are block tags: one paragraph per cell.
  test("a table with alignment comes out as a table", () => {
    expectRoundTrip(
      "| Left | Center | Right |\n|:-----|:------:|------:|\n| a | b | c |\n| d | e | f |",
    );
  });
});

describe("round trip — code", () => {
  // [F04] the fence was written with no info string.
  test("fenced code carries its language", () => {
    expectRoundTrip("```ts\nconst x = 1;\n```");
  });
});

describe("round trip — inline constructs with no text node", () => {
  // [F04] `<img>` contributed nothing.
  test("an image survives", () => {
    expectRoundTrip("![an alt](https://example.invalid/a.png)");
  });

  test("a linked image keeps its link", () => {
    expectRoundTrip("[![an alt](https://example.invalid/a.png)](https://example.invalid/page)");
  });

  // [F04] a footnote reference contributed nothing.
  test("a footnote reference and its definition survive", () => {
    expectRoundTrip("A claim[^1].\n\n[^1]: The note.");
  });

  // [F04] `<hr>` contributed nothing, even when fully inside the range.
  test("a thematic break between paragraphs survives", () => {
    expectRoundTrip("above\n\n---\n\nbelow");
  });

  test("a grazed thematic break contributes nothing", () => {
    // The range runs from the first paragraph to a point inside the rule's
    // wrapper but before the rule itself: the rule is touched, not held.
    const container = render("above\n\n---\n\nbelow");
    const start = findText(container, "above");
    const hrWrapper = container.querySelector("hr")!.parentElement!;
    const range = document.createRange();
    range.setStart(start.node, start.at);
    range.setEnd(hrWrapper, 0);
    const md = selectionToTranscriptMarkdown(select(range), container);
    container.remove();
    expect(md).toBe("above");
  });

  test("a rule the drag ran over on its way to the next block's start contributes nothing", () => {
    // The real overshoot shape: a drag from a paragraph to offset 0 of the
    // heading below holds the rule between them, but the reader selected
    // nothing after it, so the rule is not among what they chose.
    const container = render("above\n\n---\n\n## Below");
    const md = copyBetween(container, "above", "Below", 0);
    expect(md).toBe("above");
  });

  test("a rule with selected text on both sides is carried", () => {
    const container = render("above\n\n---\n\nbelow");
    expect(copyBetween(container, "above", "below", 2)).toBe("above\n\n---\n\nbe");
  });
});

// ---------------------------------------------------------------------------
// Partial selections — a slice has no fixture to render back to, so the
// expected markdown is written out.
// ---------------------------------------------------------------------------

describe("partial selections", () => {
  // [F01] the marker comes from the item's DOM index plus `start`.
  test("a range starting at the third item writes `3.`", () => {
    const container = render("1. one\n2. two\n3. three\n4. four");
    expect(copyBetween(container, "three", "four")).toBe("3. three\n4. four");
  });

  test("a range ending inside a bold run closes the bold at the cut", () => {
    const container = render("plain **bold text** tail");
    expect(copyBetween(container, "plain", "bold text", "bold".length)).toBe(
      "plain **bold**",
    );
  });

  // [F04] a row's cells come out as paragraphs.
  test("a single table row copies as a one-row table", () => {
    const container = render("| h1 | h2 |\n|----|----|\n| a1 | a2 |\n| b1 | b2 |");
    const copied = copyBetween(container, "b1", "b2");
    const html = transcriptMarkdownToHtml(copied);
    expect(html).toContain("<table>");
    expect(html).toContain("b1");
    expect(html).toContain("b2");
    expect(html).not.toContain("a1");
    expect(html).not.toContain("h1");
  });
});
