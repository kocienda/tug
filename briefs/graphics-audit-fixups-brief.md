<!-- brief-skeleton v1 -->

# Fixups from the graphics audit

**Purpose:** An audit of the last several days of graphics and animation work found the settle's core sound, but left a short list of law violations, an untested change, and frame-bar tests whose recorded state is red or stale. These are the fixups to make before building further on it.

---

## Purpose {#purpose}

The user asked for an audit of the work done against `briefs/graphics-animations-asks.md` — code quality, law compliance, whether to fix up or move on — and then, of the audit's recommendations:

> All the fixups you recommend
> ↑ brief these

The audit was taken at `fb0e28a35` on 2026-10-01. Typecheck, the tugdeck unit tests (9,913), `bun run audit:motion` and the tugtool `deck_motion` tests were run and pass. No app-test was run; app-test state below is from the recorded history in `apptest_results.db`.

---

## Evidence {#evidence}

**[F01] The after-paint door returns no release.** `scheduleAfterPaint` in `tugdeck/src/lib/after-paint.ts` returns `void` and hands back neither its rAF handle nor its timer id. Its callers — `deck-manager.ts`, `cards-selection-store.ts` (two sites), `responder-chain.ts`, `session-card.tsx`, and `HostMenuStatePublisher` via `host-menu-state.ts` — each guard the stale callback with a flag instead. [L27] says a registration may not return `void` and that inert is not released. A comment at `deck-manager.ts:8205` calls clearing the flag "the release ([L27])". **(verified, read from the code)**

**[F02] When the door's 50 ms deadline wins, its rAF callback stays queued.** In an occluded window rAF is suspended, so each call leaves one frame callback behind. The responder chain's notify and the menu publisher reschedule on background activity, so the queue grows while the window is covered and drains as a burst when it is shown. **(verified for the mechanism; the rate is not measured)**

**[F03] The focus engine's tracked-marks change landed without a test.** `fb0e28a35` replaced three document-wide scans in `FocusManager.applyProjection` (`tugdeck/src/components/tugways/focus-manager.ts`) with three sets of marked elements and a per-pass lookup memo, and touched no test file. No focus unit test exercises the stale-mark clearing or a mark left by a deactivated context. The change's premise holds — the engine is the only writer of `data-key-view`, `data-key-view-kbd`, `data-key-within` and `data-default-ring`. Each set can retain one detached element until the next projection. **(verified, read from the code and the commit)**

**[F04] The two app-tests nearest that change were already red, and none has run since it.** `at0109-focus-ring` failed its last six recorded runs, including one at `032cfcdeb`, the commit before the change; `at0121-list-view-container-focus` failed its last three. The newest recorded app-test run of any kind predates `fb0e28a35`. Whether either red is a real defect, a stale test, or contention has not been looked at. **(verified from the recorded history)**

**[F05] The frame-bar app-tests are recorded red.** `at0622-deck-settle-frames`: 125 fails against 7 passes since 2026-09-26, last four 7 of 8. `at0643-workspace-switch-cadence`: last five fail, all run alone, last green 2026-09-29. `at0652-loop-cost-and-life`: 13 fails against 4 passes, with a `test.todo` for the caret blink. `at0654-deck-settle-standing-reds`: 20 of 20, by design. `at0621-intra-workspace-slide` and `at0626-sash-drag-sampler` have also failed recently. None has a recorded run at HEAD. **(verified from the recorded history; not re-run)**

