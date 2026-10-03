<!-- brief-skeleton v1 -->

# Triage every red app-test on main

**Purpose:** Thirty-two app-test files are red on main, most of them for weeks. Every arc that met them called them "pre-existing" and moved on, so they piled up. Each one gets a verdict and the action that goes with it, and no red is left on main without an explanation.

---

## Purpose {#purpose}

The third graphics audit classified run 4968's reds and wrote them into `briefs/gesture-hold-followups-brief.md`. On reading that list, the user said:

> HOW IN THE F$CK DO WE HAVE 25 TESTS THAT ARE RED. HOW?????? … THEY PROBABLY JUST SUCK OR THE NEW CODE YOU WROTE SUCKS.... OR BOTH!!!! I DON'T WANT ALL THESE RED TESTS. EITHER DELETE THEM OR ***DEFEND THEM LIKE IT'S THE LAST THING YOU EVER DO***.

A red suite trains everyone to skim past red, and a red that matters then hides among the ones that don't. The cause is not one bad commit. It is a habit: each arc wrote its reds down instead of resolving them.

---

## Evidence {#evidence}

**[F01] There are 32 red files, in three groups.** They are recorded in `briefs/gesture-hold-followups-brief.md#reds-read-alone-2026-10-02`. Every file in run 4968's fail list was run once alone at `50ebad6a8` and sorted with `tugtool apptest history`. **(verified, from the recorded runs)**
- **Red and pre-existing (25):** `at0017`, `at0043`, `at0277`, `at0339`, `at0347`, `at0430`, `at0454`, `at0456`, `at0497`, `at0537`, `at0541`, `at0549`, `at0559`, `at0566`, `at0571`, `at0580`, `at0594`, `at0597`, `at0605`, `at0613`, `at0626`, `at0643`, `at0645`, `at0652`, `at0654`. Each was red before the gesture hold reached main at `85f697274`. The oldest last-green dates are 08-28.
- **Unclassified (6):** `at0369`, `at0405`, `at0443`, `at0561`, `at0631`, `at0632`. None has a green on record, and nobody has said why they are red.
- **Plus `at0622`:** red once alone on the resize-to-fit retune (2.18 frames against 2). Its last green was `f720a4e43`.

The four files that went green alone (`at0019`, `at0334`, `at0335`, `at0493`) are contention and are not in scope. The tree has moved since: the graphics-audit-three-fixups join is `c7b4ae09e`.

**[F02] Some of these reds are real product bugs, and the test is the only thing that can see them.** `at0622`'s failure text names "the dead time the user reported and the instrument could not see". Its budget was tightened on purpose to catch a live settle-frames defect. `at0654` is a deliberate ledger of standing settle reds: its header records leg readings and moves a leg out only after three green runs alone. Deleting either one deletes the only witness. **(verified, read from the test headers)**

**[F03] Some of these reds are probably the test's fault, not the product's.** Prior sessions recorded three:
- **`at0605`:** "composer bottom rides its frame" fails at 2.2–3.6 px against a 1.5 px bar, and the failing sub-case rotates between runs.
- **`at0277`:** the jots list's `outlineWidth` reads `3px` against a pinned `0px` (the [D122] "the container marks nothing in the within state" assertion). It regressed between `dbb5563d8` and `e4fa38cb0`.
- **`at0339`:** times out waiting on its own `clearComposer` helper's `data-empty`, on a clean base.

None of these has been settled as either a test defect or a product defect. That is exactly the gap this work closes. **(verified as observations, recorded in prior sessions; the cause of each is not established)**

