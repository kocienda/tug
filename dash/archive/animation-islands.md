# Animation islands — the pulsing dot at zero marginal cost {#top}

Successor to `dash/jul30-perf-brief.md` S3/S4, opened by the 2026-07-31 live-deck measurement session. The motion design is a fixed input to this work: the pulsing dot is two circles — a scale breath and an emitted ring — exactly as authored, at every size and site it ships at today. The deliverable is the engineering that lets that glyph run anywhere in the app as a true island: motion that affects nothing beyond its own box, at zero marginal cost to typing, streaming, or any other surface. No fallback forms, no reduced variants, no relocation of the glyphs. The wave inherits everything here.

**Status: Phase 0 done (`diag/anim-island.sh`, validated live); Phase 1 lab built (`tests/app-test/at9996-anim-island-lab.test.ts`) and partially run. Superseded as the map by `dash/aug01-perf-brief.md` (the six-surface round) — this document remains the island contract's definition, the walk physics, and the S3/S4 fix recipes that brief cites.** Last updated 2026-08-01.

## Phase 0/1 findings so far {#findings-0731}

- **Running glyphs are free at rest, at every weight tried.** Lab, 11k and 34k nodes, 36–39 running animations (dots + waves): 60fps, zero long frames, zero walk excess. jul30 S3's unchecked exit box, now measured twice.
- **Token streaming does not implicate animations at lab weight.** stream-hot ≡ stream-cold ≡ stream-quiet (~46fps, ~85 long frames at 50ms cadence, 11k nodes): the streaming render cost is real but animation-independent, and the meter read **zero events** — no restarts, no glyph-subtree writes, no unmounts, no aged transitions. On the synthetic text-streaming path the glyph is already a perfect island.
- **The live deck, by contrast, churns events continuously.** A 36-minute armed window on the release deck: 491 animation starts, 442 cancels — dominated by the **prompt editors' CM6 caret layer** (36 and 33 restarts on two editors) plus restarts on a session-status dot. The live deck restarts animations; the lab's text-streaming never does.
- **Working hypothesis for the next cells:** the live burn rides the **turn/tool lifecycle**, not token flow — tool_use→tool_result cycles drive glyph state crossings (settle transitions, demotions, remounts at entry boundaries), which is exactly the event class the text-streaming cells never exercise. Next lab iteration: a `tool-churn` cell (tool_use/tool_result pairs at cadence) × dots present/suppressed, at heavy weight.
- **Lab defect to fix first:** at 34k nodes the stream-hot cell hung on a `driveSession ingestFrame` RPC that never returned (page stayed alive — steady ~8% updateRendering / ~3% walk with glyphs running and no traffic). Each ingest needs a timeout guard, and the cell loop a hard iteration cap.
- The caret-layer restarts are a separate confirmed finding for the typing path: the blink animation is torn down and restarted continuously at idle, and caret-reset-on-keystroke makes it per-key under typing. Needs its own cell/fix (CM6 layer rebuild vs `data-tug-text-editor-typing` suppression interaction).


## What the live deck measured {#evidence}

