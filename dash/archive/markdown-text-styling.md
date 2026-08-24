<!-- devised against tuglaws/devise-skeleton.md v4 -->

## Markdown Text Styling — a shared TugTextEditor capability {#markdown-text-styling}

**Purpose:** Generalize the Text card's light markdown formatting niceties (token
styling that never removes visible markdown syntax, plus the soft-wrap hanging indent
for list items) into a single shared `markdownTextStyling` capability on the
`TugTextEditor` substrate, and adopt it in the Dev card's prompt entry. Also unify the
soft-wrap setting label ("Soft wrap text") across the Settings card.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-07-14 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

The Text card editor recently gained "light markdown formatting" — heading / emphasis /
strong / inline-code / link token coloring via a `HighlightStyle` (never hiding the raw
`#`, `*`, `` ` `` markers), and a hanging indent so a soft-wrapped list item's
continuation lines align under the item content instead of the marker (commit
`e74eaff93`). The prompt-entry area of the Dev card is CM6-backed via the shared
`TugTextEditor` substrate (`tugdeck/src/components/tugways/tug-prompt-entry.tsx`
composes `tugdeck/src/components/tugways/tug-text-editor.tsx`), but today it is plain
text: no markdown grammar, no highlight style, no hanging indent.

Crucially, the Text card does **not** use `TugTextEditor` — `TugTextCardEditor`
(`tugdeck/src/components/tugways/tug-text-card-editor.tsx`) builds its own
`EditorView`. So there is currently one markdown-formatting implementation (Text card)
and zero in the prompt entry. Hand-rolling markdown styling into the prompt entry would
create a second copy. Instead, this phase lifts the formatting into a shared,
substrate-level capability named `markdownTextStyling`, with the prompt entry as its
first consumer. When the Text card later migrates onto `TugTextEditor` (a separate,
explicitly out-of-scope effort), it adopts the same capability and deletes its bespoke
wiring.

#### Strategy {#strategy}

- Generalize the two already-modular pieces first: rename the text-card highlight-style
  variant in `language-registry.ts` to a neutral name, and move
  `list-hanging-indent.ts` from the text card's companion directory into the
  `TugTextEditor` substrate's companion directory (`tug-text-editor/`).
- Build one new module, `tug-text-editor/markdown-text-styling.ts`, that lazy-loads the
  markdown grammar **styling-only** (no bundled keymap, no URL-paste rewriting — see
  [P02]) and bundles grammar + highlight style + hanging indent into one extension set.
- Expose it on the substrate as a reactive `markdownTextStyling?: boolean` prop backed
  by a module-scope compartment, mirroring the substrate's existing `lineWrap` /
  `lineNumbers` prop pattern and the Text card's proven async-grammar-swap pattern.
- Adopt in `TugPromptEntry`, gated by route: on for the prose routes (`❯` Code, `?`
  btw), off for `$` Shell and `⌕` Find ([P05]).
- Unify the setting label: the Dev Card tab's "Line wrap" switch becomes "Soft wrap
  text", matching the Text Card tab ([P07]).
- Verify with a real app-test (`tests/app-test/`) driving the live Tug.app — no mock
  render tests.

#### Success Criteria (Measurable) {#success-criteria}

- Typing `# Heading`, `**bold**`, `*italic*`, and `` `code` `` into the Dev card's
  prompt entry (❯ route) paints the markdown tokens (bold heading in the keyword color,
  bold strong, italic emphasis, colored inline code) while every marker character
  remains visible in the document (assert via app-test `evalJS` on `.cm-content` spans
  and `doc.toString()`).
- With soft wrap on, a long markdown list line in the prompt entry carries the
  hanging-indent line decoration (`text-indent:-Nch;padding-left:Nch` on the `.cm-line`)
  so its wrapped continuation aligns under the item content (assert via app-test).
- Switching the prompt entry to the `$` Shell route removes markdown styling: the same
  text renders with no markdown token spans (assert via app-test).
- The excluded `markdownKeymap` never installs: on the `❯` route (Return = newline),
  typing `- item` then Return yields `"- item\n"`, not `"- item\n- "` — proving
  `insertNewlineContinueMarkup` is absent and Return semantics are unchanged ([P02]).
  Verified session-free (no submit route driven).
- The Text card's markdown styling and hanging indent behave exactly as before the
  refactor (imports moved, behavior identical).
- Settings card Dev Card tab shows "Soft wrap text" where it showed "Line wrap".
- `bunx vite build` succeeds (production rollup), `bun test` passes, `just app-test`
  passes.

#### Scope {#scope}

1. Rename the write-surface highlight style in `tugdeck/src/lib/language-registry.ts`
   to a substrate-neutral name; update its one consumer (the Text card).
2. Move `list-hanging-indent.ts` from `tugways/tug-text-card-editor/` to
   `tugways/tug-text-editor/`; update the Text card import and the module docstring.
3. New module `tugways/tug-text-editor/markdown-text-styling.ts` with a cached lazy
   loader for the styling-only markdown bundle.
4. New reactive `markdownTextStyling?: boolean` prop on `TugTextEditor`, backed by a
   new module-scope `markdownStylingCompartment`.
5. Gallery text-editor harness: a toggle row for the new prop (in-app manual
   verification surface).
6. `TugPromptEntry`: route-derived `markdownTextStyling` prop pass-through.
7. Settings label rename "Line wrap" → "Soft wrap text" (Dev Card tab), plus the same
   label row in the gallery text-editor harness.
8. One new app-test covering the prompt-entry styling end-to-end.

#### Non-goals (Explicitly out of scope) {#non-goals}

- Migrating `TugTextCardEditor` onto the `TugTextEditor` substrate. That is the
  follow-on this phase enables; the Text card keeps its own view and wiring, changed
  only where imports move.
- Anchor links (`{#slug}` / `[Q01]` ⌘-click navigation from
  `tug-text-card-editor/anchor-links.ts`) in the prompt entry — plan-doc-specific, not
  a prompt-composer affordance.
- Markdown *editing behaviors*: list continuation on Enter (`markdownKeymap`),
  `deleteMarkupBackward`, paste-URL-as-link. Deliberately excluded ([P02]); adopting
  any of them later is a follow-on with its own keymap-precedence design.
- Fenced-code-block sub-language highlighting (`codeLanguages` option) — the Text card
  doesn't configure it either; parity is the goal.
- Renaming the underlying settings key (`editorSettings.lineWrap`) or the substrate's
  `lineWrap` prop — only the user-facing label changes.

#### Dependencies / Prerequisites {#dependencies}

- `@codemirror/lang-markdown` is already a dependency, lazy-loaded by
  `language-registry.ts` (`LOADERS.md`).
- The app-test harness (`tests/app-test/_harness`, `just app-test`) with `evalJS`.

#### Constraints {#constraints}

- Tuglaws: [L02] external state via `useSyncExternalStore` only; [L06] appearance via
  CSS/DOM (CM6 decorations), never React state; [L07] substrate prop reactivity through
  refs read at fire time where extensions are read-once.
- `TugTextEditor`'s `extensions` prop is read-once-at-mount by contract — a reactive
  capability cannot ride it; it needs a compartment-backed prop (the existing house
  pattern).
- Vite production build must pass (`bunx vite build`) — dynamic-import chunking of
  `@codemirror/lang-markdown` must not regress the bundle.
- No plan-step numbers or bug-history in code comments.

#### Assumptions {#assumptions}

- The prompt editor font may be proportional (Settings offers "IBM Plex Sans" —
  `EDITOR_FONT_OPTIONS` in `settings-general-body.tsx`); the `ch`-unit hanging indent
  is accepted as an approximation there ([P06]).
- The gallery cards (`gallery-text-editor.tsx`, `gallery-prompt-entry.tsx`) are the
  in-app manual test surfaces for substrate features.

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

This plan uses explicit `{#anchor}` headings, stable labels (`[P01]`, `[Q01]`, `S01`,
`R01`), `**Depends on:**` lines with `#step-N` anchors, and rich `**References:**`
lines on every execution step. Never cite line numbers — cite anchors and symbols.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Should the btw (`?`) route get markdown styling? (DECIDED) {#q01-btw-route}

**Question:** The prompt entry has four routes (`❯` Code, `$` Shell, `?` btw, `⌕`
Find). Code is clearly markdown-destined prose; Shell and Find clearly are not. btw is
a side question — prose to Claude.

**Resolution:** DECIDED (see [P05]) — btw gets styling; it is prose to Claude, same as
Code. The gate is `route !== ROUTE_SHELL && route !== ROUTE_FIND`.

#### [Q02] Hanging indent under a proportional font (DECIDED) {#q02-proportional-font}

**Question:** `mdListHangingIndent` computes the indent in `ch` units, documented as
"reliable because the editor is monospace." The prompt editor's font is user-selectable
and includes IBM Plex Sans (proportional), where `1ch` = the width of `0`, so the
indent only approximates the marker width.

**Resolution:** DECIDED (see [P06]) — accept the `ch` approximation. Sub-character
misalignment under a proportional font is strictly better than no hanging indent, and
per-font marker measurement is complexity this feature doesn't earn. The module
docstring is updated to say so.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Markdown grammar interferes with prompt-entry key semantics | high | low (mitigated) | [P02]: load with `addKeymap: false` — verified the default bundles `Prec.high(keymap.of(markdownKeymap))` binding Enter/Backspace | Any report of Enter/Backspace misbehavior on a list line |
| `pasteURLAsLink` rewrites URL pastes over a selection | med | low (mitigated) | [P02]: `pasteURLAsLink: false`; the substrate's own `clipboardExtension` stays authoritative | — |
| Hanging indent visible artifacts with wrap off or proportional font | low | low | [P04] inertness analysis; [P06] accepted approximation; app-test covers wrap-on | Visual report from a Plex Sans user |
| Vite prod build breaks on new dynamic import | med | low | Same package already dynamically imported by `language-registry.ts`; checkpoint `bunx vite build` on every step | — |

**Risk R01: Keymap precedence collision** {#r01-keymap-collision}

- **Risk:** `markdown()`'s default bundle pushes `Prec.high(keymap.of(markdownKeymap))`
  (verified in `tugdeck/node_modules/@codemirror/lang-markdown/dist/index.js`,
  `addKeymap = true` default). `tugTextEditorKeymap`
  (`tugways/tug-text-editor/keymap.ts`) is also `Prec.high`; same precedence resolves
  by extension order, and the markdown compartment sits before the tug keymap in
  `buildExtensions` — so the bundled keymap would intercept Enter on list lines and
  break submit-on-Return.
- **Mitigation:** never install the bundled keymap: `markdown({ addKeymap: false,
  pasteURLAsLink: false, completeHTMLTags: false })` ([P02]).
- **Residual risk:** none for this phase; list-continuation-on-Enter is simply absent
  (a follow-on if wanted).

---

### Design Decisions {#design-decisions}

#### [P01] One capability, named `markdownTextStyling`, living in the substrate (DECIDED) {#p01-capability-home}

**Decision:** The shared bundle is a new module
`tugdeck/src/components/tugways/tug-text-editor/markdown-text-styling.ts`, surfaced on
`TugTextEditor` as a reactive `markdownTextStyling?: boolean` prop backed by a new
module-scope `markdownStylingCompartment` in `tug-text-editor.tsx`.

**Rationale:**
- The substrate's companion directory (`tug-text-editor/`) is where its extensions
  live (keymap.ts, theme.ts, atom-*.ts, …); the Text card already imports from it
  (`undo-menu-state-plugin`), so a future Text-card migration consumes it directly.
- The `extensions` prop is read-once-at-mount by contract; route-gating in the prompt
  entry needs runtime toggling → a compartment-backed prop, like `lineWrap`.
- Module-scope compartment identity is the substrate's established pattern (see the
  comment block above `placeholderCompartment` in `tug-text-editor.tsx`).

**Implications:**
- `buildExtensions` seeds `markdownStylingCompartment.of([])` alongside the other
  compartments (before the keymaps — placement is precedence-relevant only for the
  keymap we deliberately exclude).
- The mount effect kicks the initial async load when the prop is true at mount; a
  `useLayoutEffect` on the prop handles later flips (see #s01-substrate-contract).

#### [P02] Styling only — no bundled keymap, no paste rewriting, no HTML-tag completion (DECIDED) {#p02-styling-only}

**Decision:** The loader calls
`markdown({ addKeymap: false, pasteURLAsLink: false, completeHTMLTags: false })`.

**Rationale:**
- Verified in the installed `@codemirror/lang-markdown`: the defaults push
  `Prec.high(keymap.of(markdownKeymap))` (Enter → `insertNewlineContinueMarkup`,
  Backspace → `deleteMarkupBackward`) and a `pasteURLAsLink` DOM paste handler. The
  keymap would beat `tugTextEditorKeymap` by extension order at equal precedence and
  change Enter behavior on list lines (Risk R01); the paste handler would fight the
  substrate's `clipboardExtension`.
- The capability's charter is *visual*: "never remove visible markdown formatting, but
  subtly style fonts and colors." Editing behaviors are a different feature.
- The Text card keeps its full-default `markdown()` via `language-registry.ts` —
  unchanged behavior there (it wants Enter-continues-list).

**Implications:**
- Prompt entry gains no list-continuation on newline-insert. Recorded as a follow-on.

#### [P03] Rename `tugTextCardHighlightStyle` → `tugEditingHighlightStyle` (DECIDED) {#p03-highlight-rename}

**Decision:** The no-link-underline write-surface variant in
`tugdeck/src/lib/language-registry.ts` (`tugTextCardHighlightStyleInner` /
`tugTextCardHighlightStyle`) is renamed `tugEditingHighlightStyleInner` /
`tugEditingHighlightStyle` and shared by the Text card and the substrate bundle.

**Rationale:**
- Both editable surfaces want the same treatment: token colors from
  `tugHighlightSpecsBase`, links colored but not underlined (in the Text card the
  underline is reserved for the ⌘-hover anchor affordance; in the prompt entry an
  always-on underline is noise on a composer).
- The read-only variant `tugHighlightStyle` (underlined links) stays untouched for
  `TugCodeView` / diff snippets / static fragment tokenization.

**Implications:**
- One consumer updates: `tug-text-card-editor.tsx` imports and uses the new name in
  its `languageCompartment` reconfigure.

#### [P04] `mdListHangingIndent` moves to the substrate dir and rides the markdown compartment unconditionally (DECIDED) {#p04-hanging-indent-home}

**Decision:** `list-hanging-indent.ts` moves to
`tugways/tug-text-editor/list-hanging-indent.ts` (same symbol, updated docstring). In
the substrate's markdown bundle it is included **unconditionally** — not gated on
`lineWrap`. The Text card keeps its existing wrap-gated bundling (`lineWrapFor` in
`tug-text-card-editor.tsx`) unchanged, importing from the new path.

**Rationale:**
- The plugin is inert without the markdown grammar (it keys off `ListMark` syntax
  nodes, which don't exist without the language) and visually inert without wrap: the
  `text-indent:-Nch` / `padding-left:Nch` pair cancels exactly on a line's first (and,
  unwrapped, only) visual line.
- Unconditional inclusion avoids coupling two compartments (`lineWrapCompartment` ×
  `markdownStylingCompartment`) across the substrate's reconfigure effects.

**Implications:**
- No change to the substrate's `lineWrapCompartment` or its reconfigure effect.
- The docstring's "reliable because the editor is monospace" claim is revised per [P06].

#### [P05] Prompt entry gates styling by route: prose routes only (DECIDED) {#p05-route-gate}

**Decision:** `TugPromptEntry` passes
`markdownTextStyling={route !== ROUTE_SHELL && route !== ROUTE_FIND}` — on for `❯`
(Code) and `?` (btw), off for `$` (Shell) and `⌕` (Find).

**Rationale:**
- A shell command is not markdown: `# comment` would paint as a bold heading, `*.rs`
  globs as emphasis. A find query is a literal.
- `route` is already React state in `TugPromptEntry` via
  `useSyncExternalStore(routeLifecycle.subscribe, routeLifecycle.getRoute)` ([L02]) —
  the prop flip is a plain render-time derivation, no new state.

**Implications:**
- The substrate prop must reconfigure live on route switch (satisfied by [P01]).

#### [P06] `ch`-unit hanging indent accepted under proportional fonts (DECIDED) {#p06-ch-approximation}

**Decision:** Keep the `ch`-based indent math as-is. Under IBM Plex Sans the indent
approximates (rather than exactly matches) the marker width; that is accepted.

**Rationale:**
- The wrapped continuation still lands visually "under the content, not the margin" —
  the feature's whole point — with at most sub-character drift.
- Per-font marker measurement (canvas metrics or probe spans) is real complexity for a
  marginal correction on a non-default font.

**Implications:**
- Update the module docstring: monospace → exact; proportional → approximate by design.

#### [P07] Unify the soft-wrap label as "Soft wrap text" (DECIDED) {#p07-label-unify}

**Decision:** The Settings card Dev Card tab's `TugSwitch label="Line wrap"`
(`tugways/cards/settings-general-body.tsx`, Prompt Editor group) becomes
`label="Soft wrap text"`, matching the Text Card tab
(`tugways/cards/text-card-controls.tsx`, `label="Soft wrap text"`). The gallery
harness's "Line wrap" row label (`tugways/cards/gallery-text-editor.tsx`) is renamed
identically. No settings keys, props, or stored values change.

**Rationale:** Same option, same words — the label divergence is exactly the kind of
two-implementations drift this phase exists to smooth out.

---

### Deep Dives {#deep-dives}

#### Current wiring map (verified) {#wiring-map}

- **Substrate** (`tugways/tug-text-editor.tsx`): module-scope compartments
  (`placeholderCompartment`, `lineWrapCompartment`, `lineNumbersCompartment`,
  `activeLineGutterCompartment`, `readOnlyCompartment`, `typographyRevCompartment`);
  the full extension list is assembled in the free function `buildExtensions(...)`,
  which seeds each compartment from an `initial` snapshot; host extensions arrive via
  the read-once `extensions` prop; per-prop `useLayoutEffect`s dispatch
  `compartment.reconfigure(...)` (see the `lineWrap` effect, which piggybacks a
  `typographyRevCompartment` refresh for geometry-affecting toggles — markdown styling
  does not need that piggyback: token styling doesn't change the line grid, and the
  hanging indent's geometry is handled by CM6's own decoration measure pass).
- **Prompt entry** (`tugways/tug-prompt-entry.tsx`): renders `<TugTextEditor ...>` with
  `lineWrap` / `lineNumbers` / `highlightActiveLineGutter` forwarded from the Dev
  card's editor settings; host `editorExtensions` (a `useMemo([])`) carry only two
  update listeners and an Escape keymap — no language, no highlight style. Route
  constants: `DEFAULT_ROUTE = "❯"`, `ROUTE_SHELL = "$"`, `ROUTE_BTW = "?"`,
  `ROUTE_FIND = "⌕"`; the live route is React state via `useSyncExternalStore`.
- **Text card** (`tugways/tug-text-card-editor.tsx`): own `EditorView`; its
  `languageCompartment` effect resolves `languageForExtension(ext)` async with an
  `alive` stale-guard, then reconfigures to `[language, tugTextCardHighlightStyle]`;
  its `lineWrapFor(settings)` bundles `[EditorView.lineWrapping, mdListHangingIndent]`
  into its own `lineWrapCompartment` when soft wrap is on.
- **Registry** (`src/lib/language-registry.ts`): `tugHighlightSpecsBase` (shared
  Lezer-tag → CSS-var specs incl. `heading`/`emphasis`/`strong`/`monospace`),
  `tugHighlightStyle` (read-only variant, underlined links),
  `tugTextCardHighlightStyle` (write-surface variant, no underline — renamed by
  [P03]); `LOADERS.md` lazy-imports `@codemirror/lang-markdown` and calls `markdown()`
  with defaults.

#### `markdown()` bundling facts (verified in node_modules) {#lang-markdown-facts}

From `tugdeck/node_modules/@codemirror/lang-markdown/dist/index.js`:
- Config defaults: `addKeymap = true`, `pasteURLAsLink = true`,
  `completeHTMLTags = true`, base `commonmarkLanguage`.
- `addKeymap` pushes `Prec.high(keymap.of(markdownKeymap))`; `markdownKeymap` binds
  `Enter → insertNewlineContinueMarkup` and `Backspace → deleteMarkupBackward`.
- `pasteURLAsLink` is an `EditorView.domEventHandlers({ paste })` extension.

These are the concrete grounds for [P02]. `completeHTMLTags: false` is belt-and-
suspenders: the substrate uses its own typeahead (`tugCompletionExt`), not
`@codemirror/autocomplete`, so the completion source would be inert anyway — excluded
to keep the bundle minimal.

#### Effect ordering at mount {#mount-ordering}

In `tug-text-editor.tsx` the existing per-prop reconfigure effects (`lineWrap`,
`lineNumbers`, …) are declared **before** the mount `useLayoutEffect` that constructs
the view. On first render those effects see `viewRef.current === null` and no-op; the
mount effect then builds the view from `initial` values read out of refs. Those props
carry a matching `initial.*` field into `buildExtensions`, so their compartment is
seeded correct at construction and the pre-mount no-op is harmless.

`markdownTextStyling` is different in one way — its "enable" is **async** (the grammar
chunk lazy-loads), so there is no synchronous value to seed the compartment with at
construction. That tempts a two-path design (kick the load from the mount effect when
the prop reads true; handle later flips in a prop effect). **Do not do that** — two
paths reintroduce a race: a mount-kicked load that resolves *after* the user has flipped
to `$` (disable) would re-dispatch the bundle and strand styling on the shell route,
and a mount-path `alive` flag can't serialize against the prop effect's flag.

Instead, use **one** `useLayoutEffect([markdownTextStyling])` declared **after** the
mount effect in the component body (so `viewRef.current` is already live on its first
run — the compartment is seeded `.of([])` by `buildExtensions`, and this single effect
owns every enable *and* disable transition, mount included):

- On run with `markdownTextStyling === true`: set a local `alive = true`; call
  `loadMarkdownTextStyling()`; in `.then`, bail if `!alive` or `viewRef.current ===
  null` **or** `markdownTextStylingRef.current === false` (re-read the ref at fire time
  per [L07] — the last guard is what defeats the flip-to-shell-during-load race even
  though the effect cleanup already flips `alive`); else dispatch
  `markdownStylingCompartment.reconfigure(bundle)`.
- On run with `markdownTextStyling === false`: dispatch
  `markdownStylingCompartment.reconfigure([])` synchronously (no-op if already empty).
- Cleanup sets `alive = false`, so a superseded load never lands.

This mirrors the Text card's language effect (`alive` flag + `viewRef` null-guard) but
adds the ref re-check, because the Text card's compartment isn't toggled *off* by a
sibling gesture mid-load the way the route-gated prompt entry's is.

---

### Specification {#specification}

**Spec S01: Substrate contract** {#s01-substrate-contract}

- New prop on `TugTextEditorProps`: `markdownTextStyling?: boolean` (default
  `false`/undefined). Reactive: flipping it reconfigures live, like `lineWrap`.
- New module-scope compartment in `tug-text-editor.tsx`:
  `markdownStylingCompartment`, seeded `.of([])` in `buildExtensions` alongside the
  other compartments. It carries **no** `initial.*` field — unlike `lineWrap` etc., its
  enable is async, so there is nothing to seed synchronously; it always starts empty and
  the single effect below fills it.
- New ref `markdownTextStylingRef` tracking the prop (same pattern as `lineWrapRef`),
  read at async-fire time.
- A **single** `useLayoutEffect([markdownTextStyling])` declared **after** the mount
  effect owns every transition (mount included — no separate mount-kick path):
  - Enable (`=== true`): `alive = true`; `loadMarkdownTextStyling()`; in `.then`, bail
    if `!alive || viewRef.current === null || markdownTextStylingRef.current === false`;
    else `markdownStylingCompartment.reconfigure(bundle)`.
  - Disable (`=== false`): `markdownStylingCompartment.reconfigure([])` synchronously.
  - Cleanup: `alive = false`.
  - The `markdownTextStylingRef.current === false` guard is load-bearing: it defeats the
    flip-to-shell-during-load race ([L07] — read current state through the ref at fire
    time). See #mount-ordering for the full rationale.
- No `typographyRevCompartment` piggyback (see #wiring-map).

**Spec S02: `markdown-text-styling.ts` module** {#s02-module}

- Path: `tugdeck/src/components/tugways/tug-text-editor/markdown-text-styling.ts`.
- Exports `loadMarkdownTextStyling(): Promise<Extension>` — a module-level cached
  promise (single import + single `markdown(...)` instantiation per app lifetime):
  `import("@codemirror/lang-markdown")` →
  `m.markdown({ addKeymap: false, pasteURLAsLink: false, completeHTMLTags: false })`.
- Resolved bundle: `[languageSupport, tugEditingHighlightStyle, mdListHangingIndent]`
  (highlight style imported from `@/lib/language-registry`; hanging indent from the
  sibling `./list-hanging-indent`).
- Raw markdown syntax is never hidden or removed — this is styling only.

#### State Zone Mapping (tugdeck/tugways plans) {#state-zone-mapping}

| State | Zone (appearance / local-data / structure) | Mechanism | Law |
|-------|--------------------------------------------|-----------|-----|
| Markdown token styling + hanging indent | appearance | CM6 decorations / HighlightStyle via compartment (DOM, never React state) | [L06] |
| Prompt-entry route → styling flag | derived from existing store | `useSyncExternalStore(routeLifecycle...)` (already present) → prop | [L02] |
| Grammar loaded/not-loaded | CM6 config | single post-mount `useLayoutEffect`; compartment reconfigure with `alive` + `viewRef` + `markdownTextStylingRef` guards | [L07] |

No new persistent state; no storage; no new stores.

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tugdeck/src/components/tugways/tug-text-editor/markdown-text-styling.ts` | Cached lazy loader for the styling-only markdown bundle (Spec S02) |
| `tugdeck/src/components/tugways/tug-text-editor/list-hanging-indent.ts` | Moved from `tug-text-card-editor/` (same symbol `mdListHangingIndent`) |
| `tests/app-test/atNNNN-prompt-markdown-styling.test.ts` | App-test (next free at-number at authoring time; `at0228` was highest when planned) |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `tugEditingHighlightStyle` (+`...Inner`) | const rename | `tugdeck/src/lib/language-registry.ts` | was `tugTextCardHighlightStyle`; docstring generalized ([P03]) |
| `loadMarkdownTextStyling` | fn (new) | `tug-text-editor/markdown-text-styling.ts` | Spec S02 |
| `markdownStylingCompartment` | const (new) | `tugways/tug-text-editor.tsx` | module scope, with the other compartments |
| `markdownTextStyling` | prop (new) | `TugTextEditorProps`, `tugways/tug-text-editor.tsx` | reactive; Spec S01; owned by one post-mount `useLayoutEffect` (no `initial.*` seed) |
| `markdownTextStylingRef` | ref (new) | `tugways/tug-text-editor.tsx` | prop mirror; re-read at async-load fire time to defeat the flip-during-load race ([L07]) |
| `TugPromptEntry` render | modify | `tugways/tug-prompt-entry.tsx` | pass route-gated prop ([P05]) |
| `TugSwitch label` | modify | `tugways/cards/settings-general-body.tsx` | "Line wrap" → "Soft wrap text" ([P07]) |
| gallery rows | modify | `tugways/cards/gallery-text-editor.tsx` | label rename + new `markdownTextStyling` toggle row |
| `lineWrapFor` import | modify | `tugways/tug-text-card-editor.tsx` | import `mdListHangingIndent` from new path; use `tugEditingHighlightStyle` |

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **App-test (real app)** | Drive the live Tug.app; assert real DOM via `evalJS` | The styling end-to-end: token spans, hanging-indent decoration, route gating |
| **Build gates** | `bunx vite build`, `bun test` | Every step checkpoint (prod-bundle import safety per repo policy) |

App-test sketch: type markdown into the Dev/gallery prompt entry, poll (with the
harness's settle helpers) for the lazily-loaded grammar to land, then `evalJS` over
`[data-slot="tug-text-editor"] .cm-content` — assert a `**bold**` span computes
`font-weight: 700`, a heading span has the keyword color, the raw marker characters are
present in `view/state` text, and a long list line's `.cm-line` style contains
`text-indent:-` when soft wrap is on. Switch route (⇧⌘S dispatches `SELECT_ROUTE` to
the entry's responder, per `keybinding-map.ts`) and assert the styled spans are gone.

#### What stays out of tests {#test-non-goals}

- jsdom / mock render tests — banned repo-wide; the app-test drives the real app.
- Unit tests of CM6 internals (compartment mechanics, HighlightStyle output) — covered
  by the end-to-end DOM assertions; brittle at the unit layer.
- Screenshot pixel comparison — the DOM/computed-style assertions are stabler.

---

### Execution Steps {#execution-steps}

> **Commit after all checkpoints pass.** Commits land per the repo git policy (user
> commits, or the implement skill's dash-worktree flow).

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Generalize the shared pieces (rename + move) | done | d7245c799 |
| #step-2 | markdown-text-styling module + substrate prop + gallery toggle | done | 29b11be55 |
| #step-3 | Prompt entry adopts, route-gated | done | d71a5e252 |
| #step-4 | Unify the soft-wrap label | done | e5a659aa1 |
| #step-5 | App-test: prompt-entry markdown styling | done | c002e7091 |
| #step-6 | Integration checkpoint | done | — (verification only) |

#### Step 1: Generalize the shared pieces (rename + move) {#step-1}

**Commit:** `tugdeck: generalize editing highlight style and list hanging indent`

**References:** [P03] highlight rename, [P04] hanging-indent home, [P06] ch
approximation, (#wiring-map)

**Artifacts:**
- `tugways/tug-text-editor/list-hanging-indent.ts` (moved; docstring updated)
- Renamed exports in `src/lib/language-registry.ts`

**Tasks:**
- [ ] In `src/lib/language-registry.ts`, rename `tugTextCardHighlightStyleInner` →
      `tugEditingHighlightStyleInner` and `tugTextCardHighlightStyle` →
      `tugEditingHighlightStyle`; generalize the docstring (write-surface variant, no
      default link underline; used by the Text card editor and the `TugTextEditor`
      markdown styling bundle — in the Text card the underline stays reserved for the
      ⌘-hover anchor affordance).
- [ ] `git mv tugdeck/src/components/tugways/tug-text-card-editor/list-hanging-indent.ts
      tugdeck/src/components/tugways/tug-text-editor/list-hanging-indent.ts`; update
      the module docstring: module path; scope no longer text-card-only; monospace →
      exact indent, proportional fonts → `ch` approximation by design ([P06]).
- [ ] Update `tugways/tug-text-card-editor.tsx`: import `mdListHangingIndent` from
      `./tug-text-editor/list-hanging-indent`; import/use `tugEditingHighlightStyle`
      in the `languageCompartment` reconfigure. No behavior change.

**Tests:**
- [ ] Existing suites only (pure move/rename).

**Checkpoint:**
- [ ] `cd tugdeck && bun test`
- [ ] `cd tugdeck && bunx vite build`
- [ ] Text card manual sanity in-app: markdown file still shows token colors and
      wrap-on hanging indent (HMR is live).

---

#### Step 2: markdown-text-styling module + substrate prop + gallery toggle {#step-2}

**Depends on:** #step-1

**Commit:** `tugdeck: markdownTextStyling capability on TugTextEditor`

**References:** [P01] capability home, [P02] styling only, Spec S01, Spec S02,
Risk R01, (#lang-markdown-facts, #mount-ordering, #state-zone-mapping)

**Artifacts:**
- `tugways/tug-text-editor/markdown-text-styling.ts`
- `markdownTextStyling` prop + `markdownStylingCompartment` in
  `tugways/tug-text-editor.tsx`
- Gallery toggle row in `tugways/cards/gallery-text-editor.tsx`

**Tasks:**
- [ ] Author `markdown-text-styling.ts` per Spec S02 (cached promise; `markdown({
      addKeymap: false, pasteURLAsLink: false, completeHTMLTags: false })`; bundle
      `[support, tugEditingHighlightStyle, mdListHangingIndent]`).
- [ ] In `tug-text-editor.tsx`: declare `markdownStylingCompartment` with the other
      module-scope compartments; seed `.of([])` in `buildExtensions` (no `initial.*`
      field — it always starts empty); add the `markdownTextStyling` prop and a
      `markdownTextStylingRef` (matching the existing `lineWrapRef` pattern). Add a
      **single** `useLayoutEffect([markdownTextStyling])` declared **after** the mount
      effect (so it owns mount and every later flip — no separate mount-kick path),
      implementing Spec S01's enable/disable transitions with the `alive` + `viewRef` +
      `markdownTextStylingRef.current` guards (#mount-ordering).
- [ ] In `gallery-text-editor.tsx`: add a "Markdown styling" toggle row (pattern-match
      the existing "Line wrap" row) wired to the new prop, so the substrate feature is
      exercisable in isolation in the gallery.

**Tests:**
- [ ] Manual in gallery: toggle on → type `# h`, `**b**`, `` `c` `` → styled with
      markers visible; long `- ` list line with wrap on → continuation aligns; toggle
      off → plain.

**Checkpoint:**
- [ ] `cd tugdeck && bun test`
- [ ] `cd tugdeck && bunx vite build` (new dynamic import must survive the rollup)
- [ ] Gallery manual pass above.

---

#### Step 3: Prompt entry adopts, route-gated {#step-3}

**Depends on:** #step-2

**Commit:** `tugdeck: markdown text styling in the prompt entry (prose routes)`

**References:** [P05] route gate, [Q01] btw route, Spec S01, (#wiring-map)

**Artifacts:**
- `tugways/tug-prompt-entry.tsx` passes the route-gated prop.

**Tasks:**
- [ ] In `TugPromptEntry`'s render, pass
      `markdownTextStyling={route !== ROUTE_SHELL && route !== ROUTE_FIND}` on the
      `<TugTextEditor>` (the `route` `useSyncExternalStore` value already exists).

**Tests:**
- [ ] Manual in Dev card: ❯ route styles markdown; switch to `$` (⇧⌘S) → same text
      plain; back to ❯ → styled again; `?` route styled. Return/Enter submit semantics
      unchanged on every route, including with the caret on a list line.

**Checkpoint:**
- [ ] `cd tugdeck && bun test`
- [ ] `cd tugdeck && bunx vite build`
- [ ] Manual route-flip pass above.

---

#### Step 4: Unify the soft-wrap label {#step-4}

**Depends on:** #step-1

**Commit:** `tugdeck: "Soft wrap text" label everywhere soft wrap is offered`

**References:** [P07] label unify

**Artifacts:**
- Label strings in `tugways/cards/settings-general-body.tsx` and
  `tugways/cards/gallery-text-editor.tsx`.

**Tasks:**
- [ ] `settings-general-body.tsx` (Prompt Editor group): `TugSwitch label="Line wrap"`
      → `label="Soft wrap text"`. Keys/props/stored values unchanged.
- [ ] `gallery-text-editor.tsx`: the "Line wrap" row label → "Soft wrap text".

**Tests:**
- [ ] Manual: Settings ▸ Dev Card shows "Soft wrap text"; toggle still drives the
      prompt editor's wrap.

**Checkpoint:**
- [ ] `cd tugdeck && bunx vite build`
- [ ] Manual label check above.

---

#### Step 5: App-test — prompt-entry markdown styling {#step-5}

**Depends on:** #step-3

**Commit:** `app-test: prompt-entry markdown text styling (atNNNN)`

**References:** [P02] styling only, [P05] route gate, (#test-plan-concepts,
#success-criteria)

**Artifacts:**
- `tests/app-test/atNNNN-prompt-markdown-styling.test.ts` (claim the next free
  at-number; `at0228` was the highest at planning time).

**Tasks:**
- [ ] Author the test per #test-plan-concepts: type markdown into the prompt entry;
      settle-poll until a markdown token span appears (grammar lazy-load); assert
      token computed styles + raw markers preserved; assert the hanging-indent
      `.cm-line` inline style on a wrapped list line (soft wrap on); switch to the `$`
      route and assert no markdown token spans.
- [ ] Assert the keymap is absent ([P02]) **without a live Claude session**: on the
      `❯` route (where Return = newline, so the keystroke stays local), type `- item`,
      press Return, and assert `view.state.doc.toString() === "- item\n"` — **not**
      `"- item\n- "`. That directly proves `insertNewlineContinueMarkup` (from the
      excluded `markdownKeymap`) is not installed. Do NOT drive a submit route for this
      (that dispatches a real turn/side-question — real-claude paths are on-demand only).
      Reuse the harness patterns from `at0024-prompt-state-roundtrip.test.ts`
      (`PROMPT_INPUT_SELECTOR`, `evalJS`, gating on `TUGAPP_APP_TEST=1`). Keep it fast
      and exiting.

**Tests:**
- [ ] The new app-test itself.

**Checkpoint:**
- [ ] `just app-test` (green, including the new test)

---

#### Step 6: Integration Checkpoint {#step-6}

**Depends on:** #step-2, #step-3, #step-4, #step-5

**Commit:** `N/A (verification only)`

**References:** (#success-criteria, #exit-criteria)

**Tasks:**
- [ ] Walk every Success Criteria bullet against the live app and the test runs.

**Tests:**
- [ ] Full aggregate run.

**Checkpoint:**
- [ ] `cd tugdeck && bun test`
- [ ] `cd tugdeck && bunx vite build`
- [ ] `just app-test`

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** One shared `markdownTextStyling` capability on the `TugTextEditor`
substrate — light markdown token styling (syntax always visible) plus soft-wrap list
hanging indent — live in the Dev card's prompt entry on the prose routes, sharing its
pieces with the Text card, with the soft-wrap setting labeled "Soft wrap text"
everywhere.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] Prompt entry (❯/? routes) styles markdown per #success-criteria; $/⌕ routes stay
      plain (app-test + manual).
- [ ] No second implementation: the Text card and the substrate share
      `tugEditingHighlightStyle` and `mdListHangingIndent` from single homes
      (grep: no remaining `tugTextCardHighlightStyle`, no
      `tug-text-card-editor/list-hanging-indent`).
- [ ] Enter/Backspace/paste semantics unchanged in the prompt entry (no
      `markdownKeymap`, no `pasteURLAsLink`).
- [ ] "Soft wrap text" label in both Settings tabs.
- [ ] `bun test`, `bunx vite build`, `just app-test` all green.

**Acceptance tests:**
- [ ] `tests/app-test/atNNNN-prompt-markdown-styling.test.ts`

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] Migrate `TugTextCardEditor` onto the `TugTextEditor` substrate; the Text card
      then consumes `markdownTextStyling` and deletes its bespoke language/highlight
      wiring (`languageCompartment` + `lineWrapFor` bundling).
- [ ] Consider opt-in markdown *editing* behaviors (list continuation on
      newline-insert) with a proper precedence design vs `tugTextEditorKeymap`.
- [ ] Anchor-link affordance generalization (text-card-only today; deliberately
      excluded here).

| Checkpoint | Verification |
|------------|--------------|
| Styling live in prompt entry | app-test atNNNN + manual ❯/$ flip |
| One shared implementation | grep for old symbol/paths returns nothing |
| Build health | `bun test`, `bunx vite build`, `just app-test` |
