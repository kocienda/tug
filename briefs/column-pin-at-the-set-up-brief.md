# Column pin at the set-up: no transcript scrolls off its bottom in a split or a stack

**Purpose:** Putting a card into a split, or taking it out of one, makes the card flash and flicker as it settles. The transcript's bottom pin now rides an observer delivery that the motion gate holds, so the interior stands scrolled off its bottom for the length of the motion, or for three frames at the land, and snaps when the gate opens.

---

## Purpose {#purpose}

The user's report, 2026-10-05, on the deck as it stands after `set-up-and-go-fixups` joined at `043854efa`:

> When the height of a card changes, like when I put it into (most times) or take it out of a split (sometimes), the card *flashes and flickers* when it settles. This is BAD... like *give someone a seizure BAD*. It can't work like this. Performance otherwise looks good, but I need more time to test. The flashing must go now though.

The arc that just joined sealed the motion by holding observer deliveries and React tells behind a gate that opens three paints after the land ([B05] of `briefs/set-up-and-go-fixups-brief.md`). The transcript's bottom pin is one of those deliveries. This brief is about what that did to a column's non-moving members and to every shrink's land, and what pays the pin instead.

---

## Evidence {#evidence}

All readings are from one throwaway sampler run on the slice arm of the column fixture (`columnBlob()`, eight session cards bound to `session-transcript-basic`), dispatching `set-column-mode` split then stack on slot 0 and recording per animation frame: each shown frame's rect, its still-crossing mark, its card root's rect and anchor, and its `.tug-list-view` scroller's `scrollTop`, `clientHeight`, `scrollHeight`, distance from bottom, and last rendered cell's screen bottom. Times are ms from the sampler's arm; the gesture was dispatched at about 150. The sampler was deleted after the run; [B05] makes it a test.

**[F01] Split: the revealed member is cut to its tile and left 441 px off its bottom for the whole motion.** At t=326 pane `p1` (card `c1`, z-index 1) went from 5..1046 to 5..605 in one paint with no crossing mark, scroller `clientHeight` 682 → 241, `scrollTop` unchanged at 2898, distance from bottom 441, last cell's bottom at 753 against a frame bottom of 605. It stayed there while the survivor `p2` retreated off it from 5..1046 to 610..1210 over 400 ms, and was pinned (`scrollTop` 3339, distance 0) at t=803, when the gate opened. The commit-time cut is by design: a revealed member "is simply at its tile behind the survivor, uncovered as the survivor retreats" ([F06] and [B02] of `briefs/column-flip-cover-brief.md`), and the tween pass's covered branch in `settle-engine.ts` holds nothing on a split. The pin is not. **(verified)**

**[F02] Split: the survivor's shrink lands 441 px off its bottom and pins three to four frames later.** `p2` was held at 682 for the motion per the shrink ruling ([B02] of `set-up-and-go-fixups`). At t=747 its hold came off: `clientHeight` 241, `scrollTop` 2898, distance from bottom 441, last cell's bottom at 1358 against a frame bottom of 1210. Pinned at t=803, 56 ms later, at the gate's release. The list view's `onStillCrossingClosed` runs `smartScroll.catchUp()` only, which pays what was deferred during the hold, and nothing was: the scroller never resized while held. The pin waits for the container `ResizeObserver` delivery of 682 → 241, which `heldResizeObserver` keeps until the gate opens. **(verified)**

