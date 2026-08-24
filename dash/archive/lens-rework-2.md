## Lens Rework 2 — three focus-navigable list views {#phase-slug}

**Purpose:** Rebuild the Lens as a keyboard-first rail of exactly three sections — Sessions, Snippets, Text Files — each a `TugListView` wired into the focus language, so Cmd-L lands the keyboard cursor on a real item, Tab jumps between sections, and one uniform grammar (arrows rove, Enter acts, Escape ascends) governs the whole rail. Log and Telemetry leave the Lens and rehome in a resurrected DevTools card.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | `tugdash/snippets` (dash worktree; joins to `main` on the user's `tugutil dash join`) |
| Last updated | 2026-07-18 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

The Lens (an anchored rail pane hosting the registered `"lens"` card) today stacks four sections — Sessions, Log, Telemetry, Snippets — but none of them participates in the focus language. Cmd-L (`FOCUS_LENS`) activates the Lens card and lands DOM focus on the `.lens-content` `tabIndex={-1}` sink; the per-section focus groups (`sectionFocusGroup(kind)` → `lens-section-<kind>`) are *ordered* by `LensContent`'s `setGroupOrder` call but *empty* — no section registers a focusable. The result: no visible keyboard cursor, arrows do nothing, and the Snippets section built in the snippets-bringup phase only responds when its hand-rolled `TugQuickList` container happens to hold raw DOM focus. The user has asked for a real keyboard-focusable Lens repeatedly; this phase delivers it.

The design was discussed and settled with the user (2026-07-18): the Lens becomes three sections only — **Sessions**, **Snippets**, **Text Files** — each rendered by `TugListView` (the sanctioned item-group + cursor primitive per `tuglaws/focus-language.md`), one per collapsible band, with Tab moving between them. The uniform focus-language grammar is accepted (Space-to-add from the Things-3 model is retired in favor of Enter-opens / Escape-ascends / ⌘Return-chains). Text Files lists open Text cards **plus** the recently-open MRU. Log and Telemetry leave the Lens; because the old TugDevPanel overlay was retired when the Lens absorbed them (they are currently the *only* UI over `tugDevLogStore` and the telemetry projection), the plan resurrects a singleton **DevTools card** hosting the existing inspectors, opened by Opt-Cmd-/.

#### Strategy {#strategy}

- Ship the smallest additive primitive changes first (`TugListView.descendIntoRow`, a subscribe seam on `recent-documents.ts`, `editingId` in `snippetsStore`), each independently testable.
- Convert **Sessions** first — it is the smallest section — to prove the whole wiring: list registration into `lens-section-sessions`, the Cmd-L seed, Tab arrival, Enter activation.
- Rebuild **Snippets** on `TugListView`, deleting `TugQuickList` outright; edit-in-place rides the list's existing descend-scope machinery rather than any bespoke focus code.
- Add **Text Files** as a new section over two existing stores (deck cards + recent-documents MRU).
- Rehome Log/Telemetry into a DevTools card *before* deleting their Lens sections, so the features are never unreachable at any commit.
- Verify with the real app at every step (`bunx vite build` before declaring tugdeck changes done; app-tests for the focus round-trip).

#### Success Criteria (Measurable) {#success-criteria}

- Cmd-L opens/focuses the Lens and a `data-key-cursor` ring is visible on a Sessions row (or the first row of the first visible section) — verifiable by app-test DOM query for `[data-key-cursor]` inside `.lens-content` after dispatching `focus-lens`.
- Tab / Shift-Tab move the key view between the three section lists in render order; arrows move the cursor within a section; each verifiable via `data-key-view-kbd` / `data-key-cursor` attribute queries.
- Enter on a Sessions row fronts the bound session card (`focus-session-card`); Enter on a Text Files row fronts its card or opens the recent path; Enter on a Snippet row opens its in-place editor with the caret in the textarea.
- Escape from a snippet editor commits the edit and returns the cursor to the row; Escape from a list pops focus out of the Lens to the prior card (existing `CANCEL_DIALOG` → `focus-lens` ladder still works).
- The Lens registers exactly three sections; `registerLogSection` / `registerTelemetrySection` no longer exist; Opt-Cmd-/ opens a DevTools card with working Log and Telemetry tabs.
- `bunx tsc --noEmit`, `bun test`, and `bunx vite build` all pass; the full `just app-test` sweep passes.

#### Scope {#scope}

1. `TugListView`: one additive imperative-handle method (`descendIntoRow`).
2. `snippetsStore`: `editingId` moves into the store snapshot; `createSnippet` opens the new row.
3. `recent-documents.ts`: a change-listener seam so a data source can subscribe.
4. Lens: Cmd-L key-view seeding in `LensContent`; Sessions, Snippets, and Text Files sections rebuilt/added on `TugListView`; per-section selection memory.
5. Deletion of `TugQuickList` and the Log/Telemetry Lens sections.
6. New DevTools card (componentId `"devtools"`) hosting the existing `LogInspector` / `TelemetryInspector`, with an Opt-Cmd-/ chord.

#### Non-goals (Explicitly out of scope) {#non-goals}

- No changes to the snippets storage/transport layer (snippets.json, SNIPPETS feed, autosave, undo model, drag-to-prompt insertion path) beyond the `editingId` snapshot field — all of snippets-bringup's Rust and store code stands.
- No persistence of per-section selection across launches (session-local memory only).
- No redesign of the Lens band chrome (collapse, grips, drag-reorder of sections, `…` visibility menu) — bodies change, bands do not.
- No "proper" final home for DevTools — the card is the interim home; a future phase revisits it (user's explicit framing).
- No spatial-order (`useSpatialOrder`) work: the Lens is a vertical stack of lists; the engine's group Tab walk plus each list's own arrow handling suffices — `spatialCursor` is not needed.

#### Dependencies / Prerequisites {#dependencies}

- The snippets-bringup phase (all steps `done` on `tugdash/snippets`): `snippetsStore`, `snippets-doc.ts`, `startSnippetDrag`, the SNIPPETS feed.
- `TugListView`'s authored-list focus contract (`focusGroup` / cursor / descend), already shipped and consumed by the session picker.
- The Lens frame: `lens-content.tsx`, `lens-section-registry.ts`, `lens-section-band.tsx`, `lensStore`.

#### Constraints {#constraints}

- Warnings are errors (`-D warnings` Rust; strict tsc/eslint in tugdeck). No new lint findings.
- Tuglaws apply throughout: [L01], [L02], [L03], [L06], [L22], [L24], [L26]; cross-check `tuglaws/focus-language.md`, `pane-model.md`, `component-authoring.md`; name touched laws in each dash commit body.
- Banned tests: no fake-DOM/RTL, no mock-store assertion tests. Real-app behavior → `tests/app-test/` via `just app-test`; pure logic → `bun:test`.
- All three lists render `inline` — estimated cell heights are banned in this codebase; small bounded lists render every cell with real measured heights.
- No `localStorage`/`sessionStorage`/IndexedDB; any persistent state goes through tugbank (none is added here).
- The debug build loads the production rollup bundle — run `bunx vite build` before declaring any tugdeck step done.

#### Assumptions {#assumptions}

- The FocusManager's group Tab walk skips groups with no registered focusables (a collapsed band unmounts its body — see #lens-focus-findings — so its list unregisters); Step 3's checkpoint verifies this in the running app and [Q01] tracks the fallback if it fails.
- `TugTextarea`'s `focusGroup`/`focusOrder` props register it via `useFocusable` into the `FocusModeContext` it mounts under (verified by reading `tug-textarea.tsx`; the session picker's per-row trash `TugIconButton` uses the same in-row registration pattern).
- Opt-Cmd-/ (`Slash` + meta + alt) is unbound (`keybinding-map.ts` binds `Slash`+meta to `OPEN_COMMAND_PICKER`; no alt variant exists).

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Does the engine's Tab walk cleanly skip an empty section group? (OPEN) {#q01-empty-group-skip}

**Question:** When a section is collapsed (body unmounted → its `TugListView` unregisters) or a list has zero rows, does Tab from a neighboring section skip it without trapping or dead-ending?

**Why it matters:** Tab-between-sections is the core navigation promise; a dead stop on an empty Snippets list would read as a regression.

**Options (if known):**
- The engine walk iterates registered focusables only, so an unregistered list is naturally absent (expected — collapse case).
- A registered list with zero rows still lands the ring on the container with no cursor (`firstCursorableRow()` returns −1; the gain-seed no-ops). Acceptable: the container tint shows where you are, and the empty-hint text explains why.

**Plan to resolve:** Verified live at Step 3's checkpoint (collapse Sessions, confirm Tab goes Snippets → Text Files). If a zero-row registered list proves confusing, follow up by setting `focusPolicy: "skip"` while empty (re-register on first row).

**Resolution:** OPEN — resolves during #step-3.

#### [Q02] Snippet row drag-reorder over TugListView cell wrappers (OPEN) {#q02-reorder-wrappers}

**Question:** `useBlockReorder` (generalized in snippets-bringup with `selector`/`kindAttr` options) reorders elements matched by a selector carrying an id attribute; `TugListView` cell wrappers carry `data-tug-list-cell-index` (an index, not an item id). Does index-keyed reordering (mapping indices→ids at commit) behave correctly through a windowless `inline` list?

**Why it matters:** Losing drag-reorder of snippets would regress a shipped affordance.

**Plan to resolve:** Spike inside #step-4: `getVisibleOrder` returns stringified indices from the wrappers, `commit` maps them through `snippetsDoc.snippets[i].id` → `snippetsStore.setOrder(ids)`. Since `inline` mounts every cell in document order and the FLIP preview only rearranges DOM order transiently before commit, index mapping at drop time is sound. If the FLIP preview fights React's keyed reconciliation, fall back to commit-on-drop with no live preview (caret only).

**Resolution:** OPEN — resolves during #step-4.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Descend into a just-mounted editor races the editor's focusable registration | med | med | R01 below | Enter on a snippet opens the editor but the caret is not in it |
| Empty/collapsed sections break the Tab cycle | med | low | [Q01]; verified live at Step 3 | Tab dead-ends in the Lens |
| Cell-wrapper `onClick` (→ `onSelect`) fires after a snippet ghost-drag ends over the row | low | med | `startSnippetDrag` already uses a movement threshold; a completed drag suppresses the click via its existing pointer-capture; verify in #step-4 checkpoint | Dragging a snippet also selects/activates it |
| Deleting Log/Telemetry orphans their CSS/test files | low | low | Step 6 greps for imports of everything it deletes; `bunx vite build` catches dangling imports | build failure |

**Risk R01: Descend-after-mount ordering** {#r01-descend-after-mount}

- **Risk:** Enter on a snippet row fires `onActivate` → `beginEdit(id)`; the editor (with its in-row focusable) mounts on the *next* commit, so the descend cannot happen synchronously in the same dispatch.
- **Mitigation:**
  - The section descends from a `useLayoutEffect` keyed on the store's `editingId` ([P07]): the effect runs after the commit that mounted the editor, so the row's `[data-tug-focusable]` exists by the time `descendIntoRow(index)` runs ([L03]).
  - `TugTextarea` registers its focusable in a `useLayoutEffect` too; both run in the same commit's layout phase, child effects before parent effects — the editor's registration (child) precedes the section body's descend effect (parent).
- **Residual risk:** If ordering ever proves fragile, the fallback is `focusManager.contextFor(cardId).armKeyboardRestore(...)`-style deferred landing; the app-test in Step 7 pins the behavior either way.

---

### Design Decisions {#design-decisions}

#### [P01] The uniform focus-language grammar; Space-to-add is retired (DECIDED) {#p01-uniform-grammar}

**Decision:** The Lens adopts the focus language exactly as `tuglaws/focus-language.md` and `TugListView`'s authored-list contract define it. Snippets' Things-3 "Space = new item" key is retired; creation moves to the header `+` and ⌘N, and the rapid-entry chain rides ⌘Return.

**Rationale:**
- User-approved (2026-07-18): "Yes. I accept."
- One grammar across all three sections; Space keeps its engine meaning (select the cursor row) everywhere.
- The Things quality the user actually wanted — get into and out of an item fluidly — is fully preserved by Enter/Escape/⌘Return (see Spec S01).

**Implications:**
- `TugQuickList` (which owns the old grammar) is deleted ([P05]).
- No custom keydown handling in any section for arrows/Space/Enter/Escape — the engine and `TugListView` own them.

#### [P02] Three TugListViews, one per section band; Tab between them (DECIDED) {#p02-three-lists}

**Decision:** Each section body renders its own `TugListView` authored into that section's focus group (`host.focusGroup`, already supplied by `LensSectionHost`); the engine's group walk — kept in section render order by `LensContent`'s existing `setGroupOrder` — makes Tab/Shift-Tab move between sections. No single flat list.

**Rationale:**
- User-approved. Keeps the band chrome (collapse, section drag-reorder, live collapsed summaries, `…` visibility menu) untouched.
- Maps directly onto machinery that already exists and is already ordered; zero new Tab plumbing.

**Implications:**
- Each list is one Tab stop; other in-Lens controls (fold cues, the Snippets `+` button) stay un-authored (not Tab stops) — reachable by pointer, consistent with the fold cue's click-focus-refusing design.

#### [P03] Text Files = open Text cards + the recent-documents MRU (DECIDED) {#p03-text-files-scope}

**Decision:** The Text Files section lists all open Text cards (deck cards with `componentId === "text"`), then a `"header"`-role divider row, then MRU entries from `recent-documents.ts` whose paths are not currently open. Enter/click on an open row fronts the card (`focus-session-card` — the action is card-generic); on a recent row it calls `openFileInCard(getDeckStore(), path)` (the same one-implementation entry every open flows through).

**Rationale:**
- User-approved: "open + recently-open MRU."
- The MRU already exists, is tugbank-persisted, and feeds the host's File ▸ Open Recent — no new storage.

**Implications:**
- `recent-documents.ts` needs a change-listener seam ([P09]) — today it has no subscribe.
- `roleForIndex` header rows are inert (not cursorable), so arrows skip the divider automatically.

#### [P04] Log/Telemetry leave the Lens; a DevTools card is the interim home (DECIDED) {#p04-devtools-card}

**Decision:** Delete `registerLogSection` / `registerTelemetrySection` and the two section files. Move the inspectors (`lens/internal/log-inspector*`, `telemetry-inspector*`, and their shared helpers) to a new `components/devtools/` home, hosted by a new singleton **DevTools card** (`componentId: "devtools"`) with a `TugTabBar` (Log | Telemetry), opened by a new `SHOW_DEVTOOLS` action bound to Opt-Cmd-/.

**Rationale:**
- User-approved, with the explicit condition that the features remain available; investigation showed the old TugDevPanel overlay was retired when the Lens absorbed them (commit `1057596df` "retires the dev panel"), so the Lens sections are currently the only UI — deletion without a rehome would orphan `tugDevLogStore` entirely.
- A registered card is the cheapest honest home: it rides existing card/pane machinery, and the user has flagged it for a future proper-home revisit.

**Implications:**
- The Telemetry tab needs a followed-card subject; it reuses the `useTrackLastNonLensKeyCard` hook (which excludes a given cardId from the follow), passing the DevTools card's own id.
- Persisted Lens section order self-heals: `resolveSectionRenderOrder` drops unknown kinds, so stale `"log"`/`"telemetry"` entries in `lensStore` state are ignored with no migration.

#### [P05] TugQuickList is deleted, not adapted (DECIDED) {#p05-delete-quicklist}

**Decision:** `tug-quick-list.tsx` / `tug-quick-list.css` (component, `useQuickList` controller, styles) are removed entirely; Snippets is its only consumer.

**Rationale:**
- It is the anti-pattern the focus language exists to prevent: a plain `tabIndex={0}` container, React-state selection, bespoke keydown — invisible to the FocusManager, which is exactly why Cmd-L never reached it.
- `TugListView` provides everything it hand-rolled, engine-integrated.

**Implications:**
- Its grammar responsibilities redistribute: movement/commit → the engine + `TugListView`; create/delete/undo keys → the Snippets section's cell renderer and a small container-level keydown for ⌘N/Delete/⌘Z (see Spec S01 note).

#### [P06] Snippet edit-in-place rides TugListView's descend scope (DECIDED) {#p06-edit-descend}

**Decision:** The editing snippet row mounts a `TugTextarea` authored into the row's own focus mode (cells render inside `TugListView`'s per-row `FocusModeContext.Provider`, mode `${listFocusableId}-row-${index}` — the same mechanism the session picker's per-row trash button uses). Opening = `delegate.onActivate` (Enter, via `commitOnEnter: "act"`) or double-click → `snippetsStore.beginEdit(id)`; once the editor mounts, the section calls the new `descendIntoRow(index)` handle method ([P08]) so the engine pushes the row scope and lands the key view in the textarea. Escape in the editor commits (`commitEdit()`) and `focusManager.ascend()` pops back to the list container with the cursor preserved on the row (built-in descend→ascend behavior). ⌘Return commits and chains: `commitEdit()` then `createSnippet(afterId)` — which sets `editingId` to the new row ([P07]), so the same layout effect descends into it.

**Rationale:**
- The descend scope is the sanctioned "get into a row" gesture; the capturing text control (textarea) suspends the arrow plane exactly as the focus language prescribes — arrows and Return are caret movement and newlines inside a multi-line body.
- The list's existing descended-row deletion reconciliation covers the edge where the edited row is deleted out from under the editor.

**Implications:**
- One cell kind (`"snippet"`) whose renderer branches on `editingId` — never two kinds for the same row id ([L26]: a kind change is a remount in disguise).
- The editor's Escape/⌘Return handling is a keydown on the editor wrapper (preventDefault + store call + engine call), not engine act-dispatch — DOM focus is inside an editable target, which the list's movement handler and act dispatch already skip.

#### [P07] editingId lives in the snippets store snapshot (DECIDED) {#p07-editing-id-in-store}

**Decision:** `snippetsStore`'s snapshot gains `editingId: string | null`. `beginEdit(id)` sets it (and brackets undo coalescing as today); `commitEdit()` clears it; `createSnippet(afterId)` sets it to the new id (replacing the `lastCreatedId` open-signal mechanism, which is removed).

**Rationale:**
- One owner for "which row is open": the store already brackets edits for undo; the section, the cell renderer, and the descend effect all need the same value — a store field read via `useSyncExternalStore` is the [L02]-clean single source.
- Kills the `openSignal` prop dance from `TugQuickList` (header `+` just calls `createSnippet(null)` and the store does the rest).

**Implications:**
- `lastCreatedId` is removed from the snapshot; `snippets-store.ts` tests update accordingly.
- Editor mounting is structure driven by store state — correct zone (external store, [L02]), not `useState` in the section.

#### [P08] TugListView gains a public `descendIntoRow(index)` handle method (DECIDED) {#p08-descend-handle}

**Decision:** Add `descendIntoRow(index: number): void` to `TugListViewHandle`: move the cursor to `index` (`moveCursorTo`), then run the existing internal `descendCursorRow()` (push the row's non-trapped scope, set the key view on the row's first inner focusable, focus it). No-op when the row has no inner focusable or the list is not engine-authored.

**Rationale:**
- The descend machinery exists and is correct (scope push, ascend restore, deletion landing); the only missing piece is an imperative entry for a consumer whose row content becomes descendable *after* an activation mounts it (the snippet editor).
- Additive and generic — any future in-place row editor gets the same gesture.

**Implications:**
- Purely additive to the handle; no behavior change for existing consumers.

#### [P09] recent-documents gains a listener seam (DECIDED) {#p09-recents-subscribe}

**Decision:** `recent-documents.ts` adds `subscribeRecentDocuments(listener: () => void): () => void`, notified from `initRecentDocuments`, `noteRecentDocument`, and `clearRecentDocuments` (after the in-memory list changes).

**Rationale:**
- The Text Files data source must re-window when the MRU changes; today the module only pushes to the Swift host.

**Implications:**
- Pure additive module-level listener set; no store class ceremony needed for a module that is already a de-facto singleton store.

#### [P10] Per-section selection memory is a session-local remembered id (DECIDED) {#p10-selection-memory}

**Decision:** Each section module keeps a module-level `let lastSelectedId: string | null`, written from `delegate.onSelect`/`onActivate`, and mapped to an index at render time for `TugListView`'s `initialSelectedIndex` (the cursor gain-seed). Not persisted.

**Rationale:**
- `TugListView` already preserves its cursor while mounted and re-seeds from `initialSelectedIndex` when the container regains the key view — the remembered id only matters across a collapse/expand (unmount) or relaunch-within-session.
- An id (not an index) survives row insertion/removal/reordering.
- [L24] sanctions local selection state; a module-level variable read during render is the lightest correct mechanism for state that must outlive the section body's mount.

**Implications:**
- A remembered id no longer present falls back to the first cursorable row (the `initialSelectedIndex` contract already handles a non-cursorable value).

#### [P11] Selection *is* activation for the monitor lists (DECIDED) {#p11-monitor-activation}

**Decision:** Sessions and Text Files route both `delegate.onSelect` (click / Space) and `delegate.onActivate` (Enter, via `commitOnEnter: "act"`) to the same activation (front the card / open the path). Snippets differs: `onSelect` only records selection; `onActivate` opens the editor.

**Rationale:**
- A monitor row has no meaningful "selected but not activated" state — clicking a session row must front the card (current shipped behavior).
- Keeping all three lists on the same authored shape (`focusGroup` + `commitOnEnter: "act"`, not `singleSelect`) gives one mental model; `singleSelect`'s commit-on-arrow would front a card on every ArrowDown, which is wrong here.

**Implications:**
- Arrow movement in Sessions/Text Files is pure cursor roving (no side effects); Enter or click commits.

---

### Deep Dives {#deep-dives}

#### How the focus wiring already works (findings for the cold reader) {#lens-focus-findings}

- **Cmd-L path:** `keybinding-map.ts` binds `KeyL`+meta → `TUG_ACTIONS.FOCUS_LENS`; the deck-canvas chain handler (`deck-canvas.tsx`, `FOCUS_LENS` entry) stashes the current first-responder card, `showLensPane()`, and activates the Lens card via `transferFocusForActivation`. A second Cmd-L while the Lens is the key card focuses back out to the stashed card. Activation runs `applyBagFocus` → `adoptKeyCard`, which restores the Lens card context's key view — so once a list has ever been the key view, later Cmd-L presses land straight back on it. The one missing piece is the *first* landing: `LensContent` must seed the opening key view (Step 3).
- **Seed key format:** `useSeedKeyView("<group>:<order>")` (`use-focusable.tsx`) arms `armKeyboardRestore` on the owning card's context, resolving immediately if the target focusable is registered or the moment it mounts. The Lens seed is `` `${sectionFocusGroup(order[0])}:0` `` where `order` is the resolved visible-section render order in `LensContent`.
- **Group order:** `LensContent` already runs `focusManager.contextFor(cardId).setGroupOrder(order.map(sectionFocusGroup))` in a layout effect keyed on the render order — section drag-reorder and visibility changes keep the Tab walk in lock-step with the rail. Nothing to change.
- **Collapse unmounts:** `lens-section-band.tsx` renders `null` for the body when collapsed, so a collapsed section's `TugListView` unmounts and unregisters its focusable — the Tab walk skips it with no extra code ([Q01] verifies).
- **Escape-out:** `LensContent` registers a `CANCEL_DIALOG` responder that re-dispatches `focus-lens` (the toggle-out). It is only in the chain while focus is inside the Lens. Unchanged.
- **Sessions rows today:** `sessions-section.tsx` renders `data-tug-focus="refuse"` / `tabIndex={-1}` divs with `role="button"` and an `onClick` dispatching `focus-session-card` — deliberately invisible to the keyboard. Step 3 replaces the row *container* mechanics while keeping the row *content* (phase dot via `RowPhaseDot`, name via `useSessionLabel`, pulse line via `usePulse`/`latestLineForScope`, sparkline via `RowSparkline`) verbatim.

#### The TugListView authored-list contract (as this plan uses it) {#listview-contract}

Authored with `focusGroup` (and not `singleSelect`), a `TugListView` is ONE item-container Tab stop: Tab lands the ring/tint on the scroll container; ArrowUp/Down/Home/End/PageUp/Down move a movement cursor (`data-key-cursor`, engine-projected DOM, [L06]) over `"cell"`-role rows; Space fires `delegate.onSelect` on the cursor row; Enter **descends** into a row whose content has a registered inner focusable, else (with `commitOnEnter: "act"`) fires `delegate.onActivate`, else bubbles; ArrowRight also descends, ArrowLeft/Escape ascend. On gaining the key view the cursor seeds onto `initialSelectedIndex` when cursorable, else the list's own selection, else the first cursorable row. Cells render inside a per-row `FocusModeContext.Provider` (`${listFocusableId}-row-${index}`), so any `useFocusable`-authored control inside a cell registers into that row's descend scope — reachable only by descending, never in the section Tab cycle. `followBottom` is forced off for authored lists (irrelevant here); `inline` mounts every cell with no windowing or height estimates.

#### DevTools card mechanics {#devtools-mechanics}

- **Card registration:** mirror an existing singleton registration (e.g. the settings card): `registerCard({ componentId: "devtools", ... })` with a content component hosting a `TugTabBar` over the two inspectors. Find-or-create + activate follows the deck-canvas `SHOW_SETTINGS` handler shape exactly (find card by `componentId`, `store.addCard("devtools")` when absent, `transferFocusForActivation`).
- **Action + chord:** add `SHOW_DEVTOOLS: "show-devtools"` to `action-vocabulary.ts`, a deck-canvas chain handler, and a `keybinding-map.ts` entry `{ key: "Slash", meta: true, alt: true, action: TUG_ACTIONS.SHOW_DEVTOOLS, preventDefaultOnMatch: true }` (Cmd-/ without alt remains the command picker).
- **Telemetry subject:** `telemetry-section.tsx`'s `useFollowedCardInfo` pattern ports into the card: `useTrackLastNonLensKeyCard(devtoolsCardId)` (the hook excludes the given card from the follow — it is not Lens-specific despite its name; keep the name or rename in place, implementer's choice) → `cardServicesStore.getServices` → `TelemetryInspector selectedCardId=...`, with the same empty state.
- **File moves:** `components/lens/internal/{log-inspector.tsx,.css, log-row.tsx, telemetry-inspector.tsx, telemetry-projection.ts, telemetry.css, field-row.tsx, field-section.tsx, copy-as-json.ts, __tests__/}` → `components/devtools/`; update the two inspectors' internal imports; `lens/internal/` ends this phase empty and removed.

#### Key existing code map (for the cold reader) {#code-map}

All paths tugdeck-relative (`tugdeck/src/...`):

- `components/lens/lens-content.tsx` — `LensContent`: section order, `setGroupOrder`, Escape-out responder, `.lens-content` sink. Gains the Cmd-L seed.
- `components/lens/lens-section-registry.ts` — `LensSectionHost` (supplies `focusGroup`), `sectionFocusGroup(kind)`, `resolveSectionRenderOrder` (drops unknown kinds — the self-healing that makes Log/Telemetry removal migration-free).
- `components/lens/lens-section-band.tsx` — band chrome; collapsed ⇒ body unmounted.
- `components/lens/sections/sessions-section.tsx` (+`.css`) — current refuse-rows monitor; row-content pieces to preserve are named in #lens-focus-findings.
- `components/lens/sections/snippets-section.tsx` (+`.css`) — current `TugQuickList` wiring; `insertIntoCard` + `startSnippetDrag` port unchanged into the new cell renderer.
- `components/lens/lens-followed-card.ts(x)` — `useTrackLastNonLensKeyCard`, `LensFollowedCardContext`.
- `components/tugways/tug-list-view.tsx` — the primitive; `TugListViewHandle` (gains `descendIntoRow`), `moveCursorTo` / `descendCursorRow` internals, per-row `FocusModeContext`.
- `components/tugways/tug-textarea.tsx` — accepts `focusGroup` / `focusOrder` / `focusPolicy` → `useFocusable`.
- `components/tugways/use-focusable.tsx` — `useFocusable`, `useSeedKeyView`.
- `components/tugways/keybinding-map.ts` — chord table (`KeyL` entries at the lens block; `Slash`+meta = command picker).
- `components/tugways/action-vocabulary.ts` — `TUG_ACTIONS`; `OPEN_FILE` payload `{ path, line?, endLine? }`.
- `components/chrome/deck-canvas.tsx` — chain handlers for `FOCUS_LENS` / `TOGGLE_LENS` / `SHOW_SETTINGS` (the find-or-create model for DevTools).
- `lib/snippets-store.ts`, `lib/snippets-doc.ts`, `lib/snippet-drag.ts` — snippets state, incipit (`snippetIncipit`), ghost-drag.
- `lib/recent-documents.ts` — MRU (`getRecentDocuments`, `noteRecentDocument`, `clearRecentDocuments`, `initRecentDocuments`); gains the listener seam.
- `lib/deck-store-registry.ts` — `getDeckStore()` for non-React/data-source access to `IDeckManagerStore` (nullable; data source must no-op on null).
- `lib/text-card-open-registry.ts` — `getOpenTextCard(cardId).getPath()` / `isDirty()`; `findTextCardByPath`.
- `lib/open-file-in-card.ts` — `openFileInCard(store, path, line?, endLine?)`, the single open chokepoint (also records the MRU).
- `lib/card-session-binding-store.ts` — bindings map for the Sessions rows (dedupe by `tugSessionId` in binding order, as today's `buildRows` does).
- `main.tsx` — boot registrations: `registerSessionsSection()` / `registerLogSection()` / `registerTelemetrySection()` / `registerSnippetsSection()` (the middle two go away; Text Files and the DevTools card registration are added).

---

### Specification {#specification}

**Spec S01: The Lens keyboard grammar** {#s01-grammar}

| Key | In a section list | In an open snippet editor |
|-----|-------------------|---------------------------|
| Cmd-L | open/focus the Lens; cursor lands on the remembered row (first row on first use); Cmd-L again exits to the prior card | — |
| ↑ ↓ Home End | move the cursor (rove only; no side effects) | caret movement (capturing text control) |
| Tab / ⇧Tab | next / previous section list | — (Tab is not claimed by the editor; engine behavior) |
| Space | `onSelect` the cursor row (Sessions/Text Files: activate [P11]; Snippets: select only) | types a space |
| Enter | Sessions/Text Files: activate. Snippets: open the editor ([P06]) | newline |
| ⌘Return | — | commit + create-and-open next snippet (rapid chain) |
| Escape | pop out of the Lens (existing `CANCEL_DIALOG` → `focus-lens`) | commit + ascend to the list, cursor on the row |
| ⌘N | Snippets list only: create below the cursor and open | — |
| Delete/⌫ | Snippets list only: delete the cursor row (undo is the safety net) | normal editing |
| ⌘Z / ⇧⌘Z | Snippets list only: snippets undo/redo | textarea-native undo |

Note: ⌘N / Delete / ⌘Z on the Snippets list are a small capture-phase keydown on the section's wrapper div (active only while the list container holds `data-key-view-kbd` and the event target is not editable) — they are section verbs, not engine grammar, mirroring how `TugQuickList` scoped them. Movement/commit keys are never touched by section code.

**Spec S02: Data sources** {#s02-data-sources}

All three implement `TugListViewDataSource` with `getVersion()` returning a monotonic counter bumped per upstream notification (or the upstream snapshot reference where one exists), and cache their derived row arrays per version so repeated reads are referentially stable.

- `LensSessionsDataSource` (`components/lens/sections/sessions-data-source.ts`): rows from `cardSessionBindingStore.getSnapshot()`, deduped by `tugSessionId` in binding order (port of today's `buildRows`); `idForIndex` = `tugSessionId`; kind `"session"`; row payload `{ cardId, tugSessionId, projectDir }` via a typed `rowAt(index)`.
- `LensSnippetsDataSource` (`components/lens/sections/snippets-data-source.ts`): rows = `snippetsStore.getSnapshot().doc.snippets`; `idForIndex` = snippet id; kind `"snippet"` (one kind always, [P06]/[L26]); `rowAt(index)` returns the `Snippet`.
- `LensTextFilesDataSource` (`components/lens/sections/text-files-data-source.ts`): subscribes to BOTH `getDeckStore()` (null-tolerant) and `subscribeRecentDocuments`. Rows: open Text cards in deck-card order (kind `"text-open"`, id = cardId, title from `getOpenTextCard(cardId)?.getPath()` — basename, path-tail subtitle; null path ⇒ "Untitled"); then, when any survive, one `"header"`-role row (id `"recents-header"`, kind `"recents-header"`, label "Recent"); then MRU paths not matching any open card's path (kind `"text-recent"`, id = path).

**Spec S03: Snippets cell renderer** {#s03-snippet-cell}

One renderer for kind `"snippet"`, branching on `editingId === id` (read from `snippetsStore` via `useSyncExternalStore` inside the cell — [L02], and the branch stays inside one component type):

- **Display branch:** incipit line (`snippetIncipit`; empty ⇒ muted "New snippet"), `startSnippetDrag` on pointerdown (port of today's `SnippetRow`, including `insertIntoCard` targeting `cardServicesStore...insertSnippet`), `onDoubleClick` → `beginEdit(id)`, and a `BlockGrip` when reorder is enabled ([Q02]).
- **Editor branch:** `TugTextarea` with `autoResize`, `defaultValue={snippet.text}`, `onChange` → `updateSnippet(id, value)`, authored `focusGroup="snippet-row-editor"` `focusOrder={0}` (registers into the row's descend scope via the per-row `FocusModeContext`), and a wrapper `onKeyDown`: Escape → preventDefault, `commitEdit()`, `focusManager.ascend()`; ⌘Return → preventDefault, `commitEdit()`, `createSnippet(id)`.

The section body renders error state (`snapshot.error`) above the list as today, holds the list `ref`, and runs the descend layout effect: when `editingId` transitions to a non-null id, resolve its index and call `listRef.current?.descendIntoRow(index)`.

#### State Zone Mapping (tugdeck/tugways plans) {#state-zone-mapping}

| State | Zone (appearance / local-data / structure) | Mechanism | Law |
|-------|--------------------------------------------|-----------|-----|
| Key view / cursor / row descend scope | structure (engine-owned) | `FocusManager` via `TugListView`; projected to `data-key-view-kbd` / `data-key-cursor` | [L22], [L06] |
| Focus/selection appearance | appearance | CSS on engine attributes only | [L06] |
| `editingId` (which snippet is open) | external store | `snippetsStore` snapshot + `useSyncExternalStore` | [L02] |
| Snippet text edits / order / undo | external store | `snippetsStore` (unchanged from snippets-bringup) | [L02] |
| Sessions rows | external store | `cardSessionBindingStore` (+ per-row stores as today) via data source `subscribe`/`getVersion` | [L02] |
| Text Files rows | external store | `getDeckStore()` + `subscribeRecentDocuments` via data source | [L02] |
| Per-section remembered selection id | local-data | module-level id, read at render into `initialSelectedIndex` | [L24] |
| DevTools active tab | local-data | `TugTabBar` selection state in the card | [L24] |
| Lens section order/collapse/visibility | external store | `lensStore` (unchanged) | [L02] |

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tugdeck/src/components/lens/sections/sessions-data-source.ts` | `LensSessionsDataSource` (Spec S02) |
| `tugdeck/src/components/lens/sections/snippets-data-source.ts` | `LensSnippetsDataSource` (Spec S02) |
| `tugdeck/src/components/lens/sections/text-files-data-source.ts` | `LensTextFilesDataSource` (Spec S02) |
| `tugdeck/src/components/lens/sections/text-files-section.tsx` (+`.css`) | Text Files section registration + cell renderers |
| `tugdeck/src/components/devtools/` (moved tree) | relocated `lens/internal/` inspectors + helpers + tests |
| `tugdeck/src/components/devtools/devtools-card.tsx` (+`.css`) | DevTools card content (TugTabBar: Log \| Telemetry) + `registerDevtoolsCard()` |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `TugListViewHandle.descendIntoRow` | method | `tugdeck/src/components/tugways/tug-list-view.tsx` | [P08]; `moveCursorTo` + internal `descendCursorRow`; no-op without inner focusable |
| `SnippetsSnapshot.editingId` | field | `tugdeck/src/lib/snippets-store.ts` | [P07]; replaces `lastCreatedId` |
| `snippetsStore.beginEdit` / `commitEdit` / `createSnippet` | modified fns | `tugdeck/src/lib/snippets-store.ts` | set/clear `editingId`; create opens the new row |
| `subscribeRecentDocuments` | fn | `tugdeck/src/lib/recent-documents.ts` | [P09]; notified from init/note/clear |
| `TUG_ACTIONS.SHOW_DEVTOOLS` | const + handler + binding | `action-vocabulary.ts`, `deck-canvas.tsx`, `keybinding-map.ts` | Opt-Cmd-/; find-or-create the devtools card |
| `registerSnippetsSection` / `registerSessionsSection` | rewritten | `tugdeck/src/components/lens/sections/*.tsx` | bodies rebuilt on `TugListView` |
| `registerTextFilesSection` | fn | `text-files-section.tsx` | registered from `main.tsx` |
| `registerLogSection` / `registerTelemetrySection` | **deleted** | `lens/sections/log-section.tsx`, `telemetry-section.tsx` | files removed with their CSS |
| `TugQuickList` / `useQuickList` | **deleted** | `tugways/tug-quick-list.tsx` (+`.css`) | [P05] |
| `LensContent` seed | edit | `lens/lens-content.tsx` | `useSeedKeyView(sectionFocusGroup(order[0]) + ":0")` (null when no visible sections) |

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit (`bun:test`)** | Data-source derivations (dedupe, open/recent merge, header-row placement, version caching), snippets-store `editingId` transitions, recent-documents listener notification | pure logic, no DOM |
| **Real-app (`tests/app-test/`, `just app-test`)** | The focus round-trip: Cmd-L seed, Tab between sections, cursor movement, Enter-activate, snippet open/Escape-ascend, Escape-out; DevTools chord | anything involving the engine, DOM focus, or key events |

#### What stays out of tests {#test-non-goals}

- No fake-DOM/RTL render tests and no mock-store assertion tests — banned repo-wide; the real-app layer covers rendering/focus behavior.
- `TugListView` internals (cursor math, descend scope push/pop, deletion landing) — already covered by the primitive's own suites; this plan only adds coverage for the new `descendIntoRow` entry via the snippet-editor app-test.
- Drag interactions (section reorder, snippet ghost-drag, row reorder) — pointer-capture gesture streams are not reliably synthesizable headless; verified interactively at checkpoints.
- Editor-leaf ⌘-key behavior inside the snippet textarea beyond Escape/⌘Return — the app-test harness cannot make an arbitrary editor the chain-leaf first responder for accelerator dispatch; store-layer tests cover the commit semantics.

---

### Execution Steps {#execution-steps}

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | TugListView `descendIntoRow` | done | 9bf076af9 |
| #step-2 | Store seams: `editingId` + recents subscribe | done | 1e9c26434 |
| #step-3 | Sessions on TugListView + the Cmd-L seed | done | 732b69ff7 |
| #step-4 | Snippets on TugListView; delete TugQuickList | done | 7d87c5320 |
| #step-5 | Text Files section | done | 30595c0f0 |
| #step-6 | DevTools card; remove Log/Telemetry from the Lens | done | 67df30722 |
| #step-7 | Integration checkpoint: grammar app-test + full sweep | done | 38ca1a356 |

#### Step 1: TugListView `descendIntoRow` {#step-1}

**Commit:** `Add descendIntoRow to the TugListView handle`

**References:** [P08] descend handle, (#listview-contract, #p06-edit-descend)

**Artifacts:**
- `descendIntoRow(index)` on `TugListViewHandle` in `tugdeck/src/components/tugways/tug-list-view.tsx`, implemented in the `useImperativeHandle` block alongside `scrollToIndex`.

**Tasks:**
- [ ] Add the method to the `TugListViewHandle` interface with a JSDoc contract: clamp/validate `index`; when the list is engine-authored and the row has an inner `[data-tug-focusable]`, `moveCursorTo(index, true)` then `descendCursorRow()`; otherwise no-op (never throws).
- [ ] Wire it in the imperative-handle memo, reading the same refs/callbacks `descendCursorRow` already uses.

**Tests:**
- [ ] None at this layer (engine/DOM behavior; covered by the Step 7 app-test through the snippet editor). Type-level exposure is exercised by Step 4's compile.

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bun test tug-list-view`

---

#### Step 2: Store seams: `editingId` + recents subscribe {#step-2}

**Depends on:** #step-1

**Commit:** `Snippets editingId in store; recents change listeners`

**References:** [P07] editingId in store, [P09] recents subscribe, (#s03-snippet-cell)

**Artifacts:**
- `editingId` in the `snippetsStore` snapshot; `lastCreatedId` removed.
- `subscribeRecentDocuments` in `tugdeck/src/lib/recent-documents.ts`.

**Tasks:**
- [ ] `lib/snippets-store.ts`: snapshot gains `editingId: string | null` (initial null). `beginEdit(id)` sets it (keeping the existing undo-coalescing bracket); `commitEdit()` clears it; `createSnippet(afterId)` sets it to the new snippet's id and returns the id. Remove `lastCreatedId` and its emissions.
- [ ] `lib/recent-documents.ts`: module-level `Set` of listeners; `subscribeRecentDocuments(listener)` returns an unsubscribe; notify after the list mutates in `initRecentDocuments`, `noteRecentDocument`, `clearRecentDocuments`.
- [ ] Update `snippets-store` unit tests for the new snapshot shape; fix any `lastCreatedId` references (the section's usage is rewritten in Step 4; a temporary `@ts-expect-error`-free bridge is acceptable only if the tree must compile between commits — prefer folding the one-line section touch into this commit).

**Tests:**
- [ ] `bun:test`: `beginEdit`/`commitEdit`/`createSnippet` transitions of `editingId`; create-sets-editing; commit-clears.
- [ ] `bun:test`: `subscribeRecentDocuments` fires on note/clear and not after unsubscribe.

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bun test snippets recent-documents`

---

#### Step 3: Sessions on TugListView + the Cmd-L seed {#step-3}

**Depends on:** #step-1

**Commit:** `Sessions section on TugListView; Cmd-L seeds the Lens key view`

**References:** [P01] uniform grammar, [P02] three lists, [P10] selection memory, [P11] monitor activation, [Q01] empty-group skip, Spec S01, Spec S02, (#lens-focus-findings, #listview-contract, #code-map)

**Artifacts:**
- `sessions-data-source.ts` (`LensSessionsDataSource`); `sessions-section.tsx` rebuilt on `TugListView`; the seed in `lens-content.tsx`.

**Tasks:**
- [ ] Write `LensSessionsDataSource` per Spec S02 (dedupe port of `buildRows`; version = binding-store snapshot ref; cached row array).
- [ ] Rebuild `SessionsSectionBody`: `TugListView` with `dataSource`, `inline`, `focusGroup={host.focusGroup}`, `commitOnEnter="act"`, `initialSelectedIndex` from the remembered id ([P10]), cell renderer `"session"` reusing today's row content (phase dot / label / pulse / sparkline) minus `data-tug-focus="refuse"`, `role="button"`, `tabIndex`, and the row-level `onClick` (the wrapper's click → `onSelect` replaces it).
- [ ] Delegate: `onSelect` and `onActivate` both record the remembered id and dispatch `focus-session-card` with the row's `cardId` ([P11]).
- [ ] `lens-content.tsx`: `useSeedKeyView(order.length > 0 ? `${sectionFocusGroup(order[0])}:0` : null)` so the first Cmd-L lands the key view on the first visible section's list.
- [ ] Adjust `sessions-section.css` for cursor styling if needed — selection/cursor appearance rides the engine attributes and list-view tokens; no React state, no bespoke focus CSS attributes ([L06]).

**Tests:**
- [ ] `bun:test`: `LensSessionsDataSource` — dedupe by session, id/kind mapping, version stability across unrelated reads.

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bun test sessions-data-source && bunx vite build`
- [ ] Live (HMR): Cmd-L shows a cursor ring on the first Sessions row; arrows move it; Enter fronts the card; Cmd-L again returns to the prior card; collapsing Sessions makes Tab land on the next section's list ([Q01] observed and noted in the commit body).

---

#### Step 4: Snippets on TugListView; delete TugQuickList {#step-4}

**Depends on:** #step-2, #step-3

**Commit:** `Snippets section on TugListView with descend-scope editing`

**References:** [P01] uniform grammar, [P05] delete quicklist, [P06] edit descend, [P07] editingId, [P08] descend handle, [P10] selection memory, [Q02] reorder wrappers, Spec S01, Spec S02, Spec S03, Risk R01, (#s03-snippet-cell, #listview-contract)

**Artifacts:**
- `snippets-data-source.ts`; `snippets-section.tsx` rebuilt; `tug-quick-list.tsx` / `tug-quick-list.css` deleted.

**Tasks:**
- [ ] Write `LensSnippetsDataSource` per Spec S02.
- [ ] Rebuild `SnippetsBody` per Spec S03: `TugListView` (`inline`, `focusGroup={host.focusGroup}`, `commitOnEnter="act"`, `initialSelectedIndex` from remembered id), one `"snippet"` cell renderer branching display/editor on `editingId`, the descend layout effect (`editingId` → `descendIntoRow`; Risk R01), and the section-verbs keydown (⌘N / Delete / ⌘Z per Spec S01 note).
- [ ] Editor branch: `TugTextarea` authored into the row scope; Escape → `commitEdit()` + `focusManager.ascend()`; ⌘Return → `commitEdit()` + `createSnippet(currentId)`.
- [ ] Header `+` calls `createSnippet(null)` (store sets `editingId`; the descend effect opens it) — the `openSignal` plumbing is gone.
- [ ] Port `startSnippetDrag` + `insertIntoCard` into the display branch unchanged; verify a completed drag does not fire the wrapper click's `onSelect` (risk table).
- [ ] Resolve [Q02]: wire `useBlockReorder` over the cell wrappers (index-mapped commit → `setOrder`), or fall back per the question's plan; record the outcome in the plan.
- [ ] Delete `tugways/tug-quick-list.tsx` and `.css`; grep for any residual references.

**Tests:**
- [ ] `bun:test`: `LensSnippetsDataSource` id/kind/version; a store-level test that ⌘Return's `commitEdit` + `createSnippet` sequence yields a new `editingId` distinct from the committed row.

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bun test snippets && bunx vite build`
- [ ] Live: Tab from Sessions lands on Snippets; Enter opens a snippet with the caret in the textarea; typing autosaves (watch `snippets.json`); Escape returns the cursor to the row with the incipit updated; ⌘Return chains a new snippet; Delete removes with ⌘Z restore; dragging a snippet into a session prompt still inserts.

---

#### Step 5: Text Files section {#step-5}

**Depends on:** #step-3

**Commit:** `Text Files Lens section: open cards + recent documents`

**References:** [P02] three lists, [P03] text-files scope, [P09] recents subscribe, [P10] selection memory, [P11] monitor activation, Spec S02, (#code-map)

**Artifacts:**
- `text-files-data-source.ts`, `text-files-section.tsx` (+`.css`), registered from `main.tsx`.

**Tasks:**
- [ ] Write `LensTextFilesDataSource` per Spec S02 (deck store null-tolerant; open cards, `"header"` divider, filtered recents; unsubscribe both upstreams on teardown).
- [ ] Section registration (`kind: "text-files"`, title "Text Files", a lucide file glyph) with a live collapsed summary (`N open · M recent`).
- [ ] Cell renderers: `"text-open"` (basename + dimmed path tail), `"recents-header"` (inert label), `"text-recent"` (basename + dimmed path tail, visually quieter). Compose `TugListRow` for row presentation — never hand-rolled row chrome.
- [ ] Delegate: `"text-open"` rows → `focus-session-card` with the cardId; `"text-recent"` rows → `openFileInCard(getDeckStore(), path)` (null-guard the store); both record the remembered id ([P10]).
- [ ] Register from `main.tsx` after `registerSessionsSection()`.

**Tests:**
- [ ] `bun:test`: merge/order/filter logic — open-path exclusion from recents, header presence only when recents exist, `roleForIndex` for the divider, reaction to both subscription sources.

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bun test text-files && bunx vite build`
- [ ] Live: open two files; the section lists them; Enter fronts the right card; a recent (closed) path opens via Enter and the row migrates from Recent to open on the next tick.

---

#### Step 6: DevTools card; remove Log/Telemetry from the Lens {#step-6}

**Depends on:** #step-3

**Commit:** `DevTools card hosts Log/Telemetry; Lens drops the sections`

**References:** [P04] devtools card, (#devtools-mechanics, #code-map)

**Artifacts:**
- `components/devtools/` (moved inspectors + `devtools-card.tsx`); `SHOW_DEVTOOLS` action + Opt-Cmd-/ binding; `log-section.tsx` / `telemetry-section.tsx` (+ their CSS) deleted; `main.tsx` registrations updated.

**Tasks:**
- [ ] Move `components/lens/internal/` → `components/devtools/` (all files listed in #devtools-mechanics, including `__tests__/`); fix imports; remove the emptied `lens/internal/`.
- [ ] Write `devtools-card.tsx`: registered card `componentId: "devtools"`, `TugTabBar` with Log and Telemetry tabs; Log tab = `<LogInspector />`; Telemetry tab = the ported `useFollowedCardInfo` pattern (via `useTrackLastNonLensKeyCard(cardId)`) + `<TelemetryInspector selectedCardId=... />` + empty state.
- [ ] Add `TUG_ACTIONS.SHOW_DEVTOOLS`, the deck-canvas find-or-create handler (mirroring `SHOW_SETTINGS`), and the `Slash`+meta+alt keybinding.
- [ ] Delete `lens/sections/log-section.tsx`, `telemetry-section.tsx`, `telemetry-section.css`; remove their imports/registrations from `main.tsx`; register the DevTools card where other cards register.
- [ ] Grep for `"log"` / `"telemetry"` Lens-kind references (tests, `KIND_MIGRATIONS`-like tables, app-tests) and update; persisted order needs no migration (`resolveSectionRenderOrder` drops unknown kinds).

**Tests:**
- [ ] Existing `devtools/__tests__` (moved) still pass; any Lens tests referencing the removed sections updated.

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bun test && bunx vite build`
- [ ] Live: Opt-Cmd-/ opens the DevTools card; Log shows `tugDevLogStore` entries; Telemetry follows the last session card; the Lens shows exactly Sessions / Snippets / Text Files, and its `…` menu lists only those three.

---

#### Step 7: Integration checkpoint: grammar app-test + full sweep {#step-7}

**Depends on:** #step-4, #step-5, #step-6

**Commit:** `App-test: the Lens focus grammar end-to-end` (test file only; otherwise `N/A (verification only)`)

**References:** [P01] uniform grammar, [P06] edit descend, Spec S01, (#success-criteria, #test-plan-concepts)

**Artifacts:**
- One app-test in `tests/app-test/` covering the Lens grammar round-trip.

**Tasks:**
- [ ] Write the app-test: dispatch `focus-lens`; assert a `[data-key-cursor]` row exists inside `.lens-content`; synthesize Tab and assert the key view (`data-key-view-kbd`) moves to the next section's list; ArrowDown moves the cursor; on Snippets, Enter mounts the editor with DOM focus in its textarea; Escape returns `data-key-view-kbd` to the list container with `[data-key-cursor]` on the same row; Escape again leaves the Lens (key card changes). Space synthetic key events with settle delays per the harness conventions; reveal-scroll assertions must clear any stuck sticky header.
- [ ] Run the full sweep and the Rust suite; fix anything the sweep surfaces.
- [ ] Build and hand off: `just app-debug`, report the instance id.

**Tests:**
- [ ] `just app-test <new-file>` — `VERDICT: PASS`.

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bun test && bunx vite build`
- [ ] `just app-test` (full sweep) — `VERDICT: PASS`
- [ ] `cd tugrust && cargo nextest run` (unchanged Rust, but the gate stays green)

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** A Lens whose three sections — Sessions, Snippets, Text Files — are fully keyboard-navigable `TugListView`s under the focus language (Cmd-L seed, Tab between sections, uniform grammar per Spec S01), with Log/Telemetry rehomed in an Opt-Cmd-/ DevTools card and `TugQuickList` deleted.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] Every Success Criterion in #success-criteria verified (app-test + live).
- [ ] `TugQuickList`, `log-section`, `telemetry-section`, and `lens/internal/` no longer exist in the tree; `grep -r "TugQuickList\|registerLogSection\|registerTelemetrySection" tugdeck/src` is empty.
- [ ] All checkpoints green: `bunx tsc --noEmit`, `bun test`, `bunx vite build`, full `just app-test`, `cargo nextest run`.

**Acceptance tests:**
- [ ] The Step 7 app-test (Lens grammar round-trip) passes in the sweep.
- [ ] Data-source unit suites (sessions / snippets / text-files) pass.

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] A proper long-term home for DevTools (user-flagged revisit).
- [ ] `focusPolicy: "skip"` for empty registered lists if [Q01]'s zero-row landing proves confusing in daily use.
- [ ] Persisted per-section selection (tugbank) if session-local memory proves insufficient.
- [ ] Type-to-filter within Lens sections (a `useFilteredDataSource` host input), deliberately deferred.

| Checkpoint | Verification |
|------------|--------------|
| Focus grammar end-to-end | Step 7 app-test, `VERDICT: PASS` |
| No regressions repo-wide | full `just app-test` sweep + `bun test` + `cargo nextest run` |
| Bundle integrity | `bunx vite build` |
