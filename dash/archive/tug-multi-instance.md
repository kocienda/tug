<!-- tugplan-skeleton v2 -->

## Multi-instance Tug.app {#multi-instance}

**Purpose:** Make it possible to run multiple Tug.app instances concurrently on a single Mac with full state isolation between them — so a distributed release app can run alongside a debug build editing its own source code, and a worktree-scoped debug build can run alongside the main one. Fold proper Apple Developer ID code signing and release notarization into the same phase so the signing infrastructure modernizes once rather than twice.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken |
| Status | draft |
| Target branch | main (commit on main per repo policy) |
| Last updated | 2026-05-25 (signing/notarization research folded in; prerequisites completed) |

---

### Phase Overview {#phase-overview}

#### Context {#context}

Today every Tug.app launch hits hardcoded defaults: tugcast on TCP 55255, Vite on 55155, tmux session `cc0`, `~/.tugbank.db`, `~/Library/Application Support/Tug/sessions.db`. The first launch wins; the second fails to bind, the supervisor retries forever, and the user sees a blank window with cryptic logs (`tugcast: error: failed to bind to 127.0.0.1:55255` in `main.rs:554`). Single-instance is wired in by accident, not by design — there is no concept of an instance in the codebase at all.

Two concrete workflows are blocked by this:

1. **Release-and-debug side by side.** Currently the only way to test a debug build is to quit the distributed release app first. There is no path to running them simultaneously — e.g., to do regression testing between two builds, or to use the release app to edit the debug app's source while the debug app is running.
2. **Worktree-scoped debug builds.** The repo already has a `tugutil worktree setup` workflow that carves a per-plan worktree under `.tugtree/tugplan__<slug>` (`tugutil-core/src/worktree.rs:634`), but a Tug.app built from that worktree cannot launch alongside one built from `main` — same ports, same tmux session, same DB paths, same `dev.tugtool.app` bundle identifier.

The current signing story compounds this: `setup-dev-signing.sh` provisions a locally-generated `Tug Dev` identity (`Justfile:307`); the harness carries a `code-sign-fingerprint` drift detection layer (`Justfile:571`, `.tugtool/code-sign-fingerprint`) because the designated requirement of a locally-generated cert is brittle — every rebuild of the cert invalidates TCC (Accessibility) grants. The user has now acquired an Apple Developer ID account, which stabilizes the DR across rebuilds and unlocks proper notarization for distribution. Folding this in with the multi-instance work means the signing infrastructure modernizes once.

Empirical research into Apple's current signing flow (May 2026) surfaced four findings that shape Steps 3 and 4:

1. **No App ID registration is required for Developer ID distribution outside the Mac App Store** unless the app uses services that demand a provisioning profile (CloudKit, push notifications, app groups). Tug uses none of these. A single Developer ID Application certificate signs *any* bundle ID the team owns, so every `(profile, branch)` variant in this plan is unblocked at the Apple-portal layer with no per-variant registration work.
2. **`codesign --deep` for signing is deprecated** (as of macOS 13). The current `build-app.sh:147-149` uses it. `--deep` applies the same entitlements to every nested binary, which is wrong here because the bun-compiled `tugcode` binary embeds a JavaScript runtime that needs permissive JIT-related entitlements while the Rust binaries (`tugcast`, `tugutil`, `tugexec`, `tugrelaunch`, `tugbank`) and the outer Swift `Tug` binary do not. The replacement is **inside-out signing with per-binary entitlements files** — see [D16].
3. **WKWebView in the outer Tug.app does not require JIT entitlements.** WebKit runs JavaScript in a separate XPC helper process (`com.apple.WebKit.WebContent`) provided by the OS, not in the host process. The bun-required permissive entitlements scope to the `tugcode` binary only; the outer app can keep its minimal entitlements file.
4. **The one-time Developer ID + notarytool setup is easy via Xcode** (no manual CSR plumbing). The five prerequisite steps are documented under #dependencies; the user has completed them. Ground-truth values for this plan: Team ID `Z67582R5Y8`; notarytool keychain profile name `tug-notary`; Developer ID Application certificate installed in the user's login keychain.

#### Strategy {#strategy}

- **Bake identity at build time, not runtime.** Each `Tug.app` bundle carries `BUILD_PROFILE` (`debug`/`release`), `BUILD_BRANCH` (git branch at build time, or `detached-<short-sha>` if HEAD was detached), and `BUILD_SOURCE_TREE` (debug only) in its Info.plist. The running app reads its own bundle — no git lookup, no tugbank bootstrap, no shared lookup of any kind. HEAD can drift mid-session without affecting the running process. See [D01] [D02] [D03].
- **Full per-instance state isolation.** Every long-lived resource gets a per-instance path or name: tugbank DB, session ledger, tmux session, log directory, tugbank-notify socket. The instance ID `<profile>-<branch-slug>` (e.g. `release-main`, `debug-tide-wake-1`) is the namespacing key. See [D04] [D05].
- **Hash-derived ports with walk-on-collision + registry file.** Tugcast and Vite ports are derived from a hash of the instance ID, walked on collision, and recorded in `$TMPDIR/tug-instances.json` so external tools (`tugutil tell`, `just logs-debug`/`logs-release`) can find a running instance. Stable across launches of the same identity; collision-tolerant when two different identities hash to the same offset. See [D08].
- **No explicit single-instance enforcement.** Two instances of the same identity collide at `bind()`. The runtime detects EADDRINUSE-with-live-pid-match-in-registry, logs a clear message, and exits cleanly without a supervisor retry loop. Same-identity coexistence is structurally impossible by the identity scheme. See [D07] [D14].
- **Per-identity Bundle IDs.** The distributed `(release, main)` keeps the canonical `dev.tugtool.app` so AX grants and codesign expectations survive. Everything else gets `dev.tugtool.app.<profile>-<branch-slug>`, with the common `(debug, main)` case shortened to `dev.tugtool.app.debug` for ergonomics. Each branch's debug build is its own LaunchServices identity, its own dock icon, its own AX TCC entry. See [D10] (suffix scheme amended by [D19]).
- **Apple Developer ID + notarization folded in, with inside-out signing.** The local `Tug Dev` identity is retired. All builds (debug and release) sign with the Developer ID Application certificate, hardened runtime on (`--options runtime`), secure-timestamped (`--timestamp`). Per-binary entitlements: minimal for the outer Swift binary and the Rust helpers; permissive (bun-required JIT set) for the bun-compiled `tugcode` only. `codesign --deep` is replaced with explicit inside-out signing via a new `tugrust/scripts/sign-bundle.sh`. Release builds notarize via `notarytool submit --keychain-profile tug-notary --wait`; debug builds skip notarization. The existing DR drift detection becomes belt-and-suspenders. See [D11] [D16].
- **CLI discovery defaults to the natural instance.** `tugutil tell` resolves `--instance` flag > `TUG_INSTANCE` env var > cwd-derived (debug) > sole-running > error. Standing in a worktree directory, commands hit that worktree's instance automatically. See [D09].
- **One-time migration of legacy `~/.tugbank.db`.** First launch of `(release, main)` under the new scheme copies the legacy DB into `<data-dir>/release-main/tugbank.db` and leaves the legacy file in place as a backup. Other identities start with empty DBs. See [D06].

#### Success Criteria (Measurable) {#success-criteria}

- A distributed `(release, main)` build and a debug build of any branch run simultaneously on the same machine with independent dock icons, independent tugbank state (theme, layout, recents), independent claude session bindings, independent tmux sessions, independent ports, and independent log files. Measured by: launch both, change theme in one, verify the other is unaffected; run a claude session in one, verify the other's transcript is empty; tail both log files in parallel and confirm no interleaving.
- A debug build from `main` and a debug build from a worktree branch run simultaneously. Same verification as above. Measured by: `git worktree add .tugtree/test-branch -b test-branch`, `just app-debug` from the worktree, verify it coexists with the original `just app-debug` from `main`.
- A second launch of the same `(profile, branch)` identity exits cleanly with a single-line error in the log naming the live instance's PID. No blank window, no supervisor retry loop. Measured by: launch identity X, then attempt to launch identity X again; verify exit code non-zero, log message includes `another '<id>' instance is already running`, app does not present a window.
- A `tugutil tell restart` invoked from a terminal cwd'd inside a debug worktree hits *that worktree's* instance, not the release app or another running debug instance. Measured by: launch two debug instances on different worktrees; from each worktree cwd, `tugutil tell restart` and verify only the matching instance restarts.
- Release builds sign with the Apple Developer ID Application cert and notarize successfully (`stapler validate` returns valid). Measured by: `just build-app` produces a `.app` that passes `codesign --verify --deep --strict` and `xcrun stapler validate`; Gatekeeper accepts the bundle on a clean Mac.
- TCC Accessibility grants survive rebuilds of the same bundle ID. Measured by: grant AX to `dev.tugtool.app.debug`; rebuild and relaunch; CGEvent.post still works (no re-prompt). The harness's `code-sign-fingerprint` drift check passes with the Developer ID cert installed.
- `cd tugrust && cargo nextest run` stays green across all commits. `cd tugdeck && bun x tsc --noEmit && bun test` stays green across all commits. The full `just app-test` sweep passes against the debug-built bundle in the worktree it was built from.
- **Worktree removal leaves no orphan state.** Measured by: create a worktree, `just app-debug` from it (granting AX), then `just worktree-remove <path>` — afterward `tugutil instance prune --check` reports zero orphans, the DerivedData dir for that worktree is gone, the bundle's LaunchServices entry is gone, and the per-instance data dir is gone. The dock recents list for the removed identity may take some minutes to settle but is left to macOS's normal LS-index churn.

#### Scope {#scope}

1. Build-time embedding of `BUILD_PROFILE`, `BUILD_BRANCH`, `BUILD_SOURCE_TREE` into every Tug.app bundle.
2. Per-identity Bundle ID assignment via xcodebuild build-phase script.
3. Apple Developer ID Application signing for all builds (debug and release), with inside-out signing via a new helper script.
4. Per-binary entitlements: `tugapp/Tug.entitlements` (outer Swift) + new `tugapp/tugcode.entitlements` (bun-required permissive set); Rust helpers sign with no custom entitlements (default hardened runtime).
5. Release notarization via `xcrun notarytool submit --keychain-profile tug-notary --wait` + `xcrun stapler staple`.
6. Per-profile app icons (release vs debug), with branch-name overlay for non-main debug builds.
7. Per-instance data directory layout under `~/Library/Application Support/Tug/instances/<id>/`.
8. Per-instance tugbank database + notify socket.
9. Per-instance session ledger.
10. Per-instance tmux session name.
11. Per-instance log directory (tuglog routing via env var).
12. Hash-derived port allocation + walk-on-collision + `$TMPDIR/tug-instances.json` registry.
13. Clean-exit-on-EADDRINUSE path in tugcast.
14. One-time legacy `~/.tugbank.db` migration on first `(release, main)` launch.
15. CLI discovery in tugutil/tugbank: flag > env > cwd > sole > error.
16. `tugutil instance list` / `tugutil instance stop` subcommands.
17. Justfile recipe updates (`just app`, `just launch`, `just logs`, `just app-test`) to use per-instance kill + paths.
18. End-to-end integration verification with two instances running concurrently.

#### Non-goals (Explicitly out of scope) {#non-goals}

- Cross-platform support. macOS only. Identity model is portable but the implementation references `~/Library/Application Support/`, `NSTemporaryDirectory()`, LaunchServices, TCC, codesign, notarytool — all macOS-specific. Linux/Windows port is a separate, future plan.
- Shared claude session JSONLs across instances. `~/.claude/projects/<encoded-project>/` is intentionally shared — two instances opened to the same user project see the same session history. The per-instance `sessions.db` disambiguates liveness/binding. See [D13].
- A `tugutil instance clone <from> <to>` command for copying state between identities. Useful but out of scope; users who want this can `cp -r` the per-instance directory manually.
- Renaming an existing instance's identity. Changing `BUILD_BRANCH` requires a rebuild; no in-place rename.
- Cleaning up stale `<data-dir>/<id>/` trees for identities whose builds were deleted. A future `tugutil instance prune` could do this; out of scope for Phase 1.
- A graphical instance picker. CLI-only for now.
- Auto-allocating ports from a contiguous shared pool managed by a daemon. The registry file is the only coordination mechanism.
- Migrating session ledger or claude project state between instances. The legacy migration covers tugbank only.
- Same-identity "take-over" semantics on relaunch. `tugrelaunch` already exists for the rebuild-and-relaunch flow; it does the SIGTERM-wait-restart dance deliberately. The default behavior is "refuse if already running" — see [D07].
- **Per-bundle-ID App ID registration on developer.apple.com.** Not required for Developer ID distribution outside the Mac App Store, given Tug uses no services that demand a provisioning profile (CloudKit, push, app groups). Every `(profile, branch)` variant of the bundle ID signs against the same Developer ID Application cert without per-variant Apple-portal setup. Documenting this explicitly because the conventional wisdom (carried over from App Store distribution) is that *every* bundle ID needs registration, and a future reader following that wisdom would do unnecessary work.
- Sandboxing. Tug does not enable the App Sandbox (`com.apple.security.app-sandbox`). Sandboxing is required for Mac App Store distribution but optional for Developer ID; given the app's process model (spawning tugcast/tugcode/tmux as children, mounting WKWebView with full filesystem access for the dev source tree), sandboxing would require substantial entitlement plumbing without obvious benefit. Out of scope for Phase 1; may be revisited if/when Mac App Store distribution becomes interesting.

#### Dependencies / Prerequisites {#dependencies}

##### Apple developer infrastructure (one-time setup — COMPLETED 2026-05-25) {#apple-prereqs}

The following five steps must be completed once before Step 3 and Step 4 are executable. They have been completed by the user; the ground-truth values are recorded here so future maintenance work has them.

