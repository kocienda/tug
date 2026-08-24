<!-- devise-skeleton v4 -->

## Unify the Text Card & File-Display Experience {#editing-experience}

**Purpose:** Make Text cards open and behave like Dev cards, make file-references in tool-call headers jump directly to the touched passage with a macOS-style zoom, retain scroll/caret/selection perfectly across HMR/reload/relaunch (L23), and collapse the three divergent file-display renderers onto one Lezer tokenizer and one `--tug-syntax-*` token set.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-07-11 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

Tugdeck displays file/text content across surfaces that have drifted apart. **Text cards** (the file editor, `tug-file-editor.tsx` → `tug-text-editor.tsx`, CodeMirror 6) highlight through **Lezer** using `tugHighlightStyle` in `lib/language-registry.ts`, reading `--tug-syntax-*` CSS variables. **Read/Write tool-call blocks** (`read-tool-block.tsx` / `write-tool-block.tsx` → `body-kinds/file-block.tsx` → `tug-code-view.tsx`) sit on the same CM6 substrate but mount **no language and no highlighting** — file snippets render as plain uncolored monospace. **Edit/Diff blocks** (`edit-tool-block.tsx` → `body-kinds/diff-block.tsx`) highlight through **Shiki** (`lib/code-block-utils.ts`, `getHighlighter().codeToTokens`), reading a *second* token vocabulary `--syntax-token-*` that aliases `--tug-syntax-*` in `styles/tug.css`. **Markdown code-fences in the live transcript** (`lib/markdown/enhance-fenced-code.ts`, driven by the pulldown-cmark wasm parser) are a fourth surface and today are **not highlighted at all** — `enhanceFencedCode` wraps a plain `<pre>` in header/copy/fold chrome with no token coloring. So the same file colors three different ways (and fences a fourth, plain), kept loosely in sync by hand across two tokenizers and two namespaces.

**Live-vs-dead note (verified during vet).** The *only live Shiki consumer* is the diff renderer (`diff-block.tsx` → `lib/code-block-utils.ts` → `lib/diff/syntax-tokens-from-shiki.ts`). The older `lib/markdown.ts` (`marked` + Shiki `enhanceCodeBlocks`/`codeToHtml`) and its `_archive/cards/conversation/message-renderer.tsx` caller are **dead code** — zero live importers, `src/_archive/**` excluded from `tsconfig`. So retiring Shiki hinges on the diff migration alone; `lib/markdown.ts` is deleted as dead code, not migrated. Adding Lezer coloring to the live transcript fences is a **net-new feature** on `enhance-fenced-code.ts`, not a Shiki migration, and does not gate Shiki removal.

Three more gaps compound this. (1) Text cards open at `480×300` min / `820×620` preferred while Dev cards open at `800×600` min / `850×1200` preferred (`text-card-registration.tsx` vs `dev-card-registration.tsx`) — a Text card opens small and cramped next to a Dev card. (2) Clicking a file in a tool-call header (`ToolFileRef` in `tool-file-ref.tsx`) opens the file at *most* at a bare line — Edit and Write pass no line at all — with no selection and no reveal animation, even though the exact touched hunk range is known at render time in `edit-tool-block.tsx`. (3) Text card scroll/caret/selection are **not** reliably retained across HMR, Maker ▸ Reload, or relaunch: `getPositions` (`tug-file-editor.tsx`) saves only the collapsed caret head (selection range is discarded), and `applyPositions` writes `scrollDOM.scrollTop` synchronously before CM6 has measured the freshly-read document, so CM6 re-measures and clamps and the viewport jumps — a direct L23 violation.

#### Strategy {#strategy}

- **One tokenizer, one namespace.** Lezer becomes the single highlighting engine for every file-display surface; `--tug-syntax-*` becomes the single token namespace; Shiki and the `--syntax-token-*` bridge are deleted. Static fragments (diff hunk sides, live transcript code-fences) tokenize by building a *headless* `EditorState` with the editor's exact resolved language extension, forcing a full parse with `ensureSyntaxTree`, and walking `highlightTree`; Read/Write blocks are a *live* CM6 view and simply gain the editor's language extension. Same grammar as the live editor either way, so a file colors identically everywhere. [P01], [P02]
- **The token-merge machinery is already source-agnostic.** `lib/diff/render-line.ts` (`renderLineSegments`) merges `SyntaxToken[]` (start/end + decoration) with word-level diff ranges and knows nothing about Shiki. We re-target only the token *producer*; the merge, and the `diff-match-patch` word-overlay exactly as today, are untouched. [P04]
- **Sequence low-risk → structural.** Sizing parity first (trivial, independent), then build the shared static tokenizer, migrate each consumer onto it, delete Shiki, then fix persistence and add click-to-passage — each a clean commit with a falsifiable checkpoint.
- **Persistence rides the existing bag + [A9] protocol.** No new persistence channel: extend the `FilePositions` payload the Text card already writes to tugbank to carry the full selection, and defer the scroll restore until CM6 has measured — mirroring the proven "scroll last" ordering in `card-host.tsx`. [P05], [P06]
- **Reveal selects, then zooms.** Widen the `open-file` chain to carry an optional line range; the editor reveals *and selects* it and plays a one-shot flash decoration reusing the existing find-flash keyframes in `tug-code-view.css`. [P07], [P08]

#### Success Criteria (Measurable) {#success-criteria}

- A newly opened Text card has byte-identical `sizePolicy` to a Dev card except a `400` min height: `min {800,400}`, `preferred {850,1200}`, no `max`. (Read the two registrations; open both in the running app and compare.) [P03]
- The same `.ts` file shows identical syntax colors in a Text card, a Read block, and an Edit diff — all sourced from `--tug-syntax-*`, no `--syntax-token-*` references remain. (`grep -r "syntax-token" tugdeck/` returns nothing; visual compare in-app.) [P01]
- `import { getHighlighter } from ...code-block-utils` and the `shiki` dependency are gone from the tugdeck build. (`grep -rn "shiki\|code-block-utils\|codeToTokens\|codeToHtml" tugdeck/src --exclude-dir=_archive` returns nothing; `bunx vite build` succeeds.) [P01]
- Live transcript code-fences render Lezer-colored tokens matching a Text card of the same code (they are plain today). (Drive in-app on an assistant message with a fenced block.) [P09]
- Clicking a file in an Edit tool-call header opens the file scrolled to the first changed hunk with that hunk's line range **selected** and a visible one-shot zoom/flash over it. (Drive in-app on a real edit tool call.) [P07], [P08]
- After Maker ▸ Reload with a Text card holding a non-trivial scroll offset, a caret mid-file, and a multi-line selection, all three return exactly. Same after an HMR edit to `tug-text-editor.tsx`. (app-test + manual.) [P05], [P06]
- `cargo`-side unchanged; `cd tugdeck && bun run typecheck && bunx vite build && bun run audit:theme-contrast` all pass. [R04]

#### Scope {#scope}

