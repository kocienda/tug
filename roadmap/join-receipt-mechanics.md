## Join Receipt Mechanics {#join-receipt-mechanics}

**Purpose:** A join is a commit on the base, so its transcript receipt rides the same Git Commit presentation as a `/commit` — sha pill, subject, per-file rows with expandable diffs — instead of the thinner bespoke block it wears today. Alongside that, three run-ending mechanics found in the same audit get fixed: the `index.lock` race between the join arc's preflight sweep and a live `tugutil dash commit`, the sweep commit standing in the dash's round list and round count as if it were authored work, and `tugutil dash replay`'s exit code disagreeing with its own JSON on a deferral.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | kocienda |
| Status | draft |
| Target branch | tugdash/join-receipt-mechanics |
| Last updated | 2026-08-22 |

---

### Review Record {#review-record}

**Round 1 — 2026-08-22, opus.** Reviewed `plan:b5560d1b81dcb241`. Lint: 0 errors, 1 warning (fixed — this section).
Oriented on: the whole document (first review, `rounds: 0`).
Applied: the largest finding was that [P02]'s mechanism was wrong for two of the three join strategies. It proposed `git show --numstat <landing sha>`, but `commit_hash` is `git rev-parse HEAD` after the integrate for *all* strategies (the three `JoinStrategy` arms in `ops.rs`) — so on `Merge` the landing sha is a merge commit, whose diff git suppresses by default, and on `Rebase` it is the tip of a replayed chain, meaning the receipt would have shown only the **last round's** files as though they were the join's. A silently partial file list in a durable record is worse than an absent one. Rewrote [P02] around `git diff-tree --root`, which is the *same spelling the row expansion already uses* (`git-diff-store.ts` documents its `commit` flavor as "one commit against its first parent (`git diff-tree --root`)"), and gated the `files:` line on `outcome.strategy == "squash"` so the list and the rows it expands into can never describe different objects; the other two strategies degrade to the legacy shape [P03] already renders. Added Spec S04 and Risk R02 to record why. Second: asked about the sweep commit, which the brief flagged as standing in the ROUNDS list as a peer of real rounds — the plan had only re-voiced its subject, leaving `rounds` (`rev-list --count base..branch`) counting a machine commit as authored work, a number this very phase's receipt prints. The user chose to mark and filter it, so [P07], Spec S03, and #step-4 are new, and the fix reaches all three round-derivation sites (`dash_detail_entries_in`, `status_in`, `show_in`), which also makes the receipt's round count true for free. Third: the replay step's original test proposed comparing `std::process::ExitCode` values — it implements neither `PartialEq` nor a stable `Debug` (probed: `ExitCode(unix_exit_status(0))`, a platform internal), so the extraction now returns `u8` and the test pins that. Also: split the old #step-3 in two, because surviving contention and deciding what the resulting commit *is* are separate concerns with separate tests; named the `join-mode-controller.ts` comment that quotes the old sweep subject as deliberately unchanged (it narrates a past incident, so re-voicing it would falsify the history); recorded the tuglaws cross-check — [L19]/[L20] honored by composing the commit presentation's components rather than reaching inside their slots, [L02]/[L06]/[L24] not implicated because the block adds no state at all, [L29] honored because the receipt passes the ledger-persisted `cwd` through verbatim and canonicalizes nothing, [L31] cited by [P05] since a yielding sweep must still produce the act rather than a silent failure.
Deferred: nothing — no question was raised and left unanswered.

---

### Phase Overview {#phase-overview}

#### Context {#context}

Today the two landing receipts are siblings that drifted. `format_commit_summary` (`tugrust/crates/tugcast/src/feeds/changeset.rs`) writes a three-part durable string — machine header, a `files:` JSON line carrying per-file stats, then the verbatim message — and `SessionCommitReceiptBlock` (`tugdeck/src/components/tugways/cards/session-commit-receipt-block.tsx`) parses it into the full commit presentation: `CommitShaText` atom + subject in the header, file-count and ± diff badges, the message body, and a `CommitChangesList` whose rows expand into the committed hunks. `format_join_summary` writes only a header and the message — no `files:` line — and `SessionJoinReceiptBlock` (`tugdeck/src/components/tugways/cards/session-join-receipt-block.tsx`) renders a thinner block: sha, `dash → base`, round count, message. The join lands a real commit on the base and its receipt should read like one; the reader should not meet a second, poorer skeleton for the same kind of fact. That block's own comment already concedes the point — "a join IS a commit on the base, and the reader should not have to learn a second skeleton for it" — but it stopped at the sha.

The same audit surfaced three mechanics at the run's ending, all of them about the join's preflight sweep and the verb that replays a dash.

