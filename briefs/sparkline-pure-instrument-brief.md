# Sparkline: a pure instrument

**Purpose:** The session sparkline still jumps spuriously and still gets stuck for minutes, after roughly five rounds of fixes. This brief audits the whole instrument — data, policy, drawing, motion, consumers, tests, laws — and decides on a replacement whose picture is a pure function of the store and the clock, so that neither failure can be expressed.

---

## Purpose {#purpose}

The report, in the user's words: "Sparkline still jumps spuriously; and gets stuck other times without moving more minutes. This must be like the *FIFTH TIME* that I've raised this issue. This MUST BE FIXED once and for all." And then: "It's *ridiculous* that such a simple thing should be complicated at all. I want a simple, reliable, robust, and high-performance sparkline."

Three screenshots came with it. Two, seconds apart on one working session, show the masthead tape as a full-width, full-height solid block and then as a full-width flat line at zero — no staircase in either, no history carried between them. The third shows two working sessions, one with a foreground tool 1m 23s into its run, whose tapes are not moving.

What is wanted is not a sixth patch. It is an instrument small enough that its correctness can be read off the page.

---

## Evidence {#evidence}

**[F01] The instrument is ~2,200 lines of production code and ~1,700 lines of unit test for one 15-second line graph.** `tugdeck/src/lib/sparkline-tape.ts` (1,194), `components/tugways/tug-sparkline.tsx` (879), `lib/workers/sparkline-render-worker.ts` (151), `lib/sparkline-geometry.ts` (146), plus `lib/__tests__/sparkline-tape.test.ts` (1,717). The drawing itself — `drawSparkline` — is about 50 lines. **(verified: `wc -l`)**

**[F02] The complexity is one thing: keeping two pipelines in agreement.** The *picture* is a point array posted to a worker that paints a canvas `width + 120 s × pxPerSec + 8` px wide (nine viewport-widths); the *window* onto it is a WAAPI `translateX` driven by `Animation.startTime` writes on the main thread. Everything else in `sparkline-tape.ts` is protocol for keeping those two in step: the committed origin, 120 s epochs, the ack-gated rebase with its `clear: false` proposal paint, the 250 ms ack watchdog, the paint hold during the ack window, `registerScroll`/`stopScroll`/`parkScroll`, the 4 Hz registration self-check with its ok/nudge/rebase bands, `colorsStale`, the three-state dormancy machine, the 500 ms hidden-pause hysteresis, and the wall-clock offset seam. **(verified: read)**

**[F03] Every prior fix was a correction to that protocol, not to the drawing.** [D133] in `tuglaws/design-decisions.md` says so in as many words — "All four are corrections to the *protocol*, not to the drawing" — and lists four shipped defects of the agreement model. `git log --grep=sparkline` shows the same pattern across `9b7bbb082`, `b0100a3b2`, `1427eb48d`, `a80c6b0db`, `1693707dc`, `7a466e6a2`. The rest baseline (`data-tape-rest`) was itself added so that a protocol failure "cannot lose the INSTRUMENT" — a fallback drawn in CSS because the canvas path was not trusted. **(verified: read)**

**[F04] The jump symptom matches a window sitting to the right of the ink.** `drawSparkline` extends the newest value flat to `svgWidth` (the held tail). A viewport displaced past the last point therefore shows nothing but the current pen value as a full-width block, and the block changes height whenever the value does — exactly the two screenshots. **(inference from the code and the screenshots; not reproduced)**

**[F05] Two candidate roads to [F04], neither reproduced.** (a) `wakeLive` → `registerScroll` moves the transform synchronously, while the repaint it depends on is an async `postMessage` to the worker; the window lands on the old picture's held tail first. (b) If `document.timeline.currentTime` and `performance.now()` ever differ by a constant — the code's own comments note the timeline stalls under occlusion — `resyncRegistration` writes the *same* committed origin back as `startTime`, so the offset survives and the forced rebase repeats every 250 ms without healing. Confirmation would be the dev-log line `visible: registration off by …ms` reading a persistent non-zero value. **(inference)**

**[F06] The stuck symptom matches a wedged state machine, and the best candidate is the visibility gate.** `tug-sparkline.tsx` computes the `IntersectionObserver` root once per effect via `nearestScrollableAncestor(container)`. If the card is later reparented (dock, stack flip, minimize), that root is no longer an ancestor, `isIntersecting` stays false, and `SparklineTape.onActivity` takes `if (!this.inView) { this.lastChangeAt = now; return; }` on every event — the tape never wakes until remount. **(the early return is verified by reading; the reparenting trigger is inference, not reproduced)**

