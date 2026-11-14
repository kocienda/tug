# Arc Resume: the False Stall and the Offer That Stays

**Purpose:** A resumed arc was stopped again one second later as "went silent", and after a second Resume press the Resume offer stayed on screen while the arc was running. Both are wrong, and they have separate causes.

---

## Purpose {#purpose}

The user's report, on the arc `workspace-stages-finish` running on the card `primo-pylon`:

> Once I resumed the arc, WHY DID THE RESUME OFFER GET STUCK!? … IT'S *STILL STUCK*.

The audit stage had stopped itself to ask a decision. The user answered 47 minutes later. The Wheel then printed "Stopped · it went silent — no t…" with a **Resume this arc** offer, two seconds after the answer was sent and while the session was visibly streaming. The user pressed Resume; the offer stayed where it was.

Two things were said to the user that were not true: that the arc had gone silent, and (by the standing offer) that it was still stopped.

---

## Evidence {#evidence}

All times are 2026-11-13 PST. The log is `tugcast.log.2026-11-14` in the `release-main` instance's `Logs` directory; the record is `tugtool arc record workspace-stages-finish --json`.

**[F01] The timeline.** **(verified, from the log and the record)**

| Time | Event |
|---|---|
| 4:17:40 | The audit stops through `tugtool arc ask` (`NeedsDecision`). Ticks read `stopped=true` from 4:17:41. |
| 5:04:54 | The user sends "teach the judge frames under the gate". A resume line lands; the prompt opens a turn. |
| 5:04:56 | First tick on the resumed record: `idle=false turn_active=true opener="prompt" quiet_turns=1 last_done_count=Some(5) stalled=true decided=stop:stalled`. |
| 5:04:57 | Ticks read `stopped=true` again. |
| 5:05:05 | The user presses Resume. The record reads `stopped: null`, `resume: audit`, `last_stop: [audit, stalled]`. |
| 5:05:06 on | Ticks read `stalled=false turn_active=true quiet_turns=0 last_done_count=None action=none`. The offer is still shown. |

**[F02] The stall clock aged through the stop.** `last_motion_at` in the runner's per-arc `ArcState` was last stamped at 4:17. The stall timeout is `ARC_STALL_SECS_DEFAULT`, 1800 s, and this project declares no override. At 5:04:56 the stamp was 47 minutes old. The tick at 5:04:56 carries `quiet_turns=1` and `last_done_count=Some(5)`, both values from before the stop, so the entry survived the stop whole. **(verified)**

**[F03] Only the runner's own stops evict that memory.** `finish` in `tugrust/crates/tugcast/src/feeds/arc_runner.rs` drops the arc's entry and puts back only `stop_marks`; its doc comment names the earlier incident ("an overnight-stale `last_motion_at` re-stopping the arc within 160 ms of each Resume press"). `finish` is reached only from `arc_action`'s `Done` and `Stop` results. A stop written through the API (`arc_ask` and `arc_stop` in `tugrust/crates/tugcast/src/arc_api.rs`) does not pass through it. **(verified, by reading the code)**

**[F04] A stopped record leaves the entry untouched.** The stopped-record block in `evaluate` returns before the state update, which is why the clock is not re-stamped while stopped, and also why nothing clears it there. **(verified, by reading the code)**

**[F05] The clock is read only mid-turn, and the user's prompt made it readable.** `stalled` is `!session_idle && clock_ran_out(…)`. An idle session at the first post-resume tick would have been continued at once. Because the user typed an answer, that tick saw a turn in flight and took the "resumed, not idle, stalled" arm in `tugrust/crates/tugcast/src/feeds/arc.rs`, which returns `Stop { reason: Stalled }`. **(verified)**

**[F06] A stop row is demoted only by a later transcript row.** `markSupersededArcStops` in `tugdeck/src/lib/session-transcript-data-source.ts` marks a stop superseded when a later row for the same arc answers it: a "picked back up" note, a later receipt, or a join. `shouldOfferResume` in `session-arc-receipt-block.tsx` reads only the row and that mark, and by its own stated rule reads no live store. **(verified, by reading the code)**

