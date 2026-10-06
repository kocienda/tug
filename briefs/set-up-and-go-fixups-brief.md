# Set-up-and-go fixups

**Purpose:** The set-up-and-go arc landed as `29b69a6cb` with the right shape and five things short of done: an unread shrink on the user's deck, a land cost moved past the instrument rather than removed, two settle files red on `main`, three small holes the audit found in the code, and the workspace switch still outside the shape. This brief names each with its ending.

---

## Purpose {#purpose}

The user asked for an audit of the arc "as well as all the work that has led up to this point", against the asks in `briefs/graphics-animations-asks.md`, and then: "Do we need to make fixups? Or, can we move on from here with confidence that the codebase is in good shape?" The audit's answer was fixups, a short list on top of a sound architecture. The user ruled: "Brief these five fixups."

The architecture is not in question. The gate in `tugdeck/src/lib/gesture-scope.ts`, the land record in `tugdeck/src/lib/land-frame-record.ts`, the settled still crossing in `tugdeck/src/lib/fold-crossing.ts` and the pane-chrome cut all do what `briefs/set-up-and-go-motion-brief.md` decided, and the audit found no law broken. What is left is what stands between that shape and confidence in it.

---

## Evidence {#evidence}

All findings are from a cold read of `29b69a6cb`'s diff and the arc's own commit message, with the app-test ledger read through `just db-inspect apptest_results`.

**[F01] Nobody has looked at the user's deck since the join.** The release build at `~/Library/Developer/Xcode/DerivedData/Tug/Build/Products/Release/Tug.app` was built two minutes after the join and carries the arc. The arc's audit said plainly that the deck was never read, because the build it ran on predated the join. Every number the arc reports is from the app-test arms. **(verified)**

**[F02] A shrinking card now shows a blank band under its moving edge.** A height tween that is not a fold holds its interior at its *final* height (`settleStillCrossing`, `data-still-settled`). On a growth the extra rows sit under the clip. On a shrink the box is taller than the interior until the edge arrives, so a strip under the moving edge has nothing in it: at the top for a bottom-anchored transcript, at the bottom otherwise. The arc's audit named it and said it is settled by looking. This is the change behind the arc's largest land improvement, a seat's land from 40–48 ms to about 20 ms. **(verified in the code; unseen on any deck)**

**[F03] The land's cost was moved past the instrument, not all removed.** Taking the settled mark off re-lays the card out at the same size, about 20–25 ms on a real transcript by the arc's own reading, because `.tug-pane[data-still-crossing] .tug-pane-content` flips `overflow` from `auto` to `hidden` and a bottom-anchored root flips to `position: absolute` (`tugdeck/src/components/tugways/tug-pane.css`). The engine defers the mark-off two paints past the land through nested `scheduleAfterPaint`. The land tail in `settle-engine.ts` closes at the second tick after the release, which is the tick before that task runs, so the `settle-land` row cannot see it. The motion gate opens in the same task, so every held React tell commits in that same frame. "About 20 ms" is true of the measured frame only. **(verified)**

**[F04] Two settle files are red on `main`, each red named.** The ledger's last runs on the arc branch: `at0622-deck-settle-frames.test.ts` 10/14, `at0690-real-transcript-asks.test.ts` 1/3. The arc's commit names the five:

- `at0622` appear: an in-motion gap of 35–40 ms, down from 118 ms.
- `at0622` go-to-slot out and sidebars hide: CodeMirror's own `IntersectionObserver` forces a 3 ms layout mid-motion when a composer crosses the viewport edge.
- `at0622` bullseye enter: the transcript re-windows on every frame of its width tween. The interior hold covers the height term only (`isInteriorHeld` reads the still crossing, which a width tween never marks).
- `at0690` seat: `position: fixed` descendants in a promoted frame, red before the arc.
- `at0690` one sidebar hide: a `LayoutContent` commit inside the motion. `LayoutContent` in `tugdeck/src/components/layout/layout-card.tsx` reads `useDeckColumns`, whose subscription is one the gate does not hold, or the commit could not land there.

The brief's B09, as the user revised it on 2026-10-05, said the arc joins with `at0622` green. It did not. **(verified)**

**[F05] The hand-lift swipe is an unbarred exception.** The prelaunch survives only for `flowHandVelocity !== null`, and that path closes the gate in `arm` and then lets its own React commit through the deferred notify, which tells React with `tellReactNow` and bypasses the gate. By design ([B06] of the motion brief). No test reads the swipe with `expectMotionSealed`, so nothing is red, and the first reading that does will report a commit inside the motion as a defect. **(verified in the code)**

