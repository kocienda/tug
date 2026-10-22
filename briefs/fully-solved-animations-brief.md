# Fully-Solved Animations

**Purpose:** Cards now live in their own windows and the host moves them with Core Animation, so the frame-rate ceiling is gone and the bar moves to beauty. The motions still settle into place and then fix themselves up: a second movement, a relayout, a replay of held tells. This brief extends set-up-and-go with the rule that the set-up solves the whole end state, the motion is one set of moves to it, and the land owes nothing. It also fixes the inventory of the motions the product performs so each can be spoken of by name.

---

## Purpose {#purpose}

The user, 2026-10-22:

> Now that cards are in their own windows and we have the full power of CoreAnimation to make animations of cards and the deck, I want to focus on making *beautiful* animations, not just animations that perform decently well in terms of frame rate.
>
> I want to *extend* the concept *set up and go* to include a new concept I want to call *fully-solved animations*. This is in contrast to how animations work now, in that cards often settle into place, and then a fix-up/follow-up set of movements happens. Instead, I want the *set up* portion of *set up and go* to calculate what the end state would look like for any animation, and once the movement starts, it *all completes in one set of moves*.
>
> I also want to develop an *inventory* of the animations we support … so we can speak more specifically about the character and nature of each.

Set-up-and-go (`briefs/set-up-and-go-motion-brief.md` [B01]–[B05], `tuglaws/card-architecture.md`) is a rule about *when* work runs: every cost before the first frame, nothing mid-motion. Fully-solved is a rule about *what the set-up produces*: the complete end state of every surface the motion touches, so the motion is one choreographed move and the land is a hand-back of ownership and nothing else. The test: freeze the last frame of a motion and compare it to the resting state one second later; they are pixel-identical.

---

## Evidence {#evidence}

**[F01] Nearly every arrangement motion is one machine, the settle.** The shell plans beats on paintless stand-ins (`tugdeck/src/components/chrome/settle-engine.ts`, `tugdeck/src/lib/settle-plan.ts`), posts one `cardPlan` through `tugdeck/src/lib/card-plan.ts`, and the host plays it as `CAKeyframeAnimation` tracks for `position`, `bounds` and `opacity` on each card's container (`tugapp/Sources/BodyViewController.swift` `runPlan`, `tugapp/Sources/BodyBeats.swift` `planTrack`). Beat order is prepare, depart, room, shrink, move, grow, arrive (`tugdeck/src/lib/pane-flip.ts`); recipes and durations are in `tugdeck/src/lib/imposer-motion.ts` (crossing 400 ms, shrink and grow 240 ms, arrive and depart fades 120 ms, all scaled by `--tug-timing`). The bones are right; the fix-up lives in what runs after the host's position track ends. **(verified, read)**

**[F02] Every settle runs a land chain that is not empty.** After the host's track ends: `endCrossing` reconciles rails and notifies the shell; the shell receives `landed`, fires `IMPOSER_SETTLE_END`, opens the motion gate and replays the React tells it held (the "content pop" the set-up-and-go brief accepts at `tuglaws/animation-doctrine.md` line 380); the placer takes one more land measurement and re-posts `placeCards`, snapping any refused card (`tugdeck/src/lib/card-placement.ts` lines 31–66); a 250 ms guard (`LANDING_GUARD_MS`, line 611) lands the card by itself if the host never answers. **(verified, read)**

**[F03] A whole-card shrink relays out and repaints after the motion ends.** On `crossingReady` a growing card takes its landing size at once and re-lays out in its own process during the prepare beat; a shrinking card is `heldToLand` (`BodyViewController.swift` line 2015): the page keeps its old size, clipped by the container, and is resized at `endCrossing`. The page then ends its resize episode and restores what it pinned (`tugdeck/src/body/body-main.ts` lines 897–907), and a list view pays its owed pin, restore and extent rebase at `STILL_CROSSING_END`. **(verified, read)**

