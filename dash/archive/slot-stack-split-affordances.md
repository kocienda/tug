## Slot / Stack / Split Wayfinding Badges {#slot-stack-split-affordances}

**Purpose:** Ship the column badges designed in the `deck-wayfinding` spike: the pane control cluster and the Lens rows say a card's whole coordinate — slot, stack, split band — as three small controls with three unmistakable vocabularies, replacing today's icon-plus-count stack badge.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main (via dash worktree) |
| Last updated | 2026-08-22 |

---

### Review Record {#review-record}

**Round 1 — 2026-08-22, opus.** Reviewed `plan:0278d9591e2b5e49`. Lint: 0 errors, 1 warning (PL023, the missing Review Record this paragraph fixes).
Oriented on: a first pass over the whole document, read against `components/chrome/tug-pane.tsx`, `components/chrome/deck-canvas.tsx`, `deck-store-selectors.ts`, `components/tugways/tug-slot.{tsx,css}`, `components/tugways/card-slot-badge.{tsx,css}`, `components/lens/slot-picker.{tsx,css}`, `components/lens/sections/cards-session-cell.tsx`, and the five app-tests that name the stack badge.
Applied: **technical choice** — Step 3 proposed a `columnBadgeFactsOf` selector in `deck-store-selectors.ts` that resolved "pinned-rail membership the same two ways", which cannot be written there: `sidebarRailsOf` is module-private to `deck-canvas.tsx` and reads `getAllRegistrations()`, a boot-time registry rather than deck state. Rewritten over `deckColumnsOf` alone, with the reason rails cannot arise recorded (`assignCardsToSlots` and `movePaneToSlot` both refuse a sidebar-hosted pane, so a rail pane carries no `slot`; and the only `layoutRole: "sidebar"` cards are the Lens, Jots, and Overview). **Test plan** — Step 2 claimed five app-tests needed their assertions reworked; the survey found the opposite and it is now in the step: `at0347` and `at0359` assert `"2"` on stacks and still pass because a stack still renders a count, `at0404` asserts only the untouched tooltip, and `at0401`/`at0455` never assert split badge text — so the risk is not churn but a coverage hole, and the step now ADDS the `A`/`B` claim that pins the plan's most visible change. Risk R02 rewritten to say that. **Banned shape** — Step 1's Tests block named "`data-kind`/`data-lit` projection" as a `bun:test` unit test, which has no DOM substrate; split into pure-helper truth tables plus an explicit note that the attributes are pinned by the app-tests. **Law [L02]** — Step 3 would have read the deck store from `CardsSessionRow`, a component that subscribes to nothing today; now routed through a subscribing wrapper the way `slot-picker.tsx` does, and the State Zone Mapping split into the two rows (props for the cluster per [L10], `useSyncExternalStore` for the Lens). **Holes** — the badge must not be gated on `placeArrangement`, which is `undefined` on some panes that still render a badge under `slotStack.length > 1`; a split column of three or more overflows (`columnStanding`), so the three-rung glyph names a region while the letter names the band; unused `Layers`/`Rows2`/`Rows3` imports get a cleanup task. **Authoring contract** — Spec S01 gained `forwardRef`, `data-slot`, and the `@tug-pairings` requirement from `component-authoring.md`, and the knob family was renamed `--tugx-colbadge-*` → `--tugx-column-badge-*` to match the `--tugx-{component}-*` rule. **Coherence** — the non-goal "the slot badge is untouched" contradicted [P05] and now scopes itself to shape and semantics.
Asked and settled, rather than deferred: the cluster pair's size, because the spike was judged at 18×22/11 while `TugSlot`'s `sm` defaults — what the cluster actually draws at — are 15×19/10, so shipping unchanged would have rendered the approved glyph 21% smaller in linear terms; the user chose to bump the pair, now [P05]. And the Lens scope, where the user kept Sessions-only with text-file rows as a named follow-on.
Deferred: nothing.

---

### Phase Overview {#phase-overview}

#### Context {#context}

A card's place on the deck has three coordinates: the **slot** it stands in (the imposition chain), its **depth** when several panes share the slot in stacked mode, and its **band** when the column is split. Today the cluster says the first with the boxed-number `CardSlotBadge`, says the second and third with one `TugButton` showing a lucide icon (`Layers` for a stack, `Rows2`/`Rows3` for a split) plus a member count, and never says *which band* a split member is. The Lens row's `SlotPicker` says the slot and — as an outlined chip — "buried", and nothing else.

The `deck-wayfinding` design spike (`tugdeck/src/spikes/spike-deck-wayfinding.tsx`) iterated six rounds with the user and settled a design. This plan rolls that design into shipping components and retires the spike.

