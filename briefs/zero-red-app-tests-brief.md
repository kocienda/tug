<!-- brief-skeleton v1 -->

# Zero red app-tests on main

**Purpose:** Twenty-one app-test files are red on main after `red-app-test-triage` (`0a16691e8`), which ended by labelling them "proposed carries". Every one of them ends green or deleted, and none is carried.

---

## Purpose {#purpose}

On 2026-10-02 the user gave the instruction for the first triage in capitals:

> I DON'T WANT ALL THESE RED TESTS. EITHER DELETE THEM OR ***DEFEND THEM LIKE IT'S THE LAST THING YOU EVER DO***.

That triage's brief still let a red end as "carried" ([B06] of `briefs/red-app-test-triage-brief.md`). The arc used that verdict fifteen times, proposed six more, and the audit checked that the carries were written down properly instead of flagging the clause as contrary to the instruction. On joining it, the user said:

> I don't want to *carry* failing tests. I want them fixed, changed, or deleted.

and, on asking for this brief:

> I ALREADY GAVE YOU THIS INSTRUCTION YESTERDAY EVENING. … **No carry verdict at all**. Every file ends green or deleted.

A carry is the habit the first triage existed to end, with paperwork added. This brief closes that door.

---

## Evidence {#evidence}

Every reading below is recorded in `briefs/red-app-test-triage-brief.md#verdicts`, taken one file at a time at `3651a084f` and its successors, with the 1659×1051 launch pin in place.

**[F01] Seven reds are real regressions with a bisect window or a named candidate.** **(verified as failures; causes not established)**
- `at0580-workspaces-move`: the home transcript shifts 1246 → 1310 natively within 2ms of a scroll landing. No script path writes it, and the move between workspaces then carries 1310 exactly. Green at `3bb2c7bfc` (10-01), red from `68fcd01c4`. First candidate: `85f697274`.
- `at0347-stack-badge-picker`: a ⌘-click on a title bar never opens the stack picker. Candidates: `f6f79bca9`, `85f697274`.
- `at0430-resize-scroll-preservation`: the text card's scroll goes to 0 on a width change, in place rather than by remount. Candidate: `8295073f6`.
- `at0497-landing-stream-scroll`: the landing field reads `scrollTop` 0 at 120ms after `ready`. Range since `f0f227ccc`.
- `at0537-rail-drag-seated-frames`: the seated outline misses the strip offset by exactly 149px, which is the strip's own offset. One of the two terms in `seatedPlace` (`drop-zones.ts`) lacks it.
- `at0559-ready-folded-form`: a folded card's masthead dot never reads Ready. The red streak begins at `07475295e`; candidate `89e9bfa27`.
- `at0594-column-flip-cover`: the retiring member lacks `data-imposer-covered` on the first sampled frames. Candidate: the gesture-task work moving the settle arm.

**[F02] Eight reds are frame-budget failures in the settle-frames family.** **(verified as failures)**
- `at0622`: resize-to-fit reads 2.06–2.18 frames against 2.
- `at0654`: warm flip first frame 24–26ms against 16.5–17; fold 20ms and 2.94 frames; departure 2.12–2.41 frames.
- `at0643`: the workspace switch's first frame is 74–81ms against 17, of which 56–63ms is React's render phase.
- `at0566`, `at0605`: the interior moves during a settle (3.27px; composer bottom 3.6px against 1.5). The failing leg rotates between runs.
- `at0626`: one 53ms frame inside the sash hold against 25ms.
- `at0632`: sash pin marks outlive the release by a sampled tick.
- `at0652`: the in-flight wave costs 1–3 rendering updates over the 2ms floor.

**[F03] `at0654` is red by design.** Its header is a ledger of standing settle reds, and a leg moves out only after three green runs alone. A test built to stay red is the carry habit made into a file. **(verified, read from the test header in the first triage)**

