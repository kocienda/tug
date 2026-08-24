<!-- devise-skeleton v4 -->

## Lens Cards Rework {#lens-cards-rework}

**Purpose:** Replace the Lens's **Sessions** and **Files** sections with one **Cards** section — a pane-first mirror of the deck canvas, grouped by kind (Sessions / Files / Tools) — so that *every* card on the deck has a representation in the Lens, including multi-card panes like the debug build's Component Gallery. A single-card pane's row is pixel-for-pixel today's row; the pane level is a fact of the data derivation, never a folder the user must open.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | dash worktree (user-created; lands on `main` via `/join`) |
| Last updated | 2026-08-01 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

The Lens today has five sections: Sessions, Files, Snippets, Layouts, and (registered order per `main.tsx`'s `registerSessionsSection()` / `registerSnippetsSection()` / `registerFilesSection()` / `registerLayoutsSection()`). Sessions and Files are both **card taxonomies** — flat `TugListView`s over deck cards of specific `componentId`s — and everything else on the deck (Diff cards, Settings, About, the Component Gallery's 89 tabs, DevTools) has no Lens representation at all. That division — one privileged card type with its own section, another with its own, everything else invisible — is a wart. The row that made Sessions feel special was never the *section*; it is the *cell renderer* (the three-line `TugSessionRow` monitor), and `TugListView` already dispatches renderers by row kind.

Two further problems compound it. First, both sections flatten the deck's real two-level shape (panes own `cardIds` with one `activeCardId` — see `TugPaneState` in `tugdeck/src/layout-tree.ts`), so two files stacked in one pane read as two unrelated rows, and a pane of 89 gallery tabs would be unrepresentable. Second, the Files section still wears its pre-rename vocabulary everywhere (`.text-files-row`, `data-text-card-id`, `.lens-text-files-list`, `[data-testid="lens-text-file-unsaved"]`, `lensStore.textFileOrder`) — naming debt the user has directed be paid **now**, in full.

#### Strategy {#strategy}

- Build **bottom-up in landable slices**: registry group declarations first (pure additive), then the persisted-state schema, then a pure data source with bun tests, then the UI swap in two moves — Files+Tools first, Sessions folded in immediately after ([P01], user-locked sequencing).
- The row model is **pane-first**: the top level of the Cards list is always a pane; a single-card pane borrows its card's identity wholesale ([P02] — the invariant this plan exists to honor); a multi-card pane lists as itself with all its cards as always-open outline rows beneath ([P02]).
- Groups derive from the **card registry**, not a new taxonomy: a `lensGroup` field on `CardRegistration` plus a resolver with a `tools` fallback, pinned by a coverage unit test so a future card type cannot be born without a Lens home ([P05]).
- Reuse the existing Lens machinery unchanged wherever it already answers: `registerLensSection` band/filter/collapse plumbing, `useBlockReorder` FLIP, `SlotPicker`, `setSectionContent`, `lens-filter-store`, `LENS_LIST_PRESENTATION`, `focus-session-card` activation.
- Pay the naming debt at the extraction: no legacy DOM class, testid, store key, or file name survives into the new section ([P09]).
- Every step leaves the app green: `bunx tsc --noEmit`, `bunx vite build`, `bun test`, and the step's app-test selection all pass before its commit.

#### Success Criteria (Measurable) {#success-criteria}

- The Lens renders exactly three sections: Cards, Snippets, Layouts (verify: `document.querySelectorAll('[data-lens-section]')` yields kinds `cards`, `snippets`, `layouts`).
- A single-card pane's row in Cards has **no** disclosure affordance and the same DOM shape as its pre-rework equivalent modulo renamed classes: leading control (close box or phase dot), title line with slot picker, no indent, no chevron (verify: new app-test asserts no `.lens-cards-subrow` and no fold control inside a single-card pane row).
- A multi-card pane renders one pane row plus one always-visible indented subrow per card, with no per-pane fold control anywhere (verify: new app-test over a `gallery-buttons` stack — 4 subrows present immediately after open, zero clicks).
- Activation flows are untouched: clicking/Enter on a session pane row fronts its card; clicking a subrow fronts that tab within its pane (verify: app-test asserts the pane's `activeCardId` changes on subrow activation).
- Group headers are cursorable rows: arrows reach them, Enter/Space/click toggles the group's collapse, and the collapse persists across relaunch (verify: app-test + `lens-store` persistence test).
- ⌘L into a fresh Lens lands the movement cursor on a **pane row**, never on a group header (verify: `at0312` + `at0278` assert the cursor row is not `.lens-cards-header`) — [P16].
- Reorder engages while another group is collapsed and commits within the dragged row's own group (verify: `at0312` drag scenario; guards the Spec S03 silent-abort trap and [P15]'s clamp).
- One filter field filters the whole Cards section across groups; groups with no matches disappear; clearing restores per-group user order (verify: app-test).
- No occurrence of `text-files`, `data-text-card-id`, `lens-text-file`, `textFileOrder`, or `sessionOrder` remains under `tugdeck/src` or `tests/app-test` except in `lens-store` legacy-key *hydration seeding* and its migration tests (verify: `rg -n "text-files|textFileOrder|sessionOrder|lens-text-file|data-text-card-id" tugdeck/src tests/app-test`).
- The coverage unit test walks `getAllRegistrations()` and proves every registration resolves to a group or the explicit `"none"` exclusion (verify: `bun test cards-groups`).

#### Scope {#scope}

1. `lensGroup` on `CardRegistration` + `resolveLensGroup` resolver + coverage unit test.
2. `lensStore` schema: per-group row order (`cardsRowOrder`) and collapsed groups (`cardsCollapsedGroups`), with hydration seeding from the legacy `sessionOrder` / `textFileOrder` keys and `KIND_MIGRATIONS` entries `sessions → cards`, `files → cards`.
3. A pure `cards-data-source.ts` producing the two-level grouped projection (headers, pane rows, subrows) with filtering and ordering, plus bun unit tests.
4. `cards-section.tsx` / `cards-section.css` replacing `files-section.*` (groups: files + tools), then folding Sessions in (monitor cell renderer moves over; `sessions-section.*` retired).
5. Naming-debt payoff across DOM, testids, store keys, and file names; retirement of the Files header recents menu.
6. App-test updates for every pinned selector, plus one new two-level app-test; docs updates (`tuglaws/list-view-usage.md` consumer inventory, `tuglaws/app-test-inventory.md`).

#### Non-goals (Explicitly out of scope) {#non-goals}

- **Subrow drag-reorder** (reordering tabs within a pane from the Lens). Pane rows reorder within their group; card subrows do not drag. Tab order is the pane's own surface's job for now.
- **Alternative arrangements** ("by Canvas" ordering, sort controls). The only arrangement this plan ships is group-by-kind; the pane-first model was chosen so arrangements can be added later without re-architecture.
- **Any per-pane fold state.** Explicitly banned by [P02].
- **Snippets and Layouts sections** — untouched.
- **A replacement for the Files recents menu.** Retired without a successor per the user's decision ([P10]); `lib/recent-documents.ts` itself stays (File ▸ Open Recent still consumes it).
- **Release-build gating of Tools rows.** None needed: rows derive from mounted panes, and a release deck never mounts gallery/devtools cards, so the Tools group is simply absent.
- **Changing what `focus-session-card`, `assign-slot`, `close-tab` do.** The section composes existing actions only.

#### Dependencies / Prerequisites {#dependencies}

- The Files section trio as it stands on `main` today: `tugdeck/src/components/lens/sections/files-section.tsx`, `files-data-source.ts`, `files-section.css` (already renamed from `text-files-*` at the file level; DOM vocabulary still legacy).
- `TugListView` (`tugdeck/src/components/tugways/tug-list-view.tsx`) heterogeneous cell dispatch by `kindForIndex`, `commitOnEnter="act"`, `initialSelectedIndex`, per-row descend scopes.
- `useBlockReorder` (`tugdeck/src/components/lens/block-reorder.ts`) with its `selector` / `kindAttr` / `getVisibleOrder` / `commit` options.
- `lensStore` (`tugdeck/src/lib/lens-store/`) and its existing test suite (`__tests__/reducer.test.ts`, `migration.test.ts`, `persistence.test.ts`).
- tugbank running (implicit — the store already depends on it).

#### Constraints {#constraints}

