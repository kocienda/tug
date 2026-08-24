## Focus-Language Modernization — Roll Out the New Keyboard-Focus Visual Language {#focus-language}

**Purpose:** Replace the engine's single orange focus ring with the settled focus-visual language — a **ring + faint behind-tint** on the focused component, the component's **native fill** for committed selection, all driven by **one role axis that defaults to `action`** — across the entire component library and every app-wide focusable. This is a re-skin over the focus engine, not a change to it.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-06-09 |

- **Predecessor:** `dash/tugplan-keyboard-model.md` — built the focus engine and the behavior model; its `#focus-language-modernization` section is closed out as **spike complete**, and its `#flm-verdict` records the settled model this plan rolls out. This plan owns the *visual language*; that plan owned the *behavior*.
- **Spike canvas:** `tugdeck/src/components/tugways/cards/gallery-focus-language.{tsx,css}` — the settled reference, judged by eye in both themes. The `--fl-*` variables there are the prototype of this plan's real tokens.
- **Surface:** tugdeck / tugways (TypeScript/React + theme CSS); no Rust/Swift.
- **Build/test:** `bunx tsc --noEmit` (warnings are errors); `bun test` (pure logic); `just app-test <file>` for behavior regression (greppable `VERDICT: PASS|FAIL`); by-eye gallery review per theme/mode for appearance.

---

### Phase Overview {#phase-overview}

#### Context {#context}

The focus engine projects four stable DOM attributes today — `[data-key-view-kbd]` (the keyboard-focused component), `[data-key-cursor]` (the roving cursor item inside a deferred group), `[data-key-within]` (the immediate container of the key view), and `data-selected` (committed selection). A single global rule in `styles/focus-ring.css` paints **one orange `outline`** on `[data-key-view-kbd]`, a quiet within-mark, and a neutral cursor tint. That orange ring is the whole focus language, and it is weak: it reads as one undifferentiated treatment, it never expresses a control's role, and it doesn't carry selection.

The keyboard-model spike (now closed out) settled a richer language on the gallery canvas: the focused component wears a **ring plus a faint behind-tint**; committed selection is the component's **native fill** (radio dot / segmented pill / option fill / list-row fill); and ring + fill + tint all read **one role variable that defaults to `action`** and is overridden per role. Because every state is already a projected DOM attribute, rolling this out is CSS + tokens + a handful of resting-style tweaks — **the engine, the scopes, and the behavior app-tests do not move.**

#### Strategy {#strategy}