Method: `/api/eval` probe stylesheets on the running release instance (3 sessions mid-work, 109,848 elements, 59 running animations), `sample` on WebContent, statistic = max leading sample count for `Page::updateRendering` / `computeCompositingRequirements` per 5s window. Suppression via a quiet sheet with a `:not(.probe-x)` exemption hole — never `!important` overlays (see [#artifact]).

| condition | updateRendering /5s |
|---|---|
| native baseline (interleaved ×6) | ~1900–2140 |
| pulsing-dot loops suppressed, waves + sparklines still running (×4) | **64–82** |
| any single glyph cleanly exempted — status cell, Lens drift variant, full breathe+ring, in-transcript | ~floor |
| bare transform-animated probes — body child, inside a sticky tool-call header, inside a glyph root, dot-exact absolute+percentage geometry | ~floor |
| the transcript dots of the three working sessions, native | 875–1310 |

Two facts, and they are the whole brief:

1. **A cleanly-running glyph is free.** The full authored motion — multi-stop sampled keyframes, `calc(var())` stops, percentage translate, the ring's two-animation pair, the drift-scaled period — runs accelerated and prices the compositing walk at zero, in every context probed, including the exact spot in the transcript where the native dots burn. Axes individually exonerated by A/B: `calc(var())` stops, `var()`-resolved keyframes, percentage translate, the sticky ancestor, the declared settle transition, the inline base transform pose.
2. **The burn rides the glyphs hosted in hot subtrees.** The in-transcript dots of working sessions carry ~95% of the idle rendering cost, and the cost is not their motion — it is *events on their animations*. Each start, restart, style re-resolution of a running target, or demotion of a co-resident effect bills one whole-document `computeCompositingRequirements` walk (~3–5ms on this deck). At streaming cadence, event churn per commit reads as a continuous burn indistinguishable from a software-ticking animation — which is why jul30's I1 law (accelerated = free) and this measurement are both true.

This is jul30 [Q02] — commits during a reserved animation extent are 81% superadditive — recognized as the general case rather than an imposer-window special case. The transcript inflight glyph runs precisely while its host entry takes commits; the interaction, not the animation, is the bill.


## The walk is WebKit's, the bill is ours {#walk-physics}

The whole-document walk on every animation event is WebCore's design, not Tug's: one page is one compositing scene, painter's order in a scene is document-global, and `RenderLayerCompositor::computeCompositingRequirements` has no scoped form — a compositing-relevant event anywhere re-derives requirements for the whole tree. `contain`, clip scopes, and animation-extent reservation bound what the traversal concludes, never who it visits (jul30 `#containment-target`, confirmed). No Tug-side code change removes the mechanism. The implication is removable anyway, because the bill is **event rate × walk cost**, and both factors are ours:

- **Rate → zero** is the island contract ([#contract]) — steady state emits no events.
- **Cost → sub-millisecond** is the layer-population diet ([#p2b-diet]) — the walk is O(mounted layers) and costs 3–5ms only because the deck mounts ~26k layer-minting elements; at a 5–10× diet, even the legitimate events that always remain (work starting, tools completing, pane gestures) price below perception.
- Separate compositing scenes (WKWebView-per-pane) were tabled and **rejected by the user 2026-07-31** — recorded so it is not re-proposed. The single-page model is the model; rate and cost are the levers.

## The island contract {#contract}

An animation is an island iff its **event rate is zero at steady state**:

- **Started once.** The animation object is created when the depicted work starts and survives until it ends. Zero restarts across any number of host re-renders.
- **Target never re-resolved.** No style recalc reaches the animated spans while the loop runs: no className rewrites, no attribute churn, no inherited-property invalidation that descends into them. A recalc of a running transform target diffs the animated value and trips the geometry-update walk, regardless of what changed.
- **Stack never demoted.** No co-resident effect (a stranded CSSTransition, an `!important` cascade fight) may knock the effect stack off the compositor. One demoted member software-ticks the whole element.

Under the contract, N glyphs cost N walks total — one per work-start — and zero per frame, per token, per keystroke. The glyph's existing componentization is the island's walls; the work below makes the app respect them.

Candidate event sources on the transcript path, ranked, to be discriminated in captivity (Phase 1) rather than argued:

- **E1 — restart on remount.** If any ancestor in the entry chain remounts the indicator under streaming re-renders, every commit restarts the loops. Live-deck evidence: probe classes and inline styles stamped on running dot spans were gone minutes later; a 10s identity check under streaming showed the spans stable — consistent with remounts at entry/tool granularity, not per-token. The restart counter settles this decisively.
- **E2 — style re-resolution of running targets.** Streaming commits rewrite entry-level classes/attributes; if invalidation descends to the animated spans, each commit re-resolves an animated transform. Distinguishable from E1 by zero restarts + nonzero recalc reach.
- **E3 — stranded transitions.** The session's first census caught a CSSTransition on `transform`, playState `running`, on a live dot span — a settle crossing outliving its duration. One such transition demotes the glyph to software ticking until it dies. Transient but recurring; a standing aged-transition counter catches it in the act (a later one-shot census read zero).


## Phase 0 — the meter {#p0-meter}

jul30 I4, done to the standard this session proved necessary. A checked-in census + walk instrument, because the live-deck bisection dissolved into noise exactly as D5 predicted, and because the session reproduced jul29B's own instrument artifact ([#artifact]).

- `diag/anim-island.sh` in the `imposer-lab.sh` pattern: eval-driven census + scripted `sample` wrapper, runnable against any release instance by port.
- The census carries the discriminators, not just counts: per-animation target identity (WeakRef ledger) and `startTime`, so a **restart counter** distinguishes E1 from E2 across a measurement window; per-transition age vs resolved duration, so an **aged-transition counter** catches E3 live; running-target recalc reach (mutation-observed class/attr writes within glyph subtrees).
- Suppression/exemption is the `:not(.probe-x)` cascade hole, codified. `!important` probe overlays are banned in the method: they are themselves the demotion they claim to measure.

### The artifact, recorded {#artifact}

An `!important` probe rule fighting a suppression stylesheet demotes the probed animation off the compositor — the probe *creates* the software-ticking it then measures. This session measured "one dot = 400 walk samples" through that fight; the same dot exempted through a cascade hole measured free. jul29B's unreproducible 38–85-walk probe residue is the same ghost. Any measurement taken through an `!important` override of a live animation is void.


## Phase 1 — reproduce in captivity {#p1-lab}

Dash-release lab, seeded deck, a scripted synthetic streaming driver (ingestFrame cadence as a knob) with one running glyph in the streamed entry. Matrix: {streaming on/off} × {glyph running/static} × {glyph inside/outside the streamed subtree}. Expected reproduction: the ~20× walk delta, present only in the running+inside+streaming cell. Then the Phase 0 counters name the event source: restarts → E1; zero restarts with recalc reach → E2; aged transitions → E3. Multiple sources may be live at once; each gets its own cell.


## Phase 2 — the island, implemented {#p2-fixes}

The fixes land in the glyph's hosting and lifecycle, never its motion. All three tracks ship regardless of which E dominates — each closes a real event channel; Phase 1 decides emphasis and verifies each landing.

- **F1 — identity stability (closes E1).** The indicator element survives any re-render of its entry: stable keys through the entry chain, memoized glyph host whose props are constant while running. Plus `startLoops` idempotence in the component — re-running the effect against an already-breathing glyph at the same phase is a no-op, so even a remount that slips through restarts nothing. Assertable: zero restarts across a 1000-commit streaming run.
- **F2 — recalc firewall (closes E2).** Style invalidation from the app's churn must not reach the animated spans. The strong form makes the componentization literal: the glyph's two circles render into a shadow root with the component's own stylesheet, so ancestor selector invalidation cannot descend; the only crossings are the custom properties the component already treats as its API (fill, size, phase, drift), none of which touches transform. If Phase 1 shows a lighter form suffices (invalidation provably stops above a `contain`ed, attribute-quiet running subtree), ship the lighter form; the shadow boundary is the fallback with a guarantee, and it changes zero pixels.
- **F3 — strand-proof crossings (closes E3).** The settle/crossing machinery gets a watchdog: no CSSTransition on a glyph outlives its resolved duration + slack; violation logs to tugDevLogStore and self-heals (pin pose, drop the transition). The aged-transition counter must read zero on any settled deck — enforced, not hoped.


## Phase 2b — the walk diet {#p2b-diet}

jul30 I3, promoted from "second priority" to a co-equal track: the island contract zeroes the steady-state rate, the diet prices the events that legitimately remain. The transcript's census stands from jul30 — 26,374 layer-minting elements of 61,676 (`position: relative` 12,666, `overflow` 9,175, `position: sticky` 1,713, `z-index` 1,986, `contain: content` 789). Audit the top classes for necessity: relatives whose z-index never engages, stale positioning scaffolding, overflow clips that never clip. Each removal class gets its own A/B on the lab bench under a deliberately event-noisy probe (the multiplier is only observable while something walks). Target: a full walk on the loaded deck ≤ 1ms. No sweeping CSS rewrites on spec — class by class, measured.

## Phase 3 — enforcement, once and for all {#p3-enforce}

- **The lab test, kept.** The Phase 1 scenario lands as a checked-in app-test on the harness: synthetic streaming with running glyphs asserts walk ≤ noise, zero restarts, zero aged transitions. `@covers` the dot component and the transcript entry host. Ratios and counters, never wall-clock budgets.
- **The law, written.** `tuglaws/animation-doctrine.md` gains the island contract as stated in [#contract], with this brief's numbers as evidence and the [#artifact] method rule beside D5.
- **The regression surface.** The restart and aged-transition counters join `lib/perf-monitor.ts` and read out in TugDevPanel, so the day a future change remounts a running glyph or strands a crossing, it is visible in the panel — not rediscovered in a profiling session months later.

## Exit criteria {#exit}

- [ ] Release deck, three sessions streaming, all five glyph sites lit: main-thread rendering cost within noise of the animations-suppressed floor (D5 method, interleaved, ×3 medians).
- [ ] Prompt-editor keystroke latency independent of running-glyph count (at9997-style probe, loaded deck).
- [ ] Zero animation restarts and zero aged transitions across the lab streaming run; counters live in the panel.
- [ ] A single full compositing walk on the loaded deck priced ≤ 1ms after the diet (lab bench, D5 method).
- [ ] Doctrine updated; jul30 S3/S4 exit boxes closed by measurement, through the lab instrument.
