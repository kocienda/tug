<!-- brief-skeleton v1 -->

# Split `AgentSupervisor` into control-handler modules

**Purpose:** `tugrust/crates/tugcast/src/feeds/agent_supervisor.rs` is 30k lines, of which 14k are production and hold four unrelated subsystems behind one 510-line string match. Every tugcast feature lands in this file by gravity, and nothing in the changeset, arc, or telemetry paths can be read, tested, or changed without the whole file as context. The split is the one change that makes every other tugcast change cheaper.

---

## Purpose {#purpose}

Item 27 of `briefs/audit-punch-list.md`:

> 27. Split `AgentSupervisor` into control-handler modules behind a registry instead of the string match. This is the one that makes every other tugcast change cheaper.

Behaviour is held fixed. The split is a move of code between files, with the one dispatch function rewritten to delegate.

---

## Evidence {#evidence}

**[F01] Shape of the file** — 30,111 lines. The top-level sections, by the file's own `// ---` banners: `SpawnState`, `BoundedQueue`, `LedgerEntry`, `Ledger` alias, `SessionsRecorder` trait, `AgentSupervisor` (struct at line 2116, 31 fields; `impl` from 4607 to 14010), crate-visible test helpers, then `mod tests` from 14339 to 29668 plus two more test modules (`bridge_panic_tests`, `replay_bracket_close_tests`). The production half is 14k lines; the test half 16k. **(verified)**

**[F02] One dispatch over 44 actions** — `handle_control` (line 4775, 510 lines) is a `match` over 44 action strings. The handlers it reaches are 40 `do_*` methods; by family: session lifecycle (`spawn_session`, `close_session`, `reset_session`, `list_sessions`, `list_card_bindings`, `request_replay`, `resolve_sessions`), arc (`bind_arc`, `arc_resume`, `arc_run`, `arc_stop`, `unbind_arc`), changeset (16 actions from `changeset_git_init` to `changeset_replay`, plus `landing_receipt`), session rows (`trash_session`, `rename_session`, `set_session_private`, `trash_project_dir_sessions`), telemetry and listings (`record_*`, `list_session_state_changes`, `list_digest_lines`, `list_overview_posts`, `list_shell_exchanges`, `list_refs`), deck (`deck_seatings`, `deck_log`). **(verified)**

**[F03] Each family carries its own parsing and reply boilerplate** — 40 `parse_*_payload` functions, 25 `send_*_ok`/`send_*_err` emitters, 20 `record_*` writers, all in the same `impl`. The emitters are the 82 copy-pasted `json!({"action": …}).expect("… serializes")` sites the audit counted. **(verified)**

**[F04] Other oversized functions in the production half** — `do_spawn_session` 843 lines, `handle_control` 510, `merger_task` 398, `dispatch_one` 397, `arc_name_for` 346; a 1,594-line `is_handled` and a 937-line `From<&str>` impl (`from(tool_name)`) sit in the pre-struct sections. **(verified by an awk over function starts; the two largest are likely long `match` tables)**

**[F05] Coupling** — 15 other files import from `agent_supervisor::`; the production half references 15 distinct `crate::` modules. A process-global `static LEDGER_HANDLE: OnceLock<Ledger>` at line 987 is set once per process and read by `busy_session_ids()`, which `feeds/changeset.rs` calls. **(verified)**

**[F06] A construction seam already exists** — `AgentSupervisorConfig` (line 1938, with `Default`) and `SpawnerFactory = Arc<dyn Fn() -> Arc<dyn ChildSpawner>>` (line 1988) are how tests build a supervisor with fake children. The split does not need a new injection point. **(verified)**

**[F07] The test corpus is already grouped by family** — the `mod tests` banners read `handle_control: spawn_session`, `session↔arc binding`, `handle_control: close_session`, `request_replay`, `spawn budget`, `dispatch_one / dispatcher_task`, `rebind tests`, `merger_task, per-session bridge, metadata routing`, `directory change`. The tests know the families the code does not. **(verified)**

