<!-- brief-skeleton v1 -->

# A lock-poisoning policy for tugcast, and no ledger write dropped on the floor

**Purpose:** tugcast guards its session ledger and several shared structures with `std::sync::Mutex` and unwraps every lock. One panic while a lock is held poisons it, and every later `.expect("ledger mutex")` is a fresh panic, so a single bridge fault becomes a process-wide outage. Separately, five ledger mutations in the agent supervisor discard their `Result`, so a failed delete or unbind is silent.

---

## Purpose {#purpose}

Items 9 and 10 of `briefs/audit-punch-list.md`:

> 9. Lock-poisoning policy for tugcast ledgers. Either `parking_lot` or a `lock_or_recover` helper replacing the 97 `.expect("ledger mutex")` sites.
> 10. Log the five silently dropped ledger mutations in `agent_supervisor.rs` and observe the dropped `spawn_blocking` handle at line 9137.

---

## Evidence {#evidence}

**[F01] The ledger is one `std::sync::Mutex<Connection>` with 116 `.expect("ledger mutex …")` sites** — `tugrust/crates/tugcast/src/session_ledger.rs`, `SessionLedger { db: Mutex<Connection>, … }`; the count is `grep -c` over the file. Further `.lock().unwrap()`/`.expect()` sites in production code: `shared_agent.rs` 11, `feeds/shell.rs` 12, `server.rs` 9, `wheel/mod.rs` 7, `feeds/agent_supervisor.rs` 7. `tugcore` has four more. No crate in the workspace recovers a poisoned lock; `parking_lot` is already in `Cargo.lock` as a transitive dependency. **(verified)**

**[F02] Panics under a lock are an acknowledged reality** — `agent_supervisor.rs` carries a `bridge_panic_tests` module and `panic_hook.rs` installs a hook with `catch_unwind` handling. The hook reports the panic; it does not unpoison the mutex the panicking thread held. **(verified)**

**[F03] What poisoning costs** — the ledger is read on every session snapshot, every changeset recompute, every arc bind. After one poison, every one of those paths panics at its `expect`, the panic hook logs each, and the deck sees a tugcast that answers nothing until the host restarts it. Not reproduced; inferred from the call pattern and Rust's poisoning semantics. **(inference)**

**[F04] Five silently discarded ledger mutations** — `agent_supervisor.rs`: `let _ = ledger.delete_changeset_draft(…)` in `do_changeset_draft_set` (clear branch) and twice in `clear_arc_draft`; `let _ = ledger.clear_arc_bindings_for_arc(&owner_key)` at two sites after a join lands and after a discard. In each, the next line bumps the changeset aggregate so the deck recomputes from a ledger that may still hold the row. The 101 `let _ = …send(…)` on broadcast channels in the same file are correct (no receiver is a fine answer) and are what these hide among. **(verified)**

**[F05] One dropped `spawn_blocking` handle** — `note_model_switch` does `let _ = tokio::task::spawn_blocking(move || { … })` over ledger reads and an arc record read. A panic inside is observed only by the hook; a `JoinError` is never read. **(verified)**

**[F06] Four `let _ = std::fs::create_dir_all` in `main.rs`** (lines 450, 678, 1274, 1290), each followed by writes into the directory that then fail with a less useful error. **(verified)**

---

## Decisions {#decisions}

**[B01] tugcast adopts `parking_lot::Mutex` and `RwLock` for every in-process lock, starting with the ledger.** `parking_lot` locks do not poison: a panic releases the lock and the next caller proceeds. The 116 `.expect("ledger mutex")` calls become `.lock()`, which is also what makes the change reviewable: a type swap and a mechanical edit, no new helper to learn. The argument that poisoning protects an invariant does not apply here: the mutex guards a `Connection` handle, and SQLite transactions guard the data. `tugcore`'s four sites follow in the same change so the policy is workspace-wide.

**[B02] The policy is written down and tripwired.** A source-scan test in `tugcore` refuses `std::sync::Mutex` and `std::sync::RwLock` in production code of the workspace crates, with an allow-list for the places `std` is required (a `Condvar` pair, a `OnceLock` initializer). The `no_ad_hoc_ledger_opens` test is the model.

**[B03] A failed ledger mutation is logged with `warn!`, the operation name, and the key, and the aggregate bump still fires.** The bump is what makes the deck re-read; suppressing it on failure would hide a stale row rather than a failed delete. A `fn log_ledger_err(what: &str, key: &str, r: Result<_, LedgerError>)` keeps the five sites to one line each and keeps them visually distinct from the broadcast `let _`s ([F04]).

**[B04] `note_model_switch` awaits its handle and logs a `JoinError`.** It is already an `async fn`; the await costs nothing and a panic inside the closure becomes a logged event with the session id attached.

**[B05] The four `create_dir_all` results are checked and reported once, at startup, with the path.** A data directory that cannot be created is a startup fault, not a thing to discover three writes later.

---

## Open Questions {#open-questions}

- Whether any lock in tugcast is held across an `.await`. The audit checked every `std` lock followed by an `.await` within eight lines and found none, and `parking_lot` guards are `!Send` in the same way, so the compiler will say if the audit missed one. Not a design question.

---

## Non-goals {#non-goals}

- **`tokio::sync::Mutex` for the ledger.** The ledger's callers are synchronous `spawn_blocking` closures and the async facade is item 17 of the punch list; an async mutex here would be the wrong tool for the current shape.
- **A `lock_or_recover` helper on `std` locks.** Considered: it keeps `std` and adds a function every site must remember to call. `parking_lot` makes the correct thing the only thing.
- **Changing any ledger operation's semantics.** This is observability and policy, not behaviour.

---

## Exit {#exit}

An arc. Two steps: the `parking_lot` swap across tugcast and `tugcore` with the source-scan tripwire, verified by `cargo nextest run -p tugcast -p tugcore` and the existing `bridge_panic_tests`; then the five logged mutations, the awaited handle, and the checked `create_dir_all`s, with one unit test that drives a failing in-memory ledger through `clear_arc_draft` and asserts the warning and the bump.
