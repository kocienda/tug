<!-- devise-skeleton v4 -->

## TugListView Consumer Modernization {#listview-modernization}

**Purpose:** Bring every `TugListView` consumer in the codebase onto one consistent row model — `TugListRow` for row content, the primitive's own selection/hover/disabled ramp, and a documented set of house rules — eliminating the three divergent row implementations and the duplicated selection CSS that exist today.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-06-01 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

`TugListView` is the framework's one list primitive, and `TugListRow` (recently uplifted: `TugLabel` text, a four-state selection ramp, accent border, separators, a reserved checkmark column) is its intended row. But an audit of every consumer shows **three different ways a list row gets drawn**, with no governing convention:

1. **Modern** — `TugListRow` with `title` / `subtitle` (the `TugLabel` path). Used by the picker/listing sheets.
2. **Escape-hatch** — `TugListRow` with `children`, bypassing `TugLabel` styling entirely.
3. **Hand-rolled** — bespoke `<div>` cells that **do not use `TugListRow` at all** and **reimplement the selection / hover / disabled ramp in their own CSS** (`dev-card-picker-session-option` in `dev-card.css`, reused by the session picker and the rewind sheet).

The visible symptom: the session picker looks identical after the `TugListRow` uplift, because its rows never go through `TugListRow`. The structural symptom: a parallel selection system (`.dev-card-picker-session-option[data-selected]` → `--tug7-surface-selection-primary-normal-plain-rest`, hover → `ghost-action-hover`, disabled → `opacity: 0.55`) that duplicates — and will silently drift from — the primitive. Plus ~676 lines of bespoke row CSS in the tool-output body-kinds. This plan inventories all of it and converges it.

#### Strategy {#strategy}

- **Govern first.** Write the house rules (when to use `TugListRow` vs a custom cell, selection-ownership matrix, `rowLayout` / read-only / checkmark conventions) into the tuglaws so "modern" has a definition the codebase can be held to.
- **Fix the worst offenders next.** Migrate the hand-rolled `dev-card-picker-session-option` cells (session picker + rewind) to `TugListRow` and **delete the duplicated selection CSS** — this is the biggest consistency + correctness win and resolves the visible regression.
- **Reclaim the escape-hatch cells.** Route the `children`-based cells (recents, permission-rule matcher) through the structured path where the content is text; keep `children` only where content is genuinely rich (and document why).
- **Sweep the modern tier for consistency.** Confirm the already-`TugListRow` sheets use the knobs uniformly (read-only via `interactive={false}`, single-select via `selectedGlyph`, one `rowLayout` house style, one separator policy).
- **Decide the body-kinds explicitly.** The tool-output blocks (path-list, todo-list, search-result) are dense, specialized rows — either adopt `TugListRow` (via `children`) or formally classify them as a sanctioned custom-cell exception; either way, stop them from re-implementing tokens ad hoc.
- **Document the transcript as the sanctioned exception.** The Dev transcript's streaming turn cells are legitimately custom; name that explicitly so it isn't read as another inconsistency.
- **Token/CSS only where possible; no behavior changes.** Selection ownership, data sources, and windowing are unchanged; this is a presentation-convergence phase.

#### Success Criteria (Measurable) {#success-criteria}

- A `TugListView` usage house-rules section exists in `tuglaws/` and is linked from `component-authoring.md` (verify: file + link present).
- No consumer CSS reimplements the list-row selection/hover/disabled ramp: `grep -rn "data-selected" tugdeck/src/components/tugways/cards/*.css tugdeck/src/components/tugways/body-kinds/*.css` returns only intentional, documented exceptions (target: the `dev-card-picker-session-option` selection/hover/disabled rules are deleted).
- The session picker and rewind sheet render their rows through `TugListRow` (verify: `SessionNewCell`, `SessionResumeCell`, `RewindTurnCell` compose `<TugListRow`; `data-session-id` / `data-testid` preserved so app-tests still pass).
- Every interactive single-select list with a checkmark uses `selectedGlyph` (no hand-rolled check holders remain: grep returns none).
- Every read-only listing passes `interactive={false}`; every `children`-using cell has a one-line comment justifying the escape hatch.
- `cd tugdeck && bun test src/components/tugways` and `bun run check` pass; the existing picker/rewind app-tests (`at0096`, session/rewind suites) pass.

