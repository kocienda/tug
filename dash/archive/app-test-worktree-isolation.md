<!-- devise-skeleton v4 -->

## App-Test Worktree Isolation {#app-test-worktree-isolation}

**Purpose:** Make `just app-test` safe to invoke from multiple worktrees: each worktree builds, runs, and tears down its own app-test world, while a machine-wide gate serializes whole invocations — and the single Accessibility grant keeps working for every worktree, forever.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-06-09 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

The instance-isolation work separated dev, release, and worktree instances cleanly, but app-test still has exactly one identity. Two worktrees invoking `just app-test` concurrently destroy each other, on three fronts:

1. **One shared bundle.** `TUG_FORCE_BUNDLE_ID=dev.tugtool.app.apptest` → `PRODUCT_NAME=Tug-apptest` → DerivedData at `~/Library/Developer/Xcode/DerivedData/Tug-apptest` — the *same absolute path from every worktree* (`derived-data-path.sh` keys the leaf on `PRODUCT_NAME` alone). Worktree A's build or defensive re-sign clobbers the binary worktree B is running; B silently tests A's code.
2. **Unscoped kills.** The `app-test` recipe's clean-slate sweep, between-file straggler stop, and exit cleanup all match **any** `apptest-*` instance in the registry and `rm -rf` **all** `instances/apptest-*` data dirs. Worktree A executes worktree B's teardown mid-flight. (The recipe comment claiming "harness colleagues' parallel app-test runs are untouched" is false.)
3. **Unscoped tmux reaping.** `reap_orphan_tmux_servers` kills any `tug-*` server whose sessions are all `cc-apptest-*` — including the *live* server of another worktree's run.

And beneath the plumbing, physics: native gestures post via `CGEvent.post(tap: .cgSessionEventTap)` (`NativeEventHandlers.swift`) and lifecycle tests drive `NSApp.activate`/`deactivate`. Keyboard focus, frontmost window, and screen-coordinate clicks are **singleton resources of the login session** — two concurrent native-gesture runs interleave each other's input no matter how well files and ports are namespaced. Note that macOS does *not* prevent two same-bundle-id processes from running: single-instance enforcement lives in LaunchServices (`open`, Dock), and the harness execs the binary directly. Serialization must be ours.

The constraint that shaped the single identity: the AX/TCC grant is keyed on the bundle's **designated requirement (DR)** — bundle identifier + signing certificate. Per-worktree bundle *ids* would mint a new DR per worktree and demand a manual System Settings grant per dash. The unlock is that the DR does **not** include the bundle's path or filename: N copies of `Tug-apptest.app` in N DerivedData directories — different code, same id, same `Tug Dev` identity — all satisfy the one existing grant (`just app-test-grant`, once, ever).

#### Strategy {#strategy}

- **Fork the artifacts, keep the identity.** Per-worktree DerivedData (`Tug-apptest-<wtslug>`) so builds and re-signs never cross worktrees; bundle id, product name, and signing identity unchanged so the one AX grant covers everything ([P01]).
- **Scope the runtime identity.** Instance ids become `apptest-<wtslug>-<uuid>`; every destructive match in the recipe narrows from `apptest-*` to this worktree's prefix ([P02]). Sockets, ports, and tmux tokens already derive from the full id — no mechanics change.
- **Gate the whole invocation — with a port, not a file.** A machine-wide TCP **port gate** (`tugutil gate`) wraps the *entire* `just app-test` run — clean slate, build-if-missing, dist refresh, every file, exit cleanup. The mutex is `TcpListener::bind` on one well-known localhost port: exclusive by kernel construction, freed by the kernel on any process death including SIGKILL, no lock file anywhere. Waiters connect to the holder, read live holder metadata, and block until EOF (holder exit) — event-driven queueing with zero polling ([P03]).
- **Keep the scoped kills anyway.** The gate makes cross-run contact unlikely; the scoped sweeps make it *impossible* — a crashed run's later cleanup, or a human running cleanup by hand, can never reach another worktree's live instance ([P02] is defense-in-depth, not redundancy).
- Update `tuglaws/app-test-harness.md` so the isolation invariant gains the worktree dimension and the gate, and the false recipe comment dies.

#### Success Criteria (Measurable) {#success-criteria}

