<!-- brief-skeleton v1 -->

# Transcript copy: markdown that survives the paste

**Purpose:** Selecting and copying transcript prose should put excellent markdown on the pasteboard. Today a numbered list pastes as bullets with a blank line between every item, and the same flat model that causes that loses tables, nesting, quotes, fence languages, and hard breaks.

---

## Purpose {#purpose}

The user's report, verbatim: "Selecting and copying content from the transcript should produce *excellent markdown* on the clipboard/pasteboard. We are far short of the mark now." The example was an assistant turn holding an H2, a paragraph, and a six-item numbered list. Pasted into BBEdit and into the prompt entry, two things were wrong:

- The numbered list came back as a bulleted list.
- Extra blank lines were sprinkled in, one between every list item.

The ask is broader than those two symptoms: "Tell me how we can do better, not only with these examples, but across the board for all markdown."

---

## Evidence {#evidence}

**[F01] Every list item is emitted as a bullet.** In `tugdeck/src/lib/markdown/serialize-selection.ts`, `emitBlock` writes `"- " + text` for any block of kind `li`. It never reads whether the parent is an `<ol>`, its `start`, or the item's index among its siblings. Ordinal is lost by construction. **(verified, read from the code)**

**[F02] Every `<li>` is a top-level block, and top-level blocks are joined with a blank line.** `selectionToTranscriptSubstrate` groups runs by their nearest block element and joins the groups with `"\n\n"`. A tight list's items are therefore separated exactly as paragraphs are. That is the extra newline in the report. **(verified, read from the code)**

**[F03] A loose list loses its markers entirely.** pulldown-cmark wraps loose items in `<p>`. `blockInfoOf` takes the first block tag it meets walking up, which is `P`, so the run's kind is `p` and no marker is written at all. **(verified by reading `blockInfoOf` and the `BLOCK_TAGS` set; not reproduced on screen)**

**[F04] The block model is flat: four leaf kinds, no containers.** `BlockInfo` carries `kind` in {heading, li, pre, p}, a heading level, and one `inQuote` bit. Nothing records list type, list depth, tightness, task state, blockquote depth, table row or cell, or fence language. Each of the following follows directly, by reading, none reproduced on screen:
- `TD` and `TH` are in `BLOCK_TAGS`, so a copied table becomes one paragraph per cell with blank lines between them.
- `emitBlock` tests `heading` before `inQuote`, so a heading inside a blockquote loses its `>`.
- A nested blockquote gets one `>`, never two.
- A code block's fence is written with no info string, though `enhance-fenced-code.ts` already parses `language-X` and stores it in `dataset.lang` on the wrapper.
- `<br>`, `<img>`, a task-list checkbox, a footnote reference, and `<hr>` produce no text node, so they contribute nothing. **(verified, read from the code)**

**[F05] The clipping walk is sound and is not the problem.** `collectRuns` walks text nodes and atom chips inside the range in document order, clips the first and last to the selection offsets, emits KaTeX once per `.katex` from its TeX annotation, and treats a chip as one `U+FFFC` with its atom beside it. `mergeAdjacentRuns` joins runs an inline element split. The defects are entirely downstream, in how runs are grouped and emitted. **(verified, read from the code)**

**[F06] The `text/html` flavor is derived from the markdown, so fixing the markdown fixes both.** `transcript-copy-html.ts` re-renders the reconstructed markdown through `parseMarkdownToSanitizedBlocks` for `text/html`. Rich-text pastes into other apps inherit the same defects today and the same fix tomorrow. **(verified, read from the code)**

**[F07] The rendered DOM does not carry the source.** Each `.tugx-md-block` wrapper carries `data-block-type` and `data-content-hash` only. The message's markdown source is held by the transcript store, and the lexer's per-block byte ranges are held by the parse cache, not by the DOM the copy walks. **(verified, read from `render-incremental.ts` and `parse-markdown-to-sanitized-blocks.ts`)**

**[F08] The test surfaces exist.** Unit tests for this module run under `bun:test` with jsdom available in `tugdeck/package.json`. The real WebKit ⌘C and menu Copy paths are driven by `tests/app-test/at0188-transcript-copy-wiring.test.ts` and `at0477-transcript-copy-atoms.test.ts` over `fixture-transcript-copy.tsx`. **(verified)**

---

## Decisions {#decisions}

