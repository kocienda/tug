<!-- devise-skeleton v4 -->

## Container Focus Wash — rings mark elements, washes mark containers {#focus-language-wash}

**Purpose:** Retire the container focus **ring** from every item-group in the deck and replace it with a **background focus wash**, so the ring and the cursor caret are reserved for marking *elements* and the wash alone answers "which container holds the keyboard" — making the cursor easier to find and the surface quieter.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | implemented — Steps 1–8 landed on dash `focus-wash`; Step 9's by-eye walk is the user's |
| Target branch | main |
| Last updated | 2026-08-03 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

The focus language ([tuglaws/focus-language.md](../tuglaws/focus-language.md)) already states the target design. Its engine-attributes contract table, under "The contract — engine attributes → CSS", specifies that `data-key-view-kbd` on an **item-group container** renders a *faint behind-tint*, and that only `data-key-cursor` on an **item** renders a ring. Four of the six item-groups obey it today — `TugRadioGroup`, `TugChoiceGroup`, `TugOptionGroup`, and `TugTabBar` each override the global leaf ring to `outline: none` plus a `background-image` tint. Two do not: `TugListView` draws a full-perimeter ring in both of its placements, and `TugAccordion` draws a perimeter ring with `background-image: none`. The global `[data-key-within]` rule in `focus-ring.css` is also an outline, so *every* container that merely contains the active control rings as well.

The result on screen is a ring nested inside a ring in the same accent hue at two scales — the container's ring and the cursor item's ring answering different questions in identical vocabulary — which is exactly the conflation the focus language exists to prevent between focus and selection. In the Lens rail it is at its worst: the Cards section's list wears a full-bleed accent rectangle around Sessions and Files together, and the eye reads the rectangle before it finds the caret inside it.

Two pieces of evidence say the fix is a stronger wash rather than a thinner ring. First, `layouts-section.css` has already run this experiment locally: it overrides `--tugx-focus-tint` for `.layouts-section-group[data-key-view-kbd]`, rebuilding it from the accent **fill** at 15% alpha instead of the accent **tone**, with the comment *"a surface so quiet that over the Lens's own band background it barely registered, and the focused axis read as unmarked… TUNE the percentage here."* That override is the wash, proven in place, and it is the treatment the Layouts section shows today. Second, the default tint really is near-invisible: `--tugx-focus-tint` is `color-mix(in srgb, var(--tug7-surface-tone-primary-normal-accent-rest) 65%, transparent)`, and that tone token is already alpha-bearing in every theme (`brio` `a: 150`, `harmony` `a: 350`), so the effective alpha lands around 10% in dark and an even weaker near-white orange in light.

Retiring the container ring also retires a surprising amount of machinery that exists only to make a ring paint on a shape that resists it — an entire sticky overlay element with a JS-published measured height, a `ringPlacement` prop, and a drag-time suppression rule whose stated reason is that a ring swallows the drop caret.

#### Strategy {#strategy}

- **Introduce a dedicated container-wash token rather than restrengthening `--tugx-focus-tint`.** That token is shared with leaves (`TugCheckbox`, `TugSwitch`, `TugSlider`) and floating surfaces (`TugAlert`, `TugPopover`), which keep their rings; strengthening it in place would loudly tint twelve consumers that never asked for it.
- **The wash value is a design decision, not an implementation one.** The user runs a mini design spike to land the `harmony` value before Step 1 executes; the plan's job is to give the spike one token to write into and a contrast gate to pass.
- **Light themes lead.** A wash over a light ground has a fraction of the luminance headroom it has over a dark one. Pick the value on `harmony` and derive the dark value from it, never the reverse.
- **Convert the two non-conformant components, then delete what the ring required.** `TugListView` and `TugAccordion` first; the `ringPlacement` apparatus and the carry-suppression rule fall out as consequences, not as separate goals.
- **The ring returns where there is no item to mark.** A container holding the key view with no cursor item inside it has no element-level mark at all, so it rings *in addition to* the wash — the one honest exception.
- **Reconcile the doctrine in the same phase as the code.** Two passages in `focus-language.md` explicitly bless the container ring; leaving them would make the law self-contradictory and re-license the ring on the next component.

#### Success Criteria (Measurable) {#success-criteria}

