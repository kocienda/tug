# The land preserves the bottom

**Purpose:** A session card whose transcript is following its bottom hops at the land of a settle: the picture holds through the move, then jumps off its bottom for a frame and snaps back. Five fixes have each closed one path to the hop and left the next one open. This brief makes the engine's hold release restore the bottom itself, unconditionally, so no listener has to.

---

## Purpose {#purpose}

The user's report, 2026-10-09: "We have regressed on adding a session card to a split column. When the card settles, it *flashes* the transcript, hopping it between two scroll locations in rapid succession. It must not do this." Caught again 2026-10-10 on the user's own release deck with ⌘1 (`assign-slot`) moving a card into a slot holding one existing card, at View › Zoom 90%: "The card holds its position during the move, then lands, hops, then settles."

After the listener fix landed as `4388bf95c`, the user: "This fix is not total or complete. Cards still hop while they settle. Why can't we hold the position and prevent this *comprehensively*." Then: "I want the most correct and reliable fix."

---

## Evidence {#evidence}

**[F01] The hop is one event: a height change with no same-task scrollTop correction** — A transcript is a scroller taller than its box. The browser keeps scrollTop measured from the top, so when the scroller's `clientHeight` changes the bottom edge of the view moves. If no scrollTop is written before the next paint, one frame shows the content off its bottom and the next shows the correction. Read off the user's deck trace ring 2026-10-10: the mover's `clientHeight` went 949→241 in one frame with scrollTop unchanged, the land frame painted 708 px off bottom (`d=708`), and a React-driven `pinToBottom` wrote `scrollTop` +708 about 63 ms later. **(verified)**

**[F02] A shrinking card is held at its OPEN height through the motion and re-laid out at the land** — `settle-engine.ts` ~3360–3410: a frame that grows is a *settled* still crossing (`settleStillCrossing`, held at its final height, pinned in the set-up, nothing left to do at the land). A frame that shrinks is held at the larger of its two content heights (`markStillCrossing`) and hung from the box's bottom when the card declares `data-still-anchor="bottom"` (`tug-pane.css` ~1949: `position: absolute; inset-block-end: 0`). The comment gives the reason: held at its final height, a shrinking following transcript would show hundreds of pixels of bare background under the chrome at the first frame. So the shrink pays its land, and the land is where the height changes. **(verified)**

**[F03] The release does not pin; it dispatches an event and hopes** — `fold-crossing.ts` `endKind`: removes `data-still-crossing`, clears the held-height property, then dispatches `tug-still-crossing-end` on the pane frame with `bubbles: false`. The pin is paid, if at all, by `tug-list-view.tsx` `onStillCrossingClosed`, which runs only when the list view's listener is bound to the frame the event fires on, and then only when `answeredSizeRef` is non-null and differs from the current size. Every one of those conditions is a way to skip the correction. **(verified)**

**[F04] The correction channel the gate would otherwise provide is deliberately closed at the land** — The motion gate holds ResizeObserver deliveries and React tells until three paints after land, by design (set-up-and-go, `briefs/column-pin-at-the-set-up-brief.md`). So the one generic listener that would notice any height change is silenced in exactly the window where a shrink's height changes. **(verified, read from the code and the prior brief)**

**[F05] Five fixes have each added a listener or a guard; none added an invariant** — The land pin, the settled-crossing announce, the extent rebase owed to the end, the container observer's answered size, and the pane-frame listener re-bound in capture (`4388bf95c`) are each a path that *reacts* to a height change. The 26 px whale residue (at0708's whale arm, pre-existing) is the same class. The user's report that cards still hop after `4388bf95c` is consistent with another unlistened path, and the harness has never reproduced the user's exact cross-pane gesture. **(verified that the fixes are reactive; the specific path behind the latest hop is NOT identified)**

**[F06] WebKit offers no scroll anchoring** — Chrome and Firefox anchor scroll position across layout changes; Safari does not implement `overflow-anchor`. There is no browser-level floor under any of this; the correction has to be Tug's. **(verified, platform fact)**

**[F07] The hold's only remover is one function, and both doors go through it** — `endKind` in `fold-crossing.ts` is the sole place `data-still-crossing` comes off; the settle engine's release loops (`crossings.end(...)` ~4414, 4425) and the sash drag in `deck-canvas.tsx` (~736, `endStillCrossing`) both reach it. `settleStillCrossing` is the one other place a standing held height changes synchronously (a retarget lowers it). **(verified)**

**[F08] The declaration of which edge a card hangs from already exists and is already DOM** — `session-card-transcript.tsx` ~3199 writes `data-still-anchor="bottom"` on the card root while the transcript is following, and removes it otherwise. The CSS hold rule keys on it. The scroller itself is `[data-slot="tug-list-view"]`. **(verified)**

---

## Decisions {#decisions}

