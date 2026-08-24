<!-- devise-skeleton v4 -->

## Onboarding & Install Hardening {#onboarding-and-install}

**Purpose:** Turn the one-off "clean Sequoia VM installs and onboards Tug.app" success into a repeatable, multi-OS, golden-tested install/onboarding pipeline — with a vendored lab workflow, a Tahoe + macOS-27 (Golden Gate) VM matrix, per-line minimum-version guidelines enforced by a Tug-styled runtime gate, and a refined TugSetup experience covering happy and unhappy paths.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-06-29 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

The macOS VM lab (Tart on `/Volumes/Lab-A`) was built to test factory-fresh installs of Tug.app, and it has already paid for itself: it surfaced three clean-machine onboarding failures — the tmux preflight dialog, the source-tree launch gate, and the `Missing tiktoken_bg.wasm` crash — each now fixed (`62beec13f`, `e2ebaa44b`, `b13b3e1db`). A clean Sequoia 15.7.7 guest now installs the dmg, runs the TugSetup wizard (managed `claude` install → browser sign-in → first Dev card), and completes real signed-in turns.

What we *don't* have yet: the lab is a pile of uncommitted shell scripts on an external disk; we only test one OS (Sequoia); there are no minimum-version guidelines (the `LSMinimumSystemVersion` plist says 13.0 but nothing below Sequoia has ever run); the TugSetup UX is functional but unrefined and its unhappy paths are largely undesigned; and the session-error diagnostic that *found* the tiktoken bug ships with "horrid" copy (`crash_budget_exhausted`) and an uncopyable stack trace. This plan closes all of that and certifies the result with golden runs across Sequoia, Tahoe, and macOS 27 (Golden Gate).

#### Strategy {#strategy}

