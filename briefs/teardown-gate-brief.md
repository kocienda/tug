<!-- brief-skeleton v1 -->

# A teardown Tug starts never raises Protocol error

**Purpose:** A Session card shows "Protocol error: Claude process stream ended unexpectedly" over turns that Tug itself ended. The banner should mean one thing, that Claude died and Tug did not ask it to, and today six different deliberate acts can raise it.

---

## Purpose {#purpose}

Tito reported, from his debug build:

> Lately I have seen this issue quite a bit in Tug-debug: Protocol error, Claude process stream ended unexpectedly. Reported by the bridge at `drain_eof_open_turn`. When I click DISMISS … it stops right there. Then I type "Continue" and resumes fine. Weird, but very reproducible.

The first cause was found and contained in `06f52ed93f`: an effort change no longer kills a running turn. Tito then sent a report of every `claude_stdout_eof_open_turn` in his logs for 14 days: 17 incidents across `debug-main` and `release-main`. That report confirmed the first cause, corrected the explanation of its trigger, and showed more holes of the same kind. This brief is the complete fix: every way Tug ends a Claude process is made to decide, in one place, what happens to a turn that is running.

---

## Evidence {#evidence}

**[F01] The banner is chosen by one flag at stream EOF.** `signalEofToActiveTurn` in `tugcode/src/session.ts` runs when Claude's stdout closes. For an open turn it emits `turn_cancelled` when `turn.interrupted` is set, and `error` at site `drain_eof_open_turn` otherwise. The deck draws that `error` as the Protocol error banner. Whether a deliberate kill raises the banner therefore depends only on whether its caller set the flag first. **(verified, read from the code)**

**[F02] The flag is set per caller, and most callers do not set it.** `killAndCleanup` is called from the effort respawn (`respawnInPlace`), `sessionFork`, `sessionContinue`, `newSession`, `forceTerminateAndRespawn`, `handleStopAllWork`, `reattachAfterEof`, `shutdown`, and from `applyConversationRewind` in `tugcode/src/rewind.ts`. Only `newSession`, `forceTerminateAndRespawn` and `handleStopAllWork` mark the open turn interrupted before the kill. **(verified, read from the code)**

**[F03] Six of Tito's 17 incidents are the effort respawn.** Incidents 1 and 3–7 each have a `Setting reasoning effort: medium` line 20–70 ms before the process goes to `terminating`. **(verified, from the report)**

**[F04] The effort trigger is a new card's first prompt, not a card remounting.** In incidents 1, 3, 4 and 5 the card spawns a `new`-mode session, the first user prompt is recorded, and the effort line follows about 25 ms later. The first Claude was spawned without `--effort`; the respawn carries `--effort medium`. Every new card with a non-default effort lost its first prompt. **(verified, from the report)**

**[F05] It is a per-instance setting, not a debug-build property.** All 22 `Setting reasoning effort` lines are in `debug-main`, beginning 2026-11-26; `release-main` and `release-detached-3937df43` have none. The earlier guess that a debug build remounts cards more often is withdrawn. That Tito set a Medium default in that instance on that day is inference from the counts. **(counts verified; the cause of the counts is inference)**

**[F06] `06f52ed93f` contains the effort kill but leaves the first turn at the wrong effort.** The deck's restore now waits while a turn runs (`resolveEffortRestoreAction` in `tugdeck/src/lib/effort.ts`), and `effortChange` in `tugcode` defers its respawn to the turn's close (`applyDeferredEffort`). A new card's first turn therefore runs at the default level, and Claude is respawned after it. **(verified, read from the code and its tests)**

**[F07] Permission mode already rides the spawn end to end.** `encodeSpawnSession` in `tugdeck/src/protocol.ts` carries `permission_mode`; `agent_bridge.rs` in tugcast passes `--permission-mode` to tugcode; `tugcode/src/main.ts` parses it and hands it to the `SessionManager` as `initialPermissionMode`. Effort has no such path: it reaches tugcode only as a post-spawn `effort_change` frame. **(verified, read from the code)**

