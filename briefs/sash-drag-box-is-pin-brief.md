# A sash drag whose members are laid out at their pins, not a beat behind them

**Purpose:** After `sash-drag-pinned` (`2b82861b3`) the sash itself stays under the hand, but the cards either side of it do not: a gap opens under the seam as it moves and closes a beat after the hand stops. This brief records what was measured on the user's own deck, why the pinned drag exposed a rule that was standing all along, and the one-rule fix that has already been landed in the working tree with an instrument that can see it.

---

## Purpose {#purpose}

The user's report, verbatim: "The sash dragging is now *great*, but the cards themselves don't keep up! They leave a gap which fills in a couple of frames later. It feels like the same delay you just fixed."

The screenshots said something more specific than the sentence: with the seam and the lower card moved ~490px down, the upper card's bottom edge was still where the drag started and the deck grid showed through the gap. Not the whole drag lagging — the seam is on time — but the members' boxes following it late.

---

## Evidence {#evidence}

**[F01] The pins are written on time; the boxes are not laid out at them.** A `setTimeout` sampler installed on the user's release deck through the `diag/eval` door recorded, every ~4ms during a drag of the left rail's Cards/Overview sash, each member's inline `style.top`/`style.height` beside its `getBoundingClientRect()`. At 343ms into the drag the upper member read inline `top=0 height=406.8px` with a box of `0–245`; the middle member read inline `top=406.8 height=378.2px` with a box of `407–947`. Every inline write in the record was the drag's own — a `MutationObserver` on the panes saw no other author of `style` — and the boxes converged on the pins only ~150–300ms after the hand stopped. **(verified, measured on the user's deck)**

**[F02] The lag is a CSS transition on `height`, and only on `height`.** A second probe recorded `getAnimations()` on the rail panes per tick: every animation was a `CSSTransition`, two keyframes on `height`, 100ms, `cubic-bezier(0.2, 0, 0, 1)`, re-launched on each pointer move from wherever the box had got to. No settle beat ran — the settle's arm and tween passes both skip `data-pointer-owned` frames (`deck-canvas.tsx` near lines 4157 and 4801), and they held. Because only `height` transitions, the seam and every member's `top` snapped while the heights chased: the exact picture in the screenshots. **(verified, measured on the user's deck)**

**[F03] The transition is `[D07]`'s window-shade rule, and its stand-downs do not reach a seam drag's members.** `tugdeck/styles/chrome.css` near line 195: `.tug-pane { transition: height var(--tug-motion-duration-fast) … }` for the collapse animation, standing down for `.tug-pane[data-gesture="true"]` (the pane's own drag or resize), `[data-imposer-settling]`, and `[data-space-switching]`. A seam drag stamps `data-gesture="seam"` on the *seam* and `data-pointer-owned` on the members; none of the three selectors matches a member. **(verified, by reading the stylesheet and `PlaceSeam`)**

**[F04] The rule was always there; the pinned drag is what armed it.** Before `2b82861b3` a seam drag published fractions on the deck container and the members' `top`/`bottom` `calc()` pins moved their boxes — the computed `height` stayed `auto` and a transition never started. The pinned drag writes each member's `height` in px on every move, and each write is a computed-value change the transition runs on. So the defect is new with that arc, though no line of that arc is wrong about what it wrote. **(verified, by reading both versions of `PlaceSeam`)**

**[F05] The loaded-deck instrument could not see it.** `at0626`'s bars are heartbeat overrun and render-cost p95; a 100ms ease on two `height` values costs nothing a frame gauge notices, and the file never compared a member's box to its pin. It was green over a drag whose members ran up to a full frame's travel behind the hand. **(verified, by reading the test and by the rail measurement below)**

**[F06] On a rail of three 240px-floor sidebar cards, dragged at a hand's rate, the box ran up to 18.8px behind its pin (p95 16.5px) over 133 held ticks.** With the fix in `[B01]`, 0.0px over 131. The rail fixture fits the one screen attached to the rig today (2056×1329 logical, 1290 visible); two 600px-floor session cards cannot stand split on it, so `at0626`'s column fixture refuses here with its own sentence rather than a reading. **(verified, `at0632` red then green)**

---

## Decisions {#decisions}

**[B01] The shade transition stands down on `data-pointer-owned`.** `.tug-pane[data-pointer-owned] { transition: none }` beside the other stand-downs in `chrome.css`. `data-pointer-owned` is the latch mark every pointer-driven placement already writes on the frames it moves — the pane's own drag, a zone drop's landing, and a seam drag on every member of its place — and the `[D07]` comment's own words are that the transition is disabled for "height changes that are driven by pointer position, not collapse state". This is that sentence applied to the mark that means it. Not `data-gesture`: the seam drag stamps that on the seam, and on a rail member the pair `[data-gesture="true"][data-pointer-owned]` is the lifted-panel livery (`tug-pane.css` near line 444), so borrowing it would change what the member looks like. At the release the pins come off and the mark comes off in one task; `px → auto` is not interpolable, so no transition starts on the way out.

**[B02] "The box is the pin" is an asserted invariant, on a rail fixture, proved red first.** `at0632-sash-drag-box-is-pin.test.ts` drags a rail sash at one move per 60Hz frame and holds every member's laid-out height within a pixel of its inline pin on every held tick, sampled by `setTimeout` per the occlusion finding. It is red on the tree before `[B01]` (`[F06]`) and green after. A rail rather than a session column because the invariant is the same on any member and a rail of 240px-floor cards fits every screen the harness opens on — the instrument must be able to run where the defect is reported.

**[B03] `at0626` carries the same bar, and covers `chrome.css`.** Its heartbeat now records the box-against-pin lag per tick and asserts it inside the held window, and it declares `@covers tugdeck/styles/chrome.css` so a change to the shade rule selects it. It stays the loaded-deck reading where the rig has the screen for it; it is not the proof of this fix, because it cannot run on today's rig (`[F06]`).

**[B04] The pinned drag keeps writing `height`.** The alternative — pin `top` and `bottom` instead, so the computed `height` stays `auto` and the transition never arms — was considered and not taken. It would sidestep the rule rather than state it, leave the next pointer-owned `height` write to find the same trap, and cost a container-height read the current shape does not need. One CSS rule that says what it means is the smaller change.

---

## Non-goals {#non-goals}

- **Removing the `[D07]` shade transition.** It is the collapse animation's, it is correct for the collapse, and it has three stand-downs already because the property is shared. This adds the fourth for the case the others did not name; it does not question the transition.
- **Re-measuring the drag's per-frame cost.** `sash-drag-pinned`'s readings stand — 4ms a frame, no overrun, every pointer sample delivered. The ease was invisible to those numbers because it is cheap; this brief is about where the box is, not what a frame costs.
- **Pointer prediction ([B05] of `sash-drag-pinned`).** Still unpulled. What the user saw was not the pipeline's residual; it was a 100ms ease, and it is gone.

---

## Exit {#exit}

Nothing to open. The change is in the working tree, verified and ready to land as one commit: `tugdeck/styles/chrome.css` (`[B01]`), `tests/app-test/at0632-sash-drag-box-is-pin.test.ts` (`[B02]`), and `tests/app-test/at0626-sash-drag-sampler.test.ts` (`[B03]`). Green on everything the diff selects — `at0632`, `at0543`, `at0557`, `at0622` — with `at0626` deferred to a rig whose screen can stand two session cards split. The one thing left for a later hand is that deferred run, the first time such a screen is attached.