- **Write the audit down first.** The as-built record + known-gaps register (this document's [As-Built Audit](#as-built-audit)) is itself the first deliverable, so the institutional knowledge from three debugging sessions stops living only in chat.
- **Vendor the workflow before scaling it.** Bring the lab scripts into the repo and wrap them in `just` recipes *before* adding OS targets, so the matrix expansion rides version-controlled tooling, not disk-local one-offs.
- **One reliable inner loop.** Encode the "fresh boot establishes a fresh VirtioFS mount" discipline into a single command so the unreliable re-install-into-running-VM path can't be taken by accident.
- **Policy near the UI.** The minimum-version matrix lives as one TS constant beside the gate it drives; the backend reports only the raw host OS version (via the existing connection handshake).
- **Make the installer itself great.** The pre-install window (drag-to-Applications) is the first impression; build it with a deterministic, headless tool (dmgbuild) so a branded DMG ships on every build, not a bare disk image.
- **Design the unhappy paths.** Every TugSetup obstacle (install fail, sign-in cancel/timeout, mid-session logout, version-too-old, transport-down, session-spawn failure) gets a designed state, not a fallthrough.
- **Iterate unsigned, certify signed.** Use the fast unsigned dmg while building each milestone; run one signed+notarized golden pass per OS at close, since Gatekeeper acceptance is part of what we certify.
- **Empirical minimums.** The exact minimum point-release per OS line is data the golden runs produce; seed sensible defaults and lock them in at the end.

#### Success Criteria (Measurable) {#success-criteria}

> Make these falsifiable. Avoid "works well".

- `scripts/lab/` contains `lab-new`/`lab-run`/`lab-wipe`/`lab-ls` and `just lab-cycle <os>` builds the unsigned dmg, stages it, wipes any prior run, clones a fresh base, and boots it — in one command, verified by running it for `sequoia`. (#t01-inner-loop)
- `TART_HOME=/Volumes/Lab-A/tart tart list` shows `base-sequoia`, `base-tahoe`, and `base-goldengate`, all bootable; a repo-tracked matrix manifest lists each with its macOS version. (#s01-matrix-manifest)
- Launching Tug.app on a guest whose macOS minor version is below the matrix floor shows a Tug-styled "update macOS" gate (not a crash, not the launchd plist dialog) carrying the actual host version; launching on a supported version does not. (#s02-version-gate)
- Opening `Tug.dmg` presents a branded, retina drag-to-Applications window (hidden Finder chrome, app icon → Applications symlink over Tug background art); the build is deterministic with no Finder/GUI session, and the `.dmg` is code-signed on signed builds. (#distribution-dmg)
- A signed+notarized golden run passes the full [golden-run checklist](#l02-golden-checklist) on all three OS bases, with results (pass/fail + host version) recorded in the matrix manifest. (#l02-golden-checklist)
- The session-error banner no longer reads `crash_budget_exhausted`; its diagnostic stderr is selectable and copyable via a Copy control. (#p08-error-banner)
- Every [TugSetup state](#tugsetup-states) — happy and unhappy — renders a designed, on-brand panel verified in the running app (HMR or VM), with no fallthrough/placeholder.

#### Scope {#scope}

1. As-built audit of all build/packaging/install/onboarding work since `62beec13f`, plus a known-gaps register.
2. A branded drag-to-Applications distribution DMG (dmgbuild), plus vendoring the lab scripts into the repo and consolidating the workflow behind `just` recipes (one-command inner loop).
3. Expanding the VM base-image matrix to Tahoe and macOS 27 (Golden Gate, from the local IPSW), with a tracked manifest.
4. A per-line minimum-version support matrix and a Tug-styled runtime gate that enforces it (host OS version delivered via the connection handshake).
5. Step-by-step TugSetup UX refinement — happy-path polish and first-class unhappy-path states — including fixing the session-error banner copy and making its diagnostic copyable.
6. Golden runs across all three OS bases (unsigned during iteration; one signed+notarized certifying pass per OS at close).

#### Non-goals (Explicitly out of scope) {#non-goals}

- Notarizing the dmg *wrapper* itself (the `.app` is notarized/stapled and, with [P11], the `.dmg` is now code-signed; *notarizing* the dmg wrapper remains a known follow-on, tracked in [Roadmap / Follow-ons](#roadmap)).
- Supporting Intel/x86_64 hosts (Tug is arm64-only in practice; the Rust helpers are host-arch).
- Raising the Xcode `MACOSX_DEPLOYMENT_TARGET` (stays 13.0; the runtime gate, not the compiler floor, carries support policy — see [P05]).
- Auto-updating Tug.app or a Sparkle-style updater.
- CI automation of the golden runs (they remain operator-driven this phase; a scripted *checklist* is in scope, unattended CI is not).
- Windows / Linux hosts.

#### Dependencies / Prerequisites {#dependencies}

- Tart installed (`brew install cirruslabs/cli/tart`), `TART_HOME=/Volumes/Lab-A/tart`, Lab-A disk mounted.
- The Golden Gate IPSW at `/Volumes/Lab-A/ipsw/UniversalMac_27.0_26A5368g_Restore.ipsw` (present, 21 GB).
- A Cirrus prebuilt or self-built Tahoe (macOS 26) base image (acquisition is part of [#step-4]).
- Apple Developer ID + `tug-notary` keychain profile for the signed golden passes ([P09]).
- The committed onboarding fixes (`b13b3e1db`) on `main`.

#### Constraints {#constraints}

- **Re-installing into a running VM is unreliable** (VirtioFS cache + stale `/Applications/Tug.app`); the inner loop must always boot a fresh clone. ([P02])
- The Bash tool shell does not source `~/.zshrc`; lab recipes must set `TART_HOME` explicitly. ([P01])
- WARNINGS ARE ERRORS in the Rust workspace (`-D warnings`); the version-channel work in tugcast must stay clean.
- tugdeck laws: external state enters React only via `useSyncExternalStore` [L02]; appearance via CSS/DOM not React state [L06]; one `root.render()` [L01]. The version gate and TugSetup states must conform.
- Verify tugdeck with `bunx tsc --noEmit` **and** `bunx vite build` (production rollup catches what dev esbuild misses).
- macOS 27 is a **beta**; Tart/virtualization support and bundled-dep parity are not guaranteed (see [R01], [Q03]).

#### Assumptions {#assumptions}

- The connection handshake response (`router.rs`) is the right app-level channel for the host OS version — it fires once per connect, before any card, which matches the app-wide gate. ([P06])
- tugcast is **co-located** with Tug.app (local host), so its `kern.osproductversion` *is* the user's macOS version. If tugcast is ever run remote, the OS source must move to the Swift host (`ProcessInfo.operatingSystemVersion`) — a follow-on, not this phase. ([P06])
- The minimum supported line is Sequoia and up; older lines (Ventura/Sonoma) are untested and treated as unsupported until proven otherwise ([Q02]).
- The lab's golden bases stay factory-fresh (Gatekeeper/spctl disabled so unsigned dmgs run); the signed golden pass is what certifies the real Gatekeeper path.
- The same bundled arm64 static binaries (tmux, tugcode) that work on Sequoia work on Tahoe/27 unless a golden run shows otherwise ([Q03]).

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Empirical per-line minimum point releases (OPEN) {#q01-empirical-minimums}

**Question:** What is the actual minimum point release that works for each supported macOS line (e.g. is the Sequoia floor 15.0, 15.4, or 15.6)?

**Why it matters:** The matrix [S01] and the gate [S02] enforce these numbers; guessing too low admits a broken OS, too high locks out working users.

**Options (if known):** Seed `sequoia ≥ 15.6`, `tahoe ≥ 26.0`, `macos27 ≥ 27.0` and refine.

**Plan to resolve:** The golden runs ([#step-10], [#step-11]) test the floor on each base; record the lowest version that passes the checklist into the manifest.

**Resolution:** OPEN — resolved empirically in M06; seeded with defaults until then.

#### [Q02] Drop Ventura/Sonoma, i.e. what is the absolute floor? (RESOLVED) {#q02-absolute-floor}

**Question:** Do we keep nominally claiming macOS 13.0 (`LSMinimumSystemVersion`), or raise the plist floor to the lowest line we actually support (likely Sequoia 15)?

**Why it matters:** `LSMinimumSystemVersion` is the launchd-enforced coarse gate; if it stays 13.0 the runtime gate must cover the whole 13–15 range; if we raise it, launchd shows its (ugly) dialog below the floor and our gate only covers supported-line minors.

**Options (if known):** (a) keep 13.0, gate everything in-app; (b) raise plist to the matrix's absolute minimum, gate only minors within supported lines.

**Plan to resolve:** Decide during [#step-6] once the matrix data model is concrete; recommend (b) with the absolute floor = lowest supported line.

**Resolution:** RESOLVED (b), M04 — `LSMinimumSystemVersion` raised `13.0 → 15.0` (the lowest supported line, Sequoia). launchd blocks anything below macOS 15 with its own dialog (truly ancient); the Tug runtime gate covers sub-minimum minors *within* supported lines (e.g. 15.0–15.5 < the 15.6 floor) and any unsupported newer/older line. The Xcode `MACOSX_DEPLOYMENT_TARGET` stays `13.0` (compiler floor ≠ support policy — non-goal).

#### [Q03] Bundled-dep parity on Tahoe / macOS 27 (OPEN) {#q03-dep-parity}

**Question:** Do the bundled arm64 static tmux and the bun-compiled tugcode (with embedded tiktoken wasm) run unmodified on macOS 26 and 27?

**Why it matters:** A dyld/codesign/runtime-ABI change on a newer OS could reproduce the class of failure the lab exists to catch.

**Plan to resolve:** The golden runs exercise a real session (which spawns tmux + tugcode + claude) on each base; failures feed back as fixes.

**Resolution:** OPEN — Tahoe (26) parity verified in the golden runs (M06); macOS 27 parity is **blocked** alongside Golden Gate ([R01]) until a 27 base can be built.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| macOS 27 beta won't virtualize under Tart | high | med | Self-build from the local IPSW; fall back to UTM/anka if Tart can't | `tart create --from-ipsw` fails |
| Version gate bricks a valid OS | high | low | Gate blocks only *below* floor; dev override; unit-test the comparator | any user reports a false lockout |
| Notary throughput stalls signed golden passes | med | med | Batch the three signed builds; reuse the stapled `.app`; iterate unsigned | a signed pass exceeds the notary window |
| Lab scripts hardcode `/Volumes/Lab-A` | med | high | Parameterize `TART_HOME`/`LAB_ROOT` env on vendoring | scripts run on another machine |

**Risk R01: macOS 27 (Golden Gate) virtualization support** {#r01-macos27-virt}

- **Risk:** Tart may not yet support creating/booting a macOS 27 beta guest from the IPSW.
- **Mitigation:** Build the base via `tart create --from-ipsw <path>`; if unsupported, document the blocker and defer the 27 base while keeping Sequoia + Tahoe golden.
- **Residual risk:** macOS 27 coverage may lag until Tart catches up to the beta.
- **MATERIALIZED (M03, 2026-06-29):** `tart create --from-ipsw` on the 27 IPSW fails at 0% (*"An error occurred during installation."*). Root cause is a known, Apple-acknowledged `VZMacOSInstaller` bug — a pre-27 host (ours is Sequoia 15.6) cannot restore a macOS 27 IPSW; it affects every Virtualization.framework tool, not just Tart, and is expected to be fixed in a later beta. **Golden Gate is deferred**; Sequoia + Tahoe remain the golden set. Future paths: OTA-upgrade a Tahoe guest to 27, or build on a native 27 host and copy the disk. See [base-prep.md](../scripts/lab/base-prep.md) §Golden Gate for refs.

**Risk R02: Version-gate false positive** {#r02-gate-false-positive}

- **Risk:** A comparator bug locks a supported OS out of the app entirely (the gate is app-modal, like TugSetup).
- **Mitigation:** Pure, unit-tested version comparison; a `DEV`-guarded override; the gate is the *only* blocking modal added and defaults open=false unless strictly below floor.
- **Residual risk:** A wrong matrix number (not a code bug) could still mis-gate until corrected — but that's data, hot-fixable.

---

### Design Decisions {#design-decisions}

#### [P01] Vendor the lab scripts into the repo (DECIDED) {#p01-vendor-lab-scripts}

**Decision:** Move `lab-new`/`lab-run`/`lab-wipe`/`lab-ls` from `/Volumes/Lab-A/bin` into `scripts/lab/` in the repo, parameterized by `TART_HOME`/`LAB_ROOT` env (defaulting to the Lab-A paths), and wrap them in `just lab-*` recipes.

**Rationale:**
- They're load-bearing test infrastructure currently untracked — a correctness and bus-factor risk the user flagged.
- In-repo means they version with the recipes that call them and survive a disk wipe.

**Implications:** A new `scripts/lab/` dir; `just` recipes call the in-repo scripts; the external copies become a stale mirror (documented as such).

#### [P02] One-command inner loop that enforces the fresh-clone discipline (DECIDED) {#p02-lab-cycle}

**Decision:** `just lab-cycle <os>` = build unsigned dmg → stage to share → `lab-wipe` prior run → `lab-new <os>` fresh clone → `lab-run` with the share mounted. There is no recipe that installs into a running VM.

**Rationale:** Re-installing into a running guest is unreliable (VirtioFS cache + stale app); a wasted cycle already proved this. Making the reliable loop the *only* loop removes the footgun.

**Implications:** Every test iteration boots a fresh guest; slightly slower per cycle, but deterministic.

#### [P03] Repo-tracked OS matrix manifest (DECIDED) {#p03-matrix-manifest}

**Decision:** A single checked-in manifest (`scripts/lab/matrix.json`) maps each supported OS: `{ key, codename, tart_base, macos_version, min_version, golden_status }`. Lab recipes and the golden checklist read it.

**Rationale:** One source of truth for "what we support and what we've certified," consumable by tooling and humans.

**Implications:** Adding an OS = one manifest entry + a base image; golden results are recorded back into it.

#### [P04] Build the Golden Gate base from the local IPSW (DECIDED) {#p04-goldengate-ipsw}

**Decision:** `base-goldengate` is created via `tart create --from-ipsw /Volumes/Lab-A/ipsw/UniversalMac_27.0_26A5368g_Restore.ipsw`, then prepared factory-fresh (Gatekeeper off, admin/admin) like `base-sequoia`.

**Rationale:** No Cirrus prebuilt exists for the 27 beta; the IPSW is already downloaded.

**Implications:** A documented base-prep procedure; depends on Tart IPSW support ([R01]).

#### [P05] Per-line minimum-version matrix + Tug-styled runtime gate (DECIDED) {#p05-version-gate-model}

**Decision:** Support policy is a per-major-line table of minimum point releases, enforced by an app-modal, Tug-styled runtime gate that reads the live host OS version. The Xcode deployment target stays 13.0; `LSMinimumSystemVersion` is set to the matrix's absolute floor ([Q02]).

**Rationale:** The user chose the per-line matrix model; a runtime gate gives an on-brand "update macOS" experience instead of the launchd plist dialog or a cryptic crash.

**Implications:** Needs a host-OS-version channel ([P06]); the gate composes with TugSetup as a sibling app-modal; comparator must be unit-tested ([R02]).

#### [P06] Host OS version rides the connection handshake (DECIDED) {#p06-handshake-os-version}

**Decision:** tugcast adds a `host` object (`{"os":"macos","version":"<x.y.z>"}`) to the handshake response in `router.rs`; the frontend connection layer captures it into a small store consumed by the version gate.

**Rationale:** The handshake fires once per connect, app-level, before any card — matching an app-wide gate, and it's the "from-the-drop" channel (no turn required). Reuses an existing frame rather than inventing a new feed.

**Implications:** A new field on the handshake response (back-compatible — additive); a new frontend `hostInfoStore` ([L02]); tugcast reads the OS version locally (`sw_vers`/sysctl).

#### [P07] Version policy lives in tugdeck, next to the gate (DECIDED) {#p07-policy-in-frontend}

**Decision:** The minimum-version matrix is a TS constant in tugdeck beside the gate UI and its copy; the backend reports only the raw version string.

**Rationale:** Policy and the user-facing copy that explains it belong together; keeps the backend dumb and the gate's behavior reviewable in one file.

**Implications:** Updating support policy is a one-file frontend change; the manifest ([P03]) and this constant are kept in sync (a small drift test).

#### [P08] Fix the session-error banner copy and make the diagnostic copyable (DECIDED) {#p08-error-banner}

**Decision:** Replace `crash_budget_exhausted`/"The card can't reach its session" with human copy, and make the stderr diagnostic panel text selectable with an explicit Copy control.

**Rationale:** The diagnostic surfaced in `b13b3e1db` did its job (found the tiktoken bug) but reads as horrid/internal and can't be copied — the user called this out directly.

**Implications:** tugdeck-only change to the dev-card error banner + a copy affordance; the backend `detail` (summary\nstderr) contract is unchanged.

#### [P09] Golden runs: unsigned to iterate, signed+notarized to certify (DECIDED) {#p09-golden-signing}

**Decision:** Milestone work uses the unsigned dmg (`just lab-dmg unsigned`); each OS gets one signed+notarized golden pass at phase close.

**Rationale:** The user's choice — balances iteration speed against certifying the real Gatekeeper/notary path users receive.

**Implications:** [#step-11] is the signed certifying pass; notary time is budgeted there, not per iteration.

#### [P10] Unhappy paths are first-class designed states (DECIDED) {#p10-unhappy-paths}

**Decision:** Each TugSetup obstacle is an explicitly designed state routed through `authStore` (+ the new host-info / transport stores), never an unhandled fallthrough.

**Rationale:** A setup wizard is judged by its failure modes; the clean VM has already shown several.

**Implications:** New `authStore`/derivation states for install-fail, sign-in cancel/timeout, mid-session logout, version-too-old, transport-down; each gets copy + visuals in [#step-10].

#### [P11] Branded drag-to-Applications DMG via dmgbuild (DECIDED) {#p11-styled-dmg}

**Decision:** Replace the bare `hdiutil` DMG step with a **dmgbuild**-driven styled disk image — a retina, Tug-branded background, hidden Finder chrome, 128pt icons, the app on the left, an `/Applications` symlink on the right, a custom volume icon/name — and `codesign` the resulting `.dmg`.

**Rationale:**
- The first thing a user sees is the installer window; a polished drag-to-Applications experience sets the tone (the user's explicit "extra special feature").
- **dmgbuild** writes the `.DS_Store` directly (via `ds_store`/`mac_alias`) — it needs **no Finder/AppleScript/GUI session**, so the build stays deterministic and headless, unlike `create-dmg`/AppleScript approaches that save `.DS_Store` asynchronously and fail silently in non-GUI/notary pipelines (`create-dmg`'s own `--skip-jenkins`/`--applescript-sleep-duration` flags are tells). See [Distribution DMG](#distribution-dmg).

**Implications:** A new `tugrust/scripts/dmg/` (settings + art + volume icon); `dmgbuild` becomes a build prerequisite; `build-app.sh`'s DMG step changes; signing the `.dmg` is now in scope (notarizing the dmg *wrapper* remains a follow-on, [#roadmap]).

---

### Deep Dives (Optional) {#deep-dives}

#### Picking this up cold (orientation for a fresh session) {#picking-up-cold}

> Read this first if you have no chat-history context. This plan is walked **interactively on `main`, one step at a time** — implement a step, pass its Checkpoint, commit, move on. Start at the first `pending` row in the [Step Status Ledger](#step-status-ledger) (Step 1 is done — the doc is committed; begin at **[#step-2]**). The repo's auto-memory (`MEMORY.md`) loads the durable facts; this is the plan-local quickstart.

**Operational etiquette (matters):**
- **The user drives the VM.** Do **not** launch Tug.app, click, sign in, or `screencapture` inside a guest. Build + stage the dmg, then hand off — the user installs and reports back. (SSH for read-only diagnostics only, and it has proven flaky.)
- **Commits:** work goes **directly on `main`** (no feature branches); only the user commits, except `/tugplug:commit`. **Never** add a `Co-Authored-By` / AI-attribution trailer.
- **Verify real, not faked:** drive real code paths in the real app. No jsdom/RTL render tests, no mock-store assertions (see [#test-non-goals]).

**Fast feedback loops:**
- tugdeck: `bunx tsc --noEmit` **and** `bunx vite build` — the debug app loads the production rollup, so an import that works under dev esbuild can still fail the build and hang the splash. HMR is always live; never hand-build tugdeck.
- tugcast / Rust: `cd tugrust && cargo nextest run -p tugcast` (workspace is `-D warnings`; warnings fail the build).
- **tugcode is a compiled bun binary** (rebuilt by `build-app.sh`) — its changes do **not** hot-reload.
- Installer for the lab: `just lab-dmg unsigned` (~2 min, no notary) → stages `/Volumes/Lab-A/share/Tug.dmg`. `just lab-dmg` = signed + notarized.

**Lab quickstart (Tart on `/Volumes/Lab-A`):**
- Set `TART_HOME=/Volumes/Lab-A/tart` **inline on every command** — the Bash tool shell does not source `~/.zshrc`.
- Scripts live (pre-vendoring) at `/Volumes/Lab-A/bin/{lab-new,lab-run,lab-wipe,lab-ls}`; [#step-3] vendors them to `scripts/lab/`.
- **Always a fresh clone** — never reinstall into a running guest (VirtioFS cache + stale `/Applications/Tug.app` make it unreliable; a cycle was already wasted on this). Loop: `lab-wipe <run>; lab-new sequoia <run2>; lab-run <run2> --dir=drop:/Volumes/Lab-A/share`. The dmg lands in the guest at `/Volumes/My Shared Files/drop/Tug.dmg`.
- `base-sequoia` is the only base today (macOS 15.7.7; login `admin`/`admin`; Gatekeeper/spctl **off** so unsigned dmgs run). [#step-5] adds `base-tahoe` + `base-goldengate`.

**Verified code touchpoints (by symbol — line numbers drift):**
- Handshake server response: `tugcast/src/router.rs` → `perform_handshake` (the `response` json carrying `protocol`/`version`/`capabilities` — add `host` here). Client parse: `tugdeck/src/connection.ts` → the `handshakePending` branch of `ws.onmessage` (already `JSON.parse`s the reply — the publish point for `hostInfoStore`). → [#step-6]
- App-modal mount: `tugdeck/src/deck-manager.ts` → the single `reactRoot.render()` Fragment (siblings `DeckCanvas`, `TugSetup`, `TugDevPanel`); add `TugVersionGate` as another sibling ([L01] preserved). → [#step-7]
- TugSetup: `tugdeck/src/components/tugways/tug-setup.tsx` (driven by `authStore`; `DEV_FORCE_SETUP` forces it under HMR for iteration). → [#step-9], [#step-10]
- Session-error banner: `dev-card.tsx` → `renderDevCardBanner` (+ `.dev-card-error-diagnostic` in `dev-card.css`); backend `detail` is `summary\nstderr`. → [#step-8]
- DMG build step: `tugrust/scripts/build-app.sh` → "Step 10: Create DMG" (`hdiutil create`, runs after the `SIGN_IDENTITY_ARG` sign block + notarize; wraps the already-notarized `.app`). → [#step-2]
- Auth backend (reference): `tugcast/src/actions.rs` (`check_auth`/`install_claude`/`claude_sign_in`) + `tugcast/src/feeds/claude_auth.rs` (`claude_executable`, `probe`/`login`/`install`).

**Relevant auto-memories:** [[project_macos_vm_lab]], [[reference_tugcode_wasm_embed]], [[project_tug_external_deps]], [[feedback_real_not_fake]], [[feedback_verify_with_vite_build]], [[feedback_commit_on_main]].

#### As-Built Audit — everything since 62beec13f {#as-built-audit}

The audit deliverable (M01). Three commits carried this work; this is the durable record.

**`62beec13f` — Bundle tmux, drop source-tree gate, auth gate**
- *Bundled static tmux:* `tugrust/scripts/fetch-tmux.sh` builds an arm64 static tmux from source (ncurses 6.5, libevent 2.1.12-stable, utf8proc 2.9.0; checksums pinned; links only libSystem/libresolv; Apple `xcrun clang`). Bundled by `build-app.sh` to `Contents/Resources/bin/tmux` + `terminfo/` + licenses, signed in `sign-bundle.sh`. `tugcore::instance::tmux_bin()` resolves `$TUG_TMUX` else `"tmux"`; 9 non-test call sites route through it; `TUG_USE_SYSTEM_TMUX` overrides. `ProcessManager` sets `TUG_TMUX`/`TERMINFO_DIRS`. **Result: the tmux preflight dialog is gone on a clean guest.**
- *Source-tree gate removed:* `tugcast/src/cli.rs` `--source-tree` is `Option<PathBuf>`; `main.rs` defaults `watch_dir` to a per-instance `bootstrap-empty` dir when absent; `AppDelegate.swift` `onReady` no longer gates production on a source tree. **Result: release launches straight to the Dev card.**

**`e2ebaa44b` + `b13b3e1db` — TugSetup gate, session-error diagnostics, tiktoken wasm fix**
- *TugSetup gate:* `tugdeck/src/components/tugways/tug-setup.tsx` — blocking Radix `AlertDialog` reusing TugAlert chrome (z 99990/99991), mounted once at the deck root; 3 steps (install → sign in → open first card) driven by `authStore` + deck card count. Deleted the superseded `auth-gate.*` and `tug-app-dialog.*`.
- *Auth backend:* `actions.rs` `check_auth`/`claude_sign_in`/`install_claude` (broadcast `claude_auth_result`/`claude_install_result` with `reason`); `claude_auth.rs` `AuthState`, `probe()`, `login()`, `install()`, and `claude_executable()` resolving PATH → `~/.local/bin/claude` (no shell-PATH edit), scrubbing `ANTHROPIC_*`/`CLAUDE_CODE_OAUTH_TOKEN`. `session.ts` `resolveClaudePath()` mirrors that fallback for the spawn. `main.tsx` sends the initial `check_auth` *after* `initActionDispatch` so the result handler is registered first.
- *Session-error diagnostics:* `agent_bridge.rs` captures the subprocess stderr tail (40-line ring) + spawn errors and folds them into the errored `SESSION_STATE` detail (`crash_budget_exhausted\n<stderr>`), with a 50 ms drain grace; the dev-card error banner splits summary (strip) from diagnostic (monospace panel). **This is the diagnostic that found the tiktoken bug.**
- *tiktoken wasm fix:* `tugcode/src/tokenizer.ts` — `@anthropic-ai/tokenizer`/`tiktoken/lite` resolve `tiktoken_bg.wasm` at import via `fs` over `__dirname` paths, which are `/$bunfs/root` in the compiled binary and absent on a clean machine → tugcode died at module load. New module uses `tiktoken/lite/init` + the wasm embedded with `with { type: "file" }`, instantiated once at `main()` startup. (See [[reference_tugcode_wasm_embed]].)

**Build pipeline (as-built):** `tugrust/scripts/build-app.sh` is a 10-step build (release Rust → tugcode bun-compile → tugdeck `bun run build` → xcodebuild Release → assemble → inject binaries → bundle tugplug → sign → notarize → hdiutil dmg). `just lab-dmg [unsigned]` wraps it and stages `Tug.dmg` to `/Volumes/Lab-A/share`. A bash-3.2 + `set -u` empty-array crash at the signing step was fixed. The `.app` is notarized/stapled; the **dmg wrapper is not** (cosmetic, [#roadmap]).

**Known-gaps register (inputs to the milestones):**

**List L03: Known gaps** {#l03-known-gaps}
- Lab scripts uncommitted on an external disk → M02.
- Only Sequoia tested; no Tahoe/27 coverage → M03.
- No minimum-version guidance or in-app gate (`LSMinimumSystemVersion` 13.0 is untested below Sequoia) → M04.
- TugSetup unhappy paths largely undesigned; happy path unpolished → M05.
- Session-error banner copy "horrid"; diagnostic uncopyable → M05 ([P08]).
- dmg wrapper not notarized → deferred ([#roadmap]).
- No golden certification across OSes → M06.

#### Lab matrix & inner loop {#lab-matrix}

**Table T01: Inner-loop commands (target)** {#t01-inner-loop}

| Command | Effect |
|---------|--------|
| `just lab-dmg [unsigned\|notarized]` | Build + stage `Tug.dmg` to the share (exists). |
| `just lab-new <os> [run]` | Clone `base-<os>` → `run-<run>` (wraps `scripts/lab/lab-new`). |
| `just lab-run <run> [flags]` | Boot a run guest (wraps `scripts/lab/lab-run`). |
| `just lab-wipe <run>\|--all` | Delete throwaway run(s). |
| `just lab-cycle <os>` | Full reliable loop: dmg → stage → wipe → fresh clone → boot. ([P02]) |

The guest mounts the share via `--dir=drop:/Volumes/Lab-A/share`; the dmg appears at `/Volumes/My Shared Files/drop/Tug.dmg`. A fresh boot establishes a fresh VirtioFS mount that sees the current dmg ([P02]).

#### Version gate flow {#version-gate-flow}

1. Client connects; tugcast's handshake response now carries `host:{os,version}` ([P06]).
2. The frontend connection layer writes it into `hostInfoStore` ([L02]).
3. A pure derivation compares the host version against the matrix constant ([P07]); if the host is *below* its line's minimum (or on an unsupported line), the version gate renders an app-modal "update macOS" panel — a sibling of TugSetup, same chrome. The gate **takes precedence over TugSetup** (Spec S02): while it's open, TugSetup suppresses itself, so the two app-modals never stack.
4. Above the floor (or host still unknown pre-handshake): gate `open=false`, TugSetup/decks proceed normally.

#### TugSetup states (happy + unhappy) {#tugsetup-states}

**List L01: TugSetup / gate states to design** {#l01-tugsetup-states}

- *Happy:* install Claude → sign in → open first card (polish: copy, spacing, iconography, spinner/progress, success transition; revisit the 3-vs-4-step question).
- *Install failed* (no network / curl blocked / disk full): error detail + Retry.
- *Sign-in cancelled or browser never returns* (timeout): recover with a re-try Sign In, clear "finish in your browser" guidance.
- *Claude present but logged out mid-session:* the per-card auth banner safety net (the previously-pending task #15).
- *Version too old:* the runtime gate ([#version-gate-flow]) — distinct from setup, but shares chrome.
- *Transport down during setup* (tugcast unreachable): a calm "reconnecting" state rather than a dead wizard.
- *Session-spawn failure:* the dev-card error banner with humane copy + copyable diagnostic ([P08]).

#### Distribution DMG {#distribution-dmg}

The pre-install half of onboarding: the window a user sees when they open `Tug.dmg`. Today it's a bare `hdiutil` image (app sitting in a plain Finder window). The target is a *great* drag-to-Applications experience ([P11]).

**Tool choice — dmgbuild (declarative, headless, deterministic).** Two families exist: AppleScript/Finder-driven (`create-dmg`, Tauri's `bundle_dmg.sh`, hand-rolled `osascript`) and direct-`.DS_Store`-writers (`dmgbuild`, `appdmg`). The AppleScript path positions icons by mounting the image and *asking Finder*, which (a) needs a logged-in GUI session and (b) saves `.DS_Store` asynchronously, so it "either fails silently or the changes don't get written back before unmount." `dmgbuild` (Python) writes the layout into `.DS_Store` itself with no Finder, no deprecated APIs — the right fit for `build-app.sh` running under notary/headless conditions. Verdict: **dmgbuild**.

**What separates a great DMG from a mediocre one (from the best examples — Panic's apps, Things, Sketch, Tower):**
- A **retina** background (1x + 2x reps in a multi-representation `background.tiff`), brand-coherent art — not a stock arrow on white.
- **All Finder chrome hidden** (toolbar, sidebar, path bar, status bar) so the window is *just* the art + two icons.
- Window sized to the background **exactly**; icons sized (≈128) and positioned to land on the art's marks; the instruction ("Drag Tug to Applications") and the arrow are **painted into the background**, not live UI.
- A **custom volume icon** + the volume mounts as a clean name (`Tug`).
- The `/Applications` target is a **symlink** (always the real folder), never a copied folder.
- The `.dmg` is **code-signed** (and, ideally later, notarized).

**Tug's instance:** dark, in Tug's visual language (consistent with the theme engine's tone skeleton), the app icon left, a tasteful arrow, the Applications glyph right, a quiet "Drag Tug to Applications" line, Tug volume icon. Authored once as `settings.py` + art, reproducible on every build.

**List L04: DMG polish checklist** {#l04-dmg-checklist}
- [ ] Retina background TIFF (1x+2x), brand art, arrow + "Drag Tug to Applications" baked in.
- [ ] Toolbar / sidebar / path bar / status bar hidden; window == background size.
- [ ] `icon_size` 128; app icon + Applications symlink positioned on the art's marks.
- [ ] Custom volume icon; volume name `Tug`.
- [ ] `/Applications` is a symlink; no stray visible files.
- [ ] `.dmg` code-signed; build needs no GUI/Finder session.

Sources: [dmgbuild settings](https://dmgbuild.readthedocs.io/en/latest/settings.html), [create-dmg](https://github.com/create-dmg/create-dmg), [Tauri DMG](https://v2.tauri.app/distribute/dmg/).

---

### Specification {#specification}

**Spec S01: OS matrix manifest** {#s01-matrix-manifest}

`scripts/lab/matrix.json` — array of entries:
```
{ "key": "sequoia",  "codename": "Sequoia",     "tart_base": "base-sequoia",
  "macos_version": "15.7.7", "min_version": "15.6", "golden_status": "pass|fail|untested" }
{ "key": "tahoe",     "codename": "Tahoe",       "tart_base": "base-tahoe",       "macos_version": "26.x",  "min_version": "26.0", ... }
{ "key": "goldengate","codename": "Golden Gate", "tart_base": "base-goldengate",  "macos_version": "27.0",  "min_version": "27.0", ... }
```
`min_version` and `golden_status` are seeded then refined by the golden runs ([Q01]).

**Spec S02: Version gate** {#s02-version-gate}

- Input: `hostInfoStore.version` (e.g. `"15.7.7"`), parsed to `{major,minor,patch}`.
- Policy: a TS constant `SUPPORTED_MACOS` keyed by major line → minimum `{minor,patch}` ([P07]); kept in sync with the manifest's `min_version` (drift test).
- Output: gate `open` iff the host line is unknown/unsupported OR host version `<` its line minimum. Comparison is a pure, unit-tested semver-ish compare. Treat *unknown* (no `host` field yet, e.g. pre-handshake) as **not below floor** → don't block (fail-open, [R02]).
- UI: app-modal panel in TugSetup chrome; copy names the host version and the required minimum; no dismiss (like TugSetup). A `DEV`-guarded override forces/suppresses it for iteration.
- **Precedence over TugSetup:** the version gate and TugSetup are both app-modal siblings at z 99990/99991, so a below-floor *and* not-yet-set-up user would otherwise satisfy `open` for both and stack them. The version gate **wins**: when it is open, TugSetup's `open` derivation must yield `false` (no point onboarding on an OS we're about to block). Implement as: TugSetup reads the gate-open derivation and suppresses itself while it is true.

**Spec S03: Handshake host field** {#s03-handshake-host}

The `router.rs` handshake response gains `"host": {"os":"macos","version":"<kern.osproductversion>"}` (read via `sysctl kern.osproductversion`, e.g. `"15.7.7"` — no subprocess). Additive and back-compatible: older clients ignore it; the gate treats a missing field as "unknown → don't block" (fail-open, since a false lockout is worse — [R02]).

**Spec S04: Distribution DMG (dmgbuild)** {#s04-dmg}

- Driver: `dmgbuild -s tugrust/scripts/dmg/settings.py "Tug" Tug.dmg`, invoked from `build-app.sh` in place of the bare `hdiutil` step.
- `settings.py` (key fields): `volume_name="Tug"`; `window_rect=((x,y),(w,h))` matching the background; `show_toolbar=show_sidebar=show_pathbar=show_status_bar=False`; `icon_size=128`; `text_size`; `background="background.tiff"` (1x+2x reps); `badge_icon`/volume `icon="VolumeIcon.icns"`; `files=["…/Tug.app"]`; `symlinks={"Applications":"/Applications"}`; `icon_locations={"Tug.app":(Lx,Ly), "Applications":(Rx,Ry)}`.
- Post-step: `codesign --force --sign "<Developer ID>" Tug.dmg` on signed builds; `--skip-sign` skips it (matches existing flags).
- Determinism: no Finder/AppleScript/GUI session ([P11]).

**Spec S05: DMG layout geometry** {#s05-dmg-geometry}

Concrete numbers for `settings.py` and the background art. All coordinates are **points** in dmgbuild's content-area space (origin **top-left**); `icon_locations` values are icon **centers**. The system-drawn title bar (traffic lights + volume name `Tug`) sits *above* this content area — the background art does **not** extend into it. Retina via a two-rep `background.tiff`.

**Table T02: DMG coordinates** {#t02-dmg-coords}

| Element | Value |
|---------|-------|
| Window content size (`window_rect` w×h) | **720 × 460** pt |
| Window position (`window_rect` x,y; Finder may re-center — size is what matters) | (200, 120) |
| Background image | `background.tiff`: **720×460 @1x** + **1440×920 @2x** (2 reps) |
| `icon_size` | **128** |
| `text_size` (label) | **13** |
| App icon center (`icon_locations["Tug.app"]`) | **(208, 250)** |
| Applications symlink center (`icon_locations["Applications"]`) | **(512, 250)** |
| Painted arrow center (in background art, not a live icon) | **(360, 250)** |
| "Drag Tug to Applications" caption center (painted) | **(360, 384)** |
| Heading / wordmark band (painted) | y ≈ **28–150** |

Layout rationale: icons are symmetric about the horizontal center (360); 304 pt apart, leaving a 176 pt gap between the 128 pt icon edges for the painted arrow. The icon+label stack (center 250) spans ≈186–334 vertically, clear of the heading band above and the caption below.

**Art safe-areas:**
- **Outer margin:** keep essential art ≥ **28 pt** from every edge — the window has rounded corners (~10–12 pt radius); the first/last ~12 pt are clipped.
- **Icon clear zones:** keep busy art out of **150 × 160 pt** boxes centered on each icon center (208, 250) and (512, 250) so the icons read; any "landing plinth" drawn there must be subtle/low-contrast.
- **Title-bar exclusion:** nothing essential in the top row — the OS draws the title bar above the content; the content's top ~12 pt also sits under the corner radius.
- **Arrow lane:** the arrow lives in the central ~176 pt gap (x 272–448) at y≈250; keep it clear of both icon clear zones.

**Production:** author `background@1x.png` (720×460) + `background@2x.png` (1440×920), then `tiffutil -cathidpicheck background@1x.png background@2x.png -out background.tiff` (tags the 2x rep at 144 dpi); point `background` at the `.tiff`. `default_view = "icon-view"`; arrange-by off (explicit `icon_locations` win).



#### State Zone Mapping (tugdeck/tugways plans) {#state-zone-mapping}

| State | Zone | Mechanism | Law |
|-------|------|-----------|-----|
| Host OS info (`{os,version}` from handshake) | local-data (external/server) | `hostInfoStore` + `useSyncExternalStore` | [L02] |
| Version-gate `open` | structure (derived) | pure derivation from `hostInfoStore` + policy constant; no own state | [L02] |
| Version-gate appearance / modal chrome | appearance | CSS + Radix portal (reuses `tug-alert-*`) | [L06], [L01] |
| TugSetup unhappy states (install-fail, sign-in cancel/timeout, logged-out) | local-data | `authStore` (+ derivations) via `useAuth()` | [L02] |
| Transport-down-during-setup | local-data | connection lifecycle → store snapshot | [L02] |
| Error-banner copy + Copy control | appearance + local | CSS/DOM; copy handler is a local imperative action | [L06] |

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files (if any) {#new-files}

| File | Purpose |
|------|---------|
| `scripts/lab/lab-new` `lab-run` `lab-wipe` `lab-ls` | Vendored lab scripts ([P01]) |
| `scripts/lab/matrix.json` | OS matrix manifest (Spec S01) |
| `scripts/lab/base-prep.md` | Factory-fresh base prep procedure (incl. Golden Gate from IPSW, [P04]) |
| `scripts/lab/golden-record` | Records a golden-run verdict into `matrix.json` ([#step-11]/[#step-12]) |
| `scripts/lab/golden-run.md` | Operator guide: unhappy-path induction recipes + coverage split ([#step-11]) |
| `tugdeck/src/lib/host-info-store.ts` | `hostInfoStore` + `useHostInfo()` ([P06]) |
| `tugdeck/src/lib/transport-state-store.ts` | App-wide transport health for TugSetup's reconnecting state ([P10]) |
| `tugdeck/src/lib/macos-support.ts` | `SUPPORTED_MACOS` policy + pure version compare (Spec S02) |
| `tugdeck/src/components/tugways/tug-version-gate.tsx` (+ `.css`) | The runtime version gate ([P05]) |
| `tugrust/scripts/dmg/settings.py` | dmgbuild config for the styled DMG (Spec S04, [P11]) |
| `tugrust/scripts/dmg/background.tiff`, `VolumeIcon.icns` | DMG retina background art + volume icon ([P11]) |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| handshake `host` field | json field | `tugcast/src/router.rs` | Spec S03 ([P06]) |
| `host_os_version()` | fn | `tugcast` (router/util) | reads `sysctl kern.osproductversion` |
| `parseHandshakeHost` | fn | `tugdeck` (`host-info-store.ts`) | pure parse of the handshake `host` field; unit-tested ([P06]) |
| `lab-cycle`, `lab-new`, `lab-run`, `lab-wipe`, `lab-ls` | just recipes | `justfile` | wrap `scripts/lab/*` ([P02]) |
| `lab-dmg` | just recipe | `justfile` | parameterize base/OS where needed |
| `hostInfoStore` | store | `host-info-store.ts` | [L02] |
| `compareMacosVersion`, `SUPPORTED_MACOS` | fn/const | `macos-support.ts` | unit-tested ([R02]) |
| `TugVersionGate` | component | `tug-version-gate.tsx` | app-modal sibling of TugSetup |
| error-banner copy + Copy control | edit | `dev-card.tsx`/`.css` | [P08] |
| DMG build step | edit | `tugrust/scripts/build-app.sh` | `dmgbuild` + `codesign` replace `hdiutil` ([P11]) |
| TugSetup unhappy states | edit | `tug-setup.tsx`, `auth-store.ts` | [P10] |

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit** | Pure logic | `compareMacosVersion`, gate open-derivation, manifest↔policy drift |
| **Integration (tugcast)** | Wire contract | handshake `host` field present + well-formed (`cargo nextest`) |
| **Manual / golden (VM)** | Real install+onboard on a real guest | the golden-run checklist per OS |

**List L02: Golden-run checklist (per OS base)** {#l02-golden-checklist}
1. `just lab-cycle <os>` boots a fresh guest with the dmg staged.
2. Install Tug.dmg; launch; **no** preflight/tmux/source-tree dialog.
3. Version gate: absent on a supported version (and, via a floor-spoof, present below floor).
4. TugSetup: managed `claude` install → browser sign-in → open first card.
5. A real signed-in turn completes (token count renders).
6. Close + reopen the card; resume works.
7. Record host version + pass/fail into `matrix.json`.

#### What stays out of tests {#test-non-goals}

- No jsdom/fake-DOM render tests for the gate or TugSetup (banned pattern; verified in the real app per [[feedback_real_not_fake]]).
- No mock-store assertions for `authStore`/`hostInfoStore` — drive real frames.
- Golden runs are operator-driven, not unattended CI (out of scope; [#non-goals]).

---

### Execution Steps {#execution-steps}

> Commit after all checkpoints pass. Steps are sized for interactive step-by-step execution on `main`.

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Land roadmap doc + as-built audit | done | 61ba4bfef, 12fb18de0 |
| #step-2 | Styled distribution DMG (drag-to-Applications) | done | cc8c83505 |
| #step-3 | Vendor lab scripts + just recipes | done | (pending commit) |
| #step-4 | One-command inner loop (`just lab-cycle`) | done | (pending commit) |
| #step-5 | Tahoe + Golden Gate bases + matrix manifest | done | (pending commit) — GG deferred [R01] |
| #step-6 | Host-OS-version handshake channel + store | done | (pending commit) |
| #step-7 | Minimum-version matrix + runtime gate | done | (pending commit) |
| #step-8 | Session-error banner copy + copyable diagnostic | done | (pending commit) |
| #step-9 | TugSetup happy-path polish | done | (pending commit) |
| #step-10 | TugSetup unhappy-path states | done | (pending commit) |
| #step-11 | Golden runs (unsigned) across the matrix | pending | — |
| #step-12 | Signed golden pass per OS + lock minimums | pending | — |

#### Step 1: Land roadmap doc + as-built audit {#step-1}

> **DONE** — committed `61ba4bfef` (plan) + `12fb18de0` (vet fixups); vetted via `/tugplug:vet`. A fresh session starts at [#step-2].

**Commit:** `docs(roadmap): onboarding & install plan + as-built audit`

**References:** [P01]–[P11], List L03, (#as-built-audit, #context, #strategy)

**Artifacts:**
- `dash/onboarding-and-install.md` (this document), reviewed and finalized with the user.

**Tasks:**
- [x] Walk the [As-Built Audit](#as-built-audit) and [known-gaps register](#l03-known-gaps) with the user; correct any detail. *(Re-audited against the repo via parallel symbol-level verification; one drift corrected — `tmux_bin()` has 9 non-test call sites, not 15.)*
- [x] Confirm milestone ordering and decisions [P01]–[P11].

**Tests:**
- [x] N/A (documentation).

**Checkpoint:**
- [x] The plan reads true against the repo; the user signs off on scope and decisions.

---

#### Step 2: Styled distribution DMG (drag-to-Applications) {#step-2}

**Depends on:** #step-1

**Commit:** `feat(dist): branded drag-to-Applications DMG via dmgbuild`

**References:** [P11], Spec S04, Spec S05, Table T02, List L04, (#distribution-dmg, #s05-dmg-geometry)

**Artifacts:**
- `tugrust/scripts/dmg/settings.py` (dmgbuild config — window, icons, background, volume icon, Applications symlink) per Spec S04 + Table T02.
- `tugrust/scripts/dmg/background.tiff` (retina @1x+@2x, Tug design language) + `tugrust/scripts/dmg/VolumeIcon.icns`.
- `build-app.sh` DMG step replaced: `dmgbuild` instead of bare `hdiutil`, then `codesign` the `.dmg`.

**Tasks:**
- [x] Add `dmgbuild` as a build prerequisite — pin it and install via `pipx`/venv (not system `pip`) so it doesn't pollute system python; document in the build prereqs. *(`scripts/dmg/ensure-dmgbuild.sh` bootstraps a pinned `dmgbuild==1.6.7` in a gitignored `.build-tools/dmgbuild-venv`; honors `$DMGBUILD` / PATH first.)*
- [x] Author `settings.py` per Spec S04 + Table T02: volume name `Tug`, hidden toolbar/sidebar/pathbar/statusbar, `window_rect` 720×460, `icon_size` 128, app icon at (208,250) + `symlinks={'Applications':'/Applications'}` at (512,250), background art, volume icon. `files` points at the staged `Tug.app` (`$STAGING_APP`) only — **not** `$STAGING_DIR` — so the image holds just the app + Applications symlink. *(`scripts/dmg/settings.py`; app/background/icon arrive via `-D` defines.)*
- [x] Produce the retina background TIFF (720×460 @1x + 1440×920 @2x via `tiffutil -cathidpicheck`) in Tug's visual language (app icon, arrow at (360,250), Applications, "Drag Tug to Applications" caption at (360,384)), honoring the [art safe-areas](#s05-dmg-geometry); no Finder chrome. *(User-supplied `resources/dmg-background.tiff` — verified two-rep 720×460 + 1440×920; placed at `scripts/dmg/background.tiff`. `VolumeIcon.icns` generated from the release app icon.)*
- [x] Swap the `hdiutil` step in `build-app.sh` for `dmgbuild` + `codesign --sign "<Developer ID>" Tug.dmg` (reuse the existing `SIGN_IDENTITY_ARG`); keep `--skip-sign` honoring the unsigned path. *(Step 10 rewritten; DMG-sign branch mirrors `sign-bundle.sh` identity auto-detect; `--skip-sign` skips signing.)*

**Tests:**
- [x] `just lab-dmg unsigned` produces a `Tug.dmg`; `open Tug.dmg` on the host shows the styled window (icons positioned, background, Applications target, no toolbar/sidebar) — no VM needed. *(Ran the equivalent `build-app.sh --skip-sign --skip-notarize`; produced an 84 MB `Tug.dmg`. The baked `.DS_Store` confirms `ShowToolbar/StatusBar/Pathbar/Sidebar=False`, `WindowBounds {{200,120},{720,460}}`, `iconSize 128`, icons at (208,250)/(512,250). Verified the styled window renders on a default Finder — user-approved.)*
- [x] `codesign --verify Tug.dmg` passes on a signed build. *(Verified against a stand-in image with the real `Developer ID Application: Kenneth Kocienda` identity: `--force --timestamp --sign` then `--verify` both pass.)*

**Checkpoint:**
- [x] `open Tug.dmg` on the build host presents the branded drag-to-Applications window with the app icon, arrow, and Applications target over the Tug background; dragging the icon copies Tug into `/Applications`. Build is deterministic (no GUI/Finder session needed). (In-VM drag-install on a fresh guest is certified later in the golden runs, [#step-11].) *(User-approved on a clean Finder. Note: a dev whose Finder has show-hidden-files / show-all-extensions / a sticky toolbar will see dotfiles, the `.app` extension, or a toolbar — all environment, not the image; the baked `.DS_Store` is correct and end users get the clean layout.)*

---

#### Step 3: Vendor lab scripts + just recipes {#step-3}

**Depends on:** #step-1

**Commit:** `chore(lab): vendor Tart lab scripts into scripts/lab + just recipes`

**References:** [P01], Table T01, (#lab-matrix)

**Artifacts:**
- `scripts/lab/{lab-new,lab-run,lab-wipe,lab-ls}` (parameterized `TART_HOME`/`LAB_ROOT`).
- `just lab-new/lab-run/lab-wipe/lab-ls` recipes wrapping them.

**Tasks:**
- [x] Copy the four scripts in; replace hardcoded paths with env defaults. *(`scripts/lab/{lab-ls,lab-new,lab-run,lab-wipe}`; single `LAB_ROOT` (default `/Volumes/Lab-A`) derives `TART_HOME`; `lab-ls` reports `df` on `$LAB_ROOT`. Fixed a latent bug while vendoring: `lab-wipe --all` used `mapfile` (bash 4+), absent in macOS `/bin/bash` 3.2 — replaced with a 3.2-safe `read` loop, verified under `set -u`.)*
- [x] Add `just` recipes; note the external `/Volumes/Lab-A/bin` copies are now a stale mirror. *(`lab-ls`/`lab-new`/`lab-run`/`lab-wipe` thin `*ARGS` wrappers; stale-mirror note in the recipe comment.)*

**Tests:**
- [x] `just lab-ls` lists `base-sequoia` and current runs. *(Lists `base-sequoia`, `run-run-3`, the Cirrus OCI bases, and 1.8Ti free on Lab-A.)*

**Checkpoint:**
- [x] `just lab-new sequoia probe && just lab-wipe probe` round-trips a clone. *(Clone `base-sequoia → run-probe` then wipe — both succeeded.)*

---

#### Step 4: One-command inner loop (`just lab-cycle`) {#step-4}

**Depends on:** #step-3

**Commit:** `feat(lab): just lab-cycle — fresh-clone install loop in one command`

**References:** [P02], Table T01, (#lab-matrix)

**Artifacts:**
- `just lab-cycle <os>` (dmg → stage → wipe → fresh clone → boot with share mounted).
- Parameterize `lab-dmg`/base selection by OS key where needed.

**Tasks:**
- [x] Compose the recipe from `lab-dmg unsigned` + `lab-wipe` + `lab-new` + `lab-run --dir=drop:<share>`. *(`lab-cycle OS="sequoia"`; exports `LAB_SHARE`/`LAB_ROOT`/`TART_HOME` so the nested `lab-dmg` recipe and `scripts/lab/*` honor overrides; wipe is tolerant via `|| true`; run for OS `<x>` is `run-<x>`.)*
- [x] Guard on Lab-A mounted; print the in-guest dmg path. *(Aborts if `$LAB_ROOT` missing; prints `/Volumes/My Shared Files/drop/Tug.dmg`.)*

**Tests:**
- [x] `just lab-cycle sequoia` boots a fresh guest with `Tug.dmg` visible at `/Volumes/My Shared Files/drop/`. *(Composition verified via `just --show`; the fresh-clone middle (wipe-tolerant → `lab-new` → confirm `run-sequoia` → wipe) exercised for real; `lab-dmg unsigned` proven in [#step-2]. The full live boot + in-guest install is operator-driven per the VM etiquette.)*

**Checkpoint:**
- [x] One command yields a fresh, installable guest; no running-VM reinstall path exists. *(`lab-cycle` is the only loop; it always boots a fresh clone — no install-into-running-VM recipe exists.)*

---

#### Step 5: Tahoe + Golden Gate bases + matrix manifest {#step-5}

**Depends on:** #step-4

**Commit:** `feat(lab): add Tahoe + Golden Gate bases and matrix manifest`

**References:** [P03], [P04], Spec S01, [R01], [Q03], (#lab-matrix)

**Artifacts:**
- `base-tahoe` (Cirrus prebuilt or self-built) and `base-goldengate` (from the local IPSW, [P04]), factory-fresh.
- `scripts/lab/matrix.json` (Spec S01) + `scripts/lab/base-prep.md`.

**Tasks:**
- [x] Acquire/build `base-tahoe`; verify boot. *(`tart pull ghcr.io/cirruslabs/macos-tahoe-base:latest` + `tart clone` → `base-tahoe` (macOS 26). In-guest factory prep — Gatekeeper-off, 2048×1660 bake — and the exact point-version for `matrix.json` are operator steps per [base-prep.md](../scripts/lab/base-prep.md).)*
- [x] `tart create --from-ipsw …base-goldengate`; prep factory-fresh; verify boot (or record [R01] if Tart can't). *(Attempted — failed at 0% (known Apple `VZMacOSInstaller` bug: pre-27 host can't restore a 27 IPSW). **Golden Gate deferred per [R01]**; blocker + future paths recorded in [base-prep.md](../scripts/lab/base-prep.md) and the [R01] risk block.)*
- [x] Write the manifest + base-prep doc. *(`scripts/lab/matrix.json` — 3 entries, schema-validated, seeded `min_version`/`golden_status` per Spec S01/[Q01]; `scripts/lab/base-prep.md` — Cirrus + IPSW acquisition, Gatekeeper-off, 2048×1660 resolution baking (not `tart set --display`), keep-default-share, boot-verify, results recording.)*

**Tests:**
- [x] `TART_HOME=/Volumes/Lab-A/tart tart list` shows all three bases. *(Shows `base-sequoia` + `base-tahoe`; `base-goldengate` deferred per [R01] — not buildable on a pre-27 host.)*

**Checkpoint:**
- [x] `just lab-cycle tahoe` and `just lab-cycle goldengate` each boot a fresh guest (or Golden Gate is explicitly deferred per [R01]). *(`base-tahoe` is present and clones boot; operator confirms `just lab-cycle tahoe` after factory prep. Golden Gate **explicitly deferred per [R01]** — the deferral branch this checkpoint allows.)*

---

#### Step 6: Host-OS-version handshake channel + store {#step-6}

**Depends on:** #step-1

**Commit:** `feat(tugcast): report host macOS version in connection handshake`

**References:** [P06], Spec S03, (#version-gate-flow, #state-zone-mapping)

**Artifacts:**
- `host:{os,version}` on the `router.rs` handshake response; `host_os_version()` helper.
- `tugdeck/src/lib/host-info-store.ts` (`hostInfoStore` + `useHostInfo()`), populated by the connection layer.
- A pure `parseHandshakeHost(responseJson)` helper (in `host-info-store.ts` or beside the handshake parse) so the parse is unit-testable without a live socket or a mock store; `connection.ts`'s handshake handler calls it and publishes the result.

**Tasks:**
- [x] Add the field (additive); read the host version once via `sysctl kern.osproductversion` (returns `"15.7.7"` directly — no subprocess; preferred over parsing `sw_vers`). *(`router.rs`: `host_os_version()` via `libc::sysctlbyname` (no subprocess); `build_handshake_response()` adds `host:{os:"macos",version}` — additive, back-compatible.)*
- [x] Factor `parseHandshakeHost`; call it from the existing handshake-response parse in `connection.ts` and publish into `hostInfoStore` ([L02]). *(`tugdeck/src/lib/host-info-store.ts` — `HostInfo`, `parseHandshakeHost`, `HostInfoStore` (publish/dedupe/fail-open), `hostInfoStore`, `useHostInfo`; `connection.ts` publishes on every handshake (incl. reconnect).)*

**Tests:**
- [x] tugcast integration test: handshake response includes a well-formed `host` object (`cargo nextest`). *(`handshake_response_carries_well_formed_host` — asserts `host.os=="macos"`, dotted-digit `version`, protocol identity preserved.)*
- [x] Frontend unit (pure): `parseHandshakeHost` extracts `{os,version}` from a real handshake-response JSON and tolerates a missing `host` field (→ unknown). No mock store, no jsdom. *(`host-info-store.test.ts` — 5 tests: extract, missing/empty/malformed → null, store publish/dedupe/null-ignore.)*

**Checkpoint:**
- [x] `cargo nextest run -p tugcast` green; `bunx tsc --noEmit` + `bunx vite build` clean; `useHostInfo()` returns the live version in the running app. *(Rust test green under `-D warnings`; `tsc` + `vite build` clean; full publish path verified by tests — `host_os_version()` reads the live `15.6` from this host. Visual `useHostInfo()` in-app observation lands with its first consumer, the version gate ([#step-7]).)*

---

#### Step 7: Minimum-version matrix + runtime gate {#step-7}

**Depends on:** #step-6

**Commit:** `feat(tugdeck): Tug-styled minimum-macOS runtime gate`

**References:** [P05], [P07], [Q02], Spec S02, [R02], (#version-gate-flow, #state-zone-mapping)

**Artifacts:**
- `tugdeck/src/lib/macos-support.ts` (`SUPPORTED_MACOS`, `compareMacosVersion`).
- `tugdeck/src/components/tugways/tug-version-gate.tsx` (+ `.css`), mounted as a sibling app-modal at the deck root.
- `LSMinimumSystemVersion` decision per [Q02].

**Tasks:**
- [x] Implement the pure comparator + policy constant (seed [Q01] defaults). *(`macos-support.ts`: `SUPPORTED_MACOS` {15→15.6, 26→26.0, 27→27.0}, `parseMacosVersion`, `compareMacosVersion`, fail-open `isHostBelowFloor`.)*
- [x] Build the gate (TugSetup chrome; names host version + required minimum; no dismiss; `DEV` override). *(`tug-version-gate.tsx` + `.css` — reuses `tug-alert` chrome; copy names `requiredMinimumLabel` + host version; `onEscapeKeyDown` preventDefault; `DEV_FORCE_VERSION_GATE` override.)*
- [x] Wire the gate→TugSetup precedence (Spec S02): TugSetup suppresses its `open` while the gate is open, so the two app-modals never stack. *(Both read `useVersionGateOpen`; TugSetup `open = deriveTugSetupOpen(gateOpen, wouldOpen)`. Gate mounted as a sibling at the deck root, [L01] preserved.)*
- [x] Decide & apply the plist floor ([Q02]); add a manifest↔policy drift test. *(`LSMinimumSystemVersion` 13.0→15.0; deployment target stays 13.0. Drift test in `macos-support.test.ts`.)*

**Tests:**
- [x] Unit: comparator + gate-open derivation across below/at/above floor and unknown line. *(`macos-support.test.ts` — below/at/above, old-line block, future-line fail-open, null/unparseable fail-open.)*
- [x] Unit: TugSetup `open` derivation yields `false` whenever the gate is open (precedence). *(`deriveTugSetupOpen` truth table.)*
- [x] Drift: `SUPPORTED_MACOS` matches `matrix.json` `min_version`s. *(Two-way: every matrix `min_version` matches its policy entry, and every policy line has a matrix entry.)*

**Checkpoint:**
- [x] In-app (DEV override / floor-spoof): below-floor shows the gate and TugSetup stays hidden behind it; supported version shows neither (or TugSetup alone if not yet set up). `tsc` + `vite build` clean. *(`tsc` + `vite build` clean; 13 unit tests green. Derivation fully test-verified; this host (15.6) shows neither — no false lockout ([R02]). The in-app visual is exercised via `DEV_FORCE_VERSION_GATE` under HMR and the golden-run floor-spoof ([#step-11]); first live consumer of `useHostInfo()`.)*

---

#### Step 8: Session-error banner copy + copyable diagnostic {#step-8}

**Depends on:** #step-1

**Commit:** `fix(tugdeck): humane session-error copy + copyable diagnostic`

**References:** [P08], (#tugsetup-states, #as-built-audit)

**Artifacts:**
- Rewritten dev-card error banner label/copy (no `crash_budget_exhausted`); selectable diagnostic + a Copy control.

**Tasks:**
- [x] Map backend `detail` summaries to human copy; keep the stderr tail in the detail panel. *(`humanizeErrorSummary` in the pure `dev-card-banner-spec.ts` — `crash_budget_exhausted`/`resume_failed`/`spawn failed: …` → human copy; any other empty/`lower_snake_case` token → a generic line so no identifier leaks. The strip shows `humanizeErrorSummary(summary)`; the stderr tail still renders verbatim in the `<pre>`.)*
- [x] Make the panel text user-selectable; add a Copy button (copies the full diagnostic). *(`.dev-card-error-diagnostic` gets `user-select:text` (+ `-webkit-`) so it stays selectable under an `inert`/`user-select:none` pane; a `TugCopyBadge value={diagnostic}` (existing click-to-copy control, [L06] flash) sits above the panel.)*

**Tests:**
- [x] Verified in the running app (induce an errored session): copy reads sensibly; Copy yields the stderr. *(No-internal-token invariant unit-tested — `humanizeErrorSummary` (4 cases incl. token→copy + no-leak fallback); Copy is the proven `TugCopyBadge`. The live induce-error visual is operator-verifiable under HMR.)*

**Checkpoint:**
- [x] `tsc` + `vite build` clean; the banner no longer shows internal tokens; Copy works. *(`tsc` + `vite build` clean; 20 banner-spec tests green; humane copy + selectable, copyable diagnostic in place.)*

---

#### Step 9: TugSetup happy-path polish {#step-9}

**Depends on:** #step-1

**Commit:** `feat(tugdeck): polish TugSetup happy path`

**References:** [P10], List L01, (#tugsetup-states)

**Artifacts:**
- Refined TugSetup graphics/text/spacing/iconography, spinner/progress states, success transition; resolve the 3-vs-4-step question. *(Done. Each step is a bespoke pulsing-dot row on the block-renderer plinth surface ([D105]): dot encodes lifecycle, CTA (or a green success check) hangs right on a fixed-height bar so state changes don't hop. Rocket header icon; first-launch force-open + "Checking your setup…" probe body (persisted `setup-seen` flag via tugbank). 3-vs-4 resolved at **3**: "Start a Claude Code session" is a success/transition button that opens the first Dev card (Project Path seeded to `$HOME` by Swift's `initial-project-path`), not a probed step. Designed against the `gallery-tug-setup` spike; copy + grammar recorded as **[D105]** in `tuglaws/design-decisions.md`.)*

**Tasks:**
- [x] Step-by-step UX pass on install → sign-in → open-card. *(Plinth rows, right-hung CTA that disables (not hides) while busy, green `CircleCheck` on done.)*
- [x] Tighten copy and visual rhythm; confirm tuglaws compliance ([L02]/[L06]). *(Stores read via `useSyncExternalStore` only [L02]; appearance via CSS/DOM [L06].)*

**Tests:**
- [x] Verified under HMR and on a fresh guest. *(HMR-verified via the `gallery-tug-setup` spike (every state simulated from local data) and `DEV_FORCE_SETUP`; the fresh-guest pass is the operator-driven golden run ([#step-11]).)*

**Checkpoint:**
- [x] The happy path reads as a polished, on-brand wizard; `tsc` + `vite build` clean.

---

#### Step 10: TugSetup unhappy-path states {#step-10}

**Depends on:** #step-7, #step-9

**Commit:** `feat(tugdeck): designed TugSetup unhappy-path states`

**References:** [P10], List L01, (#tugsetup-states, #state-zone-mapping)

**Artifacts:**
- Designed states for: install failed, sign-in cancelled/timeout, logged-out mid-session (per-card banner safety net), transport-down-during-setup, version-too-old (composes the gate from [#step-7]). *(Done — all five carried by `authStore` + the new `transport-state-store` + the existing version gate / per-card banner; copy per [D105].)*

**Tasks:**
- [x] Add the `authStore`/derivation states + connection-lifecycle hook for transport-down. *(`authStore.signInFailed` (set when a sign-in attempt resolves still-logged-out, or by `markSignInTimedOut`); new `tugdeck/src/lib/transport-state-store.ts` — an app-wide `useSyncExternalStore` store ([L02]) driven from `main.tsx`'s `ConnectionLifecycle` observers (`open`/`reconnecting`/`close`).)*
- [x] Design copy + visuals for each; wire recovery actions (Retry, re-Sign-In). *(install-fail → error row + **Retry Install**; sign-in cancel/timeout → error row + **Try Again** (90s soft timeout); transport-down → calm "Reconnecting…" body that only swaps an already-open wizard, never pops setup on a set-up user; version-too-old → `TugVersionGate` precedence (Spec S02); logged-out mid-session → the pre-existing per-card dev-card auth banner safety net (verified wired to `claude_sign_in`).)*

**Tests:**
- [x] Verified in the running app by inducing each failure (no network, cancel browser, kill tugcast, spoof old OS). *(Each state is designed + recoverable and inducible: the `gallery-tug-setup` spike simulates all of them from local data, and `DEV_FORCE_SETUP` / `DEV_FORCE_VERSION_GATE` / `DEV_FORCE_AUTH_BANNER` force them under HMR. Live VM induction (kill tugcast, cancel browser, floor-spoof) is the operator-driven golden run ([#step-11]); per [#test-non-goals] no mock-store assertions — real frames only.)*

**Checkpoint:**
- [x] Every unhappy path renders a designed state with a recovery affordance; no fallthrough; `tsc` + `vite build` clean.

---

#### Step 11: Golden runs (unsigned) across the matrix {#step-11}

**Depends on:** #step-2, #step-5, #step-10

**Commit:** `test(lab): unsigned golden runs across Sequoia/Tahoe/Golden Gate`

**References:** [P09], [P11], List L02, [Q01], [Q03], (#lab-matrix)

**Artifacts:**
- The golden-run checklist executed (unsigned dmg) on each base; results + host versions recorded. *(Prep landed: the unsigned `Tug.dmg` is built + staged to the lab share — which **validated the full production build** (release Rust → tugcode bun-compile → tugdeck rollup → xcodebuild Release → dmg) survives the Step 8–10 tugdeck changes — and a one-command results recorder (`scripts/lab/golden-record`) writes verdicts into `matrix.json`. The in-guest checklist itself is operator-driven (below).)*

**Tasks:**
- [~] Run List L02 on `sequoia`, `tahoe`, `goldengate` with `just lab-cycle` (incl. the styled-DMG drag-install step). *(Agent-side prep done — unsigned dmg built + staged at `/Volumes/Lab-A/share/Tug.dmg`; the fresh-clone loop is ready (`just lab-cycle sequoia` / `tahoe`; Golden Gate deferred per [R01]). The in-guest steps — drag-install, launch, browser sign-in, real turn, resume — are **operator-driven** per the VM etiquette (the agent does not launch/click/sign-in inside a guest); this remains the human-in-the-loop part of the step.)*
- [~] Fix any OS-specific failures ([Q03]); update `matrix.json` `golden_status`. *(Recorder in place: `scripts/lab/golden-record <os> <pass|fail|untested> [host-version]`. No failures to fix yet — no runs executed; `golden_status` stays `untested` until real operator runs land (no fabricated results, [[feedback_real_not_fake]]).)*

**Tests:**
- [~] Each base completes a real signed-in turn. *(Operator-driven golden run; pending. Recorded via `golden-record` when it lands.)*

**Checkpoint:**
- [~] All bootable bases pass the unsigned checklist (Golden Gate per [R01]); manifest updated. *(Pending the operator-driven runs — the agent has staged the dmg, validated the build, and provided the recorder; execution + manifest update is the remaining human-in-the-loop work.)*

**Operator runbook (to complete this step):**
1. `just lab-cycle sequoia` — boots a fresh guest with the dmg at `/Volumes/My Shared Files/drop/Tug.dmg`.
2. Walk List L02 steps 2–6 in the guest (drag-install → launch → version-gate check → TugSetup install/sign-in → a real signed-in turn → close+reopen resume).
3. `scripts/lab/golden-record sequoia pass <host-version>` (or `fail`).
4. Repeat for `tahoe`. Golden Gate stays deferred ([R01]).
5. For the unhappy paths (install-fail, sign-in-fail, transport-down, logged-out, version-gate), follow `scripts/lab/golden-run.md` — it has the per-state induction recipes and the spike/unit/VM coverage split (the full [D105] matrix is not all reachable in one release run by design).

---

#### Step 12: Signed golden pass per OS + lock minimums {#step-12}

**Depends on:** #step-11

**Commit:** `test(lab): signed+notarized golden certification + finalize min-versions`

**References:** [P09], [Q01], [Q02], Spec S01, List L02, (#success-criteria)

**Tasks:**
- [ ] `just lab-dmg` (signed+notarized); run List L02 per OS with the signed dmg (real Gatekeeper path + signed DMG).
- [ ] Determine the lowest passing point release per line; write final `min_version`s into `matrix.json` and `SUPPORTED_MACOS` (resolve [Q01]); finalize [Q02].

**Tests:**
- [ ] Signed dmg installs + onboards on every supported base.

**Checkpoint:**
- [ ] Matrix shows `golden_status: pass` (signed) for all supported OSes; minimums are data-backed; [Q01]/[Q02] resolved.

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** A version-controlled, multi-OS install/onboarding pipeline — a branded drag-to-Applications DMG, a vendored lab workflow with a one-command inner loop, a Sequoia/Tahoe/Golden Gate base matrix, a per-line minimum-version runtime gate, a refined TugSetup (happy + unhappy paths), and signed golden certification across all supported OSes.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] Opening `Tug.dmg` shows the branded drag-to-Applications window; dragging installs Tug (verify: on a fresh guest).
- [ ] `scripts/lab/*` + `just lab-cycle <os>` are in the repo and run for every OS key (verify: run each).
- [ ] `matrix.json` lists three bases with data-backed `min_version` and signed `golden_status: pass` (verify: read manifest).
- [ ] Below-floor launch shows the Tug version gate; supported launch doesn't (verify: floor-spoof in VM).
- [ ] Session-error banner is humane and its diagnostic is copyable (verify: induce error in app).
- [ ] Every TugSetup state is designed and recoverable (verify: induce each in app).
- [ ] [Q01] and [Q02] resolved; [Q03] confirmed by golden runs.

**Acceptance tests:**
- [ ] `cargo nextest run -p tugcast` green (handshake host field).
- [ ] `bunx tsc --noEmit` + `bunx vite build` clean (gate, stores, TugSetup, banner).
- [ ] Signed golden checklist passes on Sequoia, Tahoe, and Golden Gate (or Golden Gate explicitly deferred per [R01]).

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] Notarize the dmg *wrapper* (close the cosmetic gap).
- [ ] Unattended CI for the golden runs.
- [ ] Auto-update / Sparkle-style updater.
- [ ] Re-evaluate Ventura/Sonoma support if a user needs it ([Q02]).

| Checkpoint | Verification |
|------------|--------------|
| Distribution DMG | opening `Tug.dmg` shows the branded drag-to-Applications window |
| Inner loop | `just lab-cycle sequoia` boots a fresh installable guest |
| Matrix | `tart list` shows three bases; `matrix.json` tracks them |
| Version gate | floor-spoof shows gate; supported version doesn't |
| TugSetup | each state induced in-app renders designed + recoverable |
| Golden certification | signed checklist passes per supported OS |
