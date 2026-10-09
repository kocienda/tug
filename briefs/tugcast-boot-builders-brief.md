<!-- brief-skeleton v1 -->

# Shrink tugcast's `main` to a sequence of boot builders

**Purpose:** `tugrust/crates/tugcast/src/main.rs` has an `async fn main` of 2,166 lines that resolves paths, opens ledgers, runs migrations, constructs every feed, wires channels, spawns 27 tasks, serves HTTP, and handles shutdown, with seven small helpers beside it. Nothing in it can be constructed in a test, and the order the feeds are wired in is knowable only by reading all of it.

---

## Purpose {#purpose}

The second half of item 31 of `briefs/audit-punch-list.md`:

> 31. … and shrink tugcast's 2,280-line `main` to builders.

The `AppDelegate` half is `appdelegate-extraction-brief.md`. Startup order, every feed's construction arguments, and shutdown behaviour are held fixed.

---

## Evidence {#evidence}

**[F01] Shape** — `main` runs from line 88 to 2254; the file's other functions are `ensure_data_dir`, `seed_ledger` (a developer subcommand that never returns), `run_notify_listener`, `tcp_port_is_free`, `register_with_registry`, `force_kill_port_holder`, `reclaim_stale_process`, and `shutdown_reason_for_exit_code`. **(verified)**

**[F02] What `main` does, in its own comments and order** — panic hook; bundle-path marker; pack catalog ranks; machine-wide debris reclaim; own process group; developer subcommands; ledger seeding; port resolution and early bind; bank path; tmux version and session; auth state; control socket; terminal feed; file watcher; session ledger open with its refusal path; live-row demotion; prompt-history migration; cancellation token; text-card file service; bootstrap workspace registry; ledger publication wiring; then roughly 1,100 lines of feed construction and task spawning; the supervisor; two ink migrations; the HTTP server; shutdown and tmux teardown. **(verified by reading the section comments)**

**[F03] Counts** — 27 `tokio::spawn` calls; the spawned targets include the dispatcher, the merger, the arc engine, arc notes, base motion, the digest relay, the refs and shell dispatchers, the session-index watch, the resource sampler, the wheel, the notify listener, and two git snapshot builders. Feeds constructed with `::new` include `TerminalFeed`, `FileWatchService`, `WorkspaceRegistry`, `SharedAgentPool`, `ReplayBuffer`, `ObserverBridge`, `DigestBridge`, `ChangesetAllFeed`, `JotsState`, six `SessionScopedFeed`s, and the `FeedRouter`. **(verified)**

**[F04] Late binding through `OnceLock`** — five `.set(…)` calls inside `main` fill supervisor channels after construction, and eleven module-level `OnceLock` statics across the crate (`join_board`, `join_pilot`, `join_occupancy`, `join_resolver`, `base_motion`, `deck_seatings`, `claude_download`, `changeset` ×2, `path_resolver` ×2) are initialised somewhere in this sequence. The order is a fact only `main` knows. **(verified)**

**[F05] Integration tests exist but drive the binary** — eight files under `tugcast/tests/`, three of which spawn the built binary. Nothing constructs a partial runtime. **(verified)**

---

## Decisions {#decisions}

**[B01] A `boot` module with one function per stage, each taking the previous stage's struct and returning the next: `boot::early` (panic hook, marker, debris reclaim, process group, developer subcommands, seeding), `boot::bind` (port, listener, auth, control socket), `boot::ledgers` (session ledger open and refusal, demotion, prompt-history migration, ink migrations), `boot::feeds` (every feed and the router), `boot::supervisor`, `boot::serve`, `boot::shutdown`.** The structs are named for what they hold (`Bound`, `Ledgers`, `Feeds`, `Runtime`), and `main` becomes the sequence of calls, under a hundred lines. The order is preserved exactly; it just becomes readable as a list of stage names.

**[B02] Each stage's inputs are its parameters, not ambient state.** A stage that today reads a value computed 800 lines above receives it in the previous stage's struct. This is what makes `boot::ledgers` constructible in a test with a temp dir, and it is the only behaviour-adjacent part of the move: a stage that silently depended on an earlier side effect becomes a stage with a visible parameter.

**[B03] The eleven `OnceLock` statics are initialised in the stage that owns them today, with a comment naming the stage; they are not replaced.** Replacing them with a `Boards` struct is item 18, and the `Runtime` struct this arc builds is where that struct will live. Doing both at once would turn a move into a redesign.

**[B04] `boot::ledgers` and `boot::bind` get unit tests; the rest is verified by the integration tests and a launched app.** Ledgers can be opened against a temp data dir and the refusal path asserted; bind can take port 0. Feed construction needs the real world, and the three binary-spawning integration tests ([F05]) plus a `just app-test` core-tier run are its verdict.

**[B05] Order: `early` and `shutdown` first (the ends are the least entangled), then `bind`, `ledgers`, `serve`, and last `feeds` and `supervisor` together.** The feeds stage is the largest and the one the supervisor split touches; it goes last so that if `agent-supervisor-split` lands first, this stage is written against the new layout, and if it lands second, it finds the construction already in one place.

---

## Open Questions {#open-questions}

- Whether `agent-supervisor-split` and this arc should run back to back rather than interleaved. Both touch the supervisor's construction in `main`; the default is one after the other in either order, never concurrently, and the second to start reads the first's result.

---

## Non-goals {#non-goals}

- **Replacing the `OnceLock` statics or `LEDGER_HANDLE`.** Item 18. [B03].
- **Changing startup order, timeouts, or what any feed is given.** [B01].
- **Reducing the 27 spawns or giving them `JoinHandle`s.** The audit read fire-and-forget under a `CancellationToken` as acceptable; observing task panics is the panic hook's job today.

---

## Exit {#exit}

An arc. Steps as ordered in [B05], each ending with `cargo nextest run -p tugcast` green and `main` shorter; `boot::ledgers` and `boot::bind` land with their unit tests ([B04]). After the last step, the three binary-driving integration tests run, then the app-test core tier (`just app-test`) once, since `main.rs` runs before any test's first assertion.
