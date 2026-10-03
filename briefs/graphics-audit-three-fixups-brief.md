<!-- brief-skeleton v1 -->

# Fixups from the third graphics audit

**Purpose:** The third audit of the graphics work found the gesture scope sound and the asks brief's scope ready to move past. What it left behind is a short list: two refusals and an undeadlined wait in the new rail width drag, six token-lint violations that no recipe gates, a duplicated test number, a classification that was done and not written down, and a stale test header. These are the fixups to land before the next design arc.

---

## Purpose {#purpose}

The user asked, for the third time, for an audit of the work done against `briefs/graphics-animations-asks.md`:

> I want to know if we're ready to move on past the work I originally scoped out … Do we need to make fixups? Or, can we move on from here with confidence that the codebase is in good shape?

The audit was taken at `7b216491d` on 2026-10-02, after `f6f79bca9` (gesture-hold-followups) and the two rail-width-drag commits `8295073f6` and `7b216491d` were joined to main. Typecheck, 10,001 tugdeck unit tests, `bun run audit:motion` and the 44 tugtool `deck_motion` tests pass. The gesture scope was traced through eight failure scenarios against React 19.2.4 and no defect was found. No app-test was run by the audit; app-test state below is from `apptest_results.db`. The verdict was: move on, with these fixups. The user then asked:

> Give me the brief(s) I need. Write them up.

---

## Evidence {#evidence}

**[F01] The rail width drag refuses silently when the band has no width.** `begin` in `tugdeck/src/components/chrome/rail-width-draft.ts:284-286` reads `railWidthLimits(side)` and `getBandEdges()` and returns bare when either is `null`. `getBandEdges` (`deck-manager.ts:4862-4866`) returns `null` whenever `end - start <= 0`, which is the case when the rails cover the canvas. The commit `8295073f6` says the old window-width cap on a rail is gone and a hand can now widen a rail further over the deck than before. Once the band is gone, every press on that edge has already taken pointer capture and set `data-gesture`, finds no draft in `change`, `commit` and `cancel`, and shows nothing. Narrowing the rail, the way out, is the gesture refused. The band is used only to compute how far the cards beside the rail travel. [L31]. **(verified, read from the code; not reproduced on a deck)**

**[F02] A rail pane with no `railWidthGesture` context returns bare on press.** `tug-pane.tsx:4406`, `if (railWidthGesture === null) return;` — the swallowed-internal-fault shape [L31] names. Reachable only by a rail pane rendered outside `DeckCanvas`. **(verified, read from the code)**

**[F03] The limit spring is a programmatic ease on `requestAnimationFrame`, and the commit waits on it with no deadline.** `springTo` (`rail-width-draft.ts:528-546`) plays a cubic ease-out over `LIMIT_SPRING_MS × getTugTiming()` after the pointer is released, reading no input, and `land` — the store write, the lift of `data-pointer-owned`, the end of the occlusion bracket and the resize episodes — runs only from inside its `step`. [L13] allows rAF for gesture loops that read input, not for an animation that needs completion and cancellation. In a window whose rAF is suspended the commit, the pins and the marks wait without bound; only `cancel()` (lost capture, Escape, unmount) lands it. Every other deferred commit in the deck carries a deadline. [L13], [L31], [L32]. **(verified, read from the code)**

**[F04] Six new L16 violations, and the lint that catches them gates nothing.** `cd tugdeck && bun run audit:tokens lint` exits 1 at HEAD: `MISSING_ANNOTATION` and `UNRESOLVED_PAIRING` on `.tug-pane[data-rail-held] .tug-pane-chrome`, `.tug-pane[data-rail-held][data-rail-limit] .tug-pane-chrome` and `.tug-rail-readout[data-limit]` in `tugdeck/src/components/tugways/tug-pane.css`; the tokens `--tugx-rail-edge-held`, `--tugx-rail-edge-limit` and `--tugx-rail-readout-limit-fg` have no deterministic surface. `audit:tokens` appears in `tugdeck/package.json` and in no `just` recipe and no workflow, so `just lint` and `just test` are green over it. **(verified, run)**

