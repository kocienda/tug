# Motion under View › Zoom: Z2's fold ride and the Compacting cover

**Purpose:** Two things move wrongly while the deck root is scaled. A Session card's Z2 strip pops up the moment a fold starts and trails the closing edge the whole way; and the Compacting cover jumps while its card folds. The at-rest Z2 hold was fixed in `a3fc91b75`; this brief is about what still moves.

---

## Purpose {#purpose}

The user, after `a3fc91b75` landed on main:

> **Not fixed:** a fold animated while zoomed is still affected by the same WebKit bug, because Z2 is sticky for those few hundred milliseconds. Z2 can sit too high during the motion, then lands correctly when the fold settles. No test covers a fold under zoom yet. ↑ Fix this please.
>
> Also, when the Compacting sheet is up and the deck is zoomed out, the sheet jumps around badly. Feels like the same general problem as Z2. Some measurements are not zoom-friendly.
>
> Must get to the bottom of both these issues.

View › Zoom is `transform: scale(f)` on `#deck-container`, sized to the window ÷ f (`tugdeck/src/lib/page-zoom-store.ts`). Z2 rides a fold's closing edge by `position: sticky; bottom: 0` against the pane's content box, switched on only while the pane carries `data-still-crossing` (`tugdeck/src/components/tugways/cards/session-card.css`, the rule after the strip's base rule). The Compacting cover is a bottom-anchored pane sheet resting on the card's modal rest line (`tugdeck/src/components/tugways/cards/session-compaction-run.tsx`, `presentation: "settle"`).

---

## Evidence {#evidence}

Every reading below is from a throwaway app-test (since deleted) on the at0715 fixture: a four-up flow deck, a Session card in slot 0 with a transcript long enough to scroll and a hello card in slot 1, panes 675 wide. The sampler read `getBoundingClientRect()` on `requestAnimationFrame` from before the dispatch to past the land; numbers are viewport px.

**[F01] Z2 pops at the fold's first frame under zoom, and pops back at the unfold's land.** At 0.7, Z2's bottom stood at 897 at rest with the clip's bottom (`.tug-pane-content`) at 1046.8. On the first frame carrying `data-still-crossing`, before the frame's height had moved at all, Z2's bottom was 752.7: a jump of 144 px with the edge still where it was. It then trailed above the edge for the whole crossing and met it only in the last frames. The unfold is the mirror: Z2 sat above the edge throughout and dropped 145 px at the land. At 1.0 on the same fixture Z2 held its rest position until the edge reached it and then rode it at a gap of 0.0 on every frame. **(verified)**

| factor | direction | Z2 bottom at rest | first crossing frame | clip bottom then | largest gap mid-crossing |
|---|---|---|---|---|---|
| 0.7 | fold | 897.0 | 752.7 | 1046.8 | 294.1 |
| 0.7 | unfold | 104.2 | 104.2 | 104.3 | 293.6 (at the land, then a 145 px drop) |
| 1.0 | fold | 831.0 | 831.0 | 1045.0 | 0.0 once the edge reaches Z2 |
| 1.0 | unfold | 148.8 | 148.8 | 149.0 | 0.0 until Z2 reaches rest |

**[F02] The wrong edge tracks the tweening clip height, so no constant inset compensates.** Across the crossing the gap between the clip's bottom and Z2's bottom was a near-constant fraction of the clip's height. In layout px the held edge fits `f × H + (1 − f) × y0`, where `H` is the content box's current height and `y0 ≈ 97` is its top in the deck's layout (the four-up pane's chrome). The term that matters is `f × H`: WebKit takes the scrollport's edge in scaled coordinates and compares it with the sticky box's unscaled position. Because `H` is the animated value, a `bottom: calc(…)` written once cannot undo it, and the `cqh` route is blocked too: `.session-card` is `container-type: size`, so a container unit on Z2 resolves against the held card, not the clip. **(verified by fit against the frames; the `cqh` block is read from the stylesheet)**

**[F03] Compositing hints do not change WebKit's sticky math.** Three variants were each probed through the same fold at 0.7 under `tugtool file probe`: `will-change: transform` on Z2, `transform: translateZ(0)` on Z2, and `will-change: transform` on `.tug-pane-content` during the crossing. All three produced the readings in [F01] to the pixel. The bug is in layout's constraint computation, not in which scrolling path positions the box. **(verified)**

**[F04] The frame's height is the one number the crossing animates, and it is a Web Animations keyframe on `height`.** The settle engine drives the pane frame with `el.animate()` and restores the inline `height` after (`tugdeck/src/components/chrome/settle-engine.ts`, the `inlineRestorer(frame, "height")` sites). There is no per-frame JavaScript value for the edge: nothing in the deck knows the clip's current height except layout. The card root is held at its open height by `--tugx-still-held-height`, registered non-inheriting on purpose (`tugdeck/src/components/tugways/tug-pane.css`), so a descendant cannot read it in a `calc`. **(verified)**

