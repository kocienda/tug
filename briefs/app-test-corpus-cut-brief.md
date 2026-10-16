<!-- brief-skeleton v1 -->

# The app-test corpus cut: a recorded baseline, and a corpus that guards what Tug is for

**Purpose:** The app-test corpus takes hours to run whole, carries reds nobody owns, spends minutes per file building transcripts so a card has something to move, tests generic browser controls, and repeats itself. Every such file is a tax on development, and the attempt to migrate all of it onto bodies at once stalled the every-card-a-body arc for hours. This brief records the first whole-corpus baseline on main, keeps every finding in it that points at a real product bug, and decides how the corpus is cut down, slice by slice, on main.

---

## Purpose {#purpose}

The user, 2026-10-16:

- "slow tests removed. extend out tests so that none take >20s (I expect a hard 10s limit was too strict)."
- "evaluate tests to remove redundant tests that do basically the same work as other tests."
- "remove obsolete tests that have been overtaken by changes in the way the app works."
- "remove all red tests. there should be no lingering failures in the app-test suite."
- "I think this test suite over-indexes on browser-centric input controls. THIS IS NOT AN ESSENTIAL ASPECT OF TUG." and "Every one of these non-essential app-tests is a TAX on our development efforts."
- "This thing where the test writes in 25 freaking passes of text into a transcript just to move a card must be banished from the app-test suite. It's ridiculous to wait a minute or more for a single test to run."
- Of the body-grounding chunk: "I never ever ever ever again want to run these tests as they are now. They are redundant and take far too long."
- "I want to retain the findings which point to actual bugs."

Two infrastructure complaints rode alongside: the user cannot reliably see a long run's progress in the transcript, and the results ledger looked too thin to answer what is slow or red.

Context: the every-card-a-body arc joined at its step 9 (`6ad15611d`). Its steps 10 and 11 flipped the whole corpus onto bodies at once with a 10 s budget, 324 of 486 files went red together, and that work was retracted to `quarry/every-card-a-body-corpus` with the uncommitted remainder saved as patches in `.tug/arcs/every-card-a-body/`.

---

## Evidence {#evidence}

**[F01] The baseline: 500 files run on main at `6ad15611d`, bodies off, recorded.** Run 2026-10-16 in 21 chunks of 25 through `just app-test`, each recorded in `apptest_results.db` under the selection `baseline` (runs 7204 onward). By each file's latest baseline result: **474 pass, 17 fail, 2 wedged, 7 skipped** (real-claude only). The run was stopped during the body-grounding rows at the user's word; rows 5 onward of chunk 21 and all of chunk 22 (`row-07` through `row-33`) have no baseline row, and their latest results are the arcs' that wrote them. **(verified, run and recorded)**

**[F02] 74 files take more than 20 s; a whole run is about two hours.** Of the 500, 60 passing and 12 failing files ran over 20 s, and both wedges hit their 120 s cap. The worst, in seconds: `at0736-height-crossing-bench` 198, `at0330-transcript-eviction` 144, `body-grounding/record-reading` 140, `body-grounding/row-06-menus` 144, `at0697-settle-activation` 131, `at0734-parked-content-bench` 131, `at0510-arc-ownership-two-instances` 127, `at0727-population-ceiling-reading` 121 (wedged), `at0580-workspaces-move` 120 (wedged), `at0505-arc-stage-kill` 108, `at0735-standing-taxes-reading` 106, `at0725-streaming-settle-reading` 103, `at0335-scroll-displacement` 93, `row-04-slide` 87, `at0683-arc-row-join` 85, `at0733-set-up-one-layout` 78, `at0698-settle-drop-mid-flight` 77. The list is `SELECT … WHERE selection='baseline' AND secs>20` against the ledger. **(verified, recorded)**

**[F03] Three shapes account for most of the time.** (a) **Readings and benches** from the headroom and per-card programs (`at0725`, `at0727`, `at0733`–`at0736`, `record-reading`, `overview-cost-reading`, the `zz-probe-*` files): instruments that print a number for a brief, not guards of behaviour. (b) **Transcript-seeding motion files**: the per-gesture settle family `at0696`–`at0708` (31–131 s each) and `at0724`, which seed long "slice" and "whale" transcripts before moving a card, and the transcript files built the same way (`at0330`, `at0333`, `at0335`, `at0336`, `at0387-error-block-follow-bottom`, `at0605-still-crossing-deliveries`, the find walks `at0494`, `at0603`, `at0604`, `at0605-find-adversarial`). (c) **The body-grounding rows**, 18–144 s each, which drive the real app through many legs per file. **(verified from the recorded times; the classification is a reading of file names and diagnostics, to be confirmed per file)**