**[F08] An effort respawn is not a full spawn.** `respawnInPlace` calls `spawnClaude` and `startStdoutDrain` and nothing else. `respawnResume` and the first spawn also start the stderr reader, install the early-exit watcher and send the `initialize` handshake. Two consequences are visible in the report: in incidents 2 and 13 the process phase is still `spawning` hours after an effort respawn, and in incident 6 a session already spawned with `--effort medium` was sent the same effort again, because the capabilities the deck compares against were never refreshed. **(code verified; the link from the missing handshake to the re-send is read from the code, and the report is consistent with it)**

**[F09] `isShuttingDown` is not cleared after most respawns.** `killAndCleanup` sets it. Only `forceTerminateAndRespawn`, `reattachAfterEof`, `handleStopAllWork` and the rewind's `provePostRewindSpawnReady` clear it. After an effort respawn, a `/new`, a rotation, a fork or a continue it stays set, so a later real crash logs `self_inflicted=true` and the early-exit watcher, which returns early on the flag, ignores it. All 17 incidents log `self_inflicted=true`, which is why that field did not separate causes. **(verified, read from the code)**

**[F10] Prompt retraction can kill the turn after the one it retracts.** `applyPromptRetraction` in `tugcode/src/rewind.ts` checks `isClaudeIdle()`, then awaits the JSONL read, then calls `applyConversationRewind`, which kills Claude. Nothing re-checks idleness after the await. Incident 13, in `release-main`, shows a kill with no effort line and no card close, followed by a `--resume` spawn and `tugcode.prompt_retracted`. That the user's next prompt opened a turn inside that gap is inference: the report holds 11 lines for the incident, and none records the prompt. **(the race is verified in the code; that incident 13 is this race is inference)**

**[F11] Nine incidents are card closes.** Incidents 8–12 and 14–17 each have `ledger.mark_closed keep_binding=false` for the session within a second before the kill, several inside a `supervisor.card_close_sweep`. The error frame goes to a card that is closing. **(verified, from the report)**

**[F12] Incident 2 is unexplained.** A rotation into stage `audit` killed Claude 58 ms after a user prompt was recorded, and the turn ended as an error. `newSession` marks an open turn interrupted before its kill, and `handleUserMessage` waits on the respawn gate before it opens a turn, so the orderings read from the code do not produce this. The report holds 8 lines for it. **(not explained)**

**[F13] The terminal registry logs one mismatch many times.** Incident 6's window holds about 35 `terminal registry: procStart mismatch (pid reuse), entry skipped` lines for one pid and session in 1.5 seconds, from `tugrust/crates/tugcast/src/terminal_registry.rs`. **(verified, from the report)**

---

## Decisions {#decisions}

**[B01] The banner means Claude died and Tug did not ask it to.** Every teardown Tug starts either waits for the running turn or ends it as a cancel. This is the rule the rest of the brief serves. It rests on [F01]: the banner tells the user nothing they can act on when Tug caused it, and a banner that is usually Tug's own doing teaches the user to dismiss it.

**[B02] `killAndCleanup` decides the open turn's fate itself, at kill time, and takes a required reason.** The per-caller flagging in [F02] is replaced by one decision inside the teardown: an open turn that has no result is marked a recovery cancel there, first writer wins on the cause as today. A caller cannot forget what it is not asked to do. Reading the turn at kill time, not at the caller's earlier check, also removes any window between a caller's check and its kill.

**[B03] Callers are of two kinds, and the kind is part of the reason.** Rotation, `/new`, fork, continue, card close, shutdown, the watchdog and stop-all may end a turn: the gate cancels it. Effort, prompt retraction and directory removal must not end a turn: each is refused or deferred before it reaches the gate. If one of them reaches the gate with a turn open anyway, the gate logs it as a bug and still cancels cleanly. A banner there would punish the user for our defect; the log is what we need.

