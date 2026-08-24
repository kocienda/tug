## Lens space allocation — the rail divides its height by priority, not by size {#lens-space-allocation}

**Purpose:** Make the Lens stack use every pixel of the rail before anything scrolls, and — when the rail genuinely runs out — spend the shortfall on the lowest-priority band first, so Cards keeps its height and Layouts gives it up. Pure CSS, no allocator, no measurement.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-08-03 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

The Lens stack (`.lens-sections` in `tugdeck/src/components/lens/lens-content.css`) is a column flex container holding one `.lens-section` per registered section. Every section is `flex: 0 1 auto` (`tugdeck/src/components/lens/lens-section-band.css`), so with room to spare each takes the height its content needs and the leftover sits as quiet background below the last band. Nothing scrolls. **That half is already right and this plan does not touch it.**

Under pressure, flexbox distributes the deficit in proportion to each item's flex base size — that is the default, and the default is wrong here. Measured against the real app, thirty open cards in a 1181px rail:

**Table T01: What the rail does today** {#t01-today}

| Section | wants | gets | gives |
|---|---|---|---|
| **Cards** | 948 | 596 | **352** |
| **Snippets** | 354 | 222 | **132** |
| **Layouts** | 362 | 362 | **0** |

The deficit is 483px and it lands 2.67 : 1 : 0 — exactly the ratio of the three content heights. Two things are wrong, and they compound:

- **The priority order is inverted.** Cards is the section the rail exists for, and being the tallest is precisely what makes it the biggest giver.
- **Layouts cannot give at all.** It holds no scroller, so its automatic minimum size is its full height and flex freezes it on the first pass. It is not privileged by intent; it is unshrinkable by construction, which amounts to the same thing. The lowest-priority band is the only one guaranteed to keep every pixel it asked for.

#### Strategy {#strategy}

- **No JavaScript allocator.** Flexbox's *resolve flexible lengths* step is already a priority waterfall: it shrinks in proportion to `basis × shrink-factor`, freezes any item that reaches its minimum, and redistributes the remaining deficit among the items still free. Widely separated shrink factors plus a per-section floor make the engine perform the waterfall itself. See [P01].
- **Priority is a fixed property of the section, not of its position.** Cards first, Snippets next, Layouts last, wherever they have been dragged. See [P02].
- **Give Layouts a scroller.** Until it can give, the shrink factors say nothing — an unshrinkable item outranks every ratio. This is the actual repair for the measured defect in [Table T01](#t01-today).
- **Floor every band at its header plus four one-line rows,** so a squeezed band still reads as a list you can scroll rather than as a closed bar. See [P03].
- **Spike the floor formulation before authoring it.** A naive `min-block-size` floor *inflates* short sections as well as flooring tall ones, which would make an empty Snippets band 112px taller than its content. This is the one genuinely unknown mechanism in the plan and [#step-2](#step-2) measures it in the real app rather than assuming it. See [Q01].
- **Gate the outcome with one app-test** that asserts the invariant and the priority order against real geometry, in the shape of the probe that produced [Table T01](#t01-today).

#### Success Criteria (Measurable) {#success-criteria}

- **Slack implies no scrolling.** With the rail taller than the stack's content, `.lens-sections` client height minus the summed section heights is > 0 **and** no `.tug-list-view` in the Lens has `scrollHeight > clientHeight`. Verified by `at0338`, assertion 1.
- **Layouts can give.** Under the [Table T01](#t01-today) pressure scenario, the Layouts section's measured height is strictly less than its content height. Verified by `at0338`, assertion 2. Today it is exactly equal, which is the defect.
- **Priority order holds under pressure.** Under enough pressure to exhaust the rail, Layouts sits at its floor, Snippets sits at its floor, and Cards holds everything left over — so `cardsHeight > snippetsHeight` and `cardsHeight > layoutsHeight`, and both of the latter equal the floor. Verified by `at0338`, assertion 3. See [the arithmetic](#waterfall-arithmetic) for why the correct claim is "Cards gives last", not "Cards gives nothing".
- **No band is inflated.** An empty or short section's measured height equals its content height — introducing the floor must not make a one-row Snippets band as tall as a four-row one. Verified by `at0338`, assertion 4, and by `at0297` continuing to pass.
- **The floors fit the rail.** The summed floors of all rendered sections are less than `.lens-sections` client height, so no band is clipped by an unsatisfiable minimum. Verified by `at0338`, assertion 5. See [P05].
- **Nothing new enters React.** `git diff --stat` for this change touches CSS and tests only; no `.tsx` file gains state. See [the state zone mapping](#state-zone-mapping).

#### Scope {#scope}

1. Separate `flex-shrink` factors per section kind, keyed off the `data-lens-section` attribute already stamped by `lens-section-band.tsx`.
2. A per-section floor (`--tugx-lens-section-floor`) that binds under pressure without inflating short sections.
3. A scroller on the Layouts section body, so a section with no `TugListView` can still give.
4. Restating the existing snippet-editor rule in the new vocabulary so there is one mechanism rather than two.
5. One app-test (`at0338`) gating the invariant, the priority order, the absence of inflation, and the floor ceiling from [P05].

#### Non-goals (Explicitly out of scope) {#non-goals}

- **Changing the top-anchored, content-sized behavior when there is slack.** Sections still grow downward into free space and slack still sits as quiet background below the last band. Nothing is stretched to fill the rail.
- **Making the stack itself scroll.** `.lens-sections` stays `overflow: hidden`; each section's body scrolls.
- **Any per-section user-adjustable sizing** (drag-to-resize a band, remembered band heights). Not asked for.
- **Re-litigating the extent-floor defect.** See [the warning below](#not-the-floor).
- **Priority as a registry field.** [P02] fixes the order by section kind in CSS; a declared `spacePriority` on `LensSectionDefinition` is a follow-on for the Lens redesign v2, not this change.

#### Dependencies / Prerequisites {#dependencies}

- `data-lens-section={def.kind}` is already stamped on the band root by `tugdeck/src/components/lens/lens-section-band.tsx`. No new hook is needed.
- `--tugx-lens-empty-block-size: 28px` already exists in `tugdeck/src/components/lens/lens-content.css` and is documented there as "the height of one one-line row". It is pinned against a real row by `tests/app-test/at0297-lens-empty-label-row-height.test.ts`. The floor is authored in multiples of it, so the floor cannot drift away from the row height it is stated in.
- `tests/app-test/at0337-extent-floor-phantom.test.ts` is green. Its `EXTENT` probe is the shape `at0338`'s geometry probe is written from.

#### Constraints {#constraints}

- **[L06] — appearance and geometry go through CSS and DOM, never React state.** This change is CSS-only by construction; a `ResizeObserver`-driven allocator would violate it.
- **No rAF, no duration-matched timers.** Background windows run no rAF and throttle DOM timers to 1s, so any JS allocator would be wrong in a background window. CSS is correct there and during a live window resize.
- **Estimated cell heights are banned.** The floor in [P03] is a *design minimum for a band* — the smallest a band may be squeezed to — not an estimate of how tall any content is. Nothing in this plan measures or guesses content height.
- **Verify from `tugdeck/`:** `bunx tsc --noEmit` and `bunx vite build`. Use bun, never npm.
- **App-tests are selective.** `just app-test-changed` derives the run from the diff via `@covers`; do not run the full corpus.

#### Assumptions {#assumptions}

- The three section kinds registered today are `cards`, `snippets`, and `layouts` (`SECTION_KIND` in each `sections/*-section.tsx`). A fourth section registered later falls into the default tier — see [P02].
- A collapsed section renders its band and no body (`lens-content.tsx` passes `collapsed`; `lens-section-band.tsx` renders no body when true), so it has nothing to give and its shrink factor is immaterial.
- The band header is `flex-shrink: 0` (`lens-section-band.css`) and stays that way, so a section's floor must include the band's own height.

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

This plan follows `tuglaws/devise-skeleton.md`: explicit `{#anchor}` headings, plan-local decisions labelled `[P01]`…, open questions `[Q01]`…, and `**References:**` lines citing anchors rather than line numbers.

---

### Not to be confused with the extent-floor defect {#not-the-floor}

A scrollbar on a Lens list that plainly fits, with slack below the last band, was a **different bug** — phantom scroll extent left by `.tug-list-view-floor`, fixed in `638175970` and gated by `tests/app-test/at0337-extent-floor-phantom.test.ts`. It presented as a space-allocation failure and is not one: the section was correctly sized throughout, which is exactly why flexbox never saw a problem.

Anything encountered during this work that reads as "the rail is scrolling when it shouldn't" **must be checked against at0337 first.** Run `just app-test at0337-extent-floor-phantom.test.ts` before concluding that a space-allocation rule is at fault. The distinguishing symptom: an extent-floor phantom leaves the *section* correctly sized and only the *scroller* wrong; a space-allocation failure gets the section's height wrong and the scroller is then correct about it.

Background, if needed: `dash/scroll-height-floor.md`.

---

### The invariant {#invariant}

> **No Lens list is scrollable while the stack has slack.** Scrolling begins at the pixel the stack runs out, and not before.

Stated on **scroll extent**, not on content height — that distinction is the whole lesson of [the floor defect](#not-the-floor), where content-based accounting said everything was fine while the scroller said otherwise.

This is already true today and the change must keep it true. It is directly assertable: measure `.lens-sections` client height minus the sum of the section heights; if that is greater than zero, no `.tug-list-view` in the Lens may have `scrollHeight > clientHeight`.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] How is a floor expressed so it binds under pressure without inflating short sections? (OPEN — resolved by #step-2) {#q01-floor-formulation}

**Question:** `min-block-size: 112px` on a section is a *lower bound on the used size*, not a limit on shrinking. It correctly stops a tall Snippets band from being squeezed below four rows — and it also forces an **empty** Snippets band, whose content is one 28px "None" label, up to 112px. That is a visible regression: the rail would show a tall empty band where today it shows a one-row one. What CSS formulation gives `min(content, floor)` semantics?

The answer must cover **both** floors in [Spec S01](#s01-allocation-rules) — `<section-floor>` (band header + `--tugx-lens-section-floor`) and the body's, which is the token alone. Candidate B is the only one that derives the header's contribution rather than hardcoding a band height, which is why it is worth measuring even though A is one declaration.

**Why it matters:** Every other part of this plan is settled and mechanical. This is the one place a wrong guess ships a regression that `at0297` (empty label stands at one row's height) may or may not catch, depending on which element it measures. Getting it wrong also risks a second, quieter failure: if the section's floor does not account for the band header — which is `flex-shrink: 0` — the body overflows the section box and adjacent bands overlap.

**Options (all to be measured in the real app, not reasoned about):**

- **A — `fit-content(<length>)`.** `min-block-size: fit-content(112px)` is defined as `min(max-content, max(min-content, 112px))`, which is exactly the wanted semantics in one declaration. Support in WebKit for `fit-content()` on `min-height` (as opposed to in grid track sizing) is the open part.
- **B — `min-content` on the section, explicit floor on the body.** `.lens-section { min-block-size: min-content }` plus `.lens-section > .lens-section-body { min-block-size: <floor> }`. This derives the band header's contribution from the header itself rather than hardcoding a band height. It is subject to the same inflation problem at the body level, so it only works combined with A or C at the body.
  Note the existing `.lens-section:has(.tug-list-view) { min-block-size: 0 }` rule and its comment, which reports that the section's **automatic** minimum size picks up the list's full intrinsic height. That is a statement about `auto` (the flexbox automatic minimum size), not about the `min-content` keyword; a scroll container's `min-content` block size is zero. The two are easy to conflate and the spike must distinguish them by measurement.
- **C — Gate the floor on content presence.** Apply the floor only where inflation cannot happen: unconditionally on Layouts (whose content is a fixed 362px picker, always far above the floor) and, for the list sections, gated on `:has(.tug-list-view-cell:nth-child(4))` — a band with fewer than four rows has nothing to floor. Requires confirming that `.tug-list-view-cell` elements are siblings under `.tug-list-view-window`.

**Plan to resolve:** [#step-2](#step-2) is a measurement spike in the running app, using the same in-app geometry probe as `at0338`. It answers three questions with numbers: does `fit-content()` on `min-height` behave per spec in this WebKit; does `min-block-size: min-content` on `.lens-section` resolve to band-header + body-floor; are `.tug-list-view-cell` elements direct siblings.

It runs **after** the Layouts scroller lands, because [#step-1](#step-1)'s checkpoint already measures the neighbouring mechanism — whether a scroll-container body flattens its section's automatic minimum size — which is Candidate B's premise. Running the spike second means one of its three questions is answered before it starts.

**Resolution:** OPEN — decided in [#step-2](#step-2), recorded there as the chosen option with its measurements.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Floor inflates short bands ([Q01]) | high | med | The [#step-2](#step-2) spike decides the formulation by measurement; `at0338` assertion 4 gates it | An empty band measures taller than its content |
| Layouts' new scroller clips a focus ring | med | low | `TugRadioGroup` draws its ring inside its own box; verify visually and via `at0231` | A focused layout tile shows a clipped ring |
| Tiny shrink factors hit a WebKit precision floor | med | low | Plain decimals rather than e-notation; `at0338` asserts the resulting order, not the factors | Cards gives before Snippets reaches its floor |
| Snippet-editor rule and the new factors fight | med | med | The editor rule is restated in the same vocabulary and wins on specificity; the editor's own tests re-run | A long paste squeezes Cards instead of the editor |
| Summed floors exceed the rail, clipping the last band ([P05]) | high | low | `at0338` assertion 5 measures the sum against the rail | A fourth Lens section is registered |
| `at0338` reads a rail that is not under pressure | med | high | The fixture *derives* pressure by seeding until slack reaches 0, never by a fixed card count | The test window's height changes |

**Risk R01: The floor formulation inflates short bands** {#r01-floor-inflation}

- **Risk:** `min-block-size` is a lower bound on used size, so a floor authored naively makes an empty band as tall as a four-row one.
- **Mitigation:**
  - [Q01] is resolved by measurement in [#step-2](#step-2) before any floor ships.
  - `at0338` assertion 4 measures a short band against its own content height.
  - `at0297` already pins the empty label at one row's height and is in the `@covers` fan-out for `lens-content.css`.
- **Residual risk:** A band that is short but not empty (two rows, say) is between the two gated cases; assertion 4 uses a one-row band, so a two-row band's behavior is inferred from the same rule rather than separately measured.

**Risk R03: The floors sum above the rail and the last band is clipped** {#r03-floor-ceiling}

- **Risk:** Minimums that cannot all be satisfied make a flex container overflow; `.lens-sections` is `overflow: hidden`, so the tail band is clipped away — header included — with no visible explanation.
- **Mitigation:**
  - [P05] states the ceiling and `at0338` assertion 5 gates it.
  - The margin today is roughly 456px of floor against a 1181px rail.
- **Residual risk:** The gate measures the rail at whatever height the app-test window happens to be. A user on a much shorter display than the test window could cross the ceiling without the test noticing — the assertion catches *section count* growth, not window shrinkage.

**Risk R02: Layouts' scroller changes its focus behavior** {#r02-layouts-scroller}

- **Risk:** `overflow-y: auto` on the Layouts body creates a scroll container around two `TugRadioGroup`s, which can change what `scrollIntoView` does when the keyboard cursor lands on a tile below the fold, and can clip a ring drawn outside a tile's box.
- **Mitigation:**
  - Verify the Cmd-L walk reaches every layout tile with the rail under pressure.
  - Re-run `at0231-lens-toggle-focus.test.ts`, which is in the core tier.
- **Residual risk:** A sticky-header-style reveal bug of the kind documented for the transcript is possible here in principle; Layouts has no sticky header, so there is nothing for a reveal to strand content under.

---

### Design Decisions {#design-decisions}

#### [P01] The waterfall is flexbox's own, driven by separated shrink factors (DECIDED) {#p01-flexbox-waterfall}

**Decision:** Priority is expressed as three widely separated `flex-shrink` factors plus a floor per section. No JavaScript participates in Lens sizing.

**Rationale:**
- The CSS Flexible Box *resolve flexible lengths* algorithm already is the waterfall: it distributes the deficit in proportion to `basis × shrink-factor`, freezes any item that reaches its minimum, and redistributes what remains among the items still unfrozen. Giving Cards a shrink factor eight orders of magnitude below Layouts' makes its arithmetic share of any deficit sub-pixel until both its juniors have frozen at their floors.
- It is correct in the cases a JS allocator is worst at: mid-drag window resize (no frame to hook), background windows (no rAF, DOM timers throttled to 1s), and first paint (nothing has measured anything yet).
- It is [L06] as written rather than as worked around — appearance and geometry expressed in CSS, driven by nothing.
- It introduces no re-entrancy: no observer writes a style that changes a measurement that fires the observer.

**Implications:**
- The factors are authored as plain decimals (`1`, `0.0001`, `0.00000001`) rather than e-notation. CSS `<number>` does permit `1e-8`, but a value this load-bearing should not depend on a parser detail that is easy to leave untested; the decimal form is unambiguous everywhere.
- Cards' factor must be **nonzero**. `flex-shrink: 0` would make Cards refuse to give even when Snippets and Layouts are both at their floors, and the stack would overflow the rail. The tiny nonzero factor is what makes Cards the *last* giver rather than a non-giver.
- Because shrinking never fully stops, the correct claim under pressure is "Cards gives last", not "Cards gives nothing". See [the arithmetic](#waterfall-arithmetic).

#### [P02] Priority is fixed per section kind: Cards, Snippets, then everything else (DECIDED) {#p02-fixed-priority}

**Decision:** Cards has the highest priority, Snippets next, Layouts and any future section share the lowest tier. The ranking is a property of the section kind and does not change when the user drags a band to a different position in the stack.

**Rationale:**
- This is what was asked for, stated plainly: Cards first, Snippets next, Layouts last.
- Cards is the section the rail exists for. That is true whether or not the user has dragged it to the bottom to get at something else for a moment; a band's *position* is a reading-order preference, and spending Cards' height because of it would punish a gesture that meant something else.
- It requires no code at all: `data-lens-section={def.kind}` is already on the band root, so the whole ranking is three CSS selectors.
- The alternative — priority from stack order — was considered and rejected. It would make drag-reorder double as a priority control, which is a second meaning for one gesture.

**Implications:**
- Resolves what the brief tracked as "whether the rest is one tier or ranked": **one tier.** A section registered later with no rule of its own inherits `flex-shrink: 1` and gives first, alongside Layouts. That is the right default for a new section — it earns priority by being named, not by existing.
- When the Lens redesign v2 adds sections, promoting one is a one-line CSS addition. If that becomes frequent, the follow-on is a declared `spacePriority` field on `LensSectionDefinition` stamped as a data attribute; that is explicitly out of scope here.

#### [P03] A squeezed band floors at its header plus four one-line rows (DECIDED) {#p03-four-row-floor}

**Decision:** No band may be squeezed below its band header plus four one-line rows. Authored once as `--tugx-lens-section-floor`, in multiples of the existing `--tugx-lens-empty-block-size`.

**Rationale:**
- A squeezed band has to still read as a list you can scroll. Squeezed to its header alone it is visually indistinguishable from a **collapsed** band, which is a different state with a different control (the fold chevron) — and a rail that renders two different states identically is lying about one of them.
- Four rows is enough to see that scrolling the band is worth doing, and enough that the band's scrollbar has somewhere to travel.
- Expressed in multiples of `--tugx-lens-empty-block-size` — the token already documented as "the height of one one-line row" and already pinned against a real row by `at0297` — so the floor cannot drift away from the row height it is stated in.

**Implications:**
- `--tugx-lens-section-floor: calc(4 * var(--tugx-lens-empty-block-size))` = 112px of body, plus the band header, which the formulation from [Q01] must account for.
- This is a **design minimum for a band**, not an estimate of content height. It states how small a band may be squeezed, and answers no question about how tall anything is. The ban on estimated cell heights is untouched.
- Cards' rows are the three-line session monitor rows (73px), not one-line rows. The floor is deliberately stated in one-line-row units for every band regardless: it is a floor on the *band*, not a count of that band's rows.

#### [P04] The snippet-editor rule is restated in the new vocabulary, not left beside it (DECIDED) {#p04-editor-rule-folds-in}

**Decision:** `.lens-sections:has(.snippet-editor)` keeps its current *effect* — the editing section is the sole giver — but is authored as an override of the shrink factors introduced here, not as a second, independent mechanism.

**Rationale:**
- The rule today sets every section to `flex-shrink: 0` and the editing section to `1`. Under [P01] that is the same statement in the new vocabulary: while an editor is open, the editing section takes the largest shrink factor and its siblings take none.
- Two mechanisms writing `flex-shrink` on the same elements from different premises is how a rule survives a refactor by accident and then breaks quietly. Restating it makes the relationship explicit and makes its precedence deliberate.

**Implications:**
- `.lens-sections:has(.snippet-editor) > .lens-section` (three compound selectors) already outranks `.lens-section[data-lens-section="cards"]` (two) on specificity, so it wins regardless of source order. The rules are nonetheless authored *after* the priority rules so a reader meets the general case first.
- The floors from [P03] still apply while an editor is open. Setting a sibling's `flex-shrink: 0` means it does not give; it never meant it may be squeezed below its floor.

#### [P05] The summed floors must fit the rail, and a test says so (DECIDED) {#p05-floor-ceiling}

**Decision:** The floors are unconditional, so the Lens must keep `sections × floor` below the shortest rail it supports. `at0338` asserts it directly, turning a silent clipping failure into a red test.

**Rationale:**
- Flexbox does not negotiate a minimum away. When the items' minimums sum above the container, it overflows the container rather than violating a `min-block-size` — and `.lens-sections` is `overflow: hidden`, so the overflow is *clipped*, not scrolled. The last band would go off the bottom of the rail taking its header with it, and nothing on screen would say why.
- There is no conditional form of this in CSS. A floor cannot ask whether it is affordable.
- The margin today is wide — three bands at roughly 152px is 456px against a 1181px rail — so this is not a live bug. It becomes one the moment the Lens redesign v2 adds sections, which is precisely when nobody will be thinking about floors.

**Implications:**
- `at0338` gains a fifth assertion: the summed floors of all rendered sections are less than `.lens-sections` client height. It is cheap, and it fails on the change that would otherwise ship the clipping.
- If a future Lens does exceed the ceiling, the answer is a per-section floor override or a smaller shared floor ([P03] is a design minimum, not a law of nature) — not making `.lens-sections` scroll, which [#non-goals](#non-goals) rules out.

---

### Deep Dives {#deep-dives}

#### What the waterfall actually produces {#waterfall-arithmetic}

Worked against the measured [Table T01](#t01-today) numbers so the app-test asserts something true rather than something aspirational. Rail 1181px, content 1664px, deficit **483px**. Call the band header height *H* and the floor *F* = *H* + 112.

Flex distributes in proportion to `basis × shrink`:

| Section | basis | shrink | basis × shrink |
|---|---|---|---|
| Cards | 948 | 0.00000001 | 0.0000095 |
| Snippets | 354 | 0.0001 | 0.0354 |
| Layouts | 362 | 1 | 362 |

**Pass 1.** Layouts' share is 362 / 362.035 ≈ 99.99% of the deficit — it is asked for essentially the whole 483px, hits its floor *F*, and freezes having given 362 − *F*.

**Pass 2.** The remaining deficit redistributes between Snippets and Cards, where Snippets' weight is ~3700× Cards'. Snippets absorbs essentially all of it, hits *F*, and freezes having given 354 − *F*.

**Pass 3.** Whatever is still owed lands on Cards, which is now the only unfrozen item.

With *H* ≈ 40, *F* ≈ 152: Layouts gives 210, Snippets gives 202, Cards gives the remaining **71**. Compare today's split: Cards 352, Snippets 132, Layouts 0.

Two things follow, and both matter for how `at0338` is written:

- **Cards still gives, at this deficit.** 483px is more than Layouts and Snippets have between them, so the shortfall genuinely reaches Cards. The gating claim is therefore *ordering* — Layouts at its floor, Snippets at its floor, Cards holding the remainder — and **not** "Cards holds its full content height", which would be false here. The brief this plan replaces stated it the second way; that was wrong.
- **The stack exactly fills the rail.** Slack is 0 under pressure and > 0 otherwise; there is no third state. That is what makes [the invariant](#invariant) assertable as a single subtraction.

#### Where the sizing rules live today {#current-rules}

An implementer will find `min-block-size` written at four levels, all gated on `:has(.tug-list-view)` and all set to `0`. They are not redundant — each flattens a different box on the path from the section root to the scroller — and only the outer two are touched by this plan:

| Element | File | Today | This plan |
|---|---|---|---|
| `.lens-section` | `lens-section-band.css` | `0` when it has a list | floor per [Q01] resolution |
| `.lens-section > .lens-section-body` | `lens-section-band.css` | `0` when it has a list | floor per [Q01] resolution |
| `.lens-cards-section` | `sections/cards-section.css` | `0` when it has a list | unchanged |
| `.snippets-section` | `sections/snippets-section.css` | `0` when it has a list | unchanged |

The inner two sit *inside* a box that now carries a floor, so they can stay at `0`: a floor on the outer box already stops the whole subtree from being squeezed further.

The `:has(.tug-list-view)` gate exists because a section's **automatic** minimum size otherwise picks up the list's full intrinsic height. Note that Layouts holds no `TugListView`, so none of these four rules match it — which is precisely why it cannot give, and why [#step-2](#step-2) has to reach it by a different selector.

#### Why the caret rules out positional CSS {#caret-and-nth-child}

Recorded because it is the first thing an implementer will reach for. `BlockDropCaret` is rendered as the **first child** of `.lens-sections` (`lens-content.tsx`), and it is a `<div>` — so both `:nth-child()` and `:nth-of-type()` count it, and `:nth-child(1)` is the caret rather than the first section. Any positional selector here is off by one and would break silently if the caret ever moved. [P02] sidesteps this entirely by keying off `data-lens-section`.

---

### Specification {#specification}

**Spec S01: The allocation rules** {#s01-allocation-rules}

Authored in `tugdeck/src/components/lens/lens-section-band.css`. `<section-floor>` is a placeholder decided by [#step-2](#step-2) — it is the band header plus `--tugx-lens-section-floor`, and how that sum is expressed is exactly what [Q01] resolves.

```css
/* Priority: Cards holds its height longest, then Snippets; everything else
   gives first. Fixed per section kind — see [P02]. The default tier is the
   `flex: 0 1 auto` shorthand already on `.lens-section`, which sets shrink to
   1; only the two named tiers are written here. */
.lens-section[data-lens-section="snippets"] { flex-shrink: 0.0001; }
.lens-section[data-lens-section="cards"]    { flex-shrink: 0.00000001; }

/* No band is squeezed below its header plus four one-line rows — see [P03].
   TWO DIFFERENT EXPRESSIONS: the section's floor includes the band header
   (which is `flex-shrink: 0` and therefore always present), the body's does
   not. Writing one expression in both places is the mistake to avoid — it
   either leaves the section a header too short, so the body overflows and
   adjacent bands overlap, or leaves the body a header too tall, making the
   real floor 152px of content rather than the 112px [P03] specifies. */
.lens-section                      { min-block-size: <section-floor>; }
.lens-section > .lens-section-body { min-block-size: var(--tugx-lens-section-floor); }

/* A section with no TugListView of its own still has to be able to give:
   its body is the scroller. Scoped to :not() so the list sections keep the
   list as their single scroller and gain no nested second one. */
.lens-section:not(:has(.tug-list-view)) > .lens-section-body {
  overflow-y: auto;
}

/* While a snippet editor is open the editing section is the sole giver —
   the same statement in this vocabulary, per [P04]. Floors still apply. */
.lens-sections:has(.snippet-editor) > .lens-section { flex-shrink: 0; }
.lens-sections:has(.snippet-editor) > .lens-section:has(.snippet-editor) {
  flex-shrink: 1;
}
```

**Spec S02: The floor token** {#s02-floor-token}

Authored in `tugdeck/src/components/lens/lens-content.css`, beside `--tugx-lens-empty-block-size`, which it is stated in terms of:

```css
/* The smallest a band may be SQUEEZED to — its header plus four one-line
   rows — so a squeezed band still reads as a list you can scroll rather than
   as a closed bar (which is what a COLLAPSED band looks like, and that is a
   different state). A design minimum for a band, not an estimate of any
   content's height. TUNE HERE. */
--tugx-lens-section-floor: calc(4 * var(--tugx-lens-empty-block-size));
```

The token names the **body** floor and is used directly as the body's `min-block-size`. The band header's own height is added on top of it by `<section-floor>` in [Spec S01](#s01-allocation-rules) — never by this token, so the number here stays readable as "four rows".

#### State Zone Mapping {#state-zone-mapping}

| State | Zone | Mechanism | Law |
|-------|------|-----------|-----|
| Section priority ranking | appearance / geometry | CSS selector on the existing `data-lens-section` attribute | [L06] |
| Per-section floor | appearance / geometry | CSS custom property + `min-block-size` | [L06] |
| Layouts body scrollability | appearance / geometry | CSS `overflow-y` | [L06] |
| Section render order | (unchanged) | `lensStore.sectionOrder` → `useSyncExternalStore` | [L02] |

**No new state.** Every row above is CSS. This is the plan's strongest conformance claim and the easiest to check: the diff contains no `.tsx` change.

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **App-test (geometry)** | Measure real laid-out boxes in the real app | The whole of this change — it is geometry, and geometry is only true when the engine says so |
| **Regression (existing)** | `at0297`, `at0231`, `at0266`, `at0337` keep passing | Empty-label height, Lens focus, filtering, extent floor |

Everything here is measured in the running app through `app.evalJS`, against a real seeded deck. There is nothing to unit-test: the change is four CSS rules and a token, and the only interesting question about them is what the layout engine does with them.

#### What stays out of tests {#test-non-goals}

- **The shrink factors themselves.** Asserting `getComputedStyle(...).flexShrink === "0.0001"` restates the stylesheet. The test asserts the *resulting heights*, which is the thing anyone cares about and the thing that breaks.
- **Fake-DOM / jsdom layout.** jsdom does not implement flexbox; a render test here would assert nothing at all. Banned pattern regardless.
- **Sub-pixel exactness.** Heights are compared with a tolerance of 1px, since flex distribution and device-pixel rounding both land fractions.
- **The snippet-editor interaction under pressure.** Covered by re-running the existing editor tests rather than by a new pressure scenario; a new one would be a second copy of [P04]'s claim.

---

### Execution Steps {#execution-steps}

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Layouts becomes able to give | pending | — |
| #step-2 | Spike the floor formulation in the real app | pending | — |
| #step-3 | Priority shrink factors and the floor | pending | — |
| #step-4 | at0338 gates the invariant and the order | pending | — |
| #step-5 | Integration checkpoint | pending | — |

The scroller comes **before** the spike deliberately. It depends on no floor decision, it is the direct repair for the one measured defect in [Table T01](#t01-today), and its checkpoint measures the mechanism Candidate B rests on — so the spike starts with one of its three questions already answered.

---

#### Step 1: Layouts becomes able to give {#step-1}

**Commit:** `tugways(lens-space-allocation): give a listless band a scroller so it can shrink`

**References:** [P01] flexbox waterfall, Spec S01, Table T01, (#current-rules, #r02-layouts-scroller, #q01-floor-formulation)

**Artifacts:**
- `tugdeck/src/components/lens/lens-section-band.css` — the `:not(:has(.tug-list-view))` body scroller rule.
- The geometry probe, authored here and reused by [#step-2](#step-2) and [#step-4](#step-4).

**Tasks:**
- [ ] Run the app. tugdeck HMR is live, so CSS edits land without a build.
- [ ] Author the geometry probe. Per section it reports: `data-lens-section`, the section's `getBoundingClientRect().height`, its body's height, its list's `scrollHeight` vs `clientHeight`; plus the stack's slack (`.lens-sections` client height minus the summed section heights). Everything downstream reads this one shape.
- [ ] Add the scroller rule from [Spec S01](#s01-allocation-rules) to `lens-section-band.css`, next to the existing `:has(.tug-list-view)` rules so the two halves of one idea are read together.
- [ ] Write the comment as the reason, not the history: a section with no list of its own still has to be able to give, so its body is the scroller; scoped with `:not()` so the list sections keep the list as their single scroller and gain no nested second one.
- [ ] Measure and record, for [Q01]'s benefit, whether making the body a scroll container flattened the section's **automatic** minimum size — that is Candidate B's premise, and this step is where it is first observable.

**Tests:**
- [ ] `just app-test at0231-lens-toggle-focus.test.ts` — the Lens focus walk still reaches the Layouts picker ([R02]).

**Checkpoint:**
- [ ] From `tugdeck/`: `bunx tsc --noEmit` clean, `bunx vite build` clean.
- [ ] Under pressure, the geometry probe reports a Layouts section height strictly less than its content height. Today it reports exactly equal — this is the [Table T01](#t01-today) defect, repaired.
- [ ] Cmd-L walks onto a Layouts tile that sits below the band's fold, and the tile is revealed rather than left off-screen.

---

#### Step 2: Spike the floor formulation in the real app {#step-2}

**Depends on:** #step-1

**Commit:** `roadmap(lens-space-allocation): resolve the floor formulation by measurement`

**References:** [Q01] floor formulation, [P03] four-row floor, Spec S01, (#current-rules, #q01-floor-formulation)

**Artifacts:**
- [Q01]'s **Resolution** line, rewritten in this document with the chosen option and the numbers that chose it.
- A short note under [Q01] recording what each candidate measured, so a later reader does not re-run the spike.

**Tasks:**
- [ ] Reuse the [#step-1](#step-1) probe. Put the rail under pressure — the [Table T01](#t01-today) shape, where the Cards section wants more than the rail has.
- [ ] Resolve **two** expressions, not one: `<section-floor>` (band header + `--tugx-lens-section-floor`) and the body's, which is the token alone. [Spec S01](#s01-allocation-rules) says why one expression cannot serve both.
- [ ] **Candidate A** — set `min-block-size: fit-content(112px)` and read the probe with a **tall** Snippets band and again with an **empty** one. Record both heights. The candidate passes only if the tall band floors at 112 and the empty band stays at one row.
- [ ] **Candidate B** — set `.lens-section { min-block-size: min-content }` and `.lens-section > .lens-section-body { min-block-size: 112px }`. Record whether the section's resolved minimum equals band-header + 112. This is the question of whether the `min-content` **keyword** behaves differently from the **automatic** minimum size that motivated the existing `:has(.tug-list-view)` gate — measure it, do not reason about it (see [#current-rules](#current-rules)). [#step-1](#step-1) has already shown what the automatic size does with a scroll-container body.
- [ ] **Candidate C** — confirm `.tug-list-view-cell` elements are direct siblings under `.tug-list-view-window`, so `:has(.tug-list-view-cell:nth-child(4))` is a valid "has at least four rows" test. Compare `document.querySelectorAll('.tug-list-view-window > .tug-list-view-cell').length` against the plain `.tug-list-view-cell` count.
- [ ] Choose the simplest candidate that measured correctly, preferring A (one declaration) over B over C (most machinery). Write the choice and the measurements into [Q01].
- [ ] Revert every temporary style. If the spike is driven by a patch, use `tugutil file probe --patch` so bytes *and* mtime are restored.

**Tests:**
- [ ] None — this step produces a measurement and a decision, not code.

**Checkpoint:**
- [ ] [Q01]'s Resolution line names one candidate, gives both expressions, and cites the two numbers (tall band height, short band height) that chose it.
- [ ] `git status` shows only `dash/lens-space-allocation.md` modified — every spike style is reverted.

---

#### Step 3: Priority shrink factors and the floor {#step-3}

**Depends on:** #step-2

**Commit:** `tugways(lens-space-allocation): rank the rail's bands so the lowest priority gives first`

**References:** [P01] flexbox waterfall, [P02] fixed priority, [P03] four-row floor, [P04] editor rule folds in, [P05] floor ceiling, Spec S01, Spec S02, (#waterfall-arithmetic, #caret-and-nth-child)

**Artifacts:**
- `tugdeck/src/components/lens/lens-content.css` — `--tugx-lens-section-floor` per [Spec S02](#s02-floor-token).
- `tugdeck/src/components/lens/lens-section-band.css` — the three shrink factors, the floors, and the restated snippet-editor rule per [Spec S01](#s01-allocation-rules).

**Tasks:**
- [ ] Add `--tugx-lens-section-floor` to the `body` block in `lens-content.css`, directly under `--tugx-lens-empty-block-size` — the token it is stated in terms of, so a reader meets the row height and the floor together.
- [ ] Add the **two** named-tier `flex-shrink` rules to `lens-section-band.css`, keyed off `data-lens-section`, authored as plain decimals per [P01]. Do not write a `.lens-section { flex-shrink: 1 }` rule for the default tier: the existing `flex: 0 1 auto` shorthand already sets shrink to 1, so it would be a resting duplicate whose outcome depends on source order at equal specificity. Do **not** reach for `:nth-child()` — see [#caret-and-nth-child](#caret-and-nth-child).
- [ ] Replace the two `:has(.tug-list-view)`-gated `min-block-size: 0` rules (on `.lens-section` and on `.lens-section > .lens-section-body`) with the two floor expressions resolved in [#step-2](#step-2) — `<section-floor>` on the section, the token alone on the body. Leave the two inner rules in `cards-section.css` and `snippets-section.css` alone — [#current-rules](#current-rules) says why they are not redundant.
- [ ] Rewrite the sizing-model paragraph in `lens-section-band.css`'s file docblock. It currently states "the tall list section gives first and the others hold at content, which is exactly the desired behavior — no explicit floor needed", which this change makes false in both halves. State the new model: content-sized with slack; under pressure the lowest-priority band gives first down to its floor, then the next, with Cards giving last.
- [ ] Restate the snippet-editor rules per [P04], authored *after* the priority rules, with a comment saying they override the ranking rather than sit beside it.
- [ ] Update the sizing paragraph in `lens-content.css`'s docblock, which makes the same now-false claim ("the tallest giving first").

**Tests:**
- [ ] `just app-test at0297-lens-empty-label-row-height.test.ts` — the floor must not inflate an empty band ([R01]).
- [ ] `just app-test at0337-extent-floor-phantom.test.ts` — no scroll-extent regression; also the standing check from [#not-the-floor](#not-the-floor).
- [ ] `just app-test at0266-lens-filter.test.ts` — a filtered band shrinks and regrows without disturbing the ranking.

**Checkpoint:**
- [ ] From `tugdeck/`: `bunx tsc --noEmit` clean, `bunx vite build` clean.
- [ ] Under pressure, the probe reports Layouts at its floor, Snippets at its floor, and Cards holding the remainder — the ordering from [#waterfall-arithmetic](#waterfall-arithmetic), not "Cards gives nothing".
- [ ] With slack, the probe reports every section at its content height, slack > 0, and no Lens `.tug-list-view` with `scrollHeight > clientHeight`.
- [ ] An empty Snippets band measures one row tall, not four.

---

#### Step 4: at0338 gates the invariant and the order {#step-4}

**Depends on:** #step-3

**Commit:** `tugways(lens-space-allocation): gate the rail's slack invariant and its priority order`

**References:** [P01] flexbox waterfall, [P02] fixed priority, [P03] four-row floor, [P05] floor ceiling, Table T01, Risk R03, (#invariant, #waterfall-arithmetic, #success-criteria, #test-non-goals)

**Artifacts:**
- `tests/app-test/at0338-lens-space-allocation.test.ts` — new.
- `tests/app-test/scripts/select-tests.ts` — an `ACCEPTED_FANOUT` bump if the new `@covers` lines push a source file past its accepted count.

**Tasks:**
- [ ] Write `at0338-lens-space-allocation.test.ts`. Model the fixture and the settle discipline on `at0337-extent-floor-phantom.test.ts`: seed a deck with `seedDeckState`, one pane per card, `bindSession` on the session cards so they render the real three-line monitor rows rather than the one-line fallback, then `dispatchControlAction("toggle-lens")`.
- [ ] Seed snippets the way `at0266-lens-filter.test.ts` does — `seedTugbankForLaunch` / `tugbankWrite` from `tests/app-test/_harness/tugbank-helpers.ts`. Assertion 4 needs a Snippets band holding exactly one row, which is a seeded state, not a gesture.
- [ ] Port the [#step-1](#step-1) probe in as a `SECTIONS` eval string returning one record per `.lens-section`: its `data-lens-section`, its rect height, its body's rect height, its list's `scrollHeight`/`clientHeight`, plus the stack's client height and the summed section heights.
- [ ] **Derive pressure; never hardcode a card count.** The harness exposes no window-resize verb and `launchTugApp` takes no window size, so the rail's height is whatever the launch window gives and varies with the display. Seed a small deck, read slack from the probe, and add panes until slack reaches 0 — then assert. A fixed "~30 cards" leaves slack on a tall display and over-pressures a short one, and the test would be reporting the window rather than the rule.
- [ ] Read the floor as a **number the app computes**, not one the test remembers: `app.getComputedStyleValue` on `--tugx-lens-section-floor`, compared against the **body** height. The band header's height is CSS-derived, so a test that hardcodes a section-level floor total is asserting a guess.
- [ ] **Assertion 1 — slack implies no scrolling.** With few enough cards that the stack fits, assert slack > 0 and no Lens `.tug-list-view` has `scrollHeight > clientHeight`. This is [the invariant](#invariant), stated on scroll extent.
- [ ] **Assertion 2 — Layouts can give.** Under pressure, assert the Layouts section height is strictly less than its content height. This is the direct regression gate for the defect in [Table T01](#t01-today), where it gave 0.
- [ ] **Assertion 3 — priority order.** Under pressure, assert the Layouts and Snippets **bodies** both sit within 1px of `--tugx-lens-section-floor`, and Cards holds strictly more than either. Do **not** assert Cards is at its full content height — [#waterfall-arithmetic](#waterfall-arithmetic) shows why that is false at a large enough deficit.
- [ ] **Assertion 4 — no inflation.** With a Snippets band holding one row, assert its section height is within 1px of its content height rather than at the floor ([R01]).
- [ ] **Assertion 5 — the floors fit the rail.** Assert the summed floors of all rendered sections are less than `.lens-sections` client height ([P05]). Cheap, and it is the assertion that fails on the day a fourth section is registered.
- [ ] Settle before reading, the way `at0337` does: read the probe until two consecutive readings agree, rather than sleeping a fixed interval. Layout settles over a commit or two and the assertion is about where the stack comes to rest.
- [ ] Add `@covers` for `tugdeck/src/components/lens/lens-section-band.css` and `tugdeck/src/components/lens/lens-content.css`.
- [ ] Run `just app-test-covers-check`. If it reports a fan-out over the accepted count for either file, bump `ACCEPTED_FANOUT` in `tests/app-test/scripts/select-tests.ts` with a comment arguing why the coupling is real — the CSS files are where the whole mechanism lives, so there is no smaller surface to name.

**Tests:**
- [ ] `just app-test at0338-lens-space-allocation.test.ts` — all five assertions green.
- [ ] Falsification: temporarily revert the shrink-factor rules with `tugutil file probe --patch` and confirm assertion 3 goes **red**. A gate that passes with the fix reverted is not a gate.

**Checkpoint:**
- [ ] `just app-test at0338-lens-space-allocation.test.ts` — 1 file, 5 assertions, green.
- [ ] The pressure fixture derived its card count from a slack reading rather than hardcoding one, and the test's own log says which count it settled on.
- [ ] `just app-test-covers-check` — green.
- [ ] The falsification run went red, and the probe left the tree byte-identical afterwards.

---

#### Step 5: Integration checkpoint {#step-5}

**Depends on:** #step-1, #step-3, #step-4

**Commit:** `N/A (verification only)`

**References:** [P01]–[P05], (#success-criteria, #not-the-floor, #exit-criteria)

**Tasks:**
- [ ] Re-read the amended docblocks in `lens-section-band.css` and `lens-content.css` against the shipped rules — the sizing model is stated in two places and both must describe what the code now does.
- [ ] Confirm the diff contains no `.tsx` change ([the state zone mapping](#state-zone-mapping)).
- [ ] Exercise the rail by hand at three sizes: comfortably slack, at the boundary, and well under pressure. Watch a live window resize cross the boundary in both directions.
- [ ] Open a snippet editor with the rail under pressure and confirm the editing section is still the sole giver ([P04]).

**Tests:**
- [ ] `just app-test-changed` — the selection derived from the diff.
- [ ] `just app-test` — the core tier, since `lens-content.css` is loaded by every Lens surface.

**Checkpoint:**
- [ ] From `tugdeck/`: `bunx tsc --noEmit` clean, `bunx vite build` clean.
- [ ] `just app-test-changed` green.
- [ ] `just app-test` green (core tier; the four `foreground: true` tests skip on a background run).
- [ ] Every box in [the exit criteria](#exit-criteria) ticked.

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** The Lens rail fills its height before anything scrolls, and when it cannot, the shortfall is spent on Layouts first, then Snippets, then Cards — in CSS, driven by nothing.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] With slack, no Lens list is scrollable (`at0338` assertion 1).
- [ ] Under pressure, Layouts gives (`at0338` assertion 2) — it gave 0 in [Table T01](#t01-today).
- [ ] Under pressure, Layouts and Snippets sit at the floor and Cards holds the remainder (`at0338` assertion 3).
- [ ] A one-row band is one row tall, not four (`at0338` assertion 4).
- [ ] The summed floors fit the rail (`at0338` assertion 5).
- [ ] The diff touches CSS and tests only — no React state added ([#state-zone-mapping](#state-zone-mapping)).
- [ ] `at0297`, `at0231`, `at0266`, and `at0337` still pass.
- [ ] Both sizing docblocks describe the shipped model.

**Acceptance tests:**
- [ ] `just app-test at0338-lens-space-allocation.test.ts`
- [ ] `just app-test` (core tier)

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] **`spacePriority` as a registry field.** [P02] fixes the ranking in CSS by section kind. When the Lens redesign v2 adds sections, promoting one is a one-line CSS addition; if that becomes frequent, move priority onto `LensSectionDefinition` and stamp it as a data attribute.
- [ ] **Per-section floor overrides.** [P03] gives every band the same floor. A band whose rows are much taller than one line — Cards, with its 73px session rows — may want its own.
- [ ] **A band's floor when it is the only band.** With one section registered there is no waterfall and the floor never binds. Nothing to do today; worth a thought if the Lens ever renders a single section.

| Checkpoint | Verification |
|------------|--------------|
| [Q01] resolved by measurement | [Q01]'s Resolution line names a candidate and its two numbers |
| Layouts can give | `at0338` assertion 2 |
| Priority order under pressure | `at0338` assertion 3 |
| Invariant holds with slack | `at0338` assertion 1 |
| No inflation of short bands | `at0338` assertion 4, `at0297` |
| Floors fit the rail | `at0338` assertion 5 |
| No React state added | `git diff --stat` shows no `.tsx` |
| Nothing regressed | `just app-test-changed`, `just app-test` |