**[F04] The last time this was done, it worked.** The 2026-09-18 corpus audit at `676ffcb85` had 24 reds. 23 of them failed alone, and they were resolved to zero: 5 fixed and 19 deleted.
- **Two root causes covered several test defects at once.** One was tests re-deriving the rail gutter as `railWidth + GAP` instead of importing `flowBandEdges`. The other was fixtures that overflow the 1659×1051 app-test viewport.
- **Some deleted tests were catching real bugs**, and their findings survive only in session memory: Escape no longer aborting a tab drag (`at0021`), a keymap override never reaching the menu bar (`at0182`), and `set-content-width` landing 3 px short (`at0372`).

**(verified, from the recorded audit; whether those defects still stand is not re-checked here)**

**[F05] Rewriting a test to match new behaviour can quietly kill a decision.** The rail-panel arc rewrote `at0454`'s probe in a way that held the flow-occlusion regression in place. `at0454` is on this list. **(verified, recorded in a prior session)**

---

## Decisions {#decisions}

**[B01] Every file in [F01] gets exactly one verdict, and each verdict comes with its action.**
- **Obsolete premise:** the behaviour it pins was deliberately changed or removed. Delete the whole file: its fixtures, its `CORE_TIER` entry, and every citation in `tuglaws/` and `briefs/`. "Pre-existing" is not a verdict, and neither is "unclassified".

- **Bad test:** wrong geometry, a re-derived constant, viewport overflow, a stale helper, a bar tighter than the instrument can resolve. Fix the test so it asserts the same guarantee correctly.

- **Real regression:** fix the code, and the test goes green on its own.

  When a test is red with a cause it can't be blamed for, that is the third verdict, not the first.

**[B02] Nothing is deleted in bulk, and nothing is deleted just for being red.** A file is deleted only when the behaviour it pins is gone, and the commit names the change that made it go. That rules out the easy route of clearing the board by deleting the 32 files. The user's directive was "delete them or defend them", and deleting a test that catches a live bug ([F02]) is neither.

**[B03] A bar moves only with a stated reason, and the reason is about the measurement.** "It keeps failing" is not a reason. A bar that sits below the instrument's resolution, or a sub-case whose result rotates between runs, is a reason. Write it in the test header. A frame budget that encodes a user-visible promise (`at0622`, `at0654`) is never loosened. Its red is fixed in code or carried as a named bug.

**[B04] The verdict comes from reading the test and running it, not from its history.** Read which assertion fails, and run the file alone; three times when the result varies ([F03] `at0605`). Where the question is "did a change break this", use a reverse-diff `tugtool file probe`. `tugtool apptest history` says when a test went red. It does not say why.

**[B05] When a test that guards a decision has to move, it must still assert the same guarantee ([F05]).** If it cannot, the decision is being reversed. Say so in the commit and in the governing law, and don't quietly re-point the probe.

**[B06] The arc ends when every file in [F01] is green, deleted, or carried.** A carried file is a named open bug with its own brief or an entry in `at0654`'s header, and it is carried only with the user's say-so at the join. The verdicts go into a dated section of this brief, with one line per file: verdict, cause, and the sha that resolved it. The classification lives in a tracked file and outlives the arc, so [F06] of the graphics-audit-three-fixups brief cannot happen again.

**[B07] The defects in [F04] get checked again.** For each of the three defects the 2026-09-18 audit found through tests it then deleted, read the current code. If the defect still stands, fix it here or record it in this brief's verdict section as a carried bug. The last triage deleted their witnesses and left them unowned.

---

## Open Questions {#open-questions}

- **Which reds may be carried rather than fixed?** [B06] lets a real regression be carried, but only on the user's word. The likely candidates are the settle-frames reds (`at0622`, `at0654`), which are their own motion work. The arc should propose a carry list at the join rather than decide one.

---

## Non-goals {#non-goals}

- **A full-corpus sweep as the method.** It takes about 85 minutes, and the ledger already names the reds. Each file is run alone. One full corpus run at the end is the exception, to show the triage didn't create new reds through contention or shared state.
- **Loosening frame budgets to turn motion tests green.** [B03].
- **Rewriting tests to someone's taste.** A green test that measures correctly is left alone, even if it reads oddly.
- **Changing the app-test harness or selection machinery.** If a harness defect turns out to be behind several reds, it is fixed as the cause it is, but the harness's shape is not under review here.

