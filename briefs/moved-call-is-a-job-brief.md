# A call the harness moves to the background is a job

**Purpose:** When a foreground Bash call runs past its timeout, Claude Code moves it to a background task and answers the call with a sentence. Tug treats that sentence as the call's end: the JOBS popup never lists the task, the block stops reporting, and the gaps record logs a ten-minute gap. The user watches a card that says nothing is running while a twenty-minute recipe runs.

---

## Purpose {#purpose}

The user's report, after `@session:tug/gentle-finch` ran `just capture-capabilities` three times at 20–25 minutes each: "Yet another case of a long process that left me hanging a long time without any progress indication." In that session the user asked, mid-run, "something is running? where? I see no sign of waiting on a command." The model's answer — "the harness moved it to a background task (`brl5btr75`), so the Session card shows nothing pending; its output is buffered behind `tail` until the end" — is the sentence the user says must never be true again.

The user's instruction: "We *must* show these backgrounded tasks in the JOBS Z2 popup. *That's what that facility is for!*"

---

## Evidence {#evidence}

**[F01] Three moves in one session, each invisible** — `tugtool session show e41d93b7-05a6-4eff-b131-5977d4a0ffa9` and the Claude Code transcript behind it: `just capture-capabilities` was called three times with `timeout: 600000` and `2>&1 | tail -60`; each time the `tool_result` arrived at 600 s saying the call was moved (`b4gteh0w6`, `brl5btr75`, `beyivm9db`, `bdf8vgq25` across the session), and each time the run went on for another 10–15 minutes with no row in JOBS and no block showing a running command. **(verified, read from the transcript)**

**[F02] The move is one sentence on the call's own `tool_result`** — verbatim: `Command did not complete within its 600s timeout and was moved to the background (ID: brl5btr75). Output is being written to: /private/tmp/claude-501/…/tasks/brl5btr75.output. You will be notified when it completes. If it is still running after 30m in the background, it will be stopped and you will be notified. … No output had been read from it when it was moved. A program that buffers its output, or a pipe into one such as tail, can keep the output file empty until the command finishes.` The task id, the output path and the 30-minute cap are all in that text, and the call's `tool_use_id` is the result's. **(verified)**

**[F03] tugcast closes the run at that result** — `close_run` in `tugrust/crates/tugcast/src/feeds/agent_supervisor/mod.rs` removes the call from `open_runs` at its `tool_result` unless the run was opened with `background: true`, which `parse_bash_run` reads only from `run_in_background` in the launch. A moved call was launched foreground, so it is closed, every later report finds no open call, and the block's panel freezes at whatever it last drew. **(verified)**

**[F04] Neither reader opens a job for it** — tugcast's `parse_background_launch` and the deck's `isJobLaunch` (`tugdeck/src/lib/code-session-store/select-jobs.ts`) both admit a job only for `run_in_background: true` or a `Monitor` call. The deck's `handleTaskStarted` (`reducer.ts`) looks the launching call up and drops the frame when that call is not a job launch — so even if Claude Code emits `task_started` for a moved call, the deck discards it. **(verified)**

**[F05] The gaps record counts the move as a ten-minute dark call** — `tugtool report gaps` lists `just capture-capabilities` at `10m 03s`: the wall time to the move, not to the end, recorded as a gap because `close_run` treated the move as the call's close. The record is right that the call reported nothing and wrong about how long it ran. **(verified)**

**[F06] The terminal edge does reach the session; the opening edge is unknown** — the `<task-notification>` envelope for each moved task arrived as a user turn naming `task-id`, `tool-use-id`, `output-file` and `status`, and `tugcode/src/replay.ts` already recognises that envelope. Whether Claude Code also emits `system/task_started` and `task_updated` over stream-json for a *moved* call — as it does for a `run_in_background` launch (`test-41-bg-bash-clean`) — is not captured by any probe, and the Claude Code transcript does not carry system events, so it cannot be read from the incident. **(the notification is verified; the stream-json edges are an inference to be settled by a probe)**

