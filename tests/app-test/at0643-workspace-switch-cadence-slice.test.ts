/**
 * at0643-workspace-switch-cadence-slice — the switch's frame cadence, held on a
 * deck big enough to break it, on the slice arm.
 *
 * Split from `at0643-workspace-switch-cadence`, one file per transcript arm,
 * each its own launch: the slice here, the whale in
 * `at0643-workspace-switch-cadence-whale`. The fixture, the instrument and the
 * bars are one body in `workspace-switch-cadence-fixture.ts`; the argument for
 * all of it is below.
 *
 * This is the arc's tripwire. at0640 says the switch is a cut (a set of
 * absences), at0641 and at0642 say what a hidden layer does and does not do,
 * and this file says the one thing none of them can: **how the switch PAINTED**
 * — how late the first frame after the gesture was, and how rough the 600 ms
 * after it were.
 *
 * ## Why a grown fixture, and what "grown" means here
 *
 * A two-card fixture cannot show either of the two costs this arc removed. The
 * freeze is React's render of the arriving canvas plus every arriving layout
 * effect, and it scales with the number of cards and the number of transcript
 * rows under them; the rough patch after first paint is the compositing rebuild
 * of the arriving tree, and it scales with element count and with how many
 * animations are running when the layers change hands. On a fixture with three
 * panes and no transcript, both are under a frame whatever the product does, so
 * a green run would prove nothing.
 *
 * So the fixture is grown in the two dimensions that matter and in no others:
 *
 *  - **Elements.** Six session cards across two workspaces, each bound to a
 *    REAL resumed transcript (`real-transcript-fixture.ts`) on two arms: the
 *    slice everywhere, and in the whale arm one card of each workspace carries
 *    the corpus's whale. Each workspace's cards are bound while it is the one
 *    on screen, since a parked layer has no height for a transcript to settle
 *    into. They once grew by streamed turns, and no longer can: on a resumed
 *    card a `send` is a real turn sent to `claude`. The element count the
 *    deck actually reaches is MEASURED and noted rather than asserted — it is
 *    a property of the harness's window size and the row renderer, not a
 *    number this file gets to declare.
 *  - **Running animations.** An infinite CSS loop installed on every pane and
 *    every card host of every layer, which is dozens on this fixture. This is
 *    at0641's probe shape and it is here for a different question: at0641 asks
 *    whether a hidden layer's loops are stilled, and this file asks what the
 *    compositor does with dozens of them at the moment two layers change hands.
 *
 * ## The bar, and why it is not one frame period
 *
 * The arc's success criterion is written in absolute terms — gesture to first
 * painted frame under one 60 Hz frame period. That is the criterion the LIVE
 * DECK readings in `briefs/workspace-switch-cheap-readings.md` are held to, and
 * it is the right bar for a reading taken by hand on a machine that is
 * otherwise idle.
 *
 * It is the wrong bar for a tripwire, and the reason is written down rather
 * than assumed: the settle files pin a settle's move beat at 2.0 display frames and
 * that bar has no margin on this machine — it alternates green and red at
 * 2.12–2.30 across shas and worktrees, on main as much as on this arc, which is
 * recorded in the arc's `baseline.md`. A test whose bar sits at the number the
 * product achieves is a test that reports the machine's load, and the corpus
 * already carries one of those.
 *
 * The GAP bar answers that with {@link LONGEST_GAP_FRAMES}, set from the
 * measured readings with a margin, and stating its measured number in its
 * assertion message so a regression reads as a number that moved rather than as
 * a test that got stricter.
 *
 * **The FIRST-PAINT bar does not, and [B05] is why.** It stood at 150 ms — a
 * margin derived from the 52–67 ms this very fixture was reading, which makes
 * it a bar that cannot find its own subject wanting: whatever the gesture did,
 * the number was set from it. It is now ONE DERIVED DISPLAY PERIOD, which is
 * the criterion the arc actually wrote, the one the settle files hold on every leg,
 * and the one the live-deck readings are against. A red here is a finding to
 * record rather than a bar to move back.
 *
 * The roughness bar is also RE-STATED rather than merely widened, and that is
 * the one substantive finding this file landed with. The arc's criterion says
 * "no frame gap over 20 ms", which at the 17 ms period this display derives is
 * three milliseconds of headroom — less than a live rAF loop's own jitter. The
 * measured runs bear that out exactly: `gapsOverOneFrame` was 0 on all four
 * switches while `gapsOverBudget` was 2 on one of them, and both of those gaps
 * (21 ms and 23 ms) sat under the `GAP_TOLERANCE` the repository already uses
 * for this. So the claim held here is the display-relative one, and the
 * absolute count rides along in every message and in the working paper.
 *
 * ## Suspension voids the reading, it does not pass it ([P10])
 *
 * A covered harness window suspends `requestAnimationFrame` outright, and a
 * suspended run reports a handful of ticks and no gaps at all — which reads as
 * a perfect switch if the counts are left at zero. `classifySpaceSwitchFrames`
 * voids them to `-1` instead and sets `suspended`, and this file honours that:
 * under suspension the whole record is `note()`d and NOTHING about cadence is
 * asserted. What is still asserted is that a record arrived at all, because a
 * record that never arrived is an instrument that stopped working, which is a
 * different failure from a rough switch and must not hide behind occlusion.
 *
 * ## Why the sampler is armed BY KIND
 *
 * `deckTrace.enable(true)` is not a narrow enough door. The switch-frame
 * sampler runs 600 ms of rAF callbacks per switch, and ungated it pushed
 * `at0622`'s own gap bar over its threshold — a test measuring something else,
 * made red by a neighbour's instrument. `enableKind("space-switch-frames")` is
 * per-kind for exactly that, and this file is the reading that asks for it.
 *
 * ## Two tiers: the bar says "did it break", the warning says "is it drifting"
 *
 * The GAP bar carries a margin, and what a margin costs is warning: a gap that
 * slides toward the bar is invisible until it crosses and goes red all at once.
 * So above it sits a second tier that asserts nothing. ANY gap over the 20 ms
 * absolute budget (`gapsOverBudget > 0`, which the record already carries)
 * writes a `note()` that names itself a DRIFT WARNING, so it shows in the
 * `Diagnostics:` section of every run that crosses it and in none that does
 * not. A reader of the report can tell the two apart: a red is a break, a drift
 * line is a number that has started to move. The first-paint bar needs no such
 * tier, having no margin left to drift inside.
 *
 * @motion
 * @family at0643-workspace-switch-cadence
 * @covers tugdeck/src/components/chrome/deck-canvas.tsx
 * @covers tugdeck/src/lib/space-switch-frames.ts
 * @covers tugdeck/src/components/chrome/space-layer.css
 * @covers tests/app-test/real-transcript-fixture.ts
 */

import { describeCadenceArm } from "./workspace-switch-cadence-fixture";

describeCadenceArm("slice");
