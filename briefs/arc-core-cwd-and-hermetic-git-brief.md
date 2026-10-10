<!-- brief-skeleton v1 -->

# Drop `tugarc-core`'s cwd doors so its tests can parallelize, and give every crate one hermetic git fixture

**Purpose:** `tugarc-core` exposes fourteen functions that read the process working directory, its tests call them 372 times after `set_current_dir`, and 311 of its 454 tests are `#[serial]` to survive that. Forty test files across five crates define their own `fn git`, and none of them isolates the user's global git config from the test.

---

## Purpose {#purpose}

Item 20 of `briefs/audit-punch-list.md`:

> 20. Drop the cwd-reading wrappers from `tugarc-core` so its 217 `#[serial]` tests can parallelize, and a shared hermetic `git()` fixture that sets `GIT_CONFIG_GLOBAL` and `GIT_CONFIG_NOSYSTEM`.

No arc verb changes what it does. The `tugtool` caller resolves the repository once and passes it, which is what `tugcast` already does.

---

## Evidence {#evidence}

**[F01] The doors, after the ops split** — `tugrust/crates/tugarc-core/src/ops/cwd.rs` (249 lines) holds `cwd_repo_root()` (:22, wrapping `tugtool_core::find_repo_root` into `ArcError::Refused`) and 14 public wrappers, each a one-line call to the `*_in` form: `list`, `show`, `status`, `mark`, `commit`, `create`, `step_start`, `step_done`, `step_withdraw`, `step_reset`, `step_reopen`, `delete_documents`, `join`, `discard`. Three more cwd doors sit elsewhere: `replay::replay` (:129), `resolve::resolve_conflicts_cwd` (:184), `doctor::doctor_here` (:824); and `join.rs:1923` reads `current_dir()` to refuse a join run from inside the arc worktree. **(verified)**

**[F02] One production caller** — all 18 call sites are in `tugtool/src/arc.rs` (:205 to :2496); tugcast calls the `*_in` forms. Inside `tugarc-core`'s tests the wrappers are called about 372 times (`join.rs` 123, `steps.rs` 81, `show.rs` 52, `discard.rs` 31, `commit.rs` 29, `create.rs` 29, and five smaller files). **(verified)**

**[F03] `#[serial]` and `set_current_dir`** — 311 `#[serial]` in `tugarc-core` (`join.rs` 96, `log.rs` 31, `arc.rs` 29, `show.rs` 26, `create.rs` 22, `steps.rs` 22, `discard.rs` 21, `oplog.rs` 20, `replay.rs` 17, `commit.rs` 13, `identity.rs` 7, `documents.rs` 6, `cwd.rs` 1) of 454 tests; the punch list's 217 is stale. 51 `set_current_dir` calls, 50 in `tugarc-core` tests and one in `tugtool/src/commands/file.rs:887`, each under `#[allow(clippy::disallowed_methods)]` because `tugrust/clippy.toml:2` forbids it with the reason "Process-global CWD breaks parallel tests". The tests also `env::set_var` 23 times (`TUG_DATA_DIR` ×6, `TUG_CHANGES_DB` ×4, the sessions db ×3, `TUG_SESSION_ID`, `REPO_UNIVERSE_ENV`). `cargo nextest run -p tugarc-core`: 454 passed in 20.6 s wall, 170 s sys. Other crates: tugcore 44, tugcast 46, tugtool 10, tugchanges-core 0. **(verified)**

**[F04] Forty `fn git` test helpers and eleven `fn init_repo`** — tugcast 22 (eleven in one file, `agent_supervisor/tests/changeset.rs`), tugtool 8, tugarc-core 6, tugchanges-core 3, tugtool-core 1, plus near-variants (`git_in`, `git_stdout`, `init_git_repo`, `make_repo`). `tugtool/tests/common/mod.rs` provides only `Command` builders and no git. `tugcore`'s `test-fixtures` feature gates `hostile_repo` alone, and `tugcore::git_command()` sets only `GIT_OPTIONAL_LOCKS` and `GIT_LITERAL_PATHSPECS`. **(verified)**

**[F05] Nothing isolates git config** — `GIT_CONFIG_GLOBAL`, `GIT_CONFIG_NOSYSTEM`, and `GIT_CONFIG_SYSTEM` appear nowhere in `tugrust`. `"user.name"` is set by hand 85 times across the test files instead. A developer with `init.defaultBranch`, `commit.gpgsign`, or a global hook path set runs a different suite from one without. **(verified)**

---

## Decisions {#decisions}

**[B01] `tugtool/src/arc.rs` resolves the repository root once at dispatch and calls the `*_in` forms; `cwd.rs` and the three doors in [F01] are deleted, and `join.rs:1923`'s refusal takes the caller's cwd as a parameter.** [F02]: one caller, already the shape tugcast uses. The crate's public surface loses fourteen names that were each one line, and `lib.rs`'s eleven re-exports go with them.

**[B02] The tests call `*_in` with their temp directory, and `set_current_dir` leaves `tugarc-core` entirely; the `clippy::disallowed_methods` allows go with it.** This is the mechanical half, about 372 call sites and 50 directory changes, and it is what lets `#[serial]` come off every test that was serial only for the cwd. The gauge is two numbers after each file: `#[serial]` in that file, and the suite's wall time.

**[B03] The 23 env-var tests are classified by reading them: a value that can be passed as a parameter is passed; one that cannot stays `#[serial]` with a comment naming the variable.** `TUG_DATA_DIR` and `TUG_CHANGES_DB` are read inside `tugcore::instance` and the ledger openers; whether a parameter exists for each is a reading, not a guess, and the arc records the residue count. A test that is still serial for a named reason is not a failure of the arc; a test that is serial for no reason is.

**[B04] `tugcore::test_fixtures::git` (behind the existing `test-fixtures` feature, added to `tugtool`'s and `tugtool-core`'s dev-dependencies): `GitFixture::init(dir)` writes a fixture `gitconfig` with identity, `init.defaultBranch=main`, and nothing else, and every command it runs sets `GIT_CONFIG_GLOBAL` to that file and `GIT_CONFIG_NOSYSTEM=1`; `fixture.git(args)` runs and returns stdout, panicking with the full stderr on failure.** The 40 helpers and 11 `init_repo`s converge on it in a sweep, one crate per step. The production `git_command()` does not change: the user's global config is theirs, and only tests get a fixture one.

**[B05] Order: [B01], then [B02] file by file from `join.rs` down, then [B03], then [B04] with tugarc-core first and tugcast last.** The door removal is small and makes the test rewrite possible; the sweep is the bulk; the env classification needs the sweep done to see what is left; the fixture is independent and goes last so its sweep lands on tests that are already parallel.

---

## Open Questions {#open-questions}

- Whether nextest's process-per-test is doing some of the isolation the tests credit to `#[serial]` (`join.rs:2786-2791` says both). The arc runs the suite with `--test-threads` at the default after each file; a test that was passing only because its neighbour ran earlier fails there and is fixed there.

---

## Non-goals {#non-goals}

- **Changing `tugcore::git_command()` or any production git invocation.** [B04].
- **Touching tugcore's 44 `#[serial]` tests in `instance.rs`.** They serialize on the instance registry, not cwd; a different reason, a different arc.
- **Removing the `hostile_repo` fixture.** It composes with the new one.

---

## Exit {#exit}

An arc. Steps as ordered in [B05]. `cargo nextest run -p tugarc-core -p tugtool` is each step's verdict, with the wall time and `#[serial]` count written in the step's log; after the fixture sweep, `cargo nextest run` across the workspace once, and `just test-standalone` once because the arc verbs the plugin drives have changed their caller.
