<!-- devised against tuglaws/devise-skeleton.md v4 -->

## Improve the `markdownTextStyle` scheme — fill the gaps, fix the divergences {#improve-markdown-text-style}

**Purpose:** Bring Tug's markdown text styling into full agreement with the constructs documented at <https://daringfireball.net/projects/markdown/syntax> — blockquotes, horizontal rules, strikethrough, hard line breaks, inline/fenced code face, fenced-code sub-language highlighting, inline HTML — while preserving the scheme's defining rule: **the markdown stays a text document, with every syntax character left in place**. Along the way, make the read-only filter and the live editor parse and paint the same dialect, and rename `styleMarkdownText` to `applyMarkdownTextStyle`.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | implemented on `tugdash/markdown-text-style`, awaiting join |
| Target branch | main |
| Last updated | 2026-07-25 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

`markdownTextStyle` is Tug's "markdown that is still text" scheme. It styles markdown *visually* — heading, emphasis, strong, inline code, links take tone and weight; markup characters take a muted marker tone; wrapped list items hang-indent under their content — and it **never removes, hides, folds, or substitutes a character**. It exists in two forms that must agree:

- **The one-shot filter** — `styleMarkdownText(text)` in `tugdeck/src/lib/markdown-text-styling.ts`, a pure synchronous function returning per-line `{text, indent, spans}`. It backs `TugMarkdownText` (`tugdeck/src/components/tugways/tug-markdown-text.tsx`), which is what renders a commit message body through `CommitMessage` in `tugdeck/src/components/tugways/commit-presentation.tsx`.
- **The editor bundle** — `loadMarkdownTextStyling()` in `tugdeck/src/components/tugways/tug-text-editor/markdown-text-styling.ts`, a lazily-loaded CM6 extension set behind the reactive `markdownTextStyling?: boolean` prop on `TugTextEditor` (`tugdeck/src/components/tugways/tug-text-editor.tsx`). Consumers today: `TugPromptEntry`, `TugMessageEditor`, `TugCodeView` (used by the Lens snippets section), and the gallery text-editor harness.

