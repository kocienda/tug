<!-- brief-skeleton v1 -->

# The settle fixup pass: re-derive the deferred-commit invariants, gate the instruments, bar every behaviour

**Purpose:** The `motion-before-react` arc made one architectural change — the deck's React commit now lands after the next painted frame — and did not re-derive three invariants that earlier repairs inside the settle assumed a synchronous commit. A 360° audit of the code against the original ask found the foundation sound and six defects that must be closed before the Beat primitive is built on it, and found that seven of the ask's eleven behaviours have no frame-level bar at all. This brief pins what was found and decides the one fixup pass that closes it.

---

## Purpose {#purpose}

The original ask (`briefs/graphics-animations-asks.md`) was for "a *system infrastructure* … a judder-free foundation for excellent animations, silky smooth transitions, and rock-solid consistency," and an end to "the age of one-off fixes." The sketch that answered it named five concepts, the first being *motion before React*: launch the tween from the store subscriber and let React commit under a frame that is already moving.

The arc built that for the flow slide and shipped it under [D204]: the deck store's React notify, the responder chain's fan-out, and the unbound Session card's picker present all leave the gesture's task through one after-paint door; the Layout card subscribes to what it draws; the flow offset is written on its readers. The bench moved from a 56 ms first frame to 12, and a warm flip now costs the click task 4–5 ms.

Then the user asked for the audit: "Determine if the changes are actually good, not just the plan in the abstract. Confirm that code adheres to the tuglaws. Confirm that this new architecture sets us up for the future. Do we need to make fixups? Or can we move on from here with confidence?"

The answer was: the direction is right, the core is a foundation, and we cannot move on yet. The deferral changed when the DOM the settle reasons about is committed, and three places in the settle still reason as if it were committed on the arm's own tick. Beside those, two focus paths were opened by an option used outside its stated precondition, and the instruments shipped to find all of this are themselves unbounded and run inside the window they measure. This pass closes that list, and it gives every behaviour the ask named a bar it can be held to.

---

## Evidence {#evidence}

### The one change, and the three invariants it broke

**[F01] The deck's React commit now lands one painted frame after the store write, on every commit that does not pass through `transferFocusForActivation` without `deferCommit`.** `deck-manager.ts` `notify` tells `subscribeSync` subscribers inline and schedules every other subscriber through `scheduleAfterPaint` (`lib/after-paint.ts`: rAF, a zero timer inside it, a 50 ms deadline behind). `raiseCard` passes `deferCommit: true`, so the activation path defers too. A fold, a close, a sidebar hide, a column flip, a slot move: all deferred. **(verified, read from the code)**

**[F02] Invariant one — "nothing paints in between" the arm's cancel and its restore is now false, so every retarget double-hops.** `deck-canvas.tsx` `arm`, third pass (~line 4788): an interrupted tween is cancelled `hold-at-current` (which commits the mid pose inline), the frame is measured, then `running.restores` and `clearFlip` remove the residue and the transform on the same tick, under a comment that says nothing paints between. Under [F01] the React commit is a frame away, so the frame paints once at the *interrupted* settle's end pose with no tween on it; the deferred Last pass then measures Last, inverts from the mid pose First, and tweens to the new end. The eye sees mid → old end → mid → new end. The bench is blind to it: the frame carries no effect on that tick, so the off-curve classifier has no curve to compare against. Every non-activation gesture that lands mid-settle takes this path. **(verified by reading; not yet reproduced on the bench — [B08] builds the leg)**

**[F03] Invariant two — the prelaunch predicate assumes every measured arm has been rendered.** `arm` decides a commit is a pure flow slide by `sansOffset` unchanged, no size change, no running tweens and no pending arrivals (`deck-canvas.tsx` ~4527). Two commits in one task produce two synchronous arms and one deferred React commit. A measured first arm followed by a flow-only second arm passes the predicate (no tween exists yet — the Last pass has not run), takes `measure = false`, and `firstRects.clear()` discards the first arm's First rects; the coalesced Last pass finds nothing to plan and everything the first commit moved cuts. `hideSidebarRail` (N notifies in one task) and the flow retune that follows a rail retune (`_retuneFlowOffset`) are the shapes. **(verified by reading)**