#### Strategy {#strategy}

- Build the badge as one presentational `Tug*` component (`TugColumnBadge`) with the spike's settled geometry, then compose it into the two existing surfaces — the pane title bar's stack-badge button and the Lens row — without changing either surface's behavior.
- No new state anywhere: every fact the badge draws already arrives at its surface (`slotStack`, `sidebarStack.memberIndex`, `columnMember.index`), or is derived by an existing selector (`deckColumnsOf`).
- Rework the app-tests that pin the current badge in the same step that changes it; never a separate cleanup step.
- Close by writing the badge grammar into `tuglaws/pane-model.md` and deleting the spike — graduation, the spike contract's first exit.

#### Success Criteria (Measurable) {#success-criteria}

- A pane in a stacked column of 3 shows the count `3` over the three-slice glyph with the top slice lit (app-test assertion on `data-kind="stack"` and the badge text).
- Each member of a split column of 2 shows its own letter — `A` on the top band's pane, `B` on the lower — over the ladder glyph with the correct rung lit (app-test assertion on `data-lit`).
- The badge's box is the slot badge's box — both at 18×22 with an 11px character per [P05] — asserted by comparing the two elements' rects in an app-test.
- A split rail's two members show `A` and `B` where they both showed `2` before (new claim in at0401).
- Clicking the badge still opens the same member/verbs menu it opens today (existing at0347 claims stay green after rework).
- A Lens Sessions row whose card stands in a structured column shows the badge after the slot run; a row whose card is alone shows nothing (app-test assertion).
- The spike file and its registry lines are gone; `card-taxonomy.test.ts` pins the spike count back down.

#### Scope {#scope}

1. New `TugColumnBadge` component in `tugdeck/src/components/tugways/`.
2. The pane control cluster's stack badge rewired to render it (both rail and column places).
3. The Lens Sessions row: badge after the `SlotPicker` run.
4. App-test rework for the badge's current pins; doctrine paragraph; spike deletion.

#### Non-goals (Explicitly out of scope) {#non-goals}

- The slot badge (`CardSlotBadge`) — its shape, semantics, popup, and menu are untouched. Its **size knobs move with the pair** per [P05], which is an edit to `card-slot-badge.css` and nothing else.
- The stack picker menu's contents, verbs, or behavior — the badge stays the same door.
- Any change to stack/split *mechanics* (arrangements, geometry, commands).
- Replacing `Layers`/`Rows2`/`Rows3` icons anywhere other than the cluster badge (menus and other surfaces keep their icons).
- Lens **file** rows: `SlotPicker` also renders there, but a text-file card in a structured column is rare and the cell is narrower; follow-on if wanted.
- Keyboard reachability of the badge beyond what the current button already has (focus-engine work is tabled).

#### Dependencies / Prerequisites {#dependencies}

- The spike card (`spike-deck-wayfinding.tsx`) as the visual reference — present on `main` until Step 4 deletes it.
- `deckColumnsOf` (`tugdeck/src/deck-store-selectors.ts`) and the pane props `sidebarStack` / `columnMember` (`tugdeck/src/components/chrome/tug-pane.tsx`) — all already shipped.

#### Constraints {#constraints}

- Tuglaws: [L02] external state via `useSyncExternalStore` only, [L06] appearance through CSS/DOM, [L11] controls emit actions, [L15] tokens never hex, [L16] pairings declared, [L19] component authoring, [L20] compose `Tug*` primitives and respect their token sovereignty.
- App-tests run selectively via `just app-test-changed`; new/edited tests carry `@covers`.
- `bunx vite build` green before the tugdeck work is called done (debug app loads the prod rollup).

#### Assumptions {#assumptions}

- The settled design is the spike's round-six state: count-over-slices for stacks, letter-over-rungs for splits, outline-lit accents, canvas knockout behind the character.
- The letters-are-split-only rule (agreed in conversation, 2026-08-22) holds on every surface, including the Lens.

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

This plan uses the devise-skeleton conventions: explicit `{#anchor}` on every cited heading, `[P##]` for plan-local decisions, `**Depends on:**` with `#step-N` anchors, and rich `**References:**` lines. No line numbers anywhere.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

None open. Four questions were raised and all four were answered, so nothing is deferred.

Settled with the user in the spike conversation (2026-08-22): stacks show a **count** rather than a position letter, because a visible stacked card is by definition on top; and letters are **split-only vocabulary on every surface**, so a buried Lens row reads "outlined chip + count" and never a letter — both in [P01].

