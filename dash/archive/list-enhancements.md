<!-- devise-skeleton v4 -->

## List visual-state language: marks for the keyboard, color for the mouse {#list-state-language}

**Purpose:** Replace the single-blue "four rising strengths" ramp that lists use to distinguish rest / hover / cursor / selected with a channel-separated language — the keyboard cursor becomes a leading-edge **mark** on every cursor row, hover becomes a **neutral graze** divorced from the selection hue, and selection keeps its **fill** — so every list in tugdeck reads its state at a glance instead of by ranking shades of one color.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-06-20 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

Every list surface in tugdeck — the session/recents pickers, the model/effort/permission pickers, the QuestionDialog options, the memory and permission-rules lists — renders its rest / hover / keyboard-cursor / selected states through one mechanism: rising strengths of a single selection-blue. The CSS documents this explicitly as a ramp (`hover 22% < cursor 45% < selection quiet-rest < selection+pointer quiet-strong`). The result is a confusing wall of near-identical blues: hover (a faint selection wash) is hard to rank against the keyboard cursor (a slightly stronger selection wash), and on a *selected* row the mouse-hover and keyboard-cursor states resolve to the **exact same** fill, so the two input modalities are indistinguishable by construction.

The fix is to stop overloading hue and instead give each signal its own visual vocabulary, split by **modality**: marks (a leading-edge bar, the container ring, selection glyphs) are the keyboard and the committed state; a fill that comes and goes under the pointer is the mouse. The reserved "keyboard-cursor chevron" gutter already in `tug-list-row.css` shows this was the original intent — it was abandoned mid-stream in favor of the color ramp; this plan completes it with an edge bar instead of a glyph.

#### Strategy {#strategy}

- **One invariant, stated in a sentence:** marks (edge bar, container ring, glyph) are the keyboard and the committed state; a transient fill under the pointer is the mouse.
- **The cursor mark is universal.** The leading-edge bar paints on *every* row the keyboard cursor lands on (`data-key-cursor`), in every list — a one-for-one replacement for the retired cursor fill-tint. No posture attribute, no per-consumer wiring; the existing engine projection drives it.
- **Drive everything off existing DOM signals** (`data-key-cursor`, `data-selected`) keyed in CSS ([L06]). No new React state, no new DOM attribute — this is a pure appearance change.
- **Retire the cursor fill-tint and the fill-strength promotion**, replacing them with the bar; selection fill no longer changes by modality (the bar carries "this came from the keyboard").
- **Divorce hover from the selection hue** — repoint flush hover to the existing neutral graze token, so blue means "chosen" and the neutral wash means "the mouse is here."
- **All-in across the shared primitives** (`TugListView` / `TugListRow`) so every consumer inherits the change at once; git is the safety net.
- **Verify on the real app**, not in fake-DOM tests — app-tests plus the theme-contrast audit gate.

#### Success Criteria (Measurable) {#success-criteria}

- Every row the keyboard cursor lands on (`data-key-cursor`) paints a **leading-edge bar** and **no** background fill-tint — including the recents/sessions picker's pre-commit transient, where the cursor sits on an as-yet-unselected row. (Verify: `just app-test`; Tab into the recents picker and observe the cursor row before pressing an arrow.)
- In a selection-follows-cursor list (the pickers), a **keyboard-selected** row reads as selection fill **plus the bar**, a **mouse-selected** (un-hovered) row reads as fill **only**; the fill strength itself is identical between them. (Verify: arrow vs click the same row; computed `background-color` matches, only the bar differs.)
- In an independent-cursor list (QuestionDialog options, memory, permission-rules editor), the cursor bar marks the cursor row whether or not it is selected, alongside its selection glyph. (Verify: `just app-test`; rove the cursor over checked and unchecked option rows.)
- Mouse hover on an unselected flush row paints a **neutral** wash, not a selection-blue wash — `--tugx-list-row-flush-hover-bg` resolves to `--tug7-surface-highlight-primary-normal-hover-rest`. (Verify: computed style; visual.)
- The QuestionDialog commit-advance confirmation **pulses the selection glyph** (radio dot / checkbox), not the row background. (Verify: `just app-test`; visual on Return-to-advance.)
- No theme exceeds the `brio` accessibility budget after the change. (Verify: `bun run audit:theme-contrast`.)
- `resume-sheet` (the Posture-C session picker) is visually unchanged except for inheriting the neutral hover. (Verify: diff confined to the shared primitives + question dialog; `resume-sheet` files untouched.)

