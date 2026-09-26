<!-- brief-skeleton v1 -->

# A reconnect keeps the arc seat

**Purpose:** After a stopped arc was resumed, the Arcs card showed it executing on `tug/argent-reef` while that session's own card wore no arc: no `^wizard-downloads` in the masthead, a `TASKS · None` cell where `ARC` and the step list belong. A second card, `tug/tangy-phone`, was mid-arc from a `/arc` door prompt and read unbound on every surface at once. The two surfaces read one ledger and must not disagree, and a running arc must not read unbound. This brief settles both: a reconnect that loses the deck's seat, and a second tugcast that closed the live ledger's rows from outside.

---

## Purpose {#purpose}

The user's report, 2026-09-26:

> I started an Arc, but then needed to stop it. When I resumed it, the Arcs card got the word and updated, but the session card didn't. Its masthead did not adopt the arc suffix, and the TASKS list did not change to ARC and show the steps. This should be *impossible by construction*. This lack of sync between the Arcs card and its session cards must never happen.

The resume was when the user looked, not when the card broke. The card lost its arc at the first WebSocket reconnect after its stage rotation, the previous afternoon, and every later reconnect reproduced the loss. The Arcs card never noticed because it never asks the question the session card asks.

The second report, the same morning:

> Something deeper is broken here though. This session `@session:tug/tangy-phone` is running an arc (its most recently-submitted prompt from me is an /arc slash command), but it also is not bound to its arc. WHY?

That card had never reconnected mid-arc. Its seat was moved correctly through three rotations. What it lost was the ledger row itself: every segment on its line reads `closed`, and the one carrying the binding reads `closed` with `demoted = 1`, the mark of a tugcast startup demote. No tugcast restarted. A second one started.

---

## Evidence {#evidence}

**[F01] The ledger is right and has been right throughout.** In the live `release-main` instance, line `4becaf06…` (callsign `argent-reef`) holds two segments: `afed4f75…`, spawned 2026-09-25 14:06:56 UTC under card `e842a0ee…`, now `closed` and bound to nothing; and `04b41ea1…`, minted at 14:08:04 by the wheel's rotation into implement, `live`, `stage_label = implement`, bound to `tugarc/wizard-downloads#1790345241432-75389a`. `bound_session_by_arc` therefore answered `04b41ea1…`, and every `tugtool arc` verb resolving at the door landed on it. Read from a copy via `just db-inspect` at about 11:25 UTC; a second copy at 11:40 shows the same row `closed, demoted = 1`, which is [F12]'s doing and not this finding's. **(verified)**

**[F02] The rotation seated the deck correctly.** `tugcast.log.2026-09-25` at 14:08:04 carries `ledger.seat_line_binding` for `04b41ea1…` on card `e842a0ee…`, which is the path in `agent_supervisor.rs` (`record_spawn`, ~line 1296) that moves the binding and broadcasts `bind_arc_ok` with the card and line, followed by the bridge's `session_line_seated`. At that moment the masthead, the Z2 cell, and the Arcs card agreed. **(verified)**

**[F03] Every reconnect since then re-keyed the card to its dead address.** Four `spawn.attached_to_held_bridge` events for card `e842a0ee…`, at 15:45, 20:12, 23:21 on 09-25 and 11:01 on 09-26, each reading `requested=04b41ea1…  attached=afed4f75…`. The deck's restore asked for the live segment the ledger listed (`resume_segment_for_line` orders `live` first, and the copy confirms `04b41ea1…` sorts first); `do_spawn_session`'s one-card-one-bridge attach ([B03] of the rival-bridge fix) re-pointed the spawn at the bridge's key, which is the id the card was first spawned under. The 11:01 event follows a nine-hour gap in the log, so that reconnect is the machine waking. **(verified)**

**[F04] The spawn ack names the address and reads the arc pair off the address's row.** `do_spawn_session` builds `spawn_session_ok` with `"tug_session_id": tug_session_id` (the attached key, `afed4f75…`) and reads `arc_id`/`arc_name` from `ledger.get(tug_session_id)`, which is the closed row whose binding the seat move took away. So the ack said unbound. The `ledger.reported_binding.kept` line at 11:01:47 for this arc comes from the `list_card_bindings` answer, which did read the live row; the ack that followed one second later did not. **(verified, read from `agent_supervisor.rs` ~lines 5710–5790)**

**[F05] Nothing re-announces the seat on a reconnect.** `seatedSessionId` in `tugdeck/src/lib/card-session-binding-store.ts` has exactly one writer, the `session_line_seated` handler, and that frame is sent from `agent_bridge.rs` (~line 2139) only when a `session_init` arrives with a claude id different from the previous one. A reconnect wipes the store (`clearAll`, per `[D04]`), re-spawns, and changes no claude id, so the seat is gone and no frame restores it. **(verified)**