Settled with the user during the plan review (2026-08-22): the cluster pair ships at the **18×22/11px** the design was judged at rather than `TugSlot`'s smaller `sm` defaults — [P05]; and the Lens badge lands on **Sessions rows only** this phase, leaving text-file rows (`components/lens/sections/cards-section.tsx`, which also renders `SlotPicker`) as the named follow-on in #roadmap.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Stack pair reads as two run-on numerals (`2·3`) | med | med | Glyph between them carries the "of a stack" sense; count can drop to muted ink as a one-line tune | User eval on a debug build |
| The split badge's biggest change ships untested | med | high | #step-2 adds the `A`/`B` claim; the four existing badge tests are regression checks, not rework | Step 2 checkpoint |
| Cluster chips growing to 18×22 crowd a narrow title bar | low | med | Decided with the user ([P05]); the cluster is a flex row that already absorbs a variable control count | Eval on a debug build |
| Lens row derivation cost (per-row column scan) | low | low | Derive through the existing memoized `deckColumnsOf` reading, resolved once per deck snapshot | Perf trace if Lens rows jank |

**Risk R01: The two-numeral stack pair** {#r01-two-numeral-pair}

- **Risk:** Slot `2` beside stack count `3` may blur into one fact at cluster size.
- **Mitigation:** The slice glyph sits between them; the count's ink can be stepped to the muted register without changing the component's shape (a knob, not a redesign).
- **Residual risk:** Only pixels can settle it; the debug-build eval is the test.

**Risk R02: App-test churn is smaller than it looks, and the gap is coverage** {#r02-app-test-churn}

- **Risk:** The obvious reading — five tests pin the badge, so five tests break — is wrong, and acting on it wastes a step. The survey in #step-2 found that all four badge-bearing tests pass unchanged: stacks still render a count (`at0347`, `at0359` assert `"2"`), the tooltip is untouched (`at0404`), and the split tests never assert badge text at all (`at0401`, `at0455`). The **real** risk is the inverse: the most visible change in the plan — a split's two members going from `2`/`2` to `A`/`B` — would ship pinned by nothing.
- **Mitigation:** #step-2 adds the per-member letter claim rather than reworking assertions, and keeps the `tug-pane-title-bar-stack-badge` testid so every existing selector stays valid.
- **Residual risk:** Assertions on rendered glyph internals are new surface; keep them to `data-` attributes and rect comparisons, never SVG path geometry.

---

### Design Decisions {#design-decisions}

#### [P01] Three vocabularies: number = slot, count-over-slices = stack, letter-over-rungs = split (DECIDED) {#p01-three-vocabularies}

**Decision:** The slot badge stays a number in a box. The stack badge shows the **count of cards in the stack** over a three-slice glyph with the top slice always lit. The split badge shows this member's **band letter** (A = topmost band) over a three-rung ladder with the lit rung at top, middle, or bottom of the run. Letters are split-only vocabulary on every surface.

**Rationale:**
- A visible card in a stack is by definition the top one, so a position letter there would always read A — no information. The hidden fact is *how many are behind*; the badge says the fact the eye can't get.
- Split bands are all visible at once, so position is real information there — and the letter's job is *naming* (an address to match against a Lens row), not revealing.
- Number/letter then maps categorically to stack/split, teachable in one sentence, and the Z alphabet can never be misread against slot numbers.

**Implications:**
- A buried card's Lens row reads "outlined slot chip + stack count"; exact depth lives only in the stack picker, whose rows are ordered.
- The split badge differs per member (A vs B), where today's count badge is identical across members. In a split **rail** both members are visible and both render a badge (`at0401` pins that), so the pair that used to read `2` and `2` now reads `A` and `B` — strictly more information from the same ink.
- A split column of three or more **overflows** (`columnStanding` past `COLUMN_OVERFLOW_MIN_MEMBERS` in `lib/layout-imposer.ts`): members take a fixed share and the strip scrolls behind the run. The letter stays exact however many members there are; the three-rung glyph says only top / middle / bottom, so every interior band of a deep column lights the same rung. That is the intended reading — the glyph names a region, the letter names the band — and it is why the glyph is not drawn with one rung per member.

#### [P02] One shape, one glyph, the slot badge's exact footprint (DECIDED) {#p02-one-shape-one-glyph}

**Decision:** The badge is a single character set exactly as `TugSlot` sets its number (same box, same font size, weight 600, same centering), over a glyph drawn behind it as quiet scenery — reduced opacity, muted strokes, the lit element an accent **outline** (never a fill), and the character knocked clear by a stacked canvas-color `text-shadow`.

**Rationale:**
- Spike rounds one through five established that anything subdividing the badge (bands, fans, sub-boxes) dies at 19 pixels; the slot badge works because nothing subdivides it.
- Outline-only lighting keeps the accent from competing with the character for the foreground.

**Implications:**
- The glyph geometry is fixed by Spec S02; theme-ability comes entirely from tokens, so the contrast audit governs it like any component.

#### [P03] `TugColumnBadge` is presentational; the existing surfaces stay the doors (DECIDED) {#p03-presentational-component}

**Decision:** The new component renders a `<span>` (exemplar-style, like `TugSlot`'s inert form) and owns only the drawing. The pane's existing `TugButton` menu trigger and the Lens row compose it; menu, tooltip, hover, and focus behavior are untouched.

**Rationale:**
- [L20]: compose, never hand-roll — and the inverse: don't fold a popup menu into a drawing component.
- The badge-as-door behavior (member rows + arrange verbs) is already built, tested (at0347), and correct.

**Implications:**
- The `TugButton` trigger renders the badge as its content instead of `icon` + count text; its `aria-label` carries the semantics.
- The Lens row's badge is a readout in this phase (no `onClick`), matching the slot run's disabled form on non-assignable rows.

#### [P04] Rail and column splits wear the same badge (DECIDED) {#p04-rail-column-same-badge}

**Decision:** A split **rail** member and a split **column** member render the identical letter-over-rungs badge; a stacked rail and a stacked column render the identical count-over-slices badge.

**Rationale:**
- The place model already treats them as the same kind of place (`RailArrangement` / `ColumnArrangement` share a shape by design; the current badge already serves both).
- The member index is already delivered for both: `sidebarStack.memberIndex` and `columnMember.index`.

**Implications:**
- `CardTitleBar`'s `placeArrangement` prop grows `index` and `count`, filled from whichever record the pane has (Spec S01).

---

#### [P05] The cluster pair ships at 18×22 with an 11px character (DECIDED) {#p05-cluster-pair-size}

**Decision:** Both the slot badge and the new column badge draw at 18×22px with an 11px character in the pane control cluster. `card-slot-badge.css` gains the `--tugx-slot-width-sm` / `-height-sm` / `-font-size-sm` overrides on `.card-slot-badge` that it currently sets only on `.card-slot-badge-picker`.

**Rationale:**
- The spike was evaluated at 18×22/11 throughout; `TugSlot`'s untouched `sm` defaults are 15×19/10, so shipping the cluster unchanged would render the approved glyph 21% smaller in linear terms — and the middle slice and middle rung are exactly the elements a reduction eats first.
- The same three knob values already appear in `slot-picker.css` and in `card-slot-badge.css`'s popup picker, so this makes the cluster agree with every other surface that presses a slot rather than introducing a fourth size.
- Decided with the user, 2026-08-22.

**Implications:**
- The cluster's chips get visibly larger than they are today; this is a deliberate, user-approved change and not a regression to file against.
- Any app-test asserting the slot badge's rect against a hard-coded 15×19 must move to 18×22 — Step 2's parity assertion compares the two rects to each other rather than to constants, which is the form that survives a future retune.

---

### Specification {#specification}

**Spec S01: TugColumnBadge API** {#s01-component-api}

New file `tugdeck/src/components/tugways/tug-column-badge.tsx` (+ sibling `.css`):

```tsx
export type TugColumnBadgeKind = "stack" | "split";

export interface TugColumnBadgeProps
  extends Omit<React.ComponentPropsWithoutRef<"span">, "children"> {
  /** Which place this badge describes. @selector [data-kind] */
  kind: TugColumnBadgeKind;
  /** How many panes share the place. Drawn as the character for a stack. */
  count: number;
  /** This member's 0-based position, topmost first. Required for a split
   *  (drawn as the letter and the lit rung); ignored for a stack. */
  index?: number;
}
```

- Character: `String(count)` for `kind="stack"`; `String.fromCharCode(65 + index)` for `kind="split"`.
- Lit element (`data-lit` on the SVG child): stack → always the top slice; split → `index === 0 ? "top" : index === count - 1 ? "bottom" : "middle"`.
- Export the two pure helpers (`columnBadgeCharacter`, `columnBadgeLit`) for unit tests.
- Authoring contract per `tuglaws/component-authoring.md`: `forwardRef`, `data-slot="tug-column-badge"` on the root (the same hook `card-slot-badge.tsx` already queries `[data-slot="tug-slot"]` by), a module docstring naming the laws, and the `@tug-pairings` table in the CSS. The knob family is `--tugx-column-badge-*`, matching the `--tugx-{component}-*` rule and `TugSlot`'s own `--tugx-slot-*`.
- Size knobs `--tugx-column-badge-width` / `--tugx-column-badge-height` / `--tugx-column-badge-font-size`, defaulting to **18px / 22px / 11px** — the size the design was judged at, and the size `slot-picker.css` and `card-slot-badge.css`'s popup picker already set for `TugSlot` ([P05]). Weight 600, `font-variant-numeric: tabular-nums`, line-height 1 — the same character setting `tug-slot.css` uses.
- **`TugSlot`'s own `sm` defaults are 15×19 at 10px**, which is what the cluster's slot badge draws at today; [P05] moves the cluster pair to 18×22/11 so both chips match these defaults with no per-consumer configuration.
- Ink knobs following the `TugSlot` knob pattern ([L20]): character ink `--tugx-column-badge-fg` (default: the muted text token), quiet stroke `--tugx-column-badge-stroke` (default: muted text token), lit stroke `--tugx-column-badge-accent` (default: `--tug7-surface-control-primary-filled-action-rest`). The cluster re-pairs `--tugx-column-badge-fg` to the pane-control ink the slot badge uses there.
- Pairings table declared in the CSS ([L16]); tokens only ([L15]).

**Spec S02: Glyph geometry (from the spike, round six)** {#s02-glyph-geometry}

Both glyphs are inline SVG children of the badge span, centered, `aria-hidden`, drawn at reduced opacity (0.55) behind the character; the character carries a stacked canvas-color `text-shadow` knockout (layers at 1–6px blur). Transcribed from `spike-deck-wayfinding.tsx`/`.css` so this plan survives the spike's deletion:

- **Stack (three slices):** `viewBox="0 0 18 20"`; three flattened diamonds at `dy` 0 / 5.5 / 11, points `9,dy 17.5,dy+4.5 9,dy+9 0.5,dy+4.5`, drawn deepest-first; fill = canvas token (occlusion only, never selection), quiet stroke 1.25, lit stroke 1.75. Top slice lit.
- **Split (three-rung H):** `viewBox="0 0 18 22"` (full badge height, so end rungs sit at the badge's ends); rails at x 1.5 and 16.5, y 1→21; rungs at y 2 / 11 / 20 spanning rail to rail; quiet stroke 1.5, lit stroke 2, `stroke-linecap: round`.
- Scale the drawn SVG box from the width/height knobs so the glyph grows with a consumer's size override (the Lens sets 18×22/11px, the values the spike was judged at).

#### State Zone Mapping (tugdeck/tugways plans) {#state-zone-mapping}

| State | Zone (appearance / local-data / structure) | Mechanism | Law |
|-------|--------------------------------------------|-----------|-----|
| none added — the cluster's badge facts (`kind`, `count`, `index`) arrive as props the pane already resolves (`slotStack`, `sidebarStack.memberIndex`, `columnMember.index`), so the title bar keeps rendering from props alone and reaches for no store ([L10]) | appearance | props → CSS + DOM attributes (`data-kind`, `data-lit`) | [L06], [L10] |
| the Lens row's badge facts | appearance | new subscribing wrapper: `getDeckStore()` + `useSyncExternalStore`, exactly as `slot-picker.tsx` does — never a store read inside `CardsSessionRow` | [L02], [L06] |

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files (if any) {#new-files}

| File | Purpose |
|------|---------|
| `tugdeck/src/components/tugways/tug-column-badge.tsx` | The badge component and its pure helpers |
| `tugdeck/src/components/tugways/tug-column-badge.css` | Geometry, knobs, pairings |
| `tugdeck/src/components/tugways/__tests__/tug-column-badge.test.ts` | Unit tests for the pure helpers and class/attribute projection |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `TugColumnBadge` | component | `tug-column-badge.tsx` | Spec S01 |
| `columnBadgeCharacter`, `columnBadgeLit` | fn | `tug-column-badge.tsx` | exported for unit tests |
| `CardTitleBarProps.placeArrangement` | prop | `components/chrome/tug-pane.tsx` | grows `index: number` and `count: number` (Spec S01, [P04]) |
| stack-badge trigger | JSX | `components/chrome/tug-pane.tsx` | `Layers`/`Rows2`/`Rows3` + count replaced by `TugColumnBadge` |
| `columnBadgeFactsOf` | fn | `tugdeck/src/deck-store-selectors.ts` | `(state, cardId)` → `{ kind, count, index } \| null`, over `deckColumnsOf` only — rails are out of reach and out of scope there (#step-3) |
| `.card-slot-badge` size knobs | CSS | `tugdeck/src/components/tugways/card-slot-badge.css` | 18×22/11px on the cluster chip ([P05]) |
| Lens session cell | JSX | `components/lens/sections/cards-session-cell.tsx` | badge rendered after the `slots` run |
| spike files | delete | `tugdeck/src/spikes/spike-deck-wayfinding.*` + 2 registry lines | Step 4 |
| spike count pin | test | `tugdeck/src/__tests__/card-taxonomy.test.ts` | 14 → 13 |

---

### Documentation Plan {#documentation-plan}

- [ ] `tuglaws/pane-model.md`: a badge-grammar paragraph — number-in-box = slot, count-over-slices = stack, letter-over-rungs = split; the badge says the fact the eye can't get; letters are split-only.
- [ ] Component docblock carries the full design argument (the six-round derivation compressed), per [L19].

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit** | `columnBadgeCharacter` / `columnBadgeLit` truth tables; `columnBadgeFactsOf` over constructed deck states | Step 1, Step 3 |
| **App-test (integration)** | The badge on real panes in the real app: content, lit element, footprint parity, menu still opens | Steps 2–3 |
| **Drift Prevention** | `card-taxonomy.test.ts` spike pin; `@covers` resolution via `just app-test-covers-check` | Steps 1–4 |

#### What stays out of tests {#test-non-goals}

- jsdom render tests of the badge — banned shape; the app-tests exercise the real render.
- SVG path-geometry assertions — brittle; assert `data-kind` / `data-lit` and the badge's rect instead.
- Screenshot goldens — theme-dependent; the contrast audit and eyes govern appearance.

---

### Execution Steps {#execution-steps}

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | TugColumnBadge component | done | `c63496129` |
| #step-2 | The cluster badge rewired | done | `11e8f353c` |
| #step-3 | The Lens row badge | done | `d1e2f8ffc` |
| #step-4 | Doctrine and graduation | done | `ee9e1e86f` |
| #step-5 | Integration Checkpoint | done | `577091982` |

#### Step 1: TugColumnBadge component {#step-1}

**Commit:** `tugways: TugColumnBadge — count over slices, letter over rungs`

**References:** [P01] Three vocabularies, [P02] One shape one glyph, Spec S01, Spec S02, (#symbol-inventory)

**Artifacts:**
- `tug-column-badge.tsx`, `tug-column-badge.css`, unit test file (Symbol Inventory).

**Tasks:**
- [ ] Build the component to Spec S01 and the glyphs to Spec S02, transcribing geometry from `spike-deck-wayfinding.tsx` / `.css` while the spike still exists as reference.
- [ ] Declare the pairings table in the CSS; run the contrast audit.
- [ ] Docblock per [L19] with laws cited.

**Tests:**
- [ ] Unit (`bun:test`, pure functions only): `columnBadgeCharacter` truth table (stack counts 2–5; split letters A–D) and `columnBadgeLit` truth table (0 / last / middle across counts 2–4, including a deep column where several interior indices all answer `"middle"`).
- [ ] The rendered `data-kind` / `data-lit` attributes are **not** unit-tested — there is no DOM substrate under `bun:test`, and a render test would be a banned shape. The helpers ARE those attribute values, so the unit tests pin the logic and the app-tests in #step-2 pin that the component actually writes them.

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bun test src/components/tugways/__tests__/tug-column-badge.test.ts && bunx vite build`
- [ ] `bun run audit:theme-contrast`

---

#### Step 2: The cluster badge rewired {#step-2}

**Depends on:** #step-1

**Commit:** `tugdeck: cluster column badge — slices count stacks, rungs letter splits`

**References:** [P01], [P03] Presentational component, [P04] Rail and column same badge, [P05] Cluster pair size, Spec S01, Risk R02, (#s01-component-api, #p05-cluster-pair-size)

**Artifacts:**
- `tug-pane.tsx`: `placeArrangement` grows `index`/`count`; the trigger's content becomes `TugColumnBadge`; the stack aria-label keeps its count wording, the split aria-label gains the band letter.
- `card-slot-badge.css`: the three size knobs on `.card-slot-badge` ([P05]).
- **New claims** in at0401-sidebar-split (split members read `A`/`B`) and at0455-column-split (footprint parity). No existing assertion is rewritten — see the churn survey below.

**What the badge swap does and does not break** (surveyed against the tests, not assumed):
- `at0347` asserts `badgeText` is `"2"` on a stacked slot, and `at0359` asserts `"2"` on a stacked rail. A stack still renders its **count**, and the glyph is SVG with no text nodes, so `textContent` is unchanged and both pass untouched.
- `at0404` asserts only the badge's tooltip phrase (`"Show a card, or split this column"`), which [P03] leaves alone. It is a **regression check here, not a rework**.
- `at0401` and `at0455` use the badge as a click target and count badges; neither asserts split badge text today. They pass as-is, which is exactly why the new per-member letter claim has to be **added** — otherwise the most visible behavior change in this step would be pinned by nothing.
- The testid `tug-pane-title-bar-stack-badge` is kept, which is what holds all four selectors valid.

**Tasks:**
- [ ] Fill `placeArrangement.index`/`.count` at the `CardTitleBar` call site from `sidebarStack` (`memberIndex`, `count`) or `columnMember` (`index`, `count`); a stacked place passes `slotStack.length` as count.
- [ ] **Do not gate the badge on `placeArrangement`.** Today the badge renders under `slotStack.length > 1` alone, while `placeArrangement` is set only when `sidebarStack` exists or `placement !== undefined`. A pane that shares a place but reaches the bar without `placeArrangement` must still render a badge; the missing record reads as `kind: "stack"` with `count = slotStack.length`, which is the same default `placeSplit === false` gives that pane today.
- [ ] Housekeeping: drop the `Layers` / `Rows2` / `Rows3` imports from `tug-pane.tsx` if the swap leaves them unused (the menu rows do not use them).
- [ ] Replace the trigger's `icon`/children with the badge; keep testid `tug-pane-title-bar-stack-badge`, the tooltip's door sentence, and the menu untouched ([P03]).
- [ ] Re-pair `--tugx-column-badge-fg` in the cluster to the pane-control resting ink the slot badge uses (`--tugx-pane-control-off-fg-rest`, which `card-slot-badge.css` already maps `--tugx-slot-rest-fg` to, including its `[data-focused="true"]` variant), so the pair reads as one register in both focus states.
- [ ] Set the three `--tugx-slot-*-sm` knobs on `.card-slot-badge` to 18px / 22px / 11px ([P05]) — the same values the file already sets on `.card-slot-badge-picker`.
- [ ] Add the new claims: per-member letters (`A` and `B` on a split of two) in at0401, and footprint parity in at0455 — comparing the badge's rect to the **slot badge's rect**, never to hard-coded pixels ([P05]).
- [ ] Run the four existing badge tests unchanged and confirm the survey above held; if one does move, say which and why in the commit body.
- [ ] Update `@covers` headers where the exercised source changed.

**Tests:**
- [ ] App-tests named above, green via the selective runner.

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bunx vite build`
- [ ] `just app-test tests/app-test/at0347-stack-badge-picker.test.ts tests/app-test/at0359-sidebar-stack.test.ts tests/app-test/at0401-sidebar-split.test.ts tests/app-test/at0404-title-bar-tooltips.test.ts tests/app-test/at0455-column-split.test.ts`

---

#### Step 3: The Lens row badge {#step-3}

**Depends on:** #step-1

**Commit:** `tuglens: column badge follows the slot run on structured rows`

**References:** [P01], [P03], Spec S01, (#symbol-inventory, #non-goals)

**Artifacts:**
- `columnBadgeFactsOf` in `deck-store-selectors.ts`; badge rendered in `cards-session-cell.tsx` after the `slots` run.

**Tasks:**
- [ ] Write `columnBadgeFactsOf(state, cardId)` **over `deckColumnsOf` alone**: resolve the host pane, find the column whose `members` include its id, and return `{ kind: "split", count, index }` when `mode === "split"` and `members.length > 1`, `{ kind: "stack", count }` when the column stacks two or more, and `null` otherwise (a lone member, no imposition, or no host).
- [ ] **Do not attempt to resolve rails in this selector**, and do not reach for `sidebarRailsOf`: it is module-private to `components/chrome/deck-canvas.tsx` and reads `getAllRegistrations()`, a boot-time registry rather than deck state, so a `(state, cardId)` selector in `deck-store-selectors.ts` cannot call it without dragging the registry into the selector layer. It also does not need to — `DeckManager.assignCardsToSlots` and `movePaneToSlot` both refuse a sidebar-hosted pane, so a rail pane carries no `slot` and can never appear in `deckColumnsOf`; and the only `layoutRole: "sidebar"` cards in the tree are the Lens, Jots, and Overview (`components/lens/lens-register-card.tsx`, `components/jots/jots-card-registration.tsx`, `components/overview/overview-card-registration.tsx`), none of which is a Session card. The cluster badge covers rails through `sidebarStack` in #step-2; the Lens does not need to.
- [ ] Render the badge through a **small subscribing wrapper**, the way `components/lens/slot-picker.tsx` already does — `getDeckStore()` + `useSyncExternalStore` inside the wrapper, returning `null` when the facts are `null` ([L02]). Do not read the deck store from `CardsSessionRow`, which today takes everything as props and subscribes to nothing.
- [ ] Pass it into `SessionIdentityRow` beside the existing `slots={<SlotPicker …/>}` content, as a readout (no `onClick`), sized by the same knob values `slot-picker.css` sets (18×22/11px).
- [ ] Letters stay split-only: a buried row's badge is the count; the run's outlined chip continues to say "buried" ([P01]).

**Tests:**
- [ ] Unit: `columnBadgeFactsOf` over constructed deck states — alone → `null`; stacked 3 → `{kind:"stack",count:3}`; split of 2, lower member → `{kind:"split",count:2,index:1}`; a card with no host pane → `null`; no imposition → `null`.
- [ ] App-test: extend at0455-column-split with a Lens-row claim — the split members' rows show `A` and `B`; a lone card's row shows no badge.

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bun test && bunx vite build`
- [ ] `just app-test tests/app-test/at0455-column-split.test.ts`

---

#### Step 4: Doctrine and graduation {#step-4}

**Depends on:** #step-2, #step-3

**Commit:** `tugdeck: graduate the deck-wayfinding spike; badge grammar into pane-model`

**References:** [P01], [P02], (#documentation-plan, #context)

**Artifacts:**
- `tuglaws/pane-model.md` badge-grammar paragraph; spike files deleted; `spike-registry.tsx` two lines removed; `card-taxonomy.test.ts` pin 14 → 13.

**Tasks:**
- [ ] Write the doctrine paragraph (Documentation Plan).
- [ ] Delete `spike-deck-wayfinding.tsx` / `.css` and the registry import + entry; restore the taxonomy pin.
- [ ] Note in the commit body that a saved layout holding the spike open will drop that pane on next launch (the spike contract's documented after-effect).

**Tests:**
- [ ] `bun test src/__tests__/card-taxonomy.test.ts` green at the restored pin.

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bun test && bunx vite build`
- [ ] `just app-test-covers-check`

---

#### Step 5: Integration Checkpoint {#step-5}

**Depends on:** #step-4

**Commit:** `N/A (verification only)`

**References:** [P01]–[P04], (#success-criteria)

**Tasks:**
- [ ] `tugutil dash replay <name>` — put the rounds on the live base, so what gets verified is what would land.
- [ ] `Replayed` / `Recorded`: verify the replayed tree with `sh scripts/verify-fit.sh <base-sha> <head-sha>`.
- [ ] `Current`: the base never moved, so the last step's checkpoint already verified these exact bytes — re-run nothing and say so.
- [ ] `Conflicted`: resolve the named round in the worktree, then verify as above.

**Tests:**
- [ ] None of its own. This step re-proves nothing the steps proved; it establishes that their work still holds on the base as it stands now.

**Checkpoint:**
- [ ] The replay reports its outcome, and the scoped verification is green **or** was correctly skipped as `Current`.

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** The deck says a card's whole coordinate in three legible, same-footprint badges — slot number, stack count over lit slices, split letter over lit rungs — on the pane cluster and the Lens rows, with the design spike graduated and deleted.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] Stack and split badges render per [P01]/[P02] on real panes (app-tests, Step 2).
- [ ] Footprint parity with the slot badge holds at 18×22 (rect-to-rect assertion, Step 2; [P05]).
- [ ] The badge door still opens its menu (at0347, Step 2).
- [ ] Lens rows carry the badge exactly when the column has structure (app-test, Step 3).
- [ ] Grammar recorded in `pane-model.md`; spike deleted; taxonomy pin restored (Step 4).
- [ ] Replay-verified fit on the live base (Step 5).

**Acceptance tests:**
- [ ] at0347, at0359, at0401, at0404, at0455 reworked and green (Step 2; at0455 extended again in Step 3).
- [ ] `tug-column-badge.test.ts` and the `columnBadgeFactsOf` unit tests green (Steps 1, 3).

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] Lens file rows: the same badge on `cards-section` file cells if structured columns of text files turn out to be common.
- [ ] Muted-ink count variant if Risk R01's eval finds the stack pair runs on.
- [ ] Keyboard path to the badge's menu (focus-engine work, currently tabled).

| Checkpoint | Verification |
|------------|--------------|
| Component ships alone | Step 1 checkpoint |
| Cluster swap is invisible except pixels | Step 2 app-tests |
| Lens badge appears/disappears with structure | Step 3 app-test claim |
| Spike graduated | Step 4 taxonomy pin |