**[F07] The store already holds everything the tape draws — for rate channels.** `RateMeter.series(nowMs)` returns `ACTIVITY_WINDOW_BINS = 80` bins of `ACTIVITY_BIN_MS = 250` ms: 20 s, against 15 s visible. Bins are indexed by absolute wall clock (`floor(ms / 250)`), stamped with `Date.now()` on frame arrival, zero-filled on advance, and immutable once the head has moved past them. `compositeSeries(session, now)` is a pure read. The tape's point array is a second copy of this. **(verified: `lib/activity-meter.ts`, `lib/session-activity-store.ts`)**

**[F08] Gauge channels have no history at all.** `GaugeMeter.series()` returns `new Array(windowBins).fill(latestValue ?? 0)`. The only record of a gauge's past is the tape's own point array, so every `rebuildTape` — each wake, each remount — silently flattens a gauge row's history to its current level. This is a standing violation of "values are never revised" that the current design cannot fix from inside the tape. **(verified: `lib/activity-meter.ts`)**

**[F09] The current tape reads the still-open bin.** `sampleRate` sums the last four bins including the open one, so each plotted point undercounts by whatever has not yet arrived in that bin, and the undercount is then frozen by rule 1. **(verified: read)**

**[F10] The original cost problem was SVG style invalidation, not drawing.** The worker header records it: setting `points` on a polyline scheduled a rendering update 4×/s per tape on a deck whose rendering updates cost ~10 ms. An `OffscreenCanvas` owned by a worker commits to the compositor without waking the page. That property does not depend on the transform, the epochs, or the oversized canvas. **(verified: read)**

**[F11] The tape moves slowly enough that a redraw loop is indistinguishable from compositor scroll.** At the session-row cut the scroll is on the order of 7 CSS px/s; at 2× that is ~14 device px/s, so a ~15 Hz redraw advances at most one device pixel per step. **(arithmetic from `VISIBLE_SECONDS` and the row width; the exact width was not read)**

**[F12] The tool hum is delivered as ordinary events.** `tugcode/src/session.ts` credits `FOREGROUND_TOOL_HUM_UNITS = 30` to `tools` in every drained bin while a foreground tool is open, so a long shell command produces a steady 4 Hz stream of rate events and a steady plotted level. A steady level is a flat line, and a flat line scrolling is pixel-identical to a flat line standing still — so "not moving" during a long tool is correct *if and only if* the picture is actually flat. **(verified: read)**

**[F13] Consumers and test surface.** Three mounts: `session-activity-sparkline.tsx` (masthead, Cards rows, picker — via `session-identity-row.tsx`), `cards/session-activity-card.tsx` (per-channel rows, including gauges, with `getColorChannel`), and `spikes/spike-session-identity.tsx`. Tests touching the instrument: `sparkline-tape.test.ts`, `sparkline-rest-baseline-alpha.test.ts`, and app-tests `at0567`, `at0601`, `at0257`, `at0293`; `test-surface.ts` exposes `sparklineTapeState` via `peekSparklineTape`. `activity-meter.ts` pins its 80-bin window to `rebuildTape`'s reach. **(verified: grep)**

**[F14] [L13] as written forbids the obvious design.** "Motion is a WAAPI transform, never an rAF/timer-driven frame loop." The animation doctrine's measured objection is to per-frame *style mutation on the main thread*, which forces a page walk per frame. A worker-owned canvas redraw mutates no style and wakes no page. **(verified: `tuglaws/animation-doctrine.md`)**

---

## Decisions {#decisions}

**[B01] The picture is a pure function of `(bins, now)`. There is no tape.** Each frame clears a viewport-sized canvas and draws the staircase from the store's bins, each bin edge at `x = width − (displayNow − binEdge) · pxPerSec`. The rolling one-second sum, the response curve, the clamp and the held tail are arithmetic inside the draw. No point array, no origin, no transform. A jump requires two things to disagree, and there is now one thing. Any frame that draws at all is correct in full, so no failure can outlive the next frame.

**[B02] Delete the agreement machinery outright.** Epochs, `committed`, rebase/ack/watchdog, the paint hold, `checkRegistration` and its bands, `registerScroll`/`parkScroll`, `colorsStale`, the wall-offset seam, the WAAPI animation, and the three-state dormancy machine all go, along with [D133], which is superseded. None of it has a job once [B01] holds.

**[B03] Delete the `IntersectionObserver` gate.** It is the prime suspect for the stuck tape ([F06]), and what it saves is a ~100×22 px canvas redraw for sessions that are both working and scrolled out of view — less than the gate costs in risk. `document.visibilityState` may pause the tick for a hidden page; nothing finer.

**[B04] The only state is a timer handle, and "live" is read from the data.** A store event starts the tick if it is off. Each tick draws; if every plotted value across the retained window is equal, the picture is flat, scrolling it changes nothing, and the tick stops itself (stamping `data-tape-rest` when that value is zero). The next event starts it again. This keeps the idle-costs-nothing property of the current design with no state to wedge: a tick that stopped wrongly is restarted by the next event and the first frame after is fully correct.