#### Scope {#scope}

1. The keyboard cursor becomes a leading-edge bar on every `data-key-cursor` row (CSS, pseudo-element); the cursor fill-tint and the cursor-on-selected fill promotion are retired everywhere.
2. Flush hover is repointed to the neutral graze token.
3. The QuestionDialog commit blink pulses the selection glyph instead of the background fill.
4. `@tug-renders-on` / `@tug-pairings` annotations are updated for the new bar rule and the repointed hover ([L16]).
5. Stale comments/docstrings (the "chevron" gutter, the cursor-tint ramp prose) are corrected to the new model.

#### Non-goals (Explicitly out of scope) {#non-goals}

- Rewiring `resume-sheet` from Posture C (keyboard-inert click list) to a keyboard picker — flagged as a follow-on ([P07]).
- Adding selection glyphs to lists that don't already have them (pickers stay fill-only selection) ([P05]).
- Changing the container perimeter ring / `data-key-view-kbd` / `data-key-within` language — already keyboard-only and correct.
- The transcript and `path`/`search`/`todo` body-block lists' keyboard story (Posture C; no engine cursor) — untouched beyond inheriting the new hover.
- A pill-variant cursor bar — no current consumer is a pill cursor list; the cell-wrapper bar covers flush **and default** layouts, and only the pill-specific path is deferred ([P02]).
- Any change to selection *behavior*, focus walk, or the chain — this is appearance-only.

#### Dependencies / Prerequisites {#dependencies}

- The `--tug7-surface-highlight-primary-normal-hover-rest` token exists in all six themes (verified: aria, bravura, brio, harmony, nocturne, vivace).
- `useFocusCursor` already projects `data-key-cursor` to the DOM; that projection is the sole driver of the bar — no new attribute is introduced.

#### Constraints {#constraints}

- **WARNINGS ARE ERRORS** — the Rust workspace and lint gates; fix any surfaced warnings immediately.
- **Tuglaws** — [L06] appearance via CSS/DOM never React state; [L15] token-driven state visuals; [L16] every foreground rule names its surface; [L17] one-hop `--tugx-*` → `--tug7-*`/`--tug-*` aliases; [L20] component-token sovereignty. Name the laws touched in each commit.
- **No localStorage / IndexedDB**, **no fake-DOM render tests**, **no time budgets** (per project conventions).
- Theme contrast must not exceed the `brio` budget (`bun run audit:theme-contrast`).

#### Assumptions {#assumptions}

- A leading-edge bar drawn as a `::before` pseudo-element avoids the `box-shadow` collision with the opt-in `selectedAccent` inset border.
- Posture-C lists (transcript, body blocks, resume-sheet, read-only sheets) never receive `data-key-cursor` (no `focusGroup`), so a bare `[data-key-cursor]` bar rule never touches them — no posture gating is required.
- The bar's role-resolved accent color stays legible over a quiet-selection-blue fill on a selected+cursor row (visual check during the build).

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