**[B04] Fork and continue over a running turn cancel it.** They are the same deliberate act as `/new`, which already cancels. Refusing mid-turn was the alternative; the deck remains free to gate the gesture, and tugcode does not rely on it.

**[B05] Effort rides the spawn request.** The deck puts the card's seed effort on the spawn, tugcast passes it to tugcode as an argument, and the first Claude starts with `--effort`. It follows the permission-mode path in [F07] part for part. This removes the trigger in [F04] where `06f52ed93f` only contained it, and ends the wrong-effort first turn in [F06]. The deferral from `06f52ed93f` stays: it is the route for a level changed after spawn.

**[B06] An effort respawn is a full spawn.** `respawnInPlace` starts the stderr reader, installs the early-exit watcher and sends the handshake, as `respawnResume` does. Capabilities then report the effort in force, the deck's restore settles without sending, and the phase leaves `spawning`. This closes [F08].

**[B07] `isShuttingDown` is cleared where a process is spawned, once.** One site on the spawn path replaces the four scattered clears in [F09]. [B02] reads the flag's meaning into what the user sees, so it has to be true: a real crash after any respawn must log `self_inflicted=false` and reach the early-exit watcher.

**[B08] Prompt retraction runs under the respawn gate and re-checks idleness immediately before the kill.** If a turn has opened it degrades to a plain interrupt, as its other guards already do. This closes the race in [F10] whether or not incident 13 was that race.

**[B09] Every teardown logs who asked.** The gate writes one lifecycle line naming its reason and whether a turn was open. This is the trap for [F12]: the next unexplained kill names its caller. Incident 2 stays open, and nothing here claims to fix it.

**[B10] The terminal registry logs a pid mismatch once per pid and session.** It is noise on a hot path ([F13]), small, and found in the same report, so it lands here.

**[B11] The tests that pin today's per-caller behaviour keep their guarantee.** `rotation-cancels-open-turn.test.ts` and `effort-change-open-turn.test.ts` assert that a rotation and an effort change raise no banner. Both guarantees hold under [B02]; where the mechanism moves, the assertions move with it and still assert the same thing.

---

## Open Questions {#open-questions}

- **What caused incident 2.** It cannot be settled from eight log lines ([F12]). The line from [B09] in a future report would settle it. It does not change what gets built.

---

## Non-goals {#non-goals}

- **Explaining incident 2.** It is left open on purpose. [B02] may happen to close it; that is not claimed.
- **A live effort control with no respawn.** Claude Code offers no control request for effort, so applying one after spawn is a respawn. This brief makes that respawn rare and safe; it does not try to remove it.
- **Refusing fork or continue mid-turn in tugcode.** Rejected in [B04].
- **Suppressing the error frame on a closing card by filtering it in the deck.** The frame should not be written at all ([B02]); hiding it downstream leaves the log wrong.
- **Changing what the banner says or how it is dismissed.** The banner is right when Claude dies alone.

---

## Exit {#exit}

**An arc.** The parts, in an order that keeps each one testable:

1. The spawn site clears `isShuttingDown` ([B07]). It is the smallest change and [B02] depends on it.
2. `killAndCleanup` takes a reason, decides the open turn, and logs ([B02], [B03], [B09]); the per-caller flagging is removed; fork, continue, close and shutdown gain their cancel ([B04]). Unit tests: one per caller showing no `error` frame over an open turn, and a real crash still raising one.
3. Retraction under the gate with the re-check ([B08]), with a test for the race.
4. `respawnInPlace` as a full spawn ([B06]), with a test that an effort respawn sends the handshake and that capabilities then carry the effort.
5. Effort on the spawn request across deck, tugcast and tugcode ([B05]), with tests at each hop.
6. The terminal registry's once-only log ([B10]).

The verdict run is `at0096-effort-chip` and `at0197-scheduled-survives-respawn`, plus what `just app-test-select` adds for `tugcode/src/rewind.ts` and the spawn frame.