**[F04] Reds that point at a product defect.** Each failed on main in the baseline with an assertion about what the user sees, not about timing:

- `at0412-text-card-asset-strip` — an image dropped on an unsaved Text card's buffer is not written to the draft's assets: the strip's path is `""` where `…/draft-docs/A/assets/photo.png` is expected. Red since `4cba6d19f` in every recorded run.
- `at0476-arc-interruptions` — after `arc run` resumes a stopped arc, an `arc-stop` follows the resume in the log (line 371: expected no stop after the resume, received one).
- `at0522-empty-session-close` — an unattached Session card's X does not close its pane within 16 s (case A of four).
- `at0544-resize-sidebars-to-fit` — View › Resize Sidebars to Fit moves the right rail's sash 8.8 px where more than 12 is expected: the verb barely fits the rail.
- `at0554-session-fold-focus` — in a folded Session card, ⌥⇥ then Tab never lands the keyboard on the status bar's cells (32 s timeout). No recorded run before today.
- `at0648-dictation-finish` — ⌘D toggling the focused composer's mic fails its first assertion (the words kept after the chord, or the mic returning to idle), 3 s.
- `at0714-zoom-margin-cap-phase` — under View › Zoom the margin caps fall 3.29 px off the root's 24 px grid where at most 1 is allowed.
- `body-grounding/kind-documents` — on a file-view body, the title bar's settings button does not stand still and on top.
- `body-grounding/row-05-chords` and `row-06-menus` (bodies on) — a chord does not act in the page holding the keyboard; an Overview body does not perform every File, Edit, View, Go and Window item as first responder. Seen red in the stopped chunk; not in the ledger. These touch the user's daily deck, which runs with bodies on.

**(verified: each failure message read from the run's report; the causes are not yet read, and any one may yet prove a test defect rather than a product one)**

**[F05] Reds that are motion-bar readings on seeded transcripts.** `at0697`, `at0702`, `at0703`, `at0704`, `at0705`, `at0706`, `at0708` and `at0724` failed legs of the settle bar (one-frame gaps, land frames, survivor anchoring, "the join shrank both following cards — []"). `at0702` has been red for ten recorded runs back to `f6d4c8558`; the rest went red between `4cba6d19f` and today. Whether any marks a real regression in motion on the user's deck is not known from these files, and the `deck motion settle` verb on the real app is the instrument that answers it. `body-grounding/chrome-under-bodies` timed out waiting for its own Text card fixture to fill (a setup failure, not an assertion). **(verified, run)**

**[F06] Files that test generic browser-control behaviour.** By subject, files such as `at0109-focus-ring`, `at0112-button-focus`, `at0121-list-view-container-focus`, `at0127-list-view-cursor`, `at0137-textarea-cut-paste`, `at0400-tab-release`, `at0402-caret-owns-arrows`, `at0345-editor-ring-mode-division` guard how a button, list, textarea or caret behaves under focus and keys, not what Tug does. **(read from names and diagnostics; the full list is the reading [B06] decides)**

**[F07] A triage of every file's subject already exists.** `briefs/app-test-corpus-triage.md` on `quarry/every-card-a-body-corpus` names, for each of 483 files, its subject in one line, what it reaches, and a bin (`covered` 6, `obsolete` 32, `shell` 160, `kept` 285), read by eight readers against the grounding rows. It was written to decide what moves onto bodies, not what is worth keeping, so its bins are a starting point and not a verdict. **(verified, read)**

**[F08] The ledger records every recipe run; it keeps 500 runs per checkout.** `tests/app-test/scripts/app-test.sh` pipes every run to `tugtool apptest record`. Before the baseline, 198 corpus files had no row at all: the corpus had never been run whole inside the retained window, and the bodies arc's 403 runs pushed older ones out. **(verified, read and queried)**

**[F09] A run's live progress is lost three ways.** Piping a run through `grep` or `sed` buffers or hides the progress line until the run ends; a run past the Bash tool's 10-minute foreground limit is moved to the background, where its block shows nothing; and the report's `Diagnostics:` section, thousands of lines in a busy chunk, truncates the block's result so the verdict and `Failures:` are cut off. The user also saw the Session card's live block flash and empty mid-run, cause unknown. **(the first three verified in this session; the card's flash observed by the user, not diagnosed)**

---

## Decisions {#decisions}

**[B01] The corpus guards what Tug is for, and nothing else.** A file stays only if its subject is behaviour a Tug user relies on — sessions, transcripts, the composer as a prompt, cards, arrangement and motion, workspaces, arcs, changes and commits, the host's menus and keys, bodies. Generic input-control behaviour, a reading for a brief, and a guarantee another file already makes are not reasons to keep a file. Every removal names its reason in the commit that removes it.

