<!-- brief-skeleton v1 -->

# Workspace switch: cut to the arriving workspace at once, and never show a piece of the departed one

**Purpose:** A workspace switch on the user's deck is often slow, shows pieces of the departed workspace over the arriving one, and shows a loading wave that does not move. The skeleton scheme that was built to prevent all three is running, and its fast path fails on most switches.

---

## Purpose {#purpose}

The user, 2026-11-12, with a screenshot of the Main workspace carrying a light-theme card and half a light-theme Workspaces card from another workspace:

> Two prtty big issues with workspace switches:
> - wave animation on workspace restore that's in the middle of restoring cards doesn't animate
> - There's often a *long delay* while switching workspaces.
> - Stale content showing through as I switch between workspaces. This is *really really bad*.
>
> Look... didn't we make a skeleton scheme that should make it *quick* to switch workspaces? WHY ISN'T IT WORKING?

And, asking for this brief:

> Keep in mind that the keys are:
> - *responsiveness* to move to the new workspace skeleton; and
> - *correctness* in not showing any stale bits of the departing workspace

Two properties are wanted, in those words. Responsiveness: the gesture is answered by the arriving workspace, drawn whole, as skeletons where its cards are not ready. Correctness: once the arriving workspace is on screen, nothing of the departed one is. The scheme of `briefs/workspace-skeletons-brief.md` aimed at both and added a third aim on 2026-11-09, that a switch onto ready pages shows no skeleton at all. The mechanism built for that third aim, a held picture of the departed workspace, is what now costs the first two.

---

## Evidence {#evidence}

All log readings are from `~/Library/Application Support/Tug/instances/release-main/Logs/tugapp.log.2026-11-09` through `2026-11-12`, the user's own running app. Nothing was driven or instrumented on that app. The code was read at `a45bb94de`.

**[F01] The switch hold reached its deadline on 51 of 75 switches on 2026-11-12.** `BodySwitchHold` (`tugapp/Sources/BodyFaceHandOver.swift`) logs `switch hold … outcome=landed|deadline`. By day, landed against deadline: 99/12 on Nov 9, 81/17 on Nov 10, 42/7 on Nov 11, 24/51 on Nov 12. The deadline share went from 11–17% to 68% in one day. **(verified, log)** What changed on Nov 12 was not found; the deck grew to five workspaces and 38 body views, and several arcs landed on Nov 11 and 12.

**[F02] The hold has almost no margin when it does land.** Across Nov 10 to 12 the landed holds stood 144 to 309 ms, median about 210 ms, against `deadlineMs = 300`. The arc that built the hold read 139 ms on its harness deck (`briefs/workspace-skeletons-brief.md` [B06]). So on the user's deck even a successful switch onto ready pages is a fifth of a second of frozen picture. **(verified, log)**

**[F03] The shell's switched frame is the slow party.** The hold lifts only when three things are true: the shell's snapshot has answered, no hand-over is pending, and every named page has painted as shown (`BodySwitchHold.check`). The hand-over's own snapshot of the shell took 46 to 242 ms when it answered, and passed its 250 ms deadline three times on Nov 12 (`hand-over past its horizon`). Most deadline records list every arriving card as waiting, which is what the log prints when the first two guards never passed, because the waiting list is only filtered after them. A minority list one card, most often `30a2aef2`, where the shell rendered in time and one page did not confirm. **(verified, log and code; which of the two shell guards failed on a given switch is not logged)**

**[F04] At the deadline the picture lifts onto whatever is beneath it.** `BodySwitchHold.lift("deadline")` removes the held picture unconditionally. It hides nothing, shows nothing and covers nothing. If the shell's frame or the placement has not landed, what is beneath is partly the departed workspace. **(verified, code)**

**[F05] The shell's placer keeps departing views on screen on purpose, for two shell paints.** `heldForThePaint` (`tugdeck/src/lib/card-placement.ts`) posts a departing view as still shown when it does not meet a drawable face and no arriving view takes its exact rect, and `hideNow` releases it after two `scheduleAfterPaint` hops. That was built so a view is never taken down before the shell's frame composites. With the shell slow ([F03]), those two paints are long, and the kept views outlive the held picture. **(verified, code)** The screenshot fits this reading: the departed workspace's Session card stands in a slot whose arriving card had not painted, and the top of its shorter Workspaces card stands over the arriving, taller one. **(inferred: no frame recording of that switch exists, and the log has no line for a held view)**

