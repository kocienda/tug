<!-- brief-skeleton v1 -->

# A gesture's task without React in it

**Purpose:** A flow slide's first frame lands 43–63 ms after the click, three frames late, because the click's own task still runs about 48 ms of synchronous work carrying six React commits. The deck store's notify was moved out of the gesture's task; every other store that tells React in that task was not.

---

## Purpose {#purpose}

`briefs/graphics-animations-asks.md` put "motion before React" first of its five concepts: the tween launches from the store subscriber and React commits under a frame that is already moving. An audit of the work landed since (2026-10-01, this conversation) found it built for one store and one gesture, and the user asked for the remainder to be briefed:

> the next piece of real work is either taking React out of the gesture's task for every store (the measured cause of the late first frame)

The gesture measured is the one the flow-slide briefs were written about: a click on a session row in the Cards card that activates another session card and slides the flow strip to it. The findings of `briefs/flow-slide-remainder-brief.md` are cited by that brief's name rather than repeated.

---

## Evidence {#evidence}

**[F01] The lead block is the click's own task: about 48 ms of synchronous dispatch carrying six React commits.** Flow-slide-remainder `[F09]`, taken with `tugtool deck motion slide --tasks` on a 4,038-element deck: the click dispatch is 48.0 ms per click (max 66), with six commits inside it before the handler returns — one of ~907 fibers whose origins are `ConfigureTug`, `DeckCanvas`, `SessionCardBody`, `CardsContent` and one more; one of ~632 from `SessionCardBody`, `CardsContent` and `ArcsContent`; two of ~170 each from `ArcsContent`; two that did no work. React's own microtask flush adds 8.2 ms and five more commits. The recorder gives a commit's fibers and origins but not its duration, so which of the six carries most of the 48 ms is not separated. **(verified, measured; one deck, a third the size of the user's everyday one; per-commit cost not measured)**