**[F04] Invariant three — an arriving frame's pending mark is dropped when its effect is created, not when its beat begins.** `runBeat("arrive")` deletes from `pendingArrivalsRef` at effect creation, which since beats are created up front with delays is synchronous inside the Last pass, before the `room` beat has begun. A retarget during `room` (close a card while another is arriving, the [P08] case of the pipeline brief) finds the arriving frame unprotected: `hold-at-current` commits the underlying `opacity: 0`, `running.restores` puts the pre-hold opacity back, and the card pops to full opacity with no arrival. The doc on `pendingArrivalsRef` still describes the old chained behaviour. **(verified by reading)**

### The deferral has a hole a class wide

**[F05] A synchronous-door consumer that writes another store with React subscribers pulls the deck's whole commit back into the click task.** `cards-selection-store.ts` `attachLayoutSelectionToDeck` rides `subscribeSync` and calls `selection.pickOnly(fr)` on every first-responder flip to a content card; the canvas subscribes to that store. When its "a selection stands" bit flips, the canvas re-renders inside `transferFocusForActivation`'s `flushSync`, reads the deck's *new* snapshot (React reads `getSnapshot` on render regardless of notify), and runs the Last pass in the task. The bench shows it on the plain leg: `canvas-render` at 1 ms, `last-pass` at 5–11 ms, inside the flush. Deferring the store's notify is not a guarantee; any component that renders for another reason in the same task renders the new deck state. **(verified: read from the code and read off `at0622`'s click-task marks)**

### The doors

**[F06] `raiseCard` passes `deferCommit: true` unconditionally, and two of its three callers cannot satisfy the option's precondition.** The option's own doc (`focus-transfer.ts` ~789) says it is "only for a caller whose incoming card is already mounted and displayed." `focus-session-card` (`action-dispatch.ts`) into a parked workspace calls `activateSpace` then `raiseCard`; the layer's `data-space-shown` is written by React from the snapshot — now the deferred commit — so `applyBagFocus`'s `.focus()` lands under `visibility: hidden` and is a silent no-op, then step 6 blurs the outgoing card and focus falls to `body`. `raiseCard` on a card that is a non-active tab of its pane has the same shape through the tab's `display: none → contents`. `test-surface.activateCard` is the same shape and is called by app-tests. `measureFocusClaim` records the miss and nothing surfaces it — an [L31] silence. No app-test covers either path. **(verified by reading; no reproduction yet — [B09])**

**[F07] The deferred picker present does not re-check first responder.** `session-card.tsx` parks `presentSheet` on `scheduleAfterPaint` when the card is not arriving and motion is on; `presentSheet` re-reads only its own latch and the fold. `activateSpace` ends by activating the remembered card, and `focus-session-card` then raises another in the same task; if the remembered card is an unbound Session card its sheet drops one frame later onto a card the user is not looking at — the sibling-covering "reload symptom" the code's own comment at ~1125 forbids. Any two activations inside a frame do the same. `pickerHostLiveRef` covers unmount only, and is set false in a `[]`-deps layout-effect cleanup without ever being set true, which is latent under StrictMode. **(verified by reading)**

### The instruments

**[F08] Forty-one unconditional `performance.mark` sites, none ever cleared.** User Timing marks are exempt from the entry buffer limit and persist for the document's life. `tug:button-render` fires on every `TugButton` render, `tug:pane-render`, `tug:card-host-render`, `tug:session-render` and `tug:canvas-render` per component render, and `deck-manager.ts` allocates a `tug:sync:<label>` pair per synchronous subscriber per commit; `action-dispatch.ts` queues a microtask and a zero timer per action to place two more. A streaming Session card re-renders its buttons continuously; a day-long window accumulates hundreds of thousands of entries and every `getEntriesByName` becomes a linear scan. Full list: `focus-transfer.ts`, `action-dispatch.ts`, `deck-manager.ts`, `deck-canvas.tsx`, `focus-manager.ts`, `responder-chain.ts`, `responder-chain-provider.tsx`, `host-menu-state.ts`, `card-host.tsx`, `tug-pane.tsx`, `session-card.tsx`, `tug-button.tsx`. The three arm-phase marks the last step added (`tug:arm-measured`, `tug:arm-episodes-end`, `tug:arm-planned`) are not in the bench's `clickTaskMarks` list, so the bench cannot read them. **(verified by grep)**

**[F09] The React commit census in `index.html` walks the fiber tree inside every commit for every user.** `onCommitFiberRoot` runs synchronously in React's commit phase; the census prunes by `f === o` and then does a name resolution, a Map upsert and a regex per performed fiber, on every commit including the ones inside the settle window. It is ungated in the built bundle. `window.__tugTestMode` is injected at document start by the harness user script (`TestHarnessUserScript.swift`), before this inline script runs, so gating is one line with no ordering risk. **(verified by reading)**

**[F10] The in-product settle-frames pump forces a style flush per frame inside the window [D9] says is compositor-only.** `startSettleFrameRecord` runs a rAF loop on every settle for every user; each tick's `sampleSettleFrame` does `getAnimations({subtree: true})`, `getKeyframes()` per effect and `getComputedStyle` per shown frame. Its sibling records (`layer-render`, `space-switch-frames`) are gated on a trace kind; this one is not. `settle-frame-probe.ts`'s own header says "it is a BENCH PROBE, not a product surface … nothing arms it on load," which the product use contradicts. **(verified by reading)**

**[F11] `isTugMotionEnabled()` is a `getComputedStyle` read now sitting in every store commit and every chain notify.** `scale-timing.ts` resolves `--tug-motion` off the document element; called from `deck-manager.ts` `notify`, `responder-chain.ts` `incrementAndNotify`, and the picker present. Inside the click task something is always dirty — `syncFirstResponderDomAttribute` runs immediately before the chain's notify — so the arc added a synchronous style flush to the two hottest paths it was thinning. The signal is already tracked by the motion observer's media-query listener and by `body[data-tug-motion]`. **(verified by reading)**

**[F12] Two shipped constants still wear probe names with a kill switch.** `PROBE_DEFER_REACT_NOTIFY` (`deck-manager.ts`) and `PROBE_PRELAUNCH_FLOW` (`deck-canvas.tsx`) are `true`, documented as "step-1 probes," and if flipped change the semantics of `deferCommit`, `flushPendingNotify` and the prelaunch together. `PROBE:` tags stand on `subscribeSync`, `flushPendingNotify`, `_scheduleDeferredNotify`, `sansOffset`, and `deferCommit`. [D204] records the deferral as decided. **(verified by grep)**

### What the bench conclusions understated

**[F13] The settle is not one mechanism.** The flow slide is planned by `arm` (the prelaunch) when pure and by the Last pass otherwise, and a retarget crosses between them. A departing rail does not ride the `depart` beat: its ghost's slide is launched at plant time on its own clock with `snap-to-end`, unconditional on the generation, written to survive per-commit Last passes that the coalesced commit no longer produces. The arriving state is kept in three places: `data-arriving` in the store, `pendingArrivalsRef`, and a `settleTweensRef` entry with empty `anims`. `dispatchImposerSettleStart` has no callers. A Beat primitive built on this inherits the seams as primitive semantics. **(verified by reading; the four audit reports agree)**

**[F14] Motion before React is built for the flow-only slide alone.** The fold's `markFoldCrossing`, `markStillCrossing` and opening-pose writes all run in the Last pass after React's commit; the arrival, the bullseye, the slot move and every other gesture plan and launch there too. The sketch's first concept, "the rule for every gesture rather than the fold's fix," is delivered for one gesture. `session-fold-first-frame-brief.md`'s [B01]–[B03] are not built. **(verified by reading)**

**[F15] There is a second standing [D9] violation the doctrine does not name.** Width over the scale cap (`MAX_FLIP_SCALE_DISTORTION`, 0.2) — bullseye enter and exit, the Wide presets, a rail split — tweens real `width` keyframes with the subtree re-wrapping every frame (`pane-flip.ts` says so in its header). The doctrine's worked example still says width crosses as `scaleX`. No `at0622` leg exercises a width-bearing gesture, so the runtime guard has never been shown to report `:width`. **(verified by reading)**

**[F16] The four-up plain leg's red is fixture cost; the warm flip's residual is product cost.** The plain leg first-activates an unbound Session card, whose picker mounts inside the window as a cascade of six commits plus a 432-fiber row commit — a cost a real deck pays once per unbound card at launch. The warm flip (both pickers standing) reads a 4–5 ms flush and a 9 ms first tick, and its remaining 27–48 ms gap is one 917-fiber deck commit re-rendering all four panes' title bars (44 Radix poppers) on a commit that changed one pane's focus and the strip offset, plus the picker forms re-rendering five times. The first is real-deck cost; the second is the fixture's. **(verified: `at0622` warm-flip reading and commit census, 2026-09-29)**

### The ask's eleven behaviours, and what holds each

**[F17] Four behaviours have a frame-level bar; seven have a behaviour test or nothing.** Read from the test corpus and the results ledger:

| Behaviour (from the ask) | Frame-level bar today | State |
|---|---|---|
| Flow slide, card offscreen into view | `at0622` four-up/eight-up, `at0621`, `at0624` | four-up RED (2.2–2.9 fr vs 2) |
| Fold / unfold | `at0622` fold leg (1-frame bar), `at0563` | RED (18–19 ms vs 17; 11–12 ms before the arm, unattributed) |
| Layout imposition in split columns, heights | `at0622` column leg, `at0566`, `at0605` | `at0566`, `at0605` RED (pre-existing) |
| Workspace switch | `at0643`, `at0640`–`at0644` | `at0643` flaky (26 ms vs 20 budget) |
| New card appear / disappear | `at0571`, `at0582/3` (rect and inertness, no gap bar); body handoff only a `zz-` probe | no gap bar |
| Go to slot | `at0466` (behaviour) | no bar |
| Bullseye in / out | none | no bar |
| Sidebar hide / show and content moves | `at0231`, `at0501` (behaviour) | no bar |
| Resize sidebars to fit | `at0544` (behaviour) | no bar |
| Pulsing dot, wave, caret never drop a frame | `at0629` (rest count and cost, dot only), `at0645` never recorded; wave and caret have no bench | no per-loop bar |
| Extraneous activate/deactivate animation | removed under [D203] | delivered |

The fold's missing 11–12 ms fall *before* the arm, between the dispatch and the store commit, where no mark stands and where the arm-phase marks cannot reach. **(verified: test files read, `apptest_results` ledger read through `just db-inspect`)**

### Documents

**[F18] Five briefs carry decisions retired without a banner, and the doctrine describes a settle that no longer exists.** `workspace-switch-quiet-brief.md` is dead in full (every mechanism deleted by `8a4fd3687`, `at0620` keeps its stale name); the pipeline brief's [B07] relevance hold was removed by `3e15bd032` and [D9] still names the clause; `session-fold-frames-brief.md` [B03] (fold by transform) was retired by measurement; `session-fold-chord-and-motion-brief.md` [B04]–[B07] were superseded by the still-interior brief; `session-body-first-frame-brief.md` was never started. `animation-doctrine.md` lines 269 and 307 say `fill: 'none'` where the first beat ships `backwards`, and describe the flow slide as launched from the Last pass. [D204] attributes the reduced-motion stand-down to `lib/after-paint.ts` (it lives in the callers) and does not mention the probe constant. **(verified by reading)**

---

## Decisions {#decisions}

### The three invariants, re-derived

**[B01] A retarget is never deferred.** When `arm` finds a running tween in `settleTweensRef`, the React commit it is about to hand off must land on the arm's own tick, so the third pass's restores and `clearFlip` are followed by the Last pass before anything paints. The mechanism: `arm` calls `store.flushPendingNotify()` after its measurement when it cancelled anything, which flushes the deferred notify synchronously and lets React commit inside the task exactly as it did before [D204]. The alternative — leaving the residue on and moving the third pass into the Last pass — was considered and rejected: it changes what First measures on the next retarget and reopens the stale-size flash the third pass was written to close. The cost is that a retarget pays the commit in-task, which is the price a retarget always paid; the deferral's win was for the first gesture, and it keeps it. Closes [F02]. Revisit only if the Beat primitive gives the arm a way to plan a retarget from the store delta without the DOM.

**[B02] "Pure" means nothing measured and unrendered.** The prelaunch predicate gains the clause `firstRects.size === 0` — a measured arm whose Last pass has not consumed its rects forbids a prelaunch — and a second arm in one task that finds rects standing takes the measured path and re-measures. `firstRects.clear()` moves under `measure` so a prelaunch never discards a pending measurement. Closes [F03]. This is also the definition the Beat primitive will need: a beat planned from the store delta is only valid when no beat is waiting on the DOM.

**[B03] The arriving frame leaves the pending set when its beat begins, not when its effect is created.** The delete in `runBeat("arrive")` moves inside `whenBeatBegins`'s `begin`; until then a retarget's arm treats the frame as arriving (no First rect, hold kept, no restore). The `pendingArrivalsRef` doc is rewritten to say so. Closes [F04]. The reduced-motion Last pass with a pending arrival, which today leaves the hold to the sweep for up to a second, releases the arrival's hold on its early return.

### The deferral's hole

**[B04] A synchronous-door subscriber may not notify React in the same task; the cards selection store's fan-out takes the after-paint door.** `attachLayoutSelectionToDeck` keeps its synchronous read of the deck (it needs the flip's edge) but the write it makes to the selection store — the one React subscribes to — is scheduled through `scheduleAfterPaint`, coalesced, with the same reduced-motion stand-down the other three deferrals have. The rule is written into [D204] as its fourth part: the synchronous door is for DOM writers and for readers of the flip's edge, and anything on it that reaches React does so through the same door React is told through. `selection-guard`, `deck-trace`, `test-surface` and the canvas's own `arm` are audited against this rule in the same change and found to write only DOM or their own records. Closes [F05]. The bench pins it: on the plain leg, `tug:last-pass` must read after `tug:react-notify`, never inside the flush.

