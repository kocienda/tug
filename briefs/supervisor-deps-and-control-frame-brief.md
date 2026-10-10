<!-- brief-skeleton v1 -->

# One `control_frame` helper, and a `SupervisorDeps` struct in place of `LEDGER_HANDLE` and late-bound `OnceLock`s

**Purpose:** Ninety-eight sites in tugcast build a CONTROL frame by hand with their own `.expect("… serializes")`, 82 of them in the supervisor. The supervisor's collaborators arrive through five `OnceLock` fields set from the boot stage after construction, and a process-wide `static LEDGER_HANDLE` exists so one function in another feed can read the supervisor's ledger.

---

## Purpose {#purpose}

Item 18 of `briefs/audit-punch-list.md`:

> 18. One `control_frame` helper replacing 82 copy-pasted emitters, and a `SupervisorDeps` struct replacing `LEDGER_HANDLE` and the late-bound `OnceLock` wiring.

The supervisor split and the boot-builders arc both deferred exactly this ([B03] in each). Every frame's bytes and every channel's wiring are held fixed.

---

## Evidence {#evidence}

**[F01] The emitters** — `.expect("…serializes…")` appears 98 times in `tugcast/src`: `agent_supervisor/control/changeset.rs` 28, `control/rows.rs` 16, `agent_supervisor/mod.rs` 10, `control/session.rs` 9, `control/telemetry.rs` 7, `control/arc.rs` 7, `join_resolver.rs` 4, `recorder.rs` 4, `draft_engine.rs` 3, `base_motion.rs` 3, `host.rs` 2, and one each in `jots.rs`, `session_index_watch.rs`, `join_resolve.rs`, `spawn.rs`. The supervisor directory holds 25 `fn send_*` wrappers. Every one has the shape of `control/arc.rs:782-792`: build a `serde_json::json!` body with an `"action"`, `to_vec(&body).expect(…)`, wrap in `Frame::new(FeedId::CONTROL, …)`, `let _ = tx.send(…)`. Two private helpers already exist and are not shared: `actions.rs:95 fn send_control` and `shared_agent.rs:1060 fn send_control`. **(verified)**

**[F02] The late-bound fields** — `AgentSupervisor` (`agent_supervisor/mod.rs:355`) has exactly five `OnceLock` fields: `changeset_watch` :460, `turn_complete_tx` :473, `arc_tick_tx` :481, `wheel_tick_tx` :487, `wheel` :497. Production `.set` sites: `boot/supervisor.rs:707` (`turn_complete_tx`), :750 (`wheel`), :754 (`arc_tick_tx`), :772 (`wheel_tick_tx`), and `changeset_watch` inside `start_draft_engine` (`mod.rs:2884`, called from `boot/supervisor.rs:696`). Eight test sites set them by hand (`mod.rs:6507-6508`, `tests/arc.rs` ×3, `tests/changeset.rs` ×3, `arc_runner.rs:7270`). The boot stage constructs the supervisor at `boot/supervisor.rs:174` via `new_with_ledger` and returns `Runtime`. **(verified)**

**[F03] `LEDGER_HANDLE`** — `static LEDGER_HANDLE: OnceLock<Ledger>` at `mod.rs:106`, where `Ledger` is the supervisor's in-memory `Arc<tokio::Mutex<HashMap<TugSessionId, …>>>` (:93), not the SQLite ledger. Set once in `new_with_ledger` (:1845); read once by `pub async fn busy_session_ids()` (:113); that function has one caller, `feeds/changeset.rs:1669`. **(verified)**

**[F04] The other statics are not the supervisor's** — 13 `static …: OnceLock` declarations in the crate: the join board, join pilot runner, join occupancy registry, pending asks, base-motion board, deck seatings board, claude-download control, the changeset marker and cache, two path-resolver memos, `arc_runner.rs:429 WAIT_BOARD`, and `fs_write.rs:88 LOCKS`. Each is a board or cache with its own lifetime and readers across feeds. **(verified)**

---

## Decisions {#decisions}

**[B01] `tugcast::control::{control_frame, send_control}`: `control_frame(body: serde_json::Value) -> Frame` and `send_control(tx: &broadcast::Sender<Frame>, body: Value)`.** Serialising a `Value` to bytes cannot fail (its keys are strings), so the one `expect` lives in the helper with that sentence beside it, and the 98 call sites lose theirs. The two private helpers in [F01] become calls to it. The 25 `fn send_*` wrappers stay as the named vocabulary of each control family; their bodies become one line. The gauge is `grep -c 'serializes'` at zero outside the helper.

**[B02] `SupervisorDeps { turn_complete_tx, arc_tick_tx, wheel_tick_tx, wheel }` is a constructor parameter, and the four fields are plain fields.** The channels are `mpsc::channel` senders and the wheel is an `Arc`; all four can be created before the supervisor and their receivers spawned after it, which is what the boot stage already does in a different order. The eight test sites construct a `SupervisorDeps` with test channels instead of calling `.set`, and `new_with_ledger` loses its `let _ = .set` tolerance for a second set, which was never a wanted behaviour.

**[B03] `changeset_watch` is settled by reading `start_draft_engine`, with the default that the draft engine is started by the boot stage and its receiver passed in the deps.** It is the one field whose producer lives inside the supervisor today ([F02]). If the engine needs the supervisor to exist first, the field stays a `OnceLock` as the one documented exception and the arc says why; either answer is recorded in the arc's log.

**[B04] `LEDGER_HANDLE` is deleted; `feeds/changeset.rs` receives what it needs.** [F03]: one producer, one reader. The reader gets a `BusyProbe` (a cloneable handle wrapping the `Ledger` map, or a closure) at its own construction in the feeds boot stage. `busy_session_ids` becomes a method on it.

**[B05] The 13 module statics in [F04] stay.** They are not supervisor wiring; the boot-builders brief left them in place for the same reason. A `Boards` struct for them is its own arc once this one has shown the supervisor can be constructed from a deps struct.

**[B06] Order: the helper sweep first, then `LEDGER_HANDLE`, then the deps.** The sweep is large and mechanical and touches every control file, so it goes first while nothing else is moving; the static is the smallest wiring change; the deps change last because it rewrites the boot stage and the tests together.

---

## Open Questions {#open-questions}

- None that the code cannot answer. [B03] is settled by reading one function at the step that reaches it.

---

## Non-goals {#non-goals}

- **Typed CONTROL enums.** Item 14's brief; the helper takes a `Value` so that arc can change what builds the `Value` without touching the emitters again.
- **The 13 module statics.** [B05].
- **Changing any frame's fields or any channel's capacity.**

---

## Exit {#exit}

An arc. Steps as ordered in [B06]: the helper with its one test and the sweep across the sixteen files; `LEDGER_HANDLE` out; `SupervisorDeps` with the boot stage and the eight tests converted. `cargo nextest run -p tugcast` is each step's verdict; the three binary-driving integration tests run after the deps step. Run it one after the other with `async-ledger-handle`, never concurrently; both rewrite sites across `agent_supervisor/mod.rs` and `boot/supervisor.rs`.
