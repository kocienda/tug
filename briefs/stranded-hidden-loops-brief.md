# Stranded Hidden Loops

**Purpose:** Loops that `space-layer-loops.ts` pauses in a hidden workspace can stay paused after their workspace is shown again. The Session card's wave and the Overview's pulsing dots stopped animating on a live deck and did not start again until the user switched workspaces by hand.

---

## Purpose {#purpose}

The user reported: "Why has the wave animation in `@session:tug/glossy-bowl` stopped animating?", followed by "The pulsing dots in the Overview for session atoms have also stopped animating."

The session itself was not stalled. Its arc (`settle-engine-and-beat`) was in its implement stage, under a new session (`0036ea5c…`) on the same card, running a long foreground app-test loop. That is `tool_work`, which is a phase that should show the wave. The animations were wrong and the work was fine: a live turn looked dead.

---

## Evidence {#evidence}

**[F01] The wave should show during a long tool call.** `sessionZ1CContent` (`tugdeck/src/components/tugways/cards/session-card-z1c.tsx`) shows the wave for `submitting`, `awaiting_first_token`, `streaming`, `tool_work` and `waking`. It hides it only for `awaiting_approval`, `idle`, `replaying`, `errored`, or while an interrupt is in progress. **(verified, read from the code)**

**[F02] The global motion switch was not responsible.** `tugtool deck motion probe --instance release-main` reported `demoted no`. Running `deck motion list --within` against the three CSS holds that set `--tug-loop-iterations: 0` found no animations under any of them. Those holds are `html[data-tug-motion-demoted]`, `[data-tug-offscreen]` and `[data-tug-understudy]`. **(verified, live deck)**

**[F03] The loops were paused through the Web Animations API, in the visible workspace.** `deck motion list --within '[data-slot="session-z1c"]'` showed all three `tugx-progress-wave-*` animations as `paused`. Within `.tug-space-layer[data-space-shown]`, one set of `tugx-progress-pulsing-dot-*` animations was `paused` and the other 14 sets were `running`. The hidden layer held 0 animations. The wave's CSS has no `animation-play-state: paused` rule, so the pause did not come from the stylesheet. **(verified, live deck)**

**[F04] Only two code paths pause an animation through the API.** One is `space-layer-loops.ts` (`reconcileLoop` → `animation.pause()`). The other is the hand-run diagnostics in `src/lib/motion-guard/diagnostics.ts` (`deck motion pause`, `bisect`). Today's transcripts show no `pause` or `bisect` run against `release-main` after 12:06. The stage session started about 19:09 UTC. **(verified for the code; the transcript check is evidence that the diagnostics were not used, not proof)**

**[F05] Resume runs on only two paths.** The workspace-switch effect calls `stillHiddenLayerLoops(root)` (`tugdeck/src/components/chrome/deck-canvas.tsx:7634`). The motion switch's off edge calls it through `motionBreaker.onResume` (`deck-canvas.tsx:7490`). A loop paused by `stillLoopOnStart` or by a switch pass is resumed by nothing else. **(verified, read from the code)**

**[F06] A workspace switch by hand brought every stranded loop back.** After the user switched, the Session card's three wave bars and all 13 dot sets in the visible layer read `running`. This confirms the loops were paused by `space-layer-loops.ts` and that only the switch pass was missing. **(verified, live deck)**

**[F07] The likely trigger was a loop that started while its workspace was hidden.** The implement stage opened a new session on the card while the user was in another workspace. The wave would then have started under a hidden layer, and `stillLoopOnStart` would have paused it. The exact path by which it later became visible without a resume pass has **not** been identified. Two candidates: a switch whose pass ran before the loop was paused, or a path that shows the layer without running the switch effect. **(inference; a reproduction would confirm it)**

**[F08] Two `tug-arc-lifecycle-mark-breath` animations were still `paused` after the switch.** `arc-lifecycle-mark.css:70` animates only inside a `prefers-reduced-motion: no-preference` block, so this may be a separate CSS hold and not this bug. **(not verified)**

---

## Decisions {#decisions}

**[B01] Reproduce first, in an app-test that is red at HEAD.** Start a session's turn on a card in a hidden workspace, switch to that workspace, and assert that the card's `session-z1c` wave animations are `running`. A test that fails before the fix pins down the missing resume path. A fix with no failing test first is a guess dressed as a repair; see the "motion bug needs a sampler" lesson.

**[B02] Fix the resume contract, not only the one path.** The promise in `space-layer-loops.ts` is that "nothing loops in the dark". Its converse has to hold too: a loop it paused runs again once its layer is shown, however the layer came to be shown. Patching only the path the test finds would leave the next path that skips the switch effect to strand loops again. The repair belongs in that module's contract, with the canvas calling it at whatever moments the contract needs.

**[B03] Land after `settle-engine-and-beat`.** That arc is moving the settle code out of `deck-canvas.tsx` right now, and the resume hooks for this fix live in the same file. Opening this arc after that one joins avoids a conflict in a file of about 4,800 lines.

---

## Open Questions {#open-questions}

- **Which path shows a layer without a resume pass?** The [B01] reproduction settles it. If it passes at HEAD, the trigger is something other than "turn starts while hidden", and the next candidates are the switch-dissolve window (the departing workspace is held as a frozen picture, and `deck motion list` reports "retained" elements in the hidden layer) and a card moving between workspaces.
- **What mechanism carries out [B02]?** For example, re-running the pass on the frame after any change to `data-space-shown`, or having the shown edge always re-check what this module stilled. This depends on the answer above and on the switch-cost constraint in the Non-goals. Measure with `space-switch-timing`'s `paintMs`.
- **Are the paused `arc-lifecycle-mark` loops ([F08]) the same bug?** Reading the computed `animation-play-state` on those pills settles it.

---

## Non-goals {#non-goals}

- **A stylesheet rule that pauses everything under a hidden layer.** It was measured and rejected (`space-layer-loops.ts` header): a universal descendant rule restyles every element on each switch and cost about 100 ms of post-swap work per switch.
- **Any automatic demotion or motion guard.** The breaker has been a hand switch since 2026-09-28, and nothing in the product may turn the user's motion off on its own.
- **Pausing finite animations.** A settle's tween must run out, because someone awaits its `finished` promise. This fix touches only infinite loops, as the module does today.

---

## Exit {#exit}

An arc, opened after `settle-engine-and-beat` joins ([B03]). Its first step is the [B01] app-test, red at HEAD, with `@covers` lines on `space-layer-loops.ts` and `deck-canvas.tsx`. Then comes the [B02] fix, with that test turning green. Last, a `space-switch-timing` reading compared against the baseline, so the fix does not bring back the switch cost the module was built to avoid.