**[B05] Draw half a second behind the clock.** `displayNow = Date.now() − 2 × binMs`. The right edge then only ever shows bins that are closed and delivered, which removes the open-bin undercount ([F09]) and makes "values are never revised" true by construction rather than by bookkeeping. 500 ms on a 15 s tape is not perceptible as lag.

**[B06] The worker owns the tick; the main thread posts data only on store events.** The message is `{headBin, bins, hold}` — absolute head index, the window, and whether time past the head is zero (rate) or the last level (gauge). Both threads read `Date.now()`, so there is no clock to convert. This keeps [F10]'s property — the page is never woken by a tape — and takes the main thread out of the loop entirely rather than merely lightening it. The on-main fallback (no `transferControlToOffscreen`) runs the identical instrument class against a main-thread context; one implementation, injected clock and timers.

**[B07] Tick at ~15 Hz.** Per [F11] that is at most one device pixel per step. Revisit only if a wider consumer makes stepping visible; the knob is one constant.

**[B08] `GaugeMeter` gains real binned history.** Level-per-bin with hold-forward, same window and indexing as `RateMeter`. This fixes [F08] independently of the redraw, and it is a precondition for [B01] on the activity card's gauge rows. The 80-bin window stays; its justification in `activity-meter.ts` is rewritten to cite the visible span plus the display lag, not `rebuildTape`.

**[B09] Kept as they are:** the `data-tape-rest` CSS baseline and its alpha-parity test, the `data-activity-channel` tint and `getColorChannel`, colour resolution from computed style on mount/theme/tint change, the dpr-keyed canvas replaced by `key` ([L26]), the curve library, and `TugSparkline`'s published props — so no consumer changes. Under reduced motion the instrument draws once per store event instead of ticking.

**[B10] [L13] gets a named carve-out in `tuglaws/animation-doctrine.md`.** An instrument that redraws *data* onto a worker-owned canvas on a timer is not animation in the law's sense: it mutates no style, triggers no main-thread rendering update, and the doctrine's measured objection ([F14]) does not reach it. The carve-out is scoped to worker-owned canvases so it cannot be cited for a main-thread style loop. A new design decision records this and supersedes [D133].

**[B11] Tests are rebuilt around purity.** A DOM-free unit suite drives the instrument with a fake clock and a recording context: same `(bins, now)` ⇒ same draw calls; flat window ⇒ tick stops; event ⇒ tick starts; picture after any gap equals picture from a fresh mount. `sparkline-tape.test.ts` is deleted with the file it tests. `sparklineTapeState` on the test surface is replaced by a read of the instrument's one fact (ticking or not, plus the newest plotted value); `at0567`, `at0601`, `at0257`, `at0293` are updated to it. One new app-test reparents a live card and asserts the tape keeps drawing — the regression [F06] describes.

---

## Open Questions {#open-questions}

- **Were [F05] and [F06] the actual causes?** Unreproduced. This does not block the work — [B01]–[B03] remove the mechanisms whichever was responsible — but if the symptoms survive the rewrite, the cause is upstream of the instrument (event delivery from tugcast), and that is where to look next.

---

## Non-goals {#non-goals}

- **A sixth protocol patch.** Instrumenting the clock offset and the observer root to find the next disagreement was considered and rejected: the class of bug is the design ([F02], [F03]), and a fix that leaves the class standing is the thing that has failed five times.
- **Keeping the transform and shrinking the rest.** Any compositor scroll needs an origin, and any origin needs rebasing and registration. There is no small version of two pipelines.
- **A main-thread canvas loop.** Simpler still, but it reintroduces [F10]'s rendering-update cost per tick per live tape.
- **Changing what the instrument shows.** Window length, full scale, curve, tint, hum level and row geometry are untouched.
- **Changing the wire or tugcode.** The activity feed and the hum are fine as they are ([F07], [F12]).

---

## Exit {#exit}

**An arc.** Raw material for its task list, in the order they must land:

1. `GaugeMeter` binned history ([B08]), with its unit tests — independent, lands first.
2. The pure instrument: draw function over `(bins, headBin, hold, displayNow)` and the self-stopping tick, DOM-free, with the [B11] unit suite.
3. Worker rewired to host the instrument ([B06]); main-thread fallback hosting the same class.
4. `tug-sparkline.tsx` reduced to the surface: canvas claim, colour resolution, store subscription → post, rest and channel stamps. Viewport-sized canvas; track element and animation removed.
5. Delete `sparkline-tape.ts`, its test, and the dead exports; update `test-surface.ts` and the four app-tests; add the reparenting app-test.
6. Laws: [L13] carve-out, new design decision superseding [D133], `activity-meter.ts` window comment ([B10], [B08]).