1. Text card `sizePolicy` parity with the Dev card (min height floored at 400).
2. A shared static Lezer tokenizer (`tokenizeFragment`) in the language registry, emitting per-line `{start,end,className}` tokens from the editor's own grammars.
3. Read/Write tool blocks (`TugCodeView`) highlighted through Lezer.
4. Diff renderer (`diff-block.tsx`) re-targeted from Shiki to Lezer, grammar-seed ported, word-overlay unchanged.
5. Live transcript code-fences (`lib/markdown/enhance-fenced-code.ts`) gain Lezer syntax coloring (net-new — plain today).
6. Shiki, the `--syntax-token-*` bridge, `code-block-utils.ts`, and the dead `lib/markdown.ts` deleted.
7. Full-selection persistence + measure-gated scroll restore for the Text card (HMR/reload/relaunch).
8. Range-carrying `open-file` chain: reveal + select the touched passage with a zoom/flash animation.

#### Non-goals (Explicitly out of scope) {#non-goals}

- A Find/replace UI redesign. The bundled CM6 search panel stays latent as today; this plan only *reuses* its flash decoration mechanism for reveal.
- Side-by-side vs inline diff behavior changes, hunk-collapse behavior, or diff word-diff algorithm changes — the diff renderer's structure and `diff-match-patch` word ranges are preserved verbatim.
- New language grammars beyond the union of what Lezer already loads plus what Shiki currently covers (go/java/sql/dockerfile) — see [R01].
- Per-hunk click targeting (clicking a specific hunk row jumps to *that* hunk). We target the first hunk only; per-hunk wiring is a follow-on. [P07]
- Removing the IndexedDB/`SessionCache` layer (tracked separately).

#### Dependencies / Prerequisites {#dependencies}

- CodeMirror 6 packages already vendored: `@codemirror/state`, `@codemirror/view`, `@codemirror/language`, `@lezer/highlight`, and the `@codemirror/lang-*` / `@codemirror/legacy-modes` grammars enumerated in `lib/language-registry.ts`.
- New grammar packages for languages Shiki covers but the registry does not yet: `@codemirror/lang-go`, `@codemirror/lang-java`, `@codemirror/lang-sql`, and a dockerfile legacy mode (`@codemirror/legacy-modes/mode/dockerfile`). Verify availability at implementation; fall back to plain text where a grammar is genuinely unavailable (same graceful degradation Read/Write have today). [R01]
- tugbank card-state persistence (`dev.tugtool.deck.cardstate/{cardId}`) and the `useCardStatePreservation` / `hmr-bridge.ts` capture path — already in place; this plan only widens the payload.

#### Constraints {#constraints}

- **Warnings are errors** across the workspace; tugdeck must pass `bun run typecheck` and `bunx vite build` (the debug app loads the production rollup bundle — an import that only works under dev esbuild can hang the app at the splash screen, so `bunx vite build` is mandatory before declaring any tugdeck change done). See [feedback_verify_with_vite_build].
- **Tuglaws.** L02 (external state via `useSyncExternalStore`), L03 (`useLayoutEffect` for registrations events depend on), L06/L24 (appearance via CSS+DOM, never React state), L23 (never lose user-visible state across teardown), L26 (stable mount identity). The [A9] state-preservation protocol and `CardStateBag` are the mechanisms for L23 here.
- No `localStorage`/`sessionStorage`/IndexedDB — persistent state goes through the card bag → tugbank. [feedback_no_localstorage]
- Reuse existing Tug components; do not hand-roll UI that exists. [feedback_use_tug_components]
- Theme contrast budget: no theme may exceed the `brio` accessibility budget (`bun run audit:theme-contrast`).

#### Assumptions {#assumptions}

- Lezer's `HighlightStyle.define(...)` object is a valid `Highlighter` for `highlightTree`, and its generated `StyleModule` (`.module`) mounts once to make its classes resolve to `--tug-syntax-*` colors. [P02]
- `ensureSyntaxTree(state, text.length, timeout)` fully parses fragment-sized inputs (hunk sides, snippets, fences) within a small timeout; on timeout we fall back to plain text. [R02]
- The existing `grammarSeedLines` synthetic-opener strings (`lib/diff/grammar-seed.ts`) are language-agnostic code prefixes and work unchanged under Lezer once their language keying is mapped from Shiki ids to the registry's extension/id vocabulary. [P02]
- The Dev card's `preferred` height of `1200` being canvas-clamped by `addCard` is intended behavior we are copying, not a bug. [P03]

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

