<!-- tugplan-skeleton v2 -->

## Multi-Session Router (T0.5 P2) {#multi-session-router}

**Purpose:** Land the runtime architecture for multiple concurrent Claude Code sessions behind a single `CODE_OUTPUT`/`CODE_INPUT` FeedId pair — a tugcode supervisor, `tug_session_id` stamping in the bridge, a CODE_INPUT dispatcher, a CODE_OUTPUT merger, session-scoped SESSION_METADATA routing, a session lifecycle feed (`SESSION_STATE = 0x52`), spawn/close/reset control actions, a tugdeck `FeedStore` filter API, a `tug_session_id`-aware `encodeCodeInput`, cross-client P5 relaxation, host-authoritative tugbank persistence of the card↔session map, and real Claude Code integration tests — unblocking all further TIDE: INPUT progress in T3.4.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | `tug-multi-session-router` |
| Last updated | 2026-04-12 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

Today tugcast spawns exactly one Claude Code subprocess (`main.rs:309` → `spawn_agent_bridge`) and funnels it through a single `CODE_OUTPUT` broadcast plus a single `CODE_INPUT` mpsc sender. The FeedRouter already uses dynamic `HashMap<FeedId, …>` maps (that refactor landed), so the structural ground is prepared — but every piece of runtime state above the router still assumes one Claude Code subprocess. The T3.4 Tide card depends on **D-T3-09** (Tide card ↔ session is 1:1 and two Tide cards mean two independent sessions), and T3.4.d explicitly gates multi-session on this phase. TIDE: INPUT cannot progress until this ships.

The wire approach ("keep `CODE_OUTPUT`/`CODE_INPUT` as single slots, stamp `tug_session_id` into the payload, filter client-side") is approved in `dash/tide.md §T0.5 P2` and the decision log in `dash/code-session-remediation.md`. This plan expands the 12-item architecture list in tide.md §T0.5 P2 into implementable steps plus the integration-test strategy, per the direction at the end of the remediation doc.

#### Strategy {#strategy}

- Introduce a single new module `tugcast/src/feeds/agent_supervisor.rs` that owns every piece of multi-session state: the ledger, the CODE_INPUT dispatcher, the CODE_OUTPUT merger, per-session crash budgets, per-session `system_metadata` routing, and the SESSION_STATE broadcast. The CODE_OUTPUT replay buffer stays shared at the router level per [D06] (client-side filter enforces correctness).
- Treat `agent_bridge.rs` as a per-session worker. Keep the subprocess-spawning / stream-json / handshake logic; remove its global singleton role. It becomes an implementation detail owned by the supervisor.
- Add the wire field `tug_session_id` by byte-splice in the bridge. Do not touch Claude Code's own `session_id` field. Track `claude_session_id` only in the supervisor ledger, never on the wire.
- Lazy spawn-on-first-input. `spawn_session` registers an intent record only; the subprocess is spawned when the first CODE_INPUT frame arrives. Mounted-but-unused Tide cards hold zero subprocess resources.
- Cross-client multi-session is in scope for v1. Relax P5 single-writer lock from `FeedId` to `(FeedId, tug_session_id)`.
- Land the tugdeck `FeedStore` filter API as part of this phase (part of the wire/filter contract). `CodeSessionStore` itself stays in T3.4.
- Integration tests spawn the real Claude Code binary, `#[ignore]`-gated under an env var so non-Claude CI stays green.

#### Success Criteria (Measurable) {#success-criteria}

- Two independent Tide cards (same browser or different browsers) running two concurrent Claude Code subprocesses never see each other's CODE_OUTPUT frames. Verified by `test_two_sessions_never_cross` integration test against real Claude Code.
- A freshly mounted Tide card that the user never types into holds zero Claude Code subprocess resources. Verified by `test_lazy_spawn_no_subprocess_until_first_input` which asserts process count is unchanged after `spawn_session` and increments after first `CODE_INPUT`.
- `CODE_INPUT` arriving for an unknown `tug_session_id` is rejected with a `session_unknown` control frame and does not spawn a subprocess. Verified by `test_orphan_input_rejected` unit test in the supervisor.
- Per-session crash budget (3 crashes / 60s) is isolated: one session's crash loop does not disable other sessions. Verified by `test_crash_budget_per_session` unit test.
- Cross-client P5 relaxation works: two websocket clients each claiming CODE_INPUT with distinct `tug_session_id`s both succeed; a second claim on the same id is rejected with `input_claimed`. Verified by `test_p5_relaxation_distinct_sessions` and `test_p5_relaxation_duplicate_rejected`.
- `FeedStore` filter runs on both live frames and `TugConnection.lastPayload` replay. Verified by `feed-store.test.ts` unit tests.
- Card↔`tug_session_id` mapping persists across tugcast restart in tugbank domain `dev.tugtool.tide.session-keys`. Verified by `test_supervisor_rebind_on_startup` integration test.
- Build + tests green: `cargo nextest run` (Rust), `bun test` (tugdeck), `cargo build` with `-D warnings` enforced per CLAUDE.md.

#### Scope {#scope}

1. New `tugcast/src/feeds/agent_supervisor.rs` module: supervisor, ledger, CODE_INPUT dispatcher task, CODE_OUTPUT merger task, per-session crash budget, per-session `system_metadata` routing (the merger writes `LedgerEntry::latest_metadata` directly — no separate registry type), SESSION_STATE publisher, control-action handler (`handle_control`), narrow `SessionKeysStore` trait for the card↔session map persistence surface (impl-ed for `TugbankClient`), and tugbank write-path for the card↔session map. CODE_OUTPUT replay buffer stays shared at the router level per [D06].
2. Modifications to `tugcast/src/feeds/agent_bridge.rs`: per-session spawn API owned by supervisor; `tug_session_id` constructor argument; byte-splice stamping on every outbound stream-json line; `claude_session_id` ledger entry on `session_init`; the existing shared CODE_OUTPUT replay path in `main.rs` stays unchanged.
3. Modifications to `tugcast/src/feeds/code.rs`: `splice_tug_session_id()` helper and `parse_tug_session_id()` helper (tagged on CODE_INPUT frames, read back by the dispatcher).
4. Modifications to `tugcast/src/router.rs`: `handle_client` CONTROL branch intercepts `spawn_session`/`close_session`/`reset_session` and calls `router.supervisor.handle_control()` directly; P5 input-ownership relaxation from `FeedId` to `(FeedId, tug_session_id)`.
5. Modifications to `tugcast/src/main.rs`: register supervisor instead of single `spawn_agent_bridge` call; register `SESSION_STATE` as a new broadcast stream output.
6. New `SESSION_STATE = 0x52` constant and new `TugSessionId` newtype (wire-level identifier) in `tugcast-core/src/protocol.rs` + `FeedId::name()` arms for both `SESSION_STATE` and the pre-existing `SESSION_METADATA` gap.
7. New `tugdeck/src/lib/feed-store.ts` optional fourth constructor argument `filter?: (feedId, decoded) => boolean`. Runs after decode, before snapshot update, on both live frames and the `TugConnection.lastPayload` replay cache hit inside `onFrame()`.
8. New `tugdeck/src/protocol.ts` constants for `SESSION_STATE` and the three new CONTROL action types; `encodeCodeInput` signature update to take `tug_session_id` and inject it into the outbound JSON payload.
9. New tugbank domain `dev.tugtool.tide.session-keys` for card↔`tug_session_id` map; supervisor rebinds on startup and writes (on spawn_session) / deletes (on close_session) entries itself.
10. Rewrite of `tugcast/src/feeds/session_metadata.rs` to route per-session (per [D14]) rather than holding a single global watch.
11. New integration-tests directory `tugrust/crates/tugcast/tests/` containing `multi_session_real_claude.rs` with the `#[ignore]`-gated real-Claude-Code tests.

#### Non-goals (Explicitly out of scope) {#non-goals}

