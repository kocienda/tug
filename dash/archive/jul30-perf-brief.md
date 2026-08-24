# Perf brief 30 — contained motion, surface by surface {#top}

Successor to `dash/jul29B-perf-brief.md`. That brief ended with the idle burn attributed to a single mechanism, measured three independent ways on the real release deck (`#record-overlap-law`): **a running `transform` animation forces `computeCompositingRequirements` over the entire page's layer tree on every rendering update, priced by total mounted layer population; an `opacity` animation costs zero; `will-change` is irrelevant to both.** The walk is a threshold, not a proportion — one transform animation on the heavy deck costs a walk of 85 samples/5s, all thirty cost 112, zero costs 0. Static content is free at any size. Sticky pins are exonerated. Style invalidation is properly scoped and is not being defeated; the global structure is the `LayerOverlapMap`, by construction.

This brief attacks the problem **bottom-up, by surface**. The top-down framing ("make the engine term go away") produced the law but not the plan; the plan falls out of an inventory fact instead: the complete census of continuous animation on the real working deck at idle was **41 running animations — 30 pulsing-dot loops, 6 wave bars, 1 caret blink, 4 sparkline track tweens — and nothing else.** Five surfaces animate pervasively and at volume in Tug. Each gets its own workstream, its own definition of quiet, its own cheap mechanism, and its own measured exit. The engine-level goal (a silent settled deck, contained motion while working) is not enforced from the top; it falls out when every surface honors its contract.

