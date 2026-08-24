<!-- tugplan-skeleton v2 -->

## Vocabulary Rename — Pane {#vocabulary-pane-rename}

**Purpose:** Retire "window" as the name for our in-canvas rectangular containers and adopt **Pane**. Tug is a macOS app: a native NSWindow hosts a WKWebView that renders the deck, and the rectangles inside the deck are *not* OS windows. Calling them "windows" conflates our data model with host-level chrome, shadows the `Window` DOM global on the TS side, and makes sentences about the Swift host ambiguous. `TugWindow` → `TugPane`; `windows` → `panes`; `windowId` → `paneId`; `data-window-id` → `data-pane-id`; `.tug-window` → `.tug-pane`; `focus-window` → `focus-pane`. Card vocabulary stays exactly as it is.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-04-21 |
| Predecessor | [tugplan-vocabulary-rename.md](./tugplan-vocabulary-rename.md) (complete — introduced `TugWindow` / `windows` / `windowId`) |
| Related audit | [lifecycle-and-portal-audit.md](./lifecycle-and-portal-audit.md) — "Vocabulary decisions (2026-04-21)" section |

---

### Phase Overview {#phase-overview}

#### Context {#context}

The prior rename plan (`tugplan-vocabulary-rename.md`, closed 2026-04-21) untangled Card / Stack / Tab and landed on Deck → Window → Card. That fix was the right call for the card end of the vocabulary, but the replacement term at the container layer carried a collision we didn't catch until we stepped back:

- **Tug runs in a macOS NSWindow.** One NSWindow installs a WKWebView; the WKWebView hosts the deck; the deck arranges rectangular frames. Those frames are `TugWindow`s. When a Swift author writes "the window," they mean NSWindow. When a TS author writes "the window," they mean TugWindow — or the browser `window` global. Three referents, one word.
- **The DOM has a `window` global.** `TugWindowProps`, `TugWindowPortalContext`, and the `windowId` parameter names sit next to real `window.document`, `window.requestAnimationFrame`, and `window.matchMedia` calls every day. Readability pays the tax.
- **Cross-surface discussion gets muddy.** Docs, tuglaws, and commit messages that cross the Swift / TS boundary have to keep qualifying "Tug window" vs "OS window" — a tell that the noun itself is wrong.

The fix is a replacement word that *never* means OS chrome and *never* shadows the DOM global: **Pane**. It's short, historically unambiguous (tmux panes, split-view panes, editor panes), carries no OS-level baggage, and reads naturally with the existing `Tug` prefix: `TugPane`. The hierarchy becomes **Deck → Pane → Card**, with Tab still meaning the UI affordance on a multi-card pane.

This plan lands the rename across source, DOM, CSS, serialized wire format, Swift IPC, Swift menu text, tuglaws, and the audit document. The card model is untouched; only the outer container changes name.

#### Strategy {#strategy}

- **Phased, one rename-class per commit.** Data model → serialization → store API → registries → contexts → component file → CSS → DOM → action constants → Swift wire → Swift menu text → docs. Every commit green: `bun x tsc --noEmit`, `bun test`, `bun run audit:tokens lint`, `cargo nextest run`.
- **`Tug` prefix for types and components.** `TugPane` the component, `TugPaneState` the type. Matches the house pattern and disambiguates from any generic "pane" that might appear in third-party code.
- **Bump serialized layout version 3 → 4.** On-disk `windows` / `activeWindowId` become `panes` / `activePaneId`. Field rename, no semantic change. v3→v4 migration is trivial; v2→v3 and v1→v2 migration chains stay in place (they can emit v4 directly or chain through v3).
- **Browser `window` global is out of scope.** Any TS expression that uses the `window` DOM global (`window.document`, `window.addEventListener`, `typeof window !== "undefined"`) stays untouched. The rename targets only names we authored.
- **Swift NSWindow is out of scope.** Any Swift reference to `NSWindow`, `window` as `NSWindow`, etc. stays untouched. The rename targets our Tug-specific identifiers.
- **Swift menu follows.** "Add Card to Active Window" → "Add Card to Active Pane." Dynamic label "Close Window" / "Close Card" becomes "Close Pane" / "Close Card" — the "Close Card" branch (multi-card pane, closing one card) is unchanged.
- **Document the decision in the audit doc.** The existing "Vocabulary decisions (2026-04-21)" section gets a short appendix pointing at this plan and recording why `window` was transient.

#### Success Criteria (Measurable) {#success-criteria}

- `rg "TugWindow\b|TugWindowState|TugWindowProps|TugWindowInjectedProps|TugWindowPortalContext" tugdeck/src` returns zero matches.
- `rg "windowId|activeWindowId" tugdeck/src tugapp/Sources` returns zero matches. (Note: plain `window` identifiers — browser DOM global in TS, NSWindow in Swift — remain, and that is correct.)
- `rg "data-window-id|\.tug-window\b|\.tug-window-content\b|\.tug-window-resize-" tugdeck` returns zero matches; `data-pane-id`, `.tug-pane`, `.tug-pane-content`, `.tug-pane-resize-*` exist in their place.
- `rg "addCardToWindow|setActiveCardInWindow|reorderCardInWindow|moveCardToWindow|toggleWindowCollapse|moveWindow\b|handleWindowMoved|handleWindowClosed|_closeWindow" tugdeck/src` returns zero matches.
- `rg "window-content-registry|window-root-registry|tug-window\b|WindowFrameEntry|allWindowFrameRects" tugdeck/src` returns zero matches.
- `rg "ADD_CARD_TO_ACTIVE_WINDOW|add-card-to-active-window|focus-window" tugdeck/src tugapp/Sources` returns zero matches.
- `rg "focusWindowFromMenu|addCardToActiveWindow|Add Card to Active Window|Close Window" tugapp/Sources` returns zero matches.
- `DeckState` serialized with `version: 4` writes a blob with `panes` / `activePaneId`; loading a saved `version: 3` blob migrates to the new shape; `version: 2` and `version: 1` blobs still load.
- Every step commit: `bun x tsc --noEmit` clean, `bun test` green, `bun run audit:tokens lint` zero violations, `cargo nextest run` green.
- Manual: every smoke path from the previous vocabulary plan's success criteria still passes (open card, click-switch tabs, detach, merge, resize, collapse, close pane, reload, Cmd-Tab away / back).

