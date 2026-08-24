<!-- devise-skeleton v4 -->

## TugListView / TugListRow Beautification {#listview-beautification}

**Purpose:** Lift `TugListView` / `TugListRow` to parity with the rest of the Tug component family — legible `TugLabel`-driven text, a proper four-state selection ramp the list owns (distinct from popup menus), an optional accent selection border, configurable row separators, and a small set of standard row types with a first-class checkmark column.

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

`TugListView` / `TugListRow` are framework-level list primitives (UIKit `UITableView` / `UITableViewCell` lineage) used across the picker sheets — model, effort, agents, skills, memory, help, permission rules — and the Dev transcript. Visually they lag the rest of the component family. Concretely: row text is raw `<span>`s at `--tug-font-size-sm` / `-xs` rather than `TugLabel`, so it reads small and borderline-illegible and diverges from the app's text styling; the selected fill (`--tug7-surface-selection-primary-normal-plain-rest`) has no distinct *selected-and-hovered* state, so hovering a selected row reads identically to the resting selected row; there is no opt-in accent border for selection; the `flush` row divider is a hardcoded 1px hairline in `TugListView` with no thickness/color/off control; and every picker that needs a checkmark hand-rolls its own fixed-width check holder in the leading slot.

This phase fixes all of it as a coordinated uplift, sequenced so each sub-phase is independently shippable. The selection-color direction is settled: the list keeps **its own** selection color family (an improved translucent-blue ramp), explicitly *not* the popup-menu tokens (`accentSubtle` / `filled-action`). Density and text-size improvements are the highest-leverage slice and land first.

#### Strategy {#strategy}

