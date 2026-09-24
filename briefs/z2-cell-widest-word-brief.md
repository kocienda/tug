# Z2 cells are sized to their widest word, and the ARC cell says `Executing`

**Purpose:** The Z2 ARC cell reads `Implementing` while a planned arc walks its steps, and the word does not fit the cell's box. The cell widens, its neighbours shift, and the row moves under the reader's eye. The constraint that every Z2 cell is sized from the start to its largest possible reading was lost, and this brief puts it back.

---

## Purpose {#purpose}

The user's report, with two screenshots of the same session card:

> Somehow, we lost the constraint on Z2 items being sized to the *largest item* they need to show. This *Implementing* text for ARC is simply too big. We need to find a shorter word and size the item from the start to accommodate that term. The goal is that the *labels never need to grow or resize* when any of the Z2 items changes state.

In the first screenshot the ARC cell reads `Implementing` and is visibly wider than STATE. In the second the same cell reads `2/4` and the row sits at its designed widths. The two rows have different cell boundaries, which is exactly the thing the Z2 row promises never to do.

---

## Evidence {#evidence}

**[F01] The ARC cell's width was measured against a word that no longer exists.** The comment over the `data-arc` width rules in `tugdeck/src/components/tugways/tug-status-cell.css` says the cell's widest face is `Implement`, measured at 111px between two 12px dots, and that 17ch holds it at 113px. The word list it names is `Brief`, `Devise`, `Review`, `Implement`, `Join`. **(verified, read out of the file)**

**[F02] The vocabulary grew past the measurement in `f139c1aed`.** That commit moved the ARC cell onto the lifecycle line's shared reading table, `ARC_PHASE_READINGS` in `tugdeck/src/components/tugways/tug-arc-track.tsx`, whose words are verbs in progress: `Briefed`, `Devising`, `Reviewing` / `Awaiting review`, `Implementing`, `Auditing` / `Awaiting audit`, `Finished`. The cell's `arcCellWord` adds `Stopped` and `Cut`, and the join register adds `Ready`. Nothing in that commit re-measured the cell. `Implementing` is twelve letters against the nine the box was sized for, and `Awaiting review` is fifteen. **(verified, from the commit and the tables)**

**[F03] An oversized reading widens the cell rather than clipping.** The cell's budget is `min-width` on two stretched rows, by design, so that a reading wider than its budget takes the label rule with it instead of spilling out from under it. That design keeps the label centred over the value, and it is also why the overflow is silent: the cell grows, the row's flex margins absorb the growth, and nothing reports it. The at0484 header describes this behaviour for JOBS's `None`. **(verified, `tug-status-cell.css` and the at0484 docblock)**

**[F04] The guard did not cover it.** `tests/app-test/at0484-arc-z2-instrument.test.ts` asserts the five rendered cells fit the row's content box at one card size, with a fraction in the ARC cell. No test walks the cell through every word it can say and asserts the box does not move. The Z2 tuning block in `session-card.css` says outright that no test pins the widths because "the row is looked at all day, and a regression in it is obvious". It was obvious and it shipped anyway. **(verified)**

**[F05] STATE and JOBS are sized correctly today, by hand.** STATE's 18ch was measured against `Disconnected`, its widest label in `SESSION_PHASE_LABELS`; JOBS's widest word is `None`. Both are safe now, but each width is a number in a CSS file that knows nothing about the table it was measured from, so either can go the same way ARC did the next time a word is added. **(verified for the widths; the fragility is inference)**

**[F06] The word `Implementing` is pinned in six places.** The reading table and the participle table in `tug-arc-track.tsx`, the stage purpose table in the same file, the faces tables in `tuglaws/arc-lifecycle.md`, the amended text of [D168] in `tuglaws/design-decisions.md`, and the app-tests `at0407-arcs-card` and `at0473-arc-cockpit` plus the fixture `session-task-run-fold.jsonl`. The unit test `tug-arc-track.test.ts` pins it a further ten times. **(verified, by grep)**

---

## Decisions {#decisions}

**[B01] Every Z2 cell is sized to its widest possible reading, in its widest face, and the reading set is closed.** No live value may ever change a cell's rendered box. This is the constraint that was lost, and it is restated here as a rule rather than a tuning note so it can be cited and enforced. It would only be revisited if the Z2 row stopped being a fixed instrument strip, which nothing proposes.