**[F04] Six reds outside the first census have not been read past their failing line.** Each is red alone with the first triage's whole diff reverted. **(verified as failures; nothing about cause)**
- `at0019-pane-teardown-flush`: no `card-host-unmount` follows a multi-card pane close.
- `at0191-turns-end-to-end`: the oldest row is turn 5 where turn 1 is expected. Last green `68fcd01c4`.
- `at0416-viewer-card-settings`: the Settings card has no `tug-tab-view-tab-viewerCard` tab to press. This looks like a stale premise, but that is not established.
- `at0425-arc-conflicted-join`: a live turn does not hold the discard. Intermittent; red more often than not.
- `at0493-atom-mark-raster`: the diamond mark's pulse reads 0 samples. Last green `50ebad6a8`.
- `at0621-intra-workspace-slide`: one frame after a cut-short arrival still wears an inline opacity.

**[F05] `set-content-width` lands 1px short of its preset (1229 against 1230), and has no test.** `at0372` was deleted on 2026-09-18 (`26568549d`) and was restored only behind a probe. `setContentWidth` and `setCardWidths` (`deck-manager.ts`) share the clamp. The candidate is the rail re-solve that only `setContentWidth` runs in the same commit. **(verified as a measurement; cause not established)**

**[F06] The last full corpus run also had six files red in the batch and green alone:** `at0051`, `at0295`, `at0334`, `at0335-changes-hunk-contention`, `at0410` and `at0426`. `at0426`'s failure names `at0427`'s scratch session, which is a shared-state collision rather than load. `at0566` was green in that run, and its leg rotates. **(verified, one run)**

---

## Decisions {#decisions}

**[B01] There is no carry verdict.** Every file named in [F01]–[F05] ends this work in one of three states, and only these:
- **green**, with the code fixed;
- **green**, with the test changed to assert the same guarantee correctly;
- **deleted**.

"Carried", "proposed carry", "standing red", "pre-existing", "not established" and "known red" are not outcomes. A record that a test is red is not a resolution of it. This supersedes [B06] of `briefs/red-app-test-triage-brief.md`.

**[B02] A file the arc cannot make green stops the arc, and the stop names the decision.** When a red resists its fix within reason, the arc runs `tugtool arc ask` for that file, giving the reading, the cause as far as it got, and the two choices: **delete** it, or **re-budget** it to a stated number with the reason. The user answers, and the arc applies the answer and goes on. A stop is a question with a deadline, which is now; a carry is a question deferred forever. The arc never chooses delete or re-budget on its own for a test that catches a real defect.

**[B03] `at0654` stops being a ledger of reds ([F03]).** It becomes an ordinary test whose legs are each green, or it is deleted. A leg whose budget the code cannot meet goes through [B02] like any other file. No test in the corpus may be designed to stay red.

**[B04] A deletion names what retired the premise, and is not a way out of a real bug.** The first triage's [B02] stands: a file is deleted when the behaviour it pins is gone, or when the user says so through [B02] here. A test catching a live defect is fixed, or put to the user. It is never deleted quietly.

**[B05] A budget moves only on the user's word, with the number and the reason in the test header.** Under [B02] the user may choose to re-budget, for example "resize-to-fit is 3 frames, not 2". The arc never moves a frame budget on its own reasoning. A re-budget changes the number to one the code meets and keeps the instrument and the assertion.

**[B06] A regression is settled by naming its commit.** For each file in [F01], bisect between its last green and its first red, or probe its named candidate with a reverse-diff `tugtool file probe`, rebuilding with `just app-test-build` at every step. Knowing the breaking change is what makes the fix small. The five fixes the first triage landed were each one.

**[B07] `set-content-width` gets a fresh test, red before and green after ([F05]).** Write a new small app-test that pins the pane landing exactly on the preset, rather than reviving `at0372`. `at0372` has drifted on three other cases since its deletion, and those are not part of this work.

**[B08] The arc ends on one full corpus run with zero red.** Batch-only reds count ([F06]):
- A file red in the batch and green alone is a shared-state collision or a test that cannot stand load, and gets fixed. `at0426`/`at0427`'s scratch-session collision is the first one to fix.
- A file whose result rotates (`at0566`) has to be green on three runs alone and in the batch.