- `CodeSessionStore` in tugdeck (stays scheduled for T3.4). **Note on the Step 7 → Step 9 inter-step relationship:** Step 7 makes missing-`tug_session_id` CODE_INPUT frames a hard-reject in the router, and Step 9 updates the `encodeCodeInput` signature to inject `tug_session_id`. In practice the wedge is entirely theoretical: `encodeCodeInput` has exactly one call site (the definition itself in `tugdeck/src/protocol.ts`). The sole text occurrence of `encodeCodeInput` outside the definition, in `tugdeck/src/__tests__/conversation-types.test.ts`, is explicitly listed in `tugdeck/tsconfig.json`'s `exclude` array (line 26) and does NOT participate in `bunx tsc --noEmit` or in the default `bun test` run for the gated suite. All live production CODE_INPUT dispatch paths in `tugdeck/src/components/tugways/cards/conversation-card.tsx` currently live under `_archive/` and are not active code. There is no live production code path that will observe the wedge window; the `encodeCodeInput` signature update is a pure definition-site change, and live production CODE_INPUT call sites will be reintroduced in T3.4 and will use the new signature from day one.
- **Substantial rework of `SessionMetadataStore` in tugdeck beyond a minimal, intentionally-degenerate gallery wiring.** The server-side `SessionMetadataFeed` IS rewritten in this phase per [D14] (it has to be for correctness, and the type is changing from `watch::channel` to `broadcast::channel`). The one live consumer on the tugdeck side — `SessionMetadataStore` instantiated in `tugdeck/src/components/tugways/cards/gallery-prompt-input.tsx` for slash-command completions — is updated in Step 9 to wrap a `FeedStore` that uses **no filter** (passthrough). See the "Gallery-demo slash-command completions under multi-session" non-goal below for the rationale. No internal reshaping of `SessionMetadataStore` itself (state model, render shape, subscription lifecycle) is in scope.
- **Gallery-demo slash-command completions under multi-session are last-writer-wins; the gallery is a test harness per its own file header comment.** `tugdeck/src/components/tugways/cards/gallery-split-pane.tsx` explicitly documents itself as "a test harness for iterating on TugSplitPane under HMR. It is **not** a target environment." Slash-command completions in the gallery are a dev convenience, not a production feature. Under multi-session, the gallery `SessionMetadataStore` wraps a `FeedStore` with **no filter** (or a constant-true filter) and accepts cross-session pollution: when multiple Claude Code subprocesses are live, the gallery prompt input will display whichever session's `system_metadata` arrived most recently — last-writer-wins semantics, same as today's single-subprocess behavior. Real production slash-command completions for Tide cards are scheduled for T3.4, where the proper per-card `tug_session_id` filter is wired through `CodeSessionStore`. An earlier draft of this plan claimed the gallery "will behave indistinguishably from today" and mandated a minted-per-mount random `tug_session_id` filter; that claim was wrong (the minted UUID never has a spawned subprocess behind it, so the filter would drop every real session's metadata) and is retracted in favor of this explicit passthrough + accepted-pollution stance.
- Claude Code `--resume` semantics. Reload-with-same-key always means a fresh subprocess with empty history.
- A shared global supervisor spawn rate limit (e.g., "N spawns per 10s"). Acknowledged as a future concern; not implemented in P2.
- Bridge test-mode / fake tugcode binary. Tests run against real Claude Code only (per user direction in the remediation doc).
- Generalizing `input_sinks` to a polymorphic `InputRoute` enum. The CODE_INPUT dispatcher is hand-coded inside the supervisor; the generalization is premature until a second backend needs the same pattern.
- Multi-client collaborative editing on the same `tug_session_id`. Cross-client multi-session means two clients on distinct ids, not two clients writing the same id.

#### Dependencies / Prerequisites {#dependencies}

- T0.5 P1 (open FeedId) is landed — FeedId is an open newtype so `SESSION_STATE = 0x52` can be added cleanly.
- Dynamic router refactor (`stream_outputs: HashMap<FeedId, …>`, `input_sinks: HashMap<FeedId, …>`, `register_stream` / `register_input`, `tokio_stream::StreamMap` fan-in) — already landed (router.rs:157, main.rs:319–360).
- Replay buffer / lag policy infrastructure (`ReplayBuffer`, `LagPolicy::Replay`) — already landed.
- Real Claude Code binary available in the developer environment (tests gate on an env var; non-Claude CI stays green).

#### Constraints {#constraints}

- **Warnings are errors.** `tugrust/.cargo/config.toml` enforces `-D warnings`; every step must compile and test clean.
- No new binaries. Supervisor is an in-process module inside tugcast.
- Wire contract is purely additive: no existing payload fields change semantics. `tug_session_id` is spliced as the first field of outbound CODE_OUTPUT JSON lines; all existing consumers continue to work.
- Lazy spawn must not block card mount. `spawn_session` is fire-and-forget and returns immediately after writing the intent record.
- Bounded memory: per-session CODE_INPUT queue capped at 256 frames; CODE_OUTPUT replay buffer stays a single shared 1000-frame ring (unchanged from today, per [D06]).

#### Assumptions {#assumptions}

- The `SESSION_METADATA` (0x51) feed becomes session-scoped in this phase. `SessionMetadataFeed`'s single global `watch::channel` is deleted and replaced with a supervisor-owned `broadcast::Sender<Frame>` plus on-subscribe replay driven by the supervisor (see [D14]). A single global watch would cross-pollinate metadata between concurrent sessions (the last-arriving `system_metadata` would clobber the rest), and a watch cannot be fixed downstream of the producer — the correctness problem lives at the channel type.
- As a direct consequence of [D02] splice stamping, every outbound CODE_OUTPUT frame — including frames that subsequently get republished as SESSION_METADATA — has `tug_session_id` as its first JSON field. SESSION_METADATA consumers therefore see a new additive field. The "SessionMetadataStore continues to work unchanged" framing from earlier drafts of this plan is **retracted outright**. The one live pre-T3.4 consumer (`SessionMetadataStore` in `tugdeck/src/lib/session-metadata-store.ts`, used by `gallery-prompt-input.tsx`) is instantiated in the **gallery, which is explicitly a test harness** per `gallery-split-pane.tsx`'s own file-header comment. Under multi-session, the gallery `FeedStore` uses **no filter** and accepts last-writer-wins pollution (see the corresponding non-goal for the full rationale). Real Tide cards outside the gallery will be wired with proper per-card `tug_session_id` filters in T3.4 via `CodeSessionStore`; that work is explicitly out of scope here.
- The `project_info` startup broadcast in `run_agent_bridge` is deleted along with the `project_info_tx` watch latch. Today `run_agent_bridge` emits `project_info_frame` on BOTH the shared `code_tx` broadcast AND the `project_info_tx` watch latch at startup (both pre-handshake). Under [D02] the splice rule would have to stamp a `tug_session_id` onto this broadcast emission, but the frame has no live non-`_archive/` consumer (the watch side has none by direct grep; the broadcast side has none because no current subscriber filters for `project_info` specifically), so instead of splicing it we delete the whole emission. The removed code is: the `let _ = code_tx.send(project_info_frame.clone());` line, the `let _ = project_info_tx.send(project_info_frame);` line, and the entire `project_info_frame` / `project_info_json` construction block that feeds them. This is cleaner than splicing a startup frame that nobody consumes.
- The existing `AgentBridgeHandles` / `spawn_agent_bridge` API in `agent_bridge.rs` is replaced by the new supervisor. `agent_bridge.rs` becomes a per-session implementation detail owned by the supervisor.
- **The two pre-existing snapshot watches wired through `AgentBridgeHandles.snapshot_watches` — `project_info_tx` (emitted once at bridge startup) and `session_watch_tx` (latched on every stdout `session_init` line) — are deleted outright in this phase.** Both have zero live non-`_archive/` consumers today; under multi-session each would exhibit the same last-writer-wins cross-pollination bug as the old SESSION_METADATA watch, so keeping them would leave a dormant footgun for the next feature that tripped over them. The `run_agent_bridge` signature loses both `watch::Sender<Frame>` arguments, `AgentBridgeHandles` is removed (or collapsed so the field set it used to export is empty), and `main.rs` no longer calls `agent_handles.snapshot_watches.extend(...)` or `feed_router.add_snapshot_watches(agent_handles.snapshot_watches)`. Step 6 owns the bridge-side deletions; Step 8 owns the `main.rs` wiring deletion.
- The tugbank domain name `dev.tugtool.tide.session-keys` is the authoritative name for the card-to-`tug_session_id` map. Writes are host-authoritative: the supervisor writes on every `spawn_session` and deletes on every `close_session`. The card does not write to this domain.
- Integration tests land under a new `tugrust/crates/tugcast/tests/` directory (Rust's standard `tests/` integration-test convention), not the existing `src/integration_tests.rs` module. They extend the existing `#[ignore]` pattern used for the tmux-dependent test in `src/integration_tests.rs` with an additional explicit `TUG_REAL_CLAUDE=1` env-var gate.
- The wire field is `tug_session_id`; Claude Code's own `session_id` is tracked supervisor-internal as `claude_session_id` and is never on the wire.
- `TugSessionId` is defined in `tugcast-core/src/protocol.rs` alongside `FeedId`, because it is a wire-level identifier used by both `router.rs` (P5 ownership) and `agent_supervisor.rs` (ledger). Locating it in core avoids a `router → feeds::agent_supervisor → router` dependency cycle.

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

Anchors in this plan follow the conventions defined in `tuglaws/tugplan-skeleton.md §reference-conventions`: explicit kebab-case, `step-N`, `dNN-…`, `sNN-…`, `tNN-…`, `lNN-…`, `rNN-…`, `qNN-…`. No line numbers in references — cite anchors.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Global supervisor spawn rate limit (DEFERRED) {#q01-global-spawn-rate-limit}

**Question:** Should the supervisor enforce a global spawn rate limit (e.g., no more than N Claude Code subprocesses spawned within a 10-second window) in addition to the per-session crash budget?

**Why it matters:** A runaway client (or a malicious one) could open many Tide cards and immediately type into each, spawning N Claude Code subprocesses simultaneously and exhausting CPU / memory / API quota. The per-session crash budget in [D07] only protects against one session's crash loop; it does not cap aggregate resource use.

**Options (if known):**

- Global token-bucket rate limiter inside the supervisor, applied at `maybe_spawn_on_first_input()` entry.
- Global hard cap on concurrent live sessions (e.g., 10), with new spawns returning `session_rate_limited` on SESSION_STATE.
- Defer entirely — rely on the per-session budget for now, revisit once we see real usage patterns.

**Plan to resolve:** Defer. Document as acknowledged-but-out-of-scope per user direction. Revisit if real-world usage exposes the concern.

**Resolution:** DEFERRED. Not required for T0.5 P2 exit; tracked as a follow-on item in [#roadmap].

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| [R01] Byte-splice corrupts a stream-json line and breaks downstream consumers | high | low | Splice only after confirming the line begins with `{`; unit-test the splice helper against malformed lines; on failure, pass the original line through unchanged with a warn! log | Any parse error reported by `SessionMetadataFeed` or downstream clients after P2 lands |
| [R02] Lazy-spawn race: two CODE_INPUT frames for the same `tug_session_id` arrive simultaneously and both try to spawn | high | medium | Dispatcher serializes spawn-per-session via a `HashMap<TugSessionId, SpawnState>` where `SpawnState` is `Idle` / `Spawning` / `Live`; only the `Idle → Spawning` transition actually spawns, the second caller queues into the per-session 256-frame buffer | Any observation of duplicate subprocesses for one id in integration tests |
| [R03] Shared CODE_OUTPUT replay buffer holds closed-session frames briefly after close_session | low | medium | Replay buffer is a bounded 1000-frame ring (unchanged from today); closed-session frames age out as the ring fills. Known limitation of [D06] v1; follow-on `LagPolicy::ReplayPerClient` variant tracked in [#roadmap]. Supervisor still enforces a global concurrent-session soft-cap via log warning at >20 live sessions (hard cap deferred per [Q01]) | Memory profile shows unbounded growth in a long-running tugcast session, OR user-visible cross-session frames leaking past the client filter during lag recovery |
| [R04] Cross-client P5 relaxation regresses existing single-writer semantics for non-CODE_INPUT feeds | high | low | `(FeedId, tug_session_id)` keying applies only to CODE_INPUT. TERMINAL_INPUT, TERMINAL_RESIZE, and FILETREE_QUERY continue to use the bare `FeedId` key. New ownership helper is written as a sum type so the non-session path stays byte-for-byte identical | Any regression in existing P5 unit tests around TERMINAL_INPUT ownership |
| [R05] Real-Claude-Code integration tests are flaky because of LLM non-determinism | medium | medium | Use deterministic-enough prompts (`> /status`, `> say exactly the word hello`) and assert only on the presence of the wire-level envelope (`session_init`, `assistant_text`, `turn_complete`), not on LLM content. Gate on `TUG_REAL_CLAUDE=1` env var so non-Claude CI stays green | Any integration test failure where the failure reason is LLM content drift rather than wire-level correctness |
| [R06] Close/spawn TOCTOU leaves the ledger in an inconsistent state when `close_session` and `spawn_session` for the same `tug_session_id` race across clients or across a reset | high | low | Step 4's `do_close_session` and `do_spawn_session` release the outer ledger mutex between the lookup and the drop/insert. Step 5 closes the window by holding the per-session `Mutex<LedgerEntry>` across the state check-and-mutate, gating every mutation through `SpawnState::try_transition`. See [#r06-close-spawn-toctou] | Any observation of a session whose `SESSION_STATE` frames arrive out of order, or an `Arc<Mutex<LedgerEntry>>` that outlives its map entry while a concurrent spawn resurrects the same key |

**Risk R01: Byte-splice corrupts a stream-json line** {#r01-splice-corruption}

- **Risk:** Splicing `"tug_session_id":"<id>",` at byte offset 1 of each outbound line from Claude Code could corrupt payloads that are not standard JSON objects (e.g., blank lines, partial lines, or future stream-json shapes we don't yet know about).
- **Mitigation:**
  - Only splice if the line begins with `{` and has length > 1.
  - Drop non-JSON lines with a `warn!` log, never splice them.
  - Unit-test the splice helper (`splice_tug_session_id`) with empty input, `{}`, a realistic `session_init`, and a malformed line.
- **Residual risk:** A future Claude Code stream-json shape where `{...}` does not begin immediately at offset 0 would trip the heuristic. Mitigated by fail-safe (pass-through + warn) rather than fail-loud.

**Risk R02: Lazy-spawn race** {#r02-lazy-spawn-race}

- **Risk:** First CODE_INPUT frame for a session arrives while the supervisor is still parsing the intent record or while another frame for the same session is already in flight to `maybe_spawn()`.
- **Mitigation:**
  - Per-session `SpawnState` enum inside the ledger, mutated under a single `tokio::sync::Mutex<LedgerEntry>` per session.
  - Only the `Idle → Spawning` transition spawns; subsequent callers during `Spawning` append to the per-session 256-frame buffer.
  - Transition to `Live` happens atomically after the child stdin is writable and the first queued frame has been written.
- **Residual risk:** During the `Spawning` window, the 256-frame cap can be reached on a pathological client that types very fast. In that case we emit a `session_backpressure` control frame and drop further frames until the subprocess is Live.

**Risk R06: Close/spawn TOCTOU** {#r06-close-spawn-toctou}

- **Risk:** `close_session` and `spawn_session` for the same `tug_session_id` race. Step 4's `do_close_session` implementation is a three-phase operation — (1) `ledger.lock().await.get(id).clone()` to get the `Arc<Mutex<LedgerEntry>>`, (2) mutate under the per-session lock, (3) `ledger.lock().await.remove(id)` to drop — that **releases the outer ledger mutex between phases 1 and 3**. A concurrent `do_spawn_session` interleaved between those phases can:
  1. Observe the entry still in the map (phase 1's lookup hasn't `remove`-d yet), add the id to `client_sessions[other_client]`, re-publish `pending`, and return `Ok(())`.
  2. The original `do_close_session` then proceeds to phase 3 and removes the entry that the concurrent spawn just re-announced — leaving the ledger empty while `client_sessions[other_client]` still references the now-missing id.
  3. Alternatively, the concurrent spawn can land AFTER `do_close_session`'s phase 3 `remove`, `HashMap::entry(...).or_insert_with(...)` a fresh entry, and win the key — but only after the close has published `closed`. The resulting SESSION_STATE stream observes `closed` followed by `pending` for the same id without any client intent between them.
- **Mitigation:** Step 5 closes the window. The fix is to gate every mutation through `SpawnState::try_transition` under the per-session `Mutex<LedgerEntry>` and to take the outer ledger lock exactly once per operation:
  - `do_close_session`: outer lock → `HashMap::remove` the entry up front → drop outer lock → per-session lock → `try_transition(Closed)` → publish `closed`. A concurrent spawn that arrives after the `remove` observes a missing key and `HashMap::entry(...).or_insert_with(...)` creates a fresh entry, which is correct (the close is finished from the map's perspective, and the new spawn is a legitimate new intent).
  - `do_spawn_session`: outer lock → `HashMap::entry(...).or_insert_with(...)` → `Arc::clone` → drop outer lock → per-session lock → `try_transition` only if state allows (`Idle` → no-op for reconnect; `Spawning`/`Live` → idempotent no-op; `Closed` → refuse, return `Err(_)` and let the caller retry). A concurrent close that already removed the key loses the race cleanly: the spawn sees a fresh `Idle` entry, which is the correct post-close state.
  - Both paths serialize SESSION_STATE publication under the per-session lock so frame order matches state-machine order.
- **Residual risk:** Between `do_close_session`'s `remove` and a subsequent unrelated `do_spawn_session` with the same id, a `SESSION_STATE` subscriber could observe `closed` → (briefly no entry) → `pending`, which is the correct order. Acceptable. The pathological case is a `spawn_session` for id X arriving AFTER the close's `remove` but BEFORE a different `spawn_session` for the same X from a different client — both spawns race `HashMap::entry`, one wins, the loser sees the winner's entry, and both return `Ok(())`. This is correct idempotent behavior and explicitly tested by `test_spawn_session_idempotent`.
- **Status as of commit a04e2359 (Step 4):** The three-phase close is committed to `main`. The TOCTOU window is known, documented, and closed by Step 5's state-machine integration. Step 5's task list carries an explicit bullet: **"Close the Step 4 TOCTOU window"** — see the task list in [#step-5].

---

### Design Decisions {#design-decisions}

#### [D01] `tug_session_id` is the wire field, `claude_session_id` is supervisor-internal (DECIDED) {#d01-session-id-naming}

**Decision:** The wire field is `tug_session_id` (a UUID minted by the Tide card at mount). Claude Code's own `session_id` field inside `session_init` / `system_metadata` is left untouched. The supervisor tracks the Claude-Code-emitted id as `claude_session_id` in its private ledger.

**Rationale:**

- Eliminates collision with Claude Code's own `session_id` inside `session_init` and the load-bearing `system_metadata` shape consumed by `SessionMetadataFeed`/`SessionMetadataStore`.
- Resolves the bootstrap race by construction: the card knows its `tug_session_id` at mount, so there is no handoff window.
- Lets existing `SessionMetadataFeed` keep working without changes.

**Implications:**

- The bridge splices `"tug_session_id":"<id>",` only; never overwrites Claude Code's `session_id` field.
- The supervisor ledger has two fields per session: `tug_session_id` (known at `spawn_session` time) and `claude_session_id` (populated when `session_init` arrives over stdout).
- The client filter and the dispatcher both key on `tug_session_id`, never on `claude_session_id`.

---

#### [D02] `tug_session_id` is stamped into every outbound CODE_OUTPUT by byte-splice, not envelope (DECIDED) {#d02-splice-stamping}

**Decision:** The bridge injects `"tug_session_id":"<id>",` as the first field of each outbound stream-json line by byte-splice at offset 1 (immediately after the opening `{`). No envelope wrapper.

**Rationale:**

- Splice is ~one allocation per frame; envelope is a full re-serialize plus a breaking change for every consumer.
- Purely additive: existing consumers that don't read the field see no semantic change.
- Keeps `SessionMetadataFeed` working untouched (it filters on `"type":"system_metadata"`, which is unchanged).

**Implications:**

- The splice helper must fail-safe on malformed lines (pass through + `warn!` log; see [#r01-splice-corruption]).
- Unit tests cover empty input, `{}`, realistic `session_init`, and malformed lines.

---

#### [D03] Supervisor owns CODE_INPUT dispatcher, CODE_OUTPUT merger, per-session metadata routing, and the control-action handler in a single module (DECIDED) {#d03-supervisor-consolidation}

**Decision:** A single new module `tugcast/src/feeds/agent_supervisor.rs` owns the ledger, the CODE_INPUT dispatcher task, the CODE_OUTPUT merger task, per-session crash budgets, the per-session `system_metadata` registry (per [D14]), the SESSION_STATE publisher, and the control-action handler. `agent_bridge.rs` is demoted to a per-session worker whose lifecycle the supervisor manages. The CODE_OUTPUT replay buffer stays shared at the router level per [D06]; the supervisor does not own it.

**Rationale:**

- Avoids scattering session state across three types (per the remediation assessment).
- A single mutex-guarded ledger is easier to reason about than cross-module state.
- The merger needs the ledger to know which `tug_session_id` a frame belongs to for the replay buffer; coupling them in one module keeps the data path short.

**Implications:**

- The supervisor holds `Arc<AgentSupervisor>` and is shared into `FeedRouter` and the CONTROL dispatch path.
- `agent_bridge.rs` loses its `AgentBridgeHandles` / `spawn_agent_bridge` public surface. Its public API becomes a per-session spawn function owned by the supervisor module.
- `main.rs` no longer calls `spawn_agent_bridge` directly — it constructs an `AgentSupervisor` and registers its input/output channels with the router.

---

#### [D04] Lazy spawn-on-first-input; `spawn_session` only writes an intent record (DECIDED) {#d04-lazy-spawn}

**Decision:** `spawn_session(tug_session_id)` on CONTROL is fire-and-forget. The supervisor writes an intent record into the ledger and publishes `SESSION_STATE = pending`. The Claude Code subprocess is not spawned until the first CODE_INPUT frame for that `tug_session_id` arrives.

**Rationale:**

- Twenty mounted but unused Tide cards must not pin twenty Claude Code subprocesses.
- Reload-after-crash becomes cheap: the reload rebinds intent records without spawning anything until the user types.
- Removes any synchronous "wait for session_init" rendezvous at card mount; cards are interactive immediately.

**Implications:**

- Between first CODE_INPUT arrival and the child's stdin being writable there is a brief buffering window (the per-session 256-frame queue in [D05]).
- The per-session `SpawnState` (`Idle` / `Spawning` / `Live`) must be mutated atomically to prevent double-spawn on a burst of frames (see [#r02-lazy-spawn-race]).
- `SESSION_STATE` publishes `pending` → `spawning` → `live` as each transition completes.

---

#### [D05] Per-session bounded CODE_INPUT queue, cap 256, overflow → `session_backpressure` (DECIDED) {#d05-bounded-queue}

**Decision:** The dispatcher holds a per-session bounded queue (capacity 256 frames) for CODE_INPUT frames that arrive during the spawn window. Once the subprocess is Live, the queue drains into stdin. Overflow emits a `session_backpressure` control frame and drops further frames until drain.

**Rationale:**

- Prevents unbounded memory growth on a fast-typing client during a slow spawn.
- 256 frames is ~orders of magnitude larger than any realistic typing burst, so the backpressure path is genuinely exceptional.
- Explicit backpressure control frame lets the UI show a diagnostic rather than silently dropping.

**Implications:**

- The queue is per-`tug_session_id`, not global. One session's backpressure does not affect any other session.
- The dispatcher must re-check `SpawnState` after every drain to handle mid-drain transitions cleanly.

---

#### [D06] Keep a single shared CODE_OUTPUT replay buffer; rely on client-side filter (DECIDED) {#d06-shared-replay-client-filter}

**Decision:** Keep exactly one shared `CODE_OUTPUT` `ReplayBuffer` at the router level (the existing `code_replay` registered in `main.rs` stays). The supervisor does not own per-session replay buffers in this phase. When a WebSocket client lags and `LagPolicy::Replay` fires, the router replays the entire shared buffer to the client and the card's `FeedStore` filter ([D11]) drops any frames whose `tug_session_id` does not match the card's own. Correctness is enforced end-to-end by the client filter, which already runs on every frame (live, reconnect, and `lastPayload` replay).

**Rationale:**

- The router's current lag-recovery code path extracts a single `ReplayBuffer` out of `LagPolicy::Replay(replay_buf)` and calls `replay_buf.snapshot()`. It has no notion of `tug_session_id` at that point, and a single WebSocket client may host any number of Tide cards (each with its own `tug_session_id`), so there is no "the reconnecting session" to key off.
- The `tug_session_id` splice ([D02]) means every replayed frame already carries its session id in the JSON payload. The client filter inside `FeedStore` ([D11]) runs on replay frames with no additional code, so correctness is preserved.
- Introducing a `LagPolicy::ReplayPerClient` variant plus a supervisor-owned `client_id → Vec<TugSessionId>` map (kept up to date by the CONTROL `spawn_session`/`close_session` interceptor) is the correct long-term direction but adds substantial cross-cutting state for a v1 whose success criterion is "isolation works end-to-end", which the client filter already satisfies.
- Same total replay memory as today (1000 frames, capacity unchanged). Per-session replay buffers would have multiplied memory by the session count and required the variant-change work above.

**Implications:**

- The `LagPolicy::Replay(ReplayBuffer)` registration in `main.rs` is unchanged from today. Step 8 does not rework it.
- On lag recovery the client briefly receives foreign-session frames that the `FeedStore` filter immediately drops. Bandwidth-bounded by the existing 1000-frame replay cap; user-invisible because the filter runs before the snapshot update ([D11]).
- **Known limitation (accepted for v1):** `close_session` does not free its contribution to the shared replay buffer immediately — those frames age out naturally as the ring buffer fills. Because the buffer is capped at 1000 frames globally (unchanged from today), this is bounded memory, not a leak.
- **Follow-on:** `LagPolicy::ReplayPerClient` with supervisor-owned `client_id → Vec<TugSessionId>` map is tracked in [#roadmap] as a correct-long-term replacement once real usage shows the shared-buffer approach is insufficient (e.g., if 20 concurrent sessions dilute a single session's replay content below the useful threshold).

**Cross-reference:** The client filter's correctness guarantee is [D11]; the splice that makes filtering possible is [D02]; the roadmap follow-on is listed in [#roadmap].

---

#### [D07] Per-session crash budget, 3 crashes / 60 seconds, isolated (DECIDED) {#d07-per-session-crash-budget}

**Decision:** Each session gets its own 3-crashes-per-60-seconds budget, tracked in the ledger. When a session trips its budget, the supervisor kills the subprocess, drops the per-session sender from the dispatcher, publishes `SESSION_STATE = errored{reason: "crash_budget_exhausted"}`, and leaves the intent record so the user can `reset_session`. Other sessions are unaffected.

**Rationale:**

- A shared global budget would violate session independence ([D03], [D08], and the P5 relaxation).
- One session's crash loop must not take down other sessions' work.
- The existing `CrashBudget` struct in `agent_bridge.rs` already implements the per-instance semantics — each session gets its own instance.

**Implications:**

- A global spawn-rate limiter is out of scope for P2 (see [Q01] — deferred).
- The intent record survives crash-budget exhaustion, so `reset_session` is the explicit path to re-arm a session.

---

#### [D08] P5 single-writer lock relaxes from `FeedId` to `(FeedId, tug_session_id)` (DECIDED) {#d08-p5-relaxation}

**Decision:** The `input_ownership` map keys on `(FeedId, Option<TugSessionId>)` instead of `FeedId`. For CODE_INPUT, the `Option` is always `Some`. For every other input feed (TERMINAL_INPUT, TERMINAL_RESIZE, FILETREE_QUERY), the `Option` is always `None` (legacy behavior, byte-for-byte preserved).

**Rationale:**

- Lets two browsers each own distinct `tug_session_id`s without collision while still rejecting a duplicate claim on the same id.
- Keeps non-CODE_INPUT behavior unchanged — TERMINAL_INPUT remains per-feed single-writer.
- Explicitly in scope per user direction ("we're stopping to go back on this work after already passing through here once"; no deferral behind intra-client-only).

**Implications:**

- `try_claim_input` and `release_inputs` signatures take an `Option<TugSessionId>` arg.
- The existing P5 unit tests continue to pass by passing `None` for the session argument. New unit tests cover the (CODE_INPUT, tug_session_id) paths.

---

#### [D09] Control-frame routing: intercept in router, not in `dispatch_action` (DECIDED) {#d09-control-routing}

**Decision:** `handle_client`'s CONTROL branch parses the payload, reads the `action` field, and if it is `spawn_session` / `close_session` / `reset_session`, calls `router.supervisor.handle_control(action, payload).await` directly. Otherwise falls through to `dispatch_action`. `dispatch_action`'s signature does not change.

**Rationale:**

- Matches the existing HEARTBEAT interception pattern in the same function.
- Avoids threading an `Arc<AgentSupervisor>` through `dispatch_action`, which is shared across ingress paths (HTTP tell, UDS tell, WebSocket) that don't all need session routing.
- Keeps `dispatch_action` focused on broadcastable client actions (relaunch, eval-response, generic fallback).

**Implications:**

- `FeedRouter` gains a `supervisor: Arc<AgentSupervisor>` field.
- A one-line comment at the top of `dispatch_action` names the session actions that are handled upstream and points to `agent_supervisor.rs` (mitigation for locality loss).
- `spawn_session` / `close_session` / `reset_session` are not broadcastable — they are always per-session and always handled locally.

---

#### [D10] `SESSION_STATE = 0x52` is a new broadcast FeedId slot (DECIDED) {#d10-session-state-feed}

**Decision:** Add a new FeedId constant `SESSION_STATE = Self(0x52)` in `tugcast-core/src/protocol.rs`. It is a broadcast feed (not a watch) — an event stream of lifecycle transitions across all sessions. Payload shape: `{tug_session_id, state, detail?}` where `state ∈ {pending, spawning, live, errored, closed}`.

**Rationale:**

- The card needs an ACK mechanism for `spawn_session` and a place to read spawn errors. A broadcast feed with client-side filtering on `tug_session_id` fits the pattern exactly.
- Using a separate FeedId (instead of overloading CONTROL) keeps the namespace honest and lets `FeedStore` with a session-keyed filter subscribe directly.
- `0x52` is the next available slot after `SESSION_METADATA = 0x51` and does not collide with any existing or reserved constant.

**Implications:**

- `FrameFlags` debug/name coverage extended.
- `tugdeck/src/protocol.ts` mirrors the constant.
- The supervisor owns the `SESSION_STATE` broadcast sender; `main.rs` registers it as a stream output.
- `live` is published when the bridge sees `session_init` from Claude Code (at which point `claude_session_id` lands in the ledger per [D01]).

---

#### [D11] `FeedStore` filter runs on both live frames and `TugConnection.lastPayload` replay (DECIDED) {#d11-filter-scope}

**Decision:** `FeedStore`'s constructor gains an optional fourth argument `filter?: (feedId: FeedIdValue, decoded: unknown) => boolean`. The filter runs inside `FeedStore`'s frame handler immediately after decode, before the snapshot-update path. Because `TugConnection.onFrame()` replays the cached `lastPayload` synchronously to a new subscriber, the filter naturally runs on replay too — the replayed payload flows through exactly the same decode → filter → snapshot path.

**Rationale:**

- "Live-only" filtering would let a card mounting mid-session briefly see the last CODE_OUTPUT frame from another session before the filter kicks in — a user-visible UI flash and a correctness bug.
- Locating the filter inside `feed-store.ts`'s frame handler keeps `TugConnection` session-agnostic. `TugConnection` never needs to know about `tug_session_id`.
- The single-slot `lastPayload` cache in `connection.ts` is not a substitute for per-session client caching. A mid-session mount whose session's last frame was overwritten by another session simply gets nothing until the next live frame or a server-side reconnect replay.

**Implications:**

- `feed-store.ts` unit tests cover both the live-frame path and the replay-on-subscribe path.
- `CodeSessionStore` (in T3.4) subscribes as `new FeedStore(conn, [CODE_OUTPUT, SESSION_STATE], decode, (fid, decoded) => decoded.tug_session_id === key)`.

---

#### [D12] tugbank domain `dev.tugtool.tide.session-keys` holds the card↔`tug_session_id` map (DECIDED) {#d12-tugbank-domain}

**Decision:** A new tugbank domain `dev.tugtool.tide.session-keys` persists the card↔`tug_session_id` mapping. Card id and `tug_session_id` have distinct lifecycles: "reset this card's session" mints a new `tug_session_id` without disturbing the card id.

**Rationale:**

- tugbank is the project's canonical durable key-value store; no new persistence substrate.
- Domain-scoped naming follows the existing convention (`com.example.settings`, etc.).
- Separate lifecycles let the UI offer "reset session" without destroying card state (history, layout, etc.).

**Implications:**

- Reload semantics: the supervisor rebinds intent records from tugbank on startup but does not eagerly spawn subprocesses (consistent with [D04]). The prior `claude_session_id` is discarded — a fresh Claude Code subprocess is spawned on first input with the same `tug_session_id`, empty history.
- Reload-after-crash follows the same path: rebind-then-spawn-on-first-input.
- `--resume` is not used (per the remediation decision log).
- **Tugbank write/delete failure policy is asymmetric:** `spawn_session` treats a tugbank write failure as a hard error and returns `Err(ControlError::PersistenceFailure)` from `handle_control`, so the caller (`handle_client`) can send a CONTROL error frame on the in-scope socket and the card can surface the failure to the user. This is the correct policy because a silent write failure would leave the in-memory ledger populated but tugbank empty, and on the next tugcast restart the session would silently vanish with no error signal — the worst possible UX. `close_session`, by contrast, treats a tugbank delete failure as best-effort: the in-memory cleanup proceeds (ledger entry dropped, subprocess killed, SESSION_STATE published), and the delete failure is logged via `warn!` but does not propagate as an error. Rationale: the residual tugbank entry is benign — on the next tugcast restart, `rebind_from_tugbank` re-creates a `pending` ledger entry for the lingering id, which is harmlessly re-bound and will be properly cleaned up the next time the user closes its card. Symmetric strict handling would turn a benign cleanup failure into a user-visible error frame on the close path, which would not help the user recover anything. This asymmetry is load-bearing and must not be "simplified" to symmetric.

---

#### [D13] Integration tests run against real Claude Code, `#[ignore]`-gated with an explicit `TUG_REAL_CLAUDE=1` env-var check (DECIDED) {#d13-integration-tests}

**Decision:** A new `tugrust/crates/tugcast/tests/multi_session_real_claude.rs` integration-test file spawns the real Claude Code binary. Tests are marked `#[ignore]` **and** each test additionally checks `std::env::var("TUG_REAL_CLAUDE").ok().as_deref() == Some("1")` at the top and returns early if unset (belt-and-suspenders — the env-var gate is new in this phase). The binary is discovered via `resolve_tugcode_path()`, the same mechanism tugcast uses at runtime. CI without Claude Code stays green.

**Rationale:**

- User direction in the remediation doc: "We should use real Claude Code! ... No mocks or modes for this."
- Extends the existing `#[ignore]` pattern used for the tmux-dependent test in `src/integration_tests.rs` (which uses only `#[ignore]`, no env-var gate) with a new explicit env-var check so developers can blanket-run `--run-ignored` without spuriously executing the Claude-Code-dependent tests.
- Deterministic-enough prompts (`> /status`, `> say exactly the word hello`) exercise the wire pipeline without depending on LLM output details.

**Implications:**

- Tests land under `tugrust/crates/tugcast/tests/` (new directory), not `src/integration_tests.rs`. Rust's standard `tests/` convention runs them as separate integration-test binaries.
- Test helpers (WebSocket client, control-frame builders, session-state waiters) live in `tugrust/crates/tugcast/tests/common/mod.rs`.
- Assertions target wire-level envelope (`session_init`, `assistant_text`, `turn_complete`) only, never LLM content.

---

#### [D14] `SESSION_METADATA` becomes a broadcast feed with event-driven per-session replay on `spawn_session` (DECIDED) {#d14-session-scoped-metadata}

**Decision:** Replace the single global `SessionMetadataFeed` `watch::channel` with a `broadcast::channel` driven by the supervisor. For each live session, the supervisor stores the latest `system_metadata` frame in `LedgerEntry::latest_metadata` and publishes it on the SESSION_METADATA **broadcast** sender at merge time. **Per-session metadata replay is event-driven on `handle_control("spawn_session", ...)`**, not time-driven on post-handshake: when `handle_control` inserts `tug_session_id` into `client_sessions[client_id]`, it immediately reads `LedgerEntry::latest_metadata` for that single session and, if `Some`, publishes it on the SESSION_METADATA broadcast as a one-shot frame. The caller's own `FeedStore` filter ([D11]) accepts it; other cards' filters drop it. The old single-slot `watch::channel` is deleted.

**Why event-driven on `spawn_session` instead of time-driven on post-handshake:** The WebSocket `client_id` is minted fresh on every new connection via `router.next_client_id()`. On a reconnect, the reconnected WebSocket gets a brand-new `client_id`, and `client_sessions[new_client_id]` is guaranteed empty at post-handshake time — the CONTROL `spawn_session` frame that would populate it arrives **later**, inside the main select loop. A post-handshake replay call is therefore a perpetual no-op in the real flow: there is no known session to replay for. Tying replay to `handle_control` solves this by construction — at the exact moment the client announces which session(s) it cares about, the supervisor replays the stored metadata for that session, before the main loop has had a chance to deliver any live frames. There is no separate batch replay helper — the per-session event-driven replay inside `handle_control` is the sole replay mechanism, used uniformly on first mount and reconnect alike.

**Known limitation — no in-connection lag recovery for SESSION_METADATA:** Unlike the prior `watch::channel` design, which delivered the latest value via `borrow_and_update()` on every subscribe, the `broadcast::channel` + event-driven-replay design only fires the replay inside `handle_control("spawn_session", ...)`. A card that stays connected but lags on its SESSION_METADATA broadcast receiver (e.g., rapid-fire `system_metadata` frames from multiple concurrent sessions filling the broadcast buffer under `LagPolicy::Warn`) drops frames with no in-connection recovery path. The `LedgerEntry::latest_metadata` slot is only read when the client sends `spawn_session`, so a lagged-but-still-connected card must send a `reset_session` (or disconnect-reconnect) to re-receive its current metadata. In practice this is rare — real sessions emit `system_metadata` once at init and seldom afterward — but it is a genuine regression from the watch-based snapshot-on-connect guarantee. Documented here rather than fixed in-phase; a future `LagPolicy::ReplayPerClient` variant (tracked in [#roadmap]) or a dedicated `refresh_session_metadata` CONTROL action would close the gap.

**Why a broadcast (and why event-driven replay) instead of a watch:**

- A `watch::channel` is structurally single-slot: it holds exactly one frame. Under concurrent sessions emitting distinct `system_metadata` payloads, last-writer-wins silently clobbers every earlier session's snapshot. A late-subscribing card for session A whose watch slot currently holds session B's frame receives B, the client filter rejects it, and the card gets nothing — the exact silent cross-pollination bug this decision is meant to close.
- A `broadcast::channel` preserves every emitted frame as long as at least one subscriber hasn't consumed it, so concurrent-session frames do not clobber each other on the wire. Combined with the client filter ([D11]), each card receives and displays only its own session's frame.
- "Latest frame on subscribe" is not a broadcast guarantee, so the supervisor explicitly replays from `LedgerEntry::latest_metadata` — but the correct moment is **inside `handle_control` on `spawn_session`**, not at post-handshake setup. The supervisor knows which session to replay only after the client tells it (via `spawn_session`), and by that point the client has already subscribed to the SESSION_METADATA broadcast (the CONTROL loop runs strictly after per-client broadcast subscriptions are established in `handle_client`).
- The `tug_session_id` splice ([D02]) means every replayed metadata frame already carries its session id, so the client filter handles both live and replay paths uniformly with no separate code path.

**Implications:**

- `feeds/session_metadata.rs` is substantially rewritten in this phase. The module no longer owns a global `watch::channel`; instead, the supervisor owns a SESSION_METADATA `broadcast::Sender<Frame>` and the merger task publishes on it whenever it sees a `system_metadata` line.
- `AgentSupervisor` gains a `client_sessions: Mutex<HashMap<ClientId, HashSet<TugSessionId>>>` map. `handle_control("spawn_session", ...)` adds `(client_id, tug_session_id)` to the map and then **immediately performs a one-shot replay** of that session's `latest_metadata` (if any) on the SESSION_METADATA broadcast. `handle_control("close_session", ...)` removes from the map; on WebSocket disconnect, `handle_client` calls `supervisor.on_client_disconnect(client_id)` which clears the client's entry.
- `SESSION_METADATA` payloads gain `tug_session_id` as a first field (inherited from the splice on CODE_OUTPUT). This is additive — existing consumers that don't read the field are unaffected — but is called out in #assumptions because it contradicts the original "unchanged" framing.
- The `FeedStore` filter ([D11]) is the mechanism by which each card selects its own metadata payload. `CodeSessionStore` (T3.4) subscribes with a `tug_session_id` filter. **The one live pre-T3.4 consumer — `SessionMetadataStore` in `tugdeck/src/lib/session-metadata-store.ts`, instantiated by `tugdeck/src/components/tugways/cards/gallery-prompt-input.tsx` for slash-command completions — must also pass a `tug_session_id` filter; see Step 9's updated consumer task.**
- Registration in `main.rs` changes from `register_watch(FeedId::SESSION_METADATA, ...)` (which does not exist as a FeedId-keyed API — the actual existing API is `add_snapshot_watches(Vec<watch::Receiver<Frame>>)`) to `register_stream(FeedId::SESSION_METADATA, session_metadata_broadcast_tx, LagPolicy::Warn)`. Moving from a snapshot watch to a broadcast stream eliminates the `add_snapshot_watches` call path for SESSION_METADATA entirely.

**Non-goal note:** Full generalization of "per-session snapshot feeds" (e.g., a polymorphic `PerSessionWatch<T>` primitive) is not required here. The supervisor grows the minimum surface needed for `SESSION_METADATA` and we revisit the abstraction when a second per-session snapshot feed needs it.

---

### Deep Dives (Optional) {#deep-dives}

#### End-to-end session lifecycle flow {#lifecycle-flow}

The sequence below shows what happens from card mount through first input through close, naming the concrete components that participate at each step.

1. **Card mount.** Tide card loads in the browser. The browser already holds a stable `card_id` for this card (minted by the tugdeck layout store at card creation and persisted in tugbank as part of the existing layout persistence). The card reads its persisted `tug_session_id` from `dev.tugtool.tide.session-keys` via tugbank (or mints a fresh UUID if absent) and stores it locally alongside `card_id`.
2. **`spawn_session` control frame.** Card sends a CONTROL frame: `{action: "spawn_session", card_id: "<card>", tug_session_id: "<id>"}`. Fire-and-forget, returns immediately. The `card_id` is the browser's authoritative card identifier (not derived from the WebSocket connection); it is what makes rebind-on-reconnect work — a fresh WebSocket after page reload gets a new `client_id`, but the same `card_id`, and the supervisor re-reads the tugbank entry keyed on that stable `card_id` to find the session mapping.
3. **Router interception.** `handle_client` parses the CONTROL payload, sees `spawn_session`, and calls `router.supervisor.handle_control("spawn_session", payload, client_id).await` per [D09]. Does NOT fall through to `dispatch_action`. The `client_id` is the WebSocket connection identifier used for the supervisor's per-client session set (per [D14]'s on-subscribe replay); it is distinct from `card_id`.
4. **Supervisor writes intent and replays any prior metadata.** `AgentSupervisor::handle_control` parses `card_id` and `tug_session_id` from the payload (rejects with a `missing_card_id` CONTROL error frame if `card_id` is absent or empty — see Spec S03), inserts a `LedgerEntry { tug_session_id, claude_session_id: None, spawn_state: Idle, crash_budget: CrashBudget::new(3, 60s), queue: BoundedQueue(256), latest_metadata: None }` **only if no entry exists yet for this `tug_session_id`** (reconnect scenarios preserve the pre-existing `LedgerEntry` and its `latest_metadata`), records `(client_id, tug_session_id)` in the supervisor's `client_sessions` map, publishes `SESSION_STATE { tug_session_id, state: pending }` on the SESSION_STATE broadcast, writes `(card_id, tug_session_id)` into the `dev.tugtool.tide.session-keys` tugbank domain per [D12], **and immediately reads `LedgerEntry::latest_metadata` for this single `tug_session_id` and, if `Some`, publishes it on the SESSION_METADATA broadcast as a one-shot replay frame per [D14]** — this is how reconnecting clients recover their session's prior metadata without any post-handshake replay hook.
5. **Card subscribes to SESSION_STATE and SESSION_METADATA.** Card instantiates `new FeedStore(conn, [SESSION_STATE, SESSION_METADATA], decode, (fid, decoded) => decoded.tug_session_id === key)`. **These subscriptions are established before the card sends `spawn_session`**, so the one-shot SESSION_METADATA replay that `handle_control` fires in step 4 lands on the card's active broadcast receiver and its filter selects its own session's `latest_metadata` frame (if any exists). On the SESSION_STATE broadcast the card also sees `pending` immediately (via `TugConnection.lastPayload` replay path) plus any future frames.
6. **User types.** Card sends `CODE_INPUT` frame with `tug_session_id` tagged into the JSON payload.
7. **Dispatcher route.** `handle_client` dispatches the frame to the CODE_INPUT sender registered by the supervisor. The supervisor's dispatcher task parses `tug_session_id` from the payload, looks up the ledger entry, transitions `Idle → Spawning` atomically, and spawns a per-session `agent_bridge` worker via `spawn_session_worker(tug_session_id, ...)`. The frame is pushed to the per-session 256-frame queue.
8. **Bridge handshake.** The worker performs the existing `protocol_init` / `protocol_ack` dance with Claude Code. On success, the supervisor drains the queue into the child stdin and transitions `Spawning → Live`. `SESSION_STATE = spawning` is published at step start, `live` is published when `session_init` arrives on stdout.
9. **Outbound frame stamping.** Each stream-json line from Claude Code stdout is byte-spliced with `"tug_session_id":"<id>",` at offset 1 ([D02]) and handed to the CODE_OUTPUT merger. The merger (a) pushes the frame into the shared CODE_OUTPUT broadcast (which feeds the shared `LagPolicy::Replay` ring buffer as today), and (b) if the frame is a `system_metadata` event, routes it into that session's `latest_metadata` slot in the ledger and publishes it on the session-scoped SESSION_METADATA path per [D14].
10. **Client filter.** Card's `FeedStore` receives every CODE_OUTPUT and SESSION_METADATA frame, but the filter (`decoded.tug_session_id === key`) rejects frames from other sessions — including frames received via the shared replay buffer during lag recovery.
11. **`close_session`.** Card (or user explicitly) sends `close_session`. Supervisor kills the subprocess, drops the dispatcher sender, clears the session's `latest_metadata` slot, deletes the `(card_id, tug_session_id)` entry from the `dev.tugtool.tide.session-keys` tugbank domain, publishes `SESSION_STATE = closed`, and removes the ledger entry. The shared CODE_OUTPUT replay buffer is not touched; the session's residual frames age out naturally as the ring fills (known limitation per [D06]).

#### Supervisor state machine {#supervisor-state-machine}

```
                      spawn_session
                           |
                           v
                      +----------+
                      |  pending |  (intent registered, no subprocess)
                      +----------+
                           |
                   first CODE_INPUT
                           |
                           v
                      +----------+
                      | spawning |  (subprocess starting, queue buffering)
                      +----------+
                           |
                    session_init seen
                           |
                           v
                      +----------+
                      |   live   |  (normal operation)
                      +----------+
                         |   |
              crash_budget   close_session / reset_session
                 exhausted     (close)         |
                         |   |                 v
                         v   v           +----------+
                   +----------+          |  closed  |
                   | errored  |          +----------+
                   +----------+
                         |
                  reset_session
                         |
                         v
                      +----------+
                      |  pending |  (re-armed; subprocess will spawn on next input)
                      +----------+
```

**Spec S01: `LedgerEntry` shape** {#s01-ledger-entry}

```rust
pub struct LedgerEntry {
    pub tug_session_id: TugSessionId,            // client-authoritative UUID (defined in tugcast-core)
    pub claude_session_id: Option<String>,       // populated when session_init arrives
    pub spawn_state: SpawnState,                 // Idle / Spawning / Live / Errored / Closed
    pub crash_budget: CrashBudget,               // per-session (3 crashes / 60s)
    pub queue: BoundedQueue<Frame>,              // cap 256, CODE_INPUT buffering during spawn
    pub latest_metadata: Option<Frame>,          // latest system_metadata payload for this session (per [D14])
    pub child: Option<tokio::process::Child>,    // owned subprocess handle when Live
    pub input_tx: Option<mpsc::Sender<Frame>>,   // stdin sender when Live
    pub cancel: CancellationToken,               // for close_session
}
```

Note: `LedgerEntry` does not own a `ReplayBuffer`. The CODE_OUTPUT replay buffer stays shared at the router level per [D06]; the supervisor only routes `system_metadata` per-session.

**Spec S02: `SESSION_STATE` payload** {#s02-session-state-payload}

```json
{
  "tug_session_id": "b2c1…uuid",
  "state": "pending" | "spawning" | "live" | "errored" | "closed",
  "detail": "crash_budget_exhausted" | "session_unknown" | null
}
```

**Spec S03: New CONTROL actions** {#s03-control-actions}

All three payloads carry a **required** `card_id` field (the browser's stable card identifier, minted at card mount and persisted in the tugdeck layout store). `card_id` is the durable key under which tugbank persists the card↔`tug_session_id` mapping per [D12]; without it, reconnects mint a fresh WebSocket `client_id` and any `(client_id, tug_session_id)` binding is lost. The supervisor never synthesizes `card_id` from the WebSocket `client_id`.

| Action | Payload | Effect |
|--------|---------|--------|
| `spawn_session` | `{action: "spawn_session", card_id, tug_session_id}` | Register intent. Associate `(client_id, tug_session_id)` in the supervisor's per-client session set (per [D14]). Write `(card_id, tug_session_id)` into tugbank domain `dev.tugtool.tide.session-keys`. Publish `SESSION_STATE = pending`. No subprocess. |
| `close_session` | `{action: "close_session", card_id, tug_session_id}` | Kill subprocess, drop dispatcher sender, clear `latest_metadata`, remove `(client_id, tug_session_id)` from the per-client session set, delete the `(card_id, tug_session_id)` tugbank entry, publish `SESSION_STATE = closed`, remove ledger entry. Shared CODE_OUTPUT replay frames age out naturally per [D06]. |
| `reset_session` | `{action: "reset_session", card_id, tug_session_id}` | Equivalent to `close_session` followed by `spawn_session` with the same `card_id` + `tug_session_id`. Publishes `closed` then `pending`. |

**Missing / malformed `card_id` handling:** if a CONTROL frame omits `card_id` or passes an empty string, `handle_control` rejects the action with a `warn!` log and a CONTROL error frame (`{type: "error", detail: "missing_card_id"}`) sent via `send_control_json`; it does not fall back to any synthesized id. This is strict because any silent synthesis would silently break rebind-on-reconnect.

**Spec S04: Splice helper semantics** {#s04-splice-semantics}

```rust
/// Splice `"tug_session_id":"<id>"` as the first field of a stream-json line.
///
/// - Locate the first `{` byte in `line` (skipping any leading ASCII whitespace
///   such as spaces, tabs, newlines, carriage returns). This avoids the
///   "byte offset 1 is fragile against leading whitespace" failure mode: a
///   future Claude Code update that prepends whitespace or a BOM must not
///   silently disable session stamping for every frame.
/// - If no `{` is found anywhere in `line` (empty input, non-JSON, blank line),
///   return the original bytes unchanged and log a `tracing::warn!`.
/// - If the byte after `{` is `}` (i.e., an empty object `{}`, possibly with
///   leading whitespace), return `<leading> + {"tug_session_id":"<id>"} + <trailing>`
///   with no trailing comma.
/// - Otherwise, insert `"tug_session_id":"<id>",` immediately after the `{`.
pub fn splice_tug_session_id(line: &[u8], tug_session_id: &str) -> Vec<u8>;
```

**Spec S05: P5 ownership key** {#s05-p5-ownership-key}

```rust
/// Keyed ownership: `(FeedId, Option<TugSessionId>)`.
/// - CODE_INPUT uses `Some(tug_session_id)`.
/// - All other input feeds use `None` (legacy behavior preserved).
type InputOwnership = Arc<Mutex<HashMap<(FeedId, Option<TugSessionId>), u64>>>;

fn try_claim_input(
    ownership: &InputOwnership,
    feed_id: FeedId,
    session: Option<TugSessionId>,
    client_id: u64,
) -> Result<(), u64>;

fn release_inputs(ownership: &InputOwnership, client_id: u64);
```

---

### Specification {#specification}

Covered inline in [#lifecycle-flow], [#s01-ledger-entry], [#s02-session-state-payload], [#s03-control-actions], [#s04-splice-semantics], and [#s05-p5-ownership-key].

**Terminology:**

- **`tug_session_id`**: Client-authoritative UUID minted by the Tide card at mount, persisted in tugbank, authoritative on the wire. Spliced into every CODE_OUTPUT payload, tagged on every CODE_INPUT payload, keyed on by the client filter and the supervisor dispatcher.
- **`claude_session_id`**: Claude Code's own UUID, emitted in its `session_init` stream-json. Supervisor-internal only. Populated in the ledger when `session_init` arrives. Never on the wire.
- **Ledger entry**: per-session record inside `AgentSupervisor` holding `tug_session_id`, `claude_session_id`, `spawn_state`, `crash_budget`, `queue`, `latest_metadata`, `child`, `input_tx`, `cancel`. (`replay` is NOT a field — the CODE_OUTPUT replay buffer is shared at the router level per [D06].)
- **Spawn state**: `Idle` → `Spawning` → `Live`; terminal transitions `Errored`, `Closed`. Re-armed via `reset_session` (back to `Idle`).

**Error and warning model:**

- **`session_unknown`**: CODE_INPUT arrived for a `tug_session_id` with no ledger entry. Emitted via CONTROL frame, not SESSION_STATE.
- **`session_backpressure`**: Per-session 256-frame queue overflowed during spawn window. Emitted via CONTROL frame.
- **`crash_budget_exhausted`**: Per-session crash budget tripped. Emitted via `SESSION_STATE = errored{detail: "crash_budget_exhausted"}`. Intent record survives; user can `reset_session`.
- **`input_claimed`**: Duplicate claim on `(FeedId::CODE_INPUT, tug_session_id)` from a second client. Emitted via CONTROL frame (existing mechanism, unchanged).

---

### Compatibility / Migration / Rollout (Optional) {#rollout}

- **Compatibility policy:** The wire contract is purely additive. `tug_session_id` is a new field; consumers that don't read it see no semantic change. The `SESSION_STATE` FeedId is a new slot (0x52); clients that don't subscribe are unaffected. Existing `SessionMetadataFeed` / `SessionMetadataStore` are unchanged.
- **Migration:** tugbank schema gains a new domain. tugbank domains are namespaced, so this is non-invasive — existing domains are untouched.
- **Rollout:** This is a single landing branch. The user will test on their own machine; no staged rollout or canary. The FeedStore filter addition in tugdeck is backward compatible (optional argument with a default).

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New crates (if any) {#new-crates}

| Crate | Purpose |
|-------|---------|
| (none) | All work lands in existing crates |

#### New files (if any) {#new-files}

| File | Purpose |
|------|---------|
| `tugrust/crates/tugcast/src/feeds/agent_supervisor.rs` | Supervisor module: ledger, CODE_INPUT dispatcher, CODE_OUTPUT merger, per-session metadata routing, SESSION_STATE publisher, `handle_control()`, tugbank write-path for `dev.tugtool.tide.session-keys`. |
| `tugrust/crates/tugcast/tests/multi_session_real_claude.rs` | `#[ignore]`-gated + `TUG_REAL_CLAUDE=1`-gated integration tests against real Claude Code. |
| `tugrust/crates/tugcast/tests/common/mod.rs` | Shared test helpers (WebSocket client, control-frame builders, session-state waiters). |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `TugSessionId` | struct | `tugcast-core/src/protocol.rs` | Newtype over `String` (UUID); `Clone + Eq + Hash + Serialize + Deserialize`. Defined in core because it is a wire-level identifier used by both router (P5 ownership) and supervisor (ledger). |
| `FeedId::SESSION_STATE` | const | `tugcast-core/src/protocol.rs` | `Self(0x52)`. |
| `FeedId::name` | match arm | `tugcast-core/src/protocol.rs` | Add `SESSION_STATE => "SessionState"` AND `SESSION_METADATA => "SessionMetadata"` (pre-existing gap). |
| `AgentSupervisor` | struct | `tugcast/src/feeds/agent_supervisor.rs` | Top-level supervisor; owns the ledger, dispatcher task, merger task, SESSION_STATE broadcast, **SESSION_METADATA broadcast sender** (not a watch — see [D14]), `client_sessions: Mutex<HashMap<ClientId, HashSet<TugSessionId>>>`, `store: Arc<dyn SessionKeysStore>` (narrow persistence trait — see the `SessionKeysStore` row below — not `Arc<TugbankClient>` directly). |
| `LedgerEntry` | struct | `tugcast/src/feeds/agent_supervisor.rs` | Per-session record. See [#s01-ledger-entry]. No `ReplayBuffer` field (shared at router per [D06]). `latest_metadata: Option<Frame>` holds the last `system_metadata` for this session for on-subscribe replay. |
| `ControlError` | enum | `tugcast/src/feeds/agent_supervisor.rs` | Variants: `MissingCardId`, `MissingSessionId`, `Malformed` (payload is not valid JSON), `PersistenceFailure(String)`. Derives `Debug, Error, PartialEq, Eq`. Returned from `handle_control` on payload-validation failures and — per [D12]'s asymmetric policy — on a tugbank **write** failure during `spawn_session` (strict). Tugbank **delete** failures during `close_session` are best-effort and do NOT return an error; they are logged via `warn!` and in-memory cleanup continues. The caller (`handle_client`, wired in Step 8) must handle all four variants and convert any `Err(_)` into a CONTROL error frame on the in-scope socket. |
| `SpawnState` | enum | `tugcast/src/feeds/agent_supervisor.rs` | `Idle` / `Spawning` / `Live` / `Errored` / `Closed`. Exposes `try_transition(next) -> Result<(), SpawnStateError>` so the dispatcher and close/reset paths can gate state changes atomically under the per-session mutex (see #r06-close-spawn-toctou). |
| `SessionKeysStore` | trait | `tugcast/src/feeds/agent_supervisor.rs` | Narrow persistence surface with `set_session_key(card_id, tug_session_id)` and `delete_session_key(card_id)`. Defined locally so the `impl SessionKeysStore for TugbankClient` blanket (in the same file) is legal under orphan rules. `AgentSupervisor` holds `Arc<dyn SessionKeysStore>` so unit tests can inject failing fakes to pin [D12]'s strict-vs-best-effort asymmetry. |
| `AgentSupervisor::handle_control` | fn | `tugcast/src/feeds/agent_supervisor.rs` | Dispatches `spawn_session` / `close_session` / `reset_session`; parses `card_id` + `tug_session_id` (rejects missing/empty with `Err(ControlError::MissingCardId \| MissingSessionId)`); writes/deletes tugbank entries; populates `client_sessions`. **On `spawn_session`, after populating `client_sessions[client_id]`, immediately performs the per-session metadata replay per [D14]: reads `LedgerEntry::latest_metadata` for the single `tug_session_id` and, if `Some`, publishes it on the SESSION_METADATA broadcast as a one-shot frame.** Signature: `(&self, action: &str, payload: &[u8], client_id: ClientId) -> Result<(), ControlError>`. |
| `AgentSupervisor::on_client_disconnect` | fn | `tugcast/src/feeds/agent_supervisor.rs` | Drops `client_sessions[client_id]`. Does not touch ledger or tugbank (client disconnect != session close). Called from `handle_client` teardown. |
| `AgentSupervisor::rebind_from_tugbank` | fn | `tugcast/src/feeds/agent_supervisor.rs` | Startup helper that reads `dev.tugtool.tide.session-keys` and creates `LedgerEntry { spawn_state: Idle, .. }` for each persisted session directly (does NOT go through `handle_control` and does NOT insert any sentinel `ClientId` into `client_sessions`). Per [F15], leaves `client_sessions` untouched — real clients will populate it on reconnect via their own `spawn_session` CONTROL frames. Runs once at startup before any WebSocket is accepted. |
| `AgentSupervisor::spawn_session_worker` | fn | `tugcast/src/feeds/agent_supervisor.rs` | Lazy spawn invoked on first CODE_INPUT. |
| `AgentSupervisor::dispatcher_task` | fn | `tugcast/src/feeds/agent_supervisor.rs` | Background task reading the CODE_INPUT mpsc, parsing `tug_session_id`, routing to per-session queues. |
| `AgentSupervisor::merger_task` | fn | `tugcast/src/feeds/agent_supervisor.rs` | Background task pulling from N per-bridge mpscs; forwards to shared CODE_OUTPUT broadcast; on `system_metadata` lines, writes directly to `LedgerEntry::latest_metadata` under the per-session mutex AND publishes on the SESSION_METADATA broadcast per [D14]. No `SessionMetadataRegistry` wrapper — the merger is the sole writer, and `spawn_session`'s event-driven replay reads `latest_metadata` inline from the ledger entry it already holds. |
| `BoundedQueue<T>` | struct | `tugcast/src/feeds/agent_supervisor.rs` | 256-frame bounded queue with overflow signaling. |
| `splice_tug_session_id` | fn | `tugcast/src/feeds/code.rs` | Splice helper; see [#s04-splice-semantics]. Scans for first `{` byte (handles leading whitespace). |
| `parse_tug_session_id` | fn | `tugcast/src/feeds/code.rs` | Reads `tug_session_id` out of a CODE_INPUT payload. |
| `SessionMetadataFeed` (deleted) | struct | `tugcast/src/feeds/session_metadata.rs` | **Deleted per [D14].** The single global `watch::channel` and its subscribe-to-CODE_OUTPUT loop are removed. Detection helper (needle-scan for `system_metadata`) is inlined into `agent_supervisor.rs::merger_task` or relocated as a free function in the same file; unit tests follow the helper. |
| `AgentBridgeHandles` (deleted) | struct | `tugcast/src/feeds/agent_bridge.rs` | **Deleted per #assumptions.** Had one field (`snapshot_watches: Vec<watch::Receiver<Frame>>`) that held the dead `project_info_rx` and `session_watch_rx`; both are deleted. Supervisor-owned spawn returns a minimal `SessionWorkerHandle` (or similar) carrying only per-session stdin `mpsc::Sender<Frame>` and `CancellationToken`. |
| `project_info_tx` / `project_info_rx` (deleted) | watch::channel | `tugcast/src/feeds/agent_bridge.rs` | **Deleted.** No live consumer outside `_archive/`. |
| `session_watch_tx` / `session_watch_rx` (deleted) | watch::channel | `tugcast/src/feeds/agent_bridge.rs` | **Deleted.** No live consumer outside `_archive/`. Under multi-session it would have exhibited the same last-writer-wins bug as the old SESSION_METADATA watch. |
| `snapshot_watches.extend(agent_handles.snapshot_watches)` (deleted) | call site | `tugcast/src/main.rs` | **Deleted.** The extend target (`agent_handles.snapshot_watches`) no longer exists; there is no replacement call — the SESSION_METADATA path goes through `register_stream` (broadcast) instead of `add_snapshot_watches`. |
| `InputOwnership` | type | `tugcast/src/router.rs` | Re-keyed on `(FeedId, Option<TugSessionId>)`. See [#s05-p5-ownership-key]. Imports `TugSessionId` from `tugcast_core`. |
| `try_claim_input` | fn | `tugcast/src/router.rs` | Signature gains `session: Option<TugSessionId>`. |
| `release_inputs` | fn | `tugcast/src/router.rs` | Unchanged behavior; still drops all entries for a client. |
| `FeedRouter::supervisor` | field | `tugcast/src/router.rs` | `Arc<AgentSupervisor>`; set during construction in `main.rs`. |
| `handle_client` CONTROL branch | code | `tugcast/src/router.rs` | Intercept `spawn_session` / `close_session` / `reset_session`, call `router.supervisor.handle_control(action, &frame.payload, client_id).await` before the fall-through to `dispatch_action`. On `Err(ControlError::MissingCardId \| MissingSessionId)`, use `send_control_json` on the in-scope socket (not via the supervisor broadcast). Per-session metadata replay per [D14] is performed **inside** `handle_control`'s `spawn_session` branch, not at any separate call site in `handle_client`. |
| `handle_client` teardown hook | code | `tugcast/src/router.rs` | Call `router.supervisor.on_client_disconnect(client_id)` alongside the existing `release_inputs(client_id)` in the cleanup path. |
| `spawn_agent_bridge` | fn (removed/demoted) | `tugcast/src/feeds/agent_bridge.rs` | Replaced by per-session spawn API owned by the supervisor. Public surface is now a per-session constructor. |
| `run_agent_bridge` | fn (modified) | `tugcast/src/feeds/agent_bridge.rs` | Takes `tug_session_id: TugSessionId` as a constructor arg; applies the splice on every outbound line; registers `claude_session_id` in the supervisor ledger when `session_init` arrives; per-session `CrashBudget` instance. |
| `FeedStore` constructor | ctor | `tugdeck/src/lib/feed-store.ts` | Optional 4th arg `filter?: (feedId, decoded) => boolean`; runs after decode, before snapshot update, on both live frames and the `lastPayload` replay. |
| `encodeCodeInput` | fn (modified) | `tugdeck/src/protocol.ts` | Signature gains `tugSessionId: string` arg; injects `tug_session_id` into the outbound JSON payload. Closes the Step 7 router-rejection wedge. **Pure definition-site change:** no live production caller exists; `conversation-types.test.ts` is tsconfig-excluded and does not need updating. |
| `FEED_ID_SESSION_STATE` | const | `tugdeck/src/protocol.ts` | Mirrors `0x52`. |
| CONTROL action types | const | `tugdeck/src/protocol.ts` | `CONTROL_ACTION_SPAWN_SESSION`, `CONTROL_ACTION_CLOSE_SESSION`, `CONTROL_ACTION_RESET_SESSION`. |
| `encodeSpawnSession` / `encodeCloseSession` / `encodeResetSession` | fn | `tugdeck/src/protocol.ts` | CONTROL frame builders. Required args: `cardId: string`, `tugSessionId: string`. Produce `{ action, card_id, tug_session_id }` payloads per Spec S03. |
| `gallery-prompt-input.tsx` SessionMetadataStore site | code | `tugdeck/src/components/tugways/cards/gallery-prompt-input.tsx` | Instantiate the wrapped `FeedStore` with **no filter** (passthrough). The gallery is a test harness per `gallery-split-pane.tsx`'s own file header; cross-session pollution is explicitly accepted. Add a TSX comment at the FeedStore construction site pointing at the #non-goals rationale. Do NOT mint a random `tug_session_id` for the filter — that design is retracted. Real per-card filters land in T3.4 via `CodeSessionStore`. |
| tugbank domain | const | `tugcast/src/feeds/agent_supervisor.rs` | `dev.tugtool.tide.session-keys`. |

---

### Documentation Plan {#documentation-plan}

- [x] Update `dash/tide.md §T0.5 P2` to mark this plan as landed at phase close.
- [x] Update `dash/code-session-remediation.md` to mark the "Plan authorship — next step" item as complete.
- [x] Add a section to `tugrust/crates/tugcast/README.md` (if it exists; otherwise inline module docs) describing the supervisor and its ledger.
- [x] Document the `TUG_REAL_CLAUDE=1` env var and how to run the integration tests in the test file module-level doc comment.
- [x] Update `tugdeck/src/lib/feed-store.ts` module-level doc comment with the filter semantics and an example.

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit (Rust)** | Splice helper, bounded queue, ledger state machine, P5 ownership with session keys, crash budget per session | Core logic, edge cases, error paths |
| **Unit (tugdeck)** | `FeedStore` filter on live frames and `lastPayload` replay | Frontend filter contract |
| **Integration (real Claude Code)** | End-to-end spawn/input/output/close, two-session isolation, reload/rebind, P5 cross-client relaxation | Wire pipeline correctness |
| **Drift Prevention** | Golden-byte tests for `SESSION_STATE = 0x52` encoding, splice helper stability | Wire format stability |

Tests against real Claude Code are marked `#[ignore]` and gated on `TUG_REAL_CLAUDE=1`. Non-Claude CI stays green. Assertions target wire-level envelope shape only, never LLM content. Mechanical steps (e.g., adding a constant, renaming a field) rely on `cargo build` + `cargo nextest run` as verification and do not add dedicated tests — per the "tests: less is more" guidance.

---

### Execution Steps {#execution-steps}

> Every step must build clean under `-D warnings`. Every Rust step ends with `cargo nextest run -p tugcast` (plus `cargo build -p tugcast-core` where relevant). Every tugdeck step ends with `bun test` in `tugdeck/`.

#### Step 1: Add `SESSION_STATE = 0x52`, `TugSessionId`, and missing `SESSION_METADATA` name arm to tugcast-core {#step-1}

**Commit:** `feat(tugcast-core): add SESSION_STATE FeedId, TugSessionId wire type, fix SESSION_METADATA name`

**References:** [D01] Session id naming, [D10] Session state feed, [D14] Session-scoped metadata, Spec S02, (#lifecycle-flow, #s02-session-state-payload, #assumptions)

**Artifacts:**

- New `FeedId::SESSION_STATE = Self(0x52)` constant in `tugcast-core/src/protocol.rs`.
- New `TugSessionId(String)` newtype in `tugcast-core/src/protocol.rs` with `Clone`, `Eq`, `Hash`, `Debug`, `Display`, `serde::{Serialize, Deserialize}`. Located here (not in `feeds/agent_supervisor.rs`) because it is a wire-level identifier used by both `router.rs` (P5 ownership) and `agent_supervisor.rs` — defining it inside `feeds/agent_supervisor.rs` would create a `router.rs → feeds::agent_supervisor → router` dependency cycle.
- New `Self::SESSION_STATE => Some("SessionState")` arm in `FeedId::name()`.
- New `Self::SESSION_METADATA => Some("SessionMetadata")` arm in `FeedId::name()` — fixes a pre-existing gap surfaced by this edit (SESSION_METADATA currently has no name arm despite being a live FeedId).
- Existing tests for `FeedId` constants extended to assert `SESSION_STATE.as_byte() == 0x52`, `SESSION_STATE.name() == Some("SessionState")`, and `SESSION_METADATA.name() == Some("SessionMetadata")`.

**Tasks:**

- [x] Add `pub const SESSION_STATE: Self = Self(0x52);` in the "Defaults" section of `tugcast-core/src/protocol.rs`, just after `SESSION_METADATA`.
- [x] Add both the `SESSION_STATE` and `SESSION_METADATA` arms to `FeedId::name()`.
- [x] Add `pub struct TugSessionId(pub String);` with the derives listed above. Add a `TugSessionId::new(s: impl Into<String>) -> Self` constructor and a `TugSessionId::as_str(&self) -> &str` accessor.
- [x] Add the three constant assertions to the existing `test_feed_id_bytes` (or equivalent) test.
- [x] Add a tiny `test_tug_session_id_hashable_and_cloneable` sanity test (construct two ids, insert into a `HashMap`, check clone equality).

**Tests:**

- [x] Existing tugcast-core test suite runs clean plus the new constant assertions and the TugSessionId sanity test.

**Checkpoint:**

- [x] `cd tugrust && cargo build -p tugcast-core`
- [x] `cd tugrust && cargo nextest run -p tugcast-core`

---

#### Step 2: Add splice and parse helpers in `feeds/code.rs` {#step-2}

**Depends on:** #step-1

**Commit:** `feat(tugcast): add tug_session_id splice and parse helpers`

**References:** [D01] Session id naming, [D02] Splice stamping, Spec S04, Risk R01, (#r01-splice-corruption, #s04-splice-semantics)

**Artifacts:**

- New `splice_tug_session_id(line: &[u8], id: &str) -> Vec<u8>` in `tugcast/src/feeds/code.rs`. **Contract:** locates the first `{` byte in `line` (skipping any leading ASCII whitespace — `\t`, `\n`, `\r`, space) and splices `"tug_session_id":"<id>",` immediately after it. If no `{` is found, returns the original bytes unchanged with a `tracing::warn!`. This handles the fragile-byte-offset-1 case called out in #r01-splice-corruption: a Claude Code stream-json update that prepends whitespace or a BOM would otherwise silently disable session stamping for every frame.
- New `parse_tug_session_id(payload: &[u8]) -> Option<String>` in the same file.
- Unit tests covering empty input, `{}`, realistic `session_init`, leading-whitespace case, malformed line (non-JSON), and `parse` happy-path + missing-field path.

**Tasks:**

- [x] Implement `splice_tug_session_id` per the contract above and [#s04-splice-semantics]. Scan the input for the first `{` byte before splicing; fail-safe (pass-through + `warn!`) on empty input and on lines with no `{` at all.
- [x] Implement `parse_tug_session_id` as a lightweight `serde_json::from_slice::<Value>` + `.get("tug_session_id").and_then(as_str).map(to_string)`. **Performance note:** unlike `session_metadata.rs` which deliberately uses a byte-window needle-scan for CODE_OUTPUT (the high-volume, per-stream-token path), CODE_INPUT is user-typed and arrives at most one frame per user message. Full-JSON parse cost is dominated by keystroke interarrival time, not by parser overhead, so byte-scanning would be premature optimization here. The asymmetry with `session_metadata.rs` is intentional and the dispatcher's per-frame parse is an acceptable trade-off.
- [x] Update [#s04-splice-semantics] in this plan to reflect the "first-`{`-byte" rule (done in this step's commit as part of the doc task).
- [x] Add unit tests for each case listed under Artifacts.

**Tests:**

- [x] `test_splice_empty_input_passes_through`
- [x] `test_splice_no_open_brace_passes_through`
- [x] `test_splice_leading_whitespace_finds_brace` — asserts that `  {"type":"..."}` is still spliced correctly and does not silently pass through.
- [x] `test_splice_empty_object`
- [x] `test_splice_realistic_session_init`
- [x] `test_parse_tug_session_id_present`
- [x] `test_parse_tug_session_id_absent`

**Checkpoint:**

- [x] `cd tugrust && cargo build -p tugcast`
- [x] `cd tugrust && cargo nextest run -p tugcast feeds::code`

---

#### Step 3: Introduce `AgentSupervisor` skeleton + ledger types {#step-3}

**Depends on:** #step-1, #step-2

**Commit:** `feat(tugcast): scaffold AgentSupervisor module with ledger types`

**References:** [D03] Supervisor consolidation, [D07] Per-session crash budget, Spec S01, (#supervisor-state-machine, #s01-ledger-entry)

**Artifacts:**

- New file `tugcast/src/feeds/agent_supervisor.rs` with:
  - `SpawnState` enum: `Idle`, `Spawning`, `Live`, `Errored`, `Closed`.
  - `BoundedQueue<T>` with cap 256, returning `QueuePush::Ok` / `QueuePush::Overflow`.
  - `LedgerEntry` struct per [#s01-ledger-entry] (imports `TugSessionId` from `tugcast_core`). Step 6's merger task writes `LedgerEntry::latest_metadata` directly under the per-session mutex — no separate `SessionMetadataRegistry` wrapper is introduced, because the write has exactly one caller (the merger) and the `spawn_session` event-driven replay path already holds the per-session `Arc<Mutex<LedgerEntry>>` in scope from its own `HashMap::entry(...).or_insert_with(...)` lookup and reads `latest_metadata` inline without an extra outer-map lookup.
  - `SessionKeysStore` trait — a narrow persistence surface with `set_session_key(card_id, tug_session_id)` and `delete_session_key(card_id)`, implemented for `TugbankClient`. The supervisor holds `Arc<dyn SessionKeysStore>` (not `Arc<TugbankClient>`) so unit tests can inject a failing fake to pin [D12]'s strict-vs-best-effort asymmetry. The trait is defined inside `agent_supervisor.rs`; coherence with `TugbankClient` (a foreign type) is legal because the trait itself is local.
  - `AgentSupervisor` struct holding the ledger `Mutex<HashMap<TugSessionId, Arc<Mutex<LedgerEntry>>>>`, a `SESSION_STATE` broadcast sender, a `SESSION_METADATA` **broadcast** sender (`broadcast::Sender<Frame>`, not a watch — see [D14] for why), a `client_sessions: Mutex<HashMap<ClientId, HashSet<TugSessionId>>>` map for per-client session affinity (populated by `handle_control`; used by the P5 authorization cross-check in Step 7), the supervisor's `CODE_OUTPUT` broadcast sender, a `store: Arc<dyn SessionKeysStore>` handle for the `dev.tugtool.tide.session-keys` domain, and config. `ClientId` is `u64` matching the router's existing `client_id_counter` type.
  - `AgentSupervisor::new()` constructor. Takes the broadcast senders and an `Arc<dyn SessionKeysStore>`; production wiring passes `Arc::new(TugbankClient::...)` (which implements the trait) at the call site in `main.rs`.
  - Public method stubs (`handle_control`, `dispatcher_task`, `merger_task`, `spawn_session_worker`, `on_client_disconnect`) returning `todo!()` or a no-op so the scaffold compiles.
- `mod agent_supervisor;` added to `tugcast/src/feeds/mod.rs`.

**Tasks:**

- [x] Create `agent_supervisor.rs` with the types above. Import `TugSessionId` from `tugcast_core::protocol` (introduced in Step 1) — do not redefine locally. Keep `CrashBudget` imported from `agent_bridge.rs` (unchanged).
- [x] Wire `pub mod agent_supervisor;` into `tugcast/src/feeds/mod.rs`.
- [x] Ensure the file builds clean (no warnings) with `todo!()` bodies behind `#[allow(dead_code)]` where necessary — but prefer real no-op bodies so `-D warnings` stays honest.

**Tests:**

- [x] `test_bounded_queue_cap_256`
- [x] `test_bounded_queue_overflow_signals`
- [x] `test_spawn_state_transitions` — assert the state-machine guard: `Idle → Spawning → Live` allowed; `Live → Spawning` rejected.

**Checkpoint:**

- [x] `cd tugrust && cargo build -p tugcast`
- [x] `cd tugrust && cargo nextest run -p tugcast feeds::agent_supervisor`

---

#### Step 4: Implement `handle_control` for spawn/close/reset {#step-4}

**Depends on:** #step-3

**Commit:** `feat(tugcast): implement supervisor handle_control for spawn/close/reset`

**References:** [D04] Lazy spawn, [D09] Control routing, [D10] Session state feed, [D12] tugbank domain, Spec S02, Spec S03, (#s02-session-state-payload, #s03-control-actions, #d12-tugbank-domain)

**Artifacts:**

- `AgentSupervisor::handle_control(action: &str, payload: &[u8], client_id: ClientId)` implementation. `client_id` is the WebSocket connection identifier supplied by `handle_client` at the CONTROL intercept site (per [D09]); it is distinct from `card_id` and is used only for the per-client session affinity map in [D14].
  - `spawn_session`: parse `card_id` and `tug_session_id` from the payload. If either is missing or empty, return `Err(ControlError::MissingCardId)` (or the analogous missing-session-id variant) so the caller (`handle_client`) can send a `send_control_json` error frame on the in-scope socket; do not mutate any state. On success, insert a new `LedgerEntry { spawn_state: Idle, .. }` **only if no entry exists** for this `tug_session_id` (reconnect flows MUST NOT overwrite an existing entry — the prior `latest_metadata` is exactly what the next step replays); insert `tug_session_id` into `client_sessions[client_id]`; write `(card_id, tug_session_id)` into tugbank domain `dev.tugtool.tide.session-keys`; publish `SESSION_STATE { state: pending }`. **Then, as the final step in the success path, read `LedgerEntry::latest_metadata` for this `tug_session_id` and, if `Some`, publish a clone of that frame on the supervisor's SESSION_METADATA broadcast as a one-shot event-driven replay (per [D14]).** This is the replay mechanism that services reconnect flows: at the moment the client announces its session, its broadcast subscription is already live, and the one-shot frame lands on that subscription where the client's `FeedStore` filter accepts it. Idempotent — a repeated `spawn_session` for an already-live id is a no-op on ledger state but still re-publishes `pending`, re-inserts into `client_sessions[client_id]` (set semantics), rewrites the tugbank entry (idempotent write), and re-fires the one-shot metadata replay (the client's `FeedStore` may coalesce duplicates but will never miss the frame).
  - `close_session`: parse `card_id` and `tug_session_id` (same rejection rule). Abort the per-session `cancel` token, clear `latest_metadata`, remove `tug_session_id` from `client_sessions[client_id]`, delete the tugbank entry, drop the ledger entry, publish `SESSION_STATE { state: closed }`.
  - `reset_session`: close-then-spawn with the same `card_id` + `tug_session_id` (preserves the tugbank entry: delete then re-insert is equivalent to a keep-alive rewrite). Publishes `closed` then `pending`. Because the preceding `close_session` branch drops the ledger entry and clears `latest_metadata`, the `spawn_session` branch's replay reads `None` and fires no metadata frame — this is correct, because a reset means the prior session is gone.
- `AgentSupervisor::on_client_disconnect(client_id: ClientId)`: drops `client_sessions[client_id]` entirely. Does NOT touch ledger state or tugbank — a client disconnecting is not a session close. Called by `handle_client` at WebSocket teardown.
- Unit tests covering each action path, idempotency, the tugbank write/delete behavior, and `client_sessions` bookkeeping. Use in-memory `SessionKeysStore` fakes for unit tests (no disk I/O): a passthrough `InMemoryStore` that records set/delete call counts, a `FailingWriteStore` that returns `Err(_)` on `set_session_key`, and a `FailingDeleteStore` that returns `Err(_)` on `delete_session_key`. The trait is the reason the error-injection tests are expressible at all; a concrete `TugbankClient` backed by a tempfile would never fail its writes under normal conditions.

**Tasks:**

- [x] Parse the payload with `serde_json::Value` and extract `tug_session_id` and `card_id`. **Do not synthesize `card_id` from `client_id` — that was an earlier-draft design that silently breaks rebind-on-reconnect, because a reload mints a fresh `client_id` and any synthesized `card_id` would not match the tugbank-persisted one.** Reject missing/empty `card_id` or `tug_session_id` with a `warn!` log and an `Err(ControlError::MissingCardId | MissingSessionId)` return; do not panic, do not mutate state. Step 8's `handle_client` wiring converts the `Err` into a `send_control_json(FeedId::CONTROL, &json!({type: "error", detail: "missing_card_id"}))` on the in-scope socket.
- [x] For `spawn_session`, use `HashMap::entry(...).or_insert_with(...)` so pre-existing ledger entries (reconnect scenarios) are preserved untouched — do NOT replace an existing `LedgerEntry`, because its `latest_metadata` is the payload the next bullet replays. Insert into `client_sessions[client_id]` (HashSet insertion, idempotent), then write to tugbank, then publish `pending`. Double-spawn is a no-op on ledger state but still re-publishes `pending` and re-inserts into `client_sessions` so cards re-subscribing see the current state.
- [x] **Per [D12]'s asymmetric policy: wrap the `spawn_session` tugbank write in a `match` and treat a write failure as a HARD error — return `Err(ControlError::PersistenceFailure)` from `handle_control` so `handle_client` can emit a CONTROL error frame on the in-scope socket.** Do this AFTER the idempotent ledger insert and AFTER the `client_sessions` insert but BEFORE the `pending` publish and BEFORE the event-driven metadata replay — if the write fails, the caller gets an error and the client can react; the partial ledger/client_sessions state is tolerable (it will be rewritten on any retry). Do NOT silently continue on write failure: a silent failure would leave the in-memory ledger populated but tugbank empty, and on restart the session would silently vanish with no error signal.
- [x] **Per [D12]'s asymmetric policy: wrap the `close_session` tugbank delete in a `let _ = ...` pattern (or `match` with the `Err` arm calling `warn!` and continuing) — treat a delete failure as BEST-EFFORT.** In-memory cleanup (ledger entry drop, subprocess kill, SESSION_STATE `closed` publish, `client_sessions` removal) proceeds regardless of tugbank delete success or failure. The lingering tugbank entry is benign: the next `rebind_from_tugbank` on startup will re-create a `pending` ledger entry for the lingering id, which will be harmlessly re-bound. Do NOT return an error on delete failure — symmetric strict handling would turn a benign cleanup failure into a user-visible error frame on the close path with no recovery benefit.
- [x] **Per [D14], after the `spawn_session` branch has populated `client_sessions[client_id]` and published `pending`, read `LedgerEntry::latest_metadata` for the spawned `tug_session_id` under the per-session mutex; if `Some`, clone the frame and publish it on the supervisor's SESSION_METADATA broadcast as a one-shot event-driven replay.** The replay is single-session, single-frame, and synchronous with the `spawn_session` dispatch — there is no separate batch helper.
- [x] For `close_session`, look up, abort the cancel token, remove from `client_sessions[client_id]`, delete from tugbank, drop the entry, publish `closed`.
- [x] For `reset_session`, compose the two.
- [x] Implement `on_client_disconnect(client_id)` to drop `client_sessions[client_id]`.
- [x] Declare the tugbank domain constant `dev.tugtool.tide.session-keys` as a `pub const` on `AgentSupervisor` (or in a small `domain` module inside `agent_supervisor.rs`).

**Tests:**

- [x] `test_spawn_session_writes_pending`
- [x] `test_spawn_session_writes_tugbank_entry` — asserts the in-memory tugbank fake receives the `(card_id, tug_session_id)` write.
- [x] `test_spawn_session_inserts_into_client_sessions` — after a spawn, `client_sessions[client_id]` contains the `tug_session_id` (per [D14]).
- [x] `test_spawn_session_rejects_missing_card_id` — CONTROL payload omitting `card_id` returns `Err(ControlError::MissingCardId)` and does not mutate any state (ledger, tugbank, or `client_sessions`).
- [x] `test_spawn_session_rejects_empty_card_id` — CONTROL payload with `card_id: ""` returns the same error.
- [x] `test_spawn_session_idempotent` — second spawn with same `(card_id, tug_session_id)` is a no-op on ledger state (pre-existing `LedgerEntry` and its `latest_metadata` are preserved — confirmed by asserting the original `LedgerEntry` instance is still at the same `tug_session_id` key) but re-writes tugbank and re-inserts into `client_sessions` (acceptable).
- [x] **`test_spawn_session_replays_latest_metadata_for_known_session`** — pre-populate a `LedgerEntry` for `tug_session_id = X` with `latest_metadata: Some(frame)` (no `client_sessions` entry yet — simulates reconnect), subscribe a fresh `broadcast::Receiver` to the supervisor's SESSION_METADATA broadcast, call `handle_control("spawn_session", ...)` for session X under a fresh `client_id`, and assert the receiver gets exactly one frame whose payload matches the pre-populated metadata. This is the test that pins [F13]'s fix — it exercises the real reconnect code path (no post-handshake call, fresh `client_id`, event-driven replay inside `handle_control`).
- [x] **`test_spawn_session_with_no_prior_metadata_fires_no_replay`** — spawn a brand-new session that has never had `latest_metadata` set; subscribe a broadcast receiver; call `handle_control("spawn_session", ...)`; assert the receiver gets zero metadata frames (only SESSION_STATE `pending` on a separate broadcast, which is not the one under test). Pins the `None`-skip path.
- [x] **`test_spawn_session_returns_err_on_tugbank_failure_injects_error_frame`** — uses an in-memory tugbank fake configured to return `Err(_)` on `set`. Calls `handle_control("spawn_session", payload, client_id)` with a well-formed payload. Asserts: the return is `Err(ControlError::PersistenceFailure)`; `client_sessions[client_id]` may or may not contain the id (the partial-state tolerance is documented, and the test does not pin it strictly); **SESSION_STATE broadcast has NOT received a `pending` frame for this session** (the strict path aborts before the publish); the event-driven metadata replay has NOT fired. This test pins [D12]'s strict-write asymmetry.
- [x] **`test_close_session_logs_on_tugbank_delete_failure_and_continues`** — uses an in-memory tugbank fake configured to return `Err(_)` on `delete`. Pre-populates a ledger entry for `tug_session_id = X`, inserts into `client_sessions[client_id]`, then calls `handle_control("close_session", payload, client_id)`. Asserts: the return is `Ok(())` (not an error); the ledger no longer has an entry for X; `client_sessions[client_id]` no longer contains X; SESSION_STATE has received a `closed` frame for X; a `warn!` log was emitted (captured via `tracing_test` or equivalent). This test pins [D12]'s best-effort-delete asymmetry.
- [x] `test_close_session_publishes_closed_and_removes_entry`
- [x] `test_close_session_deletes_tugbank_entry` — asserts the fake sees the delete.
- [x] `test_close_session_removes_from_client_sessions` — after a close, `client_sessions[client_id]` no longer contains the `tug_session_id`.
- [x] `test_close_session_unknown_is_noop` — no tugbank interaction on unknown-id close.
- [x] `test_reset_session_publishes_closed_then_pending`
- [x] `test_on_client_disconnect_drops_client_sessions_entry` — after calling `on_client_disconnect(cid)`, `client_sessions` no longer has a key for `cid`; ledger and tugbank are untouched.

**Checkpoint:**

- [x] `cd tugrust && cargo nextest run -p tugcast feeds::agent_supervisor`

---

#### Step 5: Implement CODE_INPUT dispatcher task with lazy spawn {#step-5}

**Depends on:** #step-4

**Commit:** `feat(tugcast): implement supervisor CODE_INPUT dispatcher with lazy spawn`

**References:** [D04] Lazy spawn, [D05] Bounded queue, [D07] Per-session crash budget, Risk R02, (#r02-lazy-spawn-race, #lifecycle-flow)

**Artifacts:**

- `AgentSupervisor::dispatcher_task`: background task consuming the CODE_INPUT `mpsc::Receiver<Frame>`, parsing `tug_session_id` from each payload via `parse_tug_session_id`, looking up the ledger, and either:
  - Routing to the per-session input sender (when `Live`), or
  - Pushing to the bounded queue (when `Spawning`), or
  - Transitioning `Idle → Spawning` and calling `spawn_session_worker` (when `Idle` and intent record exists), or
  - Emitting a `session_unknown` CONTROL error frame (when no ledger entry).
- A reference/stub `spawn_session_worker` that creates the per-session channels but does not yet start the real `agent_bridge` — that wiring lands in Step 6.
- Overflow path for the 256-frame bounded queue emits a `session_backpressure` CONTROL frame via the supervisor's CONTROL broadcast handle.

**Tasks:**

- [x] Add an outbound CONTROL broadcast handle to `AgentSupervisor::new()` (mirrors the existing `client_action_tx` pattern in main.rs).
- [x] Implement `dispatcher_task` with the four-way branch above.
- [x] Serialize `Idle → Spawning` per-session: lock the per-session `Mutex<LedgerEntry>` before deciding the branch. Only the thread that actually flips `Idle → Spawning` calls `spawn_session_worker`.
- [x] Implement the stub `spawn_session_worker` that wires the per-session `mpsc` and `CancellationToken`, publishes `SESSION_STATE = spawning`, and immediately transitions to `Live` as a scaffold. Real subprocess spawning lands in Step 6.
- [x] **Close the Step 4 close/spawn TOCTOU window per [R06]/[#r06-close-spawn-toctou].** Rework `do_close_session` so it takes the outer ledger lock exactly once — `HashMap::remove` up front under the outer lock, then per-session mutation — instead of lookup-then-remove across two outer-lock sections. Rework `do_spawn_session` to gate ledger insertion through `SpawnState::try_transition` under the per-session lock (reconnect `Idle → Idle` is a no-op; `Closed → Spawning` is refused and returns a `ControlError` the caller can retry). Move SESSION_STATE publication inside the per-session lock so frame order always matches state-machine order. Step 4's existing handle_control tests (`test_close_session_publishes_closed_and_removes_entry`, `test_reset_session_publishes_closed_then_pending`, `test_spawn_session_idempotent`) must continue to pass after the rework — the fix is lock-discipline, not a behavior change.

**Tests:**

- [x] `test_orphan_input_rejected` — CODE_INPUT with no intent record emits `session_unknown` CONTROL frame and does not touch the ledger.
- [x] `test_first_input_triggers_spawn` — with an intent record in `Idle`, a CODE_INPUT frame transitions to `Spawning` and calls the spawn hook exactly once.
- [x] `test_concurrent_first_inputs_spawn_once` — two CODE_INPUT frames arriving concurrently for the same session spawn exactly one subprocess; the second is queued. Covers [R02].
- [x] `test_queue_overflow_emits_backpressure` — 257 frames during `Spawning` triggers the `session_backpressure` CONTROL emission on frame 257.
- [x] `test_close_spawn_race_does_not_leak_entry` — covers [R06]. Two concurrent `tokio::spawn`ed `handle_control` calls for the same `tug_session_id`: one `close_session` and one `spawn_session` (different clients). Assert both complete without panic; assert the final ledger state is self-consistent (either the entry exists under the spawn's client affinity, or it does not and both `client_sessions` entries agree); assert no `LedgerEntry` is orphaned (no `Arc<Mutex<LedgerEntry>>` outlives its map removal while still referenced by `client_sessions`).

**Checkpoint:**

- [x] `cd tugrust && cargo nextest run -p tugcast feeds::agent_supervisor`

---

#### Step 6: Per-session bridge worker, splice stamping, and per-session metadata routing {#step-6}

**Depends on:** #step-5

**Commit:** `feat(tugcast): per-session agent_bridge worker and session-scoped metadata`

**References:** [D01] Session id naming, [D02] Splice stamping, [D03] Supervisor consolidation, [D07] Per-session crash budget, [D14] Session-scoped metadata, Risk R01, (#r01-splice-corruption, #d14-session-scoped-metadata)

**Artifacts:**

- Modified `agent_bridge.rs`:
  - New `spawn_session_worker(tug_session_id, ledger_entry, merger_tx, cancel, ...)` public function. The old `spawn_agent_bridge` entry point is deleted (it was a single-subprocess wiring incompatible with the supervisor; there is no call site left after Step 8).
  - `run_agent_bridge` is parameterized by `tug_session_id: TugSessionId`. **The pre-existing `project_info_tx: watch::Sender<Frame>` and `session_watch_tx: watch::Sender<Frame>` constructor arguments are deleted** — both watches exhibit the same last-writer-wins cross-pollination bug under multi-session that [D14] is fixing for SESSION_METADATA, and neither has any live non-`_archive/` consumer. The emission sites inside `run_agent_bridge` are deleted along with them: specifically (a) the `project_info_tx.send(project_info_frame)` watch latch at the top of the function (runs once at startup, before the handshake loop), (b) the `code_tx.send(project_info_frame.clone())` shared-broadcast emission that immediately precedes it in the same startup block — this is the shared-broadcast side of the `project_info` startup frame and has no live non-`_archive/` consumer, so deleting it is cleaner than splicing a startup frame that nobody reads (per overviewer OF3; alternative option "splice the broadcast emission" is rejected because the frame is dead code on both sides), (c) the whole `project_info_json` string-format and `project_info_frame` construction block that feeds the two deleted emissions, and (d) the `session_watch_tx.send(frame.clone())` line inside the `session_init` stdout branch. `session_init` still populates `claude_session_id` in the supervisor ledger via the callback described below and still triggers a `SESSION_STATE = live` publish, but there is no parallel watch to latch and no `project_info` frame ever emitted.
  - **`AgentBridgeHandles` is deleted.** It had one field (`snapshot_watches: Vec<watch::Receiver<Frame>>`) that is now empty, and the new supervisor-owned spawn API returns a `SessionWorkerHandle` (or similar) instead that carries only what the supervisor actually needs (the per-session `mpsc::Sender<Frame>` into stdin and the `CancellationToken` for close).
  - Every outbound stream-json line is passed through `splice_tug_session_id` before being sent on the merger channel.
  - When a line contains `"type":"session_init"`, parse Claude Code's `session_id` out of it and write it to the ledger as `claude_session_id` via a callback supplied by the supervisor. Publish `SESSION_STATE = live`.
  - Per-session `CrashBudget::new(3, 60s)` instance.
- Supervisor `merger_task` fans in N per-session `mpsc::Receiver<Frame>` via a `StreamMap` and for each frame (a) forwards it to the shared `CODE_OUTPUT` broadcast (which feeds the shared `LagPolicy::Replay` ring buffer at the router level, unchanged from today per [D06]), and (b) if the frame is a `system_metadata` event, stores it in `LedgerEntry::latest_metadata` for that session **and** publishes the frame on the supervisor's SESSION_METADATA `broadcast::Sender<Frame>` per [D14]. The broadcast publish is unconditional — late subscribers rely on the supervisor's on-subscribe replay (implemented in Step 8's `handle_client` wiring), not on receiving live frames retroactively.
- **Rewrite of `feeds/session_metadata.rs` per [D14]:** delete the entire `SessionMetadataFeed` struct + `run` loop. That module currently constructs a `watch::channel::<Frame>` and spawns a task that subscribes to the CODE_OUTPUT broadcast and latches `system_metadata` frames into the watch — every piece of that is replaced by supervisor state (`LedgerEntry::latest_metadata` + `client_sessions` + on-subscribe replay) plus the merger task's inline detection. The file is reduced to (a) a shared `is_system_metadata_line` needle-scan helper that the merger calls, plus any existing unit tests for the detection, or (b) deleted outright with the helper inlined into `agent_supervisor.rs` — author's choice based on whichever keeps the supervisor readable. No `watch::channel` remains anywhere for SESSION_METADATA.

**Tasks:**

- [x] Modify `run_agent_bridge` signature to take `tug_session_id: TugSessionId` and to **delete** both `project_info_tx: watch::Sender<Frame>` and `session_watch_tx: watch::Sender<Frame>` from the parameter list. Thread `tug_session_id` through.
- [x] Delete the `let (project_info_tx, project_info_rx) = watch::channel(...)` and `let (session_watch_tx, session_watch_rx) = watch::channel(...)` declarations at the top of `spawn_agent_bridge` (the whole `spawn_agent_bridge` function is going away, but the sub-deletion is called out explicitly so a coder does not miss it when refactoring).
- [x] Delete the `AgentBridgeHandles` struct and the `snapshot_watches: vec![project_info_rx, session_watch_rx]` construction at the return site.
- [x] Inside `run_agent_bridge`, delete the `let _ = project_info_tx.send(project_info_frame);` line near the top of the function (it runs once at startup, **before** the handshake loop — not after). Delete the `let _ = session_watch_tx.send(frame.clone());` line inside the `session_init` stdout branch. Keep the rest of the `session_init` handling (the supervisor callback and the `SESSION_STATE = live` publish).
- [x] **Also delete the `let _ = code_tx.send(project_info_frame.clone());` line that immediately precedes the deleted `project_info_tx.send` line (same startup block, runs once before the handshake loop).** This is the shared-broadcast side of the same `project_info` startup emission — deleting the watch latch alone would leave the broadcast emission unspliced, and under [D02]'s splice rule every outbound CODE_OUTPUT frame must carry `tug_session_id`. The whole `project_info` startup frame has no live non-`_archive/` consumer, so deleting the broadcast emission is cleaner than splicing a frame nobody reads. Delete the entire construction block as well: the `let project_info_json = ...` string-format and the `let project_info_frame = code_output_frame(project_info_json.as_bytes());` allocation. After this task, `run_agent_bridge` emits no `project_info` frame at all — neither on the shared broadcast nor on any watch.
- [x] Replace the existing `let frame = code_output_frame(line.as_bytes())` with a splice-then-wrap sequence using `splice_tug_session_id`.
- [x] Wire the `session_init`-detection path to write `claude_session_id` back into the ledger via an async callback (or a shared `Arc<Mutex<LedgerEntry>>`).
- [x] On successful handshake + first frame flushed from the per-session queue, publish `SESSION_STATE = live`.
- [x] Implement `merger_task` inside `agent_supervisor.rs`. Uses `tokio_stream::StreamMap` keyed by `TugSessionId`, same pattern as the router's existing server-to-client fan-in.
- [x] Detect `system_metadata` frames in the merger using the existing needle-scan pattern from `session_metadata.rs`. On match, look up the ledger entry for the frame's `tug_session_id` (outer mutex), clone the `Arc<Mutex<LedgerEntry>>`, release the outer lock, acquire the per-session lock, and write `entry.latest_metadata = Some(frame.clone())`. THEN publish the spliced frame on the supervisor's SESSION_METADATA `broadcast::Sender<Frame>` per [D14]. Write to the ledger field directly — no `SessionMetadataRegistry` wrapper; the merger is the sole caller of this write path, and `spawn_session`'s event-driven replay reads `latest_metadata` inline from the `Arc<Mutex<LedgerEntry>>` it already holds from `HashMap::entry(...).or_insert_with(...)`.
- [x] Delete `feeds/session_metadata.rs`'s `SessionMetadataFeed` struct and `run` task loop entirely. If the existing unit tests on needle-scan detection are worth keeping, relocate them to either `feeds/session_metadata.rs` (as pure helper tests) or `agent_supervisor.rs` alongside the merger.
- [x] **Delete the stale `test_project_info_frame_format` unit test** in `tugcast/src/feeds/agent_bridge.rs` (lines 384–397 today). The test constructs its own `project_info_json` string inline and asserts the JSON shape of a `project_info` frame — with the `project_info` startup emission deleted above, this test encodes a behavioral expectation for a code path that no longer exists. Because it does not call any deleted production function, the build does not catch it; it must be deleted explicitly. This is in addition to the `project_info_tx` / `code_tx.send(project_info_frame.clone())` deletions above.
- [x] On crash-budget exhaustion for a session, publish `SESSION_STATE = errored{detail: "crash_budget_exhausted"}`, drop the dispatcher sender for that session, but keep the intent record so `reset_session` works.
- [x] Remove the top-level `spawn_agent_bridge` call from `main.rs` (that lands in Step 8).

**Tests:**

- [x] `test_crash_budget_per_session` — one session's crash loop does not disable a sibling session. Mock the subprocess via a closure that simulates crashes.
- [x] `test_merger_fans_in_two_sessions` — two per-session mpscs feed the merger; both frames reach the CODE_OUTPUT broadcast and are routed through the splice helper.
- [x] `test_merger_routes_metadata_per_session_no_clobber` — two sessions each emit a `system_metadata` line in rapid succession; assert both frames are received by a SESSION_METADATA broadcast subscriber (neither is lost), and assert `LedgerEntry::latest_metadata` for each session holds its own distinct payload (no cross-pollination). This is the test that specifically pins the [D14] broadcast-vs-watch decision — it would pass with a broadcast and fail with a single-slot watch.
- [x] `test_session_init_populates_claude_session_id` — a mocked stdout line containing `"type":"session_init"` writes the parsed id into the ledger entry **without** touching any watch sender (verifies `session_watch_tx` deletion: there is no longer any `watch::channel` being latched; assertion is that no channel was constructed in test setup).

**Checkpoint:**

- [x] `cd tugrust && cargo build -p tugcast`
- [x] `cd tugrust && cargo nextest run -p tugcast`

---

#### Step 7: P5 single-writer relaxation to `(FeedId, Option<TugSessionId>)` {#step-7}

**Depends on:** #step-6

**Commit:** `feat(tugcast): relax P5 single-writer lock to (FeedId, tug_session_id)`

**References:** [D08] P5 relaxation, Spec S05, Risk R04, (#s05-p5-ownership-key)

**Artifacts:**

- Modified `InputOwnership` type alias, `try_claim_input` signature, `release_inputs` (unchanged behavior).
- `handle_client` passes `Some(tug_session_id)` for CODE_INPUT frames (parsed from the payload) and `None` for all other input feeds.
- New unit tests covering distinct-session and duplicate-session paths.
- Existing P5 unit tests continue to pass (pass `None` for the session argument).

**Tasks:**

- [x] Change `type InputOwnership = Arc<Mutex<HashMap<(FeedId, Option<TugSessionId>), u64>>>;` (import `TugSessionId` from `tugcast_core`).
- [x] Update `try_claim_input` and all its callers. For non-CODE_INPUT feeds, always pass `None`. For CODE_INPUT, parse `tug_session_id` from the payload via `parse_tug_session_id` before the claim attempt.
- [x] If the CODE_INPUT payload has no `tug_session_id`, reject using the existing `send_control_json(&mut socket, FeedId::CODE_INPUT, &json!({"type":"error","detail":"missing_tug_session_id"})).await` helper — do NOT route through the supervisor's CONTROL broadcast handle, they are different code paths. Do not touch the ownership map. (The orphan-reject path in Step 5's dispatcher is a different branch; it handles CODE_INPUT that has a `tug_session_id` but no ledger entry, which is emitted from the dispatcher task — that path legitimately uses the supervisor's CONTROL handle because there is no `&mut socket` in scope inside the dispatcher.)
- [x] **P5 authorization cross-check (one-line tightening).** Before inserting into `InputOwnership`, verify that the claiming `client_id` has the requested `tug_session_id` in its `client_sessions` entry: read `router.supervisor.client_sessions[client_id]` under its mutex and reject the claim if the set does not contain `tug_session_id`. Use `send_control_json(&mut socket, FeedId::CODE_INPUT, &json!({"type":"error","detail":"session_not_owned"})).await` for the rejection. Rationale: without this check, any client that learned another client's `tug_session_id` could race the legitimate owner to claim `(CODE_INPUT, tug_session_id)` ownership and have its CODE_INPUT frames delivered to the victim's subprocess. `tug_session_id`s are UUIDs and not normally visible cross-client, so the practical risk is low, but the supervisor already maintains `client_sessions` for [D14]'s event-driven replay — the cross-check is essentially free and closes a real authorization gap.
- [x] **Wedge acknowledgement:** This step makes missing-`tug_session_id` CODE_INPUT frames a hard-reject in the router. Until Step 9 lands (which updates tugdeck's `encodeCodeInput` to inject the field), the existing tugdeck code-input path is non-functional. This is explicitly called out in #non-goals and is acceptable because Steps 7 and 9 ship in the same branch.
- [x] Add a one-line comment at the top of `dispatch_action` naming the session actions that are handled upstream, pointing to `agent_supervisor.rs` (per [D09]).

**Tests:**

- [x] Existing `test_*_input_*` P5 tests continue to pass with `None` session arguments.
- [x] `test_p5_relaxation_distinct_sessions` — two clients each claim CODE_INPUT with distinct `tug_session_id`s; both succeed.
- [x] `test_p5_relaxation_duplicate_rejected` — second client claiming the same `tug_session_id` is rejected with `input_claimed`.
- [x] `test_p5_release_drops_all_entries_for_client` — `release_inputs` drops both the CODE_INPUT/session entry and any other inputs the client owned.
- [x] `test_p5_code_input_missing_session_id_rejected` — CODE_INPUT without `tug_session_id` is rejected via `send_control_json` (asserted by inspecting the websocket send path in the test harness) and does not insert into the ownership map.
- [x] `test_p5_code_input_rejects_unowned_session` — a client that has NOT sent `spawn_session` for `tug_session_id = X` sends a CODE_INPUT frame tagged with X. Supervisor's `client_sessions[client_id]` does not contain X. Assert: the claim is rejected via `send_control_json` with `detail: "session_not_owned"`, the ownership map is not mutated, and the frame is not forwarded to the dispatcher. Then have the same client send `spawn_session` for X, assert the follow-up CODE_INPUT is accepted. This pins the P5 authorization cross-check.

**Checkpoint:**

- [x] `cd tugrust && cargo nextest run -p tugcast router`

---

#### Step 8: Wire supervisor into `main.rs` and register SESSION_STATE {#step-8}

**Depends on:** #step-7

**Commit:** `feat(tugcast): wire AgentSupervisor into main.rs and register SESSION_STATE`

**References:** [D03] Supervisor consolidation, [D06] Shared replay with client filter, [D09] Control routing, [D10] Session state feed, [D12] tugbank domain, [D14] Session-scoped metadata, (#lifecycle-flow)

**Artifacts:**

- `main.rs` constructs `AgentSupervisor::new(...)` and its associated channels.
- `spawn_agent_bridge` top-level call is removed; the supervisor's `dispatcher_task` and `merger_task` are spawned instead.
- `feed_router.register_stream(FeedId::CODE_OUTPUT, code_tx, LagPolicy::Replay(shared_replay_buf))` — the CODE_OUTPUT `LagPolicy::Replay` registration is **unchanged from today** per [D06]. The existing single shared `ReplayBuffer` stays; client filters enforce isolation on replayed frames.
- `feed_router.register_stream(FeedId::SESSION_STATE, session_state_tx, LagPolicy::Warn)` — SESSION_STATE is not replayed; cards subscribe fresh.
- **`feed_router.register_stream(FeedId::SESSION_METADATA, session_metadata_broadcast_tx, LagPolicy::Warn)`** — SESSION_METADATA is a **broadcast stream**, not a snapshot watch. This is a change from the plan's earlier draft which referred to a `register_watch(FeedId::SESSION_METADATA, ...)` API that does not exist — the actual router API is `register_stream` (broadcast) + `register_input` (mpsc) + `add_snapshot_watches(Vec<watch::Receiver>)` (unkeyed bag). Because [D14] moves SESSION_METADATA from a watch to a broadcast, `register_stream` is now the correct call and `add_snapshot_watches` is not used for SESSION_METADATA at all. The supervisor's merger task publishes onto `session_metadata_broadcast_tx`; cards subscribe via the normal broadcast path; per-session replay on reconnect is handled event-driven inside `handle_control("spawn_session", ...)` (Step 4) — there is no separate batch replay helper.
- `feed_router.register_input(FeedId::CODE_INPUT, code_input_tx)` now points at the supervisor's dispatcher input.
- `FeedRouter::new` signature gains `supervisor: Arc<AgentSupervisor>`, or a setter method is added. Router's `handle_client` CONTROL branch gains the intercept block per [D09].
- **Deletions in `main.rs`:** the existing `snapshot_watches.extend(agent_handles.snapshot_watches)` line (which extended the router's bag with the bridge's two dead watches) is deleted outright. The `let agent_handles = spawn_agent_bridge(...)` call that produced those watches is replaced by the supervisor construction + task spawn, so the `agent_handles` binding and its `.snapshot_watches` field no longer exist at this site.
- **Additions in `handle_client` (inside `router.rs`):** at WebSocket teardown (in the cleanup path that already exists for `release_inputs`), call `router.supervisor.on_client_disconnect(client_id)`. The CONTROL intercept block signature takes `client_id` as a third argument: `router.supervisor.handle_control(action, &frame.payload, client_id).await`. **There is NO post-handshake replay call anywhere in `handle_client`** — per-session metadata replay on reconnect is performed event-driven inside `handle_control("spawn_session", ...)` (implemented in Step 4) and needs no additional wiring in `handle_client`. A fresh WebSocket mints a new `client_id` whose `client_sessions` entry is empty until the subsequent `spawn_session` CONTROL frame arrives, so any post-handshake replay call would be a perpetual no-op. This bullet is retained as an explicit negative requirement so a reviewer or a future revision does not reintroduce it.
- `main.rs` rebinds intent records from the `dev.tugtool.tide.session-keys` tugbank domain at startup.

**Tasks:**

- [x] Add `supervisor: Arc<AgentSupervisor>` to `FeedRouter` struct; thread through the constructor.
- [x] Replace `spawn_agent_bridge(...)` block in `main.rs` with supervisor construction + dispatcher/merger task spawns.
- [x] **Delete the `snapshot_watches.extend(agent_handles.snapshot_watches)` line** in `main.rs` (near line 359 today). With `AgentBridgeHandles` gone and the supervisor providing no `snapshot_watches`, this line has no replacement and must be removed, not retained as an empty extend.
- [x] Register `SESSION_STATE` as a stream output with `LagPolicy::Warn`.
- [x] Register `SESSION_METADATA` as a stream output via `register_stream(FeedId::SESSION_METADATA, session_metadata_broadcast_tx, LagPolicy::Warn)`. Do NOT call `add_snapshot_watches` for SESSION_METADATA — that was the old, deleted path.
- [x] Leave the CODE_OUTPUT `LagPolicy::Replay(shared_replay_buf)` registration unchanged from today. No new `LagPolicy` variant. Document inline (via a short comment) that correctness on replay relies on the client-side filter per [D06]/[D11].
- [x] **Remove the `SessionMetadataFeed` wiring from `main.rs` entirely.** The task no longer exists; its role is owned by the supervisor (merger task publishes live frames; `handle_control("spawn_session")` fires the event-driven replay on reconnect). Specifically delete these four pieces in `main.rs` — do not rely on `-D warnings` compile errors to surface them, name them here so a coder can grep directly:
  - [x] Delete the `let (session_meta_tx, session_meta_rx) = watch::channel(...);` allocation (near line 284 today). Under [D14] the SESSION_METADATA path is a broadcast, not a watch, so this watch channel has no replacement.
  - [x] Delete the `let session_metadata_feed = SessionMetadataFeed::new(code_tx.subscribe());` construction (near line 286 today). The `SessionMetadataFeed` struct itself is deleted in Step 6.
  - [x] Delete the `tokio::spawn(session_metadata_feed.run(session_meta_tx));` task spawn (near line 290 today). No replacement — the merger task in `agent_supervisor.rs` does the detection and publication inline.
  - [x] Delete the `session_meta_rx` entry inside the `snapshot_watches = vec![..., session_meta_rx, ...]` literal (near line 354 today). Under `-D warnings` this is a hard compile error if left in place (the binding no longer exists), but naming it explicitly here avoids guessing. The entire `snapshot_watches` vec literal may need to be reduced to `vec![]` or removed if it held only these dead entries — verify against the current `main.rs` state and reduce appropriately.
- [x] Modify `handle_client`'s CONTROL branch: parse action, intercept `spawn_session` / `close_session` / `reset_session` and call `router.supervisor.handle_control(action, &frame.payload, client_id).await` before the fall-through to `dispatch_action`. On `Err(ControlError::MissingCardId | MissingSessionId)`, call `send_control_json(&mut socket, FeedId::CONTROL, &json!({"type": "error", "detail": "missing_card_id"}))` (or the session variant) and continue the select loop — do NOT disconnect the client.
- [x] **Do NOT add any post-handshake replay call in `handle_client`.** Per [D14] and [F13]'s fix, event-driven replay runs inside `handle_control("spawn_session", ...)` (Step 4). Any post-handshake replay call with a fresh `client_id` is a guaranteed no-op because `client_sessions[client_id]` is empty at that moment — the client has not yet sent `spawn_session`. This bullet is retained as an explicit **negative requirement** so a reviewer or a future revision does not reintroduce a no-op call. There is no batch replay helper to call even if someone tried.
- [x] **Add `supervisor.on_client_disconnect(client_id)`** to the `handle_client` teardown path, alongside the existing `release_inputs(client_id)` call.
- [x] Add tugbank domain constant `dev.tugtool.tide.session-keys`. On startup, iterate persisted `(card_id, tug_session_id)` pairs from the domain and rebind intent records via an `AgentSupervisor::rebind_from_tugbank()` helper. **The rebind path does NOT go through `handle_control("spawn_session", ...)` and does NOT insert anything into `client_sessions`.** Instead, it directly creates a `LedgerEntry { spawn_state: Idle, .. }` for each persisted `tug_session_id` (skipping entries that already exist in the ledger from a prior rebind) and leaves `client_sessions` entirely untouched. Rationale per [F15]: `client_sessions` exists solely to track which WebSocket client has announced which session, and the rebind path has no WebSocket client — any sentinel `ClientId` (e.g., `ClientId::MAX`) inserted here would be a permanent ghost entry with no cleanup trigger (no real WebSocket calls `on_client_disconnect(ClientId::MAX)`). Real clients connecting after startup will send their own `spawn_session` CONTROL frames, which populate `client_sessions[real_client_id]` via [D14]'s normal flow and fire the event-driven metadata replay against whatever `latest_metadata` the prior session accumulated before shutdown (which, for a pure rebind from tugbank, is always `None` — there is no persisted metadata across restart, only the persisted intent record). The supervisor itself writes / deletes tugbank entries on `spawn_session` / `close_session` per [D12] (host-authoritative).

**Tests:**

- [x] `test_main_rebinds_intent_records_on_startup` — unit test on the `rebind_from_tugbank()` helper that reads a fake tugbank populated with `(card_id, tug_session_id)` pairs and creates ledger entries directly for each. Assert: all rebound ids appear in the ledger as `pending`; **`client_sessions` is empty** (per [F15], the rebind path does not insert any sentinel `client_id` entry); tugbank is unchanged (the helper only reads on startup, it does not re-write).
- [x] `test_control_frame_interception_routes_to_supervisor` — simulates a WebSocket CONTROL frame with `action: "spawn_session"` (including `card_id`) and asserts the supervisor ledger gains a pending entry and `client_sessions[client_id]` contains the session id. Uses the existing router test harness.
- [x] `test_control_frame_missing_card_id_sends_error_frame` — a CONTROL frame with `spawn_session` and no `card_id` results in a `send_control_json` error frame on the client socket and no ledger mutation.
- [x] `test_session_metadata_fed_by_supervisor_broadcast` — asserts that a `system_metadata` frame injected into the merger is received by a `register_stream`-registered broadcast subscriber (not any `watch::Receiver`), confirming the broadcast-not-watch migration.
- [x] `test_handle_client_disconnect_clears_client_sessions` — invoke the `on_client_disconnect` path and assert `client_sessions` no longer has an entry for the client.
- [x] **Removed:** the earlier-draft test `test_handle_client_replay_on_connect_emits_stored_metadata` is deleted. Its premise (pre-populating `client_sessions[client_id]` before invoking a post-handshake replay) does not exercise the real reconnect flow per [F13] — in practice, the fresh-connection `client_id` has an empty `client_sessions` entry at post-handshake time, and any such call would be a perpetual no-op. The real reconnect path is tested by Step 4's `test_spawn_session_replays_latest_metadata_for_known_session` (unit) and Step 10's `test_session_metadata_reaches_late_subscriber` (integration).

**Checkpoint:**

- [x] `cd tugrust && cargo build -p tugcast`
- [x] `cd tugrust && cargo nextest run -p tugcast`

---

#### Step 9: tugdeck `FeedStore` filter API, protocol constants, `encodeCodeInput` injection, and SessionMetadataStore filter {#step-9}

**Depends on:** #step-8

**Commit:** `feat(tugdeck): add FeedStore filter API, session protocol constants, encodeCodeInput session injection, and gallery SessionMetadataStore filter`

**References:** [D01] Session id naming, [D10] Session state feed, [D11] Filter scope, [D14] Session-scoped metadata, (#lifecycle-flow, #non-goals, #d14-session-scoped-metadata)

**Artifacts:**

- `tugdeck/src/lib/feed-store.ts`: new optional 4th constructor argument `filter?: (feedId: FeedIdValue, decoded: unknown) => boolean`. Runs inside the existing `onFrame` handler after decode, before the snapshot update. The replay-on-subscribe path (`TugConnection.onFrame` replays `lastPayload` synchronously) naturally flows through the same handler, so the filter runs on both live and replayed frames with zero additional code path — but the filter location must be inside the frame handler, not in `TugConnection`, so `TugConnection` stays session-agnostic.
- `tugdeck/src/protocol.ts`: new constants:
  - `FEED_ID_SESSION_STATE = 0x52`
  - `CONTROL_ACTION_SPAWN_SESSION = "spawn_session"`
  - `CONTROL_ACTION_CLOSE_SESSION = "close_session"`
  - `CONTROL_ACTION_RESET_SESSION = "reset_session"`
- `tugdeck/src/protocol.ts`: **`encodeCodeInput` signature update.** Current signature `encodeCodeInput(msg: object): ArrayBuffer` is replaced with `encodeCodeInput(msg: object, tugSessionId: string): ArrayBuffer`. The function spreads `{ tug_session_id: tugSessionId, ...msg }` into the JSON payload before encoding. **No live production call site exists.** `encodeCodeInput` has exactly one call site today — the definition itself in `tugdeck/src/protocol.ts`. The sole formerly-cited caller `tugdeck/src/__tests__/conversation-types.test.ts` is explicitly listed in `tugdeck/tsconfig.json`'s `exclude` array (line 26) and is NOT compiled or type-checked by `bunx tsc --noEmit`, so it does not participate in the wedge closure. All live production CODE_INPUT dispatch paths in `tugdeck/src/components/tugways/cards/conversation-card.tsx` are under `_archive/` and not active code. **The signature change is a pure definition-site change** — no other file in the tugdeck source tree needs updating. Live production CODE_INPUT call sites will be reintroduced by T3.4 and will use the new signature from day one.
- **`tugdeck/src/components/tugways/cards/gallery-prompt-input.tsx` update (per [D14], passthrough filter per overviewer OF1/OQ1).** The file currently instantiates `new SessionMetadataStore(metaFeedStore, FeedId.SESSION_METADATA)` for slash-command completions, and the `metaFeedStore` it wraps is a `FeedStore` subscribed to `SESSION_METADATA` with no filter. Under [D14]'s multi-session fix, SESSION_METADATA becomes a broadcast that carries frames for every live session. **The gallery `FeedStore` continues to use NO filter** (passthrough; equivalent to a constant-true filter). Rationale: `gallery-split-pane.tsx`'s own file-header comment documents the gallery as "a test harness for iterating on TugSplitPane under HMR. It is **not** a target environment." Slash-command completions in the gallery are a dev convenience, not a production feature. An earlier draft of this plan mandated minting a per-mount `tug_session_id` via `useMemo(() => crypto.randomUUID(), [])` and filtering against it — that design is **wrong** and is retracted: the gallery never sends a `spawn_session` CONTROL frame for a minted-per-mount id, so no Claude Code subprocess is ever spawned for it, and under [D02] every real session's `system_metadata` is stamped with the supervisor-tracked `tug_session_id` of whichever session actually emitted it. The minted UUID would match nothing on the wire, and the filter would reject every real session's metadata — yielding empty slash-command completions. Passthrough is correct: under a single running Claude Code subprocess (HMR, the common dev case), the gallery behaves indistinguishably from today. Under multi-session (multiple concurrent sessions in one browser), the gallery will display last-writer-wins: whichever session's `system_metadata` arrived most recently. This cross-session pollution is **explicitly accepted** as a test-harness limitation and is documented in the non-goals. A TSX comment at the top of the gallery `FeedStore` construction names this explicitly and points at the non-goal for future readers. Real per-card filters are scheduled for T3.4 via `CodeSessionStore`.
- New CONTROL frame builders in `tugdeck/src/protocol.ts` (or a new `session-control.ts` helper) for `encodeSpawnSession(cardId: string, tugSessionId: string)`, `encodeCloseSession(cardId: string, tugSessionId: string)`, `encodeResetSession(cardId: string, tugSessionId: string)`. All three builders produce a CONTROL frame with payload `{ action, card_id: cardId, tug_session_id: tugSessionId }` per Spec S03. **`card_id` is a required argument, not optional** — the server-side supervisor rejects CONTROL frames missing `card_id` with a `send_control_json` error per Step 4, so letting it be optional on the client side would only create silent bugs.
- Unit tests in `tugdeck/src/__tests__/feed-store.test.ts` (note the `__tests__` directory — colocated with other tugdeck tests following the convention of `filetree-store.test.ts`, `prompt-history-store.test.ts`, `session-metadata-store.test.ts`) covering:
  - Filter rejects a live frame → snapshot unchanged.
  - Filter accepts a live frame → snapshot updated.
  - Filter runs on the replay path: subscribe after a cached `lastPayload` is set, assert the filter runs against the cached payload.
- **No extension to `tugdeck/src/__tests__/conversation-types.test.ts` is required.** That file is explicitly listed in `tugdeck/tsconfig.json`'s `exclude` array (line 26) and is not compiled under `bunx tsc --noEmit`. Updating it would be a no-op on the wedge-closure narrative because it does not participate in any type check or test run that gates this step. An earlier draft of this plan listed this file as "the only non-definition call site" — factually true as a text occurrence, but irrelevant because the file is tsconfig-excluded. The signature change is a pure definition-site change.
- New unit tests in `tugdeck/src/__tests__/protocol.test.ts` asserting `encodeCodeInput({ type: "user_text", text: "hi" }, "abc-123")` produces a decoded payload whose first field is `tug_session_id: "abc-123"`, plus tests for `encodeSpawnSession` / `encodeCloseSession` / `encodeResetSession` asserting each produces a CONTROL frame with both `card_id` and `tug_session_id` in the payload.

**Tasks:**

- [x] Add the optional `filter` parameter to the `FeedStore` constructor; store it on the instance.
- [x] Apply the filter inside the existing `onFrame` callback after decode, before the map update.
- [x] Update the module-level JSDoc to document the filter semantics and the replay path.
- [x] Add the four protocol constants.
- [x] Update `encodeCodeInput` signature and body to inject `tug_session_id`. **This is a pure definition-site change.** `encodeCodeInput` has exactly one call site (the definition itself); no live production caller exists. `conversation-types.test.ts` is tsconfig-excluded (see `tugdeck/tsconfig.json` `exclude` line 26) and does not need updating. Do not hunt for other call sites — there are none in live tugdeck code; the archive paths under `_archive/` are not compiled.
- [x] Add `encodeSpawnSession`, `encodeCloseSession`, `encodeResetSession` CONTROL frame builders. Each takes `cardId` and `tugSessionId` as required arguments.
- [x] **Update `gallery-prompt-input.tsx` to instantiate its `SessionMetadataStore`-wrapping `FeedStore` for SESSION_METADATA with NO filter (passthrough).** Equivalent forms are acceptable: omitting the 4th argument entirely, or passing a constant-true filter. Do NOT mint a per-mount random `tug_session_id` via `useMemo(() => crypto.randomUUID(), [])` — that design is retracted (the minted UUID never has a spawned subprocess behind it and the filter would reject every real session's metadata). Add a TSX comment at the top of the `FeedStore` construction explaining the gallery's test-harness status and the accepted last-writer-wins pollution under multi-session, and pointing at the non-goal for rationale. A minimal comment body: `// Gallery is a test harness (see gallery-split-pane.tsx header). No tug_session_id filter: under multi-session this is last-writer-wins, explicitly accepted per the multi-session-router plan #non-goals. Real per-card filters land in T3.4 via CodeSessionStore.`
- [x] Write the feed-store filter tests at `tugdeck/src/__tests__/feed-store.test.ts`.
- [x] Extend `tugdeck/src/__tests__/protocol.test.ts` with the `encodeCodeInput` injection test and the three CONTROL frame builder tests.

**Tests:**

- [x] `bun test tugdeck/src/__tests__/feed-store.test.ts` — new filter tests.
- [x] `bun test tugdeck/src/__tests__/protocol.test.ts` — `encodeCodeInput` injection test plus CONTROL frame builder tests.

**Checkpoint:**

- [x] `cd tugdeck && bun test`
- [x] `cd tugdeck && bun run audit:tokens lint` (if tokens touched — they are not, but run it to confirm no regression)

---

#### Step 10: Real Claude Code integration tests {#step-10}

**Depends on:** #step-9

**Commit:** `test(tugcast): add real Claude Code multi-session integration tests`

**References:** [D13] Integration tests, Risk R05, (#test-plan-concepts)

**Artifacts:**

- New directory `tugrust/crates/tugcast/tests/`.
- New file `tugrust/crates/tugcast/tests/common/mod.rs` with test helpers:
  - `start_tugcast_for_test()` — spawns a tugcast instance bound to an ephemeral port, returns the port and a cancel handle.
  - `connect_ws(port)` — opens a WebSocket client and performs the handshake.
  - `send_spawn_session(ws, card_id, tug_session_id)`, `send_code_input(ws, tug_session_id, prompt)`, `send_close_session(ws, card_id, tug_session_id)`. Each helper that wraps a CONTROL action takes `card_id` as a required argument because Spec S03 requires it on the wire.
  - `await_session_state(ws, tug_session_id, target_state, timeout)`.
  - `collect_code_output(ws, tug_session_id, until_turn_complete)` — collects frames until `turn_complete` arrives and returns the shape.
- New file `tugrust/crates/tugcast/tests/multi_session_real_claude.rs` with these `#[ignore]`-gated `#[tokio::test]`s:
  - `test_single_session_end_to_end` — spawn one session, send `> /status`, assert `session_init` arrives, assert `turn_complete` arrives, close.
  - `test_two_sessions_never_cross` — spawn sessions A and B, send distinct prompts, assert A's collector never receives any frame with `tug_session_id == B` and vice versa.
  - `test_lazy_spawn_no_subprocess_until_first_input` — `spawn_session` then wait 500ms; assert no `claude` process is running; send CODE_INPUT; assert `claude` process appears; assert `SESSION_STATE = live` arrives.
  - `test_orphan_input_rejected` — send CODE_INPUT for an unknown `tug_session_id`; assert a `session_unknown` CONTROL frame is received and no subprocess is spawned.
  - `test_reset_session_reinitializes` — spawn, live, `reset_session`, assert `closed` then `pending` on SESSION_STATE, then send CODE_INPUT and assert a fresh `session_init` arrives with a new `claude_session_id`.
  - `test_supervisor_rebind_on_startup` — persist an intent record via tugbank, restart tugcast, open a fresh WebSocket, send `spawn_session` with the same `(card_id, tug_session_id)` that was persisted, subscribe to SESSION_STATE, assert the session is `pending` and the same subprocess can be driven by CODE_INPUT afterward.
  - `test_p5_cross_client_distinct_sessions` — two WebSocket clients, each claiming CODE_INPUT with a distinct `tug_session_id`; both succeed and receive their own outputs.
  - `test_session_metadata_reaches_late_subscriber` — session A connects (WebSocket `W1`), sends `spawn_session`, sends a CODE_INPUT, and receives a `system_metadata` frame from Claude (cached in `LedgerEntry::latest_metadata` for A's `tug_session_id`). `W1` disconnects. A new WebSocket `W2` opens — the supervisor assigns a **fresh** `client_id`, so `client_sessions[new_client_id]` starts empty. `W2` subscribes to SESSION_METADATA via `FeedStore` with a `tug_session_id = A` filter. `W2` then sends `spawn_session` with the same `card_id` and `tug_session_id = A`. **Assert:** `W2`'s SESSION_METADATA subscription receives exactly one frame carrying A's original `latest_metadata`, delivered as the event-driven one-shot replay that `handle_control`'s `spawn_session` branch fires (per [D14] and [F13]). No post-handshake replay call is involved. The assertion specifically pins that the replay happens **after** `W2` subscribes and **as a result of** `W2` sending `spawn_session`, not during `W2`'s handshake. Pins the [D14] event-driven replay correctness and rejects the alternative (broken) design where replay runs post-handshake before `spawn_session` arrives.
  - `test_session_metadata_two_sessions_no_clobber_real_claude` — two sessions connect via the same WebSocket, each receives its own `system_metadata` from Claude; assert both cards (using the FeedStore filter) receive their own session's snapshot and neither observes the other's.
- Test-only `[dev-dependencies]` in `tugrust/crates/tugcast/Cargo.toml` as needed (`tokio-tungstenite`, `reqwest`, etc., if not already present).

**Tasks:**

- [x] Create the `tests/` directory and `common/mod.rs` helpers.
- [x] Write each test. Each test begins with `#[ignore]` and a header comment explaining: "Gated on `TUG_REAL_CLAUDE=1`; requires a real `claude` binary on PATH or via `resolve_tugcode_path`."
- [x] Tests check the `TUG_REAL_CLAUDE` env var at the top and `return` if unset (belt-and-suspenders alongside `#[ignore]`).
- [x] Document the env var in the file's module-level doc comment and in `dash/tide.md` P2 exit notes.
- [x] Ensure the tests compile (even if `#[ignore]`-ed) so `cargo build --tests -p tugcast` passes clean.

**Tests:**

- [x] `cd tugrust && cargo build --tests -p tugcast` — compilation-only verification.
- [x] `cd tugrust && TUG_REAL_CLAUDE=1 cargo nextest run -p tugcast --run-ignored only` — the real run, performed by the developer manually.

**Checkpoint:**

- [x] `cd tugrust && cargo build --tests -p tugcast`
- [x] `cd tugrust && cargo nextest run -p tugcast` — standard suite stays green (ignored tests do not run).

---

#### Step 11: Integration Checkpoint {#step-11}

**Depends on:** #step-1, #step-2, #step-3, #step-4, #step-5, #step-6, #step-7, #step-8, #step-9, #step-10

**Commit:** `N/A (verification only)`

**References:** [D01] Session id naming, [D02] Splice stamping, [D03] Supervisor consolidation, [D04] Lazy spawn, [D05] Bounded queue, [D06] Shared replay with client filter, [D07] Per-session crash budget, [D08] P5 relaxation, [D09] Control routing, [D10] Session state feed, [D11] Filter scope, [D12] tugbank domain, [D13] Integration tests, [D14] Session-scoped metadata, (#success-criteria, #lifecycle-flow)

**Tasks:**

- [x] Verify all 12 items from tide.md §T0.5 P2 are covered: supervisor module [✓ Step 3–8], `tug_session_id` splice [✓ Step 2, 6], CODE_INPUT dispatcher [✓ Step 5], CODE_OUTPUT merger [✓ Step 6], lazy spawn [✓ Step 5], bounded per-session queue [✓ Step 5], SESSION_STATE feed [✓ Step 1, 8], control-frame surface with `card_id` payloads [✓ Step 4, 8, 9], FeedStore filter API + `encodeCodeInput` injection [✓ Step 9], cross-client P5 relaxation [✓ Step 7], tugbank persistence (including supervisor-side write/delete) [✓ Step 4, 8], real Claude Code integration tests [✓ Step 10], session-scoped metadata rewrite via broadcast + on-subscribe replay and deletion of `project_info` / `session_watch` dead watches [✓ Step 6, 8].
- [x] Verify all exit criteria in [#exit-criteria] are satisfied.
- [x] Manually run the real-Claude-Code integration suite once (`TUG_REAL_CLAUDE=1 cargo nextest run -p tugcast --run-ignored only`) and confirm all tests pass against the real binary.
- [x] Update `dash/tide.md §T0.5 P2` status footer to mark the plan as landed.
- [x] Update `dash/code-session-remediation.md` to check off the "Plan authorship — next step" item.

**Tests:**

- [x] Full suite: `cd tugrust && cargo nextest run` — all standard tests pass, no warnings.
- [x] Full suite: `cd tugdeck && bun test` — all tugdeck tests pass.
- [x] Developer-run: `cd tugrust && TUG_REAL_CLAUDE=1 cargo nextest run -p tugcast --run-ignored only` — all real-Claude-Code tests pass.

**Checkpoint:**

- [x] `cd tugrust && cargo build` (entire workspace, warnings-are-errors)
- [x] `cd tugrust && cargo nextest run`
- [x] `cd tugdeck && bun test`
- [x] `cd tugrust && cargo build --tests -p tugcast` (ignored tests compile clean)

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** Two or more concurrent Claude Code sessions running behind a single `CODE_OUTPUT`/`CODE_INPUT` FeedId pair with a shared CODE_OUTPUT replay buffer guarded by client-side filtering, session-scoped SESSION_METADATA routing, per-session crash budgets, lazy spawn-on-first-input, cross-client P5 relaxation, host-authoritative tugbank persistence, and a `#[ignore]` + `TUG_REAL_CLAUDE=1`-gated real-Claude-Code integration test suite — unblocking T3.4 Tide card multi-session.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

**Status — 2026-04-12:** ✅ **All criteria satisfied.** Plan landed across
commits `c31a013d` (Step 1) through `6ed2492e` (Step 11 docs).

- [x] `cargo build` green across the full workspace with `-D warnings` enforced (CLAUDE.md build policy).
- [x] `cargo nextest run` green across the full workspace (standard non-ignored suite) — **1012 passed, 18 skipped** (9 `#[ignore]`-gated real-Claude, 9 pre-existing).
- [x] `bun test` green in `tugdeck/` — **1924 passed, 0 failed** across 86 files.
- [x] All unit tests listed under Steps 2–9 exist and pass.
- [x] All integration tests listed under Step 10 exist, compile clean, and have been manually run once with `TUG_REAL_CLAUDE=1` and reported as passing — **9/9** against `claude 2.1.104` + `tmux 3.6a`.
- [x] `FeedId::SESSION_STATE = 0x52` and `TugSessionId` exist in `tugcast-core` and mirror in `tugdeck/src/protocol.ts` (`FEED_ID_SESSION_STATE = FeedId.SESSION_STATE`).
- [x] `AgentSupervisor` is the only owner of multi-session state (no session state scattered across `router.rs` / `agent_bridge.rs` / `main.rs` beyond wiring). The shared CODE_OUTPUT `ReplayBuffer` stays at the router level per [D06].
- [x] `tug_session_id` is spliced into every outbound CODE_OUTPUT frame; `SessionMetadataFeed`'s single global `watch::channel` is deleted and replaced by a supervisor-owned `broadcast::channel` plus **event-driven per-session replay inside `handle_control("spawn_session", ...)`** (per [D14]), so SESSION_METADATA is session-scoped end-to-end and concurrent sessions no longer clobber each other's snapshots.
- [x] `AgentBridgeHandles`, `project_info_tx`/`project_info_rx`, and `session_watch_tx`/`session_watch_rx` are deleted from `agent_bridge.rs`, and the `snapshot_watches.extend(agent_handles.snapshot_watches)` line is deleted from `main.rs`. The former `SessionMetadataFeed` wiring in `main.rs` — the `session_meta_tx/session_meta_rx` `watch::channel` allocation, the `SessionMetadataFeed::new(code_tx.subscribe())` construction, the `tokio::spawn(...run(...))` call, and the `session_meta_rx` entry inside the `snapshot_watches` vec literal — is deleted in Step 8. No `watch::channel` remains for either SESSION_METADATA or the former project_info / session_watch snapshot paths.
- [x] `handle_client` calls `supervisor.on_client_disconnect(client_id)` on teardown. **There is no post-handshake replay call** — per-session metadata replay runs event-driven inside `handle_control("spawn_session", ...)`; there is no batch replay helper and no separate replay trigger anywhere else in the code.
- [x] Spec S03 CONTROL payloads carry a required `card_id` field and the supervisor rejects payloads missing it via a `send_control_json` error frame; the supervisor never synthesizes `card_id` from `client_id`. The startup rebind path (`rebind_from_tugbank`) bypasses `handle_control` entirely and creates ledger entries directly without any `client_id` synthesis (per [F15]).
- [x] `encodeCodeInput` injects `tug_session_id` into every outbound CODE_INPUT payload (closes the Step 7 wedge).
- [x] P5 `(FeedId, tug_session_id)` relaxation works: distinct-session claims succeed, duplicate-id claims are rejected.
- [x] `FeedStore` filter runs on both live frames and `TugConnection.lastPayload` replay (asserted by unit tests at `tugdeck/src/__tests__/feed-store.test.ts`).
- [x] `dev.tugtool.tide.session-keys` tugbank domain is created, the supervisor writes/deletes entries on `spawn_session` / `close_session` (host-authoritative), and `AgentSupervisor::rebind_from_tugbank()` re-creates pending ledger entries at startup.
- [x] `dash/tide.md §T0.5 P2` is marked as landed; `dash/code-session-remediation.md` plan authorship item is checked off.

**Acceptance tests:**

- [x] `test_two_sessions_never_cross` (integration, real Claude Code) — two-session isolation verified end-to-end.
- [x] `test_lazy_spawn_no_subprocess_until_first_input` (integration, real Claude Code) — lazy spawn verified by state-machine observation (no `spawning` frame arrives until the first CODE_INPUT).
- [x] `test_p5_cross_client_distinct_sessions` (integration, real Claude Code) — cross-client relaxation verified.
- [x] `test_supervisor_rebind_on_startup` (integration, real Claude Code) — tugbank persistence verified across restart.
- [x] `test_crash_budget_per_session` (unit) — isolation verified via injectable `CrashingSpawner` vs `StallSpawner`.
- [x] `feed-store.test.ts` filter tests (tugdeck) — client filter verified on both live and replay paths.

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] Global supervisor spawn rate limit / concurrent-session hard cap (see [Q01]).
- [ ] `LagPolicy::ReplayPerClient` variant plus supervisor-owned `client_id → Vec<TugSessionId>` map maintained by the CONTROL spawn/close interceptor. This is the correct long-term replacement for [D06]'s shared-replay-with-client-filter approach; it frees closed-session replay memory immediately on `close_session` instead of waiting for ring eviction. Trigger to land: real usage shows the shared buffer's isolation-by-filter is too coarse (e.g., many concurrent sessions dilute a single session's replay content below the useful threshold), OR the deferred memory reclamation in the residual risk for [R03] becomes user-visible.
- [ ] `CodeSessionStore` implementation in tugdeck, consuming the filter API from this phase (scheduled for T3.4.a).
- [ ] Claude Code `--resume` integration for reload-with-history (explicitly out of scope here; decision logged in [D12]).
- [ ] Bridge test-mode / fake tugcode binary for faster CI (explicitly declined; retained here only as a possible future revisit if the real-Claude-Code tests become a bottleneck).
- [ ] Multi-client collaborative editing on a single `tug_session_id` (out of scope; distinct from cross-client multi-session).
- [ ] Polymorphic `PerSessionWatch<T>` primitive (generalizing [D14]'s per-session SESSION_METADATA routing) once a second per-session snapshot feed needs the same shape.

| Checkpoint | Verification |
|------------|--------------|
| Wire contract stability | `cargo nextest run -p tugcast-core` green; golden-byte tests cover `SESSION_STATE = 0x52`. |
| Supervisor correctness | `cargo nextest run -p tugcast feeds::agent_supervisor` green; all Step 3–6 unit tests pass. |
| P5 relaxation | `cargo nextest run -p tugcast router` green; all Step 7 unit tests pass. |
| Router integration | `cargo nextest run -p tugcast` green; Step 8 tests pass. |
| Client filter | `bun test tugdeck/src/lib/feed-store.test.ts` green; Step 9 tests pass. |
| Real-world verification | `TUG_REAL_CLAUDE=1 cargo nextest run -p tugcast --run-ignored only` — developer-manual run, all tests green. |
| Workspace-wide build | `cargo build` green under `-D warnings`. |