**State of play:** S1 and S2 are done ([#s1-caret], [#s2-sparkline]). S2's execution produced the brief's deepest conceptual gains — the event clock ([D7]) and the no-news wire contract ([D8]) — plus a sixth animated surface the census was structurally blind to (timer-driven typographic motion, the Pulse readouts; see I4's timer census). S3–S5 inherit both laws as templates.

Two standing constraints from the design discussion that produced this brief:

- **Opacity-only motion is rejected as doctrine.** Motion design keeps its channels — scale, translate, whatever the gesture calls for — provided the animation qualifies for contained residency (defined under [D2]). Opacity-only authoring is a fallback of last resort for a motion that provably cannot qualify, never the default.
- **No WKWebView-per-pane work in this brief.** The single-page deck model gets maximized first; per-pane process isolation and host-side pane composition are follow-up app architecture, to be designed with full knowledge of these findings, not reached for as an escape hatch.

**Process:** this brief is the map, not the recipes. The five workstreams are worked **interactively on `main`, one surface at a time, each advancing only on the user's explicit call** — no batch plans, no dash ceremony; the user vets each surface live (debug build / release deck) and lands the commits. Nothing here authorizes autonomous implementation.


## The doctrine, firm {#doctrine}

The laws this brief exists to prove out and then codify in `tuglaws/animation-doctrine.md` (`#tuglaws-doc`). D1, D4, D5, D6, D7, and D8 are fully evidenced; D2 and D3 depend on investigations I1/I2.

**[D1] The quiet contract — every animated surface owns its silence.** Every surface that animates continuously has a data-driven notion of *quiet* that only its owner component can know: no data flowing, no work in flight, no gesture underway. The contract: **when my data is quiet, I am motion-silent and animation-object-free** — no running animations, no live timers driving repaint, no retained finished `CSSTransition`s (WebKit keeps finished transition objects in `getAnimations()` forever; shedding them is part of going quiet, which is what the pulsing dot's `data-static` demotion already does). A settled deck is then zero running animations *by construction*, surface by surface — assertable via `/api/eval` census and enforced in the idle-silence gate (at0291) as an invariant, not a hope. This is the first law of the doctrine and the organizing principle of the work plan.

**[D2] Live-work motion runs in the contained form.** A glyph depicting in-flight work may scale, translate, breathe, and wave, in any channel motion design calls for, **provided the animation qualifies for contained residency**: compositor-resident, invalidation bounded to its own layer and below — never rippling above the fixed-size box that hosts it — no per-frame overlap rebuild. The contained form is not yet a recipe — producing it is I1/I2's job — but its existence is proven inside this app today: the four sparkline WAAPI transform tweens ran with the whole-page walk at **zero** while every CSS loop was suppressed (jul29B leave-one-out, condition P3).

**[D3] The cost of motion is paid once, at authoring time, through the Tug animation API.** No raw `@keyframes` or bare `element.animate()` in product surfaces once the API exists (`#tug-animation-api`). Every motion primitive declares its residency class, and the class is *verified by measurement in the gallery bench*, not asserted in a comment.

**[D4] When real work is in flight, honest cost is acceptable; at rest, none is.** A session actively streaming is not idle — paying rendering cost to depict genuinely live work is defensible even before the contained form lands. Indefensible is paying it at rest: stuck in-flight indicators, breathing glyphs on settled sessions, decorative loops. The gate between quiet and motion is the truthful liveness of the thing depicted, derived from real state (turn phase, feed activity), never from "the card is mounted."

**[D5] Measurement discipline is part of the doctrine.** The binding method rules, dearly bought and recorded in jul29B `#record-overlap-law`: release-main is not a controlled environment (interleave baselines, repeat, take medians, discard runs whose baselines disagree); an occluded window does no rendering work and voids the run; suppress animations with `animation: none` via a probe sheet, never WAAPI `pause()` (pausing demotes to the main thread and reads *worse*); count leading sample integers from raw trees, never grep line counts; profile release builds only, via the dash-release lab.

**[D6] Finite transitions must end and must be droppable.** Settle crossings, hover/press states, card chrome — honest one-shots, but each retains a finished `CSSTransition` unless the surface drops it (`transition: none` on the rest state, per the dot's `data-static` pattern). A surface is not quiet until its transition population is zero.

**[D7] The data event is the only clock.** Proven and shipped in S2, and the deepest simplification this brief has produced: **never poll a push system.** Every depiction of live work sits downstream of a data plane that already announces its changes (store events, feed frames, turn-phase transitions); a consumer that runs a standing timer to *ask* whether anything changed is re-deriving, at per-tick cost, a fact the system already pushed for free — and every "detect quiet and stop" mechanism (dormancy detection, idle gating, TTL decay) is a patch on that one mistake. Under D7, quiet is not detected, it is **constructed**: no event, no work, and an idle surface holds zero timers and zero animation objects because nothing is running, not because something noticed. Timers are permitted in exactly one shape — **finishers**: a timer may only complete work a data event started, and must terminate by construction. The finisher discipline, dearly bought from S2's clamp-plateau bug: a finisher finishes the **data's** future, not the pixels' present — a plotted value can hold still (clamped at full scale, or drifting under a display deadband) while the window beneath it is still draining, so a finisher's stop condition must outlive the data horizon the last event touched (the sparkline's settle burst stops only when the value is stable *and* the rolling window has fully drained), never merely observe that the screen stopped moving.

**[D8] No news is no news — the wire contract.** D7 applied at the producer: an emitter publishes **change**, not state — an unchanged reading sends nothing, silence means "unchanged," and consumers hold the last published value indefinitely on the strength of that. Two obligations make the contract sound: the emitter must publish the **falling edge** (a final zero when the measured thing dies — silence must never be ambiguous between "steady" and "gone"), and no consumer may time out a held value (a TTL decay under this contract turns a steady reading into a lie — the deleted `GAUGE_TTL_MS` is the cautionary example). Change thresholds layer by knowledge, each gate owning exactly the judgment it is positioned to make: wire-level dedup at the emitter (tugcast: 0.5% CPU / 4 MiB rss / exact-delta disk), display-grain events at ingestion (the store: 1% of full scale), plot-pixel recognition at the surface (the sparkline: 2px of amplitude). Every gate compares against the value at the last *published/recognized* change — never the previous sample — so sub-threshold drift accumulates against a fixed reference and eventually fires instead of ratcheting under the threshold forever.


## The conceptual target — downward-only invalidation {#containment-target}

The requirement, stated as it was stated: a render box that **does not change its own size**, containing an element that scales or moves within it, must never ripple invalidation higher in the tree than itself. The motion's consequences flow to that layer and its descendants, never upward.

The platform's obstacle is that painter's order is document-global — any layer may in general overlap any other, so a moving layer means re-deciding who else needs compositing. But WebKit carries two mechanisms that bound exactly this, and I1's whole question is which authoring forms engage them:

1. **Animation extent.** `computeExtentOfTransformAnimation` (present in the jul29B samples) computes the union bounds of a transform animation's entire journey so overlap can be reserved **once**, for the whole envelope, instead of re-walked per frame. A breath scaling 0.35→1.0 inside a fixed 32px box has a trivially computable extent. Something in the current authoring defeats this, or defeats acting on it.
2. **Overlap clip scopes.** The `LayerOverlapMap` maintains clipping scopes: a composited container that clips its descendants (`overflow: hidden`, `contain: paint`) bounds their possible overlap to its own box. A glyph inside such a scope should be provably unable to affect anything outside its 32px box.

If either mechanism can be reliably engaged by authoring — a property, a wrapper, a keyframe form — then "place dots and waves wherever we want" is achievable in the current single-page model, and the recipe becomes the heart of the Tug animation API. If neither can, that is a finding with teeth: the containment the pane model wants does not exist inside one WebKit page, and the follow-up architecture round inherits it as a hard input. Either way the groping ends: measured, named, written down.


## The five surfaces {#surfaces}

The complete inventory of pervasive, at-volume animation in Tug today, confirmed by census on the real deck. Each workstream states its quiet contract ([D1]), its cheap mechanism while legitimately running ([D2]/[D4]), and its measured exit. Ordering within the plan is the user's call; dependencies on the supporting investigations are noted per workstream.

### S1 — Caret blink (TugTextEditor / CM6) {#s1-caret}

**Status: done — and it is the template.** Moved to sampled opacity hold-stops under `linear` (jul29B), compositor-resident, measured free on the heavy deck (`applyKeyframeEffects` 0, walk contribution 0 — opacity animations do not touch the overlap map). Typing already suppresses it via `[data-tug-text-editor-typing]`.

- **Quiet contract:** honored in the strong form, verified on the live release deck in all four rest states — unfocused editor (`animation-name: none`, 0 animation objects), window not key (WebKit blurs the element on deactivation; the blink object disappears entirely), active typing (`animation: none`), mid-drag (`display: none` — which measured as a *cancel*, not a pause: 0 objects during, restart at phase 0 on release, so the caret lands solid at the click point; the stronger quiet mechanism, noted for reuse).
- **Cheap mechanism:** compositor-free residency class, proven. The `theme.ts` mechanism comments were corrected in place (CM6's `LayerView` builds its layer DOM once — the phase reset comes from the drag rule's `display: none`, not a per-selection rebuild).
- **One census blind spot, found here:** `TugInput`/`TugTextarea` render native `<input>`/`<textarea>` whose WebKit caret blink is a main-thread repaint timer, not a `KeyframeEffect` — invisible to `document.getAnimations()` and thus to every census this phase has run. Only one thing holds focus at a time so it doesn't add to the settled-deck count, but it is the same instrument gap as the readout timers found in S2; I4 gains a timer census because of it.
- **Exit (remaining):** none beyond citation — S1 is the worked example the doctrine and the API document point at.

### S2 — Sparklines (Pulse) {#s2-sparkline}

**Status: done — shipped as a reconception, not the planned patch, and it is the template for D7/D8.** The planned work was "extend dormancy to gauges." The actual finding was that dormancy itself was a patch on the real defect — **the entire Pulse system polled a push system.** Data was already event-driven end to end (tugcode/tugcast push ACTIVITY frames as work happens); on top of it sat a standing 4Hz sampler per tape, a perpetual 250ms easing interval per readout row (a *sixth* animated surface the inventory missed — typographic motion by timer, invisible to `getAnimations()`), and dormancy machinery whose whole job was to detect that polling had been finding nothing. All of it replaced by the event clock ([D7]):

- **The clock plane, rebuilt.** The store's `record()` gained the ingestion change gate (rate `units > 0`; gauge moved ≥1% of full scale vs the published reference) and pushes per-session, channel-tagged activity events; `subscribeRateActivity` became `subscribeActivity`, dissolving the rate/gauge asymmetry (jul29B [H2] is no longer expressible). The tape appends only downstream of events; its two timers are finishers — a settle burst (250ms cadence, stops when the plotted value is stable ≥2 ticks **and** the rolling window has drained past the last event) and one flat-off timeout that retires the WAAPI scroll once the last recognized change scrolls off. Change is recognized in plot pixels (2px of amplitude vs the reference at last recognized change), so a steady or sub-pixel-jittering gauge is as inert as a zero rate. The readout's easing became a glide burst: armed by events, terminated by its own no-write gate (the convergence fact it was already computing and discarding). The geometry's held tail (the pen draws the last value flat to the right edge) is what makes "a flat line needs no new points" literally true — the load-bearing fact of the whole rework.
- **The wire, quieted ([D8]).** tugcast's resource sampler publishes only moved gauge channels (0.5% CPU / 4 MiB rss / exact-delta disk, referenced to last-published), sends no frame when nothing moved, and flushes one final all-zero frame when a session leaves the live set; the deck's `GaugeMeter` holds indefinitely (TTL deleted — under this contract a decay is a lie). The 1Hz OS sampling cadence itself is unchanged ([Q02]); only publication is gated.
- **Net:** an idle session's Pulse chain — OS sampler → wire → frame handler → store → tape → readout — is silent end to end, each stage silent because the stage before it sent nothing. A Pulse card that idled at 6 tape timers + 6 readout timers + 6 tweens (~48 wakes/s) now idles at zero of each, by construction.
- **The bug that taught the finisher rule:** the settle burst's first stop condition was value-stability alone; an end-of-turn flush clamped the curve at full scale while the window drained under it, the burst quit mid-drain, and the tape froze at max (user-caught on the live deck). The fix — outlive the data horizon, not the pixel stillness — is now [D7]'s finisher discipline verbatim.
- **Remaining (moved to I1):** the WAAPI tween's walk-free characterization. The tween now *stops* at idle, so the lab bench is the only place left to isolate why it never priced the walk — the property S3/S4 need named before they can inherit it.

### S3 — TugProgressIndicator `pulsing-dot` {#s3-pulsing-dot}

The volume champion: 30 of the 41 idle animations, 10 live glyphs — 6 in one session card's telemetry status bar, 3 in Lens session rows, 1 in a tool-call header. 1,341 dot elements mounted (most already static/skipped — the `data-static` demotion works; the problem is the *running* population and its per-tick price).

- **Quiet contract — only truthful liveness breathes, driven by the event clock.** A dot animates only while the session/tool it depicts is genuinely in flight ([D4]), and per [D7] its arm/disarm must ride **data events** — turn-phase transitions, feed liveness edges — never mount state, render passes, or anything polled. Audit the six status-bar glyphs: any depicting settled sessions demote to `data-static` (machinery exists — this is a gating bug, not new machinery), and the audit's real question is *which event's falling edge each glyph missed*. Lens rows breathe only for sessions actually running. Settled decks reach zero dot animations by gating alone, before any recipe work.
- **Cheap mechanism while running:** the contained form from I1/I2 — the honest two-or-three breathers cost nothing regardless of deck size, keeping the full motion design: scale breath, emitted ring, ignition advance, phase-locking. Already exonerated: `calc(var())` keyframe stops are not the problem (measured identical to literals); `will-change` refusal stays but its stated rationale gets corrected in I2's docstring pass.
- **Depends on:** I1 (recipe), I2 (application). The gating half depends on nothing and can ship first.
- **Measured exit:** settled deck → zero dot animations (census); one running dot on the 12k-layer bench → walk delta ≤ noise ×3 medians; motion design visually intact (gallery A/B against current).

### S4 — Wave (thinking indicator) {#s4-wave}

TugProgressIndicator's `wave` variant: three phase-locked `scaleY` bars, 960ms, in in-flight footers (and kin). Inherently in-flight-only — its whole existence is [D4]-honest — so its problem is different from S3's:

- **Quiet contract — stop reliably.** The two `.tug-transcript-entry__inflight-footer` waves observed animating on a *settled* deck are a broken quiet contract — in [D7] terms, a **missed falling edge**: the wave's stop must be downstream of the turn's own end events, on every path those events can take (normal end, cancel, error, wedge-recovery). Root-cause in the state machine, not the CSS, and fixed regardless of everything else in this brief. S2's clamp-plateau bug is the instructive sibling — both are depictions that outlived the data they depicted because the falling edge wasn't the thing that stopped them.
- **Cheap mechanism while running:** the I1/I2 contained form, same recipe as S3.
- **Depends on:** stuck-footer fix — nothing; contained form — I1/I2.
- **Measured exit:** settled deck → zero wave animations across all turn-end paths (app-test the falling edges); one running wave on the bench → walk delta ≤ noise.

### S5 — Imposer pane motion {#s5-imposer}

**Status: done — motion and the notification hold both landed and measured 2026-07-30 (release build of `tugdash/imposer-flip`, since joined to `main`).** Plan and step ledger: `dash/imposer-pane-motion.md`.

The premise line below — "an in-page transform on a pane root is a whole-page walk per frame" — is superseded by I1's law and by the numbers here. It holds only for non-qualifying forms.

**What the settle is now.** Layout snaps in one commit and the crossing is a FLIP transform tween per moved frame, authored in I1's qualifying form and run through TugAnimator (`tugdeck/src/lib/pane-flip.ts`, `deck-canvas.tsx`). The old motion transitioned `left`/`top`/`bottom`/`width` and crossed the pinned Lens by interpolating a registered custom property that `left` re-read through a `calc()` — per-frame *layout*, a cost class above the walk.

**Instrument.** Release builds cannot run the app-test harness (`window.__tug` is installed only under `__tugTestMode`, whose `WKUserScript` is `#if DEBUG`-gated in Swift). `window.tugdeck.lab` — `dispatch` and `seedDeck`, both thin wrappers over paths the app already runs — makes a release scenario scriptable through `/api/eval`, which stays behind the `diag/eval` default. Scene: two imposed panes + pinned Lens, 4,000 composited boxes planted inside the two moving subtrees. Runners are checked in under `diag/imposer-*.sh`. Statistic is samples in `RenderLayerCompositor::computeCompositingRequirements`, [D5] discipline throughout (unoccluded, interleaved, ×3, medians, leading sample integers).

**The walk is per-gesture, not per-frame — the falsifiable form.** A fixed 4s window with only the *number* of arrangement changes varying. Per-frame cost would read flat across all three; it tracks gestures and nothing else:

| gestures in the window | walk samples (×3) | median | per gesture |
|---|---|---|---|
| 0 (idle) | 0, 0, 0 | **0** | — |
| 4 | 128, 119, 139 | 128 | 32.0 |
| 8 | 285, 290, 308 | 290 | 36.3 |
| 16 | 669, 692, 658 | 669 | 41.8 |

Idle is exactly zero across every run — the quiet contract, measured. The forcing probe (the same frames driven by per-frame rAF transform mutation, the disqualifying form) read **2622** in the same window against the settle's 290, which is what proves the instrument is live rather than dead: without it, "the settle measured near-zero" and "the probe is broken" are the same reading.

**Correction to the plan's floor: three walks per gesture, not two.** At ~11 samples per walk (from the forcing probe's 2622 over ~240 frames), 32–42 samples per gesture is three walks, not two. The plan counted the animation's start and land and missed the third: React's own commit of the new geometry dirties compositing before either tween exists. The mild rise with cadence (32.0 → 41.8) is retargeting — at a 250ms cadence gestures land inside the 300ms window and each cancel-and-restart adds a pair.

**[Q01] nested transform animations — accepted, not load-bearing.** 48 infinite accelerated scale loops planted inside the moving panes, same 8-gesture window: 365 → 399 median (+9%), with p95 frame delivery unchanged. Bounded, no layer-count explosion, no escalation warranted.

**[Q02] the freeze — RULED IN, superadditively.** Three-way attribution over the same window, 67 real deck-store commits (`focus-pane` alternating, validated as landing — the first attempt used `cycleCard`, which is a no-op when every pane holds one card, and measured an empty condition):

| condition | walk median | dropped frames >25ms (×3) | median frame |
|---|---|---|---|
| settle alone | 343 | 10, 10, 11 | 17 ms |
| commits alone | 654 | 23, 26, 29 | 17 ms |
| settle + commits | **1809** | **39, 43, 45** | **20 ms** |

Additive prediction 997; actual 1809 — **81% superadditive**. A commit landing *inside* the gesture window costs far more than the same commit landing outside it, because it dirties compositing while an animation extent is reserved and forces the recompute the reservation exists to avoid. The motion degrades with it: median frame delivery 17 → 20ms and four times the settle's dropped-frame rate. This is precisely the cost the kink-the-hose sequence was hypothesized to prevent, so the hold ships (`dash/imposer-pane-motion.md#step-7`).

(The frame threshold is >25ms, not >16.7ms: this panel is 60Hz and delivers a median 17ms interval *at rest*, so a 16.7ms threshold marks ~60% of an idle page late.)

**What the hold buys, measured after it shipped.** Same scene, with a fourth condition in which the commit driver defers while the container wears `data-imposer-settling` and flushes when the window closes — deferred, never dropped, which is exactly `CodeSessionStore.holdNotifications`'s contract:

| condition | walk median | dropped frames >25ms | median frame | commits landed |
|---|---|---|---|---|
| settle alone | 327 | 12, 7, 5 | 17 ms | 0 |
| commits alone | 578 | 17, 18, 19 | 17 ms | 66 |
| settle + commits | 1556 | 52, 56, 57 | 21 ms | 66 |
| **settle + held** | **386** | **15, 15, 13** | **17 ms** | **66** (59 deferred) |

Holding through the window recovers **95% of the interaction penalty** — 1556 back down to 386, within noise of the settle's own 327 — returns frame delivery to its settle-alone median, and cuts dropped frames from ~55 to ~14. Every one of the 66 commits still landed; 59 of them simply waited. p95 rises slightly against settle-alone (31 vs 23) because the flush at window close is a burst, which is the honest shape of deferral and is well inside budget.

One scoping note, so the number is not read for more than it says. This condition defers at the *driver*, because the driver is a **local** deck-store action and the store's hold deliberately never defers local-origin events — a user's own gesture must not look ignored. What ships holds **wire-origin** session-store notifications, the streaming-card token traffic that is the real-world source of mid-window commits, and needs a live turn to produce. So the table measures what suppressing mid-window commits is *worth*; the store's hold is that suppression applied to the path that carries it in production, and its semantics are pinned at the store layer by `code-session-store/__tests__/notification-hold.test.ts`.

The original sequence, for the record:

1. **Freeze** — halt feed/store delivery to the card(s) in the moving pane (the same muscle HMR/replay gating already exercises); let React commit and layout fully settle so nothing dirties mid-gesture. In [D7] terms the whole sequence is the event clock at pane scale: freezing IS suspending the pane's data clock, and with every surface event-driven (S1–S4), suspending the clock provably silences the pane — there are no standing timers left inside it to tick through the drag.
2. **Promote** — the settled pane becomes one static composited layer (its content neither paints nor re-lays-out during the move).
3. **Move** — a single transform animates that layer. With S1–S4 quiet contracts honored, it is the *only* running animation: the per-frame walk exists but competes with no other dirt, and the population term is the only price.
4. **Land** — snap to final geometry, drop the promotion.
5. **Unkink** — resume delivery; one coalesced catch-up render applies everything that arrived during the move.

- **Quiet contract:** no standing animation between gestures — the imposer contributes zero to idle by construction; promotion and its layer are shed on land ([D6]).
- **Depends on:** S1–S4 (a frozen pane buys little if dots and sparklines tick through the drag); I3 lowers the walk's population multiplier for the frames that do pay it.
- **Measured exit:** a scripted pane move on the heavy deck holds frame budget (no main-thread frame over budget in the sampled gesture window); zero mid-gesture React commits from the frozen card; zero residual animations/layers after land; data catch-up correct after unkink (app-test).
- **Flagged for the architecture round:** if the measured gesture cost is still unacceptable after freeze+quiet+diet, pane motion is the first candidate to leave the page for host-side composition — recorded here so it is not re-derived, out of scope in this brief.


## Supporting investigations {#investigations}

Service roles for the workstreams — none is a deliverable in itself.

### I1 — the sparkline exception (feeds S3, S4, S5) {#i1-sparkline-exception}

**Status: done — measured 2026-07-30 on the idle-hunt lab bench and confirmed on release-main.** The question was which axis of the sparkline's authoring made its four WAAPI transform tweens walk-free while a 6×16px `scaleY` probe cost 85. The answer is none of the five hypothesized axes: on the shipping WebKit, **every cleanly-authored animation object is walk-free**, and the walk is the signature of something else entirely.

**The two-part law, source-verified** (WebKit trunk, `RenderLayerCompositor.cpp` / `KeyframeEffect.cpp` / `RenderElement.cpp`):

1. The per-frame whole-tree walk is caused by **per-frame main-thread transform style commits**, not by transform animations as such. A software-ticking animation invalidates style every rendering update; any transform-family diff trips `recompositeChangeRequiresGeometryUpdate` → `setNeedsPostLayoutCompositingUpdate` → the requirements traversal. `will-change` is irrelevant because the trigger is the style diff, not compositing status; opacity is exempt by construction (absent from the geometry-update property list — its value pushes straight to the compositor layer even when software-ticked).
2. A **completely accelerated** effect stops ticking entirely (`ticksContinuouslyWhileActive()` false): one requirements walk at animation start reserves the union of the whole journey in the overlap map (`computeExtentOfTransformAnimation` → `setAnimationExtent`), then zero walks per frame at any population, for any journey length. "Completely" is the sharp edge — one non-accelerable property in the same effect, or one blocked animation elsewhere on the element's effect stack (`KeyframeEffectStack::allowsAcceleration`), and the effect ticks anyway. Extent certainty fails only on 3D transforms, NaN keyframe offsets, or nested (self + ancestor) transform animations.

**The bench matrix** (idle-hunt lab at current main, 12,200-box population, unoccluded per D5, interleaved no-probe baselines, ×3, `sample`-derived counts): every animation-object condition read walk ≈ baseline (0–3 samples/5s) — WAAPI `translateX` finite, WAAPI translate+opacity mixed in one effect (opacity is itself accelerable, so the mix stays completely accelerated), CSS `@keyframes` translate, WAAPI and CSS `scaleY` `infinite`, the jul29B probe replica (`position: fixed` body child, CSS `scaleY` 960ms `infinite`), `steps(4)` easing, and a 420×700 pane-sized mover. Threaded animation resolution on this WebKit evidently swallows even the historical blockers (`steps()` accelerates). Bench validity was proven by a forcing probe: an rAF loop mutating `el.style.transform` per frame lit the walk to 18 with `updateRendering` 21, from ≈0 — the population participates; the animation forms genuinely never wake it.

**Confirmed on release-main** (the real ~26k-layer deck, interleaved ×3): a 420×700 fixed-position pane tweening `translate(0,0) → (500px,80px)` via `element.animate()` read walk 68/85/81 against neighboring baselines 76/88/63 — median delta ≈ 0. The S5 mover is free on the exact surface that will run it.

**The qualifying form** (the recipe S3/S4/S5 inherit): one `element.animate()` — or CSS animation; the API axis [Q5] is confirmed a proxy — whose keyframes touch **transform-family properties only** (nothing else in the effect), strictly 2D, explicit two-plus keyframes, `composite: replace`, sane easing (bezier/`linear` keyword), `playbackRate` 1, forward direction, non-zero duration, no other blocked animation on the same element, no ancestor transform animation running concurrently. **The disqualifying delta**: driving motion by per-frame style mutation from JS (rAF), or any condition that demotes the effect to software ticking. For long moves, `fill: forwards` + commit once at landing — one walk at start, one at land, zero between.

**Residue, recorded honestly:** the jul29B 38–85-walk probe could not be reproduced with a cleanly-authored replica on either surface. Those measurements were taken with app animations suppressed via an `animation: none` probe stylesheet with the probe layered on top; the one acceleration blocker that survives on modern WebKit is cascade/`!important` interaction, which is exactly the shape of a probe fighting a suppression stylesheet. The jul29B law stands, narrowed: *software-ticking* transform walks, opacity never does. The old probe's exact demotion cause is unrecovered; nothing downstream depends on it.

Hypothesis verdicts: [Q1] clip scope — not load-bearing (unclipped fixed-position probes are walk-free); [Q2] `infinite` — not load-bearing; [Q3] `position: fixed` — not load-bearing; [Q4] scale vs translate — not load-bearing; [Q5] WAAPI vs CSS — a proxy for acceleration eligibility, not an axis. Implication for I2: largely moot — the dot already lives in the qualifying form (its `linear()`-easing battle, recorded in `tug-progress-pulsing-dot.css`, was this same law encountered early); what remains of I2 is asserting the primitives' forms against the census, not rebuilding them. Implication for S5: the brief's premise that "an in-page transform on a pane root is a whole-page walk per frame" holds only for non-qualifying forms — a qualifying pane move pays two walks per gesture (start, land), not one per frame.

### I2 — the contained-glyph recipe (feeds S3, S4) {#i2-contained-recipe}

Apply I1's qualifying form to the real primitives in the gallery: rebuild the dot's breathe/emit pair and the wave's three-bar loop in the qualifying form inside their existing fixed-size boxes; measure on the lab against the synthetic population. If the qualifying form cannot express the current envelopes (e.g., extent reservation conflicts with the ignition-advance structure), document the exact conflict and bring the minimal design delta to the user as a decision — the [D2] fallback ladder, exercised only on proof.

### I3 — layer-population diet (feeds S5, and any non-quiet moment) {#i3-population-diet}

The multiplier side, second priority: containment zeroes the term, dieting only divides it. Transcripts carry 26,374 layer-minting elements of 61,676 (`position: relative` 12,666, `overflow` 9,175, `position: sticky` 1,713, `z-index` 1,986, `contain: content` 789). Audit the top two classes for necessity — relatives whose z-index never engages, stale positioning-context scaffolding, overflow clips on elements that never clip. Every removal class gets its own A/B on the lab bench (walk cost under a deliberately non-qualifying probe — the multiplier is only observable while something animates). No sweeping CSS rewrites on spec.

### I4 — instrument hardening (serves all) {#i4-instruments}

(a) an **occlusion guard** in the profiling path — refuse to sample, or stamp the output, when the target window is occluded (`CGWindowListCopyWindowInfo` on-screen state, or an eval heartbeat asserting rAF delivery); (b) fix `scripts/perf-resize-profile.sh` bundle-id matching for dash-release bundles (`dev.tugtool.app.release-tugdash-<name>` — the lsof cache-dir match fails; newest-WebContent-by-start-time is the manual workaround); (c) **re-verify the lab's 0.9% idle on an unoccluded window** — it predates the occlusion discovery and is suspect; (d) a `diag/anim-census` eval snippet checked into the repo (running animations by name/target/playState, walk-relevant counts, retained-transition count) so the census stops being retyped by hand — it is also the assertion body for every workstream's quiet-contract exit; (e) a **timer census** beside the animation census — S1 (native `<input>` caret) and S2 (readout easing intervals) both found timer-driven motion that `document.getAnimations()` is structurally blind to, so a quiet claim backed only by the animation census is incomplete; instrument standing `setInterval`/rAF wakes (dev-build wrapper or Timers-instrument sample) or the [D7] audit has no meter.


## The Tug animation API {#tug-animation-api}

The end state [D3] points at, finalized after I1/I2 land the recipe: motion in Tug is authored through a small set of primitives whose residency class is declared, measured, and enforced — the way theme tokens made color sovereign and TugListView made lists measured-height-only.

- **Residency classes**, named in code: `compositor-free` (opacity/filter — zero cost at any population, proven by S1), `compositor-contained` (transform in the I1 qualifying form — zero walk, proven by bench), `main-thread` (everything else — forbidden in product surfaces; available to gallery benches only).
- **The quiet contract as API surface**: primitives expose arm/disarm driven by owner liveness, and disarm means animation-object-free ([D1]/[D6]) — the `data-static` demotion generalized, not reinvented per surface.
- **The event clock as API surface ([D7]/[D8])**: primitives take a data-event subscription as their clock, never a polling cadence; the only timer shape the API offers is the **finisher** (event-armed, self-terminating, stop condition bound to the data horizon — the sparkline's settle burst and the readout's glide burst as the two worked examples). Producers feeding the primitives follow the wire contract: publish change with its falling edge, hold indefinitely, threshold-per-gate by what each layer knows (wire dedup / display grain / plot pixels).
- **The primitive layer**: a motion module owning keyframe construction, the qualifying-form wrapper (whatever I1 proves load-bearing), phase-locking helpers (the dot's shared-clock/drift machinery generalized), and the settle/handoff pattern (pin live pose inline, drop animation, transition to rest).
- **Enforcement**: a gallery bench per primitive mounting it against the synthetic population and asserting walk delta ≤ noise via the lab harness (on-demand measurement benches, not CI sweeps); a lint that product code doesn't reach for raw `@keyframes`/`element.animate()` outside the primitive layer.

## The tuglaws document {#tuglaws-doc}

Once I1/I2 convert doctrine-in-waiting into proven recipe, write `tuglaws/animation-doctrine.md` (with INDEX.md entry): D1–D8 in final form with the quiet contract and the event clock as the two organizing laws; the residency classes with their measured price table (the jul29B/jul30 numbers as permanent evidence); the qualifying form as an authoring recipe; S2 as the worked example of the event clock end to end (producer gate → store gate → surface finishers); the falsification method (how to bench a new primitive before shipping it); cross-references into [L06]/[L13] (deepened, not replaced) and `pane-model.md` (what containment the pane model can and cannot promise inside one page). Reconcile the dot's inline docstring (correct on `linear()` easings; superseded on `will-change` reasoning) to cite the law doc.


## Carried forward from jul29B {#carried}

Standing items, re-ranked, not part of the five surfaces:

1. **TugListView per-cell ResizeObserver** (~1.1% of the 5.8%): unobserve cells while `content-visibility: auto` skips them; re-observe on `contentvisibilityautostatechange`; the width-invalidation stamp-strip path must explicitly re-observe or unobserved-while-skipped cells keep stale intrinsic sizes forever. Load-bearing machinery — own pass, own test.
2. **selection-guard autoscroll watchdog** — a lost `pointerup` pins `runAutoscrollTick` in a permanent 60/s rAF loop (measured +2.1% from the wake alone). Zero-delta watchdog. Latent wedge, not current residual.

## Exit criteria {#exit}

- [x] S2: **done** — the Pulse system is event-clocked end to end ([D7]) and the wire honors no-news-is-no-news ([D8]): idle → zero sparkline/readout timers, zero animation objects, zero gauge frames; live rows unaffected (settle burst runs at the old live cadence); user-verified on the debug build including the end-of-turn decay. Unit + app-tests green (`at0230`, `at0292`, `at0293`).
- [ ] S3: settled deck → zero dot animations by gating; running dot on the 12k bench → walk ≤ noise, motion design intact.
- [ ] S4: stuck footers root-caused and fixed; all turn-end falling edges verifiably still the wave; running wave → walk ≤ noise.
- [x] S5: **done** — arrangement motion is measured FLIP through TugAnimator (idle walk exactly zero between gestures; settle + held commits 386 walk samples vs 327 settle-alone, frame budget held at the settle's own median); catch-up is the hold's single release flush, deferred never dropped (store-layer tests + 66/66 commits landed in the lab run). App-test `at0294`, hold tests in `code-session-store/__tests__/notification-hold.test.ts`.
- [ ] I1 verdict recorded: minimal qualifying form + minimal disqualifying delta, ×3 medians, confirmed on release-main.
- [ ] Release-main unattended idle ≤ **1.5%** ×3 (medians, D5 method) with the full working deck mounted and all sessions at rest.
- [ ] `tuglaws/animation-doctrine.md` written and indexed; animation-API primitive layer landed or explicitly scoped into its own follow-up plan.
- [ ] Lab 0.9% re-verified unoccluded; profiler occlusion guard + dash-bundle matching fixed.