#### Scope {#scope}

1. House-rules governance doc + `component-authoring.md` link.
2. Migrate hand-rolled cells (session picker, rewind) → `TugListRow`; delete duplicated selection CSS.
3. Reclaim escape-hatch cells (recents, permission-rule matcher) where text-based.
4. Consistency sweep of the modern tier (knobs uniform).
5. Body-kinds decision (migrate or formally exempt) + token hygiene.
6. Document the transcript as the sanctioned custom-cell consumer.

#### Non-goals (Explicitly out of scope) {#non-goals}

- Re-architecting `TugListView` windowing, the data-source/delegate contracts, or `selectionRequired`.
- Migrating the Dev transcript's streaming turn cells to `TugListRow` (they are the documented rich-content exception).
- Visual redesign beyond convergence — the goal is consistency, not a new look (the `TugListRow` ramp is the look).
- Changing the recents search-highlight behavior or the RTL middle-ellipsis path rendering.

#### Dependencies / Prerequisites {#dependencies}

- The completed `TugListRow` uplift (`TugLabel` text, selection ramp, `selectedAccent`, `rowSeparator`, `selectedGlyph`) — already on `main`.
- Existing app-tests covering the pickers / rewind (`tests/app-test/`) as the migration safety net.

#### Constraints {#constraints}

- Tuglaws: [L06] appearance via CSS/DOM; [L15] token-driven state visuals; [L19] component authoring; [L20] component-token sovereignty; [L24] selection state ownership.
- No fake-DOM / mock-store tests. Real-app behavior (selection, trash, click) verified via `just app-test`; pure logic via `bun:test`.
- HMR is always running (no manual tugdeck builds); `tugcode` is unaffected.
- No plan numbers in code/comments/commits.

#### Assumptions {#assumptions}

- The session/rewind rows' data attributes (`data-session-id`, `data-state`, `data-pending-trash`, `data-testid`, `data-recent-path`) can be passed straight through `TugListRow`'s `...rest` spread, so app-test selectors survive migration.
- The recents path text (`<mark>` search highlights + RTL middle ellipsis) genuinely cannot be a plain-string `TugLabel` title, so `children` stays — but its typography can be unified with a shared token.
- The tool-output body-kinds may legitimately remain custom; the decision is made per-block in this plan, not assumed.

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

