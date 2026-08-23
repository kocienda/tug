<!-- devise-skeleton v5 -->

## Z2 Status Row Rework — Retire TOKENS, Split WORK into TASKS + JOBS {#z2-mods}

**Purpose:** Rework the Session card's Z2 status row: retire the TOKENS cell (its per-turn figure already lives in Z1B), and split the overloaded WORK cell into TASKS (the numbered checklist) and JOBS (all other background work — running jobs, scheduled rows, the goal). The row becomes STATE · TIME · CONTEXT · TASKS · JOBS, each cell with a focused popup.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-08-23 |

---

### Review Record {#review-record}

**Round 1 — 2026-08-23, opus.** Reviewed `plan:cdb82e8cb2906b12`. Lint: 0 errors, 1 warning (the missing Review Record this paragraph resolves).
Oriented on: a first pass over the whole document, against the Z2 sources it names.
Applied, in descending order of consequence. **Durable record**: the merged WORK cell is not only code — it is global decision **[D107]**, with [D97]'s zone table naming the five-cell lineup and [D100]/[D102] each carrying a "Superseded (cell layout only)" trailer pointing at it. The plan changed none of it, which would have shipped a `tuglaws/` that documents a cell the code no longer has. Asked the user how the record should absorb the reversal; they chose to delete [D107] outright and restore [D100]/[D102]. That is now [P13], a Documentation Plan, and Step 5 (the Integration Checkpoint moved to Step 6). **A redundant feature removed**: [P06] proposed a `session total` row for the CONTEXT popup computed by a new `computeSessionTokensTotal` — but `computeRichContextBreakdown` already emits `messages = window − bootstrap`, which is arithmetically the same figure the retired TOKENS summary telescoped to, and `ContextBreakdownBody` already renders it as the **Messages** legend row (tracking the live in-flight window, so strictly fresher). Asked; the user chose to drop it. [P06] is now a decision *not* to add the row, and the new function, prop, unit test and popup edit are gone with it. **Two implementation holes**: `TugProgressIndicator`'s `phaseLabels` is the width-stabilize ghost set under `labelAlign="center"`, so the WORK cell's `{none:"None", max:"00"}` carried onto a fraction-labelled TASKS cell would let the label shift as digits accrue — now [P15] and Risk R02; and `tug-status-cell.css` keys **four** rule blocks on `[data-priority="work"]` (indicator stretch, glyph inset, value typography, empty dim) which the plan never mentioned re-keying — now Spec S04. **Architecture**: Spec S02 put a `composeTasksSummary` in `lib/` delegating to `components/`, crossing the one-way boundary `telemetry.ts` states in its own source and that today's `select-work.ts` respects via structural count params — now [P14]. **Checkpoints**: every step verified with `vite build`, which strips types without checking them; added `bun run check` (`tsc --noEmit`) where signatures move and `bun run audit:tokens` where color rules change ([L16]). **Smaller**: the `/tasks` and `/bashes` user-visible descriptions in `slash-commands.ts` both name a WORK popover and call the pair aliases, which the split makes false twice over; the State Zone Mapping now uses [L24]'s vocabulary; the app-test tasks name the actual constants and probes in each file (`Z2_TOKENS`/`Z2_WORK`, `WORK_CELL`, `TOKENS_JS`).
Deferred: nothing. Both judgment calls were asked and settled in this round, so the plan carries no `[Q##]`.

---

### Phase Overview {#phase-overview}

#### Context {#context}

The Z2 status row (`SessionTelemetryStatusRow` in `tugdeck/src/components/tugways/cards/session-card-telemetry-renderers.tsx`) currently shows five cells: STATE, TIME, TOKENS, CONTEXT, WORK. Two problems. First, TOKENS — the signed per-turn window delta — is never consulted: the same number renders on every committed turn's Z1B end-state row (`session-card-z1b.tsx`, `perTurnTokens` prop), so the cell duplicates in the status strip what the transcript already shows in place. Second, WORK is a grab bag: it merges the numbered task checklist, background jobs (bash, agents, monitors), scheduled rows (wakeups/loops, crons, remote routines), and the `/goal` into one count whose meaning shifts with its contents.

Historical symmetry worth knowing: WORK was itself created by *merging* older TASKS and JOBS cells ([P02]/[P03] of `roadmap/slash-command-plan.md`). The orphaned `TasksPopoverContent` and `JobsPopoverContent` exports still sit in `session-card-telemetry-popovers.tsx` with no callers. This plan re-splits along a better line than the original: TASKS is the checklist alone; JOBS is everything else including the goal.

#### Strategy {#strategy}

- Bottom-up in three implementation layers, each a buildable commit: selector layer (pure derivations in `code-session-store`), popover layer (rewrite the orphaned popovers into the new shapes), then the status row itself (cell lineup, placards, slash routing, CSS widths and collapse rungs) with the deletions of everything the swap orphans.
- Land the durable record with the code: the merged cell is global decision [D107], and [D97]'s Z2 zone table names the five-cell lineup — a code-only change would leave `tuglaws/design-decisions.md` documenting a cell that no longer exists ([P13]).
- Reuse, never hand-roll: the new popovers compose the same `TugPopupList*` primitives and `JobRow` the WORK popover uses today; the cells stay `TugStatusCell` + `TugProgressIndicator`.
- Keep every management action the WORK popover carries (stop job, cancel cron, stop loop, clear goal, clear finished jobs) — they move to the JOBS popover unchanged.
- Re-measure the cell width budgets and `@container` collapse rungs in the built app, following the measurement doctrine already written in `tugdeck/src/components/tugways/tug-status-cell.css`.
- Update the three app-tests that pin these surfaces; run selection via `just app-test-changed`.

#### Success Criteria (Measurable) {#success-criteria}

- The Z2 row renders exactly five cells, in order STATE · TIME · CONTEXT · TASKS · JOBS; no element with `data-priority="tokens"` or `data-priority="work"` exists in the DOM (app-test assertion, Step 4).
- With a task list of 7 items, 3 completed, the TASKS cell reads `3/7`; with no tasks it reads `None` (unit test on the formatter + app-test, Steps 1 and 4).
- With one running agent, one scheduled cron, and an active goal, the JOBS cell reads `3` with a running pose (unit test on the derivation, Step 1).
- The TASKS popup lists checklist rows with ordinal numbers `1.`–`N.`; the JOBS popup shows Goal / Running / Scheduled / Finished groups with the stop/cancel/stop-loop/clear-goal/Clear actions (bun unit-level assertions where pure, app-test for the scheduled row, Steps 2 and 4).
- `/tasks` opens the TASKS placard; `/bashes` opens the JOBS placard; `/context` still opens CONTEXT, and the two slash entries' user-visible descriptions no longer name a WORK popover (code inspection, Step 3).
- `bun run check` (`tsc --noEmit`) and `bunx vite build` are both green, and `just app-test-changed` reports VERDICT green (Steps 3 and 4).
- `tuglaws/design-decisions.md` documents the shipped row: [D107] is gone, [D100]/[D102] carry no "Superseded" trailer, and [D97]'s Z2 row names STATE · TIME · CONTEXT · TASKS · JOBS (prose assertion, Step 5).

#### Scope {#scope}

