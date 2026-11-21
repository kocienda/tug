# The card's busy state answers to tugcast

**Purpose:** A Session card can stay "turn in flight" over a session that has no turn running. When it does, it refuses the join, holds back the join offer, and shows a live Stop that has nothing to stop. Nothing corrects it short of a stop-all-work and a reopen.

---

## Purpose {#purpose}

The user asked why `tug/sleek-creed` "got stuck at the end right at the moment that it was marking an audited arc". The session itself was not stuck. The audit turn ended cleanly at 20:44:32 UTC on 2026-11-21, and `tugtool arc mark liven-files audited` returned "liven-files is audited". The card was stuck: the `liven-files` arc's Session card (`4417e8fd`) woke at 21:43:38 still believing a turn was running.

The card's belief that a turn is running comes only from its own frame history. When that history is incomplete or wrong, the card has no way to learn otherwise. This brief decides that the belief must answer to tugcast, which always knows whether the session is mid-turn.

---

## Evidence {#evidence}

**[F01] The card slept through the end of the arc's implement stage, the rotation, and the whole audit turn.** The host declared the card dormant at 20:27:05, during an implement turn. The arc then ran another implement turn (20:27:37–20:41:30), rotated the card's session from `3b08273f` to `704aba75` at 20:41:35, and ran the audit turn (20:41:35–20:44:32). The card woke at 21:43:38. Read from `release-main`'s `tugcast.log` and `tugapp.log`. **(verified)**

**[F02] On waking, the card showed the audit turn frozen at the running `tugtool arc mark` Bash block, with no closing summary, and acted busy.** The join was refused twice ("Wait for the turn to finish", `turnInProgress:true`, at 21:43:44 and 21:43:51). The join offer's reveal had been held back with reason `turn-in-flight` since 20:47:22. The state cleared only after Stop (21:44:47), stop-all-work (21:45:03) and the card reopening (21:45:17). The join then completed at 21:45:32. The log lines are verified; what the card showed is the user's report. **(verified)**

**[F03] tugcast knew no turn was running.** The arc runner's ticks read `turn_active=false` from 20:44:32 on, and closed the stage with `decided=done action=done` at 20:44:38. The flag is kept per session in the supervisor's ledger entry (`tugrust/crates/tugcast/src/feeds/agent_supervisor/ledger_entry.rs`, `turn_active`). The merger sets it on a prompt or `wake_started` and clears it when a `turn_complete` or `turn_cancelled` crosses the pipe (`feeds/session_metadata.rs`). Across a replay bracket it is put back to what it was when the bracket opened (`ReplayLatch`), so a replay does not move it. **(verified)**

**[F04] The catch-up answer tugcode sent at wake carried the whole audit turn.** tugcode read 267 lines and translated them to 154 frames, one turn. Offline, the translator (`translateJsonlSession`, `tugcode/src/replay.ts`) gives 154 frames ending in `turn_complete … success` only for the full 267-line transcript. Every shorter prefix gives fewer frames. The byte count tugcode logged (1,593,930) differs from today's 267-line prefix (1,597,270), because Claude Code rewrites some non-message lines in place. The message content matches. **(verified)**

**[F05] The real card store, given that answer, ends idle with the summary shown.** I drove `CodeSessionStore` with the exact frames in a scratch test, under several variations:
- the card settled when it slept, or mid-turn;
- with `noteDormant`, the ask id, and `replay_batch` envelopes.

Every run ends idle, `canInterrupt` false, with the summary as the turn's last message. Entering a catch-up's answer already drops any turn the card held through its sleep (`handleReplayStarted`, `supersedesCycle`, `tugdeck/src/lib/code-session-store/reducer.ts`). Dropping the opening wire line, or the first two or three lines, also ends idle. **(verified)**

**[F06] The path that produced [F02] is not reproduced.** The logs don't record which frames the card received or which reducer branch ran. No `code-session-store` or `body-dormancy` warning was logged at wake, so none of the logged refusal paths fired. One candidate stays plausible but unconfirmed. tugcast's per-client loop is an unbiased `tokio::select!`, and the body posts the catch-up ask just before the subscribe that widens its session scope. So frames can be filtered against the old, empty scope. Nothing counts such drops in the log. **(not verified: inference from the code)**

**[F07] The card's busy state is derived from its own frame history alone.** `turnInFlight` in `tugdeck/src/components/tugways/cards/session-card.tsx` reads `codeSessionStore.getSnapshot().canInterrupt`. Both the join gate and the passive reveal gate (`joinOfferRevealHold`, `tugdeck/src/lib/join-offer-reveal.ts`) read it. The reducer moves that state from the frames it hears, and keeps a turn in flight at a replay's close when one survives the bracket ("never-drop chain link 13"). No turn-active fact from tugcast reaches the deck. The deck does receive a per-card `sessionState` (`live`, `closed`, `failed`, `childless`), but it says nothing about a turn. **(verified)**

