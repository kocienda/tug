<!-- brief-skeleton v1 -->

# Resolve the instance's paths once at the edge, so `tugarc-core` stops reading the environment and its tests stop serializing

**Purpose:** The cwd arc removed every working-directory read from `tugarc-core`, and its test suite got no faster: 332 of its 454 tests are `#[serial(tug_data_dir)]`, because every arc operation writes an arc-log line under a data directory that `tugcore::instance` reads from `TUG_DATA_DIR` at call time, and a test can only point that variable at its own temp directory by setting it process-wide.

---

## Purpose {#purpose}

From the audit of 2026-10-11:

> The cwd arc removed the mechanism but not the serialization. The tests now serialize on `TUG_DATA_DIR` instead of on the working directory, and the suite alone runs in the same twenty seconds it did before. The one structural debt still open is the environment-variable coupling in the instance layer.

The two observations are one piece of work. No path changes; what changes is when it is read and by whom.

---

## Evidence {#evidence}

**[F01] The environment is read at every call** — `tugrust/crates/tugcore/src/instance.rs` reads `TUG_DATA_DIR` inside `data_dir()` (:163), and `TUG_SESSIONS_DB`, `TUG_CHANGES_DB`, `TUG_PROMPT_HISTORY_DB`, `TUG_SESSION_INDEX_DB`, `TUG_APPTEST_RESULTS_DB`, `TUG_TEST_RESULTS_DB`, `TUG_INSTANCE_ID`, and `TUG_TEST_ISOLATION` inside their path functions (:52 to :393). There is no struct that holds a resolved set; `registry.rs:59 Instance` is the registry row, not the paths. **(verified)**

**[F02] `tugarc-core` reaches the environment through four doors** — `log.rs:249` reads `ENV_DATA_DIR` directly for the arc log's location; `ops/join.rs:500` calls `changes_db_path()`; `ops/show.rs:1060` calls `resolve_sessions_db_path()`; `ops/commit.rs:216` and :761 read `TUG_SESSION_ID`; and `instance_id()`, `instance_tmux_live`, `reap_instance_tmux` are called once each. Every other operation is pure over its `root` parameter. **(verified)**

**[F03] The tests serialize on the variable they set** — `ops/test_support.rs:22` and :112 `set_var("TUG_DATA_DIR", home)` under a comment that says every caller is `#[serial(tug_data_dir)]`. Keys across the crate: `tug_data_dir` 298, `tug_changes_db, tug_data_dir` 15, `tug_data_dir, tug_repo_universe` 5, three others. Fifteen `set_var` sites in all. `cargo nextest run -p tugarc-core`: 454 passed in 19.8 s, against 20.6 s before the cwd arc. **(verified)**

**[F04] Production readers of the instance paths, by file** — tugcast 10 sites (`session_ledger.rs`, `boot/ledgers.rs`, `attachments.rs`, `prompt_ledger.rs`, `session_index_watch.rs`), tugtool 3 (`draft.rs`, `session.rs`), tugcore 4 (`session_finder.rs`, `session_index.rs`, `quiesce.rs`), tugchanges-core 2 (`ledger.rs`), tugtool-core 2 (the two result ledgers), tuglog 1. The apptest-ledger and tugcode-wire tests in other crates isolate the same way: tugcast has 69 `set_var` sites and 81 `#[serial]`, tugcore 44. **(verified)**

---

## Decisions {#decisions}

**[B01] `tugcore::instance::Paths` is a plain struct holding every path `instance.rs` computes today, with one constructor that reads the environment, `Paths::from_env()`, and one that takes a data directory, `Paths::under(dir)`.** The existing free functions become thin calls to `from_env()` so no caller breaks on the day it lands; they are then deleted one crate at a time as callers take a `Paths`.

**[B02] `tugarc-core` takes a `&Paths` through its `*_in` entry points and reads the environment nowhere.** [F02]: the four doors become fields. `log.rs` takes the data dir it writes under; `join_in` and `show_in` take the ledger paths; the session id in `commit.rs` becomes a parameter the caller resolves. `tugtool/src/arc.rs` and tugcast's arc runner build one `Paths::from_env()` at dispatch and pass it, which is the same shape the cwd arc gave the repository root. A `tugcore` scan test, in the family of `no_ad_hoc_ledger_opens`, asserts no `env::var` of a `TUG_` name outside `instance.rs` in the crates that have adopted `Paths`.

**[B03] `test_support.rs` builds a `Paths::under(tempdir)` per test, the fifteen `set_var` sites go, and `#[serial]` comes off every test that was serial for a path.** The gauge is the `#[serial]` count in `tugarc-core`, from 332 to the handful that serialize on something else (`tug_repo_universe` is the other key, and whether `REPO_UNIVERSE_ENV` can be a `Paths` field is read at that step), and the suite's wall time, which the arc writes in its log before and after.

**[B04] The other crates adopt `Paths` only as far as `tugarc-core` needs them to.** `tugchanges-core::ledger` is called by the arc ops with a ledger path and takes it as a parameter; tugcast and tugtool's own readers in [F04] keep `from_env()` at their edges and are a later arc, since their tests serialize for reasons beyond paths (the instance registry, the gate port) that this brief has not read.

**[B05] Order: `Paths` with `from_env` and the shims ([B01]); `tugarc-core`'s four doors ([B02]); the test support rewrite and the serial sweep ([B03]); the scan test last.** The struct is additive and proves nothing until a consumer takes it; the arc crate is the consumer with a measurable payoff; the sweep is the payoff; the scan test is the gate that keeps it.

---

## Open Questions {#open-questions}

- Whether nextest's process-per-test already isolates a `set_var` so that some of the 298 would pass in parallel today, and `#[serial]` is defensive. The arc finds out by removing the attribute from one file and running it with the default thread count; if that is green, the sweep is faster than the brief assumes, and if it is not, the brief's reasoning stands. Either way the environment read leaves the crate, because a library that reads process state is the thing being fixed, not only the attribute.

---

## Non-goals {#non-goals}

- **Changing any path, variable name, or the precedence between them.** `Paths::from_env()` computes exactly what the free functions compute today.
- **Converting tugcast's or tugtool's own test isolation.** [B04].
- **Touching `TUG_SESSION_ID` identity resolution beyond passing it in.** The identity scan in `tugcore` owns that rule.

---

## Exit {#exit}

An arc. Steps as ordered in [B05], each ending with `cargo nextest run -p tugcore -p tugarc-core -p tugtool` green; the sweep step records the serial count and wall time before and after. After the last step, `just test-standalone` runs once because the arc verbs the plugin drives have a new parameter at their edge.