**[F06] A page shown from sleep keeps every loop stilled until its catch-up ends.** `installBodyDormancy` (`tugdeck/src/body/body-dormancy.ts`) calls `stillLoops(true)` at sleep and `stillLoops(false)` only in the `wake` act, which runs after the session's catch-up bracket closes. Stilling sets `--tug-loop-iterations: 0`, which draws a loop at its base style: visible and motionless (`tugdeck/styles/tug.css`). A made-ahead page is declared dormant the moment it paints (`applyVisibility`, `tugapp/Sources/BodyViewController.swift`), and any page hidden five minutes is dormant, so nearly every arriving page passes through catch-up with its wave still, for exactly the time it is restoring. **(verified, code; not observed live)** A second suspect is the shell's own loop pause for hidden layers (`tugdeck/src/components/chrome/space-layer-loops.ts`), which pauses a stand-in's wave that starts in a parked layer and has stranded loops before (`at0682`).

**[F07] Make-ahead runs against the user after launch.** On the 22:04:45 launch, parked workspaces' pages were still being made 28 s later (22:04:51 to 22:05:13), eight at a time when a switch widens the lane. The switch that produced the screenshot was made about seven seconds after the 14:47:50 launch, while the third workspace's pages were mid-make. `installMakeAhead` (`tugdeck/src/lib/body-make-ahead.ts`) waits for a second with nothing loading and does not yield to a switch. **(verified, log and code)**

**[F08] Pages churn, and messages go to pages that cannot hear.** Nov 12 logged 509 cold page starts, 184 `evicting … cause=hidden` that make-ahead then makes again, 818 `session_unknown` and 744 `bus_undeliverable` console errors. Only 12 of the 75 holds had any such error within two seconds before the lift, so the errors are not shown to cause the timeouts. **(verified, log)**

**[F09] The page's confirmation costs at least five frames by construction.** A page shown again waits `SHOWN_QUIET_FRAMES = 3` animation frames with its deck still, capped at 120 ms (`sayDrawnWhenQuiet`, `tugdeck/src/body/body-main.ts`), and the host then counts `liftFrames = 2`. The wait is asked of every arriving page, including one that never slept and whose workspace facts did not change. **(verified, code)**

**[F10] The existing judges cannot see any of this.** `at0791` and the row-44 judges run on a harness deck where the hold lands in about 140 ms. No judge delays the shell's frame past either deadline, so the deadline paths of [F04] and [F05] are unexercised. **(verified, read)**

---

## Decisions {#decisions}

**[B01] Responsiveness is a bar on the cut: the arriving workspace is on screen, whole, within a fixed short time of the gesture, whatever state its pages are in.** Whole means every arriving pane shows one of three things: its live page, its own last frame, or its skeleton. The cut never waits for a page to confirm and never waits for the shell beyond that bar. The bar is proposed at 100 ms on the user's deck, six frames, and the arc sets the final figure from its first reading. This is the first of the user's two keys, and it is what [F02] shows the present scheme cannot give even when it works.

**[B02] Correctness is a property of one host transaction, not of timing.** When the cut happens, on time or at its bar, a single `CATransaction` hides every body that is not the arriving workspace's, shows every arriving page that is ready, and stands a face or the card's last frame over every arriving pane that is not. After that transaction nothing of the departed workspace can be on screen, because nothing of it is in the layer tree as shown. This replaces [F04]'s unconditional lift. It is the second key, and it holds however slow the shell is.

**[B03] While a switch's cut is pending, the placer holds no departing view for the paint.** [F05]'s two-paint hold exists to cover the shell's frame, and during a switch the host's own cover does that job. The switch's placement posts every departing view hidden, and the host hides them in [B02]'s transaction. `heldForThePaint` stays as it is for a close, a fold and a tab change, which have no cover.

**[B04] This reverses the 2026-11-09 rule that a switch onto ready pages shows no skeleton.** `briefs/workspace-skeletons-brief.md` [B06] records "no gaps": a made-ahead switch goes from the departed picture straight to the finished one, and a skeleton is not allowed. Under [B01], a pane whose page has not confirmed by the bar shows its last frame or its skeleton, and lands on its own page when ready. The reversal is taken from the user's words on 2026-11-12, "responsiveness to move to the new workspace skeleton", read as: a prompt cut onto skeletons beats a held departed picture. That reading is the author's and is the first thing to correct if wrong. [B05] of that brief stands and is strengthened: every frame is the departed workspace, or the arriving one in live pages, last frames and skeletons, and never a mix.

**[B05] A page's own last frame is preferred to a bare skeleton.** Where the host can hold a parked page's last picture, the cut stands that picture over a page that has not confirmed, and swaps to the live page when it does. The change at the swap is then whatever moved while the page was parked, usually nothing. The skeleton is for a card with no picture: never made, or evicted without a cover. What this costs in memory is an open question below.

**[B06] A page that is already current is shown without being asked to confirm.** A page that never went dormant since it was last shown, and whose workspace facts have not changed, is drawn as it will be shown. The three-quiet-frames wait of [F09] is kept only for a page that slept or whose facts moved. This removes the common case from the wait rather than tuning the wait.