**[F08] A catch-up that never answers leaves the held turn standing, by design.** `catch-up.test.ts`: "a catch-up that never answers leaves the cycle standing". With no answer, the card has nothing to replace the cycle with. That is correct as far as the card's own knowledge goes, and it is the case where an outside fact is the only way out. **(verified)**

**[F09] tugcast's turn flag already reaches the shell, on every session row.** The session ledger keeps a per-segment turn latch beside each row (`SessionLedger::set_turn_active` / `turn_active`, `tugrust/crates/tugcast/src/session_ledger.rs`). The recorder pushes the row again whenever the latch moves (`record_turn_latch`, `feeds/agent_supervisor/recorder.rs`), and `build_session_updated_frame` writes it as `turn_active` on every `session_updated` push and every `list_sessions` row. The deck's `SessionRow` carries it (`turn_active?`, `tugdeck/src/protocol.ts`; absent means unknown, never idle). The shell already reads it, through `latchOf` in `tugdeck/src/lib/bodiless-facts-store.ts`, as "the one source of a card's phase while the card's body is not listening". The same ledger row is what `deck.cards` `sessionState` is projected from (`publishDeckCards`, `tugdeck/src/lib/body-shell.ts`). So the first carrier option is one field on `DeckCardFacts`, read by the same row lookup. **(verified)**

**[F10] The flag arrives on CONTROL, with no mark ordering it against the card's own frames.** The row rides the shell's CONTROL feed. The body's frames ride its own connection's `CODE_OUTPUT`. The row's only time marks are wall-clock stamps: `last_used_at`, and `last_turn_end_at`, which a cancelled or errored end never writes. This allows a real misfire. The card hears `turn_complete` and sends a queued prompt at once. Then the row push saying the old turn ended reaches the shell. If that push is an edge under [B04], it finds the card busy on its new turn and the flag idle, and would end a turn that has just begun. A session-scoped frame on the card's own feed does not remove the race either: the latch's frame for the old turn would still come after the card had sent the new prompt. **(verified from the code; the race itself is inferred)**

**[F11] "Busy" on the card is the turn, not the session's background work.** `canInterrupt` is true only in turn phases (`phaseCanInterrupt`, `tugdeck/src/lib/code-session-store/lifecycle-state.ts`). Background jobs are shown in the `JOBS` cell ([D102]), and stopping them is a separate verb (`stop_all_work`). So the turn latch, not tugcast's "finished" (`!turn_active && open_jobs.is_empty()`), is the fact the card's busy state should answer to. **(verified)**

**[F12] A wake turn is covered by the same latch.** The merger sets the latch on `wake_started` as on a prompt, and clears it on the turn's end ([F03]). The card's `waking` phase is one of the phases `canInterrupt` covers. So [B02] covers a wake turn with no rule of its own. **(verified from the code)**

**[F13] The two follow-ups are in the working tree, uncommitted.** Every catch-up now writes one `tugcast.log` line when it ends: `deck: catch-up <ending> source="catch-up"`, with the card, the session, the ask, the frames and turns its answer carried, and the card's phase, `canInterrupt` and held cycle before the ask and after the close (`tugdeck/src/lib/code-session-store/catch-up-log.ts`). The router writes one line per catch-up answer, saying how many of its frames the body's filter sent and how many it refused, and by which rule: scope, dormancy, or feed (`CatchUpTally`, `router.rs`). That line confirms or rules out the race in [F06]. A catch-up now also carries the ancestor turns a card slept through, so the content half of [B03] can be repaired across a rotation. **(verified by tests)**

---

## Decisions {#decisions}

**[B01] tugcast's turn flag is the authority on whether a turn is running. The card's derived belief yields to it.** The card can lose frames: by sleeping, by a race at wake, or by a path not yet found ([F06]). tugcast cannot lose them, because the merger sees every frame that ends a turn ([F03]). Repairing each lossy path one by one leaves the next unknown path with the same symptom. One authority closes the whole class. This rules out a card that stays busy against a tugcast that says the session is idle. It would be revisited only if the flag itself turned out to be unreliable, for example a turn that ends with no `turn_complete` or `turn_cancelled` on the pipe.

**[B02] The correction runs one way: a card that believes a turn is running over a session tugcast calls idle ends that turn.** The opposite disagreement, where the card is idle and tugcast says busy, is left alone. A running turn's frames are still on their way, and the card cannot make up a turn it has not heard. Ending the turn means the held cycle is closed: no live Stop, the composer usable, the gates open. Nothing the card holds is presented as a finished turn it never received.