**[F06] Three small holes.** In `tugdeck/src/components/tugways/tug-list-view.tsx`, `settledSizeRef` is set in `onStillCrossingSettled` and cleared only by the container observer's next delivery, so a crossing whose first delivery never comes leaves it armed, and a later resize back to identical dimensions skips one pin. In `settle-engine.ts`, the gate's cap releases the hold but leaves `motionGateRef.current.release` set, so the next `openMotionGate` records a spurious `settle-gate open` row. In `land-frame-record.ts`, the geometry-getter wrappers go onto `Element.prototype` at the first arm and stay for the page's life, passing through when disarmed. **(verified)**

**[F07] The workspace switch is still outside the shape.** `at0643-workspace-switch-cadence.test.ts` was red in two of its last four runs on `main`. The motion brief's [B08] and its revised Exit say the switch is worked on `main`, outside the arc, and briefed once its decomposition is read. It has not been read. **(verified)**

---

## Decisions {#decisions}

**[B01] The user's deck is read first, and the shrink is looked at.** Every reading the arc rests on is from a test arm. Before anything below is built, `tugtool deck motion settle` runs on the user's deck for fold, unfold, division, slot, rails, sidebar and fit, with `--chains`, and a shrink is watched by eye. The numbers go into `briefs/real-transcript-motion-readings.md` beside the H4 readings they are compared against. Whether [F02]'s band is visible is a fact about a screen, and no instrument answers it.

**[B02] If the band is visible, the settled hold keeps its final height and covers the band; the hold is not reverted to the larger height.** Reverting would hand the 35–49 ms land back. The cover is the moving edge's own neighbour: on a shrink the next frame or the pane's chrome slides over the strip, which is what the still crossing's bottom anchor already does for a following transcript. The arc that walks this reads the anchor rule before choosing a cover, and the cover touches only compositor properties inside the motion. If the band is not visible, nothing is built and [F02] closes as a reading.

*Revised 2026-10-05, on the reading.* The band is visible: on a column join 576 px of bare background under the chrome at the first frame, closing over about 250 ms (`briefs/real-transcript-motion-readings.md`). No neighbour can cover it, because the chrome is 91 px tall and the column's neighbour rides the same edge. The user ruled: **a shrink holds its interior at its starting height**, as before the motion arc, so it shows no band and pays its land relayout. A growth keeps the settled hold, since its final height is its larger one, and so does every land saving it bought.

**[B03] The settled mark is made free to take off.** A hold whose removal re-lays the card out is a land paid two frames late, and the instrument's silence about it is the same blindness the motion brief's [F09] named for the old land. Under `data-still-settled`, the interior stands at the height it lands at, so the clip exists for the growth case only and the `position` flip for the bottom anchor only. The change is to make the settled hold's style delta zero on removal: whichever of `overflow` or `position` forces the relayout is kept identical between the held and the rested state, or the clip moves to a property that does not dirty layout. Then the mark comes off at the land, in the land's task, and the deferral goes.

- *Resolved during the arc, from a reading on the user's deck.* Neither candidate paid it. Holding `overflow`, `position` or both constant moved the mark-off by a millisecond at most (11–15 ms on four live panes); the cost was the held height itself, an unregistered and so inherited custom property written above the card root, whose removal restyled every element in the card. Registered non-inheriting and written on the root alone, the mark-off reads 2 ms, so the mark comes off in the land's task and the deferral is gone.

**[B04] The land tail covers the mark-off, whatever [B03] achieves.** The tail reads one more tick, or reads until the settled frames have shed their mark, so a settle whose hand-back is paid late reads as a late hand-back. A record that stops one frame short of the cost it was written to see is not a record. The `tugtool deck motion settle` verb reads the same span.

**[B05] The five reds close by the three endings, on `main`, and `at0622` and `at0690` go green.** Each has its ending:

- Appear's gap is set-up work landing in the motion. The arriving card's mount and its first layout move before the first frame, under the hold, like every other set-up cost.
- Bullseye's re-window is the width term without an interior hold. The hold the height term has extends to a width tween: a frame whose width tweens marks its interior held, the list view's observer skips the frames it already answered, and the pin runs once in the set-up.
- The `LayoutContent` commit is a subscription that bypasses the gate. Every React-facing subscription goes through `gestureScope`; the one `useDeckColumns` rides is routed through it.
- CodeMirror's `IntersectionObserver` is an external observer. The arc reads whether its callback can be held under the gate the way `ResizeObserver` deliveries are counted. If it can, it is held. If it cannot, the 3 ms layout is carved out of the forced-layout clause by site, in writing, in the fixture, and the carve-out names why.
- The fixed-descendant red predates the arc and is handled by its own reading, not by loosening the clause.
- **A width growth's row re-measure** (resolved during the arc, from the readings). A frame whose width grows re-flows its transcript at the new width, and the list view's cell observers re-measured the rows over several frames, a pin, a re-window and a commit per frame mid-motion. The hold settles the interior at its final width in the set-up; a width-settling settle takes the arrival's two-frame prepare beat, so the first wave of re-measure is set-up work, and the cell observer waits out the motion gate, so anything after that lands after the land. Holding the starting width instead would have put the whole re-measure in the land frame.
- **The bench probe's own read** is carved out of the forced-layout clause by site, in the fixture. On the user's deck a sync layout read costs 3–4 ms on every tick while beats run and 0 at rest, with no DOM mutation in the motion: the frame's own layout, paid early by the instrument. CodeMirror's `IntersectionObserver` is held behind the gate all the same.
- **The `at0690` endings went with the file** (resolved during the arc). `734d273da` reached the arc's base mid-arc: it fanned `at0622` out into `at0696`–`at0706`, one gesture each, and deleted `at0690`, whose gestures are readings `tugtool deck motion settle` takes on a live deck. So the fixed-descendant seat red has no test left to be red in, and nothing about it is built here. The `LayoutContent` commit needed no routing either: `useDeckColumns` reads through `useStoreDerived`, which already subscribes through `gestureScope`'s `useSyncExternalStore`, and the sidebar legs in `at0706` read the sealed clause green. "`at0622` and `at0690` green" below reads as `at0696`–`at0706` green.

