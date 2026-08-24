<!-- devise-skeleton v4 -->

## July 29 Perf Tune-up — Kill the Typing-Lag Bill {#jul29-perf-tuneup}

**Purpose:** Remove the measured causes of the release app's typing lag: 438 pulsing dots per heavy transcript card holding 82% of the card's composited breadth, 415 zombie finished `CSSTransition`s per card ticking the animation controller every frame, and (pending its own measurement) 438 per-block sticky headers — with the animation-tuneup census gate landed first so every fix is verified mechanically rather than by eye.

> **Source brief:** [dash/jul29-perf-tuneup-brief.md](jul29-perf-tuneup-brief.md) holds the full audit: method, measurements, exonerations, and user guidance. This plan is the implementable form of that brief. Where a number is cited without a source below, it is from the brief's #reference-numbers table.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-07-29 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

Typing in the release app's prompt editor lags. The 2026-07-29 audit (the brief) measured the causal chain end to end: the release deck holds five heavy session cards; one cold-restored 30MB transcript card carries 16,249 elements and 1,603 stacking contexts, of which 1,314 (82%) are tool-call-header pulsing dots — `.tool-call-header` (sticky) + `.tug-progress-pulsing-dot-dot` + `.tug-progress-pulsing-dot-ring`, 438 of each. Every one of those dots is a full `TugProgressPulsingDot` mounted for a tool call that finished long ago and will never animate again. Each also fired a transition on mount (the component writes its initial inline `transform` through the live `transition: transform` on the class), and WebKit retains the finished `CSSTransition` objects: `document.getAnimations()` on the restored card returns 415 of them, iterated by the animation controller on every rendering update. A keystroke dirties style and layout; the engine then walks compositing requirements over that breadth twice per frame (167 + 124 samples in the release profile), runs ResizeObserver gather (67 samples), and rebuilds the layer transaction. One card idles at 2.9–4.0% main-thread busy; five reproduce the measured release 13.8%.

