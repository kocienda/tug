<!-- devise-skeleton v4 -->

## Vestigial Resource Fixup {#vestigial-resource-fixup}

**Purpose:** Give the Tug suite a single machine-wide janitor (`tugcore::janitor`, surfaced as `tugutil host sweep`) that reclaims every class of leaked runtime debris — orphan instance data dirs, dead unix sockets, leaked tmux servers, and `$TMPDIR` test litter — wire it into the paths that already run routinely, and fix each leak at its source so the janitor is a backstop, not the plan.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-08-02 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

A 2026-08-02 audit of one developer machine found the app-test and dev-instance machinery leaving unbounded debris behind: **9,833** dead `tugcast-ctl-*.sock` control sockets (accumulating ~500/day since Jul 14), **8,765** `tugcast-test-changes-<pid>.db{,-wal,-shm}` files (146 MB) from Rust integration tests, **188 of 201** instance data dirs under `~/Library/Application Support/Tug/instances/` orphaned (726 MB), **130** screenshot PNGs (121 MB), ~**900** assorted test-tugbank DBs and `mkdtempSync` dirs, **14** dead tmux socket inodes — and one **live** orphan tmux server (`tmux -L tug-17a6924d`, session `cc-apptest-detached-650da0c2`, idle `zsh`, 20 hours old) that had been sitting there for 20 hours because nothing runs automatically.

The root cause is structural, not accidental. Every resource has an owner that cleans up on *graceful* shutdown — but the routine ending for an app-test instance is SIGKILL (the harness's escalation, the recipe's `pkill` backstop), which skips every owner epilogue. And because every launch mints a unique name (`apptest-<wtslug>-<uuid>` → per-launch sockets, data dirs, tmux tokens), leaks never collide with a future run, so nothing ever *notices* them.

**Three reclaim mechanisms already exist, and the gap is invocation, not capability.** `just reap` (`Justfile:545–684`) is a real machine-wide janitor — registry-cross-referenced, covering private `tug-*` tmux servers, legacy default-server `cc-*` sessions, `lsof`-guarded ctl/notify sockets, and PID-1-reparented `tugcode`/`claude` zombies. It would have reclaimed `tug-17a6924d` on the spot; it is manual, undiscoverable, and `lsof` over ~10k sockets takes minutes, so nobody runs it. `tugutil host instance prune` correctly identifies all 188 orphan dirs — but nothing invokes it, and its remit stops at data dirs. Only the justfile's `reap_orphan_tmux_servers()` is genuinely incapable: scoped to the current worktree's `TUG_APPTEST_ID_PREFIX`, it cannot reach a server leaked by a since-deleted detached worktree *by construction*.

So this plan is less an invention than a promotion: take `reap`'s registry-cross-referenced logic into probed Rust (a `connect()` probe is both more correct and orders of magnitude faster than `lsof`), extend it to the classes nobody covers ($TMPDIR test litter, screenshots, data-dir removal), and wire it into paths that already run — so the janitor executes without ritual.

#### Strategy {#strategy}

