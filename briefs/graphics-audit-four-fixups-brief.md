<!-- brief-skeleton v1 -->

# Fixups from the fourth graphics audit

**Purpose:** The fourth audit found the settle architecture sound and the asks brief's scope ready to close, and found three cancellation-path defects and one false law clause in the tree. These are the fixups that land before the asks brief is closed and before the next design arc starts.

---

## Purpose {#purpose}

The user asked, on 2026-10-04, for a 360° audit of the graphics work against `briefs/graphics-animations-asks.md`, and then:

> So, you've told me to move on, but then told me there are law violations and that the fixups are one short arc. WHICH IS IT?

The answer: fixups first, then move on. The audit was taken at `f1f84016d`, after `d8259bcf1` (settle-engine-and-beat), `7b0568303` (settle-window-commit), `f1f84016d` (departing-and-height-crossing) and `3b6cc80cb` (stranded-hidden-loops) joined main. Typecheck, 10,356 unit tests, `audit:motion`, `audit:tokens lint` and 54 `deck_motion` Rust tests pass. No app-test was run by the audit; the state cited is from `apptest_results.db`. Two of the findings below are probable from a code read and not reproduced, so the arc confirms each with a sampled probe before fixing it.

---

## Evidence {#evidence}

**[F01] A retarget never ends a fold or still crossing.** When a new `arm` interrupts a running settle in `tugdeck/src/components/chrome/settle-engine.ts`, the retarget path (around `:1720–1815`) cancels the running tweens with `hold-at-current`, runs their restorers and calls `clearFlip`, and does not call `endFoldCrossing` or `endStillCrossing`. The generation bump makes the old chain's completion (`:3582–3585`) return before it reaches its own `endFoldCrossing` (`:3621–3623`). The new Last pass adopts a standing crossing (`adoptFoldCrossing` `:2670`, `adoptStillCrossing` `:2694`) only when the frame still has at least 0.5 px of height change; otherwise the frame leaves the tween records with its crossing attribute and held content height standing. The sweep ends crossings (`:1379–1380`) but walks only the tween records, and the unmount teardown (`:2090–2091`) is the only other caller. Repro: fold or unfold a card and, in the spring's tail, activate another card. **(probable, read from the code; not reproduced)**

**[F02] A drag begun on a pane mid-settle has two owners of its inline `transform`.** `tug-pane.tsx` writes `data-pointer-owned` at the drag threshold (`:3757`, `:4339`) and the frame's inline `transform` each frame. Nothing cancels a settle tween already running on that frame; `arm` skips pointer-owned frames only on a later commit (`settle-engine.ts:1664`), and a drag start commits nothing. The beat's effect hides the drag's transform until the beat ends, and then `commitStyles` in the animator's finished handler, `landFrames` (`:3487`) and the completion's `clearFlip` each overwrite it. Repro: activate a card so the flow slides, then within 400 ms press and drag a moving pane. [L32]'s one-owner clause. **(probable, read from the code; not reproduced)**

**[F03] A rail re-shown inside its hide's depart window is read as an arrival while the depart beat still owns it.** `arm` measures `SHOWN_PANE_FRAMES`, which excludes `[data-rail-parked]`, so a frame sliding out on its depart beat gets no First rect; `releaseDepartingTargetsRef.current("unlaunched")` (`:1525`) skips it because it is launched; the Last pass's arrival branch (`:2544–2556`) writes `opacity: 0` and measures travel through the depart hold without checking `data-settle-departing`; and when the depart lands, `landDepartingTarget` (`:496–502`) runs restorers captured before the hide, removing the arrival's holds mid-arrival. Repro: toggle the rails twice within one depart window. **(possible, read from the code; not reproduced)**

**[F04] The composed snapshot makes `standingDeck` an inverted default, and three listing readers were not converted.** `getSnapshot` composes departing panes back in for one settle, and every reader that lists or counts has to opt out with `standingDeck`. `tugdeck/src/lib/live-turns-store.ts:217`, `tugdeck/src/components/tugways/tug-logout.tsx:67` and `tugdeck/src/main.tsx:915` (`diag.listCardIds`, which app-tests read) iterate the composed `cards`. `spaceHoldsLiveSessions` (`deck-manager.ts:1935`) counts a departing session card where `spaceCardCount` does not, so the two disagree during a fade. `departing-invisibility.test.ts` checks only the readers it names. **(verified, grep at HEAD)**

