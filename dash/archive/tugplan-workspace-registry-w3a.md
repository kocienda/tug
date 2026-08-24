<!-- tugplan-skeleton v2 -->

## T3.0.W3.a — CLI rename + source-tree helper + dev-only gating (bootstrap kept) {#workspace-registry-w3a}

**Purpose:** Introduce a `resources::source_tree()` helper, route tugcast's internal resource lookups through it, gate dev-only code paths behind `#[cfg(debug_assertions)]`, and rename the `--dir` CLI flag to `--source-tree` as a transitional step. The W1 bootstrap workspace stays alive so daily development against Tug.app still shows git/filetree card content during T3.4.a → T3.4.b work.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-04-15 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

[T3.0.W2](./tugplan-workspace-registry-w2.md) landed per-session workspace binding on `spawn_session`. The wire now carries `project_dir` per card, `WorkspaceRegistry` refcounts workspaces via `get_or_create` / `release`, and `LedgerEntry` binds each session to a canonical `workspace_key`. But W2 deliberately left the W1 bootstrap `registry.get_or_create(&watch_dir, cancel.clone())` call in place — see [W2 Step 6 design notes](./tugplan-workspace-registry-w2.md#step-6). Three consequences leak out of that decision and need cleanup before the Tide card lands:

1. **CLI flag naming.** `tugcast --dir <path>` still names the W1 bootstrap workspace. Every day of ambiguity between "the workspace being watched" and "the tugtool source tree" costs developers cognitive load. Renaming `--dir` → `--source-tree` signals "this flag is transitional; it's going away when the Tide card lands."
2. **Source-tree path derivation is scattered.** Four callsites in tugcast (`resolve_tugcode_path`'s `.ts` fallback, `BuildStatusCollector`, `migrate_settings_to_tugbank`, `server.rs::dist_path`) all derive their paths from `cli.dir` / `watch_dir` on the assumption that the CLI flag *is* the tugtool source tree. That assumption is true today by accident (dev developers point `--dir` at the tugtool checkout) but becomes unsound the moment a second workspace exists. A small `resources::source_tree()` helper decouples the two: the CLI flag can become whatever we want, and the source tree is derived from the binary location (compile-time in dev, bundle-relative in release).
3. **Dev-only code is present in release builds.** `BuildStatusCollector` reads `target/`, the tugcode `.ts` fallback reads `tugcode/src/main.ts`, and `migrate_settings_to_tugbank` reads `.tugtool/deck-settings.json`. None of those paths exist in a production Tug.app bundle. The code compiles into release anyway because nothing `#[cfg]`-gates it. W3.a gates it.

W3.a does *all three* cleanups without removing the bootstrap workspace, so that every intermediate commit keeps Tug.app's daily development workflow fully green. The bootstrap deletion rides with [T3.4.c](./tide.md#t3-4-c-tide-card) in [W3.b](./tide.md#t3-workspace-registry-w3b), where the UI picker lands in the same commit and the first real `spawn_session` flow replaces the bootstrap as the source of workspace frames.

#### Strategy {#strategy}

- **Xcode copy phase + Swift env-var set first, then helper, then route, then rename.** Step 0 adds the `PBXCopyFilesBuildPhase` to `Tug.xcodeproj`, shrinks `Justfile::app`'s manual `cp` commands, AND sets `TUGCAST_RESOURCE_ROOT=Bundle.main.resourcePath` in `ProcessManager.swift` when spawning tugcast. After Step 0, a launched `Tug.app` publishes the env var even though nothing reads it yet. Step 1 lands `resources::source_tree()` (env var first, CARGO_MANIFEST_DIR fallback under `#[cfg(debug_assertions)]`). Step 2 routes the four callsites through it and applies dev-only gates on the three dev-only callsites. At Step 2 completion, `just app` tugcast reads `tugdeck/dist` from the bundle Resources, exercising the same code path release will. Step 3 renames the CLI flag. Step 4 is the integration checkpoint.
- **Single resolution path: `TUGCAST_RESOURCE_ROOT` env var, set by Tug.app at spawn time.** `resources::source_tree()` reads `TUGCAST_RESOURCE_ROOT` from its environment unconditionally. Tug.app's `ProcessManager.swift` sets that env var to `Bundle.main.resourcePath` when spawning tugcast. Debug `just app` and Release both exercise the *same* code path — tugcast reads from `Tug.app/Contents/Resources/`, populated by an Xcode `PBXCopyFilesBuildPhase`. This is the collapse: one codepath, one workflow, one way to break. Bundle layout bugs surface in debug immediately instead of hiding until ship day.
- **Fallback for standalone cargo runs and unit tests.** When `TUGCAST_RESOURCE_ROOT` is *unset*, debug builds fall back to walking `CARGO_MANIFEST_DIR` up three parents (the tugtool workspace root). This is the only `#[cfg(debug_assertions)]` branch in the helper and it only affects behavior when the env var is missing. Release builds with an unset env var *panic* at startup — no baked-in dev machine path leaks into production.
- **Do not touch `dev.rs`'s `DevState.source_tree` field.** A field with the same name already exists in `dev.rs` as part of dev-mode state management (user-facing CONTROL frame). The new `resources::source_tree()` helper is a different concept. Both can coexist; the compiler's module path (`resources::source_tree()`) disambiguates at callsites.
- **Keep `watch_dir` as the internal variable name for the bootstrap role.** The CLI field renames (`cli.dir` → `cli.source_tree`), but the local `let watch_dir = ...` in `main.rs` stays named `watch_dir` because it semantically reflects "the bootstrap workspace being watched," not "the source tree." This minimizes diff noise across files that read `watch_dir`.
- **Atomic CLI rename.** The `cli.dir` → `cli.source_tree` field rename, the `--dir` → `--source-tree` flag rename, the Tug.app Swift `ProcessManager.swift:558` update, the `cli.rs` test updates, and the README/doc updates all land in one commit (Step 3). The rule is: after Step 3, `git grep -- '--dir'` in tugcast/Tug.app contexts returns zero real references.

#### Success Criteria (Measurable) {#success-criteria}

- `cargo build --release -p tugcast` compiles clean under `-D warnings`. (verification: Step 4 checkpoint)
- `just ci` green: `cargo nextest run --workspace` + `bun test` + `cargo fmt --check`. (verification: Step 4 checkpoint)
- `just app` produces a `Tug.app` bundle where `Contents/MacOS/tugcast` exists (Xcode copy phase) AND `Contents/Resources/tugdeck/dist/index.html` exists. (verification: Step 0 checkpoint and re-verified in Step 4.)
- `rg -- '--dir' tugrust/crates/tugcast/src tugapp/Sources` returns zero real flag references. (verification: Step 4 grep)
- `rg 'AgentSupervisorConfig::project_dir' tugrust/crates/tugcast/src` returns zero real references. (W2 criterion re-verified.)
- Tug.app launches from `just app`, tugcast spawns from `Contents/MacOS/tugcast`, and the git/filetree cards show content from whatever directory `--source-tree` points at. Tugdeck UI loads (not a 404) because `server.rs::dist_path` resolves to `Contents/Resources/tugdeck/dist/`. (verification: manual smoke in Step 4.)
- `cargo expand -p tugcast --release 2>&1 | grep -c BuildStatusCollector::new` returns zero. (verification: Step 4 cfg-gate spot check.)

#### Scope {#scope}

1. Add a `PBXCopyFilesBuildPhase` to `tugapp/Tug.xcodeproj/project.pbxproj` that copies `tugcast`, `tugcode`, `tugutil`, `tugexec`, `tugrelaunch` from `tugrust/target/$(CONFIGURATION)/` into `Contents/MacOS/`, and copies `tugdeck/dist/` (as a folder reference) into `Contents/Resources/tugdeck/dist/`. Shrink `Justfile::app`'s manual `cp` commands accordingly. Update `tugapp/Sources/ProcessManager.swift` so that the tugcast spawn sets `TUGCAST_RESOURCE_ROOT=Bundle.main.resourcePath` in the child process environment.
2. New file `tugrust/crates/tugcast/src/resources.rs` with `pub(crate) fn source_tree() -> PathBuf`. Primary path: read `TUGCAST_RESOURCE_ROOT` env var. Fallback (dev-only, `#[cfg(debug_assertions)]`): walk `CARGO_MANIFEST_DIR` up three parents. Release with no env var: panic.
3. Route four callsites (`resolve_tugcode_path`'s `.ts` fallback, `BuildStatusCollector::new` in `main.rs`, `migrate_settings_to_tugbank` callsite in `main.rs`, `server.rs::dist_path`) through `resources::source_tree()`.
4. Apply `#[cfg(debug_assertions)]` gates on the three dev-only callsites: the `.ts` fallback branch inside `resolve_tugcode_path`, the `BuildStatusCollector` construction + feed registration block in `main.rs`, and the `migrate_settings_to_tugbank` call in `main.rs`. `server.rs::dist_path` is NOT gated — it works in both modes now that `Contents/Resources/tugdeck/dist/` is a real path.
5. Delete the `source_tree: Option<PathBuf>` parameter from `server.rs::build_app` and `run_server`. The frontend static serving pulls its path from `resources::source_tree()` internally, unconditionally.
6. Rename CLI: `cli.dir` field → `cli.source_tree`; clap `#[arg(long, default_value = ".")]` flag `--dir` → `--source-tree`; help text update in `cli.rs`.
7. Update `tugapp/Sources/ProcessManager.swift:558` to pass `--source-tree` instead of `--dir`.
8. Update `cli.rs` tests: `test_default_values`, `test_override_dir` (→ `test_override_source_tree`), `test_all_overrides`, `test_help_contains_flags` all must use the new name.
9. Update README, `tugutil worktree setup` scaffolding templates, and any developer setup notes that mention `tugcast --dir`.
10. Final integration checkpoint: run `just ci`, run `cargo build --release -p tugcast`, run `just app` and verify bundle layout, manual smoke Tug.app launched from the bundle, grep verifications.

#### Non-goals (Explicitly out of scope) {#non-goals}

- **Do NOT remove the W1 bootstrap `registry.get_or_create(&watch_dir, cancel.clone())` call in `main.rs`.** That deletion rides with [T3.0.W3.b](./tide.md#t3-workspace-registry-w3b) and [T3.4.c](./tide.md#t3-4-c-tide-card).
- **Do NOT touch `dev.rs::DevState.source_tree`.** That's a separate runtime concept. This plan only adds a module-level helper at `tugcast::resources::source_tree()`.
- **Do NOT touch `control.rs`'s `source_tree: Option<String>` field** on the `dev_mode` CONTROL frame. Different concept.
- **Do NOT delete `migrate_settings_to_tugbank` itself.** Just gate the callsite. Full deletion of the legacy migration path is a separate follow-up.
- **Do NOT implement per-workspace `BuildStatusCollector`.** That's a W3+ follow-up that replaces the dev-only chrome widget with a workspace-scoped feature. Tracked separately.
- **Do NOT codesign or notarize the bundle.** `just app` produces an unsigned Debug bundle; codesigning is a separate `just dmg` concern and outside W3.a scope.

#### Dependencies / Prerequisites {#dependencies}

- [T3.0.W2](./tugplan-workspace-registry-w2.md) fully closed out (✓ as of commit `bf19d683`).
- `just ci` green on the W2 tip (✓ verified in W2 closeout).

#### Constraints {#constraints}

- **Rust `-D warnings`:** the tugrust workspace treats warnings as errors via `tugrust/.cargo/config.toml`. Every intermediate commit must build clean in both dev and release.
- **No touching Swift's WebView theme loading.** `MainWindow.swift:154` reads `<root>/tugdeck/styles/themes/<theme>.css` from a Swift-managed sourceTree string. That path is orthogonal to tugcast's internal resources and is not part of W3.a's scope.
- **Tug.app must remain launchable under Xcode debug for the duration of W3.a.** If any intermediate commit breaks Tug.app's ability to spawn tugcast, the plan has broken a constraint.

#### Assumptions {#assumptions}

- Tug.app's `ProcessManager.spawnTugcast` flow is the *only* external consumer that passes `--dir` to tugcast. (Verified: grep of `tugapp/` found exactly one `--dir` callsite.)
- No test scripts, shell aliases, or CI workflows pass `tugcast --dir` on the command line. (Assumption — will be verified during Step 3's grep sweep.)
- `cargo expand --release -p tugcast` is an acceptable way to spot-check cfg gates without compiling a full release artifact for a manual end-to-end test. (If unavailable, fallback is reading the expanded module tree manually.)

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

This plan follows the shared skeleton at [tuglaws/tugplan-skeleton.md](../tuglaws/tugplan-skeleton.md). Execution steps cite decisions by ID (`[D01]`), specs by label (`Spec S01`), and deep-link anchors in parentheses (`(#strategy, #context)`).

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

None. The release-mode resource resolution was previously flagged as an open question; it is now pinned via [D01](#d01-source-tree-env-var) (env var as the single resolution path) and [D06](#d06-xcode-copy-phase) (Xcode copy phase + Swift env-var set), both landed in Step 0.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Missed `--dir` callsite breaks Tug.app launch | high | low | Exhaustive `rg -- '--dir'` across tugrust/ and tugapp/ in Step 3 before commit | Tug.app fails to spawn tugcast after Step 3 |
| `#[cfg(debug_assertions)]` gate left off a callsite, release compile fails | medium | medium | `cargo build --release -p tugcast` gate on Step 2 commit and again in Step 4 checkpoint | Release build fails with "cannot find `source_tree` in module" error |
| `dev.rs::DevState.source_tree` name collision with `resources::source_tree()` helper | low | low | Module path disambiguates (`crate::resources::source_tree()` vs `state.source_tree`); do not import `source_tree` as a bare name | Developer confusion in PR review, rename helper if it bites |
| Renaming `cli.dir` breaks a test that asserts exact help text | low | high | `cli.rs`'s `test_help_contains_flags` already asserts `"--dir"` specifically — update explicitly in Step 3 | Test failure during Step 3 |

**Risk R01: Tug.app Swift-side `--dir` callsite missed** {#r01-tugapp-callsite-missed}

- **Risk:** `ProcessManager.swift:558` currently passes `args += ["--dir", dir]`. If Step 3 renames the Rust CLI flag to `--source-tree` but misses this Swift callsite, Tug.app will crash on first tugcast spawn in the subsequent run.
- **Mitigation:** Update Swift in the same commit as the Rust CLI rename. Add a grep verification to the Step 3 checkpoint: `rg -- '--dir' tugapp/Sources` returns zero. Manual smoke: launch Tug.app under Xcode after commit, confirm tugcast spawns successfully.
- **Residual risk:** If a second Swift callsite exists outside `tugapp/Sources/` (e.g., a test script or launch configuration), the grep would still miss it. Tide.md's execution-order section already notes "Tug.app AppDelegate" as a candidate — need to double-check AppDelegate too.

**Risk R02: Dev-only callsite left ungated, fires in release** {#r02-release-gate-miss}

- **Risk:** If Step 2 fails to gate `BuildStatusCollector::new`, `migrate_settings_to_tugbank`, or the `.ts` tugcode fallback inside `#[cfg(debug_assertions)]`, the release binary will attempt to read paths that don't exist in a bundled Tug.app (`target/`, `.tugtool/deck-settings.json`, `tugcode/src/main.ts`). Result: runtime error, not compile error — harder to catch.
- **Mitigation:** Step 4 runs `cargo expand --release -p tugcast | grep BuildStatusCollector::new` (and equivalents for the other dev-only symbols). Zero matches means the cfg gate took. Run `cargo build --release -p tugcast` at the end of Step 2.
- **Residual risk:** Runtime-only errors in release tugcast that fire only on certain code paths. Mitigated by the Step 4 manual smoke of the built bundle.

**Risk R04: `TUGCAST_RESOURCE_ROOT` forgotten in the spawn environment** {#r04-env-var-spawn-miss}

- **Risk:** If Step 0's `ProcessManager.swift` change doesn't actually propagate `TUGCAST_RESOURCE_ROOT` into the spawned tugcast's environment (e.g., because `proc.environment = env` is overwritten later, or `env` is re-copied from `ProcessInfo.processInfo.environment` after the set), tugcast will fall back to `CARGO_MANIFEST_DIR` in debug and panic in release.
- **Mitigation:** Add a task in Step 0's checkpoint: launch `Tug.app`, then in Activity Monitor or by attaching to the running tugcast process, verify `TUGCAST_RESOURCE_ROOT` is set in its environment. Alternatively, add a `tracing::info!` log in tugcast's startup that prints the resolved `source_tree()` path and whether it came from the env var or the fallback.
- **Residual risk:** None significant — the verification is a one-time check at Step 0 close, and thereafter any failure surfaces immediately in `just app` manual smoke.

**Risk R03: `watch_dir` rename sprawl** {#r03-watch-dir-sprawl}

- **Risk:** A naive rename of `cli.dir` to `cli.source_tree` could tempt the implementer to also rename the downstream `watch_dir` variable throughout `main.rs`, creating a 30-line diff where a 5-line diff would do.
- **Mitigation:** [D03] explicitly decides: `watch_dir` stays as the internal variable name. Only the `Cli` struct field and the `--dir`/`--source-tree` flag rename.
- **Residual risk:** None — this is a discipline risk, and [D03] is clear.

---

### Design Decisions {#design-decisions}

#### [D01] `resources::source_tree()` reads `TUGCAST_RESOURCE_ROOT` — one path, one workflow (DECIDED) {#d01-source-tree-env-var}

**Decision:** The `resources::source_tree()` helper reads the `TUGCAST_RESOURCE_ROOT` environment variable unconditionally. Tug.app sets that env var to `Bundle.main.resourcePath` when spawning tugcast (via `ProcessManager.swift`). Debug `just app` and Release both set the env var to `Tug.app/Contents/Resources/`, and both run the same resolution code. There is no `#[cfg]` branching on the *primary* path — debug and release exercise the *same* line of code.

If the env var is unset — for example, `cargo run -p tugcast` standalone or `cargo nextest run -p tugcast` — debug builds fall back to walking `CARGO_MANIFEST_DIR` up three parents (the tugtool workspace root). This fallback is `#[cfg(debug_assertions)]`-gated so `env!("CARGO_MANIFEST_DIR")` never makes it into a release binary. Release builds with an unset env var panic at startup with a clear message: "TUGCAST_RESOURCE_ROOT must be set by Tug.app."

**Rationale:**
- **The collapse.** Two-arm cfg-branching creates a testing divergence: day-to-day `just app` exercises the debug arm, release is only exercised on ship day. With env-var driving, debug and release *are the same codepath*. Bundle layout bugs surface in debug the moment they land.
- **Xcode-idiomatic.** Tug.app already knows `Bundle.main.resourcePath`. Setting the env var at spawn time is the standard macOS pattern for passing bundle context to a spawned helper binary. We lean on what Xcode already does well instead of reinventing a bundle walk in Rust.
- **Standalone `cargo run` still works.** Unit tests and ad-hoc `cargo run -p tugcast` still function because the debug-only fallback kicks in. You don't need a bundle to develop.
- **No dev-machine paths in release binaries.** The `env!("CARGO_MANIFEST_DIR")` reference is inside a `#[cfg(debug_assertions)]` block, so the release binary carries no trace of the developer's filesystem.
- **Release with misconfigured env var fails loud, not silent.** A release tugcast spawned without `TUGCAST_RESOURCE_ROOT` panics at startup with an actionable message, rather than silently serving 404s.

**Implications:**
- `server.rs::build_app`'s ServeDir hookup is unconditional (no `#[cfg]` gate on the hookup itself).
- `BuildStatusCollector` construction + `migrate_settings_to_tugbank` call remain `#[cfg(debug_assertions)]`-gated — not because of the helper, but because `target/` and `.tugtool/deck-settings.json` don't exist in a bundled Tug.app's Resources directory regardless.
- The `.ts` tugcode fallback remains `#[cfg(debug_assertions)]`-gated (production Tug.app ships a compiled tugcode binary at `Contents/MacOS/tugcode`, never the `.ts` source).
- `ProcessManager.swift`'s tugcast spawn must set `TUGCAST_RESOURCE_ROOT` in the child process environment. This is part of Step 0's Swift update.
- Unit tests for `source_tree()` exercise the CARGO_MANIFEST_DIR fallback (because `cargo nextest` does not set the env var). Bundle-path resolution is verified via manual smoke in Step 4.

#### [D06] Xcode copy phase + `ProcessManager.swift` env-var set (DECIDED) {#d06-xcode-copy-phase}

**Decision:** Add a `PBXCopyFilesBuildPhase` to `Tug.xcodeproj` that copies `tugcast`, `tugcode`, `tugutil`, `tugexec`, `tugrelaunch` (sourced from `tugrust/target/$(CONFIGURATION)/`) into `Contents/MacOS/` and `tugdeck/dist/` into `Contents/Resources/tugdeck/dist/`. Pair this with a `ProcessManager.swift` change that sets `TUGCAST_RESOURCE_ROOT=Bundle.main.resourcePath` in the child process environment when spawning tugcast. Together these two changes make `just app` and release launch produce bundle-resolved `source_tree()` results by the *same* mechanism.

**Rationale:**
- The `just app` flow today builds tugcast/tugcode/etc. via cargo, then manually `cp`s them into `$APP_DIR/Contents/MacOS/` after xcodebuild finishes. Xcode's Copy Files build phase does the same thing declaratively, inside the Xcode build graph.
- Letting Xcode own the copies means the bundle is self-contained after `xcodebuild build` — no out-of-band script required — which is the prerequisite for `resources::source_tree()`'s env-var path to resolve to a real directory.
- `tugdeck/dist/` moves from "wherever the source tree happens to be" to a stable bundle-relative location. This is the change that makes `server.rs::dist_path` work in both modes.
- Setting the env var in Swift (rather than deriving it from `current_exe()` in Rust) means Tug.app owns bundle-context communication, which is the idiomatic macOS pattern. Rust tugcast doesn't have to know anything about `.app/Contents/` layout at all.

**Implications:**
- `Justfile::app` loses the manual `cp tugrust/target/debug/{tugcast,tugcode,tugutil,tugexec,tugrelaunch} "$MACOS_DIR/"` lines. The `bun run build` + `cargo build` prerequisites still run before xcodebuild, so the binaries and dist artifacts exist when the copy phase fires.
- The Xcode phase runs in both Debug and Release configurations, so `just app` (Debug) and `just dmg` (Release) both produce a fully-populated bundle.
- The copy phase uses a `PBXBuildFile`/`PBXFileReference` pattern with the source paths pointing into `$(SRCROOT)/../tugrust/target/$(CONFIGURATION)/` and `$(SRCROOT)/../tugdeck/dist/`. Xcode evaluates these at build time.
- `ProcessManager.swift`'s tugcast spawn block (around line 549 where `env` is built) sets `env["TUGCAST_RESOURCE_ROOT"] = Bundle.main.resourcePath`. This fires in both Debug and Release builds of Tug.app, so both exercise the env-var path in Rust.
- `server.rs::build_app` unconditionally wires ServeDir pointing at `source_tree().join("tugdeck/dist")`, which resolves to the bundle Resources in both debug and release.

#### [D02] CLI flag rename is transitional, not semantic (DECIDED) {#d02-cli-rename-transitional}

**Decision:** Rename `--dir` to `--source-tree` as a transitional name that will be deleted entirely in [T3.0.W3.b](./tide.md#t3-workspace-registry-w3b). The new name is mildly inaccurate — the flag continues to feed the W1 bootstrap `registry.get_or_create(&watch_dir, cancel.clone())` call, which is about the workspace being watched, not about the tugtool source tree — but the inaccuracy is deliberate: it signals to developers that this flag is on its way out.

**Rationale:**
- The alternative (keep `--dir`) leaves an ambiguous flag name in place for however long T3.4.a–c take to land, and every new developer has to re-learn that "`--dir` really means the workspace."
- The other alternative (introduce a clean new name like `--workspace`) creates a migration that would then need a *second* migration in W3.b when the flag goes away.
- Renaming to `--source-tree` aligns with the name the internal helper uses, making the deprecation story consistent: "this flag is the legacy name for the bootstrap workspace, and it's going away."

**Implications:**
- Docs must say "transitional; will be removed in T3.4.c."
- Developers running `tugcast --dir /path/to/checkout` after this commit lands get a clap error; there is no deprecation alias.
- Tug.app Swift must update in the same commit.

#### [D03] `watch_dir` internal variable name survives (DECIDED) {#d03-watch-dir-kept}

**Decision:** Only the `Cli` struct field (`cli.dir` → `cli.source_tree`) and the clap flag name (`--dir` → `--source-tree`) change. The local variable `let watch_dir = ...` in `main.rs` and downstream `watch_dir`-named parameters in feed constructors (e.g., `FileWatcher::new(watch_dir)`, `FilesystemFeed::new(watch_dir, ...)`) keep their names.

**Rationale:**
- `watch_dir` semantically reflects what the variable is: the directory being watched by the bootstrap workspace's feed bundle. Renaming it to `source_tree` would be a lie — it's not the tugtool source tree in any conceptual sense, it just happens to be the same path in practice during development.
- Renaming `watch_dir` throughout downstream code would balloon the diff from ~5 lines to 30+, most of them in feed constructors that have nothing to do with the CLI rename.
- The rename's real purpose is ergonomic signaling at the CLI surface. The internal plumbing stays stable.

**Implications:**
- Diff in `main.rs` is limited to: (a) `cli.dir` → `cli.source_tree` at the two callsites that read the field, (b) updating `cli.rs`.
- Readers of `main.rs` see `let watch_dir = cli.source_tree.clone();` — slightly surprising, but clarified by a one-line comment.

#### [D04] `server.rs::build_app` drops the `source_tree: Option<PathBuf>` parameter (DECIDED) {#d04-server-param-deletion}

**Decision:** `build_app` and `run_server` no longer take a `source_tree: Option<PathBuf>` parameter. The ServeDir hookup in `build_app` is unconditional (no `#[cfg]` gate) and the `dist_path` is computed internally via `resources::source_tree().join("tugdeck").join("dist")`.

**Rationale:**
- Today, `server.rs` threads `source_tree` as an `Option`, and every caller either passes `Some(watch_dir.clone())` or `None`. The "None" case is only used by unit tests. The real callsite in `main.rs` always passes `Some`. That's a plumbed-through parameter with a single production value.
- Moving the path derivation inside `build_app` shrinks the interface and keeps the static-serving concern local to `server.rs`.
- With [D06](#d06-xcode-copy-phase) landing the copy phase, both dev and release have a real `tugdeck/dist/` directory at the `source_tree()`-derived path. No `#[cfg]` gate needed on the ServeDir hookup.

**Implications:**
- All callers of `build_app` and `run_server` drop the `source_tree` argument.
- Tests that previously passed `None` now get an implicit ServeDir hookup pointing at the dev tugtool repo's `tugdeck/dist/`. If the dir doesn't exist at test time, ServeDir returns 404s — tests that don't exercise that path are unaffected. Spot-check in Step 2.

#### [D05] Release with missing env var panics loud; debug falls back to CARGO_MANIFEST_DIR (DECIDED) {#d05-env-var-missing-behavior}

**Decision:** If `TUGCAST_RESOURCE_ROOT` is unset at the time `resources::source_tree()` is called:
- **Debug builds** (`#[cfg(debug_assertions)]`) fall back to walking `env!("CARGO_MANIFEST_DIR")` three parents up, yielding the tugtool workspace root. This keeps `cargo run -p tugcast`, `cargo nextest run`, and ad-hoc developer invocations working without any bundle wiring.
- **Release builds** (`#[cfg(not(debug_assertions))]`) panic immediately with a clear message: `"TUGCAST_RESOURCE_ROOT must be set when tugcast is spawned from a Tug.app bundle"`. No silent fallback.

**Rationale:**
- A silent fallback in release would either hardcode a dev machine path (via `env!("CARGO_MANIFEST_DIR")` leaking into the release binary) or silently serve 404s. Both are worse than a panic.
- Cfg-gating the fallback means `env!("CARGO_MANIFEST_DIR")` never appears in the release binary's string table. `cargo expand --release -p tugcast | grep CARGO_MANIFEST_DIR` should return zero results (verifiable in Step 4).
- A release panic at startup with an actionable message is easy to diagnose: the developer sees "TUGCAST_RESOURCE_ROOT must be set" in the Tug.app log the moment they launch a misconfigured bundle.
- The debug fallback is a pure developer convenience — it turns off the instant you ship.

**Implications:**
- Release tugcast will not start unless spawned from a bundle that sets the env var. That's exactly what Tug.app does in Step 0.
- Running `./target/release/tugcast` directly (outside a bundle) will panic — acceptable, since release tugcast is only ever spawned by Tug.app.
- The fallback branch is the *only* `#[cfg]` in `resources::source_tree()`. The primary env-var read is unconditional.

---

### Deep Dives (Optional) {#deep-dives}

#### Callsite inventory — everywhere `cli.dir`/`watch_dir` currently flows through for source-tree purposes {#callsite-inventory}

Before writing the plan I audited every place in `tugrust/crates/tugcast/src/` where `cli.dir` or `watch_dir` feed a *source-tree-like* lookup (as opposed to a workspace-watching lookup). The four callsites listed in [#scope](#scope) are the complete set. For the record, here is each one with its current shape:

1. **`main.rs:284` — `resolve_tugcode_path(cli.tugcode_path.as_deref(), &watch_dir)`.** The second parameter is used inside `agent_bridge.rs::resolve_tugcode_path` to compute the `.ts` fallback path `watch_dir.join("tugcode/src/main.ts")`. W3.a removes this parameter; the fallback becomes `resources::source_tree().join("tugcode/src/main.ts")` inside a `#[cfg(debug_assertions)]` block (the `.ts` fallback is dev-only — production ships a compiled tugcode binary at `Contents/MacOS/tugcode`).

2. **`main.rs:222` — `let target_dir = watch_dir.join("target");`.** Feeds the `BuildStatusCollector::new(target_dir, ...)` constructor at `main.rs:257-259` and the feed registration that follows. W3.a wraps the whole construction + registration block in `#[cfg(debug_assertions)]` and computes `target_dir` as `resources::source_tree().join("target")`. This remains dev-only because `target/` doesn't exist in a bundled Tug.app.

3. **`main.rs:160` — `migration::migrate_settings_to_tugbank(&watch_dir, client)`.** Reads `<watch_dir>/.tugtool/deck-settings.json`. W3.a wraps the call in `#[cfg(debug_assertions)]` and changes the argument to `&resources::source_tree()`. Dev-only because production tugbank has no legacy flat-file settings to migrate.

4. **`main.rs:505` — `run_server(... Some(watch_dir), ...)`, threaded through `server.rs::build_app(..., source_tree, ...)`.** Used at `server.rs` to set up ServeDir for `<source_tree>/tugdeck/dist`. W3.a deletes the parameter and moves the ServeDir hookup inside `build_app` — **unconditionally**, no `#[cfg]` gate. In dev, `resources::source_tree().join("tugdeck/dist")` resolves to `<repo>/tugdeck/dist/`. In release, it resolves to `Tug.app/Contents/Resources/tugdeck/dist/` via [D06](#d06-xcode-copy-phase)'s copy phase. Both paths are real at runtime.

The bootstrap `registry.get_or_create(&watch_dir, cancel.clone())` at `main.rs:184` is **not** a source-tree callsite — it's a workspace-watching callsite, which is why the bootstrap stays alive in W3.a. It continues to read `&watch_dir` (which is `cli.source_tree` after the rename) as before.

#### Why not a feature flag instead of `#[cfg(debug_assertions)]`? {#why-not-feature-flag}

`debug_assertions` tracks the build profile exactly: `cargo build` enables it, `cargo build --release` disables it. A custom feature like `#[cfg(feature = "dev")]` would require every developer to remember to pass `--features dev` and every CI step to set it. `debug_assertions` is zero-ceremony and matches the "dev workflow vs production bundle" distinction exactly.

The tradeoff: `debug_assertions` is also disabled for `cargo build --release -p tugcast` runs that a developer might do to spot-check performance. Those runs lose BuildStatusCollector, but that's fine — BuildStatusCollector is a *chrome widget*, not a correctness feature. A release-mode perf test that doesn't show the build status widget is still a valid perf test.

---

### Specification {#specification}

> W3.a is mostly mechanical cleanup, so the Specification section is deliberately short. The interesting normative content is in [Design Decisions](#design-decisions).

#### `resources::source_tree()` signature and semantics {#source-tree-spec}

**Module:** `tugrust/crates/tugcast/src/resources.rs` (new)

**Environment variable:** `TUGCAST_RESOURCE_ROOT` — absolute path to a directory containing `tugdeck/dist/`. Set by Tug.app's `ProcessManager.swift` to `Bundle.main.resourcePath` (i.e., `Tug.app/Contents/Resources/`).

**Public API:**

```rust
pub(crate) fn source_tree() -> PathBuf {
    // Primary path: Tug.app set this via ProcessManager.swift.
    // Debug and release exercise the same code.
    if let Some(from_env) = std::env::var_os("TUGCAST_RESOURCE_ROOT") {
        return PathBuf::from(from_env);
    }

    // Fallback for standalone dev runs (cargo run / cargo nextest).
    // Cfg-gated so the env!() string never ships in release binaries.
    #[cfg(debug_assertions)]
    {
        return PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()   // crates
            .and_then(|p| p.parent())  // tugrust
            .and_then(|p| p.parent())  // tugtool root
            .expect("CARGO_MANIFEST_DIR has at least three ancestors")
            .to_path_buf();
    }

    #[cfg(not(debug_assertions))]
    panic!(
        "TUGCAST_RESOURCE_ROOT must be set when tugcast is spawned \
         from a Tug.app bundle. This is a Tug.app configuration bug."
    );
}
```

**Module declaration in `main.rs`:**

```rust
mod resources;
```

(Unconditional — no `#[cfg]` gate on the `mod` declaration.)

**Invariants:**
- Primary path (env var set) — returns the path Tug.app decided, whatever that is. Works identically in debug and release.
- Fallback path (env var unset, debug build) — returns the tugtool workspace root derived from `CARGO_MANIFEST_DIR`. Suitable for standalone `cargo run` and unit tests.
- Fallback path (env var unset, release build) — panics. No silent fallback.
- The returned path is stable for the life of the process (either the env var or `CARGO_MANIFEST_DIR` is a compile-time or early-process constant).

**Bundle-layout contract:** Callers assume that `source_tree().join("tugdeck/dist")` resolves to a directory containing `index.html`. Tug.app's `PBXCopyFilesBuildPhase` (see [D06](#d06-xcode-copy-phase)) is responsible for putting `tugdeck/dist/` under `Contents/Resources/`. The dev fallback satisfies the same contract because the tugtool repo has `tugdeck/dist/` under its root after `bun run build`.

#### CLI flag rename {#cli-rename-spec}

**Before:**

```rust
/// Working directory for the tmux session
#[arg(long, default_value = ".")]
pub dir: PathBuf,
```

**After:**

```rust
/// Workspace directory for the bootstrap file-tree/git feeds.
/// Transitional: this flag will be removed in T3.4.c when the Tide
/// card lands a real project picker at card-open time.
#[arg(long, default_value = ".")]
pub source_tree: PathBuf,
```

**Help text update:** The `long_about` block in `cli.rs` mentions `tugcast --dir /path/to/project`; update to `tugcast --source-tree /path/to/project`.

**No deprecation alias:** running `tugcast --dir /some/path` after this commit yields a clap error. The W3.b removal follows shortly; a 2-phase deprecation would be overkill.

#### Tug.app Swift update {#swift-update-spec}

**File:** `tugapp/Sources/ProcessManager.swift`

**Line 558 — before:**

```swift
if let dir = sourceTree {
    args += ["--dir", dir]
}
```

**Line 558 — after:**

```swift
if let dir = sourceTree {
    args += ["--source-tree", dir]
}
```

---

### Compatibility / Migration / Rollout (Optional) {#rollout}

- **Compatibility policy:** internal CLI; not a public API. Breaking the flag name is free.
- **Migration plan:** none for end users (Tug.app is the only consumer, updated in the same commit). Developers running `tugcast --dir` directly at the command line will need to update muscle memory; docs are updated in the same commit.
- **Rollout plan:** single commit for the rename, no feature gate. Atomic flip.

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New crates (if any) {#new-crates}

None.

#### New files (if any) {#new-files}

| File | Purpose |
|------|---------|
| `tugrust/crates/tugcast/src/resources.rs` | Module housing `pub(crate) fn source_tree() -> PathBuf`. Reads `TUGCAST_RESOURCE_ROOT` env var unconditionally; debug-only fallback to `CARGO_MANIFEST_DIR` walk; release panics if env var unset. |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `resources::source_tree` | fn | `tugrust/crates/tugcast/src/resources.rs` (new) | Primary: reads `TUGCAST_RESOURCE_ROOT` env var. Fallback (debug-only): `CARGO_MANIFEST_DIR` three parents up. Release + unset env var: panic. |
| `PBXCopyFilesBuildPhase` (new) | build phase | `tugapp/Tug.xcodeproj/project.pbxproj` | Copies `tugcast`, `tugcode`, `tugutil`, `tugexec`, `tugrelaunch` into `Contents/MacOS/` and `tugdeck/dist/` into `Contents/Resources/tugdeck/dist/`. Runs in both Debug and Release configurations. |
| `ProcessManager.swift` — tugcast spawn env | stmt | `tugapp/Sources/ProcessManager.swift` | Adds `env["TUGCAST_RESOURCE_ROOT"] = Bundle.main.resourcePath ?? ""` before `proc.environment = env`. |
| `Justfile::app` | recipe | `Justfile` | Drops the `cp tugrust/target/debug/{tugcast,tugcode,tugutil,tugexec,tugrelaunch}` lines; Xcode owns those copies now. |
| `Cli::source_tree` | field | `tugrust/crates/tugcast/src/cli.rs` | Renamed from `Cli::dir`. Type `PathBuf`, default `"."`. |
| `resolve_tugcode_path` | fn | `tugrust/crates/tugcast/src/feeds/agent_bridge.rs` | Loses `watch_dir: &Path` parameter. `.ts` fallback branch wrapped in `#[cfg(debug_assertions)]` and reads `resources::source_tree()`. |
| `build_app` | fn | `tugrust/crates/tugcast/src/server.rs` | Loses `source_tree: Option<PathBuf>` parameter. ServeDir hookup internal and unconditional (works in both dev and release). |
| `run_server` | fn | `tugrust/crates/tugcast/src/server.rs` | Loses `source_tree: Option<PathBuf>` parameter. |
| `main.rs` — BuildStatusCollector block | stmt range | `tugrust/crates/tugcast/src/main.rs` | Construction + feed registration wrapped in `#[cfg(debug_assertions)]`. `target_dir` pulled from `resources::source_tree().join("target")`. |
| `main.rs` — migrate_settings_to_tugbank call | stmt | `tugrust/crates/tugcast/src/main.rs` | Wrapped in `#[cfg(debug_assertions)]`. Arg changed to `&resources::source_tree()`. |
| `ProcessManager.swift:558` | stmt | `tugapp/Sources/ProcessManager.swift` | `"--dir"` → `"--source-tree"`. |

---

### Documentation Plan {#documentation-plan}

- [ ] Update `README.md` if it mentions `tugcast --dir <path>` anywhere (need a Step 3 grep).
- [ ] Update `tugutil worktree setup` scaffolding templates under `tugrust/crates/tugutil/src/commands/worktree/` if they mention `--dir`.
- [ ] Add a one-line comment in `cli.rs` noting that `--source-tree` is transitional and will be removed in T3.4.c.
- [ ] Update `cli.rs::long_about` block to say `--source-tree` instead of `--dir`.
- [ ] **Do NOT update tide.md** — tide.md already references the new name in the W3.a/W3.b sections landed in commit `3d785db7`.

---

### Test Plan Concepts {#test-plan-concepts}

W3.a is a refactor, not a feature. The test plan is "don't break what's already working."

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Bundle layout** | After Step 0: `just app` builds a bundle where the binaries are under `Contents/MacOS/` and `tugdeck/dist/` is under `Contents/Resources/`. Verified by `ls`. | Step 0, Step 4. |
| **Spawn-env propagation** | After Step 0: `TUGCAST_RESOURCE_ROOT` is present in the environment of the tugcast process spawned by Tug.app. Verified by inspecting the process env. | Step 0. |
| **Unit — env var path** | `test_source_tree_uses_env_var_when_set` — `source_tree()` respects `TUGCAST_RESOURCE_ROOT` regardless of build profile. | Step 1. |
| **Unit — fallback path (debug-only)** | `test_source_tree_fallback_points_at_tugtool_root` — with env var unset, debug returns the tugtool workspace root. | Step 1. |
| **CLI parser** | `cli.rs` existing tests (`test_default_values`, `test_override_dir`, `test_all_overrides`, `test_help_contains_flags`) all updated to use `--source-tree` instead of `--dir`. Add one new test: `test_old_dir_flag_rejected` asserts `tugcast --dir /foo` yields a clap error. | Step 3. |
| **Integration (dev build)** | `cargo nextest run --workspace` green after every step commit. `just ci` green at Step 4. | Steps 1–4. |
| **Release compile** | `cargo build --release -p tugcast` compiles clean under `-D warnings` at Steps 1, 2, 4. The `cargo expand --release | grep CARGO_MANIFEST_DIR` check in Steps 1 and 4 confirms the fallback is cfg-gated out. | Steps 1, 2, 4. |
| **End-to-end manual smoke** | After Step 4: launch the built `Tug.app` via `just app`. Confirm tugcast spawns, tugdeck UI loads **from the bundle Resources** (not the repo's `tugdeck/dist/` — verify by deleting `tugdeck/dist/` in the repo after the `just app` build and confirming the app still works). Git card shows current branch; filetree card populates. This is the "one pattern" verification: debug `just app` is exercising the same code path release would. | Step 4. |

---

### Execution Steps {#execution-steps}

> Execution comes last. Each step should be executable, with a clear commit boundary and a checkpoint. Commit after all checkpoints pass.

---

#### Step 0: Add Xcode copy phase + set TUGCAST_RESOURCE_ROOT in ProcessManager.swift {#step-0}

**Commit:** `build(tugapp): bundle binaries+tugdeck/dist and set TUGCAST_RESOURCE_ROOT`

**References:** [D01] env-var single-path, [D06] Xcode copy phase + Swift env-var set, Spec (#source-tree-spec), Risk R04 (#r04-env-var-spawn-miss)

**Artifacts:**
- Modified: `tugapp/Tug.xcodeproj/project.pbxproj` — new `PBXCopyFilesBuildPhase` section, new `PBXFileReference` entries for the binaries and `tugdeck/dist/`, updated `buildPhases` array on the `Tug` native target.
- Modified: `tugapp/Sources/ProcessManager.swift` — the tugcast spawn block sets `env["TUGCAST_RESOURCE_ROOT"] = Bundle.main.resourcePath` after the existing `env["PATH"] = ProcessManager.shellPATH` line (~line 550).
- Modified: `Justfile` — drop the `cp tugrust/target/debug/{tugcast,tugcode,tugutil,tugexec,tugrelaunch}` lines from the `app` recipe.

**Tasks:**
- [ ] Hand-edit `tugapp/Tug.xcodeproj/project.pbxproj` to add the copy phase. Use two phases or one — whichever Xcode prefers. The MacOS copies have `dstSubfolderSpec = 10` (Executables). The Resources copy uses `dstSubfolderSpec = 7` (Resources) with `tugdeck/dist/` as a folder reference (blue group reference, not yellow file group), so Xcode copies it recursively.
- [ ] File references for the five binaries point to `$(SRCROOT)/../tugrust/target/$(CONFIGURATION)/<name>` — Debug build resolves to `target/debug/`, Release to `target/release/`. The files don't exist at Xcode-project-read time; Xcode tolerates that as long as they exist by the time the copy phase runs. The `app` recipe runs `cargo build` before `xcodebuild`, which satisfies this.
- [ ] File reference for `tugdeck/dist/` points to `$(SRCROOT)/../tugdeck/dist`. The `app` recipe runs `bun run build` before `xcodebuild`, satisfying this.
- [ ] Add the new phase to `PBXNativeTarget.buildPhases` after the existing `Resources` phase (or as its own phase — Xcode doesn't care about ordering between Resources and Copy Files, but put it last for clarity).
- [ ] `ProcessManager.swift`: in the tugcast spawn block (around line 544 where `let proc = Process()` is constructed), after `env["PATH"] = ProcessManager.shellPATH`, add `env["TUGCAST_RESOURCE_ROOT"] = Bundle.main.resourcePath ?? ""`. The empty-string fallback is a belt-and-suspenders: `Bundle.main.resourcePath` is documented to return non-nil for a running app.
- [ ] Drop the manual `cp` lines from `Justfile::app` — lines 79–83. Keep `tugbank write dev.tugexec.app source-tree-path "$(pwd)"` because it's unrelated to the copy phase.
- [ ] Do NOT remove the `open "$APP_DIR"` / `tugrelaunch` lines — those still launch the bundle.

**Tests:**
- [ ] Visual: Open `Tug.xcodeproj` in Xcode and confirm the new Copy Files build phase appears in the Tug target's Build Phases list with the five binaries and the `tugdeck/dist` folder.
- [ ] `xcodebuild -project tugapp/Tug.xcodeproj -scheme Tug -configuration Debug -destination 'platform=macOS,arch=arm64' build` succeeds (after a prior `cd tugrust && cargo build -p tugcast -p tugcode -p tugutil -p tugexec -p tugrelaunch` and `cd tugdeck && bun run build`).

**Checkpoint:**
- [ ] `just app` succeeds end-to-end.
- [ ] `ls "$APP_DIR/Contents/MacOS/"` shows `Tug`, `tugcast`, `tugcode`, `tugutil`, `tugexec`, `tugrelaunch`. (Capture `APP_DIR` from the recipe output.)
- [ ] `ls "$APP_DIR/Contents/Resources/tugdeck/dist/"` shows `index.html` and the built tugdeck assets.
- [ ] Launching Tug.app still works. *(Tugcast at this point doesn't read `TUGCAST_RESOURCE_ROOT` yet — Step 1 introduces the helper. Step 0 only establishes that the env var is set in the spawn environment.)*
- [ ] Verify the env var actually reaches the spawned process. Launch `Tug.app`, then `ps -E -p $(pgrep -x tugcast)` (or a `tracing::info!` hook after Step 1) to confirm `TUGCAST_RESOURCE_ROOT=<bundle-resource-path>` is present in tugcast's environment. See Risk [R04](#r04-env-var-spawn-miss).
- [ ] `git status` shows changes to `tugapp/Tug.xcodeproj/project.pbxproj`, `tugapp/Sources/ProcessManager.swift`, and `Justfile` only.

---

#### Step 1: Add `resources.rs` module with env-var-driven `source_tree()` helper {#step-1}

**Depends on:** #step-0

**Commit:** `feat(tugcast): add resources::source_tree() helper (env var + dev fallback)`

**References:** [D01] env-var single-path, [D05] release panic + debug fallback, Spec (#source-tree-spec), (#strategy)

**Artifacts:**
- New file: `tugrust/crates/tugcast/src/resources.rs` (~40 lines including unit tests).
- One-line module declaration in `main.rs` (or `lib.rs`): `mod resources;` — unconditional.

**Tasks:**
- [ ] Decide whether `resources` is declared in `lib.rs` or `main.rs`. (Check first — tugcast has both. The declaration goes wherever it can be reached by `resolve_tugcode_path` etc.)
- [ ] Create `tugrust/crates/tugcast/src/resources.rs` with `pub(crate) fn source_tree() -> PathBuf` implementing Spec (#source-tree-spec): env var read first, then `#[cfg(debug_assertions)]` fallback to `CARGO_MANIFEST_DIR` walk, then `#[cfg(not(debug_assertions))]` panic.
- [ ] Add `mod resources;` declaration in the parent module.

**Tests:**
- [ ] Unit test `test_source_tree_uses_env_var_when_set` — sets `TUGCAST_RESOURCE_ROOT=/tmp/test-root`, calls `source_tree()`, asserts the returned path equals `/tmp/test-root`. Uses `serial_test::serial` (or an equivalent guard) because env var mutation is not thread-safe with other tests.
- [ ] Unit test `test_source_tree_fallback_points_at_tugtool_root` (dev-only, `#[cfg(debug_assertions)]`) — removes `TUGCAST_RESOURCE_ROOT` from the environment, calls `source_tree()`, asserts the returned path has a `Cargo.toml` child (sanity check that the three-parent walk reached the workspace root).
- [ ] Unit test `test_source_tree_fallback_is_absolute` — fallback path is absolute.

**Checkpoint:**
- [ ] `cd tugrust && cargo build -p tugcast` clean under `-D warnings`.
- [ ] `cd tugrust && cargo build --release -p tugcast` clean under `-D warnings`. **Both build profiles must compile** even though `source_tree()` has no callers yet.
- [ ] `cd tugrust && cargo nextest run -p tugcast resources` passes.
- [ ] `cd tugrust && cargo expand --release -p tugcast 2>&1 | grep -c 'CARGO_MANIFEST_DIR'` returns `0`. (Confirms the dev fallback is cfg-gated out of the release binary — no dev machine paths leak.)

---

#### Step 2: Route callsites through `resources::source_tree()` and apply dev-only gates {#step-2}

**Depends on:** #step-1

**Commit:** `refactor(tugcast): route resource lookups through resources::source_tree()`

**References:** [D01] both-modes helper, [D04] server.rs param deletion, Spec (#callsite-inventory), Risk R02 (#r02-release-gate-miss)

**Artifacts:**
- Modified: `tugrust/crates/tugcast/src/main.rs` (`BuildStatusCollector` block + `migrate_settings_to_tugbank` call wrapped in `#[cfg(debug_assertions)]`; `resolve_tugcode_path` call updated to drop the `watch_dir` arg; `run_server` call updated to drop the `source_tree` arg).
- Modified: `tugrust/crates/tugcast/src/feeds/agent_bridge.rs` (`resolve_tugcode_path` signature: drop `watch_dir: &Path` parameter; `.ts` fallback branch wrapped in `#[cfg(debug_assertions)]` and reads `crate::resources::source_tree()`).
- Modified: `tugrust/crates/tugcast/src/server.rs` (`build_app` signature: drop `source_tree: Option<PathBuf>` parameter; `run_server` signature: same; ServeDir hookup unconditional, reads `crate::resources::source_tree()`).

**Tasks:**
- [ ] `agent_bridge.rs::resolve_tugcode_path`: drop the `watch_dir: &Path` parameter. Move the `.ts` fallback into a `#[cfg(debug_assertions)]` block that reads `crate::resources::source_tree().join("tugcode/src/main.ts")`. In release, the `.ts` fallback branch does not exist at all — the function returns `None` if none of the non-fallback resolution paths fire (production Tug.app always resolves tugcode via the bundled `Contents/MacOS/tugcode` binary).
- [ ] `main.rs:284`: update the call to `resolve_tugcode_path(cli.tugcode_path.as_deref())` — one argument.
- [ ] `main.rs:257-259` (BuildStatusCollector construction): wrap the entire construction + feed registration block in `#[cfg(debug_assertions)]`. Inside the block, compute `target_dir` as `resources::source_tree().join("target")`.
- [ ] `main.rs:222`: delete the old `let target_dir = watch_dir.join("target");` line (now redundant — it moved inside the cfg-gated block).
- [ ] `main.rs:160`: wrap the `migrate_settings_to_tugbank(&watch_dir, client)` call in `#[cfg(debug_assertions)]`. Inside the block, change the first arg to `&resources::source_tree()`.
- [ ] `server.rs::build_app`: drop the `source_tree: Option<PathBuf>` parameter. The ServeDir hookup is unconditional (no `#[cfg]` gate) and reads `crate::resources::source_tree().join("tugdeck").join("dist")`.
- [ ] `server.rs::run_server`: drop the `source_tree: Option<PathBuf>` parameter.
- [ ] `main.rs:505`: update the `run_server(...)` call to drop the `Some(watch_dir)` argument.
- [ ] Any callers of `build_app` in tests: drop the parameter. Tests run in dev (`debug_assertions = true`) so `source_tree()` resolves to the tugtool workspace root, and `tugdeck/dist/` may or may not exist — unit tests should not depend on it. If any test asserts ServeDir behavior, verify it still works.
- [ ] Any callers of `run_server` in tests or other binaries: drop the parameter.

**Tests:**
- [ ] All existing tugcast tests still pass (`cargo nextest run -p tugcast`).
- [ ] `cargo build --release -p tugcast` compiles clean.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run --workspace` green.
- [ ] `cd tugrust && cargo build -p tugcast` clean under `-D warnings`.
- [ ] `cd tugrust && cargo build --release -p tugcast` clean under `-D warnings`. **Critical** — this is the first step where the cfg gates are load-bearing.
- [ ] `rg 'fn resolve_tugcode_path' tugrust/crates/tugcast/src/feeds/agent_bridge.rs` — confirm signature dropped the `watch_dir` param.
- [ ] `rg 'fn build_app|fn run_server' tugrust/crates/tugcast/src/server.rs` — confirm signatures dropped the `source_tree` param.

---

#### Step 3: Rename CLI `--dir` → `--source-tree` and update Tug.app Swift + tests + docs {#step-3}

**Depends on:** #step-2

**Commit:** `feat(tugcast): rename --dir to --source-tree (transitional)`

**References:** [D02] transitional rename, [D03] watch_dir internal name kept, Spec (#cli-rename-spec, #swift-update-spec), Risk R01 (#r01-tugapp-callsite-missed)

**Artifacts:**
- Modified: `tugrust/crates/tugcast/src/cli.rs` (`Cli::dir` → `Cli::source_tree`; `#[arg(long)]` flag name update; `long_about` help-text update; all tests that reference `cli.dir` or `"--dir"`).
- Modified: `tugrust/crates/tugcast/src/main.rs` (`cli.dir` → `cli.source_tree` at the two callsites that read the field; `tracing!` fields that log `dir = ?cli.dir` updated to `source_tree = ?cli.source_tree`).
- Modified: `tugapp/Sources/ProcessManager.swift` (line 558: `"--dir"` → `"--source-tree"`).
- Modified: `README.md` and any developer setup docs that mention `tugcast --dir <path>`.
- Modified: `tugrust/crates/tugutil/src/commands/worktree/*.rs` scaffolding that emits `tugcast --dir ...` (if any — grep first).

**Tasks:**
- [ ] Rename the `Cli::dir` field to `Cli::source_tree`. Update the `#[arg(long, default_value = ".")]` — clap will automatically infer the flag name `--source-tree` from the field name.
- [ ] Update `cli.rs::long_about` to say `tugcast --source-tree /path/to/project`.
- [ ] Update the field doc comment to say "Workspace directory for the bootstrap file-tree/git feeds. Transitional: this flag will be removed in T3.4.c when the Tide card lands a real project picker."
- [ ] Update `cli.rs` tests: `test_default_values` (assert `cli.source_tree`), `test_override_dir` → `test_override_source_tree` (pass `--source-tree`), `test_all_overrides` (use `--source-tree`), `test_help_contains_flags` (assert `--source-tree` in help text, not `--dir`).
- [ ] Add a new test `test_old_dir_flag_rejected` asserting that `tugcast --dir /foo` yields a clap `InvalidFlag`-ish error.
- [ ] Update `main.rs`: every `cli.dir` reference (check `grep -n 'cli\.dir' tugrust/crates/tugcast/src/main.rs`) becomes `cli.source_tree`. Two callsites per audit: `main.rs:70` (tracing) and `main.rs:135-138` (absolute-path check + `watch_dir` derivation). Update accordingly.
- [ ] Leave `let watch_dir = ...` named `watch_dir`. Add a one-line comment: `// `cli.source_tree` is the transitional name; internally we still call the bootstrap workspace "watch_dir" — see tide.md T3.0.W3.a.`
- [ ] Update `ProcessManager.swift:558`: `args += ["--dir", dir]` → `args += ["--source-tree", dir]`.
- [ ] Grep sweep: `rg -- '--dir' tugrust/crates/tugcast tugapp/Sources` should return zero real flag references.
- [ ] Grep sweep: `rg 'cli\.dir' tugrust/crates/tugcast/src` should return zero.
- [ ] Doc updates: `rg -- '--dir' README.md dash/ docs/ 2>/dev/null` and update every hit that's about tugcast's flag. Skip historical references (e.g., tugplan archive files) — those are immutable records.
- [ ] Update `tugutil worktree setup` scaffolding if it mentions `--dir` (grep first).

**Tests:**
- [ ] `cargo nextest run -p tugcast cli` — all cli.rs tests green with new flag name.
- [ ] `cargo nextest run --workspace` — full suite green.
- [ ] New test `test_old_dir_flag_rejected` passes.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run --workspace` green.
- [ ] `cd tugrust && cargo build --release -p tugcast` clean.
- [ ] `cd tugapp && xcodebuild -project Tug.xcodeproj -scheme Tug -configuration Debug build 2>&1 | tail -5` shows BUILD SUCCEEDED. *(Or equivalent — whatever the project's standard Swift build invocation is.)*
- [ ] `rg -- '--dir' tugrust/crates/tugcast tugapp/Sources` returns zero real flag references.
- [ ] `rg 'cli\.dir' tugrust/crates/tugcast/src` returns zero.
- [ ] Manual smoke: launch Tug.app under Xcode debug; confirm tugcast spawns successfully; confirm git card shows the current branch of the directory `--source-tree` points at; confirm filetree card populates.

---

#### Step 4: Integration checkpoint — end-to-end verification {#step-4}

**Depends on:** #step-1, #step-2, #step-3

**Commit:** `N/A (verification only)`

**References:** (#success-criteria, #exit-criteria), [D01] dev-only gating confirmation

**Artifacts:**
- No code changes. Verification only.

**Tasks:**
- [ ] `cd tugtool && just ci` — full gate green (Rust nextest + fmt + tugdeck bun test).
- [ ] `cd tugrust && cargo build --release -p tugcast` — release compile green under `-D warnings`.
- [ ] `cd tugrust && cargo expand --release -p tugcast 2>&1 | grep -c 'BuildStatusCollector::new'` — returns `0`. (Confirms the `#[cfg(debug_assertions)]` gate excludes BuildStatusCollector from the release expanded tree.)
- [ ] `cd tugrust && cargo expand --release -p tugcast 2>&1 | grep -c 'CARGO_MANIFEST_DIR'` — returns `0`. (Confirms no dev machine paths leak into the release binary via the source_tree fallback.)
- [ ] `rg -- '--dir' tugrust/crates/tugcast tugapp/Sources` — zero real flag references.
- [ ] `rg 'AgentSupervisorConfig::project_dir' tugrust/crates/tugcast/src` — zero real references (W2 criterion re-verified).
- [ ] `just app` — end-to-end bundle build succeeds.
- [ ] Verify bundle layout: `ls "$APP_DIR/Contents/MacOS/"` shows `Tug`, `tugcast`, `tugcode`, `tugutil`, `tugexec`, `tugrelaunch`. `ls "$APP_DIR/Contents/Resources/tugdeck/dist/index.html"` exists.
- [ ] Manual smoke — *single-pattern verification*: Launch the built `Tug.app`. Confirm tugdeck UI loads. Then **temporarily** rename `<repo>/tugdeck/dist/` to `<repo>/tugdeck/dist.bak/` and re-launch Tug.app. Tugdeck UI should still load, because tugcast is reading from `Contents/Resources/tugdeck/dist/` via `TUGCAST_RESOURCE_ROOT`, not from the repo. This is the confirmation that debug `just app` exercises the same code path release would. Restore the directory after the test.
- [ ] Manual smoke — full feature: git card shows the current branch for the directory `--source-tree` points at; filetree card populates; file edits are reflected in feed updates.

**Tests:**
- [ ] `just ci` green.
- [ ] Release compile green.
- [ ] Bundle layout verified.

**Checkpoint:**
- [ ] All exit criteria in [#exit-criteria] are checked.
- [ ] Manual smoke notes captured in the PR description.

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** A merged branch that lands the `Tug.xcodeproj` copy phase (binaries + `tugdeck/dist` into the bundle), the `ProcessManager.swift` env-var set (`TUGCAST_RESOURCE_ROOT=Bundle.main.resourcePath`), `tugcast::resources::source_tree()` driven by that env var with a debug-only `CARGO_MANIFEST_DIR` fallback, routes `resolve_tugcode_path`'s `.ts` fallback + `BuildStatusCollector` + `migrate_settings_to_tugbank` + `server.rs` static serving through it (dev-only gating on the first three; unconditional on the last), deletes the `source_tree: Option<PathBuf>` parameter from `build_app`/`run_server`, renames the `--dir` CLI flag to `--source-tree`, updates Tug.app's `ProcessManager.swift` to pass the new flag, and keeps the W1 bootstrap workspace alive throughout. Debug `just app` and Release launch exercise the **same** resource-resolution code path, eliminating the build-profile testing divergence.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] **Criterion 1** — `just ci` full-suite green. (verification: Step 4 checkpoint)
- [ ] **Criterion 2** — `cargo build --release -p tugcast` compiles clean under `-D warnings`. (verification: Step 4 checkpoint)
- [ ] **Criterion 3** — `cargo expand --release -p tugcast | grep BuildStatusCollector::new` returns zero. (verification: Step 4 cfg-gate spot check)
- [ ] **Criterion 4** — `cargo expand --release -p tugcast | grep CARGO_MANIFEST_DIR` returns zero. (verification: Step 4 — confirms the debug-only fallback branch is cfg-gated out of the release binary; no dev machine path leaks.)
- [ ] **Criterion 5** — `rg -- '--dir' tugrust/crates/tugcast tugapp/Sources` returns zero real flag references. (verification: Step 4 grep)
- [ ] **Criterion 6** — `rg 'AgentSupervisorConfig::project_dir' tugrust/crates/tugcast/src` returns zero matches. (W2 criterion re-verified.)
- [ ] **Criterion 7** — `just app` builds a bundle where `Contents/MacOS/tugcast` and `Contents/Resources/tugdeck/dist/index.html` both exist. (verification: Step 0 and Step 4 checkpoints.)
- [ ] **Criterion 8** — `TUGCAST_RESOURCE_ROOT` is set in the environment of the tugcast process spawned by the built Tug.app. (verification: Step 0 checkpoint — `ps -E -p $(pgrep -x tugcast)` or equivalent.)
- [ ] **Criterion 9** — The built Tug.app launches, and tugdeck UI loads from `Contents/Resources/tugdeck/dist/` even when the repo's `tugdeck/dist/` is temporarily renamed. This proves `just app`'s tugcast is reading from the bundle, not the repo — debug and release exercise the same code path. (verification: Step 4 single-pattern manual smoke.)
- [ ] **Criterion 10** — Git card shows the current branch for the directory `--source-tree` points at; filetree card populates. (verification: Step 4 full feature manual smoke.)
- [ ] **Criterion 11** — Workspace builds clean under `-D warnings` on every intermediate commit. (verification: per-step `cargo build` checkpoints)
- [ ] **Criterion 12** — The W1 bootstrap `registry.get_or_create(&watch_dir, cancel.clone())` call in `main.rs` is **still present** — its deletion is explicitly W3.b's job. (verification: `rg 'get_or_create.*watch_dir' tugrust/crates/tugcast/src/main.rs` returns exactly one match.)

**Acceptance tests:**
- [ ] `test_source_tree_uses_env_var_when_set`
- [ ] `test_source_tree_fallback_points_at_tugtool_root` (debug-only)
- [ ] `test_source_tree_fallback_is_absolute` (debug-only)
- [ ] `test_default_values` (updated to assert `cli.source_tree`)
- [ ] `test_override_source_tree` (renamed from `test_override_dir`)
- [ ] `test_all_overrides` (updated)
- [ ] `test_help_contains_flags` (updated to assert `--source-tree`)
- [ ] `test_old_dir_flag_rejected` (new)

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] **T3.0.W3.b** — delete the bootstrap workspace + `--source-tree` flag entirely. Rides with [T3.4.c](./tide.md#t3-4-c-tide-card).
- [ ] **Delete `migrate_settings_to_tugbank` entirely** — the legacy flat-file settings migration was a one-time dev migration. After it's been `#[cfg(debug_assertions)]`-gated for long enough that no one remembers needing it, delete the function itself. Tracked separately.
- [ ] **Per-workspace `BuildStatusCollector`** — replace the dev-only chrome widget with a workspace-scoped feature that detects `Cargo.toml` / `package.json` / `go.mod` in each workspace. Tracked separately as a post-W3 item.
- [ ] **Codesign + notarize the bundle** — `just dmg` already exists for this but W3.a doesn't verify it. Confirm the new copy phase works under Release + codesign in a follow-up.

| Checkpoint | Verification |
|------------|--------------|
| Xcode copy phase lands and bundle is self-contained | `just app` + `ls $APP_DIR/Contents/{MacOS,Resources}/tugdeck/dist` ([#step-0]) |
| `resources::source_tree()` helper lands and compiles | `cargo nextest run -p tugcast resources` ([#step-1]) |
| Callsites routed + gates applied | `cargo build --release -p tugcast` clean ([#step-2]) |
| CLI rename lands and Tug.app spawns tugcast | Manual smoke + `rg -- '--dir'` zero ([#step-3]) |
| Full phase green (bundle loads tugdeck UI) | `just ci` + `just app` manual launch + release compile + grep verifications ([#step-4]) |
