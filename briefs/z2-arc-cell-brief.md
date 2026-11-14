# The Z2 fourth cell is ARC, full-time

**Purpose:** The fourth cell of the Session card's Z2 status bar is labelled `TASKS` whenever no arc is bound, and nobody uses it for that. It should read `ARC` always, and the `/tasks` command that opens its checklist should go.

---

## Purpose {#purpose}

The user's report: "TASKS is a misnomer. We never use it for that. We should change it to ARC full-time." And of the slash command that opens the checklist placard: "Remove /tasks. It does nothing."

The cell already has two faces. With no arc bound it reads `TASKS` and shows the [D100] checklist's `done/total`; while the session drives an arc it reads `ARC` and shows the arc's step fraction or stage word. The first face is the one that is never looked at, and it is the one the cell wears most of the time.

---

## Evidence {#evidence}

**[F01] The label is a two-way swap on whether an arc is bound.** `session-card-telemetry-renderers.tsx:1882` reads `label={arcFact === null ? "TASKS" : "ARC"}`, and the same test picks the placard (`"tasks"` or `"arc"`), the dimmed-empty state (`valueEmpty={arcFact === null && !hasTasks}`) and which of two keyed fragments renders the value. `arcFact` comes from `useArcForSession(snap.tugSessionId)`. **(verified)**

**[F02] The arc reading widens the cell through a row-level switch.** The row carries `data-arc={arcFact !== null ? "true" : undefined}` (`session-card-telemetry-renderers.tsx:1742`), and five rules in `session-telemetry-cell.css` (lines 252–260, 381, 388) key on `.session-telemetry-status-row[data-arc="true"]` to widen the fourth cell for the arc's word and take the difference back from `JOBS`. The widest arc word is `ARC_CELL_WIDEST_WORD = "Re-auditing"` (`arc-track-model.ts:382`); the tasks face reserves `WORK_CELL_WIDEST_WORD = "None"` and `00/00`. **(verified)**

**[F03] The cell's key is `tasks` and the Arc placard borrows it.** The cell is `priority="tasks"`, which becomes `data-priority="tasks"`; the width table and the placard anchor query are both keyed on that attribute. `PLACARD_ANCHOR_PRIORITY` maps `arc: "tasks"` so the Arc placard anchors under a cell named for something else. `data-priority="tasks"` / `priority="tasks"` appears at 22 sites across `tugdeck/src` and `tests/app-test`. **(verified)**

**[F04] `/tasks` is a Tug-local command whose only act is opening the Tasks placard.** It is declared in `tugdeck/src/lib/slash-commands.ts:116`, dispatched at `session-card.tsx:4345` to `statusRowRef.current?.openTasks()`, which is `showPlacard("tasks")` (`session-card-telemetry-renderers.tsx:1179`). The comment at `slash-supported.ts:114` records that `/tasks` and `/bashes` "graduated" out of the unsupported list to become local commands. **(verified)**

**[F05] The Tasks placard and the bar reading have their own machinery.** `TasksPopoverContent` (`session-card-telemetry-popovers.tsx:1609`) is rendered once, at `session-card-telemetry-renderers.tsx:1634`. The bar reading uses `formatTaskFraction`, `tasksCellPose` and `tasksRecentlyDone` from `select-work.ts`, plus `composeTaskSummary`, a linger window (`WORK_LINGER_MS`) and a bounded timeout shared with `JOBS`. `composeTaskSummary` is also used by `todo-list-block.tsx`, so it has a caller that survives. **(verified)**

**[F06] The checklist has surfaces that do not depend on the cell.** The inline task marker in the transcript (`task-inline-tool-block.tsx`, registered in `session-assistant-renderer-registrations.ts:112` as "the second surface") and the Arc placard, which takes a `tasks` prop and shows the task list when the arc drives no plan and so has no ledger (`ArcPopoverContent`, `session-card-telemetry-popovers.tsx`). **(verified)**

**[F07] [D100] is the decision this reverses.** `tuglaws/design-decisions.md:345` opens: "The active task list surfaces as a `TASKS` cell on the [D97] `Z2` status bar", and goes on to specify the `N/M` label, the popover, `/tasks`, the dimmed `None` and the idle demotion. The Z2 diagram (line 307), the zone table (line 333), [D102] ("mirroring the `TASKS` grammar", line 351), `tuglaws/slash-commands.md:213–214` and `tuglaws/session-card-unsupported-slash-commands.md:66–67` all describe the same arrangement. **(verified)**

**[F08] About seventeen test files name the cell or the command.** App-tests: `at0140`, `at0192`, `at0473`, `at0475`, `at0484`, `at0504`, `at0525`, `at0543`, `at0588`, `at0619`, `at0627`, `body-grounding/row-13-arc-tracking`, `site-clips/sc-status-row`. Unit: `select-work.test.ts`, `slash-supported.test.ts`, `session-assistant-renderer-dispatch.test.ts` (a "[D100] two-surface" canary at line 196), `task-inline-tool-block.test.ts`. Which of them assert the `done/total` face rather than the arc reading was not read out file by file. **(listed by grep; the split is not verified)**

