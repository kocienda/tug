<!-- brief-skeleton v1 -->

# The flow slide: loose threads after the remaining-costs arc

**Purpose:** The flow slide now delivers its frames on the user's deck, but the reading that says so was taken on a half-size deck by hand-rolled scripts, two costs are still unexplained, and the arc that carried the work was joined midway. This brief gathers every open thread into one place so the remaining work can be taken on main, one item at a time.

---

## Purpose {#purpose}

The user, after the re-reading on the rebuilt deck:

> the **What's left** and **Two caveats** still kinda sucks. It feels like we're still leaving work undone.

and, on how the work continues:

> I want to get control over the work we should do next. … tackle the remaining items from the brief on main so we can work interactively, rebuilding the app as needed to pick up necessary pieces.

The gesture is the one `briefs/flow-slide-remaining-costs-brief.md` was written about: a Workspaces-row click (`focus-session-card`) that moves focus from the card in slot 1 to the card in slot 4 and slides the flow strip one card width. That brief's findings `[F01]`–`[F17]` are the evidence base here and are cited by its name rather than repeated.

---

## Evidence {#evidence}

**[F01] The remaining-costs arc was joined after two of its four steps, and the other two were done by hand on main.** `6d294fcf1` carries the ink fix (`--tugx-pane-dot-ink` declared on `.tug-pane-grab-dots`, pinned by `at0628`) and the highlight rule (`transcript-find-highlighter.ts` and `selection-guard.ts` register a name only while it has ranges, pinned by `at0663`). The re-reading (step 3) and the carry into the unification material (step 4) were then written on main and are **uncommitted**: `briefs/flow-slide-remaining-costs-brief.md` (findings `[F13]`–`[F17]`), `briefs/graphics-animations-asks.md` (a "Findings carried in" section with the compositing-walk floor and the Overview's growth), and `briefs/deck-animation-pipeline-brief.md` (a "Premise withdrawn" note under its `[B01]`). The join removed `.tug/arcs/flow-slide-remaining-costs/`, so that arc's task list and `baseline.md` no longer exist. **(verified, read from the tree and the join receipt)**

**[F02] On the rebuilt deck the gesture delivers its frames, the start cost is gone, and the land frames are gone.** On `release-main` at `6d294fcf1`: 10–12 of 12 frames in the first 200 ms over sixteen clicks (2–3 before); the bare identity tween's first gap 10–24 ms on every pane (up to 125–130 ms before); no long frame at the settle's hand-back in twenty gestures (two 28–45 ms frames every run before); zero samples in `MarkedText::collectForHighlights` (162 of 321 paint samples before). Recorded in full as `[F13]`–`[F16]` of the remaining-costs brief. **(verified, measured)**

**[F03] That reading was taken on a deck half the size of the one the costs were found on.** A relaunch took the deck to 10,927 elements, 718 stacking contexts and 3,456 render-layer candidates, against 23,116, 1,435 and 7,226; the Overview to 3,745 elements against 12,349. Every gain in `[F02]` is the fixes and the smaller deck together, and the Overview's old 125–130 ms start cost was measured at more than three times its present size. **(verified, measured with `tugtool deck motion layers`)**

**[F04] The main thread is still blocked about 215 ms in the click's first 260 ms, and it is mostly script.** A zero-timer heartbeat read 212–226 ms of blocking in that window across sixteen clicks, against about 200 ms before the fixes. Across four gestures sampled at 1 ms, the WebContent main thread showed 61 samples under `WebCore::timerFired` (script) against 35 in rendering updates. Frames get through regardless now, so this no longer costs frames on the half-size deck; whether it does on a full one is unknown. The click-task candidates `briefs/deck-animation-pipeline-brief.md` `[F06]` names (`arm`'s per-frame reads, `discoverScrollers`, the activation focus write) are the first suspects, not yet attributed. **(verified for the blocking and the sample split; the attribution is not done)**

**[F05] An occasional 26–43 ms frame remains mid-slide.** In about half the gestures one frame of 26–43 ms lands 340–356 ms after the click, inside the settle (which runs from about 33 to about 450 ms); a few more land at 780–1,170 ms, after it. Nothing has attributed them. **(verified that they occur; cause not investigated)**

**[F06] Which fix removed the land frames is not known.** The rail fix, the ink fix and the highlight rule all reached the deck together, and no reading separates them. A bare 680 px tween with no hand-back ends on one 19–26 ms frame and a short catch-up, so an animation's end is not itself the cost. **(verified that they are gone; attribution not done)**