This plan uses explicit `{#anchor}` headings and rich `**References:**` lines. Plan-local decisions are `[P01]`+; global design decisions (if cited) are `[D##]`. Never cite line numbers — cite anchors and symbol names.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Lezer tag → token-slot coverage vs Shiki (DECIDED) {#q01-tag-coverage}

**Question:** Shiki's hand-authored theme (`code-block-utils.ts`) distinguishes more buckets than the current `tugHighlightStyle` map — it colors `operator`, `punctuation`, `variable.parameter`, and `constant` distinctly, and has dedicated `tag`/`attribute`/`decorator` rules. Does the Lezer `HighlightStyle` reproduce (or exceed) that fidelity, or will diffs look flatter after the switch?

**Why it matters:** A visibly flatter diff would be a regression users notice immediately.

**Options (if known):**
- Extend `tugHighlightStyle` to map the full Lezer standard-tag set to the existing `--tug-syntax-*` / `--tugx-syntax-*` slots (`tags.operator` → `--tugx-syntax-operator`, `tags.punctuation` → `--tugx-syntax-punctuation`, `tags.constant(...)` → `--tug-syntax-constant`, etc.), keeping editor and diff at parity or better.
- Accept the current shorter map and its flatter output.

**Plan to resolve:** Resolved in this plan.

**Resolution:** DECIDED (see [P04]) — Step 2 extends `tugHighlightStyle` to the full standard-tag set against the existing token slots so every surface (editor included) gains the richer coverage at once. The `--tugx-syntax-operator` / `--tugx-syntax-punctuation` tokens already exist in `tug-code.css`.

#### [Q02] Live fence highlighting output form + async-into-sync patch (DECIDED) {#q02-fence-output}

**Question:** The live fence enhancer `enhanceFencedCode` (`lib/markdown/enhance-fenced-code.ts`) is a **synchronous** DOM walk over pulldown-cmark `<pre>` output that today applies *no* coloring. `tokenizeFragment` is **async** (grammar chunks lazy-load). How does async token HTML land into a sync enhancement pass without racing the windowing engine's prune/re-render?

**Why it matters:** A fire-and-forget async patch that writes into a `<code>` after its block has been pruned or re-`innerHTML`'d would either throw on a detached node or paint stale colors over new content.

**Options (if known):**
- A `highlightFragmentToHtml(text, langId)` helper that emits class-per-token `<span>` HTML; `enhanceFencedCode` kicks it off per `<pre>` and, on resolve, patches the `<code>` innerHTML only if the node is still connected AND its text is unchanged (guard token), so a pruned/rewritten block is skipped.
- Move fence tokenization upstream into `parseMarkdownToSanitizedBlocks` (synchronous, pre-`innerHTML`) — rejected: that parse path is wasm/pulldown-cmark and has no grammar access, and blocking it on async grammar loads would stall the transcript.

**Plan to resolve:** Resolved in this plan.

**Resolution:** DECIDED (see [P09]) — Step 5 adds `highlightFragmentToHtml(text, langId)` on top of `tokenizeFragment` (class-per-token `<span>` HTML, classes only, no inline styles) and wires it into `enhanceFencedCode`: fire per `<pre>`, and on resolve re-check `codeEl.isConnected` and that `codeEl.textContent` still equals the tokenized source before patching innerHTML. Idempotent (skip an already-colored `<pre>`). The `HighlightStyle` `StyleModule` is mounted globally so the classes resolve; the existing `.tugx-md-fenced-code` chrome is untouched.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Language coverage gap after dropping Shiki | med | med | Add go/java/sql/dockerfile grammars to the registry; plain-text fallback elsewhere | A diff/fence in a covered-by-Shiki language renders plain |
| `ensureSyntaxTree` cost on large inputs | med | low | Bounded parse timeout + plain-text fallback; fragments are small | Visible hitch tokenizing a big hunk/file |
| Scroll-restore still races CM6 measure | high | med | Mirror `card-host.tsx` "scroll last"; one-shot measure gate; app-test it | Viewport jumps after reload in the test |
| Dangling Shiki refs after deletion | low | med | grep + `bunx vite build` gate in the cleanup step | Build error or stray `--syntax-token-*` |
| Fence async coloring races sync walk / prune | med | med | `isConnected`+unchanged-text patch guard; idempotent enhance | Console error or stale paint on transcript scroll |

**Risk R01: Language coverage regression after removing Shiki** {#r01-language-coverage}

- **Risk:** Shiki's `INITIAL_LANGUAGES` includes go, java, sql, and dockerfile, which the CM registry's `LOADERS` table does not; diffs/fences in those languages would drop from colored to plain.
- **Mitigation:** Step 2 extends `LOADERS`/`LANGUAGE_LABELS`/`SELECTABLE_LANGUAGES` with Lezer grammars for the union set (`@codemirror/lang-go`, `@codemirror/lang-java`, `@codemirror/lang-sql`, dockerfile legacy mode). Where no grammar exists, the surface falls back to plain text — exactly the behavior Read/Write already have.
- **Residual risk:** A niche language Shiki bundled on-demand (via `loadLanguage`) but the registry omits renders plain; acceptable and consistent with the editor's own coverage.

**Risk R02: Static-parse performance** {#r02-parse-perf}

- **Risk:** Building a headless `EditorState` and forcing a full parse per fragment could hitch on very large hunks or whole-file Read snippets.
- **Mitigation:** `ensureSyntaxTree(state, len, timeout)` with a small timeout and plain-text fallback; cache nothing per-keystroke (fragments are static). Tokenization already runs in an effect off the render path (as the Shiki version does).
- **Residual risk:** A pathological multi-thousand-line hunk tokenizes plain on timeout; no correctness loss.

**Risk R03: Reload scroll jump persists** {#r03-scroll-jump}

- **Risk:** The measure-gate fires before CM6 has laid out line heights and the clamp still moves the viewport.
- **Mitigation:** Gate scroll restore on a one-shot CM6 `updateListener`/`requestMeasure` after the seeded document binds and geometry is known, applying scroll *after* selection — the ordering `card-host.tsx` uses for form-control/scroll restore. Assert with an app-test that reads `scrollDOM.scrollTop` post-reload.
- **Residual risk:** Extremely long files whose full height isn't known until fully parsed may need a second settle; covered by re-applying on the first post-parse measure.

**Risk R05: Fence async coloring races the sync DOM walk / windowing prune** {#r05-fence-async}

- **Risk:** `enhanceFencedCode` is a synchronous DOM walk but `tokenizeFragment` is async (grammar chunks lazy-load); a fire-and-forget patch could write into a `<code>` node the windowing engine has already pruned or re-`innerHTML`'d, throwing on a detached node or painting stale colors over new content.
- **Mitigation:** On async resolve, patch only if `codeEl.isConnected` and `codeEl.textContent` still equals the tokenized source; otherwise skip. Enhancement stays idempotent (skip an already-colored `<pre>`). Covered by the Step 5 manual prune-during-highlight test.
- **Residual risk:** A block pruned mid-highlight simply stays plain until re-enhanced on its next render — no error, no stale paint.

---

### Design Decisions {#design-decisions}

#### [P01] Lezer is the single tokenizer; `--tug-syntax-*` the single namespace {#p01-single-tokenizer}

**Decision:** All four file-display surfaces (Text card editor, Read/Write blocks, Edit/Diff blocks, markdown fences) highlight through Lezer and read `--tug-syntax-*` / `--tugx-syntax-*`. Shiki (`code-block-utils.ts`, the `shiki` dependency), and the `--syntax-token-*` bridge in `styles/tug.css`, are deleted.

**Rationale:**
- The editor already runs Lezer at keystroke latency; reusing its grammars for static fragments means one grammar registry, one highlight map, one namespace — a file colors identically everywhere and theme switches recolor every surface live.
- Two token vocabularies for the same colors is a standing maintenance trap: a new bucket must be added to the Lezer map, the Shiki scope list, and the `tug.css` bridge, and they already disagree (`--syntax-token-variable` maps to prose while CM colors variable definitions; `--syntax-token-link` → function vs CM → string).

**Implications:**
- A shared static tokenizer must exist ([P02]) before any consumer migrates.
- Grammar coverage must reach the union of today's Lezer + Shiki languages ([R01]).

#### [P02] Static fragments tokenize via a headless EditorState + ensureSyntaxTree + highlightTree {#p02-static-tokenizer}

**Decision:** Add `tokenizeFragment(text, ext)` (and a language-id variant) to `lib/language-registry.ts`. It resolves the same `Extension` `languageForExtension(ext)` returns, builds a throwaway `EditorState.create({ doc: text, extensions: [languageExtension] })`, forces a full parse with `ensureSyntaxTree(state, text.length, TIMEOUT)`, walks the tree with `highlightTree(tree, tugHighlightStyleInner, cb)`, and returns per-line `{start,end,className}[]`. The `HighlightStyle`'s `StyleModule` is mounted once so those classes resolve to `--tug-syntax-*`.

**Rationale:**
- Reuses the editor's *exact* grammar and highlight map — the strongest possible guarantee that static and live highlighting agree.
- Emits class names (not inline styles), which compose cleanly with the diff word-overlay class on the same span and match how CM applies the editor's own highlighting.

**Implications:**
- `tugHighlightStyle` (the extension) is refactored to derive from an exported raw `tugHighlightStyleInner = HighlightStyle.define([...])`, so both `syntaxHighlighting(tugHighlightStyleInner)` (editor) and `highlightTree(..., tugHighlightStyleInner, ...)` (fragments) share one definition.
- `SyntaxToken` (in `lib/diff/`) gains a `className` field; `render-line.ts` applies `className` (union with the word-overlay class) instead of an inline `style` string.

#### [P03] Text card sizing mirrors the Dev card, min height floored at 400 {#p03-sizing}

**Decision:** `text-card-registration.tsx` `sizePolicy` becomes `min: {width:800, height:400}`, `preferred: {width:850, height:1200}`, no `max` — identical to the Dev card except the min height (Dev is 600).

**Rationale:**
- User directive: Text cards open and size like Dev cards. The `800` width floor and `850×1200` preferred match Dev exactly (Dev's `preferred` height is intentionally canvas-clamped by `addCard`; we inherit that).
- The Dev card's `600` height floor exists to fit its fixed 200px prompt entry + toolbars + transcript minimum — a Text card has no such row, so `400` is the chosen floor, letting a Text card shrink a bit more vertically while keeping the shared `800` width and open size.

**Implications:**
- Text cards can no longer be dragged narrower than `800` (a deliberate behavior change). Both cards flow through the same `addCard` 90%-canvas clamp and `TugPane` enforcement, so nothing else changes.

#### [P04] Tokens are CSS classes; the diff word-overlay is preserved verbatim {#p04-classes-and-overlay}

**Decision:** Fragment tokens carry a `className` (from the extended `tugHighlightStyle`, mapping the full Lezer standard-tag set — [Q01] — to `--tug-syntax-*`/`--tugx-syntax-*`). `render-line.ts` merges syntax `className` with the existing `diff-match-patch` word-range classes (`tugx-diff-word-add`/`-remove`) on the same `<span>`, exactly as today; only the syntax decoration's form changes (className vs inline style).

**Rationale:** The word-overlay is correct and user-visible; the merge algorithm is already source-agnostic. Changing only the token producer minimizes regression surface. User directive: keep the word-level overlay merged onto the new Lezer spans exactly as today.

**Implications:** `diff-block.tsx`'s span render (which currently parses Shiki inline `style`) applies `className` for syntax instead; `tugx-diff-content` spans carry both syntax and word classes.

#### [P05] FilePositions persists the full selection, not a collapsed caret {#p05-selection-persist}

**Decision:** Extend `FilePositions` (`lib/text-card-store.ts`) from `{ anchor:{line,ch}, scrollTop }` to also carry the selection **head** (a range: `anchor` + `head`, both `{line,ch}`; multi-range optional). `getPositions` reads `state.selection.main.anchor` **and** `.head`; `applyPositions` restores a real selection range, not a bare cursor.

**Rationale:** L23 names selection as user data that must survive teardown; today it is silently dropped at capture time, so no restore path could ever bring it back.

**Implications:** The bag payload the card writes to tugbank (`useCardStatePreservation` in `text-card.tsx`) widens; restore in `onRestore`/`applyPositions` reconstructs the range. Backward-compatible read: a bag with only `anchor` restores a collapsed caret (old behavior) rather than erroring.

#### [P06] Scroll restore is deferred until CM6 has measured {#p06-measure-gate}

**Decision:** Replace the synchronous `live.scrollDOM.scrollTop = positions.scrollTop` in `applyPositions` with a one-shot measure-gated restore: after the seeded document binds, apply selection first, then apply scroll on the first CM6 measure where line geometry is known (via `requestMeasure` / a one-shot `updateListener`), mirroring the "scroll last" ordering in `card-host.tsx`.

**Rationale:** The current write lands before CM6 measures the just-read text; CM6 re-measures and clamps `scrollTop`, producing the jump. Deferring past measure removes the clamp race. L23 + L03.

**Implications:** `applyPositions` (and the `useLayoutEffect` in `text-card.tsx` that calls it after `phase === "ready"`) coordinate a one-shot gate; the gate must be idempotent and drop if the card re-anchors before it fires (same stale-path discipline the store uses).

#### [P07] open-file carries an optional line range; reveal selects the first hunk {#p07-range-open}

**Decision:** Widen the open path end-to-end to carry an optional `{startLine, endLine}` range: `ToolFileRef` gains a `range?` prop; `edit-tool-block.tsx`/`write-tool-block.tsx` populate it from the first hunk (`diffData.hunks[0].after_start` + line count); the `open-file` action payload, `openFileInCard`, the card seed (`anchor` → add `selection`), and `revealLine` accept a range. The editor reveals and **selects** the range (dispatch `selection: {anchor,head}` + `scrollIntoView(range,{y:"center"})`). Edit/Write target the first hunk; Read keeps its window start.

**Rationale:** The touched range is known at render time but thrown away; a caret-only jump can't drive the macOS-style zoom the user wants. First-hunk (not clicked-hunk) keeps the wiring bounded ([non-goals](#non-goals)).

**Implications:** `revealLine(line)` becomes `reveal(target)` where `target` is a line or a range; the reuse-registry entry (`text-card-open-registry.ts` / `text-card.tsx`) and `open-file-in-card.ts`'s `seed` grow a `selection` field.

#### [P08] Reveal plays a one-shot zoom/flash decoration {#p08-flash}

**Decision:** On reveal, apply a one-shot CM6 decoration over the revealed range that runs a zoom/flash keyframe, reusing the existing `@keyframes tugx-codeview-find-flash` ping pattern from `tug-code-view.css` (currently search-driven, unused by reveal). Appearance only — a CM6 decoration + CSS animation, never React state.

**Rationale:** Matches macOS find-zoom feedback; reuses proven, themed motion tokens (`--tug-motion-duration-slow`/`--tug-motion-easing-exit`). L06/L24.

**Implications:** A small decoration field/plugin in `tug-file-editor.tsx` (or a shared editor module) applies the mark and clears it after one cycle; the keyframe/class is shared or copied into the file-editor CSS.

#### [P09] Live transcript code-fences gain Lezer coloring (net-new) {#p09-fences}

**Decision:** The **live** fence enhancer `enhanceFencedCode` (`lib/markdown/enhance-fenced-code.ts`) — a synchronous DOM walk over pulldown-cmark `<pre>` output that applies no coloring today — gains a call to `highlightFragmentToHtml(text, langId)` (built on `tokenizeFragment`), emitting class-per-token `<span>` HTML for the `<code>` body. It resolves the fence language from the existing `readLanguage` (`<code class="language-X">`) through the registry's id→grammar path, and patches innerHTML on async resolve guarded by `isConnected` + an unchanged-text token ([Q02]). The `.tugx-md-fenced-code` chrome (header/copy/fold) is untouched. This is **net-new** — fences are plain today — not a Shiki migration.

**Rationale:** Delivers the user's "fold fences into the Lezer path" directive on the surface that is actually live, and unifies fence coloring with the editor. Note this does **not** gate Shiki removal — the only live Shiki consumer is the diff renderer ([P01]).

**Implications:** The registry gains an id→grammar resolution path reusing `normalizeLanguage`-style aliasing; `highlightFragmentToHtml` and the async-patch guard are new; the dead `lib/markdown.ts` (`marked`+Shiki `enhanceCodeBlocks`) is deleted separately in Step 6, not edited here.

---

### Deep Dives {#deep-dives}

#### The shared static tokenizer {#shared-tokenizer}

**Spec S01: `tokenizeFragment`** {#s01-tokenize-fragment}

Signature (in `lib/language-registry.ts`):

```
export interface FragmentToken { start: number; end: number; className: string }
// Per-line tokens over `text` (split on "\n"); line N → tokens[N].
export async function tokenizeFragment(text: string, ext: string | null): Promise<FragmentToken[][]>
export async function tokenizeFragmentByLangId(text: string, langId: string): Promise<FragmentToken[][]>
```

Algorithm:
1. Resolve the language `Extension` via the existing lazy `languageForExtension(ext)` (or an id variant). `null` → return per-line empty token arrays (plain text).
2. Build `const state = EditorState.create({ doc: text, extensions: [languageExtension] })`.
3. `const tree = ensureSyntaxTree(state, text.length, PARSE_TIMEOUT_MS) ?? syntaxTree(state)`.
4. Walk: `highlightTree(tree, tugHighlightStyleInner, (from, to, classes) => push({from,to,classes}))`.
5. Slice the flat `{from,to,classes}` runs per line using `state.doc.lineAt`, converting to line-relative `{start,end,className}`. Runs that span a newline are split at line boundaries.
6. Mount `tugHighlightStyleInner.module` (a `StyleModule`) once at first use so `classes` resolve to `--tug-syntax-*` colors.

`tugHighlightStyleInner` is the raw `HighlightStyle.define([...])` (exported), extended per [Q01] to the full standard-tag set. `tugHighlightStyle` (the editor extension) becomes `syntaxHighlighting(tugHighlightStyleInner)`.

**Consumers:**
- **Read/Write** (`tug-code-view.tsx`): the read-only CM6 view already carries a `language` prop it treats as informational. Add the `languageForExtension` + `tugHighlightStyle` extensions to its extension list (it is a real `EditorView`, so it uses the *live* highlighting path, not `tokenizeFragment`). This is the simplest migration — no token plumbing.
- **Diff** (`diff-block.tsx`): replace the Shiki `codeToTokens` effect with `tokenizeFragment` over each reconstructed hunk side (before/after), keeping the exact position-keyed `Map<"hunkIndex:lineIndex", SyntaxToken[]>` shape and the grammar-seed prepend/drop. `SyntaxToken.style` → `SyntaxToken.className`.
- **Live transcript fences** (`lib/markdown/enhance-fenced-code.ts`): `highlightFragmentToHtml` over the `<code>` body, patched on async resolve with an `isConnected`+unchanged-text guard ([P09], [Q02]). Net-new coloring, not a Shiki migration.

#### Grammar-seed port {#grammar-seed-port}

`grammarSeedLines(sideText, lang)` (`lib/diff/grammar-seed.ts`) returns synthetic opener strings (`"/*"`, `"seed {"`, `"seed: f("`) that are language-agnostic code prefixes. Under Lezer the technique is identical: prepend `seeds.join("\n") + "\n"`, tokenize the combined text, drop the first `seeds.length` lines of tokens. Only the *keying* changes: `BLOCK_COMMENT_LANGS`/`CSS_RULE_LANGS` are Shiki-normalized ids today; map them to the registry's ext/id vocabulary (e.g. accept both `"ts"`/`"typescript"`). Keep the heuristic and the sets otherwise unchanged.

#### Persistence: capture, restore, and the measure gate {#persistence-flow}

Current flow (to change): `getPositions` reads only `selection.main.head` → collapsed `anchor`; the card writes `{path,anchor,scrollTop,...}` to the bag via `useCardStatePreservation`; on restore, `onRestore` stashes `pendingPositionsRef` and calls `store.openPath`; a `useLayoutEffect` keyed on `phase` calls `store.applyPositions`, which writes `scrollTop` synchronously → clamp/jump.

New flow: `getPositions` captures `{anchor:{line,ch}, head:{line,ch}, scrollTop}`; `applyPositions` restores the selection range immediately, then schedules the scroll for the first post-bind CM6 measure ([P06]). HMR is covered for free: `hmr-bridge.ts` already fires `captureAllForTeardown("hmr")` and replays the bag; a wider bag + measure-gated restore means HMR, Maker ▸ Reload, and cold relaunch all use the same corrected path.

---

### Specification {#specification}

#### State Zone Mapping {#state-zone-mapping}

| State | Zone | Mechanism | Law |
|-------|------|-----------|-----|
| Text card `sizePolicy` | static config | registration literal in `text-card-registration.tsx` | — |
| Selection range in `FilePositions` (anchor+head) | local-data | captured via `useCardStatePreservation` → tugbank bag; restored via CM6 dispatch | [L23], [L02] |
| Scroll offset restore timing | local-data (restore) | one-shot measure gate (`requestMeasure`/`updateListener`) applied after selection | [L23], [L03] |
| Syntax highlight classes (all surfaces) | appearance | CM6 `syntaxHighlighting` (editor) / `tokenizeFragment` → `<span class>` (fragments); `StyleModule` + `--tug-syntax-*` CSS | [L06], [L24] |
| Zoom/flash reveal decoration | appearance | CM6 decoration + `@keyframes`; never React state | [L06], [L24] |
| `open-file` range payload (in-flight) | ephemeral | action-dispatch payload → seed; not persisted | [L11] |

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tugdeck/src/lib/diff/syntax-tokens-from-lezer.ts` | Replaces `syntax-tokens-from-shiki.ts`: convert `highlightTree` runs → per-line `SyntaxToken[]` with `className` |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `tugHighlightStyleInner` | export const (HighlightStyle) | `lib/language-registry.ts` | raw definition, full standard-tag map ([Q01]); `tugHighlightStyle = syntaxHighlighting(tugHighlightStyleInner)` |
| `tokenizeFragment` / `tokenizeFragmentByLangId` | export fn | `lib/language-registry.ts` | Spec S01 |
| `highlightFragmentToHtml` | export fn | `lib/language-registry.ts` (or sibling) | class-per-token HTML for live transcript fences ([P09]) |
| `enhanceFencedCode` | fn | `lib/markdown/enhance-fenced-code.ts` | add async Lezer coloring of the `<code>` body with `isConnected`+unchanged-text patch guard |
| `LOADERS` / `LANGUAGE_LABELS` / `SELECTABLE_LANGUAGES` | data | `lib/language-registry.ts` | add go/java/sql/dockerfile ([R01]); add id→grammar resolution |
| `SyntaxToken` | interface | `lib/diff/syntax-tokens-from-lezer.ts` | `{start,end,className}` (was `style`) |
| `RenderedSegment` / `renderLineSegments` | interface/fn | `lib/diff/render-line.ts` | segment carries `className` for syntax; union with word-overlay class |
| `grammarSeedLines` keying | fn | `lib/diff/grammar-seed.ts` | map lang sets to registry ext/id vocabulary |
| `FilePositions` | interface | `lib/text-card-store.ts` | add selection `head`; make `head` optional for back-compat |
| `getPositions` / `applyPositions` | fn | `tug-file-editor.tsx` | capture+restore full selection; measure-gated scroll |
| `revealLineFn` → `revealFn` | fn | `tug-file-editor.tsx` | accept a line or a range; select + flash |
| `ToolFileRefProps.range` | prop | `tool-file-ref.tsx` | `{startLine,endLine}`; carried on `open-file` dispatch |
| `openFileInCard` `seed` | fn | `lib/open-file-in-card.ts` | seed grows optional `selection` range |
| `TUG_ACTIONS.OPEN_FILE` payload | type | `action-vocabulary.ts` + `action-dispatch.ts` | add optional `range`/`endLine` |
| flash decoration | CM6 field/plugin | `tug-file-editor.tsx` (+ CSS) | reuse `tugx-codeview-find-flash` keyframe |

#### Files to delete {#files-to-delete}

| File | Reason |
|------|--------|
| `tugdeck/src/lib/code-block-utils.ts` | Shiki singleton + theme — sole live consumer (diff) migrated in Step 4 |
| `tugdeck/src/lib/diff/syntax-tokens-from-shiki.ts` | superseded by the Lezer variant |
| `tugdeck/src/lib/markdown.ts` | dead code (`marked`+Shiki `enhanceCodeBlocks`); only `_archive` callers, no live importer |
| `--syntax-token-*` block in `styles/tug.css` | the Shiki bridge namespace |
| `shiki` dependency in `tugdeck/package.json` | last consumer removed |

New grammar packages to add (`bun add`): `@codemirror/lang-go`, `@codemirror/lang-java`, `@codemirror/lang-sql` (not currently installed; `@codemirror/legacy-modes` — already present — supplies dockerfile). Without these, go/java/sql diffs regress to plain ([R01]).

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When |
|----------|---------|------|
| Unit | `tokenizeFragment` per-line token slicing; `render-line.ts` className merge; `FilePositions` round-trip incl. selection | pure logic |
| Integration (app-test) | reload retains scroll+caret+selection; click-to-passage selects first hunk + flashes; Read block colored | real app via `just app-test` |
| Contract | `bunx vite build` + `bun run typecheck` + `grep` gates prove Shiki fully removed | cleanup step |
| Drift | `bun run audit:theme-contrast` stays within budget after any token additions | after Step 2/6 |

#### What stays out of tests {#test-non-goals}

- No jsdom render tests / mock-store assertions — drive the real editor and real files. [feedback_real_not_fake]
- No golden-image pixel diffs of syntax colors — verify token *classes* in unit tests and eyeball in-app; pixels are too brittle across themes.
- No re-testing CM6/Lezer internals — we test our tokenizer glue, not the grammars.

---

### Execution Steps {#execution-steps}

> Commit after all checkpoints pass. tugdeck steps must pass `bun run typecheck` and `bunx vite build` before commit.

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Text card sizing parity | done | 86493f752 |
| #step-2 | Shared static Lezer tokenizer + full tag map + language coverage | done | 7044d7b8a |
| #step-3 | Read/Write blocks highlighted via Lezer | done | a9b3747b7 |
| #step-4 | Diff renderer re-targeted Shiki → Lezer | done | 14891a1bf |
| #step-5 | Color live transcript code-fences (net-new) | done | df9b1b120 |
| #step-6 | Delete Shiki + bridge + dead markdown.ts | done | 8a05b4bf8 |
| #step-7 | Rendering-unification integration checkpoint | done | (verify) |
| #step-8 | Full-selection persistence + measure-gated scroll | done | 341f1e96f |
| #step-9 | Click-to-passage: range open + select + zoom flash | done | f3c905ef7 |
| #step-10 | End-to-end integration checkpoint | done | (verify) |

#### Step 1: Text card sizing parity {#step-1}

**Commit:** `feat(text-card): size like the Dev card (min 800x400, preferred 850x1200)`

**References:** [P03] (#p03-sizing, #success-criteria)

**Artifacts:**
- Updated `sizePolicy` in `tugdeck/src/components/tugways/cards/text-card-registration.tsx`.

**Tasks:**
- [ ] Set `sizePolicy.min = { width: 800, height: 400 }`, `sizePolicy.preferred = { width: 850, height: 1200 }`, no `max` — matching `dev-card-registration.tsx` except the min height.
- [ ] Update the registration doc comment to state the parity and the 400 height floor rationale (no prompt-entry row, so it can shrink below Dev's 600).

**Tests:**
- [ ] Manual: open a Text card and a Dev card in the running app; confirm equal open size and equal min-drag width.

**Checkpoint:**
- [ ] `cd tugdeck && bun run typecheck && bunx vite build`
- [ ] `just app-test` (no regression)

---

#### Step 2: Shared static Lezer tokenizer + full tag map + language coverage {#step-2}

**Depends on:** #step-1

**Commit:** `feat(highlight): shared Lezer fragment tokenizer over the editor grammars`

**References:** [P01] (#p01-single-tokenizer), [P02] (#p02-static-tokenizer), [Q01] (#q01-tag-coverage), Spec S01 (#s01-tokenize-fragment), Risk R01 (#r01-language-coverage), Risk R02 (#r02-parse-perf)

**Artifacts:**
- `tugHighlightStyleInner` (raw, full standard-tag map) + `tugHighlightStyle` derived; `tokenizeFragment` / `tokenizeFragmentByLangId` / `highlightFragmentToHtml` in `lib/language-registry.ts`.
- Extended `LOADERS`/`LANGUAGE_LABELS`/`SELECTABLE_LANGUAGES` + id→grammar resolution.
- `StyleModule` mount for the highlight classes.

**Tasks:**
- [ ] Refactor `language-registry.ts`: export `tugHighlightStyleInner = HighlightStyle.define([...])`; extend the map to the full Lezer standard-tag set against existing slots (`tags.operator`→`--tugx-syntax-operator`, `tags.punctuation`→`--tugx-syntax-punctuation`, `tags.constant(tags.variableName)`/`tags.standard(tags.name)`→`--tug-syntax-constant`, `tags.function(tags.variableName)` already mapped, etc.). Keep `tugHighlightStyle = syntaxHighlighting(tugHighlightStyleInner)`.
- [ ] Implement `tokenizeFragment(text, ext)` per Spec S01 (headless `EditorState` + `ensureSyntaxTree` + `highlightTree`, per-line slicing, plain-text fallback). Add `PARSE_TIMEOUT_MS`.
- [ ] Implement `tokenizeFragmentByLangId(text, langId)` — resolve a language id (e.g. `"typescript"`, `"bash"`) to a grammar via a `normalizeLanguage`-style alias map reusing `SELECTABLE_LANGUAGES`.
- [ ] Implement `highlightFragmentToHtml(text, langId)` — class-per-token `<span>` HTML (no inline styles), for the live transcript fences ([Q02]).
- [ ] Mount `tugHighlightStyleInner.module` once (idempotent) so fragment classes resolve.
- [ ] `bun add @codemirror/lang-go @codemirror/lang-java @codemirror/lang-sql` (confirmed NOT installed today; `@codemirror/legacy-modes` is already present and supplies `mode/dockerfile`). Wire them into `LOADERS`/`LANGUAGE_LABELS`/`SELECTABLE_LANGUAGES` (dockerfile via the existing `legacy()` helper); fall back to plain text for any that resolve unavailable. Without these, go/java/sql diffs regress from Shiki's coverage to plain ([R01]).

**Tests:**
- [ ] Unit: `tokenizeFragment("const x = 1\n// c", "ts")` yields a `keyword` class on `const` (line 0) and a `comment` class on line 1; a multi-line block-comment fragment carries the comment class across lines.
- [ ] Unit: unknown extension → per-line empty arrays.

**Checkpoint:**
- [ ] `cd tugdeck && bun run typecheck && bunx vite build`
- [ ] `bun test` (registry unit tests) green
- [ ] `bun run audit:theme-contrast` within budget

---

#### Step 3: Read/Write blocks highlighted via Lezer {#step-3}

**Depends on:** #step-2

**Commit:** `feat(tool-blocks): syntax-highlight Read/Write file snippets via Lezer`

**References:** [P01] (#p01-single-tokenizer), Spec S01 (#shared-tokenizer)

**Artifacts:**
- `tug-code-view.tsx` extension list gains language + `tugHighlightStyle`; `file-block.tsx` passes the resolved extension.

**Tasks:**
- [ ] In `tug-code-view.tsx`, add a language compartment that resolves `languageForExtension` from the file path/`language` prop and reconfigures with `[language, tugHighlightStyle]` (mirror `tug-file-editor.tsx`'s language effect and its stale-path guard). Read-only view keeps all other extensions.
- [ ] Ensure `file-block.tsx` (used by `read-tool-block.tsx` / `write-tool-block.tsx`) forwards the file path/extension so the view can resolve a grammar.

**Tests:**
- [ ] app-test: a Read tool call on a `.ts` file renders colored tokens (assert a highlighted token span class is present in the block DOM).

**Checkpoint:**
- [ ] `cd tugdeck && bun run typecheck && bunx vite build`
- [ ] `just app-test`

---

#### Step 4: Diff renderer re-targeted Shiki → Lezer {#step-4}

**Depends on:** #step-2

**Commit:** `refactor(diff): tokenize hunks via Lezer, keep word-overlay verbatim`

**References:** [P02] (#p02-static-tokenizer), [P04] (#p04-classes-and-overlay), (#grammar-seed-port), Risk R01 (#r01-language-coverage)

**Artifacts:**
- `lib/diff/syntax-tokens-from-lezer.ts` (new); `render-line.ts` merges `className`; `diff-block.tsx` effect uses `tokenizeFragment`; `grammar-seed.ts` keying mapped to registry vocabulary.

**Tasks:**
- [ ] Add `syntax-tokens-from-lezer.ts`: convert per-line `highlightTree` runs → `SyntaxToken[]` with `className` (drop the Shiki `ThemedTokenLike`/`style` shape).
- [ ] Change `SyntaxToken` to `{start,end,className}`; update `render-line.ts` `RenderedSegment` to carry `className` for syntax and union it with the word-overlay class on the same span (two-pointer merge otherwise unchanged).
- [ ] Update the `syntax-tokens-from-shiki` import in `lib/diff/__tests__/render-line.test.ts` (and any other importer) to the new `syntax-tokens-from-lezer` module + `className` shape.
- [ ] In `diff-block.tsx`, replace the `getHighlighter()`/`codeToTokens` effect with `tokenizeFragment(sideText, ext)` per reconstructed hunk side; keep the position-keyed `Map<"hunkIndex:lineIndex", SyntaxToken[]>`, the before/after two-pass, and the grammar-seed prepend/drop. Resolve `ext` from `data.filePath`.
- [ ] Update the span render in `diff-block.tsx` to apply `className` for syntax instead of parsing an inline `style` string; `tugx-diff-content` spans carry syntax + word classes.
- [ ] Port `grammar-seed.ts` language keying to the registry ext/id vocabulary; keep heuristics.

**Tests:**
- [ ] Unit: `renderLineSegments` with a syntax token + an overlapping word range yields a segment carrying both `className`s.
- [ ] Unit: a hunk opening inside a block comment (seeded) tokenizes its first line as comment.
- [ ] app-test: an Edit diff on a `.ts` file shows colored add/remove lines with word-level overlays intact.

**Checkpoint:**
- [ ] `cd tugdeck && bun run typecheck && bunx vite build`
- [ ] `bun test` diff libs green
- [ ] `just app-test`

---

#### Step 5: Color the live transcript code-fences via Lezer (net-new) {#step-5}

**Depends on:** #step-2

**Commit:** `feat(transcript): syntax-color code-fences via Lezer`

**References:** [P09] (#p09-fences), [Q02] (#q02-fence-output), Risk R05 (#r05-fence-async)

**Artifacts:**
- `lib/markdown/enhance-fenced-code.ts` `enhanceFencedCode` gains async Lezer coloring of the `<code>` body via `highlightFragmentToHtml`.

**Note:** This is **net-new** coloring — live fences are plain today (`enhanceFencedCode` only wraps `<pre>` in header/copy/fold chrome). It is NOT a Shiki migration and does NOT gate Shiki removal (the older `lib/markdown.ts` is dead code, deleted in Step 6). The live markdown surface is driven by pulldown-cmark, not `marked`.

**Tasks:**
- [ ] In `enhanceFencedCode`, after building the fence wrapper, resolve the fence language via the existing `readLanguage` (`<code class="language-X">`) and call `highlightFragmentToHtml(codeText, langId)`.
- [ ] Patch `codeEl.innerHTML` with the class-per-token spans **on async resolve**, guarded: skip unless `codeEl.isConnected` and `codeEl.textContent` still equals the source that was tokenized (the windowing engine may have pruned/re-rendered the block). Keep the enhancement idempotent (skip an already-colored `<pre>`).
- [ ] Confirm the `.tugx-md-fenced-code` chrome and `tug-markdown-block`/`tug-markdown-view` styling still apply; the `StyleModule` mount is global from Step 2.
- [ ] Leave `lib/markdown.ts` untouched here (dead; deleted in Step 6).

**Tests:**
- [ ] app-test / manual: an assistant message with a fenced ` ```ts ` block renders Lezer-colored tokens matching a Text card of the same code; a fence in an unknown language stays plain.
- [ ] Manual: scroll the transcript so a fenced block prunes and re-renders mid-highlight; confirm no stale paint and no console error (the guard holds).

**Checkpoint:**
- [ ] `cd tugdeck && bun run typecheck && bunx vite build`
- [ ] `just app-test`

---

#### Step 6: Delete Shiki + `--syntax-token-*` bridge + dead markdown.ts {#step-6}

**Depends on:** #step-4

**Commit:** `chore(highlight): remove Shiki, the --syntax-token-* bridge, and dead markdown.ts`

**References:** [P01] (#p01-single-tokenizer), (#files-to-delete), Risk R04 (#risks)

**Artifacts:**
- `code-block-utils.ts`, `syntax-tokens-from-shiki.ts`, and dead `lib/markdown.ts` deleted; `--syntax-token-*` block removed from `styles/tug.css`; `shiki` removed from `package.json`.

**Note:** The only live Shiki consumer is the diff renderer (migrated in #step-4), so this step's hard dependency is #step-4 alone. #step-5 (fence coloring) and #step-3 (Read/Write) do not touch Shiki.

**Tasks:**
- [ ] Delete `lib/code-block-utils.ts` and `lib/diff/syntax-tokens-from-shiki.ts`.
- [ ] Delete the dead `lib/markdown.ts` (`marked`+Shiki `enhanceCodeBlocks`/`renderMarkdown`; zero live importers — verify with grep first). If it has a live `bun:test`, delete that too.
- [ ] Remove the `--syntax-token-*` (and `--syntax-foreground`/`--syntax-background` if unused elsewhere) block from `styles/tug.css`.
- [ ] Remove `shiki` from `tugdeck/package.json`; `bun install`.
- [ ] `grep -rn "shiki\|code-block-utils\|codeToTokens\|codeToHtml\|syntax-token" tugdeck/src tugdeck/styles --exclude-dir=_archive` → zero hits (fix any straggler). Note: `src/_archive/cards/conversation/code-block.tsx` references a Shiki-era `code-block-utils` but is **dead code** — `src/_archive/**/*` is excluded from `tsconfig`, is not a Vite entry, and its import target does not exist; it neither builds nor typechecks and needs no change here (delete it opportunistically if desired).

**Tests:**
- [ ] Contract: the (archive-excluded) grep returns nothing.

**Checkpoint:**
- [ ] `cd tugdeck && bun run typecheck && bunx vite build`
- [ ] `bun run audit:theme-contrast` within budget

---

#### Step 7: Rendering-unification integration checkpoint {#step-7}

**Depends on:** #step-3, #step-4, #step-5, #step-6

**Commit:** `N/A (verification only)`

**References:** [P01] (#p01-single-tokenizer), (#success-criteria)

**Tasks:**
- [ ] Open the same `.ts` file as a Text card, a Read block, and an Edit diff; confirm identical colors, all from `--tug-syntax-*`.

**Tests:**
- [ ] app-test covering Read-block coloring + Edit-diff coloring in one run.

**Checkpoint:**
- [ ] `cd tugdeck && bunx vite build && just app-test`

---

#### Step 8: Full-selection persistence + measure-gated scroll {#step-8}

**Depends on:** #step-1

**Commit:** `fix(text-card): retain scroll, caret, and selection across reload/HMR (L23)`

**References:** [P05] (#p05-selection-persist), [P06] (#p06-measure-gate), (#persistence-flow), Risk R03 (#r03-scroll-jump)

**Artifacts:**
- Widened `FilePositions`; corrected `getPositions`/`applyPositions`; widened bag payload in `text-card.tsx`.

**Tasks:**
- [ ] Extend `FilePositions` (`lib/text-card-store.ts`) with an optional selection `head: {line,ch}` alongside `anchor`; document that a bag without `head` restores a collapsed caret (back-compat).
- [ ] `getPositions` (`tug-file-editor.tsx`): capture `anchor` from `selection.main.anchor` and `head` from `.head` (plus `scrollTop`).
- [ ] `applyPositions`: restore a real selection range (`selection: { anchor, head }`); replace the synchronous `scrollDOM.scrollTop = …` with a one-shot measure-gated restore applied after the selection (via `requestMeasure` or a one-shot `updateListener`), mirroring `card-host.tsx`'s scroll-last ordering; drop the gate if the card re-anchors first.
- [ ] Widen the persisted bag in `text-card.tsx` (`useCardStatePreservation` capture + `onRestore` coercion) to carry the selection `head`.

**Tests:**
- [ ] Unit: `getPositions` → `applyPositions` round-trips a multi-line selection.
- [ ] app-test: scroll a Text card mid-file, place a caret, make a multi-line selection, Maker ▸ Reload; assert `scrollDOM.scrollTop`, caret line, and selection range all return (no jump).
- [ ] Manual HMR: edit `tug-text-editor.tsx`; confirm the same three survive.

**Checkpoint:**
- [ ] `cd tugdeck && bun run typecheck && bunx vite build`
- [ ] `just app-test`

---

#### Step 9: Click-to-passage: range open + select + zoom flash {#step-9}

**Depends on:** #step-8

**Commit:** `feat(tool-blocks): jump to and zoom the touched passage on file-ref click`

**References:** [P07] (#p07-range-open), [P08] (#p08-flash)

**Artifacts:**
- `ToolFileRef.range` prop + populated call sites; widened `open-file` payload → `openFileInCard` seed → `reveal`; flash decoration in the file editor.

**Tasks:**
- [ ] Add `range?: {startLine,endLine}` to `ToolFileRefProps`; carry it on the `open-file` dispatch.
- [ ] Populate `range` from the first hunk in `edit-tool-block.tsx` (`diffData.hunks[0].after_start` + line count) and `write-tool-block.tsx`; leave Read passing its window start (single line).
- [ ] Widen `TUG_ACTIONS.OPEN_FILE` payload (`action-vocabulary.ts`) and the handler (`action-dispatch.ts`) to accept the range; pass it into `openFileInCard`.
- [ ] `openFileInCard` (`lib/open-file-in-card.ts`): seed grows an optional `selection` range; the reuse path calls `reveal(range)` instead of `revealLine(line)`.
- [ ] Rename/extend `revealLineFn` → `revealFn(target)` in `tug-file-editor.tsx` (line or range): dispatch `selection: {anchor,head}` for a range, `scrollIntoView(range,{y:"center"})`, `focus()`; update the reuse-registry entry (`text-card-open-registry.ts` / `text-card.tsx`) and the mount-time `applyPositions` seed path.
- [ ] Add a one-shot CM6 flash decoration over the revealed range reusing the `@keyframes tugx-codeview-find-flash` pattern (share or copy the keyframe/class into the file-editor CSS); clear after one cycle.

**Tests:**
- [ ] app-test: click an Edit tool-call file header; assert the Text card opens with the first hunk's range selected (`selection.main` spans it) and the flash class appears then clears.
- [ ] Manual: Read header still lands at the window start; Write header lands at the first changed line.

**Checkpoint:**
- [ ] `cd tugdeck && bun run typecheck && bunx vite build`
- [ ] `just app-test`

---

#### Step 10: End-to-end integration checkpoint {#step-10}

**Depends on:** #step-7, #step-8, #step-9

**Commit:** `N/A (verification only)`

**References:** (#success-criteria, #exit-criteria)

**Tasks:**
- [ ] Verify all success criteria together: sizing parity, one namespace (grep clean), reload retains scroll/caret/selection, click-to-passage selects + zooms.

**Tests:**
- [ ] Full `just app-test` sweep covering coloring, reload persistence, and click-to-passage.

**Checkpoint:**
- [ ] `cd tugdeck && bun run typecheck && bunx vite build && bun run audit:theme-contrast && just app-test`

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** Text cards open and size like Dev cards; every file-display surface highlights through one Lezer tokenizer on one `--tug-syntax-*` namespace with Shiki removed; Text card scroll/caret/selection survive HMR/reload/relaunch; and tool-call file-refs jump to and zoom the touched passage.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] Text card `sizePolicy` = `min {800,400}`, `preferred {850,1200}`, no `max`. ([P03])
- [ ] `grep -rn "shiki\|syntax-token\|code-block-utils" tugdeck/src tugdeck/styles --exclude-dir=_archive` → zero hits; `shiki` absent from `package.json`. (The sole live Shiki consumer is `diff-block.tsx` via `code-block-utils.ts`; `lib/markdown.ts` was dead code, deleted in Step 6; `src/_archive` is dead, unbuilt.) ([P01])
- [ ] Same file colors identically in Text card / Read block / Edit diff. ([P01])
- [ ] Reload/HMR retains scroll offset, caret, and multi-line selection. ([P05], [P06])
- [ ] Edit-header click opens at the first hunk, selects its range, plays the zoom flash. ([P07], [P08])
- [ ] `bun run typecheck && bunx vite build && bun run audit:theme-contrast && just app-test` all pass.

**Acceptance tests:**
- [ ] app-test: Read-block + Edit-diff coloring.
- [ ] app-test: reload persistence (scroll/caret/selection).
- [ ] app-test: click-to-passage select + flash.

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] Per-hunk click targeting (jump to the specific hunk row clicked, not just the first). ([non-goals](#non-goals))
- [ ] A real Find/replace UI on the latent CM6 search panel.
- [ ] Multi-range selection persistence (beyond the primary range).

| Checkpoint | Verification |
|------------|--------------|
| Sizing parity | Read both registrations; open both cards in-app |
| One tokenizer / one namespace | grep clean + visual compare |
| L23 persistence | app-test reads `scrollDOM.scrollTop` + selection post-reload |
| Click-to-passage + zoom | app-test asserts selection span + flash class |