---

## Exit {#exit}

**An arc.** The first move is a census, not a fix:
1. Run each of the 32 files alone at the current tree and record which assertion fails.
2. Group the files by root cause. [F04] suggests a few causes will cover several files.
3. Work cause by cause rather than file by file, so one fix to a shared fixture or helper turns several files green at once.
4. Do the deletions in their own rounds, each naming what retired its premise.

The [F04] re-check ([B07]) can run alongside. The arc ends with the verdict section written into this brief, plus one full corpus run showing that only the agreed carried bugs are still red.

---

## Verdicts (2026-10-02) {#verdicts}

**Census, provisional.** Every file was run alone at `1e6255da1` after `just app-test-build`, twice: once as the tree stands (pass 1) and once with `launchTugApp` pinning the window's content to 1659×1051 through a `tugtool file probe` (pass 2). Timeouts were then re-run with a probe that names the calling line. All 32 were red in pass 1. A line marked provisional below names a cause that was read but not established; its verdict and its carry are final.

### The tally

Of the 32 files, 17 are green alone, none is deleted, and 15 are proposed as carries for the join. One deleted test (`at0021`) is reinstated as the witness of a fixed defect, and one orphaned defect (`at0372`) joins the carries.

| File | Verdict | Cause | Resolved |
|------|---------|-------|----------|
| `at0017` | bad test | `JSON.stringify` order compare | green, `15bd301cd` |
| `at0043` | bad test | smart-insert pads atoms (cause C) | green, `15bd301cd` |
| `at0277` | bad test | `outline-width` under `outline-style: none` | green, `15bd301cd` |
| `at0339` | bad test | `clearComposer` left a trailing newline | green, `71b9e1b6c` |
| `at0347` | real regression | ⌘-click never opens the stack picker; not established | carry |
| `at0369` | real regression | flash retry outrun by the deferred commit (cause B) | green, `71b9e1b6c` |
| `at0405` | bad test | draft written to a ledger the launch never reads | green, `efcba754d` |
| `at0430` | real regression | text card loses its scroll on a width change | carry |
| `at0443` | real regression | hook below the no-git early return | green, `71b9e1b6c` |
| `at0454` | bad test | leaked viewport (cause A) | green, `15bd301cd` |
| `at0456` | bad test | leaked viewport (cause A) | green, `15bd301cd` |
| `at0497` | real regression | landing field loses its top hold | carry |
| `at0537` | real regression | seated outline misses the strip offset | carry |
| `at0541` | bad test | leaked viewport (cause A) | green, `15bd301cd` |
| `at0549` | bad test | leaked viewport (cause A) | green, `15bd301cd` |
| `at0559` | real regression | folded masthead dot never reads Ready | carry |
| `at0561` | real regression | line-tier citation larger than its line | green, `71b9e1b6c` |
| `at0566` | real regression | interior moves during a settle | carry |
| `at0571` | bad test | predates every-card-folds' 145px tier | green, `15bd301cd` |
| `at0580` | real regression | home transcript jumps 64px after a scroll lands | carry |
| `at0594` | real regression | cover misses the first sampled frames | carry |
| `at0597` | bad test | leaked viewport (cause A) | green, `15bd301cd` |
| `at0605` | real regression | composer bottom leaves its frame mid-settle | carry |
| `at0613` | bad test | smart-insert pads atoms (cause C) | green, `15bd301cd` |
| `at0622` | real regression | resize-to-fit settle frames over budget | carry |
| `at0626` | real regression | 53ms frame in the sash hold (stale sampler fixed, `15bd301cd`) | carry |
| `at0631` | real regression | zoom-rect sweep outrun by the deferred commit (cause B) | green, `71b9e1b6c` |
| `at0632` | real regression | sash pin marks outlive the release | carry |
| `at0643` | real regression | workspace switch's first frame 74–81ms | carry |
| `at0645` | bad test | fill predates the Overview's 150-row ceiling | green, `efcba754d` |
| `at0652` | real regression | in-flight wave over the 2ms floor | carry |
| `at0654` | real regression | standing settle-frame reds | carry |

