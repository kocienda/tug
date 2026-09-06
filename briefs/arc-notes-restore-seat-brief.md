# A restored line replays every segment it has

**Purpose:** Restore `tug/eager-wrap` through the resume sheet and every arc quiet line the `arc-line-words` run wrote — *Arc opened*, *Run declared*, seven steps, seven rounds, the mark — stands in a block at the top of the card, above a transcript reading *4 of 4 · all loaded*, under a header that says 18 turns. Live, each line sat between the two tool calls it narrated. This brief settles why the restore replayed one segment of a three-segment line, and how the resume-sheet restore comes to replay the whole line exactly as the relaunch restore already does.

---

## Purpose {#purpose}

The user's report:

> Look at what happened when I restored `@tug/eager-wrap`. All these arc-related quiet line messages are out of place. All these messages must be seated *exactly* where they appeared in the flow of the conversation/transcript.

The quiet lines are durable ink, and the mechanism that seats durable ink was rebuilt in `1039faf1f` the same afternoon: every row is anchored to the transcript turn it followed, and rows a rotated card wrote under a retired segment's id were re-anchored at boot. That work was correct. The rows on this line name the right turns. The card never loaded those turns, so the rows had nothing to stand beside and took the fallback seat — clock order against a transcript that starts hours after they happened.

---

## Evidence {#evidence}

Times are UTC. The ledgers are `instances/release-main/sessions.db` and `instances/release-main/shell_exchanges.db` (read through `just db-inspect`); the log is `instances/release-main/Logs/tugcast.log.2026-09-05`; the supervisor is `tugrust/crates/tugcast/src/feeds/agent_supervisor.rs`; the deck's seat logic is `tugdeck/src/lib/code-session-store/reducer.ts`.

**[F01] The line has three segments and the card replayed one.** `lines` row `25be48ec…` (tag `eager-wrap`) owns three `sessions` rows: `d6b49eec…` (the door, 1 turn), `8b79f6a4…` (stage `implement`, 13 turns, forked from the door), `b3e4c268…` (stage `audit`, 4 turns, forked from implement). The restore's `replay::complete count=4` and the bar's *4 of 4* are the audit segment alone; the header's 18 is the line's sum. **(verified)**

**[F02] Every arc-note row is anchored correctly, into the implement segment.** All 27 arc-note rows (`shell_exchanges` ids 2125–2152) carry `tug_session_id = d6b49eec…`, the id frozen into the card's shells at spawn, and clocks from 15:41 to 17:38 local, while the implement segment was seated. The boot backfill ran — `backfills` carries `reanchor-rotated-lines-2026-09-04` — and a sampled anchor, `msg_011CejCwbxYE` on rows 2126 and 2127, occurs in `8b79f6a4….jsonl` and in neither other segment's file. The anchors name turns of the transcript a whole-line replay would load ([P10]). **(verified)**

**[F03] The relaunch restore replayed the line; the resume-sheet restore did not, four minutes later.** The log shows `b3e4c268…` resumed twice:

| time | path | card | `inserted` | `resume_claude_session_id` | lineage |
|---|---|---|---|---|---|
| 01:03:24 | relaunch (`session-restore.ts`) | `ac190e99…` | false | `b3e4c268…` | `lineage_prefix sessions=3 frames=1641` |
| 01:07:11 | resume sheet onto a fresh card | `010e817d…` | true | *(empty)* | *(no line)* |