- Two worktrees invoking `just app-test <file>` at the same moment both complete green: the second waits (printing the holder's label and start time), then runs — neither kills the other's processes, wipes its data dirs, reaps its tmux server, or rebuilds/re-signs its bundle (verify: the two-worktree drill in #step-6).
- Each worktree's app-test bundle lives at `DerivedData/Tug-apptest-<wtslug>/…` and `codesign -dr -` reports the **same** designated requirement for both (verify: build in two worktrees, compare DR strings).
- Native-gesture tests pass in a *second* worktree without any new Accessibility grant (verify: `just app-test harness-smoke/smoke-native.test.ts` on a fresh dash with no System Settings visit).
- `grep` finds no remaining unscoped `apptest-*` destructive match in the `app-test` recipe (verify: recipe matches use `apptest-${WTSLUG}-`).
- A run killed with SIGKILL leaves the gate free for the next invocation — the kernel closes the listener with the process (verify: kill a gated run, start another, it acquires immediately).

#### Scope {#scope}

1. `derived-data-path.sh`: worktree-scoped leaf for forced-identity (app-test) builds.
2. Harness instance-id minting honors a worktree prefix; recipe exports it.
3. Recipe sweeps (data-dir wipe, instance stops, tmux reaper) scoped to the worktree prefix.
4. New `tugutil gate` subcommand (localhost port bind, live holder handshake, blocking + `--no-wait`) + gate-port reservation in `tugcore::ports`.
5. `just app-test` wrapped in the gate.
6. Documentation: `tuglaws/app-test-harness.md`, `tuglaws/code-signing-mac.md` pointer, `tests/app-test/README.md`, recipe comments.

#### Non-goals (Explicitly out of scope) {#non-goals}

- **True parallel native-gesture execution.** `CGEvent.postToPid` exists, but key-window state, the activation tests (at0004/at0005), and WebKit inactive-window behaviors make it a research project. The gate is the design, not a stopgap.
- **Per-worktree bundle ids.** Breaks the single AX grant — the central constraint.
- **A NO_AX fast lane** (protocol-only tests bypassing the gate). Their launches still flash windows and activation churn; gate everything first, measure later ([Q02]).
- Reworking `just reap` / `tugutil instance prune` (manual, registry-cross-referenced tools stay as they are; see [Q01] for DerivedData reclamation).

#### Dependencies / Prerequisites {#dependencies}

- The existing `Tug Dev` signing pipeline and the one-time `just app-test-grant` (already done on this machine).
- `tugutil` already present at `tugrust/target/debug/tugutil` for the recipe (it already shells to it for `instance list`/`stop`).
- `branch-slug.sh` for slug derivation (already used by `bundle-id-from-cwd.sh`).
- `tugcore::ports` for reserving the gate's well-known port alongside the existing dev/app-test windows. The gate itself needs only `std::net` — no new dependencies.

#### Constraints {#constraints}

- **The DR must not change.** Anything that alters bundle id or signing identity invalidates the grant. Only *paths* may vary per worktree.
- **Never signal a PID you cannot confirm is yours** (existing invariant — the scoped prefixes extend it, they don't replace identity-checked kills).
- **No cross-instance file sweeps** beyond the worktree's own prefix (existing invariant, now per-worktree).
- Socket names must stay within `sun_path` (~104 B) — unaffected: sockets key on the 8-hex FNV short token of the full id, not the id itself.
- tugcast's app-test tmux self-reap gates on the `apptest-` id *prefix* (`tugcast/src/main.rs`) — the new `apptest-<wtslug>-<uuid>` shape preserves that prefix; do not break it.

#### Assumptions {#assumptions}

- Two processes with the same bundle id can run concurrently when exec'd directly (true today; under the gate it should not occur for app-test, but nothing relies on the OS preventing it).
- No test file passes `opts.instanceId` explicitly today (verified by grep) — changing the default mint in `resolveLaunchOptions` covers all launches. Cross-launch continuity (cold-boot) reuses the resolved id via harness verbs, not via hardcoded ids.
- One slug per worktree is unique in practice (slug = branch slug; two checkouts of the *same branch* running app-test concurrently is out of scope — the gate still serializes them, and their builds share one DerivedData as today).

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

This plan uses explicit `{#anchor}` headings and rich `References:` lines per the skeleton contract. Plan-local decisions are `[P01]`…; open questions `[Q01]`…; specs `S01`; tables `T01`; risks `R01`.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Reclaiming per-worktree app-test DerivedData (DEFERRED) {#q01-deriveddata-reclaim}

**Question:** Should `tugutil dash join` / `dash release` remove the worktree's `DerivedData/Tug-apptest-<wtslug>` directory?

**Why it matters:** Each dash that runs app-test leaves a multi-GB DerivedData tree behind. Today nothing reclaims it automatically.

**Options (if known):**
- Hook removal into `dash join`/`release` (symmetric with tmux reaping there).
- Leave it manual (`just clean-*` / periodic `rm -rf DerivedData/Tug-apptest-*`).

**Resolution:** DEFERRED — disk, not correctness. Record the leak in the harness doc's lifecycle table (#step-5); revisit if dashes churn fast enough to hurt.

#### [Q02] NO_AX fast lane around the gate (DEFERRED) {#q02-noax-fast-lane}

**Question:** Should protocol-only tests (`skipAccessibilityPreflight: true`) bypass the gate?

**Why it matters:** They post no native events, so in principle they could run alongside a gated gesture run — but their app launches still create windows and activation churn that could perturb a gesture test in flight.

**Resolution:** DEFERRED — gate everything first ([P03]); measure whether the wait ever hurts before carving exceptions.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Gate wedged by a dead holder | high | low | Kernel closes the listener with the process — release is guaranteed on any death, including SIGKILL | a waiting run that never proceeds with no live holder |
| An unrelated process squats the gate port | med | low | Reserved in `tugcore::ports` (nothing tug-side hashes onto it); the waiter's handshake validates the holder's JSON greeting — a non-gate listener fails the handshake and the error names the port and culprit instead of waiting forever | handshake-failure errors in practice |
| Lingering `TIME_WAIT` from waiter connections delays rebind | low | low | `SO_REUSEADDR` on the bind (on macOS/BSD this does **not** permit two simultaneous listeners — that would take `SO_REUSEPORT`, which we never set) | bind failures right after holder exit |
| DerivedData proliferation eats disk | med | med | [Q01]; document in lifecycle table; manual `rm` works today | disk pressure |
| Slug edge cases (detached HEAD) | low | low | `branch-slug.sh` already handles detached (`detached-<sha8>` pattern in `bundle-id-from-cwd.sh`) | malformed instance ids |
| First app-test build per fresh dash is slow (no shared bundle) | low | high | Cost of correctness; build-if-missing means once per dash | — |

**Risk R01: A bare `bun test` outside the recipe escapes both gate and scoped sweeps** {#r01-bare-bun-test}

- **Risk:** A hand-rolled `bun test` (already banned by convention) would mint an unprefixed `apptest-<uuid>` that no worktree's scoped sweep reaps, and would run ungated.
- **Mitigation:** The harness default stays `apptest-<uuid>` only when the prefix env is absent; `just reap` (registry-cross-referenced) remains the remedial for orphans. The README already mandates `just app-test`.
- **Residual risk:** An ungated bare run can still race a gated one — same as today; unchanged exposure, narrower than before. Its mid-boot (still session-less) tmux server is also reachable by the gated run's empty-server reap branch — bounded, same class.

---

### Design Decisions {#design-decisions}

#### [P01] Per-worktree artifacts, single designated requirement (DECIDED) {#p01-artifacts-fork-identity-shared}

**Decision:** When `TUG_FORCE_BUNDLE_ID` is set, `derived-data-path.sh` keys the DerivedData leaf on the worktree as well: `Tug-apptest-<wtslug>` (slug from `branch-slug.sh`; `main` on main). Bundle id (`dev.tugtool.app.apptest`), `PRODUCT_NAME` (`Tug-apptest`), and the `Tug Dev` signing identity are unchanged.

**Rationale:**
- TCC keys the AX grant on the DR (identifier + certificate), which is **path-independent** — N bundles at N paths all inherit the one grant. This is the only split that gives isolation *and* preserves the grant.
- Per-worktree bundle ids would demand a manual grant per dash — unacceptable for ephemeral worktrees.

**Implications:**
- Every recipe that resolves the bundle through `derived-data-path.sh` (app-test, build-app, app-test-grant, clean-*) picks the change up for free; any hardcoded `DerivedData/Tug-apptest` path must be found and removed.
- Each worktree's first app-test run builds its own bundle (slow once per dash).
- DerivedData reclamation becomes per-worktree ([Q01]).

#### [P02] Worktree-scoped instance ids and surgically scoped sweeps (DECIDED) {#p02-scoped-ids-sweeps}

**Decision:** The recipe exports `TUG_APPTEST_ID_PREFIX=apptest-<wtslug>`; `resolveLaunchOptions` mints `${prefix}-<uuid>` when the env is present (unchanged `apptest-<uuid>` otherwise). All destructive recipe matches — pre-run data-dir wipe, between-file straggler stop, exit cleanup, tmux orphan reaper (`cc-apptest-<wtslug>-*`) — narrow to that prefix.

**Rationale:**
- Even under the gate, a crashed run's cleanup trap, or a human invoking cleanup logic by hand, must be physically unable to touch another worktree's live world. Scoping the matches makes cross-worktree kills impossible rather than merely unlikely.
- Ids keep the `apptest-` prefix so tugcast's tmux self-reap gate and the existing mental model ("apptest-* is a test instance") hold.

**Implications:**
- Sockets/ports/tmux tokens are untouched (they derive from the full id via the FNV short token).
- The harness change is one line in `resolveLaunchOptions` plus an env read; no test files change.
- `just reap` stays broad-but-registry-checked (manual remedial, unchanged).

#### [P03] One app-test invocation at a time, gated by a localhost port (DECIDED) {#p03-whole-run-gate}

**Decision:** A new `tugutil gate` subcommand wraps the **entire** `just app-test` invocation in an exclusive `TcpListener::bind` on one well-known localhost port (reserved in `tugcore::ports`). One invocation runs at a time machine-wide; others connect to the holder, read live holder metadata, and block until EOF (default), or fail fast with `--no-wait`. **No lock file** — this project does not use lock files.

**Rationale:**
- Native input (CGEvent session tap, app activation, key focus) is a login-session singleton — serialization is physics, not policy.
- Whole-invocation granularity (per the user's call) makes interleaving states unrepresentable: the clean slate, build, dist refresh, every file, and cleanup of one run complete before the next begins. Per-file interleaving was considered and dropped — fairness wasn't worth the state-space.
- Port binding is exclusive by kernel construction and kernel-released on **any** process death, including SIGKILL — no stale-lock state can exist. The harness law's own lifecycle table classes ports as the zero-residual-risk resource ("Reclaimed: OS on process exit. Residual: None").
- Holder metadata is served live by the holder's listener, so it can *never* be stale: if a waiter can read it, the holder is alive. Wait-for-release is event-driven (EOF on holder exit), not polled.
- Alternatives rejected: POSIX named semaphores don't release on holder death; robust pthread mutexes (`PTHREAD_MUTEX_ROBUST`) are not implemented on macOS; a Unix domain socket needs a filesystem path on macOS (no abstract namespace) — a file again; `launchd` labels have poor wrap-a-command ergonomics.

**Implications:**
- The gate is the *only* shared resource left between worktrees; everything else is fully forked.
- The gate port is **machine-global** (a TCP port, vs. the per-user scope a `$TMPDIR` lock would have had). For a single-GUI-session resource like CGEvent posting, machine-global is the more correct scope.
- The port must be reserved in `tugcore::ports` next to the existing windows so nothing else ever hashes onto it.
- A second worktree's quick test waits for a full sweep ahead of it (minutes). Acceptable; revisit via [Q02] only if it hurts in practice.

---

### Specification {#specification}

**Spec S01: `tugutil gate` CLI contract (port gate)** {#s01-gate-cli}

```
tugutil gate run --name <name> [--label <text>] [--no-wait] [--json] -- <cmd> [args…]
```

- **Acquire** = `TcpListener::bind("127.0.0.1:<gate-port>")`, where `<gate-port>` is the well-known port reserved for `<name>` in `tugcore::ports` (this plan reserves one name, `apptest`). `SO_REUSEADDR` is set (dodges `TIME_WAIT` lingering from waiter connections; on macOS/BSD it does not permit a second simultaneous listener). **No lock file exists anywhere in this design.**
- **While holding:** a background accept loop answers every incoming connection with one JSON greeting line — `{"gate":"<name>","label":…,"pid":…,"since":<iso8601>}` — and then holds the connection open. The main thread spawns `<cmd>` with inherited stdio and, on child exit, propagates the child's exit code. The listener (and every held connection) closes when the process exits — gracefully or SIGKILLed — so release is kernel-owned and unconditional.
- **On `EADDRINUSE`:** connect to the port and read the greeting.
  - Greeting parses and `gate` matches `<name>` → print one line to stderr — `gate '<name>' held by <label> (pid <pid>, since <since>) — waiting…` — then **block reading the open connection until EOF** (the holder exited), and loop back to the bind attempt. Event-driven; no polling.
  - Greeting missing/invalid → an unrelated process is squatting the port: exit non-zero naming the port and what was read. Never wait on a non-gate listener.
  - With `--no-wait`: print the holder info (JSON shape under `--json`) and exit non-zero immediately.
- Holder metadata is served **live by the holder**; it cannot be stale — readable metadata implies a live holder. The bound port is the sole source of truth for "held".

**Table T01: app-test resources, before → after** {#t01-resource-matrix}

| Resource | Today (shared/colliding) | After (keyed on) |
|---|---|---|
| DerivedData / `.app` bundle | `DerivedData/Tug-apptest` — one path for all worktrees | `DerivedData/Tug-apptest-<wtslug>` ([P01]) |
| Bundle id / signing / DR / AX grant | `dev.tugtool.app.apptest` + `Tug Dev` — one grant | **unchanged** — same DR, same single grant ([P01]) |
| Instance id / data dir / tugbank / registry | `apptest-<uuid>` (per launch, but swept by any worktree) | `apptest-<wtslug>-<uuid>`; sweeps match own prefix only ([P02]) |
| Sockets / ports / tmux token | derived from full id (already per-launch) | unchanged mechanics, new id input |
| tmux orphan reaper | any server with only `cc-apptest-*` sessions | only `cc-apptest-<wtslug>-*` ([P02]) |
| Input stream / activation / key focus | uncontrolled collision | `tugutil gate --name apptest` (localhost port bind, kernel-released) around the whole invocation ([P03]) |

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files (if any) {#new-files}

| File | Purpose |
|------|---------|
| `tugrust/crates/tugutil/src/commands/gate.rs` | `gate run` implementation (port bind + greeting protocol + EOF wait + spawn) |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| forced-id branch | script | `tugrust/scripts/derived-data-path.sh` | append `-<wtslug>` to leaf when `TUG_FORCE_BUNDLE_ID` set ([P01]) |
| `TUG_APPTEST_ID_PREFIX` read | const/env | `tests/app-test/_harness/index.ts` (`resolveLaunchOptions`) | mint `${prefix}-<uuid>` ([P02]) |
| `WTSLUG` export + scoped matches | recipe | `justfile` (`app-test`) | prefix every `apptest-*` destructive match; export id-prefix env ([P02]) |
| `reap_orphan_tmux_servers` | recipe fn | `justfile` (`app-test`) | match `cc-apptest-<wtslug>-` sessions only ([P02]) |
| gate wrap | recipe | `justfile` (`app-test`) | re-exec under `tugutil gate run --name apptest --label <wtslug>` ([P03]) |
| `GateCommands` / `run_gate` | enum/fn | `tugrust/crates/tugutil/src/cli.rs`, `commands/gate.rs` | Spec S01 |
| gate-port reservation (`apptest`) | const/fn | `tugrust/crates/tugcore/src/ports.rs` (or sibling) | well-known port outside the hashed windows ([P03]) |
| isolation section update | doc | `tuglaws/app-test-harness.md` | worktree dimension + gate; lifecycle table row for DerivedData ([Q01]) |
| grant note | doc | `tuglaws/code-signing-mac.md` | N bundles / one DR |
| procedure note | doc | `tests/app-test/README.md` | gate wait message, `--no-wait` |

---

### Documentation Plan {#documentation-plan}

- [ ] `tuglaws/app-test-harness.md` — "Instance isolation" gains the worktree dimension (T01 contents) and the gate; correct the recipe's false "parallel runs untouched" comment; lifecycle table gains the per-worktree DerivedData residual ([Q01]).
- [ ] `tuglaws/code-signing-mac.md` — one paragraph: the DR is path-independent; per-worktree bundles share the single grant.
- [ ] `tests/app-test/README.md` — what the gate wait message looks like; `--no-wait` behavior.

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Rust unit/integration (`cargo nextest run`)** | `gate run`: exclusivity (second acquirer blocks / `--no-wait` fails), exit-code propagation, release-on-kill, holder metadata shape | the new tugutil subcommand |
| **Shell checkpoints** | script outputs (`derived-data-path.sh` per worktree), recipe grep audits | per-step verification |
| **Live two-worktree drill** | the actual success criterion: concurrent invocations queue, both pass, nothing cross-killed | integration checkpoint (#step-6) |
| **Existing app-test suite** | regression — the single-worktree flow is unchanged in behavior | after recipe changes |

#### What stays out of tests {#test-non-goals}

- No mock-store / fake-DOM tests (banned). The gate is tested against real processes and a real bound port.
- No automated test that runs *two full app-test sweeps* concurrently in CI — the drill in #step-6 is a one-time falsifiable verification; routine regression is covered by the single-run suite plus the gate's Rust tests.

---

### Execution Steps {#execution-steps}

> Commit after all checkpoints pass.

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Worktree-scoped DerivedData | done | 2a498fbb |
| #step-2 | `tugutil gate` subcommand | done | 4c3af281 |
| #step-3 | Worktree-scoped instance ids (harness + recipe env) | done | 7fbb7f0f |
| #step-4 | Scope the recipe sweeps + wrap in the gate | done | e7170e1a |
| #step-5 | Documentation updates | done | 9c0c51ca |
| #step-6 | Two-worktree integration drill | done | (verification only) |

#### Step 1: Worktree-scoped DerivedData {#step-1}

**Commit:** `scripts(build): per-worktree DerivedData for forced-identity app-test builds`

**References:** [P01] (#p01-artifacts-fork-identity-shared), Table T01, (#context)

**Artifacts:**
- `derived-data-path.sh` forced-id branch appends `-<wtslug>` (via `branch-slug.sh`) to the leaf.

**Tasks:**
- [ ] In the `TUG_FORCE_BUNDLE_ID` branch of `derived-data-path.sh`, derive the worktree slug exactly as `bundle-id-from-cwd.sh` does (branch → `branch-slug.sh`, detached fallback) and emit `…/DerivedData/Tug-<suffix>-<wtslug>`.
- [ ] Audit for hardcoded `Tug-apptest` DerivedData paths (`grep -rn "DerivedData/Tug-apptest" justfile tugrust/scripts/ tests/`) and route any through the script.
- [ ] Confirm `app-test`'s `APP_DIR`, `build-app`, `app-test-grant`, and the relevant `clean-*` recipe all resolve through the script.
- [ ] One-time migration: remove the now-orphaned shared `~/Library/Developer/Xcode/DerivedData/Tug-apptest` (pre-change path; never used again) — by hand on this machine, and note it in the commit body so other machines know to do the same.

**Tests:**
- [ ] `TUG_FORCE_BUNDLE_ID=dev.tugtool.app.apptest bash tugrust/scripts/derived-data-path.sh debug` emits a slug-suffixed leaf on main and a different one on a dash worktree.

**Checkpoint:**
- [ ] On main: `TUG_FORCE_BUNDLE_ID=dev.tugtool.app.apptest just build-app` lands the bundle under `DerivedData/Tug-apptest-main/…`; `codesign -dr - <bundle>` DR string is byte-identical to the pre-change bundle's DR.
- [ ] `just app-test harness-smoke/smoke-native.test.ts` → `VERDICT: PASS` (grant still satisfied — no System Settings visit).

---

#### Step 2: `tugutil gate` subcommand (port gate) {#step-2}

**Commit:** `tugutil(gate): port-bind machine-wide gate with live holder handshake`

**References:** [P03] (#p03-whole-run-gate), Spec S01 (#s01-gate-cli)

**Artifacts:**
- `tugrust/crates/tugutil/src/commands/gate.rs`, CLI wiring in `cli.rs`/`main.rs`, gate-port reservation in `tugcore::ports`.

**Tasks:**
- [ ] Reserve the `apptest` gate port in `tugcore::ports` — a well-known constant outside every hashed window (document it in the ports module alongside the window map).
- [ ] Implement Spec S01: bind with `SO_REUSEADDR`; background accept loop serving the JSON greeting and holding connections open; spawn `<cmd>` with inherited stdio; propagate child exit code.
- [ ] Waiter path: connect on `EADDRINUSE`, parse the greeting, validate `gate` name; print the single stderr wait line; block on read-until-EOF; loop to re-bind. Invalid/missing greeting → fail with port + culprit detail (never wait on a non-gate listener).
- [ ] `--no-wait` and `--json` shapes per S01.

**Tests:**
- [ ] nextest: second acquirer with `--no-wait` against a held gate exits non-zero and reports the holder's label/pid/since from the live greeting.
- [ ] nextest: blocking acquirer proceeds after the holder exits (EOF wakeup, no polling sleep in the test); child exit code propagates (0 and non-0).
- [ ] nextest: SIGKILL the holder → a fresh acquirer binds immediately (kernel release; `SO_REUSEADDR` covers waiter-connection `TIME_WAIT`).
- [ ] nextest: a non-gate listener squatting the port → waiter exits non-zero with the handshake-failure error, does not block.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugutil -p tugcore` green, zero warnings.

---

#### Step 3: Worktree-scoped instance ids {#step-3}

**Depends on:** #step-1

**Commit:** `app-test(harness): worktree-prefixed instance ids via TUG_APPTEST_ID_PREFIX`

**References:** [P02] (#p02-scoped-ids-sweeps), Risk R01 (#r01-bare-bun-test), Table T01

**Artifacts:**
- `resolveLaunchOptions` env read; recipe exports the prefix.

**Tasks:**
- [ ] `resolveLaunchOptions`: when `TUG_APPTEST_ID_PREFIX` is set (validated shape `apptest-<slug>`), mint `${prefix}-${uuid}`; otherwise keep `apptest-<uuid>`. Update the adjacent doc comment.
- [ ] `app-test` recipe: derive `WTSLUG` (same derivation as Step 1) and export `TUG_APPTEST_ID_PREFIX="apptest-${WTSLUG}"`.

**Tests:**
- [ ] One app-test smoke run, then assert the spawned instance id in `tugutil instance list` output (captured during the run via the recipe's existing loop or the harness log) carries the `apptest-<wtslug>-` prefix.

**Checkpoint:**
- [ ] `just app-test harness-smoke/smoke.test.ts` → `VERDICT: PASS`; during the run, `tugutil instance list` (or the registry entry / a one-line recipe echo of the minted id) shows `apptest-<wtslug>-<uuid>` — the harness does not currently log the env, so observe via the registry or add the echo.
- [ ] `cd tests/app-test && bun x tsc --noEmit` clean.

---

#### Step 4: Scope the sweeps, wrap in the gate {#step-4}

**Depends on:** #step-2, #step-3

**Commit:** `just(app-test): worktree-scoped sweeps; whole-invocation gate via tugutil gate`

**References:** [P02] (#p02-scoped-ids-sweeps), [P03] (#p03-whole-run-gate), Spec S01, (#success-criteria)

**Artifacts:**
- `app-test` recipe: scoped matches + gate re-exec wrapper.

**Tasks:**
- [ ] Narrow every destructive match to the prefix: pre-run `rm -rf …/instances/apptest-${WTSLUG}-*`; the three `instance stop` loops match `apptest-${WTSLUG}-*`; `reap_orphan_tmux_servers` treats a server as ours only if its sessions are all `cc-apptest-${WTSLUG}-*`.
- [ ] Keep the **empty**-server reap branch broad (a session-less `tug-*` server cannot be attributed to a worktree) and document *why it is safe*: the gate guarantees no other app-test run is live during our sweeps. Without that comment an implementer will either scope it (wrongly, stranding true orphans) or not see what justifies the breadth.
- [ ] One-time migration note: pre-change unprefixed `instances/apptest-<uuid>` data dirs are invisible to the new scoped wipe — sweep them once by hand (`tugutil instance prune` / manual `rm`) and say so in the commit body.
- [ ] Wrap the whole recipe body in the gate: a re-exec guard at the top (`if [ "${TUG_APPTEST_GATED:-}" != 1 ]; then exec tugrust/target/debug/tugutil gate run --name apptest --label "${WTSLUG}" -- env TUG_APPTEST_GATED=1 just app-test {{FILES}}; fi`) so build-if-missing, dist refresh, all files, and the cleanup trap run under the lock.
- [ ] Fix the recipe comments: the clean-slate comment's "harness colleagues' parallel app-test runs are untouched" claim; document the gate at the recipe head.
- [ ] `app-test-build` inherits the gate via its `just app-test` call — verify no double-gating issue (the inner re-exec guard handles nesting; `build-app` from `app-test-build` runs *outside* the gate but targets this worktree's own DerivedData, which [P01] made private — acceptable; note it in the recipe comment).

**Tests:**
- [ ] With a long-running `just app-test <file>` in flight, a second invocation from the same checkout prints the wait line with the holder label, then runs to green after the first completes.
- [ ] `--no-wait` path exercised once by hand (`tugutil gate run --name apptest --no-wait -- true` while held → non-zero + holder info).

**Checkpoint:**
- [ ] `just app-test-smoke` → `VERDICT: PASS` (single-worktree behavior unchanged).
- [ ] `grep -n "apptest-\*\|apptest-'" justfile` shows no remaining unscoped destructive match in the `app-test` recipe.

---

#### Step 5: Documentation {#step-5}

**Depends on:** #step-4

**Commit:** `docs(app-test): worktree isolation + invocation gate in harness law`

**References:** [P01]–[P03], [Q01], [Q02], Table T01, (#documentation-plan)

**Tasks:**
- [ ] `tuglaws/app-test-harness.md`: extend "Instance isolation — the invariant" with the worktree dimension (T01), the gate paragraph (what it serializes, why physics demands it, and the port-bind mechanism — kernel-released, no lock file), and the lifecycle-table rows for per-worktree DerivedData ([Q01] residual) and the gate port (zero-residual, bounded to process).
- [ ] `tuglaws/code-signing-mac.md`: DR path-independence note (N bundles, one grant).
- [ ] `tests/app-test/README.md`: the wait message, `--no-wait`, and that concurrent invocations queue.

**Tests:**
- [ ] N/A (docs).

**Checkpoint:**
- [ ] Docs name every behavior shipped in Steps 1–4; the false "untouched" claim is gone (`grep -n "untouched" justfile tuglaws/app-test-harness.md` reads correctly).

---

#### Step 6: Two-worktree integration drill {#step-6}

**Depends on:** #step-4

**Commit:** `N/A (verification only)`

**References:** (#success-criteria), [P01]–[P03], Table T01

**Tasks:**
- [ ] Create a scratch dash (`tugutil dash create apptest-drill …`). In it and in the main checkout, launch `just app-test harness-smoke/smoke-native.test.ts` simultaneously.
- [ ] Observe: the second prints the wait line naming the first's slug; both finish `VERDICT: PASS`; `tugutil instance list` during the overlap never shows one worktree's sweep removing the other's instances; both bundles exist under their own `DerivedData/Tug-apptest-<wtslug>` with identical DR strings; no new Accessibility grant was needed for the dash.
- [ ] SIGKILL a gated run mid-flight; confirm the next invocation acquires the gate immediately and its own scoped cleanup leaves the other worktree's artifacts alone.
- [ ] Release the scratch dash.

**Tests:**
- [ ] The drill itself (falsifiable: any cross-kill, grant prompt, or wedged gate fails it).

**Checkpoint:**
- [ ] All success criteria in (#success-criteria) observed and recorded in the ledger.

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** Any number of worktrees can each build, run, and tear down their own app-test world under a single machine-wide invocation gate, with the one existing Accessibility grant covering all of them.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] Two-worktree drill passes end-to-end (#step-6).
- [ ] Single-worktree `just app-test-smoke` and the full sweep behave exactly as before (modulo the gate acquire, which is uncontended).
- [ ] `cargo nextest run` green (gate tests included); `bun x tsc --noEmit` clean in `tests/app-test`; zero warnings.

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] [Q01] DerivedData reclamation on `dash join`/`release`.
- [ ] [Q02] NO_AX fast lane around the gate, if gate waits ever hurt in practice.
- [ ] Drop the vestigial `--force` from the app-test launch path (noted in the harness law as harmless).

| Checkpoint | Verification |
|------------|--------------|
| Grant survives the artifact fork | `smoke-native` green in a fresh dash, no System Settings visit |
| No cross-worktree kills | drill: overlapping runs, registry observed |
| Gate is unwedgeable | SIGKILL holder → next acquirer proceeds |