**[B03] A turn ended by the correction is followed by a catch-up for what the card missed.** The card was busy because it missed the turn's end, so it is missing that turn's content too ([F02]: no summary). Closing the cycle without re-asking would leave the transcript frozen where it stopped. The ask is the existing catch-up, for the turns after the ones the card holds. This keeps the content repair on the one path that already rebuilds a transcript, rather than adding a second one.

**[B04] The card checks its belief at fixed edges, and when the flag changes, never on a timer.** The edges:
- when a catch-up closes, answered or lapsed;
- when the wire reconnects or the card's session binding is acknowledged again;
- whenever tugcast's flag for the card's session changes while the card believes a turn is running.

The last edge heals a loss that happens with no reconnect at all. Following the project's rule against polling, the card watches the fact and never asks on an interval.

**[B05] The correction is read after a replay bracket closes, never inside one.** tugcast restores the flag across a bracket ([F03]), and the reducer may legitimately hold a turn in flight through one. Checking only after the close means the correction never fights a replay that is still delivering the turn's end.

**[B06] Every correction is said in the log.** A card the correction had to fix is evidence that some path lost a frame. A `tugcast.log` line naming the card, the session, what the card believed, and which edge caught it is how the next such path gets found rather than silently healed. This is the same discipline as the join gate's landing receipts.

---

## Open Questions {#open-questions}

- **Which carrier brings the flag to the card.** Read ([F09], [F10]). The flag already reaches the shell on every session row, so one field on `deck.cards` is the cheap path. Neither carrier orders the flag against a queued send. Whichever carries it, the correction needs a mark saying which turn the latch's idle is about. The proposal: the latch records the submission id of the prompt that opened it (a wake turn has none), and the card ends its cycle only when the flag is idle and names the submission the card's own cycle sent, or, in `waking`, names no newer submission. Still to settle: the mark, and whether it rides the row or a frame.
- **Whether "busy" means turn running or session not finished.** Read ([F11]): the turn. Background jobs have their own cell and their own stop.
- **A wake turn.** Read ([F12]): the latch covers it, and [B02] needs no rule of its own. Only the ordering mark has to say what a wake turn compares against.

---

## Non-goals {#non-goals}

- **Logging every catch-up's outcome.** Agreed as a separate follow-up, done after this brief: one `tugcast.log` line per catch-up (answered, lapsed or set aside; frames applied; the card's state at close). [B06] covers only corrections.
- **The catch-up's missing ancestor turns.** Also a separate follow-up. When the card holds any turn, `catchUpOverHeld` in `tugcode/src/replay-runner.ts` skips the lineage prefix and replays only the newest session. So a card that slept through a stage rotation never receives the turns it missed from earlier sessions. Here those were the four implement turns from 20:27 to 20:41. It is a real defect but did not cause [F02].
- **Fixing the specific lossy path behind [F02].** It is unidentified ([F06]). [B01] is chosen so that the card heals whichever path it was. The logs from the two follow-ups are how it gets named.
- **Closing the ask-before-subscribe race by re-ordering the body's wake.** Rejected. The order is a recorded decision ([B03] of `briefs/body-lifecycle-fixups-brief.md`: ask first, so no live frame precedes the bracket). If the race turns out to be real, it should be closed in tugcast, by letting the catch-up ask widen the body's session scope in band, the way it already withdraws dormancy in band (`catch_up_wakes_card`, `router.rs`). Not by reversing that decision.
- **Letting tugcast drive the card's transcript.** The flag decides whether a turn is running, never what a turn contains. Content stays the catch-up's job ([B03]).
- **A periodic re-check.** Ruled out by [B04].

---

## Exit {#exit}

An arc. First steps, in order:

1. Settle the carrier and the meaning of busy (the first two open questions), by reading the session-state projection and how background jobs appear on the card. Read: [F09]–[F12]. What is left is the ordering mark of [F10].
2. Carry tugcast's turn flag to the card for its session.
3. In the card's store, add the correction at the [B04] edges, after any bracket ([B05]). It closes the held cycle ([B02]), asks a catch-up ([B03]), and logs a line ([B06]). Tests drive the store through a held cycle with no answer ([F08]) and an idle flag, and assert the card ends idle and asks for the missing turns.
4. Confirm the join gate and the reveal gate open once the correction lands. They read `canInterrupt` and need no change of their own ([F07]).

The follow-ups in Non-goals (logging each catch-up's outcome, and replaying the ancestor turns a sleeping card missed) were done first, by the user's choice, and are in the working tree ([F13]).
