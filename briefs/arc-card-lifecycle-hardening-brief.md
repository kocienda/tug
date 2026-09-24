# The arc card's lifecycle: one bridge, one live segment, one honest answer to "busy"

**Purpose:** An arc that had finished cleanly presented itself as wedged for seven hours, refused its join as "still working", and after the card was closed went on reporting itself live. Every fault is a place where the card is a *line* but the machinery keys on a *segment*, and the fix is to make the segment-keyed shapes unrepresentable rather than to patch the one that fired.

---

## Purpose {#purpose}

The report, in the user's words: *"What is wrong with this session and its arc? It is completely wedged. Really pretty colossal failure here. I even tried to close the session, but it still reports itself as live."* And the ask: *"I want a complete fix to harden these code paths and make it far less likely, ideally impossible, to wind up in this broken state again."*

Observed 2026-09-24, instance `release-main`, project `tug`, arc `release-tug`, card line `59e8e524` (title *sparkle-xp*), audit segment `1b94765b` (callsign *comfy-arena*). The arc itself was fine: it walked eight steps, audited, marked, and the join later landed as `068522c16`. What failed was everything around the card once the wheel had rotated it through four stages and the deck reloaded.

---

## Evidence {#evidence}

**[F01] The arc was done, and nothing was waiting on it.** The arc log (`~/Library/Application Support/Tug/projects/-Users-kocienda-Mounts-u-src-tug/arc-log.md`) carries `audited` at 03:00:31Z, `arc-done` at 03:00:51Z, and `068522c16 joined via card` at 10:32:38Z. The join pilot reconciled at 03:00:31Z with a clean candidate. The tick log shows `idle=true turn_active=false open_jobs=0 action=none` every minute from 03:03Z to 10:27Z. Nothing was working; the join should have been on offer the whole night. **(verified)**

**[F02] The join was refused as "holder busy" three times and accepted the moment the segment was closed.** `landing-receipt kind=join verdict=refused reason=holder … holderBusy:true turnInProgress:false` at 10:28:04Z, 10:28:53Z, 10:28:58Z. `ledger.mark_closed 1b94765b` at 10:30:01Z. `verdict=ok … holderBusy:false` at 10:32:27Z. The refusal is `holders_busy` in `tugrust/crates/tugcast/src/feeds/changeset.rs:1616`, which is `busy.contains(bound_session)`. **(verified)**

**[F03] A replayed wake frame latches a session mid-turn with no turn to end.** `tugrust/crates/tugcast/src/feeds/agent_supervisor.rs:12047` sets `entry.turn_active = true` on any `wake_started` frame, unconditionally. The turn-end branch four lines below is gated on `entry.replay_brackets_open == 0`. So a resumed transcript that carries a wheel wake opens a turn during replay whose own replayed end is discarded. The first tick after the resume at 10:27:36Z reads `idle=false turn_active=true opener="wake" prompt_turns=0 wake_turns=0` for a session that had just replayed `sessions=7 frames=6739` of lineage. The only ageing mechanism, `reap_stuck_jobs` at `:727` with `JOB_REAP_HORIZON` of thirty minutes, drops jobs and never touches the turn flag. The doctrine on that function, *"the one direction the busy latch is allowed to fail in is offered late, never wedged forever"*, was written for jobs and does not cover the turn. **(verified)**

**[F04] The holder gate compares a segment id against a set of card ids.** `bound_session_by_arc` (`tugrust/crates/tugcast/src/session_ledger.rs:5509`) returns the most recently used `live` row carrying `arc_id`; `seat_line_binding` had moved the binding onto the audit segment at 02:51:48Z. `busy_session_ids` (`agent_supervisor.rs:781`) is keyed by the supervisor's `tug_session_id`, which for a rotated card stays the card's original id: during the audit every job frame was logged as `session_id=76547365`, while the segment doing the work was `1b94765b`. So for a rotated arc the gate is false by construction while a stage is genuinely working, and became true only because the reload gave the segment its own supervisor entry (F05). Both failure directions exist and neither is the truth. **(verified)**