**The carries proposed for the join:** the settle-frames family (`at0622`, `at0654`, `at0643`, `at0566`, `at0605`, `at0626`, `at0594`, `at0632`, `at0652`), whose budgets [B03] does not let move and whose causes are the settle work's own; the interaction regressions with no established cause (`at0347`, `at0430`, `at0497`, `at0537`, `at0559`, `at0580`); and `set-content-width`'s 1px shortfall (`at0372`, test left deleted). Each stays red with its test untouched, so its witness survives until the bug is fixed.

### Shared cause A — the app-test viewport leaks between runs

`at0626` sizes the window to a 1700px height, and AppKit's frame autosave (`NSWindow Frame MainWindow` in the `dev.tugapp.app.apptest` defaults, re-applied by `setFrameAutosaveName` in `MainWindow.swift` after the screen-fit clamp) carries it into every later launch. Every other test has been running at 1982×1700 rather than the 1659×1051 its fixture was written against, on this machine since `at0626`'s sash arcs (09-24 to 09-26). Pinning the content size at launch turns five files green alone and unmasks a sixth. The fix is the harness's: `launchTugApp` pins every launch to 1659×1051 (`LAUNCH_CONTENT_SIZE`), so one test's window state never reaches the next. Fixed in `15bd301cd`; a 61-file screen (the core tier and every app-test added since 09-24, the ones written on the leaked window) is green at the pinned size.

- `at0454-flow-mode` — line 1092, "the fixture must leave the inheriting card out of the band": 5 vs < 3.5. **Bad test (cause A)** — green alone, `15bd301cd`.
- `at0456-column-overflow` — line 365, "p2 stands at its own floor": 480 off. **Bad test (cause A)** — green alone, `15bd301cd`.
- `at0541-rail-press-no-reveal` — no rail member straddles the window foot (five 340px members fill a 1700px run exactly). **Bad test (cause A)** — green alone, `15bd301cd`.
- `at0549-card-drag-leaves-the-rail` — line 376, "the rail it could land in scrolls under the hold": 0. **Bad test (cause A)** — green alone, `15bd301cd`.
- `at0566-three-beat-settle` — line 311, "no top inside B moves during the move": 1.80 (departure) unpinned; green once pinned, then red alone again at 3.27 (arrival). The leg rotates and the miss is well above the instrument. **Real regression** (the interior-stillness family with `at0605`), not cause A.
- `at0597-drop-lands-then-reveals` — line 170, "the target tile must straddle the band edge": −275. **Bad test (cause A)** — green alone, `15bd301cd`.

### Shared cause B — a one-task retry outrun by the deferred commit

Since `85f697274` (gesture-task-without-react), the deck's React commit lands in a later task than the gesture that caused it. Two features hand off across that boundary with a `setTimeout(0)`, so they now fire before the element they need exists.

- `at0631-update-pill-zoom-rects` — line 382, "rectangles were lit on the way out": 0 of 72 frames, `data-zoom` never set. `stashZoomRect` (`zoom-rects.ts`) sweeps its rect on `setTimeout(0)`, and the wizard now mounts after the sweep, so its claim finds nothing. **Real regression (cause B)** — the sweep now waits for the gesture's release (`afterGesture`) and one task more, guarded by a generation; the reduced case's bar allows the gesture scope's one held frame before the mount, with the reason in the header. Green alone, `71b9e1b6c`.
- `at0369-open-file-nearest-slot` — line 136, the opened file's pane never wears `tug-pane-flash`. `flashPaneBorder` (`flash-pane-border.ts`) retries once on `setTimeout(0)` when the pane is not in the DOM yet, and the retry now misses too. An opened file's card never flashes. An open is not a pointer gesture, so the miss is the deck store's own after-paint notify ([D204]) as much as the scope. **Real regression (cause B)** — the retry joins the gesture's release, waits past the next paint, then one task more. Green alone, `71b9e1b6c`.

