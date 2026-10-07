<!-- brief-skeleton v1 -->

# View › Zoom: make the gesture fast, and make it answer

**Purpose:** View › Zoom In / Zoom Out / Actual Size is the app-wide "pack more on the screen" control Tug already ships, and it is unusable as it stands: a zoom step freezes the deck for seconds, applies the next step late, and shows nothing while it works. This brief records what the gesture actually costs, why, and what the user should see from the moment the chord lands.

---

## Purpose {#purpose}

The user wanted one more high-value app-wide option to fit more content on a laptop screen. The sketch found that option already exists — View › Zoom drives `WKWebView.pageZoom` from 50 % to 200 % in 10 % steps, persisted across launches — and the user's answer was that it is the thing they want, but "the performance and feedback on this zoom *is so abysmal and laggy* that it seems broken." The ask is a brief that looks at the performance of the gesture **and** provides immediate feedback, probably an app-modal sheet, to cover the time the zoom takes to render.

---

## Evidence {#evidence}

All readings below were taken on 2026-10-06 against the running release deck (`release-main`, Tug.app Release, viewport 1981×1222 CSS px at 2×, 8 panes, 4 CodeMirror editors, 18 495 DOM nodes, 94 transcript entries mounted across four Session cards) with the window frontmost, driving the real chords (`⌘-` then `⌘=`) through System Events. A first attempt through the menu *items* (System Events clicking View › Zoom Out) stalled the page identically, so the shape is not a menu-tracking artefact.

**[F01] The relayout alone is ~350 ms, and that is the small part** — a synchronous `body.style.zoom = 0.9` followed by a forced `offsetHeight` read, through `/api/eval`, cost 348 ms each way for style + layout. Paint and the compositing walk are on top of that. **(verified)**

**[F02] After a zoom step the page stops rendering and stops processing input for 6–10 s** — a `requestAnimationFrame` series armed before the chord shows 60 Hz at rest, then at the `⌘-`: a 360–380 ms gap, two or three slow frames (120–210 ms), and then a single gap of 7.6–10.9 s during which no frame was delivered. The `resize` event for the following `⌘=` (sent 3 s after `⌘-`) did not fire until that gap ended, so the second step was applied 8–11 s late. `/api/eval` round trips issued during the gap blocked for the same duration — the page's JS thread was busy, not idle. Reproduced four times. **(verified)**

**[F03] A plain window resize does not stall** — the same rAF recorder across a 120 px window-width change and back: 414 ticks, worst gap 78 ms, two `resize` events on time. The stall is specific to the zoom path, not to "the deck relaid out." **(verified)**

**[F04] The host's main thread is idle through the stall** — `sample Tug 4` during a zoom: 3239 of 3265 samples in `mach_msg` under `__CFRunLoopRun`; the remaining 21 are `RemoteLayerTreeDrawingAreaProxy::asyncSetLayerContents` IOSurface plumbing. Nothing in `MainWindow.setPageZoom` (clamp, `pageZoom =`, `UserDefaults.set`) or in menu validation is the cost. **(verified)**

**[F05] The deck's WebContent main thread spends the whole stall in JavaScript off a WebSocket message** — `sample` of the deck's WebContent process (pid identified by WebCore frame count) during a zoom: 2774 of 2774 main-thread samples under `WebSocket` event dispatch → microtask checkpoint → JIT frames; the hot engine leaves are `CSSComputedStyleDeclaration::getPropertyValueInternal` → `Document::updateStyleIfNeeded` → `Document::resolveStyle` (2600 samples) with `RenderLayerCompositor::updateCompositingLayers` / `computeCompositingRequirements` under each. That is JS reading a computed-style property with the whole document's style dirty, over and over. **(verified)**

**[F06] The reader is `findScrollAncestor` in `tug-transcript-entry.tsx`, reached from a React commit** — wrapping `getComputedStyle` on the live deck and timing property gets across one `⌘-` / `⌘=` pair: 4 115 property reads, 255 of them over 2 ms, every slow one `overflowY`, from one call site, total **5 782 ms**, ~23 ms per read. The stack is the `useLayoutEffect` in `TugTranscriptEntry` → `registerPinStackEntry` → `findScrollAncestor`, which walks the pin's ancestors reading `getComputedStyle(p).overflowY` at each (`tugdeck/src/components/tugways/tug-transcript-entry.tsx:450-458`). Each read forces a full style resolve of an 18 k-node document because the commit interleaves DOM writes between entries. **(verified)**

**[F07] That effect only runs at mount, so the zoom mounted ~260 transcript entries that were not mounted before** — the entry count across the deck went 94 → 356 at the zoom-out, every one of the original 94 elements still connected, and back to 95 once the zoom had settled. The over-mount is transient: the transcript's windowed list grew its rendered window to several hundred rows for the duration of the relayout and shrank again after. **(verified)**