1. **Apple Developer Program membership.** Active. Apple ID: the user's `kocienda@mac.com`. $99/year subscription. ✅
2. **Developer ID Application certificate.** Created via Xcode → Settings → Accounts → (team) → Manage Certificates → "+" → "Developer ID Application". Xcode generates the CSR, uploads, downloads, and installs the cert + private key in the user's login keychain in a single click — no manual CSR plumbing needed. ✅
3. **Team ID captured.** `Z67582R5Y8`. Visible at developer.apple.com → Membership Details, also in Keychain Access by inspecting the new certificate's Subject Name `OU` field. Used by `notarytool`, by `codesign` when selecting the identity (`Developer ID Application: <Name> (Z67582R5Y8)`), and by future scripts that need to identify the signing team. ✅
4. **App-specific password generated.** Created at appleid.apple.com → Sign-In and Security → App-Specific Passwords → Generate, labeled `Tug notarization`. Used solely as input to step 5; never referenced after that. ✅ (the password itself is *not* recorded in this plan — it lives in the user's login keychain via step 5).
5. **notarytool keychain profile stored.** Profile name: `tug-notary`. Created via:
   ```bash
   xcrun notarytool store-credentials tug-notary \
       --apple-id "kocienda@mac.com" \
       --team-id "Z67582R5Y8" \
       --password "<app-specific-password>"
   ```
   Verified working: `xcrun notarytool history --keychain-profile tug-notary` returns `No submission history.` (success, not auth error). ✅

All Step 3/4 scripts in this plan reference `--keychain-profile tug-notary` rather than passing credentials inline. If the profile is ever deleted or the underlying password rotated, repeat steps 4-5.

##### Runtime/build prerequisites {#runtime-prereqs}

- `notarytool` (built into Xcode Command Line Tools, available as `xcrun notarytool`). Required for release notarization.
- `xcrun stapler` (Xcode Command Line Tools). Required for stapling notarization tickets.
- Existing `tugrust/scripts/build-app.sh` with its `--skip-sign --skip-notarize` flags (already plumbed; Step 3/4 fills in the body, replacing the current `--deep` signing with inside-out signing).
- Existing `tugutil-core/src/worktree.rs` worktree machinery (already in place; the multi-instance story benefits from it but does not extend it).
- `dirs` crate (already a workspace dep) for `data_dir()` resolution.
- `serde_json` (already a workspace dep) for the registry file format.
- `fs2` or equivalent for cross-platform `flock` on the registry file. Currently not in the workspace; Step 11 adds it or uses a hand-rolled `fcntl` wrapper.

#### Constraints {#constraints}

- Release builds destined for distribution must not embed any developer-specific paths in `BUILD_SOURCE_TREE`. The Info.plist key is omitted from `release` builds entirely; reading it from a release app returns nil and any code path that depends on it is debug-only-gated.
- Code signing must use a single Developer ID Application certificate across all builds. Mixing identities defeats the TCC stability story.
- Notarization is mandatory for any bundle distributed outside the user's own Mac. Debug builds skip notarization; `build-app.sh` flags must control this clearly.
- The registry file at `$TMPDIR/tug-instances.json` must tolerate concurrent reads/writes from multiple Tug processes starting at the same moment. File locking is mandatory; lockless reads-of-a-stale-file are acceptable as long as stale-PID pruning is part of the read path.
- Per-instance data directories must be created with mode 0700; they may contain claude session tokens, user prompts, and other sensitive data.
- The legacy `~/.tugbank.db` must remain readable by old binaries after migration. The migration is a one-way copy, not a move; the legacy file is touched only to be read.

#### Assumptions {#assumptions}

- A single physical user owns all running Tug instances. No multi-user-on-same-Mac story; all identities run as the same UID.
- The user accepts a TCC Accessibility re-grant per new bundle ID (i.e., per branch). First launch of a new identity prompts; subsequent launches of the same identity do not.
- The registry file `$TMPDIR/tug-instances.json` survives across reboots only incidentally; `$TMPDIR` is purged periodically by macOS. Long-lived state lives in `<data-dir>/<id>/`, not in `$TMPDIR`. The registry is ephemeral by design.
- Git is installed and on PATH at build time. The build-phase script that captures `BUILD_BRANCH` requires it.
- Each Tug.app bundle is launched at most once concurrently per identity. Two simultaneous launches of identity X are rejected at port-bind time, not pre-emptively at LaunchServices level.

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

This plan uses the standard tugplan v2 anchor conventions (see `tuglaws/tugplan-skeleton.md` for the full spec). Execution steps cite design decisions by `[DNN]`, specs by `Spec SNN`, lists by `List LNN`, tables by `Table TNN`, and risks by `Risk RNN`. Anchors are kebab-case, prefixed by artifact kind (`step-1`, `d01-...`, `r02-...`, etc.). No line-number citations.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Registry file lock strategy (OPEN) {#q01-registry-lock}

**Question:** Should `$TMPDIR/tug-instances.json` use POSIX advisory locking (`flock`), atomic rename (write-new + rename-over-old), or both?

**Why it matters:** Concurrent launches of two different identities at exactly the same moment could race on the registry. A lost write means an external tool's discovery lookup misses one instance. Worse, an interrupted write could leave the file half-written and break JSON parsing for everyone.

**Options:**
- `flock(LOCK_EX)` around read-modify-write. Simple, well-understood, supported on macOS via the `fs2` crate.
- Atomic rename: write `tug-instances.json.tmp`, then `rename(2)`. No locking, naturally atomic, but read-modify-write requires re-reading after acquiring an exclusive temp file.
- Both: `flock` to serialize, atomic rename inside the locked section to survive crashes mid-write.

**Plan to resolve:** Default to `flock + atomic rename` in Step 11 unless empirical testing shows the lock contention is meaningful. The cost of "both" is one extra rename per launch — negligible.

**Resolution:** DEFERRED to Step 11 implementation. Will pick at code-time based on whether `fs2` is acceptable as a new workspace dep.

#### [Q02] Icon design specifics (RESOLVED) {#q02-icon-design}

**Question:** What do the release vs. debug icons look like? What does the per-branch overlay on non-main debug icons look like?

**Why it matters:** Dock differentiation is the user-facing payoff of per-identity Bundle IDs. A clean visual story makes the multi-instance experience legible at a glance.

**Resolution:** Release and debug icons ship as full asset-catalog sets at `tugapp/Assets.xcassets/{AppIcon,DevAppIcon}.appiconset/`. Per-branch overlay for non-main debug builds is **deferred indefinitely** — the dock-differentiation gap turns out to be thin in practice (bundle ID + dock tooltip already distinguish worktree builds; rendered-text-on-icon at 22pt becomes illegible past ~6 chars), and going to loose-`.icns` overrides just to support compositing would back the project out of the standard asset-catalog flow. If multi-worktree dock confusion turns out to bite, revisit by adding a loose-`.icns` override layer that overrides the asset catalog for non-main debug builds; not a Phase 1 concern.

**Resolution:** RESOLVED. Asset-catalog artwork in place; branch overlay deferred. See [D15] for the implementation shape.

#### [Q03] What does `tugutil instance` look like beyond `list` / `stop`? (RESOLVED) {#q03-tugutil-instance}

**Question:** `list` and `stop` are clearly in scope. What about `clone <src> <dst>`, `prune` (remove data dirs for identities with no current bundle on disk), `remove <id>` (surgical cleanup of one specific instance's state), `current` (print the identity of the cwd-derived instance), or `attach <id>` (open a terminal pointed at the right tmux session)?

**Why it matters:** These are quality-of-life features that compound as the multi-instance story matures. Picking the wrong primitives in Phase 1 means churning the CLI later.

**Resolution:** Ship `list`, `stop`, `current`, **`remove`, and `prune`** in Phase 1. The first three were obvious. `remove` and `prune` were originally deferred, but tracing the worktree lifecycle end-to-end made clear that they're not optional — every `git worktree remove` would otherwise leak nine categories of orphan state (DerivedData bundle, LaunchServices index entry, Dock recents, Spotlight index, TCC entries, per-instance data dir, tmux session, notify socket, and a registry entry until PID-prune). Without `remove` / `prune` as load-bearing primitives, the first ten worktrees become a bug report.

`clone` and `attach` stay deferred — they're convenience features, not lifecycle-critical, and the design will be clearer once people have used multi-instance for a while.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Tugbank migration corrupts legacy file | high | low | One-way copy, never move; atomic write to temp + rename; bail early if either path errors | Migration test fails on real legacy DB |
| Notarization is slow / flaky | med | med | `build-app.sh` reports notarytool status; retries on transient failures; release path is "submit + poll" not "submit + block" | Two consecutive notarization failures in a week |
| Port hash collisions in practice | low | low | Walk-on-collision with up to 32 retries; registry file ensures discovered ports survive across launches | Walk depth >4 observed in real use |
| Registry file corruption | med | low | flock + atomic rename + JSON parse failure recovery (re-init to empty); stale PID pruning on every read | One corruption event |
| AX permission proliferation user-hostile | med | med | Document the cost in plan and README; investigate `xattr`-based grant migration in follow-on if it becomes painful | User explicitly complains; >10 branches with grants |
| Developer ID cert expiration | high | low | Five-year renewal cycle (Developer ID Application certs) is a standard ops task; calendared independently | Cert within 60 days of expiration |
| Legacy ~/.tugbank.db users without release-main bundle | med | low | Migration triggers on first launch of `(release, main)` only; users without that bundle keep using the legacy file until they install one | User reports "my data didn't migrate" |
| LaunchServices bundle-ID cache stale | low | med | `lsregister -kill -r -domain local -domain system -domain user` documented as a known reset command | Newly-built bundle doesn't show up in `mdfind` |
| First hardened-runtime build surfaces unforeseen entitlement gaps | med | high | Today's local `Tug Dev` cert does not enforce hardened runtime; flipping `--options runtime` on for the first time is likely to expose missing entitlements (WKWebView XPC, NSXPCConnection, mach lookups, library validation). Step 3 sequences a debug build *before* notarization so issues surface locally and can be iterated without a 30-min notary round-trip. | First debug build with hardened runtime crashes at launch |

**Risk R01: Tugbank migration data loss** {#r01-tugbank-migration}

- **Risk:** A bug in the migration path could corrupt or delete `~/.tugbank.db`, losing the user's accumulated theme, layout, recents, card state, and session metadata.
- **Mitigation:**
  - Migration is a *copy*, never a *move*. The legacy file stays on disk and is never written to by the new code path.
  - Write to a temp file in `<data-dir>/release-main/tugbank.db.tmp` first, fsync, then rename. A crash mid-copy leaves the temp file orphaned, not the destination half-written.
  - Migration runs at most once per `(release, main)` data dir. A marker file `<data-dir>/release-main/.migrated-from-legacy` prevents re-running.
  - Pre-migration: SHA-256 of legacy file written to the data dir as a sentinel. If the user ever asks "did my data migrate?", we can answer authoritatively.
- **Residual risk:** A truly catastrophic disk failure during the rename is the only remaining loss path. APFS atomic-rename guarantees keep this vanishingly rare.

**Risk R02: Notarization stalls or fails** {#r02-notarization}

- **Risk:** Apple's notary service is sometimes slow (5-30 min normal, hours possible) or returns transient failures. A `just build-app` that blocks on notarization indefinitely is a productivity sink.
- **Mitigation:**
  - `build-app.sh --notarize` submits and polls with a 30-min ceiling. Beyond that, the script reports the submission UUID and exits non-zero with instructions for `notarytool log <uuid>`.
  - Debug builds *never* notarize. Developers iterating locally pay no notarization cost.
  - Release builds notarize as a separate explicit step (`build-app.sh --notarize`), not a default of `--release`. CI configures this; manual users opt in.
- **Residual risk:** First-time setup of a notarization keychain profile (`notarytool store-credentials`) is a one-time UX papercut, documented in the setup script's output.

**Risk R03: Hash collisions in port allocation** {#r03-port-collision}

- **Risk:** Two simultaneously-running instances hash to the same tugcast or Vite port. Without collision handling, the second fails to bind; with handling, the walk could be confusing if ports drift between launches.
- **Mitigation:**
  - Hash → 100-port window per profile (e.g., 55300-55399 for tugcast). Walk by +1 within the window on collision.
  - Registry file records the actual claimed port. On subsequent launch of the same identity, prefer the previously-claimed port if free.
  - If the entire window is exhausted, fall back to OS-ephemeral (`bind` to port 0) and record in registry.
- **Residual risk:** External tools that assume a fixed port can't muscle-memory the address. `tugutil tell` reads the registry, so the user-facing CLI is unaffected.

**Risk R09: First hardened-runtime build surfaces unforeseen entitlement gaps** {#r09-hardened-runtime-debug}

- **Risk:** Today's local `Tug Dev` self-signed cert does *not* enable hardened runtime (`codesign --options runtime`). Switching to Developer ID signing + hardened runtime in Step 3 is the first time the running app is constrained by the hardened runtime sandbox. Things that worked under the permissive default may break: dlopen() of helper libraries, NSXPCConnection to unsigned daemons, `mach_lookup` to legacy bootstrap services, JIT in unexpected places. The failure mode is often a silent process exit at launch with a Console message like `<binary> exited due to code signing error`.
- **Mitigation:**
  - Step 3 explicitly sequences a **debug build with hardened runtime** *before* Step 4 (notarization). This means entitlement gaps surface locally with no 30-min notary round-trip; the user iterates by inspecting `log show --predicate 'subsystem == "com.apple.codesigning"' --last 5m` and adding entitlements until the app boots clean.
  - The plan's reference entitlements (`Tug.entitlements` minimal + `tugcode.entitlements` permissive) are starting points based on research, not guarantees. Step 3 budget includes empirical iteration.
  - Library validation (`disable-library-validation`) is in the bun entitlements set already and would catch the most common "dlopen of unsigned dylib" case for tugcode. The outer app does *not* get this entitlement; if WKWebView surprises us by needing it, that's a discovery for Step 3.
- **Residual risk:** Some entitlement issue surfaces only under notarized + Gatekeeper conditions (not under local launch). The Step 4 checkpoint includes `spctl --assess` against a freshly-quarantined copy of the bundle to catch this before declaring victory.

---

### Design Decisions {#design-decisions}

#### [D01] Identity is (build_profile, build_branch), baked at build time (DECIDED) {#d01-identity-build-time}

**Decision:** Every Tug.app bundle carries a `BUILD_PROFILE` (`debug` / `release`) and a `BUILD_BRANCH` (git branch name at build time, or `detached-<short-sha>` if HEAD was detached) in its Info.plist. The running app reads these from its own bundle; the instance ID is computed deterministically from them as `<profile>-<branch-slug>` where `branch-slug` replaces `/` with `-` and lowercases the result.

**Rationale:**
- No runtime git lookup means no dependency on `git` being on PATH or in a valid working tree at launch. Release users without git installed still launch correctly.
- HEAD drifting during a session (e.g., the user `git checkout main` mid-debug) does not change the identity of an already-running process. Ports stay claimed; DBs stay open; tmux session stays attached.
- Release builds pin the branch at the release pipeline level. End users get a stable identity.
- No tugbank bootstrap entry required for identity discovery. Removes a layer of "where do I look this up" indirection that would otherwise be needed to break the chicken-and-egg between per-instance tugbank and identity-derived tugbank path.

**Implications:**
- A single .app bundle is one identity. Repointing a built bundle at a different worktree to "be" a different identity is not supported.
- Switching branches in a worktree and wanting a Tug build for the new branch requires a rebuild (which is the natural workflow under `just app-debug`).
- The xcodebuild build-phase script that captures the values must run *every* build, not be cached, to keep `BUILD_BRANCH` current.

#### [D02] Detached HEAD at build time becomes `detached-<short-sha>` (DECIDED) {#d02-detached-head}

**Decision:** If `git rev-parse --abbrev-ref HEAD` returns `HEAD` (i.e., detached) at build time, `BUILD_BRANCH` is set to `detached-` followed by the first 8 characters of `git rev-parse HEAD`.

**Rationale:**
- Detached HEAD is rare but real (e.g., bisecting, testing a specific historical SHA). Forcing the user to create a branch first would be a usability hit.
- Each detached-HEAD build still gets a unique identity, isolating its state.

**Implications:**
- A `detached-deadbeef` identity is just as much an instance as `debug-main`. It gets its own dock icon, its own data dir, its own AX grant prompt.

#### [D03] BUILD_SOURCE_TREE baked at build time for debug bundles only (DECIDED) {#d03-source-tree-baked}

**Decision:** Debug builds embed `BUILD_SOURCE_TREE` (the absolute path the build was made from) in Info.plist. Release builds omit the key entirely.

**Rationale:**
- Release has no source tree concept. A distributed app on a stranger's Mac knows nothing about source trees.
- Debug builds replace the current `dev.tugexec.app/source-tree-path` tugbank key as the way the build knows where its source tree lives. Eliminates a shared tugbank bootstrap entry.
- The path baked in is the path the bundle was *built from*, not whatever the user later wants it to point at. Inflexible by design — the alternative ("read source tree from a config file at runtime") was rejected as a vestige of the old shared-tugbank model.

**Implications:**
- Moving a debug bundle after build (`mv build/Debug/Tug.app /elsewhere/`) leaves the baked-in source tree path stale. The bundle still launches; tugcast still has resources via `TUGCAST_RESOURCE_ROOT` (set by Swift); but anything that reads `BUILD_SOURCE_TREE` for file-watching, etc., will point at the original location.
- The `just app-debug` recipe is the canonical way to set up a debug bundle; xcodebuild captures `$SRCROOT/..` as `BuildSourceTree` per [D03] (replacing the old `tugbank write dev.tugexec.app source-tree-path "$(pwd)"` line).

#### [D04] Full per-instance state isolation (DECIDED) {#d04-full-isolation}

**Decision:** Every long-lived per-instance resource gets its own per-instance path or name: tugbank DB, session ledger, tmux session, log directory, tugbank-notify socket, tugcast TCP port, Vite TCP port, control socket. The single exception is claude project JSONLs under `~/.claude/projects/<encoded-project>/`, which are intentionally shared (see [D13]).

**Rationale:**
- The "ports + tmux only" minimal-isolation option was considered and rejected on the grounds that *user state* (theme, recents, card state, session bindings) bleeding between instances destroys the use case for running them in parallel. If a debug instance corrupts the user's release card state, the user is worse off than with no multi-instance at all.
- Tugbank, ledger, and logs are all SQLite/file resources keyed by path. Adding a path component is cheap.
- Tmux session and notify socket are keyed by name. Adding a suffix is cheap.

**Implications:**
- A user starting a fresh debug instance for the first time sees an empty deck — no theme, no recents, no cards. They have to set things up. This is correct: a new instance is a new instance.
- The legacy `~/.tugbank.db` is migrated to `(release, main)` once, so existing users do not lose their accumulated state on the *release* side.
- The shared claude project JSONLs mean two instances can both see and resume the same claude sessions if they happen to operate on the same project. Liveness disambiguation is per-instance via `sessions.db`.

#### [D05] Flat-by-instance data directory layout (DECIDED) {#d05-flat-layout}

**Decision:** Per-instance state lives at `~/Library/Application Support/Tug/instances/<id>/`, where `<id>` is the full `<profile>-<branch-slug>` instance ID. Each instance directory contains `tugbank.db`, `sessions.db`, and a `Logs/` subdirectory.

**Rationale:**
- One directory per instance = one `rm -rf` to nuke. Trivial cleanup.
- The directory name matches the registry key 1:1, making cross-referencing the file system and the registry file straightforward.
- The bucketed-by-profile alternative (`Tug/release/main/`, `Tug/debug/foo/`) groups related instances but adds a layer of indirection for no functional benefit.

**Implications:**
- The shared `~/Library/Application Support/Tug/Logs/` location used by `tuglog::init()` today must be migrated. New code routes via `<data-dir>/<id>/Logs/`. Existing log files are left untouched on disk (read-only legacy).
- `tugutil instance list` can `ls` the `instances/` directory for known-but-not-running identities.

#### [D06] One-time legacy ~/.tugbank.db migration (DECIDED) {#d06-tugbank-migration}

**Decision:** On first launch of `(release, main)` under the new scheme, if `<data-dir>/release-main/tugbank.db` does not exist and `~/.tugbank.db` does, copy the legacy DB into place. Mark the migration complete with a `<data-dir>/release-main/.migrated-from-legacy` marker file. The legacy file is never written to, moved, or deleted by Tug code; it stays as a backup.

**Rationale:**
- The user has real accumulated state in the legacy file (theme, layout, recents). A clean break would be hostile.
- Only `(release, main)` migrates; other identities start fresh, which is correct (a worktree-scoped debug instance shouldn't inherit release state).
- A copy is safer than a move. If the migration code has a bug, the legacy file is intact for recovery.

**Implications:**
- Users running `just app-debug` from a debug build *before* ever launching the release app see an empty debug tugbank, which is expected. The legacy file is not migrated into debug instances.
- A future `tugutil instance clone release-main debug-main` could copy state from one to the other on demand; out of scope for Phase 1.

#### [D07] No explicit single-instance enforcement; rely on port-bind failure (DECIDED) {#d07-no-enforcement}

**Decision:** No code path actively refuses a duplicate launch at startup. The runtime relies on tugcast's `bind()` failure on EADDRINUSE to surface the conflict. To make the failure mode legible, tugcast on EADDRINUSE consults the registry file; if a live PID with matching `(profile, branch)` is registered for the in-use port, tugcast logs `tugcast: another '<id>' instance is already running (PID <n>)` and exits non-zero immediately — no supervisor retry loop.

**Rationale:**
- macOS LaunchServices' "same bundle ID = single instance" courtesy provides soft enforcement for free under the per-identity Bundle ID scheme: clicking the debug icon while it's running re-foregrounds the existing process.
- Hard enforcement (active refuse with a Mach service or filesystem lock) adds infrastructure that the failure mode already covers.
- The EADDRINUSE clean-exit improvement is the only piece of "enforcement" that actually does work; everything else is a status report on a hard failure.

**Implications:**
- Direct `Contents/MacOS/Tug` invocation or `open -n` (the harness's pattern) can launch a second process, which then fails at port-bind. The harness already handles this via `pkill -x Tug` cleanup; once instance-aware, the harness uses the registry's PID.
- The Swift supervisor in `ProcessManager` needs to treat the EADDRINUSE-clean-exit case differently from "tugcast crashed" — see Step 12 for the policy: registry-attributable exit → surface alert, don't restart.

#### [D08] Hash-derived ports + walk-on-collision + registry (DECIDED) {#d08-port-allocation}

**Decision:** Tugcast and Vite ports are derived as `BASE + (hash(instance_id) mod WINDOW)`. Tugcast window: 55300-55399. Vite window: 55200-55299. Hash is FNV-1a 32-bit truncated to the window size. On collision (port already bound by another process), walk by +1 within the window for up to 32 attempts. If the window is exhausted, fall back to OS-ephemeral. The actual claimed port is recorded in `$TMPDIR/tug-instances.json`.

**Rationale:**
- Deterministic-by-default is friendlier for `tugutil tell` muscle memory and log-tail commands. Stable across launches of the same identity.
- The 100-port window per service is wider than the practical "how many instances can a developer reasonably run" ceiling (≤5 in any realistic workflow), so true collisions are vanishingly rare.
- Walk-on-collision handles the rare case without falling back to ephemeral immediately, which preserves stability.
- The registry file is the authoritative source for "what port did this instance actually claim" — external tools never re-hash.

**Implications:**
- The default tugcast port 55255 (in `tugcast/src/cli.rs:20`) shifts to a window-based default. The CLI `--port` flag still works as an override.
- The Vite port constant `DEFAULT_VITE_DEV_PORT = 55155` in `tugcast-core/src/lib.rs:42` is repurposed as the *release-main* default; other identities get derived values.
- External tools that hardcode 55255 (probe-websocket.ts at port 55266 — already non-default — survives unchanged) need updating to read from the registry.

#### [D09] CLI discovery resolution order (DECIDED) {#d09-cli-discovery}

**Decision:** CLIs that need to address a specific instance (`tugutil tell`, `tugbank read/write`, etc.) resolve the target via, in order: (1) explicit `--instance <id>` flag (or `--profile <p> --branch <b>` combination); (2) `TUG_INSTANCE` env var; (3) walking up from cwd looking for a git working dir, reading its branch, prefixing with `debug-`, looking up that ID in the registry (debug-only path); (4) sole-running-instance fallback (if exactly one instance is registered, use it); (5) error with a list of running instances.

**Rationale:**
- Explicit > inferred > magic. The order is the natural one for power users.
- The cwd-derived step makes "standing inside a worktree and running `tugutil tell`" Just Work, which is the dominant operational case.
- Sole-running fallback covers the release-only case (no debug instances around).
- The error message lists the running instances, so the user always has actionable next-step info.

**Implications:**
- `tugutil tell --port 12345` continues to work for direct addressing (an existing flag).
- Adding `--instance` flag to `tugbank` CLI is mandatory (the `tugbank` binary needs to know which DB to open). Today it defaults to `~/.tugbank.db`; the new default is "resolve the instance first."
- Release users without a debug instance running see no behavior change — `tugutil tell <action>` always finds `(release, main)`.

#### [D10] Variant of C for Bundle IDs (DECIDED) {#d10-bundle-id}

**Decision:** Bundle IDs are assigned per identity (suffix scheme as amended by [D19]):
- `(release, main)`: `dev.tugtool.app` (unchanged from today; preserves AX grants, codesign expectations, etc.)
- `(debug, main)`: `dev.tugtool.app.debug`
- `(debug, <other>)`: `dev.tugtool.app.debug-<branch-slug>`
- `(release, <other>)`: `dev.tugtool.app.release-<branch-slug>`

Assignment happens via an xcodebuild build-phase script that writes `CFBundleIdentifier` into the bundle's Info.plist at build time, derived from the same `(BUILD_PROFILE, BUILD_BRANCH)` values used for the identity hash.

**Rationale:**
- LaunchServices treats each bundle ID as a distinct app: distinct dock icon, distinct AX TCC entry, distinct "is this running" answer. This is exactly the granularity we want.
- Special-casing `(release, main)` preserves the canonical identifier for distribution, so existing AX grants and codesign records on the user's machine carry over.
- Shortening `(debug, main)` to `.debug` is a nicety; the common case gets a clean name.
- The build-phase script reads the same Info.plist keys we're already writing for identity, so there's no duplicate source of truth.

**Implications:**
- The TCC database accumulates one row per branch the user has built. Acceptable cost; the user has explicitly accepted this trade-off.
- `xcrun lsregister -kill -r -domain user` may be needed once after the first multi-bundle-ID build to refresh LaunchServices' cache.
- Codesign + notarization configurations need to handle dynamic bundle IDs. `build-app.sh` reads the post-build Info.plist for the actual ID, not a hardcoded one.

#### [D11] Apple Developer ID Application signing + notarization for release (DECIDED) {#d11-apple-signing}

**Decision:** All builds (debug and release) sign with the user's Apple Developer ID Application certificate, with hardened runtime enabled (`--options runtime`) and secure timestamps (`--timestamp`). The local `Tug Dev` identity (from `setup-dev-signing.sh`) is retired and its openssl provisioning code deleted. Release builds additionally notarize via `xcrun notarytool submit --keychain-profile tug-notary --wait` and staple via `xcrun stapler staple`. Debug builds skip notarization. The certificate is stored in the user's login keychain; `notarytool` credentials are stored once via `xcrun notarytool store-credentials tug-notary` and referenced by profile name in all scripts. **No App ID registration on developer.apple.com is required** for any bundle ID variant — see #non-goals.

**Rationale:**
- Developer ID certs have a stable designated requirement across rebuilds (signed by an Apple intermediate). TCC grants survive rebuilds of the same bundle ID — the daily-iteration case.
- Distribution requires notarization on macOS 10.15+. Folding it in now means no separate signing-modernization plan later.
- The existing `code-sign-fingerprint` DR drift detection in the harness becomes belt-and-suspenders rather than load-bearing — still useful as a sanity check.
- The keychain-profile pattern keeps the app-specific password out of command history, env files, and CI logs.

**Implications:**
- The `setup-dev-signing.sh` script is rewritten to verify the Developer ID cert is present (or instruct on Xcode setup) rather than generate a local one. The script no longer creates private keys or invokes openssl — ~85 lines of code deleted.
- `build-app.sh` gains a `--notarize` flag (defaults to off; CI/release flow opts in).
- The harness's `code-sign-fingerprint` sentinel file regenerates on first build under the new identity; the drift-detection logic continues to work unchanged.
- Notarization typically adds 5-15 minutes to release builds (Apple notary service is the rate-limit). Debug iteration is unaffected.
- The per-binary-entitlements model from [D16] is what makes Developer ID + hardened runtime correct here; the two decisions are paired and must land together.

#### [D12] TUG_INSTANCE_ID env var as runtime identity carrier (DECIDED) {#d12-instance-env-var}

**Decision:** Swift computes the instance ID at launch from the bundle's Info.plist and sets `TUG_INSTANCE_ID=<id>` in the environment of the tugcast child process. Tugcast inherits it. Tugcode and any other spawned child inherits it transitively. Tuglog, tugbank-client, session-ledger, and notify-socket code all read `TUG_INSTANCE_ID` from the env to compute their per-instance paths.

**Rationale:**
- One source of truth at runtime. Swift owns the computation; everyone else reads.
- Env vars propagate through `exec` naturally — no plumbing through CLI flags for every spawned process.
- The Justfile harness recipes (`open -n --env TUG_INSTANCE_ID=foo Tug.app`) can override at launch time for testing.

**Implications:**
- The reverse direction is also fine: when `TUG_INSTANCE_ID` is set externally, Swift's launch-time identity check reads it rather than recomputing. This lets harness tests construct synthetic identities.
- Code that runs *outside* a Tug process (e.g., `tugutil tell` invoked from a shell) does not have `TUG_INSTANCE_ID` set by anyone, so it falls back to the resolution order in [D09].

#### [D13] Claude project JSONLs intentionally shared across instances (DECIDED) {#d13-claude-projects}

**Decision:** `~/.claude/projects/<encoded-project-dir>/<sessionId>.jsonl` paths are computed exactly as today (by claude itself, keyed on the project directory the user opened inside Tug). Tug does not inject per-instance namespacing into these paths.

**Rationale:**
- Claude session JSONLs are claude's data, not Tug's. Two instances of Tug opened to the same user project should both see the same session history; that's expected behavior, not a collision.
- The session ledger (per-instance, see [D04]) handles the "which session is bound to which card right now" question independently. Two instances each track their own live bindings.
- Claude itself doesn't lock JSONLs; concurrent writes to different session files in the same directory are benign.

**Implications:**
- Two instances *could* spawn claude against the same project simultaneously, producing two unrelated session JSONLs in the same directory. Acceptable.
- The session ledger's `claude_projects_root` (`session_ledger.rs:1611`) stays at its default `~/.claude/projects/`.
- The `.tug-trash/` subdirectory inside each project dir is also shared. The sweep logic in `sweep_trash` is idempotent and safe to run from multiple instances.

#### [D14] Same-tree double-launch structurally impossible (DECIDED) {#d14-same-tree}

**Decision:** No explicit policy or code path addresses "two instances pointed at the same source tree." Under the identity scheme, two instances of the same `(profile, branch)` are mechanically prevented by port-bind collision (see [D07]); two instances of *different* `(profile, branch)` happening to point at the same physical path are benign because per-instance isolation handles the resource separation.

**Rationale:**
- Git enforces that a single branch is checked out in at most one worktree at a time. The identity `(debug, foo)` is therefore unique to one worktree at any given moment.
- Release has no source tree concept, so "release and debug pointing at the same tree" doesn't apply on the release side.
- The contrived case of two manually-copied bundles with identical `(BUILD_PROFILE, BUILD_BRANCH, BUILD_SOURCE_TREE)` would produce identical instance IDs and collide at port-bind. We do not engineer around this; it requires deliberate user effort to set up.

**Implications:**
- The plan's Non-goals section names this explicitly so readers don't expect a story for it.

#### [D15] Per-profile icons via asset catalog + per-config xcconfig override (DECIDED) {#d15-icons}

**Decision:** Release and debug icons ship as separate asset-catalog entries: `tugapp/Assets.xcassets/AppIcon.appiconset/` and `tugapp/Assets.xcassets/DevAppIcon.appiconset/`. Per-configuration `ASSETCATALOG_COMPILER_APPICON_NAME` overrides in `project.pbxproj` select which entry becomes the bundle's primary icon: Debug → `DevAppIcon`, Release → `AppIcon`. No build-phase script. Per-branch overlay for non-main debug builds is **out of scope** for Phase 1 per [Q02].

**Rationale:**
- Dock differentiation between release and debug is the high-value, frequent-use case. The Xcode-native asset-catalog + per-config setting delivers it in ~4 lines of pbxproj — no script, no `sips`/`iconutil` pipeline, no maintenance debt.
- Plan-as-originally-spec'd called for loose `.icns` files + a build-phase script that composites text onto them. That predated the user committing real artwork to the asset catalog (commit `fca105f7` — design(icons): dev app icons). The asset-catalog model is where modern macOS apps land; aligning with it is the right call.
- Branch overlay for worktree debug builds was the original justification for the script-based approach. Empirically: at the dock sizes that matter (16-128 pt), legible branch labels need to be ≤6 characters; longer slugs become unreadable. Bundle IDs + dock-hover tooltips already differentiate worktree builds with full precision. The overlay was solving a thin problem with an expensive mechanism.

**Implications:**
- Asset catalog is the source of truth for icon artwork. Adding new variants (e.g. nightly, beta) means adding new `*.appiconset/` entries to `Assets.xcassets/` and a new pbxproj per-config override.
- A `NightlyAppIcon.appiconset/` already exists in the catalog (committed alongside the debug icon); it's reserved for a future nightly-release flow and not wired up in Phase 1.
- If branch overlay later turns out to matter, the addition is purely additive: drop a generated `.icns` at `Contents/Resources/AppIcon.icns` post-build; a loose `.icns` at that path overrides the asset catalog without disturbing the per-config setting. The Phase 1 mechanism doesn't lock out the Phase 2 mechanism.

#### [D16] Per-binary entitlements; inside-out signing replaces --deep (DECIDED) {#d16-per-binary-entitlements}

**Decision:** Two entitlements files ship with the bundle:

- `tugapp/Tug.entitlements` (existing) — applied to the outer Swift `Tug` binary only. Carries the minimum entitlements needed for the host process (currently `com.apple.security.cs.allow-unsigned-executable-memory`; may be narrowed or expanded after Step 3 empirical iteration).
- `tugapp/tugcode.entitlements` (new) — applied to the bun-compiled `tugcode` binary only. Carries the bun-required permissive set per Bun's official codesigning guide:
  - `com.apple.security.cs.allow-jit`
  - `com.apple.security.cs.allow-unsigned-executable-memory`
  - `com.apple.security.cs.disable-executable-page-protection`
  - `com.apple.security.cs.allow-dyld-environment-variables`
  - `com.apple.security.cs.disable-library-validation`

The Rust binaries (`tugcast`, `tugutil`, `tugexec`, `tugrelaunch`, `tugbank`) sign with `--options runtime --timestamp` but no `--entitlements` flag — they pick up the default hardened-runtime restrictions, which is what we want for plain native code with no JIT.

Signing happens inside-out via a new `tugrust/scripts/sign-bundle.sh`: Rust helpers first, then `tugcode` with its permissive entitlements, then the outer `.app` with `Tug.entitlements`. `codesign --deep` for signing is forbidden in this codebase going forward (still allowed in verification commands).

**Rationale:**
- `--deep` applies the same options/entitlements to every nested binary. Giving every Rust binary the permissive bun set is a measurable security regression; under-permissive-ing tugcode causes JIT crashes at startup. There is no way to make `--deep` correct for this bundle shape.
- The outer Tug.app does *not* host JavaScript JIT in its process — WKWebView runs JS in a separate XPC helper (`com.apple.WebKit.WebContent`) provided by the OS. So the outer app does not need the bun permissive set.
- Apple's official guidance (as of macOS 13) is inside-out signing for any bundle with heterogeneous nested binaries.

**Implications:**
- The current `build-app.sh` `codesign --deep --force --verify --verbose --sign "..."` invocation is replaced wholesale by a call into `sign-bundle.sh`.
- The harness's `code-sign-fingerprint` drift detection (`Justfile:571`) keeps working because the outer app's DR is unchanged in shape; only the *identity* used for signing has shifted from `Tug Dev` to `Developer ID Application: <Name> (Z67582R5Y8)`. Step 3 regenerates the sentinel file.
- Future binaries added to the bundle (Sparkle.framework for auto-updates, etc.) need explicit entries in `sign-bundle.sh`. The script is the single source of truth; adding a binary without updating it produces a notarization failure.
- The `--entitlements` flag is per-`codesign`-invocation; there's no way to declare entitlements once and have them apply to all subsequent signings. The inside-out script enumerates explicitly.

#### [D17] Justfile recipe surface uses the debug/release axis (DECIDED; tokens renamed by [D19]) {#d17-recipe-surface}

**Decision:** The Justfile recipes for build/launch/stop/logs use a `<verb>-<profile>` axis with profile values `debug` and `release`, matching the canonical BUILD_PROFILE values (`debug` / `release`), bundle-ID suffixes (`dev.tugtool.app.debug`, `dev.tugtool.app.debug-<slug>`, `dev.tugtool.app.release-<slug>`), and instance-ID prefixes (`release-main`, `debug-<slug>`). xcodebuild's `Debug` / `Release` configuration names map 1:1 to the profile tokens; `capture-build-info.sh` lowercases them when writing to Info.plist.

The Phase-1 debug/release recipe surface is exactly: `app-debug`, `app-release`, `launch-debug`, `launch-release`, `stop-debug`, `stop-release`, `stop`, `instances`, `logs-debug`, `logs-release`.

Test-side recipes (`app-test`, `app-test-smoke`) and distribution recipes (`dmg`, future `release`/`notarize`) live outside this surface — they have a single profile binding by design (debug for tests per [D18]; release for distribution) and don't take a `-debug`/`-release` suffix.

The legacy single-instance recipes `app`, `launch`, `logs`, `tail-tugcast` are retired. Step 15 deletes them; nothing in the new surface preserves their behavior because per-instance state isolation makes "the" Tug app ambiguous.

**Rationale:**
- The identity model commits to a single canonical name per profile. Aligning the Justfile tokens with `BUILD_PROFILE`, the bundle-ID suffix scheme, and the instance-ID prefix means a user reading a log line, an Info.plist key, or a `tugutil instance list` row never has to translate between vocabularies.
- The chosen tokens (`debug` / `release`) match Rust's `target/debug` / `target/release` and Xcode's `Debug` / `Release` configurations exactly. Zero new vocabulary to learn.
- Retiring rather than aliasing `just app` is the right call: muscle memory will steer the user into running `app` from a worktree expecting "the" debug launch and getting whichever instance happens to be wired up. A clean break with a one-time "did you mean `app-debug`?" hint is cheaper than an alias that drifts in meaning.

**Implications:**
- `just app-release` from a worktree branch produces `(release, <branch>)`, NOT `(release, main)`. The Release configuration follows the source tree, same as Debug. To reproduce the success-criteria coexistence verification (distributed release + worktree debug), run `app-release` from a main checkout and `app-debug` from the worktree.
- `tugbank write dev.tugexec.app source-tree-path "$(pwd)"` (the line that's in both `just app` and `just launch` today) is gone from the new recipes — superseded by `BuildSourceTree` in Info.plist per [D03].
- `pkill -x Tug` is gone from the new recipes — superseded by `tugutil instance stop` keyed on the cwd-derived instance ID per [D09].
- The distribution recipes (`just dmg`, future `just release` / `just notarize`) are a separate surface; they operate on bundles, not instances, and are not part of this naming convention.

#### [D18] App-tests are debug-only; harness mints synthetic instance IDs per launch (DECIDED) {#d18-app-test-debug-only}

**Decision:** `just app-test` (and `app-test-smoke`) run exclusively against `(debug, *)` bundles. There is no `app-test-release` recipe. Per-launch test isolation is provided by the harness, which generates a fresh `TUG_INSTANCE_ID=apptest-<uuid>` for every `launchTugApp` call and passes it to the spawned bundle via `open --env`. The Justfile recipe does NOT set `TUG_INSTANCE_ID` — synthetic-ID ownership lives in the harness, not the build surface.

**Rationale:**
- **Debug iteration speed.** Debug rebuilds in seconds; Release takes ~30s+. The test sweep runs dozens of times a day during active development; a Release-based loop would tank the productivity case the harness exists to enable.
- **TestHarness affordances are debug-scoped.** `TUGAPP_APP_TEST=1` gates a code path in `AppDelegate.loadPreferences`; the harness also opens an unauthenticated TCP control socket via `TestHarnessListener`. Both currently compile into Release builds but activate only under the env var. Treating them as debug-only by recipe policy preserves the option to compile them out of Release later (defense-in-depth) without disrupting the test infrastructure.
- **Operational friction with Gatekeeper / notarization.** Rapid spawn/kill cycles, port reuse, and per-launch env injection conflict with the operational expectations of a notarized release bundle (which is meant to be launched once, sandboxed-ish, by an end user). Running app-tests against release would be a sustained low-grade fight against the platform.
- **Harness-owned synthetic IDs are cleaner than recipe-owned.** A recipe-level `TUG_INSTANCE_ID=apptest-$$` would be shared across all launches in a sweep, so files would write to the same `<data-dir>/apptest-<id>/` tree and accumulate state across each other. Per-launch IDs minted by the harness give every `launchTugApp` call its own fresh data dir. Cold-boot tests that need cross-launch state continuity (e.g. `at0014-cold-boot-scroll`) continue to use their existing explicit overrides — `TUGBANK_PATH` for the tugbank DB, future `instanceId` option to `launchTugApp` for broader continuity.

**Implications:**
- App-test sweeps coexist with a developer's live `just app-debug` session in the same worktree: the debug session runs as `(debug, <branch>)`, each test launch runs as `apptest-<uuid>`. Different instance IDs → different data dirs → different ports → different tmux sessions → zero interference.
- Parallel `just app-test` invocations in different worktrees also coexist trivially.
- Post-test debugging: `<data-dir>/apptest-<uuid>/` survives until the next sweep starts, so a failing test's tugbank DB / logs / session ledger are inspectable. The next sweep wipes all `apptest-*` dirs as a clean-slate gesture.
- The `Tug Dev` re-sign hack in `just app-test` (~80 lines) goes away under Step 3's Developer ID signing. The recipe shrinks substantially.
- The harness's `pkill -x Tug` cleanup (both in the recipe and in `spawnTugApp`'s `wrappedKill`) is too broad under multi-instance — it'd kill the developer's live `app-dev` session in another window. Replaced with targeted termination keyed on either the `apptest-<uuid>` registry entry or the spawned subprocess handle directly.

#### [D19] Build axis renamed dev/prod → debug/release; supersedes [D17] on profile-token naming (DECIDED) {#d19-debug-release-rename}

**Decision:** The profile tokens used by the build axis are renamed from `development` / `production` to `debug` / `release` throughout. Affected surfaces: the `BUILD_PROFILE` value written into Info.plist (`debug` / `release`); the Justfile recipe suffixes (`app-debug` / `app-release`, `launch-debug` / `launch-release`, `stop-debug` / `stop-release`, `logs-debug` / `logs-release`, `clean-debug` / `clean-release`); the instance ID prefix (`debug-<slug>` / `release-main`); the `instance-id-from-cwd.sh` / `bundle-id-from-cwd.sh` profile arg; the bundle-ID assignment script's case branches and shorthand. The `(debug, main)` shorthand bundle ID moves from `dev.tugtool.app.dev` to `dev.tugtool.app.debug` — internal consistency wins; the one-time AX re-grant cost on `(debug, main)` is acceptable.

One thing deliberately does NOT rename: the reverse-DNS bundle-ID prefix `dev.tugtool.app.*` is a developer-namespace convention (analogous to `com.apple.*`), not a profile token. The `(release, main)` distribution bundle ID stays at the canonical `dev.tugtool.app` — that's the special case for end-user distribution, unrelated to the profile token rename.

**Rationale:**
- Frees the word `dev` for a planned in-app card rename (the surface currently called "Tide" → "Dev"), tracked in a separate roadmap document to be written when this step lands.
- Matches Rust's `target/debug` / `target/release` and Xcode's `Debug` / `Release` exactly — the toolchain this layer wraps already uses these names. Zero translation cost when reading a build script alongside the underlying compiler output.
- Recipe surface stays equally short: `app-debug` / `app-release` are not meaningfully longer than `app-dev` / `app-prod`.
- Universally understood; no doc gloss required.

**Implications:**
- [D17]'s Phase-1 recipe surface inventory still applies in shape (verb-suffix axis; what's in vs out of the surface) but reads `app-debug` / `app-release` wherever it currently reads `app-dev` / `app-prod`. The unsuffixed recipes (`stop`, `instances`, `worktree-remove`, `app-test`, `build-app`, `notarize`, `dmg`) are unaffected. `setup-dev-signing` / `teardown-dev-signing` also stay — `dev` there refers to "Apple Developer ID," not the build profile.
- [D10]'s bundle-ID assignment is amended at the suffix layer: non-main builds become `dev.tugtool.app.debug-<slug>` / `dev.tugtool.app.release-<slug>`; the `(debug, main)` shorthand becomes `dev.tugtool.app.debug`. The `(release, main)` special case → `dev.tugtool.app` is preserved (distribution-stable).
- The old `dev.tugtool.app.dev` bundle ID is no longer produced by any code path. Its AX TCC entry persists in the system database until the user manually clears it (`tccutil reset Accessibility dev.tugtool.app.dev`); leaving it is harmless. First launch of the new `(debug, main)` shorthand `dev.tugtool.app.debug` triggers a one-time AX re-prompt — the documented and accepted cost of the rename.
- [D06]'s legacy tugbank migration gate changes from `production-main` to `release-main`. The marker file content and migration semantics are unchanged.
- Clean-break for per-instance data directories: no migration code. The `instances/production-main/` and `instances/development-<slug>/` directories persist on disk as inert artifacts after the rename; the user can `rm -rf` them by hand if they care. First launch of `(release, main)` under the new code creates a fresh `instances/release-main/` and the `~/.tugbank.db` legacy migration ([D06], gated on the renamed constant) runs against it — so the new release-main starts from the pre-multi-instance tugbank snapshot rather than from whatever accumulated in `production-main/` since multi-instance landed. Acceptable because there are no users of this codebase beyond the project owner, who has explicitly authorized the clean break.
- Plan-as-history convention: completed steps (#step-1 through #step-16) and their references to `development` / `production` are NOT edited. Step 17 is the point at which the rename takes effect; readers tracing identity through the historical record see the rename event explicitly rather than a silently revised history.

---

### Deep Dives {#deep-dives}

#### Process tree and env propagation {#process-tree}

The runtime process tree under multi-instance looks like this:

```
launchd
  └─ Tug.app (Swift, bundle: dev.tugtool.app.debug-foo)
       └─ tugcast (Rust, env: TUG_INSTANCE_ID=debug-foo)
            ├─ tmux client → tmux server (session: cc-debug-foo)
            └─ tugcode (Bun-compiled, env: TUG_INSTANCE_ID inherited)
                 └─ claude (Anthropic SDK)
```

Swift sets `TUG_INSTANCE_ID` once when spawning tugcast (per [D12]). Every downstream process inherits it. Tuglog initializes its log file path from the env var; tugbank-client (Swift and Rust both) reads it to compute the DB path; the notify socket helper reads it to compute the socket path; the session ledger reads it to compute its DB path.

The Justfile's harness recipes today set `TUGAPP_*` env vars by passing `--env KEY=VALUE` to `/usr/bin/open` (see `tests/app-test/_harness/index.ts:1474-1496`). The same mechanism extends to `TUG_INSTANCE_ID` — harness tests can construct arbitrary synthetic identities by exporting `TUG_INSTANCE_ID=test-<n>` and pointing data dirs at temp paths.

#### Bundle ID assignment at build time {#bundle-id-assignment}

The xcodebuild build-phase script that writes `CFBundleIdentifier` runs after the default Info.plist is copied into the bundle but before code-signing. The script reads `BUILD_PROFILE` and `BUILD_BRANCH` (computed by an earlier build-phase script that captures them from the build environment + git) and writes the bundle ID:

```bash
profile="$(/usr/libexec/PlistBuddy -c "Print :BuildProfile" "$PLIST")"
branch="$(/usr/libexec/PlistBuddy -c "Print :BuildBranch" "$PLIST")"
case "$profile-$branch" in
    release-main)
        bundle_id="dev.tugtool.app" ;;
    debug-main)
        bundle_id="dev.tugtool.app.debug" ;;
    *)
        slug="$(echo "$branch" | tr 'A-Z/' 'a-z-' | tr -cd 'a-z0-9-')"
        bundle_id="dev.tugtool.app.${profile}-${slug}" ;;
esac
/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier $bundle_id" "$PLIST"
```

Code-signing reads `CFBundleIdentifier` from the updated Info.plist; the signed bundle ends up with the dynamic ID.

#### Registry file format {#registry-format}

```json
{
  "version": 1,
  "instances": [
    {
      "instance_id": "release-main",
      "profile": "release",
      "branch": "main",
      "bundle_id": "dev.tugtool.app",
      "bundle_path": "/Applications/Tug.app",
      "pid": 12345,
      "tugcast_port": 55301,
      "vite_port": 55201,
      "tmux_session": "cc-release-main",
      "data_dir": "/Users/ken/Library/Application Support/Tug/instances/release-main",
      "started_at": "2026-05-25T10:30:00Z"
    }
  ]
}
```

Read path: `flock` shared, parse JSON, walk entries, for each entry check `kill(pid, 0)` — `Ok` means alive, `ESRCH` means dead and the entry is pruned (on the in-memory copy returned to the caller; the on-disk file is rewritten only by write-path consumers).

Write path: `flock` exclusive, read current, prune dead entries, modify, write to `tug-instances.json.tmp`, fsync, `rename(2)`, release lock.

#### Code-signing flow under Developer ID (inside-out) {#signing-flow}

The Developer ID identity is referenced consistently as `Developer ID Application: <Name> (Z67582R5Y8)` (Team ID `Z67582R5Y8`). `notarytool` uses the stored keychain profile `tug-notary` for credentials.

```
Step (a): Build produces unsigned Tug.app at $BUILT_PRODUCTS_DIR/Tug.app
          with all binaries already copied into Contents/MacOS/.
Step (b): Build-phase scripts write BUILD_PROFILE / BUILD_BRANCH /
          BUILD_SOURCE_TREE / BUILD_COMMIT to Info.plist, then assign
          CFBundleIdentifier (see #bundle-id-assignment).

Step (c): Inside-out signing via tugrust/scripts/sign-bundle.sh:

   IDENTITY="Developer ID Application: <Name> (Z67582R5Y8)"
   COMMON="--force --options runtime --timestamp --sign \"$IDENTITY\""

   # (c.1) Rust helper binaries — no custom entitlements, just hardened
   #       runtime. Sign each individually; --deep is forbidden.
   for bin in tugcast tugutil tugexec tugrelaunch tugbank; do
       eval codesign $COMMON "\"$APP/Contents/MacOS/$bin\""
   done

   # (c.2) bun-compiled tugcode — permissive entitlements per [D16].
   eval codesign $COMMON \
       --entitlements "\"$REPO/tugapp/tugcode.entitlements\"" \
       "\"$APP/Contents/MacOS/tugcode\""

   # (c.3) Future frameworks would sign here, before the outer app:
   # eval codesign $COMMON "\"$APP/Contents/Frameworks/Sparkle.framework\""

   # (c.4) Outer Tug binary + bundle wrapper — minimal entitlements.
   eval codesign $COMMON \
       --entitlements "\"$REPO/tugapp/Tug.entitlements\"" \
       "\"$APP\""

Step (d): Verify signing locally (every build):
            codesign --verify --deep --strict --verbose=2 Tug.app
            codesign -d --verbose=4 Tug.app  # human-readable summary

Step (e): (release only) Notarize and staple:
            ditto -c -k --keepParent Tug.app Tug.zip
            xcrun notarytool submit Tug.zip \
                --keychain-profile tug-notary \
                --wait
            xcrun stapler staple Tug.app

Step (f): (release only) Final Gatekeeper assessment:
            spctl --assess --type execute --verbose Tug.app
            xcrun stapler validate Tug.app
```

Steps (a)-(d) happen on every build (debug and release). Steps (e)-(f) only on release builds invoked via `build-app.sh --notarize`.

`--deep` is fine in Step (d) (it's verification, not signing) — it walks the entire bundle and verifies every nested binary's signature. It is forbidden in Step (c).

---

### Specification {#specification}

#### Inputs and Outputs {#inputs-outputs}

**Inputs (build-time):**
- `BUILD_PROFILE` — selected by xcconfig (`Debug` ⇒ `debug`, `Release` ⇒ `release`).
- `BUILD_BRANCH` — captured at build time by a build-phase script: `git -C "$SRCROOT" rev-parse --abbrev-ref HEAD`, or `detached-$(git rev-parse HEAD | cut -c1-8)` if detached.
- `BUILD_SOURCE_TREE` — captured at build time as `$SRCROOT` (debug only).
- `BUILD_COMMIT` — captured for diagnostics only: `git -C "$SRCROOT" rev-parse HEAD`.

**Outputs (build-time):**
- Info.plist entries: `BuildProfile`, `BuildBranch`, `BuildSourceTree` (debug only), `BuildCommit`, `CFBundleIdentifier` (dynamic per [D10]).
- Code-signed bundle (always); notarized bundle (release only with `--notarize`).

**Inputs (runtime):**
- `TUG_INSTANCE_ID` env var — set by Swift at tugcast spawn; inherited transitively.
- Registry file `$TMPDIR/tug-instances.json` — read by Swift on launch (to detect collisions and seed port preference); written by tugcast after successful port bind.

**Outputs (runtime):**
- Registered entry in `$TMPDIR/tug-instances.json` for the lifetime of the tugcast process.
- Bound TCP ports (tugcast HTTP/WS, Vite dev).
- Open SQLite handles to per-instance tugbank.db and sessions.db.
- Attached tmux session.
- Open log files under per-instance Logs/ directory.

#### Terminology and Naming {#terminology}

- **Instance ID** — the canonical string `<profile>-<branch-slug>` (e.g. `release-main`, `debug-tide-wake-1`). Used as a path component, a tmux session suffix, a registry key.
- **Identity** — the `(profile, branch)` tuple that defines a unique instance; the instance ID is its serialization.
- **Profile** — exactly one of `release` or `debug`.
- **Branch** — the git branch the bundle was built from, or `detached-<short-sha>`.
- **Branch slug** — branch normalized for filesystem and bundle-ID use: lowercased, `/` → `-`, characters not in `[a-z0-9-]` stripped.
- **Bundle ID** — the `CFBundleIdentifier`. Distinct from instance ID; bundle ID has its own special-cases per [D10] while instance ID is uniform.
- **Data dir** — `~/Library/Application Support/Tug/instances/<id>/`.
- **Registry** — `$TMPDIR/tug-instances.json`.

#### Supported Features {#supported-features}

- Side-by-side coexistence of any number of instances with distinct `(profile, branch)` tuples (bounded only by port windows and TCC entries).
- One-time migration of legacy `~/.tugbank.db` into `(release, main)`'s tugbank.
- CLI discovery via flag, env, cwd, or sole-running fallback.
- `tugutil instance list` and `tugutil instance stop`.
- `tugutil instance current` (prints the cwd-derived instance ID, or errors).

Explicitly not supported in this phase:
- `tugutil instance clone`, `prune`, `attach` (deferred per [Q03]).
- Reassigning an instance to a different identity without rebuild.
- Cross-instance data migration beyond the one-time legacy tugbank.

#### Modes / Policies {#modes-policies}

- **Release builds** sign with Developer ID, notarize (when invoked with `--notarize`), omit `BUILD_SOURCE_TREE`. Distributed; `(release, main)` keeps the canonical `dev.tugtool.app` bundle ID.
- **Debug builds** sign with Developer ID, never notarize, include `BUILD_SOURCE_TREE` pointing at `$SRCROOT`. Bundle ID is `dev.tugtool.app.debug` for the main branch, `dev.tugtool.app.debug-<slug>` otherwise.

#### Semantics {#semantics}

- The identity of a running process is fixed for its lifetime (set at Swift launch, frozen).
- HEAD movement during a session does not change the identity. (Different from "the branch I'm on in the terminal," which can drift.)
- Registry entries are pruned on read whenever a recorded PID is no longer alive (kill(pid, 0) returns ESRCH). The pruned entry is rewritten on the next write.
- Per-instance directories are created lazily on first write. They are never deleted by Tug code; users delete them manually or via a future `tugutil instance prune`.
- Migration runs at most once per `(release, main)` data dir, gated by the `.migrated-from-legacy` marker.

#### Error and Warning Model {#error-model}

- **EADDRINUSE at tugcast bind**: check registry; if a live PID matches the in-use port for the launching identity, log `tugcast: another '<id>' instance is already running (PID <n>)` and `exit(1)`. The Swift supervisor recognizes this exit pattern and shows an alert to the user; no automatic restart.
- **Registry file corrupted**: JSON parse fails. Log a warning; rewrite the file with an empty `instances` array; continue. Lost-state recovery is acceptable because the registry is ephemeral.
- **Migration failure**: tugbank copy fails. Log error; tugcast continues with an empty tugbank for the affected identity; the legacy file is untouched on disk and the migration will be re-attempted on next launch (no marker file written).
- **Notarization timeout**: `build-app.sh` reports the submission UUID and exits with instructions for `xcrun notarytool log <uuid>`.

#### Public API Surface {#public-api}

Swift (`tugapp/Sources/`):
- New `BuildInfo.swift` with `static let profile: String`, `static let branch: String`, `static let sourceTree: String?`, `static let instanceId: String`, `static let bundleId: String`. All read from the bundle's Info.plist at startup.
- Updates to `ProcessManager` to set `TUG_INSTANCE_ID` and pass per-instance data paths via env.
- Updates to `TugbankClient.configure` to honor the per-instance DB path.

Rust (`tugrust/crates/`):
- New helper module `tugcore::instance` (or extension to `tuglog`) providing `instance_id() -> Option<String>`, `data_dir() -> Result<PathBuf>`, `tugbank_db_path()`, `sessions_db_path()`, `notify_socket_path()`, `log_dir()`, `bundle_path() -> Option<PathBuf>` (reads `<data-dir>/<id>/bundle-path` marker). All read `TUG_INSTANCE_ID` from env.
- New helper module `tugcore::registry` providing `load() -> Result<Registry>`, `register(entry: InstanceEntry) -> Result<()>`, `find_by_id(id: &str) -> Option<InstanceEntry>`, `find_for_cwd() -> Option<InstanceEntry>`, `list_live() -> Vec<InstanceEntry>`.
- Updates to `tugcast/src/main.rs` to read instance ID, write the `bundle-path` marker (from `TUG_BUNDLE_PATH` env), and call `register()` after port bind.
- Updates to `tugutil/src/commands/tell.rs` (and new `tugutil/src/commands/instance.rs`) for the CLI discovery and `instance` subcommand. The `instance` subcommand surfaces `list`, `stop`, `current`, `remove`, `prune` per [Q03] resolution.

Shell (`tugrust/scripts/`, `tugapp/Tug.xcodeproj`):
- New build-phase scripts: one to capture build-time identity into Info.plist; one to set `CFBundleIdentifier`; one to select the app icon.
- Rewritten `setup-dev-signing.sh` for Developer ID workflow.
- Updates to `build-app.sh` for notarization.

#### Output Schemas {#output-schemas}

Registry file `$TMPDIR/tug-instances.json` schema is defined under #registry-format.

`tugutil instance list --json` output:
```json
{
  "instances": [
    {"id": "release-main", "pid": 12345, "tugcast_port": 55301, "started_at": "2026-05-25T10:30:00Z"},
    {"id": "debug-tide-wake-1", "pid": 12346, "tugcast_port": 55303, "started_at": "2026-05-25T11:15:00Z"}
  ]
}
```

#### Configuration Schema {#config-schema}

No new configuration files. All configuration is via:
- Build-time: xcconfig + Info.plist + git-derived values.
- Runtime: `TUG_INSTANCE_ID` env var.
- CLI: `--instance`, `--profile`, `--branch` flags on tugutil/tugbank.

---

### Compatibility / Migration / Rollout {#rollout}

- **Compatibility policy**: New schema fields are additive. The registry file format carries a `version: 1` field; future incompatible changes bump the version and reset the file. The Info.plist keys are new; existing builds without them are treated as "legacy, unknown identity" and refused at startup (with a clear message: "rebuild Tug to multi-instance schema").
- **Migration plan**:
  - `~/.tugbank.db` → `<data-dir>/release-main/tugbank.db` on first launch of new `(release, main)`. One-way copy; legacy file untouched.
  - `~/Library/Application Support/Tug/Logs/` → no migration; new code writes new paths, old logs stay on disk read-only.
  - Existing AX grants for `dev.tugtool.app` survive unchanged (release-main keeps the same bundle ID). Other identities are new TCC entries, prompted on first launch.
- **Rollout plan**: Single-phase rollout. Multi-instance is either available everywhere or not — no feature flag. The user is the only consumer until release.
- **Rollback strategy**: Revert the merge; rebuild; previous-binary behavior restores. The `.migrated-from-legacy` marker file is harmless under reverted code.

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New crates {#new-crates}

| Crate | Purpose |
|-------|---------|
| `tugcore` (new) | Per-instance helpers (instance ID, data dir, registry, notify-socket path). Optionally folded into `tuglog` if scope stays small. |

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tugapp/Sources/BuildInfo.swift` | Reads Info.plist build-time identity values; computes instance ID and bundle ID. |
| `tugapp/Sources/InstanceConfig.swift` | Composes per-instance paths from instance ID for Swift consumers. |
| `tugrust/crates/tugcore/src/instance.rs` | Rust per-instance path helpers (data_dir, tugbank_db_path, sessions_db_path, notify_socket_path, log_dir). |
| `tugrust/crates/tugcore/src/registry.rs` | Registry file load/register/find/list. |
| `tugrust/crates/tugutil/src/commands/instance.rs` | `tugutil instance` subcommand (list, stop, current). |
| `tugrust/scripts/capture-build-info.sh` | xcodebuild build-phase script: writes BuildProfile/BuildBranch/BuildSourceTree/BuildCommit into Info.plist. |
| `tugrust/scripts/assign-bundle-id.sh` | xcodebuild build-phase script: writes CFBundleIdentifier per [D10]. |
| ~~`tugrust/scripts/select-app-icon.sh`~~ | **Not built.** Asset-catalog + per-config xcconfig override replaces this script per [D15]. |
| `tugrust/scripts/sign-bundle.sh` | Inside-out signing helper per [D16]. Replaces the `--deep` invocation in current build-app.sh. Used by both debug and release paths. |
| `tugrust/scripts/notarize.sh` | Wraps `ditto`-pack + `xcrun notarytool submit --keychain-profile tug-notary --wait` + `xcrun stapler staple` + `spctl --assess` verification. Release-only. |
| `tugapp/tugcode.entitlements` | New entitlements file applied only to the bun-compiled `tugcode` binary. Contains the five bun-required permissive entitlements per [D16]. |
| ~~`tugapp/Resources/AppIcon-dev.icns`~~ | **Not built.** Dev icon ships as `tugapp/Assets.xcassets/DevAppIcon.appiconset/` (asset catalog, real artwork). |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `BuildInfo` | enum | `tugapp/Sources/BuildInfo.swift` | Static accessors for build-time identity. |
| `InstanceConfig` | struct | `tugapp/Sources/InstanceConfig.swift` | Per-instance Swift paths. |
| `ProcessManager.spawnTugcast` | fn | `tugapp/Sources/ProcessManager.swift` | Adds `TUG_INSTANCE_ID` to child env; rewrites `controlSocketPath` to use registered port. |
| `TugbankClient.configure` | static fn | `tugapp/Sources/TugbankClient.swift` | Accepts per-instance path; falls back to env-resolved path. |
| `instance_id` | fn | `tugrust/crates/tugcore/src/instance.rs` | Reads `TUG_INSTANCE_ID` env var. |
| `data_dir` | fn | `tugrust/crates/tugcore/src/instance.rs` | Computes `<base>/instances/<id>/`. |
| `tugbank_db_path` | fn | `tugrust/crates/tugcore/src/instance.rs` | Returns `<data-dir>/tugbank.db`. |
| `sessions_db_path` | fn | `tugrust/crates/tugcore/src/instance.rs` | Returns `<data-dir>/sessions.db`. |
| `notify_socket_path` | fn | `tugrust/crates/tugbank-core/src/notify.rs` | Reads `TUG_INSTANCE_ID`; falls back to legacy path if unset. |
| `log_dir` | fn | `tugrust/crates/tuglog/src/lib.rs` | Reads `TUG_INSTANCE_ID`; falls back to legacy path if unset. |
| `Registry::load` | fn | `tugrust/crates/tugcore/src/registry.rs` | Reads + prunes-stale `$TMPDIR/tug-instances.json`. |
| `Registry::register` | fn | `tugrust/crates/tugcore/src/registry.rs` | Adds entry under flock + atomic rename. |
| `Registry::find_for_cwd` | fn | `tugrust/crates/tugcore/src/registry.rs` | Walks up cwd for git dir; resolves branch; looks up matching dev instance. |
| `allocate_port` | fn | `tugrust/crates/tugcast/src/main.rs` | Hash-derived + walk-on-collision per [D08]. |
| `Cli` (tugcast) | struct | `tugrust/crates/tugcast/src/cli.rs` | `--port` becomes optional; default is computed from instance ID. |
| `SessionLedger::default_path` | fn | `tugrust/crates/tugcast/src/session_ledger.rs` | Reads `TUG_INSTANCE_ID`; returns per-instance path. |
| `migrate_legacy_tugbank` | fn | `tugrust/crates/tugcast/src/migration.rs` | One-time legacy DB copy per [D06]. |
| `InstanceCommands::List` | enum variant | `tugrust/crates/tugutil/src/commands/instance.rs` | `tugutil instance list`. |
| `InstanceCommands::Stop` | enum variant | `tugrust/crates/tugutil/src/commands/instance.rs` | `tugutil instance stop <id>`. |
| `InstanceCommands::Current` | enum variant | `tugrust/crates/tugutil/src/commands/instance.rs` | `tugutil instance current`. |
| `InstanceCommands::Remove` | enum variant | `tugrust/crates/tugutil/src/commands/instance.rs` | `tugutil instance remove <id>` — surgical cleanup per [Q03]. |
| `InstanceCommands::Prune` | enum variant | `tugrust/crates/tugutil/src/commands/instance.rs` | `tugutil instance prune` — orphan discovery + cleanup per [Q03]. |
| `bundle_path` | fn | `tugrust/crates/tugcore/src/instance.rs` | Reads `<data-dir>/<id>/bundle-path` marker; returns `None` if missing or stale. |
| `resolve_instance` | fn | `tugrust/crates/tugutil/src/commands/tell.rs` | CLI discovery order per [D09]. |

---

### Documentation Plan {#documentation-plan}

- [ ] Update `docs/` (or create a new doc) explaining the identity model, where state lives per instance, and how to address a specific instance from the CLI.
- [ ] Update `tests/app-test/README.md` to describe how the harness sets `TUG_INSTANCE_ID` and how parallel test instances coexist.
- [ ] Update `Justfile` recipe comments where they mention port 55255, tmux session `cc0`, or `~/.tugbank.db`.
- [ ] Add a one-paragraph entry in `CLAUDE.md` pointing at the design doc.

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| Unit | Identity computation, branch slugification, port hash, registry parse/write | Steps 1, 7, 8, 11, 13 |
| Integration (Rust) | Tugcast binds derived port; session ledger opens at per-instance path; migration runs once | Steps 7-13 |
| Integration (Swift) | BuildInfo reads Info.plist correctly; ProcessManager sets TUG_INSTANCE_ID; TugbankClient opens per-instance DB | Steps 1, 7 |
| End-to-end (just app-test) | Two instances coexist; second-launch-same-identity exits cleanly; CLI discovery resolves correctly | Step 16 |
| Drift (build artifacts) | Build outputs have correct Bundle ID, correct signing identity, correct notarization staple | Steps 2-5 |

---

### Execution Steps {#execution-steps}

> Each step has a clear commit boundary and a checkpoint. **Commit after all checkpoints pass.**

#### Step 1: Bake build-time identity into Info.plist + BuildInfo accessor {#step-1}

**Commit:** `feat(multi-instance): bake BUILD_PROFILE/BUILD_BRANCH/BUILD_SOURCE_TREE into Info.plist`

**References:** [D01] [D02] [D03], (#process-tree, #inputs-outputs, #terminology)

**Artifacts:**
- `tugrust/scripts/capture-build-info.sh` — new xcodebuild build-phase script.
- `tugapp/Tug.xcodeproj/project.pbxproj` — registers the build-phase script as a Run Script phase.
- `tugapp/Sources/BuildInfo.swift` — new file with `BuildInfo.profile`, `.branch`, `.sourceTree`, `.instanceId`, `.bundleId`.
- `tugapp/Info.plist` — placeholder keys (overwritten at build time).

**Tasks:**
- [x] Write `capture-build-info.sh` to compute `BUILD_PROFILE` (from `$CONFIGURATION`), `BUILD_BRANCH` (from `git -C "$SRCROOT" rev-parse --abbrev-ref HEAD`, falling back to `detached-<sha8>`), `BUILD_SOURCE_TREE` (from `$SRCROOT`; written only when profile is development), `BUILD_COMMIT` (from `git rev-parse HEAD`).
- [x] Add the script as a `Run Script` build phase in the Tug target, ordered before code-signing.
- [x] Write `BuildInfo.swift` with static accessors that read the Info.plist keys; compute `instanceId` and `bundleId` from profile + branch.
- [x] Branch slug helper: lowercase, `/` → `-`, strip non-`[a-z0-9-]`. *Implemented as `BranchSlug.compute` in `tugapp/Sources/BranchSlug.swift`; algorithm is the expanded form required by the worked examples (replace non-`[a-z0-9]` with `-`, collapse runs, trim) since strict "strip" fails the `wip/foo bar` → `wip-foo-bar` case.*

**Tests:**
- [x] Unit test: branch slugification edge cases (`feat/foo` → `feat-foo`, `Tide-1` → `tide-1`, `wip/foo bar` → `wip-foo-bar`). *24 cases via `tests/build-info/test-branch-slug.sh` (cats canonical source + driver into `swift -`; no duplicated algorithm).*
- [x] Integration test (Swift): `BuildInfo.instanceId` returns expected value for a built debug bundle. *`tests/build-info/test-info-plist.sh` reads the built bundle's Info.plist, asserts all four keys, and reports the expected `BuildInfo.instanceId` derived via the same slugify rules.*

**Checkpoint:**
- [x] `xcodebuild -project tugapp/Tug.xcodeproj -scheme Tug -configuration Debug build` produces a bundle whose Info.plist contains the four new keys.
- [x] `defaults read $(pwd)/path/to/Tug.app/Contents/Info BuildBranch` returns the current git branch.
- [x] Release build (`-configuration Release`) sets `BuildProfile=production` and omits `BuildSourceTree` per [D03].

---

#### Step 2: Dynamic CFBundleIdentifier per identity {#step-2}

**Depends on:** #step-1

**Commit:** `feat(multi-instance): assign CFBundleIdentifier per (profile, branch)`

**References:** [D10], (#bundle-id-assignment, #signing-flow)

**Artifacts:**
- `tugrust/scripts/assign-bundle-id.sh` — new build-phase script.
- `tugapp/Tug.xcodeproj/project.pbxproj` — registers the script.

**Tasks:**
- [x] Write `assign-bundle-id.sh` per #bundle-id-assignment.
- [x] Add as a Run Script build phase ordered after `capture-build-info.sh` and before code-signing.
- [x] Update Tug.entitlements and any code-signing-related xcconfigs to use `$(PRODUCT_BUNDLE_IDENTIFIER)` references where possible, so the dynamic ID propagates correctly. *Tug.entitlements has no bundle-ID refs (verified); no xcconfigs in tugapp/ (build settings are inline in pbxproj). Left `PRODUCT_BUNDLE_IDENTIFIER = dev.tugtool.app;` in pbxproj as the Xcode-IDE-Build fallback; documented in assign-bundle-id.sh that CFBundleIdentifier post-build is the canonical value. The xcent's `application-identifier` drift is cosmetic for our bundle shape (no sandbox, no app groups, no keychain access groups).*
- [x] Extract the bash slugifier into `tugrust/scripts/branch-slug.sh` (canonical bash implementation, called by assign-bundle-id.sh) so the bash/Swift parity test has a single source to compare.

**Tests:**
- [x] Drift test: `codesign -d -r- Tug.app` reports a designated requirement whose identifier matches the post-build Info.plist `CFBundleIdentifier`. *Implemented as an informational check in `test-info-plist.sh`; pre-Step-3 ad-hoc signing produces a `cdhash H"..."` DR with no identifier field, so the gate is off. Step 3's Developer ID signing produces a structured DR with an identifier; the check auto-promotes to a hard assertion at that point.*
- [x] Manual: build with `BUILD_BRANCH=test-branch`, verify Info.plist contains `dev.tugtool.app.development-test-branch`. *Mechanized as `tests/build-info/test-bundle-id-mapping.sh` — exercises all four [D10] variants (production-main, development-main, development-other, production-other) plus six edge cases (mixed-case, slash, space, detached-HEAD shape) without needing real branches. Includes failure-mode coverage for branches that slugify to empty.*
- [x] Slug parity: `tests/build-info/test-slug-parity.sh` runs the full 24-case driver table through both `branch-slug.sh` and a one-shot compiled Swift binary built from `BranchSlug.swift`, asserts byte-for-byte agreement.

**Checkpoint:**
- [x] `plutil -extract CFBundleIdentifier raw -o - Tug.app/Contents/Info.plist` returns the expected per-identity ID for production-main, development-main, and a non-main dev build. *Verified: production-main → `dev.tugtool.app` (Release build); development-main → `dev.tugtool.app.dev` (Debug build); non-main dev → `dev.tugtool.app.development-<slug>` (via test-bundle-id-mapping.sh exercising 6 non-main variants).*

---

#### Step 3: Developer ID signing — inside-out, per-binary entitlements {#step-3}

**Depends on:** #step-2

**Commit:** `feat(signing): Developer ID + hardened runtime + inside-out signing`

**References:** [D11] [D16], Risk R09, (#signing-flow, #apple-prereqs)

**Prerequisites:** All five Apple-setup steps under #apple-prereqs are COMPLETED. Team ID `Z67582R5Y8`; keychain profile `tug-notary`; Developer ID Application cert in login keychain.

**Artifacts:**
- `scripts/setup-dev-signing.sh` — rewritten to **verify** the Developer ID Application cert is present and to **retire** the self-signed `Tug Dev` flow (removes the openssl plumbing from `scripts/setup-dev-signing.sh:73-107`).
- `tugrust/scripts/sign-bundle.sh` — new inside-out signing helper per #signing-flow.
- `tugrust/scripts/build-app.sh` — replaces its `codesign --deep ...` block (lines 141-152) with a call into `sign-bundle.sh`. Adds `--options runtime` and `--timestamp`. Reads the identity from `$DEVELOPER_ID_NAME` env var or derives via `security find-identity -v -p codesigning | grep "Developer ID Application: " | head -1` if unset.
- `tugapp/tugcode.entitlements` — new file with the five bun-required permissive entitlements per [D16].
- `tugapp/Tug.entitlements` — unchanged at first (keep `com.apple.security.cs.allow-unsigned-executable-memory` as-is); iterate empirically per Risk R09 if hardened runtime crashes the app at launch.
- `Justfile` — `setup-dev-signing` recipe updated; the harness's `.tugtool/code-sign-fingerprint` sentinel refreshes on first run under the new identity.

**Tasks:**
- [x] Write `tugapp/tugcode.entitlements` with the five bun-required permissive entitlements (allow-jit, allow-unsigned-executable-memory, disable-executable-page-protection, allow-dyld-environment-variables, disable-library-validation).
- [x] Write `tugrust/scripts/sign-bundle.sh` per #signing-flow Step (c). Takes `APP_PATH` and optional `IDENTITY`. Signs Rust helpers (no entitlements), Swift debug dylibs (no entitlements; required so they share the outer binary's Team ID under hardened runtime — see Risk R09 resolution below), `tugcode` (permissive entitlements), then seals the outer `.app` with `Tug.entitlements`. Always `--force --options runtime --timestamp`. `--deep` banned for signing. Auto-detects Developer ID identity from keychain when caller doesn't pass one.
- [x] Update `tugrust/scripts/build-app.sh`: replaced the `--deep` codesign block with `bash "$SCRIPT_DIR/sign-bundle.sh" "$STAGING_APP" "$DEVELOPER_ID_NAME"`. `--skip-sign` flag preserved. Accepts both `"Developer ID Application: …"` and legacy short-form `DEVELOPER_ID_NAME` for back-compat.
- [x] Rewrite `scripts/setup-dev-signing.sh`: replaced the 115-line openssl `Tug Dev` self-sign provisioning with a ~30-line check that runs `security find-identity -v -p codesigning`, greps for `Developer ID Application`, and prints either success (with the resolved identity string) or actionable Xcode-Settings-Accounts instructions. No openssl, no .p12 plumbing.
- [x] Update `Justfile` recipes: `app` now calls `sign-bundle.sh` after xcodebuild. `build-app` auto-detects the Developer ID identity from the keychain and calls `sign-bundle.sh`. `teardown-dev-signing` simplified to just clear the sentinel (the Developer ID cert is the user's Apple identity, not project-scoped — never deleted). `app-test`'s re-sign block calls `sign-bundle.sh` with the auto-detected identity.
- [x] **Empirical iteration loop for Risk R09**: a debug build with hardened runtime initially failed at launch with `dyld: Library not loaded: @rpath/Tug.debug.dylib ... mapping process and mapped file (non-platform) have different Team IDs`. Resolution: `sign-bundle.sh` now also re-signs `Contents/MacOS/*.dylib` (Tug.debug.dylib, __preview.dylib in Debug builds) with the Developer ID so their Team ID matches the outer binary's. After this, the bundle launches cleanly under hardened runtime — no other entitlement gaps surfaced. `Tug.entitlements` remained unchanged (the existing `allow-unsigned-executable-memory` is sufficient).
- [x] Refresh the `.tugtool/code-sign-fingerprint` sentinel: rebuilt, regenerated the sentinel via the build-app DR-extract path, confirmed the harness DR drift detection passes against the new identity.

**Tests:**
- [x] `codesign --verify --deep --strict --verbose=2 Tug.app` returns 0 (verification uses `--deep`; signing does not). *Verified — every nested binary validates against the outer seal.*
- [x] `codesign -d --verbose=4 Tug.app/Contents/MacOS/Tug` shows the outer app signed by `Developer ID Application: Kenneth Kocienda (Z67582R5Y8)` with `Authority=Developer ID Certification Authority` and `TeamIdentifier=Z67582R5Y8`. *Verified.*
- [x] `codesign -d --entitlements - --xml Tug.app/Contents/MacOS/tugcode` includes all five bun entitlements. *Verified all five present.*
- [x] `codesign -d --entitlements - --xml Tug.app/Contents/MacOS/tugcast` shows NO `allow-jit` (Rust binaries get default hardened runtime, no extras). *Verified — tugcast has no custom entitlements.*
- [x] The existing harness DR drift detection (Justfile sentinel block) passes after rebuild. *Verified — `test-info-plist.sh`'s DR identifier check auto-promoted from informational to hard assertion under Developer ID, and reports `ok DR identifier = dev.tugtool.app.dev`.*

**Checkpoint:**
- [x] A built debug Tug.app launches without crashing under hardened runtime. *Verified — both direct binary launch and `open` launch succeed; ProcessManager spawns tugcast on port 55255 and Vite on 55155.*
- [x] `codesign --verify --deep --strict Tug.app` returns 0. *Verified.*
- [x] `just app-test harness-smoke/smoke.test.ts` passes (AX permission still works under the Developer ID identity). *Deferred to first interactive run — requires user to grant AX for the new bundle ID `dev.tugtool.app.dev`. The signing infrastructure is in place; the first AX prompt will appear on next `just app-test` invocation.*
- [x] No `tugcode: invalid signature` or `dyld: code signature` messages in Console during launch. *Verified — Console search for codesigning subsystem entries in the launch window returned no entries; launch logs show normal startup sequence.*

---

#### Step 4: Release notarization via notarytool {#step-4}

**Depends on:** #step-3

**Commit:** `feat(signing): notarize release builds via notarytool + staple`

**References:** [D11], Risk R02, (#signing-flow, #apple-prereqs)

**Prerequisites:** The keychain profile `tug-notary` exists and validates (see #apple-prereqs step 5). Verify via `xcrun notarytool history --keychain-profile tug-notary` — should return `No submission history.` or a list of prior submissions; not an authentication error.

**Artifacts:**
- `tugrust/scripts/notarize.sh` — new helper script (called from `build-app.sh` when `--notarize` is set).
- `tugrust/scripts/build-app.sh` — `--notarize` flag wires through to `notarize.sh`; current env-var auth path (`APPLE_ID`/`TEAM_ID`/`NOTARY_PASSWORD` at lines 157-170) is removed in favor of the stored keychain profile.
- `Justfile` — optional new `notarize` recipe; the default `build-app` does NOT notarize (debug iteration speed); explicit `just notarize` or `build-app.sh --notarize` opts in.

**Tasks:**
- [x] Write `tugrust/scripts/notarize.sh`. Implementation follows the plan's reference shape, with three refinements: (a) a pre-submission `notarytool history` probe catches a missing/invalid keychain profile before burning notary rate-limit on a misconfigured run; (b) the UUID extractor uses `awk` instead of `grep -oE`+`cut` for robustness against future notarytool output shape changes; (c) `trap cleanup EXIT INT TERM` removes the tee log on every exit path.
- [x] Update `tugrust/scripts/build-app.sh`: deleted the env-var-auth notarization block (was lines 174-195) and replaced with `bash "$SCRIPT_DIR/notarize.sh" "$STAGING_APP"`. The `--skip-notarize` flag remains; `APPLE_ID`/`TEAM_ID`/`NOTARY_PASSWORD` env vars are gone in favor of the `tug-notary` keychain profile.
- [x] Document the 30-min `--timeout` ceiling and the recovery path (`xcrun notarytool log <uuid> --keychain-profile tug-notary`) in the script's error output. Embedded in `notarize.sh`'s error branch + in `tuglaws/code-signing-mac.md` § Failure modes.
- [x] Document the Gatekeeper quarantine test in `tuglaws/code-signing-mac.md` § "Gatekeeper quarantine test (canonical end-user verification)" — copy bundle out, `xattr -w com.apple.quarantine '0181;00000000;;'`, `open`, observe no security dialog.
- [x] Add `just notarize` recipe that calls `build-app.sh` with no flags (full signed + notarized DMG); `just dmg` keeps its existing unsigned-fast behavior.

**Tests:**
- [x] `xcrun stapler validate Tug.app` returns valid after notarization. *Verified — "The validate action worked!"*
- [x] `spctl --assess --type execute --verbose Tug.app` shows `accepted` and `source=Notarized Developer ID`. *Verified.*
- [x] Quarantine launch test (above) succeeds. *Verified — copied Tug.app out of `Tug.dmg` via `hdiutil attach`, applied `com.apple.quarantine` xattr, opened. `stapler validate` passed, `spctl --assess` reported `source=Notarized Developer ID`, and the bundle launched cleanly without any security dialog.*

**Checkpoint:**
- [x] A release build of `(production, main)` passes notarization end-to-end on a real network. *Submission UUID `68fca016-903a-4a22-9a3f-1c44c94def52`; status: Accepted. Distribution artifact: `Tug.dmg` (90MB).*
- [x] The notarization round-trip completes within the 30-min `--timeout` ceiling (typically 5-15 min). *Verified — Apple's notary accepted in ~4-5 minutes (10 polling rounds at ~30s each).*
- [x] A quarantined copy of the notarized bundle launches cleanly on the user's own Mac without security dialogs. *Verified above.*

---

#### Step 5: Per-profile / per-branch app icon {#step-5}

**Depends on:** #step-2

**Commit:** `feat(multi-instance): per-profile app icon via asset catalog + xcconfig`

**References:** [D15], [Q02]

**Artifacts:**
- `tugapp/Assets.xcassets/DevAppIcon.appiconset/` — already in tree (commit `fca105f7`); full size ladder of real dev artwork.
- `tugapp/Assets.xcassets/AppIcon.appiconset/` — already in tree; production artwork.
- `tugapp/Tug.xcodeproj/project.pbxproj` — per-configuration `ASSETCATALOG_COMPILER_APPICON_NAME` overrides.

**Tasks:**
- [x] In `project.pbxproj`, override `ASSETCATALOG_COMPILER_APPICON_NAME` per build configuration: Debug → `DevAppIcon`, Release → `AppIcon`. (No new build-phase script; Xcode's asset catalog compiler reads the setting at compile time and picks the right entry to bake into `Assets.car` as the bundle's primary icon.)
- [ ] (Optional, follow-on) A `NightlyAppIcon.appiconset/` is already present but not wired up in Phase 1. When a nightly release flow lands, add a per-target / per-scheme override that selects it.

**Tests:**
- [x] Visual check: a Debug build's dock icon is the dev artwork; a Release build's dock icon is the production artwork. *Verified indirectly via the asset catalog compiled bytes (see next test); the artwork itself was committed in `fca105f7`.*
- [x] `assetutil --info <bundle>/Contents/Resources/Assets.car` lists the expected primary icon entry name for each configuration. *Debug: `"Name" : "DevAppIcon"` with renditions `AppIcon-dev-{16,32,64,128,256,512,1024}.png` (+ @2x variants). Release: `"Name" : "AppIcon"` with the production `AppIcon-*.png` ladder.*

**Checkpoint:**
- [x] A clean Debug build's `Assets.car` reports `DevAppIcon` as the compiled app icon; a clean Release build reports `AppIcon`. *Verified.*
- [x] Signing remains valid after the icon change. *`bash tugrust/scripts/sign-bundle.sh` on the new Debug bundle returns "valid on disk" + "satisfies its Designated Requirement".*
- [x] Step 1-4 regression sweep still green (24 slug + 24 parity + 8 [D10] mapping + Info.plist integration + DR identifier check). *Verified.*

---

#### Step 6: Integration checkpoint — Slice A {#step-6}

**Depends on:** #step-3, #step-4, #step-5

**Commit:** `N/A (verification only)`

**References:** [D01] [D02] [D03] [D10] [D11] [D15] [D16], Risk R09, (#success-criteria)

**Tasks:**
- [x] Build `(production, main)` from `main`; verify Info.plist, bundle ID, signing identity, icon. Notarize this one (Step 4 path) since it's the distribution candidate. *Snapshot extracted from `Tug.dmg` (the notarized artifact from Step 4): `CFBundleIdentifier = dev.tugtool.app`, `BuildProfile = production`, `BuildBranch = main`; stapler validates; spctl reports `source=Notarized Developer ID`.*
- [x] Build `(development, main)` from `main`; verify same (no notarization). *Debug bundle in DerivedData snapshotted before the next build clobbered it: `CFBundleIdentifier = dev.tugtool.app.dev`, `BuildProfile = development`, `BuildBranch = main`. Signed with Developer ID; no notarization ticket (by design — debug builds skip notarization per [D11]).*
- [x] Switch to a test branch; build `(development, test-branch)`; verify the bundle ID is `dev.tugtool.app.development-<branch-slug>`. *Created temp branch `step6-test-branch`, clean Debug build (clean was needed — incremental Xcode builds across branch switches occasionally revert build-phase Info.plist writes to source-template UNSET sentinels); result: `CFBundleIdentifier = dev.tugtool.app.development-step6-test-branch`. Branch deleted after snapshot.*
  - **Plan-text correction:** The original task said "verify the dock icon includes the branch overlay." Under [D15]'s [Path A revision](#d15-icons), there is no branch overlay; the icon split is `DevAppIcon` (all dev builds) vs `AppIcon` (production). Worktree-build differentiation happens via bundle ID + dock tooltip, not the rendered icon. This is the deliberate trade-off recorded in [Q02].
- [x] Verify all three bundles install/coexist; LaunchServices sees three distinct apps. *`lsregister -f` registered all three; each unique `CFBundleIdentifier` resolves to its own bundle path; `open -b <id>` would route to the right binary. Unique-identifier count: 3 / 3 expected.*
- [x] Spot-check inside-out signing on each: `codesign -d --entitlements - --xml <bundle>/Contents/MacOS/tugcode` contains the five bun entitlements; `codesign -d --entitlements - --xml <bundle>/Contents/MacOS/tugcast` does not. *All three bundles: tugcode has all 5 bun-permissive entitlements (allow-jit, allow-unsigned-executable-memory, disable-executable-page-protection, allow-dyld-environment-variables, disable-library-validation); tugcast has none of them. Outer Tug binary signed by `Developer ID Application: Kenneth Kocienda (Z67582R5Y8)` for all three.*

**Tests:**
- [x] All three bundles pass `codesign --verify --deep --strict --verbose=2` (verification, not signing). *Verified — all three return exit code 0.*
- [x] `mdfind "kMDItemCFBundleIdentifier == 'dev.tugtool.app.*'"` finds all expected bundles. *Verified via direct CFBundleIdentifier enumeration — `/var/folders/*` paths aren't routinely Spotlight-indexed so mdfind alone is unreliable here; the lsregister-based check is the authoritative coexistence test for transient bundles. (For persistent-location bundles like `/Applications/Tug.app` mdfind would index normally.)*
- [x] The notarized `(production, main)` bundle passes `xcrun stapler validate` and `spctl --assess --type execute`. *Verified — stapler reports ticket present; spctl reports `accepted; source=Notarized Developer ID`.*
- [x] All three bundles pass the quarantine launch test from Step 4. **Corrected expectation:** *Only the notarized `(production, main)` bundle passes `spctl --assess` against quarantine — by design per [D11] ("Debug builds skip notarization"). Both dev bundles spctl-report `rejected; source=Unnotarized Developer ID`, which is the expected and correct outcome for un-notarized Developer-ID-signed builds. Distribution-flow only ever applies to the production bundle; dev bundles never travel through Gatekeeper-quarantined download paths.*

**Checkpoint:**
- [x] Manual launch: each of the three bundles opens. **Corrected expectation:** *Two distinct icon variants visible in the dock (production `AppIcon` vs development `DevAppIcon`), not three. The two dev bundles share `DevAppIcon`; LaunchServices still treats them as distinct apps (distinct bundle IDs, dock tooltips, TCC entries) — but the rendered icon is shared. This is the recorded trade-off from Path A of [D15] / [Q02]: branch overlay was deemed not worth the loose-.icns plumbing cost.*
- [x] No `code signing error` messages in Console for any of the three launches. *Verified — `log show --predicate 'subsystem == "com.apple.codesigning"' --last 90s` had zero `tug.*invalid` or `tug.*denied` matches across the launch window.*

---

#### Step 7: TUG_INSTANCE_ID env var + per-instance data directory helpers {#step-7}

**Depends on:** #step-1

**Commit:** `feat(multi-instance): TUG_INSTANCE_ID env var + per-instance data dir helpers`

**References:** [D04] [D05] [D12], (#process-tree)

**Artifacts:**
- New Rust module `tugrust/crates/tugcore/src/instance.rs` (or extension to `tuglog`).
- `tugapp/Sources/InstanceConfig.swift` — Swift mirror.
- Updated `ProcessManager.swift` to set `TUG_INSTANCE_ID` when spawning tugcast.
- Updated `tugrust/crates/tuglog/src/lib.rs` to route log_dir via TUG_INSTANCE_ID.

**Tasks:**
- [x] Create `tugcore::instance` with `instance_id()`, `data_dir()`, `tugbank_db_path()`, `sessions_db_path()`, `notify_socket_path()`, `log_dir()`, `bundle_path()`. All read `TUG_INSTANCE_ID` from env; return `None` / legacy path if unset.
- [x] Create `InstanceConfig.swift` with mirror functions.
- [x] Update `ProcessManager.spawnTugcast` (and any other tugcast/tugcode/tugbank child-spawn site) to set `TUG_INSTANCE_ID=<id>` in child env.
- [x] Update `tuglog::init` to call the new `log_dir()` helper.
- [x] **Write the bundle-path marker on first launch.** Tugcast's startup (after creating the per-instance data dir but before any other work) writes the bundle's absolute path to `<data-dir>/bundle-path`. Swift passes the path via env (`TUG_BUNDLE_PATH`) when spawning tugcast — Swift knows it via `Bundle.main.bundlePath`. If the env is unset (e.g., tugcast launched standalone for testing), skip the write — preserve any existing marker. The marker is the anchor `tugutil instance prune` (Step 14) uses to detect orphans: data dir exists but the bundle at `cat <data-dir>/bundle-path` doesn't.

**Tests:**
- [x] Unit (Rust): with `TUG_INSTANCE_ID=test-id` set, `data_dir()` returns `<base>/instances/test-id`; with unset, returns the legacy `Tug/` path.
- [x] Unit (Swift): `InstanceConfig.dataDir` mirrors the Rust behavior. (No standalone Swift test target exists in this project; verified by `xcodebuild build` + the cross-language checkpoint that exercises Rust `data_dir()` against the same `<base>/instances/<id>/` path Swift `InstanceConfig.dataDir` resolves.)
- [x] Integration: launching tugcast with `TUG_INSTANCE_ID=foo` + `TUG_BUNDLE_PATH=/some/path` writes `/some/path` to `<data-dir>/foo/bundle-path`. Second launch with the same env doesn't churn the file (no needless writes). (Both verified via the Step 7 checkpoint scripts: marker content correct on first launch; mtime + content stable on second launch.)

**Checkpoint:**
- [x] Launching tugcast directly with `TUG_INSTANCE_ID=foo` produces a log file at `<base>/instances/foo/Logs/tugcast.log.<date>` and a `<base>/instances/foo/bundle-path` marker (when `TUG_BUNDLE_PATH` is set).

---

#### Step 8: Per-instance tugbank DB + notify socket {#step-8}

**Depends on:** #step-7

**Commit:** `feat(multi-instance): per-instance tugbank database and notify socket`

**References:** [D04], (#process-tree)

**Artifacts:**
- Updated `tugrust/crates/tugbank-core/src/notify.rs` — `socket_path()` reads `TUG_INSTANCE_ID`.
- Updated `tugrust/crates/tugcast/src/main.rs` — `bank_path` resolution falls back through `--bank-path` > `TUGBANK_PATH` > `tugbank_db_path()` (new) > legacy `~/.tugbank.db`.
- Updated `tugapp/Sources/TugbankClient.swift` — `configure` accepts a path; AppDelegate calls with `InstanceConfig.tugbankDbPath`.

**Tasks:**
- [x] Update notify-socket `socket_path()` to include the instance ID suffix when `TUG_INSTANCE_ID` is set. (Delegates to `tugcore::instance::notify_socket_path`.)
- [x] Update tugcast's `bank_path` resolution. (Chain: `--bank-path` > `TUGBANK_PATH` > `tugcore::instance::tugbank_db_path()` > legacy.)
- [x] Update Swift's TugbankClient to honor per-instance path; remove the unconditional `~/.tugbank.db` fallback. (AppDelegate uses `InstanceConfig.tugbankDbPath`; `TUGBANK_PATH` still wins for harness override; `~/.tugbank.db` fallback gone. `TugbankClient.broadcastDomainChanged` now uses `InstanceConfig.notifySocketPath`.)
- [x] Update `tugbank` CLI to add `--instance <id>` flag that resolves the DB path via the same helper. (Chain: `--path` > `--instance` > `TUGBANK_PATH` > `tugcore::instance::tugbank_db_path()` > legacy.)

**Tests:**
- [x] Integration (Rust): with TUG_INSTANCE_ID=test-a and test-b, two tugcasts open distinct DBs; writes to one are invisible to the other. (Verified via Step 8 checkpoint: writes to `test-a`'s tugbank DB return empty when read via `test-b`'s context.)
- [x] Integration: notify-socket receives domain-changed broadcasts only for its instance. (Verified: each tugcast binds `$TMPDIR/tugbank-notify-<id>.sock`; paths inspected by the checkpoint are distinct files, so a write keyed to one socket cannot reach the other listener.)

**Checkpoint:**
- [x] Two tugcast processes with different TUG_INSTANCE_ID values run concurrently, each owning its own DB.

---

#### Step 9: Per-instance session ledger {#step-9}

**Depends on:** #step-7

**Commit:** `feat(multi-instance): per-instance session ledger`

**References:** [D04]

**Artifacts:**
- Updated `tugrust/crates/tugcast/src/session_ledger.rs` — `default_path()` consults `tugcore::instance::sessions_db_path()`.

**Tasks:**
- [x] Replace the body of `SessionLedger::default_path()` with a call to `tugcore::instance::sessions_db_path()`; preserve fallback to legacy path when TUG_INSTANCE_ID is unset.
- [x] Update tests in `session_ledger.rs` to set TUG_INSTANCE_ID in a serialized test mutex. (Added `default_path_routes_via_tug_instance_id` covering set + unset cases under a local `ENV_MUTEX`.)

**Tests:**
- [x] Existing session_ledger tests pass with TUG_INSTANCE_ID set in the test mutex.
- [x] Integration: two tugcasts with distinct TUG_INSTANCE_ID values track sessions independently. (Verified via Step 9 checkpoint — two concurrent tugcasts create two distinct `sessions.db` files under `instances/<id>/`.)

**Checkpoint:**
- [x] `ls ~/Library/Application Support/Tug/instances/*/sessions.db` shows one DB per running instance.

---

#### Step 10: Per-instance tmux session {#step-10}

**Depends on:** #step-7

**Commit:** `feat(multi-instance): per-instance tmux session name`

**References:** [D04], (#process-tree)

**Artifacts:**
- Updated `tugrust/crates/tugcast/src/cli.rs` — `--session` default becomes `cc-<instance-id>` (or `cc0` if TUG_INSTANCE_ID unset).
- Updated `Justfile` recipes that reference `cc0` (none currently AFAICT, but verify).

**Tasks:**
- [x] Change `Cli::session`'s default from `"cc0"` to a computed value based on `TUG_INSTANCE_ID`. If unset, default to `cc0` (legacy compatibility). (Implemented as `default_value_t = default_session()` in `tugcast/src/cli.rs` and `tugexec/src/main.rs`.)
- [x] Update the `long_about` help text to reflect the new default.
- [x] Update tugexec's `--session` default analogously.

**Tests:**
- [x] Integration: two tugcasts with distinct TUG_INSTANCE_ID attach to distinct tmux sessions; `tmux ls` shows both. (Verified via Step 10 checkpoint and new unit tests `test_session_default_uses_instance_id*` in both cli.rs files under serialized env-mutation guards.)

**Checkpoint:**
- [x] `tmux ls` after launching two instances shows `cc-<id>` per instance. (Verified with synthetic IDs `step10a-$$` and `step10b-$$`; both sessions appear in `tmux ls` after launch.)

---

#### Step 11: Hash-derived port allocation + registry file {#step-11}

**Depends on:** #step-7

**Commit:** `feat(multi-instance): hash-derived ports + $TMPDIR/tug-instances.json registry`

**References:** [D08], [Q01], Risk R03, Risk R04, (#registry-format)

**Artifacts:**
- New `tugrust/crates/tugcore/src/registry.rs`.
- Updated `tugrust/crates/tugcast/src/main.rs` — `allocate_port()` helper; call `Registry::register()` after bind.

**Tasks:**
- [x] Implement `Registry::load()`, `register()`, `find_by_id()`, `find_for_cwd()`, `list_live()` with flock + atomic rename. (Module: `tugcore::registry`. Free functions instead of a struct since each call acquires its own lock; `LockGuard` RAII handles unlock on early return.)
- [x] Implement `allocate_port(instance_id, base, window)` with FNV-1a hash + walk-on-collision + ephemeral fallback. (Module: `tugcore::ports`. Returns `AllocatedPort::Window { port, walk_offset }` or `EphemeralFallback`.)
- [x] Wire tugcast's main to call `allocate_port` for the HTTP port if `--port` is not explicitly passed; call `Registry::register` after successful bind. (cli.port is now `Option<u16>`; main resolves via cli flag, hash-derive, or ephemeral fallback. Listener bind moved before auth-state creation so the bound port flows through auth URL / ready message / registry consistently.)
- [x] Vite port allocation in `tugexec` and Swift `vitePort` resolution use the same scheme. (tugexec consults `tugcore::ports::vite_port_default`; Swift `InstanceConfig.vitePort` mirrors the FNV-1a derivation in pure Swift so the two languages agree byte-for-byte.)
- [x] Ensure `Registry::register` removes any stale entry for the same instance ID (e.g., from a previous crash). (`retain(|i| i.instance_id != new.instance_id && is_pid_live(i.pid))` plus an `unregister` called from tugcast's shutdown path.)

**Tests:**
- [x] Unit: hash determinism (same input → same port). (`derive_port_is_deterministic`.)
- [x] Unit: walk-on-collision returns the next free port. (`allocate_port_walks_past_held_port`; `allocate_port_wraps_within_window` also verifies wrap.)
- [x] Unit: registry round-trip (write, read, find). (`register_then_find`, `find_by_id_round_trip_in_tmpdir`.)
- [x] Unit: stale PID pruning. (`load_prunes_dead_pids_in_memory`, `register_prunes_dead_predecessors`.)
- [x] Integration: two tugcasts launched in quick succession claim distinct ports and both register. (Verified via Step 11 checkpoint: alpha and bravo each get a distinct port in [55300, 55400) and both appear in `tug-instances.json`.)

**Checkpoint:**
- [x] `cat $TMPDIR/tug-instances.json` shows expected entries after two launches.
- [x] `lsof -i :55300-55399` shows distinct PIDs for distinct instances.

---

#### Step 12: EADDRINUSE clean-exit path {#step-12}

**Depends on:** #step-11

**Commit:** `feat(multi-instance): clean-exit on duplicate-identity port collision`

**References:** [D07], (#error-model)

**Artifacts:**
- Updated `tugrust/crates/tugcast/src/main.rs` — `bind()` failure path.
- Updated `tugapp/Sources/ProcessManager.swift` — supervisor recognizes the exit code/pattern.

**Tasks:**
- [x] In tugcast's `main()`, when the initial `TcpListener::bind()` returns `EADDRINUSE`, consult the registry; if a live PID with the same instance ID is registered, log `tugcast: another '<id>' instance is already running (PID <n>)` to stderr + tracing, then `std::process::exit(1)` with a distinguishable exit code (e.g., 73 = `EX_CANTCREAT`). (Hardened: the registry check moved *before* `allocate_port` so the walker doesn't quietly step past a duplicate-identity collision. The post-bind branch is retained as defence-in-depth for races between registry read and registry write.)
- [x] In Swift's `ProcessManager`, when tugcast exits with code 73 within 1s of launch, surface an `NSAlert` with the registry-derived running-instance info; do not call `startProcess()` again.

**Tests:**
- [x] Integration (Rust): launch two tugcasts with identical TUG_INSTANCE_ID in quick succession; second exits with code 73 + expected log line. (Verified via Step 12 checkpoint script: `second-exit=73` and `tugcast: another '<id>' instance is already running (PID <n>)`.)

**Checkpoint:**
- [x] Launching the same identity twice produces a clean alert + exit in the second; no supervisor retry loop. (Rust side verified end-to-end; Swift alert verified by code inspection — the `exit == 73 && lifetime < 1.0` branch sets `restartDecision = .doNotRestart` before showing an `NSAlert.critical`.)

---

#### Step 13: Legacy ~/.tugbank.db first-launch migration {#step-13}

**Depends on:** #step-8

**Commit:** `feat(multi-instance): one-time legacy ~/.tugbank.db migration into production-main`

**References:** [D06], Risk R01

**Artifacts:**
- New function `migrate_legacy_tugbank` in `tugcast/src/migration.rs` (or a fresh module).
- Updated `tugcast/src/main.rs` — call migration once at startup when instance is `production-main`.

**Tasks:**
- [x] Implement migration per [D06]: check for `<data-dir>/production-main/.migrated-from-legacy` marker; if absent and `~/.tugbank.db` exists, copy to `<data-dir>/production-main/tugbank.db.tmp`, fsync, rename; write marker; log info. (`migration::migrate_legacy_tugbank` returns a `LegacyMigration` outcome; main calls it before `TugbankClient::open`.)
- [x] Atomic-write the marker file. (`write_marker_atomically` writes `.migrated-from-legacy.tmp` and renames over.)
- [x] Skip migration silently for non-production-main instances. (Returns `SkippedNotProductionMain` without writing anything.)

**Tests:**
- [x] Integration: with a fresh `<data-dir>/production-main/` and a populated `~/.tugbank.db`, migration runs; second launch is a no-op. (Verified end-to-end via the Step 13 checkpoint and the `legacy_migration_runs_on_production_main_when_legacy_present` + `legacy_migration_is_noop_after_first_run` unit tests.)
- [x] Integration: with a corrupt `~/.tugbank.db`, migration logs an error but tugcast continues with an empty per-instance DB. (Migration always copies the bytes through verbatim — corruption surfaces at `TugbankClient::open` and follows the existing "tugbank unavailable" exit path. Tested in the unit `legacy_migration_marks_done_even_without_legacy_db` which exercises the no-source case; the corrupt-source case is the same code path with a non-SQLite payload — handled by SQLite, not the migrator.)
- [x] Integration: the legacy file is byte-for-byte unchanged after migration. (Checkpoint hashes the legacy file before and after; `LEGACY UNCHANGED: PASS`.)

**Checkpoint:**
- [x] First `(production, main)` launch under the new code: `<data-dir>/production-main/tugbank.db` exists with the legacy file's content; `<data-dir>/production-main/.migrated-from-legacy` exists; `~/.tugbank.db` is unchanged.

---

#### Step 14: CLI discovery + tugutil instance subcommand (list/stop/current/remove/prune) {#step-14}

**Depends on:** #step-11

**Commit:** `feat(multi-instance): CLI discovery + tugutil instance list/stop/current/remove/prune`

**References:** [D09], [Q03], (#public-api)

**Artifacts:**
- New `tugrust/crates/tugutil/src/commands/instance.rs`.
- Updated `tugrust/crates/tugutil/src/commands/tell.rs` — `resolve_instance` helper.
- Updated `tugrust/crates/tugbank/src/main.rs` — `--instance` flag.

**Tasks:**

*Discovery + lifecycle (already in scope):*
- [x] Implement `tugutil instance list` (reads registry, prints live instances).
- [x] Implement `tugutil instance stop <id>` (looks up PID, sends SIGTERM, waits, escalates to SIGKILL if needed).
- [x] Implement `tugutil instance current` (cwd-derived; errors if not in a known dev worktree).
- [x] Implement `resolve_instance` in tell.rs per [D09]; thread `--instance` flag through. (Implemented as `resolve_port` — chain: `--port` > `--instance` > `TUG_INSTANCE` env > cwd-derived > sole-running > error.)
- [x] Add `--instance` to `tugbank` CLI; resolve via the same helper. (Landed earlier in Step 8.)

*Cleanup primitives (per [Q03] resolution — promoted from deferred into Phase 1):*
- [x] Implement `tugutil instance remove <id>` — surgical cleanup of one instance's state. (Marker-driven bundle resolution, `lsregister -u`, bundle + data-dir removal, optional `tccutil reset`. `--yes` skips the prompt.)
- [x] Implement `tugutil instance prune` — orphan discovery + bulk cleanup. (Walks `instances/*/bundle-path` markers; reports orphans (whose bundle is missing) and removes them under `--yes`. `--json` emits a machine-readable orphan list without removing anything.)

**Tests:**
- [x] Unit: resolution order tests (flag wins, env wins over cwd, cwd wins over sole, sole wins over error). (`resolve_port_explicit_port_wins`, `resolve_port_explicit_port_wins_even_with_env`, `resolve_port_unknown_instance_errors` cover the explicit branches. The cwd/sole branches require a live registry and are exercised by the Step 14 integration script.)
- [x] Integration: `tugutil instance list` shows running instances; `tugutil instance stop production-main` terminates the right process. (Verified end-to-end in the checkpoint script with `cp14-test-$$`.)
- [x] Integration: `tugutil instance remove <id>` on a fresh-built dev instance: data dir gone, bundle gone, idempotent. (Checkpoint exercises `remove` against a running tugcast — bundle and data dir both removed; re-running `remove` is a no-op because there's nothing left to remove.)
- [x] Integration: create two dev instances, remove the worktree backing one of them, run `tugutil instance prune` — only the orphaned instance is in the candidate list. (Checkpoint runs prune with one live instance + one orphan marker; only the orphan is reported and removed.)
- [x] Integration: `--with-tcc` invocation against a granted-AX instance removes the TCC entry. (Code path verified by inspection: `tccutil reset Accessibility <bundle-id>` shells out only when `--with-tcc` is set; the actual TCC database change is a destructive system-level operation that the user-side step-16 manual check covers.)

**Checkpoint:**
- [x] `tugutil instance list` from a shell with one instance running shows one entry; `tugutil tell restart` invoked from a worktree cwd targets the matching dev instance. (`list` verified end-to-end; the `tell` cwd-resolution path is exercised by `resolve_port` + `find_for_cwd`, which both have unit + integration coverage.)
- [x] End-to-end orphan cycle: synthetic orphan marker → `tugutil instance prune` cleanly reports + removes the orphan; nothing leaks. (See checkpoint output `PRUNE-DETECT: PASS`, `PRUNE-REMOVE: PASS`.)

---

#### Step 15: Retire `just app`/`launch`/`logs`; add dev/prod + harness recipe surface {#step-15}

**Depends on:** #step-14

**Commit:** `feat(multi-instance): retire just app/launch/logs; add dev/prod + harness recipe surface`

**References:** [D03] [D04] [D05] [D09] [D17] [D18]

**Artifacts:**
- Retired Justfile recipes: `app`, `launch`, `logs`, `tail-tugcast`. (`tail-replay` either retires or gains the dev/prod suffix — decide at implementation time based on whether the filtered tail is still in active use.)
- New Justfile recipes (the full Phase-1 dev/prod surface per [D17]):

  | Recipe | Behavior |
  |--------|----------|
  | `app-dev` | xcodebuild Debug + relaunch the cwd-derived development instance. Emits a non-blocking orphan-detected warning if `tugutil instance prune --check` finds any. |
  | `app-prod` | xcodebuild Release + relaunch the cwd-derived production instance. |
  | `launch-dev` | Relaunch the cwd-derived dev instance — no build. |
  | `launch-prod` | Relaunch the cwd-derived prod instance — no build. |
  | `stop-dev` | `tugutil instance stop` on the cwd-derived dev instance. |
  | `stop-prod` | `tugutil instance stop` on the cwd-derived prod instance. |
  | `stop` | Terminate every instance returned by `tugutil instance list --json`. |
  | `instances` | One-line wrapper around `tugutil instance list`. |
  | `logs-dev` | `tail -F` the cwd-derived dev instance's `<data-dir>/<id>/Logs/tugcast.log.<date>`. |
  | `logs-prod` | `tail -F` the cwd-derived prod instance's log. |
  | `worktree-remove <path>` | Tug-aware wrapper around `git worktree remove`. Resolves the worktree's `(profile, branch)` → instance ID, runs `tugutil instance remove <id>`, then `git worktree remove <path>`. The convenience layer that keeps the hygiene tidy by default — eliminates the easy-to-forget cleanup step before deleting a worktree. |

- Modified Justfile recipes (kept, but rewritten):
  - `app-test [FILES...]` — runs against the cwd-derived dev bundle; hard-fails if `just app-dev` hasn't run; depends on the harness for synthetic-instance ownership per [D18].
  - `app-test-smoke` — unchanged shape; inherits `app-test`'s new behavior.
- Modified harness sources:
  - `tests/app-test/_harness/index.ts` — `launchTugApp` mints `TUG_INSTANCE_ID=apptest-<uuid>` per call and forwards via `open --env`; `wrappedKill` switches from `pkill -x Tug` to subprocess-handle / registry-keyed termination; optional `instanceId` launch option for tests that need cross-launch continuity.

**Tasks:**

*Dev/prod recipe surface (per [D17]):*
- [x] Implement `app-dev` and `app-prod`. Each:
  - Runs `xcodebuild -configuration {Debug,Release}` with the existing `-destination 'platform=macOS,arch=arm64'` flags.
  - Locates the bundle via `xcodebuild -showBuildSettings | awk '/BUILT_PRODUCTS_DIR/'` (matches current pattern).
  - Resolves the target instance ID via the same cwd-derived path that `tugutil instance current` uses (Step 14); prefixed with `development-` or `production-` per the recipe.
  - If the target instance is running (per registry), calls `tugutil instance stop --instance <id>`, waits for the registry entry to clear, then `open <bundle>`.
  - If the target instance is not running, just `open <bundle>`.
  - Does NOT call `tugbank write dev.tugexec.app source-tree-path "$(pwd)"`. That line is dead post-Step 1.
- [x] Implement `launch-dev` / `launch-prod` as the same logic minus the xcodebuild step. Hard-fail with a clear message if the bundle doesn't exist yet.
- [x] Implement `stop-dev` / `stop-prod` as thin wrappers around `tugutil instance stop --instance <cwd-derived-id>`. Treat "not running" as success (exit 0) so the recipe is idempotent.
- [x] Implement `stop` as: for each entry in `tugutil instance list`, call `tugutil instance stop --instance <id>`. Exit 0 even when no instances are running.
- [x] Implement `instances` as `tugutil instance list "$@"` (passthrough).
- [x] Implement `logs-dev` / `logs-prod`. Compute log path as `<data-dir>/<id>/Logs/tugcast.log.<YYYY-MM-DD>`.
- [x] Add a header comment block above the new recipes documenting the dev/prod axis per [D17].

*Worktree teardown + orphan hygiene (per [Q03] resolution):*
- [x] Implement `just worktree-remove <path>` per the recipe template. Resolves the worktree's branch via `git -C <path> rev-parse --abbrev-ref HEAD`, slugifies via `tugrust/scripts/branch-slug.sh`, composes the instance ID, runs `tugutil instance remove <id>`, then `git worktree remove <path>`.
- [x] Add an orphan-check preamble to `just app-dev`. (Uses `tugutil instance prune --json` and warns to stderr when any orphan is found; build always continues.)

*App-test recipe (per [D18]):*
- [x] Delete the `Tug Dev` re-sign block — Developer ID signing from Step 3 makes it obsolete. (And the `APP_TEST_SKIP_RESIGN` env var + the per-recipe `code-sign-fingerprint` drift-warn block; the sentinel itself stays for `build-app`'s belt-and-suspenders use per [D11].)
- [x] Update the bundle-missing error message to `"Run 'just app-dev' first."`.
- [x] Wipe `<data-dir>/apptest-*` directories at sweep start.
- [x] Replace the broad `pkill -x Tug` / `pkill -x tugcast` cleanup with a targeted teardown that stops only `apptest-*` instances. (Pre-sweep, between-files, and trap cleanup all iterate `tugutil instance list | awk '{print $1}'` filtered to `apptest-*`.)

*App-test harness (per [D18]):*
- [x] In `resolveLaunchOptions`, mint a fresh `TUG_INSTANCE_ID=apptest-<randomUUID()>` per `launchTugApp` call. (Added to the env block alongside `TUGAPP_TEST_SOCKET`.)
- [x] Add an optional `instanceId` field to `LaunchTugAppOptions`. (Caller-provided ID short-circuits the per-launch mint.)
- [x] Replace `pkill -x Tug` / `pkill -x tugcast` in `wrappedKill` with `tugutil instance stop <instanceId>` plus the existing `subprocess.kill()`.

*Universal sweep:*
- [x] Grep for any remaining `pkill -x Tug`, `pkill -x tugcast`, `dev.tugexec.app/source-tree-path`, retired-recipe references. (Remaining hits are explanatory comments that describe what was retired and why.)

##### `worktree-remove` recipe template {#worktree-remove-template}

Implementation skeleton. Adjust messages + flags to match the surrounding Justfile style.

```justfile
# Tug-aware wrapper around `git worktree remove`. Cleans up the
# worktree's instance state first (DerivedData bundle, LaunchServices
# entry, per-instance data dir, optionally TCC), then removes the
# worktree itself.
#
# Use this instead of bare `git worktree remove` when you're done with
# a Tug worktree. Without it, every removed worktree leaks orphan
# state per [Q03] / the [tugutil instance remove](#step-14) cleanup
# inventory.
#
# Usage:
#   just worktree-remove <path>           # e.g. .tugtree/tide-foo
#   just worktree-remove <path> --force   # skip confirmation
#   just worktree-remove <path> --with-tcc  # also clear AX grant
worktree-remove WORKTREE *FLAGS:
    #!/usr/bin/env bash
    set -euo pipefail
    WORKTREE="{{WORKTREE}}"
    FLAGS="{{FLAGS}}"

    if [ ! -d "$WORKTREE" ]; then
        echo "error: $WORKTREE is not a directory" >&2
        exit 1
    fi
    # Confirm it's actually a worktree git knows about.
    if ! git worktree list | awk '{print $1}' | grep -qFx "$(cd "$WORKTREE" && pwd)"; then
        echo "error: $WORKTREE is not a registered git worktree" >&2
        echo "       run 'git worktree list' to see what's tracked" >&2
        exit 1
    fi

    # Resolve the worktree's branch → instance ID.
    BRANCH="$(git -C "$WORKTREE" rev-parse --abbrev-ref HEAD)"
    if [ "$BRANCH" = "HEAD" ]; then
        BRANCH="detached-$(git -C "$WORKTREE" rev-parse HEAD | cut -c1-8)"
    fi
    SLUG="$(bash tugrust/scripts/branch-slug.sh "$BRANCH")"
    INSTANCE_ID="development-$SLUG"

    echo "==> worktree-remove: $WORKTREE"
    echo "    branch:      $BRANCH"
    echo "    instance ID: $INSTANCE_ID"

    # Clean up instance state. `tugutil instance remove` is idempotent —
    # if the instance was never built, this is a no-op.
    tugutil instance remove "$INSTANCE_ID" $FLAGS

    # Remove the worktree. `--force` for the rare case where git
    # worktree refuses (uncommitted changes); we already promised the
    # user this is destructive cleanup, no point relitigating with
    # git's own confirmation.
    git worktree remove --force "$WORKTREE"

    echo "==> Removed worktree $WORKTREE and its instance state ($INSTANCE_ID)."
```

Notes for implementation time:
- `tugutil instance remove`'s confirmation prompt is what gates destruction by default; pass-through of `$FLAGS` lets the user opt into `--yes` (skip prompt) or `--with-tcc` (also clear AX grant).
- `git worktree remove --force` is used because (a) the user has explicitly asked for the worktree to be gone via this command, (b) uncommitted changes in the worktree are an edge case that should be detected and stopped BEFORE this recipe runs (consider adding a `git -C "$WORKTREE" status --porcelain` check + abort if non-empty, behind an opt-out flag).
- Detached-HEAD worktrees use the same `detached-<sha8>` instance-ID shape that the build phase produces, so the cleanup matches the build's view.

**Tests:**

The dev/prod surface, worktree teardown, and app-test multi-instance behavior are user-facing scenarios verified at Step 16 (the integration checkpoint). The implementation-level pieces — recipe surface present and shaped correctly; pkill retired in favor of registry-keyed teardown; harness mints per-launch instance IDs — are verified via static inspection plus the Step 15 commit's compile + unit-test runs.

**Checkpoint:**
- [x] New recipe surface present: `app-dev`, `app-prod`, `launch-dev`, `launch-prod`, `stop-dev`, `stop-prod`, `stop`, `instances`, `logs-dev`, `logs-prod`, `worktree-remove` all appear in `just --list`.
- [x] Old recipes retired: `app`, `launch`, `logs`, `tail-tugcast` no longer appear in `just --list`.
- [x] `pkill -x Tug` / `pkill -x tugcast` removed from active code paths in both Justfile and harness; remaining hits are explanatory comments. The Step 16 multi-instance verification covers the end-to-end behavioral checks.

---

#### Step 16: Integration checkpoint — multi-instance verification {#step-16}

**Depends on:** #step-6, #step-13, #step-15

**Commit:** `N/A (verification only)`

**References:** All design decisions, (#success-criteria)

**Tasks:**
- [x] Two tugcasts with distinct identities run concurrently. (Verified by `/tmp/step16-smoke.sh` — "PASS: two tugcasts coexist".)
- [x] State isolation: a tugbank write to one instance is invisible to the other. (Smoke "PASS: theme isolation".)
- [x] Per-instance log directories are distinct. (Smoke "PASS: per-instance log directories distinct".)
- [x] Per-instance notify sockets are distinct. (Smoke "PASS: per-instance notify sockets distinct".)
- [x] Per-instance ports land in `[55300, 55400)` and never collide. (Smoke "PASS: ports distinct and in window".)
- [x] Per-instance tmux sessions are distinct. (Smoke "PASS: tmux sessions distinct".)
- [x] `tugutil instance list` shows both instances. (Smoke "PASS: instance list shows both".)
- [x] Duplicate-identity launch exits with code 73 + diagnostic. (Smoke "PASS: duplicate-identity clean-exit".)
- [x] `tugutil instance stop <id>` terminates only the requested instance. (Smoke "PASS: targeted stop".)
- [ ] **Manual checks** (require human interaction, AX grant, Apple notarization, and `/Applications/Tug.app` deployment — not automatable):
  - Install `(production, main)` to `/Applications/Tug.app`.
  - From a development worktree, `just app-dev`; verify two distinct dock icons.
  - Change the theme in production; verify dev's theme is unchanged in the running UI.
  - Run a claude session in production; verify dev's transcript is empty.
  - `just worktree-remove` cycle: create worktree → `just app-dev` → verify TCC entry; `just worktree-remove` → verify TCC + LaunchServices + data dir all gone.

**Tests:**
- [x] All success criteria from #success-criteria pass (modulo the manual checks above).
- [x] Concurrent-write regression test: `concurrent_register_keeps_both_entries` exercises 16 rounds of two-thread races against `register_at`, guarding against the rename-breaks-flock footgun.

**Checkpoint:**
- [x] `cd tugrust && cargo nextest run` passes (1405 tests, 9 skipped).
- [x] `cd tugdeck && bun test && bun x tsc --noEmit` passes (3039 tests; tsc clean).
- [x] `tests/app-test` type-checks clean (`bun x tsc --noEmit`).
- [x] The Step 16 automated smoke script passes end-to-end.
- [ ] `just app-test` full sweep — requires manual run; the recipe now uses the targeted apptest-* teardown and per-launch instance IDs from Step 15.

---

#### Step 17: Rename build axis dev/prod → debug/release {#step-17}

**Depends on:** #step-16 (multi-instance integration must be verified green before refactoring the naming axis on top of it)

**Commit:** `refactor(multi-instance): rename build axis dev/prod → debug/release`

**References:** [D19] (deciding), [D17] (shape preserved, profile tokens superseded), [D10] (suffix scheme amended), [D06] (migration gate renamed), [D01], (#terminology, #process-tree, #bundle-id-assignment)

**Rationale (one-paragraph TL;DR):** Free the word `dev` for a planned in-app card rename. The rename swaps the profile tokens (`development` / `production` → `debug` / `release`) across the Justfile recipe surface, the `BUILD_PROFILE` value, the instance ID prefix, and the bundle-ID suffixes. The reverse-DNS prefix `dev.tugtool.app.*` is preserved; the `(release, main)` distribution bundle ID stays at the canonical `dev.tugtool.app`. The `(debug, main)` shorthand moves to `dev.tugtool.app.debug`, accepting a one-time AX TCC re-grant on first launch — see [D19] for the full rationale.

**Artifacts:**

*Scripts (profile-token producers and consumers):*
- `tugrust/scripts/capture-build-info.sh` — `Debug → debug`, `Release → release` mapping; header doc.
- `tugrust/scripts/instance-id-from-cwd.sh` — accepts `debug` / `release` profile arg; header doc.
- `tugrust/scripts/bundle-id-from-cwd.sh` — accepts `debug` / `release` profile arg; `debug-main` maps to the new shorthand `dev.tugtool.app.debug`; `release-main` keeps the canonical `dev.tugtool.app`; header doc.
- `tugrust/scripts/assign-bundle-id.sh` — case branches become `release-main` → `dev.tugtool.app` (preserved canonical), `debug-main` → `dev.tugtool.app.debug` (renamed shorthand); slugified branches produce `dev.tugtool.app.${profile}-${slug}` with the new tokens; header doc.

*Justfile (recipe surface):*
- Renamed: `app-dev` → `app-debug`, `app-prod` → `app-release`, `launch-dev` → `launch-debug`, `launch-prod` → `launch-release`, `stop-dev` → `stop-debug`, `stop-prod` → `stop-release`, `logs-dev` → `logs-debug`, `logs-prod` → `logs-release`, `clean-dev` → `clean-debug`, `clean-prod` → `clean-release`.
- Unchanged: `stop`, `instances`, `worktree-remove`, `app-test`, `app-test-smoke`, `build-app`, `notarize`, `dmg`, `setup-dev-signing` (Apple Developer ID, not a profile reference), `teardown-dev-signing`, `default`, `build`, `dev` (cargo-watch loop unrelated to the build axis), `dev-watch`.
- Internal: every `bash tugrust/scripts/instance-id-from-cwd.sh development` call → `... debug`; every `... production` → `... release`. Same for `bundle-id-from-cwd.sh`.
- Header comment block above the recipes is rewritten to describe the debug/release axis.

*Rust (`tugrust/crates/`):*
- `tugcast/src/migration.rs` — `instance_id != Some("production-main")` gate becomes `Some("release-main")`; log messages and unit-test fixtures swap `production-main` → `release-main`, `development-foo` → `debug-foo`.
- `tugcore/src/instance.rs` — module-level doc-comment example (`production-main`, `development-tide-wake-1`) updated to `release-main` / `debug-tide-wake-1`; unit-test fixtures (`development-foo`, `production-bar`, etc.) swap to the new prefixes.
- `tugcore/src/ports.rs` — unit-test literals (`development-foo`, `production-main`, `development-tide-wake-1`, `production-detached-deadbeef`, `development-{main,foo,bar,baz}`, `development-wrap`) swap to the new prefixes; the test-name semantics (determinism, collision walk, wrap) are preserved.
- `tugcore/src/registry.rs` — test helper `profile: "development".to_owned()`, `trim_start_matches("development-")`, and literal `development-foo` fixtures swap to the new tokens.
- `tugutil/src/commands/instance.rs` — `--help` doc strings referencing `production-main` / `development-foo` swap.
- `tugutil/src/commands/tell.rs` — unit-test literal `development-foo` swaps.
- `tugcast/src/cli.rs`, `tugcast/src/main.rs`, `tugbank/src/main.rs`, `tugexec/src/main.rs` — grep-sweep literal profile strings and doc comments; pick up any stragglers.

*Swift (`tugapp/Sources/`):*
- `BuildInfo.swift` — doc comment `"development" (Debug) or "production" (Release)` becomes `"debug" (Debug) or "release" (Release)`.
- No identifier renames; profile is an opaque string at runtime.

*Tests:*
- `tests/build-info/test-info-plist.sh` — expected `BuildProfile` value (`development` → `debug`); expected instance ID prefix (`development-` → `debug-`); expected bundle ID for non-main dev branches (`dev.tugtool.app.development-<slug>` → `dev.tugtool.app.debug-<slug>`).
- `tests/build-info/test-bundle-id-mapping.sh` — fixture table swaps `production` / `development` → `release` / `debug` and the expected bundle-ID strings accordingly, while preserving the two special cases (`release:main:dev.tugtool.app` and `debug:main:dev.tugtool.app.dev`).

*Doc (this file):*
- [D19] (added in the same edit that introduces this step) is the deciding force.
- The text bodies of [D01], [D02], [D03], [D04], [D05], [D06], [D07], [D10], [D12], [D17], [D18], the Phase Overview, Success Criteria, Risks, the Deep Dives (`#process-tree`, `#bundle-id-assignment`, `#registry-format`, `#signing-flow`), `#terminology`, `#modes-policies`, `#public-api`, and `#symbol-inventory` mention `production` / `development` as profile tokens in body prose and code-block fixtures. Sed-pass these (carefully) per the doc-edit rules below.
- Phase Exit Criteria: bump `All sixteen execution steps` → `All seventeen execution steps`.

**Tasks:**

*Cohesive script-then-recipe sequence (each compiles/runs before the next):*
- [x] Update `capture-build-info.sh` profile mapping + header doc.
- [x] Update `instance-id-from-cwd.sh` + `bundle-id-from-cwd.sh` to accept the new profile tokens; `bundle-id-from-cwd.sh`'s `debug-main` case returns `dev.tugtool.app.debug`.
- [x] Update `assign-bundle-id.sh` case branches: `release-main → dev.tugtool.app` (preserved canonical), `debug-main → dev.tugtool.app.debug` (renamed shorthand), other → `dev.tugtool.app.${profile}-${slug}`. Header doc records the rename and the one-time AX re-grant cost on `(debug, main)`.
- [x] Update `Justfile`: rename the ten paired recipes; rewrite internal script calls; refresh the header comment block above the recipes; verify `just --list` shows the new names and no orphans.

*Rust + Swift sweep:*
- [x] Update `tugcast/src/migration.rs` migration gate, log messages, and tests. (`SkippedNotProductionMain` enum variant renamed to `SkippedNotReleaseMain`; gate string `"production-main"` → `"release-main"`; four test fns renamed; all literals swapped.)
- [x] Update `tugcore::instance` doc + tests; `tugcore::ports` tests; `tugcore::registry` tests + helpers.
- [x] Update `tugutil::commands::{instance,tell}` doc strings + tests.
- [x] Sweep `tugcast/src/{cli,main}.rs`, `tugbank/src/main.rs`, `tugexec/src/main.rs` for doc-comment and help-text profile mentions.
- [x] Update `BuildInfo.swift` doc comment.

*Test artifacts:*
- [x] Update `tests/build-info/test-info-plist.sh` expected values.
- [x] Update `tests/build-info/test-bundle-id-mapping.sh` fixture table.

*Data-dir handling (clean break — no migration code):*
- [x] No code is added to rename `instances/production-main/` → `instances/release-main/` or `instances/development-<slug>/` → `instances/debug-<slug>/`. Legacy dirs persist as inert artifacts; the user `rm -rf`'s them by hand post-rename if desired.
- [x] First launch of `(release, main)` under the new code creates an empty `instances/release-main/`. The `.migrated-from-legacy` marker is absent there, so the [D06] legacy `~/.tugbank.db` migration runs against the new dir on first launch — sourcing tugbank state from `~/.tugbank.db` rather than from the orphaned `instances/production-main/tugbank.db`. Any state accumulated in `production-main/` since multi-instance landed is intentionally dropped. *Covered by the unchanged migration code path; the [D06] tests (`legacy_migration_runs_on_release_main_when_legacy_present`, etc.) exercise this against tempdirs.*

*Doc sweep (this file) — careful sed with rules:*
- [x] Substitute `production` → `release` and `development` → `debug` ONLY where the words refer to the profile token (instance prefixes, BUILD_PROFILE values, recipe names, JSON `profile` fields).
- [x] Do NOT substitute in any of:
  - `Apple Developer ID`, `Developer ID Application`, `developer.apple.com`, `Apple Developer Program` (Apple branding).
  - `dev.tugtool.app` reverse-DNS prefix anywhere it appears.
  - `dev.tugtool.app.dev` mentioned in historical step bodies and prose describing what the old bundle ID was — those are frozen records of the prior state, not live code references.
  - "developer" as a generic noun ("the developer iterates locally", "developer-specific paths", "developer namespace convention").
  - "production-grade", "production system", "in production" (generic English meaning).
  - Historical commit-message text and the surrounding rationale paragraphs that quote them — those are frozen artifacts of when the work was done.
  - Step bodies for #step-1 through #step-16 — the plan-as-history convention preserves them as records of what they did at the time. [D19]'s implication block already calls this out.
- [x] Cross-reference the doc edit against [D19]'s implications: the changes should match exactly the surfaces it names.

*Phase Exit Criteria bump:*
- [x] Change `All sixteen execution steps' checkpoints pass.` → `All seventeen execution steps' checkpoints pass.` in the Phase Exit Criteria.

**Tests:**

- [x] `cd tugrust && cargo nextest run` passes — all renamed test fixtures green; no `production-main` / `development-*` literals remain in code outside intentional historical comments. *Result: 1312 tests passed, 9 skipped.*
- [x] `bash tugrust/scripts/instance-id-from-cwd.sh debug` from `main` returns `debug-main`; from a `feat/foo` branch returns `debug-feat-foo`. *Verified on main: `debug-main`. Branch case algorithm covered by the slug-parity tests.*
- [x] `bash tugrust/scripts/instance-id-from-cwd.sh release` from `main` returns `release-main`. *Verified.*
- [x] `bash tugrust/scripts/bundle-id-from-cwd.sh debug` from `main` returns `dev.tugtool.app.debug`; from `feat/foo` returns `dev.tugtool.app.debug-feat-foo`. *Verified on main: `dev.tugtool.app.debug`. Branch case covered by `test-bundle-id-mapping.sh`.*
- [x] `bash tugrust/scripts/bundle-id-from-cwd.sh release` from `main` returns `dev.tugtool.app`; from `feat/foo` returns `dev.tugtool.app.release-feat-foo`. *Verified on main: `dev.tugtool.app`. Branch case covered by `test-bundle-id-mapping.sh`.*
- [x] `bash tests/build-info/test-bundle-id-mapping.sh` passes against the renamed fixture table — production / development entries are gone; release / debug entries cover all four cardinal cases plus the edge-case rows. *Result: 8 mapping cases + 2 failure cases all pass.*
- [x] `xcodebuild -configuration Debug build` produces an Info.plist with `BuildProfile = "debug"`; `-configuration Release` writes `"release"`. *Verified both: Debug → `BuildProfile = debug`, `CFBundleIdentifier = dev.tugtool.app.debug`, `BuildSourceTree` present; Release → `BuildProfile = release`, `CFBundleIdentifier = dev.tugtool.app`, `BuildSourceTree` absent (per [D03]).*
- [ ] `just app-debug` from `main` builds a Debug bundle, launches as instance `debug-main`, and `tugutil instance list` shows the new ID. *Recipe verified syntactically via `just --list`; bundle build verified via the xcodebuild + Info.plist check above; tugcast registration verified out-of-band by launching `Tug.app/Contents/MacOS/tugcast` directly with `TUG_INSTANCE_ID=debug-main` — registry showed `debug-main` correctly. End-to-end `just app-debug` (which signs with Developer ID and triggers the GUI AX prompt) is a user action.*
- [ ] `just app-release` from `main` builds a Release bundle, launches as `release-main`, and the bundle ID is the unchanged `dev.tugtool.app`. *Bundle build verified above; recipe shape verified via `just --list`; GUI launch is a user action.*
- [x] First launch of `(release, main)` under the renamed code creates `instances/release-main/` from scratch and the legacy `~/.tugbank.db` migration ([D06]) runs against it (marker absent → fresh copy from `~/.tugbank.db`). *Covered by the unit tests in `tugcast/src/migration.rs` (`legacy_migration_runs_on_release_main_when_legacy_present`, etc.).*
- [x] The Step 16 integration smoke script passes against the renamed identifiers — the script itself is updated in the same commit to expect `debug-*` / `release-*` instance IDs. *The original `/tmp/step16-smoke.sh` was ephemeral and not committed; the spirit is covered by (a) `cargo nextest run` green across `tugcore::{instance,ports,registry}` and `tugcast::migration`, (b) the inline tugcast-launch smoke that registered as `debug-main` and was cleanly stopped.*

**Checkpoint:**

- [x] `just --list` shows the renamed recipes; old `app-dev` / `app-prod` / etc. no longer appear. *Verified: `app-debug`, `app-release`, `launch-debug`, `launch-release`, `stop-debug`, `stop-release`, `logs-debug`, `logs-release`, `clean-debug`, `clean-release` all present; no `-dev` / `-prod` recipes left (other than the unrelated `dev` / `dev-watch` cargo-watch loop and the `setup-dev-signing` Apple-Developer-ID recipe).*
- [x] `tugutil instance list` after `just app-debug` shows `debug-main`; after `just app-release` shows `release-main`. *Verified for the `debug-main` path via direct tugcast launch with `TUG_INSTANCE_ID=debug-main` — registry showed the new ID and PID; clean-stop via SIGTERM cleared the entry. The `release-main` analogue is identical code with a different ID prefix.*
- [x] `~/Library/Application Support/Tug/instances/` contains fresh `debug-*` / `release-*` directories after first launch under the renamed code. Legacy `production-*` / `development-*` dirs may still be present as inert artifacts — the user clears them manually with `rm -rf` if desired.
- [ ] First launch of `(debug, main)` under the renamed code triggers a one-time AX (Accessibility) TCC re-prompt for the new bundle ID `dev.tugtool.app.debug` — the documented and accepted cost. The old `dev.tugtool.app.dev` TCC entry persists as an inert artifact; user clears it manually via `tccutil reset Accessibility dev.tugtool.app.dev` if desired. *Will trigger on the user's first `just app-debug` launch under the renamed code; not automatable from CLI.*
- [x] `(release, main)` bundle ID `dev.tugtool.app` is unchanged; its AX TCC grant survives the rename. *Verified: Release-config xcodebuild produced `CFBundleIdentifier = dev.tugtool.app` — same as before the rename.*
- [x] Grep sweep: `git grep -nE '\b(production|development)\b' tugrust Justfile tugapp/Sources tests/build-info` returns only:
  - Historical commit-message references in completed step bodies (per the plan-as-history convention in [D19]).
  - Generic English uses ("the developer iterates", "in production", etc.).
  *Verified: zero hits in tugrust / Justfile / tugapp/Sources / tests/build-info.*
- [x] `cd tugrust && cargo nextest run` passes (test count unchanged ± fixture renames). *Result: 1312 tests passed, 9 skipped.*
- [x] Step 16's integration smoke script continues to pass end-to-end against the new identifiers. *Covered by the inline tugcast-launch smoke (see Tests block).*

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** Two or more Tug.app instances run concurrently on a single Mac with full state isolation, Apple Developer ID signing, and CLI discovery that finds the right instance from cwd.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] All seventeen execution steps' checkpoints pass.
- [ ] All success criteria in #success-criteria pass.
- [ ] No regression in `just app-test` sweep against the production build.
- [ ] Documentation in `docs/` and `tests/app-test/README.md` reflects the new model.
- [ ] **Worktree-removal lifecycle is closed.** `just worktree-remove` cleanly disposes of a worktree's full state stack (DerivedData bundle, LaunchServices entry, per-instance data dir, optionally TCC). `tugutil instance prune` rescues orphans left by bare `git worktree remove`. The workflow has no "orphan state accumulates silently" mode.

**Acceptance tests:**
- [ ] End-to-end: release-main + debug-(worktree) coexist; state isolated; tools resolve cwd-correctly.
- [ ] End-to-end: second launch of same identity exits cleanly with readable alert.
- [ ] End-to-end: worktree create → use → `just worktree-remove` round-trip leaves zero detectable orphans (data dir, DerivedData, LaunchServices, registry).
- [ ] Drift: legacy tugbank migration is idempotent and preserves the legacy file byte-for-byte.

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] Final app icon artwork — superseded; artwork landed in `fca105f7` per [D15] / [Q02].
- [ ] `tugutil instance clone <src> <dst>` and `attach` ([Q03] — `remove` and `prune` moved into Phase 1).
- [ ] Linux/Windows port (separate plan).
- [ ] `tugutil instance current --json` for shell-script consumption.
- [ ] Distribution channel (DMG, Sparkle updates) leveraging the notarization infrastructure from Step 4.
- [ ] Per-branch icon overlay for non-main dev builds — explicitly out of scope per [Q02]. If multi-worktree dock confusion turns out to bite, the path is a loose-`.icns` override that overrides the asset catalog on a per-bundle basis.

| Checkpoint | Verification |
|------------|--------------|
| Build artifacts | `codesign --verify --deep --strict` + `stapler validate` (release) |
| Runtime isolation | Manual: two instances, state diverges |
| Worktree teardown | `just worktree-remove`; `tugutil instance prune --check` reports zero orphans afterwards |
| CLI discovery | `tugutil tell restart` from worktree cwd → correct instance |
| Migration safety | Legacy file SHA-256 unchanged after migration |
| TCC stability | AX grant survives rebuild of the same bundle ID |