### Shared cause C — a deliberate change the test's expected value predates

- `at0043-tug-text-editor-copy-diag` — line 325, mixed ⌘C: `x [main.ts](…)` vs `x[main.ts](…)`. `ac498e5e0` (smart-insert) pads an inserted atom with a space on purpose. The label substitution the test guards still holds. **Bad test (cause C)** — green alone, `15bd301cd`.
- `at0613-session-card-drop-surface` — line 243, axis caret drop: `A ￼ B` vs `A￼B`. Same padding, from the same commit. The atom still lands at the caret with the draft intact. **Bad test (cause C)** — green alone, `15bd301cd`.

### Measurement defects

- `at0017-savestate-rpc-parity` — line 126, `saveState()` bag vs window-blur bag. The bags hold identical keys and values in a different insertion order, and the test compares `JSON.stringify` strings. **Bad test** — compared as values, green alone, `15bd301cd`.
- `at0277-row-accessories-keyboard` — line 242, `outlineWidth` `3px` vs `0px`. `3px` is `medium`, which this WebKit reports as the computed `outline-width` under `outline-style: none` instead of 0. The suppression rule `.tug-list-view:is([data-key-within])` is in place, and `at0121` already reads `outlineStyle === "none" ? "0px" : outlineWidth`. **Bad test** — read the same way, green alone, `15bd301cd`.
- `at0626-sash-drag-sampler` — line 769, "the gauge took render-cost samples inside the held window": 2–3 vs > 8. Since `32a0a0c6f`, `__tugMotion.cost(1)` follows its two-frame burst with a 1000ms `sampleRest`, so the back-to-back loop gets one sample per second of a 2.9s hold. **Bad test (stale helper)** — sampled in `sampleFrame`'s own shape in `15bd301cd` (87 samples in the hold, p95 4ms). The file is still red on its next assertion: one 53ms frame inside the held window against a 25ms bar, a reading pass 1 already carried. **Real regression** behind the fixed instrument, for the regression step.
- `at0605-still-crossing-deliveries` — line 360, "join: B's composer bottom rides its frame's bottom edge" < 1.5: 6.29 unpinned, 1.55 pinned; [F03] records the sub-case rotating between runs. Read three times alone at the pinned size: 3.71 (stack), 3.59 (stack), green. A 3.6px miss is far above what the instrument resolves, so [B03] gives no reason to move the bar. **Real regression** (the interior-stillness family with `at0566`).
- `at0571-picker-card-arrival` — line 998, "alone in its column the folded sitter is still the whole run": sitter 145 of run 1041. `pane-model.md` [D195] says a folded member is ceilinged and a place whose members are all ceilinged "stands as a strip", which is the opposite of the test's precondition. The sitter is a `hello` card, which since `89e9bfa27` (every-card-folds) folds to the shared `FOLDED_CARD_HEIGHT_PX` of 145 rather than its own 150 `min.height`, alone or not ([D185] as amended). The test's copied 150 and its whole-run precondition both predate that. **Bad test** — the precondition reads the tier, the copy reads 145, and every assertion about who takes the room is unchanged; green alone, `15bd301cd`.

### Real regressions

