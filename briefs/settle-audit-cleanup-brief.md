<!-- brief-skeleton v1 -->

# The settle audit cleanup: one instrument false positive, one open sync-door route, five unasserted bars, and the two reds nobody has attributed

**Purpose:** A second 360° audit of the settle, run after the fixup pass (`bcc8cb580`) landed, found the pass built as decided and found no user-visible defect in what it changed. It also found a short list that should not ride into the Beat primitive's brief as inherited truth: a bench classifier that can go red on the instrument rather than the deck, a synchronous React write the deferral rule missed, four bench legs whose beat guard is a note, two tests weaker than the bar they claim, a handful of documents that describe code that no longer exists, no ledger row at any landed sha, and two product reds recorded without a cause. This brief pins those and decides the one cleanup that closes them on `main`.

---

## Purpose {#purpose}

The user asked, after the fixup pass: "Do we need to make fixups? Or, can we move on from here with confidence that the codebase is in good shape? No code changes yet. Just a sketch or an all-clear."

The answer was neither. The eleven decisions of `briefs/settle-fixup-pass-brief.md` trace to code, and where the implementation deviated it wrote the deviation into the findings paper. The mechanisms the pass changed — the retarget vote, the prelaunch predicate, the pending-arrival record, the computed `deferCommit`, the picker recheck, the one mark gate — are correct on every path the audit could trace. What remains is smaller than a fixup pass and larger than nothing, and the user's call was: "Let's go here on the fixups, and let's do the work on main."

The work is a cleanup, not a redesign. Its output is a tree the Beat primitive's brief can open on without re-deriving anything, and a findings-paper section with the first readings taken at a landed commit.

---

## Evidence {#evidence}

### The instrument

**[F01] The stranded-tick classifier flags a legitimately landed frame.** `tugdeck/src/lib/settle-frame-probe.ts` ~656: a tick is stranded when the pane is past its first effect tick and not past its last, carries no transform effect now, sits at the identity, and carried an effect on the previous tick. A pane whose own beat landed inside a still-open recording (its `land` removes the transform, so the pane is at identity with no effect) and which is then re-tweened by a retarget in the same recording satisfies all three clauses on the tick after landing. The pump is not restarted on a retarget, so `last` for that pane is the re-tween's last tick. Shape: a `room` + `arrive` settle whose survivors' room beat lands, then a close during `arrive` retargets them. No unit case pins it; the three cases in `settle-frame-probe.test.ts` cover the mid-travel drop, the held-between-beats pane, and the clean run. **(verified by reading the clause; not reproduced on the bench)**

### The deferral rule

**[F02] `pruneTo` is a synchronous React-visible write on the sync door.** `tugdeck/src/components/cards/cards-selection-store.ts` ~268 calls `selection.pruneTo(...)` inline on every commit; `pruneTo` → `publish` fires the store's listeners synchronously whenever a selected id or a stale anchor drops, and the canvas subscribes to that store through `useSyncExternalStore` (`deck-canvas.tsx` ~2544). Closing a selected card that is not first responder takes the plain `notify` (deferred) and the prune publishes inline, so the canvas renders the new deck snapshot and runs the Last pass in the task's microtask — the [F05] shape the fixup pass's [B04] said it closed. Cost-only, before paint, on a rare path. **(verified by reading)**

**[F03] The six-subscriber audit justifies the `key-card` exception from a false dependency.** `tugdeck/src/deck-manager-store.ts` ~90 says deferring `syncKeyCard` "would leave `applyBagFocus` claiming focus for the card that was active before the commit." `applyBagFocus` (`focus-transfer.ts` ~552) calls `adoptKeyCard` with the incoming id and `adoptKeyCard` (`focus-manager.ts` ~2708) begins with `this.setKeyCard(cardId)`, so the transfer never reads what the sync subscriber wrote. What a deferral would break is the direct-activation paths that bypass the transfer — `activateCard` / `_flipFirstResponder` at `deck-manager.ts` 1538, 1867, 3031, 3087, 7056 and the cold-boot seed — where `syncKeyCard` is the only key-card writer. The exception must stand; the reason written down is wrong. The same list omits that `canvas-arm` now reaches React through the [B01] vote. **(verified by reading both sites)**

### The bench