Anchors are explicit and kebab-case; plan-local decisions are `[P01]`; steps cite decisions, specs, and anchors — never line numbers.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Pill-variant hover under the neutral-graze change (RESOLVED) {#q01-pill-hover}

**Question:** Does the flush-hover repoint to the neutral token also need to touch the pill-variant hover?

**Why it matters:** If pill hover is also a selection-blue wash, the "blue = chosen" invariant leaks.

**Resolution:** DECIDED — no change to pill hover. `--tugx-list-row-pill-hover-bg` already resolves to `--tug7-surface-control-primary-outlined-action-hover` (the button outlined-action hover), which is **not** a selection-blue wash. Only the flush-variant hover (`--tugx-list-row-flush-hover-bg`, currently a 22% selection-blue mix) violates the invariant. See [P04].

#### [Q02] Edge-bar color source (RESOLVED) {#q02-bar-color}

**Question:** What color is the cursor edge bar?

**Resolution:** DECIDED — the role-resolved `--tugx-focus-ring` (the same accent the container ring and global cursor ring already use), so all keyboard marks read as one color family. Legibility over a selection fill (selected+cursor row) is verified visually during the build. See [P02].

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Edge bar collides with `selectedAccent` inset box-shadow | med | low | Draw the bar as a `::before` pseudo-element, not a box-shadow; tune color stacking on the shared left edge | Visual overlap on a selected+cursor accent row |
| Neutral white-wash hover fails contrast on a light theme | med | low | Token already shipped & used by menus; gate on the contrast audit | `audit:theme-contrast` regression |
| Bar over selection fill reads poorly | low | low | Accent-ring color vs quiet-selection-blue have distinct value; visual check in the integration step | Bar invisible/garish on a selected+cursor row |
| Picker host-ring + per-row bar reads busy | low | low | Both are keyboard-only and complementary; eyeball in the integration step | Picker looks over-marked under keyboard nav |

**Risk R01: Edge bar vs. accent border collision** {#r01-bar-accent-collision}

- **Risk:** `selectedAccent` flush rows paint an inset `box-shadow`; a box-shadow edge bar would fight it on a selected+cursor row, and even as a pseudo-element the bar and the accent border's left segment stack on the same edge.
- **Mitigation:** Implement the bar as an absolutely-positioned `::before` on the cell wrapper so it composes with any box-shadow; pick a bar width/color that reads cleanly over the accent border's left segment.
- **Residual risk:** A consumer with unusual cell padding could clip the bar; caught visually in the integration checkpoint.

**Risk R02: Contrast regression from neutral hover** {#r02-contrast}

- **Risk:** The neutral wash reads differently over light vs dark surfaces.
- **Mitigation:** Reuse the existing, audited `surface-highlight-primary-normal-hover-rest`; run `audit:theme-contrast` as a checkpoint.
- **Residual risk:** None expected — the token is already in production use for menu hover.

---

### Design Decisions {#design-decisions}

#### [P01] Three postures explain the cursor, but the bar is universal (DECIDED) {#p01-postures}

**Decision:** The leading-edge cursor bar paints on **every** row carrying `data-key-cursor`, in every list — no posture attribute gates it. The three keyboard postures are a *description* of when the cursor visibly diverges from the selection, not a switch the CSS reads.

**Rationale:**
- **Posture A — selection follows the cursor** (`focusGroup` + `singleSelect`): the cursor usually rides the selected row — *but not always*. The recents and sessions pickers pass `singleSelect` with **no** `seedSelection` and **no** `initialSelectedIndex` (verified in `dev-card.tsx`): on gaining the key view the cursor lands on a row **without** committing selection (deliberate — a recents list must not overwrite a typed path on gain). That pre-commit transient is a real "cursor on an unselected row" state, and removing all per-row indication from Posture A would make it invisible — a regression in the very surface this plan targets.
- **Posture B — independent cursor** (`focusGroup`, not `singleSelect`): the cursor roves freely over unselected rows; the bar is essential.
- **Posture C — no engine cursor** (no `focusGroup`): never receives `data-key-cursor`, so a bare `[data-key-cursor]` rule never touches it. No gating needed.
- A single universal rule is simpler (no `data-cursor` attribute, no extra step) and strictly more correct than posture-gated bars.

**Implications:**
- CSS keys the bar off `.tug-list-view-cell[data-key-cursor]` directly — no root attribute.
- In Posture A the bar becomes the modality tell: keyboard-selected = fill + bar, mouse-selected = fill only.
- See [#consumer-posture-audit] for the full classification.

#### [P02] The keyboard cursor is a leading-edge bar, drawn as a layout-agnostic pseudo-element (pill deferred) (DECIDED) {#p02-edge-bar}

**Decision:** The keyboard cursor is a crisp leading-edge bar on the cursor row — a `::before` pseudo-element on the cell wrapper, `~3px` wide, colored with the role-resolved `--tugx-focus-ring` (referenced directly, exactly as the container-ring rule does). The selector is **not** scoped to a layout, so it covers `flush` **and default** layouts alike; only a **pill-specific** bar path is deferred.

**Rationale:**
- A bar is a *mark* (not a fill), keyboard-only, and never contends with the selection glyph column — so a multi-select option row can show the bar (cursor) **and** a checkbox (selection) simultaneously.
- A pseudo-element composes with any `box-shadow` (the `selectedAccent` inset border), sidestepping [R01].
- Reusing `--tugx-focus-ring` keeps every keyboard mark (container ring, edge bar) in one color family.
- Layout-agnostic selector, pill deferred: the cell-wrapper bar works for any layout whose row sits flush to the cell edge — `flush` (all six pickers, memory, permission-rules, the question options) **and default** (the gallery focus demos omit `rowLayout`). Scoping it to `[data-row-layout="flush"]` would wrongly blank the default-layout lists, so the selector stays unscoped. Only `pill` (a gapped, rounded row) needs a different anchor, and no pill cursor-list exists — building that path now would be untestable dead code; extend it when a pill cursor-list ships.

**Implications:**
- Cell wrapper gains `position: relative` to host the absolute `::before`.
- One new component token, `--tugx-list-view-cursor-bar-width` (one-hop to `--tug-space-*` per [L17]). The bar **color** references `--tugx-focus-ring` directly — no `-color` alias — so it tracks the focus axis exactly like the container ring and avoids a two-hop `--tugx-` → `--tugx-` chain.
- The reserved `--tugx-list-row-indicator-gutter` is no longer a "chevron slot"; its comment is corrected (the gutter may stay as standing breathing room, but it is not where the bar lives).

#### [P03] Retire the cursor fill-tint and the fill-strength promotion; the bar carries keyboard modality (DECIDED) {#p03-retire-tint}

**Decision:** Remove `--tugx-list-view-cursor-tint` and all rules that paint a background tint on `[data-key-cursor]`, and remove the cursor-on-selected fill promotion (`[data-key-cursor] [data-selected]` → `selected-hover-bg`). The leading-edge bar replaces both. Selection fill no longer changes by input modality; the bar is the only keyboard tell on a selected row.

**Rationale:**
- The cursor-tint and the promotion were the two ways the keyboard appeared in fill strength — the source of the "wall of blues." The bar carries the same information as an intentional mark instead of a fill-strength step that competes with hover and selection.
- The mouse-hover-over-selected step (`:hover` → `selected-hover-bg`) **stays** — it is a genuine pointer affordance, and with keyboard off the fill ramp it no longer collides with anything.

**Implications:**
- Net: the four-rung blue ramp collapses to two fills (neutral hover, selection) plus one mark (the bar).
- Keyboard-selected and mouse-selected rows share the same fill; they differ only by the bar.

#### [P04] Hover is a neutral graze, divorced from the selection hue (DECIDED) {#p04-neutral-hover}

**Decision:** Repoint `--tugx-list-row-flush-hover-bg` from the 22% selection-blue mix to `--tug7-surface-highlight-primary-normal-hover-rest` (a faint neutral wash). Pill hover is unchanged ([Q01]).

**Rationale:**
- The core of the "wall of blues" complaint is that hover is a weak selection — so a hovered row reads as half-chosen. A neutral wash makes the colors mean different *things* (blue = chosen, neutral = mouse here), not different *amounts*.
- The token already exists in all six themes and is the established menu-hover idiom.

**Implications:** One-hop alias change in `tug-list-row.css`; no theme-file edits. The `@tug-renders-on` annotation on the flush-hover rule is updated to name the host surface ([L16]).

#### [P05] Selection stays fill-primary; glyphs only on true choice-sets (DECIDED) {#p05-selection-fill}

**Decision:** Selection keeps its solid fill as the primary signal. No selection glyphs are added to lists that lack them (the recents/sessions/model/effort pickers stay fill-only). Glyphs (radio/checkbox) remain only where the surface is a real choice-set (QuestionDialog options).

**Rationale:** A persistent committed selection is the one place a strong color is earned; bolting checkmarks onto every picker would be noise. The mark/color split is fundamentally about *modality*, with selection as a third modality-independent channel that uses fill.

**Implications:** No change to picker cell renderers; the glyph work is confined to the existing choice-set lists.

#### [P06] The QuestionDialog commit blink pulses the selection glyph, not the background (DECIDED) {#p06-glyph-blink}

**Decision:** Change the commit-advance flash to pulse the selected rows' glyph element (`.tug-list-row-check` — the radio dot / checkbox) instead of animating the row `background-color`.

**Rationale:** With selection now glyph-bearing in the options list and color reserved for the mouse, pulsing the fill would reintroduce "color does keyboard work" mid-animation. Pulsing the mark keeps the invariant honest even during the confirmation. (Verified: every option row carries a glyph — single-select renders a radio dot, multi-select a checkbox — so the pulse target always exists.)

**Implications:** The flash effect targets `row.querySelector('.tug-list-row-check')` and animates opacity/transform; the row-element lookup by `[data-option-label]` is unchanged.

#### [P07] `resume-sheet` stays Posture C and out of scope (DECIDED) {#p07-resume-sheet}

**Decision:** Do not rewire `resume-sheet`'s focus model. It remains a keyboard-inert click list and inherits only the new hover.

**Rationale:** It is a latent inconsistency (a session picker with no `focusGroup`/`singleSelect`, unlike the dev-card sessions picker), but rewiring its focus is behavior, not the visual-state language this plan owns. Flagged as a follow-on.

**Implications:** Listed under [#roadmap]; its files are untouched (a diff-confinement check in the integration step).

---

### Deep Dives (Optional) {#deep-dives}

#### Consumer posture audit {#consumer-posture-audit}

Every current `TugListView` consumer, classified by [P01]:

**Table T01: Consumer postures** {#t01-postures}

| Consumer | Props | Posture | Cursor treatment |
|---|---|---|---|
| dev-card recents picker | `focusGroup` + `singleSelect`, no `seedSelection` | A | fill + ring; **bar** on the cursor row (incl. pre-commit transient) |
| dev-card sessions picker | `focusGroup` + `singleSelect`, no `seedSelection` | A | fill + ring; **bar** on the cursor row |
| model-picker-sheet | `focusGroup` + `singleSelect` | A | fill + ring; **bar** on the cursor row |
| effort-picker-sheet | `focusGroup` + `singleSelect` | A | fill + ring; **bar** on the cursor row |
| permission-mode-chip | `focusGroup` + `singleSelect` | A | fill + ring; **bar** on the cursor row |
| rewind-sheet | `focusGroup` + `singleSelect` + `seedSelection` | A | fill + ring; **bar** on the cursor row |
| memory-sheet | `focusGroup`, no `singleSelect`, flush | B | **bar** on the cursor row |
| permission-rules-editor | `focusGroup`, no `singleSelect`, flush | B | **bar** on the cursor row |
| QuestionDialog options | `focusGroup` + `commitOnEnter="act"`, no `singleSelect`, flush | B | **bar** on the cursor row (+ glyph for selection) |
| dev-card-transcript | no `focusGroup` (handle-driven) | C | none (no `data-key-cursor`) |
| path/search/todo body blocks | `inline`, no `focusGroup` | C | none |
| resume-sheet | no `focusGroup`/`singleSelect` | C | none ([P07]) |
| QuestionDialog rail | `inline`, no `focusGroup` | C | none |
| help/agents/skills, options-sizer | `interactive={false}` | C (read-only) | none |

A bare `[data-key-cursor]` bar rule paints exactly on Postures A and B (the engine-cursor lists) and never on Posture C (no projection). No posture attribute is needed. Every current engine-cursor list is `flush` **or default** layout (the gallery focus demos omit `rowLayout`), and the cell-wrapper bar handles both — so the selector stays unscoped by layout; only a pill-specific path is deferred ([P02]).

#### The four-rung ramp, before and after {#ramp-before-after}

**Before (one hue, four strengths):** `flush-hover-bg` (selection-blue 22%) < `cursor-tint` (selection-blue 45%) < `selected-bg` (quiet-rest) < `selected-hover-bg` (quiet-strong, used for *both* mouse-hover-over-selected and keyboard-cursor-over-selected — the collision).

**After (two fills + one mark):**
- Hover (mouse) → neutral graze (`highlight…hover-rest`).
- Selection (modality-independent) → `selected-bg` fill (+ glyph on choice-sets); mouse-hover-over-selected keeps the single `selected-hover-bg` step.
- Cursor (keyboard, every cursor row) → leading-edge bar (`--tugx-focus-ring`), no fill. The cursor-tint and the keyboard cursor-over-selected promotion are gone.

---

### Specification {#specification}

#### Semantics — edge-bar rendering {#edge-bar-semantics}

**Spec S02: Edge bar** {#s02-edge-bar}

> (Spec S01 was removed — the earlier `data-cursor` posture attribute is no longer needed; the gap is intentional.)

- Selector: `.tug-list-view-cell[data-key-cursor]::before` — deliberately **not** scoped to `[data-row-layout]`, so it covers `flush` and default layouts alike (the gallery focus demos omit `rowLayout`). No posture attribute gates it; only a pill-specific anchor is deferred.
- The `::before` is absolutely positioned at the leading inline edge, full row height, `var(--tugx-list-view-cursor-bar-width)` wide, `background: var(--tugx-focus-ring)` (the focus axis, referenced directly).
- The cursor cell no longer paints any `background-image` tint, and the cursor-on-selected fill promotion is removed ([P03]).
- The global `[data-key-cursor]` outline ring stays suppressed for list cells (already true).
- On a selected cursor row the bar sits at the leading edge over the selection fill; on an unselected cursor row (Posture-A transient or any Posture-B cursor) the bar is the sole row mark.

#### State Zone Mapping (tugdeck/tugways plans) {#state-zone-mapping}

| State | Zone | Mechanism | Law |
|-------|------|-----------|-----|
| `data-key-cursor` (cursor position) | appearance | existing `useFocusCursor` DOM projection | [L06], [L22] |
| edge bar / hover / selection visuals | appearance | CSS keyed on existing DOM attributes + component tokens | [L06], [L15], [L16], [L17] |
| commit-blink glyph pulse | appearance | WAAPI/TugAnimator on the glyph DOM, reading committed `selections` (local-data) | [L06], [L03] |

No new React state and no new DOM attribute are introduced.

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

None.

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `--tugx-list-view-cursor-bar-width` | CSS token | `tug-list-view.css` (`body` block) | one-hop to `--tug-space-*` ([L17]); **no** `-color` alias — the bar references `--tugx-focus-ring` directly |
| `--tugx-list-view-cursor-tint` | CSS token | `tug-list-view.css` | **removed** ([P03]) |
| cursor `::before` bar rule | CSS | `tug-list-view.css` | keyed on `[data-key-cursor]`, unscoped (covers flush + default) ([S02]); color `var(--tugx-focus-ring)`; `@tug-renders-on` added ([L16]) |
| cursor-on-selected promotion rules | CSS | `tug-list-row.css` | **removed** ([P03]) |
| `--tugx-list-row-flush-hover-bg` | CSS token | `tug-list-row.css` | repointed to neutral token; `@tug-renders-on` updated ([P04], [L16]) |
| flash effect | TS | `dev-question-dialog.tsx` | pulse `.tug-list-row-check`, not background ([P06]) |

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **App-test** | Drive the real Tug.app to confirm keyboard/mouse behavior + visuals | bar on every cursor row, Posture-A transient, modality fill parity, QuestionDialog blink |
| **Contract (audit)** | Theme contrast budget | After the hover repoint |
| **Build/tsc** | Type + warning gate | Every step |

#### What stays out of tests {#test-non-goals}

- Fake-DOM / jsdom render assertions on the CSS state classes — banned project pattern; appearance is verified on the real app.
- Per-token snapshot tests — covered by the contrast audit and visual inspection.

---

### Execution Steps {#execution-steps}

> Commit after all checkpoints pass. Each step names the tuglaws it touches in its commit body.

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Edge-bar cursor + retire the fill-tint | done | 4fccda247 |
| #step-2 | Neutral-graze hover | done | c93f44772 |
| #step-3 | QuestionDialog blink pulses the glyph | done | ca04cb4bd |
| #step-4 | Integration checkpoint + comment cleanup | done | N/A (verification) |

---

#### Step 1: Edge-bar cursor + retire the fill-tint {#step-1}

**Commit:** `tugdash(list-state): keyboard cursor is a leading-edge bar on every cursor row; retire fill-tint [L06][L15][L16][L17]`

**References:** [P01] universal bar, [P02] edge bar, [P03] retire tint, Spec S02, Table T01, Risk R01, (#edge-bar-semantics, #ramp-before-after, #consumer-posture-audit)

**Artifacts:**
- `tug-list-view.css`: new `--tugx-list-view-cursor-bar-width` token (no `-color` alias); the `::before` bar rule keyed on `.tug-list-view-cell[data-key-cursor]`, unscoped by layout, color `var(--tugx-focus-ring)`; `position: relative` on the cell wrapper; removal of `--tugx-list-view-cursor-tint` and its `background-image` rules; `@tug-renders-on` annotation on the bar rule and an updated `@tug-pairings` header entry ([L16]).
- `tug-list-row.css`: remove the cursor-on-selected fill promotion and the cursor-tint pill/flush rules; keep the mouse-hover-over-selected step.

**Tasks:**
- [ ] Add the `--tugx-list-view-cursor-bar-width` token (one-hop to `--tug-space-*`) per [L17]; color the bar with `var(--tugx-focus-ring)` directly — no `-color` alias ([P02]).
- [ ] Draw the bar as an absolutely-positioned `::before` on the cell wrapper, selector **unscoped by layout** so it covers flush + default ([S02]); confirm it stacks over the row's selection fill; do **not** scope to `[data-row-layout="flush"]` (would blank the default-layout gallery demos) and do **not** build a pill path ([P02]).
- [ ] Delete `--tugx-list-view-cursor-tint` and every rule that set a cursor `background-image`.
- [ ] Delete the `[data-key-cursor] … [data-selected]` → `selected-hover-bg` promotion in `tug-list-row.css`.
- [ ] Verify the global `[data-key-cursor]` outline stays suppressed for list cells.
- [ ] Add/refresh the `@tug-renders-on` annotation and the file-header `@tug-pairings` table for the new bar rule ([L16]).
- [ ] Correct the stale `--tugx-list-row-indicator-gutter` "chevron" comment ([P02]).

**Tests:**
- [ ] App-test: Tab into the recents picker → the cursor row shows the bar **before** any arrow press (pre-commit transient marked).
- [ ] App-test: in a picker, arrowing onto a row then clicking the same row yields identical `background-color`; only the keyboard case carries the bar (modality parity in fill, bar carries keyboard).
- [ ] App-test: rove the cursor over a checked and an unchecked QuestionDialog option row → bar on both; no fill-tint.
- [ ] App-test: a selected + cursor row in a Posture-B accent list shows the bar and the accent border with no clipping.

**Checkpoint:**
- [ ] `just app-test` passes; type/lint gate clean with no warnings.
- [ ] Visual: bar on every cursor row; Posture-A transient marked; bar legible over a selection fill.

---

#### Step 2: Neutral-graze hover {#step-2}

**Depends on:** #step-1

**Commit:** `tugdash(list-state): flush hover is a neutral graze, divorced from the selection hue [L15][L16][L17]`

**References:** [P04] neutral hover, [Q01] pill hover, Risk R02, (#ramp-before-after)

**Artifacts:**
- `tug-list-row.css`: `--tugx-list-row-flush-hover-bg` repointed to `--tug7-surface-highlight-primary-normal-hover-rest`; the flush-hover rule's `@tug-renders-on` annotation updated to name the host surface ([L16]).

**Tasks:**
- [ ] Repoint the flush hover alias (one hop) to the neutral token; leave pill hover untouched ([Q01]).
- [ ] Update the `@tug-renders-on` annotation on the flush-hover rule ([L16]).
- [ ] Confirm no remaining list rule mixes the selection hue for a *transient* (hover/cursor) state.

**Tests:**
- [ ] App-test: hover an unselected flush row → neutral wash; computed `background-color` resolves from the neutral token, not a selection-blue mix.

**Checkpoint:**
- [ ] `bun run audit:theme-contrast` — no theme exceeds the `brio` budget.
- [ ] `just app-test` passes.
- [ ] Visual across at least one dark + one light theme.

---

#### Step 3: QuestionDialog blink pulses the glyph {#step-3}

**Commit:** `tugdash(list-state): commit-advance blink pulses the selection glyph, not the fill [L06][L03]`

**References:** [P06] glyph blink, [P05] selection fill, (#state-zone-mapping)

**Artifacts:**
- `dev-question-dialog.tsx`: the flash layout-effect targets each selected row's `.tug-list-row-check` and animates opacity/transform instead of the row `background-color`; `dev-question-dialog.css` adjusted if a transform origin / will-change is needed.

**Tasks:**
- [ ] Replace the `background-color` keyframes with a glyph opacity/scale pulse on `row.querySelector('.tug-list-row-check')`, keeping the `[data-option-label]` row lookup and the advance-on-tail Promise flow.
- [ ] Keep the TugAnimator reduced-motion scaling ([D06]) and `fill: "none"` cleanup.
- [ ] Update the flash docstring (no longer "blink the tint").

**Tests:**
- [ ] App-test: Return-to-advance pulses the glyph (single-select: one row; multi-select: all checked) and advances on the tail.

**Checkpoint:**
- [ ] `just app-test` (the QuestionDialog suite) passes.
- [ ] tugdeck unit gate (`bun test`) passes — the existing `dev-question-dialog` suite is unaffected by the flash rewrite.
- [ ] Visual: glyph pulse, no background blink.

---

#### Step 4: Integration checkpoint + comment cleanup {#step-4}

**Depends on:** #step-1, #step-2, #step-3

**Commit:** `N/A (verification only)`

**References:** [P01]–[P07], Table T01, Risks R01-R02, (#success-criteria, #consumer-posture-audit)

**Artifacts:**
- Verified-clean stale comments: the `--tugx-list-row-indicator-gutter` "chevron" prose ([P02]) and the cursor-tint ramp prose in `tug-list-view.css` / `tug-list-row.css` (corrected in Step 1, confirmed here).

**Tasks:**
- [ ] Walk every Posture-B consumer (memory, permission-rules editor, QuestionDialog options) — bar on the cursor row whether selected or not, no fill-tint.
- [ ] Walk every Posture-A consumer (all six pickers) — bar on the cursor row including the pre-commit transient; keyboard- and mouse-selected fills identical apart from the bar.
- [ ] Confirm the picker host-ring + per-row bar combination does not read as over-marked ([Risks]); confirm the bar is legible over a selection fill ([R01]).
- [ ] Confirm Posture-C surfaces (transcript, body blocks, **resume-sheet**, read-only sheets) are visually unchanged except for the neutral hover; confirm `resume-sheet` source files are untouched ([P07]).
- [ ] Confirm no stale "chevron"/"cursor-tint ramp" comments remain and `@tug-pairings`/`@tug-renders-on` annotations are current ([L16]).

**Tests:**
- [ ] Aggregate `just app-test` across the affected sheets.

**Checkpoint:**
- [ ] `just app-test`, `bun test` (tugdeck unit gate), and `bun run audit:theme-contrast` all green.
- [ ] `git diff --stat` shows changes confined to the shared primitives + question dialog (no `resume-sheet`).

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** Every tugdeck list distinguishes rest / hover / keyboard-cursor / selected through channel-separated marks-and-color (keyboard = a universal leading-edge bar + container ring + glyph; mouse = neutral fill; selection = blue fill), replacing the single-hue four-rung ramp.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] Every `data-key-cursor` row shows a leading-edge bar and no fill-tint, including the recents/sessions pre-commit transient (`just app-test` + visual).
- [ ] Posture-A keyboard- and mouse-selected rows share the same fill, differing only by the bar (computed-style check).
- [ ] Flush hover is a neutral wash (computed-style check).
- [ ] QuestionDialog commit blink pulses the glyph (`just app-test` + visual).
- [ ] `@tug-renders-on` / `@tug-pairings` annotations updated for the new bar and hover rules ([L16]).
- [ ] `bun run audit:theme-contrast` passes; no warnings in any build/type gate.
- [ ] `resume-sheet` untouched (diff check).

**Acceptance tests:**
- [ ] `just app-test`
- [ ] `bun run audit:theme-contrast`

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] Rewire `resume-sheet` to a keyboard picker (Posture A or B) for consistency with the dev-card sessions picker ([P07]).
- [ ] Consider whether Posture-C body-block lists (path/search/todo) deserve a keyboard cursor at all.
- [ ] Extend the cursor bar to a pill path if a pill independent-cursor list ever ships ([P02]).

| Checkpoint | Verification |
|------------|--------------|
| Universal bar | `just app-test` + visual; recents pre-commit transient marked |
| Posture-A fill parity | computed `background-color` arrow vs click (bar differs, fill matches) |
| Neutral hover | computed style + `audit:theme-contrast` |
| Glyph blink | `just app-test` (QuestionDialog) |
| resume-sheet untouched | `git diff --stat` |