**The arming race.** Closing a run's final declared step arms the join arc, and the arc's preflight (`commit_worktree_dirt` in `tugrust/crates/tugdash-core/src/ops.rs`, reached from both `join_in` and the resolution ladder's preamble in `resolve.rs`) runs `git add -A` + `git commit` in the dash worktree. A live `tugutil dash commit` (`ops::commit`) does the same thing in the same worktree at the same moment — the ledger write that closes the step is exactly what both want to commit — and whichever side loses the race dies on `index.lock: File exists`. Either loss is wrong: the preflight dying kills a join the user just accepted, and the dash commit dying kills the round that closes the run.

**The sweep stands as a round.** That sweep commit, subject `join: commit outstanding changes`, lands on the dash branch — so `git log --format=%s base..branch` lists it in the shade's ROUNDS section (`round_subjects` in `dash_detail_entries_in`) and `rev-list --count base..branch` counts it in `rounds`. It is machine plumbing wearing neither the round voice nor a marker saying it is not a round, and the count it inflates is printed by the very receipt this phase is unifying.

**The replay deferral's two verdicts.** `tugutil dash replay` on a deferral (`run_replay` in `tugrust/crates/tugutil/src/dash.rs`) prints JSON saying `status: ok` with `outcome: deferred` — and exits 1. One command, two answers to "did anything go wrong?".

#### Strategy {#strategy}

- Extend the S01 join summary format additively: the `files:` line slots in at line 1, exactly where the commit summary carries it. Old receipts (no `files:` line) keep parsing forever — the discard block's historical-header pattern is the precedent.
- Compute the receipt's file stats with the **same git spelling the row expansion uses**, so the list and the rows it expands into cannot describe different objects ([P02], Spec S04).
- Rust first (the format is the contract, formatted once server-side), then the deck (parse and present), so the deck step can copy its test literals from the updated Rust assertions — the existing pinning discipline between `format_join_summary_names_the_dash_the_base_and_the_rounds` and `session-join-receipt-block.test.ts`.
- The deck join receipt delegates to the commit presentation's components (`CommitShaText`, `CommitMessage`, `CommitChangesList`) rather than growing a parallel implementation; `SessionJoinReceiptBlock` thins to parse-and-present, and the discard block beside it is untouched.
- The three mechanics fixes are independent of the receipt; each is its own step. The sweep's identity ([P07]) is deliberately separate from the retry ([P05]) even though both edit `commit_worktree_dirt` — one is about surviving contention, the other about what the resulting commit *is*.
- Live/replay byte-parity is free by construction and stays that way: every display fact parses from the one server-formatted summary string, which is the same bytes in the live `_ok` frame and in the shell-ledger row a restore replays.

#### Success Criteria (Measurable) {#success-criteria}

- A squash-strategy join's transcript receipt shows the sha pill, the squash subject, per-file rows with counts, and expandable per-file diffs — verified by `tests/app-test/at0419-join-receipt.test.ts` against the exact bytes the updated Rust formatter test asserts.
- A pre-existing join receipt (JSONL written before this phase) still parses and renders as a receipt, not a raw shell row — pinned by a unit test feeding `parseJoinReceipt` the old-format literal.
- `commit_worktree_dirt` and `ops::commit` both survive a transient `index.lock` — pinned by unit tests that hold the lock and release it mid-call.
- A dash whose worktree was swept at join time reports the same `rounds` and the same `round_subjects` as it did before the sweep — pinned by a test that sweeps a dash with N rounds and asserts the count stays N.
- `tugutil dash replay` on a deferral exits 0; the exit mapping is pinned by a unit test over all five `ReplayOutcome` variants.

#### Scope {#scope}

1. `format_join_summary` gains a `files:` line, computed from the landing commit against its first parent, for squash-strategy joins.
2. `SessionJoinReceiptBlock` renders through the commit presentation; `parseJoinReceipt` learns the optional `files:` line.
3. `index.lock` retry in `commit_worktree_dirt` and `ops::commit`.
4. The sweep commit wears the round voice, carries a `Tug-Sweep` trailer, and is excluded from every round count and round list.
5. `dash replay` deferral exits 0.

#### Non-goals (Explicitly out of scope) {#non-goals}

- The discard receipt (`SessionDiscardReceiptBlock`) — a discard lands no commit, so the bespoke shape is correct for it and it stays.
- Per-file rows for `Merge` and `Rebase` strategy joins — the diff fetch is first-parent-shaped end to end (`git-diff-store.ts`'s `commit` flavor), so those receipts keep the legacy shape rather than showing a partial list ([P02], Risk R02). Making the expandable diff range-aware is a larger change to the diff route and belongs to its own plan.
- The join register / narration surfaces — closed by `roadmap/join-narration.md`; the register's mount question is `roadmap/join-offer-route.md`'s subject.
- Unifying `record_landing_receipt` callers beyond what the receipt change forces — the ledger write path is shared already.
- Rewriting sweep commits that already exist. A pre-existing sweep carries no trailer and keeps counting as a round ([P07]); history is not edited to make a count prettier.
- `ReplayOutcome::Conflicted`'s exit code — a conflict stops mid-application and the dash cannot move until a person resolves the named round, so the non-zero exit is a script's cheap signal that work is required. Only the deferral's code is wrong.

#### Dependencies / Prerequisites {#dependencies}

- `tugchanges_core::file_stats` (`tugrust/crates/tugchanges-core/src/git.rs`) — joins `--numstat` and `--name-status` output into `Vec<FileStat>`; already public, already a tugcast dependency (`format_commit_summary` takes its `FileStat`).
- `tugchanges_core::append_trailers` — already used by `with_dash_trailers` (`ops.rs`) to attach `Tug-Session:` / `Tug-Dash:`; the sweep marker rides the same helper.
- `CommitChangesList` (exported from `tugdeck/src/components/tugways/tug-changes-list.tsx`) takes `{root, sha, files}` and lazily fetches per-row commit-flavor diffs. Its `CommitChangesFile` (`path`/`status`/`added`/`removed`) is structurally identical to `CommitReceiptFile`, so the parsed files pass straight through.

#### Constraints {#constraints}

- WARNINGS ARE ERRORS (`-D warnings` via `tugrust/.cargo/config.toml`).
- Receipts already written in the old S01 format must keep parsing forever — transcripts replay from JSONL on every card reload.
- Live append and JSONL replay must render byte-identically ([D111] discipline): every display fact parses from the summary string itself.
- App-tests are selective: `just app-test tests/app-test/at0419-join-receipt.test.ts`, never a sweep.

#### Assumptions {#assumptions}

- The landing commit exists on the base when the receipt is formatted — the `(Some(sha), false)` arm in `do_changeset_join` is reached only when it does — so a git read against `project_dir` can always resolve it.
- `CommandBlockProps.message.cwd` holds the base repo dir for `/dash-join` rows. Verified: `record_landing_receipt` persists its `cwd` parameter into `NewShellExchange.cwd`, and `do_changeset_join` passes `project_dir` — the same field, from the same writer, that the commit receipt already resolves `CommitChangesList` against.
- The card sends no `strategy`, so real joins are `Squash` (the payload's documented default, and the strategy `ops.rs` calls "the default every route asks for"). `Merge` / `Rebase` reach the code only through an explicit CLI flag.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

None. Every design call in this phase is decided below; the deferral exit-code meaning was decided in the phase's commissioning (deferral is a non-error outcome), and the sweep commit's presentation was asked during review and settled as [P07].

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Landing stats read fails at format time | low | low | omit the `files:` line — the receipt degrades to today's shape, which the parser reads as legacy | a squash join renders with no file list |
| Retry loop masks a genuinely stuck lock | low | low | bounded retry (~1.5s total), then the original error surfaces verbatim | `index.lock` errors persisting past the retry window |
| A script depended on replay's deferral exiting 1 | low | low | audited: no repo script, hook, or justfile recipe branches on the exit code; `dash-implement` and `dash-on` read the printed outcome word | a caller found parsing `$?` after `dash replay` |
| Trailer-based filtering hides a real round | med | low | the trailer is written at exactly one site (the sweep) and read as an exact key match; a round committed by `ops::commit` never carries it | an authored round missing from the shade's ROUNDS list |

**Risk R01: The join receipt's file rows fetch diffs against the wrong root** {#r01-wrong-root}

- **Risk:** `CommitChangesList` resolves per-row diffs at `root`; a wrong cwd on the ledger row would fetch nothing for every expansion.
- **Mitigation:** the row's cwd is `project_dir` — the base checkout the landing commit lives in — written by the same `record_landing_receipt` the commit receipt already trusts; the app-test expands one row and asserts hunk content.
- **Residual risk:** a receipt restored after the repo moved on disk fetches nothing — identical to the commit receipt's existing behavior, not new exposure.

**Risk R02: A non-squash join's file list would be a partial truth** {#r02-non-squash-partial}

- **Risk:** For `JoinStrategy::Merge` the landing sha is a merge commit (git suppresses its diff by default) and for `Rebase` it is the tip of a replayed chain, so a first-parent read returns nothing or only the last round — and a *partial* list is worse than none, because it reads as complete.
- **Mitigation:** [P02] gates the `files:` line on the squash strategy, so those receipts carry no list at all and render in the legacy shape [P03] guarantees.
- **Residual risk:** a CLI user who joins with `--strategy merge` gets a receipt with no file rows. That is honest rather than wrong, and it is named in #non-goals.

---

### Design Decisions {#design-decisions}

#### [P01] The join receipt rides the commit presentation (DECIDED) {#p01-receipt-rides-commit-presentation}

**Decision:** A landed join's receipt renders with the commit receipt's skeleton — `CommitShaText` + squash subject in the header, file-count and ± badges, message body, `CommitChangesList` with expandable per-file diffs — plus one join-only identity line naming `dash → base`.

**Rationale:**
- A join IS a commit on the base; the existing block's own comment already says the reader "should not have to learn a second skeleton for it", but it stopped at the sha.
- The per-file rows are the receipt's value: what the join actually changed on the base, inspectable without leaving the transcript.

**Implications:**
- `SessionJoinReceiptBlock` thins to parse-and-present over shared components; it keeps its module (matchers, parsers, the discard block) rather than retiring, because the command-block registration and the historical parsing live there.
- The `dash → base` identity moves out of the header (the subject takes that seat, commit parity) into one line above the message body.

#### [P02] The `files:` line is the landing commit against its first parent, and squash-only (DECIDED) {#p02-files-first-parent-squash-only}

**Decision:** `format_join_summary` takes `files: &[tugchanges_core::FileStat]`. The `do_changeset_join` success arm computes them with `git diff-tree --root --numstat` and `git diff-tree --root --name-status` against the landing sha at `project_dir`, joined by `tugchanges_core::file_stats` — and only when `outcome.strategy == "squash"`. An empty read, or any other strategy, omits the `files:` line entirely.

**Rationale:**
- `commit_hash` is `git rev-parse HEAD` after the integrate for every strategy, so the landing sha means three different things: a squash commit (the whole join), a merge commit (whose diff git suppresses by default), or a replayed chain's tip (one round). Only the first is the join, so a naive read of the landing sha would have shown a rebase join's *last round* as though it were the join's whole change.
- `git diff-tree --root` is the **same spelling the row expansion already uses** — `git-diff-store.ts` documents its `commit` flavor as "one commit against its first parent (`git diff-tree --root`)". Using it here makes the summary's list and the rows it expands into the same object by construction, rather than by two readings that could drift.
- Omit-on-empty means a failed read degrades to exactly today's receipt shape rather than fabricating "0 files" over a commit that plainly changed files.

**Implications:**
- A `pub(crate) async fn landing_file_stats(dir: &Path, sha: &str) -> Vec<tugchanges_core::FileStat>` lives in `changeset.rs` beside the module-private `git_stdout` it uses; `agent_supervisor.rs` calls it, never git directly.
- The `files:` JSON serialization (the key-ordered `ReceiptFile` struct currently local to `format_commit_summary`) extracts to a shared `receipt_files_line(files: &[FileStat]) -> String` so the two formatters cannot drift.
- Non-squash joins render the legacy receipt (Risk R02, #non-goals).

#### [P03] Old receipts parse forever; the `files:` line is optional (DECIDED) {#p03-historical-parse-forever}

**Decision:** `parseJoinReceipt` treats line 1 as a `files:` line only when it carries the `files: ` prefix — exactly `parseCommitReceipt`'s discipline — so every join receipt already in JSONL parses with `files: []` and renders as a receipt.

**Rationale:**
- Transcripts replay from JSONL on every card reload; a format change that orphaned old rows would turn every recorded join back into a raw shell row. The discard block's `HISTORICAL_DISCARD_HEAD_RE` is the house precedent: read-forever, write-never.
- Because [P02] also omits the line for non-squash joins, "legacy" and "no file list" are the same code path — one degradation to build and test, not two.

**Implications:**
- `parseFilesLine` and `CommitReceiptFile` export from `session-commit-receipt-block.tsx` for the join block to import — one parser for the one line format.
- The S01 header line is unchanged, so the old and new formats differ only in the optional line — no historical regex needed.

#### [P04] The machine sweep commit wears the round voice (DECIDED) {#p04-sweep-wears-round-voice}

**Decision:** `commit_worktree_dirt` gains a `name: &str` parameter and commits with subject `tugdash(<name>): commit outstanding changes`, replacing `join: commit outstanding changes`.

**Rationale:**
- The commit sits on the dash branch among rounds; when anything does surface it — `tug log` on the branch, an archaeology read — it should speak in the same scope-colon voice the engine's own `adopt plan` and `remap round ids` commits already wear.
- Every caller — `join_in` (ops.rs), the resolution ladder preamble (`resolve_ladder` in resolve.rs), and `resolve_conflicts`'s doc contract — already holds the dash name.

**Implications:**
- The voice is presentation; [P07] is what stops the commit being *counted* as a round. Both are needed: the trailer decides what the shade lists, the subject decides how it reads when something lists it anyway.
- The stale comment on `commit_remap` (`replay.rs`) — "its subject is the join's, hardcoded" — updates to say the subject is the round-voiced sweep, keeping the two functions' distinction accurate.
- The comment in `join-mode-controller.ts` that quotes `join: commit outstanding changes` narrates a past incident and is left exactly as written — re-voicing it would falsify the history it records.

#### [P05] Both commit paths retry briefly on index.lock, and yielding is a no-op (DECIDED) {#p05-index-lock-retry}

**Decision:** `commit_worktree_dirt` and `ops::commit` retry `git add` / `git commit` when the failure names `index.lock`, bounded (10 attempts × 150ms sleep, ~1.5s), re-checking `git status --porcelain` between attempts; a worktree that comes back clean returns success with no commit.

**Rationale:**
- The race is symmetric — the arc's preflight and a live `tugutil dash commit` want to commit the same dirt — and either side losing is wrong: the preflight dying kills a join the user just accepted, the dash commit dying kills the round that closes the run.
- Re-checking status is what makes the loser yield gracefully: if the winner already swept the dirt, there is nothing left to commit and nothing to report as an error. A gesture must produce the act or a visible reason ([L31]); here the act is simply already done, so silence is correct rather than a swallowed failure.

**Implications:**
- The re-check means `ops::commit` can return `committed: false` when a concurrent sweep took its changes — already a legal outcome (`has_changes == false` path), so no caller changes.
- Spec S02 pins the retry contract; a shared `index_lock_blocked(stderr) -> bool` predicate keeps the two sites matching the same error.
- Both sites are synchronous (tugdash-core runs under `spawn_blocking`), so the sleep is `std::thread::sleep`.

#### [P06] A replay deferral exits 0 (DECIDED) {#p06-deferral-exits-zero}

**Decision:** `run_replay` maps `ReplayOutcome::Deferred` to exit 0; `Conflicted` keeps exit 1.

**Rationale:**
- A deferral is the command declining to act and saying why — `status: ok` / `outcome: deferred` in its own JSON. Exit 1 beside that is one command giving two verdicts, and the JSON is the truthful one: nothing failed.
- A conflict is different in kind: the replay stopped mid-application and the dash cannot move until a person resolves the named round — the non-zero exit is a script's only cheap signal that work is required.

**Implications:**
- The mapping extracts to `fn replay_exit_status(outcome: &ReplayOutcome) -> u8`, returning `0` / `1`, with `run_replay` wrapping it in `ExitCode::from`. It returns `u8` rather than `ExitCode` because `std::process::ExitCode` implements neither `PartialEq` nor a stable `Debug` (its Debug is the platform internal `ExitCode(unix_exit_status(0))`), so an `ExitCode` return could only be pinned by a brittle string comparison.
- `run_replay`'s docblock rewrites to state the deferral/conflict distinction.

#### [P07] The sweep commit is marked, and marked commits are not rounds (DECIDED) {#p07-sweep-marked-not-a-round}

**Decision:** The sweep commit carries a `Tug-Sweep: 1` trailer, and every derivation of a dash's rounds — `round_subjects` and `rounds` in `dash_detail_entries_in`, `rounds` in `status_in`, and the `RoundItem` list in `show_in` — excludes commits carrying it.

**Rationale:**
- `rounds` is `rev-list --count base..branch`, so a sweep counts as authored work — and this phase's own receipt prints that number as "N round(s)". Unifying the receipt while leaving it counting plumbing would ship a prettier lie.
- Filtering on a durable trailer rather than on the subject string means the exclusion is a fact the commit carries, not a pattern match that a renamed subject or a user's own commit could break. `with_dash_trailers` already establishes trailers as the house mechanism for machine-readable commit metadata, and `tugchanges_core::append_trailers` is the shared writer.
- The count feeds `join_ready(rounds, …)` and `derive_stage`, so a truthful count makes the arc arm on authored work rather than on plumbing.

**Implications:**
- The three sites converge on one helper that reads subject and trailer together in a single `git log` (`--format=%s%x1f%(trailers:key=Tug-Sweep,valueonly)%x1e`), so `rounds` becomes the filtered list's length rather than a separate `rev-list --count` — one git call replaces two in `dash_detail_entries_in`.
- A dash whose only commit is a sweep reports `rounds: 0` and is not join-ready. That is correct: nothing was authored.
- Sweeps written before this phase carry no trailer and keep counting as rounds. They are not rewritten (#non-goals) and they age out as their dashes join or are discarded.

---

### Specification {#specification}

**Spec S01: The join summary format, v2** {#s01-join-summary-v2}

```text
joined <sha[0..10]> · <dash> → <base> · <N> round(s)
files: [{"path":"…","status":"modified","added":16,"removed":1}, …]
<full squash message, trimmed, never truncated>
```

- `·` is U+00B7 and `→` U+2192, matched exactly by the deck (`JOIN_HEAD_RE` unchanged).
- The `files:` line is line 1 when present, serialized by the same key-ordered `receipt_files_line` the commit summary uses (`path`, `status`, `added`, `removed` — declaration order, stable bytes). It is **omitted entirely** for a non-squash join or an empty stats read ([P02]).
- The message begins at line 1 (legacy / no-files) or line 2 (with files); the parser decides by the `files: ` prefix ([P03]).

**Spec S02: The index.lock retry contract** {#s02-index-lock-retry}

- Trigger: a `git add` or `git commit` failure whose stderr contains `index.lock`.
- Loop: up to 10 attempts, 150ms `std::thread::sleep` between attempts (~1.5s ceiling), each attempt re-reading `git status --porcelain` first; a clean tree exits the loop as success without committing.
- Any non-lock failure, or lock persistence past the last attempt, surfaces the original error verbatim — the retry never rewrites or swallows an error message.
- Applies at exactly two sites: `commit_worktree_dirt` (ops.rs) and the stage/commit sequence in `ops::commit`.

**Spec S03: The sweep marker and the round filter** {#s03-sweep-marker-round-filter}

- The sweep commit's message is `tugdash(<name>): commit outstanding changes` with a `Tug-Sweep: 1` trailer, appended via `tugchanges_core::append_trailers`.
- A dash's rounds are read by one helper over `git log --format=%s%x1f%(trailers:key=Tug-Sweep,valueonly)%x1e <base>..<branch>`: a record whose trailer field is non-empty is a sweep and is dropped.
- `round_subjects` is the surviving subjects (newest first, as today); `rounds` is their count. `status_in` and `show_in` read through the same helper.
- The marker is written at exactly one site and read as an exact key match — no subject-string matching anywhere.

**Spec S04: Why the receipt's files are first-parent** {#s04-first-parent-rationale}

- The deck's expandable rows fetch `{kind: "commit", root, sha, paths}`, documented in `git-diff-store.ts` as "one commit against its first parent (`git diff-tree --root`)".
- The summary's `files:` line is therefore computed the same way, so a row can never appear in the list without the fetch behind it describing the same diff.
- `JoinStrategy::Squash` is the only strategy where that object is the whole join; `Merge` and `Rebase` are excluded at the formatter ([P02], Risk R02).

#### State Zone Mapping (tugdeck/tugways plans) {#state-zone-mapping}

The deck change introduces **no new state**: every display fact is a pure parse of `props.message.output` at render time, exactly as both receipt blocks work today, and `CommitChangesList` owns its existing lazy fetch and its own row-expansion `useState`. There is no store read, no effect, and no appearance state moved through React — [L02], [L06], and [L24] are not implicated by anything this plan adds. [L29] is honored by passing `props.message.cwd` through verbatim: the receipt resolves a path the ledger persisted, and never canonicalizes one itself. [L19] and [L20] are honored by composing the commit presentation's components without adding rules that reach inside their slots.

| State | Zone (appearance / local-data / structure) | Mechanism | Law |
|-------|--------------------------------------------|-----------|-----|
| (none added) | — | parsed from the durable summary at render | [L02] not implicated |

---

### Definitive Symbol Inventory {#symbol-inventory}

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `receipt_files_line` | fn | `tugrust/crates/tugcast/src/feeds/changeset.rs` | extracted from `format_commit_summary`; shared serializer for the `files:` line |
| `format_join_summary` | fn | `tugrust/crates/tugcast/src/feeds/changeset.rs` | gains `files: &[tugchanges_core::FileStat]` parameter |
| `landing_file_stats` | async fn | `tugrust/crates/tugcast/src/feeds/changeset.rs` | `git diff-tree --root` numstat + name-status → `file_stats` ([P02]) |
| `do_changeset_join` | fn | `tugrust/crates/tugcast/src/feeds/agent_supervisor.rs` | success arm computes stats for a squash landing before formatting |
| `parseJoinReceipt` / `ParsedJoinReceipt` | fn / interface | `tugdeck/src/components/tugways/cards/session-join-receipt-block.tsx` | gains `files` (`CommitReceiptFile[]`) |
| `parseFilesLine`, `CommitReceiptFile` | fn / interface | `tugdeck/src/components/tugways/cards/session-commit-receipt-block.tsx` | `parseFilesLine` becomes exported; type already exported |
| `SessionJoinReceiptBlock` | component | `tugdeck/src/components/tugways/cards/session-join-receipt-block.tsx` | renders through the commit presentation ([P01]) |
| `index_lock_blocked` | fn | `tugrust/crates/tugdash-core/src/ops.rs` | shared stderr predicate for Spec S02 |
| `commit_worktree_dirt` | fn | `tugrust/crates/tugdash-core/src/ops.rs` | gains `name`, retry loop, round voice, `Tug-Sweep` trailer |
| `ops::commit` | fn | `tugrust/crates/tugdash-core/src/ops.rs` | stage/commit sequence retries on index.lock |
| `dash_round_subjects` | fn | `tugrust/crates/tugdash-core/src/ops.rs` | the one sweep-filtering round reader (Spec S03), used by all three sites |
| `replay_exit_status` | fn | `tugrust/crates/tugutil/src/dash.rs` | extracted exit mapping returning `u8`; `Deferred` → 0 |

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit (Rust)** | formatter bytes, retry behavior, round filtering, exit mapping | Steps 1, 3, 4, 5 |
| **Unit (bun)** | parser round-trips, legacy parse-forever | Step 2 |
| **Contract pinning** | deck test literals copied verbatim from Rust formatter assertions | Steps 1↔2, the existing discipline |
| **App-test** | the receipt's real DOM — presentation, restore parity, per-file expansion | Step 2 (`at0419`) |

#### What stays out of tests {#test-non-goals}

- A real card-driven land in an app-test — `at0419`'s header records why (a join lands on the developer's own `main`); the file drives the deck half against the exact Rust literals, and the end-to-end ledger path is walked by the discard in `at0418-join-outcomes.test.ts`. That division stands.
- A live two-process `index.lock` race — the retry unit tests hold and release the lock deterministically; racing real processes is flake by construction.
- Mock-store or fake-DOM render tests — banned; the block's rendering is covered where it is real, in the app-test.

---

### Execution Steps {#execution-steps}

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | The join summary carries its files | done | `046ef16cf` |
| #step-2 | The join receipt rides the commit presentation | done | `d166dded7` |
| #step-3 | Both commit paths survive index.lock | done | `a5e3faf1e` |
| #step-4 | The sweep is marked, and is not a round | done | `faed76870` |
| #step-5 | A replay deferral exits 0 | done | `fc89c0ebe` |
| #step-6 | Integration checkpoint | done | `04a78fd99` |

#### Step 1: The join summary carries its files {#step-1}

**Commit:** `tugdash(join-receipt-mechanics): add files line to the join summary`

**References:** [P02] first-parent and squash-only, [P03] historical parse-forever, Spec S01, Spec S04, Risk R02, (#context, #symbols)

**Artifacts:**
- `receipt_files_line` extracted; `format_join_summary` with the `files` parameter; `landing_file_stats`; the `do_changeset_join` success arm computing stats for a squash landing.

**Tasks:**
- [ ] Extract the `ReceiptFile` serialization from `format_commit_summary` into `receipt_files_line(files: &[tugchanges_core::FileStat]) -> String` (returns the full `files: […]` line); `format_commit_summary` keeps emitting it unconditionally, byte-identically — its three existing formatter tests must pass unchanged.
- [ ] Add `files: &[tugchanges_core::FileStat]` to `format_join_summary`; emit the line between header and message when `files` is non-empty, omit it when empty (Spec S01).
- [ ] Add `landing_file_stats(dir, sha)` in `changeset.rs`: `git diff-tree --root --numstat <sha>` and `git diff-tree --root --name-status <sha>` via the module's `git_stdout`, joined by `tugchanges_core::file_stats`; either read failing yields an empty vec. Document why it is `diff-tree --root` and not `git show` (Spec S04) — it is the spelling the deck's row expansion uses, so the list and the rows cannot describe different objects.
- [ ] In `do_changeset_join`'s `(Some(sha), false)` arm (`agent_supervisor.rs`), compute the stats only when `outcome.strategy == "squash"` — otherwise pass an empty slice — and hand the result to `format_join_summary`.

**Tests:**
- [ ] `format_join_summary` with files asserts the exact v2 bytes (header, `files:` line, message) — this literal is what Step 2 copies.
- [ ] `format_join_summary` with empty files asserts the exact legacy bytes — no `files:` line, message at line 1.
- [ ] Existing `format_commit_summary_*` tests pass unchanged (the extraction moved bytes nowhere).

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast`

---

#### Step 2: The join receipt rides the commit presentation {#step-2}

**Depends on:** #step-1

**Commit:** `tugdash(join-receipt-mechanics): render the join receipt as a commit`

**References:** [P01] receipt rides the commit presentation, [P03] historical parse-forever, Spec S01, Risk R01, (#assumptions, #state-zone-mapping, #test-non-goals)

**Artifacts:**
- `parseJoinReceipt` with files; `SessionJoinReceiptBlock` on the commit skeleton; updated unit tests and `at0419`.

**Tasks:**
- [ ] Export `parseFilesLine` from `session-commit-receipt-block.tsx`; import it and `CommitReceiptFile` in the join block. `ParsedJoinReceipt` gains `files: CommitReceiptFile[]` (empty for legacy and non-squash rows), parsed exactly as `parseCommitReceipt` does: line 1 is files only when it starts `files: `.
- [ ] Rebuild `SessionJoinReceiptBlock`'s render on the commit skeleton: header = `CommitShaText` + the squash message's first line as the subject (the same `<code>` treatment `commit-receipt-summary` gets); `resultSummary` = `{count: fileCount, noun: "file"}` + `{diff, added, removed}` (both only when files parsed) + `{count: rounds, noun: "round"}`; body = one identity line `<code>{dash} → {base}</code>` above the message body (`CommitMessage`), then `CommitChangesList root={props.message.cwd} sha={sha} files={files}` when files are present.
- [ ] Compute the badge numbers from the parsed files (sum of added/removed), matching how the commit header derives them; a row with no files shows the rounds badge alone — today's presentation, degraded gracefully.
- [ ] Compose, do not restyle ([L19], [L20]): the join block adds no rules reaching inside `CommitChangesList`'s or `CommitMessage`'s slots. Thin `session-join-receipt-block.css` to what the new render still uses; the identity line keeps a `join-receipt-` classed hook for the app-test.
- [ ] Update `at0419-join-receipt.test.ts`: the `JOIN_SUMMARY` literal becomes the v2 bytes copied verbatim from Step 1's new Rust assertion; assertions cover the subject-led header, the `dash → base` line, the file rows, and one row expanded into real hunk content; keep one seeded old-format row asserting it still renders as a receipt.

**Tests:**
- [ ] `session-join-receipt-block.test.ts`: v2 literal parses with files; the pre-existing old-format literal parses with `files: []` (parse-forever pin); a hand-typed arrow still refuses to parse.
- [ ] `just app-test tests/app-test/at0419-join-receipt.test.ts` green.

**Checkpoint:**
- [ ] `cd tugdeck && bun test src/components/tugways/cards/__tests__/session-join-receipt-block.test.ts src/components/tugways/cards/__tests__/session-commit-receipt-block.test.ts`
- [ ] `cd tugdeck && bunx tsc --noEmit && bunx vite build`
- [ ] `just app-test tests/app-test/at0419-join-receipt.test.ts`

---

#### Step 3: Both commit paths survive index.lock {#step-3}

**Commit:** `tugdash(join-receipt-mechanics): retry the dash commit paths on index.lock`

**References:** [P05] index.lock retry, Spec S02, [L31] a gesture produces the act or a visible reason, (#context)

**Artifacts:**
- `index_lock_blocked`; the retry loop in `commit_worktree_dirt` and in `ops::commit`.

**Tasks:**
- [ ] Add `index_lock_blocked(stderr: &str) -> bool` (contains `index.lock`).
- [ ] Restructure `commit_worktree_dirt` as Spec S02's loop: status → clean returns Ok → add → commit → on a lock-blocked failure `std::thread::sleep(150ms)` and re-enter (≤10 attempts). A non-lock failure returns its original message unchanged.
- [ ] Apply the same loop to `ops::commit`'s stage-and-commit sequence: a lock-blocked `git add` or `git commit` sleeps and re-enters from the `add -A`; the existing `diff --cached --quiet` re-check is what makes a concurrently-swept worktree land on the `committed: false` path.

**Tests:**
- [ ] `commit_worktree_dirt` under a held lock: create `.git/index.lock` in a scratch repo, release it from a helper thread after ~300ms, assert the call succeeds and the dirt is committed.
- [ ] Yield case: hold the lock, have the helper thread commit the dirt itself before releasing, assert `commit_worktree_dirt` returns Ok with no new commit (the yield is a no-op).
- [ ] Lock never released: assert the call fails after the bounded window and the error still names `index.lock` verbatim.
- [ ] `ops::commit` equivalents for the first two cases, asserting `CommitOutcome.committed` correctly reports each.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugdash-core`

---

#### Step 4: The sweep is marked, and is not a round {#step-4}

**Depends on:** #step-3

**Commit:** `tugdash(join-receipt-mechanics): mark the sweep commit and drop it from rounds`

**References:** [P04] sweep wears the round voice, [P07] marked commits are not rounds, Spec S03, (#context, #success-criteria)

**Artifacts:**
- `commit_worktree_dirt(worktree, name)` with the round voice and the `Tug-Sweep` trailer; `dash_round_subjects`; the three round-derivation sites reading through it.

**Tasks:**
- [ ] Give `commit_worktree_dirt` a `name: &str` parameter; build its message as `tugdash(<name>): commit outstanding changes` passed through `tugchanges_core::append_trailers` with `("Tug-Sweep", "1")`. Update both callers — `join_in` (ops.rs) and `resolve_ladder`'s preamble (resolve.rs), both of which already hold the name.
- [ ] Add `dash_round_subjects(repo_root, base, branch) -> Vec<String>` implementing Spec S03's single `git log` read with the `%(trailers:key=Tug-Sweep,valueonly)` field, dropping records whose trailer field is non-empty.
- [ ] Rewire `dash_detail_entries_in` to call it once: `round_subjects` is its result, `rounds` is `result.len() as u32`, and the separate `rev-list --count` call goes away. Confirm the downstream readers of `rounds` — `join_ready`, `derive_stage` — still receive the same type.
- [ ] Rewire `status_in`'s `rounds` and `show_in`'s `RoundItem` list through the same filter (`show_in` needs hash and date too, so extend the helper's format rather than adding a second reader).
- [ ] Update the `commit_remap` comment in `replay.rs` that contrasts against the old hardcoded subject.
- [ ] Leave the `join-mode-controller.ts` comment quoting `join: commit outstanding changes` exactly as written — it narrates a past incident, and re-voicing it would falsify the record.
- [ ] Grep tugdash-core tests for the old subject and update every assertion to the round voice.

**Tests:**
- [ ] A dash with N authored rounds, swept by `commit_worktree_dirt`, still reports `rounds == N` and `round_subjects.len() == N`, with the sweep's subject absent.
- [ ] The sweep commit's message carries the `Tug-Sweep: 1` trailer and the `tugdash(<name>): ` subject.
- [ ] A dash whose only commit is a sweep reports `rounds == 0` and is not `join_ready`.
- [ ] A sweep written without the trailer (simulating a pre-existing one) still counts — the filter keys on the trailer, never on the subject ([P07]).
- [ ] `status_in` and `show_in` agree with `dash_detail_entries_in` on the same swept dash.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugdash-core`

---

#### Step 5: A replay deferral exits 0 {#step-5}

**Commit:** `tugdash(join-receipt-mechanics): a replay deferral exits 0`

**References:** [P06] deferral exits zero, (#non-goals)

**Artifacts:**
- `replay_exit_status(outcome) -> u8` in `tugutil/src/dash.rs`; `run_replay` delegating to it; rewritten docblock.

**Tasks:**
- [ ] Extract the match at the bottom of `run_replay` into `replay_exit_status`: `Replayed` / `Recorded` / `Current` / `Deferred` → `0`; `Conflicted` → `1`. `run_replay` returns `ExitCode::from(replay_exit_status(&outcome))`.
- [ ] Rewrite `run_replay`'s docblock: a deferral is the command declining to act and saying why — a non-error outcome whose exit agrees with its own `status: ok` JSON; a conflict stops mid-application and demands work, which exit 1 is the script-readable spelling of.

**Tests:**
- [ ] Unit test on `replay_exit_status` covering all five `ReplayOutcome` variants against plain `u8` values.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugutil`

---

#### Step 6: Integration checkpoint {#step-6}

**Depends on:** #step-1, #step-2, #step-3, #step-4, #step-5

**Commit:** N/A (verification only)

**References:** [P01], [P02], [P05], [P06], [P07], (#success-criteria)

**Artifacts:**
- None — this step verifies the fit, not the work.

**Tasks:**
- [ ] `tugutil dash replay join-receipt-mechanics`
- [ ] On `Replayed` / `Recorded`: `sh scripts/verify-fit.sh {base} {head}` with the replayed range.
- [ ] On `Current`: nothing re-runs — the last step's checkpoint verified these exact bytes; say so.
- [ ] On `Conflicted`: resolve in the worktree as ordinary work, commit the fix as a round, then verify as above.

**Tests:**
- [ ] None beyond the verify command — every per-step checkpoint is spent.

**Checkpoint:**
- [ ] The replay outcome is recorded and, where the tree moved, `verify-fit.sh` exits 0.

---

### Deliverables {#deliverables}

- A landed squash join whose transcript receipt is a commit receipt: sha, subject, badges, expandable per-file diffs, plus the `dash → base` identity — live and restored, byte-identical, with every historical receipt still parsing and non-squash joins degrading honestly rather than partially.
- Run endings that cannot kill each other on `index.lock`, and a preflight sweep that is marked as plumbing rather than counted as a round — which makes the receipt's own round count true.
- `tugutil dash replay` whose exit code and JSON tell one story.