**[F04] Four of the seven new bars only note their beats.** In `tests/app-test/at0622-deck-settle-frames.test.ts`, `beats` is asserted on the appear leg (~3248) and the depart leg (~3310) and nowhere else; the walk, bullseye, sidebar hide, sidebar show and retune legs print their beats through `reportB09`'s `note()`. The findings paper's step 7 preamble says every new leg asserts "the beat names the settle actually ran," and its table prints those beats as if judged. A regression that cuts instead of choreographs passes those legs on lead and gap; `row !== null` narrows the hole to "armed but ran the wrong beats." **(verified by grep)**

**[F05] `at0652` is one aggregate reading, not the per-loop bar, and the caret is green without a claim.** `tests/app-test/at0652-loop-cost-and-life.test.ts`: the wave asserts three running loops with advancing clocks; the dot asserts only that at least one `pulsing-dot-breathe` runs somewhere on the deck; the cost bar is a single `rest()` with dot and wave standing against an idle `restQuiet`, and `cost(120)` is noted only. The caret is "read, noted, and NOT claimed" (~345) inside a test that passes. [B09] asked for "per loop, not only the dot." The fixture reason — no app-test card takes real keyboard focus, so `.cm-focused` never sets — is recorded in step 7 but not in the test as a `todo`. **(verified by reading)**

**[F06] `at0643` keeps a 150 ms lead budget where [B09] said one display period.** `FIRST_PAINT_BUDGET_MS = 150` (`at0643-workspace-switch-cadence.test.ts` ~157) still stands as the lead bar; only the 20 ms gap clause and `gapsOverOneFrame === 0` were demoted to notes. `assertCadence` returns `false` on `suspended`, and the test passes on notes when all four switches are voided (~684–705). **(verified by reading)**

**[F07] `expectLastPassAfterNotify`'s in-flush clause is conditional.** `at0622` ~1739: the "Last pass not inside the flush" clause runs only if both `tug:flushSync-start` and `tug:flushSync-end` are present; a change that drops those marks skips the pin silently. `clickTaskMarks` also collapses more than three occurrences of a mark to `{first, last}`, so a Last pass in the middle of a longer run would be invisible to the filter. **(verified by reading; suspected in consequence)**

### The doors

**[F08] Two computed-style reads now sit inside every activation's click task.** `mayDeferCommit` (`focus-transfer.ts` ~1274) calls `hiddenClaimReason`, which reads `getComputedStyle(root).display` before the commit; step 4b (~953) reads it again after `applyBagFocus`, on every `transferFocusForActivation` caller including the real click path (`pane-focus-controller.ts` ~153). It is the class of read [F11] of the fixup brief removed from every commit. Style-only, never layout; on the warm-flip leg the first read comes from a fresh task and the second follows `.focus()`, which flushes style itself, so the marginal cost is the invalidation of the ring's attribute writes. Unmeasured; not recorded in [D204] or step 7. **(verified existence; magnitude not measured)**

### The documents

**[F09] Seven lines describe code that no longer exists or make a claim the code contradicts.** `tuglaws/animation-doctrine.md` line 273 still prescribes `fill: 'none'` for FLIP settles, contradicting its own new paragraph at ~313 and `deck-canvas.tsx` ~5407. `tugdeck/src/lib/perf-marks.ts` ~60 claims an app-test step grep for direct `performance.mark` that does not exist, and ~71 says the settle's arm clears marks when only `armSettleFrameProbe` (`test-surface.ts` ~3104) does — a deviation step 7 records with a rule and the code comment contradicts. `briefs/session-fold-first-frame-brief.md` carries no banner though [F14] of the fixup brief says its [B01]–[B03] are unbuilt. `briefs/deck-animation-pipeline-brief.md` [B10] describes an always-on product pump now gated on a trace kind, with no banner. Step 7's "this document's residency table above" points at a table that lives in `animation-doctrine.md` ~249. `deck-canvas.tsx` ~5892 says "the deck has no animation left that is unconditional on the settle generation" while ~6262 correctly says the ghost fade's landing is; and ~4876 still states "nothing paints in between" as a fact three paragraphs before ~4906 explains it is false under [D204]. **(verified by reading each)**

**[F10] Step 7 does not restate the program or the ask's ledger.** It hands the Beat primitive one question (retarget: flush vs store-planned) and does not carry step 6's ordering (pane-chrome grain → bound bench → Beat → superseding brief), does not list which gestures remain Last-pass-planned (all but the flow slide), and does not say that the ask's one-frame bar, always-on instrument, "one hold, one quiet" and "nothing created or destroyed in a gesture" were consciously not taken. A reader starting from step 7 sees one mechanism with one open question. **(verified by reading)**