### The doors

**[B05] `deferCommit` is computed, not defaulted, and its precondition is asserted.** `raiseCard` passes `deferCommit` only when the incoming card is its pane's `activeCardId` and its space is the shown space; otherwise it flushes as every other activation does. `transferFocusForActivation` records a `focus-claim-hidden` trace row when `applyBagFocus` targets an element under a hidden layer or a `display: none` tab, so the miss is never silent ([L31]). Closes [F06].

**[B06] The deferred picker present re-checks that the card is still first responder at the door.** `if (getDeckStore()?.getFirstResponderCardId() !== cardId) return;` before `presentSheet()`, alongside the existing latch and fold checks. `pickerHostLiveRef` is set true on mount and false on unmount in one layout effect. Closes [F07].

### The instruments

**[B07] Every mark, the census and the settle-frames pump stand behind one gate, and marks are cleared at each arm.** A `mark(name)` helper in `lib/perf-marks.ts` is a no-op unless `window.__tugTestMode` or the deck trace is enabled; every `performance.mark("tug:…")` call goes through it; the four per-render marks and the per-subscriber `tug:sync:*` pair are removed outright (the bench never read them as counts). `armSettleFrameProbe` and `arm` call `clearMarks()` so a leg's timeline is its own and `origin` is unambiguous. The `index.html` census is gated on `window.__tugTestMode`. The in-product settle-frames pump is gated on the `settle-frames` trace kind like its siblings; the row the product records at rest is the release's own bookkeeping (start, end, generation), not a per-frame sample. `isTugMotionEnabled()` reads the cached flag the motion observer already maintains, never computed style. The `PROBE_*` constants and tags go; the doors are named as product and cite [D204]. Closes [F08]–[F12].