**[B01] The thing that changes the height restores the position, in the same synchronous task, unconditionally.** The hold release in `endKind` (still kind) becomes: for each `[data-slot="tug-list-view"]` scroller under a `[data-still-anchor="bottom"]` root in the frame's content box, read its distance from bottom (`scrollHeight - scrollTop - clientHeight`); remove the mark and the held-height property; force one layout with a `clientHeight` read; write `scrollTop = scrollHeight - clientHeight - distance`, clamped at 0; and only then dispatch `tug-still-crossing-end`. No paint can fall inside one task, so there is no frame in which the height is new and the scrollTop old. This replaces hope with an invariant. A top-anchored scroller is left alone: keeping scrollTop is exactly what a top anchor wants and the browser already does it.

**[B02] `data-still-anchor` is the one truth for which edge to preserve.** The CSS rule that hangs the held picture from the bottom and the JS restore that keeps the bottom after the hold read the same attribute. A card that declares bottom gets both; one that does not gets neither. No second registry, no ref on the list view, no engine-side map of which scrollers follow.

**[B03] `settleStillCrossing` gets the same bracket.** A retarget that lowers a standing held height is a synchronous height change on a bottom-hung interior and hops by the same mechanism. The preserve-across-change primitive is one function (`preserveBottomAcross(frame, fn)` or equivalent) that both `endKind` and `settleStillCrossing` wrap their geometry writes in.

**[B04] The list view's crossing listeners stay, but stop being load-bearing for the pin.** `onStillCrossingClosed` and `onStillCrossingSettled` also pay the extent rebase, the catch-up, and the re-window; those remain theirs. Their `maybePinToBottom` becomes idempotent on an already-pinned scroller. Thinning them is a later act, after the invariant has held on the user's deck for a while; this arc does not remove them.

**[B05] The shrink keeps its open-height hold.** [F02]'s reason stands: a following transcript held at its final height would bare the top of the box at the first frame. The hold is right; only its release was wrong. This arc changes the release, not the hold.

**[B06] Verification is a sampled invariant, red before and green after, plus the user's deck.** A regression app-test arms a per-frame recorder before the gesture (see memory `settle-frames-row-misses-the-lead`) and, on a following transcript across a column join and a slot assignment that shrink the card, asserts that distance-from-bottom never exceeds a few px on any sampled frame from arm to three paints past land. It must be red on the current tree under `tugtool file probe` with the change reverted and green with it; a test that was never red proves nothing (memory `motion-bug-needs-a-sampler`). Separately the change is built into the user's deck and the user repeats the ⌘1 move at 90% zoom with the passive recorder armed; the trace ring is what has caught this bug every time and is the final word.

---

## Open Questions {#open-questions}

- **Whether the user's latest hop is this mechanism or a different one.** [F05]: the hop after `4388bf95c` is unexplained by trace. [B01] removes the whole class of unlistened height changes at the hold release, so the question does not change what is written; it changes whether the user's deck is green afterwards. If the deck still hops after this lands, the next read of the trace ring looks for a height change outside any still crossing (a React commit, a zoom change, a ResizeObserver backlog flushing when the gate opens), and the same primitive is applied at that site.

---

## Non-goals {#non-goals}

- **A reversed-flex scroller (`flex-direction: column-reverse`).** It would get bottom anchoring from the browser for free, but WebKit has long-standing wheel and negative-scrollTop defects with reversed scrollers, and `tug-list-view.tsx` is a large top-down virtualizer. That is a rewrite with its own bug tail, not a fix.
- **Holding a shrink at its final height from the arm.** Rejected for [F02]'s reason: bare background under the chrome on the first frame of a following transcript.
- **Another listener, or another guard on an existing one.** [F05]: that is the shape of all five prior fixes, and each left a path open.
- **Removing the list view's crossing listeners in this arc.** [B04]: they carry work beyond the pin and are thinned later, after the invariant has proved itself.
- **The 26 px whale residue.** Pre-existing, caught by at0708's whale arm only where a local corpus is harvested, and a product of extent-rebase clamping rather than the hold release. [B01] preserves whatever distance a scroller had, so it neither fixes nor worsens it. Its own brief if it is to be fixed.
- **Tabs.** Nothing here touches or depends on tab machinery.

---

## Exit {#exit}

An arc. The shape of its first steps:

1. Add the preserve-bottom primitive to `fold-crossing.ts` and wrap the still-kind geometry writes in `endKind` and `settleStillCrossing` with it ([B01], [B03]), keyed on `[data-still-anchor="bottom"]` and `[data-slot="tug-list-view"]` ([B02]). Dispatch of `tug-still-crossing-end` moves after the restore.
2. Write the sampled regression app-test ([B06]) with `@covers` on `fold-crossing.ts`, `settle-engine.ts` and `tug-list-view.tsx`; prove it red with the primitive reverted under `tugtool file probe`, then green.
3. Run the derived selection (`just app-test-changed`), with at0605, at0689, at0333 and at0708's slice arm in it, and name at0708's whale arm as a known red that leaves the batch.
4. Build into the user's deck; the user repeats the ⌘1 move at 90% zoom with the passive recorder armed ([B06]). The arc is not done until that trace shows no frame off the bottom.