### The evidence base

**[F11] No app-test ledger row exists at any landed sha.** `just db-inspect apptest_results`: every reading in step 7 is from dirty arc-worktree shas (`7eb709553`, `9cf36fd9f`, `4a30072ba`, `d1a9a385f`). `at0622` read 13/16 on its last run where the paper says 12/16 — consistent with the rotating warm-flip edge, but the paper states one number. `at0566` last read red at `09d8f0e56` mid-arc and was not re-run. `at0605-still-crossing-deliveries`, which the doctrine cites as the still crossing's gate, has been red for 21 recorded runs, last green 2026-09-26, and was never run during the arc. **(verified from the ledger)**

**[F12] Two product reds stand with no attributed cause.** A card's departure from a split column leads by 24, 29 and 33 ms across three runs with `commitDelayMs` 0, so the whole lead is the deck's own after the arm. Showing a two-member rail gaps 3.65–3.76 frames (62–64 ms) where hiding one gaps 1.29; the asymmetry points at the arriving rail's cards mounting inside the window — the "component mounting inside the flush" route step 7 itself names as unforbidden — but nothing has read the commit census on either leg. Both contradict the ask's own bullets. **(readings verified from step 7; cause is inference)**

### What holds, so it is not re-audited

**[F13] The fixup pass's mechanisms are correct on every traced path.** The retarget vote is nested per commit, drains any earlier deferral first, and React cannot render inside a subscriber call, so the Last pass always follows the restores and always lands before paint. The prelaunch cannot coexist with a measured arm or double-tween a pane. Every drop of a pending arrival hands its hold back. The `hiddenClaimReason` predicate answers correctly for parked, background-tab, folded and hidden-rail cards. The picker recheck has no dropped-forever case. Every mark site is behind the gate; the census and the pump are off the shipping path; the cached motion flag is correct at boot. L01, L02, L03, L06, L22, L27, L32 hold in every touched file. Unit suite 9780 pass, typecheck clean, the three tugdeck audits clean; the one unit red (`three-way-merge.fuzz`) predates the commit. **(verified by two independent readings)**

---

## Decisions {#decisions}

**[B01] The stranded-tick clause counts only a tick whose previous effect was cancelled, not one that finished.** The classifier gains the distinction it lacks: a pane at identity with no effect after its own beat landed is landed, and a pane at identity with no effect after a cancel is stranded. The probe already sees effects per tick; the narrowing reads whether the previous tick's effect reached its end time or vanished before it. A unit case for "landed, then re-tweened in the same recording" reads zero, and the existing mid-travel-drop case still reads one. Closes [F01]. Lands first, because the retarget bar in every later step reads this number.

**[B02] `pruneTo` takes the same coalescer `pickOnly` takes.** The prune's publish is scheduled through the store's one-slot `scheduleAfterPaint`, with the same reduced-motion stand-down; the synchronous read of the card list stays. Closes [F02]. The [B04] rule from the fixup brief is unchanged; this is its second worked example.

**[B03] The six-subscriber audit gives the true reason for the `key-card` exception and names the arm's vote as the second exception.** The `key-card` entry is rewritten to cite the direct-activation paths that bypass the transfer; the `canvas-arm` entry says it reaches React through `flushPendingNotify` on a retarget. Closes [F03]. Doc only; it is the artifact the Beat primitive's author will treat as law.

**[B04] Every [B09] bar asserts its beat names.** The walk, bullseye, sidebar hide, sidebar show and retune legs each gain an `expect` on `row.beats` equal to what step 7's table already prints for them. Closes [F04]. A leg that turns out to run different beats than the table says is a finding, recorded, not a loosened assertion.

**[B05] `at0652` reads each loop's cost separately and marks the caret a `todo`; `at0643` holds the one-period lead and cannot pass on a voided run.** The dot and the wave each get a rest reading against the idle floor; the caret clause becomes `test.todo` with the fixture reason in its name. `FIRST_PAINT_BUDGET_MS` becomes one derived display period, and an all-suspended run is red. Closes [F05], [F06]. A reading that comes out red stays red and is recorded in the findings paper.