### The bench

**[B08] Every invariant in [B01]–[B04] has a leg that reads it, and the plain leg becomes a warm flip.** Four legs join `at0622` or a sibling: a retarget leg (a second flow slide dispatched at 140 ms, then a fold interrupted by a close) that asserts every shown frame's rect on the tick after the second gesture lies on the first tween's curve or the second's, never at the first's end pose; a two-commit-task leg (`hideSidebarRail` with two members) that asserts every moved frame carries a tween; an arrival-interrupted-by-close leg that asserts the arriving frame's computed opacity never reads 1 before its arrive beat begins; and a `last-pass`-after-`react-notify` assertion on the activation leg. The pinned bar leg becomes the warm flip (the user's all-day gesture), and the cold first activation stays as a `note()`. The three arm-phase marks join `clickTaskMarks`, and a mark at `setPaneFolded` entry closes the fold's 11–12 ms gap before the arm.

**[B09] Every one of the ask's eleven behaviours gets a frame-level bar, and the bar is the same bar.** The bar is the settle-frames row's: lead at most one display frame from the gesture, no gap over two frames across the beat (one for a fold, whose window is the whole motion), zero off-curve ticks, no rect change after landing, tick count above the suspension floor. The seven behaviours without one get a leg that drives the real path and reads the row:

- **New card appear / disappear** — `addCard` into a split column and `removeCard` from it, read across `room` + `arrive` and `depart`; the `zz-` body-handoff probe is promoted or deleted.
- **Go to slot** — `go-to-slot` across the band, both directions.
- **Bullseye in / out** — `toggle-bullseye` on a card in a four-up flow deck; this leg also asserts the runtime guard reports `:width` and nothing else, the way the column leg asserts `:height`, so [F15] is named by a test rather than a comment.
- **Sidebar hide / show and the content moves after** — `hide-sidebar-rail` and its reverse with two members, read across the whole choreography including the rail's exit.
- **Resize sidebars to fit** — the settled-resize retune after a window resize, read from the retune's commit.
- **Pulsing dot, wave, caret** — a per-loop bar: with a dot, a wave and a focused caret running and nothing else, the render-cost probe reads no main-thread rendering update over the floor across 120 frames, per loop, not only the dot; `at0645` is recorded through `just app-test` so a ledger row exists.
- **Workspace switch** — `at0643`'s budget is held to the same bar as the rest rather than its own 20 ms, and the flake is read three times before it is called jitter.

A behaviour whose leg is red at landing stays red and is named in the findings paper; a bar is not loosened to go green.

### The seams

**[B10] The departing rail rides the `depart` beat, and `dispatchImposerSettleStart` is deleted.** The rail exit's own clock existed to survive per-commit Last passes; under the coalesced commit there is one Last pass and the race is gone. Folding it into the chain removes the one animation unconditional on the generation. The arriving state's three records are reduced to two — the store mark and `pendingArrivalsRef` — by dropping the empty-anims `settleTweensRef` placeholder in favour of the pending set. Closes the seams [F13] names that this pass can close; the prelaunch stays as the first instance of a store-planned beat, which the Beat primitive then generalises rather than replaces.

