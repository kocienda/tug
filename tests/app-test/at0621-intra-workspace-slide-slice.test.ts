/**
 * at0621-intra-workspace-slide-slice.test.ts — an activation INSIDE a
 * workspace slides, and never fades; the slice arm.
 *
 * Split from `at0621-intra-workspace-slide`, one file per transcript arm, each
 * its own launch: the slice here, the whale in
 * `at0621-intra-workspace-slide-whale`. The sampler, the fixture and the
 * claims are one body in `intra-workspace-slide-fixture.ts`; the argument for
 * all of it is below.
 *
 * ## What the plain gesture owes
 *
 * Moving the reader from one card to another in the same workspace is an
 * ordinary arrangement change: the strip travels, every frame glides to where
 * the commit puts it, and nothing appears or disappears. A report said it had
 * regressed into a FADE — cards blinking in from nothing instead of sliding
 * into place — and this file is what that report was chased with.
 *
 * ## The mechanism this file went looking for
 *
 * One ref that can outlive the settle that filled it.
 * `pendingArrivalsRef` holds the pane ids a settle is keeping invisible until
 * their arrive beat comes round, and `arm`'s First pass skips every id in it:
 * a frame still arriving is not on screen as far as that settle is concerned,
 * so it has no First rect to measure. The Last pass then walks the shown
 * frames again and treats **any frame with no First rect as an arrival** —
 * held at inline `opacity: 0`, faded up as the chain's last beat.
 *
 * That is exactly right while the arrival is real, and exactly wrong once it
 * is not. The set is cleared in one place, `releaseSettle`, and `arm`'s
 * `"cut"` branch — the spelling a WORKSPACE SWITCH commits under — returns
 * before it ever reaches one. So a card caught mid-arrival when the user
 * crosses to another workspace leaves its pane id in the set.
 *
 * The settle's window timer does eventually collect it — about a second later,
 * from a wedge guard rather than from a correctness path — which is why this
 * is a hazard rather than the observed defect. See the second leg below.
 *
 * ## The sweep
 *
 * The answer to that hazard is in the switch layout effect in
 * `deck-canvas.tsx`, which
 * already runs on every change of `spacesSnapshot.activeSpaceId`. It also drops
 * from
 * `pendingArrivalsRef` every pane id whose frame is no longer among
 * `SHOWN_PANE_FRAMES`, running that id's registered restorers first — the
 * restorers are what hand back the inline `opacity: "0"` the hold wrote, and
 * dropping the id without them would leave the frame invisible rather than
 * merely faded.
 *
 * It sits ABOVE the effect's early returns, because a stale pending arrival is
 * stale whether or not an epoch is opening. A first show and a re-activation of
 * the workspace already on screen are precisely the paths on which the id would
 * otherwise be stranded with its frame still held at zero.
 *
 * ## The two legs
 *
 * The first leg is the plain gesture with no history behind it: four cards in
 * a four-up flow deck, the reader walked from slot 1 to slot 4. It is held to
 * the whole bar — the strip travelled, and no frame anywhere dipped below full
 * opacity or wore an inline hold at any sample.
 *
 * The second stages the precondition — a card opened into the workspace so a
 * settle with a real arrival is in flight, a workspace switch landed during
 * that arrival, a switch back, then the same walk.
 *
 * **It used to record a mass fade, and the sweep was not what answered it.**
 * Every resident frame of the arriving workspace, the Layout rail included,
 * was held at inline `opacity: 0` on the switch back, with five departure
 * ghosts minted for the workspace being left. The trace said why, and it was
 * not a stale pending arrival: the switch's SECOND commit — `activateSpace`
 * step (7)'s `activateCard`, outside the swap batch — armed a `"cross"` settle
 * with `outcome: "carried"`, and that arm's First pass read the workspace
 * being left while its Last pass read the one arriving. Five panes with a
 * First rect and no survivor are five departures; six with no First rect are
 * six arrivals.
 *
 * That was a switch-epoch problem rather than a settle-registry one, and
 * `data-space-switching` is what closed it: the second commit's arm now reads
 * `landing: "cross", outcome: "declined"`, and both legs hold the same bar.
 *
 * **The claims are scoped to the RESIDENT frames** — the panes on screen
 * before the gesture began. The text card the precondition opens is a genuine
 * arrival and is genuinely supposed to fade in; a test that refused every hold
 * would pin the absence of a feature. What is pinned is that a frame which
 * never left the screen is never treated as arriving.
 *
 * Both legs also read the canvas **at rest** — no frame left wearing an inline
 * opacity, none computing below 1, no departing target still marked. That is the claim
 * the sweep itself can fail: an id dropped from `pendingArrivalsRef` without
 * running its restorers leaves its frame invisible for the life of the canvas,
 * which a mid-flight sampler cannot tell from a hold about to be handed back.
 *
 * The walked workspace's four cards are Session cards bound to REAL resumed
 * transcripts (`real-transcript-fixture.ts`), on two arms: the slice
 * everywhere, and in the whale arm the walk's two ends carry the corpus's
 * whale. The strip carries what a user's strip carries, so a frame lost to a
 * card's own work under the slide is a frame lost here. The other workspace
 * keeps its plain cards: it is only ever crossed to and back.
 *
 * @family at0621-intra-workspace-slide
 * @covers tugdeck/src/components/chrome/settle-plan.ts
 * @covers tugdeck/src/components/chrome/settle-engine.ts
 * @covers tugdeck/src/components/chrome/space-layer.ts
 * @covers tests/app-test/real-transcript-fixture.ts
 */

import { describeSlideArm } from "./intra-workspace-slide-fixture";

describeSlideArm("slice");
