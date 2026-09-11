# The reveal: restoring a minimized card's transcript and its wave

**Purpose:** Two glitches in the Session card's minimize behavior have one cause — nothing in the deck knows about the *reveal*, the moment a hidden scroller gets its box back. The transcript comes back at the top with follow-bottom released, and an in-flight wave comes back motionless.

---

## Purpose {#purpose}

In the user's words:

> - When I minimize, if I was set on follow-bottom scrolling of the transcript, I should be restore to follow-bottom scrolling of the transcript and the bottom of the transcript when I un-minimize.
> - When I un-minimize and the turn is still in progress, the wave animation does not start moving again. It's stuck motionless. BAD. Must restart animating.

Both are unfold-time failures on a card that was never unmounted. The fold is [D185]'s work, landed and otherwise sound; this is the state the motion leaves behind.

---

## Evidence {#evidence}

**[F01] A minimized card's transcript scroller has no box.** At rest the card writes `data-fold="settled"`, and `session-card.css` takes the view slot out of layout entirely: `.session-card[data-fold="settled"] .session-view-slot { display: none; }`. The `TugListView` inside it stays mounted the whole time — the card never unmounts, which is the premise every finding below rests on. **(verified)**

**[F02] The height ledger already survives the fold; the scroll state does not.** `TugListView` knows the boxless state well and defends against it twice: the cell `ResizeObserver` has an explicit zero-box guard that keeps `0×0` deliveries out of the ledger (`tugdeck/src/components/tugways/tug-list-view.tsx:2828`), and the width observer skips `width === 0` as "a hidden scroller (`display: none` — an inactive card tab), not a width change" (`:3082`). Both defences are about *measurement*. Neither preserves `scrollTop` or the follow-bottom intent. **(verified)**

**[F03] `SmartScroll` has no concept of its box going away.** `grep -n hidden tugdeck/src/lib/smart-scroll.ts` finds nothing on this axis: no reveal path, no box-loss path, no bracket. The browser resets `scrollTop` to 0 when the box is destroyed, and the class is never told. **(verified)**

**[F04] The reveal's own scroll event has the exact shape the idle rule reads as a user gesture.** When the box returns, a deferred scroll event arrives with a large upward delta against an unchanged `scrollHeight` — which satisfies every clause of the `unattributed-scroll-up` disengage in `_handleScroll` (`smart-scroll.ts:1227`). That rule's own comment names the browser clamp as "the exception this rule used to get wrong" and names the defence: the owning component brackets the write with `noteExternalWrite`, "syncing `_lastScrollTop` to the clamped position — so its deferred scroll event arrives with no upward delta and never reaches this rule." The fold brackets nothing. *This is the inference in the brief*: the code paths are read, but the flip has not been caught in the act. The deck trace records every follow-bottom flip with its `source`, so a single reproduction showing `unattributed-scroll-up` at the unfold confirms it — and a different `source` would redirect the fix rather than invalidate it, since the intent is lost either way. **(inference, cheaply confirmable)**

**[F05] The restore vocabulary already exists and is already spelled `atBottom`.** `TugListView`'s region-scroll save writes `meta.atBottom = true` when the list is following (`tug-list-view.tsx:4344`), and its `onRegionScrollSet` restore calls `scrollToBottom(false)` on that meta, which re-engages follow-bottom and keeps the jump-to-bottom affordance hidden (`:3365`). Cold boot, cross-pane mount and HMR all ride it. **(verified)**

**[F06] Minimize rides none of it, because minimize is not an unmount.** The `[A9]` bag is saved when a card's regions are collected and applied by `CardHost`'s `applyRegionScrolls`. A folded card is still mounted and still in its pane, so no bag is ever saved at the fold or applied at the unfold. Nothing restores anything. **(verified)**

**[F07] The stuck wave is inside the transcript, so it goes dark with the view slot.** The in-flight indicator lives in the assistant row's Z1B chrome — `session-card-transcript.tsx:1605` names it directly, in a comment about not remounting cells because that would restart "any in-flight `TugProgressIndicator` wave animation in the assistant row's Z1B chrome". It is not a masthead instrument; it is a cell of the list the fold hides. **(verified)**