None of these is "carried". A red that cannot be fixed within reach is a question for the user about the clause, asked in the arc, not an entry on a list.

**[B06] The swipe is carved out of the sealed-motion clause explicitly.** The hand-lift prelaunch is the one gesture that commits under the gate on purpose, and the carve-out lives in the fixture beside `expectMotionSealed`, keyed on the gesture rather than on the reading, with [B06] of the motion brief cited. A swipe leg reads the clause with the carve-out applied, so the exception is a tested fact rather than an unread one.

**[B07] The three small holes close as hygiene.** `settledSizeRef` is cleared at the crossing's end as well as on delivery. The engine drops its handle when the cap fires, so a cap release and a normal release leave the same state and the trace records one open per close. The getter wrappers stay installed; the cost is one branch per read when disarmed, and uninstalling a prototype patch is more machinery than the branch is worth. That last is a decision to leave it, recorded so it is not re-asked.

**[B08] The workspace switch gets its own brief, after [B01].** The switch's decomposition is read with the same instruments the motion brief named: `--tasks`, chains and the land record, on the user's deck. The brief is written from that reading and nothing about the switch is built here.

- *Where the reading was taken (resolved by the decision's purpose).* The user's release deck cannot be read at rest while the arc's own session runs on it: its progress marks hold it at 21 updates/s against the verb's budget of 10, and `deck motion settle` refuses a busy deck. The decomposition was therefore read on `at0643`'s grown two-workspace fixture, at rest. The switch brief records that, and its first act re-reads the user's deck with no session running.

**[B09] The order is [B01], then [B03] and [B04] together, then [B05], then [B06] and [B07], then [B08].** The deck reading comes first because [B02] depends on it and because every later reading is compared against it. The land work precedes the reds because appear and bullseye are read through the land record, and a record that stops short would call them green early.

---

## Open Questions {#open-questions}

- **Is the band visible?** Settled by [B01]: it is, and [B02] as revised holds a shrink at its starting height rather than covering it.
- **Which property pays the mark-off relayout?** Settled under [B03]: neither. The inherited held height did.
- **Can an `IntersectionObserver` callback be held?** Settled under [B05]: it can. Every `IntersectionObserver` is constructed through a wrapper in `lib/gesture-scope.ts` whose deliveries wait out a closed gate and arrive once, in order, at its release, so no carve-out was needed.

---

## Non-goals {#non-goals}

- **Reverting the settled hold to the larger height on a growth.** It is what bought the land. A shrink is reverted, by the user's ruling in [B02].
- **Loosening the gap, land or sealed-motion bars.** They are the asks' bars under the user's rule. A carve-out by site ([B05], [B06]) is a named exception with a reason, not a looser number.
- **Building anything for the workspace switch.** [B08] briefs it from a reading.
- **Shortening the set-up.** Not a bar; nothing here is set-up work.
- **Uninstalling the geometry-getter wrappers.** Left, by [B07].

---

## Exit {#exit}

**An arc.** Its shape, in [B09]'s order:

1. The user's deck read on every height-bearing gesture, with a shrink watched, and the readings recorded ([B01]). [B02] decided from it.
2. The settled mark made free to remove, and the land tail extended to cover the mark-off, read on the deck against step 1 ([B03], [B04]).
3. The five reds closed on `main` by their named endings, `at0622` and `at0690` green ([B05]).
4. The swipe carve-out and the three hygiene closes ([B06], [B07]).
5. The switch's decomposition read and its brief written ([B08]).

The arc is done when `at0622` and `at0690` are green (since the split, `at0696`–`at0706`; see [B05]), the land row on the user's deck covers the hand-back's whole cost and reads one frame on every height-bearing gesture that does not shrink a frame (a shrink pays its land by [B02] as revised), and the switch brief exists.
