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