- Build the janitor once, in Rust, in `tugcore` (new `janitor` module) — so tugcast can call it natively at startup and `tugutil` can surface it as a CLI verb, with no shell-out or bundling questions.
- Prefer **liveness probes** over age heuristics wherever a probe exists: `connect()` for unix sockets, `tmux list-sessions` + registry lookup for tmux servers, registry + bundle-marker for data dirs. Age-gate (24 h) only inert files that cannot be probed (`$TMPDIR` test litter).
- Put a **minimum-age floor** under every deletion whose liveness signal is a registry lookup rather than a probe, because a booting instance is invisible to the registry for a real interval ([P10](#p10-age-floor)).
- Wire the janitor into paths that already run routinely: the `app-test` recipe (replacing the under-scoped shell reaper) and tugcast startup for dev/release instances — merely *using* Tug keeps the machine clean.
- Leave exactly one janitor standing: `just reap` becomes a thin front end over `tugutil host sweep` and its shell body is deleted, along with `reap_orphan_tmux_servers()` ([P07](#p07-single-owner)).
- Fix each leak at its source (TempDir-owned test DBs, tracked-and-unlinked tugbank temp files, harness-owned screenshot/tempdir lifecycles) so steady-state debris is zero and the janitor only catches crash residue.
- Make the fix durable with an enforcement test in the `no_ad_hoc_ledger_opens` mold: temp-file prefixes must be registered in the janitor's manifest, so the next debris class cannot be invented unswept.
- Sequence: janitor core first (steps 1–4), call-site wiring second (5–6), source fixes third (7–9), integration + law-doc close (10–11). Source fixes are independent of the janitor and can interleave if convenient.

#### Success Criteria (Measurable) {#success-criteria}

- After one `just app-test <file>` run on a clean checkout, the counts of `tugcast-ctl-*.sock`, `tugapp-test-*.sock`, `tugapp-screenshot-*.png`, `tugapp-test-tugbank-*` in `$TMPDIR`, `apptest-*` dirs under `~/Library/Application Support/Tug/instances/`, and `tug-*` sockets in `${TMUX_TMPDIR:-/tmp}/tmux-$(id -u)/` are each **no higher than before the run** (measure with `ls | wc -l` before/after).
- `tugutil host sweep --yes` on the audited machine reclaims the existing backlog: instances dir count drops to live-instances-only, dead ctl sockets to 0, and reports what it removed (verify with the same counts).
- A data dir or tmux server younger than `MIN_DEBRIS_AGE_SECS` is **never** removed, even with no registry entry — the booting-instance guard ([P10](#p10-age-floor)), covered by a Rust test with a freshly-stamped fixture.
- A deliberately-planted dead fixture of each class (dead socket file, orphan `tug-*` tmux server hosting only a `cc-apptest-*` session, orphan apptest data dir, >24 h-old `tugcast-test-changes-*.db`) is removed by one sweep; a *live* fixture of each class (bound socket, tmux server with a registered live instance's session, data dir of a registry-live instance, <24 h file) is untouched — covered by Rust tests.
- `cd tugrust && cargo nextest run` leaves `$TMPDIR` with zero new `tugcast-test-changes-*` files (count before/after).
- The enforcement test fails when a new `env::temp_dir().join("tug-something-…")` creator appears in `tugrust/` without a matching manifest prefix (demonstrated once by temporarily adding one).

#### Scope {#scope}

1. New `tugcore::janitor` module: socket sweep, tmux-server sweep, `$TMPDIR` debris sweep, apptest-data-dir sweep, and the shared temp-prefix manifest.
2. New `tugutil host sweep` subcommand composing the janitor with the existing `prune` (bundle-missing full removals).
3. Call-site wiring: `justfile` `app-test` recipe (both `reap_orphan_tmux_servers` sites), tugcast startup, and `just reap` re-pointed at the new verb (its ~110-line shell body deleted).
4. Source fixes: `tugrust/crates/tugcast/tests/common/mod.rs` changes-DB TempDir; `tugcode/src/__tests__/setup-tugbank.ts` WAL/SHM; app-test harness tracked cleanup for tugbank temp DBs, screenshots, `mkdtempSync` dirs, and its own sockets; harness tmux fallback fixed to target the private server.
5. One-time backlog remediation via the new sweep (part of the integration checkpoint).
6. Amending `tuglaws/app-test-harness.md`, whose recorded corollary, resource table, and known-limitations bullet this work directly changes.

#### Non-goals (Explicitly out of scope) {#non-goals}

- Claude Code's own debris (`/private/tmp/claude-501/`, `~/.claude/tasks/`) — upstream's, not Tug's.
- **Per-worktree app-test DerivedData** (`Tug-apptest-<wtslug>`), named in `tuglaws/app-test-harness.md` as "the known leak" with nothing automatic reclaiming it. It is build output, not runtime debris: it lives under `~/Library/Developer/Xcode/DerivedData/` (neither `$TMPDIR` nor the instances root), it is keyed to a worktree rather than to an instance, no registry entry or socket can testify to its liveness, and deleting one mid-build corrupts an Xcode build rather than reclaiming garbage. `just clean-all`'s `Tug-*` glob owns it today. Recorded as a follow-on (#roadmap) so the omission is deliberate rather than overlooked.
- Enforcement-test coverage of TypeScript/Swift temp-file creators — the manifest *sweeps* their debris, but the source-scan tripwire is Rust-only in this phase (see [Q01](#q01-ts-swift-enforcement)).
- Changing instance identity, port-window, or tmux-isolation schemes — the janitor works within the existing naming (`apptest-` prefix, FNV-1a short tokens, `cc-<id>` sessions).
- Sweeping `~/Library/Application Support/Tug/instances/debug-*` / `release-*` dirs whose bundles still exist — those are live dev surfaces; only the existing bundle-missing rule (via `prune`) touches them.
- TCC / LaunchServices cleanup changes — `remove --with-tcc` behavior is untouched.

#### Dependencies / Prerequisites {#dependencies}

- `tugcore::registry` (`list_live`, `find_by_id`) — already filters to live PIDs; the janitor's "is this instance live?" oracle.
- `tugcore::instance` helpers: `short_token_for`, `tmux_socket_label_for`, `reap_instance_tmux`, `tmux_bin`, `instances_root` (in `tugcore`), `BUNDLE_PATH_MARKER`.
- `tugcore::ports::is_apptest_id` — the apptest-family gate.
- Existing `tugutil host instance prune` / `remove --data-only` machinery in `tugrust/crates/tugutil/src/commands/instance.rs`.
- The existing `reap` recipe (`Justfile:545–684`) — the prior art this plan promotes into Rust; read it before implementing the janitor, its classification rules are the ones being ported.
- `tugutil` CLI surface: `HostCommands` in `tugrust/crates/tugutil/src/cli.rs` (the `Host(HostCommands)` arm at `Commands::Host`), dispatched by `tugrust/crates/tugutil/src/host.rs::dispatch`. `InstanceCommands` is a *different* enum, declared in `commands/instance.rs` — `sweep` is a sibling of `instance`/`gate`, not a member of `InstanceCommands`.

#### Constraints {#constraints}

- **WARNINGS ARE ERRORS** (`-D warnings` via `tugrust/.cargo/config.toml`).
- The janitor must be safe to run concurrently with live dev/release instances, other worktrees' app-test runs, and itself — every deletion is gated by a probe that a live resource passes (see [P02](#p02-liveness-probes)).
- Janitor functions must take their root paths as parameters (temp dir, tmux socket dir, instances root) so tests exercise them against fixture trees — production wrappers bind the real paths.
- No `Date`-based cleverness in tests; age-gate tests set fixture mtimes with `filetime` or `std::fs` explicitly.
- App-tests follow the selective doctrine: this plan's Rust work needs no app-test; the harness changes are covered by running any one app-test file and asserting the no-new-debris delta (cheap, deterministic).
- **Laws touched.** [L27] ("Every acquisition returns its release; the shorter-lived party calls it on teardown") is the law this whole plan serves: the source fixes ([P08](#p08-source-fixes)) *are* L27 compliance, and the janitor is the backstop for when the releasing party is SIGKILLed and never reaches its release. [L29] (canonicalization gateway) is **not** implicated: the janitor reads the bundle marker only to test path existence, never persists a path as a key and never hands one to Claude — the same reasoning `tugcore::registry::find_for_cwd` records for its own bare comparison. `tuglaws/app-test-harness.md` **is** amended by this plan (see [#step-11](#step-11)); its "No cross-instance file sweeps" corollary is a recorded discipline, and the tuglaws preamble requires updating the design rather than silently diverging.
- The sweep must **never** acquire the app-test gate (`tugutil host gate run --name apptest`): the `app-test` recipe re-execs its whole body under that gate and then calls the sweep, so a gate acquisition inside the sweep would deadlock against its own caller. The booting-instance safety comes from [P10](#p10-age-floor), not from serialization.

#### Assumptions {#assumptions}

- ~~A unix socket whose `connect()` fails with `ECONNREFUSED` has no listener and is safe to unlink~~ — **falsified by measurement during [#step-2](#step-2)**. On macOS a live `AF_UNIX` listener whose backlog is full also fails `connect()` with `ECONNREFUSED`, and it does so at backlog+1 connections; there is no `EAGAIN`/`ETIMEDOUT` to distinguish the cases. Errno discipline is kept (only `ECONNREFUSED`/`ENOENT` may unlink) but it is *not* sufficient on its own, so the socket pass is gated by the live-instance namespace check and the age floor as well ([P02](#p02-liveness-probes), [P10](#p10-age-floor)).
- `tmux -L <label> list-sessions -F '#S:#{session_attached}'` on a dead socket errors out (as observed: "error connecting to …"), distinguishing dead socket files from live servers.
- 24 h is a safe age gate for `$TMPDIR` test litter: no legitimate app-test or cargo-test artifact is read across a >24 h gap (the machine-wide app-test gate serializes runs; cargo tests are minutes).
- `tugutil` remains bundled in `Tug.app/Contents/MacOS/` (verified on the Release bundle) — but nothing in this plan depends on it, because tugcast calls `tugcore::janitor` directly.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] TS/Swift-side temp-prefix enforcement (DEFERRED) {#q01-ts-swift-enforcement}

**Question:** Should the manifest-enforcement test also scan `tugcode/`, `tests/app-test/`, and `tugapp/Sources/` for temp-path creators?

**Why it matters:** The Rust-only tripwire leaves a gap: a new TS/Swift temp-file class could accumulate unswept until someone notices.

**Plan to resolve:** Ship the Rust scan first; the manifest itself (which the sweep consumes) already lists the TS/Swift-created prefixes, so adding a new one to the sweep is a one-line manifest edit. Revisit a cross-language scan if a new unregistered class ever actually appears.

**Resolution:** DEFERRED — cross-language source scanning is brittle (string-building idioms differ per language); the cost/benefit favors the Rust-only tripwire plus code review for now.

---

### Risks and Mitigations {#risks}

| ID | Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|---|------|--------|------------|------------|--------------------|
| R01 | Sweep deletes a live resource | high | low | Liveness probes ([P02]); age floor ([P10]); live-fixture tests; data-dir removal reuses identity-checked `instance stop`/`remove` paths | any report of a killed live session |
| R02 | Startup sweep slows tugcast launch | low | low | Spawned on a detached thread; never blocks serving. The `connect()` probe replaces `reap`'s `lsof` (minutes over ~10k sockets → milliseconds) | startup-time regression |
| R03 | Age gate removes an in-flight >24 h artifact | med | low | Only inert manifest-prefixed files are age-gated; sockets/tmux/data dirs use probes; gate is a named constant, easy to raise | a test legitimately spanning >24 h |
| R04 | Sweep races a mid-boot instance (data dir or tmux server) | high | med | [P10](#p10-age-floor)'s `MIN_DEBRIS_AGE_SECS` floor — see [#r04-mid-boot-race](#r04-mid-boot-race) for why the registry alone is not enough | any app-test launch failure coinciding with a sweep |
| R05 | Two janitors drift apart | med | high without the fold | [P07](#p07-single-owner) deletes both shell janitors; `just reap` delegates to the one Rust implementation | a shell reap loop reappearing in the `Justfile` |

**Risk R01: Deleting live state** {#r01-deleting-live-state}

- **Risk:** The janitor's whole job is deletion; a scoping bug destroys a developer's live session or another worktree's in-flight run.
- **Mitigation:** Every class has a probe a live resource passes (bound socket accepts; live server's session id is in the registry; live instance's data dir is registry-protected); Rust tests plant live fixtures and assert they survive; dev/release tmux servers are *never* candidates (only servers whose sessions are all `cc-apptest-*`).
- **Residual risk:** A resource that is live but fails its probe (e.g. a registered instance whose registry write failed) could be swept. The age floor ([P10](#p10-age-floor)) bounds the blast radius: anything younger than `MIN_DEBRIS_AGE_SECS` is out of reach regardless of what the registry says.

**Risk R04: The mid-boot race — a booting instance is invisible to the registry** {#r04-mid-boot-race}

- **Risk:** `sweep_apptest_data_dirs` classifies "data dir exists + marker's bundle exists + no live registry entry" as an orphan. A *booting* instance matches that signature exactly, and the window is not brief. In `tugrust/crates/tugcast/src/main.rs`, `write_bundle_path_marker()` runs near the top of startup, while `tugcore::registry::register` runs much later — it needs `actual_port`, so it cannot happen until port allocation and the listener bind have completed. Everything in between (port walk, tugbank init, ledger opens) is time in which the instance owns a data dir and has no registry entry. A sweep firing in that window `remove_dir_all`s a live, booting instance's data dir.
- **Why this is new:** today the predicate lives only in `prune`, which is manual and interactively confirmed. This plan promotes it to unattended execution on every dev/release launch and at both ends of every app-test run, so a race that was theoretical becomes routine.
- **The same break hits the tmux ladder.** The "a server with zero sessions is reapable" rule is inherited from `Justfile:1255–1259`, where it is justified by an explicit precondition: *"the gate guarantees no other app-test run is live while we sweep."* Once the sweep also runs from tugcast startup — outside the gate — **that precondition no longer holds** and the rule's justification is gone. An inherited rationale that silently stops applying under new call sites is the most dangerous kind.
- **Mitigation:** [P10](#p10-age-floor). Both classes get an mtime floor; nothing young is ever a candidate, whatever the registry says.

---

### Design Decisions {#design-decisions}

#### [P01] The janitor lives in tugcore; CLI and tugcast both call it (DECIDED) {#p01-janitor-in-tugcore}

**Decision:** Implement all sweep logic as a new `tugcore::janitor` module; `tugutil host sweep` and tugcast's startup hook are thin callers.

**Rationale:**
- tugcast can invoke it natively (no shell-out, no PATH/bundling concerns), mirroring how `local_model::reconcile_catalog_ranks` already runs at startup.
- One implementation, two entry points — no drift between "what the CLI sweeps" and "what startup sweeps".
- `tugcore` already owns the identity math the sweep needs (`short_token_for`, `is_apptest_id`, registry).

**Implications:**
- `tugcore` gains a module with filesystem/process side effects; functions take root paths as parameters for testability.
- Bundle-missing *full* removals (which need `lsregister`) stay in `tugutil`'s `prune` — tugcast's startup sweep does everything except those (see [P05](#p05-sweep-composition)).

#### [P02] Liveness probes over age heuristics (DECIDED) {#p02-liveness-probes}

**Decision:** Each resource class is gated by the strongest available liveness signal; age (24 h, constant `TMP_DEBRIS_MAX_AGE_SECS`) applies only to inert `$TMPDIR` litter with no probe.

**Rationale:**
- A probe can never false-positive on a live resource the way an age threshold can; the old justfile glob ban ("isolation > tidiness") was a reaction to *unprobed* deletion — probing dissolves the objection.
- Observed populations confirm probes suffice: all 9,833 ctl sockets fail `connect()`; the orphan tmux server is identifiable by registry absence.

**Implications:**
- Socket sweep = `UnixStream::connect` per candidate. Unlink only on `ECONNREFUSED` or `ENOENT`; every other errno keeps the file. Accepted → drop the stream immediately and skip. **But the probe is not sufficient by itself**: measured on macOS, a live `AF_UNIX` listener with a saturated backlog returns `ECONNREFUSED` — the same errno a corpse returns — so two further gates carry the safety. A socket whose basename belongs to a live registered instance (`tugcast-ctl-<token>`, `tugbank-notify-<token>`, `tugcast-ctl-<port>` for tugexec) is never a candidate at all, and the age floor ([P10](#p10-age-floor)) applies here too, contrary to the original "a bound socket answers for itself" reasoning. A failed registry read aborts the pass.
- Tmux sweep = per `tug-*` socket in `${TMUX_TMPDIR:-/tmp}/tmux-<uid>/`: query sessions; dead socket → unlink the socket file; live server whose sessions are all `cc-apptest-*`, none of which maps to a registry-live instance id (session name minus `cc-` prefix), **and whose socket is older than the age floor** → `kill-server` + unlink; anything else → skip.
- Data-dir sweep = existing prune discovery semantics (registry + `BUNDLE_PATH_MARKER`) plus the age floor, moved where the janitor can drive the apptest-data-only portion.
- **A registry read failure is not an empty registry.** `reap` gets this right (`Justfile:591–594`, "refusing to reap blind") and the janitor must too: if `registry::load` errors, abort the registry-gated passes rather than treating every instance as an orphan.

#### [P03] A registered temp-prefix manifest with an enforcement test (DECIDED) {#p03-prefix-manifest}

**Decision:** The janitor's `$TMPDIR` sweep consumes a single manifest of prefixes (`List L01`) declared in `tugcore::janitor`; a repo-scanning test in the `no_ad_hoc_ledger_opens` mold fails when a Rust source mints a temp path whose prefix is not in the manifest.

**Rationale:**
- The audit's lesson is that debris classes get invented faster than anyone sweeps them; registration-or-red makes the sweep self-maintaining.
- The pattern already exists in this codebase (`tugcore/src/ledger_db.rs::no_ad_hoc_ledger_opens` walks `tugrust/crates` and asserts a chokepoint).

**Implications:**
- Manifest entries are data (`&[TmpPrefix]`), each with a prefix string and a kind (file/dir) — the sweep and the test share them.
- The scan is best-effort by design: it extracts string literals from `temp_dir().join(…)`/`format!` patterns; non-matching idioms are caught by review, not the test (documented in the test's comment).

#### [P04] Probes, then manifest — never a bare glob delete (DECIDED) {#p04-no-bare-globs}

**Decision:** The janitor never deletes by name-pattern alone: sockets must fail a connect probe, tmux servers must fail the registry test, data dirs must fail the registry/marker test; only manifest-prefixed, age-expired `$TMPDIR` files are removed on pattern+age.

**Rationale:**
- Honors the justfile's standing rationale for refusing the old `tugcast-ctl-*.sock` glob (it could have hit a live dev instance's socket) while still reclaiming the 9,833 dead ones.

**Implications:**
- The sweep is idempotent and safe to run at any moment, from any instance, on any worktree — which is what makes the wiring in [P06](#p06-call-sites) tenable.

#### [P05] `tugutil host sweep` = janitor + prune; prune survives unchanged (DECIDED) {#p05-sweep-composition}

**Decision:** Add `Sweep` to `InstanceCommands`' sibling surface as `tugutil host sweep` (flags: `--yes`, `--json`, `--quiet`); it runs the tugcore janitor (sockets, tmux, tmpdir litter, apptest data-only dirs) and then the existing bundle-missing prune pass. `prune` remains as-is for compatibility.

**Rationale:**
- One habit-forming verb for humans and recipes; existing scripts using `prune` keep working.
- Bundle-missing removals shell to `lsregister` and are interactive-confirm by default — CLI territory, not tugcast-startup territory.

**Implications:**
- `run_prune`'s discovery loop stays; sweep calls it with `yes=true` after the janitor passes. The janitor's own apptest-dir removal reuses `run_remove(id, false, /*data_only=*/true, /*yes=*/true)` semantics via a tugcore-side equivalent (registry-checked, `reap_instance_tmux`, `remove_dir_all`) so tugcast doesn't depend on tugutil.

#### [P06] Wire the sweep where work already happens (DECIDED) {#p06-call-sites}

**Decision:** Three call sites: (a) the `app-test` recipe replaces both `reap_orphan_tmux_servers` invocations with `tugrust/target/debug/tugutil host sweep --yes --quiet`; (b) tugcast startup spawns `tugcore::janitor::sweep_all` on a detached thread when `instance_id()` is set and `!is_apptest_id` (mirroring the `reconcile_catalog_ranks` gate); (c) `just reap` / `just reap apply` keep their names and delegate to `tugutil host sweep` ([P07](#p07-single-owner)) — no new `just sweep` verb.

**Rationale:**
- The recipe already runs its reaper "before the first spawn and in cleanup" — same slots, wider reach.
- Dev/release tugcast startup is the only routine event on a machine where app-tests never run; hooking it means the machine self-heals without ritual. `tuglaws/app-test-harness.md` already names this as the intended direction ("A registry-anchored *automatic* sweep at startup remains a possible future hardening").
- App-test instances must NOT startup-sweep (dozens per run, and mid-run sweeps of sibling instances are pure risk for no gain) — hence the `is_apptest_id` exclusion.
- Reusing `reap`'s name preserves the muscle memory and the `--help`/recipe docs people already know; a `just sweep` sitting beside a `just reap` is a coin flip at every invocation.

**Implications:**
- The justfile function `reap_orphan_tmux_servers()` is deleted, and so is `reap`'s ~110-line shell body (single owner, [P07]); the per-worktree `instance stop` loops in `cleanup()` and between files stay (they handle *live* stragglers, which the janitor deliberately skips).
- **The sweep must not acquire the app-test gate.** The recipe re-execs its entire body under `tugutil host gate run --name apptest` and then calls the sweep, so a gate acquisition inside the sweep would deadlock against its own caller. Safety at the call sites comes from [P10](#p10-age-floor), not from serialization — which is exactly the assumption [R04](#r04-mid-boot-race) shows the old shell reaper was silently relying on.

#### [P07] Both shell janitors are deleted; the Rust janitor is the only sweeper (DECIDED) {#p07-single-owner}

**Decision:** `reap_orphan_tmux_servers()` in the `app-test` recipe is removed, **and** the `reap` recipe's shell body (`Justfile:574–684`) is replaced by a delegation: `just reap` → `tugutil host sweep --json` (report), `just reap apply` → `tugutil host sweep --yes`. Neither is kept as belt-and-braces.

**Rationale:**
- `reap_orphan_tmux_servers`'s worktree-slug scoping (`grep -qv "^cc-${TUG_APPTEST_ID_PREFIX}-"`) is the *cause* of the permanent detached-worktree orphan; keeping an under-scoped duplicate invites drift and false confidence.
- `reap` is the opposite problem: its classification is *correct* (registry-cross-referenced, machine-wide) but it is manual, undiscoverable, and slow — `lsof` per socket over ~10k sockets is minutes, which is a large part of why nobody runs it. Porting it to a `connect()` probe makes it both more correct (see [P02](#p02-liveness-probes) on errno discipline; `lsof` cannot distinguish a saturated backlog either) and fast enough to run unattended.
- Leaving `reap` in place next to `tugutil host sweep` reproduces exactly the two-implementations-drift failure this decision exists to prevent ([R05](#risks)) — with the added hazard that the shell copy would be the one people's fingers know.

**Implications:**
- The recipe's comment blocks explaining both reapers move (condensed) onto the sweep calls so the isolation rationale isn't lost.
- `reap`'s data-dir section (report-only, deferring to `prune` because full removal can delete a shared bundle) is preserved by [P05](#p05-sweep-composition)'s composition: the janitor removes apptest data dirs, and bundle-missing full removals stay behind the interactive prune pass.
- `reap`'s "refusing to reap blind" guard on a failed registry read is ported into the janitor ([P02](#p02-liveness-probes)).
- `reap`'s process class is ported too, or it would be lost outright — see [P11](#p11-reparented-processes).

#### [P08] Fix leaks at the source; the sweep is a backstop (DECIDED) {#p08-source-fixes}

**Decision:** Every identified creator gets a lifecycle fix: TempDir-owned Rust test DBs, WAL/SHM-complete TS unlinks, harness-tracked tugbank/screenshot/tempdir/socket cleanup.

**Rationale:**
- Steady-state debris should be zero after a *clean* run; the janitor exists for SIGKILL residue and backlog, not as an excuse to keep littering.
- This is [L27] compliance ("Every acquisition returns its release; the shorter-lived party calls it on teardown"); the janitor is the backstop for the one case L27 cannot cover, where the releasing party is SIGKILLed before it reaches its release.

**Implications:**
- See steps 7–9; each has a measurable no-new-debris checkpoint.

#### [P09] Harness tmux fallback targets the private server (DECIDED) {#p09-harness-private-server}

**Decision:** The harness `wrappedKill` fallback `tmux kill-session -t cc-<instanceId>` (which addresses the *default* tmux server) is replaced with a kill against the instance's private server: `tmux -L tug-<fnv1a-token> kill-server`, with the FNV-1a 32-bit token computed in TS.

**Rationale:**
- Since the private-server scheme landed, instance sessions live on `tmux -L tug-<token>`, so the default-server kill is a no-op against current leaks; it only mattered pre-isolation.
- The fallback path is real: in a dash worktree there is no `~/.local/bin/tugutil` symlink, so the `tugutil host instance stop/remove` spawns throw and the tmux fallback is all that runs.

**Implications:**
- TS gains a tiny `fnv1a32` helper mirroring `tugcore::ports::fnv1a_32` and Swift's `InstanceConfig.shortToken` (same algorithm, `%08x` formatting); a unit-style assertion pins one known vector so the three implementations can't drift silently (e.g. token for `apptest-27b5400c-7d5e-4a9a-99a0-4f787deb6d80`, computable via `tugcore::instance::short_token_for` in a Rust test and hard-coded in the TS test).

#### [P10] A minimum-age floor under every registry-gated deletion (DECIDED) {#p10-age-floor}

**Decision:** Add `MIN_DEBRIS_AGE_SECS` (10 minutes) beside `TMP_DEBRIS_MAX_AGE_SECS`. No data dir, no tmux server, **and no socket** is a removal candidate unless its mtime is older than that floor, regardless of registry state.

*(Sockets were originally exempted here on the grounds that "a bound socket answers for itself." [#step-2](#step-2) measured otherwise — a saturated live listener answers exactly like a corpse — so the floor covers all three classes.)*

**Rationale:**
- A booting instance is invisible to the registry for a real interval — `write_bundle_path_marker()` runs near the top of tugcast startup, `registry::register` only after the port bind — so "no registry entry" is a *lagging* signal, unlike a socket probe which is instantaneous. See [R04](#r04-mid-boot-race).
- It costs nothing. Every population in the audit is hours to weeks old; a 10-minute floor reclaims all of it and forfeits only the ability to reap something that was created in the last ten minutes — which is precisely the thing most likely to be alive.
- It replaces a serialization assumption the old shell reaper depended on and the new call sites break, with a property that holds unconditionally at every call site.

**Implications:**
- `sweep_tmux_servers` and `sweep_apptest_data_dirs` each take the floor as a parameter (tests pass `Duration::ZERO` to exercise classification, and a real floor to prove a fresh fixture survives).
- The floor is why an *empty* `tug-*` server can still be reaped safely: a session-less server that has also sat untouched for ten minutes is not mid-boot.

#### [P11] Reparented tugcode/claude processes stay in scope (DECIDED) {#p11-reparented-processes}

**Decision:** Port `reap`'s process section (`Justfile:653–662`) into the janitor as `sweep_reparented_processes` — `tugcode`/`claude --…stream-json` processes whose PPID is 1 — rather than dropping the class when the shell body is deleted.

**Rationale:**
- It is the one class `reap` covers that the original janitor design missed; deleting the recipe body without porting it would be a net *loss* of coverage from a hygiene plan.
- PPID 1 is a genuine liveness-adjacent signal, not a heuristic: these binaries are always spawned as children of tugcast or the GUI host, so reparenting to launchd means the owner died. It is the process-world analogue of a socket with no listener.

**Implications:**
- SIGTERM, then SIGKILL after a grace interval, mirroring the shell version.
- The kill is by PID with a command-name recheck immediately before signalling — the identity-checked-kills discipline recorded in `tuglaws/app-test-harness.md`, which exists because a blind PID signal once let an app-test teardown SIGKILL a live debug instance's child.
- The age floor ([P10](#p10-age-floor)) applies here too, keyed on process start time: a `tugcode` reparented seconds ago may be mid-handoff.

---

### Deep Dives {#deep-dives}

#### The audited inventory {#audit-inventory}

**Table T01: Vestigial resource classes (2026-08-02 audit)** {#t01-inventory}

| Class | Location | Population | Creator | Cleanup that was supposed to run |
|---|---|---|---|---|
| Orphan instance data dirs | `~/Library/Application Support/Tug/instances/` | 188/201 dirs, 726 MB | tugcast per launch (`write_bundle_path_marker`, tugbank, sessions.db, Logs) | harness `wrappedKill` → `instance remove --data-only` (skipped on SIGKILL/launch-failure/custom-id paths); `prune` never invoked |
| Control sockets | `$TMPDIR/tugcast-ctl-<token>.sock` | 9,833 | `tugapp/Sources/ProcessManager.swift` (`tugcast-ctl-\(InstanceConfig.shortToken).sock`), `tugrust/crates/tugexec/src/main.rs` | graceful-close unlink only; the `app-test` recipe deliberately never sweeps them (`Justfile:1277–1286`), but `just reap apply` does, `lsof`-guarded (`Justfile:643–651`) — manual, and `lsof` over ~10k sockets is minutes |
| Test changes DBs | `$TMPDIR/tugcast-test-changes-<pid>.db{,-wal,-shm}` | 8,765 files, 146 MB | `tugrust/crates/tugcast/tests/common/mod.rs` (`TUG_CHANGES_DB` env in `TestTugcast::spawn`) | none |
| tugcode test tugbanks | `$TMPDIR/tugcode-test-tugbank-<ts>-<rand>.db{,-wal,-shm}` | 405 | `tugcode/src/__tests__/setup-tugbank.ts` | `process.on("exit")` unlinks the `.db` only — WAL/SHM always leak; whole triple leaks on hard kill |
| Harness test tugbanks | `$TMPDIR/tugapp-test-tugbank-<uuid>.db{,-wal,-shm}` | 373 | `tests/app-test/_harness/tugbank-helpers.ts::mkTempTugbank` | `rmTempTugbank` exists but is caller-discipline; many tests never call it |
| Screenshots | `$TMPDIR/tugapp-screenshot-<UUID>.png` | 130, 121 MB | `tugapp/Sources/TestHarness/TestHarnessConnection.swift` `screenshot` verb | none (Swift writes, TS reads, nobody deletes) |
| Harness sockets | `$TMPDIR/tugapp-test-<uuid>.sock` | 45 | `tests/app-test/_harness/index.ts::resolveLaunchOptions` | close-path + `process.on("exit")` unlink; SIGKILL of the harness leaks |
| Test tempdirs | `$TMPDIR/tug-at*-*/`, `at[0-9]*-*/`, `tug-probe-*/` | ~128 dirs | per-test `mkdtempSync` (e.g. `at9997-scratch-snippet-heavy-deck.test.ts`), `diag/deck-probes` | some tests `rmSync`; many don't |
| Orphan tmux servers | `${TMUX_TMPDIR:-/tmp}/tmux-<uid>/tug-*` | 1 live (20 h) + 14 dead socket inodes | tugcast per apptest instance (private `-L tug-<token>` server) | tugcast shutdown (`main.rs`, "tearing down ephemeral app-test tmux server") — skipped on SIGKILL; `reap_orphan_tmux_servers` can't reach other worktrees' slugs; `just reap apply` *can* (registry-cross-referenced) but is manual |
| Reparented processes | process table | not counted in the audit | `tugcode` / `claude --…stream-json` orphaned when their host dies | `just reap apply` only (`Justfile:653–662`) — manual; ported by [P11](#p11-reparented-processes) |

#### Why the existing mechanisms each miss {#why-mechanisms-miss}

**tugcast's tmux self-reap** (`tugrust/crates/tugcast/src/main.rs`, the shutdown block gated on `tugcore::ports::is_apptest_id` + `tmux_socket_label`) runs only when tugcast reaches its shutdown path. The harness teardown ladder (`tugutil host instance stop` → SIGTERM → 2 s → SIGKILL) usually lets it run, but a wedged tugcast, a `pkill -f "$APP_BIN"` backstop hit, or a crashed run gets SIGKILL and the server survives.

**The justfile reaper** (`reap_orphan_tmux_servers()` in the `app-test` recipe) iterates `${TMUX_TMPDIR:-/tmp}/tmux-$(id -u)/tug-*` and kills a server only when it has no sessions or *every* session matches `^cc-${TUG_APPTEST_ID_PREFIX}-` — the current worktree's slug (`apptest-<wtslug>`, minted a few lines earlier from `branch-slug.sh`; detached HEADs get `detached-<sha8>`). The observed orphan session `cc-apptest-detached-650da0c2` can only match a run whose `WTSLUG` is `detached-650da0c2` — i.e. the same detached checkout at the same commit, which no longer exists.

**`wrappedKill`** (`tests/app-test/_harness/index.ts`) already does the right per-launch teardown when it runs: `tugutil host instance stop`, then for ephemeral ids `tugutil host instance remove --data-only --yes` (whose `run_remove` calls `tugcore::instance::reap_instance_tmux`, killing the private server). It misses when: the harness itself is SIGKILLed; the launch fails before the App handle exists; the test passes `opts.instanceId` (cold-boot continuity — deliberately skipped, "instance prune collects those", except nothing ran prune); or `tugutil` isn't on PATH (dash worktrees — the bare-name spawn throws, and the surviving fallback targets the wrong tmux server, see [P09](#p09-harness-private-server)).

**`prune`** (`tugrust/crates/tugutil/src/commands/instance.rs::run_prune`) walks `tugcore::instances_root()`, reads each dir's `BUNDLE_PATH_MARKER`, and classifies: marker's bundle missing → full-removal orphan; bundle present + `is_apptest_id` + no live registry entry → data-only orphan. Correct, tested against reality (188 found), never called by anything except `reap`'s report-only section.

**`just reap`** (`Justfile:545–684`) is the mechanism the rest of this plan is built out of, and the one an implementer must read first. It is *not* under-scoped — it is the only existing sweeper that gets classification right:

- **tmux** (`Justfile:619–641`): for every `tug-*` socket, `tmux -L <label> list-sessions -F '#S'`, then `is_live "${s#cc-}"` against `tugutil host instance list`. Keeps a server iff one of its sessions names a *live registry instance* — worktree-independent, so it reaps other worktrees' and deleted worktrees' orphans alike. It also kills legacy default-server `cc-*` sessions the private-server scheme left behind. `tug-17a6924d` would have died on the first `just reap apply`.
- **sockets** (`Justfile:643–651`): `tugbank-notify-*.sock` and `tugcast-ctl-*.sock`, removed iff `lsof` reports no holder. Correct in principle; `lsof` per socket over 9,833 sockets is the practical reason this never runs, and `lsof` cannot distinguish a live-but-saturated listener any better than a naive probe can.
- **processes** (`Justfile:653–662`): PID-1-reparented `tugcode` / `claude … stream-json`, SIGTERM then SIGKILL. A class nothing else covers ([P11](#p11-reparented-processes)).
- **data dirs** (`Justfile:664–678`): report-only in both modes, deliberately deferring to `prune` because full removal can delete a shared app bundle. [P05](#p05-sweep-composition) preserves that split.
- **blind-reap guard** (`Justfile:589–594`): a failed `instance list` aborts rather than treating every instance as an orphan. Ported by [P02](#p02-liveness-probes).

Its failures are *invocation* failures, not logic failures: it is manual, it is `MODE`-flagged rather than defaulted, it is slow enough to discourage habitual use, and it covers none of the `$TMPDIR` test litter (24k files) or screenshot classes. That is the shape of the work — promote the logic, extend the coverage, remove the ritual.

#### Tmux sweep mechanics {#tmux-sweep-mechanics}

Candidates are socket files matching `tug-*` in `${TMUX_TMPDIR:-/tmp}/tmux-<uid>/` (note: this is a *different* directory from `$TMPDIR`; the registry lock and instance data live in `$TMPDIR`, tmux sockets under `/tmp/tmux-501/`). For each candidate label `L`:

1. `tmux -L L list-sessions -F '#S'` (via `tugcore::instance::tmux_bin()`).
2. Command errors / "no server running" → the socket is a dead inode → unlink it.
3. Sessions exist: if **any** session does not start with `cc-apptest-` → skip (dev/release/user server; `cc-debug-*`, `cc-release-*` never touched).
4. All sessions are `cc-apptest-*`: strip `cc-` to recover instance ids; if **any** id has a live registry entry (`registry::find_by_id` → `Some`) → skip (in-flight run).
5. Socket mtime younger than `MIN_DEBRIS_AGE_SECS` → skip ([P10](#p10-age-floor)).
6. Otherwise: `tmux -L L kill-server`, then unlink the socket file if it remains.

A server with zero sessions but a live process answers `list-sessions` with an empty list. It is reapable — but **only via rule 5**. The old shell reaper treated an empty server as reapable outright, and its comment (`Justfile:1255–1259`) is explicit that this is safe because *"the gate guarantees no other app-test run is live while we sweep"*. Under [P06](#p06-call-sites) the sweep also runs from tugcast startup, outside the gate, so that guarantee evaporates and the age floor is what replaces it. Do not carry rule 6 forward without rule 5.

**The socket directory must be passed to tmux, not just to the sweep.** `sweep_tmux_servers` takes the directory as a parameter for testability, but `tmux -L <label>` resolves its socket directory from the `TMUX_TMPDIR` environment variable — the parameter never reaches the child process. Every spawned `Command` must therefore carry `.env("TMUX_TMPDIR", <parent of the tmux-<uid> dir>)`, or a test pointed at a fixture directory will silently operate on the developer's real tmux servers. Two further constraints the fixture must satisfy: tmux requires the directory to be named exactly `tmux-<uid>` beneath `TMUX_TMPDIR`, and it refuses to use one that is not mode 0700 and owned by the calling uid.

#### `$TMPDIR` debris sweep mechanics {#tmpdir-sweep-mechanics}

For each manifest entry (List L01), glob `<tmp>/<prefix>*`; for each hit older than `TMP_DEBRIS_MAX_AGE_SECS` (24 h, by mtime): files are unlinked, dirs are `remove_dir_all`'d. Socket-kind entries (`.sock` suffixed classes) are **not** age-gated — they get the connect probe regardless of age. SQLite triples: the glob naturally catches `-wal`/`-shm` siblings since they share the prefix.

---

### Specification {#specification}

**Spec S01: `tugcore::janitor` public surface** {#s01-janitor-api}

```rust
// tugrust/crates/tugcore/src/janitor.rs

/// What one sweep pass removed (counts + byte estimates for reporting).
pub struct SweepReport {
    pub dead_sockets: Vec<PathBuf>,
    pub tmux_servers_killed: Vec<String>,   // socket labels
    pub tmux_sockets_unlinked: Vec<PathBuf>,
    pub tmp_files_removed: Vec<PathBuf>,
    pub tmp_dirs_removed: Vec<PathBuf>,
    pub apptest_data_dirs_removed: Vec<String>, // instance ids
    pub processes_killed: Vec<(i32, String)>,   // pid + command, [P11]
}

/// Kind discriminator for manifest entries.
pub enum TmpKind { File, Dir, Socket }

pub struct TmpPrefix { pub prefix: &'static str, pub kind: TmpKind }

/// The registered temp-artifact manifest (List L01). The sweep and the
/// enforcement test both consume this.
pub const TMP_PREFIXES: &[TmpPrefix];

/// Inert litter older than this is debris (nothing reads a test
/// artifact across a day-long gap).
pub const TMP_DEBRIS_MAX_AGE_SECS: u64 = 24 * 60 * 60;

/// Nothing younger than this is a candidate for a registry-gated
/// deletion — a booting instance is invisible to the registry until
/// after its port bind. See [P10] / [R04].
pub const MIN_DEBRIS_AGE_SECS: u64 = 10 * 60;

/// Individual sweeps — each takes explicit roots (and the age floor)
/// for testability; tests pass `Duration::ZERO` to exercise
/// classification and a real floor to prove fresh fixtures survive.
/// Whether a pass acts on its findings or only names them.
/// Classification is identical in both modes, so a report is an
/// honest preview of what an apply would do — which is what makes
/// `just reap` (report) / `just reap apply` real.
pub enum SweepMode { Report, Apply }

pub fn sweep_dead_sockets(tmp: &Path, min_age: Duration, mode: SweepMode) -> Vec<PathBuf>;
pub fn sweep_tmux_servers(tmux_dir: &Path, min_age: Duration, mode: SweepMode)
    -> (Vec<String>, Vec<PathBuf>);
pub fn sweep_tmp_debris(tmp: &Path, max_age: Duration, mode: SweepMode)
    -> (Vec<PathBuf>, Vec<PathBuf>);
pub fn sweep_apptest_data_dirs(instances_root: &Path, min_age: Duration, mode: SweepMode)
    -> Vec<String>;
pub fn sweep_reparented_processes(min_age: Duration, mode: SweepMode) -> Vec<(i32, String)>;

/// Production composition: binds real roots (std::env::temp_dir(),
/// ${TMUX_TMPDIR:-/tmp}/tmux-<uid>, tugcore::instances_root()) and the
/// real age constants.
pub fn sweep_all(mode: SweepMode) -> SweepReport;
```

`sweep_apptest_data_dirs` mirrors the prune data-only branch: dir name passes `is_apptest_id`, no live registry entry, dir mtime older than `min_age`, bundle marker's bundle still exists (bundle-missing dirs are left for `prune`'s full removal so LaunchServices bookkeeping isn't skipped); removal = `reap_instance_tmux(id)` + `remove_dir_all`. `sweep_tmux_servers` implements [#tmux-sweep-mechanics](#tmux-sweep-mechanics) using `tmux_bin()`, and **must set `TMUX_TMPDIR` on every spawned command** from `tmux_dir`'s parent, or the parameter is decorative. `sweep_dead_sockets` probes only manifest `Socket`-kind prefixes (`tugcast-ctl-`, `tugbank-notify-`, `tugapp-test-`) via `std::os::unix::net::UnixStream::connect`, unlinking on `ECONNREFUSED`/`ENOENT` and **keeping the file on every other errno** ([P02](#p02-liveness-probes)). `sweep_reparented_processes` implements [P11](#p11-reparented-processes): PPID 1, command matches `tugcode` or `claude … stream-json`, process older than `min_age`, command re-checked immediately before signalling.

Every registry-gated pass aborts (returning what it has, logging the error) if `registry::load` fails — a failed read is not an empty registry.

**Spec S02: `tugutil host sweep` CLI contract** {#s02-sweep-cli}

- `tugutil host sweep [--yes] [--json] [--quiet]`, added as a `Sweep` variant on **`HostCommands`** in `tugrust/crates/tugutil/src/cli.rs` (sibling of `Instance`/`Gate`) and dispatched from `tugrust/crates/tugutil/src/host.rs::dispatch`. It is **not** a member of `InstanceCommands` (a separate enum, declared in `commands/instance.rs`).
- Default (no `--yes`): print the would-remove report (same shape as prune's listing) and confirm once for the whole batch; `--json` prints the `SweepReport` as JSON and **removes nothing** (mirror of `prune --json`).
- Order: janitor passes first (`sweep_all`), then the existing bundle-missing prune pass (`run_prune`-equivalent with `yes` forwarded) so one verb covers everything `prune` covered.
- Exit 0 on success including nothing-to-do; nonzero only on I/O errors reading the roots.
- `--quiet` suppresses the per-item lines (keeps the one-line summary), for recipe use.
- Output is capped per section the way `reap` caps it (`Justfile:604–617`, `CAP=12` with a "… (cap reached; remaining items are still reaped)" line) so a 9,833-socket backlog doesn't bury the report — everything is still swept.
- `--json` implying report-only mirrors the local precedent set by `instance prune --json` ("Emit the orphan list as JSON without removing anything"), which is why format and dry-run are one flag here rather than two.

**Spec S03: manifest enforcement test** {#s03-enforcement-test}

A `#[test]` in `tugcore/src/janitor.rs` (`no_unregistered_tmp_prefixes`), patterned on `ledger_db.rs::no_ad_hoc_ledger_opens`: walk `tugrust/crates/**/*.rs` (skipping `target/`, `fixtures/`; **including** `tests/` — the biggest offender was a test harness), extract string literals from lines matching `temp_dir()`-adjacent joins (regex over source text for `temp_dir\(\)` or `std::env::temp_dir` within the statement, then literal segments of `join(format!("<lit>` / `join("<lit>`), and assert every extracted literal starts with a manifest prefix or an explicit in-test allowlist entry. The allowlist must carry **both** registry names — `tugcore::registry::REGISTRY_FILENAME` (`tug-instances.json`) and `REGISTRY_LOCKFILE` (`tug-instances.json.lock`) — which are *live state*, not debris; omitting the lockfile makes the test fail on `registry.rs` itself. The test's doc comment states the known limitation: literals built through variables escape the scan; review catches those.

**List L01: registered temp prefixes** {#l01-tmp-prefixes}

| Prefix | Kind | Creator |
|---|---|---|
| `tugcast-ctl-` | Socket | ProcessManager.swift / tugexec |
| `tugbank-notify-` | Socket | `tugcore::instance::notify_socket_path` |
| `tugbank-notify.sock` (exact) | Socket | same function's no-instance-id fallback — `notify_socket_path()` returns the bare `tugbank-notify.sock` when `short_token()` is `None`, which the dashed prefix does not match |
| `tugapp-test-` | Socket | harness `resolveLaunchOptions` (`.sock`) |
| `tugcast-test-changes-` | File | tugcast tests `common/mod.rs` |
| `tugcode-test-tugbank-` | File | `tugcode setup-tugbank.ts` |
| `tugapp-test-tugbank-` | File | harness `tugbank-helpers.ts` |
| `tugapp-screenshot-` | File | `TestHarnessConnection.swift` |
| `tug-at` | Dir | per-test `mkdtempSync(join(tmpdir(), "tug-atNNNN-"))` |
| `tug-probe-` | Dir | diag probes |
| `at` (constrained: `^at[0-9]{4}` in the sweep's dir matcher) | Dir | per-test `mkdtempSync(join(tmpdir(), "atNNNN-…"))` |

(`tugapp-test-` as Socket and `tugapp-test-tugbank-` as File overlap textually; the sweep matches longest-prefix-first so the tugbank files aren't probed as sockets.)

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tugrust/crates/tugcore/src/janitor.rs` | Sweep implementations, manifest, enforcement test |
| `tests/app-test/_harness/fnv1a.ts` | FNV-1a 32-bit token mirror for [P09] (or inline in `index.ts` if the harness prefers few files) |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `janitor` module + Spec S01 surface | mod/fns | `tugcore/src/janitor.rs` | registered in `tugcore/src/lib.rs` |
| `HostCommands::Sweep { yes, json, quiet }` | enum variant | `tugutil/src/cli.rs` (beside `Instance`/`Gate`) | Spec S02 — **not** `InstanceCommands` |
| `HostCommands::Sweep` dispatch arm | match arm | `tugutil/src/host.rs::dispatch` | routes to the new command impl |
| `run_sweep` | fn | `tugutil/src/commands/sweep.rs` (new; registered in `commands/mod.rs`) | Spec S02 |
| `run_prune` discovery reuse | refactor | `tugutil/src/commands/instance.rs` | expose the orphan-discovery loop so `sweep` can run it with `yes` forwarded, no behavior change to `prune` |
| startup sweep hook | thread spawn | `tugcast/src/main.rs` | beside the `reconcile_catalog_ranks` block; gate `instance_id().is_some() && !is_apptest_id(&id)`; log the report summary via `info!` |
| `reap_orphan_tmux_servers` deletion | recipe edit | `Justfile` (`app-test` recipe) | both call sites become `tugrust/target/debug/tugutil host sweep --yes --quiet` |
| `reap` recipe body deletion | recipe edit | `Justfile:574–684` | ~110 lines of shell → two delegating lines; the doc comment above it is rewritten to describe the Rust janitor's coverage ([P07]) |
| changes-DB TempDir | test fix | `tugcast/tests/common/mod.rs` | `TestTugcast` gains a held `tempfile::TempDir`; `TUG_CHANGES_DB` points inside it |
| `tempfile` dev-dependency | manifest edit | `tugcast/Cargo.toml` | **not currently present** in tugcast's `[dev-dependencies]` (tugcore has it); the TempDir fix does not compile without adding `tempfile = { workspace = true }` |
| resource-lifecycle table, sweep corollary, known-limitations bullet | doc edit | `tuglaws/app-test-harness.md` | [#step-11](#step-11) |
| WAL/SHM unlink | test fix | `tugcode/src/__tests__/setup-tugbank.ts` | exit handler removes `.db`, `-wal`, `-shm` |
| tracked tugbank temps | harness fix | `tests/app-test/_harness/tugbank-helpers.ts` | module-level registry of minted paths + `process.on("exit")` unlink-all; `rmTempTugbank` stays for eager cleanup |
| screenshot tracking | harness fix | `tests/app-test/_harness/index.ts` / `client.ts` | record every `screenshot()` result path on the App handle; unlink during `close()`/teardown; a keep-the-shot test copies it first |
| `testTmpDir()` | harness helper | `tests/app-test/_harness/index.ts` (exported) | `mkdtempSync` under a manifest prefix + auto-`rmSync` on exit; existing tests migrate opportunistically (not a bulk rewrite — the sweep catches stragglers) |
| private-server kill fallback | harness fix | `tests/app-test/_harness/index.ts::wrappedKill` | `tmux -L tug-<fnv1a32(instanceId)> kill-server` replacing the default-server `kill-session`; plus own-socket + notify-socket unlink after the SIGKILL branch |

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit (Rust)** | Sweep functions against fixture roots: planted dead/live sockets, fake instances trees, aged files | every janitor function |
| **Integration (Rust)** | Tmux sweep against a real throwaway `tmux -L` server under an overridden `TMUX_TMPDIR` | `sweep_tmux_servers` |
| **Drift Prevention** | `no_unregistered_tmp_prefixes`; FNV-1a cross-language vector pin | manifest, token math |
| **Delta assertion (shell)** | before/after counts around `cargo nextest run` and one app-test file | source-fix checkpoints |

Live-fixture survival is the load-bearing test shape ([R01](#r01-deleting-live-state)): every sweep test plants both a reapable and a live fixture and asserts the live one is untouched.

#### What stays out of tests {#test-non-goals}

- No app-test for the janitor itself — it has no app-visible behavior; Rust tests + shell delta checks are the honest layer (per the selective-run doctrine).
- No mocked-filesystem abstractions — sweeps run against real temp fixture trees (real code paths on real content).
- No test for `lsregister`/TCC side effects — unchanged code, covered by the existing `remove` path.

---

### Execution Steps {#execution-steps}

> **Commit after all checkpoints pass.** This rule applies to every step below.

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Janitor module: manifest + tmpdir debris sweep + enforcement test | done | `fc4666f45` |
| #step-2 | Janitor: dead-socket sweep | done | `5fd9aed6c` |
| #step-3 | Janitor: tmux-server sweep | done | `b911a6441` |
| #step-4 | Janitor: apptest data-dir sweep, reparented processes, `sweep_all` | done | `47ec273da` |
| #step-5 | `tugutil host sweep` CLI | done | `884077319` |
| #step-6 | Wire call sites: `Justfile` (both janitors deleted) + tugcast startup | done | `826ee9c9a` |
| #step-7 | Source fix: Rust test changes-DB TempDir | done | `b0f159826` |
| #step-8 | Source fix: TS tugbank temps (tugcode + harness) | done | `280b2b338` |
| #step-9 | Harness lifecycle: screenshots, testTmpDir, sockets, private-server fallback | done | `e3d05ff7f` |
| #step-10 | Integration checkpoint + backlog remediation | done | `14040b87d` |
| #step-11 | Amend `tuglaws/app-test-harness.md` | done | `7828237f5` |

#### Step 1: Janitor module: manifest + tmpdir debris sweep + enforcement test {#step-1}

**Commit:** `tugcore(janitor): temp-prefix manifest, age-gated tmpdir sweep, no_unregistered_tmp_prefixes`

**References:** [P01] Janitor in tugcore, [P02] Liveness probes, [P03] Prefix manifest, [P04] No bare globs, Spec S01, Spec S03, List L01, (#tmpdir-sweep-mechanics, #audit-inventory)

**Artifacts:**
- `tugrust/crates/tugcore/src/janitor.rs` with `TMP_PREFIXES`, `TmpKind`, `TmpPrefix`, `TMP_DEBRIS_MAX_AGE_SECS`, `MIN_DEBRIS_AGE_SECS`, `sweep_tmp_debris(tmp, max_age)`, `SweepReport` (all fields present; later sweeps fill them in across steps 2–4).
- `pub mod janitor;` registration in `tugcore/src/lib.rs`.

**Tasks:**
- [ ] Implement `sweep_tmp_debris`: for each `File`/`Dir` manifest entry, glob `<tmp>/<prefix>*` (the `at` entry additionally requires `^at[0-9]{4}` on the basename, per List L01), check mtime age ≥ `max_age`, unlink files / `remove_dir_all` dirs; `Socket`-kind entries are skipped here (step 2's probe owns them).
- [ ] Implement `no_unregistered_tmp_prefixes` per Spec S03, modeled line-for-line on `ledger_db.rs::no_ad_hoc_ledger_opens`'s walk at `tugcore/src/ledger_db.rs:333` (skip `target/`, `fixtures/`; **include** `tests/` — note the model test skips it, and the biggest offender lives there); allowlist `tug-instances.json`, `tug-instances.json.lock`, and the `tug-test-` tmux session prefix (not a temp *file*).
- [ ] Doc-comment the module with the audit numbers and the graceful-path-only root cause so the "why" survives.

**Tests:**
- [ ] Fixture tree: aged file/dir under each File/Dir prefix removed; fresh (< max_age) sibling kept; non-manifest name (`random-junk.txt`) kept; `at`-pattern constraint verified (`atelier-…` dir survives, `at0275-…` aged dir goes).
- [ ] Enforcement test passes on the current tree (it must — every known creator's prefix is in List L01).

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcore`
- [ ] Temporarily add `let _ = std::env::temp_dir().join(format!("tug-bogus-{}", 1));` to any tugcore fn, confirm `no_unregistered_tmp_prefixes` goes red, revert.

---

#### Step 2: Janitor: dead-socket sweep {#step-2}

**Depends on:** #step-1

**Commit:** `tugcore(janitor): connect-probed dead-socket sweep for ctl/notify/harness sockets`

**References:** [P02] Liveness probes, [P04] No bare globs, Spec S01, List L01, (#audit-inventory)

**Artifacts:**
- `sweep_dead_sockets(tmp)` probing `Socket`-kind manifest prefixes.

**Tasks:**
- [ ] For each `<tmp>/<prefix>*.sock` candidate: `UnixStream::connect`. Unlink **only** on `ErrorKind::ConnectionRefused` (`ECONNREFUSED`) or `NotFound` (`ENOENT`); on success drop the stream immediately and skip; **on any other errno keep the file** — `EAGAIN`/`ETIMEDOUT` is a live listener with a saturated backlog, not a corpse. Non-socket files matching a socket prefix (stat says not a socket) are left alone — longest-prefix-first ordering keeps `tugapp-test-tugbank-*` out of the `tugapp-test-` candidate set, but stat is the second gate.
- [ ] Include the exact-name `tugbank-notify.sock` candidate (List L01) alongside the `tugbank-notify-<token>.sock` family.
- [ ] Fill `SweepReport.dead_sockets`.

**Tests:**
- [ ] Plant a bound `UnixListener` socket and a dead socket file under `tugcast-ctl-` in a fixture tmp; sweep removes the dead one, leaves the live one; listener still accepts afterward.
- [ ] Plant a bound listener that is **never accepted from** and whose backlog is filled: the sweep must leave it alone. This is the load-bearing regression test — and the one that proved errno discipline insufficient, since the saturated listener returns `ECONNREFUSED`. It passes because of the age floor and the live-namespace check, not because of the errno.
- [ ] `tugapp-test-tugbank-x.db` in the fixture is untouched by the socket pass.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcore`

---

#### Step 3: Janitor: tmux-server sweep {#step-3}

**Depends on:** #step-1

**Commit:** `tugcore(janitor): reap dead apptest tmux servers machine-wide, registry-gated`

**References:** [P02] Liveness probes, [P07] Single owner, [P10] Age floor, Spec S01, Risk R01, Risk R04, (#tmux-sweep-mechanics, #why-mechanisms-miss)

**Artifacts:**
- `sweep_tmux_servers(tmux_dir, min_age)` implementing the 6-rule ladder in (#tmux-sweep-mechanics), using `tugcore::instance::tmux_bin()`.

**Tasks:**
- [ ] Enumerate `tmux_dir/tug-*` socket files; per label run `list-sessions -F '#S'`; classify per the ladder (dead socket → unlink; any non-`cc-apptest-` session → skip; any `cc-apptest-*` session whose id (name minus `cc-`) is registry-live → skip; socket younger than `min_age` → skip; else `kill-server` + unlink).
- [ ] **Set `TMUX_TMPDIR` on every spawned `Command`**, derived from `tmux_dir`'s parent. Without this the `tmux_dir` parameter is decorative: `tmux -L <label>` resolves its socket directory from the environment, so a test aimed at a fixture would operate on the developer's real servers.
- [ ] Carry the ladder's rule-5 rationale into a code comment — the empty-server rule is only safe *because* of the age floor now that the sweep runs outside the app-test gate ([R04](#r04-mid-boot-race)).
- [ ] Fill `SweepReport.tmux_servers_killed` / `tmux_sockets_unlinked`.

**Tests:**
- [ ] Integration test against a fixture tmux root. Construct it correctly or tmux will refuse it: a `TempDir` containing a subdirectory named exactly `tmux-<uid>` (from `libc::getuid`), mode 0700, owned by the caller; `TMUX_TMPDIR` is the TempDir, `tmux_dir` is the `tmux-<uid>` subdirectory. Start a real throwaway server `tmux -L tug-jtest1 new-session -d -s cc-apptest-janitor-test-<uuid>`; sweep with `min_age = ZERO` kills it (`tmux -L tug-jtest1 list-sessions` errors). Start `tmux -L tug-jtest2 new-session -d -s cc-debug-janitor`; sweep leaves it; kill it in teardown. Plant a bare dead file `tug-deadsock`; sweep unlinks it. (Guard with a tmux-availability skip mirroring how existing tugcast tests handle tmux.)
- [ ] Age-floor survival: the same `cc-apptest-*` server, freshly created, survives a sweep with the real `MIN_DEBRIS_AGE_SECS` — the [R04](#r04-mid-boot-race) regression test.
- [ ] Registry-live protection: not integration-testable without a registered instance — cover by unit-testing the classification function extracted pure (sessions list + live-id set + age in, decision out).

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcore`

---

#### Step 4: Janitor: apptest data-dir sweep, reparented processes, `sweep_all` {#step-4}

**Depends on:** #step-1

**Commit:** `tugcore(janitor): registry-gated data-dir + reparented-process sweeps; sweep_all composition`

**References:** [P01] Janitor in tugcore, [P05] Sweep composition, [P10] Age floor, [P11] Reparented processes, Spec S01, Risk R01, Risk R04, (#why-mechanisms-miss)

**Artifacts:**
- `sweep_apptest_data_dirs(instances_root, min_age)`; `sweep_reparented_processes(min_age)`; `sweep_all()` binding real roots and composing steps 1–4's passes into one `SweepReport`.

**Tasks:**
- [ ] Port the prune data-only branch's semantics (from `tugutil/src/commands/instance.rs::run_prune`): dir name `is_apptest_id` + `registry::find_by_id` returns `None` + dir mtime older than `min_age` + `BUNDLE_PATH_MARKER` reads to an **existing** bundle → `reap_instance_tmux(id)` then `remove_dir_all`. Marker-missing or bundle-missing dirs are left for `prune` (full removal owns LaunchServices).
- [ ] Comment the age floor at the call site with its reason ([R04](#r04-mid-boot-race)): `write_bundle_path_marker()` runs near the top of tugcast startup while `registry::register` waits on the port bind, so a booting instance looks exactly like an orphan for a real interval.
- [ ] Port `reap`'s process section (`Justfile:653–662`) as `sweep_reparented_processes`: `ps -eo pid,ppid,command`, PPID 1, command matches `tugcode` or `claude` with `stream-json`, start time older than `min_age`; SIGTERM, then SIGKILL after a grace interval; re-read the command for that PID immediately before signalling (identity-checked kills — a PID is recycled the instant its process dies).
- [ ] Bail out of the registry-gated passes if `registry::load` errors rather than treating every instance as an orphan — `reap`'s "refusing to reap blind" guard (`Justfile:589–594`).
- [ ] `sweep_all()` = tmp debris + dead sockets + tmux servers + apptest data dirs + reparented processes; real roots: `std::env::temp_dir()`, `${TMUX_TMPDIR:-/tmp}/tmux-<uid>` (via `libc::getuid`), `tugcore::instances_root()`; real age constants.

**Tests:**
- [ ] Fixture instances root: `apptest-dead-<uuid>` dir with a marker pointing at an existing dir-as-bundle and an aged mtime → removed; `debug-something` dir → kept; `apptest-nomarker-<uuid>` (no marker) → kept.
- [ ] Age-floor survival ([R04](#r04-mid-boot-race)): a freshly-stamped `apptest-booting-<uuid>` dir with a valid marker and no registry entry — the exact mid-boot signature — survives a sweep at the real `MIN_DEBRIS_AGE_SECS`.
- [ ] Process classification extracted pure (pid/ppid/command/age rows in, kill list out): PPID 1 `tugcode` → killed; PPID 1 `claude` without `stream-json` → skipped; PPID != 1 `tugcode` → skipped; fresh PPID 1 `tugcode` → skipped.
- [ ] `sweep_all` smoke: runs without panicking on the real machine roots (assert only that it returns; deletions on the dev machine are legitimate by definition of the gates — but keep this test `#[ignore]`d so CI/dev runs don't sweep as a side effect of testing).

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcore`

---

#### Step 5: `tugutil host sweep` CLI {#step-5}

**Depends on:** #step-2, #step-3, #step-4

**Commit:** `tugutil(host): add sweep — one janitor verb over sockets, tmux, tmpdir, data dirs`

**References:** [P05] Sweep composition, Spec S02, (#s01-janitor-api)

**Artifacts:**
- `HostCommands::Sweep { yes, json, quiet }` added in `tugutil/src/cli.rs` beside the existing `Instance(InstanceCommands)` / `Gate(GateCommands)` variants, with a match arm in `tugutil/src/host.rs::dispatch`, and `run_sweep` in a new `tugutil/src/commands/sweep.rs` registered in `commands/mod.rs`. Note `InstanceCommands` is a *different* enum living in `commands/instance.rs` — `sweep` is a sibling of `instance`, not a subcommand of it.
- Refactor of `run_prune` exposing its discovery so sweep can run the bundle-missing pass with `yes` forwarded (no behavior change to `prune` itself).

**Tasks:**
- [ ] Implement per Spec S02: `--json` reports without removing; default confirms once; `--yes --quiet` for recipes; run janitor passes then the bundle-missing prune pass.
- [ ] Cap per-section output at 12 items with a "remaining items are still swept" line, as `reap` does (`Justfile:604–617`) — a 9,833-socket backlog must not bury the report.
- [ ] `--help` text carries the audit-derived rationale in the style of `Prune`'s doc comment, and absorbs the `reap` recipe's doc comment (`Justfile:545–573`), which is where the "released vs reported-only" distinction is currently explained.

**Tests:**
- [ ] `tugutil host sweep --json` on a machine with nothing to reap prints a valid empty-ish JSON report and exits 0 (unit-test the report serialization; CLI smoke via checkpoint).

**Checkpoint:**
- [ ] `cd tugrust && cargo build -p tugutil && cargo nextest run -p tugutil`
- [ ] `tugrust/target/debug/tugutil host sweep --json | python3 -m json.tool`

---

#### Step 6: Wire call sites: `Justfile` (both janitors deleted) + tugcast startup {#step-6}

**Depends on:** #step-5

**Commit:** `just+tugcast(janitor): sweep from app-test recipe and dev/release startup; both shell reapers deleted`

**References:** [P06] Call sites, [P07] Single owner, [P10] Age floor, [R02](#risks) (startup cost), [R05](#risks) (janitor drift), (#why-mechanisms-miss)

**Artifacts:**
- `Justfile` `app-test` recipe: both `reap_orphan_tmux_servers` call sites (≈1275, ≈1306) replaced by `tugrust/target/debug/tugutil host sweep --yes --quiet`; the function (≈1261–1274) deleted; its isolation-rationale comment and the "No cross-instance socket sweep" block (≈1277–1286) condensed onto the call — the latter rewritten, since [P02](#p02-liveness-probes)/[P04](#p04-no-bare-globs) resolve rather than ignore its objection.
- `Justfile` `reap` recipe (545–684): doc comment rewritten to describe the Rust janitor's coverage; shell body replaced by `just reap` → `tugutil host sweep --json`, `just reap apply` → `tugutil host sweep --yes`. Keep the build-if-absent guard for `tugrust/target/debug/tugutil` (`Justfile:584–588`) — it is what makes the recipe work from a clean tree.
- `tugcast/src/main.rs`: after the `reconcile_catalog_ranks` block (≈98), when `instance_id().is_some() && !tugcore::ports::is_apptest_id(&id)`, `std::thread::spawn(|| { let r = tugcore::janitor::sweep_all(); info!(…summary…) })`.

**Tasks:**
- [ ] Justfile edits, preserving the surrounding cleanup ladder (the per-worktree `instance stop` loops stay — they stop *live* stragglers, which sweep deliberately skips).
- [ ] tugcast startup hook with the gate mirroring the local-model reconcile gate's reasoning (a test-spawned tugcast has no instance id → no sweep; an apptest instance never sweeps). The hook sits *before* this instance registers itself (`registry::register` is late in startup, gated on `actual_port`) — harmless, because `sweep_apptest_data_dirs` only considers `is_apptest_id` dirs and a dev/release instance is never its own candidate.
- [ ] Confirm no call site attempts to acquire the app-test gate ([P06](#p06-call-sites) — the recipe already holds it; acquiring it inside the sweep would deadlock).
- [ ] Note in the recipe comment that `pkill -f "$APP_BIN"` remains the registry-blind live-process backstop; sweep handles everything dead.

**Tests:**
- [ ] (covered by checkpoint — recipe and startup are glue)

**Checkpoint:**
- [ ] `cd tugrust && cargo build` (warnings are errors)
- [ ] `just app-test-select` still resolves; `rg -n 'reap_orphan_tmux_servers|lsof' Justfile` returns nothing
- [ ] `just reap` prints the report and changes nothing; `just --list` still shows `reap`
- [ ] Launch the debug app (`just app-debug` or existing flow), confirm the tugcast log line reporting the sweep summary appears once, and the app serves normally

---

#### Step 7: Source fix: Rust test changes-DB TempDir {#step-7}

**Commit:** `tugcast(tests): changes DB rides a per-spawn TempDir; nextest leaves TMPDIR clean`

**References:** [P08] Source fixes, Table T01, (#audit-inventory)

**Artifacts:**
- `tugcast/Cargo.toml`: add `tempfile = { workspace = true }` to `[dev-dependencies]` — **it is not there today** (tugcore has it, tugcast does not), so the change below will not compile without this.
- `tugcast/tests/common/mod.rs`: `TestTugcast` holds a `tempfile::TempDir`; `TUG_CHANGES_DB` env in `spawn` points at `<tempdir>/changes.db` instead of `std::env::temp_dir().join(format!("tugcast-test-changes-{}.db", pid))`.

**Tasks:**
- [ ] Add the dev-dependency, then the `TempDir` field (dropped with the struct → auto-removed, WAL/SHM included); keep the per-process-unique property (TempDir already guarantees it, better than the pid key which collides across sequential same-pid reuse anyway).
- [ ] Keep the `tugcast-test-changes-` manifest entry (backstop for SIGKILLed test binaries, where Drop never runs).

**Tests:**
- [ ] Existing tugcast integration tests are the test — they must still pass.

**Checkpoint:**
- [ ] `N_BEFORE=$(ls "$TMPDIR" | grep -c '^tugcast-test-changes-'); cd tugrust && cargo nextest run -p tugcast; N_AFTER=$(ls "$TMPDIR" | grep -c '^tugcast-test-changes-'); [ "$N_AFTER" -le "$N_BEFORE" ]`

---

#### Step 8: Source fix: TS tugbank temps (tugcode + harness) {#step-8}

**Commit:** `tugcode+apptest(tests): tugbank temp DBs unlink WAL/SHM and self-track for exit cleanup`

**References:** [P08] Source fixes, Table T01, (#audit-inventory)

**Artifacts:**
- `tugcode/src/__tests__/setup-tugbank.ts`: exit handler unlinks `tempDbPath`, `${tempDbPath}-wal`, `${tempDbPath}-shm` (currently `.db` only — the WAL/SHM siblings leak on every run because the DB is opened `journal_mode = WAL`).
- `tests/app-test/_harness/tugbank-helpers.ts`: `mkTempTugbank` records each minted path in a module-level set; a `process.on("exit")` hook runs `rmTempTugbank` over any still-registered path; `rmTempTugbank` de-registers.

**Tasks:**
- [ ] The two edits above; `rmTempTugbank` keeps its existing WAL/SHM-inclusive triple (it already handles them — the gap was callers never calling it).

**Tests:**
- [ ] `cd tugcode && bun test` passes; after the run `ls "$TMPDIR" | grep -c '^tugcode-test-tugbank-'` has not grown.

**Checkpoint:**
- [ ] `cd tugcode && bun test`
- [ ] TMPDIR delta counts for `tugcode-test-tugbank-` (before/after, as above)

---

#### Step 9: Harness lifecycle: screenshots, testTmpDir, sockets, private-server fallback {#step-9}

**Commit:** `apptest(harness): own the lifecycle of screenshots, tempdirs, and sockets; tmux fallback hits the private server`

**References:** [P08] Source fixes, [P09] Private-server fallback, Table T01, (#why-mechanisms-miss)

**Artifacts:**
- `tests/app-test/_harness/index.ts` (+ `client.ts` touchpoint): every `app.screenshot()` result path is recorded on the App handle and unlinked in `close()`/teardown (a test that wants to keep a shot copies it before close — note this in the method's doc comment, and check existing `screenshot()` call sites for any that read the file after close and adjust them to copy).
- Exported `testTmpDir(prefix?: string)` helper: `mkdtempSync` under `tug-at`-style manifest naming, auto-`rmSync`'d via `process.on("exit")`; doc-comment steers new tests to it (existing tests migrate opportunistically; the janitor's age gate catches stragglers — not a bulk rewrite).
- `wrappedKill`: after the existing `instance stop`/`remove` attempts, replace `tmux kill-session -t cc-<instanceId>` (default server — a no-op under the private-server scheme) with `tmux -L tug-<fnv1a32(instanceId)> kill-server`; additionally unlink this launch's `socketPath` and `$TMPDIR/tugbank-notify-<token>.sock` best-effort.
- `fnv1a32` TS helper mirroring `tugcore::ports::fnv1a_32` + Swift `InstanceConfig.shortToken` (`%08x` lower-hex), with a pinned-vector test: compute the expected token for a fixed id via a new one-line Rust assertion in `tugcore` (`short_token_for("apptest-27b5400c-7d5e-4a9a-99a0-4f787deb6d80")`) and hard-code the same vector in the TS test so the implementations can't drift.

**Tasks:**
- [ ] The four artifact edits; keep the harness convention that `setTimeout`/`process.kill` shims live in `_harness/` only.

**Tests:**
- [ ] TS unit test for `fnv1a32` against the pinned vector; Rust side gains the matching `assert_eq!` beside the existing `short_token_and_tmux_label_track_instance_id` test in `tugcore/src/instance.rs`.
- [ ] One app-test file run (pick any core-tier file, e.g. the harness smoke) with TMPDIR/socket delta counts as the leak assertion.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcore`
- [ ] `just app-test harness-smoke/smoke.test.ts` passes; before/after counts of `tugapp-test-*.sock`, `tugapp-screenshot-*`, `tugapp-test-tugbank-*` in `$TMPDIR` have not grown

---

#### Step 10: Integration checkpoint + backlog remediation {#step-10}

**Depends on:** #step-6, #step-7, #step-8, #step-9

**Commit:** `N/A (verification only)`

**References:** [P05] Sweep composition, [P06] Call sites, (#success-criteria, #audit-inventory)

**Tasks:**
- [ ] Run the full sweep for real on the accumulated backlog: `tugrust/target/debug/tugutil host sweep` (interactive — review the report before confirming; expected magnitudes from the audit: ~9.8k dead ctl sockets, ~180 orphan data dirs, ~19k tmpdir files, ≥1 tmux server if any orphan persists).
- [ ] Verify live surfaces survived: the running dev/release instance still serves; `tmux -L tug-<token-of-live-instance> list-sessions` still shows its session; registry unchanged; no live `tugcode`/`claude` was signalled.
- [ ] Re-run one `just app-test <file>` and confirm the no-new-debris success criteria end-to-end.
- [ ] Run `just reap` and confirm it reports through the new verb; run a dev-instance launch concurrently with a `tugutil host sweep --yes` and confirm the launch succeeds — the [R04](#r04-mid-boot-race) end-to-end check that the age floor holds under the real call sites.

**Tests:**
- [ ] `cd tugrust && cargo nextest run` (whole workspace, warnings-as-errors)

**Checkpoint:**
- [ ] `ls "$TMPDIR" | grep -c '^tugcast-ctl-'` ≈ number of live instances (each live instance keeps exactly its own socket)
- [ ] `ls ~/Library/Application\ Support/Tug/instances | wc -l` ≈ live + intact-bundle dev dirs only
- [ ] `just app-test harness-smoke/smoke.test.ts` green with flat before/after debris counts

---

#### Step 11: Amend `tuglaws/app-test-harness.md` {#step-11}

**Depends on:** #step-6, #step-10

**Commit:** `tuglaws(app-test-harness): probed cross-instance sweeps replace the no-sweep corollary; record the janitor`

**References:** [P02] Liveness probes, [P04] No bare globs, [P06] Call sites, [P10] Age floor, Table T01, (#audit-inventory)

**Context:** `tuglaws/app-test-harness.md` is the doc surface this plan changes, and the tuglaws preamble is explicit — *"Violating any law requires updating the design first — never silently diverge."* Three passages are affected, all in the isolation / resource-lifecycle sections:

**Tasks:**
- [ ] **The "No cross-instance file sweeps" corollary** currently reads that the recipe "does not glob-and-remove sockets across instances… not something to reap by reaching into another instance's namespace," and cites per-launch token uniqueness to argue an orphan is harmless. The audit's 9,833 sockets falsify "harmless." Rewrite it around the actual invariant, which is narrower and stronger than the old blanket ban: **a cross-instance sweep is permitted only when every deletion is gated by a signal a live resource passes** — a `connect()` probe for sockets, a registry lookup plus an age floor for tmux servers and data dirs. Keep the original ban on *unprobed* globs (the `tugcast-ctl-*.sock` glob that could reach a live dev instance is still forbidden, and that is what [P04](#p04-no-bare-globs) preserves).
- [ ] **The resource-lifecycle table's residual-risk column.** The notify- and control-socket rows claim "Crash → stale file; unique token, `$TMPDIR`-reaped. Bounded" — `$TMPDIR` does not reap them, which is how 9,833 accumulated. Correct both rows to name the real reclaim path (`tugutil host sweep`, automatic at dev/release startup and both ends of an app-test run). Add rows for the classes the table omits entirely: `$TMPDIR` test artifacts, screenshots, and instance data dirs.
- [ ] **The known-limitations bullet** that reads "A registry-anchored *automatic* sweep at startup remains a possible future hardening" — that is this work; close it and point at the janitor. In the same bullet, keep the out-of-band-worktree-deletion limitation but update it: `just reap` is no longer a hand-written shell remedial, it is the front end to the automatic sweeper.
- [ ] Record the mid-boot race and its floor ([R04](#r04-mid-boot-race)) as a durable gotcha in the same section — the next person to add a registry-gated deletion needs to know the registry is a lagging signal during startup, and *why* the old empty-tmux-server rule's gate rationale stopped applying.
- [ ] Note the identity-checked-kills discipline now extends to the reparented-process sweep ([P11](#p11-reparented-processes)); the section already states the rule for `instance stop`.

**Tests:**
- [ ] (documentation — no code)

**Checkpoint:**
- [ ] `rg -n 'possible future hardening' tuglaws/app-test-harness.md` returns nothing
- [x] `rg -n 'reaped. Bounded|does not glob-and-remove|the gate guarantees no other app-test run is live' tuglaws/app-test-harness.md` returns nothing **asserted** — each was a claim this plan falsifies (`$TMPDIR` does not reap sockets; the recipe now does sweep across instances, probed; the gate no longer covers every sweep). The one surviving occurrence is the deliberate historical note that *quotes* the gate rationale in order to retire it, which this step's own task list asks for. A grep cannot tell an assertion from a retraction; read the line.
- [ ] Every row of the resource-lifecycle table names a definite reclaim path, per the section's own standing rule that "the OS cleans it up eventually" is only acceptable for kernel-owned resources

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** A machine that stays clean: **one** janitor (`tugcore::janitor` / `tugutil host sweep`) — with both shell janitors deleted and `just reap` delegating to it — reclaiming every audited debris class behind liveness probes and an age floor, invoked automatically by the app-test recipe and dev/release tugcast startup; every known leak fixed at its creator; a manifest-enforcement test that keeps the next debris class from being invented unregistered; and the law doc updated to match.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] All Step 10 checkpoints pass (backlog reclaimed, live surfaces untouched, no-new-debris deltas flat).
- [ ] All Step 11 checkpoints pass (`tuglaws/app-test-harness.md` matches the shipped behavior).
- [ ] `rg -n 'reap_orphan_tmux_servers|lsof' Justfile` → no matches; `just reap` / `just reap apply` delegate to `tugutil host sweep`; no `just sweep` verb was added.
- [ ] Exactly one implementation of each sweep exists — `rg -n 'list-sessions' Justfile` → no matches ([R05](#risks)).
- [ ] `cd tugrust && cargo nextest run` green (includes `no_unregistered_tmp_prefixes` and all janitor tests).
- [ ] `cd tugcode && bun test` green.

**Acceptance tests:**
- [ ] Planted-fixture janitor suite (dead removed, live survives) — `cargo nextest run -p tugcore`.
- [ ] End-to-end app-test debris delta — Step 10 checkpoint.

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] Cross-language enforcement scan (see [Q01](#q01-ts-swift-enforcement)).
- [ ] Opportunistic migration of remaining `mkdtempSync` tests to `testTmpDir()`.
- [ ] Consider a periodic sweep (e.g. from the app's maintenance surface) if dev/release startups prove too infrequent on some machines.
- [ ] **Per-worktree app-test DerivedData** (`Tug-apptest-<wtslug>`) — the largest disk consumer of the lot and explicitly out of scope here (see #non-goals). Reclaiming it needs a different liveness signal than any class in this plan: worktree existence plus "no Xcode build in flight," neither of which the registry or a socket can answer. Worth its own small design.

| Checkpoint | Verification |
|------------|--------------|
| Janitor correctness | `cargo nextest run -p tugcore` (planted fixtures) |
| CLI contract | `tugutil host sweep --json \| python3 -m json.tool` |
| Wiring | app-test run leaves flat debris counts; tugcast startup logs one sweep summary; `just reap` delegates |
| Single owner | no `list-sessions` / `lsof` loop survives in the `Justfile` ([R05](#risks)) |
| Mid-boot safety | fresh-fixture survival tests (steps 3–4) + concurrent launch-during-sweep check (step 10) |
| Law doc | `tuglaws/app-test-harness.md` carries no falsified residual-risk claim ([#step-11](#step-11)) |
| Source fixes | TMPDIR before/after deltas around `cargo nextest run` / `bun test` / one app-test |
| Backlog | instances dir and ctl-socket counts drop to live-only after one confirmed sweep |
