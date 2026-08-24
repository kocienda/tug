<!-- devise-skeleton v4 -->

## Slash-Command Expansion: /goal, /loop, /btw, the Slash Doctrine, and the WORK Cell {#slash-command-expansion}

**Purpose:** Ship first-class Dev-card support for Claude Code's `/goal`, `/loop`, and `/btw` commands, codify the slash-command doctrine as a tuglaws document, and unify the Z2 TASKS and JOBS cells into a single `WORK` cell that also tracks goals, loops, and scheduled work — one surface for every trackable unit of session work.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-07-08 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

Claude Code has grown three commands that produce session activity outside the plain user→assistant turn cycle: `/goal` (an evaluator keeps starting new turns until a condition holds), `/loop` (a skill that re-runs a prompt on a timer via `CronCreate` / `ScheduleWakeup`), and `/btw` (an ephemeral side question that never enters history). Today the Dev card swallows `/goal` and `/loop` (`HIDDEN_SLASH_COMMANDS` in `tugdeck/src/lib/slash-supported.ts`) and passes `/btw` through *by accident* — nobody has verified what `/btw` does over the stream-json bridge. Meanwhile the knowledge of how slash commands flow through Tug lives only in an investigation dropfile (`dash/slash-commands-investigations.md`) and a hidden-list mirror doc, and the Z2 status bar has accreted two separate work-tracking cells (TASKS per [D100], JOBS per [D102]) with a third and fourth candidate (goals, loops) now knocking.

This plan does four things in one arc: (1) writes the durable slash-command doctrine into `tuglaws/`, (2) re-baselines the capability fixtures on claude 2.1.204 and probes the three commands' real wire behavior, (3) unhides and plumbs `/goal` and `/loop` (and resolves `/btw`), and (4) merges TASKS + JOBS into a single `WORK` cell whose popover also tracks goals, loops, and scheduled work. Per the owner's directive: **the WORK unification is about UI, not storage** — the existing stores stay as they are; a view-model unifies the surface.

#### Strategy {#strategy}

- **Doctrine first** — the tuglaws document has zero unknowns and is the reference the rest of the work cites; write it before touching code.
- **Evidence before plumbing** — re-baseline fixtures with `just capture-capabilities` on 2.1.204, then probe `/goal`, `/loop`, and `/btw` through real tugcode stream-json before unhiding anything. Never unhide a command without a current-CLI capture ([P07]).
- **Pass-through, not reimplementation** — `/goal` and `/loop` execute entirely on the claude side; Tug's work is lifecycle plumbing (turns that start without a user submit) and legibility (chips, status, stop affordances), not command logic ([P01]).
- **Honest surfaces over impersonation** — if scheduled work still dies on respawn/resume (the May 2026 probe finding), mark it stopped and offer re-arm rather than building a tugcode-owned timer that impersonates the harness scheduler ([P04]).
- **Unify the surface, not the storage** — TASKS stays a derived turn-scoped fold, JOBS stays a session-lifetime ledger; a `WorkItem` view-model projects both (plus goal/loop state) into one Z2 cell and grouped popover ([P02], [P03]).
- **Decision gate mid-plan** — probe results feed an explicit checkpoint step that resolves the open questions and records the resolutions in this document before the build steps run.

#### Success Criteria (Measurable) {#success-criteria}

- Typing `/goal <condition>` in the Dev card starts a goal; evaluator-driven continuation turns render with correct phase/turn accounting; `/goal` and `/goal clear` round-trip and render their output. (Verify: app-test + manual real-claude run.)
- Typing `/loop 2m <prompt>` and self-paced `/loop <prompt>` each produce scheduled rows in the WORK popover, wake turns render with a trigger chip naming the loop, and the loop can be stopped from the popover. (Verify: real-claude app-test tier.)
- `/btw` has a deliberate disposition — native side-question surface, or hidden with a notice — decided from probe evidence, never accidental pass-through. (Verify: classifier test + probe capture in repo.)
- `capabilities/LATEST` reads `2.1.204` and every fixture consumer (e.g. `tugdeck/src/__tests__/system-metadata-fixture.test.ts`) is green. (Verify: `just capture-capabilities` + full test suites.)
- The Z2 status bar shows one `WORK` cell where TASKS and JOBS were; all prior affordances (task checklist view, job stop, clear, cron cancel) are reachable from its popover; goals and loops appear there too. (Verify: app-test + `bunx vite build`.)
- `tuglaws/slash-commands.md` exists and answers, standalone: how the three tiers work, how to map an existing Claude Code command, how to add a new command, how output flows back. (Verify: doc review against the checklist in Spec S01.)
- A respawn (model change, Reload, app restart) while a loop is armed produces a visible `stopped` row with a re-arm affordance — never a silently dead loop. (Verify: app-test driving a respawn.)

#### Scope {#scope}

1. `tuglaws/slash-commands.md` — the comprehensive slash-command doctrine; `dev-card-unsupported-slash-commands.md` demoted to its hidden-list mirror.
2. Capability re-baseline (`just capture-capabilities`) to 2.1.204 plus targeted probes for `/goal`, `/loop` (both modes + resume retest), and `/btw`, with fixtures pinned.
3. Unhide `goal`, `loop`, `proactive`; lifecycle plumbing for goal continuation turns; loop durability (honest surface) and legibility (trigger chips, stop).
4. `/btw` disposition and, if bridge-supported, a native side-question surface.
5. The `WORK` Z2 cell: `WorkItem` view-model, merged cell, grouped popover with per-kind actions; `/tasks` and `/bashes` become local commands that open it.
6. `design-decisions.md` updates recording the WORK cell and superseding the TASKS/JOBS cell-layout aspects of [D100]/[D102].

#### Non-goals (Explicitly out of scope) {#non-goals}