**[F07] A resume pressed mid-turn writes no such row.** `arc_resume` in `arc_api.rs` appends `arc-resume` and binds, and leaves the first act to "that card's own next idle". The "picked back up" note is written when the runner continues or rotates the stage. In the "resumed, not idle, not stalled" arm `arc_action` returns `None`, so nothing is written until the turn ends. **(verified, by reading the code and the `action=none` ticks)**

**[F08] The arc itself was healthy after the second press.** From 5:05:06 the record carried no stop and the audit session's context grew from 298,557 to 325,224 tokens over two minutes. The offer was the only thing wrong, and a press on it is a no-op by `arc_resume`'s own rule. **(verified)**

**[F09] Which door wrote the 5:04:55 resume was not traced.** It was either the prompt sent on the stopped card or a press on the 4:17 row. The resume API logs no line of its own. This is the one finding not established, and neither decision below depends on it.

---

## Decisions {#decisions}

**[B01] A stopped record ages nothing, whoever stopped it.** On every tick that reads `record.stopped`, the runner resets the arc's running memory to its `stop_marks` alone, in `evaluate`'s stopped-record block. The eviction becomes a property of the record, so it covers `arc ask`, `arc stop`, and any writer added later, where the existing eviction in `finish` covers only stops the runner decides. The first tick after a resume then seeds a fresh clock, which is the same rule the runner already applies after a restart: silence tugcast did not watch as a running arc is not silence it may hold against a stage. `stop_marks` is kept because the stopped path reads it to tell life on a stopped stage from the stop's own echo.

**[B02] A resume onto a stage that is already working is a continue, and it is said at once.** In the "resumed, not idle, not stalled" arm, when the seated session is the stage's own, the runner writes `arc-continue` and the "picked back up" note on that tick and sends no prompt. `arc-continue`'s fold comment already describes this state: "the stage is already seated and already moving". The note lands in the open turn's mid-turn seat, which `markSupersededArcStops` already reads, so the stop row demotes within a tick with no change to the deck. A seat that is not the stage's own keeps today's wait for idle and rotation.

**[B03] The receipt's rule stands.** The offer goes on reading only its own row and the supersede mark. The fix for a stale offer is a row that answers it ([B02]), because a receipt reading live state would be reporting the present in a row about the past.

**[B04] Each decision gets a runner test that reproduces the report.** For [B01]: a stop written by the API, held past the stall timeout, then resumed with a turn in flight, is not stopped as stalled. For [B02]: a resume on a card whose stage session is mid-turn writes the continue and its note on the next tick, and sends nothing to the session.

---

## Open Questions {#open-questions}

- **What the end of that turn should do after [B02].** Once `arc-continue` has cleared `resume` mid-turn, the turn's end is judged by the ordinary arms. For an audit that ends the turn without marking, that is `AuditDidNotMark`, where today the resume arm would have asked the stage again. Whether the turn the user opened should count as the stage's asked turn, or the stage is owed one more ask, is read out of the predicate's arms and their tests when the step is walked; it needs no user decision unless the two readings give the user a different sentence.

---

## Non-goals {#non-goals}

- **Stamping motion at the resume press.** It would have prevented this stop, but it patches one door. Any other path that clears a stop would need the same stamp, which is how the first fix came to miss the API stops.
- **Making the Resume offer read live arc state.** Rejected by [B03].
- **Changing the stall timeout or the stalled sentence.** The clock was right about the time; it was measuring a span it should not have held.
- **Tracing or changing which gesture resumes a stopped arc.** [F09] is left open because nothing here turns on it.
- **Repairing `workspace-stages-finish`.** It is running; its record keeps `last_stop: stalled` as history.

---

## Exit {#exit}

**An arc.** The raw material for its steps:

1. The runner test for [B01], red first, then the reset in `evaluate`'s stopped-record block.
2. The runner test for [B02], red first, then the immediate continue in the "resumed, not idle" arm, with the open question settled against the predicate's existing tests.
3. A deck-side check that a mid-turn "picked back up" note demotes the stop row, which `session-transcript-data-source.test.ts` may already cover.

Step 1 lands first: without it, step 2's continue can still be beaten to the tick by a stale clock.