**[B02] The widest word is declared beside the table that produces it, not measured into a CSS number by hand.** Each word-bearing cell names its widest reading in the same TypeScript file as its word table, and the cell's box is established from that declaration rather than from a `ch` count tuned in a stylesheet. The cheapest construction is a hidden sizing element in the value wrap that renders the widest word at the cell's face, so the box is set at mount and the visible reading swaps inside it. A `ch` number in CSS cannot know when its table grows; a declaration next to the table is one edit away from the word that outgrows it. The `ch` budgets stay as the floor the `@container` rungs are measured against.

**[B03] The implement phase reads `Executing`, everywhere the phase has a word.** `Implementing` is too long for the cell and the alternatives were weighed: `Building` names the wrong thing for a hand-worked task list, `Enacting` sounds like legislation, and `Performing` at ten letters would become the new widest word and reads like a stage act. `Executing` is nine letters, the same as `Reviewing`, carries the sense of running a plan that already exists, and inflects cleanly: `Executing the plan` on the line, `Executed` and `Not yet executed` in the track hovers, `Executing · 3 of 6 steps closed` on the active cell. One word on every face keeps the cell on the shared reading table, which [D168] requires, so no third vocabulary is introduced for the implement phase.

**[B04] The two rest forms that are clauses get a cell-only short form.** `Awaiting review` and `Awaiting audit` are right on the line and too long for the cell. The cell reads `Review` and `Audit` at rest for those two phases. These are the only cell-specific overrides beyond the existing `Stopped`, `Cut` and `Ready`, and the cell's tooltip still carries the line's full clause, so nothing is lost, only shortened.

**[B05] The phase key stays `implement`.** The enum, the skill names, the git stage and the arc verbs are all called implement. The word a person reads changes; the identifier the code uses does not. The tables that map key to word are where the change lands and nowhere else.

**[B06] Two tests enforce [B01], one at each level.** A unit test iterates every reading a cell can produce, including `Stopped`, `Cut`, `Ready`, the resting forms and every fraction shape up to `99/99`, and asserts none is wider than the declared widest word by character count. The at0484 app-test then walks a bound session through every phase the cell can show and asserts the row's five rendered boxes are identical at each. The second is the assertion that would have caught [F02].

**[B07] The widest-word doctrine and the new phase word are written into the laws.** The faces tables in `tuglaws/arc-lifecycle.md` change `Implementing` to `Executing` and gain the cell's two short rest forms. [D168] is amended to carry [B01] and [B03]. The width comments in `tug-status-cell.css` are rewritten to say what the widths are measured against now, since the current comment describes a vocabulary that is gone.

---

## Open Questions {#open-questions}

None that would change what gets written. Whether the sizing element in [B02] is a hidden span or a `min-width` computed from the declaration is an implementation call the walker makes against the cell's existing two-row construction.

---

## Non-goals {#non-goals}

- **A third vocabulary table for the ARC cell.** Considered in the sketch and rejected once `Executing` fit the box. The cell stays on `ARC_PHASE_READINGS` with the short rest forms of [B04] as its only overrides, so a cell and the line beside it cannot disagree about what the arc is doing.
- **Clipping or eliding an oversized reading.** The stretch that lets the label follow the value is right and stays. The fix is that no reading is ever oversized, not that an oversized one is hidden.
- **Retuning the row's `ch` budgets or the `@container` rungs.** `Executing` and `Reviewing` fit the 17ch the box already has. The numbers stay; what changes is that a declaration beside the table now guards them.
- **Renaming the `implement` phase key, the `/tugplug:arc-implement` skill, or the git stage.** See [B05].

---

## Exit {#exit}

An arc. The first steps, in the order they must land:

1. Change the implement word to `Executing` in the three tables in `tug-arc-track.tsx` and add the cell's short rest forms for review and audit; update the unit tests that pin the old words.
2. Declare each word-bearing cell's widest reading beside its table and size the cell's box from it; rewrite the width comments in `tug-status-cell.css`.
3. Add the unit test over every reading and extend at0484 to walk every phase asserting the row's boxes do not move.
4. Amend `tuglaws/arc-lifecycle.md` and [D168], and update the two app-tests and the fixture that pin `Implementing`.