Explicit kebab-case anchors; steps cite `[P01]`, specs `S01`, tables `T01`, and `#anchors`; `**Depends on:**` uses `#step-N`. No line numbers.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Body-kinds: migrate to TugListRow or formally exempt? (OPEN) {#q01-body-kinds}

**Question:** Should `path-list-block`, `todo-list-block`, and `search-result-block` adopt `TugListRow` (via `children`), or be classified as a sanctioned dense-data custom-cell exception?

**Why it matters:** ~676 lines of bespoke row CSS. Migrating buys consistency but these rows are denser and more specialized (icons, match counts, monospace paths) than a title/subtitle row; a forced migration could regress their density.

**Options:** (a) migrate to `TugListRow` with `children` + shared tokens; (b) keep custom but route their colors through `--tugx-list-row-*`-aligned tokens and document the exemption.

**Plan to resolve:** Evaluate `todo-list-block` against `TugListRow` and compare cost before committing the other two.

**Resolution:** DECIDED — **exempt (option b)**. `todo-list-block`'s rows carry a per-status background band, strikethrough-on-completed text decoration, a live `TugProgressIndicator` ring icon, and per-status single-line-vs-wrap behavior; `path-list`/`search-result` are monospace paths and match-count layouts. Expressing these through `TugListRow` would require pervasive overrides into the primitive's title `TugLabel`, padding, and background — an [L20] violation — and regress the compact density these tool-output checklists depend on. They render `inline`, hold no selection (no ramp duplication), and their only state affordance is a `:hover` background from the shared `--tugx-block-row-hover-bg` token. Recorded as a sanctioned exception in `list-view-usage.md`. A throwaway migration spike was judged unnecessary — the status-band / strikethrough / live-ring / density evidence in the existing CSS is conclusive.

#### [Q02] `rowLayout` house style — flush everywhere, or keep pill for recents? (DECIDED) {#q02-rowlayout}

**Question:** Recents is `pill`; everything else is `flush`. Unify, or keep the exception?

**Resolution:** DECIDED (see [P03]). House style is **`flush` for in-sheet listings**; `pill` is reserved for free-standing, card-like rows outside a bordered list frame. Recents lives inside a bordered list frame, so it moves to `flush` for consistency unless the visual review in Step 5 shows the pill treatment is load-bearing — in which case the exception is documented inline.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Migrating session/rewind cells breaks app-test selectors | high | med | Pass through all `data-*` / `data-testid` via `TugListRow` `...rest`; run the picker/rewind app-tests in the same step | Any app-test red |
| Deleting `dev-card-picker-session-option` CSS drops a needed treatment (pending-trash, live badge) | med | med | Inventory every rule before deleting; re-express trash-reveal via `trailingReveal="hover"` + `data-pending-trash` kept on the row | Trash icon / badge regresses |
| Recents highlight (`<mark>`) lost when touching the cell | med | low | Keep `children` for recents; only unify typography token, never the markup | Search highlight disappears |
| Body-kinds density regresses under `TugListRow` | med | med | Spike one block first ([Q01]); compare before committing | Spike row taller/looser than today |

**Risk R01: App-test selector breakage on cell migration** {#r01-apptest-selectors}

- **Risk:** The session/rewind app-tests target `[data-session-id]`, `[data-testid="rewind-turn-row"]`, etc.; moving markup into `TugListRow` could drop them.
- **Mitigation:** `TugListRow` spreads `...rest` to its root `<div>`, so every `data-*` passes straight through. Migrate + run the app-test in the same step.
- **Residual risk:** Internal `-text` / `-title` child selectors, if any test uses them, must be repointed — caught by running the suite.

---

### Design Decisions {#design-decisions}

#### [P01] `TugListRow` is the only sanctioned row; custom cells are documented exceptions (DECIDED) {#p01-tuglistrow-default}

**Decision:** Every `TugListView` cell renderer composes `TugListRow` for its row chrome. A cell may render fully custom markup **only** when its content is not a row (rich streaming content, dense tabular data) and it carries an inline comment naming it a sanctioned exception per the house rules.

**Rationale:**
- One row implementation means one selection/hover/disabled/accent/separator behavior — the "control" the codebase is missing.
- The transcript and (pending [Q01]) the body-kinds are the only genuine non-row content.

**Implications:**
- Hand-rolled `dev-card-picker-session-option` / `rewind` cells migrate to `TugListRow`.
- A house-rules doc defines and enforces the convention.

#### [P02] No consumer reimplements the row state ramp (DECIDED) {#p02-no-duplicate-ramp}

**Decision:** Selection / hover / disabled visuals are the primitive's. Consumer CSS must not paint `[data-selected]` / `:hover` / `[data-disabled]` row backgrounds; it styles only consumer-specific affordances (trash reveal, badges).

**Rationale:**
- `dev-card-picker-session-option` duplicates the exact tokens `TugListRow` now owns, so it will drift and won't pick up the selected-hover / accent improvements.

**Implications:**
- The `dev-card-picker-session-option` selection/hover/disabled rules are deleted; what remains is trash-affordance + layout only.

#### [P03] House style: `flush` listings, `selectedGlyph` for single-select, `interactive={false}` for read-only (DECIDED) {#p03-house-style}

**Decision:** In-sheet listings use `rowLayout="flush"`; single-select-with-check lists use `selectedGlyph="check"` (never a hand-rolled holder); read-only listings pass `interactive={false}`; selection ownership follows the matrix in [S02].

**Rationale:**
- These conventions already hold for most modern sheets; codifying them closes the gaps (recents pill, hand-rolled checks).

**Implications:**
- The consistency sweep ([#step-5]) aligns the stragglers; the house-rules doc records the matrix.

#### [P04] `children` only for non-string content, always justified (DECIDED) {#p04-children-justified}

**Decision:** A cell uses `TugListRow`'s `children` escape hatch only when its primary content is not a plain string (e.g. `<mark>`-highlighted RTL path); such a cell carries a one-line comment and applies the shared title typography token so it still reads consistently.

**Rationale:**
- `children` silently bypasses `TugLabel`; unjustified use is how the recents/matcher cells drifted.

**Implications:**
- Recents + permission-rule matcher keep `children` (justified) but adopt a shared `--tugx-list-row-title-*` typographic treatment so size/weight match the structured path.

---

### Specification {#specification}

#### TugListView Consumer Inventory {#consumer-inventory}

**Table T01: Every `TugListView` consumer and its modernization tier** {#t01-inventory}

| Consumer (file) | List(s) | Cell impl today | Selection | Gap | Tier |
|---|---|---|---|---|---|
| `help-sheet` | 1 | `TugListRow` title/subtitle, `interactive={false}` | none (read-only) | none — confirm knobs | 1 |
| `agents-sheet` | 1 | `TugListRow` title/subtitle (2 variants), `interactive={false}` | none | none — confirm | 1 |
| `skills-sheet` | 1 | `TugListRow` title/subtitle + `leading`, `interactive={false}` | none | none — confirm | 1 |
| `memory-sheet` | 1 | `TugListRow` title/subtitle, interactive | consumer (`onSelect`) | none — confirm | 1 |
| `permission-mode-chip` | 1 | `TugListRow` title/subtitle + `leading` | consumer | could use `selectedGlyph` | 1 |
| `model-picker-sheet` | 1 | `TugListRow` title/subtitle + `selectedGlyph` | consumer | none (just migrated) | 1 |
| `effort-picker-sheet` | 1 | `TugListRow` title/subtitle + `selectedGlyph` | consumer | none (just migrated) | 1 |
| `permission-rules-editor` | 2 (allow/deny) | `TugListRow`: one structured, one `children` (matcher) | consumer | matcher cell bypasses `TugLabel` | 2 |
| `dev-picker-cells` → recents | 1 | `TugListRow` via `children` (RTL path + `<mark>`), `pill` | `selectionRequired` | `children` bypasses `TugLabel`; pill vs house style | 2 |
| `dev-picker-cells` → sessions | 1 | **hand-rolled** `dev-card-picker-session-option` divs, `flush` | `selectionRequired` + **custom CSS ramp** | not `TugListRow`; duplicate selection CSS | 3 |
| `rewind-sheet` (`RewindTurnCell`) | 1 | **hand-rolled**, reuses `dev-card-picker-session-option` classes | consumer | not `TugListRow`; duplicate CSS | 3 |
| `resume-sheet` | hosts recents+sessions (via `dev-picker-cells`) | — | — | fixed by the `dev-picker-cells` migration | 3 |
| `dev-card` | hosts recents+sessions | — | — | same | 3 |
| `path-list-block` | 1 | **hand-rolled** `tugx-paths-row`, `inline` | none | bespoke tool-output rows | 4 |
| `todo-list-block` | 1 | **hand-rolled** `tugx-todo-row`, `inline` | none | bespoke | 4 |
| `search-result-block` | 1 | **hand-rolled**, `inline` | none | bespoke | 4 |
| `dev-card-transcript` | 1 | custom `AssistantTurnCell` / turn cells (streaming), `inline`, `followBottom`, `pageByEntry` | none | **sanctioned exception** — rich content | 5 |

**Spec S01: Modernization tiers** {#s01-tiers}

- **Tier 1 — Modern.** Already on `TugListRow` title/subtitle; only a consistency confirm needed.
- **Tier 2 — Escape-hatch.** `TugListRow` but `children`; reclaim to structured where text, justify where not.
- **Tier 3 — Hand-rolled, duplicating the ramp.** Migrate to `TugListRow`, delete duplicated CSS. **Highest priority.**
- **Tier 4 — Bespoke tool-output.** Decide migrate-or-exempt ([Q01]).
- **Tier 5 — Sanctioned exception.** Document, do not migrate.

**Spec S02: Selection-ownership matrix** {#s02-selection-matrix}

| List intent | Mechanism | Example |
|---|---|---|
| Always exactly one selected (navigation/picker) | `selectionRequired` (list-view owned) | session picker, recents |
| Pick-to-confirm (commit on OK) | consumer-owned (`delegate.onSelect` → `useState`) | model / effort picker |
| Read-only display | none + `interactive={false}` | skills / agents / help |
| Tool-output display | none + `inline` | body-kinds |

#### State Zone Mapping (tugdeck/tugways) {#state-zone-mapping}

| State | Zone | Mechanism | Law |
|-------|------|-----------|-----|
| row selection/hover/disabled visuals | appearance | `TugListRow` CSS + `data-*` (consumer stops painting them) | [L06], [L15] |
| which component renders a row | structure | cell renderer composes `TugListRow` | [L19] |
| selection ownership | local-data | unchanged (`selectionRequired` / consumer `useState`) | [L24] |
| trash-reveal / pending-trash affordance | appearance | `trailingReveal="hover"` + `data-pending-trash` on the row | [L06] |

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tuglaws/list-view-usage.md` | House rules: when to use `TugListRow`, selection matrix ([S02]), `rowLayout`/read-only/checkmark conventions, the sanctioned-exception list |

#### Symbols to modify {#symbols}

| Symbol | Location | Change |
|--------|----------|--------|
| `SessionNewCell`, `SessionResumeCell` | `dev-picker-cells.tsx` | Compose `TugListRow` (title/subtitle/`trailing`/`selectionRequired` selected) |
| `RewindTurnCell` | `rewind-sheet.tsx` | Compose `TugListRow`; stop reusing `dev-card-picker-session-option` |
| `.dev-card-picker-session-option*` ramp rules | `dev-card.css` | Delete selection/hover/disabled rules ([P02]); keep trash/layout only |
| `PathRecentCell` | `dev-picker-cells.tsx` | Keep `children`; add justification comment + shared title token ([P04]); `rowLayout` per [P03]/[Q02] |
| permission-rule matcher cell | `permission-rules-editor.tsx` | Reclaim to structured where text; else justify ([P04]) |
| body-kind cells | `path-list-block.tsx`, `todo-list-block.tsx`, `search-result-block.tsx` | Per [Q01] outcome |

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When |
|----------|---------|------|
| **App-test (`just app-test`)** | Picker/rewind selection, trash, click still work after migration | Tier 3 steps |
| **Pure-logic (`bun:test`)** | Any new pure helper (e.g. row-model adapter) | As introduced |
| **Contract (`bun run check`)** | API/shape integrity | Every step |
| **Grep guards** | No duplicated `data-selected` CSS; no hand-rolled check holders | Verification |

#### What stays out of tests {#test-non-goals}

- Fake-DOM render tests for cells — banned; behavior verified via `just app-test`.
- Per-token color assertions — gallery-verified.
- Re-testing `TugListRow` itself — covered by its own suite.

---

### Execution Steps {#execution-steps}

> Commit after checkpoints pass. References mandatory. No plan numbers in code/commits.

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | House-rules doc + component-authoring link | done | fc55a368 |
| #step-2 | Migrate session picker cells to TugListRow | done | 2395ac74 (folded w/ #step-3) |
| #step-3 | Migrate rewind cell + delete duplicated selection CSS | done | 2395ac74 |
| #step-4 | Reclaim escape-hatch cells (recents, matcher) | done | 40e467a7 |
| #step-5 | Tier 1 consistency sweep (knobs uniform) | done | e0e5d8b3 |
| #step-6 | Body-kinds spike + decision (todo-list-block) | done | 63adc8ab (verdict: exempt) |
| #step-7 | Apply body-kinds decision to remaining blocks | done | a513d957 |
| #step-8 | Document transcript exception + final integration | done | (transcript doc in fc55a368; verification only) |

---

#### Step 1: House-rules doc + component-authoring link {#step-1}

**Commit:** `docs(tuglaws): TugListView consumer house rules`

**References:** [P01] (#p01-tuglistrow-default), [P02] (#p02-no-duplicate-ramp), [P03] (#p03-house-style), [P04] (#p04-children-justified), Spec S01 (#s01-tiers), Spec S02 (#s02-selection-matrix), Table T01 (#t01-inventory)

**Artifacts:**
- `tuglaws/list-view-usage.md` — the house rules, the selection matrix, the inventory + tier table, and the sanctioned-exception list (transcript; body-kinds pending [Q01]).
- `tuglaws/component-authoring.md` — a link to it under list/table guidance.

**Tasks:**
- [ ] Write the doc from [S01]/[S02]/[T01].
- [ ] Link it from `component-authoring.md`.

**Tests:**
- [ ] None (doc-only).

**Checkpoint:**
- [ ] `tuglaws/list-view-usage.md` exists and is linked from `component-authoring.md` (grep).

---

#### Step 2: Migrate session picker cells to TugListRow {#step-2}

**Depends on:** #step-1

**Commit:** `refactor(dev-card): session picker rows via TugListRow`

**References:** [P01] (#p01-tuglistrow-default), [P03] (#p03-house-style), Risk R01 (#r01-apptest-selectors), (#consumer-inventory)

**Artifacts:**
- `dev-picker-cells.tsx`: `SessionNewCell` / `SessionResumeCell` compose `TugListRow` (`title` = session name/snippet, `subtitle` = relative time · turns · id, `trailing` = trash `TugIconButton` with `trailingReveal="hover"`, `selected` from `selectionRequired`/context, `disabled` for live rows). All `data-*` / `data-testid` passed through `...rest`.

**Tasks:**
- [ ] Rewrite both cells on `TugListRow`; preserve every data attribute and the trash dispatch.
- [ ] Keep the `flush` + `selectionRequired` wiring at the list level.

**Tests:**
- [ ] `just app-test` for the session-picker suite (selection, open, trash) — `tail -n 1` shows `VERDICT: PASS`.

**Checkpoint:**
- [ ] `cd tugdeck && bun run check` clean; session app-test PASS; session rows visibly pick up the `TugLabel` title + selection ramp.

---

#### Step 3: Migrate rewind cell + delete duplicated selection CSS {#step-3}

**Depends on:** #step-2

**Commit:** `refactor(rewind): turn rows via TugListRow; drop duplicated selection CSS`

**References:** [P01] (#p01-tuglistrow-default), [P02] (#p02-no-duplicate-ramp), (#symbols)

**Artifacts:**
- `rewind-sheet.tsx`: `RewindTurnCell` composes `TugListRow` instead of `dev-card-picker-session-option` markup.
- `dev-card.css`: delete the `.dev-card-picker-session-option` selection/hover/disabled ramp rules ([P02]); keep only trash-reveal / badge / layout rules still in use (and only if still referenced after Step 2).

**Tasks:**
- [ ] Migrate `RewindTurnCell`; preserve `data-testid="rewind-turn-row"` + scope data.
- [ ] Inventory the `dev-card-picker-session-option` rules; delete the ramp; re-express trash-reveal via `trailingReveal` + `data-pending-trash`.

**Tests:**
- [ ] `just app-test` rewind suite — `VERDICT: PASS`.
- [ ] Grep: no `dev-card-picker-session-option[data-selected]` / `:hover` ramp rules remain.

**Checkpoint:**
- [ ] `bun run check` clean; rewind app-test PASS; `grep -rn "data-selected" dev-card.css` shows no row-ramp rules.

---

#### Step 4: Reclaim escape-hatch cells (recents, matcher) {#step-4}

**Depends on:** #step-1

**Commit:** `refactor(tugways): justify + unify TugListRow children cells`

**References:** [P04] (#p04-children-justified), [Q02] (#q02-rowlayout), (#consumer-inventory)

**Artifacts:**
- `dev-picker-cells.tsx` `PathRecentCell`: keep `children` (RTL path + `<mark>`), add the justification comment, apply the shared title typography token, set `rowLayout` per [P03]/[Q02].
- `permission-rules-editor.tsx`: route the text portion of the matcher cell through `title` where possible; if the matcher must stay `children`, add the justification comment + shared token.

**Tasks:**
- [ ] Apply shared title token to recents `children`; resolve [Q02] (flush vs pill) by visual review.
- [ ] Reclaim the matcher cell or justify it.

**Tests:**
- [ ] `just app-test` recents/permission suites — `VERDICT: PASS`.

**Checkpoint:**
- [ ] `bun run check` clean; recents highlight intact; both `children` cells carry a justification comment.

---

#### Step 5: Tier 1 consistency sweep (knobs uniform) {#step-5}

**Depends on:** #step-1

**Commit:** `refactor(tugways): uniform TugListView knobs across listing sheets`

**References:** [P03] (#p03-house-style), Spec S02 (#s02-selection-matrix), Table T01 (#t01-inventory)

**Artifacts:**
- The Tier 1 sheets (`help`, `agents`, `skills`, `memory`, `permission-mode-chip`): confirm `interactive={false}` on read-only lists, `selectedGlyph` where a single-select check belongs (e.g. `permission-mode-chip`), consistent `rowLayout`, and a single separator policy.

**Tasks:**
- [ ] Diff each Tier 1 sheet against the house rules; fix any straggler (no hand-rolled checks, read-only flagged, etc.).

**Tests:**
- [ ] `cd tugdeck && bun test src/components/tugways` passes.

**Checkpoint:**
- [ ] `bun run check` clean; grep shows no hand-rolled check holders anywhere; each list matches its [S02] row.

---

#### Step 6: Body-kinds spike + decision (todo-list-block) {#step-6}

**Depends on:** #step-1

**Commit:** `refactor(body-kinds): spike todo-list rows on TugListRow`

**References:** [Q01] (#q01-body-kinds), [P01] (#p01-tuglistrow-default)

**Artifacts:**
- `todo-list-block.tsx`: spike the rows onto `TugListRow` (`children` for the icon+text) and compare density / CSS-line delta against today; record the verdict inline + in the ledger.

**Tasks:**
- [ ] Implement the spike; measure density + removed CSS.
- [ ] Decide migrate-vs-exempt for the body-kinds; record in [Q01] resolution + the house-rules doc.

**Tests:**
- [ ] `just app-test` for a transcript containing a todo block (or the body-kind gallery) — `VERDICT: PASS`.

**Checkpoint:**
- [ ] `bun run check` clean; [Q01] resolved with a recorded verdict.

---

#### Step 7: Apply body-kinds decision to remaining blocks {#step-7}

**Depends on:** #step-6

**Commit:** `refactor(body-kinds): converge path-list + search-result per decision`

**References:** [Q01] (#q01-body-kinds) (resolved), [P02] (#p02-no-duplicate-ramp)

**Artifacts:**
- `path-list-block.tsx`, `search-result-block.tsx`: apply the Step 6 verdict (migrate to `TugListRow children`, or keep custom with tokens aligned to `--tugx-list-row-*` and a documented exemption).

**Tasks:**
- [ ] Apply the decision uniformly; align any remaining custom colors to shared tokens.

**Tests:**
- [ ] `just app-test` body-kinds coverage — `VERDICT: PASS`.

**Checkpoint:**
- [ ] `bun run check` clean; both blocks match the recorded decision; no ad-hoc row-state colors remain.

---

#### Step 8: Document transcript exception + final integration {#step-8}

**Depends on:** #step-2, #step-3, #step-4, #step-5, #step-7

**Commit:** `docs(tuglaws): record transcript as sanctioned custom-cell consumer`

**References:** [P01] (#p01-tuglistrow-default), (#success-criteria), (#exit-criteria)

**Artifacts:**
- `tuglaws/list-view-usage.md`: name `dev-card-transcript` (streaming turn cells) as the sanctioned rich-content exception, with the rationale.

**Tasks:**
- [ ] Add the exception note.
- [ ] Full-codebase verification pass against the success criteria.

**Tests:**
- [ ] `cd tugdeck && bun test src/components/tugways` passes.

**Checkpoint:**
- [ ] All success criteria met (grep guards clean; app-tests PASS; `bun run check` clean).

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** Every `TugListView` consumer renders rows through `TugListRow` (or a documented exception), with one selection ramp owned by the primitive, the duplicated `dev-card-picker-session-option` CSS deleted, and a house-rules doc that keeps it that way.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] `tuglaws/list-view-usage.md` exists, linked from `component-authoring.md`, listing the inventory + exceptions.
- [ ] Session picker + rewind rows render via `TugListRow`; their app-tests pass.
- [ ] No consumer CSS paints the row selection/hover/disabled ramp (grep).
- [ ] No hand-rolled check holders remain (grep).
- [ ] Every `children` cell is justified; every read-only list is `interactive={false}`.
- [ ] `cd tugdeck && bun test src/components/tugways` and `bun run check` pass.

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] Optional ESLint guard: flag a `TugListViewCellRenderer` that returns a non-`TugListRow` root without an exemption comment.
- [ ] Consider a `TugListRow` `titleContent` slot so rich titles (`<mark>` highlights) get `TugLabel` sizing without `children` — would let recents/matcher leave the escape hatch entirely.

| Checkpoint | Verification |
|------------|--------------|
| House rules | `tuglaws/list-view-usage.md` linked from component-authoring |
| Tier 3 migrated | session/rewind app-tests PASS; rows use `TugListRow` |
| No duplicate ramp | `grep data-selected` in card/body-kind CSS → only documented exceptions |
| Knobs uniform | each list matches its [S02] selection-matrix row |
