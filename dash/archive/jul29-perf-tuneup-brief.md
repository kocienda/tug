# July 29 Perf Tune-up — Findings Brief {#jul29-perf-tuneup-brief}

**Status:** brief — source material for a /devise call, not a plan. Every number below was measured this session against a real running app; nothing here is inferred from code reading alone.

**Owner:** Ken Kocienda
**Date:** 2026-07-29

---

## The complaint {#complaint}

Typing in the prompt entry editor of the release app lags. This is the third session opened on Tug performance; the two prior programs (July perf phases P1–P5, the animation tune-up through Addendum C) each fixed real defects but the typing lag survived both.

## Method {#method}

Three probes, all against real apps, all repeatable:

- `sample` profiles of the live release renderer (pid found via the WebKit cache-dir match, same mechanism as `scripts/perf-resize-profile.sh`).
- `tests/app-test/zz-blink-probe.test.ts` — A/B/C of the caret blink easing inside one live app instance via injected style override, sampling the renderer per phase.
- `tests/app-test/zz-heavy-census.test.ts` — cold-restores one of the user's real 30MB sessions (`8b8d7bf1`, one of the five cards in the lagging deck) through the production picker → resume path via the corpus reference-seeding mechanism (session content never enters the repo), then runs `document.getAnimations()` census, `layerTreeProbe()`, a stacking-context histogram, and a renderer sample.

Both probe tests are temporary (`zz-` prefix, untracked). They are the measurement instruments for the fix phase and should be kept until the fixes land, then deleted or graduated. (All four `zz-` probes are deleted as of the close; `at0288`/`at0289` are what graduated.)

**One trap in `perf-resize-profile.sh`'s verdict line.** It reads any nonzero `applyKeyframeEffects` as "at least one long-running animation is not compositor-resident." That frame also runs for finite CSS *transitions* — the post-fix release samples show 1–3 samples of it reached through `updateCSSTransitionsForStyleableAndProperty`, which is a live transition doing its job, not an unaccelerated loop. Read the call path before believing the verdict; `animationCensus()` makes the same distinction correctly, and it is the authority.

## The causal chain, measured {#causal-chain}

1. **The release deck is five heavy session cards** (plus two text cards and the Lens; read from the persisted `dev.tugtool.deck.layout`). The release renderer burns **13.8% of the main thread at idle** — ~2.3ms of every 16.7ms frame — with all five tugcode processes idle.
2. **One restored heavy transcript card carries 438 pulsing dots.** Every tool-call block header mounts a full `TugProgressIndicator variant="pulsing-dot"` (`tugdeck/src/components/tugways/blocks/block-header.tsx:316`), including for tool calls that completed long ago. Each dot contributes three stacking contexts: the sticky `.tool-call-header` (`blocks/block-header.css:57`), the dot span, and the ring span — both transform-posed (`dotPose`, `internal/tug-progress-pulsing-dot.tsx:464`, deliberately kept on the transform footing so a live crossing never tears its layer).
3. **Census of the restored card:** 16,249 elements, 1,603 stacking contexts, max DOM depth 37. The histogram: `.tool-call-header` 438 + `.tug-progress-pulsing-dot-dot` 438 + `.tug-progress-pulsing-dot-ring` 438 = **1,314 of 1,603 stacking contexts (82%) are tool-call-header dots.** Next terms are two orders of magnitude down (`__pin` 43, `session-z1b-copy` 41).
4. **415 zombie CSSTransitions per card.** On mount, the dot's layout effect writes an inline `transform` (`tug-progress-pulsing-dot.tsx:735`) through the live `transition: transform var(--tugx-progress-pulsing-dot-settle)` declared on the class (`tug-progress-pulsing-dot.css:241`). The browser fires a mount transition from the stylesheet pose to the inline pose for every settled dot, and WebKit retains the finished `CSSTransition` objects: `getAnimations()` on the restored card returns 415 finished-but-alive transitions, which the animation controller iterates on every rendering update.
5. **The bill each keystroke pays.** A keystroke dirties style and layout — normal. What is not normal is what a dirty frame then costs: the compositing-requirements walk runs **twice per frame** (once after style, once after layout — 167 + 124 samples in the release profile), ResizeObserver gather runs over every observed element (67 samples; the transcript observes per entry), and the layer transaction rebuilds. The walk's cost is proportional to composited breadth, which is ~1,600 stacking contexts × 5 cards. One card idles at 2.9–4.0% busy in the harness at 820×620; five bigger cards reproduce the release 13.8% almost exactly.