- Reimplementing `/goal` or `/loop` semantics in tugcode (the evaluator and scheduler stay claude-owned).
- A tugcode-owned timer that re-fires scheduled work the harness scheduler dropped (see [P04]; revisit only if the honest surface proves insufficient).
- Changing TASKS or JOBS storage (the derived task fold and the jobs ledger both stay; [P02]).
- A generalized Z2 topic-descriptor registry (the merge *reduces* cell count; a registry is follow-on work if Z2 grows again — see [#roadmap]).
- Unhiding the rest of the "conversation-structure / automation" hidden group (`/branch`, `/plan`, `/fork`, `/workflows`, `/schedule`, `/tasks`-as-passthrough, `/autofix-pr`, `/ultraplan`) — each remains a future plan; `/tasks` and `/bashes` are handled here only as local commands opening the WORK popover.
- `/btw`'s fork-into-session (`f`) affordance — deferred even if `/btw` ships natively.
- MCP anything.

#### Dependencies / Prerequisites {#dependencies}

- claude CLI ≥ 2.1.204 on PATH (`/goal` needs ≥ 2.1.139; the fixtures baseline targets 2.1.204 exactly).
- A clean `tugplug/` tree for `just capture-capabilities` (the recipe's dirty-tugplug guard refuses otherwise).
- Real-claude test tier available on demand (`TUG_REAL_CLAUDE=1`) for captures and live app-tests.
- `dash/archive/tugplan-tide-session-wake.md` (wake-plan decisions [D05]–[D13], cited throughout) and `dash/archive/wake-investigation-findings.md` (the resume-scheduler finding).

#### Constraints {#constraints}

- **Warnings are errors** across the Rust workspace; `bunx vite build` must pass before any tugdeck step is declared done (dev-esbuild-only imports hang the app at splash).
- No localStorage/sessionStorage/IndexedDB — any persisted preference goes through tugbank `/api/defaults/<domain>/<key>`.
- Tuglaws apply to all tugdeck work: [L01] one `root.render()`; [L02] external state via `useSyncExternalStore` only; [L03] `useLayoutEffect` for registrations; [L06] appearance via CSS/DOM, never React state.
- No hand-rolled UI where a `Tug*` component exists (compose `TugStatusCell`, `TugPopupListFrame`, `TugProgressIndicator`, `TugAlert`, …).
- App-tests run via `just app-test`; real-claude tests are on-demand only and must exit.
- `/goal` requires workspace trust accepted and hooks enabled (`disableAllHooks` unset) in the claude tugcode spawns — verify, don't assume.

#### Assumptions {#assumptions}

- tugcode's wake machinery (Cohort A `task_notification` / Cohort B re-init detection, `wake_started` frames — see [#wake-mechanics]) is the right substrate for `/loop` wake turns; the probes confirm rather than design this.
- Claude's catalog continues to report `goal`, `loop` (alias `proactive`), and `btw`; the popup needs no new plumbing to show them once unhidden.
- The Dev card's existing interrupt control can terminate a goal continuation turn the same way it terminates a normal turn (probe verifies).

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] What does a `/goal` evaluator-driven continuation turn look like on the wire? (DECIDED) {#q01-goal-wire-shape}

**Question:** After a turn's `result`, when the Stop-hook evaluator says "not met," how does the next turn begin over `--input-format stream-json --output-format stream-json`? A wake-like re-init? A new turn bracket with no `user` event? Is goal state (condition, evaluator reason, achieved) observable anywhere other than `/goal` status stdout?

**Why it matters:** This decides whether goal continuation turns ride the existing wake bracket (Cohort A/B, `wake_started`) or need a third detection path in `tugcode/src/session.ts`; and whether the WORK popover's goal row can show the evaluator's latest reason live or only after a `/goal` status round-trip.

**Options (if known):**
- Continuation turns resemble Cohort B re-inits → reuse the wake bracket with a goal-flavored summary.
- Continuation turns are plain assistant-opener turns → reuse the `assistant_opener` path.
- A new event shape → extend `protocol-types.ts` + `session.ts` detection.

**Plan to resolve:** Probe in #step-3; pin captures.

**Resolution:** DECIDED (probe evidence: `tugcode/probes/goal-loop/FINDINGS.md#q01-goal`,
capture `capture-goal-2026-07-08T14-58-18-964Z`). **A goal run is ONE result
cycle** — continuation is a synthetic `user` event (`isSynthetic: true`, text
`Stop hook feedback:\n[<condition>]: <reason>`) injected into the same cycle;
no re-init, no per-continuation `result`. tugcode needs **no new bracketing**
(the wake cohorts are not involved) — #step-8's tugcode work is instead:
(a) exclude `isSynthetic` user events from the rewind prompt-anchor latch
(today they pass `isSubmissionEcho` and would corrupt the anchor), and
(b) surface the feedback to the deck (a dedicated IPC frame carrying the
evaluator's reason). Goal state is observable only via the
`<command-name>/goal</command-name>` envelope (set), the synthetic feedback
events (active + latest reason), and the cycle result / clear acknowledgment
(ended). `/goal` status output is plain assistant text (no
`<local-command-stdout>`), and upstream status FORGETS an achieved goal on
2.1.204. Feedback events persist to the JSONL — replay must classify them.

#### [Q02] Is the stream-json resume-scheduler bug still present on 2.1.204? (DECIDED) {#q02-resume-scheduler}

**Question:** The 2026-05-25 probe (`tugcode/probes/wake-investigation/probe-resume.mjs`, finding recorded in `dash/archive/wake-investigation-findings.md`) showed that in stream-json mode, `--resume` restores a scheduled task's *metadata* but the in-process scheduler never fires it ("FAIL: no wake_started observed"). Does 2.1.204 still behave this way? And does an active `/goal` (documented to be restored on resume) actually re-arm its evaluator over stream-json?

**Why it matters:** tugcode respawns claude on model/effort change, add-dir, Developer ▸ Reload, and app restart — each silently kills a live loop (and possibly a goal) if the bug persists. This sizes the entire durability step (#step-9): upstream-fixed means a small verification; still-broken means the honest-surface slice ([P04]).

**Plan to resolve:** Re-run `probe-resume.mjs` (and a goal-resume variant) in #step-4.

**Resolution:** DECIDED (probe evidence: `FINDINGS.md#q02-loop`, captures
`capture-loop-*-2026-07-08T15-04-34-180Z`). **The bug is FIXED on 2.1.204** —
a `ScheduleWakeup` armed before a kill fires in the `--resume`d process
(PASS). Since tugcode respawns with `--resume`, live loops survive
model/effort change, Reload, and app restart. Tool-per-mode confirmed:
self-paced → `ScheduleWakeup` (ends via `{stop}`), interval → `CronCreate`;
a wake fire is a fresh `system/init` (Cohort B) + `/loop` envelope
re-injection; no `task_notification` in either mode. Goal-across-resume:
the resumed session continues goal work immediately; evaluator re-arm
unconfirmed (treat a resumed goal as possibly-active, don't clear it).
**#step-9 takes the fixed-upstream branch**: verification + honest scheduled
rows across respawn (no re-arm affordance — nothing needs re-arming; the
step must instead ensure scheduled rows are NOT falsely marked stopped).

#### [Q03] What does `/btw` do over the headless bridge? (DECIDED) {#q03-btw-headless}

**Question:** `/btw` is documented as a TUI overlay (ephemeral answer, never enters history, usable mid-turn, answers off the parent prompt cache with no tools). Its headless/stream-json behavior is undocumented. Does it answer at all? On what channel (a normal-looking turn? `<local-command-stdout>`? an error)? Does the exchange stay out of the session JSONL?

**Why it matters:** `btw` is currently **pass-through by accident** (absent from `HIDDEN_SLASH_COMMANDS`, so `classifySlashCommand` defaults it to pass-through). If it errors or burns a normal turn headless, users get broken behavior today. The answer picks between the two #step-11 branches.

**Plan to resolve:** Probe in #step-5: send `/btw <question>` through tugcode against a session with prior context; capture everything; also inspect the session JSONL afterward for contamination.

**Resolution:** DECIDED (probe evidence: `FINDINGS.md#q03-btw`, capture
`capture-btw-2026-07-08T15-05-07-785Z`). **`/btw` is not available over the
headless bridge**: claude answers `"/btw isn't available in this
environment."` as a local zero-cost response (`num_turns: 0`, no envelope,
no model turn burned), and the exchange still enters the session JSONL.
`btw` is also absent from the 2.1.204 `slash_commands` catalog. There is no
headless side-question channel to render.

#### [Q04] If `/btw` is unsupported headless, hide-with-notice or build Tug-side? (DECIDED) {#q04-btw-fallback}

**Question:** Should an unsupported `/btw` be hidden (minimum), or implemented Tug-side (tugcode issues a one-shot, tool-less query against session context)?

**Why it matters:** Tug-side implementation is real work (a parallel query channel, cache reuse, an overlay surface) and should be a deliberate decision, not a default.

**Options (if known):**
- Hide with the standard "Command not available" notice; record in the mirror doc. (Cheap, honest.)
- Tug-side ephemeral query — a separate follow-on plan.

**Plan to resolve:** Decide with the owner at #step-6 once [Q03] evidence is in. Default if unreachable: hide with notice, note the follow-on in [#roadmap].

**Resolution:** DECIDED — **hide with notice** (the plan's stated default,
taken on the [Q03] evidence: upstream refuses `/btw` headless outright, so
the only native path is a from-scratch Tug-side query channel — recorded as
a follow-on in [#roadmap]). #step-11 takes branch B.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Resume-scheduler bug persists on 2.1.204 | med | med | Honest-surface durability ([P04]); re-arm affordance | Upstream changelog notes a fix |
| Goal continuation turns confuse turn accounting / phases | high | med | Probe-first (#step-3); reuse wake bracket if shapes match; app-test the lifecycle | Any Z1 phase misrender in testing |
| `/btw` unusable headless | low | med | [Q03]/[Q04] gate; hide-with-notice fallback costs one line | Upstream adds SDK side-question support |
| Z2 relayout regressions (widths, collapse order, focus order) | med | med | One cell replaces two (net simpler); keep [D102]'s collapse-order doctrine; app-test the bar | Container-query collapse misbehaves |
| `capture-capabilities` re-baseline breaks fixture consumers | med | high (expected) | The recipe prints a catalog diff; #step-2 budgets for consumer updates | — |

**Risk R01: Goal turns arrive with no user submit and break the busy/idle model** {#r01-goal-turn-lifecycle}

- **Risk:** An evaluator-forced turn between `result` events could strand `ActiveTurn` state, mislabel Z1 phases, or leave the prompt entry wrongly disabled.
- **Mitigation:** #step-3 captures the exact shape before any plumbing; #step-8 extends whichever existing path (wake bracket / assistant opener) matches; the integration checkpoint (#step-15) drives a real goal end-to-end.
- **Residual risk:** Future claude versions may change the continuation shape; the pinned fixtures make the drift detectable.

**Risk R02: Silent loop death on respawn erodes trust** {#r02-loop-death}

- **Risk:** tugcode respawns claude for routine reasons; a live loop dying invisibly is worse than no loop support.
- **Mitigation:** #step-9 makes death visible (stale-mark to `stopped`, mirroring [D102]'s `session_init` stale-marking) and recovery one click (re-arm).
- **Residual risk:** Re-arm re-sends the loop prompt as a fresh command — interval phase resets; acceptable and disclosed in the row.

---

### Design Decisions {#design-decisions}

#### [P01] `/goal` and `/loop` are pass-throughs; Tug adds plumbing and legibility, never command logic (DECIDED) {#p01-passthrough-not-reimpl}

**Decision:** Both commands leave `HIDDEN_SLASH_COMMANDS` and become plain pass-throughs. Tug does not parse conditions, schedule timers, or evaluate goals; it renders and manages what claude does.

**Rationale:**
- The evaluator (a session-scoped prompt-based Stop hook, Haiku by default) and the scheduler (`CronCreate`/`ScheduleWakeup` harness timers) live inside claude; duplicating either creates drift.
- tugcode is architecturally a verbatim forwarder (`SessionManager.handleUserMessage` writes user content straight to claude stdin); keeping it that way is the standing contract.

**Implications:**
- All Tug-side goal/loop state is *derived from observation* (tool calls, wake frames, command stdout), never authored.
- Stopping a loop/goal goes through claude (`/goal clear`; the wake plan's [D12] hidden-user-message cancellation transport for scheduled work), not a local kill.

#### [P02] Unify the surface, not the storage (DECIDED) {#p02-surface-not-storage}

**Decision:** TASKS remains a derived, turn-scoped fold over transcript tool calls (`select-task-list.ts` + `useTaskListState`); JOBS remains the session-lifetime ledger in `CodeSessionSnapshot.jobs` fed by `task_started`/`task_updated` frames ([D102]). A `WorkItem` view-model (Spec S02) projects both — plus goal and scheduled-work state — into one cell and popover.

**Rationale:**
- Owner directive: "This is about UI, not storage."
- The storage divergences are intentional semantics ([D100] idle demotion vs [D102] no-idle-demotion), not accidents.

**Implications:**
- The view-model layer is pure projection — no new persistence, no migration.
- Per-group semantics (idle demotion for the checklist group only) are preserved inside one cell's pose function.

#### [P03] The unified cell is named `WORK`; the deck vocabulary is `WorkItem` (DECIDED) {#p03-work-naming}

**Decision:** One Z2 cell labeled `WORK` replaces the TASKS and JOBS cells. Deck-side code uses the `WorkItem` vocabulary for the projected rows.

**Rationale:**
- Fits the Z2 register of plain uppercase nouns (STATE · TIME · TOKENS · CONTEXT).
- Honest for every kind: checklist items, background shells, agents, monitors, wakeups, crons, goals, loops. `BACKGROUND` is too long and false for goals/loops (they drive foreground turns); `TRACKER` names the UI, not the content.
- Resolves the standing three-way naming hazard (`task_*` wire frames = jobs; `Task*` tools = todos; see the terminology guard at the top of `select-jobs.ts`) with a fourth, deliberately distinct term.

**Implications:**
- [D100]/[D102]'s *cell-layout* aspects are superseded (recorded in #step-14); their storage/grammar doctrine stands.
- Width: the 14ch JOBS + TASKS footprint collapses to one cell; #step-12 re-tunes `data-priority` widths and the container-query collapse order.

#### [P04] Durability is honest-surface-first (DECIDED) {#p04-honest-surface}

**Decision:** If [Q02] confirms scheduled work still dies on respawn/resume, tugcode/tugdeck make the death visible (rows flip to `stopped` on `session_init`, matching [D102]'s stale-marking) and recovery cheap (a re-arm affordance that re-sends the originating loop command), rather than building a tugcode-owned timer that impersonates the harness scheduler.

**Rationale:**
- A tugcode-owned re-injection timer is a large commitment (persistence, clock discipline, double-fire hazards when upstream fixes the bug).
- The wake plan's [D10] sidecar-JSONL persistence pattern is available if escalation is ever needed — but visibly-stopped-plus-one-click beats silently-wrong today.

**Implications:**
- Re-arm resets interval phase (disclosed in the row).
- If upstream has fixed the bug, #step-9 shrinks to a verification + fixture pin.

#### [P05] Goal state is a small session-lifetime store field; loops ride the existing scheduled-work rows (DECIDED) {#p05-goal-loop-state}

**Decision:** Loops need no new store: `/loop`'s `ScheduleWakeup`/`CronCreate` calls already fold into scheduled rows via `select-scheduled-work.ts` (kinds `wakeup`/`cron`); #step-10 adds loop-aware labeling. Goals get one new snapshot field (`CodeSessionSnapshot.goal`, Spec S04) reduced from whatever wire markers [Q01] surfaces plus `/goal` command output — session-lifetime like jobs, because a goal spans turns.

**Rationale:**
- Reuse over invention; the scheduled-work selector was built for exactly these tool calls.
- A goal is one-per-session and tiny — a field, not a ledger.

**Implications:**
- New reducer handling + `useSyncExternalStore` selector ([L02]); replay must not resurrect an achieved goal (same discipline as [D102]'s replay-never-populates rule).

#### [P06] A native `/btw` surface is overlay-only — never transcript ink (DECIDED, contingent on [Q03]) {#p06-btw-overlay}

**Decision:** If `/btw` works over the bridge, it becomes a `supported-local` command whose surface is a Dev-card side-question panel (popover/sheet). The question and answer never paint into the transcript, matching upstream's "never enters the conversation history."

**Rationale:**
- Rendering an ephemeral exchange as transcript ink would contradict its defining property and pollute replay expectations.
- The Dev card is arguably a *better* home for this than a terminal overlay: earlier side questions list naturally, copy is native.

**Implications:**
- Side-question state lives in a deck store (session-scoped, ephemeral — no tugbank persistence, no localStorage); mid-turn submission needs the prompt entry to allow `/btw` while busy (a scoped exception, not a general unlock).

#### [P07] No unhide without a current-CLI capture (DECIDED) {#p07-probe-discipline}

**Decision:** Moving any command out of `HIDDEN_SLASH_COMMANDS` requires a probe capture on the CLI version in `capabilities/LATEST`, pinned as a fixture or probe artifact in-repo. This becomes doctrine in `tuglaws/slash-commands.md`.

**Rationale:**
- `/btw`'s accidental pass-through shows the failure mode of guessing; the 2.1.150→2.1.204 fixture gap shows how fast the ground moves.

**Implications:**
- #step-2 (re-baseline) gates all probe steps; the doctrine doc records the rule for future commands.

#### [P08] `/tasks` and `/bashes` become local commands that open the WORK popover (DECIDED) {#p08-tasks-local}

**Decision:** Move `tasks` and `bashes` from `HIDDEN_SLASH_COMMANDS` to `LOCAL_SLASH_COMMANDS`, with a surface that opens the WORK cell's popover — the same pattern as `/context` opening the CONTEXT popover via `statusRowRef`.

**Rationale:**
- Upstream `/tasks` shows running shells and subagents; the WORK popover *is* that view in Tug. A command that used to be swallowed becomes an affordance for free.

**Implications:**
- Two entries in the registry + two lines in the compile-enforced `slashCommandSurfaces` map; the mirror doc's hidden list shrinks.

---

### Deep Dives {#deep-dives}

#### The three commands, as upstream defines them (2.1.204 docs) {#upstream-behavior}

**`/goal [condition|clear]`** (requires ≥ 2.1.139): sets a session-scoped completion condition. Setting starts a turn immediately with the condition as directive. After each turn, the configured small fast model (default Haiku) — a wrapper around a session-scoped prompt-based **Stop hook** — judges the condition against the conversation and returns yes/no + a short reason; "no" starts another turn with the reason as guidance. One goal per session; condition ≤ 4,000 chars. `/goal` bare shows status (condition, elapsed, turns evaluated, token spend, latest reason); `clear`/`stop`/`off`/`reset`/`none`/`cancel` clears; `/clear` also clears. Active goals are restored on `--resume`/`--continue` (counters reset). Works in non-interactive mode. **Requires workspace trust accepted and hooks enabled** (`disableAllHooks` unset, no `allowManagedHooksOnly`) — otherwise the command explains why it can't run.

**`/loop [interval] [prompt]`** (bundled skill, alias `/proactive`): re-runs a prompt while the session stays open. Interval mode paces via `CronCreate` (`{cron, prompt, durable?, recurring?}`, 5-field cron, returns a job id, 7-day auto-expire for recurring); self-paced mode via `ScheduleWakeup` (`{delaySeconds, reason, prompt}`, fire-once, no id, harness-owned; ends via `{stop: true}`). Omitting the prompt runs a maintenance check or `.claude/loop.md` where available.

**`/btw <question>`**: an ephemeral side question with full conversation visibility but **no tools**, answered off the parent prompt cache, rendered in a dismissible overlay, never entering conversation history; usable while a turn is running; single response (no follow-ups); the TUI offers copy (`c`), fork-into-session (`f`), and a dimmed history of earlier side questions. Headless behavior: **undocumented** ([Q03]).

#### How slash commands flow through Tug today {#slash-flow}

Three tiers, decided entirely client-side at submit time (`tugdeck/src/components/tugways/tug-prompt-entry.tsx`, `performSubmit`):

1. **`supported-local`** — `matchLocalSlashCommand()` hits `LOCAL_SLASH_COMMANDS` (`tugdeck/src/lib/slash-commands.ts`, ~21 entries) → dispatch `RUN_SLASH_COMMAND`; `slashCommandSurfaces` in `dev-card.tsx` (a compile-enforced `Record<LocalCommandName, …>`) opens the surface. Never sent to claude.
2. **`hidden`** — `HIDDEN_SLASH_COMMANDS` (`tugdeck/src/lib/slash-supported.ts`) → `SHOW_SLASH_COMMAND_NOTICE`, swallowed. `goal` and `loop` sit here today under "Conversation-structure / automation deferred to a future plan."
3. **`pass-through`** — everything else; sent verbatim. `isUnknownRemoteCommand()` alerts on genuine unknowns once the catalog is populated.

tugcode is a verbatim forwarder: `SessionManager.handleUserMessage` (`tugcode/src/session.ts`) writes user content straight to claude stdin; no slash parsing, no tool allowlist. It supplies the catalog two ways: the turn-free `session_capabilities` handshake (`buildSessionCapabilities()` in `tugcode/src/capabilities.ts`, plugin-augmented via `enumeratePluginCommands`/`mergePluginCommands`) and post-turn `system_metadata.slash_commands`. Command output returns as `<local-command-stdout>` scaffolding, which tugcode synthesizes into assistant text (`session.ts` stdout-synthesis; `replay.ts` `COMMAND_SCAFFOLDING_PREFIXES`) and tugdeck renders as command atoms (`tugdeck/src/lib/command-atom.ts`).

The popup merges local + remote catalogs in `tugdeck/src/components/tugways/cards/completion-providers/local-commands.ts` (`mergeCommandProviders`, `filterCommandProvider` drops the hidden tier). Unhiding a catalogued command therefore makes it appear in the popup with **zero popup plumbing**.

#### Wake mechanics (the substrate for loop — and possibly goal — turns) {#wake-mechanics}

tugcode already brackets turns that start without a user submit, in two cohorts (both in `tugcode/src/session.ts`; decisions in `dash/archive/tugplan-tide-session-wake.md`):

- **Cohort A** — an inter-turn `system/task_notification` (fired by deferred-completion tools: `Monitor`, `CronCreate`, `ScheduleWakeup`, `PushNotification`, `RemoteTrigger`, `TaskOutput`; typed in `tugcode/src/protocol-types.ts`) → `handleTaskNotification` builds a `wake_started` IPC frame (`buildWakeStartedMessage`), sets `isInWake`, opens a fresh `ActiveTurn`.
- **Cohort B** — the harness scheduler fires a timer and re-brackets with a fresh `system/init`; `handleClaudeLine` distinguishes a between-turn re-init (`activeTurn === null` → wake, per wake-plan [D05] `#d05-reinit-detector`) from a mid-turn compact re-init; synthesizes `wake_started` with `summary: "scheduled wake"`.
- Bracket close is implicit: the wake turn's terminal `result` clears `activeTurn`/`isInWake`; the deck maps `waking → idle` on `turn_complete`. Deck-side, wake turns are `origin: "assistant"` pending turns (Z1C shows "Waking…"), and `select-scheduled-work.ts` folds `ScheduleWakeup`/`CronCreate` tool calls into `scheduled` JOBS rows with fire-time reconciliation.

Parked-but-designed pieces this plan revives: per-session FIFO trigger correlation (wake-plan [D08] `#d08-cohort-b-fifo`), the trigger chip above the assistant row ([D09] `#d09-chrome-visual-class`), sidecar-JSONL trigger persistence ([D10] `#d10-sidecar-jsonl`), and the hidden-user-message cancellation transport ([D12] `#d12-cancellation-hidden-user-message`).

#### The resume-scheduler finding (May 2026) {#resume-finding}

`tugcode/probes/wake-investigation/probe-resume.mjs` (run 2026-05-25 on claude 2.1.150, sessions f9977732/a2b0737b; finding in `dash/archive/wake-investigation-findings.md`): in stream-json mode, `--resume` restores scheduled-task *metadata* (the resumed claude can describe the pending wakeup) but the in-process scheduler **never fires it** — "FAIL: no wake_started observed." This contradicts the published scheduled-tasks docs, which don't carve out stream-json mode. Compounding: tugcode respawns claude on model/effort change, add-dir, fork, Developer ▸ Reload, and app restart — each would silently kill a live loop. [Q02] retests on 2.1.204.

#### Fixture baseline and `just capture-capabilities` {#capture-capabilities}

`capabilities/LATEST` currently reads **2.1.197** (dirs: 2.1.105 … 2.1.197); the stream-json catalog fixtures for jobs date to `v2.1.173-jobs-spike`. The `justfile` recipe `capture-capabilities`: refuses on a dirty `tugplug/` tree (the capture spawns claude with `--plugin-dir tugplug`, so uncommitted skill changes would bake into the golden — override `TUG_ALLOW_DIRTY_TUGPLUG=1`); runs `cargo nextest run -p tugcast --features real-claude-tests --run-ignored only --no-capture capture_all_probes` with `TUG_REAL_CLAUDE=1` (≈2–3 min at `TUG_STABILITY=1`); writes `capabilities/<version>/`, updates `LATEST`, and prints a file-stat diff of the stream-json catalog against the previous baseline. Known consumer to re-verify: `tugdeck/src/__tests__/system-metadata-fixture.test.ts`; [D101]'s governance test also pins the canonical tool set and will surface any new tools in 2.1.204.

---

### Specification {#specification}

**Spec S01: `tuglaws/slash-commands.md` contents** {#s01-doctrine-doc}

The doctrine doc must cover, standalone (absorbing `dash/slash-commands-investigations.md`, which is then deleted):

1. **The three-tier model** — `supported-local` / `pass-through` / `hidden`; tugdeck as sole interceptor; tugcode as verbatim forwarder; the submit-path dispatch order.
2. **Catalog sources** — turn-free `session_capabilities` handshake vs post-turn `system_metadata.slash_commands`; the plugin-augmentation rationale (claude's `initialize` answers before `--plugin-dir` loads); namespace resolution (`resolveRemoteCommand`, bare `/devise` → `tugplug:devise`).
3. **The decision procedure** for mapping an existing Claude Code command: pass through (expands to a prompt / runs turns — default), give a local surface (Tug has or should have a graphical equivalent), or hide with notice (terminal-only UI, host concern, or deferred feature) — with the criteria and one worked example of each.
4. **Mechanical recipes** — add to `LOCAL_SLASH_COMMANDS` + wire `slashCommandSurfaces` (compile-enforced); add to `HIDDEN_SLASH_COMMANDS` + mirror in `dev-card-unsupported-slash-commands.md`; author a new tugplug skill for a genuinely new command.
5. **Output flow-back** — the `<command-name>`/`<command-message>`/`<command-args>`/`<local-command-stdout>` scaffolding; tugcode stdout synthesis; replay stripping; command atoms.
6. **The probe-and-fixture discipline** ([P07]) — no unhide without a current-`LATEST` capture; where probes and fixtures live.
7. **Pointers** — `dev-card-unsupported-slash-commands.md` as the maintained hidden-list mirror; the AskUserQuestion shape note stays in `CLAUDE.md`.

**Spec S02: `WorkItem` view-model** {#s02-workitem}

A pure projection type in a new `tugdeck/src/lib/code-session-store/select-work.ts`:

```ts
type WorkKind = "task" | "bash" | "agent" | "monitor" | "wakeup" | "cron" | "goal";
type WorkGroup = "active" | "scheduled" | "checklist" | "finished";
interface WorkItem {
  readonly key: string;            // stable per-source id (taskId / jobId / "goal")
  readonly kind: WorkKind;
  readonly group: WorkGroup;       // derived, drives popover grouping
  readonly label: string;          // description / subject / goal condition
  readonly status: string;         // source-native status, untranslated
  readonly detail?: string;        // evaluator reason / schedule label / activeForm
  readonly startedAtMs?: number;
  readonly endedAtMs?: number;
  readonly firesAtMs?: number;
  readonly actions: readonly WorkAction[]; // "stop" | "cancel" | "rearm" | "clear-goal"
  readonly turnAnchor?: string;    // #a{turn} scroll link, where the source has one
}
```

Projection sources (no storage changes, [P02]): `TaskListState` (via the existing `reduceTaskListState`/`useTaskListState` logic) → `checklist` rows; `CodeSessionSnapshot.jobs` → `active`/`scheduled`/`finished` rows (kinds `bash`/`agent`/`monitor`/`wakeup`/`cron`); `CodeSessionSnapshot.goal` (Spec S04) → one `active` (or `finished`) `goal` row. Loop-born scheduled rows carry a loop-aware `detail` (#step-10).

**Spec S03: WORK cell + popover grammar** {#s03-work-cell}

- **Cell:** one `TugStatusCell` labeled `WORK`, `data-priority="work"`. Label composes the live counts: running jobs + active goal dominate; falls back to checklist `completed/total`; dimmed `None` when everything is empty. Pose (a pure function over both snapshots): any running job or active goal → `running`; else any failed job → `aborted` (holds until cleared, per [D102]); else checklist semantics with [D100]'s idle demotion applied **to the checklist contribution only** — a running background job or live goal never idle-demotes ([D102]'s divergence preserved inside the merged pose).
- **Popover:** `WorkPopoverContent`, grouped **Active** (running jobs, live goal with latest evaluator reason, live loop), **Scheduled** (wakeups/crons with fire-time badges), **Checklist** (task rows, exactly the current `TasksPopoverContent` rows), **Finished**. Groups render only when non-empty. Per-row actions by kind: stop (running jobs → existing `CodeSessionStore.stopJob`), cancel (crons → existing `cancelScheduledWork`), re-arm (stopped loop rows, #step-9), clear goal (→ sends `/goal clear`, [P01]). Footer: the merged summary + the existing Clear (terminal job rows only) + copy.
- **Layout:** TASKS and JOBS cells are removed; freed width returns to TIME/TOKENS (which [D102] narrowed 16ch→12ch to pay for JOBS). Collapse order becomes TIME → TOKENS → WORK (live signal collapses last). Focus order (`cellOrder`) drops from 6 to 5 cells.

**Spec S04: Goal snapshot state** {#s04-goal-state}

```ts
interface GoalState {
  readonly condition: string;
  readonly status: "active" | "achieved" | "cleared";
  readonly setAtMs: number;
  readonly turnsEvaluated: number;
  readonly latestReason?: string;   // evaluator's most recent explanation
}
// CodeSessionSnapshot.goal: GoalState | null
```

Reduction sources (finalized at #step-6 from the [Q01] captures): **set** — the
`<command-name>/goal</command-name>` envelope user event (condition in
`<command-args>`); **active + latestReason** — each `isSynthetic` Stop-hook-feedback
user event (reason = text after `]: `), surfaced to the deck via the #step-8 IPC
frame; **achieved** — the goal cycle's terminal `result` landing with no
subsequent feedback; **cleared** — the `/goal clear` acknowledgment (plain user
text + assistant stand-down; note residual feedback events may trail a clear by
a round or two). There is no dedicated goal-state wire event and nothing rides
`<local-command-stdout>`. Rules: replay never resurrects an `active` goal (an
achieved/cleared goal may render as `finished` history); after a respawn/resume
a previously-active goal is **possibly-active** ([Q02]: work continues after
resume; evaluator re-arm unconfirmed) — keep it `active` rather than clearing,
and let the next observed signal settle it.

#### State Zone Mapping (tugdeck/tugways plans) {#state-zone-mapping}

| State | Zone (appearance / local-data / structure) | Mechanism | Law |
|-------|--------------------------------------------|-----------|-----|
| `CodeSessionSnapshot.goal` | local-data (session store) | reducer field + `useSyncExternalStore` selector (`useGoalState`) | [L02] |
| `WorkItem[]` projection | derived | pure selector over snapshots; no stored copy | [L02] |
| WORK cell pose/label | appearance | pure function → `data-*` attrs + CSS | [L06] |
| WORK popover visibility | local-data (component) | existing `TugStatusCell` popover mechanics | — |
| Side-question exchanges (`/btw`, if native) | local-data (session store, ephemeral) | deck store + `useSyncExternalStore`; no persistence | [L02] |
| Loop trigger chip content | local-data | wake-plan [D08] FIFO drained into turn model | [L02] |
| Re-arm button width stability | appearance | reserve wider state width (widthStabilize pattern) | [L06] |

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tuglaws/slash-commands.md` | The slash-command doctrine (Spec S01) |
| `tugcode/probes/goal-loop/probe-goal.mjs` | `/goal` lifecycle probe (#step-3) |
| `tugcode/probes/goal-loop/probe-loop.mjs` | `/loop` both-modes probe (#step-4) |
| `tugcode/probes/goal-loop/probe-btw.mjs` | `/btw` headless probe (#step-5) |
| `tugcode/probes/goal-loop/FINDINGS.md` | Probe findings, referenced by #step-6 resolutions |
| `tugdeck/src/lib/code-session-store/select-work.ts` | `WorkItem`/`WorkKind`/`WorkGroup`, projection selectors, pose + summary functions (Spec S02, S03) |
| `tugdeck/src/lib/code-session-store/hooks/use-work-state.ts` | `useWorkState` snapshot selector |
| `tugdeck/src/lib/code-session-store/select-goal.ts` | `GoalState` narrowers + reducer helpers (Spec S04) |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `HIDDEN_SLASH_COMMANDS` | const set | `tugdeck/src/lib/slash-supported.ts` | remove `goal`, `loop`, `tasks`, `bashes`; add `proactive` removal check (not currently listed — verify); add `btw` iff [Q04] lands on hide |
| `LOCAL_SLASH_COMMANDS` | const array | `tugdeck/src/lib/slash-commands.ts` | add `tasks` (+`bashes` alias handling), and `btw` iff native ([P06]/[P08]) |
| `slashCommandSurfaces` | record | `tugdeck/src/components/tugways/cards/dev-card.tsx` | wire `tasks` → open WORK popover; `btw` → side-question panel (conditional) |
| `CodeSessionSnapshot.goal` | field | `tugdeck/src/lib/code-session-store/reducer.ts` | init `null`; reducer cases per [Q01] evidence |
| `GoalState` | interface | `select-goal.ts` | Spec S04 |
| `WorkItem`, `selectWorkItems`, `workCellPose`, `composeWorkSummary` | types/fns | `select-work.ts` | Spec S02/S03 |
| `WorkPopoverContent` | component | `tugdeck/src/components/tugways/cards/dev-card-telemetry-popovers.tsx` | replaces `TasksPopoverContent` + `JobsPopoverContent` composition (their row internals are reused) |
| `DevTelemetryStatusRow` | component | `tugdeck/src/components/tugways/cards/dev-card-telemetry-renderers.tsx` | 6 cells → 5; WORK cell; `cellOrder` update; width CSS |
| `DevTelemetryStatusRowHandle.openWorkPopover` | method | `tugdeck/src/components/tugways/cards/dev-card-telemetry-renderers.tsx` | new imperative-open method beside the existing `openContextPopover()`; the `/tasks` surface (#step-13) calls it via `statusRowRef` |
| `wake_started` trigger fold | logic | `tugcode/src/session.ts` | extend per [Q01] (goal continuation bracket) and #step-10 (trigger chip payloads via [D08] FIFO) |
| `clearGoal` | method | `tugdeck/src/lib/code-session-store.ts` | sends `/goal clear` as a user message ([P01]) |

---

### Documentation Plan {#documentation-plan}

- [ ] `tuglaws/slash-commands.md` (new; Spec S01).
- [ ] `tuglaws/dev-card-unsupported-slash-commands.md` — shrink hidden list (goal, loop, tasks, bashes out; btw disposition recorded); point at the new doctrine doc; fix its stale claim that "[D14] is in design-decisions.md" (that label is plan-local to the original slash-commands plan).
- [ ] `tuglaws/design-decisions.md` — new global decision for the WORK cell superseding the cell-layout aspects of [D100]/[D102]; note in each.
- [ ] Delete `dash/slash-commands-investigations.md` once absorbed.
- [ ] `tuglaws/INDEX.md` entry for the new doc.

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit** | classifier tiers, `WorkItem` projection, pose functions, goal narrowers, command-line canonicalization | pure logic in `select-work.ts`, `select-goal.ts`, `slash-supported.ts` |
| **Integration** | tugcode goal-turn bracketing against captured wire lines | `tugcode` tests in the style of `wake-reinit.test.ts` |
| **Golden / Contract** | pinned probe captures + `capabilities/2.1.204` fixtures; `system-metadata-fixture.test.ts`; [D101] governance test | every capture step |
| **App-test (real app)** | Z2 WORK cell renders/acts; respawn marks loop stopped; real-claude tier drives a live short goal and loop | `just app-test`; real-claude tests on-demand only |

#### What stays out of tests {#test-non-goals}

- jsdom render tests and mock-store assertion tests — banned patterns; behavior is proven in the real app via app-tests.
- The claude-side evaluator/scheduler logic itself — upstream's; we pin its *wire shape* (fixtures), not its behavior.
- `/btw` fork-into-session — out of scope.
- Timing-sensitive assertions on live loop intervals beyond one fire — flaky by construction; one observed wake bracket suffices.

---

### Execution Steps {#execution-steps}

> **Commit after all checkpoints pass.** This rule applies to every step below.

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Write `tuglaws/slash-commands.md` | done | 796ff7b11 |
| #step-2 | Re-baseline capabilities to 2.1.204 | done | c54b01fe9 |
| #step-3 | Probe `/goal` lifecycle | done | cb42b4f50 |
| #step-4 | Probe `/loop` + resume retest | done | ebbb90561 |
| #step-5 | Probe `/btw` headless | done | ebbb90561 (folded into #step-4's commit) |
| #step-6 | Decision gate: resolve Q01–Q04 in this plan | done | f71ed423f + 79a4e1af0 |
| #step-7 | Unhide `goal` / `loop` / `proactive` | done | 863546ede |
| #step-8 | Goal-turn lifecycle plumbing | done | 671a2de6a |
| #step-9 | Loop/goal durability (honest surface) | done | 274d0bbdc + 836a3345e |
| #step-10 | Loop legibility: trigger chips + stop | done | f2cb46625 |
| #step-11 | `/btw` disposition | done | 32419e57f |
| #step-12 | WORK view-model, cell, popover | done | bd5fc8cb0 |
| #step-13 | `/tasks` + `/bashes` local commands | done | 7883dcc19 |
| #step-14 | Docs + design-decisions sync | done | 8467ada6c |
| #step-15 | Integration checkpoint | done | N/A (verification only; live real-claude goal/loop runs deferred to the debug-build vet) |

#### Step 1: Write `tuglaws/slash-commands.md` {#step-1}

**Commit:** `docs(tuglaws): add slash-commands doctrine; absorb roadmap investigations`

**References:** Spec S01, [P07] probe discipline, (#slash-flow, #upstream-behavior, #documentation-plan)

**Artifacts:**
- `tuglaws/slash-commands.md` per Spec S01.
- `tuglaws/dev-card-unsupported-slash-commands.md` reframed as the hidden-list mirror, linking to the doctrine doc; stale `[D14]` attribution fixed.
- `dash/slash-commands-investigations.md` deleted; `tuglaws/INDEX.md` updated.

**Tasks:**
- [ ] Author the doc against Spec S01's seven-point checklist, transcribing the mechanics in (#slash-flow) — file paths and symbol names included, no line numbers.
- [ ] Verify every named symbol still exists (`classifySlashCommand`, `mergeCommandProviders`, `COMMAND_SCAFFOLDING_PREFIXES`, `enumeratePluginCommands`, …) before citing it.
- [ ] Reframe the mirror doc; delete the roadmap dropfile; update INDEX.

**Tests:**
- [ ] N/A (docs only) — but run the existing classifier tests to confirm no code drifted while writing: `cd tugdeck && bun test slash`.

**Checkpoint:**
- [ ] Doc answers all seven Spec S01 points on a cold read; every cited symbol greps clean.

---

#### Step 2: Re-baseline capabilities to 2.1.204 {#step-2}

**Commit:** `chore(capabilities): re-baseline to claude 2.1.204 via capture-capabilities`

**References:** [P07] probe discipline, (#capture-capabilities), Risk table row 5

**Artifacts:**
- `capabilities/2.1.204/` + updated `LATEST` (was 2.1.197).
- Updated stream-json catalog fixtures and any consumer-test adjustments.

**Tasks:**
- [ ] Confirm `tugplug/` is clean (`git status --porcelain -- tugplug`), then run `just capture-capabilities`.
- [ ] Review the printed catalog diff (2.1.197 → 2.1.204); note new commands/tools relevant to this plan (`goal`, `loop`, `btw`, aliases) in the commit message.
- [ ] Fix any fixture-consumer breakage: `tugdeck/src/__tests__/system-metadata-fixture.test.ts`, the [D101] governance test (new 2.1.204 tools must be classified in `dev-tool-visibility-policy.ts`), and anything else the suites surface.

**Tests:**
- [ ] `cd tugrust && cargo nextest run -p tugcast`
- [ ] `cd tugdeck && bun test`

**Checkpoint:**
- [ ] `cat capabilities/LATEST` → `2.1.204`; both suites green.

---

#### Step 3: Probe `/goal` lifecycle {#step-3}

**Depends on:** #step-2

**Commit:** `probe(goal): capture /goal lifecycle over stream-json on 2.1.204`

**References:** [Q01] goal wire shape, [P07], (#upstream-behavior, #wake-mechanics)

**Artifacts:**
- `tugcode/probes/goal-loop/probe-goal.mjs` + timestamped captures (probe style of `tugcode/probes/wake-investigation/`).
- Findings section in `tugcode/probes/goal-loop/FINDINGS.md`.

**Tasks:**
- [ ] Drive through real tugcode (or claude directly with tugcode's exact spawn args from `buildClaudeArgs`): set a small achievable goal (e.g. "a file named DONE exists in the cwd; prove with ls"), let the evaluator force ≥1 continuation turn, reach achieved.
- [ ] Capture: the continuation-turn boundary shape (re-init? bare turn? new event?), where the evaluator's reason appears, `/goal` bare status output, `/goal clear` output, achieved marker.
- [ ] Verify trust/hooks preconditions hold in tugcode's spawn config (goal must not refuse).
- [ ] Record answers to [Q01] in FINDINGS.md.

**Tests:**
- [ ] N/A (probe artifacts are the deliverable).

**Checkpoint:**
- [ ] Captures show a full set → continuation → achieved cycle; FINDINGS.md states the continuation-turn shape unambiguously.

---

#### Step 4: Probe `/loop` + resume retest {#step-4}

**Depends on:** #step-2

**Commit:** `probe(loop): capture /loop modes and retest resume scheduler on 2.1.204`

**References:** [Q02] resume scheduler, [P07], (#resume-finding, #wake-mechanics)

**Artifacts:**
- `tugcode/probes/goal-loop/probe-loop.mjs` + captures for interval mode (`/loop 2m …`) and self-paced (`/loop …`).
- Re-run results of `tugcode/probes/wake-investigation/probe-resume.mjs`, plus a goal-resume variant.
- FINDINGS.md sections for both.

**Tasks:**
- [ ] Confirm which tool each mode fires on 2.1.204 (expected: interval → `CronCreate`, self-paced → `ScheduleWakeup`) and that wake brackets land per wake-plan [D05] (`dash/archive/tugplan-tide-session-wake.md#d05-reinit-detector`).
- [ ] Re-run the resume probe; record PASS/FAIL for scheduled-work firing after `--resume` in stream-json mode.
- [ ] Test goal-across-resume: set a goal, end the session, `--resume`, observe whether the evaluator re-arms.
- [ ] Record answers to [Q02] in FINDINGS.md.

**Tests:**
- [ ] Existing wake tests still green: `cd tugcode && bun test wake`.

**Checkpoint:**
- [ ] FINDINGS.md states, with capture evidence: tool-per-mode, wake-bracket conformance, resume PASS/FAIL for loops and goals.

---

#### Step 5: Probe `/btw` headless {#step-5}

**Depends on:** #step-2

**Commit:** `probe(btw): capture /btw behavior over stream-json on 2.1.204`

**References:** [Q03] btw headless, [P07], (#upstream-behavior)

**Artifacts:**
- `tugcode/probes/goal-loop/probe-btw.mjs` + captures; FINDINGS.md section.

**Tasks:**
- [ ] In a session with prior context, send `/btw <question about that context>` through the bridge; capture the full stream. Repeat mid-turn if feasible.
- [ ] Inspect the session JSONL afterward: did the exchange enter history?
- [ ] Record answers to [Q03] in FINDINGS.md: works/fails, channel, contamination.

**Tests:**
- [ ] N/A.

**Checkpoint:**
- [ ] FINDINGS.md states unambiguously whether `/btw` is bridge-viable and on what channel the answer arrives.

---

#### Step 6: Decision gate — resolve Q01–Q04 in this plan {#step-6}

**Depends on:** #step-3, #step-4, #step-5

**Commit:** `plan(slash-command): resolve open questions from 2.1.204 probe findings`

**References:** [Q01] [Q02] [Q03] [Q04], [P04] honest surface, [P06] btw overlay, Spec S04, (#open-questions)

**Artifacts:**
- This document updated: each Q resolution flipped to DECIDED/DEFERRED with a pointer into `tugcode/probes/goal-loop/FINDINGS.md`; Spec S04 finalized; #step-8/#step-9/#step-11 task lists tightened to the chosen branches.

**Tasks:**
- [ ] Write the four resolutions; where [Q04] needs an owner call (hide vs Tug-side `/btw`), present the evidence and get the decision before proceeding.
- [ ] Adjust downstream step scopes (e.g. #step-9 shrinks to verification if [Q02] came back fixed).

**Tests:**
- [ ] N/A.

**Checkpoint:**
- [ ] No `(OPEN)` markers remain in this plan's Open Questions section.

---

#### Step 7: Unhide `goal` / `loop` / `proactive` {#step-7}

**Depends on:** #step-6

**Commit:** `feat(slash): unhide /goal and /loop (alias /proactive) as pass-throughs`

**References:** [P01] pass-through, [P07], Spec S01, (#slash-flow)

**Artifacts:**
- `goal`, `loop` removed from `HIDDEN_SLASH_COMMANDS` in `tugdeck/src/lib/slash-supported.ts` (verify `proactive` isn't separately listed; the catalog's alias handling covers it via `resolveRemoteCommand`).
- Mirror doc updated (its "Conversation-structure / automation" section shrinks).
- Classifier tests updated.

**Tasks:**
- [ ] Edit the set; update the group comment (the remaining deferred names keep their marker role).
- [ ] Update `tuglaws/dev-card-unsupported-slash-commands.md` and cross-check the doctrine doc's worked examples.
- [ ] Extend the classifier unit tests: `goal`/`loop` now classify `pass-through`; popup merge shows them (they're in the 2.1.204 catalog fixture).

**Tests:**
- [ ] `cd tugdeck && bun test slash`

**Checkpoint:**
- [ ] `cd tugdeck && bun test` green; `bunx vite build` passes; typing `/goal` in a live card reaches claude (manual or app-test smoke).

---

#### Step 8: Goal-turn lifecycle plumbing {#step-8}

**Depends on:** #step-6, #step-7

**Commit:** `feat(tugcode+tugdeck): bracket /goal continuation turns; track goal state`

**References:** [Q01] resolution, [P05] goal state, Spec S04, Risk R01, (#wake-mechanics, #state-zone-mapping)

**Artifacts (rescoped at #step-6 — [Q01]: no new bracketing; a goal run is one result cycle):**
- tugcode: (a) exclude `isSynthetic` user events from the rewind prompt-anchor latch in the `case "user"` mapping in `tugcode/src/session.ts` — today the feedback event passes `isSubmissionEcho` (it carries a non-`tool_result` text block) and would overwrite the anchor mid-run; (b) map each Stop-hook-feedback event to a new `goal_feedback` IPC frame carrying the condition and the evaluator's reason (parsed from the `Stop hook feedback:\n[<condition>]: <reason>` text) so the deck can track goal state live. Integration test pinned against the #step-3 capture lines (style of `wake-reinit.test.ts`).
- tugdeck: `CodeSessionSnapshot.goal` (Spec S04) + `select-goal.ts` + `useGoalState`; reducer cases for the goal envelope (set), `goal_feedback` (active + latest reason), cycle result (achieved), clear acknowledgment (cleared); `CodeSessionStore.clearGoal()` sending `/goal clear`.
- Replay: classify `isSynthetic` JSONL user entries so Stop-hook feedback never renders as user prose on replay/reload.
- Z1 phases need no new states (one long turn); interrupt is the normal turn interrupt; prompt entry queues mid-run submissions as it does for any in-flight turn (the capture shows a mid-run `/goal clear` is delivered into the running cycle).

**Tasks:**
- [ ] Implement the anchor exclusion + `goal_feedback` frame per FINDINGS.md; never guess beyond the captures.
- [ ] Reduce goal state from the Spec S04 sources; enforce the replay/possibly-active rules.
- [ ] Verify turn/token accounting over a goal cycle (one bracket; `num_turns` is claude-internal).

**Tests:**
- [ ] tugcode integration test over captured lines.
- [ ] Unit tests for goal narrowers/reducer transitions (set → active → achieved; clear; replay non-resurrection).

**Checkpoint:**
- [ ] `cd tugcode && bun test` and `cd tugdeck && bun test` green; a live `/goal` run (real-claude, on-demand) shows correct phases, counts, and a working interrupt.

---

#### Step 9: Loop/goal durability — honest surface {#step-9}

**Depends on:** #step-6, #step-7

**Commit:** `fix(tugdeck): keep scheduled work honest across respawn (resume re-fires on 2.1.204)`

**References:** [Q02] resolution, [P04] honest surface, Risk R02, (#resume-finding)

**Artifacts ([Q02] = fixed upstream — this step takes the verification branch):**
- The resume-survival captures are pinned (#step-4's `capture-loop-resume-sw-*`); no re-arm affordance is built — a `--resume`d claude re-fires its scheduled work, and every tugcode respawn path resumes.
- Deck honesty audit: scheduled rows (`wakeup`/`cron` kinds from `select-scheduled-work.ts`) must SURVIVE a respawn un-stale-marked — verify the [D102] `session_init` stale-marking touches only `running` job rows, and that a post-resume wake fire reconciles the surviving scheduled row (flip/reap) rather than duplicating it.
- A regression note in `FINDINGS.md` if any false stale-marking or duplication is found and fixed.

**Tasks:**
- [ ] Trace the `session_init` stale-mark path over the scheduled-work selector; fix any false flip of scheduled rows.
- [ ] Verify post-resume wake reconciliation against the #step-4 resume captures.

**Tests:**
- [ ] Unit tests over the scheduled-row derivation across a `session_init` boundary (survives) and a post-resume wake fire (reconciles, no duplicate).
- [ ] App-test: resume a captured session JSONL containing a real `ScheduleWakeup` tool call (from the #step-4 captures; resume-from-JSONL is the established real-not-mock mechanism — Developer ▸ Reload re-resumes from JSONL), trigger a respawn (model change), assert the scheduled row survives (not falsely `stopped`).

**Checkpoint:**
- [ ] `just app-test` green including the respawn case; no silently-vanishing and no falsely-stopped scheduled rows.

---

#### Step 10: Loop legibility — trigger chips + stop {#step-10}

**Depends on:** #step-8, #step-9

**Commit:** `feat(tugcode+tugdeck): trigger chips on wake turns; stop affordance for loops`

**References:** wake-plan [D08] (`dash/archive/tugplan-tide-session-wake.md#d08-cohort-b-fifo`), [D09] (`#d09-chrome-visual-class`), [D12] (`#d12-cancellation-hidden-user-message`), [P01], [P05], Spec S03

**Artifacts:**
- tugcode buffers `ScheduleWakeup`/`CronCreate` payloads per session ([D08] FIFO) and drains them into the `wake_started` frame so a wake turn carries its trigger (`reason`/`prompt`).
- tugdeck renders the trigger chip above the wake turn's assistant row ([D09]) — "loop: <reason>" instead of bare "scheduled wake".
- Stop-loop action (WORK popover row + chip affordance) via the [D12] hidden-user-message transport asking claude to stop the loop / `CronDelete`.
- Loop-aware `detail` labeling on scheduled rows (feeds Spec S02).

**Tasks:**
- [ ] Implement FIFO + drain in `tugcode/src/session.ts`; pin against #step-4 captures.
- [ ] Chip render + stop wiring in the deck.

**Tests:**
- [ ] tugcode test: FIFO correlation over captured interleavings.
- [ ] App-test: wake turn shows the chip; stop sends the hidden message.

**Checkpoint:**
- [ ] Live self-paced loop (real-claude, on-demand): chip names the loop, stop ends it, `just app-test` green.

---

#### Step 11: `/btw` disposition {#step-11}

**Depends on:** #step-6

**Commit:** `fix(slash): hide /btw pending SDK side-question support` *(branch B chosen at #step-6 — [Q03]: upstream refuses /btw headless)*

**References:** [Q03] [Q04] resolutions, [P06] overlay-only, [P08]-adjacent surface wiring, Spec S01, (#state-zone-mapping)

**Artifacts (branch A — bridge-viable):**
- `btw` added to `LOCAL_SLASH_COMMANDS` (`takesArgs: true`) + `slashCommandSurfaces` entry opening a side-question panel; submission allowed while busy (scoped exception in `performSubmit`).
- Side-question store (ephemeral, session-scoped) + panel composed from existing Tug primitives (popup frame, copy button); answers never render as transcript ink; earlier exchanges listed dimmed with clear.

**Artifacts (branch B — not viable):**
- `btw` added to `HIDDEN_SLASH_COMMANDS` + mirror-doc entry; follow-on recorded in [#roadmap].

**Tasks:**
- [ ] Implement the branch chosen at #step-6.
- [ ] Either way: `/btw` no longer reaches claude by accident.

**Tests:**
- [ ] Classifier test for the new tier.
- [ ] Branch A: app-test — ask a side question about session context, assert the answer appears in the panel and the transcript is unchanged.

**Checkpoint:**
- [ ] `cd tugdeck && bun test` + `bunx vite build` green; branch-A app-test (if applicable) green.

---

#### Step 12: WORK view-model, cell, popover {#step-12}

**Depends on:** #step-8, #step-9

**Commit:** `feat(tugdeck): merge TASKS+JOBS into the WORK cell; add goal/loop rows`

**References:** [P02] surface-not-storage, [P03] WORK naming, [P05], Spec S02, Spec S03, [D97] [D100] [D102] (global), (#state-zone-mapping, #symbols)

**Artifacts:**
- `select-work.ts` + `use-work-state.ts` (Spec S02); `WorkPopoverContent` (Spec S03) reusing the existing task-row and job-row internals.
- `DevTelemetryStatusRow`: TASKS + JOBS cells replaced by one WORK cell; `data-priority="work"` width CSS; `cellOrder` 6→5; collapse order TIME → TOKENS → WORK; freed width returned to TIME/TOKENS.
- All prior actions reachable: stop job, clear terminal rows, cancel cron, re-arm (from #step-9), clear goal (from #step-8).

**Tasks:**
- [ ] Build the projection + pose per Spec S02/S03, preserving [D100] idle demotion for the checklist contribution only and [D102] no-idle-demotion for jobs/goals. Note: the loop-aware `detail` on scheduled rows arrives with #step-10 (a parallel branch off #step-8/#step-9) — until it lands, loop-born rows render with the generic schedule label; do not block this step on it.
- [ ] Compose the popover from `TugPopupListFrame`/`TugStatusCell` primitives — no hand-rolled UI.
- [ ] Sweep for `statusRowRef` consumers (`/context` imperative open) and keep that path working.

**Tests:**
- [ ] Unit tests: projection grouping, merged pose truth-table (running job beats idle demotion; failed holds `aborted`; empty → `None`).
- [ ] App-test: cell renders counts; popover groups; stop/clear/cancel act.

**Checkpoint:**
- [ ] `cd tugdeck && bun test` green; `bunx vite build` passes; `just app-test` green.

---

#### Step 13: `/tasks` + `/bashes` local commands {#step-13}

**Depends on:** #step-12

**Commit:** `feat(slash): /tasks and /bashes open the WORK popover`

**References:** [P08], Spec S03, (#slash-flow)

**Artifacts:**
- `tasks` (and `bashes` as alias) moved from `HIDDEN_SLASH_COMMANDS` to `LOCAL_SLASH_COMMANDS`; `slashCommandSurfaces` entries open the WORK popover via `statusRowRef` (the `/context` pattern); mirror doc updated.

**Tasks:**
- [ ] Registry + surface + mirror-doc edits; classifier tests.

**Tests:**
- [ ] `cd tugdeck && bun test slash`

**Checkpoint:**
- [ ] Typing `/tasks` opens the WORK popover in a live card; suites green.

---

#### Step 14: Docs + design-decisions sync {#step-14}

**Depends on:** #step-12, #step-13

**Commit:** `docs(tuglaws): record WORK cell decision; sync slash doctrine and mirror`

**References:** [P03], Spec S01, S03, (#documentation-plan)

**Artifacts:**
- New global decision in `tuglaws/design-decisions.md` (next free `D###`) recording the WORK cell, superseding the cell-layout aspects of [D100]/[D102] (supersession notes added to each; their storage/grammar doctrine explicitly reaffirmed).
- `tuglaws/slash-commands.md` updated with the final dispositions (goal/loop pass-through, btw branch, tasks local) as worked examples.
- `card-state-model.md` Z2 row updated (TASKS/JOBS → WORK).

**Tasks:**
- [ ] Write the decision + supersession notes; sync the doctrine doc and card-state model.

**Tests:**
- [ ] N/A (docs).

**Checkpoint:**
- [ ] Grep confirms no doc still describes separate TASKS/JOBS cells as current; INDEX updated.

---

#### Step 15: Integration checkpoint {#step-15}

**Depends on:** #step-8, #step-9, #step-10, #step-11, #step-12, #step-13, #step-14

**Commit:** `N/A (verification only)`

**References:** (#success-criteria, #exit-criteria), Risk R01, R02

**Tasks:**
- [ ] Full-suite pass: `cd tugdeck && bun test`, `bunx vite build`, `cd tugcode && bun test`, `cd tugrust && cargo nextest run`, `just app-test`.
- [ ] Real-claude (on-demand) end-to-end: one live goal to achievement, one self-paced loop through a wake + stop, `/btw` per its branch — each observed in the real app with the WORK cell tracking throughout.
- [ ] Walk the Success Criteria list; check each off with its verification.

**Tests:**
- [ ] The above, aggregated.

**Checkpoint:**
- [ ] Every Success Criterion in (#success-criteria) verified; all suites green.

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** `/goal`, `/loop`, and `/btw` are deliberately supported (or deliberately hidden, with evidence) in the Dev card; the slash-command doctrine lives in `tuglaws/`; and one Z2 `WORK` cell tracks tasks, jobs, scheduled work, goals, and loops with full management affordances.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] `tuglaws/slash-commands.md` merged; investigations dropfile deleted. (doc review)
- [ ] `capabilities/LATEST` = 2.1.204; all fixture consumers green. (`just capture-capabilities` + suites)
- [ ] All four open questions resolved in this document with probe evidence. (plan review)
- [ ] Live goal and loop runs work end-to-end in the real app with correct lifecycle, chips, and stop affordances. (real-claude app-test)
- [ ] Respawn during an armed loop yields a visible `stopped` + re-arm row. (app-test)
- [ ] Z2 shows the single WORK cell; every prior TASKS/JOBS affordance reachable; `bunx vite build` + `just app-test` green. (suites)

**Acceptance tests:**
- [ ] `just app-test` (standard tier) — WORK cell, popover actions, respawn durability.
- [ ] Real-claude tier (on-demand) — live `/goal` to achievement; live self-paced `/loop` through one wake and a stop.

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] Tug-side `/btw` implementation (if [Q04] lands on hide) — ephemeral tool-less query channel.
- [ ] `/btw` fork-into-session.
- [ ] Z2 topic-descriptor registry (only if the bar grows again).
- [ ] Escalation from honest-surface durability to tugcode-owned re-injection (wake-plan [D10] sidecar pattern) — only on demonstrated need.
- [ ] The remaining hidden conversation-structure commands (`/branch`, `/plan`, `/fork`, `/workflows`, `/schedule`, `/ultraplan`) — each a future plan.

| Checkpoint | Verification |
|------------|--------------|
| Doctrine doc complete | Spec S01 checklist review |
| Fixtures at 2.1.204 | `cat capabilities/LATEST`; suites green |
| Probes answered Q01–Q03 | `tugcode/probes/goal-loop/FINDINGS.md` |
| Goal/loop live | real-claude app-test run |
| WORK cell shipped | `just app-test`; `bunx vite build` |
