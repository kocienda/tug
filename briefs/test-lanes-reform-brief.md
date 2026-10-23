# Test lanes reform: machine-independent tests in a fast lane and a full lane

**Purpose:** `just ci` and the GitHub CI it mirrors are flaky and slow, and every red of the past three days was a test measuring the machine it ran on rather than the product. The check has to become machine-independent and timely at once: no test tied to any machine's speed or state, and a push verdict in five minutes.

---

## Purpose {#purpose}

The user's words: "`just ci` is flaky as crazy ... we need to root out what is making this so fragile and set the check on firmer footing." Then: "It feels like we are trying to base our critical push and release workflow on facilities that *ARE KNOWN TO BE HUGELY FLAKY* (Lock files... YOU CAN'T BE SERIOUS!!!). STOP THIS. Remove these tests. Get this workflow back on a timely design. I shouldn't have to wait >15m to see flak again and again. A build should take no more than 5 minutes."

And the correction that sets the bar: "Tests must not be tied to the characteristics of *my machine*. The timing **and** flakiness need to be solved."

Four CI runs went red between 2026-10-21 and 2026-10-23, and `just ci` went red on the user's own terminal in the same window. Each red was patched with a bigger number, and the next run found the next number. That loop is what this brief ends.

---

## Evidence {#evidence}

**[F01] Every red of the window was a test measuring its machine, not the product.** Read from the CI logs of the four failed runs and the local ledger. **(verified)**

| Run | What failed | Cause |
|---|---|---|
| 39606752777 | `select-tests-ratchet.test.ts` | bun's 5 s default timeout, hit by a test that spawns the real selector |
| 39819528675 | `layout-imposer-solutions.test.ts` | a wall-clock `toBeLessThan` on a sweep tuned locally |
| 39860738316 | the same sweep assertion | same |
| 39962024013 | `tugplug/__tests__/standalone.test.ts` | `beforeAll` spawning git and tugtool past the 5 s default |
| local `just ci` | `tugcast feeds::shell::tests::settled_exchange_is_recorded_to_the_ledger` | the test spawns the user's real login zsh, which blocks in `lockhistfile` on the user's history lock |

Not one red found a product defect. Each was repaired by raising a number, and the next number was found by the next run.

**[F02] The CI runner is about six times slower than the development machine, and the number was never going to be stable.** Setup for the standalone suite took a few hundred milliseconds locally and 3.6 s then 5.2 s on two CI runs; the selector test took 4.4 s locally and about 27 s on CI. **(verified)** A constant tuned on one machine is a bet on every other, and the ratio is not even constant run to run on the same runner.

**[F03] The test suites hold forty-odd assertions on an elapsed duration, and a handful of per-file timeouts chosen by hand.** `grep` over the TypeScript tests finds about twenty `toBeLessThan` calls on a measured time (`block-height-index` asserts `elapsed < 1` ms, `do-set-region-wiring` asserts a 5× lexing ratio, `wedge-cap` asserts 5 s and 10 s walls, `send-path-horizon` asserts `elapsed < horizon × 20`, the sweep asserts `allocMs / restMs < 4`), and the Rust side has several `assert!(started.elapsed() < Duration::from_secs(n))`. Two files set `setDefaultTimeout` by hand (`select-tests-print` at 120 s, `standalone` at 60 s). **(verified by grep; each site is in the census, and the plan must read every one, because some compare a constant to a constant and are not timing tests.)**

**[F04] About twenty tugcast shell-feed tests spawn an interactive login zsh.** `tugrust/crates/tugcast/src/feeds/shell.rs` has 29 tests; the ten from `exec_round_trip_and_exit_code` through `kill_reaps_a_long_runner` spawn `spawn_session_shell`, which runs `$SHELL -il` and reads the developer's real rc, and the ten path-command and rc-word tests after them spawn `/bin/zsh -il` with `ZDOTDIR` pointed at a temp dir but `HOME` still the developer's. **(verified by reading the file.)** Either way `/etc/zshrc` sets `HISTFILE` under `$HOME` and the shell locks the user's history at startup. A sampled stuck shell sat in `zsh_main → readhistfile → lockhistfile → zsleep` for the whole 10 s warmup. The remaining nine tests (grammar, classify, relative-path grading) spawn nothing.

**[F05] CI wall time is sixteen minutes, and the shape of the workflow is most of it.** From the job and step timings of run 39962024013. **(verified)**

| Job | Minutes | Of which |
|---|---|---|
| typescript | 15.8 | `just lint` 6.0 (a full WASM release rebuild, and clippy and `cargo fmt` which already have their own jobs), `just test-ts` 7.9, standalone 0.1 |
| build | 12.5 | `cargo build --all-targets` 5.7 with a warm cache, `cargo nextest run` 4.3 |
| clippy | 3.0 | |
| format | 0.4 | |

