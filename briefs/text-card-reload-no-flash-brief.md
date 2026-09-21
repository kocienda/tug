<!-- brief-skeleton v1 -->

# Text card reload: no frame with the wrong text at the top

**Purpose:** An in-place reload of a Text card can paint one frame with the new text at the old scroll offset before the correction lands. The disk-sync round-out (`185bbbc68`) fixed the reload that *lost* its place; it did not join the text and the scroll correction into one beat, and a one-frame flash is a bug.

---

## Purpose {#purpose}

The round-out arc's audit reported the flash as a judgment call about how strict a test should be. The user's answer:

> I have to be honest with you. This does not read like we nailed it here. One-frame flashes are ***BUGS***. Tell me how we build on the progress here and actually make this achieve the level of polish I asked for as we started on this work.

That is the right reading. The reader's place is theirs, and a reload that shows them the wrong line for a frame has moved it, however briefly. The assertion that caught it was correct and stays; what is missing is the fix, and a way to produce the race on purpose rather than waiting for a loaded machine to expose it.

---

## Evidence {#evidence}

**[F01] The flash was observed, once, under load.** In a 14-file app-test batch whose wall time had nearly doubled, `at0209` scenario 3b's per-frame sampler traced `045@900 | 044@900 | 045@920`: the new text painted at the old `scrollTop` for one frame, and the correction arrived on the next. Every quiet run — alone, and in two other batches the same day — traces the single state `045@920`. **(verified; observed once)**

**[F02] The mechanism is two beats joined only by a frame callback.** In `tugdeck/node_modules/@codemirror/view/dist/index.js`, `EditorView.update` applies the DOM change synchronously (`docView.update`, near line 7951) and then only calls `requestMeasure()` (near 7963), which schedules `measure()` on `requestAnimationFrame` (near 8258). The scroll-anchor correction — `scroll.scrollTop += diff` — lives inside `measure()` (near 8162–8170). Any paint that gets in before that callback runs shows new text at the old offset. **(verified from source)**

