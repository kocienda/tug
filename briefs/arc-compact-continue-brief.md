# An arc walks on after its own compaction

**Purpose:** The `consistent-atoms` arc closed Step 4 of 6 at 14:00 on 2026-09-04, was sent `/compact` by the wheel because its context stood above the threshold, and never received the prompt for Step 5. It is not stopped: it has logged `action=none` every minute since, with no receipt, no Resume, and nothing on the card to say it has stopped advancing. The compaction worked; the wheel decided to walk on; and it dropped its own decision one tick later.

---

## Purpose {#purpose}

The user's report:

> `@tug/viney-mule` failed to pick up and work on Step 5 after a compact following Step 4. This *can't happen*! Work must continue! What went wrong?

The doctrine already promises exactly this: a compaction "keeps its session, its lineage, and its stage label, and only its context comes down" (`tuglaws/wheel.md`), and the implement stage is owed its next turn at the compaction's end. The promise was kept by the predicate and broken by the runner, in the gap between the settle gate that landed this morning and a one-shot memory that gate never learned about. The problem is therefore not the compaction and not the predicate. It is that a decision the runner is required to *hold* was made over a fact the runner *spent*.

---

## Evidence {#evidence}

Times are UTC as the logs write them; the user's clock is seven hours behind. The tugcast log is `instances/release-main/Logs/tugcast.log.2026-09-04`; the arc log is `projects/-Users-kocienda-Mounts-u-src-tug/arc-log.md`; the stage session's transcript is `~/.claude/projects/-Users-kocienda-Mounts-u-src-tug/39bb5314-1e8a-4cde-9d07-e0fb0d705b0b.jsonl`.

**[F01] The compaction was decided correctly and delivered.** `step-done 4/6` at 21:00:47. The `arc.tick` line at 21:00:54.398 read `tokens=328150 step_just_done=true settled=true quiet_for=5013` and decided `prompt:compact`; the arc log carries `compact 328150 > 300000` and `arc-note compacted at 328150 > 300000` at the same instant; the transcript shows the `/compact` as a queued user message at 21:00:54.401. This is the arm at `feeds/arc.rs:541` doing what `wheel.md` says it does. **(verified)**

**[F02] The compaction ran and ended as a turn.** The transcript's `compact_boundary` at 21:03:36.446 reads `trigger:"manual", preTokens:328150, durationMs:162044`, followed by the summary and `<local-command-stdout>Compacted</local-command-stdout>`. The tick at 21:03:36.781 read `prompt_turns=9` (up from 8), `idle=true`, `compacted_since_below=true`, `compact_turn_just_ended=true`. **(verified)**