The user waits on the longest job, and both long jobs carry work that is not a push-time verdict.

**[F06] Local `just ci` already averages about two minutes.** From the call-time ledger: 11 runs, mean 130 s, max 300 s. **(verified)** The timeliness problem is the CI shape and the test census, not the development machine.

**[F07] The slow Rust test time is in suites that spawn git and tugcast.** The ledger's per-binary totals: the `tugcast` binary's tests 423 s, `tugarc-core` 360 s, the next largest 30 s. **(verified)** `tugcast::integration_tests` has 41 tests spawning the real binary under tmux, `arc_runner.rs` has 131 tests, `operator.rs` 123 tests spawning git, `attribution.rs` 56, `git.rs` 50. These are integration suites, slow by nature and not shown flaky; they do not belong in a five-minute lane.

**[F08] Twenty-five TypeScript test files spawn a process.** From a grep for `Bun.spawn`, `spawnSync` and the real-tugcast helper. **(verified)** Nine are app-test selector tests that drive the built `tugtool`; six are tugcode session tests that spawn the bridge; among tugdeck's are `many-pages` (spawns a real tugcast under tmux), `real-worker`, `release-chunk-contents` (10 s) and `three-way-merge.fuzz` (10 s). Spawning is not itself a flake, but a process is the only thing a test can stall on, and the fast lane should hold as few as possible.

**[F09] The bun version floats on CI.** `oven-sh/setup-bun@v2` with `bun-version: "1.3.x"` resolved to 1.3.14 while the checkout runs 1.3.9. **(verified)** One of the two timeout mechanisms investigated (`bunfig` `[test] timeout`) behaves differently across 1.3 patch releases.

**[F10] Two of the week's rounds were lint reds that an arc commit let through.** Both fixed in `9ac7e1467` and `a17ece125`. **(verified)** Nothing runs the typecheck or oxlint before `tugtool arc commit` lands a step.

**[F11] Lint, Swift tests and the standalone suite are not recorded in the test ledger.** `just test-rust` and `just test-ts` go through `tugtool test run`; `lint`, `test-swift` and `test-standalone` do not, so a red there has no `tugtool test last --failures` and no history. **(verified by reading the `Justfile`.)**

---

## Decisions {#decisions}

**[B01] No test in any lane asserts a duration, and no test chooses its own timeout.** A test that compares an elapsed time to a number is a measurement of the machine, and [F01] and [F02] show it fails on any machine it was not tuned on. Every assertion in the [F03] census that compares a measured time is deleted or rewritten to assert the property it was standing in for (an operation ran once, a cache hit served the second call, a count is bounded). A comparison between two constants is not a timing test and stays. The only timeout is one suite-wide hang guard set in the recipe, far above any real run on any machine; `setDefaultTimeout` and per-test timeout arguments are removed from test files. The guard exists so a hung run ends with a named red, never so a slow run fails.

**[B02] No test in any lane depends on host state.** No test spawns an interactive or login shell, reads a user rc or history file, or inherits the developer's `HOME`, `SHELL`, `ZDOTDIR`, `TERM_PROGRAM` or `TERM_SESSION_ID`. A test that must spawn a shell spawns `/bin/sh` or `/bin/zsh` without `-i` or `-l`, with a scrubbed environment and a temp `HOME`. This rules out the lock in [F04] by construction, not by waiting less for it.

**[B03] The twenty login-shell tests in `shell.rs` are deleted, along with the sweep's ratio test.** The user asked for removal, not quarantine. The sentinel protocol, cwd persistence, exit codes and kill-reaping are re-covered by tests that drive the dispatcher with a non-login `/bin/sh` under [B02] where the property is about the protocol; what was about the user's rc (that a login shell sources it, that rc functions grade as words) is a product behaviour verified by hand and by the app-tests, not by a unit test spawning the developer's shell. The sweep keeps its invariant tests and loses the clause that timed the allocator.

**[B04] The rule in [B01] and [B02] is enforced by a lint, written before the deletions.** A `tugtool`-side or script lint in `just lint` refuses, in any test file: a shell spawned with `-i` or `-l`; `toBeLessThan`, `toBeGreaterThan` or an `assert!` whose operand is an elapsed time or a `Date.now()` difference; `setDefaultTimeout` or a per-test timeout; an inherited `HOME` in a spawn without a scrubbed env. A rule that lives only in a document drifts back the way the tuned constants did; a rule a lint holds cannot. The lint lands first so the deletions are checked by it and the census in [F03] is closed by the lint going green, not by a grep.

