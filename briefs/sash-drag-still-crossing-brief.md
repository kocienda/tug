<!-- brief-skeleton v1 -->

# A sash drag is a still crossing driven by the hand

**Purpose:** Dragging the sash between two split sidebar cards judders and the sash trails the pointer by several frames. The sash must stay pinned under the pointer, and it must do so on a rail that holds real cards with real content.

---

## Purpose {#purpose}

The report, in the user's words: *"Dragging the sash between two split sidebar cards judders. These should be smooth and nimble. The sash should stay pinned under my mouse as I drag it, not lag several frames behind it like a drunken sailor."*

The constraint the user set on the answer: no per-frame machinery that the tuglaws do not license. [L13] permits one thing on a gesture's clock, a loop that reads input and writes DOM, and the animation doctrine's organizing sentence is that motion cost is paid at gesture edges, never per frame, never at rest. The brief is written against that reading, and its decisions are checked against [L05], [L06], [L08], [L13], [L23], [L27] and [L33] rather than against what would merely be fast.

---

## Evidence {#evidence}

**[F01] The drag machine itself is built the licensed way.** `PlaceSeam` in `tugdeck/src/components/chrome/deck-canvas.tsx` takes pointer capture, latches on a move threshold, coalesces `pointermove` into one `requestAnimationFrame` per frame, and writes the seam's fraction as a custom property on the canvas container. A shared rail writes every seam so a cascade stays consistent. Nothing on the path touches React state; the store sees one commit at release. This is [L13]'s "gesture-driven frame loop that reads input and writes DOM" and [L08]'s preview-in-DOM, commit-at-release. **(verified, by reading)**

**[F02] The frames and the seam read one number.** A rail member's vertical pins are `calc()` expressions over `--tug-rail-<side>-seam-<i>` (`railMemberPins` in `tugdeck/src/lib/layout-imposer.ts`), and the seam's own `top` is the same expression. The sash cannot move before both members have re-laid-out, because the browser resolves all three in one style-and-layout pass. **(verified, by reading)**

**[F03] Every frame of the drag re-lays-out both members' interiors.** Each member's card root is `height: 100%` of a content box whose height the seam property just changed, so the whole subtree is dirtied: the Cards card's list view, the Jots card, every cell. On a shared rail under cascade it is every member the drag has reached. **(verified, by reading `tug-pane.css` and the pins)**

**[F04] The list view's container observer turns each of those layouts into a React commit.** `TugListView`'s scroll-container `ResizeObserver` (`tugdeck/src/components/tugways/tug-list-view.tsx`, near line 3879) answers every delivery with `maybePinToBottom()`, `applyRestoreTarget()` and `scrollTick()`, which is a `useReducer` bump: a render and a commit per member per frame, then a second layout inside the observer loop. The comment on the still-held rule in `tugdeck/src/components/tugways/tug-pane.css` (near line 1408) names this exact cascade as the reason the settle needed a still picture. **(verified, by reading)**

**[F05] The settle already has the cure for this cost class, and the hand does not.** Every settle beat carrying a `height` term marks its frames `data-still-crossing` and writes `--tugx-still-held-height` on the card root (`tugdeck/src/lib/fold-crossing.ts`, `STILL_CROSSING_ATTR`, `STILL_HELD_HEIGHT_PROP`). Under the mark the content box clips, the root is held at a definite height, and a subtree with a definite height that does not change delivers nothing to observe. `at0605` gates it for the settle. The seam drag sets `data-pointer-owned` on its members and nothing else; the doctrine's own hold is absent from the one gesture that changes a member's height sixty times a second. **(verified, by reading)**

**[F06] Every pane is a standing compositor layer, so a resized pane re-rasters in full.** `.tug-pane` carries `will-change: transform` (`tug-pane.css`, near line 317) by the prior animation arc's decision. A CoreAnimation-backed layer whose bounds change is repainted whole, since its contents are drawn relative to its bounds. Two Retina-scale card repaints per frame, more under cascade. **(inference about WebKit's layer implementation, not measured; the sampler in [B06] settles it)**

**[F07] The seam fraction is an inherited custom property on the deck's container.** Rewriting it may re-resolve style for every descendant of the container, which is the whole deck, unless the engine tracks `var()` dependencies per element. **(inference, not measured; same sampler)**

**[F08] The lag is frame debt, not intent.** Pointer samples arrive at display rate while frames overrun. WebKit coalesces the samples, skips rendering updates, and the sash catches up in jumps. The alternation is the judder; the debt is "several frames behind". The baseline pipeline, sample to `requestAnimationFrame` to paint, is one to two frames even when every frame is cheap; whether the rAF hop adds a frame over writing in the pointer handler is a measurement, and [L13] licenses either shape. **(inference from [F03]–[F06]; not sampled)**

**[F09] No instrument exists for this gesture.** `at0543-rail-sashes-are-the-hands.test.ts` drives a real pointer across a sash and asserts the heights it leaves behind; it samples nothing per frame. `deckTrace` has no seam kind. The prior motion arc's lesson stands: a hop report "verified" without a sampler was not fixed. **(verified, by reading and `grep`)**

**[F10] The width drag pays an honest version of the same bill; the height drag's is pure waste.** `handleSidebarResizeStart` in `tugdeck/src/components/chrome/tug-pane.tsx` re-wraps text on every frame, which is why it wraps a resize episode around the gesture. A height change re-wraps nothing: every interior layout, observer delivery and commit a sash drag causes produces a picture identical to holding the interior still and moving the frame's edge over it. **(verified, by reading)**

