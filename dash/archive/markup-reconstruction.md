## Markup Reconstruction on Copy — Robustness, Granularity, Reach {#markup-reconstruction}

**Purpose:** Take the transcript's copy-as-markdown reconstruction (markdown + TeX + tool blocks) from "good" to "great": remove the latent mis-attribution risk in how a selection is mapped to blocks, give it true inline (sub-block) granularity so a partial selection copies exactly what was selected, extend it across transcript rows, emit rich (`text/html`) alongside markdown, and lock all of it down with the integration tests the current work is missing — leaving no known improvement behind.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | complete on dash (all steps done; awaiting user `dash join`) |
| Target branch | main |
| Last updated | 2026-06-13 |

---

### Current Status & Post-Compact Handoff {#handoff}

**Read this first.** The implementation pivoted away from this plan's original source-offset-slicing design partway through. The pivot is the correct, user-validated approach; the earlier source-slicing steps ([P02], [Q01], [#step-5]–[#step-7], the spec at [#inline-segment-model]) are **superseded** — do not resurrect them.

**Governing approach (supersedes [Q02]/[P02]/[P03]/[P06]):** see **[P09] Fragment serialization** below. Copy = serialize the **selected DOM text runs** to markdown. Fidelity is structural (output text == selection by construction); styling is best-effort per run; **overshoot is impossible** (a node with no selected text node — `<hr>`, a grazed empty heading — produces no run).

**Where the work lives:**
- Dash worktree `tugdash/markup-reconstruction` (NOT joined to main). Build instance: `debug-tugdash-markup-reconstruction` (`just app-debug` / `launch-debug` / `logs-debug` / `stop-debug` from the worktree).
- **The one file that matters now:** `tugdeck/src/lib/markdown/serialize-selection.ts` — the fragment serializer (`selectionToTranscriptMarkdown(selection, bodyEl)`). Walks text nodes in the range, clips to selection, reads inline marks from ancestors (`strong/em/del/code/a`), block context (heading/li/pre/blockquote), KaTeX→TeX annotation (`$…$`/`$$…$$`), fenced code from `<pre>`.
- Wiring: `dev-card-transcript.tsx` — `useTranscriptCellMenu(resolveCopyMarkdown)` → `handleCopy` (reads live selection in the gesture, `clipboard.writeText`). `resolveCopyMarkdown = (bodyEl, sel) => selectionToTranscriptMarkdown(sel, bodyEl)`.
- Test: `tests/app-test/at0188-transcript-copy-wiring.test.ts` + fixture `gallery-transcript-copy.tsx` (mounts the REAL hook over real `TugMarkdownBlock`/`ToolBlockChrome`/`DevThinkingBlock` + a static `PropertyStore`; exposes `window.__tugCopyWiringProbe` for deterministic assertions). Run: `just app-test at0188-transcript-copy-wiring.test.ts`.

**Dash commits (chronological):** `a3d323fd` `f47bf670` `9fe11c5a` `bb5b1dec` (steps 1–4) · `e14d53b0` `b6512f80` `5a7d8408` `069efce4` (steps 5–8, source-slicing — **later retired**) · `271c2878` `dc416969` `58f9652c` (the fix rounds: overshoot guard → fidelity guarantee → **fragment-serialization rework**, the current state).

**Retired (deleted/reverted — do not bring back):** `range-to-blocks.ts`, `inline-offset-map.ts`, `selection-to-markdown.ts` (+ their `bun:test`s), `at0187`; the `data-md-start/end` attribution in `render-incremental.ts`; `data-md-source-path` in `tug-markdown-block.tsx`; the WASM `lex_inline_segments` (`tugmark-wasm/src/lib.rs` + regenerated `pkg/`); `buildCopyResolvers`/`CopyResolvers`. Vestigial-but-harmless leftovers from Step 1 that were NOT reverted: `ToolUseIdContext` + always-on `data-tool-use-id` (collapse-context.tsx, tool-block-chrome.tsx, the CodeRowBody provider) and the exported `groupToolCallsByParent`/`toolCallToMarkdown` (turn-entry-markdown.ts). The serializer doesn't use them; clean up if convenient.