## Exonerated, by measurement {#exonerated}

Recorded so nobody re-convicts them:

- **The caret blink** (`tug-text-editor/theme.ts:327`, `steps(1)`). A/B/C in the live app: steps 1.6% busy, keyframe-native linear 1.3%, no animation 1.4% — all within noise. This also settles the animation-tuneup plan's **[Q07]**: `steps()` does not block compositor acceleration in this WebKit.
- **Empty session decks** — three bound session cards plus a text card idle at 2.4% with exactly one running animation (the blink).
- **The easing fix** (`3e24f00d2`) is live in the release build (bundle rebuilt 06:24 on 07-29; zero multi-stop `linear()` in dist). The pulsing-dot main-thread-blend bug from Addendum C is not the current burn.
- **`cssEasing()`** has exactly one runtime caller: `IMPOSITION_SETTLE_EASING` (`lib/layout-imposer.ts:193`) — finite, gesture-scoped, exempt.
- **The atom pending pulse** (`tug-text-editor/atom-decoration.ts:774`) animates `opacity` + `filter` — `filter` is never accelerable, so this is a genuine residency violation — but it only runs while `img[data-pending]` exists (image downsample window) and is not implicated in the idle burn. It should be fixed opportunistically (drop the `filter` leg or move it to opacity-only), not treated as the villain.

## User guidance (2026-07-29) {#guidance}

Verbatim direction from the review of these findings:

1. **End-state swap, not a cheaper pose.** The dots are a state machine. Once a dot reaches an end state (`completed` / `stopped` / `aborted`), the tool-call header machinery should swap the `TugProgressIndicator` for a much cheaper end-state graphic. This may become part of what the component itself does — but something must remove the cost of the animation/progress machinery once we know it no longer needs to show progress. A detailed proposal is required (see below).
2. **Mount-transition suppression: clearly should be done.**
3. **The 438 sticky headers must be accused or absolved.** Straggling items with potential perf cost get measured; if implicated, fixed.
4. **Land the animation-tuneup step 15 census gate first**, as preliminary work before fixes 1+2 — it is the instrument that would have caught the zombie army, and it hardens the census into a regression gate the fixes can be verified against.

## Proposal: the end-state swap {#endstate-swap-proposal}

**Principle:** a dot that is settled and not crossing is pure appearance — a colored circle, optionally with a static ring. Nothing about that requires transforms, transitions, loops, refs, or three spans. The full `TugProgressPulsingDot` machinery exists for exactly two situations: a running loop, and the choreography of crossing into/out of one.

**Where the swap lives: inside the component, not at call sites.** `block-header.tsx` is one of many mounts; pushing "am I cheap yet" onto every consumer invites drift. The component already receives `state` and already runs a state machine over it (`shownRef`, the crossing layout effect). The swap becomes the machine's cheapest state.

**Mechanism — two render modes:**