**[F08] The list view's own doctrine explains the growth path** — `tug-list-view.tsx` (around line 1020) says a container **width** change invalidates every cell's measured height so cells "drop back to full rendering, re-measure, and re-arm"; the windowing math in `list-view-window.ts` then sizes the window from `scrollTop`, `clientHeight`, and per-index heights, falling back to `estimatedHeightForKind` (default 60 px) for unmeasured cells. A zoom step changes the CSS-px width of every scroller at once (1981 → 2201 at 0.9×), so every transcript on the deck re-estimates in the same frame. **(read from code; the exact chain from "stamps invalidated" to "window of 260 extra rows" is inferred, not traced — confirming it means logging the window bounds across a zoom.)**

**[F09] No feedback exists on either side** — the deck is never told the zoom value or that it changed: `currentPageZoom` is a Swift property on `MainWindow`, read only by `validateMenuItem`; the registry's zoom commands are `routing: "first-responder"` with a chord and no predicate (`command-registry.ts:1954-1990`, `tuglaws/menus.md` §host tier), and `tugdeck/src` has no reader of the zoom level. The host, for its part, gets no completion signal from WebKit after setting `pageZoom`. The user sees the menu item's own highlight and then nothing until the page unfreezes. **(verified)**

**[F10] Three mechanisms exist for "zoom" and one is user-facing** — the host's `pageZoom` (View menu, persisted, 50–200 %); a dormant CSS token `--tug-zoom` applied as `body { zoom }` in `tug.css` and written only by the gallery's scale-timing spike, which `getTugZoom()` reads and the canvas, pane, snap-guide and rail-width code divide their rect measurements by; and a per-card transcript `magnification` (CSS `zoom` on the transcript root). **(verified)**

**[F11] The host already owns a native cover** — `MainWindow.freezeForReload` snapshots the content view into an `NSImageView` placed as a *sibling* of the web view in `containerView`, and `thawAfterReload` crossfades it away when `frontendReady` fires; `freezeForShutdown` does the same with `webView.takeSnapshot`. Both exist so the user sees a frozen frame instead of flicker while the page is unusable. **(verified)**

**[F12] A deck-side cover cannot paint while the deck is the thing stalled** — follows from [F02] and [F05]: during the 6–10 s the page's main thread is in JS and delivers no frames, so a sheet rendered in the page would neither appear nor animate until the stall ends. Any surface meant to be visible *during* the stall must be native, or the stall must be gone first. **(inference from the measurements; trivially confirmable by raising any in-page sheet before a zoom today.)**

**[F13] The deck already tunes itself 200 ms after the canvas comes to rest** — `deck-canvas.tsx`'s settled-resize `ResizeObserver` restarts a `RESIZE_RETUNE_QUIET_MS` (200 ms) timer on every observation and calls `store.retuneSidebarAllocation()` on expiry, which re-derives flow, column and rail offsets and may move rails. On a zoom this lands after the stall as a second visible event. **(read from code; its cost under a zoom was not measured.)**

---

## Decisions {#decisions}

**[B01] View › Zoom is the app-wide density control; nothing new is built beside it.** It already scales everything uniformly, persists, and has a menu seat with chords. The sketch's other candidates (a fourth `wisp` width, a Compact density mode, rail tucking) are not pursued by this work ([non-goals](#non-goals)). What the user asked for is this control made to feel like it works.

**[B02] The stall is a deck defect and this work fixes it; the cover is not a substitute for the fix.** [F05]–[F07] put the whole of the 6–10 s in deck JavaScript, in a transient over-mount the deck does to itself. A cover that hides a 10 s self-inflicted freeze would be dishonest, and [F12] says it could not even be an in-page one. The fix is owned here, not deferred to the transcript's owners: the arc that surfaced it owns it.

**[B03] The fix attacks the over-mount first, the per-entry read second.** Two independent multipliers make 5.8 s: ~260 entries that should not have mounted, and ~23 ms per `overflowY` read because each read lands with style dirty. Removing either collapses the product. The over-mount is the primary target because it also costs the mount of ~260 rich entries (markdown, code, atoms) and their teardown; the read is the secondary target because a scroll-ancestor lookup has no business forcing style on an 18 k-node document per entry (the controller is keyed by scroller already; the lookup can be answered once per scroller, or passed down, or deferred past the commit). Both land; the arc's first measurement decides their order by payoff.

**[B04] The deck learns the zoom from the host, before and after.** Today the deck cannot react to a zoom because it does not know one is happening ([F09]). The host sends a notice on the existing control channel *before* it sets `pageZoom` (carrying the target factor) and a second after the page has delivered a frame at the new factor (a JS round trip, since WebKit offers no completion callback). This is what makes any feedback possible, and it is cheap: the channel, the message shape and the menu-state plumbing all exist.

