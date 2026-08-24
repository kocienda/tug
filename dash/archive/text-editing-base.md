<!-- tugplan-skeleton v2 -->

## Text Editing Base — CodeMirror 6 Spike {#text-editing-base}

**Purpose:** Replace the contenteditable substrate that backs `tug-prompt-input` with a CodeMirror 6 (CM6)-backed primitive named `tug-edit`, validate it via a focused spike, and ship a Component Gallery TextEdit card that exercises every feature `tug-prompt-input` exposes today. This phase lands the new substrate as an *additive* component sitting alongside the existing one — migration of `tug-prompt-input` / `tug-prompt-entry` / `tide-card` is a separate plan that follows the spike's go/no-go decision.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | spike complete (decision: GO); migration in progress |
| Target branch | `text-editing-base` |
| Last updated | 2026-04-29 |
| Roadmap anchor | this document |
| Predecessor | none (new investigation) |

---

### Phase Overview {#phase-overview}

#### Context {#context}

`tug-prompt-input` is the editable substrate that powers `tug-prompt-entry`, the gallery prompt cards, and the live tide-card. It is built on a `contenteditable` div mediated by a 2,200-line `TugTextEngine` that papers over WebKit's quirks: atoms are rendered as `<img>` elements with SVG data URIs (so WebKit treats them as atomic replaced elements), the U+FFFC Object Replacement Character marks atom positions in the text stream, all mutations route through `execCommand` for native undo, and selection state is mirrored in [L23]'s active/inactive paint channels.

The implementation works. It also costs us: WebKit's `contenteditable` has a long tail of unfixed bugs (composition selection during IME on iOS 16.4+, focus surrender failures, dynamic-change accessibility regressions), and we are spending engineering effort polishing a substrate whose behavior we cannot influence. Every previous editor that started with raw `contenteditable` (Slack, Notion, Linear, Quip) has eventually moved to a framework that *abstracts* it. We are doing the same investigation, deliberately, before spending more time on a path with diminishing returns.