- **`static` mode** — rendered when the dot is in an end state and no crossing is in flight. One span. Pose expressed without transform: the dot circle sized by `width`/`height` computed from `staticScale × size` (the same numbers `dotPose` feeds `scale()`), centered by flex/grid or `inset`+`margin:auto` in the same box the indicator already reserves — the box geometry (`DOT_SIZE` alignment in the header's leading slot) is untouched, so the header's left-edge alignment contract holds. No `transition` property. No ring span when the end-state design doesn't show one; a static border if it does. Zero stacking contexts, zero animations, zero retained transitions.
- **`live` mode** — the current three-span structure, rendered when `state === "running"` or a crossing is in flight.

**Mode transitions:**

- **Born settled** (the 438-per-card case: restored transcripts, completed tool calls): render `static` from first paint. No promotion, no transition, no layer — this alone removes ~880 stacking contexts and all 415 zombies per heavy card.
- **Settled → running**: swap in `live` mode, then start the loops exactly as the current `previous !== "running" && isRunning` branch does. The swap is a DOM replacement at the moment motion begins; motion starting is itself the visual event, so there is no crossfade to preserve at this boundary.
- **Running → settled**: this is the choreography the component's docstring guards (catch the live pose, pin it, transition to the settled pose, release the emitter on its own clock). The component stays in `live` mode through the settle transition and demotes to `static` on `transitionend` (with a timeout fallback, per the existing emit-timer pattern). Demotion after the transition completes means the crossing is pixel-identical to today; the cheap state is entered only once nothing is moving.
- **Disabled / label variants**: unchanged; `static` mode carries the same `data-state`/`data-slot`/aria attributes so selectors and tests keep matching.

**What must hold (checkpoints for the plan):**

- Gallery side-by-side: settled dots in all end states indistinguishable from today at both size treatments (≥28px and the sub-28px reach ramp — note the ring overshoot geometry only matters in `live` mode).
- The crossing choreography (all five states, per the component docstring) still crosses, never cuts — `at0274` and the gallery timing bench are the instruments.
- Census on the restored heavy card: dots contribute **zero** stacking contexts and **zero** retained animations; the header histogram's top entries become `__pin`-scale numbers.
- `getEmCardState`-style probes and existing app-tests that select `[data-slot="tug-progress-pulsing-dot"]` keep passing.

**Risk:** the swap changes DOM shape at the running boundary; anything holding a ref to the dot span across the swap (the component's own `dotRef`/`ringRef` wiring) must re-acquire. Contained inside the component; the refs are already re-bound per render.

## Proposal: mount-transition suppression {#mount-suppression}

Independent of (and complementary to) the swap: the mount path (`previous === null`, `tug-progress-pulsing-dot.tsx:734`) writes the initial pose through the live transition. Apply the component's own existing trick from the running→settled branch (`transition: "none"` → write → `void offsetWidth` → restore, lines 743–751) to the first-paint write. This kills zombie retention for every dot that renders in `live` mode for any reason, including future call sites the swap doesn't cover. Cheap, mechanical, zero visual change (the mount transition was never visible — it transitions to the pose the first frame should have had).

## Proposal: accuse or absolve the sticky headers {#sticky-headers}

438 `.tool-call-header { position: sticky }` per card (the per-block sticky tier; the July P3 pass consolidated only the per-entry `__pin`). Sticky positioning creates a stacking context and participates in compositing overlap. Whether that participation is a material term *after the dots are fixed* is an open, falsifiable question — the honest sequencing is measure-after-fix:

- **The A/B:** on the restored heavy card, with the dot fixes in place, inject `.tool-call-header { position: static !important }` and re-sample (same instrument as the blink probe: one app instance, style override, before/after within minutes). Compare busy %, both compositing-walk counts, and the layer transaction time.
- **If implicated:** the fix is not removing stickiness (header pinning is design). Candidates, in order of preference: demote the header to `position: static` in cells currently under `content-visibility: auto` skip (46 of 47 cells on the probe card carry `cv:auto` — a skipped cell's sticky header serves nobody); or containment at the entry boundary so the header's overlap scope is its entry, not the page. Either is its own measured step.
- **If absolved:** record the numbers in the plan and close it — the same way Addendum C's #c-refuted list keeps dead suspects buried.

The ResizeObserver gather (67 samples in the release profile, 22–32 on the probe card) rides the same decision: it is per-dirty-frame overhead proportional to observed-element count, and the same A/B run reports it for free. If it remains a material term after the dots, per-entry observers under skipped cells are the follow-on suspect.

**RESOLVED 2026-07-29 — both absolved.** The A/B ran post-fix (dots static: 438/438 `data-static`, 0 retained transitions, stacking contexts 1,603 → 725) on the same restored heavy card, one app instance, three phases, each sampled 5s at rest and 5s under continuous native typing into the composer:

| Phase | Idle busy | Typing busy | resolveStyle | compositing after style / layout | ResizeObserver gather |
|---|---|---|---|---|---|
| A — post-fix baseline | 2.0% | 65.9% | 5 / 98 | 0+9 / 241+61 | 23 / 12 |
| B — `.tool-call-header { position: static !important }` | 2.2% | 65.8% | 4 / 112 | 0+9 / 236+50 | 21 / 18 |
| C — all 506 tracked ResizeObservers disconnected | 1.8% | 62.9% | 3 / 96 | 0+13 / 255+63 | 1 / 0 |

(Per cell: idle-sample / typing-sample counts.) Un-sticking 438 headers moves nothing outside noise in any column; disconnecting every observer trims ≤0.2 idle / ~3 typing points while zeroing its own gather counts — at the edge of run-to-run noise and nowhere near a term worth surgery on scroll-pinning or measurement machinery. The suspects are closed the way Addendum C's #c-refuted list closes suspects: with the numbers that would reopen them.

## Sequencing {#sequencing}

Agreed order, folding in the guidance:

1. **Animation-tuneup step 15 first** (census truth: drop the station rule, add the easing rule — already fully specced in `dash/animation-tuneup.md` #step-15), **extended with two rules this audit hands it:**
   - a violation for **retained finished transitions** above a small threshold (the zombie-army detector — `getAnimations()` entries with `playState === "finished"` of kind `CSSTransition` should be ~zero at rest; 415 is a defect signature), and
   - record **[Q07] as settled** (steps() does not block acceleration; measured 2026-07-29) so the doctrine and census don't re-open it.
   The gate then verifies fixes 2 and 3 mechanically: the heavy-card census (a `zz-heavy-census`-derived leg, or the existing `at0288` decks plus a restored-transcript deck) asserts zero zombies and a dot-free stacking histogram.
2. **Mount-transition suppression** (#mount-suppression) — small, safe, gate-verified.
3. **End-state swap** (#endstate-swap-proposal) — the big win; gate- and gallery-verified.
4. **Sticky-header A/B** (#sticky-headers) — accuse or absolve with the post-fix baseline; fix or record.
5. Re-profile the real release deck (`just perf-resize-profile` idle + resize, and a typing-load sample) and record before/after in the plan. The before numbers are in this brief.

Steps 16–19 of the animation tune-up (per-variant sweep, dormancy, forced-promotion sweep, doctrine) remain valid, separate work — orthogonal to the lag, worth landing after, with the doctrine (#step-19) absorbing this brief's findings (steps() verdict, zombie-transition rule, the end-state-swap principle: *progress machinery is for progress; settled states render settled DOM*).

## Reference numbers {#reference-numbers}

| Measurement | Before | After (2026-07-29, fixes landed on the dash) |
|---|---|---|
| Release renderer idle busy (5 heavy cards, 07-29 06:40) | 13.8% (581/4210 samples) | **8.3%** — three 5s idle samples at 11:12 on the post-fix release bundle (11:09 build, `data-static` present in the shipped CSS and JS): 8.5% / 8.1% / 8.3%, i.e. 351/4119, 331/4099, 334/4041. The deck was not certified card-for-card identical to the baseline's five, so the frame counts below are the comparable signal; the pre-fix re-check is the same-day, same-machine, active-session comparison at 24.2% |
| — compositing walk after style / after layout | 167 / 124 samples | **85 / 45** (pre-fix re-check: 424 / 101) |
| — ResizeObserver gather / IntersectionObserver | 67 / 32 samples | **29 / 21** |
| Restored heavy card (820×620 harness window, production bundle) idle busy | 2.9–4.0% | **2.0%** — at the empty-deck floor (2.4% below) |
| — elements / stacking contexts / max depth | 16,249 / 1,603 / 37 | 16,249 / **725** / 37 |
| — pulsing dots / their stacking contexts | 438 / 1,314 (82%) | 438 / **0** (438/438 `data-static`; dot/ring buckets absent from the histogram) |
| — retained finished CSSTransitions | 415 | **0** |
| — typing busy, continuous native typing into the composer | (not measured pre-fix) | 65.9% baseline; 65.8% with sticky headers forced static; 62.9% with all 506 ResizeObservers disconnected (#sticky-headers — both absolved) |
| — cells carrying `content-visibility: auto` | 46 of 47 | unchanged |
| Empty 3-session deck idle busy | 2.4% | — |
| Caret blink A/B/C (steps / linear / none) | 1.6% / 1.3% / 1.4% | — (exonerated; [Q07] settled) |
| Sample files | `/tmp/tug-webcontent-sample.txt`, `/tmp/tug-rel-2.txt`, `/tmp/zz-*-*.txt` | `/tmp/zz-heavy-census-{A,B,C}-*.txt`, `/tmp/zz-rel-before-recheck.txt` |