**[F06] Both blank surfaces are one lookup.** `useArcForSession` in `tugdeck/src/lib/arc-session-index.ts` indexes the aggregate by `bound_session` (`04b41ea1…`) and, on a miss, walks address to card to seat via `seatedSegmentForSession`, which returns `seatedSessionId ?? tugSessionId`. After a reconnect that is `afed4f75…`, a second miss, and the answer is null. The masthead marker (`tug-session-identity.tsx`), the Z2 cell's `TASKS`/`ARC` label and step list (`session-card-telemetry-renderers.tsx` ~line 1905), and the binding chip all read that null. **(verified)**

**[F07] The Arcs card is keyed by arc and never asks the session question.** `useArcRows` projects `CHANGESET_ALL` by arc entry; the bound-session pill resolves `04b41ea1…` to a callsign by line. Both segments wear `argent-reef`, so the pill and the masthead read the same name while disagreeing about the arc. **(verified)**

**[F08] The tugcast-restart path does not have this bug.** `SessionLedger::seat_line_bindings` runs once at startup and moves each seated line's binding onto the resume segment, so a fresh process acks the tip and the direct index lookup hits. The reconnect path never restarts the process and was never covered by that repair. **(verified from the code; not exercised in this incident)**

**[F09] The resume itself worked.** `arc_resume`/`arc_run` resolve the posted id through `calling_segment` to the line's live segment, so the bind landed on `04b41ea1…` and `arc.continued` at 11:02:19 addressed the bridge key `afed4f75…`, which is what the runner keys on. The server is consistent with itself in two vocabularies; the deck was handed only one. **(verified)**

**[F10] No app-test covers a rotate-then-reconnect.** `TugConnection._forceCloseForTest` exists precisely to drive the reconnect restore from a test, and `at0503` pins the rotation seat, but no test rotates a card, drops the wire, and reads the masthead afterwards. **(verified by search; the absence is inference from a grep, not a proof)**

**[F11] The `tangy-phone` line's seat is closed and demoted while its stage runs.** Line of `c7ac9d8e…` (card `b59b2122…`): the door segment `c7ac9d8e…` and the devise and review segments `851138ff…` and `3b7d18d5…` read `closed, demoted = 0`, which is what a rotation leaves. The implement segment `4f0a70da…`, minted 11:26:42 UTC and bound to `tugarc/changes-shade-refusals#…`, reads `closed, demoted = 1` with `last_used_at` equal to its `created_at`. The stage was running turns under it at 11:28 and 11:34. **(verified from a ledger copy)**

**[F12] A startup demote ran against the live ledger at 11:28:35 UTC, and three more followed.** The `facts` table carries `session.closed (startup-demote)` for `4f0a70da…` and for `04b41ea1…`, the wizard-downloads seat, both at `at_ms = 1790422115634`. `demote_live_to_closed` has one production caller, `tugcast/src/main.rs` at startup, and its `UPDATE` is unscoped: every `live` row in the file. The release-main tugcast (pid 64458, up since 2026-09-25 03:26) never restarted. Its own log shows nothing at that second. **(verified)**

**[F13] The demoting process was a per-arc release app launched from the wizard-downloads worktree.** `instances/release-tugarc-wizard-downloads/Logs/tugcast.log.2026-09-26` opens at 11:28:35.084 with `source_tree = .tug/worktrees/wizard-downloads`, bundle `Tug-release-tugarc-wizard-downloads.app`, and reads at 11:28:35.635 `demoted stale live ledger rows on startup count=5`, then at 11:28:36.309 `ledger snapshot backup written dest=…/instances/release-main/backups/sessions-1790422115634-000000.db`. The backup lands beside the database it opened, so that process opened release-main's `sessions.db`. Its later launches at 11:30:46, 11:32:22 and 11:35:16 each demoted again against the same file (counts 1, 1, 3), while the 11:28:48 launch wrote its backup under its own instance directory. **(verified)**

