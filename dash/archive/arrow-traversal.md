<!-- devise-skeleton v4 -->

## Arrow Traversal Everywhere {#arrow-traversal}

**Purpose:** Make arrow keys move the keyboard focus caret ergonomically between components on every surface — across Lens sections, through the Choose Session sheet, and out of text fields/editors when that is what the user means — via one general engine mechanism (a universal arrow liveliness net + centralized empty-field release + an editor boundary latch), not per-surface patches. Command-history navigation in the prompt editor moves to Cmd-Up/Cmd-Down so plain arrows can never overshoot into a history recall.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-08-03 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

The focus language ([tuglaws/focus-language.md](../tuglaws/focus-language.md), "Motion: two planes") promises that arrows move the ring "in the direction you see", but the implementation is dialog-shaped: every declared `SpatialOrder` in the tree lives inside a trapped sheet/dialog scope, `TugListView` registers its `SpatialCursorHandle` only behind a `spatialCursor` opt-in with exactly one consumer (the question dialog), and the empty-field arrow release (`data-tug-arrow-release`) is wired per-component in one place. Three concrete failures motivated this phase: (1) in the Lens, Down from the last Cards row dead-ends instead of continuing into Snippets — the list clamps at its edge and consumes the key; (2) in the Choose Session sheet, arrows work only inside the sessions list plus the filter field's bespoke ArrowDown advance — Up from the list top does not return to the filter, and arrows never reach Trash/Cancel/Open; (3) in the prompt editor, plain Up at the document start fires history navigation, so walking the caret to the start routinely overshoots into an unwanted history recall.

