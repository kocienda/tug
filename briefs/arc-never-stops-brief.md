# An arc never stops while its stage is working

**Purpose:** The `arc-unification` arc was stopped at 20:26 on 2026-09-03 while Step 4 of 7 was being worked, Step 4 then closed onto a stopped arc, and both Resume presses the next morning were undone within 160 ms. One log and one audit found five defects in the runner's stop-and-resume machinery. This brief finds the rest and settles what makes the machinery hold.

---

## Purpose {#purpose}

The user's report, verbatim in its load-bearing parts:

> This session was running an arc. It got through step 4/7 and then stopped. ARCS MUST NOT STOP PARTWAY THROUGH. WTF is the problem here? Clicking the Pick this arc back up `RESUME` did *nothing* to start up the arc again. […] the arc stoppage is the *key error* that must be rooted out and fixed. This *must not happen*.

And on the follow-up:

> This arc work *must be rock-solid*. It should not be possible to audit the code and a log and come up with five problems to address. We must find and plug all these holes now.

The report's premise was that the arc stopped *after* Step 4. The records say it stopped *during* Step 4, and every later symptom follows from that one wrong stop. So the problem is stated as the doctrine states it: the wheel judges a stage only between its turns, and it judged one in the middle of a turn the harness had split in two. The remedy has to make that impossible by construction, not merely rarer.

---

## Evidence {#evidence}

Times are local (PDT). The tugcast log (`instances/release-main/Logs/tugcast.log.2026-09-04`), the arc log (`projects/-Users-kocienda-Mounts-u-src-tug/arc-log.md`), and the session's own transcript write UTC, seven hours ahead.

**[F01] The stop landed inside Step 4, not after it.** The arc log reads `step-start 4/7` at 19:52:45, `arc-stop implement implement idle` at 20:26:23, round `2b389d1dd` at 20:27:53, `step-done 4/7` at 20:27:59. The `arc.tick` line at 20:26:23.87 decided `stop:implement idle` with `quiet_turns=5`; the tick 120 ms later read the session busy again. **(verified)**

**[F02] Every one of the six "quiet" turns was opened by a background command finishing.** The stage ran commands with `run_in_background`. The session transcript (`~/.claude/projects/-Users-kocienda-Mounts-u-src-tug/5a779d57-….jsonl`) shows six user-role rows in the window whose content is a `<task-notification>` envelope and nothing else — the harness re-invoking the model when a job exits — at exactly the six `turn_complete` edges the runner counted (20:02:44, 20:13:14, 20:24:42, 20:26:00, 20:26:23, 20:26:57). Nobody asked the stage anything six times and nobody declined to close a step. **(verified)**

**[F03] The runner acted in the gap between a turn ending and its wake opening the next.** The idle read the stop needed was true for the 120 ms between the fifth envelope's turn ending and the sixth beginning (`session_idle` from `LedgerEntry::is_quiet`, which is `!turn_active && open_jobs.is_empty()`). The supervisor also fires an `arc_tick` on the *job-close* edge (`agent_supervisor.rs` ~10195: "the last job reporting … is the moment the session goes quiet"), which is the tick shape most likely to land in that gap by design. **(verified in code; the tick's trigger for this instance is not in the log)**