**[F05] Two app-tests carry the number at0672.** `tests/app-test/at0672-pane-press-raises-in-its-task.test.ts` (from `f6f79bca9`) and `tests/app-test/at0672-rail-width-drag-commit-and-cancel.test.ts` (from `8295073f6`), both on main. The arcs were walked in parallel and each took the next free number. **(verified)**

**[F06] The 36 reds were classified and the classification was not kept.** `briefs/gesture-hold-followups-brief.md` [B01] asked for the full corpus at HEAD with every red classified. Run 4968 at `68fcd01c4` (434 files) recorded 36 fails and 7 skips; the arc's commit message says each is "green alone, red with the hold disabled too, or red since before the hold landed", in one sentence with no names. The arc's documents under `.tug/arcs/` went with its worktree at join, the arc's session transcript has one turn, and no brief or test header carries the per-file verdicts. The record now cannot say which of the 36 is which. **(verified from the recorded history and the repository)**

**[F07] `at0654`'s header carries the 2026-10-01 readings only.** The header says the five legs were "read three times alone on 2026-10-01". The arc re-read the file alone at `f720a4e43` on 2026-10-02 and got 1 of 5, with the unfold gap at 2.29 frames against its 1.5 bar; that reading is in `briefs/gesture-task-without-react-brief.md` [F12], not in the test. Which leg went green is not recorded anywhere. **(verified from the header, the brief and the recorded run)**

**[F08] No run of consequence has happened at HEAD.** Since the join, the only recorded runs on main are two one-file runs of `at0673` at `8295073f6`. The rail arc's own new tests were intermittent alone on the arc: `at0674` 2 passes and 2 fails at `142b06500`, `at0675` 2 of 3 at `d2b0225ec`, `at0672-rail-width-drag` red once in a batch of 3 and once in a batch of 4 at `2ff5c2928`. None has been read on main. **(verified from the recorded history)**

**[F09] Small staleness the audit read.** `pane-occlusion-controller.ts:46` still says "the three gesture machines in `tug-pane.tsx` bracket their moves", where the rail machine now lives in `rail-width-draft.ts`. `tug-banner-bridge.tsx:52-55` says the show timer "stays active for the entire disconnect period", where it nulls itself when it fires. `tug-button.tsx:664` builds `manager.subscribe.bind(manager)` on every render under a comment claiming stable references, so every chain-active button resubscribes on every render. `READOUT_FADE_MS = 400` in `rail-width-draft.ts:188` repeats `transition: opacity 400ms` in `tug-pane.css`, and only the TypeScript side scales with `getTugTiming()`. **(verified, read from the code)**

**[F10] The hold costs an activating click one frame on store-driven appearance.** From `briefs/gesture-task-without-react-brief.md` [F09]: a click that activates its card paints the pane's focus at a median of 21–22 ms with the hold on and 11–12 ms bypassed; a control's own state in an already-active card paints at 5 ms on and 7 ms bypassed. The arc did not narrow the scope to motion-launching gestures because activation is the gesture that can launch the flow slide. **(verified, measured by the arc; this brief does not re-measure)**

---

## Decisions {#decisions}

**[B01] A press on a rail edge always produces a drag or a visible reason.** The band guard in `begin` is replaced: a band of no width clamps the travel term to zero rather than refusing the gesture, so a rail widened over the deck can be narrowed back. The `railWidthLimits === null` and the missing-context cases either cannot happen by construction, and are made to say so, or surface a reason where the user is looking. No bare `return` survives on the press path ([L31]).

**[B02] The limit spring moves onto TugAnimator, and the commit it lands carries a deadline.** The spring is programmatic motion with a completion and a cancellation, which is what `tug-animator.ts` is for ([L13]); its `finished` lands the commit, and both arms of the promise land it, so the store write, the lifted marks and the closed brackets never wait on a frame that does not come ([L32]). A reduced-motion or zero-timing deck lands at once, as now.