- `at0443-no-git-notice` — waits for `tug-no-git-notice` after a no-git `host_tools_result`, and it never appears. `32a0a0c6f` placed `useMotionHold(isAwaitingScan)` (`session-changes-view.tsx:464`) below the no-git and `no_repo` early returns, so the no-git render runs one hook fewer and React throws. The file's own comment records `at0443` catching this exact fault before. **Real regression** — the composition and the hold moved above the returns, the hold gated off on both notices. Green alone, `71b9e1b6c`.
- `at0339-session-find-bar` — `clearComposer`'s `data-empty` wait times out at step 9. The composer is still in landing mode: a `cm-landing-subject` line plus a body line, so the doc is `"\n"` and never empty. Step 6 opens Changes with ⌃⌘C and leaves it with ⌘F, and the composer stays a commit-message editor after that. Read again in step 3: landing mode *is* left (`data-landing` is off after ⌘F; `cm-landing-subject` rides every composer and is painted only under `data-landing`). The stray line is step 5's: Return in this composer inserts a newline by design (`returnKeyAction: "newline"`, `2dec6879b`), so the typed probe leaves `"not a search\n"`, and `clearComposer` backspaced from a caret the centre click put on line 1, leaving the newline. **Bad test** — the clear deletes both sides of the caret, and the step-5 message no longer claims Return submits. Green alone, `71b9e1b6c`.
- `at0347-stack-badge-picker` — line 403: the badge, the picker and the row choice all pass; a ⌘-click on a title bar then never opens the stack picker. Candidates are the 10-01/10-02 press-path changes (`f6f79bca9`, `85f697274`), not established. **Real regression, provisional.**
- `at0430-resize-scroll-preservation` — line 655, the text card's top line goes from `line 115` to `line 0` on a width change (`scrollTop` 6281 → 0). A probe shows the same scroller and the same `.cm-editor` survive the change, so this is not a remount. The document loses its scroll in place. **Real regression, provisional.**
- `at0497-landing-stream-scroll` — line 297, the field reads `scrollTop` 0 120ms after `ready`. The 450ms `LANDING_TOP_REVEAL_MS` beat is intact, and the `ready` path restores the pre-draft message before the final one (`tug-prompt-entry.tsx`). Which change broke the hold since `f0f227ccc` is not established. **Real regression, provisional.**
- `at0537-rail-drag-seated-frames` — unmasked by the pin. Line 335: the dropped card lands at 811..1051 against an outline at 960..1200, with the strip at offset 149 both under the hold and after it. The seated outline is drawn in strip coordinates without the strip's offset, so it hangs past the run. **Real regression, provisional.**
- `at0559-ready-folded-form` — runs to its 240s budget waiting for a folded card's masthead dot to read `data-phase="ready"`, and the dot never says Ready. The red streak begins at `07475295e`; the candidate is the 10-02 fold work (`89e9bfa27`), not established. **Real regression, provisional.**
- `at0561-narration-annotation` — line 611, the session citation stands 15.6px in a 14.4px line band. The `line` tier sets `font-size: var(--tug-font-size-sm)` (13px, `line-height` 15.6px) inside a 12px narration line, so the citation's type is larger than the prose around it. The mention's own doc comment still reads the line as 13px; `0.75rem` is the masthead line's size now. **Real regression** — a line-tier mark inside a session annotation inherits its host's size, as the commit mention does. Green alone (14.4 in a 14.4 band), `71b9e1b6c`.
- `at0594-column-flip-cover` — line 304, the retiring member does not wear `data-imposer-covered` on the first sampled frames (4–12ms), in both cases. A candidate is the gesture-task work moving the settle arm past the first sample; not established. **Real regression, provisional.**
- `at0632-sash-drag-box-is-pin` — line 247, "no member is left marked after the pointer is released": 2. The pin's marks outlive the release by at least one sampled tick; the candidate is the release landing in its own task (`f6f79bca9`). **Real regression, provisional.**
- `at0652-loop-cost-and-life` — line 556, the in-flight wave costs 1–3 rendering updates over the 2ms floor with every dot stood down (the idle card costs 0). It varies across runs. **Real regression, provisional;** needs the three-run read.

