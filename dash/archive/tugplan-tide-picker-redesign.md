<!-- tugplan-skeleton v2 -->

## Tide Picker Redesign — Header Support, Filter Primitive, and TugListView-Driven Sheet {#tide-picker-redesign}

**Purpose:** Replace the Tide card's project-picker sheet with a single `TugListView`-driven surface, after first lifting two `TugListView` capabilities — header/footer cells (deferred from [tugplan-tug-list-view.md §Q04](./archive/tugplan-tug-list-view.md#q04-headers-footers)) and a reusable filter wrapper (modeled on UIKit's `UISearchController` projecting a filtered data source into `UITableView`) — into the primitive itself.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-05-07 |
| Predecessor | [tugplan-tug-list-view.md](./archive/tugplan-tug-list-view.md) (TugListView v1) |
| Related | [tugplan-tide-card-polish.md](./tugplan-tide-card-polish.md) |

---

### Phase Overview {#phase-overview}

#### Context {#context}

The Tide card's project-picker sheet (`TideProjectPickerForm` in `tugdeck/src/components/tugways/cards/tide-card.tsx`) stacks four input idioms in one form: a `TugInput` for the project path, a column of `TugPushButton emphasis="ghost"` buttons for recent paths, a `TugRadioGroup` for "Start fresh" + existing sessions, and Cancel/Open. Two interactive lists are fused into the form (path list and session list), and they share the typed-path state silently — clicking a recent re-keys `useSessionLedger(trimmedPath)` and the radio group's content swaps under the user. There is no architectural seam between path discovery and session selection.

`TugPushButton` bakes `text-transform: uppercase` into its base style (`tug-push-button.css:4`). The recents column renders Unix paths *through* that button — turning `/Users/Ken/projects/foo` into `/USERS/KEN/PROJECTS/FOO`. Unix paths are case-sensitive; an all-caps treatment is wrong both as a presentation of arbitrary user data and as a categorical fact about paths.