**[F09] Upstream `/tasks` is a terminal-only surface.** That is the inference from [F04]'s "graduated" comment: before Tug gave it a local meaning, the command sat in the list of commands Tug refuses with an explanatory chip. Reading `slash-supported.ts` and `tuglaws/session-card-unsupported-slash-commands.md` would confirm what the refused form looked like. **(inferred)**

---

## Decisions {#decisions}

**[B01] The fourth cell's label is `ARC`, always.** The swap in [F01] is removed. The row reads `STATE · TIME · CONTEXT · ARC · JOBS` whether or not an arc is bound. Singular, not `ARCS`: the cell reads the one arc this session drives.

**[B02] With an arc bound, nothing about the reading changes.** The dot, the fraction or stage word, the dot; the stopped, wheel-driven, hand-run and re-audit poses; the accessible label; the Arc placard and its verb row. This work adds a quiet state and removes a face. It does not redesign the arc reading.

**[B03] With no arc running in the session, the value is `None`.** Dimmed, the way `JOBS` reads when it has nothing: the cell keeps its box, and the placard it opens says `None`. No new behaviour is added to the empty click.

**[B04] The arc widths are the only widths.** The row's `data-arc` switch ([F02]) is removed and its five rules fold into the base width table, so the cell is the same box in both states and nothing in the row moves when an arc is bound or released. The `None` reading must sit inside the box the widest arc word already reserves.

**[B05] `/tasks` is removed.** The command, its dispatch entry, `openTasks` on the row's handle, the `"tasks"` placard kind, its title and `TasksPopoverContent` all go ([F04], [F05]). The user's reason is that the command does nothing anyone wants. After removal, typed `/tasks` is handled the way it was before it graduated: it returns to the unsupported set and is refused with that set's chip, so it is never sent to the model as text ([F09]).

**[B06] The `done/total` bar reading goes with it.** `formatTaskFraction`, `tasksCellPose`, `tasksRecentlyDone` and the tasks half of the linger timeout are removed where the cell was their only caller. Anything another surface still calls stays (`composeTaskSummary` does, [F05]). The hand-run arc's idle demotion, which the code describes as "the TASKS idle demotion", is arc behaviour and stays, described in its own terms.

**[B07] The checklist's other surfaces stay.** The inline task marker in the transcript, and the task list inside the Arc placard for an arc that drives no plan ([F06]). This change is about the status bar and the command, and the user named nothing else.

**[B08] The cell's key becomes `arc`.** `data-priority="tasks"` is renamed to `arc` at all 22 sites ([F03]), and the `arc: "tasks"` entry in `PLACARD_ANCHOR_PRIORITY` is deleted, since the Arc placard now anchors under a cell of its own name. A key that says `tasks` on a cell that reads `ARC` is the misnomer moved one layer down. There are no installs to keep compatible.

**[B09] [D100] is amended in the open.** The decision shrinks to what survives: the task list's surface is the inline marker, plus the Arc placard for a plan-less arc; the status-bar cell, its popover and `/tasks` are recorded as withdrawn, with the reason, in a History note like the one the decision already carries. The Z2 diagram, the zone table, [D102]'s "mirroring the `TASKS` grammar", and the two slash-command documents ([F07]) are edited in the same piece of work.

**[B10] Tests follow the guarantee, not the label.** A test asserting the arc reading gets its key and label updated and keeps its assertion. A test asserting the `done/total` face, the Tasks placard or `/tasks` asserts something being removed and is deleted. The [D100] canary in `session-assistant-renderer-dispatch.test.ts` is restated for the amended decision: task create/update calls stay hidden from the transcript's per-call rendering, and the inline marker is the surface. New assertions cover [B01], [B03] and [B04]: the label with no arc, the `None` value, and an unchanged cell box across bind and release.

---

## Non-goals {#non-goals}

- **`ARCS`, plural, or a count of the project's arcs.** Briefly on the table through a slip of the keyboard. The cell reads this session's one arc.
- **A door on the empty click.** Revealing the Arcs sidebar card from an empty ARC cell was considered. It would be new behaviour, and the user chose `None`.
- **Keeping `/tasks` as a command-only way to the checklist.** Considered, since it costs nothing to keep. Rejected by the user: it does nothing.
- **Removing the inline task marker or the task tools' handling.** Out of scope; see [B07].
- **Any change to `JOBS`, or to the other three cells.** `JOBS` gives up no more width than it already does while an arc is bound.

---

## Exit {#exit}

**An arc.** The shape, in the order that keeps each step whole:

- The cell: fixed `ARC` label, the `None` state and its placard, the arc branch as the only value branch, and the `data-arc` width rules folded into the base table.
- The removals: `/tasks` from the command table and its dispatch, `openTasks`, the Tasks placard kind and component, and the bar reading's helpers in `select-work.ts` with their unit tests; `/tasks` returned to the unsupported set.
- The rename: `data-priority="tasks"` to `arc` across CSS, the row and the app-tests, and the anchor indirection deleted.
- The documents: [D100] amended with its History note, and the diagram, zone table, [D102] and the two slash-command documents brought into line.
- The tests: the files in [F08] sorted per [B10], with the new assertions added beside the cell change.
