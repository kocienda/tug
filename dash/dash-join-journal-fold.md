## Fold the join journal into the operation log {#dash-join-journal-fold}

**Purpose:** Make a join's interrupt/resume state and its undo record one artifact. Today `tugutil dash join` writes two parallel records into `project_state_dir` — the op log's `oplog-<seq>.json` (the *reverse* record, for undo) and `join-journal-<name>.json` (the *forward* record, for `--continue`) — and an interrupted join leaves both describing the same event, free to disagree. After this phase the op payload carries the join's phase and the teardown checklist, `--continue` resumes from the dash's incomplete op, and the journal file format is retired with a read-time fold for any journal still on disk at upgrade. This is [P10] of `dash/archive/dash-hardening.md`, deferred there until the op record was enriched; both enrichments have now landed.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-08-24 |

---

### Review Record {#review-record}

**Round 1 — 2026-08-24, opus.** Reviewed `plan:8825d1ac1115c7ad`. Lint: 0 errors, 1 warning (the absent Review Record, fixed by this section).
Oriented on: a first pass over a never-reviewed plan, read against `tugdash-core/src/{ops,oplog,replay,dash}.rs`, `tugcast/src/feeds/{join_board,base_motion}.rs`, `tugutil/src/dash.rs`, `tugutil/tests/dash_binding_cli.rs`, and `tugutil-core/src/worktree.rs`.
Applied: a **performance and correctness defect in the central predicate** — the plan routed `join_in_flight` through `oplog::list_ops`, whose first act is `ref_seqs` → `git for-each-ref`, a process spawn, and `join_blockers_from_detail` sits on the join board's *explicitly uncached* path (`join_board.rs`'s module doc names blockers as never cached because they answer to a journal file, which "does not move a SHA"), recomputed per dash per tick, where today it costs one failed `open()`; new [P09] gives `oplog` a `payload_seqs_desc` read-dir scan with no subprocess, and Spec S01, Strategy, Scope, and Step 1 now name it. A **hole under that same predicate**: the plan assumed a join in flight is always the dash's newest op, but `undo_in` selects with `find(|op| op.is_undoable())`, which *skips* an incomplete op rather than stopping at it — its `incomplete-op` refusal fires only when nothing is undoable — so `tugutil dash undo` during an interrupted join records an Undo *above* the in-flight join; the Assumptions bullet is rewritten to say so, [P09]'s scan tests the full predicate all the way back instead of short-circuiting on "an op for this dash", and two tests pin it (`an_undo_recorded_above_an_in_flight_join_does_not_hide_it`, `the_in_flight_read_touches_no_refs`). Three factual corrections against the tree: `sanitize_branch_name` is `tugutil_core::sanitize_branch_name` from `tugutil-core/src/worktree.rs`, not `crate::ops` as [P05] and Step 1 claimed; `capture_before` does **not** fail once the branch is deleted — `dash_base` falls back to `detect_default_branch` and both `rev-parse`s are `unwrap_or_default()` — so [P05]'s fallback rationale was wrong and, worse, would have recorded a *guessed* `base_branch` over the real one the journal holds, which the fold now prefers explicitly; and [P07] needed to say that `dash_binding_cli.rs`'s `tug()` returns a `std::process::Command` via `CommandCargoExt` (so `spawn`/`kill` exist — `assert_cmd::Command` has neither), that every invocation must `.current_dir(&root)`, and that `remove_dash_worktree` reaps tmux before its first `worktree remove`. The **tuglaws cross-check was absent** and is now a Deep Dive naming [L23] (the fold deletes the journal only after the payload write lands; the phase write gains `write_atomic`, which the journal never had), [L28] (one published predicate replaces five callers stat-ing a file — the fold improves this law rather than merely honoring it), [L31] (the unreadable-journal path returns a named `Err` rather than a silent `None`; the deleted "cannot be undone" warning is safe only because [P04] carries the seq, and `record_complete`'s own failure warning stays), and [D138]. Verified and left alone: the phantom-op claim is real — `oplog::abandon` has no call site in `ops.rs`, while `replay.rs` calls it on all three refusal arms, so the join genuinely is the one verb that forgot, and [P03]'s sequencing ahead of the fold is right.
Deferred: nothing.

---

### Phase Overview {#phase-overview}

#### Context {#context}

`tugrust/crates/tugdash-core/src/ops.rs` holds the **join journal**: a private `JoinJournal { name, base_branch, strategy, commit_hash, phase: JoinPhase, message: Option<String> }` serialized to `project_state_dir(repo)/join-journal-<sanitize_branch_name(name)>.json` by `write_join_journal`, read by `read_join_journal`, removed by `clear_join_journal`. `JoinPhase` is `Integrated | WorktreeRemoved | BranchDeleted`. `join_in_with_progress` writes the journal at phase `Integrated` the instant the integrate commit lands (two sites: the resolved-candidate arm and the strategy `match` for a plain join), then calls `finish_join_teardown(TeardownTarget, journal, warnings, on_beat)`, which advances the phase after each idempotent step — `remove_dash_worktree` → `WorktreeRemoved`; `clear_candidate` + `workshop::remove` + `branch -D` → `BranchDeleted`; then the `append_dash_log` line, `clear_join_journal`, and the op-log completion. `--continue` (`JoinOptions.continue_join`) re-enters `finish_join_teardown` with whatever the file says.

`tugrust/crates/tugdash-core/src/oplog.rs` holds the **operation log** ([D157]): per operation, a keepalive ref `refs/tug/oplog/<seq>` parenting every tip the verb will move or delete, and a payload `oplog-<seq>.json` (`OpPayload { version, seq, verb, dash, recorded_at, before: OpBefore, after: Option<OpAfter>, undone_by, reverses }`) written by `record_begin` and rewritten by `record_complete`. A join records itself in `join_in_with_progress` **after** the `ahead == 0` refusal and the `commit_worktree_dirt` sweep, and completes in `finish_join_teardown` by asking `oplog::newest_incomplete(repo, name, OpVerb::Join)` — because the teardown receives only the journal, which carries no sequence number.

So one join produces two files that both say "this join is between integrate and done", cleared at different moments by different code, and the seam already shows:

- **A conflicted join leaves a phantom op.** After `record_begin`, the strategy arms return `Ok(conflict_outcome(...))` on a merge conflict and `Err(...)` on a stale candidate or a failed `merge`/`commit` — and nothing calls `oplog::abandon`. The op stays incomplete forever: `tugutil dash undo --list` prints it as `incomplete`, and `undo_in` refuses with `incomplete-op` naming a join that never happened. Today that is merely misleading, because "join in flight" is the journal's fact, not the op's. After the fold it would be *wrong*, because an incomplete join op is exactly what "join in flight" will mean.
- **Completion finds its op by search.** `newest_incomplete` exists only because the teardown has no seq in hand; with the seq carried on the resume record itself, the search — and the "no open op-log record; it cannot be undone" warning when the search fails — goes away.
- **Two retention regimes.** The op log prunes at `OPLOG_CAP` (50); the journal is cleared at teardown end and otherwise lives forever. A journal whose op was pruned is a resume record with no undo record.

The consumers of "a join is in flight" are few and all go through one predicate. `ops::join_in_flight(repo, name) -> bool` is re-exported from `lib.rs` and read by `replay.rs` (`ReplayOutcome::deferred("join-journal", ...)`), by `tugcast/src/feeds/join_board.rs` (the orphaned-workshop sweep skips a dash whose join is in flight), and by `tugcast/src/feeds/base_motion.rs` (`DashReading.join_journal` → `Decision::Skip("join-journal")`). Inside `ops.rs`, `read_join_journal` is read directly by `join_blockers_from_detail` (the `stale-journal` blocker, suppressed when `held == Some("join")`), by the `joining` input to `crate::dash::join_ready` in the detail composition, by `status_in` (`DashStatus.join_journal_phase`, formatted `{:?}` of the phase, which `derive_stage` turns into the `joining` stage and `tugutil dash status` prints as `Landing interrupted at: <phase>`), and by the `--continue` and stale-journal guards in `join_in_with_progress`.

The model this converges on is jj's: `lib/src/op_store.rs` and `lib/src/transaction.rs` make every mutation one operation record — a transaction that commits writes an operation, one that is dropped writes nothing — with no side journals. Here the op record already exists; the fold moves the journal's four facts (`phase`, `commit_hash`, `strategy`, `message`) onto it and makes the dropped-transaction rule explicit for the pre-integrate exits.

Both preconditions [P10] named are met: `dash/dash-hardening-2.md` landed as `42ac1eb0b` (the conflict chain joins the keepalive, `OpBefore.conflict`) and `dash/dash-occupancy-lease.md` landed as `06aae833c` (`OpBefore.broke_lease`). Both plans are archived under `dash/archive/`.

#### Strategy {#strategy}

- **Put the phase on the record, not beside it.** `OpPayload` gains `join: Option<JoinProgress>` — phase, commit hash, strategy, message — written by a new `oplog::record_join_progress`. Payload version stays 1: the field is additive and defaults to `None`, so every payload on disk still parses ([P01]).
- **Make the dropped-transaction rule explicit first, while the journal still stands.** Extract the integrate arms into one function and abandon the op on every exit that lands nothing ([P03]). This step is independently correct today and is what makes the next step safe.
- **Then swap the teardown's input from the journal to the op**, one function at a time, keeping every phase idempotent and re-enterable exactly as it is ([P04]). `--continue` resumes from `oplog::join_in_flight`. The journal type and its three file functions are deleted in the same step — no shim keeps both alive.
- **Fold legacy journals at the one reader**, lazily, with no upgrade step and no daemon — the same shape as `migrate_worktrees` ([P05]).
- **Keep the in-flight read off the subprocess path.** The blockers are recomputed per dash per tick and are explicitly never cached, so the predicate reads payload files directly and never `list_ops` ([P09]).
- **Keep the wire exactly as it is.** `stale-journal`, `join-journal`, and `join_journal_phase` are conditions the client already understands; the fold changes storage, not vocabulary (owner-decided, [P02]).
- **Test bar: the existing `--continue` coverage rerun against the folded machinery, plus a real kill at each phase boundary** — a `tugutil dash join` process SIGKILLed mid-teardown by the CLI integration suite, with no crash-injection scaffolding in product code ([P07]).
- **Doctrine last**: `tuglaws/dash-lifecycle.md` and a new global decision, once the code says what the prose will claim ([P08]).

#### Success Criteria (Measurable) {#success-criteria}

- After a join completes, `project_state_dir` contains no `join-journal-*.json` for that dash and never did during the join; `oplog-<seq>.json` for the join carries `join.phase == "BranchDeleted"` and an `after` (Rust test, Step 3).
- A join interrupted at each of the three phase boundaries by SIGKILL of the real `tugutil` process leaves exactly one incomplete join op carrying the phase reached, no journal file, and `--continue` finishes it: worktree gone, branch gone, dash-log line present, op completed, and `tugutil dash undo` then restores the dash (CLI integration test, Step 4).
- Every existing `--continue` / stale-journal test in `ops.rs` passes unchanged in what it asserts, with its fixture seeded through the op log (Rust tests, Step 3).
- A conflicted join, a stale-candidate refusal, and a failed integrate leave **no** op record; `tugutil dash undo --list` after a conflicted join shows nothing for it (Rust test, Step 2).
- A legacy `join-journal-<name>.json` present at upgrade is folded into the op log on first read — attached to the dash's incomplete join op when one exists, otherwise recorded as one — and the file is deleted; `--continue` then completes it (Rust test, Step 1; CLI test, Step 4).
- `undo_in` still refuses a mid-teardown join with `incomplete-op`, and `oplog::abandon` still deletes both halves — the payload, and with it the progress (Rust test, Step 1 and Step 3).
- The in-flight read spawns no git process: it survives every `refs/tug/oplog/*` being deleted, and it still finds a join under a newer Undo record for the same dash (Rust tests, Step 1).
- `cargo nextest run -p tugdash-core -p tugcast -p tugutil` green under `-D warnings`; `grep -rn "JoinJournal\|join_journal_path\|write_join_journal\|read_join_journal\|clear_join_journal" tugrust/crates` returns nothing (Step 3 checkpoint).

#### Scope {#scope}

1. `oplog.rs`: `JoinPhase` (moved here, made `pub`), `JoinProgress`, `OpPayload.join`, `record_join_progress`, `join_in_flight`, `payload_seqs_desc`, `fold_legacy_join_journal`, and tests.
2. `ops.rs`: `integrate_join` extraction with abandon-on-no-landing; `finish_join_teardown` over the op; `--continue` from the op; all in-crate readers moved to `oplog::join_in_flight`; `JoinJournal` + file functions deleted; test fixtures reseeded through the op log.
3. `tugutil/src/dash.rs`: `print_oplog` names the teardown phase of an incomplete join; `--continue`'s no-op message unchanged in meaning.
4. `tugutil/tests/dash_binding_cli.rs`: kill-mid-teardown at each phase boundary via a PATH `git` shim; legacy-journal fold through the real binary.
5. Comment and doc surfaces that describe the journal *file*: `oplog.rs` module doc, `join_board.rs`, `base_motion.rs`, `tuglaws/dash-lifecycle.md`, `tuglaws/design-decisions.md`.

#### Non-goals (Explicitly out of scope) {#non-goals}

- **No wire rename.** The blocker kind `stale-journal` (`tugcast-core/src/types.rs`, `tugdeck/src/lib/changeset-types.ts`, `session-changes-dash-join.tsx`), the replay deferral reason `join-journal`, the `Decision::Skip("join-journal")` in `base_motion.rs`, and the `join_journal_phase` key of `tugutil dash status --json` all keep their spellings and their values. tugdeck is untouched.
- **No new verb.** There is no `tugutil dash join --abandon`; a mid-teardown op is finished by `--continue`, exactly as today. `oplog::abandon` remains the internal path a verb takes when it declines.
- **No change to the landing doctrine**, to what a join lands, or to any refusal sentence. `stale_journal_detail` keeps its text.
- **No change to undo/redo semantics** beyond the payload carrying more; `is_undoable`, `is_redoable`, and every CAS refusal are untouched.
- **No change to `OPLOG_CAP` or pruning.** Pruning is oldest-first over 50 records; a join recorded moments ago is 49 operations away from being reached.

#### Dependencies / Prerequisites {#dependencies}

- `dash/archive/dash-hardening.md` [P01]–[P05] — the op record shape, sequence allocation, undo semantics, retention (landed; [D157]).
- `dash/archive/dash-hardening-2.md` [P03], [P07]–[P10] — the conflict chain in the keepalive, redo (landed as `42ac1eb0b`).
- `dash/archive/dash-occupancy-lease.md` [P04]–[P05] — `OpBefore.broke_lease` (landed as `06aae833c`, [D160]).
- `serde` with `#[serde(default)]` tolerance already in use throughout `oplog.rs`; no new crates.

#### Constraints {#constraints}

- `-D warnings` across the workspace; `cargo nextest run` is the test runner.
- No daemon, lock file, or registry; no upgrade step the user runs. Migration is read-time and idempotent ([P05]).
- Every teardown phase stays idempotent and re-enterable: `remove_dash_worktree` already tolerates a missing worktree, `branch -D` is guarded by `branch_exists`, `clear_candidate` and `workshop::remove` tolerate absence — the fold must not introduce a phase that is not.
- Product code carries no test-only crash hooks. The kill tests pause git from outside via `PATH` ([P07]).
- No AI attribution in commits; commit subjects in the `tugdash(<name>): …` house form during the run.

#### Assumptions {#assumptions}

- Every `git` invocation in `tugdash-core` goes through `Command::new("git")` resolved from `PATH` (`ops::git_output`, `dash.rs`), so a shim directory prepended to `PATH` for a spawned `tugutil` intercepts every call it makes. Verified in `ops.rs` (`git_output`) and `dash.rs`.
- A join in flight is **not** reliably the dash's newest op, and the predicate must not assume it is. `undo_in` selects with `candidates.iter().find(|op| op.is_undoable())`, which *skips* an incomplete op rather than stopping at it — its `incomplete-op` refusal fires only when nothing at all is undoable. So `tugutil dash undo <name>` during an interrupted join reverses some older completed op and calls `record_begin(OpVerb::Undo, name, …)`, leaving an Undo record newer than the in-flight join. The scan in [P09] therefore tests the full predicate all the way back and never short-circuits on "an op for this dash". Undo reaching past an interrupted join is pre-existing — the journal never blocked it either — and is out of scope; what is in scope is that the fold must not depend on it being impossible.
- The state dir under test is redirected with `TUG_DATA_DIR` (`redirect_state_dir` in `ops.rs` tests; `tug()` in `dash_binding_cli.rs`), so tests write no real payloads.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

None open. The one design question raised during authoring — whether the wire vocabulary (`stale-journal`, `join-journal`, `join_journal_phase`) follows the storage into op-log terms — was put to the owner on 2026-08-24 and decided as *keep the wire spellings*; it is recorded in [P02].

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| The fold regresses interrupt recovery the journal proved | high | low | Every existing `--continue`/stale-journal test reruns with its assertions intact; three real SIGKILL tests, one per phase boundary ([P07]) | Any red in Step 3 or Step 4 |
| An incomplete op that never integrated reads as "join in flight" and blocks every later join of that dash | high | low | In-flight requires `join.is_some()` ([P02]); pre-integrate exits abandon the record ([P03]); a pinned test for each | A `stale-journal` blocker with no `join` progress on the op |
| A legacy journal at upgrade is silently dropped or doubles the record | med | low | Fold attaches to the existing incomplete op when there is one, records one otherwise, deletes the file only after the payload write succeeds; unreadable file left in place and named by `--continue` ([P05]) | A journal file that survives a `--continue` |

**Risk R01: The fold regresses interrupt recovery** {#r01-regress-recovery}

- **Risk:** The journal is proven crash machinery; moving its state onto a record that is also rewritten at completion could introduce a write ordering under which a crash loses the phase.
- **Mitigation:**
  - The phase write stays exactly where the journal write is today — before each phase's actions are treated as done — and goes through `write_atomic` (rename-into-place), which the journal did not use.
  - Step 3 rewrites fixtures, not assertions: every existing test still asserts what it asserted.
  - Step 4 kills the real binary at each boundary and resumes with the real binary.
- **Residual risk:** A crash between `record_complete` and the dash-log append (the last two writes) is the same window that exists today, resolved the same way: the dash-log line is appended before completion, as it is now.

**Risk R02: In-flight semantics drift from "the journal exists"** {#r02-inflight-semantics}

- **Risk:** Today "in flight" is a file's existence; after the fold it is a predicate over the op list, and every reader must agree on the predicate.
- **Mitigation:**
  - One function, `oplog::join_in_flight`, is the only spelling; `ops::join_in_flight` delegates to it and every in-crate reader that used `read_join_journal` calls it.
  - Step 3's checkpoint greps the journal symbols out of the tree.
- **Residual risk:** None identified.

---

### Design Decisions {#design-decisions}

#### [P01] The op payload carries the join's progress as an optional, additive field (DECIDED) {#p01-progress-on-payload}

**Decision:** `OpPayload` gains `pub join: Option<JoinProgress>` with `#[serde(default, skip_serializing_if = "Option::is_none")]`, where

```rust
pub struct JoinProgress {
    pub phase: JoinPhase,          // Integrated | WorktreeRemoved | BranchDeleted
    pub commit_hash: String,       // the integrate commit on the base
    pub strategy: String,          // JoinStrategy::as_str()
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,   // what the integrate committed with
}
```

`JoinPhase` moves from `ops.rs` to `oplog.rs` and becomes `pub`, with its serde spelling unchanged (unit variants, default naming), so a folded legacy journal's `"phase": "Integrated"` parses into it directly. A new `oplog::record_join_progress(repo, seq, progress: JoinProgress) -> Result<(), String>` reads the payload, sets `join`, and writes it through `write_payload` (atomic). Payload `version` stays `1`.

**Rationale:**
- The journal's `name` and `base_branch` are already on the payload (`dash`, `before.base_branch`); only four facts are new, and none of them belongs in `before` (captured before the integrate) or `after` (absent until done). They are the *during*.
- Additive-with-default is how every prior payload field landed (`conflict`, `broke_lease`); `an_old_payload_without_the_conflict_field_still_parses` is the pattern to copy.
- Keeping `join` on the payload **after** completion turns the record into what the journal never was: the receipt of how the join went, readable from `dash undo --list`.

**Implications:**
- `join_in_flight` must test `after.is_none() && join.is_some()`, never `join.is_some()` alone ([P02]).
- `OpPayload` construction sites (`record_begin`, and the test fixtures in `oplog.rs`) add `join: None`.

#### [P02] "A join is in flight" is: the dash's newest incomplete join op carries progress; the wire keeps its words (DECIDED) {#p02-in-flight-predicate}

**Decision:** `oplog::join_in_flight(repo, name) -> Option<OpPayload>` returns the newest op with `dash == name`, `verb == OpVerb::Join`, `after.is_none()`, and `join.is_some()`, after first folding any legacy journal ([P05]), scanning as [P09] specifies. `ops::join_in_flight(repo, name) -> bool` keeps its signature and delegates (through `main_repo_root`, which is `find_repo_root_from` — a filesystem walk, no subprocess — so a caller holding a worktree path reads the right state dir). `DashStatus.join_journal_phase` is `join_in_flight(...).map(|op| format!("{:?}", op.join.unwrap().phase))` — the same strings as today. The blocker kind `stale-journal`, its `stale_journal_detail` sentence, replay's `"join-journal"`, base-motion's `Decision::Skip("join-journal")`, and the `join_journal_phase` JSON key are unchanged.

**Rationale:**
- An incomplete op with no progress is a join that died before integrating (or, until Step 2 lands, a conflicted one). Neither is a teardown to resume, and reading it as in-flight would refuse every later join of the dash with a `--continue` that has nothing to continue.
- Owner-decided 2026-08-24: the wire names a condition the client already handles ("resume the interrupted teardown"), not a file; renaming would touch tugcast-core, tugdeck, two bun tests, and an app-test for no user-visible gain.

**Implications:**
- `newest_incomplete` stays (the fold in [P05] and existing tests use it), but the teardown no longer calls it.
- Comments in `join_board.rs` and `base_motion.rs` that describe *the journal file* are reworded to describe the incomplete op; the identifiers `join_journal` / `"join-journal"` in `base_motion.rs` stay.

#### [P03] A join that lands nothing records nothing: the integrate is one function, and every exit that does not land abandons the op (DECIDED) {#p03-abandon-on-no-landing}

**Decision:** The code between `record_begin` and the journal write in `join_in_with_progress` — the resolved-candidate arm and the `match opts.strategy` for a plain join — is extracted into

```rust
enum Integration {
    Landed { commit_hash: String, message: Option<String> },
    Conflicted(Vec<String>),
}
fn integrate_join(repo_root, name, branch, base_branch, opts: &JoinOptions, warnings: &mut Vec<String>) -> Result<Integration, String>
```

The caller does `match integrate_join(...) { Ok(Landed {..}) => record progress + teardown, Ok(Conflicted(c)) => { oplog::abandon(repo, op_seq); return Ok(conflict_outcome(c, warnings)) }, Err(e) => { oplog::abandon(repo, op_seq); return Err(e) } }`. Progress is recorded at phase `Integrated` by `record_join_progress` at exactly the point `write_join_journal` is called today, before `on_beat("squash", "done")`.

**Rationale:**
- jj's rule, stated in `transaction.rs`: a transaction that is not committed writes no operation. The op log already applies it to undo (`undo_in` abandons on a declined reversal) and to replay's CAS refusal; the join is the one verb that forgot.
- After [P02], an incomplete join op is the resume record. The only way to keep that meaning honest is to guarantee that an op which never integrated does not survive.
- One function with one return type is also the one place the three landing shapes (candidate, squash/merge, rebase) can be read together.

**Implications:**
- Today's phantom-op behaviour after a conflicted join goes away. This is the one change to what `tugutil dash undo --list` shows and it is a correction of the consolidated artifact, not a feature: the list stops naming a join that did not happen.
- `commit_worktree_dirt`'s round on the dash branch is not undone by the abandon — it never was, and it is the dash's own work.
- The `?` operators inside the integrate arms now surface as `Err` from `integrate_join` and are abandoned at the single call site rather than at each arm.

#### [P04] The teardown takes the op, advances progress in place, and completes by seq (DECIDED) {#p04-teardown-over-op}

**Decision:** `finish_join_teardown(target: TeardownTarget, op_seq: u64, mut progress: JoinProgress, warnings, on_beat)` replaces the journal parameter. Each phase advance is `progress.phase = X; oplog::record_join_progress(repo_root, op_seq, progress.clone())?;` at the same three points the journal is written today. Completion is `oplog::record_complete(repo_root, op_seq, OpAfter { base_tip, landed_commit: Some(progress.commit_hash), .. })` after the dash-log append; `clear_join_journal` and the `newest_incomplete` search are deleted along with the "No open op-log record … cannot be undone" warning. `--continue` does `let op = oplog::join_in_flight(&repo_root, name).ok_or_else(|| format!("No interrupted join to continue for dash '{}'.", name))?` and enters the teardown with `op.seq` and `op.join.unwrap()`. `base_branch` for the outcome comes from `op.before.base_branch`.

**Rationale:**
- The phase machine is unchanged in shape — same three phases, same guards, same actions in the same order — so the resumability guarantee is carried by the same code, only its storage moves.
- Carrying the seq removes a search that could find the wrong op and a warning that admitted it could.

**Implications:**
- `record_complete` keeps `join` on the payload (it only sets `after`), so the finished record still shows the phase it ended at.
- A `record_join_progress` failure is a hard error (as `write_join_journal`'s was) — a teardown that cannot record its phase must not proceed past it.

#### [P05] Legacy journals fold at the reader, lazily and idempotently (DECIDED) {#p05-legacy-fold}

**Decision:** `oplog::fold_legacy_join_journal(repo, name) -> Result<Option<u64>, String>` reads `project_state_dir(repo)/join-journal-<sanitize_branch_name(name)>.json` if it exists, parses it into a private `LegacyJoinJournal { name, base_branch, strategy, commit_hash, phase: JoinPhase, #[serde(default)] message }`, then: if `newest_incomplete(repo, name, OpVerb::Join)` finds an op, attaches the progress to it; otherwise records one — `record_begin(repo, OpVerb::Join, name, before, &tips_of(&before))` — and attaches the progress to that. Only after `record_join_progress` succeeds is the file removed.

`before` is `capture_before(repo, name)` **with `base_branch` overwritten by the journal's**, and the `undo_in`-shaped minimal `OpBefore` only as an `unwrap_or`. Both details matter and neither is guesswork:

- `capture_before` does **not** fail when the branch is already gone (phase `BranchDeleted`). `dash_base` falls back to `detect_default_branch` when `branch.tugdash/<name>.tugbase` is absent, and the two `rev-parse` reads are `unwrap_or_default()`. So it returns `Ok` with an empty `dash_tip` and a `base_branch` that is a **guess**. The journal recorded the real one, so the journal wins.
- `tips_of` drops empty strings, so a `BranchDeleted` fold records a keepalive parented on the base tip alone. That is honest: at that phase the dash branch is already deleted and its commits are only reachable through what the *original* join's keepalive held, which this fold cannot reconstruct. The record exists so `--continue` can finish and `undo` can then refuse or reverse against real values — not to retroactively rescue commits. It is called first thing inside `oplog::join_in_flight`, so every reader migrates, and also at the top of `join_in_with_progress` beside `migrate_worktrees`, where a parse error becomes a returned `Err("legacy-join-journal-unreadable: <path>: <serde error>")` rather than a silent `None`.

**Rationale:**
- The precedent is `migrate_worktrees(&repo_root, &mut warnings)`: migration at the verb's entry, idempotent, no upgrade command. A one-shot migration would need something to run it; the reader already runs.
- A journal without an incomplete op is possible in two ways — the op was pruned, or the join predates the op log — and both want the same answer: a record that `--continue` can finish and `undo` can then reverse.
- Deleting only after the payload write succeeds is what makes a crash inside the fold re-enterable.

**Implications:**
- `sanitize_branch_name` is **not** in `crate::ops` — it is `tugutil_core::sanitize_branch_name` (defined in `tugutil-core/src/worktree.rs`, re-exported at the crate root; `ops.rs` imports it that way at its `use tugutil_core::{Config, find_repo_root, sanitize_branch_name};` line). `oplog.rs` adds the same import beside its existing `use tugutil_core::paths::project_state_dir;`.
- `join_in_flight` swallows only the *absent* case; an unreadable journal makes it return `None`, and the verb path names it. The file is never deleted on a parse error.
- The fold's tests write a legacy-shaped JSON by hand — that is the one place the old format is still spelled, and it is spelled as the artifact being retired.

#### [P06] Undo's incomplete-op refusal and the abandon path are preserved unchanged (DECIDED) {#p06-undo-and-abandon-unchanged}

**Decision:** No edit to `OpPayload::is_undoable`, `undo_in`'s `incomplete-op` refusal, `redo_in`, or `oplog::abandon`. An op mid-teardown has `after == None`, so it is refused as `incomplete-op` until `--continue` completes it; `abandon` deletes the ref and the payload, and the progress goes with the payload.

**Rationale:**
- The plan's charter names these as invariants. They already hold over the payload; the fold adds a field, not a state.

**Implications:**
- Step 3 pins both with tests over the folded shape: an interrupted join seeded through the op log is refused by `undo_in` with `incomplete-op`; `abandon` on it leaves neither `refs/tug/oplog/<seq>` nor `oplog-<seq>.json`.

#### [P07] The test bar is the existing coverage rerun, plus a real SIGKILL at each phase boundary from a PATH git shim (DECIDED) {#p07-kill-tests}

**Decision:** In `tugutil/tests/dash_binding_cli.rs`, a shell script `git` placed first on `PATH` for the *first* `tugutil dash join` spawn forwards every call to the real git (absolute path passed in `SHIM_REAL_GIT`) except the one it is told to pause on (`SHIM_PAUSE_ON`), where it first touches `SHIM_PAUSED` and then blocks until `SHIM_GATE` exists. The test waits for `SHIM_PAUSED`, SIGKILLs the `tugutil` child, creates `SHIM_GATE` so the shim exits, asserts the on-disk state, then runs `tugutil dash join <name> --continue` with the plain `PATH`. Three boundaries, three tests:

| Boundary | Pause on | State asserted before `--continue` |
|---|---|---|
| after `Integrated` written | `worktree remove` | op incomplete, `join.phase == Integrated`, worktree present, branch present, base HEAD == `join.commit_hash` |
| after `WorktreeRemoved` written | `branch -D` | `join.phase == WorktreeRemoved`, worktree gone, branch present |
| after `BranchDeleted` written | the first `rev-parse --short` **after** the shim has seen `branch -D` (the shim touches `SHIM_SEEN_BRANCH_D` when it forwards that call) | `join.phase == BranchDeleted`, branch gone, no dash-log `joined` line yet |

After `--continue`, each asserts: worktree gone, branch gone, dash-log carries `joined`, the op has `after`, no `join-journal-*.json` anywhere under the state dir, and `tugutil dash undo <name>` succeeds.

**Rationale:**
- A state-space test (seed phase N by hand, run `--continue`) proves the machine re-enters; a kill test proves the *write ordering* under a real crash, which is the property the journal was trusted for. Both are wanted and only the second needs a process.
- The occupancy-lease run already proved the gate-file idiom against the real binary (`a_resolve_in_flight_leases_its_chain`); it is deterministic, needs no sleeps, and leaves product code with no `TUG_CRASH_AT` hook.
- `rev-parse --short` is called earlier in a join (`commit_worktree_dirt` runs `rev-parse --short HEAD` in the worktree), so the third boundary is keyed on order rather than on the first match.

**Implications:**
- The shim must `exec "$SHIM_REAL_GIT" "$@"` for every non-matching call so exit codes and output are the real git's.
- The tests run the CLI in a temp repo with `TUG_DATA_DIR` redirected (`tug()` helper) and need no `#[serial]`: each has its own repo and state dir. `refuse_unredirected_temp_repo` is a debug-only assert and `tug()` already sets `TUG_DATA_DIR`, so it stays quiet.
- **The spawn works because `dash_binding_cli.rs` uses `assert_cmd::cargo::CommandCargoExt`, which extends `std::process::Command`** — `tug()` returns a `std::process::Command`, so `.spawn()`, `child.kill()`, and `child.wait()` are all available. Do not reach for `assert_cmd::Command`; that wrapper has no `spawn`. Every test must also `.current_dir(&root)`: `join_in_with_progress` refuses a join launched from inside the dash worktree and requires the base branch checked out.
- The fixture is the file's existing `repo_with_dash(&root, name)`, which inits the repo, adds `.tugtool/config.toml`, creates `tugdash/<name>` with one round via `git worktree add`, and writes the `tugbase`/`tugid` config. The `--break-lease` tests already in this file are the working precedent for driving `dash join` end to end.
- `remove_dash_worktree` calls `reap_dash_tmux` (no git) and then retries `worktree remove` up to five times before a final `worktree prune`, so boundary 1's pause lands on the first `worktree remove` and the retry loop never runs.

#### [P09] The in-flight read spawns no subprocess: payload files, newest first, full predicate (DECIDED) {#p09-cheap-read}

**Decision:** `join_in_flight` must **not** call `list_ops`. `list_ops` begins with `ref_seqs`, which is `git_stdout(repo, ["for-each-ref", …])` — a process spawn — and then parses every payload in the directory. Instead `oplog` gains

```rust
/// Payload sequence numbers, newest first, from the state directory alone.
fn payload_seqs_desc(repo: &Path) -> Vec<u64>
```

— one `read_dir` over `project_state_dir`, `oplog-<seq>.json` filenames parsed, sorted descending — and `join_in_flight` walks it, `read_op`-ing one payload at a time and returning the **first** that satisfies the whole predicate (`dash == name && verb == Join && after.is_none() && join.is_some()`). It stops at that first match and never at "the first op belonging to this dash", because an Undo can sit above an in-flight join (#assumptions).

**Rationale:**
- `join_blockers_from_detail` is on the join board's **explicitly uncached** path — `join_board.rs`'s module doc names blockers as never cached precisely because they answer to dirt, to the checked-out branch, and to the journal, "none of [which] move a SHA". It runs per dash, per recompute, and `base_motion.rs` reads the same fact per dash per tick. Today that costs one failed `open()`; routing it through `list_ops` would put a `git` spawn (~ms) on it per dash per tick, which is the cost unit that actually matters here.
- Reads of ≤50 small JSON files out of page cache are microseconds and are noise beside the git subprocesses `join_state_for` already runs (`candidate_status`); a *new* subprocess is not.
- The ref half of a record answers "may this work still be collected"; in-flight-ness is a property of the payload alone, so consulting the refs was never needed for this question.

**Implications:**
- `list_ops` keeps `ref_seqs` and its ref/payload union — `dash undo --list` and `newest_undoable` still need to know which records still have a keepalive. Only the in-flight read takes the cheap path.
- `payload_seqs_desc` is the natural body for `list_ops`'s existing directory scan to share; refactoring `list_ops` onto it is optional and not required by this plan.

#### [P08] Doctrine names the consolidation once the code does (DECIDED) {#p08-doctrine}

**Decision:** `tuglaws/dash-lifecycle.md` changes in place: the `joining` stage row reads *an incomplete join op — an interrupted teardown*; the derive-vs-declare paragraph says the op is what git-adjacent state the stage derives from; the op-log section's payload bullet drops "beside the join journal", and the retention line drops "the same discipline the join journal uses"; a short paragraph under the op-log heading states that a join's resume state is the op's `join` progress and that a join which lands nothing records nothing. `tuglaws/design-decisions.md` gains **D161**, one paragraph in the house style, citing [D138], [D157], [D160], [L23].

**Rationale:**
- The lifecycle doc currently teaches two artifacts; after the fold it would teach one that no longer exists.

**Implications:**
- The oplog module doc (`//!` at the top of `oplog.rs`) is edited in Step 1 with the code; the tuglaws edits are Step 5.

---

### Deep Dives {#deep-dives}

#### The join's life as one record {#one-record-lifecycle}

```
refuse (off-base, base-dirt, live-resolve, stale-journal, empty)      — no record
commit_worktree_dirt                                                 — dash's own round
record_begin(Join)  ────────────────────────────────────────────────── op #N, after=None, join=None
integrate_join
   ├─ Conflicted / Err  → abandon(#N)                                — no record            [P03]
   └─ Landed            → record_join_progress(#N, Integrated)       — join in flight       [P01][P02]
remove_dash_worktree    → record_join_progress(#N, WorktreeRemoved)
clear_candidate, workshop::remove, branch -D
                        → record_join_progress(#N, BranchDeleted)
append_dash_log("joined")
record_complete(#N, after)                                           — done; join stays on the payload
```

A crash anywhere between the first `record_join_progress` and `record_complete` leaves op #N incomplete with a phase, which is what `join_in_flight` returns and what `--continue` resumes. A crash between `record_begin` and the first `record_join_progress` leaves op #N incomplete with no phase: not in flight, refused by `undo` as `incomplete-op` exactly as today, and the next join records #N+1 above it. That case is unchanged by this plan and is named here so nobody reads it as a gap.

#### Laws this touches {#laws-cross-check}

- **[L23] — internal operations must never lose, destroy, or cease to apply user-visible state.** The three places this plan could violate it, and what holds each: the legacy fold deletes the journal file *only after* `record_join_progress` returns `Ok` ([P05]); the abandon-on-no-landing runs only on paths that landed nothing, which is why [P03] is its own step with its own tests before the journal is retired; and the phase write moves to `write_atomic` (rename-into-place), which is strictly safer than `write_join_journal`'s plain `std::fs::write`. Honored.
- **[L28] — a control acts on a lifecycle by subscribing to its published state, never by reaching into it.** Today `replay.rs`, `join_board.rs`, `base_motion.rs`, the blockers, and `status_in` each answer "is a join in flight?" by stat-ing a file. After the fold there is one published predicate, `oplog::join_in_flight`, and `ops::join_in_flight` is the bool face of it; no caller reads the storage. Improved by the fold.
- **[L31] — a gesture produces either the act or a visible reason, never silence.** The one new failure mode is an unreadable legacy journal, and [P05] gives it a named `Err` on the verb path rather than a `None` that would let a plain join proceed over a half-torn-down dash. The deleted warning ("No open op-log record … it cannot be undone") is not a loss of voice: [P04] carries the seq, so the case it reported cannot occur. `record_complete` failing at the tail keeps its warning.
- **[D138] — derive what git can see; declare only what it cannot.** Unchanged in kind: a join's teardown phase is not visible to git and has always been declared. The fold moves *where* it is declared, from a private file to the record the other declaration for that operation already lives in. One artifact, same side of the line.

#### Where each phase's write sits today {#phase-write-sites}

In `finish_join_teardown`: the `Integrated` guard removes the worktree then writes `WorktreeRemoved`; the `WorktreeRemoved` guard clears the candidate, removes the workshop, deletes the branch, then writes `BranchDeleted`; the tail appends the dash-log line, clears the journal, and completes the op. The fold keeps each write at its site and replaces `write_join_journal(repo_root, &journal)?` with `record_join_progress(repo_root, op_seq, progress.clone())?`. Nothing moves.

---

### Specification {#specification}

#### S01 — `oplog` additions {#s01-oplog-additions}

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum JoinPhase { Integrated, WorktreeRemoved, BranchDeleted }

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct JoinProgress { pub phase: JoinPhase, pub commit_hash: String, pub strategy: String,
    #[serde(default, skip_serializing_if = "Option::is_none")] pub message: Option<String> }

// on OpPayload
#[serde(default, skip_serializing_if = "Option::is_none")]
pub join: Option<JoinProgress>,

pub fn record_join_progress(repo: &Path, seq: u64, progress: JoinProgress) -> Result<(), String>;
pub fn join_in_flight(repo: &Path, name: &str) -> Option<OpPayload>;   // folds legacy first; no subprocess ([P09])
pub fn fold_legacy_join_journal(repo: &Path, name: &str) -> Result<Option<u64>, String>;
fn payload_seqs_desc(repo: &Path) -> Vec<u64>;                          // read_dir only ([P09])
```

`JoinProgress.strategy` is a `String` built in `ops.rs` from `JoinStrategy::as_str()`, which is private to that module — `oplog` only ever stores and returns the string.

`lib.rs` re-exports `JoinPhase` and `JoinProgress` alongside the other `oplog` types.

#### S02 — `ops` changes {#s02-ops-changes}

- Delete: `enum JoinPhase`, `struct JoinJournal`, `join_journal_path`, `write_join_journal`, `read_join_journal`, `clear_join_journal`.
- `pub fn join_in_flight(repo, name) -> bool { crate::oplog::join_in_flight(&main_repo_root(repo), name).is_some() }`.
- `join_blockers_from_detail`: `read_join_journal(repo_root, name).is_some()` → `crate::oplog::join_in_flight(repo_root, name).is_some()`.
- Detail composition (`let joining = …`) and `status_in` (`join_journal_phase`): same substitution; `status_in` formats `op.join.map(|j| format!("{:?}", j.phase))`.
- `join_in_with_progress`: `--continue` per [P04]; stale-journal execute guard per [P02]; `integrate_join` per [P03]; the two `JoinJournal {..}` constructions become one `JoinProgress {..}` at the single landing site.
- `finish_join_teardown` per [P04].

#### S03 — `tugutil` surface {#s03-tugutil-surface}

- `print_oplog`: for an op with `after == None` and `join == Some(p)`, the state reads `incomplete (teardown at {p.phase:?})`; every other state string unchanged.
- `run_status` (text mode): `Landing interrupted at: <phase>` unchanged.
- `--continue` with nothing to continue: the existing sentence.

#### S04 — Error and warning model {#s04-errors}

| Situation | Today | After |
|---|---|---|
| plain join, teardown incomplete | `Err(stale_journal_detail)` | same |
| `--continue`, nothing incomplete | `No interrupted join to continue for dash '<n>'.` | same |
| teardown cannot find its op | warning `No open op-log record …` | cannot occur (seq in hand) |
| legacy journal unreadable | n/a | `Err("legacy-join-journal-unreadable: <path>: <err>")` from the verb; `join_in_flight` returns `None` |
| conflicted join | incomplete op left | no op |

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit** (`oplog.rs`) | payload round-trip, predicate truth table, fold arms | Step 1 |
| **Integration** (`ops.rs` tests, real temp repos) | the join path end to end, `--continue` from each phase, abandon on every no-landing exit | Steps 2–3 |
| **Process** (`dash_binding_cli.rs`, real `tugutil`) | SIGKILL at each boundary, legacy fold through the binary | Step 4 |
| **Drift Prevention** | grep for the retired symbols; blocker parity test already in `ops.rs` | Step 3 checkpoint |

#### What stays out of tests {#test-non-goals}

- tugdeck — nothing on the wire changes ([P02]); the existing bun tests over `stale-journal` stand as they are.
- tugcast feeds beyond compile — `join_board.rs` and `base_motion.rs` call `join_in_flight` through the same bool; their existing tests (`the_board_hides_the_lease_blocker_while_it_holds_the_dash`, the `join-journal` skip test in `base_motion.rs`) keep passing without edits beyond what Step 3 needs to seed state.
- App-tests — no surface changes; `just app-test-changed` will select nothing new, and that is correct.

---

### Execution Steps {#execution-steps}

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Progress on the payload, the in-flight predicate, and the legacy fold | pending | — |
| #step-2 | One integrate function; a join that lands nothing records nothing | pending | — |
| #step-3 | Teardown and `--continue` over the op; the journal retired | pending | — |
| #step-4 | CLI surface and the kill-mid-teardown tests | pending | — |
| #step-5 | Doctrine: lifecycle doc and D161 | pending | — |
| #step-6 | Integration Checkpoint | pending | — |

---

#### Step 1: Progress on the payload, the in-flight predicate, and the legacy fold {#step-1}

**Commit:** `tugdash(join-journal-fold): carry join progress on the op payload`

**References:** [P01], [P02], [P05], [P06], Spec S01, (#one-record-lifecycle)

**Artifacts:**
- `tugrust/crates/tugdash-core/src/oplog.rs`: `JoinPhase`, `JoinProgress`, `OpPayload.join`, `record_join_progress`, `join_in_flight`, `fold_legacy_join_journal`, module doc edited.
- `tugrust/crates/tugdash-core/src/lib.rs`: re-exports.

**Tasks:**
- [ ] Add `JoinPhase` and `JoinProgress` to `oplog.rs` per S01; add `join` to `OpPayload` and `join: None` at every construction site (`record_begin`, the `before()`-based fixtures in the tests module).
- [ ] Add `record_join_progress` (read → set → `write_payload`).
- [ ] Add `payload_seqs_desc` and `join_in_flight` per [P02] and [P09]: call `fold_legacy_join_journal` first (ignore its `Err` here — the verb path reports it), then walk `payload_seqs_desc(repo)`, `read_op` one at a time, and return the first satisfying `op.dash == name && op.verb == OpVerb::Join && op.after.is_none() && op.join.is_some()`. No `list_ops`, no `ref_seqs`, no subprocess.
- [ ] Add `fold_legacy_join_journal` per [P05], with a private `LegacyJoinJournal` serde struct; add `use tugutil_core::sanitize_branch_name;`.
- [ ] Edit the module doc: the payload bullet no longer says "beside the join journal"; the retention paragraph no longer cites the journal's discipline; add one sentence that a join's forward state is the payload's `join` progress.
- [ ] Widen the `pub use oplog::{…}` line in `lib.rs` with `JoinPhase, JoinProgress`.

**Tests:**
- [ ] `a_payload_with_join_progress_round_trips` — serialize/deserialize with every phase.
- [ ] `an_old_payload_without_the_join_field_still_parses` — the JSON literal shape used by `an_old_payload_without_the_conflict_field_still_parses`.
- [ ] `join_in_flight_needs_both_an_open_op_and_progress` — incomplete op with no progress → `None`; with progress → `Some`; after `record_complete` → `None`; a Discard op with (impossible but cheap) progress → `None`.
- [ ] `an_undo_recorded_above_an_in_flight_join_does_not_hide_it` — record a join with progress, then `record_begin(OpVerb::Undo, same dash)` and complete it; `join_in_flight` still returns the join. Pins the scan against the short-circuit [P09] rejects and the assumption (#assumptions) corrects.
- [ ] `the_in_flight_read_touches_no_refs` — delete every `refs/tug/oplog/*` ref with `update-ref -d`, leaving the payloads, and assert `join_in_flight` still finds the join. A ref-dependent implementation fails this; it is the executable form of "no `for-each-ref`".
- [ ] `an_open_join_with_progress_is_refused_by_undo_as_incomplete` and `abandon_drops_the_progress_with_the_payload` — pins [P06].
- [ ] `a_legacy_journal_attaches_to_the_open_op_and_is_deleted`, `a_legacy_journal_with_no_open_op_records_one`, `an_unreadable_legacy_journal_is_left_in_place_and_named` — hand-written legacy JSON in the redirected state dir.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugdash-core oplog` green; `cargo build -p tugdash-core` clean under `-D warnings`.

---

#### Step 2: One integrate function; a join that lands nothing records nothing {#step-2}

**Depends on:** #step-1

**Commit:** `tugdash(join-journal-fold): abandon the op when a join lands nothing`

**References:** [P03], Spec S02, S04, (#one-record-lifecycle)

**Artifacts:**
- `tugrust/crates/tugdash-core/src/ops.rs`: `enum Integration`, `fn integrate_join`, the call site in `join_in_with_progress`.

**Tasks:**
- [ ] Extract the resolved-candidate arm (`if let Some(candidate) = opts.candidate.clone() { … }`) and the `match opts.strategy { Squash | Merge | Rebase }` into `integrate_join` returning `Result<Integration, String>`; the `conflict_outcome` closure's inputs move to the caller. The `integrate_message` call and the rebase-arm `message` read (`log -1 --format=%B`) stay inside, returned in `Landed.message`.
- [ ] At the call site: `Err` and `Conflicted` both `crate::oplog::abandon(&repo_root, op_seq)` before returning; `Landed` proceeds to the journal write (still the journal in this step) and the teardown.
- [ ] Keep `on_beat("squash", "start")` before and `on_beat("squash", "done")` after, as today.

**Tests:**
- [ ] `a_conflicted_join_records_no_op` — squash conflict; `list_ops` unchanged in length; `undo_in(repo, Some(name))` says `nothing-to-undo`, not `incomplete-op`.
- [ ] `a_stale_candidate_refusal_records_no_op` — candidate behind a moved base; same assertions.
- [ ] Existing join/undo/redo tests in `ops.rs` unchanged.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugdash-core` green.

---

#### Step 3: Teardown and `--continue` over the op; the journal retired {#step-3}

**Depends on:** #step-2

**Commit:** `tugdash(join-journal-fold): resume a join from its op; retire the journal`

**References:** [P02], [P04], [P05], [P06], Spec S02, (#phase-write-sites)

**Artifacts:**
- `tugrust/crates/tugdash-core/src/ops.rs`: `finish_join_teardown`, `join_in_with_progress`, `join_in_flight`, `join_blockers_from_detail`, detail composition, `status_in`; `JoinJournal` and its file functions deleted; tests reseeded.
- `tugrust/crates/tugcast/src/feeds/join_board.rs`, `base_motion.rs`: comments only.

**Tasks:**
- [ ] `finish_join_teardown` signature per [P04]; each `write_join_journal` becomes `record_join_progress`; the tail completes by `op_seq` and drops the `newest_incomplete` block and its "No open op-log record" warning. A `record_complete` failure keeps pushing its existing warning ([L31] — the tail still speaks when it fails). The outcome's `base_branch` comes from the op's `before`.
- [ ] `join_in_with_progress`: `--continue` reads `oplog::join_in_flight`; call `fold_legacy_join_journal` beside `migrate_worktrees` and return its `Err` as the verb's; the execute-path stale guard uses `oplog::join_in_flight(...).is_some()`; the single landing site builds a `JoinProgress { phase: Integrated, .. }` and calls `record_join_progress` where `write_join_journal` was.
- [ ] Replace every `read_join_journal(...)` read (blockers, `joining`, `status_in`) per S02; `ops::join_in_flight` delegates.
- [ ] Delete `JoinPhase`, `JoinJournal`, `join_journal_path`, `write_join_journal`, `read_join_journal`, `clear_join_journal`.
- [ ] Add a tests-module helper `seed_interrupted_join(repo, name, phase, commit_hash) -> u64` that calls `capture_before` + `record_begin` + `record_join_progress` — the real code path, never a hand-written payload — and reseed `test_join_continue_resumes_teardown`, `test_dash_status_reports_each_stage`, `preview_reports_a_stale_journal`, `a_live_join_is_not_a_stale_journal`, `preflight_and_the_execute_path_agree`, and `composed_blockers_match_the_preflight_for_every_kind` with it; where a test asserted `read_join_journal(...).is_none()` it now asserts `oplog::join_in_flight(...).is_none()` and that the op has `after`.
- [ ] Reword the comments at `join_board.rs` (the sweep's "journaled teardown" paragraph and the `held` paragraph) and `base_motion.rs` (`DashReading.join_journal` doc) to describe the incomplete op; identifiers unchanged.

**Tests:**
- [ ] `continue_resumes_from_each_phase` — seed `Integrated`, `WorktreeRemoved`, `BranchDeleted` in turn (with the matching git state produced by hand as `test_join_continue_resumes_teardown` does), run `--continue`, assert the same end state each time and that the op completed with `landed_commit`.
- [ ] `continue_twice_is_a_named_refusal` — second `--continue` returns the "No interrupted join" sentence.
- [ ] `a_finished_join_keeps_its_progress_on_the_record` — after a clean join, `read_op(seq).join.unwrap().phase == BranchDeleted` and `after.is_some()`.
- [ ] `undo_refuses_a_join_mid_teardown_then_reverses_it_once_continued` — `incomplete-op` first, success after `--continue`.
- [ ] All reseeded tests above, assertions intact.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugdash-core -p tugcast` green.
- [ ] `grep -rn "JoinJournal\|join_journal_path\|write_join_journal\|read_join_journal\|clear_join_journal" tugrust/crates` prints nothing.

---

#### Step 4: CLI surface and the kill-mid-teardown tests {#step-4}

**Depends on:** #step-3

**Commit:** `tugdash(join-journal-fold): kill a join at every phase boundary and resume it`

**References:** [P07], Spec S03, S04

**Artifacts:**
- `tugrust/crates/tugutil/src/dash.rs`: `print_oplog`.
- `tugrust/crates/tugutil/tests/dash_binding_cli.rs`: the shim, three kill tests, one legacy-fold test.

**Tasks:**
- [ ] `print_oplog`: the `(None, _)` arm reads `incomplete (teardown at {:?})` when `op.join` is `Some`, else `incomplete`.
- [ ] Write the shim as a `&str` in the test file, materialized into `<tmp>/shim/git` with mode `0o755`: `case "$*" in *"$SHIM_PAUSE_ON"*) touch "$SHIM_PAUSED"; while [ ! -f "$SHIM_GATE" ]; do sleep 0.05; done;; esac` guarded by the `SHIM_SEEN_BRANCH_D` ordering rule for the third boundary, then `exec "$SHIM_REAL_GIT" "$@"`. Resolve `SHIM_REAL_GIT` with `which git` at test start.
- [ ] Helper `kill_join_at(pause_on: &str) -> (tmp, name)`: `repo_with_dash`, spawn `tug(&tmp).args(["dash","join",&name])` with `PATH=<shim dir>:<PATH>` and the `SHIM_*` env, poll for `SHIM_PAUSED` (bounded loop, no fixed sleep), `child.kill()`, create `SHIM_GATE`, `child.wait()`.
- [ ] Three tests per the [P07] table, each ending with a plain-`PATH` `--continue` and a `tugutil dash undo <name>` that exits 0.
- [ ] `a_legacy_journal_on_disk_is_folded_and_continued_by_the_binary`: write a legacy-shaped `join-journal-<name>.json` into `<tmp>/state/projects/<slug>/` with the integrate done by hand (as `test_join_continue_resumes_teardown` does), run `tugutil dash join <name> --continue`, assert the file is gone, the join finished, and `undo --list --json` shows the op with `join.phase == "BranchDeleted"`.

**Tests:**
- [ ] The four tests above, against the real `tugutil` binary.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugutil` green.

---

#### Step 5: Doctrine: lifecycle doc and D161 {#step-5}

**Depends on:** #step-3

**Commit:** `tugdash(join-journal-fold): doctrine — one record per join`

**References:** [P08], [P03], (#one-record-lifecycle)

**Artifacts:**
- `tuglaws/dash-lifecycle.md`, `tuglaws/design-decisions.md`.

**Tasks:**
- [ ] `dash-lifecycle.md`: the `joining` row; the derive-vs-declare paragraph's "the journal" → "an incomplete join op"; the payload bullet and the retention sentence under *The operation log, and undoing*; one new paragraph there stating the fold and the dropped-transaction rule. Prose unbroken on each line.
- [ ] `design-decisions.md`: append **D161** in the house form — bold thesis, the seam it closes (two records that could disagree; the phantom op after a conflicted join), the shape (`join` on the payload, `--continue` from the incomplete op, abandon on no-landing, read-time fold), what stays (wire vocabulary; undo's refusal; abandon), the jj model, then the plan's `[P01]`–`[P08]`, the files, and `[D138], [D157], [D160], [L23]`.

**Tests:**
- [ ] None — prose. `grep -n "journal" tuglaws/dash-lifecycle.md` afterwards should match only the `stale-journal` blocker name in the occupancy section.

**Checkpoint:**
- [ ] The grep above; `tugutil plan lint dash/dash-join-journal-fold.md` still exits 0 on the worktree copy.

---

#### Step 6: Integration Checkpoint {#step-6}

**Depends on:** #step-4, #step-5

**Commit:** `tugdash(join-journal-fold): integration checkpoint`

**References:** [P04], [P07], (#success-criteria)

**Tasks:**
- [ ] `tugutil dash replay join-journal-fold` — put the rounds on the live base, so what gets verified is what would land.
- [ ] `Replayed` / `Recorded`: verify the replayed tree with the project's declared verify command (`tugutil dash config --json`), substituting `{base}`/`{head}` with the replayed range; with no declaration, the plan's own checkpoint commands over what the replay moved, said plainly.
- [ ] `Current`: the base never moved, so the last step's checkpoint already verified these exact bytes — re-run nothing and say so.
- [ ] `Conflicted`: resolve the named round in the worktree, then verify as above.

**Tests:**
- [ ] None of its own. This step re-proves nothing the steps proved; it establishes that their work still holds on the base as it stands now.

**Checkpoint:**
- [ ] The replay reports its outcome, and the scoped verification is green **or** was correctly skipped as `Current`.

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** A join's interrupt/resume state lives on its op-log record — `--continue` resumes from the incomplete op, a join that lands nothing records nothing, the journal file format is gone with a read-time fold for stragglers — with the wire, the landing doctrine, and undo's refusals unchanged.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] No `join-journal-*.json` is written by any path and none of the journal symbols remain (grep, Step 3).
- [ ] `--continue` resumes from each phase, and a real SIGKILL at each boundary is recovered by the real binary (Rust tests Step 3; CLI tests Step 4).
- [ ] A conflicted or refused integrate leaves no op (Rust tests, Step 2).
- [ ] A legacy journal at upgrade is folded and completed (Rust test Step 1; CLI test Step 4).
- [ ] `undo` refuses mid-teardown by name and `abandon` drops both halves (Rust tests, Steps 1 and 3).
- [ ] Doctrine reads the consolidated shape (prose, Step 5).

**Acceptance tests:**
- [ ] `cargo nextest run -p tugdash-core -p tugcast -p tugutil` (per-step checkpoints, Steps 1–4).
- [ ] The three kill tests and the legacy-fold CLI test (Step 4).

#### Follow-ons (Explicitly Not Required for Phase Close) {#follow-ons}

- A `tugutil dash join --abandon` that drops a mid-teardown op explicitly — not asked for; `--continue` is the recovery today and after.
- Renaming the wire vocabulary to op-log terms, if the owner ever wants it; recorded as declined 2026-08-24 in [P02].