The design brief this plan implements is [dash/arrow-traversal-brief.md](arrow-traversal-brief.md). All five of its open questions are DECIDED (see [#open-questions]): empty editors traverse freely; the net wraps; empty-input release covers all four directions; the Choose Session sheet also gets an authored `rowGridOrder`; the armed latch shows no visual affordance.

#### Strategy {#strategy}

- Generalize before specializing: land the engine-level pieces (universal liveliness net, universal list cursor handles, centralized empty-input release) first, so the two failing surfaces are fixed mostly by the general mechanism rather than surface code.
- Preserve the never-beep invariant at every step: an arrow is always consumed by something that moves the ring, drives a cursor, moves a caret, or deliberately holds — it never falls through to WebKit/macOS unhandled.
- Keep declared `SpatialOrder`s as the way to author *better-than-linear* movement; the net is the floor under them, now everywhere instead of only inside declared scopes.
- Rebalance the editor's plain arrows to carry exactly two meanings (caret motion; deliberate two-press spatial exit at a document edge) by moving history to Cmd-Up/Cmd-Down with the same at-edge rules.
- Amend the doctrine (`tuglaws/focus-language.md`) in the same phase, so the law and the implementation move together.
- Test at the layer that owns each behavior: `bun test` engine units for resolution logic, app-tests (selected via `@covers`, per [tuglaws/app-test-harness.md](../tuglaws/app-test-harness.md)) for the end-to-end traversals.

#### Success Criteria (Measurable) {#success-criteria}

- In the Lens, with the key view on the last cursorable Cards row, ArrowDown lands the key view in the Snippets section (its filter field, the next stop in group order); ArrowUp from the first row of a section's list lands on that section's filter field. (App-test assertion on `focusManager.keyView()` / `data-key-view` after `nativeKey`.)
- In the Choose Session sheet, starting from the sessions list: ArrowUp from the top row reaches the filter field; ArrowDown from the bottom row reaches the trash control; further ArrowDowns reach Cancel then wrap per the authored order; ArrowLeft/ArrowRight swap Cancel↔Open. (App-test.)
- An empty `TugFilterField` (placeholder showing) is transparent to all four arrows: Down passes through into the list below, Up passes out above. A filter field with text keeps every arrow (caret/no-op) except its existing delegate ArrowDown advance. (App-test + unit.)
- In the prompt editor with a non-empty document: plain Up at the doc start does NOT navigate history and does NOT leave the editor on first press; the second discrete plain Up enters the session card's focus cycle at the editor's own seat and lands the ring on the adjacent cycle stop; held-key auto-repeat never leaves the editor. (App-test asserting the focus mode became the cycle scope and the key view is the expected `SESSION_CYCLE_GROUP:<order>` stop.)
- No arrow press anywhere in this phase's surfaces ends unconsumed: the arrow exit from the prompt editor is a host handoff, never a base-mode walk (the session card registers no base-mode focusables — see [#session-card-cycle]). (App-test: focus-invariant report shows zero violations and an empty steal ledger after each traversal, the check at0248 already performs.)
- The editor itself never takes a focus ring: after an arrow exit the ring is on the cycle stop and the editor is blurred; arrowing back onto the editor stop rings the **input-area wrapper** with no caret, and `Return` descends into typing. (App-test asserting `data-key-view-kbd` lands on `.tug-prompt-entry-input-area`, never on `.tug-text-editor`.)
- Cmd-Up with the caret mid-document moves the caret to the doc start (existing `cursorDocStart`); Cmd-Up with the caret already at the start recalls the previous history entry; Cmd-Down symmetric. Opt-Up/Opt-Down walk history position-independently, unchanged. (App-test on the shell route + unit test of the handler predicate.)
- No regression in descended row-scope arrows: at0277 and at0282 stay green unmodified.
- `bun test` (tugdeck), `bunx vite build`, and `just app-test-changed` all pass at phase end.

#### Scope {#scope}

1. Focus engine: universal arrow liveliness net (group-edge fallback in `moveKeyViewSpatial`; new post-delegate fallback listener stage).
2. `TugListView`: cursor handle registered for every engine-authored list; retire the `spatialCursor` opt-in.
3. Centralized empty-input arrow release in the document keyboard pipeline; repeat-gating for release crossings.
4. `tug-text-editor` keymap: history nav on Cmd-Up/Cmd-Down (at-edge rules), plain arrows caret-only, two-press boundary latch for spatial exit, editor-owned `data-tug-arrow-release` (retiring the `arrowRelease` prop).
5. The composer's arrow exit: an `onArrowExit` host handoff into the session card's focus cycle (`enterAt`), plus the editor stop's seat in that cycle's spatial grid.
6. Choose Session sheet: authored `rowGridOrder`.
7. Doctrine amendments to `tuglaws/focus-language.md` (and a sweep of tuglaws for statements the change invalidates).
8. App-test and unit-test coverage for all of the above.

#### Non-goals (Explicitly out of scope) {#non-goals}

- No authored base-mode `SpatialOrder` for the Lens — its linear group order already matches the visual column, so the net *is* its correct spatial order. (Revisit only if the wrap-at-extremes feel is wrong in practice.)
- No horizontal (Left/Right) latch exit from a *non-empty* text editor — Left/Right stay caret-only there; only vertical arrows exit via the latch. (An empty editor releases all four.)
- No new base-mode focusables on the session card. The card's stops live in its trapped cycle mode by design ([#session-card-cycle]); the editor's arrow exit enters that cycle ([P09]) rather than inventing a parallel base-mode order — the same reasoning `focus-language.md` applies to the ⌘F find bar ("A surface that appears on a card joins the card's authored order; it never declares a parallel one").
- No visual affordance for the armed latch ([Q05] decided: none).
- No changes to descended row-scope arrow behavior (`handleListKey`'s in-row walks, at0277/at0282).
- No changes to the responder chain, act dispatch, or Tab-walk semantics.
- No accessibility-mode (VoiceOver mirror) changes; the net moves the key view through the same `place()`/projection machinery accessibility mode already mirrors.

#### Dependencies / Prerequisites {#dependencies}

- None external. All work is in `tugdeck/` plus `tuglaws/` and `tests/app-test/`.
- tugdeck HMR is live for interactive verification; the debug app loads the production rollup bundle, so `bunx vite build` must pass before any step is called done that touches imports.

#### Constraints {#constraints}

- Tuglaws: [L01]–[L06], [L22] (engine state is structure — never mirrored in React state), [L03] (registrations in layout effects), [L06] (appearance via CSS/DOM attributes, never React state). Focus writes go through `FocusManager.place()`; there is no legal raw `.focus()` to an engine-routed element.
- Never-beep: every arrow keydown on an engine surface must end consumed. No step may leave a configuration where an arrow falls through unhandled to the WKWebView.
- App-tests: selective runs only (`just app-test-changed`); every new test carries `@covers` lines; never `just app-test-all`.
- WARNINGS ARE ERRORS in the Rust workspace — untouched here, but `bun test` and `vite build` failures are equally blocking.

#### Assumptions {#assumptions}

- The document-capture keyboard listener ladder in `responder-chain-provider.tsx` remains the single arbiter of bare arrows (verified in this investigation; see [#pipeline-today]).
- Bare Cmd-ArrowUp/Cmd-ArrowDown are unbound in the global keybinding map (`keybinding-map.ts` binds only the ⌥⌘ and ⌥⇧⌘ arrow chords, for turn paging), so the editor substrate may claim them without a document-level conflict. Verified 2026-08-03.
- No app-test currently pins plain-arrow history navigation in the prompt editor (grep of `tests/app-test/*.test.ts` for history found only unrelated suites), so moving history to Cmd-arrows breaks no pinned behavior.
- The session card registers **no base-mode focusables** — verified 2026-08-03 by reading every `focusGroup=` site in `cards/session-card.tsx`: each resolves to `SESSION_CYCLE_GROUP` (the trapped cycle) or the picker sheet's group. A base-mode linear walk on that card therefore has an empty `walkOrder()`. This is the fact that makes [P09] necessary; if a future change adds base-mode stops there, [P09] still holds (the handoff is the authored path) but the failure it prevents becomes less severe.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

All five questions from the brief were answered by the owner on 2026-08-03. Recorded here as DECIDED with pointers to the design decisions that bind them.

#### [Q01] Empty-editor traversal: free or latched? (DECIDED) {#q01-empty-editor}

**Question:** Does an empty `TugTextEditor` (placeholder showing) traverse freely like an empty input, or does it still cost the extra latch press?

**Resolution:** DECIDED — free traversal when empty (see [P05]). The latch exists to protect a document; an empty editor has none.

#### [Q02] Net wrap policy at the registry ends (DECIDED) {#q02-wrap}

**Question:** Does the linear fallback walk wrap at the ends of the focus registry, or clamp?

**Resolution:** DECIDED — wrap (see [P01]). Matches the existing in-scope liveliness net semantics (`focusNext`/`focusPrevious` are modulo walks).

#### [Q03] Empty-input release directions (DECIDED) {#q03-release-directions}

**Question:** Does the empty-input auto-release cover Left/Right as well as Up/Down?

**Resolution:** DECIDED — all four directions (see [P03]). An empty field has no caret motion to protect.

#### [Q04] Choose Session sheet: net-only or authored order? (DECIDED) {#q04-picker-order}

**Question:** Is the picker sheet served by the net alone, or does it also get an authored `rowGridOrder`?

**Resolution:** DECIDED — also an authored `rowGridOrder` (see [P06]), per the doctrine's stated preference for dialogs/sheets.

#### [Q05] Latch affordance (DECIDED) {#q05-latch-affordance}

**Question:** Should the armed latch show a visual affordance (caret/edge pulse)?

**Resolution:** DECIDED — no affordance (see [P05]). The latch stays invisible.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| The net steals arrows from a surface that needed them (Radix menu, slider, focused editor) | high | low | Strict active-element gate + captures re-check (Spec S01); net runs after the key-view delegate stage | Any report of a menu/slider/caret losing arrows |
| Universal cursor handles change list arrow behavior on lists that never opted in | med | med | The handle's interior moves replicate `handleListKey`'s exactly (same `stepCursorableRow`/`moveCursorTo`/commit-on-move); at0248/at0141 revised deliberately, at0277/at0282 must pass unmodified | at0248 diffs beyond edge expectations |
| Muscle-memory break: plain Up no longer recalls history | med | high (by design) | Cmd-Up/Cmd-Down carry the same at-edge rules; Opt-Up/Opt-Down unchanged; doctrine documents the new split | Owner feedback after daily use |
| A dropped consumption path lets an arrow reach WebKit (macOS beep) | med | low | Every changed site keeps an explicit consume-or-hand-off; the net consumes whenever its gates pass; unit tests assert consumption returns | Any beep report |
| The question dialog's release seam ([P25] in that surface) regresses when `arrowRelease` is retired | med | low | The editor-owned release reproduces `empty ? release : keep` exactly; at0202-family app-tests run via `@covers` | at0202 failures |
| The two exit paths ([P09] handoff vs. release) diverge in behavior | med | med | One decision function in the keymap owns both; the projection is explicitly suppressed on the handoff path so they can never both fire | Any editor where an arrow exit both moves the ring and fires the host |
| The editor's new grid row ([P10]) puts a stop somewhere that reads wrong on screen | low | med | Seat verified by keyboard walk before commit; `rowGridOrder` seams are cheap to re-seat | Owner feedback that Up/Down from the composer lands oddly |

**Risk R01: Net misfire on non-engine DOM focus** {#r01-net-misfire}

- **Risk:** A future surface holds real DOM focus on a non-text element (like Radix menu items do) and the net walks focus out from under it.
- **Mitigation:** The net's gate admits only `document.activeElement` ∈ {key sink, `<body>`, `null`} or a text surface whose release predicate passes (Spec S01). Anything else — any real focused element — bails.
- **Residual risk:** A surface that parks focus on the sink but still expects arrows via a channel other than `KeyViewBehavior.onKey` would lose them; no such surface exists today (the delegate stage runs before the net and owns that pattern).

**Risk R02: Latch feels sticky or invisible** {#r02-latch-feel}

- **Risk:** With no affordance ([Q05]), the first consumed press at a document edge may read as a dead key.
- **Mitigation:** The caret is already visibly at the edge (the press that armed changed nothing, which is the honest signal); repeat never crosses, so the cost is exactly one press.
- **Residual risk:** Discoverability of the exit gesture relies on doctrine/habit; revisit affordance only on owner request.

---

### Design Decisions {#design-decisions}

#### [P01] The arrow liveliness net is universal, and it wraps (DECIDED) {#p01-universal-net}

**Decision:** A bare arrow that nothing claims, while the engine holds the keyboard, falls back to the linear focus walk — Down/Right advance via `focusNext()`, Up/Left retreat via `focusPrevious()`, both wrapping (modulo the mode-bounded registry) — realized through `place()` with keyboard modality. Implemented at two sites: (a) inside `FocusContext.moveKeyViewSpatial` where a group cursor sits at its edge in a scope with no declared order (today's clamp-and-consume clause), and (b) a new document-capture listener stage `arrowFallbackListener`, registered immediately after `keyViewDelegateListener`, for key views that are not groups and have no declared order (today the arrow dies unconsumed).

**Rationale:**
- The never-beep liveliness fallback already exists inside declared spatial scopes (`moveKeyViewSpatial`'s `nodeInOrder` branch); this extends the same semantics to undeclared scopes instead of inventing a second model.
- Site (b) must run *after* the key-view delegate stage so descended row scopes (`handleListKey`'s in-row arrow walks) and any `KeyViewBehavior.onKey` consumer keep their arrows — the net catches only truly-unclaimed keys.
- Wrap (not clamp) per [Q02]: matches `focusNext`/`focusPrevious`'s existing modulo semantics and the in-scope net's behavior.

**Implications:**
- New public method `FocusContext.moveKeyViewLinear(direction): string | null` (delegated on `FocusManager`) shared by both sites, returning the moved focusable id. It performs the walk (`focusNext`/`focusPrevious`, which already `setKeyView`) and **no focus write** — the caller decides how to realize it, so a convenience method never becomes a second focus writer.
- Site (a) (inside `moveKeyViewSpatial`) follows it with `focusKeyView()`, exactly as the existing in-scope liveliness net does — that path is internal to the context. Site (b) (the listener) instead calls `place(null, { kind: "focusable", id }, { modality: "keyboard" })`, mirroring how `focusWalkListener` realizes a Tab move, because an external caller's focus write goes through the engine's single write primitive ([L22]; focus-language "One writer, one interpreter, one truth").
- Declared orders remain authoritative where present — the net never overrides a resolvable seam/ring/override.
- The existing `spatial-nav.test.ts` "never-beep boundaries" suite changes: a group edge with no order now *moves* instead of holding.

#### [P02] Every engine-authored list registers its cursor handle (DECIDED) {#p02-universal-handles}

**Decision:** `TugListView` registers its `SpatialCursorHandle` whenever it is authored into a focus group and the focus engine is active; the `spatialCursor` prop is removed (its one consumer, `chrome/session-question-dialog.tsx`, drops the prop).

**Rationale:**
- The handle is what makes a list's *edges* visible to the engine, which is where [P01] carries the ring onward; without it, arrows route through the delegate path and clamp at `handleListKey`'s edge.
- The handle's interior behavior is already identical to the delegate path (same `stepCursorableRow`, `moveCursorTo`, commit-on-move, `tryDescendRight`), so interior arrows do not change.
- Chip groups (`use-item-group-keyboard`) already register handles unconditionally; lists become consistent with them.

**Implications:**
- `handleListKey`'s container-edge arrow clause becomes unreachable for bare arrows (the spatial plane consumes first); its row-scope duties and Home/End/Page handling are unchanged and still reached via the delegate.
- Horizontal arrows on a list do **not** become cursor moves — see [P12], which makes the list handle vertical-axis-only. Without that, universalizing handles would silently turn ArrowLeft into "cursor up" on every list in the app (`resolveSpatial` treats a `columns: 1` group as a 1-D run where any arrow steps it), which reads as broken on a full-width vertical list. ArrowRight still tries descend first (`tryDescendRight` precedes movement in `moveKeyViewSpatial`).

#### [P03] Empty-input arrow release is engine policy, all four directions (DECIDED) {#p03-empty-release}

**Decision:** A single shared predicate (Spec S02) in the document keyboard pipeline treats a textual `<input>` that is empty and sits **inside the engine's current key view** as released for all four arrow directions — no per-component wiring. An explicit `data-tug-arrow-release` attribute on the active element overrides the automatic rule (its presence, including the empty string, is authoritative). Release crossings never fire on key auto-repeat (`event.repeat`).

**Rationale:**
- Centralizing in the pipeline's yield check is what makes this a *general* feature: `TugFilterField`, the picker's path field when cleared, and any future `TugInput` participate with zero new props.
- All four directions per [Q03]: an empty field has no caret motion to protect.
- The key-view gate keeps plain non-engine forms untouched and prevents a stale engine key view from being walked while an unrelated input holds focus. It must be a **containment** test (`active.closest("[data-key-view]") !== null`), not an attribute-on-the-active-element test: the projection stamps `data-key-view` on the element resolved from `[data-responder-id]` / `[data-tug-focusable]` (`FocusContext.keyViewElement`), and a composite field registers its **wrapper** as the responder while `document.activeElement` is the inner `<input>` — `TugFilterField` is exactly this shape (`tug-filter-field.tsx`'s `setWrapperRef` passes the wrapper to `responderRef`). An attribute test on the input therefore never matches, which would leave the Lens filter and the picker's Up-from-list-top permanently held **and** send that arrow into the net's gate as unreleased text, ending unconsumed — a beep, against [P08].
- Repeat-gating makes leaving a text surface always a discrete press — the general form of the latch's overshoot protection.

**Implications:**
- The shared predicate is consulted by both `arrowNavListener` (replacing its inline release check) and the new `arrowFallbackListener`.
- `TugFilterField` needs no changes: its `filterFieldDidRequestAdvance` (ArrowDown with a non-empty query, fired from the input's own React keydown at bubble phase) is unreachable when empty (the release path consumes at document capture first) and unchanged when non-empty.

#### [P04] History navigation rides Cmd-Up/Cmd-Down with the at-edge rules; plain arrows are caret-only (DECIDED) {#p04-cmd-history}

**Decision:** In `tug-text-editor/keymap.ts`, plain ArrowUp/ArrowDown never invoke the `HistoryProvider`. Cmd-ArrowUp with the caret collapsed at the document start (the existing `atBackBoundary`) recalls history back; otherwise it falls through to `defaultKeymap`'s `cursorDocStart`. Cmd-ArrowDown symmetric with `atForwardBoundary`/`cursorDocEnd`. Opt-Up/Opt-Down remain the position-independent walk. All history branches keep the existing guards (no Shift/Ctrl, not composing).

**Rationale:**
- Preserves Cmd-Up/Cmd-Down's editing functions exactly (the fall-through the current module docstring defends) while adding history only at the position where the editing function is a no-op.
- Repeated Cmd-Up keeps walking because `navHistory("back")` already lands the caret at index 0, re-satisfying the boundary.
- Kills the overshoot class: no plain-arrow press can ever recall history.

**Implications:**
- The keymap module docstring's "Opt not Cmd" rationale paragraph is rewritten to document the new split.
- Applies to every `historyProvider` consumer automatically: `tug-prompt-entry.tsx` (per-route providers — main prompt and `$` shell command history) and `cards/gallery-text-editor.tsx`.

#### [P05] The editor boundary latch: two discrete presses to exit, vertical only, free when empty, no affordance (DECIDED) {#p05-boundary-latch}

**Decision:** A non-empty `TugTextEditor` exits to the spatial plane only through a latch: the first plain ArrowUp with the caret collapsed at the doc start (ArrowDown at the doc end) is consumed and arms the latch; while armed, the editor's content element carries `data-tug-arrow-release` for that vertical direction, so the *next discrete* press is taken by the document pipeline and moves focus out. `event.repeat` never arms-to-exit or exits (enforced pipeline-side per [P03] and by the keymap consuming repeats while armed). The latch disarms on any selection/document change off the boundary and on blur. An empty editor (doc length 0) releases all four directions with no latch ([Q01]). Left/Right never exit a non-empty editor. No visual affordance ([Q05]).

**Rationale:**
- "Requires an extra arrow key to jump out" — the user-specified ergonomic. Slamming/holding Up parks the caret at the start and stops; both overshoot forms (into history, out of the editor) are gone.
- Reflecting the latch into the existing `data-tug-arrow-release` attribute reuses the pipeline's one release channel — the document-capture listener necessarily runs before CM6's target-phase handlers, so the armed state must be readable *before* the keydown arrives; an attribute computed from editor state is exactly that.
- Vertical-only for non-empty documents: horizontal arrows are high-frequency caret keys; a Left-at-position-0 exit would fire during ordinary editing.

**Implications:**
- The editor owns its release attribute entirely: the `arrowRelease` prop on `TugTextEditor`/`TugMessageEditor` is removed, and `chrome/session-question-dialog.tsx`'s `arrowRelease={empty ? "up down" : undefined}` wiring is deleted (superseded by the built-in emptiness rule, which releases all four — a strict superset).
- The latch state lives in the substrate (a closure in the keymap extension factory plus a CM6 `updateListener` that recomputes the attribute) — never React state ([L02]/[L22]).
- **The exit itself is a handoff first and a release second** — see [P09]. Releasing to the document pipeline only works on a surface whose stops the pipeline can walk; the prompt entry is not such a surface, so the crossing press must be offered to the host before the attribute path is used. Spec S03 encodes both paths.

#### [P06] The Choose Session sheet declares a `rowGridOrder` (DECIDED) {#p06-picker-order}

**Decision:** `SessionProjectPickerForm` (in `cards/session-card.tsx`) declares `useSpatialOrder(rowGridOrder([...]))` over its existing focus keys, rows top-to-bottom: `[browse, path]`, `[filter]`, `[sessions]`, `[trash]`, `[cancel, open]` — using `pickerFocusKey(...)` for each (`session-picker-cycle:{-0.5,0,1,2,3,4,5}`).

**Rationale:**
- [Q04] decided; matches the doctrine's authoring contract ("Declare the arrow order with `useSpatialOrder(rowGridOrder([...]))`" for dialogs/sheets) and the gallery-sheet precedent.
- Gives Cancel/Open a proper horizontal ring (Left/Right swap, wrapping) and a vertical seam cycle, instead of two linear stops.
- The sessions list is a single-node row: `rowGridOrder` gives it no ring, and the engine injects the list's live cursor handle as the group, so interior arrows rove rows and only edge arrows cross the seams — the exact question-dialog shape.

**Implications:**
- The `useSpatialOrder(order)` context form works here because the sheet body renders inside the sheet's trap (`FocusModeScope`); the call sits in the form component whose content is inside the trap, per the gallery-sheet pattern. If the registration lands in the base mode instead (the context form no-ops there), that is the signal it was called outside the trap — move it inside.
- The filter field's `filterFieldDidRequestAdvance` → `place(sessions)` stays (non-empty query path); the empty path now also works via [P03].

#### [P07] Doctrine moves with the code (DECIDED) {#p07-doctrine}

**Decision:** `tuglaws/focus-language.md` is amended in this phase: the liveliness net is documented as the universal floor (not a property of declared scopes); "An empty text field spends `Tab` on movement" gains its sibling rule — an empty text field spends *arrows* on movement; the editor boundary latch and the Cmd/Opt/plain history split are recorded under "Arrow ownership"; the descended-scope "consumed and nothing moves at an edge" sentence is scoped explicitly to row scopes (list-container edges now traverse).

**Rationale:**
- The law is the contract reviewers enforce; shipping behavior the law contradicts invites "fixes" that regress this work.

**Implications:**
- A grep sweep of `tuglaws/` for `spatialCursor`, `arrow-release`, and arrow-ownership statements, updating any that the change invalidates (`list-view-usage.md` describes list arrow behavior; `component-authoring.md` may reference the authoring contract).

#### [P08] Consumption is guaranteed at every changed site (DECIDED) {#p08-never-beep}

**Decision:** Each changed site preserves an explicit consume-or-hand-off: `moveKeyViewSpatial`'s edge fallback returns `true` after walking (or holds and returns `true` if the walk finds nothing to move to — an empty registry); `arrowFallbackListener` consumes iff it walks; the editor latch consumes the arming press and repeats; released presses are consumed by the pipeline stage that acts on them.

**Rationale:**
- The app runs in a WKWebView; an unhandled keydown can bounce to the macOS responder chain and beep. "Never beeps" is a standing invariant of the spatial model.

**Implications:**
- Unit tests assert the boolean returns at the engine layer, not just the movement.

#### [P09] The editor's arrow exit is a host handoff into the card's focus cycle (DECIDED) {#p09-exit-handoff}

**Decision:** A text editor leaves for the spatial plane by **offering the gesture to its host first**. `TugTextEditor` gains `onArrowExit?: (step: 1 | -1) => boolean` (Up/Left → `-1`, Down/Right → `+1`), forwarded through `TugMessageEditor` and `TugPromptEntry`, and wired by the session card to `cycle.enterAt(\`${SESSION_CYCLE_GROUP}:${SESSION_CYCLE_ORDER_EDITOR}\`, step)`. A host that returns `true` consumes the press. Only when no host callback is supplied (or it returns `false`) does the editor fall back to the `data-tug-arrow-release` attribute path, letting the document pipeline's spatial plane / net take the next press.

**Rationale:**
- **The release-only design does not work on the prompt entry, the surface this phase exists to fix.** The session card registers no base-mode focusables (see [#session-card-cycle]); every stop lives in the trapped cycle mode. A released arrow would reach the net, find an empty `walkOrder()`, decline to consume, and fall through to WebKit — a beep and no movement, violating [P08].
- This is **not a second mechanism**: it is the existing `onTabWhenEmpty` rule applied to arrows. `focus-language.md` already documents Tab-out-of-an-empty-field as "hands the gesture to the host, which enters its focus-cycling mode **at that field's own seat in the order** and takes one step (`useCycleMode`'s `enterAt`)", and the prompt entry already exposes exactly that prop shape (`onTabWhenEmpty?: (step: 1 | -1) => boolean`, "Return `true` to consume; a host that returns `false` (or is absent) leaves Tab to the editor").
- `enterAt` is correct for both entry conditions: it pushes the cycle mode only when not already cycling, seeds the ring on the caller's own seat, and steps off it unconditionally.
- The attribute fallback is still needed for editors that ARE stops inside a surface the pipeline can walk (the question dialog's answer field), so both paths earn their place.

**Implications:**
- The latch's armed state must NOT project the release attribute when a host callback is present — otherwise the document-capture listener takes the crossing press before CM6's target-phase handler runs and the handoff never fires. Spec S03 makes the projection conditional on the absence of a host callback.
- Applies identically to the empty-editor free traversal ([Q01]): empty + host callback → handoff on the first press; empty + no callback → attribute releases all four.

#### [P10] The editor stop joins the session card's cycle spatial grid (DECIDED) {#p10-editor-in-grid}

**Decision:** `SESSION_CYCLE_ORDER_EDITOR` is added to `cycleSpatialOrder` in `cards/session-card.tsx` as its own single-node row, seated so its seams match on-screen adjacency — the natural seat is between the PULSE row and the attachment row, which is what that grid's own comment says Down from a status cell should reach ("Down from a status cell reaches the editor / attachments instead"). The implementer verifies the seat by keyboard walk against the rendered layout before committing.

**Rationale:**
- The stop is currently excluded, and the code states the reason: *"it is deactivated while cycling and a focused editor keeps its caret arrows ([P25] editing-host yield), so it is deliberately left OUT of the grid."* The latch ([P05]) retires that premise — a focused editor no longer keeps its caret arrows unconditionally, and the editor stop is now a legitimate arrow destination.
- Without the row, the editor stop is off the spatial plane inside the cycle: an arrow that should cross *onto* or *through* it instead resolves against a grid that does not contain it, so the seams jump from PULSE straight to the attachments. The phase's tenet is "the element in the direction of that arrow," and the editor is one of those elements. (The exit gesture itself lands correctly either way — `enterAt` steps the linear numeric walk, where editor `19` already sits between PULSE `18` and attachments `20+`; the row is about arrows *within* the cycle, not about the handoff.)

**Implications:**
- The comment justifying the exclusion is rewritten in the same commit (a stale rationale is how this decision gets silently reverted).
- `rowGridOrder` drops empty rows, so no per-state membership logic is needed; the single-node row gets no horizontal ring and the seams carry Up/Down across it.

#### [P11] The editor takes no ring; the ring belongs to the input-area stop and the caret to the editor (DECIDED) {#p11-ring-vs-caret}

**Decision:** This phase adds no focus ring to any `TugTextEditor`. The focus signature stays as the language already defines it: while the user is typing, the editor shows a **caret** and no ring; while the keyboard is cycling, the ring lands on the **input-area wrapper** stop (`.tug-prompt-entry-input-area[data-key-view-kbd]`) with the editor deactivated and blurred, and `Return` descends back into typing (the editor-as-text-stop design, `onResumeTyping` — note the prompt entry's own docstrings label this `[P10]`/`[P11]`, which are *that* plan's numbers, unrelated to this plan's [P10]/[P11]).

**Rationale:**
- Already the law and already the code: `tug-text-editor.css` gates its ring rule on `data-focus-stop` and records that "An editor that is not a stop (the prompt entry, a text card) never matches, so its focus language is untouched." The prompt entry's editor is not a focus stop — it is reached by click or `focusResponder`.
- Recording it here is defensive: this phase is the first to make arrows move focus *into and out of* editors, which is precisely the change that would tempt an implementer to paint a ring on the editor so the landing is visible. The landing is visible — on the wrapper.
- It also settles what an arrow exit/entry means visually, which the plan otherwise left unstated: exit blurs the editor (caret gone, ring elsewhere); entry rings the wrapper (no caret) and needs `Return` to type.

**Implications:**
- The app-test asserts `data-key-view-kbd` lands on `.tug-prompt-entry-input-area` and never on `.tug-text-editor`.
- Consistent with [Q05]'s no-affordance ruling: the armed latch adds no mark, and the caret resting at the document edge is the honest signal that the press changed nothing.

#### [P12] A list's cursor handle is vertical-axis only (DECIDED) {#p12-vertical-handle}

**Decision:** `SpatialCursorHandle` gains an optional `axis?: "vertical" | "both"` (default `"both"`, preserving chip-group behavior); `TugListView` declares `"vertical"`. In `moveKeyViewSpatial`, a horizontal direction against a `"vertical"` handle passes `cursorIndex: null` to `resolveSpatial`, so group delegation is skipped and the arrow falls through to seam → ring → the liveliness net.

**Rationale:**
- `resolveSpatial` treats a `columns: 1` group as a 1-D run in which **any** arrow steps the cursor, so universalizing handles ([P02]) would make ArrowLeft mean "cursor up" on every list in the app. On a full-width vertical list in a one-column pane that is not "the element in the direction of the arrow" — it is a bug the user would report.
- Today Left/Right on a Lens list are simply unconsumed (`handleListKey` returns `false` and nothing downstream claims them), so neither the current nor the naive new behavior is right; this decision picks the correct third option.
- `tryDescendRight` is consulted *before* this in `moveKeyViewSpatial`, so ArrowRight still descends into a row's accessories where one exists — the [P02] disclosure model is untouched.

**Implications:**
- Behavior change for the question dialog's answer list (its Left/Right currently rove the cursor): Left/Right there now cross the dialog's declared seams instead. That is the more correct reading, and at0202-family runs as a watch-item.
- Chip groups (`use-item-group-keyboard`) keep `"both"` — their both-axes roving is the documented, correct behavior for inline chips.

---

### Deep Dives {#deep-dives}

#### The session card's focus cycle — why the editor cannot simply release {#session-card-cycle}

The single most important structural fact for this phase, verified 2026-08-03 and not obvious from any one file:

**The session card has no base-mode focusables.** Every `focusGroup=` site in `cards/session-card.tsx` resolves to `SESSION_CYCLE_GROUP` or the picker sheet's group. `SESSION_CYCLE_GROUP` is the group of a `useCycleMode` scope — a **trapped** focus mode entered by ⌥⇥ (`enter()` → `focusFirstInMode`) or by Tab-from-an-empty-composer (`onTabWhenEmpty` → `enterAt`). Its stops are the route chip, Claude Code / Session / Project / Mode / Model / Effort, Submit, the ⌘F find-bar controls, the status cells, PULSE, the attachment tiles, and the editor text stop.

**The prompt editor is not a focus stop.** `TugTextEditor`'s `focusGroup` prop docstring: "When omitted the editor stays outside the walk and is reached by click / an explicit `focusResponder` (the prompt entry's path)." What registers instead is the **input-area wrapper**, via `TugPromptEntry`'s `editorFocusGroup` / `editorFocusOrder` (supplied by the card as `SESSION_CYCLE_GROUP` / `SESSION_CYCLE_ORDER_EDITOR`) — the editor-as-text-stop design (labelled `[P10]`/`[P11]` in the prompt entry's own docstrings; those are that plan's numbers, not this one's): the cycle lands the ring on the wrapper while the editor stays blurred (`deactivated`), and its key-view behavior declares `currentItemDescendable`, so `Return` fires `onResumeTyping` and drops the user back into the caret.

Consequences the plan is built on:

- A base-mode linear walk from the resting editor has an **empty `walkOrder()`**. `advance()` returns `null` (and note: when the key view is merely *absent* from a non-empty order, `advance()` starts at the first element — so on a card that did have stray base stops, the net would land the ring somewhere arbitrary rather than no-op; both outcomes are wrong). This is why [P09] exists.
- Once inside the cycle, arrows already work spatially: the card declares `cycleSpatialOrder` (a `rowGridOrder`) under `cycle.scopeId`. So the exit's whole job is to get *into* that mode at the right seat — which is exactly `enterAt`'s contract.
- `enterAt(fromFocusKey, step)` pushes the mode only when not already cycling, `realizeTarget`s the caller's own focus key as a synchronous unpainted seat, then `focusNext`/`focusPrevious` and `focusKeyView()`. It returns `false` (and pops the mode if it pushed one) when nothing moved, which is the honest signal for the editor to fall back to its attribute path.

#### The document keyboard pipeline today {#pipeline-today}

All stages are document-**capture** `keydown` listeners installed in one effect in `tugdeck/src/components/tugways/responder-chain-provider.tsx` (search for the registration block that adds `focusWalkListener`), in this order: `focusWalkListener` (Tab/Shift-Tab) → `arrowNavListener` (bare arrows → spatial plane) → `captureListener` (keybinding map) → `actDispatchListener` (Space/Enter/Escape) → `keyViewDelegateListener` (forwards to `focusManager.dispatchKeyToKeyView` → the key view's `KeyViewBehavior.onKey`; bails when `document.activeElement` is INPUT/TEXTAREA/contentEditable) → `engineScrollKeyListener` (Page/Home/End) → `bubbleListener` (bubble phase). Capture listeners on `document` run before any target-phase handler — including CM6's `EditorView.domEventHandlers` and React's delegated handlers — which is why release state must be readable *from the DOM before the keydown* (an attribute), and why the new net stage after the delegate still runs before a focused editor could consume (hence its text-surface gate).

`arrowNavListener` today: bails on any modifier; yields to a DOM-focused text surface (INPUT/TEXTAREA/contentEditable) unless the element's `data-tug-arrow-release` lists the direction; yields-with-delivery when `focusManager.keyViewCaptures(key)` (sliders, the filter field's Escape); else consumes iff `focusManager.moveKeyViewSpatial(direction)` returns true. Consumption is `preventDefault()` + `stopImmediatePropagation()` — the latter is what keeps later document-capture stages from double-handling, so the new net stage naturally never sees a consumed key.

#### `moveKeyViewSpatial` resolution, and the two changed branches {#spatial-resolution}

`FocusContext.moveKeyViewSpatial` (in `tugdeck/src/components/tugways/focus-manager.ts`): Right first tries the cursor handle's `tryDescendRight()`; then reads `spatialOrderInScope()` (top-down mode-stack walk, stops at the first trapped mode, base-mode fallback); **returns `false` when there is no order and no handle** (branch (b) of [P01] replaces the eventual dead-end); resolves via `resolveSpatial` (`spatial-order.ts` — override → group-cursor delegation → seam → ring → none), injecting the ringed node's live handle as the group; `cursor` resolutions drive `handle.moveCursor(delta)`; `ring` resolutions land via `setKeyView` + `focusKeyView` with a liveliness fall-through for absent/non-interactive targets; nodes inside a declared order get the existing linear fallback (`focusNext`/`focusPrevious`, wrapping, with a dev-time `warnDeadArrow`); and finally **a group at an edge in a scope with no declared order holds (clamps) and returns `true`** — branch (a) of [P01] replaces this clamp with the linear walk. `focusNext`/`focusPrevious` walk `orderedFocusables` modulo its length (wrap is free) and are mode-bounded, so the sheet's walk never escapes the trap.

#### List arrows: two paths, one owner after this phase {#list-arrows}

`TugListView` (`tugdeck/src/components/tugways/tug-list-view.tsx`) currently has both paths: (1) the `SpatialCursorHandle` built in `cursorHandleRef` — `length`/`cursorIndex` over *cursorable* rows, `moveCursor` via `stepCursorableRow`+`moveCursorTo`(+`selectCursorRow` when commit-on-move), `tryDescendRight` via `rowFirstFocusableId`+`descendCursorRow` — registered in a layout effect **gated on the `spatialCursor` prop** (default false; sole consumer `chrome/session-question-dialog.tsx`); and (2) `handleListKey`, reached through the key-view delegate, which owns descended row-scope arrows (horizontal walk with Left-off-first-ascends; vertical ordinal-carrying row hop; Home/End/Page ascend-then-jump) *and* container-cursor arrows, whose edge behavior is clamp-and-consume (`next === cur` → consume). After [P02], bare container arrows always route through the handle (path 1), and `handleListKey` keeps row scopes + Home/End/Page. The delegate stage's INPUT/contentEditable bail means a released empty input's arrow skips the delegate entirely and reaches the net — correct, since the input (a leaf) has no `onKey`.

The cursor-seed effect ("Land / clear the cursor as the container gains or loses the keyboard key view") already seeds the cursor on entry (initialSelectedIndex → selection → first cursorable row) and retains it across exits, so a seam/net entry from either direction lands on the remembered or seeded row — no new entry logic needed.

#### Editor keymap and release mechanics today {#editor-keymap-today}

`tugdeck/src/components/tugways/tug-text-editor/keymap.ts` — `tugTextEditorKeymap(getConfig)` returns a `Prec.high` bundle: `EditorView.domEventHandlers.keydown` handling Enter family + history nav, plus a `keymap.of` for Ctrl-U/Ctrl-W/Alt-F/Alt-B. History today: plain Up/Down (no Shift/Ctrl/Meta, not composing) → Opt variant walks anywhere; bare variant walks only from the matching boundary (`atBackBoundary` = selection collapsed at 0; `atForwardBoundary` = collapsed at doc end) via `navHistory`, which lands the caret on the boundary being navigated toward. Cmd-Up/Down deliberately fall through to `defaultKeymap`'s `cursorDocStart`/`cursorDocEnd` (the module docstring documents this choice — that paragraph gets rewritten under [P04]). The factory is called once per editor instance, so closure state in it is per-editor — where the latch lives.

`tugdeck/src/components/tugways/tug-text-editor.tsx` — the `arrowRelease?: string` prop is written to the CM6 content element (`.cm-content`, which is `document.activeElement` when the editor is focused) in a layout effect (`content.setAttribute("data-tug-arrow-release", arrowRelease)` / removed when unset). `tug-message-editor.tsx` forwards the prop; `chrome/session-question-dialog.tsx` is the sole producer (`arrowRelease={empty ? "up down" : undefined}`). Under [P05] this becomes editor-owned: a CM6 `updateListener` (plus focus/blur) recomputes the attribute from `{doc empty | latch armed at which edge}` and the prop chain is deleted.

#### Surface facts: Lens and Choose Session sheet {#surface-facts}

**Lens** (`tugdeck/src/components/lens/`): each section is one focus group `lens-section-<kind>` (`sectionFocusGroup` in `lens-section-registry.ts`); the filter field registers at `focusOrder={-1}`, the list at order 0 (`lens-section-band.tsx`); `lens-content.tsx` calls `setGroupOrder(order.map(sectionFocusGroup))` so the walk order tracks rendered section order — which is why the net's linear walk is the correct spatial order for this one-column pane with zero new authoring. Sections gate their focus group on `navigable` (post-filter row count, `lens-section-content.ts`), so an empty/filtered-out section drops out of the walk and the net skips it for free. The Lens lists pass no `spatialCursor` today.

**Choose Session sheet** (`SessionProjectPicker`/`SessionProjectPickerForm` in `tugdeck/src/components/tugways/cards/session-card.tsx`): one cycle group `PICKER_CYCLE_GROUP = "session-picker-cycle"` with orders `PICKER_ORDER_BROWSE = -0.5`, `PATH = 0`, `FILTER = 1`, `SESSIONS = 2`, `TRASH_ALL = 3`, `CANCEL = 4`, `OPEN = 5`, and `pickerFocusKey(order)` building `group:order` keys. The sheet mounts with `onOpenAutoFocus: (e) => e.preventDefault()` (engine owns the seed); the filter delegate's ArrowDown advance places `pickerFocusKey(PICKER_ORDER_SESSIONS)`. The list is `TugListView` single-select with selection-follows-cursor. No spatial order is declared today (the `useSpatialOrder` call in this file belongs to the *connected* card's cycle scope, not the picker). The authored-order pattern to copy is in `cards/gallery-sheet.tsx`: `rowGridOrder([[field],[cancel, commit]])` memoized + `useSpatialOrder(order)` (context form) + `useSeedKeyView(...)`, called in the component rendered inside the sheet.

**Path field note:** the project-path field virtually always contains text, so per [P03] it keeps its arrows for the caret; the sheet's vertical traversal reaches it via the authored seams and leaves via Tab or (when someone clears it) the release rule. This is by design, not a gap.

---

### Specification {#specification}

**Spec S01: The arrow fallback (net) stage** {#s01-net-stage}

`arrowFallbackListener(event)`, document-capture keydown, registered immediately after `keyViewDelegateListener` (and symmetrically removed in the cleanup). In order:

1. Bail if `event.defaultPrevented` — the same guard `keyViewDelegateListener` and `engineScrollKeyListener` already carry, against a capture listener outside this ladder that calls `preventDefault` without `stopImmediatePropagation`.
2. Bail unless `arrowDirection(event.key)` is non-null and no modifier is held (same modifier set as `arrowNavListener`: meta/ctrl/alt/shift).
3. Bail if `event.repeat` and the active element is a text surface (release crossings are discrete-press only; non-text engine stops keep repeat, so a held arrow still roves a list cursor via the earlier stage).
4. Active-element gate: let `active = document.activeElement`. Proceed only when `active` is `null`, `document.body`, an element matching `[data-tug-key-sink]` (or inside one), **or** a text surface for which the shared release predicate (Spec S02) passes for this direction. Any other focused element (Radix menu item, native control, unreleased text) → bail.
5. Bail if `focusManager.keyViewCaptures(key)` (defensive parity with the earlier stage).
6. Call `focusManager.moveKeyViewLinear(direction)`. On a non-null id, realize it with `focusManager.place(null, { kind: "focusable", id }, { modality: "keyboard" })` and consume (`preventDefault` + `stopImmediatePropagation`). On `null` — nothing registered to move to — do **not** consume; decline and let the key continue (by [P09] no released text surface can reach this state with an empty walk, so this branch is a defensive no-op, not a beep path).

`FocusContext.moveKeyViewLinear(direction): string | null`: `down`/`right` → `this.focusNext()`, `up`/`left` → `this.focusPrevious()`; returns the moved focusable id, or `null` when the current mode has no participating focusables. It performs **no focus write** — realization belongs to the caller, so this method never becomes a second focus writer ([L22]). The [P01] site (a) replacement inside `moveKeyViewSpatial` calls it and then `focusKeyView()` (the context-internal path the existing liveliness net already uses), returning `true` regardless of the result — the group holds rather than beeping, preserving [P08]. Delegated on `FocusManager` like the other key-view calls.

**Spec S02: The text-surface release predicate** {#s02-release-predicate}

A new module `tugdeck/src/components/tugways/arrow-release.ts` exporting a **pure predicate** plus a thin DOM adapter, used by `arrowNavListener` (replacing its inline check) and `arrowFallbackListener`. The split exists because tugdeck's `bun test` runs **DOM-free** (`bunfig.toml` preloads only console silencing; the existing suites are pure by policy and the engine itself guards on `typeof document === "undefined"`) — so the policy is expressed over a plain structural value the unit test can build by hand, and the one place that touches the DOM is covered end-to-end by the app-tests.

```
interface ArrowReleaseSubject {
  tag: string;                  // uppercased tagName
  contentEditable: boolean;
  inputType: string | null;     // the `type` attribute; null when absent
  value: string | null;         // the input's value; null for non-inputs
  releaseAttr: string | null;   // data-tug-arrow-release; null when absent
  inKeyView: boolean;           // is, or is contained in, the [data-key-view] element
}

arrowReleaseSubject(active: Element | null): ArrowReleaseSubject | null   // DOM adapter
resolveArrowRelease(subject: ArrowReleaseSubject | null, direction: SpatialDirection):
  "not-text" | "released" | "held"
```

- A `null` subject (no active element) or a subject that is not INPUT/TEXTAREA/contentEditable → `"not-text"` (callers treat per their own gates).
- If `releaseAttr !== null`, the attribute is authoritative: released iff its space-separated tokens include the direction. (This is the editor channel — emptiness and the latch are both projected into it by the substrate, per [P05].)
- Otherwise, auto-release: released iff the subject is an `<input>` whose `inputType` is textual (`text`, `search`, `url`, `email`, `tel`, or `null`), whose `value === ""`, and whose `inKeyView` is true. All four directions release ([Q03]).
- `inKeyView` is a **containment** test in the adapter — `active.closest("[data-key-view]") !== null`, not `active.hasAttribute("data-key-view")`. The projection stamps the mark on the responder/focusable element, which for a composite field is the wrapper, not the inner `<input>` that holds DOM focus ([P03] rationale). Getting this wrong disables the feature on every `TugFilterField` in the app.
- TEXTAREA and contentEditable without the attribute are always `"held"` (multi-line surfaces own their emptiness semantics via the attribute — the editor after [P05]).
- Callers must apply the repeat rule: a `"released"` verdict on `event.repeat` is treated as `"held"`.

**Spec S03: The editor latch state machine** {#s03-latch}

Per-editor closure state in `tugTextEditorKeymap`'s factory: `armedEdge: "start" | "end" | null`. The config thunk gains `onArrowExit?: (step: 1 | -1) => boolean` ([P09]).

**The exit is a handoff first, a release second.** Which path is live depends on whether the host supplied `onArrowExit`:

| | Host supplied `onArrowExit` (the prompt entry) | No host callback (a dialog's editor) |
|---|---|---|
| Crossing press | handled **in the keymap**: call `onArrowExit(step)`; `true` → consume | handled **by the document pipeline**, via the released attribute |
| Release attribute | never set for the latch (see below) | set while armed / while empty |

The attribute must not be set on the handoff path: document-capture listeners necessarily run before CM6's target-phase handlers, so a set attribute means the pipeline takes the crossing press and the handoff never fires ([P09]).

`projectRelease(view)` writes `data-tug-arrow-release` on `view.contentDOM`:

- Host callback present → always remove the attribute (the keymap owns every exit).
- Else doc empty → `"up down left right"`.
- Else `armedEdge === "start"` and selection collapsed at 0 → `"up"`; `armedEdge === "end"` and selection collapsed at doc end → `"down"`.
- Otherwise remove the attribute.

Transitions in the keydown handler (plain arrows only — no meta/alt/ctrl/shift, not composing):

- **Empty document.** Any arrow: with a host callback → `onArrowExit(step)` (Up/Left `-1`, Down/Right `+1`); consume iff it returned `true`. Without one → fall through (the attribute already released it to the pipeline, which handled the key before CM6 saw it). Never on `event.repeat` — a repeat consumes and holds ([P03]'s discrete-press rule).
- **Non-empty, arming.** ArrowUp with `atBackBoundary` and `armedEdge !== "start"` → set `armedEdge = "start"`, reproject, consume. ArrowDown symmetric with `"end"`.
- **Non-empty, crossing.** ArrowUp while `armedEdge === "start"`, not `event.repeat`, with a host callback → `onArrowExit(-1)`; consume iff `true`; if it returns `false`, stay armed and consume (never beep, [P08]). ArrowDown symmetric with `+1`. Without a host callback the crossing press never reaches the keymap — the pipeline took it via the attribute.
- **Repeat while armed** → consume (a held key parks at the edge and never crosses).
- **Disarm.** Any transaction whose selection leaves the armed boundary, or that changes the doc, → `armedEdge = null` + reproject (a CM6 `updateListener` owns this; it also reprojects on emptiness changes and on host-callback identity changes). Blur (`focusChange` false) → disarm + reproject.

The `arrowRelease` prop on `TugTextEditor`/`TugMessageEditor` and the static attribute effect are removed; `projectRelease` is the only writer.

**Table T01: Editor arrow-key meanings after this phase** {#t01-editor-keys}

| Key | Caret mid-document | Caret at doc start | Caret at doc end | Empty document |
|-----|--------------------|--------------------|------------------|----------------|
| Up | line up | 1st press: arm (consume); next discrete press: exit up (handoff → `enterAt(-1)`, or release) | line up | exit up (free) |
| Down | line down | line down | 1st press: arm; next discrete press: exit down (handoff → `enterAt(+1)`, or release) | exit down (free) |
| Left / Right | caret | caret (never exits) | caret (never exits) | exit (free; step `-1` / `+1`) |
| Cmd-Up | `cursorDocStart` | history back (repeats keep walking) | `cursorDocStart` | history back |
| Cmd-Down | `cursorDocEnd` | `cursorDocEnd` | history forward (repeats keep walking) | history forward |
| Opt-Up / Opt-Down | history walk (unchanged) | history walk | history walk | history walk |
| held (auto-repeat) Up/Down | caret lines | parks at edge, never exits | parks at edge, never exits | no exit on repeat ([P03] repeat rule) |

**Spec S04: Choose Session sheet spatial order** {#s04-picker-grid}

In `SessionProjectPickerForm`, memoized on nothing (the keys are constants):

```
rowGridOrder([
  [pickerFocusKey(PICKER_ORDER_BROWSE), pickerFocusKey(PICKER_ORDER_PATH)],
  [pickerFocusKey(PICKER_ORDER_FILTER)],
  [pickerFocusKey(PICKER_ORDER_SESSIONS)],
  [pickerFocusKey(PICKER_ORDER_TRASH_ALL)],
  [pickerFocusKey(PICKER_ORDER_CANCEL), pickerFocusKey(PICKER_ORDER_OPEN)],
])
```

registered with the context form `useSpatialOrder(order)` from inside the sheet body (the trap's `FocusModeScope`). `rowGridOrder` semantics (from `spatial-order.ts`): rows of ≥2 become closed horizontal rings; every node seams down to the next row's first member and up to the previous row's, cycling top↔bottom; the sessions list row is single-node so it gets no ring and the engine's injected live cursor handle roves its interior, seams firing only at the cursor's edges.

#### State Zone Mapping (tugdeck/tugways plans) {#state-zone-mapping}

| State | Zone (appearance / local-data / structure) | Mechanism | Law |
|-------|--------------------------------------------|-----------|-----|
| Latch `armedEdge` | substrate-internal (CM6 editor state, not React) | closure in the keymap extension factory + CM6 `updateListener` | [L02] (never React state into CM6), [L22] |
| `data-tug-arrow-release` projection | appearance / declared DOM state | attribute writes from the substrate (`projectRelease`) and the release predicate reads | [L06] |
| Cursor-handle registration (all lists) | structure (engine config) | `registerCursorHandle` in a layout effect | [L03], [L22] |
| Picker `SpatialOrder` | structure (engine config) | `useSpatialOrder` (layout-effect registration) inside the trap scope | [L03], [L22] |
| Editor row in `cycleSpatialOrder` | structure (engine config) | memoized order + `useSpatialOrder(cycle.scopeId, …)` (already in place) | [L03], [L22] |
| Exit handoff (`onArrowExit`) | not state — a callback prop read live | config thunk in the keymap factory, read at fire time | [L07], [L11] |
| Cycle mode push on exit | structure (engine) | `useCycleMode.enterAt` → `pushFocusMode` / `focusNext` | [L22] |
| Net walk / key-view movement | structure (engine) | `FocusManager.place()` path via `moveKeyViewLinear` | [L22], focus-language "one writer" |

No new React state is introduced anywhere in this phase.

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tugdeck/src/components/tugways/arrow-release.ts` | Spec S02 shared release predicate (+ its unit test in `__tests__/arrow-release.test.ts`) |
| `tests/app-test/atNNNN-lens-cross-section-arrows.test.ts` | Lens section-crossing traversal (number assigned at authoring time from the corpus tail) |
| `tests/app-test/atNNNN-picker-arrow-traversal.test.ts` | Choose Session sheet traversal |
| `tests/app-test/atNNNN-prompt-arrow-latch-history.test.ts` | Editor latch + Cmd-history on the shell route |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `FocusContext.moveKeyViewLinear` | method (new) | `tugways/focus-manager.ts` | Spec S01; delegated on `FocusManager` |
| `FocusContext.moveKeyViewSpatial` | method (modified) | `tugways/focus-manager.ts` | edge clamp → linear walk ([P01] site a) |
| `arrowFallbackListener` | fn (new) | `tugways/responder-chain-provider.tsx` | Spec S01 stage; registered after `keyViewDelegateListener` |
| `arrowNavListener` | fn (modified) | `tugways/responder-chain-provider.tsx` | inline release check → Spec S02 helper + repeat rule |
| `resolveArrowRelease` | fn (new) | `tugways/arrow-release.ts` | Spec S02 — pure predicate over `ArrowReleaseSubject`, unit-testable DOM-free |
| `ArrowReleaseSubject` | interface (new) | `tugways/arrow-release.ts` | Spec S02 — the structural view the predicate reads |
| `arrowReleaseSubject` | fn (new) | `tugways/arrow-release.ts` | Spec S02 — the one DOM read; `inKeyView` via `closest("[data-key-view]")` |
| `TugListViewProps.spatialCursor` | prop (removed) | `tugways/tug-list-view.tsx` | handle registration now gated only on engine-active + focus group |
| `SpatialCursorHandle.axis` | field (new, optional) | `tugways/focus-manager.ts` | [P12]; `"vertical" \| "both"`, default `"both"`; `TugListView` declares `"vertical"` |
| `TugTextEditorProps.onArrowExit` | prop (new) | `tugways/tug-text-editor.tsx` | [P09] `(step: 1 \| -1) => boolean`; mirrors `onTabWhenEmpty`'s shape |
| `TugMessageEditorProps.onArrowExit` | prop (new) | `tugways/tug-message-editor.tsx` | forwarder |
| `TugPromptEntryProps.onArrowExit` | prop (new) | `tugways/tug-prompt-entry.tsx` | forwarded to the editor; documented beside `onTabWhenEmpty` |
| `TugTextEditorKeymapConfig.onArrowExit` | field (new) | `tugways/tug-text-editor/keymap.ts` | Spec S03; read live through the config thunk ([L07]) |
| `cycleSpatialOrder` | modified | `tugways/cards/session-card.tsx` | [P10] editor row added; exclusion comment rewritten |
| session-card editor wiring | modified | `tugways/cards/session-card.tsx` | `onArrowExit={(step) => cycle.enterAt(\`${SESSION_CYCLE_GROUP}:${SESSION_CYCLE_ORDER_EDITOR}\`, step)}` |
| `tugTextEditorKeymap` | fn (modified) | `tugways/tug-text-editor/keymap.ts` | [P04] Cmd-history branches; [P05] latch; plain-arrow history removed |
| `projectRelease` | fn (new) | `tugways/tug-text-editor/keymap.ts` (or a small sibling module) | Spec S03 attribute projection |
| `TugTextEditorProps.arrowRelease` | prop (removed) | `tugways/tug-text-editor.tsx` | attribute becomes substrate-owned |
| `TugMessageEditorProps.arrowRelease` | prop (removed) | `tugways/tug-message-editor.tsx` | forwarder deleted |
| question-dialog answer field wiring | modified | `tugways/chrome/session-question-dialog.tsx` | drop `arrowRelease` + `spatialCursor` props |
| `SessionProjectPickerForm` | component (modified) | `tugways/cards/session-card.tsx` | Spec S04 order registration |

---

### Documentation Plan {#documentation-plan}

- [ ] Amend `tuglaws/focus-language.md` per [P07] (universal net; empty-field arrow rule; latch; Cmd/Opt/plain history table; scope the edge-consumption sentence to row scopes).
- [ ] Record in `focus-language.md`, beside the existing "An empty text field spends `Tab` on movement" rule, that the **arrow exit is the same handoff** ([P09]) — a text surface leaves via its host's `enterAt` seat, not a parallel walk — and that the editor takes no ring ([P11]): ring on the input-area stop, caret in the editor, never both.
- [ ] Rewrite the `cycleSpatialOrder` comment in `cards/session-card.tsx` that justifies excluding the editor stop ([P10]); a stale rationale is how this decision gets silently reverted.
- [ ] Sweep `tuglaws/` for `spatialCursor` / `arrow-release` / arrow-ownership statements (`list-view-usage.md`, `component-authoring.md`) and update any invalidated by [P02]/[P03]/[P05].
- [ ] Update the module docstrings the changes touch (keymap.ts history rationale; tug-list-view spatial-cursor comment; responder-chain-provider ladder comment).
- [ ] Mark `dash/arrow-traversal-brief.md` as superseded by this plan (one line at the top).

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit (`bun test`, tugdeck)** | Engine resolution logic: `moveKeyViewLinear`, edge fallback, axis gating, release predicate, keymap boundary/latch/exit predicates | Steps 1–4, 7–8; the existing harness in `__tests__/spatial-nav.test.ts` builds real `FocusContext`s |
| **App-test (real Tug.app)** | End-to-end traversal on the real surfaces with `nativeKey`, asserting `focusManager.keyView()` / focus mode / `data-key-view` via `evalJS` | Steps 5, 6, 9 |
| **Drift prevention** | at0277/at0282 (row scopes), at0202-family (question dialog release seam), at0248/at0141 (revised deliberately) | run via `just app-test-changed` throughout |

#### What stays out of tests {#test-non-goals}

- No jsdom/fake-DOM render tests and no mock-store assertions — banned patterns; the engine unit tests drive the real `FocusContext`, and everything DOM-dependent is covered by app-tests on the real app.
- No synthetic-keyboard-event simulation of the full document pipeline in unit tests — listener ordering is exercised end-to-end by the app-tests; units cover the pure/manager layers.
- Main-route prompt history recall with a live Claude turn — history mechanics are identical across providers; the shell route (`$` commands, real shell) covers the end-to-end without a real-claude dependency.

---

### Execution Steps {#execution-steps}

> **Commit after all checkpoints pass.** Applies to every step. All tugdeck commands run from `tugdeck/`; app-test commands from the repo root.

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Engine: `moveKeyViewLinear` + group-edge fallback | done | `8e4111f0c` |
| #step-2 | Shared release predicate + `arrowNavListener` rework | done | `910b5ce7a` |
| #step-3 | The net stage: `arrowFallbackListener` | done | `5cb8cf94b` |
| #step-4 | Universal list cursor handles | done | `fe0ff5736` |
| #step-5 | Lens traversal app-tests (`at0341`) | done | `0943a8eaf` |
| #step-6 | Choose Session sheet: authored order + app-tests (`at0342`) | done | `ab07afca9` |
| #step-7 | Editor keymap: Cmd-history, plain arrows caret-only | done | `4a8c14bb4` |
| #step-8 | Editor boundary latch + substrate-owned release | done | `2097b9fb5` |
| #step-9 | Prompt-entry exit handoff + editor row in the cycle grid (`at0343`) | done | `17415cdd3` |
| #step-10 | Doctrine amendments | done | `e181f5d57` |
| #step-11 | Integration checkpoint | done | verification only |

**Step 11 notes.** `just app-test-changed` over the phase's whole diff derives **140 files** and the selector refuses it as a sweep — `focus-manager.ts` alone fans out to 64. The scoped answer run instead: the ~20-file **core tier** (`just app-test`, 20/20 green after the at0168 fix below) plus the phase's own three tests and the six drift tests (9/9 files, 12/12 tests green).

Two pre-existing failures on `main` were found and fixed, neither caused by this phase:

- **at0248 / at0277 / at0282** assumed ⌘L seeds the Lens **Snippets** list. It seeds the first expanded section with navigable content, which became **Cards** once that section had a card to show. All three were already red on `main`. Their assertions are untouched — they now Tab to Snippets first. at0248's interior-arrow and focus-invariant assertions passing unmodified is the evidence that universal cursor handles changed no interior behavior.
- **at0168** pinned ⇧⌘P for *Cycle Permission Mode*, but `2d28be623` (on `main`, before this branch) rebound it to ⌃⌘P and never updated the test. `main` looked green only off a **stale app-test bundle**; a fresh build from this worktree surfaced it. The expectation now matches the shipped binding.

**Not verifiable on this machine:** the foreground-class focus tests (at0246, at0250–at0252, at0268, at0272, at0278, at0287) time out on `document.hasFocus()` — they need real key focus, and they fail **identically on unmodified `main`**, so they are a machine condition, not a signal about this work. Re-run them on an idle machine.

#### Step 1: Engine — `moveKeyViewLinear` + group-edge fallback {#step-1}

**Commit:** `tugways(arrow-traversal): universal liveliness net in the spatial navigator`

**References:** [P01] Universal net, [P08] Consumption guaranteed, Spec S01, (#spatial-resolution, #q02-wrap)

**Artifacts:** `FocusContext.moveKeyViewLinear` (+ `FocusManager` delegation); `moveKeyViewSpatial` edge-clamp clause replaced; `spatial-nav.test.ts` updated/extended.

**Tasks:**
- [ ] In `tugdeck/src/components/tugways/focus-manager.ts`, add `moveKeyViewLinear(direction: SpatialDirection): string | null` to `FocusContext` per Spec S01: down/right → `focusNext()`, up/left → `focusPrevious()`, returning the moved focusable id (or `null` when the current mode has no participating focusables); wrap comes free from the modulo walk. It performs **no focus write** — realization belongs to the caller, so this method never becomes a second focus writer ([L22]). Delegate on `FocusManager` alongside `moveKeyViewSpatial`.
- [ ] Replace the final clause of `moveKeyViewSpatial` (the "group at an edge in a scope with NO declared order: hold the cursor (clamp)" branch) with: call `moveKeyViewLinear(direction)` and, on a non-null id, follow it with `this.focusKeyView()` — the context-internal realization the existing in-scope liveliness net already uses. Return `true` regardless of the result (consumption holds even when there is nowhere to go, [P08]). Update the method docstring ("holds at an undeclared edge" → "walks on from an undeclared edge").
- [ ] Leave the `order === undefined && handle === undefined → return false` branch exactly as is (the net stage in #step-3 owns that case; the delegate stage must keep running between them).

**Tests:**
- [ ] `spatial-nav.test.ts`: amend the "never-beep boundaries" cases — a group cursor at its edge with no declared order now moves the key view to the adjacent focusable (wrapping at the registry ends) and still returns true.
- [ ] New unit: `moveKeyViewLinear` returns the moved focusable id and wraps at both ends; returns `null` on an empty registry without throwing; and moves the key view without writing focus (a singleton registry re-returns its one id).

**Checkpoint:**
- [ ] `cd tugdeck && bun test src/components/tugways/__tests__/spatial-nav.test.ts`
- [ ] `cd tugdeck && bun test` (full suite green)

---

#### Step 2: Shared release predicate + `arrowNavListener` rework {#step-2}

**Depends on:** #step-1

**Commit:** `tugways(arrow-traversal): centralized empty-input arrow release with discrete-press crossings`

**References:** [P03] Empty release, [Q03], Spec S02, (#pipeline-today)

**Artifacts:** `tugdeck/src/components/tugways/arrow-release.ts` (+ unit test); `arrowNavListener` consuming the helper.

**Tasks:**
- [ ] Create `arrow-release.ts` per Spec S02: the `ArrowReleaseSubject` structural type, the pure `resolveArrowRelease(subject, direction)` predicate (explicit `data-tug-arrow-release` authoritative when present; else auto-release for an empty textual `<input>` with `inKeyView`; TEXTAREA/contentEditable without the attribute always held), and the `arrowReleaseSubject(active)` DOM adapter — whose `inKeyView` is `active.closest("[data-key-view]") !== null`, **not** an attribute test on the active element itself (the mark lands on the responder wrapper, not the inner input).
- [ ] In `responder-chain-provider.tsx`, replace `arrowNavListener`'s inline text-surface check with `resolveArrowRelease(arrowReleaseSubject(document.activeElement), direction)`, adding the repeat rule: a `"released"` verdict with `event.repeat` is treated as `"held"` (the surface keeps the key; crossing out of text is discrete-press only).

**Tests:**
- [ ] `__tests__/arrow-release.test.ts`, driving `resolveArrowRelease` with hand-built `ArrowReleaseSubject` values — **no DOM**: tugdeck's `bun test` has none (`bunfig.toml` preloads only console silencing; the existing suites are pure by policy), so `document.createElement` would throw. Cases: attribute-authoritative (including empty-string attribute = release nothing); auto-release only for empty + textual type + `inKeyView`; `inKeyView: false` held (the stale-key-view guard); non-empty, non-textual (`type="number"`), and attribute-less TEXTAREA/contentEditable all held.
- [ ] The `arrowReleaseSubject` adapter's DOM reads are covered end-to-end by the Step 5 / Step 6 app-tests — the Lens filter and picker traversals fail outright if the `inKeyView` containment read is wrong.

**Checkpoint:**
- [ ] `cd tugdeck && bun test src/components/tugways/__tests__/arrow-release.test.ts`
- [ ] `cd tugdeck && bunx vite build`

---

#### Step 3: The net stage — `arrowFallbackListener` {#step-3}

**Depends on:** #step-1, #step-2

**Commit:** `tugways(arrow-traversal): post-delegate arrow fallback stage — every unclaimed arrow moves the ring`

**References:** [P01] Universal net, [P08] Consumption, Spec S01, Risk R01, (#pipeline-today)

**Artifacts:** `arrowFallbackListener` in `responder-chain-provider.tsx`, registered (and cleaned up) immediately after `keyViewDelegateListener`.

**Tasks:**
- [ ] Implement `arrowFallbackListener` per Spec S01, in that order: `event.defaultPrevented` bail (parity with `keyViewDelegateListener` / `engineScrollKeyListener`); modifier bail; repeat-on-text bail; active-element gate {null, body, key sink, released text}; `keyViewCaptures` bail; then `moveKeyViewLinear(direction)` and, on a non-null id, `place(null, { kind: "focusable", id }, { modality: "keyboard" })` + consume. A `null` id declines without consuming.
- [ ] Register it in the listener block after `keyViewDelegateListener` and before `engineScrollKeyListener`, with the matching `removeEventListener` in the cleanup; extend the ladder ordering comment to name the new stage and why it sits there (row scopes and `onKey` consumers run first; text surfaces are gated, not raced).

**Tests:**
- [ ] Unit coverage rides Step 1's `moveKeyViewLinear` tests (the listener body is thin by design); end-to-end consumption is asserted by the Step 5/6 app-tests.

**Checkpoint:**
- [ ] `cd tugdeck && bun test && bunx vite build`
- [ ] Manual smoke in the running debug app (HMR is live): in the Choose Session sheet, ArrowDown from the trash row reaches Cancel; in the Lens, arrows still rove lists normally.

---

#### Step 4: Universal list cursor handles {#step-4}

**Depends on:** #step-1

**Commit:** `tugways(arrow-traversal): every engine-authored list registers its spatial cursor handle`

**References:** [P02] Universal handles, Risk table (handle-behavior row), (#list-arrows)

**Artifacts:** `spatialCursor` prop removed from `TugListView`; question-dialog call site updated.

**Tasks:**
- [ ] In `tug-list-view.tsx`, remove the `spatialCursor` prop (declaration, destructuring default, and its term in the handle-registration layout effect — registration now gates on `manager !== null && focusEngineActive` alone; the effect already requires the list to be engine-authored via `focusableId`). Update the handle block comment: the handle is unconditional, and list edges fall through to the navigator's liveliness walk.
- [ ] Implement [P12]: add `axis?: "vertical" | "both"` to `SpatialCursorHandle` (default `"both"`), declare `axis: "vertical"` on `TugListView`'s handle, and in `moveKeyViewSpatial` pass `cursorIndex: null` to `resolveSpatial` for a horizontal direction against a vertical handle so the arrow falls through to seam → ring → net. Leave `tryDescendRight` ahead of it untouched (ArrowRight still descends into row accessories).
- [ ] Remove `spatialCursor` from `chrome/session-question-dialog.tsx`'s `TugListView` usage (now the default behavior).
- [ ] Leave `handleListKey` untouched — its container-edge arrow clause is now unreachable for bare arrows (the spatial plane consumes first) but still serves as the delegate's backstop; note this in its comment rather than deleting the branch (defense in depth for any path that bypasses the spatial plane).

**Tests:**
- [ ] `cd tugdeck && bun test` (list-related suites green).
- [ ] `spatial-nav.test.ts`: a vertical-axis handle at any cursor position yields horizontal arrows to the seam/ring/net rather than stepping the cursor ([P12]); a `"both"` handle (chip group) is unchanged.

**Checkpoint:**
- [ ] `cd tugdeck && bunx vite build`
- [ ] `just app-test tests/app-test/at0277-lens-row-accessories-keyboard.test.ts tests/app-test/at0282-lens-row-arrow-escape.test.ts` — row scopes unmodified and green.
- [ ] `just app-test tests/app-test/at0202-question-review-reveal.test.ts` — the question dialog's list survives the [P12] horizontal change.

---

#### Step 5: Lens traversal app-tests {#step-5}

**Depends on:** #step-3, #step-4

**Commit:** `tugways(arrow-traversal): lens cross-section arrow coverage`

**References:** [P01], [P02], [P03], Success criteria (#success-criteria), (#surface-facts)

**Artifacts:** new `tests/app-test/atNNNN-lens-cross-section-arrows.test.ts` (with `@covers` for `focus-manager.ts`, `responder-chain-provider.tsx`, `arrow-release.ts`, `tug-list-view.tsx`, and the lens section files); at0248 revised.

**Tasks:**
- [ ] Author the new app-test: seed the Lens (⌘L), cursor to the last cursorable Cards row, `nativeKey("ArrowDown")` → assert the key view is the Snippets filter field (`lens-section-snippets:-1`); `ArrowDown` again (field empty) → the snippets list; `ArrowUp` twice retraces; verify a filter field with typed text holds Up/Down (key view unchanged). Assert via `evalJS` on the focus manager / `data-key-view`, identifying landings by element per the doctrine's focus-key caveat.
- [ ] **Verify** `at0248-lens-list-cursor-keys.test.ts` rather than assuming a revision: its arrow assertions are interior moves (ArrowDown ×2, ArrowUp ×1) plus a focus-invariant check, and no edge-clamp assertion was found when this plan was written. Revise only if it does pin an edge. Note its `expect(report!.violations).toBe(0)` / `expect(Object.keys(report!.steals)).toEqual([])` assertions are a free tripwire for any incorrect focus write the net makes — keep them.

**Tests:**
- [ ] The two app-tests above.

**Checkpoint:**
- [ ] `just app-test-covers-check`
- [ ] `just app-test tests/app-test/atNNNN-lens-cross-section-arrows.test.ts tests/app-test/at0248-lens-list-cursor-keys.test.ts`

---

#### Step 6: Choose Session sheet — authored order + app-tests {#step-6}

**Depends on:** #step-3, #step-4

**Commit:** `tugways(arrow-traversal): session picker declares its spatial order`

**References:** [P06] Picker order, [Q04], Spec S04, (#surface-facts)

**Artifacts:** `SessionProjectPickerForm` order registration; new `tests/app-test/atNNNN-picker-arrow-traversal.test.ts`; at0141 revised if it pins dead-end arrows.

**Tasks:**
- [ ] In `cards/session-card.tsx`, add the Spec S04 `rowGridOrder` and register it with the context-form `useSpatialOrder(order)` from inside the sheet body (gallery-sheet pattern; the memoized order is module-computable since `pickerFocusKey` and the order constants are module-level). Verify at runtime that the registration binds to the sheet's trap scope, not base (the context form no-ops at base — a silent no-op here means the call sits outside the trap; move it in).
- [ ] Author the picker app-test: open the sheet, assert filter→list (ArrowDown), list-top→filter (ArrowUp), list-bottom→trash→Cancel (ArrowDowns), Cancel↔Open (ArrowLeft/ArrowRight), and the vertical wrap from the buttons row back to the path row.
- [ ] Review `at0141-picker-keys.test.ts` and `at0265-picker-filter.test.ts` for assertions the new order invalidates (e.g., an edge arrow asserted as a no-op); revise deliberately.

**Tests:**
- [ ] The app-tests above.

**Checkpoint:**
- [ ] `just app-test-covers-check`
- [ ] `just app-test tests/app-test/atNNNN-picker-arrow-traversal.test.ts tests/app-test/at0141-picker-keys.test.ts tests/app-test/at0265-picker-filter.test.ts`

---

#### Step 7: Editor keymap — Cmd-history, plain arrows caret-only {#step-7}

**Commit:** `tugways(arrow-traversal): command history moves to Cmd-Up/Down with the at-edge rules`

**References:** [P04] Cmd-history, Table T01, (#editor-keymap-today), Assumption (bare Cmd-arrows unbound)

**Artifacts:** `tug-text-editor/keymap.ts` reworked; module docstring updated.

**Tasks:**
- [ ] In the keydown handler: add a Cmd-branch (meta, no shift/alt/ctrl, not composing) for ArrowUp/ArrowDown — at the matching boundary (`atBackBoundary`/`atForwardBoundary`) run `navHistory`; otherwise `return false` so `defaultKeymap`'s `cursorDocStart`/`cursorDocEnd` runs.
- [ ] Remove the plain-arrow `atEdge → navHistory` handoff (plain vertical arrows now fall through to caret motion; the latch arrives in #step-8). Keep the Opt-walk branch unchanged.
- [ ] Rewrite the module docstring's history paragraphs to the new split (plain = caret + latch exit; Cmd = editing function with at-edge history; Opt = position-independent walk).

**Tests:**
- [ ] Unit test (new or extended alongside the existing keymap-adjacent tests in `tug-text-editor/`): drive the exported predicates/branch logic — Cmd-Up mid-doc yields false (fall-through), Cmd-Up at start invokes the provider, plain Up at start no longer invokes it. (Structure the branch so the policy is testable without synthesizing a full EditorView, mirroring how `resolveEnterAction` is exported for tests.)

**Checkpoint:**
- [ ] `cd tugdeck && bun test && bunx vite build`
- [ ] Manual: in the running app's shell route, run two commands; Cmd-Up mid-text moves the caret to start; Cmd-Up again recalls; Opt-Up still walks.

---

#### Step 8: Editor boundary latch + substrate-owned release {#step-8}

**Depends on:** #step-2, #step-7

**Commit:** `tugways(arrow-traversal): two-press boundary latch; the editor owns its arrow release`

**References:** [P05] Latch, [P09] Exit handoff, [P11] Ring vs caret, [Q01], [Q05], Spec S03, Table T01, Risk R02, (#editor-keymap-today, #session-card-cycle)

**Artifacts:** latch + exit decision + `projectRelease` in the keymap module; `onArrowExit` added to `TugTextEditor`/`TugMessageEditor`; `arrowRelease` prop removed from both; `session-question-dialog.tsx` wiring dropped.

**Tasks:**
- [ ] Implement Spec S03 in `tug-text-editor/keymap.ts`: the closure `armedEdge`, the `onArrowExit` config field, the arming / crossing / repeat-hold branches, `projectRelease(view)` writing `data-tug-arrow-release` on `view.contentDOM` (**suppressed entirely when a host callback is present** — [P09]), and a CM6 `updateListener` + focus-change hook that disarms and reprojects (selection off boundary, doc change, emptiness change, blur). Bundle the listener into the extension the factory returns so every consumer inherits it.
- [ ] Add the `onArrowExit?: (step: 1 | -1) => boolean` prop to `tug-text-editor.tsx` (into the keymap config ref, [L07]) and forward it from `tug-message-editor.tsx`. Document it beside the existing `tabMovesFocus` / `onTabWhenEmpty` prose as the arrow sibling of the Tab-out-of-empty rule.
- [ ] Remove the `arrowRelease` prop and its layout effect from `tug-text-editor.tsx`, the forwarder from `tug-message-editor.tsx`, and the `arrowRelease={empty ? "up down" : undefined}` wiring in `chrome/session-question-dialog.tsx` (the built-in emptiness rule supersedes it — all four directions instead of two; that editor supplies no `onArrowExit`, so it keeps the release path).

**Tests:**
- [ ] Unit: `projectRelease` truth table (host callback → never set; empty → all four; armed + at-boundary → that direction; otherwise absent); disarm on selection/doc change.
- [ ] Unit: the exit decision — a crossing press with a host callback calls it once and consumes; a callback returning `false` leaves the editor armed and still consumes ([P08]); `event.repeat` never crosses on either path.

**Checkpoint:**
- [ ] `cd tugdeck && bun test && bunx vite build`
- [ ] `just app-test tests/app-test/at0202-question-review-reveal.test.ts` — the dialog editor's release seam survives on the no-callback path.

---

#### Step 9: Prompt-entry exit handoff + editor row in the cycle grid {#step-9}

**Depends on:** #step-8

**Commit:** `tugways(arrow-traversal): the composer's arrow exit enters the card's focus cycle`

**References:** [P09] Exit handoff, [P10] Editor in the grid, [P11] Ring vs caret, [P04] Cmd-history, Table T01, (#session-card-cycle)

**Artifacts:** `onArrowExit` forwarded through `tug-prompt-entry.tsx`; session-card wiring to `cycle.enterAt`; editor row added to `cycleSpatialOrder` with its stale exclusion comment rewritten; new latch/history app-test.

**Tasks:**
- [ ] Forward `onArrowExit` through `TugPromptEntry` to the editor, documented beside `onTabWhenEmpty` (same shape, same contract: return `true` to consume).
- [ ] In `cards/session-card.tsx`, wire it to `cycle.enterAt(\`${SESSION_CYCLE_GROUP}:${SESSION_CYCLE_ORDER_EDITOR}\`, step)` — the same call the existing `onTabWhenEmpty` makes, so the arrow exit and the Tab exit land identically.
- [ ] Add `SESSION_CYCLE_ORDER_EDITOR` to `cycleSpatialOrder` as its own single-node row per [P10] (natural seat: between the PULSE row and the attachment row) and **rewrite the comment** that justifies its exclusion — it currently reads "a focused editor keeps its caret arrows … so it is deliberately left OUT of the grid", which the latch retires. Verify the seat by keyboard walk against the rendered layout before committing.
- [ ] Expect the grid edit **not** to change where the exit itself lands: `enterAt` seeds the seat and steps with `focusNext`/`focusPrevious` — the linear numeric walk — and editor `19` already sits between PULSE `18` and the attachments `20+`, so the landing is right before and after this edit. What the row buys is arrows *inside* the cycle reaching and crossing the editor stop spatially. (With no attachments and the pulse strip hidden, Down from the editor wraps to the route chip — [Q02]'s wrap, working as decided.)
- [ ] Author the app-test on the shell route (`@covers` the keymap module, `tug-text-editor.tsx`, `tug-prompt-entry.tsx`, `cards/session-card.tsx`, `arrow-release.ts`, `responder-chain-provider.tsx`): type text; plain Up walks the caret to the start and the first boundary press does not leave the editor; the second discrete Up puts the card in its cycle mode with the ring on the expected adjacent stop; hold Up (repeat) from a re-entered editor — focus never leaves; clear to empty — a single Up exits; Cmd-Up at start recalls the previous command; and per [P11] assert `data-key-view-kbd` lands on `.tug-prompt-entry-input-area`, never on `.tug-text-editor`.

**Tests:**
- [ ] The app-test above.

**Checkpoint:**
- [ ] `cd tugdeck && bun test && bunx vite build`
- [ ] `just app-test-covers-check && just app-test tests/app-test/atNNNN-prompt-arrow-latch-history.test.ts`
- [ ] Manual: in the running debug app, Up from mid-composer never recalls history and never overshoots out of the editor on one press.

---

#### Step 10: Doctrine amendments {#step-10}

**Depends on:** #step-3, #step-4, #step-9

**Commit:** `tuglaws(arrow-traversal): the liveliness net is universal; empty fields spend arrows on movement`

**References:** [P07] Doctrine, (#documentation-plan), Table T01

**Artifacts:** amended `tuglaws/focus-language.md`; swept `tuglaws/list-view-usage.md` / `component-authoring.md`; brief marked superseded.

**Tasks:**
- [ ] Execute the Documentation Plan (#documentation-plan) in full: the four focus-language.md amendments, the tuglaws sweep (`grep -rn "spatialCursor\|arrow-release\|arrow" tuglaws/`), the touched module docstrings (verify none still describe the old behavior), and the superseded line on the brief.

**Tests:**
- [ ] None (docs).

**Checkpoint:**
- [ ] `grep -rn "spatialCursor" tuglaws/ tugdeck/src` returns no stale references (the prop is gone everywhere).

---

#### Step 11: Integration checkpoint {#step-11}

**Depends on:** #step-5, #step-6, #step-9, #step-10

**Commit:** `N/A (verification only)`

**References:** (#success-criteria, #exit-criteria)

**Tasks:**
- [ ] Walk every success criterion (#success-criteria) against the built app.
- [ ] Confirm at0277/at0282 pass **unmodified** (row-scope invariant).

**Tests:**
- [ ] `just app-test-changed` — the full derived selection for the phase's diff.

**Checkpoint:**
- [ ] `cd tugdeck && bun test && bunx vite build`
- [ ] `just app-test-changed`

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** Arrow keys traverse every focusable surface in the app — across Lens sections, through the Choose Session sheet, and through empty fields — via one engine-level mechanism, with the prompt editor's history on Cmd-Up/Cmd-Down and a two-press latch protecting its document edges, and the focus-language doctrine updated to match.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] All success criteria in (#success-criteria) verified against the built app.
- [ ] `cd tugdeck && bun test` green; `bunx vite build` clean; `just app-test-changed` green.
- [ ] at0277 and at0282 pass without modification.
- [ ] No `spatialCursor` or `arrowRelease` references remain in `tugdeck/src` or `tuglaws/`.
- [ ] `tuglaws/focus-language.md` documents the universal net, the empty-field arrow rule, the arrow-exit handoff ([P09]), the ring-vs-caret rule ([P11]), the latch, and the history split.
- [ ] The composer's arrow exit lands in the card's cycle at the editor's seat — no arrow press in the composer ends unconsumed, and the editor never wears a ring.
- [ ] The `cycleSpatialOrder` comment in `cards/session-card.tsx` no longer claims the editor is excluded because it keeps its caret arrows.

**Acceptance tests:**
- [ ] `atNNNN-lens-cross-section-arrows`, `atNNNN-picker-arrow-traversal`, `atNNNN-prompt-arrow-latch-history` (numbers assigned at authoring), plus any deliberate revisions to at0248/at0141/at0265.

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] Authored base-mode `SpatialOrder` for the Lens if the wrap-at-extremes feel warrants open edges.
- [ ] Horizontal latch exits from non-empty editors, if ever wanted (deliberately out of scope now).
- [ ] Audit other `historyProvider`-style arrow consumers that may want the latch pattern (none known today beyond the editors).

| Checkpoint | Verification |
|------------|--------------|
| Engine units | `cd tugdeck && bun test` |
| Bundle integrity | `cd tugdeck && bunx vite build` |
| End-to-end traversal | `just app-test-changed` |
| Row-scope invariant | at0277 + at0282 green, unmodified |