**[F04] That land is the measured judder.** The set-up-and-go brief's [F02] reads 45–49 ms on a fold or unfold, 35–38 ms on a division and 40–41 ms on a stack, all in the motion's last 100 ms, and its [B03] names the land as the red that brief exists to close. The attribution to the hand-back and owed work is inference there and here; the land frame is still not instrumented (its [F09]). **(verified for the gap; attribution inferred)**

**[F05] The fix-up shapes are not all the same, and several live outside the settle.** Read out of the code: the folded form goes `inert` and `data-card-fold="settled"` only at `FOLD_CROSSING_END` with a one-rAF probe standing in when no crossing is marked (`tugdeck/src/lib/folded-body.ts`); `afterFoldCrossing` handles the compaction cover and the Z2 row occupant; `flashPaneBorderOnSettle` parks the ⌘1 flash ring until the land (`tugdeck/src/lib/flash-pane-border.ts`); the rail drag's release resizes member pages once and then waits on `railLand` or a 500 ms deadline (`BodyViewController.swift` lines 1733–1767); `RESIZE_RETUNE_QUIET_MS = 200` still exists (`tugdeck/src/lib/layout-imposer.ts` line 2525) though the fit brief removed its use; `revealRange` in `tugdeck/src/components/tug-list-view.tsx` places, verifies and re-places up to three writes under a 3 s deadline; the workspace switch's epoch detector waits two silent frames or 400 ms (`tugdeck/src/lib/space-settled.ts`). **(verified, read)**

**[F06] The flow slide is built the other way round.** Its prelaunch move beat launches at `arm` with the hand's velocity, and the React commit lands while the strip is moving (`settle-engine.ts` lines 2150–2280; set-up-and-go brief [F06]). It is the one gesture whose set-up is deliberately not complete before the first frame. **(verified, read)**

**[F07] Two motions have no host-side choreography.** A closing card's `depart` fade runs on the shell's paintless stand-in only; departing frames are not passed to `runCardPlan`, and the placer hides the card at the commit, so the real card cuts out while the survivors close the room (`settle-engine.ts` lines 3395–3440 and 3535–3600). Hiding the sidebars treats the host card the same way. **(verified in code; not confirmed on screen)**

**[F08] The per-card web view makes a solve possible.** A card is its own process, so the set-up can give it the end size, let it lay out and paint off screen, and then start the host's tracks; growth already does this during the prepare beat ([F03]). The host already holds snapshot machinery for the reload freeze (`tugapp/Sources/MainWindow.swift` `freezeForReload`, `thawAfterReload`). **(verified, read)**

**[F09] One chord is misrecorded.** `briefs/resize-sidebars-to-fit-brief.md` [B11] says ⌃⌥⌘R; the registry binds ⇧⌥⌘S (`tugdeck/src/command-registry.ts` lines 2376–2382). The code is right: ⌃⌥⌘ is reserved. **(verified, read)**

---

## The inventory {#inventory}

The grain was settled with the user on 2026-10-22: fold and unfold are two entries because their fix-ups differ, likewise split and unsplit. These are the names the work speaks in.

