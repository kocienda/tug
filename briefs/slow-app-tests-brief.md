<!-- brief-skeleton v1 -->

# Slow app-tests: no file in the suite runs longer than a minute

**Purpose:** Four app-test files run for one and a half to three minutes every time, one of them has never been green, and two of them are readings rather than gates. The user has ruled that no app-test may take more than a minute or two on the outside, and that the suite is not where a diagnostic reading lives. This brief records what each slow file does and what becomes of it.

---

## Purpose {#purpose}

The user, 2026-10-05, after a core-tier checkpoint ran for 91 minutes inside the `set-up-and-go-motion` arc:

> These are broken app-tests by construction. I do not want tests in the suite that take this long to run. Not even a fraction of this. No test should ever take more than one or two minutes… *on the outside*.

The complaint that led there was about how the model runs app-tests, and that part is already landed as prompt text (`b82386ea1d`: a slow run is a verdict, run once per step, never a probe). What remains is the suite itself: a step whose checkpoint names a 160-second file pays 160 seconds per verdict no matter how disciplined the runner is, and a file that is red on every recorded run teaches everyone to skim past red.

---

## Evidence {#evidence}

All timings are from `apptest_results.db` (`just db-inspect apptest_results`), over runs since id 5400, excluding `SKIP` rows.

**[F01] Three of the four files that hit 17–19 minutes in the 91-minute run are not slow.** `at0357-content-width-default`, `at0563-session-fold-still-picture` and `at0597-drop-lands-then-reveals` run in 5–7 seconds on every other recorded run, including the run that finished at 07:51 the same morning (7 s, 5 s, 7 s). In run 5806 they sat at 1015–1125 s each because the app stopped answering and the harness waited on each file in turn. No surviving log says why the app wedged. Those three files stay; the defect is that nothing stopped the run. **(verified)**

**[F02] Four files are slow on every run.** Average wall time over recent runs: `at0622-deck-settle-frames` 101 s (138 runs, 61 green; 160–165 s on the current tree), `at0690-real-transcript-asks` 100 s (17 runs, 0 green), `at0603-find-walk-transcript` 115 s (4 runs), `at0684-settle-window-commits` 82 s (40 runs). The next slowest file in the suite averages 67 s (`at0683-arc-row-join`) and most run under 30 s. **(verified)**

**[F03] `at0622` is slow because it is fourteen gestures in one file, each paying a real-transcript resume.** Every leg builds a four- or eight-card flow deck of Session cards, binds each card to a real resumed transcript through a genuine `tugcode --resume` (`real-transcript-fixture.ts`, `BOUND_MS` 60 s per card on the slice arm), arms the per-frame sampler, drives one gesture, waits the settle plus `AFTER_LAND_MS` 900 ms, and classifies the record. The legs are: fold stamp spent once; activation at four cards (ring, slide, one-row-per-settle); eight cards in shared columns; a stalled settle, a retarget and a space switch; a fold retargeted at 140 ms; hiding a two-member rail; a card arriving closed into at 140 ms; a card arriving into a split column; the same card closed out; go-to-slot out and home; bullseye in and out; hiding and showing a rail plus resize to fit. One leg is a deliberate sabotage proving the sampler can see. Its per-test timeout is `BAR_TIMEOUT_MS` 600 s. No single assertion is slow; the count is. **(verified, read from the file)**

**[F04] `at0690` has never passed.** Seventeen recorded runs, seventeen reds. It reads four gestures no other file reads (seat into a split column and back, close and reopen one rail member, resize the rails to fit, the deck at rest) on the same real-transcript fixture, and its lead and beat-start bars were the set-up's length, which the `set-up-and-go-motion` brief [B02] has already ruled is not a bar. It is a reading wearing a test's name. **(verified)**

**[F05] `at0684` records, it does not gate.** Its five legs record every React commit inside a settle gesture's window with its size and cause, for closing a newcomer in a split column, showing the rails after hiding them, splitting slot 0 of an eight-card deck, unfolding a folded card, and a workspace switch. The `set-up-and-go-motion` brief [B02] has already removed its `COMMIT_BAR`; what is left is `MAIN_THREAD_BAR_MS` and a census. The census is the kind of reading `tugtool deck motion settle` takes on a live deck. **(verified, read)**

**[F06] `at0603` is one honest regression test with an oversized fixture.** One test: ⌘G pressed N+1 times over a long mixed transcript, checking every step lands on the match it names and brings it into view. It exists for a real reported bug (a reveal that outlived its frame budget and stayed armed, two gestures racing through one shared boolean, an ordinal drifting from the chip). Its expected total is computed from the fixture rather than written down, so the fixture can shrink without the assertions moving. It covers six source files and nothing else in the suite covers the walk. **(verified, read)**

**[F07] The selector cannot narrow a file.** `@covers` resolves a changed source file to a test *file*. A change to the fold path selects all of `at0622`, so every fold change pays the other thirteen gestures' resumes. There is no per-test filter on `just app-test`; bun has `--test-name-pattern` and the recipe does not pass it. **(verified, read from the justfile)**