**[B06] The in-flush pin fails when its marks are missing.** `expectLastPassAfterNotify` asserts the presence of both flush marks before reading them, and `clickTaskMarks` keeps every occurrence rather than collapsing to first and last. Closes [F07].

**[B07] The two style reads are measured before they are kept.** The `tug:applyBagFocus-end` to `tug:flushSync-end` span and the `mayDeferCommit` call are read off the warm-flip leg with the reads in and with them reverted under `tugtool file probe`. Under one millisecond, the cost is written into [D204] and the reads stay. Over it, the pre-commit read is replaced by the store's parked and tab facts alone and only the post-claim read remains. Closes [F08]. The decision is the measurement's; this brief does not pre-empt it.

**[B08] The seven lines are brought to the code, and step 7 gets the ledger it lacks.** Each line in [F09] is corrected or bannered as named. Step 7 gains a closing subsection carrying step 6's program order, the list of gestures still planned in the Last pass, and the ask's five concepts and two rules each marked delivered, reversed with a citation, or owed. Closes [F09], [F10].

**[B09] The reds are re-run alone at a landed tree, and the readings are the first at a landed sha.** After [B01]–[B08] are committed, `at0622`, `at0566`, `at0605-still-crossing-deliveries`, `at0643`, `at0652`, `at0649` and `at0650` are run each alone, then once as a batch, through `just app-test`, so a ledger row exists at a landed commit with a history line. Each result is recorded in a "Step 8" section of the findings paper. Closes [F11]. `at0605` is the doctrine's own gate; if it is red alone at a landed tree, the doctrine's citation is corrected to say so rather than left pointing at a green that is not there.

**[B10] The departure and show-rail reds are attributed, not fixed.** The commit census and the click-task marks are read on those two legs and the time is named — which commit, how many fibers, mounting or re-rendering, inside or outside the window. The finding goes into the findings paper. A fix lands only if the cause is one line; otherwise the named cause is what the Beat primitive's brief opens on, because both look like the mount-inside-the-window class the primitive cannot close by itself. Closes [F12].

---

## Open Questions {#open-questions}

- **Whether the stranded-tick narrowing in [B01] is "previous effect cancelled" or "pose is not the pane's own last curve endpoint."** Both close [F01]; the first is cheaper and the second is more general. The unit case decides: whichever reads zero on the landed-then-re-tweened shape and one on the mid-travel drop without touching the held-between-beats case.
- **Whether [B07]'s reads come out under a millisecond on the real click path, not only the warm flip.** The warm flip is `activateCard`; the user's mouse click takes `pane-focus-controller.ts` and never defers. The post-claim read is on both. The probe should read both once.

---

## Non-goals {#non-goals}

- **The Beat primitive.** This cleanup exists so its brief can open on a tree with nothing to re-derive. Nothing here adds an abstraction above `animate()`, and the six seams the audit named (two beat-record writers, two release idioms, the ghost's post-launch landing, the arriving strip's empty-anims record, the unrecorded pending arrive fade, the re-measure after a retarget) are the primitive's to collapse, not this pass's.
- **Motion before React for the fold, the arrival, bullseye and the slot.** [F14] of the fixup brief stands; the fold's 11–19 ms lead is the deferral plus the Last pass, and moving that is the primitive's work.
- **Fixing the departure or show-rail red** beyond a one-line cause. [B10] attributes; the fix is the next brief's.
- **The pane-chrome grain** (917-fiber title-bar re-render on a focus flip). Known since step 6, still the next lever, still not a defect.
- **Loosening any bar.** A red from [B04], [B05] or [B09] is a finding.
- **A bound-card bench fixture** for the caret. The `todo` names it; building it is its own question.
- **An arc worktree.** The user chose `main`; each decision is one commit the user lands.

---

## Exit {#exit}

An arc, on `main`. The order is the dependency order: [B01] first, because every retarget reading after it is taken against the narrowed classifier; then [B02] and [B03], the correctness fix and the doc it belongs beside; then [B04], [B05] and [B06], the bench brought to the bar it claims; then [B07], the measurement and whichever branch it decides; then [B08], the documents, written from what the code and the legs now say; then [B09], the first ledger rows at a landed sha, which needs everything before it committed; and last [B10], the two attributions, which hand the Beat primitive's brief its first two findings. The findings paper's "Step 8" carries the readings from [B09] and [B10].