**[F03] Stack: the held member is laid out at the full run before its tile hold goes on, and the browser clamps its scroll.** At t=304 `p1` stayed at 5..605 (held inline at its tile, as the stack's cover choreography does) but its `scrollTop` dropped 3339 → 2898, distance from bottom 441, and its card root lost `data-still-anchor` (following went false). 2898 is exactly `scrollHeight − 682`: the commit laid the frame out at the full run (scroller 682 tall) before the tween pass wrote the inline tile hold, and any forced layout in between, the engine's own Last-rect read included, clamped `scrollTop` to that larger viewport's maximum. The hold then returned the scroller to 241 with the clamped value standing. The survivor `p2` grew up over it from 610..1210 to 5..1046, so `p1` was fully uncovered at the start and showed the jumped content for about 150 ms. At the land `p1` read distance 0 only because the land height equals the clamp height; it re-engaged following at t=781 by `growth-at-bottom-reengage`. **(verified)**

**[F04] Stack: the survivor's growth is clean.** `p2` was a settled crossing (held at its final 682 with the pin paid in the set-up by `announceStillCrossingSettled`): distance from bottom 0 on every tick from t=304 to the land, and its held delivery was swallowed by `settledSizeRef`. The growth door already does what this brief asks for the other three cases. **(verified)**

**[F05] This is the arc's regression.** At `b8d570447`, the commit before the join, `tug-list-view.tsx` constructed five plain `ResizeObserver`s and no `heldResizeObserver`; the container observer delivered the frame after the commit or the land, so [F01]'s pin landed under the survivor's cover and [F02]'s one frame after the land. The join made every one of them gate-held, and the gate opens three paints after the land. **(verified by `git show b8d570447:tugdeck/src/components/tugways/tug-list-view.tsx`)**

**[F06] The three cases share one shape.** In each, the interior's geometry is changed in a task we run (the set-up commit's layout effect, the land's completion), and the only thing that pays the pin is a delivery the same task's gate then holds. The growth is the exception because its door pays synchronously. **(read out of the code; [F01]–[F04] are its instances)**

**[F07] A growth "flicker" was not reproduced.** The slice renders every cell (5 cells, no spacers), so a window that does not cover a grown viewport cannot show here. The settled door's `scrollTick` runs its re-window synchronously in the set-up, before the gate closes, so the mechanism is not expected to produce one. If a stack still flickers after this lands it needs a whale-arm reading on the user's deck. **(not reproduced)**

---

## Decisions {#decisions}

**[B01] The pin is paid in the task that changes the interior's geometry, never on an observer delivery.** The gate holds deliveries for a reason that stands ([B05] of `set-up-and-go-fixups`); a pin that rides one is therefore a pin that lands after the motion. The settled growth already pays synchronously ([F04]) and reads clean; the three cases that do not ([F01]–[F03]) are the flash. This rules out un-holding the list view's container observer, which would put its re-window commits back into the motion.

**[B02] A split's revealed member is a settled still crossing at its tile.** In the tween pass's covered branch, the frame is marked with `settleStillCrossing` at the content height it already has and pushed onto `settledFrames`, so `announceStillCrossingSettled` pays its pin, restore, extent rebase and re-window before the gate closes, and records the size so the held delivery is swallowed. Its geometry does not change: the root is held at the height it stands at. The mark ends with the cover at the chain's completion, in both release loops. This keeps [F06] and [B02] of the cover brief intact: the revealed member still neither travels nor fades.

**[B03] A shrink's land pays like the settled door.** `onStillCrossingClosed` in `tug-list-view.tsx` does what `onStillCrossingSettled` does: `maybePinToBottom`, `applyRestoreTarget`, record the settled size, `scrollTick`. It runs in the land's task, right after `endStillCrossing` has dropped the hold, so the forced layout it takes is the reflow the land already owes under the shrink ruling, and the gate-held delivery then arrives carrying the settled size and is swallowed. The land record will show that layout; it is the shrink ruling's cost made honest, and the land bar reads it as before. The re-window commit behind `scrollTick` lands at the gate's release, which is safe for a shrink: the viewport moves down by the shrink's height within rows the larger viewport had already rendered.

**[B04] A stack's held member opens its still crossing at arm, at its tile's content height.** The arm's predict loop in `settle-engine.ts` skips every covered member; it skips only the revealed ones from now on and marks the held ones with `markStillCrossing` at the content height they stand at. A definite root height survives the commit's full-run layout, so the scroller never grows and nothing clamps [F03]. The tween pass adopts the mark in the covered branch and ends it with the cover; the post-land reflow to the full run lands under the survivor, which stays z-frontmost. Revealed members stay skipped at arm because their tile is smaller than their standing height, and [B02] handles them.

**[B05] The sampler becomes the test, and it is red today.** `at0708-settle-column-pin` records, per animation frame across a split and a stack of slot 0 on both transcript arms, each shown frame's scroller distance from bottom and whether the frame is uncovered. The bar: a scroller that was following reads zero on every tick its frame is visible and at the land. It fails on [F01], [F02] and [F03] on the tree as it stands, and covers `settle-engine.ts`, `fold-crossing.ts` and `tug-list-view.tsx`.

**[B06] The gate's three-paint release and the shrink ruling stand.** Neither caused the flash; the pin's riding a held delivery did. [B03] makes the release harmless for a shrink, and the ruling that a shrink holds its starting size keeps the motion free of bare background.

---

## Non-goals {#non-goals}

- **Un-holding the list view's observers.** It would restore the pre-arc one-frame glitch and put the re-window commits back into the motion that the arc took them out of. [B01] is the rule instead.
- **Holding a revealed member at its standing height with a bottom anchor through the split.** The picture would be right during the motion, but its hold would come off at the land as a shrink, and [F02]'s three frames would move to the reveal. [B02] pays it in the set-up instead.
- **Changing the cover choreography.** The survivor still moves alone, covered members still neither travel nor fade, and z-order still decides what shows ([F06] of the cover brief). This brief touches only what their interiors do at the commit and the land.
- **The growth leg.** It is already paid in the set-up ([F04]); nothing here changes it.

---

## Exit {#exit}

An arc. Its first move is the test ([B05]), written from the sampler's shape and run red on the three findings, so the three doors land against a bar rather than an eye. The doors are independent and can land in any order; the split's two ([B02] revealed member, [B03] shrink's land) together answer "most times", and the stack's ([B04]) answers "sometimes". Each lands with `tugtool deck motion settle` on the user's deck as the reading of record, as [B10] of `briefs/set-up-and-go-motion-brief.md` requires, and the fixture's land bar and sealed-motion bar stay green across `at0702`, `at0703` and `at0705`.
