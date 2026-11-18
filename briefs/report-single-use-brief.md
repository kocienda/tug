# Report bars are single-use

**Purpose:** A report panel can end green with empty cells, a filled cell can go back to empty and fill again, and a finished panel can vanish. A cell fills once, a track belongs to one run, and a finished panel says no more than its rows show.

---

## Purpose {#purpose}

The user, looking at three report panels in the transcript:

- "Incomplete test results: improve test result/progress interface. results can be incomplete."
- "Bars can be re-used or reset (they shouldn't do this)"
- "Completed bars can disappear (they shouldn't)"

Two of the screenshots showed a `PASS` verdict over `3/5 files` and `6/9 files`, with empty cells in the track. The third showed an `arc verify` panel with a nested `app-test` track of 25 cells beneath its running surface.

And, settling what "re-used" means: "I just don't want a filled-in bar to reset to empty and then fill again. Bars are *single-use*."

---

## Evidence {#evidence}

**[F01] A unit's identity is its name, so a repeated file collapses into one cell.** `UnitPlan::index_of` in `tugrust/crates/tugtool/src/report_unit.rs` returns the first position of a name, and `start`, `done` and `amend` all resolve their row through it. The commands behind the two screenshots, read from the sessions' transcripts, were `just app-test` with `row-01-arrival-cold.test.ts` three times followed by two other files, and with `at0817-overlay-exit-frees-the-app.test.ts` four times followed by five others. The panels drew green, empty, empty, green, green over `3/5`, and green, three empty, five green over `6/9`: every copy wrote the first copy's cell, which went running, pass, running, pass, while the other copies' cells stayed pending. This one defect produces all three reported symptoms. **(verified)**

**[F02] The same collision is in the recipe's own results, so its verdict over repeated files is unsound.** `run_one_file` and `collect_file` in `tests/app-test/scripts/app-test.sh` key `$out.row`, `$out.fails`, `$out.out`, `$out.start` and `$out.notes` by the file's name. Copies running at once overwrite one row file, and the pool's FIFO hands `collect_file` the same name once per copy, so the summary reads the last writer's row as many times as there are copies. A red copy followed by a green copy is reported as all green. Repeating a file is how a flake is hunted, which is the case where this matters most. **(verified by reading; not reproduced)**

**[F03] Every report is a whole snapshot, and the last to arrive wins.** Each `report unit` call loads every row from the state directory, changes its own, and posts the whole run. Two items landing together in parallel jobs can post in one order and arrive in the other. `foldReport` in `tugdeck/src/lib/report-store.ts` replaces the entry whole, and nothing on the frame orders it but tugcast's arrival stamp, which the deck does not read. A landed cell can therefore step back to running until the next post. **(read from the code; not observed)**

**[F04] A call has one slot for a run.** The state directory is keyed by session and label (`run_dir`), and `plan` removes it, so a second run under the same label in one call wipes the first run's rows and its report replaces the first panel. The deck holds one `Report` per call.  **(verified by reading)**

**[F05] A nested child's panel is discarded when its parent moves on, and again when the call ends.** `ReportStore.applyReport` folds a report under another label into the parent's `child` slot, and the parent's own next report "replaces the entry whole, child and all". `reportPanelModel` sets `child` to null in the finished state. Under `arc verify`, a surface's 25 green cells vanish when the surface lands and the next surface's child draws in the same place. This was decided in `briefs/report-verdicts-brief.md` [B02], on the argument that the parent's row carries what the child ended with. **(verified by reading)**

**[F06] A finished panel is page memory.** `ReportStore.settled` holds the last report of at most 64 closed calls (`RUN_SETTLED_CAP`) for as long as the page lives. A reload, a relaunch, a session restored from its transcript, or the sixty-fifth run leaves the block with no panel, and it renders its raw output instead. tugcast keeps no record of a report after publishing it. **(verified by reading)**

**[F07] The finished panel overstates.** The verdict is green whenever the run is over, the call did not fail and no row is red, whatever `done` and `total` say, which is how `PASS` came to stand over `3/5`. `resolveFinished` in `tugdeck/src/lib/report-panel-model.ts` turns a unit still running at close into a pass or a fail by the call's exit status, which is a guess about a unit nobody reported on. `finish` posts the run again and carries nothing that says the reporter finished. **(verified)**

**[F08] The in-flight rows under the track reuse their lines by design, and that is not the reuse reported.** `laneSlots` keeps a landed unit on its row until a newly started unit takes it, so the rows hold their height. A row is a label with no fill; the cell on the track is what fills. **(verified; confirmed with the user)**

---

## Decisions {#decisions}

**[B01] Three invariants govern the panel, and each is asserted in the pure model.** A landed cell is final: it never changes status and never leaves. A track belongs to one run: a new run gets a new track and never an old one's. The verdict claims no more than the rows show. Every decision below serves one of the three, and a later change that breaks one is a regression whatever else it improves.

**[B02] A unit's identity is its slot, not its name.** `plan` assigns one slot per planned item in order, repeats included. `start`, `done` and `amend` take `--slot <n>`. Without it, the nth `start` of a name takes the nth planned slot of that name, and a name with no free planned slot is appended, so a hand-written loop that never passes a slot still gets one cell per item. This is what makes a cell single-use ([F01]).

