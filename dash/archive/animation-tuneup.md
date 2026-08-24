<!-- devise-skeleton v4 -->

## Animation Tune-up — Motion Residency, Stationing, and Enforcement {#animation-tuneup}

**Purpose:** Make Tug's long-running animations structurally free — every design-approved loop runs on the compositor, and stays there — and lock the contract in with a machine-checked residency law so no future animation can regress it.

> **Read [Addendum C](#addendum-c) first.** This document has been rewritten twice by measurement. The body and Addenda A and B are kept as the record of what was believed and why it was wrong; Addendum C holds the finding that resolved the phase, the corrected cost model, the live step ledger (#c-step-status-ledger), and the only steps still pending. The one-line version: a multi-stop CSS `linear()` easing silently blocks compositor acceleration in WebKit, which cost the pulsing dot 28.0% of a core for 100 glyphs where the same animation, with its curve moved into the keyframe stops, costs 1.5%. "Inside a contained box" in the original purpose statement above is withdrawn ([P17]); stationing was never justified by a measurement.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-07-28 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

Tug uses long-running animation deliberately — pulsing dots on running sessions and tool-call headers, the wave caret in a streaming prompt, spinners and bars in progress surfaces, skeleton shimmer during loads. That is a design commitment and it is not changing. What must change is what those animations *cost*. Profiling (2026-07-28, `sample` on the live WebContent processes) showed the release app spending ~20% of wall-clock main-thread time at idle, with ~63% of the busy time inside `LocalFrameViewLayoutContext::updateCompositingLayersAfterStyleChange` — the full-tree compositing-requirements walk — and the style path running `KeyframeEffectStack::applyKeyframeEffects` → `preventsAcceleration` / `canBeAccelerated` every frame. Translation: some running animations fail WebKit's compositor-acceleration test, so the main thread blends keyframes, re-resolves style, and re-walks the layer tree at 60Hz for as long as they run. A window live-resize adds a full relayout per frame on top of that already-saturated loop, which is the judder the user feels.

The failures are specific properties, not the animation API: `tug-skeleton` animates `background-color` (never accelerable); the pulsing dot's `emit-thicken` animates `border-width` (a layout property, and one non-accelerable property in an element's effect stack forces the element's *entire* stack onto the main thread — the dot's own CSS docstring underestimates this as "re-rasters the ring"); the spinner animates `opacity` on SVG interior `<rect>` spokes and the ring rotates a nested SVG (SVG interiors never get compositing layers, so those loops are main-thread by construction). Meanwhile even the correctly-accelerated transform loops subscribe the page to per-update overlap testing (`computeExtentOfTransformAnimation` → `computeCompositingRequirements`, observed recursing 10 deep with `calculateClipRects` 6 deep beneath), a cost that scales with the whole layer tree because nothing bounds the animated elements' extents.

#### Strategy {#strategy}

- **Fix the mechanism, not the design.** Every re-plumb below reproduces the shipped look exactly through a compositor-eligible mechanism (opacity crossfades, transforms on HTML wrappers). Zero visual change is a checkpoint, not a hope.
- **Compositor residency first** (skeleton, pulsing dot, spinner, ring) — these run *during turns*, which is exactly when the user resizes and feels jank, and they are the largest measured cost.
- **Then stationing**: wrap every long-run animation in a fixed-size contained box so its overlap extent is local, plus a `will-change` audit so layers exist only while their animation runs.
- **Then dormancy**: a collapsed pane must not tick animations under its `height: 0` body.
- **Enforce by census, not by review.** `document.getAnimations()` exposes every running animation, its target, and its keyframe properties; an app-test asserts the residency contract against the real app so a violating animation fails CI with its name in the message.
- **Measure before and after.** A `just` profiling recipe turns "does resize jank" into a number (`sample`-based main-thread busy %), taken at step 1 and re-taken at the end.

#### Success Criteria (Measurable) {#success-criteria}

- With a session card mid-turn (dots pulsing, wave running), `sample` of the WebContent process over 5s shows `Style::TreeResolver::resolve` absent from the per-frame timer path — no `KeyframeEffectStack::applyKeyframeEffects` under `RemoteLayerTreeDrawingArea::updateRendering` at steady state. (Verify: `just perf-resize-profile` idle mode, before/after comparison.)
- The residency app-test passes: every running `CSSAnimation` with infinite iterations targets an `HTMLElement`, animates only `transform`/`opacity`, and sits inside a `.tugx-motion-station`. (Verify: the new app-test in CI / `just app-test-changed`.)
- All six `TugProgressIndicator` variants, the skeleton, and the gallery timing bench are visually indistinguishable from before at every state — verified side-by-side in the gallery cards. (Verify: gallery inspection + `app.screenshot()` comparison during implementation.)
- Collapsing a pane whose card hosts running indicators stops those animations from ticking (`document.getAnimations()` on elements under the collapsed body reports `playState !== "running"`), and expanding resumes them seamlessly. (Verify: assertion in the residency app-test.)
- `bunx vite build` passes; `just app-test-changed` green.

#### Scope {#scope}

1. Re-plumb the four non-accelerable long-run animations: skeleton shimmer, pulsing-dot ring thicken, spinner spoke fade, ring spin (and verify pie/bar/wave/marquee/session-changes pass as-is).
2. Introduce the **motion station** wrapper (`contain`-based extent bounding) across the progress-indicator family, skeleton, sparkline, and marquee.
3. `will-change` audit across the 16 standing declarations: keep only those co-located with a running-state selector.
4. Collapse dormancy: pause long-run animations under a collapsed pane body via an inherited CSS variable.
5. Enforcement: animation census helper in `perf-monitor.ts`, a residency app-test, and a `just perf-resize-profile` recipe.
6. Doctrine: a motion-residency section in tuglaws plus a global design-decision entry, cross-linked from `component-authoring.md`.

#### Non-goals (Explicitly out of scope) {#non-goals}

- Occlusion-based dormancy (pausing animations in panes fully covered by other panes) — requires z-order geometry tracking; revisit only if post-tune-up profiles still show idle burn.
- Reducing transcript layer depth (sticky pins, block headers) — the July perf program (P3) already restructured these; re-open only on post-tune-up evidence.
- Imposed-card *width* tracking during window resize — the imposer's fixed-width/live-position design (`tugdeck/src/lib/layout-imposer.ts`) is a separate design question, not a perf one.
- Changing any animation's design: timing, easing, geometry, and choreography are untouched.
- The `tug-sheet` and imposer settle *transitions* — finite, gesture-scoped, already correct.

#### Dependencies / Prerequisites {#dependencies}

- July 2026 perf program shipped (sparkline dormancy, notify batching, `__pin` sticky consolidation, `offscreenSkip`) — this plan builds on it and does not re-open it.
- App-test harness with `@covers` selection (`tests/app-test/`), `evalJS` bridge, and `window.tugPerfMonitor` (dev/test-only, `tugdeck/src/lib/perf-monitor.ts`).
- `sample` CLI (ships with macOS) and AppleScript System Events access for the profiling recipe (accessibility permission on the driving terminal).

#### Constraints {#constraints}

- WARNINGS ARE ERRORS (workspace-wide); `bunx vite build` must pass before any tugdeck change is done (dev-esbuild/rollup divergence).
- Never `npm`; bun only. Tugdeck HMR is live; no manual frontend builds during development.
- App-tests: selective runs via `just app-test-changed`; every new test carries `@covers` and registers in `tuglaws/app-test-inventory.md`.
- Motion-off must keep working: `body[data-tug-motion="off"]` zeroes all loops today; every re-plumbed animation must stay under that gate.
- Reduced-motion/`--tug-timing` scaling (`calc(… * var(--tug-timing, 1))`) must survive every re-plumb.

#### Assumptions {#assumptions}