---

## Decisions {#decisions}

**[B01] A sash drag is a still crossing whose clock is the hand.** At the latch the drag marks every divided member `data-still-crossing` and writes `--tugx-still-held-height` on each card root, exactly as a settle's height beat does; at release it removes both and the interior takes its one layout at the final height. This is the animation doctrine's own form, cost at the gesture's edges and none per frame, reused rather than invented. It rules out any per-card opt-in: the hold is pane-level for the reason the settle's is, so the next expensive card does not judder until someone notices. Held at `seamDragBounds`' upper bound for each member, which the drag already computes, so the interior is laid out once at the largest height it can reach and the moving edge only clips or reveals. A card that declares `data-still-anchor="bottom"` keeps its bottom-hung picture, as it does under the settle.

**[B02] One DOM write per pointer sample is the floor, and it is [L13]'s licensed use.** The hand produces one sample per display frame and something must turn each into one property write. No compliant form gets under this, and the brief does not pretend one exists. Whether that write happens inside a `requestAnimationFrame` callback or directly in the `pointermove` handler is a latency measurement ([F08]) that the sampler answers, not a doctrinal choice; either is a gesture loop that reads input and writes DOM. What the drag may not do is anything else per frame, which [B01] is what removes.

**[B03] The hold is an acquisition and rides every exit path.** [L27]: the mark and the held height go on together at the latch and come off together on `pointerup`, `pointercancel`, and the `finally` that already clears `data-pointer-owned`; the release is idempotent, as the existing one is. [L33]: pointer capture is the horizon, since the browser guarantees an `up` or a `cancel` for a captured pointer. [L23]: a hold that outlives the gesture is a card propped open, which is the failure the settle's own hold is guarded against; the same guard applies here and the arc's test asserts no member is left marked after any exit.

**[B04] Layers stand before the hand arrives; the gesture creates none.** The doctrine forbids a gesture creating or destroying a layer inside the frame the eye is judging. So if the edge is ever moved as a compositor clip rather than as a box size, to close the re-raster in [F06], the clip must stand at rest on every pane at its identity value and the drag only changes its number. Applying a clip at pointer-down is a layer transaction inside the first frame and is refused. This is the same open work the doctrine already names for the settle's height term, giving the division a form the compositor can run; done as standing state it serves the drag and the settle together, and it is a second step gated on [B06]'s numbers, not the first change.

**[B05] The preview stays in the DOM and the store sees one commit.** The drag is a mutation transaction under [L08]'s test: a cancelled or untravelled press leaves no committed value. Every intermediate fraction remains a custom property, the hold is a DOM attribute and never React state ([L06]), and `onCommit` fires once at release as it does today. The arc changes nothing about what is committed or when.

**[B06] The bar is measured on a loaded rail, before and after, by a bench-only sampler.** An app-test drives a real pointer across a rail sash and records per frame the y it injected, the seam's rendered top, and the frame's duration; it brackets the drag with `TugListView`'s existing `data-scroll-displacements` counter and a count of interior commits. The bar: lag of at most one frame, no frame over the display interval, and zero interior deliveries or commits between latch and release. The rail holds a Cards card with real sessions and a Jots card with content, because an empty rail reads clean on either side of any change, which is how the previous deck-motion defect hid. Per-frame rect reads are the doctrine's bench-probe class and live in the test, never the product. The `before` run is recorded in the arc's findings paper; no later message may call the drag improved without both numbers.

**[B07] The same sampler answers the three beliefs before any second step.** [F06] layer repaint on resize, [F07] invalidation scope, and [F08]'s rAF-hop cost are each a delta the sampler can show. [B01] is the right change whichever way they land; [B04] and any change to [B02]'s write site depend on the readings and are not to be built on belief.

---

## Open Questions {#open-questions}

- Whether the frame's re-raster ([F06]) is the residual cost after [B01], or whether holding the interior alone reaches the bar. The sampler's `after` run decides whether [B04]'s clip form is needed at all.
- Whether the seam's `requestAnimationFrame` hop costs a frame of pointer latency in WebKit, where `pointermove` is already aligned to the rendering update. Sampler, [B02].

---

## Non-goals {#non-goals}

- **Removing the per-sample DOM write.** There is no form of a mouse drag the compositor can own. The write is [L13]'s licensed loop, and this brief does not chase a zero it cannot reach.
- **Re-solving the allocation during the drag.** The doctrine records the settled-resize retune as deliberate: continuous re-solving would put the allocator on the gesture's clock. The drag keeps writing fractions and the store keeps committing once.
- **An occlusion bracket for the seam drag.** Two tiled members never pass over each other; `PlaceSeam`'s stated divergence from the reorder drag stands.
- **The width drag.** Its per-frame cost is honest re-wrap and it has the resize episode. Out of scope, though [B04]'s standing clip, if built, may be worth reading against it later.
- **Revisiting the standing `will-change: transform`.** It is the prior arc's [B01] and it is why the re-raster is a fixed cost rather than a spike; if [F06] proves the residual, the answer is [B04], not demotion.

---

## Exit {#exit}

An arc. Its first movement is the sampler ([B06]) and the recorded `before` on a loaded rail, because nothing else in this brief may be called an improvement without it. Its second is [B01] and [B03] together, the hold on and off with the drag's existing exits, plus the `after` run and an exit-path test that no member stays marked. [B04] follows only if the `after` reading shows raster as the residual, and it lands as standing state on every pane rather than as gesture-time promotion. The two open questions close from the sampler's numbers inside the same arc, and the findings paper carries both runs.