**Hard-won lessons (cost real iterations — don't relearn):**
1. **Fidelity beats styling, always.** Copy must contain exactly the selected text — never widen to a whole construct/block to preserve markup, never bail to plain text when markup is hard. Apply styling to the selected text, clipped.
2. **`range.cloneContents()` does NOT preserve an inline ancestor** (`<strong>`) when the selection is wholly inside its text node — so it can't carry styling for within-run selections. That's why we walk live text runs and read ancestors, not the clone.
3. **WebKit `Selection.toString()` is empty for a programmatically-set selection** (works for real user selections). Use `Range.toString()` in tests/anywhere that reads a scripted selection.
4. **Overshoot is structural:** only text nodes produce output, so `<hr>`/empty-heading boundary clones can't leak. Keep it that way.
5. App-test selection helpers: interpolate offsets/needles into the page-script string (`${...}`) — don't reference test-scope vars inside the evalJS string. `nativeKey("c", ["cmd"])` for ⌘C; the cell must be first-responder first (click it).

**Remaining work — ALL DONE (Steps 9–13 reassessed + closed under the new model):**
- **[#step-9]** (partial=document-order / full-row exact, the `## Response` stitch): **MOOT/superseded** — serialization is inherently document-order and faithful; there is no tools-first stitch. Done-by-supersession.
- **[#step-10]** Cross-cell copy: **DONE** (`d891753a`), and it needed **no host handler**. The per-cell `handleCopy` reads the live `window.getSelection()` (not cell-scoped), and the serializer walks the whole `Range` from `commonAncestorContainer` — so a selection spanning rows is reconstructed in full by whichever cell owns the COPY gesture. The [P04]/[Q02] design (a host responder that substitutes `turnEntryToMarkdown` for "contained" cells) was **dropped**: under [P09] it would *overshoot* — copying tool I/O the cheap-tier cell doesn't display. A cheap (preview-tier) cell in a cross-cell span contributes its **displayed preview text**, which is faithful-to-display ([P09]). Proven by `at0188` (two/three separate responder-scope cells; cross-cell ⌘C asserts both cells' content in document order, blank-line separated).
- **[#step-11]** Dual `text/plain` + `text/html` clipboard: **DONE** (`d891753a`). `handleCopy` writes a `ClipboardItem` ({`text/plain`: reconstructed markdown, `text/html`: that markdown re-rendered via `parseMarkdownToSanitizedBlocks` — [Q04]}), built + issued synchronously in the gesture, degrading to `writeText` when `ClipboardItem`/`clipboard.write` is unavailable or rejects ([P07]). New `lib/markdown/transcript-copy-html.ts`. `at0188` asserts `<strong>bold</strong>` in the `text/html` flavor.
- **[#step-12]** Regression coverage: **DONE** (`d891753a`). `gallery-transcript-copy` grew a rich cell (heading, list, fenced code, inline `$E=mc^2$`, display `$$x=a+b$$`); `at0188` asserts each copies its markdown **source**, never the rendered glyph/highlight text (KaTeX TeX-annotation path waits for `.katex` to render). blockquote/table remain **best-effort** (degrade to plain, never overshoot) — a known limitation, not a bug.
- **[#step-13]** Final `verify`: **DONE**. `bunx tsc --noEmit` clean; `bun test` 3639 pass; `cargo nextest` 1040 pass; `just app-test at0188` VERDICT: PASS (29 assertions). Ready for `tugutil dash join markup-reconstruction` (user-invoked).

---

### Phase Overview {#phase-overview}

#### Context {#context}

The transcript COPY path was built in two steps (now on `main`): source-offset attribution stamps `data-md-start`/`data-md-end` on every `.tugx-md-block` wrapper (`lib/markdown/render-incremental.ts`), and a Range→markdown reconstruction (`lib/markdown/range-to-blocks.ts` + the pure `lib/markdown/selection-to-markdown.ts`) walks a live `Selection`, slices each touched block's source, and stitches it — wired through `useTranscriptCellMenu.handleCopy` in `dev-card-transcript.tsx`, reusing `turn-entry-markdown.ts`'s per-tool serializer for tool blocks.

It works and has a genuine strength worth protecting: because it slices *source* rather than reading `Selection.toString()`, it sidesteps the garbage that rendered KaTeX (duplicated MathML + visual text) and Shiki-highlighted code produce on copy. But a critical review surfaced concrete gaps:

1. **Two parallel iterations.** `buildTranscriptDocBlocks` (in `dev-card-transcript.tsx`) re-derives the same message→block filter `CodeRowBody` renders from, and the walk aligns `bodyEl.children[i] ↔ docBlocks[i]` *positionally*, guarded only by `children.length < docBlocks.length`. Any future divergence between the two iterations silently mis-attributes copied source.
2. **Block-level coarseness.** Selecting half a sentence copies the whole paragraph ([Q02] in the prior plan deferred inline granularity); grazing a tool block copies its entire serialized output.
3. **No cross-cell copy.** The handler walks only the first-responder cell's body, so a selection spanning turns yields one row's fragment.
4. **The real ⌘C path is untested.** `at0187` drives a *probe* over a single-block gallery card; the actual `handleCopy → resolver → clipboard.writeText` wiring, multi-block alignment, tool serialization in a selection, and context-menu vs keyboard COPY are unverified in-app.
5. **Silent source/offset coupling.** Offsets index the parsed string; copy re-reads `streamingStore.get(path)`. A mismatch (cold-restore, replay, normalization) yields a wrong/empty slice that silently falls back to plain text.
6. **`## Response` injection / tool-first reorder on partial selections** fabricates structure the user did not select.
7. **Plain-text clipboard only** — no `text/html`, so pasting into rich targets loses formatting.

The parser already has what we need for the hard part: `tugdeck/crates/tugmark-wasm/src/lib.rs` walks `parser.into_offset_iter()`, so per-inline-event source ranges are obtainable — we simply don't surface them yet.

#### Strategy {#strategy}

- **Robustness before reach.** Eliminate the mis-attribution landmine and the silent failures first (they corrupt output, not just limit it), and add the missing integration test. This is small and high-leverage.
- **Make the DOM the single source of truth.** Stop mirroring `CodeRowBody`'s filter; have the rendered DOM carry the block kind + identity the walk needs, so there is one enumeration, not two.
- **Inline granularity via parser offsets, not injected attributes.** The sanitizer's `ALLOWED_ATTR` allowlist strips `data-*` from inline HTML (`lib/markdown/dompurify-instance.ts`), so we will *not* stamp inline DOM attributes. Instead surface per-block inline **segments** from the WASM (`into_offset_iter`) — splittable plain-text runs vs atomic constructs carrying their full source span (markers included) — map a DOM range to a rendered-text offset, and resolve to a source range, widening to whole constructs (so `**bold**` never copies as bare `bold`) and falling back to whole-block where the rendered DOM diverges (math/highlighting).
- **Preserve the source-slice defense.** Keep slicing source for math/code; add regression guards so a future change can't reintroduce `Selection.toString()` garbage.
- **Phased and falsifiable.** Three milestones (Robustness → Granularity → Reach), each ending in a verifiable checkpoint, so the work can stop at any milestone boundary with a coherent result.

#### Success Criteria (Measurable) {#success-criteria}

- The block walk reads block kind + identity from the DOM; `buildTranscriptDocBlocks`'s mirrored ordered filter is gone, and a deliberately injected renderer/enumeration mismatch is *detected* (logged + safe), not silently mis-attributed. ([#step-1])
- A real `just app-test` drives keyboard ⌘C **and** context-menu Copy on a seeded multi-block transcript (markdown + tool + thinking) and asserts the clipboard holds correct reconstructed markdown — not plain text, not mis-attributed. ([#step-3])
- Selecting a sub-range *within a single prose block* copies exactly that text as markdown — char-accurate in plain text, widened to the whole construct for emphasis/code/links/math so markers are never orphaned — proven by a round-trip + an app-test. ([#step-6], [#step-7])
- Selecting rendered math or highlighted code copies the **source** (`$$…$$`, fenced block), never the rendered duplicate-text garbage — asserted by a regression test. ([#step-13])
- A selection spanning multiple transcript rows copies all touched turns' markdown in document order. ([#step-10])
- Copying yields both `text/plain` (markdown) and `text/html` (rendered) on the clipboard. ([#step-11])
- A partial selection reproduces only what was selected (document order, no fabricated `## Response`); a whole-row selection still reproduces `turnEntryToMarkdown(turn)` exactly. ([#step-9])

#### Scope {#scope}

1. Replace the mirrored block enumeration with DOM-sourced kind/identity; reliable `data-tool-use-id` on every tool block.
2. Observable degradation (log on any plain-text fallback).
3. Integration app-tests for the real COPY wiring (keyboard + menu, multi-block).
4. WASM inline source segments + pure construct-aware JS rendered-offset→source mapper.
5. Inline-accurate slicing for single-block (and boundary) selections, block-level interior.
6. Partial-selection semantics (document order; full-row still exact).
7. Cross-cell / whole-transcript selection copy at the host level.
8. Dual `text/plain` + `text/html` clipboard.
9. Regression guards for the math/code source-slice defense; tool-output over-copy handling.

#### Non-goals (Explicitly out of scope) {#non-goals}

- Changing the markdown renderer, highlighter (Shiki), or math engine (KaTeX).
- Editing/round-tripping copied markdown back into the transcript.
- Inline granularity *inside* tool-block output or code fences (tool blocks and fences stay whole — they have no meaningful sub-block markdown boundary).
- A user-facing "copy as plain text vs markdown" toggle (the markup path is the product intent; [P05] adds `text/html` transparently).
- Persisting any copy preference to tugbank.

#### Dependencies / Prerequisites {#dependencies}

- `lib/markdown/render-incremental.ts` — single `.tugx-md-block` construction point already stamps block offsets.
- `tugdeck/crates/tugmark-wasm/src/lib.rs` — `into_offset_iter()` already drives `lex_blocks`; inline runs ride the same walk. Rust workspace builds under `-D warnings`; tests via `cargo nextest run`.
- `turn-entry-markdown.ts` — `turnEntryToMarkdown`, `toolCallToMarkdown`, `groupToolCallsByParent`, `lastAssistantCopyText` (the `/copy` whole-turn precedent used by `dev-card.tsx`).
- `tug-text-editor.tsx` — existing `text/html` + `text/plain` clipboard envelope pattern to reuse for [P05].
- `gallery-transcript-markdown.tsx` — the `__tugTranscriptCopyProbe` test surface; `tests/app-test/at0187-transcript-copy-markdown.test.ts`.

#### Constraints {#constraints}

- Tuglaws: external state via `useSyncExternalStore` [L02]; live reads inside the gesture, no derived state [L07]; appearance/DOM attributes via CSS/DOM not React state [L06]; store observers may write DOM [L22]; stable mount identity [L26]. Cross-check `tuglaws/tuglaws.md`, `pane-model.md`, `component-authoring.md` per tugways change and name the laws in each commit.
- WARNINGS ARE ERRORS (Rust `-D warnings`; tugdeck builds clean). HMR for tugdeck; rebuild for WASM/Rust (`cargo build` of `tugmark-wasm` + regen pkg) and tugcode/Swift.
- Tests: pure-logic `bun:test`; real behavior via `just app-test` (greppable `VERDICT:`); Rust via `cargo nextest run`. No fake-DOM/RTL, no mock-store assertion tests.
- Clipboard writes must stay synchronous inside the user gesture.

#### Assumptions {#assumptions}

- Committed turns retain their source in the streaming store for the cell's life ([P07] makes a miss observable rather than silent).
- `into_offset_iter` yields enough structure to classify each inline span as splittable plain text or an atomic construct with its full source span; rendered text is 1:1 with source only inside splittable runs (emphasis/code/links/math are atomic), and rendered-transformed inline DOM (KaTeX/Shiki) is handled by aux-skipping measurement + whole-block fallback ([Q01], [P02]).
- The two-tier never-blank render keeps every cell mounted (cheap or rich), so a cross-cell selection's endpoints are reachable in the DOM even when off the rich window ([Q02] addresses non-rich boundary cells).

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

Anchors are explicit and kebab-case. Plan-local decisions use `[P01]`; global decisions cited as `[D##]`. Steps cite artifacts and anchors, never line numbers.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Boundary behavior inside atomic constructs and rendered-transformed inline DOM (OPEN) {#q01-inline-nonlinear}

**Question:** Rendered text is 1:1 with source only for *plain* text. Emphasis (`**bold**`→`bold`), inline code (`` `x` ``→`x`), links (`[label](url)`→`label`), images, autolinks, entities, and footnote refs all differ. Worse, **inline math and highlighted code inject *extra* DOM** — KaTeX renders duplicated MathML+visual text, so a block's DOM `textContent` no longer matches the source-derived segment lengths. When a selection boundary lands in any of these, what happens?

**Why it matters:** Char-accurate mapping is sound *only* inside splittable plain-text runs. A boundary inside an atomic construct, if not widened, strips syntax or yields half a construct (e.g. `**bold**` demoted to `bold`); a rendered-offset measured naively across KaTeX aux nodes drifts and mis-maps everything after it.

**Options:** (a) treat every non-plain construct as an **atomic segment** and widen any touching boundary to its whole source span, markers included ([P02]); (b) when measuring the DOM rendered-offset, the `TreeWalker` skips KaTeX/Shiki aux subtrees, and the mapper falls back to whole-block if the block's measured rendered length disagrees with the segment total. Recommended: **(a) for emphasis/code/link/image/entity, plus (b) for inline math** (atomic segment *and* aux-skipping measurement, whole-block fallback on mismatch).

**Plan to resolve:** Spiked in [#step-6] (segment model + widen/fallback) and validated in [#step-7] (DOM measurement) against a fixture corpus including `**bold**`, `` `code` ``, `[link](url)`, and inline `$math$`.

**Resolution:** OPEN → resolved in [#step-6]/[#step-7].

#### [Q02] Cross-cell COPY interception + non-rich boundary cells (OPEN) {#q02-cross-cell}

**Question:** Where is a multi-row selection's COPY intercepted (per-cell first responder vs a transcript-host responder vs the document `copy` event), and how is a touched cell that is mounted *cheap* (preview tier, no `.tugx-md-block`) reconstructed?

**Why it matters:** COPY dispatches to one first-responder cell today; assembling across cells needs a higher scope. Off-rich-window cells lack the rich DOM to slice.

**Options:** host-level responder that owns COPY when the selection spans >1 cell; for non-rich or fully-contained cells, emit the full `turnEntryToMarkdown(turn)` (data is on the row descriptor regardless of tier), clipping only the first/last partially-selected rich cells.

**Plan to resolve:** Spiked in [#step-10].

**Resolution:** RESOLVED in [#step-10] (`d891753a`) — and the answer inverts the original options. COPY is **not** intercepted at a higher scope: the first-responder cell's existing handler reads the un-scoped live selection and the range-global serializer reconstructs the whole span ([P09]/[P04] amendment). A non-rich (cheap-tier) boundary or contained cell contributes its **displayed preview text** — faithful-to-display — rather than a substituted `turnEntryToMarkdown` (which would overshoot beyond what's shown).

#### [Q03] Deterministic transcript seeding for the integration test (OPEN) {#q03-test-seeding}

**Question:** Can a committed multi-turn transcript (markdown + tool + thinking) be seeded deterministically for `just app-test`, or must the test drive a canned session fixture through the dev card?

**Why it matters:** The real COPY wiring lives on `AssistantTurnCell`; the test must exercise it, not a probe. Live Claude sessions are non-deterministic.

**Options:** (a) a deck-seed path that injects a frozen `TurnEntry[]` into a `CodeSessionStore`; (b) a dedicated gallery/fixture card mounting `dev-card-transcript` over a static transcript; (c) extend the existing probe to mount the *real* cell. Recommended: (b) — a fixture card mounting the actual transcript renderer over a frozen transcript, so the real handler runs.

**Plan to resolve:** Spiked in [#step-3].

**Resolution:** OPEN → resolved in [#step-3].

#### [Q04] `text/html` source: live subtree vs re-render (OPEN) {#q04-html-source}

**Question:** Is the `text/html` payload the serialized live touched DOM subtree, or HTML re-rendered from the reconstructed markdown slice?

**Why it matters:** The live subtree carries theme classes/inline KaTeX markup (heavy, app-specific); a clean re-render from the markdown slice is portable but a second render pass.

**Options:** re-render the reconstructed markdown to standalone sanitized HTML (portable, matches the markdown exactly) vs. clone the selected DOM. Recommended: re-render from the slice via the existing parse→sanitize pipeline.

**Plan to resolve:** Decided in [#step-11].

**Resolution:** OPEN → decided in [#step-11].

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| WASM offset-iter inline surface is subtle across GFM (tables, footnotes, task lists) | med | med | Rust `cargo nextest` corpus asserting segment `renderedLen` totals == rendered length and atomic spans include their markers; ship inline behind graceful whole-construct/whole-block fallback | corpus mismatch on real content |
| Inline mapping breaks on links/entities | med | med | [Q01] fallback to construct/whole-block; round-trip corpus | round-trip fails |
| Cross-cell interacts badly with windowing (non-rich cells) | med | med | [Q02]: full-turn markdown for non-rich/contained cells; clip only rich boundary cells | blank/partial output in `verify` |
| DOM-sourced enumeration still drifts from data needed for tools | low | low | Stamp `data-tool-use-id` reliably + id→message lookup (order from DOM, not a parallel filter) | misattribution in app-test |
| Dual-clipboard write violates gesture rules | low | low | Build payload synchronously in the handler; `ClipboardItem` write inside the gesture, mirror `tug-text-editor` | clipboard write rejected |

**Risk R01: Silent mis-attribution (the landmine)** {#r01-misattribution}
- **Risk:** Today's positional `children[i] ↔ docBlocks[i]` alignment mis-maps source if the two enumerations diverge, with no error.
- **Mitigation:** [P01] DOM-as-source-of-truth + [P07] observable fallback; [#step-1] removes the parallel filter; [#step-3] catches drift in-app.
- **Residual:** A renderer that emits a top-level child with no kind marker → walk skips it (logged), copying less rather than wrong.

**Risk R02: Inline mapping fragility** {#r02-inline}
- **Risk:** Rendered↔source non-1:1 regions (emphasis, code, links, math) corrupt char-accurate slices or strip markers.
- **Mitigation:** [P02] construct-aware segment mapping with [Q01] widen/fallback; atomic constructs slice with their markers, never partially.
- **Residual:** Boundary widens to the whole construct (or block) — coarser, never broken.

---

### Design Decisions {#design-decisions}

#### [P09] Copy is fragment serialization of the selection (GOVERNING — supersedes [P02]/[P03]/[P06] and the source-slice model) {#p09-fragment-serialization}

**Decision:** Reconstruct copy markdown by **serializing the selected DOM text runs**, not by slicing source offsets. Walk the text nodes the range touches in document order, clip the first/last to the selection's offsets (so the text is *exactly* the selection), and for each run emit markdown that decorates only that text: inline marks from the run's ancestor elements (`<strong>`→`**`, `<em>`→`*`, `<del>`→`~~`, `<code>`→`` ` ``, `<a>`→`[…](href)`), block context from the nearest block ancestor (heading level, list item, code fence, blockquote), KaTeX from its embedded TeX annotation (`$…$`/`$$…$$`), fenced code from the `<pre>` text.

**Rationale (the lesson):** Source slicing forces whole-construct boundaries, so it can only *widen* a partial selection (→ copies unselected text) or *bail* to plain (→ drops styling). Both are wrong. Fidelity and styling are not in tension if you build *from* the selected text and layer styling on per run. Two non-obvious facts forced this: (a) `range.cloneContents()` drops an inline ancestor when the selection is wholly inside its text node, so the clone can't carry within-run styling — you must read ancestors off the live tree; (b) only text nodes produce output, so structural/empty boundary nodes (`<hr>`, grazed empty heading) **cannot** leak into the copy — overshoot is impossible by construction.

**Invariant:** the rendered text of the copied markdown equals the selected text, by construction (markers are not text). Styling degrades run-by-run, never wholesale.

**Implications:** Implemented in `lib/markdown/serialize-selection.ts`. Block-level/atomic-widen ([P02]/[Q02]'s slicing), the offset mapper, the WASM inline segments, and the `data-md-*` attribution are all **retired**. blockquote prefixing and tables are best-effort (degrade to plain text, never overshoot). [L07].

#### [P01] The rendered DOM is the single source of truth for block enumeration (DECIDED — partly retained) {#p01-dom-source-of-truth}

> **Note:** the *spirit* (read the rendered DOM, not a mirrored filter) survives in [P09]; the *mechanism* below (data-attribute markers, resolver callbacks, `range-to-blocks`) was **retired** in the fragment-serialization rework. Kept for history.

**Decision:** Stop deriving an ordered `docBlocks` array from a mirror of `CodeRowBody`'s filter. Each top-level transcript child carries `data-transcript-block="markdown|tool|thinking|other"` and the identity the walk needs (markdown: the streaming-path/message key to read source; tool: `data-tool-use-id`). `range-to-blocks` reads kind + identity from the DOM in document order; the cell supplies only *lookups* (source-by-path, tool-markdown-by-id), not an ordered parallel list.

**Rationale:** Removes Risk R01 at the root — one enumeration (the DOM the user actually selected in), order intrinsic, no lockstep invariant between two functions.

**Implications:** `CodeRowBody` stamps the attributes at the dispatch site; `ToolBlockChrome` (or the dispatch wrapper) stamps `data-tool-use-id` on *every* tool block (not only collapse-wrapped ones); `buildTranscriptDocBlocks` is deleted; `selectionToTranscriptMarkdown` takes resolver callbacks. [L06] DOM attributes; [L26] markers ride stable wrappers.

#### [P02] Inline granularity via construct-aware source segments (RETIRED — superseded by [P09]) {#p02-inline-segments}

> Source-slicing model. Built (Steps 5–7) then retired: it widened partial selections to whole constructs (copying unselected text). Replaced by [P09] fragment serialization. Kept for history.

**Decision:** Surface, per block, an ordered list of inline **segments** from the WASM `into_offset_iter` walk. Each segment is either *splittable* — a plain-text run whose rendered text equals its source 1:1 (char-accurate slicing) — or *atomic* — an inline construct (strong, emphasis, inline code, link, image, autolink, inline math, HTML entity) carrying its **whole** source span *including* its markers. The JS mapper converts a selection's DOM offsets within a block to a rendered-text offset, finds the segment(s) it falls in, splits inside splittable runs, and **widens to the whole span** of any atomic construct it touches. Slicing stays source-based; an unresolvable boundary widens to the whole block.

**Why segments, not "text runs":** rendered text is **NOT** 1:1 with source for emphasis or code — `**bold**` renders `bold` (no `**`), `` `x` `` renders `x` (no backticks). A naive map onto `into_offset_iter` `Text` events would slice the *inner* text and **strip the markdown syntax** on partial copy (demoting `**bold**` to `bold`). This is the common case, not an edge. The offset iter already gives what's needed to avoid it: `Start`/`End` tag events report the construct's **full** source span, and the inline-`Code` event range **includes** its backticks — so atomic segments slice with markers intact.

**Rationale:** The sanitizer strips `data-*` from inline HTML (`dompurify-instance.ts` `ALLOWED_ATTR`), so inline DOM attribution is a dead end without weakening sanitization. The parser already walks offsets; the segment list is a pure data product, testable in Rust and JS, with no DOM-attribute or sanitizer change.

**Implications:** New WASM export (e.g. `lex_inline_segments`) emitting `{kind: splittable|atomic, renderedLen, sourceStart, sourceEnd}` per block; a pure JS mapper module; `range-to-blocks` uses it for the first/last touched block, interior blocks stay whole.

#### [P03] Partial = document order, no fabricated structure; full-row stays exact (SUPERSEDED by [P09]) {#p03-partial-semantics}

> Moot under [P09]: serialization is inherently document-order and adds no `## Response`/tools-first stitch. Kept for history.

**Decision:** A partial selection stitches touched blocks in **document order** with no tool-first regrouping and no injected `## Response`. A whole-row selection still reproduces `turnEntryToMarkdown(turn)` byte-for-byte (detected as full coverage, or routed to `turnEntryToMarkdown`).

**Rationale:** Partial copy should yield what was selected; full-row copy should match the COPY button. The current single stitch can't satisfy both; split them.

**Implications:** `stitchSelectionMarkdown` gains a document-order mode; the walk preserves interleave order; a full-coverage detector (or the existing full-row COPY button) routes whole-row to `turnEntryToMarkdown`.

#### [P04] Cross-cell copy assembled at the transcript host (AMENDED — no host handler under [P09]) {#p04-cross-cell}

> **Amended by [P09] (implemented `d891753a`).** The host-scope assembly below was **not built** and is not needed. Because `handleCopy` reads the live, un-scoped `window.getSelection()` and the serializer walks the whole `Range` from `commonAncestorContainer`, the per-cell handler already reconstructs a cross-cell span in full — no host responder, no `turnEntryToMarkdown` substitution. The substitution is in fact **wrong** under [P09]: it would copy a contained cell's full turn markdown (tool I/O included) even when that cell is rendered cheap (preview only), overshooting beyond displayed text. A cheap cell contributes its displayed preview text, which is faithful-to-display. Original text kept for history.

**Decision (superseded):** When a selection spans more than one cell, COPY is handled at the transcript host scope: walk touched cells in document order, reconstruct each (boundary cells via the per-cell range path, fully-contained cells via `turnEntryToMarkdown`), and join.

**Rationale:** Per-cell handlers structurally cannot see other cells; the host owns the row set and each row's `TurnEntry`.

**Implications:** A host-level responder/`copy`-event handler ([Q02]); reuse of `turnEntryToMarkdown` for contained cells; single-cell selections keep the existing per-cell fast path.

#### [P05] Dual-format clipboard: markdown + HTML (DECIDED) {#p05-dual-clipboard}

**Decision:** Write a `ClipboardItem` with `text/plain` (reconstructed markdown) and `text/html` (rendered from the same slice, [Q04]). Rich targets get formatting; plain targets get markdown.

**Rationale:** "Great" copy serves both paste destinations; the editor already does this.

**Implications:** Replace `clipboard.writeText` in the transcript path with a `ClipboardItem` write, synchronous in the gesture; reuse `tug-text-editor`'s envelope helper.

#### [P06] The source-slice defense is canonical and regression-guarded (SUPERSEDED by [P09]) {#p06-source-slice}

> Replaced: copy no longer slices source. The math/code "garbage" concern is handled instead by serializing KaTeX from its TeX annotation and fenced code from `<pre>` ([P09]). Kept for history.

**Decision:** Copy always derives from source offsets, never `Selection.toString()` over rendered math/code. A regression test asserts copying a selection over rendered KaTeX/Shiki yields source, not rendered duplicate text.

**Rationale:** This is the design's core strength; protect it explicitly so a refactor can't regress it.

#### [P07] Degradation is observable (DECIDED) {#p07-observable-fallback}

**Decision:** Any fall-through to the plain-text guard (resolver returned `null`, source missing, enumeration gap) logs via `tugDevLogStore` with context. The guard remains (copy never produces nothing) but is no longer silent.

**Rationale:** [P03] of the prior plan promised "no plain-text fallback"; in practice a guard must exist, so make it visible instead of a silent correctness hole (Risk R01, gap #5).

#### [P08] Tool blocks and code fences stay whole within a selection (DECIDED) {#p08-tool-whole}

**Decision:** Inline granularity applies to prose blocks only. A selection touching a tool block or a fenced code block includes it whole; very large tool outputs are handled by the existing `turnEntryToMarkdown` fences (no truncation that would corrupt round-trip), with the over-copy documented.

**Rationale:** Tool output and code have no meaningful sub-block markdown boundary; slicing them mid-content would not round-trip.

---

### Specification {#specification}

#### Reconstruction model (target) {#reconstruction-model}

`selectionToTranscriptMarkdown(selection, bodyEl, resolvers)`:
1. Walk `bodyEl`'s top-level children in document order. For each, read `data-transcript-block`.
2. Skip children the range does not overlap (strict boundary-point overlap, as today).
3. For an overlapped **markdown** child: collect touched `.tugx-md-block` wrappers; for the first/last touched wrapper, ask the inline mapper ([P02]) for a source sub-range from the selection's DOM offsets, falling back to the wrapper's whole `[data-md-start,end)` ([Q01]); interior wrappers contribute their whole range; slice `resolvers.sourceForPath(path)`.
4. For an overlapped **tool** child: `resolvers.toolMarkdownById(data-tool-use-id)` (whole, [P08]).
5. **thinking/other**: omit (match `turnEntryToMarkdown`).
6. Stitch in **document order** ([P03]); if the selection fully covers the row, route to `turnEntryToMarkdown(turn)`.
7. The cell builds `text/plain` (this markdown) + `text/html` (re-rendered slice, [P05]/[Q04]) and writes one `ClipboardItem`.

#### Inline segment model {#inline-segment-model}

> **RETIRED ([P09]).** This source-offset/segment model was built then removed. The live design serializes the selected DOM fragment — see [P09] and `lib/markdown/serialize-selection.ts`. Kept for history.

Per block, the WASM emits an ordered list of **segments** from `into_offset_iter`, each `{ kind: splittable | atomic, renderedLen, sourceStart, sourceEnd }`:
- **splittable** — a plain-text run; rendered text == source 1:1, so a boundary inside it maps linearly to a source char offset.
- **atomic** — an inline construct (strong, emphasis, inline code, link, image, autolink, entity, inline math). Its `sourceStart..sourceEnd` covers the **whole** construct *including* its markers (`**…**`, backticks, `[…](…)`, `$…$`), taken from the `Start`/`End` tag range (or the `Code` event range). A boundary touching it widens to the full span — never slicing inner text and orphaning markers.

The JS mapper: DOM range within the block → rendered-text char offset (a `TreeWalker` measuring text length up to the boundary, **skipping KaTeX/Shiki aux subtrees**) → segment lookup → source range (linear inside a splittable run; whole span for an atomic). If the measured rendered length disagrees with the segment `renderedLen` total (rendered-transformed DOM the walker couldn't normalize), the mapper returns whole-block ([Q01]). Slicing is always source-based.

#### State Zone Mapping (tugdeck/tugways) {#state-zone-mapping}

| State | Zone | Mechanism | Law |
|-------|------|-----------|-----|
| `data-transcript-block` kind + identity | appearance/structure | DOM attributes stamped at dispatch | [L06] |
| `data-tool-use-id` on every tool block | appearance/structure | DOM attribute | [L06] |
| inline segment list (per block, at copy) | derived/transient | computed in the COPY handler by re-lexing the touched block's source | [L07] |
| selection→markdown result | transient | computed in the gesture, no persistent state | [L07] |
| cross-cell assembly | transient | host COPY handler over touched rows | [L07], [L02] |
| clipboard payload (md + html) | transient | `ClipboardItem` in the gesture | [L07] |
| fallback log line | none (telemetry) | `tugDevLogStore` | — |

---

### Test Plan Concepts {#test-plan-concepts}

| Category | Purpose | Where |
|----------|---------|-------|
| Rust unit (`cargo nextest`) | inline segment `renderedLen` totals match rendered length per block, and atomic segments carry their markers, across the GFM corpus | `tugmark-wasm` |
| Unit (`bun:test`) | rendered-offset→source mapping; document-order stitch; full-coverage detection; non-1:1 fallback | `lib/markdown/__tests__` |
| Real-app (`just app-test`) | actual ⌘C + context-menu COPY on a seeded transcript; inline-accurate single-block copy; cross-cell; math/code source-not-garbage; clipboard `text/html` present | `tests/app-test` |

Banned (per project policy): fake-DOM/RTL, mock-store assertion tests.

---

### Execution Steps {#execution-steps}

> Commit after all checkpoints pass. Cross-check the cited tuglaws and name them in each tugways commit.

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | DOM-sourced block enumeration; reliable tool-use-id | done | a3d323fd |
| #step-2 | Observable degradation on fallback | done | f47bf670 |
| #step-3 | Integration app-test for the real COPY wiring | done | 9fe11c5a |
| #step-4 | Robustness checkpoint | done | N/A (verify) |
| #step-5 | WASM inline source segments | retired | e14d53b0 (later removed) |
| #step-6 | Pure rendered-offset→source mapper | retired | b6512f80 (later removed) |
| #step-7 | Inline-accurate slicing in range-to-blocks | retired | 5a7d8408 (later removed) |
| #step-8 | Granularity checkpoint | superseded | — |
| — | **Fragment-serialization rework ([P09])** — inline accuracy + fidelity guarantee, the current copy path | done | 271c2878 → dc416969 → 58f9652c |
| #step-9 | Partial = document order; full-row stays exact | superseded by [P09] | — |
| #step-10 | Cross-cell / whole-transcript selection copy | done | d891753a |
| #step-11 | Dual text/plain + text/html clipboard | done | d891753a |
| #step-12 | Regression coverage on rich content (math/lists/headings); blockquote+table best-effort | done | d891753a |
| #step-13 | Final integration checkpoint | done | N/A (verify) |

---

#### Step 1: DOM-sourced block enumeration; reliable tool-use-id {#step-1}

**Commit:** `refactor(tugways): enumerate transcript copy blocks from the DOM, not a mirrored filter [L06][L26]`

**References:** [P01] DOM source of truth, Risk R01, Spec (#reconstruction-model)

**Artifacts:**
- `lib/markdown/range-to-blocks.ts` — read each top-level child's **kind from its existing `data-slot`** (`tug-markdown-block` / `dev-thinking-block` / `tool-block-chrome` / `compaction-divider` — all already present; no new kind attribute needed); take resolver callbacks (`sourceForPath`, `toolMarkdownById`) instead of an ordered `DocBlock[]`.
- `tug-markdown-block.tsx` — reflect the streaming-mode `streamingPath` onto the root as `data-md-source-path`, so the markdown source is resolvable from the DOM (the component forwards only `className` today, so this is an explicit, generic reflection — not arbitrary `data-*` passthrough).
- `tool-blocks/tool-block-chrome.tsx` + `dev-card-transcript.tsx` `CodeRowBody` — make `data-tool-use-id` present on **every** tool root, not only collapse-wrapped ones. The chrome currently reads the id from `ToolBlockCollapseContext` (so it's stamped only when wrapped); add a lightweight **dispatch-level id context** that `CodeRowBody` provides around each top-level tool, which the chrome reads as a fallback. No DOM wrappers (which would perturb the markdown spacing model) and no ~20-file edit.
- `dev-card-transcript.tsx` — delete `buildTranscriptDocBlocks` (the mirrored filter); the cell passes only the resolver callbacks.

**Tasks:**
- [ ] `range-to-blocks` derives kind from `data-slot` and identity from `data-md-source-path` / `data-tool-use-id`, walking DOM children in order; unknown/unmarked children are skipped (and logged in [#step-2]).
- [ ] Reflect `streamingPath` → `data-md-source-path` on the markdown root.
- [ ] Provide tool-use-id via the dispatch-level context so the chrome stamps `data-tool-use-id` unconditionally.
- [ ] Remove the positional `docBlocks` array and `buildTranscriptDocBlocks`; `selectionToTranscriptMarkdown` resolves via callbacks.

**Tests:**
- [ ] Update `selection-roundtrip` / pure tests to the resolver shape; `bunx tsc --noEmit` clean.

**Checkpoint:**
- [ ] `bun test` green; `at0187` still passes; no `buildTranscriptDocBlocks` remains.

---

#### Step 2: Observable degradation on fallback {#step-2}

**Depends on:** #step-1

**Commit:** `feat(tugways): log when transcript copy falls back to plain text [L07]`

**References:** [P07] Observable fallback, gap #5

**Artifacts:**
- `dev-card-transcript.tsx` `handleCopy` — when reconstruction returns `null` (or a markdown child's source is missing), `tugDevLogStore.warn(...)` with context before the plain-text guard.

**Tasks:**
- [ ] Add the log at the fallback site; include block kind/path that failed.

**Tests:**
- [ ] Unit over the source-missing branch where pure; in-app confirmation deferred to [#step-3].

**Checkpoint:**
- [ ] Forcing a missing source logs a warning; copy still succeeds as plain text.

---

#### Step 3: Integration app-test for the real COPY wiring {#step-3}

**Depends on:** #step-1

**Commit:** `test(app): drive real ⌘C + menu Copy on a seeded transcript [L07]`

**References:** gap #4, [Q03] Test seeding, (#q03-test-seeding)

**Artifacts:**
- A **fixture card** mounting the real `dev-card-transcript` over a frozen `TurnEntry[]` ([Q03] recommended option) — there is no existing static-transcript fixture (the `dev` card drives a live session; `gallery-transcript-markdown` mounts only `TugMarkdownBlock`), so this is net-new and the first sub-step.
- `tests/app-test/atXXXX-transcript-copy-wiring.test.ts` — seed the fixture; select within a paragraph, across blocks, and across a tool block; fire keyboard ⌘C (`nativeKey`) **and** context-menu Copy; assert the captured clipboard markdown.

**Tasks:**
- [ ] **First:** resolve [Q03] — build the static-transcript fixture card mounting the real renderer over a frozen turn (markdown + tool + thinking). Nothing else in this step proceeds without it.
- [ ] Capture the clipboard by overriding `navigator.clipboard.write`/`writeText` in-page via `evalJS` before the gesture, then reading the captured value back (the harness has no clipboard helper; `nativeKey` provides ⌘C).
- [ ] Ensure the target cell is first responder before COPY (the `at0010` focus gesture) so the action routes to the cell handler.
- [ ] Assert reconstructed markdown (raw syntax present), correct attribution, and that the plain-text guard does NOT fire.

**Tests:**
- [ ] `just app-test atXXXX-transcript-copy-wiring.test.ts` → `VERDICT: PASS`.

**Checkpoint:**
- [ ] Real handler verified end-to-end for keyboard + menu, against the seeded fixture, reading the captured clipboard.

---

#### Step 4: Robustness checkpoint {#step-4}

**Depends on:** #step-1, #step-2, #step-3

**Commit:** `N/A (verification only)`

**References:** (#success-criteria), Risk R01

**Tasks:**
- [ ] Inject a deliberate enumeration mismatch (a renderable child without a kind marker) and confirm it is logged + safe, not mis-attributed.

**Checkpoint:**
- [ ] `verify`/app-test PASS; drift is observable.

---

> **Steps 5–7 RETIRED ([P09]).** Built (commits `e14d53b0`/`b6512f80`/`5a7d8408`) then removed in the fragment-serialization rework. The inline-accuracy goal is met by `serialize-selection.ts` instead. Do not re-implement. Kept for history.

#### Step 5: WASM — per-block inline source segments {#step-5}

**Depends on:** #step-4

**Commit:** `feat(tugmark): emit per-block inline source segments for copy reconstruction`

**References:** [P02] Inline segments, [Q01], Spec (#inline-segment-model)

**Artifacts:**
- `tugdeck/crates/tugmark-wasm/src/lib.rs` — new export (e.g. `lex_inline_segments`) walking `into_offset_iter` into per-block segments aligned to `lex_blocks` block order. Plain `Text` runs → **splittable** segments (`renderedLen` == source length); `Strong`/`Emphasis`/`Code`/`Link`/`Image`/autolink/entity → **atomic** segments spanning the construct's **full** source range (from the `Start`/`End` tag range, or the `Code` event range, which includes the markers). Inline math (`$…$` — not a pulldown construct; it arrives as text) is marked atomic by the same delimiter rule the renderer's math enhancer uses.
- Regenerated `pkg/`; exposed as a sibling JS API that **re-lexes a single block's source on copy** (copy is rare, so this avoids threading segments through the streaming parse cache).

**Tasks:**
- [ ] Emit `{kind: splittable|atomic, renderedLen, sourceStart, sourceEnd}` segments per block, in document order.
- [ ] Rust tests: splittable runs' `renderedLen` equals their source length; atomic segments' source spans include their markers; per-block segment `renderedLen` totals equal the block's rendered text length across the GFM corpus (`**bold**`, `` `code` ``, `[link](url)`, `$math$`, mixed).

**Tests:**
- [ ] `cd tugrust && cargo nextest run` green; `-D warnings` clean.

**Checkpoint:**
- [ ] Segments available in JS; atomic spans include markers; totals match rendered length on real content.

---

#### Step 6: Pure construct-aware rendered-offset→source mapper {#step-6}

**Depends on:** #step-5

**Commit:** `feat(tugways): map a block's rendered-text offset to a source range, construct-aware [L07]`

**References:** [P02] Inline segments, [Q01], Spec (#inline-segment-model)

**Artifacts:**
- `lib/markdown/inline-offset-map.ts` (new, pure) — given a block's segment list and a rendered-offset range, return a source range: split inside splittable runs (char-accurate), **widen to the full span** of any atomic segment a boundary touches ([P02]); return "whole-block" when a boundary is unresolvable (e.g. the measured rendered length disagrees with the segment total, signaling rendered-transformed DOM).

**Tasks:**
- [ ] Implement the segment walk + atomic-widen + whole-block fallback ([Q01]).

**Tests:**
- [ ] `bun:test`: a selection inside plain text slices exactly; a boundary inside `**bold**` / `` `code` `` / `[link](url)` widens to the whole construct **with markers**; inline `$math$` is atomic; every result re-parses (`parse-markdown-to-sanitized-blocks`) to the same structure (no orphaned markers).

**Checkpoint:**
- [ ] Mapper unit-green; partial slices round-trip with syntax intact; [Q01] resolved.

---

#### Step 7: Inline-accurate slicing in range-to-blocks {#step-7}

**Depends on:** #step-6

**Commit:** `feat(tugways): inline-accurate transcript copy within a block [L07]`

**References:** [P02], [P08], [Q01], Spec (#reconstruction-model)

**Artifacts:**
- `range-to-blocks.ts` — for the first/last touched wrapper, compute the selection's **rendered-text offset** within the block and call the mapper; interior wrappers + tool/code stay whole ([P08]).

**Tasks:**
- [ ] Measure the rendered-text offset with a `TreeWalker` that **skips KaTeX/Shiki aux subtrees** (so duplicated MathML/visual text doesn't inflate the offset); if the block's measured rendered length disagrees with the segment total, fall back to whole-block ([Q01]).
- [ ] Wire the mapper; fall back to whole-block on any unresolvable boundary; keep [P08].

**Tests:**
- [ ] `just app-test`: select one sentence inside a plain paragraph → exactly that sentence; select across a `**bold**` / link boundary → widened, well-formed markdown; select inside a paragraph **containing inline `$math$`** → correct source (math atomic), no KaTeX-duplicated garbage.

**Checkpoint:**
- [ ] Single-block partial copy is inline-accurate; math/code/emphasis boundaries widen correctly; no rendered-text drift.

---

#### Step 8: Granularity checkpoint {#step-8}

**Depends on:** #step-5, #step-6, #step-7

**Commit:** `N/A (verification only)`

**References:** (#success-criteria)

**Checkpoint:**
- [ ] `verify`: sub-sentence copies land exactly; math/code still source-sliced; no regressions.

---

> **SUPERSEDED ([P09]).** Fragment serialization is inherently document-order and faithful; there is no tools-first stitch or injected `## Response`. Nothing to do here.

#### Step 9: Partial = document order; full-row stays exact {#step-9}

**Depends on:** #step-1

**Commit:** `fix(tugways): partial copy preserves document order; full-row matches the COPY button [L07]`

**References:** [P03] Partial semantics, gap #6

**Artifacts:**
- `selection-to-markdown.ts` — document-order stitch mode (no tool-first regroup, no injected `## Response`).
- `range-to-blocks.ts` / `dev-card-transcript.tsx` — full-coverage detection routes whole-row to `turnEntryToMarkdown`.

**Tasks:**
- [ ] Add document-order stitch; route full-row to `turnEntryToMarkdown`.

**Tests:**
- [ ] `bun:test`: prose→tool→prose partial keeps order, no heading; full-row equals `turnEntryToMarkdown(turn)` exactly.

**Checkpoint:**
- [ ] Both semantics proven.

---

#### Step 10: Cross-cell / whole-transcript selection copy {#step-10}

**Depends on:** #step-1, #step-9

**Commit:** `feat(tugways): copy a selection spanning multiple transcript rows [L02][L07]`

**References:** [P04] Cross-cell, [Q02], (#q02-cross-cell)

**Artifacts:**
- Transcript host (`DevTranscriptHost` in `dev-card-transcript.tsx`) — host-scope COPY that, when the selection spans >1 cell, walks touched rows in order; contained cells via `turnEntryToMarkdown`, boundary cells via the per-cell range path; joins.

**Tasks:**
- [ ] Resolve [Q02] (interception point; non-rich boundary cells → full turn).
- [ ] Assemble across rows; single-cell keeps the fast path.

**Tests:**
- [ ] `just app-test`: select across two turns (incl. a tool block) → both turns' markdown in order.

**Checkpoint:**
- [ ] Cross-cell copy verified; single-cell unaffected.

---

#### Step 11: Dual text/plain + text/html clipboard {#step-11}

**Depends on:** #step-9

**Commit:** `feat(tugways): copy writes markdown + HTML clipboard formats [L07]`

**References:** [P05] Dual clipboard, [Q04], `tug-text-editor` envelope precedent

**Artifacts:**
- `dev-card-transcript.tsx` — replace `writeText` with a `ClipboardItem` ({`text/plain`: markdown, `text/html`: re-rendered slice}), synchronous in the gesture.
- Reuse the editor's clipboard envelope helper; [Q04] = re-render the slice via parse→sanitize.

**Tasks:**
- [ ] Build both payloads; write one `ClipboardItem`.

**Tests:**
- [ ] `just app-test`: clipboard exposes both `text/plain` and `text/html`; HTML re-parses to the slice's block structure.

**Checkpoint:**
- [ ] Rich + plain paste both correct.

---

#### Step 12: Source-slice regression guards; tool over-copy {#step-12}

**Depends on:** #step-7

**Commit:** `test(tugways): guard source-slice copy for math/code; document tool over-copy`

**References:** [P06] Source slice, [P08] Tool whole, gap #2/#8

**Artifacts:**
- `tests/app-test` — selecting rendered KaTeX/Shiki copies source (`$$…$$`, fenced block), not rendered duplicate text.
- Tool-block over-copy: documented behavior; thinking-block inclusion decision recorded.

**Tasks:**
- [ ] Add the math/code regression tests; finalize thinking/tool over-copy behavior.

**Tests:**
- [ ] `just app-test` math/code source-not-garbage → PASS.

**Checkpoint:**
- [ ] Core defense guarded; edge behaviors documented.

---

#### Step 13: Final integration checkpoint {#step-13}

**Depends on:** #step-4, #step-8, #step-9, #step-10, #step-11, #step-12

**Commit:** `N/A (verification only)`

**References:** (#success-criteria, #exit-criteria)

**Tasks:**
- [ ] End-to-end `verify` on a real heavy session: inline-accurate partial copy; cross-cell; markdown+HTML; math/code source; observable fallback; full-row exact.

**Tests:**
- [ ] Full `verify`; `bun test` green; `bunx tsc --noEmit` clean; Rust tests green.

**Checkpoint:**
- [ ] All success criteria ([#success-criteria]) PASS.

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** A transcript copy path that reconstructs exact markdown (and TeX, via source slicing) for any selection — inline-accurate within a block, whole across tool/code, in document order, across rows — written to the clipboard as both markdown and HTML, with the mis-attribution landmine removed, degradation made observable, and the real COPY wiring covered by tests.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [x] Block enumeration is DOM-sourced; no mirrored filter; drift is observable ([#step-1], [#step-2], [#step-4]).
- [x] Real ⌘C + menu COPY covered by `just app-test` ([#step-3]).
- [x] Inline-accurate single-block copy; graceful fallback — delivered by [P09] fragment serialization (the per-run, clip-to-selection model), not the retired source-slicer.
- [x] Partial = document order; full-row exact — inherent to [P09] serialization ([#step-9] superseded).
- [x] Cross-cell copy works ([#step-10]) — via the range-global serializer, no host handler.
- [x] Clipboard carries markdown + HTML ([#step-11]).
- [x] Math/code source-faithful copy guarded ([#step-12]) — KaTeX TeX annotation + fenced `<pre>`, asserted in `at0188`.
- [x] `bun test` green (3639), `tsc` clean, Rust green (1040), `verify` PASS ([#step-13]).

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] Inline granularity inside tool output / code fences (currently whole, [P08]).
- [ ] A user preference for plain-text-only copy, if ever requested.

| Checkpoint | Verification |
|------------|--------------|
| Robustness | drift observable; real ⌘C app-test |
| Granularity | sub-sentence copy exact; Rust inline-segment tests |
| Reach | cross-cell + dual-format app-tests |
| Defense | math/code source-not-garbage app-test |