**[F08] Nothing caps a file's wall time.** The recipe sets bun's `--timeout` only when parallel jobs are on; the harness's own timeouts are per operation and did not fire in run 5806. A wedged app walks the rest of the selection into the same wall. **(verified)**

**[F09] The `set-up-and-go-motion` arc holds every file this brief touches except `at0603`.** Its committed rounds and uncommitted edits cover `at0622`, `at0684`, `at0690`, `settle-frames-fixture.ts` and both halves of `deck motion settle`. Work on those files on `main` conflicts at that arc's join. **(verified, `git status` in the worktree)**

---

## Decisions {#decisions}

**[B01] No app-test file runs longer than one minute; two minutes is the outside.** The user's rule, 2026-10-05. A file over the bar is a defect of the file's construction, not a cost to budget for. The bar is read from the recorded history (`tugtool apptest history` carries `lastSecs`), so a file that drifts over it is visible without anyone timing it by hand.

**[B02] `at0690` is deleted.** It has never been green ([F04]), its bars were the set-up's length which is no longer a bar, and its four gestures are readings. Any of the four readings still wanted is taken on a live deck through `tugtool deck motion settle`, which drives the same lab door. Nothing moves out of it into another test file: a test built to stay red is a carry wearing a file's name, as the deletion of `at0654` already established.

**[B03] `at0622` is split into one file per gesture.** Each new file carries one gesture's legs, its own `@covers` naming the source that gesture exercises, and its own fixture setup, so a fold change selects the fold file and nothing else, and each runs in the ten to twenty seconds one resume-and-settle costs. The forcing leg (the sabotage that proves the sampler sees) stays with the activation file, because that is the bar it falsifies. The shared machinery stays in `settle-frames-fixture.ts`; it is the legs that fan out, not the instrument. The split is chosen over cutting legs because every leg holds a bar on a clean tree and losing one would lose a tripwire; what was wrong was the file boundary, not the coverage.

**[B04] `at0684`'s commit census moves into `tugtool deck motion settle` and the file is deleted.** The census (every commit in the window, by size and cause) is a reading, and the verb already takes the land and settle readings on a live deck; the census becomes one more field of the same reading. `MAIN_THREAD_BAR_MS` as a regression guard on the set-up's cost is carried by the per-gesture files from [B03] where the gesture is one they cover, and is otherwise dropped with the file: a guard nobody selected because its file was too slow to run was not guarding.

**[B05] `at0603` is kept and its transcript is shortened to the minimum that still reproduces the walk.** The bar is the file under a minute. The computed total ([F06]) means the fixture can shrink without re-deriving the assertions; the minimum is the shortest transcript on which the three original defects would still have shown, which the file's own header states (a reveal outliving its frame budget, two gestures racing one boolean, an ordinal drifting from the chip), so the shortened fixture must still have enough matches past the fold to force the reveal and enough to make the ordinal count.

**[B06] A file running far past its recorded time is stopped, not waited on.** The recipe caps each file at three times its last recorded wall time, floored at two minutes, kills it, records it as `WEDGED` rather than `FAIL`, and halts the run after two consecutive wedges with a line saying the app is not answering. `WEDGED` is its own status so the history never reads it as a red. This is the fix for [F01]; without it the 91-minute run recurs the next time the app hangs under any file.

**[B07] This work opens after `set-up-and-go-motion` joins, and not inside it.** [F09]: three of the four files are in that arc's hands. Folding the deletions and the split into that arc would widen a step list its brief never settled, and doing them on `main` first would conflict at its join. `at0603` and [B06] are free of the conflict but are not worth a second arc; they ride the same one.

---

## Non-goals {#non-goals}

- **A per-test filter on `just app-test` as the fix.** It was sketched (`file::pattern` passed to bun's `--test-name-pattern`, with filtered runs recorded as partial so the history never reads a partial pass as a green file). It is a workaround for a file that is too big; [B03] removes the need by making the file the unit again. It may still be worth building, but it is not this work.
- **Cutting `at0622` to the four legs the set-up-and-go brief bars.** Rejected in favour of the split: every leg holds a bar on a clean tree and is a tripwire; the file boundary was the defect.
- **Keeping `at0690` as a skipped or documented-red file.** A test that stays red is a carry. Its readings belong on a live deck.
- **A cost line printed before each run.** Useful, and it is what [B06] reads from, but it is runner ergonomics rather than suite shape and is not required for any decision here.
- **Fixing the three files that hung.** [F01]: they are 5–7 s files and did nothing wrong.

---

## Exit {#exit}

**An arc**, opened after `set-up-and-go-motion` joins ([B07]). The order that matters:

1. The wedge rule ([B06]) first, because every later step's checkpoint runs app-tests and should not be able to repeat the 91-minute run.
2. Delete `at0690` ([B02]).
3. Split `at0622` into per-gesture files ([B03]), each with its own `@covers`, and confirm with `just app-test-select` that a change to one gesture's source selects one file.
4. Move the commit census into `deck motion settle` and delete `at0684` ([B04]).
5. Shorten `at0603`'s transcript ([B05]) and confirm the file's recorded time is under a minute.

The checkpoint for the whole is one reading: no file in `tests/app-test/` has a recorded wall time over sixty seconds.
