# tug — unify the CLI trio under a single `tug` binary {#purpose}

## Purpose {#purpose-statement}

Collapse the three separate developer CLIs — `tugutil`, `tugdash`, `tugmark` — into
**one binary, `tug`**, with a better-organized command surface and **zero feature
changes**. Every capability the three tools expose today survives; only the interface
changes:

- `tugmark <verb>` → **`tug <verb>`** (top-level: `changes`, `context`, `commit`, `log`, `diff`).
- `tugdash <verb>` → **`tugutil dash <verb>`** (`create`, `commit`, `join`, `release`, `list`, `show`).
- `tugutil {instance,gate,state-dir,tell,init}` → **`tugutil host <verb>`** (a new `host` namespace for machine/project plumbing).
- `tugutil resolve` and `tugutil version` are **retired** — nothing calls them; `tug --version` (clap's built-in) covers the latter.

The three `*-core` libraries (`tugutil-core`, `tugdash-core`, `tugmark-core`) are the
untouched engines. `tug` is a pure `clap` re-facing over them: one bin crate that owns
the union command tree and delegates to the existing typed handlers. The three old bin
crates are deleted; the cores stay.

## Plan Metadata {#plan-metadata}

- **Slug:** `tug-unify-bringup`
- **Surface:** Rust workspace (`tugrust/`), macOS host (`tugapp/`), distribution scripts, `tugplug` skills, `tugdeck` command-enhancer, app-test harness.
- **Primary new artifact:** `tugrust/crates/tug/` (bin crate, bin name `tug`).
- **Deleted:** `tugrust/crates/tugutil/`, `tugrust/crates/tugdash/`, `tugrust/crates/tugmark/` (bin crates only).
- **Preserved verbatim:** all `*-core` libraries; every verb's `--json` envelope and `command` label; all git/ledger/dash behavior.
- **No sub-agents.** Walked by `/tugplug:implement` on a `tugdash` worktree, one commit per step.

## Phase Overview {#phase-overview}

### Context {#context}

The repo already went through the *opposite* refactor: `tugmark` was just split out of
`tugutil` (the "tugmark bring-up", `dash/tugmark-bringup.md`, all 10 steps landed).
That split proved the two-crate lib+bin pattern but left the developer facing **three
binaries** for what is really one tool suite. This plan reverses direction at the
*presentation* layer only — one binary, three namespaces — while keeping the clean
`*-core` library boundaries the split produced.

Current shapes (verified from the live `--help` and source):

- **`tugmark`** (`crates/tugmark/src/main.rs`): global `--json`; subcommands `changes`
  / `context` / `commit` / `log` / `diff`, each a thin `run_*` over `tugmark_core::{changes,context,commit,log,diff}`.
  Envelope: inline `JsonResponse<T>` = `{schema_version:"1", command, status:"ok", data, issues:[]}`.
  `command` labels are `"mark changes"`, `"mark context"`, `"mark commit"`, `"mark log"`, `"mark diff"`.
- **`tugdash`** (`crates/tugdash/src/main.rs`): global `--json` + `--quiet`; subcommands
  `create` / `commit` / `join` / `release` / `list` / `show` over `tugdash_core::ops`
  (+ `resolve` for `join --resolve`). `commit` reads round-metadata JSON from stdin.
  Same inline envelope; `command` labels `"dash create"`, `"dash commit"`, `"dash join"`,
  `"dash join --resolve"`, `"dash release"`, `"dash list"`, `"dash show"`.
- **`tugutil`** (`crates/tugutil/src/{main,cli}.rs` + `commands/`): global `-v/--verbose`,
  `-q/--quiet`, `--json`; subcommands `init` / `resolve` / `version` / `tell` /
  `instance` (subtree) / `gate` (subtree) / `state-dir`. Envelope lives in
  `crates/tugutil/src/output.rs` (`JsonResponse<T>`, `JsonIssue`) — **byte-identical**
  shape to the tugmark/tugdash inline one. Version string:
  `const VERSION = concat!(CARGO_PKG_VERSION, " (", env!("TUG_COMMIT"), ")")`, where
  `TUG_COMMIT` is injected by `crates/tugutil/build.rs`. No-subcommand path prints a
  splash (`commands/splash.rs`).

**Which `tugutil` verbs are actually load-bearing** (audited by grep across justfile,
scripts, Swift, TS, skills, excluding `dash/archive/`):

| Verb | Real automated dependents | Disposition |
|---|---|---|
| `instance` | justfile (~20 sites), `quit-tug-bundle.sh`, app-test `_harness/index.ts` (`spawnSync ["tugutil","instance","stop",…]`), **ProcessManager.swift** (`resolveBundledTool("tugutil")` → `instance stop`) | keep → `tugutil host instance` |
| `gate` | justfile build mutex (app-test target) | keep → `tugutil host gate` |
| `state-dir` | justfile, `implement` SKILL, `enhance-commands` | keep → `tugutil host state-dir` |
| `tell` | no automated caller (hand wrapper over `POST /api/tell`) | keep → `tugutil host tell` |
| `init` | no automated caller (human project bootstrap) | keep → `tugutil host init` |
| `resolve` | **zero callers anywhere**; `resolve_plan` lib only re-exported, never called outside its own tests | **retire the verb** (keep the lib) |
| `version` | zero — every bin has `--version` | **retire the verb** |

### Strategy {#strategy}

Land it Rust-first, then radiate outward through the call sites, so the workspace stays
green at every commit and only the final steps touch the app bundle:

1. **Rust unification** (one decisive step): create `crates/tug`, move `tugutil`'s
   `commands/` + `output` + `splash` + `build.rs` into it, port the `tugmark`/`tugdash`
   `run_*` handlers, author the union clap tree, re-home the integration tests, delete
   the three old bin crates, fix `workspace.members`. Verified entirely by
   `cargo nextest run` + `cargo build` + `tug --help`.
2. **justfile** — build targets, `~/.local/bin` symlinks, every `instance`/`gate`/`state-dir` call site.
3. **Distribution** — pbxproj file-lists + copy loop, `sign-bundle.sh`, `build-release-inputs.sh`, `build-app.sh`, `quit-tug-bundle.sh`.
4. **Swift host** — ProcessManager's bundled-tool takeover kill.
5. **Skills + frontend + hook + harness** — `tugplug` skills, `enhance-commands.ts` allowlist, `auto-approve-tug.sh`, app-test `spawnSync`.
6. **Integration checkpoint** — residual-reference sweep, full test run, live end-to-end demo.

### Success Criteria {#success-criteria}

- `cargo build` and `cargo nextest run` are green for the whole workspace with `-D warnings`.
- `tug --help` shows the three groups; `tugutil host --help` and `tugutil dash --help` reproduce today's `tugutil`/`tugdash` command sets (minus retired verbs); `tug` with no subcommand prints the splash.
- Every migrated verb's `--json` output is byte-identical to the pre-migration tool's (same envelope, same `command` label, same `data`).
- `just build` produces a `tug` binary and a single `~/.local/bin/tugutil` symlink; `just instances`, `just reap`, `just app-test` (gate), and the sentinel/state-dir paths all work through `tugutil host …`.
- `just app-debug` builds, signs, bundles, and launches; `Contents/MacOS/tugutil` is present and signed; the ProcessManager takeover kill uses the bundled `tugutil host instance stop`.
- `just app-test` ends `VERDICT: PASS`.
- No live surface (code, justfile, scripts, skills, non-archive docs, CLAUDE.md) references `tugutil`/`tugdash`/`tugmark` as an *invoked binary* — only the `*-core` crate names and `dash/archive/**` history remain.

### Scope {#scope}

- New `crates/tug` bin crate (clap tree + re-homed command modules + build.rs).
- Deletion of `crates/{tugutil,tugdash,tugmark}` bin crates and `workspace.members` update.
- Re-homed integration tests under `crates/tug/tests/`.
- justfile, pbxproj, four shell scripts, ProcessManager.swift, four `tugplug` skills, `enhance-commands.ts` + its test, `auto-approve-tug.sh`, app-test `_harness/index.ts`.
- Comment/doc references to the old binary *commands* on live surfaces (CLAUDE.md, non-archive roadmap, tuglaws if any).

### Non-goals {#non-goals}

- **No behavior changes.** Every flag, exit code, stdin contract (dash `commit` round-meta), envelope field, and `command` label is preserved exactly. [P01]
- **No `*-core` edits.** `tugutil-core`/`tugdash-core`/`tugmark-core` are untouched (except that `tugutil-core::resolve` becomes unused-by-any-bin; it stays for its lib API — see [P02]).
- **No alias/shim binaries.** `tugutil`/`tugdash`/`tugmark` binaries are gone, not aliased. This is one repo built together; there are no external consumers to bridge. [P03]
- **No tugcast changes.** tugcast already calls `tugmark_core::commit` in-process (from the tugmark bring-up) and never spawns any of these binaries — confirmed by grep. Out of scope.
- Renaming `tugtool` the repo, or `tugcast`/`tugexec`/`tugcode`/`tugrelaunch`/`tugbank`/`tugpulse` (separate programs, not CLI verbs) — untouched.

### Dependencies {#dependencies}

- Clean base checkout (the implement worktree). No overlap with in-flight branches expected.
- `just app-debug` / `just app-test` require the normal macOS + Xcode toolchain already in use.

### Constraints {#constraints}

- **Warnings are errors** (`tugrust/.cargo/config.toml` `-D warnings`). Fix every warning in-step.
- Rust edition 2024, `rust-version` 1.85 (workspace-inherited).
- Only the user commits to `main`; this plan is walked on a `tugdash` worktree via `implement`, committing per step on the dash.
- Keep the workspace green at **every** step — Rust steps verified by cargo; shell/Swift steps verified by `just app-debug`/`just app-test` in their own step, not left to break earlier Rust commits.

### Assumptions {#assumptions}

- `TUG_COMMIT` is provided **only** by `crates/tugutil/build.rs` (there is no `[env]` block in `tugrust/.cargo/config.toml`); moving that `build.rs` into `crates/tug` preserves the version string. [A01]
- The tugmark/tugdash/tugutil `--json` envelopes are already identical, so a single `output::JsonResponse` in `tug` reproduces all three byte-for-byte. [A02]
- No code outside justfile/scripts/Swift/harness spawns the `tugutil`/`tugdash`/`tugmark` binaries by name (verified: no `Command::new("tugutil"|…)` in Rust; Swift's only spawn is ProcessManager's `resolveBundledTool("tugutil")`). [A03]

## Open Questions {#open-questions}

- **[Q01] `command` label strings.** tugmark emits `"mark changes"` etc.; under `tugutil changes`
  the `"mark "` prefix is now cosmetically odd. **Resolved:** preserve every label verbatim
  ([P01]) — the skills consume `.data.*`, not `.command`, and a "no feature change" refactor
  must not risk a consumer that string-matches the label. A later cosmetic pass can revisit.
- **[Q02] `host` splash / no-subcommand behavior.** `tug` (no args) keeps `tugutil`'s splash.
  `tugutil host` (no sub) and `tugutil dash` (no sub) should print their subcommand help (clap default
  when a subcommand group has no default) — acceptable, no special-casing. **Resolved:** default clap behavior.

## Risks {#risks}

- **[R01] A missed call site leaves a dangling `tugutil`/`tugdash`/`tugmark` invocation.**
  Mitigation: Step 6 greps the whole tree (excluding `dash/archive/**` and `*-core` names)
  for the three tokens as *commands* and drives the count to zero on live surfaces.
- **[R02] Envelope drift** (a re-homed handler serializes differently). Mitigation: reuse the
  handler bodies verbatim; the re-homed integration tests assert the same `--json` shapes; a
  live `--json` diff is part of Step 6.
- **[R03] `~/.local/bin` dangling symlinks** from a dash worktree build (the justfile already
  guards this — only the main checkout owns `~/.local/bin`). Mitigation: keep the guard; when
  the dash builds, it skips the symlink step, so `tug` resolves via the main-checkout symlink
  only after join. Noted so the implementer runs `tug` from `tugrust/target/debug/tugutil` inside
  the worktree, not via a stale `~/.local/bin/tugutil`.
- **[R04] Swift/bundle step green but takeover-kill untested** (the takeover path is hard to
  force in app-test). Mitigation: assert the binary name + arg vector by code review and confirm
  `Contents/MacOS/tugutil host instance stop --help` runs from the signed bundle.
- **[R05] Dead code from retiring `resolve`/`version` fails `-D warnings`.** Deleting
  `commands/resolve.rs` strands `output::ResolveData` (only `resolve` constructs it), and likely
  `JsonResponse::error` + `JsonIssue` (and the `ResolveResult`/`ResolveStage` re-exports) if no
  surviving verb builds an error envelope — dead-code warnings are hard errors here. This is the
  most likely thing to break Step 1's checkpoint. Mitigation: Step 1 prunes `ResolveData` and
  audits `error()`/`JsonIssue`/the resolve re-exports, keeping only what a surviving verb uses ([P05]).
- **[R06] Stale `~/.local/bin/{tugutil,tugdash,tugmark}` symlinks dangle after join.** Dropping the
  three names from the build recipe's symlink loop stops *managing* them, but the pre-existing
  symlinks linger; once the user rebuilds `main` post-join, they point at `target/debug/tugutil` etc.
  that cargo no longer produces (the dangling-link failure mode in `reference_local_bin_symlinks`).
  Mitigation: Step 2 adds `rm -f ~/.local/bin/{tugutil,tugdash,tugmark}` inside the main-checkout
  branch of the recipe (same guard as symlink creation).

## Design Decisions {#design-decisions}

- **[P01] Zero behavior change; preserve every verb's output byte-for-byte** — same envelope,
  same `command` label, same flags, same exit codes, same stdin contract. The only observable
  differences are the binary name and the `host`/`dash` prefixes.
- **[P02] Keep the `*-core` libraries as the engines; `tug` is presentation only.** No logic
  moves into `tug`; it ports the existing `run_*` shells and command modules. `tugutil-core::resolve`
  stays even though no bin calls it anymore (it's a published lib API with a full test suite;
  deleting it is a separate decision, out of scope).
- **[P03] Clean cutover, no alias binaries.** The old binary names are deleted. All call sites
  migrate in the same plan. Rationale: single repo, no external consumers, and aliases would
  leave the old names discoverable and the migration half-done.
- **[P04] `host` namespace for machine/project plumbing** (`instance`/`gate`/`state-dir`/`tell`/`init`).
  Keeps the top level human-facing (git verbs + `dash`) and tucks plumbing behind one prefix.
  Chosen over a flat top level (per the proposal decision). Cost: every plumbing call site gains
  a `host` token — inventoried in Steps 2–5.
- **[P05] Retire `resolve` and `version` verbs.** Zero callers; `--version` covers version. The
  `version.rs`/`resolve.rs` command modules are dropped; `build.rs`/`TUG_COMMIT` are kept for the
  `--version` string.
- **[P06] One crate, `crates/tug`, by re-homing `tugutil`'s modules.** `tugutil` is the largest of
  the three (owns `commands/`, `output`, `splash`, `build.rs`); `tug` is built by moving those in
  and porting the two smaller bins' `run_*` handlers. Preferred over a fresh crate that re-imports,
  to minimize new code and keep the command modules unchanged.

## Deep Dives {#deep-dives}

### D1 — The unified `tug` clap tree {#dd-clap-tree}

`crates/tug/src/cli.rs` (or inline in `main.rs`) defines:

```
struct Cli {
  --verbose (-v, global)   // from tugutil
  --quiet   (-q, global)   // union of tugutil/tugdash
  --json    (global)       // all three
  command: Option<Commands> // Option → None prints the splash (tugutil behavior)
}

enum Commands {
  // --- git changes & commits (was tugmark, top-level) ---
  Changes  { --session, --project, --all, --diff }
  Context  { --session, --project, --log-limit=10 }
  Commit   { --message (required), --session, --project, --paths.., --all }
  Log      { --limit, --range }
  Diff     { --range, --staged, --session, --project }
  // --- dashes (was tugdash) ---
  Dash(DashCommands)   // Create/Commit/Join/Release/List/Show — verbatim from tugdash
  // --- host plumbing (was tugutil, minus resolve/version) ---
  Host(HostCommands)   // Init/Tell/Instance(subtree)/Gate(subtree)/StateDir
}
```

- The **git verbs** route to `tugmark_core::{changes,context,commit,log,diff}` via the
  `run_changes/run_context/run_commit/run_log/run_diff` bodies ported verbatim from
  `crates/tugmark/src/main.rs` (including the plain-mode stderr "ambiguous omitted" note
  and the exit-1/exit-2 `AppError` mapping from `ChangesError`).
- **`Dash`** wraps the existing `tugdash` `Command` enum and its `run_*` functions verbatim
  (including `join --resolve`'s dispatch guard, the stdin round-metadata read in `dash commit`,
  and the `CliStrategy`→`JoinStrategy` mapping).
- **`Host`** wraps `tugutil`'s existing `InstanceCommands`/`GateCommands` subtrees and the
  `run_init/run_tell/run_instance/run_gate/run_state_dir` handlers, moved from
  `crates/tugutil/src/commands/`. Drop `run_resolve`/`run_version` and their modules.

**Exit-code reconciliation:** the three mains map results differently — tugmark uses the
`AppError::{Exit1,Exit2}` enum (exit 2 = ledger "can't resolve session"); tugdash returns
`Result<(),String>` → exit 1 (plus join-conflict exit 1); tugutil returns `Result<u8,_>` →
`ExitCode::from(code)`. The unified `main` must preserve each: keep the git-verb `AppError`
mapping for `Changes/Context/Commit/Log/Diff`, the string→exit-1 mapping for `Dash`, and the
`u8` code mapping for `Host`. Simplest: each top-level arm returns its own typed result and
`main` matches per-group, exactly as the three mains do today.

### D2 — Envelope + version wiring {#dd-envelope}

- Use `tugutil`'s `output::JsonResponse`/`JsonIssue` (re-homed to `crates/tug/src/output.rs`)
  as the single envelope for **all** verbs. The tugmark/tugdash inline `JsonResponse` structs
  are dropped; their `print_json` calls point at the shared one. Field-for-field identical, so
  `--json` output is unchanged ([A02]).
- Move `crates/tugutil/build.rs` → `crates/tug/build.rs` verbatim. It sets
  `cargo::rustc-env=TUG_COMMIT=<hash>`. Keep `const VERSION = concat!(CARGO_PKG_VERSION, " (", env!("TUG_COMMIT"), ")")`
  on the `tug` `#[command(version = VERSION)]`.

### D3 — Full call-site inventory {#dd-call-sites}

Exact sites the sweep must hit (line numbers are indicative — match on content):

- **justfile:** `cargo build … -p tugutil -p tugdash -p tugmark …` (build + app-debug build, 2 lines) → `-p tug`; symlink loop `for bin in … tugutil tugdash tugmark …` → include `tug`, drop the three, **and `rm -f ~/.local/bin/{tugutil,tugdash,tugmark}` in the same main-checkout branch so no stale symlink dangles post-join** ([R06]); `tugrust/target/debug/tugutil instance …` (prune-warn 273/274, stop 408/410, remove 470, reap `TUGUTIL=` 531-539, kill loops 1063/1065/1120/1122/1199/1201) → `tugrust/target/debug/tugutil host instance …`; `tugutil gate …` (app-test gate 1007-1012, comments 953/1001) → `tugutil host gate …`; `tugutil state-dir` (803/921, comment 793) → `tugutil host state-dir`; the `just instances` wrapper (415) and `just instance-remove` (470); comment `tugdash join|release` (494) → `tugutil dash …`.
- **pbxproj** (`tugapp/Tug.xcodeproj/project.pbxproj`): input file list (220-225) + output file list (234-239) entries for `tugutil`/`tugdash`/`tugmark` → single `tug`; the copy-phase `shellScript` `for bin in tugcast tugcode tugutil tugdash tugmark tugexec tugrelaunch tugpulse` → replace the three with `tug`.
- **sign-bundle.sh:** `RUST_BINS=(tugcast tugutil tugdash tugmark tugexec tugrelaunch tugbank)` → replace the three with `tug`; comment (21).
- **build-release-inputs.sh:** `cargo build --release -p tugcast -p tugdash -p tugmark -p tugexec -p tugutil -p tugrelaunch` → `-p tug` (one, not three); comment (8).
- **build-app.sh:** `cp …/release/tugutil …/MacOS/` (114) → `tug`; comment (82). (Note: this script currently copies only tugcast/tugutil/tugexec/tugcode — it never copied tugdash/tugmark; after unify it copies `tug`.)
- **quit-tug-bundle.sh:** `TUGUTIL="$REPO_ROOT/tugrust/target/debug/tugutil"` + `"$TUGUTIL" instance stop …` (57-59) → `tug` + `host instance stop`; comments (53-55).
- **ProcessManager.swift:** `resolveBundledTool("tugutil")` (922) → `"tug"`; the `proc` arg vector `["instance","stop",id,"--timeout",…]` → `["host","instance","stop",…]`; comments (324/912-940 mentioning tugutil).
- **tugplug skills** (`SKILL.md`): `commit` (`tugmark context`/`tugmark commit`), `implement`/`dash` (`tugmark log`, `tugdash create|commit|join`, `tugutil state-dir`), `audit` (`tugmark log`, `tugmark diff --range`) → `tug …` / `tugutil dash …` / `tugutil host state-dir`.
- **enhance-commands.ts:** `SHELL_COMMAND_TOOLS = ["just","tugutil","tugdash","tugmark"]` → `["just","tug"]`; doc comment (16); test fixtures in `__tests__/enhance-commands.test.ts` (104-107, 128) → `tug`/`tugutil host`/`tugutil dash` forms.
- **auto-approve-tug.sh:** the `case` arms `tugtool\ *|tugutil` and `tugmark\ *|tugmark` (25-26) → a single `tug\ *|tug) APPROVE=true` (keep the `tugtool` arm if it still means the repo umbrella; drop the tugutil/tugmark arms).
- **app-test `_harness/index.ts`:** `spawnSync({cmd:["tugutil","instance","stop",id,"--timeout",…]})` (1770-1782) → `["tug","host","instance","stop",…]`; comments referencing `tugutil instance …`.
- **CLAUDE.md / non-archive roadmap / tuglaws:** update prose that names the old binaries as commands.

## Test Plan Concepts {#test-plan-concepts}

- **Re-homed integration tests** (`crates/tug/tests/`): port `tugmark/tests/cli.rs` (7 tests:
  changes/context/commit/log/diff over a seeded temp repo + `HOME`/`TUG_*` env scrubbing) and
  `tugutil/tests/{cli_integration_tests.rs, gate.rs}`. Rewrite the command builder to
  `assert_cmd::Command::cargo_bin("tug")` and prefix invocations: git verbs stay top-level,
  `gate`/`instance`/`state-dir`/`tell`/`init` gain `host`, dash gains `dash`. These are the
  byte-identical golden contract for the envelope + exit codes.
- **`bun test`** for `enhance-commands` — the fixture table asserts the `tug`/`tugutil host`/`tugutil dash`
  command lines are recognized by the enhancer.
- **`bunx vite build`** — the tugdeck change (allowlist) must survive the production rollup bundle.
- **`just app-test`** (full sweep) — exercises instance lifecycle through `tugutil host instance` and
  the app-test gate through `tugutil host gate`; ends `VERDICT: PASS`.
- **Live end-to-end** (Step 6): from the worktree's `tugrust/target/debug/tugutil`, run `tugutil context`
  → `tugutil commit --message …` and diff the receipt against `git show --numstat`; `tugutil dash list`;
  `tugutil host instance list`; `tugutil host state-dir`.

## Execution Steps {#execution-steps}

### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| 1 | Create the unified `tug` crate; delete the three bins | done | `00df42b5c` |
| 2 | Retarget the justfile | done | `8634d96cf` |
| 3 | Retarget distribution scripts + app bundle | done | `fe62e65b6` |
| 4 | Swift host: ProcessManager takeover kill | done | `c7add9bd2` |
| 5 | Skills, frontend allowlist, hook, app-test harness | done | `59708c341` |
| 6 | Integration checkpoint + residual-reference sweep | done | `aeeef9439` |

### Step 1 — Create the unified `tug` crate; delete the three bins {#step-1}

**Commit:** `tug(unify): single tug binary over the three cores; retire tugutil/tugdash/tugmark bins`

**References:** [P01] [P02] [P03] [P04] [P05] [P06] [A01] [A02] [Q01] [Q02], #dd-clap-tree, #dd-envelope

**Tasks:**
1. Create `crates/tug/` with `Cargo.toml`: `[[bin]] name = "tug"`, `path = "src/main.rs"`;
   `build = "build.rs"` (implicit — just place the file). Dependencies = union of the three bins:
   `clap`, `serde`, `serde_json`, `libc`, `toml`, `thiserror`, `anyhow`, `regex`, `chrono`,
   `ureq = { version = "3", features = ["json"] }`, `tugcore`, `tugutil-core`, `tugdash-core`,
   `tugmark-core`. Dev-deps: `tempfile`, `assert_cmd`, `rusqlite` (for the ported tests),
   `serial_test` (for the gate test).
2. Move verbatim into `crates/tug/src/`: `tugutil`'s `commands/{init,tell,instance,gate,state_dir}.rs`,
   `output.rs`, `splash.rs`, and `build.rs`. Rewrite `commands/mod.rs` to drop `resolve`/`version`
   (delete those two module files); keep the other `pub use`s. **Then clear the dead code the
   retirement strands, or `-D warnings` fails the build ([R05]):** delete `output::ResolveData`
   (only `resolve` built it), and audit `JsonResponse::error`/`JsonIssue` and the
   `tugutil_core::{ResolveResult,ResolveStage,resolve_plan}` re-exports — keep only what a surviving
   verb (`init`/`tell`/`instance`/`gate`/`state-dir`) actually uses; remove the rest. `build.rs`
   stays (it feeds `TUG_COMMIT` into the `--version` string), only the `version` *subcommand* goes.
3. Author `crates/tug/src/cli.rs` + `main.rs` implementing the union tree in #dd-clap-tree:
   global `--verbose`/`--quiet`/`--json`; top-level git verbs (bodies ported verbatim from
   `tugmark/src/main.rs`, pointing `print_json` at the shared `output::JsonResponse` and keeping
   the `"mark …"` command labels [Q01]); `Dash(DashCommands)` (ported verbatim from
   `tugdash/src/main.rs`, incl. `CliStrategy`, the stdin round-meta read, and `join --resolve`);
   `Host(HostCommands)` wrapping `InstanceCommands`/`GateCommands` + `init/tell/state-dir`. Preserve
   each group's exit-code mapping (#dd-clap-tree "Exit-code reconciliation"). No-subcommand → splash.
4. Move + rewrite integration tests into `crates/tug/tests/`: from `tugmark/tests/cli.rs` and
   `tugutil/tests/{cli_integration_tests.rs, gate.rs}`; switch to `Command::cargo_bin("tug")` and
   add `host`/`dash` prefixes where applicable (git verbs stay top-level). Keep the env scrubbing
   (`HOME`, `TUG_INSTANCE_ID`, `TUG_SESSION_ID`) and the canonicalized-tempdir `init_repo` helper.
5. Delete `crates/tugutil/`, `crates/tugdash/`, `crates/tugmark/`.
6. Update `tugrust/Cargo.toml` `workspace.members`: remove the three, add `"crates/tug"`. Leave the
   `tugutil-core`/`tugdash-core`/`tugmark-core` members and `workspace.dependencies` entries intact.

**Tests:** `cd tugrust && cargo nextest run` (whole workspace) green; `cargo build` green (`-D warnings`);
the re-homed CLI tests pass; `cargo run -p tug -- --help`, `-- host --help`, `-- dash --help`, and bare
`cargo run -p tug` (splash) render the expected shapes.

**Checkpoint:** `cargo nextest run` reports zero failures with the three old bin crates gone and
`crates/tug` present; `tug --help` lists `changes/context/commit/log/diff`, `dash`, `host`; `tugutil host --help`
lists `instance/gate/state-dir/tell/init` (no `resolve`/`version`); `tug --version` prints `0.8.0 (<hash>)`.

### Step 2 — Retarget the justfile {#step-2}

**Commit:** `tug(unify): justfile builds/symlinks/calls the single tug binary`

**Depends on:** #step-1

**References:** [P03] [P04] [R03] [R06], #dd-call-sites

**Tasks:**
1. Replace both `cargo build … -p tugutil -p tugdash -p tugmark …` invocations with `-p tug`.
2. In the `~/.local/bin` symlink loop, drop `tugutil tugdash tugmark`, add `tug` (keep the
   main-checkout-only guard, [R03]). In that **same** main-checkout branch, add
   `rm -f ~/.local/bin/{tugutil,tugdash,tugmark}` so the retired names don't dangle after a
   post-join `main` rebuild ([R06]).
3. Rewrite every `tugrust/target/debug/tugutil instance …` → `tugrust/target/debug/tugutil host instance …`
   (prune-warn, stop, remove, the reap `TUGUTIL=` variable + its build fallback, all kill loops, the
   `just instances`/`just instance-remove` wrappers).
4. Rewrite `tugutil gate …` → `tugutil host gate …` (the app-test gate `exec …/tug host gate run --name apptest …`
   and its build fallback) and `tugutil state-dir` → `tugutil host state-dir` (sentinel-file + sentinel-dir
   resolution, both the PATH form and the `tugrust/target/debug/` fallback form).
5. Update comments naming the old binaries as commands (incl. the `tugdash join|release` comment).

**Tests:** `just build` green; `ls -l ~/.local/bin/tugutil` resolves into `tugrust/target/debug/tugutil`;
`tugutil host instance list` and `just instances` succeed; `tugutil host state-dir` prints the project dir.

**Checkpoint:** `just build` produces `tug` and its symlink (no `tugutil`/`tugdash`/`tugmark` symlink
created, and any pre-existing ones removed), and `just instances` lists instances through
`tugutil host instance list`.

### Step 3 — Retarget distribution scripts + app bundle {#step-3}

**Commit:** `tug(unify): bundle, sign, and release-build the single tug binary`

**Depends on:** #step-1

**References:** [P03], #dd-call-sites, #success-criteria

**Tasks:**
1. **pbxproj:** in the copy build-phase, replace the `tugutil`/`tugdash`/`tugmark` entries in both the
   input-file list and the output-file list with a single `tug`; in the `shellScript` `for bin in …`
   loop, replace the three names with `tug`.
2. **sign-bundle.sh:** in `RUST_BINS=(…)`, replace the three with `tug`; fix the comment listing the
   Rust helpers.
3. **build-release-inputs.sh:** replace `-p tugdash -p tugmark … -p tugutil` with `-p tug`; fix the
   header comment listing populated binaries.
4. **build-app.sh:** replace the `cp …/release/tugutil …/MacOS/` line with `tug`; fix the comment.
5. **quit-tug-bundle.sh:** point `TUGUTIL` at `…/tug`, change the call to `host instance stop`, update comments.

**Tests:** `just app-debug` from the worktree builds + signs + launches a `(debug, <branch>)` instance;
`just instances` shows it; `codesign -dv "<bundle>/Contents/MacOS/tugutil"` verifies a valid signature;
`"<bundle>/Contents/MacOS/tugutil" --version` runs.

**Checkpoint:** the debug bundle contains a signed `Contents/MacOS/tugutil`, no `tugutil`/`tugdash`/`tugmark`
binaries, and the app launches to a live instance.

### Step 4 — Swift host: ProcessManager takeover kill {#step-4}

**Commit:** `tug(unify): ProcessManager takeover uses bundled tugutil host instance stop`

**Depends on:** #step-3

**References:** [A03] [R04], #dd-call-sites

**Tasks:**
1. In `ProcessManager.swift`, change `resolveBundledTool("tugutil")` → `resolveBundledTool("tug")`
   and prepend `"host"` to the argument vector so it invokes `tugutil host instance stop <id> --timeout …`.
2. Update the surrounding doc comments (`Contents/MacOS/` helper list, the takeover-kill comment) to name `tug`.

**Tests:** `just app-debug` rebuilds the app (xcodebuild) green; the app launches; invoke
`"<bundle>/Contents/MacOS/tugutil" host instance stop --help` from the signed bundle to confirm the arg path
resolves (the live takeover race is not app-testable, [R04]).

**Checkpoint:** the app builds and launches with the Swift change; the bundled `tugutil host instance stop`
help runs from `Contents/MacOS/`.

### Step 5 — Skills, frontend allowlist, hook, app-test harness {#step-5}

**Commit:** `tug(unify): skills, command-enhancer, auto-approve, and harness speak tug`

**Depends on:** #step-1

**References:** [P03] [P04] [P05], #dd-call-sites

**Tasks:**
1. **tugplug skills:** in `commit`, `implement`, `dash`, `audit` `SKILL.md`, rewrite `tugmark <verb>` →
   `tug <verb>`, `tugdash <verb>` → `tugutil dash <verb>`, `tugutil state-dir` → `tugutil host state-dir`.
   (The `dash join`/`create`/`commit` lifecycle references become `tugutil dash …`.)
2. **enhance-commands.ts:** `SHELL_COMMAND_TOOLS` → `["just", "tug"]`; update the doc comment; in
   `__tests__/enhance-commands.test.ts` rewrite the fixtures to `tug`/`tugutil host state-dir`/`tugutil dash join`
   forms (incl. the bare-tool-name-plus-space case → `"tug "`).
3. **auto-approve-tug.sh:** collapse the `tugutil`/`tugmark` `case` arms into one `tug\ *|tug) APPROVE=true`
   (retain the `tugtool` arm if it denotes the repo umbrella).
4. **app-test `_harness/index.ts`:** change the `spawnSync` `cmd` from `["tugutil","instance","stop",…]`
   to `["tug","host","instance","stop",…]`; update comments. **Note the resolution caveat:** the
   spawn uses the bare name (PATH-resolved), and a linked dash worktree creates no `~/.local/bin/tugutil`
   symlink — so during this run's own `just app-test` the teardown spawn throws, is caught, and the
   existing SIGTERM+tmux fallback reclaims the instance (same best-effort contract as today's bare
   `tugutil`). The `tugutil host instance stop` path gets real coverage from the post-join `main` run,
   where the symlink exists. If true in-dash coverage is wanted, resolve the binary at the bundle's
   `Contents/MacOS/tugutil` absolute path instead of the bare name — but that exceeds strict parity.

**Tests:** `bun test tugdeck/src/lib/markdown/__tests__/enhance-commands.test.ts` green; `bunx vite build`
green (production rollup); `just app-test` full sweep → `VERDICT: PASS` (the `tugutil host instance` teardown
resolves post-join; in-dash it falls back to SIGTERM+tmux — either way the instance is reclaimed and the
verdict passes; `tugutil host gate` is exercised directly as the app-test gate).

**Checkpoint:** the enhancer recognizes `tug`/`tugutil host`/`tugutil dash` command lines, the production bundle
builds, and `just app-test` passes.

### Step 6 — Integration checkpoint + residual-reference sweep {#step-6}

**Commit:** `tug(unify): residual-reference sweep, docs, and live end-to-end verification`

**Depends on:** #step-2, #step-3, #step-4, #step-5

**References:** [R01] [R02], #success-criteria, #test-plan-concepts

**Tasks:**
1. Grep the whole tree (excluding `dash/archive/**`) for `tugutil `/`tugdash `/`tugmark ` used as an
   *invoked binary*. Distinguish and **keep**: the `*-core` crate names, `tugmark_core::`/`tugdash_core::`/
   `tugutil_core::` Rust paths, `workspace.dependencies`, and any historical archive text. **Fix** every
   remaining command-form reference on a live surface (CLAUDE.md, non-archive `dash/**`, `tuglaws/**` if any).
2. Update `CLAUDE.md`'s repository-structure / tooling prose to describe the single `tug` CLI.
3. Full `cd tugrust && cargo nextest run` (whole workspace) green.
4. Live end-to-end from `tugrust/target/debug/tugutil` (env-scrub `TUG_INSTANCE_ID`/`TUG_SESSION_ID` as
   needed): `tugutil context` → `tugutil commit --message "<m>"` and diff the receipt vs `git show --numstat`;
   `tugutil dash list`; `tugutil host instance list`; `tugutil host state-dir`. Confirm each `--json` matches the
   pre-migration envelope shape ([R02]).
5. `just app-test` full sweep → `VERDICT: PASS`.

**Tests:** `cargo nextest run` green; the residual grep returns zero command-form hits on live surfaces;
the live `--json` outputs match the documented envelope; `just app-test` passes.

**Checkpoint:** whole-workspace tests green, no live surface invokes the retired binaries, and the live
`tug` end-to-end (context→commit receipt matching `git show --numstat`, dash/host verbs) succeeds.

## Deliverables {#deliverables}

- `tugrust/crates/tug/` — the single unified binary (clap tree + re-homed command modules + `build.rs` + tests).
- Deleted `tugrust/crates/{tugutil,tugdash,tugmark}/` bin crates; updated `workspace.members`.
- Retargeted justfile, `project.pbxproj`, `sign-bundle.sh`, `build-release-inputs.sh`, `build-app.sh`, `quit-tug-bundle.sh`, `ProcessManager.swift`.
- Migrated `tugplug` skills (`commit`/`implement`/`dash`/`audit`), `enhance-commands.ts` + its test, `auto-approve-tug.sh`, app-test `_harness/index.ts`.
- Updated `CLAUDE.md` and non-archive docs; retired `resolve`/`version` verbs.
- Green `cargo nextest run`, green `bunx vite build`, `just app-test` `VERDICT: PASS`, and a live `tug` end-to-end demo.
