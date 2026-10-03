<!-- brief-skeleton v1 -->

# After the gesture hold: fixups, the unattributed lead, and the fold

**Purpose:** The gesture scope took React out of the click's task and the flow slide's first frame came in from 26–49 ms to 14–28 ms. A second audit found the mechanism sound but unverified across the app, with a few holes in it, a lead that is still blocked 22–48 ms with nothing named, and every gesture but the flow slide still launching after React.

---

## Purpose {#purpose}

The user asked for a second audit of the graphics work after three arcs landed (`graphics-audit-fixups` `3c6a57248`, `gesture-task-without-react` `85f697274`, `compositing-walk-and-overview` `f31ca5443`), and of its recommendations said:

> I want all of this work done. Brief this. Then I'll do the work in another session.

The recommendations were five fixups — a full app-test run with its reds classified, a gesture scope that survives a throwing callback, the popup menu's close routed through the door, a click-latency reading, the gesture-task readings written back into its brief — and two pieces of next work: attribute the remaining lead, then move a second gesture, the fold, to launch before React.

The audit was taken at `88edca520` on 2026-10-02. Typecheck, the tugdeck unit tests (9,984), `bun run audit:motion` and the tugtool `deck_motion` tests (43) pass. No app-test was run; app-test state is from `apptest_results.db`.

---

## Evidence {#evidence}

**[F01] No full app-test run has been recorded since the gesture scope landed.** The largest recorded runs after `85f697274` are 16–21 files. The scope changes the timing of every click in the app: `installGestureScope(window)` in `tugdeck/src/main.tsx` opens a scope on capture-phase `pointerdown`, `mousedown`, `pointerup`, `mouseup` and `click`, and every store-driven React update then lands one painted frame later, or at the 50 ms deadline in an occluded window. **(verified from the recorded history and the code)**

**[F02] The harness's synthetic click does not account for the hold.** `tugdeck/src/test-surface.ts` dispatches all five pointer events in one task; the capture listeners fire for synthetic events; neither `test-surface.ts` nor `tests/app-test/_harness` references the scope. A test that asserts store-driven DOM straight after a click without polling is exposed. A keyboard-synthesized click (Space or Enter on a button) opens a scope too. **(verified, read from the code; which tests are exposed is not known)**

**[F03] Recent runs on main carry reds nobody has classified.** At `89e9bfa27` (16 files): `at0541`, `at0558`, `at0605`, `at0622`, `at0626`. At `16ae6d4d1` (17 files): `at0555`, `at0559`, `at0566`, `at0594`, `at0605`, `at0654`. `at0622` passes 8/8 run alone and failed 7/8 in the 16-file batch. `at0558` and `at0559` first appear red after the every-card-folds arc (`89e9bfa27`). `at0555` was red before `88edca520` loosened its launch bound from 80 to 105 ms for the fold's prepare beat; no run of it is recorded since. `at0643` is red on first paint against a one-period bar while the switch's first paint waits on a roughly 3,900-fiber commit, and `at0654` stands 0/5 by design. **(verified from the recorded history; causes not looked at)**

**[F04] One throwing callback drops every tell behind it.** In `tugdeck/src/lib/gesture-scope.ts`, `release` and `drainHeld` copy and clear the held set and the queue before iterating, with no per-callback guard, so a throw loses every later store tell and every queued `afterGesture` body; those components stay stale until their store next changes. In the wrapped `flushSync`, `drainHeld()` runs before the caller's body in the same closure, so a throw during the drain means the body — a tab switch's `commitMutation` in `focus-transfer.ts`, for one — never runs. `pending` and `bypass` are left consistent. **(verified, read from the code; no trigger observed)**

**[F05] `open()` joins a scope whose frame has already fired.** A scope is released by rAF then a zero timer. A gesture that opens between the two — a `click` after a `pointerdown` about one frame earlier, or a keyboard-driven prelaunch — finds `pending` true, joins, and is released in the next task, ahead of its own tween's first frame. Nothing breaks; the hold is defeated for that gesture. **(verified, read from the code; how often it happens is not measured)**