**[F07] The recipe itself ran dark, and that half is fixed in the tree** — no `[[tugtool.report.runner]]` row and no built-in matched `just capture-capabilities`, so for the whole run the block drew nothing, and the `| tail -60` kept the output file empty too (which the harness's own message in [F02] warns of). Both legs now run under `tugtool test run --kind lines --unit probe` in the `Justfile`, reading the probe loop's closing line, which `tugrust/crates/tugcast/tests/common/catalog.rs` now ends with the probe's verdict (`ok`, `fail`, `skip`, `fail (unstable)`). Fed the loop's exact line shapes, the reader counted three probes and one red; `cargo clippy -p tugcast --features real-claude-tests --tests` is clean. Both edits are uncommitted in the working tree as of 2026-10-26. **(verified)**

**[F08] The harness ceiling is the harness's** — a foreground Bash call may ask for at most 600 000 ms, and the move at that ceiling is Claude Code's act. Tug cannot keep a 20-minute recipe in the foreground; it can only make the move visible and keep the block alive across it. **(verified, from the tool's own description)**

---

## Decisions {#decisions}

**[B01] A moved call is a job, and it appears in JOBS.** A Bash `tool_result` whose text matches the move sentence in [F02] is a job launch, read by both readers of the wire: tugcast opens the job under the task id the sentence names (kind `bash`), and the deck inserts a JOBS row keyed by that id with the call's description, the output file from the sentence, and `startedAtMs` at the call's open. The insert does not go through `isJobLaunch`, which answers a different question (was this *launched* as background work); it goes through a second gate, "was this *moved*", that reads the result. The row ends on the `task_notification` the harness already sends ([F06]), and on `task_updated` if the probe in [B05] shows one. This is the user's instruction and the whole point of the facility: JOBS lists what is running in the background, and a moved call is running in the background.

**[B02] The call stays open in tugcast, and its block keeps reporting.** `close_run` treats a moved `tool_result` as a re-key, not a close: the run becomes `background: true` with `task_id` set from the sentence, exactly as a `run_in_background` launch's run is re-keyed at its `task_started`, and it leaves `open_runs` when its job ends. Reports from the command keep attaching to the call's block for the rest of the run, so a recipe that reports ([F07]) draws its panel to the end instead of freezing at minute ten. The Bash block itself renders as a backgrounded call's block does after the move, with the job's row linked.

**[B03] The move is not a gap.** `close_run` records nothing at the move. The gap, if any, is recorded when the job ends, with the wall time from the call's open to the job's end, and only if no unit report attached across the whole run — the same rule a foreground call is held to, over the run's true length. This ends the `10m 03s` row in [F05], which named a duration nothing ran for.

**[B04] The move is tested by a real-claude probe, which is the first thing the arc does.** A new probe in `tugrust/crates/tugcast/tests/common/probes.rs` (`test-48-bash-timeout-move`) asks for one Bash call with a short `timeout` and a `sleep` longer than it, in the foreground, and waits for the terminal wake. Its golden pins what stream-json carries for a moved call: whether `task_started` and `task_updated` fire, and the exact `tool_result` text. [B01] and [B02] are built on what the probe captures — from the wire edges if they exist, from the result sentence if they do not — and the capture that lands the probe is the same `just capture-capabilities` run that proves [F07]'s fix on the block.

**[B05] The sentence is matched by its shape, not its wording.** The recognizer reads `moved to the background (ID: <id>)` and `Output is being written to: <path>` with a regex over the result text, lives in one place each side (`tugcast` beside `parse_background_launch`; the deck beside `isJobLaunch`), and is pinned to the captured golden, so a wording change in a future Claude Code release shows up as drift rather than as a silent return to the dark card.

**[B06] The doctrine says what the move is.** `tugplug/tool-calls.md`, under *Tail the screen, never the record*: a call that runs past the harness ceiling is moved, the move makes it a job the card shows, and its block keeps reporting — so the model never again explains a dark card by the move. A call the model knows will run past ten minutes is written to report before it is launched, which is the rule the ladder already states; the move changes nothing about that obligation.

---

## Open Questions {#open-questions}

- Whether Claude Code emits `task_started` / `task_updated` for a moved call ([F06]). The probe in [B04] settles it; the design in [B01] works either way, and the question decides only which frame the job's open and close ride on.

---

## Non-goals {#non-goals}

- **Preventing the move, or raising the ceiling.** Both are the harness's ([F08]). The work makes the move visible and keeps the block alive across it.
- **Teaching the model to read the output file after a move.** That is the recovery the `report-verdicts` brief already ruled out; a run that reports puts its progress on the block and its verdict in the record.
- **Polling the task's state.** The job's edges arrive as frames; nothing in Tug watches the output file or a timer for them.
- **A `[[tugtool.report.runner]]` row for `just capture-capabilities`.** The recipe reports for itself ([F07]), so the hook has nothing to wrap, and a declared row would only tell the gaps record what the block already shows.

---

## Exit {#exit}

An arc. Its rough order: first the probe ([B04]) and one capture run, which also lands the recipe fix in [F07] on the block for the first time and should be committed from the working tree before the arc opens — the `Justfile` and `catalog.rs` edits are uncommitted there. Then tugcast: the move recognizer, `close_run`'s re-key ([B02]) and the gap rule ([B03]), with the `report_gaps` tests extended for a moved call. Then the deck: the move gate beside `isJobLaunch`, the JOBS row ([B01]), and the Bash block's post-move rendering, with a `code-session-store` test over the captured frames. Last the doctrine line ([B06]) and an app-test that drives a short-timeout Bash call through the stub tugcode and asserts the JOBS row and the block's live panel across the move.
