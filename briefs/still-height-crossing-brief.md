# Still Interior for Every Height Crossing

**Purpose:** A card resizing into or out of a stack sometimes judders and sometimes runs at full frame rate. The judder is the card's interior re-laying-out on every frame of the resize; it should be smooth every time.

---

## Purpose {#purpose}

The report, in the user's words: "Sometimes, when a card resizes to move into or out of a stack, the animation is smooth, while other times, it judders. The judder appears to be due to the card relaying out during the resize animation — this happens reasonably often with session cards. However … other times, the animation is perfectly smooth and runs at full frame rate (as it should, in my opinion). I want these split/resize animations to be smooth *all the time*."

And the scope, also in the user's words: "The issues I'm seeing have *nothing* to do with width. These cards never change their width." This brief is about **height** crossings only.

---

## Evidence {#evidence}

Everything below was read out of the code and the animation doctrine's recorded measurements. **No fresh profile was taken for this brief** — the per-frame cost is inferred from what the code demonstrably does per frame, and [B07]'s bench is what confirms it.

**[F01] The settle runs in two cost classes, and the gesture picks which.** A frame that only moves rides a transform-only tween in the qualifying form — compositor-resident, one walk at start, one at land, nothing between. A frame whose **height** changes gets a real `height` term in `springSettleKeyframes`: `lib/pane-flip.ts`'s header says height is never smeared, because the gestures that change it halve or double it and no scale cap admits that ([D135]). A frame carrying a real size term "forfeits acceleration", and "the frame's subtree lays out truthfully on every frame of the motion". `deck-canvas.tsx` computes `heightTweens` as any height delta ≥ 0.5px and hands it to `planSettleBeats`. **(verified, by reading)**

**[F02] A stack or split always gives exactly one frame a height term.** On a column mode flip the z-frontmost member is the **survivor** and rides a fused beat that tweens its real height; every other member is **covered** and animates nothing (`settleHoldPlanRef` doc, `deck-canvas.tsx`). So whether the gesture judders is decided by which card is frontmost and what its interior costs to lay out — which is the "sometimes". **(verified, by reading)**

**[F03] A session-card survivor is the expensive case, and the code says why in its own words.** `session-card.css`, on the fold's held height: "`TugListView`'s container `ResizeObserver` answers every delivery with `maybePinToBottom()` and `scrollTick()`, so a scrollport that shrinks with the frame slides the text upward by the amount the viewport lost, every frame, and re-windows rows under the closing edge … the same holds for CodeMirror's host and for this card's own size container". The card root is `container-type: size`, so its `cqh`-based rules re-resolve at every intermediate height as well. **(verified, by reading; the per-frame cost itself is not freshly measured)**