**[F02] The pre-launch works, and the task it launches from is what delays it.** `arm` in `tugdeck/src/components/chrome/deck-canvas.tsx` writes the new flow offset and launches the move tween from the store delta, inside the click's task, before React renders. A WAAPI tween created in a task is play-pending until that task's rendering update, so the tween cannot show a frame until the task ends. First frame reads 43–63 ms after the click across the flow-slide readings (remainder `[F01]`, `[F07]`), against a 16.7 ms period. **(verified for the readings and the code; that the task's length is the whole of the delay is inference from the two together)**

**[F03] The deferral is opt-in, per store, at five call sites.** `scheduleAfterPaint` (`tugdeck/src/lib/after-paint.ts`) is called from `deck-manager.ts` (the deck store's React subscribers), `cards-selection-store.ts` (two sites), `responder-chain.ts` (the chain's notify), `session-card.tsx` (the picker present) and `host-menu-state.ts` (the menu publisher). Each was added when a reading named that store. A store nobody has named still tells React synchronously, and React commits a discrete-event update before the event returns. **(verified, read from the code)**

**[F04] Activation's focus transfer forces a synchronous commit by default.** `transferFocusForActivation` in `tugdeck/src/focus-transfer.ts` wraps its mutation in `flushSync` and flushes the deck store's pending notify inside it, unless the caller passes `deferCommit` — which is granted only when the incoming card's host is proved on screen. The contract it protects is real: step 5 focuses an element that must have left `display: none`. **(verified, read from the code)**

**[F05] The commits in the click name their origins, and several are not about the deck's geometry.** `SessionCardBody`, `CardsContent`, `ArcsContent` and `ConfigureTug` appear as commit origins in `[F01]`. Which store update drives each — card activation state, the Cards card's selection, the arcs list, a theme or configuration read — has not been traced from origin to store. **(verified that they appear; the store behind each is not identified)**

**[F06] Only the flow-only slide launches before React.** Arrival, departure, fold, split, rail show and hide, bullseye and resize-to-fit all launch from the Last pass, after the commit, because their target geometry is measured from the DOM. Their standing reds in `tests/app-test/at0654-deck-settle-standing-reds.test.ts` are leads of 18–34 ms. **(verified, read from the code and the test's header)**

### Readings since {#readings}

**[F07] The door took every commit out of the click's task.** Build `85f697274`, release, two session cards in Two Up · Wide, 16 clicks per run on a freshly launched deck, `tugtool deck motion slide --tasks`: commits in the click task 8.0 → 0.0 per click (21.7 ms React, 39.3 ms span before); first frame 26–49 → 14–28 ms; lead blocked 27–49 → 22–48 ms. The one-frame bar is met on some clicks and not all. At the time the verb dispatched all five pointer events from one task, so the press's work counted in the click task; it now dispatches the press and the release as two tasks and reports each. **(verified, measured; the census beside it is the card count, not an element count)**

**[F08] The door's design.** `tugdeck/src/lib/gesture-scope.ts` exports the `useSyncExternalStore` and `flushSync` every non-test file under `tugdeck/src` imports, and `src/__tests__/react-door.test.ts` refuses any file that takes either from React directly. `installGestureScope(window)` opens a scope on capture-phase `pointerdown`, `mousedown`, `pointerup`, `mouseup` and `click`, and the canvas's `arm` opens one when it prelaunches the flow tween. While a scope is pending, store-change tells are held in a set and released together through `scheduleAfterPaint`, so the 50 ms deadline holds ([L32]); no scope opens under reduced motion. Escapes: the wrapped `flushSync` drains the hold (and the `afterGesture` queue) inside react-dom's flush and leaves the scope pending; `tellReactNow` tells unheld; `afterGesture` queues React-facing work that is an event rather than a snapshot into the same release. A scope opened again after its frame has fired re-arms with what remains of the 50 ms budget from its first open, rather than joining a release that would land a frame late or starting a fresh deadline. A throwing callback in the release no longer strands the rest: every held tell and queued callback runs, and the first error is rethrown. A `useState` setter inside a store subscription bypasses the hold, and the lint now refuses that shape too (except under `afterGesture`); five such sites were moved through the door. The app-test harness's `click()` resolves only once no scope is pending (`isGestureScopePending` on the test surface). `transferFocusForActivation` skips its `flushSync` when `mayDeferCommit` proves the incoming card already on screen. **(verified, read from the code; unit-tested in `gesture-scope.test.ts`, `after-paint.test.ts` and `react-door.test.ts`)**

**[F09] The hold costs an ordinary click one frame on store-driven appearance, and nothing on a control's own state.** Arc tree `e66b19b3e`, app-test bundle (production `vite build`), three gallery cards in three panes, frames every 17 ms in both settings, 6 samples per cell, `tests/app-test/zz-probe-click-latency.test.ts`; bypass is `--tug-motion: 0` inline, the switch `GestureScope.open` reads. A click that activates its card paints the pane's `data-focused` at median 21–22 ms with the hold on and 11–12 ms bypassed; a checkbox's own `data-state` in an already-active card paints at 5 ms on and 7 ms bypassed. `PerformanceEventTiming` cannot see this: it ends at the first paint after the handlers, the very paint the hold moves React past, and it times trusted input only. The scope was not narrowed: the frame lands on activation, which is the gesture that can launch motion. **(verified, measured; a list row's selection did not read and is unmeasured)**

**[F10] A pane press raises in its own task.** Since `68328270c`, the pane-chrome press keeps its React commit deferred, and two synchronous store subscribers write each shown frame's inline `z-index` (`pane-raise`, in `deck-canvas.tsx`, revealing a raised frame's occlusion stamp) and `data-focused` (`pane-focus`, in `pane-focus-controller.ts`) in the commit's own task. `tests/app-test/at0672-pane-press-raises-in-its-task.test.ts` reads the standing in the press's task: red against the code before (the pressed pane at z 1 under its neighbour's 2), green after. **(verified, measured)**

**[F11] What still blocks the lead is the engine's compositing, not a commit.** Release `110da4701` (carries `85f697274`), the user's `release-main` deck, not freshly launched; census 15256 elements, 1206 stacking contexts, 5138 render-layer candidates, 9 panes; 16 clicks between two session rows with the press and the release in separate tasks. The press task is 9.9 ms with no commit; the release task 11.8 ms. The first frame lands at 8–40 ms, and the next two frames run 45–157 ms each. Callbacks fill 17–23 ms of the first (deferred React tells, ~22 ms per click across the lead) and 7–12 ms of the second (the transcript's Z0-gutter `recompute` in `session-card-transcript.tsx`, a forced layout). A native sample (`--sample`, census 16802 elements / 1296 stacking contexts / 5578 candidates) puts the rest in WebContent's main thread, ~369 ms busy per click: compositing first (187 samples, led by `RenderLayerCompositor::computeCompositingRequirements` and `RenderLayer::convertToLayerCoords`), then layer commit 74, script 73, rendering update 71, style 67, layout 32, paint 26; the GPU process draws ~283 ms per click. Ranked by cost: compositing over the deck's layer candidates; GPU drawing of the repaint; the deferred tells in the first long frame; the gutter measure's forced layout. None was fixed: the first two are structural, the third is the hold as designed, and the fourth is a layout the frame pays anyway. A reading on a live deck has to check rest first: a first run during another session's streaming saw ~42 commits per click that were that session's feed. **(verified, measured; frame and lead numbers perturbed by the recorder and the sampler)**

**[F12] A fold's heights are computable at `arm`; its far side is not, so the fold does not launch before React.** Every frame's heights on both sides of a fold are known from the store: a folded member is height-pinned at its card type's folded tier (`min === max`, so the pane's chrome measurement cannot move it), and an open member's height is `columnAllocationOf(state, slot, run)` — the store's shares, floors and weights over the column run the deck last measured and holds — or the whole run in an undivided column. But the fold's target is not only geometry. `data-folded` is rendered by React on the frame (`tug-pane.tsx`), the session card's interior CSS and its own `data-fold` key on it, and the Last pass detects a fold crossing by that attribute changing between First and Last. A pre-launch holds React's commit past the first painted frame — that is what makes it a pre-launch — so the interior would flip, and the observers and notifies answering it would land, after the edge had started moving: the 30–47 ms hole under the tween that `FOLD_PREPARE_MS` was added to keep out. Launching earlier would move the stall rather than remove it, so the fold stays where it is and the prepare beat stays. What would qualify it: the far side's interior form written in `arm` from the store (the fold flag and the card's terminal state as DOM writes rather than renders), so that nothing the edge sweeps over waits on a commit. At `f720a4e43`, alone: `at0622` 8/8; `at0654` 1/5 as it stood — the fold's unfold gap 2.29 frames against its 1.5 bar. **(verified, read from the code; the hole's size is `FOLD_PREPARE_MS`'s own recorded reading, not re-measured)**

---

## Decisions {#decisions}

**[B01] The goal is a click task that contains no React commit, for the flow slide first.** The flow slide is the gesture with a tween already launched in the task (`[F02]`), so every millisecond taken out of the task shows directly as an earlier first frame, and `tugtool deck motion slide --tasks` already reads it. The bar is the one `briefs/graphics-animations-asks.md` set: lead at most one frame from the gesture. Other gestures follow only once they launch before the commit, which is not this work.

**[B02] Each synchronous commit is traced to the store update that caused it before anything is changed.** `[F05]` names components, not causes. The first act is to extend the reading so each commit in the click carries its duration and the store notify (or `setState`) that scheduled it; the costliest are then taken out in order. This is the rule the flow-slide briefs held to and it stays: nothing is designed against an unattributed cost, and no reading is written by hand.

**[B03] The deferral becomes a property of the gesture rather than of each store.** Five opt-in call sites (`[F03]`) is how a sixth store goes unnoticed. The direction is one gesture scope that a discrete input opens, inside which every store's React-facing notify is held and released together after the next painted frame, with synchronous DOM subscribers still told inline — the split `DeckManager.notify` already makes, generalized. The exact shape is the arc's to design from `[B02]`'s reading; what is decided here is that the fix is one mechanism, not a sixth and seventh call to `scheduleAfterPaint`.

**[B04] The focus contract is kept, and is satisfied without a synchronous commit where the DOM already allows it.** `[F04]`'s `flushSync` exists so focus never lands on a hidden element. Where the incoming host is already on screen the existing `deferCommit` path proves it is unnecessary; the work is to widen the cases that can prove it, not to weaken the check. A case that cannot prove it keeps the synchronous commit and is recorded as a known cost.

**[B05] Every release of held notifies carries a deadline.** The after-paint door's 50 ms bound ([L32], [L33]) carries over to whatever replaces it: a window whose frames are suspended still tells React.

**[B06] A change lands only with a before-and-after reading from the verb, and the settle app-tests green or no redder.** `tugtool deck motion slide --tasks` on a freshly launched release deck, with build sha and census recorded (flow-slide-remainder `[B05]`). `at0622` and `at0654` are run alone for the comparison.

---

## Open Questions {#open-questions}

- **Which commit carries the 48 ms?** *Answered by the gesture scope, not by narrowing.* The reading found 8.0 commits in the click task, 21.7 ms of React and 39.3 ms of span between them, shared rather than carried by one; the door took all of them out (`[F07]`).
- **Can a held React notify be observed by code later in the same task?** *Yes, and every reader gets a flush.* The wrapped `flushSync` drains the hold, `tellReactNow` tells unheld, and focus transfer keeps its flush wherever `mayDeferCommit` cannot prove the card on screen (`[F08]`). The harness's `click()` waits for the scope to release, so a test reads the committed DOM.
- **Does React's own scheduling offer the hold?** *No.* react-dom enqueues every `useSyncExternalStore` change at SyncLane, and a transition render is not ordered after the paint, so the hold is the door's own (`[F08]`).
- **What opens a gesture scope?** *The capture phase of the five pointer and mouse events, and the canvas's `arm` when it prelaunches the flow tween,* so keyboard- and `tugtool`-driven slides are held the same way (`[F08]`).

---

## Non-goals {#non-goals}

- **The Beat primitive and its lint.** It would inherit the same late first frame if built on the current dispatch; it comes after this.
- **Launching other gestures before the commit.** Fold, arrival, departure and the rest need their target geometry computed without the DOM (`[F06]`), which is its own work.
- **Making the commits cheaper as the main route.** Narrowing a 907-fiber commit helps and may fall out of `[B02]`, but a cheaper commit in the task is still a commit in the task.
- **Loosening any frame bar.**
- **Readings written by hand.** If the verb cannot take the reading, the verb is extended.

---

## Exit {#exit}

**An arc.** It starts by extending `tugtool deck motion slide --tasks` so each commit in the click carries its duration and its cause (`[B02]`), and takes that reading on a fresh release deck. From it: design the gesture scope (`[B03]`) against the stores the reading names, settle the open questions about same-task readers and React's own scheduling, widen the focus transfer's deferral (`[B04]`), and land each change behind a before-and-after reading (`[B06]`).
