# Relay Panic Hardening

**Purpose:** On 2026-09-20 one bad string slice in tugcast turned into a Release app that would not launch. The slice is fixed; this brief is about the three places that let a one-line panic in one session's relay become a dead app with nothing in any log.

---

## Purpose {#purpose}

The report: "The release version of the app is hanging on launch." The app-modal read *Restoring 1 session — 10 of 10 turns* and never closed. It could not be dismissed, the wedged card could not be closed from behind it, and quitting and relaunching reproduced it every time, because the session that tripped it was the session being restored.

The trigger was small and is already fixed. What made it an outage is that every layer between the panic and the user assumed the layer below it would always speak: the supervisor assumed a relay that died would say so, the relay's watchdog assumed another line would arrive to wake it, and the restore gate assumed `replay_complete` would always come. None of those is true, and the failure of any one alone would have been survivable.

---

## Evidence {#evidence}

**[F01] The trigger was a `str` slice at a fixed byte offset.** `write_targets` in `tugrust/crates/tugchanges-core/src/shell_ops.rs` scans an interpreter heredoc for `open(` and reads `&text[start..text.len().min(start + 200)]`. In the eucit session a `python3` heredoc carried "Stanisław" with the `ł` straddling byte 200, and the slice panicked: `byte index 258 is not a char boundary; it is inside 'ł'`. Reproduced by feeding the session's real six replay wire lines through `relay_session_io` in the scripted-stdout test harness; the panic fired in 80 ms. **(verified)**

**[F02] The fix for [F01] is written and uncommitted.** The cut is floored to a char boundary, with a regression test `an_open_window_ending_inside_a_multibyte_char_does_not_panic` that walks the cut across every offset of a two-byte char. With it, the same harness forwards all seven frames including `replay_complete` in 70 ms; `tugchanges-core` is 186/186. `shell_ops.rs` is the only file changed. **(verified)**

**[F03] A panic in the relay task is invisible.** `relay_session_io` is awaited inside `run_session_bridge`, which `agent_supervisor.rs` launches with a bare `tokio::spawn` whose `JoinHandle` is dropped (the spawn at the end of the per-session bridge setup, ~line 11963). tugcast installs no panic hook and wraps nothing in `catch_unwind`. So the panic unwound the whole bridge task and produced: no log line in `tugcast.log` (the tracing appender never saw it), no `RelayOutcome`, no crash-budget accounting, no respawn, no `SESSION_STATE` frame, and no `lastError` on the card. The child's pipes dropped with the task, tugcode exited on the closed pipe, and "tugcode stdout closed" was never logged because nothing was left to read EOF. The log shows the session's last line at `[dev::replay::complete]` and then nothing for that session, ever. **(verified — log read and spawn site read; the EPIPE exit of tugcode is inferred from its absence from the process table with no crash report)**

**[F04] The replay-bracket watchdog cannot fire on a quiet stream.** `REPLAY_BRACKET_DEADLINE` (120 s, `agent_bridge.rs:1430`) is checked at `agent_bridge.rs:1981`, inside the `Ok(Some(line))` arm of the relay's `select!`. It runs only when another stdout line arrives. Its own comment names the case it exists for — a bracket opened and never closed — and that is precisely the case in which no further line arrives. It did not apply on 2026-09-20 because the relay itself was dead, but it is wrong independently: a tugcode that opens a bracket and then goes quiet latches `in_replay` forever. **(verified by reading the code)**

**[F05] The merger's bracket counter latches the same way.** `LedgerEntry::replay_brackets_open` (`agent_supervisor.rs`, `process_outbound_frame_journal_gate`) increments on `replay_started` and decrements on `replay_complete`, and nothing else ever resets it. Its doc comment already concedes that a bridge dying mid-bracket leaves it stuck non-zero, which suppresses every later journal-pop, turn-end edge, and context-window retire for that session. On 2026-09-20 the log shows `merger.replay_bracket_open depth=1` for the last three launches and no matching close. **(verified)**