**[F05] A deck reload spawns a second bridge for a segment the card's first bridge already hosts.** The card's original bridge, `tugcode` pid 95711 for `76547365`, spawned the audit's `claude` (pid 63836, started 02:51:48Z, still alive) inside itself on rotation. When the deck reconnected at 10:27:32Z (`Client connected client_id=2`), the card asked for `tug_session_id=1b94765b` in resume mode; the supervisor's `phase1` (`agent_supervisor.rs`, `ledger.entry(tug_session_id).or_insert_with`) found no entry under that key, logged `inserted=true`, and spawned a second `tugcode` with `claude --resume 1b94765b`. The segment id reaches the deck because `sessions_recorder.record` (`agent_bridge.rs` ≈2100) files each segment's row under its claude id, and a reloading card seats on `resume_segment_for_line` (`session_ledger.rs:4236`), which prefers the newest live row. `do_close_session` (`agent_supervisor.rs:5774`) removes exactly the entry named, so closing the card killed the second bridge and left the first. State now: the card is absent from `dev.tugapp.deck.layout`, pids 95711 and 63836 are alive, and `sessions.db` says `76547365` is `live`. **(verified)**

**[F06] Rotation never closes the segment it rotated away from.** On line `59e8e524`, `sessions.db` holds four `live` rows: `76547365`, `d29269db` (devise), `69cb9194` (review), `c6faff99` (implement), plus the audit row the user closed by hand. The rotation path (`agent_bridge.rs` segment handling; `arc_runner.rs:2101 rotate`) records the new segment and moves the arc binding, and marks nothing closed. The only thing that ever demotes them is `demote_live_to_closed` at tugcast startup (`session_ledger.rs:5871`). `LineOwnership.any_live` (`:4287`) is what the Choose Session dialog renders as **live**, so a line with any stale row reads live forever within one tugcast lifetime. **(verified)**

**[F07] The pilot and the strip inherit the lie.** `arc_entries` skips the join pilot while the holder is busy (`changeset.rs:1705`), so the fit was never re-verified after the audit's fix commit and the shade showed *unverified* with the caution glyph. The arc runner also kept ticking every minute for seven and a half hours after `arc-done`, `stage="audit" action=none`, until the join removed the arc. **(verified)**

**[F08] This is the third surface with the same root.** `briefs/claim-orphans-the-live-session.md` found the changes ledger keyed on a raw segment id; `briefs/wheel-rotation-strands-the-arc.md` found the arc verbs reading `$TUG_SESSION_ID` frozen at spawn. Both were answered per caller with a line expansion. The supervisor ledger, the holder gate, and the bridge's identity are the callers nobody expanded. The finding of that second brief stands: *"the hazard is being answered per-caller, so the next caller written will have it again."* **(verified by reading both briefs)**

---

## Decisions {#decisions}

**[B01] Replay can never leave a session non-quiet.** The `wake_started` setter takes the same `replay_brackets_open == 0` guard the turn-end branch has, so the two are symmetric. And at the close of the outermost replay bracket the entry is asserted quiet: `turn_active` false, `open_jobs` empty; if either is set, it is cleared with a `warn!` naming the frame kind that set it. The guard fixes the frame we know about; the bracket-close reset is what makes the next unforeseen replayed shape harmless. A test replays a transcript carrying a wake turn and asserts the entry is quiet when the bracket closes.

**[B02] A turn, like a job, ages out.** `is_quiet` stays the conjunction it is, but `turn_active` gets the horizon that jobs already have: a turn that has produced no frame for `JOB_REAP_HORIZON` while its bridge has no live `claude` child (`live_session_processes`) is reaped with `event = "turn_reaped"`. The doctrine at `reap_stuck_jobs` is extended to the turn flag verbatim: the latch may fail toward *offered late*, never toward *wedged forever*. This does not touch a genuine long turn: a real turn streams partial messages and has a child under the bridge.

**[B03] One card, one bridge, keyed by the line.** A `spawn_session` naming a session the supervisor already hosts attaches to the existing entry instead of inserting. The lookup at `phase1` becomes three-way: the requested `tug_session_id`; any entry whose `claude_session_id` equals it; any entry whose `line_id` is the requested id's line and whose `card_id` is the requesting card. Only when all three miss does a bridge spawn. The reload in F05 then re-holds bridge 95711 rather than spawning a rival. The entry's `tug_session_id` remains the line's seat for its whole life, which is already how the supervisor behaves between reloads; this makes the reload agree.

