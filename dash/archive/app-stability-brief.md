# App stability brief — tugcast SIGBUS and the test isolation leak

Written 2026-08-02 after five `tugcast` crashes in one day. This is a brief for discussion, not a plan of record; the second track needs a real `devise` pass before anyone builds it.

## What happened

Every Session card lost its transport at once — "Disconnected — reconnecting", "Connection lost / transport closed", "This card lost its session" — and the app had to be force quit. That reads like a frontend failure. It is not. `tugcast` died underneath the deck, and the deck reported the loss correctly.

The crash is `SIGBUS` / `EXC_BAD_ACCESS`, subtype `FS pagein error: 22 Invalid argument`, faulting inside SQLite's memory-mapped WAL-index (`-shm`) — top frames are `walIndexReadHdr`, `walFindFrame`, `readDbPage`. It happened five times on 2026-08-02: 17:05:23, 17:07:12, 17:23:21, 18:48:02, 18:58:46 PDT, all with the same signature.

The fastest way to recognise it: the instance's `tugcast.log.<date>` shows a **silent** gap — no `SIGTERM received`, no `tugcast shut down`, just a fresh `tugcast starting` — and `~/Library/Logs/DiagnosticReports/tugcast-<ts>.ips` exists at the exact second of the gap. A clean quit always logs `SIGTERM received, shutting down`.

## What is proven

The mechanism was reproduced with real SQLite processes: a live holder with the `-shm` mapped, and a second process performing one operation on that file.

| operation on the live `-shm` | holder |
|---|---|
| `unlink` | survived |
| rewrite in place, same size | survived |
| shrink 32768 → 4096 | **SIGBUS (signal 10)** |
| truncate to 0 | **SIGBUS (signal 10)** |

So the actor **shrinks** the file. Deleting it is harmless. Overwriting it in place is harmless. Only truncation kills a live reader.

## What is ruled out

The janitor (`5fa3556e6`, `92a41fb92`) is not involved, on two independent grounds. Three of the five crashes happened before the janitor's first-ever run in that build at 18:03:53, with an identical signature on both sides of that line. And its only filesystem verbs are `unlink` and `remove_dir_all`, which the table above shows a live holder survives.

Two attractive theories died under test. The POSIX footgun — where opening and closing any plain fd on a database drops every `fcntl` lock the process holds on that inode, including SQLite's dead-man switch — did not reproduce. Neither did SQLite's own DMS truncation, the one place SQLite deliberately calls `ftruncate(shm, 0)`: it refused to fire while a reader held the file, even after the read-write owner was `SIGKILL`ed and a replacement opened the database. SQLite defends that path correctly.

Also ruled out: the binary being replaced under the running process (the fault address is in no loaded image, so it is a data mapping, not text); mismatched SQLite builds sharing one `-shm` (one workspace lockfile, one bundled `libsqlite3-sys`); the `ledger_integrity` quarantine path (it error-logs loudly and never fired); and disk pressure (2.4 TiB free).

## The open question

**Which `-shm` is being truncated is not yet known, and it decides everything below.**

An earlier reading of the crash reports argued it was the machine-global `changes.db-shm`, because the faulting region's inode persisted across tugcast restarts while its neighbour's changed. That inference has a hole: a tugcast that dies on SIGBUS never closes cleanly, so the per-instance `sessions.db-shm` *also* survives with its inode intact across a crash-restart. Both files fit the evidence equally well.

A detector is running to settle it. It polls `changes.db-shm`, `sessions.db-shm` and `tugbank.db-shm` every 10ms and, on any shrink or inode change, dumps the process table and `lsof` to `/tmp/shm-truncation.log`. The next occurrence names both the file and the actor.

As of 2026-08-03 it has been up eleven hours with no event on any of the three files, and no new crash.

## Track one — the test isolation leak

This is independently real and worth fixing whether or not it is the crash.

Every Session card exports `TUG_INSTANCE_ID` into its shell children, and `changes_db_path()` returns the live machine-global ledger whenever `TUG_CHANGES_DB` is unset. Any `cargo nextest` run started from a Session card therefore resolves the **live** databases rather than temp ones.

This is demonstrated, not inferred. Re-running the suites with `HOME` redirected into a sandbox showed `tugcast --bins` creating `Application Support/Tug/projects/<slug>/dash-log.md`; without the sandbox those writes land in the real projects directory. `tugchanges-core`, `tugdash-core` and `tugbank-core` came back clean.

The correlation with the crashes is tight. Every one sits one to two seconds after concurrent instance activity — `debug-main` tugcast *starting* at 00:05:21 and 00:07:13 UTC against crashes at 00:05:23 and 00:07:12 — and after test-fixture tugbank domains (`test.domain`, `env-domain`, `flag-domain`, `com.example.test`, `domain.alpha`, `app.prefs`) reaching the live instance. Those arrive over `$TMPDIR/tugbank-notify.sock`, a machine-global path, so a test with its own temp database still rings the live app's doorbell.

### What it turned out to be — done 2026-08-03

The leak was wider than "some tests forget to isolate", and the fix landed in a different place than proposed above.