- **Phase A — foundation (legibility + selection ramp).** Route all row text through `TugLabel`; bump the title to a legible size; give the list a real four-state selection ramp (rest → hover → selected → selected-hover) on its own token family, including a new `-hover` selection base token in both themes.
- **Phase B — accent border + separators.** Add an opt-in accent selection border (inset shadow on `flush` so selection moving never reflows row height; border-color swap on `pill`), and lift the divider into a `rowSeparator` prop on `TugListView` with thickness / color / none.
- **Phase C — standard row types + checkmark + migration.** Add a first-class `selectedGlyph` check column that reserves width (so titles align with or without the mark) and multiline subtitle support, then migrate the picker sheets off their hand-rolled check holders.
- **Token-driven throughout.** Every state visual is CSS + `data-` attribute, color-only transitions ([L06], [L15]); new component aliases resolve one hop to base ([L17]); new base tokens land in *both* `brio.css` and `harmony.css`.
- **Defaults stay byte-identical** where a prop is added (separators, accent border default off; omitting `rowLayout`/`rowSeparator` reproduces today's output) so existing consumers are visually unchanged except for the deliberate text-legibility bump.
- **Verification is gallery + pure-logic.** New branching logic is exported as pure resolvers with `bun:test` coverage; visuals are exercised in the Component Gallery under HMR. No fake-DOM render tests (banned).

#### Success Criteria (Measurable) {#success-criteria}

- All `TugListRow` text (title, subtitle) renders through `TugLabel`; no raw `<span class="tug-list-row-title">` / `-subtitle` text nodes remain in the component (verify: grep `tug-list-row.tsx` for `TugLabel`, no residual title/subtitle spans).
- Hovering a selected row produces a visibly different background than (a) a resting selected row and (b) a hovered-but-unselected row, for both `flush` and `pill` (verify: distinct CSS rules + gallery States section).
- A new `--tug7-surface-selection-primary-normal-plain-hover` token exists in `brio.css` **and** `harmony.css` (verify: grep both files).
- `TugListView` accepts `selectedAccent` and `rowSeparator`; with both omitted the rendered DOM/CSS is identical to today (verify: default-path gallery diff + `bun run check`).
- `TugListRow` accepts `selectedGlyph="check"` and renders a fixed-width, reserved check column; `model-picker-sheet` and `effort-picker-sheet` no longer hand-roll a check holder (verify: grep those files for the removed local check markup).
- `cd tugdeck && bun test src/components/tugways/__tests__/tug-list-row.test.ts` and the new list-view resolver test pass; `cd tugdeck && bun run check` is clean.

#### Scope {#scope}

1. `TugListRow` text via `TugLabel`, title size bump, multiline subtitle support.
2. List-owned four-state selection ramp + new selection-hover base token in both themes.
3. Optional accent selection border (`flush` inset shadow, `pill` border swap).
4. `rowSeparator` prop on `TugListView` (thickness / color / none), backed by tokens.
5. `selectedGlyph` reserved check column + standard one-/two-/multi-line row types.
6. Migration of `model-picker-sheet` and `effort-picker-sheet` to `selectedGlyph`.
7. Component Gallery coverage for every new knob.

#### Non-goals (Explicitly out of scope) {#non-goals}

- Re-theming or restyling the popup-button menus (`tug-menu.css`) — the decision is explicitly to *diverge* the list from the menu tokens, not to converge them.
- Changing `TugListView` windowing, selection ownership (`selectionRequired`), scroll, or data-source contracts.
- Migrating consumers beyond the two checkmark pickers (agents/skills/memory/help/permission-rules stay as-is; they may adopt the new row types in a follow-on).
- Any new React runtime state or store; this is a presentation/token phase.
- Dark/light or per-theme palette redesign beyond adding the one selection-hover token.

#### Dependencies / Prerequisites {#dependencies}

- Existing `TugLabel` primitive (size, emphasis, `maxLines`, ellipsis) — used as-is.
- Existing `--tug7-*` base tokens: `--tug7-surface-selection-primary-normal-plain-rest`, `--tug7-element-selection-text-normal-plain-rest`, `--tug7-element-tone-border-normal-accent-rest`, `--tug7-element-global-border-normal-muted-rest`.
- Theme files `tugdeck/styles/themes/brio.css` and `harmony.css` (hand-authored; edited directly).

#### Constraints {#constraints}

- Tuglaws: [L06] appearance via CSS/DOM, never React state; [L15] token-driven state visuals, color-only transitions; [L16] declared pairings; [L17] one-hop alias resolution; [L19] component authoring guide; [L20] component-token sovereignty.
- WARNINGS-ARE-ERRORS does not apply to tugdeck (that's the Rust workspace), but `bun run check` (tsc `--noEmit`) must stay clean.
- HMR is always running — no manual tugdeck builds; changes take effect on save.
- No fake-DOM / happy-dom render tests; no mock-store tests. Pure-logic `bun:test` + gallery only.
- No plan numbers / roadmap-step references in code, comments, or commit messages.

#### Assumptions {#assumptions}

- The deliberate title-size bump is acceptable to consumers; pickers are non-windowed (`inline`), so a small per-row height increase causes no windowing instability.
- `flush` rows gain an *inset box-shadow* (not a `border`) for the accent treatment so selection moving between rows never changes row height / reflows the list.
- The existing selection blue (`blue i:50 t:50 a:40`) is the right hue to build the ramp on; "improve" means add the hover step and a legible selected-text color, not change hue.

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

Anchors are explicit and kebab-case; steps cite plan-local decisions `[P01]`, specs `S01`, and `#anchors`; `**Depends on:**` lines reference `#step-N` anchors. Line numbers are never cited.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Title size bump — global default vs per-instance opt-in (DECIDED) {#q01-title-size}

**Question:** Should the title legibility bump apply as a new default to every consumer, or be opt-in per instance?

**Why it matters:** A global default changes row heights everywhere at once; an opt-in leaves the legibility complaint unfixed for non-migrated consumers.

**Resolution:** DECIDED (see [P02]). Bump the default title to `TugLabel size="md"` for every consumer, and expose a `titleSize?: TugLabelSize` escape hatch on `TugListRow` for the rare row that needs to opt back down. The user's complaint is global ("most text in list view rows is too small"), so a global default is correct; the escape hatch covers exceptions without a second migration.

#### [Q02] Multiline subtitle clamp configurability (DEFERRED) {#q02-multiline-clamp}

**Question:** Should multiline rows expose a configurable max-line clamp beyond a simple `subtitleMaxLines` integer (e.g. per-breakpoint clamps)?

**Why it matters:** Over-building the clamp API now risks an awkward surface; under-building may force a follow-on.

**Resolution:** DEFERRED. Ship `subtitleMaxLines?: number` (default 1, today's behavior) backed by `TugLabel`'s existing `maxLines`. Revisit richer clamp policy only if a consumer needs it; tracked in [#roadmap].

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Title size bump shifts picker row heights / layouts | med | high | Pickers are non-windowed; verify each in gallery + running app; `titleSize` escape hatch | Any picker overflows or clips |
| Accent border on `flush` causes reflow when selection moves | med | med | Use inset `box-shadow`, not `border` (no box-model change) | Visible row jump on selection change |
| New selection-hover token clashes in one theme | low | med | Add to both themes in the same step; verify in gallery under each theme | Token missing / wrong contrast |
| `selectedGlyph` column changes title alignment in migrated pickers | low | med | Reserve fixed column width always (empty when unselected), mirroring current hand-rolled holders | Titles misalign post-migration |

**Risk R01: Title-size regression in pickers** {#r01-title-size-regression}

- **Risk:** Bumping the default title size visibly grows or clips rows in the picker sheets.
- **Mitigation:** Verify every picker in the gallery and the running app after Step 2; expose `titleSize` for opt-down.
- **Residual risk:** Sheets sized to today's tighter rows may need a one-line height tweak — cheap and local.

**Risk R02: Accent-border reflow on `flush`** {#r02-accent-reflow}

- **Risk:** A bordered selected `flush` row is taller than its neighbors, so moving selection nudges layout.
- **Mitigation:** Inset `box-shadow` paints inside the existing box; no height change ([P04]).
- **Residual risk:** None expected; box-shadow does not participate in layout.

---

### Design Decisions {#design-decisions}

#### [P01] The list owns its selection color family, distinct from popup menus (DECIDED) {#p01-own-selection-family}

**Decision:** `TugListRow` selection visuals are built on the `--tug7-surface-selection-primary-*` blue family (improved with a new `-hover` step), **not** the popup-menu tokens (`--tug7-element-global-fill-normal-accentSubtle-rest`, `--tug7-surface-control-primary-filled-action-*`).

**Rationale:**
- User decision: the list should have its own selection language, not reuse the menus'.
- The selection token family already exists and already differs from the menu's; "improve" means complete the ramp (add hover) and add a legible selected-text color.

**Implications:**
- A new base token `--tug7-surface-selection-primary-normal-plain-hover` is added to both themes.
- `tug-list-row.css` selection aliases resolve to the selection family, never to menu/control tokens.

#### [P02] All row text routes through `TugLabel`; title defaults to `md` (DECIDED) {#p02-tuglabel-text}

**Decision:** Title and subtitle render via `TugLabel` — title at `size="md"` (default, overridable by `titleSize`) with the existing medium weight expressed as `emphasis="strong"`; subtitle at `size="sm" emphasis="calm"` (muted). `children` remains the raw escape hatch.

**Rationale:**
- Fixes the legibility complaint and unifies row text with app-wide `TugLabel` styling.
- `TugLabel` already provides ellipsis/maxLines truncation, so manual `text-overflow` CSS moves into the label.

**Implications:**
- `TugListRowProps` gains `titleSize?: TugLabelSize` and `subtitleMaxLines?: number`.
- Row CSS drops the manual title/subtitle `overflow`/`text-overflow`/`white-space` rules (now `TugLabel`'s job).

#### [P03] Four-state selection ramp with a distinct selected-hover (DECIDED) {#p03-selection-ramp}

**Decision:** Both variants get explicit rest / hover / selected / selected-hover rules. Selected uses the selection-rest token; selected-hover uses the new selection-hover token; selected rows paint title text with `--tug7-element-selection-text-normal-plain-rest` for contrast on the fill.

**Rationale:**
- Today `[data-selected]` and `:hover` collide at equal specificity with no dedicated combined rule, so the states are visually indistinguishable — the user's item 2 complaint.

**Implications:**
- New `.tug-list-row[data-selected="true"]:hover` rules per variant; `@tug-pairings` block updated.

#### [P04] Accent selection border — inset shadow on `flush`, border swap on `pill` (DECIDED) {#p04-accent-border}

**Decision:** An opt-in accent selection border, requested via `TugListView`'s `selectedAccent` (published to rows through the existing `TugListRowLayoutContext` mechanism) and overridable directly on `TugListRow` via `selectedAccent`. `flush` paints an inset `box-shadow` in `--tug7-element-tone-border-normal-accent-rest`; `pill` swaps its border color to the same token.

**Rationale:**
- `flush` rows have no border; an inset shadow gives an accent outline without a box-model change, so selection moving never reflows ([R02]).

**Implications:**
- `TugListViewProps` gains `selectedAccent?: boolean`; `TugListRowProps` gains `selectedAccent?: boolean`; the layout context payload extends from a bare variant to `{ variant, selectedAccent }` (internal, app code never reads it).

#### [P05] Row separators become a `TugListView` prop (DECIDED) {#p05-row-separators}

**Decision:** Lift the hardcoded `flush` divider into a `rowSeparator` prop on `TugListView`: `{ thickness?: "hairline" | "thin" | "medium"; color?: string } | "none"`, backed by `--tugx-list-view-divider-thickness` / `--tugx-list-view-divider-color` tokens. Default reproduces today's hairline exactly.

**Rationale:**
- User wants varying thickness, color, and a no-separator option; the divider currently has none of these.

**Implications:**
- `TugListView` writes `data-row-separator` and the divider tokens on the scroll container; pure resolver maps the prop to token values.

#### [P06] Standard row types via a reserved `selectedGlyph` column + multiline subtitle (DECIDED) {#p06-row-types}

**Decision:** Express the "one/two/multiline, with icons, checkmarks and without" matrix with the existing `leading`/`trailing`/`title`/`subtitle` slots plus two additions: `selectedGlyph?: "check" | "none"` (a fixed-width column, reserved even when unselected so titles align) and `subtitleMaxLines?` (multiline). No new "row type" enum — composition over a taxonomy.

**Rationale:**
- The pickers already prove the checkmark column is the missing piece; a reserved column deletes their hand-rolled holders.
- Single/two/multiline already fall out of `title` + `subtitle` + `subtitleMaxLines`; an enum would be redundant ceremony.

**Implications:**
- `selectedGlyph="check"` renders its own leading column *in addition to* any `leading` accessory; the two coexist.

#### [P07] Phased, independently-shippable sequencing (DECIDED) {#p07-phasing}

**Decision:** Ship A (foundation) → B (accent + separators) → C (row types + migration), each phase ending at a verifiable checkpoint and committable independently.

**Rationale:**
- Foundation is highest-leverage and stands alone; B and C tune against the improved baseline.

**Implications:**
- Steps group by phase; integration-checkpoint steps close A and B before C begins.

---

### Specification {#specification}

#### Public API Surface {#public-api}

**`TugListRowProps` additions:**

- `titleSize?: TugLabelSize` — overrides the default `md` title size ([P02]).
- `subtitleMaxLines?: number` — subtitle wraps to N lines via `TugLabel maxLines` (default 1) ([P06], [Q02]).
- `selectedGlyph?: "check" | "none"` — reserved leading check column (default `"none"`) ([P06]).
- `selectedAccent?: boolean` — accent selection border for this row; falls back to the list-view context value ([P04]).

**`TugListViewProps` additions:**

- `selectedAccent?: boolean` — publishes accent-selection intent to descendant rows (default `false`) ([P04]).
- `rowSeparator?: { thickness?: "hairline" | "thin" | "medium"; color?: string } | "none"` — divider control (default = today's hairline) ([P05]).

**Internal context change:** `TugListRowLayoutContext` payload becomes `{ variant: TugListRowVariant; selectedAccent: boolean } | null` (was `TugListRowVariant | null`). Internal to the row/list-view pair.

**Spec S01: Selection token resolution** {#s01-selection-tokens}

- `--tugx-list-row-selected-bg` → `--tug7-surface-selection-primary-normal-plain-rest`
- `--tugx-list-row-selected-hover-bg` → `--tug7-surface-selection-primary-normal-plain-hover` (new base token)
- `--tugx-list-row-selected-text` → `--tug7-element-selection-text-normal-plain-rest`
- `--tugx-list-row-selected-accent-border` → `--tug7-element-tone-border-normal-accent-rest`

**Spec S02: Separator resolver** {#s02-separator-resolver}

Pure function `resolveRowSeparator(prop)` → `{ thickness: string; color: string } | null`:
- `"none"` → `null` (no divider, no `data-row-separator`)
- omitted → `{ thickness: hairline-token, color: divider-default-token }` (today's behavior)
- object → merge over the omitted default per provided field
- `thickness` keyword → `1px` (hairline) / `1.5px` (thin) / `2px` (medium) via `--tugx-list-view-divider-thickness`.

#### State Zone Mapping (tugdeck/tugways) {#state-zone-mapping}

| State | Zone | Mechanism | Law |
|-------|------|-----------|-----|
| selected / hover / disabled visuals | appearance | CSS + `data-selected`/`:hover` + tokens | [L06], [L15] |
| `selectedAccent` intent (list → rows) | appearance/structure | prop → context payload → `data-` attr + CSS | [L06], [L20] |
| `rowSeparator` config | appearance | prop → `data-row-separator` + CSS vars on container | [L06] |
| `selectedGlyph` reserved column | appearance/structure | presentational prop → DOM | [L06] |
| selected-index ownership | local-data | *unchanged* (`selectionRequired` `useState`+ref) | [L24] |

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tugdeck/src/components/tugways/internal/list-view-separator.ts` | Pure `resolveRowSeparator` ([S02]) + thickness keyword map |
| `tugdeck/src/components/tugways/internal/__tests__/list-view-separator.test.ts` | `bun:test` coverage for the separator resolver |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `--tug7-surface-selection-primary-normal-plain-hover` | token | `styles/themes/brio.css`, `harmony.css` | New selection-hover base ([P01]) |
| `--tugx-list-row-selected-*` | tokens | `tug-list-row.css` | Selection ramp aliases ([S01]) |
| `--tugx-list-row-selected-accent-border` | token | `tug-list-row.css` | Accent border alias ([P04]) |
| `--tugx-list-view-divider-thickness` | token | `tug-list-view.css` | Separator thickness ([P05]) |
| `titleSize`, `subtitleMaxLines`, `selectedGlyph`, `selectedAccent` | props | `tug-list-row.tsx` | Row API additions ([P02],[P04],[P06]) |
| `selectedAccent`, `rowSeparator` | props | `tug-list-view.tsx` | List API additions ([P04],[P05]) |
| `TugListRowLayoutContext` payload | type | `tug-list-row.tsx` | `{ variant, selectedAccent }` ([P04]) |
| `resolveListRowSelectedGlyph` | fn | `tug-list-row.tsx` | Pure; exported for tests ([P06]) |
| `resolveRowSeparator` | fn | `internal/list-view-separator.ts` | Pure ([S02]) |

---

### Documentation Plan {#documentation-plan}

- [ ] Update `tug-list-row.tsx` / `.css` module docstrings + `@tug-pairings` for the new selection ramp, accent border, and row types.
- [ ] Update `tug-list-view.tsx` / `.css` module docstrings + `@tug-pairings` for `rowSeparator` and `selectedAccent`.
- [ ] Component Gallery (`gallery-tug-list-row`, `gallery-list-view`) sections for every new knob.

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit (pure-logic `bun:test`)** | Lock the branching resolvers | `resolveRowSeparator`, `resolveListRowSelectedGlyph`, existing variant/content-mode resolvers |
| **Gallery (visual, HMR)** | Exercise the render path + every state under both themes | All new visuals — states, accent border, separators, row types |
| **Contract (tsc)** | API shape stays sound | `bun run check` after each step |

#### What stays out of tests {#test-non-goals}

- Render/DOM assertions for `TugListRow` / `TugListView` — fake-DOM render tests are banned; the render path is verified in the gallery and running app.
- Mock-store / call-count tests — banned pattern.
- Per-token color-value assertions — tokens are theme data, verified by eye in the gallery under each theme.

---

### Execution Steps {#execution-steps}

> Commit after all checkpoints pass. References are mandatory. No plan-number text in code or commit messages.

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Selection token family (both themes + row aliases) | done | 324f73f2 |
| #step-2 | TugLabel-driven row text + title size bump | done | c58ab362 |
| #step-3 | Four-state selection ramp (selected-hover) | done | 09fb6cc4 |
| #step-4 | Phase A gallery + integration checkpoint | done | 55b9a028 |
| #step-5 | `rowSeparator` prop on TugListView | done | 110d3f9f |
| #step-6 | Accent selection border (`selectedAccent`) | done | 1896dda8 |
| #step-7 | Phase B gallery + integration checkpoint | done | b90028fd |
| #step-8 | `selectedGlyph` column + multiline subtitle | done | 151d141f |
| #step-9 | Row-types gallery section | done | 728d03b9 |
| #step-10 | Migrate model + effort pickers to `selectedGlyph` | done | 48bcfa83 |
| #step-11 | Phase C integration checkpoint | done | N/A (verification only) |

---

#### Step 1: Selection token family (both themes + row aliases) {#step-1}

**Commit:** `feat(tugways): add list selection-hover token + own selection ramp aliases`

**References:** [P01] (#p01-own-selection-family), [P03] (#p03-selection-ramp), Spec S01 (#s01-selection-tokens)

**Artifacts:**
- `--tug7-surface-selection-primary-normal-plain-hover` added to `brio.css` and `harmony.css` in the existing `/* Selection */` group.
- `--tugx-list-row-selected-bg` / `-selected-hover-bg` / `-selected-text` / `-selected-accent-border` aliases in `tug-list-row.css`, replacing the lone `--tugx-list-row-flush-selected-bg` / `pill-selected-*` references; `@tug-pairings` updated.

**Tasks:**
- [ ] Add the `-hover` selection base token to both themes (a slightly stronger step than `-rest`, e.g. higher alpha of the same blue).
- [ ] Introduce the `--tugx-list-row-selected-*` alias block ([S01]); keep one-hop resolution ([L17]).
- [ ] Update the `@tug-pairings` table/block in `tug-list-row.css` to declare the selection foregrounds on the selection surface.

**Tests:**
- [ ] None (token-only); covered by `bun run check` + gallery in #step-4.

**Checkpoint:**
- [ ] `grep -l "selection-primary-normal-plain-hover" tugdeck/styles/themes/brio.css tugdeck/styles/themes/harmony.css` lists both files.
- [ ] `cd tugdeck && bun run check` is clean.

---

#### Step 2: TugLabel-driven row text + title size bump {#step-2}

**Depends on:** #step-1

**Commit:** `feat(tugways): render TugListRow text via TugLabel with legible title size`

**References:** [P02] (#p02-tuglabel-text), [Q01] (#q01-title-size)

**Artifacts:**
- `tug-list-row.tsx`: title/subtitle rendered via `TugLabel` (title `size={titleSize ?? "md"} emphasis="strong"`; subtitle `size="sm" emphasis="calm"` with `maxLines={subtitleMaxLines ?? 1}`).
- `TugListRowProps`: `titleSize?`, `subtitleMaxLines?`.
- `tug-list-row.css`: drop the manual title/subtitle `overflow`/`text-overflow`/`white-space` (now `TugLabel`'s job); keep layout/column rules.

**Tasks:**
- [ ] Swap structured-mode spans for `TugLabel`; preserve the `children` escape hatch unchanged.
- [ ] Add `titleSize` / `subtitleMaxLines` props + docstrings.
- [ ] Remove the superseded CSS text-truncation rules; verify column flex/min-width still truncates correctly.

**Tests:**
- [ ] Existing `tug-list-row.test.ts` resolver tests still pass (no resolver change).

**Checkpoint:**
- [ ] `cd tugdeck && bun run check` is clean.
- [ ] Gallery `TugListRow` tab: titles read at the new, larger size; long titles still ellipsize (verified in #step-4).

---

#### Step 3: Four-state selection ramp (selected-hover) {#step-3}

**Depends on:** #step-2

**Commit:** `feat(tugways): distinct selected-hover state for TugListRow`

**References:** [P03] (#p03-selection-ramp), Spec S01 (#s01-selection-tokens)

**Artifacts:**
- `tug-list-row.css`: explicit `.tug-list-row[data-variant="flush"][data-selected="true"]:hover` and the `pill` equivalent, using `--tugx-list-row-selected-hover-bg`; selected rows set title color to `--tugx-list-row-selected-text`.

**Tasks:**
- [ ] Add selected-hover rules for both variants (color-only, [L15]).
- [ ] Apply selected-text color so titles stay legible on the selection fill.
- [ ] Confirm rule order/specificity so selected-hover wins over both plain hover and plain selected.

**Tests:**
- [ ] None (CSS-only); visual in #step-4.

**Checkpoint:**
- [ ] `cd tugdeck && bun run check` is clean.
- [ ] Gallery States section shows four visibly distinct backgrounds: rest, hover, selected, selected+hover (verified in #step-4).

---

#### Step 4: Phase A gallery + integration checkpoint {#step-4}

**Depends on:** #step-1, #step-2, #step-3

**Commit:** `docs(gallery): TugListRow selection ramp + TugLabel text states`

**References:** [P01], [P02], [P03], (#success-criteria)

**Artifacts:**
- `gallery-tug-list-row.tsx`: States section extended with rest / hover / selected / selected-hover for both variants; captions note the list-owned selection family.

**Tasks:**
- [ ] Extend the gallery States/Variants sections to demonstrate the four-state ramp and the larger title.
- [ ] Visually verify under both `brio` and `harmony` themes in the running app (HMR).

**Tests:**
- [ ] `cd tugdeck && bun test src/components/tugways/__tests__/tug-list-row.test.ts` passes.

**Checkpoint:**
- [ ] In the gallery, hovering a selected row differs from both a resting selected row and a hovered-unselected row, in both themes.
- [ ] `cd tugdeck && bun run check` is clean.

---

#### Step 5: `rowSeparator` prop on TugListView {#step-5}

**Depends on:** #step-4

**Commit:** `feat(tugways): configurable TugListView row separators`

**References:** [P05] (#p05-row-separators), Spec S02 (#s02-separator-resolver)

**Artifacts:**
- `internal/list-view-separator.ts`: `resolveRowSeparator` + thickness keyword map ([S02]).
- `tug-list-view.tsx`: `rowSeparator?` prop → `data-row-separator` + `--tugx-list-view-divider-thickness` / `-color` on the scroll container.
- `tug-list-view.css`: divider rule reads the thickness token; `data-row-separator="none"` (and the `rowLayout="flush"` default) reconciled so omitting `rowSeparator` is byte-identical to today.
- `internal/__tests__/list-view-separator.test.ts`.

**Tasks:**
- [ ] Implement + export the pure resolver ([S02]).
- [ ] Wire the prop to container attributes/tokens; default reproduces the current hairline.
- [ ] Update the divider CSS + `@tug-pairings`.

**Tests:**
- [ ] `list-view-separator.test.ts`: `"none"` → null; omitted → hairline default; keyword → px; partial object merges over default.

**Checkpoint:**
- [ ] `cd tugdeck && bun test src/components/tugways/internal/__tests__/list-view-separator.test.ts` passes.
- [ ] `cd tugdeck && bun run check` is clean.

---

#### Step 6: Accent selection border (`selectedAccent`) {#step-6}

**Depends on:** #step-4

**Commit:** `feat(tugways): optional accent selection border for list rows`

**References:** [P04] (#p04-accent-border), Risk R02 (#r02-accent-reflow)

**Artifacts:**
- `tug-list-row.tsx`: `selectedAccent?` prop; `TugListRowLayoutContext` payload widened to `{ variant, selectedAccent }`; row reads context fallback; writes `data-selected-accent`.
- `tug-list-view.tsx`: `selectedAccent?` prop published through the layout provider.
- `tug-list-row.css`: `flush` selected+accent → inset `box-shadow` in the accent token; `pill` selected+accent → border-color swap.

**Tasks:**
- [ ] Widen the context payload (internal); update `resolveListRowVariant` call sites to read the new shape.
- [ ] Add `data-selected-accent` + CSS for both variants (inset shadow on `flush`, no box-model change).
- [ ] Publish `selectedAccent` from `TugListView`.

**Tests:**
- [ ] Existing resolver tests pass; if the context-resolution helper changes shape, extend its pure test accordingly.

**Checkpoint:**
- [ ] `cd tugdeck && bun run check` is clean.
- [ ] Gallery: a selected row shows the accent outline; selecting a different `flush` row causes no row-height jump (verified in #step-7).

---

#### Step 7: Phase B gallery + integration checkpoint {#step-7}

**Depends on:** #step-5, #step-6

**Commit:** `docs(gallery): list separators + accent selection border`

**References:** [P04], [P05], (#success-criteria)

**Artifacts:**
- `gallery-list-view.tsx` / `gallery-tug-list-row.tsx`: sections for separator thickness/color/none and the accent border.

**Tasks:**
- [ ] Add gallery controls demonstrating each separator option and `selectedAccent` on/off.
- [ ] Verify default-path (no `rowSeparator`, no `selectedAccent`) is visually unchanged from before the phase.

**Tests:**
- [ ] `cd tugdeck && bun test src/components/tugways/internal/__tests__/list-view-separator.test.ts` passes.

**Checkpoint:**
- [ ] Gallery shows hairline/thin/medium/none separators and the accent border, both themes; default path unchanged.
- [ ] `cd tugdeck && bun run check` is clean.

---

#### Step 8: `selectedGlyph` column + multiline subtitle {#step-8}

**Depends on:** #step-7

**Commit:** `feat(tugways): reserved checkmark column + multiline subtitle for list rows`

**References:** [P06] (#p06-row-types), [Q02] (#q02-multiline-clamp)

**Artifacts:**
- `tug-list-row.tsx`: `selectedGlyph?: "check" | "none"` renders a fixed-width leading check column (reserved when unselected); `resolveListRowSelectedGlyph` pure helper exported.
- `subtitleMaxLines` already added in #step-2 — confirm multiline path wires to `TugLabel maxLines`.
- `tug-list-row.css`: check-column width + alignment (mirrors the pickers' current holders).

**Tasks:**
- [ ] Implement the reserved check column + the pure resolver.
- [ ] Confirm `selectedGlyph` coexists with an independent `leading` accessory.
- [ ] Add resolver tests to `tug-list-row.test.ts`.

**Tests:**
- [ ] `tug-list-row.test.ts`: `resolveListRowSelectedGlyph` — `"check"` + selected → show; `"check"` + unselected → reserved-empty; `"none"` → no column.

**Checkpoint:**
- [ ] `cd tugdeck && bun test src/components/tugways/__tests__/tug-list-row.test.ts` passes.
- [ ] `cd tugdeck && bun run check` is clean.

---

#### Step 9: Row-types gallery section {#step-9}

**Depends on:** #step-8

**Commit:** `docs(gallery): standard list row types (one/two/multiline, checkmark)`

**References:** [P06] (#p06-row-types)

**Artifacts:**
- `gallery-tug-list-row.tsx`: a "Row types" section — single-line, two-line, multiline (`subtitleMaxLines`), with/without leading icon, with/without `selectedGlyph`.

**Tasks:**
- [ ] Add the row-types matrix to the gallery.
- [ ] Verify multiline wraps (no ellipsis) and checkmark column aligns titles.

**Tests:**
- [ ] None (gallery visual).

**Checkpoint:**
- [ ] Gallery renders the full row-types matrix; titles align across checked/unchecked rows.
- [ ] `cd tugdeck && bun run check` is clean.

---

#### Step 10: Migrate model + effort pickers to `selectedGlyph` {#step-10}

**Depends on:** #step-8

**Commit:** `refactor(tugdeck): adopt TugListRow selectedGlyph in model + effort pickers`

**References:** [P06] (#p06-row-types), (#success-criteria)

**Artifacts:**
- `model-picker-sheet.tsx`, `effort-picker-sheet.tsx`: replace the hand-rolled leading check holder with `selectedGlyph="check"`.

**Tasks:**
- [ ] Swap the local check markup for `selectedGlyph`; remove now-dead check CSS/holders.
- [ ] Verify selected row still shows the mark and titles still align.

**Tests:**
- [ ] Existing picker behavior unchanged (selection still moves the checkmark); verified in the running sheet.

**Checkpoint:**
- [ ] `grep -n "check" model-picker-sheet.tsx effort-picker-sheet.tsx` shows no hand-rolled holder remains (only `selectedGlyph`).
- [ ] `cd tugdeck && bun run check` is clean; pickers work in the running app.

---

#### Step 11: Phase C integration checkpoint {#step-11}

**Depends on:** #step-9, #step-10

**Commit:** `N/A (verification only)`

**References:** [P06], (#exit-criteria)

**Tasks:**
- [ ] Verify the full uplift end-to-end: legible text, four-state selection, accent border, separators, row types, migrated pickers — under both themes.

**Tests:**
- [ ] `cd tugdeck && bun test src/components/tugways` passes (row + separator resolvers).

**Checkpoint:**
- [ ] `cd tugdeck && bun run check` clean; all gallery sections render; model + effort pickers function with the new checkmark column.

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** A beautified `TugListView` / `TugListRow` — `TugLabel`-driven legible text, a list-owned four-state selection ramp, an optional accent selection border, configurable row separators, and a reserved checkmark column adopted by the model and effort pickers.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] All row text renders via `TugLabel`; title legible at `md` (escape hatch present) — gallery + grep.
- [ ] Four visibly distinct selection backgrounds for both variants, both themes — gallery.
- [ ] `--tug7-surface-selection-primary-normal-plain-hover` present in both themes — grep.
- [ ] `selectedAccent` and `rowSeparator` work; defaults byte-identical to today — gallery default path.
- [ ] `selectedGlyph` column reserved/aligned; model + effort pickers migrated — grep + running app.
- [ ] `cd tugdeck && bun test src/components/tugways` and `bun run check` pass.

**Acceptance tests:**
- [ ] `cd tugdeck && bun test src/components/tugways/__tests__/tug-list-row.test.ts`
- [ ] `cd tugdeck && bun test src/components/tugways/internal/__tests__/list-view-separator.test.ts`
- [ ] `cd tugdeck && bun run check`

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] Migrate agents / skills / memory / help / permission-rules sheets to the new row types.
- [ ] Richer multiline clamp policy if a consumer needs it ([Q02]).
- [ ] Consider `leadingReveal="hover"` to mirror `trailingReveal`.

| Checkpoint | Verification |
|------------|--------------|
| Selection ramp | Gallery States: rest/hover/selected/selected-hover distinct, both themes |
| Separators | Gallery: hairline/thin/medium/none; default unchanged |
| Accent border | Gallery: outline shown; no row-height jump on `flush` selection move |
| Pickers migrated | `bun run check` + model/effort sheets work; no hand-rolled check holders |
