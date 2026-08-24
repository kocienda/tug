## Accessory Focus Cycling — Row Accessories Join the Keyboard Focus Language {#accessory-focus-cycling}

**Purpose:** Hover-revealed trailing accessories in list rows (the picker's per-row trash buttons, and any future in-row action) become visible when their row is selected or under the keyboard cursor, and reachable by keyboard: ArrowRight descends onto the accessory, Space/Enter acts on it, ArrowLeft/Escape ascend back to the list — with a deliberate focus landing after the accessory's action deletes its own row.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-06-10 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

The session picker's Recents and Sessions lists carry per-row trash buttons in `TugListRow`'s trailing slot with `trailingReveal="hover"`. The reveal CSS in `tug-list-row.css` shows the accessory only on `.tug-list-row:hover` or `:focus-within` — and keyboard state fires neither: the list is a single engine focus stop (browser focus rests on the scroll container), selection is `data-selected` on the row, and the movement cursor is `data-key-cursor` on the cell wrapper. A keyboard user never sees the trash button, and could not reach it anyway: the ArrowRight tree-descend in `TugListView` is gated `!singleSelect` (both picker lists are single-select), and the trash `TugIconButton` never registers as an engine focusable, so `rowFirstFocusableId` finds nothing in the row.

All the machinery this feature needs already shipped in the focus-language phase ([tugplan-focus-language.md](tugplan-focus-language.md)): every `TugListView` cell renders inside a per-row `FocusModeContext` so in-row focusables join the row's descend scope; `TugButton` separated click-focus-refusal (`stealsFocusOnClick`, default false) from walk authoring (`focusGroup`/`focusOrder`/`focusPolicy`); the engine's act dispatch owns descend/ascend; and the confirm popover already anchors to the row's trash button by DOM query. This phase connects the existing pieces and closes the one genuinely new gap: where the keyboard lands when a confirmed trash deletes the row that owns the descended scope.

#### Strategy {#strategy}

- **CSS first, behavior second.** The reveal change is appearance-only ([L06]) and lands as one primitive-level CSS + rename step, independently shippable and visible immediately.
- **Connect existing seams; add no new focus machinery.** TugIconButton forwards the focus-authoring props TugButton already has; TugListView relaxes one gate (Right-descend in single-select) and adds one symmetric branch (Left-ascend). No new engine projections, no new modes.
- **Enter's meaning is sacred.** In single-select pickers Enter remains "pick / fall through to the surface default (Open)". Only ArrowRight gains the descend meaning; `currentItemDescendable` stays false for single-select so the engine's Enter-descend never fires there.
- **The picker is the proving consumer, not the scope.** Changes land in the primitives (`tug-list-row`, `tug-icon-button`, `tug-list-view`); the picker cells just author their buttons. Any other list adopts by passing one prop.
- **The post-trash landing is the only stateful new behavior** — a reconciliation in TugListView keyed on the descended row's stable data-source id, so deletion of the descended row ascends cleanly to a surviving neighbor.
- **One end-to-end app-test** pins the whole keyboard journey against the real app per the test-reality rule; no fake-DOM or mock-store tests.

#### Success Criteria (Measurable) {#success-criteria}

- Arrowing onto a non-live session row in the picker makes its trash button visible with no pointer involvement (app-test asserts computed `opacity: 1` on the trailing slot of the cursor row, and `opacity: 0` on a non-cursor, non-selected, non-hovered row).
- ArrowRight on that row lands the engine key view on the trash button (`data-key-view-kbd` present on the button); Enter on the same row still triggers the picker's default action, not a descend (app-test).
- Space on the descended trash button opens the confirm popover anchored to that button (app-test).
- Confirming the trash deletes the session and lands the keyboard cursor on the nearest surviving row with the list container holding the key view and the ring painted (app-test).
- ArrowLeft and Escape from the descended accessory both return the key view to the list container with the cursor preserved (app-test).
- No occurrence of `data-reveal="hover"` or `trailingReveal="hover"` remains in the tree (`rg` returns empty).
- `bunx tsc --noEmit` clean; the existing focus-family app-tests (at0117, at0118, at0120, at0140, at0143, at0145) stay green.

#### Scope {#scope}

1. Rename the `TugListRow` trailing reveal value `"hover"` → `"engaged"` and extend its CSS to reveal on row selection (`data-selected="true"`) and keyboard cursor (`data-key-cursor` on the cell wrapper), in addition to hover and focus-within.
2. Forward `focusGroup` / `focusOrder` / `focusPolicy` from `TugIconButton` to its underlying `TugButton`, making in-row icon buttons authorable as engine focusables while keeping click-focus refusal.
3. Allow ArrowRight to descend a single-select `TugListView` row that carries a focusable accessory; keep Enter as pick/passthrough in single-select.
4. ArrowLeft from a descended row scope ascends back to the list (symmetric with Right-descend; Escape continues to ascend).
5. Author the picker's two trash buttons (Recents `PathRecentCell`, Sessions `SessionResumeCell`) into their rows' focus scopes.
6. Post-delete focus landing: when the descended row's data-source row disappears, pop the row scope and land the cursor on the nearest surviving cursorable row (committing it in single-select); handle the deleted-last-row and emptied-list cases.

#### Non-goals (Explicitly out of scope) {#non-goals}

- The picker footer's "move all sessions to trash" button — it is a normal cycle stop outside the list rows; nothing changes for it.
- Arrow movement *between* multiple accessories within one descended row (Tab/Shift+Tab already walk the row scope; the picker rows have exactly one focusable accessory). Left always ascends.
- Spatial-order authoring for row scopes (rings/seams) — the row scope stays orderless; `moveKeyViewSpatial` correctly yields there.
- Re-mapping a descended row scope when the row *survives* but its index shifts (no current flow produces this; see [R04]).
- Reveal-on-engagement for non-`TugListRow` accessory patterns (e.g. transcript block affordances).

#### Dependencies / Prerequisites {#dependencies}

- The focus-language phase's descend model: per-row `FocusModeContext` in `TugListView`, `manager.pushFocusMode(rowScopeId, { trapped: false })`, engine-owned Escape-ascend (`focus-manager.ascend()`), and the act dispatch in `responder-chain-provider.tsx`. All shipped.
- `TugButton`'s split focus axes (`stealsFocusOnClick` vs `focusGroup` authoring). Shipped.
- The dev-card picker's trash flow (`request-trash-session` / `request-trash-recent` chain actions, anchored `TugConfirmPopover`, `data-pending-trash`). Shipped.

#### Constraints {#constraints}

- Tuglaws: [L01] one render; [L02] external state via `useSyncExternalStore` only; [L03] `useLayoutEffect` for registrations events depend on; [L06] appearance via CSS + DOM attributes, never React state. Cross-checked per the tuglaws rule; the commit messages name the laws touched.
- Picker cells stay pure renderers (dev-picker-redesign [D17]): no new hooks in cells beyond what `TugIconButton` already encapsulates.
- `-D warnings`-grade hygiene on the TS side: `bunx tsc --noEmit` must stay clean at every step.
- App-tests run via `just app-test <file>` and end with a greppable `VERDICT: PASS|FAIL` line; no hand-rolled `bun test` with `TUGAPP_*` env vars.
- HMR serves tugdeck — no manual builds in checkpoints.

#### Assumptions {#assumptions}

- `moveKeyViewSpatial("left")` returns `false` in a descended row scope (no declared spatial order, no cursor handle on a leaf button), so a bare ArrowLeft falls through the document-level arrow navigator to `TugListView`'s own capture handler. (Verified by reading `focus-manager.ts` `moveKeyViewSpatial`; pinned by the at0163 app-test.)
- A descended trash button needs no `behavior` declaration: Space activates natively on the DOM-focused `<button>` (the act dispatch leaves leaves alone), and Enter activates through the bubble Stage-2 refusing-button branch (`activeIsRefusingButton` → synthetic click + `preventDefault`), which routes Enter to the focused refusing button instead of the sheet's default button. (Verified by reading `responder-chain-provider.tsx` Stage-2.)
- The Sessions list's "New session" row and live-session rows have no focusable accessory (live rows render a badge, trash suppressed), so Right is naturally inert on them via the `rowFirstFocusableId !== null` gate.

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

Cite plan-local decisions `[P01]`–`[P0n]` (use `P`, never `D`), open questions `[Q01]`, risks `R01`, and step anchors `#step-n`. Global laws/decisions are `[Lnn]`/`[Dnn]` (referenced, not owned here). Never cite line numbers — add an anchor.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Should ArrowLeft ascend from a descended row scope? (DECIDED) {#q01-left-ascend}

**Question:** Escape already ascends a descended non-trapped scope. Does ArrowLeft gain the same meaning inside a descended list row?

**Resolution:** DECIDED (user, 2026-06-10) — yes; Right in, Left out is the tree-disclosure symmetry. See [P04].

#### [Q02] Is selected-reveal acceptable in multi-select lists? (DECIDED) {#q02-multiselect-fanout}

**Question:** "Selected reveals trailing" means a multi-select list with five selected rows shows five trash icons at once.

**Resolution:** DECIDED (user, 2026-06-10) — acceptable design; selected = engaged. See [P01].

#### [Q03] Rename the reveal value or keep `"hover"` with broader docs? (DECIDED) {#q03-reveal-rename}

**Question:** `trailingReveal="hover"` becomes a lie once the accessory also reveals on selection and cursor.

**Resolution:** DECIDED (user, 2026-06-10) — rename to `"engaged"`. See [P01].

#### [Q04] Where does focus land after a confirmed trash deletes the descended row? (DECIDED) {#q04-post-trash-landing}

**Question:** The confirm deletes the row that owns the descended scope and the popover's restore target.

**Resolution:** DECIDED (user, 2026-06-10) — ascend the row scope and put the cursor on the nearest surviving row; handle the last-row case. See [P05].

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| ArrowLeft intercepted upstream of the list handler | med | low | Verified fall-through by code reading; at0163 pins it | Left stops ascending after navigator changes |
| Popover pop and row-scope reconciliation race on confirm | low | med | Reconciliation triggers on data AND mode-stack changes, acts only when the row scope is top — final writer by construction | Ring vanishes after confirm-trash |
| A missed `data-reveal="hover"` selector permanently hides an accessory | med | low | Grep checkpoint in #step-1 (zero remaining occurrences) | Any invisible trailing accessory |
| Registered trash buttons leak into the picker's Tab cycle | high | low | Buttons register under the row's `FocusModeContext`, not the cycle's mode; at0163 asserts Tab order unchanged | Tab lands on a trash icon |

**Risk R01: ArrowLeft falls through as designed** {#r01-left-falls-through}

- **Risk:** While descended, ArrowLeft passes `arrowNavListener` (spatial navigator yields: no order, no cursor handle), the keybinding map, and the act dispatch before reaching `TugListView`'s capture handler — a future binding or navigator change could consume it first.
- **Mitigation:** at0163 asserts the full Left-ascend journey in the real app; the list handler's branch is gated narrowly (top mode is one of this list's row scopes) so it never competes outside descend.
- **Residual risk:** A future *global* bare-ArrowLeft keybinding would shadow the ascend; the dead-arrow dev-warning plus at0163 would surface it.

**Risk R02: Pop-ordering race between the popover's restore and the reconciliation** {#r02-pop-ordering-race}

- **Risk:** On confirm, two pops race. The likely ordering (async store deletion) is benign: the popover's trapped mode pops first (its captured key view — the trash button — is still mounted), the row unmounts later, and the reconciliation runs with the row scope on top. But if a store ever notifies *before* the popover finishes closing, the reconciliation would pop a **buried** row scope (no restore), and the popover's later pop would become the final writer — restoring a dead key view and stranding the ring.
- **Mitigation:** The reconciliation triggers on **both** data changes and mode-stack changes (`manager.subscribe`) and acts only when the recorded row scope is the **top** mode ([P05]). Whichever pop happens last, the reconciliation re-runs after it and lands the cursor — final writer by construction, not by ordering luck. Tests assert the final state (container key view, ring, cursor on neighbor).
- **Residual risk:** A one-frame ringless flash between the racing pops; cosmetic only.

**Risk R03: Reveal-rename regression surface** {#r03-rename-regression}

- **Risk:** The rename touches a string literal used as a CSS attribute selector in two stylesheets and a prop value in four components; a missed site silently keeps an accessory at `opacity: 0`.
- **Mitigation:** Single commit for the rename; checkpoint greps for both `data-reveal="hover"` and `trailingReveal="hover"` returning empty; no tests pin the old attribute (verified).
- **Residual risk:** None identified.

**Risk R04: Index-shifted surviving descended row (deferred non-goal)** {#r04-index-shift}

- **Risk:** The row-scope mode id and `FocusModeContext` value embed the row *index*; if the data source ever inserts/removes rows *above* a still-descended row, the pushed mode id goes stale.
- **Mitigation:** Out of scope ([#non-goals]) — no current flow mutates the picker lists mid-descend except deleting the descended row itself, which [P05] handles by ascending. The reconciliation triggers on the descended row id vanishing OR the cursor row's identity changing, so a stale scope cannot strand the keyboard.
- **Residual risk:** A future live-updating multi-select list would need id-keyed (not index-keyed) row scopes; revisit then.

---

### Design Decisions {#design-decisions}

#### [P01] Trailing reveal value is `"engaged"`: hover, focus-within, selected, or key-cursor (DECIDED) {#p01-engaged-reveal}

**Decision:** Rename `TugListRowTrailingReveal`'s `"hover"` value to `"engaged"` and extend the reveal CSS so the trailing accessory is visible when the row is hovered, holds focus within, is selected (`.tug-list-row[data-selected="true"]`), or sits under the keyboard movement cursor (`.tug-list-view-cell[data-key-cursor] .tug-list-row`). `"always"` is unchanged and stays the default.

**Rationale:**
- Keyboard users must *see* the affordance Right will reach; selection and cursor are the keyboard's "approach", exactly as hover is the pointer's.
- Selected = engaged generalizes correctly to multi-select fan-out ([Q02]).
- The honest name survives the semantic widening ([Q03]).

**Implications:**
- Appearance-only: CSS + existing DOM attributes, no new React state ([L06]).
- The selected trigger keys off the *row's* `data-selected` (works for `TugListRow` used outside `TugListView`, e.g. the permissions rules list); the cursor trigger keys off the cell wrapper's `data-key-cursor` (only meaningful inside a list view, where the wrapper exists).
- All `"hover"` call sites and both stylesheets' `[data-reveal="hover"]` selectors rename in one commit ([R03]).

#### [P02] TugIconButton forwards focus authoring; click-refusal untouched (DECIDED) {#p02-icon-button-authoring}

**Decision:** `TugIconButton` gains optional `focusGroup` / `focusOrder` / `focusPolicy` props forwarded verbatim to the underlying `TugButton`; `stealsFocusOnClick` remains unset (false).

**Rationale:**
- `TugButton` already separated the old `data-tug-focus="refuse"` bundle into independent axes — clicking still never yanks browser focus or promotes the chain, while authoring makes the button an engine focusable (`data-tug-focusable`) reachable by descend.
- The dev-picker-redesign [D16] contract ("focus-refusing in-list action") is preserved on the pointer axis and deliberately extended on the keyboard axis.

**Implications:**
- An authored in-row icon button registers under the row's `FocusModeContext`, so it joins the row's descend scope — never the surface's Tab cycle ("Tab never lands on an item" holds).
- The docstring's "focus-refusing" framing updates to name the two axes.

#### [P03] Single-select rows descend on ArrowRight only; Enter stays the pick (DECIDED) {#p03-right-descend-single-select}

**Decision:** Remove the `!singleSelect` gate from `TugListView`'s ArrowRight branch (the `rowFirstFocusableId(cur) !== null` check remains the real gate); leave `currentItemDescendable` false for single-select lists so the engine's Enter-descend never fires there.

**Rationale:**
- The original "picks are never descended" rule predates rows carrying real accessories; the accessory is the thing Right reaches, while Enter must keep committing the picker (Return = Open) — splitting the keys preserves both meanings without a flag.
- Multi-select lists are untouched (Right and Enter both descend, as today).

**Implications:**
- Rows without a focusable accessory still ignore Right (no horizontal movement in a vertical list).
- The picker's existing Enter-to-Open behavior is a regression-guard assertion in at0163.

#### [P04] ArrowLeft ascends a descended row scope (DECIDED) {#p04-left-ascend}

**Decision:** In `TugListView`'s capture-phase keydown handler, when the scroll container is *not* the key view but the engine's current (top) focus mode is one of this list's row scopes (`${focusableId}-row-` prefix), a bare ArrowLeft calls `manager.ascend()` and consumes the event.

**Rationale:**
- Tree-disclosure symmetry: Right in, Left out ([Q01]); Escape keeps its existing ascend meaning unchanged.
- The document-level spatial navigator provably yields this arrow in a row scope ([#assumptions], [R01]), so the list-local branch is the natural owner — no engine change.

**Implications:**
- Left ascends from *any* focusable in the row scope (with multiple accessories, Left does not move between them — Tab does; [#non-goals]).
- `ascend()` restores the container key view with the ring and preserves the cursor index (existing descend→ascend round-trip semantics).

#### [P05] Post-delete landing: ascend + cursor to nearest surviving row, committed in single-select (DECIDED) {#p05-post-delete-landing}

**Decision:** `TugListView` records the descended row's stable data-source id at descend time; a layout-effect reconciliation — triggered on **both** data changes and engine mode-stack changes (`manager.subscribe`) — detects the id vanishing while the row scope is pushed **and acts only when that row scope is the top mode**, then: pops the row scope back to the container (key view + ring on the container), clamps the cursor to the nearest surviving cursorable row (old index clamped into range, then nearest-cursorable resolution), scrolls it into view, and — in single-select — commits it (`selectCursorRow`), so selection lands where the eye does.

**Rationale:**
- Mac convention: deleting the selected item moves selection to its nearest neighbor; stranding the keyboard on a dead scope is the only alternative and is unacceptable ([Q04]).
- Keying on the row *id* (not index) distinguishes "row deleted" from "row scrolled out of the render window" — virtualized unmount must not ascend.
- Committing the landed row in single-select supersedes the form's interim selection fallback through the normal `delegate.onSelect` path — one writer, the list's own commit machinery.
- Gating on top-mode + subscribing to mode-stack changes makes the reconciliation the final writer in **every** pop ordering: if the popover's trapped mode is still above the row scope when the row vanishes, the reconciliation simply waits for that pop (it re-runs on the mode-stack change) and then lands the cursor ([R02]).

**Implications:**
- Emptied list: no cursorable row remains → the cursor clears and the container keeps the key view + ring (the Sessions list always retains "New session", so this is the Recents edge).
- The popover's own pop may transiently restore a dead key view first; the reconciliation re-runs after it and is the final writer by construction ([R02]).
- Mouse-initiated trash (no descend) is unaffected — the reconciliation is gated on the pushed row scope.
- In the Recents list, committing the landed neighbor rewrites the project-path input (the Recents delegate's `onSelect` fills the path). This is deliberate and consistent with that list's existing live-commit arrows — every arrow movement already rewrites the path — not a bug.

#### [P06] Picker trash buttons author into the row scope with a shared group constant (DECIDED) {#p06-picker-authoring}

**Decision:** `PathRecentCell` and `SessionResumeCell` pass a module-level `focusGroup` constant (e.g. `"picker-row-trash"`) with `focusOrder` 0 to their trash `TugIconButton`s; uniqueness comes from the per-row `FocusModeContext` (the mode, not the group, scopes the walk).

**Rationale:**
- Cells are pure renderers ([D17]); a module constant needs no hooks.
- The mode-scoped walk is the same mechanism the permissions add-rule form uses (authored into its accordion section's scope) — proven pattern.

**Implications:**
- Live-session rows keep `trash = null` → no focusable → Right inert, by construction.
- The Recents list gets the identical keyboard journey for free (its rows are also single-select with one trash accessory).

---

### Specification {#specification}

#### Interaction contract (the keyboard journey) {#interaction-contract}

With the key view on a picker list container (cursor on row *i*, a non-live session):

1. **↑/↓** move cursor + selection (single-select live commit, unchanged). The cursor row's trash is *visible* ([P01]).
2. **→** pushes the row scope (non-trapped), key view → trash button, ring on it; the accessory stays lit via `:focus-within`. ([P03])
3. **Space/Enter** on the button activates it → `request-trash-session` → confirm popover anchored to the button (unchanged flow). Mechanism differs by key: **Space** activates natively (DOM focus is on the button; the act dispatch leaves leaves alone). **Enter** rides the bubble Stage-2 refusing-button path — the button carries `data-tug-focus="refuse"` and holds DOM focus, so Stage-2 synthetically clicks *it* (not the sheet's Open default) and `preventDefault` stops double-fire.
4. **Confirm** → row deleted → reconciliation pops the row scope, cursor + selection land on the nearest surviving row, ring on the container. ([P05])
5. **Cancel / Escape in the popover** → popover pops, key view restores to the trash button (still mounted), row scope intact; **←/Escape** then ascend to the list. ([P04])
6. **Enter** on a row (not descended) still falls through to the picker's default action (Open). ([P03])

#### State Zone Mapping (tugdeck/tugways plans) {#state-zone-mapping}

| State | Zone (appearance / local-data / structure) | Mechanism | Law |
|-------|--------------------------------------------|-----------|-----|
| Accessory visibility (engaged reveal) | appearance | CSS over existing `data-selected` / `data-key-cursor` / `data-reveal` attributes | [L06] |
| Trash button engine registration | structure (focus engine) | `useFocusable` via TugButton's existing `focusGroup` authoring, under the row's `FocusModeContext` | [L03] |
| Descended-row stable id (for reconciliation) | local-data | `useRef` in TugListView, written at descend, cleared on ascend/pop | — |
| Post-delete cursor landing | structure (focus engine + cursor projection) | layout-effect reconciliation calling existing `popFocusMode` / `moveCursorTo` / `selectCursorRow` | [L03], [L06] |
| Row data (deletion) | external | existing ledger store via `useSyncExternalStore` at the list level (unchanged) | [L02] |

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files (if any) {#new-files}

| File | Purpose |
|------|---------|
| `tests/app-test/at0163-list-accessory-keyboard.test.ts` | End-to-end keyboard journey: reveal-on-cursor, Right-descend, Space→popover, confirm→landing, Left/Escape ascend, Enter-still-opens |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `TugListRowTrailingReveal` | type | `tugdeck/src/components/tugways/tug-list-row.tsx` | `"always" \| "hover"` → `"always" \| "engaged"` |
| `.tug-list-row-trailing[data-reveal="engaged"]` rules | CSS | `tugdeck/src/components/tugways/tug-list-row.css` | rename + selected/cursor reveal selectors ([P01]) |
| `TugIconButtonProps.focusGroup/focusOrder/focusPolicy` | props | `tugdeck/src/components/tugways/tug-icon-button.tsx` | forwarded to TugButton ([P02]) |
| ArrowRight branch gate | fn (keydown handler) | `tugdeck/src/components/tugways/tug-list-view.tsx` | drop `!singleSelectRef.current` ([P03]) |
| ArrowLeft ascend branch | fn (keydown handler) | `tugdeck/src/components/tugways/tug-list-view.tsx` | new, gated on this list's pushed row scope ([P04]) |
| descended-row id ref + reconciliation effect | ref + layout effect | `tugdeck/src/components/tugways/tug-list-view.tsx` | [P05] |
| `PICKER_ROW_TRASH_FOCUS_GROUP` | const | `tugdeck/src/components/tugways/cards/dev-picker-cells.tsx` | shared group for both cells ([P06]) |
| `[data-reveal="hover"]` selector | CSS | `tugdeck/src/components/tugways/cards/dev-card.css` | rename to `"engaged"`; pending-trash overrides otherwise unchanged |
| `trailingReveal="hover"` call sites | props | `dev-picker-cells.tsx`, `permission-rules-editor.tsx`, `gallery-tug-list-row.tsx` | rename to `"engaged"` (incl. gallery prose/snippet) |

---

### Documentation Plan {#documentation-plan}

- [ ] `tug-list-row.tsx` module docstring + `trailingReveal` prop docs: the engaged-reveal triggers.
- [ ] `tug-icon-button.tsx` module docstring: two focus axes (click-refusal vs keyboard authoring).
- [ ] `tug-list-view.tsx` keydown-handler comments: Right-descend in single-select, Left-ascend, post-delete landing.
- [ ] Gallery `gallery-tug-list-row.tsx` reveal demo prose updated to `"engaged"`.

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **App-test (real app)** | The full keyboard journey against the running app — the only honest proof of focus/visibility behavior | at0163 (new); at0117/at0118/at0120/at0140/at0143/at0145 as regression guards |
| **Static sweep** | Rename completeness | `rg` for the old value in the #step-1 checkpoint |
| **Type check** | API surface integrity | `bunx tsc --noEmit` at every step |

#### What stays out of tests {#test-non-goals}

- Fake-DOM render tests of the reveal CSS — banned pattern; the app-test asserts computed opacity in the real app.
- Mock-store call-count tests of the trash dispatch — banned pattern; the journey test observes the real ledger-backed row disappearing.
- Unit tests of `moveKeyViewSpatial`'s yield in row scopes — already covered by the engine's existing spatial tests; the fall-through is pinned end-to-end by at0163.

---

### Execution Steps {#execution-steps}

> **Commit after all checkpoints pass.** Commits land on the working branch per the session's dash-vs-main choice; messages name the tuglaws touched.

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Engaged reveal: rename + selected/cursor triggers | done | a7886789 |
| #step-2 | TugIconButton focus authoring | done | 65051caa |
| #step-3 | TugListView: Right-descend in single-select, Left-ascend | done | 051356bd |
| #step-4 | Author the picker trash buttons | done | bab48a71 |
| #step-5 | Post-delete focus landing | done | bad21bfc |
| #step-6 | at0163 journey test + integration checkpoint | done | 15c01ba6 |

#### Step 1: Engaged reveal — rename `"hover"` → `"engaged"`, reveal on selected + cursor {#step-1}

**Commit:** `tugways(list-row): trailing reveal on engagement — rename "hover" → "engaged", reveal on selected/cursor rows [L06]`

**References:** [P01] engaged reveal, [Q02], [Q03], Risk R03, (#interaction-contract, #state-zone-mapping)

**Artifacts:**
- `TugListRowTrailingReveal` = `"always" | "engaged"`; prop docs + module docstring updated.
- `tug-list-row.css`: `[data-reveal="engaged"]` base rule plus reveal selectors for `:hover`, `:focus-within`, `.tug-list-row[data-selected="true"]`, and `.tug-list-view-cell[data-key-cursor] .tug-list-row`.
- Renamed call sites: `dev-picker-cells.tsx` (×2), `permission-rules-editor.tsx` (×1), `gallery-tug-list-row.tsx` (prop + prose/snippet), `dev-card.css` (`[data-reveal="hover"]` selector + comment).

**Tasks:**
- [ ] Rename the type value, the `data-reveal` projection, and every call site.
- [ ] Add the two new reveal selectors to `tug-list-row.css`.
- [ ] Update `dev-card.css`'s pending-trash override selector to the new value (behavior unchanged).

**Tests:**
- [ ] None new in this step (appearance-only; pinned by at0163 in #step-6).

**Checkpoint:**
- [ ] `rg -n 'data-reveal="hover"|trailingReveal="hover"' tugdeck/` returns empty.
- [ ] `cd tugdeck && bunx tsc --noEmit` clean.
- [ ] By eye (HMR): selected recents/session rows show their trash without hover; gallery reveal demo still works.

---

#### Step 2: TugIconButton focus authoring {#step-2}

**Commit:** `tugways(icon-button): forward focusGroup/focusOrder/focusPolicy — keyboard-authorable, still click-focus-refusing [L19]`

**References:** [P02] icon-button authoring, (#symbols)

**Artifacts:**
- `TugIconButtonProps` gains optional `focusGroup` / `focusOrder` / `focusPolicy`, forwarded to `TugButton`; docstring names the two focus axes.

**Tasks:**
- [ ] Add + forward the three props; leave `stealsFocusOnClick` untouched.
- [ ] Update the module docstring ("focus-refusing" → the two-axis framing).

**Tests:**
- [ ] None new (prop pass-through; behavior pinned end-to-end in #step-6).

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit` clean.
- [ ] An unauthored TugIconButton renders without `data-tug-focusable` (by eye in gallery / dev tools) — no registration unless opted in.

---

#### Step 3: TugListView — Right-descend in single-select, Left-ascend {#step-3}

**Depends on:** #step-2

**Commit:** `tugways(list-view): Right descends single-select rows with focusable accessories; Left ascends the row scope [L03]`

**References:** [P03] right-descend, [P04] left-ascend, [Q01], Risk R01, (#interaction-contract, #assumptions)

**Artifacts:**
- ArrowRight branch: `!singleSelectRef.current` gate removed; comment updated (Enter stays the pick in single-select — `currentItemDescendable` untouched).
- New ArrowLeft branch: when the container is not the key view and `manager.currentFocusMode()` starts with this list's `${focusableId}-row-` prefix, a bare ArrowLeft (no modifiers, non-editable target) calls `manager.ascend()` and consumes the event.

**Tasks:**
- [ ] Relax the Right gate; keep the `rowFirstFocusableId(cur) !== null` condition.
- [ ] Add the Left-ascend branch ahead of the existing key-view early-return in the capture handler.

**Tests:**
- [ ] None new in this step (no consumer registers an accessory until #step-4; journey pinned in #step-6).

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit` clean.
- [ ] `just app-test at0120-accordion-focus.test.ts` and `just app-test at0143-descend-escape-ascend.test.ts` → `VERDICT: PASS` (multi-select descend untouched).

---

#### Step 4: Author the picker trash buttons into their row scopes {#step-4}

**Depends on:** #step-2, #step-3

**Commit:** `tugdeck(dev-picker): author Recents/Sessions trash buttons into row focus scopes — Right reaches the trash [L03]`

**References:** [P06] picker authoring, [P02], [P03], (#interaction-contract)

**Artifacts:**
- `PICKER_ROW_TRASH_FOCUS_GROUP` module constant in `dev-picker-cells.tsx`; both trash `TugIconButton`s pass it with `focusOrder` 0.

**Tasks:**
- [ ] Add the constant and the props to `PathRecentCell` and `SessionResumeCell`.
- [ ] Confirm live-session rows still render no trash (no change needed; assert by eye).

**Tests:**
- [ ] None new in this step (the full journey lands in #step-6).

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit` clean.
- [ ] By eye (HMR): arrow onto a session row → trash visible; Right → ring on trash; Space → popover; Escape ×2 → back on the list; Tab order through the picker unchanged (trash never a Tab stop).
- [ ] `just app-test at0140-cycle-devcard.test.ts` → `VERDICT: PASS`.

---

#### Step 5: Post-delete focus landing {#step-5}

**Depends on:** #step-4

**Commit:** `tugways(list-view): land the cursor on the nearest surviving row when the descended row is deleted [L03] [L06]`

**References:** [P05] post-delete landing, [Q04], Risks R02, R04, (#state-zone-mapping, #interaction-contract)

**Artifacts:**
- Descend records the row's stable data-source id (ref); ascend/pop clears it.
- A layout-effect reconciliation triggered on **both** data-source changes and engine mode-stack changes (`manager.subscribe`): recorded id absent from the data source (`idForIndex` sweep) **and the recorded row scope is the top mode** → `popFocusMode` the row scope, clamp the old cursor index into range, resolve the nearest cursorable row, `moveCursorTo` + scroll, commit it when single-select; emptied list → clear cursor, container keeps key view + ring. When the row vanishes while the popover trap is still above the row scope, the reconciliation defers — the mode-stack subscription re-runs it after the popover pops, so it is the final writer in every ordering ([R02]).

**Tasks:**
- [ ] Record/clear the descended row id around `descendCursorRow` / ascend / scope pop.
- [ ] Implement the reconciliation effect with both triggers (data subscription + `manager.subscribe`); gate the action on the recorded row scope being the top mode; ensure it is inert when no row scope is pushed (mouse-trash flow untouched).
- [ ] Verify both pop orderings land identically: popover-pops-first (async store, the common case) and row-vanishes-first (reconciliation defers until the popover's pop) — final state is container key view + ring + cursor on neighbor ([R02]).

**Tests:**
- [ ] Covered by at0163 in #step-6 (deleting mid-list, last-row, and selected-row cases).

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit` clean.
- [ ] By eye (HMR): descend → Space → confirm on a mid-list session lands cursor+selection on the neighbor with the ring on the list; same journey on the last row lands on the new last row.

---

#### Step 6: at0163 journey test + integration checkpoint {#step-6}

**Depends on:** #step-1, #step-4, #step-5

**Commit:** `test(app): at0163 — list-row accessory keyboard journey (reveal, descend, act, landing, ascend)`

**References:** [P01]–[P06], Risks R01–R03, (#success-criteria, #interaction-contract, #test-non-goals)

**Artifacts:**
- `tests/app-test/at0163-list-accessory-keyboard.test.ts` exercising the real picker: seeded sessions, keyboard-only journey, greppable `VERDICT: PASS|FAIL`.

**Tasks:**
- [ ] Park the OS pointer away from the picker window (or assert on a row provably outside the pointer position) before sampling computed styles — a resting pointer over the list would contaminate the `opacity: 0` assertion via `:hover`.
- [ ] Seed at least three non-live sessions so the mid-list, last-row, and selected-row deletion cases are all exercisable.
- [ ] Assert: cursor row's trailing slot computed `opacity: 1`; a non-engaged row's `opacity: 0`.
- [ ] Assert: Right lands `data-key-view-kbd` on the trash button; Tab from the list container never lands on a trash button; Enter on a row triggers the picker default (not descend).
- [ ] Assert: Space opens the confirm popover; cancel restores the trash key view; Left and Escape each ascend to the container with the cursor preserved.
- [ ] Assert: confirm deletes the row and lands cursor + selection on the nearest surviving row, ring on the container; repeat for the last row.

**Tests:**
- [ ] at0163 (new, above).
- [ ] Regression sweep: at0117, at0118, at0120, at0140, at0143, at0145.

**Checkpoint:**
- [ ] `just app-test at0163-list-accessory-keyboard.test.ts` → `VERDICT: PASS`.
- [ ] `just app-test` sweep of the six regression guards → all `VERDICT: PASS`.
- [ ] `cd tugdeck && bunx tsc --noEmit` clean.

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** List-row trailing accessories participate in the keyboard focus language end to end — visible on row engagement, reachable with ArrowRight, actionable with Space, exited with ArrowLeft/Escape, with a deliberate cursor landing after the accessory deletes its own row — shipped in the primitives and proven on the dev-card session picker.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] All #success-criteria hold (at0163 + grep + tsc as listed).
- [ ] No `"hover"` reveal value remains anywhere in the tree.
- [ ] The six focus-family regression app-tests pass unchanged.

**Acceptance tests:**
- [ ] at0163-list-accessory-keyboard (`VERDICT: PASS`).
- [ ] at0117 / at0118 / at0120 / at0140 / at0143 / at0145 (`VERDICT: PASS`).

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] Id-keyed (not index-keyed) row focus scopes for live-updating multi-select lists ([R04]).
- [ ] Arrow movement between multiple accessories within one descended row, if a consumer ever has two.
- [ ] Engaged-reveal adoption for non-`TugListRow` accessory patterns (transcript block affordances).

| Checkpoint | Verification |
|------------|--------------|
| Engaged reveal complete | `rg 'data-reveal="hover"\|trailingReveal="hover"' tugdeck/` empty |
| Keyboard journey | `just app-test at0163-list-accessory-keyboard.test.ts` → `VERDICT: PASS` |
| No focus-family regressions | six guard app-tests → `VERDICT: PASS` |
| Types clean | `cd tugdeck && bunx tsc --noEmit` |