- **Tokens first, then re-point the global rule.** Land the real token surface ([P05]) and re-point the existing `[data-key-view-kbd]` rule to it in one foundational step, so the *entire app* shifts to the new ring coherently before any per-component work — no mixed orange/new state.
- **Re-skin over stable attributes ([P04]).** Touch only CSS/tokens and a few resting-style renders. Never change the engine, the scope stack, or what attributes are projected. Behavior app-tests stay green as the proof that nothing behavioral moved.
- **One role axis, default action ([P03]).** Model every focusable as carrying a role that defaults to `action`; ring/fill/tint resolve from it. Most components need *zero* prop changes — only their focus CSS changes — because they ride the default.
- **Component-by-component, grouped by archetype.** Walk the matrix in archetype clusters (buttons → item-groups → live/continuous → rows → leaf controls → surfaces → links/app-wide), each a commit, each gallery-verified in both themes.
- **Lift the bespoke dialog CSS into first-class component CSS.** The fill-promotion proven in `dev-permission-dialog.css`/`dev-question-dialog.css` becomes a TugPushButton keyboard-promoted state; the dialogs then consume it instead of carrying their own copy.
- **Appearance is judged by eye, behavior by app-test.** Pixels are not app-tested ([#test-non-goals]); the gallery (and the spike card) is the review surface, per theme and per keyboard-vs-mouse.
- **Close with governance.** Author the `tuglaws/` focus-language doc and the governing decision that supersedes the keyboard-model plan's [P03], so the language is documented law, not folklore.

#### Success Criteria (Measurable) {#success-criteria}

- Every component in the keyboard-model [Keyboard Behavior Matrix](tugplan-keyboard-model.md#keyboard-matrix) shows the new focus signature — ring + faint behind-tint on focus, native fill on selection — verified by eye in **both** brio and harmony. (gallery review checklist per component)
- The orange `--tugx-focus-ring-color` axis is gone from the focus path; the ring color resolves from the role axis defaulting to `action`. (grep: no `--tugx-focus-ring-color` consumers in component/chrome focus CSS; the spike-card legend may retain an explicit orange swatch for contrast)
- Role-bearing controls (button, checkbox, switch, radio, choice, option) ring + fill + tint in their role color; role-less controls render `action`. (gallery danger/accent cells per component)
- `TugInput` invalid state focuses in the danger role; `TugTabBar` commits on act. (gallery + live build)
- All existing `just app-test` keyboard scenarios still `VERDICT: PASS` (behavior unchanged); `bunx tsc --noEmit` clean; `bun test` green. (CI commands)
- A `tuglaws/focus-language.md` exists describing the language, and the governing decision supersedes keyboard-model [P03]. (file present; cross-links resolve)

#### Scope {#scope}

1. The token foundation: real focus-language tokens (ring / behind-tint / selection-fill resolved from a role axis) authored in `styles/focus-ring.css` + `styles/themes/brio.css` + `styles/themes/harmony.css`, re-pointing the global `[data-key-view-kbd]` rule ([#step-1]).
2. TugPushButton keyboard-promoted state; unify the inline dialogs onto it ([#step-2]).
2.5. Keyboard-focus-cycling mode (Opt-Tab) for text-first cards — a per-card cycle focus-scope toggled by a trigger, with the dev card as first consumer; the surface that exercises the whole focus language end-to-end ([#step-cycle]).
3. Item-groups: TugRadioGroup, TugChoiceGroup, TugOptionGroup ([#step-3]).
4. Live / continuous: TugSlider, TugTabBar (→ commit-on-act) ([#step-4]).
5. Descendable rows: TugListView/TugListRow, TugAccordion ([#step-5]).
6. Leaf controls: TugCheckbox, TugSwitch, TugInput (validation→role), TugTextarea, TugValueInput ([#step-6]).
7. Surfaces / boxes: TugPopover, TugSheet, TugAlert, the inline-dialog shell **and its option rows**, plus a menus audit (TugContextMenu, internal/tug-popup-menu) ([#step-7]).
8. Links + the app-wide long tail the global rule touches: TugLink, title bars, toolbars, prompt entry, dev panel ([#step-8]).
9. Governance: `tuglaws/focus-language.md`, the governing decision superseding [P03], and the Keyboard Behavior Matrix visual-column annotation ([#step-9]).
10. Integration checkpoint + decide the spike card's fate ([#step-10]).

#### Non-goals (Explicitly out of scope) {#non-goals}

- **Any change to the focus engine** — the registry, Tab walk, scope stack, keybinding registry, key-view/cursor/within projection, and ring-modality stay byte-for-byte. This plan reads the attributes they already set.
- Re-litigating the *behavior* model (focus/move/act over scopes) — owned and done by the keyboard-model plan.
- The accessibility-mode ARIA pass + standard/accessibility dual-mode toggle (a keyboard-model follow-on); this plan must not *break* it, but a dedicated high-contrast focus variant is deferred ([Q03]).
- New component-level user-facing `role` props where none exist — the role axis defaults to `action` and components opt into richer roles over time ([P03]); only `TugInput`'s existing `validation` is mapped this phase ([P07]).
- The deferred `refuse`/first-responder audit (keyboard-model `#step-15`).
- **Z1 transcript cycling / message selection** — the first cut of the cycling mode ([P10]) circulates the chrome zones (Z2 / Z4 / Z5) only; tabbing into the transcript to scroll or select messages is deferred (possibly indefinitely).

#### Dependencies / Prerequisites {#dependencies}

- The four projected focus attributes (`[data-key-view-kbd]`, `[data-key-cursor]`, `[data-key-within]`, `data-selected`) — all live, from the keyboard-model plan.
- `styles/focus-ring.css` (the global focus rule + `--tugx-focus-*` token surface) and the theme token system (`--tug7-*`, `--tug-color()` PostCSS expansion, `styles/themes/{brio,harmony}.css`).
- The spike canvas `gallery-focus-language.{tsx,css}` as the visual reference, and the keyboard-model `#flm-verdict` as the settled model.
- The bespoke prototypes in `dev-permission-dialog.css` / `dev-question-dialog.css` (the fill-promotion to lift) and `internal/tug-button.css` (the role-style classes).

#### Constraints {#constraints}

- **tuglaws hold** — esp. [L06] appearance is CSS/DOM attributes, never React state; [L17] one-hop token aliasing (`--tugx-*` → `--tug7-*`); [L24] state-zone discipline. Cross-check and name laws in each tugways step's commit body.
- Theme token files (`brio.css`, `harmony.css`) are **hand-authored** — edit directly; there is no generation script.
- **Warnings are errors** (`bunx tsc --noEmit`). No fake-DOM/RTL or mock-store tests. Behavior via `just app-test`; appearance by eye.
- **Pixel appearance is not app-testable** — do not add pixel-snapshot tests; the gallery is the review surface ([#test-non-goals]).
- No plan-step numbers in code/comments/commits — describe the behavior.
- HMR is always running for tugdeck; never run manual frontend builds.

#### Assumptions {#assumptions}

- The role color a control rings/fills/tints with maps to the existing `--tug7-...-filled-{role}-rest` token family (action/danger/accent/agent/data/option), exactly as the spike used them; `action` is the neutral default.
- A faint behind-tint can be layered over a component's own background without a new DOM node — via an `outline`/`box-shadow`/gradient-overlay technique as the spike proved ([P01], [Q02]).
- Most components need no prop change to adopt the role axis (they ride `action`); the focus CSS change is the bulk of each step.
- The inline dialogs' current focus behavior is final (keyboard-model `#step-14` done); this plan only refactors their *styling* onto the shared button state.

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

Cite plan-local decisions `[P01]`–`[P0n]` (use `P`, never `D`), open questions `[Q01]`, specs `S01`, risks `R01`, and step anchors `#step-n`. Global laws/decisions are `[Lnn]`/`[Dnn]` (referenced, not owned here). Never cite line numbers — add an anchor.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Real token shape for the role-resolved focus axis (OPEN → resolve in #step-1) {#q01-token-shape}

**Question:** How are the spike's `--fl-role` / `--fl-sel` / `--fl-focus-bg` expressed as real tokens? A single set of `--tugx-focus-*` variables that components set per role, vs. component-tier aliases per role, vs. a small resolver that maps a `data-role` to the `--tug7-...-filled-{role}-*` family.

**Why it matters:** It sets the authoring ergonomics for every component step and whether theme files grow a new token block.

**Options:** (a) `--tugx-focus-ring` / `--tugx-focus-fill` / `--tugx-focus-tint` set from `[data-fl-role]`-style rules in `focus-ring.css` (mirrors the spike's structure 1:1); (b) per-component `--tugx-<component>-focus-*` aliases ([L17]); (c) a hybrid — shared `--tugx-focus-*` defaults + per-component overrides only where the native fill differs.

**Plan to resolve:** Spike (a) against two real components in [#step-1]; it is the closest lift of the proven card. **Lean:** (a) + (c) — shared defaults, component overrides for native fills. **Resolution:** OPEN.

#### [Q02] Behind-tint layering over component backgrounds (OPEN → resolve in #step-1) {#q02-tint-layer}

**Question:** How to paint the faint behind-tint without a new DOM node when the component already has a background (segmented track, sheet surface, list panel)?

**Why it matters:** Naively setting `background` clobbers the component's own surface; the spike used a `linear-gradient` overlay for the box and a plain background for trackless groups.

**Plan to resolve:** Settle one technique (gradient-overlay vs. `box-shadow` inset vs. a `::before`) in [#step-1] and reuse it everywhere. **Lean:** gradient-overlay over the existing background (the spike's box approach), since it composes with any surface. **Resolution:** OPEN.

#### [Q03] High-contrast / accessibility-mode focus variant (DEFERRED) {#q03-a11y-variant}

**Question:** Does the new language need a distinct high-contrast treatment under accessibility mode?

**Why it matters:** Double-borders are colourblind-robust, but a single faint tint + thin ring may be too subtle at high-contrast settings.

**Resolution:** DEFERRED to the keyboard-model a11y follow-on (`#roadmap`). This plan must not regress accessibility mode; a dedicated variant is out of scope. **Framing from [P13]:** the *navigation* half of an a11y keyboard mode is "always-on cycling" = making a toggleable context **persistent** (drop the toggle, push at mount), assessed at [#step-cycle-vet]; this question is now specifically about the *visual* high-contrast treatment, which remains deferred.

#### [Q04] Fate of the spike card (OPEN → decide in #step-10) {#q04-spike-card}

**Question:** Keep `gallery-focus-language.{tsx,css}` as a living reference, fold its cases into the per-component gallery cards, or delete it?

**Why it matters:** It is a throwaway by design, but it is also the single screen that shows the whole language at once.

**Plan to resolve:** Decide at [#step-10] once the rollout is real. **Lean:** keep it (retitle "Focus language reference") but stop it from drifting by having it consume the real tokens, not its private `--fl-*`. **Resolution:** OPEN.

#### [Q05] The cycle trigger chord (OPEN → resolve in #step-cycle-trigger-spike) {#q05-cycle-trigger}

**Question:** Which chord toggles the keyboard-focus-cycling mode ([P09])? The mnemonic candidate is **Opt-Tab** (⌥⇥ — "Tab, but navigation"), but macOS full-keyboard-access / WebKit may intercept Tab-family chords before they reach the WebView — the same reason ⇧⇥ is eaten and `at0088` dispatches its chord synthetically.

**Why it matters:** If the chord never reaches the document keybinding stage, the mode is unreachable; the trigger must be confirmed *before* the mechanism is wired to it.

**Options:** (a) **Opt-Tab** (⌥⇥) — most mnemonic; (b) a **non-Tab chord** if Opt-Tab is eaten (⌃Tab is OS-reserved; candidates: a function chord, ⌥Esc, or a card-scoped leader); (c) a two-key leader.

**Plan to resolve:** Spike in [#step-cycle-trigger-spike] — a temporary capture-phase probe / app-test that posts the chord and asserts the document listener receives it; take the first reliable option. **Lean:** Opt-Tab if it lands, else the simplest non-conflicting chord. **Resolution:** DECIDED — **Opt-Tab (⌥⇥)**. Confirmed by `at0138`: a native ⌥⇥ reaches the document keydown listeners (it is *not* eaten by macOS full-keyboard-access the way plain Tab / ⇧⇥ are) and matches the `CYCLE_FOCUS_MODE` binding (`preventDefaultOnMatch` fires). The engine side is clear too — the focus-walk stage bails on any modifier (`responder-chain-provider.tsx`), so ⌥⇥ is never consumed as a reverse-tab. No fallback chord needed.

#### [Q06] Scope-options gesture — plain radio item-group vs descend model (DECIDED — 2026-06-08) {#q06-scope-gesture}

**Question:** The permission scope choices (Allow once / Allow for this project / …) become an item-group stop inside the dialog's trap ([P17]). Is it a **plain radio item-group** (Tab lands on the group, arrows select-within per the [#step-7-5] single-select model) or a **descendable group** ([#step-5]: Tab lands a ring on the group, Enter / Right *descends* in, arrows rove, Escape ascends)? The user phrased issue #1 as "no way to **descend** into the options."

**Why it matters:** It sets the gesture count and whether Escape inside the group ascends-to-group vs cancels-the-dialog. The descend model adds a level the two-option list may not warrant; the plain model is one fewer gesture but reads less like the list/accordion family.

**Options:** (a) **plain radio item-group** — Tab to the group, arrows pick (selection follows cursor), Return falls through to Allow; (b) **descendable group** — Tab rings the group, Enter/Right descends, arrows pick inside, Escape ascends to the group (a second Escape denies).

**Resolution:** DECIDED — **(a) plain radio choice group** (user, 2026-06-08). The scope choices are a single radio item-group stop: Tab reaches the group, arrows pick (selection follows the cursor, [#step-7-5] single-select), Return falls through to Allow; Escape denies (no ascend level). No descend model — "descend" meant "reach into," which the plain group satisfies with one fewer gesture.

#### [Q07] Cycle-stop topology with a pending dialog (RESOLVED — obviated by [P16]) {#q07-dialog-cycle-topology}

**Question:** Where would the dialog stops sit in the card's [P10] Tab order, and how would they register into the card's cycle scope across the render boundary?

**Resolution:** OBVIATED. The card-modal decision ([P16]) keeps the dialog **trapped**, so it never threads into the card's cycle: there is no cross-render-boundary registration to settle, no cycle-stop ordering to choose, and no editor/submit-participation question (the editor stays deactivated and excluded, as today). The dialog's controls register into the trap's own mode via `FocusModeContext`. This question existed only for the abandoned "join the walk" model and is retained as a record of why that path was dropped.

#### [Q08] QuestionDialog scope under the new model (OPEN → resolve in #step-7-6-question) {#q08-question-scope}

**Question:** The `QuestionDialog` is a paged wizard (Cancel / Submit on the header, Back / Next nav, per-question option groups, a review state). Does it adopt the same card-modal archetype model as PermissionDialog ([P16]/[P17]) — Cancel/Submit/Back/Next as leaf stops + option groups as item-group stops inside the trap — or does it keep an internal sub-navigation for the wizard?

**Why it matters:** The wizard has more internal structure than the permission dialog; a naïve flattening of stops could make the Back/Next/review flow awkward. But two different inline-dialog keyboard models would violate the "one language" goal.

**Resolution:** DECIDED — **same model** ([#step-7-6-question]). Cancel/Submit/Back/Next are leaf stops; the current question's options are a single **deferred** item-group stop (`CurrentRowOptions` — arrows move a cursor, Space/Enter pick: a single-select pick auto-advances, a multi-select pick toggles — so, unlike the permission scope group, it does NOT use `singleSelect` passthrough). A re-seed effect keyed on `currentIndex` moves the key view onto the new step's options as the wizard advances (auto-advance / Back / Next), and onto Submit/Cancel at the review step. Wizard auto-advance / review / [A9] state is unchanged. Verified by at0146.

#### [Q09] Scrim scoping technique for an in-flow modal ([P19]) (OPEN → resolve in #step-7-6-modal) {#q09-scrim-technique}

**Question:** How is "dim everything except the inline dialog (and its subject tool-call row)" expressed in CSS when the dialog renders *inside* the scrolling transcript rather than as a portal overlay?

**Why it matters:** A naïve full-card overlay can't sit "behind the dialog but over everything else" — the dialog is in the flow, not on top. The scoping has to dim siblings/ancestors while excepting the dialog subtree, without a backdrop element and without touching the dialog's own contrast.

**Options:** (a) a `[data-inline-dialog-pending]` signal on the card root that dims the chrome zones (Z2/Z4/Z5) and transcript rows `:not()` the pending dialog (and `:not()` its subject tool-call row); (b) an explicit dim class applied to each chrome zone plus a transcript-level dim the dialog row opts out of; (c) two stacked layers (dimmed transcript + bright dialog) via z-index within the flow.

**Resolution:** DECIDED — **(a)** ([#step-7-6-modal]). A `data-inline-dialog-pending` signal on the card root (`.dev-card`) dims the chrome (`.dev-card-status-bar`, `.dev-card-entry-pane`) and the transcript rows `:not(:has(.dev-permission-dialog)):not(:has(.dev-question-dialog))` to `opacity: 0.45`. The dialog **restates its own subject** (the description names the command / file; an Edit shows its diff in the body), so the single bright island is the dialog's own transcript row — no separate "subject tool-call row" exception is needed (simplifies the lean's `:not()` set, and keeps R04 satisfied since the subject lives inside the bright dialog). Appearance-only ([L06]); no portal / backdrop.

---

#### [Q10] In-group commit key — Space only, or Space and Enter (RESOLVED — 2026-06-09, #step-7-8-spike → (a)) {#q10-commit-key}

**Question:** When the ring rests on a member of a selection group (radio / choice / option), does **Enter** also commit that member, or is Enter reserved exclusively for the scope default action (the ringed default button, e.g. Allow)?

**Why it matters:** This is the exact seam that produced the original Enter-on-Allow bug. If Enter commits the ringed group member, it cannot also bubble to the scope default — the two meanings collide on one key. Reserving Enter for the default (and committing the group member with Space) is what lets "groups never consume Enter" become unconditional and lets the `enterPassthrough` flag disappear ([P24]).

**Options:** (a) **Space commits the ringed member; Enter is always the scope default (bubbles past the group)** — recommended; (b) Space and Enter both commit the member when no competing default exists, Enter bubbles only when a default is present (context-dependent — reintroduces the per-layout consume/bubble ambiguity this whole model exists to kill).

**Plan to resolve:** decide in the spike ([#step-7-8-spike]) against the PermissionDialog, where a default button (Allow) and a group (scope radio) coexist. Leaning (a).

**Resolution:** (a) — **Space commits the ringed member; Enter is always the scope default** (bubbles past the group). Forced by [P24] and the [#seam-arrow-matrix] selection-group row: Enter is unconditionally the scope default for item containers, so it cannot also commit a group member. In `focus-act.ts` this is the `enterPassthrough` flag becoming the always-true behavior for item containers ([#step-7-8-commit]).

---

#### [Q11] Opt-Tab escape semantics — eject-to-next vs release-in-place (RESOLVED — 2026-06-09, #step-7-8-spike → neither; Opt-Tab is out, escape is Tab/Escape) {#q11-opt-tab-eject}

**Question:** When a component captures the arrows (text-editor caret, slider value), what does the escape chord do? Does Opt-Tab **eject to the next node** (advance the ring off the component; arrows are spatial again on the next stop), or **release arrow-capture in place** (the ring stays on the component, which enters a nav-not-edit state so the next arrow navigates spatially *from here*)?

**Why it matters:** "Release in place" is a richer, vim-like normal/insert split — more power (arrow *away from* an editor without first Tabbing off it), more concept (a per-component "focused but not editing" substate). "Eject to next" is simpler and matches the plain mental model. Plain **Tab** already leaves any component that does not itself consume Tab; Opt-Tab is the eject for the ones that do (the code editor).

**Options:** (a) **eject-to-next** — recommended default; (b) **release-in-place** (a per-component nav/edit substate).

**Plan to resolve:** spike both against the prompt editor in [#step-7-8-spike]; default to (a) unless a concrete need for (b) surfaces. Confirm the chord does not collide with the ⌥⇥ cycle trigger (R02).

**Resolution:** **Opt-Tab is rejected — R02 is real.** `⌥⇥` (`code: "Tab"`, `alt: true`) is already bound to `TUG_ACTIONS.CYCLE_FOCUS_MODE` in `keybinding-map.ts` — it *toggles a card's keyboard-focus-cycling mode*. An "Opt-Tab eject" would therefore exit cycling rather than eject to the ring; the two cannot coexist on one chord. So the spike drops Opt-Tab entirely and the escape story collapses to two existing chords (the [#seam-arrow-matrix] already lists "(or Escape)"):
- **Plain Tab** leaves any component that does not itself eat Tab — and in cycling mode Tab is *already* repointed to walk the zones, so it ejects even a normally-Tab-consuming editor.
- **Escape** (ascend, the existing act-vocabulary meaning) is the eject for a descended component that hard-consumes Tab outside cycling (multi-line / code editor). It releases to the ring (the eject lands you back on the component's key view, ring intact; the next Tab moves on) — so the eject-to-next-vs-release-in-place sub-question is moot: Escape releases to the ring, Tab advances from there.

A focused single-line text entry already leaves on plain Tab (it captures arrows, not Tab — [#seam-arrow-matrix]), so it needs no special chord. Wired in [#step-7-8-capture].

---

#### [Q12] Spatial-order registration API surface (RESOLVED — 2026-06-09, #step-7-8-spike → per-card declared `SpatialOrder` table) {#q12-ordering-api}

**Question:** What is the concrete API a layout uses to declare its spatial arrow order? The *shape* is decided ([P23]: named ordered rings + seams as the default, per-node neighbor overrides as the escape hatch) — this question is the registration surface: how a focusable joins a ring, how a ring is named / ordered, how seams between rings are declared, and how it composes with the existing `useFocusable` / `focusGroup` registration.

**Why it matters:** "Each layout wires this in meticulously" makes the authoring API the whole ergonomic story. Get it verbose or leaky and authors will under-fill it (dead arrows — R06). It must read like the layout (a horizontal button ring, a vertical option ring, one seam) and reuse the per-card `FocusContext` registry rather than adding a parallel one.

**Options:** sketched in [#spatial-nav-model] — a ring id + index per focusable plus a seam table on the context; whether seams are declared on the ring or per-node; whether the existing `focusGroup` / `order` props are reused or a new `arrowRing` / `arrowOrder` slot is added.

**Plan to resolve:** prototype on the PermissionDialog in [#step-7-8-spike]; lock the surface before the engine work ([#step-7-8-spatial]).

**Resolution:** A **per-card declared `SpatialOrder` table**, distinct from the per-node `groupOrder` (the linear Tab integer). The layout author declares the *whole* table for the bounded scope (the card or dialog), not order-integers scattered per focusable — because rings and seams are relations between nodes, not a property of one node. The resolver landed as a pure module, `spatial-order.ts` (`resolveSpatial(order, node, direction, cursorIndex) → ring | cursor | none`), so the spike **graduates** (not throwaway): [#step-7-8-spatial] holds a `SpatialOrder` on the per-card `FocusContext` (keyed by card via `CardIdContext`, the same context focusable registration already rides) and calls `resolveSpatial`. The locked shape:
- `rings: { axis: "horizontal"|"vertical"; nodes: string[]; closed?: boolean }[]` — ordered runs of key-view ids; `closed` (default true) wraps the edges so the ring never beeps.
- `seams: { from; direction; to }[]` — explicit boundary crossings (the author writes the return edge for reversibility).
- `overrides: { from; direction; to }[]` — the [P23] per-node escape hatch; wins over rings and seams.
- `groups: { node; length }[]` — **the delegation contract.** A selection group is ONE ring node with a 1D cursor (any arrow moves it: down/right → next, up/left → previous). The author does **not** declare this — the navigator injects it live from the group's registered `SpatialCursorHandle` (`length` + `cursorIndex` + `moveCursor` + `tryDescendRight`), so a non-edge move resolves to `{ kind:"cursor", delta }` (the navigator drives the handle, firing any live commit) and an edge move falls through to a seam. This keeps `data-key-cursor` appearance-only ([L06]) and "Tab never lands on an item" intact. **Node references are stable `group:order` keys** (the navigator maps the ringed focusable id ↔ key via `focusKeyOf` / `idForFocusKey`), so an author never needs an auto-generated id; declaration rides `useSpatialOrder(scopeId, order)`.

Resolution precedence (most specific first): override → group-delegation (non-edge) → seam → ring (wrap if closed) → **linear-order liveliness fallback** (the navigator walks `groupOrder` so the arrow always moves; never a beep, never a dead-end — R06).

---

#### [Q13] Dev-card spatial generalization — 2D order, list-as-handle, edge-landing (RESOLVED — 2026-06-09, #step-7-9-devcard spike) {#q13-devcard-spatial}

**Question:** Three coupled decisions for putting the spatial plane on the dev card (the richest, 2D layout):
1. **The 2D order + whether arrows belong in cycling — including editor-zone arrow-*leave*.** The dev card tours its zones with Tab in cycling mode ([#cycle-model]); what spatial order (toolbar row as a horizontal ring, the Z2 status bar as a second row, the editor as the body) reads as "the direction you see," and does an arrow plane coexist cleanly with Tab there? **Critical sub-question:** can the ring be arrowed *off* the editor zone? [P25]'s editing-host yield gives a focused `contentEditable` all four arrows — if the editor zone's focused element is/contains CodeMirror's `.cm-content`, arrows feed the caret and the ring is trapped. Confirm the zone sits on a wrapper stop (arrow-leaveable, descent drops into the caret), or treat the editor as a Tab/Escape-only body rather than an arrow stop.
2. **List-as-handle ([Q12] option (a)).** The dev card has pickers (`TugListView`), which today own their arrows (decision (b), Tab-reached). Should `TugListView` register a `SpatialCursorHandle` so a picker joins a declared ring (arrows traverse *into* it), or does Tab-reached suffice on the dev card? This decision also governs 7.9.1-multi / 7.9.2 (see [#step-7-9] Sequencing caveat).
3. **Edge-aware seam landing.** Should a seam into a group be able to land the cursor at the *bottom* (a true vertical wrap — the 7.8 by-eye nit), via an optional `land: "first" | "last"` on `SpatialSeam` + a `setCursor` path on the handle? **Implementation subtlety:** the group's `wasKbd` auto-seed (selection-landing, fired off `setKeyView`'s notify) races a post-seam `setCursor(last)` — the override must run after the seed and on an active cursor, or be folded into the seed. Validate the ordering in the spike.

**Why it matters:** the dev card is the end-to-end vetting surface ([#cycle-model]) and the first genuinely 2D layout; (2) and (3) are the two primitives 7.8 deferred. Deciding them on the dev card keeps the engine additions demand-driven (build them only if the feel needs them) rather than speculative.

**Plan to resolve:** spike on the dev card in [#step-7-9-devcard] *before* any engine work; land each adopted primitive as a small, separately-committed, pure-logic-tested change ahead of the dev-card authoring that uses it. **Lean:** map the 2D order first; adopt list-as-handle only if a picker genuinely needs in-ring arrow traversal; adopt edge-landing only if the vertical wrap feels wrong without it.

**Resolution:** Spiked against the real dev-card cycle (`dev-card.tsx` `DEV_CYCLE_GROUP`; stops route 0 / mode 1 / model 2 / effort 3 / submit 4 / Z2 status cells 5–9 / editor 10 — all *leaf* stops, no delegated group in the cycle).

1. **2D order — adopted.** Two horizontal rings — the toolbar (route → mode → model → effort → submit) and the Z2 status cells — with a vertical seam cycle between the rows, built with `rowGridOrder` and declared under the **cycle scope** (`useCycleMode().scopeId`), so it is consulted exactly while cycling and coexists with the unchanged linear Tab walk.
2. **Editor arrow-leave — resolved by EXCLUSION (no new primitive).** The editor (order 10) is the cycle's *body*, not an arrow stop: it is deactivated while cycling and a focused `contentEditable` keeps its caret arrows ([P25]), so trying to arrow *out* would trap the ring. It is deliberately left OUT of the grid (Tab / typing / ⌥⇥ enter it); the navigator's `nodeInOrder` gate means even a ring that landed there would yield its arrows to the caret.
3. **List-as-handle ([Q12](a)) — NOT needed here; stays at (b).** The cycling dev-card layout has no inline `TugListView` — the chips are leaf `TugPopupButton`s and the pickers open as separate sheets/menus. So the dev card needs no in-ring list traversal; 7.9.1-multi / 7.9.2 likewise stay Tab-reached. The primitive remains deferred (build it only when a surface genuinely needs arrows *into* a list).
4. **Edge-aware seam landing — NOT needed; deferred.** All dev-card cycle stops are leaf, so there is no group cursor to land at an edge — the `wasKbd`-seed timing subtlety never arises. Left for a future surface that puts a delegated group in a vertical 2D layout.

**One engine refinement adopted** (in lieu of a new primitive): the navigator skips a ring/seam target that resolves to a **disabled / absent** stop and falls to the liveliness walk, landing on the next interactive key view. This lets an author declare a *fixed* grid over a layout whose membership changes by state (the chips disable on the Shell route) without recomputing it per state — no author-time membership filtering. It lives in `moveKeyViewSpatial` (interactivity is a DOM property — `isRecordInteractive`), so it is covered by the at0140 app-test (the Shell-disabled-submit skip), not the pure resolver.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| App-wide re-skin regresses a shipped surface's focus affordance | high | med | Re-point the global rule first ([#step-1]) so everything stays coherent; per-surface steps; live-build pass | A surface loses/garbles its focus ring |
| Behind-tint clobbers a component background | med | med | One settled layering technique ([Q02]); per-component eye check both themes | Tint hides content or wrong surface |
| Silent visual regressions (pixels not app-tested) | med | med | By-eye gallery review per theme/mode is a required checkpoint; behavior app-tests guard that attributes/behavior didn't move | Reviewer can't tell focus from rest |
| Role-axis adoption balloons into prop churn | med | low | Default `action` means no prop changes for most; only focus CSS moves ([P03]) | A step needs new props on many components |
| Theme contrast: filled role on light vs dark flips text legibility | med | med | Keep the spike's retuned intensities; verify white-on-fill in both themes per step | Text unreadable on a filled selection |
| Cycle trigger chord eaten by OS/WebKit | high | med | Spike the chord first ([#step-cycle-trigger-spike]); fall back to a non-Tab chord ([Q05]) | A posted chord never reaches the document listener |
| Cycling mode regresses the editor's typing / Tab semantics | high | low | Mode is opt-in + trapped; behavior app-tests for enter/cycle/act/exit AND editor-Tab-still-completes | Tab in the editor stops doing completion |
| Scrim dims the very tool call the dialog is about | med | med | Dialog subtree + its subject tool-call row opt out of the dim ([P19]); by-eye legibility check both themes | The user can't read what they're approving |
| Card-modal / cycle focus lost across card switch or app switch | high | high | Per-card focus-mode suspend/restore on (de)activation ([P21]); a pending card-modal dialog is the card's active focus destination ([P20]); switch-away-and-back app-tests | A pending dialog goes inert on return; the editor is focusable behind a modal |
| Spatial-order slots under-filled → arrows with no declared target | med | low | Linear-order liveliness fallback: the navigator walks `groupOrder` so an arrow always moves — never a dead-end ([P23], R06). Authored seams shape the feel | An arrow press feels spatially surprising (but never beeps / dead-ends) |
| Reverting selection-follows-cursor churns recently-shipped code + tests | low | high | The model *collapses* flags (net simplification); rewrite at0117/at0118/at0145 to explicit-commit ([P24], R07) | A group commits on arrow after the revert |

**Risk R01: Mixed-language window during rollout** {#r01-mixed-window}

- **Risk:** Between [#step-1] and the last component step, migrated and un-migrated focusables could show two different focus looks.
- **Mitigation:** [#step-1] re-points the *global* `[data-key-view-kbd]` rule to the new ring axis, so every un-migrated focusable already rings in the new language; per-component steps then add the behind-tint + native-fill refinements. There is never an orange-vs-new split — only "ring only" vs "ring + refinements".
- **Residual risk:** Un-migrated groups show the component ring rather than the cursor-item ring until their step lands; acceptable and self-evidently in-progress.

**Risk R02: The cycle trigger is unreachable** {#r02-trigger-eaten}

- **Risk:** macOS / WebKit may intercept Opt-Tab (a Tab-family chord) before it reaches the WebView, exactly as it eats ⇧⇥ — leaving the cycling mode with no way in.
- **Mitigation:** confirm reachability in [#step-cycle-trigger-spike] *before* building the mechanism; [Q05] carries a non-Tab fallback chord.
- **Residual risk:** the fallback chord is less mnemonic than Opt-Tab.

**Risk R03: Un-trapping the inline dialog leaks the keyboard (OBVIATED by [P16])** {#r03-dialog-untrap}

- **Status:** OBVIATED. The card-modal decision ([P16]) keeps the dialog **trapped**, so there is no un-trapping and no keyboard-leak path; the `CANCEL_DIALOG` responder (Escape/Cmd-. → Deny) is unchanged. Retained as a record of the rejected "join the walk" direction.

**Risk R04: The scrim hides the dialog's own subject** {#r04-scrim-legibility}

- **Risk:** Dimming the card content around the dialog ([P19]) could also dim the tool-call row the permission is about, leaving the user approving something they can't read.
- **Mitigation:** the dialog subtree **and** its subject tool-call row opt out of the dim; by-eye legibility check in both themes ([#step-7-6-modal]).
- **Residual risk:** a quiet scrim still slightly lowers peripheral-context contrast — acceptable; that is the intended effect.

**Risk R05: Focus state is pooled deck-global instead of per-card (the missing key-window model)** {#r05-global-modestack}

- **Root cause (not just a risk):** The `FocusManager` is a single deck-wide singleton (one `reactRoot.render` in `deck-manager.ts`; `ResponderChainProvider` mounted once) holding ONE `modeStack` and ONE key view shared by **every card**. But focus state — the mode stack (cycle / card-modal trap / descend), the key view, the key-within — is inherently **card-local**: each card is a self-contained focus universe with its own resting key view (editor caret), its own modes, its own focusables. Pooling N cards' state into one stack is the wrong data structure. Its symptoms: a background card's still-pushed trap (its dialog stays mounted at `display:none`, so `useFocusTrap` never pops it) is `currentFocusMode` while a *different* card is active; and a card-modal dialog's focus, established once on open, is gone on return because the deck-global key view was overwritten and `paintMirrorAsActive` refocuses the editor ([#focus-restore-audit]). The current code papers over the pooling with run-time filters — `isRecordRendered` excludes `display:none` cards from the walk, `walkModeSet` bounds to the top mode — which are exactly the band-aids a wrong shape forces.
- **The system already names the right model.** The responder chain has a **key card** (`getKeyCard`, `sendToKeyCard`, key-card-scoped chords) — the AppKit *key window*: each window owns its own responder chain / key-view loop, and the app routes input to the key window. The focus mode stack is the one structure that did NOT follow this; it pooled instead.
- **Mitigation (the from-scratch design, not a tag-and-filter patch):** **per-card focus contexts** ([P21]) — each card owns a self-contained `FocusContext` (mode stack + key view + its focusables); the `FocusManager` becomes a deck **coordinator** holding deck-global settings (ring modality, access mode), the key-card pointer, and the per-card contexts, routing the document Tab/pointer listeners and the engine API to the **key card's** context. A card switch swaps the active context; each card's focus universe is independent and preserved **by construction** — no tagging, no suspend/restore reconciliation of a shared stack, and the *cross-card* role of `isRecordRendered` dissolves (its within-card hidden-element filter and `isRecordInteractive` stay — they are correct inside one context). [P20] (a pending dialog is the card's destination) then falls out: the card's context already remembers the dialog as its key view.
- **Residual risk:** the refactor must preserve every per-scope invariant (cycle pop-on-unmount + mouse-exit; sheet opener-restore + pane `inert`; descend ascend-on-Escape); the audit's regression matrix ([#step-7-7-audit]) is the gate. Sheets are *pane*-modal (a pane shows one card at a time + `inert` on the pane body), which composes cleanly: a sheet's trap lives in its pane's active-card context, cross-pane isolation stays a DOM (`inert`) concern.

**Risk R06: Author under-fills the spatial order → arrow keys that land on nothing** {#r06-dead-arrows}

- **Risk:** [P23] moves the cost from heuristics to authoring: every layout declares its arrow rings + seams, and a focusable left off every ring would otherwise be unreachable by arrows — a *dead arrow* that violates the "arrows always move the ring, never beep" guarantee ([P22]).
- **Mitigation — DECIDED (liveliness fallback, 2026-06-09):** the spatial navigator can **never** dead-end. Within a declared spatial scope, an arrow with no spatial target (a group edge, or a direction the rings / seams don't name) **falls back to the linear `groupOrder` walk** — down / right advance, up / left retreat, both wrapping (`moveKeyViewSpatial`). The authored rings / seams give the *spatial feel*; the linear walk is the net under them, so an arrow always lands somewhere and the interface never beeps and never silently swallows the key. This is the user's "never beeps falls back to the design-time ordering" decision realized: the linear order IS the design-time ordering. (A `tugDevLog` reachability *warning* was prototyped in 7.8.3 and then removed — with the fallback there is no dead arrow to warn about.)
- **Residual risk:** the fallback guarantees *liveliness*, not *intuitiveness* — a linear-walk target can be technically-sensible but spatially surprising (e.g. Up from a second top button steps to its sibling rather than wrapping to the content below). The authored seams exist precisely to make the common motions match what the user sees; the rest stays a by-eye judgment.

**Risk R07: The explicit-commit reversion churns shipped selection code** {#r07-reversion-churn}

- **Risk:** [P24] reverts the selection-follows-cursor model shipped in the 7.7 era (the `onMove` commit, `commit: "live" | "deferred"`, the `deferCommit` prop, the conditional `enterPassthrough` flag) and the app-tests pinned to it (at0117 / at0118 / at0145 assert select-on-arrow).
- **Mitigation:** the reversion *removes* flags rather than adding them — arrows stop being a commit mechanism anywhere, so the four-way flag cluster collapses to one rule ("Space/Enter commits, arrows move the ring"). Rewrite the three app-tests to the explicit-commit contract as part of [#step-7-8-commit]; this is planned evolution, not an unplanned regression.
- **Residual risk:** muscle memory from the brief selection-follows-cursor era (arrowing a radio committed it) must be re-learned; acceptable and intended.

---

### Design Decisions {#design-decisions}

#### [P01] The focus signature: ring + faint behind-tint on the focused component; native fill for selection (DECIDED; GOVERNING; supersedes keyboard-model [P03]) {#p01-signature}

**Decision:** Keyboard focus is shown by a **ring** on the focused element plus a **faint behind-tint** on its component; committed selection is the component's **native fill** (radio dot / segmented pill / option fill / list-row fill / checkbox-switch fill). These are three orthogonal marks — ring = "the keyboard is here", tint = "this component is focused", fill = "this is selected".

**Rationale:**
- Proven by eye on the spike canvas across the full archetype taxonomy in both themes.
- Selection-as-native-fill preserves decades-old per-component conventions; the keyboard layer sits on top rather than replacing them.
- Supersedes keyboard-model [P03] ("ring on the component, *never* on a sub-item; cursor = hover token"): the spike showed the cursor must be able to ride **on top of** a selection fill (multi-select), which a ring does and a tint can't — so for item-groups the ring moves to the cursor item (see [P02]).

**Implications:** `styles/focus-ring.css` and per-component CSS react to the existing attributes; the orange `--tugx-focus-ring-color` axis is retired from the focus path; the keyboard-model matrix's visual column is rewritten ([#step-9]).

#### [P02] Leaf rings the whole component; item-group tints the group and rings the cursor item (DECIDED) {#p02-leaf-vs-group}

**Decision:** For a **leaf** focusable (button, input, toggle, slider) the component *is* the focusable, so the ring wraps the whole component and the behind-tint sits behind it. For an **item-group** (radio/choice/option/list/accordion/Q&A) the behind-tint sits on the **group** and the ring sits on the **cursor item** — so the cursor stays visible even atop a selected item's fill.

**Rationale:** Resolves the multi-select crux (a tint vanishes under a fill; an outline ring does not) with no added checkmark, while keeping a single signature.

**Mechanism — the inversion, and how CSS tells a leaf from a group.** Today the global focus rule maps `[data-key-view-kbd]` → an outline **ring** and `[data-key-cursor]` → a background **tint**. This model **inverts that for groups**: a group key-view becomes a behind-**tint** and the cursor item becomes a **ring**. The engine does **not** project a container-kind attribute (verified: `use-focusable` sets only `data-tug-focusable` / `data-tug-focus-key`; the `container: "item"` kind never reaches the DOM), and this plan **adds none** ([P04]). So differentiation is **pure CSS, per component**:

- the global rule keeps `[data-key-view-kbd]` → ring — correct for a **leaf** control;
- `[data-key-cursor]` is changed **globally** to an outline **ring** (role-resolved) — correct for every cursor item;
- each **group** component, in its own step, **overrides the global ring on its `[data-key-view-kbd]` root to `outline: none` + the behind-tint**, keyed on its own `data-slot` / `role` (e.g. `[data-slot="tug-radio-group"]`, `role="radiogroup"`).

No engine touch; stays in the appearance zone ([L06]).

**Implications:** the leaf-vs-group split is owned by each group's CSS overriding the global ring; [#step-1] globalizes only the ring recolor + the cursor→ring flip; the behind-tint is applied **per archetype** (steps 2–8), never globally. Until a group's step lands it shows the leaf ring on its container — a benign in-progress state (Risk R01).

#### [P03] One role axis, default `action`; no role-less branch (DECIDED) {#p03-role-axis}

**Decision:** The ring color, the selection fill, and the behind-tint all resolve from a **single role variable that defaults to `action`** (the neutral interactive blue) and is overridden per role. Every focusable is modeled as carrying a role; "role-less" controls simply ride the `action` default. Buttons additionally **promote to their filled role style** on focus (the [#step-2] keyboard-promoted state).

**Rationale:** Collapses the two-case (role vs role-less) handling into one path; makes a danger input / accent toggle / danger option expressible for free; matches the spike's final unification.

**Implications:** No `var(--role, fallback)` branching; components set the role variable only when non-default. `TugInput.validation` maps onto it ([P07]); `TugTabBar` keeps `action`.

#### [P04] Re-skin over stable engine attributes — no engine change (DECIDED) {#p04-reskin}

**Decision:** This plan changes only CSS, tokens, and a few resting-style renders. It does not modify the focus engine, the scope stack, the projection of `[data-key-view-kbd]`/`[data-key-cursor]`/`[data-key-within]`/`data-selected`, or any behavior.

**Rationale:** The de-risker — behavior app-tests (which assert attributes/behavior, not pixels) stay green and prove nothing behavioral moved; the work is contained to the appearance zone ([L06]).

**Implications:** Every step's checkpoint includes the relevant behavior app-tests still `VERDICT: PASS` plus `tsc` clean; appearance is the by-eye add-on. The leaf-vs-group differentiation ([P02]) is handled by per-component CSS overrides, **not** a new engine-projected attribute, to keep this decision intact. (Deliberate behavior exceptions, each carried with its own app-tests: [P08] TugTabBar commit-on-act, and [P09] the keyboard-focus-cycling mode — a new, opt-in mode that gives the focus language its home on text-first cards, built on the engine's existing focus-mode stack rather than a new projection.)

#### [P05] Token architecture — promote the spike's `--fl-*` knobs to real tokens (DECIDED; shape in [Q01]) {#p05-tokens}

**Decision:** Author a real focus-language token surface (ring / behind-tint / selection-fill, resolved from the role axis) in `styles/focus-ring.css` + the theme files, replacing the spike's private `--fl-*`. Component CSS consumes these tokens, not bespoke per-component colors.

**Rationale:** Single source of truth, theme-aware, tunable in one place (as the spike demonstrated); avoids the bespoke-per-component drift the dialogs currently have.

**Implications:** [#step-1] lands the tokens; later steps consume them; the spike card is repointed at them ([Q04]).

#### [P06] Buttons keep fill-promotion, unified into a TugPushButton keyboard-promoted state (DECIDED) {#p06-button-promote} 

**Decision:** A focused button promotes to its filled role style + role ring (demoting siblings to outlined), lifted from the bespoke dialog CSS into `internal/tug-button.css` reacting to the engine attributes. The inline Permission/Question dialogs consume this state instead of carrying their own copy.

**Rationale:** Buttons have no separate selection, so fill-as-focus is unambiguous and is the treatment already shipped + loved in the dialogs; centralizing removes duplication.

**Implications:** `dev-permission-dialog.css` / `dev-question-dialog.css` shrink to dialog-layout only; the promotion is a first-class button capability.

#### [P07] TugInput validation maps onto the role axis (DECIDED) {#p07-input-validation}

**Decision:** `TugInput`'s existing `validation` axis (`default`/`invalid`/`valid`/`warning`) maps onto the role axis: invalid→danger, valid→success, warning→caution, default→action. The focus ring/border take the resolved role color; no parallel "role" prop is added.

**Rationale:** One semantic-color axis, not two; an invalid field focusing red is the natural, expected behavior.

**Implications:** Input focus CSS resolves the role from the validation class; covered in [#step-6].

#### [P08] TugTabBar keeps live commit; adopts the item-group visual signature (DECIDED; REVISED in #step-4) {#p08-tabbar-commit}

**Decision:** `TugTabBar` **keeps live commit** — the selection follows the cursor on every arrow move (the ARIA-tabs *automatic activation* pattern) — and adopts the item-group focus **visual** signature (behind-tint on the bar + the cursor ring + the native `data-active` fill). Because it commits live, the cursor always rides the active tab: the focused tab shows the cursor ring *and* its fill at once.

**Rationale (revised).** The original decision flipped the tab bar to commit-on-act "to remove the one live-commit special case." Reversed after seeing it: a tab bar is a **view switcher**, not a value picker. The ARIA tabs convention is automatic activation whenever switching content is inexpensive (it is here — switching a card is cheap), because the user expects to *see* the tab they move to. Commit-on-act stranded the cursor ring on an un-shown tab (ring on "Overflow" while still viewing "Hello") — a confusing preview state that doesn't belong on navigation. The live commit is a *justified* special case, not an accident; uniformity with TugChoiceGroup is not worth the worse UX. The valuable part of the original — the item-group *visual* signature — is kept; only the commit timing reverts.

**Implications:** Pure-appearance change at the component (the live commit behavior is unchanged from before the focus-language work) plus the new visual signature. The step's app-test asserts the new visual (behind-tint on the bar, cursor ring on the tab) AND the live switch (arrow moves the cursor and switches the view together). The keyboard-model matrix row stays **live**.

#### [P09] Keyboard-focus-cycling mode for text-first cards (DECIDED; behavior addition) {#p09-cycle-mode}

**Decision:** Text-first cards — whose resting key view is a text editor that owns Tab — gain a **keyboard-focus-cycling mode**: a per-card, **trapped** engine focus-scope, toggled by a dedicated trigger ([Q05]), within which Tab circulates the card's chrome zones (the [D97] `Z`-areas) while the editor's typing semantics are suspended. The resting state after connection is **typing** (caret in editor); the trigger flips to **cycling**. The mechanism is **general** (any text-first card opts in); the **dev card is the first consumer**.

**Rationale:**
- The editor needs Tab (completion / indent, `at0104`) and the chrome needs Tab (reach the `Z`-zones) — irreconcilable on one Tab. A *mode* resolves it (the modal-editor move).
- Cycling is the surface that finally exercises the whole focus language on a real card — one Tab tour shows every archetype — so it is feature and end-to-end vetting surface at once.
- The deferred a11y mode ([Q03]) likely falls out for free ("always-on cycling" = the cycle scope is the base mode).

**Implications:** A scoped **behavior** addition — the [P04] carve-out — built on the engine's existing focus-mode stack (`pushFocusMode` / `popFocusMode` / `focusFirstInMode`), adding **no** new engine projection. Carried with its own app-tests. A reusable hook + dev-card wiring; the *visuals* come from [#step-1]–[#step-8]. See [#cycle-model].

#### [P10] Cycle topology — zones are the focus-language item-groups (DECIDED) {#p10-cycle-topology}

**Decision:** In cycling mode, **Tab moves between zones; arrows rove within a zone.** A multi-control *semantic group* is an **item-group** (behind-tint on the zone, ring on the cursor item, per [P02]); a single control or a cluster of independent controls contributes **leaf** stops (whole ring). The cycle is **trapped** (wraps within the card), Shift+Tab reverses. The **Z1 transcript is excluded** from the first cut.

**Order + seed — REVISED 2026-06-06 (supersedes the original "seed at Z5 submit / wrap top→bottom"):** the cycle reads the card **bottom toolbar left→right, then up, then into the editor**, and **seeds at the route (the first stop)**:

> **route (Z4A) → Mode → Model → Effort (Z4B) → submit (Z5) → Z2 status row → prompt-entry editor → wrap.**

The **editor is the last stop** (a text stop, per [P11]): landing gives the **still-blurred** input area a clear focus-ring-colored **border around the whole text component** (a `::after` overlay — a plain inset `outline` was painted over by the CodeMirror substrate and read as no indication at all), and **Return resumes typing** (exits cycling). The **Z4B chips are independent leaf stops** (Mode/Model/Effort). A **disabled** stop (the empty submit; the Z4B chips on the Shell route) is dropped from the walk by the engine's interactivity filter (`FocusManager.isRecordInteractive`), so the seed lands on the next live stop (route stays first).

> **Z2 = five leaf stops — REVERSED 2026-06-06 (by-eye).** The interim "Z2 is one item-group stop, arrow-rove the cells" was tried and **felt awful** in practice. Decision reversed: **each Z2 status cell (STATE / TIME / TOKENS / CONTEXT / TASKS) is its own leaf Tab stop**, exactly like the Z4B chips — Tab steps cell-to-cell, no arrow-roving, each cell wears the blue leaf ring in turn, Space/Enter opens its popover. The order becomes route → Mode → Model → Effort → submit → STATE → TIME → TOKENS → CONTEXT → TASKS → editor → wrap (cells at orders 5…9, editor at 10). A consequence: **a Z2 cell rings only while it is the active cycle stop** — never at rest (there is no item-group cursor to strand). This makes the Z2 cells a *cluster of independent controls*, not a semantic group, so the [P02] item-group treatment does not apply to them.

**Why the seed moved off submit:** with the editor now in the cycle and the full toolbar+Z2 walked, a spatial left→right→up→editor reading is more legible than "nearest-actionable-first"; the route is the natural entry. (This reverses the earlier interim "submit first" — see [P12], also revised.)

**Refinement (impl):** "multi-control zone = item-group" applies only to a **semantic group** — and in this card that is **only the Z4A route** (Code/Shell). Clusters of **independent** controls are runs of leaf stops, each its own Tab stop: the Z4B chips (Mode / Model / Effort) **and** (per the 2026-06-06 reversal above) the Z2 status cells. Arrow-within is for true groups only.

**Rationale:** Zone-granular cycling keeps the Tab count low and maps the card's zones onto the focus-language's leaf/group archetypes — cycling *is* the language's showcase. Seeding at the route + reading left→right→up→editor gives a predictable spatial tour that ends on the text surface the user most often wants back.

**Implications:** Each consumer registers its zones as cycle stops (`focusGroup` into the card's cycle scope); the existing item-group focus CSS ([#step-3], [#step-5]) renders the within-zone roving for free.

#### [P11] Mode keys — Return is text-entry-only; Space acts; trigger exits (DECIDED) {#p11-cycle-keys}

**Decision:** While cycling: the **trigger toggles the mode off** anywhere (restoring the caret to the editor); **Return is reserved for text-entry contexts only** — landing the cycle ring on the prompt-entry (or any text-input) zone and pressing Return **drops into the field** (resume typing — which also exits cycling), where the route's own Return semantics apply (Prompt: Shift+Return submits; Shell: Return submits), and on a **non-text** control Return is inert; **Space acts** on the focused control (the engine act tier). Dedicated chords stay live throughout (routes ⇧⌘C / ⇧⌘S, permission ⇧⌘P, and the per-zone Z2 chords Cmd-1…N). **Escape is deliberately NOT bound** to exit cycling in the first cut — the trigger already toggles off, and Escape is kept free for future per-stop / cancel-ladder semantics; revisit only if exiting via Escape proves a real need.

**Rationale:** "Return = enter / commit text" is the one universal expectation; reserving it to text contexts keeps "land in prompt-entry + Return → typing" coherent and removes the ambiguous Return-activates-button-vs-submit case. Space-acts matches the existing act tier. The chords are the fast path; cycling is the discoverable / accessible path; they coexist.

**Implications:** The cycle scope's key handling routes Return only to text-input stops, dispatches act on Space, and pops on the trigger (and on Return dropping into a text stop). The Z2 cells gain Cmd-1…N popup-toggle chords ([#step-cycle-keys]).

**Brought forward (2026-06-06):** the **editor-as-text-stop** half — the prompt-entry editor is the cycle's last stop, lands the ring on the still-blurred input, and **Return resumes typing (exits cycling)** — lands with the dev-card cycle redesign ([#step-cycle-devcard], [P10] revised order), not deferred to [#step-cycle-keys]. The remaining [P11] mode-key semantics (Space-acts on non-text stops, the inert-Return rule on buttons, Cmd-1…N Z2 chords) stay in [#step-cycle-keys].

#### [P12] Per-state default focus + per-control roles for the dev card (DECIDED) {#p12-devcard-focus}

**Decision:** The dev card declares its default (resting) key view **per state** — **Picker → the Open (submit) button; Connected → the editor** — and focus **migrates deliberately on state transition** (spawn picker→connected seeds the editor; end connected→picker seeds Open), never landing wherever React happens to mount. Per-control roles: **submit = action** (danger while stopping), **route choice = action**, **permission chip = agent**.

**Rationale:** Matches the single-text-entry rule (the editor is the connected card's persistent destination) and the commit-home convention (Open is the picker's primary action). The roles make the cycle tour role-resolved per [P03].

**Cycling suppresses the standing fill; fill follows focus; restore on exit.** Outside cycling, the submit button is `filled` as its standing identity (the ring's home base) — unchanged; we do **not** touch the submit button. *During* cycling, `filled` means a different thing — the keyboard-focus convention (filled = "the keyboard is here") — so the submit's standing fill is **suppressed** so the fill follows the cursor (exactly one filled+ringed stop at a time), and **restored on exit**. The two meanings never co-occur, and the seed lands the fill on the commit-home on entry, so nothing flickers. Mechanism (pure CSS, [L06] — **no change to the submit button's component or props, no React-state emphasis swap**): a rule keyed on the card's `[data-cycling="true"]` signal (rendered from `useCycleMode`'s engine-derived `cycling`) relaxes the standing fill on cycle-stop buttons to outlined while cycling; the existing promotion rules (`[data-key-view-kbd]` / `[data-key-cursor]`) fill the focused one; on exit `data-cycling` drops and the submit reverts to its identity fill. This refines the keyboard-model "primary keeps its fill, ring moves" reading for the cycling context — in cycling, **filled === focused, everywhere**.

**Implications:** A per-state default-focus declaration on the card's seed path + the transition migration; the roles feed the focus-language visuals; the `[data-cycling]` fill-suppression rule lands with the dev-card wiring ([#step-cycle-devcard]). The `gallery-cycle-demo` already models the target (all stops outlined → fill follows focus); the suppression matters only where a cycle stop is `filled` at rest (the dev-card submit).

**REVISED 2026-06-06 — cycle seed + cycling visuals:**
- **Resting default focus is unchanged** (Picker → Open; Connected → editor). What changed is the **cycle seed**: ⌥⇥ now seeds the **route**, not the submit ([P10] revised). "Resting default" (where focus rests outside cycling) and "cycle seed" (the first stop ⌥⇥ lands on) are distinct — the resting default stays the editor; the cycle seed is the route.
- **Blur the input, drop the section ring.** While cycling, the editor stands down via the existing **`deactivated` read-only path** (`deactivated = inlineDialogPending || cycling`) — that *is* the mode indicator. The engine's **`data-key-within`** container mark (the faint outline on the focused stop's container — the toolbar / prompt-entry section) is **suppressed during cycling**: only the focused-stop ring + the input blur read the mode. (User: "don't draw an outer ring around the Z4/Z5 section.")
- **Editor-stop ring:** when the cycle lands on the editor (last stop), the still-blurred input area shows a **focus-ring-colored border** (the focused-stop ring for a text stop); Return resumes typing ([P11]).
- **Fill-suppression still holds:** the submit is `filled` at rest and suppressed-to-outlined during cycling so the fill follows the focused stop — unchanged by the seed move (it keys on `[data-cycling]`, not on being the seed).

#### [P13] Every focus context is persistent-cycling or toggleable-cycling (DECIDED) {#p13-context-cycling-type}

**Decision:** Every focus context — pane / card / sheet / alert / dialog — relates to keyboard-focus-cycling (the trapped Tab-walk over its controls) in exactly one of two ways, and the context **knows which**:

- **Persistent cycling** — the trapped walk **is** the context's base mode. It is pushed when the context opens and never turned off; there is no editor monopolizing Tab, so Tab circulating the controls is simply how the context works. Examples: `PermissionDialog`, `QuestionDialog`, the Model / permission / effort sheets — any surface with **no Tab-owning text surface**.
- **Toggleable cycling** — the context's base mode is **text-first**: a Tab-owning editor rests with the keyboard, and cycling is a mode **pushed on the trigger (⌥⇥)** and **popped back to the editor caret**. Example: the connected dev card.

**The discriminator is a single question: does the context contain a Tab-owning surface?** A *Tab-owning surface* is a **multi-line editor** (the CodeMirror prompt / code editor) where Tab means indent / completion. A **single-line** text input (a path field, a search box, a rename field) does **not** own Tab — Tab should leave it — so its presence does **not** make a context toggleable. No Tab-owner → **persistent**; a Tab-owner → **toggleable** (the editor is the resting home, cycling is the escape hatch).

**The type is a property of (context × state), not of a component — it can flip as the UI evolves.** The dev card is **persistent in its Picker state** (no editor — the picker is a form whose only text field is single-line) and **toggleable in its Connected state** (the prompt editor owns Tab). The type changes at the Picker→Connected transition; a context must re-derive its type as its state changes, and seed/expose the trigger accordingly. (This is the concretized form of "track these states as the UI and user interaction evolve.")

**Rationale:** This is a *classification over a mechanism we already have*, not a new mechanism. Persistent cycling is exactly `useFocusTrap` (push a `{ trapped: true }` mode at open, pop on unmount, no toggle); toggleable cycling is exactly `useCycleMode` (push on ⌥⇥, capture+restore the editor key view, expose a toggle) — `useCycleMode` is `useFocusTrap` + a toggle + key-view capture/restore. Naming the two as one axis (a) gives a decision rule for every new context instead of ad-hoc per-surface keyboard wiring, (b) lets the two hooks converge (toggleable builds on persistent), and (c) **dissolves the deferred a11y question [Q03]**: "always-on cycling" for accessibility is just *making a toggleable context persistent* — drop the toggle, push at mount — same mechanism, no separate feature.

**Implications:**
- Each context **declares or derives** its cycling type (from the discriminator), and the type is **reactive to the context's state** where the state changes the composition (dev card). Persistent contexts push their trapped mode at open (`useFocusTrap`) and never expose ⌥⇥; toggleable contexts rest on the editor and expose ⌥⇥ (`useCycleMode`).
- **The session picker is *persistent*, not toggleable** ([#step-picker-keys]): its only text input is the single-line path field, which does not own Tab. (Reclassifies the earlier tentative read.)
- **Convergence (not required now, enabled):** refactor `useCycleMode` to build on `useFocusTrap` so both express the one mechanism; the a11y mode ([Q03], assessed at [#step-cycle-vet]) becomes "persistent variant of an otherwise-toggleable context."
- **A toggleable context shows the focus language ONLY while cycling** (by-eye, 2026-06-07). When a toggleable context is not cycling (`data-cycling="false"` on its root), the keyboard lives in the editor; its cycle stops must show no ring / behind-tint / cursor, even though the engine may keep a *resting* key view among them (e.g. the dev-card route group seeds the key view on its selected segment). A global CSS rule in `focus-ring.css` suppresses `outline` + `background-image` under `[data-cycling="false"]`. Persistent contexts have no `data-cycling` ancestor, so they always show the language when keyboard-focused. (The editor's own key-view mark is a `::after` border, not an outline, so it is untouched.)
- **Governance:** this axis is enshrined in the focus-language tuglaws doc ([#step-9]) alongside the leaf/group/cycle model; until then this decision is the reference.
- Keep it **lightweight** — a naming + decision rule + hook convergence, **not** a new "focus-context manager." The engine's focus-mode stack already is the manager; this decision only says how each context should use it.

#### [P14] Solid fill is reserved for selection + the live control; a sheet's recommended-default rests at a tint (`primary` emphasis) (DECIDED; refines [P06]) {#p14-primary-emphasis}

**Decision:** A **solid role fill** carries exactly two meanings in the focus language: a **selected** item in a collection (the component's native fill, [P01]), or the **live** keyboard control (which also wears the ring, [P12]). It does **not** mean "this is the recommended default action." A sheet/dialog/alert's recommended-default (commit) button therefore does **not** sit at a resting solid fill. It uses a new **`primary` emphasis** that **rests at the quiet `tinted` wash** — its standing "Return's home" identity — and **promotes to the solid `filled` look + role ring when engaged** (hovered, or holding the key view), riding the same promotion machinery as `outlined` ([P06]).

**Rationale:** In a multi-control surface, an idle `filled+action` default and a `filled` selected list-row render identically (solid blue, no ring), so the default button *impersonates a selected item* — the session-picker "too much blue" observation. The ring already separates the *live* control from everything else; the remaining collision is between *selection* and *default-identity*, both shouting with a full fill. Hue carries **role** (action / danger / accent / …) and must not encode "primary-ness" (a primary-action and a primary-danger button share prominence but differ in role), so prominence is carried on the **emphasis** axis: tint = recommended (quiet), solid = selected-or-live. This keeps one role-hue and resolves the conflation without a new color or a lost affordance (full removal would make the idle default indistinguishable from a plain button).

**Mechanism:** `TugButtonEmphasis` gains `"primary"`; `internal/tug-button.css` authors `primary` (action + danger) as tint-at-rest, filled-on-hover/active, and lists it alongside `outlined` in the keyboard-promoted block (filled + role ring on `[data-key-view-kbd]`). A `primary+action` button still registers as the scope default (Return target) exactly like `filled+action`. Appearance-only, driven by the engine attributes — no React state ([L06]). `filled+action` remains valid for a **standalone CTA with no competing controls** (a lone FAB / submit affordance, e.g. the prompt-entry submit, the jump-to-bottom button), where a resting solid fill is wanted.

**The resting look is the badge treatment, deliberately — ENSHRINED, not incidental.** `primary`'s rest tokens are the `--tug7-…-tinted-…` family, **the same tokens `TugBadge` uses for its `tinted` look** (a faint role-tinted wash behind role-colored text). This is a load-bearing choice, not a coincidence of reuse: a recommended-default *at rest* should read as a **labeled chip / marker** — "here is the thing Return will do" — not as a pressed or selected control. A badge is exactly that: a quiet, labeled, role-colored marker. So the prominence ladder maps onto already-shipped vocabulary the eye knows — **badge (recommended) → solid fill + ring (live) → solid fill (selected)** — and the resting default borrows the badge's "labeled marker" semantics on purpose. Any future retoning of `primary`-at-rest **must keep it within the badge/`tinted` family** (or move both together); `primary` rest and `TugBadge tinted` are intentionally one visual language, and that linkage is the decision, not an implementation detail to drift apart.

**Implications:**
- The **session picker** Open button adopts `primary` now ([#step-primary]); the gallery's Focus-Language demo gains a `primary` row as the by-eye vetting surface.
- **App-wide adoption** of `primary` for every sheet / dialog / alert commit button is folded into **[#step-7]** (surfaces / boxes), the natural home for the surface sweep — not done piecemeal here.
- The selection fill itself (bright list rows) is left as-is — it is honest selection; toning it is a separate later lever once [#step-3]'s cursor-as-ring lands.
- **Governance:** enshrined in the focus-language tuglaws doc ([#step-9]) as part of the prominence hierarchy.

#### [P15] A keyboard value-commit's cycle disposition derives from the [P13] context type; the mode carries it (DECIDED; refines [P13]) {#p15-cycle-commit-disposition}

**Decision:** When a cycle **stop** commits a value via the keyboard (the act dispatch's `select` / `act` on an item-group), the cycle either **retains** (stay cycling) or **relinquishes** (pop the cycle mode, return the keyboard to the resting key view). The disposition is **derived from the [P13] context type** and is a property **carried by the focus mode** itself:

- **Persistent cycling (sheets / dialogs / `useFocusTrap`) → `retain`.** The trap *is* the base mode; there is nowhere to relinquish *to*. Committing a radio / option keeps you navigating the surface.
- **Toggleable cycling (dev card / `useCycleMode`) → `relinquish` on a value commit (`select`/`act`), `retain` on `descend`.** The editor is home; cycling is the escape hatch, so committing a config change ("set the route to Shell") returns the keyboard to the editor. `descend` retains (you went deeper, not done).
- **An optional per-context override** (`useCycleMode({ dispositionAfterCommit })`) refines per-stop / per-commit where a context needs something other than its derived default. Most contexts (incl. the dev card) configure nothing.

**Rationale:** Fixes a concrete desync ([the dev-card sequence]): Opt-Tab → Tab to the route group → arrow → Return committed the route, and the route change returned the caret to the editor through its *own* focus path while the cycle mode stayed pushed — so the engine was still cycling (its capture-phase keydown owned the keys) under a blinking caret, and typing failed. Routing the "return to the editor" through the cycle's own relinquish keeps the engine and DOM in agreement. Deriving the default from the context type (rather than per-consumer wiring) makes the right thing happen with zero config and confines bespoke behavior to an explicit override — the scalable shape over an ad-hoc per-card fix.

**Mechanism:** A focus mode gains an optional `commitDisposition(commit) → "retain" | "relinquish"`, stored at `pushFocusMode` time (the policy rides the mode, so the act dispatch stays policy-agnostic). The act dispatch, after carrying out a `select`/`act`/`descend` on the key view, calls `manager.applyCommitDisposition(kind)`; the manager consults the **top** mode's `commitDisposition` and, on `relinquish`, pops that mode (default restore → the captured editor key view + DOM focus). `useCycleMode` injects the **toggleable default** (and forwards the override); `useFocusTrap` injects nothing → `retain`. So the disposition derives from *which primitive pushed the mode*, i.e. the [P13] type. Leaf acts (chips / Z2 cells that open a popover) go native and never reach this path, so they retain — correct. Modeled on the **route-lifecycle tier** (synchronous, no `MessageChannel` drain) per [lifecycle-delegates.md]; the decision must land in the same flow to pop the mode. No new engine projection ([P04]); the dev card's existing `cycle.cycling`→caret-restore effect (gated on `consumeExitViaPointer`) carries the editor focus once the mode pops.

**Implications:**
- Implemented in [#step-cycle-commit]: `focus-manager` (`commitDisposition` on the mode + `applyCommitDisposition`), the act dispatch chokepoint, `useCycleMode` (default + override option). The dev card configures nothing — it inherits the toggleable default.
- **Governance:** folds into the focus-language tuglaws doc ([#step-9]) alongside the [P13] cycling axis.

#### [P16] An inline dialog is card-modal — inline display, trapped focus (DECIDED — 2026-06-08; refines [P06]; confirms [P13]) {#p16-card-modal}

**Decision:** The inline Permission / Question dialogs keep their **inline display** (rendered in transcript flow, beside the tool call they concern — [D13]) but are **card-modal in focus**: while one is pending it owns the card's keyboard via a trapped focus mode (the existing `useFocusTrap` on the CFRunLoop-style mode stack — [#cycle-model]), and the rest of the card is inert. This rests on a principle: **display locus and focus locus are independent.** Where a surface *renders* (inline, in flow) does not dictate what *owns the keyboard* while it is up. A permission request is a **blocking decision** — the turn is halted, the agent waits, forward progress is gated on the answer — which is the definition of a modal interaction; the focus model should tell that truth even though the surface renders in-flow rather than as an overlay.

**Rationale:**
- Matches the semantics: focus **comes to** the user (seeded on the default, ringed) instead of making them *find* the dialog; Tab cycles the dialog's own controls; Escape cancels and unblocks. The user never has to navigate *to* a blocking decision.
- The card chrome a non-modal "join the walk" model would expose (Model / Effort / submit) is meaningless at that instant — submit is blocked, changing the model mid-request isn't a workflow — so reaching it is a cost with no benefit.
- It is the correct **accessibility** contract: a trap can carry `role="dialog"` / `aria-modal`, which assistive tech reads as "you are in a decision"; a peer-chrome walk cannot.
- **Smallest, safest build, and consistent with the architecture already decided.** The dialogs *already* trap (`useFocusTrap` + `FocusModeScope`); this keeps that machinery and only fixes the *contents* (decompose into archetypes, [P17]) and the *dead-zone* ([P18]). [P13] already classified these as persistent contexts — card-modal **confirms** that (persistent-*trapped*), it does not amend it. (This supersedes the earlier "join the host card's focus walk" proposal, which would have forced the card persistent-cycling, threaded the dialog across a render boundary, and risked leaking the keyboard — all avoided here.)

**Implications:**
- A [P04]-consistent refinement (a focus-model correction, not an engine change): the dialog controls register into the trap's existing mode via `FocusModeContext`, exactly as every sheet / alert / popover does. `useInlineDialogModal` (the single flat item-container shell) is **retired** — its job is replaced by per-control focusables inside the trap.
- Tab cycles **within the dialog** (Deny / Allow / scope group, wrap); Escape / Cmd-. → Deny (the scope's `CANCEL_DIALOG` responder, unchanged); the editor stays deactivated (already wired via `deactivated = inlineDialogPending || cycling`) and is excluded from the walk; the existing resolve → caret-return effect (`prevInlineDialogPendingRef`, `dev-card.tsx`) is unchanged.
- The card content **outside the dialog is scrimmed** while pending ([P19]) so the modality is *felt*, not only enforced by where the keyboard is.
- **Governance:** folds into the focus-language tuglaws doc ([#step-9]) as the inline-vs-overlay rider on [P13] — *inline display does not imply non-modal focus; a blocking in-flow dialog is card-modal.*

#### [P17] PermissionDialog decomposes into focus-language archetypes — leaf buttons + a radio item-group (DECIDED — 2026-06-08; refines [P02]/[P14]) {#p17-dialog-archetypes}

**Decision:** Retire the single flat item-container (`PermissionDialogModal` collects `[Deny, Allow, …scope options]` as **one** cursor list) and model the dialog's controls as their proper archetypes, each registered into the dialog's **trapped** mode ([P16]) via `FocusModeContext`:

- **Deny / Allow are leaf buttons**, each its own focus stop. **Allow** is the recommended default: `emphasis="primary"` (tint-at-rest → fill + ring on engage, [P14]) **plus `persistentDefaultRing`** so it wears the "Return's home" ring the whole time the dialog is open ([#step-7-5]). **Deny** is `emphasis="outlined" role="danger"` — it promotes to filled-danger + danger ring when it holds the key view (a focused Deny claims Return, [P12]).
- **The scope choices (Allow once / Allow for this project / …) are a single radio item-group stop** ([P02]): the group takes the behind-tint, the cursor item the ring, the chosen scope the native radio fill; **selection follows the cursor** (the [#step-7-5] single-select model — arrows move the selected scope, no separate Space step). Tab reaches the group as one stop; arrows rove **within** it without wandering onto the buttons.

**Rationale:**
- The flat container is why **arrows move the highlight off both Deny and Allow** (they keep roving into the heterogeneous option rows) and why there is **no clean way to "descend into" the scope options** (they are not a distinct, enterable group — just more cells in one undifferentiated cursor list). Splitting buttons (leaves) from scopes (a group) gives each its native gesture: Tab between, arrows within the group.
- The Deny/Allow buttons currently render `emphasis="outlined"` (never migrated to [P14] — [#step-2] predates `primary`), so the dialog has **no resting recommended-default affordance**. `primary` + `persistentDefaultRing` on Allow makes Return's destination legible at rest (issue #3).

**Implications:**
- `dev-permission-dialog.tsx`: Deny/Allow become individually-registered leaf focusables; the scope `options` move from `TugInlineDialog`'s flat `options` radio render into an engine-registered radio item-group (reusing the [#step-3] item-group machinery, single-select per [#step-7-5]). `dev-permission-dialog.css` sheds the modal-scope ring rules.
- The scope-group's gesture is a **plain radio choice group** ([Q06], DECIDED): Tab-to-group + arrows-select (selection follows cursor), Return falls through to Allow — no descend level.

#### [P18] Inert dialog chrome establishes no focus state (DECIDED — 2026-06-08) {#p18-no-deadzone}

**Decision:** Clicking the inert region of an inline dialog (the empty space around its controls) must **not** establish any focus state. The full-width transcript-row scope wrapper that today carries `tabIndex={0}` (so the modal-for-keys hook can land DOM focus on it) is removed as a focusable target: a click on dead space neither takes DOM focus nor causes the engine to project `data-key-view` / `data-key-within` onto a transcript-row-sized element.

**Rationale:** The "odd wide focus ring" (issue #4) is the engine marking the full-width `tabIndex=0` wrapper (and/or its container's `data-key-within`) when a click lands on it. It is a meaningless state — a ring around a layout wrapper, not a control. Under [P16]/[P17] the dialog's controls are individually-registered focusables inside the trap, so the wrapper no longer needs to be focusable at all; removing the dead-zone deletes the state at its source rather than papering it with a CSS `outline: none`.

**Implications:** Drop `tabIndex={0}` + the `data-slot="dev-permission-dialog-scope"` focusable role from the wrapper; the `.dev-permission-dialog-scope[data-key-view-kbd]` ring-relocation rules in `dev-permission-dialog.css` go with it. The dialog box's own focus reads come from its real controls. (Under the scrim, [P19], the dialog subtree is the one bright island; a click in the scrimmed surround does nothing.) Verify by app-test: a native click on the dialog's inert chrome leaves zero `data-key-view*` / `data-key-within` marks.

#### [P19] A card-modal dialog scrims the card content outside it (DECIDED — 2026-06-08) {#p19-scrim}

**Decision:** While an inline dialog is pending, the card content **outside the dialog is scrimmed** — a quiet dim/veil over the chrome (Z2 status row, Z4/Z5 toolbar, prompt editor) and the rest of the transcript that visually subordinates everything to the one decision in focus, reinforcing the card-modal nature ([P16]). The pending dialog itself **and the tool-call row it concerns** stay at full strength, so the user can still read what they are deciding about.

**Rationale:**
- Modality should be *felt*, not only enforced by where the keyboard is. An inline dialog has no overlay backdrop to say "everything else is on hold"; the scrim supplies that signal **in-flow**.
- Dimming the surround while keeping the dialog (and its subject) bright draws the eye to the decision and reads as "answer this first," matching the trapped keyboard and the seeded ring.

**Mechanism (appearance-only, [L06]):** a `data-*` signal on the card root keyed on `inlineDialogPending` (derived from store state via `useSyncExternalStore`, [L02]) applies a reduced-opacity / desaturated wash to the card's chrome and non-dialog transcript content via CSS — **no portal, no backdrop element, no React-state appearance.** The dialog (`.dev-permission-dialog` / `.dev-question-dialog`) and the tool-call row it is about opt **out** of the dim. The exact scoping technique is [Q09], settled in [#step-7-6-modal].

**Implications:**
- New CSS in the card / dialog stylesheets; a single derived `data-*` signal on the card root. No engine touch, no new React state ([L06]/[L24]).
- Keep it quiet — a **scrim, not a blackout**; the dialog's subject stays legible (Risk R04).
- **Governance:** folds into the focus-language tuglaws doc ([#step-9]) as part of the card-modal rider.

---

#### [P20] A pending card-modal dialog is its card's active focus destination (DECIDED — 2026-06-08) {#p20-dialog-is-destination}

**Decision:** While a `PermissionDialog` / `QuestionDialog` is pending, the **dialog is the card's active focus destination** — the thing the card's activation-focus path lands on whenever the card gains focus (cold boot, intra-pane tab switch, pane activation, cross-pane move, window blur→focus), *replacing* the resting editor caret for the duration. The card-modal trap is not a one-shot established only on open; it is **re-established every time the card becomes active** while the dialog is pending.

**Rationale:**
- The card-modal contract ([P16]) says a blocking decision owns the keyboard. "Owns the keyboard" must hold across *every* way focus can return to the card, not only the instant the dialog mounts. A trap that survives only until the next card switch is not modal.
- The activation-focus machinery already has a single, principled channel — `bag.focus` resolved through `applyBagFocus` (`focus-transfer.ts`), with the engine branch invoking the card's `paintMirrorAsActive` hook. Today that hook unconditionally refocuses the prompt editor (`tug-prompt-entry.tsx`), with **no awareness of a pending dialog** — the defect. The dialog must participate in that channel rather than bolt on a parallel restore.

**Mechanism (structure-zone, [L22]/[L24]):** [P20] is **delivered by [P21]**, not a separate patch — the card's `FocusContext` already holds a pending dialog's trap as its top mode and the dialog default as its key view, so restoring the context on activation restores the dialog. The one concrete seam [P20] names: the prompt editor's `paintMirrorAsActive` hook (`tug-prompt-entry.tsx`) is **one focusable inside the context, not a parallel focus claimant** — activation restores the context's key view (the dialog, when pending), and the editor's paint-mirror fires only when the context's key view *is* the editor. No new React appearance state; the engine context is the single source of "where focus is."

**Implications:**
- The activation-focus path (`focus-transfer.ts` engine branch → `paintMirrorAsActive`) restores the **engine context's key view**, not unconditionally the editor.
- `useInlineDialogScope`'s seed is owned by the context's restore, not a one-shot `active`-keyed effect.
- **Governance:** folds into the [#step-9] card-modal rider — "card-modal ⇒ the dialog is the card's focus destination until resolved; the editor is subordinate to the context's key view."

---

#### [P21] Per-card focus contexts — the key-window model (DECIDED — 2026-06-08) {#p21-card-scoped-modes}

**Decision:** Focus state is **owned per card**, not pooled deck-global. Each card has a self-contained **`FocusContext`** — its mode stack (cycle / card-modal trap / descend), its key view (id + keyboard-ness), its key-within, and the focusables registered into it. The `FocusManager` is recast as a deck-level **coordinator**: it owns only deck-global state (ring modality, access mode, the document Tab/pointer listeners) plus the **key-card** pointer and the map of `cardId → FocusContext`, and it routes every walk / seed / projection / engine call to the **key card's** context. Switching the key card is an O(1) context swap; an inactive card's context is **untouched**, so its focus universe (a mid-flow cycle, a pending card-modal dialog, a descended scope) is preserved **by construction**.

**Rationale:**
- This is how we *would* design it from scratch, and the system already half-says it: the responder chain has a **key card** (`getKeyCard` / `sendToKeyCard` / key-card chords) — the AppKit **key window**, where each window owns its own responder chain + key-view loop and the app routes input to the key window. The focus mode stack was the lone structure that pooled all cards into one; per-card contexts complete the model the rest of the engine already uses.
- It **retires the cross-card band-aids** the wrong shape forced — the *cross-card* burden of `isRecordRendered` (excluding *other cards'* `display:none` focusables; background cards are simply not in the active context) and `walkModeSet`'s cross-card containment caveat — and rejects outright the "tag the mode with a card and demultiplex the shared stack" scheme (that threads N universes through one structure and un-threads them at read time). **NOT deleted:** the *within-card* filters — `isRecordRendered` still skips hidden subtrees inside the active card (a collapsed accordion section, a conditionally-hidden control), and `isRecordInteractive` still skips disabled / `pointer-events:none` controls. Those are correct within one context and stay.
- The reported "switch away and back loses the scope" bug, the cross-card Tab leak, and the activation-restore gap are **one** defect — focus state in the wrong place — and dissolve together.

**Mechanism (structure-zone, [L22]):**
- Extract a `FocusContext` holding the mode stack + key view + key-within + the default-ring stack + this card's focusable registry, with the walk/seed/project logic operating on *it*. The card id resolves at registration from the existing `CardIdContext` (`@/lib/card-id-context`, already provided by `CardHost`) — the same context-read shape `useFocusable` uses today for `FocusModeContext`, so no new plumbing.
- `FocusManager` keeps deck-global state (ring modality, access mode, the document Tab/pointer listeners) + `keyCardId` + `Map<cardId, FocusContext>`; its public API delegates to `contexts.get(keyCardId)`.
- **One source of truth for "which card is key" — and the data flow inverts.** Today `getKeyCard()` is *focus-derived* (first-responder of kind `card`, falling back to the card holding `[data-key-view-kbd]`). Per-card contexts make the key card **activation-driven**: `keyCardId` (set from the deck's `activeCardId` of the key pane in `onCardActivated`) is THE authority, and focus is *downstream* — set `keyCardId` → project that context's key view → `getKeyCard` reads `keyCardId` (its DOM fallback now finds the just-projected view). The two can never diverge because one feeds the other; they are not independent truths.
- `useFocusable` registers into its **card's** context; `pushFocusMode` / `useCycleMode` / `useFocusTrap` push onto the card's context (card id from `CardIdContext`, which flows through portals so a sheet/dialog opened from a card resolves to that card).
- Card activation (the existing `onCardActivated` / paint-mirror lifecycle) sets `keyCardId` and **projects that context's key view** to the DOM; deactivation clears the projection but leaves the context intact. Only the key card's context projects — and it projects **all three** engine marks (`data-key-view(-kbd)`, `data-key-within`, `data-default-ring`). Keep the existing "clear ALL globally, then stamp" in `syncKeyViewDomAttribute` as a safety net so a stale mark from a just-deactivated context can never linger.

**Implications:**
- Bigger than a patch, by design — but it *removes* code (the cross-card filters) as much as it adds. The audit ([#step-7-7-audit]) gates it with a regression matrix across cycle / sheet / card-modal / descend before adoption.
- Must preserve: `useCycleMode` pop-on-unmount + mouse-exit; `useFocusTrap` pop-on-deactivate + opener key-view restore + pane `inert`; descend ascend-on-Escape.
- Sheets stay *pane*-modal (a pane lays out one card at a time + `inert` on the pane body); a sheet's trap lives in its active card's context, cross-pane isolation stays a DOM concern — the two compose.
- **[L26] null-tolerance:** every hook (`useFocusable` / `useFocusTrap` / `useCycleMode`) must stay a clean no-op when there is no manager AND when there is no resolvable card context (the gallery / standalone-preview path) — the per-card refactor must not assume a `CardIdContext` is always present.
- **Pointer-activation ordering:** a click on a focusable in a non-key card must **activate that card (swap the key context) first, then** set its key view — get the order wrong and the click paints the ring in the outgoing context.
- **Governance:** the governing statement for [#step-9] — "focus state is per-card (the key-window model); the deck coordinator services the key card's context only."

---

#### [P22] Two ring-movement planes — Tab (linear) and arrows (spatial); commit is a separate act (DECIDED — 2026-06-09; GOVERNING for keyboard motion) {#p22-two-planes}

**Decision:** Keyboard focus motion is **two parallel planes over one node set**, plus a separate commit act:
- **Tab / Shift-Tab** move the ring in **linear** (declared `groupOrder`) order — unchanged.
- **Arrow keys** move the ring **spatially** in author-declared order ([P23]) across the **bounded scope** (the key card's active mode — a card, or a sheet / card-modal dialog). Arrows move the ring and **nothing else**: they never commit, never act.
- **Space / Enter** commit / act on the **ringed** thing ([P24]).

Both planes traverse the **same node set** — the current mode's focusables in the key card's `FocusContext` ([P21]), the exact set `walkModeSet` already bounds for Tab. Only the *order* differs (linear `groupOrder` vs declared rings + seams). The spatial plane is therefore **additive**: it reuses the per-card context, the walk's node set, and the engine key view; it adds an ordering and an arrow handler, not a second focus system.

**Rationale:**
- It directly answers the reported friction (Left-arrow should move the ring from `Allow` to `Deny`) without disturbing the structured Tab / Enter / Space contract the rest of the system relies on — additive, not a rewrite.
- "Arrows move the ring, never beep" gives the user a felt sense of freedom and control; making arrows a *pure* ring-mover (never a committer) is what removes the ambiguity that produced the Enter-on-Allow bug.

**Implications:**
- The document-level capture listener that today walks Tab gains an **arrow branch** that consults the declared order ([P23]) and moves the key view — DOM in, ring out, no React state ([L06] / [L22]).
- **The navigator operates over *key views* (the existing registered focusables), NOT over individual group items.** The codebase keeps two distinct concepts the spatial plane must respect: the **key view** (`data-key-view-kbd`, a Tab stop — and a group is *one* focusable, "Tab never lands on an item", `use-item-group-keyboard.ts`) and the **movement cursor** (`data-key-cursor`, *appearance-only*, internal to the group, reuses the hover treatment — `use-focus-cursor.ts`). A selection group is therefore a **single ring node** in the spatial plane: arrows along the group's own axis **delegate to its existing cursor** (`useFocusCursor`), and the group's boundary is a **seam** to the next ring node. This preserves [P02] (container behind-tint + cursor ring) and the `#language-contract` intact. What moves to the navigator is the group's arrow **dispatch** (the document-level arrow branch calls the group's cursor instead of the group owning its own `onKeyDown`); `useFocusCursor` is **kept**, not retired. (Promoting items to first-class ring nodes / key views is the *rejected* alternative — it would break "Tab never lands on an item" and route the appearance cursor through focusable registration; this is the spike's headline question, [#step-7-8-spike].)
- Arrows are spatial **except where a focused component captures them** (editor caret, slider value) — [P25].

---

#### [P23] Spatial arrow order is author-declared, not geometric — named rings + seams (default), per-node neighbors (override) (DECIDED — 2026-06-09) {#p23-declared-order}

**Decision:** The order the arrows follow is **declared at design time per layout**, never derived from on-screen geometry. The default authoring shape is **named ordered rings + seams**: a layout declares one or more ordered sequences (a horizontal ring `[Deny, Allow]`; a vertical ring `[Allow-once, Allow-for-project]`) and the **seams** that connect them (Down from the button ring enters the option ring; Up returns); the navigator maps Left/Right onto horizontal rings and Up/Down onto vertical rings. A **per-node neighbor override** (`up / down / left / right → node`) is the escape hatch for layouts a ring model can't express.

**Rationale:**
- "No guesswork." Declared order makes **"never beeps"** a *total function* by construction (a closed ring always has a next element; a seam always has a target) and makes movement **reversible** by construction (the author writes both edges) — eliminating the nearest-in-direction heuristic and the axis-memory hysteresis that make geometric directional nav famously fragile.
- The cost moves entirely onto **authoring**, which is a cost we can *see and lint for* (R06), versus a geometric heuristic's mis-fires, which read as bugs precisely because the system promised they wouldn't happen.
- (b)-default + (a)-override matches the real distribution: most layouts are "a row and a column with one seam" (near-zero authoring); only gnarly layouts need per-node pins.

**Implications:**
- The per-card `FocusContext` ([P21]) gains the declared **ring/seam table** (structure-zone, [L22]); registration ([Q12]) puts each focusable on a ring at an index, with optional per-node overrides.
- An unfilled slot can never be a **dead arrow** (R06): the navigator falls back to the linear `groupOrder` walk, so the arrow always moves — the authored order shapes the *feel*, the linear walk guarantees *liveliness*.
- Geometry is never read for *ordering*; `getBoundingClientRect` is not consulted by the navigator. (Appearance still reads the DOM; ordering does not.)

---

#### [P24] Selection is explicit again — arrows never select; Space commits the ringed member, Enter is the scope default (DECIDED — 2026-06-09; reverts the 7.7-era selection-follows-cursor) {#p24-explicit-commit}

**Decision:** Moving the ring **never** changes a selection. A selection group's members are ring nodes; arrowing onto one **rings it without selecting it**. Committing is a separate, explicit act:
- **Space** commits / toggles the **ringed** group member.
- **Enter** is the **scope default action** — it always bubbles past the group to the ringed default button ([P12]); a group **never** consumes Enter.
- **Spatial entry into a group lands the ring on the group's *current selection*** (not the first member) and **changes nothing**; further arrows move the ring within the group without committing.

This **reverts the selection-follows-cursor model for mutually-exclusive selection groups** (radio / choice — the `onMove` commit shipped in the 7.7 era): the `deferCommit` prop on `TugRadioGroup` / `TugChoiceGroup` and the conditional `enterPassthrough` flag disappear — "groups never consume Enter" becomes *unconditional*, so the flag that expressed it is no longer a variable.

**Scope of the revert — what is NOT reverted:**
- **`TugTabBar` keeps live commit.** A tab bar is a *view switcher*: arrowing it **should** switch the view live ([P08]; `tug-tab-bar.tsx` uses `commit: "live"` + `onMove`, the canonical live consumer). The `commit: "live" | "deferred"` flag and `onMove` are **retained** for the tab bar; only the radio/choice *selection-follows-cursor usage* is removed. Do **not** delete the live-commit machinery wholesale (that would regress [P08] and at0119 / at0030).
- **Single-select list pickers ([#step-7-5] / `TugListView singleSelect`) are a spike decision, not an automatic revert.** Step 7.5 deliberately made the model / effort / permission / session pickers select-on-arrow with a default button. The user's directive named radio / choice / option — *not* list pickers. Whether a single-select picker also becomes ring-then-Space (consistent) or keeps select-on-arrow (its 7.5 feel) is decided in [#step-7-8-spike], not assumed here.

**Rationale:**
- It is the clean resolution of the spatial-vs-selection tension: if arrival selected, arrowing *through* a group to reach something beyond it would mutate the answer as a side effect; landing-on-current-without-mutating removes that hazard while keeping entry meaningful (the ring lands where the answer already is).
- It permanently fixes the Enter-on-Allow bug by *construction* — Enter is never a group's to consume — rather than by a per-dialog flag.
- Net simplification for radio / choice: the `deferCommit` + conditional-`enterPassthrough` pair collapses to one unconditional rule (Enter always bubbles; Space commits the ringed member). The live-commit path stays available for the genuine view-switcher case (the tab bar).

**Implications:**
- `resolveFocusAct`: for the **selection-group** case, arrows in an item container resolve to **move** (ring), never to a committing "select"; Space → **select** (commit the ringed member); Enter in an item container → **passthrough** (scope default), unconditionally. (The live-commit view-switcher path — tab bar — still commits as the cursor moves; that is `commit: "live"`, orthogonal to the act-tier resolution.)
- `TugRadioGroup` / `TugChoiceGroup` shed `deferCommit` and the conditional `enterPassthrough`; `TugOptionGroup` keeps Space-toggle (arrows ring, Space toggles). **`use-item-group-keyboard.ts` keeps its `onMove` / `commit: "live"` path** — it is what the tab bar needs ([P08]); radio / choice simply stop *using* it.
- `TugListView` keeps `singleSelect`'s *selection-model* meaning; whether its single-select picker reverts to ring-then-Space or keeps select-on-arrow is the [#step-7-8-spike] decision (above), not assumed.
- at0117 / at0118 / at0145 are rewritten from select-on-arrow to ring-on-arrow + explicit Space-commit (R07). The tab-bar tests (at0119 / at0030) must **stay green unchanged** — the guard that the revert did not over-reach.
- The in-group commit-key nuance (Space-only vs Space+Enter) is [Q10].

---

#### [P25] Arrow ownership & escape — capturing components suspend the spatial plane; Tab / Escape return to it (DECIDED — 2026-06-09; Opt-Tab rejected per [Q11]) {#p25-arrow-ownership}

**Decision:** A component that needs arrows for its own content **captures** them (via the existing `captureSet`, the act resolver — or, for a text-editing host, the navigator yields to any focused contentEditable / input / textarea), which **suspends** the spatial plane while it holds focus; the user returns to spatial / cycling navigation with **Tab** (for components that don't consume Tab) or **Escape** (ascend, for a descended editor that consumes Tab). **Opt-Tab is rejected** — `⌥⇥` is the cycle-mode toggle (`CYCLE_FOCUS_MODE`), so it cannot also be an eject ([Q11], R02). The ownership classes are fixed by [#seam-arrow-matrix]:
- **Leaf** (button, link, toggle, checkbox): no capture — full spatial participant; Space / Enter acts.
- **Selection group** (radio / choice / option / list): *soft* owner — shapes the declared ring order ([P23]) but does **not** trap arrows; arrows flow out at the declared boundary, Tab jumps the whole group as one linear unit.
- **Value control** (slider / stepper): captures the **value axis** (Left/Right) via `captureSet`; the cross axis (Up/Down) leaves spatially, or Tab.
- **Text editor** (single-line: captures the four arrows for the caret — the navigator yields to any focused editing host — Tab not captured → Tab leaves; multi-line / code: captures arrows **and** Tab → Escape (ascend) leaves).
- **Container scope** (box-scope / card / dialog): not an arrow owner; Escape ascends / cancels.

**Rationale:**
- The honest promise is "arrows move the ring **except where a focused component captures them**" — there is no truly universal arrow, and pretending otherwise would steal arrows from editors and sliders that legitimately need them.
- Capture already exists (`captureSet`) and already takes precedence in the resolver, so this is wiring + a documented matrix, not a new mechanism.

**Implications:**
- The escape chords are **Tab** (any non-Tab-consuming component) and **Escape** (ascend, for a Tab-consuming descended editor) — no new chord. Opt-Tab is out ([Q11]: `⌥⇥` is the cycle toggle; R02 confirmed real in the spike).
- A new arrow-needing component must opt into `captureSet` (or be a text-editing host, which the navigator yields to automatically); one that forgets has its arrows taken by the spatial plane *only in a declared-order scope* — a documented authoring requirement, surfaced by the same dev-time check as R06.

---

### Deep Dives {#deep-dives}

#### Keyboard-focus-cycling model {#cycle-model}

A text-first card has one irreducible conflict: the **editor wants Tab** (completion / indent, `at0104`) and the **chrome wants Tab** (reach the [D97] `Z`-zones). One Tab can't mean both. The resolution is a **mode** ([P09]):

- **Typing** (resting, after connection): caret in the editor; Tab = completion. The chrome is reachable only by dedicated chords (routes ⇧⌘C / ⇧⌘S, permission ⇧⌘P, Z2 Cmd-1…N).
- **Cycling** (trigger-toggled): the editor's typing is suspended; **Tab circulates the zones, arrows rove within a zone.**

**Mapping to engine primitives (no new projection — the [P09] carve-out reuses the existing stack):**

- the trigger **pushes a trapped per-card focus mode** (`pushFocusMode`) and **seeds the key view at the commit-home** (`focusFirstInMode` → Z5 submit);
- Tab walks the mode's focusables (the registered `Z`-zones); each zone is a **leaf** (Z5) or an **item-group** (Z2 / Z4) — so the focus-language's [P02] leaf-vs-group visuals render the tour for free;
- the trigger (or Return dropping into a text stop) **pops the mode** (`popFocusMode`), restoring the editor caret (the captured prior key view). Escape is deferred ([P11]).

**Comprehensive rule — the mouse exits toggleable cycling (DECIDED 2026-06-06).** Cycling is a *keyboard* mode; the moment the user reaches for the pointer they have left keyboard navigation. So a `pointerdown` while a toggleable cycle is the **current (top)** mode pops it (`useCycleMode` installs a capture-phase document listener; it exits only when the cycle is top, so a pointerdown inside a nested surface opened from a cycle stop does NOT exit — that surface's close returns to the originating stop). Consequences: clicking the editor ends the cycle and drops the caret in; clicking a Z4B chip / Z2 cell ends the cycle and opens its surface *by mouse*, so closing that surface restores the **editor caret** (no keyboard key view to return to). Clicking a control while NOT cycling is unchanged.

**Close-focus ownership — the engine is the single writer (DECIDED 2026-06-06).** A surface (popover / sheet) opened **from a keyboard key view** (a cycle stop) returns close-focus to that stop: `popFocusMode` restores the captured key view *and its keyboard-ness* (the ring) and moves DOM focus to it (`focusKeyView`); the surface's own restorer (`useServicePopupBinding` for popovers, `handleUnmountAutoFocus` for sheets) **defers** — decided once at open via `keyViewIsKeyboard()`. A mouse-opened surface (no keyboard key view) keeps the existing responder/trigger restore. `getKeyCard` falls back to the keyboard focus's card so key-card chords (⌥⇥, ⇧⌘P) resolve even when focus is on a focus-refusing stop. `popFocusMode` always notifies (a mode pop changes `isFocusModePushed`, which a card's `cycling` flag observes, independent of the key view).

**Cycle order ([P10]):** seed Z5; forward Tab wraps to the top and reads top→bottom (Z2 → Z4 → Z5 → wrap), Shift+Tab reverses; trapped within the card; Z1 transcript excluded (first cut).

**Why this is the focus language's home:** one Tab tour of the dev card exercises every archetype in the matrix — leaf ring on submit; group tint + cursor ring on the status bar and route; role colors (submit = action / danger, permission = agent). Cycling is simultaneously the feature and the end-to-end vetting surface.

**a11y ([Q03]):** "always-on cycling" is just "the cycle scope is the base mode" — design the mechanism so the toggle can be removed without restructuring, so the a11y mode falls out. Assessed at [#step-cycle-vet].

---

#### Spatial arrow-navigation model {#spatial-nav-model}

The keyboard moves the focus ring two ways over the **same** node set — the key card's active-mode focusables ([P21], the set `walkModeSet` bounds for Tab):

- **Tab / Shift-Tab** — the structured **linear** walk (declared `groupOrder`), unchanged.
- **Arrow keys** — a parallel **spatial** plane ([P22]): an *ergonomic* way to move the ring "in the direction you see," bounded to the card or sheet / dialog, that **always moves the ring and never beeps**.

**Why declared, not geometric ([P23]).** True 2D nearest-in-direction is heuristic and famously non-reversible without axis-memory, and "always matches what the user sees" is impossible to honor in rich layouts (a transcript with interleaved tool cards has no well-defined "left of this"). Declaring the order per layout makes the navigator a pure lookup: "never beeps" is guaranteed by the linear-order liveliness fallback (an arrow with no spatial target walks `groupOrder` — R06), reversibility is written by the author, and the worst failure mode is a *surprising* fallback target (never a dead arrow — the ring always moves) rather than a heuristic mis-fire that reads as a bug. The simple dialog case (the motivating one) is near-zero authoring; the cost scales with layout complexity, where explicit control is exactly what you want.

**The model in one example (the PermissionDialog).** One horizontal ring `[Deny, Allow]`, one vertical ring `[Allow-once, Allow-for-project]`, one seam joining them (Down from the button ring → the option ring; Up returns). Left/Right move within the button ring; Up/Down move within the option ring; the seam carries the ring between them. Left-arrow from `Allow` → `Deny` — the reported expectation, satisfied by declaration.

**Composition with the engine.** The spatial plane adds an **ordering and an arrow handler**, not a second focus system:
- node set = the key card's active-mode focusables ([P21]) — already computed for the Tab walk;
- order = the declared ring / seam table on the `FocusContext` ([P23] / [Q12]) — additive to `groupOrder`;
- movement = set the engine key view to the resolved target and project the ring ([L22]); no React state ([L06]);
- selection is **not** touched by movement ([P24]); Space commits the ringed node, Enter is the scope default.

**Seam — arrows are already owned in several places.** Arrows mean caret in an editor, value in a slider, and (today) cursor in a group. The spatial plane **yields** to any component that captures them; the user returns to spatial / cycling nav with Tab or Escape. The fixed matrix ([P25]): {#seam-arrow-matrix}

| Context | Arrows do | Captures arrows? | Resume spatial / cycling nav via | Commit / act |
|---|---|---|---|---|
| **Leaf** (button, link, toggle, checkbox) | nothing — full spatial participant | No | n/a (arrows already spatial) | Space / Enter acts |
| **Selection group** (radio, choice, option, list) | move ring among members, per declared order | *Soft* — shapes order, never traps | arrows flow out at declared boundary; Tab jumps the group as one unit | **Space** commits ringed member; **Enter** = scope default |
| **Value control** (slider, stepper) | primary axis (L/R) changes value | Primary axis **only** (`captureSet`) | cross-axis arrow (Up/Down) leaves; or Tab | value is live; Enter = scope default |
| **Single-line text entry** (prompt) | move caret | All 4 arrows (editing-host yield); **Tab not captured** | **Tab / Shift-Tab** (arrows spatial on the next node) | Enter submits (component policy) |
| **Multi-line / code editor** | caret; Tab may indent | All 4 arrows **and** Tab | **Escape** (ascend) — plain Tab is consumed | component policy |
| **Container scope** (box-scope, card, dialog) | delegates to members | No | **Escape** ascends / cancels | — |

The rule the matrix encodes: **plain Tab leaves any component that doesn't itself eat Tab; Escape (ascend) is the eject for a Tab-consuming descended editor.** Opt-Tab is NOT used — `⌥⇥` is the cycle toggle ([Q11], R02). A focused text-editing host (contentEditable / input / textarea) keeps its arrows automatically (the navigator yields); a value control declares its captured axis via `captureSet`.

**Bounding and the app shell.** The bounded scope is the active `FocusContext`'s current mode — a card, or a sheet / card-modal dialog (the trap mode bounds the dialog). This is the same boundary [P21] already draws. Persistent app-chrome stops (a title bar, a global toolbar) are the same open question Step 8 flags ([#step-8], "decide the app-level context"): the spatial plane inherits that decision — such stops need an app / shell context, not a per-card one, or arrows won't reach them after a card switch.

---

### Specification {#specification}

#### The focus-language contract {#language-contract}

For any focusable, given the engine attributes:

- `[data-key-view-kbd]` on a **leaf** → ring (role color) + faint behind-tint (role color) on the component.
- `[data-key-view-kbd]` on an **item-group container** → faint behind-tint (role color) on the container.
- `[data-key-cursor]` on an **item** → ring (role color) on the item, offset so it survives atop a fill.
- `data-selected` (or the component's native checked/active state) → the component's **native fill** in the role color.
- `[data-key-within]` on a container → the quiet "contains active" mark (unchanged in meaning; restyled to the new tint family).
- Role resolves from the role axis, default `action` ([P03]); buttons additionally promote to filled ([P06]).

#### Token surface (target) {#token-surface}

Replaces the orange axis. Exact names settle in [Q01]; shape:

- `--tugx-focus-ring` (role-resolved ring color; default `action`), `--tugx-focus-ring-width/offset/radius` (geometry, kept).
- `--tugx-focus-tint` (role-resolved faint behind-tint).
- `--tugx-focus-fill` (role-resolved native-selection fill) + `--tugx-focus-fill-on` (light glyph/text on fill).
- `--tugx-key-within-*` (restyled to the tint family).
- Role override rules mapping a role to the `--tug7-...-filled-{role}-*` family.

#### State Zone Mapping (tugdeck/tugways) {#state-zone-mapping}

| State | Zone | Mechanism | Law |
|-------|------|-----------|-----|
| focus ring / behind-tint (focused component) | appearance | CSS keyed on `[data-key-view-kbd]` reading the role token | [L06] |
| cursor ring (current item) | appearance | CSS keyed on `[data-key-cursor]` reading the role token | [L06] |
| `data-key-within` mark | appearance | CSS keyed on `[data-key-within]` (engine-projected) | [L06] |
| committed selection fill | appearance (from committed data) | `data-selected` / native checked-active state → CSS | [L06] |
| role (per component) | config | prop / validation class → role token; default `action` | [L06], [L24] |
| (engine: key view, cursor, scope stack) | structure | **unchanged** — FocusManager owns it | [L22] |
| cycling-mode active (per card, [P09]) | structure | engine focus-mode push/pop (`pushFocusMode` / `popFocusMode`); no React state | [L22], [L06] |
| cycle stop registration (the Z-zones, [P10]) | structure | `focusGroup` into the card's cycle scope; one leaf/item-group per zone | [L22], [L03] |

No new store-backed state; no `useState` for appearance ([L06]).

---

### Compatibility / Migration / Rollout {#rollout}

- **Migration shape:** [#step-1] re-points the global `[data-key-view-kbd]` rule, shifting the whole app at once (R01 mitigation); per-component steps then layer the behind-tint + native-fill + cursor-ring refinements. No flag/gate — it is a visual replacement, reversible by git.
- **Who is impacted:** every keyboard-focusable surface app-wide. Mouse interaction is unchanged (focus marks show on keyboard focus only, per the engine's `-kbd` attribute).
- **Rollback:** per-step git revert; the engine is untouched so reverts are pure CSS.

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tuglaws/focus-language.md` | The documented focus-language law + governing decision ([#step-9]) |
| `use-cycle-mode.ts` (or similar; name settled in impl) | The reusable keyboard-focus-cycling hook a text-first card opts into — push/seed/pop a trapped cycle scope ([#step-cycle-mechanism]) |

#### Files to modify {#files-modified}

| File | Change |
|------|--------|
| `styles/focus-ring.css` | Re-point the global rule; define the role-resolved focus token surface ([#step-1]) |
| `styles/themes/brio.css`, `styles/themes/harmony.css` | Focus token values per theme; keep the spike's retuned filled intensities ([#step-1]) |
| `internal/tug-button.css` | Keyboard-promoted (filled-role) state ([#step-2]) |
| `tug-radio-group.css`, `tug-choice-group.css`, `tug-option-group.css` | Group tint + cursor ring + native fill, role-aware ([#step-3]) |
| `tug-slider.css`, `tug-tab-bar.css` | Slider ring/thumb; tab bar commit-on-act + segmented treatment ([#step-4]) |
| `tug-list-view.css`, `tug-list-row.css` (+ accordion) | Row cursor ring + native fill + within mark ([#step-5]) |
| `tug-checkbox.css`, `tug-switch.css`, `tug-input.css`, `tug-textarea.css`, `tug-value-input.css` | Whole-component ring + tint + native fill; input validation→role ([#step-6]) |
| `tug-popover/sheet/alert` + inline-dialog shell CSS | Box ring + within ([#step-7]) |
| `tug-link.css` + app-chrome focus CSS | Link + app-wide focusables ([#step-8]) |
| `dev-permission-dialog.css`, `dev-question-dialog.css` | Shrink to layout; consume the shared button state ([#step-2]) |
| `keybinding-map.ts` + `action-vocabulary.ts` | The cycle-toggle trigger chord + action ([#step-cycle-trigger-spike], [#step-cycle-keys]) |
| `cards/dev-card.tsx`, `tug-prompt-entry.tsx` | Register the dev-card Z-zones as cycle stops; per-state default focus + transition migration; Z2 Cmd-1…N chords ([#step-cycle-devcard], [#step-cycle-keys]) |
| `tugplan-keyboard-model.md` (matrix) | Visual-column annotation ([#step-9]) |
| `gallery-focus-language.{tsx,css}` | Repoint at real tokens / decide fate ([#step-10]) |

---

### Documentation Plan {#documentation-plan}

- [ ] Author `tuglaws/focus-language.md` (the language + the governing decision) ([#step-9]).
- [ ] Annotate the keyboard-model [Keyboard Behavior Matrix](tugplan-keyboard-model.md#keyboard-matrix) visual column to the new signature ([#step-9]).
- [ ] No one-off `docs/*.md` — laws live in `tuglaws/`.

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When |
|----------|---------|------|
| **Behavior regression** (`just app-test`) | Prove nothing behavioral moved — the existing keyboard scenarios still pass | Every step ([P04]) |
| **Pure logic** (`bun:test`) | Only if a role→token resolver has branching worth unit-testing | [#step-1] if applicable |
| **By-eye gallery review** | The appearance proof — focus signature per component, both themes, keyboard vs mouse | Every component step |
| **Live-build pass** | Surfaces/app-chrome focus that the gallery can't host | [#step-7], [#step-8] |

#### What stays out of tests {#test-non-goals}

- **No pixel-snapshot / fake-DOM render tests** — appearance is reviewed by eye in the gallery; the project bans fake-DOM/RTL and pixel assertions. A focus *color* is not a unit test.
- **No mock-store tests.** The engine is untouched; there is nothing new to assert at the store layer.

---

### Execution Steps {#execution-steps}

> Each step commits on completion after its checkpoint passes. Behavior app-tests + `tsc` are the hard gates; the by-eye gallery check (both themes) is the appearance gate.

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Token foundation + re-point the global focus rule | done | 950337d5 (+ ring-scope fix d1dbaf12) |
| #step-gallery | Gallery rename + enrichment policy (ring-scope bug fixed) | done | d1dbaf12 + rename |
| #step-2 | TugPushButton keyboard-promoted state; unify inline dialogs | done | (dash focus-button) |
| #step-cycle | Step 2.5 — Keyboard-focus-cycling mode (umbrella) | pending | — |
| #step-cycle-trigger-spike | Step 2.5.1 — Trigger spike: confirm the chord reaches the webview | done | 62228934 |
| #step-cycle-mechanism | Step 2.5.2 — Cycle-mode scope primitive (push/seed/pop) | done | (main) |
| #step-cycle-devcard | Step 2.5.3 — Dev card joins the cycle; per-state default focus | done ([P10]r): route-seed + blur + no outer ring `6a27148f`; editor text-stop `bd9e44b0`; Z2 carved to #step-z2-cycle | — |
| #step-cycle-keys | Step 2.5.4 — Mode keys + Z2 dedicated chords | punted (2026-06-06): cycling covers status-bar access — no dedicated Z2 chords needed; remaining mode-key polish deferred | — |
| #step-cycle-vet | Step 2.5.5 — Integration checkpoint + a11y assessment | punted (2026-06-06): no ceremonial checkpoint; a11y assessment deferred to the a11y follow-on | — |
| #step-picker-keys | Step 2.6 — Session-picker keyboard navigation (persistent cycling, [P13]) | done: picker controls authored into the sheet's trapped mode (one group, orders 0–5); `TugFileChooser` standard `focusGroup`/`consumesTab` opt-in; bespoke arrow model retired; `armKeyboardRestore` seed; at0141 + nativeKey regression + by-eye green | f6350aae |
| #step-z2-components | Step 2.7 — Componentize the Z2 status cells (prereq for Z2 cycling) | done: `TugStatusCell` extraction (devised in `tugplan-z2-status-cell.md`) | afd978c7 |
| #step-z2-cycle | Step 2.8 — Z2 status cells join the cycle (was Slice 3) | done: five Z2 cells = leaf stops (orders 5…9; rove reversed by-eye); square editor border; engine = single owner of close-focus (popovers+sheets defer; `getKeyCard` fallback; `popFocusMode` always notifies); **mouse exits cycling** ([#cycle-model]); at0140 cells + popover-escape + mouse-exit | d1c2296a + 6f579eae |
| #step-primary | Prominence hierarchy — `primary` emphasis (tint-at-rest → fill-on-engage); session picker adopts it ([P14]) | pending | — |
| #step-cycle-commit | Cycle commit disposition — value-commit relinquishes a toggleable cycle (derived from [P13], mode-carried); fixes the dev-card route-commit desync ([P15]) | done: `commitDisposition` on the mode + `applyCommitDisposition`; act-dispatch wired; `useCycleMode` toggleable default + override; at0140 relinquish test green, picker retain regression green | (uncommitted) |
| #step-3 | Item-groups — radio / choice / option | done: container behind-tint (no container ring) + cursor-item ring + native role fill; `buildRoleStyle` role-resolved focus marks; route-group double-ring resolved; at0117/at0118/at0119/at0030 reworked to the [P02] contract + green | (uncommitted) |
| #step-4 | Live / continuous — slider; tab bar (→ commit-on-act) | done | uncommitted (pending /tugplug:commit) |
| #step-5 | Descendable rows — list view / row, accordion | done (final by-eye model): list + accordion container **perimeter ring** (picker hosts ring own border via `:has`) + cursor-row **reduced tint fill** (25% of the quiet selection blue, no ring/chevron, shares the selection's rounded bounds) + leading row gutter; selection = toned-back role-blue quiet fill covering its dividers ([P14]); `[data-key-within]` on descend; at0120/at0121 reworked to the perimeter-ring contract, at0110 re-pinned to the blue role color; at0127/at0122/at0141 green | b465e107 |
| #step-6 | Leaf controls — checkbox, switch, input (validation→role), textarea, value-input | done: toggles ring the whole component (glyph+label wrapper) + behind-tint, native "on" fill role-aware; fields keep the global leaf ring + a role-derived behind-tint wash on keyboard focus; input/textarea `validation` repoints `--tugx-focus-ring` so the ring/tint/border resolve danger/success/caution and the border holds through focus ([P07]); gallery focus-walk toggles relabelled so the wrapper ring is exercised; at0113/at0114 reworked to the wrapper-ring contract + green; field behavior tests (at0137/at0131/at0128) green | (uncommitted) |
| #step-7 | Surfaces / boxes — popover, sheet, alert, inline dialogs (+ option rows), menus audit | done: box-scope ring/within = layout-free box-shadow layered over the drop shadow (popover/sheet/alert), behind-tint on popover+alert only; `primary` adopted on every action-role sheet/dialog/alert commit (completeness gate met — survivors are excluded CTAs), shared confirms resolve action→primary / danger→filled per [P14]; inline-dialog option rows → global cursor ring (role-resolved in tug-dialog-button.css), bespoke border-recolor retired; menus audit = no change (Radix `data-highlighted`, never `data-key-cursor`); surface/dialog/menu app-tests green (at0040/at0088/at0096 pre-existing flakes) | (uncommitted) |
| #step-7-5 | Default-action ring + single-select list keyboard model | done: `persistentDefaultRing` button API + `/rename` migration + `:has`-rule undo; engine `singleSelect` Enter-passthrough (focus-act); `TugListView` `singleSelect` + `initialSelectedIndex` + `seedSelection` (arrows move+select, seed list, Enter→default); applied to effort/model/permission-mode/rewind pickers + session picker (recents/sessions singleSelect, Open persistentDefaultRing, no seedSelection so focus-gain never clobbers a typed path); new at0142 single-select keyboard app-test green; at0097/at0090/at0094/at0105/at0106/at0141 + item-container focus tests green (at0088/at0096 pre-existing chip failures, unrelated) | (uncommitted) |
| #step-7-6 | Step 7.6 — Inline-dialog card-modal focus & keyboard model (umbrella) | done (dash focus-card-modal): Permission + Question dialogs card-modal; archetypes, scrim, dead-zone removed; [Q06]/[Q08]/[Q09] decided, [Q07]/R03 obviated | — |
| #step-7-6-repro | Step 7.6.1 — Repro the four PermissionDialog defects; lock [P16]–[P19], resolve [Q06] | done (folded into at0145 target test; dash focus-card-modal) | — |
| #step-7-6-archetypes | Step 7.6.2 — PermissionDialog controls → archetypes inside the trap (Allow primary+ring, Deny danger, scope radio group) | done (dash focus-card-modal) | — |
| #step-7-6-modal | Step 7.6.3 — Card-modal polish: kill the wide-ring dead-zone; scrim the card content; verify the trap | done: at0145 green; [Q09]=(a) `:has()` dim with the dialog row bright (dash focus-card-modal) | — |
| #step-7-6-question | Step 7.6.4 — QuestionDialog adopts the model | done: Cancel/Submit/Back/Next leaf stops + per-question options item-group (deferred); re-seed follows auto-advance; useInlineDialogModal deleted; at0146 green (dash focus-card-modal) | — |
| #step-7-6-vet | Step 7.6.5 — Integration checkpoint + tuglaws note | done: tsc + 3396 pure-logic green; app-test sweep green (at0084/at0097/at0106/at0117-120/at0140/at0144/at0145/at0146); inline-vs-overlay rider noted for [#step-9] (dash focus-card-modal) | — |
| #step-7-7 | Step 7.7 — Focus-scope audit + per-card focus contexts (umbrella) | pending | — |
| #step-7-7-audit | Step 7.7.1 — Feature-driven focus-scope audit report (enumerate + verdict + regression matrix) | done | dash focus-cardscope — report + harness-capability finding (C/F boundaries reachable via at0080/at0081/at0125/at0035) |
| #step-7-7-cardscope | Step 7.7.2 — Per-card focus contexts (the key-window model); delivers [P20] + the reported-bug fix ([P21]) | done | dash focus-cardscope — FocusContext per card + deck coordinator; keyCard driven by the deck store's focused card; [P20] via adoptKeyCard; cross-card filters retired; focus-walk +6 cases; at0148 (frontmost) |
| #step-7-7-vet | Step 7.7.3 — Integration checkpoint: full regression matrix green | checkpoint — green here (tsc; bun test 3403; RPC app-tests at0030/at0037/at0026; at0148 on-open); native-keyboard suite + app-switch round-trip + by-eye both themes pending a frontmost session (OS window-key gate); see Checkpoint results | — |
| #step-7-8 | Step 7.8 — Spatial arrow navigation + explicit-commit model (umbrella) | done (joined to main 2026-06-09, `8973bd60`): the model (`spatial-order` + `useSpatialOrder` + navigator) + explicit commit + arrow ownership + the PermissionDialog (Left→Deny) + the liveliness fallback. Generalization to other surfaces → [#step-7-9] | 8973bd60 |
| #step-7-8-spike | Step 7.8.1 — Spike: lock model + ordering API on the PermissionDialog; resolve [Q10]–[Q12] | done: navigator-over-key-views + cursor-delegation confirmed (no escalation); `spatial-order.ts` resolver + 13-case test graduates; [Q10]→(a) Space-commits, [Q11]→Opt-Tab out (⌥⇥ = CYCLE_FOCUS_MODE; escape = Tab/Escape), [Q12]→per-card `SpatialOrder` table; list pickers keep select-on-arrow | (dash focus-spatial) |
| #step-7-8-commit | Step 7.8.2 — Explicit-commit reversion ([P24]); collapse the selection flag cluster | done: resolver drops `enterPassthrough` (item-container Enter → passthrough unless descendable; descendable-first preserves the editor-stop / accordion / list descend); `deferCommit` + `onMove`/`commit:"live"` removed from radio/choice (route group + QuestionDialog wizard commit on Space now, relinquish via mode disposition); option group + single-select list behaviour preserved by the resolver; tab-bar live-commit machinery untouched; at0117/at0118/at0145 rewritten to ring-on-arrow + Space-commit; tsc + 23 pure-logic green (app-test sweep at build phase) | (dash focus-spatial) |
| #step-7-8-spatial | Step 7.8.3 — The declared spatial navigator ([P22]/[P23]) | done: `FocusContext` gains per-mode `spatialOrders` + live `cursorHandles` + `moveKeyViewSpatial` (override→group-delegate→seam→ring→linear-order liveliness fallback so an arrow never dead-ends — refined from the initial clamp/warn in 7.8.6 per the never-dead-end directive); `arrowNavListener` sits between `focusWalkListener` and `captureListener`, gated by `keyViewCaptures`; group arrow dispatch relocated from `use-item-group-keyboard` to the navigator via `SpatialCursorHandle` (Home/End stay local; `useFocusCursor` kept); new `spatial-nav.test.ts` (10) over the real `FocusManager`; tsc + 262 tugways pure-logic green. NB: no card declares an order yet (7.8.5) so ring/seam is dormant; group roving preserved. **7.8.5 must decide list delegation** — `TugListView` manages its own cursor (no handle), so a declared order including a list needs the list to register a handle or be excluded. | (dash focus-spatial) |
| #step-7-8-capture | Step 7.8.4 — Arrow-ownership matrix + Tab/Escape escape ([P25]) | done: navigator yields arrows to any focused editing host (contentEditable/input/textarea — covers CodeMirror/prompt with no per-editor wiring); `TugSlider` declares `captureSet(["ArrowLeft","ArrowRight"])` (value axis; container "none" leaves Space/Enter native); groups stay soft owners (7.8.3 delegation); Opt-Tab rejected → Tab/Escape (⌥⇥ is the cycle toggle, R02); plan matrix/[P25] reconciled. tsc clean | (dash focus-spatial) |
| #step-7-8-apply | Step 7.8.5 — Author PermissionDialog rings + archetypes; by-eye | done: `useSpatialOrder` declaration hook (the [Q12] surface — nodes by `group:order` key) + navigator id↔key translation (`focusKeyOf`/`idForFocusKey`); PermissionDialog declares its order (closed [Deny,Allow] ring; both buttons' Up/Down seam into the scope group; scope Up→Allow) — the reported Left→Deny; at0145 extended with the spatial + liveliness blocks; list-delegation DECIDED (b) lists own their arrows, excluded from ring/seam tables. QuestionDialog + composed-sheet generalization moved to [#step-7-9]. Joined `8973bd60` | 8973bd60 |
| #step-7-8-vet | Step 7.8.6 — Integration checkpoint | done: automated sweep GREEN — `tsc` clean, 263 tugways pure-logic, 12 app-test files; by-eye accepted (the liveliness fallback fix landed in response). Joined `8973bd60` | 8973bd60 |
| #step-7-9 | Step 7.9 — Generalize the spatial order to QuestionDialog, a sheet, and the dev-card (umbrella) | done (dash focus-generalize): `rowGridOrder` helper + context-derived `useSpatialOrder(order)` + the navigator's disabled-target skip; QuestionDialog, a composed gallery sheet, and the dev-card cycle all carry declared spatial orders; list-as-handle / edge-landing confirmed unneeded, stay deferred; full focus app-test set green. By-eye both themes pending user review | ad63a6a2 049461ce 1150b8ac |
| #step-7-9-question | Step 7.9.1 — QuestionDialog declares its spatial order | done (dash focus-generalize): `rowGridOrder` helper (closed ring per row + vertical seam cycle, dynamic membership) declares the dialog's 3-row order; multi-select list stays Tab-reached (b); engine `nodeInOrder` gate yields liveliness to off-order key views; at0146 2/2 + at0145/at0117-119 green | ad63a6a2 |
| #step-7-9-sheet | Step 7.9.2 — A composed sheet (list + buttons) declares its order | done (dash focus-generalize): context-derived `useSpatialOrder(order)` overload (reads `FocusModeContext`, no-op at base); gallery "Spatial Order" sheet (`SpatialSheetBody`: radio group + Cancel/Save) declares its order via the no-id form; list-bearing sheets stay Tab-reached (b); at0150 green | 049461ce |
| #step-7-9-devcard | Step 7.9.3 — Dev-card spike + apply (2D zone order; list-as-handle / edge-landing decisions) | done (dash focus-generalize): spike [Q13] resolved — 2D order = toolbar ring + Z2 status ring + vertical seam cycle under the cycle scope; editor excluded as the Tab-reached body; list-as-handle & edge-landing NOT needed (all leaf stops), stay deferred; engine skips disabled ring targets onto the next live stop; at0140 3/3 (incl. disabled-skip + editor-not-arrow-stop) | 1150b8ac |
| #step-7-9-vet | Step 7.9.4 — Integration checkpoint | checkpoint — green here: tsc clean; bun test 3431/3431; focus app-test set all green (at0145/at0146/at0150/at0117-120/at0140/at0115/at0116/at0141/at0142/at0030 — 21 tests). By-eye both themes pending user review on the debug build | — |
| #step-8 | Links + app-wide focusables (title bars, toolbars, prompt, dev panel) | pending | — |
| #step-9 | Governance — tuglaws/focus-language.md + matrix rewrite + governing decision | pending | — |
| #step-10 | Integration checkpoint + spike-card fate | pending | — |

#### Step 1: Token foundation + re-point the global focus rule {#step-1}

**Commit:** `focus(lang): role-resolved focus tokens; re-point the global ring`

**References:** [P01], [P02], [P03], [P04], [P05], [Q01], [Q02], Risk R01, (#token-surface, #language-contract, #p02-leaf-vs-group)

**Artifacts:** new focus token surface in `styles/focus-ring.css` + `brio.css`/`harmony.css`; the global `[data-key-view-kbd]` / `[data-key-cursor]` / `[data-key-within]` rules re-pointed.

**Tasks:**
- Define the role-resolved focus tokens ([P05]); resolve [Q01]'s token shape against two real components and [Q02]'s tint-layering technique; keep the spike's retuned filled-accent/danger intensities.
- Re-point the global `[data-key-view-kbd]` rule from the orange axis to the role-axis **ring** (default `action`) — this is the **leaf** treatment; groups override it in their own steps ([P02]).
- **Flip the global `[data-key-cursor]` rule from a background tint to an outline ring** (role-resolved) — the item cursor for every group ([P02]).
- Restyle the `[data-key-within]` mark into the new tint family.
- **Do NOT globalize the behind-tint** — leaf / group / chrome differ, so it is applied per archetype in steps 2–8 ([P02], Risk R01).
- Keep `--tugx-focus-ring-width/offset/radius`; retire `--tugx-focus-ring-color` from the component/chrome focus path (the spike-card legend may keep an explicit orange swatch for contrast — out of the focus path, settled at [#step-10]).

**Tests:**
- Behavior: full `just app-test` keyboard sweep still `VERDICT: PASS` (nothing behavioral moved).
- By-eye: a **leaf** focusable rings in the new default-action language; a **cursor item** in a group now shows a ring (not the old tint); groups still ring their container until [#step-3]+ land (expected, Risk R01); both themes; orange gone from the focus path.

**Checkpoint:** `bunx tsc --noEmit` clean; app-test sweep green; gallery shows the new default ring + cursor ring in brio + harmony.

> **Step 1 follow-up — the ring-scope bug (fixed `d1dbaf12`).** Step 1 originally
> declared the role-axis aliases (`--tugx-focus-ring` / `-tint` / `-fill`) on
> `:root`, but the `--tug7-*` theme tokens are scoped to **`body`**. A
> `var(--tug7-*)` evaluated at `:root` (the `<html>` element, above the theme
> scope) resolves to the *guaranteed-invalid value*, which inherits down and
> collapses every `outline: … var(--tugx-focus-ring)` to `none` — so **the focus
> ring was invisible app-wide** (the "Tabbing does nothing" / "I can't see the
> changes" report). Fix: the three role-axis aliases moved to `body` (geometry
> literals stay on `:root`). Also repointed `tug-slider.css`'s whole-component
> ring from the retired `--tugx-focus-ring-color` to `--tugx-focus-ring` (orphaned
> by Step 1), and updated `at0115` to assert the ring on the slider root (the
> component rings; the thumb stays the key-view target). The whole focus suite was
> red before this fix (Step 1's "green sweep" claim was wrong); 10/10 focus
> app-tests green after. Upholds [L06], [L17] (one-hop alias, now in the right
> scope).

#### Step (gallery): Gallery rename + enrichment policy {#step-gallery}

**Commit:** `focus(gallery): rename Focus Walk → Focus Language; enrichment is per-component`

**References:** [P01], [P02], [P03], [P04], (#success-criteria, #test-categories)

**Depends on:** #step-1

**STATUS — done.** This step was originally scoped as "make the gallery keyboard-drivable
by building a shared trapped `<FocusLanguageSection>`." **That premise was wrong, and the
trap helper was both unnecessary and harmful** — see below. It collapses to a rename + a
policy note; the real fix was the Step 1 ring-scope bug above.

**Why the original premise was wrong.** The diagnosis "regular gallery cards aren't
keyboard-focus surfaces, so Tab does nothing" was a *symptom of the invisible-ring bug*,
not a missing focus scope. Driving the engine directly proved it: the existing `Focus Walk`
sections register their component into the base focus mode via `focusGroup`/`focusOrder`,
and the **base mode already drives the Tab-walk** — click into a card (or its pane title
bar) → Tab → the key view walks into the component and rings. This is exactly what the
existing focus app-tests (`at0118`, `at0119`, `at0125`, `at0112`, …) exercise, and they
pass. Once the ring actually paints (Step 1 fix), the gallery is a perfectly good
keyboard-focus vetting surface as-is.

**Why a trapped `<FocusLanguageSection>` is rejected.** A per-card trap active on mount
would have **broken two passing app-tests**: every mounted card (including hidden
background tab-cards) would push a trapped focus mode, breaking `at0125`'s
background-tab isolation; and seeding `focusFirstInMode` on mount would light the ring at
rest, breaking `at0118`'s "no ring at rest" assertion. The engine already isolates hidden
cards and lands one Tab on the active card's first focusable — no trap needed. **Do not
add one.**

**Done (on `main`, earlier):**
- ✅ Deleted the unintelligible demo cards `gallery-focus-states` + `gallery-focus-nested`, their `gallery-focus.css`, their registrations, and the `at0123`/`at0124` app-tests.
- ✅ De-spiked `gallery-focus-language` into a permanent **"Focus Language"** card — the static OVERVIEW of the whole language (a `--fl-*` mockup; repoint at the real tokens in [#step-10]).

**Done (this step):**
- ✅ **Ring-scope bug fixed** (`d1dbaf12`) — the real cause of the gallery looking broken (see the Step 1 follow-up box above).
- ✅ **Renamed** every card's `Focus Walk` → `Focus Language` (label text + comments + aria-labels) across `gallery-choice-group / -radio-group / -option-group / -checkbox / -switch / -slider / -accordion / -chain-actions`. **Testids kept** (`*-focus-title`, `focus-walk-*`) — they back `at0112/at0118/at0125`; renaming them would break those tests.

**Enrichment policy (folded into the component steps, not a separate step).** The gallery is
the **example + vetting surface for the focus language**, not just look-and-feel. As each
component step ([#step-2]–[#step-8]) lands, it **enriches that component's Focus Language
section** into a real vetting surface:
- show the component's **role variants** (action default + danger/accent/… where the
  component supports roles) so the role-resolved ring/fill/tint are visible side by side;
- where it makes sense, include **multiple components in the section so Tab moves between
  them** (proving the ring travels and the within-mark reads);
- exercise the **complete progression** — rest → keyboard focus (ring + behind-tint) →
  cursor (group → ring on the cursor item) → committed selection (native fill).
No shared trap helper; the base mode drives it. Components without a Focus Language section
yet get one added as their step lands.

**Tests:**
- Behavior: `tsc` clean; the focus app-test sweep green (`at0104/0106/0109/0112/0113/0114/0115/0118/0119/0125` — 10/10 after the ring-scope fix). No banned tests — pixels are by-eye.
- By-eye: open a component card, click in, **Tab** — the real component rings/cursors/selects per the model, both themes.

**Checkpoint:** `bunx tsc --noEmit` clean; focus app-test sweep green; ring visible in brio + harmony; the rename landed with testids preserved; the two demo cards are gone and the **Focus Language** reference card is permanent. **No `<FocusLanguageSection>` helper exists (by design).**

#### Step 2: TugPushButton keyboard-promoted state; unify inline dialogs {#step-2}

**Depends on:** #step-1

**Commit:** `focus(button): first-class keyboard-promoted state; dialogs consume it`

**References:** [P06], [P03], [P01], (#p06-button-promote)

**Artifacts:** keyboard-promoted rules in `internal/tug-button.css`; `dev-permission-dialog.css`/`dev-question-dialog.css` reduced to layout.

**Tasks:**
- Lift the bespoke fill-promotion (focused → filled role + role ring; siblings demoted) into `internal/tug-button.css`, reacting to the engine attributes and the role axis.
- Repoint the inline dialogs onto it; delete their duplicated promotion CSS.

**Tests:**
- Behavior: the inline-dialog keyboard scenarios still `VERDICT: PASS`.
- By-eye: focused Allow/Deny/Save/Delete promote correctly per role, both themes; dialogs match the gallery.

**Checkpoint:** `tsc` clean; dialog app-tests green; dialogs visually unchanged or better.

#### Step 2.5: Keyboard-focus-cycling mode for text-first cards (umbrella) {#step-cycle}

**Depends on:** #step-1, #step-2

**Commit:** `N/A (umbrella — the substeps carry the commits)`

**References:** [P09], [P10], [P11], [P12], [Q05], Risk R02, (#cycle-model, #language-contract)

Umbrella for the cycling-mode feature ([P09]) — the one deliberate **behavior** addition in this plan (the [P04] carve-out). Substeps [#step-cycle-trigger-spike] → [#step-cycle-vet] build the general mechanism (a reusable hook over the engine's focus-mode stack) and wire the dev card as the first consumer. This is what gives the focus language its home on text-first cards: one Tab tour exercises every archetype. Design write-up in the deep dive ([#cycle-model]); the *visuals* it displays come from [#step-1]–[#step-8].

#### Step 2.5.1: Trigger spike — confirm the chord reaches the webview {#step-cycle-trigger-spike}

**STATUS — done.** Opt-Tab (⌥⇥) confirmed reachable + matched ([Q05] DECIDED); the action + binding are wired; `at0138` guards it. The mechanism (the handler) lands in [#step-cycle-mechanism].

**Depends on:** #step-1

**Commit:** `focus(cycle): cycle-toggle trigger chord + action`

**References:** [Q05], [P09], Risk R02, (#cycle-model)

**Artifacts:** `CYCLE_FOCUS_MODE` action in `action-vocabulary.ts`; the ⌥⇥ trigger chord in `keybinding-map.ts`; `at0138-cycle-trigger-chord.test.ts`; [Q05] resolved in this plan.

**Tasks:**
- [x] Spike the candidate chord (Opt-Tab, ⌥⇥) reachability: an app-test that posts a native ⌥⇥ and asserts the document keybinding stage receives + matches it. → **reaches + matches** (not eaten by macOS, unlike ⇧⇥).
- [x] If eaten, take the first reliable non-Tab fallback; record the choice + rationale in [Q05]. → **not eaten; Opt-Tab kept** ([Q05] DECIDED).
- [x] Wire the chosen chord to the `CYCLE_FOCUS_MODE` action (handler deferred to the mechanism step). Also fixed the stale `⇧⇥` comment on `CYCLE_PERMISSION_MODE` (now ⇧⌘P) while in `action-vocabulary.ts`.

**Tests:**
- [x] Behavior: `at0138` posts a native ⌥⇥ and asserts it reaches the document (not OS-eaten) AND `defaultPrevented === true` (the binding matched). `VERDICT: PASS`.

**Checkpoint:**
- [x] `bunx tsc --noEmit` clean.
- [x] the chord is confirmed reachable (`at0138` green).
- [x] [Q05] resolved (Opt-Tab chosen + recorded).

#### Step 2.5.2: Cycle-mode scope primitive (push/seed/pop) {#step-cycle-mechanism}

**STATUS — done.** `useCycleMode` built (general, engine-derived `cycling`, no new projection); proven on a permanent `gallery-cycle-demo` card; `at0139` guards push/seed/wrap/restore. The real consumer (dev card) is [#step-cycle-devcard].

**Depends on:** #step-cycle-trigger-spike

**Commit:** `focus(cycle): per-card cycle focus-scope primitive`

**References:** [P09], [P10], [P11], (#cycle-model, #state-zone-mapping)

**Artifacts:** `use-cycle-mode.tsx` (the hook); `cards/gallery-cycle-demo.tsx` + its registration (the showcase / test surface); `at0139-cycle-mode-scope.test.ts`.

**Tasks:**
- [x] Implement the cycle scope: the toggle pushes a **trapped** per-card focus mode, seeds the key view at the commit-home (the lowest-`focusOrder` stop, via `focusFirstInMode`), and pops on toggle — restoring the captured prior key view (the resting key view / editor caret) ([P10]). `cycling` is **engine-derived** (`useSyncExternalStore` on `currentFocusMode() === scopeId`, [L02]), not a parallel React boolean. `exit` is exposed for [#step-cycle-keys] (the Return-into-text exit).
- [x] Keep it **general**: the hook owns only push/seed/pop + the `CycleScope` wrapper; the consumer supplies the stops (via `focusGroup` inside `CycleScope`) and orders the commit-home first. No dev-card specifics.
- [x] No new engine projection — reuse the focus-mode stack (`pushFocusMode` / `popFocusMode` / `focusFirstInMode` / `focusKeyView`) — the [P04] carve-out via [P09].

**Tests:**
- [x] Behavior: `at0139` — ⌥⇥ seeds the commit-home; Tab wraps home → A → B → home (trapped; the resting control never takes the key view); ⌥⇥ restores the resting key view. `VERDICT: PASS`.

**Checkpoint:**
- [x] `bunx tsc --noEmit` clean.
- [x] the primitive pushes/seeds/pops a trapped cycle scope (`at0139` green).
- [x] no existing app-test regresses (the hook + demo card are additive; the keybinding/focus-walk are untouched).

#### Step 2.5.3: Dev card joins the cycle; per-state default focus {#step-cycle-devcard}

**STATUS — Slices 1 + 2 done (uncommitted on `main`); Slice 3 optional/deferred. RESUME NOTES.**

*Slice 1 — DONE (uncommitted).* The dev card cycles end-to-end: `useCycleMode({ enabled: !sessionErrored })` in `DevCardBody`; `CYCLE_FOCUS_MODE → cycle.toggle()` on the card-content responder; `data-cycling` on the `dev-card` root; the prompt entry wrapped in `cycle.CycleScope`; the **Z5 submit authored as the commit-home** via new neutral `submitFocusGroup`/`submitFocusOrder` props on `TugPromptEntry` (group `dev-prompt-cycle`, order 0); **Connected → editor on exit** via a layout effect on the engine-derived `cycling` snapshot (the editor is a responder, not a key-view, so the card owns the restore — `pushFocusMode`'s `restoreKeyView` is null); the **fill-suppression CSS** (`[data-cycling="true"] .tug-prompt-entry-submit-button.tug-button-filled-{action,danger}:not([data-key-view-kbd]):not([data-key-cursor])` → outlined tokens) in `tug-prompt-entry.css`.

*Slice 2 — DONE (uncommitted).* Z4A route as the second cycle stop: new neutral `routeFocusGroup`/`routeFocusOrder` props on `TugPromptEntry` → the route `TugChoiceGroup` (group `dev-prompt-cycle`, order 1). The route is an **item-group** — one Tab stop, arrows within — and its **root** carries `data-key-view-kbd` when it holds the cycle key view (the arrow cursor `data-key-cursor` rides a child), so the cycle tours submit(0) → route(1) → wrap. **Picker → Open** default focus via a **smart latch** in `DevProjectPickerForm` (user-chosen): on mount/settle, focus Open when it is enabled (a valid path seeded) else the path field; a user edit (`onChange`) claims the field so the latch never yanks focus mid-typing; `autoFocus` removed from `TugFileChooser`, `openButtonRef` added to the Open button. Verified: `bunx tsc --noEmit` clean; **at0140** (submit seed → Tab tour submit→route→wrap → exit restores editor) green; regressions green — at0138/at0139 (cycle primitive), at0088/at0092/at0093/at0099/at0102 (dev/picker incl. default-button pane scope), at0051/at0080/at0081 (dev focus), at0085/at0118 (route/choice-group), at0103/at0104 (submit/tab completion), at0020/at0024/at0025/at0100/at0105/at0106 (roundtrip/sheet/permission-keys). NB: **at0038** (deactivation inactive-paint) fails its two *dev* cases on `getActiveCardId()==="B"` — **pre-existing**, reproduced on a clean baseline build with these changes stashed; unrelated to focus language.

*Post-review fixes (uncommitted).* (1) **Disabled controls are no longer Tab targets** — `FocusManager.walkOrder` now skips a focusable whose element is `:disabled` / `[aria-disabled="true"]` / computed `pointer-events: none` (new `isRecordInteractive`, reading the DOM at walk time like `isRecordRendered`). So the submit drops out of the cycle while the editor is empty (its empty-input gate) and the seed lands on the route instead — **no React state**, the empty-ness stays DOM/appearance state and the structure consumer (the walk) observes it directly ([L06]/[L22]/[L24]; L02 forbids mirroring editor empty-ness into `useState`). at0140 extended to assert empty→submit-skipped and typed→submit-seeded. (2) **Choice-group double-ring** (selected-value ring + cycle group/cursor ring) is a Step 3 cleanup — note added to [#step-3].

*Slice 3 — Z4B chips DONE (uncommitted); Z2 status row still deferred.* The interactive Z4B chips — **Mode** (`PermissionModeChip`), **Model** (`ModelChip`), **Effort** (`EffortChip`) — now take `focusGroup`/`focusOrder` props and join the cycle as **leaf stops** at orders 2 / 3 / 4. Tour: submit(0, seed) → route(1) → Mode(2) → Model(3) → Effort(4) → wrap. They are independent controls, so each is its **own leaf Tab stop** (NOT a single arrow-within item-group — a [P10] refinement: "multi-control zone = item-group" applies to a *semantic* group like the route choice; a cluster of independent controls is a run of leaf stops). On the Shell route the chips are `disabled` and the engine's interactivity filter drops them from the walk for free. The chips are `tinted agent`, so the role-ring axis in `internal/tug-button.css` was extended to cover `tinted` (was filled/outlined only) — a focused chip now rings in its agent role colour. at0140 tours all five stops. The non-interactive Z4B badges (CLAUDE CODE / PROJECT / SESSION) are display-only and intentionally not stops.

> **NOTE — this Slice-3 note predates the 2026-06-06 redesign.** The orders above (submit=0 seed) are SUPERSEDED by [P10] revised: the cycle now seeds the **route** and runs route(0) → Mode(1) → Model(2) → Effort(3) → submit(4) → Z2(5) → editor(6) → wrap. The **Z2 status-row stop has been carved out** into its own steps: [#step-z2-components] (componentize the cells first — the prerequisite) then [#step-z2-cycle] (author the row into the cycle as the order-5 item-group stop). This step (#step-cycle-devcard) is DONE for the route / Z4B / submit / editor stops + the visuals.

*Where we are.* Working **on `main`** (the user commits; I edit + run checkpoints). Done + committed: 2.5.1 trigger chord `62228934`; 2.5.2 mechanism `fad9abc6`; refinements `8d382f2b`. The at0088 fix is `6e2c8a83`; the Step 2.5 authoring is `73b4784c`. Slice 1 above is **uncommitted**.

*Build / test (CRITICAL — from the repo root, one invocation):* `export TUG_FORCE_BUNDLE_ID=dev.tugtool.app.apptest && just build-app && just app-test <files>`. Without the env var the app-test fails the macOS AX preflight (the grant lives on `dev.tugtool.app.apptest`). `bunx tsc --noEmit` from `tugdeck/`. tsc + app-tests are the gates; appearance is by-eye in both themes. Next AT number: **at0140** (the `app-test-inventory.md` is stale at AT0083 — number by filename; do **not** add a lone inventory entry).

*The proven mechanism (reuse it).* `useCycleMode({ enabled })` in `tugdeck/src/components/tugways/use-cycle-mode.tsx` → `{ cycling, toggle, exit, CycleScope, scopeId }`. The trigger is **⌥⇥** = `TUG_ACTIONS.CYCLE_FOCUS_MODE` (in `action-vocabulary.ts`), bound in `keybinding-map.ts` (`{ key: "Tab", alt: true, scope: "key-card", preventDefaultOnMatch: true }`). **Reference wiring** (copy this shape from `cards/gallery-cycle-demo.tsx`): a `card-content` `useResponder` maps `CYCLE_FOCUS_MODE → toggle`; the card root carries `data-cycling={cycling ? "true" : "false"}`; `CycleScope` wraps the cycle-able zones; each cycle stop is a `focusGroup` focusable with the **commit-home at `focusOrder` 0** (what `focusFirstInMode` seeds); `focusNext` wraps top→bottom, Shift+Tab reverses ([P10]).

*Dev-card integration map (the real consumer).*
- **Card-content responder already exists** in `cards/dev-card.tsx` (`useResponder({ id: \`${cardId}-card-content\`, kind: "card-content", actions: {...} })`, the block that holds `FOCUS_PROMPT` / `CYCLE_PERMISSION_MODE` / `RUN_SLASH_COMMAND`). **Add `[TUG_ACTIONS.CYCLE_FOCUS_MODE]: () => cycle.toggle()` there.** Call `useCycleMode({ enabled: <connected> })` in the dev card (enabled only in the **Connected** state, never the Picker).
- **`CycleScope` + `data-cycling`**: wrap the dev card's content root (it must cover BOTH the transcript pane (Z2) and the prompt pane (Z4/Z5)) and put `data-cycling` on it.
- **Z5 submit + Z4A route live in the SHARED `tug-prompt-entry.tsx`** — the toolbar `<div className="tug-prompt-entry-toolbar" data-tug-focus="refuse">` holds `<TugChoiceGroup … aria-label="Route">` (Z4A, **no `focusGroup` today → not registered**) and `<TugPushButton className="tug-prompt-entry-submit-button" action={SUBMIT} emphasis="filled" role={submitView.danger ? "danger" : "action"}>` (Z5). `data-tug-focus="refuse"` is no-steal-on-click only — it does NOT block `focusGroup` registration. **`TugPushButton`/`TugChoiceGroup` register only when given a `focusGroup`** (both gate on `focusGroup !== undefined`).
- **Z4B permission chip** = `cards/permission-mode-chip.tsx` (`TugPushButton` `emphasis="tinted" role="agent"`). **Z2 status bar** = the `Z2` telemetry status row (cells STATE/TIME/TOKENS/TASKS/CONTEXT) in the transcript pane.

*THE key open design question to resolve first (decide in impl):* how do the **shared** prompt-entry's route + submit join the cycle **without coupling the shared component to the cycle concept or polluting the base mode**? Lean: `tug-prompt-entry` accepts **optional `cycleFocusGroup` + order props** (passed only by the dev card); the dev card **wraps the prompt entry (and status row) in `CycleScope`** so those controls register into the **cycle scope** (modes=[scopeId]) via `FocusModeContext`, NOT the base mode — so they are inert during typing and walked only while cycling. Verify whether `tug-prompt-entry` is dev-card-only vs shared (grep its importers) before choosing unconditional vs prop-gated registration. The editor itself is a **responder** (caret), not a `focusGroup` focusable — it is NOT a cycle stop in this step (editor-as-text-stop is the 2.5.4 concern).

*Per-state default focus ([P12]).* **Connected → editor** is already the seed (`tug-prompt-entry` `paintMirrorAsActive`). **Picker → Open**: `DevProjectPicker` currently `autoFocus`es the `TugFileChooser` (Project path) — move the default focus to the **Open** `TugPushButton` (the picker footer `<TugPushButton emphasis="filled" role="action" onClick={submit}>Open</TugPushButton>`). Transition migration: spawn (picker→connected) seeds the editor; end (connected→picker) seeds Open — wire deliberately, don't rely on mount order.

*Fill-suppression CSS ([P12]).* While `[data-cycling="true"]`, relax the submit's standing `filled-action` to outlined so the promoted fill follows focus; the existing `[data-key-view-kbd]`/`[data-key-cursor]` promotion (Step 2, in `internal/tug-button.css`) re-fills the focused stop; on exit `data-cycling` drops → submit reverts. Pure CSS keyed on the card's `data-cycling` ancestor; **no change to the submit button's component/props** (user-confirmed). Roles: submit=action/danger (already), route=action, chip=agent (already).

*Scope advice (big step — land in coherent commits).* Slice 1: mode plumbing on the dev card (`useCycleMode` + `CYCLE_FOCUS_MODE` handler + `data-cycling` + `CycleScope`) + **Z5 submit as the commit-home stop** + Connected→editor restore + the fill-suppression CSS → a real dev-card cycle end-to-end (at0140). Slice 2: Z4A route as the next stop + Picker→Open default + transition migration. Slice 3 (optional / may defer): Z2 status bar as an item-group stop + Z4B chip. Mark each in the ledger.

*Tests.* at0140: Connected dev card (`bindDevSession` like at0088) → ⌥⇥ → cycle on, key view on the submit (Z5) → Tab → route (when added) → ⌥⇥ → off, caret back in editor. Plus the Picker→Open default. By-eye: fill follows focus (suppressed submit), both themes.

**Depends on:** #step-cycle-mechanism

**Commit:** `focus(cycle): dev-card zones + per-state default focus`

**References:** [P10], [P12], [P09], (#cycle-model)

**Artifacts:** dev-card / prompt-entry registration of the Z-zones (Z2 status group, Z4A route, Z4B indicators incl. the permission chip, Z5 submit) as cycle stops; the per-state default-focus declaration + transition migration.

**Tasks:**
- Register the chrome zones as cycle stops — each a leaf or item-group per [P10] (Tab between zones, arrow within); seed at Z5; forward Tab wraps top→bottom, Shift+Tab reverses ([P10]). *(Done: Z5 submit = commit-home (0), Z4A route item-group (1), Z4B Mode/Model/Effort leaf stops (2/3/4) — submit → route → chips → wrap. Deferred: Z2 status cells.)*
- [x] Declare per-state default focus ([P12]): Picker → Open, Connected → editor; migrate focus deliberately on spawn / end transitions. *(Connected → editor via the cycle-exit layout effect; Picker → Open via the smart latch — focus Open when settled enabled, else the field, never interrupting typing.)*
- [x] Apply per-control roles ([P12]): submit = action (danger while stopping), route = action, permission chip = agent. *(submit = action/danger (unchanged), route = action, the Z4B chips = agent; the role-ring axis now covers `tinted` so a focused chip rings agent.)*
- [x] Add the `[data-cycling]` fill-suppression rule ([P12]): while cycling, the submit's standing `filled` is relaxed to outlined so the fill follows focus (one filled+ringed stop at a time); on exit it reverts to its identity fill. Pure CSS on the card's `data-cycling` signal — no change to the submit button's component / props.
- [x] Z1 transcript excluded ([P10]).

**Tests:**
- Behavior: app-tests — Picker seeds Open; Connected seeds the editor; spawn / end migrates focus; the cycle tours Z5 → (top→bottom) → Z5 and wraps.
- By-eye: the cycle tour shows the focus language (ring / tint / role) across zones, both themes.

**Checkpoint:** `bunx tsc --noEmit` clean; default-focus + cycle app-tests green; by-eye tour clean in brio + harmony.

#### Step 2.5.4: Mode keys + Z2 dedicated chords {#step-cycle-keys}

**STATUS — punted (2026-06-06).** With keyboard-focus-cycling in place, the Z2 status-bar cells are reachable and activatable directly in the cycle (Tab to the cell, Space/Enter opens its popover) — so the planned Cmd-1…N dedicated chords add a parallel access path the cycle already provides, and are **dropped**. The core mode-key semantics this step would have added landed early elsewhere: the **Return-into-text exit** shipped with [#step-cycle-devcard], and the **mouse-exits-cycling** rule with [#step-z2-cycle]. The remaining polish (Space-acts on non-text stops, the inert-Return rule on buttons, a gallery text-input demo stop) is **deferred** — not needed for the current dev-card cycle; revisit only if a concrete need surfaces. The tasks below are kept for the record, not as active work.

**Depends on:** #step-cycle-devcard

**Commit:** `focus(cycle): mode keys + Z2 popup chords`

**References:** [P11], [P12], (#cycle-model)

**Artifacts:** the cycle scope's key handling (Return text-entry-only; Space acts; trigger exit); Cmd-1…N popup-toggle chords for the Z2 status-bar cells. A text-input cycle stop in `gallery-cycle-demo` to exercise the Return-into-text exit.

**Tasks:**
- Wire the exit + Return / Space semantics ([P11]): trigger toggles off anywhere; Return drops into a text-input stop (resume typing — also exits cycling) and is inert on non-text controls; Space acts on the focused control. Escape is deferred ([P11]).
- Add a text-input cycle stop to `gallery-cycle-demo` (a `focusGroup` stop wrapping a caret surface) so the Return-into-text exit is exercisable.
- Add Cmd-1…N chords toggling each Z2 cell's popup; confirm they coexist with the existing routes (⇧⌘C / ⇧⌘S) and permission (⇧⌘P) chords.

**Tests:**
- Behavior: app-tests — Return on a text stop drops into typing (no submit) and exits cycling; Space acts on a non-text control; the trigger restores the caret; Cmd-N toggles the Nth Z2 popup.

**Checkpoint:** `bunx tsc --noEmit` clean; mode-key + chord app-tests green.

#### Step 2.5.5: Integration checkpoint + a11y assessment {#step-cycle-vet}

**STATUS — punted (2026-06-06).** No separate ceremonial integration checkpoint: the cycle has been verified end-to-end by the [#step-z2-cycle] audit + at0140 (enter → tour → act → exit, both card states) and by-eye, and the editor's Tab still completes (Risk R02). The [P13] a11y corollary ("always-on cycling" = a persistent push-at-mount variant, resolving [Q03]) is **deferred to the a11y follow-on** rather than recorded here as a gated task.

**Depends on:** #step-cycle-trigger-spike, #step-cycle-mechanism, #step-cycle-devcard, #step-cycle-keys

**Commit:** `N/A (verification only)`

**References:** [P09], [P10], [P11], [P12], [P13], [Q03], (#success-criteria, #cycle-model)

**Tasks:**
- End-to-end pass: enter (trigger) → cycle (Tab / arrow) → act (Space / dedicated chord) → exit (Return-into-text / trigger), in both card states, both themes.
- Assess the [P13] a11y corollary: "always-on cycling" = making a toggleable context **persistent** (drop the toggle, push at mount — the [P13] persistent type), which resolves the deferred [Q03]. Record the finding for the a11y follow-on.

**Tests:**
- Behavior: full `just app-test` keyboard sweep green (incl. the new cycle tests); the editor's Tab still completes (no regression — Risk R02 row).
- By-eye: the cycle tour reads as the focus-language showcase on the dev card.

**Checkpoint:** all cycle gates green; the a11y assessment is recorded.

#### Step 2.6: Session-picker keyboard navigation (persistent cycling) {#step-picker-keys}

**STATUS — done (2026-06-06).** The connected card cycles (Step 2.5); the **picker** (`DevProjectPicker` / `DevProjectPickerForm`, the "Choose Session" sheet) had **no keyboard navigation** — ⌥⇥ correctly does nothing there, and that stays true. Per [P13] the picker is a **persistent-cycling** context: its only text input is the **single-line** path field, which does not own Tab, so there is no Tab-owner to suspend — the trapped Tab-walk **is** the picker's base mode (always on, no toggle). It is *not* a toggleable cycle like the connected card. The walk is missing today and must be designed + built.

**Depends on:** #step-3 (the recents / sessions lists are the item-group archetype; reuse that focus CSS rather than re-inventing it).

**Commit:** `focus(picker): persistent keyboard navigation for the session picker`

**References:** [P02], [P12], [P13], (#cycle-model — for the per-state contrast: Picker = persistent cycling, Connected = toggleable cycling)

**Design (settled 2026-06-06 — every load-bearing piece consumes an existing framework seam; the only net-new code is the missing standard opt-in on one control, plus retiring the picker's bespoke keyboard model):**

- **What we're retiring (the actual "bespoke" thing).** The picker predates the focus language and hand-rolls its own keyboard model: `handleArrowKey` + a parallel `PickerSelection` React state for ArrowUp/Down over session rows, `handleFormKeyDown` intercepting arrows on the form `<div>`, and lists that are not focus stops at all. This step **deletes** that and puts the picker on the same rails as the dev-card cycle / `gallery-cycle-demo`.

- **Mechanism ([P13] persistent) — the trap already exists.** `TugSheet` already calls `useFocusTrap({ active: open })` and wraps its content in `FocusModeScope`, so the picker is *already* inside a trapped engine focus mode. The picker controls join it for free through the normal `FocusModeContext` (their `useFocusable`/`focusGroup` registers `modes: [sheetMode]`). **No new trap, no `useFocusTrap` call in the picker, no toggle** — the sheet's persistent mode *is* the picker's base mode.

- **Tab order:** Project-path field → Recent Project Paths list → Sessions list → trash-all → Cancel → Open, authored as **one focus group with explicit orders** (the dev-card `DEV_CYCLE_GROUP` pattern). Each `TugListView` is **one** item-group stop with arrow-roving within (its existing `focusGroup` listbox model — [P02]/[#step-3] archetype, already implemented); conditionally-rendered lists (empty recents / not-ready sessions) simply leave a gap in the order, which the walk skips. The buttons (incl. the popover-wrapped trash-all) take `focusGroup`/`focusOrder` directly via `TugButton` (its asChild ref-merge already composes the focusable ref).

- **The path field — bring `TugFileChooser` up to the standard (DECIDED).** It is the only interactive control in the picker missing the `focusGroup` opt-in every other control has. Extend the **shared component** with the standard `focusGroup`/`focusOrder` opt-in (stamp `data-tug-focusable` on the input so the engine lands the key view on the real caret) **plus a `consumesTab: () => menuOpen` predicate** — the exact pattern the editor uses so Tab accepts an open completion and otherwise leaves the field ("the single-line field does not own Tab"). This benefits every future form, not just this picker.

- **Default focus / seed — already a framework primitive.** The picker's commit-home (Open) is **last** in reading order, so the dev-card convention (*seed = first stop*, `focusFirstInMode`) doesn't fit. The engine already resolves a focusable by its stable `group:order` focus-key, sets it as the keyboard key view, focuses it, and handles the async-mount case — **`armKeyboardRestore(focusKey)`** (built for cold-boot ring restore; it is the general "seed this specific stop by position" primitive). The smart latch ([P12], already added in [#step-cycle-devcard]) calls it: **Open** when a valid path is seeded, else the path field. (Return on Open submits regardless via the existing default-button mechanism — Open is `filled`+`action`.) **No `.focus()`-without-key-view shortcut, no parallel state.**

- **Within-list keys:** ↑/↓ rove the list cursor; Return/Space commits the roved row through the list's existing `delegate.onSelect` (opens the roved session / commits the roved recent into the path field) via the engine act dispatch — no new wiring.

- **Per-row trash stays pointer-only (DECIDED).** The in-row trash icons are `TugIconButton` (`data-tug-focus="refuse"`) — deliberately pointer affordances, not focusables, so they are not descendable and Return keeps its primary meaning (open the session). Keyboard users trash via the **bulk "Move all to Trash"** Tab stop. A generic keyboard row-delete gesture is a real list-archetype decision and is **deferred to [#step-5]** (list view / row), not built one-off here.

- **Escape:** Cancel — the sheet's existing cancel ladder already owns Escape; confirm no regression (no new Escape wiring expected).

**Tasks:**
- [x] Extend `TugFileChooser` with the standard `focusGroup`/`focusOrder` opt-in (focusable on the input element) + `consumesTab: () => menuOpen` (plus the `data-tug-tab-consume` marker on the input — the editor's pattern, the robust signal while typing).
- [x] Author the picker controls into one focus group with orders (path 0 → recents 1 → sessions 2 → trash-all 3 → Cancel 4 → Open 5); `focusGroup`/`focusOrder` on the two `TugListView`s and the three buttons.
- [x] Delete the bespoke keyboard model (`handleArrowKey`, `handleFormKeyDown`, the `onKeyDown` handler, the dead `openButtonRef`); the engine cursor + the list's `onSelect` own navigation + commit.
- [x] Seed via the smart latch through `armKeyboardRestore` (Open when valid, else the path field) so the ring rests on the seed at open.
- [x] App-test `at0141-picker-keys`: seed on Open, Tab wraps to the path field, path releases Tab when its menu is closed, Recents is one stop with internal arrow-roving, Return commits the roved recent. Added a reusable `setTugbankValue` test-surface method (SURFACE_VERSION 1.11.0) to populate Recents in-process.

**Tests:**
- [x] Behavior: `tests/app-test/at0141-picker-keys.test.ts` — **green**. Driven by synthetic `keydown` through the real document-level focus pipeline (the engine's Tab-walk listener / `focusNext` / list arrow-rove / act dispatch all run for real); only OS→WebView delivery is skipped (the form auto-scrolls the seeded Open into view, putting the top field off-screen for a native click — see the test header).
- [x] Regression (pure-logic): `focus-walk.test.ts` green (24/24) — walk/advance/wrap intact.
- [x] Regression (real-app `nativeKey`): at0106 / at0055 / at0058 / at0035 / at0051 / at0140 green in a foreground run (the automation session that built this couldn't focus the app window; the user ran the suite).
- [x] By-eye: the persistent ring reads as the focus language across the picker; per-row trash still works by mouse; Return opens a session; Escape cancels. *(user-verified)*

**Checkpoint:** `bunx tsc --noEmit` clean ✅; `at0141-picker-keys` green ✅; `focus-walk` units green ✅; `nativeKey` regression set green ✅; by-eye clean ✅.

#### Step 2.7: Componentize the Z2 status cells {#step-z2-components}

**STATUS — done (2026-06-06; `afd978c7`).** Devised in `tugplan-z2-status-cell.md` and implemented: the cells are now the `TugStatusCell` component (button-rooted, focus-ready), migrated faithfully from the bespoke spans, which is what made [#step-z2-cycle] the trivial "author into the cycle" it became. The original framing is kept below for the record. The Z2 telemetry status cells (STATE / TIME / TOKENS / CONTEXT, + TASKS) were the card's **one bespoke holdout**: hand-assembled inline in `dev-card-telemetry-renderers.tsx` as `<span className="dev-telemetry-status-cell">` wrapped in a `TugPopoverTrigger`, with ad-hoc CSS — *not* proper components. Every other zone the focus language plugs into is a real component (route = `TugChoiceGroup`, chips = `TugPushButton`) that joins the cycle via one `focusGroup` prop. Retrofitting focus/keyboard onto the bespoke spans is the "invasive" part of Z2 cycling (a `<span>` trigger is not keyboard-activatable; the ring / arrow-rove / popover-on-Space all hand-rolled). **Componentize the cells first**, so [#step-z2-cycle] becomes the same trivial "author into the cycle" as the chips.

This step is **devised separately** (`/tugplug:devise`) — it is a real refactor with its own design questions — then implemented and rejoined before [#step-z2-cycle].

**Depends on:** —  *(stands alone; the focus treatment it inherits is defined by [#step-3] / [#step-5], but the component extraction does not block on them)*

**Commit:** `feat(devcard): proper Z2 status-cell component(s)`

**References:** [P02], [P13], [D100] (TASKS popover), (#cycle-model)

**Design (to settle in the devise pass):**
- **Primitive choice:** the cell is "a focusable control that opens a surface on activate" — the same interaction as the Z4B chips (which open sheets). Decide: a `TugPushButton`-with-popover variant (max consistency, focus-ready) vs a dedicated `TugStatusCell` component. Either way the **activatable element is a button, not a span**, so keyboard activation + the focus ring come for free.
- **Faithful extraction — preserve:** the per-cell popover (STATE/TIME/TOKENS/CONTEXT) + the `/context` programmatic popover ref; the TASKS cell ([D100]); width stabilization ([R01]); the `data-priority` + endcap-rule-label visuals; the STATE pulsing-dot indicators; the placement-experiment slot usage.
- **Token sovereignty ([L20]):** move the cell's ad-hoc CSS into the component's own scoped tokens; the row keeps only layout.

**Tasks:** (expand after the devise pass)
- Extract the status cell into a proper component (per the primitive choice); migrate `dev-card-telemetry-renderers.tsx` to it without behavior loss.
- Keep all existing Z2 app-tests green (telemetry/popover/`/context`).

**Checkpoint:** `tsc` clean; Z2 telemetry + popover + `/context` app-tests green; the row renders identically by-eye, both themes.

#### Step 2.8: Z2 status row joins the cycle (was Slice 3) {#step-z2-cycle}

**STATUS — done (2026-06-06; Z2-as-leaf reversal applied).** Each Z2 status cell is its own **leaf** cycle stop ([P10] revised + the 2026-06-06 by-eye reversal — the interim item-group/arrow-rove "felt awful"). `TugStatusCell` registers via `useFocusable` (keyed by id; `data-tug-focusable` stamped on the cell `<button>` directly, sidestepping `TugPopoverTrigger`'s `asChild` ref capture); the engine drives DOM focus to the button during the walk and the global `[data-key-view-kbd]` rule paints the blue leaf ring; Space/Enter open the cell's popover natively. The dev card threads `statusRowFocusGroup`/`statusRowFocusOrderBase` (=5) through `useDevPlacementSlots`; the row assigns the cells consecutive orders 5…9; the editor moves to order 10. The status-bar region is wrapped in a second `cycle.CycleScope` sharing the card's mode id. **A cell rings only while it is the active cycle stop — never at rest** (the prior item-group cursor that could strand is gone). The **editor text-stop border** was reworked from an inset `outline` (painted over by CodeMirror → invisible) to a **square** (`border-radius: 0`) `::after` overlay border around the whole input component.

**Close-focus ownership (one system) — added 2026-06-06.** Opening a Z2 cell's popover from the cycle, then Escape, used to lose the cycle position and dump focus into the editor. Two systems were writing close-focus and disagreeing on the destination: the focus engine's mode-stack restore (→ the cell key view) and the service-popup binding's "prior responder" restore (→ the editor, since the status bar is `data-tug-focus="refuse"`). Resolved by making the **focus engine the single owner** (see [#cycle-model] "Close-focus ownership"): `popFocusMode` restores the captured key view's keyboard-ness AND `focusKeyView`s it; `useServicePopupBinding` (popovers) and `TugSheet`'s `handleUnmountAutoFocus` (sheets) **defer** when a keyboard key view was present at open; `getKeyCard` falls back to the keyboard-focus card so key-card chords resolve on a refuse stop. Mouse/responder restore unchanged (at0055 / at0058 / at0020 / at0039 / at0106 / at0100 green). Also: `cycle.cycling` reads **mode-stack membership** (not top-of-stack) so a nested surface isn't a cycle exit; and `popFocusMode` **always notifies** (a mode pop changes `isFocusModePushed` independent of the key view — `setKeyView` early-returns when the restored key view is unchanged, which had left `cycle.cycling` stale).

**Comprehensive rule — the mouse exits toggleable cycling — added 2026-06-06.** Per [#cycle-model]: `useCycleMode` exits on a `pointerdown` while the cycle is the top mode. Clicking the editor ends the cycle + drops the caret; clicking a Z4B chip / Z2 cell ends the cycle + opens its surface by mouse (close → editor caret). Verified in at0140 (editor-click + chip-click both exit).

**Depends on:** #step-cycle-devcard, #step-z2-components

**Commit:** `focus(cycle): Z2 status cells join the dev-card cycle as leaf stops`

**References:** [P10] (revised — Z2 = five leaf stops, the 2026-06-06 reversal), (#cycle-model)

**Artifacts:** the five Z2 status cells authored as the cycle's order-5…9 **leaf** stops (Tab cell-to-cell, blue leaf ring on the active cell, Space/Enter opens its popover), wrapped in a second `cycle.CycleScope` sharing the card's mode id; the editor text-stop's whole-component blue border.

**Tasks:**
- [x] Author each Z2 cell as a leaf stop into `DEV_CYCLE_GROUP` (orders 5…9, editor → 10); wrap the status-bar region in `cycle.CycleScope`.
- [x] Confirm the tour: route → Mode → Model → Effort → submit → STATE → TIME → TOKENS → CONTEXT → TASKS → editor → wrap; the blue leaf ring on each cell in turn; Space/Enter opens its popover; **no Z2 ring at rest**.
- [x] Give the editor text-stop a clear **square** blue border around the whole text component.
- [x] Make the focus engine the single owner of close-focus (popovers AND sheets defer when a keyboard key view was present at open); `getKeyCard` falls back to the keyboard-focus card; `popFocusMode` always notifies; `cycle.cycling` reads mode-stack membership so a nested surface is not a cycle exit.
- [x] Comprehensive rule: **using the mouse exits toggleable cycling** (`useCycleMode` pointerdown-while-top → exit). Clicking the editor / a Z4B chip / a Z2 cell ends the cycle; a mouse-opened surface then restores the editor caret.

**Tests:**
- [x] Behavior: extend at0140 — the five Z2 cells are individual stops; submit skipped when empty; **Return opens a cell popover and Escape returns the ring to the same cell** without leaving the cycle or focusing the editor; **a click on the editor and on a Z4B chip both exit cycling**.
- [x] Regression: mouse/responder close-focus unchanged — at0055 / at0058 / at0020 / at0039 / at0106 / at0100 / at0016 green.
- [ ] By-eye: Z2 leaf rings + the square editor border read as the focus language, both themes; no ring at rest; keyboard-opened Z4B sheet returns the ring to its chip (full keyboard sheet-open lands with #step-cycle-keys). *(user verification)*

**Checkpoint:** `bunx tsc --noEmit` clean ✅; at0140 (cells + popover-escape + mouse-exit) green ✅; at0084 + at0055/at0058/at0020/at0039/at0105/at0106/at0100/at0016 green ✅; by-eye clean in brio + harmony — *user verification pending*.

#### Step 2.9: Prominence hierarchy — `primary` emphasis (tint-at-rest → fill-on-engage) {#step-primary}

**STATUS — done (2026-06-07).** Motivated by the session-picker "too much blue": an idle `filled+action` default button rendered identically to a `filled` selected list-row (solid blue, no ring), so the default *impersonated a selection*. [P14] reserves solid fill for **selection + the live control** and introduces a **`primary` emphasis** that rests at the quiet tint and promotes to the solid fill + ring when engaged. The primitive is built and proven on the picker + the gallery; the app-wide sheet/dialog/alert sweep is folded into [#step-7].

**Depends on:** #step-1, #step-2 (the keyboard-promoted block `primary` rides)

**Commit:** `focus(buttons): primary emphasis — tint at rest, fill when engaged`

**References:** [P14], [P06], [P12], (#p14-primary-emphasis)

**Artifacts:** `TugButtonEmphasis` += `"primary"`; `internal/tug-button.{tsx,css}` (default-button registration accepts `primary`; primary CSS = tint-at-rest, filled-on-hover/active, listed alongside `outlined` in the keyboard-promoted block); the session picker Open button (`dev-card.tsx`); `gallery-push-button.tsx` Focus-Language demo row + preview popup; `styles/focus-ring.css` prose (the prominence-hierarchy note).

**Tasks:**
- [x] Add `"primary"` to `TugButtonEmphasis`; accept `filled || primary` in `isDefaultButton` (Return-home registration).
- [x] Author `primary` (action + danger) in `tug-button.css`: tint-at-rest, filled-on-hover/active; add `primary` to the role-ring axis + the outlined→filled key-view promotion + the aria-disabled list.
- [x] Switch the session-picker Open button `filled` → `primary`.
- [x] Gallery: add a `primary` row to the Focus-Language demo (the by-eye vetting surface) + `primary` in the emphasis preview popup.
- [x] Update `focus-ring.css` prose so the documented model matches (default rests at a tint; solid = selection-or-live).
- [x] Leave standalone CTAs (jump-to-bottom FAB, prompt-entry submit, icon CTAs) on `filled` — no competing controls, resting solid fill is wanted.

**Tests:**
- [x] `bunx tsc --noEmit` clean.
- [ ] By-eye: in the picker, idle Open reads as a quiet tint (no longer a solid blue that mimics the selected rows); Tab onto Open → it fills + rings; Tab away → back to tint. Cancel still promotes to fill+ring when focused. Gallery primary row promotes/demotes on Tab. Both themes. *(user verification)*

**Checkpoint:** `bunx tsc --noEmit` clean ✅; gallery + picker render `primary`; by-eye prominence reads as three distinct levels (tint = recommended, solid+ring = live, solid = selected) — *user verification pending*.

#### Step 2.10: Cycle commit disposition — relinquish a toggleable cycle on value-commit {#step-cycle-commit}

**STATUS — done (2026-06-07).** A keyboard value-commit at a cycle stop now consults the **top mode's** `commitDisposition` and, in a toggleable cycle, relinquishes (pops the mode → editor caret returns) on `select`/`act` while retaining on `descend`. The policy rides the mode (injected by `useCycleMode` = toggleable default; `useFocusTrap` injects none = retain), so the act-dispatch chokepoint stays policy-agnostic and the disposition derives from the [P13] context type with zero per-card config. Fixes the dev-card route-commit desync (caret blinking but typing dead). `at0140` gained a relinquish test (Return on the route group exits cycling, returns the caret, typing lands); the persistent picker (`at0141`) and gallery cycle demo (`at0139`) regress green (commit retains where there's no toggleable cycle).

**Depends on:** #step-cycle (the cycle-mode primitive)

**Commit:** `focus(cycle): value-commit relinquishes a toggleable cycle ([P15])`

**References:** [P15], [P13], (#p15-cycle-commit-disposition), lifecycle-delegates.md

**Artifacts:** `focus-manager.ts` (`commitDisposition` on the mode + `applyCommitDisposition`), `responder-chain-provider.tsx` (act-dispatch calls it after `select`/`act`/`descend`), `use-cycle-mode.tsx` (toggleable default + `dispositionAfterCommit` override option); a real-app test.

**Tasks:**
- [x] Carry an optional `commitDisposition(commit) → "retain" | "relinquish"` on the focus mode (stored at `pushFocusMode`); add `manager.applyCommitDisposition(kind)` that consults the **top** mode and pops it (default restore) on `relinquish`.
- [x] Call `applyCommitDisposition` from the act dispatch after `onSelect`/`onAct`/`onDescend`.
- [x] `useCycleMode`: inject the toggleable default (`select`/`act` → relinquish, `descend` → retain) at push; add the `dispositionAfterCommit` override option. `useFocusTrap` injects nothing → retain.
- [x] Dev card configures nothing — inherits the toggleable default.

**Tests:**
- [x] Real-app: connected dev card → Opt-Tab → Tab to the route group → Arrow → Return commits the route AND exits cycling (the editor is the key view; typing lands) — `at0140` new case green. Z2-cell Return (act → opens popover) does NOT exit cycling — `at0140` existing case green.
- [x] `bunx tsc --noEmit` clean; focus-walk pure-logic green; `at0139`/`at0141` (commit-retains-where-no-toggleable-cycle) regress green.

**Checkpoint:** `bunx tsc --noEmit` clean ✅; the dev-card route-commit sequence leaves the editor typable (no caret-without-key-view desync) ✅; the Z2-cell-popover-open path still retains the cycle ✅.

#### Step 3: Item-groups — radio / choice / option {#step-3}

**STATUS — done (2026-06-07).** The three item-groups now wear the [P02] treatment: the group container carries a faint behind-tint (no container ring); the single ring rides the cursor item; selection stays the native fill (radio dot / choice pill / option fill) in the role color. The legacy "cursor reuses the neutral hover wash" is retired — the cursor is the role-resolved ring (global `[data-key-cursor]`), and hover keeps its own pointer wash. Role-awareness is injected once in `buildRoleStyle` (`--tugx-focus-ring` / `--tugx-focus-tint` follow an explicit role; no-role rides the global `action` default per [P03], independent of the disentangled "on" selection axis). The dev-card route-group double-ring is resolved by the container override. The three group app-tests were reworked to the new contract (container has NO ring + HAS the behind-tint; the cursor item carries the ring) — these are the falsifiable guards.

**By-eye refinements (2026-06-07).** (1) **Cursor ring geometry — settled on the leaf "ring + gap"** (see (3) for the full rationale). The 2px-outside halo read "tubby" and smashed; an inset ring was tried (tight, contained) but blended on same-color fills; the final form is the role ring just OUTSIDE the item with a *thin* gap (`outline-offset: 1px`), uniform across all three groups, with the constant `column-gap` providing room so it never smashes. (2) **Toggleable contexts show the language only while cycling** — recorded as a [P13] implication: a global `[data-cycling="false"]` rule in `focus-ring.css` suppresses the ring + behind-tint on a non-cycling context's stops (the dev-card route group no longer rings when the editor holds the keyboard). (3) **`selected` vs `selected + cursor` — resolved with the LEAF "ring + gap" treatment** (user choice). A role-colored ring blends into a same-color fill, and a neutral/text-color contrast ring read as a one-off that broke family with the rest of the language. The settled answer: the cursor ring is the **standard role ring sitting just OUTSIDE the item with a thin background-colored gap** (`outline-offset: 1px`) — exactly like a focused button. The gap (fill → thin track gap → role ring) is what lets it read atop a same-color selection without leaving the role family. Applied uniformly to all three groups (replacing the earlier inset ring); the constant `column-gap` (bumped to `4px`) gives the outside ring room so it never smashes. The theme-adaptive `--tugx-cursor-ring-on-fill` token was removed (no longer needed). (4) **Harmony segment resting text was too light** (a theme-token bug: `plain-rest` `t:38`/`hover` `t:22`); darkened to `t:16`/`t:8` to match the radio group's dark text on the light track. (5) **Constant inter-item gap.** The segmented groups used gapless `1fr` tracks whose sub-pixel seams shifted on relayout (and, when a parent stretched the group, distributed fractional width). Added a fixed `column-gap: 4px` (choice + option; ghost route keeps `0`) — a controlled gap that never shifts and gives the outside cursor ring room so it never smashes; the gallery Focus-Language demos are wrapped in a plain block so they stay content-width instead of being stretched by `.cg-section`'s column flex. (6) **The focus ring hides the inter-segment pipe divider**, exactly as the selection fill does: the choice/option pipe `::before` is now also transparent when a neighbor holds `[data-key-cursor]` (previously only when `active`/`on`), so the ring no longer collides with a divider line. All verified at the app-test level (group tests + `at0140` green); user by-eye pending.

**Depends on:** #step-1

**Commit:** `focus(groups): behind-tint + cursor ring + native fill, role-aware`

**References:** [P01], [P02], [P03], (#language-contract)

**Artifacts:** `tug-radio-group.css`, `tug-choice-group.css`, `tug-option-group.css`; `internal/tug-group-utils.tsx` (`buildRoleStyle` role-resolved focus marks); reworked `at0117` / `at0118` / `at0119`.

**Tasks:**
- [x] Project the behind-tint from `[data-key-view-kbd]` on the group (override the global leaf ring → `outline:none` + a `background-image` tint that composes over the container's own bg); the ring from `[data-key-cursor]` on the item (the global rule, offset outside so it survives atop a fill); native fill from the checked/active state (dot / pill / fill) in the role color (already injected via `buildRoleStyle`, now also feeding `--tugx-focus-ring`/`--tugx-focus-tint`).
- [x] Remove the old cursor-as-neutral-wash CSS these files carried (the `:is(:hover, [data-key-cursor])` reuse → hover-only); no orange remained after [#step-1].
- [x] **Resolve the double-ring on the dev card's route group in cycling** ([#step-cycle-devcard] by-eye): the container override drops the container leaf ring to a behind-tint, leaving the single cursor ring. Mechanism proven by `at0118` (choice container outline 0 + behind-tint present, cursor segment ring present); `at0086` + `at0140` green. Dev-card cycle-tour both-theme look is by-eye.

**Tests:**
- [x] Behavior: each group's app-tests + `at0030` component-state-preservation green — `at0117` / `at0118` / `at0119` / `at0030` all PASS (reworked to assert the [P02] visual contract; `at0086` / `at0125` / `at0140` regression green).
- [ ] By-eye: exclusive (radio dot / choice pill) and multi (option) per the gallery, incl. danger/accent, both themes; the cursor ring hugs the item (inset, not a tubby halo, no neighbor smash); the dev-card route group shows one ring while cycling and **no ring when cycling is off**. *(refinements landed; user re-verification pending)*

**Checkpoint:** `bunx tsc --noEmit` clean ✅; group app-tests green ✅ (`at0117`/`at0118`/`at0119`/`at0030` + `at0086`/`at0125`/`at0140` regression); gallery parity — *user by-eye pending*.

#### Step 4: Live / continuous — slider; tab bar (commit-on-act) {#step-4}

**Depends on:** #step-1

**Commit:** `focus(live): slider ring/thumb; tab bar commit-on-act`

**References:** [P01], [P02], [P08], (#p08-tabbar-commit)

**Artifacts:** `tug-slider.css`, `tug-tab-bar.css` (+ `tug-tab-bar.tsx` visual signature; live commit retained per the [P08] revision), and a shared cursor-projection fix (`use-focus-cursor.ts` / `use-item-group-keyboard.ts`).

**STATUS — done (on `main`, uncommitted; pending /tugplug:commit).**

**Done:**
- ✅ **Slider** (`tug-slider.css`): the leaf now wears the full [P01] signature — the ring AND a faint behind-tint (role-resolved `--tugx-focus-tint` as a gradient overlay over the root's background, the [Q02] technique) on the whole component, and the **thumb fills with the role color** (`--tugx-focus-fill`) on keyboard focus (the slider's "native fill").
- ✅ **Tab bar keeps live commit** ([P08], REVISED): the original plan flipped it to commit-on-act; reversed after by-eye review — a tab bar is a view switcher and the ARIA *automatic activation* pattern (arrow switches the view) is correct here. Commit-on-act stranded the cursor ring on an un-shown tab. So the tab bar adopts only the item-group **visual** signature; the live commit behavior is unchanged.
- ✅ **Tab bar item-group signature** (`tug-tab-bar.css`): the bar wears the behind-tint (no leaf ring on the bar); the focused tab carries the single ring — **inset** (`outline-offset: -2px`, square-matched radius) because the bar clips overflow (`overflow: hidden`, the tab-collapse mechanism) and the tabs fill full height, so the choice/option groups' *outside* ring would be clipped. Because the bar commits live, the cursor always rides the active tab: the focused tab shows the ring AND its `data-active` underline+fill at once (the ring is the keyboard overlay on the live selection).
- ✅ **Keyboard-model matrix** (`tugplan-keyboard-model.md`): TugTabBar row stays **live** (the [P08] revision).
- ✅ **Shared cursor-at-rest fix** (surfaced by the tab bar's now-visible inset ring): `useFocusCursor` projected `data-key-cursor` unconditionally, so **every** item-group (radio/choice/option/tab) stamped a cursor ring at index 0 *at rest* and on a plain mouse click — masked before only because the outside rings were faint/clipped. Cursor projection is now gated on an `active` flag the owner flips with the keyboard key view, so no ring shows at rest or on click ([P12]). Confirmed radio/choice/option still ring correctly on Tab.

**Tests:**
- ✅ Behavior: `at0115` (slider) green — now also asserts behind-tint + thumb fill. `at0116` (tab bar): Tab tints the bar (no leaf ring on the bar) + cursors the active tab; arrow **switches live** (cursor + active tab move together).
- ✅ Regression: `at0117/0118/0119` (radio/choice/option), `at0120` (accordion), `at0121/0122` (list view), `at0140` (cycle dev card), `at0109` (focus ring) all green — the shared cursor fix holds. (`at0040`, `at0083` fail identically on clean `main` — pre-existing, unrelated to this step.)
- By-eye: pending user review — both themes; slider tint/thumb-fill; tab-bar cursor-vs-selection legibility, especially the inset ring on the active+cursor tab.

**Checkpoint:** ✅ `bunx tsc --noEmit` clean; ✅ app-tests (incl. the new tab-bar contract) green; gallery parity (existing interactive demos exercise the new behavior).

#### Step 5: Descendable rows — list view / row, accordion {#step-5}

**Depends on:** #step-1

**Commit:** `focus(rows): list/accordion behind-tint + cursor ring + native fill`

**References:** [P01], [P02], [P03], (#language-contract)

**Artifacts:** `tug-list-view.css`, `tug-list-row.css`, `tug-accordion.css`.

**STATUS — done (`b465e107`). Final model after a by-eye design pass — supersedes
the original "container behind-tint + cursor ring" framing below.** The descendable-row
archetype (list, accordion) settled on a treatment distinct from the small item-groups
of [#step-3]: the focused CONTAINER wears a **perimeter ring** (not a behind-tint), and
the cursor row wears a **reduced tint fill** (not a ring). The by-eye loop found the
group behind-tint + cursor ring illegible for full-width rows ("too much lit up; the
cursor blends in"), and inverted it.

**Done:**
- ✅ **Container perimeter ring** (`tug-list-view.css`, `tug-accordion.css`): the focused container's `[data-key-view-kbd]` paints an `outline` ring at `outline-offset: 0` so it overlays the list's own border. Bordered picker hosts (`.dev-card-picker-recents-host` / `-sessions-host`) clip an inner outward outline (`overflow: hidden`), so the ring is drawn on the host via `:has(.tug-list-view[data-key-view-kbd])` (border-color + 1px box-shadow).
- ✅ **Cursor row = reduced tint fill, no ring** (`tug-list-view.css` cell / `tug-accordion.css` trigger): the cursor is a 25% `color-mix` of the per-theme quiet selection blue (`--tugx-list-view-cursor-tint` / `--tugx-accordion-cursor-tint`), painted as a gradient fill. The global `[data-key-cursor]` ring is suppressed and `border-radius: 0` on the cursor cell drops the stray global 6px so the cursor shares the selection's host-clipped rounded bounds. No chevron/dot accessory. A leading row gutter (`--tugx-list-row-indicator-gutter: 0.2rem`) gives the fills breathing room.
- ✅ **`[data-key-within]` on descend**: Enter-descend drops the container's key view and the engine projects `[data-key-within]` on the list/accordion root → the global quiet within mark. No new CSS needed.
- ✅ **Selection = toned-back role-blue native fill** (`tug-list-row.css`, `brio.css`/`harmony.css`): list-row selection is the `selection` family's calm `quiet` sibling ([P14]: a large persistent row fill rides the calm sibling, not the solid `--tugx-focus-fill`), and the per-theme quiet token was toned back at source (brio `i:34,t:32`; harmony `i:42,t:45`) so the cursor tint reads as a lighter version of the same hue. Selected flush rows cover their own dividers. The cursor tint is derived from this same token.

**Tests:**
- ✅ Behavior: `at0120` (accordion) + `at0121` (list container) reworked to assert the [P02] contract (behind-tint gradient + suppressed outline, not the leaf ring); `at0110` re-pinned from the orange arc to the **blue** role arc; `at0127` (cursor/select/descend/ascend), `at0122` (subordinate), `at0141` (picker), `at0060` (content-settled), `at0030` (virtual focus) all green. (`at0069` + `at0083`'s cold-boot-restore test fail **identically on clean `main`** — pre-existing scroll-restore timing flakes, unrelated to focus visuals; verified by stash-rebuild.)
- By-eye: pending user review — cursor-on-selected-row legibility, descend within-mark, both themes.

**Checkpoint:** ✅ `bunx tsc --noEmit` clean; ✅ focus app-tests green; gallery parity (the `gallery-list-view-focus` + `gallery-accordion` focus demos exercise the new behavior) — *user by-eye pending*.

#### Step 6: Leaf controls — checkbox, switch, input, textarea, value-input {#step-6}

**Depends on:** #step-1

**Commit:** `focus(leaf): whole-component ring + tint + native fill; input validation→role`

**References:** [P01], [P02], [P03], [P07], (#p07-input-validation)

**STATUS — done (2026-06-07).** Two leaf shapes, two treatments.
**Toggles** (checkbox, switch): the focusable box/track is small and sits next to
a label, so the [P02] "whole component" ring + behind-tint move to the
`.tug-checkbox-wrapper` / `.tug-switch-wrapper` via `:has(.tug-…[data-key-view-kbd])`
(the box's own global leaf ring is suppressed inside a wrapper; a label-less
toggle keeps the global ring on the box). Persistent inset keyed on
`data-tug-focusable` keeps the ring/tint off the glyph + label with no focus-time
layout shift (the slider's approach). The native "on" fill is unchanged and
already role-aware (`--tugx-toggle-on-color`). **Fields** (input, textarea,
value-input): the field *is* the focusable, so the global leaf ring already wraps
it; the leaf signature adds a faint behind-tint painted as a gradient overlay over
the field's own focus background on keyboard focus only ([Q02]), derived from the
resolved `--tugx-focus-ring` so it follows the role. `validation` maps onto the
role axis ([P07]): `invalid`/`valid`/`warning` repoint `--tugx-focus-ring` to the
danger/success/caution outlined border, so the ring AND the derived wash resolve
to the validation colour, and the field border now holds that colour through focus
(an invalid field stays red while you edit it). Value-input has no validation axis
— it rides the action default. The gallery focus-walk toggles were relabelled
(`aria-label`→visible `label`) so the wrapper ring is exercised and reviewable;
`at0113`/`at0114` now assert the ring on the wrapper (box outline 0). Inputs are
not engine-authorable into a focus group (no `useFocusable` wiring, and adding it
is engine-adjacent — out of scope per [P04]); the field CSS activates wherever an
input is an engine key view (sheets, editors), and the [P07] border-holds-red
behaviour is reviewable on plain `:focus` in the gallery.

**Artifacts:** `tug-checkbox.css`, `tug-switch.css`, `tug-input.css`, `tug-textarea.css`, `tug-value-input.css`.

**Tasks:**
- Toggle/switch: whole-component ring (glyph + label) + behind-tint; native blue "on" fill, role-aware.
- Input/textarea/value-input: whole-component ring + behind-tint; map `validation` onto the role axis ([P07]) so invalid focuses danger.

**Tests:**
- Behavior: input/toggle app-tests green.
- By-eye: ring wraps glyph+label; invalid input focuses red; both themes.

**Checkpoint:** `tsc` clean; app-tests green; gallery parity.

#### Step 7: Surfaces / boxes — popover, sheet, alert, inline dialogs, menus {#step-7}

**Depends on:** #step-1, #step-2, #step-3

**Commit:** `focus(surfaces): box ring + within; dialog option-rows; menus audit`

**References:** [P01], [P02], [P04], [P14], (#language-contract)

**STATUS — done (2026-06-07).** Four parts.
**(A) Box-scope.** `tug-popover.css` / `tug-sheet.css` / `tug-alert.css` override the
global outline-based ring/within on the `-content` box (a clipping rounded box with
its own drop shadow) to a layout-free **box-shadow ring that hugs the radius and
LAYERS over the existing drop shadow** (`0 0 0 ring-w role, var(--tugx-*-shadow)`),
plus a role border on key-view. Popover + alert (compact) also take the faint role
**behind-tint** ([Q02] gradient overlay over their own bg); the sheet does **not** — a
wash over a full-height scrolling panel reads as noise ("tint where the surface
allows"). The quiet `[data-key-within]` variant is the same box-shadow at the dimmer
within color. The inline dialogs already carried the box-shadow box ring (modal-for-
keys scope); kept and finalised.
**(B) `primary` sweep — completeness gate met.** Every sheet/dialog/alert
action-role text commit moved `filled`→`primary` (OK/Save/Done/Confirm/Retry/Send):
the picker (from [#step-primary]) plus model/effort pickers, skills/agents/memory/
hooks/help/rename/rewind/diff sheets, permission-rules-editor (both commits) +
permission-mode-chip + dev-attachment-preview, ask-user-question submit, dev-card
(spawn-retry + telemetry Done), and the pane-close confirm (`chrome/tug-pane.tsx`).
The modal alerts (`tug-alert`, `tug-alert-sheet`) resolve
`emphasis={confirmRole === "action" ? "primary" : "filled"}` — **action promotes to
`primary`; danger/caution keep `filled`** (the [P14] danger judgment call: a solid
red destructive default does not conflate with selection-blue, and the engine seeds
the key view onto their default on open so a `primary` action default fills+rings
regardless). Re-grep of `emphasis="filled"` leaves only the excluded standalone CTAs
(prompt-entry submit/queue, jump-to-bottom FAB), the gallery `filled` demos, and the
confirm-popover defaults below.

**Confirm popovers — authored into their own trapped focus mode (2026-06-07).**
`TugConfirmPopover` and the pane-close confirm previously seeded focus with a native
`.focus()` and weren't engine focusables, so (a) the default never got
`data-key-view-kbd` → no ring, (b) the fill sat on a fixed button instead of
following the keyboard, and (c) **Tab escaped the popover entirely** (on the session
picker it roved back into the picker's group). Fixed by authoring both action
buttons into the popover's **own** `useFocusTrap` mode (the one `TugPopover` already
pushes while open): each button takes `focusGroup`/`focusOrder`, so the engine
cycles only those two under Tab — **the popover is its own focus layer you cannot Tab
out of** — and moves the key view between them. Both buttons are now `emphasis="outlined"`
in their role; the engine's `[data-key-view-kbd]` promotion turns whichever holds the
key view into its **filled role style + role ring** — *the fill follows the ring*
(matching the gallery's outlined→filled focus-language demo). The default is seeded as
the engine key view via `armKeyboardRestore` on open (Return-safe **Cancel** for the
destructive Trash confirm; **Close** for the Close confirm), so it rests filled+ringed
and Tab promotes/demotes the pair. No bespoke `:focus` CSS — the engine drives it.
**(C) Inline-dialog option rows.** The bespoke `[data-key-cursor]` border-recolor in
`dev-permission-dialog.css` / `dev-question-dialog.css` is retired; the option ROWS
(`TugDialogButton`) take the [#step-3] item-group treatment — the global
`[data-key-cursor]` outline ring offset outside the row (survives atop the native
selected fill), **role-resolved** via a `--tugx-focus-ring` repoint added to
`tug-dialog-button.css` (danger options rove a red ring; action rides the default).
**(D) Menus audit — no change.** `tug-menu`, `tug-context-menu`,
`tug-editor-context-menu`, `tug-completion-menu`, and `internal/tug-popup-menu` drive
highlighting via Radix `data-highlighted` (the editor menu hand-rolls the same
attribute), never the engine `[data-key-cursor]` — so the [#step-1] cursor→ring flip
cannot reach them. No scoped override needed.

**Tests:** surface/dialog/menu app-tests green — at0090/at0093/at0094/at0097/at0100/
at0102/at0104/at0105/at0106/at0057/at0058/at0128. (at0040/at0088/at0096 fail
**identically on clean `main`** — pre-existing native-click / capability-metadata
timing flakes, not gated on; verified by stash-rebuild.)

**Slash-command / Z4B sheet focus-scope sweep (2026-06-07).** `TugSheet` already
pushes a trapped focus mode and wraps its body in `FocusModeScope`, but the
slash-command + chip sheets never authored their controls into a group or seeded a
default — so Tab did nothing and the `primary` Done/OK never got `data-key-view-kbd`
(it sat at the resting tint). Added a reusable `useSeedKeyView(group:order)` hook
(`use-focusable.tsx`) that seeds the engine key view onto a control on mount via
`armKeyboardRestore`, and authored each sheet's controls into its trap with a
`React.useId()` group: **effort / model / permission-mode pickers** (list → Cancel →
OK, OK seeded), **permissions editor** (tab bar → Done, Done seeded), **rewind**
(turn list → Cancel → Rewind, Rewind seeded), **memory** (file list → Done, Done
seeded), **hooks** (accordion → Done), **help** (tab bar → Done), and the Done-only
**skills / agents / diff / attachment-preview** sheets (Done seeded → filled+ring).
Cancel buttons moved ghost/default → `outlined+action` so the focused one promotes to
filled+ring like the confirm popovers.

**TugInput brought into the focus system (2026-06-07).** `TugInput` gained the standard
`useFocusable` opt-in (`focusGroup` / `focusOrder` / `focusPolicy`), composing the
focusable ref with the responder's `composedRef` so one `<input>` carries both
`data-responder-id` and `data-tug-focusable`; the engine lands the key view on the real
caret and a text field never consumes Tab (default `consumesTab=false`). Backward
compatible — un-authored inputs are unchanged. Exposed it: the **permissions** filter
field, add-rule accordion, and rule list now join the tab walk (tab bar → add-rule →
filter → list → Done); **rename** authors its name field as order 0 and **seeds the
field** (caret on open, text-first) with Save resting at its tint and promoting on Tab —
the manual `autoFocus` is retired in favor of the engine seed.

**Ring vs. Return-target (2026-06-07; rule refinement).** The ring and the fill answer
two different questions — **ring = where keystrokes go (the key view); the live control
= what Return commits.** They coincide on one control everywhere *except* a text-first
commit sheet, where the caret is in the field (ring) but Return commits the default. The
rule: when the key view is a single-line **text field** (which delegates Return to the
surface default), the field wears its caret ring AND the default `primary` commit button
ALSO wears a **ring** ("Return commits here") — ring only, the default keeps its quiet
tint since keystrokes don't go there. The instant focus moves to a **button**, the field
is no longer the key view, the extra ring comes off the default, and the focused button
owns the ring and its own Return (a focused button claims Return, [P12]). Implemented as
the app-owned `[data-return-default-scope]:has(.tug-input[data-key-view-kbd])
.tug-button-primary-action` ring in `focus-ring.css` (opt-in per surface so multi-field
sheets like the permissions filter, where Return does NOT delegate to a single default,
are unaffected); `/rename` opts in and moves its `Enter`→submit onto the field so a
focused Cancel cancels (never saves). (`TugTextarea` /
`TugValueInput` can take the same opt-in if a surface needs it.) The Recently-denied
permissions tab renders a static row `<div>` (not a `TugListView`), so it stays
tab-bar → Done only.

**Audit completion — alert / settings / compaction (2026-06-07).** Three more
dev-card sheets were missing the seed: the **alert sheet** (`tug-alert-sheet`, the
`presentAlertSheet` "Unknown command" / confirm alerts) — its confirm button now
authored + seeded (action → filled+ring, danger keeps its fill), Cancel `outlined+action`;
the **settings sheet** (`SettingsSheetBody`, the title-bar "…" menu) — Done authored +
seeded, the stale native `autoFocus` retired in favor of the engine seed; and the
**compaction-progress** sheet — its transient Cancel authored into the trap (so Tab
reaches it / it rings) but deliberately NOT seeded (a progress sheet has no commit
default; a solid-filled Cancel would misread as a primary action).

**Sheet-host unification (2026-06-07).** `usePermissionRulesSheet` owned its *own*
`useTugSheet()` host, separate from the shared `cardPickerSheet` the chips/pickers use
— so `/permissions` and a Z4B picker (e.g. effort) rendered as two independent,
stacked sheets: opening effort over an open `/permissions` showed permissions on top,
and Done dismissed only one host while the other stayed up ("Done dismisses neither").
Fixed by passing the card's shared `showSheet` into `usePermissionRulesSheet` (dropping
its internal host + `renderRulesSheet`), so the editor and every picker occupy ONE
sheet at a time with replace-on-open semantics. (The `DevProjectPicker` pre-session
host and the store-backed `useCardSettings` "…" host remain separate by design.)

**Artifacts:** popover/sheet/alert + inline-dialog shell focus CSS; the inline-dialog **option rows**; the sheet/dialog/alert commit buttons (`primary` adoption); a menus audit note.

**Tasks:**
- Box-scope ring (box-shadow hugging the radius, no reflow) + the quiet within variant; behind-tint where the surface allows ([Q02]).
- **MANDATORY — adopt `primary` for EVERY sheet / dialog / alert commit button** ([P14], primitive landed in [#step-primary]). This is not optional polish: until it is done, every un-migrated surface still shows an idle `filled+action` default that impersonates a selected row — the exact bug [#step-primary] fixed for the picker, left standing everywhere else. Switch `emphasis="filled"` → `emphasis="primary"` on each surface's recommended-default (Open / Save / Done / Confirm / Retry — **action-role text commits**). Work the inventory below to zero; each is a `<TugPushButton>` (or `SheetCloseButton`) that is the surface's commit/default:
  - [x] `cards/dev-card.tsx` — spawn-error "Choose Directory" retry; the telemetry sheet's "Done"
  - [x] `cards/model-picker-sheet.tsx`, `cards/effort-picker-sheet.tsx` — confirm/commit
  - [x] `cards/skills-sheet.tsx`, `cards/agents-sheet.tsx`, `cards/memory-sheet.tsx`, `cards/hooks-sheet.tsx`, `cards/help-sheet.tsx` — commit/done
  - [x] `cards/rename-session-sheet.tsx`, `cards/rewind-sheet.tsx` — commit
  - [x] `cards/permission-rules-editor.tsx` (both filled commits), `cards/permission-mode-chip.tsx`, `cards/dev-attachment-preview.tsx`
  - [x] `cards/tool-blocks/ask-user-question-tool-block.tsx` — submit
  - [x] `tug-alert.tsx`, `tug-alert-sheet.tsx`, `tug-confirm-popover.tsx`, `chrome/tug-pane.tsx` — the surface/shell default
  - **Exclude** (leave on `filled`, by [P14]): standalone CTAs with no competing controls — the jump-to-bottom FAB, prompt-entry submit/queue, any other `subtype="icon"` affordance — and the gallery `filled` *demos* (they exist to show `filled` itself).
  - **Danger confirms** (e.g. `tug-confirm-popover`'s Trash) are a judgment call, not a blanket convert: red does not conflate with selection-blue, but `primary danger` exists if the surface wants the quiet-at-rest behavior. Decide per surface and note it.
- **Inline-dialog option rows** (the scope/question choices — item-group *items* inside the modal, distinct from the Deny/Allow/Next buttons handled in [#step-2]): give them the item-group treatment from [#step-3] (cursor ring + native fill, role-resolved), replacing the bespoke `[data-key-cursor]` border-recolor in `dev-permission-dialog.css` / `dev-question-dialog.css`.
- **Menus audit (`TugContextMenu`, `internal/tug-popup-menu`):** confirm they are Radix-highlighted and do **not** carry the engine `[data-key-cursor]` attribute, so the global cursor→ring flip ([#step-1]) does not reach them — record this as no-change, or add a scoped override only if the audit finds otherwise.

**Tests:**
- Behavior: surface + dialog + menu app-tests green (Escape/trap/restore unchanged — engine untouched).
- **Completeness gate (falsifiable):** after the sweep, **no sheet / dialog / alert default remains a resting solid fill**. Concretely — every remaining `emphasis="filled"` `role="action"` text (non-`subtype="icon"`) commit button is either a deliberate standalone CTA or a gallery demo; nothing in the inventory above is still `filled`. Re-grep `emphasis="filled"` across `tugways/` and confirm each survivor against the exclude list.
- Live-build pass: open each surface and both menus; confirm the box focus + dialog option-row cursor read in both themes; menu highlight unchanged; **each migrated commit button rests as the badge/tint and fills + rings only when it holds the key view.**

**Checkpoint:** `tsc` clean; surface/dialog/menu app-tests green; live-build confirmation; menus audit recorded; **commit-button completeness gate met — the picker's prominence fix now holds app-wide ([P14]), with every survivor of the `filled` grep justified.**

#### Step 7.5: Default-action ring + single-select list keyboard model {#step-7-5}

**Depends on:** #step-1, #step-3 (item-group cursor model), #step-5 (list/descend), #step-7 (sheets on the shared host)

**Commit:** `focus(lists): single-select keyboard model; default-action ring`

**References:** [P01], [P02], [P12], [P14], (#language-contract), (#p14-primary-emphasis)

**Motivation (by-eye, 2026-06-07).** Two findings from driving the card sheets by keyboard:
1. **List views should be single-select-by-arrow.** In a single-select picker (rewind turns, session recents/sessions, effort/model/permission-mode levels) the arrow keys should **move the selected row immediately** — no separate movement cursor + Space-to-commit. The current item-group model (arrows move a `data-key-cursor`, Space selects, Enter acts/descends — [#step-3]/[#step-5]) is right for **multi-select / descendable** lists but wrong for these single-pick lists.
2. **The default action should keep its ring.** In a sheet whose **only** Return consumer is its default action (no text entry, or a single one — `/rename`, the pickers, alerts), the default commit button should wear the focus ring **the entire time the sheet is open** ("Return's home"), even while the keyboard focus / caret is on the list or the field. This is the generalization of the `/rename` field→default ring the by-eye pass landed.

The two are linked: (2) is only unambiguous once (1) holds, because a single-select list must **not consume Return** — Return must fall through to the default action.

**Design decisions:**
- **`persistentDefaultRing` is a component API, opt-in per button — NOT a CSS recognition rule** (user directive). A surface tags its sole-Return-consumer default button; nothing inspects field focus. Multi-control surfaces where another control may claim Return (`/permissions`) simply do not opt in.
- **Single-select is expressed as a single-selection list mode, not a "live-select" flag** (user preference): the concept is "this list has one selected row that the arrows move," applied only to lists that support a single-selected-row model.

**DONE this turn (committed in this step's first commit; uncommitted at authoring):**
- ✅ **`persistentDefaultRing` button prop** — `internal/tug-button.tsx` adds the prop → `data-default-ring=""` on the `<button>`. `internal/tug-button.css`: a `.tug-button[data-default-ring]:not(:disabled):not([aria-disabled="true"])` outline ring (role-resolved via the existing role-ring axis), and the `outlined`/`primary`→filled promotion `:is(...)` selectors extended to also match `[data-default-ring]` (so a `primary` default fills persistently; a `filled` default just gains the ring). Suppressed while disabled.
- ✅ **`/rename` migrated to the API** — removed the `data-return-default-scope` attribute + the `[data-return-default-scope]:has(.tug-input[data-key-view-kbd]) .tug-button-primary-action` rule from `styles/focus-ring.css` (replaced with a pointer comment); rename's Save now carries `persistentDefaultRing`. The field is still engine-seeded (caret on open) and its `onKeyDown` commits Enter.

**KEY ENGINE FINDING (the crux of the pending work).** `focus-act.ts` `resolveFocusAct` makes an **item-container always consume Enter** — `if (key === "Enter") return declaration.currentItemDescendable ? "descend" : "act";`. So a *focused* list eats Return; it never reaches the default button. That is exactly why the pickers today seed the **OK button** (not the list) — Enter works, but arrows never reach the list. To get *both* (arrows in the list **and** Return → default) a single-select list must resolve Enter to **`passthrough`**, which is a small additive engine change.

**TASKS (pending — drive from here in a fresh context):**

1. **Engine: single-select Enter passthrough.** Add a flag to `KeyViewBehavior` (e.g. `singleSelect?: boolean` or `actDelegatesToDefault?: boolean`) and honor it in `focus-act.ts` `resolveFocusAct`: when `container === "item"` **and** the flag is set, resolve `Enter` to `"passthrough"` (do not `act`) so the keydown bubbles to the scope default (the `pushDefaultButton` Enter→click routing in `responder-chain-provider`). Space may still `select` (harmless — selection already follows the cursor). Keep all existing item-container behavior unchanged when the flag is absent. Verify on a real app-test that Enter in a focused single-select list fires the sheet's default, not a row act.

2. **`TugListView` single-select mode.** Add a prop (name to settle — `singleSelect`) that: (a) sets the new behavior flag so Enter passes through; (b) makes the **arrow / Home / End** movement *also select* the landed row — i.e. selection follows the cursor (`moveCursorTo` + `selectCursorRow` together), so there is always exactly one selected row and no Space step is needed; (c) seeds the list itself as the key view on open (so arrows work immediately) with the first selectable row selected. The cursor-as-distinct-from-selection multi-select path ([#step-3]/[#step-5]) stays the default when the prop is absent. The list keyboard handler lives in `tug-list-view.tsx` (~L2270 `behavior` declaration: `onSelect`/`onAct`/`onDescend`; ~L2348+ the capture-phase movement handler: `ArrowDown`/`ArrowUp`/`Home`/`End`/`Page`).

3. **Apply to the picker sheets** — add `singleSelect` to the list(s) and `persistentDefaultRing` to the default button, and re-point each sheet's seed from the OK button to the **list**:
   - `effort-picker-sheet.tsx`, `model-picker-sheet.tsx`, `permission-mode-chip.tsx` — list `singleSelect`; OK `persistentDefaultRing`; seed the list (currently seeds OK).
   - `rewind-sheet.tsx` — turn list `singleSelect` (already seeds the list); Rewind `persistentDefaultRing`. **Coupling:** with `singleSelect` the first row auto-selects on open, so Rewind is enabled → its persistent ring shows (the disabled-suppression in the CSS otherwise hides it). The existing sheet-div `onKeyDown` Enter→apply can be removed once Enter passes through to the default via the engine.
   - `dev-card.tsx` `DevProjectPickerForm` (the session picker) — recents + sessions lists `singleSelect`; Open `persistentDefaultRing`; the picker is persistent-cycling with a path **text field**, so it still seeds the field/Open per its existing `armKeyboardRestore` logic — confirm Open's ring + Return coexist with the field (this is the "one text entry" case, like `/rename`).
4. **Alerts / Done-only sheets** — optionally add `persistentDefaultRing` to the alert confirm and the Done-only sheet commits so the default rings even when Tab moves to a secondary control. Lower priority (their seed already keeps the default ringed while focus stays on it).

**Tests:**
- Engine: a new/extended app-test — focus a `singleSelect` list in a sheet, press Enter, assert the sheet's **default action** fired (not a row act); arrow keys move `data-selected` directly (no Space).
- Behavior: `at0097` (rewind) + the picker app-tests stay green; `at0090`/`at0094` (permissions, which does NOT opt in) unchanged.
- By-eye: rewind/session/effort open with the first row selected + the default ring lit; arrows move the selection; Return commits the default; both themes.

**Checkpoint:** `tsc` clean; engine + picker app-tests green; by-eye single-select + persistent default ring on rewind/session/effort/model/mode; `/permissions` unchanged (no opt-in); the `persistentDefaultRing` CSS suppresses on disabled.

**STATUS — done (2026-06-07).** The `persistentDefaultRing` API + `/rename` migration + the `/rename` `:has`-rule undo landed in this step's first commit. The single-select list keyboard model then landed: the engine `singleSelect` Enter-passthrough (`focus-act.ts` + the inherited `KeyViewBehavior`), the `TugListView` `singleSelect` / `initialSelectedIndex` / `seedSelection` props (arrows move + select via the capture handler, the gain-seed lands the cursor on the active row and — under `seedSelection` — commits it; Enter resolves to passthrough), and application to the effort / model / permission-mode / rewind pickers and the session picker.

Implementation note ([P12], beyond the original task list): the gain-seed split into **`singleSelect`** (cursor-only seed; selection follows explicit arrow movement) vs **`seedSelection`** (also commit the seeded row on open). Confirm pickers that must enable their default action on open use `seedSelection` (rewind auto-selects its first turn so Rewind enables and its ring lights); the session picker's recents/sessions lists use `singleSelect` WITHOUT `seedSelection`, so merely cycling the key view onto a list never commits a row — a recents list must not overwrite a typed path the instant it gains focus. Open carries `persistentDefaultRing` (the "one text entry" case, like `/rename`). Verified: new `at0142` (list is key view on open + first row auto-selects + ArrowDown moves selection with no Space + Enter fires the default action), `at0097` rewind, `at0090`/`at0094`/`at0105` permissions (no opt-in, unchanged), `at0106`/`at0100`/`at0058` sheet focus, `at0141` picker keys, `at0116`–`at0120` item-container focus, `at0109`/`at0112` focus visuals — all green; `tsc` + 232 pure-logic tests green. (`at0088`/`at0096` fail identically on HEAD — pre-existing chip-rendering/metadata assertions unrelated to focus.)

#### Step 7.6: Inline-dialog card-modal focus & keyboard model — PermissionDialog (then QuestionDialog) {#step-7-6}

**Depends on:** #step-2, #step-3, #step-5, #step-7, #step-7-5

**Commit:** `N/A (umbrella — see #step-7-6-archetypes … #step-7-6-vet)`

**References:** [P16], [P17], [P18], [P19], [P02], [P12], [P13], [P14], [Q06], [Q08], [Q09], Risk R04, (#p16-card-modal, #p17-dialog-archetypes, #p18-no-deadzone, #p19-scrim, #language-contract)

**Motivation (by-eye, 2026-06-08).** Driving a pending `PermissionDialog` by keyboard surfaced four defects, all rooted in the same cause — the dialog is built as a **modal-for-keys trap** (`useInlineDialogModal` + `useFocusTrap`) that registers the whole dialog as **one full-width `tabIndex=0` item-container** whose cursor roams a flat `[Deny, Allow, …scope options]` list:

1. **No way to descend into the scope options** (Allow once / Allow for this project) — they are undifferentiated cells in the flat cursor list, not a distinct group you can enter.
2. **Arrows move the highlight off *both* Deny and Allow** — the cursor keeps roving into the heterogeneous option rows, leaving the action buttons unmarked.
3. **Deny / Allow do not follow the filled+action+ring conventions** — both render `emphasis="outlined"` (never migrated to [P14] `primary`), so there is no resting recommended-default ("Return's home") affordance.
4. **Clicking the empty space under the dialog paints an odd "wide focus ring"** — a click lands DOM focus on the full-width `tabIndex=0` scope wrapper and the engine projects a key-view / `data-key-within` mark on a transcript-row-sized element; a meaningless state.

The design question this raised — should the inline dialog *join* the card's Tab loop, or be *card-modal* (inline display, trapped focus)? — was decided in favor of **card-modal** ([P16]): a permission request is a blocking decision, so it should own the keyboard, not sit as peer chrome. The earlier "join the walk" proposal is recorded as superseded in [P16] / [Q07] / R03.

**Approach.** [P16] keeps the dialog **card-modal** — inline display, **trapped** focus (the `useFocusTrap` the dialog already pushes), confirming the [P13] persistent-trapped classification rather than amending it; [P17] decomposes the dialog into focus-language archetypes registered **into that trap** (Deny/Allow leaf buttons with [P14] `primary`/`persistentDefaultRing`; scope choices as a single radio item-group, [P02] + [#step-7-5] single-select); [P18] removes the dead-zone wrapper so inert chrome establishes no focus state; [P19] **scrims the card content outside the dialog** so the modality is felt. This is a [P04]-consistent refinement (fix the trap's contents, not the engine). **PermissionDialog leads; QuestionDialog follows** ([Q08]).

**State Zone Mapping:**

| State | Zone | Mechanism | Law |
|-------|------|-----------|-----|
| Dialog controls (which holds the key view) | structure | engine focus-mode stack — dialog controls `useFocusable` into the trap's mode via `FocusModeContext` | [L02], [L22] |
| "A dialog is pending" (drives the trap + the scrim) | local-data → derived | `inlineDialogPending` from store via `useSyncExternalStore`; `useFocusTrap({active})` + a `data-*` scrim signal on the card root | [L02], [L06] |
| Selected scope (Allow once / project) | local-data | `useState` + [A9] preservation (unchanged) | [L23], [L24] |
| Allow=primary tint→fill, persistent ring; Deny danger promote; scope cursor/tint/fill | appearance | CSS keyed on engine `data-*` attributes; `emphasis`/`persistentDefaultRing` props | [L06], [L24] |
| Scrim on card content outside the dialog | appearance | CSS keyed on the card-root `data-*` signal; dialog + subject row opt out | [L06] |
| Inert-chrome click establishes no focus | structure | remove `tabIndex=0` focusable wrapper | [L06] |

**Sub-steps:** [#step-7-6-repro] (repro + decisions lock), [#step-7-6-archetypes] (archetype decomposition into the trap + emphasis), [#step-7-6-modal] (kill the dead-zone + scrim + verify the trap), [#step-7-6-question] (QuestionDialog), [#step-7-6-vet] (integration checkpoint).

---

#### Step 7.6.1: Repro the four PermissionDialog defects; lock decisions {#step-7-6-repro}

**Depends on:** #step-7-5

**Commit:** `test(focus): pin current inline-dialog keyboard defects (pre-redesign)`

**References:** [P16], [P17], [P18], [Q06], (#p16-card-modal)

**Artifacts:** a new `tests/app-test/at0145-permission-dialog-keyboard.test.ts` that drives a pending permission dialog and **documents the current behavior** (the four defects), so the redesign steps have a falsifiable before/after; resolved [Q06] recorded in the plan.

**Tasks:**
- Stand up a pending `PermissionDialog` in an app-test (seed a `control_request_forward` with `is_question:false` + `permission_suggestions` so the scope options render). Reuse the `at0144` harness shape (`/model` path won't do — needs a real permission request; check how `dev-permission-dialog.test.ts` / existing permission app-tests seed one).
- Assert the **current** state as documentation (mark these `expect`s as the pre-redesign baseline): the scope wrapper carries `tabIndex=0`; the dialog is one item-container; Deny/Allow are `outlined`.
- (Decisions already locked: [Q06] = plain radio choice group; [Q07] obviated by the card-modal decision. Nothing to resolve here beyond confirming the repro.)

**Tests:**
- The new app-test runs green describing current behavior (it will be rewritten to the target behavior in [#step-7-6-modal]).

**Checkpoint:**
- [ ] `just app-test at0145-permission-dialog-keyboard` → `VERDICT: PASS` (documents current behavior).
- [ ] [Q06] resolved (plain radio choice group); [P16]–[P19] confirmed with the user.

---

#### Step 7.6.2: PermissionDialog → focus-language archetypes {#step-7-6-archetypes}

**Depends on:** #step-7-6-repro

**Commit:** `focus(dialog): decompose PermissionDialog into leaf buttons + radio item-group`

**References:** [P17], [P02], [P14], [P12], [Q06], (#p17-dialog-archetypes, #p14-primary-emphasis)

**Artifacts:** `dev-permission-dialog.tsx` (Deny/Allow as leaf focusables; scope choices as a radio item-group), `dev-permission-dialog.css` (shed bespoke modal-scope rules), the [P14] emphasis adoption.

**Tasks:**
- **Allow** → `emphasis="primary"` + `persistentDefaultRing` (the recommended default; rests at the badge tint, promotes to fill+ring on engage, keeps the "Return's home" ring while open).
- **Deny** → `emphasis="outlined" role="danger"` (promotes to filled-danger + danger ring when it holds the key view).
- **Scope choices** → a single **radio choice group** stop ([P02], [#step-7-5] single-select: arrows move the selected scope, selection follows the cursor, no Space; Return falls through to Allow; per [Q06], DECIDED — no descend level). Replace the bespoke flat-container cursor mixing in `PermissionDialogModal` for the options.
- Keep the round-trip semantics unchanged (Allow-with-scope, Deny ignores scope, `respondApproval`).

**Tests:**
- Behavior: scope selection still round-trips the chosen `update`; Deny/Allow still call `respondApproval` with the right decision (existing `dev-permission-dialog.test.ts` pure-logic assertions stay green).
- By-eye: Allow rests as the badge tint with the persistent ring; arrows within the scope group don't wander onto the buttons; both themes.

**Checkpoint:** `tsc` clean; pure-logic tests green; by-eye archetypes correct in both themes.

---

#### Step 7.6.3: Card-modal polish — kill the wide-ring dead-zone; scrim the card; verify the trap {#step-7-6-modal}

**Depends on:** #step-7-6-archetypes

**Commit:** `focus(dialog): card-modal inline dialog — no dead-zone, scrimmed surround`

**References:** [P16], [P18], [P19], [P13], [P12], Risk R04, [Q09], (#p16-card-modal, #p18-no-deadzone, #p19-scrim)

**Artifacts:** `dev-permission-dialog.tsx` (per-control focusables in the trap; no full-width focusable wrapper; `useInlineDialogModal` retired), `dev-permission-dialog.css` (dead-zone rules removed), the card / dialog **scrim** CSS + the card-root `data-*` signal, `use-inline-dialog-scope.ts` (retired or demoted).

**Tasks:**
- **Trap stays, contents fixed.** Confirm the dialog keeps its `useFocusTrap` mode ([P16]); the [#step-7-6-archetypes] controls are the only focusables in it. Seed the key view onto **Allow** on open (`armKeyboardRestore` / the existing focus-on-mount) so Return commits and the ring lands home. Tab cycles Deny → Allow → scope group → wrap; **Escape / Cmd-. → Deny** via the scope's `CANCEL_DIALOG` responder (unchanged). The editor stays deactivated and excluded (already wired).
- **Remove the dead-zone** ([P18]): drop `tabIndex={0}` + the focusable role from the full-width wrapper; delete the `.dev-permission-dialog-scope[data-key-view-kbd]` ring-relocation rules (the box ring now comes from the real controls / the surface box-scope ring).
- **Scrim the surround** ([P19]): add a derived `data-*` signal on the card root keyed on `inlineDialogPending` (from store via `useSyncExternalStore`), and CSS that dims the chrome (Z2/Z4/Z5) + non-dialog transcript content while the pending dialog **and its subject tool-call row** stay bright. Settle the scoping technique ([Q09]); keep it a quiet scrim, not a blackout.
- **Retire `useInlineDialogModal`** (and the modal-for-keys plumbing) once PermissionDialog no longer uses it; leave a pointer if QuestionDialog still references it until [#step-7-6-question].

**Tests:**
- Rewrite `at0145` to the **target** behavior: open a pending dialog → Tab cycles Deny → Allow → scope group → wraps (trapped, never escapes to the chrome/editor); Escape on a dialog stop fires **Deny**; a native click on inert dialog chrome leaves **zero** `data-key-view*` / `data-key-within` marks; Allow holds `data-default-ring` while open and exactly one filled+ring shows at a time ([#step-7-5]/at0144 invariant); the card root carries the scrim signal while pending and clears on resolve.
- Behavior: existing permission app-tests green; the resolve→caret return still works.

**Checkpoint:** `tsc` clean; `at0145` green at target behavior; permission app-tests green; by-eye scrim reads as modal in both themes with the dialog + subject legible (Risk R04); **cross-check tuglaws — name [L02]/[L06]/[L22] in the commit body** (engine focus-mode stack + appearance via attributes; external pending-state via `useSyncExternalStore`).

---

#### Step 7.6.4: QuestionDialog adopts the model {#step-7-6-question}

**Depends on:** #step-7-6-modal

**Commit:** `focus(dialog): QuestionDialog card-modal; archetype decomposition`

**References:** [P16], [P17], [P19], [Q08], (#p16-card-modal, #p17-dialog-archetypes, #p19-scrim)

**Artifacts:** `dev-question-dialog.tsx` (Cancel/Submit/Back/Next leaf stops; per-question option groups as item-group stops; wizard state logic unchanged), `dev-question-dialog.css` (shed modal-scope rules; opt out of the scrim).

**Tasks:**
- Apply [Q08]'s resolution (lean: same model). Option groups → item-group stops; Cancel / Submit / Back / Next → leaf stops, all **inside the trap**; Submit = `primary` (already migrated in [#step-7]) + `persistentDefaultRing` consideration. Wizard auto-advance / review / `[A9]` preservation unchanged (state, not focus).
- Inherit the scrim ([P19]): the question dialog subtree opts out of the card dim like the permission dialog.
- Retire the dialog's `useInlineDialogModal` usage; finish deleting the hook if both dialogs are now off it.
- Keep `Cancel ≡ Esc ≡ popInteractive` and the confirm-popover guard.

**Tests:**
- Existing question app-tests + pure-logic tests green (answers round-trip, auto-advance, review gate).
- New/extended app-test: Tab cycles the wizard within the trap; Escape cancels; the wizard's Back/Next/Submit work by keyboard.

**Checkpoint:** `tsc` clean; question app-tests green; by-eye wizard keyboard flow + scrim in both themes; tuglaws named in the commit body.

---

#### Step 7.6.5: Integration checkpoint + tuglaws note {#step-7-6-vet}

**Depends on:** #step-7-6-modal, #step-7-6-question

**Commit:** `N/A (verification only)`

**References:** [P16], [P17], [P18], [P19], [P13], (#success-criteria)

**Tasks:**
- Composed pass: open a pending permission dialog **and** a pending question dialog (in turn) on a connected dev card; confirm card-modal behavior (focus trapped in the dialog, seeded on the default; Tab cycles only the dialog; Escape → cancel), the scrim reads as modal with the dialog + subject legible, no wide-ring, the [P14] default affordance, both themes, keyboard vs mouse.
- Record the [P16] inline-vs-overlay rider for the [#step-9] tuglaws doc (inline display ≠ non-modal focus; a blocking in-flow dialog is card-modal + scrimmed; floating overlays stay trapped) — note it; the doc itself lands in [#step-9].

**Tests:**
- Full `just app-test` permission + question + sheet sweep green; `bun test` green; `bunx tsc --noEmit` clean.

**Checkpoint:** all gates green; the four defects fixed by eye; [P16]–[P19] satisfied; [P13] classification confirmed (persistent-trapped) in the plan.

---

#### Step 7.7: Focus-scope audit + per-card focus contexts {#step-7-7}

**Depends on:** #step-7-6, #step-cycle, #step-7

**Commit:** `N/A (umbrella — see #step-7-7-audit … #step-7-7-vet)`

**References:** [P20], [P21], [P16], [P13], [P09], Risk R05, (#p20-dialog-is-destination, #p21-card-scoped-modes, #r05-global-modestack, #cycle-model)

**Motivation (by-eye, 2026-06-08).** A pending `QuestionDialog` is card-modal, but **switching away from the card (to another card, to another app) and back does not restore the focus scope** — on return the dialog is inert (no seeded ring, modality not felt). This is the latest of a string of focus-scope defects (cross-card Tab leak; descend over-containment; double-ring), all symptoms of one under-engineered seam: **a single deck-wide `FocusManager` with one global `modeStack`, and activation-focus that has no concept of a card-modal dialog.** Enough whack-a-mole — this step is a **top-to-bottom audit** of every focus scope the product now supports, a verdict on each, and the fixups the audit proves necessary. The bar is *solid, ready-for-prime-time* code: no band-aids, the engine the single owner.

**Audit scope — the focus-scope features the product must support** (the audit gates each as **SOLID** / **FIXUP**):

| # | Feature (focus scope) | Required behavior | Primary code | Verdict |
|---|-----------------------|-------------------|--------------|---------|
| A | Card focus-cycle (⌥⇥) | Trapped per-card mode; Tab cycles chrome zones; commit-disposition relinquish; **mouse exits**; pop on unmount; restore editor caret | `use-cycle-mode.tsx` | **SOLID** — clean push/seed/pop; `useSyncExternalStore` truth; unmount + mouse-exit safety. Audit only confirms it survives [P21]. |
| B | Sheet modality | Pane-modal (not app-modal); Tab trapped; Escape/⌘. dismiss; opener key-view restored on close; descend into accordion/list inside the sheet = locked loop | `tug-sheet.tsx` + `use-focus-trap.tsx` + Radix `loop` + pane `inert` | **SOLID (post-fix)** — cross-pane Tab leak fixed by walk-containment (`walkModeSet`, commit `821e5fd4`); relies on Radix `loop` + `inert` for native-only tabbables. Re-verify under [P21]. |
| C | Card-modal inline dialogs | Inline display + trapped focus; seed default on open; scrim + pointer-events modal barrier; Escape→Deny/Cancel; scroll-entire-dialog-into-view; auto-advance + ring-flash; **survive card / app switch** | `dev-permission-dialog.tsx`, `dev-question-dialog.tsx`, `use-inline-dialog-scope.ts` | **FIXUP** — everything green EXCEPT survival across (re)activation: the seed is one-shot on `active`, and the card's `paintMirrorAsActive` refocuses the editor on return ([#focus-restore-audit]). [P20] + [P21]. |
| D | Descend scopes | Accordion section / list row: locked Tab loop; Escape ascends | `tug-accordion.tsx`, `tug-list-view.tsx`, `focus-manager.ts#walkModeSet` | **SOLID (post-fix)** — containment fixed (commit `821e5fd4`); `trapped` governs Escape only. |
| E | Item-groups | Tab to group; arrows rove cursor; Space/Enter commit; keyboard cursor authoritative over hover | `use-item-group-keyboard.ts`, `tug-radio-group`/choice/option/list | **SOLID** — double-ring (hover-over-cursor) fixed; cursor/ring model consistent. |
| F | Cross-card containment | A background card's pushed modes must never be the active card's `currentFocusMode` | `focus-manager.ts` (one global `modeStack`) | **FIXUP** — Risk R05; the structural root. [P21]. |
| G | Activation focus restore | Card switch / pane activation / cross-pane move / window blur→focus / cold boot all land focus on the card's correct destination | `focus-transfer.ts#applyBagFocus`, `paintMirrorAsActive` | **FIXUP** — the path is principled but has no card-modal-dialog branch; it always restores the editor. [P20]. |

**Findings (grounded):**
- **C/G — the reported bug.** `useInlineDialogScope` seeds the key view via `useSeedKeyView(active ? key : null)` — fires only when `active` flips, never on re-activation. The card's activation-focus hook `paintMirrorAsActive` (`tug-prompt-entry.tsx`) unconditionally calls `editor.paintMirrorAsActive(...)` with **no `inlineDialogPending` branch**. So returning to the card focuses the editor; the dialog's trap is still on the stack but its ring/currency is gone. {#focus-restore-audit}
- **F — the structural root (R05).** One deck-wide `FocusManager` / `modeStack` (`deck-manager.ts` single `reactRoot.render`; `ResponderChainProvider` mounted once). A background card's dialog stays mounted at `display:none`, so `useFocusTrap`'s effect never pops its trap; that trap is `currentFocusMode` while another card is active. `walkModeSet` bounds the *walk* to the top mode but not *which card owns it*.
- A–B, D–E are **solid** as of the recent fixes; the audit's job for them is a **regression matrix**, not new work — [P21] must not regress cycle pop-on-unmount / mouse-exit, sheet opener-restore, or descend ascend.

**Approach — one structural fix, no interim band-aid.** The fix is **per-card focus contexts** ([P21], the key-window model): extract a per-card `FocusContext` (mode stack + key view + focusables) and recast `FocusManager` as a deck coordinator routing to the **key card's** context ([#step-7-7-cardscope]). This dissolves R05 and *all* its symptoms together — the reported restore bug, the cross-card Tab leak, the activation gap — because each card's focus universe is independent and preserved by construction. [P20] (a pending dialog is the card's destination, fixing the user's reported bug) **falls out**: the restored context already holds the dialog as its top mode + key view.

A separate "interim editor-yield" patch was considered and **dropped** — it is an admitted band-aid (the user's standing directive: no band-aids), and its wiring (the editor reading `inlineDialogPending`; `useInlineDialogScope` subscribing to re-activation) is most of the real work [P21] does properly and then discards. We do it right once. Explicitly **not** the alternative band-aid either — tagging each mode with a card id and demultiplexing the shared stack keeps the wrong shape.

**State Zone Mapping:**

| State | Zone | Mechanism | Law |
|-------|------|-----------|-----|
| Which mode is current / serviced | structure | per-card `FocusContext` (mode stack + key view); deck coordinator routes to the key card's context | [L02], [L22] |
| "A card-modal dialog is pending" (routes activation focus) | local-data → derived | `inlineDialogPending` via `useSyncExternalStore`; consulted by the activation-focus path | [L02] |
| Dialog key view re-seed on reactivation | structure | `useInlineDialogScope` subscribes to card activation, re-seeds the default | [L03], [L22] |
| Ring / scrim appearance | appearance | unchanged — CSS on engine `data-*` | [L06] |

**Sub-steps:** [#step-7-7-audit] (this report + the regression matrix as living tests), [#step-7-7-cardscope] (the [P21] per-card focus contexts — delivers [P20] and the reported-bug fix), [#step-7-7-vet] (full matrix green).

---

#### Step 7.7.1: Feature-driven focus-scope audit report + regression matrix {#step-7-7-audit}

**Commit:** `docs(focus): Step 7.7 focus-scope audit report`

**References:** [P20], [P21], Risk R05, (#step-7-7)

**Tasks:**
- Land the audit table + findings above in the plan (this step's deliverable is the report itself).
- Enumerate the **regression matrix** the fixups must keep green, as a checklist the later sub-steps turn into tests: (A) ⌥⇥ cycle enter/Tab/commit-relinquish/mouse-exit/unmount-pop; (B) sheet open → Tab-trapped → descend accordion (locked) → Escape ascend → Cmd-. dismiss → opener key-view restored; (C) permission + question present → seeded → **switch card away/back** + **window blur/focus** → still modal + ringed → resolve; (D) descend lock + Escape ascend; (E) item-group cursor vs hover.
- **(F) Persistence boundaries** — a focus scope is never serialized; it re-derives from durable state on mount ([D13]/[A9] for a card-modal dialog) or evaporates if it was a transient gesture. The matrix asserts both directions:
  - **F-durable:** a card-modal dialog is pending → **Developer > Reload** and **app relaunch** → the dialog returns **modal + seeded** (the cold-boot restore, `applyBagFocus(..., {site: "cold-boot"})`, must land the dialog as the card's key view, not the editor — the *same* [P20]/[P21] seam as the card-switch case, just a different trigger).
  - **F-transient:** a ⌥⇥ cycle / a descend is in progress → **Reload / relaunch** → it does **not** come back (transient gestures, no durable source); only the resting key view is restored.
  - **F-HMR:** HMR keeps the `FocusManager` alive while remounting components — so the goal is **robustness, not preservation**: remounting a dialog / radio / cycle component leaves **no stale rings, no double-trap, no double-seed** (the class of HMR bugs already hit). A rebuilt `FocusContext` ([P21]) is the structural guard; a pure-logic test exercises register→unregister→re-register under one manager.
- Identify which matrix rows already have app-tests (at0140/at0141/at0145/at0146/at0147/focus-walk) and which are **new** — the switch-away-and-back cases (C), the reload/relaunch dialog-survival cases (F-durable), and the HMR re-register robustness (F-HMR, pure-logic).

**Harness capability (confirmed before writing C/F tests, per the [#step-7-7-cardscope] gotcha — no silent gap):** the boundary triggers are *already* harness-reachable; the existing focus app-tests drive them and become the regression base the fixup extends:
- **C (card switch):** `at0080-dev-focus-card-switch` already seeds two dev cards and switches between them — the multi-card / active-card-switch capability the C cases need.
- **C (cross-card isolation):** `at0125-background-tab-focus-isolation` already asserts a background card's focus state does not leak into the foreground — the cross-card containment row (F) in app form.
- **C (app switch / window blur→focus):** `at0035-dev-app-switch-selection` already drives resign/return.
- **F-durable (reload):** `at0081-dev-focus-reload` already drives **Developer > Reload** and asserts focus re-derivation; `harness-smoke/smoke-app-reload` confirms the reload primitive.
- **F-HMR:** pure-logic only (a surviving-manager register→unregister→re-register in `focus-walk.test.ts`); HMR is not an app-test trigger.
- **Relaunch** (full app restart) is *not* a distinct harness primitive beyond reload; covered by-eye in [#step-7-7-vet] and called out there (no silent gap).

So the fixup adds **assertions**, not harness plumbing: the genuinely-new coverage is a *pending card-modal dialog* surviving each of those triggers (extend the at0080 / at0081 / at0035 patterns with a present-dialog precondition), plus the F-HMR pure-logic case.

**Tests:** none new here (report step); the matrix is the spec the next steps implement.

**Checkpoint:** the report enumerates every focus scope with a grounded verdict; the regression matrix is explicit; [P20]/[P21]/R05 recorded; the boundary triggers are confirmed harness-reachable (above).

---

#### Step 7.7.2: Per-card focus contexts — the key-window model {#step-7-7-cardscope}

**Depends on:** #step-7-7-audit

**Commit:** `refactor(focus): per-card focus contexts (key-window model)`

**References:** [P21], [P20], Risk R05, (#p21-card-scoped-modes, #p20-dialog-is-destination, #r05-global-modestack, #focus-restore-audit)

**Tasks:**
- Extract a `FocusContext` owning one card's mode stack + key view (id + keyboard-ness) + key-within + default-ring stack + focusable registry, with the walk/seed/project logic operating on it.
- Recast `FocusManager` as the deck **coordinator**: deck-global settings (ring modality, access mode) + the document Tab/pointer listeners + `keyCardId` + `Map<cardId, FocusContext>`; its public API delegates to the key card's context.
- Route `useFocusable` registration and `pushFocusMode` / `useCycleMode` / `useFocusTrap` into the **card's** context — card id from `CardIdContext` (`@/lib/card-id-context`, already provided by `CardHost`; flows through portals so a sheet/dialog resolves to its opening card).
- **One source of truth for the key card — pin the data-flow direction.** Today `getKeyCard()` (`responder-chain.ts`) is **focus-derived**: it reads the first-responder of kind `card`, falling back to the card containing `[data-key-view-kbd]`. Per-card contexts **invert** that: the key card is driven by **card / pane activation** (the deck's existing `activeCardId` of the key pane), `keyCardId` is the authority, and focus is *downstream* of it. So the order at activation is fixed: `onCardActivated` sets `keyCardId` → the coordinator projects **that** context's key view → `getKeyCard()`'s DOM fallback now finds the view the coordinator just projected. Projection is never an independent source; `getKeyCard` is reconciled to read `keyCardId` (its focus-derivation becomes a consequence, not a competing truth). Get this inversion wrong and you reintroduce the very divergence this step exists to kill.
- Only the key card's context projects, and it projects **all three** marks (`data-key-view(-kbd)`, `data-key-within`, `data-default-ring`). Keep `syncKeyViewDomAttribute`'s global "clear all, then stamp" as the safety net against a stale mark from a just-deactivated context.
- **Retire only the cross-card band-aids:** the *cross-card* role of `isRecordRendered` (other cards' `display:none` focusables) and `walkModeSet`'s cross-card caveat. **Keep** the *within-card* filters — `isRecordRendered` still skips hidden subtrees inside the active card; `isRecordInteractive` still skips disabled / `pointer-events:none`; `walkModeSet`'s within-context containment stays.
- **[P20] falls out** — the restored context already holds a pending dialog as its top mode + key view, so card switch / pane activation / cross-pane move / window blur→focus all re-establish the dialog with no editor-yield patch. The prompt editor's `paintMirrorAsActive` becomes one focusable inside the context (fires only when the context's key view *is* the editor), never a parallel claimant.
- **[L26] + default-context invariant:** the coordinator must service a **default/implicit context** when no key card is set — `new FocusManager()` + `registerFocusable(...)` with no `CardIdContext` (the pure-logic tests, the gallery, standalone previews) routes into that default context. Design this path **first**: the existing `focus-walk` suite must pass **unchanged** against it; per-card behavior is purely additive. Every hook stays a clean no-op with no manager.
- **Pointer-activation order:** a click on a focusable in a non-key card activates that card (swaps the key context) **before** setting its key view.
- **Safe internal ordering (within this one atomic step — keep the migration from ever being half-applied):** (a) move all current `FocusManager` state into a single internal context, behavior-identical, all tests green; (b) add the `Map<cardId, FocusContext>` + `keyCardId` routing + register-by-card (default context still serves the no-card path); (c) wire activation (set `keyCardId` → project), reconcile `getKeyCard`, delete the cross-card filters, [P20] falls out. The dash squashes the internal commits.

**Implementation notes (grounded landmarks + gotchas — captured from the 7.7 audit so a fresh implementer doesn't re-derive them; cite by symbol, line hints drift):**
- **Landmarks.** The single deck-wide manager mounts once in `deck-manager.ts` (`ResponderChainProvider` in the lone `reactRoot.render`, ~L528). `FocusManager` fields split cleanly: per-card = `focusables`, `modeStack`, `groupOrder`, `defaultActions`, `keyViewId`/`keyViewKeyboard`, `defaultRingStack`, `version`; deck-global = `ringFollowsPointer`, `accessMode`. The editor's activation hook is `paintMirrorAsActive` registered by `tug-prompt-entry.tsx` (~L1513) — it unconditionally `editor.paintMirrorAsActive(...)` and consumes `pendingActivationDraftRef`; this is the seam [P20] makes subordinate (it must still run when the context's key view *is* the editor, including after a dialog resolves). Cold-boot restore is `card-host.tsx` `applyBagFocus(cardId, store, {site:"cold-boot"})` (~L965) → `focus-transfer.ts` engine branch → `invokeEnginePaintMirrorAsActive` — the F-durable path. `getKeyCard` is `responder-chain.ts` (~L680, focus-derived — see the data-flow inversion above). `CardIdContext` is `@/lib/card-id-context`, provided by `CardHost` (~L1516).
- **Gotcha — the `cycling` [L02] consumer must not desync.** `useCycleMode`'s `cycling` boolean is a `useSyncExternalStore` over `manager.isFocusModePushed(scopeId)` + `manager.subscribe` (it reads *stack membership*, not top-of-stack, so a covering surface doesn't read as "exited"). Under per-card contexts, `isFocusModePushed(scopeId)` must resolve against the context that owns that scope (look up by scope, or the hook reads its own card's context), and `subscribe`/`version` should stay a single global notify-all (cheap; consumers re-read). Verify the cycle flag still flips correctly across enter/exit/cover/uncover after the refactor — it is the canonical [L02] focus consumer.
- **Gotcha — confirm the app-test harness can drive the boundaries BEFORE writing the C / F tests** (don't defer to manual). Needed capabilities: seed a **multi-card / multi-pane** deck (today's at0145–at0147 seed a single card), **switch the active card / pane**, **window blur→focus**, and **Developer > Reload**. Audit `tests/app-test/_harness` for these; extend it where missing, or pin which boundary checks are app-test vs pure-logic (`focus-walk`) up front. If `relaunch` isn't harness-reachable, cover it by-eye and say so (no silent gap).
- **Verify (cheap assertion):** `CardIdContext` actually resolves inside a **portaled sheet's** content (React context crosses portals, so it should — but a sheet host that renders outside the card's React subtree would break the card-id resolution the whole design rests on). One render-time check during (b).

**Tests:**
- `focus-walk.test.ts` (pure-logic, real `FocusManager`): the **existing 25 tests pass unchanged** against the default context (the no-card path), proving the refactor is additive. New cases: two card contexts; the key card's walk sees only its own focusables/modes; switching the key card swaps contexts losslessly (each card's mode stack + key view intact on return); a hidden / disabled focusable inside the active card is still skipped (within-card filters preserved). **(F-HMR robustness)** register→unregister→re-register a card's focusables + push/pop its mode under one surviving manager (the HMR remount shape) leaves no stale key view / double-trap / double-seed.
- App-test (C): present a PermissionDialog (and a QuestionDialog), switch to another card and back, and to/from another app → the dialog is still modal, its default ringed, Tab trapped, resolve works (the reported bug). Plus two cards (one cycling, one card-modal): switch between them; each scope intact on return; neither pollutes the other.
- App-test (F-durable): with a dialog pending, **Developer > Reload** (and, where the harness can, an app relaunch) → the dialog re-derives **modal + seeded** (cold-boot restore lands the dialog as the card's key view, not the editor).
- App-test (F-transient): a ⌥⇥ cycle / a descend in progress → Reload → it does **not** return; only the resting key view is restored (the inverse assertion — transient scopes must not be replayed).

**Checkpoint:** focus state is per-card; the deck coordinator services only the key card's context; switch-away-and-back AND reload/relaunch leave a pending dialog modal + ringed while a transient cycle/descend does not return; HMR remount leaves no stale focus marks; the cross-card filters are gone, the within-card filters preserved; the full regression matrix ([#step-7-7-audit]) green; existing at0140/at0141/at0145/at0146/at0147 + focus-walk green.

---

#### Step 7.7.3: Integration checkpoint — full regression matrix green {#step-7-7-vet}

**Depends on:** #step-7-7-cardscope

**Commit:** `N/A (checkpoint)`

**Tasks:**
- Run the full matrix (A–F) — including switch-away-and-back, the reload/relaunch dialog-survival cases (F-durable), the transient-non-restore inverse (F-transient), and the HMR re-register robustness (F-HMR); `bunx tsc --noEmit`, `bun test`, `just app-test` sweep.
- By-eye both themes: cycle, sheet, permission, question, descend — plus a reload with a pending dialog.

**Checkpoint:** every focus scope solid and ready for prime time across card switch, app switch, reload/relaunch, and HMR; no band-aids; [P20]/[P21] satisfied; R05 retired.

**Checkpoint results (dash focus-cardscope):**
- **Green here (unattended):** `bunx tsc --noEmit` clean; full `bun test` 3403/3403 (incl. +6 per-card focus-walk cases — context isolation, lossless key-card swap, cross-card containment, [P20] adoption gate, HMR re-register robustness); RPC-drivable app-tests `at0030` 6/6, `at0037` 8/8, `at0026` 2/2; `at0148` dialog-modal-seeded **on open** (`keyCard=A`, walk=3 [Allow/Deny/scope], Allow seeded `data-key-view-kbd`, trap mode current).
- **Requires a frontmost session (OS window-key gate — proven: `smoke-native` 0/5 vs non-native `smoke` 2/2; even `osascript` activation can't make the WebView `document.hasFocus()` true unattended):** the native-keyboard focus suite (at0080/at0125/at0140/at0143/at0145/at0146/at0147) and the app-switch survival round-trip in `at0148` (`simulateAppResign` needs the app actually active). Run these with the Tug window frontmost.
- **By-eye (frontmost), both themes:** cycle / sheet / permission / question / descend; and the reported bug directly — present a card-modal dialog, switch to another card / app and back → it stays modal + ringed. F-durable (Developer > Reload) by-eye too (a harness-seeded deck does not rehydrate the transient card after reload, so the reload case is by-eye / a persisted-deck fixture, not at0148).

---

#### Step 7.8: Spatial arrow navigation + explicit-commit model {#step-7-8}

**Depends on:** #step-7-7, #step-3, #step-cycle

**Commit:** `N/A (umbrella — see #step-7-8-spike … #step-7-8-vet)`

**References:** [P22], [P23], [P24], [P25], [Q10], [Q11], [Q12], Risk R06, Risk R07, (#spatial-nav-model, #seam-arrow-matrix, #p22-two-planes, #p23-declared-order, #p24-explicit-commit, #p25-arrow-ownership)

**Motivation (by-eye, 2026-06-09).** Keyboard focus-cycling is counter-intuitive in too many cases. The simplest: a card-modal PermissionDialog is up, `Allow` is ringed, and the user reaches for **Left arrow** to move the ring to `Deny` — nothing happens. Today arrows only rove *within* an item-group; there is no ergonomic, "move-the-ring-in-the-direction-you-see" motion across a bounded layout. This step adds that as a **parallel plane** ([P22]) without disturbing the structured Tab / Enter / Space contract: arrows move the ring **spatially**, in **author-declared** order ([P23], no geometry), always moving and never beeping; selection goes **explicit** again ([P24], reverting the 7.7-era selection-follows-cursor) so arrows are a pure ring-mover and Enter is free to bubble to the scope default; and arrow-owning components (editor, slider) **yield** the plane and are re-entered with Tab / Escape ([P25]; Opt-Tab is the cycle toggle, not an eject).

**Strategy:**
- Lock the model and the registration API on the motivating case first (the PermissionDialog) in a spike, resolving [Q10] / [Q11] / [Q12] *before* engine work.
- Land the explicit-commit reversion ([P24]) as a clean, *simplifying* intermediate (Space commits, Enter = default, arrows still rove within a group but never commit) — collapses the flag cluster, rebases the group app-tests.
- Build the spatial navigator ([P22] / [P23]) over the existing per-card `FocusContext` node set — additive ordering + arrow handler, no second focus system.
- Wire the arrow-ownership / escape matrix ([P25]) and author the PermissionDialog's rings / seams (the reported case), then verify.

**State Zone Mapping:**

| State | Zone | Mechanism | Law |
|-------|------|-----------|-----|
| Declared spatial order (rings + seams, per layout) | structure (config) | ring / seam table on the per-card `FocusContext`; declared at registration ([Q12]) | [L22], [L03] |
| Which node is ringed (the key view) | structure | engine key view — unchanged mechanism; arrows set it via the navigator | [L22] |
| Arrow capture (which component owns arrows) | structure | `captureSet` in the act resolver — already exists | [L22] |
| Commit (Space / Enter) | (no state — act dispatch) | `resolveFocusAct` → select / passthrough; Space commits ringed, Enter bubbles to default | [L22] |
| Ring / focus appearance | appearance | unchanged — CSS on engine `data-*` | [L06] |

**Sub-steps:** [#step-7-8-spike] (lock model + API; resolve [Q10]–[Q12]), [#step-7-8-commit] (explicit-commit reversion [P24]), [#step-7-8-spatial] (the declared spatial navigator [P22] / [P23]), [#step-7-8-capture] (arrow-ownership + Tab / Escape escape [P25]), [#step-7-8-apply] (author the PermissionDialog + key archetypes; by-eye), [#step-7-8-vet] (integration checkpoint).

**Implementation landmarks (grounded by-reading the real code, 2026-06-09 — so a fresh implementer doesn't re-derive them; cite by symbol, line hints drift):**

- **The keydown listener stack lives in `responder-chain-provider.tsx`, all `{capture: true}`, registered in this order (the order IS the precedence):** `focusWalkListener` → `captureListener` → `actDispatchListener` → then `bubbleListener` (bubble phase, the scope-default button). The comment at the registration site says it outright: "focusWalkListener is registered before captureListener so it owns Tab." **The new spatial arrow listener slots in as a sibling of `focusWalkListener`, registered BEFORE `captureListener`** — so a bare arrow is resolved as movement before the keybinding map (`captureListener`) can claim it. (There is also a separate `window` `keydown` at the top of the effect that does NOT intercept Tab — leave it alone.)
- **`focusWalkListener` is the exact template for the arrow listener.** It: returns early unless `event.key === "Tab"` with no meta/ctrl/alt; checks the **capture gate** — `active.closest('[${TAB_CONSUME_ATTRIBUTE}="true"]')` (the `data-tug-tab-consume` marker, an editor with an open completion) **OR `focusManager.keyViewConsumesTab()`**; then `focusManager.focusNext()/focusPrevious()`, and on a non-null result `focusManager.focusKeyView()` + `event.preventDefault()` + `event.stopImmediatePropagation()`. The arrow listener mirrors this with `keyViewCaptures(focusKey)` as the gate (so a focused editor/slider keeps its arrows — [P25]) and a new context method (e.g. `moveKeyViewSpatial(direction)`) in place of `focusNext`.
- **`actDispatchListener` is where Space/Enter/Escape resolve** (NOT in the components): it filters to `" "|"Spacebar"|"Enter"|"Escape"` (returns on meta/ctrl), early-returns on `focusManager.keyViewCaptures(focusKey)` and on Escape-while-`data-tug-tab-consume`, then `resolveFocusAct(focusKey, focusManager.keyViewBehavior() ?? {container:"none"})` and switches on the act — `"select" → behavior.onSelect() + focusManager.applyCommitDisposition("select")`, plus `act`/`descend`/`ascend`/`cancel`/`passthrough`. **This is the file [#step-7-8-commit] edits for the enterPassthrough/select changes** (the resolver lives in `focus-act.ts`; the dispatch lives here).
- **`use-item-group-keyboard.ts` is the group hook to relocate-not-delete.** The group registers as **one** `useFocusable` stop ("Tab moves the ring between components, never onto an item"). Its React `onKeyDown` owns arrows today: `ArrowDown/ArrowRight → cursor.moveCursor(1)`, `ArrowUp/ArrowLeft → moveCursor(-1)`, `Home → setCursor(0)`, `End → setCursor(LAST_INDEX)` (`Number.MAX_SAFE_INTEGER`), `ArrowRight` descends when `currentItemDescendable`. **This `onKeyDown` is what moves to the navigator** ([#step-7-8-spatial], Fixup 1) — the navigator calls the same `cursor.moveCursor/setCursor`. Its `behavior()` (read live via `keyViewBehavior()`) returns `{container, commit, currentItemDescendable, enterPassthrough, onSelect, onAct, onDescend}` — `[#step-7-8-commit]` drops `deferCommit`/conditional-`enterPassthrough` from radio/choice's options but **keeps `commit:"live"` + `onMove`** (the `if (commit === "live") onMove(...)` path at the bottom of `onKeyDown` is the tab bar's; do not remove it). The cursor lands on `initialIndex()` via a `manager.subscribe` layout-effect keyed on the group gaining `data-key-view-kbd` (`wasKbdRef`) — **the seed-on-enter mechanism [P24] reuses** ("entry lands on current selection").
- **The cursor itself is `use-focus-cursor.ts`** (`KEY_CURSOR_ATTRIBUTE = "data-key-cursor"`; index + items in refs; projects only when active; styling reuses the hover treatment). API the navigator drives: `setItems`, `setCursor`, `moveCursor`, `cursorElement`, `cursorIndex`, `setActive`, `clear`. **Keep this whole file** — it is the appearance projection ([L06]) the delegation model preserves.
- **`focus-act.ts` exports** `resolveFocusAct`, `captureSet` (matches by key, ignores modifiers — the [P25] capture mechanism), `isMovementKey`, and `type ComponentKeyDeclaration` (`container: "none"|"item"|"component"`, `captures`, `currentItemDescendable`, `enterPassthrough`, `modal`, `commit`, `onSelect/onAct/onDescend`) + `type CommitMode`. Movement keys: Arrow{Up,Down,Left,Right}, Home, End, PageUp, PageDown. Current resolver truth (pinned by `focus-act.test.ts`): movement in `item → "move"`, in `none/component → "passthrough"`; Enter in `item` → `enterPassthrough ? "passthrough" : (descendable ? "descend" : "act")`; Space in `item → "select"`; captured key → `"capture"`.
- **`focus-manager.ts` — where the ring/seam table lands.** `FocusContext` already holds the per-card `modeStack`, `keyViewId/keyViewKeyboard`, `groupOrder` (the linear Tab order), `defaultRingStack`, focusable registry, and `walkModeSet()` (the bounded node set both planes share). Add the declared **ring/seam table** here and a `moveKeyViewSpatial(direction)` that resolves over it + the cursor-delegation when the ringed key view is a group. Public methods already present and reused: `focusKeyView`, `keyViewBehavior`, `keyViewCaptures`, `keyViewConsumesTab`, `currentFocusMode`, `isFocusModePushed`, `applyCommitDisposition`, `subscribe`/`version`, plus the [P21] coordinator surface (`contextFor`, `activeContext`, `keyCard`, `setKeyCard`, `adoptKeyCard`).
- **`TugTabBar` carve-out is concrete:** `tug-tab-bar.tsx` calls `useItemGroupKeyboard({ commit: "live", onMove: (el) => …, … })` with the comment "The tab bar is a view switcher, so it commits live ([P08])". The other `useItemGroupKeyboard` / `onMove` callers are `tug-accordion`, `tug-choice-group`, `tug-option-group`, `tug-radio-group`. Only radio/choice lose the selection-follows-cursor usage.
- **`CardIdContext`** (`@/lib/card-id-context`, provided by `CardHost`, flows through portals) is how registration resolves a focusable's card under [P21] — the ring/seam registration ([Q12]) rides the same context the existing focusable registration does. **R06's dev-time warning uses `tugDevLogStore.warn(source, msg, data)`** (the in-app TugDevPanel sink) — never `console.warn`.

---

#### Step 7.8.1: Spike — lock the model + registration API on the PermissionDialog {#step-7-8-spike}

**Depends on:** #step-7-7-vet

**Commit:** `spike(focus): spatial-nav model + ordering API on the permission dialog`

**References:** [P22], [P23], [P24], [P25], [Q10], [Q11], [Q12], (#spatial-nav-model, #seam-arrow-matrix)

**Headline question — the granularity of a ring node (decide FIRST; everything downstream depends on it).** Confirm the buildable model from [P22]'s implications: **the navigator moves between *key views* (existing registered focusables); a selection group is one ring node whose internal arrows delegate to its `useFocusCursor` cursor, with the group boundary a seam.** Reject the alternative of promoting group items to first-class focusables/key views (it breaks "Tab never lands on an item" — `use-item-group-keyboard.ts` — and routes the appearance-only `data-key-cursor` through focusable registration, against [L06]). Prove the delegation on the PermissionDialog's scope group: an Up/Down within the group moves the cursor; an Up/Down at the group's edge crosses the seam to a button. If a strong reason to promote items surfaces, escalate before [#step-7-8-spatial] rather than silently changing [P02] / the `#language-contract`.

**Tasks:**
- Prototype the named-rings + seams registration ([Q12]) on the PermissionDialog: one horizontal ring `[Deny, Allow]`, one vertical ring `[Allow-once, Allow-for-project]`, one seam. Confirm Left/Right and Up/Down + the seam move the ring as declared, both directions, reversibly — with the group's internal axis **delegating to the cursor** (headline question).
- Resolve **[Q10]** (in-group commit key — Space-only vs Space+Enter) against the dialog where a default (Allow) and a group (scope) coexist; record the decision.
- Resolve **[Q11]** (Opt-Tab eject-to-next vs release-in-place) against the prompt editor; confirm Opt-Tab does not collide with the ⌥⇥ cycle trigger (R02).
- Resolve **[Q12]** (the registration surface): reuse `focusGroup` / `order` or add an `arrowRing` / `arrowOrder` slot; decide whether seams live on the ring or per-node; whether per-node overrides ([P23] escape hatch) are a separate prop; **how a group node exposes its internal cursor axis to the navigator** (the delegation contract). Lock the API before [#step-7-8-spatial].
- **Decide the single-select list-picker disposition** (the [P24] scope question): do the model / effort / permission / session pickers ([#step-7-5]) revert to ring-then-Space, or keep their 7.5 select-on-arrow feel? Record it; it gates how [#step-7-8-commit] touches `TugListView`.
- Decide whether the spike is throwaway or graduates cleanly; capture the locked API in the plan.

**Tests:**
- Pure-logic: an ordering-resolution function over a declared ring / seam table (`(node, direction) → next`) — closed-ring "never beeps", seam traversal, reversibility, per-node-override precedence, **group-node-with-cursor delegation** (internal move stays in the node; an edge move crosses the seam). (No DOM.)

**Checkpoint:** the navigator-over-key-views + cursor-delegation model is confirmed (or an escalation is raised); the PermissionDialog's `Allow`↔`Deny` and button↔option moves work by declared order in a spike; [Q10] / [Q11] / [Q12] + the list-picker disposition decided and recorded; the registration API is locked; Opt-Tab vs ⌥⇥ confirmed non-colliding.

**Spike results (2026-06-09):**
- **Headline question — CONFIRMED, no escalation.** Navigator-over-key-views + cursor-delegation is buildable and clean. The deep-dive prose's "vertical ring `[Allow-once, Allow-for-project]`" ([#spatial-nav-model]) is realized as the scope group's **internal cursor axis** (a `groups` entry, `length: 2`), **not** two ring nodes — so "Tab never lands on an item" and `data-key-cursor` stays appearance-only ([L06] / [P02]). Proven by `spatial-order.test.ts`: an Up/Down off the group edge resolves to `cursor`, an Up/Down at the edge crosses the seam to `Allow`. Item-promotion stays **rejected**.
- **Artifact graduates (not throwaway).** The resolver landed as `spatial-order.ts` + `spatial-order.test.ts` (13 cases: reported `Allow`→`Deny`, closed-ring never-beep, button-ring reversibility, group cursor delegation, edge-seam crossing, dead-arrow detection, override precedence, open-ring edge). [#step-7-8-spatial] wires it onto the `FocusContext`.
- **[Q10] → (a)** Space commits the ringed member; Enter is always the scope default.
- **[Q11] → Opt-Tab out (R02 confirmed real).** `⌥⇥` is already `CYCLE_FOCUS_MODE` in `keybinding-map.ts`. Escape story = plain **Tab** (soft; cycling-mode Tab walks zones) / **Escape** (hard, multi-line / code editor — ascend, release-to-ring). No new chord.
- **[Q12] → per-card declared `SpatialOrder` table** (`rings`/`seams`/`overrides`/`groups`), resolved by `resolveSpatial`; held on the per-card `FocusContext` via `CardIdContext`; group nodes expose their cursor axis through the delegation contract above. Precedence: override → group-delegation → seam → ring → none.
- **List-picker disposition → keep select-on-arrow (the 7.5 feel); lists are excluded from the [P24] radio/choice/option reversion.** Rationale: a single-select picker's highlighted row is *simultaneously* its cursor and its selection — there is no separable "ring vs choice" to defer, so reverting would make arrowing produce no selection until Space, breaking the type-to-filter → arrow → Enter-to-open list idiom Step 7.5 deliberately built. The user's [P24] directive named radio / choice / option, not lists. [#step-7-8-commit] therefore leaves `TugListView singleSelect` untouched.

---

#### Step 7.8.2: Explicit-commit reversion — arrows never select; Space commits, Enter defaults {#step-7-8-commit}

**Depends on:** #step-7-8-spike

**Commit:** `refactor(focus): explicit commit — arrows move the ring, Space/Enter commit`

**References:** [P24], [Q10], Risk R07, (#p24-explicit-commit)

**Tasks:**
- `resolveFocusAct`: for the **selection-group** case, arrows in an item container → **move** (never a committing select); **Space** → select (commit the ringed member); **Enter** in an item container → **passthrough** (scope default), unconditionally. Remove the conditional `enterPassthrough` flag — it becomes the always-true behavior.
- Remove the **radio / choice** selection-follows-cursor usage: the `deferCommit` prop on `TugRadioGroup` / `TugChoiceGroup` and their `onMove` wiring. **Do NOT delete `commit: "live"` / `onMove` from `use-item-group-keyboard.ts`** — `TugTabBar` is the canonical live consumer ([P08], `tug-tab-bar.tsx`); the machinery stays, radio / choice just stop using it.
- `TugOptionGroup` keeps Space-toggle (arrows ring, Space toggles via `onSelect`).
- `TugListView`: keep `singleSelect`'s *selection-model* meaning; apply the [#step-7-8-spike] list-picker disposition (revert to ring-then-Space, or keep select-on-arrow) — do not assume either here.
- Spatial entry into a group lands on the group's **current selection** without mutating; intra-group arrows move the ring (cursor), no commit.
- Rewrite **at0117 / at0118 / at0145** from select-on-arrow to ring-on-arrow + explicit Space-commit (and Enter → default bubbling for at0145, the original Enter-on-Allow case). **at0119 / at0030 (tab bar) must stay green unchanged** — the guard that the revert did not reach the live view-switcher.

**Tests:**
- `focus-act.test.ts`: Enter-passthrough for item containers becomes unconditional; Space → select; arrows → move (no select). Update the resolver decision-table tests.
- App-test: at0117 / at0118 (radio / choice — arrow rings, does not select; Space selects); at0145 (permission — ArrowDown rings the scope option without selecting; Space commits scope; **Enter activates the ringed Allow default after a Tab loop** — the original bug, now fixed by construction). Tab-bar regression (at0119 / at0030) green **unchanged**.

**Checkpoint:** `bunx tsc --noEmit` clean; radio / choice no longer select on arrow; Space commits the ringed member; Enter bubbles to the scope default; the tab bar still commits live (at0119 / at0030 green unchanged); at0117 / at0118 / at0145 green to the explicit-commit contract.

---

#### Step 7.8.3: The declared spatial navigator {#step-7-8-spatial}

**Depends on:** #step-7-8-commit

**Commit:** `feat(focus): spatial arrow navigation over declared rings + seams`

**References:** [P22], [P23], [Q12], Risk R06, (#spatial-nav-model, #p22-two-planes, #p23-declared-order)

**Tasks:**
- Add the declared **ring / seam table** to the per-card `FocusContext` ([P21]); registration ([Q12], locked in the spike) places each focusable (key view) on a ring at an index with optional per-node neighbor overrides.
- Add a new **capture-phase arrow listener** (a sibling of `focusWalkListener` in `responder-chain-provider.tsx`): resolve `(ringed key view, direction) → next` against the declared order over the **active mode's node set** ([P21], the `walkModeSet` set), set the engine key view, project the ring ([L22]). No React state ([L06]).
- **Listener ordering + capture gating (Fixup):** the arrow listener must be **gated by `focusManager.keyViewCaptures(...)` / the `data-tug-tab-consume` marker** so a focused editor (caret) or slider (value axis) wins its arrows ([P25] / R02), and ordered **ahead of the keybinding `captureListener`** so a bare arrow is not eaten by a global binding — mirroring how `focusWalkListener` is registered before `captureListener` for Tab. When the ringed key view is a **selection group**, an arrow along the group's axis **delegates to the group's `useFocusCursor`** (move the cursor); only an arrow at the group's edge crosses the **seam** to the next key view ([P22] implication / the spike's headline model).
- **Total-function / never-beep:** a closed ring always yields a next node; a seam always has a target; resolution never returns "nothing" for a declared node.
- **Reversibility by construction:** the author declares both edges; verify Right-then-Left returns.
- **Relocate the group's arrow *dispatch*, keep the cursor.** `use-item-group-keyboard.ts` stops owning the arrow `onKeyDown` (the navigator drives the cursor instead); **`useFocusCursor` is kept** (the `data-key-cursor` appearance projection is unchanged, [L06] / [P02]). The group reads the cursor / ringed item to know what Space commits.
- **R06 liveliness (revised in 7.8.6):** when an arrow resolves with no spatial target, the navigator falls back to the linear `groupOrder` walk (wrapping) so the ring always moves — never a beep, never a silent swallow, never a dead-end. (A `tugDevLog` reachability warning was prototyped here and then removed: the fallback means there is no dead arrow to warn about.)
- **[L26] / default-context:** the navigator no-ops cleanly with no manager and routes through the default context with no `CardIdContext` (gallery / standalone preview).

**Tests:**
- Pure-logic (`focus-walk.test.ts` or a new `spatial-nav.test.ts`, real `FocusManager` / `FocusContext`): ring traversal (L/R, U/D), seam crossing, closed-ring wrap (never-beep), reversibility, per-node-override precedence, **group-node cursor delegation** (internal move stays in the node, edge move crosses the seam), an undeclared-node warning path (no throw), default-context (no card) path.
- App-test: arrow-move the ring across a multi-control card / dialog by declared order; confirm no commit occurs on movement; confirm a focused editor / slider keeps its arrows (capture gating).

**Checkpoint:** arrows move the ring spatially by declared order across the bounded scope; never beep; reversible; the navigator owns inter-node + seam movement and delegates intra-group movement to the kept cursor; capture gating + listener ordering hold (editor / slider keep their arrows; no binding eats a bare arrow); a dev-time warning fires on a dead arrow; existing focus-walk + at0140 / at0141 green.

---

#### Step 7.8.4: Arrow ownership + Tab / Escape escape {#step-7-8-capture}

**Depends on:** #step-7-8-spatial

**Commit:** `feat(focus): arrow-capture matrix — slider value axis + editing-host yield`

**References:** [P25], [Q11], Risk R02, (#seam-arrow-matrix, #p25-arrow-ownership)

**Tasks:**
- Wire the [#seam-arrow-matrix] ownership classes: a focused **text-editing host** (contentEditable / input / textarea — CodeMirror, prompt) keeps all four arrows for the caret (the navigator yields to it directly, no per-editor wiring); a **slider** captures its value axis (Left/Right) via `captureSet`, the cross axis (Up/Down) leaves spatially; **selection groups** stay *soft* owners (the 7.8.3 delegation — no trap); a **leaf** participates fully.
- **Escape is Tab / Escape, not Opt-Tab** ([Q11]: `⌥⇥` is the cycle toggle, R02). Plain Tab leaves any non-Tab-capturing component; Escape (ascend) leaves a descended Tab-consuming editor. No new chord.
- A component that needs arrows but doesn't capture them surfaces via the same R06 dev-time check, *in a declared-order scope* (outside one the navigator yields by returning not-consumed).

**Tests:**
- App-test: in the prompt editor arrows move the caret (spatial suspended) and Tab returns to the plane; on a slider Left/Right change value and Up/Down (or Tab) leaves; a leaf participates fully.
- Pure-logic: `moveKeyViewSpatial` is gated by the editing-host yield + `keyViewCaptures` (the slider's Left/Right capture is pinned by `focus-act`'s `captureSet`); the `spatial-nav` tests cover the leaf / group / ring paths.

**Checkpoint:** arrow-owning components suspend the spatial plane and are re-entered with Tab / Escape; the matrix holds for editor / slider / group / leaf; Opt-Tab is not used (it is the cycle toggle).

---

#### Step 7.8.5: Author the PermissionDialog rings + key archetypes; by-eye {#step-7-8-apply}

**Depends on:** #step-7-8-spatial, #step-7-8-capture

**Commit:** `focus(dialogs): declare spatial rings for permission + question dialogs`

**References:** [P22], [P23], [P24], (#spatial-nav-model)

**Tasks:**
- Author the PermissionDialog's declared order (the motivating case): `[Deny, Allow]` horizontal ring, `[Allow-once, Allow-for-project]` vertical ring, the seam — Left from Allow → Deny; Down → into the scope options; Space commits the scope; Enter activates the ringed Allow.
- Author the QuestionDialog and one composed surface (a sheet with a list + buttons) to confirm the API generalizes beyond the simplest case.
- **List delegation — DECIDED (b), 2026-06-09:** `TugListView` manages its own arrow cursor (it does **not** use `use-item-group-keyboard`, so it registers no `SpatialCursorHandle`). A declared spatial order **excludes the list from its ring/seam table**: the list owns its arrows (select-on-arrow, the 7.5 idiom — preserved) and Tab reaches it. Rationale: least churn, keeps the picker feel the user accepted. Option (a) — `TugListView` registering a `SpatialCursorHandle` so the navigator delegates to its cursor (consistent with groups) — is a clean future enhancement, but the list cursor is bespoke (its own seed/descend/scroll logic), out of scope for this pass. Until then, a layout's spatial ring covers its buttons / groups; lists are Tab-reached islands.
- By-eye both themes: every arrow press moves the ring somewhere sensible; nothing beeps; reversal returns.

**Tests:**
- App-test: at0145 extended — Left/Right/Up/Down move the ring by declared order; Space commits the scope; Enter → Allow (the round-trip native cases run frontmost per the 7.7 harness note).

**Checkpoint:** the reported case works (Left → Deny on the PermissionDialog); the API generalizes to the QuestionDialog and a composed sheet; by-eye both themes clean; no dead arrows.

---

#### Step 7.8.6: Integration checkpoint {#step-7-8-vet}

**Depends on:** #step-7-8-apply

**Commit:** `N/A (checkpoint)`

**References:** [P22], [P23], [P24], [P25], (#success-criteria)

**Tasks:**
- Full sweep: `bunx tsc --noEmit`, `bun test`, `just app-test`; confirm the 7.7 regression matrix (cycle / sheet / card-modal / descend) is still green under the new arrow plane.
- By-eye both themes: arrows move the ring across card / dialog / sheet, never beep, reverse cleanly; editor / slider yield + Tab / Escape re-entry; Space / Enter commit semantics.

**Checkpoint:** spatial arrow navigation works across the bounded scopes; explicit commit holds; arrow-owning components yield and are re-entered; no regressions in the 7.7 matrix; [P22]–[P25] satisfied; [Q10]–[Q12] resolved.

---

#### Step 7.9: Generalize the spatial order to QuestionDialog, a sheet, and the dev-card {#step-7-9}

**Depends on:** #step-7-8

**Commit:** `N/A (umbrella — see #step-7-9-question … #step-7-9-vet)`

**References:** [P22], [P23], [P24], [P25], [Q12], [Q13], (#spatial-nav-model, #seam-arrow-matrix, #r06-dead-arrows)

**Motivation (2026-06-09).** Step 7.8 built the spatial-navigation model and proved it on the PermissionDialog (the reported Left→Deny), shipped to `main` (`8973bd60`). The model is now a **reusable primitive**: `spatial-order.ts` (the pure resolver), `useSpatialOrder` (the per-scope declaration hook — nodes by `group:order` key), the navigator's linear-order **liveliness fallback** (no arrow ever dead-ends). This step rolls it out to the rest of the bounded scopes, **easy→hard**, so each validates the API before the hard one: the QuestionDialog (a near-copy of the PermissionDialog), a composed sheet (the first non-dialog trap), and the dev-card (a genuine 2D layout — and the surface that already exercises every archetype end-to-end, [#cycle-model]).

**Strategy:**
- **7.9.1 / 7.9.2 are application steps** — declare each surface's ring/seam order with `useSpatialOrder`; no engine change expected.
- **7.9.3 is spike-then-apply** for the dev-card: its layout is 2D (toolbar row + status bar + editor) and it forces the two primitives 7.8 deferred — **list-as-handle** ([Q12] option (a): `TugListView` registers a `SpatialCursorHandle` so a picker can join a declared ring) and **edge-aware seam landing** (Up into a group lands at the bottom, not the selection — the by-eye nit from 7.8). The spike ([Q13]) decides whether each is needed, and whether arrows belong in the cycling layout at all, before any engine work.
- **7.9.4 verifies** the whole rollout (sweep + by-eye both themes).

**Sequencing caveat — the list-as-handle decision (in 7.9.3) governs work in 7.9.1 and 7.9.2.** A multi-select QuestionDialog (7.9.1) and a list-bearing sheet (7.9.2) have a `TugListView` as a main surface; under decision (b) that list is Tab-reached, so their *spatial* story is buttons/groups-only until 7.9.3 decides whether to adopt list-as-handle (a). The order here is deliberate — prove the API on the simpler radio/button cases first, decide the heavier list primitive on the dev-card (the richest case), then **retrofit** 7.9.1-multi / 7.9.2 if (a) is adopted. To avoid a thin demo in the meantime, 7.9.2 picks a sheet rich in non-list controls. If the multi-select / sheet-list feel demands spatial traversal sooner, pull the list-as-handle decision forward into a pre-step before 7.9.1 rather than discovering it late.

**State Zone Mapping:** unchanged from [#step-7-8] — each new piece is a declared `SpatialOrder` (structure/config, [L22]) on a `FocusContext`; if the spike adopts them, a list cursor handle (appearance, [L06]) and a seam landing hint (structure). No new state zones.

**Sub-steps:** [#step-7-9-question], [#step-7-9-sheet], [#step-7-9-devcard] (spike + apply), [#step-7-9-vet].

**Implementation landmarks (grounded by-reading the real code at the 7.8 join `8973bd60`, 2026-06-09 — so a fresh implementer works straight from the plan; cite by symbol, line hints drift). All paths under `tugdeck/`.**

- **The shipped primitives 7.9 builds on (all on `main`):**
  - `src/components/tugways/spatial-order.ts` — the **pure resolver**. `resolveSpatial(order, node, direction, cursorIndex) → { kind:"ring", target } | { kind:"cursor", delta } | { kind:"none" }`. Types: `SpatialOrder { rings, seams?, overrides?, groups? }`, `SpatialRing { axis: "horizontal"|"vertical"; nodes: string[]; closed? }` (closed default true = wrap), `SpatialSeam { from, direction, to }`, `SpatialOverride { from, direction, to }`, `SpatialGroup { node, length }` (NO axis — a 1D cursor, both axes rove: down/right → +1, up/left → −1). Helpers `arrowDirection(key)`, `oppositeDirection(dir)`. **Nodes are referenced by `group:order` keys, not focusable ids.** Pure, no DOM — pinned by `__tests__/spatial-order.test.ts`.
  - `src/components/tugways/use-spatial-order.ts` — **the declaration hook**, current signature `useSpatialOrder(scopeId: string, order: SpatialOrder | null)`: registers `order` on `manager.contextFor(cardId)` under `scopeId` in a layout effect, tears down on unmount / when `order` is null ([L03]/[L26]). **7.9.2 adds the context-derived form** `useSpatialOrder(order)` that reads the scope from `FocusModeContext` (see below).
  - `src/components/tugways/focus-manager.ts` — `FocusContext` holds the per-mode `spatialOrders: Map<scopeId, SpatialOrder>` (`registerSpatialOrder`/`unregisterSpatialOrder`) and live `cursorHandles: Map<id, SpatialCursorHandle>` (`registerCursorHandle`/`unregisterCursorHandle`). `moveKeyViewSpatial(direction): boolean` resolves (override → group-delegate → seam → ring → **linear-order liveliness fallback** via `focusNext`/`focusPrevious`, so an arrow NEVER dead-ends). Private `focusKeyOf(id)` / `idForFocusKey(key)` translate focusable-id ↔ `group:order`. `interface SpatialCursorHandle { length(); cursorIndex(); moveCursor(±1); tryDescendRight() }`. Coordinator `FocusManager.moveKeyViewSpatial` delegates to `activeContext()`. **`export const FocusModeContext = createContext<string>(BASE_FOCUS_MODE)`** — the active trap scope, provided to descendants by `FocusModeScope`.
  - `src/components/tugways/responder-chain-provider.tsx` — `arrowNavListener` (capture phase, registered **between** `focusWalkListener` and `captureListener`). Bails on modified arrows; **yields to a focused editing host** (`document.activeElement` is contentEditable / INPUT / TEXTAREA) and to `focusManager.keyViewCaptures(focusKey)` (the slider's value axis), else calls `focusManager.moveKeyViewSpatial(direction)` and consumes on true.
  - `src/components/tugways/use-item-group-keyboard.ts` — registers a `SpatialCursorHandle` for every group (radio / choice / option / accordion / tab-bar); `moveCursor` fires the live commit; `tryDescendRight` does ArrowRight-descend; Home/End stay in the local React `onKeyDown`. `useFocusCursor` is kept (`data-key-cursor`, appearance-only).
- **The reference implementation to mirror — `src/components/tugways/chrome/dev-permission-dialog.tsx`:** captures `const { FocusModeScope, scopeId } = useFocusTrap({ active: isPending })`, builds a **memoized** `SpatialOrder` from `${focusGroup}:${ORDER}` keys (closed `[denyKey, allowKey]` horizontal ring; seams: both buttons' Up+Down → `scopeKey`, `scopeKey` Up → `allowKey`), and calls `useSpatialOrder(scopeId, isPending ? spatialOrder : null)`. Copy this shape.
- **Where each surface's `scopeId` comes from:**
  - `useFocusTrap({ active })` (`use-focus-trap.tsx`) returns `{ scopeId, FocusModeScope }` AND provides `FocusModeContext = scopeId` to everything inside `FocusModeScope`. A component that *owns* its trap (the dialogs) passes its own `scopeId`; content placed *inside someone else's* trap (a sheet's body) reads `useContext(FocusModeContext)` — this is the 7.9.2 mechanism.
  - `useCycleMode(...)` (`use-cycle-mode.tsx`) returns `{ cycling, toggle, exit, CycleScope, scopeId, ... }` — `scopeId` is the dev-card cycle scope (7.9.3 registers under it).
- **QuestionDialog — `src/components/tugways/chrome/dev-question-dialog.tsx`:** already calls `useFocusTrap`; one focus group (`React.useId()`) with order constants Cancel `0` / Submit `1` / Back `2` / Next `3` / options `4`; the options are `QuestionRadioOptions` (single — a `TugRadioGroup`, delegated group) or `QuestionListOptions` (multi — a `TugListView`, Tab-reached under (b)). Already builds `${focusGroup}:${ORDER}` keys for `defaultFocusKey`. Test: `tests/app-test/at0146-question-dialog-keyboard.test.ts`.
- **Sheet — `src/components/tugways/tug-sheet.tsx`** calls `useFocusTrap({ active: open })` and renders `FocusModeScope` (only `FocusModeScope` is destructured today — `scopeId` is available if needed, but content should use the `FocusModeContext` form). Sheet *content* declares the order.
- **Dev-card — list-as-handle target `src/components/tugways/tug-list-view.tsx`:** `TugListView` owns its cursor directly (NOT `useItemGroupKeyboard`): `cursorIndexRef`, `moveCursorTo(index)`, `selectCursorRow()`, `descendCursorRow()`, `rowFirstFocusableId(i)`, and a `behavior()` with `commit: singleSelect ? "live" : "deferred"`. To adopt (a), wrap these into a `SpatialCursorHandle` (`length` = row count, `cursorIndex` = `cursorIndexRef.current`, `moveCursor` = `moveCursorTo` + select-on-arrow for singleSelect, `tryDescendRight` = `descendCursorRow` when `rowFirstFocusableId` ≠ null). Cycle order is [P10] (Z2 → Z4 → Z5 → wrap, [#cycle-model]). Test: `tests/app-test/at0140-cycle-devcard.test.ts`.
- **Build / test tooling (gotchas learned in 7.8):** typecheck with `./node_modules/.bin/tsc --noEmit` from `tugdeck/` — **NOT `bunx tsc`** (it resolved a wrong standalone `tsc` package). Pure-logic: `bun test src/components/tugways/__tests__/<file>`. Native-keyboard app-tests: `just app-test-build <files>` (full build + run) or `just app-test <files>` (dist refresh + run — enough for TS-only changes; the env runs native-keyboard tests fine, no frontmost gate observed). `tugutil` lives at `tugrust/target/debug/tugutil` (not on PATH); dash commits via `tugutil dash commit <name> --json` from the **worktree root** (cwd drifts — pass absolute paths / `git -C`). See also the [#step-7-8] landmarks for the engine internals.

---

#### Step 7.9.1: QuestionDialog declares its spatial order {#step-7-9-question}

**Depends on:** #step-7-8

**Commit:** `focus(dialogs): declare the question dialog's spatial ring`

**References:** [P22], [P24], (#step-7-8-apply)

**NOT a near-copy — design its own order.** The QuestionDialog's controls are **two button rows + options**, not the PermissionDialog's single button row (`dev-question-dialog.tsx`: one focus group, Cancel `0` / Submit `1` / Back `2` / Next `3` / options `4`). Visually Cancel/Submit are one row and Back/Next another (wizard nav), and *which* buttons render is conditional (Back/Next only multi-step; Submit gated until every question is answered). So the declared order is a **3-row vertical structure with dynamic membership**, not a copy of [#step-7-8-apply].

**Tasks:**
- In `dev-question-dialog.tsx`, capture the trap `scopeId` (from `useFocusTrap`) and declare a `SpatialOrder` via `useSpatialOrder`. Author the rows explicitly: a horizontal ring per button row (Cancel↔Submit; Back↔Next when present), a vertical seam chain between the rows, and a seam into the options; both top edges loop (the liveliness pattern — and the navigator's linear fallback backstops any unnamed edge). Nodes by `group:order`.
- **Build the order from the buttons actually rendered this state** — recompute (memoized) when the present set changes (single vs multi question, review boundary), so a missing Back/Next never leaves a seam pointing at an absent node. (A stale seam is harmless — the navigator's `idForFocusKey` returns `null` and the liveliness fallback takes over — but author it to match what's on screen.)
- **Radio options** (single-select question) — a delegated group ([Q12]), same as the PermissionDialog scope group. **List options** (multi-select question) — per the list-delegation decision (b), the `TugListView` is excluded from the ring/seam table (Tab-reached); the order covers the buttons. **Watch-item:** for a multi-select question the list IS the main content, so under (b) the spatial story is buttons-only until [#step-7-9-devcard] decides list-as-handle — see the umbrella Strategy note. (Revisit this step if 7.9.3 adopts (a).)
- Register only while the dialog is the active trap (`isPending`), memoized.

**Tests:**
- App-test: extend `at0146` — from a button, Left/Right swap actions within a row; Up/Down move between rows and into the options (radio: ring then Space commits; list: Tab-reached); Enter activates the default; nothing beeps anywhere, including the conditional-button states (single vs multi).

**Checkpoint:** the QuestionDialog is spatially navigable for both arities and across its conditional button sets; `at0146` green; by-eye clean.

---

#### Step 7.9.2: A composed sheet declares its spatial order {#step-7-9-sheet}

**Depends on:** #step-7-9-question

**Commit:** `focus(sheets): declare a composed sheet's spatial ring`

**References:** [P22], [P23], [Q12], (#spatial-nav-model)

**The scope comes from context here, not a local `useFocusTrap`.** Unlike the dialogs (which own their trap), a sheet's trap lives inside `TugSheet` (`tug-sheet.tsx` calls `useFocusTrap`); the sheet's **content** is a separate consumer that has no local `scopeId`. The mechanism already exists: `useFocusTrap`'s `FocusModeScope` provides the scope id to descendants via `FocusModeContext`. **API refinement (land first, with the engine work):** give `useSpatialOrder` a context-derived form — `useSpatialOrder(order)` reads the enclosing `FocusModeContext` for the scope, while the dialogs keep passing their own id explicitly (`useSpatialOrder(scopeId, order)`). Sheet content then declares its order with the no-id form.

**Tasks:**
- Add the context-derived `useSpatialOrder(order)` overload (reads `FocusModeContext`); no-op when there is no enclosing scope ([L26]). Pure-logic / type coverage as warranted.
- Pick a representative composed sheet **rich in non-list controls** (buttons + a toggle/group/segment), so the declared order exercises real spatial motion rather than degenerating to one button row — a list-dominant sheet has little to navigate under decision (b) until [#step-7-9-devcard] (see the Strategy note). Declare its `SpatialOrder` from the sheet content via the context form; it registers/tears-down with the sheet's open state automatically (the scope is only present while `FocusModeScope` renders).
- Confirm the bounded scope is the sheet's trap mode (the boundary [P21] / [#spatial-nav-model] already draws).
- Apply the list-delegation decision (b) for any list in the sheet unless 7.9.3 has adopted list-as-handle by the time this lands.

**Tests:**
- App-test: arrows move the ring across the sheet's controls by declared order; any list is reached (Tab, or a seam if (a) is adopted); never beeps; reversal returns.

**Checkpoint:** a non-dialog trap carries a declared order cleanly via the context-derived hook; the API generalizes past dialogs; by-eye clean both themes.

---

#### Step 7.9.3: Dev-card spike + apply {#step-7-9-devcard}

**Depends on:** #step-7-9-question

**Commit:** `feat(focus): dev-card spatial order (+ any spike-adopted primitives)`

**References:** [P22], [P23], [P25], [Q12], [Q13], (#cycle-model, #spatial-nav-model, #seam-arrow-matrix)

**Headline questions — the spike decides FIRST ([Q13]):**
1. **Do arrows belong in the cycling layout, and what is the 2D order?** Cycling tours zones with Tab; the spike maps a sensible spatial order (toolbar row — route / mode / model / effort / submit — as a horizontal ring; the Z2 status bar as a second row; the editor as the body) and confirms it coexists with Tab. Declared under the **cycle mode's `scopeId`** (the `useCycleMode` scope) so it is active exactly while cycling.
   - **Editor-zone arrow-*leave* (must confirm both directions).** [P25]'s editing-host yield means a focused `contentEditable` keeps all four arrows for the caret. If the editor zone's focused element *is* (or contains) CodeMirror's `.cm-content`, arrows there feed the caret and the ring could never arrow *off* the editor. The spike must confirm the editor zone is arrow-navigable **out**, not just reachable — most likely the ring sits on a wrapper stop (not the contentEditable), with Enter / typing descending into the caret. If the zone can't be left by arrow, the order needs a different editor-zone treatment (e.g. the editor is the cycle's body that only Tab/Escape enters, not an arrow stop).
2. **List-as-handle?** The dev card has pickers (`TugListView`). If arrows should traverse *into* a picker spatially, `TugListView` registers a `SpatialCursorHandle` (its existing cursor + select-on-arrow + descendable rows, driven by the navigator — [Q12] option (a)). The spike decides if the dev-card needs it or if Tab-reached (b) suffices. (This decision also governs 7.9.1-multi / 7.9.2 — see the umbrella Sequencing caveat.)
3. **Edge-aware seam landing?** A 2D layout may want Up-into-a-group to land at the *bottom* for a true vertical wrap. If the feel needs it, add an optional `land: "first" | "last"` to `SpatialSeam` + a `setCursor` path on the handle, and have the navigator set the cursor after a seam crossing.
   - **Timing subtlety to validate.** A group's `useItemGroupKeyboard` auto-seeds its cursor on gaining the key view (the `wasKbd` layout effect, fired off `setKeyView` → `manager.subscribe` notify) to the *selection*. A post-seam `setCursor(last)` must run **after** that seed (or it is clobbered), and the cursor must already be `active` for the projection to paint. Verify the ordering (navigator sets the cursor after `setKeyView` + `focusKeyView` returns), or route the landing through the seed itself rather than a post-hoc override.

**Tasks (after the spike locks the above):**
- Land any adopted primitive (list-as-handle and/or edge-landing) as a small, **separately-committed** engine change with its own pure-logic test, *before* the dev-card authoring uses it.
- Author the dev-card's declared `SpatialOrder` under the cycle scope. Keep the editing-host yield ([P25]) — arrows in the editor move the caret; the ring reaches the editor zone via the order; descent (Enter / typing) drops in.

**Tests:**
- Pure-logic: any new primitive gets a `spatial-nav` / `spatial-order` case.
- App-test: extend `at0140` — in cycling, arrows move the ring across the dev-card's zones by declared order; pickers behave per the spike decision; the editor keeps its caret; never beeps; Space/Enter commit semantics unchanged.

**Checkpoint:** the dev-card is spatially navigable in cycling; the spike's primitive decisions are recorded and (if adopted) tested; `at0140` green; by-eye both themes.

---

#### Step 7.9.4: Integration checkpoint {#step-7-9-vet}

**Depends on:** #step-7-9-devcard

**Commit:** `N/A (checkpoint)`

**References:** [P22], [P23], [P24], [P25], (#success-criteria)

**Tasks:**
- Full sweep: `tsc`, `bun test`, `just app-test`; the focus app-test set (at0145 / at0146 / at0117–120 / at0140 / at0115 / at0116 / at0141 / at0142 / at0030) green under the generalized orders.
- By-eye both themes across the PermissionDialog, QuestionDialog, the chosen sheet, and the dev-card: every arrow moves the ring somewhere sensible, never beeps, reverses cleanly.

**Checkpoint:** spatial navigation generalizes to dialogs, a sheet, and the dev-card; liveliness holds everywhere; no regressions; the deferred primitives are either adopted-with-tests or consciously left at (b) / selection-landing.

---

#### Step 8: Links + app-wide focusables {#step-8}

**Depends on:** #step-1

**Commit:** `focus(app): links + title bars / toolbars / prompt / dev panel`

**References:** [P01], [P03], (#r01-mixed-window)

**Artifacts:** `tug-link.css` + app-chrome focus CSS (the long tail the global rule touches).

**Tasks:**
- TugLink: inline ring + behind-tint (underline kept for hover).
- Audit the app-wide focusables the global `[data-key-view-kbd]` rule already paints (title bars, toolbars, prompt entry, dev panel); confirm each reads correctly under the new tokens; add per-surface overrides only where the default ring is wrong.

**Per-card-context interaction — decide the app-level context (from the [#step-7-7-cardscope] audit):** [P21] keys the focusable registry by `CardIdContext`. A focusable with **no** card context (`CardIdContext === null`) routes to the manager's **active** context (`contextFor(null) → activeContext()`) — correct for today's only card-less focusables, which are *transient* (a pane-chrome confirm popover opened over the key card, gone before the card switches). But a **persistent** app-chrome stop that should be Tab-reachable *regardless of which card is active* (a window title bar, a global toolbar) would register into whichever card was key at mount and then not be walked once a different card is key — the Tab walk only services the key card's context. Before authoring any such persistent app-level stop, decide its home: most likely a dedicated **app/shell context** the coordinator also services (e.g. union the shell context with the key card's walk, or a separate always-present stop tier), NOT the per-card default. If Step 8 only restyles the *existing* chrome (no new persistent walk stops), this is a no-op — but make the call explicitly rather than letting a stop silently land in a card context. (Sheets/popovers stay fine: they resolve their opening card via `CardIdContext` through the portal.)

**Tests:**
- Behavior: existing chrome app-tests green.
- Live-build pass: Tab through the app shell; every stop rings coherently, both themes.

**Checkpoint:** `tsc` clean; app-tests green; live shell Tab-through clean; the app-level-context decision is recorded (above) if any persistent app-chrome stop is added.

#### Step 9: Governance — tuglaws doc + matrix rewrite + governing decision {#step-9}

**Depends on:** #step-3, #step-4, #step-5, #step-6, #step-7, #step-8

**Commit:** `focus(law): focus-language doc + matrix visual column`

**References:** [P01], [P02], [P03], (#language-contract, #token-surface)

**Artifacts:** `tuglaws/focus-language.md`; updated keyboard-model matrix; a governing decision entry.

**Tasks:**
- Author `tuglaws/focus-language.md`: the contract ([#language-contract]), the token surface ([#token-surface]), the role axis, and how a new component declares its focus visuals.
- Rewrite the keyboard-model [Keyboard Behavior Matrix](tugplan-keyboard-model.md#keyboard-matrix) visual column to the new signature; record the governing decision superseding [P03] (promote to `tuglaws/design-decisions.md` if the user wants it global).

**Tests:** n/a (docs) — cross-links resolve; matrix matches shipped behavior.

**Checkpoint:** doc present and accurate; matrix consistent with the implemented components.

#### Step 10: Integration checkpoint + spike-card fate {#step-10}

**Depends on:** #step-2, #step-3, #step-4, #step-5, #step-6, #step-7, #step-8, #step-9

**Commit:** `N/A (verification only)` (plus a small commit if the spike card is repointed/removed)

**References:** [P01], [Q04], (#success-criteria, #exit-criteria)

**Tasks:**
- Composed-surface pass: a sheet containing a list, a form, and an editor — confirm one coherent focus language across nesting, both themes, keyboard vs mouse.
- Decide [Q04]: repoint `gallery-focus-language` at the real tokens and retitle "Focus language reference", or delete it.

**Tests:**
- Behavior: full `just app-test` sweep green; `bun test` green; `bunx tsc --noEmit` clean.
- By-eye: the [#success-criteria] checklist passes per component, both themes.

**Checkpoint:** all gates green; [#exit-criteria] satisfied; spike-card decision recorded.

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** The whole app speaks one keyboard-focus visual language — ring + faint behind-tint on the focused component, native fill for selection, all role-resolved (default `action`) — documented in `tuglaws/focus-language.md`, with the focus engine and all behavior unchanged.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] Every matrix component shows the new focus signature in both themes (gallery checklist).
- [ ] The orange focus axis is retired from the focus path (grep clean).
- [ ] Role-bearing controls ring/fill/tint per role; role-less ride `action` (gallery danger/accent cells).
- [ ] `TugInput` invalid focuses danger; `TugTabBar` commits on act (gallery + live).
- [ ] All `just app-test` keyboard scenarios `VERDICT: PASS`; `bun test` green; `bunx tsc --noEmit` clean.
- [ ] `tuglaws/focus-language.md` exists; the governing decision supersedes keyboard-model [P03]; the matrix visual column is rewritten.

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] High-contrast / accessibility-mode focus variant ([Q03]) — with the keyboard-model a11y pass.
- [ ] Broaden component-level `role` props beyond `TugInput`'s validation as real semantic needs arise.
- [ ] The deferred keyboard-model `refuse`/first-responder audit (its `#step-15`).
- [ ] Escape-to-exit cycling mode ([P11]) — deliberately left out of the first cut; add if the trigger / Return-into-text exits prove insufficient.

| Checkpoint | Verification |
|------------|--------------|
| Token foundation | `tsc` clean; app-test sweep green; new ring in both themes |
| Per-component parity | gallery review per archetype, both themes |
| App-wide coherence | live shell Tab-through; composed-surface pass |
| Governance | `tuglaws/focus-language.md` present; matrix consistent |
