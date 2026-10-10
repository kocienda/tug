<!-- brief-skeleton v1 -->

# An async `LedgerHandle` so SQLite and the changes forward never block a tokio worker

**Purpose:** `SessionLedger` is a `parking_lot::Mutex<Connection>` called from async code at about 1,100 sites against 138 `spawn_blocking`s, and `write_change` holds its access lock across a blocking HTTP forward with a two-second timeout. A slow disk or a stalled forward stalls a tokio worker and everyone waiting on that lock.

---

## Purpose {#purpose}

Item 17 of `briefs/audit-punch-list.md`:

> 17. An async `LedgerHandle` facade so SQLite and the 2-second blocking `ureq` forward never run on a tokio worker under a std mutex.

Behaviour is held fixed: every write lands, in the same order, with the same takeover semantics when a forward fails. The lock-poisoning arc already replaced the std mutex with `parking_lot`; what remains is where the blocking happens.

---

## Evidence {#evidence}

**[F01] The ledger and its locks** — `tugrust/crates/tugcast/src/session_ledger.rs:1085` `db: parking_lot::Mutex<Connection>`, locked at 98 sites in the file. Beside it `changes_journal: Mutex<Option<ChangesJournal>>` (:1112) and `changes_access: Mutex<ChangesAccess>` (:1125), with the documented order "`changes_access` is acquired strictly before `db`" (:1118-1124). The ledger is shared as `Arc<SessionLedger>` from `boot::Ledgers` (`boot/ledgers.rs:36`, open returns it at :315). There is no `async fn` on it outside a test, and no `LedgerHandle` anywhere. **(verified)**

**[F02] The forward runs under the lock** — `write_change` (:7151) takes `changes_access.lock()` at :7155, and when the access is `Forward(forwarder)` calls `forwarder.send(&record)` at :7159 while holding it; on failure it runs `take_over_changes_writer` (claim and re-attach) still under the lock, and drops it after `*access = ChangesAccess::Owner(lock)` at about :7207. In the owner case `apply_change_locally` (:7235) also runs under it. The forwarder is `ureq::Agent` (`changes_writer.rs:103`), built with `timeout_global(FORWARD_TIMEOUT)` where `FORWARD_TIMEOUT` is 2 s (:50), posting to `/api/changes-write`. **(verified)**

**[F03] Call density** — lines matching `ledger.` or `ledger()` in `tugcast/src`: 1,103. By file: `feeds/agent_supervisor/mod.rs` 200, `feeds/agent_bridge.rs` 88, `session_ledger.rs` 70, `agent_supervisor/recorder.rs` 41, `agent_supervisor/control/changeset.rs` 36, `feeds/arc.rs` 33, `prompt_ledger.rs` 32. `spawn_blocking` appears 138 times, concentrated in `arc_runner.rs` (27), `join_resolver.rs` (10), `server.rs` (9); `agent_supervisor/mod.rs` has 3. **(verified)**

**[F04] The runtime and the clients** — `main.rs:74` is a bare `#[tokio::main]`: the multi-thread runtime with default worker count and no thread naming. `reqwest` 0.12 (`rustls-tls`, `stream`, `http2`) is already a dependency and used asynchronously in `claude_auth.rs`, `server.rs`, and `claude_download.rs`; `ureq` 3 is used only by the forwarder. **(verified)**

---

## Decisions {#decisions}

**[B01] The forward leaves the lock first, and it is the one step that changes a mechanism.** `write_change` becomes: lock, read the access state and clone what the send needs, unlock; send; relock and apply the outcome against a generation counter so a takeover that happened during the send is not undone. Ordering of forwarded records, which the lock gives for free today, is kept by a `tokio::sync::Mutex` around the forward path in the handle ([B02]), which serialises senders without parking a worker. The send itself moves to the async `reqwest` client already in the crate ([F04]), and `ureq` leaves `Cargo.toml` when nothing else uses it.

**[B02] `LedgerHandle` is a thin `Arc<SessionLedger>` wrapper with one escape hatch and named async methods added as sites convert.** `async fn run<R: Send>(&self, f: impl FnOnce(&SessionLedger) -> R + Send) -> R` runs `f` on `spawn_blocking`; named methods (`write_change`, the hot reads in [F03]) are added when a call site needs them more than once. The 98 `db.lock()` sites inside `SessionLedger` do not change: the facade moves where the blocking runs, not how the ledger locks. This is what keeps the arc a relocation and not a rewrite of a 15,000-line file.

**[B03] Conversion goes by the density table in [F03]: `agent_supervisor/mod.rs`, `agent_bridge.rs`, `recorder.rs`, `control/changeset.rs`, `feeds/arc.rs`.** Each file is one step; a site on a synchronous path (a recorder thread, a boot stage) keeps the direct `Arc<SessionLedger>` and says so in a comment, since `spawn_blocking` from a non-runtime thread is wrong in the other direction.

**[B04] The gauge is a debug-build assertion, not a grep.** The runtime builder names its worker threads (so `main` becomes a `Builder` with `thread_name`, which is also where the worker count becomes visible), the facade sets a thread-local while `run` executes, and `SessionLedger::db` access in debug builds asserts "not on a named worker, or inside a facade run". Every existing test exercises it. A grep for `ledger.` inside `async fn` would miss calls through helpers and flag calls that are already inside `spawn_blocking`.

**[B05] `prompt_ledger.rs` and the other ledgers are out of this arc unless the assertion in [B04] fires on them.** They have their own locks; the assertion is applied to `SessionLedger` only, and the arc records any other ledger the assertion would have caught if widened.

---

## Open Questions {#open-questions}

- Whether the forward's takeover-on-failure needs the lock held across the claim to stay correct against a concurrent `retry_changes_takeover` (:7334). The generation counter in [B01] is the default answer; the arc reads the five `changes_access` sites (:7139, :7155, :7334, :7366, :7376) before committing to it, and if the claim needs the lock, the claim stays under it and only the send leaves.

---

## Non-goals {#non-goals}

- **An async SQLite driver.** `rusqlite` on `spawn_blocking` is the design; the facade is the discipline.
- **Changing the `changes_access` before `db` lock order.**
- **Reducing the 98 `db.lock()` sites inside the ledger.** [B02].
- **Touching `arc_runner.rs`'s 27 `spawn_blocking`s.** They are already off the worker.

---

## Exit {#exit}

An arc. Steps: the forward out from under the lock with a test that stalls the forward endpoint and asserts the writer is not blocked ([B01]); the handle and the debug assertion with the named runtime ([B02], [B04]); then one file per step down the table in [B03]. `cargo nextest run -p tugcast` is each step's verdict. Run it one after the other with `supervisor-deps-and-control-frame`, never concurrently; both rewrite call sites across `agent_supervisor/mod.rs`.
