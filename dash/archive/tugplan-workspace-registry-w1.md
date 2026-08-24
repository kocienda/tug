<!-- tugplan-skeleton v2 -->

## T3.0.W1 — WorkspaceRegistry, one-shot construction {#workspace-registry-w1}

**Purpose:** Introduce `WorkspaceRegistry` in tugcast as the owner of per-project feed bundles, route the existing FileWatcher / FilesystemFeed / FileTreeFeed / GitFeed through it as a single bootstrap workspace derived from the current `--dir` arg, and tag every FILETREE / FILESYSTEM / GIT frame with a `workspace_key` field. Behavior must be bit-identical to today's `tugcast --dir <path>` — this is a pure refactor that prepares the ground for W2's per-session workspace binding.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-04-14 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

Tugcast today constructs exactly one `FileWatcher`, one `FilesystemFeed`, one `FileTreeFeed`, and one `GitFeed` at startup, eagerly, in `main.rs`, bound to whatever directory the `--dir` CLI arg points at. That construction block is the only workspace tugcast has ever known, and the frames it produces carry no identifier for which workspace they belong to.

T3.0.W is a three-step refactor (W1 → W2 → W3) that moves tugcast from "tugcast has a workspace" to "workspaces are per-session objects owned by a registry and driven by CONTROL frames from the client". W1 is the first and most mechanical step: introduce the registry, route the existing construction through it, and add a `workspace_key` field to the frame payloads. No wire-protocol CONTROL additions, no per-session binding, no teardown — those ship in W2 and W3. W1's entire reason to exist is to land the refactor in a reviewable, behavior-preserving diff so W2 can focus on the CONTROL plumbing against a post-refactor shape.

#### Strategy {#strategy}

- **Pure refactor, bit-identical behavior.** Nothing observable to the end user changes. The `--dir` arg still drives the one workspace that exists; the existing router wiring is preserved; the existing test suite passes untouched. The shape of construction changes; the runtime semantics do not.
- **Registry as a thin owner.** `WorkspaceRegistry` holds a `Mutex<HashMap<WorkspaceKey, Arc<WorkspaceEntry>>>`. A `WorkspaceEntry` owns one `FileWatcher`, the broadcast `Sender<Vec<FsEvent>>`, four spawned-task `JoinHandle`s (file_watcher + the three feeds), and uses the caller-supplied `CancellationToken`. `get_or_create` canonicalizes the path, returns the existing `Arc<WorkspaceEntry>` if one exists, or creates a fresh entry and spawns the four tasks.
- **Canonicalization via PathResolver.** `WorkspaceKey` wraps `PathResolver::watch_path().to_string_lossy().into_owned()`. Re-using `PathResolver` preserves the FSEvents-compatible resolution that already handles `/etc/synthetic.conf`, firmlinks, and APFS quirks; there is zero risk of reopening that debugging. Dedup is tested via `Arc::ptr_eq` on the returned entries — not via `Arc::strong_count`, which is brittle across test contexts.
- **One splice helper, two callsites — plus one wrapper struct.** A single `splice_workspace_key` function lives next to `splice_tug_session_id` in `feeds/code.rs` and follows the identical scan-for-first-`{` pattern. `FileTreeFeed` and `GitFeed` call it at their publish sites — their payloads are already JSON objects (`FileTreeSnapshot`, `GitStatus`) so the splice prepends `workspace_key` as the first field. `FilesystemFeed` does **not** use the splice helper: its current wire payload is a bare JSON array (`Vec<FsEvent>`), so [D08] replaces it with a new wrapper struct `FilesystemBatch { workspace_key, events }` that serializes directly into an object. One canonical routine to audit (used by two feeds), one wrapper struct for the third — both approaches produce the same "workspace_key as first field" invariant.
- **No `release()` in W1.** The registry does not expose a `release` method. The bootstrap workspace is never torn down. W2 introduces `release` and teardown together when session lifecycle hooks need them. Do not build the path halfway.
- **Tugdeck filter as a presence check in W1.** Stores that subscribe to FILETREE / FILESYSTEM / GIT get an optional `workspaceKeyFilter` on their `registerCard` config. For W1 the filter closure asserts `"workspace_key" in decoded` — validates the splice is happening without coupling to a specific value (W1 has no `spawn_session` ACK from which to learn a value). In W2 the closure becomes `decoded.workspace_key === myWorkspaceKey` with the value learned from `spawn_session`.
- **Sequential commits per step.** Committer-agent commits after each step's checkpoint passes. Warnings are errors across the workspace, so every intermediate commit compiles clean under `-D warnings`.

#### Success Criteria (Measurable) {#success-criteria}

- `cd tugrust && cargo nextest run` is green on the resulting branch. (verification: run the command)
- `tugcast --dir <path>` behavior is bit-identical pre/post W1: the same FILETREE query returns the same scored results for the same input, filesystem events still flow, git status reports the same branch and file list. (verification: manual A/B against a known repo plus the existing integration-test suite which exercises file events, git, and filetree via watch channels)
- `test_workspace_registry_bootstrap_construction` passes — `get_or_create` on a fresh path returns an `Arc<WorkspaceEntry>` whose four spawned task `JoinHandle`s (`file_watcher_task`, `filesystem_task`, `filetree_task`, `git_task`) are all non-finished and whose `workspace_key` is non-empty. (verification: new unit test in `workspace_registry.rs`)
- `test_workspace_registry_deduplicates_canonical_paths` passes — two `get_or_create` calls for paths that canonicalize to the same directory return `Arc`s where `Arc::ptr_eq(&a, &b)` is true. (verification: new unit test in `workspace_registry.rs`)
- `test_workspace_key_spliced_into_filesystem_frame`, `test_workspace_key_spliced_into_filetree_frame`, `test_workspace_key_spliced_into_git_frame` — one dedicated unit test per feed, each asserting that the bytes written to the feed's `watch::Sender<Frame>` parse as JSON whose first field is `workspace_key` and whose value matches the bootstrap `workspace_key`. (verification: new unit tests added to existing test modules in `filesystem.rs`, `filetree.rs`, `git.rs`)
- No `clippy`, `rustfmt`, or `-D warnings` violations. (verification: `cargo build` and existing CI checks)

#### Scope {#scope}

