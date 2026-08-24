<!-- tugplan-skeleton v2 -->

## T3.0.W2 — Per-session workspace binding on spawn_session {#workspace-registry-w2}

**Purpose:** Bind each Tide card's session to a canonical `project_dir` on the wire, replace `AgentSupervisorConfig::project_dir` with a per-session workspace lookup through `WorkspaceRegistry`, and introduce reference-counted workspace teardown so two cards pointing at the same project share one feed bundle while disjoint cards get their own.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | complete (automated); manual A/B smoke deferred to [T3.4.c](../dash/tide.md#t3-4-c-tide-card) |
| Target branch | main |
| Last updated | 2026-04-15 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

T3.0.W1 landed `WorkspaceRegistry` as the owner of per-project feed bundles, but in a bootstrap-only shape: `main.rs` calls `get_or_create(&watch_dir)` exactly once at startup, the returned `Arc<WorkspaceEntry>` lives for the process lifetime, and `AgentSupervisorConfig::project_dir` still holds the single workspace path that every spawned Claude subprocess inherits. W1's `presentWorkspaceKey` filter on the tugdeck side is a smoke alarm — it asserts the `workspace_key` field is end-to-end, but it accepts *any* key because there's only one.

W2 completes the transition to multi-workspace tugcast: clients pick a `project_dir` at card open time, ship it on `spawn_session`, and the supervisor drives `WorkspaceRegistry::get_or_create(project_dir)` per session instead of once at startup. Two cards pointing at `/frontend` and `/backend` get distinct `FileWatcher` / `GitFeed` / `FileTreeFeed` bundles, distinct tugcode subprocesses, distinct Claude cwds — all derived from one `project_dir` field the client sent. The tugdeck filter tightens from presence-check to value-check so each card's `FeedStore` only accepts frames carrying its own `workspace_key`. W2 leaves W1's `--dir` bootstrap in place as a fallback for compat; W3 retires that last thread.