**[F04] Those re-windows are commits inside the settle window, which the doctrine measured as superadditive, and the existing hold does not cover them.** `animation-doctrine.md` (#residency): settle alone 343 walk samples, a commit stream alone 654, both together 1809. `CodeSessionStore.holdNotifications` defers **wire-origin** notifications only — "Local actions and timer ticks are never held" — so a list view re-windowing off its own `ResizeObserver` lands inside the window regardless. **(verified, by reading; whether `scrollTick` commits on every delivery or only on a window change was not traced)**

**[F05] The list view already debounces a width gesture to its settle; height has no equivalent.** `tug-list-view.tsx`'s `widthObserver` runs its invalidation once at settle and freezes the cell observer in between. Nothing brackets a height gesture. **(verified, by reading)**

**[F06] This exact problem is already solved — for one gesture.** `lib/fold-crossing.ts` and `briefs/session-fold-still-interior-brief.md`: for the tween's life the card is laid out once at the larger of its two content heights, `.tug-pane-content` clips it (`overflow: hidden`), and only the frame's edge moves, because "a subtree with a definite height that does not change is not dirtied by its ancestor's tween". It is gated on `data-folded` differing across the commit (`deck-canvas.tsx`, the `firstFold.folded !== frame.hasAttribute("data-folded")` test beside `markFoldCrossing`). A stack or split height tween never gets it. **(verified, by reading)**

**[F07] A sticky composer cannot carry the bottom of the card through a general crossing.** Z2 (the status row) is already `position: sticky; bottom: 0`, with `.session-card-top-column` as its containing block and `.tug-pane-content` as its scrollport. An entry region made sticky against the same scrollport pins to the same visible bottom edge and covers Z2 for the whole crossing; Z2 cannot be offset above it without knowing the composer's height, which is an interior measurement the fold design exists to avoid. **(verified, by reading `session-card.css`)**

**[F08] `.tug-pane-content` is already `position: relative`.** A held card root positioned `absolute; bottom: 0` inside it tracks the box's bottom edge at layout with no new positioning context. The pane's chrome sits outside the content box, so an interior overflowing the box's **top** is clipped under it. **(verified, by reading `tug-pane.css`; the rendered result is untested)**

**[F09] The list view's resize episode restores a top anchor at landing.** `beginResizeEpisode` is armed for every armed frame, height-only settles included; the list view claims the episode and restores a cell-index anchor (`onPreserveBegin` / `onPreserveEnd`, `makeAnchorResolver`). A scrolled-up transcript therefore lands top-anchored; a following one re-pins to its bottom. **(verified, by reading)**

**[F10] Every consumer of `data-fold-crossing` reads it as "a fold".** `session-card.tsx`'s terminal-state effect listens for `FOLD_CROSSING_END` and probes the attribute one frame after a `folded` flip; `afterFoldCrossing` is used by `session-compaction-run.tsx` (the cover rising out of Z2) and `session-card-telemetry-renderers.tsx` (Z2's occupant leaving). **(verified, by grep)**

**[F11] A re-mark mid-crossing can lower the held height — today, in fold retargets.** The held height is `max(First, Last)` content height, and on a retarget `arm` measures First mid-tween, at an intermediate height. A fold-in landing inside an unfold reads First = intermediate, Last = folded, and re-marks the interior *smaller* than it is being held — one relayout in mid-sweep. **(inferred from the code path in `deck-canvas.tsx` and `markFoldCrossing`; not reproduced)**