- Tuglaws: [L01] one root render; [L02] external state via `useSyncExternalStore`; [L03] `useLayoutEffect` registrations; [L06] appearance via CSS/DOM; [L11] controls emit typed actions; [L19]/[L20] component authoring + token sovereignty; [L22] FocusManager owns the cursor; [L24] selection ownership. Cross-check `tuglaws/tuglaws.md`, `tuglaws/list-view-usage.md`, `tuglaws/focus-language.md` before UI work; name touched laws in each dash commit body.
- Compose real Tug components — `TugListView`, `TugListRow`, `TugSessionRow`, `TugIconButton`, `TugLabel`, `SlotPicker`. No hand-rolled rows, ramps, or focus.
- No `localStorage`/`sessionStorage`/IndexedDB — persistence is `lensStore` → tugbank only.
- No estimated row heights.
- bun, never npm; verify with `bunx tsc --noEmit` **and** `bunx vite build` (run from `tugdeck/`); app-tests via `just app-test-changed` / `just app-test <files…>`; every new test carries `@covers`.
- No plan-step numbers or bug-history in code comments; comments state what the code does.

#### Assumptions {#assumptions}

- The `files-feature` dash has landed on `main` (verified: `tests/app-test/at0311-pdf-viewer-controls.test.ts` exists on `main`); this plan builds on that state.
- The Lens remains a singleton card (`LENS_CARD_ID` in `tugdeck/src/lib/lens-card-id.ts`); module-level selection memory remains valid.
- `TugPaneState.title` is usually `""` for ordinary panes; pane ids persist across relaunch via the deck layout blob.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Does `useBlockReorder` tolerate non-matching rows interleaved between draggable rows? (DECIDED) {#q01-reorder-interleave}

**Question:** The Cards list intermixes pane rows (draggable, matched by `selector`/`kindAttr`) with group-header rows and card subrows (not draggable, not matched). `useBlockReorder` snapshots the visible order + each element's rect from elements matching its selector — do drop-index computation and the sibling-shift animation behave when unmatched siblings sit between matched ones?

**Resolution:** DECIDED — resolved by reading `block-reorder.ts` in full during the vet pass, before any code was written. The answer has three parts, and it is **not** "polish only":

1. **Target computation is fine.** `computeTarget` walks the midpoints of matched elements only; interleaved siblings do not perturb it, and the midpoint array stays monotonic.
2. **The sibling shift is not fine across a group boundary.** `applyShift` translates only matched elements, so a header would stay nailed in place while pane rows slid past it; and `slot` (`tops[i+1] - tops[i]`) would swallow the header's height. → clamped away by [P15].
3. **A silent-abort trap exists and constrains the list's rendering mode.** `beginDrag` does `els.some(e => e === undefined) → return`: if any key from `getVisibleOrder()` has no *mounted* element, the drag dies with no error and no log. This makes `inline` load-bearing and makes it mandatory that `visibleOrder()` be derived from the rendered projection. → Spec S03.

See [P15] for the scope decision and the stated stack-subrow limitation.

#### [Q02] What fixture makes a multi-card pane in an app-test? (DECIDED) {#q02-multicard-fixture}

**Question:** App-tests need a real multi-card pane to pin the two-level rendering.

**Resolution:** DECIDED — `addCard("gallery-buttons")` seeds a 4-card stack via `GALLERY_DEFAULT_CARDS` (`tugdeck/src/components/tugways/cards/gallery-registrations.tsx`): one pane hosting `gallery-buttons`, `gallery-input`, `gallery-checkbox`, `gallery-popover`. It is available in the app-test build, lands in the Tools group, and needs zero new harness machinery (`app.dispatchControlAction` or `evalJS` against `window.__tug` — see how `at0310-file-view-open.test.ts` drives `dispatchControlAction("toggle-lens")`).

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Reorder aborts silently (unmounted row in `visibleOrder()`) | high | low | Spec S03: `inline` + projection-derived order; app-test drags a row while a group is collapsed | any drag that does nothing at all |
| Stack subrows detach from their pane row mid-drag ([P15]) | low | high (by design) | Stated limitation; drop result is correct via [P14]; follow-on recorded | user reports it as breakage rather than roughness |
| App-test churn breaks unrelated focus-walk tests | med | high | Table T03 inventories every affected test up front; run the full lens selection each UI step | any red test in the step's selection |
| Session monitor subscriptions multiply in one list | low | low | Cell code moves unchanged; the row count is the same rows that existed across two lists | typing-lag telemetry regression |
| Filter semantics over two levels surprise (pane matches vs child matches) | low | med | Spec S04 fixes the rule; bun tests pin it before any UI exists | user report of a "missing" row while filtering |

**Risk R01: Losing today's row visuals in the move** {#r01-visual-regression}

- **Risk:** The single-card rows (session monitor, file row) drift visually while being rehosted, violating the [P02] invariant.
- **Mitigation:** Move the cell renderers **verbatim** — `SessionRowContent`, `RowPhaseDot`, `RowSparkline`, `useSessionLabel`, `useSessionCreatedAtMs` and the file `FileRow` structure migrate as whole functions with only import-path and class-name changes; the pulse app-tests (at0280, at0282-pulse-two-level, at0283-pulse-typography) run unmodified as the visual regression gate for the monitor row.
- **Residual risk:** Row striping parity shifts because headers now occupy indices; addressed in Spec S05 (striping counts only non-header rows via `data-row-parity` — verify at0283-list-row-striping).

---

### Design Decisions {#design-decisions}

#### [P01] One Cards section; Sessions and Files retire; fold immediately (DECIDED) {#p01-one-cards-section}

**Decision:** The Lens converges on Cards / Snippets / Layouts. Both the Sessions and the Files sections retire in **one** step (#step-4), with the session monitor arriving as a Cards row kind in the same commit — no soak period, and no intermediate state in which the two models coexist. (The user's original staging folded Sessions in "immediately after" the Files swap; once #step-3 made the projection group-agnostic, the pause between them stopped being a seam and started being a duplicated-or-degraded Lens for one commit, so it was removed — user decision, 2026-08-01.)

**Rationale:**
- The privileged-section-vs-omnibus division is a taxonomy wart; the session monitor was always a cell renderer, not a section.
- The remaining sections are genuinely different *kinds of things*: what's open (Cards), what you can say (Snippets), how it's arranged (Layouts).

**Implications:**
- `registerSessionsSection()` and `registerFilesSection()` calls in `tugdeck/src/main.tsx` are replaced by one `registerCardsSection()`.
- `sessions-section.tsx/.css`, `sessions-data-source.ts`, `files-section.tsx/.css`, `files-data-source.ts` are deleted (their reusable internals move — see Symbol Inventory).

#### [P02] Pane-first two-level rows; a single-card pane's row IS today's row; the outline is always open (DECIDED) {#p02-pane-first-invariant}

**Decision:** The top level of the Cards list is always a *pane*. A single-card pane borrows its card's identity, name, and row rendering wholesale — no chevron, no disclosure affordance, no indent, nothing to expand. A multi-card pane renders one pane row with **all** of its cards as indented subrows, unconditionally visible — no disclosure triangle, no per-pane fold state, ever. (User invariant, emphatic, 2026-08-01.)

**Rationale:**
- The deck's data model is pane-first (`TugPaneState.cardIds` + `activeCardId`); the Lens becomes a projection of deck state rather than an interpretation.
- A folder metaphor would tax the overwhelmingly common single-card case to serve the rare stack.
- Always-open matches the Lens's standing ethos (every section renders; no hidden-sections set). A heavy stack is handled by collapsing its *group*.

**Implications:**
- The only visible difference between the two cases is that a stack occupies more lines; subrows distinguish themselves by indent alone (a CSS `padding-inline-start` on `.lens-cards-subrow`).
- Tab-sentinel ids (`settings-tab`, `help-tab`, `devtools-tab`, `permission-rules-tab`) need no special case for a different reason than this plan first assumed: they are **not registered cards at all** and never appear in a pane's `cardIds`. Each is a `TugTabBar` tab *inside* a single card's own content (see the "non-registered sentinel" comments in `settings-card.tsx`, `help-sheet.tsx`, `permission-rules-editor.tsx`, `devtools-card.tsx`). They therefore cannot reach the Cards list in any form, as subrows or otherwise. Corrected during #step-1 against the real registry.

#### [P03] Groups by kind — sessions / files / tools, fixed order, empty groups render nothing (DECIDED) {#p03-groups-by-kind}

**Decision:** Cards buckets pane rows into three groups rendered in fixed order: **Sessions**, **Files**, **Tools**. A group with no pane rows renders neither header nor body. Group order is not user-reorderable in this plan.

**Rationale:**
- Reproduces today's visual order (Sessions above Files) so the swap reads as a refinement, not an upheaval.
- Empty headers would be three lines of nothing on a fresh deck.

**Implications:** `GROUP_ORDER: readonly LensCardsGroup[] = ["sessions", "files", "tools"]` and `GROUP_TITLES` live in `cards-groups.ts`.

#### [P04] A mixed-kind multi-card pane files under its active card's group (DECIDED) {#p04-active-card-files}

**Decision:** A pane's group is `resolveLensGroup(registration of its active card)`. A mixed-kind stack therefore moves groups when the user fronts a different-kind tab.

**Rationale:**
- Same-kind stacks — the common case — never move. A mixed pane moving is unusual but *honest*: the row follows what the pane currently is. (User accepted 2026-08-01; revisit only if it proves weird in usage.)

**Implications:** The data source reads `pane.activeCardId` → card → registration → group. No stability shim, no majority vote.

#### [P05] Registrations declare their Lens home; coverage is a unit test (DECIDED) {#p05-registry-homes}

**Decision:** `CardRegistration` gains `lensGroup?: "sessions" | "files" | "tools" | "none"`. `resolveLensGroup(reg)` resolves: explicit `lensGroup` → else `category.label === "Files"` → `"files"` → else `"tools"`. The Lens card itself declares `lensGroup: "none"` (the mirror does not reflect itself — `deck-store-selectors.ts` already filters `LENS_CARD_ID` out of card counts). A unit test walks `getAllRegistrations()` after full registration and asserts every entry resolves, that only `lens` resolves to `"none"`, and pins the expected group for each known `componentId` (Table T01).

**Rationale:**
- The taxonomy already half-exists (`diff` declares `category: { label: "Files" }`); one declaration should feed both the `+` type-picker menu and the Lens.
- The `tools` fallback is semantically right — anything that is not a work artifact is an app surface — and makes coverage total by construction; the test then pins the *specific* mapping so drift is caught.

**Implications:**
- Explicit declarations added: `session` → `"sessions"` (`session-card-registration.tsx`); `text` (`text-card-registration.tsx`) and `file-view` (`file-view-card-registration.tsx`) → `"files"`; `lens` (`lens-register-card.tsx`) → `"none"`. `diff` needs nothing (category covers it). Settings/About/DevTools/gallery/hello fall to `"tools"` with no edits.

#### [P06] Group headers are cursorable cells that toggle collapse (DECIDED) {#p06-header-cells}

**Decision:** Group headers are data-source rows with `roleForIndex → "cell"` and `kindForIndex → "group-header"`, so the movement cursor reaches them in the arrow walk; `onSelect`/`onActivate` on a header row toggles that group's collapse (persisted via `lensStore`). They are **not** `role: "header"` rows.

**Rationale:**
- `TugListView`'s `"header"` role is documented inert ("an inert section divider" — `tug-list-view.tsx` docstring) and is skipped by cursor and click; the user chose focusable collapse-toggles in the arrow walk.

**Implications:**
- The header cell composes `TugListRow` (list-view-usage rule 1) with the group title, a live count, and a chevron glyph reflecting collapsed state via `data-group-collapsed` + CSS ([L06]). It composes the real row primitive — a hand-rolled header `div` is the tempting shortcut and an [L19]/[L20] violation.
- A collapsed group omits its pane/card rows from the projection but keeps its header row (that is the way back).
- **The cursor must never seed onto a header** — see [P16]. Making headers `"cell"`-role is what puts them in the arrow walk, and it is also what would let `TugListView`'s gain-seed land ⌘L on index 0. [P16] is the counterweight and is not optional.

#### [P07] One filter for the whole section; a pane matches on its own text or any subrow's (DECIDED) {#p07-one-filter}

**Decision:** The Cards band carries a single `TugFilterField` (section kind `"cards"` in `lens-filter-store`). Filtering: a pane row survives if its own match text or any of its cards' match text matches; a multi-card pane shows only its matching subrows unless the pane's own text matched (then all). Group headers survive only for groups with surviving panes. Ranking: pane rows rank by their best score within their group; clearing the query restores per-group persisted order. Reorder is disabled while filtering (existing rule, same rationale as today's sections).

**Rationale:** One field beats remembering which band to type into; the per-band fields die with their bands.

#### [P08] Per-group row order under one store key; order keys preserve today's identities (DECIDED) {#p08-row-order}

**Decision:** `lensStore` gains `cardsRowOrder: Record<"sessions" | "files" | "tools", readonly string[]>` (tugbank key `cardsRowOrder`, JSON). A pane row's **order key** is: the bound `tugSessionId` for a single-card session pane; the `cardId` for any other single-card pane; the `paneId` for a multi-card pane. Hydration seeds `cardsRowOrder` from the legacy `sessionOrder` / `textFileOrder` values when `cardsRowOrder` is absent, then never reads the legacy keys again (they stop being written; orphaned tugbank values are harmless).

**Rationale:**
- `tugSessionId` keeps a session's arranged position across close/reopen (today's behavior); `cardId` matches today's Files behavior; `paneId` is the only stable identity a stack has.
- Seeding preserves the user's existing arrangement through the swap instead of resetting it.

**Implications:**
- `LENS_KEYS` gains `CARDS_ROW_ORDER` and `CARDS_COLLAPSED_GROUPS`; `LensSnapshot`/reducer drop `sessionOrder` and `textFileOrder` as fields (hydration reads the raw legacy keys only to seed); `KIND_MIGRATIONS` gains `sessions: "cards"` and `files: "cards"` (both old section kinds fold into the new one; `resolveSectionRenderOrder`'s `seen` set already dedupes the doubled entry, and duplicate membership in `collapsedSections` is tolerated by `withMembership`).

#### [P09] Naming debt paid in full at the extraction (DECIDED) {#p09-naming-debt}

**Decision:** No legacy name survives: Table T02 is the complete rename map, executed in the step that touches each surface. (User: "We *absolutely* pay the naming debt now.")

#### [P10] The Files recents menu retires without a successor (DECIDED) {#p10-recents-retired}

**Decision:** `FilesHeaderActions` (the clock-glyph `TugPopupMenu` mirroring File ▸ Open Recent) is deleted with the Files section; the Cards section registers no `headerActions`. `lib/recent-documents.ts` and the `clear-recent-documents` / `open-file` actions are untouched (other consumers remain).

#### [P11] Card subrows are generic one-line rows; no subrow drag (DECIDED) {#p11-generic-subrows}

**Decision:** Every subrow — regardless of card kind — is one generic row: kind glyph + resolved title + trailing close box (when `card.closable`), indented, composing `TugListRow`. Activation dispatches `focus-session-card` with the subrow's `cardId`, which fronts that tab (the handler in `action-dispatch.ts` finds the hosting pane and calls `deckManager.activateCard(cardId)` inside `transferFocusForActivation`). Subrows do not participate in drag-reorder.

**Rationale:**
- A session card inside a stack rendered as a full three-line monitor would make the outline heavy; the pane row already monitors the *active* card when it is a single-card session pane, and stacked sessions are rare.
- Title resolution per kind: `text` → open-registry path basename or buffer display name (port of `files-data-source`'s resolvers); `file-view` → viewer-registry path basename; `session` → `sessionRowLabel` when a binding exists in `cardSessionBindingStore`, else `card.title`; everything else → `card.title || registration.defaultMeta.title`.

#### [P12] The multi-card pane row: identity, slot picker, no close box (DECIDED) {#p12-stack-pane-row}

**Decision:** A multi-card pane row shows: a kind glyph for its active card, a title (`pane.title` when non-empty, else the active card's resolved title), a muted trailing tab count (e.g. `4 tabs`), and the `SlotPicker` (keyed on the active card's id — `assign-slot` takes a `cardId` and the slot resolution walks to its hosting pane, see `slot-picker.tsx`). It carries **no** close box; per-card close lives on the subrows. Single-card pane rows keep exactly the close/dot semantics their kind has today.

**Rationale:** Placement is pane geometry, so the picker belongs to the pane row; a one-click pane-wide close on a stack is a heavier gesture than this list should offer.

#### [P13] No session dedupe — the mirror shows every pane (DECIDED) {#p13-no-dedupe}

**Decision:** Today's Sessions section dedupes by `tugSessionId` (`buildSessionRows` — first bound card wins). Cards does not: if one session is bound to cards in two panes, two pane rows render.

**Rationale:** The canvas has two panes; the mirror says so. Dedupe was an artifact of the session-centric section; the Cards section is pane-centric by [P02].

**Implications:** Two rows sharing a `tugSessionId` share an order key; the ordering sort is stable (rank ties break by projection index), so both rows stay adjacent-stable. Acceptable for a rare case.

#### [P14] Reorder commits re-bucket by group (DECIDED) {#p14-reorder-rebucket}

**Decision:** The reorder `commit` receives the new flat visible order of pane-row order keys and decomposes it: each key is assigned to its **known** group (from the pre-drag projection), preserving relative order within that group; `lensStore.setCardsRowOrder(group, keys)` is written for the dragged row's group (others unchanged). A row dropped visually inside a foreign group therefore still orders within its own group by relative position — forgiving, and correct regardless of what the mid-drag preview showed.

#### [P15] Drags are clamped to the dragged row's own group; a stack's subrows do not travel with it (DECIDED) {#p15-drag-scope}

**Decision:** The section clamps the reorder's target index to the contiguous run of pane rows belonging to the dragged row's own group, so a drag never crosses a group header. Within a group, a **multi-card pane row travels alone** — its subrows stay put for the duration of the carry and snap into place at the drop. This is a stated limitation, not a defect to chase in this phase.

**Rationale (measured against `block-reorder.ts`, not assumed):**
- `beginDrag` builds its element map from `container.querySelectorAll(selector)` — only *matched* elements. `applyShift` therefore translates only pane rows: an unmatched sibling (a group header, a subrow) never moves. Without clamping, dragging across a boundary would slide pane rows past a header that stays nailed in place.
- `slot` is computed as `tops[dragIndex + 1] - tops[dragIndex]` — the advance between consecutive *pane rows*, which silently includes any interleaved subrow heights. Within a group that number is the right one (a stack's block genuinely occupies that much vertical space, so the gap opens correctly); across a boundary it would also swallow the header's height.
- Clamping is a few lines in the section's own `commit` / target seam and needs no change to `block-reorder.ts`, which is shared with Snippets and the section stack.

**Implications:**
- The subrow detach is visible only while carrying a *multi-card* pane row — rare, momentary, and self-correcting at drop. Recorded as a follow-on rather than hidden.
- [P14]'s re-bucketing stays regardless: clamping improves the preview, re-bucketing guarantees the result.

#### [P16] The cursor seeds onto a pane row, never a group header (DECIDED) {#p16-cursor-seed}

**Decision:** The section always passes an `initialSelectedIndex`: the remembered row (`lastSelectedRowId`) when it is still in the projection, otherwise **the index of the first pane row**. It is never left `undefined`.

**Rationale:**
- `TugListView` seeds its movement cursor on key-view gain as "`initialSelectedIndex` if cursorable, else `firstCursorableRow()`". Because [P06] makes headers `"cell"`-role, `firstCursorableRow()` is index 0 — the first group header. Left alone, every ⌘L into a fresh Lens would park the cursor on a collapse toggle instead of on a card.
- The standing rule is that ⌘L lands the keyboard cursor on a navigable Lens *item*. A header is a control, not an item.

**Implications:**
- `LensCardsDataSource` exposes `firstPaneRowIndex(): number` (−1 when the projection holds no pane row) beside `indexForId`.
- Asserted in `at0312` (fresh Lens, ⌘L, cursor is on a pane row) and in the `at0278` update.

---

### Deep Dives {#deep-dives}

#### What moves verbatim, and from where {#verbatim-moves}

The [P02] invariant is enforced by *moving*, not rewriting, the row internals:

- From `sessions-section.tsx`: `SessionRowContent` (feeds `TugSessionRow` with indicator/name/slots/intent/activity/sparkline), `RowPhaseDot`, `RowSparkline`, `useSessionLabel`, `useSessionCreatedAtMs`, `useOpenBindings`, the `OFFLINE_PHASE_INPUT` / `PHASE_VISUAL` / `NOOP_SUBSCRIBE` / `SPARKLINE_FULL_SCALE_CHARS` / `SPARKLINE_CURVE` constants, and the dot-drift comment block. These land in `cards-session-cell.tsx` unchanged except imports and the reorder-context type. The `data-session-id` attribute on the row content element **stays** (it names which session, which is not legacy naming); the row content element additionally carries the uniform `data-lens-row-id`.
- From `files-data-source.ts`: `basename`, `dirname`, `displayDir`, `displayPath`, `assignDisambiguators`, and the resolver seams (`OpenCardPathResolver` etc. — re-typed against the new row shape so bun tests can still inject). Disambiguators apply to file-kind rows only, computed over the unfiltered file group as today.
- From `files-section.tsx`: the `FileRow` structure (leading `TugIconButton` close box sending `CLOSE_TAB` **by card id** through `chain.sendToTarget` with the `hasResponder` guard, headline span with glyph + `TugLabel` title + unsaved dot + disambiguator + `SlotPicker`), `glyphForRow` (via `classifyFileKind`), and the close-box rationale comments.
- Presentation: the section passes `{...LENS_LIST_PRESENTATION}` and reuses `lens-oneline-list` row-height CSS for one-line rows; the session monitor rows keep their own height exactly as they do today (the Sessions list never used `lens-oneline-list`; per-kind row heights coexist in one `TugListView` because rows render at their real heights).

#### Focus, seed, and the responder chain {#focus-and-seed}

- The section registers one focus group (`sectionFocusGroup("cards")` = `lens-section-cards`), and **the whole list is one focus stop within it** — `TugListView` authored into a `focusGroup` is a single item-container stop, not one stop per row. So `lens-content.tsx`'s `useSeedKeyView` seeding `lens-section-cards:0` addresses *the list*, and where the cursor lands inside it is then the list's own gain-seed — which is why [P16] exists. `setSectionContent(host.focusGroup, { navigable, populated })` semantics unchanged: `navigable` = the projection has any row; `populated` = any pane row exists before the filter.
- Per-row descend scopes are `TugListView`'s: the close box registers in focus group `"lens-cards-row-actions"` at `focusOrder: 0` and the `SlotPicker` in `"lens-row-slots"` (unchanged constant), so ArrowRight descends onto close → slots exactly as at0277 pins today.
- Selection memory: one module-level `lastSelectedRowId: string | null` storing the data source's row id (replaces `lastSelectedSessionId` and `lastSelectedFileId`), mapped through `initialSelectedIndex`.

#### The band {#band}

Registered via `registerLensSection` with `kind: "cards"`, `title: "Cards"`, `filterable: true`, glyph `<LayoutGrid size={14} />` (lucide), no `headerActions` ([P10]). `collapsedSummary` renders the census from the unfiltered projection: `"3 sessions · 2 files · 1 tool"` with zero-count groups omitted, singular/plural per count, `"No cards"` when empty. Band collapse of the whole section continues through `lensStore.setCollapsed("cards", …)` / `collapsedSections` untouched.

---

### Specification {#specification}

**Spec S01: Row model and projection** {#s01-row-model}

`cards-data-source.ts` exports:

```ts
export type LensCardsGroup = "sessions" | "files" | "tools";  // from cards-groups.ts

export type CardsRow =
  | { readonly type: "group-header"; readonly group: LensCardsGroup; readonly count: number; readonly collapsed: boolean }
  | { readonly type: "pane"; readonly group: LensCardsGroup; readonly paneId: string; readonly cardId: string;          // the identity card: the pane's activeCardId
      readonly orderKey: string; readonly cardCount: number; readonly rowKind: string }                                  // rowKind drives the cell renderer
  | { readonly type: "card"; readonly group: LensCardsGroup; readonly paneId: string; readonly cardId: string; readonly active: boolean };
```

`buildCardsRows(inputs, resolvers)` is pure. Inputs: `deck: DeckState | null`, `cardsRowOrder`, `collapsedGroups`, `filterQuery`, registry-version / open-registry-version / name-tag-version tokens. Projection algorithm:

1. For each pane in `deck.panes` except the Lens pane (`findLensPane` from `deck-store-selectors.ts`): resolve the active card, its registration, its group ([P04]/[P05]). Skip panes whose active card resolves to `"none"`.
2. Bucket panes by group; within each group, sort by `cardsRowOrder[group]` rank with unranked panes trailing in deck order (the exact stable-sort rule `buildFilesRows` uses today).
3. Emit per group in `GROUP_ORDER`: nothing if the bucket is empty; else one `group-header` row; if the group is not collapsed, each pane row, and for panes with `cardIds.length > 1`, one `card` row per card in `cardIds` order.
4. `rowKind` for a pane row: `"session-pane"` when the identity card's group resolution came from a `session` registration; `"file-pane"` for `text` / `file-view` / `diff`; `"tool-pane"` otherwise; multi-card panes always `"stack-pane"`. `kindForIndex` returns `"group-header"`, the pane `rowKind`, or `"subcard"`. `roleForIndex` returns `"cell"` for every row ([P06]).
5. Filtering per [P07] runs before the header/collapse emission so counts and header survival reflect matches.

Match text per row (Spec S04 details): session panes → `sessionRowLabel`; file panes → title + `displayDir(dirname(path))`; tool panes and subrows → resolved title; stack panes → own title + every child's match text.

**Spec S02: Group resolution** {#s02-group-resolution}

`cards-groups.ts` exports `resolveLensGroup(reg: CardRegistration): LensCardsGroup | "none"`:

```
explicit reg.lensGroup  →  it
reg.category?.label === "Files"  →  "files"
otherwise  →  "tools"
```

plus `GROUP_ORDER` and `GROUP_TITLES` ([P03]). `CardRegistration.lensGroup` is added in `card-registry.ts` with a doc comment naming this resolver as the single consumer.

**Spec S03: Reorder seam** {#s03-reorder-seam}

`useBlockReorder` options for the section: `selector: '.lens-cards-row[data-lens-row-id]'`, `kindAttr: "data-lens-row-id"`, `getVisibleOrder: () => dataSource.visibleOrder()`, `commit: (order) => …` re-bucketing per [P14], target clamped per [P15]. The drag is armed only from pane rows (`onRowPointerDown` handed via cell context, as both retired sections do today) and never while filtering.

Two non-negotiable constraints, both from `beginDrag`'s `els.some(e => e === undefined) → return` guard — a drag whose key set does not resolve 1:1 to *mounted* elements aborts silently, with no error and no log:

- **The list renders `inline`.** `TugListView` windows by default and unmounts off-screen rows; a windowed Cards list would have working reorder above the fold and dead-on-arrival reorder below it, with nothing in the console to say why. Both retired sections already pass `inline`, so this is continuity, not a new cost. It is worth stating that this deliberately accepts the primitive's "a consumer that may grow unboundedly stays windowed" guidance: the unbounded case here is a 89-tab gallery stack, which is debug-only and whose group collapses.
- **`visibleOrder()` is derived from the rendered projection**, not from the underlying pane set — it returns the order keys of exactly the pane rows the projection emitted, in emission order. Collapsed groups emit no pane rows, so their keys are absent and the guard stays satisfied. Deriving it from anything else (e.g. all panes in the deck) would make every drag abort silently while any group was collapsed.

**Spec S04: Filter semantics** {#s04-filter}

Uses `filterAndRank` (`lib/text-match.ts`) per group over pane rows with each pane's match-text array = its own fields plus children's. Subrow survival: children re-tested individually with `filterMatchScore`-based matching; if none match but the pane matched on its own fields, all children show. `renderFilterHighlight` paints pane-row titles only against the exact displayed string (list-view-usage rule 3).

**Spec S05: DOM vocabulary** {#s05-dom-vocabulary}

See Table T02. Additional attributes: the list root `.lens-cards-list`; every pane row content element carries `data-lens-row-id="<orderKey>"` and `data-lens-row-group="<group>"`; subrows `.lens-cards-subrow` with `data-lens-card-id="<cardId>"` (NOT `data-card-id` — that attribute belongs to card hosts; a Lens row carrying it would hijack `[data-card-id="…"]` queries, the exact trap `files-section.tsx` documents); headers `.lens-cards-header` with `data-lens-group` and `data-group-collapsed`. Striping: keep `{...LENS_LIST_PRESENTATION}`; `data-row-parity` comes from the primitive.

#### State Zone Mapping (tugdeck/tugways plans) {#state-zone-mapping}

| State | Zone | Mechanism | Law |
|-------|------|-----------|-----|
| Per-group pane order (`cardsRowOrder`) | structure, persisted | `lensStore` reducer + tugbank; React via `useSyncExternalStore` | [L02], [L23] |
| Collapsed groups (`cardsCollapsedGroups`) | structure, persisted | `lensStore` reducer + tugbank | [L02], [L23] |
| Header chevron / collapsed look | appearance | `data-group-collapsed` attribute + CSS | [L06] |
| Filter query (kind `"cards"`) | local-data, transient | `lens-filter-store` module store | [L02] |
| Row projection | derived | `LensCardsDataSource` ([L02] store), notify from `useLayoutEffect` | [L02], [L03] |
| Cursor / selection | structure | `TugListView` + FocusManager | [L22], [L24] |
| Selection memory (`lastSelectedRowId`) | local-data, session-scoped | module-level variable (existing pattern in both retired sections) | — |
| Drag preview | appearance | `useBlockReorder` inline transforms + `data-dragging` | [L06] |
| Subrow indent | appearance | CSS on `.lens-cards-subrow` | [L06] |

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tugdeck/src/components/lens/sections/cards-groups.ts` | `LensCardsGroup`, `resolveLensGroup`, `GROUP_ORDER`, `GROUP_TITLES` (Spec S02) |
| `tugdeck/src/components/lens/sections/__tests__/cards-groups.test.ts` | Coverage test over `getAllRegistrations()` + Table T01 pins |
| `tugdeck/src/components/lens/sections/cards-data-source.ts` | Pure projection (Spec S01), `LensCardsDataSource`, `useLensCardsDataSource` |
| `tugdeck/src/components/lens/sections/__tests__/cards-data-source.test.ts` | bun tests for the projection, filtering, ordering |
| `tugdeck/src/components/lens/sections/cards-section.tsx` | The section: band registration, cell renderers, delegate, reorder |
| `tugdeck/src/components/lens/sections/cards-session-cell.tsx` | The session monitor cell, moved verbatim (#verbatim-moves) |
| `tugdeck/src/components/lens/sections/cards-section.css` | Section styles incl. `.lens-cards-subrow` indent, header chrome |
| `tests/app-test/at0312-lens-cards-two-level.test.ts` | The two-level / groups / header-toggle app-test |

#### Files deleted {#files-deleted}

`sessions-section.tsx`, `sessions-section.css`, `sessions-data-source.ts`, `files-section.tsx`, `files-section.css`, `files-data-source.ts` (all under `tugdeck/src/components/lens/sections/`), plus `sections/__tests__/files-data-source.test.ts` (superseded by `cards-data-source.test.ts`, which ports its cases). Use `tugutil file rm`.

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `CardRegistration.lensGroup` | field | `tugdeck/src/card-registry.ts` | `"sessions" \| "files" \| "tools" \| "none"`, optional |
| `lensGroup` declarations | field values | `session-card-registration.tsx`, `text-card-registration.tsx`, `file-view-card-registration.tsx`, `lens-register-card.tsx` | per [P05] |
| `LENS_KEYS.CARDS_ROW_ORDER`, `LENS_KEYS.CARDS_COLLAPSED_GROUPS` | consts | `tugdeck/src/lib/lens-store/types.ts` | replaces `SESSION_ORDER` / `TEXT_FILE_ORDER` as written keys (legacy consts stay for hydration seeding) |
| `LensSnapshot.cardsRowOrder`, `.collapsedCardGroups` | fields | `types.ts` / `reducer.ts` | `sessionOrder` / `textFileOrder` fields removed |
| `set_cards_row_order`, `set_cards_group_collapsed` | reducer events | `reducer.ts` | reference-stable per group list |
| `lensStore.setCardsRowOrder(group, order)`, `.setCardGroupCollapsed(group, collapsed)` | methods | `lens-store.ts` | persist via `putJson` |
| hydration seeding | logic | `lens-store.ts` `_hydrateFromTugbank` | seed `cardsRowOrder` from legacy keys when absent ([P08]) |
| `KIND_MIGRATIONS` | const | `lens-store.ts` | add `sessions: "cards"`, `files: "cards"` |
| `registerCardsSection` | fn | `cards-section.tsx` | called from `main.tsx` replacing the two retired calls |
| icon resolution for `defaultMeta.icon` | reuse | `tug-tab-bar.tsx` | the tab bar already maps lucide icon-name strings; export/reuse its resolver for tool pane-row glyphs, else fall back to a `Wrench` glyph |

---

**Table T01: componentId → Lens group (the coverage pins)** {#t01-group-inventory}

| componentId | Group | Via |
|---|---|---|
| `session` | sessions | explicit `lensGroup` |
| `text`, `file-view` | files | explicit `lensGroup` |
| `diff` | files | `category.label === "Files"` |
| `settings`, `about`, `devtools`, `hello` | tools | fallback |
| every `gallery-*` | tools | fallback |
| `lens` | none | explicit `lensGroup` |

**Table T02: rename map (complete — nothing legacy survives)** {#t02-rename-map}

| Legacy | New |
|---|---|
| `.lens-text-files-list` | `.lens-cards-list` |
| `.text-files-row` | `.lens-cards-row` |
| `data-text-card-id` | `data-lens-row-id` (uniform pane-row identity) |
| `.text-files-row-close` | `.lens-cards-row-close` |
| `.text-files-row-glyph` | `.lens-cards-row-glyph` |
| `.text-files-row-headline` | `.lens-cards-row-headline` |
| `.text-files-row-where` | `.lens-cards-row-where` |
| `.text-files-row-unsaved` / `[data-testid="lens-text-file-unsaved"]` | `.lens-cards-row-unsaved` / `[data-testid="lens-card-unsaved"]` |
| `[data-testid="lens-text-file-where"]` | `[data-testid="lens-card-where"]` |
| `.text-files-list-wrap` / `.text-files-section` / `.text-files-empty` | `.lens-cards-list-wrap` / `.lens-cards-section` / `.lens-cards-empty` |
| `[data-testid="lens-text-files-empty"]` / `[data-testid="lens-sessions-empty"]` | `[data-testid="lens-cards-empty"]` |
| `lensStore.textFileOrder` / `.sessionOrder` | `lensStore.cardsRowOrder` ([P08]) |
| `ROW_ACTION_FOCUS_GROUP = "lens-text-file-row-actions"` | `"lens-cards-row-actions"` |
| `.sessions-list-wrap` / `.sessions-section` / `.lens-sessions-list` | folded into the Cards list (`.lens-cards-list-wrap` etc.) |
| `scrollKey: "lens-text-files"` / `"lens-sessions"` | `"lens-cards"` |
| section kinds `"sessions"`, `"files"` | `"cards"` (via `KIND_MIGRATIONS`) |

Kept deliberately: `.session-row-content[data-session-id]` (names which session — semantic, not legacy), `lens-row-slots`, `lens-oneline-list`, `lens-section-empty`.

**Table T03: app-test impact** {#t03-app-test-impact}

| Test | What it pins | Expected change |
|---|---|---|
| `at0257-lens-session-reorder` | session row drag → `sessionOrder` | selectors keep `data-session-id`; persistence assertion reads `cardsRowOrder.sessions` out of the one record |
| `at0266-lens-filter` | per-section filter fields | Scenarios A–E drive the *Snippets* band and are untouched. **Scenario F had to be rebuilt**, not merely re-pointed: it asserted that an *empty* filterable band disables its field, using the Files band, which this run left empty by seeding no text files. The Cards band mirrors the whole deck, so it is populated for as long as any card is open — and this test seeds a `gallery-accordion`. F is now the same rule observed as a **transition**: assert the field live, close the last card through its Lens row's close box, assert it goes disabled and unregistered. Stronger than the original, since it also catches a field that latches live once populated |
| `at0269-lens-text-file-dirty-dot` | unsaved dot testid | testid rename (T02), **and the file itself renamed** to `at0269-lens-card-dirty-dot.test.ts` — the old vocabulary survived in the filename, which [P09] does not allow and the Success Criteria sweep catches |
| `at0277-lens-row-accessories-keyboard` | ArrowRight descend: close → slots | class renames only; behavior identical |
| `at0278-lens-cmdl-focus-stability` | ⌘L seed + memory | the list is one focus stop; the cursor inside it seeds to the first **pane row** ([P16]). Add an assertion that it is a pane row and not a group header |
| `at0280-local-model-absent`, `at0282-pulse-two-level`, `at0283-pulse-typography` | monitor row content/typography | The R01 gate held: all three needed only the section-wrapper selector rename (`.lens-sessions-list` → `.lens-cards-list`) that this row's own rule permits, and `at0283-pulse-typography` needed nothing at all. `at0282` and `at0283` pass. **`at0280` fails, and fails identically on `main`** — a pre-existing defect, verified by running it on the base checkout: it times out after 10s waiting for `nativeType`d text to reach the composer, in its strip phase, before it ever looks at the Lens. Out of scope for this plan; recorded rather than absorbed |
| `at0283-list-row-striping` | `data-row-parity` bands | verify parity behavior with header cells interleaved |
| `at0287-lens-row-action-not-a-pick` | close box ≠ row pick | class renames |
| ~~`at0296-lens-row-is-the-handle`~~ | — | **NOT affected.** It matches `.snippet-row-content[data-snippet-id]` — a Snippets test. Verify green, change nothing |
| ~~`at0248-lens-list-cursor-keys`~~ | — | **NOT affected.** It matches `.lens-content .lens-snippets-list` — a Snippets test. Verify green, change nothing |
| `at0297-lens-empty-label-row-height` | empty-face row height | testid rename, plus a real selector fix: `ROW_CELL` took the list's FIRST cell, which is now the Files group header, so it measured a header instead of a file row. Scoped with `:has(.lens-cards-row-headline)`. `ROW_TITLE` had the same hazard (headers carry `.tug-list-row-title` too) and was scoped through `.lens-cards-row-headline` here, in `at0269`, and in `at0310` |
| `at0310-file-view-open` | Lens row for a viewer card | selector renames (its `ROW_TITLE`/`ROW_CLOSE`/`ROW_GLYPH`/`UNSAVED_DOT` constants) |
| `at0231/0233/0246/0247/0250/0252/0256` | Lens focus walks / section reorder | the section census drops to three (cards / snippets / layouts); re-derive expected Tab-walk stops; section-reorder tests that enumerate band kinds update their kind lists. Audit each before editing — several are Snippets- or Layouts-driven and need nothing |
| NEW `at0312-lens-cards-two-level` | [P02]/[P03]/[P06]/[P16] | see #step-4 |

`@covers` housekeeping: every updated test's `@covers` lines must point at the new file names (`cards-section.tsx`, `cards-data-source.ts`, `cards-groups.ts`); `just app-test-covers-check` gates this.

---

### Documentation Plan {#documentation-plan}

- [ ] `tuglaws/list-view-usage.md` consumer inventory: replace the "lens Sessions" and "lens Text Files" rows with "lens Cards" (cell models: monitor row, file row, generic subrow, header cell), same selection column ("none, cursor only").
- [ ] `tuglaws/app-test-inventory.md`: update entries for renamed/rewritten tests; add `at0312`.

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit (bun)** | `resolveLensGroup` coverage; `buildCardsRows` projection: grouping, [P04] filing, ordering, filtering, collapse omission, disambiguators, subrow emission | Steps 1–3 |
| **Unit (bun)** | `lens-store` reducer events, hydration seeding, `KIND_MIGRATIONS` folding | Step 2 (extends existing `__tests__/{reducer,migration,persistence}.test.ts`) |
| **Integration (app-test)** | Real-app rendering, keyboard walk, header toggles, reorder persistence, filter | Step 4 |
| **Drift Prevention** | Coverage test (T01 pins); rg-based naming sweep in checkpoints | Steps 1, 4, 5 |

#### What stays out of tests {#test-non-goals}

- jsdom render tests of the section — banned pattern; the app-tests drive the real app.
- Mock-store assertions of `lensStore` writes from UI gestures — covered by app-test persistence assertions against the real store.
- Per-pixel monitor-row visuals — already pinned by the existing pulse app-tests, which run unmodified as the regression gate (R01).

---

### Execution Steps {#execution-steps}

> **Commit after all checkpoints pass.** Commits go on the dash worktree via `tugutil dash commit`. Name touched tuglaws in each commit body. Run `bunx tsc --noEmit` and `bunx vite build` from `tugdeck/` in every checkpoint.

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Registrations declare their Lens group | done | `400228581` |
| #step-2 | lensStore: cardsRowOrder + collapsed groups + migrations | done | `5b9a84e52` |
| #step-3 | cards-data-source: the pure two-level projection | done | `865a67dcc` |
| #step-4 | The Cards section replaces Sessions and Files | done | `d940ddf5d` |
| #step-5 | Docs, naming sweep, and integration verification | done | `4bcbc2cdc` |

#### Step 1: Registrations declare their Lens group {#step-1}

**Commit:** `tugdeck(lens-cards): registrations declare their Lens group`

**References:** [P05] Registry homes, Spec S02, Table T01, (#context, #s02-group-resolution)

**Artifacts:**
- `cards-groups.ts` (Spec S02), `lensGroup` field on `CardRegistration`, explicit declarations on `session` / `text` / `file-view` / `lens`, coverage unit test.

**Tasks:**
- [ ] Add `lensGroup?: "sessions" | "files" | "tools" | "none"` to `CardRegistration` in `tugdeck/src/card-registry.ts` with a doc comment naming `resolveLensGroup` as the consumer.
- [ ] Create `cards-groups.ts` with `LensCardsGroup`, `resolveLensGroup`, `GROUP_ORDER`, `GROUP_TITLES`.
- [ ] Declare `lensGroup` per [P05] implications (four registration sites; `diff` intentionally undeclared — the category path must be exercised).
- [ ] Write `__tests__/cards-groups.test.ts`: import the registration entry points (the same modules `main.tsx` imports for `registerSessionCard` etc., plus `gallery-registrations`), register everything, then assert the Table T01 pins and the totality property (every registration resolves; only `lens` → `"none"`).

**Tests:**
- [ ] `bun test cards-groups` green with the T01 table asserted row by row.

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bunx vite build && bun test`

---

#### Step 2: lensStore — cardsRowOrder, collapsed groups, migrations {#step-2}

**Depends on:** #step-1

**Commit:** `tugdeck(lens-cards): lensStore learns per-group card order and group collapse`

**References:** [P08] Row order, [P01] fold sequencing, Spec S01 (inputs), (#s01-row-model, #state-zone-mapping)

**Artifacts:**
- New `LENS_KEYS`, snapshot fields, reducer events, store methods, hydration seeding; extended unit tests.

**Two tasks moved to #step-4 (discovered while implementing, 2026-08-01):** this step is *additive only*. Removing the `sessionOrder` / `textFileOrder` snapshot fields and store methods here would break `tsc` outright — `sessions-section.tsx` and `files-data-source.ts` are live consumers until #step-4 deletes them. And adding the `sessions: "cards"` / `files: "cards"` `KIND_MIGRATIONS` entries here would be worse than a build break: it would silently rewrite the two *still-registered* sections' persisted order and collapse state to a `"cards"` kind that does not yet exist, losing the user's arrangement for two commits and re-persisting the damage. Both belong in the commit that retires their consumers.

**Tasks:**
- [ ] `types.ts`: add `CARDS_ROW_ORDER: "cardsRowOrder"`, `CARDS_COLLAPSED_GROUPS: "cardsCollapsedGroups"`; add `cardsRowOrder: Readonly<Record<LensCardsGroup, readonly string[]>>` and `collapsedCardGroups: readonly string[]` to `LensSnapshot`; **remove** the `sessionOrder` / `textFileOrder` snapshot fields and their `LENS_KEYS` doc claims (keep the legacy key-name string constants, marked hydration-seed-only).
- [ ] `reducer.ts`: state fields, `set_cards_row_order` / `set_cards_group_collapsed` events, `hydrate` extension; preserve reference stability per group list (return same record when a group's list is `listsEqual`).
- [ ] `lens-store.ts`: read/write the new keys in `_hydrateFromTugbank` / `_persistDiff`; add `setCardsRowOrder` / `setCardGroupCollapsed`; implement seeding — when the `cardsRowOrder` tugbank key is absent and legacy `sessionOrder` / `textFileOrder` values exist, hydrate `{ sessions: sessionOrder ?? [], files: textFileOrder ?? [], tools: [] }` (persist happens naturally on the next mutation); stop writing the legacy keys; add `sessions: "cards"`, `files: "cards"` to `KIND_MIGRATIONS`.
- [ ] Add a JSON-record reader beside `readStringArray` (reject-and-keep on malformed, per the hydrate discipline documented there).

**Tests:**
- [ ] Extend `lib/lens-store/__tests__/reducer.test.ts` (events, stability), `migration.test.ts` (seeding cases: fresh install, legacy-only, both present → new wins; `sessions`+`files` → `cards` folding with dedupe), `persistence.test.ts` (new keys written, legacy keys never written).

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bun test lens-store`
- [ ] `bunx vite build`

---

#### Step 3: cards-data-source — the pure two-level projection {#step-3}

**Depends on:** #step-1, #step-2

**Commit:** `tugdeck(lens-cards): pane-first grouped projection with filter and per-group order`

**References:** [P02] Pane-first, [P03] Groups, [P04] Active-card filing, [P07] Filter, [P08] Order keys, [P11] Subrows, [P13] No dedupe, Spec S01, Spec S04, (#s01-row-model, #s04-filter, #verbatim-moves)

**Artifacts:**
- `cards-data-source.ts` + `__tests__/cards-data-source.test.ts`.

**Tasks:**
- [ ] Implement `buildCardsRows` per Spec S01, with resolver seams for testability (path/display-name/unsaved/view-path resolvers ported from `files-data-source.ts`; a bindings map for session labels; a registration lookup seam so bun tests need no real registry).
- [ ] Port `basename` / `dirname` / `displayDir` / `displayPath` / `assignDisambiguators` (disambiguators over the unfiltered file-group pane rows only).
- [ ] Implement `LensCardsDataSource` (the `TugListViewDataSource` shape both retired sources use: `setInputsWithoutNotify` diffing, `notifyAll`, `rowAt`, `idForIndex`, `kindForIndex`, `roleForIndex` = `"cell"`, `isFiltering`, `unfilteredCount`, `visibleOrder()` = flat pane order keys, `censusByGroup()` for the collapsed summary) and `useLensCardsDataSource` (deck store + both open registries + binding store + name/tag versions + `lensStore` orders/collapse + filter query as inputs, layout-effect notify).
- [ ] Row ids: `pane:<paneId>` / `card:<cardId>` / `header:<group>` — stable, non-colliding.

**Tests (port every `files-data-source.test.ts` case, then add):**
- [ ] Single-card pane → exactly one row, no subrows ([P02]).
- [ ] Multi-card pane → pane row + N subrows in `cardIds` order, present regardless of any state ([P02] always-open).
- [ ] Mixed-kind pane files under active card's group; switching `activeCardId` in the input moves it ([P04]).
- [ ] Empty group → no header; collapsed group → header only, `count` correct ([P03]/[P06]).
- [ ] Order: ranked keys first, unranked trail in deck order; session panes keyed by `tugSessionId`, stacks by `paneId` ([P08]).
- [ ] Filter: child match keeps pane + matching children; pane-own match keeps all children; headers vanish with their groups; clearing restores order ([P07]).
- [ ] Two panes, one session → two rows ([P13]).
- [ ] Lens pane excluded.

**Checkpoint:**
- [ ] `cd tugdeck && bun test cards-data-source && bunx tsc --noEmit && bunx vite build`

---

#### Step 4: The Cards section replaces Sessions and Files {#step-4}

**Depends on:** #step-3

**Commit:** `tugdeck(lens-cards): one Cards section replaces Sessions and Files — pane-first rows, groups, header toggles`

**References:** [P01] One Cards section, [P02] Invariant, [P06] Header cells, [P09] Naming debt, [P10] Recents retired, [P11] Subrows, [P12] Stack row, [P13] No dedupe, [P14] Rebucket, [P15] Drag scope, [P16] Cursor seed, [Q01] (resolved), [Q02], Spec S03, Spec S05, Risk R01, Tables T02–T03, (#band, #focus-and-seed, #verbatim-moves)

**Why this is one step and not two:** after #step-3 the projection is group-agnostic — it already emits all three groups — so "Cards renders files + tools" and "Cards renders sessions too" is one piece of work, not two. Every way of pausing between them is worse than not pausing: leaving the old Sessions section registered renders every session twice at once, unregistering it early drops the monitor row (pulse lines, sparkline) for a commit, and gating the group is throwaway scaffolding. The intermediate state has no good version, so it does not exist. The app-test update volume is identical either way.

**Artifacts:**
- `cards-section.tsx`, `cards-session-cell.tsx`, `cards-section.css`; `files-section.*`, `files-data-source.ts`, `sessions-section.*`, `sessions-data-source.ts` deleted; `main.tsx` swap; updated app-tests; new `at0312`.

**Tasks:**
- [ ] Read `tuglaws/tuglaws.md`, `tuglaws/list-view-usage.md`, and `tuglaws/focus-language.md` before writing UI. (`block-reorder.ts` is already characterized — see [Q01]'s resolution and [P15]; no re-derivation needed.)
- [ ] Move the session monitor cell per #verbatim-moves into `cards-session-cell.tsx` — a verbatim move (imports and the reorder-context type are the only edits), which is what makes the pulse app-tests a valid unmodified regression gate (R01).
- [ ] Build `cards-section.tsx` with all five cell renderers at their final form: `group-header` (TugListRow: title + count + chevron via `data-group-collapsed`, activation toggles `setCardGroupCollapsed`), `session-pane` (the moved monitor cell), `file-pane` (the moved `FileRow`, renamed classes per T02), `tool-pane` (icon-resolved glyph + title + close when closable + `SlotPicker`), `stack-pane` ([P12]), `subcard` ([P11], indented, `focus-session-card` on activate, close box when closable).
- [ ] Wire the section: delegate = activate-and-remember; `initialSelectedIndex` per [P16]; `inline` + projection-derived `visibleOrder()` + group-clamped target per Spec S03 / [P15]; band registration per #band with the full census summary; `setSectionContent` per #focus-and-seed.
- [ ] The session pane row carries `data-lens-row-id` (= `tugSessionId`) alongside the kept `data-session-id`, so reorder flows through the uniform selector.
- [ ] `main.tsx`: replace both `registerSessionsSection()` and `registerFilesSection()` with a single `registerCardsSection()`; drop both imports.
- [ ] Delete `files-section.tsx/.css`, `files-data-source.ts`, `sections/__tests__/files-data-source.test.ts`, `sessions-section.tsx/.css`, `sessions-data-source.ts` via `tugutil file rm`; the recents menu goes with them ([P10]).
- [ ] Execute the whole of Table T02.
- [ ] Update the T03 tests: `at0257` (persistence → `cardsRowOrder.sessions`), `at0266` (add one Cards-filter scenario; its Snippets scenarios A–F are untouched), `at0269`, `at0277`, `at0278` ([P16]: the cursor seeds to a pane row, not a header), `at0287`, `at0297`, `at0310`, `at0283-list-row-striping`, and the focus-walk set (`at0231/0233/0246/0247/0250/0252/0256`) for the three-section census — auditing each before editing, since several are Snippets- or Layouts-driven and need nothing. `@covers` lines throughout.
- [ ] Run `at0280` / `at0282-pulse-two-level` / `at0283-pulse-typography` **unmodified first** — they are the R01 visual gate. Touch them only if a section-wrapper selector fails, and call out any diff in the commit body.
- [ ] Write `at0312-lens-cards-two-level.test.ts` (`@covers` `cards-section.tsx`, `cards-data-source.ts`, `cards-groups.ts`): open two files (single-card pane rows: assert **no** subrows, no fold affordance, close box + slot picker present — the [P02] invariant); `addCard("gallery-buttons")` ([Q02]) → assert Tools header + one `stack-pane` row + 4 subrows visible with zero interaction; activate a subrow → the pane's `activeCardId` changes; ⌘L into a fresh Lens → the cursor is on a **pane row**, not a group header ([P16]); cursor onto the Tools header via arrows, Enter → its pane and subrows disappear, count stays on the header; Enter again → back; drag a pane row while another group is collapsed → the drag actually engages and commits (the Spec S03 silent-abort guard); persistence assert via `lensStore` snapshot through `evalJS`.

**Tests:**
- [x] `at0312` green. `at0257` green 3/3. `at0287`, `at0297`, `at0310`, `at0269` green. R01 gate: `at0282` and `at0283-pulse-typography` green (the latter wholly unmodified).
- [ ] **Six tests could not be run in this environment, and fail identically on `main`**: `at0266`, `at0277`, `at0278`, `at0248`, `at0283-list-row-striping`, `at0296` all time out on `document.hasFocus()` before their first Lens assertion, and `at0280` times out waiting for `nativeType`d text to reach the composer. Both classes were reproduced on the base checkout, so neither is this phase's doing. The consequence to state plainly: the selector renames in `at0277` / `at0278` / `at0283-list-row-striping` and the rebuilt scenario F in `at0266` are **unverified** — they typecheck and the covers-check resolves them, but no run has exercised them. Re-verify when the focus-mode issue is fixed.

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bunx vite build && bun test`
- [ ] `just app-test-covers-check`
- [ ] `just app-test-changed` (or explicitly: the T03 set + `at0312`)
- [ ] `rg -n "text-files|lens-text-file|data-text-card-id|textFileOrder|sessionOrder|sessions-section|lens-sessions" tugdeck/src tests/app-test` → only `lens-store` hydration seeding and its migration tests remain.
- [ ] The Lens shows exactly three bands: Cards, Snippets, Layouts.

---

#### Step 5: Docs, naming sweep, and integration verification {#step-5}

**Depends on:** #step-4

**Commit:** `tugdeck(lens-cards): list-view and app-test doctrine updated for the Cards section`

**References:** [P01], [P09], Success Criteria, Documentation Plan, (#success-criteria, #documentation-plan, #t02-rename-map)

**Tasks:**
- [ ] `tuglaws/list-view-usage.md` consumer inventory rows per Documentation Plan.
- [ ] `tuglaws/app-test-inventory.md` entries for changed tests + `at0312`.
- [ ] Run the full Success Criteria list one by one, including the rg naming sweep, in the real app (`just` debug instance) and via app-tests.
- [ ] Author the dash join draft (`/tugplug:draft` style) summarizing the section swap for the user's `/join`.

**Tests:**
- [ ] `just app-test` (core tier) if any step's changes touched pre-assertion surfaces; otherwise #step-4's `app-test-changed` selection re-run green.

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bunx vite build && bun test`
- [ ] `just app-test-covers-check`
- [ ] Every Success Criteria checkbox verifiable and verified.

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** The Lens reads **Cards / Snippets / Layouts**: one pane-first, group-by-kind mirror of the deck canvas in which a single-card pane's row is exactly today's row, a multi-card pane discloses nothing (its outline is simply always there), every registered card type has a provable Lens home, and no legacy `text-files`/`sessions`-section name survives anywhere.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] All Success Criteria pass (each names its verification).
- [ ] Steps 1–5 committed on the dash; Step Status Ledger fully `done` with commit hashes.
- [ ] `bunx tsc --noEmit`, `bunx vite build`, `bun test`, `just app-test-covers-check`, and the accumulated app-test selection all green at the final commit.

**Acceptance tests:**
- [ ] `at0312-lens-cards-two-level` (new).
- [ ] The updated T03 set, with the pulse trio as the unmodified visual-regression gate.

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] "By Canvas" arrangement and sort controls for the Cards section (the M4 the pane-first model was chosen to enable).
- [ ] Subrow drag-reorder (Lens-side tab reordering) if pane stacks become common.
- [ ] Carry a stack's subrows with their pane row during a drag ([P15]'s stated limitation). Needs `block-reorder` to learn about grouped elements, which is why it is not in this phase.
- [ ] Revisit [P04] if mixed-kind pane group-hopping proves weird in real usage.
- [ ] A successor to the retired recents affordance, if its absence is ever felt ([P10]).

| Checkpoint | Verification |
|------------|--------------|
| Registry coverage is a property | `bun test cards-groups` |
| Projection is law | `bun test cards-data-source` |
| The invariant holds in the real app | `at0312` single-card-pane assertions |
| Naming debt is zero | the rg sweeps in #step-4 / #step-5 checkpoints |