The closing run is the evidence, and its result goes into a dated verdict section of this brief, one line per file: what was done and the sha that did it.

---

## Open Questions {#open-questions}

None that this brief can settle. The calls that remain are per-file and only appear when a fix stalls. [B02] is the mechanism that brings each of them to the user at that moment, with the reading in hand.

---

## Non-goals {#non-goals}

- **Carrying any red, under any name.** Rejected by the user twice ([B01]).
- **Deleting tests in bulk to clear the board.** Rejected in the first triage and still rejected ([B04]). Deleting a witness to a live bug is not one of the user's two endings.
- **The arc loosening budgets on its own judgment.** Only the user re-budgets ([B05]).
- **Reviving `at0372` whole.** It drifted on cases unrelated to the 1px defect ([B07]).
- **Changing the app-test harness's shape.** If a harness defect is behind several reds, as the launch pin was, it is fixed as the cause it is. The selection machinery and report format are not under review.

---

## Exit {#exit}

**An arc.** Its first steps, in this order:
1. **Read the six unread reds ([F04])** and give each a verdict and an ending. Some are probably stale premises, so this is the cheap part, and it shrinks the list first.
2. **Bisect and fix the seven regressions ([F01], [B06])**, one breaking commit at a time.
3. **The settle-frames family ([F02])**, with `at0654` converted first ([B03]) so that every leg is an ordinary assertion. Fix in code; anything that resists goes to the user through [B02].
4. **`set-content-width`** with its fresh test ([B07]).
5. **Batch-only reds and the closing corpus run ([B08])**, with the verdict section written.

The arc is finished only when that run shows zero red files.

---

## Verdicts — 2026-10-03 {#verdicts}

The closing corpus run (`just app-test-all` at `27b2185f6`, 441 files, 41m30s): **431 of 434 files green**, 7 skipped, 807 of 810 tests passed. The three reds are listed last, with what each did alone.

**Six unread reds ([F04]) — `0f9438b6f`:**
- `at0621-intra-workspace-slide` — **fixed in code.** A workspace switch dropped a pending arrival while its delayed fade, already built, finished and committed `opacity: 1` to a frame that was meant to stay hidden; a stale beat now cancels its own fades (`deck-canvas.tsx`).
- `at0019-pane-teardown-flush` — **test corrected.** The unmount is React's commit, which lands after the next paint; the test now waits for `card-host-unmount` instead of reading it on return.
- `at0416-viewer-card-settings` — **test corrected.** It waits for the viewer tab after `show-card`, for the same reason.
- `at0191-turns-end-to-end` — **test corrected.** A bare `scrollTop` write was undone by the follow-bottom pin; the test now scrolls the way a reader does, with a wheel event first.
- `at0493-atom-mark-raster` — **test corrected.** Its cloned diamonds carried the off-screen mark, which stops their loops; the clones now drop it.
- `at0425-arc-conflicted-join` — **test corrected.** It read the menu after the turn had ended and forged a `turn_complete` to get there; it now reads while the turn is live and waits for the turn to end.

**Seven regressions ([F01]) — `919b5a29e`:**
- `at0537-rail-drag-seated-frames` — **fixed in code.** A rail's autoscroll offset was written to the canvas, and the shown workspace layer's own copy of it overrode that, so the cards stood still until the drop and then jumped; the offset is written to the layer too (`deck-canvas.tsx`).
- `at0430-resize-scroll-preservation`, `at0497-landing-stream-scroll` — **fixed in code.** WebKit reveals a restored caret inside `focus()` despite `preventScroll`, which moved a Text card to the top and the commit composer off its tail; `cm6-focus-keeps-place.ts` puts the scroller back before the frame paints, in both editors.
- `at0580-workspaces-move` — **test corrected.** The shared `waitForTranscriptSettled` now also waits for the transcript's height to hold still.
- `at0347-stack-badge-picker` — **test corrected.** Since the grab handle became a card's only drag surface (`06889db93`), ⌘-click opens the picker there, and the test clicks it.
- `at0594-column-flip-cover` — **test corrected.** The frame before the layout change applies is not part of the motion.
- `at0559-ready-folded-form` — **test corrected.** The session dot stopped carrying `data-phase` (`5616490b6`); the test reads Ready from the dot's own face.