**[F07] The process samples are partial.** The WebContent main thread is broken down (`[F16]` of the remaining-costs brief). The GPU process's `RemoteRenderingBackend` work-queue share and most of the `Tug` main thread's share (where `CAIOSurfaceCreate` and per-surface ICC colour-space construction were the cost before) were not, because the permission check refused the reads that would have reduced them. **(verified, a gap in the record)**

**[F08] The existing `gesture` verb does not record a dispatched click.** `tugtool deck motion gesture --mode arm`, a row click dispatched as pointer and click events through the eval door, then `--mode read`, reported "gesture NOT RECORDED: no gesture stamp landed inside the series" although the slide ran and the series held 88 ticks. Whatever stamps a gesture is not reached by a dispatched click. The re-reading used an in-page `requestAnimationFrame` recorder and a zero-timer heartbeat keyed to a timestamp written by the click script instead. **(verified, observed; the stamp's source was not read)**

**[F09] Every reading so far was hand-rolled, and that is what stalled it.** The readings were JavaScript posted to `POST /api/eval` by an ad hoc script under `/tmp`, sample output reduced by hand, and the session's permission classifier refused the work partway on three separate occasions — the writes to the live page, a source search, and a reduction of sample files already on disk. Nothing from any of it is in the tree, so no reading can be repeated on a full deck by anyone without rebuilding the scripts. **(verified, this conversation's record)**

**[F10] The eval door is per instance, loopback-only, and opened and closed by a verb.** `tugtool deck motion enable` / `disable` set and clear the `diag/eval` opt-in on the instance's bank; `POST /api/eval` on the instance's tugcast port runs code in the deck and returns its result (`tugrust/crates/tugcast/src/server.rs`, `eval_handler`); `tugtool deck motion` resolves the port from `--instance` or `--port`. The other `deck motion` verbs (`cost`, `rest`, `layers`, `bisect`, `gesture`) are this door's shell end over `window.__tugMotion` (`tugrust/crates/tugtool/src/commands/deck_motion.rs`, `tuglaws/animation-doctrine.md` §deck-motion-verb). **(verified, read from the code and used)**

**[F11] `just app-test-covers-check` is red on main for reasons outside this work.** It reports `tugdeck/src/components/chrome/deck-canvas.tsx` fanning out to 30 tests against an accepted 29, and `tugdeck/styles/themes/` at 11 sources against a recorded 7. The deck-canvas fan-out arrived with the rail fix, which is flow-slide work. **(verified, run during the arc)**

**[F12] `tugtool deck motion slide` exists, and its first quiet reading is on a near-full deck that has lost the half-size deck's gains.** Run by the user from a terminal with no session mid-turn, sixteen clicks between `tug/goodly-ferry` and `tug/goodly-treat`, on a deck of 16,421 elements, 1,004 stacking contexts and 5,291 render-layer candidates (Overview 6,660): 5–7 frames in the first 200 ms against `[F13]`'s 10–12; the first frame at 63–75 ms against 34–41; and then, in every click, a ~40 ms gap and a ~50 ms gap before ordinary pacing near 180 ms. The lead is blocked 168–181 ms, *less* than the half-size deck's 212–226, so the late start is not script alone; a per-frame cost that grows with the layer population is the inference, unconfirmed until `--sample` attributes it. Frames of 26–31 ms are back at the settle's hand-back (~450 and ~480 ms) in 13 of 16 clicks, milder than the pre-fix 28–45, which reopens `[F06]` under `[B05]`. Settle on at 58–71 ms, off at 471–492. An earlier run taken from inside a session that was mid-turn read 2–4 early frames and carried 30–60 ms frames through the whole window, so a reading from a working session is not a reading of the gesture. **(verified, measured with the verb)**

---

## Decisions {#decisions}

**[B01] The remaining work is done on main, interactively, one item at a time.** The user's call: no arc wheel, no worktree, rebuild the Release app when a change needs to be on the deck to be read. Each item lands as its own commit when its reading or its pin says it is done. This rules out batching the items into one arc, and it is what makes the reading-driven items workable — each depends on the user rebuilding, relaunching and arranging the deck, which an unattended stage cannot do.

**[B02] The uncommitted brief edits land first.** The three files in `[F01]` carry the re-reading and the withdrawn premise. They are the record every item below cites, and a reading that lives only in a working tree is the kind of thing a relaunch or a stash loses.