**Step 3's reach.** Five regressions are fixed above. The rest of this list stays red and is **proposed as carried**, each with its failing number unchanged and its test untouched. None has an established cause, and each needs a bisect across the 10-01/10-02 commits or a probe on the settle's First/Last passes, which is the settle-frames family's own work. What was read in step 3:

- `at0537` — the drop-zone engine's `seatedPlace` (`drop-zones.ts`) recovers the strip's top from a seated member's live rect minus its allocated advance, so the tiles carry the strip's scroll by construction. The 149px miss equals the strip offset exactly, so one of those two terms is read without the offset it should carry. Which one is not established.
- `at0632` — the sash drag's release (`deck-canvas.tsx`) takes its own still-crossing marks off in the `pointerup` task, before the commit. A mark seen after the release is therefore the commit's settle re-marking a height term ([still-height-crossing]). The pins should make First equal Last at the release, so that term should be zero, and why it is not is not established.
- `at0430` — the resize episode and the CM6 line anchor are unchanged since 09-28 except for `8295073f6` (rail-width-drag, which added the gesture episode window). The anchor is lost in place, not by a remount.
- `at0347`, `at0497`, `at0559`, `at0594`, `at0652`, `at0566`, `at0605`, `at0626` — as read in step 1, above; step 3 established nothing further.

### Settle-frames reds — proposed carries

These encode user-visible frame promises that [B03] does not let move. Each is a real regression, and each is proposed as a carry for the join to decide, as the brief's open question anticipates.

- `at0622-deck-settle-frames` — line 1680, resize to fit: 2.06–2.18 frames vs 2. **Real regression, proposed carry.**
- `at0654-deck-settle-standing-reds` — warm flip first frame 24–26ms vs 16.5–17 (line 200); fold first frame 20ms and 2.94 frames (lines 311 and 319); departure 2.12–2.41 frames vs 2. **Real regression, proposed carry.**
- `at0643-workspace-switch-cadence` — line 603, the first frame after the gesture lands at 74–81ms vs 17, of which 56–63ms is React's render phase before the swap commit. **Real regression, candidate carry.**

### The orphaned defects, re-checked ([B07])

Each of the three tests the 2026-09-18 triage deleted was restored from `26568549d^` and run against this arc's build behind a `tugtool file probe`, at the pinned window.