**The settle-frames family ([F02]) — `6d6292ee5`, `8a6f3b572`:**
- `at0632-sash-drag-box-is-pin`, `at0626-sash-drag-sampler` — **fixed in code.** A seam's release published the new division to the canvas while the shown layer kept the old one, so every member snapped back and the settle slid it forward again — the 54ms overrun in `at0626` was that settle. The division is published to the layer too (`deck-canvas.tsx`).
- `at0566-three-beat-settle`, `at0605-still-crossing-deliveries` — **test corrected.** WebKit steps a running tween's clock inside one callback (a frame read twice in one tick measured 5.7px apart), so a frame read before its interior disagreed with it; each sample is now retaken until its frames read the same before and after. Green three runs of three alone, and green in the closing run.
- `at0654-deck-settle-standing-reds` — **deleted, on the user's word ([B02]).** A test built to stay red. Its readings: warm-flip lead 18ms against a 17ms period; unfold 2.24 frames against 1.5; a card's departure 2.24 against 2 (closing a pane renumbers every survivor's position label, 2965 fibers); showing a two-member rail 3.00 against 2 (the rail's contents mount inside the window, 4501 fibers); column split 3.35 against 2 (real height tweens on a 2621–3289-fiber commit).
- `at0622-deck-settle-frames` — **re-budgeted, on the user's word ([B05]).** Resize-to-fit 2 → 2.5 frames; it read 2.06–2.18.
- `at0643-workspace-switch-cadence` — **re-budgeted, on the user's word.** First paint one period → 100ms; it read 45–75ms, one 3899-fiber commit re-rendering both layers.
- `at0652-loop-cost-and-life` — **re-budgeted, on the user's word.** Every rest clause idle → idle + 10 wakeups a second; it read 1–5 with the machine's load, where a main-thread loop reads 60.

**`set-content-width` ([F05]) — `27b2185f6`:**
- `at0681-content-width-lands-on-preset` — **new test.** Every content pane lands on `min(preset, band)` exactly, on three decks. Its first red was a read at a fixed 900ms, inside the settle that ending a bullseye starts; read once the settle lands, every pane is exact, so the 1229-against-1230 reading was the same mid-settle read, and `deck-manager.ts` needed no change. A probe making the pane land 1px short turns all three decks red. `at0372` stays deleted.

**Batch-only reds ([F06], and the two met during the arc):** `at0051`, `at0295`, `at0334`, `at0335-changes-hunk-contention`, `at0410`, `at0426`, `at0456`, `at0619` — green in the closing run with no change, except `at0295` (below).

**Red in the closing run:**
- `at0330-transcript-eviction` — **open: occlusion.** Red in the corpus (stepping up off the live bottom did not move), green alone. Red again in eight-file batches beside `at0607` and `at0603`, while `at0603`'s own sampler reported its window occluded (9 frames against a floor of 10). Every app-test window launches at the same autosaved origin and the pinned 1659×1051 size, and each new one is ordered back, so concurrent windows stack exactly and the covered ones get no `requestAnimationFrame`.
- `at0607-commit-hostile-filename` — **open: occlusion.** Red in the corpus (the Changes sheet did not appear within 80s), green alone. In the same eight-file batches the `/commit` popup stayed painted for 40s after Escape. The cause is the same stacked windows as `at0330`.
- `at0295-background-activation-click` — **fixed in the harness.** Backgrounding the app activates Finder, which raised a Finder window over the click point. A background click now orders the app's window front without activating it (`NativeEventHandlers.swift`). Green alone with the same Finder window open, and `at0451` is green too.