1. New file `tugrust/crates/tugcast/src/feeds/workspace_registry.rs` containing `WorkspaceKey`, `WorkspaceEntry`, `WorkspaceRegistry`, and the two new unit tests. **No `WorkspaceError` enum in W1** — all underlying operations are infallible, so `get_or_create` returns `Arc<WorkspaceEntry>` directly. W2 reintroduces a `Result` wrapper when release/teardown has real failure modes to encode.
2. New function `feeds::code::splice_workspace_key` added to `feeds/code.rs`, following the exact same pattern and scanning behavior as `splice_tug_session_id`, with its own unit tests.
3. Signature changes for `FilesystemFeed::new`, `FileTreeFeed::new`, and `GitFeed::new` to accept a `workspace_key: String` (or `Arc<str>`) that each feed stores and splices into every frame it publishes. All existing test callsites in `tugrust/crates/tugcast/src/feeds/{filesystem,filetree,git}.rs` updated to pass a fixture key.
4. `main.rs` replacement of the eager feed-construction block (currently at `main.rs`'s filesystem / filetree / git setup section, anchored at `#eager-feed-construction-block`) with `WorkspaceRegistry::new()` + `registry.get_or_create(&watch_dir)` and thread `WorkspaceEntry`'s watch receivers and `ft_query_tx` into the existing router wiring without touching router semantics.
5. New optional `workspaceKeyFilter` field on `CardRegistration` in `tugdeck/src/card-registry.ts`. `DeckCanvas` reads `registration.workspaceKeyFilter` and threads it as a new optional `filter?: FeedStoreFilter` prop into `<Tugcard>`; `Tugcard` passes the prop as the `filter` argument to `FeedStore` for FILETREE / FILESYSTEM / GIT feed subscriptions. For W1 the closure is a presence check: `(_id, decoded) => typeof decoded === "object" && decoded !== null && "workspace_key" in decoded`. Existing card registrations (git, any other Tugcard-based filetree/filesystem card) adopt the filter as a presence check. `gallery-prompt-input.tsx` is a special case: it constructs a `FeedStore` inline at module scope and bypasses the `<Tugcard>` prop chain, so its inline construction is updated directly to pass `presentWorkspaceKey` as the 4th argument rather than via `registerCard`. This keeps filter exercise uniform across both the Tugcard path and the inline-FeedStore path.
6. Two new unit tests in `workspace_registry.rs`; three new unit tests in the per-feed test modules (one each for filesystem, filetree, git) asserting that a frame published to the watch channel carries `workspace_key` as its first JSON field. No new integration-test harness.

#### Non-goals (Explicitly out of scope) {#non-goals}

- **No CONTROL wire protocol changes.** `encodeSpawnSession` keeps its existing two-parameter signature. No new payload fields on `spawn_session` / `close_session` / `reset_session`. Those are W2.
- **No `WorkspaceRegistry::release()` method or refcount-zero teardown.** The bootstrap workspace is never released. Any teardown logic, refcount decrement, or `CancellationToken::cancel()` on entry removal is W2 work. Do not build it halfway.
- **No per-session `project_dir`, no removal of `AgentSupervisorConfig::project_dir`, no `LedgerEntry::workspace_key` field.** Those are W2. `AgentSupervisorConfig::project_dir` remains exactly as today.
- **No `--dir` retirement, no empty-registry-at-startup, no `resources.rs` source-tree helper.** Those are W3. `--dir` still drives the one bootstrap workspace; tugcast's internal resource discovery still uses `watch_dir` the same way.
- **No `tugcode/` or `tugapp/` changes.** This refactor is tugcast + one tugdeck filter line.
- **No changes to CODE_OUTPUT splicing.** `splice_tug_session_id` is untouched; the new `splice_workspace_key` is a sibling helper, not a replacement.
- **No new integration-test harness for exit criterion 5.** See [D07] below — criterion 5 ("workspace_key present in observed frame payloads") is validated by three per-feed unit tests exercising the publish path plus the existing integration tests that already walk frames through the watch channel. No new test harness is added.
- **No tugdeck business-logic changes beyond the filter closure.** `FileTreeStore`, `GitStore`, and any other card-side stores continue to read their payloads exactly as today; for W1 the `workspace_key` field is a passenger the store ignores (the filter already passed the frame).

#### Dependencies / Prerequisites {#dependencies}

- Existing `PathResolver` in `tugrust/crates/tugcast/src/feeds/path_resolver.rs` — used as-is to canonicalize the workspace key. No changes.
- Existing `splice_tug_session_id` helper in `tugrust/crates/tugcast/src/feeds/code.rs` — serves as the pattern template for `splice_workspace_key`. No changes.
- Existing `FeedStore` filter API in `tugdeck/src/lib/feed-store.ts` — the `FeedStoreFilter` type and 4th constructor argument already exist (introduced for the CODE_OUTPUT `tug_session_id` / [D11] filter). W1 uses it as-is.
- Existing `registerCard` API in `tugdeck/src/card-registry.ts` — adds one new optional field, no breaking changes.
- No prerequisite work from any other plan; W1 is the first step of the T3.0.W series.

#### Constraints {#constraints}

- **Warnings are errors.** The tugcast crate and the whole tugrust workspace enforce `-D warnings` via `tugrust/.cargo/config.toml`. Every intermediate commit must compile clean. New imports, new types, new tests — all zero-warning.
- **Behavior preservation is the primary contract.** Any diff in observable FILETREE query results, filesystem event ordering, git status content, or watch-channel semantics is a regression. The plan includes a dedicated behavior-preservation step before committing.
- **One tugdeck package manager: bun.** Never npm or npx. (Memory: `feedback_use_bun`.)
- **No `--no-verify`, no commit squashing, no `git amend`.** Committer-agent creates new commits per step. (CLAUDE.md commit discipline.)
- **Skeleton compliance is mandatory.** Every cited artifact has an explicit anchor; steps carry `**References:**` and `**Depends on:**` lines.
- **No Co-Authored-By attribution lines in commits.** (Memory: `feedback_no_coauthored_by`.)

#### Assumptions {#assumptions}

- `WorkspaceRegistry` lives at `tugrust/crates/tugcast/src/feeds/workspace_registry.rs` and is declared `pub mod workspace_registry;` in `tugrust/crates/tugcast/src/feeds/mod.rs` alongside the existing feed modules.
- The bootstrap workspace construction in `main.rs` replaces the eager feed-construction block at [#eager-feed-construction-block](#eager-feed-construction-block) with `WorkspaceRegistry::new()` + `registry.get_or_create(&watch_dir, cancel.clone())` (no `?` — `get_or_create` is infallible in W1 per [S02]) and the existing router wiring remains unchanged. `WorkspaceEntry` exposes the same watch receivers main.rs currently wires into the router: `fs_watch_rx`, `ft_watch_rx`, `git_watch_rx`.
- `FileTreeFeed`'s dual-input nature (event broadcast + query mpsc) means `WorkspaceEntry` must expose a `ft_query_tx: mpsc::Sender<FileTreeQuery>` alongside the three watch receivers; the FILETREE_QUERY adapter task in `main.rs` remains, now fed by `entry.ft_query_tx` rather than a locally constructed mpsc sender.
- The three workspace-scoped feeds splice `workspace_key` *before* serializing their own payload, meaning the splice is applied to the serialized JSON bytes, and the field is prepended as the first field of the outer JSON object. Existing feed serialization tests (e.g. filetree response tests) continue to pass as long as the tests don't assert *first-field position* — a spot-check of the test file confirmed they assert field *presence* and *value*, not position. See [Q02] for the FileTreeFeed test shape question and its resolution.
- Exit criterion 5 (workspace_key present in all observed frame payloads) is validated by three per-feed unit tests that walk each feed's publish path through its watch channel and parse the resulting frame. Manual A/B against a running tugcast is a belt-and-suspenders smoke test, not a formal exit gate.

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

This plan uses explicit `{#anchor-name}` anchors on every heading and artifact that later steps cite. Anchors are kebab-case, decisions use `dNN-...`, questions use `qNN-...`, risks use `rNN-...`, specs use `sNN-...`, tables use `tNN-...`, steps use `step-N`.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Feed signature — workspace_key by value or by Arc<str>? (DECIDED) {#q01-workspace-key-feed-signature}

**Question:** When a feed like `FilesystemFeed` stores the workspace key for splicing into each published frame, should the type be `String`, `Arc<str>`, or `Arc<WorkspaceKey>`?

**Why it matters:** The key is read on every frame publish (many times per second during file events), so allocation churn in the hot path is observable. It's also shared across all three feeds for a given entry.

**Plan to resolve:** Pick a shape that minimizes hot-path allocation while keeping the construction site readable.

**Resolution:** DECIDED (see [D02]) — store `Arc<str>` on each feed, constructed once per feed from the canonical `WorkspaceKey` string at `get_or_create` time.

#### [Q02] FileTreeFeed's existing `response_serializes_to_spec_s01b` test and prepended `workspace_key` (DECIDED) {#q02-filetree-existing-test}

**Question:** The existing `response_serializes_to_spec_s01b` test in `filetree.rs` asserts the JSON shape of a serialized `FileTreeSnapshot`. Does prepending `workspace_key` break it?

**Why it matters:** The test constructs a `FileTreeSnapshot` directly and calls `serde_json::to_value`, bypassing any splice path. The test does not exercise the watch-channel publish; it exercises the struct's Serde shape. So the splice logic is invisible to it and the test keeps passing unchanged.

**Plan to resolve:** Inspect the test body; confirm it exercises the struct, not the publish path; decide whether the splice site is the struct or the publish path.

**Resolution:** DECIDED (see [D03]) — the test is untouched. The splice is applied to the serialized bytes *inside* `FileTreeFeed::send_response` (or equivalent publish path), *after* the struct serialization and *before* the watch channel write. Direct struct tests are orthogonal.

#### [Q04] FilesystemFeed wire payload is a JSON array, not an object (DECIDED) {#q04-filesystem-payload-shape}

**Question:** `FilesystemFeed::run` currently writes `serde_json::to_vec(&batch)` where `batch: Vec<FsEvent>` — a bare JSON **array** like `[{...},{...}]`, not an object. The splice helper scans for the first `{` and inserts a field after it. For an empty batch `[]` there is no `{` at all (splice returns bytes unchanged, drops presence-check filter). For a non-empty batch the first `{` is the opening brace of the first `FsEvent` element, so the splice produces `[{"workspace_key":"...","kind":"Created",...},...]` — the field ends up inside the first event, not at the top level. Exit criterion 5 ("workspace_key as first JSON field") is physically impossible for FILESYSTEM under the current wire shape.

**Why it matters:** Without a fix, the tugdeck presence-check filter ([D05]) drops filesystem frames for idle periods and misidentifies populated frames, and the "first field" invariant does not hold.

**Plan to resolve:** Decide between (a) wrap the payload in a wrapper struct so it becomes a JSON object, or (b) special-case splice to handle JSON arrays, or (c) document that FILESYSTEM is exempt from the first-field invariant.

**Resolution:** DECIDED (see [D08]) — Option (a). Introduce a wrapper struct `FilesystemBatch { workspace_key: String, events: Vec<FsEvent> }` and serialize that. The wire shape becomes a JSON object with `workspace_key` as its first field, matching FILETREE and GIT. Both ends of the protocol (tugcast producer, tugdeck consumer) are under our control; no external consumer exists. This is the shape W2 will want anyway.

#### [Q03] Tugdeck filter — presence check or value check in W1? (DECIDED) {#q03-tugdeck-filter-shape}

**Question:** In W1 there is only one workspace and no `spawn_session` ACK from which the card can learn the expected `workspace_key` value. Should the W1 filter closure match the exact value (hardcoded?) or just assert presence of the field?

**Why it matters:** A hardcoded value would be W1-only dead code that W2 immediately replaces; a presence check validates the splice end-to-end without coupling to a specific value.

**Plan to resolve:** Decide based on what W2 will replace the closure with.

**Resolution:** DECIDED (see [D05]) — presence check only. `(_id, decoded) => typeof decoded === "object" && decoded !== null && "workspace_key" in decoded`. This validates the splice is wired end-to-end without creating a W1-only hardcoded key that W2 would need to replace anyway. W2 swaps the closure to `decoded.workspace_key === myWorkspaceKey` once the card learns its key from the `spawn_session` ACK.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Splice breaks a feed's existing wire contract | high | low | Unit tests per feed on the publish path; existing integration tests that parse frames end-to-end continue to pass unchanged | Any CI failure in `cargo nextest run` on `feeds::` tests |
| WorkspaceEntry task lifecycle differs subtly from current main.rs construction | high | medium | Step [#step-6] dedicated to behavior preservation — runs existing integration tests and a manual A/B script against a known repo before merging | Integration-test diff between pre- and post-W1 |
| Canonicalization via PathResolver produces a key form that doesn't round-trip in tugdeck | medium | low | W1 filter is a presence check only ([D05]); actual value-matching is a W2 concern with its own test coverage | W2's `test_two_sessions_two_workspaces` failure |
| Hot-path allocation on every frame from `String::clone` in the splice | low | medium | Store workspace key as `Arc<str>` on each feed ([D02]); splice reads a borrowed `&str` and only allocates the final `Vec<u8>` output | Profiling diff on `STATS_BUILD_STATUS` flamegraph |
| New registry tests leak tokio tasks and FileWatcher OS handles under parallel nextest | medium | medium | Both new tests explicitly `cancel.cancel()` + drop Arcs + bounded `tokio::time::timeout` yield, matching existing `test_filesystem_feed_integration` cleanup pattern ([R03]) | Any "too many open files" or watch-quota OS error in CI |

**Risk R01: FileWatcher event source swap is subtly different under the registry** {#r01-filewatcher-swap}

- **Risk:** In the current main.rs, `FileWatcher::new(watch_dir.clone())` and `FileWatcher::create_sender()` are called side-by-side; the broadcast sender is cloned into both `FilesystemFeed` and `FileTreeFeed`, and `file_watcher.run(fw_broadcast_tx, fw_cancel)` is spawned explicitly. In the registry shape, `WorkspaceEntry::new` owns all three of those things internally. If the ordering, cancellation parent/child relationship, or the broadcast channel capacity changes, filesystem events might miss the race window during early file modifications.
- **Mitigation:** `WorkspaceEntry::new` preserves the exact same ordering as today: create `FileWatcher`, call `FileWatcher::create_sender()`, clone the sender into `FilesystemFeed::new` and `FileTreeFeed::new`, spawn `file_watcher.run`, spawn `fs_feed.run`, spawn `ft_feed.run`, spawn `git_feed.run`. The `CancellationToken` used is the `cancel` passed into `WorkspaceRegistry::get_or_create` (which in main.rs is the same `cancel: CancellationToken` that exists today, but relocated to an earlier line — see [#step-4]), not a fresh token owned by the entry. This keeps the cancellation tree identical. [#step-4] explicitly moves `let cancel = CancellationToken::new();` from its current position at main.rs:293 to immediately before the `WorkspaceRegistry::new()` call so `cancel.clone()` is available at the `get_or_create` callsite.
- **Residual risk:** If `WorkspaceEntry` ever needs a per-workspace cancellation token in W2 (for the teardown path), the cancellation tree will change at that point. That's W2's problem.

**Risk R02: `-D warnings` failure on an unused import or field during incremental rework** {#r02-warnings-errors}

- **Risk:** Warnings are errors across this workspace. During incremental step-by-step work (e.g., introduce `WorkspaceRegistry` in step 2 before `main.rs` calls it in step 4), the intermediate state might leave unused code that fails the build.
- **Mitigation:** Step ordering is chosen so that the registry is introduced, tested, and immediately adopted in `main.rs` within a small number of steps. Where an intermediate state would leave dead code, mark it `#[allow(dead_code)]` with a comment pointing at the next step that uses it. Remove the allow on that next step.
- **Residual risk:** A `clippy` lint not explicitly covered by `-D warnings` could still fire. The build command `cargo build` in every step's checkpoint catches this.

**Risk R03: New registry tests leak tokio tasks and FileWatcher OS handles** {#r03-test-task-leaks}

- **Risk:** The two new tests `test_workspace_registry_bootstrap_construction` and `test_workspace_registry_deduplicates_canonical_paths` each call `get_or_create`, which spawns four tokio tasks (`file_watcher.run`, `fs_feed.run`, `ft_feed.run`, `git_feed.run`) and constructs a `FileWatcher` holding a live FSEvents (macOS) or inotify (Linux) handle. Under nextest's parallel runner, a test that asserts and returns without cancelling the token and dropping the `Arc<WorkspaceEntry>` will leak the tasks and the OS-level watcher resources across test boundaries. Over enough parallel tests this hits "too many open files" or OS-level watch-quota limits, producing flaky and environment-dependent failures.
- **Mitigation:** Both new tests end with an explicit cleanup sequence: drop all local `Arc<WorkspaceEntry>` bindings (so the map is the only ref holder), then `cancel.cancel();` to trigger shutdown of the four spawned tasks, then `let _ = tokio::time::timeout(Duration::from_secs(2), async { /* short yield */ }).await;` so the runtime has a bounded window to observe cancellation. This mirrors the existing cleanup pattern in `test_filesystem_feed_integration` at `tugrust/crates/tugcast/src/feeds/filesystem.rs` (which uses `cancel.cancel(); let _ = tokio::time::timeout(Duration::from_secs(2), feed_task).await;`). The registry does not hold a direct `JoinHandle` that a test can `.await` on, but `cancel.cancel()` + `drop(entry)` + a short bounded timeout is sufficient because the tasks are cooperatively cancellable via their `cancel.cancelled()` branches.
- **Residual risk:** If a future feed task is written that does not observe its cancellation token (e.g., it blocks on a synchronous system call), the test's short timeout will expire without the task terminating. The test itself still passes (the timeout is bounded), but the underlying leak returns. Mitigation for that is a code review standard on feed tasks: every spawned task must have a `cancel.cancelled()` branch in its top-level `tokio::select!`.

---

### Design Decisions {#design-decisions}

#### [D01] WorkspaceKey is canonicalized via PathResolver::watch_path (DECIDED) {#d01-canonical-path-form}

**Decision:** `WorkspaceKey` is a newtype `pub struct WorkspaceKey(Arc<str>)` whose inner string is produced by `PathResolver::new(project_dir).watch_path().to_string_lossy().into_owned()` then converted via `.into()` to `Arc<str>`. See [Spec S01](#s01-workspace-entry-shape) for the full definition.

**Rationale:**
- `PathResolver` already handles the FSEvents-compatible path form: `/etc/synthetic.conf`, firmlinks, APFS data volume, Linux bind mounts. Re-deriving canonical paths from `std::fs::canonicalize` in the registry would reopen debugging this project has already done once.
- The registry is the only place in the codebase that needs a *string* form of the canonical path as a map key. Every other consumer takes a `PathBuf` or `&Path`. The newtype wraps an `Arc<str>` so comparison is cheap and map-key semantics are explicit.
- Using `Arc<str>` inside the newtype means the feeds can cheaply clone the shared allocation (`entry.workspace_key.arc()` is one atomic increment) rather than duplicating the string. There is no separate `workspace_key_arc` field — one canonical copy per entry.
- `WorkspaceEntry` still carries `project_dir: PathBuf` for Rust-side APIs that need an owned path (e.g., passing to `FileWatcher::new`, `FilesystemFeed::new`). The `PathBuf` is the original input to `get_or_create`; the `WorkspaceKey` is the canonical form used for dedup.

**Implications:**
- A one-line doc comment on `WorkspaceKey` in `workspace_registry.rs` explains why the canonical form is `PathResolver::watch_path` and not `std::fs::canonicalize`.
- `WorkspaceRegistry` depends on `super::path_resolver::PathResolver`.
- The dedup unit test asserts two different input `PathBuf`s whose resolutions match produce `Arc::ptr_eq`-equal entries. It does *not* assert specific string contents of the `WorkspaceKey`; that would couple the test to `PathResolver`'s implementation.

#### [D02] Feeds store workspace_key as Arc<str>, not String (DECIDED) {#d02-arc-str-feed-field}

**Decision:** `FilesystemFeed`, `FileTreeFeed`, and `GitFeed` each gain a `workspace_key: Arc<str>` field, populated at construction time. The splice helper reads it as `&str` on every frame publish.

**Rationale:**
- Frame publishing runs on every file event and every git poll tick. Cloning a `String` per publish allocates on the hot path.
- `Arc<str>` is cheap to clone (one atomic increment) and dereferences to `&str` for the splice helper. The entry owns the "source of truth" `Arc<str>`, and hands a clone to each feed at construction.
- Using `Arc<WorkspaceKey>` would require unwrapping the newtype on every read. `Arc<str>` is the clean minimum.

**Implications:**
- `WorkspaceKey` itself wraps `Arc<str>` (see [D01] and [Spec S01](#s01-workspace-entry-shape)). `WorkspaceEntry::new` obtains the shared handle via `workspace_key.arc()` and passes clones to each feed. There is no separate `workspace_key_arc` field on `WorkspaceEntry` — the `WorkspaceKey` is the canonical owner.
- `FilesystemFeed::new`, `FileTreeFeed::new`, and `GitFeed::new` gain a `workspace_key: Arc<str>` parameter as the last argument (preserves parameter-order readability).
- Existing test callsites in each feed's test module construct a fixture key (e.g. `let key: Arc<str> = Arc::from("/tmp/test")`) and pass it. Affected tests in `feeds/filesystem.rs`, `feeds/filetree.rs`, `feeds/git.rs` are updated to match.

#### [D03] Splice is applied at the publish site for filetree/git; filesystem uses a wrapper struct (DECIDED) {#d03-splice-at-publish-site}

**Decision:** `FileTreeFeed` and `GitFeed` apply `splice_workspace_key` to the bytes they're about to write to their `watch::Sender<Frame>`, immediately before constructing the `Frame`. Their internal types (`FileTreeSnapshot`, `GitStatus`) retain their current Serde shapes — no new field is added to either struct. `FilesystemFeed` does not use the splice helper because its existing payload is a bare JSON array; it uses a wrapper struct instead, per [D08].

**Rationale:**
- Adding a `workspace_key` field to `FileTreeSnapshot` / `GitStatus` would force every test that constructs those structs directly to provide the field, bloating the diff.
- The splice helper already knows how to prepend a first-field into an arbitrary JSON object (proven pattern from `splice_tug_session_id`). Using it at the publish site is a three-line mechanical change per feed (filetree, git).
- Existing struct-level Serde tests (e.g. `response_serializes_to_spec_s01b` in `filetree.rs`) continue to pass unchanged because they exercise the struct, not the publish path.
- FilesystemFeed is the lone exception: its payload is a `Vec<FsEvent>` (a JSON array), so there is no object for the splice to prepend a field into. [D08] resolves this by wrapping the payload in a `FilesystemBatch { workspace_key, events }` struct, which serializes as a JSON object with `workspace_key` as the first field.

**Implications:**
- The new per-feed unit tests for workspace_key exercise the publish path: spawn the feed, push an event or tick, read the watch channel, parse the frame payload, assert `workspace_key` is the first field.
- Any future consumer that needs the `workspace_key` field statically typed (e.g. a deserialization target in a Rust client) can't rely on struct shape alone and must either deserialize to a serde_json::Value or add a wrapper struct. For W1, no such consumer exists.
- `splice_workspace_key` lives in `feeds/code.rs` next to `splice_tug_session_id`, not in `workspace_registry.rs`. The single authoritative splice module simplifies audit.

#### [D04] `release()` is not implemented in W1 (DECIDED) {#d04-no-release-in-w1}

**Decision:** `WorkspaceRegistry` has no `release` method and no refcount-decrement path in W1. The bootstrap workspace lives for the lifetime of the process. `WorkspaceEntry` does not carry an explicit refcount field; the `Arc` in the map is the only refcount mechanism (see [D06]).

**Rationale:**
- W1 has exactly one workspace that is never released. Implementing `release` without exercising it means implementing untested lifecycle code, which is the worst possible combination.
- W2 introduces `release` together with the session-lifecycle hooks that actually call it, so the method ships with real test coverage (`test_workspace_teardown_on_last_session_close`, `test_two_sessions_same_project_share_workspace`).
- This is the roadmap's explicit intent per §T3.0.W1: "refcount floor is 1 — the initial bootstrap entry is never released".

**Implications:**
- No `pub fn release(...)` on `WorkspaceRegistry` in W1.
- No `CancellationToken::cancel()` call on entry drop. If the process shuts down, the outer `cancel: CancellationToken` owned by main.rs cascades to the feed tasks exactly as today.
- Comment in `workspace_registry.rs`: "Teardown lifecycle deferred to W2 (T3.0.W2). Do not add `release` here without updating the W2 plan."

#### [D05] Tugdeck filter is a presence check in W1 (DECIDED) {#d05-tugdeck-presence-filter}

**Decision:** The `workspaceKeyFilter` closure on `registerCard` for W1 is a presence check: `(_id, decoded) => typeof decoded === "object" && decoded !== null && "workspace_key" in decoded`. It rejects frames that do not carry a `workspace_key` field. It does not compare the value.

**Rationale:**
- W1 has no `spawn_session` ACK plumbing from which a card can learn the expected `workspace_key` value. Any hardcoded value in the closure would be W1-only dead code that W2 would immediately replace.
- A presence check is the strongest filter W1 can usefully apply: it validates end-to-end that the splice is happening and that tugdeck's filter path is wired correctly.
- W2 swaps the closure to `decoded.workspace_key === myWorkspaceKey` once the card learns its key from the `spawn_session` ACK; the tugdeck-side plumbing (`workspaceKeyFilter` field, `FeedStore` filter argument, `tug-card.tsx` wiring) is already in place from W1.

**Implications:**
- `card-registry.ts` gains one optional field: `workspaceKeyFilter?: FeedStoreFilter`.
- `tug-card.tsx` reads the field at `FeedStore` construction and passes it as the 4th argument. If the field is unset, behavior is identical to today.
- Existing card registrations for git, filetree-consuming gallery cards, and any filesystem-consuming card adopt the presence-check closure. A shared helper `const presentWorkspaceKey: FeedStoreFilter = (_id, decoded) => typeof decoded === "object" && decoded !== null && "workspace_key" in decoded` lives in `card-registry.ts` or `feed-store.ts` and is imported where needed.

#### [D06] No explicit refcount field on WorkspaceEntry (DECIDED) {#d06-no-refcount-field}

**Decision:** `WorkspaceEntry` has no `ref_count: AtomicUsize` field. Reference-counting is delegated entirely to the `Arc` in the `HashMap<WorkspaceKey, Arc<WorkspaceEntry>>`. The dedup unit test asserts `Arc::ptr_eq(&first, &second)`, not `Arc::strong_count`.

**Rationale:**
- `Arc::strong_count` is brittle in tests: the count depends on how many local `Arc` clones exist on the stack at the assertion point, including clones held by the test harness and the callee.
- `Arc::ptr_eq` is exact: it tests pointer identity, which is the actual property dedup is trying to guarantee.
- The roadmap §T3.0.W1's "refcount 1" / "refcount 2" language was loose shorthand for "one workspace exists in the map" / "two `get_or_create` calls dedupe to the same entry". Those properties are testable without reading `strong_count`.
- W2's `release` path becomes `self.map.lock().remove(&key)`; the entry Drops automatically when the last `Arc` referencing it is dropped. No manual bookkeeping.

**Implications:**
- `test_workspace_registry_bootstrap_construction` asserts: map contains exactly one entry for the given key; the `Arc<WorkspaceEntry>` returned from `get_or_create` dereferences to a `WorkspaceEntry` whose four spawned task handles (`file_watcher_task`, `filesystem_task`, `filetree_task`, `git_task`) are non-finished (`!handle.is_finished()`); `entry.workspace_key` is non-empty.
- `test_workspace_registry_deduplicates_canonical_paths` asserts: two `get_or_create` calls return `Arc`s for which `Arc::ptr_eq(&first, &second)` is true, and the map still contains exactly one entry.
- No `AtomicUsize` import in `workspace_registry.rs`.

#### [D07] Exit criterion 5 validated by three per-feed unit tests, not a new harness (DECIDED) {#d07-exit-criterion-5-unit-tests}

**Decision:** Exit criterion 5 ("all FILETREE / FILESYSTEM / GIT payloads observed on a running tugcast are JSON objects whose first field is workspace_key matching the bootstrap workspace") is validated by three new unit tests, one per feed, each exercising the feed's publish path through its `watch::Sender<Frame>` and asserting the result. No new integration-test harness is added.

**Rationale:**
- The three existing feed test files already exercise `run()` with a `watch::Sender<Frame>` and parse the resulting `Frame::payload`. Adding one assertion (`parsed_as_value["workspace_key"]` is a string and is the first key) per test is a minimal addition.
- An integration harness that starts a full tugcast and observes frames over the WebSocket would duplicate existing integration coverage while exposing W1 to flakiness unrelated to the refactor.
- The clarifier asked the plan author to make an explicit call on this. The explicit call is: unit tests, no new harness.

**Implications:**
- Three new tests in the three feed test modules, named `test_workspace_key_spliced_into_{filesystem,filetree,git}_frame`.
- Exit criterion 5 in [#exit-criteria] cites these tests as the formal verification. "Manual validation against a running tugcast" is kept as a belt-and-suspenders smoke-test, not a gate.

#### [D08] FilesystemFeed payload becomes a wrapper object, not a bare array (DECIDED) {#d08-filesystem-wrapper-struct}

**Decision:** `FilesystemFeed::run` stops serializing `Vec<FsEvent>` directly. Instead it serializes a new struct:

```rust
#[derive(Serialize)]
struct FilesystemBatch<'a> {
    workspace_key: &'a str,
    events: &'a [FsEvent],
}
```

The field ordering is `workspace_key` then `events`, so the JSON output is `{"workspace_key":"...","events":[...]}` with `workspace_key` as the first field. Because the workspace_key is built into the struct, FilesystemFeed does **not** call `splice_workspace_key` on its payload — it emits the wrapper directly and the shape is correct by construction.

**Rationale:**
- The current wire shape (a bare JSON array `[{...},...]`) is fundamentally incompatible with the "first field is workspace_key" invariant that `splice_workspace_key` enforces. Any array-aware splice would be special-case code that breaks the "one helper, three callsites" pattern.
- Wrapping in a struct is the cleanest fix: the wire shape becomes a JSON object like FILETREE and GIT, `workspace_key` is present by construction (not by string-level splicing), and the empty-batch case `{"workspace_key":"...","events":[]}` still carries the field.
- Both ends of the protocol are under our control. The only existing filesystem frame consumer is tugdeck, and tugdeck updates in [#step-5] anyway. There is no external wire contract to preserve.
- FILETREE and GIT still use `splice_workspace_key` because their existing payloads are already JSON objects (`FileTreeSnapshot`, `GitStatus`); rewriting those feeds to use wrapper structs would bloat the diff for no benefit.

**Implications:**
- `FilesystemFeed` does **not** store an `Arc<str> workspace_key` for splicing at runtime; instead it stores the key and reads it into the wrapper struct at publish time. In practice the feed still holds an `Arc<str>` field for consistency with the other feeds and to avoid re-cloning on every publish (the wrapper takes `&str`, which the `Arc<str>` dereferences to).
- **`FilesystemBatch` is private to `feeds/filesystem.rs`.** It is declared as a module-private `struct FilesystemBatch<'a> { ... }` with `#[derive(Serialize)]`, used only inside `FilesystemFeed::run`'s publish path, and never referenced from `workspace_registry.rs` or any other module. This is possible because [Spec S01](#s01-workspace-entry-shape) does not seed the FILESYSTEM watch channel with a `FilesystemBatch` value — the watch channel is initialized with an empty payload `Frame::new(FeedId::FILESYSTEM, vec![])` exactly as today, and the router's `!frame.payload.is_empty()` guard drops that empty frame before it reaches the wire. No cross-module visibility of `FilesystemBatch` is required.
- The FilesystemFeed publish site in [#step-3] changes from `serde_json::to_vec(&batch)` to `serde_json::to_vec(&FilesystemBatch { workspace_key: &self.workspace_key, events: &batch })`. No call to `splice_workspace_key` from `filesystem.rs`.
- The existing integration test `test_filesystem_feed_integration` at `feeds/filesystem.rs:151` currently parses the payload as `Vec<FsEvent>`. It must be updated to deserialize the new wrapper — either into a local `#[derive(Deserialize)] struct FilesystemBatchOwned { workspace_key: String, events: Vec<FsEvent> }`, or by parsing as `serde_json::Value` and extracting `events`.
- `test_workspace_key_spliced_into_filesystem_frame` (the new W1 test) asserts the same invariant as the filetree/git counterparts — `parsed.as_object().unwrap().keys().next().unwrap() == "workspace_key"` and `parsed["workspace_key"] == "<fixture-key>"` — but the mechanism producing that shape is the wrapper struct, not the splice helper. The test name is kept aligned with the other two for symmetry, even though "spliced" is mechanically inaccurate for filesystem (the plan's comment in [#step-3] notes this).
- Spec S04 drops `workspace_key: Arc<str>` from `FilesystemFeed::new`'s "through the splicer" semantics and describes the wrapper-struct path instead. FileTree and Git constructors keep the splicer path unchanged. See the amended Spec S04 below.

---

### Deep Dives (Optional) {#deep-dives}

#### The eager feed-construction block {#eager-feed-construction-block}

The block `main.rs` currently runs at startup — the part W1 replaces — looks structurally like:

1. `let file_watcher = FileWatcher::new(watch_dir.clone());` — owns the notify watcher and the walker.
2. `let fs_broadcast_tx = FileWatcher::create_sender();` — a `broadcast::Sender<Vec<FsEvent>>`, shared between `FilesystemFeed`, `FileTreeFeed`, and the `file_watcher.run` task.
3. `let (fs_watch_tx, fs_watch_rx) = watch::channel(Frame::new(FeedId::FILESYSTEM, vec![]));` — filesystem feed watch channel.
4. `let fs_feed = FilesystemFeed::new(watch_dir.clone(), fs_broadcast_tx.clone());`
5. `let (initial_files, ft_truncated) = file_watcher.walk();` — synchronous walk to seed the FileTreeFeed.
6. `let (ft_query_tx, ft_query_rx) = mpsc::channel::<FileTreeQuery>(16);` — query input for FileTreeFeed.
7. `let (ft_watch_tx, ft_watch_rx) = watch::channel(Frame::new(FeedId::FILETREE, vec![]));` — filetree output.
8. `let ft_feed = FileTreeFeed::new(watch_dir.clone(), initial_files, ft_truncated, fs_broadcast_tx.clone(), ft_query_rx);`
9. `let (ft_input_tx, mut ft_input_rx) = mpsc::channel::<Frame>(16);` — FILETREE_QUERY adapter input.
10. Spawn the FILETREE_QUERY adapter task that translates raw `Frame`s into `FileTreeQuery`s and forwards to `ft_query_tx`.
11. `let (git_watch_tx, git_watch_rx) = watch::channel(Frame::new(FeedId::GIT, vec![]));` — git feed watch channel.
12. `let git_feed = GitFeed::new(watch_dir.clone());`
13. Later: four `tokio::spawn` calls for `file_watcher.run`, `fs_feed.run`, `ft_feed.run`, `git_feed.run`.

After W1, steps 1 / 2 / 4 / 5 / 6 / 8 / 12 / 13 move inside `WorkspaceEntry::new`. The watch channels (steps 3, 7, 11) stay in main.rs because the router owns them; the entry exposes the senders it should publish on. (Or: the entry owns the watch channels too and exposes the receivers. Either works; see Spec [S01] below for the chosen shape.)

The FILETREE_QUERY adapter task (steps 9, 10) stays in main.rs because it's a router-side concern; it now forwards to `entry.ft_query_tx` instead of a locally constructed mpsc sender.

#### End-to-end flow after W1 {#end-to-end-flow}

```
main.rs startup
├── parse CLI → watch_dir: PathBuf
├── WorkspaceRegistry::new() → empty map
├── registry.get_or_create(&watch_dir, cancel.clone())      // returns Arc<WorkspaceEntry>, not Result
│     ├── canonicalize via PathResolver → WorkspaceKey
│     ├── lookup map → none
│     ├── construct WorkspaceEntry:
│     │     ├── FileWatcher::new(watch_dir.clone())
│     │     ├── fs_broadcast_tx = FileWatcher::create_sender()
│     │     ├── FilesystemFeed::new(watch_dir, fs_broadcast_tx.clone(), key.arc())
│     │     ├── file_watcher.walk() → (initial_files, ft_truncated)
│     │     ├── (ft_query_tx, ft_query_rx) = mpsc::channel(16)
│     │     ├── FileTreeFeed::new(watch_dir, initial_files, ft_truncated,
│     │     │                     fs_broadcast_tx.clone(), ft_query_rx, key.arc())
│     │     ├── GitFeed::new(watch_dir.clone(), key.arc())
│     │     ├── spawn file_watcher.run(fs_broadcast_tx, cancel.clone())
│     │     ├── spawn fs_feed.run(fs_watch_tx, cancel.clone())
│     │     ├── spawn ft_feed.run(ft_watch_tx, cancel.clone())
│     │     └── spawn git_feed.run(git_watch_tx, cancel.clone())
│     ├── insert into map
│     └── return Arc<WorkspaceEntry>
├── main.rs wires entry.fs_watch_rx / ft_watch_rx / git_watch_rx into router snapshot_watches
├── main.rs wires entry.ft_query_tx into FILETREE_QUERY adapter task
└── (rest of main.rs untouched: TCP listener, router, supervisor)
```

Every frame a workspace-scoped feed publishes now carries `workspace_key` as its first JSON field: FileTreeFeed and GitFeed achieve this by calling `splice_workspace_key` on their serialized object payloads; FilesystemFeed achieves it by serializing a `FilesystemBatch { workspace_key, events }` wrapper struct directly ([D08]). The tugdeck filter is a presence check that validates the field is present end-to-end.

---

### Specification {#specification}

#### Spec S01: WorkspaceEntry exposes the same surface main.rs wires today {#s01-workspace-entry-shape}

`WorkspaceEntry` is the owner of one workspace's feed bundle. Its fields are:

```rust
pub struct WorkspaceEntry {
    /// Canonicalized path — the map key. Wraps Arc<str> so .as_str() and
    /// .arc() both give cheap views without duplicating the underlying string.
    pub workspace_key: WorkspaceKey,
    /// Original path input to get_or_create — used by feeds and for logging.
    pub project_dir: PathBuf,
    /// Watch receivers for the three feeds; main.rs wires these into the router.
    pub fs_watch_rx: watch::Receiver<Frame>,
    pub ft_watch_rx: watch::Receiver<Frame>,
    pub git_watch_rx: watch::Receiver<Frame>,
    /// Query input for FileTreeFeed — main.rs wires this into the FILETREE_QUERY adapter.
    pub ft_query_tx: mpsc::Sender<FileTreeQuery>,
    /// Task handles for the four spawned tasks. Retained so tests can
    /// assert `!handle.is_finished()` on the bootstrap construction.
    pub file_watcher_task: JoinHandle<()>,
    pub filesystem_task: JoinHandle<()>,
    pub filetree_task: JoinHandle<()>,
    pub git_task: JoinHandle<()>,
}
```

`WorkspaceKey` itself wraps a single `Arc<str>`:

```rust
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct WorkspaceKey(Arc<str>);

impl WorkspaceKey {
    pub fn as_str(&self) -> &str { &self.0 }
    pub fn arc(&self) -> Arc<str> { Arc::clone(&self.0) }
}
```

Feeds take the `Arc<str>` form via `entry.workspace_key.arc()`; the map hashes on `WorkspaceKey` via the inner `Arc<str>`'s `Hash` / `Eq` impls (`Arc<str>` derefs to `&str` for hashing, so two `WorkspaceKey`s with the same string content hash equal even if their `Arc`s are different allocations). There is no `workspace_key_arc` field — one canonical owned copy.

Watch channels are owned inside `WorkspaceEntry::new`: the entry creates the `(tx, rx)` pair, stores the `rx` on the struct, and hands the `tx` to the spawned feed task. This keeps the receiver side of the channel with the entry, which is what main.rs needs to wire into the router.

**Initial watch-channel values remain empty-payload, exactly as today's `main.rs`.** `WorkspaceEntry::new` constructs each of the three watch channels with `watch::channel(Frame::new(FeedId::*, vec![]))`, matching the current `main.rs` bootstrap. No seeding with a workspace-key-bearing payload is performed. The reason seeding is unnecessary (and would be incorrect):

- **Router already drops empty-payload frames from the initial snapshot send.** The tugcast router's LIVE-state initial snapshot path at `router.rs` applies a guard on every watch receiver: `if !frame.payload.is_empty() && socket.send(Message::Binary(frame.encode().into())).await.is_err() { ... }`. An empty watch-channel initial value is therefore a no-op on the wire — it is dropped at the router *before* encoding and *before* reaching tugdeck. The tugdeck presence filter ([D05]) never observes an empty frame either today or under W1, so there is nothing for it to reject.
- **Seeding would introduce a FILESYSTEM behavior divergence.** Replacing the empty `vec![]` with a serialized `FilesystemBatch { workspace_key, events: [] }` would turn the initial value into a non-empty JSON object, which the router's `!frame.payload.is_empty()` guard would then *send* on every client connect — a new wire frame that today's build does not produce. That divergence breaks Success Criterion 2 ("bit-identical behavior pre/post W1... filesystem events still flow"). W1 is a pure refactor; no new wire frames on client connect.
- **FILETREE already publishes its initial snapshot inside the spawned task.** `FileTreeFeed::run` calls `self.send_response(&watch_tx, &initial_snapshot)` as the first action of the spawned task, before entering the select loop (see `feeds/filetree.rs` around the top of `run()`). That initial send lands in the watch channel essentially immediately — long before any client can race to subscribe, because the four feed tasks are spawned inside `WorkspaceEntry::new` which runs *before* main.rs finishes constructing the TCP listener. No race window exists for a subscriber to observe an unfiltered empty value; the first real frame on the channel is a spliced `FileTreeSnapshot` with `workspace_key` as its first field.
- **FILESYSTEM and GIT receive their first real frames from their tasks' first publish.** A subscriber that attaches before any file event or git tick will simply not receive an initial FILESYSTEM/GIT frame (because the router's guard drops the empty), which is *exactly* the current behavior. The very next file event or git poll publishes a properly-shaped frame (wrapper struct for FILESYSTEM per [D08], spliced object for GIT per [D03]) and the subscriber receives it via the normal watch-channel `changed()` path.

The net result is that the three watch channels are initialized identically to today (empty payload), the router strips those empty frames before encoding, and every subsequent frame on each channel carries `workspace_key` as its first field via the mechanisms in [D03] and [D08]. No seeding step is needed; the tugdeck presence filter never encounters an empty frame; bit-identical behavior is preserved.

#### Spec S02: WorkspaceRegistry public API {#s02-registry-api}

```rust
pub struct WorkspaceRegistry {
    inner: Mutex<HashMap<WorkspaceKey, Arc<WorkspaceEntry>>>,
}

impl WorkspaceRegistry {
    pub fn new() -> Self { ... }

    /// Look up or create the workspace entry for `project_dir`.
    ///
    /// Canonicalizes `project_dir` via `PathResolver::watch_path`, consults the
    /// map, and either returns the existing `Arc<WorkspaceEntry>` or constructs
    /// a new one and inserts it.
    ///
    /// `cancel` is the lifetime token used for the spawned feed tasks; in W1
    /// main.rs passes its existing process-scoped token so the cancellation
    /// tree is identical to today.
    ///
    /// Returns `Arc<WorkspaceEntry>` directly — **not** `Result<_, _>`. All
    /// underlying operations (`PathResolver::new`, `FileWatcher::new`,
    /// `FileWatcher::create_sender`, `walk_directory`, `FilesystemFeed::new`,
    /// `FileTreeFeed::new`, `GitFeed::new`, `tokio::spawn`) are infallible, so
    /// W1 has no failure mode to encode. W2 reintroduces a `Result` wrapper
    /// when real failure modes exist (release/teardown contention, task-panic
    /// detection, etc.). This matches [D04]'s principle of not building
    /// untested lifecycle code — an unreachable error variant under `-D warnings`
    /// is exactly the kind of lifecycle code [D04] rejects.
    pub fn get_or_create(
        &self,
        project_dir: &Path,
        cancel: CancellationToken,
    ) -> Arc<WorkspaceEntry> { ... }
}
```

No `WorkspaceError` enum in W1. No `release` method. No `drop_entry` method. No public accessor on `inner`. The registry is small and exactly what W1 needs; W2 will extend both the failure model and the lifecycle surface together.

**Lock discipline (correct-by-construction for W2):** The `Mutex` is held across the entire check-construct-insert sequence inside `get_or_create`. That is, the implementation acquires `self.inner.lock()`, checks for an existing entry under the key, and if none exists calls `WorkspaceEntry::new(...)` *while still holding the lock*, then inserts and returns. `std::sync::Mutex` is acceptable (as opposed to `tokio::sync::Mutex`) because `WorkspaceEntry::new` is synchronous and never `.await`s while holding the lock — the `tokio::spawn` calls inside it do not await. In W1 the `get_or_create` call count is exactly one (the `main.rs` startup call), so the blocking cost of constructing four tasks under lock is irrelevant. W2 inherits this discipline unchanged when multi-session spawns call `get_or_create` concurrently on the same `project_dir`: the held-across-construct pattern is the simplest correct-by-construction approach, eliminating the TOCTOU race that a fast-path (check under lock, drop, construct, re-acquire, insert) implementation would otherwise allow — where two concurrent callers for the same workspace both miss, both construct, both insert, and the second insert clobbers the first, orphaning a set of spawned tasks and leaking a `FileWatcher` OS handle. Specifying this now prevents a latent race from shipping in W2 as an unreproducible bug.

#### Spec S03: splice_workspace_key helper {#s03-splice-workspace-key}

```rust
// in feeds/code.rs, immediately below splice_tug_session_id

/// Splice `"workspace_key":"<key>"` as the first field of a JSON line.
///
/// Semantics mirror `splice_tug_session_id` exactly: scan for the first `{`
/// byte, splice immediately after, handle empty-object case, log a warning
/// and pass through unchanged if no `{` is found.
pub fn splice_workspace_key(line: &[u8], workspace_key: &str) -> Vec<u8> { ... }
```

Tests in `feeds/code.rs` mirror the `splice_tug_session_id` tests: empty input passes through, no brace passes through with warning, leading whitespace is handled, empty object produces `{"workspace_key":"..."}`, realistic payload has `workspace_key` as first field.

**Note on ordering with `tug_session_id`:** W1's three workspace-scoped feeds (FILESYSTEM / FILETREE / GIT) do *not* carry `tug_session_id`; only `CODE_OUTPUT` does. So there is no splice-ordering concern in W1 — each of the W1 feeds calls only `splice_workspace_key` and the field is unambiguously first. CODE_OUTPUT continues to call only `splice_tug_session_id`. In a hypothetical future where a single feed needed both fields spliced, ordering would need to be defined. That's not W1's problem.

#### Spec S04: Updated feed constructor signatures {#s04-feed-constructor-signatures}

```rust
// BEFORE
FilesystemFeed::new(watch_dir: PathBuf, event_tx: broadcast::Sender<Vec<FsEvent>>)
FileTreeFeed::new(root: PathBuf, initial_files: BTreeSet<String>, truncated: bool,
                  event_tx: broadcast::Sender<Vec<FsEvent>>, query_rx: mpsc::Receiver<FileTreeQuery>)
GitFeed::new(repo_dir: PathBuf)

// AFTER
FilesystemFeed::new(watch_dir: PathBuf, event_tx: broadcast::Sender<Vec<FsEvent>>,
                    workspace_key: Arc<str>)
FileTreeFeed::new(root: PathBuf, initial_files: BTreeSet<String>, truncated: bool,
                  event_tx: broadcast::Sender<Vec<FsEvent>>, query_rx: mpsc::Receiver<FileTreeQuery>,
                  workspace_key: Arc<str>)
GitFeed::new(repo_dir: PathBuf, workspace_key: Arc<str>)
```

The `workspace_key: Arc<str>` parameter is appended to each constructor so existing positional arguments keep their meaning. Each feed stores the key as a private field and reads it in its `run()` loop at the publish site.

**FileTreeFeed and GitFeed** use `splice_workspace_key(&serialized_bytes, &self.workspace_key)` on the payload they are about to publish, exactly as [D03] describes. Their underlying payload types (`FileTreeSnapshot`, `GitStatus`) are JSON objects, so the splice prepends `workspace_key` as the first field.

**FilesystemFeed** does **not** call `splice_workspace_key`. Its existing payload is a bare JSON array (`Vec<FsEvent>`), which is incompatible with an object-level splice. Per [D08], FilesystemFeed instead serializes a wrapper struct:

```rust
#[derive(Serialize)]
struct FilesystemBatch<'a> {
    workspace_key: &'a str,
    events: &'a [FsEvent],
}
```

and writes `serde_json::to_vec(&FilesystemBatch { workspace_key: &self.workspace_key, events: &batch })` as the frame payload. The resulting wire shape is `{"workspace_key":"...","events":[...]}` with `workspace_key` as the first field by construction.

#### Spec S05: Tugdeck CardRegistration addition {#s05-card-registration-addition}

```typescript
// in tugdeck/src/card-registry.ts

export interface CardRegistration {
  // ... existing fields unchanged ...

  /**
   * Optional filter applied to every decoded frame before the card's
   * FeedStore accepts it. For cards subscribing to workspace-scoped feeds
   * (FILETREE / FILESYSTEM / GIT), this filter validates the workspace
   * tagging. In W1 it's a presence check; in W2 it becomes a value check
   * against the card's own workspace_key learned from spawn_session.
   */
  workspaceKeyFilter?: FeedStoreFilter;
}

/**
 * W1 presence-check filter: asserts that a decoded frame is an object
 * with a `workspace_key` field. Does not compare the value.
 */
export const presentWorkspaceKey: FeedStoreFilter = (_id, decoded) =>
  typeof decoded === "object" && decoded !== null && "workspace_key" in decoded;
```

`Tugcard` does **not** have direct access to the `CardRegistration` object at `FeedStore` construction — the registration is resolved by `DeckCanvas` (`tugdeck/src/components/chrome/deck-canvas.tsx`), which calls `getRegistration(componentId)` and then renders `<Tugcard ...>` with selected props. To thread the filter through:

1. Add a new optional prop `filter?: FeedStoreFilter` to `TugcardProps` in `tug-card.tsx`.
2. In `Tugcard`, at the `FeedStore` construction site (`tugdeck/src/components/tugways/tug-card.tsx` around lines 1030–1032), pass `filter` (or the wrapper for the `decode`-aware branch) as the 4th argument to `new FeedStore(conn, feedIds, decoder, filter)`.
3. In `DeckCanvas` (`tugdeck/src/components/chrome/deck-canvas.tsx` around line 467, inside `renderContent`), read `registration.workspaceKeyFilter` and pass it through: `<Tugcard ... filter={registration.workspaceKeyFilter} />`.

If `registration.workspaceKeyFilter` is unset, the prop is `undefined`, the 4th argument to `FeedStore` is `undefined`, and `FeedStore` is constructed without a filter exactly as today.

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tugrust/crates/tugcast/src/feeds/workspace_registry.rs` | `WorkspaceKey`, `WorkspaceEntry`, `WorkspaceRegistry`, two unit tests. No `WorkspaceError` enum in W1 — `get_or_create` returns `Arc<WorkspaceEntry>` directly. |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `WorkspaceKey` | struct (newtype) | `feeds/workspace_registry.rs` | Wraps `Arc<str>`; `PartialEq + Eq + Hash + Clone + Debug`. Provides `.as_str()` and `.arc()` view methods. |
| `WorkspaceEntry` | struct | `feeds/workspace_registry.rs` | Shape per [S01]. |
| `WorkspaceRegistry` | struct | `feeds/workspace_registry.rs` | API per [S02]. No `release` in W1. `get_or_create` returns `Arc<WorkspaceEntry>` directly (no `Result` wrapper — W2 reintroduces it when release/teardown adds real failure modes). |
| `splice_workspace_key` | fn | `feeds/code.rs` | Helper per [S03]. |
| `FilesystemFeed::new` | fn (modify) | `feeds/filesystem.rs` | Add `workspace_key: Arc<str>` parameter. |
| `FileTreeFeed::new` | fn (modify) | `feeds/filetree.rs` | Add `workspace_key: Arc<str>` parameter. |
| `GitFeed::new` | fn (modify) | `feeds/git.rs` | Add `workspace_key: Arc<str>` parameter. |
| `feeds::mod` | mod (modify) | `feeds/mod.rs` | Add `pub mod workspace_registry;`. |
| `main::run` (or equivalent) | fn (modify) | `main.rs` | Replace the eager block at [#eager-feed-construction-block] with `WorkspaceRegistry::new()` + `get_or_create`. |
| `CardRegistration.workspaceKeyFilter` | interface field | `tugdeck/src/card-registry.ts` | Optional, per [S05]. |
| `presentWorkspaceKey` | const | `tugdeck/src/card-registry.ts` | W1 presence-check filter. |
| `TugcardProps.filter` | interface field (new) | `tugdeck/src/components/tugways/tug-card.tsx` | New optional `filter?: FeedStoreFilter` prop; passed as 4th arg to `FeedStore` constructor. |
| `Tugcard` / `tug-card.tsx` FeedStore construction | modify | `tugdeck/src/components/tugways/tug-card.tsx` | Read `props.filter` and pass as 4th arg to `FeedStore` constructor. |
| `DeckCanvas` `<Tugcard>` invocation | modify | `tugdeck/src/components/chrome/deck-canvas.tsx` | Pass `filter={registration.workspaceKeyFilter}` into Tugcard in the `renderContent` callback. |

#### New tests {#new-tests}

| Test | Location | Purpose |
|------|----------|---------|
| `test_workspace_registry_bootstrap_construction` | `feeds/workspace_registry.rs` | Fresh path → entry with four live spawned tasks (file_watcher + 3 feeds) and non-empty workspace_key. |
| `test_workspace_registry_deduplicates_canonical_paths` | `feeds/workspace_registry.rs` | Two canonicalizing inputs → `Arc::ptr_eq` equal. |
| `test_splice_workspace_key_empty_input` | `feeds/code.rs` | Mirror of `test_splice_empty_input_passes_through`. |
| `test_splice_workspace_key_no_open_brace` | `feeds/code.rs` | Mirror of `test_splice_no_open_brace_passes_through`. |
| `test_splice_workspace_key_leading_whitespace` | `feeds/code.rs` | Mirror of `test_splice_leading_whitespace_finds_brace`. |
| `test_splice_workspace_key_empty_object` | `feeds/code.rs` | Mirror of `test_splice_empty_object`. |
| `test_splice_workspace_key_realistic_payload` | `feeds/code.rs` | Realistic FileTreeSnapshot-shaped JSON. |
| `test_workspace_key_spliced_into_filesystem_frame` | `feeds/filesystem.rs` | Exercise publish path; assert `workspace_key` is first field in the watch-channel frame. |
| `test_workspace_key_spliced_into_filetree_frame` | `feeds/filetree.rs` | Same, for FileTreeFeed. |
| `test_workspace_key_spliced_into_git_frame` | `feeds/git.rs` | Same, for GitFeed. Uses a temp git repo (pattern already in place in existing tests). |

---

### Documentation Plan {#documentation-plan}

- [ ] Doc comment on `WorkspaceKey` explaining canonicalization via `PathResolver::watch_path` ([D01]).
- [ ] Doc comment on `WorkspaceRegistry` explaining the W1 "bootstrap only, no release" scope and pointing at W2 for teardown ([D04]).
- [ ] Doc comment on `splice_workspace_key` noting it mirrors `splice_tug_session_id` ([D03], [S03]).
- [ ] Doc comment on `workspaceKeyFilter` field in `card-registry.ts` noting the W1 presence-check semantics and the W2 value-check plan ([D05]).

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit** | Registry dedup, splice helper shape, per-feed publish path | Core W1 verification |
| **Integration** | Existing feed integration tests (`test_filesystem_feed_integration`, etc.) | Regression — must continue to pass unchanged after constructor-signature updates |
| **Behavior preservation** | Manual A/B against a known repo using `tugcast --dir` pre- and post-W1 | Belt-and-suspenders smoke-test of exit criterion 2 |

---

### Execution Steps {#execution-steps}

> **Commit discipline:** The committer-agent commits after each step's checkpoint passes. Every intermediate commit compiles clean under `-D warnings`. No amend, no squash, no `--no-verify`.

#### Step 1: Add `splice_workspace_key` helper to `feeds/code.rs` {#step-1}

**Commit:** `feat(tugcast): add splice_workspace_key helper mirroring splice_tug_session_id`

**References:** [D03] Splice at publish site, Spec S03 (#s03-splice-workspace-key), (#strategy)

**Artifacts:** (what this step produces/changes)
- Modified `tugrust/crates/tugcast/src/feeds/code.rs`: new `pub fn splice_workspace_key(line: &[u8], workspace_key: &str) -> Vec<u8>` next to `splice_tug_session_id`, plus five unit tests mirroring the existing splice tests.

**Tasks:**
- [ ] Add `splice_workspace_key` below `splice_tug_session_id` in `feeds/code.rs`. Copy the scan-for-first-`{` pattern verbatim; substitute the field name. Add a doc comment pointing at `splice_tug_session_id` as the pattern source.
- [ ] Add five unit tests in the existing `mod tests` block: `test_splice_workspace_key_empty_input`, `test_splice_workspace_key_no_open_brace`, `test_splice_workspace_key_leading_whitespace`, `test_splice_workspace_key_empty_object`, `test_splice_workspace_key_realistic_payload`.

**Tests:**
- [ ] Five new unit tests above, all green.

**Checkpoint:**
- [ ] `cd tugrust && cargo build -p tugcast` — compiles clean under `-D warnings`.
- [ ] `cd tugrust && cargo nextest run -p tugcast feeds::code` — the new tests pass and the existing splice tests still pass.

---

#### Step 2: Create `feeds/workspace_registry.rs` with types and bootstrap-only registry {#step-2}

**Depends on:** #step-1

**Commit:** `feat(tugcast): add WorkspaceRegistry with bootstrap-only get_or_create`

**References:** [D01] PathResolver canonicalization, [D02] Arc<str> on feeds, [D04] no release in W1, [D06] no refcount field, Spec S01 (#s01-workspace-entry-shape), Spec S02 (#s02-registry-api), Risk R01 (#r01-filewatcher-swap), Risk R03 (#r03-test-task-leaks), (#eager-feed-construction-block)

**Artifacts:** (what this step produces/changes)
- New file `tugrust/crates/tugcast/src/feeds/workspace_registry.rs`: `WorkspaceKey`, `WorkspaceEntry`, `WorkspaceRegistry`, construction body, two unit tests. **No `WorkspaceError` enum** — `get_or_create` returns `Arc<WorkspaceEntry>` directly.
- Modified `tugrust/crates/tugcast/src/feeds/mod.rs`: add `pub mod workspace_registry;`.

**Tasks:**
- [ ] Create `workspace_registry.rs` with the types per [S01] and [S02]. Use `PathResolver::new(project_dir).watch_path().to_string_lossy().into_owned()` for the canonical string, per [D01]. **Do not define a `WorkspaceError` enum** — all underlying operations are infallible in W1, so `get_or_create` returns `Arc<WorkspaceEntry>` directly. Do not import `thiserror::Error`. Add `#![allow(dead_code)]` (or a module-level `#[allow(dead_code)]`) at the top with a one-line comment: `// Removed in #step-4 when main.rs starts calling the registry.`
- [ ] Declare `pub mod workspace_registry;` in `feeds/mod.rs`.
- [ ] Implement `WorkspaceRegistry::new` and `WorkspaceRegistry::get_or_create` per [S02]. `get_or_create`'s signature is `pub fn get_or_create(&self, project_dir: &Path, cancel: CancellationToken) -> Arc<WorkspaceEntry>` — **no `Result` wrapper**. It canonicalizes `project_dir` via `PathResolver::new(project_dir).watch_path()`, wraps the resulting string into a `WorkspaceKey`, and looks it up in the mutex-guarded `HashMap`. On a miss it constructs a fresh `WorkspaceEntry`, inserts it into the map, and returns `Arc<WorkspaceEntry>`.
- [ ] Implement `WorkspaceEntry::new` as a private constructor taking `(project_dir: PathBuf, workspace_key: WorkspaceKey, cancel: CancellationToken)`. `WorkspaceKey` already wraps an `Arc<str>` (per [D01] and [Spec S01](#s01-workspace-entry-shape)), so feed constructors will later be able to obtain a cheap handle via `workspace_key.arc()`. `WorkspaceEntry::new` creates `FileWatcher`, creates `fs_broadcast_tx` via `FileWatcher::create_sender()`, walks the directory to seed the initial filetree, creates the three watch channels and the `ft_query_tx`/`ft_query_rx` pair, and spawns the four tasks (`file_watcher.run`, `fs_feed.run`, `ft_feed.run`, `git_feed.run`) with `cancel.clone()`. **In Step 2, `WorkspaceEntry::new` calls the current pre-Step-3 `FilesystemFeed::new`, `FileTreeFeed::new`, `GitFeed::new` signatures — the `WorkspaceKey` is stored on the `WorkspaceEntry` but is *not yet* passed to the feed constructors.** [#step-3] updates the feed signatures and adds the pass-through (via `workspace_key.arc()`). The module-level `#[allow(dead_code)]` absorbs any "unread accessor" warnings until [#step-3] consumes the `arc()` method; [#step-4] removes the allow once main.rs starts calling the registry. **Note:** the three watch channels are still initialized with empty payloads (`Frame::new(FeedId::*, vec![])`) in Step 2 — exactly as today in main.rs. The pre-seeding with a workspace-key-bearing payload is introduced in [#step-3] alongside the feed-signature changes, so that Step 2 remains a pure structural move and Step 3 is the only step that touches wire-shape.
- [ ] Add `test_workspace_registry_bootstrap_construction` — use `tempfile::TempDir` as the project dir; build a `CancellationToken`; bind the registry explicitly so it can be dropped on cleanup: `let registry = WorkspaceRegistry::new(); let entry = registry.get_or_create(dir.path(), cancel.clone());` (no `.unwrap()` — the return type is `Arc<WorkspaceEntry>` directly per [S02]). Assert the four task handles are not finished (`!handle.is_finished()` on each of `file_watcher_task`, `filesystem_task`, `filetree_task`, `git_task`); assert the `workspace_key` is non-empty. **At the end of the test**, clean up the spawned tokio tasks and the `FileWatcher`'s OS handle to avoid leaking across nextest's parallel runner: `cancel.cancel();` (so the four spawned tasks observe shutdown), then `let _ = tokio::time::timeout(Duration::from_secs(2), async { tokio::task::yield_now().await }).await;` to give the runtime a bounded window to observe cancellation, then `drop(registry);` as an explicit final step. Note: dropping the local `entry` binding alone would *not* release the `WorkspaceEntry` — the registry's internal `HashMap` still holds an `Arc<WorkspaceEntry>` under the canonicalized key, so the entry's `FileWatcher` OS handle (FSEvents on macOS / inotify on Linux) lives until the registry itself is dropped. `release()` is forbidden in W1 per [D04], so the test-scoped drop of `registry` is the only correct path. This mirrors the spirit of the existing cleanup pattern in `test_filesystem_feed_integration` at `feeds/filesystem.rs` (`cancel.cancel();` + bounded timeout) while correctly accounting for the registry-held Arc (see [R03] below).
- [ ] Add `test_workspace_registry_deduplicates_canonical_paths` — create a `TempDir` at `tmp`. Call `get_or_create` twice with two textually-distinct inputs that canonicalize to the same directory: e.g., `let first = registry.get_or_create(tmp.path(), cancel.clone());` and `let second = registry.get_or_create(&tmp.path().join("..").join(tmp.path().file_name().unwrap()), cancel.clone());` (no `.unwrap()` on either call). Assert `Arc::ptr_eq(&first, &second)`. Assert the map contains exactly one entry. This test exercises the actual dedup logic — exact string equality alone would not produce the correct result for the second input, so canonicalization must be working. **At the end of the test**, call `cancel.cancel();` (so the four spawned tasks in the single deduped entry observe shutdown), then `let _ = tokio::time::timeout(Duration::from_secs(2), async { tokio::task::yield_now().await }).await;` to give the runtime a bounded window to observe cancellation, then `drop(registry);` as an explicit final step to release the map's `Arc<WorkspaceEntry>`, which drops the `WorkspaceEntry` and with it the `FileWatcher` OS handle (FSEvents on macOS / inotify on Linux). Note: dropping the local `first` and `second` bindings alone would *not* release the entry, because the registry's internal `HashMap` still holds an `Arc<WorkspaceEntry>` under the canonicalized key — only dropping the registry (or, in W2, removing the entry via `release()`) actually frees the entry and its OS handle. In W1, `release()` is forbidden per [D04], so the test-scoped drop of `registry` is the only correct cleanup path. This prevents tokio task and `FileWatcher` FSEvents/inotify handle leaks across parallel test runs (see [R03]).

**Tests:**
- [ ] `test_workspace_registry_bootstrap_construction` — green.
- [ ] `test_workspace_registry_deduplicates_canonical_paths` — green.

**Checkpoint:**
- [ ] `cd tugrust && cargo build -p tugcast` — compiles clean under `-D warnings` with no unused-import or dead-code warnings.
- [ ] `cd tugrust && cargo nextest run -p tugcast feeds::workspace_registry` — both new tests pass.
- [ ] `cd tugrust && cargo nextest run -p tugcast` — full tugcast test suite green (nothing else should have moved yet).

---

#### Step 3: Thread `Arc<str>` workspace_key through the three feed constructors and publish paths {#step-3}

**Depends on:** #step-2

**Commit:** `feat(tugcast): splice workspace_key into filesystem/filetree/git frames`

**References:** [D02] Arc<str> on feeds, [D03] Splice at publish site, [D07] Exit criterion 5 validated by unit tests, [D08] FilesystemFeed wrapper struct, Spec S04 (#s04-feed-constructor-signatures), Spec S03 (#s03-splice-workspace-key), (#end-to-end-flow)

**Artifacts:** (what this step produces/changes)
- Modified `feeds/filesystem.rs`: `FilesystemFeed::new` gains `workspace_key: Arc<str>`. A new private `#[derive(Serialize)] struct FilesystemBatch<'a> { workspace_key: &'a str, events: &'a [FsEvent] }` is added. `run()` serializes `FilesystemBatch { workspace_key: &self.workspace_key, events: &batch }` instead of `&batch`, producing a JSON object with `workspace_key` as the first field by construction ([D08]). FilesystemFeed does **not** call `splice_workspace_key`.
- Modified `feeds/filetree.rs`: `FileTreeFeed::new` gains `workspace_key: Arc<str>`; `send_response` is converted from an associated function (`fn send_response(watch_tx, snapshot)`) to a `&self` method (`fn send_response(&self, watch_tx, snapshot)`), and the two callsites in `run()` change from `Self::send_response(...)` to `self.send_response(...)`. The new method body calls `splice_workspace_key(&json, &self.workspace_key)` on the serialized snapshot before the watch channel write.
- Modified `feeds/git.rs`: `GitFeed::new` gains `workspace_key: Arc<str>`; `run()` calls `splice_workspace_key(&json, &self.workspace_key)` on the serialized status JSON before constructing the `Frame`.
- Updated test callsites in each of the three feed test modules — existing tests pass a fixture key `"/tmp/test".into()` (or similar) as the new last argument. Existing frame-parsing assertions that previously read `Vec<FsEvent>` / `FileTreeSnapshot` / `GitStatus` directly are updated to accommodate the new shape (wrapper struct for filesystem; object with prepended `workspace_key` for filetree/git).
- Updated `test_filesystem_feed_integration` at `feeds/filesystem.rs:151`: replace `let events: Vec<FsEvent> = serde_json::from_slice(&frame.payload).unwrap();` with deserialization into a local `#[derive(Deserialize)] struct FilesystemBatchOwned { workspace_key: String, events: Vec<FsEvent> }` (or equivalent `serde_json::Value` parsing that extracts the `events` array). Assert that `workspace_key` is non-empty and that `events` carries the expected file events.
- Modified `feeds/workspace_registry.rs`: `WorkspaceEntry::new` now passes `workspace_key.arc()` to each feed constructor (per [D02] and [Spec S01](#s01-workspace-entry-shape)). The three watch channels remain initialized with empty-payload `Frame::new(FeedId::*, vec![])` values exactly as in today's `main.rs` and exactly as in Step 2 — no seeding with a workspace-key-bearing payload is performed. Per the amended [Spec S01](#s01-workspace-entry-shape), the tugcast router already strips empty-payload frames from the LIVE-state initial snapshot send, so the tugdeck presence filter ([D05]) never observes an empty frame on the wire, and seeding would actively introduce a new FILESYSTEM wire frame on client connect that today's build does not produce (breaking Success Criterion 2). For FILETREE, `FileTreeFeed::run` already publishes its initial snapshot as the first action inside the spawned task, so the first real frame on the channel is a properly spliced `FileTreeSnapshot` well before any client can race to subscribe.
- New tests `test_workspace_key_spliced_into_filesystem_frame`, `test_workspace_key_spliced_into_filetree_frame`, `test_workspace_key_spliced_into_git_frame` — one per feed test module, exercising the publish path and asserting the resulting frame JSON has `workspace_key` as its first field. (Note: the filesystem test name uses "spliced" for symmetry with the other two, but mechanically FilesystemFeed uses a wrapper struct per [D08], not the splice helper.)

**Tasks:**
- [ ] `feeds/filesystem.rs` — add `workspace_key: Arc<str>` field and constructor parameter. Add private `FilesystemBatch<'a>` wrapper struct with `#[derive(Serialize)]` and field order `workspace_key`, `events`. In `run()`, change `serde_json::to_vec(&batch)` to `serde_json::to_vec(&FilesystemBatch { workspace_key: &self.workspace_key, events: &batch })`. Do NOT call `splice_workspace_key` in filesystem.rs.
- [ ] `feeds/filesystem.rs` — update `test_filesystem_feed_integration` to deserialize the new wrapper shape. Either add a local `#[derive(Deserialize)] struct FilesystemBatchOwned { workspace_key: String, events: Vec<FsEvent> }` inside the test, or parse as `serde_json::Value` and read `["events"]` as an array. Assert `workspace_key == "/tmp/test"` (or whatever fixture key is passed) and that `events` is non-empty.
- [ ] `feeds/filesystem.rs` — update `test_feed_id_and_name` to pass a fixture `Arc<str>` as the new last argument to `FilesystemFeed::new`.
- [ ] `feeds/filetree.rs` — add `workspace_key: Arc<str>` field and constructor parameter. **Convert `send_response` from an associated function to a `&self` method.** Its current signature is `fn send_response(watch_tx: &watch::Sender<Frame>, snapshot: &FileTreeSnapshot) -> Result<(), ()>` and it is called from `run()` at two callsites as `Self::send_response(&watch_tx, &initial)` and `Self::send_response(&watch_tx, &response)`. Change the signature to `fn send_response(&self, watch_tx: &watch::Sender<Frame>, snapshot: &FileTreeSnapshot) -> Result<(), ()>` and update both callsites in `run()` from `Self::send_response(...)` to `self.send_response(...)`. This is a zero-friction conversion because `run()` already binds `mut self`. Inside the new method body, after `let json = serde_json::to_vec(snapshot).map_err(|_| ())?;`, apply `let json = splice_workspace_key(&json, &self.workspace_key);` before the `watch_tx.send_modify(...)` call. Without this refactor the task "call `splice_workspace_key(&json, &self.workspace_key)` inside `send_response`" would fail to compile because `self.workspace_key` is not accessible from an associated function.
- [ ] `feeds/git.rs` — add `workspace_key: Arc<str>` field and constructor parameter. The publish path is inside `run()` at the "git status updated" branch; apply the same `splice_workspace_key` call immediately before the `Frame::new(FeedId::GIT, json)` line.
- [ ] Update every existing test in the three feed test modules that calls one of the `new` constructors: add the fixture `Arc<str>` key as the last argument. Inspect each test's frame-parsing path and update the assertions: for filetree/git, the `workspace_key` field is now present in the parsed object (add a check or a normalization step so existing shape assertions still pass); for filesystem, the payload is now a wrapper object, so the parse type changes from `Vec<FsEvent>` to the wrapper.
- [ ] Update `feeds/workspace_registry.rs::WorkspaceEntry::new` to pass `workspace_key.arc()` (which returns a cheap `Arc<str>` clone) to each feed constructor. **Leave the three watch-channel initializers as empty-payload `Frame::new(FeedId::*, vec![])` — do not seed them with workspace-key-bearing values.** Per the amended [Spec S01](#s01-workspace-entry-shape), the tugcast router strips empty-payload frames from the LIVE-state initial snapshot send, so the tugdeck presence filter never observes an empty frame on the wire. Seeding would break bit-identical FILESYSTEM behavior by introducing a new wire frame on client connect (a `{"workspace_key":"...","events":[]}` wrapper object) that today's build does not produce. The `FilesystemBatch` wrapper struct is still introduced in this step per [D08], but its only use site is `FilesystemFeed::run`'s publish path — it is private to `feeds/filesystem.rs` and does not need to be reachable from `workspace_registry.rs`.
- [ ] Add `test_workspace_key_spliced_into_filetree_frame` and `test_workspace_key_spliced_into_git_frame`. Each constructs its feed with a fixture key, spawns its task against the existing test fixtures, waits for the first publish, reads the watch channel, parses the frame payload via `serde_json::from_slice::<serde_json::Value>`, and asserts `parsed.as_object().unwrap().keys().next().unwrap() == "workspace_key"` and `parsed["workspace_key"] == "<fixture-key>"`.
- [ ] Add `test_workspace_key_spliced_into_filesystem_frame`. Same structure as the other two, but note in a comment that FilesystemFeed produces the shape via a wrapper struct per [D08], not via the splice helper. The assertion is identical: `workspace_key` is the first field of the parsed object.

**Tests:**
- [ ] Three new tests above, all green.
- [ ] All existing feed tests continue to pass under the new constructor signatures.

**Checkpoint:**
- [ ] `cd tugrust && cargo build -p tugcast` — compiles clean under `-D warnings`.
- [ ] `cd tugrust && cargo nextest run -p tugcast feeds::filesystem feeds::filetree feeds::git feeds::workspace_registry feeds::code` — all green.
- [ ] `cd tugrust && cargo nextest run -p tugcast` — full tugcast test suite green.

---

#### Step 4: Replace main.rs eager feed block with `WorkspaceRegistry` bootstrap {#step-4}

**Depends on:** #step-3

**Commit:** `refactor(tugcast): route bootstrap feeds through WorkspaceRegistry`

**References:** [D04] no release in W1, Spec S01 (#s01-workspace-entry-shape), Spec S02 (#s02-registry-api), (#eager-feed-construction-block), (#end-to-end-flow), Risk R01 (#r01-filewatcher-swap)

**Artifacts:** (what this step produces/changes)
- Modified `tugrust/crates/tugcast/src/main.rs`: the eager feed-construction block at [#eager-feed-construction-block] is replaced by `let registry = WorkspaceRegistry::new();` followed by `let bootstrap = registry.get_or_create(&watch_dir, cancel.clone());` (no `?` — `get_or_create` returns `Arc<WorkspaceEntry>` directly in W1 per [S02]). The router wiring that previously used `fs_watch_rx` / `ft_watch_rx` / `git_watch_rx` / `ft_query_tx` now reads those receivers/senders from `bootstrap.*`. The three `tokio::spawn` calls for the feed tasks are removed from main.rs — the registry's entry constructor now owns them.
- The FILETREE_QUERY adapter task remains in main.rs; its target sender becomes `bootstrap.ft_query_tx.clone()`.

**Tasks:**
- [ ] **Move `let cancel = CancellationToken::new();` earlier in `main.rs`.** In the current main.rs this declaration is at line 293, *after* the eager feed-construction block at lines 200–250. The new `WorkspaceRegistry::get_or_create` call needs `cancel.clone()` as an argument, so `cancel` must be declared *before* the registry call. Move the `let cancel = CancellationToken::new();` line to immediately before the new `let registry = WorkspaceRegistry::new();` call. Before making this move, grep the removed region (old positions 200–293) for any reference to `cancel` and confirm there are none — the existing feed block uses local `cancel` clones inside its own `tokio::spawn` closures, all of which are being deleted in this step.
- [ ] In `main.rs`, replace the block identified at [#eager-feed-construction-block] (filesystem / filetree / git construction + the four feed `tokio::spawn` calls) with `let registry = WorkspaceRegistry::new();` followed by `let bootstrap = registry.get_or_create(&watch_dir, cancel.clone());` (plain binding, no `?`). `get_or_create` is infallible in W1 per [S02]. There is no `WorkspaceError` to propagate; do not wrap the result in `?` or in `.unwrap()`.
- [ ] Update `feed_router.add_snapshot_watches(vec![...])` to use `bootstrap.fs_watch_rx.clone()`, `bootstrap.ft_watch_rx.clone()`, `bootstrap.git_watch_rx.clone()` (plus the existing stats and defaults watches, unchanged).
- [ ] Update the FILETREE_QUERY adapter `tokio::spawn` to forward parsed queries into `bootstrap.ft_query_tx.clone()` instead of the previously locally constructed `ft_query_tx`.
- [ ] Keep `registry` and `bootstrap` alive for the lifetime of `main` (e.g., `let _registry = registry; let _bootstrap = bootstrap;` at the end of the setup block if necessary, though typically the compiler will keep them via the `let` bindings).
- [ ] Delete the now-unused `FileWatcher::new`, `FileWatcher::create_sender`, `FilesystemFeed::new`, `FileTreeFeed::new`, `GitFeed::new` calls and the four feed `tokio::spawn` calls from `main.rs`. Delete any local variables (`file_watcher`, `fs_broadcast_tx`, `fs_feed`, `initial_files`, `ft_truncated`, `ft_query_tx`, `ft_feed`, `git_feed`) that are no longer referenced.
- [ ] Remove `#[allow(dead_code)]` from `workspace_registry.rs` if it was introduced in [#step-2].

**Tests:**
- [ ] No new tests in this step — the behavior is covered by the existing integration tests (`test_filesystem_feed_integration`, `response_serializes_to_spec_s01b`, git feed tests) and the workspace_registry unit tests.

**Checkpoint:**
- [ ] `cd tugrust && cargo build -p tugcast` — compiles clean under `-D warnings`. No unused-import warnings, no dead-code warnings.
- [ ] `cd tugrust && cargo nextest run -p tugcast` — full tugcast test suite green.
- [ ] `cd tugrust && cargo build --workspace` — the whole workspace compiles clean.

---

#### Step 5: Tugdeck — add `workspaceKeyFilter` field and wire it through `tug-card.tsx` {#step-5}

**Depends on:** #step-4

**Commit:** `feat(tugdeck): add workspaceKeyFilter on registerCard and wire to FeedStore`

**References:** [D05] tugdeck presence filter, Spec S05 (#s05-card-registration-addition), (#end-to-end-flow)

**Artifacts:** (what this step produces/changes)
- Modified `tugdeck/src/card-registry.ts`: add optional `workspaceKeyFilter?: FeedStoreFilter` to `CardRegistration`; export `presentWorkspaceKey: FeedStoreFilter`.
- Modified `tugdeck/src/components/tugways/tug-card.tsx`: add optional `filter?: FeedStoreFilter` to `TugcardProps`; at the `FeedStore` construction site (around lines 1030–1032), pass the `filter` prop as the 4th argument to `new FeedStore(conn, feedIds, decoder, filter)`. If `filter` is `undefined`, `FeedStore` is constructed exactly as today.
- Modified `tugdeck/src/components/chrome/deck-canvas.tsx`: in the `renderContent` callback around line 467, add `filter={registration.workspaceKeyFilter}` to the `<Tugcard>` JSX invocation so the registered filter is threaded through to `Tugcard`.
- Modified registrations for any cards that subscribe to FILETREE / FILESYSTEM / GIT feeds (git-card, any filetree/filesystem card that uses the `<Tugcard>` FeedStore plumbing): adopt `workspaceKeyFilter: presentWorkspaceKey`.
- Modified `tugdeck/src/components/tugways/cards/gallery-prompt-input.tsx`: this file constructs a `FeedStore` directly at module scope (`new FeedStore(connection, [FeedId.FILETREE])` in `getFileCompletionProvider` around line 157), bypassing the `<Tugcard>` plumbing entirely. Because the `CardRegistration → DeckCanvas → <Tugcard filter> → FeedStore` chain does not reach this codepath, adding `workspaceKeyFilter` to its registration would be a silent no-op. Instead, update the inline construction to pass `presentWorkspaceKey` explicitly as the 4th argument: `new FeedStore(connection, [FeedId.FILETREE], undefined, presentWorkspaceKey)`. This is a two-line change (import + the `undefined, presentWorkspaceKey` arguments) and makes filter exercise uniform across both the Tugcard path and the inline-FeedStore path. Without it, the filetree feed reaching gallery-prompt-input is never filtered.

**Tasks:**
- [ ] Add the optional `workspaceKeyFilter?: FeedStoreFilter` field and the `presentWorkspaceKey` helper to `card-registry.ts`. Import `FeedStoreFilter` from `../lib/feed-store`.
- [ ] In `tug-card.tsx`, add `filter?: FeedStoreFilter` to `TugcardProps` (import `FeedStoreFilter` from `../../lib/feed-store`). Destructure `filter` from props and pass it as the 4th argument to both `new FeedStore(...)` construction branches. **Because the `FeedStore` constructor signature is `(connection, feedIds, decode?, filter?)`, passing a 4th positional argument requires explicitly passing the 3rd.** The current non-decode branch at `tug-card.tsx` line 1032 is `new FeedStore(conn, feedIds)` and becomes `new FeedStore(conn, feedIds, undefined, filter)`. The decode branch at line 1030 (`new FeedStore(conn, feedIds, (payload) => decode(feedIds[0], payload))`) becomes `new FeedStore(conn, feedIds, (payload) => decode(feedIds[0], payload), filter)`. Do **not** collapse to `new FeedStore(conn, feedIds, filter)` in the non-decode branch — TypeScript will flag the type mismatch, but the error message is confusing because the 3rd slot is typed as a decoder, not a filter.
- [ ] In `deck-canvas.tsx`, locate the `<Tugcard ...>` JSX in the `renderContent` callback (around line 467). Add `filter={registration.workspaceKeyFilter}` as a new prop so each Tugcard receives the filter registered for its `componentId`.
- [ ] Grep for `FeedId.FILETREE`, `FeedId.FILESYSTEM`, `FeedId.GIT` usages in card registrations and update each to set `workspaceKeyFilter: presentWorkspaceKey`.
- [ ] **Update `gallery-prompt-input.tsx` directly, not via `registerCard`.** This file constructs a `FeedStore` at module scope in `getFileCompletionProvider` (around line 157) — `const feedStore = new FeedStore(connection, [FeedId.FILETREE]);` — and bypasses the `<Tugcard>` plumbing entirely, so adding `workspaceKeyFilter` to its card registration would be a silent no-op. Change that line to `const feedStore = new FeedStore(connection, [FeedId.FILETREE], undefined, presentWorkspaceKey);` (adding `undefined` in the 3rd slot to skip the decoder and `presentWorkspaceKey` in the 4th). Add `import { presentWorkspaceKey } from "../../card-registry";` (adjust the relative path to match the file's location). This is the only inline FeedStore construction in the tugdeck card tree that subscribes to a workspace-scoped feed without going through `<Tugcard>`; all other subscribers reach FeedStore via the Tugcard prop chain updated above.
- [ ] Existing tests in `tugdeck/src/__tests__/feed-store.test.ts` that construct `FeedStore` with the filter argument are already exercised; the new field on `CardRegistration` and the new `filter` prop on `Tugcard` are additive and do not break existing card-registry or Tugcard tests.

**Tests:**
- [ ] Any tugdeck test that exercises filter-based rejection continues to pass. No new dedicated tests — the presence check is a mechanical filter and tugdeck's existing `FeedStore` filter tests already cover the accept / reject paths.

**Checkpoint:**
- [ ] `cd tugdeck && bun run typecheck` — TypeScript compiles clean.
- [ ] `cd tugdeck && bun test src/__tests__/feed-store.test.ts src/__tests__/card-registry.test.ts src/__tests__/tugcard.test.tsx` — targeted test suites pass.
- [ ] HMR picks up the change — no manual build required.

---

#### Step 6: Behavior-preservation checkpoint (integration) {#step-6}

**Depends on:** #step-3, #step-4, #step-5

**Commit:** `N/A (verification only)`

**References:** [D07] Exit criterion 5 validation, Risk R01 (#r01-filewatcher-swap), Risk R02 (#r02-warnings-errors), (#success-criteria), (#exit-criteria)

**Artifacts:**
- No code changes. This step is a gate: all tests pass, a manual smoke-test against a known repo confirms bit-identical observable behavior, and the plan closes.

**Tasks:**
- [ ] Verify `cd tugrust && cargo nextest run` is green on the full workspace (not just tugcast).
- [ ] Verify `cd tugdeck && bun test` is green on the full tugdeck test suite.
- [ ] Manual A/B smoke: `cd tugrust && cargo run --bin tugcast -- --dir <known-repo>` pre- and post-W1 on the same repo; observe that (a) FILETREE queries return the same scored results for the same inputs, (b) filesystem events flow on file edits, (c) git status reflects the current branch and working-tree state. Capture a short checklist in the PR description.
- [ ] Confirm: a running tugcast (post-W1) emits FILETREE / FILESYSTEM / GIT frames whose decoded payloads all contain `workspace_key` as their first JSON field. This is a belt-and-suspenders check beyond the three unit tests from [#step-3].
- [ ] Confirm: no new `clippy` or `rustc` warnings anywhere in the workspace. `cd tugrust && cargo build --workspace` must be clean.
- [ ] Confirm exit criteria 1–5 in [#exit-criteria] are all checked.

**Tests:**
- [ ] Full `cargo nextest run` — green.
- [ ] Full `bun test` in tugdeck — green.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run` — workspace-wide green.
- [ ] `cd tugrust && cargo build --workspace` — workspace-wide clean.
- [ ] `cd tugdeck && bun test` — green.
- [ ] Manual smoke captured in PR description.

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** A merged branch that lands `WorkspaceRegistry`, routes the bootstrap feeds through it, splices `workspace_key` into every FILETREE / FILESYSTEM / GIT frame, wires a presence-check filter on the tugdeck side, and preserves existing `tugcast --dir` behavior bit-identically — leaving the repo in a state where W2 can introduce per-session workspace binding without fighting the refactor.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] Criterion 1 — `cd tugrust && cargo nextest run` green. (verification: run command in [#step-6] checkpoint)
- [ ] Criterion 2 — `tugcast --dir <path>` is bit-identical pre/post W1: same FILETREE query results, same file-event flow, same git status. (verification: manual A/B in [#step-6] plus unchanged integration tests)
- [ ] Criterion 3 — `test_workspace_registry_bootstrap_construction` asserts fresh-path construction produces an entry with live feed tasks and matching canonical key. (verification: new unit test in `workspace_registry.rs`)
- [ ] Criterion 4 — `test_workspace_registry_deduplicates_canonical_paths` asserts two canonicalizing inputs produce `Arc::ptr_eq`-equal entries. (verification: new unit test in `workspace_registry.rs`)
- [ ] Criterion 5 — all FILETREE / FILESYSTEM / GIT frames carry `workspace_key` as their first JSON field. (verification: three per-feed `test_workspace_key_spliced_into_*` unit tests per [D07]; belt-and-suspenders manual observation in [#step-6])
- [ ] Workspace builds clean under `-D warnings` on every intermediate commit. (verification: `cargo build --workspace` in [#step-6])
- [ ] `AgentSupervisorConfig::project_dir` is still present and unchanged. (verification: grep — this is a non-goal sanity check)
- [ ] No `release` method exists on `WorkspaceRegistry`. (verification: grep — this is a non-goal sanity check)

**Acceptance tests:**
- [ ] `test_workspace_registry_bootstrap_construction`
- [ ] `test_workspace_registry_deduplicates_canonical_paths`
- [ ] `test_workspace_key_spliced_into_filesystem_frame`
- [ ] `test_workspace_key_spliced_into_filetree_frame`
- [ ] `test_workspace_key_spliced_into_git_frame`
- [ ] `test_splice_workspace_key_*` (five new splice helper tests)
- [ ] `cd tugrust && cargo nextest run -p tugcast` — full tugcast suite green (regression coverage for existing integration tests: `test_filesystem_feed_integration`, `response_serializes_to_spec_s01b`, existing git feed tests)

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] T3.0.W2 — per-session workspace binding on `spawn_session`: introduces `release()`, teardown, `LedgerEntry.workspace_key`, `LedgerEntry.project_dir`, `AgentSupervisorConfig::project_dir` removal, `ChildSpawner::spawn_child(&Path)` signature change, tugdeck `encodeSpawnSession` extension, presence-check filter → value-check filter in card registrations.
- [ ] **T3.0.W2 dead-code cleanup.** W1 retains six fields on `WorkspaceEntry` with per-field `#[allow(dead_code)]` because they have no non-test reader in the bootstrap-only W1 scope: `workspace_key`, `project_dir`, `file_watcher_task`, `filesystem_task`, `filetree_task`, `git_task` (`feeds/workspace_registry.rs`). W2 must delete all six `#[allow(dead_code)]` annotations when `release()` lands — `release()` will read `workspace_key` to look up the map entry, read `project_dir` (passed through to `ChildSpawner::spawn_child`), and `.abort()` + `await` each of the four `JoinHandle<()>` task fields on teardown. Grep for `#\[allow\(dead_code\)\]` in `workspace_registry.rs` during W2; expect exactly six matches (plus zero after cleanup). **If any of the six still has no reader after W2's `release()` is implemented, that's a signal the field is genuinely dead and should be removed from the struct — not left with a persistent allow.**
- [ ] **T3.0.W2 gallery-prompt-input migration.** W1 passes `presentWorkspaceKey` (boolean presence check) directly at module scope in `tugdeck/src/components/tugways/cards/gallery-prompt-input.tsx`, bypassing the `CardRegistration → DeckCanvas → <Tugcard filter> → FeedStore` chain entirely. When W2 introduces value-check filters (match a specific workspace key), this file has no `registration.workspaceKeyFilter` to read — the inline FeedStore singleton is constructed at first render of the gallery, not at card mount time, and persists across card lifetimes. W2 must either (a) refactor `gallery-prompt-input` to construct its FeedStore *inside* a card component so it can receive the filter via props through `<Tugcard>`, or (b) hoist the active-workspace key into a tugdeck-wide context (e.g., `useActiveSession()` or a new `WorkspaceContext`) and close over it in the inline FeedStore construction. Whichever W2 picks, the `presentWorkspaceKey` constant in `card-registry.ts` should stop being imported from this file once the proper value-check filter lands. **Without this migration, the gallery prompt's file completion will keep receiving every workspace's filetree frames in a multi-session world — a silent leak of the kind [D11] was designed to prevent.**
- [ ] T3.0.W3 — retire `--dir` entirely: empty registry at startup, `resources::source_tree()` helper, `BuildStatusCollector` / `resolve_tugcode_path` / `migrate_settings_to_tugbank` rewiring, CLI surface cleanup.
- [ ] Per-workspace `BuildStatusCollector` (follow-up to T3.0.W3, tracked separately): detect `Cargo.toml` / `package.json` / `go.mod` in each workspace and publish a per-workspace build status.

| Checkpoint | Verification |
|------------|--------------|
| Splice helper lands and tests pass | `cargo nextest run -p tugcast feeds::code` ([#step-1]) |
| Registry module compiles and tests pass | `cargo nextest run -p tugcast feeds::workspace_registry` ([#step-2]) |
| Feed signatures updated and frames carry `workspace_key` | `cargo nextest run -p tugcast feeds::{filesystem,filetree,git}` ([#step-3]) |
| main.rs routes through the registry and tugcast still works | `cargo nextest run -p tugcast` ([#step-4]) |
| Tugdeck filter field plumbed through tug-card.tsx | `bun test src/__tests__/{feed-store,card-registry,tugcard}*` ([#step-5]) |
| Workspace-wide green and bit-identical behavior confirmed | `cargo nextest run` + `bun test` + manual A/B ([#step-6]) |