**[F03] The measure-first fix that landed closed the permanent miss and nothing more.** `dispatchReplacement` in `tugdeck/src/components/tugways/tug-text-card-editor.tsx` calls `requestMeasure()` and then `coordsAtPos()` *before* the dispatch, so the anchor is computed from a fresh scroll offset. Reverting it leaves the trace stuck at `044@900` with no correction at all. It never touched the ordering in [F02]. **(verified by the landed arc's reverse probe)**

**[F04] The same public-API flush, called after the dispatch, applies the correction in the same task.** `readMeasured()` (near line 8246) runs `measure(false)` synchronously whenever a measure is scheduled and the view is idle, and after `update()` one always is. `coordsAtPos` goes through `readMeasured`. The correction's own guard — `scroll == this.scrollDOM || this.hasFocus || recent wheel/touch` — passes without focus because the scroller is CM6's own `.cm-scroller`. **(verified from source; that it closes the flash is inference until a sampler shows it)**

**[F05] The window exists in the product, in two shapes.** A dispatch made from inside the browser's rendering steps registers its frame callback for the *next* frame by construction — and the hidden-card path does exactly that, dispatching from a `requestAnimationFrame` callback armed inside a `ResizeObserver`. And a `WKWebView` whose frame callbacks are throttled — an occluded or backgrounded window — can paint without running them; a covered app-test harness window is already known to suspend `requestAnimationFrame`. An agent rewriting a file while Tug is not frontmost is the ordinary Tug case. **(mechanism verified; how often the product hits it was not measured)**

**[F06] The hidden-card path hand-rolls the correction because of [F05].** `applyDeferredReplacement` reads the top row's document position with `posAtCoords`, maps it through `ChangeSet.mapPos`, dispatches, and moves `scrollTop` by the `lineBlockAt` height delta. Its commit recorded that two earlier shapes using a `requestMeasure` write phase landed neither text nor correction, and that dispatching directly in the resize callback lost the place by one row. It waits one frame past the observer callback. **(verified)**

**[F07] Nothing can produce the race on purpose.** It appeared only under machine load. A loaded machine is not a test plan, and a scenario that is red one run in several is the marginality the round-out arc was opened to end. **(verified)**

**[F08] The three `EvalError` reds seen beside the flash were load, not a regression.** `at0210`, `at0223` and `at0224` failed twice on the arc's tree with `JavaScript execution returned a result of an unsupported type`. Run alone on `main` at `cab4148d1` with a fresh bundle they are green, 11/11. **(verified)**

---

## Decisions {#decisions}

**[B01] `dispatchReplacement` flushes CM6's measure synchronously after the dispatch as well as before it.** The same two public calls, `requestMeasure()` then a public layout read, so the DOM write and the scroll-anchor correction land in one task and no painted frame can hold new text at the old offset ([F02], [F04]). It is the one door all external text enters through, so reload, merge, Revert to Saved and Reload from Disk are covered together. Revisit only if [B05] fires.

**[B02] The race gets a deterministic scenario, red before the fix every time.** Hold the page's `requestAnimationFrame` callbacks — a test-side stall installed before the reload and released after — drive the same-task reload, and read the top line while frames are held: it must already be correct with no frame callback having run ([F07]). `at0209` 3b's per-frame sampler assertion stays byte-for-byte as strict as it is. Nothing is loosened and no wait is added.

**[B03] The proof is a sampler trace and a reverse probe, not a green run.** A `tugtool file probe` reverting only the post-dispatch flush must turn [B02]'s scenario red. This is the standing lesson for motion bugs: the 2026-09-18 drop fix was "verified" green and was not fixed.

**[B04] The hidden-card path is brought onto the same footing, and the scenario decides how far.** Try dispatching with the pre- and post-flush directly in the `ResizeObserver` callback, retiring the extra frame and — if CM6's own anchor then holds — the hand correction too ([F06]). If `at0602` scenario 6 goes red under that, the hand correction stays and only the post-flush is added. Either way what was found is written down, because [F06] records two shapes that already failed here and the next reader should not try them a third time.

**[B05] If the sampler shows the flash surviving [B01], the reading in [F04] is wrong: stop and say so.** No second guess ships. The fallback is named in advance so the stop is cheap: the synchronous hand correction of [F06], generalized to every `replaceText`.

**[B06] Law compliance is named in the work, not inherited by mimicry.** The laws this change stands on, each to be cited in the commit body of any round touching `tugways`:

- **[L23]** — scroll position is user data an internal operation must never lose, and the in-session mechanism is minimal mutation. This work is that law's scroll clause held to the frame rather than to the settled state.
- **[L06], [L22]** — the correction is a direct DOM write in the same task as the store-driven change. It never round-trips through React state or an effect.
- **[L05], [L13]** — no frame callback sequences the correction. Frame timing is not an ordering contract, which is exactly what [F02] demonstrates.
- **[L32]** — the hidden-card deferral is a refusal to measure that re-arms on the shown transition rather than just returning, and while its beat has not run the buffer still answers with the held text, so it fails toward correct.
- **[L27]** — every observer and frame handle acquired is released on teardown, including any this change removes the need for.
- **[L07]** — the bridge reads current state through refs, never a stale closure.

---

## Open Questions {#open-questions}

- **Does the deferral's `ResizeObserver` fire for a card whose *workspace layer* goes from `display: none` to shown?** [L23]'s third class and [L32] name `useSpaceLayerShown()` as the condition for that transition. A box appearing should notify the observer regardless of which ancestor hid it, but no scenario covers a reload into a card in a hidden workspace. Settled by one `at0602` scenario; if it is red, the deferral re-arms on `useSpaceLayerShown()` as well.

---

## Non-goals {#non-goals}

- **Loosening, scoping down, or adding a wait to `at0209`'s per-frame assertion.** It was right, and it is what made this visible.
- **Calling CM6's `@internal` `measure()`, or patching CM6.** The public flush in [F04] reaches the same pass.
- **A timer that re-checks hidden editors.** The deferral is applied on the show event, never on a clock.
- **Changing the merge, the save modes, the wire, or the watch service.** Settled by the two arcs before this one.
- **Chasing the load-induced harness `EvalError`s.** Recorded as contention in [F08].

---

## Exit {#exit}

**An arc**, small, in this order — the red scenario first, so the fix is proven against something that could fail:

1. The frame-stall scenario of [B02], red on today's `main`.
2. The post-dispatch flush of [B01].
3. The sampler trace and the reverse probe of [B03]; the stop of [B05] if the flash survives.
4. The hidden-card path per [B04], and the hidden-workspace scenario from Open Questions.

Done means: the new scenario green and proven able to go red; `at0209` and `at0602` green alone and in the derived selection; full `bun test` green; `bunx tsc --noEmit` clean in `tugdeck` and `tests/app-test`.