1. Selector layer: per-cell derivations replacing the merged WORK grammar in `tugdeck/src/lib/code-session-store/select-work.ts`.
2. Popover layer: rewritten `TasksPopoverContent` and `JobsPopoverContent`; deletion of `TokensPopoverContent` and `WorkPopoverContent`.
3. Status row: cell lineup and order, `PlacardKind`, imperative handle, slash-command routing and the two slash entries' descriptions, `tug-status-cell.css` widths, per-cell rules and collapse rungs.
4. Test updates: unit tests beside the changed modules; app-tests `at0192`, `at0140`, `at0197` (and whatever else `@covers` selects).
5. Durable record: `tuglaws/design-decisions.md` ([D97] zone table, [D100], [D102], [D107]) and `tuglaws/slash-commands.md`.

#### Non-goals (Explicitly out of scope) {#non-goals}

- No change to Z1B per-turn telemetry (duration, cost, tokens, TTFT stay as they are).
- No change to the underlying stores or wire protocol — tasks stay the derived turn-scoped fold, jobs the session-lifetime ledger, the goal its own snapshot field. This is projection-and-presentation only.
- No change to STATE, TIME, or CONTEXT at all — not the cell, not `computeRichContextBreakdown`, not the popup. CONTEXT's existing `messages` segment already carries the session's conversation total ([P06]).
- No change to the `/btw` placard or `SideQuestionBody`.
- No new persistence, no new tugbank defaults.

#### Dependencies / Prerequisites {#dependencies}

- None external. All work is in `tugdeck/` plus `tests/app-test/`. The tugdeck dev server HMRs; final verification is `bunx vite build` (the app loads the prod bundle).

#### Constraints {#constraints}

- Tuglaws, each with what it demands here: **[L02]** the task list, jobs ledger, goal and phase all enter React through `useSyncExternalStore` (the existing `useTaskListState` / `useJobsState` / snapshot reads — no new mechanism); **[L06]** cell collapse, replay dimming and the empty-value dim stay CSS/attribute-driven, never React state; **[L16]** every new or re-keyed CSS rule that sets `color` without a `background-color` carries a `@tug-renders-on` annotation — the four `[data-priority="work"]` blocks being re-keyed already do, and `bun run audit:tokens` enforces it; **[L19]** component authoring guide for the rewritten popups; **[L20]** no new token slots — the cells consume `TugStatusCell` / `TugProgressIndicator` / `TugPopupList*` and reference only their own component-scoped tokens; **[L24]** every piece of state names its zone in the State Zone Mapping below. Cross-check `tuglaws/tuglaws.md`, `tuglaws/pane-model.md`, `tuglaws/component-authoring.md` before the row work and name the laws in the commit messages.
- **`lib/` must not import from `components/`.** `tugdeck/src/lib/code-session-store/telemetry.ts` states the one-way boundary explicitly ("Declared locally here rather than imported from the components layer so the library boundary stays one-way"), and today's `select-work.ts` honors it by taking task counts as a structural `{ completed, total }` parameter rather than importing `TaskCounts`. [P14] holds that line.
- Global design decisions this rework changes: **[D107]** (the merged WORK cell) is retired, **[D100]** / **[D102]** (the standalone TASKS / JOBS cells) are restored as live doctrine, and **[D97]**'s Z2 zone table is rewritten. See [P13].
- Never hand-roll UI that exists as a Tug\* component: the popovers are `TugPopupListFrame`/`TugPopupListGrid`/`TugPopupListItem`/`TugPopupListGroup`/`TugPopupListFooter` compositions; buttons are `TugPushButton`; dots are `TugProgressIndicator`.
- App-tests run selectively (`just app-test-changed`), never the full corpus; the report is read bare, never piped.
- Comments state what the code does — no plan-step numbers, no bug history, no "superseded by" markers; deleted designs are deleted, not flagged.

#### Assumptions {#assumptions}

- The 2–4 week-old cell fixed-width + container-query collapse architecture in `tug-status-cell.css` stays; only budgets and rung values change.
- `WORK_LINGER_MS` (5 minutes) remains the right linger window; it now applies per cell.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

None open. The three design questions raised in discussion — row order, whether any session token accounting survives, and the second cell's name — were settled with the user and are recorded as [P03], [P06], and [P02] respectively.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Width budgets overshoot the slim strip and trip a collapse rung | med | med | Measure in the built app against the strip's content box per the doctrine in `tug-status-cell.css`; verify at the slim (675) preset | TIME cell disappears at slim |
| App-tests beyond the three named ones assert `data-priority="work"`/`"tokens"` selectors | low | med | `just app-test-changed` selects by `@covers`; grep `tests/app-test` for the selectors before Step 4 closes | Red files in the selection run |
| A slash command opens a placard for a cell the container query has collapsed | low | low | Pre-existing behavior, carried forward knowingly: `measureAnchorCenter` reads a `display:none` cell's zeroed rect and `TugPlacard` clamps in-card, so the surface opens left-clamped rather than failing | A `/tasks` on a narrow card opens nothing at all |