**[B05] Two lanes: `just ci` is the fast lane and the only push-time check; `just ci-full` adds the integration suites.** The fast lane holds every test that spawns nothing from the host, and no suite whose nature is slow. The full lane adds, by name: the `tugcast` integration binary, the `arc_runner`, `operator`, `attribution`, `git` and `tugarc-core` git-spawning suites, and the bun files that spawn a real tugcast or run a 10 s fuzz ([F07], [F08]). Nightly and release workflows run the full lane; the user runs it before a release. The fast lane's budget is five minutes on CI, on each verdict step ([B06]).

**[B06] The CI workflow is reshaped to the lanes, with a five-minute budget per verdict step.** Jobs: `rust-tests` (unit tests of the fast lane), `ts-tests` (bun fast lane, standalone, covers check), `ts-lint` (typecheck and oxlint), `lint` (the audits, shellcheck, clippy, fmt, once each), `wasm` (the release rebuild, path-filtered to `tugdeck/crates/`), and `full-lane` on the nightly schedule only. `just lint` stops carrying clippy and fmt twice ([F05]). A verdict step that runs past its budget is a red to investigate, not a budget to raise.

*Revised 2026-10-23, after the first run of the reshape ([`40024446014`](https://github.com/kocienda/tug/actions/runs/40024446014)).* A five-minute cap on the whole job could never pass cold: the new per-job cache keys started empty, clippy alone took 3m06 cold, `ts-fast`'s typechecks took 2m27 before any test, and a job killed mid-build either saved no cache (`rustc` still writing under the save) or saved a half-built one that the exact-hit rule then never rewrote. So the budget moves from the job to the verdict: each Rust-using job builds what its verdict needs in a `Build` step of its own and saves the cache right after it, every step that runs a `just` recipe carries `timeout-minutes: 5`, and the job's own `timeout-minutes` is only the cap on a cold build. The typechecks moved to their own `ts-lint` job, and the jobs are named for what they run rather than `-fast` (the user's call). `scripts/workflow-lint.ts` enforces the step budget. The same run found `rust-tests` missing bun, which tugcast's build script needs.

**[B07] Bun is pinned to the exact version the checkout runs, on CI and in a project file.** [F09]. A floating patch version is a second machine the tests were not written on.

**[B08] `tugtool arc commit` runs the typecheck and oxlint over the step's files before it lands the commit.** [F10]. Two rounds of CI were spent on reds that a ten-second check at the commit would have caught.

**[B09] Every `just ci` step records to the test ledger.** `lint`, `test-swift` and `test-standalone` go through `tugtool test run` or `report unit` so a red anywhere in the lane is named by `tugtool test last --failures` and has a history ([F11]).

**[B10] A red in either lane has three endings: the code is fixed, the test is changed, or the test is deleted.** Raising a number is none of them. This is already the working rule for app-tests; it now binds the unit lanes, and a change whose only content is a bigger timeout or a looser bound is refused in review.

---

## Open Questions {#open-questions}

- **How far the fast lane's Rust build gets under five minutes with a warm cache.** [F05] shows 5.7 minutes for `cargo build --all-targets` on a cache hit, which is too slow for a cache hit and suggests the cache key or the `--all-targets` set is wrong. The plan should measure one run after the reshape before deciding whether the Rust fast lane needs splitting by crate.

---

## Non-goals {#non-goals}

- **Raising any timeout or wall-clock bound.** Rejected as the loop this brief ends ([F01]). The uncommitted edits that raised bun's timeouts to 60 s and 120 s are superseded by [B01]'s single recipe-level guard and the removal of per-file timeouts.
- **Quarantining the login-shell tests to a host lane instead of deleting them.** The user asked for removal; a quarantined test that depends on the user's history lock is flaky wherever it runs.
- **Deleting the slow integration suites.** They are slow, not flaky, and they cover git and tugcast behaviour nothing else does. They move to the full lane ([B05]).
- **Making the product's login-shell warmup faster.** The 10 s warmup and safe-mode fallback in the shell feed may stall on the same history lock for a user; that is a product finding worth its own brief, and it is not this reform.
- **Touching the app-test corpus.** Its selection discipline, budget and ledger already follow these rules and are not part of `just ci`.

---

## Exit {#exit}

An arc. The shape the steps take, in the order they must land:

1. The lint of [B04], green on the current tree only once the census of [F03] and [F04] is closed, so it is written first and run red.
2. The deletions and rewrites of [B03] and [B01]: the twenty `shell.rs` tests, the sweep's ratio clause, each timing assertion in the census, every per-file timeout. The lint goes green here.
3. The two lanes in the `Justfile` ([B05]) with the single hang guard, and ledger recording for every step ([B09]).
4. The workflow reshape and the bun pin ([B06], [B07]), measured once to answer the open question.
5. The commit-time lint in `tugtool arc commit` ([B08]).

The uncommitted edits in `Justfile`, `tugplug/__tests__/standalone.test.ts` and `tests/app-test/scripts/select-tests-print.test.ts` are superseded and should be dropped rather than landed.