**[F14] The override reached it through the environment.** `agent_bridge.rs` (~line 424) exports `TUG_SESSIONS_DB` into every tugcode child so the child opens the ledger its tugcast opened. The live tugcode processes for both arcs carry `TUG_SESSIONS_DB=…/instances/release-main/sessions.db`. Claude Code, its Bash tool, and every `just` recipe a stage runs inherit it. `resolve_sessions_db_path` in `tugcore/src/instance.rs` honours that override before the instance-derived path, so a tugcast whose own identity is `release-tugarc-wizard-downloads` opened another instance's ledger. The `app-release`, `app-debug`, `launch-release` and `launch-debug` recipes scrub the launch environment with `env -u TUG_INSTANCE_ID -u TUG_BUNDLE_PATH -u TUGCAST_RESOURCE_ROOT open …`, and that list does not include `TUG_SESSIONS_DB`; `open` propagates the rest, as the recipe's own comment says. Which of those recipes the stage ran is not visible in the session summaries; the product name and the source tree are the evidence. **(verified for the mechanism; the recipe is inference)**

**[F15] `guard_isolated` does not catch this.** The guard in `instance.rs` only fires when the test-isolation variable is set, and only refuses a path inside the live data root. A developer launch sets no isolation variable, and the path *is* the live root by design. There is no check that the ledger a process opens belongs to the instance it identifies as. **(verified)**

**[F16] A demoted seat never revives, because activity is recorded under the address.** `revive_on_activity` lifts a `closed, demoted = 1` row back to `live` when a turn lands on it. The supervisor records turns and jobs under the bridge key (`ledger.insert_pending_turn session_id=c7ac9d8e…` at 11:26:41, `job_launched session_id=c7ac9d8e…` at 11:28:36), which is the rotation-closed door row with `demoted = 0`, so revive matches nothing. The seat row `4f0a70da…` gets no activity under its own id. The same holds for `04b41ea1…` under `afed4f75…`. **(verified from the log and `session_ledger.rs` ~line 5498)**

**[F17] Every server verb now refuses both arcs.** `bound_session_by_arc` is live-only, so both arcs report no bound session and the Arcs card and the session cards agree on "unbound". `calling_segment` resolves a posted id to a live segment of its line and errors when there is none, so `tugtool arc step`, `arc commit`, `arc stop` and `arc run` from inside either stage now answer "names a closed segment and no segment of its line is live". **(inference from the code; not run against a live card, because running it would spend the refusal on a real arc)**

---

## Decisions {#decisions}

**[B01] The spawn ack carries the seat, and reads the arc pair off it.** In `do_spawn_session`, after the bridge attach resolves the key, the ack resolves the line's live segment (`live_segment_of` on the attached key, or the requested id when it is itself live) and carries it as `seated_session_id`, with `arc_id` and `arc_name` read from *that* row. `tug_session_id` on the ack stays the bridge key: it is the card's address, every frame is stamped with it, and `CardServicesStore` keys on it, so moving it would tear the services bag down mid-turn. The two ids ride the ack side by side, exactly as they sit side by side in `CardSessionBinding`. The deck's `spawn_session_ok` handler writes `seatedSessionId` when the two differ and seeds the line store with both pairs. This is the smallest change that hands the deck both vocabularies on every restore path, and it makes the ack's arc pair true for a rotated card, which it was not. A server that omits the field is read as "seat is the address", which is today's behaviour, so an older server needs no bridge.

**[B02] The arc index is line-keyed as well as segment-keyed.** `buildArcSessionIndex` keys each fact by its bound segment *and* by that segment's line (through `sessionLineStore.lineOf`, subscribed the way the seat walk already is), and `arcForSession` falls through address, then seat, then the caller's line. The aggregate already names the bound segment, and the deck learns every segment-to-line pair from the row push and the ack, so the line answer is derivable from facts the deck durably holds rather than from a memory-only seat. With [B01] the fall-through should never be reached; it is there so a reader keyed by an id a rotation left behind is still answered when a seat frame is lost, which is the failure this brief is about. It does not replace the seat: the chip and every other seat-walking reader keep walking.

**[B03] The reconnect is pinned by an app-test.** One test rotates a card onto a fresh segment with an arc bound, drops the wire with `_forceCloseForTest`, waits for the restore to land, and asserts the masthead's `^<arc>` marker, the Z2 cell's `ARC` label, and the step list survive. It carries `@covers` for `session-restore.ts`, `card-session-binding-store.ts`, `arc-session-index.ts`, and the supervisor's spawn path. This is the test that would have caught all four reconnects in [F03]. A unit test beside `a_reload_naming_a_rotated_segment_re_holds_the_cards_bridge` in `agent_supervisor.rs` asserts the ack's `seated_session_id` and arc pair name the live segment when the attach re-keyed the spawn.

**[B04] Every finding here stays server-consistent; nothing moves the ledger.** The binding stays on the live segment, `calling_segment` stays newest-first, and the bridge stays keyed by its first id. The defect is in what the deck was told, not in what the server knows, and a fix that moved a ledger column to make the ack easier would reintroduce the corpse-binding the seat move exists to prevent.