### The documents

**[B11] The doctrine and the decisions are brought to the code, and the dead briefs are bannered.** `animation-doctrine.md` worked example 2 gains the flow-only pre-commit launch and the after-paint notify, and says `backwards` on the first beat; [D9] names the width-over-cap tween as its second standing hit and records the relevance hold's retirement; [D204] gets the fourth part from [B04], the correct file attributions, and loses the probe constant. `workspace-switch-quiet-brief.md`, the pipeline brief's [B07], `session-fold-frames-brief.md` [B03], and `session-fold-chord-and-motion-brief.md` [B04]–[B07] get a superseded banner naming what retired them. `session-body-first-frame-brief.md` is bannered as waiting on this pass. `at0620` is renamed for what it still tests.

---

## Open Questions {#open-questions}

- **Whether [B01]'s flush is the right fix for a retarget in the long run, or whether the Beat primitive should plan a retarget from the store delta.** The flush restores the pre-[D204] behaviour for retargets and is correct today; a store-planned retarget would keep the commit out of the task but needs the arm to know Last without the DOM, which is the Beat's open design. This pass takes the flush and records the question for the Beat's brief.
- **Whether the pane title bar's 917-fiber re-render on a focus flip is this pass's or the next.** It is the largest remaining product cost in the warm flip and it is [D204]'s grain rule applied at the pane; it is not a defect of the deferral. This brief leaves it to the step program's next item so the pass stays a fixup pass, but a reader who finds it cheap to do beside [B04] should say so at the door.
- **Whether a bound-card bench fixture is needed for [B09]'s bars or the unbound fixture with a warm flip is enough.** The picker cascade is fixture cost; a bound fixture reads the deck the user has but makes every leg depend on tugcast. The warm flip removes the cascade from the bar leg without that dependency. Take the warm flip now; open the bound fixture as its own question when the eight-up scaling clause needs it.

---

## Non-goals {#non-goals}

- **The Beat primitive and its lint.** They are the step after this one, and this pass exists so they have one engine to be the API of. Nothing here adds an abstraction above `animate()`.
- **The pane-chrome grain (`useStoreDerived` at the pane).** A cost, not a defect; next item in the step program.
- **Loosening any bar to go green.** `at0622`'s four-up and fold legs, `at0566`, `at0605` and `at0643` are red on real readings; this pass adds bars and pins invariants, and a red that survives it is a finding for the findings paper.
- **Removing the instruments.** They found everything in this brief. They are gated, cleared and named, not deleted.
- **Moving the third pass into the Last pass as the fix for [F02].** Rejected under [B01]: it changes what the next retarget measures and reopens the stale-size flash.
- **A `departing` mark that keeps the real frame mounted through its fade.** Still the right end state for the ghost (doctrine, "The ghost's contract") and still deferred; [B10] moves the rail's ghost onto the beat clock, which is the smaller change.
- **Height by translation and occlusion.** Measured and retired in step 4; the fold keeps its real height term and the still crossing.

---

## Exit {#exit}

An arc. Its first steps, in the order the dependencies run: the three invariants ([B01]–[B03]) with their bench legs from [B08] landing beside them, because every later reading is taken against a settle that must not double-hop; then the deferral rule ([B04]) and its `last-pass`-after-`react-notify` pin; then the two doors ([B05], [B06]) with a test for the parked-workspace and background-tab activations; then the instruments ([B07]), which changes what every bench leg after it can read; then the seams ([B10]); then the seven new bars ([B09]) one leg at a time, each red or green on its own reading; and last the documents ([B11]) written from what the legs read rather than from this brief's expectation. The findings paper gets a "Step 7" section with the before-and-after of every leg, so the next reader starts from numbers.