**Risk R01: Collapse-rung mismeasurement** {#r01-rung-mismeasure}

- **Risk:** The re-measured budgets/rungs are sized against the card instead of the strip's content box, silently hiding a cell at the slim preset (the exact failure the CSS comment documents from the first diet attempt).
- **Mitigation:** Follow the written procedure: budgets in `ch` against the row font, measured from the widest realistic face rendered in the built app; rungs asked against the ~657px content box at slim; verify visually at 675/800/1230 presets.
- **Residual risk:** A future font or padding change invalidates the measurements — same exposure the current row already carries.

**Risk R02: The width-stabilize ghost set is forgotten** {#r02-ghost-set}

- **Risk:** `TugProgressIndicator`'s `phaseLabels` map is not decoration — under `labelAlign="center"` every entry renders as a hidden ghost in the label's grid cell, and the cell sizes to the widest ghost. The WORK cell ships `{ none: "None", max: "00" }`. Carried over unchanged to a TASKS cell whose label is now a fraction, the ghost set is narrower than the live label: the fraction escapes the reserved box and the label shifts as its digit count changes (`3/7` → `10/17`), which is exactly the jitter the fixed-width row exists to prevent.
- **Mitigation:** [P15] states the ghost set per cell, and Step 3 sets it in the same edit that sets the label.
- **Residual risk:** The ghost set also contributes to the cell's intrinsic width, so a ghost wider than the budget silently fights the CSS — verify the two together during the Step 3 measurement pass.

---

### Design Decisions {#design-decisions}

#### [P01] Retire the TOKENS cell and its popup (DECIDED) {#p01-retire-tokens}

**Decision:** Remove the TOKENS status cell, its placard, and `TokensPopoverContent`. The per-turn signed window delta remains visible on every committed turn's Z1B row.

**Rationale:**
- The user never reads the cell; the identical number (`window(N) − window(N−1)`, an honest negative at `/compact`) renders per turn in Z1B (`session-card-z1b.tsx`, `perTurnTokens`).
- Freeing the slot funds the WORK split without widening the row.

**Implications:**
- The status row stops computing `tokensCellValue` for display; the live `streaming_usage` subscription stays (CONTEXT still reads it).
- `TurnTokensSummary`/`computeTokensSummary` in `telemetry.ts` lose their only consumer; replaced per [P06].
- `formatTokens` (lowercase-suffix formatter) **stays** — `SessionTelemetryWindowUtilization` still uses it. `formatTokensCaps`/`formatTokenCap` stay (CONTEXT cell, Z1B, popovers).

#### [P02] WORK splits into TASKS and JOBS (DECIDED) {#p02-split-work}

**Decision:** Replace the WORK cell with two cells: **TASKS** — the numbered checklist only (the `Task*`-tool fold from `select-task-list.ts`) — and **JOBS** — everything else: running jobs (bash, agent, monitor, unknown), scheduled rows (wakeup, cron, remote), and the `/goal`.

**Rationale:**
- The merged cell's single count folds a checklist fraction, a live-agent count, and standing schedules into one number whose meaning shifts with its contents.
- The checklist / everything-else line is the natural seam: a checklist is turn-scoped plan-following; the rest is session-lifetime background machinery.
- "JOBS" revives the pre-merge vocabulary and matches the internal ledger naming (`select-jobs.ts`, `JobItem`); the goal is a standing condition with an evaluator loop — background work, not a checklist item.

**Implications:**
- The `WorkItem`/`WorkKind`/`WorkGroup`/`WorkAction` unified projection (`selectWorkItems`) loses its purpose; deleted per [P11].
- Aria summaries, poses, counts, and lingers split per cell ([P04], [P05], [P09]).

#### [P03] Row order is STATE · TIME · CONTEXT · TASKS · JOBS (DECIDED) {#p03-row-order}

**Decision:** Measurements sit left (STATE, TIME, CONTEXT), work sits right (TASKS, JOBS), the two work cells adjacent.

**Rationale:**
- The split reads as one story when the two work cells are neighbors.
- CONTEXT moves one slot left of its current position; it remains in the row's center-right region where the user's eye finds it.

**Implications:**
- `TugStatusCell` `focusOrder` offsets remap 0–4 in the new order; still five leaf cycle stops from `SESSION_CYCLE_ORDER_STATUS_BASE`, so the [P10]-revised cycle architecture in `session-card.tsx` is untouched structurally.

#### [P04] TASKS cell shows a done/total fraction (DECIDED) {#p04-tasks-fraction}

**Decision:** The TASKS cell value is `completed/total` (e.g. `3/7`), rendered `None` when the list is empty. Pose keeps today's checklist grammar: `running` while the session is active with open items, idle-demoted to `stopped` ([D100]'s demotion), `completed` (green) only while a finish is recent ([P09]'s linger), else quiet.

**Rationale:**
- The fraction is the one number a plan-following session actually tracks; the current "incomplete count" hides progress.
- Preserving the [D100] idle demotion keeps a half-done checklist from glowing over an idle session.

**Implications:**
- New formatter `formatTaskFraction(counts)` and pose helper `tasksCellPose(...)` in the selector layer (Spec S02).
- The cell keeps the `TugProgressIndicator` dot + label composition the WORK cell uses today (`glyphPosition="both"` flanking dots), with the fraction as the label.

#### [P05] JOBS cell shows the active count with [D102]'s pose grammar (DECIDED) {#p05-jobs-count}

**Decision:** The JOBS cell value is `running + scheduled + activeGoal` (`None` at zero, lingered per [P09]). Pose: any running job → `running` (never idle-demoted); else any failed job → `aborted` (nags red until cleared — not linger-gated); else `completed` while a finish is recent; else quiet.

**Rationale:**
- This is exactly the jobs half of today's merged grammar (`jobsCellPose` in `select-jobs.ts` already implements the running/aborted core); the split lets it apply cleanly without the checklist branch interleaved.
- A scheduled row and an active goal are not *running*: they count but do not pose live, per the existing `indicator-liveness` reasoning in `select-work.ts`.

**Implications:**
- Derivations `jobsCellActiveCount`, `jobsCellPose` (wrapping the existing one with the linger gate), `composeJobsCellSummary` (Spec S02).

#### [P06] No session-total row is added — the CONTEXT popup already shows it (DECIDED) {#p06-session-total}

**Decision:** The TOKENS popup's whole summary block (`turns` / `total` / `avg`) is dropped with the popup. The CONTEXT popup is **not** changed: its existing `messages` segment already renders the session's conversation total.

**Rationale:**
- `computeRichContextBreakdown` in `tugdeck/src/lib/code-session-store/telemetry.ts` computes `messages = window − bootstrap` where `bootstrap` is `sessionInitTokens`. That is arithmetically identical to the old summary's `totalTokens`, which telescopes over `deriveContextWindows`' per-turn deltas to `window(latest) − sessionInit`. `ContextBreakdownBody` already renders it as a legend row labeled **Messages**, with its percent and its `formatTokensCaps` value.
- The existing row is the fresher of the two: `messages` follows the live in-flight window, while the retired summary covered committed turns only.
- `turns` is visible in the transcript; `avg` was never consulted.

**Implications:**
- No `computeSessionTokensTotal`, no new prop on `ContextPopoverContent`, no change to `ContextBreakdownBody`, no new unit test.
- `computeTokensSummary` and the `TurnTokensSummary` interface in `telemetry.ts` lose their only consumer with the TOKENS popup and are deleted along with their `__tests__/telemetry.test.ts` cases ([P11]).

#### [P07] TASKS popup rows are numbered (DECIDED) {#p07-numbered-tasks}

**Decision:** The TASKS popup renders the checklist as ordinal-numbered rows — `1.`–`N.` in source order — each with its status dot ([D100] demotion applied), subject as primary text, description in a `TugTooltip`. Footer: `composeTaskSummary` counts + COPY. **No clear button.**

**Rationale:**
- It is a numbered task list; the ordinals give rows the identity the user asked for.
- The list is transcript-derived — nothing deck-local to clear — which also retires the "Clear Jobs" labeling compromise documented in today's WORK footer.

**Implications:**
- The orphaned `TasksPopoverContent` in `session-card-telemetry-popovers.tsx` is rewritten in place (name reused) with the ordinal column added; `composeTaskCopyText(tasks, false)` keeps the copy shape.

#### [P08] JOBS popup keeps the full management surface (DECIDED) {#p08-jobs-popup}

**Decision:** The JOBS popup renders Goal / Running / Scheduled / Finished groups (each only when non-empty) with every action today's WORK popup carries: stop job, cancel cron, stop wakeup-paced loop, clear goal (idle-gated), and a footer **Clear** button (plain name again — its scope is unambiguous) clearing terminal rows only. `JobRow`, `wakeBadgeText`, `scheduledCancelEnabled`, `formatWakeSchedule`, and the goal row move over unchanged.

**Rationale:**
- The WORK popup minus its Tasks group *is* the JOBS popup; the decomposition falls along the same seam as the cell split.

**Implications:**
- The orphaned `JobsPopoverContent` is rewritten in place (name reused) as this shape — it gains the goal row, scheduled actions (`onStopLoop`), and always-grouped sections; `WorkPopoverContent` is deleted.

#### [P09] Linger applies per cell, same 5-minute window (DECIDED) {#p09-per-cell-linger}

**Decision:** `WORK_LINGER_MS` (300 000 ms) stays and applies independently to each cell: TASKS lingers recently-completed tasks, JOBS lingers recently-finished jobs. Each cell shows its lingered count when its active count is zero; the single bounded-timeout recompute effect in the status row computes the earliest expiry across both cells (no per-second ticker — the work cells stay tick-free).

**Rationale:**
- The linger's purpose (no snap to "None" the instant work finishes) is per-surface; a finished agent should not keep the TASKS cell inflated or vice versa.

**Implications:**
- `countRecentlyDone` and `nextLingerExpiryMs` in `select-work.ts` split into task-only and job-only variants (Spec S02).

#### [P10] Collapse order: TIME, then TASKS, then JOBS; STATE and CONTEXT persist (DECIDED) {#p10-collapse-order}

**Decision:** The `@container session-status` rungs hide TIME first, then TASKS, then JOBS; STATE and CONTEXT are the most-persistent pair. Rung widths are re-measured against the post-split row's intrinsic width per the doctrine in `tug-status-cell.css`.

**Rationale:**
- The existing doctrine keeps the live-signal cell last: "a running job / live goal is live 'something is happening' signal". That argument transfers to JOBS, so TASKS collapses before it.
- The full set must still hold at the slim (675) preset's ~657px strip content box, per the measured-budget doctrine.

**Implications:**
- Three rung rules in `tug-status-cell.css` re-target `data-priority` `time` / `tasks` / `jobs` at freshly measured widths; the doctrine comment block is rewritten for the new lineup (no history of the old one).

#### [P11] Delete what the split orphans (DECIDED) {#p11-deletions}

**Decision:** Deleted outright, not kept or flagged: `TokensPopoverContent`, `WorkPopoverContent`, `selectWorkItems` + `WorkItem`/`WorkKind`/`WorkGroup`/`WorkAction`, the dead hook `tugdeck/src/lib/code-session-store/hooks/use-work-state.ts` (zero callers today), the merged-cell helpers `workActiveCount`, `workCellPose`, `workCellLabel`, `workDisplayCount`, `composeWorkSummary` once the row stops reading them, and `computeTokensSummary` + `TurnTokensSummary` in `telemetry.ts` ([P06]). Their unit tests go with them; the new derivations get their own.

**Rationale:**
- Unread registry → delete (project doctrine). `use-work-state.ts` is already dead — `grep -rn useWorkState tugdeck/src` finds only its own file.

**Implications:**
- `select-work.ts` shrinks to the per-cell derivation module (Spec S02); its doc header is rewritten for the split.

#### [P12] Slash routing: `/tasks` → TASKS placard, `/bashes` → JOBS placard (DECIDED) {#p12-slash-routing}

**Decision:** The imperative handle `SessionTelemetryStatusRowHandle` replaces `openWork()` with `openTasks()` and `openJobs()`. In `session-card.tsx`'s slash-command map, `tasks:` calls `openTasks()`, `bashes:` calls `openJobs()`; `context:` is unchanged.

**Rationale:**
- Upstream `/bashes` is about running shells/subagents — jobs; `/tasks` is the checklist. The aliases finally mean different things.

**Implications:**
- `session-card-placement-experiment.tsx` forwards the same handle type; the type change ripples there mechanically.
- The two entries' user-visible `description` strings in `tugdeck/src/lib/slash-commands.ts` currently read "Show the session's work (goal, jobs, scheduled, checklist) in the WORK popover" and "…in the WORK popover (alias of /tasks)". Both are now wrong on two counts — there is no WORK popover, and `/bashes` is no longer an alias of `/tasks` since the two open different surfaces. They are rewritten in Step 3, as is the explanatory comment in `tugdeck/src/lib/slash-supported.ts` (which also says the pair opens the WORK popover); `tugdeck/src/lib/__tests__/slash-supported.test.ts` is checked for assertions over those strings.

---

#### [P13] The durable record loses [D107] and restores [D100]/[D102] (DECIDED) {#p13-durable-record}

**Decision:** In `tuglaws/design-decisions.md`: **[D107] is deleted outright** — the decision that merged TASKS and JOBS into WORK describes a cell that will not exist. The "**Superseded (cell layout only):**" trailers at the end of [D100] and [D102] are removed, restoring both as live doctrine for their own cells. [D97]'s Z2 zone-table row is rewritten to `STATE · TIME · CONTEXT · TASKS · JOBS` with the two popovers described, and the ASCII zone diagram's "(WORK cell per [D107], unifying [D100]/[D102]…)" annotation is updated. Every surviving `[D107]` citation elsewhere in the file is resolved to [D100]/[D102].

**Rationale:**
- Decided with the user during review. An obsolete design is deleted, never left standing behind a "superseded by" marker — the same rule that removes the trailers is the rule that removes [D107] itself.
- [D100] and [D102] already contain the doctrine the split restores: [D100]'s derived turn-scoped fold, idle demotion and `N/M` reading; [D102]'s session-lifetime ledger, `jobsCellPose`, and the deliberate no-idle-demotion divergence. Restoring them costs a trailer deletion rather than a rewrite.

**Implications:**
- [D102]'s body carries two stale layout sentences from its own era — "TIME / TOKENS narrowed 16ch→12ch to pay for the 14ch JOBS cell" and "container-query collapse order TIME → TOKENS → TASKS → JOBS" — which must be corrected to this plan's measured budgets and [P10]'s order rather than left as a second, contradicting account.
- `tuglaws/slash-commands.md` names the WORK popover as `/tasks`'s surface and needs the same correction; `tuglaws/session-card-unsupported-slash-commands.md` carries a WORK-popover mention in its prose.
- Decision numbers are not reused: nothing new claims `D107`.

---

#### [P14] `select-work.ts` stays free of `components/` imports (DECIDED) {#p14-lib-boundary}

**Decision:** Every derivation in `tugdeck/src/lib/code-session-store/select-work.ts` takes task counts as a **structural** `{ completed: number; total: number }` parameter, exactly as the current `workActiveCount` / `composeWorkSummary` do. `TaskCounts`, `countTasks`, `composeTaskSummary` and `composeTaskCopyText` are **not** imported into `lib/` — they live in `tugdeck/src/components/tugways/body-kinds/todo-list-block.tsx`, and the components-layer callers (the status row, the Tasks popup) call them directly.

**Rationale:**
- `telemetry.ts` states the boundary in its own source: category tones are "declared locally here rather than imported from the components layer so the library boundary stays one-way: `lib` doesn't depend on `components`."
- The existing `select-work.ts` already honors it structurally; a `composeTasksSummary` in `lib` that delegated to `composeTaskSummary` in `components` would be the first violation.

**Implications:**
- There is no `composeTasksSummary` in the selector layer. The TASKS cell's aria summary and the Tasks popup's footer both call `composeTaskSummary(countTasks(tasks))` in the components layer, which is where both already live.
- `tasksRecentlyDone` may take `readonly TaskItem[]`: `TaskItem` comes from `lib/code-session-store/select-task-list.ts`, not from `components/`.

---

#### [P15] Each work cell states its own width-stabilize ghost set (DECIDED) {#p15-ghost-set}

**Decision:** The TASKS cell passes `phaseLabels={{ none: "None", max: "00/00" }}`; the JOBS cell passes `phaseLabels={{ none: "None", max: "00" }}` (the WORK cell's current set, correct for a bare count). Both keep `labelAlign="center"`.

**Rationale:**
- Under `labelAlign="center"`, `TugProgressIndicator` renders every `phaseLabels` entry as a hidden ghost in the label's grid cell and sizes the cell to the widest — it is the width-stabilize set, not a display map (see its props doc: "doubles as the width-stabilize set for `labelAlign='center'`"). A fraction label against a `"00"` ghost is unstabilized and shifts as digits are added.
- `"00/00"` reserves the widest realistic fraction; a longer checklist is possible but a two-digit-over-two-digit reservation is the honest budget, matching how the row's other cells are sized to their widest realistic face rather than their theoretical one.

**Implications:**
- The ghost set participates in the cell's intrinsic width, so it is measured together with the [P10] budget pass, not after it.

### Specification {#specification}

**Table T01: Z2 cell lineup (post-split)** {#t01-cell-lineup}

| Order | `data-priority` / `PlacardKind` | Label | Value | Pose source | Popup |
|---|---|---|---|---|---|
| 0 | `state` | STATE | phase title | `sessionSessionPhaseKey` (unchanged) | state-change log (unchanged) |
| 1 | `time` | TIME | live/job-extended clock (unchanged) | — | per-turn time log (unchanged) |
| 2 | `context` | CONTEXT | `used / max` with threshold tint (unchanged) | — | breakdown, unchanged — its `messages` segment already carries the conversation total ([P06]) |
| 3 | `tasks` | TASKS | `done/total` fraction, `None` empty ([P04]) | `tasksCellPose` | numbered checklist ([P07]) |
| 4 | `jobs` | JOBS | active count, `None` at zero ([P05]) | `jobsCellPose` + linger gate | goal/running/scheduled/finished + actions ([P08]) |

Replay inerting is unchanged: while `phase === "replaying"` or cold restore is active, every value cell renders the inert em-dash and only STATE stays live.

**Spec S01: `PlacardKind` and handle** {#s01-placard-kind}

`PlacardKind` in `session-card-telemetry-renderers.tsx` becomes `"state" | "time" | "context" | "tasks" | "jobs" | "btw"`. `PLACARD_TITLES` maps the two new keys to `"Tasks"` / `"Jobs"`. `measureAnchorCenter` needs no change — it already looks up cells by `[data-priority="${key}"]`, and the new kinds match the new cell priorities. `SessionTelemetryStatusRowHandle`: `openContext()`, `openTasks()`, `openJobs()`, `openSideQuestions()`.

**Spec S02: per-cell derivations in `select-work.ts`** {#s02-derivations}

The module keeps its name and `WORK_LINGER_MS`, and becomes the per-cell Z2 derivation layer. All functions pure; all unit-tested in `__tests__/select-work.test.ts`. Per [P14] nothing here imports from `components/` — task counts arrive as a structural `{ completed, total }`, the shape the current merged helpers already take:

- `formatTaskFraction(counts: { completed: number; total: number }): string` — `"3/7"`, or `"None"` when `counts.total === 0`. The caller supplies the counts via `countTasks` in the components layer.
- `tasksCellPose(checklist: {hasTasks, allTasksComplete, isIdle}, recentlyCompleted: boolean): "stopped" | "running" | "completed"` — the checklist branch of today's `workCellPose`, verbatim semantics: all-complete → `completed` only while `recentlyCompleted`, else `stopped`; otherwise `running` unless idle-demoted to `stopped`; no tasks → `stopped`.
- `tasksRecentlyDone(tasks, nowMs, lingerMs): number` and `jobsRecentlyDone(jobs, nowMs, lingerMs): number` — the two halves of today's `countRecentlyDone` (tasks by `completedAtMs`, terminal jobs by `endedAtMs`).
- `jobsCellActiveCount(jobCounts: JobCounts, goal: GoalState | null): number` — `running + scheduled + (goalIsActive ? 1 : 0)`.
- `jobsCellDisplayPose(jobs, goal, recentlyCompleted): "stopped" | "running" | "completed" | "aborted"` — `jobsCellPose(jobs)` (from `select-jobs.ts`) with the linger gate: `completed` demotes to `stopped` when not `recentlyCompleted`; `running`/`aborted` pass through. An active goal alone contributes count, never pose.
- `cellDisplayCount(activeCount, recentlyDone): number` — today's `workDisplayCount`, shared by both cells; formatted by the existing `formatWorkCount` (renamed `formatCellCount`).
- `nextLingerExpiryMs(tasks, jobs, nowMs, lingerMs): number | null` — kept with today's signature (the row schedules one timeout at the earliest expiry across both cells, per [P09]).
- `composeJobsCellSummary(jobCounts, goal): string` — the jobs/goal half of today's `composeWorkSummary` ("goal active, 1 running, 2 scheduled, 1 finished"; "No jobs" empty).

The TASKS cell's aria summary is **not** a function here: it is `composeTaskSummary(countTasks(tasks))`, both already exported from `components/tugways/body-kinds/todo-list-block.tsx` and called from the components layer ([P14]).

**Spec S03: popup contracts** {#s03-popup-contracts}

`TasksPopoverContent({ state: TaskListState, idle: boolean })` — rewritten in place. Ordinal-numbered rows (a leading muted `{n}.` span inside the `TugPopupListItemText` primary line; **not** a hand-rolled list widget) built from the same `TugPopupListItem` composition the WORK popup's Tasks group uses today, `TugProgressIndicator` dot via the existing `taskRowState(status, idle)`, description tooltip. Rows keep the `session-tasks-popover-item` class — `tugdeck/src/components/tugways/cards/session-card-telemetry-popovers.css` already styles its completed state — and the ordinal span's rule goes in that same file, carrying a `@tug-renders-on` annotation since it sets `color` without a background ([L16]). Footer: `composeTaskSummary(countTasks(tasks))` + COPY (`composeTaskCopyText(tasks, false)`). Empty state: "No tasks for this session."

`JobsPopoverContent({ goal, canClearGoal, onClearGoal, jobs, transcript, turnNumberBase, onScrollToRow, onStopJob, onCancelScheduledWork, onStopLoop, onClearJobs })` — rewritten in place: today's `WorkPopoverContent` minus `taskState`/`idle` and the Tasks group. Groups Goal / Running / Scheduled / Finished, each rendered only when non-empty; `JobRow` unchanged (including `#a{turn}` launch links, progress tool name, wake badges); footer summary is `composeJobsCellSummary` + COPY (`composeJobsCopyText`) + plain **Clear** (disabled when `counts.finished === 0`). Empty state: "No background jobs this session."

`ContextPopoverContent` and `ContextBreakdownBody` are untouched ([P06]).

**Spec S04: the per-cell CSS rules that must follow the rename** {#s04-cell-css}

`tugdeck/src/components/tugways/tug-status-cell.css` keys **four** rule blocks on `[data-priority="work"]`, and all four exist because the work cell's value row is one `TugProgressIndicator` rather than the sibling glyphs+value STATE uses. Each must apply to **both** new cells (`[data-priority="tasks"], [data-priority="jobs"]`), or the two cells lose the treatment silently:

1. `.tug-progress-indicator` → `display:flex; width:100%; justify-content:space-between` — without it the indicator shrink-wraps and the two dots park ~30px inside the endcap ticks instead of tracking STATE's excursion.
2. `.tug-progress-indicator-glyph` → `margin-inline: 2px` — the same 2px inset STATE uses.
3. `.tug-progress-indicator-label-active` → the row's focal value treatment (`0.75rem`, bold, `nowrap`, `tabular-nums`). `tabular-nums` is what keeps a ticking fraction from reflowing.
4. `.session-telemetry-status-value-wrap[data-empty="true"]` → muted color for the `None` reading. This one sets `color` with no background and already carries its `@tug-renders-on` annotation ([L16]) — keep it on the re-keyed rule.

#### State Zone Mapping (tugdeck/tugways plans) {#state-zone-mapping}

No new state *kinds* — every mechanism below already exists in the row; the table records where the reworked pieces live so the swap does not drift zones.

No new state *kind* is introduced — every mechanism below already carries this data in the row today. The table records the zone each reworked piece keeps, in [L24]'s vocabulary, so the split does not drift one across a boundary.

| State | Zone (appearance / local-data / structure) | Mechanism | Law |
|-------|--------------------------------------------|-----------|-----|
| Task list, jobs ledger, goal, phase (feeding both cells' values and poses) | structure | `useSyncExternalStore` via the existing `useTaskListState` / `useJobsState` / store snapshot | [L02] |
| Which placard is open, and its measured anchor x | local data | existing `useState` in `SessionTelemetryStatusRow` (read back through `placardKeyRef` for the toggle) | [L24] |
| Linger expiry recompute nudge | local data | existing single bounded `setTimeout` + `useState` counter, now taking the min across both cells | [L24] |
| Cell collapse at narrow widths | appearance | CSS `@container session-status` rungs only — no JS measurement, no React state | [L06] |
| Replay inerting (dim + pointer-events off) | appearance | existing `data-replay-inert` attribute on the row + CSS | [L06] |
| Empty-value dim (`None`) | appearance | existing `data-empty` attribute via `TugStatusCell`'s `valueEmpty` + CSS | [L06] |

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files (if any) {#new-files}

None. Every change lands in existing files; one file is deleted (`use-work-state.ts`).

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `formatTaskFraction` | fn (new) | `tugdeck/src/lib/code-session-store/select-work.ts` | [P04]; structural counts param ([P14]) |
| `tasksCellPose` | fn (new) | `select-work.ts` | checklist branch of old `workCellPose` |
| `tasksRecentlyDone` / `jobsRecentlyDone` | fn (new) | `select-work.ts` | split of `countRecentlyDone` |
| `jobsCellActiveCount` | fn (new) | `select-work.ts` | [P05] |
| `jobsCellDisplayPose` | fn (new) | `select-work.ts` | wraps `jobsCellPose` + linger gate |
| `cellDisplayCount` | fn (rename) | `select-work.ts` | was `workDisplayCount` |
| `formatCellCount` | fn (rename) | `select-work.ts` | was `formatWorkCount` |
| `composeJobsCellSummary` | fn (new) | `select-work.ts` | jobs/goal half of `composeWorkSummary`; the tasks half is `composeTaskSummary` in the components layer ([P14]) |
| `workActiveCount`, `workCellPose`, `workCellLabel`, `composeWorkSummary`, `selectWorkItems`, `WorkItem`, `WorkKind`, `WorkGroup`, `WorkAction` | delete | `select-work.ts` | [P11] |
| `use-work-state.ts` | delete file | `tugdeck/src/lib/code-session-store/hooks/` | dead hook, zero callers |
| `computeTokensSummary`, `TurnTokensSummary` | delete | `tugdeck/src/lib/code-session-store/telemetry.ts` | [P06], [P11] — no replacement |
| `TasksPopoverContent` | component (rewrite) | `.../cards/session-card-telemetry-popovers.tsx` | [P07] |
| `JobsPopoverContent` | component (rewrite) | same file | [P08] |
| `TokensPopoverContent`, `WorkPopoverContent` | delete | same file | [P01], [P11] |
| ordinal-span rule | CSS (new) | `.../cards/session-card-telemetry-popovers.css` | [P07]; needs `@tug-renders-on` ([L16]) |
| `PlacardKind`, `PLACARD_TITLES`, `SessionTelemetryStatusRowHandle`, `SessionTelemetryStatusRow` | modify | `.../cards/session-card-telemetry-renderers.tsx` | Spec S01, Table T01, [P15] |
| slash map entries `tasks:` / `bashes:` | modify | `.../cards/session-card.tsx` | [P12] |
| `tasks` / `bashes` `description` strings | modify | `tugdeck/src/lib/slash-commands.ts` | [P12] — both name the WORK popover today |
| `/tasks` graduation comment | modify | `tugdeck/src/lib/slash-supported.ts` | [P12] |
| per-priority width rules, the four work-cell rule blocks, collapse rungs | modify | `tugdeck/src/components/tugways/tug-status-cell.css` | [P10], Spec S04 |
| [D97] zone table + diagram, [D100] / [D102] trailers, [D107] | modify / delete | `tuglaws/design-decisions.md` | [P13] |
| WORK-popover references | modify | `tuglaws/slash-commands.md`, `tuglaws/session-card-unsupported-slash-commands.md` | [P13] |

---

### Documentation Plan {#documentation-plan}

- [ ] `tuglaws/design-decisions.md`: delete [D107]; strike the "Superseded (cell layout only)" trailers from [D100] and [D102]; correct [D102]'s stale layout sentences (the 16ch→12ch note and the `TIME → TOKENS → TASKS → JOBS` collapse order); rewrite [D97]'s `Z2` zone-table row and the ASCII diagram's WORK annotation ([P13]).
- [ ] `tuglaws/slash-commands.md`: `/tasks`'s surface is the TASKS popover and `/bashes`'s is JOBS — they are no longer one popover behind two names.
- [ ] `tuglaws/session-card-unsupported-slash-commands.md`: the WORK-popover sentence in its prose.
- [ ] No new tuglaws document — this rework changes existing doctrine rather than adding a surface.

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit** (bun test, `tugdeck/`) | Pin the pure derivations: fractions, counts, poses, lingers, summaries | Step 1 |
| **Integration** (app-test, real Tug.app) | The row renders the new lineup from a real replayed session; the scheduled row survives respawn in the JOBS popup; the cycle walks five stops | Step 4 |

#### What stays out of tests {#test-non-goals}

- No jsdom/fake-DOM render tests of the popovers or the row — banned pattern; the app-tests drive the real surface.
- No mock-store assertion tests — the unit layer tests pure functions only.
- No test of the CONTEXT popup at all — this plan does not change it ([P06]).
- No pixel/measurement tests of the width budgets — the doctrine is comment-documented measurement, verified by eye at the presets, as the current row already does.

---

### Execution Steps {#execution-steps}

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Selector layer: per-cell derivations | pending | — |
| #step-2 | Popup layer: Tasks and Jobs rewritten | pending | — |
| #step-3 | Status row swap: lineup, placards, routing, CSS | pending | — |
| #step-4 | App-test updates and selective run | pending | — |
| #step-5 | Durable record: retire [D107], restore [D100]/[D102] | pending | — |
| #step-6 | Integration Checkpoint | pending | — |

#### Step 1: Selector layer: per-cell derivations {#step-1}

**Commit:** `tugways(z2-tasks-jobs): add the per-cell TASKS and JOBS derivations`

**References:** [P04] TASKS fraction, [P05] JOBS count, [P09] per-cell linger, [P14] lib boundary, Spec S02, (#symbols)

**Artifacts:**
- New derivations in `tugdeck/src/lib/code-session-store/select-work.ts` per Spec S02, added alongside the existing merged helpers (which Step 3 deletes — the tree stays buildable at every commit).

**Tasks:**
- [ ] Implement every Spec S02 function; keep `WORK_LINGER_MS` and `nextLingerExpiryMs` as-is; add the renames as new names (old names untouched until Step 3).
- [ ] Keep the module import-clean per [P14]: `./select-goal`, `./select-jobs`, `./select-task-list` only — no `components/` import, and task counts arrive structurally.

**Tests:**
- [ ] Extend `tugdeck/src/lib/code-session-store/__tests__/select-work.test.ts`: fraction formatting (`0/0`→`None`, `3/7`, `12/17`), `tasksCellPose` idle demotion + linger-gated green, `jobsCellActiveCount` (running+scheduled+goal), `jobsCellDisplayPose` (aborted nags, completed demotes past linger, active-goal-alone stays quiet), per-cell recently-done splits, `composeJobsCellSummary` zero-bucket drop.

**Checkpoint:**
- [ ] `cd /Users/kocienda/Mounts/u/src/tugtool/tugdeck && bun test src/lib/code-session-store/__tests__/select-work.test.ts`
- [ ] `cd /Users/kocienda/Mounts/u/src/tugtool/tugdeck && bun run check`

---

#### Step 2: Popup layer: Tasks and Jobs rewritten {#step-2}

**Depends on:** #step-1

**Commit:** `tugways(z2-tasks-jobs): rewrite the Tasks and Jobs popups for the split surfaces`

**References:** [P07] numbered tasks, [P08] jobs popup, [P14] lib boundary, Spec S03, (#p11-deletions)

**Artifacts:**
- `TasksPopoverContent` and `JobsPopoverContent` rewritten in place in `tugdeck/src/components/tugways/cards/session-card-telemetry-popovers.tsx` per Spec S03. Both currently have **zero callers** (they are leftovers from the merge that created WORK), so rewriting them breaks nothing and the live `WorkPopoverContent` keeps running until Step 3 swaps the row.
- One new rule in `session-card-telemetry-popovers.css` for the ordinal span.

**Tasks:**
- [ ] Rewrite `TasksPopoverContent` with the ordinal column, composing `TugPopupListFrame` / `TugPopupListScroller` / `TugPopupListItem` / `TugPopupListItemText` / `TugPopupListFooter` — the same primitives the WORK popup's Tasks group uses; no hand-rolled list.
- [ ] Add the ordinal span's CSS rule with its `@tug-renders-on` annotation ([L16]); reference only popup-list-scoped tokens ([L20]).
- [ ] Rewrite `JobsPopoverContent` as `WorkPopoverContent` minus the Tasks group: goal row (with idle-gated clear), always-grouped Goal/Running/Scheduled/Finished sections, `onStopLoop` threading, footer `composeJobsCellSummary` + COPY + plain **Clear**. `JobRow`, `wakeBadgeText`, `scheduledCancelEnabled`, `formatWakeSchedule`, `jobRowState`, `goalRowState` carry over unchanged.

**Tests:**
- [ ] Keep the existing pure-helper tests green (`wakeBadgeText`, `scheduledCancelEnabled`, `formatWakeSchedule` are exported for exactly this and must stay exported). Popup rendering is covered by Step 4's app-tests — no fake-DOM render tests.

**Checkpoint:**
- [ ] `cd /Users/kocienda/Mounts/u/src/tugtool/tugdeck && bun test`
- [ ] `cd /Users/kocienda/Mounts/u/src/tugtool/tugdeck && bun run check` — `vite build` strips types without checking them, so this is the step's real type gate.
- [ ] `cd /Users/kocienda/Mounts/u/src/tugtool/tugdeck && bun run audit:tokens`

---

#### Step 3: Status row swap: lineup, placards, routing, CSS {#step-3}

**Depends on:** #step-2

**Commit:** `tugways(z2-tasks-jobs): retire TOKENS, split WORK into TASKS + JOBS on the Z2 row [L02][L06][L19][L20]`

**References:** [P01] retire tokens, [P02] split, [P03] row order, [P10] collapse order, [P11] deletions, [P12] slash routing, [P15] ghost sets, Spec S01, Spec S04, Table T01, (#state-zone-mapping, #r01-rung-mismeasure, #r02-ghost-set)

**Artifacts:**
- `SessionTelemetryStatusRow` renders the Table T01 lineup; `PlacardKind`/`PLACARD_TITLES`/handle per Spec S01.
- `session-card.tsx` slash map plus the two slash entries' descriptions in `slash-commands.ts` and the comment in `slash-supported.ts`.
- `tug-status-cell.css` per-priority widths, the four re-keyed rule blocks (Spec S04), and the rungs.
- All [P11] deletions, including `computeTokensSummary`/`TurnTokensSummary` and the old merged helpers plus their tests.

**Tasks:**
- [ ] Rebuild the cell block: order state/time/context/tasks/jobs with `focusOrder` offsets 0–4; TASKS cell = flanking-dot `TugProgressIndicator` with `formatTaskFraction` label, `tasksCellPose`, `phaseLabels={{ none: "None", max: "00/00" }}` ([P15]); JOBS cell = same composition with `formatCellCount(cellDisplayCount(...))`, `jobsCellDisplayPose`, `phaseLabels={{ none: "None", max: "00" }}`; both honor replay inerting and `valueEmpty` at their empty readings; aria labels are `composeTaskSummary(countTasks(tasks))` and `composeJobsCellSummary(...)`.
- [ ] Wire per-cell linger counts into the one bounded-timeout effect (earliest expiry across both cells via `nextLingerExpiryMs`).
- [ ] Delete the tokens placard branch, the `tokensPopover` element, and the `tokensCellValue` display path — keeping the live `streaming_usage` subscription, which CONTEXT still reads.
- [ ] Update `SessionTelemetryStatusRowHandle` + `session-card.tsx` map + `session-card-placement-experiment.tsx` forwarding; rewrite the stale comment at the `tasks:`/`bashes:` entries, the two `description` strings in `tugdeck/src/lib/slash-commands.ts`, and the graduation comment in `tugdeck/src/lib/slash-supported.ts`. Check `tugdeck/src/lib/__tests__/slash-supported.test.ts` for assertions over those strings.
- [ ] CSS, Spec S04: re-key all four `[data-priority="work"]` rule blocks to cover both new cells, preserving the `@tug-renders-on` annotation on the empty-dim rule.
- [ ] CSS, [P10]: re-measure per-priority budgets in the built app (widest faces: the TASKS endcap label vs a `00/00`-class fraction *including its ghost set*; JOBS label vs dot+`00`) and set the three rungs (TIME, then TASKS, then JOBS) against the slim strip's ~657px content box; rewrite the doctrine comment for the new lineup; update the stale "five cells / STATE · TIME · TOKENS · CONTEXT · WORK" comments in `session-card-telemetry-renderers.css` and the renderers file.
- [ ] Apply all [P11] deletions; `grep -rn "workCellPose\|selectWorkItems\|TokensPopoverContent\|WorkPopoverContent\|computeTokensSummary\|useWorkState\|data-priority=\"work\"\|data-priority=\"tokens\"" tugdeck/src` comes back empty.

**Tests:**
- [ ] Prune the deleted helpers' cases from `select-work.test.ts` and `computeTokensSummary`'s from `telemetry.test.ts`; full tugdeck unit suite green.

**Checkpoint:**
- [ ] `cd /Users/kocienda/Mounts/u/src/tugtool/tugdeck && bun test`
- [ ] `cd /Users/kocienda/Mounts/u/src/tugtool/tugdeck && bun run check` — the type gate for the handle-interface change, which ripples into `session-card.tsx` and `session-card-placement-experiment.tsx`.
- [ ] `cd /Users/kocienda/Mounts/u/src/tugtool/tugdeck && bun run audit:tokens`
- [ ] `cd /Users/kocienda/Mounts/u/src/tugtool/tugdeck && bunx vite build`
- [ ] Visual pass in the running app at the 675/800/1230 width presets: five cells present at slim, no label shift as a fraction gains a digit, collapse order TIME → TASKS → JOBS when dragged narrower.
- [ ] `/tasks` and `/bashes` each open their own placard, including on a card narrow enough to have collapsed the cell (expected: opens clamped in-card, per Risk R02's row in the risk table).

---

#### Step 4: App-test updates and selective run {#step-4}

**Depends on:** #step-3

**Commit:** `tugways(z2-tasks-jobs): repin the Z2 app-tests to the TASKS/JOBS lineup`

**References:** [P02] split, [P04] fraction, [P08] jobs popup, Table T01, (#success-criteria, #test-categories)

**Artifacts:**
- Updated app-tests; a green `just app-test-changed` run.

**Tasks:**
- [ ] `tests/app-test/at0192-z2-cold-replay.test.ts`: drop the `TOKENS_JS` probe and its "TOKENS non-zero" assertion (the file's header prose names TOKENS too); keep the CONTEXT numerator/denominator assertions unchanged; add an assertion that no `[data-priority="tokens"]` cell exists and that `[data-priority="tasks"]` / `[data-priority="jobs"]` do.
- [ ] `tests/app-test/at0140-cycle-session-card.test.ts`: the five cell selectors are named constants (`Z2_STATE` … `Z2_WORK`) — replace `Z2_TOKENS`/`Z2_WORK` with `Z2_TASKS`/`Z2_JOBS` and re-order them to match the new left→right walk, since the file asserts the cycle's order.
- [ ] `tests/app-test/at0197-scheduled-survives-respawn.test.ts`: its `WORK_CELL` constant selects `[data-priority="work"]` and its assertions read that cell's `textContent` for the scheduled count — re-point to `[data-priority="jobs"]`; the scheduled row is a JOBS reading now.
- [ ] `grep -rn 'data-priority="work"\|data-priority="tokens"\|openWork' tests/` and fix any further pins; check `at0084-session-lifecycle-coordination.test.ts` (it `@covers` the renderers file, so the selector picks it up) for incidental selectors.
- [ ] Run `just app-test-changed` (bare, never piped) and read the report; fix reds.

**Tests:**
- [ ] The updated app-tests themselves.

**Checkpoint:**
- [ ] `cd /Users/kocienda/Mounts/u/src/tugtool && just app-test-changed` — VERDICT green.

---

#### Step 5: Durable record: retire [D107], restore [D100]/[D102] {#step-5}

**Depends on:** #step-3

**Commit:** `tuglaws(z2-tasks-jobs): retire [D107] and restore the TASKS and JOBS cell decisions`

**References:** [P13] durable record, [P02] split, [P10] collapse order, Table T01, (#documentation-plan)

**Artifacts:**
- `tuglaws/design-decisions.md`, `tuglaws/slash-commands.md`, `tuglaws/session-card-unsupported-slash-commands.md`.

**Tasks:**
- [ ] Delete the **[D107]** entry outright. Leave the number unreused; do not replace it with a tombstone or a "superseded by" line.
- [ ] Remove the trailing "**Superseded (cell layout only):** the standalone `TASKS`/`JOBS` cell merged into the unified `WORK` cell per [D107]…" sentence from **[D100]** and from **[D102]**, so both read as live doctrine for their own cell again.
- [ ] Correct [D102]'s two stale layout sentences: the "TIME / TOKENS narrowed 16ch→12ch to pay for the 14ch JOBS cell" note and the "collapse order TIME → TOKENS → TASKS → JOBS" note, replaced by Step 3's measured budgets and [P10]'s order.
- [ ] Rewrite [D97]'s `Z2` zone-table row: five cells STATE · TIME · CONTEXT · TASKS · JOBS, the TASKS fraction and JOBS count readings, and the two popovers with their actions. Update the ASCII zone diagram's "(WORK cell per [D107], unifying [D100]/[D102]…)" annotation.
- [ ] `grep -n "D107" tuglaws/` comes back empty; every former citation now reads [D100] and/or [D102].
- [ ] Fix the WORK-popover sentences in `tuglaws/slash-commands.md` (`/tasks`'s surface) and `tuglaws/session-card-unsupported-slash-commands.md`.

**Tests:**
- [ ] None — this step changes prose only. Its falsifiable claim is the grep below.

**Checkpoint:**
- [ ] `grep -rn "D107" /Users/kocienda/Mounts/u/src/tugtool/tuglaws/` returns nothing.
- [ ] `grep -rn "WORK popover\|WORK cell" /Users/kocienda/Mounts/u/src/tugtool/tuglaws/` returns nothing.
- [ ] [D97]'s `Z2` row read back names the five shipped cells in order.

---

#### Step 6: Integration Checkpoint {#step-6}

**Depends on:** #step-4, #step-5

**Commit:** `N/A (verification only)`

**References:** [P02] split, [P13] durable record, Table T01, (#success-criteria)

**Tasks:**
- [ ] `tugutil dash replay <name>` — put the rounds on the live base, so what gets verified is what would land.
- [ ] `Replayed` / `Recorded`: verify the replayed tree with the project's declared verify command (`tugutil dash config --json`), substituting `{base}`/`{head}` with the replayed range (in this repo: `sh scripts/verify-fit.sh {base} {head}`).
- [ ] `Current`: the base never moved, so the last step's checkpoint already verified these exact bytes — re-run nothing and say so.
- [ ] `Conflicted`: resolve the named round in the worktree, then verify as above.

**Tests:**
- [ ] None of its own. This step re-proves nothing the steps proved; it establishes that their work still holds on the base as it stands now.

**Checkpoint:**
- [ ] The replay reports its outcome, and the scoped verification is green **or** was correctly skipped as `Current`.

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** The Session card's Z2 row reads STATE · TIME · CONTEXT · TASKS · JOBS — TOKENS retired, the checklist and the background-work surfaces each with an honest count and a focused popup, all management actions preserved, and the tuglaws record describing the row that actually ships.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] Per-cell derivations pinned by unit tests (bun test, Step 1).
- [ ] Tasks popup numbered; Jobs popup grouped with the full action set (built + type-checked, Step 2; app-test-asserted Step 4).
- [ ] No surviving reference to the merged WORK grammar or the TOKENS surface anywhere in `tugdeck/src` (grep task, Step 3).
- [ ] Width budgets, ghost sets, the four re-keyed cell rules and the collapse rungs all landed; five cells hold at the slim preset with no label shift (visual pass, Step 3).
- [ ] `just app-test-changed` VERDICT green (Step 4).
- [ ] [D107] gone, [D100]/[D102] restored, [D97]'s zone table current (grep + read-back, Step 5).
- [ ] Replay-and-verify ending completed (Step 6).

**Acceptance tests:**
- [ ] Updated `at0192-z2-cold-replay` (the new lineup reconstructed from a real replayed session, Step 4).
- [ ] Updated `at0197-scheduled-survives-respawn` (scheduled row in the JOBS popup, Step 4).

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] Consider surfacing the in-progress task's `activeForm` as the TASKS popup's running-row meta line.
- [ ] Consider whether the CONTEXT popup's `Messages` legend label reads clearly enough as the session's conversation total, now that it is the only place that figure appears.

| Checkpoint | Verification |
|------------|--------------|
| Selector layer | bun unit tests + `bun run check` (Step 1) |
| Popup layer | `bun test` + `bun run check` + `audit:tokens` (Step 2) |
| Row swap | `bun test` + `bun run check` + `audit:tokens` + `vite build` + preset visual pass (Step 3) |
| App surface | `just app-test-changed` (Step 4) |
| Durable record | greps over `tuglaws/` (Step 5) |
| Fit on live base | dash replay + scoped verify (Step 6) |
