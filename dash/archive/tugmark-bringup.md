<!-- devise-skeleton v4 -->

## tugmark bring-up — a standalone program for git changes & commits {#tugmark-bringup}

**Purpose:** Ship `tugmark` (binary) over `tugmark-core` (library) — a cohesive program that owns "git changes & commits" the way `tugdash` owns git *worktrees* — so composing a commit is one command, never an ad-hoc `git status`/`git diff`/`git log` tail, and so tugcast and the CLI share a single implementation of stage→commit→receipt.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-07-16 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

Composing a commit needs three facts: **which files** changed this session, **what** changed in them, and **how** commits here read (message style). Today only the first has a home — `tugutil changes --json` (the session's attribution rows ∩ `git status`). The other two have no owner, so every tugplug skill improvises a raw-git tail, and those tails drift: `git log --oneline -10` in the `commit` skill vs. bare `git log` in `implement`/`dash`/`audit`; `--no-pager` only in `commit`; mixed `git status` forms (`--porcelain=v2` in `tugutil/src/commands/changes.rs` and `tugcast/src/feeds/git.rs`, bare `git status` in the `commit` skill, and `tugcast/src/feeds/changeset.rs` mixing porcelain forms across its status header and dash-diff paths); `git add <paths>` in the skill vs. `git add -- <files>` server-side. The `commit` skill even hand-rolls `git commit … && git --no-pager show --numstat --format= HEAD` while `tugcast/src/feeds/changeset.rs` (`run_changeset_commit`) already implements that exact operation and returns a structured receipt — two implementations of one thing, drifting, with tugdeck's `commit-block.tsx` scraping the numstat text back into structure at the end.

`tugutil` is where this landed only because it is the project's miscellaneous-command grab-bag (eight unrelated subcommands: `init`, `resolve`, `version`, `tell`, `instance`, `gate`, `state-dir`, `changes` — only `changes` touches git or the ledger). The AI-powered IDE this project is building treats git changes & commits as a *fundamental* surface; it deserves its own program, designed once, with a stable JSON contract, so no agent ever invents the incantation again.

#### Strategy {#strategy}

- **Mirror `tugdash`'s proven two-crate, dual-front-end shape**: a print-free typed library (`tugmark-core`) with a thin `--json` CLI (`tugmark`) over it, and tugcast linking the *library* directly in-process (never spawning the binary) — exactly how `tugdash-core` serves both the `tugdash` CLI and the Changeset card.
- **Build the library bottom-up**: canonical git shelling + parsers first, then each operation (`changes`, `commit`, `context`, `log`, `diff`), each with unit/integration tests against a real temp git repo, before the CLI wraps them.
- **Make the commit receipt structured data**, not scraped text — the one durable contract both the CLI and tugcast emit and the deck consumes.
- **Consolidate fully but safely**: route tugcast's `run_changeset_commit` through the library and swap tugcast's duplicate porcelain/diff parsers for the library's canonical ones — while keeping tugcast's async feed-snapshot *builders* and its wire types unchanged, proven by a golden contract test.
- **Migrate the single caller** (`tugutil changes` → `tugmark`) and remove the extracted command in the same step, so nothing straddles two homes.
- **Sequence for green-at-every-step**: scaffold that compiles → library ops → CLI → distribution wiring → tugcast consolidation → skill migration → integration checkpoint.

#### Success Criteria (Measurable) {#success-criteria}

> Make these falsifiable. Avoid "works well".

- `tugmark context --json` run from a Session card `$`-route shell returns `{session, files:[…with per-file diff…], recent_commits:[…]}` in one call, with a non-empty `files` array for a session that edited files (verify: seed a session, edit a file, run it).
- `tugmark commit --message "<m>"` stages exactly the session's non-ambiguous changed files, commits, and prints a structured `CommitReceipt` whose `files[].added/deleted` match `git show --numstat` (verify: integration test in a temp repo).
- The `commit` skill runs **zero** raw `git` commands — its context-gathering is one `tugmark context --json`, and its commit is one `tugmark commit` (verify: grep the migrated skill for `git ` finds none in the command sequence).
- `cargo nextest run` is green with tugcast routing commits and git parsing through `tugmark-core`; the git/changeset feed snapshots are byte-identical to pre-consolidation on the fixture corpus (verify: golden contract test).
- `just build` produces a Tug.app bundle containing `Contents/MacOS/tugmark`, and `~/.local/bin/tugmark` resolves (verify: the pbxproj copy loop `exit 1`s if absent, and the justfile symlink loop links it).
- `tugutil changes` no longer exists; `grep -rn "tugutil changes"` across `tugplug/` and the repo returns nothing (verify: grep).

#### Scope {#scope}

1. New crates `tugmark-core` (lib) and `tugmark` (bin), registered in the workspace and bundled/symlinked like the other `tug*` binaries.
2. `tugmark-core` operations: `changes` (ported from `tugutil`), `commit` (structured receipt), `context` (one-shot commit context), `log`, `diff`; plus canonical `git status --porcelain=v2` / unified-diff / numstat parsers as pure functions.
3. `tugmark` CLI: `changes`, `context`, `commit`, `log`, `diff` subcommands over the library, emitting the shared `JsonResponse` envelope.
4. Full consolidation in tugcast: `run_changeset_commit` → `tugmark_core::commit`; `feeds/git.rs` + `feeds/changeset.rs` parsing → `tugmark-core` canonical parsers.
5. Skill migration: `commit`, `implement`, `dash`, `audit` updated to `tugmark`; `tugutil changes` removed.

#### Non-goals (Explicitly out of scope) {#non-goals}

- Merging `tugdash-core`'s worktree git helpers into `tugmark-core`. `tugdash` keeps its worktree git; `tugmark` owns changes/commits. (They may share a lower git-shell crate later — not now.)
- Rewriting tugdeck's `commit-block.tsx` to consume the structured receipt instead of scraping numstat. The receipt carries a raw `numstat` field for transition; the deck migration is a follow-on ([Q01]).
- Any new git capability the current workflows don't already need (amend, stash, cherry-pick UI, arbitrary `git show <sha>` rendering).
- Attributing shell-typed edits into `file_events`. Explicitly rejected earlier as over-engineering; `tugmark changes` reports the session's ledgered (Claude-made) changes joined against the live working tree, same as `tugutil changes` did.

#### Dependencies / Prerequisites {#dependencies}

- The Shell route now exports `$TUG_SESSION_ID` to spawned shells (commit `dc9263805`, `tugcast/src/feeds/shell.rs`). This is what makes `tugmark context`/`commit` usable from the `$` route; without it those commands can't resolve a session.
- `tugcore::instance::sessions_db_path()` (`tugrust/crates/tugcore/src/instance.rs:183`) — resolves the per-instance `sessions.db`.
- Repo-root resolution: `git rev-parse --show-toplevel` from the project dir (the `changes` join must key off the *session's* worktree root, not the main checkout — so `tugutil_core::worktree::find_repo_root` is deliberately NOT used; it starts from cwd and resolves a linked worktree back to the main repo, both wrong here). See [P08].
- Read models to port from: `tugutil/src/commands/changes.rs` (the `changes` query), `tugcast/src/feeds/changeset.rs` `run_changeset_commit` (the commit+receipt), `tugcast/src/feeds/git.rs` `parse_porcelain_v2`/`parse_git_diff` (the parsers).

#### Constraints {#constraints}

- **Warnings are errors** (`tugrust/.cargo/config.toml` enforces `-D warnings`); `cargo build` and `cargo nextest run` fail on any warning. Fix warnings immediately.
- **Sync core.** `tugmark-core` must be synchronous — tugcast calls sibling sync libraries via `tokio::task::spawn_blocking` (see `agent_supervisor.rs` join/release/resolve call sites) and will call `tugmark-core` the same way. Do not make the core async.
- **Read-only ledger access.** `tugmark-core` reads `sessions.db` read-only (`SQLITE_OPEN_READ_ONLY | SQLITE_OPEN_NO_MUTEX`), never writes it — the ledger is tugcast's to own.
- **No dependency on the `tugcast` crate** from `tugmark-core` (tugcast is the server; depending on it would invert the layering and risk cycles). The ledger is reached by raw SQL against `sessions.db`, not via `tugcast::session_ledger::SessionLedger`.
- **git via `std::process::Command`**, matching house style (`tugdash-core`, `tugutil` `changes` — no `git2`/`gix` dependency anywhere in the workspace).

#### Assumptions {#assumptions}

- The `sessions.db` schema for `file_events` (`tug_session_id, tool_use_id, file_path, tool_name, op, origin, ambiguous, parent_tool_use_id, project_dir, at`) and `sessions` (`session_id, …`) is stable; `tugmark-core` couples to it by raw SQL, as `tugutil changes` does today. A schema drift is caught by the contract test ([R04]).
- Only the `commit` skill invokes `tugutil changes`; nothing in the Swift app host calls it (confirmed by prior investigation — the app bundles `tugutil` for `instance`/`gate`, never `changes`).
- The `commit`/`implement`/`dash`/`audit` skills run under tugcode inside Tug.app, which is why `tugmark` must be bundled (the CLI, like `tugdash`, is reached by skills, not the Swift host).

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

Anchors are explicit and kebab-case; design decisions are `[P01]`, specs `S01`, lists `L01`, risks `R01`, open questions `[Q01]`. Steps cite these by ID/anchor, never by line number.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Should tugdeck's commit-block consume the structured receipt? (DEFERRED) {#q01-deck-structured-receipt}

**Question:** `tugdeck/src/components/tugways/body-kinds/commit-block.tsx` (`parseGitCommit`/`parseCommitFiles`) currently scrapes `git show --numstat --format= HEAD` text into `CommitData`/`CommitFile`. Should it instead consume `tugmark commit --json`'s structured `files` directly?

**Why it matters:** Scraping is fragile (rename `=>` parsing, binary `-` handling). Structured consumption is the durable end state. But it's a tugdeck change with its own tuglaws surface and isn't required for the CLI/tugcast consolidation to land.

**Plan to resolve:** Ship `CommitReceipt` with both structured `files` **and** a raw `numstat` string (Spec S03) so the existing scraper keeps working unchanged. Migrate the deck in a follow-on plan.

**Resolution:** DEFERRED — tracked in [Roadmap / Follow-ons](#roadmap). The raw `numstat` field is the compatibility bridge.

#### [Q02] Do tugcast's async feed builders move into tugmark-core, or only the parsers? (DECIDED) {#q02-feed-builders}

**Question:** `feeds/git.rs` has async builders (`build_git_diff_snapshot`, `build_git_log_snapshot`, `build_dash_diff_snapshot`) that spawn git and produce `tugcast_core::types` wire snapshots for live feeds. Should those move to `tugmark-core`?

**Why it matters:** Moving them would drag async + tugcast wire types into the library and blur the boundary.

**Resolution:** DECIDED (see [P06]). Only the **pure parsers** (`parse_porcelain_v2`, `parse_git_diff`, numstat) consolidate into `tugmark-core`. The async builders stay in `feeds/git.rs`, keep producing `tugcast_core::types`, and call `tugmark-core`'s parsers on the git output they already fetch. This shares the parsing logic without moving the feed plumbing or the wire contract.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Consolidation changes the git/changeset feed snapshots the deck consumes | high | med | Golden contract test on the fixture corpus; keep `tugcast_core` wire types unchanged, swap only parser internals | Any snapshot diff in the golden test |
| Bundle/symlink wiring miss → `tugmark` absent | med | med | pbxproj copy loop `exit 1`s on a missing bin; a green `just build` + `just app-test` smoke proves presence | App build error or skill "command not found" |
| Removing `tugutil changes` breaks an un-updated caller | med | low | grep proves the sole caller is the `commit` skill; migrate + remove atomically in one step | Any `tugutil changes` grep hit post-migration |
| `sessions.db` schema drift silently desyncs the raw-SQL query | med | low | Contract test seeds a known `sessions.db` and asserts the query; comment points at `session_ledger.rs` schema | Ledger schema change in tugcast |

**Risk R01: Feed snapshot regression under consolidation** {#r01-feed-snapshot-regression}

- **Risk:** Routing `feeds/git.rs`/`feeds/changeset.rs` through `tugmark-core` parsers subtly changes a `GitStatus`/`GitDiffSnapshot`/`GitLogSnapshot` the deck renders.
- **Mitigation:**
  - Before consolidating, capture golden snapshots of the existing parsers' output on the tugcast fixture corpus; assert byte-identical after.
  - Leave `tugcast_core::types` (the wire contract) untouched; the library returns its own structs and `feeds/git.rs` maps them to the wire types, so the mapping is explicit and testable.
- **Residual risk:** Fixtures may not cover every porcelain edge (submodule, rename with score, `.gitmodules`). Golden coverage is only as good as the corpus.

**Risk R04: Ledger schema coupling** {#r04-ledger-schema-coupling}

- **Risk:** `tugmark-core` hand-mirrors `file_events`/`sessions` SQL; a tugcast-side schema change desyncs it.
- **Mitigation:** A contract test builds a `sessions.db` with the current schema, inserts known rows, and asserts `changes`/`context` return them. A code comment in the ledger-query module names `tugcast/src/feeds/attribution.rs` + `session_ledger.rs` as the schema source of truth.
- **Residual risk:** The test encodes today's schema; a coordinated migration must update both sides.

---

### Design Decisions {#design-decisions}

#### [P01] Two crates: `tugmark-core` (lib) + `tugmark` (bin), mirroring tugdash (DECIDED) {#p01-two-crate-split}

**Decision:** Ship a print-free library `tugmark-core` and a thin `--json` CLI `tugmark` over it; tugcast depends on the library directly and never spawns the binary.

**Rationale:**
- This is the exact, proven shape of `tugdash`/`tugdash-core` (`tugrust/crates/tugdash/src/main.rs` is "a thin presentation shell over `tugdash_core::ops`"), whose dual front-end (CLI for skills, library for the Changeset card) is precisely what we need: skills shell `tugmark`, tugcast links `tugmark-core`.
- A library boundary is what lets tugcast retire its duplicate commit/parse code by *calling* the same functions the CLI calls.

**Implications:**
- All real logic lives in `tugmark-core`; `tugmark/src/main.rs` only parses args, calls the library, and formats output.
- tugcast adds `tugmark-core = { workspace = true }` and calls it via `spawn_blocking` ([P02]).

#### [P02] `tugmark-core` is synchronous; tugcast wraps it in `spawn_blocking` (DECIDED) {#p02-sync-core}

**Decision:** The library shells git synchronously with `std::process::Command`. tugcast calls it from async feed code via `tokio::task::spawn_blocking`.

**Rationale:**
- tugcast already does exactly this for the sync `tugdash-core` (`agent_supervisor.rs` wraps `tugdash_core::join_in`, `resolve_conflicts`, `release_in` in `tokio::task::spawn_blocking`). Following the established pattern keeps one concurrency story.
- A sync core matches `tugutil` `changes` and `tugdash-core`; it's the simplest thing that composes with both the CLI (naturally sync) and tugcast (via `spawn_blocking`).

**Implications:**
- No `tokio` dependency in `tugmark-core`.
- The commit path in tugcast becomes `spawn_blocking(move || tugmark_core::commit(opts))`.

#### [P03] Ledger read via read-only raw SQL, not via tugcast's `SessionLedger` (DECIDED) {#p03-ledger-raw-sql}

**Decision:** `tugmark-core` reads `sessions.db` (`file_events`, `sessions`) with read-only `rusqlite`, resolving the path via `tugcore::instance::sessions_db_path()` — never depending on the `tugcast` crate.

**Rationale:**
- `tugmark-core` must not depend on the server crate (`tugcast`) — that would invert layering and risk a cycle (tugcast depends on `tugmark-core`).
- This is the boundary `tugutil changes` already uses (`changes.rs` hand-mirrors the query and calls `tugcore::instance::sessions_db_path`). We preserve it.

**Implications:**
- The `file_events`/`sessions` schema is coupled by SQL, guarded by a contract test ([R04]).
- Opened with `SQLITE_OPEN_READ_ONLY | SQLITE_OPEN_NO_MUTEX`.

#### [P04] The commit receipt is structured data (DECIDED) {#p04-structured-receipt}

**Decision:** `tugmark_core::commit` returns a `CommitReceipt { sha, branch, message, files: [{path, status, added, deleted}], aggregate: {files_changed, insertions, deletions}, numstat: String }` (Spec S03). The raw `numstat` string is retained for transition.

**Rationale:**
- The current pipeline round-trips through text: `git show --numstat` → skill/`run_changeset_commit` → tugdeck scrapes it back to structure. Structured-at-the-source kills the fragility.
- Keeping the raw `numstat` field means tugdeck's existing scraper (`commit-block.tsx`) works unchanged until it migrates ([Q01]).

**Implications:**
- `ChangesetCommitReceipt { sha, receipt }` in `changeset.rs` is superseded by `CommitReceipt`; the changeset card path adapts to the richer shape.
- Numbers come from parsing `git show --numstat --format= HEAD` (the numstat parser, [P08]).

#### [P05] `tugmark commit` derives its own file set; staging is by construction (DECIDED) {#p05-commit-file-set}

**Decision:** With no `--paths`, `tugmark commit --message M` commits exactly the session's **non-ambiguous** changed files (the `changes` set). `--paths a b …` overrides with an explicit list; `--all` includes ambiguous files too. Staging is `git add -- <files>` then `git commit -m <message> -- <files>` — never `git add .`.

**Rationale:**
- One command, atomic and consistent: the file set is computed the same way the skill would, but inside the tool, so the receipt can't disagree with what was staged.
- The `-- <files>` pathspec on **both** add and commit means anything else already in the index stays out — the exact guarantee `run_changeset_commit` already provides.
- `--paths`/`--all` give the agent the escape hatch the `commit` skill needs for the rare "include this one ambiguous file because the diff clearly shows it's mine" case.

**Implications:**
- `tugmark commit` calls the `changes` query internally (unless `--paths`).
- Refuses an empty file set and a blank message with a clear error (matching `run_changeset_commit`).

#### [P06] Full consolidation: parsers + commit route through `tugmark-core`; feed builders stay (DECIDED) {#p06-consolidation}

**Decision:** tugcast routes `run_changeset_commit` through `tugmark_core::commit`, and `feeds/git.rs`/`feeds/changeset.rs` use `tugmark-core`'s canonical `parse_status_porcelain_v2`/`parse_unified_diff`/`parse_numstat` instead of their own copies. The async feed-snapshot builders and the `tugcast_core` wire types stay in tugcast (see [Q02]).

**Rationale:**
- Ends the drift at the root: one parser, one commit operation, shared by the CLI and the server.
- Scoping to parsers+commit (not the async builders or wire types) keeps the blast radius bounded and the feed contract stable ([R01]).

**Implications:**
- `feeds/git.rs` maps `tugmark-core` parser output → `tugcast_core::types` (`GitStatus`, `GitDiffFile`, …).
- A golden contract test proves the feed snapshots are unchanged.

#### [P07] `tugutil changes` is removed and the skill migrated in one step (DECIDED) {#p07-remove-tugutil-changes}

**Decision:** Delete the `changes` subcommand (and `commands/changes.rs`) from `tugutil`; migrate the `commit` skill to `tugmark` in the same step. No compatibility shim.

**Rationale:**
- The sole caller is the `commit` skill; a shim would be permanent cruft for a one-caller migration.
- Extraction is the whole point — leaving a forwarding stub keeps git logic in the grab-bag.

**Implications:**
- `tugutil`'s CLI enum, dispatch, and `commands/mod.rs` drop `changes`; the `rusqlite`/`dirs` deps stay only if other commands use them (else drop).
- `grep -rn "tugutil changes"` must be clean after this step.

#### [P08] Canonical git shell + parsers live in `tugmark-core`; `--porcelain=v2` everywhere (DECIDED) {#p08-canonical-git}

**Decision:** `tugmark-core` exposes a `pub` git-shell helper (`git_stdout`/`git_output`) and pure parsers (`parse_status_porcelain_v2`, `parse_unified_diff`, `parse_numstat`). Repo-root resolution is a `repo_root_for(dir)` helper that runs `git -C <dir> rev-parse --show-toplevel` and falls back to the project dir when it isn't a git repo (then the status map is empty and everything reads as non-dirty). Status is always `--porcelain=v2`.

**Rationale:**
- Kills the mixed `git status` drift by having one status invocation and one parser.
- `git rev-parse --show-toplevel` from the project dir is the behavior `tugutil/src/commands/changes.rs` already uses (`git_repo_root`), and it is the *correct* one: it returns the worktree the session edits in. `tugutil_core::worktree::find_repo_root` is deliberately rejected — it takes no path (starts from cwd, so `--project` can't be honored) and resolves a linked worktree back to the **main** repo, which would join a `tugdash`-worktree session's `file_events` against the wrong `git status` and report everything as non-dirty.

**Implications:**
- The project-dir → repo-root → empty-status-fallback chain from `changes.rs` is preserved verbatim in `tugmark-core`.
- `tugcast/src/feeds/changeset.rs` already parses via `parse_porcelain_v2` for its status header; its dash-diff path and any v1 status calls route through the canonical parser via [P06] — verify status consumers still get staged/unstaged/untracked.

---

### Deep Dives (Optional) {#deep-dives}

#### Current-state map: what exists, where {#current-state-map}

**Table T01: What moves, what stays** {#t01-move-stay}

| Today | Location | Under this plan |
|------|----------|-----------------|
| `changes` query (ledger ∩ `git status`) | `tugutil/src/commands/changes.rs` | Ported into `tugmark-core::changes`; removed from `tugutil` ([P07]) |
| commit + receipt | `tugcast/src/feeds/changeset.rs` `run_changeset_commit` → `ChangesetCommitReceipt {sha, receipt}` | Superseded by `tugmark_core::commit` → `CommitReceipt` ([P04], [P06]) |
| porcelain-v2 status parser | `tugcast/src/feeds/git.rs` `parse_porcelain_v2` | Calls `tugmark_core::parse_status_porcelain_v2` ([P06]) |
| unified-diff parser | `tugcast/src/feeds/git.rs` `parse_git_diff` | Calls `tugmark_core::parse_unified_diff` ([P06]) |
| async feed snapshot builders | `tugcast/src/feeds/git.rs` `build_git_diff_snapshot`/`build_git_log_snapshot`/`build_dash_diff_snapshot` | **Stay** in tugcast; call library parsers ([Q02]) |
| `git status`/`diff`/`log` ad-hoc tails | tugplug `commit`/`implement`/`dash`/`audit` skills | Replaced by `tugmark` subcommands ([P07], §skill-migration) |

**List L03: tugcast consolidation targets** {#l03-consolidation-targets}

- `tugcast/src/feeds/changeset.rs`: `run_changeset_commit` (async) → `spawn_blocking(tugmark_core::commit)`; adapt the `ChangesetCommitReceipt` consumer to `CommitReceipt`.
- `tugcast/src/feeds/git.rs`: `parse_porcelain_v2`, `parse_git_diff` → thin adapters over `tugmark-core` parsers; builders keep producing `tugcast_core::types`.
- `tugcast/Cargo.toml`: add `tugmark-core = { workspace = true }`.

#### How tugcast calls a sync sibling library (the pattern to copy) {#spawn-blocking-pattern}

`agent_supervisor.rs` wraps sync `tugdash_core` calls in `spawn_blocking`, e.g. `tokio::task::spawn_blocking(move || tugdash_core::join_in(&dir_owned, &dash, opts)).await`. The commit routing copies this: capture owned `repo_dir`, `files`, `message`; `spawn_blocking(move || tugmark_core::commit(CommitOptions{…})).await`. This is why [P02] mandates a sync core.

#### Distribution wiring — the full checklist {#distribution-wiring}

**List L02: everything to touch to ship a new `tug*` binary** {#l02-wiring}

1. Create `tugrust/crates/tugmark/` (bin) and `tugrust/crates/tugmark-core/` (lib), each with a `Cargo.toml` mirroring `tugdash`/`tugdash-core` (version/edition/license/rust-version `.workspace = true`; bin `[[bin]] name="tugmark"`; lib `[lib] name="tugmark_core"`).
2. `tugrust/Cargo.toml`: add `"crates/tugmark"` and `"crates/tugmark-core"` to `members`, and `tugmark-core = { path = "crates/tugmark-core" }` under `[workspace.dependencies]`.
3. `justfile` `build` recipe: add `-p tugmark` to the `cargo build` line (check the duplicate build line too).
4. `justfile` symlink loop: add `tugmark` to `for bin in tugcast tugexec tugutil tugdash tugcode tugpulse tugrelaunch tugbank` (the main-checkout-guarded loop that symlinks `tugrust/target/debug/*` into `~/.local/bin`).
5. `tugapp/Tug.xcodeproj/project.pbxproj`, the copy build phase (the `shellScript` with `for bin in tugcast tugcode tugutil tugdash tugexec tugrelaunch tugpulse`): add `tugmark` to that `for bin in …` list, and add the matching `$(SRCROOT)/../tugrust/target/$(CONFIGURATION)/tugmark` to `inputPaths` and `$(TARGET_BUILD_DIR)/$(CONTENTS_FOLDER_PATH)/MacOS/tugmark` to `outputPaths`.
6. `tugrust/scripts/sign-bundle.sh` `RUST_BINS=(…)`: add `tugmark` so it's signed.
7. `tugrust/scripts/build-app.sh` and `build-release-inputs.sh`: add `tugmark` wherever the release binaries are listed/copied.
8. `tugplug/hooks/auto-approve-tug.sh`: add `tugmark` to the auto-approve allowlist so skills can run it without a prompt.

#### Skill migration {#skill-migration}

- `tugplug/skills/commit/SKILL.md`: replace the context-gathering block (`tugutil changes --json` + `git status` + `git diff`/`git diff --cached` + `git log --oneline -10`) with a single `tugmark context --json`; replace the commit line (`git commit -m … && git --no-pager show --numstat --format= HEAD`) with `tugmark commit --message "<m>" --json` (and `--paths …` for the ambiguous-include case). Fix the stale "Dev card" → "Session card" wording while here.
- `tugplug/skills/implement/SKILL.md`, `dash/SKILL.md`, `audit/SKILL.md`: replace bare/ad-hoc `git log` history reads with `tugmark log` (and `tugmark diff --range <base>..<branch>` for audit's range review). Leave `tugdash create/commit/join/release/show/list` untouched — that's tugdash's remit.

---

### Specification {#specification}

#### Terminology {#terminology}

- **session** — the tug session id (full UUID), from `$TUG_SESSION_ID` or `--session`.
- **changes set** — the session's `file_events` rows deduped per path, joined against live `git status`, minus committed/reverted files (unless `--all`).
- **ambiguous** — a change whose ownership is uncertain (an overlapping session had a Bash bracket open); excluded from `commit` by default ([P05]).

**Spec S05: shared `JsonResponse` envelope** {#s05-envelope}

Every `--json` output uses the envelope `tugdash`/`tugutil` share: `{ "schema_version": "1", "command": "<name>", "status": "ok"|"error", "data": <payload>, "issues": [] }`. `command` is e.g. `"mark context"`, `"mark commit"`.

**Spec S01: `tugmark changes --json` data payload** {#s01-changes-schema}

```jsonc
{ "session": "…uuid…", "project": "/abs/dir",
  "files": [ { "path": "rel/path.rs", "op": "edit", "origin": "exact",
               "ambiguous": false, "git_status": " M",
               "diff": "…unified diff…"   // present only with --diff
             } ] }
```
Flags: `--session <id>` (default `$TUG_SESSION_ID`), `--project <dir>` (default cwd), `--all` (keep committed/reverted), `--diff` (include per-file unified diff). Exit codes preserved from `tugutil changes`: `0` normal, `2` for missing/unknown session or missing ledger.

**Spec S02: `tugmark context --json` data payload** {#s02-context-schema}

```jsonc
{ "session": "…uuid…", "project": "/abs/dir", "repo_root": "/abs/repo",
  "branch": "main", "head": "abc1234",
  "files": [ { "path": "rel/path.rs", "op": "edit", "origin": "exact",
               "ambiguous": false, "git_status": " M", "diff": "…unified diff…" } ],
  "recent_commits": [ { "sha": "abc1234", "subject": "tugcast(shell): export TUG_SESSION_ID to $ route" } ] }
```
`files` always carries `diff` (context is *for composing a message* — the diff is the point); a created/untracked file carries a synthesized add-diff, never an empty string. Flags: `--session <id>` (default `$TUG_SESSION_ID`), `--project <dir>` (default cwd — must match how `commit` resolves the repo, since `commit` reuses the same `changes` set), `--log-limit N` (recent-commit depth, default 10). This is the one-shot command the `commit` skill runs.

**Spec S03: `tugmark commit --json` data payload (`CommitReceipt`)** {#s03-commit-schema}

```jsonc
{ "sha": "abc1234", "branch": "main",
  "message": "subject line\n\noptional body",
  "files": [ { "path": "rel/path.rs", "status": "modified", "added": 24, "deleted": 6 } ],
  "aggregate": { "files_changed": 2, "insertions": 34, "deletions": 10 },
  "numstat": "24\t6\trel/path.rs\n10\t4\tother.rs\n" }
```
`status` ∈ `created|modified|deleted|renamed`. `added`/`deleted` are `null` for binary files (numstat `-`). `numstat` is the raw `git show --numstat --format= HEAD` text ([Q01] bridge). Flags: `--message <m>` (required), `--session <id>`, `--project <dir>` (default cwd — resolves the same repo/`changes` set as `context`, so the staged set can't disagree with the reviewed context), `--paths <p>…` (explicit set), `--all` (include ambiguous). Errors (exit 1) on empty file set or blank message.

**Spec S04: `tugmark log` / `tugmark diff` data payloads** {#s04-log-diff-schema}

```jsonc
// log:  { "range": "HEAD~10..HEAD",
//         "commits": [ { "sha": "abc1234", "subject": "…" } ] }
// diff:  { "range": "…"|null,
//          "files": [ { "path": "rel/path.rs", "status": "modified", "added": 24, "deleted": 6 } ] }
```
`log` flags: `--limit N` (default 10), `--range <a>..<b>`. `diff` flags: `--range <a>..<b>`, `--staged`, `--session` (session's changed files only). Both standardize on the two-dot `a..b` range convention for `log` and, where a range implies a merge base, document three-dot explicitly at the call site.

**Spec S06: `tugmark-core` public API surface** {#s06-core-api}

```rust
// tugrust/crates/tugmark-core/src/lib.rs (re-exports of module fns)
pub fn changes(opts: ChangesOptions) -> Result<ChangesReport, String>;
pub fn context(opts: ContextOptions) -> Result<ContextReport, String>;
pub fn commit(opts: CommitOptions)  -> Result<CommitReceipt, String>;
pub fn log(opts: LogOptions)        -> Result<LogReport, String>;
pub fn diff(opts: DiffOptions)      -> Result<DiffReport, String>;

// canonical pure parsers, reused by tugcast ([P06], [P08]):
pub fn parse_status_porcelain_v2(out: &str) -> StatusReport;
pub fn parse_unified_diff(out: &str)         -> Vec<DiffFile>;
pub fn parse_numstat(out: &str)              -> Vec<NumstatEntry>;

// git shell helper (sync):
pub fn git_stdout(dir: &Path, args: &[&str]) -> Result<String, String>;
pub fn git_output(dir: &Path, args: &[&str]) -> Result<std::process::Output, String>;
```
All return types derive `Serialize` for the CLI envelope. `changes`/`context` distinguish the exit-2 conditions (no session id, no ledger, unknown session) from real errors via a typed error/outcome rather than a `String`, so `main()` can map them to `ExitCode::from(2)` vs `1` ([F5]). `ChangesReport` carries `known: bool` (the unknown-session-with-no-events signal, per today's `compute_changes`).

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New crates {#new-crates}

| Crate | Purpose |
|-------|---------|
| `tugmark-core` | Sync library: git shelling, canonical parsers, and the `changes`/`context`/`commit`/`log`/`diff` operations |
| `tugmark` | Thin `--json` CLI over `tugmark-core` |

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tugrust/crates/tugmark-core/Cargo.toml` | lib crate manifest (`rusqlite`, `serde`, `serde_json`, `dirs`, `tugcore`, `tugutil-core`) |
| `tugrust/crates/tugmark-core/src/lib.rs` | public re-exports + shared types |
| `tugrust/crates/tugmark-core/src/git.rs` | `git_stdout`/`git_output` + `parse_status_porcelain_v2`/`parse_unified_diff`/`parse_numstat` |
| `tugrust/crates/tugmark-core/src/changes.rs` | `changes` (ledger ∩ status), ported from `tugutil/src/commands/changes.rs` |
| `tugrust/crates/tugmark-core/src/commit.rs` | `commit` → `CommitReceipt` |
| `tugrust/crates/tugmark-core/src/context.rs` | `context`, `log`, `diff` |
| `tugrust/crates/tugmark-core/src/ledger.rs` | read-only `sessions.db` query (raw SQL) |
| `tugrust/crates/tugmark/Cargo.toml` | bin crate manifest (`clap`, `serde`, `serde_json`, `tugmark-core`) |
| `tugrust/crates/tugmark/src/main.rs` | clap parser + `JsonResponse` envelope over the library |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `ChangesOptions`/`ChangesReport`/`Change` | structs | `tugmark-core/src/changes.rs` | mirrors today's `ChangesJson`/`ChangeFile` + optional `diff`; `ChangesReport` carries `known: bool`; `ChangesOptions` has `project` |
| `ChangesError` (or equivalent outcome) | enum | `tugmark-core/src/changes.rs` | distinguishes exit-2 cases (no session id / no ledger / unknown session) from exit-1 errors, so the CLI can map cleanly ([F5], `changes.rs:63/83/91`) |
| `CommitOptions`/`CommitReceipt`/`CommitFile`/`Aggregate` | structs | `tugmark-core/src/commit.rs` | Spec S03; `CommitOptions` has `project` |
| `ContextOptions` | struct | `tugmark-core/src/context.rs` | Spec S02; has `session`, `project`, `log_limit` |
| `ContextReport`/`LogReport`/`LogEntry`/`DiffReport`/`DiffFile`/`NumstatEntry`/`StatusReport` | structs | `tugmark-core/src/{context,git}.rs` | Specs S02/S04 |
| `run_changeset_commit` | fn (retire) | `tugcast/src/feeds/changeset.rs` | replace body with `spawn_blocking(tugmark_core::commit)` ([P06]) |
| `parse_porcelain_v2`/`parse_git_diff` | fn (retarget) | `tugcast/src/feeds/git.rs` | delegate to `tugmark-core` parsers ([P06]) |
| `Commands::Changes` + `commands/changes.rs` | enum variant + file (remove) | `tugutil/src/cli.rs`, `tugutil/src/commands/` | [P07] |

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit** | Parser correctness on known git output | `parse_status_porcelain_v2`/`parse_unified_diff`/`parse_numstat` golden inputs |
| **Integration** | Ops against a real temp git repo | `changes`/`commit`/`context`/`log`/`diff` end-to-end, driving real `git` |
| **Contract** | JSON envelope + `sessions.db` schema coupling | Seed a known `sessions.db`, assert `changes`/`context` payloads; assert feed snapshots unchanged after consolidation |

#### What stays out of tests {#test-non-goals}

- No app-test for the long `tugmark context → commit` UI flow. The Session-card `$`-route → ledger path uses a transient replay workspace (entries live ~2s), so a real multi-step scribe/commit UI flow isn't app-testable; cover it at the Rust integration layer with a temp git repo + seeded `sessions.db` (matches the existing "cover at the round-trip layer" convention).
- No mock-store / fake-DOM tests — banned. Integration tests drive real `git` and a real SQLite file.

---

### Execution Steps {#execution-steps}

> Commit after all checkpoints pass. Every step cites plan artifacts and anchors, never line numbers.

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Scaffold crates + workspace + build wiring | done | 08267a652 |
| #step-2 | tugmark-core git foundation (shell + parsers) | done | 89c33cb6c |
| #step-3 | tugmark-core changes query (ledger ∩ status) | done | 75afc6766 |
| #step-4 | tugmark-core commit → structured receipt | done | 58d711cda |
| #step-5 | tugmark-core context, log, diff | done | 0ee41907c |
| #step-6 | tugmark CLI binary over the library | done | 9b5800280 |
| #step-7 | Distribution wiring (justfile, bundle, hooks) | done | 4843c1341 |
| #step-8 | Consolidate tugcast onto tugmark-core | done | ce0e63e9b |
| #step-9 | Migrate skills; remove tugutil changes | done | d7d48f631 |
| #step-10 | Integration checkpoint | done | (verification only) |

#### Step 1: Scaffold crates + workspace + build wiring {#step-1}

**Commit:** `tugmark: scaffold tugmark + tugmark-core crates`

**References:** [P01] Two-crate split, List L02 (#distribution-wiring), (#strategy)

**Artifacts:**
- `tugrust/crates/tugmark-core/` and `tugrust/crates/tugmark/` with manifests + stub `lib.rs`/`main.rs` (a `--version`-only CLI).
- `tugrust/Cargo.toml` `members` + `[workspace.dependencies]` updated.
- `justfile` `build` line (`-p tugmark`) updated.

**Tasks:**
- [ ] Create both crates mirroring `tugdash`/`tugdash-core` manifests (inherit version/edition/license/rust-version; bin `name="tugmark"`, lib `name="tugmark_core"`).
- [ ] Register both in `tugrust/Cargo.toml` `members`; add `tugmark-core = { path = "crates/tugmark-core" }` to `[workspace.dependencies]`.
- [ ] Add `-p tugmark` to the `justfile` `build` recipe cargo line(s).
- [ ] Stub `main.rs` with the `JsonResponse` envelope struct copied from `tugdash/src/main.rs` and a no-op `--version`.

**Tests:**
- [ ] `cargo build -p tugmark -p tugmark-core` compiles clean (`-D warnings`).

**Checkpoint:**
- [ ] `cargo build -p tugmark` succeeds
- [ ] `tugrust/target/debug/tugmark --version` prints a version

#### Step 2: tugmark-core git foundation (shell + parsers) {#step-2}

**Depends on:** #step-1

**Commit:** `tugmark-core: git shelling + porcelain/diff/numstat parsers`

**References:** [P08] Canonical git + parsers, Spec S06 (#s06-core-api), (#current-state-map)

**Artifacts:**
- `tugmark-core/src/git.rs`: `git_stdout`/`git_output`; `parse_status_porcelain_v2`, `parse_unified_diff`, `parse_numstat`; `StatusReport`/`DiffFile`/`NumstatEntry` types.

**Tasks:**
- [ ] Port the porcelain-v2 status parsing from `tugcast/src/feeds/git.rs` `parse_porcelain_v2` into `parse_status_porcelain_v2`, returning a `tugmark-core` `StatusReport` (branch/head/staged/unstaged/untracked).
- [ ] Port `parse_git_diff` → `parse_unified_diff`; add `parse_numstat` (parse `N\tM\tpath`, `-` → binary/`null`, rename `old => new`).
- [ ] Implement `git_stdout`/`git_output` (sync `std::process::Command`, `-C <dir>`), `pub`.

**Tests:**
- [ ] Unit golden: porcelain-v2 sample (modified/untracked/renamed/staged) → expected `StatusReport`.
- [ ] Unit golden: numstat sample incl. a binary `-` line and a rename → expected entries.
- [ ] Unit golden: unified-diff sample → expected `DiffFile`s.

**Checkpoint:**
- [ ] `cargo nextest run -p tugmark-core` green

#### Step 3: tugmark-core changes query (ledger ∩ status) {#step-3}

**Depends on:** #step-2

**Commit:** `tugmark-core: port the changes query`

**References:** [P03] Ledger raw SQL, [P08] find_repo_root, Spec S01 (#s01-changes-schema), Risk R04 (#r04-ledger-schema-coupling)

**Artifacts:**
- `tugmark-core/src/ledger.rs` (read-only `sessions.db` query) and `src/changes.rs` (`changes` op).

**Tasks:**
- [ ] Port `tugutil/src/commands/changes.rs` logic: resolve session (`--session` else `$TUG_SESSION_ID`; empty → error/exit 2), resolve `sessions.db` via `tugcore::instance::sessions_db_path()`, open read-only.
- [ ] Query `file_events` (`SELECT file_path, op, origin, ambiguous … WHERE tug_session_id = ?1 ORDER BY at, tool_use_id, file_path`) and `session_exists` (`SELECT COUNT(*) FROM sessions WHERE session_id = ?1`).
- [ ] Resolve repo root via the `repo_root_for(project_dir)` helper (`git rev-parse --show-toplevel`, project-dir fallback per [P08]); build the status map via `parse_status_porcelain_v2`; dedup per path (latest op/origin, OR `ambiguous`), join, drop non-dirty unless `--all`.
- [ ] Add `--diff`: attach per-file unified diff. For tracked files, `git diff -- <path>` (working tree). For **untracked/created** files (`op: created` — a new-file `Write` — where `git diff` emits nothing), synthesize an add-diff via `git diff --no-index -- /dev/null <path>` (note: exits 1 when the files differ, which is the normal case — treat exit 1 with output as success, not an error).
- [ ] Add a comment in `ledger.rs` naming `tugcast/src/feeds/attribution.rs` + `session_ledger.rs` as the schema source of truth.

**Tests:**
- [ ] Integration: temp git repo + seeded `sessions.db` (known `file_events`/`sessions` rows) → `changes` returns expected paths/op/origin/ambiguous with correct `git_status`.
- [ ] Integration: `--diff` on an **untracked** file yields a non-empty add-diff (guards the F2 gap where `git diff` is silent for new files).
- [ ] Integration: unknown session → exit-2 semantics; valid-but-empty session → empty files, exit 0.
- [ ] Contract: schema-coupling test (R04) with a hand-built `sessions.db`.

**Checkpoint:**
- [ ] `cargo nextest run -p tugmark-core` green

#### Step 4: tugmark-core commit → structured receipt {#step-4}

**Depends on:** #step-3

**Commit:** `tugmark-core: structured commit receipt operation`

**References:** [P04] Structured receipt, [P05] Commit file set, Spec S03 (#s03-commit-schema)

**Artifacts:**
- `tugmark-core/src/commit.rs`: `commit(CommitOptions) -> CommitReceipt`.

**Tasks:**
- [ ] Derive the file set: `--paths` if given, else the non-ambiguous `changes` set, else (with `--all`) include ambiguous. Refuse empty set / blank message (error, exit 1).
- [ ] Stage + commit by construction: `git add -- <files>`, `git commit -m <message> -- <files>` (never `git add .`), mapping git stderr into the error.
- [ ] Build `CommitReceipt`: `git rev-parse HEAD` (sha), current branch, `git show --numstat --format= HEAD` (raw `numstat` + parsed `files` via `parse_numstat`), aggregate totals.

**Tests:**
- [ ] Integration: temp repo, two edited files → `commit` produces a receipt whose `files[].added/deleted` match `git show --numstat`; only the listed files are in the commit (a third dirty file stays out).
- [ ] Integration: empty message and empty file set each error with a clear message.

**Checkpoint:**
- [ ] `cargo nextest run -p tugmark-core` green

#### Step 5: tugmark-core context, log, diff {#step-5}

**Depends on:** #step-4

**Commit:** `tugmark-core: context, log, diff operations`

**References:** Spec S02 (#s02-context-schema), Spec S04 (#s04-log-diff-schema)

**Artifacts:**
- `tugmark-core/src/context.rs`: `context`, `log`, `diff`.

**Tasks:**
- [ ] `context`: `changes` set (always with diff — reuse Step 3's tracked + untracked/created add-diff handling, so new files carry a real diff) + `head`/`branch` + `recent_commits` via `git log --format=%h%x00%s -n <log-limit>` (default 10) parsed to `{sha, subject}`.
- [ ] `log`: `--limit`/`--range` → `LogReport`.
- [ ] `diff`: working tree / `--staged` / `--range` / `--session` (session files only) → `DiffReport` via `parse_numstat`/`parse_unified_diff`.

**Tests:**
- [ ] Integration: temp repo with commits + edits → `context` returns files-with-diff (including a non-empty diff for a newly created/untracked file) and the recent commit subjects in order.
- [ ] Integration: `log --limit 3` returns 3 entries; `diff --staged` reflects the index.

**Checkpoint:**
- [ ] `cargo nextest run -p tugmark-core` green

#### Step 6: tugmark CLI binary over the library {#step-6}

**Depends on:** #step-5

**Commit:** `tugmark: CLI binary over tugmark-core`

**References:** [P01] Two-crate split, Spec S05 (#s05-envelope), List L01 (#l01-subcommands), Specs S01–S04

**Artifacts:**
- `tugmark/src/main.rs`: clap subcommands `changes`, `context`, `commit`, `log`, `diff` over the library, `JsonResponse` envelope + plain human output.

**List L01: subcommand surface** {#l01-subcommands}
- `tugmark changes [--session][--project][--all][--diff][--json]`
- `tugmark context [--session][--project][--log-limit N][--json]`
- `tugmark commit --message <m> [--session][--project][--paths <p>…][--all][--json]`
- `tugmark log [--limit N][--range a..b][--json]`
- `tugmark diff [--range a..b][--staged][--session][--json]`

**Tasks:**
- [ ] Wire each subcommand to its library op; format `--json` via `JsonResponse::ok("mark <cmd>", data)` and a plain read-out otherwise.
- [ ] Exit-code plumbing: the library surfaces the unknown-session / no-ledger case as a **typed** outcome (e.g. `ChangesOutcome::UnknownSession`), NOT a stringly `Err` — `tugdash`'s `main()` maps every `Err` to exit 1, which would collapse the 0/2 distinction. `main()` matches the typed outcome to `ExitCode::from(2)` (with the stderr message from `changes.rs:63/83/91`), reserving exit 1 for real errors.
- [ ] Preserve plain-mode behavior: one repo-relative path per line excluding ambiguous rows, and the "`N ambiguous file(s) omitted — use --json`" stderr note (`changes.rs` `render_plain`).

**Tests:**
- [ ] Integration (invoke the built binary in a temp repo + seeded `sessions.db`): `tugmark changes --json`, `tugmark context --json`, `tugmark commit --message … --json`, `tugmark log --json`, `tugmark diff --json` each emit a valid envelope with the Spec payload.
- [ ] Integration: `tugmark changes` with an unknown session exits **2** (not 1); a valid empty session exits 0.

**Checkpoint:**
- [ ] `cargo nextest run -p tugmark` green
- [ ] `tugmark context --json` in a temp repo prints an S02-shaped payload

#### Step 7: Distribution wiring (justfile, bundle, hooks) {#step-7}

**Depends on:** #step-6

**Commit:** `tugmark: wire into justfile symlinks, app bundle, auto-approve`

**References:** List L02 (#distribution-wiring), Risk R02 (#risks)

**Artifacts:**
- `justfile` symlink loop; `tugapp/Tug.xcodeproj/project.pbxproj` (copy list + input/output paths); `tugrust/scripts/sign-bundle.sh`; `tugrust/scripts/build-app.sh`; `tugrust/scripts/build-release-inputs.sh`; `tugplug/hooks/auto-approve-tug.sh`.

**Tasks:**
- [ ] Add `tugmark` to the `justfile` `~/.local/bin` symlink loop.
- [ ] pbxproj: add `tugmark` to the `for bin in …` copy list and add its `inputPaths`/`outputPaths` entries.
- [ ] Add `tugmark` to `sign-bundle.sh` `RUST_BINS`, and to `build-app.sh`/`build-release-inputs.sh` binary lists.
- [ ] Add `tugmark` to `auto-approve-tug.sh`.

**Tests:**
- [ ] `just build` completes (the pbxproj copy loop `exit 1`s if `tugmark` is missing, so a green build proves it's bundled).

**Checkpoint:**
- [ ] `just build` succeeds and `Contents/MacOS/tugmark` exists in the built bundle
- [ ] `~/.local/bin/tugmark --version` resolves
- [ ] `just app-test harness-smoke/smoke.test.ts` green

#### Step 8: Consolidate tugcast onto tugmark-core {#step-8}

**Depends on:** #step-7

**Commit:** `tugcast: route commit + git parsing through tugmark-core`

**References:** [P06] Consolidation, [P02] spawn_blocking, List L03 (#l03-consolidation-targets), Risk R01 (#r01-feed-snapshot-regression), (#spawn-blocking-pattern)

**Artifacts:**
- `tugcast/Cargo.toml` (+`tugmark-core`); `tugcast/src/feeds/changeset.rs`; `tugcast/src/feeds/git.rs`.

**Invariant (freeze the wire contract):** the frame the deck receives is unchanged. `agent_supervisor.rs` (the commit request handler, which today forwards `run_changeset_commit`'s `{sha, receipt}`) must still emit the **exact same** sha + raw-numstat-text frame the deck's `commit-block.tsx` scrapes — the richer structured `CommitReceipt` is consumed server-side, and only `.numstat`/`.sha` cross the wire until [Q01] migrates the deck. Do not change any `tugcast_core` wire type in this step.

**Tasks:**
- [ ] Add `tugmark-core = { workspace = true }` to `tugcast/Cargo.toml`.
- [ ] Replace `run_changeset_commit`'s body with `spawn_blocking(move || tugmark_core::commit(…))`; adapt its caller (`agent_supervisor.rs` commit handler) from `ChangesetCommitReceipt {sha, receipt}` to `CommitReceipt`, taking `.sha` and `.numstat` for the unchanged wire frame.
- [ ] Retarget `parse_porcelain_v2`/`parse_git_diff` in `feeds/git.rs` to delegate to `tugmark_core::parse_status_porcelain_v2`/`parse_unified_diff`, mapping results into the existing `tugcast_core::types`; keep the async builders and wire types unchanged.
- [ ] Capture golden snapshots of the pre-change parser output on the fixture corpus; assert identical after.

**Tests:**
- [ ] Golden/contract: git status + `/diff` + log feed snapshots byte-identical to pre-consolidation on the fixture corpus (R01) — confirm the corpus covers a rename (score-suffixed porcelain).
- [ ] Adapt the existing `run_changeset_commit_*` tests (`changeset.rs`: `run_changeset_commit_commits_exactly_the_listed_files`, `_stages_untracked_selections`, `_refuses_empty_list_and_blank_message`, `_error_carries_git_stderr`) to the new `commit`/`CommitReceipt` path; they must keep passing (equal-file-set staging, untracked staging, refusals, git-stderr surfacing).

**Checkpoint:**
- [ ] `cargo nextest run` (whole workspace) green

#### Step 9: Migrate skills; remove tugutil changes {#step-9}

**Depends on:** #step-8

**Commit:** `tugmark: migrate skills; remove tugutil changes`

**References:** [P07] Remove tugutil changes, (#skill-migration)

**Artifacts:**
- `tugplug/skills/commit/SKILL.md`, `implement/SKILL.md`, `dash/SKILL.md`, `audit/SKILL.md`; `tugutil/src/cli.rs`, `tugutil/src/commands/mod.rs`, delete `tugutil/src/commands/changes.rs`.

**Tasks:**
- [ ] `commit` skill: replace the `tugutil changes --json` + `git status`/`git diff`/`git log` preamble with a single `tugmark context --json`; replace the commit line with `tugmark commit --message "<m>" --json` (`--paths` for ambiguous-include). Fix "Dev card" → "Session card".
- [ ] `implement`/`dash`/`audit`: replace bare/ad-hoc `git log` reads with `tugmark log`; audit's range review → `tugmark diff --range <base>..<branch>`.
- [ ] Remove the `Changes` variant + dispatch from `tugutil/src/cli.rs`, drop it from `commands/mod.rs`, delete `commands/changes.rs`.
- [ ] Check for orphaned deps: `changes` was `tugutil`'s only `rusqlite` user (and a `dirs` user). `-D warnings` does NOT flag unused manifest deps, so audit `tugutil/Cargo.toml` by hand (or `cargo machete`) and drop `rusqlite`/`dirs` if nothing else in the crate uses them.
- [ ] `grep -rn "tugutil changes"` across the repo → clean.

**Tests:**
- [ ] `cargo build -p tugutil` clean after removal (no dead-code/unused-dep warnings under `-D warnings`).
- [ ] `grep -rn "tugutil changes" .` returns nothing.

**Checkpoint:**
- [ ] `cargo nextest run` green
- [ ] The `commit` skill's command sequence contains no raw `git ` invocation

#### Step 10: Integration checkpoint {#step-10}

**Depends on:** #step-8, #step-9

**Commit:** `N/A (verification only)`

**References:** (#success-criteria), (#exit-criteria)

**Tasks:**
- [ ] Verify the full pipeline end-to-end: in a temp git repo with a seeded `sessions.db`, `tugmark context --json` → compose a message → `tugmark commit --message … --json` produces a receipt matching `git show --numstat`.

**Tests:**
- [ ] Whole-workspace `cargo nextest run` green.
- [ ] `just build` green with `tugmark` bundled; `just app-test harness-smoke/smoke.test.ts` green.

**Checkpoint:**
- [ ] All [Phase Exit Criteria](#exit-criteria) checked.

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** `tugmark`/`tugmark-core` shipped and bundled; the `commit` skill runs one `tugmark context` + one `tugmark commit` with zero raw git; tugcast commits and git parsing route through `tugmark-core`; `tugutil changes` removed.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] `cargo nextest run` (whole workspace) green with the consolidation in place.
- [ ] `just build` produces a bundle containing `Contents/MacOS/tugmark`; `~/.local/bin/tugmark` resolves.
- [ ] `tugmark context --json` and `tugmark commit --json` behave per Specs S02/S03 in a temp repo integration test.
- [ ] The `commit` skill's command flow is `tugmark context` + `tugmark commit` — no raw `git`.
- [ ] `grep -rn "tugutil changes"` is clean.
- [ ] Golden contract test confirms tugcast's git/changeset feed snapshots are unchanged.

**Acceptance tests:**
- [ ] tugmark-core integration: `changes`/`commit`/`context`/`log`/`diff` against a real temp repo + seeded `sessions.db`.
- [ ] tugcast golden/contract: feed snapshots byte-identical post-consolidation.

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] [Q01] Migrate `tugdeck/src/components/tugways/body-kinds/commit-block.tsx` to consume the structured `CommitReceipt` instead of scraping `numstat`; then drop the raw `numstat` field.
- [ ] Consider a shared lower-level git-shell crate that both `tugdash-core` and `tugmark-core` depend on (unify worktree git + changes/commit git).
- [ ] Route a live `git commit` Bash block in the Session card into the `CommitBlock` renderer (the "not yet wired" routing intent noted in `commit-block.tsx`).

| Checkpoint | Verification |
|------------|--------------|
| Library ops correct | `cargo nextest run -p tugmark-core` |
| CLI contract | `cargo nextest run -p tugmark` + temp-repo envelope checks |
| Bundled + resolvable | `just build`; `Contents/MacOS/tugmark` present; `~/.local/bin/tugmark --version` |
| Consolidation safe | Whole-workspace `cargo nextest run` + golden feed-snapshot test |
| Extraction complete | `grep -rn "tugutil changes"` clean |
