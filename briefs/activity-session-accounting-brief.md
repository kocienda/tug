# Activity Session Accounting

**Purpose:** The activity tape misses whole kinds of work. A background subagent, anything that happens between turns, and a test run reporting its progress all draw little or nothing.

---

## Purpose {#purpose}

The report, 2026-11-24: "We still seem to be missing tons of different kinds of activity." This brief covers the kinds the model's own stream and tugcast's report door already tell us about and nobody counts. Shell commands that report nothing are `activity-machine-channel-brief.md`.

It is the second of four briefs from one sketch, after `activity-watch-scope-brief.md`.

---

## Evidence {#evidence}

**[F01] All four rate channels are counted inside a turn and nowhere else.** `accountActivity` in `tugcode/src/active-turn.ts:464` is a method of `ActiveTurn`, and it is called at three sites, all inside `dispatchEventToTurn` in `tugcode/src/session.ts` (about lines 2990, 3055 and 3094). `flushActivity` takes `this.activeTurn` and returns at once when it is null. **(verified)**

**[F02] Task frames arrive between turns and are forwarded uncounted.** `handleInterTurnEvent` in `tugcode/src/session.ts` (about line 2714) writes `task_started`, `task_updated`, `task_progress` and `background_tasks_changed` to the wire with `writeLine` and calls no accounting. The 2.1.325 capture `tugrust/crates/tugcast/tests/fixtures/stream-json-catalog/v2.1.325/test-42-bg-agent-progress.jsonl` shows the order: `turn_complete`, then `task_progress`, then a subagent `tool_use`, then `task_started` and `wake_started`. **(verified)**

**[F03] A background subagent's frames bypass accounting in and out of a turn.** `observeSubagentLifecycle` builds each `SubagentTailer` with `emit: (frame) => writeLine(frame)` (`tugcode/src/session.ts:2394`). The tailer reads the agent's output file and emits its `tool_use` and `tool_result` frames straight to the wire (`tugcode/src/subagent-tail.ts`, the `emit` calls at about lines 187 and 252). The only activity a background agent produces is its `task_progress` tick, and only while a turn is open. Background is the Agent tool's default, so this is the common case. **(verified)**

**[F04] `task_progress` is credited to the wrong channel.** `accountActivity` adds `SUBAGENT_ACTIVITY_UNITS` to `tools` for a `task_progress` frame, though the comment beside it says it is a backgrounded agent's step (`tugcode/src/active-turn.ts:547`). **(verified)**

**[F05] `tool_progress` is not counted.** It is the engine's heartbeat for a running tool call (`ToolProgress` in `tugproto/src/outbound.ts:1240`) and has no arm in `accountActivity`. The hum that holds the tape up during a foreground tool is kept by `foregroundToolOpen`, a set opened on `tool_use` and closed on `tool_result` (`tugcode/src/active-turn.ts:418`). **(verified)**

**[F06] A progress report never reaches the activity feed.** `tugtool report` posts to tugcast's HTTP door (`op == "report"`, `tugrust/crates/tugcast/src/server.rs` about line 1569). `publish_report` in `tugrust/crates/tugcast/src/feeds/agent_supervisor/mod.rs` (about line 4116) folds the report into its Bash call and publishes a `report` frame on CODE_OUTPUT only. The door's own comment says a report arrives about once a second for as long as a run lasts. `publish_report` already resolves the report to the card's session id. **(verified)**

**[F07] The deck sums samples that land in one bin.** `RateMeter.record` adds to the bin (`tugdeck/src/lib/activity-meter.ts`), so two ACTIVITY frames for one session in one 250 ms bin, from two producers, add rather than overwrite. **(verified)**

---

## Decisions {#decisions}

**[B01] The accumulator belongs to the session, not the turn.** The per-channel counters, the per-message token marks, the tool-input byte marks, the seen-id sets and the open-tool set move off `ActiveTurn` onto the session. The 250 ms flush emits whenever there is something to emit, with or without an open turn.

**[B02] Every live frame is counted at one door on its way out.** The turn dispatcher, the between-turn drain and the subagent tailer all write through one accounted emit instead of three call sites knowing to count. A new emit path then counts by construction; the tailer gap in [F03] is what the scattered call sites cost.

**[B03] A replayed frame is never counted.** The turn path gates accounting on `suppressEmit` today and the tailer has its own `resetForReplay`. The one door keeps both: a frame re-emitted for a replay bracket goes out through the uncounted path.

**[B04] A tailed subagent frame is credited as a subagent frame.** It carries the launching call's `parent_tool_use_id`, so the existing subagent arms apply: a burst per distinct `tool_use`, the capped length of a `tool_result`. A background agent then draws as a foreground one does.

**[B05] `task_progress` credits `subagents`.** It is a subagent's step ([F04]).

**[B06] `tool_progress` keeps its tool's hum alive.** A heartbeat for a foreground tool id holds that id in the open set for the bin, which covers a call whose `tool_use` the bookkeeping missed. It adds no units of its own: the hum is the level, and a heartbeat is not work.

**[B07] A report that moves credits a beat on `tools`, from tugcast.** `publish_report` publishes an ACTIVITY frame for the session when the report's `done` count or its unit rows advanced since the last report under that label. A report that only repeats its last state credits nothing, so a `report wait` loop does not draw a busy line. The frame is tugcast's own, summed by the deck with tugcode's ([F07]).

---

## Calls you have not seen {#unseen-calls}

- A report beat is the same size as a tool-call burst, 250 units. It is a single constant beside `publish_report`; change it there.
- A report with no call attached (a card-level report) still credits its beat, since the session is known either way.
- The hum continues between turns for a foreground tool whose result has not landed, though in practice a turn does not end with one open. Say so if the open set should be cleared at turn end instead.

---

## Open Questions {#open-questions}

- Whether tugcast's ledger or the bodiless-facts reading treats an ACTIVITY sample between turns as a sign the session is working. `onActivity` in `tugdeck/src/lib/bodiless-facts-store.ts` ignores a sample while the turn latch reads closed, which is the right answer for a row that carries the latch; a row from an older tugcast has none, and there are no installs to protect. The arc should confirm the latch is always present and leave that reader alone.

---

## Non-goals {#non-goals}

- **Showing waiting as activity.** API retries, compaction and time to first token leave the tape flat. Settled 2026-11-24: the phase dot already says busy, and the tape measures motion.
- **Measuring what a shell command does.** The hum says a tool is open and no more. That is `activity-machine-channel-brief.md`.
- **Changing the units the tape was tuned against.** Text, tokens, the tool burst, the result cap and the hum keep their sizes.

---

## Exit {#exit}

An arc. A shape for its first steps:

1. Move the accumulator to the session and let the flush run without a turn, with the existing activity fixtures still passing unchanged.
2. Route the three emit paths through one accounted door, with the replay gate, and add fixtures for the between-turn `task_progress` and a tailed subagent `tool_use`, taken from the 2.1.325 capture.
3. The two re-pointings: `task_progress` to `subagents`, and `tool_progress` holding the hum.
4. The report beat in tugcast, with a test beside `a_report_attaches_to_the_one_live_bash_call`.