---

## Decisions {#decisions}

**[B01] The file becomes a directory, `feeds/agent_supervisor/`, and the families become child modules.** `mod.rs` keeps the struct, the config, the dispatcher loop (`dispatch_one`, `merger_task`), and `handle_control`. Each family is a child module with its own `impl AgentSupervisor` block: `control/session.rs`, `control/arc.rs`, `control/changeset.rs`, `control/rows.rs`, `control/telemetry.rs`, `control/deck.rs`, plus `spawn.rs` for `do_spawn_session` and its spawn-state machinery. A child module in Rust sees its parent's private items, so no field becomes `pub(crate)` for the move and the struct's privacy is unchanged. This is the lowest-risk split available: every function keeps its name, signature, and receiver.

**[B02] `handle_control` becomes a one-level delegation, not a registry.** The 510-line match shrinks to a match that maps each action to its family's `handle_<family>_control(action, payload)`, and each family owns its own inner match. The audit proposed a trait-and-table registry; rejected for this arc because a table adds an indirection the compiler cannot check exhaustively, and the problem was the size of the match, not its form. A registry can come later if two families ever need the same action.

**[B03] Each family's `parse_*`, `send_*`, and `record_*` helpers move with it.** The boilerplate is what makes the families separable; the `reply_err` helper that would collapse the 82 emitters is item 18 of the punch list and is not this arc's, but once the emitters sit in six files the helper is a six-file change instead of a 14k-line one.

**[B04] Tests move with the code they exercise, in the same step.** The `mod tests` is split along the banners in [F07] into `agent_supervisor/tests/<family>.rs`, each `#[cfg(test)]`, each reaching the supervisor through `super::super`. A step that moves a family's production code and leaves its tests in the monolith has not finished.

**[B05] The pre-struct sections (`SpawnState`, `BoundedQueue`, `LedgerEntry`, `SessionsRecorder`) move to `agent_supervisor/{spawn_state,bounded_queue,ledger_entry,recorder}.rs` first.** They have no dependency on the struct and moving them is the arc's warm-up: it proves the directory layout and the test-path rewrite on code with the least risk.

**[B06] Order: pre-struct sections, then families from smallest to largest (deck, rows, telemetry, arc, session, changeset), then spawn.** `changeset` is the largest family and the one most other feeds reach into; it goes last so the pattern is settled by then. Each step ends with `cargo nextest run -p tugcast` green and the file's line count lower.

**[B07] `LEDGER_HANDLE` and the `OnceLock` late binding are left exactly as they are.** They are item 18's concern; touching them here would make a pure move into a behaviour change.

---

## Open Questions {#open-questions}

- Whether the 1,594-line `is_handled` and the 937-line `from(tool_name)` ([F04]) are lookup tables that want a data file rather than code. Read them in the warm-up step and decide; if either is a table, it becomes `include!`d data or a `phf` map in its own module, and that decision is recorded in the arc's log.

---

## Non-goals {#non-goals}

- **A `ControlHandler` trait and dispatch table.** [B02].
- **Collapsing the 82 reply emitters into one helper.** Item 18.
- **Replacing `LEDGER_HANDLE` or the `OnceLock` wiring with a deps struct.** Item 18. [B07].
- **Making the ledger calls async or moving them off the runtime.** Item 17.
- **Any change to what an action does, what it replies, or when.** The verdict for every step is the existing test corpus passing unchanged except for its module paths.

---

## Exit {#exit}

An arc. The first step turns the file into a directory and moves the four pre-struct sections with their tests ([B05]). Each following step moves one family with its tests and shrinks `handle_control` by that family's arms ([B01], [B02], [B04], [B06]). The last step moves `do_spawn_session` and its spawn-state machinery. `cargo nextest run -p tugcast` is the verdict for each step; the `@covers`-derived app-test selection for `agent_supervisor.rs` (20 files today) runs once after the last step, with the `@covers` lines retargeted at the new paths.