**[B04] Close is by card, and a card owns every bridge on its line.** `close_session` tears down every ledger entry carrying the card's `card_id` or the card's `line_id`, through the same `do_close_session` path, and marks every live row on the line closed. The existing `headless_close_refused` rule (a card that took the session over keeps it) is preserved by resolving the holder before the sweep. A bridge cannot survive its card because there is no bridge that is not the card's.

**[B05] At most one live segment per line, enforced in the ledger.** Recording a rotation segment marks the parent segment `closed` (`demoted = 0`, the binding already moves) in the same transaction. The invariant is checked where it can be broken: the insert path warns and demotes the older row if a second live row would appear on a line, and `demote_live_to_closed` at startup keeps only the newest live row per line rather than demoting all of them. `any_live` then means what the dialog says it means.

**[B06] The holder gate answers for the line.** `holders_busy` resolves the bound session to its supervisor entry through the line, the same expansion `tugchanges-core::ledger::line_segments` gave `tugtool changes`. `bound_session_by_arc` returns the line's seat, and the *"two live sessions carry one arc binding"* warn becomes a test that fails. With B03 there is exactly one entry per line, so the resolution is a lookup, not a search.

**[B07] The supervisor reaps orphan bridges; a restart is not the remedy.** After a client reconnects, every open card re-announces its session. An entry that no client holds and no card names once that settle window has passed is closed through `do_close_session` with `event = "bridge_orphan_reaped"`. Today the only reaper is a tugcast restart, which is what F05 leaves the user with.

**[B08] A Done arc leaves the wheel.** `finish` on `ArcAction::Done` evicts the arc's runner state so the per-minute tick ends with the arc rather than with the join. This is hygiene beside the others, but the 450 identical tick lines are what made the log hard to read during the investigation, and a runner still clocking a finished arc is one more place a stale reading can come from.

**[B09] Each invariant lands with its tripwire.** Unit tests for B01, B02, B05, B06 in the crates that own them. One app-test for the whole shape: open an arc card, rotate a stage, reload the deck, assert one bridge in `live_session_processes`, one live row on the line, and the join offered. `@covers` names the supervisor, the session ledger, and the changeset feed.

---

## Open Questions {#open-questions}

- **The settle window for B07.** Reconnect re-announcement is not instantaneous, and a background or headless card (see `briefs/background-session-card-adoption-brief.md`) may legitimately be held by no client for a while. The window has to be longer than a reconnect and shorter than a user noticing. Reading the adoption brief and the `client_sessions` hold model settles it; it did not need the user.
- **Whether the deck should stop sending segment ids at all.** B03 makes the server correct whatever the deck sends. A deck that sends the line's seat id is cleaner but touches `resume_segment_for_line` callers and the card's persisted state; it is a follow-up, not a condition.

---

## Non-goals {#non-goals}

- **Removing or weakening the holder gate.** The gate exists so a join is never offered while backgrounded tests are still deciding whether the arc is any good ([P04], [P08]). The fault is that it read the wrong session, not that it read one.
- **Changing how the wheel rotates stages.** Stages still rotate on the card's own bridge, one scroll, labelled dividers. This brief makes the ledger and the supervisor agree with that model; it does not change the model.
- **A manual repair verb.** `tugtool session close`, a kill button, or a "mark closed" gesture would let the user dig out of the state. The state must not be reachable.
- **Relying on `demote_live_to_closed` at startup.** It stays as the crash backstop it was written to be. It is not the fix for rows that go stale inside one process lifetime.
- **The changes-ledger and arc-verb line expansions.** Already briefed and landed separately; cited in F08 as the pattern, not reopened here.
- **The `terminal_registry` `procStart mismatch (pid reuse)` noise** seen on every reconnect for pid 63836. It is a symptom of the same second-bridge shape and should disappear with B03; if it does not, it is its own finding.

---

## Exit {#exit}

An arc. The first steps, in the order they must land:

1. B01, the replay guard and the bracket-close reset, with its test. Smallest change, closes the wedge the user saw.
2. B05 and B06, the ledger invariant and the line-resolved holder gate. These are what make F04 and F06 unrepresentable and they share the `session_ledger.rs` seams.
3. B03 and B04, bridge identity on spawn and close by card. These change the supervisor's `phase1` and `close_session` and are the largest step.
4. B02 and B07, the two reapers, which only make sense once there is one bridge and one live row to reap against.
5. B08, evicting a Done arc from the runner.
6. B09, the app-test over the reload shape, last, because it needs everything above to be green.