**[F03] The tick that read the compaction's end decided an action, and the settle gate withheld it.** That same 21:03:36.781 line says `settled=false quiet_for="0" action=none`. `quiet_for="0"` is the gate's own signature for "a different reading, or the first one — start the window over it" (`settle_gate`, `arc_runner.rs` ~1043): it armed a five-second re-sweep and set the action to `None`. So the predicate did return something here; the log shows the withheld result, not the decision. **(verified from the log's `quiet_for` field and the gate's code; the predicate's return value is not itself logged)**

**[F04] The same tick spent the compaction's pending record.** `arc_runner.rs:690`: "A pending prompt is read back exactly once: the tick that derived `compact_turn_just_ended` from it is the tick that consumes it" — `if memory.compact_turn_just_ended { entry.pending = None; }`. This runs *above* the settle gate, unconditionally. **(verified)**

**[F05] The next tick, 100 ms later, had nothing left to decide on.** The line at 21:03:36.880 reads `compact_turn_just_ended=false step_just_done=false quiet_turns=0 action=none`. With `pending` gone the fact cannot be re-derived; `step_just_done` is false because the compaction closed no step and `last_done_count` already read 4; `quiet_turns` is 0 because the runner deliberately does not count a compact turn (`arc_runner.rs:622`). `implement_action` falls to its `!step_just_done` branch and returns `None`. The settle re-sweep at 21:03:41.788 (`quiet_for=5006`) found `action=none` and, by the gate's own rule for a `None` action, held nothing. **(verified)**

**[F06] Nothing can wake it.** The quiet-turn horizon needs a turn to end, and no turn will start without a prompt. The stall clock is read only on a non-idle reading (`arc_runner.rs:651`, by [P06] of the previous brief). `compacted_since_below` stays true, but the rotation arm it keys sits behind `step_just_done`. Every tick from 21:03:41 to the time of writing (21:09 and counting, `quiet_for` past 360,000 ms) logs `action=none`. The arc record reads `stopped: null`, so no receipt was written and no Resume exists. **(verified)**

**[F07] The defect is a regression from this morning's settle gate.** `git log -S settle_gate` names one commit, `25aefdde3` (2026-09-04 11:33, `arc-never-stops`). Before it the tick that derived `compact_turn_just_ended` also *acted* on it, so a one-shot was safe. The gate's docblock names this exact hazard for step boundaries — "a withheld reading is also an unspent one" — and restores `last_done_count` on every withheld tick for that reason, but `pending` was not given the same treatment. Every compaction on a continued implement stage under the gate will wedge this way. **(verified)**

**[F08] The predicate's tests cannot see it.** `a_compact_turns_end_continues_when_the_context_came_down` and its siblings in `feeds/arc.rs` hand the predicate a facts struct with `compact_turn_just_ended: true` and assert the return value. The wedge is in the runner's memory across two ticks, which only the runner harness (`arc_runner.rs` tests from `an_idle_reading_is_not_an_edge` on) can drive, and no test there sends a compaction and ticks through its end. `a_compaction_writes_the_arc_log_line_and_the_arc_note` stops at the delivery. **(verified)**

**[F09] The token reading did not change after the compaction, so the decision the gate withheld was the wrong one anyway.** `tokens=328150` on every tick from 21:00:49 through 21:09, before and after the compaction. The supervisor writes `context_window_tokens` from `streaming_usage` and `cost_update` frames only (`agent_supervisor.rs:10410`, `parse_context_window`); a `/compact` turn produces neither on the main lane, so the reading is the pre-compaction number until the next real turn's first `message_start`. Had [F04] not spent the record, the post-compact arm at `feeds/arc.rs:667` would have read `328150 > 300000` with `compacted_since_below=true` and returned **Rotate** to a fresh session over Steps 5–6 — the expensive act the compaction exists to avoid — over a measurement of a context that no longer existed. **(the unchanged reading is verified in the log; that no usage frame accompanies a compact turn is inferred from the frame parser and the transcript, which shows no assistant message between the `/compact` and the boundary)**

**[F10] tugcode already knows the post-compaction size and tugcast does not read it.** The `compact_boundary` frame carries `post_tokens` (`tugcode/src/types.ts:770`), which the deck uses to drop its CONTEXT readout in place. The supervisor's `context_window_tokens` writer ignores the frame. **(verified)**

---

## Decisions {#decisions}

**[B01] A withheld decision leaves every fact it was made from standing, and the compaction's pending record is one of those facts.** The runner spends `pending` only on a tick whose action the settle gate let through — the rule the gate already applies to `last_done_count`, stated once and applied to both. Concretely: the `if memory.compact_turn_just_ended { entry.pending = None }` at `arc_runner.rs:690` moves below the gate and runs only when `settled.settled` is true (or the gate restores `pending` on the withhold paths exactly as it restores `last_done_count`; the plan chooses, and the test in [B04] does not care which). The settle re-sweep then re-derives `compact_turn_just_ended` from the still-standing record, the predicate returns the same action, and the gate's "same session, standing still long enough" path lets it through. The re-ask's `StillOpen` retirement at `arc_runner.rs:696` is compared against a turn count rather than consumed by a derivation, so it does not have this shape — but the plan should say so in a comment beside it, because the two sit together and the next reader will ask.

**[B02] A compact turn's end is judged against no reading rather than a stale one.** On a `compact_boundary` frame for a session, the supervisor retires `context_window_tokens` to `None`: the number it held measured a context that no longer exists, and the predicate's stated principle — "a missing reading is no reason to strand a stage that has steps left" (`feeds/arc.rs:748`) — already makes `None` mean *continue* on the post-compact arm. The next real turn's first `streaming_usage` writes the true size, and the next step boundary judges it with `compacted_since_below` still standing, which is where a compaction that genuinely did not bring the context down earns its rotation. This rules out reading `post_tokens` into the arc's number: it is below the session base, not the resident window, and adding an estimate of the base would be a second measurement of the same thing that the deck already keeps for its own reasons.

**[B03] The rotate-after-compaction arm needs a reading newer than the compaction, and `None` is the way to say there is none.** [B02] is what makes this true without a timestamp on the reading. The plan should not add one: a runner memory of "tokens at the moment the `/compact` was sent" compared against the current reading would answer the same question with a second piece of state, and the previous brief's audit found five defects in memory of that kind.

**[B04] The runner harness drives the whole sequence, and the pin is on the wedge's exact shape.** A frame-sequence test in `arc_runner.rs`'s settle harness: step close → settle → `/compact` submitted → compact turn end → a changeset tick inside the settle → settle re-sweep → the continue prompt for Steps 5–6 is submitted, and `pending` is gone only then. A second case: the same sequence with a `streaming_usage` still above the threshold arriving *before* the boundary and none after, asserting a continue rather than a rotation, which is [B02]'s pin. The tick inside the settle is the load-bearing line; a test that ticks once and ages the settle would have passed on the code that wedged.

**[B05] The `arc.tick` line says what the predicate decided as well as what the gate let through.** [F03] had to be inferred from `quiet_for="0"`. A `decided=` field carrying the predicate's action before the gate, beside the existing `action=`, is what would have made this a one-line read, and it is what the previous brief's [B09] meant by "the tick line says what it settled on".

**[B06] The doctrine names the compaction's turn end as a settled edge like any other.** `wheel.md`'s compaction paragraph gains one sentence: the `/compact` the arc sent ends a turn, that end is held for the settle like every other idle edge, and the stage is prompted on from it against a fresh reading or none. `arc-lifecycle.md`'s stop table is unchanged: this shape is not a stop and must not become one.

---

## Open Questions {#open-questions}

- **Should an idle, seated, in-range implement stage with no prompt outstanding have a floor at all?** [F06] is a class the machine could not classify and it degraded to *forever*, which is the shape the previous brief's clock was introduced to forbid — but that brief's [P06] deliberately confined the clock to a turn that never ends, because an idle stage after a wake-opened turn end is a legitimate quiet state the horizon answers. A floor here would have to be a re-ask rather than a stop (the work must continue, not be handed back), fire only when no prompt is out and `quiet_turns` is 0, and wait the full stall timeout. The recommendation is to build [B01]–[B04] first and decide this with the harness in hand, since a floor that fires on the wake-quiet case is the kind of false answer the last brief spent itself removing. It needs the user's call because it revisits a decision they settled yesterday.

---

## Non-goals {#non-goals}

- **Retrying the `/compact` or rotating when the post-compact reading is missing.** Both spend a session on a measurement that does not exist. [B02] makes the missing reading mean *walk on*, which is what the predicate already says it means.
- **Reading `post_tokens` into the arc's context number.** See [B02]: it is a different quantity and would need an estimate of the base to become the same one.
- **A timestamp on the context reading.** See [B03].
- **Changing what a compact turn counts for.** It still does not count as a quiet turn and still does not move `last_done_count`; the fix is that its one-shot memory survives a withhold, not that it acquires new meaning.
- **Unwedging `consistent-atoms` by code.** The live arc is recovered by hand — a stop and a Resume, or the Step 5 ask typed into the card — before this brief's arc opens, so that its own dogfooding does not run under the defect it is fixing.

---

## Exit {#exit}

**A plan**, small and single-phase, for `/arc`:

1. Move the compaction's consumption below the settle gate ([B01]), with the comment beside the re-ask's retirement.
2. Retire `context_window_tokens` on `compact_boundary` in the supervisor ([B02]), and a unit test on the parser or the writer that the frame clears rather than sets.
3. The `decided=` field on the tick line ([B05]).
4. The two frame-sequence tests ([B04]) — written to fail on the current runner first, since the wedge is exact and cheap to reproduce in the harness.
5. The `wheel.md` sentence ([B06]).

Nothing here touches the predicate in `feeds/arc.rs`, the deck, or the skills.