| Id | Motion | Trigger | Fix-up carried today | Fully-solved end state |
|---|---|---|---|---|
| C1 | Card fold | ⌃⌘Y, View menu | page relayout at the land, `inert` at crossing end, compaction cover, Z2 row occupant | page is at folded size and painted before frame one; the container reveals a snapshot of the start and swaps at the land |
| C2 | Card unfold | same | list reveal re-applies scroll, "unfold's first frames" relayout | end size and scroll target solved in the set-up |
| C3 | Move card to slot | ⌘1–6, slot picker, badge | flash ring parked until the land | the flash is a beat in the choreography |
| C4 | Move card up, down, top, bottom | ⌃⌘↑↓, ⇧ | the land chain | one move |
| C5 | Card open, arrive | ⌘N, show-card, picker | arrival-reveal rule for a card hidden while its sheet settles | arrive waits on `painted`; no late reveal |
| C6 | Card close, depart | close button | real card cuts out, stand-in fades | host fades the real card on the survivors' timeline |
| C7 | Card drag and grip resize | mouse on title or grip | drop lands as a one-card plan; `returnToLanding` if unmoved | already solved; the drop is the set-up |
| C8 | Card activate | click, chords | none | a cut; stays one |
| C9 | Tab drag ghost | tab drag | none | fine as is |
| S1 | Split column | ⌃⌘/ | retiring member held to completion; height term a real tween | both members at final size and painted before frame one |
| S2 | Unsplit, stack column | same | same | same |
| S3 | Column seam drag | mouse on sash | commits on release | already solved |
| S4 | Equalize heights, bullseye, content width | ⌃⌘B, settings | `scaleX` under 20 % distortion else real width; land chain | solved width; no scale stand-in |
| R1 | Rail width drag | mouse on rail edge | pages resized at release, then a 500 ms wait on `railLand` | per `briefs/rail-drag-ghost-brief.md`: nothing moves until release, then a settle |
| R2 | Rail limit spring-back | over-drag release | `finishSpring` re-applies placement | one spring to a known rest |
| R3 | Show, hide sidebars; show left, right rail | ⌃⌘S, ⌃⌘←→ | host card not planned on hide | host carries the hide on the same timeline |
| R4 | Resize sidebars to fit | ⇧⌥⌘S, View menu | both axes as violations; retune constant alive | both axes solved; retune deleted |
| D1 | Flow slide, go to slot | ⌃⌘1–6, wheel, swipe, click | React commit lands mid-slide | the commit is deferred past the land or the slide owns nothing React reads |
| D2 | Workspace switch | activate-space | epoch detector; departing-face flash | one host transaction, per `briefs/switch-hand-over-brief.md` |
| D3 | Zoom | ⌘= ⌘- ⌘0 | placement re-posted | a cut; stays one |
| D4 | Theme switch | menu | none | a snap; stays one |
| D5 | Shell reveal, reload | launch, reload | none | fine |
| B1 | Scroller pin across a crossing | any size crossing | restore at the land | the end offset is solved and written once |
| B2 | Scroll into view | reveal range | up to three verify-and-replace writes | one write from a solved position |
| B3 | Sheets, banners | open, close | none | fine; a sheet exit already rides the settle clock |

---

## Decisions {#decisions}

**[B01] Every motion is fully solved: the set-up computes the end state of every surface the motion touches, the motion is one set of moves to that state, and the land owes nothing.** The phases are commit, solve, go, hand back. Solve is a stage the code does not have today, between the React commit and the plan: each card page is told its end size, lays out and paints off screen, and reports; only then are First and Last rects read and the beats planned. Go moves finished layers under Core Animation. Hand back transfers ownership and does not move, measure, re-pin, replay or relayout anything. This extends set-up-and-go's [B01] and [B04]; it does not replace them.

**[B02] The set-up has a soft limit of 100 ms.** Set-up-and-go's [B02] made the set-up's length a reading, not a bar. This brief keeps it a reading and adds a soft limit: a solve that takes the set-up past 100 ms on the user's deck is a product reading to raise, not a reason to move work back into the motion or the land. The user's ruling: it will not be noticeable in most cases, as long as the movement just works once things start moving. The limit is soft because the alternative, a judder, is always worse.

**[B03] A whole-card shrink is solved by snapshot.** The page takes its end size during the solve, as growth already does. The container shows a snapshot of the card's start face for the motion and swaps to the live page at the hand back. The snapshot route was chosen over a live second web view because folded and stacked content is static for the motion's length and the host already holds snapshot machinery ([F08]); a second live view costs a process-sized budget for content nobody can read mid-fold. `heldToLand` and the clip-and-resize-at-land path go.