The real defect: **the application-data root was resolved in nine places and only one of them was overridable.** `TUG_DATA_DIR` already existed, but only `tugutil_core::project_state_dir` honored it. `tugcore::instance::base_data_dir`, `tugcore::instances_root`, `tugcast`'s `drafts_root` / `asides_root` / `models_root` / `SessionLedger::default_path`, `tugchanges_core::resolve_sessions_db_path` and `tugdash_core::sessions_db_file` each called `dirs::data_dir()` (or built `~/Library/Application Support/Tug` from `home_dir()`) themselves. No environment variable could move them, so a test run resolved live paths no matter what the harness set.

Also worth recording: the intended lever does not exist. `nextest.toml` has no `[env]` section — nextest ignores the key with a warning. Environment for test processes comes from Cargo's `[env]` table in `.cargo/config.toml`, where `relative = true` resolves against the config file's parent directory and `force = true` overrides an inherited value.

What was done:

- `tugcore::instance::base_data_dir` is now public, honors `TUG_DATA_DIR` (replacing the platform dir, still appending `Tug` — the same contract `tugcode`'s `tugDataRoot()` implements), and is the single origin of every Tug path. All nine call sites route through it; the three duplicated session-ledger fallbacks collapsed into one `resolve_sessions_db_path`.
- A tripwire keyed on `TUG_TEST_ISOLATION`: when set, any resolved path inside the user's real data root panics with the variable to set. It is a no-op in the shipping app.
- `tugrust/.cargo/config.toml` gained an `[env]` block forcing `TUG_DATA_DIR` to `target/tug-test-data`, `TUG_INSTANCE_ID` to `cargo-test`, and `TUG_TEST_ISOLATION` to `1`. Forcing is required: a run started from a Session card inherits that instance's real `TUG_INSTANCE_ID`. This also covers `cargo run`; the shipping app and the `just build` binaries are launched directly and are unaffected.
- `no_ad_hoc_data_dir_resolution`, a source-scanning enforcement test in the shape of the existing `no_ad_hoc_ledger_opens`, fails on any production `dirs::data_dir()` or hardcoded `Application Support/Tug` outside the chokepoint. Both tests now share one traversal (`tugcore::source_scan`). The guard was verified non-vacuous by patching in a violation with `tugutil file probe` and watching it fail.

Verification: 1879 tests across all thirteen crates pass, and a run with `HOME` redirected into a sandbox creates nothing under `Library` at all. The scratch dir shows what had been landing in the live root — `sessions.db` and `shell_exchanges.db` each with a live `-shm` mapping, `projects/`, `backups/`, and `Logs/tugcast.log`, meaning tests had been writing into the very log directory used to build the crash timeline above.

One test changed behavior deliberately: `fs_write`'s aside-root test redirected `HOME` to move `asides_root()`, which no longer keys off `HOME`. It now redirects `TUG_DATA_DIR`. The same substitution retired `HomeGuard` in `tugcore::instance`'s tests.

Not covered, and correctly so: the app-test harness launches `Tug.app` directly rather than through cargo, so `[env]` does not reach it — but it already pins `TUG_CHANGES_DB` per instance (`tests/app-test/_harness/index.ts`), so an app-test instance never maps the machine-global ledger.

Note the honest limit: the earlier changes-DB `TempDir` fix covered only the tugcast integration harness. This was the same bug class, wider than that fix scoped it.

## Track two — single-process `changes.db`

The more correct architecture, and the one that makes this crash class impossible regardless of who the truncator turns out to be: if exactly one process ever maps `changes.db-shm`, nothing can be truncated out from under a second mapping.

The single-writer contract already exists — non-owner instances log `another instance owns the changes ledger; attaching read-only and forwarding writes` on startup. But non-owners still *attach read-only*, and a read-only attach still maps the shared `-shm`. Single-**writer** is not single-**process**. Moving non-owner reads onto the owner's existing forwarding API closes that gap.

Two reasons not to start it yet.

First, it may not be the fix. If the faulting mapping is the per-instance `sessions.db-shm`, this is a large change to the read path that addresses a file that was never shared, and the crashes continue. That question is cheap to answer and answering it first costs nothing.

Second, it is not shovel-ready. Open design questions that deserve a plan rather than mid-implementation discovery: what a non-owner displays when the owner process dies, where today it degrades to a stale-but-readable attach and afterwards would have nothing; how ownership hands off; what a round-trip does to the aggregate changeset feed's latency; and how `ledger_degraded` stays honest when the truthful answer is "the owner is unreachable" rather than "the ledger is damaged".

## Proposed sequencing

Do track one now, while the detector runs. It is understood, bounded, and independently justified.

Let the next crash name the file and the actor. Then decide whether track two is the right target or whether the real one is elsewhere, and give it a proper `devise` pass before building.

One caveat to state plainly: if track one stops the crashes, we may never catch the actor red-handed, and this closes on strong correlation rather than proof. That is an acceptable outcome, but it should be recorded as what it is.

## Unrelated, for the record

The fan noise during the incident was not the crash. Two runaway `yes` processes, reparented to launchd, had been burning a core each since Aug 1 (~31 hours), alongside a `vite build` and `esbuild` pair at roughly 360% from a session in a dash worktree. Load average was 6.9. The `yes` processes have been terminated. They are the shape of debris the janitor reaps — aged, reparented to PID 1 — but it will never touch them, correctly, because it only reaps tug-owned executables.