**[F06] The restore gate has no deadline and no failure path.** `deriveColdRestoreActive` (`tugdeck/src/components/tugways/cards/session-card-restore-gate.ts`) is true while `phase === "replaying"` in resume mode, and only `replay_complete` or a non-null `lastError` ends that. `restore-gate-store.ts` folds every card's predicate into one app-modal, and `TugRestoreGate` (`tug-restore-gate.tsx`) is undismissable by design — Escape is prevented, there is no button, and its docblock says it "closes when the app can answer again." The preflight beat has a 12 s tick; the `replaying` phase has nothing. So one lost frame on one card blocks every card, the menus behind it, and the only gesture that could remove the offending card. **(verified)**

**[F07] The app-modal's premise did not hold here.** The gate exists because a cold restore's reveal is one uninterruptible main-thread task, so the app "answers nothing" for its duration. On 2026-09-20 the main thread was idle the whole time — all ten turns had been ingested and the bar read 10 of 10. The modal was asserting "busy" over an app that was merely waiting. **(verified from the screenshot and the store's `turnsLoaded`/`turnsTarget` derivation)**

**[F08] No code change introduced this.** The only commit between the last healthy restore of the session (19:07 UTC) and the first wedged one (20:28 UTC) is `1b7d0f9e9`, a brief. The variable was the transcript: the offending heredoc entered the ten-turn restore window. Any user whose transcript contains a non-ASCII character near an `open(` in an inline interpreter program would have hit it. **(verified)**

---

## Decisions {#decisions}

**[B01] The restore gate gets a deadline, and it is the first thing to land.** [F06] is what escalated a one-session failure to an app-wide one; with it fixed, every other failure in this brief degrades to one broken card. A card that has been in `replaying` past the deadline stops counting toward the app-modal and surfaces an error on itself — through the existing `lastError` path, which already forces `deriveColdRestoreActive` false and mounts the body so the banner shows. The deadline measures *silence*, not total duration: it restarts on every replay frame the card ingests, so a genuinely enormous restore that is still making progress is never cut off, and [F07]'s case — all turns in, nothing arriving — trips promptly. The gate stays undismissable; the argument for that in its docblock is sound while the app is truly busy, and a deadline is what makes "truly" checkable.

**[B02] A relay death of any kind surfaces as a visible card error, never as silence.** The bridge task's `JoinHandle` is observed — or the bridge body is wrapped so an unwind is caught at the task boundary — and a panic is converted into the same terminal handling a crash gets: an `error!` line carrying the panic message and location, a `RelayOutcome::Crashed`-equivalent through the crash budget, a closing `replay_complete { error }` if a bracket was open, and a session-state frame the deck turns into `lastError`. The user sees a card that says its bridge died and can close or retry it. This is the decision that would have turned 2026-09-20 into a thirty-second annoyance even with [F06] unfixed.

**[B03] tugcast installs a process-wide panic hook that writes through tracing.** Separate from [B02] because it covers every task, not just the bridge: a panic anywhere in tugcast currently goes to a stderr nobody reads. The hook logs message, location, and thread/task name at `error!` and then defers to the default hook. It changes no control flow; it exists so the next silent death is one `grep panicked` away instead of a two-hour bisection through healthy-looking logs.

**[B04] The bracket watchdog moves to where a quiet stream can reach it.** The deadline check leaves the per-line arm and becomes its own arm of the relay's `select!` — a timer armed at `replay_started`, disarmed at `replay_complete` — so it fires on wall-clock time whether or not tugcode ever writes again. When it fires it does what the current code does (force live capture, warn) **and** emits a synthetic `replay_complete { error: replay_timeout }` downstream, so the merger's counter ([F05]) and the deck's phase both close through the one frame they already understand, rather than each growing a private timeout. This is an event-armed timer on the thing being watched, not a poll.

**[B05] A bridge's terminal teardown zeroes `replay_brackets_open`.** Whatever ends a bridge — crash, panic per [B02], cancel — the entry's bracket counter is reset as part of that teardown, and a respawned bridge starts from zero. [B04]'s synthetic close covers the live-but-quiet case; this covers the dead-bridge case, where there is no relay left to synthesize anything. The doc comment that currently concedes the latch is rewritten to say it no longer can.

**[B06] The `shell_ops` fix and its test land with this work, first.** [F02] is done and verified; it rides as the opening commit so the arc's base is a tree in which the known trigger cannot recur while the structural fixes are walked. A sweep of `tugchanges-core` and `agent_bridge.rs` for sibling byte-budget `str` slices found none (`long[..40]` in `contention.rs` is a sha), so no broader slice audit is in scope.

---

## Open Questions {#open-questions}

- **How long is the gate's silence deadline?** It must sit well above the longest legitimate gap between replay frames during a real restore — dominated by the deck's own ingest of a large `replay_batch`, which on the eucit session is a single 14.7 MB wire line — and well below a user's patience. Settled by measuring ingest gaps on the largest sessions in the corpus; a number in the 10–20 s range is the expectation, and it should be one named constant beside the preflight's 12 s.

- **Does the deadline's clock live in the deck or arrive from tugcast?** With [B02] and [B04] in place tugcast will nearly always deliver an error frame first, which argues the deck's own timer is a backstop and can be simple. But 2026-09-20 is the proof that "tugcast will say so" is the assumption that failed, so the deck-side timer must not depend on any frame arriving. The open part is only whether the two share a constant.

---

## Non-goals {#non-goals}

- **Making the restore gate dismissable.** Considered as the quick fix and rejected: while the reveal task really is running there is nothing behind the modal to interact with, and an Escape that appears to do nothing is worse than none. The deadline in [B01] removes the case where dismissal would have helped.

- **Chunking the restore so input can interleave.** Already tried and rejected for reasons recorded in `tug-restore-gate.tsx`'s docblock; nothing here reopens it.

- **Bounding `replay_batch` line size.** The 14.7 MB line was the first suspect and was cleared: `Bun.write` delivered it whole under a slow reader, the relay and merger forwarded it, and the deck ingested it. It may deserve attention as a performance matter; it is not part of this failure.

- **`panic = "abort"` for tugcast.** It would make a relay panic loud by killing every session at once. [B02] and [B03] get the loudness without widening the blast radius, which is the opposite of what this brief is for.

- **A general audit of `unwrap`/index panics across tugcast.** The point of [B02]–[B05] is that the *next* panic, wherever it is, costs one card and leaves a log line. Hunting panics one by one is the approach this brief replaces.

---

## Exit {#exit}

**An arc.** The order is set by blast radius, not by layer:

1. Land [B06] — the `shell_ops` char-boundary fix and its test, as they stand in the working tree.
2. The deck-side silence deadline on the restore gate ([B01]): a card past it drops out of `restore-gate-store`'s fold and raises `lastError`. Tests at the pure-predicate level (`session-card-restore-gate.ts`) and one app-test that withholds `replay_complete` and asserts the modal closes and the card shows its error.
3. tugcast's panic hook ([B03]) — small, independent, and it makes every later step's failures legible.
4. Bridge-task panic containment ([B02]), with a relay test that injects a panic mid-bracket and asserts the log line, the closing error frame, the crash-budget tick, and the session-state frame.
5. The watchdog as a `select!` arm with a synthetic close ([B04]), and the teardown reset of `replay_brackets_open` ([B05]), tested with a scripted stdout that writes `replay_started` and then goes silent without EOF.

Steps 2 and 3–5 touch disjoint code (tugdeck vs. tugrust) and either half alone would have prevented the outage; they are ordered so the half that protects the whole app lands first.
