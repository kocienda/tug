# Perf brief 29B — from circling to the bullseye {#top}

Successor to `dash/jul29-perf-tuneup-brief.md`. That brief's program cut idle renderer busy from 13.8% to 8.3% by shrinking composited breadth (438 pulsing-dot stacking contexts → 0, retained transitions → 0, sticky A/B). This brief exists because that is not good enough, and because the remaining cost is **measured but not attributed**. Three charges stand:

1. **The remaining ~8% at idle is unexplained.** We know its shape (86% of busy is `Page::updateRendering`) but not its cause — nobody has named what *schedules* those rendering updates on a deck that is supposedly at rest.
2. **Style recalculation has never been attributed.** `Style::TreeResolver::resolve` holds ~23 samples per 5s at idle (~7% of busy) and we cannot say which component's DOM writes cause it.
3. **There is no guarantee typing won't lag.** Typing busy measured 65.9% on the heavy card; the dominant term (`updateCompositingLayersAfterLayoutIfNeeded`, 241+61 samples) survived both A/B suspects (sticky headers forced static, all 506 ResizeObservers disconnected) and is attributed to nothing. There is no regression gate that would catch typing lag coming back.

The rule for this brief: **no fix ships before its cost is attributed, and no attribution counts until it predicts the profile numerically.** We have been paying for fixes aimed at categories ("animations", "stickies"). The bullseye is a causal model where every busy sample has a name, and the fixes fall out.


## The mechanism model {#mechanism}

Everything measured so far fits one equation:

> **renderer busy = (rendering updates per second) × (cost per update)**

The cost-per-update side is now well understood: each dirty frame pays `Document::resolveStyle`, then **two** full compositing walks (`updateCompositingLayersAfterStyleChange` and, when layout ran, `updateCompositingLayersAfterLayoutIfNeeded`), and each walk's cost tracks the size of the layer tree, not the size of the change. The jul29 program attacked exactly this side and the after-style walk fell 424 → ~79 samples on the same deck. Proven, closed.

The wake side has never been measured. **At true idle nothing should schedule a rendering update at all** — no dirty style, no rAF, no animation events, no observer deliveries. 303 samples of `updateRendering` per 5s means something wakes the page several times a second, forever. Cut wakes to zero and idle busy approaches zero *regardless of tree breadth*; that is the idle bullseye, and it makes the remaining breadth work (which still matters for typing) a separate axis instead of a confounded one.


## Charge 1 — attribute the idle 8% {#idle-attribution}

### The named suspects {#idle-suspects}

