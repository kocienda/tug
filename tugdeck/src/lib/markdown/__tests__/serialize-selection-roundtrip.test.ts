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
 *
 * The plain form has no renderer to round-trip through — it is the text a
 * reader pastes where markdown is noise — so its cases at the end spell out
 * the expected text, over the same fixtures the markdown form is held to.
 */

import { join, dirname } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";

import { TUG_ATOM_CHAR } from "@/lib/tug-atom-img";

import { initSync } from "../../../../crates/tugmark-wasm/pkg/tugmark_wasm.js";

import { renderIncremental } from "../render-incremental";
import { enhanceFencedCode } from "../enhance-fenced-code";
import { isRunOfferLang, markdownFenceLang } from "../enhance-run-offer";
import {
  selectionToTranscriptMarkdown,
  selectionToTranscriptPlainSubstrate,
} from "../serialize-selection";
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

  // The sanitizer moves footnote ids and links under the page's prefix; the
  // copy carries the label the author wrote, which the HTML round trip above
  // cannot see, since the prefix is idempotent.
  test("a footnote copies under the author's label", () => {
    const copied = copyAll(render("A claim[^1].\n\n[^1]: The note."));
    expect(copied).toContain("[^1]");
    expect(copied).not.toContain("tugfn-");
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
// Runnable offers — a `tugrun` fence
// ---------------------------------------------------------------------------

const OFFER = "```tugrun\nlaunchctl kickstart -k gui/$(id -u)/foundation.example.local-ci\n```";
const OFFER_COMMAND = "launchctl kickstart -k gui/$(id -u)/foundation.example.local-ci";

describe("a runnable offer — the fence language", () => {
  test("only `tugrun` declares an offer, in any case", () => {
    expect(isRunOfferLang("tugrun")).toBe(true);
    expect(isRunOfferLang("TugRun")).toBe(true);
    expect(isRunOfferLang("bash")).toBe(false);
    expect(isRunOfferLang("tugchart")).toBe(false);
    expect(isRunOfferLang(null)).toBe(false);
  });

  test("an offer is written out as bash, and every other language as itself", () => {
    expect(markdownFenceLang("tugrun")).toBe("bash");
    expect(markdownFenceLang("ts")).toBe("ts");
    expect(markdownFenceLang(null)).toBeNull();
  });
});

describe("a runnable offer — the frame", () => {
  test("a `tugrun` fence wears the offer frame and not the fence chrome", () => {
    const container = render(OFFER);
    const frame = container.querySelector(".tugx-md-run");
    expect(frame).not.toBeNull();
    expect(container.querySelector(".tugx-md-fenced-code")).toBeNull();
    expect(container.querySelector(".tugx-md-chrome-header")).toBeNull();
    expect(container.querySelector(".tugx-md-chrome-fold")).toBeNull();
    // The command is still the fence's own `<pre><code>`, inside the frame.
    const code = frame?.querySelector(".tugx-md-run-row > pre > code.language-tugrun");
    expect(code?.textContent).toBe(OFFER_COMMAND + "\n");
    // Play is drawn and inert; Copy is beside it.
    const play = frame?.querySelector<HTMLButtonElement>("button.tugx-md-run-play");
    expect(play?.disabled).toBe(true);
    expect(frame?.querySelector("button.tugx-md-chrome-copy")).not.toBeNull();
    container.remove();
  });

  test("a bash fence keeps the fence chrome", () => {
    const container = render("```bash\nls -la\n```");
    expect(container.querySelector(".tugx-md-run")).toBeNull();
    expect(container.querySelector(".tugx-md-fenced-code")).not.toBeNull();
    container.remove();
  });

  test("a second enhance pass over the same block builds nothing more", () => {
    const container = render(OFFER);
    const before = container.innerHTML;
    enhanceFencedCode(container);
    expect(container.innerHTML).toBe(before);
    expect(container.querySelectorAll(".tugx-md-run").length).toBe(1);
    container.remove();
  });

  test("a rebuilt block arrives at one frame holding the new command", () => {
    // A streaming delta rewrites the block's `innerHTML`; the pass after
    // it has to put the frame back, once, around what the fence now says.
    const container = document.createElement("div");
    document.body.appendChild(container);
    renderIncremental(container, "```tugrun\nmake\n```");
    renderIncremental(container, "```tugrun\nmake check\n```");
    expect(container.querySelectorAll(".tugx-md-run").length).toBe(1);
    expect(container.querySelectorAll(".tugx-md-run-play").length).toBe(1);
    expect(container.querySelector(".tugx-md-run pre > code")?.textContent).toBe("make check\n");
    // The same source rendered again leaves the frame as it stands.
    renderIncremental(container, "```tugrun\nmake check\n```");
    expect(container.querySelectorAll(".tugx-md-run").length).toBe(1);
    container.remove();
  });
});

describe("a runnable offer — the copy", () => {
  test("copy as Markdown writes the fence as bash", () => {
    expect(copyAll(render(OFFER))).toBe("```bash\n" + OFFER_COMMAND + "\n```");
  });

  test("an offer among prose copies as a bash fence in its place", () => {
    expect(copyAll(render("Restart the agent:\n\n" + OFFER + "\n\nThen check the log."))).toBe(
      "Restart the agent:\n\n```bash\n" + OFFER_COMMAND + "\n```\n\nThen check the log.",
    );
  });

  test("the plain form is the command alone", () => {
    expect(plainAll(render(OFFER))).toBe(OFFER_COMMAND);
  });

  test("a multi-line offer keeps its lines", () => {
    expect(copyAll(render("```tugrun\ncd build\nmake check\n```"))).toBe(
      "```bash\ncd build\nmake check\n```",
    );
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

// ---------------------------------------------------------------------------
// The plain form — the same tree, no marks
// ---------------------------------------------------------------------------

/** The whole container as plain text, as ⌘A ⌘C would copy it. */
function plainAll(container: HTMLElement): string {
  const range = document.createRange();
  range.selectNodeContents(container);
  const substrate = selectionToTranscriptPlainSubstrate(select(range), container);
  container.remove();
  return substrate?.text ?? "";
}

/** {@link copyBetween}, in the plain form. */
function plainBetween(
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
  const substrate = selectionToTranscriptPlainSubstrate(select(range), container);
  container.remove();
  return substrate?.text ?? "";
}

describe("plain form — lists keep their markers", () => {
  test("a tight unordered list", () => {
    expect(plainAll(render("- alpha\n- beta\n- gamma"))).toBe("- alpha\n- beta\n- gamma");
  });

  test("a tight ordered list", () => {
    expect(plainAll(render("1. one\n2. two\n3. three"))).toBe("1. one\n2. two\n3. three");
  });

  test("a loose list keeps the blank line between its items", () => {
    expect(plainAll(render("- alpha\n\n- beta"))).toBe("- alpha\n\n- beta");
    expect(plainAll(render("1. one\n\n2. two"))).toBe("1. one\n\n2. two");
  });

  test("a nested list keeps its indent", () => {
    expect(plainAll(render("- outer\n  - inner one\n  - inner two\n- outer two"))).toBe(
      "- outer\n  - inner one\n  - inner two\n- outer two",
    );
  });

  test("a list starting above one keeps its start", () => {
    expect(plainAll(render("4. four\n5. five"))).toBe("4. four\n5. five");
  });

  test("a range starting at the third item writes `3.`", () => {
    const container = render("1. one\n2. two\n3. three\n4. four");
    expect(plainBetween(container, "three", "four")).toBe("3. three\n4. four");
  });

  test("a task list keeps its checkboxes", () => {
    expect(plainAll(render("- [ ] todo\n- [x] done"))).toBe("- [ ] todo\n- [x] done");
  });

  test("an item's inline marks go and its marker stays", () => {
    expect(plainAll(render("1. first **item**\n2. second `item`\n3. third *item*"))).toBe(
      "1. first item\n2. second item\n3. third item",
    );
  });
});

describe("plain form — inline marks are not written", () => {
  test("bold, emphasis, strike and code read as their text", () => {
    expect(plainAll(render("Some **bold** and *em* and ~~gone~~ and `code`."))).toBe(
      "Some bold and em and gone and code.",
    );
  });

  test("a range ending inside a bold run is just the selected words", () => {
    const container = render("plain **bold text** tail");
    expect(plainBetween(container, "plain", "bold text", "bold".length)).toBe("plain bold");
  });

  test("a link is its label", () => {
    expect(plainAll(render("see [a link](https://example.invalid/x) here"))).toBe(
      "see a link here",
    );
  });

  // The defect of stripping a rendered string: prose that merely contains
  // markdown's characters would be parsed as markdown and lose them. Here
  // they are text in the tree and nothing parses them.
  test("a literal asterisk in prose survives", () => {
    expect(plainAll(render("a \\*starred\\* word and 2 \\* 3"))).toBe(
      "a *starred* word and 2 * 3",
    );
  });

  test("a line-leading hash in prose survives", () => {
    expect(plainAll(render("\\# not a heading\n\nbody"))).toBe("# not a heading\n\nbody");
  });

  test("markdown's characters inside a code span survive", () => {
    expect(plainAll(render("call `f(**kwargs)` and `# comment`"))).toBe(
      "call f(**kwargs) and # comment",
    );
  });
});

describe("plain form — blocks", () => {
  test("a heading is its text, and block spacing is kept", () => {
    expect(plainAll(render("## Title\n\nFirst paragraph.\n\nSecond paragraph."))).toBe(
      "Title\n\nFirst paragraph.\n\nSecond paragraph.",
    );
  });

  test("a blockquote loses its prefix at every depth", () => {
    expect(plainAll(render("> outer\n>\n> > inner"))).toBe("outer\n\ninner");
  });

  test("a list inside a blockquote keeps its markers", () => {
    expect(plainAll(render("> - alpha\n> - beta"))).toBe("- alpha\n- beta");
  });

  test("fenced code with a language is its text, verbatim", () => {
    expect(plainAll(render("```ts\nconst x = a * b;\n  // **not bold**\n```"))).toBe(
      "const x = a * b;\n  // **not bold**",
    );
  });

  test("a table is one row per line with tabs between cells", () => {
    expect(
      plainAll(render("| Left | Right |\n|:-----|------:|\n| a | **b** |\n| c | d |")),
    ).toBe("Left\tRight\na\tb\nc\td");
  });

  test("a single table row copies as that row alone", () => {
    const container = render("| h1 | h2 |\n|----|----|\n| a1 | a2 |\n| b1 | b2 |");
    expect(plainBetween(container, "b1", "b2")).toBe("b1\tb2");
  });

  test("an image is its alt text", () => {
    expect(plainAll(render("before ![an alt](https://example.invalid/a.png) after"))).toBe(
      "before an alt after",
    );
  });

  test("a thematic break is a block boundary and no text", () => {
    expect(plainAll(render("above\n\n---\n\nbelow"))).toBe("above\n\nbelow");
  });

  test("a footnote reads as a bracketed label", () => {
    expect(plainAll(render("A claim[^1].\n\n[^1]: The note."))).toBe(
      "A claim[1].\n\n[1] The note.",
    );
  });
});

describe("plain form — atoms", () => {
  // A chip built the way `atomIdentityAttrs` writes one: identity in the
  // `data-atom-*` attributes, a drawn label that is not prose.
  function withChip(): HTMLElement {
    const container = document.createElement("div");
    container.innerHTML =
      '<div class="tugx-md-block"><p>see <strong>this</strong> '
      + '<span data-atom-type="file" data-atom-label="a.ts" data-atom-value="/src/a.ts">a.ts</span>'
      + " there</p></div>";
    document.body.appendChild(container);
    return container;
  }

  test("a selection crossing an atom carries the character and the atom", () => {
    const container = withChip();
    const range = document.createRange();
    range.selectNodeContents(container);
    const substrate = selectionToTranscriptPlainSubstrate(select(range), container);
    container.remove();
    expect(substrate).toEqual({
      text: `see this ${TUG_ATOM_CHAR} there`,
      atoms: [{ kind: "atom", type: "file", label: "a.ts", value: "/src/a.ts" }],
    });
  });

  test("an empty selection yields nothing", () => {
    const container = withChip();
    const range = document.createRange();
    range.setStart(container, 0);
    range.collapse(true);
    const substrate = selectionToTranscriptPlainSubstrate(select(range), container);
    container.remove();
    expect(substrate).toBeNull();
  });
});