#### Scope {#scope}

1. Data model type + field rename (`TugWindowState` → `TugPaneState`; `DeckState.windows` → `DeckState.panes`; `activeWindowId` → `activePaneId`).
2. Serialization v3 → v4 with in-place migration.
3. Store API method rename (`addCardToWindow` → `addCardToPane` and siblings).
4. Registry file + key rename (`window-content-registry` → `pane-content-registry`; `window-root-registry` → `pane-root-registry`; keys `windowId` → `paneId`).
5. Context rename (`TugWindowPortalContext` → `TugPanePortalContext`; other contexts stay as named).
6. Component file rename (`tug-window.tsx` → `tug-pane.tsx`; `TugWindow` → `TugPane`; props types).
7. CSS file + class rename (`tug-window.css` → `tug-pane.css`; `.tug-window` → `.tug-pane`; `.tug-window-content` → `.tug-pane-content`; `.tug-window-resize-*` → `.tug-pane-resize-*`).
7a. `TugWindowBanner` → `TugPaneBanner` rename (component file, CSS file, 13 selectors, consumers) — surfaced by the Step 7 sweep.
8. DOM attribute rename (`data-window-id` → `data-pane-id`; internal `WindowFrameEntry` → `PaneFrameEntry`; `allWindowFrameRects` → `allPaneFrameRects`).
9. Action constant + wire string rename (`ADD_CARD_TO_ACTIVE_WINDOW` → `ADD_CARD_TO_ACTIVE_PANE`; `"add-card-to-active-window"` → `"add-card-to-active-pane"`).
10. Swift wire contract (`focus-window` with `windowId` → `focus-pane` with `paneId`; Swift method `focusWindowFromMenu` → `focusPaneFromMenu`; `addCardToActiveWindow` → `addCardToActivePane`).
11. Swift menu text ("Add Card to Active Window" → "Add Card to Active Pane"; dynamic "Close Window" branch → "Close Pane"; "Close Card" branch unchanged).
12. Docs + tuglaws + audit update.

#### Non-goals (Explicitly out of scope) {#non-goals}

- **Card vocabulary.** Cards, CardHost, cardId, `data-card-id`, card lifecycle delegates, `tabstate/{id}` tugbank prefix — all unchanged.
- **Browser `window` DOM global.** `window.document`, `window.addEventListener`, `typeof window`, `window.matchMedia`, etc. are untouched; the rename targets only names we authored.
- **Swift NSWindow references.** `NSWindow`, window-level AppKit APIs, any `window` identifier whose type is `NSWindow?` — untouched.
- **Internal decomposition of `TugPane`.** The audit's follow-on "decompose TugWindow into hooks" item (P6 analogue) is still on the roadmap as a separate refactor; it does not ride this rename.
- **Renaming old closed plan documents.** `tugplan-vocabulary-rename.md`, `tugplan-lifecycle-delegates.md`, and any prior roadmap artifact that uses "window" in its historical narrative stays as written. Those docs are history; only *current-state* docs (tuglaws, README-adjacent material) update.
- **Commit message history rewrite.** Past commits that say "window" stay as written.

#### Dependencies / Prerequisites {#dependencies}

- `tugplan-vocabulary-rename.md` closed and landed on main (it is, at commit `c71c6b41` / `28f39c9b` on 2026-04-21).
- Green HEAD on main. All tests passing.
- No in-flight work on `deck-manager.ts`, `deck-canvas.tsx`, `tug-window.tsx`, `card-host.tsx`, the registries, or `serialization.ts`.

#### Constraints {#constraints}

- Warnings-are-errors (`-D warnings`) across Rust. TypeScript strict mode across tugdeck.
- Every commit independently reviewable and green.
- Phased execution — don't stack unrelated renames in one commit.
- Grep hygiene: word-boundaried patterns (`\bwindow`) would catch the DOM global and NSWindow; use prefixed / suffixed forms (`TugWindow`, `windowId`, `data-window-id`, `focus-window`) when sweeping so we don't chase false positives into untouchable territory.

#### Assumptions {#assumptions}

- No external consumer depends on the serialized layout format beyond Swift and tugbank (both in this repo).
- Persisted dev layouts at head are `version: 3` (introduced 2026-04-21); the migration path exercises both v3→v4 and the longer v1→v2→v3→v4 chain via tests.
- The browser `window` global and NSWindow references are findable by grep and can be excluded from sweeps mechanically.

---

### Design Decisions {#design-decisions}

#### [D01] "Pane" is the replacement word (DECIDED) {#d01-pane}

**Decision:** The new word is `Pane`. The component is `TugPane`; the type is `TugPaneState`; the id parameter is `paneId`; the DOM attribute is `data-pane-id`; the CSS class is `.tug-pane`; the wire action is `focus-pane`; the Swift menu word is "Pane."

**Rationale:**
- Never means OS chrome in any dialect. NSWindow is a window; a tmux split is a pane. The asymmetry is load-bearing.
- Short, one-syllable, reads well in compounds (`paneId`, `activePaneId`, `TugPanePortalContext`).
- Has computing precedent (tmux, vim/neovim splits, macOS Finder column-view panes, VS Code editor panes) — readers arrive with the right mental model.
- Rejected alternatives:
  - **Frame** — ambiguous with CSS `frame`, the drag system's rect name, and `StackFrame` which we *just* retired. Too much recent baggage.
  - **Panel** — NSPanel is a real AppKit class for floating utility windows. Collides.
  - **Tile** — evokes tiling window managers, implies grid-snap, which we don't do.
  - **Surface / Region / Board** — too abstract or too generic.
  - **Sheet** — NSView-sheet / modal-sheet collision in macOS.