Grepped from the live tree, these are the periodic wakers that exist in tugdeck today. Each is a hypothesis to convict or absolve with the waker census (#instruments), not a pre-judged villain — but H1 is a smoking gun on inspection:

**[H1] Pulse-card readout paint — 4Hz per row, ungated, writes on every tick.** `pulse-card.tsx:108` sets `READOUT_PAINT_MS = 250`; the `paint` closure (`pulse-card.tsx:194–213`) runs on `setInterval` for every mounted `ChannelRow` and executes `el.textContent = formatValue(...)` plus `el.dataset.idle = ...` **unconditionally**. Assigning `textContent` replaces the text node even when the string is identical — that is a DOM mutation, a style invalidation, and a scheduled rendering update, 4×/s×rows, at rest. The sparkline beneath the row has a dormancy protocol; the readout above it has none. If a Pulse card was mounted during any idle profile, this alone plausibly accounts for the wake cadence.

**[H2] Gauge sparklines never dorm — by design, but the design predates the walk bill.** `tug-sparkline.tsx:58` (`SAMPLE_MS = 250`), `:373` (the sample interval). Rate rows dorm via `subscribeRateActivity`; gauge rows (cpu/memory/disk) deliberately keep the 4Hz sampler and the WAAPI scroll animation alive forever because the store never wakes on gauge samples. Canvas redraw doesn't recalc style, but the running WAAPI scroll and the timer both keep the page from resting.

**[H3] The shared 1Hz telemetry tick.** `session-card-telemetry-renderers.tsx:222–230` — a module-scoped `setInterval(…, 1_000)` notifying every session-clock renderer through `useSyncExternalStore`. It is subscriber-gated (stops when nothing subscribes), but if any mounted readout subscribes at idle, that is 1Hz of React commits.

**[H4] `useLifecycleTick`** (`lib/code-session-store/hooks/use-lifecycle-tick.ts`) — 1Hz, but registered only while a turn is in flight, and cleared on terminal phases. Expected innocent at idle; the census will confirm, and the `alsoWhile` escape hatch (kept alive by background agents) is the one clause worth checking.

**[H5] Non-timer wakes**: IntersectionObserver deliveries (21 samples at idle — deliveries require rendering updates; what keeps re-triggering them at rest?), WebSocket traffic → store notify → React commit (keep-alives, telemetry feeds from tugcast), and compositor-driven animation event bookkeeping. These are only reachable by the timeline instrument, not by grep.

### Arithmetic the model must survive {#idle-arithmetic}

Post-fix idle: ~340ms busy per 5s. If the waker census finds ~8–10 wakes/s (two 4Hz timers + 1Hz), that is ~45 wakes per window → **~7.5ms per wake**, which must decompose into resolveStyle + two walks + paint over the measured tree (119 stacking contexts, `computeCompositingRequirements` at 110 samples). If the census finds far fewer wakes than that, the per-wake cost is bigger than the model allows and something else is burning — either way the numbers must close. **An attribution that doesn't predict the sample counts is rejected.**

### Idle exit criterion {#idle-exit}

**[E1] An idle deck schedules zero rendering updates**, enforced two ways: every timer in tugdeck is dormancy-gated or change-gated (a paint that would write an unchanged value writes nothing), and an app-test gate asserts the mutation census (#instruments) reads **0 DOM writes/s** on a settled heavy deck. Idle busy target after the wakes die: **≤ 1%**, re-profiled on the release bundle. If a waker is judged legitimately alive at idle (a real live readout), it is named in the brief with its measured cost — nothing stays anonymous.


## Charge 2 — make style recalculation a numbered, attributed quantity {#style-recalcs}

What we actually know: `TreeResolver::resolve` ≈ 23/23/19 samples per 5s idle window. What we don't know: which elements, invalidated by whom. `sample` fundamentally cannot answer this — it sees the resolver's frames, never the mutation that dirtied the tree.

Two instruments close the gap:

**Web Inspector Timelines.** The WKWebView is already inspectable in every build — `webView.isInspectable = true` at `tugapp/Sources/MainWindow.swift:316`, not `#if DEBUG`-fenced. Safari → Develop → Tug.app → Timelines, record 10s of idle on the heavy deck: the Rendering Frames timeline attributes each style recalc, layout, and composite to its initiating JS callsite. This is the instrument class the whole investigation has been missing, and it costs nothing to wire — it is already wired. First session's deliverables: the initiator list for idle recalcs, and the same for a 5s typing burst.

**A mutation census in `perf-monitor.ts`.** A `MutationObserver` on `document.documentElement` (childList + attributes + characterData, subtree) accumulating counts per second, bucketed by target (tag.class, like the census does). This turns "who writes DOM at idle" into an app-testable number with named culprits — the same graduation path animationCensus took: instrument → convict → fix → become the gate. The observer is start/stop (`beginMutationCensus()` / `endMutationCensus()`), never left running outside a measurement window, so the instrument doesn't become its own waker.

**Recalc *scope* matters too, not just count.** WebKit resolves style from the invalidation root down; a class flip on a container re-resolves the subtree. The timeline shows recalc durations per frame — a 4Hz × 0.5ms recalc is a different crime than a 4Hz × 5ms one. Both the count and the per-recalc cost go in the record.

**[E2] Exit criterion:** idle style recalcs = 0 (subsumed by E1 once DOM writes are zero), and for the typing regime a recorded, attributed per-keystroke recalc cost with the CM6 editor's own necessary work separated from collateral invalidation outside the composer.


## Charge 3 — the typing guarantee {#typing}

### What the A/B already proved {#typing-known}

On the restored heavy card: typing busy 65.9%; after-style walk collapsed to ~0+9 (the census/dot work paid off here) but **after-layout walk held at 241+61 across all three phases** — baseline, sticky headers forced static, all 506 ResizeObservers disconnected. Two suspects absolved; term unattributed. And a hard honesty note: there is **no pre-fix typing number** — "kill the typing-lag bill" was never evidenced for typing itself. This brief creates the durable typing number and its gate.

### The breadth hypothesis, stated precisely {#typing-hypothesis}

**[H6]** Every keystroke makes CM6 lay out (necessary), and layout triggers `updateCompositingLayersAfterLayoutIfNeeded`, whose `computeCompositingRequirements` recursion visits **every RenderLayer in the document** — and RenderLayers are made by positioned elements, overflow scrollers, and transforms, not just stacking contexts. Our `layerTreeProbe` counts stacking contexts (119); the RenderLayer population on a heavy transcript deck is plausibly in the thousands. That would explain the A/B cleanly: removing 28 sticky-header contexts was removing 28 from thousands — invisible in the sample counts, exactly as observed.

Decisive tests, in order:

1. **Ground truth via Web Inspector Layers tab** on the heavy deck: the real composited-layer list with reasons and memory. Also extend `layerTreeProbe` with a RenderLayer-candidate count (position ≠ static, overflow ≠ visible, transform ≠ none, will-change) so the number is app-testable, not inspector-only.
2. **The containment experiment.** `content-visibility: auto` (or `contain: strict` + fixed sizing) on off-viewport transcript entries collapses their layout, style, and layer participation. One evalJS experiment on the restored heavy card: apply to all `[data-transcript-entry]` outside the viewport, re-run the typing profile, read the after-layout walk. If H6 holds, this is the single biggest lever in the codebase — it shrinks the walked tree instead of nibbling at categories. (Real adoption must respect the no-height-estimates doctrine: `content-visibility: auto` keeps natural layout when on-screen and uses `contain-intrinsic-size` only for off-screen placeholding — that boundary gets its own design pass if the experiment convicts.)
3. **Scoped-walk check.** If the timeline shows WebKit re-walking compositing for keystrokes that dirty only the composer's subtree, investigate why the update isn't scoped — overlay/ancestor structures (the pane chrome, the sticky positioning context) can force root-wide invalidation.

### The gate — "won't lag" becomes a number {#typing-gate}

**[E3] A typing-latency app-test on the heavy fixture deck**: focus the composer, `nativeType` a fixed ~80-char burst, measure per-keystroke `keydown → post-paint` latency in-page (keydown timestamp vs the next rAF-after-paint tick, collected by a probe installed via evalJS), assert **p95 under one 60Hz frame (16.7ms)** and record the distribution in the test output. This is the guarantee: not a vibe, a gated budget that fails CI when a future card regresses it. Alongside it, budget assertions on the structural proxies (stacking contexts, RenderLayer candidates, idle DOM writes/s) so the gate names the cause when it trips, not just the symptom.


## Charge 4 — the other 15 cores {#multicore}

The machine has 16 cores; the assumption "basically everything happens on the main thread" is half right, and the half matters. What Tug.app already gets for free, what is genuinely available, and what is a mirage:

### What is already parallel {#multicore-already}

WebKit's process architecture gives us more than zero. The app is at minimum four processes: the UI process (Swift, thin), the **WebContent process** (all of tugdeck), the Networking process, and the GPU process. Beyond that: **compositing display is UI-side** (WebContent commits a remote CoreAnimation layer tree; the render server draws it — this is why compositor-resident animations cost ~nothing, the whole point of the census program), **scrolling is asynchronous** (off the WebContent main thread), and the Rust side (tugcast, tug, tugexec) is its own multicore world already. The one image-heavy pipeline in tugdeck already runs on Workers with `OffscreenCanvas` (`lib/workers/image-downsample-worker.ts` — one worker per attachment job, all paint/encode off-main).

The precise bottleneck is therefore one thread: the **WebContent main thread**, which serializes all JS, style resolution, layout, paint recording, and the compositing walks. WebKit does not parallelize style resolution or layout internally (unlike Servo, and unlike Blink's partial efforts) — so nothing we do can make *one document's* style/layout pipeline use two cores. That constraint frames every idea below.

### Shot down, with reasons {#multicore-shot-down}

- **"Move each session card to its own thread" via Workers — dead on arrival.** Workers cannot touch the DOM, period. A card is DOM. Worker-DOM mirror libraries (AMP's worker-dom lineage) are toys that break focus, selection, IME, and every tuglaw about real DOM ownership.
- **React rendering in a worker** — same corpse, same reason. react-dom needs the real document.
- **CSS Paint/Layout worklets** — not implemented in WebKit. Not an option on our engine.
- **Canvas/WebGL text engine for the transcript** (the Google-Docs-style escape hatch) — a from-scratch text stack: selection, IME, accessibility, find, links. A year of work to escape problems whose actual causes (#idle-attribution, #typing) are fixable in weeks. Ridiculous for us.
- **"More cores will fix idle burn"** — backwards. A 4Hz timer that dirties style burns the main thread no matter how many cores idle beside it. Charges 1–3 are wake-rate and tree-breadth problems; zero of them are compute-starvation problems. Multicore is a *fourth* axis, not a substitute for the first three.

### Genuinely available, ranked by cost/benefit {#multicore-options}

**Calls made 2026-07-29:** M1, M2, M3 are **IN** — committed work, no spikes or further debate. M4 is **MAYBE IN** — its spike runs **first, before any other work on any charge**, so its verdict completes the IN list before the devise's execution order is fixed. M5 is **OUT** — no work at all until further notice.

**[M1] Workers for the data plane — IN. Cheap, proven in-repo, aimed at turn latency not idle.** The candidates are the JS that actually chews: JSONL transcript parsing on resume/Reload (the restore path), tiktoken counting (the wasm is worker-friendly), diff computation for diff blocks, transcript find/search indexing, and syntax-highlight tokenization for large code blocks. Pattern already established by the image-downsample worker. Honesty clause: today's profiles show the bill is style/layout/compositing housekeeping, **not** JS compute — so M1 buys smoother restores and big-turn ingestion, not the idle 8% and not the typing walk. Do it where a profile shows a JS hotspot, never speculatively.

**[M2] OffscreenCanvas for sparklines and any future chart surface — IN. Cheap, natural extension.** The Pulse card's canvases can be transferred to a worker (`transferControlToOffscreen`), moving sampling + redraw off-main entirely; combined with the Step 3 dormancy fixes this makes the Pulse card cost ~zero main-thread at idle *and* under load. The downsample worker proves our WebKit supports the full path.

**[M3] Process-per-window — IN. Cheap Swift-side lever, real isolation.** Two deck windows today share one WebContent process (one `MainWindow.swift` webview, default pool). Giving each window its own WebContent process (distinct `WKProcessPool` per window, or just verifying modern WebKit's process-per-tab behavior applies) means a heavy deck in window A cannot lag typing in window B. Doesn't split cards, splits *workspaces* — but that is a real user-facing win and nearly free. Verify empirically before claiming: process sharing rules changed across WebKit versions.

**[M4] The out-of-process iframe spike — MAYBE IN, spike runs first. The only honest path to "a card on its own thread."** WebKit has been landing site isolation (cross-origin iframes hosted in their own WebContent process). *If* it is enabled for WKWebView on this macOS version, a session card hosted in a cross-origin iframe would get its own main thread: its style/layout/walks fully parallel to the deck's. The costs are real — postMessage instead of shared stores, separate focus/selection worlds, drag-between-panes across process boundaries, duplicated bundles — so this is a *measured spike*, not a plan: build a toy (deck page + cross-origin iframe animating/typing), check Activity Monitor for a second WebContent process, and profile whether load in one stalls the other. If WebKit gives us in-process iframes only, the idea is dead on our engine and we write that down and stop wondering.

**[M5] Separate WKWebView per heavy surface — OUT, by call. No work on this until further notice; recorded only so the reasoning isn't re-derived.** An NSView-layered second webview *does* get its own WebContent process today (with its own pool). Fits surfaces with low interaction coupling to the deck — a future log viewer, a profiler UI, possibly the Pulse card. Does not fit session cards: panes, card drag, z-order, focus, and the share gesture all assume one document. Scoped tool, not an architecture.

**[M6] Scheduling, not parallelism, for the rest**: `requestIdleCallback` (supported in our WebKit) for deferrable work (prefetch, cache warm, census bookkeeping) so it never competes with a keystroke. Zero new threads, often the biggest perceived-latency win per line changed.

### Multicore exit criterion {#multicore-exit}

**[E4]** M1, M2, and M3 are landed (committed by call, not gated on further debate — M1's *worker targets* are still chosen against named profile hotspots, but the workstream itself is in). The M4 spike has a written verdict (own-process iframes: yes/no on our WebKit, with the Activity Monitor + profile evidence), delivered before any other charge's work begins; if yes, M4 graduates to IN with its own design pass. M5: no work.


## Instruments {#instruments}

| id | instrument | what it answers | status |
|----|-----------|-----------------|--------|
| I1 | **Web Inspector** (Timelines + Layers) against the running app — `isInspectable` already true (`MainWindow.swift:316`) | who initiates each rendering frame, recalc, layout; real composited-layer list with reasons | available today, never yet used in this investigation |
| I2 | **Waker census** in `perf-monitor.ts` — boot-time wrap of `setInterval`/`setTimeout`/`requestAnimationFrame` recording creation stacks and per-second fire counts into a registry read by evalJS | which timers exist, who made them, how often they fire at idle | to build |
| I3 | **Mutation census** in `perf-monitor.ts` — windowed MutationObserver, counts by target bucket | who writes DOM at idle; the E1/E2 gate's sensor | to build |
| I4 | **Typing-latency probe** — in-page keydown→post-paint sampler, installed by the gate test | the E3 number | to build |
| I5 | `layerTreeProbe` extension — RenderLayer-candidate count alongside stacking contexts | the H6 denominator, app-testable | to build |
| — | `scripts/perf-resize-profile.sh` | end-to-end release verdicts (with the known `applyKeyframeEffects` transition false-positive) | exists |

I2–I5 live where `animationCensus` lives and graduate the same way: instrument first, gate after conviction.


## Execution {#execution}

Order matters: the M4 spike before everything (its verdict completes the IN list), then instruments before verdicts, verdicts before fixes, fixes before gates, and the release re-profile last.

- **Step 0 — The M4 spike, upfront.** Toy deck page + cross-origin iframe (served from a second port on the local server), animate and type in both; Activity Monitor for a second WebContent process; profile whether load in one stalls the other. Written yes/no verdict in #record. Nothing else starts until this is answered.
- **Step 1 — Build I2/I3/I5** in `perf-monitor.ts`, with an app-test that exercises each on a seeded deck (anti-vacuity floors like at0288's: the waker census must see the wrapped timers fire, the mutation census must see a deliberate write).
- **Step 2 — The attribution session.** Web Inspector + the new censuses against the heavy deck at idle, debug and release. Deliverable: a table where **every** rendering update per second and every style recalc has a named initiator, and the arithmetic in #idle-arithmetic closes against fresh `sample` numbers. No fixes in this step.
- **Step 3 — Kill the idle wakes.** Change-gate the pulse readout paint (write only when the formatted string or idle flag actually changed — this also stops the dataset write), extend dormancy to whatever Step 2 convicted, re-examine the gauge-row always-alive policy against its measured cost. Each fix is one commit with a before/after census read.
- **Step 4 — The typing term.** Layers-tab ground truth, then the containment experiment on the restored heavy card, then the scoped-walk check. Deliverable: the after-layout walk attributed and a chosen lever with measured effect.
- **Step 4c — The IN multicore work (M1/M2/M3).** M2 rides with Step 3's Pulse fixes (dormancy-gate the readout, then transfer the canvases off-main — one surface, one pass). M3 is a Swift-side change in `MainWindow.swift` (per-window process isolation, verified in Activity Monitor). M1 lands worker offloads against the hotspots Step 2's attribution names, restore-path parsing first in line.
- **Step 5 — Land the gates.** The E1 idle-silence assertion and the E3 typing-latency budget as app-tests; extend at0288's docstring scope honestly if the census family grows.
- **Step 6 — Release re-profile** against all three exit criteria; record in this brief's #record section; archive.

## Exit criteria, restated as one line each {#exit}

- **[E1]** Idle deck: zero scheduled rendering updates, ≤1% release busy, every surviving waker named with its cost.
- **[E2]** Style recalcs: zero at idle; per-keystroke recalc cost attributed with CM6's necessary work separated from collateral.
- **[E3]** Typing: p95 keystroke→paint < 16.7ms on the heavy fixture deck, enforced by a committed app-test.
- **[E4]** Multicore: the out-of-process-iframe question answered with evidence; workers/OffscreenCanvas adopted only against named profile hotspots, never speculatively.

## Record {#record}

### M4 verdict — site isolation works, behind an unstable WebKit feature flag reached by private SPI {#record-m4}

**Answer: yes, with a flag.** Stock `WKWebViewConfiguration` hosts a cross-origin iframe in the deck's own WebContent process — that part of the first measurement stands. But WebKit 18.6 ships a feature named `SiteIsolationEnabled`, described in its own metadata as *"Put cross-origin iframes in a different process"*, defaulting off. Turned on, it does exactly that, and the isolation is complete: a cross-origin iframe burning 200ms of every 250ms leaves the deck at a **flawless 60fps**.

Measured on macOS 15.6 (24G84), Safari/WebKit 18.6.

| Stage | Flag off — procs / frames per 5s / p95 gap | Flag on — procs / frames per 5s / p95 gap |
|---|---|---|
| Baseline, no iframe | 14 · 300 · 17ms | 14 · 300 · 17ms |
| Cross-origin iframe, idle | 14 · 300 · 18ms | **15** · 300 · 18ms |
| Cross-origin iframe, `?busy=1` | 14 · **108** · **211ms** | **15** · **300** · **17ms** |
| Same-origin iframe, `?busy=1` (control) | 14 · 84 · 210ms | 14 · 84 · 211ms |

Every cell corroborates the same story. With the flag on, the cross-origin load spawns a **fifteenth** WebContent process and the deck's frame delivery is untouched — 300 frames in 5s, zero gaps over 100ms, indistinguishable from having no iframe at all. The same-origin control still stalls (84 frames, p95 211ms) and the process count drops back to 14, which is the correct behavior: same origin, same process. A bug or a measurement artifact would not reproduce that asymmetry.

**How it is turned on.** `SiteIsolationEnabled` is reachable through the `_WKFeature` SPI — enumerate `+[WKPreferences _features]`, find the feature whose `key` is `SiteIsolationEnabled`, and call `-[WKPreferences _setEnabled:forFeature:]` on the configuration's preferences before the `WKWebView` is constructed. No private headers are needed; selectors resolve at runtime. The spike's implementation is `MainWindow.enableSiteIsolation(on:)`, gated behind `TUG_SPIKE_SITE_ISOLATION=1`.

**What "unstable" means here, and why this is not yet a green light.**

- The feature's status field reads **1 (unstable)** — below internal, developer, preview, and stable. WebKit's own site-isolation deep dive described the work as "step 2 of 3" as of January 2025, with the remaining step being *fixing the functionality that site isolation breaks*. We would be adopting a feature its authors do not consider finished.
- It is **private SPI**. Selector-based access dodges the compile-time dependency but not the risk: Apple can rename, re-status, or remove the feature in any macOS update, and a silent failure degrades to "no isolation" (which the spike's own logging catches, but only if we keep watching).
- Turning it on changes cross-origin iframe semantics **globally** for the web view, not just for surfaces we opt in. Anything else the deck ever frames inherits it.

**The architectural cost is the real gate, not the flag.** The flag makes per-card threading *possible*; it does not make it cheap. Every Session card moved into a cross-origin iframe loses the shared DOM and the shared React tree, which means the focus engine, the pane model, theme tokens, selection, drag, and the deck-trace ring all have to cross a `postMessage` boundary. That is a rearchitecture of the deck's core, not a perf tweak — and it should be judged as one, on its own brief, against what it would actually buy.

**Side finding, worth keeping.** The deck's CSP (`tugdeck/index.html`) is `default-src 'self'` with no `frame-src`, so a cross-origin iframe is blocked outright before any engine behavior is observable — the first run of this spike read as a hard "no isolation" purely because of it. The measurement needs a temporary `frame-src 'self' http://localhost:*` allowance, reverted afterward. Any future revisit must relax CSP first or it will misread a CSP refusal as an engine answer.

**Disposition: M4 is OUT, on policy.** Call made 2026-07-29, immediately on reading the above: **Tug does not ship private SPI.** Not conditionally, not behind a flag, not with a fallback path — a feature Apple can rename or remove in any OS update, whose failure mode is silent, is not a foundation this product builds on. The engine capability is real and the measurement stands; the delivery mechanism disqualifies it. All spike scaffolding was removed in the same step and `MainWindow.swift` is byte-identical to `main`.

**What would reopen it:** `SiteIsolationEnabled` graduating to a *stable* status with public API — a `WKWebViewConfiguration` or `WKPreferences` property with no leading underscore. Worth a look on each macOS major. Nothing short of that.

**Consequences for the plan.** [Q01] closes **YES on the engine, OUT on policy**. Risk R01 did not materialize but is moot. Nothing else in the plan depended on the answer either way — Steps 2–12 stand as written, and the multicore work that remains (brief M1/M2/M3) is public API throughout: Workers, `OffscreenCanvas`, and `WKProcessPool`.

---

### Idle attribution — the mechanism model closes, and the transcript is innocent {#record-idle}

Measured 2026-07-29 on the app-test bundle (`dev.tugtool.app.apptest`, its own WebContent process, so `perf-resize-profile.sh` samples it cleanly with the user's own instances running). One deck: `session-transcript-basic` restored through the production picker → spawn → reveal path, 32 pulsing dots, 1,468 elements. Two arms of the same deck, both after a 4s settle, censuses and `sample` taken over the same parked window. Reproduced across two independent launches with identical waker and write counts.

**Arm A — deck at rest, pulse detail closed.**

| Quantity | Reading |
|---|---|
| Wakers | **1/s**, and it is the perf monitor's own 1Hz heartbeat (dev/test only — it does not exist in a release build) |
| DOM writes | **0 in 5,000ms** — childList 0, attributes 0, characterData 0 |
| Main-thread busy | 1.6% (71/4,379 samples) |
| `updateRendering` | 48 samples = **1.1%** |
| `computeCompositingRequirements` | 1 sample |
| `Style::TreeResolver::resolve` | 2 samples |

**A restored heavy transcript at rest is already silent.** Zero product wakers, zero DOM writes. Whatever burns the release deck's idle budget, it is not the transcript — that page of the investigation is closed.

**Arm B — the same deck with the pulse detail popover open (6 channel rows).**

| Quantity | Reading | Decomposition |
|---|---|---|
| Wakers | **33/s** | 24/s = 6 × 250ms readout intervals at one callsite (**[H1]**, 6 rows × 4Hz). 8/s = 2 × 250ms sparkline samplers (**[H2]**, the two gauge rows that never dorm; the four rate rows dormed correctly). 1/s = the dev heartbeat. |
| DOM writes | **64/s** (320 in 5,000ms) | 240 on `span.session-pulse-card-value` = 6 rows × 4Hz × 5s × **2 writes each** — `textContent` (120 childList) and `dataset.idle` (120 of the 200 attributes). 40 `polyline.tug-sparkline-line` + 40 `polygon.tug-sparkline-area` = 2 live tapes × 4Hz × 5s. |
| Main-thread busy | 5.5% (216/3,927) | |
| `updateRendering` | 144 samples = **3.7%** | |

**The arithmetic closes.** Both arms agree on one constant: **a rendering update on this tree costs ~10ms.** Arm A: 48 `updateRendering` samples over 5s at ~1 update/s (the lone heartbeat) → 10ms each; predicted busy 1.0% against 1.1% measured. Arm B: every waker sits on the same 250ms grid, so the eight timers coalesce into ~4 rendering updates/s → predicted 4.0% against 3.7% measured. Both inside ±25%, from opposite ends of a 3.5× range. `busy = rendering updates per second × cost per update` is the right model, and the cost term is now a measured number rather than an assumption.

**T01 verdicts.**

| # | Suspect | Verdict |
|---|---|---|
| 1 | Pulse readout paint ([H1]) | **CONVICTED, exactly as charged.** 4Hz × rows, and *two* unconditional writes per tick, not one — `dataset.idle` is as ungated as `textContent`. 48 writes/s of the 64. |
| 2 | Gauge sparklines never dorm ([H2]) | **CONVICTED, and the dormancy design is vindicated in the same breath** — the four rate rows dormed to zero; only the two gauge rows held their 4Hz timer. 16 writes/s. |
| 3 | Shared 1Hz telemetry tick ([H3]) | **ABSOLVED at idle.** Subscriber-gated and absent from both arms' censuses. |
| 4 | `useLifecycleTick` ([H4]) | **ABSOLVED.** Turn-gated; absent from both arms. |
| 5 | Non-timer wakes ([H5]) | **ABSOLVED on this deck.** Arm A reads 0 writes/s and 1 waker/s, which leaves no room for a hidden IntersectionObserver or WebSocket-driven commit at rest. |

**Scope limit, stated plainly.** This deck rests at 1.6%; the release baseline in `#top` is 8.3%, measured on the user's own deck with surfaces this one does not mount. The model says that gap is ~7 additional rendering updates per second, which two or three live readout surfaces would produce — but *which* surfaces is not established here, and a release-bundle idle sample taken while a session is streaming reads 12.5% and is not an idle baseline at all. The clean release re-baseline belongs to the last step of the plan, on a deck the user is not driving. What Steps 4–5 fix is convicted on its own numbers regardless: 64 writes/s and 32 wakes/s from surfaces that are displaying nothing changing.

**Layer ground truth, banked for the typing charge.** Same deck: **535 RenderLayer candidates against 118 stacking contexts** — a 4.5× gap, and the first direct evidence for **[H6]**. The candidate histogram is not led by anything exotic: 61 `button.tug-button-size-xs`, 43 + 38 `svg.lucide` icons, 32 + 32 dot spans, and five separate 28-count buckets that are the per-tool-call header's own children (`div.tool-call-header`, `span.tool-call-header-name`, `-detail`, `-timing`, and its chevron). Every tool call in the transcript contributes roughly a dozen layer candidates through ordinary positioned and clipping boxes. That is the population the after-layout walk recurses over, and it explains cleanly why removing 28 sticky headers moved nothing.

**[Q04] — deferred, with reason.** The brief-M1 worker offload wants the top JS self-time entry on a cold restore, which is a Web Inspector JavaScript & Events timeline reading and not automatable. It is also the item [P07] most wants evidence for: on this deck `updateRendering` is 67–68% of busy in both arms and JS self-time does not appear at all. Named in the plan's ledger as pending its own measurement rather than guessed at.

### Idle fix — the readout writes only on change {#record-idle-fix}

Same deck, same two-arm method, same 5s windows. `PulseRow`'s paint now holds the last written string and the last written idle flag and writes neither unless it differs. Both are gated: `dataset.idle` was as unconditional as `textContent`, and an attribute set to the value it already holds is delivered as a mutation just the same.

| Pulse detail open, session idle | Before | After |
|---|---|---|
| DOM writes | 64/s | **15.2/s** |
| `span.session-pulse-card-value` | 240 in 5s | **absent** |
| childList mutations | 120 in 5s | **0** |
| Main-thread busy | 5.5% | **3.9%** |
| `updateRendering` samples | 144 | 126 |

The readout's contribution is **zero**, not merely smaller — the eased value drifts by fractions forever, but the string a reader sees settles within a second of the session going quiet, and the gate compares the string. **[Q03] resolves with no product change required:** there is no residual churn to quantize, so the gauges keep their full precision.

Worth recording because it was not a foregone conclusion: removing 48 writes/s moved busy by 1.6 points even though the surviving wakers still land on the same 250ms grid and still force a rendering update. Style invalidation on six rows was not being fully absorbed by coalescing.

**What is left, and where it goes.** The residual 15.2 writes/s is entirely the two gauge sparkline tapes (`polyline.tug-sparkline-line` + `polygon.tug-sparkline-area`, 2 tapes × 4Hz), which never dorm by design — the store does not wake on gauge samples, so giving them the rate rows' wake channel would freeze a live reading. Their `points` string genuinely changes on every sample, so a naive equality gate buys nothing; the fix is a canonicalized flat form, and it belongs with **brief M2** where the drawing path is being replaced anyway. Designing that gate twice, once against the SVG path and once against the canvas one, would be waste. Recorded here so the remainder is named rather than quietly dropped.

Note also that this cost only exists while the pulse **detail popover is open**. A resting deck with the popover closed reads 0 writes/s (Arm A), which is why the idle-silence gate is satisfiable today.

### M3 — per-window process pool, groundwork landed {#record-m3}

`MainWindow`'s `WKWebViewConfiguration` now constructs its own `WKProcessPool` instead of taking WebKit's shared default. Web views built from the same pool are hosted in the same WebContent process, so a second deck window built through this initializer would have shared one main thread with the first and each would have stalled the other — the isolation is now structural and cannot be lost later by an unrelated change.

Verified 2026-07-29: with the app parked on a restored deck, exactly one WebContent process carries the app's WebKit cache directory (matched via `lsof`, since WebContent is launchd-owned and has no parent link back to the app). Smoke trio green.

**Payoff is deferred, honestly.** Tug.app builds one window today — one `MainWindow` construction in `AppDelegate.swift` — so this changes nothing a user can measure. It is the cheap half of brief M3; the half that pays arrives with multi-window support. Public API throughout.

### Typing attribution — H6 is refuted, and the probe has a floor {#record-typing}

Measured 2026-07-29 on the same restored `session-transcript-basic` deck, composer focused, 240 synthetic keystrokes per arm through `nativeType`, `sample` taken during the bursts.

**The containment experiment could not be run as designed, and that is itself the first finding.** The fixture corpus tops out at `session-transcript-basic`: 29 tool calls, but only **5 transcript entries** and 1,468 elements. `content-visibility: auto` on five entries, all in or near the viewport, skips nothing — measured, and it moved neither latency nor the walk. The corpus cannot reproduce the deck the 65.9% typing figure came from (1,603 stacking contexts against this deck's 118), so subtraction has no room to work here.

**So the hypothesis was tested by dose-response instead: add layers rather than remove them.** Each arm injects N absolutely-positioned, mutually overlapping, `z-index`-stacked boxes into the transcript subtree — real geometry, real overlap, genuinely visible (a first pass used a `visibility: hidden` host, which WebKit could legitimately skip; the numbers below are the visible arm).

| Injected | RenderLayer candidates | Stacking contexts | latency p50 / p95 | frame gap p50 / p95 | `computeCompositingRequirements` |
|---|---|---|---|---|---|
| 0 | 535 | 118 | 11 / 17 ms | 17 / 18 ms | 29 samples |
| +1,500 | 2,036 | 1,617 | 12 / 18 ms | 17 / 18 ms | — |
| +4,000 | 4,536 | 4,117 | 13 / 18 ms | 17 / 19 ms | 37 samples |

**[H6] is refuted.** Thirty-five times the stacking contexts — past 4,000, which is **2.5× the audited card's 1,603** — costs 2ms per keystroke, eight sample-slices in the walk, and **does not stretch a single frame**: frame-gap p50 sits at 17ms in every arm, which is vsync. The after-layout compositing walk is not a function of RenderLayer or stacking-context population, and the prior phase's null result on 28 sticky headers was not a scale problem after all. Removing tree breadth is not the lever.

**Which reopens the question the audited card posed, sharper than before.** That card showed 241 + 61 walk samples at 1,603 stacking contexts. This deck shows 37 at 4,117. Population cannot be the difference, so it is *what the layers are*: the plausible next hypothesis is **composited layers — actual backing stores — rather than RenderLayers**, a number script cannot read and the Web Inspector Layers tab reports directly with per-layer reasons. That is a human-instrument reading on the user's own deck, and it is where the typing charge goes next. Nothing in this plan should spend further effort on breadth.

**Consequence: [Q02] is moot and #step-9 does not run.** Containment was the productization of a hypothesis that did not survive. Recorded as refuted, not deferred.

**The [P08] probe has a floor, and the budgets were written without it.** `requestAnimationFrame` fires at the next vsync, so keystroke→post-paint includes a uniform 0–16.7ms wait that has nothing to do with the work the keystroke caused. On a deck that is comfortably hitting frame rate this probe reads **p50 11ms, p95 17ms** — meaning the p50 < 9ms budget is not merely unmet, it is **unreachable in principle** at 60Hz, and p95 < 17ms is measuring vsync phase rather than the app.

The honest instrument is the one this session added alongside it: **inter-frame gap during a typing burst**. A rendering update that overruns the frame budget stretches a frame and shows up nowhere else; one that fits does not. It has no floor artifact, and it states the guarantee in the words the guarantee is actually about — *typing must not drop a frame*. The gate should be built on frame gap; the recalibration is #step-11's, with the numbers above as the reference reading.

### M2 — the tape is painted in a worker {#record-m2}

`TugSparkline`'s `<svg>` polyline/polygon pair is now a `<canvas>` whose context is transferred to one shared render worker (`lib/workers/sparkline-render-worker.ts`). The staircase geometry moved verbatim into `lib/sparkline-geometry.ts` and is shared by the worker and the on-main fallback, so there is only ever one implementation of the tape's shape. Everything that needs the DOM or the stores stayed on the main thread: the sample timer, the dormancy protocol, the WAAPI scroll on `.tug-sparkline-track`, the `IntersectionObserver` gate, and the `data-activity-channel` stamp.

| Pulse detail open, session idle | Before the phase | After change-gating | After the worker |
|---|---|---|---|
| DOM writes | 64/s | 15.2/s | **0/s** |
| Main-thread busy | 5.5% | 3.9% | **2.8%** |
| `updateRendering` samples | 144 | 126 | 73 |

**Zero DOM writes with the pulse detail open.** The tape's 15.2 writes/s — the residual [H2] left standing by the change gate — are gone entirely, because a worker's canvas commit reaches the compositor without touching the page. The deck's floor at rest is 1.6%, so an open pulse card now costs 1.2 points where it cost 3.9.

Note what did **not** change: the wakers. Still 33/s, because the timers still fire — they simply do no DOM work now. That is the shape of the whole finding this phase: the wake only costs when it dirties something.

**Design notes worth keeping.**

- **Whole tape per draw, not one appended sample.** The plan specced an `append`-style protocol; shipping one instead. The main thread owns the tape and the epoch origin `t0` (the same number the WAAPI translate is measured from), so posting both together makes it impossible for the two threads to hold different pictures. A few dozen points at 4Hz is far below the cost of the style invalidation it replaces.
- **The canvas is keyed on its geometry.** `transferControlToOffscreen` may be called once per element, so canvas ownership is its own `useLayoutEffect` scoped to width/height, and the element carries a matching `key`. Folded into the tape effect it would have thrown the second time a caller passed a fresh `getSeries`.
- **Four values moved out of CSS.** A canvas has no cascade, so the line/area color and opacities are read from computed style on mount, on a theme swap (`subscribeThemeChange` — a callback set, not an observer), and when the channel stamp moves. The Pulse card's per-consumer weights became `--tugx-sparkline-{line,area}-alpha` and `--tugx-sparkline-line-width`, declared nowhere by default so an ancestor override always wins.

**Visual verification is partial.** A screenshot of the PULSE design card shows both strip tapes drawing the staircase with its area fill, so the conversion paints. Stroke weight and fill alpha at real sizes are the user's eyeball to bless (**Risk R03** residual) — that check is still owed.

### M1 — no target, so no offload {#record-m1}

[Q04] asked which data-plane hotspot earns the first worker. Measured on a cold restore of `session-transcript-basic`, 2026-07-29:

| Instrument | Reading |
|---|---|
| Replay ingest (`getSessionPerf().lastReplay`) | 148 frames, **`dispatchMs` 2**, `reduceMs` 2, 1 fold, 2 commits, 11ms wall |
| Markdown parse counters | **9 parses** across 7 identities, 3 cache hits, 20 memo hits |
| `sample`, leaf-attributed over the restore | JS (JIT) 351, `RenderBlock::layout` 114, flex layout 125, paint 58 |

None of the three candidates is a hotspot. The reducer costs two milliseconds for the whole replay; markdown parses nine times, with the parse-once cache and row memoization already carrying the rest; find indexing and diff computation do not run on this path at all.

JS *is* the largest single term of real work on the restore (351 leaf samples against layout's ~280) — but the ingest measurement places it downstream of the store, in React rendering and reconciliation, and that is DOM-touching work a Worker cannot take. There is no seam here.

**[P07] applies as written: no named hotspot, no offload.** #step-10 does not run. This is the discipline working, not a gap — an offload built against these numbers would have moved two milliseconds and added a thread boundary to the restore path forever.

Worth noting what the numbers *do* say about the restore: it is layout-bound, on a tree whose flex layout alone is 125 leaf samples. That is a real finding for a later phase, and it is not a threading problem.

### Phase close — what landed, what is still owed {#record-close}

**Landed and measured**, all on the restored `session-transcript-basic` deck sampled through the app-test bundle's own WebContent process:

| | Before | After |
|---|---|---|
| Deck at rest, DOM writes | 0/s | 0/s (already silent — the transcript was never the burn) |
| Pulse detail open, DOM writes | 64/s | **0/s** |
| Pulse detail open, busy | 5.5% | **2.8%** |
| Typing, frame gap p50 / p95 | — | **17ms / 18ms**, gated |

Three gates committed: at0291 (the instruments see what they claim), at0292 (a settled deck writes nothing), at0293 (typing does not stretch a frame). at0292 reopens its measured window once before failing — one window in roughly eight caught the tail of the transient workspace's changeset churn, and a deck that is genuinely writing fails both windows.

**Two hypotheses died, which is most of what this phase bought.** [H6] — the after-layout walk is a function of layer population — is refuted by dose-response, so no further effort should go to tree breadth. And [Q04] found no worker target: the replay ingest costs 2ms. Both were IN lists before this phase and are closed lists after it.

**Still owed, and neither is mine to do:**

1. **The release re-baseline.** Every number here is from a controlled deck that rests at 1.6%; the 8.3% baseline in `#top` is the user's own deck, with surfaces this corpus cannot mount. The model says that gap is ~7 additional rendering updates per second at the measured ~10ms each. Confirming it needs `scripts/perf-resize-profile.sh dev.tugtool.app idle 5` on a genuinely idle release deck — one nobody is driving. A sample taken mid-session reads 12.5% and means nothing.
2. **The sparkline eyeball** (Risk R03). Screenshots confirm the tapes paint their staircase and area fill; stroke weight and fill alpha at real sizes are a human call.

**And one hypothesis is now the live one.** The audited card showed 241 walk samples at 1,603 stacking contexts; this deck shows 37 at 4,117. Population is ruled out, so the next candidate is **composited layers — actual backing stores** — which script cannot count and the Web Inspector Layers tab reports directly, with reasons, on the user's own deck. That is where the typing charge resumes.

### The release re-baseline — missed, and why {#record-release}

Measured 2026-07-29 on release `dev.tugtool.app` (pid 31066, launched 17:50:27 from a bundle carrying `sparkline-render-worker-BbpLUs38.js`), three spaced 5s idle samples with the deck genuinely unattended — the sampling ran from a backgrounded shell so the driving session's own card was at rest for every window.

| Sample | Busy | `updateRendering` | compositing walk | `Style::TreeResolver::resolve` |
|---|---|---|---|---|
| 1 | 9.1% | 87% | 18% | 5% |
| 2 | 8.3% | 86% | 24% | 6% |
| 3 | 7.8% | 87% | 25% | 6% |

Mean **8.4%** against a **8.3%** starting point and a **≤1.5%** target. **The exit criterion is missed, and the phase's landed work produced no measurable change on the real deck.** Three earlier samples taken while a tool call was in flight read 17.7% / 9.0% / 10.5% and are recorded only to mark how much a driving session costs; they are not the baseline.

**Why the fixture wins did not transfer.** Converting the frame shares to wall time on sample 3 (797 samples/s): `updateRendering` is 6.75% of wall, the compositing walk 1.9%, and style resolution **0.5%**. The pulse change-gate and the sparkline worker both attack style invalidation. Style invalidation on the real idle deck is half a percent — that was the entire ceiling on that line of work, and the fixture deck's 5.5% → 2.8% was a real win against a cost the real deck barely pays. The fixture deck's burn is style-shaped; the real deck's is not.

**What the residual actually is.** Of the 6.75% inside `updateRendering`, roughly 1.9% is the compositing-requirements walk and 0.5% is style; the remaining **~4.3% is unattributed by this instrument** — layout, paint, and layer flush, none of which the script names.

**The one measurement that would decide the next move, and cannot currently be taken.** `busy = updates/s × cost/update` has two unknowns and this instrument constrains only their product. At 6.75% wall, `updateRendering` is either running ~60×/s at ~1.1ms each — something is animating continuously and the fix is to stop the loop — or ~7×/s at ~10ms each, in which case the fix is to make each update cheaper. Those imply opposite work. The waker and mutation censuses built this phase answer it directly, but they are exposed only under `import.meta.env.DEV || window.__tugTestMode`, so **they cannot be run against a release deck.** Ungating them behind an explicit opt-in (a launch flag or a Maker gesture, not a build mode) is the prerequisite for any further attribution on the surface that actually matters.

### The real deck attributed from the raw sample trees {#record-real-deck}

The paragraph above was written before reading the raw `sample` call trees the profile script had been summarizing — they were in `/tmp` the whole time, and they answer everything the ungated censuses would have. From the three unattended idle samples of 2026-07-29 (release, pid 31066):

**Where a rendering update's time goes** (sample 1, 241 `updateRendering` samples by phase offset):

| Phase | Share |
|---|---|
| style resolve → `updateCompositingLayersAfterStyleChange` → `traverseUnchangedSubtree` recursion | 32% |
| `Document::updateResizeObservations` — `gatherObservations` reading `contentBoxSize` per observed element | 32% |
| `Document::updateIntersectionObservations` — `localToContainerQuad` per target | 15% |
| post-position layout | 7% |
| `updateEventRegionsRecursive` | 5% |

Half of every update is **observer bookkeeping WebKit performs per observed element on every update**, whether or not anything resized or moved. The style-resolve→compositing-walk pair only runs when style was dirtied — so it names a per-frame style dirtier.

**Who schedules the updates** (every application-level `scheduleRenderingUpdate` caller across all three samples): `CaretAnimator` (16 hits) and `DocumentTimeline` (12 hits). Nothing else. The deck at idle is woken by caret blinking and animation resolution, a few times a second, and each wake pays the tree-sized taxes above. That closes the arithmetic at ~4–6 updates/s × ~10–15ms.

**The DocumentTimeline driver:** `tug-text-editor-caret-blink 1.2s steps(1) infinite` — the composer's caret-layer blink. Core Animation cannot express step timing, WebKit declines to accelerate, and the loop ticks style resolution on the main thread — dragging the full compositing walk behind it — on any idle deck with a focused composer, which is every real deck. (The typing A/B that "exonerated" blink was correct for typing: the typing attribute sets `animation: none`. At idle it runs.)

**Fixes landed 2026-07-29** (uncommitted on `main`, pending user rebuild):

1. **Caret blink → compositor** (`tug-text-editor/theme.ts`): `steps(1)` replaced with sampled hold-stop keyframes (`0%,49.9% / 50%,99.9%`) under `linear` easing — the same trick `breathKeyframes` uses, for the same measured reason (the pulsing-dot bench: 18.0% → 0.9%). Kills the idle style dirty AND the 32% compositing walk that only ran because style was dirtied.
2. **Pin-stack observers hoisted** (`tug-transcript-entry.tsx`): the per-entry ResizeObserver (pin height) and per-entry IntersectionObserver (stuck detection) replaced by ONE shared controller per scroll container — one RO observation (pins are uniform per scroller; the height is written on the scroller and inherited), and stuck state computed on the scroll event from sticky displacement (`pin.top > root.top + 1px`), gated by `checkVisibility({contentVisibilityAuto})` so skipped cells are never rect-read (geometry queries force layout of skipped subtrees). Idle observer tax from transcript entries: zero.

Expected post-rebuild shape: `DocumentTimeline` gone from the schedulers, `updateCompositingLayersAfterStyleChange` near zero at idle, `updateIntersectionObservations` collapsed, `updateResizeObservations` roughly halved (TugListView's per-cell height RO remains — see below). Verification: `scripts/perf-resize-profile.sh dev.tugtool.app idle 5` ×3 unattended, then read the schedulers out of the raw sample file.

**Remaining per-update taxes, documented as the next candidates, not yet done:**

- **TugListView's per-cell ResizeObserver** — the other half of the RO gather. A skipped cell cannot resize (it is not laid out), so cells could be unobserved while skipped and re-observed on `contentvisibilityautostatechange` (initial delivery re-measures, which is exactly the stamping contract) — but the width-invalidation stamp-strip path must re-observe too, and that machinery is load-bearing; it deserves its own careful pass.
- **`tug-label` truncation ROs** (one per JS-ellipsis label) and the `use-clamp-overflow` / `use-is-multiline` / `block-chrome` populations — same per-observation tax, smaller populations, same hoisting pattern available.

#### Verified after rebuild {#record-real-deck-after}

Three unattended idle samples on the rebuilt release bundle (pid 86153, built 18:32; bundle confirmed to carry `linear` hold-stop blink keyframes and the pin-stack controller):

| | Before | After |
|---|---|---|
| Idle busy | 9.1 / 8.3 / 7.8% (mean **8.4%**) | 6.0 / 5.8 / 5.5% (mean **5.8%**) |
| `CaretAnimator` as scheduler | 16 hits | **0** |
| `updateIntersectionObservations` | 37 samples | **1** |
| `updateResizeObservations` | 65 samples | **3–6** |
| `Style::TreeResolver::resolve` | 5–6% of busy | 5–6% of busy |

**31% off idle busy, and both predicted mechanisms confirmed dead** — the caret animator no longer schedules a rendering update at all, and the transcript's observer tax is gone. Every prediction in `#record-real-deck` held except one: style resolve did not fall, because it was never the caret's alone.

**What the residual is, and why it is now a different problem.** The remaining 5.8% is dominated by one term: `computeCompositingRequirements` → `traverseUnchangedSubtree`, 19–24% of busy at 25–54 samples per window, reached through `resolveStyle → updateCompositingLayersAfterStyleChange`. `DocumentTimeline` still schedules (5 hits in one of three windows) and `KeyframeEffect::setAnimatedPropertiesInStyle` / `computeExtentOfTransformAnimation` are present, so **a transform keyframe loop is still running somewhere on the deck** — the pulsing dot's breath, on whatever glyph is live. Each tick resolves style, and each style resolve drags a full compositing-requirements walk over the whole layer tree.

That walk is the last big term, and it is a function of layer population — the hypothesis [H6] recorded as refuted. **[H6] should be read as refuted only for the fixture deck it was tested on.** The dose-response injected 4,000 stacking contexts into a deck whose walk was 37 samples; the real deck's walk is 25–54 samples out of a much smaller busy budget, reached by a different path. The population that matters here is specifically **compositing-overlap candidates**, and this codebase mints one per transcript entry by design: `.tug-transcript-entry__pin` is `position: sticky` on every entry, which the primitive's own docstring already identifies as the reason the icon and header were merged into one sticky wrapper. Hundreds of entries per card, walked on every animation tick.

Two candidate directions, neither yet tested: stop the tick (find and accelerate or eliminate the remaining transform loop on an idle deck), or shrink the walk (make off-screen entries non-sticky, so a skipped cell contributes no overlap candidate). The first is cheaper to try and should go first.

#### The lab: a profileable release instance + eval on release {#record-lab}

Two pieces of standing infrastructure landed 2026-07-29 evening, replacing all further guesswork:

1. **`/api/eval` on release, behind an explicit opt-in.** `eval_handler` (tugcast `server.rs`) now answers on a release instance when the tugbank default `diag/eval` is `true` (bool, or string `"1"`/`"true"`), loopback-only as always. Flip it with `curl -X PUT http://127.0.0.1:<port>/api/defaults/diag/eval -H 'Content-Type: application/json' -d '{"kind":"bool","value":true}'`; `DELETE` the key to revoke. Verified against a real release build: forbidden before the flip, answering after. This is the census channel the phase kept lacking — `document.getAnimations()`, element counts, rAF traps, anything.
2. **The dash-release lab.** `just app-release` derives instance identity from cwd, so run from a dash worktree it builds and launches `release-<dash>` — its own bundle id, own WebContent, own tugbank — coexisting with the developer's release-main. The `idle-hunt` dash is exactly this: main + the uncommitted eval ungate, launched as `release-tugdash-idle-hunt`.

**What the lab measured** (release build, Lens + session card + focused composer + two mounted sparkline canvases, tapes dormant):

- **Idle busy 0.9% — under the ≤1.5% exit target** — with the caret blink RUNNING. `updateCompositingLayersAfterStyleChange` 0, `applyKeyframeEffects` 0: the blink is compositor-resident, verified directly on the surface that matters.
- The animation census on the settled deck: exactly ONE running animation (the blink). The deck is motion-silent at idle by construction.
- **A cautionary artifact:** a synthetic `mousedown` with no `pointerup` (driving the Lens via eval) wedged `selection-guard`'s `runAutoscrollTick` into a permanent 60/s rAF loop — 0.9% → 3.0% busy from the wake alone. Zero rAF-service frames in any of release-main's samples, so it is not the residual — but it is a real latent wedge (tracking ends only on `pointerup`; a lost one pins a frame-rate loop forever) and deserves a watchdog (stop the loop when no pointer has moved for a few seconds of zero-delta ticks).

**What the lab could not reproduce: the 5.8%.** A light real deck profiles at 0.9%; release-main profiles at 5.8% with intermittent `DocumentTimeline` scheduling and `KeyframeEffect` transform frames. The delta is deck content — most plausibly live/waking Pulse tapes plus several heavy session cards' layer trees. The next measurement is now one rebuild away: rebuild release-main (picks up the ungated tugcast), flip `diag/eval` on it, and census the real deck directly — running animations, entry/pin counts, and an rAF trap, taken on the exact surface that misses the target.

#### The overlap-map law — what the idle burn actually is {#record-overlap-law}

Measured 2026-07-30 on release-main (the real working deck: 3 session cards, 177 transcript entries, ~29–41 running animations at idle), through `/api/eval` with `diag/eval` flipped on. Every number below is `sample`-derived from the raw call trees, itemized by `Page::updateRendering` phase offset, with no-op baselines interleaved between conditions.

**The law.** A running **`transform`** animation forces `computeCompositingRequirements` over the entire page's layer tree on every frame. A running **`opacity`** animation does not. `will-change` is irrelevant to both. The mechanism is the `LayerOverlapMap`: a transform changes a layer's geometry, so the map is rebuilt, and the rebuild's cheap path (`traverseUnchangedSubtree`) still visits every layer — there is no subtree pruning for it. Cost is therefore **(any transform animation running) × (total mounted layer population)**.

| probe (one 6×16px span, `body` level) | walk | `traverseUnchangedSubtree` |
|---|---|---|
| none | 6 | 81 |
| `transform` + `will-change: transform` | 39 | 220 |
| `transform`, no `will-change` | 38 | 221 |
| `opacity`, no `will-change` | 9 | 91 |
| `opacity` + `will-change: opacity` | 9 | 35 |

**Population is the multiplier.** Same single transform probe, varying only how much deck is mounted:

| mounted | probe | walk |
|---|---|---|
| 3 cards / 177 entries | — | **0** |
| 3 cards / 177 entries | 1 | **85** |
| 1 card | 1 | 20 |
| 0 transcripts | 1 | 7 |

Static content is free at any size; the walk is zero whenever nothing animates. The transcripts carry **26,374 layer-minting elements** of 61,676 — `position: relative` 12,666, `overflow` 9,175, `position: sticky` 1,713, `z-index` 1,986, `contain: content` 789, `transform` 136.

**The walk is a threshold, not a proportion — this is the actionable part.** Round-robin, three repeats per condition, medians:

| condition | running anims | `updateRendering` | walk |
|---|---|---|---|
| baseline | ~27 | 179 | **112** |
| wave bars off | ~26 | 167 | 98 |
| pulsing dots off | ~4 | 127 | 66 |
| **all animations off** | 2 | 70 | **9** |

One transform animation on this deck costs a walk of 85; all ~30 of them cost 112. Removing a subset buys almost nothing — **idle must reach zero running transform animations for the term to disappear.** Partial motion budgets are not a strategy here.

**Two corrections to `#record-real-deck-after`.**

- The claim that a style dirty "re-proves" the rest of the deck was wrong in mechanism and was never evidenced. WebKit's style invalidation is properly scoped here and is not being defeated. What is global is the overlap map, by construction.
- **Sticky pins are exonerated.** Forcing all 174 `.tug-transcript-entry__pin` to `position: static` left the walk unchanged (77 → 70, against a clean re-baseline of 58). The sticky-population theory in `#record-real-deck-after` is refuted; do not spend work on it.

The caret-blink fix in `#record-real-deck` was correct and remains correct — it animates **opacity**, which this law prices at zero.

**Method notes, dearly bought.**

- **`sample` on release-main is not a controlled environment.** Other live sessions move the no-op baseline by more than the effect under test: one run's three all-suppressed baselines read 16 / 27 / 103. Any single-window A/B on this deck is worthless. Interleave baselines, repeat, take medians — and discard runs whose baselines disagree.
- **An occluded window does no rendering work at all.** A lab bench of 12,200 layer-minting boxes crossed with 30 transform animations returned `updateRendering` 0 in every condition, because the lab window was behind the developer's. Confirm the window is unoccluded before believing any lab measurement — which also makes the 0.9% in `#record-lab` suspect for the same reason.
- **WAAPI `pause()` is not a null operation.** Pausing an accelerated animation demotes it off the compositor and applies its pose on the main thread; pausing a subset made the walk *worse* than baseline. Suppress with `animation: none` via a probe stylesheet instead.
- **`calc(var(--…))` in keyframe values is not an acceleration defeater.** 100 glyphs, var-based stops vs the identical numbers as literals: `updateRendering` 26 vs 33, `setAnimatedPropertiesInStyle` 7 vs 14. Identical within noise. The pulsing dot's keyframe authoring is not the problem.