- WebKit accelerates `transform`/`opacity` `@keyframes` on HTML elements that hold their own compositing layer, and never accelerates animations targeting SVG interior elements or animating layout/paint properties (`border-width`, `background-color`). This matches the observed `preventsAcceleration` frames in the profile.
- `contain: layout paint` on a fixed-size wrapper clips a descendant animation's overlap extent at the wrapper (WebKit's `computeClippedOverlapBounds` clips by ancestor clip rects), making overlap testing local to the station.
- A paused CSS animation (`animation-play-state: paused`) does not dirty style per frame; resuming restores the loop mid-phase with no visual cut.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Does the thicken crossfade read identically to the border-width lerp? (OPEN → resolve in implementation) {#q01-thicken-parity}

**Question:** The pulsing dot's ring stroke "thickens" over the back of its cycle by animating `border-width` between `--tugx-progress-pulsing-dot-pulse-birth-width` and `--…-pulse-end-width`. The re-plumb replaces this with two stacked ring elements (birth weight, end weight) crossfaded by opacity. A crossfade of two stroke weights is not mathematically a stroke-width lerp — at some mid-cycle frames it may read as a soft double edge instead of a single thickening line.

**Why it matters:** The dot is the most-seen indicator in the product; a visibly mushier ring is a design regression the plan promises not to make.

**Options (if known):**
- Two-layer crossfade (planned) — verify at both size treatments (28px Lens row, 10px status cell) in the gallery timing bench.
- Fallback: a single static mid-weight stroke with the existing expand+fade — loses the thicken gesture; a design call for the owner, not the implementer.

**Plan to resolve:** Implement the crossfade behind the same `data-emitting` gate; compare against the shipped build side-by-side in `gallery-tug-progress-indicator` (the timing bench already renders four cuts side-by-side). If parity fails at either size, stop and surface the fallback option to the user before proceeding.

**Resolution:** OPEN (resolved at #step-3's checkpoint).

#### [Q02] Is the ring's SVG-root spin actually main-thread? (DECIDED — moot, see [P06]) {#q02-svg-root-acceleration}

**Question:** `tug-progress-ring.css` animates `.tug-progress-ring-svg` — the `<svg>` *root*, which unlike SVG interiors can hold a compositing layer, so its spin may already be accelerated.

**Why it matters:** Only for effort estimation — if accelerated, the ring re-plumb is optional.

**Resolution:** DECIDED — moot. [P06] moves the spin to the HTML wrapper regardless, because the enforcement law asserts `target instanceof HTMLElement` and a uniform law beats a per-case carve-out for SVG roots. The move is two selector edits.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Crossfade thicken reads visibly different | med | med | [Q01] side-by-side bench check before landing; fallback design call | Gallery comparison fails |
| `contain` on stations clips deliberate overshoot (small pulsing dot lets its ring past the box) | med | high if ignored | Station box is the *motion extent*, not the glyph box — see [P02]; small-dot reach computed from `sizeGeometry` | Any clipped ring in gallery small-size row |
| `contain: size` breaks a consumer that relied on content-driven indicator sizing | low | low | Indicators are already fixed-size (`size` prop → inline width/height); census step greps consumers | tsc/visual break in a consumer |
| Census test is flaky (animations mid-transition at assert time) | med | med | Assert only infinite-iteration `CSSAnimation`s; settle-wait before census; exempt finite transitions | Test flakes in CI |
| `animation-play-state` var gate missed on some loop → collapse doesn't pause it | low | med | The census test asserts paused state under a collapsed pane for every discovered loop, so a miss is caught mechanically | Census collapse assertion fails |

**Risk R01: Visual drift under re-plumb** {#r01-visual-drift}

- **Risk:** Re-plumbed mechanisms (overlay crossfades, HTML spokes) subtly change rendering — anti-aliasing, sub-pixel rounding, blend order.
- **Mitigation:** Each re-plumb step's checkpoint includes a gallery side-by-side against the pre-change build; `app.screenshot()` captures for the record; land one component per commit so a drift bisects to one change.
- **Residual risk:** Sub-pixel AA differences invisible at 1x may appear at 2x; accepted if unnoticeable in the gallery at both zooms.

**Risk R02: Perf win smaller than expected** {#r02-perf-shortfall}

- **Risk:** Residency + stationing lands but resize still judders, because the irreducible per-frame relayout of a resize dominates.
- **Mitigation:** Step 1 captures the baseline profile so the delta is attributable; the plan's success criterion is the *style/animation path* leaving the frame loop, which is what we control.
- **Residual risk:** If post-tune-up profiles still jank, the next suspect is transcript layer depth — explicitly a follow-on (#roadmap), now with numbers to justify it.

---

### Design Decisions {#design-decisions}

#### [P01] The compositor-residency contract (DECIDED) {#p01-residency-contract}

**Decision:** A long-running animation (infinite iterations, or total duration > 5s) may animate only `transform` and `opacity`, must target an `HTMLElement` (never any SVG element, root or interior), and no other animation on the same element may animate any other property while it runs.

**Rationale:**
- These are exactly WebKit's acceleration conditions (observed: `KeyframeEffect::canBeAccelerated` failures put the whole effect stack on the main thread at 60Hz).
- One flat rule is enforceable by census ([P09]); carve-outs ("SVG roots are sometimes fine") are not.
- Finite gesture transitions (imposer settle, sheet roll, state crossings) are exempt — they end.

**Implications:**
- Skeleton shimmer, pulsing-dot thicken, spinner spokes, and ring spin must be re-plumbed ([P03]–[P06]).
- Future indicators are born under the law; the census test names violators.

#### [P02] Motion stations: `contain: layout paint size` at the motion extent (DECIDED) {#p02-motion-stations}

**Decision:** Every long-run animation lives inside a `.tugx-motion-station` wrapper — a fixed-size box with `contain: layout paint size` (equivalent to `contain: strict`) sized to the animation's full **motion extent**, not the glyph box.

**Rationale:**
- Paint containment clips the animated descendants' overlap extents at the station, so WebKit's per-update overlap test is local (a few dozen px²) instead of page-global.
- Size+layout containment guarantees the loop can never dirty ancestor layout.
- The extent distinction is load-bearing: the pulsing dot's small treatment (below 28px) deliberately sends the ring **past** the glyph box (`--tugx-progress-pulsing-dot-emit-reach-auto` ramps past 1; see `sizeGeometry` in `tug-progress-pulsing-dot.tsx`). The station must be `size × reach` so containment never clips the designed overshoot.

**Implications:**
- The station wrapper renders inside `TugProgressIndicator` (one place covers all six variants), standalone inside `TugSkeleton`, `TugSparkline`, and `TugMarquee`, and on the wave caret's self-built root span (`wave-caret.ts` bypasses the indicator facade — see Spec S02).
- The station also carries the dormancy variable ([P08]) — one wrapper, two jobs.
- The census test asserts `target.closest(".tugx-motion-station") !== null`.

#### [P03] Skeleton shimmer via overlay opacity crossfade (DECIDED) {#p03-skeleton-overlay}

**Decision:** `.tug-skeleton` keeps `background-color: var(--tugx-skeleton-base)` static; an `::after` overlay (`inset: 0`, `border-radius: inherit`, `background-color: var(--tugx-skeleton-highlight)`, `opacity: 0`) animates `opacity` 0 → 1 → 0 on the existing 2s `cubic-bezier(0.4, 0, 0.6, 1)` cycle, replacing the `td-shimmer` background-color keyframes (`tugdeck/src/components/tugways/tug-skeleton.css`).

**Rationale:**
- With an opaque highlight token, `α·highlight + (1−α)·base` is *pixel-identical* to interpolating `background-color` between the same two colors — same curve, same period, same colors.
- `opacity` on a pseudo-element is compositor-accelerable.

**Implications:**
- If any theme ships a non-opaque `--tugx-skeleton-highlight`, parity breaks — check the six theme files during the step; none are expected to.

#### [P04] Pulsing-dot thicken via stacked-stroke crossfade (DECIDED) {#p04-dot-thicken-crossfade}

**Decision:** The emitted ring becomes a wrapper + two stroke layers: the wrapper `<span>` carries the existing `emit-expand` (transform) and `emit-fade` (opacity) keyframes; two child `<span>`s carry static `border-width`s (`--…-pulse-birth-width`, `--…-pulse-end-width`) and crossfade by opacity on the `emit-thicken` easing (`--tugx-progress-pulsing-dot-emit-thicken-ease`), replacing the `border-width` keyframes in `tugx-progress-pulsing-dot-emit-thicken` (`tug-progress-pulsing-dot.css`).

**Rationale:**
- Removes the one layout-property animation from the stack, restoring the whole dot to the compositor.
- Phase lock is preserved by the component's existing mechanism: all ring animations share one duration and are gated on `data-emitting` written by the component (`releaseEmitter` clocks the pulse, not the state) — the two new opacity keyframes ride the same clock.

**Implications:**
- DOM change in `tug-progress-pulsing-dot.tsx` (currently `<span class="…-dot">` + `<span class="…-ring">` under the root, `tug-progress-pulsing-dot.tsx` render): ring becomes a 3-element group. The component's ref-based catch-and-cross logic (`ringRef`) must move to the wrapper.
- [Q01] governs acceptance; both size treatments checked.

#### [P05] Spinner spokes as HTML elements (DECIDED) {#p05-spinner-html-spokes}

**Decision:** `TugProgressSpinner` (`tugdeck/src/components/tugways/internal/tug-progress-spinner.tsx`) drops the `<svg viewBox="0 0 100 100">` + 12 `<rect>` structure for 12 absolutely-positioned `<span>` spokes — each a rounded rect via `border-radius`, placed with `transform: rotate(i·30deg) translateY(…)`, dimensions scaled from the same constants (`INNER 24, OUTER 48, SPOKE_WIDTH 9`, viewBox-units → percentages of the box). The staggered `tug-progress-spinner-fade` opacity loop and per-spoke negative `animation-delay` move unchanged onto the spans.

**Rationale:**
- SVG interior `<rect>`s can never be accelerated; 12 spokes × opacity loop is 12 perpetual main-thread animations per visible spinner.
- The geometry is trivially reproducible in HTML: a spoke is a rounded rect — exactly what a `<span>` with `border-radius` is.

**Implications:**
- The static pose transform (`rotate` for placement) and the animated property (`opacity`) live on the same element — allowed by [P01] (only the *animated* property set matters; static transforms are fine).
- `fill:` becomes `background-color:` on the spoke class; state selectors (`-running/-paused/-completed/-disabled`) unchanged.

#### [P06] Ring and pie spin on the HTML wrapper (DECIDED) {#p06-spin-on-wrapper}

**Decision:** `tug-progress-ring.css` moves the `tug-progress-ring-spin` animation (and its scoped `will-change: transform`) from `.tug-progress-ring-indeterminate .tug-progress-ring-svg` to the component's root `<span>`; the SVG becomes static art. Pie already animates its HTML element (`.tug-progress-pie-indeterminate`) and needs no change beyond census verification.

**Rationale:**
- Resolves [Q02] by construction; keeps the law flat (`HTMLElement` targets only).
- The determinate arc's `stroke-dashoffset` *transition* is finite and exempt under [P01].

**Implications:**
- The `-90deg` start angle currently baked into the spin keyframes must be preserved (a static `transform: rotate(-90deg)` on the SVG, with the wrapper spinning 0→360, or keyframes kept as-is on the wrapper).

#### [P07] `will-change` only under a running-state selector (DECIDED) {#p07-will-change-discipline}

**Decision:** A `will-change` declaration is legal only in a rule whose selector requires the animation to be running (e.g. `.tug-progress-spinner-running …`, `.tug-progress-ring-indeterminate …`, `[data-breathing]`, `.session-changes-scanning-spin`). Standing declarations on always-present elements are removed or re-scoped.

**Rationale:**
- `will-change` forces a permanent layer that participates in every overlap walk; most of the family already scopes it correctly (ring/pie/spinner/bar/wave are exemplary) — this makes the good pattern the law.
- Known audit targets from the 2026-07-28 inventory (16 sites): `tug-marquee.css` `.tug-marquee-strip` (standing — scope to its scrolling state), `tug-sparkline.css` `.tug-sparkline-track` (standing — scope to the dormancy-awake state from the July program), `tug-sheet.css` (standing on the shade — sheets are transient surfaces; verify the element unmounts at rest, else scope), `gallery.css` petals/pole (gallery-only; scope to running selectors for hygiene).

**Implications:**
- Each removal is verified by re-checking the animation still composites (no jank reintroduced) — the profiling recipe covers this.

#### [P08] Collapse dormancy via an inherited play-state variable (DECIDED) {#p08-collapse-dormancy}

**Decision:** Every long-run animation declaration includes `animation-play-state: var(--tugx-motion-play, running);` as part of the residency contract, and `.tug-pane-chrome--collapsed` (the existing collapse class, `tug-pane.css`) sets `--tugx-motion-play: paused` so the variable inherits into every station under the collapsed body.

**Rationale:**
- A collapsed pane keeps its body mounted under `height: 0; overflow: hidden` (`.tug-pane-chrome--collapsed .tug-pane-body`), and hidden-but-mounted animations tick style forever — the exact hole the sparkline dormancy work closed for one component, closed here for all of them.
- `animation-play-state` can't be set for descendants from an ancestor rule, but a custom property inherits — the var is the only mechanism that lets one ancestor rule pause arbitrary descendants without enumerating them.
- Pause/resume is seamless by spec: the loop freezes mid-phase and resumes mid-phase, so expanding a pane shows no cut. (Non-active *tab* cards are already safe — they render `display: none`, which removes animations entirely.)

**Implications:**
- The census test asserts the pause behaviorally: collapse a seeded pane, then require every infinite animation under its body to report `playState !== "running"`.
- **The var gates CSS animations only** — WAAPI loops (the sparkline) don't read `animation-play-state`. The sparkline's activity-driven dormancy (shipped 2026-07) covers the common case; full WAAPI collapse-pause is a follow-on (#roadmap), and the doctrine doc must state this asymmetry plainly rather than imply the var covers everything ([P11]).
- Inactive/occluded (not collapsed) panes are out of scope (#non-goals).

#### [P09] Enforcement by census app-test (DECIDED) {#p09-census-enforcement}

**Decision:** A new app-test seeds the `gallery-tug-progress-indicator` card (componentId registered in `gallery-registrations.tsx`, which mounts all variants and states), plus a `TugSkeleton` surface, and asserts over `document.getAnimations()`: every long-running animation — **any `Animation` that is not a `CSSTransition`** (CSS `@keyframes` and WAAPI alike; the sparkline's WAAPI scroll must not dodge the law) — with `effect.getTiming().iterations === Infinity` (1) targets an `HTMLElement`, (2) has `effect.getKeyframes()` properties ⊆ {`transform`, `opacity`, `offset`, `easing`, `composite`}, (3) has `effect.target.closest(".tugx-motion-station") !== null`; then collapses the pane and asserts every such animation under it is not `running` ([P08]). Before asserting zero violations, the test asserts a **minimum discovered count** (≥ the number of running variants the seeded gallery card mounts) so a motion-off environment or a failed card mount reads as a failure, never a vacuous pass.

**Rationale:**
- The whole contract is introspectable from JS against the *real* app — no mocks, no jsdom, per the project's real-code-paths doctrine.
- A violation fails with the animation name and target class — self-diagnosing.

**Implications:**
- Census logic lives as `animationCensus()` in `tugdeck/src/lib/perf-monitor.ts` (exposed on `window.tugPerfMonitor`, dev/test-only), so the app-test and any future DevPanel tile share one implementation.
- Registered in `tuglaws/app-test-inventory.md` with `@covers` lines for the indicator family files.

#### [P10] `just perf-resize-profile` — the resize jank meter (DECIDED) {#p10-profiling-recipe}

**Decision:** A `just` recipe drives a paced window resize on a named running Tug process via AppleScript System Events (`set size of window 1`, ~60 steps × 80ms, restoring the original frame), concurrently runs `sample <WebContent-pid> 5`, and prints a short verdict: main-thread busy %, and the top style-path frames (`resolveStyle`, `updateCompositingLayersAfterStyleChange`, `applyKeyframeEffects` counts). An idle mode skips the resize drive for steady-state measurement.

**Rationale:**
- This exact procedure produced every number in #context; scripting it makes before/after comparison a one-liner instead of Instruments ceremony.
- It is a manual tool, not CI — `sample` output is machine-load-dependent.

**Implications:**
- The recipe must find the right WebContent child (the one whose ancestor is the target app's pid — via `pgrep`/`ps` walk), and must tolerate missing accessibility permission with a clear error.

#### [P11] Doctrine lands in tuglaws (DECIDED) {#p11-tuglaws-doctrine}

**Decision:** A new `tuglaws/motion-residency.md` records the contract ([P01], [P02], [P07], [P08]) with the WebKit cost model that motivates it; `tuglaws/design-decisions.md` gains one entry (next free `[D##]`) naming the contract; `tuglaws/component-authoring.md` gains a cross-link in its motion guidance.

**Rationale:**
- tuglaws is the curated durable doc surface; the census test enforces the letter, the doc preserves the why.

**Implications:**
- Future `[L13]` motion citations should co-cite the residency doc.

---

### Deep Dives {#deep-dives}

#### The WebKit cost model (why the contract has exactly these clauses) {#webkit-cost-model}

A CSS/WAAPI animation runs in one of two regimes. **Accelerated:** the animation's keyframes are handed to the compositor once; the main thread does nothing per frame. Requires: only `transform`/`opacity` animated, target element holds a compositing layer, and no co-animated non-accelerable property on the same element (WebKit evaluates the whole `KeyframeEffectStack`; one bad property demotes everything — `KeyframeEffect::preventsAcceleration`). SVG interior elements never hold layers, so their animations are never accelerated. **Main-thread:** every frame runs keyframe blending inside style resolution (`Style::TreeResolver` → `applyKeyframeEffects`), which dirties style, which triggers `updateCompositingLayersAfterStyleChange` — a recursive walk (`computeCompositingRequirements`) over the layer tree doing overlap testing (`computeClippedOverlapBounds`, `accumulateOffsetTowardsAncestor` — the hottest leaf in the 2026-07-28 profiles). The cost is O(layer-tree size × depth), per frame, for the animation's lifetime.

Even accelerated transform animations participate in overlap testing whenever a compositing update runs for any reason (and during a window resize one runs every frame): the engine computes the union of every pose the animation can take (`computeExtentOfTransformAnimation`) and promotes anything it might overlap. Ancestor clips bound that extent — which is what makes stationing ([P02]) effective and why `.tug-pane-chrome`'s existing `overflow: clip` already stops extents at pane boundaries. The station tightens the bound from "the pane" to "the glyph's own box".

**Table T01: Long-run animation inventory and verdicts (2026-07-28 audit)** {#t01-inventory}

| Surface | File | Animated property → target | Verdict |
|---------|------|---------------------------|---------|
| Skeleton shimmer | `tugways/tug-skeleton.css` (`td-shimmer`) | `background-color` → div | **VIOLATION** → [P03] |
| Pulsing-dot breathe | `tugways/internal/tug-progress-pulsing-dot.css` | `transform` → span | OK |
| Pulsing-dot emit (expand/fade/**thicken**) | same | `transform`+`opacity`+**`border-width`** → ring span | **VIOLATION** (thicken poisons stack) → [P04] |
| Spinner spoke fade | `tugways/internal/tug-progress-spinner.css` | `opacity` → **SVG `<rect>`** ×12 | **VIOLATION** → [P05] |
| Ring spin | `tugways/internal/tug-progress-ring.css` | `transform` → **`<svg>` root** | **VIOLATION** under flat law → [P06] |
| Pie spin | `tugways/internal/tug-progress-pie.css` | `transform` → span | OK (verify by census) |
| Bar barber-pole | `tugways/internal/tug-progress-bar.css` | `transform` → HTML, clipped by track | OK (exemplary) |
| Wave / wave-caret | `tugways/internal/tug-progress-wave.css` | `transform` (scaleY) → spans | OK (exemplary); wave-caret builds this DOM directly in the editor (`wave-caret.ts`), so it needs its own station ([P02], Spec S02) |
| Sparkline scroll | `tugways/tug-sparkline.css` + WAAPI | `transform` → div | OK (dormancy shipped 2026-07); station + will-change scope in [P07] |
| Marquee scroll | `tugways/tug-marquee.css` | `transform` → strip | OK; standing `will-change` → [P07] |
| Session-changes scanning spin | `tugways/cards/session-changes/session-changes-view.css` | `transform` → HTML | OK (will-change already scoped) |
| Gallery petals/pole demos | `tugways/cards/gallery.css` | `transform`/`opacity` | OK; hygiene pass in [P07] |
| Skeleton pulse (gallery demo) | `tugways/cards/gallery-skeleton.tsx` | inherits [P03] | follows skeleton |

#### Existing component mechanics an implementer must not break {#component-mechanics}

- **Pulsing dot's crossing machinery** (`tug-progress-pulsing-dot.tsx`): motion is gated on `data-breathing`/`data-emitting` attributes the component writes — *not* on `data-state` — so state arrivals cross instead of cutting. `releaseEmitter` releases the ring on the pulse's own clock; `breathPhaseFor` starts the breathe loop at the phase matching the dot's pinned pose. The [P04] wrapper takes over the current ring element's role; the two stroke children are purely presentational and need no script.
- **Indicator states** (`tug-progress-indicator.tsx`): `running/paused/stopped/completed/aborted` + `disabled`; `paused` uses `animation-play-state: paused` already — the [P08] var must compose with it (two pause sources; CSS `animation-play-state` takes one value, so paused-state rules must keep their explicit `paused`, which wins by being the more specific rule — verify in the step).
- **Motion-off**: `body[data-tug-motion="off"]` zeroes loops globally; `--tug-timing` scales durations. Both must hold for every re-plumbed rule.
- **Skeleton API** (`tug-skeleton.tsx`): single `div.tug-skeleton` with `width/height/radius` props and a `tug-skeleton-group` container — the `::after` overlay adds no DOM.

---

### Specification {#specification}

**Spec S01: The residency contract (normative)** {#s01-residency-contract}

1. An animation is **long-running** iff `iterations === Infinity` or `duration × iterations > 5000ms`. The contract covers **every `Animation` kind** — CSS `@keyframes` (`CSSAnimation`) and WAAPI (`Animation`) alike; only `CSSTransition`s are outside it (they are finite by construction).
2. A long-running animation MUST animate only `transform` and/or `opacity`.
3. Its effect target MUST be an `HTMLElement` (never `SVGElement`, root or interior).
4. No other animation or transition on the same element may animate a property outside {`transform`, `opacity`} while the long-running animation runs.
5. *(Withdrawn — [P17]. Stations are no longer part of the contract.)*
6. Every long-running animation declaration MUST include `animation-play-state: var(--tugx-motion-play, running)` unless a more specific state rule (e.g. paused-state) overrides it deliberately.
7. `will-change` MUST appear only in rules whose selector implies the animation is running.
8. Finite gesture transitions and one-shot animations are exempt from 2–7 (but not from good sense).
9. A long-running animation's timing function — at the animation level and at every keyframe — MUST be expressible as a cubic Bézier: the `linear` keyword, `ease`/`ease-in`/`ease-out`/`ease-in-out`, or `cubic-bezier(…)`. A `linear()` with more than two stops MUST NOT appear on a long-running animation ([P22]). `steps(…)` is compliant — measured harmless, see [Q07].

**Spec S02** {#s02-motion-station}

*(Deleted — motion stations were withdrawn by [P17]; nothing renders or asserts a `.tugx-motion-station`.)*

#### State Zone Mapping (tugdeck/tugways plans) {#state-zone-mapping}

| State | Zone (appearance / local-data / structure) | Mechanism | Law |
|-------|--------------------------------------------|-----------|-----|
| Collapse pause (`--tugx-motion-play`) | appearance | CSS custom property set by existing `.tug-pane-chrome--collapsed` rule; inherited | [L06] |
| Animation census | dev/test-only derived data | plain function in `perf-monitor.ts`, exposed on `window.tugPerfMonitor`; no store, no React | [L02] n/a (never enters React) |
| Station geometry | appearance | inline `width/height` computed from existing size props at render | [L06] |

No new React state, no new stores, no new persistence.

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tuglaws/motion-residency.md` | The doctrine: contract, cost model, station spec |
| `tests/app-test/at02XX-motion-residency.test.ts` | Census enforcement app-test (number = next free per `tuglaws/app-test-inventory.md`) |
| `scripts/perf-resize-profile.sh` (or inline in justfile) | Paced-resize + `sample` profiling driver |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `animationCensus()` | fn | `tugdeck/src/lib/perf-monitor.ts` | Enumerates `document.getAnimations()`, classifies per Spec S01, returns violations list |
| `.tugx-motion-station` | CSS class | per Spec S02 | Contain wrapper + `--tugx-motion-play` reader host |
| `TugProgressIndicator` | component | `tugdeck/src/components/tugways/tug-progress-indicator.tsx` | Wraps glyph in station |
| `TugSkeleton` | component | `tugdeck/src/components/tugways/tug-skeleton.tsx` | `::after` shimmer overlay ([P03]); station class on root |
| `TugProgressPulsingDot` | component | `tugdeck/src/components/tugways/internal/tug-progress-pulsing-dot.tsx` | Ring → wrapper + 2 stroke layers ([P04]) |
| `TugProgressSpinner` | component | `tugdeck/src/components/tugways/internal/tug-progress-spinner.tsx` | HTML spokes ([P05]) |
| `tug-progress-ring.css` | CSS | `tugdeck/src/components/tugways/internal/` | Spin to wrapper ([P06]) |
| `wave-caret.ts` | module | `tugdeck/src/components/tugways/tug-text-editor/` | Station class + extent on its root span (Spec S02) |
| `perf-resize-profile` | just recipe | `justfile` | [P10] |

---

### Documentation Plan {#documentation-plan}

- [ ] `tuglaws/motion-residency.md` — contract + cost model ([P11])
- [ ] `tuglaws/design-decisions.md` — one new `[D##]` entry citing the contract
- [ ] `tuglaws/component-authoring.md` — cross-link from motion guidance
- [ ] `tuglaws/app-test-inventory.md` — register the census test

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **App-test (census)** | Assert the residency contract against the real running deck | The enforcement backbone; collapse-pause behavior |
| **Visual (manual + screenshot)** | Prove re-plumbs are pixel-faithful | Each re-plumb step's checkpoint, gallery side-by-side |
| **Profile (manual recipe)** | Before/after main-thread numbers | Step 1 baseline; final verification |
| **Build** | `bunx vite build` + tsc | Every step (rollup/dev-esbuild divergence) |

#### What stays out of tests {#test-non-goals}

- jsdom/mock render tests of indicators — banned pattern; the census test drives the real app.
- Automated pixel-diff CI — screenshots inform the implementer during the step; AA/scale variance makes them brittle as CI gates.
- CI-gated profiling — `sample` numbers are machine-dependent; the recipe is a tool, not a gate.
- Occlusion dormancy — out of scope (#non-goals).

---

### Execution Steps {#execution-steps}

> **Commit after all checkpoints pass.** This rule applies to every step below.

#### Step Status Ledger {#step-status-ledger}

> **Stale — this ledger is historical.** The live ledger is #c-step-status-ledger in Addendum C, which is the one an implementer resumes from. Read #addendum-c first: it supersedes the cost model, the success criteria, and every pending step in this document and in Addenda A and B.

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Baseline profile + census helper + profiling recipe | done | `92f80410e` |
| #step-2 | Skeleton shimmer overlay | done | `757bb04fb` |
| #step-3 | Pulsing-dot thicken crossfade | done (Q01 open) | `cd9ee8916` |
| #step-4 | Spinner HTML spokes | done | `43c627966` |
| #step-5 | Ring spin to wrapper; pie/bar/wave census pass | done | `5a193deff` |
| #step-6 | Motion stations + will-change audit | pending | — |
| #step-7 | Collapse dormancy | pending | — |
| #step-8 | Residency app-test + inventory registration | pending | — |
| #step-9 | tuglaws doctrine | pending | — |
| #step-10 | Integration checkpoint | pending | — |

#### Step 1: Baseline profile + census helper + profiling recipe {#step-1}

**Commit:** `tugways(motion-residency): animation census helper and perf-resize-profile recipe`

**References:** [P09] Census enforcement, [P10] Profiling recipe, Spec S01, (#webkit-cost-model, #success-criteria)

**Artifacts:**
- `animationCensus()` in `tugdeck/src/lib/perf-monitor.ts`, exposed on `window.tugPerfMonitor`
- `just perf-resize-profile [app-name]` recipe (+ helper script if not inline)
- Baseline profile captures recorded in the commit message body (idle + resize, before any fix)

**Tasks:**
- [ ] Implement `animationCensus()`: filter `document.getAnimations()` to long-running per Spec S01 rule 1 — every non-`CSSTransition` `Animation`, WAAPI included; for each, capture animation name, target tag/class, keyframe property set (`effect.getKeyframes()`), `playState`, station ancestry; return `{ total, longRunning, violations: [...] }` with violation reasons.
- [ ] Write the profiling recipe per [P10]: resolve the app's WebContent pid (walk `pgrep -f com.apple.WebKit.WebContent` children against the target app's auxiliary processes; simplest reliable approach — `sample` each candidate briefly or match via `ps` ancestry), drive the paced AX resize, run `sample`, grep the output into the verdict summary. Include an `idle` mode (no resize).
- [ ] Run the recipe against the debug app twice (idle, resize); store both outputs under `/tmp` and summarize numbers in the commit body.

**Tests:**
- [ ] `cd tugdeck && bun x tsc --noEmit` (helper compiles; dev/test-only gating like the rest of perf-monitor)

**Checkpoint:**
- [ ] `just perf-resize-profile Tug-debug` prints a verdict with nonzero sample counts
- [ ] In the running debug app: `window.tugPerfMonitor.animationCensus()` returns a violations list that names the skeleton and/or pulsing dot when one is on screen (proving the detector sees the known offenders)
- [ ] `bunx vite build` passes

---

#### Step 2: Skeleton shimmer overlay {#step-2}

**Depends on:** #step-1

**Commit:** `tugways(motion-residency): skeleton shimmer via overlay opacity crossfade`

**References:** [P01] Residency contract, [P03] Skeleton overlay, Table T01, Risk R01, (#component-mechanics)

**Artifacts:**
- `tug-skeleton.css`: static base background; `::after` overlay animating `opacity`

**Tasks:**
- [ ] Replace `td-shimmer` background-color keyframes with an opacity keyframes block on `.tug-skeleton::after` (highlight color, `position: absolute; inset: 0`, `border-radius: inherit`, `pointer-events: none`), same 2s period and easing. `.tug-skeleton` is currently a plain div — it needs `position: relative` to become the overlay's containing block.
- [ ] Verify `--tugx-skeleton-highlight` is opaque in all six theme files (`tugdeck/styles/themes/*.css`); note any exception in the step.
- [ ] Confirm motion-off (`body[data-tug-motion="off"]`) still zeroes the shimmer.

**Tests:**
- [ ] Census in the running app: skeleton no longer appears in `animationCensus().violations`.

**Checkpoint:**
- [ ] Gallery skeleton card (`gallery-skeleton.tsx`) side-by-side vs. pre-change: indistinguishable shimmer
- [ ] `bunx vite build` passes

---

#### Step 3: Pulsing-dot thicken crossfade {#step-3}

**Depends on:** #step-1

**Commit:** `tugways(motion-residency): pulsing-dot ring thicken via stacked-stroke crossfade`

**References:** [P01] Residency contract, [P04] Dot thicken crossfade, [Q01] Thicken parity, Table T01, Risk R01, (#component-mechanics)

**Artifacts:**
- `tug-progress-pulsing-dot.tsx`: ring rendered as wrapper + two stroke spans
- `tug-progress-pulsing-dot.css`: `emit-thicken` border-width keyframes replaced by two opacity keyframes on the stroke layers

**Tasks:**
- [ ] Restructure the ring DOM: wrapper span carries `emit-expand` + `emit-fade` (and `ringRef` / `releaseEmitter` wiring, `data-emitting` gate); children carry static `border-width`s from `--…-pulse-birth-width` / `--…-pulse-end-width` and opacity keyframes on the thicken easing var.
- [ ] Preserve both size treatments' geometry (BIG_SIZE path and the sub-28px reach ramp in `sizeGeometry`).
- [ ] Preserve every state crossing: running→paused/stopped/completed/aborted arrivals must still cross, not cut (the component's docstring documents the contract; exercise all five states in the gallery).
- [ ] Confirm motion-off and `--tug-timing` scaling hold.

**Tests:**
- [ ] Census: pulsing dot absent from violations while running.

**Checkpoint:**
- [ ] [Q01] resolved: gallery timing bench side-by-side at 28px and 10px treatments — thicken gesture reads identically; if not, STOP and surface the [Q01] fallback to the user
- [ ] All five states + disabled visually verified in `gallery-tug-progress-indicator`
- [ ] `bunx vite build` passes

---

#### Step 4: Spinner HTML spokes {#step-4}

**Depends on:** #step-1

**Commit:** `tugways(motion-residency): spinner spokes as HTML elements`

**References:** [P01] Residency contract, [P05] Spinner HTML spokes, Table T01, Risk R01

**Artifacts:**
- `tug-progress-spinner.tsx`: 12 positioned `<span>` spokes replacing the SVG
- `tug-progress-spinner.css`: spoke geometry/placement rules; `fill` → `background-color`

**Tasks:**
- [ ] Port the viewBox-unit geometry (INNER 24 / OUTER 48 / WIDTH 9 on a 100-unit box) to percentage-based spans rotated about the box center; keep the per-spoke negative `animation-delay` stagger and the `--tugx-progress-spinner-cycle` clock.
- [ ] Keep all four state classes' behavior (`running/paused/completed/disabled`) byte-for-byte in semantics.

**Tests:**
- [ ] Census: spinner absent from violations while running.

**Checkpoint:**
- [ ] Gallery spinner rows (all sizes/roles/states) indistinguishable side-by-side
- [ ] `bunx vite build` passes

---

#### Step 5: Ring spin to wrapper; pie/bar/wave census pass {#step-5}

**Depends on:** #step-1

**Commit:** `tugways(motion-residency): ring spin on the HTML wrapper; census-verify pie, bar, wave`

**References:** [P01] Residency contract, [P06] Spin on wrapper, [Q02] SVG-root acceleration, Table T01

**Artifacts:**
- `tug-progress-ring.css`: spin + scoped `will-change` on the root span; SVG holds a static `-90deg` rotation

**Tasks:**
- [ ] Move the `tug-progress-ring-spin` animation from `.tug-progress-ring-svg` to the indeterminate root; preserve the start angle.
- [ ] Run `animationCensus()` with pie, bar, wave, marquee, session-changes-scanning, and sparkline on screen; confirm zero violations from them (Table T01 "OK" rows) and record the census output in the commit body.

**Tests:**
- [ ] Census: ring absent from violations while indeterminate.

**Checkpoint:**
- [ ] Gallery ring (determinate + indeterminate) indistinguishable; determinate arc transition (stroke-dashoffset) unaffected
- [ ] `bunx vite build` passes

---

#### Step 6: Motion stations + will-change audit {#step-6}

**Depends on:** #step-2, #step-3, #step-4, #step-5

**Commit:** `tugways(motion-residency): motion stations and will-change scoping`

**References:** [P02] Motion stations, [P07] will-change discipline, Spec S02, Risk R01, (#webkit-cost-model)

**Artifacts:**
- `.tugx-motion-station` CSS + wrappers in `TugProgressIndicator`, `TugSkeleton`, `TugSparkline`, `TugMarquee`
- Re-scoped/removed `will-change` at the audit targets named in [P07]

**Tasks:**
- [ ] Implement Spec S02; for the pulsing dot compute the station box from `sizeGeometry` reach so sub-28px overshoot is never clipped (Risk table row 2).
- [ ] Station the wave caret: add the station class + extent sizing to the root span `wave-caret.ts` builds (it bypasses `TugProgressIndicator`; see Spec S02) — verify caret alignment in the editor is unchanged.
- [ ] Audit all 16 `will-change` declarations (grep `will-change` under `tugdeck/src` + `tugdeck/styles`); leave the correctly-scoped ones, re-scope `tug-marquee-strip`, `tug-sparkline-track`, `tug-sheet` shade (verify unmount-at-rest first), gallery petals/pole.
- [ ] Verify no indicator consumer breaks on the station's `inline-block` wrapper (grep consumers of `TugProgressIndicator`, `TugSkeleton`, `TugSparkline`, `TugMarquee`; spot-check Lens session rows, block headers, Z2 status, prompt entry).

**Tests:**
- [ ] Census: every long-running animation now reports a station ancestor.

**Checkpoint:**
- [ ] Gallery + Lens + a live session card visually unchanged (especially small pulsing dots' ring overshoot)
- [ ] `bunx vite build` passes; `just app-test-changed` green

---

#### Step 7: Collapse dormancy {#step-7}

**Depends on:** #step-6

**Commit:** `tugways(motion-residency): pause long-run animations under collapsed panes`

**References:** [P08] Collapse dormancy, Spec S01 rule 6, (#component-mechanics)

**Artifacts:**
- `animation-play-state: var(--tugx-motion-play, running)` added to every long-run animation declaration (Table T01 rows)
- `.tug-pane-chrome--collapsed { --tugx-motion-play: paused; }` in `tug-pane.css`

**Tasks:**
- [ ] Add the var read to each loop rule; verify the explicit paused-state rules (e.g. `.tug-progress-spinner-paused`) still win where intended.
- [ ] Gotcha: the `animation:` shorthand **resets** `animation-play-state` — the var declaration must come *after* the shorthand within the same rule (or the shorthand must carry it), else the gate silently never applies.
- [ ] Manually verify collapse→expand of a pane with a running indicator shows a freeze/resume, not a cut or restart.

**Tests:**
- [ ] Behavioral assertion deferred to the census app-test (#step-8), which collapses a seeded pane and asserts non-running play states.

**Checkpoint:**
- [ ] In the running app: collapse a session card mid-turn; `document.getAnimations()` under its body reports no `running` infinite loops; expand resumes seamlessly
- [ ] `bunx vite build` passes

---

#### Step 8: Residency app-test + inventory registration {#step-8}

**Depends on:** #step-6, #step-7

**Commit:** `tugways(motion-residency): census app-test enforcing the residency contract`

**References:** [P09] Census enforcement, [P08] Collapse dormancy, Spec S01, Spec S02, (#test-plan-concepts)

**Artifacts:**
- `tests/app-test/at02XX-motion-residency.test.ts` (next free AT number; `at0284` was the highest at authoring time — confirm against `tuglaws/app-test-inventory.md`)
- Inventory registration + `@covers` lines (`tug-progress-indicator.tsx`, the six internal variant files, `tug-skeleton.tsx`, `tug-text-editor/wave-caret.ts`, `perf-monitor.ts`, `tug-pane.css`)

**Tasks:**
- [ ] Seed a pane with the `gallery-tug-progress-indicator` card (all variants/states mounted) and a skeleton surface; settle-wait; call `window.tugPerfMonitor.animationCensus()` via `evalJS`; assert the minimum-count floor first (`longRunning ≥` the seeded card's running-variant count — a vacuous-pass guard per [P09]), then assert zero violations.
- [ ] Collapse the seeded pane (drive the real collapse gesture or store call `togglePaneCollapse`), re-census, assert every long-running animation under it is not `running`; expand and assert they resume.
- [ ] Keep the test fast and exiting per app-test doctrine; use settle delays around the collapse gesture.

**Tests:**
- [ ] The test itself.

**Checkpoint:**
- [ ] `just app-test tests/app-test/at02XX-motion-residency.test.ts` passes
- [ ] `just app-test-covers-check` passes

---

#### Step 9: tuglaws doctrine {#step-9}

**Depends on:** #step-8

**Commit:** `tuglaws(motion-residency): the compositor-residency contract`

**References:** [P11] tuglaws doctrine, [P01] [P02] [P07] [P08], Spec S01, Spec S02, (#webkit-cost-model)

**Artifacts:**
- `tuglaws/motion-residency.md`; `design-decisions.md` entry; `component-authoring.md` cross-link

**Tasks:**
- [ ] Write the doc: the contract (Spec S01), the station (Spec S02), the WebKit cost model (#webkit-cost-model), the census test as the enforcement mechanism, the exemption for finite gesture motion, and the WAAPI asymmetry — `--tugx-motion-play` pauses CSS loops only; WAAPI loops need their own dormancy controller ([P08]).
- [ ] Add the global `[D##]` entry (next free number) and the component-authoring cross-link.

**Tests:**
- [ ] n/a (documentation)

**Checkpoint:**
- [ ] Doc review: a component author can determine from the doc alone whether a proposed animation is legal and how to station it

---

#### Step 10: Integration checkpoint {#step-10}

**Depends on:** #step-1, #step-2, #step-3, #step-4, #step-5, #step-6, #step-7, #step-8, #step-9

**Commit:** `N/A (verification only)`

**References:** (#success-criteria, #exit-criteria), [P10] Profiling recipe, Risk R02

**Tasks:**
- [ ] Re-run `just perf-resize-profile` (idle + resize) against a debug build with a session card mid-turn; compare against the step-1 baseline; record both in the session notes for the user.
- [ ] Verify the success criterion: no `applyKeyframeEffects` in the steady-state per-frame path.
- [ ] Full selective sweep: `just app-test-changed`.

**Tests:**
- [ ] Aggregate: census app-test + selective sweep green.

**Checkpoint:**
- [ ] `just app-test-changed` green; `bunx vite build` passes; profile delta reported to the user
- [ ] If resize still janks: record the top remaining frames and file the transcript-layer-depth follow-on (#roadmap) with those numbers

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** Every long-running animation in Tug runs compositor-resident inside a contained motion station, pauses under collapsed panes, and is guarded by a census app-test and a one-command profiling recipe — with the doctrine recorded in tuglaws.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] Census app-test green in the selective sweep (`just app-test-changed`)
- [ ] Zero `animationCensus()` violations with the full gallery + a live session on screen (manual check in the running app)
- [ ] Steady-state profile shows no per-frame `applyKeyframeEffects` / style-resolution loop (`just perf-resize-profile` idle mode)
- [ ] All re-plumbed surfaces visually indistinguishable (gallery side-by-sides done at each step)
- [ ] `bunx vite build` + `bun x tsc --noEmit` clean; tuglaws docs landed

**Acceptance tests:**
- [ ] `at02XX-motion-residency.test.ts` (census + collapse dormancy)
- [ ] `just app-test-changed` over the touched files

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] Transcript layer-depth reduction — only if the step-10 profile still shows resize jank; carry the recorded frames as evidence
- [ ] Occlusion-based dormancy for fully-covered panes
- [ ] DevPanel census tile (needs a cached/versioned snapshot per the perf-monitor docstring; census fn is already shared-ready)
- [ ] Imposed-card live *width* derivation during window resize (design question on `layout-imposer.ts`, separate from perf)

| Checkpoint | Verification |
|------------|--------------|
| Residency enforced | census app-test in CI sweep |
| Perf improved | step-1 vs step-10 `perf-resize-profile` delta |
| Look preserved | per-step gallery side-by-sides |
| Doctrine durable | `tuglaws/motion-residency.md` + `[D##]` entry |

---

## Addendum A — Attribution first, structure back in scope (2026-07-28) {#addendum-a}

**Why this addendum exists:** steps 1–5 landed and the profile did not move. Re-plumbing four animations off the main thread changed idle main-thread busy by less than run-to-run noise, and a deck seeded down to **zero cards** measured the same as a deck full of animating gallery variants. The cost the plan set out to remove is therefore **not attributable to the surfaces the plan re-plumbed**, and the remaining steps (stations, dormancy) rest on a cost model that the evidence no longer supports. This addendum records exactly where the work stands, what the numbers say, what the environment can and cannot verify, and the revised sequence: **get an instrument, attribute the cost, then remediate** — with layer-tree structure restored as a first-class avenue rather than a gated follow-on.

Everything above this line stands as authored except where a decision below supersedes it. Supersessions are named explicitly.

### Where the work stands {#a-state}

Dash worktree — **all work happens here, addressed by absolute path**:

| Field | Value |
|---|---|
| Worktree | `/Users/kocienda/Mounts/u/src/tugtool/.tug/worktrees/animation-tuneup` |
| Branch | `tugdash/animation-tuneup` (base `main`) |
| Dash name | `animation-tuneup` |
| Debug instance | `debug-tugdash-animation-tuneup` |
| Bundle id | `dev.tugtool.app.debug-tugdash-animation-tuneup` |
| Product name | `Tug-debug-tugdash-animation-tuneup` |

Landed commits (all verified in the worktree with `bunx tsc --noEmit` and `bunx vite build`):

| Step | Commit | Landed |
|---|---|---|
| #step-1 | `92f80410e` | `animationCensus()` in `perf-monitor.ts` (exposed as `window.tugPerfMonitor.animationCensus`, alongside `.snapshot`); `scripts/perf-resize-profile.sh` + `just perf-resize-profile`; baselines |
| #step-2 | `757bb04fb` | Skeleton shimmer as an `::after` opacity crossfade; motion-off gate in `tug.css` widened to `*::before` / `*::after` (`*` matches elements only, so a pseudo-element loop escaped it) |
| #step-3 | `cd9ee8916` | Pulsing-dot ring = wrapper + two stroke layers; thicken animates opacity |
| #step-4 | `43c627966` | Spinner spokes = 12 HTML spans (percent geometry, `transform-origin: 50% 200%`) |
| #step-5 | `5a193deff` | Ring spin moved to the root span; SVG holds a static `rotate(-90deg)` |

Steps 6–10 are **not** started. Their status is revised by [P14] below.

**A correction to the record:** during steps 2–4 the Bash shell's working directory had drifted to the **main checkout**, so some `tsc` / `vite build` runs and one skeleton A/B experiment executed against `main`'s tree rather than the worktree. The A/B was a no-op on unmodified files and proved nothing; the build checks were re-run in the worktree afterward and pass. No file in the main checkout was modified. See [P16] for the standing rule this produced.

### The measurement that changed the plan {#a-measurement}

All four runs: same machine, same debug instance, `idle` mode, 6s, window raised, minutes apart.

**Table T02: idle profiles across deck contents** {#t02-empty-deck}

| Deck contents | Busy / total | `updateRendering` | `updateCompositing…` | `computeCompositingRequirements` | `TreeResolver::resolve` | `applyKeyframeEffects` |
|---|---|---|---|---|---|---|
| Gallery indicator card (baseline, pre-fix) | 931 / 5213 (17.9%) | 889 (95%) | 154 (17%) | 135 (15%) | 171 (18%) | 58 (6%) |
| Gallery indicator card (after steps 2–5) | 933 / 5193 (18.0%) | 911 (98%) | 223 (24%) | 153 (16%) | 258 (28%) | 68 (7%) |
| One `gallery-skeleton` card | 892 / 5200 (17.2%) | 861 (97%) | 231 (26%) | 165 (18%) | 248 (28%) | 55 (6%) |
| **Zero cards** | 892 / 5177 (17.2%) | 856 (96%) | 190 (21%) | 143 (16%) | 235 (26%) | 62 (7%) |

Three readings follow, in decreasing confidence:

1. **The burn is not in the cards.** An empty deck costs what a full one costs. Whatever dirties style every frame lives in persistent chrome, or in the engine's own frame loop, not in `TugProgressIndicator` or `TugSkeleton`.
2. **The walk outweighs the blend.** `updateCompositingLayersAfterStyleChange` (21%) plus `computeCompositingRequirements` (16%) is three times `applyKeyframeEffects` (7%). Keyframe blending is the *trigger* that dirties style; the compositing walk is the *bill*. Removing every trigger only helps if no other trigger exists — and a window live-resize is a trigger by construction, every frame, forever.
3. **Therefore structure is not a follow-on.** The bill is `O(layer-tree size × depth)` per dirty frame. Capping it is the only thing that makes a *resize* smooth, because a resize dirties layout no matter how well-behaved every animation is.

### Superseded and revised decisions {#a-decisions}

#### [P12] The census app-test is an instrument first, a gate second (DECIDED) {#p12-instrument-first}

**Decision:** Build the residency app-test (#step-8's artifact) **now**, ahead of stations and dormancy, and treat its first job as diagnosis rather than enforcement. It runs against an **empty deck** as well as a seeded one, and it reports the full census (`entries`, not just `violations`) so the output names every animation the app runs at rest.

**Rationale:** the app-test harness is the only sanctioned path to `evalJS` (see [P15]), and `document.getAnimations()` is the only thing that can answer "what is animating in an empty deck". Every other route was tried and is closed.

**Implications:** #step-8's assertions about station ancestry ([P02]) and collapse pause ([P08]) cannot pass until those steps land — so the test is authored in two passes: the diagnostic census first (asserting only the vacuous-pass floor and reporting entries), the contract assertions once the remediation is known.

#### [P13] Layer-tree structure returns as a first-class avenue (SUPERSEDES the #non-goals entry and the #roadmap entry) (DECIDED) {#p13-structure-first-class}

**Decision:** "Reducing transcript layer depth" is no longer out of scope and no longer gated on a #step-10 profile. Structural cost is investigated on equal footing with animation residency, starting with measurement (#step-13) rather than with a proposed restructuring.

**Rationale:** Risk R02 fired. Its residual said the next suspect is layer depth if the profile still janks; the profile never improved at all, and the walk is the majority of the cost with zero cards on screen.

**Implications:**
- The plan's title promise ("motion residency") is now one half of the work; the other half is bounding what a dirty frame costs.
- [P02] motion stations remain correct but are re-motivated: `contain` bounds an animation's *extent*, and the same primitive applied to chrome subtrees bounds the *walk*. Their target list may change once #step-13 says where the depth is.
- Nothing is proposed here about *how* to restructure. That is #step-14's output, written against measured numbers.

#### [P14] Steps 6 and 7 are held pending attribution (DECIDED) {#p14-hold-6-7}

**Decision:** #step-6 (motion stations + `will-change` audit) and #step-7 (collapse dormancy) move to `held` in the ledger. Neither is withdrawn — both are defensible on their own terms — but both are re-scoped after #step-12 attributes the cost, because their current target lists were derived from the same model the measurement undermined.

**Rationale:** stationing the six indicator variants is cheap and correct, and it is also not obviously where the cost is. Doing it now would spend the next verification window proving nothing again.

#### [P15] What this environment can and cannot verify (DECIDED — a constraint, not a choice) {#p15-environment-limits}

**Decision:** record these as standing facts so a fresh session does not re-derive them.

- **No `evalJS` outside the app-test harness.** The in-app bridge (`TestHarnessBridge`, `tugapp/Sources/TestHarness/`) binds its Unix socket only when `TUGAPP_TEST_SOCKET` is set at launch, which only `just app-test` does. A normally-launched debug instance has no bridge, so `window.tugPerfMonitor.animationCensus()` is unreachable from the shell. Hand-rolling the `TUGAPP_*` launch is forbidden by project doctrine — go through `just app-test`.
- **No screenshots from the shell.** `screencapture` returns frames with all window content blanked (menu bar only) because the terminal lacks screen-recording permission. This is what blocked every gallery side-by-side. Visual verification must go through `app.screenshot()` inside an app-test, or the user's own eyes on the running build.
- **The window must be visible to measure.** macOS stops delivering frames to a fully occluded window and WebKit throttles with it: the same deck read 0.1% busy behind the terminal and 17.9% raised. `scripts/perf-resize-profile.sh` now raises the target window before sampling for exactly this reason. A flat-zero profile means "occluded", not "fixed".
- **HMR is live from the worktree.** The app auto-starts a Vite dev server for its own source tree (observed on `127.0.0.1:55270`). To confirm what the running app is actually serving: `curl -s "http://127.0.0.1:<port>/src/<path-to-module>"` and read the payload. Do this before trusting any before/after.

#### [P16] Absolute paths into the worktree, always (DECIDED) {#p16-absolute-paths}

**Decision:** every Bash invocation touching the tree uses an absolute path under the worktree. Never a bare `cd tugdeck`, never a relative `git checkout <path>`.

**Rationale:** the Bash tool's working directory persists across calls and was silently reset to the main checkout mid-run, which invalidated a set of verification results and pointed a `git checkout` at the wrong tree. The damage was nil by luck, not by design.

### New open questions {#a-open-questions}

#### [Q03] What animates in an empty deck? (OPEN — the central question) {#q03-empty-deck-animations}

**Question:** with zero cards, what does `document.getAnimations()` report, and which entries fail the residency contract?

**Why it matters:** it is the whole attribution. Until it is answered, no remediation can be aimed.

**Candidates to check first** (persistent chrome, none yet examined): the Lens rail and its `--tugx-lens-rail` registered property; the deck canvas / imposer settle machinery (`deck-canvas.tsx` arms `data-imposer-settling` from a store subscriber); the window chrome's connection/status affordances; the tugcast connection indicator; any always-mounted sparkline or pulse-line surface; `tug-sheet` shade elements that may be mounted at rest (flagged in [P07] as needing an unmount-at-rest check).

**Plan to resolve:** #step-11 and #step-12.

#### [Q04] Did the empty-deck measurement actually measure an empty deck? (OPEN — verify before building on T02) {#q04-empty-deck-validity}

**Question:** the zero-card layout was written straight into tugbank and applied with `tugutil host tell reload`. The resulting numbers were *identical* to the seeded runs, which is either the finding itself or evidence that the reload did not take.

**Why it matters:** the entire addendum rests on T02's last row.

**Plan to resolve:** re-run the isolation inside the app-test harness, where the deck's contents are seeded by the harness and can be asserted (count the mounted cards via `evalJS` in the same run as the census). This is the first assertion #step-11 should make. Do not build remediation on T02 until it holds.

**Reproduction of the seeding used** (for the record, and to retry): write the layout, then reload.

```
tugbank --instance debug-tugdash-animation-tuneup write dev.tugtool.deck.layout layout "$(cat layout.json)" --type json
tugutil host tell reload --instance debug-tugdash-animation-tuneup
tugutil host tell show-card -p component=<componentId> --instance debug-tugdash-animation-tuneup
```

#### [Q05] Do `var()`-bearing keyframes block compositor acceleration in WebKit? (OPEN — strong hypothesis, unverified) {#q05-var-keyframes}

**Question:** several of Tug's loops interpolate values that are `var()` references rather than literals — the pulsing dot's `breathe` and `emit-expand` keyframes hold `scale(var(--tugx-progress-pulsing-dot-dot-scale-min, …))`, and durations are `calc(… * var(--tug-timing, 1))` throughout. If WebKit declines to accelerate a keyframe effect whose values depend on custom properties (as it must, since a custom property can change at any time and is resolved during style), then those loops were **never** accelerated and never could be — and no amount of re-plumbing the animated *property* fixes them.

**Why it matters:** it would explain steps 3–5 producing no delta, it applies to nearly every loop in the codebase, and it would add a clause to Spec S01 that changes how every future animation is authored (literal keyframes; parameterize by swapping the animation, not by `var()` inside it).

**Plan to resolve:** #step-12 — the census reports each entry's keyframe values, so a `var()`-bearing effect is visible in the output; confirm with a one-variable A/B in the running app (literalize the dot's keyframes, re-profile) and, if it holds, grep WebKit's behavior rather than guessing at the mechanism.

**[Q01] remains OPEN** (#q01-thicken-parity): the stacked-stroke thicken shipped in `cd9ee8916` has never been seen. Per [P15] it cannot be judged from this environment; it needs the user's eyes on the running build, or an `app.screenshot()` comparison inside an app-test.

### Revised execution steps {#a-execution-steps}

#### Revised Step Status Ledger {#a-step-status-ledger}

> **Stale.** Superseded by #c-step-status-ledger.

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Baseline profile + census helper + profiling recipe | done | `92f80410e` |
| #step-2 | Skeleton shimmer overlay | done | `757bb04fb` |
| #step-3 | Pulsing-dot thicken crossfade | done (Q01 open) | `cd9ee8916` |
| #step-4 | Spinner HTML spokes | done | `43c627966` |
| #step-5 | Ring spin to wrapper; pie/bar/wave census pass | done | `5a193deff` |
| #step-11 | Census app-test as diagnostic instrument | done | `838704d6a` |
| #step-12 | Attribute the idle burn | done | `9df8c4425` |
| #step-13 | Layer-tree structural probe | done | `d23e8ef70` |
| #step-14 | Revised remediation plan | done | `14fb1b0e5` |
| #step-6 | Motion stations + will-change audit | held ([P14]) | — |
| #step-7 | Collapse dormancy | held ([P14]) | — |
| #step-8 | Residency app-test (contract assertions) | folded into #step-11 / re-opened after #step-14 | — |
| #step-9 | tuglaws doctrine | pending (rewrite after #step-14) | — |
| #step-10 | Integration checkpoint | pending | — |

#### Step 11: Census app-test as diagnostic instrument {#step-11}

**Depends on:** #step-1

**Commit:** `tugways(motion-residency): census app-test reporting every running animation`

**References:** [P12], [P09], [Q03], [Q04], Spec S01, (#a-measurement)

**Artifacts:**
- `tests/app-test/at02XX-motion-residency.test.ts` (next free AT number per `tuglaws/app-test-inventory.md`; `at0284` was highest at authoring time)
- Registration in `tuglaws/app-test-inventory.md` with `@covers` lines (`perf-monitor.ts`, `tug-progress-indicator.tsx`, the internal variant files, `tug-skeleton.tsx`, `tug-text-editor/wave-caret.ts`, `tug-pane.css`)

**Tasks:**
- [ ] Launch with **no cards** and assert the deck really is empty (`evalJS` a count of mounted card roots) — this discharges [Q04] properly, in a harness that controls the deck instead of writing tugbank behind the app's back.
- [ ] Call `window.tugPerfMonitor.animationCensus()` and print the **full** `entries` array (name, kind, target, properties, playState, stationed, svgTarget) into the test output. Diagnosis is the deliverable; assertions come later.
- [ ] Repeat with the `gallery-tug-progress-indicator` card seeded, so the two censuses subtract.
- [ ] Assert only what is safe today: the vacuous-pass floor (seeded run discovers ≥ the card's running-variant count) and that the census call itself works.
- [ ] Keep it fast and exiting per app-test doctrine.

**Tests:** the test itself.

**Checkpoint:**
- [x] `just app-test tests/app-test/at0288-motion-residency.test.ts` passes and its output **names every animation running in an empty deck**
- [x] `just app-test-covers-check` passes

**Result — the empty deck runs nothing** {#a-census-result}

`tests/app-test/at0288-motion-residency.test.ts`, one launch, two decks:

| Deck | Card hosts | `getAnimations()` total | Long-running | In violation |
|---|---|---|---|---|
| Empty (asserted) | 0 | **0** | 0 | 0 |
| `gallery-tug-progress-indicator` | 1 | 161 | 161 | 161 |

Two things fall out of the first row, and one out of the second.

- **[Q03] is answered, and the answer is "nothing".** With zero cards mounted, `document.getAnimations()` returns an empty list — not a short list of chrome loops. The candidate list in [Q03] (Lens rail, imposer settle, connection affordances, sparkline, sheet shade) is empty of animations at rest. Whatever costs 17.2% in an idle empty-deck profile is **not an animation**, so no residency work can reach it. #step-12's fourth task is now its only task.
- **[Q04] resolves against T02's last row.** The profiled "zero cards" deck showed `applyKeyframeEffects` at 62 samples (7%). A genuinely empty deck has no keyframe effects to apply. So the tugbank-written layout plus `host tell reload` did **not** empty the deck — T02's last row measured a deck that still had cards in it, and its agreement with the seeded rows is an artifact, not a finding. The *first three* rows of T02 stand; the conclusion drawn from the fourth ("an empty deck costs what a full one costs") is withdrawn pending a re-measurement with the deck emptied through the app.
- **Steps 2–5 did their job, on their own terms.** All 161 seeded violations are the single reason `no .tugx-motion-station ancestor` — which is #step-6, held. Zero entries animate a non-accelerable property, zero target an SVG element, zero share a box with a demoting neighbour. The shapes the plan set out to fix are fixed; the profile not moving is a separate fact about what the profile was measuring.

---

#### Step 12: Attribute the idle burn {#step-12}

**Depends on:** #step-11

**Commit:** `tugways(motion-residency): <what the attribution turned out to be>` (or none — this step may be investigation only)

**References:** [Q03], [Q05], (#a-measurement), (#webkit-cost-model)

**Tasks:**
- [ ] Take the empty-deck census from #step-11 and, for each entry, decide: is it a residency violation, an accelerated loop that still forces per-frame compositing updates, or something the contract does not cover?
- [ ] Test [Q05]: literalize one loop's `var()`-bearing keyframes in the running app (HMR), re-profile, and compare. A delta confirms the hypothesis and promotes it to a Spec S01 clause.
- [ ] For each attributed source, record its cost with a `perf-resize-profile` A/B — one variable at a time, confirming via `curl` on the dev server that the running app has the change ([P15]).
- [ ] If the census reports **nothing** running in an empty deck, the trigger is not an animation: profile with the dev-log and `PerformanceObserver` to find what dirties style per frame (candidates: a `requestAnimationFrame` loop, a store notifying on a timer, a `ResizeObserver` feedback cycle, the imposer's settle subscriber).

**Checkpoint:**
- [x] The idle burn is attributed to named sources with per-source numbers, written into this document as Table T03

**Result — the burn is the gallery card, and it scales with the number of running loops** {#a-attribution}

Every row below is a 6s `just perf-resize-profile idle` on `debug-tugdash-animation-tuneup`, same window (1590×1028), raised, minutes apart, with the deck's contents confirmed in the app's own persisted layout before sampling.

**Table T03: idle cost by deck contents and by one-variable A/B** {#t03-attribution}

| Deck / variable | Busy / total | `updateRendering` | `updateCompositing…` | `computeCompositingReq…` | `TreeResolver::resolve` | `applyKeyframeEffects` |
|---|---|---|---|---|---|---|
| Empty (0 cards, 0 animations) | **1 / 4785 (0.0%)** | 0 | 0 | 0 | 0 | 0 |
| `lens` only | **8 / 4765 (0.2%)** | 0 | 0 | 0 | 0 | 0 |
| `gallery-skeleton` only | **11 / 4772 (0.2%)** | 8 | 0 | 0 | 4 | 1 |
| `gallery-tug-progress-indicator` only | **926 / 4712 (19.7%)** | 894 | 333 | 204 | 270 | 69 |
| …with `var()` keyframes literalized | 947 / 4702 (20.1%) | 926 | 351 | 221 | 268 | 72 |
| …with `will-change` removed | 934 / 4713 (19.8%) | 902 | 337 | 202 | 276 | 76 |
| …with every pulsing-dot loop silenced | **504 / 4726 (10.7%)** | 473 | 253 | 179 | 41 | 9 |

What this establishes, and what it retires:

- **T02 is retired in full.** Its four rows were all measured against the same never-emptied four-card deck (`lens` + `gallery-tug-progress-indicator` + two `gallery-skeleton`), which is why they agreed with each other to within noise. The mechanism is now known and it is not the one first suspected: **`tugutil host tell reload` persists the live deck before it reloads**, so any layout written into tugbank beforehand is overwritten by the app's own save on the way out and the reload restores what was already on screen. Writing `dev.tugtool.deck.layout` and reloading is therefore a no-op *by construction*, whatever the layout says — verified directly by writing a one-card layout, reading it back intact, reloading, and reading back the pre-existing deck. The route that does change a live deck is the app's own actions: `tugutil host tell close-all` (repeat until the panes are gone) and `tugutil host tell show-card`.
- **Nothing costs anything at rest except the indicator gallery.** An empty deck, a Lens, and a card full of skeletons are all within noise of zero. The plan's premise — that Tug burns CPU while idle — is true of exactly one surface, and that surface is a stress bench showing 161 concurrent loops, not a thing a user sits in front of.
- **[Q05] is REFUTED.** Literalizing the pulsing dot's `var()`-bearing `transform` keyframes moved the profile by less than run-to-run noise (19.7% → 20.1%). Custom properties in keyframe values do not block acceleration in this WebKit, and nothing in Spec S01 needs a clause about them.
- **`will-change` is not the lever either.** Removing it from the dot's animating rule changed nothing (19.7% → 19.8%) — the `translate3d` poses already promote those elements, so the hint was redundant rather than load-bearing.
- **Cost scales with the count of concurrently running loops.** Silencing the pulsing dots — about 110 of the card's 161 animations — halved the burn (19.7% → 10.7%) and collapsed style resolution with it (`TreeResolver::resolve` 270 → 41, `applyKeyframeEffects` 69 → 9). The remaining ~50 loops carry the remaining 10.7%. There is no single villain to fix; the bill is per-running-animation, and it is the same bill whether or not the animation is accelerable-shaped.
- **The walk outlives the blend.** With the dots silenced, `updateCompositingLayersAfterStyleChange` fell only 333 → 253 while style resolution fell by 85%. The compositing walk is not proportional to the animations the way style resolution is — it is proportional to the layer tree those animations promote, and it is the half that #step-13 measures.
- **Steps 2–5 were correct and are now measurable.** `gallery-skeleton` at 0.2% is what step 2's overlay crossfade bought; the earlier "one skeleton card, 17.2%" reading was the stale deck, not the skeletons.

**A tooling caveat for anyone repeating this** {#a-deck-verification}

Two traps, both of which cost this investigation a wrong conclusion before they were understood.

- **The persisted layout lags the live deck.** `dev.tugtool.deck.layout` is written on a long debounce, so reading it back seconds after a `host tell show-card` reports the *previous* contents. Two `show-card` calls that looked like no-ops turned out to have both applied, and only surfaced after a reload.
- **Writing the layout and reloading cannot seed a deck.** `host tell reload` saves the live deck on the way out, clobbering the write. There is no shell-side route that sets deck contents directly.

So deck contents are controlled by the app's own actions (`close-all`, `show-card`) and confirmed either by a `tugbank read` taken *well* after the change has settled, or — properly — inside the app-test harness, which seeds and asserts the deck in the same run. Add this to [P15]'s list of what this environment cannot do.

---

#### Step 13: Layer-tree structural probe {#step-13}

**Depends on:** #step-11

**Commit:** `tugways(motion-residency): layer-tree structural probe`

**References:** [P13], [P02], (#webkit-cost-model), Risk R02

**Tasks:**
- [ ] Add a `layerTreeProbe()` beside `animationCensus()` in `perf-monitor.ts`: DOM depth distribution, count of stacking contexts, count of elements with a standing `will-change`, count of elements carrying `contain`, and the deepest chain of stacking contexts with its selector path.
- [ ] Run it against an empty deck, a one-card deck, and a full session deck; record the shape.
- [ ] Correlate with the sample: `computeCompositingRequirements` / `calculateClipRects` / `accumulateOffsetTowardsAncestor` sample counts against measured depth.
- [ ] Identify which ancestors already bound the walk (`.tug-pane-chrome` has `overflow: clip; isolation: isolate`) and where a `contain` boundary would cut the deepest chains.

**Checkpoint:**
- [x] Depth and layer counts are numbers in this document, not adjectives — Table T04
- [x] At least one candidate containment boundary is identified with the sample-count reduction it would plausibly buy — two were tried, and both bought nothing

**Result — the tree is shallow and containment buys nothing** {#a-structure}

`layerTreeProbe()` (in `perf-monitor.ts`, beside `animationCensus()`, exposed as `window.tugPerfMonitor.layerTreeProbe`) walks every element, reads its computed style, and reports depth, stacking contexts, standing `will-change`, containment boundaries, and the deepest nested stacking chain with its selector path. `at0288` reads it against the same two decks it censuses.

**Table T04: the structure a dirty frame walks** {#t04-layer-tree}

| Deck | Elements | Max depth | Mean depth | Stacking contexts | Deepest chain | `will-change` | `contain` |
|---|---|---|---|---|---|---|---|
| Empty | 32 | 8 | 4.6 | 5 | 2 | 0 | 0 |
| `gallery-tug-progress-indicator` | 1016 | 21 | 16.7 | 254 | **5** | 127 | **0** |

Depth histogram for the seeded deck: `{"0-9": 50, "10-19": 735, "20-29": 231}`. Deepest stacking chain: `html > div.tug-pane > div.tug-pane-chrome > span.tug-progress-ring.tug-progress-ring-indeterminate > svg.tug-progress-ring-svg`.

**Table T05: containment A/Bs against the 19.7% baseline** {#t05-containment}

| Variable | Busy / total | `updateCompositing…` | `computeCompositingReq…` |
|---|---|---|---|
| Baseline (`gallery-tug-progress-indicator`) | 927 / 4713 (19.7%) | 318 | 183 |
| `contain: layout paint` on `.tug-progress-indicator` (one per glyph) | 905 / 4708 (19.2%) | 309 | 198 |
| `contain: layout paint` on `[data-card-host]` (one per card) | 903 / 4718 (19.1%) | 345 | 193 |

**[P13] does not survive its own measurement.** The layer tree is not deep and it does not branch deeply: 21 elements at the very bottom, a mean of 16.7, and a *deepest nested stacking chain of five*. A recursion five frames deep over a thousand elements is not where 19.7% of a core goes. Both containment boundaries — one fine-grained (254 of them, one per glyph), one coarse (one per card, the whole subtree) — moved the profile by half a point, which is inside the run-to-run spread of the baseline itself. Structure is not a co-equal cost driver, and "reduce transcript layer depth" should go back to being out of scope until some *measured* surface says otherwise.

What the numbers do say is that the walk's cost tracks the **breadth** of composited content, not the depth of the tree: 254 stacking contexts and 127 standing `will-change` hints on one card, essentially all of them created by the animating glyphs themselves. That is the same quantity #step-12 found the burn scaling with, seen from the other side — which is why silencing the loops cut style resolution by 85% but the compositing walk by only 24%. The layers outlive the animation that promoted them.

Two smaller findings worth keeping:

- **Nothing in the deck uses containment at all** (`contain: 0` on both decks). That is a genuine gap in the codebase, just not one that pays here.
- **`translate3d(x, y, 0)` does not read as a 3D transform.** The probe counts zero `matrix3d` computed transforms on a deck full of `translate3d` poses — a zero `z` normalizes to a 2D matrix in computed style. Whether WebKit still promotes internally is not observable from script, so the pulsing dot's docstring claim that its `translate3d` "gets the element a layer of its own" is unverified rather than wrong. The `will-change` A/B in T03 is the relevant evidence: removing the hint changed nothing, which is consistent with the element already being promoted by something.

---

#### Step 14: Revised remediation plan {#step-14}

**Depends on:** #step-12, #step-13

**Commit:** `tugways(motion-residency): remediation plan revised against measured attribution`

**Tasks:**
- [ ] Write Addendum B: what the cost actually is, split between trigger-side (what dirties style) and bill-side (what a dirty frame costs).
- [ ] Re-scope #step-6 and #step-7 against the attribution — keep, re-target, or withdraw each with a reason.
- [ ] Propose the structural work as concrete steps with falsifiable checkpoints, sized by [P13]'s numbers.
- [ ] Restate the phase's #success-criteria in terms that the empty-deck measurement can falsify (the current criteria could all pass while the app still janks).
- [ ] Re-open #step-8's contract assertions and #step-9's doctrine against the revised model.

**Checkpoint:**
- [x] A fresh session can implement the remediation from Addendum B alone

---

### Resuming from here {#a-resume}

A session picking this up cold should, in order: read #a-state and #a-measurement; re-read [P15] before attempting any verification; start at #addendum-b, which supersedes everything above it. The dash already exists — `tugutil dash create animation-tuneup` is idempotent and returns the worktree path. The plan file being edited is the **worktree copy**; never write to the base checkout.

---

## Addendum B — What the cost actually is (2026-07-28) {#addendum-b}

Steps 11–13 replaced every number this plan was built on. Addendum A's three readings are all retired: the burn *is* in the cards, the walk does *not* outweigh the blend on any surface that matters, and structure is *not* a co-equal cost driver. This addendum states what the measurements support, re-scopes the held steps against them, and gives the remaining work as steps with checkpoints that can fail.

Where a statement here contradicts the body or Addendum A, this addendum wins — **except where [Addendum C](#addendum-c) contradicts this one, which it does on the central point.** B's cost model ("cost is linear in the number of loops running; nothing about how an individual animation is written changes its cost") is false, and the paragraph below is retained only as the record of a wrong reading. See [P21].

### The cost, in one paragraph {#b-the-cost}

**Tug does not burn CPU at idle on any surface a user sits in front of.** An empty deck: 0.0% busy and zero animations. A Lens: 0.2%. A card full of skeletons: 0.2%. The only expensive surface in the app is `gallery-tug-progress-indicator` — the *bench* that renders 161 concurrent loops so a developer can compare six variants across five states and ten sizes at once — and it costs 19.7%. That cost is roughly linear in the number of animations running: silencing the ~110 pulsing-dot loops took it to 10.7%. It is not caused by any of the things this plan assumed. Not by non-accelerable properties (there are none left after steps 2–5). Not by `var()` in keyframes ([Q05], refuted by A/B). Not by missing or excess `will-change` (removing it changed nothing). Not by tree depth (mean 16.7, deepest nested stacking chain 5). Not by missing containment (two A/Bs, both inside noise).

### Trigger and bill {#b-trigger-and-bill}

The split Addendum A proposed is real, but the proportions are the other way around and both halves scale with the same quantity — **how many loops are running right now**, not how they are authored.

- **Trigger — style resolution.** Tracks the running-animation count almost exactly. Silencing 110 of 161 loops cut `TreeResolver::resolve` from 270 samples to 41 (-85%) and `applyKeyframeEffects` from 69 to 9 (-87%).
- **Bill — the compositing walk.** Tracks the *composited breadth* those animations promote, and outlives them: the same silencing cut `updateCompositingLayersAfterStyleChange` only 333 → 253 (-24%). The layers persist after the animation that created them stops. This is why containment at either granularity bought nothing — containment bounds a subtree's *extent*, and the walk here is wide, not deep.

The single lever both halves respond to is therefore **how many animations are running at once**. Nothing about how an individual animation is written changes its cost once it is already accelerable-shaped.

### Re-scoped decisions {#b-decisions}

#### [P17] The station rule is withdrawn from the contract (SUPERSEDES [P02] and Spec S01's station clause) (DECIDED) {#p17-stations-withdrawn}

**Decision:** `.tugx-motion-station` is removed from the residency contract. `animationCensus()` stops emitting `no .tugx-motion-station ancestor` as a violation, and Spec S01 loses that rule. #step-6 is **withdrawn**, not held.

**Rationale:** the rule was justified by a cost model that measured false. Containment was tried at both the granularity stations would have used (per-glyph, 254 boundaries) and a coarser one (per-card), and neither moved the profile. Meanwhile the rule dominates the census output — all 161 seeded entries are "violations" for this reason and this reason only — which makes the violation list useless as a signal. A contract clause with no measured backing that also drowns out the clauses that do have backing is worse than no clause.

**Implications:** after this lands, a non-empty `census.violations` means something again: a property that cannot be accelerated, an SVG target, or a demoting neighbour in the same box. That is exactly the set steps 2–5 fixed, so the assertion "zero violations" becomes a true regression gate rather than a vacuous one.

#### [P18] The `will-change` audit inverts: remove hints, do not add them (DECIDED) {#p18-will-change-inverts}

**Decision:** the surviving half of #step-6 is a sweep to *delete* standing `will-change` declarations that buy nothing, not to add them to surfaces that lack them.

**Rationale:** the seeded gallery carries 127 standing `will-change` hints. Removing the pulsing dot's changed the profile by 0.1 points. Each hint is a promise to the engine to keep a layer around, and the bill above is proportional to composited breadth — so a hint that does not demonstrably help is a hint that costs.

**Method:** one A/B per hint, on the surface that actually carries it, against a profile taken minutes apart on the same window. A hint survives only if removing it measurably hurts.

#### [P19] Dormancy is the only remediation the measurement supports (SUPERSEDES [P14]'s hold on #step-7) (DECIDED) {#p19-dormancy-only}

**Decision:** #step-7 comes off hold and becomes the phase's remaining substantive work, broadened past collapsed panes: an animation nobody can see should not run, whether it is hidden by a collapsed pane, a background tab, a scrolled-away region, or an occluded window.

**Rationale:** cost is linear in concurrently-running loops. Not running the invisible ones is the only lever with a measured slope behind it. It is also the lever that would have made the gallery bench cheap without changing a single glyph.

**Scope note:** WebKit already throttles a fully occluded *window* (the 0.1% vs 17.9% reading in [P15]), so the window case is free. What is not free is in-page invisibility, which the engine does not know about.

#### [P20] The phase's problem statement did not survive (DECIDED — the honest reading) {#p20-premise-retired}

**Decision:** record plainly that the phase set out to fix an idle burn that no user-facing surface exhibits. The re-plumbs in steps 2–5 are still correct work and still land; the enforcement and dormancy work below is still worth doing as a guardrail. But the plan should not continue to describe itself as fixing a present-tense performance problem.

**Rationale:** every idle profile that motivated this plan was taken against a deck that had the gallery bench open, and the deck could not be emptied by the route being used to try (see #a-deck-verification). The bench is a developer surface. Whether the remaining steps are worth the time is a call for the user to make with these numbers in hand, not a foregone conclusion.

### Revised success criteria {#b-success-criteria}

These SUPERSEDE #success-criteria. Each one can fail.

1. `at0288`'s empty-deck census reports **zero** animations and its layer probe reports a non-empty tree. (Holds today.)
2. `at0288`'s seeded-deck census reports **zero** violations once [P17] lands. (Fails today: 161, all for the withdrawn rule.)
3. A deck showing `gallery-tug-progress-indicator` in a **collapsed** pane censuses zero *running* animations — every loop `paused` or absent. (Fails today: dormancy is unimplemented.)
4. An idle profile of any single non-gallery card stays under 1% main-thread busy. (Holds today: lens 0.2%, skeleton gallery 0.2%.)
5. The idle profile of a deck showing the indicator gallery with its pane collapsed is within noise of an empty deck. (Fails today; this is criterion 3 measured rather than asserted.)


### Remaining execution steps {#b-execution-steps}

**Superseded.** Addendum B's steps 15–18 were written before the acceleration finding and are replaced wholesale by #c-execution-steps. The step numbers were reassigned in that rewrite (the old 16/17/18 shifted to 17/18/19 to make room for the per-variant sweep); nothing had been implemented against the old numbering, so no commit refers to it.

---

## Addendum C — Acceleration is provable (2026-07-28) {#addendum-c}

Addendum B concluded that cost is linear in the number of animations running, that nothing about how an individual animation is *written* changes its cost once it is accelerable-shaped, and that dormancy was therefore the only lever with a slope behind it. **All three statements are false**, and the measurement that disproves them also fixed the app's most expensive surface.

Where this addendum contradicts Addendum B, the body, or Addendum A, this addendum wins.

### The finding {#c-finding}

**A multi-stop CSS `linear()` easing blocks compositor acceleration in WebKit entirely.**

Core Animation expresses a keyframe segment's timing as a cubic Bézier. That is the only shape the compositor's timing model has. A `linear(0, 0.0381, 0.1464, …)` with fourteen to twenty-one stops is not a cubic Bézier and cannot be expressed as one, so WebKit does not accelerate the animation *at all*. It falls back to resolving style and blending the animated value on the main thread, every frame, for every element carrying it. The animation still animates and still looks correct — there is no visual tell, no console warning, and no DevTools badge. It just costs main thread instead of costing nothing.

The pulsing dot carried its entire motion design in three such easings, sampled from cosine legs and a cubic ease-out by `cssEasing()` in `tugdeck/src/lib/unit-functions.ts` and held in `--…-ease` custom properties over two-stop `@keyframes`. Every running dot in the app was blended by hand.

**The fix preserves the curve exactly.** Move the shape out of the easing and into the keyframe stops: sample the same unit functions at ~40 offsets, emit them as `@keyframes` percentages, and let the segments interpolate `linear`. Same curve by construction — the stops *are* samples of the same functions the easing was sampled from — and Core Animation runs it natively. This shipped in `3e24f00d2`; `breathKeyframes(turn, prefix)` in `tugdeck/src/components/tugways/internal/tug-progress-pulsing-dot.tsx` is the generator.

### The ladder {#c-ladder}

**Table T05 — 100 running pulsing dots, `gallery-motion-bench`, `just perf-resize-profile idle 6`.** "busy" is total samples minus `mach_msg2_trap`; the other two columns are sample counts for `WebCore::Style::TreeResolver::resolve` and `WebCore::Style::applyKeyframeEffects`.

| configuration | busy | TreeResolver | applyKeyframeEffects |
|---|---|---|---|
| shipped — `linear()` easings, 6 boxes per glyph | **28.0%** | 518 | 159 |
| `linear()` → `ease-in-out` (curve wrong, diagnostic only) | 19.2% | 319 | 86 |
| + literal duration/delay, no `calc(var())` | 18.9% | — | — |
| + literal keyframe values, no `var()` | 19.0% | 336 | 98 |
| + every animation `paused` (nothing moves at all) | 17.1% | 394 | 103 |
| 1 element + 2 pseudo-elements instead of 3 elements | 36.3% | 1151 | — |
| 3 elements, `will-change` deleted | 24.2% | 512 | 119 |
| + `translate3d(…, 0)` → `translate(…)` | 18.0% | 411 | 101 |
| + `linear()` → the `linear` keyword (curve wrong, diagnostic only) | **0.9%** | 20 | 2 |
| **shape moved into ~40 keyframe stops, full envelope restored** | **1.5%** | 23 | 4 |

**28.0% → 1.5% with the animation numerically unchanged.** `at0274` seeks the real running animation and asserts the same envelope it asserted before: peak at the turn, sinking at the midpoint and at 70%, ring dark through the inhale, near-solid at ignition, gone by cycle end. It passes on both sides of the change.

### What the ladder also settles {#c-corollaries}

- **`var()` in keyframe values does not block acceleration.** Proven twice — 18.9% → 19.0% while still blocked, and 1.5% vs 0.9% after the fix (the 0.6 points are the extra stops, not the variables). This closes **[Q05]** for good, in the same direction Addendum B closed it but with a mechanism attached. Size-derived knobs survive.
- **Animating pseudo-elements is more expensive than animating elements**, in WebKit, at parity: 24.2% for three elements against 36.3% for one element plus two pseudo-elements, with `TreeResolver::resolve` more than doubling to 1151. The intuition that a pseudo-element is cheaper than a box is wrong here.
- **`translate3d(…, 0)` forced-layer promotion is a cost, not a win**: 24.2% → 18.0% removing it, with `computeCompositingRequirements` falling 415 → 184. This is [P18]'s direction, now with a measured slope.
- **`applyKeyframeEffects` is not an acceleration tell.** It held near 100 samples with *every animation paused*. It measures style resolution walking effect stacks, not blending. Addendum B's trigger/bill split read it as the former; that reading was wrong.
- **SVG is not an escape hatch.** SVG interior elements can never hold a compositing layer in WebKit, so SVG motion is always main-thread. Spec S01 clause 3 already says this; it is restated because it is the natural next guess after "make the DOM simpler."

### Refuted, by name {#c-refuted}

Each of these was tested against the bench and moved the number by less than the run-to-run noise, or moved it the wrong way. They are listed so nobody re-derives them.

- **The rounded clip.** `.tug-pane` carries `border-radius: var(--tug-radius-md)` + `overflow: clip`. Portalling the identical population to `<body>` with `position: fixed`, out of every card ancestor, measured 25.0% against 24.2% in-card. Card corners do not break the compositing pipeline.
- **`will-change`.** Inert on this surface in both directions.
- **Containment.** Two granularities, both inside noise (Addendum B, #b-trigger-and-bill).
- **`calc(var())` in durations and delays.** 19.2% → 18.9%, inside noise.
- **Tree depth.** Mean 16.7, deepest nested stacking chain 5.
- **Element count as the dominant term.** Cutting six boxes per glyph to four helped ~14% while the easing bug was live; it is a second-order term.

### Re-scoped decisions {#c-decisions}

#### [P21] The cost model, corrected (SUPERSEDES [P19]'s premise and #b-trigger-and-bill) (DECIDED) {#p21-cost-model-corrected}

**Decision:** cost is linear in the number of loops WebKit is **blending on the main thread**, not in the number of loops running. An accelerated loop is very nearly free — 100 of them, four boxes each, cost 1.5%.

**Rationale:** Addendum B measured its slope by silencing 110 of 161 loops on a surface where *every* loop was main-thread-blended, so "running" and "main-thread-blended" were the same set and the data could not tell them apart. Table T05 separates them: the same population, same count, same visual output, differs by a factor of eighteen depending only on whether the compositor will take it.

**Implication:** "how many animations are on screen" is the wrong question to design around. "Is each one shaped so the compositor will take it" is the right one, and unlike the first it is checkable from script.

#### [P22] Acceleration becomes a census rule, not a convention (DECIDED — ADDS clause 9 to Spec S01) {#p22-easing-is-a-census-rule}

**Decision:** `animationCensus()` gains a violation for a timing function the compositor cannot express. Spec S01 gains: *a long-running animation's timing function — at the animation level and at every keyframe — MUST be expressible as a cubic Bézier: the `linear` keyword, `ease`/`ease-in`/`ease-out`/`ease-in-out`, or `cubic-bezier(…)`. A `linear()` with more than two stops MUST NOT appear on a long-running animation.*

**Rationale:** this is the single highest-value thing the census can check, it is the bug that actually cost the app, and it is invisible to every other form of review — the animation looks right, typechecks, and passes its behavioral test. It is exactly the class of defect a machine gate exists for.

**Mechanism:** `KeyframeEffect.getTiming().easing` gives the animation-level easing as a serialized string; `effect.getKeyframes()[i].easing` gives each segment's. Both are already reachable in `animationCensus()` — `getTiming()` is called there today for `iterations`/`duration`, and `easing` is already in `KEYFRAME_METADATA_KEYS`. Flag any value matching `linear(` with more than two comma-separated stops.

**Not a violation:** a two-stop `linear(0, 1)` is the `linear` keyword and is fine. `steps(…)` is un-flagged — [Q07] settled it as harmless (measured 2026-07-29).

#### [P23] Dormancy is demoted from remediation to hygiene (SUPERSEDES [P19]) (DECIDED) {#p23-dormancy-is-hygiene}

**Decision:** dormancy still lands, but as a hygiene rule rather than as the phase's remediation, and its success criterion is re-baselined. It is no longer allowed to claim the 19.7%-to-noise win — that win was the easing fix.

**Rationale:** [P19] made dormancy load-bearing because it was the only lever with a measured slope. [P21] removed that premise: with acceleration restored, a hundred running dots cost 1.5%, so pausing them saves ~1.5 points, not ~18. The rule is still right — motion nobody can see should not run, and it is a genuine battery and thermal argument on a laptop — but it is cheap insurance, not a fix, and it must not be sold as one.

#### [P24] The `will-change` sweep is bounded and enumerated (REFINES [P18]) (DECIDED) {#p24-will-change-bounded}

**Decision:** the sweep works from the **source** declarations, of which there are eleven, not from the 127 live instances the layer probe counted (one source rule under a `running` selector multiplies across every glyph on the bench). The eleven:

| File | Line | Value |
|---|---|---|
| `tugdeck/src/components/tugways/tug-sheet.css` | 502 | `transform, opacity` |
| `tugdeck/src/components/tugways/tug-marquee.css` | 81 | `transform` |
| `tugdeck/src/components/tugways/tug-sparkline.css` | 58 | `transform` |
| `tugdeck/src/components/tugways/cards/gallery.css` | 326 | `transform` |
| `tugdeck/src/components/tugways/cards/gallery.css` | 338 | `transform, opacity` |
| `tugdeck/src/components/tugways/cards/session-changes/session-changes-view.css` | 65 | `transform` |
| `tugdeck/src/components/tugways/internal/tug-progress-bar.css` | 70 | `transform` |
| `tugdeck/src/components/tugways/internal/tug-progress-pie.css` | 35 | `transform` |
| `tugdeck/src/components/tugways/internal/tug-progress-ring.css` | 60 | `transform` |
| `tugdeck/src/components/tugways/internal/tug-progress-spinner.css` | 58 | `opacity` |
| `tugdeck/src/components/tugways/internal/tug-progress-wave.css` | 75 | `transform` |

(`tug-progress-pulsing-dot.css` line 323 and `tug-list-view.css` line 338 are prose about the absence of a hint, not declarations; `gallery-commit-surfaces.tsx` line 110 is changelog copy.)

**Rationale:** [P18] was a hunch about layer breadth. It now has a measurement behind it — deleting the dot's `will-change` and its `translate3d` together took 24.2% → 18.0% — but the honest attribution of those 6.2 points is to the `translate3d`, since `will-change` alone moved 0.1. So the sweep's justification is *forced promotion costs*, and `will-change` is swept because it is a forced promotion, not because it was independently convicted.

#### [P25] The doctrine leads with the easing law (SUPERSEDES [P11]'s framing) (DECIDED) {#p25-doctrine-leads-with-easing}

**Decision:** `tuglaws/motion-residency.md` opens with the timing-function rule, not with the property rule. The property rule (`transform`/`opacity` only) is well known and widely written down; the easing rule is not, cost eighteen points, and is invisible without a gate.

**Rationale:** doctrine is read for what the reader does not already know.

### New open questions {#c-open-questions}

#### [Q06] Do the other five variants pay a comparable cost? (OPEN — the blast-radius question) {#q06-blast-radius}

None of `tug-progress-{bar,pie,ring,spinner,wave}.css` uses `linear()` — each declares a plain `linear` or an `ease` keyword — so none carries *this* bug. But none of them has ever been validly profiled either. An earlier per-variant sweep this session was **withdrawn as invalid**: `tugutil host tell show-card` *adds* a card to the deck rather than replacing the current one, so every measurement in that sweep included the whole `gallery-tug-progress-indicator` card underneath it. The tell was `ring` reading 16.4%, below the supposed shared baseline. Resolved by #step-16.

#### [Q07] Does `steps()` block acceleration the same way? (SETTLED — no) {#q07-steps-easing}

A step function is not a cubic Bézier either, but WebKit special-cases it (Core Animation has a discrete timing mode). **Settled 2026-07-29** by a three-phase A/B on the editor caret blink in one live app instance (dash/jul29-perf-tuneup-brief.md #exonerated): busy 1.6% with the shipped `steps(1)`, 1.3% with a keyframe-native `linear` override, 1.4% with `animation: none` — noise; `TreeResolver::resolve` and the compositing walk flat across all three. `steps()` does not block acceleration, the census rule set carries no steps() clause (noted in the `animationCensus()` docstring so one doesn't grow later), and #step-16's bench A/B is no longer needed for this.

#### [Q01] The stacked-stroke thicken — now moot {#q01-resolved-by-removal}

**[Q01]** (#q01-thicken-parity) is **closed by deletion.** The stacked-stroke crossfade layers that [P04] introduced were removed in `3e24f00d2` — the rework dropped the glyph from six boxes to four and the ring's opening is carried by the ring's own border again. There is no longer a crossfade whose parity with the border-width lerp could be in question. What is still owed is the user's eyes on the reworked dot generally, which is a review gesture, not a plan step.

### Revised success criteria {#c-success-criteria}

These SUPERSEDE #b-success-criteria.

1. `at0288`'s empty-deck census reports zero animations and its layer probe reports a non-empty tree. (Holds.)
2. `at0288`'s seeded-deck census reports **zero violations**, with the station rule gone and the easing rule added. (Unknown until #step-15 runs; the easing rule may convict something.)
3. Re-introducing a multi-stop `linear()` on any long-running animation fails `at0288`, naming the animation and its target.
4. Every `TugProgressIndicator` variant, profiled alone at a pinned population of 100 on `gallery-motion-bench`, reads **under 3% busy**. (The reworked pulsing dot reads 1.5%.)
5. A deck showing `gallery-tug-progress-indicator` in a **collapsed** pane censuses zero `running` animations.
6. An idle profile of any single non-gallery card stays under 1% busy. (Holds: lens 0.2%, skeleton gallery 0.2%.)

Note what is *not* here: Addendum B's criterion 5 asked the collapsed-pane profile to fall to noise from 19.7%. Per [P23] that delta was the easing bug and has already been collected; the collapsed-pane profile now starts near noise, so the criterion would pass vacuously.

### Revised execution steps {#c-execution-steps}

#### Revised Step Status Ledger {#c-step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 … #step-5 | Census helper, profiling recipe, four re-plumbs | done | see #a-step-status-ledger |
| #step-11 | Census app-test as diagnostic instrument | done | `838704d6a` |
| #step-12 | Attribute the idle burn | done | `9df8c4425` |
| #step-13 | Layer-tree structural probe | done | `d23e8ef70` |
| #step-14 | Addendum B | done | `14fb1b0e5`, `f42100fef` (landed `a207d1e6b`) |
| — | Pulsing-dot rework: keyframe-native envelope, gallery consolidation | done | `826cc958a`, `3e24f00d2` |
| #step-15 | Census truth: drop the station rule, add the easing rule | done | `18e6cf53c` — landed by dash/jul29-perf-tuneup.md #step-1 (with a retained-transition rule added on top) |
| #step-16 | Per-variant residency sweep — one card at a time | pending | — |
| #step-17 | Dormancy for invisible motion | pending | — |
| #step-18 | Forced-promotion sweep (`will-change`, `translate3d`) | pending | — |
| #step-19 | Doctrine: `tuglaws/motion-residency.md` | pending | — |
| #step-6 | Motion stations | **withdrawn** ([P17]) | — |
| #step-7 | Collapse dormancy | superseded by #step-17 | — |
| #step-8 | Residency app-test (contract assertions) | folded into #step-15 | — |
| #step-9 | tuglaws doctrine | superseded by #step-19 | — |
| #step-10 | Integration checkpoint | withdrawn — #step-16 is the integration check | — |

#### Step 15: Census truth — drop the station rule, add the easing rule {#step-15}

**Depends on:** #step-13

**Commit:** `tugways(motion-residency): violations mean acceleration, not stations`

**References:** [P17], [P22], Spec S01, #c-finding

**Context an implementer needs.** `animationCensus()` lives in `tugdeck/src/lib/perf-monitor.ts`. It walks `document.getAnimations()`, filters out `CSSTransition`s, keeps effects whose target is non-null, computes a per-box property set so a demoting neighbour convicts its box-mates, and emits one `AnimationCensusEntry` per long-running animation with a `violations: string[]`. Four rules are checked today: non-accelerable property, SVG target, demoting neighbour, and station ancestry. `MOTION_STATION_SELECTOR` is the module constant `".tugx-motion-station"`; `stationed` is a field on `AnimationCensusEntry`; both the field and the violation go. `at0288` mirrors the entry shape in a local `CensusEntry` interface and prints `stationed` in its reporter — both need the same edit or the app-test will not typecheck.

**Tasks:**
- [ ] Delete `MOTION_STATION_SELECTOR`, the `stationed` field on `AnimationCensusEntry`, the `const stationed = …` computation, and the `no … ancestor` violation from `animationCensus()`. Keep the property, SVG, and co-animation rules.
- [ ] Add the easing rule per [P22]. Collect the animation-level easing from `effect.getTiming().easing` and every keyframe's `easing` from `effect.getKeyframes()`; flag any that starts with `linear(` and carries more than two comma-separated stops. Violation text names the offending easing, truncated — e.g. ``blends on the main thread: `linear(0, 0.0381, 0.1464, …)` (23 stops) is not a cubic Bézier``. Add the collected easings to the entry as a `timingFunctions: string[]` field so the census prints them and the next investigation does not have to re-derive them.
- [ ] Delete Spec S02 (#s02-motion-station) and Spec S01 clause 5 from this document, leaving a one-line pointer to [P17]; add Spec S01 clause 9 from [P22].
- [ ] Update `at0288`'s `CensusEntry` interface, its reporter columns, and its module docstring: drop `stationed`, print `timingFunctions`, and restate what the contract checks.
- [ ] Promote the seeded-deck assertion from a floor to a gate: `expect(seeded.violations).toEqual([])`. The failure message must name the offending animation and target — pass the violating entries through `JSON.stringify` in the assertion message rather than asserting a bare length.
- [ ] Correct the stale docstrings in the reworked dot. `tug-progress-pulsing-dot.css` line ~79 still says the envelope "lives in the `linear()` easings held in the `--…-ease` variables", and the file header still describes the retired pseudo-element structure (`::before` filled dot, `::after` ring) and claims "the keyframes carry no shape". `tug-progress-pulsing-dot.tsx` line ~29 carries the same stale `linear()` claim. All are now false; the corrected explanation already exists at `tug-progress-pulsing-dot.css` lines ~414–417 and can be the source of truth.

**Tests:** `at0288`.

**Checkpoint:**
- [ ] `just app-test tests/app-test/at0288-motion-residency.test.ts` passes with `violations` asserted empty on the seeded deck
- [ ] Temporarily setting any glyph's `animation-timing-function` to a multi-stop `linear()` makes `at0288` fail, naming that glyph and the easing — revert after proving it
- [ ] `bunx tsc --noEmit` clean; `bunx vite build` green

---

#### Step 16: Per-variant residency sweep — one card at a time {#step-16}

**Depends on:** #step-15

**Commit:** `tugways(motion-residency): profile every progress variant at a pinned population`

**References:** [Q06], [Q07], [P21], criterion 4 in #c-success-criteria, Table T05

**Context an implementer needs.** `tugdeck/src/components/tugways/cards/gallery-motion-bench.tsx` exists for exactly this: a pinned population of `BENCH_COUNT = 100` glyphs of one `BENCH_VARIANT`, all `running`, all `BENCH_SIZE = 28`, with nothing else on the card that moves. It is registered as `gallery-motion-bench` in `gallery-registrations.tsx`. Change `BENCH_VARIANT` (currently `"bar"`), let HMR repaint, profile.

**Two traps that invalidated the previous attempt at this sweep. Both are mandatory reading.**

1. **`tugutil host tell show-card` ADDS a card to the deck; it does not replace the current one.** A sweep that shows six variants in sequence without closing the previous card measures a growing pile, not six variants. Every number from the first attempt was discarded for this reason — the tell was `ring` reading 16.4%, *below* the supposed shared baseline, which is impossible for a strictly-additive deck. **Close the previous card before showing the next, and verify the deck holds exactly one card** before each profile.
2. **An occluded window profiles at a flat ~0% no matter what is running** (see [P15]). The window must be raised. A 0.1% reading is far more likely to be an occluded window than a win.

Additionally, confirm the running app actually has your `BENCH_VARIANT` edit before trusting a profile: `curl http://127.0.0.1:<vite-port>/src/components/tugways/cards/gallery-motion-bench.tsx` and read the constant back. [P15] documents why this is not optional — there is no `evalJS` outside `just app-test` to ask the app directly.

**Tasks:**
- [ ] For each of `bar`, `pie`, `ring`, `spinner`, `wave`, `pulsing-dot`: set `BENCH_VARIANT`, mount `gallery-motion-bench` as the **only** card in the deck, raise the window, and run `just perf-resize-profile idle 6`. Record busy %, `TreeResolver::resolve`, `applyKeyframeEffects`, and `updateCompositingLayersAfterStyleChange`.
- [ ] Record the six rows as **Table T06** in this addendum, alongside the empty-deck baseline taken in the same session on the same window.
- [ ] For any variant over the 3% criterion, diagnose it against #c-finding and #c-refuted before proposing anything new — the known-expensive shapes are a non-cubic easing, a forced layer (`translate3d`, `will-change`), an SVG target, and an animated pseudo-element, in roughly that order of cost.
- [ ] Settle [Q07] while the bench is up: one A/B swapping the bench variant's easing for `steps(8)`. Record the answer.
- [ ] Fix what the sweep convicts, or record why a variant's cost is irreducible.

**Tests:** `at0288` (unchanged assertions must still pass); `just app-test-changed` for any glyph actually edited.

**Checkpoint:**
- [ ] Table T06 exists with six rows plus a baseline, each stated as taken against a single-card deck on a raised window
- [ ] Criterion 4 holds for every variant, or each exception carries a recorded reason
- [ ] [Q07] is answered yes or no, with the two numbers that answer it

---

#### Step 17: Dormancy for invisible motion {#step-17}

**Depends on:** #step-16

**Commit:** `tugways(motion-residency): motion stops where it cannot be seen`

**References:** [P23], [P08], criterion 5 in #c-success-criteria

**Context an implementer needs — the two in-page invisibility cases are not symmetric.**

- **Background tab in a multi-card pane: already free, verify and move on.** `CardHost` renders every card into the pane and hides the non-active ones with `display: none` (`tugdeck/src/components/chrome/card-host.tsx`, the `style={{ display: isActive ? "contents" : "none" }}` on the `[data-card-host]` div). A `display: none` subtree generates no boxes, and WebKit does not run CSS animations on elements with no box. So a background card's loops are expected to be **absent from the census entirely** — not paused, absent. Addendum B listed this as work; it is almost certainly already done by construction. **Verify it with the census, and if it holds, record the finding and write no code for this case.**
- **Collapsed pane: the real work.** A collapsed pane keeps its body displayed and collapses it geometrically — `tug-pane.css` line ~279, `.tug-pane-chrome--collapsed .tug-pane-body { height: 0; overflow: hidden }` (see also the `[D07]` comment at line ~270). The content still generates boxes, so its animations still run. This is the case dormancy exists for.

**Mechanism — decide and record as a [P##] before writing it.** Two candidates:

- *A descendant rule.* `.tug-pane-chrome--collapsed .tug-pane-body * { animation-play-state: paused !important }`. Needs no opt-in, so a newly written animation cannot forget to participate — which is the whole failure mode of the alternative. The `!important` is load-bearing: several glyphs already set `animation-play-state` under their own state selectors at comparable specificity (`tug-progress-{bar,pie,ring,spinner}.css` each carry a `paused`-state rule), and without it the cascade winner is order-dependent. The universal selector only ever matches inside a collapsed subtree, so its match cost is bounded by content that is invisible anyway.
- *The inherited custom property* from [P08] and Spec S01 clause 6 — `animation-play-state: var(--tugx-motion-play, running)` on every animation declaration, with the collapsed rule setting `--tugx-motion-play: paused`. Cleaner cascade, no `!important`, but it is opt-in at every declaration site and nothing enforces the opt-in. Clause 6 has never been implemented: `grep -rn "animation-play-state: var" tugdeck/src` returns nothing today.

The descendant rule is recommended; if the custom-property route is chosen instead, `animationCensus()` must gain a rule that convicts a long-running animation whose declaration omits the variable, or clause 6 is decorative.

**Do not remove the animation — pause it.** A resumed pane must pick the loop up mid-phase, not restart it. The pulsing dot's phase discipline (`releaseEmitter` / `liveScale` in `tug-progress-pulsing-dot.tsx`) depends on the loop's clock being continuous across a pause.

**Tasks:**
- [ ] Census a deck whose multi-card pane has `gallery-tug-progress-indicator` in a background tab; confirm zero animations from that card. Record the result either way.
- [ ] Implement collapsed-pane dormancy by the chosen mechanism; record the choice as a [P##] in this addendum with the cascade reasoning above.
- [ ] Confirm the resumed loop continues rather than restarts — expand a collapsed pane holding a running pulsing dot and check that the dot's scale does not snap to its trough.

**Tests:** `at0288` gains a third deck — the same gallery card in a collapsed pane — asserting every censused animation reports `playState === "paused"` (and a fourth, background-tab deck asserting zero entries, if the verification above holds).

**Checkpoint:**
- [ ] Criterion 5 holds: collapsed-pane census reports no `running` animation
- [ ] The background-tab case is settled by measurement, with either a test or a recorded finding — not left as an assumption
- [ ] Expanding the pane resumes the motion without a visible restart

---

#### Step 18: Forced-promotion sweep {#step-18}

**Depends on:** #step-17

**Commit:** `tugways(motion-residency): drop forced promotions that buy nothing`

**References:** [P24], [P18], Table T05

**Context an implementer needs.** The eleven source `will-change` declarations are enumerated in [P24]'s table. The companion target is `translate3d(…, 0)` used purely to force a layer — the dot's removal was worth 6.2 points on the bench, with `computeCompositingRequirements` falling 415 → 184. Find the rest with `grep -rn "translate3d" tugdeck/src`. A `translate3d` that carries real 3D motion stays; one whose Z is a literal `0` is a promotion request in disguise.

Each A/B follows the same discipline as #step-16 — single-card deck, raised window, `curl` the dev server to confirm the running app has the change — and must be taken minutes apart on the same window, because the absolute numbers drift between app launches.

**Tasks:**
- [ ] A/B each of the eleven `will-change` declarations on the surface that carries it. Delete the ones that show no regression.
- [ ] Enumerate `translate3d(…, 0)` uses in `tugdeck/src` and apply the same test; replace the promotion-only ones with `translate(…)`.
- [ ] Leave a comment on each survivor naming the measurement that saved it, in the form the reworked dot's CSS already uses at `tug-progress-pulsing-dot.css` line ~323.

**Checkpoint:**
- [ ] Every surviving `will-change` and Z-zero `translate3d` in `tugdeck/src` cites a measurement in a comment
- [ ] The seeded-gallery layer probe's `willChange` count falls, and no variant's #step-16 number rises

---

#### Step 19: Doctrine written against the numbers {#step-19}

**Depends on:** #step-15, #step-16, #step-17, #step-18

**Commit:** `tuglaws(motion-residency): the contract, and what it is actually for`

**References:** [P25], [P21], [P22], #c-finding, #c-refuted, Table T05, Table T06

**Tasks:**
- [ ] Write `tuglaws/motion-residency.md`. Open with the timing-function law per [P25] — *the envelope goes in the keyframe stops, never in a multi-stop `linear()`* — with #c-finding's mechanism and Table T05's 28.0% → 1.5% as its evidence. Then the property law, the element law (no SVG), the no-demoting-neighbour law, the no-forced-promotion law, and dormancy last, marked as hygiene per [P23].
- [ ] State the corrected cost model from [P21]: linear in main-thread-blended loops, not in running loops; an accelerated loop is very nearly free. Explain why the earlier reading was wrong, because that mistake is easy to repeat.
- [ ] Record #c-refuted by name — the rounded clip, `will-change`, containment, `calc(var())` durations, `var()` in keyframe values, tree depth, element count, SVG-as-remedy. A doctrine that lists only what is true invites the same wrong guesses.
- [ ] Record the two anti-tells: `applyKeyframeEffects` does not drop when animations pause and is not an acceleration signal; a pseudo-element is not cheaper than an element.
- [ ] Point at `at0288` as the enforcement and `just perf-resize-profile` as the measurement, and carry across the measurement traps: `show-card` adds rather than replaces (#step-16), an occluded window reads ~0% ([P15]), and there is no `evalJS` outside `just app-test` so the dev server must be `curl`ed to confirm a change is live.
- [ ] Note the one legitimate `linear()` left in the codebase and why it is legitimate: `--tugx-imposer-settle-easing`, written by `deck-canvas.tsx` from `IMPOSITION_SETTLE_EASING` via `cssEasing()` in `tugdeck/src/lib/unit-functions.ts`, drives the pane settle **transition** in `tug-pane.css`. It is finite, one-shot, and animates `left`/`top`/`width` — properties that are not accelerable in any case — so the contract does not reach it. Say so explicitly, or the next reader will delete it.
- [ ] Register the doc in `tuglaws/INDEX.md` and add the pointer from `tuglaws/tuglaws.md` and `tuglaws/component-authoring.md`.
- [ ] Absorb the jul29-perf-tuneup findings (dash/jul29-perf-tuneup-brief.md, all measured 2026-07-29): **(a)** the `steps()` verdict — [Q07] settled, steps() does not block acceleration (caret A/B 1.6/1.3/1.4%), so the timing-function law needs no steps clause; **(b)** the retained-transition rule — a transitioned property written through a live `transition` outside a designed crossing leaves a finished `CSSTransition` in `getAnimations()` forever, iterated by the animation controller every rendering update (415 on one restored card; the census's `retainedTransitions` + at0288/at0289 enforce zero-at-rest), and `transition: none` both prevents and DROPS them; **(c)** the end-state principle — *progress machinery is for progress; settled states render settled DOM* — a settled glyph renders transform-free, transition-free, animation-free (the pulsing dot's static mode; 1,314 stacking contexts → 0 on the restored card), with the live↔static handoff governed by the swap-when-settled rule (jul29-perf-tuneup [P06]).

**Checkpoint:**
- [ ] Every rule in the doc cites the measurement that justifies it, or is explicitly marked as a convention with no measured backing
- [ ] `tuglaws/INDEX.md` lists it and at least one law doc links to it
- [ ] `just app-test-changed` selection for the touched files passes

---

### Still open {#c-open}

- **[Q06]** — the blast radius across the other five variants. #step-16 answers it.
- **[Q07]** — whether `steps()` blocks acceleration. #step-16 answers it in passing.
- **The reworked dot has not been seen by the user.** Its fidelity is verified numerically by `at0274`, which seeks the live animation and asserts the envelope's shape at five points. It has not been verified by eye. This is a review gesture rather than a plan step, but it is the one thing this investigation cannot self-certify.