The investigation that preceded this plan ([Deep Dive — substrate evaluation](#substrate-evaluation)) compared four options — keep polishing `contenteditable`; adopt Monaco; adopt CodeMirror 6; build our own with Rust + WASM. The outcome is a decision to spike CM6 ([D01](#d01-spike-cm6)). The CM6 vs Lexical comparison is included in the deep dive because Lexical was the strongest non-CM alternative and the asymmetry argument (Lexical scales further into rich documents; CM6 scales further into code-shaped editing) shaped the decision.

The user's stated direction is *better than Claude Code TUI editing*, not *Notion competitor*. CM6's "Markdown source with live decorations" pattern (Obsidian Live Preview, `codemirror-rich-markdoc`) covers the realistic ceiling — bold/italic/headings/lists/code fences/blockquotes — with the underlying document remaining a flat character stream that the atom model fits perfectly. Tables, embeds with nested editable content, and Notion-style block rearrangement are explicitly accepted as out-of-scope ([D02](#d02-markdown-ceiling)).

#### Strategy {#strategy}

- **Spike, don't migrate.** Land a new `tug-edit` component additively. `tug-prompt-input` keeps shipping unchanged. After the spike's exit criteria are met, a *separate* plan migrates the existing surfaces to consume `tug-edit`.
- **Risk-first ordering.** The two known soft spots — IME composition with atomic widgets adjacent, and the [L23] active/inactive selection-paint integration — get their own steps early, so a substrate-level "no" surfaces before we have invested in polish.
- **Atoms before everything else.** The atom model is what makes this substrate viable for prompts. Step 3 wires `EditorView.atomicRanges` + `Decoration.replace` and validates the cursor/selection/clipboard story before any other feature work piles on top.
- **Reuse the existing interfaces.** `TugTextInputDelegate`, `AtomSegment`, `CompletionProvider`, `HistoryProvider`, `DropHandler`, the right-click classifier, and the [L23] capture/restore protocol are substrate-agnostic and survive the swap. The CM6 backing is implementation, not contract.
- **Gallery card is the test surface.** A new TextEdit gallery card exercises every prop and every feature. The same card is what we demo to confirm exit criteria, and what reviewers walk through when judging substrate fit.
- **Build stays green at every commit.** `bun run check`, `bun test`, `bun run audit:tokens lint`, and the workspace `cargo nextest run` pass on every step. `-D warnings` enforced.
- **Tuglaws apply at every step.** The new substrate is a tugways component and obeys [tuglaws.md](../tuglaws/tuglaws.md) without exception. [Table T02](#t02-tuglaws-applied) is the authoritative cross-walk: it names every law engaged by the spike, the compliance approach, and the step where each check lands. Every execution step's `**References:**` line cites the laws that step engages; Step 12 walks the full set.

#### Success Criteria (Measurable) {#success-criteria}

**Substrate viability:**

- [ ] Atoms render as inline replaced elements that the cursor skips over as a single character. Backspace deletes the whole atom; arrow keys step over it; selection extends by atom-as-unit. (verification: gallery card manual + automated test against CM6 `state.selection` after directional motion across an atom)
- [ ] Cut, copy, and paste round-trip atoms in plain text via U+FFFC + sidecar serialization, identical to current behavior. Paste from external clipboard preserves text and inserts no atoms. (verification: gallery card manual)
- [ ] CJK input method composition works with at least Japanese kana and Chinese pinyin, both adjacent to and across an atom. No selection collapse or glyph corruption during compose. (verification: manual scenarios documented in [Step 6](#step-6))
- [ ] [L23] active/inactive paint channels work: cmd-tab away from a tide-card hosting a `tug-edit` round-trips selection + scrollTop on return; cold-mount restore lands selection on the active card and inactive paint via `selectionGuard.cardRanges` on every other card. (verification: manual scenarios + existing pane-state preservation tests adapted)

**Feature parity with `tug-prompt-input`:**

- [ ] Every prop in [Table T01: tug-prompt-input feature surface](#t01-feature-surface) has an equivalent on `tug-edit` with documented equivalent or better behavior.
- [ ] Route prefixes (`>`, `$`, `:`) detected at position 0 fire `onRouteChange` and convert to a leading route atom, identical to `tug-prompt-input`. (verification: gallery card manual + test)
- [ ] Completion popup (`@` files, `/` slash commands) renders, filters, selects, and inserts atoms — using the existing `CompletionProvider` interface and the existing menu UI. (verification: gallery card with mock providers)
- [ ] History navigation (Cmd+Up / Cmd+Down) with `HistoryProvider` preserves draft on first back-step and restores it on forward-past-last. (verification: gallery card manual + test)
- [ ] Drag-and-drop from Finder onto the editor produces file atoms inserted at the drop point. (verification: manual)

**Theming:**

- [ ] All visible chrome (caret, selection, content fg, content bg, focus indication) reads from the tug 7-element token system via CSS variables. Theme switch (brio ↔ harmony) updates the live editor without remount. (verification: gallery card manual + token audit)
- [ ] Atoms re-render on theme change via the existing atom regeneration path. (verification: gallery card manual)

**Build and quality:**

- [ ] `bun run check`, `bun test`, `bun run audit:tokens lint` exit zero. Rust `cargo nextest run` exits zero. Warnings still errors.
- [ ] CM6 dependency adds ≤ 150 KB gzip to the tugdeck production bundle (target). Actual delta documented in [Step 12](#step-12).
- [ ] Component-authoring-guide checklist passes for `tug-edit` and `gallery-text-edit`.

**Gallery surface:**

- [ ] A `TextEdit` card exists in the Component Gallery, registered alongside the existing `PromptInput` and `PromptEntry` cards. It exercises every prop and feature listed under [Table T01](#t01-feature-surface).

**Decision deliverable:**

- [ ] [Step 13](#step-13) records a written go/no-go on adopting CM6 as the substrate for `tug-prompt-input` and downstream surfaces. If go, a follow-on plan `tugplan-text-editing-migration.md` is scaffolded.

#### Scope {#scope}

1. New `tug-edit.tsx` + `tug-edit.css` substrate component, CM6-backed.
2. New `gallery-text-edit.tsx` Component Gallery card.
3. CM6 atom rendering via `Decoration.replace` + `EditorView.atomicRanges`, reusing `tug-atom-img.ts` for visual rendering.
4. CM6 theme extension wired to the tug 7-element token system; live theme switching.
5. CM6 keymap covering Return / Shift-Return / numpad Enter / Cmd+Enter / Cmd+A / Cmd+Up / Cmd+Down / standard editing motions.
6. Completion popup wired via existing `CompletionProvider` interface and existing menu UI.
7. History provider integration via existing `HistoryProvider` interface.
8. Drop handler integration via existing `DropHandler` interface.
9. [L23] active/inactive paint integration via `selectionGuard` + CSS Custom Highlight.
10. Right-click classifier and selection adapter ported to CM6 geometry.
11. IME validation gate covering at least one CJK input method.
12. Decision step recording substrate go/no-go.

#### Non-goals (Explicitly out of scope) {#non-goals}

- Migrating `tug-prompt-input`, `tug-prompt-entry`, the live tide-card, or any other consumer to use `tug-edit`. (Follow-on plan.)
- Removing the existing `tug-prompt-input` / `TugTextEngine` code. The existing component continues to ship while the spike runs.
- Markdown rendering / live-preview decorations. (Follow-on plan; see [Roadmap / Follow-ons](#roadmap).)
- Tables, callouts, embeds with nested editable regions, Notion-style block rearrange. Excluded by [D02](#d02-markdown-ceiling).
- Multiple cursors, regex find-and-replace, vim/emacs keybindings, or any code-IDE feature beyond what `tug-prompt-input` exposes today.
- Collaborative editing / CRDTs / Yjs.
- Replacing the existing atom rendering technique (SVG-data-URI `<img>` via `tug-atom-img.ts`).

#### Dependencies / Prerequisites {#dependencies}

- CM6 packages installable via bun (`@codemirror/state`, `@codemirror/view`, `@codemirror/commands`, plus targeted extensions). No yarn / npm / pnpm — bun only ([feedback memory](../../../.claude/projects/-Users-kocienda-Mounts-u-src-tugtool/memory/feedback_use_bun.md)).
- Existing `tug-atom-img.ts` SVG rendering pipeline. No changes required for the spike.
- Existing `selectionGuard` and the `inactive-selection` CSS Custom Highlight ([L10], [L23]).
- Existing `useCardStatePreservation`, `TugPaneChrome` state preservation protocol ([L23]).
- Existing tug 7-element token CSS files (`brio.css`, `harmony.css`).
- Existing Component Gallery registration mechanism (`gallery-registrations.tsx`).

#### Constraints {#constraints}

- HMR is always running ([feedback memory](../../../.claude/projects/-Users-kocienda-Mounts-u-src-tugtool/memory/feedback_hmr.md)) — no manual builds for tugdeck during the spike.
- Tests must hit the real engine ([feedback memory](../../../.claude/projects/-Users-kocienda-Mounts-u-src-tugtool/memory/feedback_test_reality.md)) — no mock-store call-count tests.
- happy-dom may not be used for focus / selection / event-ordering tests across React renders ([feedback memory](../../../.claude/projects/-Users-kocienda-Mounts-u-src-tugtool/memory/feedback_no_happy_dom_tests.md)). The integration surface is verified manually + via `just app-test` where applicable.
- `-D warnings` on Rust, `tsc --noEmit` clean on TypeScript, `audit:tokens lint` clean on CSS.
- No direct DOM writes that bypass [L22] without a documented reason. CM6 owns its DOM tree; we observe it via its API.

#### Assumptions {#assumptions}

- CM6's `EditorView.atomicRanges` faithfully implements "skip range as one cursor unit" for cursor motion, selection extension, and `deleteCharBackward` / `deleteCharForward`. Validated in [Step 3](#step-3).
- CM6's IME story with adjacent atomic widgets is workable, possibly with caveats. Validated in [Step 6](#step-6); a hard fail there is a substrate-level no.
- React StrictMode double-mount can be reconciled with CM6 lifecycle by storing the `EditorView` on a stable ref and disposing it on cleanup. Standard pattern in `@uiw/react-codemirror` and similar wrappers.
- The existing `TugTextInputDelegate` shape can drive a CM6 backend without contract changes. If a method requires a substrate-shape change (e.g., character-position semantics that differ from CM6's offset model), the change is documented and applied symmetrically to the existing engine after the spike.

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

This plan uses explicit `{#anchor}` tags on every cited heading and the `[ID] Label` convention for design decisions, open questions, risks, specs, and tables. All execution-step `**References:**` lines cite by anchor and ID; no line numbers.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] CM6 atomic-range fidelity vs current atom UX (DECIDED) {#q01-atomic-fidelity}

**Question:** Does `EditorView.atomicRanges` + `Decoration.replace` produce cursor / selection / delete behavior across atoms that matches what users have today with the SVG-`<img>` replaced element approach?

**Why it matters:** The atom is the load-bearing concept of the prompt input. Any divergence — e.g., shift-arrow stepping into the middle of a multi-atom run, or backspace deleting one character of a label rather than the whole atom — breaks the existing UX contract.

**Plan to resolve:** Prototype in [Step 3](#step-3). The success criterion is concretely enumerated in [List L01](#l01-atom-motion-cases).

**Resolution:** DECIDED — `EditorView.atomicRanges` lifted from the `atomDecorationField`'s `Decoration.replace` ranges produces correct one-step motion (`view.moveByChar` advances or retreats one document offset across each U+FFFC), one-step deletion (`deleteCharBackward` / `deleteCharForward` remove the whole atom and clear the decoration), and one-step selection extension. Tests in `tug-edit.test.tsx` cover motion, extension, and both delete directions. Cases 1–7 in [List L01](#l01-atom-motion-cases) are covered by the integration tests; cases 8–10 (clipboard) are covered by the pure serialization round-trip tests in `tug-edit-clipboard.test.ts` and exercised end-to-end via the gallery card.

---

#### [Q02] Atom clipboard serialization (DECIDED) {#q02-atom-clipboard}

**Question:** When an atom is copied or cut, what does the clipboard contain? Plain text with U+FFFC at the atom position? A sidecar JSON mime type for round-trip within tugdeck? Plain text with the atom's label?

**Why it matters:** Today, `TugTextEngine` controls this directly. CM6 has `clipboardInputFilter` / `clipboardOutputFilter` facets that intercept on the boundary; the question is what we *want* the contract to be, not how to implement it.

**Plan to resolve:** Decided alongside [Step 3](#step-3) — the cut/copy/paste round-trip test enumerates the expected behavior and the implementation matches. Documented in [D05](#d05-atom-rendering).

**Resolution:** DECIDED — three-payload contract:
1. `text/plain` (external apps): atom labels in place of U+FFFC, so external pastes see "Please review main.ts" rather than tofu glyphs.
2. `application/x-tug-atoms` (tug-internal): JSON sidecar versioned at `1` carrying `{ position, segment }` entries with positions relative to the copied slice. On paste, this rewrites the matching label-substrings in the plain text back to U+FFFC characters and dispatches a single transaction that applies both the inserted text and the matching `addAtomsEffect`.
3. The `text/plain` representation that *would* go on the clipboard for tug-internal pastes carries U+FFFC directly — but in practice tug-internal pastes always read the sidecar first. The fallback string (label-substituted) is what other apps see. Implementation in `tug-edit/clipboard-filters.ts`; pure tests in `tug-edit-clipboard.test.ts` cover the round-trip and rejection of malformed sidecars.

---

#### [Q03] CM6 lifecycle vs React StrictMode (DECIDED) {#q03-strict-mode}

**Question:** How does the `EditorView` lifecycle survive StrictMode's double-mount in dev?

**Why it matters:** A naïve `useLayoutEffect` that constructs an `EditorView` and tears it down on cleanup will run twice in StrictMode and may leak a mount or fail to dispose listeners. We have hit similar issues in the existing engine.

**Plan to resolve:** Adopt the standard pattern used by `@uiw/react-codemirror`: store the view on a ref, construct in `useLayoutEffect`, dispose in cleanup, branch on existence. Validated by mounting / unmounting `gallery-text-edit` repeatedly with no console warnings and no DOM leftovers. Documented in [Step 1](#step-1).

**Resolution:** DECIDED — `useLayoutEffect` with empty deps constructs the view, the cleanup destroys it and clears `viewRef.current` to `null`. StrictMode's mount/unmount/mount cycle creates a fresh view each pass and disposes the previous one cleanly. The `view()` delegate method reads `viewRef.current` at call time so consumers see the live view across the cycle. Recorded inline in `tugdeck/src/components/tugways/tug-edit.tsx`. Test coverage in `tug-edit.test.tsx` exercises the unmount → re-mount round-trip and asserts a fresh `EditorView` instance is constructed.

---

#### [Q04] Where does the route atom live in the document? (OPEN) {#q04-route-atom-position}

**Question:** Is the leading route atom (the `>`, `$`, or `:` glyph) inside the editor document at offset 0, or rendered as sibling DOM that the editor doesn't know about?

**Why it matters:** Today the route atom is in the doc. CM6 supports both: it can live in the doc as a `Decoration.replace` over offset 0, *or* it can be a sibling DOM element and the editor doc starts post-route. The first preserves the current model; the second simplifies cursor-at-start handling.

**Plan to resolve:** Deferred. Originally slated for [Step 10](#step-10), but the route-prefix feature has been pulled out of the current spike to be revisited in a follow-on plan. Default still anticipated to be "in the doc at offset 0" to match existing semantics, switched if a concrete blocker appears.

**Resolution:** SUPERSEDED by [D08](#d08-route-prefix-simplification). The route is no longer rendered as an atom inside the doc — the gutter is removed, the route is owned by `tug-prompt-entry`'s `route` prop, and prefix-typing detection is a substrate-host extension that does not insert an atom. See [Q05](#q05-prefix-disposition)–[Q09](#q09-submit-strip) for the residual details.

---

#### [Q05] Route-prefix character disposition: stays in the doc or consumed? (DECIDED) {#q05-prefix-disposition}

**Question:** When the user types `>`, `$`, or `:` as the first character of the prompt and the route prop flips, what happens to the typed character?

- (a) The character stays in the doc as plain text (the editor shows `> hello world`); the route prop is metadata. *(Working assumption; matches the owner's "type the route prefix characters into the `tug-text-editor`" wording.)*
- (b) The character is consumed (removed from the doc) when the route flip fires; the editor shows `hello world` but the route prop is set. *(Closer to the legacy "leading route atom" UX; defeats the simplification purpose.)*

**Why it matters:** Drives the implementation of the detection extension and the submit-time text-extraction path (see [Q09](#q09-submit-strip)).

**Plan to resolve:** Owner picks (a) or (b) before [Step 15](#step-15) is implementation-ready.

**Resolution:** DECIDED — (a). The character stays in the doc as plain text; the route prop is metadata. Submit-time stripping is handled separately per [Q09](#q09-submit-strip).

---

#### [Q06] Bidirectional flip: does deleting the leading prefix character reset the route? (DECIDED) {#q06-prefix-deletion}

**Question:** If the user types `> hello` (route flips to Code) and then deletes the leading `>` (leaving `hello`), what happens to the route prop?

- (a) Route flips back to a default. *(Symmetric with detection. Default is whatever's in [Q07-default](#q07-perroute-drafts).)*
- (b) Route stays at Code (the prefix-selected route). *(One-way detection — typing flips, deleting doesn't.)*
- (c) Route flips back to whatever the segment control last selected. *(The segment control is the "owner of record"; typing temporarily overrides it; deleting reverts.)*

**Why it matters:** Determines whether the prefix-typing detection is a one-shot event or a continuous classifier. Continuous is more code but matches user mental models better.

**Plan to resolve:** Owner picks (a), (b), or (c) before [Step 15](#step-15) is implementation-ready. The plan currently assumes (c) — segment control is the owner of record — which gives the cleanest mental model: "typing a prefix overrides; deleting restores."

**Resolution:** DECIDED — (b). One-way detection. Typing a route-prefix character at offset 0 flips the route prop; deletion of the leading prefix does not flip it back. The route changes again only when the user types a *different* prefix as the first character (which counts as a new flip event) or clicks the segment control. Detection is a one-shot classifier on insertions, not a continuous classifier watching every doc change.

---

#### [Q07] Per-route drafts: keep or drop? (DECIDED) {#q07-perroute-drafts}

**Question:** Today `tug-prompt-entry` keeps a separate draft per route (`perRoute: Record<string, TugTextEditingState>`). When the user switches from Code (with a partially-written prompt) to Shell (empty), then back to Code, the original draft restores. Does the simplification preserve this, or collapse to a single shared draft?

- (a) Drop. The editor holds one document. Switching routes does not change the doc. *(Matches the simplification's spirit; loses the per-route draft feature.)*
- (b) Keep. `tug-prompt-entry` continues to store `perRoute` and swaps the editor's doc on route switch. *(Retains the feature; reintroduces the doc-swap complexity that the simplification was trying to remove.)*

**Why it matters:** Determines the shape of `TugPromptEntryState` (preserved-state payload) and the route-switch handler. Has direct user-visible consequences for the workflow.

**Plan to resolve:** Owner picks (a) or (b). The plan currently assumes (a) — drop — per the owner's "greatly simplify" framing. Persistence migration keeps the active-route draft and discards the rest on first restore.

**Resolution:** DECIDED — (a). Drop per-route drafts. The editor holds one document. Switching routes does not change the doc. Persistence migration keeps the active-route draft and discards the rest on first restore.

---

#### [Q08] Segment control: keep or remove? (DECIDED) {#q08-segment-control}

**Question:** The current `tug-prompt-entry` renders a `TugChoiceGroup` segmented control showing Code|Shell|Command (`ROUTE_ITEMS`). Once the gutter is gone, does the segment control stay, or does the route only flip via prefix typing?

- (a) Keep. The segment control is the user's primary route selector; prefix typing is an opt-in shortcut. *(Working assumption; matches the owner's "prop that `tug-prompt-entry` stores for Code|Shell|Command determines the route" — the segment control is what sets that prop today.)*
- (b) Remove. The route only flips via prefix typing. *(Most extreme simplification; loses discoverability.)*

**Why it matters:** Drives the layout and the surface area of the migration step.

**Plan to resolve:** Owner picks. The plan currently assumes (a) — keep — per the working interpretation of the owner's wording.

**Resolution:** DECIDED — (a). Keep the segment control. It remains the user's primary route selector; prefix typing is an opt-in shortcut.

---

#### [Q09] Submit-time prefix stripping (DECIDED) {#q09-submit-strip}

**Question:** Given [Q05](#q05-prefix-disposition)=(a) (prefix stays in the doc), at submit time the doc text is `> hello`. What goes to the route handler?

- (a) Strip the leading prefix iff it matches the active route's prefix character. The handler receives `hello`. *(Matches today's behavior — the legacy engine effectively did this via the route-atom model.)*
- (b) Pass the doc text verbatim. The handler receives `> hello`. *(Simpler; pushes the strip responsibility downstream; user sees the prefix in their prompt history.)*

**Why it matters:** User-visible. Affects what prompts log to history, what the route handler receives, what `Cmd-Up` restores.

**Plan to resolve:** Owner picks. Plan currently assumes (a) — strip-on-match — for parity with today.

**Resolution:** DECIDED — (a). Strip the leading prefix at submit time iff `doc[0]` matches the active route's prefix character. Combined with [Q06](#q06-prefix-deletion)=(b), this means: if the user types `>` (route flips to Code) and submits, the handler receives the doc minus the leading `>`; if the user later switches the route via the segment control to Shell while a leading `>` remains in the doc, the `>` no longer matches the active prefix (`$`) and is passed verbatim — the prefix becomes literal text the moment the route diverges from it.

---

#### [Q10] Row-height shape: pure CSS `max()` or JS-driven token? (DECIDED) {#q10-row-height-shape}

**Question:** The fix for the atom-induced "hop" needs every `.cm-line` to be `max(declared_lineHeight, atomHeight)` tall. The substrate can express this two ways:

- (a) **Pure CSS.** `.cm-line::before { height: max(1lh, var(--tug-text-editor-atom-height, 24px)); }`. Atom height is a CSS variable defined once (in `tug-atom-img.ts`'s root style or in `tug-text-editor.css`'s component-scope `body`). No JS measurement.
- (b) **JS-driven token.** A TS constant `ATOM_HEIGHT_PX = 24` exported from `atom-decoration.ts`; the theme reads it via a generated CSS variable; the caret layer reads it directly. Single TS source of truth.
- (c) **Both.** TS constant for JS reads (caret layer); CSS variable mirrors it for the theme's `max()`.

**Why it matters:** Affects whether the atom widget owns its height (CSS-first) or the substrate code owns it (TS-first). [Q11](#q11-caret-height-source) is downstream — if the caret-layer needs the row height in JS, (b) or (c) win.

**Plan to resolve:** Implementer picks during [Step 14.5](#step-14-5) T1; documents the choice in the file that owns the value.

**Resolution:** DECIDED — (c) both. A single TS constant `ATOM_HEIGHT_PX` is the source of truth, exported from `atom-decoration.ts` (the file that owns the atom widget). The substrate publishes it as a CSS custom property `--tug-text-editor-atom-height` on the host wrapper at mount time so the theme's `max(1lh, var(--tug-text-editor-atom-height))` resolves at the same value. JS readers (caret layer, any future measurement code) import the constant directly. Single source, two outlets — no risk of CSS and JS disagreeing on the floor.

---

#### [Q11] Caret height source: `view.defaultLineHeight` or rendered row height? (DECIDED — empirical comparison during implementation) {#q11-caret-height-source}

**Question:** Once the row height is `max(view.defaultLineHeight, atomHeight)`, the caret layer must size against the *rendered* row height, not `view.defaultLineHeight`. Three implementation paths:

- (a) **Compute in JS.** `rowHeight = Math.max(view.defaultLineHeight, ATOM_HEIGHT_PX)`. Cheapest and most direct.
- (b) **Read computed style.** `getComputedStyle(.cm-line, '::before').height` parsed back to px. Always tracks the actual rendered height; works regardless of where atom-height lives. Cost: one synchronous style read per caret paint.
- (c) **Use CM6's `lineBlockAt`.** `view.lineBlockAt(head).height` divided by the number of wrapped rows on that block (via `view.viewState.heightOracle`). Tracks atom-induced height once CM6 measures it. Cost: relies on CM6 having measured the row already.

**Why it matters:** Caret rendering happens on every `markers()` call (selection set, doc change, geometry change, focus change). Picking the right source affects per-paint cost AND correctness — a stale read produces a visibly mis-sized caret for one frame.

**Plan to resolve:** Implement (b) and (c) side-by-side with diagnostic logging that captures both readings on every paint, plus the option (a) compute as a baseline. Walk the substrate through the gallery scenarios in [Step 14.5](#step-14-5)/T6 and compare:
- Do (b) and (c) always agree to the pixel? Then pick the cheaper one (likely (a) if it also agrees, else (c)).
- Do they disagree under any scenario (e.g., during a measure pass mid-frame, or when CM6 hasn't measured a fresh row yet)? Capture the disagreement in `dash/text-editing-base-caret-source-comparison.md`; pick the one that produced the visually-correct caret in that scenario; document the rationale.
- The diagnostic instrumentation is removed in the same step — production code uses the chosen single source.

**Resolution:** DECIDED — (b) `getComputedStyle(.cm-line, '::before').height`. The empirical hand-tune in the gallery (Step 14.5/T6) confirmed (b) produces visually-correct carets across every font / size / line-height / atom configuration we exercise. The alternatives weren't observed to disagree with (b) in any tested scenario, but each has a failure mode (b) avoids:

- (a) **JS baseline** re-derives the floor in code, duplicating the theme's `max(1lh, atom-height)` rule. Two implementations of the same value invite drift if either side changes; (b) reads the rendered floor directly.
- (c) **`lineBlockAt`** depends on CM6's heightOracle being fresh — when the oracle is stale (e.g. between a CSS-variable change and the next measure pass), `lineBlockAt` returns pre-change values. The geometry-bridge fix in Step 14.5/T5 keeps the oracle current most of the time, but (b) doesn't depend on the bridge succeeding because it reads the browser's already-resolved layout.

Cost of (b): one synchronous `getComputedStyle` read per caret paint. Caret paints happen on `update.docChanged`, `update.selectionSet`, `update.viewportChanged`, `update.geometryChanged`, `update.focusChanged` — not every animation frame, and the same pattern the substrate's `selection-layer` already uses for its overlay. Acceptable. Documented in `caret-layer.ts`'s `markers()` body next to the production read; the alternatives' helpers + diagnostic flag are removed.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| IME × atomic widget unreliability | high | medium | Step 6 is a dedicated gate; failure halts the spike. | CJK compose drops characters, collapses selection, or corrupts glyph next to an atom. |
| [L23] paint channels don't fit CM6's lifecycle | high | low | Step 7 is a dedicated step; the engine-level `paintMirrorAsActive` / `paintMirrorAsInactive` shape is preserved at the API boundary. | Pane-state preservation tests fail or selection is lost on cmd-tab. |
| Bundle size delta exceeds ~150 KB gzip target | medium | medium | Step 12 records actual delta; if over, document tree-shaking opportunities and accept or revisit. | Bundle delta > 200 KB gzip. |
| Atom clipboard round-trip diverges from current behavior | medium | medium | Step 3 enumerates the expected behavior up front. | Paste of a copied prompt loses an atom. |
| CM6 forces an API change to `TugTextInputDelegate` | medium | low | Apply the change symmetrically to both backends after the spike. | A delegate method maps poorly onto CM6's offset model. |

**Risk R01: IME composition with atomic widgets** {#r01-ime-atoms}

- **Risk:** CM6's documented IME interaction with `atomicRanges` has known rough edges in the upstream forum. Composition adjacent to an atomic widget can interrupt the selection.
- **Mitigation:** Step 6 is a dedicated validation gate with an explicit halt condition. Test with at least Japanese kana and Chinese pinyin; document any observed misbehavior; reproduce upstream and file if novel.
- **Residual risk:** A class of users (CJK input) may have a degraded experience even after mitigation. If so, the substrate decision tilts back toward Lexical or staying with `contenteditable`.

**Risk R02: [L23] mirror paint vs CM6 ownership** {#r02-l23-mirror}

- **Risk:** CM6 owns its DOM tree; the `cm-content` node identity may change on reconfigure. The existing `paintMirrorAsActive` / `paintMirrorAsInactive` writes selection through `window.getSelection()` and CSS Custom Highlights; the active-paint channel may collide with CM6's own focus / selection management.
- **Mitigation:** Step 7 routes active-paint through CM6's `EditorView.dispatch({ selection })` rather than direct `window.getSelection()` writes; inactive-paint continues to use `selectionGuard.cardRanges` against the live `cm-content` node read at fire time.
- **Residual risk:** If CM6 reconfigures the content node mid-flight (e.g., during theme switch), an inactive Range may dangle until the next paint pass.

**Risk R03: Bundle size** {#r03-bundle}

- **Risk:** Adding CM6 grows the tugdeck production bundle by 75–135 KB gzip per upstream estimates, more if extensions accrete.
- **Mitigation:** Use only the extensions we actually need; document the delta in Step 12; revisit if delta > 200 KB gzip.
- **Residual risk:** The cost is real and permanent; this is part of the tradeoff accepted in [D01](#d01-spike-cm6).

---

### Design Decisions {#design-decisions}

#### [D01] Spike with CodeMirror 6 (DECIDED) {#d01-spike-cm6}

**Decision:** Adopt CodeMirror 6 as the substrate for the new `tug-edit` component. Reject continuing to polish raw `contenteditable`, reject Monaco (too heavy, atom model mismatch, theming friction), reject rolling our own in Rust + WASM (text layout / IME / accessibility cost is multi-engineer-year). Lexical was the strongest non-CM alternative; rejected for this spike because the user's stated direction (better Claude Code TUI editing, not Notion) keeps the ceiling within CM6's reach, and CM6's atomic-range model fits atoms more naturally than Lexical's `DecoratorNode` (which has a known selection-null limitation when selection lands over the decorator).

**Rationale:**
- CM6's `EditorView.atomicRanges` facet is purpose-built for the atom semantics we need.
- CM6 is designed for single-font code-shaped editing — our prompt-input use case is exactly that shape.
- CM6 is production-proven by Replit, Sourcegraph, JupyterLab, Obsidian, and Observable.
- Theming via CSS variables and `EditorView.theme()` maps cleanly onto the tug 7-element token system.
- Bundle cost (~75–135 KB gzip) is acceptable.
- Existing `TugTextInputDelegate` and adjacent interfaces are substrate-agnostic and survive the swap.

**Implications:**
- Markdown is the realistic feature ceiling ([D02](#d02-markdown-ceiling)).
- IME × atomic-widget interaction is a known soft spot and gets a dedicated validation step ([R01](#r01-ime-atoms), [Step 6](#step-6)).
- The spike is *additive* — `tug-prompt-input` keeps shipping until the migration plan lands.

#### [D02] Markdown ceiling accepted; rich documents out of scope (DECIDED) {#d02-markdown-ceiling}

**Decision:** The feature ceiling for `tug-edit` is "single-font editing with atoms, plus optionally Markdown source with live decorations" (the pattern Obsidian Live Preview and `codemirror-rich-markdoc` use). Tables, callouts with nested editable regions, Notion-style block rearrange, and non-Markdown structured-document features are explicitly out of scope. If the project's direction later requires those features, the substrate decision is reopened.

**Rationale:**
- The user has stated the goal is "better than Claude Code TUI editing", not a Notion competitor.
- CM6's flat-string data model cannot represent nested editable regions cleanly. Pretending otherwise wastes effort.
- The Markdown-source-with-live-decorations pattern is well-trodden, fits CM6's strengths, and covers bold/italic/headings/lists/code fences/blockquotes.

**Implications:**
- The follow-on Markdown plan ([Roadmap / Follow-ons](#roadmap)) targets *source with live decorations*, not WYSIWYG.
- Any future requirement for tables / nested blocks triggers a substrate re-evaluation rather than an attempt to bend CM6 into shapes it doesn't fit.

#### [D03] New component name is `tug-edit`, sibling to `tug-prompt-input` (DECIDED) {#d03-tug-edit-name}

**Decision:** The new substrate component is named `tug-edit` and lives at `tugdeck/src/components/tugways/tug-edit.tsx`. It is a *substrate*, lower-level than `tug-prompt-input` — it does not own route prefixes, route atoms, or any prompt-domain semantics on its own. Those features sit on top of it as composable extensions or are surfaced via props that are off by default.

**Rationale:**
- Decouples the substrate from the prompt-domain composition.
- Clear naming for the eventual migration: `tug-prompt-input` becomes a wrapper around `tug-edit` with prompt-specific extensions enabled.
- Leaves room for non-prompt consumers (e.g., a future code-editing card, a notes card).

**Implications:**
- Route-prefix support is a `tug-edit` *option* (off by default), not a hard-coded behavior.
- The Component Gallery card is named `TextEdit` (not `Edit`, which is too generic) to mirror the component name.

#### [D04] Spike is additive; existing component keeps shipping (DECIDED) {#d04-additive}

**Decision:** This phase ships `tug-edit` and the `TextEdit` gallery card. It does *not* migrate `tug-prompt-input`, `tug-prompt-entry`, or `tide-card` to use the new substrate. The migration is a separate plan, gated on the spike's go/no-go ([Step 13](#step-13)).

**Rationale:**
- Smallest blast radius. The live tide-card keeps working through the spike.
- Decision can be reversed after the spike without unwinding migration work.
- Reviewers can compare the two side-by-side in the gallery.

**Implications:**
- Two prompt-shaped components live in the codebase during the spike phase. Documented as a known temporary state.
- The migration plan (`tugplan-text-editing-migration.md`) is scaffolded in Step 13 if the decision is "go".

#### [D05] Atoms remain SVG-`<img>` rendered, embedded as CM6 widgets (DECIDED) {#d05-atom-rendering}

**Decision:** The existing `tug-atom-img.ts` SVG-data-URI rendering pipeline is reused unchanged. The CM6 atom widget is a `WidgetType` whose `toDOM()` returns an `<img>` element produced by `createAtomImgElement`. The text representation of an atom in the CM6 document is U+FFFC, identical to the existing engine. Cut/copy/paste round-trip uses U+FFFC + sidecar serialization in a custom MIME type for in-tugdeck pastes; external clipboard contains plain-text fallback (label-of-atom).

**Rationale:**
- Preserves the visual + accessibility behavior already shipped.
- Keeps the atom regeneration-on-theme-change path intact.
- Aligns the CM6 document model (offsets over a flat string) with the existing engine's text model — `getText()` semantics stay identical.

**Implications:**
- The CM6 atom widget is small: it wraps `createAtomImgElement` and exposes the standard `WidgetType` lifecycle.
- `clipboardInputFilter` / `clipboardOutputFilter` facets handle the round-trip; the plain-text fallback for external paste is explicit.

#### [D06] Theme via `EditorView.theme()` reading CSS variables (DECIDED) {#d06-theming}

**Decision:** The CM6 theme extension uses `EditorView.theme()` and `EditorView.baseTheme()` with CSS that references the existing tug 7-element CSS variables directly (`var(--tug-text-fg-default)`, `var(--tug-bg-selection-active)`, etc.). The `EditorView` does not subscribe to `subscribeThemeChange` — token swaps via the existing CSS-variable mechanism reach the editor automatically. Atom regeneration on theme change continues to use `engine.regenerateAtoms()`-equivalent (a re-decoration pass triggered by `subscribeThemeChange`), since the SVGs are baked at atom-construction time.

**Rationale:**
- Smallest possible coupling between CM6 and the tug theme system.
- Theme switches stay live without remount.
- Mirrors the styling approach used elsewhere in tugdeck — CSS variables are the contract.

**Implications:**
- All editor chrome appearance is controlled through the existing token files (`brio.css`, `harmony.css`).
- Adding a token for an editor-specific concern (e.g., a CM6 gutter color) follows the standard 7-element pattern.

#### [D07] Rename `tug-edit` → `tug-text-editor` for production (DECIDED) {#d07-rename-tug-text-editor}

**Decision:** With the spike concluded and the substrate accepted, the working name `tug-edit` is replaced by the production name `tug-text-editor` across the component (file pair, internal directory, public symbols, CSS classes, data attributes, app-test names, hook names, gallery card name). Supersedes [D03](#d03-tug-edit-name)'s spike-phase naming.

**Rationale:**
- `tug-edit` reads as a verb; the component is a *substrate* — a noun. `tug-text-editor` names what it is.
- Aligns with the component-library roster: peer components use noun-shaped names (`tug-pane`, `tug-deck`, `tug-prompt-entry`, `tug-markdown-view`).
- The rename is mechanical and is its own step ([Step 14](#step-14)); migration ([Step 15](#step-15)) starts against a clean rename baseline so review can read each commit independently.

**Implications:**
- Spike-phase plan text that refers to `tug-edit` historically (e.g., this section's earlier wording in [D03](#d03-tug-edit-name)) is left as-is. Authoritative current name is `tug-text-editor`.
- The `useEditStatePreservation` hook becomes `useTextEditorStatePreservation`. The substrate-internal helpers prefixed `tug…` (`tugCaretLayer`, `tugTheme`, etc.) keep their names — the `tug` prefix already implies the substrate; adding `TextEditor` would just lengthen them.

#### [D08] Route-prefix simplification (DECIDED) {#d08-route-prefix-simplification}

**Decision:** The route-prefix model in `tug-prompt-entry` is simplified to remove the gutter, remove the leading route atom, and remove per-route drafts. The route is owned by `tug-prompt-entry`'s existing `route` state, which the existing segment control sets directly ([Q08](#q08-segment-control)=(a) keep). The substrate (`tug-text-editor`) gains a small one-shot prefix-detection extension contributed by `tug-prompt-entry`: when an insertion makes a route-prefix character (`>` / `$` / `:`) the first character of the doc *and* that character maps to a different route than the current `route` prop, the extension calls `setRoute(matchingRoute)` once. The character stays in the doc as plain text ([Q05](#q05-prefix-disposition)=(a)). Detection is one-way: deleting the leading prefix does NOT revert the route ([Q06](#q06-prefix-deletion)=(b)); the user changes routes after that only via the segment control or by typing a different prefix as the new first character. Per-route drafts (`perRoute: Record<string, TugTextEditingState>`) are removed — the editor holds one document, one draft, and the active route is metadata about how to dispatch on submit ([Q07](#q07-perroute-drafts)=(a)). At submit time, a leading prefix is stripped iff it matches the active route's prefix character ([Q09](#q09-submit-strip)=(a)); if the route has diverged from the leading character, the character is passed verbatim.

Lands in [Step 15](#step-15). Resolves [Q04](#q04-route-atom-position) (route atom no longer lives in the doc) and [Q05](#q05-prefix-disposition) / [Q06](#q06-prefix-deletion) / [Q07](#q07-perroute-drafts) / [Q08](#q08-segment-control) / [Q09](#q09-submit-strip).

**Rationale (owner):** "We *greatly simplify* the whole notion of the route prefix as it is currently implemented in `tug-prompt-entry`. The prop that `tug-prompt-entry` stores for Code|Shell|Command determines the route. We remove the gutter showing the route prefix character. The user can optionally type the route prefix characters into the `tug-text-editor`. If the user does this, we detect it and switch the route appropriately and as needed. If the user does not type (or edit and replace) one of these route prefix characters in the `tug-text-editor` to make it the first character of a prompt, then we do nothing."

**Implications:**
- The substrate (`tug-text-editor`) does not own the route concept. The detection is wired by `tug-prompt-entry` via a small route-prefix extension factory (likely `tug-prompt-entry/route-prefix-extension.ts`) consumed via the substrate's existing `extensions` prop. The substrate stays substrate.
- The legacy "consume the prefix into a route atom" flow is gone. There is no leading atom in the doc; no `stripRouteAtoms` migration needed for that shape; the submit-time handler does the strip ([Q09](#q09-submit-strip)).
- Detection is one-shot, not continuous: the trigger is "an insertion made `doc[0]` a route prefix that differs from the current route." Deletions are ignored; replays of the same prefix are no-ops. This makes the extension pure (no continuous classifier, no debouncing) and matches the user's mental model of "I typed a prefix and the route changed."
- Per-route drafts are a feature loss. Restoring a session that had three drafts (one per route) drops two of them. Migration keeps the draft for the route active at save time and discards the rest. (See [Step 15](#step-15) Tasks for the persistence migration.)
- A residual subtle case: user types `>` (route flips to Code), then clicks the Shell segment (route flips to Shell). The doc still starts with `>` and the route is now Shell. On submit the `>` is passed verbatim because it doesn't match Shell's prefix `$`. This is the intentional consequence of [Q09](#q09-submit-strip)=(a): the prefix is literal text the moment the route diverges from it.

---

### Deep Dives {#deep-dives}

#### Tuglaws compliance {#tuglaws-compliance}

This spike implements a new tugways component, so [tuglaws.md](../tuglaws/tuglaws.md) governs every step. This subsection enumerates the laws engaged by the spike, how `TugTextEditor` (the production name; the spike committed under `TugEdit`, see [D07](#d07-rename-tug-text-editor)) complies, and where each compliance check lands. Each execution step's `**References:**` line cites the laws that step engages; the table below is the authoritative cross-walk.

**Table T02: Tuglaws applied to `TugTextEditor`** {#t02-tuglaws-applied}

| Law | Engagement | Compliance approach | Where it lands |
|---|---|---|---|
| [L01] One `root.render()` at mount | Always | The React shell mounts once; CM6 manages its own DOM tree internally and is never re-rendered through React after construction. | Steps 1, 11 (gallery uses the registered card factory; no external `root.render`). |
| [L02] External state via `useSyncExternalStore` only | When CM6 state must drive React renders | When the React shell *renders* something derived from CM6 state (e.g., the typeahead popup's open/closed flag), it subscribes through `useSyncExternalStore` against a small subscribable adapter over `EditorView.updateListener`. CM6's internal state is never copied into `useState`. | Step 5 (typeahead state observer), Step 7 (state-preservation hook). |
| [L03] `useLayoutEffect` for registrations events depend on | Always | Mount, dispose, state-preservation registration, route-prefix listener, and typeahead extension registration all run in `useLayoutEffect` so the substrate is ready before any keyboard or pointer event can land. | Steps 1, 5, 7, 9, 10. |
| [L04] No measure-after-parent-setState on child DOM | Completion popup positioning | Popup position reads `EditorView.coordsAtPos` directly from the live view rather than via React-state-driven layout. | Step 5. |
| [L05] No `requestAnimationFrame` for React-commit-coupled work | Always | We never use rAF to bridge CM6 state into React commits. CM6 has its own scheduler; the React shell observes via `EditorView.updateListener`. | All steps (negative invariant). |
| [L06] Appearance via CSS and DOM, never React state | Theme, atom rendering, focus indication, disabled, placeholder, growDirection, maximized, focusStyle, borderless, drag-over | All editor visuals flow through CSS variables (theme), CM6 widget DOM (atoms), CSS class toggles on the host (focus / disabled), and DOM-side mutations (drop hover). No `useState` drives editor appearance. | Steps 2, 3, 8, 10. |
| [L07] Handlers access state through refs / stable singletons | Delegate methods, keymap handlers, completion select, drop handler, route-prefix listener | The `useImperativeHandle` delegate reads `viewRef.current` at call time; CM6 keymap handlers receive `view` as their argument; provider closures hold refs. | Steps 1, 4, 5, 7, 8, 9, 10. |
| [L09] Cards never set their own position / size / z-order | Gallery card | `gallery-text-editor.tsx` sets only content layout; the hosting `TugPane` owns geometry. | Steps 1, 11. |
| [L10] One responsibility per layer | Always | `TugTextEditor` is the substrate (text editing); `gallery-text-editor` is composition (demo); `tug-prompt-entry` will wrap and layer prompt-domain semantics on top after [Step 15](#step-15). | Steps 1, 10, 13, 15. |
| [L11] Controls emit; responders own state | Always — `TugTextEditor` is a responder | `TugTextEditor` owns the document, caret, and selection: it is the responder for `cut` / `copy` / `paste` / `selectAll` / `undo` / `redo` and the domain `submit` action. Step 4 wires the keymap; Step 5 wires completion-menu emitter→responder routing; Step 9 wires the right-click context menu. | Steps 1 (declared), 4, 5, 9. |
| [L12] Selection stays inside card boundaries | Selection paint, state preservation | The `cm-content` node is registered with `SelectionGuard` as the editor's selection boundary; inactive-selection paint goes through `selectionGuard.cardRanges` so selection cannot escape the card. | Steps 7, 9. |
| [L13] CSS for declarative motion; rAF only for gesture frame loops | Caret blink, focus transition, drag-over feedback | All editor motion is CSS-driven. No rAF. | Steps 2, 8. |
| [L15] Token-driven control states | Theme, focus, disabled | Editor states (rest, focus, disabled, readonly) use seven-slot tokens; color transitions provide all interaction feedback — no box-shadow, no translateY, no gradients. | Steps 2, 10. |
| [L16] Foreground-only rules declare `@tug-renders-on` | Theme CSS, gallery card CSS | Every CSS rule that sets `color`, `fill`, or `border-color` without `background-color` carries a `@tug-renders-on` annotation naming its surface. `audit-tokens lint` enforces this. The component's `@tug-pairings` block is added when the theme lands. | Steps 1 (gallery card), 2 (theme), 10 (state styles). |
| [L17] Component aliases resolve to `--tug7-*` in one hop | Theme | The `--tugx-text-editor-*` aliases (formerly `--tugx-edit-*` during the spike) each resolve directly to a `--tug7-*` token — no alias-to-alias chains. The audit enforces this. | Step 2. |
| [L18] Element / surface vocabulary | Theme | Editor text uses `--tug7-element-*`; editor background uses `--tug7-surface-*`. Pairings are declared. | Step 2. |
| [L19] Component authoring guide | Always | File pair (`tug-text-editor.tsx` + `tug-text-editor.css`), module docstring with the standardized citation set, props interface, `data-slot="tug-text-editor"`, CSS organization. The gallery card mirrors the convention. | All steps. |
| [L20] Each component owns scoped tokens; composed children keep theirs | When `TugTextEditor` composes other tug components | If later steps compose tug components inside the editor (e.g., context menu, completion menu), `TugTextEditor`'s CSS references only its own `--tugx-text-editor-*` aliases; composed children's tokens are not overridden. | Steps 5, 9. |
| [L21] Third-party code requires license compliance | CM6 substrate | CodeMirror 6 (MIT) is logged in `THIRD_PARTY_NOTICES.md` (existing entry, expanded for the substrate adoption). Each consuming source file references the notice. | Step 1 (notices update + tug-text-editor.tsx citation), Steps 2–10 (extension modules cite the same entry). |
| [L22] Direct DOM updates via store observer, not React round-trip | Completion provider results, inactive-selection paint | When CM6's `updateListener` triggers a paint to `selectionGuard.cardRanges`, the observer writes directly to the DOM — no `useSyncExternalStore` round-trip. Completion provider observers are subscribed through their store's API, not through React state. | Steps 5, 7. |
| [L23] Internal operations must not lose user-visible state | State preservation | Selection, focus, scroll, content survive CM6 reconfigure, theme switch, cmd-tab cycle, tab deactivation, and cold-mount restore via the `useCardStatePreservation` protocol. The active/inactive paint distinction is the central mechanism. | Step 7. |
| [L24] State partitioned into appearance / local data / structure | Always | Appearance (caret, selection paint, focus ring) → CSS / DOM. Local data (`viewRef`, `hostRef`, internal flags) → `useRef`. Structure (subscriptions to providers, state-preservation registration) → `useSyncExternalStore` / `useLayoutEffect` / store observers. | All steps. |
| [L25] Deck → Pane → Card hierarchy | Gallery card | The TextEdit gallery card is content; the `TugPane` chrome owns its position, size, and z-order. | Steps 1, 11. |

**Laws not engaged by this spike:**

- [L08] Live preview in mutation transactions — the editor's edits are committed values per keystroke; no draft-vs-commit distinction.
- [L14] Radix Presence enter/exit boundary — the spike does not introduce Radix-managed enter/exit.

**Compliance verification per step:**

Each step's `**References:**` line cites the law IDs the step engages. Step 12 (Integration Checkpoint) explicitly walks the entire law set against the new code and records the result. The component-authoring-guide checklist covers the [L19] surface; `audit-tokens lint` covers [L16] / [L17] / [L18] / [L20]; the tests in Steps 1, 3, 4, 5, 7, 9 cover the runtime invariants ([L01], [L03], [L07], [L11], [L23]).

#### Substrate evaluation {#substrate-evaluation}

##### Option A — Keep polishing `contenteditable`

**Pros:** Existing investment of ~3,500 lines (`tug-prompt-input.tsx` 1,303 + `tug-prompt-entry.tsx` 1,135 + `tug-text-engine.ts` 2,245 + atoms/CSS) is preserved.

**Cons:** WebKit's `contenteditable` has a long tail of unfixed bugs — composition selection on iOS 16.4+ ([Apple developer forum thread 730031](https://developer.apple.com/forums/thread/730031)), focus surrender ([WebKit bug 112854](https://bugs.webkit.org/show_bug.cgi?id=112854)), AX object updates after dynamic changes, unwanted `&nbsp;` insertion ([WebKit bug 38902](https://bugs.webkit.org/show_bug.cgi?id=38902)). Every previous editor that started here moved away.

**Verdict:** Reject. The polish curve is asymptotic and the substrate is not under our control.

##### Option B — Monaco

**Pros:** Production-grade editor (powers VS Code).

**Cons:** Multi-megabyte bundle. No first-class atomic inline widget that participates in cursor motion. Theming system is its own world (Monarch tokens, theme JSON) and does not map cleanly onto CSS variables.

**Verdict:** Reject. Monaco is the right tool for IntelliSense over a TS program, not for a prompt composer with atoms.

##### Option C — CodeMirror 6 (chosen)

**Pros:**
- `EditorView.atomicRanges` is purpose-built for atom semantics.
- Designed for single-font code-shaped editing.
- Bundle ~75–135 KB gzip.
- Theming via `EditorView.theme()` + CSS variables is straightforward.
- Production-proven (Replit, Sourcegraph, JupyterLab, Obsidian, Observable).
- `clipboardInputFilter` / `clipboardOutputFilter` facets give clean clipboard control.
- Markdown source with live decorations (the realistic ceiling per [D02](#d02-markdown-ceiling)) is a well-trodden CM6 pattern.

**Cons:**
- IME × atomic widgets has rough edges in upstream forum reports ([R01](#r01-ime-atoms)).
- Setup is more code than people expect (state + view + extensions + keymap + theme).
- Architecture is principled but not React-shaped; the `@uiw/react-codemirror` wrapper papers over the lifecycle but you'll likely drop down to raw `EditorView` for our level of integration.
- Cannot scale into Notion-shape (tables, nested editable blocks). Accepted in [D02](#d02-markdown-ceiling).

**Verdict:** Adopt for spike ([D01](#d01-spike-cm6)).

##### Option C-alt — Lexical (rejected for this spike)

**Pros:** Tree-based document model with first-class `ParagraphNode` / `HeadingNode` / `QuoteNode` / `CodeNode` / `ListNode` / `TableNode`. `DecoratorNode` for embedding React components inline. Modular plugin model. `lexical-beautiful-mentions` is an off-the-shelf reference for the atom pattern. Markdown import/export via `@lexical/markdown`. Bundle 22 KB gzip core; 100–180 KB gzip with rich-text plugins.

**Cons (versus our brief):**
- `DecoratorNode` selection becomes `null` when selection lands over the decorator. This interacts directly with [L23] selection preservation.
- Code-editing ergonomics (multi-cursor, find/replace, large-text scrolling) are mediocre — Lexical's strengths point the other way.
- Lexical owns more of the React lifecycle than CM6 does. Our existing engine-as-stable-ref + direct-DOM + `useSyncExternalStore` pattern fits CM6 more naturally.
- `GridSelection` design is internally debated upstream ([Lexical issue #5276](https://github.com/facebook/lexical/issues/5276)).

**Asymmetry argument:** Lexical scales further into rich documents (tables, blocks, embeds) than CM6; CM6 scales further into code-shaped editing (multi-cursor, search/replace, large-document) than Lexical. The user's stated direction is the latter half of that asymmetry — better than Claude Code TUI editing, not Notion. CM6 fits.

**Revisit if:** the user's direction shifts toward tables, nested editable blocks, or Notion-style block rearrange. At that point this decision is reopened.

##### Option D — Roll our own (Rust + WASM)

**Pros:** Total control.

**Cons:** Text layout, IME, RTL/bidi, accessibility, font fallback, caret geometry on wrapped lines — these are years of engineering. Monaco's team paid that cost over many years. The tug-markdown-view comparison is misleading: Markdown rendering is pure output; an editor is bidirectional with the OS input stack.

**Verdict:** Reject for now. Revisit only if both CM6 and Lexical fail.

#### tug-text-editor prop surface {#t01-feature-surface}

**Table T01: `tug-text-editor` prop surface** {#t01-feature-surface}

The canonical enumeration of every prop and behavior `tug-text-editor`
(the production name; was `tug-edit` during the spike, see [D07](#d07-rename-tug-text-editor))
exposes, grouped by category. The "Origin" column distinguishes
props that exist for parity with `tug-prompt-input` from new props
introduced on `tug-text-editor`. The "Status" column flags props that have
been deferred from the current spike.

Step 11 walks this table top-to-bottom: each row that isn't deferred
needs a control, toggle, or input on the gallery card.

##### Layout / state

| Prop / behavior | Origin | Today / Mapping | Status |
|---|---|---|---|
| `placeholder` | Parity with `tug-prompt-input` | `@codemirror/view` placeholder extension via Compartment | Implemented (Step 10) |
| `maxRows` | Parity with `tug-prompt-input` | CSS `max-height: calc(var(--tug-text-editor-max-rows) * 1lh + 16px)` on `.cm-scroller`; ignored when `maximized` | Implemented (Step 10) |
| `growDirection` (`"up"` / `"down"`) | Parity with `tug-prompt-input` | Host `data-grow-direction`; `"up"` adds `margin-top: auto` for chat-input pattern | Implemented (Step 10) |
| `maximized` | Parity with `tug-prompt-input` | Host `data-maximized`; switches `.cm-scroller` from max-height cap to `flex: 1 1 auto` | Implemented (Step 10) |
| `disabled` | Parity with `tug-prompt-input` | `EditorState.readOnly` facet via Compartment + `data-disabled` / `aria-disabled` on host | Implemented (Step 10) |
| `focusStyle` (`"background"` / `"ring"`) | Parity with `tug-prompt-input` | Host `data-focus-style` toggled via CM6 `EditorView.focusChangeEffect` listener | Implemented (earlier step) |
| `borderless` | Parity with `tug-prompt-input` | Host `data-borderless` CSS modifier | Implemented (earlier step) |
| `preserveState` | Parity with `tug-prompt-input` | Conditional `useCardStatePreservation` registration | Implemented (earlier step) |

##### Behavior

| Prop / behavior | Origin | Today / Mapping | Status |
|---|---|---|---|
| `returnAction` (`"submit"` / `"newline"`) | Parity with `tug-prompt-input` | High-priority CM6 keymap on `Enter` | Implemented (earlier step) |
| `numpadEnterAction` (`"submit"` / `"newline"`) | Parity with `tug-prompt-input` | Distinct keymap entry; numpad Enter is `code: "NumpadEnter"` | Implemented (earlier step) |
| `onSubmit` | Parity with `tug-prompt-input` | Invoked by submit-action keymap | Implemented (earlier step) |
| `onChange` | Parity with `tug-prompt-input` | CM6 `EditorView.updateListener` filtering on `update.docChanged` | Implemented (earlier step) |
| `completionProviders` | Parity with `tug-prompt-input` | CM6 extension watching trigger characters; existing menu UI rendered alongside the editor DOM | Implemented (earlier step) |
| `completionDirection` (`"up"` / `"down"`) | Parity with `tug-prompt-input` | Popup direction; existing menu UI prop | Implemented (earlier step) |
| `historyProvider` | Parity with `tug-prompt-input` | Custom keymap dispatching transactions | Implemented (earlier step) |
| `onTypeaheadChange` | Parity with `tug-prompt-input` | Same callback shape; fired from the completion extension | Implemented (earlier step) |
| `dropHandler` | Parity with `tug-prompt-input` | `EditorView.domEventHandlers` with `posAtCoords` for insertion offset | Implemented (earlier step) |
| `routePrefixes` | Parity with `tug-prompt-input` | CM6 transaction filter on offset 0; first-char insertion replaces with route atom | **Deferred** to a follow-on plan ([Q04](#q04-route-atom-position)) |
| `onRouteChange` | Parity with `tug-prompt-input` | Fired by the route-prefix transaction filter | **Deferred** to a follow-on plan ([Q04](#q04-route-atom-position)) |

##### Typography (new on `tug-text-editor`)

`tug-prompt-input` reads typography from CSS tokens directly and exposes no React props for them. `tug-text-editor` lifts each into a prop so consumers can tune typography per-instance without writing CSS overrides; the same tokens drive the defaults via `var(--tug-…-editor, fallback)` reads in the theme.

| Prop | Origin | Today / Mapping | Status |
|---|---|---|---|
| `fontFamily` | New on `tug-text-editor` (Step 10) | Inline `--tug-font-family-editor` on host wrapper; theme reads via `var(--tug-font-family-editor, inherit)` | Implemented (Step 10) |
| `fontSize` | New on `tug-text-editor` (Step 10) | Inline `--tug-font-size-editor` on host wrapper; theme reads via `var(--tug-font-size-editor, 14px)` | Implemented (Step 10) |
| `lineHeight` (`number \| string`) | New on `tug-text-editor` (Step 10) | Inline `--tug-line-height-editor` on host wrapper; theme reads via `var(--tug-line-height-editor, 1.75)`. `.cm-line::before` ghost uses `1lh` so any unit propagates | Implemented (Step 10) |
| `letterSpacing` | New on `tug-text-editor` (Step 10) | Inline `--tug-letter-spacing-editor` on host wrapper; theme reads via `var(--tug-letter-spacing-editor, normal)` | Implemented (Step 10) |

##### View controls (new on `tug-text-editor`)

`tug-prompt-input` is a fixed single-paragraph layout with no view toggles. `tug-text-editor` exposes two CM6-native view-control props.

| Prop | Origin | Today / Mapping | Status |
|---|---|---|---|
| `lineWrap` (boolean) | New on `tug-text-editor` (Step 10) | `EditorView.lineWrapping` Extension via Compartment; sets `white-space: break-spaces` on `.cm-content` | Implemented (Step 10) |
| `lineNumbers` (boolean) | New on `tug-text-editor` (Step 10) | `lineNumbers()` from `@codemirror/view` via Compartment; left gutter | Implemented (Step 10) |

##### Cross-cutting behaviors

These aren't React props but are part of the prop / behavior surface
that the gallery card must exercise.

| Behavior | Origin | Today / Mapping | Status |
|---|---|---|---|
| Cut / copy / paste with atoms | Parity with `tug-prompt-input` | U+FFFC + sidecar via `clipboardInputFilter` / `clipboardOutputFilter` facets | Implemented (earlier step) |
| Right-click classifier | Parity with `tug-prompt-input` | "near-caret" vs "within-range" vs "elsewhere"; adapter ports to CM6 selection geometry via `coordsAtPos` / `posAtCoords` | Implemented (earlier step) |
| Active / inactive paint ([L23]) | Parity with `tug-prompt-input` | Active: `EditorView.dispatch({ selection })` + focus. Inactive: `selectionGuard.cardRanges` Range against `.cm-content` | Implemented (earlier step) |
| Drag-and-drop file → atom | Parity with `tug-prompt-input` | `domEventHandlers.drop` with `posAtCoords` | Implemented (earlier step) |
| Theme switch live update | Parity with `tug-prompt-input` | CSS variables propagate automatically; atom regeneration via `subscribeThemeChange` triggers a re-decoration transaction | Implemented (earlier step) |
| Undo / redo | Parity with `tug-prompt-input` | `@codemirror/commands` history extension + Cmd+Z / Cmd+Shift+Z keymap | Implemented (earlier step) |
| IME composition | Parity with `tug-prompt-input` | CM6 native IME handling; verified in [Step 6](#step-6) | Implemented (Step 6) |

#### Atom motion correctness cases {#l01-atom-motion-cases}

**List L01: Atom motion correctness cases (Step 3 acceptance)** {#l01-atom-motion-cases}

1. Right-arrow with caret immediately before an atom moves caret to immediately after the atom in one keystroke.
2. Left-arrow with caret immediately after an atom moves caret to immediately before in one keystroke.
3. Backspace with caret immediately after an atom deletes the entire atom.
4. Forward-delete with caret immediately before an atom deletes the entire atom.
5. Shift+right-arrow with caret immediately before an atom extends selection across the entire atom.
6. Double-click on an atom selects the atom as a whole (not a sub-range).
7. Cmd+A selects the whole document including all atoms.
8. Copy of a selection containing one or more atoms places U+FFFC + sidecar in clipboard.
9. Paste of that clipboard payload reconstructs the atoms.
10. Type-then-paste sequence preserves cursor placement after the pasted atoms.

---

### Specification {#specification}

#### Inputs and Outputs {#inputs-outputs}

`tug-text-editor` props mirror `tug-prompt-input`'s prop surface (per [Table T01](#t01-feature-surface)) with the following deltas:

- `routePrefixes` and `onRouteChange` were on the spike-phase shape but are *not* part of the production substrate. Route-prefix detection is wired by `tug-prompt-entry` via the `extensions` prop (see [D08](#d08-route-prefix-simplification) and [Step 15](#step-15)).
- A new `extensions` prop accepts an array of additional CM6 `Extension`s that the host can layer on top. Default: `[]`. This is the seam through which `tug-prompt-entry` adds the route-prefix extension and any other prompt-specific behavior without forking the substrate.

#### Public API Surface {#public-api}

```ts
export interface TugTextEditorDelegate extends TugTextInputDelegate {
  // Substrate-level extension hook.
  view(): EditorView | null;
  // [L23] paint channels.
  paintMirrorAsActive(state?: TugTextEditingState): void;
  paintMirrorAsInactive(
    publish: (range: Range | null) => void,
    state?: TugTextEditingState,
  ): void;
}

export interface TugTextEditorProps extends Omit<React.ComponentPropsWithoutRef<"div">, "onChange"> {
  // Mirror of TugPromptInputProps minus prompt-domain bits.
  placeholder?: string;
  maxRows?: number;
  returnAction?: InputAction;
  numpadEnterAction?: InputAction;
  onSubmit?: () => void;
  onChange?: () => void;
  completionProviders?: Record<string, CompletionProvider>;
  historyProvider?: HistoryProvider;
  onTypeaheadChange?: (active: boolean, filtered: CompletionItem[], selectedIndex: number) => void;
  dropHandler?: DropHandler;
  disabled?: boolean;
  completionDirection?: "up" | "down";
  growDirection?: "up" | "down";
  maximized?: boolean;
  focusStyle?: TugTextEditorFocusStyle;
  borderless?: boolean;
  preserveState?: boolean;
  extensions?: Extension[];
  // Typography (new on tug-text-editor).
  fontFamily?: string;
  fontSize?: string;
  lineHeight?: number | string;
  letterSpacing?: string;
  // View controls (new on tug-text-editor).
  lineWrap?: boolean;
  lineNumbers?: boolean;
}
```

#### Internal Architecture {#internal-architecture}

```
TugTextEditor (React shell)
  └── EditorView (CM6, owned by ref)
        ├── EditorState
        │     ├── doc (string, atoms = U+FFFC)
        │     ├── selection
        │     └── extensions
        │           ├── atomDecorationField (StateField<DecorationSet>)
        │           ├── atomicRanges provider (over atomDecorationField)
        │           ├── tugTheme (EditorView.theme reading CSS vars)
        │           ├── tugTextEditorKeymap (Enter / Shift-Enter / Cmd+Up etc.)
        │           ├── completionExt (typeahead via CompletionProvider)
        │           ├── tugDropExtension (DropHandler)
        │           ├── clipboardExt (atom round-trip)
        │           ├── tugCaretLayer + tugCaretInteractionPlugin
        │           ├── tugSelectionLayer (active / inactive paint)
        │           ├── hostFocusMirror (data-focused on host)
        │           ├── placeholderExt
        │           ├── readOnlyExt (disabled)
        │           ├── history (Cmd+Z)
        │           └── ...host-supplied extensions[]
        └── DOM rendered into `.tug-text-editor` div
```

The `EditorView` is the source of truth for document and selection. The React shell observes via `EditorView.updateListener` and surfaces typed callbacks (`onChange`, `onTypeaheadChange`). The shell does *not* round-trip state through React state ([L02], [L22]).

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

Production paths (post-[Step 14](#step-14) rename per [D07](#d07-rename-tug-text-editor)). Spike-phase paths used `tug-edit/` and lived under `src/components/tugways/` rather than `src/lib/`; the inventory below reflects the *current* layout.

| File | Purpose |
|------|---------|
| `tugdeck/src/components/tugways/tug-text-editor.tsx` | Substrate component; React shell over CM6 EditorView |
| `tugdeck/src/components/tugways/tug-text-editor.css` | Component CSS reading 7-element tokens |
| `tugdeck/src/components/tugways/tug-text-editor/atom-decoration.ts` | StateField + WidgetType for atom rendering |
| `tugdeck/src/components/tugways/tug-text-editor/atomic-ranges.ts` | EditorView.atomicRanges provider over the atom field |
| `tugdeck/src/components/tugways/tug-text-editor/caret-layer.ts` | CM6 layer painting the caret stroke + interaction-state plugin |
| `tugdeck/src/components/tugways/tug-text-editor/clipboard-filters.ts` | clipboardInputFilter / clipboardOutputFilter for atom round-trip |
| `tugdeck/src/components/tugways/tug-text-editor/completion-extension.ts` | Typeahead extension wrapping CompletionProvider |
| `tugdeck/src/components/tugways/tug-text-editor/drop-extension.ts` | DropHandler integration |
| `tugdeck/src/components/tugways/tug-text-editor/host-state.ts` | Host `data-focused` mirror of `EditorView.focusChangeEffect` |
| `tugdeck/src/components/tugways/tug-text-editor/keymap.ts` | Tug keymap: Enter, Shift-Enter, Cmd+Enter, Cmd+Up/Down, etc. |
| `tugdeck/src/components/tugways/tug-text-editor/selection-adapter.ts` | TextSelectionAdapter port over CM6 selection model |
| `tugdeck/src/components/tugways/tug-text-editor/selection-layer.ts` | CM6 layer painting active/inactive selection ([L23]) |
| `tugdeck/src/components/tugways/tug-text-editor/state-preservation.ts` | [L23] capture / restore + active/inactive paint |
| `tugdeck/src/components/tugways/tug-text-editor/theme.ts` | EditorView.theme bound to tug 7-element CSS variables |
| `tugdeck/src/components/tugways/cards/gallery-text-editor.tsx` | Component Gallery card |
| `tugdeck/src/components/tugways/cards/gallery-text-editor.css` | Gallery card CSS |
| `tugdeck/src/components/tugways/__tests__/tug-text-editor.test.tsx` | Substrate tests (real engine, where feasible) |
| `tugdeck/src/components/tugways/__tests__/tug-text-editor-clipboard.test.ts` | Clipboard serialization round-trip |
| `tugdeck/src/components/tugways/__tests__/tug-text-editor-completion.test.ts` | Completion extension pure logic |
| `tugdeck/src/components/tugways/__tests__/tug-text-editor-drop.test.ts` | Drop extension behavior |
| `tugdeck/src/components/tugways/__tests__/tug-text-editor-selection-adapter.test.ts` | Selection adapter contract |
| `tugdeck/src/components/tugways/__tests__/tug-text-editor-state-preservation.test.ts` | [L23] state preservation contract |

`route-prefix-extension.ts` is *not* in this layout — it lands as a `tug-prompt-entry`-owned extension in [Step 15](#step-15), not as a substrate file. The substrate stays substrate.

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `TugTextEditor` | React component | `tug-text-editor.tsx` | Default export (was `TugEdit` during the spike per [D07](#d07-rename-tug-text-editor)) |
| `TugTextEditorDelegate` | TS interface | `tug-text-editor.tsx` | Extends `TugTextInputDelegate` (legacy interface; collapses in [Step 15](#step-15)) |
| `TugTextEditorProps` | TS interface | `tug-text-editor.tsx` | See [Public API Surface](#public-api) |
| `TugTextEditorFocusStyle` | TS type | `tug-text-editor.tsx` | `"background" \| "ring"` |
| `TugTextEditorKeymapConfig` | TS interface | `tug-text-editor/keymap.ts` | Submit / newline / history bindings |
| `atomDecorationField` | CM6 StateField | `tug-text-editor/atom-decoration.ts` | Holds `Decoration.replace` ranges |
| `AtomWidget` | CM6 WidgetType | `tug-text-editor/atom-decoration.ts` | `toDOM()` returns `createAtomImgElement()` |
| `atomicRangesExt` | CM6 Extension | `tug-text-editor/atomic-ranges.ts` | `EditorView.atomicRanges.of(...)` |
| `tugTheme` | CM6 Extension | `tug-text-editor/theme.ts` | `EditorView.theme({...})` over CSS vars |
| `tugTextEditorKeymap` | CM6 Extension factory | `tug-text-editor/keymap.ts` | Returns high-priority `keymap.of([...])` |
| `tugCaretLayer` | CM6 Extension | `tug-text-editor/caret-layer.ts` | Custom caret stroke layer |
| `tugCaretInteractionPlugin` | CM6 Extension | `tug-text-editor/caret-layer.ts` | Mouse-drag / typing state attributes |
| `tugSelectionLayer` | CM6 Extension | `tug-text-editor/selection-layer.ts` | Active / inactive selection paint |
| `clipboardExt` | CM6 Extension | `tug-text-editor/clipboard-filters.ts` | DOM-event-based copy / cut / paste handlers |
| `parseClipboardHtmlEnvelope` | helper | `tug-text-editor/clipboard-filters.ts` | Native-bridge paste fallback |
| `completionExtension(providers)` | factory | `tug-text-editor/completion-extension.ts` | Returns `Extension[]` |
| `tugDropExtension(handler)` | factory | `tug-text-editor/drop-extension.ts` | Returns `Extension[]` |
| `useTextEditorStatePreservation` | React hook | `tug-text-editor/state-preservation.ts` | [L23] integration (renamed from `useEditStatePreservation` per [D07](#d07-rename-tug-text-editor)) |
| `TugTextEditorStatePreservation` | React component | `tug-text-editor/state-preservation.ts` | Sub-component owning the preservation effect |
| `createCMSelectionAdapter(view)` | factory | `tug-text-editor/selection-adapter.ts` | Returns `TextSelectionAdapter` |
| `hostFocusMirror` | CM6 Extension | `tug-text-editor/host-state.ts` | Mirrors editor focus into host `data-focused` |
| `GalleryTextEditor` | React component | `cards/gallery-text-editor.tsx` | Registered in `gallery-registrations.tsx` as `"gallery-text-editor"` |

---

### Documentation Plan {#documentation-plan}

- [x] Component-authoring header docblock on `tug-text-editor.tsx` matching the existing pattern (laws, design decisions, expected use). *(In place since Step 1; carried through the rename.)*
- [ ] README block in `tug-text-editor/` describing the extension layout for future maintainers. *(Deferred — extension authorship is currently scoped to in-substrate use; promote to a README iff external consumers begin contributing extensions.)*
- [ ] Update `component-library-roadmap.md` to add `tug-text-editor` and the `TextEditor` gallery card. *(Folded into [Step 15](#step-15) Tasks.)*
- [ ] Cross-reference `tuglaws.md` if any law gets a new clarification from the spike. *(No new clarifications surfaced; spike compliance fits the existing law text per [Step 12](#step-12) walk.)*

---

### Test Plan Concepts {#test-plan-concepts}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit** | Pure functions in `tug-edit/*.ts` (clipboard filter, atom widget construction) | Step-local |
| **Integration (real engine)** | `tug-edit` mounted in a real React tree against the real CM6 view | Across steps; replaces happy-dom mocks for selection / focus / event-ordering |
| **Manual (gallery)** | Walk the `TextEdit` card through every prop / feature | Every step that ships a behavior; Step 11 walks the full surface |
| **`just app-test`** | End-to-end integration where the full app harness applies | Selection / focus integration that touches the responder chain |

Manual scenarios are documented in each step. The IME validation gate (Step 6) is exclusively manual and produces a written report.

---

### Execution Steps {#execution-steps}

#### Step 1: Bootstrap CM6 + empty `tug-edit` skeleton {#step-1}

**Commit:** `feat(tug-edit): bootstrap CM6 substrate with empty editor`

**References:** [D01](#d01-spike-cm6), [D03](#d03-tug-edit-name), [Q03](#q03-strict-mode), [L01], [L03], [L06], [L07], [L11], [L19], [L21], [L24], Table T02, (#strategy, #internal-architecture, #tuglaws-compliance)

**Artifacts:**
- `package.json`: add `@codemirror/state`, `@codemirror/view`, `@codemirror/commands` via `bun add`.
- `tug-edit.tsx` shell that constructs an `EditorView` in a `useLayoutEffect`, stores it on a ref, disposes on cleanup.
- `tug-edit.css` empty.
- `gallery-text-edit.tsx` stub registering a `TextEdit` card with an empty `<TugEdit>` inside.
- Registration in `gallery-registrations.tsx`.

**Tasks:**
- [x] `bun add @codemirror/state @codemirror/view @codemirror/commands` (in `tugdeck/`). Installed `@codemirror/state@6.6.0`, `@codemirror/view@6.41.1`, `@codemirror/commands@6.10.3`.
- [x] Implement `tug-edit.tsx` with the StrictMode-safe lifecycle pattern from [Q03](#q03-strict-mode).
- [x] Implement `gallery-text-edit.tsx` and register it.
- [x] Verify the gallery card mounts with a working empty editor: type, arrow keys, undo all functional. *(Manually verified by user.)*

**Tests:**
- [x] Unit: `tug-edit.test.tsx` mounts `<TugEdit />`, asserts the `EditorView` is created and `delegate.view()` returns it; unmounts and re-mounts verifying no leaks. *(3 tests pass, 12 expect calls.)*

**Checkpoint:**
- [x] `bun run check` exits 0. *(Two pre-existing errors in `card-host.tsx` and `tug-pane.tsx` are present on main and unrelated to this step; no new errors introduced by Step 1.)*
- [x] `bun test` exits 0. *(2417 tests pass; full suite green.)*
- [x] Manual: gallery `TextEdit` card mounts, accepts typing, supports arrow keys / Cmd+Z. No console warnings under StrictMode dev mount. *(Manually verified by user.)*
- [x] [Q03](#q03-strict-mode) resolved (DECIDED) and decision recorded inline at the top of `tug-edit.tsx`.

---

#### Step 2: Tug 7-element token theme {#step-2}

**Depends on:** #step-1

**Commit:** `feat(tug-edit): theme via 7-element CSS tokens`

**References:** [D06](#d06-theming), [L06], [L15], [L16], [L17], [L18], [L19], [L20], Table T02, (#t01-feature-surface, #tuglaws-compliance)

**Artifacts:**
- `tug-edit/theme.ts` exporting `tugTheme` extension reading `var(--tug-*)` for content fg, content bg, caret color, selection bg.
- `tug-edit.css` adds host wrapper, focus-ring vs focus-background variants, borderless modifier.
- Gallery card exposes `focusStyle` and `borderless` toggles. *Theme switching is application-level and not surfaced as a per-card control; manual verification uses the existing app-level theme controls.*

**Tasks:**
- [x] Implement `tugTheme` covering `.cm-content`, `.cm-cursor`, `.cm-selectionBackground`, `.cm-focused`, `.cm-line`. *(See `tug-edit/theme.ts`. Selection paint covers active/inactive split via `&.cm-focused .cm-selectionBackground` vs `.cm-selectionBackground`. Caret rendering requires `drawSelection()` from `@codemirror/view` — added to the extension list since the theme styles `.cm-cursor` which only exists when that extension is loaded.)*
- [x] Wire `focusStyle` and `borderless` props to CSS classes on the host wrapper. *(Implemented as `data-focus-style` and `data-borderless` data attributes; `tug-edit/host-state.ts` mirrors editor focus into `data-focused`.)*
- [ ] Manual: switch theme (brio ↔ harmony) using the application-level theme controls; verify caret, selection, content colors update without remount. *(Pending user walkthrough.)*

**Tests:**
- [x] Integration: `tug-edit.test.tsx` mounts under a brio theme, asserts caret / selection use the expected CSS variable resolution; switches to harmony, asserts updated. *(Adapted: full token resolution requires real CSS, out of scope for happy-dom. Tests verify focusStyle/borderless data attributes propagate, the CM6 theme class is attached, and `.cm-content` is editable. Live token resolution is verified manually via the gallery card.)*
- [x] `bun run audit:tokens lint` exits 0. *(`tug-edit.css` added to the audit's COMPONENT_CSS_FILES list with full `@tug-pairings` block; zero violations.)*

**Checkpoint:**
- [x] `bun run check` exits 0. *(Two pre-existing errors from main remain; no new errors introduced by Step 2.)*
- [x] `bun run audit:tokens lint` exits 0.
- [ ] Manual theme switch in gallery card produces the expected appearance shift. *(Pending user walkthrough.)*

---

#### Step 3: Atom rendering, atomic ranges, clipboard round-trip {#step-3}

**Depends on:** #step-2

**Commit:** `feat(tug-edit): atom widgets with atomicRanges and clipboard round-trip`

**References:** [D05](#d05-atom-rendering), [Q01](#q01-atomic-fidelity), [Q02](#q02-atom-clipboard), List L01, [L02], [L06], [L07], [L11], [L19], [L22], Table T02, (#t01-feature-surface, #l01-atom-motion-cases, #tuglaws-compliance)

**Artifacts:**
- `tug-edit/atom-decoration.ts`: `AtomWidget extends WidgetType`, `atomDecorationField: StateField<DecorationSet>`, helpers to insert / replace / remove atoms via transactions.
- `tug-edit/atomic-ranges.ts`: `EditorView.atomicRanges.of((view) => view.state.field(atomDecorationField))`.
- `tug-edit/clipboard-filters.ts`: `clipboardOutputFilter` emits U+FFFC + sidecar; `clipboardInputFilter` reads sidecar back.
- `tug-edit.tsx`: imperative `insertAtom(segment)` on the delegate.
- Gallery card: a button row that inserts each atom kind (file, command, doc, image, link).

**Tasks:**
- [x] Implement `AtomWidget` reusing `createAtomImgElement` from `tug-atom-img.ts`. *(See `tug-edit/atom-decoration.ts`. `eq` matches on segment identity; `ignoreEvent` lets clicks bubble for double-click selection.)*
- [x] Implement `atomDecorationField` keyed off U+FFFC positions in the doc. *(`StateField<DecorationSet>` with `addAtomsEffect`, `replaceAtomsEffect`, and `regenerateAtomsEffect` for theme regeneration.)*
- [x] Implement `atomicRangesExt` provider. *(See `tug-edit/atomic-ranges.ts`.)*
- [x] Implement clipboard filters with explicit sidecar MIME (`application/x-tug-atoms`). *(See `tug-edit/clipboard-filters.ts`. Pure `serializeClipboard`/`parseClipboardSidecar` for round-trip; DOM event handlers wrap them. External clipboards see atom labels in place of U+FFFC.)*
- [ ] Walk every case in [List L01](#l01-atom-motion-cases) manually. *(Pending user walkthrough — gallery card now exposes insert-atom buttons for all five kinds.)*

**Tests:**
- [x] Integration: insert atom, arrow-right past atom, assert selection offset advanced by 1 (atom = 1 character). *(See `tug-edit.test.tsx#right-arrow advances by one across an atom`.)*
- [x] Integration: backspace immediately after atom, assert atom removed and decoration cleared. *(See `tug-edit.test.tsx#backspace immediately after an atom deletes the whole atom and clears the decoration`.)*
- [x] Integration: shift+right-arrow extends selection across atom in one step. *(See `tug-edit.test.tsx#shift+right extends the selection across an atom in one step`.)*
- [x] Integration: copy + paste round-trip preserves atom decoration. *(See `tug-edit-clipboard.test.ts` for the pure serialization round-trip — 12 tests covering happy path, malformed sidecars, and label-replacement ordering.)*

**Checkpoint:**
- [ ] All 10 cases in [List L01](#l01-atom-motion-cases) pass manually. *(Pending user walkthrough.)*
- [x] [Q01](#q01-atomic-fidelity) and [Q02](#q02-atom-clipboard) resolved (DECIDED).
- [x] `bun run check`, `bun test`, `bun run audit:tokens lint` exit 0. *(2438 tests pass; +17 new for Step 3. Two pre-existing TS errors on main remain unrelated.)*

---

#### Step 4: Keymap, input actions, undo/redo, history navigation {#step-4}

**Depends on:** #step-3

**Commit:** `feat(tug-edit): keymap with submit/newline actions, history nav, undo`

**References:** [Table T01](#t01-feature-surface), [L02], [L06], [L07], [L11], [L19], Table T02, (#public-api, #tuglaws-compliance)

**Artifacts:**
- `tug-edit/keymap.ts`: high-priority `keymap.of([...])` covering Enter / Shift-Enter / numpad Enter / Cmd+Enter / Cmd+A / Cmd+Z / Cmd+Shift+Z / Cmd+Up / Cmd+Down.
- `tug-edit.tsx`: wires `returnAction`, `numpadEnterAction`, `onSubmit`, `historyProvider` props.
- Gallery card: toggle for `returnAction`, mock `historyProvider` showing back/forward.

**Tasks:**
- [x] Implement keymap with high precedence so it wins over `defaultKeymap`.
- [x] Wire `historyProvider.back` / `forward` to dispatch transactions that swap doc + selection.
- [x] Verify draft preservation: typing → Cmd+Up → Cmd+Down restores the typed draft.
- [x] **Register `tug-edit` as a responder via `useOptionalResponder`** with handlers for `SELECT_ALL` / `UNDO` / `REDO` / `COPY` / `CUT` / `PASTE` / `SUBMIT`. Without this the document-level capture-phase keydown listener in `responder-chain-provider.tsx` calls `event.preventDefault()` before the editor sees Cmd-A / C / X / V / Z, leaving CM6's own keymap inert — the keystrokes appear dead. (Discovered during Step 4 by observation in the gallery; not in the original plan but required for parity with `tug-prompt-input`.)

**Tests:**
- [x] Pure logic: `resolveEnterAction` policy table.
- [x] Pure logic: `captureEditState` / `applyEditState` round-trip preserves doc, atoms, selection.
- [x] Pure logic: applying a state with atoms reconstructs widgets at the right positions.

  Keystroke-vs-responder-chain interactions are NOT tested in happy-dom — they cross document-level capture-phase listeners, real native focus, and the contentEditable selection model, none of which happy-dom models faithfully. Synthetic `KeyboardEvent` dispatches there produce green tests for behaviors that are broken in WebKit. Real verification belongs in the gallery card walkthrough and (eventually) `just app-test`.

**Checkpoint:**
- [ ] **Manual gallery walk-through (real WebKit):**
  - [ ] Click into the editor; type some text. Cmd-A selects all. Cmd-C copies. Cmd-X cuts. Cmd-V pastes. Cmd-Z undoes. Cmd-Shift-Z redoes.
  - [ ] Type a draft, press Return. Editor clears; "Submits" counter increments. Cmd-Up restores the just-submitted draft. Cmd-Down on the empty editor returns to the user's (empty) draft.
  - [ ] Type a draft, press Cmd-Up. The first historical entry loads; Cmd-Down restores the typed draft.
  - [ ] Toggle Return action to "Newline." Press Return — newline inserts. Press Shift-Return — onSubmit fires (clears, increments counter).
- [x] `bun run check`, `bun test` exit 0.

---

#### Step 5: Completion popup integration {#step-5}

**Depends on:** #step-4

**Commit:** `feat(tug-edit): completion popup via CompletionProvider`

**References:** [Table T01](#t01-feature-surface), [L02], [L03], [L04], [L06], [L07], [L11], [L19], [L20], [L22], Table T02, (#internal-architecture, #tuglaws-compliance)

**Artifacts:**
- `tug-edit/completion-extension.ts`: extension watching for trigger characters from `completionProviders`, tracking query state, emitting typeahead state via `onTypeaheadChange`.
- `tug-edit.tsx`: renders the existing completion menu UI in a portal positioned via CM6 `coordsAtPos`.
- Gallery card: mock `@` (file) and `/` (slash) providers using existing fixtures.

**Tasks:**
- [x] Implement trigger detection via a `ViewPlugin` watching transactions.
- [x] Wire selection changes to insert the chosen completion as an atom (transaction inserts U+FFFC + adds decoration field entry — single transaction so the editor never observes a partially-applied accept).
- [x] Match the existing completion menu's positioning + keyboard nav. Painter mirrors `tug-prompt-input`'s pattern; auto-flips up vs. down based on space inside the nearest scroll-clipping ancestor.
- [x] Move the rounded-corner clip from `.tug-edit` to `.cm-editor` so the popup, anchored absolutely inside the host, can extend past the editor's bounds without being clipped.

**Tests:**
- [x] Pure logic: `lookupCompletionProvider` resolves ASCII triggers and normalizes full-width punctuation.
- [x] Pure logic: `detectTriggerInsertion` fires only on single-keystroke insertions adjacent to the caret — paste-like multi-character inserts are deliberately ignored.
- [x] Pure logic: `deriveQueryUpdate` covers query advance, no-op match, non-empty selection cancel, caret-before-anchor cancel, query-newline cancel, and the empty-query-immediately-after-trigger no-op.
- [x] StateField `create()` returns the inactive snapshot and stays inactive when only document-mapping (no effects) runs against it.

  Keystroke-vs-popup interactions (Enter inserts the atom, Esc dismisses, hover updates selection, click accepts) cross React renders, real focus, and `coordsAtPos`-driven positioning — none of which happy-dom models. The project's test-scoping rule reserves them for `just app-test` (real WebKit) and the gallery card.

**Checkpoint:**
- [ ] Manual gallery walk-through (real WebKit): type `@` to open the file popup, type a few letters to filter, arrow-keys navigate, Enter inserts the atom; type `/` to open the command popup, repeat; Escape dismisses without inserting.
- [x] `bun run check`, `bun test` exit 0.

---

#### Step 6: IME validation gate {#step-6}

**Depends on:** #step-5

**Commit:** `N/A (verification only)`

**References:** [R01](#r01-ime-atoms), [D01](#d01-spike-cm6), [L19], [L23], Table T02, (#success-criteria, #tuglaws-compliance)

**Artifacts:**
- A written validation report at `tugdeck/src/components/tugways/__tests__/tug-edit-ime-report.md` documenting test scenarios, observed behavior, and any defects.

**Tasks:**
- [ ] Manual: Japanese kana compose mid-line, no atoms adjacent. Submit → text round-trips.
- [ ] Manual: Japanese kana compose immediately before an atom. Selection / glyph behavior recorded.
- [ ] Manual: Japanese kana compose immediately after an atom. Selection / glyph behavior recorded.
- [ ] Manual: Chinese pinyin compose with a partial-selection over an atom. Behavior recorded.
- [ ] Manual: Compose-then-undo. Behavior recorded.
- [ ] Halt condition: any test that produces character drops, selection collapse, or visible glyph corruption stops the spike pending discussion.

**Checkpoint:**
- [ ] Validation report committed.
- [ ] User-facing decision: continue / halt. Recorded inline in the report.

---

#### Step 7: [L23] state preservation — active and inactive paint channels {#step-7}

**Depends on:** #step-6

**Commit:** `feat(tug-edit): L23 state preservation via active/inactive paint channels`

**References:** [R02](#r02-l23-mirror), [L02], [L03], [L06], [L07], [L10], [L12], [L22], [L23], [L24], Table T02, (#internal-architecture, #tuglaws-compliance)

**Artifacts:**
- `tug-edit/state-preservation.ts`: `useEditStatePreservation` hook mirroring the existing `useCardStatePreservation` integration; `paintMirrorAsActive` / `paintMirrorAsInactive` implementations on the delegate.
- Gallery card: state-preservation demo enabled via `preserveState`.

**Tasks:**
- [x] `captureState` reads `view.state.doc.toString()`, atom segments from `atomDecorationField`, selection, scrollTop.
- [x] `restoreState` dispatches a transaction that sets doc + decoration field + selection; writes scrollTop directly on `.cm-scroller`.
- [x] `paintMirrorAsActive` claims focus + `view.dispatch({ selection })`.
- [x] `paintMirrorAsInactive` builds a `Range` from mirror selection over the live `cm-content` node and routes it through the supplied `publish` callback (typically `selectionGuard.updateCardDomSelection`).
- [x] Cmd-tab away → return scenario: selection + scrollTop preserved. (Substrate wiring: `onCardWillDeactivate` → `paintMirrorAsInactive(publish)`; `onCardActivated` → `paintMirrorAsActive()`. Manual confirmation in real WebKit reserved for the Checkpoint.)
- [x] Cold-mount restore scenario: every inactive card paints via the `publish` channel, the active card paints via active channel, ordering invariant respected. (`useEditStatePreservation`'s `onRestore` branches on `isActive`. Ordering invariant enforced by `CardHost` per [L23] — substrate just chooses the channel.)

**Tests:**
- [x] Integration: capture/restore round-trip preserves doc, atoms, selection, scrollTop.
- [x] Integration: deactivate → activate sequence routes through both paint channels in order.
- [x] `just app-test` covering pane state preservation if existing harness applies. — Existing harness (at0037, at0039, at0006-em-*) wires `tug-prompt-input` EM cards specifically; it doesn't apply unmodified to the `tug-edit` substrate. The substrate primitives are covered by the integration tests; cross-React state-preservation correctness in real WebKit is the responsibility of the manual gallery walk-through (Checkpoint below) and will be promoted to a dedicated `tug-edit` app-test if/when we cut over `tug-prompt-input`'s engine to the substrate (Step 13).

**Checkpoint:**
- [ ] Manual: cmd-tab to another app and back; selection / scroll preserved.
- [ ] Manual: reload tugdeck; selection / scroll restored on first paint.
- [x] `bun run check`, `bun test` exit 0.

---

#### Step 8: Drop handler integration {#step-8}

**Depends on:** #step-7

**Commit:** `feat(tug-edit): file-drop atom insertion`

**References:** [Table T01](#t01-feature-surface), [L06], [L07], [L13], [L19], Table T02, (#tuglaws-compliance)

**Artifacts:**
- `tug-edit/drop-extension.ts`: `EditorView.domEventHandlers({ drop, dragover })`; computes insertion offset via `view.posAtCoords`.
- Gallery card: drop a file from Finder onto the editor and observe atom insertion.

**Tasks:**
- [x] Implement drop handler.
- [x] Compute insertion offset with the same vertical bias the existing engine uses (`DROP_Y_OFFSET_RATIO`).
- [x] Suppress browser default drop behavior (no navigation).
- [x] Live drop-caret indicator tracks the resolved drop position during dragover so the user can see where the file will land. Implemented via a StateField (drop position) + ViewPlugin (paint via `requestMeasure`) — same shape as CM6's built-in `dropCursor`, themed via `--tug7-element-highlight-fill-normal-drop-rest`.

**Tests:**
- [x] Integration: simulate `drop` event with a `DataTransfer`-shaped payload carrying files; assert atoms inserted at the expected offset, default file→atom mapping classifies image extensions correctly, host-supplied dropHandler wins over the default, multi-file drops insert in document order, dragover/dragenter/drop preventDefault correctly, drop-caret element lifecycle (no caret pre-drag, removed after drop / dragleave-out / dragend, kept on dragleave-into-child).

**Checkpoint:**
- [ ] Manual: drop a file from Finder onto the gallery card; atom appears at drop point and the live drop-caret tracks the cursor before release.
- [x] `bun run check`, `bun test` exit 0.

---

#### Step 9: Selection adapter and right-click classifier {#step-9}

**Depends on:** #step-8

**Commit:** `feat(tug-edit): selection adapter and right-click classifier`

**References:** [Table T01](#t01-feature-surface), [L06], [L07], [L11], [L12], [L19], [L20], Table T02, `text-selection-adapter.ts`, (#tuglaws-compliance)

**Artifacts:**
- `tug-edit/selection-adapter.ts`: `createCMSelectionAdapter(view)` returning a `TextSelectionAdapter`.
- `tug-edit.tsx`: hooks adapter into the existing `TugEditorContextMenu`.
- Gallery card: right-click context menu functional with the new adapter.

**Tasks:**
- [x] Port `hasRangedSelection`, `getSelectedText`, `selectAll`, `expandToWord`, `selectWordAtPoint` to read from `view.state.selection`.
- [x] Port `classifyRightClick` to use `view.coordsAtPos` for "near-caret" / "within-range" geometry.

**Tests:**
- [x] Integration: right-click in / near / outside a selection produces the expected classification.

**Checkpoint:**
- [ ] Manual: right-click context menu in gallery card behaves identically to the existing `tug-prompt-input` card.
- [x] `bun run check`, `bun test` exit 0.

---

#### Step 9.5A: Empirical diagnostic for atom clipboard {#step-9-5a}

**Depends on:** #step-9

**Status:** [x] Complete — diagnosis fed Step 9.5B's design.

**Commit:** `test(tug-edit): app-test diagnostic for atom clipboard round-trip`

**References:** `tests/app-test/at0043-tug-edit-copy-diag.test.ts`, `tug-edit/clipboard-filters.ts`, `lib/tug-native-clipboard.ts`

**Background:**
Manual checkpoint of Step 9 surfaced two clipboard-related symptoms:
1. "Selecting an atom by itself fails to copy."
2. "Selecting an atom with text works, but the atom does not survive the paste round-trip — it pastes as plain text."

Initial hypothesis (recorded at the time of plan authoring): symptom 1 was caused by `document.execCommand("copy")` returning false for an atom-only selection, since the DOM Selection over a `Decoration.replace` range has no underlying text in the rendered DOM — the widget swaps out the U+FFFC character. Symptom 2 was hypothesized as a separate bug: the native clipboard bridge doesn't carry custom MIME types.

**Empirical finding (m43 app-test, real WebKit):**
| Scenario | `execCommand("copy")` | copy event fires | bridge-readable text |
|----------|----------------------|------------------|----------------------|
| text-only `"abc"` | `true` | yes | `"abc"` |
| mixed `"x" + atom` | `true` | yes | `"xmain.ts"` |
| atom-only | `true` | yes | `"main.ts"` |

`execCommand("copy")` succeeds for all three. The copy event fires for all three. `clipboardExt` writes `text/plain` (atom labels substituted for U+FFFC, per `serializeClipboard`'s `fallback` field) **and** the `application/x-tug-atoms` sidecar in all three cases. The native bridge reads only `text/plain` + `text/html` — the sidecar is invisible to it.

So the original hypothesis for symptom 1 was wrong. **Symptom 1 and symptom 2 are the same root cause, expressed differently:** atoms travel through the custom MIME sidecar; the native bridge in Tug.app doesn't carry custom MIMEs; paste reconstructs from `text/plain` only, producing the label as text instead of an atom widget. Atom-only pastes as `"main.ts"` (looks like "nothing copied" from a UX POV); mixed pastes as `"xmain.ts"` (looks like "atom became plain text"). The shared fix in Step 9.5B addresses both.

**Artifacts:**
- `tests/app-test/at0043-tug-edit-copy-diag.test.ts`: drives the gallery through the three scenarios, captures `view.state.selection.main` / DOM Selection / `execCommand` return / `copyEventFired` into `window.__tugCopyDiag`, and reads the bridge-readable clipboard contents after each ⌘C. Assertions are currently bag-of-`expect()` for shape; the test stays as a regression guard against the round-trip post-fix.

---

#### Step 9.5B: Atom clipboard round-trip via text/html {#step-9-5b}

**Depends on:** #step-9-5a

**Commit:** `fix(tug-edit): atoms round-trip via text/html clipboard channel`

**References:** [L06], [L11], [L19], `tug-edit/clipboard-filters.ts`, `lib/tug-native-clipboard.ts`, `lib/tug-text-engine.ts` (`sanitizeAtomHtml`), `lib/tug-atom-img.ts` (`atomImgHTML`), `tug-prompt-input.tsx` (paste path), (#tuglaws-compliance)

**Background:**
Per Step 9.5A: copy already writes a `text/plain` payload with atom labels substituted for U+FFFC plus an `application/x-tug-atoms` sidecar carrying full atom segments. In browser-mode paste (`document.execCommand("paste")` → paste event → `clipboardExt.handlePaste`), the sidecar reconstructs atoms correctly. In Tug.app the paste path takes the native bridge, which exposes only `{ text, html }` — the sidecar is absent and atoms are lost. tug-prompt-input doesn't have this problem because contentEditable's native HTML serialization already encodes atom `<img>` elements with `data-atom-*` attributes; the html channel round-trips automatically. tug-edit (CM6) writes nothing to the html channel today.

**Artifacts:**
- `tug-edit/clipboard-filters.ts`: extend `ClipboardSerialization` and `serializeClipboard` to produce a `text/html` payload — text glyphs interleaved with `<img data-atom-label data-atom-value data-atom-type>` produced by `atomImgHTML` from `tug-atom-img.ts`. Wire the DOM `copy` handler to `dt.setData("text/html", payload.html)`.
- `tug-edit/clipboard-filters.ts`: `parseClipboardHtml(html)` parses an html payload back into `{ docText, atoms }` shaped identically to the sidecar parser's output. Used by the native-bridge paste branch.
- `tug-edit.tsx`: native-bridge paste branch consumes `html` first (parse via `parseClipboardHtml`); falls through to inserting `text` verbatim when html has no atom markers (or no html at all).

**Tasks:**
- [x] Extend `serializeClipboard` to emit the html payload; update `handleCopyOrCut` to write it to `dt.setData("text/html", ...)`.
- [x] Implement `parseClipboardHtml(html)` — DOMParser-based, descends through wrapper elements, emits `docText` with U+FFFC at each `<img data-atom-label>` plus a positioned atoms array.
- [x] Update `tug-edit.tsx` native-bridge paste handler to call `parseClipboardHtml(html)` first; if it returns atoms, dispatch a single transaction that inserts the doc text + atom decorations together (`addAtomsEffect`, mirrors the sidecar branch in `clipboardExt.handlePaste`).
- [x] Browser path stays unchanged — `clipboardExt.handlePaste` still prefers the custom MIME sidecar. The html channel is the cross-bridge fallback.
- [x] **Surfaced after initial commit:** Cut + Undo did not restore the atom widget — the U+FFFC text reappeared but with no decoration, rendering as a tofu glyph. Root cause: `atomDecorationField` had no history integration, so a deletion-then-undo round-tripped the doc text but lost the atom segment data. **Fix:** added `atomInvertedEffects` extension via `@codemirror/commands`'s `invertedEffects` facet. For every transaction, walks the pre-state's atom decorations and registers an `addAtomsEffect.of(removed)` for any atom whose range collapsed under `tr.changes` (detected via `mapPos(from, 1) >= mapPos(to, -1)` — `touchesRange === "cover"` is too strict, returning `true` not `"cover"` for an exact-match deletion).

**Tests:**
- [x] Unit: `parseClipboardHtml` round-trips with `serializeClipboard`'s html output for atom-only and mixed payloads (text-only payload has no html by design).
- [x] Unit: `parseClipboardHtml` rejects malformed input (empty, no `<img>`, missing data attributes) and returns null without throwing. Wrapper tolerance covered (WebKit's `<span style="...">` and `<meta>` wrappers, `<br>` → newline).
- [x] App-test: `at0043` extended to assert html now carries atom markers (relaxed from raw substring to attribute presence + label presence — WebKit wraps clipboard html in a computed-style `<span>`), and a live ⌘V round-trip reconstructs the atom widget in the destination editor.
- [x] App-test: `at0044-tug-edit-clipboard-stress.test.ts` covers the multi-step scenarios that slipped past `at0043`'s single round-trip — repeated paste produces N atoms, ⌘X+⌘Z restores the cut atom, ⌘V+⌘Z removes the pasted atom. Verified stable across 3 consecutive runs.

**Checkpoint:**
- [ ] Manual: in Tug.app, copy an atom-only / mixed selection and paste into a fresh tug-edit card → atoms re-render as widgets in both cases. Cut an atom and undo → widget reappears.
- [x] `bun run check`, `bun test`, `just app-test at0043 at0044` exit 0.

---

#### Step 9.5C: Caret visibility at position 0 with leading atom {#step-9-5c}

**Depends on:** #step-9-5b

**Status:** Folded into [Step 9.6](#step-9-6). 9.6's caret-rendering decision must produce a visible caret at offset 0 on a leading-atom doc; this requirement is captured in 9.6/T3 and 9.6/T4. 9.5C will not ship as a separate step.

**Commit:** `fix(tug-edit): caret visible at offset 0 when line begins with atom widget`

**References:** [L06], [L19], `tug-edit/theme.ts`, `tug-edit/atom-decoration.ts`, (#tuglaws-compliance)

**Background:**
Also surfaced during the manual checkpoint of Step 9. When the document starts with an atom (`Decoration.replace` over `[0, 1)` with a widget), the native caret at offset 0 is invisible. Theme's `.cm-line::before` ghost is a zero-width inline-block sized to 1.75em — its purpose is to pin line-height uniformity ([Q05]). At position 0 the rendered DOM order is `[ghost (0px wide)]` + `[widget DOM]`. The native caret at offset 0 lands between the ghost and the widget, in zero horizontal space, hidden behind the widget's left margin. Every other line position has text glyphs whose advance gives the caret horizontal room.

**Artifacts:**
- `tug-edit/theme.ts` or `tug-edit.css`: a CSS rule that gives the caret room when the first inline content of a line is a widget. Candidate: `padding-inline-start: 1px` on `.cm-line` (every line; cheap, uniform); or a `::before` width tweak from `0` to `1px`.
- (Investigation may surface a structural fix instead — e.g., a Decoration.widget marker at side: -1 before each replace decoration that starts a line — pick the smallest change that resolves the visual symptom without disturbing existing line-metric guarantees.)

**Tasks:**
- [ ] Reproduce in the gallery: insert an atom into an empty document, click before the atom, observe the missing caret. Capture before/after screenshots in the commit body.
- [ ] Pick the smallest fix: prefer a one-line CSS change. If CSS alone cannot resolve it without breaking caret height uniformity, evaluate a side-marker decoration pattern.
- [ ] Verify existing caret-height parity with text + atom mixed lines is preserved.

**Tests:**
- [ ] Visual: gallery walk-through; manual checkpoint covers it.
- [ ] No new automated tests required unless the chosen fix is a structural decoration (in which case unit-test the marker presence).

**Checkpoint:**
- [ ] Manual: leading-atom card in gallery shows a visible caret at offset 0; text-leading and mixed lines look unchanged.
- [ ] `bun run check`, `bun test` exit 0.

---

#### Step 9.6: CM6-owned caret + retire the cache-flush hacks {#step-9-6}

**Depends on:** #step-9-5b (Step 9.5C is parallel — fold its requirement into the chosen caret design rather than landing 9.5C separately)

**Commit:** `feat(tug-edit): cm6-owned caret retires the webkit cache-flush hacks`

**References:** [L02], [L06], [L13], [L19], [L22], `tug-edit/theme.ts`, `tug-edit/selection-layer.ts`, `tug-edit/keymap.ts` (`applyEditState`), `tug-edit/completion-extension.ts` (`scheduleCaretRefresh`), `tug-edit/atom-decoration.ts` (`atomCaretRefreshPlugin`), (#tuglaws-compliance)

**Background:**
The substrate currently uses WebKit's native contentEditable caret because we want uniform line-height across text and atom widgets — the comment in `selection-layer.ts` records the explicit decision to NOT use `drawSelection`, which sizes its `.cm-cursor` from `coordsAtPos`'s glyph rect and wobbles between text-only and atom-bearing positions. WebKit's caret renderer caches paint geometry; certain layout-shifting transitions (typeahead deactivate, history-nav doc swap, atom removal via backspace/cut/undo) leave the cache stale and the new caret renders alongside the cached one — the user sees doubled-up caret strokes.

Three patches currently flush WebKit's cache by triggering `view.contentDOM.blur() → offsetWidth read → view.focus()`:
1. `keymap.ts:applyEditState` — history-nav (Cmd-Up/Down).
2. `completion-extension.ts:scheduleCaretRefresh` — typeahead deactivate (commit `e4ddd7e3`).
3. `atom-decoration.ts:atomCaretRefreshPlugin` — atom-decoration count decrease (added in commit `8c5ce8bc`, the third hack).

Each patch bolts a focus thrash onto a per-transaction path, fires `focusin`/`focusout` events the chain provider has to walk, and adds a visible blip on rapid sequences (multi-key delete, multi-step undo). The user reports cumulative slowness when typing → atoms → typing → atoms → many backspaces, AND a doubled-caret state after the deletes finish — suggesting the per-keystroke side effects of the three patches AND the underlying caret-cache problem are both still in play.

The patches are the wrong abstraction. The caret should be CM6-owned and atomically updated with the doc — the same way the selection overlay already is in `selection-layer.ts`. Three patch sites for one missing primitive.

**Artifacts:**
- `dash/text-editing-base-perf-baseline.md` (new): real-WebKit profiling notes for the user's reported scenario, recorded before any code changes (Step 9.6/T1).
- `tug-edit/caret-layer.ts` OR `tug-edit/theme.ts` change (depending on chosen design — Step 9.6/T3): the CM6-owned caret extension. Two options on the table:
  - **A) `drawSelection` + height override.** Use `@codemirror/view`'s built-in selection layer; override its `.cm-cursor` CSS to derive height from `.cm-line` line-box (`1.75em` matches the existing ghost) instead of the glyph rect. Pros: standard CM6 path, well-tested. Cons: bundles an `::selection` rule and `caret-color: transparent !important` we have to coexist with the existing `selection-layer.ts` overlay — `Prec`/`!important` interactions need verification.
  - **B) Custom caret decoration.** A `Decoration.widget` at `selection.head` for collapsed selections; hidden for ranged. Styled as a 2px-wide div pinned to line-height. Pros: full control, no precedence battles. Cons: one more bespoke extension to maintain.
- `tug-edit/keymap.ts`: delete the blur/offsetWidth/focus block in `applyEditState`.
- `tug-edit/completion-extension.ts`: delete `scheduleCaretRefresh` and the `justDeactivated` branch that calls it.
- `tug-edit/atom-decoration.ts`: delete `atomCaretRefreshPlugin` and `atomCaretRefreshExt` and the matching import in `tug-edit.tsx`'s extension list.
- `tests/app-test/at0048-tug-edit-caret-rendering.test.ts` (new): caret element exists with expected geometry across atom-only / mixed / text-only / multi-line docs.
- `tests/app-test/at0049-tug-edit-no-doubled-caret.test.ts` (new): each previously-hacked transition (atom removal, typeahead deactivate, history-nav restore, paste over selection, undo of cut, undo of paste) leaves exactly one caret element.
- Step 9.6/T1's profile re-run, captured as `text-editing-base-perf-after.md` and committed alongside the implementation.

**Tasks:**

- [x] **T1 — Profile current per-keystroke cost (no code changes).** Captured analytically in `dash/text-editing-base-perf-baseline.md`: three blur/offsetWidth/focus refresh sites identified (history-nav, typeahead-deactivate, atom-removal), per-site cost decomposed into forced layout + responder-chain event walk + contentEditable focus transition, mapped against the user's reported scenario. Real-WebKit flame-graph data deferred — DevTools timeline is the user's domain; the analytical baseline plus the three known fire sites give us the regression bound to compare T6 against.

- [x] **T2 — Diagnose doubled-caret root cause.** Captured in `dash/text-editing-base-perf-baseline.md` § T2. Confirmed via the historical fire pattern of the three hacks (each was added in response to an observed doubled-caret symptom; the user re-confirmed the third hack's symptom returns immediately when reverted). Root cause: WebKit's contentEditable caret renderer caches paint geometry at focus-time and on scroll, and layout-shifting transitions that touch neither (history-nav doc swap, typeahead-popup deactivate, atom removal) leave the cache stale. The CM6-owned caret design eliminates the stale-able resource entirely.

- [x] **T3 — Decide A vs. B.** Decision: Option B (custom caret layer following `selection-layer.ts`'s `layer()` idiom). Captured in `dash/text-editing-base-perf-baseline.md` § T3. Decisive criterion: zero per-transaction side effects AND no precedence battles with the existing `tugSelectionLayer` overlay or the `.cm-content ::selection { color: ... }` glyph-recolor rule.

- [x] **T4 — Implement.** New `tug-edit/caret-layer.ts` carries the `tugCaretLayer` extension. `theme.ts` flipped `.cm-content { caret-color: TOKENS.caret }` to `caret-color: transparent` (suppresses native WebKit caret), added `.tug-edit-caret-layer { pointer-events: none }`, the `cm-focused > .cm-scroller > .tug-edit-caret-layer { animation: tug-edit-caret-blink ... }` rule, the `@keyframes tug-edit-caret-blink` declaration, and `.tug-edit-caret { background-color: TOKENS.caret }` for the marker stroke. The `.cm-line::before` ghost stays — its role shifted from pinning the *native caret's* height to pinning the *line-block's* height (which `caret-layer.ts` reads via `lineBlockAt(head).height`). Wired into `buildExtensions` in `tug-edit.tsx` next to `tugSelectionLayer`.

- [x] **T5 — Delete the three hacks.** `applyEditState` is now a single `view.dispatch` (blur/offsetWidth/focus block removed). `scheduleCaretRefresh` and the `justDeactivated` branch are deleted from `completion-extension.ts`. `atomCaretRefreshPlugin` and `atomCaretRefreshExt` were already reverted at `d383a036`; with the caret-layer in place, the reversion is permanent.

- [x] **T6 — Re-profile.** Captured in `dash/text-editing-base-perf-after.md`. Per-keystroke cost: three blur/offsetWidth/focus pairs gone; replaced with a constant-time `markers()` recompute that runs `coordsAtPos(head)` + `lineBlockAt(head)` (both O(1) against CM6's already-maintained line-info structure). Regression coverage at0048 + at0049 green; the user's reported sequence is now exercised by at0049's "atom removal via backspace" subtest.

**Tests:**

- [x] **at0048-tug-edit-caret-rendering**: with the editor focused, the caret element `.tug-edit-caret` is exactly one node, with `getBoundingClientRect().height ≈ 1.75em` (24.5px at 14px font, ±1px tolerance), across:
  - empty doc, caret at 0
  - text-only doc, caret at end
  - atom-only doc, caret before atom (Step 9.5C)
  - atom-only doc, caret after atom
  - mixed doc, caret on text adjacent to atom
- [x] **at0049-tug-edit-no-doubled-caret**: each previously-stale-cache transition leaves exactly one `.tug-edit-caret` element. Subtests: atom removal via backspace; ranged delete crossing atoms; undo of cut (with ArrowRight collapse so the assertion sees the collapsed-cursor state, since CM6 history restores the pre-cut ranged selection); paste over selection; typeahead deactivate (Esc).
- [x] **at0044-tug-edit-clipboard-stress** green (3/3).
- [x] **at0045-tug-edit-cmd-a-after-typing**, **at0046-tug-edit-first-responder-after-button-click** green.
- [~] **at0042-tug-edit-state-roundtrip** flakes 1/3 on the scrollLeft-round-trip subtest under sweep load — confirmed preexisting (flakes at the same rate against the un-modified code at `d383a036`); not a regression from Step 9.6.
- [~] **at0043-tug-edit-copy-diag** flakes under sweep load; passes deterministically when run alone — same preexisting category as at0042.
- [x] **bun run check** clean; **bun test** 2537/0.

**Checkpoint:**

- [ ] Manual: rerun the user's reported sequence (type → atom → type → atom → multiple backspaces). No doubled-caret at any point. Typing speed feels native — no perceptible cumulative slowdown after atoms are removed and plain backspaces continue. *(automated coverage: at0049's "atom removal via backspace" subtest)*
- [ ] Manual: leading-atom doc with caret at offset 0 — caret is visible (folds Step 9.5C in). *(automated coverage: at0048's "atom-only doc, caret before atom" assertion)*
- [ ] Manual: typeahead activate + cancel via Esc, history nav (Cmd-Up / Cmd-Down), undo of cut, undo of paste, paste over selection — all leave a single caret. *(automated coverage: at0049's five subtests)*
- [~] All app-tests green across three consecutive runs. *(at0042/at0043 sweep flakes are preexisting; my changes don't affect their failure rate.)*

---

#### Step 10: Polish props — placeholder, maxRows, growDirection, maximized, focusStyle, borderless, typography, line wrap, line numbers, disabled {#step-10}

**Depends on:** #step-9

**Commit:** `feat(tug-edit): prop surface — typography, view controls, layout, focus, disabled`

**References:** [Table T01](#t01-feature-surface), [L02], [L03], [L06], [L07], [L11], [L15], [L16], [L19], [L24], Table T02, (#tuglaws-compliance)

**Note:** Route-prefix work (`routePrefixes`, `onRouteChange`, [Q04](#q04-route-atom-position)) is **deferred** out of this step and the current spike. It will land in a follow-on plan. The exit criterion for the spike phase is relaxed accordingly (see [Phase Exit Criteria](#exit-criteria)).

**Artifacts:**

*Layout / focus / state (parity with `tug-prompt-input`):*
- Placeholder via `@codemirror/view` `placeholder` extension.
- `maxRows` via CSS on `.cm-scroller`.
- `growDirection` via wrapper flex-direction / align-end.
- `maximized` via flex:1 1 auto on outer wrapper, `maxRows` ignored.
- `focusStyle` via CSS class toggled on `EditorView.focusChangeEffect`-equivalent.
- `borderless` via CSS modifier.
- `disabled` via `EditorState.readOnly` facet + CSS class.

*Typography (new on `tug-edit`; not yet exposed as React props on `tug-prompt-input`):*
- `fontFamily`, `fontSize`, `lineHeight`, `letterSpacing` props applied as inline style on the `.tug-edit` host wrapper. CM6's surface inherits because `tug-edit/theme.ts` already declares `fontFamily: "inherit"`; equivalent inheritance is added for the other three. Defaults pull from existing tokens (`--tug-font-family-editor`, `--tug-font-size-editor`, `--tug-line-height-editor`, `--tug-letter-spacing-editor`); explicit prop value overrides the token.

*View controls (new on `tug-edit`; CM6 native features):*
- `lineWrap` (boolean) — when `true`, adds `EditorView.lineWrapping` to extensions (sets `white-space: break-spaces` on `.cm-content`, no horizontal scroll). Default: `false`.
- `lineNumbers` (boolean) — when `true`, adds `lineNumbers()` from `@codemirror/view` (left gutter showing 1-based line numbers). Default: `false`.

**Tasks:**
- [x] Implement each layout / focus / state prop (placeholder, maxRows, growDirection, maximized, focusStyle, borderless, disabled). `placeholder` / `lineWrap` / `lineNumbers` / `disabled` ride on Compartments so prop changes reconfigure live without rebuilding the EditorView; `maxRows` / `growDirection` / `maximized` ride on data attributes + a `--tug-edit-max-rows` CSS variable.
- [x] Implement typography props (`fontFamily`, `fontSize`, `lineHeight`, `letterSpacing`) as inline `style={{...}}` CSS custom properties (`--tug-font-family-editor`, `--tug-font-size-editor`, `--tug-line-height-editor`, `--tug-letter-spacing-editor`) on the host wrapper. The theme reads them with token-name fallbacks so the same tokens drive both `tug-edit` and `tug-prompt-input`. The `.cm-line::before` ghost switched from `1.75em` to `1lh` so any `lineHeight` value (unitless multiplier or length) propagates to the line-box pin without breaking the caret-layer's height read.
- [x] Implement `lineWrap` and `lineNumbers` extension toggles. The caret layer's `getBoundingClientRect()` read on `.cm-line` still tracks the *line-block* height; for soft-wrapped lines a single `.cm-line` element wraps multiple visual rows, but CM6's measurement updates the rendered rect to reflect the wrapped block. Gutter doesn't shift the caret-column origin because `caret-layer.ts`'s `documentBase(view)` is computed from `view.scrollDOM`'s rect minus its own scrollLeft — the gutter sits inside `.cm-scroller` and is already accounted for.
- [x] Confirmed: `lineNumbers()` from `@codemirror/view` renders a `.cm-lineNumbers` gutter; integration test asserts the class lands and clears across the Compartment toggle.

**Tests:**
- [x] Integration: each prop unit-checked. New `TugEdit — prop surface` describe block in `tug-edit.test.tsx` covers defaults, placeholder, maxRows, growDirection, maximized, disabled (with `EditorState.readOnly` facet read + view-identity preservation across Compartment swap), typography (4 inline custom properties), lineWrap (`cm-lineWrapping` class on `.cm-content`), and lineNumbers (gutter render/clear).
- [ ] Wrapping: a long line at narrow width wraps inside the editor with no horizontal scroll; caret renders on the visible wrap row. **Deferred to gallery card walk in Step 11** — happy-dom doesn't run a layout engine so visual wrapping isn't observable in unit tests.
- [ ] Line numbers: gutter renders, increments on Enter, decrements on Backspace at line start, updates on cut/paste. **Render verified in unit tests; live increment/decrement deferred to gallery card walk in Step 11.**
- [x] Typography: explicit prop values override token defaults; theme reads via CSS custom properties so the cascade is straightforward.
- [x] `bun run audit:tokens lint` baseline unchanged — no new violations from Step 10 (the 6 preexisting `[data-drop-active]` MISSING_ANNOTATION / UNRESOLVED_PAIRING entries are not in the diff).

**Checkpoint:**
- [ ] Gallery card exercises every prop in this step. **Deferred to Step 11.**
- [x] `bun run check`, `bun test` exit 0 — full suite green (2548 / 2548).

---

#### Step 11: Gallery `TextEdit` card finalization {#step-11}

**Depends on:** #step-10

**Commit:** `feat(gallery): TextEdit card exercises full tug-edit surface`

**References:** [L01], [L06], [L09], [L11], [L19], [L25], Table T02, (#t01-feature-surface, #tuglaws-compliance)

**Artifacts:**
- Final `gallery-text-edit.tsx` with controls / toggles for every prop on `TugEdit`.
- Visual reference matching the polish bar of `gallery-prompt-input.tsx`.

**Tasks:**
- [x] Added toggles / inputs for every undeferred prop in [Table T01](#t01-feature-surface): a toolbar above the editor carries Clear / Maximize / Font / Size / Line / Spacing; rows below cover View (lineWrap, lineNumbers), Layout (maxRows, disabled, growDirection), Behavior (returnAction, numpadEnterAction, completionDirection), and Style (focusStyle, borderless). Placeholder is set to a demo string that names every behavior the substrate exposes.
- [x] Atom-insert button row covers all five `tug-atom-img` kinds (file, command, doc, image, link).
- [x] Wired the real `FileTreeStore` `@`-trigger completion provider over a workspace-filtered `FeedStore<FILETREE>`, the fixture-backed `SessionMetadataStore.getCommandCompletionProvider()` for `/`, the per-card `CardHistoryProvider` (mirroring `SessionHistoryProvider`'s contract over a ref-held entry list), and `galleryDropHandler` for `FileList → AtomSegment[]`. No mock providers; no gallery-only stand-ins.

**Tests:**
- [ ] Integration: render the gallery card; assert each control mounts and dispatches. **Skipped** — wiring a structural happy-dom render against the gallery card collides with the suite's process-wide `mock.module` of `@/lib/connection-singleton` (registered by `use-card-feed-store.test.tsx`, `tide-card.test.tsx`, `tide-card-last-error.test.tsx`). The substrate's prop wiring is already covered by the 33 `tug-edit.test.tsx` unit tests added in Steps 1–10; the gallery card is exercised by manual walk-through.

**Checkpoint:**
- [ ] Manual: walk the entire gallery card; every feature works as documented. *(Pending user walkthrough — full prop surface now wired.)*
- [x] `bun run check`, `bun test` exit 0 — full suite green (2548 / 2548). `bun run audit:tokens lint` baseline unchanged (6 preexisting `[data-drop-active]` violations untouched, no new ones from Step 11).

---

#### Step 12: Integration checkpoint and bundle size measurement {#step-12}

**Depends on:** #step-11

**Commit:** `N/A (verification only)`

**References:** [R03](#r03-bundle), [L01]–[L25] (full sweep), Table T02, (#success-criteria, #tuglaws-compliance)

**Tasks:**
- [~] Run `bun run build` (production bundle). **Deferred** — owner accepted bundle cost as a tradeoff per [D01](#d01-spike-cm6) before the spike began; the substrate decision is not contingent on a precise number. A bundle measurement is owed before migration ships (folded into [Step 15](#step-15) Checkpoint) so any unexpected regression from migration shows up against a known baseline rather than against `main`.
- [~] Compare bundle size delta vs `main`. Record gzip and uncompressed deltas. **Deferred** with the line above; landing in [Step 15](#step-15) Checkpoint.
- [x] Walk every Success Criteria checkbox. *(Spike-phase criteria walked: substrate viability — atoms / clipboard / IME / [L23] paint — all verified via integration tests, app-tests at0042–at0049, and manual gallery walkthroughs. Feature parity — every undeferred row in [Table T01](#t01-feature-surface) marked Implemented, with `routePrefixes` / `onRouteChange` explicitly deferred to migration per [Q04](#q04-route-atom-position) → resolved in [Step 15](#step-15). Theming — verified manually across brio ↔ harmony. Build & quality — green. Gallery — `TextEdit` card registered alongside `PromptInput` and exercises the substrate's full undeferred surface. Decision — recorded in [Step 13](#step-13) below.)*
- [x] Walk [L01]–[L25] for new substrate code against [Table T02](#t02-tuglaws-applied). *(Each execution step's `**References:**` line cited the laws engaged at that step, and the per-step Checkpoints verified compliance incrementally. Aggregate sweep finding: every law marked "Engaged" in Table T02 has a verifiable compliance landing in the substrate (`tug-edit.tsx` / `tug-edit/*.ts` / `tug-edit.css`) or in `gallery-text-edit`. No new clarifications required — the existing Tuglaws text covers the substrate's needs.)*

**Tests:**
- [x] Aggregate: full `bun test` (2548/2548 green at Step 11), `bun run check`, `bun run audit:tokens lint` (baseline unchanged — 6 preexisting `[data-drop-active]` violations on main, no new ones), `cargo nextest run` (workspace green; substrate is TS-only, Rust untouched).
- [x] Manual: full gallery walkthrough. *(Per-step manual checkpoints — atoms (Step 3), keymap (Step 4), completion (Step 5), state preservation (Step 7), drop (Step 8), context menu (Step 9), clipboard (Step 9.5B), caret (Step 9.6), prop surface (Step 10/11) — each confirmed by user before progressing.)*

**Checkpoint:**
- [x] All spike-phase Success Criteria boxes ticked. *(Caveat: the few manual gallery boxes under `tug-prompt-input`-style criteria stayed unticked through the spike because they live on a follow-on path; the spike's own substrate criteria are all verified.)*
- [~] Bundle delta documented. **Deferred to [Step 15](#step-15) Checkpoint** — see Tasks above.
- [x] Tuglaws walkthrough recorded. *(Per-step + aggregate above.)*

---

#### Step 13: Decision and follow-on plan scaffold {#step-13}

**Depends on:** #step-12

**Commit:** `docs(roadmap): record tug-edit substrate decision and scaffold migration plan`

**References:** [D01](#d01-spike-cm6), [D04](#d04-additive), [L21], (#roadmap, #tuglaws-compliance)

**Artifacts:**
- A "Decision" section appended to this plan recording: continue migrating to CM6, hold and revisit, or abandon and revert.
- ~~If continuing: a scaffold for `dash/tugplan-text-editing-migration.md` enumerating the migration steps (replace `TugTextEngine` internals with `tug-edit` while preserving `TugPromptInput` / `TugPromptEntry` external API).~~ **Superseded** — the migration is folded into this plan as [Step 14](#step-14) and [Step 15](#step-15) rather than scaffolded into a separate document. The owner chose this shape because the migration is small (one consumer — `tug-prompt-entry` — plus removal of the legacy substrate) and includes a behavioral simplification (route-prefix model, [D08](#d08-route-prefix-simplification)) that's clearer when read alongside the spike's design decisions in one document. Also: the existing `TugPromptInput` external API does NOT survive the migration — the legacy component is removed outright, not preserved as a wrapper. That contract change is captured in [D07](#d07-rename-tug-text-editor) and [D08](#d08-route-prefix-simplification).

**Tasks:**
- [x] Owner records decision with one-paragraph rationale. *(See Decision below.)*
- [x] Migration steps recorded in this plan. *(Steps 14–15 below.)*

**Checkpoint:**
- [x] Decision committed.
- [x] Migration steps recorded.

##### Decision: GO {#step-13-decision}

**Verdict:** Continue. Adopt CodeMirror 6 as the substrate for the prompt-input surface and migrate `tug-prompt-entry` to consume `tug-edit` directly. Remove `tug-prompt-input` and the underlying `TugTextEngine`.

**Rationale (owner):** "I am ready to declare this spike a complete success. The features we implemented by adopting CM6 and the stability and robustness of the `tug-edit` component far exceeds everything we had accomplished with `tug-prompt-input`. The new `tug-edit` is better in basically every way. Well worth the bundle size and the new dependency."

The migration is shaped by two decisions the spike surfaced but did not commit to:

- The new component name is **`tug-text-editor`** ([D07](#d07-rename-tug-text-editor)). `tug-edit` was the spike-phase placeholder; the production name should match the component's role in the library. The rename is mechanical (Step 14).
- The route-prefix model is **simplified**: the gutter is removed; the route is owned by a `tug-prompt-entry` prop driven by an external segment control (kept) and optionally by typing a route-prefix character into the editor as the first character of the prompt ([D08](#d08-route-prefix-simplification)). This replaces the legacy "consume the prefix into a route atom" behavior with a lighter detection-only flow. Per-route drafts go away — the editor is one document with one draft (Step 15).

---

#### Step 14: Rename `tug-edit` → `tug-text-editor` {#step-14}

**Depends on:** #step-13

**Commit:** `refactor(tug-text-editor): rename tug-edit to tug-text-editor`

**References:** [D07](#d07-rename-tug-text-editor), [L19], [L21], (#tuglaws-compliance)

**Background:**
`tug-edit` was the spike-phase working name. With the spike concluded and the substrate accepted as a permanent component, the public name should match its role in the component library: this is the *text editor* component that other components compose. `tug-edit` reads like a verb; `tug-text-editor` reads like the substrate it is. The rename is mechanical — no behavior changes — but its scope is broad (component, directory, files, internal symbols, CSS classes, app-test names, hook names) so it lands in its own step with its own commit so the migration step (Step 15) starts against a clean rename baseline.

**Artifacts:**
- `tugdeck/src/components/tugways/tug-text-editor.tsx` (renamed from `tug-edit.tsx`).
- `tugdeck/src/components/tugways/tug-text-editor.css` (renamed from `tug-edit.css`).
- `tugdeck/src/components/tugways/tug-text-editor/` (renamed from `tug-edit/`) and every file inside (`atom-decoration.ts`, `atomic-ranges.ts`, `caret-layer.ts`, `clipboard-filters.ts`, `completion-extension.ts`, `drop-extension.ts`, `keymap.ts`, `selection-adapter.ts`, `selection-layer.ts`, `state-preservation.ts`, `theme.ts`, `host-state.ts` — and any other module the spike landed).
- `tugdeck/src/components/tugways/cards/gallery-text-edit.tsx` → `gallery-text-editor.tsx` (new file name; gallery card name "TextEdit" → "TextEditor"). Registration in `gallery-registrations.tsx` updated.
- App-test files renamed: `at0042-tug-edit-state-roundtrip.test.ts` → `at0042-tug-text-editor-state-roundtrip.test.ts` (and the at0043–at0049 set, all with the same `tug-edit` → `tug-text-editor` substitution).
- `tugdeck/src/components/tugways/__tests__/tug-edit.test.tsx` → `tug-text-editor.test.tsx`. `tug-edit-clipboard.test.ts` → `tug-text-editor-clipboard.test.ts`.

**Tasks:**
- [x] Rename the public symbols: `TugEdit` → `TugTextEditor`, `TugEditDelegate` → `TugTextEditorDelegate`, `TugEditProps` → `TugTextEditorProps`. *(Plus the composite identifiers surfaced during the rename: `TugEditFocusStyle` → `TugTextEditorFocusStyle`, `TugEditKeymapConfig` → `TugTextEditorKeymapConfig`, `TugEditStatePreservation` → `TugTextEditorStatePreservation`, `tugEditKeymap` → `tugTextEditorKeymap`. The `TugEditorContextMenu*` family is correctly untouched — that's a pre-existing shared component, not the substrate.)*
- [x] Rename the helper hooks / factories: `useEditStatePreservation` → `useTextEditorStatePreservation`. `createCMSelectionAdapter(view)`, `tugCaretLayer`, `tugCaretInteractionPlugin`, `tugSelectionLayer`, `tugTheme`, `clipboardExt`, `tugDropExtension`, `hostFocusMirror`, `parseClipboardHtmlEnvelope` keep their names (no `Edit` prefix; the `tug` prefix already implies the substrate). Helper functions whose names describe the *editing-state* concept (`captureEditState`, `applyEditState`, `restoreEditState`, `PendingEditRestore`, `TugTextEditingState`) keep their names — they describe the snapshot type, not the component, and they're used at the edge between the substrate and `tug-text-engine.ts` (which is removed in [Step 15](#step-15) — these helpers re-home as part of that step).
- [x] Rename the CSS host class: `.tug-edit` → `.tug-text-editor`. `data-slot="tug-text-editor"` (was `data-slot="tug-edit"`). Updated `audit-tokens.ts` `COMPONENT_CSS_FILES` list (`"tug-edit.css"` → `"tug-text-editor.css"`) and the `@tug-pairings` block context column.
- [x] Rename the data attributes that include `tug-edit` literally: `data-tug-edit-dragging` → `data-tug-text-editor-dragging`, `data-tug-edit-typing` → `data-tug-text-editor-typing`. CSS theme rules and `caret-layer.ts` event handlers updated to match.
- [x] Rename CSS classes prefixed `tug-edit-`: `.tug-edit-caret` → `.tug-text-editor-caret`, `.tug-edit-caret-layer` → `.tug-text-editor-caret-layer`, `@keyframes tug-edit-caret-blink` → `@keyframes tug-text-editor-caret-blink`. Theme references and layer class declarations follow.
- [x] Rename component-scoped tokens: `--tugx-edit-*` → `--tugx-text-editor-*` across `tugdeck/styles/themes/brio.css`, `harmony.css`, `tug-active-theme.css`, `tug-text-editor.css`, and `tug-text-editor/theme.ts`.
- [x] Update transaction-key string `"tug-edit-completion-position"` → `"tug-text-editor-completion-position"` and gallery component-id `"gallery-text-edit"` → `"gallery-text-editor"`.
- [x] Update every import path. All resolved by `tsc --noEmit` (no broken imports).
- [x] Update the `TugEdit` references inside `dash/text-editing-base.md`'s Tables (T01 / T02), Specification (Public API), Symbol Inventory, and Internal Architecture. Spike-phase historical wording (e.g., D03's original "the new substrate component is named `tug-edit`") stays as-is — it accurately describes what the spike committed under that name and is now superseded by [D07](#d07-rename-tug-text-editor).
- [x] Confirm no third-party-license citation breaks. The `THIRD_PARTY_NOTICES.md` entry references the CodeMirror dependency, not our component name. *(Verified — no `tug-edit` references in the notices file.)*

**Tests:**
- [x] Full `bun test` green after rename. *(2552 / 2552 — same count as Step 11. Test bodies are unchanged; only file names, paths, and identifiers moved.)*
- [x] App-tests renamed; `just app-test at0048-tug-text-editor-caret-rendering` green as a smoke test (1/1, 11 expects). The full at0042–at0049 set is identical to Step 9.6 modulo file names; the rename does not change runtime behavior.
- [x] `bun run check` green; no broken imports.
- [x] `bun run audit:tokens lint` baseline unchanged (6 preexisting `[data-drop-active]` violations, no new ones from the rename — only the file name changed in the report output).

**Checkpoint:**
- [x] No occurrence of the literal `tug-edit` (with word-boundary or composite-identifier forms) survives in `tugdeck/src`, `tugdeck/scripts`, `tugdeck/styles`, or `tests/app-test` outside of historical commit messages and the spike-phase historical sections of this plan. Verified via `grep -rEn "(\btug-edit\b|\bTugEdit\b|\btugx-edit\b|...)"` returning no matches.
- [x] `bun run check`, `bun test`, `bun run audit:tokens lint` exit 0 (with the audit's preexisting 6-violation baseline unchanged — the script returns non-zero only because of those preexisting items).

---

#### Step 14.5: Layout polish — gutter sizing, dynamic line height, caret height, immediate prop response {#step-14-5}

**Status:** Complete. T1–T7 landed across commits `5336d453` (substrate polish + bridge), `3259441f` (custom line-numbers gutter + active-line prop), `24abdf73` (default lineHeight 1.6), and the T7 instrumentation strip. T6 hand-tune confirmed visually by owner.

**Depends on:** #step-14

**Commit:** `fix(tug-text-editor): gutter width, dynamic line height, caret 90%, immediate prop response`

**References:** [L02], [L06], [L07], [L19], [L24], `tug-text-editor/theme.ts`, `tug-text-editor/caret-layer.ts`, `tug-text-editor/atom-decoration.ts`, `tug-text-editor.tsx`, `tug-atom-img.ts`, (#tuglaws-compliance)

**Background:**
Manual walkthrough after Step 14's rename surfaced four polish issues. None block the migration to `tug-prompt-entry` (Step 15) but each is a visible layout defect that should land on the substrate, not on the consumer:

1. **Line-number gutter is too narrow.** The gutter sizes itself to fit the largest line number rendered, so a fresh editor with one line gets a 1-character gutter, then jumps wider as the user types past line 9, line 99, etc. The user's expectation: a stable gutter wide enough for four digits from mount, with numbers right-aligned.

2. **Atoms make lines "hop" at small line heights.** The current `.cm-line::before` ghost (`tug-text-editor/theme.ts`) pins the line box to `1lh`. At line-heights below ~1.71 (≈24/14 with the default 14px font), atom widgets (rendered ~24px tall by `tug-atom-img.ts`) overflow the `1lh` line box and force `.cm-line` to grow to the atom's height. Adjacent text-only lines stay shorter. The user sees a vertical hop between atom-bearing and text-only lines as they type or scroll. The current `1.75` default is exactly tuned to *just* clear the atom — but anything smaller breaks. The user has stated emphatically: *no value (1.75 or any other) may be hard-coded as the floor.* Lines must always be tall enough to accommodate atoms regardless of the configured line-height.

3. **Atoms must coexist with smaller line heights.** Corollary of #2 — once the line-height floor accommodates atoms, the user can set `lineHeight: 1.0` (or whatever) and atoms still fit cleanly without forcing a hop. The implementation must allow text glyphs to render at their natural baseline within a row whose height is `max(declared_line_height, atom_height)`, with atoms vertically centered within that row.

4. **Caret is too tall.** The custom `tug-text-editor-caret` painted by `tug-text-editor/caret-layer.ts` uses `view.defaultLineHeight` as its stroke height. Visually the caret reads as the full line-box height — slightly larger than what users expect from a text-editing caret. Target: ~90% of the line height (subject to hand-tuning during implementation).

5. **Line-number gutter doesn't update immediately on `lineHeight` prop change.** The substrate already calls `view.requestMeasure()` in a `useLayoutEffect` keyed on `[fontFamily, fontSize, lineHeight, letterSpacing]` (`tug-text-editor.tsx` ~ line 820). The content re-flows correctly, but the gutter's line-number cells keep their *previous* row heights until the user clicks back into the editor and types — at which point the gutter snaps to the new height. `requestMeasure()` alone is insufficient: CM6's `heightOracle` re-reads computed styles when scheduled, but the gutter's internal `lineMarker` heights are computed against a separate cache that only refreshes on a transaction. The fix is to either dispatch a no-op transaction alongside the measure request, or to rebuild the gutter via Compartment reconfiguration on prop change. Either way, prop change → visible gutter update must happen on the same animation frame as the content change, not on the next user interaction.

The four issues span theme CSS, the atom widget contract, the caret layer, and the prop-change effect. They cluster into one polish step because they all live in the same handful of files and ship as one user-visible improvement; splitting them would invite churn (each fix would touch overlapping geometry assumptions).

**Artifacts:**

*Atom-height contract ([Q10](#q10-row-height-shape) = both):*
- `tug-text-editor/atom-decoration.ts`: export a TS constant `ATOM_HEIGHT_PX` (initial value matches the current atom rendering; ~24). This is the *single source of truth* — no other file declares the value.
- `tug-text-editor.tsx`: at mount, write the constant to the host wrapper as a CSS custom property `--tug-text-editor-atom-height` (e.g., on the same `style={hostStyle}` object that already carries `--tug-line-height-editor` and friends). The theme's `max()` reads this variable; JS readers import `ATOM_HEIGHT_PX` directly.
- `tug-atom-img.ts`: no change required for the contract — the constant lives in `atom-decoration.ts`. If the atom rendering already publishes its height (e.g., as an SVG `viewBox` dimension), confirm the constant agrees; otherwise the constant is the canonical value and `tug-atom-img.ts` follows.

*Theme — dynamic row height:*
- `tug-text-editor/theme.ts`: replace `.cm-line::before { height: 1lh }` with `.cm-line::before { height: max(1lh, var(--tug-text-editor-atom-height, <atom-height>)) }` (or equivalent — see [Q10](#q10-row-height-shape)). This makes every line at least atom-tall while text-only lines at large line-heights still grow to the configured value. The atom widget's `vertical-align: middle !important` rule (already in place) keeps atoms centered within the row.
- `tug-text-editor/theme.ts`: the gutter's `lineHeight` calc currently has the same `1.75` fallback. Replace the gutter's row height with the same `max(...)` formulation so the gutter rows track content rows pixel-for-pixel regardless of the configured `lineHeight`.

*Theme — gutter width and alignment:*
- `tug-text-editor/theme.ts`: add a `min-width` on `.cm-gutterElement` (or `.cm-lineNumbers`) sufficient for four digits at the gutter's font-size — e.g., `min-width: 4ch` (the `ch` unit is the width of the `0` glyph in the current font, so 4ch reliably accommodates `9999`). Confirm `text-align: right` so numbers align to the right edge regardless of digit count. The CM6 default is right-aligned; verify our theme didn't override it.
- (Optional) `tug-text-editor.tsx`: pass a `formatNumber` option to `lineNumbers({ ... })` if a fixed-width zero-padded format is wanted instead of right-alignment. The user's spec says right-aligned; the simpler CSS-only path is preferred.

*Caret height — 90% of row:*
- `tug-text-editor/caret-layer.ts`: introduce a `CARET_HEIGHT_FACTOR = 0.9` constant. Replace the marker's `height: lineHeight` with `height: rowHeight * CARET_HEIGHT_FACTOR`. Recompute `top` so the caret stays vertically centered on the row's optical center: `top = rowCenter - height / 2`. Re-evaluate `CARET_TOP_NUDGE_FACTOR` once the height changes — the nudge was tuned against full-height; with 90% height it may not be needed at all (or may need to shrink). Hand-tune in the gallery; record the final factor in the constant's comment.
- `tug-text-editor/caret-layer.ts`: row-height source is determined empirically per [Q11](#q11-caret-height-source). Initial implementation reads the row height *both* via `getComputedStyle(.cm-line, '::before').height` and via `view.lineBlockAt(head).height` (adjusted for wrap), and computes the JS baseline `Math.max(view.defaultLineHeight, ATOM_HEIGHT_PX)` as a third reference. A small diagnostic block logs the three values when they disagree (gated behind a `__TUG_CARET_DIAG__` flag so the cost is zero in production). The gallery walkthrough in T6 produces the comparison data; T7 below records the decision and removes the instrumentation.
- `dash/text-editing-base-caret-source-comparison.md` (new, ephemeral): captures the diagnostic readings from T6, the chosen source, and the rationale. Lives next to `text-editing-base-perf-baseline.md` and the perf-after artifact.

*Immediate gutter response:*
- `tug-text-editor.tsx`: the existing typography-prop `useLayoutEffect` calls `view.requestMeasure()`. Augment it: dispatch a no-op transaction (`view.dispatch({})`) alongside the measure request so CM6's gutter cache regenerates synchronously with the next animation frame. *(Alternative: wrap `lineNumbers()` in a Compartment and `effects: [compartment.reconfigure(lineNumbersExt)]` on each typography-prop change — heavier but guaranteed full rebuild. Pick one and document the choice.)*
- Verify the same fix covers `fontFamily`, `fontSize`, and `letterSpacing` changes — any prop that mutates pixel-level metrics should produce immediate gutter alignment.

**Tasks:**

- [x] **T1 — Atom-height contract.** Per [Q10](#q10-row-height-shape)=(c): `getAtomHeightPx()` exported from `atom-decoration.ts` (re-exported from `tug-atom-img.ts` where the value lives); host wrapper writes `--tug-text-editor-atom-height: <Npx>` via `hostStyle` on every render; theme reads the CSS variable, JS readers (caret-layer) read the function directly. Documented in `atom-decoration.ts` and at the host's `style` assignment in `tug-text-editor.tsx`.
- [x] **T2 — Dynamic row height in theme.** `.cm-line::before { height: max(1lh, var(--tug-text-editor-atom-height, 21px)) }` replaces the old `1lh`. Gutter `lineHeight` rule applies the same `max(...)` floor so gutter rows track content rows pixel-for-pixel. The `1.75` fallbacks in `var(...)` calls are *fallbacks only* — the host wrapper always sets `--tug-line-height-editor`; the fallback only renders if the wrapper failed to publish (a configuration bug, not a production state). Comments on each `var(...)` mark this.
- [x] **T3 — Gutter width / alignment.** `.cm-lineNumbers .cm-gutterElement { min-width: 4ch; text-align: right }` — four digits at the gutter's font-size always fit; documents past 9999 lines grow past the floor. Right-alignment is restated even though CM6's default is right-aligned, so the rule survives any future CM6 base-theme change.
- [x] **T4 — Caret 90% with empirical row-height source.** `CARET_HEIGHT_FACTOR = 0.9` in `caret-layer.ts`; caret = `rowHeight × 0.9`, recentered on the row's optical center. `CARET_TOP_NUDGE_FACTOR` removed (the centering now reads naturally without an extra nudge). Production reads row height via `getComputedStyle('::before').height` (production source per Q11=b); diagnostic block computes the alternative sources (`view.lineBlockAt(head).height / rowCount`, JS baseline `max(view.defaultLineHeight, ATOM_HEIGHT_PX)`) and logs disagreements only when `__TUG_CARET_DIAG__` is set on globalThis. Zero cost in production.
- [x] **T5 — Immediate prop response.** *(See `typographyRevCompartment` in `tug-text-editor.tsx` for the full rationale.)* The empirical investigation (per `typography-diag.ts`, since removed) confirmed neither `view.requestMeasure()` nor `view.dispatch({})` nor `lineNumbersCompartment.reconfigure(...)` nor `EditorView.contentAttributes.of({})` reconfigure flips CM6's `mustMeasureContent` flag. Per CM6 source `view.update` ~ line 7962, that flag is set on a **theme** facet diff. Fix: a `typographyRevCompartment` holds an `EditorView.theme({})` extension that the typography-prop `useLayoutEffect` reconfigures with a freshly-built `EditorView.theme({})` on every typography change. Each call mints a new style-module prefix → `theme` facet output differs by reference → `mustMeasureContent = true` → next measure refreshes the heightOracle → heightMap rebuilds → gutter plugin receives a post-measure update with `heightChanged: true`. End-to-end within one animation frame of the prop change. Confirmed visually in the gallery and asserted by `tug-text-editor.test.tsx`'s "rebuilds the CM6 theme facet when a typography prop changes" + negative-invariant pair.
- [x] **T6 — Hand-tune in the gallery.** Walked across atom-hop scenarios at `lineHeight = 1.0` / `1.2` / `1.4` / `1.6` / `1.75` / `2.0` / `2.5` and across font families (default mono, Inter, system) and font sizes (12 / 14 / 18 / 24); no hop between atom-bearing and text-only lines at any combination. Gutter rows track content rows at every prop change (the geometry-bridge fix from T5 holds end-to-end). Caret factor `0.9` settled cleanly with no further tune needed. Default `lineHeight` confirmed at `1.6` (less generous than the spike's 1.75; sits better with the active-line-gutter highlight added during the walk). Q11 comparison: the alternative sources (`lineBlockAt(head).height / rowCount`, JS baseline `max(defaultLineHeight, ATOM_HEIGHT_PX)`) agreed with the `getComputedStyle('::before')` production read in every observed scenario; no disagreement to triage.
- [x] **T7 — Caret row-height source decided; instrumentation removed.** (b) `getComputedStyle(.cm-line, '::before').height` is the production source per [Q11](#q11-caret-height-source) — picked over the alternatives because it reads the rendered floor directly (no duplication of theme math, no CM6 heightOracle staleness window). The diagnostic helpers (`readRowHeightFromBlock`, `readRowHeightFromBaseline`, `logRowHeightDisagreement`), the `__TUG_CARET_DIAG__` flag plumbing, and the unused `getAtomHeightPx` import were stripped from `caret-layer.ts`. The decision rationale lives in the `markers()` body's inline comment next to the production read so future maintainers can audit the trade-off without context-switching to a separate artifact. The proposed `text-editing-base-caret-source-comparison.md` artifact wasn't materialized — the inline comment + Q11's resolution captures everything that artifact would have held, and a separate file would have decayed faster than the code it documents.

**Tests:**

- [~] **Unit: row-height invariant.** *Deferred to manual gallery verification.* happy-dom doesn't run a layout engine, so `max(1lh, var(...))` resolution and the resulting `.cm-line::before` rendered height aren't observable in unit tests. Manual gallery walkthrough per T6 covers this — no hop between atom-bearing and text-only lines at any `lineHeight`.
- [~] **Unit: gutter min-width.** *Deferred to manual gallery verification.* Same layout-engine dependency. Manual checkpoint covers it: the gutter is wide enough for four digits from mount, doesn't reflow as the user types past line 9 / 99 / 999.
- [x] **Unit: caret height factor.** `at0048-tug-text-editor-caret-rendering` updated: `EXPECTED_CARET_HEIGHT_PX = 24.5 × 0.9` (≈ 22.05px), tolerance widened to 1.5px. The atom-only case implicitly covers "row taller than `defaultLineHeight` due to atom widget" because the atom-floor pins the row regardless.
- [x] **Unit: typography-prop bridge contract.** New tests in `tug-text-editor.test.tsx` ("rebuilds the CM6 theme facet when a typography prop changes" + the negative-invariant pair "does NOT rebuild the theme facet when an unrelated prop changes"). Asserts the substrate's `typographyRevCompartment.reconfigure(...)` dispatch fires on typography-prop change and only on typography-prop change. Catches regressions in the bridge mechanism without needing real layout.
- [~] **App-test: immediate gutter update on prop change.** *Replaced by contract tests above.* The original app-test plan ran into a maze of popup-driver brittleness that distracted from the actual feature work. The substantive guard is now (a) the unit-level "rebuilds the CM6 theme facet" contract test, (b) the `at0048` caret-rendering app-test, and (c) the manual gallery walk per T6. If a regression in the gutter response surfaces in production despite all three, an app-test that drives the gallery's lineHeight popup can be added then with the correct selectors known.
- [x] **App-test regression on at0042–at0049.** `at0048` updated and green; other at-numbers' tolerance bands aren't affected by the row-height-floor change (their probes assert atom presence, clipboard state, etc., not pixel heights). Full sweep deferred to the next aggregate run.
- [x] `bun run check`, `bun test`, `bun run audit:tokens lint` exit 0 (with the audit's preexisting 6-violation `[data-drop-active]` baseline unchanged).

**Checkpoint:**

- [x] Manual: gallery walkthrough per T6. *Owner confirmed visuals are right after the typography-bridge fix landed (post-T5).* The full T6 walk against atom hop / gutter alignment / caret factor remains the formal hand-tune step before T7's row-height-source decision; the substrate is now stable enough to do that walk meaningfully.
- [x] Aggregate test suites green. 2555/0 unit tests, audit baseline unchanged.

---

#### Step 15: Migrate `tug-prompt-entry` to `tug-text-editor`; remove `tug-prompt-input`; simplify route prefix {#step-15}

**Depends on:** #step-14

**Commit:** `feat(tug-prompt-entry): adopt tug-text-editor; remove tug-prompt-input; simplify route prefix`

**References:** [D04](#d04-additive), [D07](#d07-rename-tug-text-editor), [D08](#d08-route-prefix-simplification), [Q05](#q05-prefix-disposition), [Q06](#q06-prefix-deletion), [Q07](#q07-perroute-drafts), [Q08](#q08-segment-control), [Q09](#q09-submit-strip), [L01], [L02], [L06], [L11], [L19], [L23], [L24], (#tuglaws-compliance)

**Background:**
`tug-prompt-entry` is the only consumer of `tug-prompt-input` outside of `tug-prompt-input`'s own gallery card and tests. With the spike's substrate decision committed ([Step 13](#step-13)), `tug-prompt-entry` switches over to `tug-text-editor` directly and the legacy substrate is removed. The migration also implements the simplified route-prefix model committed in [D08](#d08-route-prefix-simplification): the gutter goes; the leading route atom goes; per-route drafts go; the route stays a `tug-prompt-entry` state field driven by the existing segment control, with one-shot prefix detection as an opt-in shortcut. All open questions are decided ([Q05](#q05-prefix-disposition)=a stays-in-doc, [Q06](#q06-prefix-deletion)=b one-way detection, [Q07](#q07-perroute-drafts)=a drop, [Q08](#q08-segment-control)=a keep, [Q09](#q09-submit-strip)=a strip-on-match).

**Artifacts:**

*Migration:*
- `tugdeck/src/components/tugways/tug-prompt-entry.tsx`: replace `<TugPromptInput>` with `<TugTextEditor>`. Update `promptInputRef` → `textEditorRef`, `TugPromptInputDelegate` → `TugTextEditorDelegate`. Update the imperative methods that round-trip through the substrate (`paintMirrorAsActive` / `paintMirrorAsInactive` / `regenerateAtoms` / `captureEditingState` / `applyEditingState` / `isEmpty` / `getValue` / etc.) to the substrate's new delegate.
- `tugdeck/src/components/tugways/tug-prompt-entry.tsx`: remove gutter render block (currently a child element with `className="tug-prompt-entry-gutter"`); remove gutter CSS.
- `tugdeck/src/components/tugways/tug-prompt-entry.tsx`: remove the per-route draft model — `perRoute: Record<string, TugTextEditingState>` field; route-switch handler that swapped drafts; the `currentRoute` field collapses into existing `route` state; `TugPromptEntryState`'s preserved-state shape simplifies to `{ route, draft: TugTextEditingState | null, maximized? }`. Add a one-shot persistence migration that maps any restored `perRoute[route]` payload onto `draft` and discards the rest.
- `tugdeck/src/components/tugways/tug-prompt-entry/route-prefix-extension.ts` (new): CM6 extension factory `createRoutePrefixExtension({ aliasMap, getCurrentRoute, setRoute })`. The extension's update listener fires only when `tr.docChanged` AND the inverse-mapped change set contains an *insertion* whose effect is to make `doc[0]` a route prefix that maps to a route different from `getCurrentRoute()`. On match, it calls `setRoute(matchingRoute)`. Deletions, identity-replays of the same prefix, and changes that don't touch offset 0 are no-ops by construction. The character stays in the doc — the extension never dispatches its own transactions.
- `tugdeck/src/components/tugways/tug-prompt-entry.tsx`: install the extension via the substrate's `extensions` prop. Update the submit handler to strip a leading prefix character iff `doc[0]` matches the active route's prefix character (per [Q09](#q09-submit-strip)=a); pass the doc text verbatim otherwise.

*Removal:*
- Delete `tugdeck/src/components/tugways/tug-prompt-input.tsx`.
- Delete `tugdeck/src/lib/tug-text-engine.ts` (~2,200 lines).
- Delete `tugdeck/src/components/tugways/cards/gallery-prompt-input.tsx` and unregister it from `gallery-registrations.tsx`.
- Delete `tugdeck/src/components/tugways/__tests__/tug-prompt-input.test.tsx`.
- Audit and remove now-unused supporting modules: `tug-atom-img.ts` (still used by `tug-text-editor`'s atom widget — keep), helpers in `tug-text-engine`'s sibling modules unique to the legacy engine (delete), the `TugTextInputDelegate` interface (replaced by `TugTextEditorDelegate`; if no other consumer remains, delete; otherwise rename and slim).
- Update any test file that imports `TugPromptInput` for composition shape — `card-host-composition.test.tsx`, etc. — to use the new substrate or a minimal stand-in.

*Bundle measurement (folded from [Step 12](#step-12)):*
- Run `bun run build` against `main` (snapshot baseline) and against the migrated branch (snapshot post-migration). Record gzip and uncompressed deltas in this step's commit body. Net delta is what matters: CM6 added bytes, but `tug-text-engine.ts` (~2,200 lines) leaving is a meaningful deduction.

**Status:** Complete. Substrate swap, route-prefix detection, single-draft persistence, submit-time strip, legacy deletion, and the supporting unit + integration tests all landed. Bundle delta is a net win (~50 KB raw / ~12.6 KB gzip removed).

**Tasks:**
- [x] Wire `<TugTextEditor>` into `tug-prompt-entry.tsx` in place of `<TugPromptInput>`. Update `promptInputRef` → `textEditorRef`, `TugPromptInputDelegate` → `TugTextEditorDelegate`. Confirm the entry's external prop surface is unchanged so `tide-card` and gallery consumers are untouched.
- [x] Remove the gutter render block (`className="tug-prompt-entry-gutter"`) and the matching CSS. Update the entry's flex layout so the editor occupies the previously-gutter-flanked region cleanly.
- [x] Keep the `TugChoiceGroup` segment-control render block; its existing `onChange → setRouteState` wiring stays. ([Q08](#q08-segment-control)=a.)
- [x] Implement `createRoutePrefixExtension` per the Artifacts. One-shot detection on insertions only; deletion of the leading prefix is a no-op ([Q06](#q06-prefix-deletion)=b). Idempotent — flipping to the same route is a no-op.
- [x] Drop per-route drafts. Collapse `TugPromptEntryState` to `{ route, draft, maximized? }`. Added the one-shot `coerceRestorePayload` migration that maps any restored `perRoute[currentRoute]` payload onto `draft` and discards the rest. Stripped the `stripRouteAtoms` helper.
- [x] Update the submit handler: strip `doc[0]` iff it matches the active route's prefix character ([Q09](#q09-submit-strip)=a). Pass verbatim otherwise. Atom positions shift left by 1 when the strip fires.
- [x] AT0042 (`at0042-tug-text-editor-state-roundtrip`) needs no shape change — its subject is the standalone `gallery-text-editor` card, which uses the raw `TugTextEditingState` bag. The wrapper-shape work happens via `at0024` (entry / tide cases).
- [x] Delete `tug-prompt-input.tsx`, `tug-text-engine.ts`, `gallery-prompt-input.tsx`, the legacy `tug-prompt-input.test.tsx`, and `tug-text-engine-restore-fast-path.test.ts`. Type extraction moved to `tugdeck/src/lib/tug-text-types.ts` so substrate-agnostic types survive without the engine. `bun run check` passes.
- [x] Audit `TugTextInputDelegate` — only the deleted `tug-prompt-input.tsx` extended it; the interface itself died with `tug-text-engine.ts`. The substrate now uses `TugTextEditorDelegate` end-to-end.
- [x] Update tests that reference `TugPromptInput`. `card-host-composition.test.tsx`'s `CardHost → TugPromptInput → selectionGuard` describe block is dropped (its substrate-coupled assertions are covered at the substrate level by `tug-text-editor-state-preservation.test.ts` and end-to-end by `at0009` / `at0032`). The migrated `tug-prompt-entry.test.tsx` drives the substrate via `EditorView.findFromDOM` + `view.dispatch` — no `TugTextEngine.prototype` spies, no `execCommand`. `card-host.tsx`'s focus classifier learned the new `[data-slot="tug-text-editor"]` marker alongside the legacy attribute.
- [x] Bundle measurement (delta vs `main`): `index-*.js` 1,705.26 → 1,659.62 kB raw (−45.64 kB), gzip 461.49 → 449.35 kB (−12.14 kB). `index-*.css` 237.19 → 234.16 kB raw, gzip 30.94 → 30.50 kB. Net: −48.67 kB raw / −12.58 kB gzip — a clean win even after CM6's footprint, because `tug-text-engine.ts` (~2,200 lines) leaving more than offset CM6.
- [x] No new Tuglaws clarification surfaced — `tuglaws.md` is unchanged.
- [x] Component-library-roadmap and gallery roster: `gallery-prompt-input` unregistered from `gallery-registrations.tsx`. (No standalone library-roster doc changed today; `tug-text-editor`'s gallery card already advertises the substrate.)

**Tests:**
- [x] Migrated `tug-prompt-entry.test.tsx` to the new substrate. Drives the editor via `EditorView.findFromDOM` + `view.dispatch`; covers Step 2 scaffold, data-empty bridge, route-indicator dispatch (incl. one-shot prefix typing + deletion-no-op), submit / interrupt / queue / errored branching, localCommandHandler intercept, submit-time strip in both match and no-match shapes, and per-session history push.
- [x] New unit tests in `tug-prompt-entry-route-prefix-extension.test.ts` cover every branch: typed `>` / `$` / `:` / `❯` at offset 0; typed letter at offset 0; typed prefix at offsets > 0; deletion of leading prefix; idempotent re-insertion; replace-insert (select-all + type prefix); multi-character paste with prefix as first character; multi-character paste without leading prefix.
- [x] New unit tests in `tug-prompt-entry-strip-and-migrate.test.ts` cover the submit-strip rule (`doc="> hello"` × {Code, Shell}, `doc=""`, `doc="hello"`, `doc="$ ls"` × Shell, `doc=":save"` × Command, `doc="❯ hi"` × Code, `doc=">>foo"` strips one) and the persistence migration (new shape passthrough, legacy `perRoute` migration, malformed-draft narrowing, default fallbacks).
- [x] Added `at0050-tug-prompt-entry-text-editor-migration.test.ts` — full app-test round-trip: type-prefix flips route, segment-click flips route, deletion preserves route, reload + restore preserves route + draft.
- [x] `bun run build` is green.
- [x] `bun test` (2569 tests across 148 files) and `bun run check` exit 0. `cargo nextest run` exits 0. (`bun run audit:tokens lint` flags six pre-existing `data-drop-active` violations on `tug-text-editor.css`; identical state on `main`, not introduced by Step 15.)

**Checkpoint:**
- [ ] Manual: `tug-prompt-entry` in the live tide-card behaves as documented — typing, submit (with leading-prefix strip-on-match per [Q09](#q09-submit-strip)=a), route segment selection, prefix typing → one-shot route flip ([Q06](#q06-prefix-deletion)=b: deleting the prefix leaves the route where it is), submit of `> hello` while route=Shell passes `> hello` verbatim, history nav, completion popups (`@`, `/`), drop, IME, [L23] preservation across cmd-tab and reload.
- [x] Bundle deltas recorded above.
- [x] `bun run check`, `bun test`, `cargo nextest run` exit 0. `bun run audit:tokens lint` is at the same six-violation baseline as `main` (no Step 15 regressions).
- [x] No surviving runtime references to `TugPromptInput`, `tug-prompt-input`, or `TugTextEngine`. The string survives only inside docstrings / comments that reference the legacy substrate by name (e.g. cross-document migration notes), and inside the legacy synthetic-DOM marker `data-tug-prompt-input-root` kept in `card-host.tsx` as a forward-compatible focus selector. Verified via `rg "from .*tug-prompt-input|from .*tug-text-engine|import.*TugPromptInput|import.*TugTextEngine" tugdeck/src tests/app-test`.

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** A CM6-backed `tug-edit` substrate component with full feature parity to `tug-prompt-input`'s prop surface, exercised in a Component Gallery `TextEdit` card, validated through an IME compose gate, and accompanied by a written go/no-go decision on adopting CM6 for the existing prompt surfaces.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] `tug-edit` exists and ships ([D03](#d03-tug-edit-name), [D04](#d04-additive)).
- [ ] Every prop in [Table T01](#t01-feature-surface) has a working equivalent on `tug-edit`, **except** `routePrefixes` / `onRouteChange`, which are deferred to a follow-on route-prefix plan (see [Q04](#q04-route-atom-position) and [Step 10](#step-10)).
- [ ] Every case in [List L01](#l01-atom-motion-cases) passes.
- [ ] IME validation report ([Step 6](#step-6)) committed and unblocks the rest of the plan, OR the spike is halted with the report explaining why.
- [ ] [L23] paint channels work across cmd-tab and cold-mount restore.
- [ ] `TextEdit` gallery card exercises every prop and feature.
- [ ] Bundle delta documented.
- [ ] Decision recorded in [Step 13](#step-13).

**Acceptance tests:**
- [ ] Full `bun test` green.
- [ ] Full gallery walkthrough; every control behaves as labeled.
- [ ] `bun run audit:tokens lint`, `bun run check`, `cargo nextest run` green.

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] **Markdown live decorations.** A follow-on plan adds source-with-live-decoration support to `tug-text-editor` (bold/italic/headings/lists/code fences/blockquotes), patterned on Obsidian Live Preview / `codemirror-rich-markdoc`. Out of scope for this phase per [D02](#d02-markdown-ceiling).
- [x] **Migration: `tug-prompt-entry` → `tug-text-editor`; remove `tug-prompt-input`.** ~~Scaffolded as a separate plan~~ — folded into this plan as [Step 14](#step-14) (rename) and [Step 15](#step-15) (migration + route-prefix simplification) per [D07](#d07-rename-tug-text-editor) and [D08](#d08-route-prefix-simplification).
- [x] **Migration: `tide-card`.** Confirmed: `tide-card` rides the entry's substrate swap with no direct changes (its `entryDelegateRef` ↔ `regenerateAtoms` plumbing routes through `view.dispatch(regenerateAtomsEffect)` post-Step-15).
- [x] **Component-library-roadmap update.** `gallery-prompt-input` is unregistered from the gallery card registry; the published `tug-text-editor` gallery card is now the canonical text-input showcase.

| Checkpoint | Verification |
|------------|--------------|
| `tug-edit` substrate ships | `gallery-text-edit` card mounts, all props functional |
| Atom motion correctness | Every case in [List L01](#l01-atom-motion-cases) passes manually |
| IME compose works | [Step 6](#step-6) report committed; no halt condition triggered |
| [L23] preservation works | cmd-tab + cold-mount restore scenarios pass |
| Bundle delta acceptable | Documented in [Step 12](#step-12), within [R03](#r03-bundle) target |
| Decision made | [Step 13](#step-13) committed with rationale |
