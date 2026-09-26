<!-- brief-skeleton v1 -->

# Motion never runs on the main thread: measured in the page, enforced at runtime

**Purpose:** The release deck's web content process has been pinned at 100% CPU for a day, every command and keystroke lags behind it, and the cost is WebKit's whole-page compositing walk running on every frame under a long-running CSS transform animation. The doctrine says this cannot happen; nothing enforces the doctrine on the shipping surface, and nothing can measure it there.

---

## Purpose {#purpose}

The user, on the app as it stands: "Performance is *terrible*. Lag responding to my commands and actions." And on the rule the work has to make true: "We *absolutely cannot* be pegging the CPU by running CSS animations on the main thread. We basically should *never ever ever* be animating on the main thread." The pulsing dot was recently brought into the CodeMirror composer as the session chip's live phase mark ([session-dot-overlay-brief.md](session-dot-overlay-brief.md)), and the user still wants that. What they will not have is a dot whose breath costs the main thread anything, on any WebKit, ever again.

The standing doctrine ([tuglaws/animation-doctrine.md](../tuglaws/animation-doctrine.md)) already names the disease and the cure: per-frame main-thread style commits trigger a whole-page compositing walk, and a completely accelerated transform or opacity animation stops ticking entirely. It was verified by measurement in July. It is not a rule, because nothing on the release build checks it, nothing in the app-test corpus would go red when WebKit's acceleration decision changes under an OS update, and the release build ships with no Web Inspector and no way to ask the live page what is ticking. The user was told about the failure by their own fingers, a day late.

One more constraint the user set, without qualification: **no private API in the shipping host, ever.** The measurement has to be made by the page about itself, with the platform's public surface.

---

## Evidence {#evidence}

**[F01] The Tug.app WebContent process is saturated, and nothing else is.** `ps` on 2026-09-26 05:52 showed the release deck's WebContent process (pid 64499, up 26 hours) at 101% CPU and 2.4 GB resident. The Tug host, tugcast, and every claude process sat under 11%. WindowServer read 43%, which is repaint load downstream of the same process. **(verified)**

**[F02] The main thread is inside WebKit's compositing-requirements walk, every frame, with JavaScript absent.** Two `sample` runs (3 s and 5 s) agree. Of 1765 main-thread samples in the first, 1720 were inside the rendering-update timer; 1111 were under `Page::updateRendering → layoutIfNeeded → Document::resolveStyle`, and 876 of those were `updateCompositingLayersAfterStyleChange → RenderLayerCompositor::computeCompositingRequirements`, recursing five levels deep. A further 281 were the focused editor's `FrameSelection::recomputeCaretRect` forcing a second layout that walked the same tree. JavaScript accounted for roughly 7 samples. This is not React, not a store loop, not a streaming flood: it is WebKit re-deriving overlap for every layer in the page, once per frame, because style is dirty on every frame. **(verified)**