Exonerated by measurement, recorded in the brief so they stay exonerated: the caret blink and `steps()` easings generally ([Q07] of dash/animation-tuneup.md — settled, does not block acceleration), empty session decks, the pulsing-dot easing fix (`3e24f00d2`, confirmed live in the release bundle), `cssEasing()` (one finite caller), and the atom pending pulse (a real residency violation, `filter` is never accelerable, but transient and not this bug — fixed opportunistically here in #step-3).

#### Strategy {#strategy}

- **Gate first.** Land the animation-tuneup plan's census-truth step (its #step-15: drop the station rule, add the easing rule) extended with a retained-finished-transition rule — the zombie-army detector. Every subsequent fix is then verified by a census assertion, not by re-profiling.
- **Fix the mechanism, not the design.** The dots look identical after every step. The end-state swap renders settled DOM for settled states; the crossing choreography the component's docstring guards is preserved exactly, because demotion happens only after the settle transition completes.
- **Accuse or absolve, in order.** The sticky headers and the ResizeObserver gather are measured *after* the dot fixes land, against the post-fix baseline, with the same one-app-instance style-override A/B the audit used. Implicated → fixed in a follow-on step; absolved → numbers recorded and the suspect buried.
- **Re-profile the real thing.** The phase closes with before/after numbers from the actual release deck, not the harness.

#### Success Criteria (Measurable) {#success-criteria}

1. `at0288`'s censuses report **zero violations** with the station rule gone and the easing + retained-transition rules added. (Fails today: 161 station-rule violations on the seeded deck.)
2. A cold-restored transcript with tool-call headers censuses **zero retained finished `CSSTransition`s** after settle, and its stacking-context histogram shows **zero** entries for `.tug-progress-pulsing-dot-dot` / `.tug-progress-pulsing-dot-ring`. (Fails today: 415 / 438+438 on the heavy card; the committed gate asserts the same invariants at fixture scale.)
3. Settled dots in all end states are visually indistinguishable from today in the gallery at both size treatments, and every state crossing still crosses rather than cuts (`at0274` passes unchanged).
4. The sticky-header / ResizeObserver question is answered with recorded numbers — either a fix step with its own measured delta, or an absolution entry in this plan.
5. The release deck's idle profile improves from the recorded 13.8% baseline, and the improvement is recorded in this plan with the same instrument that measured the baseline.
6. `bunx vite build` and `just app-test-changed` green at every step.

#### Scope {#scope}

1. Census truth: station rule out, easing rule in, retained-finished-transition rule in; [Q07] recorded as settled; `at0288` promoted to a gate.
2. A committed restored-transcript census gate (fixture `session-transcript-basic`, 29 tool calls).
3. Mount-transition suppression in `TugProgressPulsingDot`; atom pending pulse loses its `filter` leg.
4. The end-state swap: settled-never-crossing dots render static, transform-free, transition-free DOM.
5. Sticky-header + ResizeObserver A/B against the post-fix baseline; fix or absolve.
6. Release-deck re-profile; brief updated with after numbers; temporary `zz-` probes deleted.

#### Non-goals (Explicitly out of scope) {#non-goals}

- Animation-tuneup steps 16–19 (per-variant sweep, dormancy, forced-promotion sweep, doctrine). They remain that plan's work; this plan hands its findings to that doctrine step but does not absorb the steps. The exception is #step-15 of that plan, which this plan lands (see #step-1).
- Transcript virtualization or `content-visibility` changes — 46 of 47 cells on the probe card already carry `cv:auto`; re-open only if #step-5's A/B implicates skipped-cell overhead.
- Any change to the dots' motion design, timing, or choreography.
- The `IndexedDB`/SessionCache layer, decode paths, store batching — covered by the July program, not implicated by this audit.

#### Dependencies / Prerequisites {#dependencies}

- dash/animation-tuneup.md Addendum C — its #step-15 spec is implemented here; its ledger must be updated when #step-1 lands.
- `animationCensus()` / `layerTreeProbe()` in `tugdeck/src/lib/perf-monitor.ts` (dev/test-only, `window.tugPerfMonitor`).
- `tests/app-test/at0288-motion-residency.test.ts` (two-deck census test), `at0274-progress-dot-envelope.test.ts` (envelope assertions).
- The app-test harness (`launchTugApp`, `seedDeckState`, `evalJS`), fixture seeding (`tests/app-test/fixtures/resolve.ts`), `just perf-resize-profile`.
- Temporary probes from the audit, kept until #step-6 deletes them: `tests/app-test/zz-blink-probe.test.ts`, `zz-heavy-census.test.ts` (plus the older `zz-probe.test.ts`, user's to keep or delete).

#### Constraints {#constraints}

- WARNINGS ARE ERRORS; `bunx vite build` before any tugdeck change is done; bun only; app-tests selective via `just app-test-changed`, every new test carries `@covers` and registers in `tuglaws/app-test-inventory.md`.
- Motion-off (`body[data-tug-motion="off"]`) and `--tug-timing` scaling must survive every change.
- The dot's box-reservation contract holds: a caller's `size` still means the space reserved; the header's left-edge alignment (`DOT_SIZE` box in `block-header.tsx`) must not shift.
- Only the user commits on `main`; each step below is a commit boundary for the user's landing gesture.

#### Assumptions {#assumptions}

- WebKit's retention of finished `CSSTransition`s in `getAnimations()` is stable behavior in the shipped WebKit (observed 2026-07-29, macOS 15.6, WebKit 20621.3.11); the fix removes the transitions at the source rather than depending on retention semantics.
- A `transform: none` element with no `transition` property and no `will-change` creates no stacking context and no composited layer — the basis of the static mode. (Verified by the census histogram: elements without those properties do not appear in it.)
- `getComputedStyle`-based stacking-context counting (the audit's histogram) is a valid breadth proxy even under `content-visibility: auto` skipping; the sample-based busy % is the ground truth where they disagree.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Are the sticky headers a material cost after the dot fixes? (DEFERRED to #step-5 by design) {#q01-sticky-material}

**Question:** 438 `.tool-call-header { position: sticky; z-index: 1 }` per card (`blocks/block-header.css:56-59`) each create a stacking context. After #step-4 removes the dots' 876 contexts, is what remains a measurable term in the typing bill?

**Why it matters:** Sticky header pinning is design; the fix candidates (static headers under skipped cells, entry-boundary containment) are surgery near scroll behavior and should not be attempted without a conviction.

**Plan to resolve:** #step-5's A/B — `position: static !important` override on the restored heavy card, post-fix baseline, same-instance sampling. The ResizeObserver gather rides the same run.

**Resolution:** RESOLVED 2026-07-29 — **both absolved** (numbers in the brief's #sticky-headers, recorded by #step-5). Post-fix heavy card (438/438 dots static, 0 retained, contexts 1,603 → 725): forcing every `.tool-call-header` to `position: static` moved idle 2.0% → 2.2% and typing 65.9% → 65.8% — nothing, in any pipeline column; disconnecting all 506 ResizeObservers moved idle 2.0% → 1.8% and typing 65.9% → 62.9% with its own gather zeroed — at the edge of noise. No fix step is added; the follow-on candidates (static headers under skipped cells, entry-boundary containment) stay unbuilt for lack of a conviction.

#### [Q02] Does the static ring survive in end states at the big treatment? (RESOLVED — yes, it must render) {#q02-static-ring}

**Question:** Do settled states need the ring span at all in static mode?

**Resolution:** RESOLVED by reading the component: the PRESENCE ladder (`SETTLED_PRESENCE`, `tug-progress-pulsing-dot.tsx`) draws every settled state as dot + static ring, sized by width (deliberately, so stroke weight is constant across the ladder — see the `presence` comment in the component). Static mode therefore renders both spans; what it drops is the transform pose, the `transition` declarations, and the loop attributes — not the ring. The ring's current centering (`transform: translate(-50%, -50%)`, `tug-progress-pulsing-dot.css` ~line 276/308) must be re-expressed without transform (inset + margin auto), which is the entire CSS change for it.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Static-mode pose differs by a pixel from the transform pose (rounding: width-sized vs scale-sized dot) | med | med | Gallery side-by-side at 28px and 14px (the header's `DOT_SIZE`) before landing; the dot diameter is already computed in px (`dotSizePx`) so the same number sizes the static box | Any visible seam in the gallery comparison |
| The live↔static DOM swap tears a crossing (mode flips mid-transition or mid-pulse) | high | low | [P06]: demotion only when the full settled predicate holds — settle transition done, `data-emitting` gone (a shed ring finishes its travel), no running animation under the root, one frame of grace; a new state abandons the pending demotion. Promotion to live happens before loops start, in the same layout effect that starts them | `at0274` or gallery state-walk shows a cut or hop |
| Mount-suppression flush (`void offsetWidth`) at 438 dots adds measurable restore cost | low | low | The flush only runs when a transition would otherwise fire; static-mode dots (#step-4) never reach it. Measure restore wall-clock in the census gate before/after | Restore-time regression in the gate |
| `at0288`'s easing rule convicts a legitimate animation | med | low | The animation-tuneup #step-15 spec already carves out the imposer settle (finite transition, exempt); the rule applies to long-running animations only | Gate red on an exempt surface |
| Sticky-header fix (if convicted) disturbs pin behavior | med | med | Own step with its own gallery + scroll checkpoint; not attempted absent a conviction ([Q01]) | #step-5 conviction |

---

### Design Decisions {#design-decisions}

#### [P01] The census gate lands first, extended with the zombie rule (DECIDED) {#p01-gate-first}

**Decision:** Implement dash/animation-tuneup.md #step-15 exactly as specced there (drop the station rule and the `stationed` field; add the easing rule with `timingFunctions` on entries; promote `at0288`'s seeded-deck assertion to `expect(violations).toEqual([])`; correct the dot's stale docstrings), and extend `animationCensus()` with one further violation class: **retained finished transitions** — the census reports, per `within` scope, the count of `getAnimations()` entries that are `CSSTransition`s with `playState === "finished"`, and a count above zero at rest is a violation entry naming the target. Record [Q07] as settled (steps() does not block acceleration; measured 2026-07-29, brief #exonerated) in the animation-tuneup plan and in the census docstring.

**Rationale:** User direction ("add in step 15's census gate as preliminary work before we dive in to fixes"). The gate is the instrument that would have caught the 415-zombie army; landing it first means #step-3 and #step-4 are verified by a machine, and any future mount-through-transition regression fails CI with the target's class name in the message.

**Implications:** The animation-tuneup ledger (#c-step-status-ledger) marks its step 15 done with this plan's commit; that plan's steps 16–19 remain pending there. `at0288`'s `CensusEntry` mirror interface and reporter change in the same commit or the test won't typecheck (that plan's #step-15 context section lists every touch point).

#### [P02] Zombies die at the source: no write through a live transition (DECIDED) {#p02-mount-suppression}

**Decision:** Every write of `dot.style.transform` in `TugProgressPulsingDot`'s crossing layout effect that is not itself the animated leg of a crossing is wrapped in the component's existing suppression idiom: set `transition: "none"`, write the pose, flush with `void dot.offsetWidth`, restore `transition: ""`. Concretely the first-paint branch (`previous === null`, `tug-progress-pulsing-dot.tsx` ~line 734) and the settled↔settled branch (~line 763) — the running→settled branch already suppresses (~lines 743–751), and the settled pose write it ends with (line 752) is the *deliberate* transition of the crossing and stays.

**Rationale:** The mount transition was never visible — it transitions to the pose the first frame should simply have. Its only products are a wasted style pass and a retained `CSSTransition` per dot. The settled↔settled branch (e.g. `completed` → `stopped`) is a real designed transition per the docstring ("a plain property change; the dot's CSS transition carries it") — **it is NOT suppressed**; only first paint is.

**Implications:** Fixes zombie retention for every dot that renders in live mode from any call site, independent of the swap. The census gate's zombie rule is the regression net.

#### [P03] The end-state swap lives inside TugProgressPulsingDot (DECIDED) {#p03-swap-in-component}

**Decision:** The component gains two render modes. **Static mode** renders when the shown state is a settled state (`paused | stopped | completed | aborted`) and no crossing is in flight: root span (same class, same `data-state`/`data-slot`/aria attributes, same CSS-variable style block) containing a dot span and a ring span that are sized and centered **without transforms** — dot diameter `dotSizePx × staticScale` via width/height, centering via `inset: 0; margin: auto` — with **no `transition` declarations and no animation attributes**. **Live mode** is the current three-span structure with loops, poses, and crossings, rendered when the state is `running` or a crossing is in flight. Mode is component-internal: derived at first render from the initial state (born settled → static; born running → live), promoted static→live synchronously in the crossing layout effect before loops start, and demoted live→static on the settle transition's `transitionend` (dot span, `transform` property) with a timeout fallback of the settle duration + slack, per the `EMIT_RELEASE_SLACK` pattern.

**Rationale:** User direction: the dot is a state machine, and once it reaches an end state "something must remove the cost and burden of this animation/progress component," preferably as part of what the component does. In-component is the right altitude: `block-header.tsx:316` is one of many mounts (Lens rows, Z2 status cells, session pickers), and a call-site swap would have to be re-derived at each. The component already runs the state machine (`shownRef`, the crossing effect); static is its cheapest state. Born-settled is the 438-per-card case and gets the full win with no transition ever firing.

Demotion timing is governed by [P06] — **swap when settled** — which supersedes the shorthand above ("on the settle transition's `transitionend`") wherever the two differ: `transitionend` on the dot is one *necessary* signal, not the sufficient one.

**Implications:**
- A new piece of component state (`mode`) that **does** provoke renders — unlike `shownRef`, which stays a ref per [L06]. This is legitimate: mode changes are *structure* changes (different DOM), exactly what React state is for; appearance within a mode still never renders. See #state-zone-mapping.
- `staticScale` currently written imperatively (`dotPose(staticScale)`) becomes, in static mode, a rendered width/height — the same numbers (`dotSizePx`, `presenceScale`, `IDLE_DOT_SCALE`) through a cheaper channel.
- The ring keeps rendering in static mode ([Q02]); its CSS gains a transform-free centering variant scoped to the static mode (a `data-static` attribute on the root is the cleanest hook, keeping [L06]: mode is visible in the DOM, CSS selects on it).
- `dotDriftFor` and every existing consumer prop pass through unchanged.

#### [P06] Swap when settled — the demotion rule (DECIDED) {#p06-swap-when-settled}

**Decision:** The live→static demotion **must not cause a graphical glitch or hop, ever**. The rule is: **swap when settled** — the component provides a settle window and demotes only after *everything* in the glyph has come to rest. "Settled" is a mechanical predicate, all clauses required:

1. The shown state is a settled state and no newer state has arrived (`shownRef` agrees with the prop).
2. The dot's settle transition has completed (`transitionend` for `transform` on the dot span received, or the resolved settle duration + slack has elapsed — the timeout fallback, which under motion-off collapses to ~0 because the resolved duration does).
3. **No pulse is in flight:** `data-emitting` is absent from the root. A lit ring always finishes its travel on its own clock (`releaseEmitter` + `EMIT_RELEASE_SLACK`); demotion waits for that release, however long after the dot has landed it comes.
4. Nothing else is animating under the root: `root.getAnimations({ subtree: true })` contains no `running` entry — this catches the static-ring fade and tint crossings, which run on the same settle duration but are separate transitions on separate spans.
5. One extra frame of grace after the last clause turns true (a `requestAnimationFrame` tick or equivalent), so the swap replaces DOM that has already painted its final pose with DOM that paints the identical pose — a no-op to the eye by construction.

If a new state arrives during the window, the demotion is abandoned and the machine stays live for the new crossing. The predicate is re-armed, not queued.

**Rationale:** User direction, verbatim intent: "This must not cause graphical glitches or hops. We must provide a window of time for these dot animations to settle before we do the swap. The rule is: swap when settled." The dot's own doctrine already establishes why a lazy swap is safe and an eager one is not — a shed pulse "always finishes its travel," and the most visible tear a state change can make is cutting a moving object. Static mode is a cost optimization; it has no deadline. Late is free, early is a glitch.

**Implications:**
- Demotion is driven by events (transitionend, the emit-release timer, one rAF grace tick) — never by a bare fixed-delay guess. The timeout in clause 2 is a *fallback* against a swallowed event, sized from the resolved computed duration, not a primary mechanism.
- The settled predicate is cheap and local (attribute checks + one scoped `getAnimations` call at demotion time only) — it runs a handful of times per state change, never per frame.
- The gallery state-walk checkpoint in #step-4 exercises exactly this window: rapid running→completed→running flips must never catch the glyph mid-swap (clause 1 abandons the demotion), and a completed dot with a ring still flying must keep the ring alive to the end of its travel before the swap lands.

#### [P04] Sticky headers and ResizeObserver are tried after the dots, on the post-fix baseline (DECIDED) {#p04-accuse-or-absolve}

**Decision:** No sticky-header or observer change lands in this phase without a conviction from #step-5's A/B: restored heavy card, dot fixes in, `position: static !important` override injected, before/after samples minutes apart in one app instance. Convicted → a follow-on step is added to this plan with its own checkpoint; absolved → the numbers are recorded under #step-5's checkpoint and the suspect is closed the way animation-tuneup's #c-refuted list closes suspects.

**Rationale:** User direction ("accused or absolved"). The dots are 82% of the breadth; what the remaining 18% costs cannot be measured honestly until they're gone.

#### [P05] The atom pending pulse drops its filter leg (DECIDED) {#p05-atom-pulse-opacity-only}

**Decision:** `tug-atom-pending-pulse` (`tug-text-editor/atom-decoration.ts:774`) animates `opacity` + `filter: saturate()`. The `filter` leg goes; the keyframes become opacity-only (0.4 ↔ 1, same period and easing). The wash-out read the saturate leg added is largely carried by the opacity dip; if the gallery comparison disagrees, the fallback is baking the desaturated look into a static `filter` on `img[data-pending]` (constant filter, animated opacity — the animation itself stays accelerable).

**Rationale:** `filter` in keyframes is never accelerable and poisons the element's effect stack — a genuine Spec S01 violation the new census gate would convict whenever a pending image exists during a census. Fixing it here keeps the gate's "zero violations" honest rather than carving out an exemption.

---

### Specification {#specification}

**Spec S01: The retained-transition census rule (normative)** {#s01-zombie-rule}

1. `animationCensus()` additionally enumerates `CSSTransition`s (which the long-running pipeline rightly excludes) solely to count those with `playState === "finished"` still present in `document.getAnimations()` at census time.
2. The census result gains `retainedTransitions: { count: number; targets: string[] }` (targets as `tag.class`, first N unique, N = 10).
3. A count > 0 is reported as a violation-class entry in the census output; `at0288`'s decks assert it equals 0 after a settle wait (transitions from the deck's own mount choreography must be given one settle window — the test's existing settle-wait pattern — before the assertion).
4. The rule is doctrine-bound: a finished transition that persists at rest means some component wrote a transitioned property through a live `transition` outside a designed crossing.

**Spec S02: Static-mode DOM (normative for #step-4)** {#s02-static-dom}

- Root: `span.tug-progress-pulsing-dot[data-state=<state>][data-static]` — same `rootStyle` variable block (`--…-size`, `--…-dot-size`, `--…-presence`, and the three `-auto` geometry variables), same `aria-hidden`, same forwarded ref target.
- Dot: `span.tug-progress-pulsing-dot-dot` with, under `[data-static]`: `width`/`height` = `calc(var(--tugx-progress-pulsing-dot-dot-size) * <staticScale>)` (the component may equally write one `--…-static-scale` variable and let CSS compute), `position: absolute; inset: 0; margin: auto;`, `transform: none`, `transition: none`.
- Ring: `span.tug-progress-pulsing-dot-ring` is `display: none` under `[data-static]` (amended in-step: it is invisible in every settled state anyway, and a **rendered** opacity-0 box is itself a stacking context — restyling it transform-free would have left 438 contexts standing and defeated the swap). The STATIC ring the settled states draw is the root's `::after`, which gets the transform-free centering; its width-based presence sizing already avoids transforms and is unchanged.
- No `data-breathing` / `data-emitting` ever present in static mode; no inline `transform` written.
- Verification hooks: the census stacking-context histogram must show zero dot/ring entries for a static population, and `getAnimations({subtree})` under a static dot must be empty.

#### State Zone Mapping (tugdeck/tugways plans) {#state-zone-mapping}

| State | Zone (appearance / local-data / structure) | Mechanism | Law |
|-------|--------------------------------------------|-----------|-----|
| Dot render mode (`static` \| `live`) | structure | React `useState` in `TugProgressPulsingDot`; changes only at crossing boundaries (promotion in the crossing layout effect, demotion on `transitionend`) | [L06] holds: within a mode, appearance still moves via DOM attributes/CSS only; the mode itself is structure, which is React's job |
| `data-static` root attribute | appearance | written by render (it mirrors the mode state) so CSS can select the transform-free rules | [L06] |
| Census `retainedTransitions` | dev/test-only derived data | plain function in `perf-monitor.ts`; never enters React | [L02] n/a |

No new stores, no persistence, no `useSyncExternalStore` surfaces.

---

### Definitive Symbol Inventory {#symbol-inventory}

| Symbol | Kind | Location | Change |
|--------|------|----------|--------|
| `animationCensus()` | fn | `tugdeck/src/lib/perf-monitor.ts` | station rule out; easing rule + `timingFunctions` in; `retainedTransitions` in (Spec S01) |
| `MOTION_STATION_SELECTOR`, `stationed` | const/field | `tugdeck/src/lib/perf-monitor.ts` | deleted |
| `at0288-motion-residency.test.ts` | app-test | `tests/app-test/` | mirror-interface + reporter updates; violations gate; third deck (restored fixture transcript) asserting Spec S01 rule 3 |
| `TugProgressPulsingDot` | component | `tugdeck/src/components/tugways/internal/tug-progress-pulsing-dot.tsx` | mount suppression ([P02]); static/live modes ([P03]) |
| `tug-progress-pulsing-dot.css` | CSS | same dir | `[data-static]` transform-free rules (Spec S02) |
| `pendingAtomTheme` | CM6 theme | `tugdeck/src/components/tugways/tug-text-editor/atom-decoration.ts` | `filter` leg removed from keyframes ([P05]) |
| `dash/animation-tuneup.md` | plan doc | `dash/` | ledger: step 15 done (pointer here); [Q07] resolution recorded |
| `zz-blink-probe.test.ts`, `zz-deck-census.test.ts`, `zz-heavy-census.test.ts` | temp probes | `tests/app-test/` | instruments for #step-5; deleted in #step-6 |

---

### Test Plan Concepts {#test-plan-concepts}

| Category | Purpose | When |
|----------|---------|------|
| Census gate (`at0288` + restored-fixture deck) | Zero violations, zero zombies, dot-free histogram — the mechanical verifier for every fix | Every step from #step-1 on |
| Envelope + crossing (`at0274`, gallery) | The swap and suppression change nothing visible | #step-3, #step-4 |
| Manual A/B (zz-heavy-census + style overrides) | Sticky/observer conviction on the post-fix baseline | #step-5 |
| Release profile (`just perf-resize-profile` + release-pid sampling) | Before/after on the real deck | #step-6 (baseline already recorded in the brief) |

Out of scope for tests: jsdom/mocks (banned), CI-gated profiling (machine-dependent), pixel-diff CI.

---

### Execution Steps {#execution-steps}

> **Commit after all checkpoints pass.** This rule applies to every step below.

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Census truth + zombie rule (gate first) | done | `18e6cf53c` |
| #step-2 | Restored-transcript census deck | done | `c67bd0ae9` |
| #step-3 | Mount suppression + atom pulse filter | done | `091356536` |
| #step-4 | End-state swap | done | `333980af9` |
| #step-5 | Sticky headers + ResizeObserver: accuse or absolve | done | `3ca1d2c1c` — both absolved |
| #step-6 | Release re-profile, brief update, probe cleanup | done | `0410ec12e` — release after-number taken post-landing: 13.8% → 8.3% idle |

#### Step 1: Census truth + zombie rule {#step-1}

**Commit:** `tugways(motion-residency): violations mean acceleration and hygiene — station rule out, easing and retained-transition rules in`

**References:** [P01], Spec S01, dash/animation-tuneup.md #step-15 (the full task list there is normative for the station/easing halves), brief #exonerated ([Q07])

**Tasks:**
- [ ] Execute animation-tuneup #step-15 as written: delete `MOTION_STATION_SELECTOR` + `stationed` + the station violation; add the easing rule (animation-level `getTiming().easing` and per-keyframe easings; flag `linear(` with >2 stops) with a `timingFunctions: string[]` entry field; update `at0288`'s mirror interface, reporter, and docstring; promote the seeded-deck assertion to `expect(violations).toEqual([])` with violating entries stringified in the failure message; correct the stale `linear()` docstrings in `tug-progress-pulsing-dot.{css,tsx}` (that plan's step lists the line neighborhoods).
- [ ] Add Spec S01: `retainedTransitions` on the census result, violation on count > 0, `at0288` asserting 0 on both existing decks after settle.
- [ ] Record [Q07] as settled in animation-tuneup's #c-open-questions (steps() does not block acceleration; A/B 2026-07-29: 1.6%/1.3%/1.4%, brief #exonerated) and note it in the census docstring so the rule set doesn't grow a steps() clause later.
- [ ] Update animation-tuneup's #c-step-status-ledger: step 15 done, commit hash, pointer to this plan.

**Tests:**
- [ ] `just app-test tests/app-test/at0288-motion-residency.test.ts`
- [ ] Prove the easing rule: temporarily set a glyph's timing to a multi-stop `linear()`, watch `at0288` fail naming it, revert.
- [ ] Prove the zombie rule: temporarily remove nothing — the rule is proven by #step-2's deck, which fails red against today's mount behavior (see that step); here assert it green on the existing decks.

**Checkpoint:**
- [ ] `at0288` green with zero violations on both decks
- [ ] `bunx tsc --noEmit` (tugdeck) clean; `bunx vite build` green

---

#### Step 2: Restored-transcript census deck {#step-2}

**Depends on:** #step-1

**Commit:** `tugways(motion-residency): census gate covers a restored transcript`

**References:** [P01], Spec S01, brief #causal-chain

**Context for the implementer.** The zombie army only exists on a restored transcript (dots born settled), so the gate needs a deck that has one. The committed fixture `tests/app-test/fixtures/sessions/session-transcript-basic.jsonl` carries 29 `tool_use` blocks — enough dots to make the assertions meaningful at fixture scale. The seeding + open flow is `seedFixtureSession` (`fixtures/resolve.ts`) + `openFixtureSession` / `waitForTranscriptSettled` (`fixtures/runner.ts`); `at0189`/`at0190` are working examples including the `recent-projects` tugbank pre-seed the picker needs. Decide in-step whether this is a third deck inside `at0288` or a sibling test file — `at0288` currently launches once and censuses two decks in sequence; a restored session needs its own tugbank pre-seed at launch, which argues for a **sibling test** (e.g. `at0289-transcript-motion-hygiene.test.ts`, next free number per `tuglaws/app-test-inventory.md`) rather than complicating `at0288`'s launch. Register `@covers` for `perf-monitor.ts`, `tug-progress-pulsing-dot.tsx`, and `blocks/block-header.tsx`.

**Tasks:**
- [ ] New app-test: seed + cold-restore `session-transcript-basic` through the picker, settle, then census: assert `retainedTransitions.count` and record the stacking-context histogram counts for `.tug-progress-pulsing-dot-dot` / `-ring` (the audit's histogram logic; keep it in the test or promote it into `perf-monitor.ts` beside `layerTreeProbe()` — promoting is preferred so #step-5 reuses it).
- [ ] **Land the test EXPECTED-RED-then-green:** on today's code the zombie assertion fails (29 retained transitions). Mark the zombie + histogram assertions with a short-lived expected-failure guard (or land this step *after* #step-3 flips them green in the same landing batch — implementer's call, but the test must be red against pre-#step-3 code when run locally, proving it detects the defect).
- [ ] Inventory registration.

**Finding (measured in-step, 2026-07-29, supersedes the zombie-count expectation above).** A plain cold restore at fixture scale retains **zero** transitions: the first-paint pose write resolves together with the element's initial style, so no transition ever fires from the `previous === null` branch on this path. The retention mechanism was isolated live instead: an inline `transform` write through the live transition **after** first style resolution retains exactly one finished `CSSTransition` (the audited card's 415 came from such post-first-paint writes — batched-replay state crossings land `in_flight` → `success` across separate batches on a 30MB session, where the fixture replays in one). Also measured: setting `transition: none` (with a flush) **drops** an already-retained finished transition — so [P03]'s static mode both prevents new zombies and clears crossing-retained ones at demotion. The committed gate therefore asserts at-rest retention **zero unconditionally from day one**, carries a permanent **induced-crossing phase** (the real write, performed on one real dot span) proving the detector fires naming the target, and guards only the breadth assertions behind `SETTLED_DOTS_STATIC` (flipped by #step-4, at which point the induced write must retain nothing — static immunity). #step-3's "flip the zombie guards" task is thereby absorbed: there is no zombie guard to flip, and #step-4 owns the one guard that exists.

**Tests:**
- [ ] The new test itself; `just app-test-covers-check`.

**Checkpoint:**
- [ ] Run against pre-#step-3 code: zombie assertion red, naming `tug-progress-pulsing-dot-dot` targets (proof the gate sees the defect)
- [ ] `bunx vite build` green

---

#### Step 3: Mount suppression + atom pulse filter {#step-3}

**Depends on:** #step-2

**Commit:** `tugways(pulsing-dot): no mount transition, no zombie retention; atom pulse loses its filter leg`

**References:** [P02], [P05], Spec S01, brief #mount-suppression

**Context for the implementer.** The crossing layout effect is in `tug-progress-pulsing-dot.tsx` (~line 713). Branches: first paint `previous === null` (~734) — suppress; running→settled (~740) — already suppresses its pin, leave the deliberate settle transition; settled→running (~757) — writes no dot pose, untouched; settled↔settled fallthrough (~763) — deliberate transition per the component docstring, **leave it transitioning**. The suppression idiom is exactly lines 743–751 (set `transition: "none"`, write, `void dot.offsetWidth`, restore).

**Tasks:**
- [ ] Wrap the first-paint pose write in the suppression idiom.
- [ ] [P05]: remove the `filter` legs from `tug-atom-pending-pulse` keyframes in `atom-decoration.ts`; verify the pending read in the gallery (drop an image in `gallery-prompt-entry`) or accept the static-filter fallback if it reads wrong.
- [ ] Flip #step-2's expected-red guards: zombie assertion now asserts 0 unconditionally.

**Tests:**
- [ ] #step-2's test green (zombies 0 on the restored deck); `at0288` green; `at0274` green; `just app-test-changed`.

**Checkpoint:**
- [ ] Restored-transcript deck censuses zero retained finished transitions
- [ ] Gallery: dots visually unchanged in all states; atom pending pulse still reads as pending
- [ ] `bunx vite build` green

---

#### Step 4: End-state swap {#step-4}

**Depends on:** #step-3

**Commit:** `tugways(pulsing-dot): settled states render settled DOM — the end-state swap`

**References:** [P03], [P06] (**swap when settled** — the demotion rule; normative for this step), [Q02], Spec S02, brief #endstate-swap-proposal, the component's crossing docstring (`tug-progress-pulsing-dot.tsx` module header — "No state change is a cut")

**Context for the implementer.** Load-bearing internals, all in `tug-progress-pulsing-dot.tsx`: `sizeGeometry` (two treatments; the sub-28px reach ramp only matters in live mode), `presenceScale` + `SETTLED_PRESENCE` + `IDLE_DOT_SCALE` (the numbers static mode renders as width/height), `dotPose`/`liveScale`/`breathPhaseFor`/`releaseEmitter` (live-mode machinery, untouched), `shownRef` (stays a ref; the new `mode` state is separate and changes only at mode boundaries). The header mount is `blocks/block-header.tsx:316` (`DOT_SIZE = 14`, phases from `tool-call-phase-visual.ts`: restored transcripts land `success`→`completed`, `error`/`interrupted`→`aborted`, `idle`→`stopped` — all static-eligible). Other mounts to spot-check: Lens session rows (`components/lens/sections/sessions-section.tsx`), Z2 status cell, session picker.

**Tasks:**
- [ ] Implement the mode state per [P03]: born-settled → static from first render; static→live promotion in the crossing effect before `startLoops`; live→static demotion **only through [P06]'s settled predicate** — all five clauses (state agreement, settle `transitionend` or resolved-duration fallback, `data-emitting` absent, no `running` animation under the root, one frame of grace), with a pending demotion abandoned and re-armed if a new state arrives during the window.
- [ ] Static-mode DOM + CSS per Spec S02 (`data-static` attribute; transform-free dot sizing/centering; ring centering re-expressed without transform under `[data-static]`).
- [ ] Ensure motion-off and `--tug-timing` interplay: static mode has no motion to gate; verify a motion-off crossing still lands in static mode (the settle transition is zeroed under motion-off, so the `transitionend` may never fire — the timeout fallback must also collapse to ~0 under motion-off; read the resolved duration rather than assuming the token).
- [ ] Spot-check every mount site listed above for layout (the reserved box is unchanged, but flex/grid centering contexts differ from transform centering).

**Tests:**
- [ ] #step-2's histogram assertion now asserts **zero** dot/ring stacking contexts on the restored deck; `at0288`, `at0274`, `just app-test-changed`.

**Checkpoint:**
- [ ] Restored deck: zero dot/ring stacking-context entries; zero retained transitions; census violations empty
- [ ] Gallery: all five states + disabled at 28px and 14px indistinguishable side-by-side; every crossing (run through the gallery's state walk) crosses without a cut or hop, including running→completed→running round trips
- [ ] [P06] exercised explicitly: a running dot with a ring mid-flight crossed to `completed` keeps the ring alive to the end of its travel, and the swap lands only after it — verified by eye in the gallery AND by census (no `running` animation under the root at the moment `data-static` appears; assertable in the #step-2 test by watching a crossing)
- [ ] Rapid state flips (running→completed→running inside the settle window) never strand the glyph mid-swap — the pending demotion is abandoned, the dot stays live, the new crossing plays
- [ ] Motion-off: state changes land instantly in static mode, no stuck live mode
- [ ] `bunx vite build` green; `just app-test-changed` green

---

#### Step 5: Sticky headers + ResizeObserver — accuse or absolve {#step-5}

**Depends on:** #step-4

**Commit:** `tugways(perf): sticky headers and observer gather measured against the post-fix baseline` *(or the conviction's own fix commit — see below)*

**References:** [P04], [Q01], brief #sticky-headers

**Tasks:**
- [ ] Using `zz-heavy-census.test.ts` (kept for exactly this), on the post-#step-4 build: baseline sample of the restored heavy card, then re-sample with `.tool-call-header { position: static !important }` injected, then re-sample with a third phase disconnecting transcript-entry ResizeObservers if the header A/B leaves a residue worth chasing. Same instance, minutes apart, window raised.
- [ ] Convicted (a delta clearly outside run-to-run noise): append a follow-on step to this plan (ledger + step, per the skeleton) implementing the least-invasive fix — first candidate: `position: static` for headers inside cells currently under `content-visibility: auto` skip — with its own scroll-behavior checkpoint.
- [ ] Absolved: record the three phases' numbers under this checkpoint and in the brief, closing [Q01].

**Checkpoint:**
- [ ] [Q01] carries a resolution with numbers, and either a new ledger row exists or the absolution is recorded

---

#### Step 6: Release re-profile, brief update, probe cleanup {#step-6}

**Depends on:** #step-5

**Commit:** `tugways(perf): jul29 tune-up closed — release before/after recorded`

**References:** brief #reference-numbers (the before column), [P04]

**Tasks:**
- [ ] With the fixes in a rebuilt release app showing the user's real deck: idle sample + a typing-load sample (user typing in a composer during the 5s window), compared against the brief's 13.8% / 167+124-walk baseline. `just perf-resize-profile` covers the debug instance; the release renderer is sampled by pid (the brief's #method names the mechanism).
- [ ] Write the after numbers into the brief (#reference-numbers gains an "after" column) and into this plan's ledger row.
- [ ] Delete `zz-blink-probe.test.ts`, `zz-deck-census.test.ts`, `zz-heavy-census.test.ts` (ask the user about the pre-existing `zz-probe.test.ts`).
- [ ] Hand findings to animation-tuneup #step-19's doctrine task list: the steps() verdict, the zombie rule, and the end-state principle (*progress machinery is for progress; settled states render settled DOM*).

**Checkpoint:**
- [ ] Release idle busy measurably below 13.8% with the delta recorded; typing sample recorded
- [ ] Working tree free of `zz-` probes this plan owns; `just app-test-covers-check` green

**Record (2026-07-29).** The brief's #reference-numbers now carries the after column. What could be measured pre-landing is measured: the restored heavy card on the production bundle reads **2.0% idle** (from 2.9–4.0%), at the empty-deck floor, with 438/438 dots static, 0 retained transitions, contexts 1,603 → 725; the typing-load table is recorded under #step-5's A/B. The live release renderer was re-sampled still running pre-fix code (24.2% busy mid-session, 424 after-style walk samples) confirming the before-state persists. **Closed 2026-07-29 11:12:** the release rebuild (11:09, `data-static` present in the shipped bundle) reads **8.3% idle** across three 5s samples (8.5 / 8.1 / 8.3), with the after-style compositing walk at 85 samples (from 167 at the 06:40 baseline and 424 at the pre-fix re-check), after-layout 45, ResizeObserver gather 29, IntersectionObserver 21. The deck was not certified card-for-card identical to the baseline's five, so the frame counts carry the comparison. `zz-blink-probe`, `zz-deck-census`, `zz-heavy-census`, and `zz-probe` are all deleted (with the temporary `theme.ts` ACCEPTED_FANOUT entry). Findings handed to animation-tuneup #step-19's task list.

---

### Deliverables {#deliverables}

- The census gate, hardened: station rule gone, easing + retained-transition rules live, restored-transcript deck covered (`at0288` + the new sibling test).
- `TugProgressPulsingDot` with mount suppression and the end-state swap — settled dots are one static DOM shape with zero animations, zero transitions, zero stacking contexts.
- The atom pending pulse residency-clean.
- [Q01] resolved with numbers (fix step or absolution).
- Before/after release-deck profile recorded in the brief; temporary probes removed.
