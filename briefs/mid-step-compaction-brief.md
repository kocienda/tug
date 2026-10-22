# An implement step compacts in the middle when its context crosses a share of the window

**Purpose:** The wheel compacts a seated implement stage only at a step boundary, and a step is one turn, so a step that grows its context past any line runs on with no compaction available to it until it closes. Arc steps must be able to compact mid-step once usage meets a configurable share of the window, 60% to start.

---

## Purpose {#purpose}

The user's ask:

> arc steps must be able to compact in mid-step if the context usage meets or exceeds some set threshold of the available context window (say 60%).

Today the doctrine says a step boundary is a turn boundary because the wheel can only act between turns. That is true and stays true. What it leaves out is the step whose single turn is itself long: a wide read, a long checkpoint, a step the plan sized generously. Nothing inside that turn can bring the context down, and the harness's own forced compaction, when it finally fires, lands at a point nobody chose with a summary nobody wrote.

---

## Evidence {#evidence}

**[F01] Compaction is a step-boundary act and nothing else.** The arm in `tugrust/crates/tugcast/src/feeds/arc.rs` keys on `stage_continues && ledger.step_just_done && !compacted_since_below` and a reading above `compact_tokens`; `implement_action` says in its own comment that every other act there is a step-boundary act, never mid-step. **(verified)**

**[F02] The wheel cannot act inside an open turn.** The doctrine (`tugplug/doctrine/arc-work-doctrine.md`, "A step boundary is a turn boundary") and `wheel/prompt.rs` both say why: a prompt sent into an open turn queues behind a model still working. So a mid-step compaction has exactly two possible actors: the harness acting on its own inside the turn, or the model ending the turn early so the wheel can act. **(verified)**

**[F03] The threshold is an absolute token count by decision.** `IMPLEMENT_COMPACT_TOKENS_DEFAULT` is 300 000 and its docblock argues [P07]: what makes a stage work badly is a long context, and long is a number of tokens, not a share of whatever window the model happens to have. The `ledger_entry.rs` comment on `context_window_tokens` still describes an older share reading over `context_max`, and a `tugarc-core` log fixture still carries `compact 0.73 > 0.60`; both are residue of the share-based reading P07 replaced. **(verified)**

**[F04] Both halves of a share are already known.** Used tokens live in memory as `context_window_tokens`, written live from every `streaming_usage` frame and the turn-final `cost_update`. The window cap arrives as `context_max` on tugcode's `context_breakdown` frame, read from the SDK's `modelUsage.contextWindow`, and is persisted in the `context_breakdown_latest` row. Nothing in the arc facts divides one by the other today. **(verified)**

**[F05] A compaction retires the reading, and the wheel already handles that.** On a `compact_boundary` the supervisor sets `context_window_tokens` to `None`, since a compact turn carries no usage frame and the old figure measures a context that is gone; the runner's declared fallback for a missing reading is to continue the stage. This is the repair the earlier brief `briefs/arc-compact-continue-brief.md` asked for, and it holds for any compaction, mid-step included. **(verified)**

**[F06] The harness can compact mid-turn and its line is adjustable.** Claude Code's autocompact runs between API calls inside a turn. The 2.1.285 binary carries `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` and `CLAUDE_CODE_AUTO_COMPACT_WINDOW`; tugcode reads `autoCompactEnabled` from the user's settings for its breakdown popover. The override is undocumented, and whether it is honoured under tugcode's stream-json spawn is **not verified**: a capture against the catalog would settle it. **(partly verified)**

**[F07] A hook can put a reading in the model's hands.** The same binary accepts `additionalContext` from both `PreToolUse` and `PostToolUse` hooks. The plugin registers only `PreToolUse`, answered by `tugtool hook pre-tool-use`, on `Bash`, `Skill` and the edit tools; `tugtool` already speaks to tugcast from `arc.rs` and `ask.rs`. So a reading can ride every tool call without a timer and without a new hook event. That the delivered context reaches the model's next inference under the pinned version is **not verified** by a capture. **(partly verified)**

**[F08] The ledger already models an open step across turns.** `in progress` is the step machine's one status for "being walked right now"; the implement skill resumes at the first row that is neither `done` nor `withdrawn`, and `arc step start` re-enters an `in progress` row idempotently. A turn that ends with a step open is answered by `still_open_ask`, and `QUIET_TURN_HORIZON` is 2: two asked turns with no close is a stop. **(verified)**

**[F09] The arc log already carries notes.** `tugtool arc commit --message` commits the worktree if dirty and appends an arc log line either way; `arc-note` lines are read back into `record.notes` by `tugarc_core::read_arc`. No new verb is needed to leave a line a later turn can read. **(verified)**

**[F10] The existing acts are the right shape for the second half.** After a compact turn the wheel either continues the stage or, when the reading is still above the line with `compacted_since_below` set, rotates to a fresh session over the remaining range. A mid-step compaction wants the same two endings with the range starting at the open step rather than the next pending one. **(verified)**

---

## Decisions {#decisions}

**[B01] The model yields; the harness is the backstop.** The primary mechanism is a cooperative yield: the model, told its share of the window, finishes the round it is in and ends the turn with the step still `in progress`, and the wheel compacts between turns as it does today. This keeps the doctrine's one sentence intact, that only the model can end a turn so the rule lives where the model reads, and it reuses the compact and continue path unchanged. The harness's own autocompact stays enabled as the backstop at a higher line, for the step that runs away between readings. A harness-only design was rejected because its summary is generic and its knob undocumented; a yield-only design was rejected because a single long tool call can carry a step past any line before the model reads again.