**[B03] The first piece of work is a `tugtool deck motion slide` verb, and every reading after it is taken with it.** It drives the real gesture through the eval door — the Workspaces row click dispatched as pointer and click events, the same way the re-reading did so the numbers stay comparable — N times in each direction between two named cards, and reports per click and in aggregate: frames in the first 200 ms, the first frame's offset, the early gaps, every frame over one period with its time, main-thread blocking in the lead from a zero-timer heartbeat, and the settle mark's on and off times. Every report carries the deck's census (elements, stacking contexts, render-layer candidates, and the largest panes' element counts) beside its numbers, because `[F03]` showed a reading without it cannot be compared. It keys its window to a stamp it writes itself rather than to the stamp `gesture` waits for (`[F08]`). A `--tween` mode runs the bare-tween bisect (identity per pane, and a real move across the content panes, each read at its start and its end). A `--sample` mode runs `/usr/bin/sample` on the WebContent, GPU and `Tug` processes across the clicks and reports each thread's busy share and its heaviest frames, which closes `[F07]` without anyone reducing a sample by hand. `--json` emits the whole report. It lives beside the other `deck motion` verbs in `deck_motion.rs`, so it is part of the bundle and works on any instance. The argument: `[F09]` is why the work stalled, and every remaining item is either a reading or needs one to attribute it.

**[B04] Nothing is designed against `[F04]` or `[F05]` until the verb has attributed it on a full deck.** A full deck means one at the size the costs were found at — roughly 20,000 elements and 7,000 render-layer candidates, with a grown Overview — and the census in the verb's report is what shows whether a reading qualifies. This is the remaining-costs brief's `[B05]` and `[B08]` carried forward: fixes for this gesture designed against a bench, or against a deck that happened to be small, have missed before. The lead block is attributed first, because it is the larger number and has named suspects.

**[B05] The land-frame attribution is pursued only if the land frames come back on a full deck.** `[F06]` matters if there is a cost to prevent from returning. If the full-deck reading shows none at the hand-back, the three fixes are pinned already (`at0621`, `at0628`, `at0663`), and spending rebuilds to separate them buys nothing.

**[B06] The compositing-walk floor and the Overview's size go to the unification work and to the user, not to this work.** The walk (`[F10]` of the remaining-costs brief) is priced by how much is on the deck and is now recorded in `briefs/graphics-animations-asks.md` as the floor that work plans inside. Whether the Overview skips unseen rows or holds fewer of them is a product call the user owns. This work's verb measures both; it changes neither.

**[B07] The covers-check reds are fixed alongside the verb.** `[F11]`'s deck-canvas fan-out came in with the rail fix and is this work's to settle — narrow the `@covers` lines or record the coupling in `ACCEPTED_FANOUT` with its count. The themes width is not flow-slide work, but it is a one-line record change that would otherwise keep the check red under every commit this work makes.

---

## Open Questions {#open-questions}

- **What is the 215 ms of script in the click's lead `[F04]`?** Settled by the verb's `--sample` on a full deck, then a JavaScript profile of the click task if the native sample only says `timerFired`. The pipeline brief's `[F06]` names the suspects.
- **What is the mid-slide 26–43 ms frame `[F05]`?** Settled by the verb's per-frame record with the settle's phase beside it, sampled; whether it lines up with a store notification, a transcript tick, or the session card's activity line is the first thing to read.
- **Does a full deck bring back any of what `[F02]` says is gone?** Settled only by waiting for the deck to grow and running the verb, which is the user's to schedule.

---

## Non-goals {#non-goals}

- **Re-opening the remaining-costs arc.** Its two code steps are joined and pinned; its two documentation steps are written. Its `[B05]`–`[B08]` live on as citations here.
- **A new animation primitive, a compositing-walk reduction, or anything in `briefs/graphics-animations-asks.md`'s five concepts.** That is the unification work, and this brief feeds it findings.
- **Loosening any frame bar.** `at0622`'s lead clauses stay where they are.
- **Making the verb an app-test.** The point of the verb is the user's own deck with its own content; a bench is what hid the rail regression.
- **Readings written by hand again.** If the verb cannot take a reading, the verb is extended; ad hoc scripts through the eval door are how `[F09]` happened.

---

## Exit {#exit}

**Work on main, interactively, in this order.** First, land the three uncommitted brief edits (`[B02]`). Second, build `tugtool deck motion slide` with its `--tween`, `--sample` and `--json` modes and fix the covers-check reds (`[B03]`, `[B07]`); its first run is on the deck as it stands, to check it against the hand-rolled numbers in the remaining-costs brief's `[F13]`–`[F16]`. Third, when the deck has grown back to full size, run it with `--sample` and record the reading beside the others (`[B04]`, `[B05]`). Then attribute the lead block, then the mid-slide frame, each from that reading before any fix is designed.
