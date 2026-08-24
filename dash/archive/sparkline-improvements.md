<!-- devise-skeleton v4 -->

## Sparkline Registration and Dormancy Hardening {#sparkline-improvements}

**Purpose:** Make `TugSparkline` draw a correct, continuously-registered tape on every surface it is mounted on — by putting the tape's time axis and its scroll animation on one clock, by never moving the scroll transform before the pixels for that position exist, and by making the visibility gate stop churning inside a scrolling list.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-08-08 (vet fixups folded in) |

---

### Phase Overview {#phase-overview}

#### Context {#context}

The activity sparkline (`tugdeck/src/components/tugways/tug-sparkline.tsx`) is mounted on four surfaces with the same component and, on two of them, literally the same numbers: the Session card's PULSE strip (`tugdeck/src/components/tugways/cards/session-pulse-strip.tsx`, 64×22), the Lens Cards section's session monitor row (`tugdeck/src/components/lens/sections/cards-session-cell.tsx`, also 64×22 via `TUG_SESSION_ROW_SPARK_WIDTH` / `TUG_SESSION_ROW_SPARK_HEIGHT` in `tugdeck/src/components/tugways/tug-session-row.tsx`), the expanded Pulse card's per-channel rows (`tugdeck/src/components/tugways/cards/pulse-card.tsx`, 248×26), and the Pulse Display gallery card (`tugdeck/src/components/tugways/cards/gallery-pulse-display.tsx`).