**[B05] A tugcast opens only the ledger of the instance it is.** `resolve_sessions_db_path` keeps the `TUG_SESSIONS_DB` override for harnesses, but tugcast's own startup refuses an override that names a path outside its instance directory unless the test-isolation variable is set: it logs the two paths and exits non-zero rather than opening another instance's file. The override exists so a child reads the ledger its parent opened; it was never meant to let a *new* tugcast adopt a parent's. A refusal at the door is what turns a silent five-row demote into a sentence, and it holds for any launch shape, not only the recipes we know about.

**[B06] The launch recipes scrub every Tug ledger variable.** `app-release`, `app-debug`, `launch-release` and `launch-debug` extend the `env -u` list to `TUG_SESSIONS_DB`, `TUG_CHANGES_DB`, `TUG_PROMPT_HISTORY_DB`, `TUG_SESSION_INDEX_DB`, `TUG_DATA_DIR` and `TUG_SESSION_ID`, in one shared script so the four lists cannot drift. This is belt to [B05]'s braces: the guard is the contract, the scrub is what keeps a developer launch from meeting it.

**[B07] The startup demote is scoped to rows this process could have owned.** `demote_live_to_closed` gains an instance argument and demotes only rows whose `card_id` the ledger's `lines` table files under this instance's cards, or, failing a recorded instance, only rows the process finds no live subprocess for. With [B05] in place a foreign process never reaches this, but the unscoped `UPDATE … WHERE state = 'live'` is a write that has now proven it can land on another process's live work, and a scoped one costs nothing on the ordinary crash-recovery path it exists for.

**[B08] Activity revives the seat, not the address.** `revive_on_activity` is called with the line's resume segment, resolved through `live_segment_of` or, when no segment is live, `resume_segment_for_line`, rather than with the bridge key. The row that should read `live` is the one the arc binding sits on; reviving the door row leaves the binding on a corpse. This is what would have let both arcs recover the moment their next turn landed, and it is the repair path for any ledger left demoted by whatever means.

---

## Non-goals {#non-goals}

- **Re-sending `session_line_seated` from the attach path.** Considered as an alternative to [B01]. It has the same effect through a second frame, and a second frame on the reconnect path is one more ordering to get right ([F02] already depends on push-then-announce). One field on the ack the deck already waits for is the smaller change.
- **Moving `tug_session_id` on the ack to the live segment.** Rejected: it is the card's address, and the services store, the frame stamping, and the bridge key all hang off it. The seat is a second field for exactly this reason, and it already is on the deck side.
- **Making the Arcs card read through the session index.** The Arcs card is right; the session card is wrong. Aligning surfaces by making the correct one depend on the broken lookup is the wrong direction.
- **The arc stop and resume verbs.** Neither is implicated ([F09]). The stop receipt, the resume button, and `tugtool arc run` are unchanged.
- **The one-card-one-bridge attach.** It is correct and stays. It is what made the ack's row the wrong row, but the repair is in the ack, not in the attach.
- **Removing the `TUG_SESSIONS_DB` override.** The tugtool CLI suite and the app-test harness seed isolated ledgers through it, and tugcode reads its parent's ledger through it. The override stays; what changes is that a tugcast startup will not adopt one that names a foreign instance ([B05]).
- **Repairing the two arcs by hand.** The rows can be revived with a ledger write, but a hand edit is the shape this project refuses. [B08] is the repair, and it runs on the next turn.

---

## Exit {#exit}

**An arc.** The first steps, in the order they must land:

1. The supervisor's ack gains `seated_session_id` and reads the arc pair off the seat's row ([B01]); the unit test beside the reload test pins it ([B03]).
2. The deck's `spawn_session_ok` handler writes the seat into the binding when it differs from the address ([B01]).
3. `arc-session-index.ts` gains the line key and the line fall-through ([B02]), with a unit case for an address a rotation left behind.
4. The rotate-then-reconnect app-test ([B03]), run against the built bundle after steps 1–3, and once more with step 2 reverted under `file probe` to show it catches the original loss.
5. Tugcast refuses a `TUG_SESSIONS_DB` naming a foreign instance at startup ([B05]), with a unit test that sets the override to another instance's path and asserts the refusal, and one that sets the isolation variable and asserts the override is honoured.
6. The four launch recipes share one scrub script covering every ledger variable ([B06]).
7. `demote_live_to_closed` takes the instance and scopes its rows ([B07]); `revive_on_activity` is called with the line's seat ([B08]). A ledger test seeds a rotated line, demotes it, records a turn under the door id, and asserts the seat row is the one that revives and that `bound_session_by_arc` names it again.