**[F04] The busy latch that exists for this window either never opened or had closed already.** `open_jobs` opens on `task_started` gated by a recorded `run_in_background` launch, closes on `task_updated` or `wake_started` (`parse_job_edge`). A job closed by `task_updated` before its wake leaves the gap in [F03]. Whether `task_started` arrived at all cannot be read back: `job_opened`/`job_closed` log at `trace`, the sessions ledger keeps prompts only, and the one SDK system line the log does show in the window is `unhandled system subtype="background_tasks_changed" (not forwarded)`. The installed SDK (`@anthropic-ai/claude-agent-sdk ^0.2.42`) still declares `task_started`, `task_updated`, `task_notification`. **(the latch's behaviour on this SDK is unverified — see Q1)**

**[F05] The quiet-turn horizon has no legitimate path to it.** After a turn ends with no close, the runner does nothing (`implement_action`: `quiet_turns < QUIET_TURN_HORIZON → None`) and nothing prompts the stage again; the doctrine row (`arc-lifecycle.md:94`) says "one quiet turn then nothing" is the stall clock's to answer, thirty minutes later. So a second turn end with no close can only come from a wake or a prompt the user typed. The horizon is, in practice, a wake detector wearing the sentence "the implement stage ended two turns without closing a step". **(verified by reading `feeds/arc.rs:534-604` and the doctrine)**

**[F06] The same first-turn judgement stops devise and audit on a split turn.** `stage_turn_ended` is `turns_ended > 0`; devise judges the plan's lint at its first turn end, audit judges the mark at its first turn end, review burns a round. A background command inside any of those turns ends the turn early and the stage is judged on half-written work: `lint`, `audit did not mark`, or a round spent. Nothing has yet reproduced it; the code path is the one [F01] took, one arm earlier. **(inference from code; the incident is the implement instance of it)**

**[F07] A step closing on a stopped arc is read by nobody.** `arc_action`'s first arm returns `None` on `record.stopped` (`feeds/arc.rs:286`). `step-done 4/7` at 20:27:59 was proof the stop was wrong; the runner's own tick logged `step_just_done=true … action=none` and moved on. **(verified)**

**[F08] The stop swapped the model under a working stage.** `finish`'s stop path hands back with `HandBack::Send`; the `model_change` went out at 20:26:23.875 (`control_response success` in the log). Step 4 finished under the deck's model. **(verified)**

**[F09] The runner's memory outlives a stop, and the clock outranks a resume.** `finish` never evicts the arc's `ArcState` (only `watch_the_clock_unseated` does, `arc_runner.rs:687`); `evaluate` computes `stalled` before consulting `record.stopped`; the stall arm precedes the resume arm (`feeds/arc.rs:306` vs `:324`); `arc_api::arc_resume` touches no runner state. The arc log records the consequence twice: `arc-resume implement` at 06:17:19.764 and `arc-stop implement stalled` at 06:17:19.922; again at 06:17:25.966 / 06:17:26.252. **(verified)**

**[F10] The stall clock ran over a stopped arc for ten hours and the instant a resume cleared the stop it fired.** `last_motion_at` was stamped at 20:27:59 and never again. `Instant` on macOS is `CLOCK_UPTIME_RAW` (rustc 1.93 `std/src/sys/pal/unix/time.rs:262`), which does not advance in sleep; the thirty tracked minutes were the twenty-two before sleep plus the overnight dark wakes; `stalled=true` from 03:27 on with `action=none` because the record was stopped. **(verified)**

**[F11] A resume always rotates, even when the stopped stage's own session is alive on the card.** `record.resume` → `Rotate` (`feeds/arc.rs:324`), which retires the seated session and opens a fresh one. A resume after a wrong stop therefore spends the whole working context of the stage that was, in fact, working. **(verified)**

**[F12] Two act-path early returns are silent.** `deliver_prompt` returns with no trace when its fresh re-read disagrees or when `stage_ask` yields `None`; `rotate` returns silently on the same re-read (`arc_runner.rs` ~1160, ~1236). A stop for `PromptUnavailable` exists for the rotate case and not the prompt case. **(verified)**

**[F13] The in-flight latch's retirement reads the same count.** `in_flight_at` is retired by `quiet_turns >= QUIET_TURN_HORIZON` or `stalled` (`arc_runner.rs` ~485). Any change to what a quiet turn is changes when a lost dispatch is noticed. **(verified)**

**[F14] The offer's text and frame.** `title="Pick this arc back up"` (`session-arc-receipt-block.tsx:288`). `TugInlineDialog` pads `0.625rem 0.75rem 1.5rem` (`tug-inline-dialog.css:44`): the bottom is sized for body and options slots the offer never renders. No `.arc-receipt-resume` rule exists. A resume's success is silent by design (`ArcResumeNoticeController`: "the stage opening on this card is the answer"), so a resume that is accepted and re-stopped shows a second receipt and no word about the press. **(verified)**

**[F15] What pins today's behaviour.** `one_quiet_implement_turn_waits_and_the_horizon_stops`, `a_step_boundary_outranks_the_horizon`, `the_horizon_does_not_reach_the_stages_that_end_by_rotating` (`feeds/arc.rs:1240-1300`); `a_hung_turn_stops_when_the_clock_runs_out`, `one_quiet_turn_and_then_silence_is_the_clocks_to_answer` (`:1553`, `:1579`); `quiet_is_the_turn_and_the_jobs_together` and the reap tests (`agent_supervisor.rs` ~11240); the resume tests in `arc_api.rs` (~1263-1362); the stop table at `arc-lifecycle.md:93-94`; the turn-end rule at `wheel.md:43-90`. No app-test drives the Resume button or a stop receipt (`grep arc_resume tests/app-test` finds nothing). **(verified)**

---

## Decisions {#decisions}

The decisions layer. [B01] closes the gap the incident fell through; [B02] and [B03] make the facts the predicate reads honest; [B04] makes any stop that still gets through reversible by the stage's own life; [B05] to [B08] fix what the log showed around the stop; [B09] and [B10] are what let the next audit read the answer out of a log instead of a transcript.

**[B01] The wheel acts only at a settled idle edge.** An idle reading is not an edge; an idle reading that is still true after `IDLE_SETTLE` with no turn started, no wake, and no job opened in between is. The runner, on a tick that finds the seated session quiet, records `quiet_since` and arms one re-sweep for that arc at `IDLE_SETTLE`; the decision — every decision: prompt, rotation, stop, done — is taken on that re-read, and only if `turns_ended`, `open_jobs`, and `turn_active` are unchanged. Five seconds, declared as `[tugtool.arc].idle_settle_secs` with `0` turning it off for tests that synthesize their own clock. The harness re-invokes within about a hundred milliseconds of a job's completion ([F02]), and a Monitor timeout that wakes nothing settles honestly. This is the change that makes [F03] impossible regardless of which order the SDK sends its edges in, and it is the one that would have held even if every other layer here were absent. The turn-end rule in `wheel.md` gains the word *settled*.

**[B02] A turn the harness opened is not a turn the stage was asked.** The supervisor records each turn's opener on the entry — `Prompt` for a `user_message` it dispatched (the user's or the wheel's), `Wake` for a `wake_started` — and clears it at the turn's end into a count the snapshot exposes: turns ended that were prompt-opened, and turns ended that were wake-opened. The runner's `quiet_turns` advances only on a prompt-opened turn ending with no close; a wake-opened turn's end is motion for the clock and nothing for the horizon or for `stage_turn_ended`. The in-flight latch ([F13]) retires on the same prompt-opened count. In the incident this reads Step 4 as one asked turn, which is what it was. tugcode's `wake_started` already carries the opener for a `system/task_notification`; what the live path emits for a background *Bash* completion is Q1, and [B03] is what holds if the answer is "only the user-role envelope".

**[B03] The busy latch opens on the launch and is readable afterwards.** A `tool_use` carrying `run_in_background: true` (or a `Monitor`) opens the job provisionally at the launch, keyed by `tool_use_id`; `task_started` confirms and re-keys it by `task_id`; `task_updated`, `wake_started`, and the reap horizon close it as today. A launch whose `task_started` never comes therefore still holds the session busy until the job's own terminal or the reaper, instead of being cleared at the turn's end (`background_launches.clear()`) and forgotten. tugcode forwards `background_tasks_changed` as a frame the supervisor logs rather than dropping it as unhandled, so the next drift is visible in the log. Job edges log at `debug` under `dev::ledger`, not `trace` — [F04] could not be answered because they were invisible, and a latch nobody can see is a latch nobody can trust.

**[B04] Life on a stopped stage reverses the stop.** For the stops that judged silence — `implement idle`, `stalled`, `lint`, `review did not stamp`, `audit did not mark` — a wake, a prompt-less turn start, or a step close on the stopped stage's own session is proof the judgement was wrong, and the runner acts on it without a gesture: it appends `arc-resume <stage>` with a note naming what moved, sends the stage's model back (the mirror of `hand_back`, one `model_change` frame), writes a transcript notice `arc picked back up · <arc> · <what moved>` that supersedes the stop receipt under the existing rule, and lets the predicate judge again at the next settled edge on the same session. Stops that record a person's act — `card taken`, `stopped by user`, `card closed`, `needs a decision` — are never reversed. This is the floor under [B01] to [B03]: a stop that should not have happened cannot leave an arc standing still while its own session works.

**[B05] The horizon is two asks, not two turn ends.** After an asked turn ends with no close and settles, the wheel asks the same session once more, with an ask whose text says the step is still open and names it. The second asked turn ending with no close stops as `implement idle`. This gives the doctrine's sentence — "a stage that has twice declined to close a step" — the path it never had ([F05]), and it retires the thirty-minute wait for a stage that ended its turn in prose. The stall clock keeps its one job: a turn that never ends. The prompt is composed like the continue prompt, in `wheel/prompt.rs`, and pinned there.

**[B06] A stop evicts the runner's memory, the clock is never read on a stopped record, and a resume outranks the clock.** `finish`'s stop path removes the arc's `ArcState` as the unseated path already does; `evaluate` returns before reading the clock when `record.stopped` is set; the resume arm moves above the stall arm in `arc_action`, because a resume is the user's act and a stopwatch is not a reason to refuse it; the first tick after a resume seeds `last_motion_at` fresh. Pin: *a tick that reads a resume can never decide `Stalled`*. This is the smallest change here and it makes today's Resume button honest on its own.

**[B07] A resume continues the stage's own session when it is still the card's.** When `record.resume` names a stage whose newest `arc-stage` line names the claude session the card is running (`stage_session_current`) and that session is live, the runner sends the stage's model back and the continue ask instead of rotating; the whole working context survives. When the session is gone or another has taken the card, it rotates as today. A resume is the user saying *this was wrong*, and the cheapest honest answer to a wrong stop is to pick up where the stage was.

**[B08] A stop never swaps the model under a working stage.** With [B01] a stop lands only at a settled edge, so the hand-back's `Send` reaches a session that is genuinely between turns. [B04]'s reversal sends the stage model back. Nothing else changes; the decision is recorded so nobody reintroduces a mid-turn `Send` for a good-sounding reason.

**[B09] No act-path return is silent, and the tick line says what it settled on.** `deliver_prompt`'s re-read mismatch logs at `info`; a `stage_ask` of `None` there stops as `PromptUnavailable` exactly as `rotate` does; `arc.tick` gains `opener`, `quiet_for`, and `settled` fields so the next audit can read from one line whether the runner acted on an edge or on a gap.

**[B10] The offer reads "Resume this arc" and the frame pads evenly; a re-stop after a resume is a tripwire.** The button stays `Resume`. The primitive fixes the frame, not the consumer: `TugInlineDialog` sets `data-layout="header"` when it renders no description, body, or options, and that layout pads `0.625rem 0.75rem` on all sides. A resume's success stays silent; its impossibility of re-stopping is [B06]'s pin, and a second receipt within the settle window of a resume is a test failure, not a UI state.

**[B11] The doctrine and the pins move with the machine.** `arc-lifecycle.md`'s stop table rewrites the `implement idle` and `stalled` rows, adds a row for *a stopped stage that wakes*, and states the settled edge once at the top; `wheel.md`'s turn-end rule gains *settled*; `arc-work-doctrine.md` says that a backgrounded command's wake is not a new ask. The runner gains a frame-sequence harness: (turn end → wake within the settle) decides nothing; (launch → turn end → minutes → wake) decides nothing; (stop → wake) reverses; (resume → tick) never stalls; (asked-quiet → re-ask → asked-quiet) stops. An app-test drives the Resume button on a fixture stop receipt and asserts one receipt, one bind, one stage opening.

---

## Open Questions {#open-questions}

- **[Q1] Which edges does the live SDK send for a background Bash completion?** `protocol-types.ts:41-47` says active-polling tools never fire `task_notification`; the transcript shows the harness re-invoking with a user-role `<task-notification>` envelope; the log shows a `background_tasks_changed` subtype tugcode drops. The design above does not depend on the answer — [B01] holds either way and [B03] holds if `task_started` is gone — but [B02]'s `Wake` opener needs a frame to read, and if the live path emits none for this shape, tugcode must recognise the envelope on the live path as `replay.ts` already does on replay. Settled by one backgrounded command under a live card with the tugcode IPC captured; that run is the plan's first step.

- **[Q2] Does the settled edge change what Z2 and the Wheel row show?** The Z2 pose reads the session's idle, not the runner's settled edge, and the arc-experience brief has already decided that a wheel-driven arc pulses through turn ends. Nothing here should need a face to change, but the plan should say so after reading `arcCellPose`.

---

## Non-goals {#non-goals}

- **Not forbidding background work in a stage.** A stage that backgrounds a test sweep is doing the right thing; the machine has to read it correctly.
- **Not raising `QUIET_TURN_HORIZON` or lengthening `arc_stall_secs`.** The numbers were not the problem, and a longer number is a slower version of the same wrong stop.
- **Not debouncing in the supervisor.** `turn_active` and `is_quiet` feed Z2, Pulse, and the join offer; settling belongs to the one consumer that spends a reading on an irreversible act.
- **Not a "Not now" or any dismissal on the offer.** The receipt's own brief settled that.
- **Not reversing a person's stop.** `card taken`, `stopped by user`, `card closed`, `needs a decision` stand until the user acts.
- **Not making the clock sleep-aware.** `CLOCK_UPTIME_RAW` is the right clock for silence a process watched; [B06] is what was wrong.
- **Not the arc-experience brief's items.** `notes/arc-experience-brief.md` resumes after this lands.

---

## Exit {#exit}

**A plan**, through `/arc-plan`. The work crosses tugcode's wire, the supervisor's per-turn state, the runner's timing, the predicate's arm order, the arc log's grammar, the deck, and two doctrine documents, and it carries one question ([Q1]) whose answer changes one of its parts. That is the shape a cold review is for. The plan's first step is the [Q1] capture; its phase boundary is [B06] and [B10] landing first as the smallest honest fix, then [B01] to [B04] as the machine, then [B05], [B07] to [B09], then the doctrine and the harness.