**[B04] The land is empty, and that is asserted.** The land instrument set-up-and-go's [B03] asked for is built: the settle's record carries the land frame's duration and what ran in it (React commits, chain fan-outs, resize-episode ends, placement posts, scroll writes). A fully-solved motion has an empty land record and a land of one display period, and that is a harness bar on real transcripts and on the user's deck, not a doctrine paragraph. The content pop of `animation-doctrine.md` line 380 stops being accepted: held tells are solved into the end state or deferred past the hand back where they cannot move anything.

*Revised 2026-10-22, in the arc's fold and unfold step.* "A land of one display period" is read by the settle's own land bar, `LAND_FRAMES_BAR` (1.5 periods) in `tugdeck/src/lib/motion-guard/settle-bar.ts`, not by the plan's "period plus a millisecond". The land's ticks are taken in their frame callbacks, which jitter: the solved fold's shell land read 19 ms with gaps of 19 and 15 against a 17 ms period, with nothing committed, forced, delivered or scrolled in it, so a land that delivered its frame failed a bar meant to catch one that missed it. A missed frame reads about two periods and is still red; the emptiness half of the bar is the zero lists, which are unchanged.

**[B05] The fix-up machinery is removed, not bypassed.** Each entry's "fix-up carried today" column names code that goes when its motion is solved: the placer's land measurement becomes a debug assertion that the host landed where the plan said; `LANDING_GUARD_MS` stays as a safety net that is loud when it fires; `RESIZE_RETUNE_QUIET_MS` is deleted; `revealRange`'s verify loop becomes one write; the fold's one-rAF `inert` probe goes with the crossing it stood in for.

**[B06] The inventory above is the vocabulary.** Work on motion names the entry it touches by its id and name. New motions are added to the table before they are built, with their trigger, their fix-up if any, and their solved end state.

**[B07] The first pass is, in order: C1 and C2, S1 and S2, R4, then D1.** Fold and unfold carry the largest measured judder and the user touches them most; split and unsplit share the shrink-by-snapshot route and the height-tween violation; resize sidebars to fit is the two-axis case and deletes the retune; the flow slide is the one gesture built the other way and needs its own solve. R1 and D2 already have briefs that fit this stage and land through those.

**[B08] The fit brief's chord record is corrected to ⇧⌥⌘S.** Per [F09]; the code stands.

---

## Open Questions {#open-questions}

- **How the solve reports.** Growth today reports `crossingReady` once laid out; a snapshot shrink needs a second message, or a widened one, that says the page is painted at the end size before the host starts the tracks. Whether that is the existing `painted` report reused or a new `solved` message is for the arc to read out of `body-main.ts` and the host's crossing protocol.
- **Whether the flow slide's solve is a deferred commit or a slide that reads nothing from React.** Set-up-and-go's [F06] and the gesture-task brief chose to launch before the commit; fully-solved wants the commit out of the motion. Which of the two the slide can afford at a trackpad lift is a reading to take, not a call to make here.

---

## Non-goals {#non-goals}

- **A live second web view for the shrink.** Rejected for [B03]: cost without a reader.
- **Animating zoom, theme switch, activation, or the workspace switch.** D3, D4, C8 are cuts and snaps by design; D2's cut is kept and its hand-over is the switch brief's.
- **Re-litigating the set-up's length as a hard bar.** [B02] keeps it a reading with a soft limit; a hard bar is what set-up-and-go removed.
- **Touching R1 or D2 directly.** Their briefs stand and already fit the solve stage.
- **Lowering the frame-rate bars.** Set-up-and-go's [B03] mid-motion gap bar stays; this brief adds the land bar beside it.

---

## Exit {#exit}

An arc. The first steps look like: build the land instrument and its bar ([B04]) first, so every later step has a red to turn green; add the solve stage and the snapshot shrink to the crossing protocol and play C1 and C2 through it; carry S1 and S2 on the same route and retire the height tween; solve R4 on both axes and delete the retune; then take the flow slide's reading and solve D1. Each entry's fix-up code is removed in the step that solves it ([B05]). The inventory table is the checklist the arc marks off.
