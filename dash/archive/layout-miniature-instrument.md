## The Layout Miniature Becomes the Instrument {#layout-miniature-instrument}

**Purpose:** Redesign the Lens **Layout** section around direct manipulation of its miniature: the drawing of the deck becomes the per-place control surface — every slot, rail, and sidebar block is a pressable place wearing its stored arrangement — and the per-place mixer rows (sidebar sides, rails, columns) are deleted, leaving exactly three deck-wide rows.

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

**Round 1 — 2026-08-22, fable.** Reviewed `plan:5c1cc27de07ceb1a`. Lint: 0 errors, 0 warnings.
Oriented on: a first pass over the whole document, read against `components/lens/sections/layouts-section.tsx` (the full 1045 lines), `components/lens/layout-miniature.tsx` (the full 564), `components/tugways/use-item-group-keyboard.ts`, `components/tugways/tug-choice-group.tsx`, `lib/layout-imposer.ts` (`columnModeOf`/`withColumnMode`), `deck-store-selectors.ts` (`columnDrawsSplit`), `components/tugways/action-vocabulary.ts` (the three verbs), and a grep establishing that only `at0401`/`at0455` press the doomed row testids while `at0277`/`at0278` ride the surviving Cards/Layout groups.
Applied: **technical choice** — Spec S02 named a `TugButton` primitive that does not exist; corrected to `TugIconButton` (`components/tugways/tug-icon-button.tsx`), the primitive the pane's control cluster itself composes. **Hole** — Spec S02's rail-member affordances were placed "at the rail's rect", but a stacked rail's drawn members are near-congruent slivers offset by `RAIL_DEPTH_PCT` (3%) and cannot be press targets; the spec now gives the affordance run its own geometry — equal vertical shares of the strip's height regardless of the drawing beneath. **Law [L11]** — Step 3 and Step 4 read as if the overlay could call `dispatchCommand` itself; both now state the control emits `selectValue` up the responder chain with the rows' existing sender ids (`lens-layouts-column:<slot>`, `lens-layouts-rail:<side>`, `lens-layouts-side:<componentId>`) and the section's one responder does the dispatching, exactly as the rows did; the State Zone Mapping row was corrected to match. **Tuglaws cross-check** — [L02] holds (all store reads stay in the section's existing `useSyncExternalStore` hooks, passed down as props); [L06] holds (preview visibility stays the `data-plan-active` attribute switch; the overlay cursor is `useItemGroupKeyboard`'s DOM projection); [L03] holds (focusable registration rides the hook's layout effects); [L30] holds (the funnel routing above); the preview-id contract was verified against `previewIdOf`'s actual resolution (`[data-preview-axis]` ancestor + `data-choice-value`, active-segment suppression inapplicable since affordances never carry `data-state="active"`).
Deferred: nothing. The one ambiguity in the idea — press versus drag for sidebar blocks — was settled in-plan as [P04] with drag recorded in #roadmap, since with two edges a press already reaches the only other destination.

---

### Phase Overview {#phase-overview}

#### Context {#context}

The Layout section (`tugdeck/src/components/lens/sections/layouts-section.tsx`) draws the deck once — a scale picture (`components/lens/layout-miniature.tsx`) under a caption — and then re-describes it in words: up to **thirteen** segmented mixer rows (Cards, Layout, Card Width, one row per registered sidebar card, two rail rows, and one row per shared content slot). The reader's eye joins "Column 3" in the row list to the third slot in the picture on every read, and the row count grows with every card and axis. The mixer idiom stopped scaling.

It also carries a live trap. The column rows are gated on membership (`shareableColumns = columns.filter((c) => c.members.length > 1)`), on the argument that "a column of one is already unsplit and has nothing to restore." That argument is false: membership churn deliberately preserves the stored arrangement (`columnModeOf` keeps answering `"split"`; see `columnDrawsSplit` in `deck-store-selectors.ts` and its docstring), so a slot storing `mode: "split"` with one card is **invisible everywhere and unfixable from the UI** — the stored split silently resurfaces when a second card arrives. The rails avoided this exact trap with always-present rows; the columns walked into it.

#### Strategy {#strategy}

- Split the section's questions into their two natural kinds: **deck-wide** (Cards, Layout, Card Width — three rows, the mixer idiom kept) and **per-place** (side, stack/split — moved into the drawing).
- Keep `LayoutMiniature` purely presentational ([L06]). Interaction lives on a new sibling **places overlay** whose geometry comes from the same pure function the drawing uses, so the two cannot drift.
- Every occupied place wears its **stored** mode (`columnModeOf` / `railModeOf`), not its rendered one, as a small stack/split glyph in the `TugColumnBadge` icon language. A one-member place shows its glyph in a dimmed register and still toggles — which fixes the trap.
- Reuse the existing preview machinery verbatim: affordances carry the same `data-preview-axis` / `data-choice-value` attributes the rows carry today, so `previewIdOf` and the `data-plan-preview-id` layer switch work untouched.
- Keyboard access composes `useItemGroupKeyboard`: the overlay is **one** stop in the section's focus walk with a movement cursor over its affordances — arrows audition via the preview layers, Space commits ([P24] deferred model), exactly the grammar the rows teach today.
- Sequence the stored-mode glyph first: it fixes the live bug independently of everything after it.

#### Success Criteria (Measurable) {#success-criteria}

- A slot storing `mode: "split"` with one card shows a split glyph in the Layout drawing, and pressing that glyph sets the slot back to stack — verified by a new app-test claim (rect + `data-` reads, then a store-truth read after the press).
- The section renders exactly three mixer rows regardless of deck contents; the sidebar/rail/column row testids (`lens-layouts-side-*`, `lens-layouts-rail-*`, `lens-layouts-column-*`) no longer exist in the DOM.
- Pressing a slot's glyph dispatches `set-column-mode`, a rail glyph `set-rail-mode`, a sidebar member `set-sidebar-side` — all through `dispatchCommand`, none through direct store writes (verified by the app-tests observing the resulting deck geometry, the same way `at0455` does).
- Hovering an overlay affordance shows the corresponding preview layer; moving the keyboard cursor onto it does the same; leaving restores the committed drawing — same `data-plan-active` mechanics as today, pinned by adapting the existing hover/cursor assertions.
- Every overlay affordance's hit rect is at least 16×16 px at the section's resting width (measured by `getBoundingClientRect` in the app-test).
- `cd tugdeck && bunx tsc --noEmit && bun test && bunx vite build` and `bun run audit:theme-contrast` all pass.

#### Scope {#scope}

1. Geometry extraction from `LayoutMiniature` into a shared pure function.
2. The places overlay: stored-mode glyphs on occupied slots and occupied rail sides, sidebar members with identity.
3. Pointer and keyboard commits from the overlay through the command funnel; previews from hover and cursor.
4. Deletion of the sidebar-side, rail, and column mixer rows and their senders, captions, and row-driven preview wiring.
5. App-test rework for the deleted rows and new claims for the overlay.

#### Non-goals (Explicitly out of scope) {#non-goals}

- **Dragging** a sidebar block between edges. With exactly two edges, a press already reaches the only other destination; drag adds pointer-capture machinery for no new capability. Named as a follow-on (#roadmap) — see [P04].
- Reordering stack members or dragging split seams from the miniature — the deck's own surfaces own those gestures.
- Any change to the three deck-wide rows (Cards, Layout, Card Width) beyond their focus orders staying as they are.
- Any change to the deck's stores, verbs, or the imposition record — `set-column-mode`, `set-rail-mode`, `set-sidebar-side` already exist and are sufficient.
- Empty slots. An empty slot has no occupant to arrange; its stored mode (if any) surfaces the moment a card arrives, as a dimmed glyph.

#### Dependencies / Prerequisites {#dependencies}

- The `TugColumnBadge` icon language (stack slices / split ladder) shipped in `dash/slot-stack-split-affordances.md`; this plan reuses its glyph shapes.
- `columnDrawsSplit` and the stored-vs-drawn distinction in `deck-store-selectors.ts`.
- The command verbs `SET_COLUMN_MODE` (`{ slot, mode }`), `SET_RAIL_MODE` (`{ side, mode }`), `SET_SIDEBAR_SIDE` (`{ componentId, side }`) in `components/tugways/action-vocabulary.ts`, already handled by `command-dispatch.ts`.
- `useItemGroupKeyboard` (`components/tugways/use-item-group-keyboard.ts`) — the shared item-container keyboard wiring `TugChoiceGroup` composes.

#### Constraints {#constraints}

- [L02] store reads via `useSyncExternalStore` only; [L06] preview visibility stays DOM attributes, never React state; [L11] the overlay's commits go up the responder chain / command funnel; [L30] the section never touches the deck store directly.
- WARNINGS ARE ERRORS; `bunx vite build` before declaring tugdeck work done; app-tests selective, never a sweep; output never piped.
- Overlay affordances need real hit targets (≥16 px square); the miniature may grow a step taller to afford them.
- No jsdom render tests; no assertions that read back a declared style value; app-test claims are rects, `data-` attributes, and store-truth reads.

#### Assumptions {#assumptions}

- The registered sidebar set is boot-fixed (`sidebarEntries()` reads `getAllRegistrations()` once per render; registration is a boot step) — the overlay may treat it the same way the rows do today.
- `at0401-sidebar-split.test.ts` and `at0455-column-split.test.ts` are the only app-tests that press the deleted rows (`lens-layouts-side-*` / `lens-layouts-rail-*` / `lens-layouts-column-*` testids); `at0277` / `at0278` ride `lens-layouts-kind` / `lens-layouts-layout`, which survive. Re-verify with a grep at Step 6.

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

This plan uses the devise-skeleton conventions: explicit `{#anchor}` on every cited heading, `[P##]` for plan-local decisions, `**Depends on:**` with `#step-N` anchors, and rich `**References:**` lines. No line numbers anywhere.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

None open. The one question the idea left ambiguous — "pressing **or dragging** a sidebar block" — is settled as [P04]: press ships, drag is a named follow-on, because with two edges a press already reaches the only other destination.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Overlay geometry drifts from the drawing | high | med | One pure geometry function feeds both (Spec S01); an app-test compares an overlay affordance's rect against its block's rect | Step 2 checkpoint |
| Glyph targets too small to press at miniature scale | med | med | Hit rect padded beyond the drawn glyph; miniature grows a step; 16 px floor asserted | Step 2/3 checkpoints |
| Preview-layer count grows with occupied places | low | low | Bounded: ≤6 slots ×2 + 2 sides ×2 + sidebars ×2 ≈ 22 hidden layers, same order as today's | Perf trace if the Lens rows jank |
| Keyboard walk regression in the section | med | med | The overlay is one `useItemGroupKeyboard` stop, the same shape as every `TugChoiceGroup`; `at0277`/`at0278` keep pinning the section's walk | Step 5 checkpoint |
| Losing the always-visible rail rows hides "this side can be split" from a reader who never hovers | low | med | The rail's glyph is always drawn on an occupied side (dimmed at one member), so the fact stays stated — in the picture instead of a row | User eval on a debug build |

**Risk R01: Overlay/drawing drift** {#r01-overlay-drift}

- **Risk:** Two components computing "where is slot 3" independently disagree by a seam's width and the affordance stands over the wrong block.
- **Mitigation:** Spec S01 extracts the block/rail arithmetic `LayoutMiniature` already performs into one exported pure function; the overlay consumes its output verbatim; a rect-containment claim pins it.
- **Residual risk:** The committed drawing's live flow/column offsets move blocks the overlay does not track; [P02] pins the overlay to the resting geometry and dims it under live motion states where the mismatch would show.

**Risk R02: The picture must still teach** {#r02-picture-teaches}

- **Risk:** Rows carried captions ("Left Rail", "Column 3"); glyphs carry none, and a first-time reader may not know a glyph is pressable.
- **Mitigation:** Affordances are real buttons with `aria-label`s and tooltips naming the place and the act ("Column 3 — split" / "Lens — move to left edge"); hover swaps the caption line to the preview's caption exactly as rows do today, which is itself the teaching.
- **Residual risk:** Only pixels and use settle it; the debug-build eval is the test.

---

### Design Decisions {#design-decisions}

#### [P01] Three deck-wide rows stay; every per-place control moves into the drawing (DECIDED) {#p01-rows-diet}

**Decision:** The section keeps exactly three mixer rows — Cards, Layout, Card Width — and deletes the sidebar-side rows, the two rail rows, and the per-slot column rows. Per-place facts and gestures live on the miniature.

**Rationale:**
- Deck-wide facts are three and enumerable; the segmented-row idiom genuinely fits them. Per-place facts scale with the deck (up to thirteen rows today) and each row re-describes a place the picture already draws, taxing the reader with the join.
- A fixed-height section stops resizing as cards move — the rows below it stop jumping.

**Implications:**
- `SIDE_SENDER_PREFIX`, `RAIL_SENDER_PREFIX`, `COLUMN_SENDER_PREFIX` routing in the section's responder moves to the overlay's commit path; the row JSX, captions, and testids are deleted (#step-6).
- `at0401` / `at0455` re-drive their gestures through the overlay (#step-7).

#### [P02] Interaction lives on a places overlay; the drawings stay presentational (DECIDED) {#p02-places-overlay}

**Decision:** `LayoutMiniature` keeps `pointer-events: none` and stays props-in/CSS-out ([L06]). A new sibling component, `LayoutPlaces`, renders the affordances over the plan area, positioned by the same geometry function the drawing uses (Spec S01). The overlay draws at the **resting** geometry and hides while a preview layer is active (`.layouts-plan[data-previewing]` already exists to key on).

**Rationale:**
- The committed drawing hides under `data-previewing` — affordances inside it would vanish under the very pointer that is hovering them.
- The preview layers are proposals; a proposal is not pressable. One always-mounted overlay serves every layer beneath it.
- Keeping the drawing pure preserves its contract with every other caller (the preview layers render the same component).

**Implications:**
- Geometry extraction is its own step (#step-1) so the refactor lands with zero visual change before anything is built on it.
- The overlay does not track live flow offsets or column slides; it stands at rest. This is the resting fact of the arrangement, which is exactly what its controls set.

#### [P03] A place wears its STORED mode, always; one-member places dim but still act (DECIDED) {#p03-stored-mode-always}

**Decision:** Each occupied slot's glyph reads `columnModeOf(imposition, slot)` and each occupied rail side's reads `railModeOf(imposition, side)` — the stored arrangement, not the drawn one (`columnDrawsSplit`). A place with one member draws its glyph in a dimmed register and remains pressable.

**Rationale:**
- The drawing's blocks honestly show what is ON SCREEN (one undivided card); the glyph honestly shows what the place is SET to. The two facts came apart at exactly one card, and stating both, each in its register, is the fix for the invisible-split trap.
- The membership gate (`shareableColumns`) rested on a premise (`a column of one has nothing to restore`) that membership-preserving arrangements falsified. The gate dies; the `useDeckColumns` docstring and the `shareableColumns` comment that argue for it are rewritten to argue for this.

**Implications:**
- `useDeckColumns` stops filtering; every occupied slot gets a glyph.
- Preview layers must exist for every occupied slot and every occupied rail side, one-member places included (#step-3).

#### [P04] Press is the gesture; drag is a follow-on (DECIDED) {#p04-press-not-drag}

**Decision:** A mode glyph toggles stack↔split on press. A sidebar member moves to the other edge on press. No drag machinery ships in this phase.

**Rationale:**
- Both facts are two-valued (stack/split; left/right). A press reaches the only other value in one gesture; a drag would arrive at the same place with pointer-capture, thresholds, and a ghost to design.
- The idea's own wording ("pressing or dragging") licenses either; the cheaper gesture that loses nothing ships first.

**Implications:**
- Drag-to-edge is recorded in #roadmap, not silently dropped.

#### [P05] The preview machinery is reused verbatim (DECIDED) {#p05-preview-reuse}

**Decision:** Overlay affordances carry `data-preview-axis` (on the affordance group) and `data-choice-value` (on the pressable element), the exact attributes `previewIdOf` in `layouts-section.tsx` already resolves — so hover and keyboard-cursor previews work through the existing `setPreview` / `data-plan-preview-id` / `data-plan-active` switch with no new mechanism.

**Rationale:**
- The machinery is proven, tested (`at0277`/`at0278` pin the cursor-preview path), and already [L06]-clean. New attributes would mean a second resolver to keep in step with the first.

**Implications:**
- A toggle affordance carries the **proposed** value (the mode it would set — the opposite of the stored one), so hovering it previews the change, and `previewIdOf`'s active-segment suppression never applies (the affordance is never "active" in the choice-group sense).
- The section's hover handlers (`onPointerOver` / `onPointerLeave` on `.layouts-section-rows`) extend to the overlay's container, and the `MutationObserver` watching `data-key-cursor` / `data-key-view-kbd` widens its root to include the overlay (#step-5).

#### [P06] The overlay is one keyboard stop, cursor over its places (DECIDED) {#p06-one-stop}

**Decision:** `LayoutPlaces` registers as a single focusable via `useItemGroupKeyboard` — group = the section's `host.focusGroup`, order = `LAYOUTS_WIDTH_FOCUS_ORDER + 1` — with the movement cursor walking its affordances in reading order (left rail members, then slots 1..N, then right rail members). Space commits the cursor affordance; arrows audition through [P05].

**Rationale:**
- One stop per component is the Tab-walk law the whole section already obeys ([P24] commit model, seams between groups); a stop per affordance would make Tab crawl the picture.
- `useItemGroupKeyboard` is exactly the contract: `collectItems` returns the affordance elements, `onSelect` dispatches the command the pressed element names.

**Implications:**
- The three surviving rows keep focus orders 0–2; the overlay takes 3; the per-sidebar/rail/column order arithmetic (`LAYOUTS_FIRST_SIDEBAR_FOCUS_ORDER + …`) is deleted with the rows.

#### [P07] Rail members gain identity (DECIDED) {#p07-rail-identity}

**Decision:** The overlay receives the sidebar entries themselves — `{ componentId, title, side }[]` from the section's `sidebarEntries()` + `sidebarSide()` — not the count-only `MiniatureRails`. Each rail member affordance knows which card it stands for; pressing it dispatches `SET_SIDEBAR_SIDE` for that `componentId` toward the other edge.

**Rationale:**
- `MiniatureRails` is `Partial<Record<SidebarSide, number>>` — counts, no identity — which is all a drawing needs and less than a control needs. The drawing's props stay as they are; the overlay's are its own.

**Implications:**
- Member order within a rail: registration order filtered to that side, matching the drawing's back-to-front stack order assumption; the affordance's `aria-label` carries the card's title.

---

### Specification {#specification}

**Spec S01: `miniatureGeometry` — one arithmetic, two consumers** {#s01-miniature-geometry}

Extract the layout arithmetic `LayoutMiniature` performs inline (rail percentage, fit shares, flow blocks and scale, split member spans) into an exported pure function in `layout-miniature.tsx`:

```ts
export interface MiniaturePlaceRects {
  /** Occupied side → its strip's inline extent, percent of the drawing. */
  rails: Partial<Record<SidebarSide, { leftPct: number; widthPct: number }>>;
  /** Slot → its block's inline extent within the field, plus the field's own extent. */
  field: { leftPct: number; widthPct: number };
  blocks: readonly { slot: number; leftPct: number; widthPct: number }[];
}
export function miniatureGeometry(args: {
  kind: ImpositionKind | null;
  rails: MiniatureRails;
  width?: ContentWidth;
  layout?: ImpositionLayout;
}): MiniaturePlaceRects;
```

Resting geometry only — no flow offsets, no column slides, no live extents ([P02]). `LayoutMiniature` is refactored to derive its resting positions from this function (the live/committed additions stay where they are, applied on top); `LayoutPlaces` consumes it directly. The function is unit-testable with plain truth tables (shares sum, seams count, rail trade against width presets).

**Spec S02: `LayoutPlaces` — the overlay** {#s02-layout-places}

New files `components/lens/layout-places.tsx` / `.css`. Rendered by `LayoutsSectionBody` as a sibling **after** the plan div, absolutely positioned over the plan's miniature area (the plan keeps `pointer-events: none`; the overlay takes the pointer).

Affordances, in reading order:

1. **Left rail members** (if occupied): one affordance per sidebar card on the left, laid out as **equal vertical shares of the rail strip's height** regardless of the stack/split drawing beneath — a stacked rail's drawn members are near-congruent slivers offset by a 3% peek (`RAIL_DEPTH_PCT`), which cannot be press targets, so the affordance run is its own geometry over the strip's rect. Press → `SET_SIDEBAR_SIDE { componentId, side: "right" }`. Attributes: `data-preview-axis="side:<componentId>"`, `data-choice-value="right"` (the proposed side). The existing per-sidebar preview layers (`side:<componentId>:<side>`) serve these unchanged.
2. **Left rail mode glyph** (if the left side is occupied): the stack/split glyph at the rail strip's foot. Press → `SET_RAIL_MODE { side: "left", mode: <other> }`. `data-preview-axis="railmode:left"`, `data-choice-value=<proposed mode>`. Dimmed (`data-dim`) when the side holds one member; still enabled.
3. **Per-slot mode glyphs**: one per occupied slot, at the block's foot, reading `columnModeOf`. Press → `SET_COLUMN_MODE { slot, mode: <other> }`. `data-preview-axis="columnmode:<slot>"`, `data-choice-value=<proposed mode>`. Dimmed at one member; still enabled ([P03]).
4. **Right rail mode glyph**, **right rail members**: mirrors of 1–2.

Glyph drawing: reuse the `TugColumnBadge` glyph shapes — export `StackGlyph` and `LadderGlyph` from `components/tugways/tug-column-badge.tsx` (they are module-private today) and render them with `lit={null}`; the overlay's CSS pairs their `--tugx-column-badge-*` knobs to the Lens control tokens the Lens badge already uses (`components/lens/lens-column-badge.css` is the model). No level marking — the glyph names the arrangement, not a position.

Every affordance composes `TugIconButton` (`components/tugways/tug-icon-button.tsx` — the same primitive the pane's control cluster composes; never a hand-rolled button) with an `aria-label` naming place and act ("Column 3 — split", "Left rail — stack", "Jots — move to left edge") and a tooltip carrying the same words. Hit rect ≥16×16 px via padding beyond the drawn glyph. The overlay root carries `data-testid="lens-layouts-places"`; affordances `data-testid="lens-layouts-place-<key>"` where key is `col-<slot>`, `rail-<side>`, `side-<componentId>`.

Dimming and hiding: the overlay hides (CSS, keyed on the sibling plan's `data-previewing`) while any preview layer is active, and while a drag gauge is live (`[data-carrying]` on the deck root, if present at this DOM scope — verify at implementation; otherwise omit).

**Spec S03: Preview layers for every occupied place** {#s03-layers-for-places}

`LayoutsSectionBody` today generates `railmode:*` layers only for `sharedSides` and `columnmode:*` layers only for `shareableColumns`. Both filters die with [P03]: layers are generated for **every occupied rail side** and **every occupied slot**, both modes each. A one-member place's two proposals draw the same picture (the drawing keys on member counts ≥2); their captions differ — `Column 3 Stack` / `Column 3 Split` — which is the honest statement that the change is to the stored arrangement, not the picture.

---

#### State Zone Mapping (tugdeck/tugways plans) {#state-zone-mapping}

| State | Zone (appearance / local-data / structure) | Mechanism | Law |
|-------|--------------------------------------------|-----------|-----|
| Stored place modes shown by the overlay | data via existing subscription | the section's `useImposition()` / `useDeckColumns()` (`useSyncExternalStore` on the deck store), passed to `LayoutPlaces` as props | [L02] |
| Preview visibility | appearance | DOM attributes (`data-plan-active`, `data-previewing`) toggled by handlers + `MutationObserver` — unchanged | [L06] |
| Overlay keyboard cursor | appearance | `useItemGroupKeyboard` → `data-key-cursor` projection, no React state | [L06], [L22] |
| Overlay focusable registration | structure | `useItemGroupKeyboard`'s `useFocusable`, layout effects | [L03] |
| Commits from affordances | actions | `selectValue` up the responder chain with the rows' sender ids → the section's responder → `dispatchCommand(SET_COLUMN_MODE / SET_RAIL_MODE / SET_SIDEBAR_SIDE)` — the funnel, never store writes | [L11], [L30] |

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files (if any) {#new-files}

| File | Purpose |
|------|---------|
| `tugdeck/src/components/lens/layout-places.tsx` | The places overlay (Spec S02) |
| `tugdeck/src/components/lens/layout-places.css` | Overlay geometry, glyph pairing knobs, pairings table |
| `tugdeck/src/components/lens/__tests__/layout-miniature-geometry.test.ts` | Truth tables for `miniatureGeometry` (Spec S01) |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `miniatureGeometry`, `MiniaturePlaceRects` | fn/type | `components/lens/layout-miniature.tsx` | Spec S01; `LayoutMiniature` refactored onto it |
| `LayoutPlaces` | component | `components/lens/layout-places.tsx` | Spec S02 |
| `StackGlyph`, `LadderGlyph` | export | `components/tugways/tug-column-badge.tsx` | today module-private; exported for the overlay |
| `useDeckColumns` | fn | `components/lens/sections/layouts-section.tsx` | docstring rewritten per [P03]; `shareableColumns` filter deleted |
| layer generation | code | `components/lens/sections/layouts-section.tsx` | Spec S03 — filters on `sharedSides` / `shareableColumns` removed |
| responder routing | code | `components/lens/sections/layouts-section.tsx` | `RAIL_/COLUMN_/SIDE_SENDER_PREFIX` cases serve the overlay's dispatches; row JSX deleted |
| sidebar/rail/column rows | delete | `components/lens/sections/layouts-section.tsx` + `.css` | #step-6; testids `lens-layouts-side-*`, `lens-layouts-rail-*`, `lens-layouts-column-*` retired |
| miniature height step | CSS | `components/lens/sections/layouts-section.css` + `layout-miniature.css` | one size step taller so 16 px targets fit |

---

### Documentation Plan {#documentation-plan}

- [ ] `tuglaws/pane-model.md`: the Layout section's paragraph updates — the picture is the per-place instrument; a place wears its stored mode always; the one-card-split visibility rule joins the `columnDrawsSplit` story as its UI half.
- [ ] Component docblocks ([L19]) on `layout-places.tsx` carry the overlay-vs-drawing argument ([P02]) and the stored-vs-drawn argument ([P03]).

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit** (`bun:test`, pure) | `miniatureGeometry` truth tables: shares sum to the field, rail trade vs width preset, flow scale | Step 1 |
| **App-test (integration)** | Overlay affordances on the real Lens: rect containment vs blocks, stored-mode glyphs (incl. the one-card split), press → store truth, hover/cursor previews, keyboard walk | Steps 2–7 |
| **Drift prevention** | `@covers` resolution (`just app-test-covers-check`); grep-gate that the retired testids are gone | Steps 6–7 |

#### What stays out of tests {#test-non-goals}

- jsdom render tests — banned shape; the app-tests exercise the real render.
- Reading back declared style values (a glyph's stroke color, the overlay's opacity) — asserts only that we set what we set.
- Screenshot goldens.

---

### Execution Steps {#execution-steps}

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | The geometry extracted | done | `b0fbe708a` |
| #step-2 | The places overlay, readout first | done | `c9a702e43` |
| #step-3 | The glyphs take the pointer | done | `2336b34fc` |
| #step-4 | Sidebar members join the overlay | done | `59b112d65` |
| #step-5 | The overlay joins the keyboard walk | done | `7cc51529d` |
| #step-6 | The row diet | done | `cbbef6a56` |
| #step-7 | Test rework and integration checkpoint | done | `1ee07adec` |

#### Step 1: The geometry extracted {#step-1}

**Commit:** `lens(layout): extract miniatureGeometry from the drawing`

**References:** [P02] Places overlay, Spec S01, (#symbol-inventory)

**Tasks:**
- [ ] Extract the resting-geometry arithmetic from `LayoutMiniature` into exported `miniatureGeometry` per Spec S01; refactor the component to consume it. The live/committed additions (flow window position, column slides, gauge registrations) stay in the component, applied over the resting rects.
- [ ] No visual change: the refactor must be pixel-neutral.

**Tests:**
- [ ] Unit truth tables in `__tests__/layout-miniature-geometry.test.ts`: fit shares sum with seams for counts 1–6; rail percentage falls as width preset rises; flow blocks scale to 100 when the strip overflows; a split slot's block rect is unchanged by `columnSplits` (splits divide the run, not the band).

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bun test src/components/lens/__tests__/layout-miniature-geometry.test.ts && bunx vite build`
- [ ] `just app-test at0357-content-width-default.test.ts at0454-flow-mode.test.ts` — the miniature-reading tests stay green with zero drawing change.

#### Step 2: The places overlay, readout first {#step-2}

**Depends on:** #step-1

**Commit:** `lens(layout): places overlay wears each place's stored mode`

**References:** [P02] Places overlay, [P03] Stored mode always, Spec S02, (#s01-miniature-geometry)

**Tasks:**
- [ ] Export `StackGlyph` / `LadderGlyph` from `tug-column-badge.tsx`.
- [ ] Build `LayoutPlaces` per Spec S02, **readout-only this step** (`pointer-events: none` on the root for now): mode glyphs on every occupied slot (`columnModeOf`) and every occupied rail side (`railModeOf`), dimmed at one member; positioned by `miniatureGeometry`; hidden while `data-previewing`.
- [ ] Mount it from `LayoutsSectionBody` over the plan; pass imposition + columns + sidebar entries as props.
- [ ] Grow the miniature one size step in `layouts-section.css` / `layout-miniature.css` so 16 px targets will fit (#step-3 asserts them).
- [ ] `@tug-pairings` table in `layout-places.css`; run the contrast audit.

**Tests:**
- [ ] App-test (new file, `@covers` `layout-places.tsx`, `layouts-section.tsx`): with a deck holding a two-card stack in slot 1 and a slot 2 whose stored mode is split with **one** card (drive `set-column-mode` then remove a member, the `at0455` idiom), the overlay shows a stack glyph over slot 1's block and a **dimmed split glyph** over slot 2's — read `data-` attributes and rect containment against the drawn blocks. This is the visibility half of the bug, pinned.

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bunx vite build && bun run audit:theme-contrast`
- [ ] The new app-test green.

#### Step 3: The glyphs take the pointer {#step-3}

**Depends on:** #step-2

**Commit:** `lens(layout): mode glyphs toggle stack and split from the drawing`

**References:** [P03] Stored mode always, [P04] Press not drag, [P05] Preview reuse, Spec S03, (#s02-layout-places)

**Tasks:**
- [ ] Overlay takes the pointer; each mode glyph becomes a pressable control. A press emits `selectValue` **up the responder chain** with the proposed (opposite) mode as its value and the existing sender ids (`lens-layouts-column:<slot>`, `lens-layouts-rail:<side>`) — the section's one responder then turns it into `SET_COLUMN_MODE` / `SET_RAIL_MODE` exactly as it did for the rows ([L11]); the overlay never calls `dispatchCommand` itself.
- [ ] Affordances carry `data-preview-axis` / `data-choice-value` per [P05]; extend the section's `onPointerOver`/`onPointerLeave` preview handlers to the overlay container.
- [ ] Generate preview layers for every occupied slot and rail side per Spec S03 (delete the `sharedSides` / `shareableColumns` layer filters).
- [ ] Delete the `shareableColumns` filter and rewrite the `useDeckColumns` docstring per [P03].
- [ ] Assert every affordance hit rect ≥16×16 px.

**Tests:**
- [ ] App-test extension: pressing slot 2's dimmed split glyph sets the store to stack (read `columnModeOf` truth via the deck's geometry or the masthead badge — the trap closed end to end); pressing slot 1's stack glyph splits it (both members visible, the `at0455` geometry claims); hovering a glyph shows its layer (`data-plan-active` present, caption text names the place and mode) and leaving restores the committed drawing.

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bunx vite build`; the step's app-test green.

#### Step 4: Sidebar members join the overlay {#step-4}

**Depends on:** #step-3

**Commit:** `lens(layout): sidebar blocks press to the other edge`

**References:** [P04] Press not drag, [P07] Rail identity, Spec S02, (#s03-layers-for-places)

**Tasks:**
- [ ] Rail member affordances with identity per [P07]: press emits `selectValue` up the responder chain with the other side as value and sender `lens-layouts-side:<componentId>` — the existing `SIDE_SENDER_PREFIX` route turns it into `SET_SIDEBAR_SIDE` ([L11]).
- [ ] `data-preview-axis="side:<componentId>"` + `data-choice-value=<other side>` so the existing per-sidebar layers preview the move.
- [ ] `aria-label` / tooltip carry the card's title and destination.

**Tests:**
- [ ] App-test extension: pressing the Lens's member block moves the Lens to the other edge (rail counts flip in the drawing; the real Lens card moves — assert the card's pane side, the `at0401` idiom); hover previews the move.

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bunx vite build`; the step's app-test green.

#### Step 5: The overlay joins the keyboard walk {#step-5}

**Depends on:** #step-4

**Commit:** `lens(layout): the picture is one stop, arrows audition, Space commits`

**References:** [P05] Preview reuse, [P06] One stop, (#state-zone-mapping)

**Tasks:**
- [ ] Compose `useItemGroupKeyboard` in `LayoutPlaces`: `group: host.focusGroup`, `order: 3`, `collectItems` = the affordances in reading order, `onSelect` = the affordance's dispatch, deferred commit (no `commit: "live"`).
- [ ] Widen the section's `MutationObserver` root so cursor moves on the overlay resolve through `previewIdOf` (the affordances already carry the attributes it reads).
- [ ] Tab order check: Cards → Layout → Card Width → the picture.

**Tests:**
- [ ] App-test extension: Tab to the picture, arrow to a glyph — its preview layer shows; Space — the mode commits (store truth), the preview clears; the seam out of the group lands on the neighbouring stop (`at0277`'s idiom).

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bunx vite build`; the step's app-test green; `just app-test at0277-lens-row-accessories-keyboard.test.ts at0278-lens-cmdl-focus-stability.test.ts`.

#### Step 6: The row diet {#step-6}

**Depends on:** #step-5

**Commit:** `lens(layout): three rows and the picture — the mixer rows retire`

**References:** [P01] Rows diet, (#symbol-inventory)

**Tasks:**
- [ ] Delete the sidebar-side rows, both rail rows, and the column rows from `LayoutsSectionBody`: JSX, captions, `TugChoiceItem` arrays (`sideItems`, `railModeItems`, `columnModeItems`), the `LAYOUTS_FIRST_SIDEBAR_FOCUS_ORDER` arithmetic, and the `isShared` / `sharedSides` derivations the rows alone consumed. The sender-prefix responder cases **stay** — the overlay dispatches through them.
- [ ] Delete the rows' CSS from `layouts-section.css`; the section's height is now content-fixed.
- [ ] Grep-verify no test or source still names `lens-layouts-side-`, `lens-layouts-rail-`, `lens-layouts-column-` outside the files Step 7 rewrites.
- [ ] Module docblock rewritten: the section's five-axes story becomes three-rows-and-the-picture.

**Tests:**
- [ ] App-test claim (in the overlay test file): the section renders exactly the three row testids plus `lens-layouts-places`; the retired testids resolve to nothing.

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bunx vite build`; the overlay app-test green.

#### Step 7: Test rework and integration checkpoint {#step-7}

**Depends on:** #step-6

**Commit:** `lens(layout): at0401/at0455 drive the picture; the arc verified`

**References:** [P01] Rows diet, Risk R01, Risk R02, (#success-criteria)

**Tasks:**
- [ ] Rework `at0401-sidebar-split.test.ts` and `at0455-column-split.test.ts`: every gesture that pressed a `lens-layouts-rail-*` / `lens-layouts-column-*` / `lens-layouts-side-*` segment now presses the corresponding overlay affordance; every geometric claim about the resulting deck stands unchanged.
- [ ] `just app-test-covers-check` — the new files' `@covers` lines resolve.
- [ ] `tuglaws/pane-model.md` documentation lands (#documentation-plan).

**Tests:**
- [ ] The reworked files' own claims.

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bun test && bunx vite build && bun run audit:theme-contrast`
- [ ] `just app-test at0401-sidebar-split.test.ts at0455-column-split.test.ts at0277-lens-row-accessories-keyboard.test.ts at0278-lens-cmdl-focus-stability.test.ts at0357-content-width-default.test.ts at0454-flow-mode.test.ts` plus the overlay test file — all green.

---

### Deliverables and Checkpoints {#deliverables}

- The Layout section: three deck-wide rows and an interactive picture; fixed height; the one-card-split trap closed and pinned by test.
- `miniatureGeometry` as the single arithmetic under drawing and overlay.
- `LayoutPlaces` with pointer + keyboard access, previews riding the existing machinery.
- Reworked `at0401` / `at0455`; new overlay app-test; geometry unit tests.
- Updated `tuglaws/pane-model.md`.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- Every Success Criterion in #success-criteria holds.
- `tugutil plan lint` clean; all checkpoints green; no retired testid referenced anywhere.

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- **Drag a sidebar block between edges** ([P04]): pointer-capture drag with a ghost, snapping to the other rail — worth doing only if a third edge-like destination ever exists or user eval asks for it.
- **Reorder stack members from the picture**: pressing into a stack's glyph could open the member run; today the deck's own surfaces own reordering.
- **Live overlay under flow**: the overlay stands at rest ([P02]); tracking the flow window would let affordances ride the live strip.