**[B03] The app-test recipe keys a file's results by its position in the run.** The run directory's per-file paths, the pool's retirement message and `collect_file` all use the position, and the recipe passes it as the slot. A file given three times is three results in the summary, the `Failures:` section, `TUG_APPTEST_JSON` and the ledger. This is a correctness fix to the verdict before it is a display fix ([F02]), so it lands first.

**[B04] A repeat is named by its ordinal.** The second and later copies of a name read `<name> #2`, `<name> #3` in the panel's rows, the recipe's progress lines and its result table. The ledger's per-file history keeps the plain file name, so repeats add to one file's history and do not start a new one.

**[B05] `finish` says the run finished, and only a finished, fully landed run with no reds is green.** The `finish` report carries a flag. The verdict is `PASS` when the flag is set, every unit has landed and none is red. A run with reds is red as today. Anything else that ended is `INCOMPLETE`, in the caution tone, with a sentence that counts what reported and what did not, such as "3 of 5 files reported · 2 never reported". A cell that never reported is drawn distinct from a pending one ([F07]).

**[B06] The exit-status guess stays for phase rows only.** A build phase still marked running when its call ends did end with the call, so resolving it by the call's outcome is true. A listed unit still running at close is unreported, and is counted as such under [B05].

**[B07] A call holds a list of runs, in the order each first reported.** Each `plan` mints a run id that rides every report of that run, and the state directory is keyed by it, so a second run under the same label in the same call is a second panel beneath the first and wipes nothing ([F04]). The panels stack; none replaces another.

**[B08] A nested child stays beneath its parent's row after it lands, and this reverses part of `briefs/report-verdicts-brief.md` [B02].** A child run names the parent unit it ran under. When that unit lands, the child folds to its one-line masthead (label, count, tally, time) under the row, and opens on click. A finished panel keeps its children. The earlier decision that the child's rows are not the record is withdrawn: a completed track that disappears is the defect reported ([F05]). The parent's row still carries the child's verdict, as [B03] of that brief decided.

**[B09] tugcast is the one fold, and its snapshots carry a sequence.** tugcast keeps each run's rows per call and merges every incoming report under one rule: a unit moves pending, then running, then landed, and a landed unit only gains fields (a history line, a message). It publishes the merged run with a sequence number it mints, and the deck drops a frame older than the one it holds. An out-of-order post can no longer un-land a cell ([F03]), and the merged run is what [B10] records.

**[B10] A call's settled runs are recorded by tugcast and replayed on load.** At the call's `tool_result`, tugcast writes the merged runs to the instance's session ledger, keyed by the call's id, and a session loaded from its record gets them back, so the block draws the finished panel after a reload or a relaunch. The deck's 64-entry settled map is no longer the only holder and its cap is removed ([F06]). The write is telemetry-grade: a failure is logged and never touches the call.

**[B11] The in-flight rows stay as they are.** They hold the panel's height by reusing lines, they carry no fill, and the user confirmed that they are not what "re-used" meant ([F08]).

**[B12] The checks are fast-layer, with one app-test.** The model and the store get cases for a repeated name, frames out of order, two runs in one call, a child kept after its unit lands, an incomplete finish, and a restore. tugcast's merge gets the monotone cases in Rust. `at0707-bash-live-progress.test.ts` gains the one end-to-end case: a run with a repeated item ends with every cell filled and the right count.

---

## Open Questions {#open-questions}

- **How long recorded runs are kept.** [B10] ties a call's runs to its session, which suggests they live as long as the session's record does. A run past the cell limit carries only its reds and running rows, so a row is small, but nothing here measured the ledger's growth. Reading the session ledger's existing retention will settle it.

---

## Non-goals {#non-goals}

- **Not a change to the in-flight rows.** Considered: a row that shows only running files and goes blank between one and the next. Left alone under [B11].
- **Not a change to the band.** A run past 64 units still draws a density band and still sends only the rows worth drawing.
- **Not a new report rung or reporter.** The ladder, the hook and the runner table are untouched; this is identity, ordering, lifetime and the verdict of what already reports.
- **Not a deck-side merge.** Considered and rejected: making the deck's `foldReport` monotone and leaving tugcast a relay. The deck's memory is what [F06] says is lost, so the merge belongs where the record is kept.
- **Not a migration of old panels.** Calls that closed before this lands have no recorded run and keep rendering their output.

---

## Exit {#exit}

An arc. The order that matters:

1. Slot identity in `report unit` and position-keyed results in the app-test recipe ([B02], [B03], [B04]). The verdict over repeated files is wrong today, so this is first and stands alone.
2. The honest finish ([B05], [B06]): the `finish` flag, the `INCOMPLETE` verdict and the unreported cell, in the reporter, the wire type and the model.
3. Run ids and the list of runs per call, with the child kept under its row ([B07], [B08]). The wire frame, tugproto's decoder and the store change together.
4. tugcast's merge and the sequence ([B09]), which takes over the fold the deck did in step 3.
5. The recorded settled runs and their replay ([B10]), over the merged state step 4 keeps.
6. The app-test case ([B12]) last, since it needs the rebuilt app.