**[F08] The wave reads as *present but motionless* by construction.** Each bar carries an inline `transform: scaleY(restScale)` seed written in `tug-progress-wave.tsx`, deliberately equal to the running loop's 0% keyframe "so the animation starts without a jump". A cancelled loop therefore does not clear the glyph — it leaves three bars sitting in the rest pose. What the user is seeing is consistent with the animation never being restarted after the `display: none` cycle, rather than with the element being absent. **(verified as to the mechanism of the appearance; the cause of the non-restart is [F09])**

**[F09] Two candidate causes for the non-restart, and they are distinguishable in one read.** (a) The animation is genuinely not replayed after the `display: none` cycle — with `will-change: transform` promoting each running bar to its own layer (`tug-progress-wave.css`, the `[data-state="running"]` rule), a stale composited layer that keeps painting its last frame is the classic WebKit form of this. (b) The cell is being skipped: the same file already records that "a subtree the engine declines to render does not run its animations at all, whatever `will-change` asked for", and the tail cell's exemption is a single `:last-child` rule in `tug-list-view.css:361` — which holds only while the in-flight row really is the last DOM cell of the rendered window. The discriminator is `getAnimations()` on a bar at the unfold: `"running"` means the animation is alive and the pixels are stale; `[]` or `"idle"` means it was cancelled and never replayed; the element not being found at all means this is a windowing symptom of [F03]/[F04] rather than an animation defect. **(inference; the check is the confirmation)**

**[F10] The reveal is the seam nobody owns.** `session-card.tsx`'s fold effect knows about *the fold* — it writes `data-fold`, lands `inert`, and watches `transitionend` with a settle-scaled backstop. `TugListView`'s observers know about *the box* — they can already see both edges of the `0 → real` transition and each independently declines to act on it. Neither knows about the reveal, which is the moment both of these glitches want something done. **(verified)**

---

## Decisions {#decisions}

**[B01] `TugListView` owns the hidden-box cycle.** When the scroller loses its box, it records `scrollTop` and `smartScroll.isFollowingBottom`; when it regains one, it re-applies — `scrollToBottom(false)` if it was following, the remembered position otherwise. The observers that detect both edges are already there ([F02]), so this is memory added to a cycle the component already tracks, not a new mechanism. It fixes every hidden-box path at once rather than the fold alone, it needs no new API on the transcript and no new attribute on the card, and it requires no coordination between two files that today know nothing about each other ([F10]).

**[B02] The re-apply is bracketed with `noteExternalWrite`.** Without it the restore races the reveal's own clamp event, which the idle rule reads as a gesture and answers by releasing follow-bottom ([F04]) — so an unbracketed restore can be undone a frame after it lands. The bracket is the defence the rule's own comment prescribes; this is using it, not inventing it.

**[B03] The requirement is "restore where you were", with follow-bottom as the case that also re-engages.** The report names the follow-bottom case, but a reader parked forty turns back in history has exactly the same complaint waiting for them, and a fix that returns only the followers to their place leaves the same bug wearing different clothes. [B01] covers both for the same cost, so it covers both.

**[B04] The wave is restarted at the reveal, in DOM.** The same seam [B01] introduces carries it: at the reveal, force the running bars' animations to restart — `getAnimations()` then `cancel()` + `play()`, or the attribute round-trip (clear `data-state` for one frame, write it back), which is the same gesture with less API surface. The loop itself stays a CSS `@keyframes` ([L13]) and the restart is appearance written to the DOM, never React state ([L06]).

**[B05] The wave's diagnosis gates its remedy; it does not gate the scroll work.** The `getAnimations()` check in [F09] is run before anything is changed in `tug-progress-wave.css`, because the answer decides whether the layer is implicated at all. [B01]–[B03] are independent of that answer and do not wait for it. If the check indicts the cell rather than the animation, [B04] may turn out to be unnecessary — which is itself a good reason to run the check first.