**[B07] The hold reports why it ended.** The host's `switch hold` line gains the time to the shell's frame, the time to the first placement, whether a hand-over was pending, and each named page's shown-to-confirmed time. It is permanent logging, not an instrument added for one run. [F03] could not say which guard failed, and [F01]'s one-day regression cannot be explained without it.

**[B08] The shell's work after a switch is cut to what the cut needs, found by reading and not by guess.** The first act is a recorded switch session on the user's real deck with [B07]'s line and the deck trace on. The suspects it tests: publishing deck, spaces and theme facts to all 38 pages on every switch; the revive and restore passes running in the switch's task; and the traffic behind [F08]'s errors. What the reading names is moved off the path between the gesture and the cut.

**[B09] Make-ahead yields to the user.** It stops asking for pages when a switch begins, resumes only once that switch has fully landed and the deck has been idle again, and does not widen the lane on its own account. A user who switches during launch gets that workspace's pages first and the rest after.

**[B10] A page's loops run from the moment it is shown.** `stillLoops(false)` moves from the `wake` act to the `catch-up` act, so a card restoring its session shows a moving wave. The session subscription and the withheld surface keep their present order. If [F06]'s second suspect is the cause instead, the shell's stand-in wave is fixed where it stalls; the judge in [B11] reads both.

**[B11] The judges run on a deck that is slow the way the user's is.** New judges, each red before its fix: with the shell's frame delayed past the bar, every frame is the departed workspace or the whole arriving one; with one arriving page never confirming, its pane shows its last frame or skeleton and no departed view; the cut lands within the bar with the shell delayed; a wave on a page mid-catch-up moves, and so does a stand-in's wave on a switch into a workspace mid-make. The delays are harness knobs beside `bodyDelays.contentPaintDelayMs`. And the app is looked at: a recorded switch on the real-shaped deck, frames in the arc's record, before a join is offered, as `briefs/workspace-skeletons-brief.md` [B08] required.

---

## Open Questions {#open-questions}

- **What regressed on 2026-11-12.** [F01] shows a step from about 15% to 68% in a day. [B07]'s line and [B08]'s reading should name it. If it is one change, that change may be fixed on its own ahead of the rest.

- **Whether the host can hold a last frame for every parked page.** [B05] wants one per card. Covers exist for evicted cards (`tugapp/Sources/BodyCovers.swift`) with an age and a budget (`cover dropped … why=aged|budget` in the log), and a snapshot cost 18 to 188 ms per card in today's log. Whether to take the picture at park time, and what 38 of them cost, is read by the arc. If it does not fit, the fallback is the skeleton, which [B01] already allows.

- **Whether the held picture survives at all.** Under [B01] to [B03] the host's cut is one transaction it can run as soon as the placement arrives, and the shell's stand-ins beneath are the same picture as the host's faces. The held picture may then be needed only for the frames between the shell's commit and the placement, or not at all. The arc decides from the frame recording; either answer satisfies this brief.

- **The wave's actual cause.** [F06] is read from code. The judge of [B11] settles which of the two suspects it is.

---

## Non-goals {#non-goals}

- **Raising the 300 ms deadline.** It would trade a torn frame for a longer frozen one, against the first key, and [F02] shows the wait is already too long when it succeeds.
- **A sheet, cover or dissolve over the window.** Ruled out by `briefs/workspace-skeletons-brief.md` non-goals and `at0640`'s retired cover, and unchanged here. [B02]'s faces and last frames stand per pane, in the panes' own places.
- **Removing the reveal set.** A cold switch's skeletons still land their real cards as one picture (`BodyRevealSet`, [B03] of the skeletons brief). This brief changes the cut, not that landing.
- **Removing make-ahead.** It is what makes most arriving pages ready. [B09] only makes it yield.
- **Changing the dormant or eviction clocks.** [F08]'s churn is noted and not acted on, unless [B08]'s reading shows it on the switch's path.
- **Fixing the `session_unknown` and `bus_undeliverable` errors for their own sake.** They are evidence here; they get a fix in this work only if the reading puts them between the gesture and the cut.

---

## Exit {#exit}

An arc. First, [B07]'s logging and [B08]'s recorded reading on the real-shaped deck, which also answers what regressed. Then [B11]'s judges written red with the shell's frame delayed. Then the cut itself, [B02] with [B03], which is the correctness key and must land before anything is made faster, so that a fast torn frame is never the intermediate state. Then [B01]'s bar with [B06], and [B05] if its memory reading allows. Then [B09] and [B10], which are independent of the rest. Last, the recorded look at a real switch in the built app.
