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

- **Which commit carries the 48 ms?** Settled by `[B02]`'s reading. If one 907-fiber commit is most of it, the first fix is narrow; if the six share it, the gesture scope (`[B03]`) is the first fix.
- **Can a held React notify be observed by code later in the same task?** A handler that mutates a store and then reads React-rendered DOM in the same task would read the old DOM. The deck store's deferral met this in focus transfer (`[F04]`) and in the settle's retarget. How many other readers exist across the other stores is not known; the gesture scope has to find them or offer them a flush.
- **Does React's own scheduling offer the hold?** Marking the updates as transitions, or keeping them out of the discrete-event lane, might do what a hand-rolled hold does. Whether `useSyncExternalStore` updates can be deferred that way at all — they are synchronous by design — is to be confirmed before choosing.
- **What opens a gesture scope?** The click's capture phase, the store mutation, or the settle's `arm`. It decides whether keyboard-driven activations and `tugtool`-driven ones get the same treatment.

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