**[B06] `display: none` stays.** Keeping a live, laid-out `TugListView` behind every minimized card in a wall is the cost the current rest state exists to avoid — the CSS says so in as many words, "takes the transcript's list view out of layout entirely". A rest state that made both glitches impossible by construction would be paid for on every folded card, every frame, forever.

---

## Open Questions {#open-questions}

- **Does the inactive card tab have this defect today, and does anyone depend on its current behavior?** [F02]'s own comments name the tab switch as the case that motivated the boxless guards, which suggests a tab switch also lands its transcript at the top. If it does, [B01] fixes it for free and the change is strictly good. If it does not — because the tab switch unmounts and rides the `[A9]` bag ([F05]/[F06]) — then [B01] adds a second restore path on top of an existing one, and the two must not fight. One reproduction settles it.
- **Should a non-following reader's position be restored as a raw `scrollTop` or as an anchor?** A session keeps streaming while it is minimized, so cells above the remembered position can change height while the box is gone, and a raw pixel offset is stale by exactly that much. `SmartScroll` already has the better instrument — `setRestoreTarget` with a `makeAnchorResolver` — and the region-scroll restore path uses it for precisely this reason. Whether the fold's horizon is long enough to need it is a judgment about how much a folded transcript actually moves, which nobody has measured.

---

## Non-goals {#non-goals}

- **The card brackets the fold itself.** Considered: `session-card.tsx`'s fold effect already has both moments, and would read the transcript's follow state before writing `data-fold="settled"` and call `scrollToBottom()` after clearing it. Rejected because it fixes only the fold, and because it leaves the `unattributed-scroll-up` misread in place — the restore still has to win a race against the reveal's clamp event, so it needs [B02] anyway, and with [B02] it is most of [B01] written in a worse place. It would also need a new `isFollowingBottom` read on both the transcript handle and the list view's.
- **Routing the fold through the `[A9]` bag.** Considered: collect the region-scroll bag at the fold, dispatch `tug-region-scroll-set` at the unfold, and let the existing `atBottom` branch do the work — zero new restore logic. Rejected: it routes a 400ms in-card motion through the cross-session persistence protocol, and `CardHost`'s applier brings a `MutationObserver` retry loop that exists for cold-boot conditions which do not hold here. Recorded because it reuses the most existing code, and rejected for the same reason.
- **Keeping the view slot in layout at rest.** A zero-height clipped box instead of `display: none` would make both glitches impossible. See [B06] for the price.
- **Dropping `will-change: transform` from the running bars.** Only on the evidence of [F09], and even then it trades this glitch for the streaming-load stall the promotion was added to prevent. A reveal-time restart is the cheaper trade.
- **The masthead's beat, the Observer, and the pulse.** A separate piece of work with its own brief (`briefs/session-narration-consolidation-brief.md`). Nothing here touches what the card *says* it is doing — only what its transcript and its wave do across a fold.
- **Retuning the fold's motion.** The transition, its settle clock, its `transitionend` backstop and its `inert` handling are all as landed and are not in question.

---

## Exit {#exit}

An arc, in one landing with a diagnostic step in front of it.

The first move is the check in [F09] — one reproduction on a live turn, reading `getAnimations()` on a wave bar at the unfold and the deck trace's follow-bottom flip `source` at the same moment. It costs one run and it decides both the wave's remedy ([B05]) and whether [F04]'s inference holds.

The body of the work is the reveal seam in `TugListView` ([B01]–[B03]): remember on box loss, re-apply on reveal, bracket with `noteExternalWrite`. The wave's restart ([B04]) hangs off the same seam and lands with it.

Verification is on the running app, on a card with a turn in progress: minimize while following the bottom and unfold — the transcript is at the live edge, the jump-to-bottom affordance is hidden, and the wave is moving. Then the same with the transcript parked in history, which must come back where it was ([B03]). The open question about the inactive card tab is answered by the same corpus if it is answered at all.