Both draw their colors from one tag map, `tugHighlightSpecsBase` in `tugdeck/src/lib/language-registry.ts`, wrapped two ways: `tugHighlightStyleInner` / `tugHighlightStyle` (read-only surfaces; links underlined) and `tugEditingHighlightStyleInner` / `tugEditingHighlightStyle` (write surfaces; links not underlined, so the Text card's ⌘-hover linkify affordance keeps its signal).

A construct-by-construct audit against the Daring Fireball page — run by parsing a document containing every documented construct through the real grammar and the real highlight style — found **seven gaps** and **two divergences between the two forms**. The gaps are constructs the documentation treats as first-class that today carry no visual signal at all (blockquote bodies, horizontal rules, strikethrough bodies, inline HTML), carry a signal that cannot be seen (hard line breaks — tagged, but the tag paints color onto whitespace), or carry a weaker signal than the construct means (code that isn't in a code face, fenced blocks that don't highlight the language they declare). The divergences are that the filter parses GFM while the editor parses strict CommonMark, and that the hanging-indent math has a fallback in one path and not the other. See [#audit-findings](#audit-findings) for the observed evidence.

#### Strategy {#strategy}

- **Unify before extending.** Give both forms one shared, configured markdown parser (`lib/markdown-text-style-grammar.ts`), so every subsequent improvement lands in both places by construction rather than by discipline. This alone closes the GFM/CommonMark divergence and — for free, via the parser's built-in HTML sub-parsing — the inline-HTML gap.
- **Prefer the existing tag map over new machinery.** Five of the seven gaps are one line each in `tugHighlightSpecsBase`. Reach for parser configuration, decorations, or new theme tokens only where a tag alone cannot express the result.
- **One new theme token, and only where whitespace has to be made visible.** Blockquotes reuse the muted text-derived pattern; horizontal rules reuse the existing marker tone; hard line breaks get the one genuinely new token, because they are the one construct with no glyphs to color.
- **Never change text size, and never remove text.** Every step is checked against the same two invariants: `spans` rejoin to the source verbatim, and no rule anywhere sets `font-size`.
- **Sequence so the tree is green at every commit.** Rename first (mechanical), unify second (behavior-preserving except for the intended dialect change), then one gap per step, then tests.

#### Success Criteria (Measurable) {#success-criteria}

- A document containing every construct on the Daring Fireball page round-trips through `applyMarkdownTextStyle` with **byte-identical** output: for every line, `spans.map(s => s.text).join("") === line.text`, and the lines rejoined with `\n` equal the input exactly (bun unit test over the corpus in [Spec S05](#s05-corpus)).
- Blockquote body text (`> quoted`) carries a highlight class distinct from surrounding prose (unit test asserts a non-empty class on the quoted run, and a different class from the plain-paragraph run).
- A horizontal rule line (`---`, `***`, `___`) carries the marker-tone class over its full length (unit test).
- `~~struck~~` body text carries a class whose generated CSS includes `line-through` (unit test asserts the class differs from the surrounding prose class; app-test asserts `text-decoration-line: line-through` computed in the live app).
- The two trailing spaces of a hard line break carry a class whose computed `background-color` is non-transparent in the live app (app-test), and the same two spaces are still present in `view.state.doc.toString()` (app-test).
- Inline code (`` `x` ``) computes a `font-family` containing the theme's mono stack in the live app, on a prompt entry whose editor font is set to a proportional face (app-test).
- A ` ```ts ` fence body is tokenized by the TypeScript grammar — `const` carries the keyword class, not the flat monospace class — in both forms: unit test for `applyMarkdownTextStyle` (after awaiting the grammar load), app-test for the editor.
- Inline HTML (`text <b>bold</b> text`) carries tag-name and bracket classes in both forms (unit test + app-test).
- `- [ ] task`, `~~strike~~`, and a GFM table are tagged **identically** by the filter and by the editor bundle (unit test parses the same source through both entry points and compares run arrays).
- A list item nested in a blockquote (`> - item`) receives a non-zero hanging indent from `applyMarkdownTextStyle` (unit test), matching the editor's existing fallback behavior.
- Typing `<div>` in a markdown-styled prompt entry does **not** auto-insert `</div>` (app-test; see [P03](#p03-no-auto-close)).
- `bun test`, `bunx tsc --noEmit`, `bunx vite build`, `bun run audit:tokens`, `bun run audit:theme-contrast`, `bun run audit:gamut`, and `just app-test-changed` all pass.
- No rule introduced by this plan sets `font-size` (grep check in [#step-9](#step-9)).

#### Scope {#scope}

1. Rename `styleMarkdownText` → `applyMarkdownTextStyle` and update its consumers and docstrings.
2. New shared module `tugdeck/src/lib/markdown-text-style-grammar.ts`: one configured markdown `LanguageSupport` (GFM base, styling-only options), the shared hanging-indent helper, and the fenced-code language resolver + grammar-revision store.
3. Both forms adopt the shared grammar — closes the dialect divergence and the inline-HTML gap.
4. Tag-map additions in `tugHighlightSpecsBase`: `quote`, `contentSeparator`, `strikethrough`.
5. New theme token `--tugx-syntax-quote` (+ pairing-map entry).
6. Hard-line-break affordance: a `HardBreak` tag override in the shared grammar, a new `--tug-syntax-hard-break-bg` token (dark + light), and a background-tint spec.
7. Mono face for code: `fontFamily` on the `monospace` tag spec (inline code, plain fence bodies, indented code blocks) plus a line-level mono mechanism for fences whose bodies are inner-highlighted.
8. Fenced-code sub-language highlighting via `codeLanguages`, backed by the existing `language-registry` loaders, plus a revision store so the synchronous filter repaints when a grammar chunk lands.
9. Shared hanging-indent math with the editor's fallback, so `> - item` and tab-separated markers indent in both forms.
10. Unit-test expansion (`tugdeck/src/lib/__tests__/markdown-text-styling.test.ts`) and one new app-test (`tests/app-test/at0269-markdown-text-style-constructs.test.ts`).

#### Non-goals (Explicitly out of scope) {#non-goals}

- **Any change to text size.** No heading size ramp, no smaller code, no larger anything. The user's direction is explicit: sizes do not change in this scheme.
- **Heading level differentiation of any kind** — h1–h6 continue to share one treatment. (A tone ramp across `heading1`…`heading6` is technically available and deliberately not taken here; recorded as a follow-on in [#roadmap](#roadmap).)
- **Structural or geometric decoration**: no blockquote left rule or gutter, no horizontal-rule line stroke, no table column alignment, no list bullet substitution. Tone, weight, decoration, and font family only — plus the one background tint for hard breaks ([P07](#p07-hard-break-tint)).
- **Markdown editing behaviors** — list continuation on Enter (`markdownKeymap`), `deleteMarkupBackward`, paste-URL-as-link stay excluded, as decided when the capability shipped.
- **Renaming the `markdownTextStyling` prop, the compartment, or the module filenames.** Only the function is renamed ([P10](#p10-rename)).
- **`tugdeck/src/lib/markdown/`** — the transcript's HTML-rendering pipeline (`parse-markdown-to-sanitized-blocks.ts`, DOMPurify, mermaid, KaTeX). That is a *different* subsystem that turns markdown into styled HTML; this plan never touches it. See [#naming-hazard](#naming-hazard).
- Syntax *folding*, concealment, or WYSIWYG rendering of any construct. The scheme's whole premise forbids it.

#### Dependencies / Prerequisites {#dependencies}

- `@codemirror/lang-markdown` ^6.5.0 (already a dependency; statically imported by `lib/markdown-text-styling.ts` today).
- `@lezer/markdown`, `@lezer/highlight`, `@codemirror/language`, `@codemirror/lang-html` (the last arrives transitively — `@codemirror/lang-markdown`'s dist imports it at module top level; see [#lang-markdown-facts](#lang-markdown-facts)).
- The existing `language-registry.ts` loader table (`LOADERS`), alias table (`LANG_ID_ALIASES`), and `extForLangId`/`languageForExtension` resolvers.
- The app-test harness (`tests/app-test/_harness`) and the `just app-test*` recipes; the `gallery-prompt-entry` card as a session-free surface.
- The theme pipeline: `tugdeck/src/components/tugways/tug-code.css` (syntax token declarations), `tugdeck/src/components/tugways/theme-pairings.ts` (`ELEMENT_SURFACE_PAIRING_MAP`), and the `audit:tokens` / `audit:theme-contrast` / `audit:gamut` scripts.

#### Constraints {#constraints}

- **Tuglaws.** [L06] appearance through CSS/DOM (CM6 decorations, highlight classes) — never React state. [L02] external state enters React only through `useSyncExternalStore` (the grammar-revision store). [L17] `--tugx-*` alias tokens resolve to `--tug7-*` in one hop.
- **Theme palette hard constraint** (stated in `tug-code.css`): **no red and no green** in syntax tokens — those hues are reserved for diff add/remove semantics. The new hard-break tint must come from another hue family.
- **Accent-derived tokens need a light variant.** `--tug-color(...)` recipes declared in `body` are tuned for dark surfaces and are overridden in the `[data-theme-mode="light"] body` block of `tug-code.css`. Text-derived `--tugx-*` tokens that reference `--tug7-*` need no override.
- `bunx vite build` (production rollup) must pass — the debug app loads the rollup bundle, and an import that works under dev esbuild can still fail the build.
- Warnings-are-errors discipline applies to the TypeScript check (`bunx tsc --noEmit`).
- App-tests run selectively (`just app-test-changed`), never as a sweep, and every new test declares `@covers`.
- No `localStorage`; no jsdom/mock render tests; no plan-step numbers or bug history in code comments.

#### Assumptions {#assumptions}

- The prompt editor font is user-selectable and may be proportional (IBM Plex Sans is offered), so the `ch`-based hanging indent already approximates rather than matches there — an accepted trade recorded when the capability shipped. Adding a mono face to inline code perturbs that approximation slightly and is accepted on the same grounds ([P08](#p08-mono-face)).
- `@codemirror/lang-markdown` is already in the base bundle (the filter imports it statically and `TugMarkdownText` is reachable from the Session card), so moving the editor bundle onto a statically-imported shared module does not add a new base-bundle dependency. This is stated as an assumption and **verified by build measurement** in [#step-2](#step-2).
- Theme authors will accept one additional syntax token; the tint is decorative (painted under whitespace) and therefore carries no contrast-role obligation.

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

This plan uses explicit `{#anchor}` headings, stable labels (`[P01]`, `[Q01]`, `S01`, `T01`, `R01`), `**Depends on:**` lines citing `#step-N` anchors, and rich `**References:**` lines on every execution step. Never cite line numbers — cite anchors and symbols.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Hard-break affordance: which visual form? (DECIDED) {#q01-hard-break-form}

**Question:** Two trailing spaces are a documented, meaningful construct with no glyphs. Color cannot express it. Underline (marker tone), dotted underline, or a faint background tint?

**Resolution:** DECIDED — faint background tint (see [P07](#p07-hard-break-tint)). Chosen by the user for legibility: an underline under two spaces at end-of-line is too quiet to notice, and would also collide visually with the read-only variant's underlined links. Cost accepted: one new theme token with a dark and a light variant.

#### [Q02] Where does inline code take the mono face? (DECIDED) {#q02-mono-scope}

**Question:** Read-only receipts only, everywhere markdown styling is on, or only when the host face is proportional?

**Resolution:** DECIDED — **everywhere markdown styling is on** (see [P08](#p08-mono-face)). Parity between composer and receipt is the scheme's governing property, and the `ch`-indent drift this introduces on a proportional composer is sub-character and already an accepted approximation there.

#### [Q03] Should the grammar-revision restyle be global or per-component? (DECIDED) {#q03-revision-grain}

**Question:** When a fenced-code grammar chunk finishes loading, the already-painted synchronous output of `applyMarkdownTextStyle` is stale. Should the repaint signal be a global revision counter (every mounted `TugMarkdownText` restyles) or scoped per language / per component?

**Resolution:** DECIDED — one global monotonic counter ([P09](#p09-fenced-code)). The bump count is bounded by the number of distinct grammars in the registry (~25 per session, in practice one or two), each bump costs one `applyMarkdownTextStyle` pass per mounted `TugMarkdownText`, and the passes are pure string work over already-short commit bodies. Per-language scoping would need a dependency map from every mounted component to the fences it contains — real complexity for no measurable gain.

#### [Q04] Should the `markdownTextStyling` prop be renamed to match `applyMarkdownTextStyle`? (DEFERRED) {#q04-prop-rename}

**Question:** The scheme is spoken of as `markdownTextStyle`; the substrate prop is `markdownTextStyling`, the modules are `markdown-text-styling.ts`, and the app-test is `at0229-prompt-markdown-styling`.

**Resolution:** DEFERRED. The user asked for exactly one rename — the function. A prop/module/test rename is a wide mechanical diff across the substrate, `TugCodeView`, `TugMessageEditor`, `TugPromptEntry`, the gallery harness, and an app-test filename, with no behavior change. Recorded in [#roadmap](#roadmap); do it as its own commit if wanted.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| `styleTags` override for `HardBreak` stops working on a `@codemirror/lang-markdown` upgrade | med | low | Verified against the installed ^6.5.0 ([#lang-markdown-facts](#lang-markdown-facts)); a unit test asserts the hard-break run carries the tint class, so an upgrade that breaks it fails CI | Any lang-markdown major/minor bump |
| New `--tug-syntax-hard-break-bg` fails gamut or theme-contrast audits | med | low | Reuse the purple/violet marker hue family (never red/green per the `tug-code.css` constraint); run all three audits in the step checkpoint; the token is decorative and takes no pairing-map contrast role | Audit failure on any of the six themes |
| Static import of the configured markdown support grows the base bundle | med | low | lang-markdown (and transitively lang-html, lang-javascript, lang-css) is already statically imported by `lib/markdown-text-styling.ts`; [#step-2](#step-2) measures `dist/assets/*.js` before and after and records the delta | A measured increase beyond noise |
| Mono face on inline code shifts the `ch`-based hanging indent on a proportional composer | low | med | Accepted ([P08](#p08-mono-face)); the indent was already an approximation there. Drift is sub-character and the continuation still lands under the content | A visual report from a Plex Sans user |
| Switching the editor to a GFM base changes composer behavior | low | high (intended) | Intended ([P02](#p02-gfm-dialect)): task markers, strikethrough, and tables begin to style in composers. No keymap or input handling changes — `addKeymap` stays false | — |
| Global revision bump causes visible reflow in a long Changeset list | low | low | Bump count is bounded and the work is pure; measure in [#step-7](#step-7) with a real commit body containing a fence | Perceptible jank in the Changeset card |

**Risk R01: The `HardBreak` tag override replaces rather than adds** {#r01-hardbreak-override}

- **Risk:** Configuring `styleTags({ HardBreak: tugHardBreakTag })` through `markdown({ extensions: [{ props: [...] }] })` **replaces** the node's original `processingInstruction` tag rather than adding to it. Verified by probe: before the override the two trailing spaces emit the marker class; after it, they emit only the hard-break class.
- **Mitigation:** The hard-break spec must fully describe the appearance on its own — the tint is the entire treatment, and no marker color is inherited. The spec sets `backgroundColor` only; the run has no glyphs, so no foreground color is needed.
- **Residual risk:** None functionally. Worth remembering if a future change wants markers and hard breaks to share a treatment.

**Risk R02: Fenced-code inner tokens drop the `monospace` tag** {#r02-fence-inner-tokens}

- **Risk:** Once `codeLanguages` is wired, a ` ```ts ` body is tokenized by the TypeScript grammar, so its runs carry `keyword`/`string`/`number` tags and **no longer carry `tags.monospace`**. A `fontFamily` attached only to the `monospace` spec would therefore make an *unhighlighted* fence mono and a *highlighted* fence not — the opposite of the intent.
- **Mitigation:** [P08](#p08-mono-face) pairs the tag-level `fontFamily` with a **line-level** mono mechanism for code-block lines (a `code` flag on `MarkdownStyledLine` in the filter, a `Decoration.line` class in the editor), which is independent of inner tokenization.
- **Residual risk:** A code line's box may measure a different height than a prose line when the mono and sans faces differ in metrics. Accepted: `font-size` is never changed, and a code block reading in a code face is the documented intent.

---

### Design Decisions {#design-decisions}

#### [P01] One shared markdown grammar module, consumed by both forms (DECIDED) {#p01-shared-grammar}

**Decision:** Add `tugdeck/src/lib/markdown-text-style-grammar.ts` as the single home for the scheme's parser configuration. It exports the configured `LanguageSupport`, its parser, the shared hanging-indent helper, and the fenced-code resolver + revision store. `lib/markdown-text-styling.ts` parses with `markdownTextStyleSupport.language.parser`; `tug-text-editor/markdown-text-styling.ts` bundles `markdownTextStyleSupport` itself.

**Rationale:**
- The two forms have already drifted twice (dialect, indent fallback) precisely because each configured its own parser. A shared module makes agreement structural rather than a matter of remembering.
- Every improvement in this plan that touches parsing (GFM, hard-break tag, fenced-code languages, HTML sub-parsing) then lands in both forms from one edit.
- `lib/` is the right home: no React, no `EditorView`, no DOM. Components already import from `lib/` (`tug-markdown-text.tsx` → `lib/markdown-text-styling.ts`); the reverse direction is not allowed and is not needed.

**Implications:**
- `loadMarkdownTextStyling()` keeps its `Promise<Extension>` signature so the substrate's async effect contract in `tug-text-editor.tsx` (the `alive` + `viewRef` + `markdownTextStylingRef` guard trio) is untouched — it simply resolves an already-built value.
- The module statically imports `@codemirror/lang-markdown`. See [#step-2](#step-2) for the bundle measurement that confirms this costs nothing new.
- `tugHardBreakTag` is declared in `language-registry.ts` (beside the tag map that styles it), not in the grammar module, so the import direction stays grammar → registry with no cycle.

#### [P02] GFM is the scheme's dialect (DECIDED) {#p02-gfm-dialect}

**Decision:** Both forms parse with `markdownLanguage` from `@codemirror/lang-markdown` as the base — CommonMark **plus** GFM (tables, task lists, strikethrough, bare autolinks) plus subscript, superscript, and emoji.

**Rationale:**
- The divergence today is silent and backwards: `styleMarkdownText` uses `markdownLanguage` (GFM), while `markdown()` defaults its `base` to `commonmarkLanguage`. So `- [ ] task`, `~~strike~~`, and tables style in a receipt and not in the composer that authored them — while the filter's own docstring promises a commit message "reads identically in a composer and in a receipt."
- GFM is the dialect people actually write in commit messages and prompts; task lists and tables are the two constructs most likely to appear.
- Adopting the filter's existing dialect for both means receipts do not regress.

**Implications:**
- Composers gain styling for task markers, strikethrough, and tables. Intended and covered by the success criteria.
- The base is `markdownLanguage`, not `commonmarkLanguage`; `markdown()` throws `RangeError` if the base's parser is not a `MarkdownParser`, so the configured value must come from lang-markdown's own exports.

#### [P03] Styling-only extends to HTML auto-close (DECIDED) {#p03-no-auto-close}

**Decision:** The shared configuration passes `htmlTagLanguage: html({ matchClosingTags: false, autoCloseTags: false })` alongside the existing `addKeymap: false`, `pasteURLAsLink: false`, `completeHTMLTags: false`.

**Rationale:**
- Verified in the installed package: `markdown()` defaults `htmlTagLanguage` to `htmlNoMatch = html({ matchClosingTags: false })`, and pushes `htmlTagLanguage.support` into the returned `LanguageSupport`'s support array. `html()`'s support array includes **`autoCloseTags`** — an `EditorView.inputHandler` that inserts a closing tag when you type `>` or `</`.
- That means every markdown-styled composer in Tug **already** auto-closes HTML tags today — an editing behavior that the capability's charter ("styling only — deliberately NOT markdown editing behavior") excludes on exactly the same grounds as `markdownKeymap` and `pasteURLAsLink`. It was never a decision; it arrived as a default.
- `autoCloseTags: false` removes the input handler while keeping the HTML *language*, which is what sub-parses HTML blocks and inline tags — so the inline-HTML gap still closes.

**Implications:**
- A behavior change in composers: typing `<div>` no longer inserts `</div>`. Asserted by app-test.
- `html()`'s support array also carries `javascript().support` and `css().support` (language data only, no keymaps) — harmless and unavoidable without hand-building the language.

#### [P04] Blockquotes take a muted text tone; no rule, no gutter (DECIDED) {#p04-blockquote-tone}

**Decision:** Map `tags.quote` to a new text-derived token `--tugx-syntax-quote`, defined as `var(--tug7-element-global-text-normal-muted-rest)` — the same muted rung `--tugx-syntax-comment` uses. No left rule, no indent, no background.

**Rationale:**
- Blockquote bodies are the largest signal gap on the audit: the `>` marker is toned but the quoted prose is byte-identical to ordinary prose, so the one block element whose entire purpose is "this is set apart" reads as not set apart.
- A muted tone is the minimum that expresses "set apart" without geometry. A left rule would be a *structural* decoration — the styled-document move this scheme exists to avoid — and would also have to be invented twice (a CSS pseudo-element in `TugMarkdownText`, a line decoration in CM6).
- A distinct token rather than reusing `--tugx-syntax-comment` keeps the pairing map honest about what is being checked and lets a theme author retune quotes without touching code comments. [L17] holds: one hop to a `--tug7-*` token.

**Implications:**
- One new entry in `ELEMENT_SURFACE_PAIRING_MAP` (`tugdeck/src/components/tugways/theme-pairings.ts`), mirroring the `--tugx-syntax-comment` entry: surface `--tugx-codeBlock-bg`, role `informational`.
- One new row in the `@tug-pairings` docblock at the top of `tug-code.css`.
- Text-derived, so no `[data-theme-mode="light"]` override is needed.

#### [P05] Horizontal rules take the existing marker tone (DECIDED) {#p05-hr-marker-tone}

**Decision:** Map `tags.contentSeparator` to `var(--tug-syntax-decorator)` — the same token every other markup character already uses. No new token, no line stroke.

**Rationale:**
- `---` / `***` / `___` are markup characters that happen to occupy a whole line. Treating them as markup is both the simplest and the most consistent reading: the eye already learns that tone means "this is syntax."
- Drawing an actual rule would be a geometric decoration and would raise the question of what happens to the characters — which the scheme answers by never removing them.

**Implications:** One line in `tugHighlightSpecsBase`. No theme work.

#### [P06] Strikethrough is decoration only (DECIDED) {#p06-strikethrough}

**Decision:** Map `tags.strikethrough` to `{ textDecoration: "line-through" }` with no color change.

**Rationale:**
- This is the rare construct where the styling *is* the meaning, and it still removes nothing — the `~~` delimiters stay, toned as markers.
- No color change keeps struck text legible as prose and avoids implying a second semantic.

**Implications:** One line in `tugHighlightSpecsBase`. The tag arrives only under a GFM base, so this depends on [P02](#p02-gfm-dialect).

#### [P07] Hard line breaks get a faint background tint — the scheme's one non-textual affordance (DECIDED) {#p07-hard-break-tint}

**Decision:** Override the `HardBreak` node's tag to a Tug-owned `tugHardBreakTag` (declared in `language-registry.ts`) and style it with `backgroundColor: var(--tug-syntax-hard-break-bg)` and nothing else. Add `--tug-syntax-hard-break-bg` to `tug-code.css` as a low-alpha accent recipe with dark and light variants, in the purple/violet family the marker tone already occupies.

**Rationale:**
- Two trailing spaces are documented, meaningful, and *invisible*. The grammar does tag them (`HardBreak` → `processingInstruction`), but a foreground color on whitespace paints nothing — so the construct is the one place where "leave the text alone" and "show the author what they wrote" genuinely conflict, and it resolves in favor of showing.
- A background tint adds no character and hides none: it makes visible something already present in the buffer. That keeps the scheme's rule intact in letter and spirit.
- Resolved by the user in [Q01](#q01-hard-break-form) over an underline, on legibility grounds.
- Purple/violet keeps it inside the marker vocabulary and satisfies the palette's no-red/no-green constraint.

**Implications:**
- The override **replaces** the node's marker tag (Risk [R01](#r01-hardbreak-override)), so the tint is the whole treatment.
- Two token declarations (dark in `body`, light in `[data-theme-mode="light"] body`), following the `--tug-terminal-selection-bg` precedent for an alpha-bearing accent recipe.
- Decorative: no `ELEMENT_SURFACE_PAIRING_MAP` entry and no contrast role (there is no foreground on it).
- Applies to both highlight-style variants, since the spec lives in the shared `tugHighlightSpecsBase`.

#### [P08] Code takes the mono face everywhere, by two mechanisms, and never a size change (DECIDED) {#p08-mono-face}

**Decision:** (a) Add `fontFamily: "var(--tug-font-family-mono)"` to the `tags.monospace` spec in `tugHighlightSpecsBase` — covering inline code, indented code blocks, and fence bodies with no inner grammar. (b) Add a **line-level** mono class for code-block lines, so fences whose bodies are inner-highlighted by [P09](#p09-fenced-code) keep the face: a `code: boolean` field on `MarkdownStyledLine` that `TugMarkdownText` turns into a class, and a `Decoration.line` in a new CM6 extension for the editor. Neither mechanism sets `font-size`.

**Rationale:**
- `tags.monospace` currently sets color only, so on a proportional host — a Plex Sans prompt entry, a commit body rendered at the host's prose face — `` `foo` `` reads as prose in a different color. The tag's own name says what it means.
- Resolved by the user in [Q02](#q02-mono-scope) as "everywhere markdown styling is on," for composer/receipt parity.
- The two mechanisms are not redundant: inner-highlighted fence tokens carry language tags, not `monospace` (Risk [R02](#r02-fence-inner-tokens)), so a tag-only approach would make highlighted fences *lose* the face.
- Size is untouched by explicit rule — the user's direction — so a code run differs from prose in face and tone only.

**Implications:**
- `MarkdownStyledLine` gains a field; `applyMarkdownTextStyle`'s output contract changes ([Spec S01](#s01-filter-contract)). The existing unit test's `toEqual({text, indent, spans})` assertion for empty input must be updated.
- One new CM6 extension module beside `list-hanging-indent.ts`, carrying its own `EditorView.baseTheme` so no CSS file needs to learn about it.
- On a monospace host both mechanisms are visual no-ops, which is the correct behavior.

#### [P09] Fenced code highlights its declared language, via the existing registry (DECIDED) {#p09-fenced-code}

**Decision:** Configure `codeLanguages` as a **function** `(info: string) => LanguageDescription | null` that resolves the fence info string through the existing `language-registry` alias/loader tables and returns a memoized `LanguageDescription` whose `load()` calls `languageForExtension(ext)`. For the synchronous filter, add a module-scope monotonic **grammar-revision store** to the same module; the resolver kicks `desc.load()` when `desc.support` is undefined and bumps the revision when it resolves. `TugMarkdownText` subscribes with `useSyncExternalStore` and re-runs `applyMarkdownTextStyle` on bump.

**Rationale:**
- The app already owns a full lazy language registry (`LOADERS`, `LANG_ID_ALIASES`, `extForLangId`, `languageForExtension`). A fence that declares ` ```ts ` and then renders flat is the app failing to use what it has.
- The function form is required, not merely convenient: the registry's key space is extensions plus aliases, which `LanguageDescription.matchLanguageName` over a static array would not reproduce without duplicating the alias table.
- Verified behavior (probe, [#lang-markdown-facts](#lang-markdown-facts)): in an editor, an unloaded `LanguageDescription` yields `ParseContext.getSkippingParser(found.load())` and CM6 re-parses natively when the chunk lands — no extra work. In a one-shot headless parse there is no re-parse, so the fence body stays unhighlighted until a *later* call; `LanguageDescription` caches `.support` on resolve, and a second `applyMarkdownTextStyle` call then highlights it. The revision store is exactly the nudge that turns "a later call" into "the next frame."
- Bump ordering is load-bearing: `LanguageDescription.load()` memoizes `this.loading = loadFunc().then(support => this.support = support)`. Calling `desc.load().then(bump)` from the resolver attaches **after** the internal assignment callback, so `.support` is populated before the bump fires. Scheduling the bump inside `loadFunc` instead would race the assignment.
- Grain decided in [Q03](#q03-revision-grain): one global counter.

**Implications:**
- `languageForExtension` resolves to `Extension`, but `LanguageDescription.load()` must resolve a `LanguageSupport`. The legacy stream-mode loaders return a bare `StreamLanguage`, so the load wrapper normalizes: a `LanguageSupport` passes through; anything else is wrapped as `new LanguageSupport(value as Language)`. A `null` resolution (unknown extension, chunk failure) must reject or be filtered before the descriptor is returned — the resolver returns `null` for unknown ids so no descriptor is created at all.
- `TugMarkdownText` gains one external-store subscription ([L02]); the revision joins the `useMemo` dependency list beside `text`.
- Inner-highlighted runs come back through the same `highlightRunsByLine` walk with the same highlight style, so a fence body colors exactly as the same code would in a code view.

#### [P10] Rename the function only (DECIDED) {#p10-rename}

**Decision:** `styleMarkdownText` → `applyMarkdownTextStyle`. Module filenames (`markdown-text-styling.ts` in both homes), the substrate prop (`markdownTextStyling`), the compartment (`markdownStylingCompartment`), and the app-test filename stay as they are.

**Rationale:**
- The user asked for this rename specifically. The verb form reads better at the call site and names the scheme (`markdownTextStyle`) rather than restating the noun.
- Widening the rename to files, props, and test names is a large mechanical diff with no behavior change; kept separable so it can be judged on its own ([Q04](#q04-prop-rename)).

**Implications:** Three call sites — `tug-markdown-text.tsx`, the unit test, and the module's own docstrings — plus the docstring in the sibling editor module that cross-references it.

#### [P11] One hanging-indent implementation, with the editor's fallback (DECIDED) {#p11-shared-indent}

**Decision:** Move the indent math into the shared grammar module as `markdownHangingIndent(lineText, lineFrom, markTo)`, implementing the regex match **plus** the marker-end fallback, and have both `applyMarkdownTextStyle` and `mdListHangingIndent` call it.

**Rationale:**
- The two copies disagree today: `list-hanging-indent.ts` falls back to `node.to - line.from + 1` when `LIST_PREFIX` misses; `lib/markdown-text-styling.ts` skips the line. Since the regex is anchored at `^`, a list inside a blockquote (`> - item`) or a tab after the marker gets a hanging indent in the editor and none in a receipt.
- The regex is identical in both files today — literally duplicated — which is how they drifted in the first place.

**Implications:** `LIST_PREFIX` is declared once. `list-hanging-indent.ts` keeps its `ViewPlugin` and viewport walk; only the width computation moves.

#### [P12] No size changes, no heading-level differentiation (DECIDED) {#p12-no-size-changes}

**Decision:** Nothing in this scheme changes `font-size`, and h1–h6 continue to share one treatment (bold, keyword tone).

**Rationale:**
- A size ramp breaks the uniform line box that makes these surfaces read as text rather than as a rendered document — the property the whole scheme exists to preserve. The user confirmed this call explicitly.
- Font *family* changes ([P08](#p08-mono-face)) are permitted because they express a construct without disturbing the line grid's basis; sizes are not.

**Implications:** [#step-9](#step-9) greps the diff for `font-size` / `fontSize` as a falsifiable check. A tone-only heading ramp remains available as a follow-on.

---

### Deep Dives {#deep-dives}

#### Audit findings — observed, not inferred {#audit-findings}

Every row below was produced by parsing a corpus document with the real grammar and walking it with the real `tugHighlightStyleInner`, then printing each line's runs and their generated classes. "Unstyled" means the run carried no class at all — visually identical to surrounding prose.

**Table T01: Construct coverage before this plan** {#t01-coverage-before}

| Construct | Today | Gap |
|---|---|---|
| ATX headings, incl. optional closing hashes | heading tone + bold; `#`/`##` marker tone | — |
| Setext headings | styled; `====`/`----` underline marker-toned | — |
| Emphasis / strong, `*` and `_`, intraword `*` | italic / bold; delimiters marker-toned | — |
| Code spans | code tone; backticks marker-toned | face (gap 6) |
| Indented code blocks | code tone | face (gap 6) |
| Fenced blocks | fence + info string toned; body flat | sub-language (gap 5), face (gap 6) |
| Links: inline, reference, implicit, definitions | link tone; `[label]` label tone; `"title"` string tone | — |
| Images | as links | — |
| Autolinks `<url>`, `<a@b.com>` | url tone; brackets marker-toned | — |
| Backslash escapes | own tone | — |
| Entities `&amp;` | string tone | — |
| Lists, ordered/unordered/nested | markers toned + hanging indent | indent misses `> - item` (divergence B) |
| HTML comments | comment tone (italic) | — |
| **Blockquote bodies** | **unstyled** (`>` toned only) | **gap 1** |
| **Horizontal rules** | **unstyled** across the whole line | **gap 2** |
| **Strikethrough bodies** | **unstyled** (`~~` toned only) | **gap 3** |
| **Hard line breaks** | tagged, but color on whitespace paints nothing | **gap 4** |
| **Inline / block HTML** | **unstyled** in the filter | **gap 7** |
| Task markers, tables, strikethrough | style in the filter, **not** in the editor | **divergence A** |

Divergence A, precisely: `styleMarkdownText` parses with `markdownLanguage` (GFM); `loadMarkdownTextStyling` calls `markdown({...})`, whose `base` defaults to `commonmarkLanguage`. Confirmed by parsing the same source through both and diffing the run arrays — `- [ ] task` yields a task-marker run under GFM and nothing under CommonMark.

Gap 7 has a pleasant property: it closes **for free** under [P01](#p01-shared-grammar). The filter today parses with `markdownLanguage.parser` directly, which has no `parseCode` extension; `markdown()` always pushes `parseCode({ codeParser, htmlParser })`, so a parser built through `markdown()` sub-parses HTML with the HTML grammar. Probed: `text with <b>inline html</b> here` yields angle-bracket, tag-name, attribute-name and string runs.

**Table T02: Tag → treatment, after this plan** {#t02-tag-map-after}

| Lezer tag | Markdown nodes | Treatment | Source |
|---|---|---|---|
| `heading` (via `heading1`…`heading6` fallback) | ATX/Setext headings, GFM table header | `--tug-syntax-keyword`, bold | unchanged |
| `emphasis` / `strong` | `Emphasis` / `StrongEmphasis` | italic / bold | unchanged |
| `monospace` | `InlineCode`, `CodeText` | `--tug-syntax-code` **+ mono family** | [P08](#p08-mono-face) |
| `link` / `url` | `Link`, `Image`, `URL`, `Autolink` | `--tug-syntax-string` (+ underline, read-only variant only) | unchanged |
| `labelName` | `LinkLabel`, `CodeInfo` | `--tug-syntax-constant` | unchanged |
| `string` | `LinkTitle`, `Entity` | `--tug-syntax-string` | unchanged |
| `escape` | `Escape` | `--tug-syntax-string-expression` | unchanged |
| `meta`/`processingInstruction`/`annotation` | `HeaderMark`, `QuoteMark`, `ListMark`, `LinkMark`, `EmphasisMark`, `CodeMark`, `TableDelimiter`, `StrikethroughMark` | `--tug-syntax-decorator` | unchanged |
| `comment` | `Comment`, `CommentBlock` | `--tugx-syntax-comment`, italic | unchanged |
| `atom` | `TaskMarker` | `--tug-syntax-number` | unchanged (reaches composers via [P02](#p02-gfm-dialect)) |
| **`quote`** | `Blockquote/...`, `BlockQuote/...` | **`--tugx-syntax-quote`** | [P04](#p04-blockquote-tone) |
| **`contentSeparator`** | `HorizontalRule` | **`--tug-syntax-decorator`** | [P05](#p05-hr-marker-tone) |
| **`strikethrough`** | `Strikethrough/...` | **`line-through`** | [P06](#p06-strikethrough) |
| **`tugHardBreakTag`** | `HardBreak` (overridden) | **`--tug-syntax-hard-break-bg` background** | [P07](#p07-hard-break-tint) |
| `tagName` / `attributeName` / brackets | HTML sub-parse | existing HTML slots | closes via [P01](#p01-shared-grammar) |
| language tags | fence bodies | existing per-language slots | [P09](#p09-fenced-code) |

Note on heading tags: `@lezer/markdown` emits `heading1`…`heading6`, never bare `heading`. `@lezer/highlight` defines those as children of `heading`, so the single `{ tag: tags.heading }` spec catches all six by tag inheritance. That is why all levels share one treatment today, and per [P12](#p12-no-size-changes) they continue to.

#### `@codemirror/lang-markdown` facts (verified against the installed ^6.5.0) {#lang-markdown-facts}

All of the following were read out of `tugdeck/node_modules/@codemirror/lang-markdown/dist/` (and `@codemirror/lang-html/dist/`) or observed by probe. They are the concrete grounds for the decisions above; an implementer should not need to re-derive them.

- **`markdown(config)` signature defaults:** `base` defaults to `commonmarkLanguage`; `addKeymap = true`; `completeHTMLTags = true`; `pasteURLAsLink = true`; `htmlTagLanguage = htmlNoMatch`. It throws `RangeError` unless `base.parser instanceof MarkdownParser`.
- **`markdownLanguage`** is `commonmark.configure([GFM, Subscript, Superscript, Emoji, …])` — the GFM-and-more dialect. `commonmarkLanguage` is strict CommonMark. Both are exported.
- **`markdown()` always pushes `parseCode({ codeParser, htmlParser: htmlTagLanguage.language.parser })`** into the parser's extensions — this is what gives HTML sub-parsing and fenced-code sub-parsing. A parser obtained as `markdownLanguage.parser` (what the filter uses today) has neither.
- **`htmlNoMatch = html({ matchClosingTags: false })`**, and `html()`'s returned support array is `[autocomplete data, autoCloseTags, javascript().support, css().support]`. `autoCloseTags` is an `EditorView.inputHandler`. Hence [P03](#p03-no-auto-close). It also means `@codemirror/lang-html`, `-javascript`, and `-css` are already pulled in by any static import of lang-markdown.
- **`getCodeParser`** accepts `codeLanguages` as either a `readonly LanguageDescription[]` or a function `(info: string) => Language | LanguageDescription | null`. The info string is truncated at the first whitespace (`/\S*/`). For a `LanguageDescription`, it returns `found.support ? found.support.language.parser : ParseContext.getSkippingParser(found.load())`.
- **`LanguageDescription.load()`** memoizes: `this.loading = loadFunc().then(support => this.support = support)`. A caller's `desc.load().then(cb)` therefore fires **after** `.support` is assigned. Probed end-to-end: a headless parse before load leaves the fence body unrun; after awaiting the load, the same parser instance tokenizes it fully (`const`/`x`/`=`/`1`/`;` all classed) and `desc.support` is cached.
- **`styleTags` through `markdown({ extensions: [{ props: [...] }] })` replaces a node's tag.** Probed: with `styleTags({ HardBreak: customTag })`, the two trailing spaces emit only the custom tag's class, and no longer emit the marker class. `MarkdownExtension` accepts a `props: readonly NodePropSource[]` field, which is how the override is delivered.
- **Node → tag assignments in `@lezer/markdown`** relevant here: `Blockquote/...` and `BlockQuote/...` → `quote`; `HorizontalRule` → `contentSeparator`; `Strikethrough/...` → `strikethrough` (GFM); `InlineCode CodeText` → `monospace`; `HeaderMark HardBreak QuoteMark ListMark LinkMark EmphasisMark CodeMark` → `processingInstruction`; `CodeInfo LinkLabel` → `labelName`; `LinkTitle` → `string`; `Escape` → `escape`; `Entity` → `character`; `TaskMarker` → `atom`; `TableHeader/...` → `heading`; `TableDelimiter` → `processingInstruction`.

#### Naming hazard: `lib/markdown/` is a different subsystem {#naming-hazard}

`tugdeck/src/lib/markdown/` already exists and is **not** part of this scheme. It is the transcript's HTML rendering pipeline — `parse-markdown-to-sanitized-blocks.ts`, `dompurify-instance.ts`, `render-incremental.ts`, `enhance-fenced-code.ts`, `enhance-mermaid.ts`, `enhance-math.ts`, `block-transformers/` — consumed by `TugMarkdownBlock` and `TugMarkdownView`. That pipeline turns markdown *into styled HTML* (markers removed, structure rendered), which is the exact opposite of what `markdownTextStyle` does.

Consequences for this plan:
- Put the new shared module at `tugdeck/src/lib/markdown-text-style-grammar.ts` — a sibling of `markdown-text-styling.ts`, **not** inside `lib/markdown/`.
- `tests/app-test/at0229-prompt-markdown-styling.test.ts` currently declares `@covers tugdeck/src/lib/markdown/`, which resolves (the directory exists) but points at the wrong subsystem, so a change to the transcript renderer needlessly selects the prompt-styling test and a change to the filter does not select it at all. Retarget it in [#step-8](#step-8).

#### Where the two forms are wired today {#wiring-map}

- **Filter:** `lib/markdown-text-styling.ts` exports `MarkdownSpan`, `MarkdownStyledLine`, and `styleMarkdownText`. It parses with `markdownLanguage.parser.parse(text)`, walks with `highlightRunsByLine(tree, text, tugHighlightStyleInner)` from `lib/language-registry.ts`, cuts each line into spans at run boundaries (`spansForLine`), and computes list indents by iterating `ListMark` nodes with a forward line cursor over `lineStartOffsets`.
- **`TugMarkdownText`:** `useMemo(() => styleMarkdownText(text), [text])`; renders one `div.tug-markdown-text-line` per source line, with `paddingLeft`/`textIndent` in `ch` when `indent > 0`, and `renderFilterHighlightSpans(line.spans, line.text, highlightQuery)` from `components/tugways/filter-highlight.tsx` so a list filter's matches nest *inside* the syntax runs. CSS (`tug-markdown-text.css`) sets `white-space: pre-wrap`, `overflow-wrap: anywhere`, `min-height: 1lh`, and deliberately sets no type — the host's face, size, leading, and color are inherited.
- **Editor bundle:** `tug-text-editor/markdown-text-styling.ts` caches one module-wide promise: `import("@codemirror/lang-markdown")` → `markdown({ addKeymap: false, pasteURLAsLink: false, completeHTMLTags: false })` → `[support, tugEditingHighlightStyle, mdListHangingIndent]`. A rejected import clears the cached promise so the next caller retries.
- **Substrate:** `tug-text-editor.tsx` holds `markdownStylingCompartment` (seeded `.of([])`), the `markdownTextStyling` prop, `markdownTextStylingRef`, and a single post-mount `useLayoutEffect` owning every enable/disable transition with `alive` + `viewRef.current` + `markdownTextStylingRef.current` guards. Disable is synchronous; enable is async and today wraps the load in a 4-attempt backoff ladder against a rejected chunk fetch, logging each failure through `tugDevLogStore.warn`. That ladder is dead code once [P01](#p01-shared-grammar) makes the import static — handled in [#step-2](#step-2).
- **`TugCodeView`:** its language effect prefers the markdown bundle over a `language` grammar when `markdownTextStyling` is set, reconfiguring `languageCompartment` with the resolved bundle.
- **Highlight styles:** `tugHighlightSpecsBase` (shared specs) → `tugHighlightStyleInner` (+ underlined link/url) and `tugEditingHighlightStyleInner` (link/url, no underline). `highlightRunsByLine` mounts a style's generated CSS via `mountHighlightStyle` so static callers get the same colors a live editor paints.

---

### Specification {#specification}

**Spec S01: `applyMarkdownTextStyle` output contract** {#s01-filter-contract}

```ts
export interface MarkdownSpan { text: string; className: string }

export interface MarkdownStyledLine {
  /** The line's verbatim text (no trailing newline). */
  text: string;
  /** Hanging indent in monospace cells; 0 when the line starts no list item. */
  indent: number;
  /** True when the line lies inside a fenced or indented code block. */
  code: boolean;
  /** The line's runs, in order, covering its full text. */
  spans: MarkdownSpan[];
}

export function applyMarkdownTextStyle(text: string): MarkdownStyledLine[];
```

Invariants (each asserted by unit test):
- `result.map(l => l.text).join("\n") === text` — always, for every input.
- For every line, `spans.map(s => s.text).join("") === text` when `spans.length > 0`.
- Empty input yields exactly one line, `{ text: "", indent: 0, code: false, spans: [] }`.
- A blank source line yields an entry with empty `spans`.
- `code` is true for lines inside `FencedCode` and `CodeBlock` node ranges, including the fence delimiter lines themselves (so a fence reads as one block).

**Spec S02: `lib/markdown-text-style-grammar.ts` exports** {#s02-grammar-module}

| Export | Kind | Contract |
|---|---|---|
| `markdownTextStyleSupport` | `LanguageSupport` | `markdown({ base: markdownLanguage, addKeymap: false, pasteURLAsLink: false, completeHTMLTags: false, htmlTagLanguage: html({ matchClosingTags: false, autoCloseTags: false }), codeLanguages: resolveFenceLanguage, extensions: [{ props: [styleTags({ HardBreak: tugHardBreakTag })] }] })` |
| `markdownTextStyleParser` | `MarkdownParser` | `markdownTextStyleSupport.language.parser` — the parser both forms use |
| `markdownHangingIndent(lineText, lineFrom, markTo)` | `fn → number` | Regex prefix width, else `markTo - lineFrom + 1` ([P11](#p11-shared-indent)) |
| `subscribeMarkdownGrammars(cb)` | `fn → () => void` | Store subscribe for `useSyncExternalStore` |
| `getMarkdownGrammarRevision()` | `fn → number` | Monotonic counter; changes only when a fence grammar resolves |

`resolveFenceLanguage(info)` is module-private: it maps `info` through the registry's alias/extension resolution, returns `null` for unknown ids, and otherwise returns a memoized `LanguageDescription` (one per extension key). When the returned descriptor has no `support` yet, it kicks `void desc.load().then(bumpRevision, () => {})` — the bump ordering rationale is in [P09](#p09-fenced-code).

**Spec S03: Highlight-spec additions in `tugHighlightSpecsBase`** {#s03-spec-additions}

```ts
{ tag: tags.quote,            color: "var(--tugx-syntax-quote)" },
{ tag: tags.contentSeparator, color: "var(--tug-syntax-decorator)" },
{ tag: tags.strikethrough,    textDecoration: "line-through" },
{ tag: tugHardBreakTag,       backgroundColor: "var(--tug-syntax-hard-break-bg)" },
```

and the existing monospace spec gains a family:

```ts
{ tag: tags.monospace, color: "var(--tug-syntax-code)", fontFamily: "var(--tug-font-family-mono)" },
```

`tugHardBreakTag` is `Tag.define()` from `@lezer/highlight`, exported from `language-registry.ts`. No spec added by this plan sets `fontSize` ([P12](#p12-no-size-changes)).

**Spec S04: New theme tokens** {#s04-tokens}

In `tugdeck/src/components/tugways/tug-code.css`, syntax block:

- `--tugx-syntax-quote: var(--tug7-element-global-text-normal-muted-rest);` — text-derived, declared in `body`, no light override needed, one hop per [L17].
- `--tug-syntax-hard-break-bg: --tug-color(purple, l: 760, c: 280, a: 220);` in `body`, and `--tug-syntax-hard-break-bg: --tug-color(purple, l: 460, c: 340, a: 180);` in the `[data-theme-mode="light"] body` block. Alpha values are a starting point — tune by eye against all six themes in [#step-5](#step-5); the constraint is "clearly present, never louder than the text over it."

Also: one `@tug-pairings` docblock row for `--tugx-syntax-quote` (surface `--tugx-codeBlock-bg`, role `informational`, context "Blockquote body text"), and the matching `ELEMENT_SURFACE_PAIRING_MAP` entry in `theme-pairings.ts`. `--tug-syntax-hard-break-bg` is decorative and gets neither.

**Spec S05: The construct corpus** {#s05-corpus}

A single fixture string used by the unit tests (and mirrored, abbreviated, in the app-test) containing at minimum: ATX heading with closing hashes; setext heading; blockquote and nested blockquote; blockquote containing a list item; `---` and `***` rules; a paragraph line ending in two spaces followed by a continuation; `*em*`, `_em_`, `**strong**`, `__strong__`, `` `code` ``, intraword `*emphasis*`; `\*escaped\*` and `&amp;`; inline, reference, and implicit links plus a link definition; an image; autolinks for URL and email; an indented code block; a ` ```ts ` fence with a `const` declaration; `~~strike~~`; a GFM table with header, delimiter, and body rows; `- [ ]` and `- [x]` task items; ordered items with `.` and `)`; a tab-separated list marker; inline HTML and an HTML comment.

The corpus lives in the unit test file, not in the source, and is the input to the verbatim-round-trip assertion — the scheme's central invariant.

#### State Zone Mapping (tugdeck/tugways plans) {#state-zone-mapping}

| State | Zone | Mechanism | Law |
|---|---|---|---|
| Markdown token tones, weights, decorations, families | appearance | `HighlightStyle` classes generated from `tugHighlightSpecsBase`; CSS custom properties for every color | [L06] |
| Hard-break tint | appearance | Highlight-style `backgroundColor` on a Tug-owned tag | [L06] |
| Code-line mono face (editor) | appearance | `Decoration.line` + `EditorView.baseTheme` in a CM6 extension | [L06] |
| Code-line mono face (filter) | appearance | `code` flag → class on `div.tug-markdown-text-line`, styled in `tug-markdown-text.css` | [L06] |
| List hanging indent | appearance | `Decoration.line` (editor) / inline `padding-left` + `text-indent` (filter) | [L06] |
| Fenced-grammar revision | structure | module-scope store; `useSyncExternalStore(subscribeMarkdownGrammars, getMarkdownGrammarRevision)` in `TugMarkdownText` | [L02] |
| Grammar chunk loaded/not-loaded | CM6 config | existing single post-mount `useLayoutEffect` + compartment reconfigure with `alive`/`viewRef`/ref guards | [L07] |

No new persistent state, no storage, no new user-facing settings.

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|---|---|
| `tugdeck/src/lib/markdown-text-style-grammar.ts` | Shared configured parser, hanging-indent helper, fence-language resolver, grammar-revision store ([Spec S02](#s02-grammar-module)) |
| `tugdeck/src/components/tugways/tug-text-editor/code-block-mono.ts` | CM6 `ViewPlugin` giving code-block lines the mono face, with its own `EditorView.baseTheme` ([P08](#p08-mono-face)) |
| `tests/app-test/at0269-markdown-text-style-constructs.test.ts` | App-test for the new constructs in the live app (at0268 is the highest existing number) |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|---|---|---|---|
| `applyMarkdownTextStyle` | fn (renamed) | `tugdeck/src/lib/markdown-text-styling.ts` | was `styleMarkdownText` ([P10](#p10-rename)) |
| `MarkdownStyledLine.code` | field (new) | same | [Spec S01](#s01-filter-contract) |
| `markdownTextStyleSupport` / `markdownTextStyleParser` | const (new) | `lib/markdown-text-style-grammar.ts` | [Spec S02](#s02-grammar-module) |
| `markdownHangingIndent` | fn (new) | same | [P11](#p11-shared-indent) |
| `subscribeMarkdownGrammars` / `getMarkdownGrammarRevision` | fn (new) | same | [P09](#p09-fenced-code), [L02] |
| `tugHardBreakTag` | const (new) | `tugdeck/src/lib/language-registry.ts` | `Tag.define()`; declared here to keep imports acyclic ([P01](#p01-shared-grammar)) |
| `tugHighlightSpecsBase` | const (modify) | same | four additions + monospace family ([Spec S03](#s03-spec-additions)) |
| `mdCodeBlockMono` | const (new) | `tug-text-editor/code-block-mono.ts` | [P08](#p08-mono-face) |
| `mdListHangingIndent` | const (modify) | `tug-text-editor/list-hanging-indent.ts` | delegates width to `markdownHangingIndent`; local `LIST_PREFIX` removed |
| `loadMarkdownTextStyling` | fn (modify) | `tug-text-editor/markdown-text-styling.ts` | resolves `[markdownTextStyleSupport, tugEditingHighlightStyle, mdListHangingIndent, mdCodeBlockMono]`; signature unchanged |
| markdown-styling `useLayoutEffect` | effect (modify) | `tugdeck/src/components/tugways/tug-text-editor.tsx` | retry ladder collapses to one `.then`; guard trio preserved ([#step-2](#step-2), [L07]) |
| `TugMarkdownText` | component (modify) | `tugdeck/src/components/tugways/tug-markdown-text.tsx` | revision subscription; `code` line class |
| `--tugx-syntax-quote`, `--tug-syntax-hard-break-bg` | tokens (new) | `tugdeck/src/components/tugways/tug-code.css` | [Spec S04](#s04-tokens) |
| `ELEMENT_SURFACE_PAIRING_MAP` | const (modify) | `tugdeck/src/components/tugways/theme-pairings.ts` | one entry for `--tugx-syntax-quote` |
| `.tug-markdown-text-line` code variant | CSS (new) | `tugdeck/src/components/tugways/tug-markdown-text.css` | mono family only; no size |

---

### Documentation Plan {#documentation-plan}

- [ ] Update the module docstring of `lib/markdown-text-styling.ts`: the shared grammar, the new `code` field, the revision-driven restyle, and the renamed function.
- [ ] Update the module docstring of `tug-text-editor/markdown-text-styling.ts`: it no longer configures its own `markdown()`; record `autoCloseTags: false` beside the existing `addKeymap` / `pasteURLAsLink` reasoning ([P03](#p03-no-auto-close)).
- [ ] Author the docstring of `lib/markdown-text-style-grammar.ts` as the scheme's statement of intent: syntax is never removed; both forms parse here; GFM is the dialect; the hard-break tint is the one non-textual affordance and why.
- [ ] Add the `@tug-pairings` row for `--tugx-syntax-quote` in `tug-code.css`.
- [ ] Retarget the stale `@covers` line in `at0229-prompt-markdown-styling.test.ts` ([#naming-hazard](#naming-hazard)).

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|---|---|---|
| **Unit (bun, real grammar)** | Drive `applyMarkdownTextStyle` over the corpus with the real parser and the real highlight style; assert run *structure* (which characters form a run, which runs share or differ in class) rather than generated class names | Every construct's tagging, the verbatim invariant, hanging-indent math, filter/editor parity, the post-load fence restyle |
| **App-test (real Tug.app)** | Drive the live app and read **computed** styles via `evalJS` | Anything that is only true after CSS resolves: `line-through`, non-transparent hard-break background, mono `font-family`, and the absence of HTML auto-close |
| **Audits** | `audit:tokens`, `audit:theme-contrast`, `audit:gamut` | Whenever theme tokens change |
| **Build gates** | `bunx tsc --noEmit`, `bunx vite build` | Every step |

The unit tests are legitimate real-code-path tests, not mock tests: they invoke the production function, the production grammar, and the production highlight style. Class names are generated (`ͼ13`, `ͼy`, …) and must never be asserted literally — assert that two runs' classes *differ*, or that a run's class is non-empty, or compare run arrays produced by two entry points.

Parity test shape: parse one source string through `applyMarkdownTextStyle` and, separately, through the extension bundle's `markdownTextStyleSupport.language.parser` + `highlightRunsByLine`, then assert the run arrays match. Since [P01](#p01-shared-grammar) makes them the same parser, this is a regression guard against the divergence ever reopening.

App-test surface: `gallery-prompt-entry` (composes the real `TugPromptEntry`), the same session-free surface `at0229` uses, with `describe.skipIf(!SHOULD_RUN)` on `TUGAPP_APP_TEST === "1"`, `[data-slot="tug-text-editor"] .cm-content` under `[data-card-id="A"]`, and settle-polling until markdown token spans appear (the grammar resolves asynchronously through the substrate's effect).

#### What stays out of tests {#test-non-goals}

- jsdom / mock render tests — banned repo-wide.
- Literal generated-class-name assertions — brittle by construction; assert relationships instead.
- Screenshot pixel comparison of the hard-break tint — the computed `background-color` assertion is stabler, and a WebKit highlight-wash gotcha makes screenshots unreliable for thin washes.
- Contrast values for `--tug-syntax-hard-break-bg` — decorative, no foreground pairing; the audits cover the tokens that do carry roles.
- CM6 internals (compartment mechanics, `HighlightStyle` output shape) — covered end-to-end.

---

### Execution Steps {#execution-steps}

> **Commit after all checkpoints pass.** Per repo git policy, the user commits.
>
> Every step's checkpoint includes `cd tugdeck && bun test` and `cd tugdeck && bunx vite build`; steps touching types also run `bunx tsc --noEmit`. The vite build is not optional: the debug app loads the production rollup bundle, so an import that works under dev esbuild can still hang the app at the splash screen.

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Rename `styleMarkdownText` → `applyMarkdownTextStyle` | done | `dc207a88e` |
| #step-2 | Shared grammar module; both forms adopt it | done | `a0053ab95` |
| #step-3 | Shared hanging-indent math with fallback | done | `cedc38112` |
| #step-4 | Blockquote, horizontal rule, strikethrough tones | done | `1a71357bf` |
| #step-5 | Hard-line-break tint | done | `7a4d8ef37` |
| #step-6 | Mono face for inline and block code | done | `68302fa7b` |
| #step-7 | Fenced-code sub-language highlighting | done | `daf9eb61c` |
| #step-8 | Tests: corpus unit suite + app-test at0269 | done | `bfebd5d03` |
| #step-9 | Integration checkpoint | done | verification only |

---

#### Step 1: Rename `styleMarkdownText` → `applyMarkdownTextStyle` {#step-1}

**Commit:** `tugdeck(markdown-text-style): rename styleMarkdownText to applyMarkdownTextStyle`

**References:** [P10](#p10-rename) rename scope, [Q04](#q04-prop-rename) deferred prop rename, (#wiring-map)

**Artifacts:**
- `tugdeck/src/lib/markdown-text-styling.ts` (export renamed, docstring updated)
- `tugdeck/src/components/tugways/tug-markdown-text.tsx` (import + call site)
- `tugdeck/src/lib/__tests__/markdown-text-styling.test.ts` (import + call sites)

**Tasks:**
- [ ] Rename the exported function; update its docstring to the verb form.
- [ ] Update the one component call site (`useMemo` in `TugMarkdownText`) and every call in the existing unit test.
- [ ] Update the cross-reference in the docstring of `tug-text-editor/markdown-text-styling.ts` if it names the old symbol.
- [ ] Confirm no other references: `grep -rn "styleMarkdownText" tugdeck/src tests` returns nothing.

**Tests:**
- [ ] Existing `markdown-text-styling.test.ts` passes unchanged in behavior.

**Checkpoint:**
- [ ] `cd tugdeck && bun test`
- [ ] `cd tugdeck && bunx tsc --noEmit`
- [ ] `cd tugdeck && bunx vite build`
- [ ] `grep -rn "styleMarkdownText" tugdeck/src tests` prints nothing

---

#### Step 2: Shared grammar module; both forms adopt it {#step-2}

**Depends on:** #step-1

**Commit:** `tugdeck(markdown-text-style): one shared grammar for the filter and the editor`

**References:** [P01](#p01-shared-grammar) shared module, [P02](#p02-gfm-dialect) GFM dialect, [P03](#p03-no-auto-close) no auto-close, [Spec S02](#s02-grammar-module), Risk table (bundle growth), (#lang-markdown-facts, #audit-findings, #naming-hazard)

**Artifacts:**
- New `tugdeck/src/lib/markdown-text-style-grammar.ts` (parser configuration only at this step — the fence resolver and revision store arrive in [#step-7](#step-7), the `HardBreak` prop in [#step-5](#step-5))
- `tugdeck/src/lib/markdown-text-styling.ts` parses with the shared parser
- `tugdeck/src/components/tugways/tug-text-editor/markdown-text-styling.ts` bundles the shared support
- `tugdeck/src/components/tugways/tug-text-editor.tsx` — the markdown-styling effect's retry ladder collapses (see the task below)

**Tasks:**
- [ ] Author the module per [Spec S02](#s02-grammar-module), with `codeLanguages` and the `extensions` props hook **omitted for now** (added in later steps) so this step is purely the unification. Configure `base: markdownLanguage`, `addKeymap: false`, `pasteURLAsLink: false`, `completeHTMLTags: false`, `htmlTagLanguage: html({ matchClosingTags: false, autoCloseTags: false })` — importing `html` from `@codemirror/lang-html`, already a dependency.
- [ ] Write the module docstring as the scheme's statement of intent (see [#documentation-plan](#documentation-plan)); include the [P03](#p03-no-auto-close) reasoning, since "why is `autoCloseTags` false" is exactly the question a future reader will have.
- [ ] In `lib/markdown-text-styling.ts`, replace `markdownLanguage.parser.parse(text)` with `markdownTextStyleParser.parse(text)` and drop the now-unused `@codemirror/lang-markdown` import.
- [ ] In `tug-text-editor/markdown-text-styling.ts`, replace the dynamic `import("@codemirror/lang-markdown")` + local `markdown(...)` call with a resolved promise over `[markdownTextStyleSupport, tugEditingHighlightStyle, mdListHangingIndent]`. **Keep the `Promise<Extension>` signature** — `tug-text-editor.tsx` and `tug-code-view.tsx` both await it, and the substrate's guard trio depends on the async shape. The retry-on-rejection cache logic becomes dead once the import is static; remove it and say so in the docstring rather than leaving it inert.
- [ ] **Collapse the substrate's now-dead retry ladder.** The markdown-styling `useLayoutEffect` in `tug-text-editor.tsx` currently wraps its enable path in a 4-attempt backoff ladder (`maxAttempts`, a `setTimeout` retry, a `tugDevLogStore.warn` on each failure) whose comment states that "`loadMarkdownTextStyling` no longer caches a rejection, so each retry re-attempts a fresh import." Once the import is static that promise cannot reject, so the entire rejection arm — ladder, backoff, and warn — becomes unreachable, and its comment becomes false. Collapse the enable path to a single `.then` and update the comment to say the load is now synchronous-in-practice behind an async signature. **Preserve the guard trio exactly** (`alive`, `viewRef.current === null`, `markdownTextStylingRef.current === false`): they defeat the flip-during-load race and are unrelated to rejection handling ([L07]). Check `tug-code-view.tsx`'s language effect for a comment making the same lazy-chunk claim and correct it if so.
- [ ] Measure bundle impact: record `ls -l tugdeck/dist/assets/*.js` totals from a `bunx vite build` before the change and after, and note the delta in the commit message. Expectation per [#dependencies](#dependencies): no meaningful change, because lang-markdown (and transitively lang-html/-javascript/-css) is already statically imported by the filter. If the delta is material, stop and reconsider — the fallback is to keep the editor module's dynamic import and have it `await import()` the shared module instead.

**Tests:**
- [ ] Extend `markdown-text-styling.test.ts`: a GFM-only construct (`- [ ] task`, `~~strike~~`) produces styled runs, proving the dialect.
- [ ] New parity test: the same source parsed via `applyMarkdownTextStyle` and via `markdownTextStyleSupport.language.parser` + `highlightRunsByLine` yields identical run arrays. Walk **both** sides with `tugHighlightStyleInner` — the editing variant generates a different class for `link`/`url` (no underline), so mixing the two styles fails on links for a reason that has nothing to do with parser parity.
- [ ] New test: inline HTML (`text <b>bold</b> text`) produces classed runs for the tag name and brackets — the gap that closes for free here.

**Checkpoint:**
- [ ] `cd tugdeck && bun test`
- [ ] `cd tugdeck && bunx tsc --noEmit`
- [ ] `cd tugdeck && bunx vite build` (and the bundle-delta note above)
- [ ] Manual, HMR live: open a Text/Snippet surface and a prompt entry; a `~~strike~~` line and a `- [ ]` line now tag in both; typing `<div>` inserts no closing tag.

---

#### Step 3: Shared hanging-indent math with fallback {#step-3}

**Depends on:** #step-2

**Commit:** `tugdeck(markdown-text-style): one hanging-indent implementation for both forms`

**References:** [P11](#p11-shared-indent) shared indent, [Spec S02](#s02-grammar-module), (#audit-findings)

**Artifacts:**
- `markdownHangingIndent` in `lib/markdown-text-style-grammar.ts`
- `lib/markdown-text-styling.ts` and `tug-text-editor/list-hanging-indent.ts` both delegate to it

**Tasks:**
- [ ] Move `LIST_PREFIX` and the width computation into the grammar module as `markdownHangingIndent(lineText, lineFrom, markTo)`: return the regex prefix length when it matches, else `markTo - lineFrom + 1` (the editor's existing fallback, which handles a marker inside a blockquote and a tab after the marker).
- [ ] Delete the duplicated regex from both consumers; keep `list-hanging-indent.ts`'s `ViewPlugin`, viewport walk, and decoration cache exactly as they are — only the width call changes.
- [ ] In `lib/markdown-text-styling.ts`, replace the `if (match !== null)` guard with an unconditional `indents.set(cursor, markdownHangingIndent(...))`.

**Tests:**
- [ ] `> - item` receives a non-zero indent from `applyMarkdownTextStyle` (the divergence this step closes).
- [ ] A tab-separated marker (`-\titem`) receives a non-zero indent.
- [ ] Existing indent expectations (`- item one` → 2, `1. item two` → 3, `   - nested` → 5, plain → 0) still hold.
- [ ] A `-` at the head of a line inside a fenced block still yields 0 (the `ListMark`-keyed guard is unchanged).

**Checkpoint:**
- [ ] `cd tugdeck && bun test`
- [ ] `cd tugdeck && bunx tsc --noEmit`
- [ ] `cd tugdeck && bunx vite build`

---

#### Step 4: Blockquote, horizontal rule, and strikethrough tones {#step-4}

**Depends on:** #step-2

**Commit:** `tugdeck(markdown-text-style): tone blockquotes, rules, and strikethrough`

**References:** [P04](#p04-blockquote-tone) blockquote tone, [P05](#p05-hr-marker-tone) rule marker tone, [P06](#p06-strikethrough) strikethrough, [Spec S03](#s03-spec-additions), [Spec S04](#s04-tokens), Table T02, (#t02-tag-map-after)

**Artifacts:**
- Three specs added to `tugHighlightSpecsBase` in `lib/language-registry.ts`
- `--tugx-syntax-quote` in `tug-code.css` + `@tug-pairings` row
- One `ELEMENT_SURFACE_PAIRING_MAP` entry in `theme-pairings.ts`

**Tasks:**
- [ ] Add the `quote`, `contentSeparator`, and `strikethrough` specs per [Spec S03](#s03-spec-additions). They go in `tugHighlightSpecsBase`, so both the read-only and the editing variants inherit them.
- [ ] Declare `--tugx-syntax-quote` in the syntax `body` block of `tug-code.css` as a one-hop `var(--tug7-element-global-text-normal-muted-rest)` reference ([L17]); no light-mode override (text-derived tokens inherit theirs).
- [ ] Add the `@tug-pairings` docblock row and the `ELEMENT_SURFACE_PAIRING_MAP` entry, mirroring the existing `--tugx-syntax-comment` entry (surface `--tugx-codeBlock-bg`, role `informational`).
- [ ] Confirm no geometry: the diff contains no `border`, `padding`, `margin`, or `font-size`.

**Tests:**
- [ ] Blockquote body run carries a non-empty class distinct from a plain-paragraph run's class.
- [ ] `---`, `***`, and `___` rule lines carry one class spanning the full line.
- [ ] `~~struck~~` body run's class differs from the surrounding prose run's class.
- [ ] Corpus round-trip still byte-identical.

**Checkpoint:**
- [ ] `cd tugdeck && bun test`
- [ ] `cd tugdeck && bunx vite build`
- [ ] `cd tugdeck && bun run audit:tokens`
- [ ] `cd tugdeck && bun run audit:theme-contrast`
- [ ] Manual, all six themes: a quoted line reads as set apart without reading as disabled; a rule line reads as markup.

---

#### Step 5: Hard-line-break tint {#step-5}

**Depends on:** #step-4

**Commit:** `tugdeck(markdown-text-style): make hard line breaks visible`

**References:** [P07](#p07-hard-break-tint) hard-break tint, [Q01](#q01-hard-break-form) resolved form, Risk [R01](#r01-hardbreak-override), [Spec S03](#s03-spec-additions), [Spec S04](#s04-tokens), (#lang-markdown-facts)

**Artifacts:**
- `tugHardBreakTag` exported from `lib/language-registry.ts` + its spec in `tugHighlightSpecsBase`
- The `extensions: [{ props: [styleTags({ HardBreak: tugHardBreakTag })] }]` hook in `lib/markdown-text-style-grammar.ts`
- `--tug-syntax-hard-break-bg` (dark + light) in `tug-code.css`

**Tasks:**
- [ ] Declare `export const tugHardBreakTag = Tag.define()` in `language-registry.ts` (imported from `@lezer/highlight`). It lives here, not in the grammar module, so the import direction stays grammar → registry and no cycle forms.
- [ ] Add the `backgroundColor`-only spec ([Spec S03](#s03-spec-additions)). Do not add a `color`: the override **replaces** the node's marker tag (Risk [R01](#r01-hardbreak-override)) and the run has no glyphs.
- [ ] Add the `extensions` props hook to the shared `markdown(...)` call, importing `styleTags` from `@lezer/highlight`.
- [ ] Declare both token variants per [Spec S04](#s04-tokens) (`body` and `[data-theme-mode="light"] body`), following the `--tug-terminal-selection-bg` precedent for an alpha-bearing accent recipe. Purple family — never red or green, per the palette constraint in `tug-code.css`.
- [ ] Tune the alpha by eye across all six themes (brio, nocturne, bravura, harmony, aria, vivace): clearly present at a glance, never louder than the text beside it.

**Tests:**
- [ ] A line ending in two spaces yields a run covering exactly those two characters, with a non-empty class.
- [ ] The trailing spaces survive: the line's `text` and its rejoined spans both still end with `"  "`.
- [ ] A line ending in a *single* trailing space yields no such run (a single space is not a hard break).

**Checkpoint:**
- [ ] `cd tugdeck && bun test`
- [ ] `cd tugdeck && bunx vite build`
- [ ] `cd tugdeck && bun run audit:tokens`
- [ ] `cd tugdeck && bun run audit:gamut`
- [ ] `cd tugdeck && bun run audit:theme-contrast`
- [ ] Manual, all six themes: type a line ending in two spaces in a prompt entry — the tint is visible and the caret still sits after two real spaces.

---

#### Step 6: Mono face for inline and block code {#step-6}

**Depends on:** #step-4

**Commit:** `tugdeck(markdown-text-style): code reads in a code face`

**References:** [P08](#p08-mono-face) mono face, [Q02](#q02-mono-scope) resolved scope, [P12](#p12-no-size-changes) no size changes, Risk [R02](#r02-fence-inner-tokens), [Spec S01](#s01-filter-contract), [Spec S03](#s03-spec-additions)

**Artifacts:**
- `fontFamily` on the monospace spec in `lib/language-registry.ts`
- `code` field on `MarkdownStyledLine`, computed in `lib/markdown-text-styling.ts`
- Line class in `tug-markdown-text.tsx` + rule in `tug-markdown-text.css`
- New `tug-text-editor/code-block-mono.ts`, bundled by `loadMarkdownTextStyling`

**Tasks:**
- [ ] Add `fontFamily: "var(--tug-font-family-mono)"` to the `tags.monospace` spec. Do **not** add `fontSize` ([P12](#p12-no-size-changes)).
- [ ] Compute `code` per line in `applyMarkdownTextStyle` by iterating `FencedCode` and `CodeBlock` nodes and marking every line in `[node.from, node.to]`, fence delimiter lines included. Reuse the existing `lineStartOffsets` result rather than recomputing.
- [ ] In `TugMarkdownText`, add the class when `line.code` is true; in `tug-markdown-text.css`, set **only** `font-family: var(--tug-font-family-mono)` on it. The component still sets no size, leading, or color — those stay the host's.
- [ ] Author `code-block-mono.ts` mirroring `list-hanging-indent.ts`'s shape: a `ViewPlugin` that walks `view.visibleRanges` for `FencedCode`/`CodeBlock` nodes and adds `Decoration.line({ class: "tug-md-code-line" })` per line, rebuilding on doc/viewport/tree/language change. Carry the rule in an `EditorView.baseTheme({ ".tug-md-code-line": { fontFamily: "var(--tug-font-family-mono)" } })` bundled in the same module, so no CSS file needs to know about it. Line decorations must be added in ascending position for `RangeSetBuilder`.
- [ ] Add `mdCodeBlockMono` to the bundle returned by `loadMarkdownTextStyling`.
- [ ] Update the existing empty-input test, whose `toEqual` now needs the `code` field.

**Tests:**
- [ ] Inline code's run class differs from the surrounding prose run's class (already true) **and** the corpus round-trip is unchanged.
- [ ] Every line of a fenced block, delimiters included, has `code === true`; prose lines have `code === false`.
- [ ] An indented (4-space) code block's lines have `code === true`.
- [ ] A line containing only inline code — not a block — has `code === false`.

**Checkpoint:**
- [ ] `cd tugdeck && bun test`
- [ ] `cd tugdeck && bunx tsc --noEmit`
- [ ] `cd tugdeck && bunx vite build`
- [ ] Manual: set the prompt editor font to IBM Plex Sans in Settings ▸ Dev Card; inline code and fence bodies render mono at the same size as the prose around them; a wrapped list line still hangs under its content.

---

#### Step 7: Fenced-code sub-language highlighting {#step-7}

**Depends on:** #step-6

**Commit:** `tugdeck(markdown-text-style): fenced blocks highlight the language they declare`

**References:** [P09](#p09-fenced-code) fenced code, [Q03](#q03-revision-grain) revision grain, Risk [R02](#r02-fence-inner-tokens), [Spec S02](#s02-grammar-module), (#lang-markdown-facts), [L02]

**Artifacts:**
- `resolveFenceLanguage` + `codeLanguages` wiring in `lib/markdown-text-style-grammar.ts`
- Grammar-revision store in the same module
- Revision subscription in `tug-markdown-text.tsx`

**Tasks:**
- [ ] Implement `resolveFenceLanguage(info)`: resolve `info` to a registry extension key using the same alias handling `languageForLangId` uses (`LANG_ID_ALIASES` + `LOADERS` membership — export a resolver from `language-registry.ts` if `extForLangId` is still module-private), return `null` when unknown, otherwise return a memoized `LanguageDescription` per extension key.
- [ ] The descriptor's `load()` calls `languageForExtension(ext)` and normalizes the result to a `LanguageSupport`: pass a `LanguageSupport` through; wrap anything else (the legacy `StreamLanguage` loaders) as `new LanguageSupport(value)`; throw on `null` so the descriptor stays unloaded rather than caching a broken support.
- [ ] In the resolver, when `desc.support === undefined`, kick `void desc.load().then(bumpRevision, () => {})`. Attaching to `load()`'s memoized promise is what guarantees `.support` is assigned before the bump — see [P09](#p09-fenced-code). Swallow rejections; a missing grammar must never break styling.
- [ ] Implement the store: a module-scope counter, a `Set` of listeners, `subscribeMarkdownGrammars(cb) => () => void`, `getMarkdownGrammarRevision() => number`. `getSnapshot` must return the same number between bumps or React will loop.
- [ ] Pass `codeLanguages: resolveFenceLanguage` into the shared `markdown(...)` call.
- [ ] In `TugMarkdownText`, subscribe with `useSyncExternalStore(subscribeMarkdownGrammars, getMarkdownGrammarRevision)` ([L02]) and add the revision to the `useMemo` dependency list beside `text`.
- [ ] Sanity-check cost with a realistic commit body containing a fence: the restyle happens at most once per distinct grammar per session.

**Tests:**
- [ ] Before any load, a ` ```ts ` body has flat runs; after `await`ing the descriptor's load, a second `applyMarkdownTextStyle` call tokenizes `const` with a class distinct from the flat monospace class. (This is the exact behavior probed against the real package, so it is a stable assertion.)
- [ ] An unknown info string (` ```nosuchlang `) leaves the body flat and throws nothing.
- [ ] `getMarkdownGrammarRevision()` is stable across repeated calls with no load in flight.
- [ ] Fence lines still report `code === true` after inner highlighting (Risk [R02](#r02-fence-inner-tokens)).

**Checkpoint:**
- [ ] `cd tugdeck && bun test`
- [ ] `cd tugdeck && bunx tsc --noEmit`
- [ ] `cd tugdeck && bunx vite build`
- [ ] Manual: a commit message containing a ` ```ts ` fence renders highlighted in the Changeset card's expanded row; a fence in a prompt entry highlights as you type.

---

#### Step 8: Tests — corpus unit suite and app-test at0269 {#step-8}

**Depends on:** #step-3, #step-5, #step-7

**Commit:** `app-test: markdown text style constructs (at0269)`

**References:** [Spec S05](#s05-corpus), [Spec S01](#s01-filter-contract), (#test-plan-concepts, #success-criteria, #naming-hazard)

**Artifacts:**
- Expanded `tugdeck/src/lib/__tests__/markdown-text-styling.test.ts`
- New `tests/app-test/at0269-markdown-text-style-constructs.test.ts`
- Retargeted `@covers` line in `at0229-prompt-markdown-styling.test.ts`

**Tasks:**
- [ ] Consolidate the corpus of [Spec S05](#s05-corpus) as one fixture in the unit test file and assert the two central invariants over it: lines rejoin to the input exactly, and each line's spans rejoin to the line exactly.
- [ ] Fold in the per-step assertions written along the way so the suite reads as one coherent statement of the scheme's coverage.
- [ ] Author `at0269` on the `gallery-prompt-entry` surface (model it on `at0229`: `describe.skipIf(!SHOULD_RUN)`, `mkTempTugbank`/`seedTugbankForLaunch`/`rmTempTugbank`, `[data-card-id="A"] [data-slot="tug-text-editor"] .cm-content`, settle-poll until markdown spans appear). Assert **computed** styles, which is what only the live app can prove:
  - a `~~struck~~` span computes `text-decoration-line: line-through`;
  - the hard-break span computes a non-transparent `background-color`;
  - an inline-code span computes a `font-family` containing the mono stack, with the editor font set to a proportional face;
  - a fence body's `const` span carries a different class than the fence's other text;
  - a blockquote body span's color differs from a plain paragraph span's color;
  - every raw marker (`>`, `---`, `~~`, the two trailing spaces, the backticks) is still present in `view.state.doc.toString()`;
  - typing `<div>` leaves the document as `<div>` — no `</div>` is inserted ([P03](#p03-no-auto-close)).
- [ ] Declare `@covers` for `tugdeck/src/lib/markdown-text-styling.ts`, `tugdeck/src/lib/markdown-text-style-grammar.ts`, `tugdeck/src/lib/language-registry.ts`, and `tugdeck/src/components/tugways/tug-text-editor/`.
- [ ] Retarget `at0229`'s `@covers tugdeck/src/lib/markdown/` to `tugdeck/src/lib/markdown-text-styling.ts` ([#naming-hazard](#naming-hazard)).
- [ ] Keep the test fast and exiting; drive no submit route (no real turn).

**Tests:**
- [ ] The suites themselves.

**Checkpoint:**
- [ ] `cd tugdeck && bun test`
- [ ] `just app-test-covers-check`
- [ ] `just app-test tests/app-test/at0269-markdown-text-style-constructs.test.ts`
- [ ] `just app-test tests/app-test/at0229-prompt-markdown-styling.test.ts`

---

#### Step 9: Integration checkpoint {#step-9}

**Depends on:** #step-1, #step-2, #step-3, #step-4, #step-5, #step-6, #step-7, #step-8

**Commit:** `N/A (verification only)`

**References:** [P12](#p12-no-size-changes) no size changes, (#success-criteria, #exit-criteria, #t01-coverage-before)

**Tasks:**
- [ ] Walk every bullet in [#success-criteria](#success-criteria) against the live app and the test runs.
- [ ] Re-run the audit of Table T01 by hand in the app: paste the [Spec S05](#s05-corpus) corpus into a prompt entry and a Text surface and confirm every row now reads as intended, with every syntax character on screen.
- [ ] Grep the phase's diff for size changes. This repo commits directly to `main`, so diff against the commit recorded for [#step-1](#step-1) in the ledger: `git diff <step-1-commit>^..HEAD -- tugdeck/src | grep -nE "font-size|fontSize"` must return nothing.
- [ ] Confirm the composer and a receipt paint the same source identically apart from the deliberate link-underline difference between the read-only and editing highlight variants.

**Tests:**
- [ ] Full aggregate run.

**Checkpoint:**
- [ ] `cd tugdeck && bun test`
- [ ] `cd tugdeck && bunx tsc --noEmit`
- [ ] `cd tugdeck && bunx vite build`
- [ ] `cd tugdeck && bun run audit:tokens && bun run audit:theme-contrast && bun run audit:gamut`
- [ ] `just app-test-changed`

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** A `markdownTextStyle` scheme that covers every construct documented on the Markdown syntax page — with blockquotes, rules, strikethrough, hard breaks, code face, fenced-code languages, and inline HTML all reading as what they mean — parsed and painted identically by the read-only filter and the live editor, with every markdown character still present in the text.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] Every row of Table T01 marked "gap" or "divergence" is closed, verified by the unit suite and `at0269`.
- [ ] `applyMarkdownTextStyle` reproduces the [Spec S05](#s05-corpus) corpus byte-for-byte (unit test).
- [ ] The filter and the editor bundle parse through one shared parser; the parity test passes (regression guard against re-divergence).
- [ ] The only non-textual affordance in the scheme is the hard-break tint, and it is the only new decorative token.
- [ ] No `font-size` change anywhere in the phase's diff; h1–h6 still share one treatment.
- [ ] `bun test`, `bunx tsc --noEmit`, `bunx vite build`, all three audits, and `just app-test-changed` are green.
- [ ] `grep -rn "styleMarkdownText" tugdeck/src tests` prints nothing.

**Acceptance tests:**
- [ ] `tugdeck/src/lib/__tests__/markdown-text-styling.test.ts` (expanded corpus suite)
- [ ] `tests/app-test/at0269-markdown-text-style-constructs.test.ts`
- [ ] `tests/app-test/at0229-prompt-markdown-styling.test.ts` (unchanged behavior)

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] Rename the `markdownTextStyling` prop, the two `markdown-text-styling.ts` modules, and `at0229`'s filename to match the scheme's spoken name ([Q04](#q04-prop-rename)).
- [ ] A tone-only heading ramp across `heading1`…`heading6` at constant size, if the six-level hierarchy ever needs to read at a glance ([P12](#p12-no-size-changes) permits tone, never size).
- [ ] Migrate `TugTextCardEditor` onto the `TugTextEditor` substrate so the Text card consumes `markdownTextStyling` and deletes its bespoke language/highlight wiring — the long-standing follow-on this scheme was built to enable.
- [ ] Reconsider opt-in markdown *editing* behaviors (list continuation on Enter) with a proper keymap-precedence design.
- [ ] Subscript/superscript/emoji tags arrive with the GFM-plus base but have no specs; decide whether they deserve treatment.

| Checkpoint | Verification |
|---|---|
| One shared parser | Parity unit test; `grep` finds one `markdown(` call in `tugdeck/src` |
| Every construct covered | Corpus unit suite + `at0269` computed-style assertions |
| Text never lost | Verbatim round-trip assertion over the corpus |
| Sizes never changed | `git diff <step-1-commit>^..HEAD -- tugdeck/src \| grep -E "font-size\|fontSize"` empty |
| Theme health | `audit:tokens`, `audit:theme-contrast`, `audit:gamut` |
| Build health | `bun test`, `bunx tsc --noEmit`, `bunx vite build`, `just app-test-changed` |