**[F06] `at0654`'s header is stale in two places.** It still describes the fold's bar as one frame, where `FOLD_GAP_FRAMES_BAR` in `tests/app-test/settle-frames-fixture.ts` was raised to 1.5; and it attributes the warm-flip red to a 917-fiber commit, which `0b8ab10ff` reportedly cut to 52. Whether that leg is still red, and why, has not been re-read. **(verified for the header and the constant; the leg's present state is not known)**

**[F07] A demoted deck's loops can stay frozen after `demote off`.** `reconcileLoop` in `tugdeck/src/components/chrome/space-layer-loops.ts` declines to resume a loop while motion is demoted and keeps its record; the loops were paused through WAAPI, which outranks the stylesheet. `demote(false)` in `tugdeck/src/lib/motion-guard/breaker.ts` only clears the attribute, and the one resume pass (`deck-canvas.tsx`) is keyed on the active workspace id. So a workspace shown while demoted keeps its loops still until the next workspace switch. [L32] clause 3: a refusal re-arms, it never just returns. **(verified, read from the code; not reproduced on a deck)**

**[F08] The switch-epoch mark is lifted only by another party's React commit.** `DeckManager` writes `data-space-switching` synchronously; the only code that removes it is a canvas layout effect with deps on the active workspace id. Two `activateSpace` calls in one task that end where they started leave React seeing the same id, the effect never runs, and no deadline was armed — after which every settle runs without tweens until the next real switch. No current caller does this. [L32] clause 1: one owner writes both states. **(read from the code; structural, not reproduced)**

**[F09] A rAF waits on a React commit in the session card.** `tugdeck/src/components/tugways/cards/session-card.tsx:2368` calls `setDismissedAt` and then focuses the entry from a `requestAnimationFrame`, with a comment saying the focus is only legal after the render that clears `sessionErrored`. [L05] forbids using a frame to wait on a commit; the frame is also never cancelled on unmount ([L27]). It is older code, not introduced by the audited commits. **(verified, read from the code)**

**[F10] The departure ghosts are not among [D9]'s named standing hits.** The pane ghost and the rail-shadow ghost are created, animated and removed inside the settle window (`deck-canvas.tsx`), which [D9]'s second clause — every layer an effect runs on already exists at rest — does not allow. The doctrine's ghost contract sanctions the tile but its list of standing hits names only the division's `height` and width over the raster cap. **(verified, read from the code and the doctrine)**

---

## Decisions {#decisions}

**[B01] `scheduleAfterPaint` returns a cancel, and every caller uses it on teardown.** The cancel clears the deadline timer and the rAF, and the door cancels its own rAF when the deadline wins, which closes `[F02]` at the same place. This fixes the class at the door, as [L27] requires, rather than caller by caller. The comment at `deck-manager.ts:8205` is deleted with the flag-only release it describes.

**[B02] The tracked-marks change gets a unit test, and the marked sets stop retaining detached elements.** The test covers: a stale mark from a deactivated context is cleared, a reprojection that changes nothing writes nothing, and an element unmounted while marked does not keep its mark's bookkeeping alive. It uses a stand-in document, since tugdeck's unit tests have no DOM.

**[B03] `at0109` and `at0121` are run alone and each red is classified before anything else is concluded about focus.** Real defect, stale test, or contention — and a real defect from the tracked-marks change is fixed here. A red that predates this work and is not caused by it is recorded with its cause, not waved past.

**[B04] The frame-bar tests are re-run alone at HEAD and their state is written down as the baseline.** `at0622`, `at0643`, `at0652`, `at0654`, plus `at0621` and `at0626`. Each is run as its own invocation, because the recorded history cannot tell a defect from contention otherwise. `at0654`'s header is corrected to what the run shows (`[F06]`); a leg that has gone green moves back to `at0622`. No bar is loosened.

**[B05] `demote off` resumes the loops it left still.** The breaker's off edge runs the same resume pass a workspace switch runs, so the module's promise that "the next pass tries again" has a pass to rest on.

**[B06] The switch epoch arms its own deadline when the mark is written.** The party that writes `data-space-switching` also guarantees its removal, on a bound, whether or not a React commit follows. The existing canvas effect stays as the ordinary close.

**[B07] The session card's focus-after-dismiss moves to a ready callback.** The focus runs from a layout effect keyed on the state that makes it legal, per [L04]/[L05], and is released on unmount.

**[B08] The ghosts are recorded as a third standing [D9] hit in the animation doctrine.** The `departing` mark that would remove them is deferred work with no brief; until it exists, naming the hit is what keeps the list evidence. This is a documentation change only.

---

## Open Questions {#open-questions}

- **Are `at0109` and `at0121` red for one cause?** Both read focus marks. Settled by running them alone and reading the failures (`[B03]`).
- **Is `at0643`'s first-paint red a defect or a bar the machine cannot meet?** Its own header says `at0622`'s two-frame bar has no margin on this machine. Settled by the solo re-run; if the bar is unreachable as written, that is reported to the user rather than changed.

---

## Non-goals {#non-goals}

- **Taking React out of the gesture's task, and the compositing walk.** Those are `briefs/gesture-task-without-react-brief.md` and `briefs/compositing-walk-and-overview-brief.md`.
- **Fixing the standing reds in `at0654`.** This work establishes their present state; their causes belong to the two briefs above and to the height-by-translation question.
- **The Beat primitive, a raw-`animate` lint, or breaking up `DeckCanvas`.** Real findings of the audit, and larger than a fixup.
- **Building the `departing` mark.** `[B08]` records the hit; it does not remove it.
- **Loosening any bar to turn a test green.**

---

## Exit {#exit}

**An arc.** The pieces are independent and small: the cancellable door and its callers (`[B01]`); the focus test and the two focus app-tests (`[B02]`, `[B03]`); the demote-off resume and the switch-mark deadline (`[B05]`, `[B06]`); the session card's ready callback (`[B07]`); the doctrine note (`[B08]`). The frame-bar baseline (`[B04]`) runs last, alone, at the tree all of that produced, so the numbers written down describe the code that stays.
