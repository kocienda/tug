<!-- devise-skeleton v4 -->

## Tugcast Performance Fixups — Snippets Watcher and Changeset Compose {#phase-slug}

**Purpose:** Eliminate the two loops that make every running tugcast burn 15–25% of a CPU core — the snippets `PollWatcher` that content-hashes ~16 MB of live databases four times a second, and the changeset recompute that re-derives the full attribution history (with uncached path canonicalization, per-row syscall churn on permanently-dead rows, and per-path git subprocesses) on every filesystem bump — while preserving the exact behavior each loop exists to provide. Out-of-repo attribution rows are **deleted, and never written again**, not cached around.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-08-03 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

`sample` profiles of two live tugcast processes (one idle debug instance at 23% CPU, one release instance with live sessions at 15.5%) show that essentially the entire CPU budget is two loops. **(A)** The SNIPPETS feed (`tugrust/crates/tugcast/src/feeds/snippets.rs`) installs a `notify::PollWatcher` with `.with_compare_contents(true)` on a 250 ms interval watching the **parent directory** of `snippets.json` — which is `~/Library/Application Support/Tug/`, home of `changes.db` (3.8 MB), `sessions.db` (4.0 MB), their WALs (4.1 MB + 0.7 MB), and the append-only `changes.db.journal.jsonl` (4.6 MB, growing). Every tick reads and hashes all ~16.4 MB — ~65 MB/s of redundant I/O per process, at idle, forever, to detect changes to a 2 KB JSON file. With several tugcasts running this multiplies to hundreds of MB/s machine-wide, and it does 4 Hz whole-file reads of live SQLite WALs. **(B)** The account-global `ChangesetAllFeed` (`feeds/changeset_all.rs`) recomputes `compose_snapshot` (`feeds/changeset.rs`) for **every** open project on **any** filesystem batch under **any** workspace root (`feeds/git_watch.rs` fires `bump.notify_one()` unconditionally per batch). Each recompute reads every `file_events` row for the project (4,176 rows for the main checkout today, unbounded growth), calls `repo_relative()` per row — measured at 65% of compose cost — and runs git subprocesses per dirty path (`min_live_at_ms`) and per tugdash branch (`dash_entries`).

Inside `repo_relative` the waste has three distinct layers: the loop-invariant `CanonicalPath::from_raw(repo_root)` is recomputed per row (a global-mutex memo lookup ×4,176); **~424 absolute-path rows point at files outside the repo** (e.g. `/Users/kocienda/.claude/projects/…/memory/*.md`), so `strip_prefix` can never succeed and the fallback ancestor walk stats every ancestor via `same_file` (~14 syscalls/row) producing nothing, every cycle; and the cold path of canonicalization, `resolve_synthetic` (`path_resolver.rs`), **re-reads and re-parses `/etc/synthetic.conf` from disk on every single call**.