**[F05] L32's first clause is false against the departing frame.** `tuglaws/tuglaws.md` L32 says the engine "pairs every `style.opacity = "0"` with an `inlineRestorer` that `arm`, the sweep, and the unmount teardown all run." `landDepartingTarget` (`settle-engine.ts:497–498`) sets `opacity: 0` with no restorer, by design: the lift is the store's unmount in the commit after the settle. The behaviour is right for a closed pane and the law does not say so. **(verified, read)**

**[F06] `COMMIT_BAR` was set from readings the departing arc then moved.** `tests/app-test/at0684-settle-window-commits.test.ts:88–94` bars close 2,000, rails 100, split 1,100, unfold 250, switch 1,300 fibers performed, as "about a quarter's headroom" over solo readings of 1,626 / 45 / 858 / 169 / 1,026. After `f1f84016d` the close reads 580 (`briefs/departing-and-height-crossing-readings.md`), so its bar is about 3.4×; rails is 2.2× and unfold 1.5×. The commit message says the numbers are a default for the user to revise. **(verified from the test and the readings)**

**[F07] Two app-tests are numbered at0622.** `at0622-deck-settle-frames.test.ts` and `at0622-placard-z-order.test.ts`, the latter from `d391f68bb`. **(verified)**

**[F08] Driven gestures run without the click's hold.** `window.tugdeck.lab.drive` (`tugdeck/src/lib/gesture-drivers.ts`) runs in an evaluate task and opens no `pointer` scope; the only hold a driven gesture gets is `arm`'s `prelaunch`. `at0622`, `at0684` and `tugtool deck motion settle` therefore measure without the hold a real click puts on every non-deck store. `driveGesture` returns `{ ok: true }` for a pane id that does not exist. **(verified, read)**

**[F09] Small staleness.** `hideSidebarPane`'s doc says "No-op when it is not open" where it now closes a parked card because it tests presence; `animation-doctrine.md` says the store's land is unconditional on the settle generation where the depart landing lands only once `settleReleasedRef` is true (`settle-engine.ts:3328`); "parked" is derived three ways (`deck-store-selectors.ts:164,190`, `deck-canvas.tsx:1341–1346`, `card-ring.ts:43–45`) and "clear every hide" twice (`pane-place-facts.ts:142–144`, `deck-canvas.tsx:1349–1352`); `isSidebarStanding` relies on each caller passing a standing deck. **(verified, read)**

**[F10] No reading has been taken on the release deck since the gesture scope landed, and no app-test has run on main at HEAD.** The settle verb refused the working deck at its rest check (27 updates/s against 10); the installed release predates the gesture door; every number in the readings files is from the harness on a debug build. `at0622` was red 8 of 9 three times on the departing arc under load on the appear leg's lead (20–22 ms against 17), which is still judged. **(verified from the readings and the recorded runs)**

---

## Decisions {#decisions}

**[B01] Each probable defect is confirmed with a sampled probe before it is fixed, and the probe becomes the test.** [F01], [F02] and [F03] are read, not seen. For each, the arc writes the app-test that samples the frame on every animation frame through the repro (the crossing attribute and held height for [F01]; the frame's inline transform against the pointer for [F02]; the rail frame's rect and opacity through two toggles for [F03]), runs it against HEAD to see the red, then fixes. A probe that comes up green three times alone closes the finding as not reproduced, and says so here.

**[B02] A retarget ends every crossing it does not hand on.** The retarget path runs `endFoldCrossing` and `endStillCrossing` for a frame whose crossing the new Last pass does not adopt, or hands the crossing to the new settle as a record the completion and the sweep both reach. One owner starts the crossing and one path ends it on every exit ([L32]).