**[B01] Keep the run walker; replace the grouping and the emitter.** Per [F05] the clipping walk, the atom substrate, the KaTeX handling, and the run merge are right. What changes is what a run records about its position and how runs are assembled into output. The governing principle of the module stands: the copy is the selected text, decorated with the styling those characters carry, clipped to the selection, and only text nodes and chips produce output.

**[B02] A run carries its ancestor chain, not a flat block kind.** From the `.tugx-md-block` wrapper down to the leaf, record every container the text sits in: a blockquote; a list with its type, `start`, and tightness; a list item with its sibling index and task state; a table with its row and cell position. The leaf is a paragraph, a heading with its level, a code block with its language from the fenced-code wrapper's `dataset.lang`, or a table cell. This is the information [F04] shows is missing, and the DOM already holds all of it.

**[B03] Emission builds a tree from the chains and walks it, following CommonMark's container rules.** Consecutive runs sharing a leaf join into one leaf; leaves sharing a container nest under it. The recursive emitter then does what the spec defines rather than what four hard-coded cases approximate:
- A list item's marker comes from the list type and the item's DOM index plus `start`. A selection that begins at the fourth item writes `4.`, which CommonMark renders as a list starting at four.
- Content nested inside an item is indented by the marker's width.
- Items of a tight list are separated by one newline; items of a loose list, and top-level blocks, by a blank line. This retires [F02] and [F03] together.
- A blockquote prefixes every line of everything inside it, headings and nested quotes included.
- A table emits a header row, an alignment row, and body rows, for only the rows the selection touched.
- A code block carries its language on the opening fence.

**[B04] Non-text inline constructs ride the same walk.** A `<br>` becomes a hard break, an `<img>` becomes `![alt](src)`, a task checkbox becomes `[ ]` or `[x]`, a footnote reference becomes `[^n]`. A thematic break has no text and appears only when the range fully contains it; a grazed `<hr>` still contributes nothing, so the no-overshoot property of [F05] holds.

**[B05] The correctness oracle is a round trip through the pipeline's own renderer.** Render a markdown fixture, select all, serialize, render the result, and require the two renders to be identical HTML. Per [F06] the renderer is already on the copy path, so the oracle costs no new machinery. The corpus is one small fixture per construct: ordered and unordered lists, tight and loose, nested, task lists, lists starting above one, quotes with headings and nested quotes, tables with alignment, fenced code with and without a language, hard breaks, images, footnotes, rules. Partial selections get explicit cases beside it: a mid-item start, an end inside a bold run, a single table row. This runs under `bun:test` with jsdom per [F08]; the two existing app-tests keep the real WebKit path honest and gain a numbered-list case.

**[B06] The atom substrate, the sidecar, the clipboard writers, and Copy as Plain Text are untouched.** The `SelectionSubstrate` shape and `formatAtomTextForCopy` are the contract every atom-bearing surface speaks; this work changes the text inside it, not the shape. Copy as Plain Text reads the selection's plain string and strips markup on its own path and has neither defect.

---

## Open Questions {#open-questions}

None that would change what gets written. Marker style for unordered lists (`-`) and the emphasis characters (`*`, `**`) stay as the current serializer writes them.

---

## Non-goals {#non-goals}

- **Emitting the source markdown verbatim for fully covered blocks.** Considered as a fidelity ceiling: the transcript store holds each message's source and the lexer gives per-block byte ranges, so a block the selection fully covers could be copied as the author wrote it, preserving reference links, footnote definitions, and marker style. It does not violate the module's no-overshoot rule, since a fully covered block has no overshoot. It is deferred, not rejected: it needs the source threaded to the copy path [F07], it does nothing for surfaces with no source such as the overview card, and the edge blocks of any selection still need the tree emitter of [B03]. If the round-trip oracle of [B05] ever shows a gap the DOM cannot close, this is the next step.
- **Changing what the transcript renders.** No DOM or CSS change is in scope; the DOM already carries everything [B02] reads.
- **The paste side.** The blank lines in the report come from the copy, not from the prompt entry's paste handling, which is not touched.

---

## Exit {#exit}

An arc. The first move is the fixture corpus and the round-trip oracle of [B05], written against the current serializer so the failures enumerate exactly the constructs in [F01] through [F04]. Then the run's block record grows into the ancestor chain of [B02], and the grouping loop and `emitBlock` are replaced by the tree build and recursive emitter of [B03], with the inline additions of [B04] landing alongside the constructs that need them. The two existing copy app-tests run last, with a numbered-list case added to the wiring test.