**Implications:** The DOM global `window` and Swift NSWindow keep their names. Our authored identifiers carry `pane`. Any doc that has to talk about both layers together says "pane (inside a host window)" or "the OS window vs. the pane."

#### [D02] Serialized layout bumps to `version: 4` (DECIDED) {#d02-v4}

**Decision:** `serialize()` emits `version: 4` with fields `panes` and `activePaneId`. `deserialize()` dispatches:
- `version === 4` → `parseV4` (direct read).
- `version === 3` → `migrateV3ToV4` (field rename) → parseV4 shape.
- `version === 2` → `migrateV2ToV3` → `migrateV3ToV4` → parseV4 shape (or the `migrateV2ToV3` can be short-circuited to emit v4 field names directly — implementer's choice, guided by test clarity).
- v1 legacy path chains through as today.

**Rationale:**
- On-disk field names matching in-memory field names is the only regime that stays coherent.
- A version bump is visible in tests and forces reviewers to notice the break.
- v3 was introduced 2026-04-21 and may exist in dev tugbanks; a documented migration is safer than silently reinterpreting the same version number.

**Implications:** `serialization.ts` grows a `parseV4` + `migrateV3ToV4`. The v3 parse path is retired (no more `parseV3` — replaced by the migration). Round-trip tests cover v4→v4 and v3→v4.

#### [D03] Swift menu "Close Window" branch becomes "Close Pane" (DECIDED) {#d03-close-pane}

**Decision:** The dynamic menu label logic stays the same shape, but the single-card branch now reads "Close Pane" instead of "Close Window."
```swift
closeMenuItem?.title = cardCount > 1 ? "Close Card" : "Close Pane"
```

**Rationale:**
- The whole point of this rename is that users and developers should never see "window" when they mean our in-canvas container.
- "Close Card" (the multi-card branch) already tells the truth — closing one card of several leaves the pane open. That branch stays.
- Safari/Finder precedent (Close Tab / Close Window) no longer applies cleanly once "window" means the OS chrome; "Close Pane" is the honest replacement.

**Implications:** The menu's initial title (set at construction) also becomes "Close Pane." Keybindings unchanged.

#### [D04] Browser `window` DOM global is untouched (DECIDED) {#d04-dom-global-untouched}

**Decision:** Any TS expression that references the browser `window` object — `window.document`, `window.addEventListener`, `typeof window`, `window.requestAnimationFrame`, `window.matchMedia`, property accesses on `globalThis`-style casts — is out of scope. Grep patterns for the rename are prefixed (`TugWindow`, `windowId`, `data-window-id`, `focus-window`, etc.) to avoid matching the global.

**Rationale:**
- `window` as a DOM global is a web platform name we don't own. Renaming it is impossible; grepping around it is easy if patterns are chosen well.
- Every remaining `window.*` reference in the tree post-rename is, by construction, a reference to the DOM global.

**Implications:** Reviewers looking at a rename diff can spot any lingering `window` token and immediately know it's either the DOM global (TS) or NSWindow (Swift). Neither is a bug.

#### [D05] Card vocabulary is frozen (DECIDED) {#d05-card-frozen}

**Decision:** Cards, CardHost, cardId, `data-card-id`, `card-host.tsx`, tugbank `tabstate/{id}` prefix, lifecycle delegates — all unchanged. This plan is a surgical rename of the container layer only.

**Rationale:**
- The card model was just stabilized; changing it again churns reviewers and tests for no vocabulary win.
- The tension the prior plan solved was Card / Stack / Tab conflation. That tension is resolved. The new tension — Window / OS-window — lives entirely at the container layer.

**Implications:** The plan's grep sweeps and exit criteria are scoped to the `Window` family of names; anything with `Card` in it is off-limits and stays put.

---

### Risks and Mitigations {#risks}

**Risk R01: Grep sweeps chase the DOM global** {#r01-dom-global-grep}

- **Risk:** A lazy grep for `window` would match every `window.document` / `window.addEventListener` in the tree and every NSWindow in Swift. A reviewer could spend an hour false-positive chasing.
- **Mitigation:** Every grep in this plan is prefixed (`TugWindow`, `windowId`, `data-window-id`, `focus-window`, `.tug-window`, `tug-window\.tsx`, `window-content-registry`, `window-root-registry`). The integration checkpoint (#step-13) lists the exact patterns.
- **Residual risk:** Zero, if the patterns are used as written. Near zero in practice — any `\bwindow\b` match that survives the rename is either the DOM global or NSWindow.

**Risk R02: v3→v4 migration loses a field** {#r02-migration-drop}

- **Risk:** The migration is a field rename, but a typo could drop `activePaneId` or `collapsed` silently.
- **Mitigation:** Round-trip tests: hand-authored v3 blob → deserialize → expected v4 shape; v4 → deserialize → serialize → identical. Ship both in #step-2. Keep the v2 and v1 tests as written; they now chain through v4 at the tail.
- **Residual risk:** Very low.

**Risk R03: Swift / TS wire contract mismatch** {#r03-swift-mismatch}

- **Risk:** Swift sends `focus-window` with `windowId` after TS has renamed to `focus-pane` with `paneId`, or vice versa. Handler warns, user sees a silent no-op on View-menu activation.
- **Mitigation:** Rename both sides atomically in #step-10. Manual smoke: launch Tug.app, pick a pane from the View menu, verify activation.
- **Residual risk:** Zero after #step-10 checkpoint passes (wire + payload key match on both sides).

**Risk R04: Drag coordinator selector drift** {#r04-selector-drift}

- **Risk:** `card-drag-coordinator.ts` queries `.tug-pane[data-pane-id]` (after Steps 7–8). The rename touches both the class and the attribute. Miss either, drag silently breaks.
- **Mitigation:** Pair the class rename (#step-7), the DOM attribute rename (#step-8), and the coordinator selector/field rename (#step-8) in adjacent commits; add a checkpoint smoke (drag-to-merge) after #step-8.
- **Residual risk:** Zero after checkpoint passes.

**Risk R05: CSS file import churn** {#r05-css-import}

- **Risk:** `tug-window.css` → `tug-pane.css` means every import of the old filename breaks. If any side-effect-only `import './tug-window.css'` exists and is missed, styles silently drop.
- **Mitigation:** `rg "tug-window\\.css|tug-window'" tugdeck` before and after #step-7; grep exit must be zero afterward.
- **Residual risk:** Zero with grep enforcement.

---

### Execution Steps {#execution-steps}

#### Step 1: Data model type + field rename {#step-1}

**Commit:** `Rename TugWindowState → TugPaneState and DeckState.windows → DeckState.panes`

**References:** [D01] Pane, (#context, #strategy)

**Artifacts:**
- `tugdeck/src/layout-tree.ts` — type rename, field rename, `validateDeckState` error messages updated.
- Consumers across `tugdeck/src/**/*.ts` — type imports, field accesses.
- Tests — mechanical find/replace.

**Tasks:**
- [x] Rename type `TugWindowState` → `TugPaneState` in `layout-tree.ts`.
- [x] Rename `DeckState.windows` → `DeckState.panes`.
- [x] Rename `DeckState.activeWindowId` → `DeckState.activePaneId`.
- [x] Update local variable conventions: `win` / `pane`-ish local names normalize to `pane`.
- [x] Update `validateDeckState` error message strings to say "pane" / "panes."
- [x] Method names keep their existing form (`addCardToWindow`, etc.) — renamed in #step-3.
- [x] Internal variables named `windowId` keep their form for now — renamed in later steps as they propagate.

**Tests:**
- [x] Existing `layout-tree.test.ts` passes with the renamed types.
- [x] `deck-manager.test.ts` passes.

**Checkpoint:**
- [x] `bun x tsc --noEmit` clean.
- [x] `bun test` green at existing count.
- [x] `rg "TugWindowState" tugdeck/src` returns zero matches.

---

#### Step 2: Serialization v3 → v4 with migration {#step-2}

**Depends on:** #step-1

**Commit:** `Emit serialized layout as version 4 with in-place v3→v4 migration`

**References:** [D02] v4 bump, Risk R02

**Artifacts:**
- `tugdeck/src/serialization.ts` — `serialize` emits `version: 4` with `panes` field; `parseV4` replaces `parseV3`; `migrateV3ToV4` replaces the v3-shape parse branch.
- Tests — new round-trip asserting v3 blobs load, v4 blobs round-trip, v2 and v1 chain through.

**Tasks:**
- [x] Rename `parseV3` → `parseV4` and update the serialized field names read (`panes`, `activePaneId`).
- [x] Add `migrateV3ToV4` that converts on-wire `windows` → `panes` and `activeWindowId` → `activePaneId`.
- [x] `serialize()` emits `version: 4`.
- [x] `deserialize()` dispatch: `version === 4` → `parseV4`; `version === 3` → `migrateV3ToV4` → parseV4 shape; `version === 2` → `migrateV2ToV4` (v2 wire → v3 field names → `migrateV3ToV4` → `parseV4`); v1 chains through as today.
- [x] Update JSDoc on any residue reference to historical `windows` / `activeWindowId` on-wire shapes to read: "pre-v4 on-disk shape; migrated on load."

**Tests:**
- [x] Round-trip: v4 blob → deserialize → serialize → identical shape.
- [x] Migration: hand-authored v3 blob → deserialize → expected v4 DeckState (new field names, everything else preserved).
- [x] Existing v2 migration test still passes (chains through v4).
- [x] Existing v1 migration test still passes.

**Checkpoint:**
- [x] `bun x tsc --noEmit` clean.
- [x] `bun test` green (existing + 2 new).
- [x] `rg "parseV3|version === 3" tugdeck/src` returns only the migration-dispatch branch (not a parse branch).

---

#### Step 3: Store API method rename {#step-3}

**Depends on:** #step-2

**Commit:** `Rename store API: addCardToWindow → addCardToPane (and siblings)`

**References:** [D01] Pane, (#context)

**Artifacts:**
- `tugdeck/src/deck-manager.ts` — public method + parameter renames.
- `tugdeck/src/deck-manager-store.ts` — `IDeckManagerStore` interface.
- `tugdeck/src/__tests__/mock-deck-manager-store.ts` — matching rename.
- Every consumer: `deck-canvas.tsx`, `card-drag-coordinator.ts`, `action-dispatch.ts`, `tug-window.tsx` (will become `tug-pane.tsx` in #step-6), `card-host.tsx`, tests.

**Rename table:**

| Today | New |
|---|---|
| `_addCardToWindow(windowId, componentId)` | `_addCardToPane(paneId, componentId)` |
| `_setActiveCardInWindow(windowId, cardId)` | `_setActiveCardInPane(paneId, cardId)` |
| `_reorderCardInWindow(windowId, from, to)` | `_reorderCardInPane(paneId, from, to)` |
| `_detachCard(windowId, cardId, position)` | `_detachCard(paneId, cardId, position)` (parameter rename only) |
| `_moveCardToWindow(srcId, cardId, tgtId, idx)` | `_moveCardToPane(srcId, cardId, tgtId, idx)` |
| `_toggleWindowCollapse(windowId)` | `_togglePaneCollapse(paneId)` |
| `_closeWindow(windowId)` | `_closePane(paneId)` |
| `moveWindow(windowId, pos, size)` | `movePane(paneId, pos, size)` |
| `handleWindowMoved(...)` | `handlePaneMoved(...)` |
| `handleWindowClosed(...)` | `handlePaneClosed(...)` |
| `addCard(componentId)` | unchanged |
| `getFirstResponderCardId()` | unchanged |

**Tasks:**
- [x] Rename every method in the table across `deck-manager.ts`, the interface, and the mock.
- [x] Rename parameter names `windowId` → `paneId` on all renamed methods.
- [x] Update every call site.
- [x] Update JSDoc to refer to panes/cards.

**Tests:**
- [x] Every existing `deck-manager.test.ts`, `deck-canvas.test.tsx`, `card-drag-coordinator.test.ts`, `card-header.test.tsx`, and `e2e-responder-chain.test.tsx` test passes under the new names.

**Checkpoint:**
- [x] `bun x tsc --noEmit` clean.
- [x] `bun test` green.
- [x] `rg "addCardToWindow|setActiveCardInWindow|reorderCardInWindow|toggleWindowCollapse|moveWindow\b|handleWindowMoved|handleWindowClosed|_closeWindow|moveCardToWindow" tugdeck/src` returns zero matches.

---

#### Step 4: Registry files + key rename {#step-4}

**Depends on:** #step-3

**Commit:** `Rename window-content-registry → pane-content-registry (and window-root-registry → pane-root-registry)`

**References:** [D01] Pane

**Artifacts:**
- File rename: `tugdeck/src/components/chrome/window-content-registry.ts` → `pane-content-registry.ts`.
- File rename: `tugdeck/src/components/chrome/window-root-registry.ts` → `pane-root-registry.ts`.
- Consumers: `card-portal.tsx`, `card-host.tsx`, `tug-window.tsx` (still named thus until #step-6), tests.

**Tasks:**
- [x] Rename both files.
- [x] Rename keys: every `windowId` parameter in `register`/`unregister`/`getElement`/`subscribe` → `paneId`.
- [x] Update JSDoc to reference panes, not windows.
- [x] Update every import.

**Tests:**
- [x] `window-content-registry.test.ts` renamed to `pane-content-registry.test.ts`; tests pass.
- [x] `card-portal.test.tsx` passes.

**Checkpoint:**
- [x] `bun x tsc --noEmit` clean.
- [x] `bun test` green.
- [x] `rg "window-content-registry|window-root-registry" tugdeck/src` returns zero matches.

---

#### Step 5: Context rename {#step-5}

**Depends on:** #step-4

**Commit:** `Rename TugWindowPortalContext → TugPanePortalContext`

**References:** [D01] Pane

**Artifacts:**
- `tugdeck/src/components/chrome/tug-window.tsx` — context export renamed (file rename happens in #step-6).
- Consumers updated.

**Rename table:**

| Today | New |
|---|---|
| `TugWindowPortalContext` | `TugPanePortalContext` |
| `CardDirtyContext` | unchanged |
| `CardPropertyContext` | unchanged |
| `CardPersistenceContext` | unchanged |

**Tasks:**
- [x] Rename the portal context export at its definition site.
- [x] Update every consumer import and Provider usage.
- [x] Update JSDoc: `TugPanePortalContext` provides the pane's root element (used by sheet/tooltip portals that need to attach inside the pane's frame).

**Tests:**
- [x] Every existing test that mounts a card body (tide, gallery, etc.) continues to pass.

**Checkpoint:**
- [x] `bun x tsc --noEmit` clean.
- [x] `bun test` green.
- [x] `rg "TugWindowPortalContext" tugdeck/src` returns zero matches.

---

#### Step 6: Component file rename: `TugWindow` → `TugPane` {#step-6}

**Depends on:** #step-5

**Commit:** `Rename TugWindow → TugPane (file, exports, props)`

**References:** [D01] Pane

**Artifacts:**
- File rename: `tugdeck/src/components/chrome/tug-window.tsx` → `tug-pane.tsx`.
- Component export: `TugWindow` → `TugPane`.
- Props type: `TugWindowProps` → `TugPaneProps`; `TugWindowInjectedProps` → `TugPaneInjectedProps` (if still exported; if dead, delete).
- Consumers: `deck-canvas.tsx` and any test.

**Tasks:**
- [x] Rename the file.
- [x] Rename `TugWindow` → `TugPane` at the export.
- [x] Rename prop types accordingly.
- [x] Update every import and JSX usage (`<TugWindow …>` → `<TugPane …>`).
- [x] Keep CSS class names and DOM attributes as they are for now — those land in #step-7 and #step-8.

**Tests:**
- [x] `tug-window.test.tsx` renamed to `tug-pane.test.tsx`; tests pass.
- [x] `deck-canvas.test.tsx` passes.

**Checkpoint:**
- [x] `bun x tsc --noEmit` clean.
- [x] `bun test` green.
- [x] `rg "TugWindow\b|tug-window\.tsx|tug-window'" tugdeck/src` returns zero matches.

---

#### Step 7: CSS file + class rename {#step-7}

**Depends on:** #step-6

**Commit:** `Rename tug-window.css → tug-pane.css and .tug-window* classes → .tug-pane*`

**References:** [D01] Pane, Risk R05

**Artifacts:**
- File rename: `tugdeck/styles/tug-window.css` → `tug-pane.css` (path adjusted to wherever it actually lives — likely `tugdeck/src/components/chrome/tug-window.css` alongside the TSX).
- CSS selectors: `.tug-window`, `.tug-window-content`, `.tug-window-resize-*` → `.tug-pane`, `.tug-pane-content`, `.tug-pane-resize-*`.
- JSX className usages in `tug-pane.tsx` and anywhere else that references the classes.
- Any side-effect-only CSS import (`import './tug-window.css'`) updated.

**Tasks:**
- [x] File rename.
- [x] Selector rename in the CSS file.
- [x] `className="tug-window"` → `className="tug-pane"` and children.
- [x] `className="tug-window-content"` → `className="tug-pane-content"`.
- [x] Resize handle classes `.tug-window-resize-n` / `-s` / `-e` / `-w` / `-nw` / `-ne` / `-sw` / `-se` → `.tug-pane-resize-*` equivalents.
- [x] Update any `@import` or side-effect import of the CSS.
- [x] Update `tug-window.css` reference in tuglaws/selection-model.md (§Files table line 196) to `tug-pane.css`.

**Tests:**
- [x] Visual regression: start HMR, open a pane, confirm it renders (title bar, content, resize affordances, drop shadow). HMR is always running.
- [x] Every existing render test that snapshots class names is updated.

**Checkpoint:**
- [x] `bun x tsc --noEmit` clean.
- [x] `bun test` green.
- [x] `rg "tug-window\\.css|\\.tug-window\\b|\\.tug-window-content\\b|\\.tug-window-resize-" tugdeck` returns zero matches.
- [x] **Open residue flagged:** `TugWindowBanner` (component, CSS, tests) still carries the old word. The Step 7 grep `\.tug-window\b` false-positives on `.tug-window-banner*` because ripgrep treats `-` as a word boundary. Scope-called-out and moved to #step-7a.

---

#### Step 7a: Rename TugWindowBanner → TugPaneBanner {#step-7a}

**Depends on:** #step-7

**Commit:** `Rename TugWindowBanner → TugPaneBanner (file, exports, CSS, consumers)`

**References:** [D01] Pane, (#context — no internal identifier uses "window" except DOM global / NSWindow)

**Rationale:** Surfaced by the Step 7 CSS sweep. `TugWindowBanner` is a card-scoped notification strip that lives *inside* a pane. It is not part of the pane frame itself, so it was not in Step 7's declared scope, but its name still uses "window" in a Tug-authored identifier — which the plan's exit criteria forbid. The rename here closes that straggler before Step 8 touches DOM attributes.

**Artifacts:**
- File rename: `tugdeck/src/components/tugways/tug-window-banner.tsx` → `tug-pane-banner.tsx`.
- File rename: `tugdeck/src/components/tugways/tug-window-banner.css` → `tug-pane-banner.css`.
- File rename: `tugdeck/src/__tests__/tug-window-banner.test.tsx` → `tug-pane-banner.test.tsx`.
- Component export: `TugWindowBanner` → `TugPaneBanner`; props type `TugWindowBannerProps` → `TugPaneBannerProps`.
- CSS selectors (13 classes): `.tug-window-banner`, `.tug-window-banner-strip`, `.tug-window-banner-clip`, `.tug-window-banner-icon`, `.tug-window-banner-label`, `.tug-window-banner-message`, `.tug-window-banner-detail-panel`, `.tug-window-banner-detail-body`, `.tug-window-banner-detail-icon`, `.tug-window-banner-detail-text`, `.tug-window-banner-detail-title`, `.tug-window-banner-detail-message`, `.tug-window-banner-detail-actions` → `.tug-pane-banner-*` equivalents.
- DOM slot: `data-slot="tug-window-banner"` → `data-slot="tug-pane-banner"`.
- Consumers: `tide-card.tsx` (import + JSX), `gallery-card-banner.tsx` (import + JSDoc + 4 JSX sites), `gallery-registrations.tsx` (registered-card title string), `__tests__/tide-card-last-error.test.tsx` (imports + `data-slot` selector + describe label).

**No token churn.** The CSS custom properties on these selectors are named `--tugx-card-banner-*` — they don't contain the word "window," so the theme files don't need edits.

**Tasks:**
- [x] Rename three files (`.tsx`, `.css`, `.test.tsx`) — use `git mv` so history tracks.
- [x] Rename component + props export at its definition site.
- [x] Rename every CSS selector in the CSS file.
- [x] Rename every JSX `className` and `data-slot` reference in the component.
- [x] Rename the CSS side-effect import inside the component (`./tug-window-banner.css` → `./tug-pane-banner.css`).
- [x] Update every consumer import + JSX usage.
- [x] Update `gallery-registrations.tsx` registered-card `defaultMeta.title` if it reads "TugWindowBanner."
- [x] Update tuglaws and any doc references (`rg "TugWindowBanner|tug-window-banner" tuglaws tugdeck/docs` should return zero).

**Tests:**
- [x] `tug-pane-banner.test.tsx` passes (describe labels + imports updated; `[data-slot]` selector updated).
- [x] `tide-card-last-error.test.tsx` passes (locator uses new `data-slot`).
- [x] Gallery tab smoke: open the gallery card, pick the `TugPaneBanner` demo — error / status / contained variants all render.

**Checkpoint:**
- [x] `bun x tsc --noEmit` clean.
- [x] `bun test` green (count unchanged).
- [x] `bun run audit:tokens lint` zero violations.
- [x] `rg "TugWindowBanner|tug-window-banner|\\.tug-window-banner" tugdeck tuglaws` returns zero matches.
- [x] Plan-wide grep `rg "\\.tug-window\\b" tugdeck` now returns zero matches (no banner false-positives).

---

#### Step 8: DOM attribute rename + drag-coordinator internals {#step-8}

**Depends on:** #step-7

**Commit:** `Rename data-window-id → data-pane-id and align drag coordinator`

**References:** [D01] Pane, Risk R04

**Artifacts:**
- `tug-pane.tsx` — `data-window-id={id}` on the outer frame → `data-pane-id={id}`. Tab-bar `data-window-id` (if present) → `data-pane-id`. `data-testid="tug-window"` → `data-testid="tug-pane"`.
- `card-drag-coordinator.ts` — selectors `.tug-window[data-window-id]` → `.tug-pane[data-pane-id]`; internal type `WindowFrameEntry` → `PaneFrameEntry`; field `allWindowFrameRects` → `allPaneFrameRects`; every internal variable / parameter named `windowId` → `paneId`.
- Tests — any `screen.getByTestId` / `getAttribute` that references the old names.

**Tasks:**
- [x] Rename `data-window-id` → `data-pane-id` on every emitting site.
- [x] Rename `data-testid="tug-window"` → `data-testid="tug-pane"`.
- [x] Update `card-drag-coordinator` selectors, types, and fields.
- [x] Update every test that reads these attributes.
- [x] Update tuglaws/selection-model.md §Files (line 198) — `tug-window.tsx` → `tug-pane.tsx`. (Already `tug-pane.tsx`; no edit required.)

**Tests:**
- [x] Drag tests in `tug-pane.test.tsx` pass.
- [x] Merge tests in `card-drag-coordinator.test.ts` pass. (No `card-drag-coordinator.test.ts` in tree — N/A.)
- [x] Identity preservation tests pass.

**Checkpoint:**
- [x] `bun x tsc --noEmit` clean.
- [x] `bun test` green.
- [x] `rg "data-window-id|WindowFrameEntry|allWindowFrameRects" tugdeck/src` returns zero matches.
- [ ] Manual smoke: drag a card tab onto another pane's tab bar → merges. Drag a pane frame → position commits.

---

#### Step 9: Action constant + wire string rename {#step-9}

**Depends on:** #step-8

**Commit:** `Rename ADD_CARD_TO_ACTIVE_WINDOW → ADD_CARD_TO_ACTIVE_PANE`

**References:** (#context, #strategy)

**Artifacts:**
- `tugdeck/src/components/tugways/action-vocabulary.ts` — constant rename + wire string.
- `tugdeck/src/action-dispatch.ts` — handler registration uses new constant name.
- `tugdeck/src/components/chrome/deck-canvas.tsx` — TUG_ACTIONS usage.
- `tugapp/Sources/AppDelegate.swift` — `sendControl("add-card-to-active-window")` → `sendControl("add-card-to-active-pane")`.
- Tests — any test that references the old constant name or wire string.

**Tasks:**
- [x] Rename `ADD_CARD_TO_ACTIVE_WINDOW` → `ADD_CARD_TO_ACTIVE_PANE`.
- [x] Wire string: `"add-card-to-active-window"` → `"add-card-to-active-pane"` on both sides.
- [x] Update tests.
- [x] Update tuglaws/action-naming.md to reflect new vocabulary. (`tuglaws/responder-chain.md` wire string updated in the same sweep.)

**Checkpoint:**
- [x] `bun x tsc --noEmit` clean.
- [x] `bun test` green.
- [x] `cargo nextest run` green.
- [x] `rg "add-card-to-active-window|ADD_CARD_TO_ACTIVE_WINDOW" tugdeck/src tugapp/Sources` returns zero matches.

---

#### Step 10: Swift wire `focus-window` → `focus-pane` (and Swift method renames) {#step-10}

**Depends on:** #step-9

**Commit:** `Rename focus-window wire → focus-pane with paneId (and Swift addCardToActiveWindow → addCardToActivePane, focusWindowFromMenu → focusPaneFromMenu)`

**References:** Risk R03

**Artifacts:**
- `tugdeck/src/action-dispatch.ts` — rename `registerAction("focus-window", …)` → `registerAction("focus-pane", …)`. Payload field `windowId` → `paneId`.
- `tugapp/Sources/AppDelegate.swift` — `sendControl("focus-window", ["windowId": id])` → `sendControl("focus-pane", ["paneId": id])`. Rename `focusWindowFromMenu` → `focusPaneFromMenu`. Rename `addCardToActiveWindow` → `addCardToActivePane`. Any View-menu binding follows.

**Tasks:**
- [x] TS handler renamed; payload read updated.
- [x] Swift send-site renamed; payload key updated.
- [x] Swift method names renamed; Selector strings for menu targets updated.
- [x] If the Swift-side cached "card list" payload carries a `focused` bool keyed by pane id, no change to the JSON key (it stays `id` or whatever it currently is); confirm by reading the current code. (`pushCardListToHost` / `DeckManager` still emit `{ id, title, focused, cardCount }` per pane.)

**Checkpoint:**
- [x] `bun x tsc --noEmit` clean.
- [x] `bun test` green.
- [x] Tug.app builds.
- [ ] Manual smoke: launch Tug.app, open View menu, pick a pane → target pane activates, tide prompt regains focus.
- [x] `rg "focus-window|focusWindowFromMenu|addCardToActiveWindow" tugdeck/src tugapp/Sources` returns zero matches.

---

#### Step 11: Swift menu text rename {#step-11}

**Depends on:** #step-10

**Commit:** `Rename Swift menu text: Add Card to Active Pane, Close Pane`

**References:** [D03] Close Pane

**Artifacts:**
- `tugapp/Sources/AppDelegate.swift` — menu item titles and the dynamic-label logic in `updateCardList`.
- (No separate `MainMenu.swift`; main menus are built in `AppDelegate.setupMainMenu()`.)

**Tasks:**
- [x] "Add Card to Active Window" → "Add Card to Active Pane."
- [x] Initial close-menu title "Close Window" → "Close Pane."
- [x] Dynamic label:
  ```swift
  closeMenuItem?.title = cardCount > 1 ? "Close Card" : "Close Pane"
  ```
- [x] Keybindings unchanged.

**Checkpoint:**
- [x] Tug.app builds and runs.
- [ ] Manual smoke:
  - [ ] Developer menu shows "Add Card to Active Pane"; selecting it adds a card.
  - [ ] With a single-card pane focused: File menu close title is "Close Pane"; ⌘W closes the pane.
  - [ ] With a multi-card pane focused: File menu close title is "Close Card"; ⌘W closes the active card only.
- [x] `rg "Add Card to Active Window|Close Window" tugapp/Sources` returns zero matches.

---

#### Step 12: Docs + tuglaws + audit update {#step-12}

**Depends on:** #step-11

**Commit:** `Update tuglaws and audit doc with pane vocabulary`

**References:** [D01]–[D05]

**Artifacts:**
- `tuglaws/selection-model.md` — `tug-window.css` → `tug-pane.css`, `tug-window.tsx` → `tug-pane.tsx`, `.tug-window-content` → `.tug-pane-content`.
- `tuglaws/responder-chain.md` — any `TugWindow` / `windowId` references → `TugPane` / `paneId`.
- `tuglaws/action-naming.md` — `ADD_CARD_TO_ACTIVE_WINDOW` → `ADD_CARD_TO_ACTIVE_PANE`, `focus-window` → `focus-pane`.
- `tugdeck/docs/pairing-audit-results.md` — any `TugWindow` or `window`-as-Tug-container references updated (historical narrative in `dash/` stays as written).
- `tugdeck/docs/renders-on-survey.md` — same treatment.
- `dash/lifecycle-and-portal-audit.md` — appendix to the existing "Vocabulary decisions (2026-04-21)" section: short note "Subsequent correction: `TugWindow` → `TugPane` — see `tugplan-vocabulary-pane-rename.md`. Rationale: conflict with NSWindow." No rewrite of the historical section.
- `dash/lifecycle-and-portal-audit.md` — **coherence fix under §Vocabulary decisions**: the "Also in that plan (cross-references for readers of this audit)" bullet was partially edited during #step-9 (only `ADD_CARD_TO_ACTIVE_WINDOW` → `ADD_CARD_TO_ACTIVE_PANE` was swapped). The bullet describes what the prior `tugplan-vocabulary-rename.md` delivered; the one-item edit leaves four "window-era" items (`windows / activeWindowId`, `*Window mutators`, `focus-window + windowId`, menu text) alongside one "pane-era" item — internally incoherent. Fix: revert that one item to `ADD_CARD_TO_ACTIVE_WINDOW` so the bullet accurately records the prior plan's deliverables, then the pane-correction appendix (above) supersedes them in one coherent block.

**Tasks:**
- [x] Grep each tuglaws file for `TugWindow`, `windowId`, `data-window-id`, `tug-window`, `.tug-window`, `focus-window`; replace with pane equivalents. (`selection-model.md` §Files already referenced `tug-pane.css` / `tug-pane.tsx`; `responder-chain.md`, `tuglaws.md`, `framework-architecture.md`, `action-naming.md`, and `tugdeck/docs/pairing-audit-results.md` updated.)
- [x] Audit doc appendix added. (`lifecycle-and-portal-audit.md` — **Subsequent correction: pane vocabulary**; cross-reference bullet restored to full **window**-plan deliverables for coherence.)
- [x] `rg "TugWindow|windowId|data-window-id|tug-window|\\.tug-window|focus-window" tuglaws tugdeck/docs` returns zero matches (excluding historical notes the task deliberately preserves — identify and annotate if any).

**Checkpoint:**
- [x] Tuglaws docs read coherently end-to-end.
- [x] Audit doc's vocabulary section now tells the full story (window-was-interim, pane-is-final).

---

#### Step 13: Integration checkpoint {#step-13}

**Depends on:** #step-1 through #step-12

**Commit:** `N/A (verification only)`

**References:** (#success-criteria)

**Tasks:**
- [ ] Verify every success criterion passes.
- [ ] Manual full smoke: open tide, add card, click-switch, detach, merge, resize, collapse, close, Cmd-Tab away / back, Cmd-H / unhide, reload.

**Checkpoint:**
- [ ] `bun run check` clean.
- [ ] `bun test` green.
- [ ] `bun run audit:tokens lint` zero violations.
- [ ] `cargo nextest run` green.
- [ ] Grep sweep (paste-ready):
  ```
  rg "TugWindow[A-Z]?\w*|windowId|activeWindowId|data-window-id|\.tug-window\b|\.tug-window-banner|\.tug-window-content\b|\.tug-window-resize-|tug-window[-.]|window-content-registry|window-root-registry|WindowFrameEntry|allWindowFrameRects|addCardToWindow|setActiveCardInWindow|reorderCardInWindow|moveCardToWindow|toggleWindowCollapse|moveWindow\b|handleWindowMoved|handleWindowClosed|_closeWindow|ADD_CARD_TO_ACTIVE_WINDOW|add-card-to-active-window|focus-window|focusWindowFromMenu|addCardToActiveWindow|Add Card to Active Window|Close Window" tugdeck/src tugapp/Sources tugdeck/styles tuglaws tugdeck/docs
  ```
  Expected: zero matches. (`TugWindow[A-Z]?\w*` catches `TugWindow`, `TugWindowBanner`, `TugWindowBannerProps`, etc. — one pattern, no false negatives from the old `\b`-terminated form.)
- [ ] Bare-`window` grep sanity (reviewer-only, should show only DOM globals in TS and NSWindow in Swift):
  ```
  rg "\bwindow\b" tugdeck/src tugapp/Sources
  ```
  Expected: every match is either the browser DOM global or NSWindow. No match is a Tug-authored identifier.

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** Source, DOM, CSS, serialized wire format, IPC wire contract, Swift method names, Swift menu text, and tuglaws all use `Pane` for the in-canvas rectangular container. The Tug vocabulary no longer overloads the OS `window` word; `NSWindow` (Swift) and the browser `window` DOM global (TS) remain in their rightful places, and every Tug-authored identifier uses `Pane`.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] All 12 rename steps committed; integration checkpoint (#step-13) passes.
- [ ] Prefixed grep sweep from #step-13 shows zero old-vocabulary matches in the scoped directories.
- [ ] Bare-`window` grep shows only DOM globals and NSWindow — no Tug-authored identifiers.
- [ ] Manual smoke matrix from the prior vocabulary plan still passes under the new vocabulary.
- [x] `lifecycle-and-portal-audit.md` vocabulary section updated to record the pane correction.
- [x] Tuglaws (`selection-model.md`, `responder-chain.md`, `action-naming.md`) updated.

**Acceptance tests:**
- [ ] Existing test suite green at HEAD.
- [ ] v3 → v4 migration round-trip test passes.
- [ ] v2 → v4 chained migration round-trip test passes.
- [ ] Identity preservation under drag / detach / merge / close / reload — unchanged from before the rename.

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] Internal decomposition of `TugPane` into hooks (`usePaneDrag`, `usePaneResize`, `usePaneTabBar`) — see audit P6 analogue. Still separate refactor.
- [ ] Tugbank row prefix `tabstate/` → `cardstate/` if / when a user-facing reason surfaces. Still out of scope.
- [ ] Author a `tuglaws/pane-model.md` or equivalent — formalizing the Deck → Pane → Card hierarchy as a law rather than as a rename artifact.

---

### Open Questions {#open-questions}

*(All plan-authoring open questions resolved. Decisions recorded as [D01]–[D05].)*