**[B03] A drag start takes the frame from the settle.** When a pane becomes pointer-owned, the engine cancels any beat running on that frame, hands back its holds, and lands nothing on it later: the drag owns the transform from the threshold on, and `arm` keeps skipping it. The settle's record notes the frame as taken so the frame record stays honest.

**[B04] A frame still departing is not an arrival.** The Last pass checks `data-settle-departing` before treating a seated frame with no First rect as an arrival; a re-shown rail's frame is released from its depart target (holds handed back, beat cut) and then measured and planned as the show it is.

**[B05] The composed snapshot is opt-in, not opt-out, or the invisibility test covers every reader.** Preferred: `getSnapshot` returns the standing deck and the canvas and the departing card's content read the composed picture through a named selector, so a new reader is right by default. If that inverts too much of `f1f84016d`, the alternative is that `departing-invisibility.test.ts` sweeps every `getSnapshot().panes` and `.cards` read in `src` and refuses one that is not on its allow list. Either way the three readers in [F04] and `spaceHoldsLiveSessions` are fixed.

**[B06] L32's text names the departing frame as its exception.** The clause keeps its rule and adds: a closed pane's frame is left at `opacity: 0` until the store's unmount lifts it, and the store's land is bounded on every exit. `animation-doctrine.md`'s land sentence is corrected to match the code ([F09]).

**[B07] `COMMIT_BAR` is re-read at HEAD and the numbers are the user's.** The arc runs `at0684` alone three times at the fixed tree, writes the readings, and asks the user for the bar per leg with the readings beside the question. The default offered is the one the arc used: about a quarter over the largest solo reading.

**[B08] The placard test is renumbered.** `at0622-placard-z-order` moves to the next free number with its references.

**[B09] `lab.drive` opens the hold a click opens, and refuses a pane it cannot find.** A driven gesture opens a `pointer` scope before dispatching, so the harness and the verb measure the user's gesture; `driveGesture` returns a refusal for an unknown pane ([L31]).

**[B10] The staleness in [F09] is corrected**, with one `isSidebarParked` selector and one "clear every hide" derivation.

**[B11] Nothing here loosens a bar, and the fixed tree is read before the arc closes.** `at0622`, `at0684`, `at0555`, `at0582`, `at0583`, `at0677`–`at0680` and the three new probes alone at the finished tree; the readings written to `briefs/settle-window-commit-readings.md` and `briefs/departing-and-height-crossing-readings.md` with the sha.

---

## Open Questions {#open-questions}

- **Are [F01], [F02] and [F03] real on a deck?** Settled by [B01]'s probes. If one is not, the finding is closed here with the reading.
- **Opt-in or sweep for the composed snapshot ([B05])?** Read how many composed-picture readers there are; if fewer than the standing ones, opt-in wins.
- **What are the commit bars ([B07])?** The user's, once the readings are in.
- **The release-deck reading ([F10]).** It needs a release build of this tree installed and a quiet deck arranged to each leg's shape; both are the user's to choose, and the arc asks for them once, at its end, rather than stopping.

---

## Non-goals {#non-goals}

- **The commit residue** in the close, split and switch windows (`configure-tug.tsx:407`'s whole-snapshot read, the Layout card's miniature, the Workspaces card's list). Named by the audit; its own brief, after this arc.
- **One hold, one quiet.** The last unbuilt concept; its own brief, after this arc.
- **The workspace switch's 100 ms first paint and `at0622`'s appear lead under load.** Both are real and both are the compositing floor's; the compositing brief's subject, not a fixup.
- **Re-opening the height bench.** Benched and rejected with evidence in `briefs/departing-and-height-crossing-brief.md`.
- **Loosening any bar.**

---

## Exit {#exit}

**An arc.** The three probes first ([B01]), each run against HEAD for its red; then the three cancellation fixes ([B02], [B03], [B04]) each against its probe; then the snapshot default ([B05]) and the law text ([B06]); then the drive's hold and refusal ([B09]), the renumbering ([B08]) and the staleness ([B10]); last the readings at the finished tree ([B11]) and the one question to the user about the bars ([B07]). When it lands, the asks brief is closed and the next work is design: the commit residue, then one hold.