The out-of-repo rows are not merely legacy: **capture still writes them today** (measured: the count grew 417 → 424 within hours; the newest row is from 2026-08-03). `attribution.rs::project_repo_relative` deliberately stores the canonical absolute path when `strip_prefix` against the repo root fails — so every session write to a file outside the checkout (session-memory files under `~/.claude/…` are the dominant case) mints a fresh permanently-dead row. These rows can never contribute to any changeset (the compose fold only matches events against `git status`'s repo-relative dirty paths) and the existing lazy backfill can never repair them (it only rewrites rows whose resolution *changed* the path). This plan deletes the existing population and stops the influx at capture time.

#### Strategy {#strategy}

- Fix A first: it is the larger burner, fully contained in one file, and behavior-preserving (the feed's contract — cross-build snippets sync within ~1 s, robust across sandboxes and the `/private/var` firmlink — is kept by polling a *single file's* stat, not by hashing a directory).
- Fix B by **removing dead work, not caching it**: stop recording out-of-repo file events at capture time, and delete the accumulated out-of-repo rows through the journaled ledger write path (following the existing `DeleteSession`/`Sever` deletion precedents in `changes_journal.rs`).
- Layer the remaining B fixes cheapest-first: cache the `/etc/synthetic.conf` parse process-wide; hoist the loop-invariant canonical root; cache the `min_live_at_ms` git call keyed by HEAD; add a debounce floor to the recompute loop so filesystem bursts cannot drive back-to-back full recomputes.
- Never change *what* the changeset computes for real repo files — the [D112] liveness rule, ownership semantics, and snapshot wire format are untouched. Every cache has an explicit, stated invalidation story.
- Add lightweight instrumentation (compose duration + row counts via `tracing`) so the next regression is observable without `sample`.
- Explicitly defer journal rotation and per-process feed dedup — they change ownership/semantics and deserve their own plans.

#### Success Criteria (Measurable) {#success-criteria}

- A 5-second `sample <tugcast-pid>` of an **idle** tugcast shows zero samples under `notify::poll::data::WatchData::rescan` / `PathData::get_content_hash` (currently ~21% of a core on the idle debug instance). (Run `sample` against a rebuilt running instance.)
- Snippets cross-build sync still works: an external write to `snippets.json` is observed and republished within ~1 s (existing test `external_write_triggers_new_frame` in `feeds/snippets.rs` passes unmodified in intent; timing constants may move).
- After the app runs and the main project's first compose completes: `just db-inspect changes "SELECT COUNT(*) FROM file_events WHERE project_dir='<repo project>' AND file_path LIKE '/%'"` returns **0**, and stays 0 after a session writes a file outside the repo (e.g. a memory file).
- A 5-second `sample` of a tugcast under active session load shows `compose_snapshot` + `repo_relative` + `path_resolver` combined at a small fraction of their current ~10–12% of a core; `resolve_synthetic` and `same_file` no longer appear in steady-state samples.
- `cd tugrust && cargo nextest run` passes with zero warnings (workspace enforces `-D warnings`).
- `compose_snapshot` output is unchanged for repo files (covered by the existing changeset unit tests in `feeds/changeset.rs` and `feeds/changeset_all.rs` passing unchanged).

#### Scope {#scope}

1. `feeds/snippets.rs` — replace the directory `PollWatcher` with a single-file stat poll owned by the feed task.
2. `path_resolver.rs` — cache the parsed `/etc/synthetic.conf` once per process.
3. `feeds/attribution.rs` — stop recording file events whose path resolves outside the project's repo root.
4. `feeds/changeset.rs`, `session_ledger.rs`, `changes_journal.rs` — hoist the canonical repo root; delete out-of-repo rows through a new journaled Record variant; cache `min_live_at_ms` keyed by HEAD.
5. `feeds/changeset_all.rs` — debounce floor on the bump-driven recompute loop; compose instrumentation.

#### Non-goals (Explicitly out of scope) {#non-goals}

- Truncating or rotating `changes.db.journal.jsonl` (ledger-hardening territory; see [Q02]).
- Deduplicating feed work across multiple concurrently running tugcast processes.
- Scoping the changeset bump back to per-project recomputes (the aggregate-feed design is recent and deliberate; the debounce floor addresses the practical cost).
- Changing attribution for **non-repo projects** (`repo_root = None`): their rows are the project's own files with no repo to be "outside" of; they keep their canonical absolute paths and are untouched by the purge (which is scoped per repo project).
- Any frontend/tugdeck change — this is entirely tugcast-side.
- Any DDL / `CHANGES_SCHEMA_VERSION` change — the purge is row deletion (DML) through the journaled write path, not a schema migration.

#### Dependencies / Prerequisites {#dependencies}

- None external. All work is in `tugrust/crates/tugcast`.

#### Constraints {#constraints}

- **Warnings are errors** (`tugrust/.cargo/config.toml` sets `-D warnings`).
- Never open live ledger DBs with a foreign SQLite ([LR2]); all verification queries via `just db-inspect`.
- Every `changes.db` mutation goes through the ledger chokepoint ([LR1]) and is journaled ([LR6]) — a new `Record` variant in `changes_journal.rs`, replay-idempotent, following the `DeleteSession`/`Sever` precedent.
- **[LR5]:** row deletion is shape-safe and stays permitted when a build is locked out by the `user_version` gate — so the new Record variant **must** return `false` from `Record::shapes_rows()`. Returning `true` would silently disable the purge under a version-gate lockout.
- **[LR8]:** only the writer-claim owner writes `changes.db`; other processes forward records through a **bounded 256-record queue** whose overflow drops records loudly and latches `ledger_degraded`. The purge must therefore be **one record carrying all row keys**, never one record per row.
- `notify` remains a dependency (used by `dev.rs` and `feeds/file_watcher.rs`); only the snippets feed's use of `PollWatcher` is removed.
- The snippets feed's public shape — `snippets_feed(path) -> (watch::Receiver<Frame>, Arc<Notify>)`, the frame format, and the PUT-nudge contract — must not change (`main.rs` wiring and `snippets::SnippetsState` depend on it).

#### Assumptions {#assumptions}

- `/etc/synthetic.conf` changes require a reboot to take effect, so a once-per-process parse cache is semantically identical to per-call reads.
- Out-of-repo file events have **no downstream consumer**: the changeset fold matches events only against repo-relative dirty paths from `git status`, so an out-of-repo row can never surface in the Changes card, a claim bucket, or a draft. (Verified against `compose_snapshot`'s fold in `feeds/changeset.rs`; `tugchanges-core::changes.rs` applies the same repo-relative matching for the CLI.) If a future feature wants "what did this session touch anywhere," it should read the session JSONL, not `file_events`.
- APFS mtime has nanosecond granularity and `write_snippets_atomic` replaces the file via rename, so `(mtime, len)` change detection on `snippets.json` is a reliable change signal; the retained content-hash comparison catches any residual same-stat edge.

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

This plan follows the tuglaws devise skeleton conventions: explicit `{#anchor}` on every heading cited elsewhere, `[P##]` for plan-local decisions, `[Q##]` for open questions, `R##` risks, `#step-N` execution anchors, and `**References:**`/`**Depends on:**` lines on every step. No line-number citations.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Should out-of-repo `file_events` rows be excluded or retired? (DECIDED) {#q01-out-of-repo-rows}

**Question:** ~424 of the main project's `file_events` rows name files outside the repo. Exclude at query time, mark via schema, or delete?

**Resolution:** DECIDED — **delete them, and stop writing them** (owner's call, 2026-08-03). See [P08] (capture-side stop) and [P09] (journaled purge). They serve no consumer (see #assumptions), the population was measured still growing, and caching around permanently-dead rows ([P04], withdrawn) treats a data defect as a perf problem.

#### [Q02] Unbounded growth of `changes.db.journal.jsonl` (DEFERRED) {#q02-journal-growth}

**Question:** The 4.6 MB append-only journal grows monotonically. After fix A it no longer costs CPU in tugcast, but should it rotate/truncate?

**Why it matters:** Only disk growth remains once the directory hashing stops; but a multi-hundred-MB journal is still a smell.

**Plan to resolve:** Belongs to the ledger-hardening program (see `dash/commit-tool-fixes.md` territory), not this perf plan.

**Resolution:** DEFERRED to the ledger-hardening program.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Snippets cross-build sync regresses (missed external writes) | med | low | Stat-poll same 250 ms cadence; keep content-hash suppression; existing async tests cover external write + nudge + corrupt file | `external_write_triggers_new_frame` flakes or user reports stale snippets across builds |
| Purge deletes a row a future feature wanted | low | low | Deletion is journaled (auditable in `changes.db.journal.jsonl`); the no-consumer claim is verified in #assumptions; session JSONL remains the full activity record | A feature spec appears that reads `file_events` for out-of-repo activity |
| Capture-skip drops an event that was actually in-repo (canonicalization miss) | high | low | The skip uses the same gateway canonicalization the fold uses — an event skipped at capture is by construction one the fold could never match; unit tests cover firmlink/symlink spellings resolving in-repo (recorded) vs truly outside (skipped) | Attribution gaps reported for real repo files |
| A producer is missed, so the row count never reaches zero | med | med (without the fix) | #file-event-producers enumerates all four sites; Step 3 names `record_shell_op_row` explicitly; Step 8 verifies **after** further session activity, not just once | Step 8's post-activity `db-inspect` returns non-zero |
| Purge overruns the [LR8] forwarder queue | med | low | One record carrying all keys ([P09]); 256-record queue documented in #constraints | `ledger_degraded` latches during Step 8 |
| `min_live_at_ms` cache returns a stale liveness cut | med | low | Cache keyed by `(repo_root, rel, head_oid)`; any commit moves HEAD and naturally invalidates | A workflow that rewrites history without moving HEAD (not a real Tug flow) |
| Debounce floor delays changeset UI freshness | low | med | Floor is small (150 ms) and only coalesces — the recompute still always runs after the last bump | User-visible lag in the Changes card after a save |

**Risk R01: PollWatcher removal changes atomic-rename detection** {#r01-rename-detection}

- **Risk:** The old parent-directory watch existed because atomic writes replace `snippets.json` via rename, and an inode-based watch on the file goes stale.
- **Mitigation:** The replacement polls **by path** (`std::fs::metadata` each tick), which is immune to inode replacement — every tick re-stats whatever currently lives at the path. This is strictly more robust than the directory watch, not less.
- **Residual risk:** None identified; a missing file simply reads as "no metadata" until it appears.

**Risk R02: synthetic.conf cache masks a mid-process edit** {#r02-synthetic-cache}

- **Risk:** Someone edits `/etc/synthetic.conf` while tugcast runs and expects new alias resolution.
- **Mitigation:** synthetic.conf entries only materialize at boot, so a running process can never observe a *functioning* new entry anyway. The boot-built `AliasTable` in `path_resolver.rs` already froze this data once per process; [P02] merely extends the same (already-accepted) semantics to the cold path.
- **Residual risk:** None beyond what `AliasTable` already accepted.

**Risk R03: journal replay divergence for the purge record** {#r03-replay-divergence}

- **Risk:** A purge Record replayed against a db state different from when it was written (e.g. after recovery) deletes rows that shouldn't exist or misses rows that do.
- **Mitigation:** The purge record carries the **explicit row keys** it deleted (`tug_session_id`, `tool_use_id`, `file_path` per row), not a predicate — replay is exact and idempotent (`DELETE` of an absent row is a no-op), matching how `Rewrite` carries explicit old/new paths.
- **Residual risk:** None beyond the existing journal model.

---

### Design Decisions {#design-decisions}

#### [P01] Snippets watcher becomes a single-file stat poll owned by the feed task (DECIDED) {#p01-snippets-stat-poll}

**Decision:** Delete the `notify::PollWatcher` from `feeds/snippets.rs`. The feed task's existing `tokio::select!` loop gains a `tokio::time::interval` arm (250 ms, `MissedTickBehavior::Skip`) that stats `snippets.json` by path and compares `(mtime, len)` against the last observed pair; on change (including appearance/disappearance of the file) it performs the existing debounced re-read. The published-frame suppression is strengthened: after `read_snippets`, if the new outcome's content hash equals the last published hash, no frame is sent.

**Rationale:**
- The current watcher's cost is structural, not tunable: `compare_contents` hashing of the watched *directory* means every byte of every live database in `~/Library/Application Support/Tug/` is read and hashed 4×/s (~16.4 MB/tick measured 2026-08-03, growing with the journal). Backing off the interval only divides an unbounded number.
- The `PollWatcher` was chosen over FSEvents for robustness across sandboxes and the `/private/var` firmlink — that property comes from *polling by path*, which the replacement keeps, not from `notify` or from watching the parent directory.
- The parent-directory watch existed for atomic-rename robustness (see Risk R01); path-based stat polling is immune to inode replacement by construction.
- 4 Hz whole-file reads of live SQLite WALs by eight processes is exposure we should not carry while the tugcast SIGBUS-in-WAL-shm investigation is open, even absent a proven causal link.

**Implications:**
- `notify` imports leave `snippets.rs`; the crate keeps the dependency for `dev.rs` and `file_watcher.rs`.
- `install_watcher` is deleted; the feed task owns all change detection.
- The existing tests keep their scenarios; the "let the PollWatcher establish its baseline" sleep in `external_write_triggers_new_frame` becomes unnecessary but harmless (the stat poll has no baseline race — the pre-write stat is the baseline).
- The `Arc<Notify>` nudge contract and `main.rs` wiring are untouched.
- **The last-published hash initializes from the initial frame** built before `watch::channel(initial)` — otherwise the first rebuild always publishes a duplicate of what subscribers already hold.
- **Task exit must rest on the `tx.closed()` arm.** Today the loop also exits via `tx.send(frame).is_err()`; once sends are suppressed on unchanged content, that path can go quiet indefinitely and would leak the task. The `tx.closed()` select arm already exists and becomes the load-bearing exit — do not remove it when restructuring the loop.

#### [P02] `resolve_synthetic` parses `/etc/synthetic.conf` once per process (DECIDED) {#p02-synthetic-conf-cache}

**Decision:** In `path_resolver.rs`, extract the synthetic.conf read+parse into a `OnceLock`-initialized `Vec<(String, String)>` (syn_root → target pairs, pre-trimmed); `resolve_synthetic` iterates the cached table instead of re-reading the file per call.

**Rationale:**
- The current code does `std::fs::read_to_string("/etc/synthetic.conf")` plus line parsing on **every** cold canonicalization — measured as a visible fraction of compose cost (`resolve_synthetic` 71 samples in a 5 s idle profile).
- The boot-built `AliasTable` in the same file already froze synthetic.conf once per process; this makes the cold path consistent with the already-accepted semantics (Risk R02).

**Implications:**
- Pure refactor of `resolve_synthetic`'s data source; resolution results are unchanged.
- Existing `path_resolver` unit tests must pass unchanged.

#### [P03] `repo_relative` takes the pre-resolved canonical root (DECIDED) {#p03-hoist-canonical-root}

**Decision:** Change `repo_relative(repo_root: &Path, file_path: &str)` in `feeds/changeset.rs` to accept the canonical root: `repo_relative(canonical_root: &CanonicalPath, repo_root: &Path, file_path: &str)` (raw root kept for the ancestor-walk fallback's `same_file` comparison). `compose_snapshot` computes `CanonicalPath::from_raw(repo_root)` **once** and threads it through the call sites.

**Rationale:**
- `CanonicalPath::from_raw(repo_root)` is loop-invariant but currently recomputed per row — a global `memo()` mutex lock per row per recompute, contended against every other resolver caller.

**Implications:**
- Signature change is crate-internal (`repo_relative` is `fn`, not `pub`); the sibling `tugchanges-core::changes::repo_relative` is a separate copy used by the CLI path and is out of scope here (different call frequency).

#### [P04] Legacy-absolute row resolution memo (WITHDRAWN) {#p04-legacy-row-memo}

**Decision:** Withdrawn before implementation. An earlier draft of this plan proposed a process-lifetime memo caching the (always-failing) resolution of out-of-repo rows. Superseded by [P08]/[P09]: the rows are deleted and never written again, so there is nothing left to memoize — after the first compose per project, every remaining `file_events` row is repo-relative and takes `repo_relative`'s instant non-absolute early-return. The ID is retired, not reused.

#### [P05] `min_live_at_ms` is cached keyed by HEAD (DECIDED) {#p05-live-cut-cache}

**Decision:** Cache the per-path liveness cut (`git log -1 --format=%ct -- <rel>`) in a process-lifetime map keyed `(canonical_root, rel)` → `(head_oid, cut_ms)`, where `head_oid` comes from one `git rev-parse HEAD` per `compose_snapshot` call (one added subprocess replacing up-to-N `git log` subprocesses on every recompute). On a miss or an oid mismatch the existing subprocess runs and the entry is replaced.

**Growth:** one entry per distinct path *ever* dirtied in the process's lifetime (not per currently-dirty path — entries for paths that go clean are replaced, never removed). Bounded in practice by the repo's file count, which is acceptable for a `(String, String) → (String, i64)` map; if that ever stops being true the fix is an LRU, not a redesign.

**Rationale:**
- The liveness cut ([D112] row-liveness rule) only changes when a commit lands — i.e., when HEAD moves. Between commits, re-running `git log` per dirty-path-with-events per recompute is pure subprocess churn (a busy editing session bumps recomputes far more often than it commits).
- Keying by HEAD oid is a natural, exact invalidation: any commit, merge, or reset moves the oid.

**Implications:**
- `compose_snapshot` gains a `git rev-parse HEAD` call via the existing `git_stdout` helper; if it fails (transient / unborn HEAD), skip the cache for that cycle and fall through to per-path calls (never wrong, just slower).
- The dedicated behavior tests for the liveness rule in `feeds/changeset.rs` must pass unchanged.

#### [P06] The aggregate recompute loop gets a coalescing debounce floor (DECIDED) {#p06-bump-debounce}

**Decision:** In `ChangesetAllFeed::run` (`feeds/changeset_all.rs`), after `bump.notified()` fires, sleep 150 ms before recomputing, **then drain any permit the sleep accumulated** before composing. Bumps landing during the sleep fold into the same recompute.

**The drain is required, not incidental.** `Notify::notify_one` stores a permit when no waiter is registered, and nothing awaits `notified()` during the sleep — so without a drain, a bump landing mid-sleep leaves a permit that makes the *next* `notified()` return immediately, producing a second, redundant full compose of every project. (The second snapshot is identical and diff-suppression eats the frame, so it is invisible but not free.) Drain with `tokio::time::timeout(Duration::ZERO, self.bump.notified())` — `Notified`'s first poll consumes a stored permit and otherwise the zero timeout expires immediately.

**Rationale:**
- Today the loop's only rate limit is compose duration itself: `git_watch` bumps on **every** filesystem batch under any workspace root, so sustained file activity (builds, `cargo` runs, autosave) drives back-to-back full recomputes of all projects.
- 150 ms is imperceptible against the Changes card's human timescale and matches the debounce scale already used by the snippets feed and `file_watcher` (100 ms).

**Implications:**
- The `drafts_version` probe arm and cancellation arm are unchanged; the sleep sits between wake and compose and must yield to cancellation.
- Existing `changeset_all` tests that wait on `rx.changed()` with 5 s timeouts absorb 150 ms without modification.
- Assertions about coalescing must be phrased in terms of **frames published**, not composes performed — frames are the observable contract, and diff-suppression already collapses redundant composes.

#### [P07] Compose instrumentation via tracing (DECIDED) {#p07-instrumentation}

**Decision:** `compose_aggregate` logs one `debug!` line per recompute with total duration and project count (plus per-project event-row counts if plumbing is non-invasive — never as a snapshot/wire-format field); `compose_snapshot` may expose the count via a side-channel return.

**Rationale:**
- This investigation required `sample(1)` archaeology; a single grep-able log line makes the next regression visible in the existing log surface (`~/Library/Application Support/Tug/Logs`).

**Implications:**
- `debug!` level keeps steady-state logs quiet in release; visible when needed.

#### [P08] Capture never records out-of-repo file events for repo projects (DECIDED) {#p08-capture-skip}

**Decision:** In `feeds/attribution.rs`, when the project has a repo root (`repo_root = Some`), a captured file path that — after gateway canonicalization — does not strip against the canonical root is **not recorded at all**: no `file_events` row, no journal record. `project_repo_relative`'s "residual non-prefix returns the canonical absolute path" branch is replaced by an out-of-repo signal the caller uses to skip the event. Non-repo projects (`repo_root = None`) are unchanged — their canonical absolute rows are the project's own files.

**Rationale:**
- These rows are dead on arrival: the compose fold can only match events against repo-relative dirty paths, so an out-of-repo row can never surface anywhere (#assumptions). Recording them is negative value — they cost compose time every cycle (pre-purge) and grow the table forever.
- Measured: the population grew 417 → 424 in hours; the dominant writers are session-memory files under `~/.claude/…`, written every session. Without this stop, the [P09] purge regrows indefinitely.
- The skip decision uses the same canonicalization the fold uses, so a skipped event is by construction one the fold could never have matched (Risk table, capture-skip row).

**Implications:**
- **There is no single existing chokepoint — three production sites build `FileEventRow`s and two of them bypass `into_row` entirely.** The skip predicate must live in one shared helper called from all of them (see #file-event-producers): (1) `attribution.rs::into_row` via `project_repo_relative` — the exact-tool route, 2 callers (`agent_bridge.rs`'s `record_exact_pending`, `changeset_all.rs`); (2) **`agent_bridge.rs::record_shell_op_row`** — the Bash/shell-grammar route, which builds the row inline with its own `strip_prefix(...).unwrap_or_else(|_| canonical…)` fallback and is an *independent producer of exactly these rows*; (3) `agent_supervisor.rs`'s claim route and `attribution.rs`'s bracket-sweep row push, both of which are low-risk (their paths are repo-relative by construction) but carry the same fallback shape and should route through the helper for uniformity.
- `into_row`'s return becomes fallible (`Option<FileEventRow>` or equivalent); callers drop `None` silently at `debug!` level. `record_shell_op_row` gains the equivalent early return.
- **This changes documented behavior.** `record_exact_pending`'s comment states "Off-repo files fall back to the session's dir," and [D112] describes the per-file `project_dir` rule of which that fallback is the tail case. The decision text needs a corresponding update (see #documentation-plan) rather than drifting silently.
- The full activity record for out-of-repo writes remains available in the session JSONL; `file_events` is scoped to what the Changes card can ever show.
- **Not at risk: cross-repo attribution.** `record_exact_pending` resolves `file_repo_root(&pending.file_path)` first, so a file in *another* checkout (or a nested worktree) is already homed to that repo's root and stripped against it — `into_row` only ever sees `Some(root)` + strip-failure for a file in **no git repo at all**. The skip cannot eat another project's work.

#### [P09] Out-of-repo rows are purged through a journaled ledger delete (DECIDED) {#p09-journaled-purge}

**Decision:** The existing once-per-project-per-process backfill block in `compose_snapshot` (`feeds/changeset.rs`) is extended: rows whose absolute `file_path` is **definitively outside** the canonical repo root are partitioned out of the rewrite set and **deleted** via a new `SessionLedger` method backed by a new `changes_journal::Record` variant (`fe_purge_out_of_repo`) that carries the explicit row keys (`tug_session_id`, `tool_use_id`, `file_path`) plus the canonical `project_dir`. Replay is exact and idempotent (Risk R03).

**The purge predicate is stated directly, not as a proxy:** purge iff the gateway-canonicalized `file_path` is absolute **and** is not under the canonical repo root by string prefix. An earlier draft used "resolution unchanged by `repo_relative`" — that is a *proxy* that diverges precisely when canonicalization **fails** (an in-repo file already deleted from disk, spelled through a symlink the boot alias table doesn't cover: `canonicalize` fails, `strip_prefix` fails, the ancestor `same_file` walk stats nothing, and a legitimate in-repo row would be purged). Unresolvable ≠ outside; the predicate must test the property, and the deleted-in-repo-file case is a required test (see #step-4).

**Rationale:**
- Owner's directive (2026-08-03): delete these rows; they serve nothing. Caching around them ([P04], withdrawn) treated a data defect as a perf problem.
- The backfill block is the right home: it already runs once per open project with the repo root in hand, already computes each row's resolution, and already writes through the journaled ledger path (`backfill_file_events_repo_relative` / `Record::Rewrite` precedent). The purge is the same shape with `DELETE` instead of `UPDATE`.
- With [P08] stopping the influx, once-per-process is sufficient: after the first compose, a repo project has zero absolute rows and `repo_relative`'s expensive path never executes again.

**Implications:**
- New `Record` variant in `changes_journal.rs` (serde-tagged; additive, no journal format break) and a corresponding `SessionLedger` delete method with the same journal-then-apply discipline as existing writes (`sever_file_ownership_except` is the closest precedent — journal a `Record`, apply via a `_sql` helper shared with replay). No DDL, no `CHANGES_SCHEMA_VERSION` bump.
- **`Record::shapes_rows()` must return `false` for the new variant** ([LR5], #constraints). The `match` there is exhaustive so the compiler forces a choice; choosing `true` would make the purge refuse to run on a build locked out by the `user_version` gate — exactly the degraded state where quiet failure is worst.
- **One record, all keys** ([LR8], #constraints). ~424 rows must arrive as a single `PurgeOutOfRepo` record with a `Vec` of keys. One-record-per-row would overrun the 256-record forwarder queue on every non-owner process, dropping records and latching `ledger_degraded`.
- The purge must run **before** the fold uses `events` (or the fold must use the post-purge set) so a purged row doesn't cost the ancestor walk one last time per process — order: read events → partition (rewrites / purges / keep) → apply ledger writes → fold over the kept set.
- **The once-per-project marker is set only on success.** The existing `backfill_marker().insert(...)` marks the project *before* the work runs, so a failed `write_change` (e.g. a failed [LR8] forward) means the process never retries for its lifetime. The purge must mark the project done only after the ledger write succeeds. (The same latent issue exists today for the rewrite backfill; fixing it here covers both.)
- Several tugcast processes will race the same purge. That is safe by construction — deletes are keyed and idempotent, and a no-op replay is skipped per [LR6] — but the replay test must cover a **re-applied** purge, not just a single application.
- The legacy union read in `compose_snapshot` (raw-spelling `project_dir` query) is unaffected; purge keys carry whichever `project_dir` spelling the row actually has.

---

### Deep Dives (Optional) {#deep-dives}

#### Measured profile, 2026-08-03 {#measured-profile}

Two 5-second `sample` runs (1 ms cadence, ~4,184 samples/thread), symbols aggregated:

| Symbol (aggregated) | Idle debug tugcast (PID 50883, 23% CPU) | Live release tugcast (PID 15210, 15.5% CPU) |
|---|---|---|
| `notify::poll::data::WatchData::rescan` / `PathData::get_content_hash` (snippets PollWatcher) | 867 / 861 samples (~21% of a core) | 274 / 265 samples (~6.5%) |
| `compose_snapshot` subtree | 508 (~12%) | 406 (~10%) |
| — of which `repo_relative` | 222 | 262 |
| — `path_resolver` (`from_raw` + `resolve_to_claude_form` + `resolve_synthetic` + `same_file`/`get_identity`) | ~380 | ~440 |
| — `SessionLedger::file_events_for_project` (SQLite) | 230 | 86 |

The watched directory (`~/Library/Application Support/Tug/`) contents at measurement time: `changes.db` 3,760,128 B; `changes.db-wal` 655,112 B; `changes.db.journal.jsonl` 4,598,950 B; `sessions.db` 3,964,928 B; `sessions.db-wal` 4,132,392 B; plus small files — **16.4 MB total**, all read+hashed per 250 ms tick by each tugcast.

Ledger row counts (via `just db-inspect changes`): 5,269 total `file_events`; 4,176 for `project_dir = /Users/kocienda/Mounts/u/src/tugtool`; absolute-path rows measured at 417, then **424 hours later** (newest `at` = 2026-08-03 03:16 UTC-adjusted) — proof the influx is live, not legacy. Sampled absolute rows all point under `~/.claude/projects/…/memory/`, i.e. outside the repo.

#### The recompute trigger graph {#recompute-triggers}

`ChangesetAllFeed` recomputes when its `bump` (`Arc<Notify>`, account-global, held by `WorkspaceRegistry::changeset_all_bump`) fires. Bump sources: (1) `feeds/git_watch.rs::run_git_workspace_watch` — fires on **every** debounced filesystem batch under a workspace root, one watcher per open workspace, all feeding the same global bump; (2) `ChangesetBumper::bump` from the relay after each attributed file-event write (`feeds/agent_bridge.rs`, four call sites); (3) `WorkspaceRegistry` open/close transitions (three call sites in `feeds/workspace_registry.rs`); (4) the 2 s drafts-version probe inside the feed itself when `MAX(updated_at)` moves. Each recompute runs `compose_snapshot` for every open project — three git subprocesses minimum per project (`rev-parse --show-toplevel` via `repo_root_for`, `status --porcelain=v2`, `log -1` head message), plus one `git log -1 -- <path>` per dirty-path-with-events (`min_live_at_ms`, cached only within a single compose via `live_cuts`), plus ~4 subprocesses per `refs/heads/tugdash/` branch (`dash_entries`).

#### Every production producer of a `FileEventRow` {#file-event-producers}

Verified by grepping `FileEventRow {` and `.into_row(` across `crates/tugcast/src` (2026-08-03). [P08]'s skip predicate must be applied at each of these; there is **no single existing chokepoint**.

| Site | Route | How it builds `file_path` | Risk of out-of-repo rows |
|---|---|---|---|
| `attribution.rs::into_row` → `project_repo_relative` | Exact tool calls (Write/Edit/MultiEdit/NotebookEdit). Callers: `agent_bridge.rs::record_exact_pending`, `changeset_all.rs` | Canonicalize, `strip_prefix(root)`, else canonical absolute | **High — the dominant producer.** Session memory-file writes land here |
| `agent_bridge.rs::record_shell_op_row` | Bash / shell-grammar declared paths | `canonicalize_declared`, then inline `strip_prefix(root).unwrap_or_else(\|_\| canonical…)` | **High — independent producer, bypasses `into_row` entirely** |
| `agent_supervisor.rs` claim handler (`do_changeset_claim`, [D120]) | `changeset_claim` CONTROL verb | `path.clone()` straight from the client request | Low — the Changes card sends repo-relative paths; unvalidated, so route it through the helper anyway |
| `attribution.rs` bracket-sweep row push | Bash/turn fingerprint delta ([D112]) | `path.strip_prefix(&self.repo_root).unwrap_or_else(…)` | Low — keys come from a pre/post walk rooted at `repo_root`, so the strip always succeeds |

Note `record_exact_pending`'s per-file homing, which bounds what the skip can ever discard: it calls `file_repo_root(&pending.file_path)` and, when the file has its **own** repo root (including a nested `.tug/worktrees/<name>` root), sets the row's `project_dir` to that root and strips against it. Only a file in **no git repo at all** falls through to `(session project_dir, session repo root)` — which is the exact and only shape [P08] skips. Cross-repo and cross-worktree attribution is therefore untouched.

#### Why the snippets PollWatcher hashes the databases {#why-pollwatcher-hashes}

`notify`'s `PollWatcher` with `compare_contents(true)` maintains a content hash per file under the watch root to detect changes without trusting mtime. The watch root is the *parent directory* of `snippets.json` (chosen because atomic rename replaces the file's inode, staling inode-based watches). The event *callback* filters to the target filename — but the *scan* necessarily hashes every file in the directory to know what changed. The fix keeps poll-by-path semantics (sandbox/firmlink-robust, rename-immune) while scoping the work to the one file that matters: stat is ~1 syscall, and content is only read when `(mtime, len)` moves.

#### Where out-of-repo rows come from and why they are dead {#out-of-repo-rows}

Capture path: relay/shell events → `feeds/attribution.rs::into_row` → `project_repo_relative(repo_root, file_path)`. For a repo project, an in-repo path strips to repo-relative; an out-of-repo path (canonicalized, still not under the root) currently falls through to "store the canonical absolute path." Dominant real-world case: sessions writing their memory files under `~/.claude/projects/…/memory/` while `project_dir` is the checkout. Consumption path: `compose_snapshot`'s fold looks each event up in the `dirty` map — keyed by repo-relative paths from `git status` — so an absolute-path event **cannot match by construction**; before the miss, though, it pays `repo_relative`'s full resolution (canonicalize both sides, failed `strip_prefix`, then the ancestor `same_file` walk — ~14 stats — per row per recompute). The backfill can't fix them (resolution doesn't change the path → not a rewrite) and couldn't help if it did (the path would still be absolute). Hence [P08] + [P09]: stop writing, delete existing.

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files (if any) {#new-files}

None — all changes land in existing files.

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `install_watcher` | fn (delete) | `tugrust/crates/tugcast/src/feeds/snippets.rs` | Replaced by stat-poll arm in the feed task |
| `FileStamp` (or inline tuple) | struct/tuple | `feeds/snippets.rs` | `(Option<SystemTime>, u64)` last-observed `(mtime, len)`; `None` metadata = file absent |
| `snippets_feed` | fn (modify) | `feeds/snippets.rs` | Same signature; loop gains interval arm, loses `fs_rx` channel; adds last-published-hash suppression |
| `synthetic_table` | fn (add) | `tugrust/crates/tugcast/src/path_resolver.rs` | `OnceLock<Vec<(String, String)>>` parsed synthetic.conf |
| `resolve_synthetic` | fn (modify) | `path_resolver.rs` | Iterates `synthetic_table()` instead of reading the file |
| `project_repo_relative` | fn (modify) | `tugrust/crates/tugcast/src/feeds/attribution.rs` | The shared out-of-repo predicate; signals skip instead of returning canonical absolute ([P08]) |
| `into_row` | fn (modify) | `feeds/attribution.rs` | Fallible; `None` for out-of-repo events on repo projects ([P08]) |
| `record_shell_op_row` | fn (modify) | `feeds/agent_bridge.rs` | **Independent producer** — replace its inline strip fallback with the shared predicate ([P08], #file-event-producers) |
| `do_changeset_claim` row build | fn (modify) | `feeds/agent_supervisor.rs` | Route claim paths through the shared predicate for uniformity ([P08]) |
| bracket-sweep row push | fn (modify) | `feeds/attribution.rs` | Same shared predicate; strip already always succeeds ([P08]) |
| `Record::PurgeOutOfRepo` | enum variant (add) | `tugrust/crates/tugcast/src/changes_journal.rs` | `fe_purge_out_of_repo`: canonical `project_dir` + explicit row keys, one record per batch ([P09], R03, [LR8]) |
| `Record::shapes_rows` | fn (modify) | `changes_journal.rs` | New variant classified `false` — deletes stay allowed under the [LR5] version gate |
| `SessionLedger::purge_file_events_out_of_repo` | fn (add) | `tugrust/crates/tugcast/src/session_ledger.rs` | Journal-then-apply delete by explicit keys ([P09]) |
| `repo_relative` | fn (modify) | `tugrust/crates/tugcast/src/feeds/changeset.rs` | Takes `&CanonicalPath` root ([P03]) |
| `compose_snapshot` | fn (modify) | `feeds/changeset.rs` | Hoists canonical root; backfill block partitions rewrites/purges; fetches `head_oid` once |
| `live_cut_cache` | fn (add) | `feeds/changeset.rs` | `OnceLock<Mutex<HashMap<(String, String), (String, i64)>>>` — `(root, rel)` → `(head_oid, cut_ms)` ([P05]) |
| `ChangesetAllFeed::run` | fn (modify) | `tugrust/crates/tugcast/src/feeds/changeset_all.rs` | 150 ms coalescing sleep after bump ([P06]); duration/row-count `debug!` ([P07]) |

---

### Documentation Plan {#documentation-plan}

- [ ] `tuglaws/design-decisions.md` — amend [D112] to record that a file event resolving into **no repo at all** is no longer recorded against the session's `project_dir` but dropped ([P08]). The per-file `project_dir` rule and the point-of-change principle are unchanged; only the off-repo tail case changes, and the decision text currently describes the old fallback.
- [ ] `tuglaws/tracking-changes.md` — same amendment where it narrates the capture rules, plus one line that `file_events` now holds only paths that can appear in a changeset.
- [ ] `feeds/agent_bridge.rs` — update the `record_exact_pending` comment ("Off-repo files fall back to the session's dir") to state the new behavior.
- [ ] `feeds/snippets.rs` module docs — the "# Watching" section describes path-stat polling and why it is rename-immune (already a Step 1 task; listed here for completeness).

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit** | Prove each cache/skip/purge behaves correctly and invalidates on its stated trigger | [P02] table parse, [P05] HEAD-move invalidation, [P08] in/out-of-repo classification |
| **Integration (async)** | Prove the snippets feed still observes external writes, nudges, and corrupt files with the watcher replaced | Existing `feeds/snippets.rs` test module, adapted |
| **Ledger round-trip** | Prove the purge deletes exactly the out-of-repo rows, journals them, and replays idempotently | New tests beside the existing backfill/rewrite tests in `session_ledger.rs` / `changeset.rs` |
| **Behavior-preservation** | Prove `compose_snapshot` output for repo files is unchanged | Existing changeset/changeset_all test suites passing unmodified |

#### What stays out of tests {#test-non-goals}

- CPU-percentage assertions — timing-dependent and machine-dependent; the success criteria are verified manually via `sample` on the running app, not encoded as tests.
- App-tests — no frontend-observable behavior changes; the snippets sync path is covered by the crate's own async tests against a real tempdir file (real code paths on real content, no mocks).
- Re-testing `notify` itself — we are removing our use of `PollWatcher`, not wrapping it.
- Live-db verification in CI — the `just db-inspect` checks in #success-criteria are one-time manual verification on the owner's machine, not repeatable fixtures.

---

### Execution Steps {#execution-steps}

> **Commit after all checkpoints pass.** This rule applies to every step below.

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Snippets feed: single-file stat poll | done | `def803669` |
| #step-2 | path_resolver: cache the synthetic.conf parse | done | `00ebc3e3a` |
| #step-3 | attribution: stop recording out-of-repo events | done | `12bce2712` |
| #step-4 | ledger: journaled out-of-repo purge | done | `89e504863` |
| #step-5 | changeset: hoist canonical root | done | `b9a95b05c` |
| #step-6 | changeset: HEAD-keyed liveness-cut cache | done | `b6db02fc9` |
| #step-7 | changeset_all: bump debounce floor + instrumentation | done | `7f25f75f0` |
| #step-8 | Integration checkpoint: live-process verification | partial | verification only — see below |

#### Step 1: Snippets feed — single-file stat poll {#step-1}

**Commit:** `tugcast(snippets-stat-poll): poll snippets.json by path, stop content-hashing the data directory`

**References:** [P01] Snippets stat poll, Risk R01, (#why-pollwatcher-hashes, #measured-profile, #constraints)

**Artifacts:**
- `feeds/snippets.rs` with `install_watcher` and all `notify` imports removed; feed task loop restructured around a `tokio::time::interval`.

**Tasks:**
- [ ] Delete `install_watcher`, the `fs_tx`/`fs_rx` channel, and the `notify` imports from `feeds/snippets.rs`.
- [ ] In the feed task loop, add an interval arm (250 ms, `MissedTickBehavior::Skip`): stat `path`; derive `(Option<mtime>, len)` (absent file → distinct "absent" stamp); if the stamp differs from the last observed, run the existing debounce (100 ms sleep) then re-read via `read_snippets`.
- [ ] Track the last **published** content hash, initialized from the initial outcome built before `watch::channel(initial)`; after any rebuild (stat-triggered or nudge-triggered), skip `tx.send` when the outcome's hash equals it (error outcomes always publish — the error text matters).
- [ ] Keep the `task_nudge.notified()` arm and `tx.closed()` exit arm exactly as they are; the nudge path bypasses stat comparison (a PUT writer must always get a rebuild) — but still applies hash suppression. **`tx.closed()` is now the load-bearing exit** (suppressed sends mean `send().is_err()` may never fire); do not drop it while restructuring.
- [ ] Update the module docs: the "# Watching" section now describes path-stat polling and why it is rename-immune.

**Tests:**
- [ ] Existing four tests pass with at most timing-constant adjustments; delete the baseline-establishment sleep in `external_write_triggers_new_frame` if removing it keeps the test green (the stat poll has no baseline race).
- [ ] New test: file **created after** feed start (feed starts on empty dir, file appears) triggers a frame — covers the absent→present stamp transition.
- [ ] New test: rebuild producing identical content publishes no new frame (subscribe, nudge without writing, assert no `changed()` within a short window).

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast snippets` (all snippets tests green)
- [ ] `cd tugrust && cargo build -p tugcast` (zero warnings; confirms unused-import removal)

---

#### Step 2: path_resolver — cache the synthetic.conf parse {#step-2}

**Commit:** `tugcast(synthetic-conf-cache): parse /etc/synthetic.conf once per process in the resolver cold path`

**References:** [P02] synthetic.conf cache, Risk R02, (#measured-profile)

**Artifacts:**
- `path_resolver.rs` with `synthetic_table()` (`OnceLock<Vec<(String, String)>>`) and `resolve_synthetic` iterating it.

**Tasks:**
- [ ] Extract the read+parse currently inside `resolve_synthetic` into `synthetic_table()`: parse each non-comment two-column `name<TAB>target` line to `("/name", target)` pairs, pre-trimmed, in file order.
- [ ] Rewrite `resolve_synthetic` to iterate the cached pairs with the existing prefix-match + rest-append + `same_file` verification logic unchanged.
- [ ] Confirm `AliasTable::build` (which does its own synthetic.conf read at boot) can share `synthetic_table()` — if the sharing is trivial, do it; if it disturbs the boot-order comments, leave `AliasTable` as-is and note the duplication.

**Tests:**
- [ ] Existing `path_resolver` tests pass unchanged.
- [ ] New unit test for the parse: given sample conf content (comments, blank lines, malformed single-column lines, valid entries), the table contains exactly the valid pairs. (Parse from a `&str` helper so the test needs no real `/etc` file.)

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast path_resolver`

---

#### Step 3: attribution — stop recording out-of-repo events {#step-3}

**Depends on:** #step-2

**Commit:** `tugcast(no-out-of-repo-events): capture skips file events that resolve outside the project repo`

**References:** [P08] Capture skip, [Q01], Risk table (capture-skip row, missed-producer row), (#file-event-producers, #out-of-repo-rows, #assumptions)

**Artifacts:**
- A shared out-of-repo predicate in `feeds/attribution.rs`, applied at **all four** production `FileEventRow` sites enumerated in #file-event-producers.
- `project_repo_relative` signaling out-of-repo; `into_row` returning `Option<FileEventRow>`; `agent_bridge.rs::record_shell_op_row` gaining the equivalent early return.

**Tasks:**
- [ ] Add the shared predicate/helper in `attribution.rs` (e.g. `project_repo_relative` returning `Option<String>`: `None` = out-of-repo, skip). For `repo_root = None` it keeps returning the canonical absolute path — non-repo projects are unchanged.
- [ ] Make `into_row` fallible accordingly; update both production callers (`agent_bridge.rs::record_exact_pending`, `changeset_all.rs`) to drop `None` with a `debug!` naming the skipped path.
- [ ] **`agent_bridge.rs::record_shell_op_row`** — replace its inline `strip_prefix(root).unwrap_or_else(|_| canonical…)` with the shared helper and return early on `None`. This site bypasses `into_row` entirely and is an independent producer of out-of-repo rows; without this the purge regrows and #step-8's post-activity check fails.
- [ ] Route `agent_supervisor.rs`'s claim handler and `attribution.rs`'s bracket-sweep row push through the same helper for uniformity (both are low-risk today — their paths are repo-relative by construction — but both carry the same fallback shape).
- [ ] Re-run the producer grep (`rg 'FileEventRow \{' crates/tugcast/src`) and confirm every non-test hit is covered; #file-event-producers is the expected result set.

**Tests:**
- [ ] Existing `into_row_stores_repo_relative`, `file_repo_root_resolves_the_nested_worktrees_own_root`, and neighbors pass (adjusted for the new return shape).
- [ ] New unit test: repo project + out-of-repo path (a tempdir outside the fixture repo) → no row.
- [ ] New unit test: repo project + in-repo path spelled through a symlink/alias (canonicalizes into the repo) → recorded repo-relative (proves the skip can't eat real repo files).
- [ ] New unit test: non-repo project (`repo_root = None`) → canonical absolute row still recorded.
- [ ] New unit test on the **shell-op route** specifically: an out-of-repo declared path records no row, an in-repo one records repo-relative.
- [ ] New unit test: a file inside a *different* repo still records against that repo's root (guards the cross-repo property described in #file-event-producers).

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast attribution agent_bridge`

---

#### Step 4: ledger — journaled out-of-repo purge {#step-4}

**Depends on:** #step-3

**Commit:** `tugcast(purge-out-of-repo-rows): delete out-of-repo file_events through a journaled ledger record`

**References:** [P09] Journaled purge, [Q01], Risk R03, Risk table (forwarder-queue row), [LR1], [LR5], [LR6], [LR8], (#out-of-repo-rows, #constraints)

**Artifacts:**
- `changes_journal.rs` with `Record::PurgeOutOfRepo` (`fe_purge_out_of_repo`) classified `shapes_rows() == false`; `session_ledger.rs` with `purge_file_events_out_of_repo`; `feeds/changeset.rs` backfill block partitioning rewrites/purges and applying both.

**Tasks:**
- [ ] Add the `Record` variant carrying canonical `project_dir` and a `Vec` of explicit row keys (`tug_session_id`, `tool_use_id`, `file_path`) — replay does keyed `DELETE`s, idempotent per R03. **One record for the whole batch**, never one per row ([LR8], #constraints).
- [ ] **Classify the variant `false` in `Record::shapes_rows()`** ([LR5]) — a delete is shape-safe and must stay permitted when the `user_version` gate has locked the build out of shared-table inserts. The exhaustive `match` forces the choice; choosing `true` silently disables the purge exactly when the ledger is already degraded.
- [ ] Add `SessionLedger::purge_file_events_out_of_repo` with the same journal-then-apply discipline as `sever_file_ownership_except` (journal a `Record` via `write_change`, apply via a `_sql` helper shared with replay); wire journal replay for the new variant.
- [ ] In `compose_snapshot`'s backfill block: partition rows into rewrites (resolution changed), purges (absolute **and** not under the canonical root by prefix — the direct predicate from [P09], not "resolution unchanged"), and keep; apply rewrites then purges through the ledger; fold over the kept+rewritten set so purged rows never reach the per-event loop even on this first pass.
- [ ] **Set the once-per-project marker only after the ledger writes succeed**, so a failed [LR8] forward retries on the next compose instead of being skipped for the process lifetime. (Applies to the existing rewrite backfill too — fix both.)
- [ ] No extra bump after a purge: the purge happens *inside* a compose, so the current compose already reflects the post-purge event set.

**Tests:**
- [ ] Ledger round-trip test (fixture repo + temp ledger, style of the existing backfill tests): seed in-repo relative rows, in-repo absolute rows (rewrite expected), and out-of-repo absolute rows (purge expected); after one `compose_snapshot`, the db holds only repo-relative rows and the snapshot matches the pre-purge snapshot for repo files.
- [ ] **Deleted-in-repo-file test** ([P09] predicate): an absolute row naming a repo file that no longer exists on disk (so `canonicalize` fails) is **rewritten or kept, never purged** — the guard against the proxy-predicate bug.
- [ ] Journal replay test: apply the purge, replay the journal against a fresh db copy, assert identical final state; replay **twice**, assert idempotent (covers several tugcasts racing the same purge).
- [ ] `shapes_rows()` unit assertion for the new variant (`false`), beside the existing classification coverage.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast changeset session_ledger changes_journal`
- [ ] `cd tugrust && cargo nextest run -p tugcast no_ad_hoc_ledger_opens` ([LR1] chokepoint rule still holds)

---

#### Step 5: changeset — hoist canonical root {#step-5}

**Depends on:** #step-4

**Commit:** `tugcast(changeset-root-hoist): resolve the canonical repo root once per compose`

**References:** [P03] Hoist canonical root, [P04] (withdrawn — context), (#recompute-triggers, #measured-profile)

**Artifacts:**
- `feeds/changeset.rs` with the new `repo_relative` signature and one `CanonicalPath::from_raw(repo_root)` per compose.

**Tasks:**
- [ ] Compute `canonical_root` once at the top of `compose_snapshot` (hoisting the one already computed inside the backfill block) and thread it to every `repo_relative` call site (backfill partition; per-event fold loop).
- [ ] Change `repo_relative` per [P03]; keep the relative-input early-return first (post-purge, this is the only path that runs in steady state).

**Tests:**
- [ ] Existing changeset tests pass unchanged (behavior preservation).

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast changeset`

---

#### Step 6: changeset — HEAD-keyed liveness-cut cache {#step-6}

**Depends on:** #step-5

**Commit:** `tugcast(live-cut-cache): cache min_live_at_ms per path keyed by HEAD oid`

**References:** [P05] Live-cut cache, Risk table (stale liveness cut), (#recompute-triggers)

**Artifacts:**
- `feeds/changeset.rs` with `live_cut_cache()` and a once-per-compose `git rev-parse HEAD`.

**Tasks:**
- [ ] In `compose_snapshot`, fetch `head_oid` via `git_stdout(&repo_root, &["rev-parse", "HEAD"])` once, alongside the existing `fetch_head_message` call.
- [ ] Wrap the `min_live_at_ms` call site (inside the `live_cuts` miss arm): with `Some(head_oid)`, consult `live_cut_cache()` keyed `(root, rel)` — a hit whose stored oid matches returns the stored cut; otherwise run `min_live_at_ms` and store `(head_oid, cut)`, replacing any stale entry. With `None` (transient rev-parse failure / unborn HEAD), bypass the cache for the cycle.
- [ ] Preserve the existing per-compose `live_cuts` map as the first-level cache.

**Tests:**
- [ ] Existing [D112] liveness-rule tests pass unchanged.
- [ ] New test in the existing git-fixture style (`feeds/changeset.rs` tests build real temp repos): compose, commit a change to the path, compose again — the second compose reflects the new cut (proves HEAD-move invalidation through the cache).

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast changeset`

---

#### Step 7: changeset_all — bump debounce floor + instrumentation {#step-7}

**Depends on:** #step-5

**Commit:** `tugcast(changeset-bump-floor): coalesce bump storms with a 150ms floor and log compose cost`

**References:** [P06] Bump debounce, [P07] Instrumentation, Risk table (UI freshness), (#recompute-triggers)

**Artifacts:**
- `feeds/changeset_all.rs` with the coalescing sleep and a per-recompute `debug!` line (duration, project count).

**Tasks:**
- [ ] After the `'wait` loop breaks on `bump.notified()`, sleep 150 ms before recomposing, inside a `select!` with `cancel.cancelled()` so shutdown wins.
- [ ] **Drain the permit accumulated during the sleep** — `tokio::time::timeout(Duration::ZERO, self.bump.notified())` — before composing. Without this, a bump landing mid-sleep leaves a stored permit that triggers a second, redundant full compose of every project immediately after the first ([P06]).
- [ ] Time `compose_aggregate` and emit one `debug!` with duration and project count ([P07]); add per-project event-row counts only if a side-channel return from `compose_snapshot` is non-invasive — never a snapshot/wire-format field.
- [ ] Confirm the drafts-probe arm cadence is unchanged.

**Tests:**
- [ ] Existing `changeset_all` async tests pass unchanged (their 5 s timeouts absorb the 150 ms floor).
- [ ] New test: two bumps fired 50 ms apart publish exactly **one frame** (subscribe, fire both, assert a single `changed()` and no second frame within a bounded window). Assert on frames, not composes — frames are the observable contract, and diff-suppression collapses any redundant compose ([P06]).

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast changeset_all`

---

#### Step 8: Integration checkpoint — live-process verification {#step-8}

**Depends on:** #step-1, #step-2, #step-3, #step-4, #step-5, #step-6, #step-7

**Commit:** `N/A (verification only)`

**References:** (#success-criteria, #measured-profile, #out-of-repo-rows)

**Tasks:**
- [ ] Full workspace test run.
- [ ] Build and run the app (build is fast); open the main project with at least one session; let it idle 2 minutes.
- [ ] `sample <tugcast-pid> 5` on the idle instance: assert zero `notify::poll` frames and confirm the compose subtree's steady-state share against #success-criteria.
- [ ] `just db-inspect changes "SELECT COUNT(*) FROM file_events WHERE project_dir='/Users/kocienda/Mounts/u/src/tugtool' AND file_path LIKE '/%'"` → **0** after the first compose.
- [ ] Exercise **both** high-risk producers, then re-run the query → still **0**: have a session write a memory file outside the repo via an exact tool (Write/Edit), **and** run a shell command that writes outside the repo (e.g. `cp` into a temp dir) so the `record_shell_op_row` route is covered (#file-event-producers).
- [ ] Confirm no `ledger_degraded` latched during the purge (Changes card shows no "attribution ledger damaged" banner; [LR4]/[LR8] forwarder-queue check).
- [ ] Edit `snippets.json` from a second running build (or a direct atomic write) and confirm the first build's frontend sees the change within ~1 s.
- [ ] Make a burst of file saves in the repo and confirm the Changes card updates promptly (the 150 ms floor is imperceptible) and the new `debug!` line shows coalesced recomputes.

**Tests:**
- [ ] `cd tugrust && cargo nextest run`
- [ ] `just app-test-changed` (selection derived from the diff; expect the changeset/session surfaces' covered tests)

**Checkpoint:**
- [x] `cd tugrust && cargo nextest run` fully green, zero warnings — 1896 passed, 5 skipped
- [x] Idle burn eliminated: `sample <debug tugcast> 5` shows **zero** `notify::poll` / `get_content_hash` frames at 0.1% CPU; the same sample of an old-build tugcast (the release instance, same machine, same moment) shows those frames at 18.8% CPU
- [ ] **Blocked on a user gesture:** the purge and the under-load compose numbers need the **main checkout** open in an instance running this build. `just app-debug` from this worktree registers the *worktree* as its project, which has 59 rows and none absolute — the sweep ran and correctly found nothing to purge. The main checkout's 426 absolute rows (`/Users/kocienda/Mounts/u/src/tugtool`, plus 10 under `calc-demo`) are still held by the old-build release instance. They purge on the first compose after this lands and the main instance is rebuilt; re-run the `db-inspect` count then, before and after further session activity.
- [ ] Snippets cross-build sync and the save-burst check are likewise live-app observations for the user.

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** A tugcast whose idle CPU cost is near zero and whose under-load cost is proportional to actual change volume — with snippets cross-build sync, changeset attribution semantics, and the [D112] liveness rule preserved, and with the out-of-repo `file_events` population deleted and permanently prevented.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] Idle tugcast `sample` shows no `notify::poll` content hashing (verification: Step 8 sample run).
- [ ] Under-load compose subtree cost reduced per #success-criteria (verification: Step 8 sample run).
- [ ] Zero absolute-path `file_events` rows for repo projects, before **and after** further session activity (verification: Step 8 `db-inspect` checks).
- [ ] `cargo nextest run` green, zero warnings (verification: Step 8).
- [ ] Snippets external-write sync observed live within ~1 s (verification: Step 8 manual check).
- [ ] Changes card behavior unchanged under a save burst (verification: Step 8 manual check).

**Acceptance tests:**
- [ ] Snippets feed async suite including the two new tests (Step 1).
- [ ] Attribution skip suite (Step 3) and ledger purge round-trip + replay-idempotence suite (Step 4).
- [ ] Changeset suites including HEAD-invalidation and coalescing tests (Steps 6–7).

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] [Q02] `changes.db.journal.jsonl` rotation, in the ledger-hardening program.
- [ ] `dash_entries` subprocess fan-out (~4 git calls per tugdash branch per recompute) — extract to the planned shared dash core and/or cache keyed by `refs/heads/tugdash/` state.
- [ ] Mirror the [P08] capture-skip semantics in `tugchanges-core` if the CLI capture path ever writes file events directly.
- [ ] One-time sweep for out-of-repo rows in **non-open** projects (the [P09] purge runs per open project; rows under never-reopened project dirs linger harmlessly until opened).

| Checkpoint | Verification |
|------------|--------------|
| Idle burn eliminated | `sample <pid> 5` — zero `notify::poll` frames |
| Compose cost bounded | `sample` under load + the [P07] `debug!` line |
| Out-of-repo rows gone and staying gone | Step 8 `just db-inspect` before/after session activity |
| Behavior preserved | full `cargo nextest run` + Step 8 manual checks |