**[B02] The mid-step line is a share of the window, configurable, 60% to start.** Two new keys under `[tugtool.arc]`: `implement_yield_share`, default `0.60`, the line the model yields at; and `implement_backstop_share`, default `0.85`, the line passed to the harness's autocompact override at spawn. `tugtool arc config` reports both. [P07] is not reopened: `implement_compact_tokens` keeps governing the step-boundary act, because the two lines answer different questions. The token line says when a context has become long enough to work badly; the share line says when a step is at risk of hitting the harness's forced compaction. In practice 60% of a 200k window is 120k, under the 300k default, so the share line will usually fire first, and that is accepted.

**[B03] The reading reaches the model through the `PreToolUse` hook's `additionalContext`.** `tugtool hook pre-tool-use` asks tugcast for the calling session's used tokens and window cap, and when the session is a seated implement stage at or above the yield line it returns one line of context: the share, the line, and the instruction to finish the round, commit, write the hand-off and end the turn. Below the line it says nothing, so the ordinary session sees no change. It is sent on every tool call once above the line, so the model cannot miss it behind one more read. A new `PostToolUse` registration was considered and set aside because the reading is fresh enough on the next call's gate and one hook is simpler to reason about.

**[B04] A yield happens only on committed bytes.** The model yields after a round commit, or on a clean tree, never with a half-edited file. A resumed step, in the same session or a fresh one, starts from the bytes the arc's branch already holds, so the hand-off never has to describe uncommitted work.

**[B05] The hand-off is one arc-log line through `tugtool arc commit`.** The yield's last act is `tugtool arc commit --message "yield: <round>; files: …; next: …"`, which commits the round if anything is dirty and appends the line either way. It names the round just landed, the files it touched, and the next task inside the step. No new verb. The implement skill's re-entry, under the `where` line, reads the open step's latest `yield:` line from `record.notes` and continues from the task it names.

**[B06] The wheel gains one arm: step open, turn ended, share above the line, compact.** Today's arm requires `step_just_done`. The new arm fires when the stage's turn ended with a row `in progress`, the yield line it crossed, and a `yield:` line since the last ask; it sends the same compact prompt and sets the same memory. The ordinary end of a step is unchanged.

**[B07] After the compaction, resume; if the context is still above the line, rotate to a fresh session.** The compact turn's end is answered by a resume ask that names the open step and says a hand-off line is waiting. When the reading after the compaction is still above the line with `compacted_since_below` set, the stage rotates to a fresh session over the range from the open step through the declared end, exactly as it does for the next pending step today. The fresh session resumes the open step from the hand-off alone, which is the strongest test the note gets and the reason it names the next task rather than summarising the step.

**[B08] A yield is not a quiet turn.** A turn that ends on a `yield:` line does not count toward `QUIET_TURN_HORIZON`, and the resume ask is not a `still_open_ask`. Two yields in one step are two compactions, not a stop. A turn that ends with the step open and no yield line is still what it was: an asked turn that closed nothing.

**[B09] The backstop learns from the boundary, not from the wheel.** A harness-driven compaction is recognised by the `compact_boundary` record the supervisor already parses; it retires the reading and sets `compacted_since_below` so the wheel does not compact again at the next boundary over a context that already came down. The backstop compaction lands with no hand-off line, since nobody chose the point; that is accepted as the price of a safety net that is meant to be rare.

**[B10] The doctrine, the skill and the laws say the new sentence.** `arc-work-doctrine.md`, `arc-implement/SKILL.md` and `tuglaws/wheel.md` all currently say compaction happens between steps. Each gains the yield: a step boundary is still a turn boundary, and a step may also end a turn early to be compacted, on committed bytes, with a hand-off line, and resume. The `where` line names an open step's waiting hand-off so the skill reads it rather than discovering it.

---

## Open Questions {#open-questions}

- **Whether `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` is honoured under tugcode's spawn, and what unit it takes.** Settled by a capture against the stream-json catalog at the pinned version, with a drift probe so a release that changes it is caught. If it is not honoured, the backstop falls back to the harness's default line and [B02]'s second key is dropped.
- **Whether `PreToolUse` `additionalContext` reaches the model under the pinned version.** Settled by one capture. If it does not, `PostToolUse` is registered for the same purpose.

---

## Non-goals {#non-goals}

- **Reopening [P07].** The step-boundary threshold stays a token count; the share line is a second line for a different question.
- **A prompt injected into an open turn.** It queues behind the model and the doctrine already says so.
- **A timer or poller reading the context.** The reading rides tool calls the model already makes.
- **A new `tugtool arc` verb for the hand-off.** `arc commit` already appends a log line on a clean tree.
- **A `PreCompact` hook writing a note for the backstop.** The backstop is meant to be rare; a note it wrote would be a second hand-off format to maintain.
- **Yielding with uncommitted edits.** A hand-off that has to describe a half-edited file is the failure mode this design exists to avoid.

---

## Exit {#exit}

An arc. The pieces, in the order they must land:

1. Config: `implement_yield_share` and `implement_backstop_share` under `[tugtool.arc]`, defaults and `arc config` reporting, with the template comment.
2. Facts: a `context_share` reading in the arc facts from `context_window_tokens` over the persisted `context_max`, and a `yielded_since_ask` fact derived from the arc log.
3. Wheel: the step-open compact arm [B06], the resume ask and the mid-step rotation [B07], the quiet-turn exemption [B08], and the backstop recognition [B09], each with a predicate test and a runner test that sends the compaction and ticks through its end.
4. Hook: `tugtool hook pre-tool-use` returns the reading as `additionalContext` for a seated implement stage above the line.
5. tugcode: pass the backstop line to the harness at spawn, gated on the capture in the open questions.
6. Documents: doctrine, skill, `tuglaws/wheel.md` and the `where` line.
7. Captures: the two probes the open questions name, added to the catalog with drift checks.