**[F03] Every interpolation the sampler caught was a transform list blending a translate with a scale.** Across both samples: 58 `StyleTypeWrapper<Style::Transform>`, 57 `Blending<Style::TransformList>`, with `TranslateTransformFunction::blend` and `ScaleTransformFunction::blend` beneath, against 1 opacity and 2 color blends. Those blends were reached from two places: `KeyframeEffect::computeExtentOfTransformAnimation` inside the walk (the extent of a running transform animation is recomputed on every walk) and `TreeResolver::resolveElement → createAnimatedElementUpdate → KeyframeEffect::apply` (the animated elements are the ones whose style is being re-resolved). **(verified)** The `translate(-50%, -50%) scale(…)` form belongs to `tugx-progress-pulsing-dot-breathe` and `tugx-progress-pulsing-dot-emit-expand` in `tugdeck/src/components/tugways/internal/tug-progress-pulsing-dot.css`; the only other translate-plus-scale keyframe in tugdeck is the finite alert entrance. That attribution is by elimination over the source, not by reading the element off the live page. **(inferred; [B03]'s instrument would confirm it in seconds)**

**[F04] The population the walk pays for is enormous.** The release-main ledger holds 773 sessions, eight of them in flight at sample time (`awaiting_first_token` 2, `submitting` 2, `tool_work` 3, `waking` 1), so roughly eight dots were breathing and emitting. The deck's own warning channel logged a transcript list view at `scrollHeight: 32777` while following a stream. The doctrine's numbers price a whole-page walk on the real release deck at ~26k layers; this is that deck. The trigger is a handful of animations; the bill is the tree. **(verified from the ledger and the tugcast log)**

**[F05] The breathing element carries transitions on the same box as its loop.** `.tug-progress-pulsing-dot-dot` declares `transition: transform …, background-color …` and the component writes `dot.style.transform` and `dot.style.transition` inline at every crossing. The breath keyframes animate `transform` on that same element. A `background-color` transition is not accelerable, and WebKit decides acceleration over an element's whole effect stack, so any crossing in flight demotes the loop for the crossing's duration, and a transform transition fighting a transform animation is a hazard at every edge. The doctrine's own qualifying form says "no other blocked animation on the same element's effect stack"; the dot violates it structurally. **(verified in the CSS and the component)**

**[F06] WebKit's acceleration gate is a list, and it is longer than the doctrine's.** Read out of `KeyframeEffect::canBeAccelerated()` on WebKit trunk: no accelerated properties; an accelerated property overridden by a cascade property; a reference filter; a `steps()` or multi-stop `linear()` timing function on the effect or any keyframe; a composite other than `replace`; a keyframe composing an accelerated property; an animation that animates size alongside a size-dependent transform; a discrete transform interval; unresolved keyframe offsets; a progress-based timeline; skipped content; document quirks. `preventsAcceleration()` adds motion paths and a prior acceleration failure. Any one of these on any effect sharing the element demotes the whole stack to main-thread ticking. **(verified against the source on 2026-09-26; the exact set on the shipped WebKit build is not readable from outside)**

**[F07] The shipping build cannot be asked what is ticking.** `tugapp/Sources/MainWindow.swift` keeps `developerExtrasEnabled` and `isInspectable` off in every build, by decision. `tugdeck/src/lib/perf-monitor.ts` and its `animationCensus` run only in dev builds and app-test mode. `deck-trace.ts` binds `window.__deckTrace` in every build but documents driving it from the Safari Web Inspector, which the same host forbids. There is no tugcast-to-deck command that runs a diagnostic. **(verified)**

**[F08] The July measurement no longer describes this machine, and the reason is not established.** The doctrine's bench put the pulsing dot's breath at 0.9% of the main thread for 100 glyphs, on the WebKit of that day. This machine runs macOS 27.0 (26A428) with WebKit 22625.1.29.11.27; the release app was built 2026-09-25 from a tree whose last change to the dot's CSS was 2026-09-02, and the composer chip gained its live dot on 2026-09-24. A WebKit change to the acceleration decision, a new blocked effect on the dot's stack from the crossing machinery, or the composer-chip host are all live hypotheses. **(the OS and build facts are verified; the cause is not)** A standalone Safari reproduction on the same WebKit was attempted and was inconclusive for tooling reasons (the animating tab could not be reliably found and sampled), so it neither confirms nor clears the OS hypothesis.

**[F09] The composer's dot layer is not itself a per-frame path.** `session-dot-layer.tsx` runs `markers()` and `draw()` inside CodeMirror's measure and write phases after a document update, and holds no timer between. The two other long-running animations in the CM6 theme, the caret blink in `theme.ts` and the atom pending pulse in `atom-decoration.ts`, animate opacity only. The one thing the layer changed about the dot is where it lives, not what it runs. **(verified by reading the code)**

**[F10] The render-cost measurement the work needs is available to the page with public APIs.** In the HTML event loop, `requestAnimationFrame` callbacks run first, then style, layout, and compositing run synchronously in the same rendering update, and only then does the next task run. The interval from a `requestAnimationFrame` callback's timestamp to a `setTimeout(…, 0)` queued inside it is therefore the frame's style-layout-compositing cost, measured from inside the page with `performance.now()`. `settle-frame-probe.ts` already samples frame gaps the same way for settles. `PerformanceObserver` with the `event` entry type reports input-to-next-paint per event with no polling, where the engine supports it. **(the event-loop ordering is standard; whether this WebKit build exposes the `event` entry type is unverified and must be feature-detected)**

---

## Decisions {#decisions}

**[B01] The page measures its own rendering cost, and that number is the contract.** The gauge is the frame's style-layout-compositing cost as [F10] measures it, taken from inside the deck with `requestAnimationFrame`, `setTimeout`, and `performance.now()`. It measures the exact thing the doctrine forbids, the per-frame walk, rather than a proxy for it. It works on the release build, needs no inspector, and involves no host code. Every later decision reads this number: the bisect instrument reports it, the circuit breaker trips on it, the app-test tripwire asserts on it.

**[B02] No private API in the shipping host, and no host-side process meter at all.** The user's rule, without qualification. A `_webProcessIdentifier` read, a coalition query, or a responsible-pid lookup is ruled out, and so is the "coarse process-wide meter" that would have replaced it. Nothing about [B01] needs the host to know which process the page runs in. If a future measurement genuinely cannot be made from the page, that is a reason to find a public signal, never a reason to reach for a private one.

**[B03] The probe is a finisher: armed by motion, disarmed by its absence, sampling rarely.** The doctrine's event clock ([D7]) holds. The probe arms on the rising edge of "any long-running animation is active" and disarms on the falling edge. While armed it takes one two-frame sample every few seconds. A deck with no motion runs no probe and schedules no rendering update. One `requestAnimationFrame` every few seconds is a sample, not a loop, and the sampled frame's own cost is the reading.

**[B04] A `tugtool deck motion` verb makes the release deck answerable.** It rides a tugcast-to-deck command and does three things with public APIs only: lists `document.getAnimations()` with each target, its animated properties, and its play state; pauses or resumes a group by selector; and reports the [B01] render cost before and after. Pausing the group whose pause collapses the cost names the culprit in seconds, on the build the user is running. Today's incident is the first thing it settles ([F03]), and every future incident starts with it. It also exposes `layerTreeProbe` so the population ([F04]) is a number that gets read rather than guessed.

**[B05] The breathing element carries its animation and nothing else.** Split the dot so the box that runs the breath declares no `transition`, receives no inline `transform` or `transition` writes, and carries only transform and opacity keyframes with keyword easing. Crossings (settle, tint, catch-where-it-stands) move to a wrapper or sibling that owns the transitions. The same split for the ring and its pulse. This makes [F05] impossible by construction and satisfies every clause in [F06] that authoring can satisfy. The crossing-never-cuts behaviour the component documents is preserved; only which element carries which effect changes.

**[B06] Residency is a lint, and the lint reads CM6's JavaScript-authored styles too.** Extend `tugdeck/scripts/audit-settle-motion.ts` into a whole-repo motion audit, inside `just lint`: a selector that declares a long-running (`infinite`) animation may animate only `transform` and `opacity`, may declare no `transition`, may use only keyword or single-cubic-bezier easing, and may not set `animation-composition`. The audit reads `theme.ts` and `atom-decoration.ts` style objects as well as CSS, because [F09]'s keyframes live there and a CSS-only audit is blind to them. A hit is a finding, not a reason to loosen the rule.

**[B07] A circuit breaker fails toward stillness.** If the [B01] reading stays above budget across consecutive samples while the session stores report nothing in flight, the deck demotes every long-running animation to its static form and records a `motion-demoted` event carrying the animation census and the measured cost. Motion resumes on the next quiet-to-live edge. The user sees a still dot instead of a frozen app, and the record names what broke. This is the clause that keeps the rule true when WebKit changes under an OS update, which [F08] says is exactly the failure to expect.

**[B08] An app-test in the real bundle is the tripwire.** One test mounts breathing dots in a Session card and in the composer chip, arms the probe, holds, and asserts render cost under budget for the hold. It carries `@covers` for the dot component, its CSS, the session-dot layer, and the probe. This is the test that goes red the morning after a WebKit change, before anyone feels it. The harness may take a second opinion from outside the process (`ps` on the test bundle's content process is fine in a test runner, which is not shipping product), but pass or fail rides the in-page number.

**[B09] Input latency is the second gauge where the engine offers it.** Feature-detect `PerformanceObserver.supportedEntryTypes` for `event`; where present, observe `PerformanceEventTiming` and record input-to-next-paint alongside the render cost. It fires only on input, so it costs nothing at rest, and it is the number that matches the complaint. Where absent, the [B01] reading stands alone.

**[B10] The composer's session dot stays.** The layer design is sound ([F09]) and the user wants the mark. The work fixes the dot everywhere it is mounted, and the chip inherits the fix. Nothing here removes motion from the product; it removes motion from the main thread.

---

## Open Questions {#open-questions}

- **The render-cost budget.** A threshold in milliseconds per sampled frame for the circuit breaker and the tripwire, and how many consecutive samples trip it. The number is a measurement the [B04] verb makes on a healthy deck before it can be set; the brief cannot invent it.
- **Silent or announced demotion.** Whether [B07] demotes with only a log record, or also shows a one-line notice in the Session card so the user knows why the dots went still. The user's call; the mechanism is the same either way.
- **The tugcast-to-deck command shape for [B04].** Whether it rides an existing feed or needs a new message in `tugproto`. Readable from the code at the door.
- **Whether this WebKit exposes the `event` entry type** ([B09]). Settled by one feature-detect on the release build.

---

## Non-goals {#non-goals}

- **Private API in the host, in any form.** Ruled out by the user and by [B02]. Not reopened for any measurement.
- **A host-side process CPU meter, public or not.** It measures a proxy, it needs a process identity the host cannot obtain publicly, and [B01] makes it unnecessary.
- **Relying on the system Reduce Motion setting.** Tug follows the media query and zeroes every duration when it is on, but a user preference is not an enforcement mechanism, and the setting's location was misreported during this investigation. Motion-off remains a preference, not a fix.
- **Moving the dot to a canvas or a worker.** The doctrine's instrument carve-out is for data redraws on worker-owned canvases, not for a glyph; a compositor-resident CSS animation is the right residency for a breathing dot, and the work makes that residency verifiable rather than replacing it.
- **Removing the dot from the composer chip, or the breath from the dot.** The user wants both.
- **Settling the 773-session population in this work.** The bill is real ([F04]) and [B04] makes it measurable, but reducing it is its own investigation.

---

## Exit {#exit}

An arc. The first steps, in the order they must land: the [B01] probe and the [B04] verb, because every later step is verified with them and they name today's culprit; then [B05] and [B06] together, since the lint is what keeps the split from regressing; then the [B08] tripwire, which is the gate for landing the dot changes; then [B07], read against a budget the probe has measured; [B09] alongside, where the engine allows it.