The second is the screenshot. Both restores send the same `spawn_session{mode: resume}` from the deck (`resume-sheet.tsx` calls `fireRestore`, which is `session-restore.ts`'s `sendSpawnSession`); the deck sends no claude id on either. **(verified)**

**[F04] The lineage is seeded from a field the fresh entry has not filled in.** `do_request_replay` (`agent_supervisor.rs:8793–8801`) reads `entry.claude_session_id` and calls `replay_lineage` only when it is `Some`. A resume onto a card the ledger has never seen inserts a fresh entry (`inserted=true`) with `claude_session_id: None`, and the replay request is queued during spawning (`request_replay.queued reason="spawning_window"`) before tugcode's `session_init` announces the id. The relaunch path never sees this: `rebind_from_ledger` (`agent_supervisor.rs:11124`) copies the row's `session_id` into `claude_session_id` before any client asks. **(verified)**

**[F05] Two neighbours already take the fallback the lineage lookup does not.** `agent_bridge.rs` (near `spawn.child_invoke`) passes an empty `resume_claude_session_id` and lets tugcode resume `<tug_session_id>` itself, on the stated ground that tug and claude ids are equal for an un-forked session — which is why the 01:07 restore resumed the right transcript despite the empty field. In `do_spawn_session` the `line_id` derivation reads `claude_session_id.as_deref().or(Some(tug_session_id))` for the same reason. `replay_lineage`'s call site is the one reader of the id at spawn time without that fallback. **(verified)**

**[F06] The deck's fallback seat did what it says.** `insertInkAnchored` finds no loaded turn answering to an implement-segment `msg_id`, falls back to `insertTurnByTimestamp`, and a row older than the first loaded turn seats above it — the designed [L23] posture, a bad anchor costing a row its position and never its existence. `absorbArcNotes` never fires because no loaded turn spans the rows' clocks. Twenty-seven rows older than the audit segment stack at the top in clock order, which is the picture. Nothing in the deck is wrong here. **(verified in code)**

**[F07] Nothing crosses the seam.** `at0474`'s restore leg injects `replay_stage` frames straight into the store through `ingestFrame`, so it proves the deck draws a lineage it is handed and nothing about whether tugcast hands one. `replay_lineage`'s unit tests (`the_lineage_for_a_three_stage_arc…`, via `seed_arc_lineage`) are given an id directly. The `do_request_replay` tests (`test_request_replay_*`) cover live, idle, closed, and unknown entries and never a spawning one. A resume-sheet restore of a rotated line has no test on any layer. **(verified)**

**[F08] Behind the first defect there is likely a second, unverified.** With the lineage replayed, the load bar's *X* is `countClaudeTurns` over the whole scroll and its *Y* is the tip translator's `totalTurns` on `replay_complete`, so the bar would read *18 of 4*. This could not be observed because the lineage never loaded; it is deferred, not settled — see Non-goals. **(inferred from `session-load-control-bar-state.ts` and `handleReplayComplete`; the relaunch restore at 01:03 is where it would show)**

---

## Decisions {#decisions}

**[B01] The lineage seeds from the id the spawn resumes.** In `do_request_replay`, the seed is `entry.claude_session_id.clone().or_else(|| Some(tug_session_id.to_owned()))` before `replay_lineage` is called — the same fallback the spawner and the `line_id` derivation take, for the same reason: until tugcode says otherwise, the tug session id is the claude session id. A `mode=new` spawn has no fork edges under its id, so `lineage_chain` returns one element, `replay_lineage` returns `None`, and the request stays byte-identical to today's. A resume of an un-forked session is the same case. Only a rotated line changes, and it changes to what the relaunch path already does.

**[B02] The field's ownership does not move.** Filling `claude_session_id` on the fresh insert (mirroring `rebind_from_ledger`) would also fix this restore, but it turns a fact tugcode announces into a guess the supervisor makes, and the `session_init` reconciliation would then have a value to disagree with. The fallback in [B01] is a read, not a write, and leaves the announcement as the one writer.

**[B03] The seam is pinned on the supervisor.** Two tests beside the `seed_arc_lineage` fixture: `do_spawn_session(mode=resume)` for the **tip's** id on a card the ledger has never seen, asserting the queued `request_replay` frame carries a three-entry `lineage` with the stages in order; and the same gesture on a single-segment, stage-less line, asserting the bare `{"type":"request_replay"}` body. The first is the 01:07 restore as a test; the second is the byte-identity promise [B01] makes.

**[B04] The user's sentence is pinned on the deck once.** A case under `at0474`'s `@covers` seats arc-note ink rows for a three-segment line (the `list_shell_exchanges_ok` shape, anchors naming implement-segment `msg_id`s, clocks inside those turns' spans) and replays the lineage, asserting each `arc step … done` quiet line renders inside the turn whose span holds its clock, in message order, and that no quiet line stands above the first turn. That is *seated exactly where they appeared* as a DOM assertion. The frames are injected as `at0474` already does, because the wire shape is the pin and the supervisor's half is [B03]'s.

**[B05] `1039faf1f` stands.** The anchors it writes and the rows it repaired are confirmed right by [F02]. Nothing in the ink gateways, the backfill, `insertInkAnchored`, or `absorbArcNotes` changes.

---

## Open Questions {#open-questions}

None that this brief can settle by reading the code. The one open matter is deferred by decision, below.

---

## Non-goals {#non-goals}

- **The load bar under a lineage ([F08]).** Deliberately deferred: it cannot be observed until [B01] lands, and a bar that reads *18 of 4* is its own defect with its own brief. The first act after this arc joins is to restore `tug/eager-wrap` through the resume sheet onto a fresh card and read the bar. If it is wrong, the likely shape is that tugcode sums each ancestor's engine count into the tip's window metadata before the bracket closes, so *Y* becomes the line's count — the number the header already shows. That is a guess recorded so the next investigation starts from it, not a decision.
- **Changing the fallback seat.** Parking unanchored rows until their turn loads would make rows vanish, which [L23] forbids; seating them anywhere but clock order would be a lie. With the lineage present, the residual case is a windowed tip whose older turns are not loaded, and rows anchored to those seat by clock between the prefix and the window, which is the right order. [F06] is named so nobody reaches for it as the fix.
- **A lineage that spans project directories.** `collectLineagePrefix` opens each ancestor's JSONL under the resumed session's project dir. Every segment of this line ran under the checkout, so it did not bite here; an arc whose stages run in the worktree may be a different story, and it is not this one.

---

## Exit {#exit}

**A plan**, short. Its first step is [B01] with [B03]'s two tests in the same round; its second is [B04]; its phase boundary is the join, after which the user restores `tug/eager-wrap` through the resume sheet and reads the bar for [F08]. There is no third phase in this arc.