**[B02] No file takes more than 20 s.** The runner's per-file budget is 20 s, and a file past it is reported red (`OVERTIME`). A file over the line is split along its own `test(` blocks, made cheaper, or deleted; it is never carried. The every-card-a-body arc's 10 s is retired as too strict.

**[B03] Readings leave the corpus.** Benches and readings ([F03] a) move to a directory the sweep and the selector never run (`tests/app-test/readings/`), runnable only by name, with `@covers` kept so a reading can still be found. A reading is an instrument, and its cost belongs to the person who asks for the number.

**[B04] No test seeds a transcript to move a card.** The per-gesture settle family and the files built the same way ([F03] b) are deleted. Motion on the real app is read by `tugtool deck motion settle` and the grounding rows. Where a guarantee in a deleted file has no other guard, it comes back as one file on a bare card inside the budget, written against the guarantee, not the old fixture.

**[B05] A red ends as fixed or deleted, and a red that points at a product bug is not deleted until its bug has a home.** Each of [F04]'s reds is run alone once to tell a defect from a flake. A defect is fixed, with the test kept as its guard; if the fix is not taken now, the finding is written into a brief or an issue in the same commit that deletes the test, so the bug outlives the file. Rows 5 and 6 come first, because they touch the user's daily deck. [F05]'s motion reds go with [B04], after one reading of the same gestures on the real app through the settle verb, so a real motion regression is not lost with its test.

**[B06] Redundant, obsolete and browser-control files are cut by a reading the user approves.** Starting from the triage on the quarry branch ([F07]), the fast green files are read by subject and grouped by guarantee; one file per guarantee is kept, obsolete premises are deleted, and generic control files go ([F06]). The user reads each list before anything is removed.

**[B07] The work lands on main in slices, each one a commit the user lands.** A slice is a list of files with a reason per file, the edits or deletions, and only the cheap checks (`bunx tsc --noEmit` in `tests/app-test`, `just app-test-covers-check`); a slice that changes a file's behaviour runs that file alone as its verdict. No arc, no worktree, no whole-corpus run between slices. The order: readings out ([B03]); transcript-seeding motion files out ([B04]); the product reds ([B05]); the rest over 20 s ([B02]); redundant, obsolete and control files ([B06]); the runner ([B08]); then the bodies migration ([B09]).

**[B08] The runner shows progress and keeps the record.** Multi-file runs print the per-file progress lines and the `Failures:` section and leave `Diagnostics:` to `TUG_APPTEST_JSON` or a one-file run, so a block's result is never truncated before its verdict. No run is ever piped through a filter. A run expected to pass ten minutes is split into chunks that each fit, and the chunk count is said in prose before each one. The full-corpus recipe always records under a named selection, so a baseline can be found again.

**[B09] The bodies migration follows the cut, in batches.** What remains after [B01]–[B06] moves onto bodies in batches of ten to fifteen files grouped by card kind, each batch opting in with the launch's `bodies` option and run alone as its verdict, fixes landing in the same commit. The harness default flips to bodies in one line once no file is left un-opted. The quarry branch and patches ([F07]) are mined, never merged.

**[B10] The baseline is the reference.** Every slice cites a file's baseline result (selection `baseline`) when it removes or changes it, and the record's before is that run, not memory.

---

## Open Questions {#open-questions}

- **What makes the Session card's live Bash block flash and empty mid-run?** [F09]; the user saw it twice during the baseline. A defect in the card, to be read separately from this cut.
- **Which grounding rows survive [B02]?** They are the per-card program's bar, and most run 18–144 s. Each is split by leg or cut to the legs that guard a behaviour no other row does; the program brief's bar is amended to match.

---

## Non-goals {#non-goals}

- **Migrating the corpus onto bodies before it is cut.** Tried in every-card-a-body steps 10–11 and retracted; moving files that should be deleted is waste.
- **A 10 s budget.** Too strict, by the user's ruling.
- **Keeping a file because it was written.** No grandfathering; the reason to keep a file is its subject.
- **Deleting a test to make a bug disappear.** [B05].
- **Running the whole corpus again as part of this work.** Slices are judged by the files they name.

---

## Exit {#exit}

**Slices on main, landed by the user, in [B07]'s order.** The first slice moves the readings out; the second deletes the transcript-seeding motion files after one settle-verb reading of the same gestures on the real app; the third takes the product reds, rows 5 and 6 first. Each later slice brings its list to the user before it removes anything.