**[B03] The token lint joins `just lint`, and the six violations are fixed first.** The three rules get their `@tug-renders-on` annotation or set their surface; the three tokens are given a deterministic pairing. Then `audit:tokens lint` is wired into the recipe `just lint` runs, so [L16]'s enforcement is a gate rather than a command nobody runs. This lands before anything else in the arc, because it is the one fixup that keeps the next one from happening.

**[B04] The rail-width tests are renumbered to the next free numbers.** The gesture-hold test keeps at0672; the four rail tests move up as a block, and every reference to them — headers, `@covers`-adjacent notes, briefs — moves with them. Numbers are not meaningful, but two files under one number defeats the one thing a number is for.

**[B05] The 36 reds are classified again, at HEAD, and the classification is written where it will survive a join.** Each file in run 4968's fail list is run alone at the tree this arc produces and recorded as: green alone (contention), red and pre-existing (with the sha it was last green at, from `tugtool apptest history`), or a real defect of the hold or the rail drag (fixed here). The record goes into a dated section of `briefs/gesture-hold-followups-brief.md`, which is tracked, not into an arc document, which is not. The three new rail tests are read alone on main the same way ([F08]).

**[B06] `at0654`'s header is brought to the current reading, and a leg goes green only on the header's own rule.** The 2026-10-02 reading is written beside the 2026-10-01 ones, with the leg that went green named. A leg moves back to `at0622` only when it is green on three solo runs, as the header already says; one green is a note, not a move.

**[B07] The stale comments and the rebinding subscribe are corrected.** `pane-occlusion-controller.ts:46`, `tug-banner-bridge.tsx:52-55`, `tug-button.tsx:664` (a stable subscribe, so a chain-active button subscribes once), and the readout fade duration stated once and read by both sides.

**[B08] The hold's one frame on activation is the user's call, and this arc takes it as given.** The number is measured ([F10]). If the user accepts it, nothing changes. If not, the scope narrows to gestures that launch motion: the window listener opens no scope, `arm`'s prelaunch keeps its own, and the click-latency probe is re-read to show the frame returned. The arc does neither until told.

---

## Open Questions {#open-questions}

- **Is one frame of activation latency acceptable for the hold?** ([F10], [B08]). It needs the user's judgment; the arc asks before touching the scope.
- **Does the rail drag need a cap beyond the allocator's 675 px?** The commit says the window-width-minus-80 cap is gone. [B01] makes the lockout impossible; whether a rail should still be stopped short of covering the deck is a product call.
- **Which `at0654` leg went green on 2026-10-02?** Settled by the solo re-read in [B06].

---

## Non-goals {#non-goals}

- **The Beat primitive and the raw-`animate` lint, the `departing` mark, one hold/one quiet, height by translation, and breaking up `DeckCanvas`.** These are the asks brief's unbuilt concepts, they need a sketch before a brief can carry decisions, and none is a fixup.
- **Narrowing the gesture scope on this brief's own authority.** [B08].
- **Loosening any frame bar.**
- **Changing what the rail drag looks or feels like.** The feedback, the readout and the soft stops are the rail-width brief's decisions and stand; this moves the spring's engine and its deadline, not its curve.

---

## Exit {#exit}

**An arc.** Order: the token lint and its wiring ([B03]) first, so the gate stands before the CSS it guards moves again; the two rail refusals and the spring ([B01], [B02]) with `at0672`-rail, `at0673`, `at0674` and `at0675` run alone before and after; the renumbering ([B04]); the comments and the subscribe ([B07]); then the readings last, at the finished tree — the 36 reds and the rail tests alone ([B05]) and `at0654` alone three times ([B06]) — so what is written down describes the code that stays. The hold's product question ([B08]) is asked of the user at the start and acted on only if answered.