- **Met, for the six the plan enumerates.** No item-group container paints an `outline` or a `border-color` change on `data-key-view-kbd` or `data-key-within`, in any theme — verified by app-tests probing `getComputedStyle(container).outlineWidth === "0px"` on a focused `TugListView` (at0121), `TugAccordion` (at0120), `TugRadioGroup` (at0117), `TugChoiceGroup` (at0118), `TugOptionGroup` (at0119), and `TugTabBar` (at0116), plus at0340 across all six at once.

  **There is a seventh, and it still rings.** A tree-wide grep for surviving key-view outline rules (`grep -rn -A4 "\[data-key-view-kbd\] {" tugdeck/src tugdeck/styles`) returns three hits: the global **leaf** ring in `focus-ring.css` (correct, stays), `tug-text-editor.css` (a caret surface, not an item-group, stays), and **`.tug-alert-choices[data-key-view-kbd]` in `tug-alert.css`** — an alert's choice list, which is an item-group container by every structural test and draws a flush perimeter ring recoloring its frame, in the `TugListView` idiom it was copied from. Its rows already mark the cursor with a leading-edge bar, so it is the same archetype as the list and the accordion.

  It was **not** converted, deliberately. The plan's [#scope](#scope) enumerates six components and [#non-goals](#non-goals) names `tug-alert.css` as a `--tugx-focus-tint` consumer to leave untouched — converting it would widen the phase past a stated non-goal on the implementer's own initiative. It is a genuine gap in the *law*'s coverage rather than in this plan's execution, and it is recorded in [#roadmap](#roadmap). Note the non-goal's stated reason does not actually cover this case: it exempts a floating surface's own **boundary** ring (`TugPopover` / `TugSheet` / `TugAlert` becoming the key view), which is a different mark on a different element from the choice list inside the alert taking the key view.
- Every one of those six containers paints a non-transparent `background-image` layer on `data-key-view-kbd` — same probe, asserting `backgroundImage !== "none"`.
- `bun run audit:theme-contrast` passes with no theme exceeding the `brio` accessibility budget, with the new wash tokens in place across all six themes.
- The `.tug-list-view-ring` element, the `ringPlacement` prop, the `TugListViewRingPlacement` type, and the `RING_HEIGHT_PROPERTY` publisher are absent from the tree — verified by `grep -rn "ringPlacement\|tug-list-view-ring\|TugListViewRingPlacement" tugdeck/src` returning nothing.
- ~~A container holding `data-key-view-kbd` with no `[data-key-cursor]` descendant paints both the wash and a ring~~ — **withdrawn**, see [P06]. The state is unreachable: an empty item-group is refused the focus registration, so it never holds the key view. Verified instead by the absence of the rule — `grep -rn "has(\[data-key-cursor\])" tugdeck/src` returns nothing.
- No focus mark of any kind paints while `data-app-active="false"` — the wash included. Verified by an app-test that blurs the window and probes `backgroundImage` on the previously focused container.
- `bunx vite build` succeeds, and `just app-test-changed` is green.

#### Scope {#scope}

1. New container-wash tokens in `focus-ring.css`, role-injected through `buildRoleStyle`, with the values the design spike lands.
2. `TugListView`: container ring → wash, in both current placements; delete the `ringPlacement` apparatus entirely and update its two Lens call sites.
3. `TugAccordion`: container ring → wash; trigger cursor tint-fill → leading-edge bar matching the list's cursor.
4. The four already-conformant item-groups (`TugRadioGroup`, `TugChoiceGroup`, `TugOptionGroup`, `TugTabBar`) repointed from `--tugx-focus-tint` to the container-wash token, so all six share one axis.
5. `data-key-within` on an item-group becomes the reduced-strength wash; the global outline rule survives only for non-item-group containers.
6. ~~The empty-container ring fallback.~~ Withdrawn — the state is unreachable; see [P06].
7. The background-window (`data-app-active="false"`) suppression extended to cover the wash — a latent leak the strengthened value would make visible.
8. Doctrine reconciliation: `focus-language.md`, `list-view-usage.md`, and the Focus Language gallery card.
9. App-test updates for the four suites that assert the ring, plus new assertions for the wash.

#### Non-goals (Explicitly out of scope) {#non-goals}

- **Floating surfaces keep their rings.** `TugPopover`, `TugSheet`, `TugAlert`, and the inline-dialog shell wear a box-shadow ring when they become the key view (`focus-language.md`, "Buttons: fill is the live control"). That ring is a *boundary against arbitrary content underneath a floating surface*, not a focus mark on a group inside a stable one. Nothing in this plan touches them.
- **Leaf behind-tints are unchanged.** `--tugx-focus-tint` keeps its current value and its current twelve consumers. A checkbox, switch, slider, or button still gets ring + faint tint.
- **Text-field focus is unchanged.** The `--tugx-focus-wash` token in `tug-input.css` / `tug-textarea.css` is a *field fill* on the Key axis and is unrelated to this work despite the name collision — see [P02].
- **No engine changes.** No new `data-*` attribute, no `FocusManager` change, no change to which element receives which mark. This phase is entirely [L06] appearance.
- **No new themes and no palette changes.** The wash resolves from tokens that already exist in all six themes.

#### Dependencies / Prerequisites {#dependencies}

- **The design spike lands first.** The user runs a mini design spike to choose the `harmony` wash value (and, from it, the dark-theme value) before Step 1 executes. Step 1's tasks are written to consume that value. See [Q01].
- No other blocking work. The plan touches only `tugdeck/` CSS/TSX, `tuglaws/` docs, and `tests/app-test/`.

#### Constraints {#constraints}

- **[L06] appearance via CSS and DOM, never React state.** Every mark in this plan is a CSS rule keyed on an engine-projected attribute. No component may compute a wash from React state.
- **[L20] component-token sovereignty.** "When component A composes component B, A's CSS references only A-scoped tokens… A never overrides, aliases, or references B's tokens." Concretely for this plan: `tug-accordion.css` may not read a `--tugx-list-view-*` token, and the Lens may not declare a `--tugx-focus-*` override on a component's behalf. The related-but-distinct rule that **a host must not draw another component's focus marks** is the focus-language authoring contract ("A container's ring is the container's to draw"), not [L20] itself; both apply here and the plan cites them separately.
- **Warnings are errors** in the Rust workspace; not applicable here, but `bunx vite build` must be clean and the debug app loads the production rollup bundle, so a build check is mandatory before declaring any tugdeck change done.
- **`--tugx-focus-*` knob defaults must be `var(--x, default)` fallbacks at point of use**, not declarations on the component's own element — a `--tugx-*` declared on the component's own root silently beats any ancestor override.
- **Six themes.** `brio`/`nocturne`/`bravura` (dark) and `harmony`/`aria`/`vivace` (light). All six carry the same `--tugx-accent` (`--tug-color(orange, l: 755, c: 1000)`), so one accent-derived wash formula covers all six — but the *ground* it sits on differs sharply between the dark and light sets.
- **App-tests are selective.** `just app-test-changed` derives the run from the working diff via `@covers`; the full corpus is not run for this work.

#### Assumptions {#assumptions}

- The accent hue stays the container-wash hue and the Key axis (blue) stays the selection-fill hue, so a strengthened wash cannot be misread as selection. This is already true in every theme and is now written down as [P03].
- No consumer outside `tugdeck/src` reads `ringPlacement` or the `.tug-list-view-ring` class. Verified by grep at authoring time: the only call sites are `cards-section.tsx` and `snippets-section.tsx`, plus two app-tests.
- `TugListView`'s movement cursor is a leading-edge bar (`.tug-list-view-cell[data-key-cursor]::before`), not a ring, and stays that way. The bar is the element-level mark that makes the container wash sufficient.

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

This plan follows the anchors and label conventions in [tuglaws/devise-skeleton.md](../tuglaws/devise-skeleton.md): explicit `{#anchor}` headings, `[P##]` for plan-local decisions, `[Q##]` for open questions, `S##`/`T##`/`L##`/`R##` for specs, tables, lists, and risks. `[D##]` references, where they appear, point at the global [tuglaws/design-decisions.md](../tuglaws/design-decisions.md).

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] The wash value on the light themes (DECIDED — see [P10]) {#q01-wash-value}

**Question:** What alpha and source token produce a container wash that reads clearly as "the keyboard is in here" on `harmony`/`aria`/`vivace` without reading as a filled surface or as selection?

**Why it matters:** This is the single value the whole change rests on, and light is the hard case. Over `brio`'s dark ground there is a wide band of alphas that read as "lit but not filled." Over `harmony`'s light ground the same band is a few percent wide before the wash becomes a surface colour of its own, at which point the section looks *selected* rather than *focused*, and the six-theme contrast audit starts failing. Guessing a dark-first value and deriving light from it is the specific mistake this question exists to prevent.

**Known starting point (do not re-derive):** `layouts-section.css` already carries a working local override — `color-mix(in srgb, var(--tug7-element-global-fill-normal-accent-rest) 15%, transparent)`, i.e. 15% of the opaque full-chroma accent fill (`--tugx-accent` = `--tug-color(orange, l: 755, c: 1000)`), *not* the alpha-bearing accent tone the global default uses. That is the wash currently visible on the Layouts section. It was tuned by eye on a dark theme; its comment explicitly invites tuning.

**Options (if known):**
- Keep the accent **fill** as the source and tune only the alpha, with separate values per theme mode (a `:root[data-theme-mode="light"]` override, exactly as `--tugx-drop-ring-width` already does in `focus-ring.css`).
- Keep the accent **fill** and one alpha for all six themes, if the spike finds a value that reads in both modes.
- Move to a per-theme authored token in `themes/*.css` if a single formula cannot satisfy both modes.

**Plan to resolve:** The user runs a mini design spike against the running debug app (HMR is live on `tugdeck`, so token edits are immediate) before Step 1 executes, and lands the chosen value(s). Validate with `bun run audit:theme-contrast`.

**Resolution:** **DECIDED 2026-08-03** by the spike card `gallery-focus-wash.tsx` (§1 ramp × ground, §2 source comparison) — see [P10] for the values and what they overturn. The source question resolved to the accent **fill**, as assumed. The per-mode question resolved to **yes**: the two modes take different values.

#### [Q02] Reduced-strength ratio for `data-key-within` (DECIDED — 50%) {#q02-within-ratio}

**Question:** How much weaker than the key-view wash should the "contains the active control" wash be?

**Why it matters:** The two marks must be distinguishable at a glance without the weaker one disappearing. Today's analogue is the global within-outline at 32% of the ring colour (`focus-ring.css`). Too close and a descend is invisible; too far and a descended list looks unfocused.

**Options (if known):** Express the within wash as a percentage of the key-view wash (a starting point of ~50% mirrors the existing 32%-of-ring relationship at a mark type that carries less weight), or author it as an independent alpha.

**Plan to resolve:** Folded into the [Q01] spike — the two values are chosen against each other on screen, not independently.

**Resolution:** **MOOT — closed 2026-08-03 at [#step-5](#step-5).** Step 1 landed the ratio at 50% (3% dark / 5% light) as planned, and Step 5 then established that the reduced within-wash has no consumer to apply it to: the two descendable groups keep the *full* wash through a descend by design, and the four inline chip groups suppress `data-key-within` as a spurious stamp. With no mark to strengthen or weaken there is no ratio to choose, so the token and its alpha were removed rather than shipped unread. See the amendment on [P04] for the full argument, including why reintroducing the variant would need a new subject first.

The question was worth asking — "how much weaker than the key-view wash" is exactly the right question *if* the two marks coexist. What the implementation found is that on an item-group they never do.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| ~~Wash unreadable on light themes~~ — **retired**, disproved by the spike ([P10]) | — | — | Light landed at 10%, close to dark's 6%; per-mode override absorbs the difference | — |
| A later tuning pass raises the wash and it starts reading as a filled surface | med | med | [P10] records both values as the *minimum that reads* and names raising them as the failure direction | Any change to `--tugx-focus-container-wash` |
| Strengthened wash exposes the background-window leak | med | high | Fixed head-on in [#step-2](#step-2) — this is a latent bug today, not a new one | Any focus mark visible while the app is not foreground |
| A strong wash reads as selection | med | low | [P03] pins the hue split: wash on Accent, selection fill on Key | Any theme where accent and the "on" selection token converge |
| Deleting `ringPlacement` breaks a consumer not found by grep | low | low | Full-tree grep in the [#step-3](#step-3) checkpoint; `bunx vite build` catches type errors | Build failure |
| App-tests that assert the ring fail as false negatives | med | high | Each conversion lands in the step that breaks it ([#step-3](#step-3), [#step-4](#step-4)) — no step ever commits a knowingly-red tree | — |
| `:has()` style invalidation on the transcript list | med | med | [P06] gates the rule behind a consumer opt-in so it never watches the transcript subtree | Any regression in the typing-lag q99 budget |
| `[P06]` is unreachable and ships as dead code | low | med | Reachability is a task in [#step-6](#step-6), before the test is written | No surface can focus an empty group |

**Risk R01: The wash cannot be made to read on the light themes** {#r01-light-theme-headroom} — **RETIRED 2026-08-03**

- **Risk (as written):** Over `harmony`'s pale ground there may be no alpha at which an accent wash is both clearly visible and clearly not a surface fill, which would mean the design cannot ship as a wash-only treatment.
- **Outcome:** Disproved by the spike. Light has a comfortable band, and its landed value (10%) sits close to dark's (6%) rather than in a different regime ([P10]). The per-theme-mode override absorbs the difference at zero structural cost, exactly as the mitigation anticipated.
- **What replaced it:** the opposite concern. The risk was never that the wash would be too weak to read on light — it is that a wash tuned for confidence reads as a *filled surface*, in either mode. [P10] records that both landed values are the minimum that registers, and that raising them is the failure direction.

**Risk R02: The list's cursor bar is too quiet to be the sole element mark** {#r02-cursor-bar-weight}

- **Risk:** With the container ring gone, a list row's only focus mark is the leading-edge bar. If the bar reads as too subtle, the change trades one problem for another.
- **Mitigation:** The bar's width is already a single knob (`--tugx-list-key-ring-width`, 2px, shared by the bar and the ring being retired). Freeing it from the ring means it can be tuned for the bar alone during the same spike.
- **Residual risk:** None structural — this is a value, not a shape.

---

### Design Decisions {#design-decisions}

#### [P01] The container mark is a background wash; the ring and the caret mark elements only (DECIDED) {#p01-wash-marks-containers}

**Decision:** Every **item-group container** — `TugListView`, `TugAccordion`, `TugRadioGroup`, `TugChoiceGroup`, `TugOptionGroup`, `TugTabBar` — marks keyboard focus with a background **wash** and never with a ring, a border-colour change, or any stroke. Rings and the movement caret are reserved for marking **elements**: the cursor item inside a group, and leaf controls.

**Rationale:**
- It is already the written law. The contract table in `focus-language.md` under "The contract — engine attributes → CSS" specifies behind-tint for `data-key-view-kbd` on an item-group container, with the ring listed only for a leaf and for `data-key-cursor` on an item. Four of six components already obey it; this decision finishes the job rather than starting a new one.
- Stroke-vs-area gives the two questions ("which container?" / "which element?") two different kinds of mark, the same device the language already uses to keep focus (ring) separate from selection (fill). Two nested rings in one hue at two scales is the conflation the language exists to prevent.
- A wash owns no boundary, so it cannot swallow a mark drawn at the container's edge — which is the whole reason the carry-suppression exception exists ([P07]).

**Implications:**
- `tug-list-view.css` and `tug-accordion.css` lose their perimeter-ring rules.
- The `ringPlacement` apparatus loses its reason to exist ([P05]).
- The `focus-language.md` passages that bless the container ring must be rewritten ([#step-8](#step-8)), or the law contradicts itself and re-licenses the ring on the next component authored.

#### [P02] A new `--tugx-focus-container-wash` token; `--tugx-focus-tint` is untouched (DECIDED) {#p02-new-token}

**Decision:** Add `--tugx-focus-container-wash` and `--tugx-focus-container-wash-within` to the role axis on `body` in `focus-ring.css`. Do **not** restrengthen `--tugx-focus-tint`, and do **not** rename `--tugx-focus-wash`.

**Rationale:**
- `--tugx-focus-tint` is not container-specific. Twelve files consume it, including leaves that also wear a ring (`tug-checkbox.css`, `tug-switch.css`, `tug-slider.css`) and floating surfaces explicitly out of scope (`tug-alert.css`, `tug-popover.css`). Restrengthening it in place would loudly tint all of them for a change that concerns six containers.
- `--tugx-focus-wash` is already taken, and for an unrelated mark: it is the *text-field fill*, which rides the **Key** axis (the selection-fill hue) rather than the Accent axis, and repoints in lockstep with validation state (`tug-input.css`, `tug-textarea.css`). Renaming it to free the word would touch three files for no behavioural gain and would put a Key-axis token and an Accent-axis token one character apart.
- A distinct token name makes the grep for "who draws a container mark" exact.

**Implications:**
- The four already-conformant groups are repointed from `--tugx-focus-tint` to `--tugx-focus-container-wash` in [#step-4](#step-4), so all six containers share one axis and one strength.
- `buildRoleStyle` (`internal/tug-group-utils.tsx`) must inject the two new keys alongside the two it already injects, or a role-bearing group would wash accent-orange while ringing its own role colour. Note that it currently injects `--tugx-focus-tint` at 18% of the role token — a *different* strength from the global 65%-of-tone default, which is part of why container marks read inconsistently today.
- The doctrine word is **wash**; the token name is `--tugx-focus-container-wash`. They agree, which is the point of not reusing `-tint`.

#### [P03] The container wash rides Accent; the selection fill rides Key (DECIDED) {#p03-hue-split}

**Decision:** The container wash resolves from the Accent axis (`--tug7-element-global-fill-normal-accent-rest`, i.e. `--tugx-accent`) by default, and a committed selection fill continues to resolve from the Key axis (`--tug7-surface-toggle-primary-normal-on-rest`). A role-bearing group overrides both from its own role token, keeping them distinct within the role.

**Rationale:**
- This is already true in every theme and needs to be written down before the wash is strengthened, because strengthening is exactly what would make a hue collision legible. All six themes set `--tugx-accent` to orange, while the "on" selection token is cobalt in `brio` and blue in `harmony` — the two axes are far apart, and a strong orange wash therefore cannot be misread as a blue selection fill.
- Without the rule stated, the natural next move for someone strengthening the wash is to reach for the selection hue "so it matches", which is precisely the conflation the focus language forbids.

**Implications:**
- Any future theme must keep accent and the "on" selection token distinguishable; this becomes a constraint on theme authoring, noted in `theme-engine.md` terms but enforced by `audit:theme-contrast` and by review.

#### [P04] No item-group container rings on `data-key-within`; the global outline survives only elsewhere (DECIDED — amended at [#step-5](#step-5)) {#p04-key-within}

**Decision:** No item-group container paints an outline on `data-key-within`. The global `[data-key-within]` outline rule in `focus-ring.css` stays, unchanged, for containers that are *not* item-groups — the sheet holding an open popover, the chrome case the mark was designed for.

**Amendment (2026-08-03, at implementation):** as written this decision also called for a *reduced-strength* wash (`--tugx-focus-container-wash-within`) on an item-group carrying the mark. Building the six components found that variant has **no subject**, and it was dropped rather than shipped as dead code. The reasoning, which is worth keeping because it is the argument against reintroducing it:

`data-key-within` is stamped on exactly one element — the container a scope was descended **from** (`FocusManager`'s `restoreKeyView`; only the top scope's container is marked, no ancestor chain). So the two groups that can legitimately receive it are the two descendable ones, `TugListView` and `TugAccordion` — and both keep the **full** wash for it on purpose, because a descend goes deeper into the container rather than out of it ([#descend-behavior](#descend-behavior)). The other four are inline chip groups whose items are never descended into; for them the mark is only reachable as the spurious transient stamp `TugRadioGroup`'s CSS already documents (a trap re-pushed while the key view is already inside it captures the group as its restore-key-view, then the on-open seed moves the key view away). A reduced wash would therefore have painted only on a stamp that should not be there.

The half of this decision that *did* find a subject is the more important half, and it turned out to be a live defect rather than a tidy-up: `TugChoiceGroup`, `TugOptionGroup`, and `TugTabBar` had no `data-key-within` rule at all, so they fell through to the **global outline** and rang their containers on that stamp. That was precisely the outcome the decision's own rationale warns about — "it leaves exactly one container ring in the app for the least important state." All four chip groups now suppress the mark outright, matching what `TugRadioGroup` had already worked out on its own.

[Q02] (the reduced-strength ratio) is moot as a consequence: with no consumer, there is no ratio to choose. It is recorded as such rather than deleted, since the question was real and the answer is "the mark this would have applied to does not exist."

**Rationale:**
- If containers stop ringing on `data-key-view-kbd` but keep ringing on `data-key-within`, the loud mark becomes a wash while the quiet one stays a stroke — backwards, and it leaves exactly one container ring in the app for the least important state.
- One wash at two strengths is a single legible axis; the reader learns one mark and reads its intensity.
- Restricting rather than deleting the global rule preserves the "quiet mark for a container the keyboard has genuinely left the surface of" case, which floating surfaces still need and which this plan does not touch ([#non-goals](#non-goals)).
- `TugRadioGroup` already suppresses `data-key-within` outright (a radio group is a single Tab stop and is never a descend target, but the engine can transiently stamp it across an HMR remount mid-dialog). That suppression stays as-is — the group shows only its key-view wash.

**Implications:**
- Each item-group's CSS gains a `[data-key-within]` rule mirroring its `[data-key-view-kbd]` rule at the reduced strength.
- `TugListView` and `TugAccordion` keep the *full* container mark through a descend, as they do today — the descend passage's behaviour is preserved, only the mark's shape changes. See [#descend-behavior](#descend-behavior).
- at0199 (which counts `data-key-within` attribute presence, not paint) is unaffected.

#### [P05] Delete the `ringPlacement` apparatus entirely (DECIDED) {#p05-delete-ring-placement}

**Decision:** Remove the `ringPlacement` prop, the `TugListViewRingPlacement` type, the `data-ring-placement` attribute, the `.tug-list-view-ring` sticky overlay element and its CSS, the `RING_HEIGHT_PROPERTY` scrollport-height publisher and its `ResizeObserver`, and the `--tugx-list-view-cursor-bar-inset` stacking adjustment. Update the two call sites that pass `ringPlacement="inset"` to stop passing it.

**Rationale:**
- Every piece of it exists solely to make a *ring* paint on a shape that resists one. Its own CSS comment records the chain: an edge-to-edge list in a clipping host loses an outset outline to the host's overflow; an inset outline or box-shadow is punched through by any row with an opaque fill, because a `TugListRow` is a stacking context that paints after the container's border phase; a real border would take layout space and hold the rows off the host's edge, which is the one thing an edge-to-edge list must not do. The residue is a zero-height sticky child whose height CSS cannot compute, so the component measures the scrollport in a layout effect and publishes it as a custom property.
- A background wash has none of these problems: no offset, no clipping interaction, no radius negotiation, no stacking-context fight, no measured height, no layout cost.
- **The wash gets the overlay's defining property for free.** `background-attachment` defaults to `scroll`, which for a scroll container means the background is fixed with regard to the element's border box and does *not* scroll with the content. Covering the visible scrollport and staying put is exactly what `.tug-list-view-ring` needed a sticky child, a `clientHeight` measurement, and a `ResizeObserver` to fake. Record this where the overlay is deleted so nobody re-derives the sticky construction for the next surface.
- **It also composites correctly over real rows**, which is the physics this whole design rests on and was verified before writing this plan rather than assumed — see [#wash-composition](#wash-composition).
- Leaving the prop as a deprecated no-op would leave a mode in the public API that means nothing, which is worse than the ring.

**Implications:**
- `tug-list-view.tsx` loses a layout effect, a `ResizeObserver`, a rendered element, an exported type, and a prop.
- `cards-section.tsx` and `snippets-section.tsx` drop the prop.
- The paragraph in `lens-section-band.css` that explains why the Lens's lists pass `ringPlacement="inset"` is deleted.
- The authoring-contract bullet in `focus-language.md` that cites `ringPlacement="inset"` as the reference example of "a container's ring is the container's to draw" must be rewritten around a different example — the law itself ([L20] component-token sovereignty) is unchanged and still correct; only its illustration dies.
- at0255 and at0277 probe `.tug-list-view-ring`'s `::before` border width and are converted in the same step that deletes it ([#step-3](#step-3)).

#### [P06] A container with no cursor item rings, in addition to the wash (WITHDRAWN 2026-08-03 — unreachable by construction) {#p06-empty-container-ring}

**Withdrawn at [#step-6](#step-6), before any CSS was written.** The reachability task this decision itself demanded found that an item-group container can never hold the key view with no cursor item inside it — and, more pointedly, that the codebase had already reached this decision and settled it the other way.

`lens-section-content.ts` is explicit. A section publishes `navigable` — "at least one cursorable row RIGHT NOW, after the filter" — and its docstring states the consequence in as many words: *"Each section gates its list's `focusGroup` on it, so an empty list is not a focus stop (Tab skips it, **no perimeter ring paints on emptiness**), and `LensContent` picks the Cmd-L seed target as the first expanded section that has it, so the opening key view lands on a real item."* A section filtered to zero is `navigable: false, populated: true`: out of the keyboard walk, filter field still live. So the exact path this decision was written around — filter a list to zero, then move the key view onto it — is not merely unreached, it is deliberately foreclosed, and the words "no ring paints on emptiness" are already the law.

The other five groups close the remaining gap. `TugRadioGroup`, `TugChoiceGroup`, `TugOptionGroup`, `TugTabBar`, and `TugAccordion` are authored with fixed item sets rather than filtered ones, and a group that has items always seeds a cursor when it takes the key view (the behaviour at0117 and at0121 pin). There is no third case.

Shipping the rule anyway would have meant a `:has()` in six stylesheets and a `data-empty-ring` prop on `TugListView`'s public API, all of it unreachable — and the accessibility guarantee it was meant to provide (WCAG 1.4.11, never leave a low-alpha background as the sole focus indicator) is genuinely provided, one level up, by refusing the focus registration in the first place. That is the better place for it: a container that cannot take the keyboard needs no focus mark at all.

**What this means for a future author.** The guarantee lives in the **focus registration**, not in CSS. Any new surface that lets an item-group take the key view while empty must either gate on `navigable` the way the Lens sections do, or reinstate something like this decision. That is now stated in `focus-language.md` ([#step-8](#step-8)) so the reasoning survives where the next person will look for it.

The Risk table entry that anticipated this outcome ("`[P06]` is unreachable and ships as dead code") is therefore **realised, and mitigated as designed** — the reachability check ran before the test was written, which is exactly what it was there for.

**The original decision, for the record:** An item-group container that holds `data-key-view-kbd` while containing no `[data-key-cursor]` descendant paints the wash **and** a ring. Implemented per component as `:not(:has([data-key-cursor]))`, **opt-in per list rather than blanket on `.tug-list-view`** — see the implication below.

**Rationale:**
- The wash is sufficient as a container mark precisely *because* an element-level mark sits inside it. When there is no element to mark — an empty list, a filter that matched nothing, a group whose items have not mounted — the wash becomes the sole focus indicator, and a low-alpha background alone is a weak one (WCAG 1.4.11 asks for 3:1 for the focus indicator itself).
- The ring is never redundant in this case by construction: it appears only when there is no item mark for it to double up with.
- The alternative of forbidding empty groups from taking the key view cannot hold — a list filtered to zero results must keep the keyboard so the next keystroke can widen the filter.

**Implications:**
- **The rule must not reach the transcript.** `session-card-transcript.tsx` mounts a `TugListView`, and that list is the app's largest DOM surface — the eviction work measures it at 40k–64k nodes with 1372 collapsed headers (`dash/transcript-dom-eviction.md`), against a live typing-lag program (`dash/aug01-perf-brief.md`). A bare `.tug-list-view:not(:has([data-key-cursor]))` makes every subtree mutation in that list a candidate for `:has()` style invalidation on the scroll container, which is a perf bet this plan has no reason to take. The existing `:has()` uses in the tree are not the same bet: `snippets-section.css`'s `:has(.snippet-editor:focus-within)` and `lens-section-band.css`'s `:has(.tug-list-view)` both run over small, shallow subtrees.
- **Therefore the empty-container ring is opt-in.** `TugListView` renders a `data-empty-ring` attribute (or equivalent) only for lists whose consumer asks for it, and the CSS keys on that. A transcript can never be a keyboard-focused empty group in the first place, so it opts out and pays nothing. The five non-list groups take the plain `:has()` form — they are small and bounded.
- The empty case needs an app-test, since it is the one path where a ring is still correct and a future cleanup would otherwise delete it as dead code.
- **Reachability must be confirmed before the test is written.** If no surface can actually put the key view on an empty group, [P06] is dead code rather than an accessibility guarantee — see [#step-6](#step-6).

#### [P07] A carry suppresses the cursor bar only; the wash stays up (DECIDED) {#p07-carry-suppression}

**Decision:** During a block reorder (`data-tug-carrying="true"` on an ancestor), suppress the movement cursor's bar as today, but leave the container wash painted. Delete the container half of the suppression.

**Rationale:**
- `focus-language.md`'s "A carry suppresses the focus marks" gives a specific reason for the container half, and it is a reason about *shape*: *"A ring drawn around the whole list is the one shape that swallows a caret sitting at that list's top or bottom edge outright."* A wash draws no edge, sits behind the content, and cannot swallow the drop caret at any position.
- The cursor bar's reason is different and still holds: it is a stripe of accent along the leading edge of one row, drawn in the same hue as the drop caret, pointing at a row the carry may be about to move. Mid-gesture it reads as a mark on the drop.
- Keeping the wash up during a carry is also better behaviour on its own terms: the keyboard has not moved, and the language's stated preference is that marks stand down only when they actively mislead.

**Implications:**
- `tug-list-view.css`'s carry block shrinks to the cursor-bar rule; the two container rules and the inset-ring rule go with the ring.
- `focus-language.md`'s carry section is rewritten to describe a narrower exception — one mark, not two — and to record *why* it narrowed, so a future reader does not restore the container half.
- `snippets-section.css` has a parallel quieting for the open-snippet-editor case (`:has(.snippet-editor:focus-within)`), which silences the within-mark, the inset ring, and the cursor bar so no accent ink competes with the caret. That rationale is about ink in general, not about shape, so it is preserved — but its selectors must be repointed from `outline` / `.tug-list-view-ring::before` to the wash's `background-image`.

#### [P08] The accordion's movement cursor becomes a leading-edge bar (DECIDED) {#p08-accordion-cursor-bar}

**Decision:** `TugAccordion`'s cursor mark on a trigger changes from a reduced tint **fill** to a leading-edge **bar**, matching `TugListView`'s cursor bar in colour, width, and placement. The global `[data-key-cursor]` outline stays suppressed for accordion triggers.

**Rationale:**
- With the container becoming a wash, a tint-fill cursor would be a wash sitting on a wash — the same kind of mark at two strengths, for two different questions.
- The accordion's own CSS comment already claims the fill was chosen as "matching the list cursor row", which is stale: the list's cursor is a bar (`.tug-list-view-cell[data-key-cursor]::before`), not a fill. This change makes the comment true.
- It yields a clean rule the whole language can state: **full-width row containers** (list, accordion) mark the cursor with a leading bar; **inline chip groups** (radio, choice, option, tab) mark it with a ring. Both are element marks; the shape follows the item's shape.

**Implications:**
- `tug-accordion.css` loses `--tugx-accordion-cursor-tint` and gains a bar rule.
- **The shared bar knobs must be promoted, not borrowed.** The bar's colour and width live today in `--tugx-list-view-cursor-bar-color` / `--tugx-list-view-cursor-bar-width`, which are `TugListView`-slot tokens. `tug-accordion.css` reading them would be a straight [L20] violation — "A never overrides, aliases, or references B's tokens." So Step 4 **must** promote them to neutral `--tugx-focus-cursor-bar-*` knobs in `focus-ring.css`, where both components read them as language-level tokens rather than one component reaching into another's slot. This is not optional and not a follow-on; keep the old names as `var(--new, …)` aliases so no consumer breaks.
- at0120 asserts `outlineWidth > 0` on the accordion container and is converted **in Step 4**, not deferred.

#### [P09] Focus marks stand down when the window is not foreground — the wash included (DECIDED) {#p09-app-active}

**Decision:** Extend the `[data-app-active="false"]` suppression in `focus-ring.css` to suppress `background-image` alongside `outline`, and **anchor the selector on `html`** so it outranks every component rule by construction rather than by source order.

**Rationale:**
- This is a **latent bug today, discovered while mapping the change**. The global rule sets only `outline: none` — its own comment says "the per-component behind-tint is quieted at its own site" — but none of `tug-radio-group.css`, `tug-choice-group.css`, `tug-option-group.css`, `tug-tab-bar.css`, `tug-accordion.css`, `tug-list-view.css`, or `layouts-section.css` contains any `data-app-active` rule. The container tint therefore keeps painting while the app sits in the background right now. It goes unnoticed only because the default tint is nearly invisible.
- Strengthening the wash is exactly what turns an unnoticed leak into a visible one: a background window would show a lit section. Fixing it is part of this change, not a follow-on.
- The behaviour being restored is the stated one — the keyboard focus language goes quiet while the OS window is not foreground, matching native controls whose ring dims when the window resigns key.

**Implications:**
- **The current selector would lose a tie it cannot afford.** `[data-app-active="false"] [data-key-view-kbd]` has specificity (0,2,0). So does `.tug-list-view[data-key-view-kbd]`, and so does every other component container rule this plan writes — one class plus one attribute. At equal specificity the cascade falls through to **source order**, which here is Vite's CSS emission order: not something the plan controls, not something a later refactor preserves, and not something any test would obviously catch if it flipped. `data-app-active` is projected onto `<html>` (`DeckManager.setHasFocus`), so writing the rule as `html[data-app-active="false"] …` raises it to (0,2,1) and it wins everywhere, permanently, with no per-component duplication.
- The fix lands in [#step-2](#step-2), *before* any component is converted, so no intermediate commit ships a visibly-leaking wash.
- Needs an app-test; the harness can blur the window, and the assertion is a computed-style probe rather than anything rAF-dependent, so it is safe in a background test window.

#### [P10] The wash is 6% of the accent fill on dark, 10% on light (DECIDED) {#p10-wash-values}

**Decision:** `--tugx-focus-container-wash` resolves to `color-mix(in srgb, var(--tug7-element-global-fill-normal-accent-rest) 6%, transparent)` on the dark themes and the same formula at **10%** on the light ones, via a `:root[data-theme-mode="light"]` override. The source is the accent **fill**, as [P02] assumed.

**Rationale:**
- Landed by eye on the spike card (`gallery-focus-wash.tsx`), which ramps eight alphas across the three grounds a container actually sits on, in both modes. In each mode the *minimum* rung that registers is also the rung that reads best — the wash does not want headroom above that.
- **This overturns the plan's own starting assumption.** [Q01] opened with 15% (the value `layouts-section.css` had reached for by eye on a dark ground) and treated the ramp's middle as the likely answer. The spike says the answer is the floor: at 15% the wash has already begun reading as a *filled surface* rather than a lit one, which is precisely the failure mode [P01] exists to avoid. The Layouts section's local override was tuned against the near-invisible global default, so it was calibrated to beat the wrong reference.
- The two modes genuinely differ, so [Q01]'s per-mode option is taken rather than declined. Light needs the extra few points to clear its pale ground; forcing one value would either wash out on light or over-fill on dark.
- Low values also widen the margin on every downstream risk: less chance of reading as selection ([P03]), more headroom under the six-theme contrast budget, and a quieter ground for the cursor bar that [P01] exists to make findable.

**Implications:**
- Step 1 lands concrete values, not a placeholder, and its checkpoint is a real gate rather than a provisional note.
- The per-mode split needs the right scope. Geometry knobs live on `:root`; the role-axis colour tokens must live on `body` (a `var(--tug7-*)` evaluated at `:root` resolves invalid and collapses every rule that reads it). `data-theme-mode` rides `<html>`, so the override selector is `:root[data-theme-mode="light"] body`.
- `--tugx-focus-container-wash-within` derives from these at the [Q02] ratio, landing at 3% dark / 5% light — low enough that it needs the confirming look [Q02] now calls for.
- Risk R01 ("the wash cannot be made to read on the light themes") is **retired**: light not only works, it works at a value close to dark's.

---

### Deep Dives (Optional) {#deep-dives}

#### Current state, component by component {#current-state}

**Table T01: Container focus treatment before this plan** {#t01-current-state}

| Component | File | `data-key-view-kbd` on container | `data-key-cursor` on item | Conformant to the law? |
|---|---|---|---|---|
| `TugRadioGroup` | `tugways/tug-radio-group.css` | `outline: none` + `--tugx-focus-tint` gradient | ring, `outline-offset: 1px` | yes |
| `TugChoiceGroup` | `tugways/tug-choice-group.css` | `outline: none` + `--tugx-focus-tint` gradient | ring, `outline-offset: 1px` | yes |
| `TugOptionGroup` | `tugways/tug-option-group.css` | `outline: none` + `--tugx-focus-tint` gradient | ring, `outline-offset: 1px` | yes |
| `TugTabBar` | `tugways/tug-tab-bar.css` | `outline: none` + `--tugx-focus-tint` gradient | flush inset box-shadow (the bar clips) | yes |
| `TugListView` | `tugways/tug-list-view.css` | **perimeter outline + `border-color` recolor**, or the inset overlay ring | leading-edge **bar** | **no** |
| `TugAccordion` | `tugways/tug-accordion.css` | **perimeter outline**, `background-image: none` | reduced tint **fill** | **no** |
| Lens Layouts group | `lens/sections/layouts-section.css` | local `--tugx-focus-tint` override → 15% of accent **fill** | (radio items) | yes — and it is the wash prototype |

The two non-conformant rows are the work. The Layouts row is the evidence.

#### Why the list's ring needed an overlay {#inset-ring-history}

Recorded here because it is the argument for [P05] and because deleting machinery without recording why it existed invites its return.

`TugListView` supports two ring placements. `"outset"` draws a perimeter `outline` whose width is `--tugx-list-key-ring-width` minus the list's own frame width, so that a framed list (the dev picker boxes, which recolor their border to the ring hue) and an unframed one total the same visual thickness.

`"inset"` exists for an edge-to-edge list inside a clipping host — a Lens band, a rail — where an outset outline falls outside the host's overflow and never paints. Per the CSS comments, it could not be implemented as:

- an inset `outline` or `box-shadow`, because `TugListRow` is a stacking context (it owns its press layer) and paints after the container's border/outline phase, so any row with an opaque fill punches a hole in the ring exactly where it sits;
- a real `border`, because that takes layout space and holds the rows off the host's edge, which is the one thing an edge-to-edge list must not do.

What remains is `.tug-list-view-ring`: a zero-height `position: sticky` child pinned to the scrollport, rendered first in the box, painting its ring as a `::before` overlay at `z-index: 4`. Its height cannot come from CSS — a percentage height inside a scroller resolves against the *scrolled length*, not the window onto it — so `tug-list-view.tsx` measures `scroller.clientHeight` in a layout effect, publishes it as `RING_HEIGHT_PROPERTY`, and keeps it current with a `ResizeObserver`. The cursor bar then has to be inset by one ring-width (`--tugx-list-view-cursor-bar-inset`) so the two marks stack rather than overlap.

A `background-image` wash on the scroll container has no interaction with any of this.

#### The wash composites over real rows — verified, not assumed {#wash-composition}

A container-level `background-image` paints *behind* every row, so the design only works if rows are transparent enough to let it through. This is the same physics that defeated the inset ring ("a row with an opaque fill punches a hole in the ring exactly where it sits"), so it was checked against the real stylesheets before this plan was written rather than reasoned about. Recorded here so the implementer does not have to re-derive it, and so a future row variant that breaks the assumption can be recognised as breaking it.

**Table T02: Row background opacity vs. the container wash** {#t02-row-opacity}

| Row state | Token | Resolves to | Wash visible through it? |
|---|---|---|---|
| Cell at rest | `.tug-list-view-cell` | `background-color: transparent` | yes |
| Striped row, either parity | `--tugx-list-view-stripe-color` / `-base-color` | `color-mix(in srgb, <tint> N%, transparent)`, N = 2–11 (`internal/list-view-striping.ts`) | yes — translucent by construction |
| Pill-variant row at rest | `--tugx-list-row-pill-rest-bg` → `--tug7-surface-control-primary-outlined-action-rest` | `transparent` in every theme | yes |
| **Selected row** | `--tugx-list-row-selected-bg` → `--tug7-surface-selection-primary-normal-quiet-rest` | opaque (`cobalt l:510 c:180` in `brio`, `blue l:620 c:260` in `harmony`) | **no** |

The one opaque case is correct behaviour, not a defect: a selected row already carries the strongest mark on the surface, and this is exactly how the four already-conformant groups behave today — their behind-tint sits behind the items and a selected item's fill covers it. No rule is needed; the occlusion is the right outcome.

The implication for tests is that container-level probes stay valid — the assertions in this plan read `backgroundImage` on the **container**, which is unaffected by what any row paints on top.

#### Descend behaviour is preserved {#descend-behavior}

`focus-language.md` states that a descend goes *deeper into* a container rather than out of it, so an item-group whose own item hosts the descend destination keeps its **full** marks — container mark plus item cursor — rather than dropping to the quiet within-mark. `TugListView` implements this by lighting the same ring for `[data-key-view-kbd]` and `[data-key-within]`, and at0277 asserts it.

This plan does not change that behaviour. It changes the mark's shape. Under [P04] the list and accordion keep the **full-strength** wash through a descend (matching the current full-strength ring), while the reduced within-wash applies to groups that are not descend targets. The distinction to preserve in the CSS is exactly the one that exists today: `TugListView` and `TugAccordion` treat `[data-key-within]` identically to `[data-key-view-kbd]`; the other four either suppress it (`TugRadioGroup`) or never receive it.

#### Where the six themes stand {#theme-ground}

All six themes share `--tugx-accent: --tug-color(orange, l: 755, c: 1000)` — an opaque, full-chroma orange — which is what `--tug7-element-global-fill-normal-accent-rest` aliases to and what `layouts-section.css` mixes down to 15%.

The current default wash source is a different, much weaker token: `--tug7-surface-tone-primary-normal-accent-rest`, which is `--tug-color(orange, l: 740, c: 300, a: 150)` in `brio` and `--tug-color(orange, l: 910, c: 120, a: 350)` in `harmony`. Both are *already alpha-bearing*, and `--tugx-focus-tint` mixes them down a further 65%, which is how the effective alpha lands near 10% in dark and how `harmony`'s near-white low-chroma orange ends up invisible over a light ground. This is the arithmetic behind the Layouts section's local override and behind [Q01]'s instruction to start from the fill, not the tone.

Selection fills ride a different family entirely: `--tug7-surface-toggle-primary-normal-on-rest` is cobalt in `brio`, blue in `harmony`. That separation is what [P03] pins.

---

### Specification {#specification}

**Spec S01: The container-wash tokens** {#s01-wash-tokens}

Declared on `body` in `tugdeck/styles/focus-ring.css`, alongside the existing role axis (they must be on `body`, not `:root`: the `--tug7-*` theme tokens are themselves scoped to `body`, and a `var(--tug7-*)` evaluated at `:root` resolves to the guaranteed-invalid value, which inherits down and collapses every rule that reads it).

| Token | Default source | Role-injected by `buildRoleStyle` | Consumed by |
|---|---|---|---|
| `--tugx-focus-container-wash` | accent **fill** at **6%** (dark) / **10%** (light) — [P10] | yes — from the group's role token | the six item-group containers on `[data-key-view-kbd]` |
| `--tugx-focus-container-wash-within` | the above at the [Q02] ratio — 50% → 3% / 5% pending the confirming look | yes | item-group containers on `[data-key-within]` that are not descend targets |

Painted by each component as a gradient overlay over its own background, so it composes with any surface, exactly as the existing behind-tint does:

```css
background-image: linear-gradient(
  var(--tugx-focus-container-wash),
  var(--tugx-focus-container-wash)
);
```

Per-mode values, if the spike needs them, follow the `--tugx-drop-ring-width` precedent already in `focus-ring.css`: a base declaration plus a `:root[data-theme-mode="light"]` override — noting that the *geometry* knobs live on `:root` while the *role axis* must live on `body`, so a per-mode colour override needs the `body` scope and a `[data-theme-mode="light"] body` selector or equivalent.

**Spec S02: The per-component rule shape** {#s02-rule-shape}

Every item-group container's CSS carries this shape. `<sel>` is the component's container selector.

```css
/* container key view → wash, never a stroke */
<sel>[data-key-view-kbd] {
  outline: none;
  background-image: linear-gradient(
    var(--tugx-focus-container-wash),
    var(--tugx-focus-container-wash)
  );
}

/* contains the active control → reduced wash ([P04]) */
<sel>[data-key-within] {
  outline: none;
  background-image: linear-gradient(
    var(--tugx-focus-container-wash-within),
    var(--tugx-focus-container-wash-within)
  );
}

/* NO empty-container ring rule — [P06] was withdrawn as unreachable.
   An empty item-group is refused the focus registration, so it never
   holds the key view. See [P06] and [#step-6](#step-6). */
```

The `[data-key-within]` half of this shape resolved differently in practice, and the shape above is superseded by the [P04] amendment. Two components take the **descend variant**: `TugListView` and `TugAccordion` paint the **full** wash for `[data-key-within]` — their two rules collapse into one `:is([data-key-view-kbd], [data-key-within])` selector, since a descend goes deeper into the container rather than out of it. The other four are inline chip groups that are never descend targets, and they **suppress** the mark outright (`outline: none`) rather than painting a reduced wash — the mark only reaches them as a spurious engine stamp, and before this plan three of them fell through to the global rule and rang. There is therefore no reduced-strength wash token at all.

The background-window suppression is authored once, globally, anchored on `html` so it beats every rule above regardless of bundle order ([P09]):

```css
html[data-app-active="false"] :is([data-key-view-kbd], [data-key-cursor], [data-key-within]) {
  outline: none;
  background-image: none;
}
```

#### State Zone Mapping (tugdeck/tugways plans) {#state-zone-mapping}

| State | Zone | Mechanism | Law |
|-------|------|-----------|-----|
| Container wash colour / strength | appearance | CSS custom properties on `body`, read by component CSS | [L06], [L20] |
| "This container holds the key view" | appearance (projection of engine structure) | existing `data-key-view-kbd`, projected by `FocusManager.reproject` — unchanged | [L06], [L22] |
| "This container contains the active control" | appearance (projection) | existing `data-key-within` — unchanged | [L06], [L22] |
| "This container has no cursor item" | appearance | CSS `:not(:has([data-key-cursor]))` — derived in CSS, never computed in JS | [L06] |
| Role-resolved wash for a role-bearing group | appearance | `buildRoleStyle` inline custom properties (existing mechanism, two new keys) | [L06], [L20] |
| Scrollport height for the inset ring | **deleted** | was a `ResizeObserver` + published custom property; removed with the ring ([P05]) | [L06] |

Nothing in this plan introduces React state, store state, or a new engine attribute.

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

None.

#### Symbols to add / modify / remove {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `--tugx-focus-container-wash` | CSS custom property | `tugdeck/styles/focus-ring.css` (on `body`) | **add** — Spec S01 |
| `--tugx-focus-container-wash-within` | CSS custom property | `tugdeck/styles/focus-ring.css` (on `body`) | **add** — Spec S01 |
| `--tugx-focus-cursor-bar-color` / `-width` | CSS custom properties | `tugdeck/styles/focus-ring.css` | **add** — promoted from `--tugx-list-view-cursor-bar-*` so two components share a language-level knob instead of one reaching into the other's slot ([P08], [L20]) |
| `--tugx-list-view-cursor-bar-color` / `-width` | CSS custom properties | `tugdeck/src/components/tugways/tug-list-view.css` | **modify** — become `var(--tugx-focus-cursor-bar-*, …)` aliases so no consumer breaks |
| `data-empty-ring` (or equivalent opt-in) | prop + DOM attribute | `tugdeck/src/components/tugways/tug-list-view.tsx` | **add** — gates the `:has()` empty-container rule so it never watches the transcript subtree ([P06]) |
| `buildRoleStyle` | function | `tugdeck/src/components/tugways/internal/tug-group-utils.tsx` | **modify** — inject the two new keys from the role token |
| `[data-app-active="false"]` block | CSS rule | `tugdeck/styles/focus-ring.css` | **modify** — suppress `background-image` too ([P09]) |
| `[data-key-within]` global rule | CSS rule | `tugdeck/styles/focus-ring.css` | **modify** — scope away from item-groups ([P04]) |
| `TugListViewRingPlacement` | exported type | `tugdeck/src/components/tugways/tug-list-view.tsx` | **remove** ([P05]) |
| `ringPlacement` | prop on `TugListViewProps` | `tugdeck/src/components/tugways/tug-list-view.tsx` | **remove** ([P05]) |
| `RING_HEIGHT_PROPERTY` + its layout effect / `ResizeObserver` | const + effect | `tugdeck/src/components/tugways/tug-list-view.tsx` | **remove** ([P05]) |
| `.tug-list-view-ring` element render | JSX | `tugdeck/src/components/tugways/tug-list-view.tsx` | **remove** ([P05]) |
| `data-ring-placement` attribute | DOM attribute | `tugdeck/src/components/tugways/tug-list-view.tsx` | **remove** ([P05]) |
| `.tug-list-view-ring` rules, perimeter-ring rules, carry container rules, `--tugx-list-view-cursor-bar-inset` | CSS | `tugdeck/src/components/tugways/tug-list-view.css` | **remove** ([P05], [P07]) |
| `--tugx-accordion-cursor-tint` | CSS custom property | `tugdeck/src/components/tugways/tug-accordion.css` | **remove**, replaced by the bar ([P08]) |
| `ringPlacement="inset"` | call site | `tugdeck/src/components/lens/sections/cards-section.tsx` | **remove** ([P05]) |
| `ringPlacement="inset"` | call site | `tugdeck/src/components/lens/sections/snippets-section.tsx` | **remove** ([P05]) |
| "Container focus on an edge-to-edge list" comment block | CSS comment | `tugdeck/src/components/lens/sections/lens-section-band.css` | **remove** ([P05]) |
| Local `--tugx-focus-tint` override | CSS | `tugdeck/src/components/lens/sections/layouts-section.css` | **remove** — superseded by the global token ([P02]) |
| `ListRows` replica + §8 note | component + copy | `tugdeck/src/components/tugways/cards/gallery-focus-language.tsx` | **modify** — the static replica must show a wash, not a ring |

---

### Documentation Plan {#documentation-plan}

- [ ] `tuglaws/focus-language.md` — the contract table row for item-group containers; the descend passage that says "the container ring says which group the control belongs to"; the authoring-contract bullet "A container's ring is the container's to draw" and its `ringPlacement="inset"` example; the carry-suppression section (narrowed per [P07], with the reason it narrowed).
- [ ] `tuglaws/list-view-usage.md` — any mention of the container ring; add the wash to the focus-marks description.
- [ ] `tugdeck/src/components/tugways/cards/gallery-focus-language.tsx` — §8 "Descendable rows — list / accordion" note already describes the intended law ("behind-tint on focus, ring on the cursor row") but the `ListRows` static replica paints a ring; bring the replica in line and extend the note to name the wash and the empty-container exception.
- [ ] `tuglaws/design-decisions.md` — consider a `[D##]` entry for [P01] and [P03], since "rings mark elements, washes mark containers" and the accent/key hue split are durable cross-component rules rather than plan-local ones. Decide at [#step-8](#step-8); if added, cite the new `[D##]` from `focus-language.md` rather than restating it.

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **App-test (computed style)** | Probe `getComputedStyle` on real containers in the real app for `outlineWidth` and `backgroundImage` | The primary instrument — the marks are CSS, so the assertion is CSS |
| **App-test (behavioural)** | Existing focus/descend/carry suites keep passing with converted assertions | at0120, at0127, at0255, at0277 |
| **Build / audit** | `bunx vite build`, `bun run audit:theme-contrast` | Every step |

All assertions are computed-style reads, which are safe in a background test window — they are not rAF-dependent and do not need the window visible.

**No step commits a knowingly-red tree.** Where a step changes a mark that an existing app-test asserts, that test is converted **in the same step**, not deferred to a later cleanup. Deferring would leave known failures standing across several commits, and a genuine regression arriving in that window would be indistinguishable from the expected ones. This is why at0255 and at0277 land in [#step-3](#step-3) and at0120 lands in [#step-4](#step-4), leaving [#step-7](#step-7) as a sweep rather than a backlog.

#### What stays out of tests {#test-non-goals}

- **Screenshot diffing of the wash.** The value is a design judgement being tuned by eye in a spike; pinning pixels would freeze a value the spike exists to choose, and the app-test screenshot path has a known Custom-Highlight wash artefact that makes colour comparison unreliable.
- **Per-theme visual assertions for all six themes.** `audit:theme-contrast` is the six-theme gate; duplicating it as app-tests would be slow and redundant.
- **Unit tests of the CSS.** There is nothing to unit-test — the rules are declarative and the real app is the only honest instrument, per the project's standing preference for real code paths over synthetic ones.

---

### Execution Steps {#execution-steps}

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Introduce the container-wash tokens | done | `51062f31d` |
| #step-2 | Fix the background-window wash leak | done | `335b682d2` |
| #step-3 | TugListView: ring → wash, delete `ringPlacement` (converts at0255, at0277) | done | `9655121b7` |
| #step-4 | TugAccordion: ring → wash, cursor fill → bar (converts at0120) | done | `b8e0a643d` |
| #step-5 | Repoint the four conformant groups onto the shared axis | done | `c134b8b69` |
| #step-6 | The empty-container ring fallback | done — no code ([P06] withdrawn as unreachable) | — |
| #step-7 | Sweep the corpus for surviving ring assertions | done | `5b599d9b9` |
| #step-8 | Reconcile the doctrine and the gallery | done | `461f07af9` |
| #step-9 | Integration checkpoint | automated half green; by-eye walk pending (the user's) | — |

---

#### Step 1: Introduce the container-wash tokens {#step-1}

**Commit:** `tugways(focus-language): add container-wash tokens on the role axis`

**References:** [P02] New token, not a restrengthened `--tugx-focus-tint`, [P03] Accent wash / Key selection, [Q01] wash value, [Q02] within ratio, Spec S01, Table T01, (#theme-ground, #context)

**Prerequisite:** satisfied. The design spike ran 2026-08-03 and landed the values in [P10] — **6%** of the accent fill on dark, **10%** on light, with the within variant deriving at the [Q02] ratio (3% / 5%). The spike card `gallery-focus-wash.tsx` carries the same values in its own knobs, so the two can be compared directly while this step is written.

**Artifacts:**
- `--tugx-focus-container-wash` and `--tugx-focus-container-wash-within` on `body` in `tugdeck/styles/focus-ring.css`
- Two new keys injected by `buildRoleStyle`

**Tasks:**
- [ ] Add both tokens to the role-axis block on `body` in `tugdeck/styles/focus-ring.css`, next to `--tugx-focus-ring` / `--tugx-focus-tint` / `--tugx-focus-fill` / `--tugx-focus-wash`, at the [P10] dark values. They must go on `body`, not `:root` — the block's existing comment explains why (`--tug7-*` are `body`-scoped and resolve invalid at `:root`).
- [ ] Add the light-mode override as `:root[data-theme-mode="light"] body { … }` ([P10]). This is the `--tugx-drop-ring-width` precedent in the same file, but that token is geometry and sits on `:root`; these are role-axis colours and must land on `body`, so the selector needs both parts.
- [ ] Write a comment block above them stating [P01] (rings mark elements, washes mark containers), [P02] (why this is not `--tugx-focus-tint` and not `--tugx-focus-wash`), [P03] (Accent for the wash, Key for selection fill), and [P10] (the values, and that they are the *minimum* that reads in each mode — raising them starts reading as a filled surface, which is the failure this design exists to avoid).
- [ ] In `tugdeck/src/components/tugways/internal/tug-group-utils.tsx`, extend `buildRoleStyle` to inject `--tugx-focus-container-wash` and `--tugx-focus-container-wash-within` from `--tug7-surface-toggle-primary-normal-${suffix}-rest`, alongside the `--tugx-focus-ring` and `--tugx-focus-tint` keys it already injects. Use the same alphas as the global defaults so a role-bearing group and a role-less one wash at the same strength — note the existing `--tugx-focus-tint` injection uses 18% while the global default resolves to roughly 10%, an inconsistency this step should not propagate.
- [ ] Leave `--tugx-focus-tint` and all twelve of its consumers untouched.

- [ ] Take the [Q02] confirming look: open the spike card, read §3's key-view/within pair at the landed values, and either accept the 50% ratio or raise it. Do not move the key-view value to rescue the within one — [P10] is settled.

**Tests:**
- [ ] None new at this step — the tokens are not yet consumed. Correctness is the build and the audit.

**Checkpoint:**
- [ ] `cd tugdeck && bunx vite build` succeeds
- [ ] `cd tugdeck && bun run audit:theme-contrast` passes with no theme over the `brio` budget
- [ ] `grep -n "tugx-focus-container-wash" tugdeck/styles/focus-ring.css` shows both tokens declared on `body`, plus the `:root[data-theme-mode="light"] body` override
- [ ] [Q02] recorded as decided in this plan with the ratio actually used

---

#### Step 2: Fix the background-window wash leak {#step-2}

**Depends on:** #step-1

**Commit:** `tugways(focus-language): quiet container focus marks while the window is background`

**References:** [P09] Focus marks stand down when the window is not foreground, (#current-state)

This step lands **before** any component is converted, so no intermediate commit ships a visibly-leaking wash. The leak is pre-existing: the `[data-app-active="false"]` rule in `focus-ring.css` sets only `outline: none`, its comment defers the behind-tint to "its own site", and no component actually implements that — grep confirms no `data-app-active` rule exists in any of the six item-group stylesheets or in `layouts-section.css`. Today the container tint therefore keeps painting in a background window; it goes unnoticed only because the tint is nearly invisible.

**Artifacts:**
- An extended `[data-app-active="false"]` suppression covering `background-image`

**Tasks:**
- [ ] In `tugdeck/styles/focus-ring.css`, rewrite the `[data-app-active="false"]` block per Spec S02: anchor it on `html`, and suppress `background-image` alongside `outline`.
- [ ] Do **not** add per-component suppressions. The `html` anchor takes the rule to specificity (0,2,1), which beats every (0,2,0) component container rule this plan writes without duplication. Record in the rule's comment *why* it is anchored on `html` — at equal specificity the winner would be decided by Vite's CSS emission order, which nothing in the tree pins ([P09]).
- [ ] Correct the stale comment in the global block — it currently claims the behind-tint is quieted per-component, which is not true of any component.
- [ ] Confirm the assumption the `html` anchor rests on: `data-app-active` is projected onto `<html>` by the deck store's foreground tracking (`DeckManager.setHasFocus`). If it ever moves to `body`, this selector must move with it.

**Tests:**
- [ ] New app-test (or an added case on an existing focus suite): focus a Lens list, blur the window, probe `getComputedStyle(container).backgroundImage === "none"` and `outlineWidth === "0px"`; refocus and assert the wash returns. Add `@covers tugdeck/styles/focus-ring.css`.

**Unplanned finding — the focus suites could not run at all.** Establishing this step's baseline surfaced that six of the suites this plan depends on (at0116–at0121, and at0127 alongside them) fail on **clean `main`**, before any change here: they gate on `await waitForCondition("document.hasFocus()")`, and a background-mode harness window *never* satisfies it. Pid mode deliberately never activates the app — the window sits one level below normal and takes keys by `postToPid` (`MainWindow.swift`, `harnessBackgroundLevel`) — so `document.hasFocus()` is false for the whole run and the gate hangs to timeout. The suites were left behind when background mode became the default; at0295 and at0004 look like counter-examples but both declare `@foreground`.

The gate was also asking the wrong question. What every assertion below it actually depends on is `data-app-active`, because `focus-ring.css` suppresses the entire focus language while that reads false — which is precisely what this step edits. at0112 already gates that way and has been passing throughout. So the fix is a strict improvement in precision, not a workaround: `appIsActive()` was added to `tests/app-test/_harness/selectors.ts` with the rationale and the "use this, not `document.hasFocus()`" rule, and the seven suites in this plan's path were migrated onto it. All seven now pass in background mode.

Two consequences worth carrying forward. Touching `_harness/selectors.ts` trips **CORE TIER ADVISED**, so this step's verification is the core tier rather than `app-test-changed` — run and green. And the gate is corpus-wide: roughly sixty suites still read `document.hasFocus()`, most of which this plan has no reason to touch. That is a real backlog and it is recorded in [#roadmap](#roadmap) rather than swept here.

**Checkpoint:**
- [ ] `cd tugdeck && bunx vite build` succeeds
- [ ] The new blur/refocus test passes
- [ ] `just app-test` (core tier) green — required, not optional: this step edits `_harness/selectors.ts`, which no `@covers` line can scope

---

#### Step 3: TugListView — ring → wash, delete `ringPlacement` {#step-3}

**Depends on:** #step-2

**Commit:** `tugways(list-view): replace the container focus ring with a background wash`

**References:** [P01] Wash marks containers, [P04] within is the reduced wash, [P05] Delete the `ringPlacement` apparatus, [P07] Carry suppresses the bar only, Spec S02, (#inset-ring-history, #descend-behavior)

**Artifacts:**
- `tug-list-view.css` container rules replaced; ring machinery removed
- `tug-list-view.tsx` prop, type, effect, and element removed
- Two Lens call sites updated; one `lens-section-band.css` comment block removed

**Tasks:**
- [ ] In `tug-list-view.css`, replace the perimeter-ring rule (the one that computes `outline: calc(var(--tugx-list-key-ring-width) - var(--tugx-list-view-frame-width))` and recolors `border-color`) with the Spec S02 wash rule, keeping the `:is([data-key-view-kbd], [data-key-within])` selector so the mark holds through a descend ([#descend-behavior](#descend-behavior)).
- [ ] Delete the entire inset-ring section: `.tug-list-view-ring`, `.tug-list-view-ring::before`, the two `[data-ring-placement="inset"]` rules, and the `--tugx-list-view-cursor-bar-inset` declaration that offsets the bar to stack under the ring. Reset the cursor bar to its un-inset position.
- [ ] Narrow the carry block per [P07]: delete the two container rules and the inset-ring rule, keep the cursor-bar rule. Rewrite its comment to say the wash stays up *because* it draws no edge and cannot swallow the drop caret — the shape argument that justified the container half no longer applies.
- [ ] Preserve the history from [#inset-ring-history](#inset-ring-history) as a short comment where the inset ring used to be, so nobody reintroduces an overlay ring on the next edge-to-edge surface. Include the reason the overlay is not merely unnecessary but redundant: `background-attachment: scroll` (the default) already fixes the wash to the border box rather than scrolling it with the content, which is the exact property the sticky child plus `clientHeight` publisher existed to synthesize ([P05]).
- [ ] In `tug-list-view.tsx`: remove the `ringPlacement` prop and its default, the `TugListViewRingPlacement` exported type, the `RING_HEIGHT_PROPERTY` const and its `useLayoutEffect` + `ResizeObserver`, the `data-ring-placement` attribute, and the conditional `<div className="tug-list-view-ring" aria-hidden="true" />` render.
- [ ] Remove `ringPlacement="inset"` from `lens/sections/cards-section.tsx` and `lens/sections/snippets-section.tsx`.
- [ ] Remove the "Container focus on an edge-to-edge list" comment block from `lens/sections/lens-section-band.css` — it exists only to explain why the Lens lists pass `ringPlacement="inset"`.
- [ ] Repoint `snippets-section.css`'s open-editor quieting ([P07] implications): `.lens-content:has(.snippet-editor:focus-within) [data-key-within]` and the `.lens-snippets-list:has(...) .tug-list-view-ring::before` rule must become a `background-image: none` suppression on the list container. The cursor-bar suppression there is unchanged.

**Tests:** every suite this step breaks is converted **in this step**. No step in this plan commits a knowingly-red tree.
- [ ] `at0255-lens-snippet-followons.test.ts` — reads `.tug-list-view-ring`'s `::before` `borderTopWidth` and asserts `> 0`. Replace with a `backgroundImage` probe on `.lens-snippets-list`. Rewrite the block comment explaining `ringPlacement="inset"`, which now describes deleted code.
- [ ] `at0277-lens-row-accessories-keyboard.test.ts` — the same `.tug-list-view-ring` probe, inside the descend assertion. Replace with the wash probe and keep the `within` and `cursorRows` assertions unchanged: the point of that assertion is that the list does not go dark behind a descend, and it still holds under [P04] / [#descend-behavior](#descend-behavior).
- [ ] New assertion on an existing list focus suite: focused list has `outlineWidth === "0px"` and `backgroundImage !== "none"`.

**Second unplanned finding — at0255 and at0277 are red on clean `main`, for an unrelated reason.** Both suites were converted here exactly as the plan specifies (the `.tug-list-view-ring` `::before` `borderTopWidth` probe becomes a `backgroundImage` + `outlineWidth` probe on the list container, and at0277's `within` / `cursorRows` assertions are untouched because [P04] preserves that behaviour). Neither conversion can be *exercised*, because both suites now fail before reaching it — and they fail identically on an untouched base checkout:

- **at0255** — `CoordinateOutOfBoundsError: viewport coordinate (1765.0, -440.0) is outside the WKWebView's visible frame`, on the first `nativeClickAtElement` against a snippet row. A negative `y` means the row's rect sits above the viewport; the value drifts between runs (−306, −440), so it tracks band heights or scroll state rather than a fixed layout.
- **at0277** — times out waiting for `.lens-content .lens-snippets-list[data-key-view-kbd]`; the snippets list never takes the key view at all.

Both are Lens-rail geometry / reachability failures, in the same area, and neither has anything to do with the container mark: the assertions this plan changed sit well past the point of failure in both files. Diagnosing them is a real investigation into the Lens rail under the app-test harness, not a focus-language question, so it is recorded in [#roadmap](#roadmap) rather than absorbed here — absorbing it would mean this plan silently grows a second subject.

The consequence to state plainly: **at0255 and at0277 are converted but unverified by execution.** They are correct by construction — same probe target, computed style in place of a deleted element — and they will pass the moment the Lens failure is fixed. Nothing else in this plan depends on them; the list's conversion is covered by at0121 and at0127, which are green.

**Checkpoint:**
- [ ] `grep -rn "ringPlacement\|tug-list-view-ring\|TugListViewRingPlacement\|data-ring-placement" tugdeck/src` returns nothing
- [ ] `cd tugdeck && bunx vite build` succeeds
- [ ] `just app-test at0121-list-view-container-focus.test.ts at0127-list-view-cursor.test.ts` — both green (the list's real coverage)
- [ ] at0255 / at0277 converted; execution blocked on the pre-existing Lens failure above, which reproduces on clean `main`

---

#### Step 4: TugAccordion — ring → wash, cursor fill → bar {#step-4}

**Depends on:** #step-2

**Commit:** `tugways(accordion): container wash + leading-edge cursor bar`

**References:** [P01] Wash marks containers, [P08] Accordion cursor becomes a bar, Spec S02, Table T01, [L20] component-token sovereignty, (#descend-behavior, #constraints)

**Artifacts:**
- Neutral `--tugx-focus-cursor-bar-*` knobs in `focus-ring.css`, aliased from the old `--tugx-list-view-cursor-bar-*` names
- `tug-accordion.css` container and cursor rules replaced

**Tasks:**
- [ ] **First, promote the cursor-bar knobs.** Move `--tugx-list-view-cursor-bar-color` and `--tugx-list-view-cursor-bar-width` to `focus-ring.css` as `--tugx-focus-cursor-bar-color` / `--tugx-focus-cursor-bar-width`, and keep the old names as `var(--tugx-focus-cursor-bar-*, …)` aliases in `tug-list-view.css` so no consumer breaks. This is required, not optional: `tug-accordion.css` reading a `--tugx-list-view-*` token would be a direct [L20] violation ("A never overrides, aliases, or references B's tokens"), and the bar is now a language-level mark shared by two components rather than one component's furniture.
- [ ] Replace `.tug-accordion[data-key-view-kbd]`'s `outline` + `background-image: none` with the Spec S02 wash, using `:is([data-key-view-kbd], [data-key-within])` so the mark holds through a descend as it does today.
- [ ] Replace `.tug-accordion-trigger[data-key-cursor]`'s reduced tint fill with a leading-edge bar drawn as a pseudo-element on the trigger, reading the promoted knobs. Keep the existing `outline: none` suppression of the global cursor ring.
- [ ] Remove `--tugx-accordion-cursor-tint`.
- [ ] Correct the stale comment claiming the tint fill "matches the list cursor row" — under [P08] it now genuinely does, as a bar.

**Tests:**
- [ ] `at0120-accordion-focus.test.ts` — converted **in this step**, since this step is what breaks it. Its `ACC_PROBE` reads `cs.outlineWidth` and `cs.backgroundImage` and asserts `parseFloat(outline) > 0`; invert it to assert `outlineWidth === "0px"` and `backgroundImage !== "none"`. Update the probe's comment, which states the accordion "wears a ring on its own bounds (matching TugListView), not a behind-tint" — both halves of that sentence are now wrong.
- [ ] Add a cursor assertion to the same suite: the cursored trigger paints the bar, so the accordion and the list agree by construction rather than by eye.

**Checkpoint:**
- [ ] `grep -rn "tugx-list-view-cursor-bar" tugdeck/src/components/tugways/tug-accordion.css` returns nothing ([L20])
- [ ] `cd tugdeck && bunx vite build` succeeds
- [ ] `just app-test at0120-accordion-focus.test.ts` — green
- [ ] `just app-test-changed` green

---

#### Step 5: Repoint the four conformant groups onto the shared axis {#step-5}

**Depends on:** #step-1

**Commit:** `tugways(focus-language): one container-wash axis for every item-group`

**References:** [P02] New token, [P04] within is the reduced wash, Spec S01, Spec S02, Table T01

**Artifacts:**
- Four component stylesheets and one Lens stylesheet repointed

**Tasks:**
- [ ] In `tug-radio-group.css`, `tug-choice-group.css`, `tug-option-group.css`, and `tug-tab-bar.css`, change the container `[data-key-view-kbd]` rule's gradient from `--tugx-focus-tint` to `--tugx-focus-container-wash`. Leave every other `--tugx-focus-tint` use in those files alone.
- [ ] Leave `TugRadioGroup`'s `[data-key-within] { outline: none }` suppression exactly as-is — a radio group is a single Tab stop and never a descend target, and the rule exists to kill a transient engine stamp ([P04]).
- [ ] Add the reduced-wash `[data-key-within]` rule to `TugChoiceGroup`, `TugOptionGroup`, and `TugTabBar` only if the engine can stamp them; if a component never receives the mark, skip it and say so in a comment rather than adding a dead rule.
- [ ] Delete the local `--tugx-focus-tint` override in `lens/sections/layouts-section.css` — it is superseded by the global token, which now carries the value it prototyped. Record in its place a one-line comment noting the section rides the shared wash.
- [ ] Verify no leaf consumer of `--tugx-focus-tint` changed appearance: `tug-checkbox.css`, `tug-switch.css`, `tug-slider.css`, `tug-alert.css`, `tug-popover.css` are untouched by this step.

**Tests:**
- [ ] New app-test case covering all six containers in one probe: for each, focus it and assert `outlineWidth === "0px"` and `backgroundImage !== "none"`. The gallery cards (`gallery-focus-language.tsx`, `gallery-accordion.tsx`, `gallery-list-view-focus.tsx`) provide real instances of each. Add `@covers` for `focus-ring.css` and each component touched.

**Checkpoint:**
- [ ] `cd tugdeck && bunx vite build` succeeds
- [ ] `cd tugdeck && bun run audit:theme-contrast` passes
- [ ] The six-container probe test passes

---

#### Step 6: The empty-container ring fallback — NOT NEEDED {#step-6}

**Depends on:** #step-3, #step-4, #step-5

**Commit:** `N/A (no code — [P06] withdrawn)`

**References:** [P06] Empty container rings (withdrawn), Spec S02

**Outcome: no code was written, and that is the correct result.** This step opened with a reachability task, and the answer settled the step: an item-group container cannot hold the key view with no cursor item inside it, on any surface.

The finding, in short — the full argument is on [P06]:

- Lens lists gate their `focusGroup` on `navigable` (the *post-filter* row count) and publish `navigable: false` when a filter matches nothing, which takes the section out of the Tab walk and out of the Cmd-L seed. `lens-section-content.ts` documents the intended consequence in as many words: *"an empty list is not a focus stop (Tab skips it, no perimeter ring paints on emptiness)."* The plan's candidate path is not just unreached — it is deliberately foreclosed, and the opposite rule is already written down.
- The other five groups are authored with fixed item sets rather than filtered ones, and a group that has items always seeds a cursor when it takes the key view.

So the rule would have added a `:has()` to six stylesheets and a `data-empty-ring` prop to `TugListView`'s public API, none of which anything could trigger. The WCAG 1.4.11 concern that motivated it is real and is genuinely answered — one level up, by refusing the focus registration, which is the better place for it: a container that cannot take the keyboard needs no focus mark.

**Tasks:**
- [x] Establish reachability — done, and it decided the step.
- [x] Confirm the guarantee's real home and record it where the next author will look: the invariant lives in the **focus registration** (`navigable`), not in CSS, and any future surface that lets an item-group take the key view while empty must gate the same way or reinstate [P06]. Written into `focus-language.md` at [#step-8](#step-8).
- [x] No CSS, no prop, no test.

**Checkpoint:**
- [x] `grep -rn "has(\[data-key-cursor\])" tugdeck/src` returns nothing — the rule was never written
- [x] `data-empty-ring` does not appear in the tree
- [x] The reasoning is recorded on [P06] and carried into `focus-language.md`, so this is a decision with an argument rather than an omission

---

#### Step 7: Sweep the corpus for surviving ring assertions {#step-7}

**Depends on:** #step-3, #step-4, #step-5, #step-6

**Commit:** `app-test(focus-language): retire the last container-ring assertions`

**References:** [P01] Wash marks containers, [P05] Delete the `ringPlacement` apparatus, (#descend-behavior)

The three suites that assert the ring's *paint* were converted in the steps that broke them ([#step-3](#step-3): at0255, at0277; [#step-4](#step-4): at0120), so nothing here is a knowingly-deferred failure. What remains is the sweep: prose that now lies, attribute-only suites whose comments describe a ring, and any assertion elsewhere in the corpus that the earlier greps did not reach.

**Artifacts:**
- at0127 updated; any further suites the sweep turns up

**Tasks:**
- [ ] `at0127-list-view-cursor.test.ts` — its header describes the container wearing `data-key-within` as "the ring leaving the list". The attribute assertions stand and must not change; the prose does not. Correct it, and check for any paint assertion alongside.
- [ ] Sweep the whole corpus, not just the files already known: `grep -rn "outlineWidth\|tug-list-view-ring\|ring-placement\|borderTopWidth" tests/app-test/` and judge each hit. The four suites named in this plan were found by a targeted grep on ring-related tokens; a suite asserting a container outline incidentally would not have appeared in it.
- [ ] Verify `@covers` lines still resolve on every touched test — `just app-test-covers-check` fails on a missing declaration or a path that no longer resolves, and at0120 covers `tugdeck/styles/focus-ring.css` while at0277 and at0127 cover `tug-list-view.tsx`, all of which this plan edits.

**Tests:**
- [ ] Every suite the sweep touches passes.

**Sweep result.** The corpus grep (`outlineWidth`, `borderTopWidth`, `tug-list-view-ring`, `ring-placement`) turned up 20 files. Every remaining `outlineWidth` / `borderTopWidth` assertion outside the suites this plan already converted is about something else and correctly keeps its stroke: leaf rings (at0109, at0112–at0115, at0145's Allow button, at0239's button), a progress ring's border (at0274), and text-metric / divider reads (at0208, at0268). No suite asserted an item-group container outline incidentally. at0127's attribute assertions stand unchanged — only its prose said "ring", in five places, describing paint rather than the model the file actually pins.

One pre-existing failure is worth naming so it is not mistaken for fallout: **at0330 fails one assertion (`expanding and collapsing a tool block round-trips the document height`) identically on clean `main` and on this branch** — same value, 6/7 both sides. It is the live-geometry sensitivity this suite is known for. The only edit made to it here is a comment plus dropping a filter that skipped the now-deleted ring overlay, which is a no-op since the class no longer exists on any element.

**Checkpoint:**
- [x] `just app-test-covers-check` passes
- [x] `grep -rn "tug-list-view-ring\|ring-placement" tests/app-test/` returns nothing
- [x] `just app-test at0120-accordion-focus.test.ts at0127-list-view-cursor.test.ts` — both green (at0255 / at0277 remain blocked on the pre-existing Lens failure recorded in [#step-3](#step-3))

---

#### Step 8: Reconcile the doctrine and the gallery {#step-8}

**Depends on:** #step-3, #step-4, #step-5, #step-6

**Commit:** `tuglaws(focus-language): rings mark elements, washes mark containers`

**References:** [P01] Wash marks containers, [P03] Accent wash / Key selection, [P04] within is the reduced wash, [P05] Delete the `ringPlacement` apparatus, [P07] Carry suppresses the bar only, [P08] Accordion cursor bar, (#documentation-plan)

The two blessing passages must go, or the law contradicts itself and re-licenses the container ring on the next component authored.

**Artifacts:**
- `tuglaws/focus-language.md`, `tuglaws/list-view-usage.md`, `gallery-focus-language.tsx`, possibly `tuglaws/design-decisions.md`

**Tasks:**
- [ ] `focus-language.md` — "The signature: focus is a ring, selection is a fill": state the container/element split up front. The section's leaf/item-group paragraph already says an item-group "tints the container and rings the cursor item"; upgrade "tint" to "wash" and name the exception ([P06]).
- [ ] `focus-language.md` — the contract table: change the item-group container row from "faint behind-tint (role)" to the wash, and note the `data-key-within` row now resolves per container kind ([P04]).
- [ ] `focus-language.md` — "A descend goes deeper into a container, not out of it": the passage argues correctly that a descend keeps the container's full mark, but calls that mark "the container ring". Rewrite around the wash; the behaviour is unchanged and must stay stated.
- [ ] `focus-language.md` — the authoring-contract bullet "A container's ring is the container's to draw" and its `ringPlacement="inset"` example: the law ([L20], a host must not draw another component's focus marks) is unchanged and still correct, but its illustration was deleted in [#step-3](#step-3). Rewrite the bullet as "a container's focus mark is the container's to draw" and replace the example — the `layouts-section.css` local `--tugx-focus-tint` override, also deleted, is a good replacement illustration of the same failure mode from the host side.
- [ ] `focus-language.md` — "A carry suppresses the focus marks": narrow to the cursor bar per [P07], and record *why* it narrowed (a wash draws no edge and cannot swallow the drop caret), so nobody restores the container half.
- [ ] `list-view-usage.md` — update any container-ring mention; add the wash and the cursor bar to the focus-marks description.
- [ ] `gallery-focus-language.tsx` — §8 "Descendable rows — list / accordion": its `note` already describes the intended model, but the `ListRows` static replica (`.fl-list` / `.fl-list-row` in the card's own CSS) paints a ring. Bring the replica in line with the shipped treatment, and extend the note to name the wash, the accordion's bar ([P08]), and the empty-container exception ([P06]).
- [ ] Decide whether [P01] and [P03] warrant global `[D##]` entries in `design-decisions.md` — both are durable cross-component rules rather than plan-local ones. If added, cite them from `focus-language.md` by ID rather than restating.
- [ ] Follow the repo's prose convention: no hard-wrapping — one logical line per paragraph or bullet.

**Tests:**
- [ ] None — documentation.

**Checkpoint:**
- [ ] `grep -rn "container ring\|ringPlacement" tuglaws/` returns nothing that describes current behaviour
- [ ] `cd tugdeck && bunx vite build` succeeds (the gallery card is code)
- [ ] Read the Focus Language gallery card in the running debug app and confirm §8 matches what a real focused list now does

---

#### Step 9: Integration Checkpoint {#step-9}

**Depends on:** #step-6, #step-7, #step-8

**Commit:** `N/A (verification only)`

**References:** [P01] through [P09], (#success-criteria, #exit-criteria)

**The automated half is green** (run at implementation): `bunx tsc --noEmit`, `bunx vite build`, `bun run audit:theme-contrast` (no theme over the `brio` budget), `just app-test-covers-check`, and the core tier. Both success-criteria greps return nothing — the `ringPlacement` apparatus is gone, and no `:has([data-key-cursor])` / `data-empty-ring` rule was written ([P06] withdrawn).

**The by-eye half is the user's**, on the `(debug, tugdash/focus-wash)` instance. The tasks below are the walk; two of them are load-bearing design judgements rather than checks, and are called out as such.

**Tasks:**
- [ ] Walk the keyboard through every item-group in the running debug app — the three Lens list sections, the Layouts radio group, the accordion gallery card, a tab bar, a choice group, an option group — in one dark theme and one light theme, and confirm each shows a wash and no stroke, with the cursor readable inside it.
- [ ] Exercise the descend path: Enter into a Lens row's accessories and confirm the container keeps its full wash and the row keeps its bar.
- [ ] Exercise a carry: drag-reorder a snippet and confirm the wash stays up while the cursor bar stands down, and that the drop caret is unobstructed at the list's top and bottom edges.
- [ ] Blur the window and confirm every mark goes quiet, wash included.
- [ ] Filter a list to zero rows and confirm the section drops out of the keyboard walk entirely — no wash, no ring, Tab skips it. That is the `navigable` guarantee standing in for the withdrawn [P06], and it is worth seeing once on the real surface.
- [ ] ~~Take the [Q02] confirming look~~ — moot, there is no within-wash to confirm ([P04] amendment). What replaces it is the **two judgements this phase genuinely defers to the eye**, both about the one value everything rests on:
  - **Is the wash strong enough to answer "the keyboard is in here" at a glance, on both a dark and a light theme?** [P10] landed 6% / 10% as the minimum that registers, chosen on the spike card's swatches. This is the first look at those values on real containers over real grounds — the Lens's band, a card's surface, a well.
  - **Is the cursor findable inside it?** That is the whole point of the change ([R02]) — a quieter container so the caret reads. If the list's leading-edge bar still feels too subtle now that it no longer shares a knob with a retired ring, the fix is `--tugx-list-key-ring-width`, and it is a value not a shape.
  If either wants more, raise the wash alpha knowing [P10]'s warning: above these values the wash starts reading as a *filled surface*, which is the failure this design exists to avoid.

**Tests:**
- [x] `just app-test` (core tier) — **18/20 files, 37/39 tests.** `focus-ring.css` is read by nearly every surface, so the core tier is the right scope for a change at this altitude, and every focus-language suite in it is green. The two failures are activation-timing, not focus-paint, and neither can be reached by this phase's changes (CSS marks, docs, and test gates cannot move `document.activeElement` or `getHasFocus()`):
  - `at0201` — the prompt editor does not refocus within 3s after an activation click. **This suite passed 3/3 on this same tree** in an earlier core-tier run in the same session.
  - `at0014` — `getHasFocus() === true` times out after a resign / become-active cycle. A foreground-tier suite.
  **Both pass in isolation** — re-run together on the same tree, `at0201` 3/3 and `at0014` 2/2, green. The two core-tier runs differed in exactly one way: the first had 4 foreground-tier skips, the second ran the whole tier. That is the contention — an activation-dependent suite losing a race while a foreground suite is taking the screen — and it is a property of running the tier on a machine in use, not of this branch.
- [x] `just app-test-covers-check` passes (291 test files, all `@covers` resolving and within budget)

**Checkpoint:**
- [x] `cd tugdeck && bunx vite build` succeeds
- [x] `cd tugdeck && bunx tsc --noEmit` clean
- [x] `cd tugdeck && bun run audit:theme-contrast` passes — no theme over the `brio` budget
- [x] `just app-test-covers-check` passes
- [x] Every *automated* criterion in [#success-criteria](#success-criteria) verified, including both greps: the `ringPlacement` apparatus is absent, and no `:has([data-key-cursor])` / `data-empty-ring` rule was written. The two criteria that are judgements rather than checks — the wash reads, and the cursor is findable inside it — are the by-eye walk above, and one criterion is **not** met as originally written: a seventh item-group container (`.tug-alert-choices`) still rings, recorded in [#success-criteria](#success-criteria) and [#roadmap](#roadmap).

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** Every item-group container in the deck marks keyboard focus with a background wash instead of a ring, the ring and the movement caret are reserved for elements, and the machinery that existed only to paint a container ring on a resistant shape is deleted.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] All six item-group containers wash and none stroke, in dark and light (six-container app-test probe, [#step-5](#step-5))
- [ ] `ringPlacement` and its apparatus are gone from the tree (grep, [#step-3](#step-3))
- [ ] The accordion's cursor is a leading-edge bar matching the list's ([#step-4](#step-4))
- [x] ~~An empty focused container rings alongside its wash~~ — withdrawn; an empty item-group is refused the focus registration and never holds the key view ([P06], [#step-6](#step-6))
- [ ] No focus mark paints while the window is background ([#step-2](#step-2))
- [ ] `focus-language.md` no longer blesses a container ring anywhere, and the carry exception names one mark ([#step-8](#step-8))
- [ ] `bunx vite build`, `audit:theme-contrast`, `app-test-covers-check`, `app-test-changed`, and the core tier all green ([#step-9](#step-9))

**Acceptance tests:**
- [ ] Six-container wash/no-stroke probe
- [ ] Background-window suppression (blur → refocus)
- [x] ~~Empty-container ring fallback~~ — withdrawn ([P06])
- [ ] The four converted suites: at0120, at0127, at0255, at0277

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] Reconsider the cursor bar's width now that it no longer shares a knob with a container ring ([R02]) — `--tugx-list-key-ring-width` is named for the ring it outlived and could be renamed for the bar.
- [ ] Audit the `--tugx-focus-tint` strength inconsistency surfaced in [#step-1](#step-1): `buildRoleStyle` injects it at 18% of the role token while the global default resolves near 10%, so a role-bearing leaf tints noticeably stronger than a role-less one. Out of scope here because it concerns leaves, not containers.
- [ ] Consider whether floating surfaces (`TugPopover`, `TugSheet`, `TugAlert`) want a wash *in addition to* their boundary ring, now that the wash is a legible mark. Explicitly a separate question — see [#non-goals](#non-goals).
- [ ] **Convert `.tug-alert-choices` — the seventh item-group container.** It still draws a flush perimeter ring on `data-key-view-kbd` (`tug-alert.css`), copied from `TugListView`'s retired treatment, while its rows already mark the cursor with a leading-edge bar. Structurally it is the same archetype as the list and the accordion, so under [D122] it should wash. Left alone here only because this plan's scope names six components and its non-goals name `tug-alert.css` — but the non-goal's reason (a floating surface's own *boundary* ring) does not describe this mark, which is a container ring on a list *inside* the alert. Small change; the reason it is a follow-on is scope discipline, not difficulty. The `TugAlert` boundary ring itself stays either way.
- [ ] **Fix at0255 / at0277 — the Lens rail is unreachable under the app-test harness.** Both fail on clean `main` before any assertion: at0255 clicks a snippet row at a negative viewport `y` (the row's rect sits above the visible frame, and the offset drifts run to run), at0277 never sees the snippets list take `data-key-view-kbd` at all. Same area, likely one cause — the Lens rail's geometry or its focus reachability inside a harness window. Worth pinning down because these two are the only coverage of Lens row accessories and snippet follow-ons, so the rail is currently untested. See the note in [#step-3](#step-3).
- [ ] **Migrate the rest of the corpus off `document.hasFocus()`.** Roughly sixty suites still gate on it, and every one of them can only pass in the foreground tier — which is the tier the background-mode work exists to keep nearly empty. [#step-2](#step-2) migrated the seven in this plan's path onto `appIsActive()` and left the rule written down at the helper. The remainder is a mechanical sweep, but it is not this plan's: each suite needs a judgement about whether it gates on app-activation because it asserts *paint* (→ `appIsActive()`), because it needs the keyboard in a card (→ `keyboardIsInCard()`), or because its subject genuinely is activation (→ keep `document.hasFocus()` and declare `@foreground`). Worth doing as its own pass, since the payoff is a corpus that runs without taking the screen.

| Checkpoint | Verification |
|------------|--------------|
| Wash tokens declared and role-injected | `grep -n "tugx-focus-container-wash" tugdeck/styles/focus-ring.css tugdeck/src/components/tugways/internal/tug-group-utils.tsx` |
| No container strokes | six-container app-test probe |
| Ring apparatus deleted | `grep -rn "ringPlacement\|tug-list-view-ring\|TugListViewRingPlacement" tugdeck/src` returns nothing |
| Background window quiet | blur/refocus app-test |
| Doctrine reconciled | `grep -rn "container ring\|ringPlacement" tuglaws/` returns nothing describing current behaviour |
| Six themes safe | `cd tugdeck && bun run audit:theme-contrast` |
| Build honest | `cd tugdeck && bunx vite build` |