In practice the Lens tape **judders** and, less often, renders **blank or truncated** — the staircase jammed into part of the box with the rest empty — while the Session card's tape does neither. Since the two mounts are configuration-identical, the difference is not in the tape's settings; it is in how often each surface makes the tape *rebase*, and the rebase has two latent defects (see [#the-two-defects](#the-two-defects)). The Lens hits them constantly because its tapes live inside a `TugListView` scroll container whose rows change height on every pulse beat, so `TugSparkline`'s `IntersectionObserver` toggles them in and out of dormancy repeatedly; the Session card has one always-visible tape that essentially never rebases outside its 120-second epoch rollover.

Why now: the sparkline is the one piece of live ink on the Lens rail, and the Lens rail is the surface a user watches while *not* looking at a card. A tape that stutters or blanks there is the monitor lying about the thing it exists to report.

#### Strategy {#strategy}

- **Fix the clock first.** The tape positions ink by `Date.now()` and positions the canvas by `document.timeline`. Unify both onto `performance.now()`, compute `t0` from the animation's own origin, and commit it at exactly one guarded point — so the two axes cannot disagree by construction. The activity store keeps wall clock and the tape converts at one named seam.
- **Never move the transform ahead of the pixels.** Every place `t0` changes today resets the transform synchronously and repaints asynchronously through the render worker. Gate every transform change on a paint acknowledgement — one path, no exceptions, with a bounded watchdog so a lost ack cannot freeze the tape.
- **Split the two dormancies.** "Every change has scrolled off" (flat, safe to rebase freely) and "the element is off screen" (arbitrary picture, must not rebase) are different states that today share one code path. Separate them; the off-screen one becomes a `pause()`, not a teardown.
- **Stop the visibility gate from flapping.** Observe against the nearest scroll container with a generous `rootMargin` and a hysteresis delay before pausing. Dormancy is an optimisation; entering it eagerly is what creates the churn.
- **Extract the policy so it can be tested without a DOM.** The clock, the tape, the dormancy protocol, and the rebase ordering move to a pure module driven by an injected clock and an output port. The component keeps only the DOM: WAAPI, the worker, the observer, computed style.
- **Sequence so each step is independently shippable.** Refactor (behaviour-preserving) → clock → ack protocol → rebase ordering → dormancy → observer → self-healing → backing store → tests.

#### Success Criteria (Measurable) {#success-criteria}

- The tape's own time axis carries no wall clock: `Date.now(` appears in `tug-sparkline.tsx` and `sparkline-tape.ts` **exactly once**, in the single documented `wallOffset` conversion at the store-read seam ([P09](#p09-wall-clock-seam)) — asserted by a drift-prevention unit test that reads both files off disk.
- For any sequence of clock values, `SparklineTape`'s **committed** `t0` satisfies `t0 === epochOrigin + n * EPOCH_MS` exactly, and the expected transform equals `-(now - t0) / 1000 * pxPerSec` — asserted by unit test in `tugdeck/src/lib/__tests__/sparkline-tape.test.ts`.
- No paint ever carries a `t0` other than the committed one, except the single rebase paint that proposes the next: in every recorded surface trace, the multiset of `t0` values across all paints between two `setEpochStart` calls has exactly one member ([P10](#p10-committed-t0)).
- In the recorded surface trace of the policy module, **every** `setEpochStart` call is immediately preceded by an acknowledgement — a `paintAcked` for the paint carrying the same `t0`, or the watchdog's expiry for that same paint. No unordered pair exists in any test scenario (unit test).
- A rebase whose ack never arrives still converges: `committedT0` and the transform advance on the watchdog, and a `hidden-paused` wake still resumes (unit test).
- A hidden→visible cycle produces zero animation teardowns: the recorded trace contains `pause` / `resume`, and never `cancelAnimation` / `createAnimation`, outside mount and unmount (unit test).
- In the real app, a Lens session row scrolled out of and back into its section body three times still reports exactly one animation: `document.querySelector('.sessions-monitor-spark .tug-sparkline-track').getAnimations().length === 1` and `playState === 'running'` (app-test `at0370`).
- After a devicePixelRatio change, `canvas.width === Math.ceil(svgWidth * devicePixelRatio)` on every mounted tape (app-test `at0370`).
- `bunx vite build` and `cd tugdeck && bun test` both clean; `just app-test at0370-sparkline-registration.test.ts at0282-pulse-two-level.test.ts` green.

#### Scope {#scope}

1. `tugdeck/src/components/tugways/tug-sparkline.tsx` — clock unification, rebase ordering, dormancy split, observer hardening, backing-store correctness.
2. New `tugdeck/src/lib/sparkline-tape.ts` — the extracted, DOM-free tape/clock/dormancy policy.
3. `tugdeck/src/lib/workers/sparkline-render-worker.ts` and its `SparklineWorkerRequest` type — add a paint acknowledgement message.
4. `tugdeck/src/lib/sparkline-geometry.ts` — unchanged geometry, but its `SparklinePoint.t` contract is restated as monotonic-clock ms.
5. `tugdeck/src/test-surface.ts` — a `recordActivity` hook so an app-test can drive the real `SessionActivityStore` deterministically.
6. New `tests/app-test/at0370-sparkline-registration.test.ts`.
7. New `tugdeck/src/lib/__tests__/sparkline-tape.test.ts`.

#### Non-goals (Explicitly out of scope) {#non-goals}

- Changing what the tape *plots*: the rolling-rate window, `sparklineCurves`, `fullScale`, `ACTIVITY_BIN_MS`, the composite/dominant logic in `tugdeck/src/lib/session-activity-store.ts`. This plan is about registration, not response.
- **Migrating the activity store off wall clock.** `RateMeter` in `tugdeck/src/lib/activity-meter.ts` bins on absolute wall-clock bin indices and is shared by non-sparkline consumers (the Pulse card's raw readouts, `dominant`'s hysteresis, tugcast frame receipt binning). It stays on `Date.now()`; the tape converts at one seam ([P09](#p09-wall-clock-seam)).
- Redesigning the sample-and-hold staircase in `tugdeck/src/lib/sparkline-geometry.ts`.
- Reducing the canvas's surface area (`svgWidth = width + EPOCH_S * pxPerSec + 8`, currently 584 CSS px per Lens row and 2240 per Pulse-card channel row). Recorded as a follow-on in [#roadmap](#roadmap).
- Changing the Lens's list virtualisation or `TugListView`'s `offscreenSkip` (which the Lens does not enable — only the transcript does).
- Any change to `tug-chart-glyph.tsx`, which is a static font-glyph sparkline with no tape at all.

#### Dependencies / Prerequisites {#dependencies}

- None outside the repo. All work is in `tugdeck/` plus one new app-test.
- Requires `bun` (never npm) for the deck; `bunx vite build` before declaring any tugdeck change done, because the debug app loads the prod rollup bundle.

#### Constraints {#constraints}

- **[L13]** motion is a WAAPI transform or TugAnimator — never an rAF/timer frame loop. The sample timer stays a data timer, not an animation loop.
- **[L06]** appearance is CSS + DOM attributes, never React state. The tape, `t0`, dormancy, and the `data-activity-channel` stamp all stay out of React.
- **[L02]** external state enters React only via `useSyncExternalStore` — the sparkline reads `SessionActivityStore` imperatively, which stays legal because nothing it reads is rendered.
- **[L26]** mount identity must be stable across logical transitions. `HTMLCanvasElement.transferControlToOffscreen()` may be called **once per element**, so any geometry or DPR change must arrive as a *new* element (a changed `key`), never a second transfer of a spent one.
- **[L27]** every acquisition returns its release: the worker entry, the observer, the theme subscription, and the animation are all released in the effect's cleanup.
- **[L03]** setup that events depend on goes in `useLayoutEffect`.
- App-tests run in **background windows with no rAF** and a possibly-suspended rendering pipeline (see `tuglaws/app-test-harness.md` and the harness notes). Nothing in the app-test may depend on animation frames advancing; assertions must read state that is correct synchronously.
- Warnings are errors in the Rust workspace; no Rust in this plan, but `tsc`/lint cleanliness is expected, including pre-existing issues surfaced in touched files.

#### Assumptions {#assumptions}

- `document.timeline.currentTime` and `performance.now()` share the document's time origin, so an `Animation.startTime` may be set from `performance.now()` directly. (Verified against the Web Animations spec; pinned by an assertion in [#step-9](#step-9) that reads both and records the delta.)
- The activity store's meters are wall-clock-binned and stay that way. `RateMeter.record(units, atMs)` computes `Math.floor(atMs / binMs)` as an **absolute** bin index, and `RateMeter.series(nowMs)` calls `advanceTo(Math.floor(nowMs / binMs))` — which is the mechanism that zero-fills idle bins and makes a stalled stream decay to baseline. A `performance.now()` value (≈1e5) compared against a head bin derived from `Date.now()` (≈1e12) always satisfies `bin <= headBin`, so `advanceTo` early-returns and the decay never happens. Every `getSeries` call therefore crosses a documented conversion ([P09](#p09-wall-clock-seam)).
- Setting `Animation.startTime` explicitly on a freshly created animation clears its pending start time, removing the "animation begins at the next rendering update" slop the current code inherits.
- A worker that posts an acknowledgement at the end of its `onmessage` draw handler has already queued the `OffscreenCanvas` commit for that frame; the ack is therefore a sound (if not frame-exact) proxy for "the pixels exist". Residual risk recorded as [Risk R02](#r02-ack-not-frame-exact).
- The Lens does not enable `TugListView`'s `offscreenSkip` (confirmed: the only caller is `session-card-transcript.tsx`), so `content-visibility: auto` is not a factor in the Lens symptoms.

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

Standard devise conventions apply: explicit `{#anchor}` headings, kebab-case, plan-local decisions `[P01]`+, open questions `[Q01]`+, risks `R01`+, specs `S01`+. `[D##]` is reserved for `tuglaws/design-decisions.md`.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Does the document timeline stall while the Tug window is occluded? (OPEN) {#q01-timeline-stall}

**Question:** When a Tug window is fully covered by another window, WebKit suspends rendering updates. `performance.now()` keeps advancing. Does `document.timeline.currentTime` — and therefore a running `Animation`'s `currentTime` — advance with it, or does it hold?

**Why it matters:** If the timeline holds, then on un-occlusion the animation is behind wall clock by the occlusion duration, and the tape's ink (positioned by `performance.now()`) is drawn at a position the transform has not reached. The tape would appear shifted until the next rebase. This is a plausible contributor to the reported judder, and it is exactly the class of failure the "registration self-check" in [#step-7](#step-7) exists to absorb.

**Options (if known):**
- Timeline is wall-clock-based and does not stall → the self-check is a cheap no-op safety net.
- Timeline stalls with rendering → the self-check is load-bearing and must also run on `visibilitychange`.

**What is already known:** `document.timeline.currentTime` is the current *frame* time, not a live clock — it is sampled at rendering updates. So under the branch where rendering is suspended, the timeline necessarily holds while `performance.now()` runs on. That makes "the timeline stalls" the branch to design for, whatever the exact WebKit occlusion behaviour turns out to be.

**Plan to resolve:** The design does not branch on the answer, but it does refuse to *act* on the divergence while hidden. [#step-7](#step-7) implements the self-check on every settle-burst append **while visible only**, plus a single `visibilitychange` → visible resync ([P06](#p06-registration-self-check)) — which is what keeps a stalled timeline from turning the check into a rebase storm. A diagnostic assertion in the app-test records the observed divergence after a forced occlusion so the number gets written down.

**Resolution:** DEFERRED — absorbed by the self-healing design in [P06](#p06-registration-self-check), which is correct under both answers because it acts only when the timeline is known to be advancing. Revisit only if the app-test's recorded divergence is large enough to be visible between two settle-burst ticks (250 ms).

#### [Q02] Should the epoch length shrink now that rollover is cheap? (OPEN) {#q02-epoch-length}

**Question:** `EPOCH_S = 120` forces `svgWidth = width + 120 * pxPerSec + 8` — 584 CSS px (1168 device px at dpr 2) per Lens row, and 2240 CSS px (4480 device px) per Pulse-card channel row, of which seven can be mounted at once in the Pulse popover (≈6.5 MB of backing store). Once rollover is glitch-free and free of animation teardown, epoch length is a pure texture-vs-rebase-frequency trade.

**Why it matters:** Memory cost scales linearly with `EPOCH_S`, and the Lens can hold a dozen rows.

**Plan to resolve:** Not in this phase — changing `EPOCH_S` changes what the rebase machinery is exercised by, and the machinery should land and be proven at the current value first.

**Resolution:** DEFERRED to [#roadmap](#roadmap). Revisit after [#step-10](#step-10) passes.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Extraction refactor changes tape behaviour silently | med | med | [#step-1](#step-1) is behaviour-preserving and lands with unit tests written against *current* behaviour before any semantic change | Any visual difference on the Session card after Step 1 |
| Paint ack is not frame-exact | low | med | Worst case is a bounded sub-frame stall, never a blank; a `requestAnimationFrame` boundary added only if [#step-10](#step-10) measures a seam | A visible one-frame seam at rollover |
| An ack is lost and the tape freezes | high | med | Every rebase arms a watchdog that force-commits ([P02](#p02-ack-gated-rebase)); a canvas re-claim cancels and re-issues the pending rebase ([Risk R05](#r05-lost-ack)) | A tape stuck at its epoch end, or paused after a scroll-in |
| A stalled document timeline turns the self-check into a rebase storm | med | med | `checkRegistration` runs only while `document.visibilityState === "visible"`; the `visibilitychange` resync is the single recovery ([P06](#p06-registration-self-check)) | Repeated `rebase` verdicts in the dev log while the window is occluded |
| Worker ack reintroduces main-thread cost | low | low | Ack rides only on paints flagged `ackTransform`, which happen at rebases (rare), never on the 4 Hz sample path | Any regression in `at0293-typing-latency` |
| Hysteresis keeps off-screen tapes live too long | low | low | 500 ms delay only; the tape still goes fully inert via flat-dormancy on its own timer | CPU regression with many Lens rows |
| DPR-driven canvas replacement thrashes | low | low | Keyed on the *quantised* dpr value, changed only by a `matchMedia` resolution transition | Repeated remounts observed in the dev log |
| The wall-clock seam is closed by a later edit, killing the rate decay | high | med | Drift test asserts *exactly one* `Date.now(`; a decay-to-baseline unit case tests the behaviour directly ([Risk R04](#r04-clock-seam-reopened)) | A tape that holds its level after a stream stops |
| A pending rebase lets an ordinary paint use the wrong `t0` | high | med | `committedT0` is the sole painting authority ([P10](#p10-committed-t0)); the trace test asserts one `t0` per inter-rebase interval | Any trace with two distinct `t0` values between `setEpochStart` calls |

**Risk R01: The extraction hides a behaviour change** {#r01-extraction-hides-change}

- **Risk:** Moving the tape/clock/dormancy protocol out of the component's `useLayoutEffect` closure into a class changes an ordering nobody wrote down.
- **Mitigation:**
  - Step 1 is a pure move: same constants, same call order, same `Date.now()` clock, only the seam changes.
  - The unit tests written in Step 1 encode *current* behaviour (born-dormant, settle-burst stop condition, flat-off scheduling, deadband reference advance) and must stay green through every later step except where a decision explicitly changes them.
- **Residual risk:** Behaviour the current code has by accident and no test captures.

**Risk R02: The worker ack is not frame-exact** {#r02-ack-not-frame-exact}

- **Risk:** The worker's ack proves the draw *ran*, not that the compositor *presented* it. The transform could still move one frame early.
- **Mitigation:**
  - Apply the transform directly from the ack handler. Only if [#step-10](#step-10) measures a visible seam should a `requestAnimationFrame` boundary be added, and then with an explicit [L13] exemption note — rAF parked in a motion path is what that law polices.
  - Worst case is a one-frame seam every 120 s instead of the current unbounded blank.
- **Residual risk:** A single-frame artefact under extreme worker backpressure.

**Risk R05: A rebase ack never arrives** {#r05-lost-ack}

- **Risk:** `committedT0` and the transform advance only in `onPainted`. Nothing bounds the wait, and there are three real ways the ack is lost: [P07](#p07-dpr-reactivity)'s canvas re-claim releases the worker entry and unregisters the id while a rebase is in flight; the page-lifetime shared worker dies, taking every tape's pending rebase with it; a `dispose` races a `tape` message. A `hidden-paused` wake carries `resumeAfterRebase`, so a lost ack there leaves the animation **paused forever** — not merely unmoved.
- **Why [P06](#p06-registration-self-check) cannot cover it:** the self-check runs from the settle burst and only while `state === "live"`. A tape stuck mid-rebase is not live, so the self-healing path never reaches it.
- **Mitigation:**
  - Every `rebase` arms `REBASE_ACK_TIMEOUT_MS` on the tape's injected timers. On expiry the tape commits exactly as `onPainted` would — the pixels are at worst one paint stale, which is strictly better than a frozen or paused tape.
  - The canvas-claim effect cancels the pending rebase and re-issues it after `repaint()` ([#step-8](#step-8)), so the common case never reaches the watchdog.
- **Residual risk:** One watchdog-length window of stale pixels in a failure that today has no bound at all.

**Risk R03: Judder has a contributing cause outside this plan** {#r03-other-causes}

- **Risk:** The diagnosis in [#the-two-defects](#the-two-defects) is derived from code reading, not from an instrumented reproduction. Compositing behaviour inside the Lens rail (a composited layer under `overflow: hidden` inside a scroll container, under `.tug-pulse-trailing`'s `translateY(-3px)`) could contribute independently.
- **A second churn source the diagnosis under-weights: row reordering.** The Cards section re-sorts session rows by activity (`at0257-lens-session-reorder`), so during streaming the rows most likely to move are the ones whose tapes are live. Every reorder both fires the intersection observer and moves the row in the DOM. Hardening the observer ([P04](#p04-observer-hysteresis)) cures the first only if the second preserves mount identity — a reorder that remounts a row would rebuild its tape from scratch, and no amount of rebase ordering would help. [#step-6](#step-6) verifies this directly rather than assuming it.
- **Mitigation:**
  - [#step-9](#step-9) adds a `recordActivity` test-surface hook, which makes the symptom reproducible on demand for the first time.
  - The success criteria are stated as invariants of the component's own state machine, so they are falsifiable whether or not the compositor also misbehaves.
- **Residual risk:** Residual judder after all steps land, attributable to layer management rather than registration. Escalate by capturing a WebKit layer tree at that point.

**Risk R04: The wall-clock seam is re-crossed by a later change** {#r04-clock-seam-reopened}

- **Risk:** [P09](#p09-wall-clock-seam) leaves exactly one `Date.now()` in the tape path. A future edit that adds a second — or that "tidies" the conversion away — silently kills the rate decay, and the symptom (a tape that holds its level instead of falling to baseline) reads as a data problem rather than a clock problem.
- **Mitigation:**
  - The drift-prevention test asserts **exactly one** occurrence, not zero, so both adding and removing it fail the suite.
  - A unit case drives a stalled stream past the rate window and asserts the plotted value reaches baseline — the behaviour the seam protects, tested directly rather than by proxy. It is written in [#step-1](#step-1), *before* the clock moves, so it is a genuine regression guard rather than a post-hoc rationalisation.
- **Residual risk:** A consumer other than the sparkline reading meters on a monotonic clock; nothing does today.

---

### Design Decisions {#design-decisions}

#### [P01] The tape and its scroll share one monotonic clock (DECIDED) {#p01-one-clock}

**Decision:** All tape timestamps (`SparklinePoint.t`, `t0`, `lastChangeAt`, `lastEventAt`) use `performance.now()`. The scroll animation's origin is set explicitly with `anim.startTime = <that same clock value>`. `t0` is **computed** from the animation origin rather than assigned by hand — but the value the tape *paints with* is the committed one, not the instantaneous computation (see [P10](#p10-committed-t0)).

**Rationale:**
- Today `t0` is `Date.now()` and the transform runs on `document.timeline`. The two are never reconciled, so the mapping `xOf(t) = width + (t - t0)/1000 * pxPerSec` in `sparkline-geometry.ts` is only as accurate as the accident that produced `t0`.
- `track.animate(...)` returns an animation with a **pending** start time, resolved at the next rendering update. The line above it already ran `Date.now()`. Whatever separates them is a permanent horizontal offset for the whole 120-second epoch, and it varies per instance and per main-thread load — which is why a rail of tapes drifts apart from each other and from the card.
- `Date.now()` is wall clock: an NTP step or a laptop sleep/wake moves the tape's ink relative to its own motion. `performance.now()` is monotonic.
- Computing `t0` as `epochOrigin + floor((now - epochOrigin) / EPOCH_MS) * EPOCH_MS` removes an entire category of assignment bug: there is no ad-hoc `t0 = now` line left to get wrong. What remains is exactly one guarded commit point ([P10](#p10-committed-t0)).

**Implications:**
- `SparklinePoint.t` is documented as monotonic-clock ms, not wall-clock ms. Nothing persists a tape, so there is no migration.
- The animation is created once per mount and never recreated; the rollover is a `startTime` write, not `cancel()` + `animate()`.
- Reads of `SessionActivityStore` cross a wall-clock boundary and must convert ([P09](#p09-wall-clock-seam)).
- The reduced-motion path (`isTugMotionEnabled() === false`) has no animation and therefore no animation origin. It uses a synthetic origin re-seeded to the newest sample on every append — the behaviour today's `if (!motion) t0 = now;` produces — and never calls `setEpochStart`, `pause`, or `resume`.

#### [P02] A `t0` rebase is applied only when the pixels for that `t0` are already on screen (DECIDED) {#p02-ack-gated-rebase}

**Decision:** The scroll transform is never moved in the same tick as a `t0` change. **Every** rebase goes through one path: the repaint is posted to the render worker with a sequence number, and the transform is applied from the worker's `painted` acknowledgement. A `REBASE_ACK_TIMEOUT_MS` watchdog commits anyway if that acknowledgement never arrives ([Risk R05](#r05-lost-ack)). There is no fast path.

**Rationale:**
- This is the direct cause of the truncated tape. `startEpoch`, `enterDormant`, and `wakeLive` all change `t0` and reset the transform synchronously, while the repaint travels `postMessage` → shared worker → compositor and lands one or more frames later. In that window the viewport shows the canvas at the new transform with the old pixels, displaced by up to `epochPx` (512 px on a 584 px canvas). Because a tape's ink occupies only about 81 px of that canvas and everything else is unpainted, the viewport frequently lands on blank canvas or on the boundary — a tape with an empty left portion and the staircase jammed to one side.
- **A flat picture is NOT a licence to skip the ack, and an implementer must not reintroduce one.** The tempting shortcut is "a flat tape is a horizontal line, and translating a horizontal line changes nothing." It is false, and it fails in exactly the way this decision exists to prevent: the picture is flat across the *ink*, not across the *canvas*. `drawSparkline` clears the whole surface and begins its path at `xOf(tape[0].t)`, so everything left of the oldest retained point is empty. At a rollover the stale pixels put the ink at x ≈ 495–584 while the post-move viewport sits at x ≈ [0, 64] — blank, for one round-trip, on every idle rollover. A skipped ack would have shipped the defect down the path the design called free.
- **And the fast path buys nothing anyway.** The stall an ack costs is only perceptible while something is moving, and while something is moving the tape is not flat. A flat tape that pauses for a round-trip is pixel-identical to a flat tape that does not. One path is both correct and simpler.
- Gating on the ack keeps the hot 4 Hz sample path one-directional, which is the worker's documented design contract; only rebase paints carry the flag.

**Implications:**
- `SparklineWorkerRequest`'s `tape` message gains an optional `ack` sequence number, and the worker gains one outbound message type. The main thread must install an `onmessage` handler on the shared worker and route by `id`.
- The on-main fallback painter (used when `transferControlToOffscreen` is unavailable) draws synchronously. It must **defer** its ack through `queueMicrotask` rather than calling back from inside `paint()`, or `setEpochStart` would run re-entrantly inside the tape's own paint call.
- A rebase that is superseded before its ack arrives is dropped by sequence number.
- Every rebase arms `REBASE_ACK_TIMEOUT_MS` on the tape's injected timers, cleared by the ack. On expiry the tape commits exactly as `onPainted` would ([Risk R05](#r05-lost-ack)). This is not defensive padding: without it, a canvas re-claim during a `hidden-paused` wake leaves the animation paused with no path back.
- **The rollover freezes for one round-trip, and that is the accepted trade.** While a rebase ack is outstanding the animation sits at its `fill: forwards` end position — the *correct* pixels, simply not moving. On the Lens tape that is a stall of one worker round-trip once every 120 s. It cannot be pre-empted by painting ahead: the canvas holds one `t0` at a time, so a pre-painted next-epoch canvas would be wrong for the transform still in force. Trading a bounded sub-frame stall for an unbounded blank is the whole point.
- **Apply the transform directly from the ack handler.** Do not wrap it in `requestAnimationFrame` by default: [L13] reserves rAF for gesture-driven frame loops, and a one-shot defer parked in a motion path is exactly the shape that law polices. Reach for a frame boundary only if [#step-10](#step-10) measures a visible seam, and if so record the exemption in the code comment.

#### [P03] Off-screen is a pause, not a teardown (DECIDED) {#p03-pause-not-teardown}

**Decision:** `TugSparkline` distinguishes **flat-dormancy** (every change has scrolled off; the tape is inert and the picture is flat) from **hidden-pause** (the element is not intersecting; the picture is arbitrary). Flat-dormancy behaves as today. Hidden-pause calls `anim.pause()` and stops the timers, leaves `t0` and the transform exactly where they are, and rebuilds/resyncs on re-entry through the ack-gated path.

**Rationale:**
- Today both go through `enterDormant`, which does `anim.cancel()` (with `fill: forwards`, cancellation removes the effect and snaps the transform to `translateX(0)`) and `t0 = now`. For a flat picture that is harmless. For the Lens's off-screen rows it is a full-magnitude rebase of a non-flat picture on every scroll boundary crossing — the judder.
- `wakeLive` then rebuilds the entire tape by re-quantising ten seconds of `compositeSeries` history onto the 250 ms bin grid and restarts the epoch from `translateX(0)`. The whole visible staircase re-lands on a different grid, on top of the transform snap.
- Pausing is strictly cheaper than tearing down: no animation object churn, no `onfinish` respawn hazard, and the compositor keeps the layer.

**Implications:**
- `enterDormant` splits into `enterFlatDormancy` and `enterHiddenPause`. Both wake through the same ack-gated rebase ([P02](#p02-ack-gated-rebase)); what differs is only what they preserved on the way in.
- `surface.setEpochStart(t)` writes a resolved `startTime`, which clears the animation's hold time — so it **un-pauses on its own**. The `resume()` that follows it in Spec S01 is belt, not braces: keep it so the trace reads as an explicit state change, but do not build anything on the idea that the animation is still paused after the origin moves.
- `committedT0` must not move while paused, and it does not: it only ever advances inside the rebase protocol, which does not run while paused. The next move happens at resume, as part of the ack-gated rebase ([P10](#p10-committed-t0)).

#### [P04] The visibility gate observes the scroll container, with hysteresis (DECIDED) {#p04-observer-hysteresis}

**Decision:** The `IntersectionObserver` uses the nearest scrollable ancestor as its `root` (falling back to the viewport) and a `rootMargin` of `"160px 0px"`. The component reports raw intersection to `SparklineTape.setVisible(visible)`; the **500 ms continuous-out-of-view hysteresis lives inside `SparklineTape`**, on its injected timers. Re-entry is immediate and cancels any pending pause.

**Rationale:**
- Today the observer takes the default root and `threshold: 0`. In the Lens the tape sits inside a `TugListView` scroll container, and rows re-measure constantly: `useMiddleTruncation` in `tug-pulse.tsx` runs a `ResizeObserver` on `.tug-pulse-line` — the sparkline's own parent — and rewrites the clipped activity run on every pulse beat, while `TugPulse`'s headline appears and disappears with the session overview. Rows near the clip edge therefore cross the boundary repeatedly, and each crossing today runs a full teardown-and-rebuild.
- `rootMargin` expands the *root's* rect, so it only helps if the root is the scroller — hence pairing the two.
- Hysteresis is the part that actually stops churn: dormancy is an optimisation, and an optimisation that fires on a 16 ms flap costs more than it saves.
- The hysteresis belongs to the tape, not the component: "how long out of view before we stop" is a policy question about dormancy, it already has injected timers to run on, and putting it there is what makes it testable. A debounce living in the component would be reachable only from an app-test that cannot advance frames.

**Implications:**
- A small `nearestScrollableAncestor(el)` helper (computed `overflow-y` of `auto`/`scroll`/`overlay`) lives in the component; the policy module stays DOM-free.
- The pause timer is `SparklineTape`'s and is cleared by `stop()`, which the effect cleanup calls ([L27]).

#### [P05] The tape's policy is a DOM-free module; the component is only the DOM (DECIDED) {#p05-policy-extraction}

**Decision:** The clock, the tape array, the deadband/settle/flat-off protocol, dormancy, and the rebase ordering move into `tugdeck/src/lib/sparkline-tape.ts` as a `SparklineTape` class taking an injected `now()` and a `SparklineSurface` output port. `TugSparkline` keeps the canvas claim, WAAPI, the `IntersectionObserver`, computed-style colour resolution, and the worker wiring.

**Rationale:**
- The rebase-ordering guarantee in [P02](#p02-ack-gated-rebase) is a statement about the *order of two calls*. That is exactly what a recorded output-port trace can assert, and exactly what no DOM-level test can assert cheaply — app-tests run in background windows with no rAF, so anything that depends on animation frames advancing is untestable there.
- The project bans jsdom render tests and mock-store assertion tests. This is neither: `SparklineTape` is real production code carrying the real logic, the clock is a production seam ([P01] makes it one), and the surface port is the component's real interface to WAAPI and the worker. The component's DOM behaviour is still covered by a real app-test.
- The current 800-line component mixes six concerns in one `useLayoutEffect` closure; the defects in this plan are all ordering defects in that closure.

**Implications:**
- New file `tugdeck/src/lib/sparkline-tape.ts` with `SparklineTape`, `SparklineSurface`, `SparklineTapeOptions`.
- `TugSparkline`'s `useLayoutEffect` becomes construction + wiring + cleanup.
- The two existing `useLayoutEffect`s keep their split (canvas claim vs. tape), because `transferControlToOffscreen` is once-per-element ([L26]).

#### [P06] Registration is self-healing, not assumed (DECIDED) {#p06-registration-self-check}

**Decision:** On every settle-burst append (only while live, i.e. only when something is already happening, **and only while `document.visibilityState === "visible"`**), the component compares the animation's implied scroll position against the position the clock implies. Divergence under `REGISTRATION_OK_PX` (1 CSS px) is ignored; between that and `REGISTRATION_NUDGE_MAX_PX` (2 CSS px) it is corrected in place by writing `anim.startTime`; **anything larger escalates to an ack-gated rebase.** The same check runs once on `document`'s `visibilitychange` → visible, which is the sole recovery path for anything that happened while hidden.

**Rationale:**
- [Q01](#q01-timeline-stall) is unresolved and does not need to be: a design that *verifies* its own registration is correct under both answers.
- **But the check must not run while hidden, or Q01's likely answer turns the cure into the disease.** `document.timeline.currentTime` is the current *frame* time, not a live clock: it advances at rendering updates and stops entirely when WebKit suspends rendering for an occluded window, while `performance.now()` keeps going. Left ungated, the self-check would then see a divergence growing without bound and return `rebase` every 250 ms for the whole occlusion — and each of those rebases writes a `startTime` *ahead* of the stalled timeline, putting the animation in its before-phase, where a `fill: "forwards"` effect does not apply and the element snaps to `translateX(0)` over epoch-end pixels. That is this plan's own defect, re-manufactured at 4 Hz. Gating on `visibilityState` costs one property read and removes the whole failure mode; the `visibilitychange` resync then does the single correction that was actually needed.
- The check costs one property read on a path that already runs at 250 ms and only while the tape is active. An idle tape still costs zero, which is the component's standing contract.
- **The nudge band must stay tiny, because a nudge is an unrepainted transform move.** It is the one sanctioned exception to [P02](#p02-ack-gated-rebase), and it is only sanctioned because a ≤2 px shift of a staircase is below what the eye resolves on a 22 px tape. A wide nudge band would silently reintroduce the exact defect this plan removes — a transform moving ahead of its pixels — just at smaller amplitudes. Anything the eye could catch goes through the ack.
- Escalation reuses [P02](#p02-ack-gated-rebase) unchanged, so the large-divergence case is provably safe rather than merely rare.

**Implications:**
- The policy module exposes `checkRegistration(animCurrentTimeMs)` and returns one of `ok` / `nudge(startTimeMs)` / `rebase`.
- `REGISTRATION_OK_PX` and `REGISTRATION_NUDGE_MAX_PX` are named constants in `sparkline-tape.ts`, not inline literals, so the band is one legible knob.
- Visibility is the component's to know, so the gate is applied at the call site: the component simply does not call `checkRegistration` while `document.visibilityState !== "visible"`. The policy module stays DOM-free and the unit tests drive the verdict function directly.
- The app-test records the observed divergence after a forced background/foreground transition, which writes down the answer to [Q01](#q01-timeline-stall).

#### [P07] The canvas's backing store tracks the live device pixel ratio (DECIDED) {#p07-dpr-reactivity}

**Decision:** `TugSparkline` listens for resolution changes via `matchMedia('(resolution: <dpr>dppx)')` and, on change, bumps a `dprEpoch` piece of React state that participates in the canvas element's `key` and in the geometry passed to the painter. **The canvas-claim effect repaints the committed tape immediately after re-claiming**, through `SparklineSurface.repaint()`.

**Rationale:**
- Today `dpr` is read once inside the canvas-claim effect and is **not** in its dependency array. Moving the window to a different-resolution display, or applying page zoom (which changes `devicePixelRatio` in WebKit and is known to persist per bundle), leaves the backing store permanently mismatched to the presentation size — a soft, resampled tape with no way back short of a reload.
- Replacing the element via `key` is required, not optional: `transferControlToOffscreen()` throws `InvalidStateError` on a second call for the same element ([L26]).
- This is structure-zone state — it changes *what exists*, not how something looks — so `useState` is the correct mechanism and does not violate [L06].
- **Without the forced repaint the fix would blank every idle tape.** Re-claiming releases the old worker entry and creates a new one whose tape starts empty. The *tape* effect does not re-run (dpr is not in its deps), so nothing would post points. A live tape recovers within one settle tick; a `flat-dormant` or `hidden-paused` tape — which is most of the Lens most of the time — would stay blank until its next activity, which may be never.

**Implications:**
- One new piece of React state in the component, declared in [#state-zone-mapping](#state-zone-mapping).
- The canvas `key` becomes `` `${svgWidth}x${height}@${dpr}` ``.
- **A re-claim can orphan an outstanding rebase, so it must cancel and re-issue one.** Releasing the old painter unregisters its ack route ([Risk R05](#r05-lost-ack)); the claim effect therefore calls `cancelRebase()` before `repaint()`, and the tape re-proposes on its next tick. The watchdog is the backstop for the case this ordering misses, not the primary path.
- **The surface must resolve the painter lazily.** Today every draw is `painterRef.current?.draw(...)` — a lookup per call, which is exactly what lets the claim effect swap painters under a live tape. The extracted `SparklineSurface` is constructed once in the *tape* effect while the painter is replaced by the *claim* effect, so its methods keep reading `painterRef.current` at call time. Capturing the painter in a closure would compile, pass every unit test, and blank the tape on the first resolution change.
- `SparklineTape` gains a public `committedT0()` accessor — the theme-change path (`subscribeThemeChange` → `painter.refreshColors(t0)`) needs the same number and must not read it out of the test-only `debugState()`.
- **[L26] audit, all three inputs.** The `key` change is a *deliberate* remount and L26 permits it — a canvas whose control has been transferred to a worker is genuinely a spent entity, so "a new entity has appeared" is the honest reading. The other two inputs are unchanged: the component type is still `"canvas"` and there is no renderer map in play. Critically the `key` sits on the `<canvas>` **only** — `.tug-sparkline` and `.tug-sparkline-track` keep their identity, so the tape effect, the animation, and the observer all survive a resolution change untouched.

#### [P08] A spent canvas degrades to the on-main painter instead of throwing (DECIDED) {#p08-transfer-guard}

**Decision:** `makePainter` wraps `canvas.transferControlToOffscreen()` in a `try`/`catch`; on failure it falls through to the existing 2D-context painter.

**Rationale:**
- The current code relies on the `key` being sufficient to guarantee a fresh element. Under React StrictMode's double-invoked effects, or any future dependency change that does not also change the key, the second transfer throws **out of a `useLayoutEffect`** — which does not fail one sparkline, it fails the render pass that contains it. In the Lens that is the whole rail.
- The fallback path already exists and draws the identical geometry; losing the worker thread is a performance regression, not a correctness one.

**Implications:**
- One `try`/`catch` and a dev-log line via `tugDevLogStore` (never `console.warn`).

#### [P09] The activity store stays on wall clock; the tape converts at one seam (DECIDED) {#p09-wall-clock-seam}

**Decision:** `SessionActivityStore` and the meters in `activity-meter.ts` keep binning on `Date.now()`. `SparklineTape` captures `wallOffset = Date.now() - now()` once in `start()` and passes `now + wallOffset` to **every store-facing callback** — `getSeries` *and* `getColorChannel`, which take the same `nowMs` contract. That single expression is the only wall clock in the tape's code, it is named, and it is re-derived on the `visibilitychange` resync.

**Rationale:**
- `RateMeter.record(units, atMs)` computes an **absolute** bin index `Math.floor(atMs / binMs)`, and `RateMeter.series(nowMs)` calls `advanceTo(Math.floor(nowMs / binMs))`. That `advanceTo` is the *entire* zero-fill-on-advance decay mechanism — it is what makes a stalled stream fall to a flat line. Handing it a `performance.now()` value (≈1e5) against a head bin minted from `Date.now()` (≈1e12) always takes the `bin <= this.headBin` early return, so the window never advances and the tape would freeze at its last level instead of drawing the drain. Drawing that drain is exactly what the settle burst exists for, so this would have quietly defeated the component's central behaviour.
- Moving the store to a monotonic clock instead is the larger, worse change: the meters are shared by the Pulse card's raw readouts, `dominant`'s hysteresis, and tugcast frame receipt binning, and wall clock is the honest semantics for a store keyed off wire arrival.
- One named conversion at one seam is auditable. Two clocks used interchangeably is what caused the original defect.
- **`getColorChannel` is a store read too, and it is the one that will be forgotten.** Its `nowMs` reaches `SessionActivityStore.dominant(session, nowMs)`, which spends it twice: on `compositeSeries(session, nowMs)` (wall-clock bins, same trap as `getSeries`) and on the dominance hysteresis, which stamps `{ channel, since: nowMs }` and compares it against state that `record()` writes from wall clock. Today's only consumer (`pulse-card.tsx`'s fixed-channel row) ignores the argument entirely, so a monotonic value here would break nothing on the day it shipped and everything on the day the compact strip started using `dominant`. The seam is defined over the callback *contract*, not over the current callers.

**Implications:**
- `SparklineTapeOptions` gains nothing — `wallOffset` is derived internally from the injected `now()` plus `Date.now()`, so a unit test with a fake clock still gets a consistent offset.
- The success criterion is "exactly one `Date.now(`", not zero.
- Drift between the two clocks over hours is bounded by NTP correction and is irrelevant at a 250 ms bin width; the `visibilitychange` re-derivation covers sleep/wake.

#### [P10] Paints use the committed `t0`; a rebase only proposes the next one (DECIDED) {#p10-committed-t0}

**Decision:** `SparklineTape` holds `committedT0` as its single painting authority. Every ordinary paint — mount, settle-burst append, colour repaint, forced repaint — uses `committedT0`. `proposedT0(now)` computes `epochOrigin + floor((now - epochOrigin) / EPOCH_MS) * EPOCH_MS` and is consulted **only** by the rebase protocol; `committedT0` advances to it in the same statement that calls `setEpochStart`.

**Rationale:**
- A purely derived `t0` is wrong, and wrong in exactly the way this plan exists to fix. The instant the clock crosses an epoch boundary, a derived `t0` jumps — while the transform is still ack-gated at the old epoch's end. Any settle-burst paint landing in that window would draw for the new `t0` under the old transform: the same "pixels and motion disagree" defect, relocated from the rollover into the ordinary sample path, and firing at 4 Hz instead of once per epoch.
- Making the commit point explicit also makes the ordering invariant checkable: a trace in which any paint between two `setEpochStart` calls carries a different `t0` is a bug by inspection.

**Implications:**
- The rollover **trigger** cannot be `anim.onfinish`. Under [P03](#p03-pause-not-teardown) a paused animation never finishes, so a tape that was hidden across a boundary would never roll over. The trigger is instead evaluated on the tape's own tick: roll over when `proposedT0(now) !== committedT0`, which is equivalently "the newest sample's x has passed `svgWidth - width`". `anim.onfinish` may stay as a cheap redundant nudge but must not be the only path.
- `committedT0()` is public — the component's theme-repaint path needs it.
- While a rebase is pending, `committedT0` is unchanged, so the tape keeps painting a correct (if increasingly right-shifted) picture. The held tail in `drawSparkline` extends to `svgWidth`, which is why one round-trip of over-run is safe: `svgWidth = width + epochPx + 8` reserves 8 px past the epoch's end precisely for this.

---

### Deep Dives {#deep-dives}

#### The two defects, precisely {#the-two-defects}

**Defect 1 — two unreconciled clocks.**

`tug-sparkline.tsx` places ink with `Date.now()`: `tape.push({ t: now, v })`, `t0 = Date.now()`, and `sparkline-geometry.ts`'s `xOf(t) = width + ((t - t0) / 1000) * pxPerSec`. It places the *canvas* with a WAAPI animation on `document.timeline`. `startEpoch()` reads `Date.now()` into `t0` and then calls `track.animate(...)`, whose start time is pending until the next rendering update. The gap between those two events is a permanent offset for the whole epoch, it varies with main-thread load, and it differs per instance — so a rail of tapes sits at slightly different offsets from each other and from the card, and each rollover reshuffles them. `Date.now()` additionally exposes the tape to wall-clock steps and sleep/wake.

**Defect 2 — the rebase moves the transform before the pixels exist.**

Three functions change `t0` and the transform in one tick:

| Function | What it does to `t0` | What it does to the transform | Repaint |
|---|---|---|---|
| `startEpoch()` | `t0 = Date.now()` | `anim.cancel()` (removes a `fill: forwards` effect → snaps to `translateX(0)`), then a fresh `animate()` with a pending start | `redraw()` → `postMessage` |
| `enterDormant(now)` | `t0 = now` | `anim.cancel()` → snaps to `translateX(0)` | `redraw()` → `postMessage` |
| `wakeLive(now)` | via `rebuildTape` + `startEpoch` | as `startEpoch` | two `postMessage`s |

The transform change is synchronous. The repaint goes main thread → `postMessage` → shared render worker → `drawSparkline` → compositor commit, landing one or more frames later and queued behind every other tape's paint. For those frames the viewport shows the canvas at the **new** transform with the **old** pixels.

The displacement is `P = (now - t0_old) / 1000 * pxPerSec`, up to `epochPx` = `EPOCH_S * pxPerSec` = 512 px on the 584 px Lens canvas. A tape's actual ink spans only about `retainMs * pxPerSec` ≈ 81 px of that canvas (`drawSparkline` begins its path at `xOf(tape[0].t)` and paints nothing to the left of it); the rest is cleared. So the 64 px viewport, displaced by up to 512 px, usually lands on blank canvas and occasionally straddles the ink boundary. **That is the truncated sparkline in the report: a blank left portion with the staircase jammed to one side.**

**Why the Lens and not the card — frequency.**

Defect 2 is not rarer on the card because the card's rebases are safer; there is no safe rebase. It is rarer because the card has **one** always-visible tape whose only rebase is the 120-second epoch rollover — so the artefact is a sub-second blank once every two minutes on a surface nobody is staring at, which reads as nothing at all.

(It is worth stating what is *not* true here, because it is the plausible-sounding thing an implementer will reach for: that a flat tape is safe to rebase without an ack because a horizontal line is translation-invariant. The line is flat across the ink, not across the canvas — `drawSparkline` clears the surface and starts its path at `xOf(tape[0].t)`, so a rollover moves the viewport onto cleared pixels whether the tape is flat or not. See [P02](#p02-ack-gated-rebase).)

The Lens's tapes take the *other* dormancy path, and take it constantly. They live in a `TugListView` scroll container; `TugSparkline`'s observer uses the default root and `threshold: 0`; and Lens rows change height on every pulse beat, because `useMiddleTruncation` (in `tug-pulse.tsx`) runs a `ResizeObserver` on `.tug-pulse-line` — the sparkline's own parent — and rewrites the middle-truncated activity text, while the `TugPulse` headline appears and disappears with the session overview. Rows near the clip edge therefore cross the intersection boundary repeatedly, and **each crossing rebases a picture that is not flat**: teardown, full tape rebuild re-quantised onto the 250 ms bin grid, epoch restart from `translateX(0)`, all with the paint arriving late. Repeated, that is judder; caught at the wrong frame, that is the blank tape. All N Lens tapes also share one render worker, so paints queue exactly when the rail is busiest.

#### The three clocks, and where each one stops {#three-clocks}

There are three time bases in play, and the plan's whole clock story is knowing which boundary each one may not cross.

| Clock | Owns | Read by |
|---|---|---|
| `performance.now()` (monotonic, page-relative) | the tape's own axis — `SparklinePoint.t`, `committedT0`, `lastChangeAt`, `lastEventAt`, the deadband and settle timers | `SparklineTape` throughout |
| `document.timeline` (same origin as `performance.now()`) | the scroll transform's position | `Animation.startTime` / `currentTime` |
| `Date.now()` (wall clock) | the activity meters' absolute bin indices | `SessionActivityStore.record`, `RateMeter.record` / `series` |

The first two are unified by [P01](#p01-one-clock) — they already share the document's time origin, so `anim.startTime = performance.now()` is exact and the time→x map in `sparkline-geometry.ts` and the transform become the same function.

The third cannot be unified and must be **converted**. `RateMeter` stores `headBin = Math.floor(atMs / binMs)` as an absolute index, and `series(nowMs)` calls `advanceTo(Math.floor(nowMs / binMs))` — which is the *only* thing that zero-fills the bins that have gone by since the last `record`. That zero-fill is how a stalled stream decays to a flat line, and the settle burst exists precisely to draw that decay. Pass `performance.now()` (≈1e5) where a `Date.now()`-derived head bin (≈1e12) is expected and `advanceTo` takes its `bin <= this.headBin` early return every time: the window stops advancing, the trailing sum stops falling, and the tape holds its last level forever instead of draining. The failure is silent and looks like a data bug.

Hence exactly one conversion, named, applied to every callback that reaches the store: `getSeries(now + wallOffset)` and `getColorChannel(now + wallOffset)`, where `wallOffset = Date.now() - now()` is captured in `start()` and re-derived on the `visibilitychange` resync ([P09](#p09-wall-clock-seam)). `getColorChannel` is the easy one to miss — its `nowMs` funds both `dominant`'s series read and `dominant`'s hysteresis stamps, and no current caller reads it, so the mistake would be invisible until the day someone used it. Both directions of drift from that single line are caught by the test in [Risk R04](#r04-clock-seam-reopened).

#### Why the naive "draw the tape twice" rollover trick does not work {#rejected-periodic-canvas}

A tempting alternative to ack-gating is to make the canvas periodic with period `epochPx` — draw the staircase twice, once at `t0` and once at `t0 + EPOCH_S` — so the rollover becomes a transform snap onto identical pixels needing no repaint.

It does not work, and an implementer should not rediscover this. The two copies **overlap in the visible region**. Copy 1's ink spans canvas x from `width - retainPx` to `svgWidth`; copy 2's spans that same range shifted left by `epochPx`. At the rollover instant the viewport is at x ∈ [0, width], where both copies have ink, and they represent timelines an epoch apart. Clipping each copy to its own band does not rescue it either: for `P ∈ (0, width)` the viewport straddles the clip boundary and the two sides are discontinuous by exactly one epoch. A correct periodic canvas requires a genuine wrap-around ring buffer with per-segment wrapping in `drawSparkline`, which is a much larger change to shared geometry code for no benefit over ack-gating.

#### Rebase ordering, end to end {#rebase-ordering}

**Spec S01: The rebase protocol** {#s01-rebase-protocol}

```
# Every ordinary paint uses committedT0 — never proposedT0. [P10]
paint():
  surface.paint(points, committedT0, ack = none)

rebase(newT0):                                  # newT0 := proposedT0(now)
  if newT0 == committedT0: return
  seq := ++pendingSeq                           # ONE path. No flat fast path — see [P02].
  pending[seq] := newT0
  surface.paint(current tape, newT0, ack = seq) # worker draws, then posts { painted, id, seq }
  arm watchdog(seq, REBASE_ACK_TIMEOUT_MS)      # a lost ack must not freeze the tape [R05]

onPainted(seq):                                 # from the surface, or from the watchdog
  if seq != pendingSeq: return                  # superseded — drop
  clear watchdog
  committedT0 := pending[seq]                   # commit and move together
  surface.setEpochStart(committedT0)
  if resumeAfterRebase: surface.resume()        # hidden-pause wake, ordered after the move

cancelRebase():                                 # canvas re-claimed under us [#step-8]
  clear watchdog; pendingSeq := ++pendingSeq    # orphan the outstanding ack
```

`committedT0` and the transform advance in the same statement, which is the invariant the ordering test asserts. The watchdog reaches that statement through the same `onPainted` body rather than a parallel one, so there is exactly one place where the pairing can be got wrong. While a rebase is pending, `committedT0` is unchanged and ordinary paints keep drawing a correct picture that over-runs the epoch's end by at most one round-trip — covered by the 8 px of slack `svgWidth = width + epochPx + 8` already reserves.

The rollover **trigger** is `proposedT0(now) !== committedT0`, evaluated on the tape's own tick — not `anim.onfinish`, which never fires for a paused animation ([P10](#p10-committed-t0)).

`surface.setEpochStart(t)` is implemented by the component as `anim.startTime = t` — an exact write with no pending-start slop, no `cancel()`, and no new `Animation` object. Rollover is `setEpochStart(epochOrigin + (n + 1) * EPOCH_MS)`. Because the write resolves the start time, it also clears any hold time: a paused animation is running again the moment its origin moves, and the `resume()` after it is explicitness, not mechanism.

**Spec S02: Dormancy states** {#s02-dormancy-states}

| State | Entered by | Timers | Animation | Picture | Wake path |
|---|---|---|---|---|---|
| `live` | a data event, or mount with recent activity | settle burst + flat-off | running | arbitrary | — |
| `flat-dormant` | flat-off timer fired (`now - lastChangeAt >= DORMANT_AFTER_MS`) | none | paused | provably flat | rebase (ack-gated) + resume |
| `hidden-paused` | observer reported not-intersecting for 500 ms continuous | none (pause timer cleared) | paused | arbitrary | rebase (ack-gated) + resume |

`hidden-paused` and `flat-dormant` can be true at once; both exit the same way, because [P02](#p02-ack-gated-rebase) has one rebase path and flatness does not earn a shortcut. The existing `onActivity` short-circuit — a dormant tape ignores an event whose sampled value would not clear the plot deadband — is preserved for both.

---

### Specification {#specification}

#### Public API surface {#public-api}

`tugdeck/src/lib/sparkline-tape.ts` (new):

```ts
/** Everything the tape needs from the world it is drawn into. */
export interface SparklineSurface {
  /** Post the whole tape for `t0`. `ack` non-null ⇒ the surface must call
   *  `SparklineTape.onPainted(ack)` once those pixels exist — and must do so
   *  ASYNCHRONOUSLY (the on-main fallback draws synchronously and defers its
   *  ack through `queueMicrotask`, or `setEpochStart` would run re-entrantly
   *  inside this very call). */
  paint(points: readonly SparklinePoint[], t0: number, ack: number | null): void;
  /** Move the scroll origin. Only ever called from the tape's rebase protocol. */
  setEpochStart(timelineMs: number): void;
  /** Stop / start the scroll without destroying it. */
  pause(): void;
  resume(): void;
  /** The dominant-channel stamp + the colour repaint it forces. */
  stampChannel(channel: string | null, t0: number): void;
}

export interface SparklineTapeOptions {
  now: () => number;                  // performance.now() in production
  getSeries: (nowMs: number) => number[];
  getColorChannel?: (nowMs: number) => string | null;
  binMs: number;
  fullScale: number;
  curve: SparklineCurve;
  amplitude: number;                  // plot pixels, for the deadband
  pxPerSec: number;
  motion: boolean;
  setInterval: (fn: () => void, ms: number) => number;   // injected timers
  clearInterval: (h: number) => void;
  setTimeout: (fn: () => void, ms: number) => number;
  clearTimeout: (h: number) => void;
}

export class SparklineTape {
  constructor(surface: SparklineSurface, options: SparklineTapeOptions);
  /** Mount: capture the wall-clock offset [P09], build from history, decide
   *  born-live vs born-flat-dormant. */
  start(epochOriginMs: number): void;
  /** A data event from the caller's activity channel. */
  onActivity(): void;
  /** The surface's acknowledgement for a `paint` that carried `ack`. */
  onPainted(ack: number): void;
  /** RAW intersection from the observer. The 500 ms out-of-view hysteresis
   *  [P04] lives HERE, on the injected timers — not in the component, where
   *  no test could reach it. Re-entry cancels any pending pause. */
  setVisible(visible: boolean): void;
  /** Repaint the committed tape unchanged — used after the canvas is
   *  re-claimed at a new device pixel ratio [P07]. */
  repaint(): void;
  /** The canvas the outstanding rebase was painted on is gone. Orphan its
   *  ack and disarm the watchdog; the caller re-issues afterwards [R05]. */
  cancelRebase(): void;
  /** The `t0` every paint uses [P10]. Public because the component's
   *  theme-change path needs the same number for `refreshColors`. */
  committedT0(): number;
  /** [P06] — returns what the caller should do about the animation's position. */
  checkRegistration(animCurrentTimeMs: number):
    | { kind: "ok" }
    | { kind: "nudge"; startTimeMs: number }
    | { kind: "rebase" };
  /** Test/debug read-out. NOT the accessor production code uses for `t0` —
   *  that is `committedT0()`. */
  debugState(): { state: "live" | "flat-dormant" | "hidden-paused"; t0: number; points: number };
  stop(): void;
}
```

`tugdeck/src/lib/workers/sparkline-render-worker.ts` — protocol additions:

```ts
// request (existing `tape` message gains one optional field)
| { kind: "tape"; id: number; points: SparklinePoint[]; t0: number; now: number; ack?: number }

// response (new — the worker's only outbound message)
export type SparklineWorkerResponse = { kind: "painted"; id: number; ack: number };
```

The worker posts the response **at the end of** its draw handler, after `paint()` returns, so the `OffscreenCanvas` commit for that task is already queued. Messages without `ack` produce no response, keeping the 4 Hz sample path one-directional as documented in the worker's module header.

#### State Zone Mapping {#state-zone-mapping}

| State | Zone | Mechanism | Law |
|-------|------|-----------|-----|
| Tape points, `committedT0`, epoch origin, `wallOffset`, deadband reference | local data (imperative, outside React) | `SparklineTape` fields, owned by a `useRef`-held instance | [L06] appearance is painted, not rendered |
| Dormancy state (`live` / `flat-dormant` / `hidden-paused`) | local data | `SparklineTape` field | [L06] |
| Settle burst, flat-off timer, pause hysteresis timer, rebase-ack watchdog | local data | injected `setInterval`/`setTimeout` inside `SparklineTape`, all released by `stop()` from the effect cleanup | [L27] |
| Pending rebase sequence + proposed `t0` | local data | `SparklineTape` fields; committed only in `onPainted`, whether reached by the surface's ack or the watchdog | [L06], [P10](#p10-committed-t0), [Risk R05](#r05-lost-ack) |
| Scroll position (the motion itself) | appearance | WAAPI `translateX` on `.tug-sparkline-track` | [L13] |
| `data-activity-channel` tint stamp | appearance | DOM attribute + CSS in `tug-sparkline.css` | [L06] |
| Resolved line/area colours | appearance | `getComputedStyle` → worker `colors` message | [L06], [L16] |
| `dprEpoch` (which canvas element exists) | **structure** | `useState`, feeds the canvas `key` | [L24], [L26] |
| Canvas ↔ worker entry ownership | lifecycle | claimed in `useLayoutEffect`, released in its cleanup | [L03], [L27] |

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tugdeck/src/lib/sparkline-tape.ts` | The DOM-free tape / clock / dormancy / rebase policy ([P05](#p05-policy-extraction)) |
| `tugdeck/src/lib/__tests__/sparkline-tape.test.ts` | Unit tests over the real policy with an injected clock and a recording surface |
| `tests/app-test/at0370-sparkline-registration.test.ts` | Real-app coverage: one animation across scroll cycles, DPR tracking, no teardown |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `SparklineTape` | class | `tugdeck/src/lib/sparkline-tape.ts` | New. Owns the tape, the clock, dormancy, the visibility hysteresis, and Spec S01 |
| `SparklineSurface` | interface | `tugdeck/src/lib/sparkline-tape.ts` | New. The output port; acks must be asynchronous |
| `SparklineTapeOptions` | interface | `tugdeck/src/lib/sparkline-tape.ts` | New |
| `REGISTRATION_OK_PX`, `REGISTRATION_NUDGE_MAX_PX` | consts | `tugdeck/src/lib/sparkline-tape.ts` | New. 1 px / 2 px — the nudge band ([P06](#p06-registration-self-check)) |
| `REBASE_ACK_TIMEOUT_MS` | const | `tugdeck/src/lib/sparkline-tape.ts` | New. The lost-ack watchdog ([Risk R05](#r05-lost-ack)) |
| `HIDDEN_PAUSE_DELAY_MS` | const | `tugdeck/src/lib/sparkline-tape.ts` | New. 500 ms out-of-view hysteresis ([P04](#p04-observer-hysteresis)) |
| `SparklineWorkerResponse` | type | `tugdeck/src/lib/workers/sparkline-render-worker.ts` | New outbound message type |
| `SparklineWorkerRequest` | type | `tugdeck/src/lib/workers/sparkline-render-worker.ts` | `tape` variant gains `ack?: number` |
| `Painter` | interface | `tugdeck/src/components/tugways/tug-sparkline.tsx` | `draw` gains an `ack` argument; gains `onAck` registration |
| `makePainter` | fn | `tugdeck/src/components/tugways/tug-sparkline.tsx` | `try`/`catch` around `transferControlToOffscreen` ([P08](#p08-transfer-guard)); drops the dead `tapeSnapshot` local |
| `sparklineWorker` | fn | `tugdeck/src/components/tugways/tug-sparkline.tsx` | Installs the shared `onmessage` ack router |
| `nearestScrollableAncestor` | fn | `tugdeck/src/components/tugways/tug-sparkline.tsx` | New; the observer's `root` ([P04](#p04-observer-hysteresis)) |
| `startEpoch`, `enterDormant`, `wakeLive` | fns | `tugdeck/src/components/tugways/tug-sparkline.tsx` | Removed; replaced by `SparklineTape` methods + Spec S01 |
| `SparklinePoint.t` | field doc | `tugdeck/src/lib/sparkline-geometry.ts` | Doc change only: monotonic-clock ms |
| `recordActivity` | method | `tugdeck/src/test-surface.ts` | New on `TugTestSurface`; bump `SURFACE_VERSION` |

---

### Documentation Plan {#documentation-plan}

- [ ] Rewrite the `tug-sparkline.tsx` module header: it currently describes `Date.now()`, the cancel/restart epoch, and a single dormancy. Replace with the one-clock rule ([P01](#p01-one-clock)), Spec S01 — including why there is exactly one rebase path and no flatness shortcut — and Spec S02.
- [ ] Update the `sparkline-render-worker.ts` header, which states "Nothing is ever posted back — the hot path is one-directional by design". Amend to: the hot path is one-directional; rebase paints alone carry an ack.
- [ ] Note the monotonic-clock contract on `SparklinePoint.t` in `sparkline-geometry.ts`.
- [ ] Add `@covers` lines to `at0370-sparkline-registration.test.ts` for `tug-sparkline.tsx`, `sparkline-tape.ts`, `sparkline-render-worker.ts`, `sparkline-geometry.ts`, `cards-session-cell.tsx`, and `session-pulse-strip.tsx`, and verify with `just app-test-covers-check`.

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit (`bun test` in `tugdeck`)** | Drive the real `SparklineTape` with an injected clock and injected timers, recording every `SparklineSurface` call | Clock derivation, rebase ordering, watchdog convergence, dormancy transitions, self-check verdicts |
| **Golden geometry** | Feed a fixed tape to the real `drawSparkline` against a recording 2D context and compare the emitted path | Guard that the extraction did not move the staircase |
| **App-test (`just app-test`)** | Drive the real Tug.app: real Lens, real store, real WAAPI | One animation across scroll cycles, no `cancel`, DPR tracking, canvas sizing |
| **Drift prevention** | `grep`-style assertions inside unit tests | No `Date.now()` in the tape path |

#### What stays out of tests {#test-non-goals}

- **No jsdom render tests, no mock stores.** The unit tests drive real production classes; the injected clock is a production seam introduced by [P01](#p01-one-clock), and the recording surface is the component's real output port under [P05](#p05-policy-extraction), not a stand-in for the subject.
- **No assertion that depends on animation frames advancing.** App-tests run in background windows with no rAF and, when covered, report `visibilityState: "hidden"`. `at0370` therefore reads `Animation` object identity, count, `playState`, and `startTime` — all correct synchronously — and never reads a `currentTime` delta or a mid-flight computed transform.
- **No pixel/screenshot comparison of the tape.** The tape is live data; a screenshot would be flaky by construction. Correctness of the *picture* is covered by the golden-geometry test over `drawSparkline`.
- **No coverage of the reduced-motion path in the app-test.** It has no animation, so the invariants under test do not apply; it is covered by a unit case with `motion: false`.

---

### Execution Steps {#execution-steps}

> **Commit after all checkpoints pass.** This rule applies to every step below.

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Extract the tape policy, behaviour-preserving | done | `d872aed4b` |
| #step-2 | One clock: `performance.now()` and an explicit epoch origin | done | `2504adad4` |
| #step-3 | Worker paint acknowledgements | done | `b0954ec94` |
| #step-4 | Ack-gated rebase, one path, with a lost-ack watchdog | done | `d3407cdd2` |
| #step-5 | Split flat-dormancy from hidden-pause | done | `acc24c28a` |
| #step-6 | Harden the visibility gate | done | `ddb779bf5` |
| #step-7 | Self-healing registration | done | `9d7e1bc8b` |
| #step-8 | Backing-store correctness and transfer guard | done | `bdc7bded1` |
| #step-9 | `recordActivity` test hook and the real-app test | done | `2806a56ab` |
| #step-10 | Integration checkpoint | done (mechanical); by-eye observations open | — |

---

#### Step 1: Extract the tape policy, behaviour-preserving {#step-1}

**Commit:** `tugdeck(sparkline): lift the tape policy out of the component`

**References:** [P05](#p05-policy-extraction) Policy extraction, [Risk R01](#r01-extraction-hides-change), Spec S02 (#s02-dormancy-states), (#the-two-defects)

**Artifacts:**
- New `tugdeck/src/lib/sparkline-tape.ts` with `SparklineTape`, `SparklineSurface`, `SparklineTapeOptions` as specified in [#public-api](#public-api).
- New `tugdeck/src/lib/__tests__/sparkline-tape.test.ts`.
- `tug-sparkline.tsx`'s second `useLayoutEffect` reduced to construction, wiring, and cleanup.

**Tasks:**
- [ ] Move, unchanged, into `SparklineTape`: `VISIBLE_SECONDS`, `SAMPLE_MS`, `PRUNE_MARGIN_S`, `EPOCH_S`, `DORMANT_AFTER_MS`, `RATE_WINDOW_MS`, `DEADBAND_PX`, `SETTLE_TICKS`, and the closures `sampleRate`, `appendPoint`, `rebuildTape`, `startSettle`/`stopSettle`, `scheduleFlatOff`/`stopFlatOff`, `enterDormant`, `wakeLive`, `flatPastWindow`, `onActivity`, plus the mount decision (born-inert vs `wakeLive`).
- [ ] Route every DOM touch through `SparklineSurface`: `redraw()` → `surface.paint(points, t0, null)`; `startEpoch`'s animation work → `surface.setEpochStart` / `pause` / `resume`; the `data-activity-channel` stamp and its `repaintColors()` → `surface.stampChannel`.
- [ ] Inject `now`, `setInterval`, `clearInterval`, `setTimeout`, `clearTimeout` through `SparklineTapeOptions`. **Keep `now: () => Date.now()` in the component for this step** — the clock change is Step 2, and mixing the two would make a regression unattributable.
- [ ] In `TugSparkline`, hold the instance in a `useRef`, construct it in the existing tape `useLayoutEffect`, and call `stop()` from the cleanup ([L27]).
- [ ] Implement the component-side `SparklineSurface` against the existing `Painter` and the existing cancel/restart animation behaviour — no semantic change yet. `repaint()`, `cancelRebase()` and `committedT0()` land in this step as trivial pass-throughs so later steps do not have to widen the port.
- [ ] **Every surface method resolves the painter as `painterRef.current` at call time**, matching today's `painterRef.current?.draw(...)`. The surface is built in the tape effect; the painter is owned by the claim effect and replaced under it ([#step-8](#step-8)). Capturing it would type-check and pass the unit suite.
- [ ] Move the visibility hysteresis into `SparklineTape.setVisible` from the start (it is `HIDDEN_PAUSE_DELAY_MS = 0` until [#step-6](#step-6) turns it on), so the component only ever reports raw intersection and no test has to reach into the DOM for it. **At 0 the pause must stay synchronous** — take the timer path only for a positive delay, or this "behaviour-preserving" step quietly turns today's in-callback `enterDormant` into a deferred one.
- [ ] Delete the dead `tapeSnapshot` local in `makePainter`'s worker branch (assigned, never read).

**Tests:**
- [ ] `sparkline-tape.test.ts`: a tape that receives no activity is born flat-dormant — the surface trace holds exactly one `paint` and no timers were scheduled.
- [ ] A tape built from a series with recent activity is born live: `paint` at mount, a settle burst at 250 ms intervals, and the burst stops after `SETTLE_TICKS` unchanged ticks **and** `RATE_WINDOW_MS + binMs` past the last event — assert it does *not* stop on stability alone while the window is still draining.
- [ ] The deadband reference advances only on recognised change: feed a ramp of sub-deadband steps and assert the accumulated drift eventually registers a change.
- [ ] The flat-off timeout fires exactly `DORMANT_AFTER_MS` after the last recognised change and reschedules when a later change lands during the wait.
- [ ] `motion: false` never calls `setEpochStart`, `pause`, or `resume`, and re-seeds its synthetic origin to the newest sample on every append.
- [ ] **Rate decay (the behaviour [P09](#p09-wall-clock-seam) protects, tested before the clock moves):** drive a burst, then advance the clock past `RATE_WINDOW_MS + binMs` with no further records, and assert the plotted value reaches baseline. This case must stay green through [#step-2](#step-2) — it is what catches a broken seam.
- [ ] Golden geometry: feed a fixed 5-point tape to the real `drawSparkline` with a recording 2D context and snapshot the emitted `moveTo`/`lineTo` sequence, including the held tail to `svgWidth` and the area's two baseline closers.

**Checkpoint:**
- [ ] `cd tugdeck && bun test`
- [ ] `cd tugdeck && bun run check`
- [ ] `cd tugdeck && bunx vite build`
- [ ] `just app-test at0282-pulse-two-level.test.ts`

---

#### Step 2: One clock — `performance.now()` and an explicit epoch origin {#step-2}

**Depends on:** #step-1

**Commit:** `tugdeck(sparkline): put the tape and its scroll on one monotonic clock`

**References:** [P01](#p01-one-clock) One clock, [P09](#p09-wall-clock-seam) Wall-clock seam, [P10](#p10-committed-t0) Committed `t0`, [Q01](#q01-timeline-stall), [Risk R04](#r04-clock-seam-reopened), (#three-clocks, #the-two-defects), Spec S01 (#s01-rebase-protocol)

**Artifacts:**
- `SparklineTape` holds `committedT0` and computes `proposedT0(now)`; nothing assigns `t0` ad hoc.
- The single wall-clock conversion at the `getSeries` seam.
- `tug-sparkline.tsx` sets `Animation.startTime` explicitly and never relies on a pending start.

**Tasks:**
- [ ] Change the component's injected clock to `performance.now()`.
- [ ] **Install the wall-clock seam before anything else in this step.** In `start()`, capture `wallOffset = Date.now() - options.now()`. Every call into a store-facing callback becomes `getSeries(now + wallOffset)` **and `getColorChannel(now + wallOffset)`** — both take the same `nowMs` contract, and `getColorChannel`'s argument reaches `dominant`, which spends it on a wall-clock series read *and* on hysteresis stamps compared against `record()`-side state. No current caller reads that argument, which is exactly why it has to be got right now rather than noticed later ([P09](#p09-wall-clock-seam)). Comment it with the reason from [#three-clocks](#three-clocks) — that `RateMeter.series` advances an absolute wall-clock bin index, and that this is the only thing that decays a stalled stream to baseline. This must be the **only** `Date.now(` left in either file.
- [ ] Give `SparklineTape.start(epochOriginMs)` the animation's origin and store it. Add `proposedT0(now) = epochOrigin + Math.floor((now - epochOrigin) / EPOCH_MS) * EPOCH_MS` and a `committedT0` field initialised to `proposedT0(start)`. Replace every former `t0 = <assignment>` site with a read of `committedT0`.
- [ ] Route every paint through a single private `paint()` that uses `committedT0` — mount, settle append, colour repaint, `repaint()`. No other call site may pass a `t0`.
- [ ] In the component, create the animation **once** per mount: `anim = track.animate([...], { duration: EPOCH_S * 1000, easing: "linear", fill: "forwards" })`, then immediately `anim.startTime = origin` where `origin` is the same `performance.now()` value handed to `start()`. Log via `tugDevLogStore.debug` if `anim.pending` is still true after the write.
- [ ] Replace `startEpoch`'s `cancel()` + `animate()` with `surface.setEpochStart(t)` → `anim.startTime = t`.
- [ ] Make the rollover trigger `proposedT0(now) !== committedT0`, evaluated on the tape's tick — **not** `anim.onfinish`, which never fires once [#step-5](#step-5) makes pause real. If `onfinish` is kept at all it is a redundant nudge into the same path. For this step the trigger may still commit immediately; [#step-4](#step-4) puts it behind the ack.
- [ ] Remove the `anim.onfinish = null; anim.cancel();` orphan-guard blocks — with a single long-lived animation there is nothing to orphan. Cleanup still cancels once, on unmount.
- [ ] Document the monotonic-clock contract on `SparklinePoint.t` in `sparkline-geometry.ts`.

**Tests:**
- [ ] **The Step 1 rate-decay case must still pass.** It is the direct falsifier for a broken seam; if it goes red here, the conversion is wrong, not the test.
- [ ] For a swept range of `now` values, `proposedT0(now)` equals `epochOrigin + n * EPOCH_MS` exactly and the implied transform `-(now - committedT0) / 1000 * pxPerSec` stays within `[-epochPx - 8/pxPerSec*1000, 0]`.
- [ ] Drift prevention: read `tug-sparkline.tsx` and `sparkline-tape.ts` off disk and assert `Date.now(` occurs **exactly once** across the pair, in `sparkline-tape.ts` ([Risk R04](#r04-clock-seam-reopened)).
- [ ] Every paint in a full live-tape scenario carries the same `t0` until a `setEpochStart` moves it — the [P10](#p10-committed-t0) invariant, in its simplest form before the ack lands.
- [ ] A tape driven across an epoch boundary reports `committedT0` advancing by exactly `EPOCH_MS`, with no intermediate value.
- [ ] Both store-facing callbacks receive the same converted clock: a recording `getSeries`/`getColorChannel` pair sees identical `nowMs` values, offset from the injected clock by exactly `wallOffset`.

**Checkpoint:**
- [ ] `cd tugdeck && bun test`
- [ ] `cd tugdeck && bun run check`
- [ ] `cd tugdeck && bunx vite build`
- [ ] Open the app, stream a turn, and confirm the tape still **falls to baseline** when output stops — the seam's observable behaviour.
- [ ] Watch a live Session card tape for one full 120 s epoch; the rollover shows no jump.
- [ ] `just app-test at0282-pulse-two-level.test.ts`

---

#### Step 3: Worker paint acknowledgements {#step-3}

**Depends on:** #step-2

**Commit:** `tugdeck(sparkline): let the render worker acknowledge a rebase paint`

**References:** [P02](#p02-ack-gated-rebase) Ack-gated rebase, Spec S01 (#s01-rebase-protocol), (#public-api)

**Artifacts:**
- `SparklineWorkerRequest`'s `tape` variant gains `ack?: number`; new `SparklineWorkerResponse`.
- The shared worker in `tug-sparkline.tsx` grows one `onmessage` router keyed by sparkline `id`.
- `Painter.draw` gains an `ack` parameter; `Painter` gains ack registration.

**Tasks:**
- [ ] In `sparkline-render-worker.ts`, add `ack?: number` to the `tape` message and post `{ kind: "painted", id, ack }` from the end of the `case "tape"` handler when `ack` is present. Nothing else changes; the header's one-directional claim gets amended.
- [ ] In `tug-sparkline.tsx`, keep the shared `Worker` singleton but attach a module-level `onmessage` that dispatches to a `Map<number, (ack: number) => void>` of registered sparkline ids. Register in `makePainter`, unregister in `release()` ([L27]).
- [ ] Extend `Painter.draw(tape, t0, now, ack)` on both branches. The on-main fallback draws synchronously and then **defers** its ack through `queueMicrotask` — never a synchronous callback, which would run `setEpochStart` re-entrantly inside the tape's own `paint()`. Comment the reason at the call site; it is the kind of thing a future reader would "simplify" back into a bug.
- [ ] Wire `SparklineSurface.paint`'s `ack` argument through to the painter, and `SparklineTape.onPainted(ack)` to the registered callback.
- [ ] The tape does not yet *use* acks for anything — this step lands the plumbing only, so a regression here is attributable.

**Tests:**
- [ ] A recording surface that acks immediately, and one that acks after N intervening paints, both leave the tape in the same state (the tape must be indifferent to ack latency until Step 4 gives acks meaning).
- [ ] A `paint` with `ack: null` never produces an `onPainted` call.
- [ ] Re-entrancy: a surface that acks from inside `paint()` is a **programming error**, and the tape asserts against it — `onPainted` called while a `paint` is on the stack throws in dev. This pins the `queueMicrotask` contract rather than trusting it.

**Checkpoint:**
- [ ] `cd tugdeck && bun test`
- [ ] `cd tugdeck && bun run check`
- [ ] `cd tugdeck && bunx vite build`
- [ ] `just app-test at0282-pulse-two-level.test.ts`

---

#### Step 4: Ack-gated rebase, one path, with a lost-ack watchdog {#step-4}

**Depends on:** #step-3

**Commit:** `tugdeck(sparkline): never move the scroll ahead of the pixels`

**References:** [P02](#p02-ack-gated-rebase) Ack-gated rebase, [P10](#p10-committed-t0) Committed `t0`, Spec S01 (#s01-rebase-protocol), [Risk R02](#r02-ack-not-frame-exact), [Risk R05](#r05-lost-ack), (#rejected-periodic-canvas)

**Artifacts:**
- `SparklineTape`'s rebase protocol per Spec S01, replacing every direct `setEpochStart` call site.
- `REBASE_ACK_TIMEOUT_MS` and the watchdog that reaches `onPainted` when the surface does not.
- `committedT0` advancing only inside `onPainted`.

**Tasks:**
- [ ] Implement Spec S01 in `SparklineTape` as the single `rebase(newT0)` entry point. Maintain `pendingSeq` and a `pending` map; an ack for a superseded sequence is dropped. **`committedT0` and `setEpochStart` move in the same statement** — that pairing is the invariant, so write them adjacent and comment them as one operation.
- [ ] **No flat fast path.** If a future reader proposes one, the answer is in [P02](#p02-ack-gated-rebase): `drawSparkline` clears the canvas and starts its path at `xOf(tape[0].t)`, so a rollover moves the viewport onto cleared pixels whether or not the tape is flat — and a flat tape stalled for a round-trip is pixel-identical to one that is not, so the shortcut has no upside to trade against. Record that in the code comment above `rebase`, not just here.
- [ ] Add `REBASE_ACK_TIMEOUT_MS` and arm it on every `rebase`, on the injected timers. On expiry, enter `onPainted` for that sequence — the same body, not a parallel one — so the commit-and-move pairing has exactly one implementation. Add `cancelRebase()` for [#step-8](#step-8)'s re-claim.
- [ ] Route the epoch rollover through `rebase`, triggered by `proposedT0(now) !== committedT0` on the tape's tick. While the ack is outstanding the animation sits at its `fill: forwards` end position, which is the *correct* picture — it just stops moving for a round-trip. Comment that this stall is deliberate and bounded, and why it cannot be pre-empted ([P02](#p02-ack-gated-rebase) implications).
- [ ] Apply `setEpochStart` **directly** from the ack handler. Do not add a `requestAnimationFrame` boundary unless [#step-10](#step-10) measures a seam; if it does, add it with an explicit [L13] note explaining why a one-shot defer in a motion path is not the frame loop that law forbids.
- [ ] Delete the old `startEpoch` entirely.

**Tests:**
- [ ] **Ordering invariant (the headline test):** across every scenario the suite drives — mount, rollover, activity burst, dormancy, wake — scan the recorded surface trace and assert that every `setEpochStart(t)` is immediately preceded by a `paint(..., t, ack)` whose ack has been delivered (by the surface or by the watchdog). No other ordering may appear, and in particular no `setEpochStart` may follow a `paint` carrying `ack: null`.
- [ ] **Single-`t0` invariant ([P10](#p10-committed-t0)):** between any two `setEpochStart` calls in a trace, the set of distinct `t0` values across all paints has exactly one member — except for the single rebase paint that proposes the next. Drive this specifically with settle-burst appends landing *while a rebase ack is outstanding*, which is the case a derived-`t0` design would fail.
- [ ] A rollover emits `paint(ack)` and no `setEpochStart` until `onPainted` is called — for a flat tape exactly as for a busy one, since flatness earns no shortcut.
- [ ] A superseded rebase: two `rebase` calls back to back, then acks delivered out of order — only the newest `t0` is ever applied.
- [ ] **A surface that never acks still converges:** drive a rollover, advance the injected timers past `REBASE_ACK_TIMEOUT_MS`, and assert `committedT0` advanced and `setEpochStart` fired exactly once. Run the same case for a `hidden-paused` wake and assert `resume` fired too — a tape stuck paused is the failure this constant exists to prevent.
- [ ] A late ack arriving *after* the watchdog already committed that sequence is a no-op — no second `setEpochStart`.
- [ ] `cancelRebase()` orphans the outstanding ack: a subsequent `onPainted` for that sequence does nothing, and the watchdog does not fire.
- [ ] The 4 Hz settle-burst paints never carry an ack.
- [ ] A tape paused across an epoch boundary still rolls over on resume — proving the trigger is the clock comparison and not `anim.onfinish`.

**Checkpoint:**
- [ ] `cd tugdeck && bun test`
- [ ] `cd tugdeck && bun run check`
- [ ] `cd tugdeck && bunx vite build`
- [ ] `just app-test at0282-pulse-two-level.test.ts`

---

#### Step 5: Split flat-dormancy from hidden-pause {#step-5}

**Depends on:** #step-4

**Commit:** `tugdeck(sparkline): an off-screen tape pauses instead of tearing down`

**References:** [P03](#p03-pause-not-teardown) Pause not teardown, Spec S02 (#s02-dormancy-states), (#the-two-defects)

**Artifacts:**
- `SparklineTape`'s single `dormant` boolean becomes the three-state machine of Spec S02.
- `SparklineSurface.pause()` / `resume()` replace the cancel/recreate pair.

**Tasks:**
- [ ] Replace `dormant: boolean` with `state: "live" | "flat-dormant" | "hidden-paused"`, and `inView: boolean` alongside it (the two are orthogonal; Spec S02's table is the authority).
- [ ] `enterFlatDormancy`: stop both timers and `surface.pause()`. **Do not rebase on the way in.** `rebase` no-ops unless the epoch actually rolled ([P10](#p10-committed-t0)), and if it did roll the rebase is ack-gated like any other — so there is nothing for dormancy entry to do that the wake path does not already do, and doing it here would only add a rebase to the moment the tape stops mattering.
- [ ] `enterHiddenPause`: stop both timers, `surface.pause()`, and **change nothing else** — no `t0` move, no repaint, no rebuild.
- [ ] Wake from `hidden-paused`: `rebuildTape(now)`, then `rebase(proposedT0(now))`. **`resume()` is not called inline** — the rebase is ack-gated, so set a `resumeAfterRebase` flag and have `onPainted` call `surface.resume()` immediately after `setEpochStart` (see Spec S01's `onPainted`). Only then arm the finishers. Resuming before the origin moves would run the scroll from a stale origin, which is the same defect wearing a different hat. Note that this is also why [Risk R05](#r05-lost-ack)'s watchdog is load-bearing rather than paranoid: on this path a lost ack leaves the tape paused, not merely misregistered.
- [ ] Note in the code that `setEpochStart` clears the animation's hold time and therefore un-pauses on its own; the `resume()` after it makes the state change legible in the trace but is not what restarts the scroll.
- [ ] Implement `pause()`/`resume()` in the component as `anim.pause()` / `anim.play()`. Remove `anim.cancel()` from every path except unmount cleanup.
- [ ] Preserve the existing below-deadband short-circuit in `onActivity` for both dormant states.
- [ ] Note in the code that a tape may now sit `hidden-paused` for longer than one epoch; the rollover trigger is the clock comparison, so resume rolls over correctly however long the pause was ([P10](#p10-committed-t0)).

**Tests:**
- [ ] A hidden→visible cycle produces `pause`, then on wake a `paint(ack)`, then `setEpochStart`, then `resume` — in that order — and never `cancelAnimation` or `createAnimation`. Assert `resume` comes strictly after `setEpochStart`.
- [ ] A hidden→visible cycle spanning more than `EPOCH_MS` resumes with `committedT0` advanced by the right multiple of `EPOCH_MS`, and with exactly one `setEpochStart`.
- [ ] A hidden→visible cycle on a flat tape takes the same ack-gated path and still never tears down.
- [ ] `enterFlatDormancy` emits no `paint` and no `setEpochStart` — dormancy entry is a stop, not a rebase.
- [ ] `enterHiddenPause` emits no `paint` and no `setEpochStart`.
- [ ] A tape that goes hidden while live and is still hidden when its flat-off deadline passes converges to `flat-dormant` without a second `pause`.
- [ ] Activity arriving while hidden updates `lastChangeAt` and does not wake — matching today's behaviour — and re-entry then rebuilds and rebases through the ack path.

**Checkpoint:**
- [ ] `cd tugdeck && bun test`
- [ ] `cd tugdeck && bun run check`
- [ ] `cd tugdeck && bunx vite build`
- [ ] `just app-test at0282-pulse-two-level.test.ts`
- [ ] In the running app: open the Lens with several sessions, scroll the Cards section so a session row leaves and re-enters the list, and confirm the tape resumes without a jump.

---

#### Step 6: Harden the visibility gate {#step-6}

**Depends on:** #step-5

**Commit:** `tugdeck(sparkline): observe the scroll container, and don't pause on a flap`

**References:** [P04](#p04-observer-hysteresis) Observer hysteresis, Spec S02 (#s02-dormancy-states), (#the-two-defects)

**Artifacts:**
- `nearestScrollableAncestor` in `tug-sparkline.tsx`.
- The `IntersectionObserver` gains a root and a `rootMargin`; `HIDDEN_PAUSE_DELAY_MS` goes from 0 to 500 inside `SparklineTape`.

**Tasks:**
- [ ] Add `nearestScrollableAncestor(el: Element): Element | null` — walk `parentElement`, return the first whose computed `overflow-y` is `auto`, `scroll`, or `overlay`; `null` (the viewport) if none.
- [ ] Construct the observer with `{ root: nearestScrollableAncestor(container), rootMargin: "160px 0px", threshold: 0 }`. Comment that `rootMargin` expands the *root's* rect, which is why the root has to be the scroller for the margin to buy anything — with the default viewport root it would do nothing for a row clipped by an intermediate scroller.
- [ ] Set `HIDDEN_PAUSE_DELAY_MS = 500`. The hysteresis is already inside `SparklineTape.setVisible` from [#step-1](#step-1): `false` arms a timer, `true` cancels it and resumes immediately. The component still just forwards raw intersection — no debounce in the DOM layer.
- [ ] Add a `tugDevLogStore.debug` line on each state transition, tagged `sparkline`, so the dev panel (Opt-Cmd-/) can show churn directly. Never `console.warn`.
- [ ] **Verify that a Lens row reorder preserves mount identity.** The Cards section re-sorts session rows by activity, so during streaming the rows most likely to move are the ones with live tapes — a second churn source alongside the row-height changes ([Risk R03](#r03-other-causes)). Capture `getAnimations()[0]` on a row's track, drive activity until the row reorders, and confirm it is the same `Animation` object afterwards. If it is not, the row is remounting and this step does not cure the Lens; record that finding and stop rather than tuning the observer further.

**Tests:**
- [ ] `setVisible(false)` then `setVisible(true)` inside the hysteresis window produces **zero** `pause` calls in the trace — driven through the tape's injected timers, which is possible precisely because the hysteresis lives in the policy module.
- [ ] Beyond the window, exactly one `pause`.
- [ ] A flap storm (twenty alternations inside one window) still produces zero `pause` calls and leaves exactly one armed timer.

**Checkpoint:**
- [ ] `cd tugdeck && bun test`
- [ ] `cd tugdeck && bun run check`
- [ ] `cd tugdeck && bunx vite build`
- [ ] In the running app with the dev panel open: scroll the Lens Cards section briskly and confirm the `sparkline` transition log stays quiet.

---

#### Step 7: Self-healing registration {#step-7}

**Depends on:** #step-6

**Commit:** `tugdeck(sparkline): verify the tape's registration instead of assuming it`

**References:** [P06](#p06-registration-self-check) Registration self-check, [Q01](#q01-timeline-stall), [P02](#p02-ack-gated-rebase)

**Artifacts:**
- `SparklineTape.checkRegistration(animCurrentTimeMs)`.
- A `visibilitychange` listener in `tug-sparkline.tsx`.

**Tasks:**
- [ ] Add `REGISTRATION_OK_PX = 1` and `REGISTRATION_NUDGE_MAX_PX = 2` as named constants with the rationale from [P06](#p06-registration-self-check) — a nudge is an *unrepainted* transform move, so the band is capped at what the eye cannot resolve on a 22 px tape.
- [ ] Implement `checkRegistration`: compute the expected animation position `expected = now - committedT0`, compare against the supplied `animCurrentTimeMs`, convert the difference to CSS px via `pxPerSec`. `|Δpx| < REGISTRATION_OK_PX` → `{ kind: "ok" }`; `< REGISTRATION_NUDGE_MAX_PX` → `{ kind: "nudge", startTimeMs }`; **anything at or above that, in either direction** → `{ kind: "rebase" }`. A paused or missing animation is also `rebase`.
- [ ] Call it from the settle burst's tick — only while `state === "live"`, so an idle tape still runs zero work, **and only while `document.visibilityState === "visible"`**. `document.timeline.currentTime` is the current frame time and stops advancing when rendering is suspended, so an ungated check would read an unbounded divergence and escalate to `rebase` every 250 ms for the whole occlusion — each one writing a `startTime` ahead of the stalled timeline, which drops the animation into its before-phase where `fill: "forwards"` does not apply and the element snaps to `translateX(0)`. Comment the gate with that mechanism ([P06](#p06-registration-self-check), [Q01](#q01-timeline-stall)); it reads as defensive until you know what it prevents.
- [ ] In the component, apply `nudge` as a direct `anim.startTime` write and `rebase` through Spec S01.
- [ ] Add a `document` `visibilitychange` listener that, on `visible`, re-derives `wallOffset` ([P09](#p09-wall-clock-seam)), runs one `checkRegistration`, and records the observed divergence to `tugDevLogStore` — this is what writes down the answer to [Q01](#q01-timeline-stall). Remove the listener in cleanup ([L27]).

**Tests:**
- [ ] Band boundaries, both signs: `±0.4 px` → `ok`; `±1.5 px` → `nudge` with the corrected `startTimeMs`; `±2 px` → `rebase`; `±400 px` → `rebase`. The `2 px` case is the one that matters — it proves the band is capped rather than open-ended.
- [ ] A paused animation always returns `rebase`, never `nudge`.
- [ ] A `nudge` verdict never appears in the surface trace as a `setEpochStart` — a nudge is not a rebase and must not touch `committedT0`, so the [#step-4](#step-4) ordering invariant and the [P10](#p10-committed-t0) single-`t0` invariant both still hold with the self-check active.
- [ ] `checkRegistration` is never called while `flat-dormant` or `hidden-paused` (assert via the injected timers: no settle burst is running).
- [ ] A stalled animation clock — `animCurrentTimeMs` held fixed while the injected clock advances — produces a divergence that would escalate, and the component's gate means at most one `rebase` results (assert on the surface trace with visibility driven hidden, then visible).

**Checkpoint:**
- [ ] `cd tugdeck && bun test`
- [ ] `cd tugdeck && bun run check`
- [ ] `cd tugdeck && bunx vite build`
- [ ] `just app-test at0282-pulse-two-level.test.ts`

---

#### Step 8: Backing-store correctness and transfer guard {#step-8}

**Depends on:** #step-7

**Commit:** `tugdeck(sparkline): track the live device pixel ratio, and survive a spent canvas`

**References:** [P07](#p07-dpr-reactivity) DPR reactivity, [P08](#p08-transfer-guard) Transfer guard, (#state-zone-mapping), [L26]

**Artifacts:**
- A `dprEpoch` `useState` in `TugSparkline` feeding the canvas `key` and the geometry.
- A forced `repaint()` after every canvas re-claim.
- `try`/`catch` around `transferControlToOffscreen`.

**Tasks:**
- [ ] Add a `useLayoutEffect` that installs `matchMedia('(resolution: ' + dpr + 'dppx)')` and, on `change`, calls `setDprEpoch(n => n + 1)`, re-installing against the new ratio. This is structure-zone state ([L24]) — it changes which canvas element exists — so `useState` is correct and [L06] is not violated.
- [ ] Read `devicePixelRatio` during render (not inside the effect) so the geometry and the `key` agree, and make it a dependency of the canvas-claim effect.
- [ ] Change the canvas `key` to `` `${svgWidth}x${height}@${dpr}` `` so a ratio change replaces the element rather than re-transferring a spent one ([L26]). Record the three-input audit from [P07](#p07-dpr-reactivity) in the comment: the key is on the `<canvas>` alone, so `.tug-sparkline` and `.tug-sparkline-track` keep their identity and the tape, the animation, and the observer all survive.
- [ ] **Force a repaint after re-claiming.** At the end of the canvas-claim effect, call `tapeRef.current?.cancelRebase()` and then `repaint()`. The repaint is load-bearing, not defensive: the new worker entry starts with an empty tape and the *tape* effect does not re-run, so a `flat-dormant` or `hidden-paused` sparkline — most of the Lens, most of the time — would stay blank until its next activity, possibly forever. The cancel is load-bearing for the same reason in a different direction: releasing the old painter unregisters its ack route, so any rebase in flight would otherwise be acked by nobody, and on a hidden-wake that leaves the animation paused forever ([Risk R05](#r05-lost-ack)). The tape re-proposes the rebase on its next tick.
- [ ] Wrap `canvas.transferControlToOffscreen()` in `try`/`catch`; on failure log via `tugDevLogStore.error` under the `sparkline` tag and fall through to the 2D-context painter.
- [ ] Re-read the module header of `tug-sparkline.tsx` and rewrite the paragraphs describing `Date.now()`, the cancel/restart epoch, and single dormancy — they are now wrong. Fold in [P01](#p01-one-clock), Spec S01, and Spec S02.
- [ ] Amend the `sparkline-render-worker.ts` header's "Nothing is ever posted back" claim.

**Tests:**
- [ ] `repaint()` on a `flat-dormant` tape emits exactly one `paint` carrying `committedT0` and no `setEpochStart` — the only part of this step a DOM-free test can reach, and the part most likely to be dropped.
- [ ] `cancelRebase()` followed by `repaint()` mid-rebase leaves the tape able to roll over again on its next tick, with no lingering watchdog and no `setEpochStart` from the orphaned sequence.
- [ ] The rest is covered at the app-test layer in [#step-9](#step-9): DPR and canvas transfer are not observable without a real canvas, and a jsdom stand-in is banned.

**Checkpoint:**
- [ ] `cd tugdeck && bun test`
- [ ] `cd tugdeck && bun run check`
- [ ] `cd tugdeck && bunx vite build`
- [ ] In the running app: with an idle Lens (no streaming), drag the window to a display at a different scale factor and confirm every tape is still drawn, not blank.

---

#### Step 9: `recordActivity` test hook and the real-app test {#step-9}

**Depends on:** #step-8

**Commit:** `tugdeck(sparkline): cover tape registration in the real app`

**References:** [P01](#p01-one-clock), [P03](#p03-pause-not-teardown), [P04](#p04-observer-hysteresis), [P07](#p07-dpr-reactivity), (#test-non-goals), (#success-criteria)

**Artifacts:**
- `TugTestSurface.recordActivity(session, channel, units)` in `tugdeck/src/test-surface.ts`, with `SURFACE_VERSION` bumped.
- New `tests/app-test/at0370-sparkline-registration.test.ts`.

**Tasks:**
- [ ] Add `recordActivity(session: string, channel: ActivityChannel, units: number): void` to `TugTestSurface`, implemented by calling the real `getSessionActivityStore()?.record(session, channel, units, Date.now())`. **`Date.now()`, not `performance.now()`** — the meters are wall-clock-binned ([P09](#p09-wall-clock-seam)) and this must stamp the same clock the live frame handler in `SessionActivityStore` stamps, or the recorded units land in a bin the series never reaches. This drives the real ingestion path — no fixture, no mock.
- [ ] Bump `SURFACE_VERSION` from `2.1.0` to `2.2.0` and add the changelog paragraph the constant's doc comment convention requires. Additive, so the major stays `2` — the doc comment states removals are what force a major.
- [ ] Write `at0370-sparkline-registration.test.ts` with `@covers` for `tug-sparkline.tsx`, `sparkline-tape.ts`, `sparkline-render-worker.ts`, `sparkline-geometry.ts`, `cards-session-cell.tsx`, `session-pulse-strip.tsx`.
- [ ] **Guard on motion first.** Assert `isTugMotionEnabled()`-equivalent state (`getComputedStyle(document.documentElement).getPropertyValue('--tug-motion')` is not `0`) before any animation assertion. Under `prefers-reduced-motion` the component creates no animation at all and every assertion below inverts; the test must `note()` and skip rather than report a false red.
- [ ] Test: open the Lens, drive `recordActivity` on a bound session, and assert `document.querySelector('.sessions-monitor-spark .tug-sparkline-track').getAnimations().length === 1` with `playState === 'running'` and a non-null, non-pending `startTime`.
- [ ] Test: the tape **falls to baseline** after activity stops — drive a burst via `recordActivity`, wait past `RATE_WINDOW_MS + ACTIVITY_BIN_MS`, and assert the newest plotted value is zero. This is the wall-clock seam's observable behaviour in the real app ([P09](#p09-wall-clock-seam), [Risk R04](#r04-clock-seam-reopened)), and unlike the unit case it exercises the real store.
- [ ] Test: capture the `Animation` object, scroll the Cards section so the row leaves and re-enters three times, and assert the animation is the **same object** each time (`getAnimations()[0] === captured`) and `playState` never reaches `'idle'` — the falsifiable form of "no teardown".
- [ ] Test: for every mounted `.tug-sparkline-canvas`, assert `canvas.width === Math.ceil(parseFloat(canvas.style.width) * devicePixelRatio)`.
- [ ] Test: `note()` the delta between `document.timeline.currentTime` and `performance.now()`, which records the answer to [Q01](#q01-timeline-stall) in the run's `Diagnostics:` section.
- [ ] Nothing in the test may await an animation frame or read a mid-flight computed transform — background windows run no rAF, and transitions poison style assertions.
- [ ] Run `just app-test-covers-check`.

**Tests:**
- [ ] The four assertions above are the tests.

**Checkpoint:**
- [ ] `just app-test-covers-check`
- [ ] `just app-test at0370-sparkline-registration.test.ts`
- [ ] `cd tugdeck && bun test`
- [ ] `cd tugdeck && bun run check`
- [ ] `cd tugdeck && bunx vite build`

---

#### Step 10: Integration checkpoint {#step-10}

**Depends on:** #step-4, #step-5, #step-6, #step-7, #step-9

**Commit:** `N/A (verification only)`

**References:** (#success-criteria), (#exit-criteria), [Risk R03](#r03-other-causes)

**Tasks:**
- [x] Verify every success criterion in [#success-criteria](#success-criteria) mechanically, criterion by criterion. — see [#step-10-results](#step-10-results).
- [x] Run the selective app-test derived from the working diff, then the core tier — the changes touch `test-surface.ts`, which no `@covers` line can scope. Selection resolved against the dash's full diff (`main...HEAD`), since the working diff is empty on a committed dash: `at0370`, `at0282`, `at0293`, `at0017` — 4/4 green. Core tier 20/20 green.
- [ ] Watch a live session in the Lens and on its card side by side for at least two full epochs (240 s) with real streaming activity; confirm neither judders and neither blanks, and that **both fall to baseline together** when the turn ends.
- [ ] With the dev panel open (Opt-Cmd-/), scroll the Lens rail hard during streaming and confirm the `sparkline` transition log is quiet and no registration `rebase` verdicts fire.
- [ ] Look specifically for a rollover seam ([Risk R02](#r02-ack-not-frame-exact)). If one is visible, add the `requestAnimationFrame` boundary in `setEpochStart` **and** the [L13] exemption comment; if not, leave the direct application in place and record that the ack alone was sufficient.
- [ ] Measure idle cost with a dozen Lens rows now that every mounted tape holds a paused animation: confirm no wake-ups at rest in the dev log.
- [ ] Exercise a `hidden-paused` span longer than one epoch (collapse the Cards section for >120 s, reopen) and confirm the tape resumes correctly rather than jumping.
- [ ] If judder remains after all of the above, record it against [Risk R03](#r03-other-causes) with a WebKit layer-tree capture rather than reopening the registration work.

**Tests:**
- [x] Full unit suite plus the two app-tests, green together.

**Checkpoint:**
- [x] `cd tugdeck && bun test` — 6171 pass, 0 fail
- [x] `cd tugdeck && bun run check`
- [x] `cd tugdeck && bunx vite build`
- [x] `just app-test-changed` — resolved against `main...HEAD`; 4/4 green
- [x] `just app-test` — 20/20 files, 39/39 tests green

##### Mechanical verification, criterion by criterion {#step-10-results}

| Success criterion | How it was verified | Result |
|---|---|---|
| `Date.now(` exactly once in the tape path | drift-prevention unit test reading both files off disk; `grep` confirms one live call at `sparkline-tape.ts` `captureWallOffset`, two more in comments | PASS |
| Committed `t0` lands exactly on epoch multiples; transform bounded | `proposedT0` sweep over four epochs at 1337 ms steps | PASS |
| One `t0` per inter-rebase interval | `assertRebaseOrdering`'s single-`t0` half, over every scenario the suite drives | PASS |
| Every `setEpochStart` preceded by a delivered ack | `assertRebaseOrdering`'s ordering half, same scenarios | PASS |
| A rebase whose ack never arrives still converges | watchdog cases, live and on the `hidden-paused` wake path | PASS |
| A hidden→visible cycle produces zero teardowns | allowed-verbs trace scan (the surface has no teardown verb at all) plus the ordered pause/paint/move/resume case | PASS |
| A Lens row survives three scroll cycles with one running `Animation` | `at0370`, with the tape reading `hidden-paused` on all three — the pause path genuinely ran | PASS |
| Canvas backing store matches `devicePixelRatio` | `at0370`, all 24 mounted canvases | PASS |
| `bunx vite build` + `bun test` clean; `at0370` + `at0282` green | above | PASS |

Recorded from `at0370`'s diagnostics: `document.timeline.currentTime - performance.now() === 0` on a visible window, so the timeline does **not** stall there — [Q01](#q01-timeline-stall)'s deferral holds, and the self-check's visibility gate is cheap insurance rather than a load-bearing correction on this path. The occluded-window branch is still unmeasured, which is exactly why the gate stays.

The remaining unchecked tasks above are by-eye observations over minutes of real streaming (two full epochs side by side, a hard Lens scroll with the dev panel open, a rollover seam, idle cost, a >120 s collapsed span). They need a human at a running app and are the point of the debug build below.

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** A sparkline whose tape and whose scroll are provably the same function of one monotonic clock, which never moves its transform ahead of its pixels, and which pauses rather than tears down when it leaves the screen — so the Lens rail reads exactly like the card.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [x] `Date.now(` appears exactly once across `tug-sparkline.tsx` and `sparkline-tape.ts` — the named `wallOffset` seam (drift-prevention unit test, [Risk R04](#r04-clock-seam-reopened)).
- [x] A stalled stream still decays to baseline, in a unit case and in the real app ([#step-9](#step-9)) — the seam's observable behaviour.
- [x] The ordering invariant holds in every unit scenario: no `setEpochStart` without a delivered ack, from the surface or from the watchdog ([#step-4](#step-4) headline test).
- [x] A rebase whose ack never arrives still converges, including on the `hidden-paused` wake path where the failure would otherwise leave the tape paused ([Risk R05](#r05-lost-ack)).
- [x] The single-`t0` invariant holds: no ordinary paint ever uses a `t0` other than `committedT0`, including while a rebase ack is outstanding ([P10](#p10-committed-t0)).
- [x] The nudge band is capped at 2 CSS px and everything above it goes through the ack ([#step-7](#step-7) boundary test).
- [x] A canvas re-claim repaints; no tape is ever left blank by a resolution change ([#step-8](#step-8)). Unit-covered for `repaint()` and the cancel-then-repaint ordering; the cross-display observation is a by-eye task in [#step-10](#step-10).
- [x] No animation teardown outside mount/unmount in any scenario, unit or app-test ([#step-5](#step-5), [#step-9](#step-9)).
- [x] A Lens row survives three scroll-out/scroll-in cycles with the same `Animation` object, still running (`at0370`).
- [x] Canvas backing store matches the live `devicePixelRatio` on every mounted tape (`at0370`).
- [x] `tug-sparkline.tsx` and `sparkline-render-worker.ts` module headers describe the shipped design, not the replaced one.
- [x] `cd tugdeck && bun test`, `bun run check`, `bunx vite build`, `just app-test-changed`, and `just app-test` all clean.

**Acceptance tests:**
- [ ] `tugdeck/src/lib/__tests__/sparkline-tape.test.ts`
- [ ] `tests/app-test/at0370-sparkline-registration.test.ts`
- [ ] `tests/app-test/at0282-pulse-two-level.test.ts` (unchanged, must stay green)

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] [Q02](#q02-epoch-length) — reduce `EPOCH_S` now that rollover is cheap. At 120 s the canvas is 584 CSS px per Lens row and 2240 per Pulse-card channel row (≈6.5 MB of backing store for the seven-channel popover at dpr 2).
- [ ] Consider a genuine wrap-around ring-buffer canvas (see [#rejected-periodic-canvas](#rejected-periodic-canvas)) if texture pressure ever outweighs the complexity — it would remove the rollover rebase entirely.
- [ ] Investigate whether the Lens rail's composited layer under `overflow: hidden` inside a scroll container, beneath `.tug-pulse-trailing`'s `translateY(-3px)`, is independently costing the tape its composited layer ([Risk R03](#r03-other-causes)).
- [ ] Extend `recordActivity` coverage to the expanded Pulse card's per-channel tapes, which this plan changes but does not directly app-test.

| Checkpoint | Verification |
|------------|--------------|
| Policy extraction is behaviour-preserving | `bun test` green with Step 1's tests written against current behaviour; `at0282` green |
| One clock, one seam | drift-prevention test (exactly one `Date.now(`); `proposedT0` derivation test; rate-decay test green across Step 2 |
| Ack protocol lands without semantic change | Step 3's ack-latency-indifference test and its re-entrancy assertion |
| Rebase never precedes its pixels | Step 4's trace-ordering test and single-`t0` test across all scenarios |
| A lost ack cannot freeze the tape | Step 4's never-acks convergence test (live and `hidden-paused`); Step 8's cancel-and-re-issue test |
| Off-screen is a pause | Step 5's no-teardown trace test; `at0370` same-`Animation` assertion |
| Gate does not flap | Step 6's flap-storm test (hysteresis in the policy module, so it is reachable); quiet dev-log during a hard Lens scroll |
| Registration self-heals within a capped band | Step 7's boundary test at ±0.4 / ±1.5 / ±2 / ±400 px; `visibilitychange` divergence recorded as a `note()` |
| Backing store correct, and never blank | `at0370` canvas-size assertion; Step 8's `repaint()` test and the cross-display check |
| Whole phase | Step 10's checkpoint list |