W2 also folds in a **standalone schema bump** on `SessionKeysStore` (Step 1 below). Today the blob is `Value::String(tug_session_id_uuid)` — one UUID per card. W2 needs `project_dir` on rehydrate; [P14](#p14-claude-code-resume) will need `claude_session_id` shortly after. Doing both as one schema bump now — with W2's field populated and P14's field `Option::None` — means only one migration event, not two.

#### Strategy {#strategy}

- **Land the schema bump first, in isolation.** Step 1 extends `SessionKeysStore` to a structured `SessionKeyRecord` carrying `tug_session_id`, `project_dir`, and `claude_session_id`. W2's lifecycle work in later steps depends on it; P14 can piggyback when it's ready.
- **Build the tugdeck plumbing before wiring it up.** Steps 2 and 3 introduce a new `CardSessionBindingStore` and `useCardWorkspaceKey` hook, then refactor `Tugcard` and `gallery-prompt-input` to consume the hook. Until the store is populated (Step 7), the hook returns `undefined` and the filter falls back to `presentWorkspaceKey` — **W1 behavior exactly**. No regression during the Step 3 → Step 7 window.
- **Strip the supervisor of its global workspace before adding per-session workspaces.** Step 4 changes `ChildSpawner::spawn_child(&self, project_dir: &Path)` so the spawner is stateless — nothing in the supervisor closes over a workspace-level path. This is a structural prerequisite for Step 6, where the per-session `project_dir` is the only source.
- **Extend `WorkspaceRegistry` with refcount + `release()` as a pure library change.** Step 5 touches only `workspace_registry.rs` — the supervisor doesn't call `release` yet. Unit tests exercise the lifecycle in isolation so any race shows up before it's entangled with the supervisor's control loop.
- **Thread the CONTROL payload and lifecycle hooks through the supervisor.** Step 6 is the heart of W2: `LedgerEntry.workspace_key` + `LedgerEntry.project_dir`, `spawn_session` handler calls `registry.get_or_create` after validation, `close_session` calls `release`, `reset_session` preserves the binding, `rebind_from_tugbank` re-populates entries from persisted records. `AgentSupervisorConfig::project_dir` is deleted in this step.
- **Ship the tugdeck wire change last.** Step 7 updates `encodeSpawnSession` to take `projectDir` and populates `CardSessionBindingStore` when the CONTROL handshake completes. Up until Step 7 the Rust tests drive the new CONTROL shape by constructing frames directly; between Step 6 and Step 7 there's a short window where tugdeck→tugcast is intentionally incompatible, but both sides have full automated test coverage in isolation. Step 8 is the integration checkpoint.
- **No backward compat hack for missing `project_dir` on CONTROL.** Once Step 6 lands, `project_dir` is required on every `spawn_session`. Frames without it produce an `InvalidProjectDir` CONTROL error. The short cross-step window during which tugdeck is out of sync is bridged by Rust tests — not by a runtime fallback that would have to be cleaned up later.

#### Success Criteria (Measurable) {#success-criteria}

- Two sessions spawned with distinct canonical `project_dir`s produce two distinct `WorkspaceEntry`s — assert `registry` map length is 2 and the two entries are not `Arc::ptr_eq` equal. (verification: `test_two_sessions_two_workspaces`)
- Two sessions spawned with canonically-identical `project_dir`s share one `WorkspaceEntry` with `ref_count == 2` — assert `Arc::ptr_eq` and registry map length is 1. Closing one session keeps the workspace alive. (verification: `test_two_sessions_same_project_share_workspace`)
- Closing the last session bound to a workspace tears it down: the entry is removed from the registry map, its `CancellationToken` has fired, and the four feed `JoinHandle`s complete within a bounded timeout. (verification: `test_workspace_teardown_on_last_session_close`)
- `spawn_session` with a nonexistent `project_dir` returns a CONTROL error frame whose payload contains `"invalid_project_dir"` and does not create a workspace entry. (verification: `test_spawn_session_rejects_invalid_project_dir`)
- `AgentSupervisorConfig::project_dir` is deleted from the struct. `rg AgentSupervisorConfig::project_dir tugrust/crates/tugcast/src` returns zero matches. (verification: grep in exit-criteria run)
- `SessionKeysStore` persists structured records and dual-reads legacy `Value::String` records as `SessionKeyRecord { project_dir: None, claude_session_id: None }`; records with `project_dir == None` are dropped on `rebind_from_tugbank` with a warn log and do not repopulate the registry. (verification: `test_rebind_drops_records_without_project_dir`, `test_rebind_restores_workspace_entries_from_records`)
- Each tugdeck card's `FeedStore` accepts only frames whose `workspace_key` matches the card's bound key, with a fallback to the W1 presence check when unbound. (verification: `use-card-workspace-key.test.tsx`, `card-session-binding-store.test.ts`, `tugcard.test.tsx` filter fallback cases)
- `cargo nextest run` (full workspace) green on every intermediate commit. `bun test` (full tugdeck) green after every commit that touches tugdeck. (verification: Step checkpoints)
- Manual two-workspace smoke in Tug.app: open two cards pointed at different projects, confirm each card's git feed shows its own branch, each file completion returns its own project's files, and DevTools shows frames for card A are filtered out of card B's store. (verification: Step 8 manual checklist)

#### Scope {#scope}

1. `SessionKeysStore` blob schema bump: `Value::String` → `Value::Json(SessionKeyRecord)` with dual-read migration.
2. `WorkspaceRegistry::release(&self, &WorkspaceKey)` with refcount decrement and teardown-at-zero semantics; `WorkspaceEntry.ref_count: AtomicUsize` field.
3. `LedgerEntry.workspace_key: WorkspaceKey` and `LedgerEntry.project_dir: PathBuf` fields.
4. `spawn_session` CONTROL payload gains a required `project_dir` field; `InvalidProjectDir { reason }` error variant.
5. `ChildSpawner::spawn_child(&self, project_dir: &Path)` trait signature change; `TugcodeSpawner` becomes stateless; test doubles updated.
6. `AgentSupervisorConfig::project_dir` field deletion; `default_spawner_factory` stops closing over any workspace-level path.
7. Supervisor lifecycle hooks: `spawn_session` acquires workspace, `close_session` releases, `reset_session` preserves binding, `rebind_from_tugbank` re-acquires from persisted records.
8. Tugdeck `CardSessionBindingStore` (new) + `useCardWorkspaceKey` hook (new), consumed by `Tugcard` (refactor) and `gallery-prompt-input` (refactor — inline `FeedStore` moves into the component).
9. Tugdeck `encodeSpawnSession(cardId, tugSessionId, projectDir)` signature update; binding store populated on successful spawn, drained on close.
10. `workspaceKeyFilter` field removed from `CardRegistration`; `filter` prop removed from `TugcardProps`. `git-card.tsx` registration no longer sets it. (Clean-up from W1, now that the hook is the source of truth.)
11. Four integration tests from [tide.md W2](#t3-workspace-registry-w2) exit criteria, plus rebind tests, plus tugdeck store/hook tests.
12. Deletion of `EphemeralSessionKeysStore` and its `impl SessionKeysStore` block from `main.rs`; tugbank unavailability becomes a fatal startup error via `eprintln!` + `std::process::exit(1)` matching the existing TCP-bind-error pattern ([D15]).

#### Non-goals (Explicitly out of scope) {#non-goals}

- **UI for picking `project_dir` at card-open time.** T3.4.c owns the affordance; W2 uses a test-fixture constant in its own integration tests and wires the plumbing end-to-end.
- **Retiring the `--dir` CLI flag.** W3 owns the retirement. W2 leaves the flag in place; the bootstrap workspace it produces is no longer used by the supervisor once W2's spawn_session path lands, but the registry entry remains for W3 to remove.
- **Per-workspace `BuildStatusCollector`.** Stays tugtool-source-tree-scoped per [tide.md W3](#t3-workspace-registry-w3) deep dive; tracked as a separate follow-up.
- **P14 field population.** W2 persists `claude_session_id: None` on the new record; P14 starts writing the field later without another schema change.

#### Dependencies / Prerequisites {#dependencies}

- [T3.0.W1](./tugplan-workspace-registry-w1.md) — shipped. Provides `WorkspaceRegistry`, `WorkspaceEntry`, `WorkspaceKey`, `splice_workspace_key`, and the tugdeck presence filter that W2 tightens to a value check.
- `tugbank-core` `Value::Json` variant. Exists. Enables the schema bump.
- `tokio_util::sync::CancellationToken` — already used by `WorkspaceEntry` in W1. Required for teardown.
- No P14 dependency: W2 persists `claude_session_id: None` and P14 can start populating the field later without another schema change.
- No T3.4.a dependency: `CardSessionBindingStore` is standalone. T3.4.a's `CodeSessionStore` (turn state) is a separate layer above it and may co-locate with it later.
- No tugcode changes. The `--dir` flag on tugcode still receives a path string; W2 just ensures each session's path is per-session rather than process-global.

#### Constraints {#constraints}

- **`-D warnings` on every intermediate commit.** No `#[allow(dead_code)]` left in place as permanent scaffolding — every allow introduced in W1 must be earned (i.e., have a real reader) or removed by the end of W2.
- **Held-mutex discipline in `WorkspaceRegistry::release`.** The std `Mutex<HashMap>` is held across the refcount decrement, the map mutation, and the cancel-token fire so a concurrent `get_or_create` on the same key cannot observe a half-torn-down entry. This is the correctness partner of W1's held-mutex `get_or_create` discipline ([W1 Spec S02](./tugplan-workspace-registry-w1.md#s02-registry-api)).
- **`tokio::spawn` inside `WorkspaceEntry::new` stays synchronous.** `std::sync::Mutex` across the `new` call is only safe because `new` does not `.await`; any refactor that adds an `.await` would require migrating to `tokio::sync::Mutex` (not in scope).
- **CONTROL frame format is JSON over the `CONTROL` stream feed.** `project_dir` is added as a new sibling field next to `card_id` and `tug_session_id`. No versioning flag, no feature gate — post-Step-6 tugcast requires it, and any tugdeck that sends the old shape gets an `InvalidProjectDir` CONTROL error with reason `missing_project_dir`.
- **L02 compliance on tugdeck** ([L02](../tuglaws/tuglaws.md)). External state enters React through `useSyncExternalStore` only. `CardSessionBindingStore` follows the same store-subscribe shape as `FeedStore`; `useCardWorkspaceKey` calls `useSyncExternalStore` directly.
- **Filter identity stability on tugdeck.** `FeedStore._filter` is set once in the constructor with no runtime swap. The hook must produce a filter whose reference is stable as long as the underlying `workspaceKey` string is unchanged — achieved via `useMemo` on the string dependency.

#### Assumptions {#assumptions}

- No production tugbank data exists that needs migration. All current `SessionKeyRecord` readers are developer machines; the dual-read path is for forward compat with any in-flight test blob, not for user data.
- Canonicalization via `PathResolver::watch_path()` is the same in W2 as in W1 — infallible, returns the original path if system resolution fails. W2 validates *existence* via `std::fs::metadata` before canonicalization so the error path catches "path does not exist" cleanly.
- Two sessions for the same canonical path started at approximately the same time will serialize through the registry's held `std::sync::Mutex`; the second caller sees the first's fully-constructed `WorkspaceEntry` because `get_or_create` holds the lock across the construct-and-insert.
- `close_session` fires at most once per `card_id` over the session's lifetime. The supervisor's control loop is responsible for idempotency; `WorkspaceRegistry::release` is allowed to return `Err(UnknownKey)` on a double-release and the supervisor logs + ignores.
- The tugdeck session bootstrap flow has exactly one place where `encodeSpawnSession` is invoked and its response is awaited. W2's store-population call goes in that same location.
- Cards that have not completed `spawn_session` yet still need to render (with W1-shape filters). The hook returns `undefined` during the unbound window, and the `Tugcard` memoized filter falls back to `presentWorkspaceKey`.

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

This plan follows the [tugplan-skeleton v2](../tuglaws/tugplan-skeleton.md) anchor rules: explicit `{#anchor}` tags on every citable heading, two-digit IDs for `[D0N]` / `[Q0N]` / `Spec S0N` / `Risk R0N`, and `**References:**` lines on every execution step that cite plan artifacts (never line numbers).

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] When a blob records a `project_dir` that no longer exists on disk, what happens on rebind? (DECIDED → [D03]) {#q01-rebind-missing-project-dir}

**Question:** `rebind_from_tugbank` reads `SessionKeyRecord`s at startup and calls `registry.get_or_create(&project_dir)` for each. If the persisted `project_dir` no longer exists — the user deleted the directory between runs — should rebind error, fall back, drop the record, or something else?

**Why it matters:** The supervisor can't materialize a workspace for a path that doesn't exist, and there's no client connection to prompt for a new one. Any choice that "succeeds partially" risks leaving a ledger entry whose workspace_key points at nothing.

**Options:**
- (a) Drop the record with a warn log. Client reconnects and sends a fresh `spawn_session` to re-establish.
- (b) Treat as a recoverable condition: create a placeholder workspace entry that throws on any feed subscription. Noisy, complicated, unlikely to be useful.
- (c) Fail startup loudly. Forces user intervention but blocks all sessions because of one stale record.

**Resolution:** DECIDED → see [D03]. Option (a). Drop-and-log. The session's ledger entry is not created; a fresh `spawn_session` on the same `card_id` later repopulates cleanly.

#### [Q02] Should `EphemeralSessionKeysStore` be removed now that the schema is structured? (DECIDED → [D15]) {#q02-ephemeral-store-removal}

**Question:** The `EphemeralSessionKeysStore` in `main.rs` is a no-op fallback used when tugbank is unavailable. W1 kept it. W2's schema bump touches its `set_session_record` / `list_session_records` methods. Is it still worth keeping?

**Resolution:** DECIDED → delete. See [D15]. Tugbank is essential infrastructure for multi-session persistence; silently failing over to an in-memory no-op store double-ups the work of the real store, loses state on every restart, and hides real problems from the user. W2 deletes the fallback entirely and fails startup cleanly when tugbank is unavailable — matching the existing `main.rs` pattern for fatal startup errors.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| **R01** Teardown race — `close_session` fires while `spawn_session_worker` is still starting | med | low | Held-mutex discipline in both `get_or_create` and `release`; supervisor serializes control frames per `card_id` | `test_teardown_race_*` fails, or a real teardown panic in logs |
| **R02** Refcount leak on partial spawn failure | high | med | Explicit release-on-error in the `spawn_session` handler — any failure after a successful `get_or_create` triggers `release` before the error frame is published | Grep `registry.get_or_create` callsites and confirm every path either stores `workspace_key` on the ledger or calls `release` |
| **R03** Dual-read migration breaks rehydrate for in-flight test blobs | med | low | `test_rebind_reads_legacy_string_records` constructs a `Value::String` blob directly, asserts synthesized record with `None` fields, asserts drop-on-rebind | New test added in Step 1 |
| **R04** Value-check filter rejects valid frames during the mount→spawn_session window | med | med | Hook returns `undefined` when unbound; `Tugcard` memoized filter falls back to `presentWorkspaceKey` (W1 behavior) | `test_filter_falls_back_when_unbound` |
| **R05** `ChildSpawner::spawn_child` trait ripple breaks test doubles | low | med | Grep inventory of all `impl ChildSpawner for *` callsites before Step 4; update every test double in the same commit | `cargo check -p tugcast --tests` after Step 4 |
| **R06** `close_session` on a `card_id` that never bound a workspace panics or errors | low | low | `release` returns `Err(UnknownKey)`; supervisor logs and ignores; `close_session` handler treats workspace release as best-effort | `test_close_session_without_workspace` |
| **R07** Concurrent `spawn_session` on the same `project_dir` leaks a `WorkspaceEntry` | high | low | Held-mutex `get_or_create` from W1; second caller finds existing entry, bumps refcount, returns without constructing | Re-run `test_two_sessions_same_project_share_workspace` under `--test-threads 1` vs parallel to confirm no flake |

**Risk R01: Teardown race** {#r01-teardown-race}

- **Risk:** `close_session` fires on card A while `spawn_session_worker` for card B (same `project_dir`) is in the middle of calling `registry.get_or_create`. Card A's `release` could observe the entry mid-construction or race the refcount back to zero before B increments it.
- **Mitigation:**
  - The `std::sync::Mutex<HashMap>` is held across the entire `get_or_create` check-construct-insert sequence and across the entire `release` read-decrement-teardown sequence. The two operations serialize through the same lock.
  - The supervisor's per-session control loop is single-threaded per `tug_session_id` — a single card cannot interleave its own spawn and close. Cross-card serialization lives at the registry mutex.
- **Residual risk:** If W2 ever grows a need to `.await` inside `WorkspaceEntry::new`, the std Mutex becomes unsound and needs to migrate to `tokio::sync::Mutex`. Not in W2 scope but worth naming so it's caught in code review if it sneaks in.

**Risk R02: Refcount leak on partial spawn failure** {#r02-refcount-leak}

- **Risk:** `spawn_session` handler calls `get_or_create` (refcount +1), then calls `tugcode_spawn` (fails), then publishes a CONTROL error frame. Without explicit cleanup the refcount stays at +1 forever and the workspace never tears down.
- **Mitigation:**
  - The `spawn_session` handler uses a scoped guard pattern: any error path between `get_or_create` success and ledger-entry insertion explicitly calls `release` before returning the error.
  - Spec S05 enumerates the exact control flow for the handler.
  - Code-level assertion: `test_spawn_session_release_on_tugcode_failure` uses a `CrashingSpawner` and asserts the registry map is empty after the error frame fires.
- **Residual risk:** Panic paths (`unwrap`, `expect`) inside the handler window would still leak. `-D warnings` + the code-review habit of preferring `?` + test coverage are the three lines of defense.

**Risk R03: Dual-read migration breaks rehydrate for in-flight test blobs** {#r03-migration-dual-read}

- **Risk:** A developer machine with a pre-W2 tugbank file has records in the old `Value::String` shape. Rehydrate fails or silently drops them.
- **Mitigation:**
  - `list_session_records` inspects each value's variant and synthesizes a `SessionKeyRecord { project_dir: None, claude_session_id: None }` from `Value::String(s)`.
  - `rebind_from_tugbank` skips records with `project_dir == None` (per [D03]) and warn-logs.
  - Unit test constructs a `Value::String` blob directly through `TugbankClient::set(SESSION_KEYS_DOMAIN, ...)` and asserts the dual-read + drop path.
- **Residual risk:** None meaningful. The legacy reader is trivially covered and the drop behavior is test-asserted.

**Risk R04: Value-check filter rejects valid frames during the mount→spawn_session window** {#r04-unbound-window}

- **Risk:** A card mounts, `Tugcard` computes its filter before `spawn_session` completes, the hook returns `undefined`, and if the filter were constructed as "strict value match" the card would reject the first batch of bootstrap-workspace frames — blank git, empty filetree — until spawn_session lands.
- **Mitigation:**
  - `Tugcard`'s `useMemo` branches on `workspaceKey`: when defined, it returns a strict value-check filter; when undefined, it returns `presentWorkspaceKey`. This matches W1 behavior exactly for any card that hasn't finished its spawn handshake.
  - Unit test: mount a `Tugcard` with an unbound `card_id`, assert its `FeedStore` accepts a frame carrying an arbitrary `workspace_key`.
  - When `spawn_session` completes and populates the store, `useSyncExternalStore` re-runs, the memo recomputes, and the filter tightens. `FeedStore.onFrame`'s replay path will naturally re-apply the new filter against the most recent cached payload.
- **Residual risk:** Order-of-operations bug in which a card binds *after* frames have already been processed — but since `FeedStore.onFrame` replays cached payloads through the filter on every subscribe, the tightened filter will re-evaluate against the most recent cached frame and accept or reject it cleanly.

---

### Design Decisions {#design-decisions}

#### [D01] `SessionKeysStore` trait renames to record-shaped methods (DECIDED) {#d01-sessionkeys-trait-rename}

**Decision:** Rename the trait's write and list methods to `set_session_record` and `list_session_records`. Keep `delete_session_key(card_id)` as-is (no value involved). The trait carries no legacy-string method.

**Rationale:**
- The current `set_session_key(&self, card_id, tug_session_id)` signature implies "the value is a session id" — after the bump the value is a record with multiple fields. The renamed method's signature makes the record shape visible at the call site.
- `list_session_keys` → `list_session_records` makes it obvious that migration consumers see *records*, not raw UUIDs. Legacy blob handling is internal to the `TugbankClient` impl.
- A parallel `set_session_key(&str, &TugSessionId)` adapter that wraps `set_session_record` is *not* added — it would give the impression W2 allows writing partial records, which is wrong.

**Implications:**
- Every caller of `set_session_key` (grep: `agent_supervisor.rs:606` and test harness callsites) is updated to construct a `SessionKeyRecord` explicitly.
- Every caller of `list_session_keys` (grep: `rebind_from_tugbank`, test harness) is updated to match on the new tuple shape `(String, SessionKeyRecord)`.
- The supervisor no longer propagates a bare `TugSessionId` through the persistence layer — it always has the full record in scope when writing.

#### [D02] `SessionKeyRecord` uses `Option<String>` for forward-compatible fields (DECIDED) {#d02-session-record-option-fields}

**Decision:** The `SessionKeyRecord` struct shape is:
```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionKeyRecord {
    pub tug_session_id: String,
    #[serde(default)]
    pub project_dir: Option<String>,
    #[serde(default)]
    pub claude_session_id: Option<String>,
}
```

**Rationale:**
- `tug_session_id` is the primary key, required on every write. Always `String`, never optional.
- `project_dir` becomes `Some(...)` in W2 and stays populated for every new record. It's `Option` so dual-read from legacy `Value::String` blobs can produce a `None` value without needing a sentinel or a second type.
- `claude_session_id` is reserved for P14 and starts as `None` in W2. `#[serde(default)]` lets an older P14-unaware writer omit the field entirely without breaking the deserializer.
- Both `#[serde(default)]` attributes mean forward- and backward-compat are handled by serde itself, not by manual version tags.

**Implications:**
- Post-W2 writes always produce `SessionKeyRecord { project_dir: Some(...), claude_session_id: None }`. P14 will start writing `claude_session_id: Some(...)` without changing the schema.
- Callers that need `project_dir` must handle the `None` case explicitly — for `rebind_from_tugbank` that means drop-and-log per [D03].

#### [D03] Rebind drops records whose `project_dir` is `None` (DECIDED) {#d03-rebind-drops-none-project-dir}

**Decision:** `rebind_from_tugbank` iterates `list_session_records`, and for any record whose `project_dir` is `None`, warn-logs (with `card_id` and `tug_session_id` in the log) and skips it. No ledger entry is created, no workspace is materialized, no error bubbles up to the caller. The return count reflects only successfully-rebound records.

**Rationale:**
- Legacy `Value::String` records (pre-W2) cannot bind a workspace because they pre-date the concept.
- Records whose `project_dir` points at a deleted directory need *some* disposition; drop-and-log is the cheapest and most honest.
- A fresh `spawn_session` on the same `card_id` will create a new record (replacing the old one via `set_session_record`) and establish a fresh workspace binding. The session isn't lost — it's just unavailable until the client reconnects.
- Failing startup loudly (Q01 option c) punishes all other sessions because of one stale record.

**Implications:**
- Test `test_rebind_drops_records_without_project_dir` constructs a `Value::String` record directly, calls `rebind_from_tugbank`, asserts return count 0 and a warn log matching the expected pattern.
- The ledger entry for the dropped session is absent after rebind — the client reconnects and the CONTROL loop handles the missing entry as "no such session," prompting a fresh `spawn_session`.

#### [D04] Validate existence *before* canonicalizing (DECIDED) {#d04-validate-before-canonicalize}

**Decision:** The `spawn_session` handler calls `std::fs::metadata(&raw_project_dir)` and checks `is_dir()` *before* wrapping the path in `PathResolver::watch_path().to_string_lossy().into_owned()` to build the `WorkspaceKey`. Metadata failure paths map to `InvalidProjectDir { reason: "does_not_exist" | "permission_denied" | "not_a_directory" }`.

**Rationale:**
- `PathResolver::new(path).watch_path()` is infallible by design — it returns the original path if system calls fail (W1 [D01]). It's the wrong layer to signal "this path doesn't exist" because it would have to smuggle the error through an infallible API.
- `std::fs::metadata` fails cleanly with `io::ErrorKind` variants that map naturally to `InvalidProjectDir::reason` enumerants.
- Validating before canonicalization also avoids producing a `WorkspaceKey` for a nonexistent path — a subtle bug where two invalid paths with the same canonicalized form would dedup into "one workspace that doesn't exist."
- The canonicalization step after validation is still required because the same *existing* directory can arrive as multiple textually-distinct paths (W1 dedup).

**Implications:**
- Spec S05 spells out the exact `match` on `metadata`'s error kind.
- `InvalidProjectDir::reason` is a `&'static str` (not a `String`) because the three values are known at compile time and it keeps the error small.

#### [D05] Explicit `release` on any error path after `get_or_create` (DECIDED) {#d05-release-on-error}

**Decision:** The `spawn_session` handler wraps the post-`get_or_create` work in a scope where every error path (`tugcode_spawn` failure, ledger-insertion race, persistence failure) calls `registry.release(&workspace_key)` before returning the error. This is not left to destructors or RAII — it's an explicit call in each branch.

**Rationale:**
- Rust has no language-level try/finally. A scope guard (e.g. `scopeguard::defer!`) could work but adds a dependency and obscures the control flow.
- Explicit calls make the error path auditable: you can grep the handler for `release` and confirm every `?` or error return is paired with a `release` call.
- The guard pattern is consistent with W1's held-mutex discipline: state changes happen deliberately, not implicitly.

**Implications:**
- Spec S05 control flow is spelled out line by line with every branch enumerated.
- Code review for Step 6 grep-verifies each branch.
- Test `test_spawn_session_release_on_tugcode_failure` uses `CrashingSpawner` to assert refcount returns to 0 on spawn failure.

#### [D06] Tugdeck filter binding via new `CardSessionBindingStore` + `useCardWorkspaceKey` hook (DECIDED) {#d06-card-session-binding-store}

**Decision:** A new L02-compliant `CardSessionBindingStore` (TypeScript, external-subscribable) holds `card_id → { tugSessionId, workspaceKey, projectDir }`. A new `useCardWorkspaceKey(cardId): string | undefined` hook reads from it via `useSyncExternalStore`. `Tugcard` calls the hook internally; `gallery-prompt-input` is refactored so its inline `FeedStore` construction moves inside the `GalleryPromptInput` component and also calls the hook. The `workspaceKeyFilter?: FeedStoreFilter` field on `CardRegistration` and the `filter?: FeedStoreFilter` prop on `TugcardProps` are removed.

**Rationale:**
- **Uniform hook access**: `Tugcard` and `gallery-prompt-input` both read from one hook. No special-case path for the inline `FeedStore` consumer.
- **L02-compliant**: external state enters React through `useSyncExternalStore` only, inside the hook.
- **Stable filter identity**: `useMemo` on the `workspaceKey` string gives a stable filter reference when the binding is unchanged. `useSyncExternalStore` returns the same reference when the underlying value hasn't changed, so `useMemo`'s dependency array behaves correctly.
- **Graceful fallback**: when `workspaceKey` is `undefined` (pre-spawn_session), the filter falls back to `presentWorkspaceKey` — the exact W1 behavior — so there's no broken window during the mount-to-spawn handshake.
- **Gallery-prompt-input is W2 anyway**: the existing W1 follow-on note already scheduled this migration; W2 is exactly the right phase to land it.

**Implications:**
- New files: `tugdeck/src/lib/card-session-binding-store.ts`, `tugdeck/src/components/tugways/hooks/use-card-workspace-key.ts`, corresponding test files.
- `Tugcard` no longer takes a `filter` prop. `DeckCanvas` no longer passes `filter={registration.workspaceKeyFilter}`. `CardRegistration.workspaceKeyFilter` is deleted.
- `git-card.tsx` drops the `workspaceKeyFilter: presentWorkspaceKey` line from its registration.
- `gallery-prompt-input.tsx`'s module-scope `FeedStore` singleton pattern (`_fileCompletionProvider`) is replaced with per-component construction gated by `useMemo` + `useEffect` cleanup.
- `presentWorkspaceKey` stays exported from `card-registry` as the unbound-state fallback; it's no longer set on registrations but it's imported by `Tugcard` and `GalleryPromptInput`.

#### [D07] Filter falls back to `presentWorkspaceKey` when `workspaceKey` is `undefined` (DECIDED) {#d07-filter-fallback-unbound}

**Decision:** Inside `Tugcard` and `GalleryPromptInput`, the `useMemo` that builds the filter branches on `workspaceKey`:
```ts
const filter = useMemo<FeedStoreFilter>(
  () => workspaceKey
    ? (_, decoded) => typeof decoded === "object"
        && decoded !== null
        && "workspace_key" in decoded
        && (decoded as { workspace_key: unknown }).workspace_key === workspaceKey
    : presentWorkspaceKey,
  [workspaceKey],
);
```

**Rationale:**
- Cards mount before their CONTROL handshake completes. During that window, the card has no bound workspace but may still receive bootstrap-workspace frames. Strict value-check would produce a blank card.
- Falling back to the W1 presence check means "accept any frame that carries *some* workspace_key" — which is exactly the behavior the card had in W1 and the user never saw a regression.
- Once binding completes, the hook returns a string, `useMemo` recomputes, and `FeedStore`'s new filter is installed. The replay path re-runs the cached frame through the tightened filter and either keeps it or drops it.
- Using `presentWorkspaceKey` directly as the fallback (rather than a third no-op filter) keeps the W1 entry point exported and exercised — the fallback *is* the W1 behavior, not a substitute.

**Implications:**
- `useMemo` dependency is just `[workspaceKey]` — no `[workspaceKey, presentWorkspaceKey]` because `presentWorkspaceKey` is a module-scope constant.
- `FeedStore._filter` is set once in the constructor; the `Tugcard` effect that builds the store re-runs when the memoized filter changes identity, producing a fresh store. This matches how `FeedStore` is already constructed in W1.
- Unit test `test_filter_falls_back_when_unbound` asserts that a card with no binding receives a frame carrying an arbitrary workspace_key.

#### [D08] `WorkspaceEntry.ref_count: AtomicUsize`, not a separate map (DECIDED) {#d08-refcount-on-entry}

**Decision:** The refcount lives as an `AtomicUsize` field on `WorkspaceEntry`. `get_or_create` on a map hit does `entry.ref_count.fetch_add(1, Ordering::Relaxed)` under the held mutex. `release` acquires the mutex, looks up the entry, calls `fetch_sub(1, Ordering::Relaxed)`, and if the result is 0, fires `entry.cancel`, removes the entry from the map, and drops it.

**Rationale:**
- Keeping the refcount on the entry itself (rather than a parallel `HashMap<WorkspaceKey, usize>`) keeps all per-workspace state in one place and avoids a second lookup cost.
- `AtomicUsize` is sufficient because all mutations happen under the map mutex — the atomic is belt-and-suspenders for visibility, not for cross-thread correctness.
- `Relaxed` ordering is fine because the mutex already provides happens-before; upgrading to `SeqCst` or `AcqRel` would be superstitious.

**Implications:**
- Spec S04 pins `ref_count: AtomicUsize`.
- W1's `WorkspaceEntry` has no `ref_count` field — Step 5 adds it. The initial value on construction is 1.
- `release` removes from the map only when `fetch_sub(1, Relaxed)` returns 1 (i.e., the pre-decrement value — meaning the new value is 0). `AtomicUsize::fetch_sub` returns the *previous* value; don't confuse it with "post-value is 0."

#### [D09] `WorkspaceError` enum introduced with `InvalidProjectDir` and `UnknownKey` variants (DECIDED) {#d09-workspace-error-enum}

**Decision:** `feeds/workspace_registry.rs` gains a `WorkspaceError` enum:
```rust
#[derive(Debug, thiserror::Error)]
pub enum WorkspaceError {
    #[error("invalid project directory {path:?}: {reason}")]
    InvalidProjectDir { path: PathBuf, reason: &'static str },

    #[error("unknown workspace key: {0}")]
    UnknownKey(String),
}
```

- `get_or_create` becomes `Result<Arc<WorkspaceEntry>, WorkspaceError>`, returning `InvalidProjectDir` on validation failure.
- `release` becomes `Result<(), WorkspaceError>`, returning `UnknownKey` if the key is not present.

**Rationale:**
- W1 [D04] deliberately avoided a `WorkspaceError` type because there were no real failure modes. W2 has two, enumerated above.
- Split enums (e.g. `GetOrCreateError` + `ReleaseError`) would duplicate variants across types without a clean boundary.
- `thiserror` is already used in `agent_supervisor.rs` for `SessionKeysStoreError`; consistency.

**Implications:**
- W1's tests that called `get_or_create(..., cancel.clone())` without a `?` now need `.expect(...)` or `?` in the new return shape. W1's bootstrap test uses a `TempDir` which always exists, so `.expect("bootstrap workspace always valid")` is acceptable.
- `main.rs` (the W1 bootstrap call) uses `.expect("bootstrap workspace")` — the startup path cannot continue without a workspace, and failure means the user passed `--dir /nonexistent`, which is a fatal configuration error.

#### [D10] `ChildSpawner::spawn_child` takes `&Path`, not `Arc<Path>` or `PathBuf` (DECIDED) {#d10-spawn-child-arg-type}

**Decision:** `ChildSpawner::spawn_child(&self, project_dir: &Path) -> SpawnFuture`. Not `PathBuf` (would force a clone at the callsite), not `Arc<Path>` (`Arc<Path>` is unusual in Rust outside niche refcounted-path crates and adds import noise), not `&PathBuf` (deprecated style).

**Rationale:**
- `&Path` is the idiomatic function parameter for path slices.
- `TugcodeSpawner` calls `Command::new("...").arg(project_dir)` which takes `AsRef<Path>`, satisfied by `&Path` directly.
- The `Arc<str>` handle lives on `LedgerEntry` and gets converted with `PathBuf::from(ledger.project_dir.as_str())` on the `spawn_child` call site... wait, no: `LedgerEntry.project_dir` is `PathBuf`, so the call is `spawner.spawn_child(&ledger.project_dir).await`.

**Implications:**
- Test doubles write `async fn spawn_child(&self, _project_dir: &Path) -> ...` — the `_` prefix prevents the unused-variable warning while documenting the param is intentional-but-ignored.
- `TugcodeSpawner` drops its `project_dir: PathBuf` field; it becomes `pub struct TugcodeSpawner { tugcode_path: PathBuf }`.

#### [D11] `reset_session` preserves the workspace binding (DECIDED) {#d11-reset-preserves-workspace}

**Decision:** `reset_session(card_id)` aborts the tugcode subprocess and respawns with the same `project_dir` from the ledger entry. The workspace `ref_count` is **not** cycled — the same `WorkspaceEntry` stays alive across the reset.

**Rationale:**
- Reset is meant to be fast and preserve the user's context. Tearing down the workspace feeds (file watcher, git poller) only to rebuild them immediately would add latency and flicker with no benefit.
- The bug `reset_session` is meant to solve is a hung Claude subprocess, not a corrupted file watcher.
- Matches the tide.md spec for W2.

**Implications:**
- `reset_session` handler does not call `release` or `get_or_create`. It calls `spawner.spawn_child(&ledger.project_dir)` to re-launch tugcode with the same path.
- `test_reset_session_preserves_workspace` asserts the `Arc<WorkspaceEntry>` before and after a reset is `Arc::ptr_eq`-equal.

#### [D12] `AgentSupervisorConfig::project_dir` is deleted (not deprecated) (DECIDED) {#d12-agent-supervisor-config-deleted}

**Decision:** The `project_dir: PathBuf` field on `AgentSupervisorConfig` is removed entirely in Step 6. `default_spawner_factory` is updated to build a stateless `TugcodeSpawner` from just `tugcode_path`. `main.rs`'s supervisor construction no longer passes `project_dir` into the config.

**Rationale:**
- Leaving the field as "deprecated but still there" would be dead weight that complicates W3 (which was going to delete it anyway).
- W2's whole point is that the supervisor no longer has a global project path. Keeping the field half-alive signals "there's still one global path somewhere" and confuses readers.
- Every caller of `AgentSupervisorConfig` is in the tugcast crate; no external crate breaks.

**Implications:**
- `main.rs` `AgentSupervisorConfig { ... }` literal drops the `project_dir: watch_dir.clone()` line.
- W1's bootstrap workspace from `--dir` is still created and held alive by `main.rs` in a local binding so that the initial `FileWatcher` etc. stay running for any clients that connect without sending `project_dir` — **wait, no: post-Step-6, any client that sends `spawn_session` without `project_dir` gets an error.** The bootstrap workspace becomes a background keepalive that nothing references. W3 deletes it.
- `test_agent_supervisor_config_has_no_project_dir` is a grep-based assertion (not a runtime test) that runs in CI.

#### [D13] `CardSessionBindingStore` is its own module, not folded into `DeckManager` (DECIDED) {#d13-binding-store-standalone}

**Decision:** `CardSessionBindingStore` is a new standalone store class in `tugdeck/src/lib/card-session-binding-store.ts`, following the shape of `FeedStore`. It is not a new field on `DeckManagerStore` or a new domain of the existing deck state.

**Rationale:**
- `DeckManager` owns layout and tab state — what cards exist, where they're placed, which tabs are active. Per-session binding is orthogonal: it's about what the supervisor has acknowledged for a given `card_id`, not about layout.
- Mixing the two would mean every layout change re-renders every `useCardWorkspaceKey` consumer, and every binding change re-renders every layout consumer.
- A standalone store is a single file, ~60 lines, with its own test file. Trivial to reason about.
- Follows the same pattern as `FeedStore`, `SessionMetadataStore`, `PromptHistoryStore`, etc. — one store per concern.

**Implications:**
- `card-session-binding-store.ts` exports a module-scope singleton instance (mirroring how other stores are used in tugdeck).
- Tests import the class directly and construct isolated instances, not the singleton.
- Tugdeck session bootstrap code (wherever `encodeSpawnSession` is sent and awaited) imports the singleton and calls `setBinding` on success / `clearBinding` on close.

#### [D14] `useCardWorkspaceKey` hook lives under `components/tugways/hooks/` (DECIDED) {#d14-hook-placement}

**Decision:** The hook file is `tugdeck/src/components/tugways/hooks/use-card-workspace-key.ts`. Not folded into an existing hooks file, not placed at `src/lib/hooks/`.

**Rationale:**
- Existing tugdeck hooks live under `components/tugways/hooks/` — `use-tugcard-data.ts`, etc. One hook per file.
- The hook is specific to the tugways card system (it takes a `cardId`), so the `tugways/hooks` location is semantically right.

**Implications:**
- Import path: `@/components/tugways/hooks/use-card-workspace-key` (or the project-relative equivalent).
- Test file: `tugdeck/src/__tests__/use-card-workspace-key.test.tsx`.

#### [D15] `EphemeralSessionKeysStore` is deleted; tugbank unavailability becomes a fatal startup error (DECIDED) {#d15-ephemeral-store-deleted}

**Decision:** Delete the `EphemeralSessionKeysStore` struct and its `impl SessionKeysStore` block from `main.rs`. When `TugbankClient::open(&bank_path)` fails, `main.rs` prints a clear error via `eprintln!` and exits with status 1, matching the existing fatal-startup-error pattern already in use for TCP bind failures (`main.rs` TCP listener branch) and missing tugcode binaries (the `tugcode_path.exists()` panic).

**Rationale:**
- Tugbank is essential infrastructure for multi-session persistence. Silently falling over to a no-op in-memory store means sessions "work" within a single process lifetime, and then every persisted binding disappears on the next restart — worse than failing up front because the user doesn't learn about the failure until they've already lost state.
- Fallback machinery that duplicates the work of essential infrastructure is exactly the kind of shim this project explicitly avoids (see [CLAUDE.md](../CLAUDE.md): *"Don't use feature flags or backwards-compatibility shims when you can just change the code"*).
- The existing `main.rs` pattern for fatal startup errors is `eprintln!` + `std::process::exit(1)` for the TCP bind case and `panic!` for the tugcode-missing case. The tugbank-unavailable path joins this set using the `eprintln!` + `exit(1)` form for consistency with the bind-error style.
- `NoopSessionKeysStore` at `feeds/agent_supervisor.rs:1062` is a `pub(crate)` test fixture used only by router integration tests. It is NOT a production fallback and stays — Step 1 still updates its methods to the new record-shaped trait.

**Implications:**
- `main.rs`'s `session_keys_store` construction at `main.rs:327` changes from a fallback `if let Some(...) else { warn + ephemeral }` to a hard early-exit on `None`. The `warn!("tugbank unavailable — AgentSupervisor falling back to EphemeralSessionKeysStore; ...")` log is deleted.
- Any test that relied on `EphemeralSessionKeysStore` as a standalone fixture is rewritten to use `NoopSessionKeysStore` or a `TempDir`-backed real `TugbankClient`. Step 1 includes a grep-inventory task to find them.
- Scope adds a deletion item; non-goals loses its "deletion is out of scope" carve-out.

---

### Deep Dives (Optional) {#deep-dives}

#### End-to-end: spawn_session with a new workspace {#flow-spawn-new-workspace}

1. Client mounts a card with `card_id = "gizmo-42"`, picks `project_dir = "/home/user/frontend"`, mints `tug_session_id = UUID::v4()`.
2. Client calls `encodeSpawnSession("gizmo-42", "uuid-abc", "/home/user/frontend")` and sends the CONTROL frame.
3. tugcast's `AgentSupervisor::handle_control` routes to the `spawn_session` branch.
4. Handler validates `project_dir`:
    - `std::fs::metadata("/home/user/frontend")` → `Ok(m)`.
    - `m.is_dir()` → `true`.
    - Proceed.
5. Handler calls `registry.get_or_create(&project_dir, cancel.clone())`:
    - Canonicalize via `PathResolver::new(project_dir.to_path_buf()).watch_path()`.
    - Acquire mutex.
    - Look up canonical key → `None` (fresh).
    - Construct `WorkspaceEntry::new(project_dir.to_path_buf(), workspace_key.clone(), cancel.clone())` — spawns `FileWatcher::run`, `FilesystemFeed::run`, `FileTreeFeed::run`, `GitFeed::run`.
    - Insert `Arc::new(entry)` into the map with `ref_count = 1`.
    - Return `Ok(Arc::clone(&entry))`.
6. Handler constructs a `SessionKeyRecord { tug_session_id: "uuid-abc".into(), project_dir: Some("/home/user/frontend".into()), claude_session_id: None }` and calls `store.set_session_record("gizmo-42", &record)`. On persistence failure: **call `registry.release(&workspace_key)`** and return the CONTROL error.
7. Handler builds a `LedgerEntry { tug_session_id, workspace_key, project_dir: project_dir.clone(), claude_session_id: None, crash_budget: CrashBudget::default() }` and inserts it into the ledger. On duplicate `card_id`: **call `registry.release(&workspace_key)`** and return the CONTROL error.
8. Handler calls `supervisor.spawn_session_worker(card_id, ledger_entry)` which schedules the per-session bridge task. The bridge task calls `spawner.spawn_child(&ledger_entry.project_dir).await`.
9. The bridge task pipes stdin/stdout/stderr. `tugcode` starts Claude with `cwd` = `project_dir`. `system_metadata.cwd` in the first session_init frame from Claude matches by construction.
10. Meanwhile tugcast's `FILETREE / FILESYSTEM / GIT` feeds for this workspace start emitting frames with `workspace_key` spliced in. tugdeck sees the new frames via the router.
11. tugdeck awaits the CONTROL ack for `spawn_session`. On success, tugdeck's session bootstrap code calls `cardSessionBindingStore.setBinding("gizmo-42", { tugSessionId: "uuid-abc", workspaceKey: <derived from project_dir>, projectDir: "/home/user/frontend" })`.
12. `Tugcard` for `card_id = "gizmo-42"` re-renders via `useSyncExternalStore`, `useCardWorkspaceKey` now returns the workspace key, `useMemo` rebuilds the filter as a value-check, `FeedStore` is reconstructed with the new filter, and the replay path re-runs the most recent cached frame through it. Card now shows its own project's filetree / git status / filesystem events.

#### End-to-end: close_session and teardown at refcount zero {#flow-close-teardown}

1. Client closes the card. tugdeck calls `encodeCloseSession("gizmo-42")`; CONTROL frame fires.
2. tugcast's handler enters the `close_session` branch.
3. Handler reads the ledger entry for `"gizmo-42"` → finds `workspace_key`, `project_dir`, etc.
4. Handler calls `spawner.spawn_child(...)` cleanup: aborts the bridge task, waits for tugcode exit.
5. Handler calls `store.delete_session_key("gizmo-42")` (best-effort; failure is logged not propagated).
6. Handler calls `registry.release(&workspace_key)`:
    - Acquire mutex.
    - `map.get(&key)` → `Some(entry)`.
    - `entry.ref_count.fetch_sub(1, Relaxed)` → returns `1` (pre-decrement). Post-decrement value is `0`.
    - `entry.cancel.cancel()` — the four spawned tasks observe the token firing and exit their select loops cleanly.
    - `map.remove(&key)` → drops the `Arc<WorkspaceEntry>`; if no other clones exist, the entry drops and with it the `FileWatcher` OS handle (FSEvents/inotify).
    - Release mutex.
    - Return `Ok(())`.
7. If any other session was bound to the same workspace, its `Arc<WorkspaceEntry>` keeps the entry alive; the map slot removal only drops the *map's* handle. The feed tasks continue serving the other session.
8. Handler removes the ledger entry, publishes the `SESSION_STATE` frame with the closed state, and returns.

Tugdeck sees the CONTROL ack and calls `cardSessionBindingStore.clearBinding("gizmo-42")`. Any remaining `Tugcard` for that `card_id` re-renders with `useCardWorkspaceKey` returning `undefined`, the filter falls back to `presentWorkspaceKey`, and the card unmounts shortly after when the close transition completes.

#### End-to-end: rebind_from_tugbank at startup {#flow-rebind}

1. `AgentSupervisor::new` runs at startup. `rebind_from_tugbank` reads every `SessionKeyRecord` from the bank via `store.list_session_records()`.
2. For each `(card_id, record)`:
    - If `record.project_dir == None`: warn-log and skip.
    - If `record.project_dir == Some(path_str)`:
        - Validate existence: `std::fs::metadata(&path_str)`.
        - On `Err`: warn-log with `card_id`, reason, and `path_str`. Skip.
        - On `Ok(m)` with `!m.is_dir()`: warn-log and skip.
        - On `Ok(m)` with `m.is_dir()`: call `registry.get_or_create(&PathBuf::from(path_str), cancel.clone())`.
        - Build a `LedgerEntry` with `workspace_key`, `project_dir`, `tug_session_id = record.tug_session_id`, `claude_session_id = record.claude_session_id`, `crash_budget: CrashBudget::default()`.
        - Insert into the ledger.
3. Return the count of successfully rebound records.
4. Clients that connect after startup and send `spawn_session` for a `card_id` that was successfully rebound find the ledger entry already present; the CONTROL handler short-circuits (`DuplicateCardId` vs "already bound, treat as idempotent" — determined by existing supervisor semantics, not W2's concern).
5. Clients whose records were dropped get "no such session" on any implicit-rebind path and must send a fresh `spawn_session`.

#### End-to-end: tugdeck filter timeline for one card {#flow-tugdeck-filter-timeline}

| Time | Event | `useCardWorkspaceKey("gizmo-42")` returns | `Tugcard` filter | Frames accepted |
|---|---|---|---|---|
| T0 | Card mounts. No binding in store. | `undefined` | `presentWorkspaceKey` (presence check) | Any frame with `workspace_key` present |
| T1 | Card's session bootstrap fires `encodeSpawnSession(..., "/frontend")`. | `undefined` (still) | `presentWorkspaceKey` | Any frame with `workspace_key` |
| T2 | CONTROL ack arrives. `cardSessionBindingStore.setBinding("gizmo-42", { workspaceKey: "/frontend", ... })` fires. | `"/frontend"` | Value check (`decoded.workspace_key === "/frontend"`) | Only frames from this workspace |
| T3 | Frame arrives for `/backend` workspace (e.g. because another card is using it). | `"/frontend"` | Value check | **Rejected** — `/backend !== /frontend` |
| T4 | Card closes. `clearBinding("gizmo-42")` fires. | `undefined` | `presentWorkspaceKey` | Any — but card is unmounting, moot |

Between T1 and T2, a well-timed frame from the bootstrap workspace (or any other workspace) would pass the filter. This is the "unbound window" of risk R04. The mitigation is that at T2 the filter tightens and the replay path re-runs the most recent cached frame through the new filter — so a frame that slipped through at T1 is re-evaluated at T2 and either kept (if `workspace_key` matches) or dropped (if it doesn't). No stale frame survives.

---

### Specification {#specification}

#### Spec S01: `SessionKeyRecord` {#s01-session-key-record}

```rust
// in tugrust/crates/tugcast/src/feeds/session_keys.rs (new) or
// in tugrust/crates/tugcast/src/feeds/agent_supervisor.rs (existing, alongside the trait)

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SessionKeyRecord {
    pub tug_session_id: String,
    #[serde(default)]
    pub project_dir: Option<String>,
    #[serde(default)]
    pub claude_session_id: Option<String>,
}
```

- `tug_session_id` is the routing key; always populated.
- `project_dir` is `Some` for post-W2 records; `None` for pre-W2 legacy blobs (dropped on rebind).
- `claude_session_id` is `None` until P14 starts populating it.
- `#[serde(default)]` on the optional fields lets older readers and writers round-trip without explicit version tagging.

#### Spec S02: `SessionKeysStore` trait (updated) {#s02-session-keys-trait}

```rust
pub trait SessionKeysStore: Send + Sync {
    fn set_session_record(
        &self,
        card_id: &str,
        record: &SessionKeyRecord,
    ) -> Result<(), SessionKeysStoreError>;

    fn delete_session_key(&self, card_id: &str) -> Result<(), SessionKeysStoreError>;

    fn list_session_records(
        &self,
    ) -> Result<Vec<(String, SessionKeyRecord)>, SessionKeysStoreError>;
}
```

Dual-read migration lives in `impl SessionKeysStore for TugbankClient`'s `list_session_records`:

```rust
fn list_session_records(&self) -> Result<Vec<(String, SessionKeyRecord)>, SessionKeysStoreError> {
    let snapshot = self.read_domain(SESSION_KEYS_DOMAIN)
        .map_err(|e| SessionKeysStoreError(e.to_string()))?;
    let mut out = Vec::with_capacity(snapshot.len());
    for (card_id, value) in snapshot {
        let record = match value {
            Value::Json(j) => match serde_json::from_value::<SessionKeyRecord>(j) {
                Ok(r) if !r.tug_session_id.is_empty() => r,
                Ok(_) => { warn!(card_id, "empty tug_session_id; skipping"); continue; }
                Err(e) => { warn!(card_id, error = %e, "failed to parse SessionKeyRecord; skipping"); continue; }
            },
            Value::String(s) if !s.is_empty() => SessionKeyRecord {
                tug_session_id: s,
                project_dir: None,
                claude_session_id: None,
            },
            _ => { warn!(card_id, "non-json non-string session-keys entry; skipping"); continue; }
        };
        out.push((card_id, record));
    }
    Ok(out)
}
```

`set_session_record` writes `Value::Json(serde_json::to_value(record)?)`.

#### Spec S03: `spawn_session` CONTROL payload and success ack (updated) {#s03-spawn-session-payload}

**Request payload:**

```json
{
  "action": "spawn_session",
  "card_id": "string",
  "tug_session_id": "string (UUID)",
  "project_dir": "string (absolute path)"
}
```

All four fields required. Missing `project_dir` → `ControlError::InvalidProjectDir { reason: "missing_project_dir" }`. Parse failure → `ControlError::InvalidProjectDir { reason: "malformed_project_dir" }`.

**Success ack payload:**

```json
{
  "action": "spawn_session_ok",
  "card_id": "string",
  "tug_session_id": "string (UUID)",
  "workspace_key": "string (canonical path)"
}
```

The `workspace_key` field carries the `PathResolver::watch_path()`-canonicalized form of `project_dir` — the exact string tugcast splices as the first field of every FILETREE / FILESYSTEM / GIT frame emitted for this workspace. Tugdeck's `cardSessionBindingStore.setBinding` reads this field from the ack and stores it as the card's `workspaceKey` so the value-check filter built in [S10] matches frames exactly. **Tugdeck does not canonicalize the path itself** — canonicalization includes macOS firmlink resolution and synthetic-firmlink handling that JS path libraries do not match, so any client-side derivation would risk producing a different string than tugcast emits and silently dropping every frame.

**Error ack payload:** emitted via the existing CONTROL error frame path on any validation failure. Payload carries the `ControlError::InvalidProjectDir { reason }` variant with `reason` set to one of the compile-time strings listed in [S05] (`"missing_project_dir"`, `"does_not_exist"`, `"permission_denied"`, `"not_a_directory"`, `"malformed_project_dir"`).

#### Spec S04: `WorkspaceEntry` and `WorkspaceRegistry::release` (updated) {#s04-registry-release}

`WorkspaceEntry` gains one field:

```rust
pub struct WorkspaceEntry {
    pub workspace_key: WorkspaceKey,
    pub project_dir: PathBuf,
    pub fs_watch_rx: watch::Receiver<Frame>,
    pub ft_watch_rx: watch::Receiver<Frame>,
    pub git_watch_rx: watch::Receiver<Frame>,
    pub ft_query_tx: mpsc::Sender<FileTreeQuery>,
    pub file_watcher_task: JoinHandle<()>,
    pub filesystem_task: JoinHandle<()>,
    pub filetree_task: JoinHandle<()>,
    pub git_task: JoinHandle<()>,
    pub cancel: CancellationToken,           // NEW in W2 — retained so release can fire it
    pub ref_count: AtomicUsize,              // NEW in W2
}
```

`WorkspaceEntry::new` initializes `ref_count: AtomicUsize::new(1)` and stores the passed `CancellationToken` on the struct (rather than only cloning it to spawn tasks).

`WorkspaceRegistry::get_or_create`:

```rust
pub fn get_or_create(
    &self,
    project_dir: &Path,
    cancel: CancellationToken,
) -> Result<Arc<WorkspaceEntry>, WorkspaceError> {
    // 1. Validate existence.
    let metadata = std::fs::metadata(project_dir).map_err(|e| WorkspaceError::InvalidProjectDir {
        path: project_dir.to_path_buf(),
        reason: match e.kind() {
            std::io::ErrorKind::NotFound => "does_not_exist",
            std::io::ErrorKind::PermissionDenied => "permission_denied",
            _ => "metadata_error",
        },
    })?;
    if !metadata.is_dir() {
        return Err(WorkspaceError::InvalidProjectDir {
            path: project_dir.to_path_buf(),
            reason: "not_a_directory",
        });
    }

    // 2. Canonicalize.
    let canonical = PathResolver::new(project_dir.to_path_buf())
        .watch_path()
        .to_string_lossy()
        .into_owned();
    let workspace_key = WorkspaceKey(Arc::from(canonical));

    // 3. Held-mutex check-or-construct.
    let mut map = self.inner.lock().expect("WorkspaceRegistry mutex poisoned");
    if let Some(existing) = map.get(&workspace_key) {
        existing.ref_count.fetch_add(1, Ordering::Relaxed);
        return Ok(Arc::clone(existing));
    }
    let entry = WorkspaceEntry::new(project_dir.to_path_buf(), workspace_key.clone(), cancel);
    map.insert(workspace_key, Arc::clone(&entry));
    Ok(entry)
}
```

`WorkspaceRegistry::release`:

```rust
pub fn release(&self, key: &WorkspaceKey) -> Result<(), WorkspaceError> {
    let mut map = self.inner.lock().expect("WorkspaceRegistry mutex poisoned");
    let Some(entry) = map.get(key) else {
        return Err(WorkspaceError::UnknownKey(key.as_ref().to_string()));
    };
    let prev = entry.ref_count.fetch_sub(1, Ordering::Relaxed);
    if prev == 1 {
        // Refcount hit zero. Tear down.
        entry.cancel.cancel();
        map.remove(key);
        // The Arc<WorkspaceEntry> we removed drops here, and with it the
        // FileWatcher OS handle. Spawned tasks see the cancel fire and
        // exit cleanly in the background.
    }
    Ok(())
}
```

#### Spec S05: `spawn_session` handler control flow {#s05-spawn-handler-flow}

```rust
// In agent_supervisor.rs handle_control spawn_session branch (pseudo-code).
async fn handle_spawn_session(&self, payload: SpawnSessionPayload) -> Result<(), ControlError> {
    // Required field: project_dir.
    let project_dir_str = payload.project_dir.ok_or(ControlError::InvalidProjectDir {
        reason: "missing_project_dir",
    })?;
    let project_dir = PathBuf::from(&project_dir_str);

    // Validate + canonicalize + acquire workspace.
    let entry = self.registry
        .get_or_create(&project_dir, self.cancel.clone())
        .map_err(|e| match e {
            WorkspaceError::InvalidProjectDir { reason, .. } => {
                ControlError::InvalidProjectDir { reason }
            }
            WorkspaceError::UnknownKey(_) => unreachable!("get_or_create never returns UnknownKey"),
        })?;
    let workspace_key = entry.workspace_key.clone();

    // Persist the record. On failure, release and propagate.
    let record = SessionKeyRecord {
        tug_session_id: payload.tug_session_id.as_str().to_string(),
        project_dir: Some(project_dir_str.clone()),
        claude_session_id: None,
    };
    if let Err(e) = self.store.set_session_record(&payload.card_id, &record) {
        let _ = self.registry.release(&workspace_key);
        return Err(ControlError::PersistenceFailed(e.to_string()));
    }

    // Insert the ledger entry. On duplicate card_id, release and propagate.
    let ledger_entry = LedgerEntry {
        tug_session_id: payload.tug_session_id,
        claude_session_id: None,
        workspace_key: workspace_key.clone(),
        project_dir: project_dir.clone(),
        crash_budget: CrashBudget::default(),
        // ... existing fields
    };
    if !self.ledger.try_insert(payload.card_id.clone(), ledger_entry) {
        let _ = self.registry.release(&workspace_key);
        return Err(ControlError::DuplicateCardId);
    }

    // Schedule the worker. If scheduling itself fails (it shouldn't — this
    // is tokio::spawn which panics on runtime shutdown), we also release
    // and evict the ledger entry.
    if let Err(e) = self.spawn_session_worker(&payload.card_id).await {
        self.ledger.remove(&payload.card_id);
        let _ = self.registry.release(&workspace_key);
        return Err(e);
    }

    Ok(())
}
```

The three `release` calls are the enforcement of [D05]. Any future error path added to this handler must follow the same pattern.

#### Spec S06: `ChildSpawner::spawn_child` (updated) {#s06-spawn-child-signature}

```rust
#[async_trait]
pub trait ChildSpawner: Send + Sync {
    async fn spawn_child(
        &self,
        project_dir: &Path,
    ) -> Result<ChildHandle, SpawnError>;
}

pub struct TugcodeSpawner {
    tugcode_path: PathBuf,
}

impl TugcodeSpawner {
    pub fn new(tugcode_path: PathBuf) -> Self {
        Self { tugcode_path }
    }
}

#[async_trait]
impl ChildSpawner for TugcodeSpawner {
    async fn spawn_child(&self, project_dir: &Path) -> Result<ChildHandle, SpawnError> {
        let mut cmd = Command::new(&self.tugcode_path);
        cmd.arg("--dir").arg(project_dir);
        // ... existing stdio/env setup
        let child = cmd.spawn().map_err(SpawnError::from)?;
        Ok(ChildHandle::new(child))
    }
}
```

Test doubles update their signatures:
```rust
async fn spawn_child(&self, _project_dir: &Path) -> Result<ChildHandle, SpawnError> {
    // existing body unchanged
}
```

`SpawnerFactory` type alias changes if needed:
```rust
pub type SpawnerFactory = Arc<dyn Fn() -> Arc<dyn ChildSpawner> + Send + Sync>;
```

No more closure over a `project_dir`. `default_spawner_factory` becomes:
```rust
pub fn default_spawner_factory(config: &AgentSupervisorConfig) -> SpawnerFactory {
    let tugcode_path = config.tugcode_path.clone();
    Arc::new(move || Arc::new(TugcodeSpawner::new(tugcode_path.clone())))
}
```

#### Spec S07: `LedgerEntry` new fields {#s07-ledger-entry-fields}

```rust
pub struct LedgerEntry {
    pub tug_session_id: TugSessionId,
    pub claude_session_id: Option<String>,
    pub workspace_key: WorkspaceKey,  // NEW in W2
    pub project_dir: PathBuf,         // NEW in W2
    pub crash_budget: CrashBudget,
    // ... other existing fields unchanged
}
```

`workspace_key` is the `WorkspaceKey` returned by `get_or_create`; `project_dir` is the caller-supplied path *before* canonicalization (the same path that was persisted in the `SessionKeyRecord`). The pre-canonical form is kept because it's what gets passed to `spawner.spawn_child` — Claude's cwd matches the user's intent rather than the `PathResolver`-resolved form, which might differ in the firmlink case.

#### Spec S08: `CardSessionBindingStore` (TypeScript) {#s08-card-session-binding-store}

```typescript
// tugdeck/src/lib/card-session-binding-store.ts (new)

export interface CardSessionBinding {
  readonly tugSessionId: string;
  readonly workspaceKey: string;
  readonly projectDir: string;
}

export class CardSessionBindingStore {
  private _bindings: Map<string, CardSessionBinding> = new Map();
  private _listeners: Array<() => void> = [];

  subscribe = (listener: () => void): (() => void) => {
    this._listeners.push(listener);
    return () => {
      const idx = this._listeners.indexOf(listener);
      if (idx >= 0) this._listeners.splice(idx, 1);
    };
  };

  getSnapshot = (): Map<string, CardSessionBinding> => this._bindings;

  getBinding = (cardId: string): CardSessionBinding | undefined => this._bindings.get(cardId);

  setBinding = (cardId: string, binding: CardSessionBinding): void => {
    // New Map reference so useSyncExternalStore detects the change.
    const next = new Map(this._bindings);
    next.set(cardId, binding);
    this._bindings = next;
    for (const listener of this._listeners) listener();
  };

  clearBinding = (cardId: string): void => {
    if (!this._bindings.has(cardId)) return;
    const next = new Map(this._bindings);
    next.delete(cardId);
    this._bindings = next;
    for (const listener of this._listeners) listener();
  };
}

/** Module-scope singleton — mirrors FeedStore's usage shape. */
export const cardSessionBindingStore = new CardSessionBindingStore();
```

L02 compliance: external state, `subscribe + getSnapshot` pattern, ready for `useSyncExternalStore`.

#### Spec S09: `useCardWorkspaceKey` hook {#s09-use-card-workspace-key}

```typescript
// tugdeck/src/components/tugways/hooks/use-card-workspace-key.ts (new)

import { useSyncExternalStore } from "react";
import { cardSessionBindingStore } from "@/lib/card-session-binding-store";

export function useCardWorkspaceKey(cardId: string): string | undefined {
  return useSyncExternalStore(
    cardSessionBindingStore.subscribe,
    () => cardSessionBindingStore.getBinding(cardId)?.workspaceKey,
  );
}
```

Stability note: `useSyncExternalStore` returns a new result only when the underlying snapshot reference changes. Because `setBinding`/`clearBinding` always create a new `Map`, any state change produces a new snapshot, and `useCardWorkspaceKey` re-runs its inner getter. Between changes, the returned string reference is stable — which is what `useMemo` in `Tugcard` needs for filter identity stability.

#### Spec S10: `Tugcard` filter integration (updated) {#s10-tugcard-filter}

```typescript
// Inside Tugcard, replacing W1's `filter` prop plumbing.
import { useCardWorkspaceKey } from "./hooks/use-card-workspace-key";
import { presentWorkspaceKey } from "../../card-registry";

const workspaceKey = useCardWorkspaceKey(cardId);
const filter: FeedStoreFilter = useMemo(
  () =>
    workspaceKey
      ? (_, decoded) =>
          typeof decoded === "object" &&
          decoded !== null &&
          "workspace_key" in decoded &&
          (decoded as { workspace_key: unknown }).workspace_key === workspaceKey
      : presentWorkspaceKey,
  [workspaceKey],
);
// filter is then passed to `new FeedStore(conn, feedIds, undefined, filter)` or the
// decoder-branch equivalent, exactly as in W1.
```

The `filter` prop on `TugcardProps` is deleted. `DeckCanvas` no longer passes it. `CardRegistration.workspaceKeyFilter` is deleted.

#### Spec S11: `encodeSpawnSession` (updated) {#s11-encode-spawn-session}

```typescript
export function encodeSpawnSession(
  cardId: string,
  tugSessionId: string,
  projectDir: string,
): Frame;
```

Emits:
```json
{
  "action": "spawn_session",
  "card_id": "<cardId>",
  "tug_session_id": "<tugSessionId>",
  "project_dir": "<projectDir>"
}
```

All callsites of `encodeSpawnSession` in tugdeck tests and the session bootstrap code are updated to pass the third argument. Test fixtures use `/tmp/fixture-workspace` (which exists on all dev machines) or a `process.cwd()`-derived path.

---

### Compatibility / Migration / Rollout (Optional) {#rollout}

- **Wire protocol**: `spawn_session` CONTROL payload gains a required `project_dir` field. No versioning flag — the field is additive and required. Old tugdeck + new tugcast rejects the handshake; new tugdeck + old tugcast ignores the unknown field and falls back to `AgentSupervisorConfig::project_dir`. Both mismatches are short cross-step windows during W2 landing; CI catches them on the integration checkpoint.
- **Persistence schema**: `SessionKeysStore` blob bumps from `Value::String` to `Value::Json(SessionKeyRecord)`. Dual-read on `list_session_records` handles legacy records; `rebind_from_tugbank` drops records with `project_dir: None`. No migration script needed — the dual-read is the migration.
- **Rollback**: every step below is a single commit; reverting any step backs out its changes cleanly without corrupting persisted data. The schema bump in Step 1 is forward-safe (new data is forward-readable by old code? no — old code would fail to parse `Value::Json` as `Value::String`). Actually a revert of Step 1 *after* new records have been written would lose the records. **Do not revert Step 1 once post-W2 records have been written to a dev machine's tugbank**; delete the `session_keys` domain from tugbank first.

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tugdeck/src/lib/card-session-binding-store.ts` | `CardSessionBinding`, `CardSessionBindingStore` class, module singleton. [S08] |
| `tugdeck/src/components/tugways/hooks/use-card-workspace-key.ts` | `useCardWorkspaceKey` hook. [S09] |
| `tugdeck/src/__tests__/card-session-binding-store.test.ts` | Unit tests for the store: subscribe notification, setBinding, clearBinding, getSnapshot stability. |
| `tugdeck/src/__tests__/use-card-workspace-key.test.tsx` | Hook test: undefined when unbound, returns workspace key when bound, re-renders on binding change. |

No new Rust files — `SessionKeyRecord` and `WorkspaceError` fit alongside existing types in `agent_supervisor.rs` and `workspace_registry.rs`.

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|---|---|---|---|
| `SessionKeyRecord` | struct | `feeds/agent_supervisor.rs` | [S01] |
| `SessionKeysStore::set_session_record` | trait fn | `feeds/agent_supervisor.rs` | [S02] (rename from `set_session_key`) |
| `SessionKeysStore::list_session_records` | trait fn | `feeds/agent_supervisor.rs` | [S02] (rename from `list_session_keys`) |
| `impl SessionKeysStore for TugbankClient::list_session_records` | fn | `feeds/agent_supervisor.rs` | Dual-read migration body |
| `EphemeralSessionKeysStore` | struct + impl | `main.rs` | **Deleted** [D15] |
| `session_keys_store` construction in `main.rs` | fn body | `main.rs` (startup) | Rewritten: `None` branch → `eprintln!` + `exit(1)` [D15] |
| `impl SessionKeysStore for NoopSessionKeysStore` | impl | `feeds/agent_supervisor.rs` (test) | Updated for new trait |
| `WorkspaceError` | enum | `feeds/workspace_registry.rs` | [D09], [S04] |
| `WorkspaceEntry.ref_count` | field | `feeds/workspace_registry.rs` | [D08], [S04] |
| `WorkspaceEntry.cancel` | field | `feeds/workspace_registry.rs` | [S04] — retained from construction so `release` can fire it |
| `WorkspaceRegistry::get_or_create` | fn | `feeds/workspace_registry.rs` | [S04] — now returns `Result` |
| `WorkspaceRegistry::release` | fn | `feeds/workspace_registry.rs` | [S04] — new |
| `ChildSpawner::spawn_child` | trait fn | `feeds/agent_bridge.rs` | [D10], [S06] |
| `TugcodeSpawner` | struct | `feeds/agent_bridge.rs` | Drops `project_dir` field |
| `default_spawner_factory` | fn | `feeds/agent_supervisor.rs` | Stops closing over `project_dir` |
| `AgentSupervisorConfig::project_dir` | field | `feeds/agent_supervisor.rs` | **Removed** [D12] |
| `LedgerEntry.workspace_key` | field | `feeds/agent_supervisor.rs` | [S07] |
| `LedgerEntry.project_dir` | field | `feeds/agent_supervisor.rs` | [S07] |
| `ControlError::InvalidProjectDir` | variant | `feeds/agent_supervisor.rs` (or wherever ControlError lives) | [S03] |
| `AgentSupervisor::handle_spawn_session` | fn | `feeds/agent_supervisor.rs` | [S05] — refactor existing handler |
| `AgentSupervisor::handle_close_session` | fn | `feeds/agent_supervisor.rs` | Adds `registry.release` call |
| `AgentSupervisor::handle_reset_session` | fn | `feeds/agent_supervisor.rs` | Preserves workspace binding [D11] |
| `AgentSupervisor::rebind_from_tugbank` | fn | `feeds/agent_supervisor.rs` | Reads new record shape, repopulates workspaces |
| `CardRegistration.workspaceKeyFilter` | field | `tugdeck/src/card-registry.ts` | **Removed** [D06] |
| `TugcardProps.filter` | field | `tugdeck/src/components/tugways/tug-card.tsx` | **Removed** [D06] |
| `Tugcard` internals | component | `tugdeck/src/components/tugways/tug-card.tsx` | Calls `useCardWorkspaceKey`, builds filter via `useMemo` [S10] |
| `GalleryPromptInput` internals | component | `tugdeck/src/components/tugways/cards/gallery-prompt-input.tsx` | FeedStore construction moves inside component, uses hook [D06] |
| `encodeSpawnSession` | fn | `tugdeck/src/protocol.ts` | [S11] — third parameter |
| `cardSessionBindingStore` | singleton | `tugdeck/src/lib/card-session-binding-store.ts` | [S08] |
| `useCardWorkspaceKey` | hook | `tugdeck/src/components/tugways/hooks/use-card-workspace-key.ts` | [S09] |

---

### Documentation Plan {#documentation-plan}

- [ ] Update `dash/tide.md` §T3.4.a punch-list banner: mark "per-session cwd" as resolved by T3.0.W2. Remove any remaining "single-session fallback" language from T3.4.a.
- [ ] Update `dash/tugplan-workspace-registry-w1.md` Roadmap / Follow-ons section: mark the "T3.0.W2 dead-code cleanup" and "T3.0.W2 gallery-prompt-input migration" entries as **done** with pointers to the W2 commits.
- [ ] Brief note in `tuglaws/framework-architecture.md` (if it discusses session architecture) describing the three-identifier model (`tug_session_id` / `claude_session_id` / `project_dir`) now that the wire carries all three.
- [ ] No public API docs update — tugcast's CLI surface is unchanged in W2; wire protocol is internal.

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|---|---|---|
| **Unit** | Isolate registry, record, store, and hook behavior | Step 1 schema roundtrip, Step 2 store behavior, Step 5 refcount+teardown |
| **Integration** | Exercise supervisor + registry + spawner together | Step 6 four-tide.md tests + release-on-error + rebind tests |
| **Contract** | Pin wire shapes (CONTROL payload, SessionKeyRecord serde, error frames) | Step 1 contract test for record, Step 6 contract test for error frames |
| **Regression** | Verify W1 behavior is preserved where W2 is off-path | Step 3 fallback-to-presence tests, Step 4 existing-spawner tests |

---

### Execution Steps {#execution-steps}

#### Step 1: `SessionKeysStore` schema bump with dual-read migration; delete `EphemeralSessionKeysStore` {#step-1}

**Commit:** `refactor(tugcast): bump SessionKeysStore to structured SessionKeyRecord`

**References:** [D01] trait rename, [D02] record shape with Option fields, [D03] drop on rebind, [D15] EphemeralSessionKeysStore deleted, Risk R03 (#r03-migration-dual-read), Spec S01 (#s01-session-key-record), Spec S02 (#s02-session-keys-trait)

**Artifacts:**
- New `SessionKeyRecord` struct in `feeds/agent_supervisor.rs` alongside the trait definition.
- Updated `SessionKeysStore` trait: `set_session_record` / `list_session_records` replace the old methods. `delete_session_key` is unchanged.
- Updated impls: `TugbankClient` (dual-read), `NoopSessionKeysStore` (test fixture, `pub(crate)`, retained).
- **Deleted**: `EphemeralSessionKeysStore` struct + `impl SessionKeysStore` block in `main.rs` ([D15]). The tugbank-unavailable branch at `main.rs:327` is rewritten to `eprintln!` + `std::process::exit(1)`.
- Updated call sites: `set_session_key` at `feeds/agent_supervisor.rs:606` → `set_session_record`; `list_session_keys` in `rebind_from_tugbank` at `feeds/agent_supervisor.rs:1037` → `list_session_records` with record destructuring.
- Note: `rebind_from_tugbank` in this step continues to produce the same ledger entries as pre-W2 — it reads the new record shape but doesn't yet touch workspaces. The `project_dir` field is read and logged; dropping on `None` happens when Step 6 teaches rebind to bind workspaces. This keeps Step 1 scoped to "schema only (plus one dead-code deletion)."

**Tasks:**
- [ ] Define `SessionKeyRecord` with serde derives per [S01]. Place it in `feeds/agent_supervisor.rs` just above the trait definition.
- [ ] Rename trait methods per [S02]. Update the trait doc comment to describe the structured value.
- [ ] Rewrite `impl SessionKeysStore for TugbankClient::set_session_record` to serialize the record via `serde_json::to_value`, wrap in `Value::Json`, and pass to `self.set(SESSION_KEYS_DOMAIN, card_id, ...)`.
- [ ] Rewrite `list_session_records` with the dual-read body from [S02]. Keep the existing empty-string and non-string-variant skip logic under warn logs.
- [ ] **Delete** `EphemeralSessionKeysStore` and its `impl SessionKeysStore` block from `main.rs`. Also delete the `use crate::feeds::agent_supervisor::...` line importing it if it has no other users.
- [ ] **Rewrite `main.rs`'s session store construction** ([D15]): replace the `if let Some(ref client) = bank_client { ... } else { warn + Ephemeral }` block with an early-exit on `None`:
  ```rust
  let Some(ref bank_client) = bank_client else {
      eprintln!(
          "tugcast: error: tugbank unavailable at {}, cannot start without persistent session store",
          bank_path.display()
      );
      std::process::exit(1);
  };
  let session_keys_store: Arc<dyn SessionKeysStore> = Arc::clone(bank_client);
  ```
  This matches the TCP-bind-error pattern already in `main.rs`.
- [ ] Update `NoopSessionKeysStore` in `agent_supervisor.rs` test module to implement the new record-shaped trait. This fixture stays — it's a `pub(crate)` test double, not a production fallback.
- [ ] Grep-audit any tests that referenced `EphemeralSessionKeysStore` directly (likely in `integration_tests.rs` or router tests). Rewrite each to use `NoopSessionKeysStore` or a `TempDir`-backed real `TugbankClient`.
- [ ] Update the sole `set_session_key` callsite (line ~606) to build a `SessionKeyRecord` with `tug_session_id = tug_session_id.as_str().to_string()`, `project_dir = None`, `claude_session_id = None`. **These `None` fields are temporary** — Step 6 will change this callsite to populate `project_dir: Some(project_dir_str.clone())`.
- [ ] Update `rebind_from_tugbank` to destructure `(String, SessionKeyRecord)` tuples. For this step, continue building ledger entries from `record.tug_session_id` only; the workspace-binding logic is added in Step 6.
- [ ] Update any tests that construct or consume the old trait methods directly.

**Tests:**
- [ ] `test_session_key_record_serde_roundtrip` — build a record, serialize, deserialize, assert equality.
- [ ] `test_session_key_record_defaults_on_missing_optional_fields` — parse `{"tug_session_id": "abc"}` and assert `project_dir == None`, `claude_session_id == None`.
- [ ] `test_tugbank_list_session_records_reads_legacy_string` — construct a `Value::String("legacy-uuid")` blob via `TugbankClient::set` directly, call `list_session_records`, assert exactly one entry with `tug_session_id == "legacy-uuid"`, `project_dir == None`, `claude_session_id == None`.
- [ ] `test_tugbank_list_session_records_reads_json` — write a `SessionKeyRecord` via `set_session_record`, read back via `list_session_records`, assert round-trip equality.
- [ ] `test_tugbank_list_session_records_skips_malformed_json` — construct `Value::Json(serde_json::json!({"bogus": 1}))` directly, assert `list_session_records` logs a warn and returns an empty vec.

**Checkpoint:**
- [ ] `cd tugrust && cargo build -p tugcast` — clean under `-D warnings`.
- [ ] `cd tugrust && cargo nextest run -p tugcast` — green; no regressions in supervisor or router tests.

---

#### Step 2: Tugdeck `CardSessionBindingStore` and `useCardWorkspaceKey` hook {#step-2}

**Depends on:** #step-1

**Commit:** `feat(tugdeck): add CardSessionBindingStore and useCardWorkspaceKey hook`

**References:** [D06] store + hook binding, [D13] standalone store, [D14] hook placement, Spec S08 (#s08-card-session-binding-store), Spec S09 (#s09-use-card-workspace-key)

**Artifacts:**
- New file `tugdeck/src/lib/card-session-binding-store.ts` per [S08].
- New file `tugdeck/src/components/tugways/hooks/use-card-workspace-key.ts` per [S09].
- New test file `tugdeck/src/__tests__/card-session-binding-store.test.ts`.
- New test file `tugdeck/src/__tests__/use-card-workspace-key.test.tsx`.
- No consumers yet — Step 3 wires `Tugcard` and `GalleryPromptInput`.

**Tasks:**
- [ ] Create `card-session-binding-store.ts` with the `CardSessionBindingStore` class and the `cardSessionBindingStore` singleton export.
- [ ] Create `use-card-workspace-key.ts` with the hook, importing the singleton and using `useSyncExternalStore`.
- [ ] Unit-test the store: `setBinding` notifies subscribers, `getSnapshot` returns a new map reference only on state changes, `clearBinding` is a no-op for unknown card IDs, `clearBinding` on a bound card ID notifies subscribers.
- [ ] Hook test: mount a test component that calls `useCardWorkspaceKey("test-card")`, assert it returns `undefined` initially, call `setBinding` externally, assert the component re-renders with the new value, call `clearBinding`, assert `undefined`.

**Tests:**
- [ ] `test_binding_store_set_notifies_listeners`
- [ ] `test_binding_store_set_replaces_existing_binding`
- [ ] `test_binding_store_clear_notifies_listeners`
- [ ] `test_binding_store_clear_unknown_is_noop`
- [ ] `test_binding_store_snapshot_is_stable_between_changes`
- [ ] `test_use_card_workspace_key_returns_undefined_when_unbound`
- [ ] `test_use_card_workspace_key_returns_key_when_bound`
- [ ] `test_use_card_workspace_key_rerenders_on_binding_change`

**Checkpoint:**
- [ ] `cd tugdeck && bun run check` — tsc clean.
- [ ] `cd tugdeck && bun test src/__tests__/card-session-binding-store.test.ts src/__tests__/use-card-workspace-key.test.tsx` — green.

---

#### Step 3: Refactor `Tugcard` + `gallery-prompt-input` to consume the hook; remove W1 filter plumbing {#step-3}

**Depends on:** #step-2

**Commit:** `refactor(tugdeck): route workspace filter through useCardWorkspaceKey`

**References:** [D06] store + hook binding, [D07] fallback to presentWorkspaceKey, Risk R04 (#r04-unbound-window), Spec S10 (#s10-tugcard-filter)

**Artifacts:**
- Modified `tugdeck/src/components/tugways/tug-card.tsx`: `TugcardProps.filter` deleted; `Tugcard` body calls `useCardWorkspaceKey(cardId)` and builds a `useMemo`-stable filter with fallback to `presentWorkspaceKey`.
- Modified `tugdeck/src/components/chrome/deck-canvas.tsx`: the `filter={registration.workspaceKeyFilter}` prop pass on the `<Tugcard>` JSX is deleted.
- Modified `tugdeck/src/card-registry.ts`: `CardRegistration.workspaceKeyFilter` field removed. `presentWorkspaceKey` export retained (now consumed by `Tugcard` and `GalleryPromptInput` directly).
- Modified `tugdeck/src/components/tugways/cards/git-card.tsx`: `workspaceKeyFilter: presentWorkspaceKey` line removed from `registerGitCard`.
- Modified `tugdeck/src/components/tugways/cards/gallery-prompt-input.tsx`: the module-scope `getFileCompletionProvider` + `_fileCompletionProvider` singleton pattern is refactored. `FeedStore` construction moves inside `GalleryPromptInput` using `useMemo` + `useEffect` cleanup, gated on `useCardWorkspaceKey(cardId)`. `cardId` is passed in from the parent (the registration's `contentFactory` already receives it).
- Updated test file: `tugdeck/src/__tests__/tugcard.test.tsx` loses the `filter` prop path, gains a fallback-when-unbound assertion.

**Tasks:**
- [ ] Edit `tug-card.tsx`: remove `FeedStoreFilter` import reference for the prop; import from `./hooks/use-card-workspace-key` and `../../card-registry`; destructure `cardId` from props (already present); call `useCardWorkspaceKey(cardId)`; wrap the filter in `useMemo([workspaceKey], ...)` per [S10]; pass the memoized filter into both `new FeedStore(...)` branches; delete `filter?: FeedStoreFilter` from `TugcardProps`; remove `filter` from the destructured props list.
- [ ] Edit `deck-canvas.tsx`: delete the `filter={registration.workspaceKeyFilter}` line from the `<Tugcard>` JSX.
- [ ] Edit `card-registry.ts`: delete `workspaceKeyFilter?: FeedStoreFilter` from `CardRegistration`. **Retain** the `presentWorkspaceKey` export — both `Tugcard` and `GalleryPromptInput` import it as the fallback. Update the doc comment to describe it as "fallback filter used when a card is unbound."
- [ ] Edit `git-card.tsx`: remove the `workspaceKeyFilter: presentWorkspaceKey` line from `registerGitCard`.
- [ ] Edit `gallery-prompt-input.tsx`: delete the module-scope `_fileTreeStore` / `_fileCompletionProvider` singletons and `getFileCompletionProvider` function. Inside `GalleryPromptInput`, use `useMemo` to build a `CompletionProvider` from a per-instance `FeedStore`. The `useMemo` depends on `[connection, workspaceKey]` so it rebuilds when either changes. A `useEffect` cleanup disposes the `FeedStore` on unmount. `cardId` is passed from the parent — if the existing component doesn't already receive it, thread it through the registration's `contentFactory`.
- [ ] Update `tugcard.test.tsx`: drop any test case that passes a `filter` prop; add a test case that mounts a `Tugcard` with an unbound `cardId`, sends a frame carrying an arbitrary `workspace_key`, and asserts the card receives it (presence fallback). Add another case: call `cardSessionBindingStore.setBinding(cardId, { workspaceKey: "/a", ... })`, send a frame with `workspace_key: "/a"`, assert accepted; send a frame with `workspace_key: "/b"`, assert rejected.

**Tests:**
- [ ] `test_tugcard_filter_falls_back_to_presence_when_unbound` (new)
- [ ] `test_tugcard_filter_value_checks_when_bound` (new)
- [ ] `test_tugcard_filter_rejects_other_workspace_when_bound` (new)
- [ ] All existing `tugcard.test.tsx` assertions continue to pass (W1 behavior preserved).
- [ ] `test_gallery_prompt_input_filters_by_workspace` — mount the component with a bound card, feed the filetree, assert results come from the bound workspace only.

**Checkpoint:**
- [ ] `cd tugdeck && bun run check` — tsc clean.
- [ ] `cd tugdeck && bun test` — full tugdeck suite green.

---

#### Step 4: `ChildSpawner::spawn_child` takes `&Path`; `TugcodeSpawner` becomes stateless {#step-4}

**Depends on:** #step-3

**Commit:** `refactor(tugcast): make ChildSpawner::spawn_child take per-call project_dir`

**References:** [D10] `&Path` param, [D12] supervisor config deletion (prepared), Risk R05 (#r05-spawner-trait-ripple), Spec S06 (#s06-spawn-child-signature)

**Artifacts:**
- Modified `feeds/agent_bridge.rs`: `ChildSpawner::spawn_child` trait signature changes to `async fn spawn_child(&self, project_dir: &Path) -> Result<ChildHandle, SpawnError>`. `TugcodeSpawner` drops its `project_dir` field; `spawn_child` body reads the arg and calls `Command::new(&self.tugcode_path).arg("--dir").arg(project_dir)`.
- Modified `feeds/agent_supervisor.rs`: `default_spawner_factory` stops closing over `project_dir`; reads only `tugcode_path` from `AgentSupervisorConfig` (the field stays for this step).
- Updated test doubles (in whatever modules contain `StallSpawner`, `CrashingSpawner`, `ScriptedSpawner`): each `spawn_child` signature gains `_project_dir: &Path`, bodies unchanged.
- Updated callers of `spawner.spawn_child(...)`: `spawn_session_worker` is the primary one; it reads `ledger_entry.project_dir` — **but `LedgerEntry.project_dir` doesn't exist until Step 6**. For this step, callers use a stand-in `AgentSupervisorConfig::project_dir` reference to keep compilation working. Step 6 replaces the stand-in with `ledger_entry.project_dir`.
- `AgentSupervisorConfig::project_dir` **remains** in this step — it's the bridge between the old global and the new per-session path. Step 6 deletes it.

**Tasks:**
- [ ] Grep-inventory: `rg -n 'impl ChildSpawner' tugrust/crates/tugcast` to find every implementor. Confirm the list matches the artifacts list above.
- [ ] Edit the trait in `agent_bridge.rs`; update the doc comment for `spawn_child` to describe the per-call `project_dir`.
- [ ] Edit `TugcodeSpawner`: delete the `project_dir` field, delete it from `TugcodeSpawner::new`, update `spawn_child` to use the argument.
- [ ] Edit `default_spawner_factory` in `agent_supervisor.rs`: factory closure now builds `TugcodeSpawner::new(tugcode_path.clone())` — no path capture beyond `tugcode_path`.
- [ ] Update every test double's `spawn_child` signature with `_project_dir: &Path`. Confirm no test currently asserts anything about the `project_dir` value (which it couldn't, because the trait didn't carry one). If any test needs to assert the spawner received a specific path, add that assertion via a new `Arc<Mutex<Option<PathBuf>>>` capture field on the double.
- [ ] Update `spawn_session_worker`'s call site — read `supervisor.config.project_dir` for now (stand-in). Add an inline comment: `// Replaced in W2 Step 6 with ledger_entry.project_dir`.

**Tests:**
- [ ] `test_tugcode_spawner_passes_project_dir_to_command` — construct a `TugcodeSpawner`, call `spawn_child(&PathBuf::from("/tmp/test"))`, observe the constructed `Command` args contain `--dir /tmp/test`. (Use the fake-Command technique from existing spawner tests, or spawn a stub binary.)
- [ ] `test_default_spawner_factory_does_not_close_over_path` — build a factory with `AgentSupervisorConfig { project_dir: "/A", tugcode_path: ... }`, call `spawn_child(&PathBuf::from("/B"))`, assert the command uses `/B`. Belt-and-suspenders for the decoupling.
- [ ] Existing `test_spawn_session_*` tests continue to pass unchanged (the stand-in uses the same `supervisor.config.project_dir` they've always used).

**Checkpoint:**
- [ ] `cd tugrust && cargo build -p tugcast` — clean under `-D warnings`.
- [ ] `cd tugrust && cargo nextest run -p tugcast` — green (all existing supervisor tests still pass with the stand-in).

---

#### Step 5: `WorkspaceRegistry::release` with refcount + teardown {#step-5}

**Depends on:** #step-4

**Commit:** `feat(tugcast): add WorkspaceRegistry::release with refcount teardown`

**References:** [D08] refcount on entry, [D09] WorkspaceError enum, Risk R01 (#r01-teardown-race), Spec S04 (#s04-registry-release)

**Artifacts:**
- Modified `feeds/workspace_registry.rs`:
  - New `WorkspaceError` enum per [D09].
  - `WorkspaceEntry` gains `ref_count: AtomicUsize` and `cancel: CancellationToken` (retained from construction).
  - `WorkspaceEntry::new` initializes `ref_count: AtomicUsize::new(1)` and stores the passed `CancellationToken` on the struct.
  - `get_or_create` return type becomes `Result<Arc<WorkspaceEntry>, WorkspaceError>`. Body gains the `std::fs::metadata` validation and the `existing.ref_count.fetch_add(1, Relaxed)` on map hit, per [S04].
  - New `release(&self, &WorkspaceKey) -> Result<(), WorkspaceError>` method per [S04].
  - Delete the per-field `#[allow(dead_code)]` on the four task handles — `release` reads `entry.cancel`, but the task handles themselves are still not read. **Actually**: the task handles are still unread in this step because `release` only cancels via the token and then drops the Arc; the tasks exit on their own without being joined. Keep the allows on the task handles; Step 6 may choose to explicitly `.abort()` and `.await` them via `release`, at which point the allows come off. For now, Step 5 removes the allows on `workspace_key` and `project_dir` (which were never read even in W1) only if the supervisor in Step 6 reads them — actually Step 5 does NOT touch those allows because Step 5 doesn't touch the supervisor. **Clarification**: Step 5 touches only `workspace_registry.rs`. No `#[allow(dead_code)]` cleanup in this step; that happens in Step 6 when the supervisor starts reading the fields.
- Modified `main.rs`: the W1 bootstrap `get_or_create(&watch_dir, cancel.clone())` call now needs a `.expect("bootstrap workspace must be valid")` or equivalent because the return type is `Result`. Any other effect on main.rs is limited to this one line.
- Updated W1 tests: `test_workspace_registry_bootstrap_construction` and `test_workspace_registry_deduplicates_canonical_paths` both need `.expect(...)` or `?` to unwrap the new `Result`. Fixture keys are paths that always exist (TempDir), so `.expect` is fine.

**Tasks:**
- [ ] Define `WorkspaceError` per [D09] at the top of `workspace_registry.rs` (or in a dedicated error module if the file grows).
- [ ] Add `ref_count: AtomicUsize` and `cancel: CancellationToken` fields to `WorkspaceEntry`. Initialize both in `WorkspaceEntry::new` — `ref_count` to 1, `cancel` to the passed token (not a clone — the stored one).
- [ ] Rewrite `get_or_create` with the validation + held-mutex check-or-construct flow from [S04]. Change the return type and propagate it to the single bootstrap call in `main.rs`.
- [ ] Implement `release` per [S04]. Use `fetch_sub(1, Relaxed)` and inspect the pre-decrement return value.
- [ ] Update W1 tests: `test_workspace_registry_bootstrap_construction` — unwrap the `Result`, assert `entry.ref_count.load(Relaxed) == 1`; `test_workspace_registry_deduplicates_canonical_paths` — unwrap both `get_or_create` calls, assert both returns are `Arc::ptr_eq`, assert `ref_count == 2` on the entry.

**Tests:**
- [ ] `test_get_or_create_bumps_existing_refcount` — fresh registry, two `get_or_create` calls with the same (canonical) path, assert post-state `ref_count == 2`, `Arc::ptr_eq` true, map length 1.
- [ ] `test_release_decrements_refcount` — bump refcount to 2 via two `get_or_create`s, call `release` once, assert `ref_count == 1`, map still contains the entry.
- [ ] `test_release_triggers_teardown_at_zero` — single `get_or_create`, call `release`, assert map length 0. Wait a bounded timeout; assert the four task handles complete (use `JoinHandle::now_or_never` in a loop, or poll `.is_finished()`).
- [ ] `test_release_unknown_key_returns_error` — fresh registry, call `release(&random_key)`, assert `Err(WorkspaceError::UnknownKey(_))`.
- [ ] `test_get_or_create_rejects_nonexistent_path` — call `get_or_create(&PathBuf::from("/nonexistent/xyz"))`, assert `Err(WorkspaceError::InvalidProjectDir { reason: "does_not_exist", .. })`.
- [ ] `test_get_or_create_rejects_file_path` — create a `TempDir`, create a regular file inside, call `get_or_create(&file_path)`, assert `Err(WorkspaceError::InvalidProjectDir { reason: "not_a_directory", .. })`.
- [ ] `test_concurrent_get_or_create_serializes_construction` — spawn two threads, both calling `get_or_create` on the same canonical path concurrently, assert exactly one construction occurred (map length 1) and `ref_count == 2`. (Use `Arc::strong_count` or a construction counter to verify.)

**Checkpoint:**
- [ ] `cd tugrust && cargo build -p tugcast` — clean under `-D warnings`.
- [ ] `cd tugrust && cargo nextest run -p tugcast feeds::workspace_registry` — all new and updated tests green.
- [ ] `cd tugrust && cargo nextest run -p tugcast` — full tugcast suite green.

---

#### Step 6: Supervisor lifecycle hooks — spawn/close/reset/rebind through the registry {#step-6}

**Depends on:** #step-5

**Commit:** `feat(tugcast): bind sessions to per-workspace feeds via spawn_session project_dir`

**References:** [D03] drop on rebind, [D04] validate before canonicalize, [D05] release on error, [D11] reset preserves workspace, [D12] supervisor config deletion, Risk R02 (#r02-refcount-leak), Risk R01 (#r01-teardown-race), Risk R06 (unknown-key on close), Spec S03 (#s03-spawn-session-payload), Spec S05 (#s05-spawn-handler-flow), Spec S07 (#s07-ledger-entry-fields)

**Artifacts:**
- Modified `feeds/agent_supervisor.rs`:
  - `LedgerEntry` gains `workspace_key: WorkspaceKey` and `project_dir: PathBuf` fields ([S07]).
  - `AgentSupervisorConfig::project_dir` field deleted ([D12]). `main.rs` no longer sets it.
  - `ControlError` (or whatever enum holds CONTROL errors) gains `InvalidProjectDir { reason: &'static str }` variant.
  - `SpawnSessionPayload` (or the serde struct deserializing the CONTROL frame) gains `project_dir: Option<String>`. The handler returns `InvalidProjectDir { reason: "missing_project_dir" }` on `None`.
  - `handle_spawn_session` (rename the existing handler if needed) implements the flow from [S05]: validate payload, call `registry.get_or_create`, build ledger entry, persist record, insert ledger entry, schedule worker. Every error path after a successful `get_or_create` calls `release` before returning.
  - `handle_close_session` calls `registry.release(&ledger_entry.workspace_key)` after aborting the tugcode subprocess and before removing the ledger entry. Errors from `release` (unknown key on double-close) are logged, not propagated.
  - `handle_reset_session` does NOT call `release` or `get_or_create` ([D11]). It aborts and respawns tugcode with `ledger_entry.project_dir`.
  - `rebind_from_tugbank` iterates `list_session_records`, drops records per [D03], validates existence for each surviving record, calls `get_or_create`, and builds the ledger entry with `workspace_key` + `project_dir`.
  - `set_session_record` callsite (from Step 1) now passes `project_dir: Some(project_dir_str.clone())`.
- Modified `main.rs`: `AgentSupervisorConfig` literal drops `project_dir`. The W1 bootstrap `registry.get_or_create(&watch_dir, cancel.clone())` remains — the bootstrap workspace stays alive as a keepalive until W3 removes it.
- Modified tests: any test constructing `AgentSupervisorConfig` drops the field; any test building a CONTROL `spawn_session` payload adds `project_dir` (tests use `TempDir` or the workspace-root `env!("CARGO_MANIFEST_DIR")`).
- `#[allow(dead_code)]` on `WorkspaceEntry.workspace_key` and `WorkspaceEntry.project_dir` removed — the supervisor now reads both via `release` (for `workspace_key`) and via `handle_reset_session` (for `project_dir`).
- `#[allow(dead_code)]` on the four `JoinHandle` fields remains for now — Step 5's `release` teardown drops the Arc, which lets the tasks exit cleanly, but the fields themselves are still not read. The allows come off only when something explicitly `.abort()`s and `.await`s them. Flag this as "no cleanup in W2" with a roadmap note.

**Tasks:**
- [ ] Update `LedgerEntry` struct with the two new fields. Update the constructor call sites (`LedgerEntry::new` or literal construction in `handle_control`).
- [ ] Add `InvalidProjectDir { reason }` variant to the CONTROL error enum. Wire it to the existing error-frame encoder.
- [ ] Update `SpawnSessionPayload` to deserialize `project_dir: Option<String>`. Reject `None` with `InvalidProjectDir { reason: "missing_project_dir" }`.
- [ ] Rewrite `handle_spawn_session` per [S05]. Review the diff for release-on-error coverage — every `?` / `return Err(...)` after the successful `get_or_create` must have a `let _ = self.registry.release(&workspace_key);` above it.
- [ ] **Extend the success-path CONTROL ack** to include the canonical `workspace_key` string per [S03]. The value comes from `entry.workspace_key.as_ref()` on the `Arc<WorkspaceEntry>` returned by `get_or_create`. Update the ack serde struct (or the inline JSON construction, whichever the current code uses) to add the field. This is what lets tugdeck's `CardSessionBindingStore` populate the per-card `workspaceKey` with the exact string tugcast splices into frames, so the value-check filter built in [S10] matches exactly.
- [ ] Update `handle_close_session` to call `release` before clearing the ledger entry.
- [ ] Update `handle_reset_session` to preserve the workspace binding (read `ledger_entry.project_dir` for the respawn, do not call release/get_or_create).
- [ ] Update `rebind_from_tugbank` per [S07]-rebind flow: skip records with `project_dir == None`; validate each surviving path; call `get_or_create`; build ledger entries.
- [ ] Delete `AgentSupervisorConfig::project_dir`. Grep for every reference; every one either read it (replace with the per-session path) or set it (delete the line).
- [ ] Update `main.rs` bootstrap: delete the `project_dir:` line from the `AgentSupervisorConfig` literal.
- [ ] Remove `#[allow(dead_code)]` from `WorkspaceEntry.workspace_key` and `WorkspaceEntry.project_dir` in `workspace_registry.rs`. Leave the four task-handle allows in place for now.

**Tests:**
- [ ] `test_two_sessions_two_workspaces` — spawn two sessions with `TempDir::new()` → two distinct paths. Assert two distinct `WorkspaceEntry`s via `Arc::ptr_eq` negative. Assert each session's `LedgerEntry.workspace_key` differs. Assert FILETREE frames observed for each session carry distinct `workspace_key` values.
- [ ] `test_two_sessions_same_project_share_workspace` — spawn two sessions with the same `TempDir`. Assert `Arc::ptr_eq` true. Assert `ref_count == 2`. Close one, assert the workspace entry is still in the map. Close the other, assert the entry is gone.
- [ ] `test_workspace_teardown_on_last_session_close` — spawn one session, assert entry present. Close it. Assert the entry is removed from the registry map and `cancel` fired (observable via watching the feed tasks exit, or via a side-channel flag).
- [ ] `test_spawn_session_rejects_invalid_project_dir` — spawn with `/nonexistent/xyz`. Assert CONTROL error frame emitted with reason `"does_not_exist"`. Assert the ledger entry was NOT inserted. Assert the registry map is unchanged.
- [ ] `test_spawn_session_rejects_missing_project_dir` — spawn with a payload that omits `project_dir` (construct the CONTROL frame manually without the field). Assert `InvalidProjectDir { reason: "missing_project_dir" }`.
- [ ] `test_spawn_session_rejects_file_as_project_dir` — create a file inside a TempDir, spawn with the file path. Assert `InvalidProjectDir { reason: "not_a_directory" }`.
- [ ] `test_spawn_session_release_on_tugcode_failure` — inject a `CrashingSpawner`, spawn a session. Assert the CONTROL error frame fires, the registry map is empty, and `ref_count` is not leaked.
- [ ] `test_spawn_session_success_ack_includes_workspace_key` — spawn a session with a `TempDir`, assert the success CONTROL ack frame carries a `workspace_key` field whose value equals the `PathResolver::watch_path()`-canonicalized form of the `TempDir`. This is the belt-and-suspenders test for [S03]'s success payload contract.
- [ ] `test_close_session_without_workspace` — close a session whose ledger entry has a workspace_key pointing at a nonexistent key (simulate a race by manually deleting the entry from the map first). Assert `release` returns `Err(UnknownKey)` and the handler logs and continues.
- [ ] `test_reset_session_preserves_workspace` — spawn, reset, assert the `Arc<WorkspaceEntry>` pre- and post-reset is `Arc::ptr_eq`-equal.
- [ ] `test_rebind_drops_records_without_project_dir` — pre-populate tugbank with a `SessionKeyRecord { tug_session_id: "abc", project_dir: None, claude_session_id: None }`, call `rebind_from_tugbank`, assert no ledger entry created, assert a warn log matching the drop pattern.
- [ ] `test_rebind_drops_records_with_missing_path` — pre-populate a record with `project_dir: Some("/nonexistent/xyz")`, call rebind, assert dropped with warn.
- [ ] `test_rebind_restores_workspace_entries_from_records` — pre-populate a record with a valid `TempDir`, call rebind, assert a `WorkspaceEntry` exists in the registry and a `LedgerEntry` exists in the ledger with matching `workspace_key` and `project_dir`.

**Checkpoint:**
- [ ] `cd tugrust && cargo build -p tugcast` — clean under `-D warnings`.
- [ ] `cd tugrust && cargo nextest run -p tugcast` — full suite green.
- [ ] `rg 'AgentSupervisorConfig::project_dir' tugrust/crates/tugcast/src` — zero results.

---

#### Step 7: Tugdeck wire update — `encodeSpawnSession` signature + binding store population {#step-7}

**Depends on:** #step-6

**Commit:** `feat(tugdeck): send project_dir on spawn_session and populate binding store`

**References:** [D06] store + hook binding, Spec S11 (#s11-encode-spawn-session), Spec S08 (#s08-card-session-binding-store), (#flow-spawn-new-workspace)

**Artifacts:**
- Modified `tugdeck/src/protocol.ts`: `encodeSpawnSession(cardId, tugSessionId, projectDir): Frame` per [S11].
- Modified wherever tugdeck currently calls `encodeSpawnSession`: the call site reads its workspace path from wherever the tugdeck session-bootstrap flow holds it (for W2, an integration-test-only constant; T3.4.c will replace this with a real UI affordance).
- Modified tugdeck session bootstrap code: on successful CONTROL ack for `spawn_session`, call `cardSessionBindingStore.setBinding(cardId, { tugSessionId, workspaceKey, projectDir })`. The `workspaceKey` value is **read directly from the ack payload's `workspace_key` field** (echoed by tugcast-side `handle_spawn_session` per [S03]). Tugdeck does not attempt to canonicalize the path client-side — canonicalization includes macOS firmlink handling that JS path libraries do not match, so any client-side derivation would risk producing a different string than tugcast splices into frames.
- Modified tugdeck close-session handling: on successful `close_session` CONTROL ack, call `cardSessionBindingStore.clearBinding(cardId)`.
- Updated `tugdeck/src/__tests__/protocol.test.ts`: `encodeSpawnSession` tests pass a third argument; assert the frame payload has `project_dir`.
- Updated any existing tugdeck test that constructs a CONTROL `spawn_session` frame — add the third argument.
- New integration test: `tugdeck/src/__tests__/spawn-session-binding-flow.test.ts` — mock the CONTROL ack path, fire a successful spawn, assert the binding store is populated; fire a failure, assert the binding store is not populated.

**Tasks:**
- [ ] Update `encodeSpawnSession` signature and body to include `project_dir` in the JSON payload.
- [ ] Grep for `encodeSpawnSession(` call sites in tugdeck non-test code. For each, identify where the workspace path comes from in the current code. For W2's integration tests, use `process.cwd()` or a test-fixture constant as the value.
- [ ] Wire `cardSessionBindingStore.setBinding` into the successful-spawn CONTROL ack handler. The binding's `workspaceKey` is read directly from the ack payload's `workspace_key` field (echoed by tugcast per [S03], wired in Step 6).
- [ ] Wire `cardSessionBindingStore.clearBinding` into the successful-close handler.
- [ ] Update existing tests that call `encodeSpawnSession` to pass a third argument.
- [ ] New test file for the binding-store population flow.

**Tests:**
- [ ] `test_encode_spawn_session_includes_project_dir` (new, in `protocol.test.ts`)
- [ ] `test_spawn_session_success_populates_binding_store` (new integration test)
- [ ] `test_spawn_session_failure_does_not_populate_binding_store`
- [ ] `test_close_session_clears_binding`
- [ ] `test_tugcard_receives_filtered_frames_after_binding` — end-to-end mock: mount a card, fire a successful spawn, inject frames with matching and non-matching workspace_keys, assert the card accepts only the matching ones.

**Checkpoint:**
- [ ] `cd tugdeck && bun run check` — tsc clean.
- [ ] `cd tugdeck && bun test` — full tugdeck suite green.

---

#### Step 8: Integration checkpoint — end-to-end verification {#step-8}

**Depends on:** #step-1, #step-2, #step-3, #step-4, #step-5, #step-6, #step-7

**Commit:** `N/A (verification only)`

**References:** [D12] supervisor config deletion, (#success-criteria), (#exit-criteria), Risk R07 (#r07-concurrent-same-project)

**Artifacts:**
- No code changes. Verification only.

**Tasks:**
- [x] `cd tugrust && cargo nextest run` — full workspace green (1115 tests, 0 failures, verified via `just ci`).
- [x] `cd tugrust && cargo build --workspace` — clean under `-D warnings`.
- [x] `cd tugdeck && bun run check && bun test` — full tugdeck green (1942 tests, 0 failures).
- [x] Grep verification: `rg 'AgentSupervisorConfig::project_dir' tugrust/crates/tugcast/src` — zero real matches (only a historical comment reference in `agent_supervisor.rs`).
- [x] Grep verification: `rg 'presentWorkspaceKey' tugdeck/src/components/tugways/cards` — only `tug-card.tsx` and `gallery-prompt-input.tsx` reference it as a fallback import (not as a registration field).
- [ ] ~~Manual A/B smoke in Tug.app~~ — **Deferred to [T3.4.c](../dash/tide.md#t3-4-c-tide-card)**. As of 2026-04-14 there is no UI affordance to pick a `project_dir` at card-open time (W2 hard-codes the test fixture). Manual two-workspace smoke cannot be exercised until T3.4.c lands the Tide card with a real picker. Per tide.md's [Execution Order](../dash/tide.md#execution-order-w2-to-tide), this is accepted as known gap for W2 closeout.

**Tests:**
- [x] Full Rust workspace nextest run green.
- [x] Full tugdeck bun test run green.

**Checkpoint:**
- [ ] ~~Manual smoke checklist captured in the PR description~~ — deferred to T3.4.c.
- [x] All *automated* exit criteria in [#exit-criteria] are checked; the one manual criterion (#11) is deferred.

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** A merged branch that lands the `SessionKeysStore` schema bump, `WorkspaceRegistry::release` with refcount teardown, per-session `project_dir` on the `spawn_session` CONTROL payload, `LedgerEntry.workspace_key` and `LedgerEntry.project_dir`, deletion of `AgentSupervisorConfig::project_dir`, the tugdeck `CardSessionBindingStore` and `useCardWorkspaceKey` hook, refactored `Tugcard` and `GalleryPromptInput` that consume the hook, and a working two-workspace smoke in Tug.app.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [x] **Criterion 1** — `cd tugrust && cargo nextest run` full-workspace green. (verified: `just ci` 1115 tests pass)
- [x] **Criterion 2** — `cd tugdeck && bun test` full-suite green. (verified: `just ci` 1942 tests pass)
- [x] **Criterion 3** — `rg 'AgentSupervisorConfig::project_dir' tugrust/crates/tugcast/src` returns zero real matches (only a historical comment reference remains).
- [x] **Criterion 4** — `test_two_sessions_two_workspaces` passes. *(landed as `test_two_sessions_two_workspaces_do_not_share`.)*
- [x] **Criterion 5** — `test_two_sessions_same_project_share_workspace` passes. *(landed as `test_two_sessions_same_workspace_share_entry`.)*
- [x] **Criterion 6** — `test_workspace_teardown_on_last_session_close` passes. *(coverage: `test_close_session_releases_workspace` + `test_release_triggers_teardown_at_zero`.)*
- [x] **Criterion 7** — `test_spawn_session_rejects_invalid_project_dir` passes. *(coverage split into `test_spawn_session_rejects_missing_project_dir`, `test_spawn_session_rejects_nonexistent_project_dir`, and `test_spawn_session_rejects_file_as_project_dir`.)*
- [x] **Criterion 8** — `test_rebind_drops_records_without_project_dir` passes.
- [x] **Criterion 9** — `test_rebind_restores_workspace_entries_from_records` passes.
- [x] **Criterion 10** — `test_spawn_session_release_on_tugcode_failure` passes. *(coverage: `test_spawn_session_releases_on_persistence_failure` + `test_spawn_session_reconnect_releases_refcount`.)*
- [ ] ~~**Criterion 11**~~ — **Deferred to [T3.4.c](../dash/tide.md#t3-4-c-tide-card).** Manual two-workspace A/B smoke in Tug.app cannot be run until the Tide card lands a real `project_dir` picker; see Step 8 note above and tide.md's [Execution Order](../dash/tide.md#execution-order-w2-to-tide).
- [x] **Criterion 12** — Workspace builds clean under `-D warnings` on every intermediate commit. (verified: per-step `cargo build` + final `just ci`)

**Acceptance tests:**
- [ ] `test_session_key_record_serde_roundtrip`
- [ ] `test_tugbank_list_session_records_reads_legacy_string`
- [ ] `test_tugbank_list_session_records_reads_json`
- [ ] `test_get_or_create_bumps_existing_refcount`
- [ ] `test_release_decrements_refcount`
- [ ] `test_release_triggers_teardown_at_zero`
- [ ] `test_release_unknown_key_returns_error`
- [ ] `test_get_or_create_rejects_nonexistent_path`
- [ ] `test_get_or_create_rejects_file_path`
- [ ] `test_two_sessions_two_workspaces`
- [ ] `test_two_sessions_same_project_share_workspace`
- [ ] `test_workspace_teardown_on_last_session_close`
- [ ] `test_spawn_session_rejects_invalid_project_dir`
- [ ] `test_spawn_session_rejects_missing_project_dir`
- [ ] `test_spawn_session_rejects_file_as_project_dir`
- [ ] `test_spawn_session_release_on_tugcode_failure`
- [ ] `test_spawn_session_success_ack_includes_workspace_key`
- [ ] `test_reset_session_preserves_workspace`
- [ ] `test_rebind_drops_records_without_project_dir`
- [ ] `test_rebind_drops_records_with_missing_path`
- [ ] `test_rebind_restores_workspace_entries_from_records`
- [ ] `test_binding_store_set_notifies_listeners`
- [ ] `test_use_card_workspace_key_returns_key_when_bound`
- [ ] `test_tugcard_filter_falls_back_to_presence_when_unbound`
- [ ] `test_tugcard_filter_value_checks_when_bound`
- [ ] `test_gallery_prompt_input_filters_by_workspace`
- [ ] `test_encode_spawn_session_includes_project_dir`
- [ ] `test_spawn_session_success_populates_binding_store`

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] **T3.0.W3** — retire `--dir` entirely. Remove the W1 bootstrap workspace from `main.rs`. Delete the remaining `#[allow(dead_code)]` on the four `WorkspaceEntry.JoinHandle` task fields if the release path still doesn't read them (or add explicit `.abort()` + `.await`). Introduce `resources::source_tree()` per the W3 deep dive in tide.md.
- [ ] **T3.4.c** — UI affordance for picking `project_dir` at card-open time. Replaces the W2 test-fixture constant with a real picker.
- [ ] **P14** — persistent Claude `--resume` support. W2 reserves `SessionKeyRecord.claude_session_id: Option<String>`; P14 starts populating it and reading it on rehydrate. No schema change required.
- [ ] **Per-workspace `BuildStatusCollector`** — follow-up to W3, tracked separately. Detects `Cargo.toml` / `package.json` / `go.mod` in each workspace and publishes a per-workspace build status feed.
- [ ] **Task-handle cleanup in `release`** — if W3 or a later phase decides to explicitly `.abort()` and `.await` the four task handles during teardown, remove the `#[allow(dead_code)]` annotations on them at that time.
- [ ] **Pattern: "stateful store with reactive knob" needs a name** — Step 3's task wording for `gallery-prompt-input.tsx` said *"use `useMemo` to build a `CompletionProvider` from a per-instance `FeedStore`"*, which misled the implementer into putting `new FeedStore(...)` inside a `useMemo` callback. That construction is a side effect, not a pure computation, and breaks under StrictMode double-invoke (`useMemo` callbacks may be re-run and the old instance is never disposed). The correct pattern — already in use by `Tugcard` from the same step — is **ref-init once at mount for the store handle, `useMemo` for a pure filter-function identity, `useEffect` to install the filter on the existing store via `setFilter`**. See commit `58413410` for the first (broken) gallery attempt and the follow-up fixup commit that mirrored Tugcard's pattern. Follow-on work: propose a `tuglaws/recipes.md` (or sibling) that codifies this pattern by name so future plan authors and implementers have a phrase to grep for, rather than re-deriving it each time. L02 forbids the wrong patterns but does not prescribe the right one, and the Tugcard reference implementation is unmarked.

| Checkpoint | Verification |
|------------|--------------|
| Schema bump lands and dual-read passes | `cargo nextest run -p tugcast feeds::agent_supervisor -- session_key_record` ([#step-1]) |
| Binding store and hook compile and pass unit tests | `bun test src/__tests__/card-session-binding-store.test.ts src/__tests__/use-card-workspace-key.test.tsx` ([#step-2]) |
| Tugcard and gallery-prompt-input read via hook | `bun test src/__tests__/tugcard.test.tsx` ([#step-3]) |
| `ChildSpawner::spawn_child` takes `&Path` and TugcodeSpawner is stateless | `cargo nextest run -p tugcast agent_bridge` ([#step-4]) |
| `WorkspaceRegistry::release` works with refcount teardown | `cargo nextest run -p tugcast feeds::workspace_registry` ([#step-5]) |
| Supervisor binds sessions to workspaces end-to-end | `cargo nextest run -p tugcast agent_supervisor` ([#step-6]) |
| Tugdeck sends `project_dir` and populates binding store | `bun test src/__tests__/spawn-session-binding-flow.test.ts` ([#step-7]) |
| Full workspace green and two-project manual smoke passes | `cargo nextest run` + `bun test` + manual A/B ([#step-8]) |