**[F05] Nothing positioned stands between Z2 and the clip.** `.session-card` and `.session-card-top-column` declare no `position`; `.tug-pane-content` is `position: relative` (`tug-pane.css`). An absolutely positioned Z2 would resolve its insets against the clip's box. **(verified)**

**[F06] The Compacting cover is still under zoom at rest, under every trigger tried, on both the current and the previous CSS.** At 0.6 the panel was sampled through its rise and then through five triggers. It moved only when the layout moved, once per event, with no intermediate frames: **(verified)**

| trigger at 0.6 | panel top before → after | frames with any other value |
|---|---|---|
| rise | 791 → 773.9 over 255 ms | the rise itself only |
| zoom 0.6 → 0.7 → 0.8 → 0.6 | 773.9 → 727.7 → 681.6 → 773.9 | none |
| window resize ×2 | 773.9 → 722.9 → 822.9 | none |
| streaming assistant text, six frames | 773.9 throughout | none |
| transcript scrolled up 400 and back | 773.9 throughout | none |

The same run under the pre-`a3fc91b75` stylesheet (Z2 sticky at rest, standing 268 px above the entry at 619) gave the same panel positions. The sheet's own geometry code is already in layout px (`layoutRectOf` and `layoutPxOf` throughout `tugdeck/src/components/tugways/tug-sheet.tsx`, covered by at0712), so "a measurement that is not zoom-friendly" does not describe the sheet's measure. The jump the user saw at rest was not reproduced; see Open Questions.

**[F07] A fold with the cover up jumps at every zoom, and 1.0 is as bad as 0.6.** With the cover up, folding the card sent the panel's top through 589 → 559 → 370 → 167 → 106 → 170 → 106 → 110 → … → 154 at 1.0, and 774 → 714 → 513 → 300 → 143 → 64 → 114 → 64 → … → 92 at 0.6: the same shape scaled. The panel's height was squeezed from 176 to 77 and back. The mechanism is in `tug-sheet.tsx`'s bottom-anchor effect: the clip's `bottom` is an inset from the pane frame's bottom, so when the frame's height tweens the clip's band closes and the bottom-justified panel rides the closing edge up; when the band gets shorter than the panel the panel is squeezed, the `ResizeObserver` on the sheet content fires, and `measure()` re-writes `bottom` mid-crossing (268.8 → 0 → −111 → −139 → −144 at 1.0), moving the panel again. Only after the land does the `settle` exit lower it by 48 px and fade it. The effect's own comment says the frame and the canvas were retired from observation so that no measure runs through a settle; the content observer re-admits one through the squeeze. **(verified)**

**[F08] The user's deck when read.** Read-only through the release deck's eval door on 2026-10-07: factor 0.9, seven panes, two Session cards of 608 × 1213 viewport px with Z2 `position: relative` (the fixed build) and the entry region 16 % of the card, no cover up. **(verified)**

**[F09] No test folds under zoom, and no test folds with the cover up.** at0563 samples Z2's fold ride at 1.0 only, and its docblock describes the ride as sticky. at0492 raises the cover and refuses doors but never folds while sampling; at0562 pins the folded Z2 occupant's look. **(verified)**

---

## Decisions {#decisions}

**[B01] Z2's fold ride leaves `position: sticky` for good.** [F01] shows sticky under a scaled ancestor holding Z2 a third of the card too high on every frame of the crossing, [F02] shows the error tracking the animated height so no inset undoes it, and [F03] shows no compositing hint changing it. The at-rest fix in `a3fc91b75` stays as it is; what goes is the crossing-time `position: sticky` rule and the [F07]-of-`tug-pane.css` reasoning that keeps the content box a scroll container for its sake.

**[B02] The ride is a layout ride against the clip's edge, resolved by the browser on each frame of the tween, with no second animated number and no per-frame JavaScript.** The one number in motion is the frame's animated `height` ([F04]); Z2 must read its consequence, the clip's bottom edge, at layout, which is where the browser already has it. A transform driven from the fold machinery would be a second copy of that number (`briefs/session-fold-still-interior-brief.md` rejected it for that reason) and is not reopened. Two mechanisms satisfy this and the arc chooses by probe, in this order:

1. **Anchor positioning.** For the crossing, Z2 becomes `position: absolute; inset-inline: 0` inside the clip ([F05] makes the clip its containing block) with `top: min(anchor(--z2-seat top), calc(100% - anchor-size(--z2-seat height)))`, where `--z2-seat` is an in-flow wrapper that keeps Z2's height so nothing in the column re-flows when Z2 leaves the flow. `100%` is the clip's current height, so the second term is the closing edge and the first is Z2's rest position: exactly the `min` that sticky was providing. This is pure layout and the scale never enters it.
2. **The edge as a registered length property.** The settle engine animates a registered `<length>` custom property in the same keyframes as `height` (one `animate()` call, one clock), and Z2 rides by a `translateY(min(0px, …))` off it. Its blocker is that Z2's rest bottom is not a number CSS has (the entry region's height is a flexible row), so this needs the card to publish one more value; it is second for that reason.

Whichever lands, the still picture's claims in at0563 must hold unchanged at 1.0: no top inside the card moves, Z2's top is monotonic, the crossing is spent and cleared.

**[B03] The Compacting cover does not ride the closing edge; it stands still and lowers.** For the length of a still crossing the sheet clip's geometry is frozen where it stood on the crossing's first frame, in layout px, and `measure()` does not run: the content `ResizeObserver` is gated off while the pane carries `data-still-crossing`, the same way the frame and canvas observers were already retired. The panel then plays the `settle` exit over the closing portion of the crossing on a panel that has not moved, which is what [B06] of `briefs/compaction-fold-face-brief.md` describes and [F07] shows is not happening. This is zoom-independent and is fixed as such.

**[B04] Two sampled app-tests are the verdicts, each proved red first under `tugtool file probe` with the fix reversed.** A fold under zoom in at0563's shape, at 0.8 and 0.5, asserting on every crossing frame that Z2's bottom is the lesser of its rest bottom and the clip's bottom within 1.5 viewport px, and that no consecutive pair of frames moves Z2 more than the edge moved. And a cover-fold test that raises the cover through the wheel's `tug_notice` frame (the at0492 recipe), folds, and asserts the panel's height is constant through the crossing and its top changes only by the settle exit's lowering. Both carry `@covers` for `session-card.css`, `tug-pane.css` and `tug-sheet.tsx` as they apply, and at0563's docblock stops describing the ride as sticky.

**[B05] The Z2 ride lands first, the cover second, and the at-rest report is re-checked on the built app after both.** [F06] did not reproduce a cover jumping at rest under zoom, on either stylesheet; the one jump found is the fold ([F07]). If the user still sees the cover jump with no fold in flight after both land, that is a new report with its trigger named, not a reopening of this one.

**[B06] The documents that say "sticky" are updated in the same arc.** The `[F07]` note in `tug-pane.css` about keeping the content box a scroll container, the strip's base-rule comment and the fold-doc bullet in `session-card.css`, at0563's docblock, and a line in `briefs/session-fold-still-interior-brief.md` marking its [B02] as superseded by this brief.

---

## Open Questions {#open-questions}

- **What was in flight when the cover jumped at rest?** [F06] tried the rise, zoom steps, a resize, streaming, and a scroll at 0.6 and saw one clean move per layout change. If the user folded the compacting card, [F07] is their report and nothing is open. If not, the trigger is unknown; the arc asks on hand-back, with the reading in [F06] as the comparison.
- **Anchor positioning in the shipped WKWebView.** The user's machine is macOS 27 and the deck already relies on current WebKit, but the app's minimum macOS was not found in a quick look at `tugapp/`. If anchor positioning is unavailable there, mechanism 2 of [B02] is the one to build. The arc's first probe settles this in a minute.

---

## Non-goals {#non-goals}

- **A constant compensating inset on the sticky Z2.** Ruled out by [F02]: the error is a fraction of the animated height.
- **A per-frame JavaScript write or a transform driven from the fold machinery.** A second copy of the number the settle already animates; rejected in the still-interior brief and not reopened.
- **`zoom` in place of `transform: scale`.** It would make sticky correct by re-laying-out the whole deck at every factor, which is the premise the zoom arc replaced.
- **Giving up the ride under zoom** (sticky only inside `@container style(--tug-zoom-factor: 1)`). It trades a pop for a clip and leaves the fold degraded at every factor but one. Only a fallback if both [B02] mechanisms fail, and then as its own decision.
- **Rewriting the sheet's measure code for zoom.** It is already in layout px ([F06], at0712). The sheet's fault is when it measures ([F07]), not in what units.

---

## Exit {#exit}

An arc. The first steps, in the order they must land:

1. Write the fold-under-zoom test in at0563's shape and run it red against the current CSS.
2. Probe mechanism 1 of [B02] on the harness fixture at 0.7 and 1.0; if the readings match 1.0's today, build it and run at0563, at0715 and the new test; otherwise mechanism 2.
3. Write the cover-fold test, run it red.
4. Freeze the sheet clip through a still crossing and gate the content observer ([B03]); run the cover-fold test, at0492, at0562 and at0712.
5. The document updates of [B06], then the derived selection.