**[F06] The wrapped `flushSync` drains held tells but not queued `afterGesture` work.** `tug-list-view.tsx` queues the row's `setSelectedIndex` after `delegate.onSelect`; when `onSelect` reaches a flushing path the card fronts while the previous row keeps its selected look for a frame. **(verified, read from the code; cosmetic)**

**[F07] Four sites tell React from a store without `useSyncExternalStore`, so the hold cannot see them.** `tugdeck/src/components/tugways/internal/tug-popup-menu.tsx:371` (`observeDispatch` → `setOpen(false)`, which commits in the click's task whenever a clicked menu item dispatches); `tugdeck/src/components/chrome/card-host.tsx:726` (`subscribeEngineHooksChange` → `setEngineHooksVersion`); `tugdeck/src/components/chrome/tug-banner-bridge.tsx:33` (connection state → `setState`); `tugdeck/src/components/tugways/followed-card.ts:39` (a store value copied into state from an effect, costing a second commit). [L02] forbids the shape, and `react-door.test.ts` lints imports, not this. Context-value providers were not audited. **(verified, read from the code)**

**[F08] Every click's store-driven response now waits a frame, and its cost to ordinary clicks has not been read.** The hold applies whether or not the click launches a tween. `tugtool deck motion input` reads input-to-next-paint and was not taken before or after `85f697274`. **(verified that no reading exists)**

**[F09] A partly covered pane pressed on its chrome comes forward one frame late.** `pane-focus-controller.ts` now passes `deferCommit: mayDeferCommit(...)`, so the press no longer commits in its task; pane `zIndex` and `data-focused` are React-rendered (`deck-canvas.tsx`, `tug-pane.tsx`), and the occlusion controller reads the same inline `z-index` in a post-commit layout effect. On a press-and-drag the pane travels under its neighbour for at least one painted frame before it pops forward. Drag logic reads the store and geometry and is unaffected. **(verified, read from the code; not observed on a deck)**

**[F10] The lead is still blocked 22–48 ms with no React commit left in the click's task.** From `85f697274`'s readings (release build, two session cards, sixteen clicks, fresh launch): commits in the click task 8.0 → 0.0, first frame 26–49 → 14–28 ms, lead blocked 27–49 → 22–48 ms. The verb dispatches all five pointer events from one task, so pointerdown's work counts in the click task. What the heartbeat still sees blocking has not been attributed. **(verified, measured; the remainder is unnamed)**

**[F11] The gesture-task readings live only in a commit message.** `briefs/gesture-task-without-react-brief.md` is unchanged since it was written: its open questions (which commit carried the 48 ms, whether React's scheduling offers the hold, what opens a scope) were all answered by the arc and none is recorded there. **(verified)**

**[F12] Only the flow slide launches before React; the fold still plans after the commit, and now holds 25 ms first.** `at0654`'s header: the fold's lead is 18 ms against a 17 ms period, 8 ms of it before the canvas armed, and the unfold's gap is 1.88–2.59 frames against a 1.5-frame bar — "the fold still plans after React commits". Since then `88edca520` added `FOLD_PREPARE_MS` (25 ms): a settle that opens a fold crossing stands at First for that long so the interior's observer writes and the after-paint React notify land before the edge moves, where they had held the main thread 30–47 ms under the tween. So the fold's first moved frame is deliberately late, and its tweens are still created in the Last pass. **(verified, read from the code, the test header and the commit)**

---

## Decisions {#decisions}

**[B01] The full app-test corpus is run once at HEAD, and every red is classified.** The user asked for it. Each red is re-run alone and sorted: caused by the gesture hold (a test asserting too early, or a real behaviour change), caused by another recent arc, pre-existing, or contention. A red the hold caused in product behaviour is fixed in the product; a test that asserted before the frame is fixed in the test by waiting on the condition, never by a sleep. `at0558`, `at0559` and `at0555` are classified by name (`[F03]`). The result is written down as the baseline.

**[B02] The harness gets one way to wait out a gesture scope.** `[F02]`: rather than each exposed test learning about the hold, the test surface offers a settle that resolves when no scope is pending, and the harness's click helper uses it. This is a harness change, so the core tier runs with it.

**[B03] A throwing callback never takes the rest of the release with it, and never skips a `flushSync` caller's body.** `[F04]`: each held tell and queued body runs guarded; the first error is rethrown after all have run, so a fault is still loud. In the wrapped `flushSync` the caller's body runs whether or not the drain threw.

**[B04] A gesture that opens after the pending scope's frame has fired gets a scope of its own.** `[F05]`: the hold exists to keep React out of a tween's first frame, and joining a scope one task from release does not. The scope knows whether its frame has fired; an `open` after that point extends the hold past the next paint instead of joining. The 50 ms deadline still bounds any one hold, and a run of gestures must not starve React: the extension is bounded.

**[B05] The wrapped `flushSync` drains the `afterGesture` queue with the held set.** `[F06]`: code that says "I need the DOM now" means all of it.

**[B06] The four store-to-state sites go through the door.** `[F07]`: each becomes a `useSyncExternalStore` read from `lib/gesture-scope.ts`, the popup menu first since it is the one on a click path. If a site cannot be expressed as a snapshot — the menu's close is an event, not a state — it uses `afterGesture`, and the reason is written at the site. Context-value providers fed from stores are audited in the same pass, and the lint grows to cover whatever shape it can detect.

**[B07] Click latency is read before anything about it is decided.** `[F08]`: `tugtool deck motion input` on the release deck for ordinary clicks that launch nothing — a button, a checkbox, a menu item, a list row — with the hold on and with it bypassed, same build. If the hold costs a visible frame on clicks that animate nothing, the scope opens only for gestures that can launch motion; that narrowing is designed from the reading, not assumed.

**[B08] A pane press raises in its own task.** `[F09]`: z-order and `data-focused` on a press are appearance the user is looking straight at, and a pane dragged from under its neighbour for a frame is a visible defect the old path did not have. The direction is [L22]'s: the raise is written to the DOM by a synchronous store subscriber, as the flow offset already is, so the React commit can stay deferred. If that proves larger than a fixup, the pane-chrome press goes back to committing in its task and the cost is recorded.

**[B09] The gesture-task brief is brought up to date.** `[F11]`: the arc's readings, its answers to the brief's open questions, and the door's design are written into `briefs/gesture-task-without-react-brief.md` as findings, with the build sha and census beside each reading.

**[B10] The remaining lead is attributed with the verb before anything is designed against it.** `[F10]`: `tugtool deck motion slide --tasks` on a fresh release deck, reading what runs in the lead now that no commit does — the click dispatch's own script, selector queries, the editor's measure pass, and the rendering update itself. The verb is first corrected so the five pointer events are not dispatched from one task, since that folds pointerdown's work into the click's. If the remainder is the engine's own style, layout or compositing, a native sample bracketed to the lead says which. What is named is recorded; fixes follow in order of cost.

**[B11] The fold is the second gesture to launch before React, if its target can be computed without the DOM.** `[F12]`: the flow slide's pre-launch is valid because its beat is planned from the store delta alone. The fold qualifies only if the folded and unfolded heights of every frame in the column are known from store state at `arm`. The first act is to establish that. If they are, the fold's tweens are created in `arm` and the Last pass adopts them, as it does the flow slide's; the prepare beat is then re-read, since the work it waits for may no longer land under the tween. If they are not, that is recorded with what would be needed, and the fold stays where it is.

**[B12] No bar is loosened, and every change lands with a reading.** `at0622` and `at0654` run alone before and after; the fold's change is read with `at0671` and with the settle probe from the gesture, not from the arm.

---

## Open Questions {#open-questions}

- **Should the hold apply to every click, or only to gestures that launch motion?** Settled by `[B07]`'s reading. It is a product call if the reading shows a cost: the user decides whether one frame on ordinary clicks is acceptable.
- **Can the fold's target heights be computed from the store?** Settled by reading the imposer's height terms (`[B11]`). A folded card's height may be a chrome constant; an unfolding card's share of a split column depends on its neighbours' tiers.
- **Does the prepare beat survive a pre-launched fold?** It was added because interior answers and the React notify landed under the moving edge. With the notify held by the gesture scope and the tween launched in `arm`, the 25 ms may be removable — or may still be what keeps the interior's observer writes out of the first frames. Settled by `at0671` and a frame reading.
- **Is `at0643`'s one-period first-paint bar reachable?** The fixups arc left it for a decision. The full run (`[B01]`) re-reads it; the bar is the user's to keep or change.

---

## Non-goals {#non-goals}

- **The Beat primitive, a raw-`animate` lint, or breaking up `DeckCanvas`.** Still real, still larger than this.
- **Launching arrival, departure, rails or split before React.** The fold is the one gesture taken here; the others follow from what it teaches.
- **The compositing walk.** Read and recorded in `briefs/compositing-walk-readings.md`; the aging reading is the user's.
- **Removing the gesture scope if the full run is red.** Reds are classified and fixed; the mechanism is measured and stays unless `[B07]` narrows it.
- **Sleeps in tests, or loosened bars, to turn a run green.**

---

## Exit {#exit}

**An arc.** The full app-test run comes first (`[B01]`), with the harness's scope settle (`[B02]`), because it says whether the hold broke anything and gives every later step a baseline. Then the scope's own fixes (`[B03]`–`[B06]`), which are small and unit-tested in `gesture-scope.test.ts`. Then the two readings: click latency (`[B07]`), which may narrow the scope and decides `[B08]`'s urgency, and the lead attribution (`[B10]`). The brief update (`[B09]`) lands once those readings exist. The fold (`[B11]`) is last and is the one piece of design: establish whether its target is computable at `arm`, and build the pre-launch only if it is.

---

## Run 4968's reds, read alone (2026-10-02) {#reds-read-alone-2026-10-02}

Every file in run 4968's fail list (434 files at `68fcd01c4`, 36 red) was run once alone at `50ebad6a8`, the graphics-audit-three-fixups tree, and sorted by `tugtool apptest history`. The full corpus was not re-run.

**Green alone (contention):** `at0019`, `at0334`, `at0335`, `at0493`.

**Red and pre-existing (last green before the hold reached main at `85f697274`, or red since before it):** `at0017` (last green `29521f696`, 08-29), `at0043` (`a6e0e37a9`, 08-28), `at0277` (no green on record; red since `e122906e8`, 10-01), `at0339` (`cc239bb76`, 08-29), `at0347` (`858a40e4f`, 08-28), `at0430` (`e88601699`, 08-30), `at0454` (`858a40e4f`, 08-28), `at0456` (`858a40e4f`, 08-28), `at0497` (`f0f227ccc`, 08-29), `at0537` (red since `8989802e3`, 09-30), `at0541` (red since `babe567f9`, 09-30), `at0549` (red since `8989802e3`), `at0559` (red since `07475295e`), `at0566` (red since `588780c5a`, 09-30), `at0571` (`7eb709553`, 09-30), `at0580` (`3bb2c7bfc`, 10-01), `at0594` (red since `184bab3d4`), `at0597` (red since `c9b4c88c3`, 10-01), `at0605` (red since `588780c5a`), `at0613` (red since `f3e47bcd9`, 09-30), `at0626` (red since `babe567f9`), `at0643` (`9cf36fd9f`, 09-30), `at0645` (`9cf36fd9f`), `at0652` (`0fab58f2f`, 10-01; red twice alone since — one rendering update over the 2 ms floor while the wave runs, an idle second the scope never opens on), `at0654` (the standing reds; see its header).

**Unclassified — no green on record, first recorded at run 4968:** `at0369` (open-file slot wait times out), `at0405` (arc lane never renders), `at0443` (no-git notice never appears), `at0561` (citation 15.6 px against 15.4), `at0631` (zoom rectangles not lit on the way out), `at0632` (two sash members still marked after release). History cannot say whether these predate the hold. A run with the hold disabled would settle it; it was not taken.

**A real defect of the hold, fixed:** `at0654`'s warm-flip pin required the activation's `flushSync` marks, and since the hold an on-screen activation commits with no flush, so the leg could never be read. The pin in `settle-frames-fixture.ts` now asserts the flush is absent.

**`at0622`:** red once alone at `50ebad6a8` on the resize-to-fit retune (2.18 frames against 2); last green `f720a4e43`. Not re-read.

**The rail-width tests, alone:** `at0677`–`at0680` green, and green alone before and after each change in the arc; `at0680` red once on the first run after a rebuild (the drag read at the floor), then 3/3 green.