- **Escape aborting a tab drag (`at0021`) — stood; fixed.** A probe showed Escape reaching a window-capture listener while the drag stayed live (`data-dragging` still set 300ms later), and the release committed the detach (`p1:[B]` plus a new pane holding `A`). `card-drag-coordinator.ts` registered its Escape on `document` in capture phase at drag start. The responder chain's key listeners are document-capture listeners registered at mount, so they run first, and the act-dispatch stage stops the Escape. The listener now sits on `window` in capture phase, as the pane drag's and `block-reorder.ts`'s do. `at0021` is reinstated as the witness, red before and green after, `3eda57584`.
- **A keymap override reaching the menu bar (`at0182`) — does not stand.** The restored test is green, 4/4, against this arc's build. Nothing to fix and nothing to carry; the test stays deleted, since its behaviour is pinned by the keymap's own suites.
- **`set-content-width` landing short of the preset (`at0372`) — stands, smaller; carried.** The pane lands at 1229 against a 1230 band and the 1230 `wide` preset (it was 3px short at the audit). `setContentWidth` and `setCardWidths` (`deck-manager.ts`) take the same clamp from `resolveContentWidthPx`, and differ in that only `setContentWidth` re-solves the rails in the same commit. That re-solve is the candidate for the lost pixel, and it is not established. The restored file is also red on three other cases (the title bar's target button reads the rail's pane, the leaving pane's edge reads 1664 against < 1644, and a quit while bullseyed persists no record at all), which are this file's own drift since its deletion and were not read further. **Proposed carry**, with the test left deleted.

### The full corpus at the arc's tip

One `just app-test-all` at `3651a084f`: 406 of 434 files green, 28 red, 7 skipped. Every red is accounted for, and none was caused by this arc.

- **Proposed carries (14), plus two since fixed:** `at0347`, `at0430`, `at0497`, `at0537`, `at0559`, `at0580`, `at0594`, `at0605`, `at0622`, `at0626`, `at0632`, `at0643`, `at0652`, `at0654`. `at0405` and `at0645` were red in this run and are green alone since `efcba754d`. `at0566` was green in this run; its leg rotates and it stays carried.
- **Contention (6), green alone at the tip:** `at0051`, `at0295`, `at0334`, `at0335-changes-hunk-contention`, `at0410`, `at0426`. `at0426`'s failure names another test's scratch session (`at0427`'s), so a shared-state collision.
- **Red alone, outside the census (2), already in the arc's baseline:** `at0191` (`turns-end-to-end`, line 246, oldest turn 5 against 1) and `at0493` (`atom-mark-raster`, line 444, the diamond mark's pulse reads 0 samples).
- **Red alone, outside the census, red on the base too (4):** each was run with the arc's whole `tugdeck` and harness diff reverted behind a `tugtool file probe`, and each stayed red. The census missed them because its list came from one run's fail list, and their last greens on record are on other trees.
  - `at0019-pane-teardown-flush` — line 136, no `card-host-unmount` follows the multi-card pane close (`Infinity`).
  - `at0416-viewer-card-settings` — the Settings card has no `tug-tab-view-tab-viewerCard` tab to press.
  - `at0425-arc-conflicted-join` — line 352, a live turn does not hold the discard 1200ms after the send. It passed once in a batch with the arc reverted and failed twice alone in the same probe, so it is intermittent, and red more often than not.
  - `at0621-intra-workspace-slide` — line 454, after a cut-short arrival one frame still wears an inline opacity.

These six reds (the two baseline reds plus the four found red on the base) are **proposed as carries** alongside the fifteen above. None has been read past its failing line.

### Settled after the corpus run

- `at0405-changes-arc-lane` — line 575, the arc row's brief subject never carries the draft; the lane reads "from the branch description — no draft was written". The test writes the draft to `~/Library/Application Support/Tug/instances/<id>/changes.db`, but every launch in the file hands the app the fixture's own `TUG_DATA_DIR`, and since `62484a435` the harness builds the instance's `TUG_CHANGES_DB` under that data dir. The draft went into a ledger the app never reads. **Bad test** — the path derives from the fixture's data root. Green alone, `efcba754d`.
- `at0645-overview-one-live-mark` — line 220, waits for 240 citations after 240 posts. `f31ca5443` cut `OVERVIEW_MAX_ROWS` from 500 to 150, so the store trims the column and 240 chips can never mount. **Bad test** — the fill is 120, well over a screen and under the ceiling, and every assertion about the election is unchanged (120 members, 119 understudies, one breathing chip that follows the scroll). Green alone, `efcba754d`.
- `at0580-workspaces-move` — line 269, the moved card's transcript never reads the saved `scrollTop` 1246. A probe shows the move is not what loses it: the home card already reads 1310 at the same 806px width before any move, and the away card arrives at exactly 1310. The 64px shift lands within 2ms of the test's write, with `scrollHeight` unchanged. Trapping every script path (the `scrollTop` setter on `Element.prototype`, `scroll`, `scrollTo`, `scrollBy`, `scrollIntoView`, `scrollIntoViewIfNeeded`, `focus`) catches only the test's own write, so the shift is native layout, not the deck's code. The test is unchanged since `b113e5f04` and was green at `3bb2c7bfc` (10-01). **Real regression, proposed carry**: the reader's place moves 64px after a scroll lands, somewhere in `3bb2c7bfc..68fcd01c4`, with `85f697274`'s commit-timing change the first candidate.