**[F12] Under FLIP, the hold is nearly free.** React commits the final geometry before the Last pass runs, so on a **growth** the interior is already laid out at the larger (final) height and the hold merely keeps it — zero extra layouts. On a **shrink** the hold restores the First height in the same pre-paint pass, so a `ResizeObserver` comparing against its last delivered size sees no change at the start; the one real relayout and the one delivery land when the hold comes off, after the tween. **(inferred from the effect ordering; [B07]'s gate is what pins it)**

---

## Decisions {#decisions}

**[B01] Every frame with a real height term gets a still interior — not only a fold.** In the Last pass, `heightTweens` alone is the trigger: the interior is held at the larger of the First and Last content heights for the life of the beat chain, and released at the chain's one completion through the same id-guarded doors the fold uses (completion, retarget adopt, window sweep, teardown). The fold's argument ([F06]) never depended on the fold; it depended on a height tween over an expensive subtree, which is [F02]/[F03] exactly. Revisit only if [B07]'s bench shows the held form is not the win.

**[B02] The general hold gets its own mark; `data-fold-crossing` keeps meaning "a fold".** A new attribute and held-height property (names are the arc's to pick — `data-still-crossing` is the working one), owned and written by the imposer in the same module as the fold's. A fold sets **both**. `FOLD_CROSSING_END`, `afterFoldCrossing`, and the session card's terminal-state effect are untouched ([F10]): widening the fold mark to every stack would make a compaction cover or a fold landing wait on, or be closed by, a settle that is not a fold.

**[B03] The hold is a pane-level rule, so every card type is held with no opt-in.** Under the new mark, `.tug-pane-content` clips (`overflow: hidden`, as it does for the fold) and its children take the held height; the session-card-specific `height: var(--tugx-fold-held-height)` rule folds into it. The session card keeps only what is genuinely about folding. A per-card opt-in would leave the next expensive card juddering until somebody noticed.

**[B04] The held picture hangs from the edge its content hangs from: top by default, bottom when the card says so.** A card root may declare a bottom anchor by attribute; under the mark it is then `position: absolute; bottom: 0` in the content box ([F08]). The session card writes the attribute from `onFollowBottomChange` — DOM zone, event-clocked, no React state ([L06], [D7]) — so a **following** transcript is bottom-anchored: composer, Z2 and the pinned text ride the bottom edge together, which is what the pinned layout truthfully does at every intermediate height, so neither end of the crossing pops. The imposer still measures nothing inside the card. A **scrolled-up** transcript stays top-anchored, because its episode restores a top anchor at landing ([F09]) and a bottom-anchored hold would jump the text by the height delta; the accepted cost there is that the composer wipes out or in with the edge and lands in one layout.

**[B05] A bottom anchor never applies during a fold crossing.** The fold's Z2 motion is sticky against a top-anchored interior ([F07]); when both marks are present the fold's picture wins.

**[B06] A re-mark never lowers the held height.** Re-marking a frame already held takes the larger of the standing height and the new one ([F11]). This fixes the existing fold-retarget hazard and is what makes a fold and a stack sharing one settle window safe under [B01].

**[B07] Two gates prove it.** An app-test that stacks and splits a column whose survivor is a session card with a long transcript and asserts **zero** `ResizeObserver` deliveries inside the card between the tween's start and its landing ([F12]); and an on-demand release bench of the same gesture before and after, under [D5] discipline (unoccluded, interleaved baselines, ×3 medians, forcing probe). The bench stays out of CI, per the doctrine.

**[B08] The doctrine and the module header change in the same arc.** `pane-flip.ts`'s header ("the frame's subtree lays out truthfully on every frame of the motion") and `animation-doctrine.md`'s worked example 2 both become false under [B01] and are corrected with it.

---

## Open Questions {#open-questions}

None that block. The one thing unmeasured — how much of the judder is interior layout versus the per-frame compositing walk — is answered by [B07]'s bench, and the answer only decides whether the follow-up named under Non-goals is ever opened.

---

## Non-goals {#non-goals}

- **Width.** These cards do not change width in the gestures reported, and the user ruled it out. The over-cap real-`width` tween has the same shape of cost, but holding a width means a visible re-wrap at landing — a different trade, not argued here.
- **Moving the height tween onto the compositor.** Under this brief the `height` tween itself stays main-thread, so the per-frame whole-page walk remains; what goes is the subtree layout, the observer storm and the in-window commits. A fixed-size frame revealed by clip or translate is the way to remove the walk too, and it is a larger change — borders, radius and shadow follow the box. Opened only if [B07]'s bench says the walk still matters.
- **A sticky composer.** Rejected: it lands on top of Z2, and the only fix needs an interior measurement ([F07]).
- **Bottom-anchoring a scrolled-up transcript, with a `scrollTop` correction at landing.** Rejected: it fights the episode's own restore ([F09]) and changes what a reader who scrolled up is looking at.
- **Widening `holdNotifications` to local commits.** The store's rule that the user's own gesture is never held is sound; [B01] removes the commits at their source instead.
- **A height debounce inside `TugListView`**, mirroring the width one ([F05]). It would quiet one observer in one component; the still interior quiets all of them, in every card, from outside.

---

## Exit {#exit}

**An arc.** The raw material, in the order it has to land:

1. Generalize `lib/fold-crossing.ts`: the general mark and held-height property beside the fold's, a fold setting both, and the never-lower rule on re-mark ([B02], [B06]).
2. `deck-canvas.tsx` Last pass: mark on `heightTweens` alone, fold detection layered on top; every existing end door (completion, adopt, sweep, teardown) ends the general mark too ([B01]).
3. CSS: the pane-level hold and clip in `tug-pane.css`, the session card's held-height rule folded into it, and the bottom-anchor rule with its fold exclusion ([B03], [B04], [B05]).
4. Session card: write the anchor attribute from `onFollowBottomChange` ([B04]).
5. The observer-delivery app-test, then the before/after release bench ([B07]).
6. Correct `pane-flip.ts`'s header and the doctrine's worked example ([B08]).