**[B05] Feedback is immediate and names the number.** Within the first frame after the chord the user sees the target factor — "90 %" — not a spinner alone. A zoom step is a discrete, bounded operation whose result is known at dispatch, so the honest feedback is the destination, the way macOS's own zoom HUDs and Safari's page-zoom pill behave. The surface is dismissed when the "after" notice of [B04] arrives.

**[B06] The cover for the relayout is the host's, raised only when the relayout is still long enough to need one.** Once [B02]–[B03] land, a zoom step is bounded by [F01] — a few hundred milliseconds of style, layout and paint. If that is what remains, the "90 %" readout of [B05] *is* the cover and no sheet is warranted. If a measured residue stays above roughly a quarter second on a large deck, the cover is the native snapshot overlay of [F11] (frozen frame plus the readout), because [F12] rules out an in-page sheet for exactly the window it would need to cover. The user's "probably an app-modal sheet" is read as "cover the gap"; the gap's measured length after the fix decides whether a cover is needed and [F12] decides which kind.

**[B07] The gesture is measured by the instruments this brief used, before and after, on the same deck shape.** A rAF series armed before the chord (`tugtool deck motion gesture` once the recorder is served, or the inline recorder used here), a `getComputedStyle` property-read wrapper over `/api/eval`, and `sample` of the deck's WebContent process. The bar: no frame gap over one frame beyond the relayout itself, the second step of a double-tap applied within one frame of its chord, and no transcript entry mounted that was not needed by the post-zoom window. These are stated here so the arc's checkpoint is a verdict, not a probe.

**[B08] The dormant `--tug-zoom` token is retired, or made the mirror of the host's factor, and not left as a third mechanism.** [F10]: a deck that divides its measurements by a token nobody sets is correct only by accident. Whichever the arc chooses, the invariant is one user-facing zoom, one number, and every measurement path reading the same source.

---

## Open Questions {#open-questions}

- **Where exactly does the window grow to 260 rows?** [F08] names the invalidation doctrine and the estimate fallback but the chain is inferred. Settled by logging `computeWindow`'s inputs and outputs across one zoom step on a loaded deck. This changes *how* the over-mount is fixed (clamp the window's growth per commit, keep measured heights across a zoom, scale them, or treat a zoom as not-a-width-change), not whether.
- **What is the residual relayout once the over-mount is gone, on the largest deck the user runs?** It decides [B06]. Measured by the instruments in [B07] after [B03].
- **Does `retuneSidebarAllocation` ([F13]) move anything visibly after a zoom, and should it?** If rails jump 200 ms after the page unfreezes, the "after" notice of [B04] should wait for it, or the re-tune should be suppressed for a zoom. Settled by watching one zoom with the fix in place.

---

## Non-goals {#non-goals}

- **A second zoom mechanism.** No deck-side zoom slider, no new CSS `zoom` surface. The host's `pageZoom` is the one; see [B01], [B08].
- **A `wisp` content width, a Compact density mode, or rail tucking.** Considered in the sketch as alternatives for laptop screens. Each is real work with its own blast radius (preset enumerations, a spacing-token audit, a new layout gesture) and none is what the user chose. They stay available as later work and are not re-argued here.
- **An in-page modal sheet raised *during* the stall.** Ruled out by [F12]; the page cannot paint it. A deck-side readout is fine *after* the stall is fixed, when the page is painting again; that is [B05].
- **Deferring the transcript over-mount to "the list view's owners."** The arc that found the defect owns it ([B02]).
- **Changing the zoom range, step, or persistence.** 50–200 % in 10 % steps, persisted to `UserDefaults`, pinned to 1.0 under the app-test harness — all unchanged.

---

## Exit {#exit}

**An arc.** Its first steps, in the order they must land:

1. **Instrument and reproduce** on the release deck with the [B07] instruments; record the before numbers; log the list view's window bounds across one zoom to close the first open question.
2. **Remove the over-mount** in the list view's width-invalidation path, and **de-thrash `findScrollAncestor`** so one scroller lookup is paid per scroller, not per entry per commit. Re-measure; both multipliers gone is the verdict.
3. **Tell the deck** — the before/after notices of [B04] on the control channel, and the `--tug-zoom` decision of [B08].
4. **Show the number** — the [B05] readout, raised on the "before" notice, dismissed on the "after."
5. **Decide the cover** from the residual measured in step 2 — nothing, or the host snapshot overlay of [F11] — and land it if warranted.
6. **Verdict run**: the [B07] bar on the same deck shape, once.