`TugListView` (the UIKit-`UITableView`-shaped windowed list primitive shipped via [tugplan-tug-list-view.md](./archive/tugplan-tug-list-view.md)) is already the host for the Tide transcript. It is a single-section flat list ([tugplan-tug-list-view.md §D02](./archive/tugplan-tug-list-view.md#d02-single-section)) with no header/footer support ([§Q04](./archive/tugplan-tug-list-view.md#q04-headers-footers), explicitly deferred) and no filter affordance. The picker rewrite needs both: section dividers (`RECENTS`, `SESSIONS`) and a filter over recents driven by the path input.

This plan unifies that work in three phases: Phase 0 lifts header/footer support into the primitive; Phase 1 ships a reusable filter wrapper; Phase 2 rewrites the picker on top of both. The first two phases stand alone — they leave the door open for any future consumer that wants list sections or filtered enumerations — and Phase 2 consumes them to land the user-visible UX change.

#### Strategy {#strategy}

- **Primitive first.** Phase 0 and Phase 1 are pure primitive enhancements with no consumer migration. Each ships standalone tests and a gallery card before any consumer takes a dependency. Landing the picker rewrite first would shape the primitive APIs around one consumer's accidental needs.
- **Headers via row roles, not full sections.** The picker needs section *dividers*, not multi-section enumeration. Phase 0 adds an optional `roleForIndex(index): "cell" | "header" | "footer"` to the data source — flat-list-shape preserved, additive, no breaking change to existing consumers. Full UITableView-style sections (`numberOfSections`, IndexPath shape) remain a separate future enhancement — see [D02].
- **Filter as data-source decorator.** Phase 1's `useFilteredDataSource` is a wrapper around a base `TugListViewDataSource`, not a prop on `TugListView`. UIKit's `UISearchController`/`UITableView` split is the model: the table doesn't filter; a separate object projects a filtered data source the table consumes. The host owns the search input — see [D01].
- **Picker rows use a fixed seven-kind vocabulary.** Three optional sections (RECENTS / SESSIONS / PENDING) over seven kinds. The vocabulary is enumerated in [Spec S01](#s01-row-vocabulary) so cell renderers, tests, and the data source can reference it without restating the matrix.
- **Select-then-Open uniformly except for navigation/destructive rows.** Session rows are *selectable choices*; path-recent rows are *navigation actions*; forget-all is a *destructive action*. The selection idiom matches the row's semantics rather than forcing one click model across categories — see [D03], [D04], [D05].
- **One commit per step.** Build stays green at every step (`bun run check`, `bun test`, `bun run audit:tokens lint`, `cargo nextest run`). `-D warnings` enforced.
- **Tuglaws apply.** Every step that touches React state, registrations, or DOM appearance re-checks against [tuglaws.md](../tuglaws/tuglaws.md). The closing step records the walkthrough.
- **No new persistence.** Recents stay on tugbank's `dev.tugtool.tide / recent-projects`; the ledger stays on `TideSessionLedgerStore`. No new IndexedDB. Per [tide.md §D-T3-10](./tide.md#decisions-t3).
- **All-caps fix is structural, not stylistic.** Phase 2 sidesteps `TugPushButton`'s baked-in `text-transform: uppercase` by replacing the recents-as-buttons column with `TugListView` cells. No change to `tug-push-button.css` — see [D08].

#### Success Criteria (Measurable) {#success-criteria}

**Phase 0 — Header/footer support:**
- `TugListViewDataSource` accepts an optional `roleForIndex(index): "cell" | "header" | "footer"`. Defaults to `"cell"` when omitted. (verification: typecheck + unit tests)
- Cells whose role is `"header"` or `"footer"` render with `data-list-cell-role` set to that value on the cell wrapper. They are not focusable (`tabIndex={-1}`), do not fire `delegate.onSelect`, and are skipped by any list-view-internal keyboard navigation. (verification: unit tests + DOM assertion)
- The transcript (`TideTranscriptDataSource`) and the existing gallery list view continue to render with no behavioral change. (verification: existing tests pass; manual smoke)
- A new gallery card demonstrates a flat list with header and footer kinds rendering as visually distinct rows. (verification: manual)

**Phase 1 — Filter primitive:**
- `useFilteredDataSource(base, predicate, filterToken)` exists in `tugdeck/src/components/tugways/use-filtered-data-source.ts` and returns a `TugListViewDataSource` whose enumeration is `base` filtered by `predicate(baseIndex, base)`. (verification: typecheck + tests)
- The wrapper subscribes to the base via `subscribe`, ticks listeners on every base change AND on `filterToken` identity changes, and exposes `baseIndexFor(filteredIndex)` for typed cell-renderer access. (verification: tests)
- `getVersion()` returns a value whose identity changes only on actual state changes — `Object.is`-stable across no-change calls per [L02]. (verification: tests)
- A gallery card demonstrates filtering against a `TugInput` substring query. (verification: manual)

**Phase 2 — Picker rewrite:**
- `TideProjectPickerForm` mounts a single `TugListView` against a `TidePickerDataSource` composite. The recents-as-buttons column and the `TugRadioGroup` are deleted from the picker form. (verification: `rg 'TugPushButton' tugdeck/src/components/tugways/cards/tide-card.tsx` returns no matches inside `TideProjectPickerForm`; `rg 'TugRadioGroup\|TugRadioItem' tugdeck/src/components/tugways/cards/tide-card.tsx` returns zero matches)
- Recent paths render with original case preserved. (verification: manual)
- The picker emits exactly the seven kinds in [Spec S01](#s01-row-vocabulary) across the three optional sections. (verification: data-source unit tests + manual)
- Open submits per [Spec S02](#s02-open-semantics). (verification: tests + manual)
- `path-recent` click fills the input via `setPath(recent)`; the list re-enumerates to SESSIONS once the ledger settles. (verification: manual)
- Default selection on first SESSIONS render is `{ kind: "session-new" }`. (verification: tests)
- Live `session-resume` rows render disabled with a `live` badge; failed rows render selectable with a `failed` badge. (verification: tests + manual)
- ArrowUp/ArrowDown moves selection across selectable rows, skipping headers, loading, path-recents, forget-all, and live session-resumes. (verification: tests + manual)
- The picker notice banner, retry callback, per-row Forget icon, inline confirm panel, and forget-all flow survive the rewrite unchanged. (verification: tests + manual)
- Cancel via Esc or button cascades CLOSE through the responder chain per [#cancel-cascade]. (verification: tests + manual)

**Compliance:**
- `bun run check`, `bun test`, `bun run audit:tokens lint`, `cargo nextest run` pass at every commit.
- `-D warnings` enforced.
- Component authoring guide checklist passes for every new file.
- No new IndexedDB dependencies introduced.

#### Scope {#scope}

1. Optional `roleForIndex` on `TugListViewDataSource` and the corresponding behavior in `TugListView` (focus / selection / data attribute).
2. `useFilteredDataSource` wrapper helper plus tests and a gallery card.
3. `TidePickerDataSource` composite adapter that enumerates seven cell kinds across three sections.
4. Replacement of the recents-as-buttons column and the `TugRadioGroup` inside the picker sheet.
5. Cell renderers for each new kind, scoped under `tide-card.css` per [L20].
6. Picker-owned arrow-key navigation across selectable rows.
7. Tests for the role contract, the filter wrapper, the picker data source, and the rewritten form.
8. Two new gallery cards (header/footer demo, filter demo).

#### Non-goals (Explicitly out of scope) {#non-goals}

- **Master/detail (split-pane) picker layout.** Held in reserve for a future phase if recents grow beyond ~15 entries with metadata.
- **Removing the global `TugPushButton` uppercase rule.** The redesign sidesteps it; touching the rule is a separate decision.
- **Server-side recents filtering.** The wrapper supports it via a different base data source, but the picker's recents stay client-side.
- **Full UITableView-style sections.** `numberOfSections`, `numberOfItemsInSection`, `IndexPath`-shaped data sources, sticky section headers — none of these land in this plan. Header/footer cells (Phase 0) are the smaller additive shape that solves the picker's need; full sections remain a future enhancement per [tugplan-tug-list-view.md §roadmap](./archive/tugplan-tug-list-view.md#roadmap).
- **Multi-select in the list view.** Consumer-owned single-selection covers the picker.
- **Keyboard arrow nav inside `TugListView` itself.** The picker handles its own arrow keys — see [D10]. A primitive enhancement would be a separate plan.
- **Search-input chrome inside `TugListView`.** The host owns the input per [D01] / `UISearchController` split.

#### Dependencies / Prerequisites {#dependencies}

- `TugListView` v1 from [tugplan-tug-list-view.md](./archive/tugplan-tug-list-view.md) (shipped).
- `TideSessionLedgerStore` (`tugdeck/src/lib/tide-session-ledger-store.ts`) — already the picker's session source.
- `useTugbankValue` for `dev.tugtool.tide / recent-projects` — already the picker's recents source.
- `TugInput`, `TugSheet`, `useTugSheet`, `useResponderForm`, `TugPushButton` (action-button usage retained), `TugBadge`, `Trash2` icon — all in current use.

#### Constraints {#constraints}

- `-D warnings` build policy ([CLAUDE.md `Build Policy`](../CLAUDE.md)).
- [L02] external state via `useSyncExternalStore` only.
- [L03] event-dependent registrations in `useLayoutEffect`.
- [L06] appearance changes via CSS / DOM, never React state.
- [L11] action vocabulary for any chain-routed dispatch.
- [L19] component authoring guide for any new exported primitive surface.
- [L20] component-token sovereignty — consumer overrides via cascade-scoped selectors.
- [L23] `data-tug-scroll-key` for scroll-position survival across DOM-down transitions.

#### Assumptions {#assumptions}

- Recents fits in memory and remains short (typically <20 paths). The composite data source can filter eagerly without windowing pressure.
- The path input's value is treated as a single concept ("the project path the user is choosing") — no separate "search query" mode. Recents matching is a typeahead side effect of typing a path. (Confirmed in design discussion.)
- Existing `TideTranscriptDataSource` and `GalleryListViewDataSource` will not opt into `roleForIndex` initially; the optional default keeps them unchanged.
- The session ledger store's snapshot shape is stable; the composite consumes its existing `SessionRow[]` typing.

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

This plan follows tugplan-skeleton v2. Anchors are explicit and stable; design decisions and open questions are labeled `[D01]`, `[Q01]`, etc.; execution steps cite plan artifacts on `**References:**` lines.

---

### Open Questions {#open-questions}

> All five open questions raised during design were resolved before authoring. They are recorded here for traceability.

#### [Q01] Section header treatment in the picker (RESOLVED → Phase 0 + [D02]) {#q01-section-headers}

**Question:** Section headers (`RECENTS`, `SESSIONS`) needed muted, non-uppercased treatment, but `TugListView` had no header concept. Render via plain `<div role="presentation">` cells with consumer-scoped CSS, reuse `TugLabel`, or lift into the primitive?

**Resolution:** RESOLVED — lift into the primitive. Phase 0 adds optional `roleForIndex` to `TugListViewDataSource` so headers (and footers) become a first-class capability. The picker uses it; future consumers reuse it. See [D02].

---

#### [Q02] Path truncation direction for `path-recent` (RESOLVED → [D07]) {#q02-path-truncation}

**Question:** Long paths (`/Users/Ken/Mounts/u/src/tugtool`) overflow the cell. Truncate at the end (default `text-overflow: ellipsis`) or at the start (preserves the project name's tail)?

**Resolution:** RESOLVED — truncate at the start, macOS Finder path-popup style. The meaningful tail (project name) stays visible; the prefix elides. See [D07].

---

#### [Q03] Default selection on first SESSIONS render (RESOLVED → [D06]) {#q03-default-selection}

**Question:** When SESSIONS becomes visible, auto-select `session-new`, or leave selection `null` and rely on Open's null-fallback rule?

**Resolution:** RESOLVED — auto-select `{ kind: "session-new" }`. Makes the keyboard-Enter path unambiguous; matches the user's most likely intent. See [D06].

---

#### [Q04] Wrapper + gallery commit grouping (RESOLVED → [D09]) {#q04-wrapper-gallery-grouping}

**Question:** Land the filter wrapper and its gallery card in one commit (gallery is the manual smoke for the wrapper) or split them?

**Resolution:** RESOLVED — split. Smaller commits per step is the house style; the test suite is the gate, not the gallery card. See [D09].

---

#### [Q05] Keyboard arrow navigation across picker rows (RESOLVED → [D10]) {#q05-keyboard-arrows}

**Question:** Today's `TugRadioGroup` provides Up/Down. The replacement list view's `onSelect` only fires on Space/Enter. Build arrow-key navigation into the primitive or into the picker?

**Resolution:** RESOLVED — build into the picker. The picker has the most domain knowledge about which kinds are selectable. A primitive enhancement is a separate future plan. See [D10].

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| `roleForIndex` contract change ripples to existing consumers | low | low | Optional method with default `"cell"`; existing consumers untouched | Any existing consumer test fails after Step 1 |
| Filter wrapper miss-ticks when predicate closure changes without token | med | med | Explicit `filterToken` argument; documented contract; tests cover the case | Filter wrapper tests fail or gallery card shows stale rows |
| Picker rewrite regresses live-row gating, retry, or forget-all | high | med | Preserve existing test coverage; new tests for selection state; manual smoke checklist covers each flow | Any tide-card test fails; manual smoke surfaces dropped behavior |
| Selection state divergence from data-source enumeration | med | med | `useLayoutEffect` invalidation rule mirrors the existing `selectedRow` snap-back at `tide-card.tsx:797`; tests assert it | Selection points at a vanished session id |

**Risk R01: Existing consumer breakage from `roleForIndex` addition** {#r01-role-rollout}

- **Risk:** Adding a new method to `TugListViewDataSource` could break consumers that strictly type their adapter.
- **Mitigation:** Method is optional (`roleForIndex?(...)`). Default behavior when omitted is `"cell"`, preserving the existing single-role flat list. `TideTranscriptDataSource` and `GalleryListViewDataSource` are not touched.
- **Residual risk:** A consumer that adds `roleForIndex` returning anything other than `"cell"`/`"header"`/`"footer"` triggers a runtime assert; the type narrows it to those three at compile time.

**Risk R02: Filter wrapper subtle update bug** {#r02-filter-staleness}

- **Risk:** A predicate closure that captures stale state could keep filtering against old values if the `filterToken` doesn't change identity.
- **Mitigation:** The hook's contract requires the consumer to pass a `filterToken` whose identity changes whenever predicate semantics change. JSDoc spells out the contract; tests cover it.
- **Residual risk:** A consumer that passes a stable token while the predicate's closure mutates will see stale results. Caught only by manual review or an end-to-end test.

**Risk R03: Picker rewrite UX regression** {#r03-picker-regression}

- **Risk:** The rewrite removes radio-group ergonomics (Up/Down nav, `value`-attribute Backspace dispatch, the inline confirm panel's plumbing).
- **Mitigation:** Preserve all current test cases; build arrow-key nav into Step 9 (per [D10]); reuse the inline confirm panel verbatim.
- **Residual risk:** A flow that's tested only manually (Backspace-to-forget on a focused row) could regress silently. The rewrite step's manual smoke checklist covers it.

---

### Design Decisions {#design-decisions}

#### [D01] Filter is a data-source decorator, not a TugListView prop (DECIDED) {#d01-uitableview-search-split}

**Decision:** `TugListView` does not gain a `filterPredicate` prop or own a search field. Filtering ships as `useFilteredDataSource(base, predicate, filterToken)`, a hook that returns a wrapped `TugListViewDataSource` projecting only indices that pass the predicate. The host owns the input.

**Rationale:**
- UIKit's split is the model: `UITableView` doesn't filter; `UISearchController` projects a filtered data source the table consumes.
- The primitive's `numberOfItems` / `idForIndex` / `kindForIndex` contract stays the single source of truth — a `filterPredicate` prop would split that truth across two places.
- Wrappers compose: a future `useSortedDataSource` / `useGroupedDataSource` can stack without growing TugListView's prop surface.
- Server-side filtering becomes possible without primitive change: a consumer who wants the server to filter just builds a different base data source.

**Implications:**
- Cell renderers that need typed access to the base data source's extension methods (e.g. `TideTranscriptDataSource.rowAt`) call `wrapper.baseIndexFor(p.index)` and route through the base.
- The picker's case is simple enough that the composite data source absorbs filter logic internally without using the wrapper — see [D12].

---

#### [D02] Header/footer support via row roles, not full sections (DECIDED) {#d02-role-flat-list}

**Decision:** Phase 0 adds `roleForIndex?(index: number): "cell" | "header" | "footer"` to `TugListViewDataSource`. Cells whose role is `"header"` or `"footer"` render a `data-list-cell-role` attribute on the wrapper, are not focusable (`tabIndex={-1}`), do not fire `delegate.onSelect`, and are skipped by list-view-internal keyboard navigation. Full UITableView-style sections (`numberOfSections`, IndexPath shape, sticky headers) remain deferred.

**Rationale:**
- The picker — the immediate consumer — needs section *dividers*, not multi-section enumeration. Roles solve that with one optional method.
- Full sections add real complexity (height index keyed by section, section-folding, sticky headers, IndexPath-aware imperative API). None earns its place yet, per [tugplan-tug-list-view.md §D02](./archive/tugplan-tug-list-view.md#d02-single-section).
- An optional method preserves the existing single-section flat-list contract. No existing consumer is forced to adapt.
- Migrating to full sections later is additive: `numberOfSections` becomes the new method, IndexPath becomes the new shape, the existing role concept becomes per-section header/footer renderers.

**Implications:**
- Cell renderers for header/footer kinds don't need to know about the role themselves — the primitive sets `tabIndex={-1}` and the data attribute. The renderer paints what it wants.
- CSS uses `[data-list-cell-role="header"]` for visual treatment via the consumer's cascade-scoped selectors per [L20].
- Lifts the resolved status of [tugplan-tug-list-view.md §Q04](./archive/tugplan-tug-list-view.md#q04-headers-footers) from "deferred" to "shipped via roles."

---

#### [D03] Select-then-Open for session rows (DECIDED) {#d03-select-then-open}

**Decision:** The picker's session rows (`session-new`, `session-resume`) are *selectable choices*; the trailing Open button consumes the current selection. There is no click-to-open shortcut on session rows.

**Rationale:**
- More forgiving for accidental misclicks. A misclicked row can be re-clicked (or arrow-keyed past) without an irreversible side effect.
- Matches the `TugRadioGroup` ergonomics the rewrite replaces — no change in user model.
- Keeps the Open button always meaningful; users learn one terminal action.

**Implications:**
- Selection state lives in the consumer (`useState`) per [Q06]/[D03] of the TugListView plan. The primitive does not store selection.
- Open with no selection submits `(query, "new", new uuid)` per [Spec S02](#s02-open-semantics). Same outcome as Open-on-`session-new`.

---

#### [D04] `path-recent` rows are click-to-navigate (DECIDED) {#d04-path-recent-navigation}

**Decision:** Clicking a `path-recent` row fills the path input (`setPath(recent)`); the list re-enumerates to show SESSIONS for that path. The recent does NOT become the current selection.

**Rationale:**
- A recent is a *route* into the session-choice screen, not a session choice itself.
- Forces the user through the explicit Start-fresh / Resume choice, preserving the existing UX guarantee that every spawn flows through that decision.
- Matches the user's stated instinct: "single click = navigate (fills input, list flips to sessions)."

**Implications:**
- Worst case is two clicks to open a brand-new project (recent → Start fresh OR Open-with-no-selection).
- Selectable kinds are exactly `session-new` and non-live `session-resume`; arrow-key nav skips path-recents.

---

#### [D05] `forget-all` is a direct destructive action (DECIDED) {#d05-forget-all-direct}

**Decision:** Clicking the `forget-all` row opens the inline confirmation panel (the existing `pendingForget` flow). It does NOT take selection.

**Rationale:**
- Destructive actions should not piggy-back on Open. Pretending the row is "selected" then making the user click Open to forget would be unsafe.
- Preserves the existing two-screen confirm gesture without nested overlays.

**Implications:**
- The cell renderer's `onClick` fires `onRequestForgetAll()`; the form's render branch swaps to the confirm panel exactly as today.

---

#### [D06] Default selection is `session-new` on first SESSIONS render (DECIDED) {#d06-auto-select-session-new}

**Decision:** When SESSIONS becomes visible, selection auto-defaults to `{ kind: "session-new" }`. When SESSIONS goes from hidden to visible, the same default applies. When SESSIONS is hidden (no path / pending / no rows), selection is `null`.

**Rationale:**
- Makes Enter / Open immediately meaningful — the user can always commit without an extra click.
- Matches the most common intent: "open this project, fresh."
- Mirrors the existing `selectedRow = "new"` default in the radio-group form (`tide-card.tsx:740`).

**Implications:**
- The selection-invalidation rule (when a `session-resume` row vanishes) snaps back to `session-new`, not `null`.
- The Open-with-null-selection rule still applies for the brief window where the user has typed a path before the ledger has settled.

---

#### [D07] Path truncation is macOS Finder ellipsis-at-start (DECIDED) {#d07-finder-style-truncation}

**Decision:** `path-recent` cells truncate long paths from the start (ellipsis on the leading edge), preserving the meaningful tail (project name) — matching macOS Finder path popups.

**Rationale:**
- The project name is the discriminator; the prefix is mostly identical across recents (`/Users/Ken/...`).
- Native macOS pattern; user familiarity is high.

**Implications:**
- Implemented via `direction: rtl` + `text-overflow: ellipsis` + Unicode bidirectional override (`unicode-bidi: plaintext`) on the cell's text element. (`unicode-bidi: plaintext` keeps the Latin path text logically left-to-right while the container's RTL direction trips the truncation onto the leading edge.)
- The full path is set on `title` for hover tooltip and `aria-label` for screen readers.

---

#### [D08] All-caps fix is structural, not stylistic (DECIDED) {#d08-structural-allcaps-fix}

**Decision:** The picker's all-caps recents bug is fixed by replacing `TugPushButton` with `TugListView` cells. The global `text-transform: uppercase` rule on `.tug-push-button` is left untouched. Cancel and Open buttons inside `tug-sheet-actions` remain `TugPushButton` instances.

**Rationale:**
- Smallest blast radius. Touching `tug-push-button.css` ripples through every push-button in the app.
- The all-caps treatment is correct for short command labels (Cancel, Open, Submit) and wrong for content-bearing buttons. The redesign separates those two uses.

**Implications:**
- Future cases of "user content rendered through TugPushButton" need to be moved off the primitive too, OR the primitive grows an opt-out (deferred to a separate decision).

---

#### [D09] Filter wrapper and gallery card land in separate commits (DECIDED) {#d09-wrapper-and-gallery-separate}

**Decision:** `useFilteredDataSource` (Phase 1, Step 4) and its gallery card (Phase 1, Step 5) are separate commits.

**Rationale:**
- Smaller commits per step is the house style.
- The test suite is the gate; the gallery is manual smoke.
- A reviewer can validate the wrapper without scrolling through a gallery card.

**Implications:**
- Step 5 depends on Step 4's surfaces being shipped; the dependency is recorded on the step's `Depends on:` line.

---

#### [D10] Picker owns arrow-key navigation, not the primitive (DECIDED) {#d10-picker-owns-arrows}

**Decision:** ArrowUp/ArrowDown navigation across selectable rows is implemented in `TideProjectPickerForm`'s keydown handler in Phase 2, Step 9. `TugListView` does not gain built-in arrow nav.

**Rationale:**
- The picker has the most domain knowledge: which kinds are selectable, how to skip non-live `session-resume` rows, how to wrap.
- A primitive-level arrow-nav feature would need to take a "selectability predicate" or read selection state — both consumer concerns.
- Sized to a single picker step.

**Implications:**
- The picker reads `dataSource.kindForIndex(i)` and `dataSource.rowAt(i)` to decide selectability when stepping.
- A future primitive enhancement (built-in arrow nav with a selectability predicate) is a separate plan.

---

#### [D11] Notice banner stays outside the list view (DECIDED) {#d11-notice-outside-list}

**Decision:** The picker's notice banner (`PickerNotice`) and Retry button render *above* `TugListView`, not as a list row.

**Rationale:**
- The notice has its own copy and a Retry button; it doesn't fit any of the seven row kinds.
- Keeping it outside preserves the notice's prominence — it shouldn't scroll with the list.

**Implications:**
- The retry callback (`onRetryRestore`) survives untouched.
- The notice's CSS (`.tide-card-picker-notice`, `.tide-card-picker-notice-actions`) is unchanged.

---

#### [D12] Picker uses internal eager filter for recents (DECIDED) {#d12-picker-eager-filter}

**Decision:** `TidePickerDataSource` filters recents internally (eager substring match against `query`) rather than stacking `useFilteredDataSource` over a recents-only base data source. `useFilteredDataSource` remains the canonical reusable pattern documented in the gallery card.

**Rationale:**
- Recents are typically <20 items. The windowing benefit of a wrapper is zero at that scale.
- The composite already needs to consume both recents and sessions; threading recents through a wrapper adds an indirection without benefit.
- The wrapper's existence justifies its own tests and gallery; the picker's choice is a documented exception based on data shape, not a vote against the wrapper.

**Implications:**
- A future consumer with a larger filterable list reaches for `useFilteredDataSource` directly.
- The picker's data source can be migrated to the wrapper later if recents grow without changing its public surface.

---

#### [D13] Filter matcher is a shared utility, default case-insensitive substring (DECIDED) {#d13-shared-text-matcher}

**Decision:** Filter matching for the picker, the gallery filter card, and any future small-list consumer goes through `caseInsensitiveSubstring()` in `tugdeck/src/lib/text-match.ts`. The matcher returns a `MatchResult { score?: number; matches: ReadonlyArray<[number, number]> }` whose match ranges drive `<mark>` highlight rendering in the cell. Case-insensitive is the default; case-sensitive matching is not currently exposed (a follow-on decision if a consumer earns it). A scored fuzzy variant (`fuzzyMatch`) is deferred to its own follow-on.

**Rationale:**
- Filesystem case-sensitivity does not dictate typeahead case-sensitivity. Users typing into a search box expect to find `Tugtool` when they type `tugtool` — independent of how the filesystem disambiguates.
- A shared matcher unifies the look-and-feel of every filter surface in the app at the level of "what does the highlight cover" — consumers don't roll their own substring/lowercase combinations and produce subtly different UX.
- Server-side fuzzy (the `fuzzy_scorer.rs` route file completion uses) is the right shape for project-scale candidate sets where a wire round-trip is cheaper than walking thousands of paths in JavaScript. It is the wrong shape for ≤ 50 recents — which is the picker's and the gallery card's load. Hence: client-side matcher for short lists, server-side fuzzy for big ones.
- Returning `MatchResult` shape (with optional `score`) keeps the door open for fuzzy parity later: cell renderers paint highlights identically; only the predicate and the optional sort-by-score change.

**Implications:**
- The picker's `path-recent` rows highlight their matched span ([Spec S01]). The gallery filter card's path rows do the same.
- Consumers that want case-sensitive matching write their own predicate against the wrapper (the primitive doesn't enforce a matcher).
- A future `fuzzyMatch(query, target): MatchResult | null` lands in `text-match.ts` when a short-list consumer wants fzf-feel scored matches; cell renderers don't change because the return shape is the same.

---

#### [D14] Per-cell floating surfaces are an anti-pattern (DECIDED) {#d14-no-per-cell-popovers}

**Decision:** A `TugListView` cell renderer must not mount its own popover, alert, sheet, or context menu. Confirmation flows for in-list row actions are owned by the responder *above* the list (typically the form), with a single floating surface that anchors to the requesting row at request time.

**Rationale:**
- Per-cell floating surfaces register N parallel responders with overlapping lifetimes. When a row unmounts on confirm-action, the popover's cleanup cascade (Radix portal teardown, `useServicePopupBinding` listener removal, focus restoration) collides with the row's React-tree unmount. Symptoms in the wild: leaked document listeners, indeterminate DOM focus, controls that go dead after a single use.
- The chain (`tuglaws/responder-chain.md` §The three principals, §First responder) expects responder lifetimes to track *semantic boundaries* — an editor, a card, a sheet. "One responder per virtualized list row" is not a semantic boundary; it's an accidental one tied to viewport position and data identity.
- The picker's pre-Step-9.5 implementation is the case study. Per-row `TugConfirmPopover` instances on each session row produce a structurally fragile interaction even after the chain-pollution fix (DISMISS_POPOVER instead of CANCEL_DIALOG in `TugPopover.handleOpenChange`). The popover lifecycle is not the problem; *N popover lifecycles in cells that recycle* is.

**Implications:**
- Step 9.5 refactors the picker to hoist the confirmation popover to the form responder, anchored via a `data-session-id` lookup at render time.
- This rule joins the anti-patterns list in `tuglaws/responder-chain.md` §Anti-patterns alongside "Callback props for user interactions" and "Per-component keyboard listeners."

---

#### [D15] TugConfirmPopover gains a controlled-mode API (DECIDED) {#d15-tug-confirm-popover-controlled}

**Decision:** `TugConfirmPopover` adds a controlled-mode props API (`open`, `anchorEl`, `onConfirm`, `onCancel`) alongside its existing imperative `ref.confirm() → Promise<boolean>` API. The controlled API becomes the primary surface for new consumers; the Promise API stays for legacy callers but is no longer the recommended shape.

**Rationale:**
- The imperative Promise API is what forces consumers into the [D14] anti-pattern. Each caller mounts its own popover and `await`s a per-instance promise, so confirmation lifecycle is necessarily local to the caller — exactly what produces N popovers per list.
- A controlled API lets a single popover instance serve N rows: the form holds `pendingForgetSessionId: string | null`, the popover is rendered open when that's non-null, and its anchor target is derived from the same id. One instance, repositioned by the responder, is the chain-aligned shape.
- The controlled API also threads cleanly through the responder model: the popover is now a render-time *consequence* of form state (driven by a chain action handler), not an imperative side effect inside a click handler.

**Implications:**
- New props on `TugConfirmPopover`: `open?: boolean`, `anchorEl?: HTMLElement | null`, `onConfirm?: () => void`, `onCancel?: () => void`.
- When `open` is provided, the inner `TugPopover` is driven controlled-mode (`open` + `onOpenChange` round-trip). When `open` is omitted, the imperative path is in effect.
- Anchoring: TugConfirmPopover gains a sibling render branch that uses Radix's `<Popover.Anchor>` primitive (re-exported as `<TugPopoverAnchor>` from `tug-popover.tsx`) so the popover content positions against an arbitrary `anchorEl` without needing to render it as the trigger.
- The two APIs are mutually exclusive at the call site (caller picks one).

---

#### [D16] Trailing in-list actions use TugIconButton, not raw `<button>` (DECIDED) {#d16-tug-icon-button}

**Decision:** A new `TugIconButton` primitive is introduced for trailing icon-shaped actions on `TugListView` cells (trash, more, info, etc.). It wraps `<button type="button">` with `data-tug-focus="refuse"`, `useControlDispatch()` plumbing, and standard hover/focus/active styling. Cells must not embed raw `<button>` elements.

**Rationale:**
- A raw `<button>` accepts browser focus on click (in Chrome), promotes the chain via DOM-walk, AND fires Radix-Trigger handlers when wrapped in a popover trigger — three behaviors fighting on one click event. Per `tuglaws/responder-chain.md` §Focus acceptance: *"Authoring an attribute that turns on only one half is incoherent — a button that takes browser focus but not chain promotion (or vice versa) is a bug, not a feature."*
- The picker's pre-Step-9.5 trash button hand-rolled four conflicting behaviors into a single `onClick`: `e.preventDefault()` to suppress Radix-Trigger toggle, `e.stopPropagation()` to suppress the cell wrapper's `onSelect`, `setConfirmOpen(true)` to drive React state, `confirmRef.confirm()` to open the popover imperatively. The compose pattern (`data-tug-focus="refuse"` + targeted dispatch via `useControlDispatch`) replaces all four with one bake-it-in primitive.
- Standardizing the icon-button primitive also gives us one place to apply consistent hover/focus token treatment across in-list actions.

**Implications:**
- New primitive: `TugIconButton` in `tug-icon-button.tsx` + `tug-icon-button.css`.
- Step 9.5 migrates the picker's trash button as the first consumer.
- Future in-list raw `<button>` usages are migrated as the codebase touches them; the rule lands in `component-authoring.md`.

---

#### [D17] List cell renderers are pure functions (DECIDED) {#d17-pure-renderer-rule}

**Decision:** `TugListView` cell renderers (functions matching the `TugListViewCellRenderer<…>` shape) must be pure render functions. No `useState`, `useRef`, `useEffect`, `useLayoutEffect`, `useImperativeHandle`. Cell renderers receive `(index, dataSource, kind, id)` plus React context, and return JSX. Mutable state belongs either in the data source (chain-observable, `useSyncExternalStore`-shaped) or in the responder above the list.

**Rationale:**
- Cell renderers operate inside a windowed list. Their lifecycle is tied to viewport position and data identity, both of which the consumer doesn't control. State stored in a cell can be lost on virtualization recycle, on data-source update, or on cell unmount — producing subtle, hard-to-reproduce bugs that resemble "the second click does nothing."
- The picker's pre-Step-9.5 `SessionResumeCell` violated this rule with `useState(confirmOpen)`, a `useRef<TugConfirmPopoverHandle>(null)`, and an `async` click handler whose `finally` block called `setConfirmOpen(false)` on a possibly-unmounted component. Each piece looked harmless in isolation; together they produced the leaked-listener / dead-trash bug class.
- L02 (external state via `useSyncExternalStore` only) implies state belongs in stores, not in renderers. Cells *are* renderers in the strictest sense — they should be the cleanest expression of that rule.

**Implications:**
- Step 9.5 deletes the cell-local `confirmOpen` useState, the `confirmRef`, and the `onConfirmForgetSession` callback context.
- `tuglaws/component-authoring.md` adds a "Cell renderer rules" section.
- A future lint rule in the tugdeck eslint config can enforce the constraint mechanically (out of scope for this plan, recorded in the roadmap).

---

#### [D18] Each pane owns a built-in scrim layer (DECIDED) {#d18-pane-owned-scrim}

**Decision:** Every `TugPane` carries a permanent scrim DOM element inside `.tug-pane-chrome`, default `opacity: 0`. Modal-class consumers (sheets, alerts, future modal surfaces) request the scrim via a `useTugPaneScrim()` hook that ref-counts show / hide calls; when the count is non-zero, a `data-scrim="on"` attribute on the chrome triggers the CSS transition that fades the scrim in. The scrim element is in the chrome's DOM from the moment the pane mounts and never leaves.

**Rationale:**
- The previous architecture had every modal-class surface portal a scrim wrapper into a canvas-wide overlay root and try to size it to the host pane via `getBoundingClientRect()` + `MutationObserver` choreography. That pattern is structurally incapable of guaranteeing pane scoping: anything portaled to the canvas-overlay tier sits in a single global stacking context, ABOVE every pane, so any pixel of bleed (subpixel rounding, drop-shadow extension, animation overshoot, miscalculated bounds) paints over peer panes — the source of the visual artifacts vetted at the end of Step 9.5.
- Building the scrim into the pane chrome moves the entire problem class into static CSS. The scrim element lives inside `.tug-pane-chrome`'s `overflow: hidden` clip, inside the `.tug-pane` frame's stacking context (the frame carries an inline `z-index` on its `position: absolute` rect, so it IS its own stacking context). Both the geometric clip and the stacking-context boundary are guaranteed by the chrome — bleed is structurally impossible regardless of z-index, animation interpolation, or measurement edge cases.
- A ref-counted registry handles the "two consumers want scrim simultaneously" case (e.g., sheet open + future imaginary loading-scrim). One element, multiple consumers, deterministic toggle.
- The hook reads the pane id from existing context (`TugPanePortalContext`'s chrome element). Standalone consumers (gallery previews, tests) where no pane is in scope get a no-op hook and the scrim activation silently degrades — same fallback shape as `useCanvasOverlay`, `useOptionalResponder`, etc.

**Implications:**
- New module `pane-scrim-registry.ts` owns the per-chrome ref count. Imperative `increment(chromeEl)` / `decrement(chromeEl)` mutate a `data-scrim` attribute on the chrome.
- New hook `useTugPaneScrim()` returns `{ show, hide }` callbacks. Stable identities via `useCallback` so consumers can put them in `useEffect` dep arrays without re-firing.
- `TugPane` renders one extra div inside `.tug-pane-chrome` (sibling of title bar + body). One CSS rule animates `.tug-pane-scrim` opacity based on the chrome's `[data-scrim="on"]` attribute.
- `TugSheet` (and any future modal-class surface) replaces its own scrim element with a `useTugPaneScrim()` call. The visual transition is decoupled from the panel's slide-in animation: scrim uses a CSS transition matching the panel animation's duration token (`--tug-motion-duration-moderate`), so they finish together visually without explicit synchronization.

---

#### [D19] Sheets portal into the pane frame, not canvas overlay (DECIDED) {#d19-sheet-in-pane-frame}

**Decision:** `TugSheet`'s panel + slide-in clip portal into the host pane's `.tug-pane` frame element (via a new `TugPaneFrameContext`), not into the canvas-overlay root. The frame is its own stacking context (inline z-index on `position: absolute`). The clip is positioned by pure CSS (`position: absolute; top: var(--tug-chrome-height); left: 0; right: 0; height: 100vh; overflow: hidden`) — no measurement applier, no DOM-write coords, no observers.

**Rationale:**
- Per-pane stacking is what the canvas already provides via the `.tug-pane` frame's inline z-index. Portaling sheet content into the frame means the sheet's z-index is local to the pane, and peer panes z-stacked above naturally paint above the sheet (and below) without manual coordination.
- The `.tug-pane` frame has `overflow: visible` (default), so the clip + panel can extend past the chrome's bottom edge into the canvas grid below. Where the panel extends into empty canvas, it paints visibly; where it extends into a higher-z peer pane's territory, the peer pane paints above it. Both behaviors are correct stacking — neither is bleed.
- Eliminates the canvas-overlay applier entirely: ResizeObserver + MutationObserver + window-resize all go away. Pane drag, sash resize, viewport resize all flow through the chrome's existing CSS layout naturally.
- Z-tier coordination simplifies. The `--tug-z-overlay-dialog` token isn't applied to the sheet anymore (it's at the pane's frame z-index, scoped). Popovers opened from inside the sheet still portal to canvas overlay (transient, not modal) and elevate via the existing `--tug-z-overlay-popup-in-dialog` token to stack above the panel — `TugSheetStackingContext.Provider value={true}` around the panel still drives that elevation correctly.

**Implications:**
- New `TugPaneFrameContext` exports the `.tug-pane` element from `TugPane` (alongside the existing `TugPanePortalContext` which exports `.tug-pane-chrome`). Sheets read this context for their portal target.
- `TugSheet` drops `useCanvasOverlay()`. Drops the wrapperRef + clipRef applier effect entirely (~80 lines deleted). Sheet props/contracts unchanged.
- `.tug-sheet-clip` CSS becomes `position: absolute` (in pane-frame coordinate space) instead of `position: fixed` (in viewport coordinate space). `pointer-events: none` so the empty clip area passes clicks through; the panel itself absorbs interaction via `pointer-events: auto`.
- `.tug-sheet-anchor` and `.tug-sheet-overlay` CSS rules are deleted entirely — replaced by the pane-scrim primitive ([D18]).
- Sheet panel's slide-in animation (`translateY(-100%) → 0`) and the clip's `overflow: hidden` work unchanged. Panel max-height stays constrained by `.tug-sheet-content`'s existing `max-height: calc(100% - padding)` rule and `overflow-y: auto` for tall content.
- Sheets rendered outside a `TugPane` (gallery previews, tests) where the frame context is null fall back to portaling into `document.body`, matching the existing `useCanvasOverlay` no-provider fallback shape. Production code always renders sheets inside panes.

---

#### [D20] Modal scoping is the pane stacking context, not the canvas overlay tier (DECIDED) {#d20-modal-scope-is-pane}

**Decision:** "Card-modal" surfaces (sheets, future modal-class surfaces) are scoped to a single pane via the pane's own stacking context. The canvas-overlay tier (and `useCanvasOverlay()`) remains the right portal target for transient surfaces (popovers, tooltips, context menus, the alert) but is NOT the right target for any surface that claims pane-modal semantics.

**Rationale:**
- The modal scope ("this surface blocks interaction with this thing") is a pane property — sheets are card-modal per the existing tuglaw semantics. The pane already provides a stacking-context boundary; using it as the modal scope eliminates an entire class of bugs (visual bleed, pointer-event bleed, z-index miscalculation) at the architectural level.
- Transient surfaces (popovers, tooltips) are NOT pane-modal. They are anchor-relative and may need to extend past the pane (a popover anchored to a button at the pane's edge naturally paints outside the pane). They keep their canvas-overlay portal because the relationship to the host pane is "anchored" not "scoped."
- The distinction is now explicit in the framework: the scope of a modal surface IS the pane it's hosted in, full stop. No "modal but rendered globally with measurement-based confinement" ambiguity.

**Implications:**
- `tuglaws/pane-model.md` documents this rule: pane-modal surfaces portal into the pane frame; transient surfaces portal into canvas overlay.
- `tug-alert` is a future migration candidate. Alerts are app-modal today (block ALL interaction across the canvas). They could be re-scoped to the active pane for consistency, OR remain app-modal with their own design — out of scope for this plan, but documented as a follow-on in [#roadmap].
- `tugplan-tide-overlay-framework.md` (system-level architecture for portals + responder chain + pane focus controller) gets a section update reflecting the pane-modal boundary.

---

### Specification {#specification}

#### Spec S01: Picker Row Vocabulary {#s01-row-vocabulary}

**Section ordering** (top → bottom): RECENTS, SESSIONS, PENDING. Sections are *omitted* when their visibility predicate is false. SESSIONS and PENDING are mutually exclusive on `ledger.status`.

**Cell kinds (seven):**

| Kind | Section | Role | Visibility | Click behavior |
|---|---|---|---|---|
| `header-recents`  | RECENTS  | header | filtered recents non-empty | no-op |
| `path-recent`     | RECENTS  | cell   | one per recent matching `query` via `caseInsensitiveSubstring()` from `@/lib/text-match` AND not exactly equal to `query`. (Empty `query` → all recents qualify; the matcher returns an empty `matches` array, which is intent-equivalent to "no filter active.") | `setPath(recent)`; list re-enumerates. Does NOT take selection. |
| `header-sessions` | SESSIONS | header | `ledger.status === "ready"` AND `query.length > 0` | no-op |
| `session-new`     | SESSIONS | cell   | same as above; always present in the section | becomes the current selection |
| `session-resume`  | SESSIONS | cell   | one per non-deleted ledger row | becomes the current selection unless `state === "live"` (renders disabled) |
| `forget-all`      | SESSIONS | footer | `nonLiveSessionCount > 0`; rendered after the last `session-resume` | open inline confirm panel; does NOT take selection |
| `loading`         | PENDING  | cell   | `query.length > 0` AND `ledger.status === "pending"` | no-op |

**Visual treatments:**

- `header-recents` / `header-sessions`: muted weight + small size, sentence case (`Recents`, `Sessions`). No `text-transform: uppercase`. Under `[data-list-cell-role="header"]`.
- `path-recent`: monospace family from `--tug-font-family-mono`; ellipsis-at-start truncation per [D07]; `title` and `aria-label` carry the full path. Match ranges from `caseInsensitiveSubstring(query, path)` (see [D13]) drive `<mark>` highlight rendering inside the cell so the user sees which substring satisfied the filter.
- `session-new`, `session-resume`: existing rich row layout (title + subtitle stack, optional trailing icon/badge), preserved verbatim.
- `forget-all`: rendered as a quiet footer link; `[data-list-cell-role="footer"]`.
- `loading`: subdued "checking…" placeholder; `aria-live="polite"`.
- Selected cells (`session-new` or `session-resume`) carry `data-selected="true"` for CSS-driven highlight per [L06].

#### Spec S02: Open Semantics {#s02-open-semantics}

The trailing Open button is always present. It computes its submission per the current selection:

| Selection                              | Open submits                              |
|----------------------------------------|-------------------------------------------|
| `{ kind: "session-new" }`              | `(query, "new", new uuid)`                |
| `{ kind: "session-resume"; sessionId }`| `(query, "resume", sessionId)`            |
| `null` AND `query.length > 0`          | `(query, "new", new uuid)`                |
| `null` AND `query.length === 0`        | no-op (button disabled)                   |

The defense-in-depth check in the existing `submit` (downgrade to `"new"` if the selected session id has vanished) survives unchanged.

#### Spec S03: Selection Invalidation {#s03-selection-invalidation}

- Path input changes (user typed, user clicked a recent): SESSIONS may re-enumerate; if the selected `session-resume` row no longer appears, selection snaps to `{ kind: "session-new" }` if SESSIONS is still visible, or `null` if not.
- SESSIONS goes from visible to hidden: selection becomes `null`.
- SESSIONS goes from hidden to visible: selection becomes `{ kind: "session-new" }`.

Implemented via a `useLayoutEffect` mirroring the existing snap-back at `tide-card.tsx:797`.

#### Spec S04: Cancel Cascade {#s04-cancel-cascade}

Esc / Cancel button → `close("cancel")` on the sheet → `useSheetDelegate`'s `sheetDidReturnResult` handler dispatches `TUG_ACTIONS.CLOSE` via `manager.sendToTarget(cardId, ...)` per [tide §D02](./tide.md#decisions-t3). Behavior unchanged from the current picker.

#### Spec S05: `roleForIndex` API {#s05-role-api}

```ts
// New optional method on TugListViewDataSource:
roleForIndex?(index: number): "cell" | "header" | "footer";
// Default when omitted: "cell".
```

**Behavior:**
- `"cell"` (default): existing behavior. `tabIndex={0}`; click and Space/Enter fire `delegate.onSelect`; included in any internal nav.
- `"header"` / `"footer"`: cell wrapper carries `data-list-cell-role="header"` (or `"footer"`). `tabIndex={-1}`. Click and Space/Enter do NOT fire `delegate.onSelect`. Internal keyboard nav (when added) skips the cell. Cell renderers can still attach their own `onClick` handlers for action behavior.

**Compatibility:**
- Existing data sources that omit the method get `"cell"` for every index.
- Existing tests pass without modification.

#### Spec S06: `useFilteredDataSource` API {#s06-filter-api}

```ts
export function useFilteredDataSource(
  base: TugListViewDataSource,
  predicate: (baseIndex: number, base: TugListViewDataSource) => boolean,
  filterToken: unknown,
): FilteredTugListViewDataSource;

export interface FilteredTugListViewDataSource extends TugListViewDataSource {
  /** Returns the base index for the item at the given filtered index. */
  baseIndexFor(filteredIndex: number): number;
}
```

**Contract:**
- Subscribes to `base.subscribe`; on every base tick, re-projects.
- On every `filterToken` identity change (`Object.is` compare), re-projects.
- `getVersion()` returns a value whose identity changes on either trigger; reference-stable when neither trigger fired.
- `numberOfItems()` returns the count of base indices passing `predicate`.
- `idForIndex(i)` returns `base.idForIndex(baseIndexFor(i))`.
- `kindForIndex(i)` returns `base.kindForIndex(baseIndexFor(i))`.
- `roleForIndex(i)` (when defined) returns `base.roleForIndex?.(baseIndexFor(i))`.

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tugdeck/src/components/tugways/use-filtered-data-source.ts` | `useFilteredDataSource` hook + `FilteredTugListViewDataSource` interface |
| `tugdeck/src/components/tugways/__tests__/use-filtered-data-source.test.ts` | Filter-wrapper tests |
| `tugdeck/src/lib/text-match.ts` | Shared text-matching utility (`MatchResult`, `caseInsensitiveSubstring`) per [D13] |
| `tugdeck/src/lib/__tests__/text-match.test.ts` | Text-matcher tests |
| `tugdeck/src/components/tugways/cards/gallery-list-view-headers.tsx` | Gallery card demonstrating header/footer roles |
| `tugdeck/src/components/tugways/cards/gallery-list-view-filter.tsx` | Gallery card demonstrating filter wrapper |
| `tugdeck/src/lib/tide-picker-data-source.ts` | `TidePickerDataSource` composite + `PickerRow` typed access |
| `tugdeck/src/lib/__tests__/tide-picker-data-source.test.ts` | Composite-data-source tests |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `TugListViewDataSource.roleForIndex` | optional method | `tugdeck/src/components/tugways/tug-list-view.tsx` | New optional method per [Spec S05](#s05-role-api) |
| `data-list-cell-role` attribute | DOM attribute | `tug-list-view.tsx` cell wrapper | Set when role ≠ `"cell"` |
| `useFilteredDataSource` | hook | `tugdeck/src/components/tugways/use-filtered-data-source.ts` | Per [Spec S06](#s06-filter-api) |
| `FilteredTugListViewDataSource` | interface | same | Extends `TugListViewDataSource` with `baseIndexFor` |
| `caseInsensitiveSubstring` | function | `tugdeck/src/lib/text-match.ts` | Returns `MatchResult \| null` per [D13]; UTF-16 offsets |
| `MatchResult` | interface | same | `{ score?: number; matches: ReadonlyArray<[start, end]> }` |
| `TidePickerDataSource` | class | `tugdeck/src/lib/tide-picker-data-source.ts` | Implements `TugListViewDataSource`; typed `rowAt(i): PickerRow` |
| `PickerRow` | discriminated union | same | Seven kinds per [Spec S01](#s01-row-vocabulary) |
| `useTidePickerDataSource` | hook | same | Constructs the composite from `(recents, query, ledger)` |
| `TideProjectPickerForm` | function (rewritten) | `tugdeck/src/components/tugways/cards/tide-card.tsx` | Mounts `TugListView`; replaces recents column + radio group |
| picker cell renderers | components | `tide-card.tsx` (or new sibling file) | One per kind in [Spec S01](#s01-row-vocabulary) |

#### Files to delete or trim {#files-trimmed}

| File | Change |
|------|--------|
| `tide-card.css` | Remove `.tide-card-picker-recents`, `.tide-card-picker-recents-list`, `.tide-card-picker-pending-placeholder` rules; add `.tide-card-picker-list-view` and `[data-list-cell-role]` scoped rules |
| `tide-card.tsx` (within `TideProjectPickerForm`) | Delete the `recents.length > 0` block, the `TugRadioGroup` block, the `useResponderForm({ selectValue })` block, the radio-row `useId()` |

---

### Documentation Plan {#documentation-plan}

- [ ] `tug-list-view.tsx` module docstring: add a "Row roles" subsection describing `roleForIndex` and the `data-list-cell-role` attribute.
- [ ] `tug-list-view.tsx` module docstring: add a "Filtering" subsection linking to `use-filtered-data-source.ts` and the `gallery-list-view-filter` card.
- [ ] `use-filtered-data-source.ts`: full module docstring + JSDoc on the exported hook and interface, citing [Spec S06](#s06-filter-api) and the UISearchController split rationale.
- [ ] `tide-picker-data-source.ts`: module docstring describing the three-section enumeration, citing [Spec S01](#s01-row-vocabulary).
- [ ] [tugplan-tug-list-view.md §roadmap](./archive/tugplan-tug-list-view.md#roadmap): mark "Header / footer views" as shipped via this plan; mark "Picker migration onto `TugListView`" as shipped.
- [ ] [tugplan-tug-list-view.md §Q04](./archive/tugplan-tug-list-view.md#q04-headers-footers): note that the deferred header/footer feature shipped via row roles ([D02] in this plan) rather than full sections.

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit** | Test individual functions, methods, and small components in isolation | `roleForIndex` defaulting; `useFilteredDataSource` projection logic; `TidePickerDataSource` row enumeration across input states |
| **Integration** | Test components working together | `TugListView` + role-aware cell wrappers; `TugListView` + filtered data source; `TideProjectPickerForm` end-to-end with a mocked ledger |
| **Drift Prevention** | Detect unintended behavior changes | Existing tide-card and tug-list-view tests must continue to pass without modification (Phase 0 is additive) |
| **Manual / Smoke** | Validate visual rendering and gestures | Each gallery card; the rewritten picker's main flows |

---

### Execution Steps {#execution-steps}

> Commit after all checkpoints pass. Patterns: each phase ends in an Integration Checkpoint step that depends on its constituent steps and uses `Commit: N/A (verification only)`.

#### Step 1: Phase 0 — Add `roleForIndex` to TugListView data source {#step-1}

**Commit:** `tugways(tug-list-view): add roleForIndex with header/footer behavior`

**References:** [D02] role-flat-list, [Spec S05](#s05-role-api), Risk R01, (#scope, #context, #strategy), [tugplan-tug-list-view.md §Q04](./archive/tugplan-tug-list-view.md#q04-headers-footers)

**Artifacts:**
- Edit `tugdeck/src/components/tugways/tug-list-view.tsx`:
  - Add optional `roleForIndex?(index: number): "cell" | "header" | "footer"` to `TugListViewDataSource`.
  - Read role per cell during render; default to `"cell"` when method is undefined.
  - Set `data-list-cell-role="header"` (or `"footer"`) on the cell wrapper when role ≠ `"cell"`.
  - When role ≠ `"cell"`: render with `tabIndex={-1}`; gate `delegate.onSelect` dispatch (click and Space/Enter handlers early-return).
  - Update module docstring with a "Row roles" section.
- Edit `tugdeck/src/components/tugways/__tests__/tug-list-view.test.tsx`:
  - Add cases: default role is `"cell"` for data sources without the method; `"header"` cells set the data attribute and `tabIndex={-1}`; clicking a `"header"` cell does not fire `onSelect`; existing transcript-shaped data sources are unaffected.

**Tasks:**
- [x] Add the `roleForIndex` declaration to `TugListViewDataSource`.
- [x] Thread the role through cell rendering.
- [x] Gate focus and `onSelect` on role.
- [x] Update the module docstring.
- [x] Add unit + integration tests.
- [x] Verify existing tests pass without modification.

**Tests:**
- [x] `bun test src/components/tugways/__tests__/tug-list-view.test.tsx` covers the new cases.
- [x] `bun test src/lib/__tests__/tide-transcript-data-source.test.ts` continues to pass (drift check).

**Checkpoint:**
- [x] `bun run check`
- [x] `bun test src/components/tugways/__tests__/tug-list-view.test.tsx`
- [x] `bun run audit:tokens lint`

---

#### Step 2: Phase 0 — Gallery card for header/footer roles {#step-2}

**Depends on:** #step-1

**Commit:** `tugways(gallery): add list-view headers gallery card`

**References:** [D02] role-flat-list, [Spec S05](#s05-role-api), (#success-criteria)

**Artifacts:**
- New file `tugdeck/src/components/tugways/cards/gallery-list-view-headers.tsx`: a card mounting `TugListView` over a synthetic data source that emits `[header, cell, cell, cell, footer]` (and similar permutations); cell renderers paint the kind name. Demonstrates the `data-list-cell-role` attribute is set and that headers/footers don't take focus.
- Edit `tugdeck/src/components/tugways/cards/gallery-registrations.tsx`: register the new gallery card.

**Tasks:**
- [x] Implement `GalleryListViewHeadersDataSource`.
- [x] Cell renderers for `cell`, `header`, `footer` kinds with distinct visual treatments.
- [x] Register in gallery.

**Tests:**
- [x] Manual smoke: open the gallery card; Tab through the list — focus skips header and footer cells.
- [x] Manual smoke: cells are visually distinct; the data attribute appears in DevTools.

**Checkpoint:**
- [x] `bun run check`
- [x] `bun run audit:tokens lint`
- [x] Manual: gallery card mounts, headers visually distinct, focus skips them.

---

#### Step 3: Phase 0 Integration Checkpoint {#step-3}

**Depends on:** #step-1, #step-2

**Commit:** `N/A (verification only)`

**References:** [D02] role-flat-list, (#success-criteria)

**Tasks:**
- [x] Confirm `roleForIndex` is shipped, defaults preserve existing behavior, and the gallery card demonstrates the new capability.

**Tests:**
- [x] Aggregate suite green.

**Checkpoint:**
- [x] `bun run check`
- [x] `bun test` (curated subset: TugListView primitive + its consumers — `tug-list-view.test.tsx`, `gallery-list-view-content.test.tsx`, `tide-card-transcript.test.tsx`, `tide-transcript-data-source.test.ts`. 101 pass / 0 fail / 446 ms. Full-suite run skipped per "no minutes-long runs.")
- [x] `bun run audit:tokens lint`
- [x] `cargo nextest run`

---

#### Step 4: Phase 1 — `useFilteredDataSource` helper {#step-4}

**Depends on:** #step-3

**Commit:** `tugways(tug-list-view): add useFilteredDataSource decorator hook`

**References:** [D01] uitableview-search-split, [Spec S06](#s06-filter-api), Risk R02, (#strategy)

**Artifacts:**
- New file `tugdeck/src/components/tugways/use-filtered-data-source.ts`:
  - `FilteredTugListViewDataSource` interface extending `TugListViewDataSource` with `baseIndexFor(filteredIndex): number`.
  - `useFilteredDataSource(base, predicate, filterToken)` hook returning the wrapper.
  - Internal `FilteredDataSource` class managing the `baseIndices: number[]` projection, base subscription, listener set, monotonic version counter.
  - Re-projection triggers: base tick, filterToken identity change.
  - Module docstring covering the UISearchController split rationale, the contract, and the [L02] `Object.is` version-stability requirement.
- New file `tugdeck/src/components/tugways/__tests__/use-filtered-data-source.test.ts`:
  - Empty base; all-pass; no-pass; predicate change; promotion of a previously-filtered item; drop of a previously-projected item; version-token reference stability under no change; `baseIndexFor` correctness across base reorder.

**Tasks:**
- [x] Implement the `FilteredDataSource` class.
- [x] Implement the `useFilteredDataSource` hook.
- [x] Write the module docstring.
- [x] Write the tests listed above.

**Tests:**
- [x] `bun test src/components/tugways/__tests__/use-filtered-data-source.test.ts` — all cases pass.

**Checkpoint:**
- [x] `bun run check`
- [x] `bun test src/components/tugways/__tests__/use-filtered-data-source.test.ts`
- [x] `bun run audit:tokens lint`

---

#### Step 5: Phase 1 — Gallery card for filter wrapper {#step-5}

**Depends on:** #step-4

**Commit:** `tugways(gallery): add list-view filter gallery card`

**References:** [D01] uitableview-search-split, [D09] wrapper-and-gallery-separate, [Spec S06](#s06-filter-api)

**Artifacts:**
- New file `tugdeck/src/components/tugways/cards/gallery-list-view-filter.tsx`:
  - 50-item synthetic data source.
  - `TugInput` above `TugListView`; the input's value drives a substring predicate via `useFilteredDataSource`.
  - Demonstrates host-owns-input split (input is outside the list view DOM).
- Edit `tugdeck/src/components/tugways/cards/gallery-registrations.tsx`: register the new card.
- Edit `tugdeck/src/components/tugways/tug-list-view.tsx`: add a "Filtering" subsection to the module docstring with a link to `use-filtered-data-source.ts`.

**Tasks:**
- [x] Implement the gallery card.
- [x] Register in gallery.
- [x] Update `tug-list-view.tsx` JSDoc.

**Tests:**
- [ ] Manual smoke: typing narrows the list; deleting widens it; scroll position is stable across filter changes.

**Checkpoint:**
- [x] `bun run check`
- [x] `bun run audit:tokens lint`
- [ ] Manual: filter card behaves per the smoke checklist.

---

#### Step 6: Phase 1 Integration Checkpoint {#step-6}

**Depends on:** #step-4, #step-5

**Commit:** `N/A (verification only)`

**References:** [D01] uitableview-search-split, [D09] wrapper-and-gallery-separate, (#success-criteria)

**Tasks:**
- [x] Confirm the wrapper API matches [Spec S06](#s06-filter-api), the gallery card mounts, and JSDoc cross-links resolve.

**Tests:**
- [x] Aggregate suite green.

**Checkpoint:**
- [x] `bun run check`
- [x] `bun test` (curated subset: text-match, useFilteredDataSource, tug-list-view — 120 pass / 0 fail / 168 ms. Full-suite run skipped per "no minutes-long runs.")
- [x] `bun run audit:tokens lint`
- [x] `cargo nextest run`

---

#### Step 7: Phase 2 — `TidePickerDataSource` composite {#step-7}

**Depends on:** #step-3, #step-6

**Commit:** `tide(picker): add TidePickerDataSource composite adapter`

**References:** [D02] role-flat-list, [D11] notice-outside-list, [D12] picker-eager-filter, [Spec S01](#s01-row-vocabulary), [Spec S03](#s03-selection-invalidation)

**Artifacts:**
- New file `tugdeck/src/lib/tide-picker-data-source.ts`:
  - `PickerRow` discriminated union (seven kinds).
  - `TidePickerDataSource` class implementing `TugListViewDataSource`:
    - Inputs (passed at construction or via update methods): `recents: ReadonlyArray<string>`, `query: string`, `ledger: { status: "idle" | "pending" | "ready"; rows: SessionRow[] }`.
    - Internal eager filter on recents per [D12].
    - Section-emission logic per [Spec S01](#s01-row-vocabulary).
    - `roleForIndex(i)` returns `"header"` for `header-recents` / `header-sessions`, `"footer"` for `forget-all`, `"cell"` otherwise.
    - `idForIndex(i)`: `recents:<path>` for `path-recent`; `session:new` for `session-new`; `session:resume:<sessionId>` for `session-resume`; literal kind for singletons.
    - `kindForIndex(i)`: returns the row's kind.
    - `subscribe(listener)` / `getVersion()`: monotonic counter incremented on every `setInputs(...)` call.
    - Typed access: `rowAt(i): PickerRow`.
  - `useTidePickerDataSource(recents, query, ledgerSnapshot)` hook constructing and updating the composite.
- New file `tugdeck/src/lib/__tests__/tide-picker-data-source.test.ts`:
  - Empty recents + empty query → numberOfItems is 0.
  - Non-empty recents + empty query → header-recents + N path-recent rows.
  - Non-empty recents + matching query, ledger pending → header-recents + matching path-recent rows + loading.
  - Recents that match the query, with one recent exactly equaling the query → exact-match recent excluded.
  - Ledger ready with rows → header-sessions + session-new + N session-resume rows; forget-all iff non-live count > 0.
  - Ledger ready with zero rows → header-sessions + session-new only; no forget-all.
  - Live row → kind `session-resume`, `row.state === "live"`.
  - `idForIndex` stability across recents change (a session row's id is stable when its index shifts).
  - Subscribe/unsubscribe: one tick per upstream change.

**Tasks:**
- [x] Define `PickerRow`.
- [x] Implement `TidePickerDataSource`.
- [x] Implement `useTidePickerDataSource`.
- [x] Write the module docstring.
- [x] Write the tests listed above.

**Tests:**
- [x] `bun test src/lib/__tests__/tide-picker-data-source.test.ts` — all cases pass.

**Checkpoint:**
- [x] `bun run check`
- [x] `bun test src/lib/__tests__/tide-picker-data-source.test.ts`
- [x] `bun run audit:tokens lint`

---

#### Step 8: Phase 2 — Picker cell renderers + scoped CSS {#step-8}

**Depends on:** #step-7

**Commit:** `tide(picker): add cell renderers for picker row kinds`

**References:** [D02] role-flat-list, [D04] path-recent-navigation, [D05] forget-all-direct, [D07] finder-style-truncation, [D08] structural-allcaps-fix, [Spec S01](#s01-row-vocabulary)

**Artifacts:**
- Edit `tugdeck/src/components/tugways/cards/tide-card.tsx`: add seven `TugListViewCellRenderer<TidePickerDataSource>` components. Per-cell callbacks (`onNavigate`, `onSelectSession`, `onRequestForgetSession`, `onRequestForgetAll`) flow through React context owned by `TideProjectPickerForm` (added in Step 9).
  - `HeaderRecentsCell` / `HeaderSessionsCell` — sentence-case label, `aria-hidden`-ish presentation. Inert per role.
  - `PathRecentCell` — plain text path, `direction: rtl` + `unicode-bidi: plaintext` + `text-overflow: ellipsis` per [D07]; `title` and `aria-label` carry full path. Click → `onNavigate(path)`.
  - `SessionNewCell` — "Start fresh" / "New session" stack; `data-selected` reflects consumer selection state.
  - `SessionResumeCell` — existing rich row layout; `data-selected` reflects consumer selection state; trailing trash icon for non-live rows; `live` / `failed` badges.
  - `ForgetAllCell` — quiet footer link; click → `onRequestForgetAll()`.
  - `LoadingCell` — `aria-live="polite"` "checking…".
- Edit `tugdeck/src/components/tugways/cards/tide-card.css`:
  - New scoped block under `.tide-card-picker-list-view` per [L20].
  - `[data-list-cell-role="header"]` styling (muted, small, sentence case, no uppercase).
  - `[data-list-cell-role="footer"]` styling (subdued link).
  - `[data-selected="true"]` highlight on session cells.
  - `direction: rtl; unicode-bidi: plaintext; text-overflow: ellipsis` on `.tide-card-picker-path-recent` per [D07].
  - Remove `.tide-card-picker-recents`, `.tide-card-picker-recents-list`, `.tide-card-picker-pending-placeholder` rules.

**Tasks:**
- [x] Implement seven cell renderers.
- [x] Define a React context for cell-renderer callbacks (or pass via props on the data source — pick the smaller surface).
- [x] Add scoped CSS; remove obsolete rules.
- [ ] Verify `data-list-cell-role` styling renders as designed in DevTools.

**Tests:**
- [x] Cell-renderer unit tests via `@testing-library/react` (render, click, role attribute, selected state).

**Checkpoint:**
- [x] `bun run check`
- [x] `bun test src/components/tugways/cards/__tests__/`
- [x] `bun run audit:tokens lint`

---

#### Step 9: Phase 2 — Rewrite `TideProjectPickerForm` with `TugListView` {#step-9}

**Depends on:** #step-8

**Commit:** `tide(picker): replace recents-buttons + radio-group with TugListView`

**References:** [D03] select-then-open, [D04] path-recent-navigation, [D05] forget-all-direct, [D06] auto-select-session-new, [D08] structural-allcaps-fix, [D10] picker-owns-arrows, [D11] notice-outside-list, [Spec S01](#s01-row-vocabulary), [Spec S02](#s02-open-semantics), [Spec S03](#s03-selection-invalidation), [Spec S04](#s04-cancel-cascade), Risk R03

**Artifacts:**
- Edit `tugdeck/src/components/tugways/cards/tide-card.tsx`:
  - Inside `TideProjectPickerForm`:
    - Drop the `recents.length > 0` block (recents-as-buttons column).
    - Drop the `TugRadioGroup` block and its surrounding `useResponderForm({ selectValue })` block.
    - Drop the `tide-card-picker-pending-placeholder` div.
    - Add `selection: { kind: "session-new" } | { kind: "session-resume"; sessionId: string } | null` state.
    - Mount `<TugListView dataSource={pickerDataSource} delegate={pickerDelegate} cellRenderers={pickerCellRenderers} scrollKey="tide-card-picker" inline />` between the path input and the `tug-sheet-actions` row.
    - Implement `onSelect(index)` delegate that reads `dataSource.kindForIndex(index)` and dispatches: navigation for `path-recent`; selection update for `session-new` / non-live `session-resume`; confirm-panel open for `forget-all`; early return for headers / loading / live `session-resume`.
    - Implement `[Spec S03](#s03-selection-invalidation)` via `useLayoutEffect`.
    - Implement [D06] auto-default-to-`session-new` when SESSIONS first appears.
    - Implement [D10] keyboard handler: ArrowUp/ArrowDown moves selection across selectable rows (skipping headers / loading / path-recents / forget-all / live session-resumes); wraps at boundaries; Enter activates Open.
    - Update `submit()` to consume the new selection state per [Spec S02](#s02-open-semantics); preserve the defense-in-depth downgrade.
    - Update `handleFormKeyDown` Backspace handler: read selection state instead of `target.getAttribute("value")` for forget-on-Backspace.
    - Notice banner above `TugListView` per [D11] — unchanged from current code.
    - Cancel/Open buttons in `tug-sheet-actions` remain `TugPushButton` instances.
- Edit `tugdeck/src/__tests__/tide-card.test.tsx`:
  - Update selectors for the new DOM shape.
  - Add cases: select-then-Open for session-new and session-resume; click-to-navigate for path-recent; click-to-act for forget-all; arrow-key navigation skips inert rows; auto-select on first SESSIONS render; selection invalidation when the selected session vanishes.

**Tasks:**
- [ ] Refactor `TideProjectPickerForm` per the artifact list.
- [ ] Implement arrow-key navigation.
- [ ] Update tests.
- [ ] Manual smoke per [#manual-smoke-checklist](#manual-smoke-checklist) below.

**Tests:**
- [ ] `bun test src/__tests__/tide-card.test.tsx` — all cases pass.

**Checkpoint:**
- [ ] `bun run check`
- [ ] `bun test`
- [ ] `bun run audit:tokens lint`
- [ ] `rg 'TugRadioGroup\|TugRadioItem' tugdeck/src/components/tugways/cards/tide-card.tsx` returns zero matches.
- [ ] `rg 'TugPushButton' tugdeck/src/components/tugways/cards/tide-card.tsx` returns matches only inside `tug-sheet-actions` and the editor-settings sheet body.
- [ ] Manual smoke (see below).

##### Manual Smoke Checklist {#manual-smoke-checklist}

1. Open a Tide card → picker drops down → input focused.
2. Type a partial path → recents narrow with original case preserved.
3. Click a recent → input fills, list flips to SESSIONS, `Start fresh` is auto-selected.
4. Click an existing session row → selection moves to that row.
5. Click Open with `Start fresh` selected → `spawn_session` fresh.
6. Click Open with a `session-resume` selected → `spawn_session` resume.
7. Type a brand-new path → ledger settles with `Start fresh` only → click Open → fresh session.
8. Esc → sheet closes, card closes (cancel cascade).
9. ArrowUp/ArrowDown moves between selectable rows, skipping headers / loading / path-recents / forget-all / live rows.
10. Enter on a selected `session-resume` activates Open.
11. Per-row trash icon → confirm panel → confirm → row vanishes, panel closes, picker returns.
12. "Forget all sessions for this path" → confirm panel → confirm → all non-live rows vanish.
13. Path with one live session → `live` badge visible, row not selectable, arrow nav skips it.
14. Path retry notice (simulated): notice renders above the list view; Retry button works; list view is below the notice.

---

#### Step 9.5: Phase 2.5 — Chain-native confirmation refactor {#step-9-5}

**Depends on:** #step-9

**Commit:** Multiple (one per sub-task in the order below). The phase closes with `tide(picker): hoist confirmation to form, eliminate per-cell popovers`.

**References:** [D14] no-per-cell-popovers, [D15] tug-confirm-popover-controlled, [D16] tug-icon-button, [D17] pure-renderer-rule, [responder-chain.md §The three principals](../tuglaws/responder-chain.md#the-three-principals), [responder-chain.md §Anti-patterns](../tuglaws/responder-chain.md#anti-patterns), [responder-chain.md §Focus acceptance](../tuglaws/responder-chain.md#focus-acceptance), L11, L06, L02, (#context, #strategy)

##### Findings (post-Step 9 vetting) {#step-9-5-findings}

After landing the master/detail picker (Step 9) and the chain-pollution fix in `TugPopover.handleOpenChange` (DISMISS_POPOVER instead of CANCEL_DIALOG, already shipped during Step 9 vetting and required regardless of this step), HMR vetting surfaced a deeper structural issue: **per-cell `TugConfirmPopover` instances produce a fragile interaction lifecycle that the chain alone cannot rescue.** After a single trash+forget on a session row, DOM focus enters an indeterminate state and subsequent trash clicks become inert.

The root cause is not a single bug. It is a stack of tuglaw violations on the per-row trash button:

1. **L11 violation — callback props for user interactions.** The cell calls `onConfirmForgetSession` from `PickerCellContextValue` instead of dispatching a chain action. `responder-chain.md §Anti-patterns` lists this as the first prohibited pattern.
2. **L06 violation — appearance via React state.** The cell uses `useState(confirmOpen)` to drive the row's `data-popover-open` attribute. Visual state should derive from the chain or from CSS, not from a parallel React `useState`.
3. **Per-cell floating surfaces ([D14]).** N parallel `TugConfirmPopover` instances register N responders with overlapping lifetimes; when a row unmounts on confirm, the popover's cleanup cascade collides with the cell's React-tree teardown. Listeners installed by `useServicePopupBinding.captureOnOpen` leak, focus restoration runs against detached trigger elements, and the next trash click finds the chain in an inconsistent state.
4. **Mixed focus models on one control.** The trash is a raw `<button>`, not a focus-refusing `TugButton`. Click promotes the chain (DOM-walk), moves browser focus (Chrome), AND fires Radix's `Popover.Trigger` toggle — three behaviors fighting on one click. The hand-rolled `e.preventDefault()` to suppress Radix's toggle also disables `useServicePopupBinding.captureOnOpen`, so close-focus restoration is half-broken even on the happy path.
5. **Imperative Promise as a parallel control flow path.** `confirmRef.current?.confirm()` returns a `Promise<boolean>` the cell `await`s, then calls a callback, then `setConfirmOpen(false)` in a `finally` block on a possibly-unmounted component. The chain is the canonical dispatch currency (`responder-chain.md §ActionEvent — the sole dispatch currency`); a parallel Promise lane creates ordering and unmount seams where bugs land.

The chain is built on ownership boundaries (responders own state, controls dispatch). The picker's per-row trash places state, control, side-effect, and floating-surface lifecycle in the cell — violating every part of the model. More patches won't fix it. The model has to change.

##### Approach {#step-9-5-approach}

Hoist confirmation ownership to the picker form (the chain responder). The cell becomes a pure renderer with a focus-refusing `TugIconButton` that emits one chain action with a `{sessionId}` payload. The form responder handles the action by setting `pendingForgetSessionId` state, which drives a single `TugConfirmPopover` (controlled mode) anchored to the requesting row's trash button via a `data-session-id` lookup.

```
┌─────────────────────────────────────────────────┐
│  TideProjectPickerForm (chain responder)        │   actions:
│    pendingForgetSessionId: string | null        │     request-forget-session
│    one <TugConfirmPopover open={…} anchorEl={…}/>│
└──────────────────────▲──────────────────────────┘
                       │ parentId
┌──────────────────────┴──────────────────────────┐
│  SessionResumeCell (pure renderer)              │
│    data-session-id={row.session_id}             │
│    <TugIconButton dispatch={request-forget-     │  ← targeted dispatch
│      session, {sessionId}}/>                    │     to parent responder
└─────────────────────────────────────────────────┘
```

##### Sub-steps and commits {#step-9-5-substeps}

This step ships as five commits in order. Each builds on the previous.

**9.5a — `TugIconButton` primitive.**
- New: `tug-icon-button.tsx`, `tug-icon-button.css`, `__tests__/tug-icon-button.test.tsx`.
- Props: `icon: ReactNode`, `ariaLabel: string`, `title?: string`, `dispatch?: ActionEvent`, `onClick?: (e) => void`, `disabled?: boolean`, `senderId?: string`, `size?: "sm" | "md"`, `tone?: "default" | "danger"`.
- Renders `<button type="button" data-tug-focus="refuse" data-slot="tug-icon-button">`.
- Uses `useControlDispatch()` when `dispatch` is provided. Falls back to `onClick` otherwise. Both are mutually exclusive (typed via discriminated union or runtime warn).
- Hover / focus / active states scoped under `tug-icon-button.css` per L20.
- Add a small gallery card (`gallery-icon-button.tsx` registered in `gallery-registrations.tsx`).
- Commit: `tugways(tug-icon-button): add focus-refusing icon button primitive`.

**9.5b — `TugConfirmPopover` controlled-mode API + `TugPopoverAnchor` re-export.**
- Edit `tug-popover.tsx`: re-export `Popover.Anchor` as `TugPopoverAnchor`. Document its purpose (anchor without trigger).
- Edit `tug-confirm-popover.tsx`: add `open?: boolean`, `anchorEl?: HTMLElement | null`, `onConfirm?: () => void`, `onCancel?: () => void` props. When `open` is a boolean, render `<TugPopoverAnchor>` over the supplied `anchorEl`'s position (via a synthetic positioned element or by passing the element ref through to Radix), drive the inner `TugPopover` controlled-mode (pass `open` and `onOpenChange`), and invoke `onConfirm`/`onCancel` from the action handlers in lieu of resolving the imperative Promise.
- Caller picks one API: imperative `ref.confirm()` OR controlled props. Document mutual exclusivity in JSDoc.
- Tests: existing imperative tests pass unchanged; new tests cover controlled-mode open/close + onConfirm/onCancel firing.
- Commit: `tugways(tug-confirm-popover): add controlled-mode props API`.

**9.5c — `request-forget-session` chain action.**
- Edit `action-vocabulary.ts`: add `REQUEST_FORGET_SESSION: "request-forget-session"`. Document payload `{ sessionId: string }` inline.
- Edit `tuglaws/action-naming.md`: add the action to the per-action payload table.
- Commit: `tugways(action-vocabulary): add request-forget-session`.

**9.5d — Picker refactor.**
- Edit `tide-picker-cells.tsx`:
  - Delete `useState(confirmOpen)`, `confirmRef`, the in-cell `<TugConfirmPopover>`, and the `handleTrashClick` async function.
  - Replace the raw `<button>` trash with `<TugIconButton dispatch={{ action: REQUEST_FORGET_SESSION, value: { sessionId: row.session_id }, phase: "discrete" }} icon={<Trash2 size={14} />} ariaLabel={…} tone="danger" size="sm" />`.
  - Add `data-session-id={row.session_id}` to the row's outer wrapper for anchor lookup.
  - Delete `onConfirmForgetSession` from `PickerCellContextValue` and `NULL_CONTEXT`.
  - Drop all imports made unused by the deletion.
- Edit `tide-card.tsx` (`TideProjectPickerForm`):
  - Add `pendingForgetSessionId: string | null` state.
  - Register chain handler for `REQUEST_FORGET_SESSION` on the form responder via `useResponderForm` (or hand-rolled `useResponder` if `useResponderForm` doesn't have a slot for free-form actions). Payload's `sessionId` populates `pendingForgetSessionId`. Defensive payload narrowing per L07.
  - Resolve the anchor element via a `useLayoutEffect` that, when `pendingForgetSessionId !== null`, queries `formRef.current?.querySelector(`[data-session-id="${id}"] [data-slot="tug-icon-button"]`)` and stores it in a ref-backed state for the popover.
  - Render ONE `<TugConfirmPopover open={pendingForgetSessionId !== null} anchorEl={anchorEl} message={…} confirmLabel="Forget" confirmRole="danger" side="left" onConfirm={() => { forgetSession(pendingForgetSessionId!); setPendingForgetSessionId(null); }} onCancel={() => setPendingForgetSessionId(null)} />` near the form's footer — sibling to the existing forget-all popover.
  - Delete `onConfirmForgetSession: forgetSession` from `cellContextValue`.
- Edit `tide-card.css`:
  - Remove the `.tide-card-picker-session-option[data-popover-open="true"]` rules — no longer needed (popover open state is form-owned, the row no longer has its own attribute).
  - Adjust the trash icon hover-reveal CSS to read `:hover` and `:focus-within` on the row plus the form's `[data-pending-forget="<id>"]` marker, OR drop the hover-only reveal entirely (icon button is always visible on the row when non-live; its tone="danger" gives the visual weight).
- Manual smoke: trash → forget on row A → trash on row B → forget on row B → trash on row C → cancel — all interactions remain crisp; no focus indeterminacy; no dead clicks.
- Commit: `tide(picker): hoist confirmation to form, eliminate per-cell popovers`.

**9.5e — Documentation updates.**
- Edit `tuglaws/responder-chain.md` §Anti-patterns: add a new bullet for "Per-cell floating surfaces" per [D14].
- Edit `tuglaws/component-authoring.md`: add "Cell renderer rules" section per [D17] and "Trailing actions in lists use TugIconButton" rule per [D16].
- Update [tugplan-tug-list-view.md §roadmap](./archive/tugplan-tug-list-view.md#roadmap): note cell-renderer purity rule landed via this plan.
- Commit: `tuglaws(responder-chain,component-authoring): document cell-renderer + icon-button rules`.

##### Artifacts (consolidated) {#step-9-5-artifacts}

- New file `tugdeck/src/components/tugways/tug-icon-button.tsx`.
- New file `tugdeck/src/components/tugways/tug-icon-button.css`.
- New file `tugdeck/src/components/tugways/__tests__/tug-icon-button.test.tsx`.
- New file `tugdeck/src/components/tugways/cards/gallery-icon-button.tsx`.
- Edit `tugdeck/src/components/tugways/tug-popover.tsx`: re-export `TugPopoverAnchor`.
- Edit `tugdeck/src/components/tugways/tug-confirm-popover.tsx`: add controlled-mode props API; existing imperative API preserved.
- Edit `tugdeck/src/components/tugways/__tests__/tug-confirm-popover.test.tsx`: add controlled-mode test cases.
- Edit `tugdeck/src/components/tugways/action-vocabulary.ts`: add `REQUEST_FORGET_SESSION`.
- Edit `tuglaws/action-naming.md`: document `request-forget-session`.
- Edit `tugdeck/src/components/tugways/cards/tide-picker-cells.tsx`: delete cell-local state/refs/popover/callback; replace raw trash with `TugIconButton`; add `data-session-id`.
- Edit `tugdeck/src/components/tugways/cards/tide-card.tsx`: add `pendingForgetSessionId` state, chain handler, anchor resolution, single controlled-mode `TugConfirmPopover`.
- Edit `tugdeck/src/components/tugways/cards/tide-card.css`: remove `[data-popover-open]` rules; adjust trash visibility.
- Edit `tuglaws/responder-chain.md` §Anti-patterns: add per-cell-floating-surfaces entry.
- Edit `tuglaws/component-authoring.md`: add cell-renderer-purity + trailing-actions sections.

##### Tasks {#step-9-5-tasks}

- [x] 9.5a — Implement `TugIconButton` + CSS + tests + gallery card. Land as commit 1.
- [x] 9.5b — Add controlled-mode API to `TugConfirmPopover`; re-export `TugPopoverAnchor`; tests. Land as commit 2.
- [x] 9.5c — Add `REQUEST_FORGET_SESSION` action constant + action-naming.md entry. Land as commit 3. (Payload docs live inline in `action-vocabulary.ts` per the project pattern; no separate table in `action-naming.md` to update.)
- [x] 9.5d — Refactor `tide-picker-cells.tsx` to a pure renderer; refactor `TideProjectPickerForm` to own confirmation state + popover; CSS cleanup. Land as commit 4.
- [x] 9.5e — Documentation updates (responder-chain.md, component-authoring.md). Land as commit 5.
- [ ] Manual smoke: trash → forget → trash → forget across multiple rows in succession; no focus glitch; no dead clicks (the bug from post-Step-9 vetting is gone).

##### Tests {#step-9-5-tests}

- [ ] `bun test src/components/tugways/__tests__/tug-icon-button.test.tsx` — all cases pass.
- [ ] `bun test src/components/tugways/__tests__/tug-confirm-popover.test.tsx` — existing imperative tests + new controlled-mode tests all pass.
- [ ] `bun test src/components/tugways/__tests__/tug-popover.test.tsx` — unchanged from Step 9 (the DISMISS_POPOVER fix already shipped, tests already pass).
- [ ] `bun test src/__tests__/tide-card.test.tsx` — picker tests pass with new DOM shape (pre-existing rot in `tide-picker-cells.test.tsx` still deferred per Step 9 note).
- [ ] Cell-renderer purity check — lint or manual: `rg '\buseState\b|\buseRef\b|\buseEffect\b|\buseLayoutEffect\b|\buseImperativeHandle\b' tugdeck/src/components/tugways/cards/tide-picker-cells.tsx` returns zero matches.
- [ ] Raw-button check: `rg '<button\b' tugdeck/src/components/tugways/cards/tide-picker-cells.tsx` returns zero matches.

##### Checkpoint {#step-9-5-checkpoint}

- [ ] `bun run check`
- [ ] `bun test` (curated subset matching Step 9's pattern; full run optional)
- [ ] `bun run audit:tokens lint`
- [ ] `cargo nextest run`
- [ ] Manual smoke: trash + forget interaction is stable across repeated use; no focus indeterminacy; clicking trash on different rows in succession Just Works.

##### Risks specific to Step 9.5 {#step-9-5-risks}

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| Anchor-element resolution races on first render of the popover (querySelector returns null because the row isn't painted yet) | med | low | Use a `useLayoutEffect` for resolution; null `anchorEl` keeps the popover closed in render; the next layout pass re-resolves. Tests cover the race. |
| Existing imperative-mode TugConfirmPopover consumers (forget-all in the same form, future callers) regress on the API change | med | low | Imperative API is preserved as-is; new props are purely additive; existing tests pass without modification. |
| TugIconButton's `dispatch` prop conflicts with consumers that need both dispatch AND a side-effect onClick | low | med | Discriminated union: caller picks `dispatch` OR `onClick`. If both are needed, the responder's handler does the side effect — that's the chain way. |
| Refactor introduces a new sheet-close-on-popover-dismiss bug | high | low | The DISMISS_POPOVER fix from Step 9 vetting addresses this category at the primitive level; refactor doesn't reintroduce it. Verify in manual smoke. |

---

#### Step 9.6: Phase 2.6 — Pane-scoped overlay framework {#step-9-6}

**Depends on:** #step-9-5

**Commit:** Multiple commits (one per sub-task in the order below). The phase closes with `tugways(tug-sheet): portal into pane frame, use pane-owned scrim`.

**References:** [D18] pane-owned-scrim, [D19] sheet-in-pane-frame, [D20] modal-scope-is-pane, [pane-model.md](../tuglaws/pane-model.md), [responder-chain.md §Focus acceptance](../tuglaws/responder-chain.md#focus-acceptance), L06, L20, L24, (#context, #strategy)

##### Findings (post-Step 9.5 vetting) {#step-9-6-findings}

After landing the chain-native confirmation refactor in Step 9.5, HMR vetting surfaced a deeper bug class in how modal-class surfaces (specifically `TugSheet`) interact with multi-pane canvases. Two failed remediation attempts before this step landed converged on the same root cause:

1. **Attempt 1 — split portal (scrim → pane chrome, panel → canvas overlay):** The scrim moved into pane chrome where it's structurally bounded, but the panel + clip stayed on canvas overlay at `--tug-z-overlay-dialog`. Pointer-events on the clip were narrowed to `none` so empty clip area passed clicks through. *Result:* visual bleed gone, but the panel itself still painted above peer panes wherever it overlapped them — modal-class surface sitting "above the canvas" can never not paint over peer panes that happen to occupy the same pixels.
2. **Attempt 2 — single portal into pane chrome:** Both scrim and panel portaled into the chrome. *Result:* the chrome's `overflow: hidden` clipped the panel at the chrome's bottom edge — the picker form's Cancel/Open buttons disappeared. Dealbreaker.

The architectural mismatch underlying both attempts: the canvas-overlay tier is a single global stacking context. Anything portaled there is above ALL panes by construction. "Pane-modal but rendered on canvas-overlay with measurement-based confinement" is a class of patch on top of the wrong portal target — every pixel of bleed (subpixel rounding, drop-shadow extension, animation overshoot, miscalculated bounds, future Radix internals) is a potential bug. Confining to the right pixels was always going to be a losing game.

The right answer is **scope the modal to the pane's stacking context, not to a measured rectangle on canvas-overlay**. The canvas already gives us per-pane stacking via `.tug-pane`'s inline z-index — we just weren't using it for sheets. Each pane is its own stacking context; peer panes stack with each other independently of one pane's internal z-index choices. Anything inside a pane's stacking context is structurally incapable of affecting peer panes.

##### Approach {#step-9-6-approach}

Two complementary primitives, both rooted in the host pane's stacking context:

**1. Pane-owned scrim (built into TugPane).** Every pane carries a permanent scrim element inside its chrome from mount. Modal-class consumers control it via a `useTugPaneScrim()` hook with ref-counted show/hide. The chrome's `overflow: hidden` and the frame's stacking-context boundary make bleed structurally impossible. See [D18].

**2. Sheets portal into the pane frame.** `TugSheet`'s panel + slide-in clip portal into the `.tug-pane` frame element, not into canvas overlay. Frame is its own stacking context. Frame has `overflow: visible` so the panel can extend past the chrome's bottom edge into the canvas grid below — without escaping the pane's stacking context. Pure CSS positioning; no applier, no observers, no measurement. See [D19], [D20].

```
.tug-pane (frame, position: absolute, z-index: N, overflow: visible)
  resize-handles (siblings)
  .tug-pane-chrome (position: relative, overflow: hidden)
    .tug-pane-titlebar
    .tug-pane-body
    .tug-pane-scrim   ← built-in, opacity:0, [data-scrim] gates
  .tug-sheet-clip     ← portaled here by TugSheet (sibling of chrome)
    .tug-sheet-content (the panel)
```

Peer panes z-stacked above paint on top of everything in this pane's stacking context — including the scrim AND the sheet panel. That's correct: peer panes are NOT inside this pane's modal scope; they SHOULD paint above. The modal scope is the pane.

##### Sub-steps and commits {#step-9-6-substeps}

This step ships as five commits in order. Each builds on the previous.

**9.6a — Pane-scrim registry + hook.**
- New: `tugdeck/src/lib/pane-scrim-registry.ts`. Module-scope `Map<HTMLElement, number>` ref-counts per chrome. `increment(chromeEl)` adds to count and sets `data-scrim="on"` when count crosses 0→1; `decrement(chromeEl)` removes from count and clears the attribute when count drops to 0. Idempotent on a missing element.
- New: `tugdeck/src/components/tugways/use-tug-pane-scrim.ts`. Hook reads chrome from `TugPanePortalContext`. Returns `{ show, hide }` callbacks stable via `useCallback` over the chrome ref. No-op when chrome is null (standalone preview / test).
- Tests: ref-count semantics (multiple show/hide), no-provider fallback (no crash, no DOM mutation), attribute toggling at count boundaries, cleanup on consumer unmount.
- Commit: `tugways(pane-scrim): add ref-counted pane-scoped scrim primitive`.

**9.6b — Build the scrim element into TugPane chrome.**
- Edit `tug-pane.tsx`: render `<div className="tug-pane-scrim" aria-hidden="true" />` inside `.tug-pane-chrome` as a sibling of `.tug-pane-titlebar` and `.tug-pane-body`. Default state: opacity 0.
- Edit `tug-pane.css`: add `.tug-pane-scrim` rule. `position: absolute; top: var(--tug-chrome-height); inset: 0; pointer-events: auto; z-index: 10`. Background uses the existing `--tugx-sheet-overlay-bg` token (rename to `--tugx-pane-scrim-bg` since it's no longer sheet-specific) — register the new alias in the chrome's component-tier alias section.
- Add `.tug-pane-chrome[data-scrim="on"] .tug-pane-scrim { opacity: 1; transition: opacity var(--tug-motion-duration-moderate) ease; }`. Also a transition on the rest state so the fade-out runs cleanly.
- `pointer-events: auto` makes the scrim a dead zone within the pane body. The existing `inert` on `.tug-pane-body` (set by `TugSheet` when open) handles keyboard-routing semantics; the scrim is the visual + pointer dead zone.
- Tests: pane renders the scrim element regardless of sheet state; CSS rules apply when attribute set; transition timing token resolves; pane bodies in a multi-pane gallery card all carry their own independent scrims.
- Commit: `tugways(tug-pane): build pane-scoped scrim layer into chrome`.

**9.6c — TugPaneFrameContext.**
- Edit `tug-pane.tsx`: add `TugPaneFrameContext` (alongside the existing `TugPanePortalContext`), provide the `.tug-pane` frame element via `frameRef`. Same context-provider lifecycle as `TugPanePortalContext` — value updates when the frame is rendered.
- Re-export: name + type from `tug-pane.tsx`. Keep `TugPanePortalContext` as the chrome target (used by everything else); the frame context is sheet-specific (and any future pane-frame-scoped surface).
- Tests: context provides the right element; context is null outside a pane; provider value updates when frame remounts.
- Commit: `tugways(tug-pane): expose TugPaneFrameContext for pane-frame-scoped portals`.

**9.6d — TugSheet refactor.**
- Edit `tug-sheet.tsx`:
  - Drop `useCanvasOverlay()` import + call.
  - Read `paneFrameEl` from `TugPaneFrameContext`. Use it as the `createPortal` target in place of the canvas overlay root. Fall back to `document.body` when null (matches existing `useCanvasOverlay` fallback shape for standalone tests/previews).
  - Drop the entire wrapper applier `useLayoutEffect` (~80 lines): no more `wrapperRef`, no more `clipRef.style.top/left/width/height` writes, no more ResizeObserver, no more MutationObserver, no more window-resize listener.
  - Drop the `<div ref={wrapperRef} className="tug-sheet-anchor">` + nested `<div ref={overlayRef} className="tug-sheet-overlay">`. Replace with a `useTugPaneScrim()` call: `useLayoutEffect(() => { if (open) { scrim.show(); return () => scrim.hide(); } }, [open, scrim])`.
  - The remaining JSX is just the clip + content portal: `<div className="tug-sheet-clip"><FocusScope>...<div className="tug-sheet-content">...</div></FocusScope></div>` — sized by CSS, no inline styles.
  - Drop the `overlayRef` (no longer used; the scrim is no longer animated by TugAnimator group). The panel's `g.animate(contentEl, ...)` stays — it's the only animated element on the sheet's side now.
- Edit `tug-sheet.css`:
  - Delete `.tug-sheet-anchor` and `.tug-sheet-overlay` rules entirely.
  - `.tug-sheet-clip`: change to `position: absolute; top: calc(var(--tug-chrome-height) + 1px); left: 0; right: 0; height: 100vh; overflow: hidden; pointer-events: none; z-index: 2`. The `+ 1px` accounts for `.tug-pane-chrome`'s 1px border so the clip top aligns precisely with the title-bar bottom edge in frame coordinates (chrome border is the 1px gap between frame top and title-bar top). The `z-index: 2` puts the clip above sibling resize handles (which carry `z-index: 1`); without it, the south resize handle's `bottom: -4px → +4px` band paints and hit-tests above the panel where a tall panel overlaps it. The 100vh height accommodates panels taller than the pane (panel scrolls inside via `.tug-sheet-content`'s `overflow-y: auto`); shorter panels just don't extend that far.
  - `.tug-sheet-content` keeps its existing rules; no changes needed.
  - Drop the `--tugx-sheet-overlay-bg` alias (moved to `--tugx-pane-scrim-bg` in step 9.6b's chrome alias block).
- Tests: existing TugSheet tests should pass with minor selector adjustments. The portal target check (`document.body` vs canvas overlay root) needs an update — the sheet now lives inside `.tug-pane` instead of the overlay root. `.tug-sheet-content` selector is unchanged.
- Commit: `tugways(tug-sheet): portal into pane frame; use pane-owned scrim`.

**9.6e — Documentation updates.**
- Edit `tuglaws/pane-model.md`: new section "Pane-modal vs canvas-overlay surfaces" documenting [D20]'s rule and the per-pane stacking model. Cross-references [pane-scrim-registry] and [TugPaneFrameContext].
- Edit `tuglaws/responder-chain.md`: a brief note in §Anti-patterns that "modal surfaces portaling to canvas overlay" was an architectural anti-pattern fixed by this step — reference [D20] and Step 9.6.
- Edit `dash/tugplan-tide-overlay-framework.md` (#mental-model): update the system-level architecture description to reflect the pane-modal boundary.
- Update `tug-sheet.tsx` module docstring: replace the canvas-overlay-portal language with pane-frame-portal language. Reference [D19] / [D20].
- Commit: `tuglaws(pane-model,responder-chain): document pane-scoped modal scope`.

##### Artifacts (consolidated) {#step-9-6-artifacts}

- New file `tugdeck/src/lib/pane-scrim-registry.ts`.
- New file `tugdeck/src/components/tugways/use-tug-pane-scrim.ts`.
- New file `tugdeck/src/lib/__tests__/pane-scrim-registry.test.ts`.
- New file `tugdeck/src/components/tugways/__tests__/use-tug-pane-scrim.test.tsx`.
- Edit `tugdeck/src/components/chrome/tug-pane.tsx`: render scrim element inside chrome; add `TugPaneFrameContext` provider.
- Edit `tugdeck/src/components/tugways/tug-pane.css`: add `.tug-pane-scrim` rules + `[data-scrim="on"]` selector + `--tugx-pane-scrim-bg` alias.
- Edit `tugdeck/src/components/tugways/tug-sheet.tsx`: portal target → pane frame; drop scrim element + applier; use `useTugPaneScrim()`.
- Edit `tugdeck/src/components/tugways/tug-sheet.css`: drop `.tug-sheet-anchor` + `.tug-sheet-overlay` rules; update `.tug-sheet-clip` positioning.
- Edit `tuglaws/pane-model.md`: add pane-modal vs canvas-overlay section.
- Edit `tuglaws/responder-chain.md`: anti-pattern note + cross-reference.
- Edit `dash/tugplan-tide-overlay-framework.md`: mental-model update.

##### Tasks {#step-9-6-tasks}

- [x] 9.6a — pane-scrim registry + hook + tests. Land as commit 1.
- [x] 9.6b — scrim element built into `TugPane` chrome + CSS + tests. Land as commit 2.
- [x] 9.6c — `TugPaneFrameContext` provider + tests. Land as commit 3.
- [x] 9.6d — `TugSheet` refactor: portal into pane frame, use pane-scrim hook, drop applier + canvas-overlay portal + scrim element. Land as commit 4.
- [x] 9.6e — Documentation updates (`pane-model.md`, `responder-chain.md`, `tugplan-tide-overlay-framework.md`, `tug-sheet.tsx` docstring). Land as commit 5.
- [ ] Manual smoke: open Tide picker → choose session → close. With a peer pane stacked above the Tide pane partially overlapping it: scrim does NOT bleed into peer pane; sheet panel does NOT paint over peer pane where they overlap (peer pane covers the panel). With a peer pane below the Tide pane vertically: panel extends into empty canvas grid where peer pane isn't, peer pane covers the panel where it is. Sheet open / cancel / submit / Escape all work.

##### Tests {#step-9-6-tests}

- [x] `bun test src/lib/__tests__/pane-scrim-registry.test.ts` — ref-count semantics, attribute toggling, no-element fallback.
- [x] `bun test src/components/tugways/__tests__/use-tug-pane-scrim.test.tsx` — hook show/hide drives registry; cleanup on unmount; no-provider returns no-op callbacks.
- [x] `bun test src/__tests__/tug-sheet.test.tsx` — existing sheet tests pass with selector updates; verify portal target is now the pane frame, not document.body / canvas overlay.
- [x] `bun test` curated subset — no regressions in `tug-popover`, `tug-confirm-popover`, `tug-icon-button`, `tide-card-banner-spec`.
- [x] `bun run audit:tokens lint` — new `--tugx-pane-scrim-bg` alias declared and paired correctly.
- [x] Greppable invariants:
  - `rg 'useCanvasOverlay' tugdeck/src/components/tugways/tug-sheet.tsx` returns zero matches.
  - `rg '\.tug-sheet-overlay' tugdeck/src/components/tugways/tug-sheet.css tugdeck/src/components/tugways/tug-sheet.tsx` returns zero matches.
  - `rg 'tug-pane-scrim' tugdeck/src/components/chrome/tug-pane.tsx` returns matches.

##### Checkpoint {#step-9-6-checkpoint}

- [x] `bun run check`
- [x] `bun test` (curated subset; full run optional)
- [x] `bun run audit:tokens lint`
- [x] `cargo nextest run`
- [ ] Manual smoke: pane-modal scope is correct in all the geometric configurations under (#step-9-6-tasks)' manual smoke item.

##### Risks specific to Step 9.6 {#step-9-6-risks}

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| Slide-in animation no longer sequenced with scrim fade (decoupled per [D18]) — visible mistiming on slow machines | low | low | Both transitions use `--tug-motion-duration-moderate`. End-time skew is a few ms; visually they finish together. If anyone reports a problem, hoist scrim animation back into TugAnimator's `group()` via a ref-based escape hatch. |
| `TugSheetStackingContext` z-tier coordination breaks for popover-in-sheet now that the sheet is inside a pane's stacking context (lower than canvas-overlay) | med | low | Popovers still portal to canvas-overlay (transient surface, not pane-modal). Their z-tier (`--tug-z-overlay-popup-in-dialog` when inside a sheet) is on canvas overlay tier, ABOVE all panes — so popovers always stack above the sheet's panel in the pane. Verify in manual smoke (open picker → click trash → confirm popover should appear above the sheet panel). |
| Cross-pane card move with sheet open: portal target changes mid-interaction | med | low | `TugPaneFrameContext` value updates atomically when card moves. `createPortal` re-targets on the next render. `useTugPaneScrim()` re-derives from new context, decrement old pane's count, increment new pane's count. Sheet visually moves with card, scrim follows. Smoke-check by dragging the host card to a different pane while a sheet is open. |
| Component State Preservation restore-on-mount: timing race where the sheet wants to render before the pane chrome has mounted | low | low | The `useTugPaneScrim()` no-provider fallback handles the transient null-chrome window; the sheet's existing `if (!cardEl) return null` already gates the portal until chrome is in scope. Restore is idempotent (re-runs effect on next render). |
| Standalone TugSheet rendering in tests / gallery without a pane | low | low | Sheet falls back to `document.body` portal target when frame context is null; pane-scrim hook no-ops. Existing standalone tests stay green. Note: a previous canvas-overlay fallback rendered the scrim against `document.body` so a bare sheet showed dimming; after this step a pane-less sheet shows no scrim. Acceptable in tests (assertions don't depend on scrim presence). For gallery sheet cards, render them inside a `TugPane` host (the gallery pattern for other chrome-dependent substrates) so the scrim is present. |
| TugAlert's app-modal semantic conflicts with [D20]'s pane-scope rule | low | low | TugAlert is explicitly out of scope for Step 9.6 (pane-modal surfaces only). Documented as a follow-on candidate in [#roadmap]. Alert continues to use canvas overlay until a future plan decides whether to migrate it (and re-scope its blocking semantic to a pane). |

---

#### Step 10: Phase 2 — Tuglaws walkthrough + cleanup {#step-10}

**Depends on:** #step-9, #step-9-5, #step-9-6

**Commit:** `tide(picker): tuglaws walkthrough and cleanup`

**References:** [tuglaws.md](../tuglaws/tuglaws.md), [pane-model.md](../tuglaws/pane-model.md), [component-authoring.md](../tuglaws/component-authoring.md), [design-decisions.md](../tuglaws/design-decisions.md), (#constraints)

**Artifacts:**
- Final pass over `tide-card.tsx` and `tide-card.css` — remove any commented-out legacy code and orphaned selectors.
- Walk the rewrite against tuglaws and record findings in the commit message:
  - [L01] no extra `root.render`.
  - [L02] external state via `useSyncExternalStore`; recents, query (local), ledger.
  - [L03] event-dependent registrations in `useLayoutEffect`.
  - [L06] selection highlight is CSS (`[data-selected]`), not className concat.
  - [L11] no new chain handlers; `TUG_ACTIONS.CLOSE` cascade preserved.
  - [L19] new files follow component authoring guide.
  - [L20] new tokens scoped under the picker; no reach into `--tugx-list-view-*`.
  - [L23] `scrollKey="tide-card-picker"` distinct from `"tide-card-transcript"`.
- Update [tugplan-tug-list-view.md §roadmap](./archive/tugplan-tug-list-view.md#roadmap) entries: mark "Header / footer views" and "Picker migration onto `TugListView`" as shipped (note: the archive plan can be edited to reflect the shipped status, or a footnote added — pick whichever the team's archive convention prefers).

**Tasks:**
- [ ] Final pass over `tide-card.tsx` / `tide-card.css`.
- [ ] Walk tuglaws.
- [ ] Update archive plan annotation.
- [ ] Commit message records the walkthrough.

**Tests:**
- [ ] All four test/build commands green.
- [ ] `git diff --stat` shows orphaned CSS deleted.

**Checkpoint:**
- [ ] `bun run check`
- [ ] `bun test`
- [ ] `bun run audit:tokens lint`
- [ ] `cargo nextest run`

---

#### Step 11: Phase 2 Integration Checkpoint (Plan close) {#step-11}

**Depends on:** #step-7, #step-8, #step-9, #step-9-5, #step-9-6, #step-10

**Commit:** `N/A (verification only)`

**References:** (#success-criteria, #exit-criteria)

**Tasks:**
- [ ] Confirm all success criteria from [#success-criteria](#success-criteria) are met.
- [ ] Confirm the manual smoke checklist from Step 9 passes end-to-end.
- [ ] Confirm no regression in transcript or gallery list-view behavior.

**Tests:**
- [ ] Aggregate suite green.

**Checkpoint:**
- [ ] `bun run check`
- [ ] `bun test`
- [ ] `bun run audit:tokens lint`
- [ ] `cargo nextest run`

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** A `TugListView`-driven Tide project picker, built on a primitive that supports header/footer rows and a reusable filter-decorator hook.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] `roleForIndex` ships in `TugListView`; existing consumers unchanged. (verification: `bun test` green, transcript renders unchanged in manual smoke)
- [ ] `useFilteredDataSource` ships with full test coverage and a gallery card. (verification: `bun test`, manual gallery)
- [ ] `TideProjectPickerForm` is rewritten on top of `TugListView` + `TidePickerDataSource`. (verification: `rg` checks in [#success-criteria](#success-criteria) + manual smoke)
- [ ] All seven row kinds render correctly across the four input states (empty / partial-match / exact-known / exact-unknown). (verification: data-source unit tests + manual)
- [ ] Recent paths render with original case preserved. (verification: manual)
- [ ] Open semantics match [Spec S02](#s02-open-semantics). (verification: tests + manual)
- [ ] Cancel cascade matches [Spec S04](#s04-cancel-cascade). (verification: tests + manual)
- [ ] Tuglaws walkthrough recorded in the closing commit. (verification: commit message review)

**Acceptance tests:**
- [ ] `bun test src/components/tugways/__tests__/tug-list-view.test.tsx`
- [ ] `bun test src/components/tugways/__tests__/use-filtered-data-source.test.ts`
- [ ] `bun test src/lib/__tests__/tide-picker-data-source.test.ts`
- [ ] `bun test src/__tests__/tide-card.test.tsx`
- [ ] `cargo nextest run`

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] **Full UITableView-style sections** (`numberOfSections`, `numberOfItemsInSection`, `IndexPath`-shaped data source, sticky section headers). Earned when a consumer needs cross-section semantics that role-on-flat-list can't express.
- [ ] **Built-in arrow-key navigation in `TugListView`** with a selectability predicate. Earned when a second consumer reproduces the picker's arrow-nav handler.
- [ ] **Master/detail picker layout.** Earned when recents grow beyond ~15 entries with metadata that benefits from a dedicated pane.
- [ ] **Server-side recents filtering.** Drop-in replacement at the base data source layer; no primitive change needed.
- [ ] **Atom-aware path rendering.** Once paths support project-name + branch + workspace metadata as structured atoms, the `path-recent` cell renderer evolves to display them.

| Checkpoint | Verification |
|------------|--------------|
| Phase 0 primitive shipped | `bun test src/components/tugways/__tests__/tug-list-view.test.tsx` green; gallery-list-view-headers card mounts |
| Phase 1 primitive shipped | `bun test src/components/tugways/__tests__/use-filtered-data-source.test.ts` green; gallery-list-view-filter card mounts |
| Phase 2 picker shipped | `bun test src/__tests__/tide-card.test.tsx` green; manual smoke checklist passes |
| Tuglaws walkthrough | Commit message of the closing commit includes the eight-law walk |
| No regression | `bun test`, `bun run audit:tokens lint`, `cargo nextest run` all green |
