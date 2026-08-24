## App Self-Update via Sparkle {#self-update}

**Purpose:** The release Tug.app a user installs from the downloaded DMG checks GitHub for new versions, tells the user via a deck bulletin, and can download, install, and relaunch itself — using Sparkle 2, the standard macOS update framework, with zero invented infrastructure.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-07-26 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

Tug.app ships as a signed, notarized DMG built by `tugrust/scripts/build-app.sh` and (for nightlies) published by `.github/workflows/nightly.yml` to a rolling GitHub release. There is no update mechanism: a user who installed from the DMG stays on that version forever unless they manually re-download. The pipeline is already updater-shaped — `build-app.sh` stamps a per-build `CFBundleVersion` with a comment saying it exists "so a future updater can distinguish builds", `notarize.sh` already produces a notarized distribution zip, and `sign-bundle.sh` reserves an explicit slot "(4) Reserved slot for nested frameworks" naming Sparkle.

Sparkle 2 (`https://github.com/sparkle-project/Sparkle`) is the tried-and-true answer: a Swift-package dependency that handles version comparison, EdDSA signature verification, download, atomic install, and relaunch, driven by a static `appcast.xml` feed on any HTTPS host — GitHub Releases qualifies. Because Tug.app is **not sandboxed** (no `com.apple.security.app-sandbox` in `tugapp/Tug.entitlements`), the plain non-XPC Sparkle integration applies, which is the simplest tier.

#### Strategy {#strategy}

- Adopt Sparkle 2 via SPM as the Xcode project's first package dependency; wrap it in one small `UpdateController` owned by `AppDelegate`.
- Reuse existing artifacts: the notarized zip `notarize.sh` already creates becomes the update archive; the DMG remains the first-install vehicle.
- Host the feed and archives as GitHub release assets: a rolling `updates` release holds `appcast.xml` plus the versioned zips, so `SUFeedURL` is a fixed URL and CI needs no extra hosting.
- The appcast carries **only the newest release** — regenerated wholesale each release from the single new zip. No merge logic, no history, no deltas (follow-on).
- Ship the standard Sparkle UI for user-initiated checks ("Check for Updates…" menu item), and route *scheduled* update discovery through the deck's `TugBulletin` surface via the existing `window.__tugBridge` channel, using Sparkle's gentle-reminders API.
- Stand up a stable-release GitHub workflow (near-copy of `nightly.yml`) since none exists today — only nightly publishes.

#### Success Criteria (Measurable) {#success-criteria}

- A release-profile Tug.app pointed (via env override) at a locally served appcast advertising a higher version detects the update, and Update & Relaunch replaces the running app in place and relaunches the new version (verify: `CFBundleShortVersionString` of the running bundle after relaunch).
- The scheduled-check path surfaces a deck bulletin ("Tug X.Y.Z is available") instead of Sparkle's alert window; clicking the bulletin action opens Sparkle's update flow (verify: manual run per #integration-verification).
- `generate_appcast` output validates against the published zip: `sparkle:edSignature` present, `sparkle:version` matches the zip's `CFBundleVersion` (verify: CI step output + manual inspection).
- The signed bundle with Sparkle.framework embedded passes `codesign --verify --deep --strict` and notarization (verify: existing `notarize.sh` gate in the build).
- Debug/branch builds and app-test runs never start the updater (verify: gating guard + app-test `menuSnapshot` shows no crash, bulletin app-test passes).

#### Scope {#scope}

1. Sparkle 2 SPM integration, `UpdateController`, "Check for Updates…" menu item, Info.plist feed/key configuration.
2. EdDSA keypair generation and secret placement (public in plist, private in GitHub Actions secret).
3. Signing pipeline support: `sign-bundle.sh` slot (4) implementation; `build-app.sh` preserves the distribution zip into `products/`.
4. Appcast generation script + stable-release GitHub workflow publishing DMG, zip, and appcast.
5. Deck bulletin for scheduled update discovery via `__tugBridge`, with a `checkForUpdates` message handler back into Sparkle.

#### Non-goals (Explicitly out of scope) {#non-goals}

- Nightly-channel self-update (`dev.tugtool.nightly` staying current via Sparkle channels) — follow-on, see [Q01].
- Delta updates (`generate_appcast` delta support) — follow-on.
- Notarizing the DMG wrapper itself (already noted as a follow-on in `build-app.sh`).
- Rollback / downgrade support — the single-item appcast intentionally offers only "latest".
- Any Settings-card UI for update preferences — Sparkle defaults plus the menu item suffice for this phase.

#### Dependencies / Prerequisites {#dependencies}

- Existing Apple signing/notary setup: Developer ID cert, `tug-notary` keychain profile, and the CI secrets already used by `nightly.yml` (`APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_ID`, `APPLE_TEAM_ID`, `NOTARY_PASSWORD`, `DEVELOPER_ID_NAME`).
- **User action:** install the Sparkle EdDSA private key as a new GitHub Actions secret (`SPARKLE_ED_PRIVATE_KEY`) — Step 2 produces it; only the repo owner can set secrets.
- **User action:** the first stable release run (`workflow_dispatch`) that seeds the `updates` release.
- Network access during `xcodebuild` for SPM resolution (CI runners have it; `Package.resolved` pins the version).

#### Constraints {#constraints}

- Warnings are errors across the workspace; Swift code must build clean under the project's settings.
- `--deep` signing is FORBIDDEN (`sign-bundle.sh` doctrine, [D16]); Sparkle's nested binaries must be signed individually inside-out.
- Only the user commits to git; each step ends at a commit boundary the user lands.
- The updater must never run for debug/branch-identity builds (`assign-bundle-id.sh` rewrites bundle IDs per (profile, branch)) or under the app-test harness.
- No localStorage/IndexedDB on the deck side; the bulletin path introduces no persistent web state at all.

#### Assumptions {#assumptions}

- Sparkle 2.x latest stable (2.9+ at authoring time) — pin `from: "2.9.0"` semver range in the package reference.
- GitHub release-asset URLs (`https://github.com/tugtool/tugtool/releases/download/<tag>/<asset>`) serve over HTTPS with redirects Sparkle follows; this is standard practice for Sparkle feeds.
- `origin` remote is `github.com/tugtool/tugtool`; the repo is public enough for unauthenticated asset downloads by end-user apps. If the repo is private, release assets are NOT anonymously downloadable and the feed host must move (see Risk R04).

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

This plan follows the devise-skeleton v4 conventions: explicit `{#anchor}` on every cited heading, `[P##]` plan-local decisions, `[Q##]` open questions, `R##` risks, `S##` specs, `**Depends on:**` lines citing `#step-N` anchors, and rich `**References:**` lines. No line-number citations.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Nightly self-update channel (DEFERRED) {#q01-nightly-channel}

**Question:** Should `dev.tugtool.nightly` builds also self-update, via Sparkle's `<sparkle:channel>` element or a second feed?

**Why it matters:** Nightly users currently re-download the rolling `TugNightly.dmg` manually. Sparkle 2 channels would fold nightly into the same machinery.

**Resolution:** DEFERRED. The stable channel is the essential feature; nightly identity (`CFBundleVersion` = workflow run number, `CFBundleShortVersionString` = `<version>-nightly.<build>`) needs its own version-comparison thinking. Revisit after the stable channel ships; the gating guard in [P06] already keys on bundle ID so nightly is cleanly excluded until then.

#### [Q02] A release build installed the update without consent (MUST RESOLVE) {#q02-unconsented-install}

**Question:** Why does a *release-configuration* bundle download and install a scheduled update with no consent step, when the same code in a *debug* bundle correctly defers to the delegate and downloads nothing?

**What was observed** during #integration-verification, against a local feed offering 0.8.1 to an installed 0.8.0:

- **Debug bundle — correct.** `standardUserDriverShouldHandleShowingScheduledUpdate` returned `false`, `standardUserDriverWillHandleShowingUpdate` fired with `handles: no, userInitiated: no`, the deck was handed the notice, and Sparkle then **did not fetch the archive** — it waited for the delegate to bring the update into focus, exactly as [P07] intends.
- **Release bundle — wrong.** Same code, same feed: Sparkle fetched the appcast, fetched `Tug-0.8.1.zip` within seconds, and replaced the bundle in place **while the app was still running**, with no bulletin click and no Sparkle window. Repeated on a freshly extracted bundle with Sparkle's user defaults cleared, and again with `SUAutomaticallyUpdate` explicitly written `false` into the app's defaults domain — the silent install happened all three times.

**Why it matters:** an app that replaces itself under the user is the one behavior this feature must never have. It contradicts [P07] (the bulletin is the consent surface) and [P09] (no silent installs).

**Not yet ruled out:** a `Release` build-setting difference (optimization / `SWIFT_COMPILATION_MODE = wholemodule`) changing how the `SPUStandardUserDriverDelegate` conformance is witnessed; the delegate being deallocated or not seen at all in the release binary (the release runs carried no delegate `NSLog` output to confirm the callbacks even fired — the logging landed after those runs); or a genuine Sparkle policy difference keyed on something in the release configuration.

**Next diagnostic:** re-run the release build now that `UpdateController` logs both delegate callbacks. If the log lines are absent in release, the conformance is not being seen and the fix is in how the delegate is declared/retained; if they are present and the download still happens, the question is Sparkle's, and `SPUUpdaterDelegate.updater(_:shouldPostponeRelaunchForUpdate:)` / an explicit `automaticallyDownloadsUpdates = false` on the updater becomes the lever.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Sparkle-driven relaunch races Tug's async termination | med | low | R01 | update leaves stale tugcast/tmux behind |
| Hand-edited pbxproj SPM references malformed | med | med | R02 | xcodebuild fails resolving the package |
| Framework signing breaks notarization | high | low | R03 | notarytool rejection naming Sparkle paths |
| Private repo blocks anonymous asset download | high | low | R04 | 404 from the feed URL in a release build |

**Risk R01: Relaunch vs. async terminate** {#r01-relaunch-terminate}

- **Risk:** `AppDelegate.applicationShouldTerminate` returns `.terminateLater` and finishes teardown (saveState → `cleanupBridge` → `processManager.shutdown()`) in an async completion before replying. Sparkle's installer waits for app exit before swapping bundles and relaunching, but a hang in the JS save callback would stall the update mid-flight.
- **Mitigation:** No code change expected — Sparkle terminates via the normal `NSApp.terminate` path, which is the same path Cmd-Q exercises daily. The integration checkpoint (#step-6) explicitly verifies child-process teardown (no orphaned tugcast/tmux for the instance) after an update relaunch.
- **Residual risk:** A wedged WebView at update time stalls the install until the user force-quits; acceptable, identical to today's quit behavior.

**Risk R02: pbxproj SPM hand-edit** {#r02-pbxproj-spm}

- **Risk:** `tugapp/Tug.xcodeproj/project.pbxproj` is hand-authored (synthetic `AA…` object IDs, `objectVersion = 56`, no existing package references); adding `XCRemoteSwiftPackageReference`/`XCSwiftPackageProductDependency` blocks by hand can produce a project Xcode parses but resolves wrongly.
- **Mitigation:** Follow the exact object graph in Spec S02; verify with both `xcodebuild -resolvePackageDependencies` and a full `just app-debug` build; commit the generated `Package.resolved` (under `Tug.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/`) so CI resolution is pinned.
- **Residual risk:** Future Xcode versions may rewrite the file on open; harmless churn.

**Risk R03: Sparkle framework signing/notarization** {#r03-framework-signing}

- **Risk:** Sparkle.framework contains nested executables (`Autoupdate`, `Updater.app`, and two XPC services used only by sandboxed hosts). Signing them wrong — or letting Xcode's throwaway ad-hoc signature ride through — fails notarization or breaks the outer seal.
- **Mitigation:** Sign inside-out in `sign-bundle.sh` slot (4) per Spec S03, exactly as the script's own comment instructs; hardened runtime + timestamp like every other nested binary; verify with `codesign --verify --deep --strict` (allowed for verification) and a real `just notarize` run before the release workflow lands.
- **Residual risk:** Sparkle releases occasionally reorganize the framework layout; the signing loop in S03 globs rather than hardcodes where practical.

**Risk R04: Feed reachability** {#r04-feed-reachability}

- **Risk:** If `github.com/tugtool/tugtool` is private, release-asset URLs require auth and every installed app's update check 404s.
- **Mitigation:** Confirm repo visibility before the first stable release; if private, host `appcast.xml` + zips on `tugtool.dev` (the Help ▸ Project Home domain) instead — only `SUFeedURL` and the workflow upload step change, nothing in the app.
- **Residual risk:** None once visibility is confirmed; the URL is baked per-build so a later host move just rides the next update.

---

### Design Decisions {#design-decisions}

#### [P01] Sparkle 2 via SPM is the updater (DECIDED) {#p01-sparkle-spm}

**Decision:** Adopt `https://github.com/sparkle-project/Sparkle` (2.x, `from: "2.9.0"`) as an SPM dependency of the Tug Xcode target; no hand-rolled update code.

**Rationale:**
- Sparkle is the two-decade standard for non-App-Store macOS updates; it delivers version comparison, EdDSA + Apple code-signing verification, atomic install, and relaunch as configuration, not code.
- The user's directive: invent nothing; use tried-and-true libraries. Rust (`self_update`) and TS alternatives reimplement a native-host job poorly; Squirrel.Mac is unmaintained.
- Tug.app is not sandboxed, so the simplest (non-XPC) Sparkle integration applies.

**Implications:**
- First SPM package in the project → pbxproj gains package-reference objects (Spec S02) and `Package.resolved` gets committed.
- `sign-bundle.sh` slot (4) must be implemented (Spec S03).

#### [P02] The notarized zip is the update archive; the DMG stays the installer (DECIDED) {#p02-zip-archive}

**Decision:** Sparkle serves the stapled-bundle zip that `notarize.sh` already produces (`ditto -c -k --keepParent` of the post-staple .app); the DMG remains the human first-install download only.

**Rationale:**
- The artifact already exists at `build/staging/<AppName>.zip` after notarization; zips are Sparkle's canonical archive format.
- No dual-purpose DMG mounting logic, no changes to the DMG pipeline.

**Implications:**
- `build-app.sh` must copy the zip into `products/` before its `rm -rf "$BUILD_DIR"` cleanup destroys it (today the zip dies with the build dir) — Step 3.
- The published zip is named `Tug-<CFBundleShortVersionString>.zip` so multiple versions coexist on one release tag.

#### [P03] Feed and archives live on a rolling `updates` GitHub release (DECIDED) {#p03-updates-release}

**Decision:** `SUFeedURL` = `https://github.com/tugtool/tugtool/releases/download/updates/appcast.xml`. The rolling `updates` release (mirroring the existing rolling `nightly` release pattern) holds `appcast.xml` and every `Tug-<version>.zip`. Each stable release ALSO publishes a human-facing `v<version>` release carrying `Tug.dmg`.

**Rationale:**
- One fixed URL for the feed; one `--download-url-prefix` for `generate_appcast` since all zips share the tag.
- `softprops/action-gh-release` already handles rolling-tag upsert in `nightly.yml`; same action, same pattern.

**Implications:**
- The release workflow uploads to two tags (Spec S04).
- Old zips accumulate on `updates`; harmless, prunable manually.

#### [P04] EdDSA keys: public in Info.plist, private in a GitHub secret (DECIDED) {#p04-eddsa-keys}

**Decision:** Generate the Sparkle EdDSA keypair once with Sparkle's `generate_keys`; commit the public key as `SUPublicEDKey` in `tugapp/Info.plist`; export the private key (`generate_keys -x`) and store it as GitHub Actions secret `SPARKLE_ED_PRIVATE_KEY`, fed to `generate_appcast --ed-key-file -` on stdin in CI.

**Rationale:**
- Updates are then verified by both EdDSA and Apple code signing (Sparkle's recommended posture).
- Mirrors the repo's existing secret discipline (`nightly.yml` keeps Apple credentials in step-scoped env).

**Implications:**
- Losing the private key means shipping one bridging release with a new key; keep the exported key backed up in the user's password manager (user action).
- Local `just` builds never need the private key — only CI signs appcasts.

#### [P05] The appcast carries only the newest release (DECIDED) {#p05-single-item-appcast}

**Decision:** Each release regenerates `appcast.xml` wholesale from the single new zip; no merging with prior items, no history.

**Rationale:**
- Sparkle only needs the newest item to offer an update; a one-item feed is fully functional.
- Eliminates the entire "maintain appcast state across CI runs" problem (downloading prior zips or merging XML) — the strongest simplification available.

**Implications:**
- No delta updates (they require consecutive-version items) — explicitly a follow-on.
- No downgrade path; acceptable per #non-goals.

#### [P06] Updater runs only for the stable release identity (DECIDED) {#p06-updater-gating}

**Decision:** `UpdateController` starts Sparkle only when `Bundle.main.bundleIdentifier == "dev.tugtool.app"`, OR when the `TUG_SPARKLE_FEED` environment variable is set (the testing override, which also supplies the feed URL via `SPUUpdaterDelegate.feedURLString(for:)`).

**Rationale:**
- Debug/branch builds get per-(profile, branch) bundle IDs from `assign-bundle-id.sh` and run from DerivedData — self-replacing them is nonsense. Nightly (`dev.tugtool.nightly`) is deferred per [Q01].
- Keying on bundle ID (not `BuildInfo.profile`) excludes nightly, which is also release-profile.
- The env override is what makes the end-to-end update locally testable against a `python3 -m http.server` feed (#integration-verification).

**Implications:**
- The "Check for Updates…" menu item hides (like the Maker menu's hidden-not-disabled pattern) when the updater is not started.
- The `checkForUpdates` WKScriptMessageHandler must no-op gracefully when the updater is off (app-tests hit this path).

#### [P07] Standard Sparkle UI for user checks; deck bulletin for scheduled finds (DECIDED) {#p07-gentle-bulletin}

**Decision:** Use `SPUStandardUpdaterController` with `AppDelegate`-owned delegates. User-initiated checks show Sparkle's stock windows. For *scheduled* checks, adopt Sparkle's gentle-reminders API: `SPUStandardUserDriverDelegate.supportsGentleScheduledUpdateReminders = true`, and when a scheduled update arrives, suppress Sparkle's alert and instead push `__tugBridge.onUpdateAvailable(...)` into the deck, which fires a `TugBulletin` whose action posts back to the `checkForUpdates` handler → `updaterController.checkForUpdates(nil)` → Sparkle's standard flow in immediate focus.

**Rationale:**
- The user asked for a bulletin; `TugBulletinProvider` + imperative `bulletin()` (Sonner-backed) is the existing, mandated surface — never hand-roll UI that exists as a Tug* component.
- Gentle reminders are Sparkle's *documented* mechanism for exactly this handoff (sparkle-project.org "Gentle Reminders"); we write no custom `SPUUserDriver`.
- The stock UI for the actual download/install keeps release-notes display, progress, and error handling for free.

**Implications:**
- One new message handler in `MainWindow` (registered + removed + cased, the three-site pattern), one Swift→JS push, one small deck lib module (Spec S05).
- If the frontend isn't loaded when the scheduled find fires, the notice queues in `AppDelegate` and flushes on `bridgeFrontendReady` — same pattern as `pendingOpenPaths`.

#### [P08] Stable releases keep the computed CFBundleVersion (DECIDED) {#p08-stable-bundle-version}

**Decision:** The stable release workflow does NOT set `TUG_BUILD_NUMBER`; stable bundles ship the `version.sh`-computed `CFBundleVersion` (`major*10000 + minor*100 + patch`, e.g. `0.8.0` → `800`).

**Rationale:**
- `sparkle:version` (what Sparkle compares) is read from the zip's `CFBundleVersion` by `generate_appcast`; the computed scheme is strictly monotonic across semver bumps and reproducible from the tag alone.
- Mixing workflow run numbers (nightly's scheme) into the stable channel would make version order depend on CI history.

**Implications:**
- Every stable release requires a `tugrust/scripts/version.sh bump`/`set` beforehand (already the release discipline); the workflow fails fast if the tag version already exists on `updates`.

#### [P09] Automatic checks on, no permission prompt (DECIDED) {#p09-auto-checks}

**Decision:** Set `SUEnableAutomaticChecks` = `YES` in Info.plist (daily check, Sparkle's default interval); leave `SUAutomaticallyUpdate` unset (no silent installs — the bulletin/consent flow is the UX).

**Rationale:**
- Setting the key in the plist suppresses Sparkle's first-run "check automatically?" permission dialog — one less alien dialog in an app whose UX surface is the deck.
- Silent background *installs* are a policy decision worth deferring until the bulletin flow has mileage.

**Implications:**
- Scheduled checks begin shortly after launch; the gentle-reminder path ([P07]) is what the user sees.

---

### Deep Dives {#deep-dives}

#### Existing pipeline facts an implementer needs {#pipeline-facts}

- **Build:** `tugrust/scripts/build-app.sh` is the canonical distribution build (`just dmg` = unsigned, `just notarize` = signed+notarized). Version read from `tugrust/Cargo.toml` `[workspace.package]`. Steps: release inputs → xcodebuild (ad-hoc, re-signed later) → stage → inject binaries → tmux → plist stamping → `sign-bundle.sh` → `notarize.sh` → dmgbuild → DMG codesign → **`rm -rf build/` cleanup (currently destroys the distribution zip)**.
- **Zip:** `notarize.sh` postcondition: a stapled-bundle distribution zip at `<APP_PATH minus .app>.zip`, i.e. `build/staging/Tug.zip`, re-created AFTER stapling (the pre-staple submission zip is unsuitable).
- **Signing:** `tugrust/scripts/sign-bundle.sh` signs inside-out with per-binary entitlements; `--deep` signing banned; slot (4) is reserved verbatim for nested frameworks "before the outer .app is sealed", warning that skipping it fails notarization.
- **Versioning:** `tugrust/scripts/version.sh` propagates `Cargo.toml` → `tugcode/package.json`, `tugdeck/package.json`, `tugapp/Info.plist` (`CFBundleShortVersionString` + computed `CFBundleVersion`). Currently `0.8.0` / `800`.
- **CI:** `.github/workflows/nightly.yml` is the only packaging workflow — macos-15, ephemeral keychain holding cert + `tug-notary` profile, `build-app.sh --nightly`, publish `products/TugNightly.dmg` to rolling `nightly` release via `softprops/action-gh-release@v2`. The stable workflow (Step 4) mirrors this structure.
- **Xcode project:** `tugapp/Tug.xcodeproj/project.pbxproj`, `objectVersion = 56`, hand-authored explicit file references with synthetic IDs (`AA0000…` pattern), no SPM packages, no `PBXFileSystemSynchronizedRootGroup`. New Swift files need PBXFileReference + PBXBuildFile + group + Sources-phase entries.
- **Bundle identity:** `BuildInfo.swift` reads `BuildProfile`/`BuildBranch`/`BuildCommit` stamped by `capture-build-info.sh`; bundle ID rewritten per (profile, branch) by `assign-bundle-id.sh` for dev builds; nightly = `dev.tugtool.nightly`; stable = `dev.tugtool.app`.

#### Swift ⇄ deck bridge facts {#bridge-facts}

- **JS → Swift:** `WKUserContentController` handlers registered in `MainWindow` init (14 names: `sourceTree` … `exportSession`), symmetrically removed in `cleanupBridge()`, dispatched in `userContentController(_:didReceive:)` by `switch message.name`. Adding a handler = three edits (add / remove / case).
- **Swift → JS:** `window.evaluateJavaScript` against `window.__tugBridge` callbacks (`onExportDone`, `onSettingsLoaded`, …). Deck modules install callbacks non-destructively via `const bridge = (w.__tugBridge ??= {})` — see `tugdeck/src/lib/maker-mode-bridge.ts` for the canonical pattern (typed `WebkitHandles`, `handler(name)` accessor, `ensureBridge()`).
- **Boot ordering:** pushes before the frontend is live are lost; `AppDelegate` queues (`pendingOpenPaths` pattern) and flushes on `bridgeFrontendReady`, which fires on mount AND every reconnect (`frontendHasLoadedOnce` distinguishes).
- **Bulletins:** `tugdeck/src/components/tugways/tug-bulletin.tsx` exports imperative `bulletin(msg, options)` + `.success/.danger/.caution`; `BulletinOptions` supports `description`, `duration`, `sticky`, and `action: { label, onClick }`. `TugBulletinProvider` mounts once in `deck-manager.ts`'s provider composition. Precedent for an imperative non-React bridge firing bulletins: `tugdeck/src/components/chrome/rate-limit-bulletin-bridge.tsx`.

#### End-to-end update flow {#update-flow}

1. Launch → `UpdateController.startIfEligible()` ([P06] gate) → `SPUStandardUpdaterController` starts; `SUEnableAutomaticChecks` schedules a check.
2. Scheduled check fetches `SUFeedURL` appcast → finds `sparkle:version` > local `CFBundleVersion`.
3. Gentle-reminder delegate suppresses Sparkle's alert; `AppDelegate` pushes `__tugBridge.onUpdateAvailable({version, build})` (queued until `bridgeFrontendReady` if needed).
4. Deck fires `bulletin("Tug <version> is available", { description, sticky-ish duration, action: "Update…" })`.
5. Action posts `webkit.messageHandlers.checkForUpdates.postMessage({})` → `MainWindow` case → `AppDelegate.checkForUpdates()` → `updaterController.checkForUpdates(nil)` → Sparkle standard UI (release notes, Install & Relaunch).
6. Sparkle downloads `Tug-<version>.zip`, verifies EdDSA + Developer ID, terminates the app (normal `applicationShouldTerminate` teardown runs — saveState, `processManager.shutdown()`), its `Autoupdate` helper swaps `/Applications/Tug.app`, relaunches.
7. "Check for Updates…" menu item skips 3–5 and goes straight to the standard UI.

---

### Specification {#specification}

**Spec S01: Info.plist keys** {#s01-plist-keys}

Added to `tugapp/Info.plist` (static; nightly's PlistBuddy overrides in `build-app.sh` do not touch them):

| Key | Value |
|-----|-------|
| `SUFeedURL` | `https://github.com/tugtool/tugtool/releases/download/updates/appcast.xml` |
| `SUPublicEDKey` | base64 public key printed by `generate_keys` (Step 2) |
| `SUEnableAutomaticChecks` | `true` |

**Spec S02: pbxproj SPM object graph** {#s02-pbxproj-spm}

Add to `tugapp/Tug.xcodeproj/project.pbxproj`, following the file's synthetic-ID convention (invent fresh unique 24-hex IDs, e.g. `AA00001100000000000000NN`):

- `XCRemoteSwiftPackageReference "Sparkle"` — `repositoryURL = "https://github.com/sparkle-project/Sparkle"`, `requirement = {kind = upToNextMajorVersion; minimumVersion = 2.9.0;}`; listed in the `PBXProject` block's `packageReferences`.
- `XCSwiftPackageProductDependency` — `productName = Sparkle`, referencing the package; listed in the Tug `PBXNativeTarget`'s `packageProductDependencies`.
- A `PBXBuildFile` for the Sparkle product in the target's `PBXFrameworksBuildPhase` (create the phase if the target lacks one). SPM products embed automatically for app targets; no manual Copy Frameworks phase.
- Commit the generated `Package.resolved` from `Tug.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/`.

**Spec S03: sign-bundle.sh slot (4)** {#s03-framework-signing}

Implement the reserved slot, between (3c) and (5). Present-if-shipped (skip silently when no framework — debug DerivedData builds signed by `just app-debug` also run this script):

```bash
SPARKLE_FW="$APP_PATH/Contents/Frameworks/Sparkle.framework"
if [ -d "$SPARKLE_FW" ]; then
    # Nested executables first, then the framework seal. Paths per
    # Sparkle 2's framework layout (Versions/B).
    for nested in \
        "$SPARKLE_FW/Versions/B/XPCServices/Installer.xpc" \
        "$SPARKLE_FW/Versions/B/XPCServices/Downloader.xpc" \
        "$SPARKLE_FW/Versions/B/Autoupdate" \
        "$SPARKLE_FW/Versions/B/Updater.app"; do
        if [ -e "$nested" ]; then
            codesign --force --options runtime --timestamp --sign "$IDENTITY" "$nested"
        fi
    done
    codesign --force --options runtime --timestamp --sign "$IDENTITY" "$SPARKLE_FW"
fi
```

(Sparkle documents `--preserve-metadata=entitlements` for the sandboxed Downloader XPC; Tug is not sandboxed, so plain hardened-runtime signing is correct. If notarization complains about a nested item, sign the specific inner binary it names — the loop's paths cover the known layout.)

**Spec S04: Release workflow + appcast** {#s04-release-workflow}

New `.github/workflows/release.yml` (`workflow_dispatch` only, macos-15) — clone `nightly.yml`'s checkout/toolchain/cache/keychain/notary steps verbatim, then:

1. `tugrust/scripts/build-app.sh` (no `--nightly`, no `TUG_BUILD_NUMBER` per [P08]) → `products/Tug.dmg` + `products/Tug-<version>.zip` (Step 3's build-app.sh change).
2. Guard: fail if `Tug-<version>.zip` already exists as an asset on `updates` (accidental re-release of the same version).
3. Appcast: `tugrust/scripts/make-appcast.sh <zip-dir>` — downloads Sparkle's release tooling (or uses the `generate_appcast` binary from the SPM artifacts checkout), runs `generate_appcast --download-url-prefix "https://github.com/tugtool/tugtool/releases/download/updates/" -o products/appcast.xml <dir containing only the new zip>`. Key sourcing is two-mode: when `SPARKLE_ED_PRIVATE_KEY` is set (CI), add `--ed-key-file -` and pipe the secret to stdin; when unset (local runs on the machine that ran `generate_keys`), omit the flag so `generate_appcast` signs from the login Keychain, its default. Single-item appcast per [P05].
4. Publish: `softprops/action-gh-release@v2` twice — tag `v<version>` (human release, `files: products/Tug.dmg`), and tag `updates` (`files: products/Tug-<version>.zip, products/appcast.xml`, upsert like nightly's rolling tag).

**Spec S05: Bridge contract** {#s05-bridge-contract}

- Swift → JS: `window.__tugBridge.onUpdateAvailable({ version: string, build: string })` — `version` = `sparkle:shortVersionString`-style display version of the found update (from `SUAppcastItem.displayVersionString`), `build` = `SUAppcastItem.versionString`.
- JS → Swift: message handler name `checkForUpdates`, empty body `{}`. Swift side calls `AppDelegate.checkForUpdatesFromDeck()`; no-op (NSLog only) when the updater never started ([P06]).
- Bulletin: `bulletin(\`Tug ${version} is available\`, { description: "Restart into the new version when you're ready.", duration: 30_000, action: { label: "Update…", onClick: postCheckForUpdates } })`. Re-pushes on reconnect are fine — a repeat bulletin after a reconnect is acceptable, matching the voiceover-state re-send philosophy.

#### State Zone Mapping (tugdeck/tugways plans) {#state-zone-mapping}

| State | Zone (appearance / local-data / structure) | Mechanism | Law |
|-------|--------------------------------------------|-----------|-----|
| update-available notice | appearance (transient toast) | imperative `bulletin()` via Sonner; no React state, no store, no persistence | [L06], [L14] |
| pending notice before frontend ready | host-side (Swift) | `AppDelegate` optional var, flushed on `bridgeFrontendReady` (the `pendingOpenPaths` pattern) | n/a (native) |

No web-persistent state of any kind is introduced (no tugbank keys, no localStorage).

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tugapp/Sources/UpdateController.swift` | Sparkle wrapper: eligibility gate, `SPUStandardUpdaterController`, updater + user-driver delegates, gentle-reminder handoff |
| `tugrust/scripts/make-appcast.sh` | CI appcast generation per Spec S04 |
| `.github/workflows/release.yml` | Stable release workflow per Spec S04 |
| `tugdeck/src/lib/update-bridge.ts` | Installs `__tugBridge.onUpdateAvailable`, fires the bulletin, posts `checkForUpdates` |
| `tests/app-test/update-bulletin.test.ts` | Drives the real app: synthesize `onUpdateAvailable`, assert bulletin DOM; `@covers tugdeck/src/lib/update-bridge.ts` |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `UpdateController` | final class | `tugapp/Sources/UpdateController.swift` | owns `SPUStandardUpdaterController`; `startIfEligible()`, `checkForUpdates()`, `var isActive` |
| `UpdateController.Delegate` conformances | ext | same | `SPUUpdaterDelegate.feedURLString(for:)` (env override), `SPUStandardUserDriverDelegate` gentle reminders (`supportsGentleScheduledUpdateReminders`, `standardUserDriverShouldHandleShowingScheduledUpdate(_:andInImmediateFocus:)` → false for scheduled, `standardUserDriverWillHandleShowingUpdate(_:forUpdate:state:)` → push to deck) |
| `AppDelegate.updateController` | property | `tugapp/Sources/AppDelegate.swift` | constructed in `applicationDidFinishLaunching`; menu item "Check for Updates…" in the app menu below About, hidden when `!isActive` |
| `AppDelegate.pendingUpdateNotice` | property | same | queued `(version, build)`; flushed where `flushPendingOpenPaths()` is called on frontendReady |
| `MainWindow.bridgeUpdateAvailable(version:build:)` | fn | `tugapp/Sources/MainWindow.swift` | `evaluateJavaScript("window.__tugBridge?.onUpdateAvailable?.({...})")` |
| `checkForUpdates` handler | 3 edits | `tugapp/Sources/MainWindow.swift` | `contentController.add`, `removeScriptMessageHandler` in `cleanupBridge()`, `case "checkForUpdates"` in `userContentController(_:didReceive:)` forwarding to the delegate |
| `installUpdateBridge()` | fn | `tugdeck/src/lib/update-bridge.ts` | `(w.__tugBridge ??= {})` pattern from `maker-mode-bridge.ts`; called once from deck boot in `tugdeck/src/main.tsx` |
| slot (4) body | script | `tugrust/scripts/sign-bundle.sh` | Spec S03 |
| zip preservation | script | `tugrust/scripts/build-app.sh` | copy `build/staging/<AppName>.zip` → `products/Tug-<version>.zip` before cleanup (stable, signed builds only) |
| `SUFeedURL`, `SUPublicEDKey`, `SUEnableAutomaticChecks` | plist keys | `tugapp/Info.plist` | Spec S01 |
| Sparkle package objects | pbxproj | `tugapp/Tug.xcodeproj/project.pbxproj` | Spec S02 |

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **App-test (selective)** | Real app, real deck: bulletin renders from a synthesized bridge push | `update-bulletin.test.ts` via `just app-test-changed` |
| **Build verification** | Signed bundle integrity with the embedded framework | `codesign --verify --deep --strict`; `just notarize` once before the workflow lands |
| **Manual end-to-end** | The actual update install + relaunch | #integration-verification with a local feed |
| **CI dry-run** | Appcast generation correctness | `make-appcast.sh` against a locally built zip; inspect `sparkle:version`/`edSignature` |

#### What stays out of tests {#test-non-goals}

- Sparkle's own download/verify/install internals — upstream-tested; we configure, not reimplement.
- Automated app-tests of the update *install* — the updater is gated off outside the stable identity, real installs need a served feed and bundle replacement; covered manually at #integration-verification (same reasoning as the real-scribe flows covered outside app-tests).
- Mock feeds inside unit tests — banned pattern (real, not fake); the local-feed manual pass uses real Sparkle against a real zip.

---

### Execution Steps {#execution-steps}

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Sparkle SPM dependency + UpdateController + menu item | done | `68d6f325f` (also carries the slot-(4) signing from #step-3 — the app will not launch without it) |
| #step-2 | EdDSA keypair + Info.plist feed configuration | done | `2154e1912` (public key `q1ZnWaJ…se48=`; private key in the login Keychain, awaiting the user's GitHub secret) |
| #step-3 | Signing slot (4) + zip preservation in build-app.sh | done | `fce42d2f0` (slot (4) itself landed in `68d6f325f`) |
| #step-4 | Appcast script + stable release workflow | done | `fce42d2f0` (same commit as #step-3 — `dash commit` stages the whole worktree) |
| #step-5 | Deck bulletin bridge + gentle reminders | done | `9d2bc73e5` (test named `at0278-update-bulletin.test.ts`, following the corpus numbering) |
| #step-6 | Integration checkpoint (local end-to-end update) | blocked | N/A (verification only) — mechanics verified, consent behavior failed; see [Q02] |

#### Step 1: Sparkle SPM dependency + UpdateController + menu item {#step-1}

**Commit:** `tugapp(self-update): adopt Sparkle 2 and add the update controller`

**References:** [P01] Sparkle via SPM, [P06] updater gating, [P07] standard UI for user checks, Spec S02, (#pipeline-facts, #r02-pbxproj-spm)

**Artifacts:**
- pbxproj package-reference graph per Spec S02 + committed `Package.resolved`
- `tugapp/Sources/UpdateController.swift` (+ pbxproj file/build entries)
- "Check for Updates…" `NSMenuItem` in `AppDelegate.buildMenuBar()`'s app menu (below About, identifier `app.checkForUpdates`), hidden when the updater is inactive

**Tasks:**
- [ ] Add the Sparkle package + product dependency to `project.pbxproj` per Spec S02; run `xcodebuild -resolvePackageDependencies -project tugapp/Tug.xcodeproj -scheme Tug` and commit `Package.resolved`.
- [ ] Write `UpdateController`: `startIfEligible()` implements the [P06] gate (`dev.tugtool.app` bundle ID or `TUG_SPARKLE_FEED` env); constructs `SPUStandardUpdaterController(startingUpdater: true, updaterDelegate: self, userDriverDelegate: self)`; `SPUUpdaterDelegate.feedURLString(for:)` returns `TUG_SPARKLE_FEED` when set, else nil (plist `SUFeedURL` rules). Gentle-reminder delegate methods are stubbed to defaults in this step (full behavior in #step-5).
- [ ] Wire `AppDelegate`: construct + `startIfEligible()` in `applicationDidFinishLaunching`; menu item targets `updateController.checkForUpdates()`; hide the item when `!updateController.isActive` (hidden-not-disabled, the Maker-menu pattern).
- [ ] Info.plist keys wait for #step-2 (no feed URL or public key yet); `UpdateController` stays inactive (NSLog, never crash) unless **both** `SUFeedURL` and `SUPublicEDKey` are present in Info.plist — or `TUG_SPARKLE_FEED` is set, which supplies the feed by itself. This covers dev builds forever AND a stable-identity `just notarize` build made between this step and #step-2, so this commit builds and ships standalone.

**Tests:**
- [ ] `just app-debug` builds clean (warnings are errors) and launches; updater inactive (branch bundle ID), no new menu item visible, no Sparkle side effects.

**Checkpoint:**
- [ ] `xcodebuild -resolvePackageDependencies -project tugapp/Tug.xcodeproj -scheme Tug` succeeds
- [ ] `just app-debug` builds and the app runs normally

---

#### Step 2: EdDSA keypair + Info.plist feed configuration {#step-2}

**Depends on:** #step-1

**Commit:** `tugapp(self-update): configure the Sparkle feed and public key`

**References:** [P03] updates release feed, [P04] EdDSA keys, [P09] auto checks, Spec S01, (#r04-feed-reachability)

**Artifacts:**
- `tugapp/Info.plist` gains `SUFeedURL`, `SUPublicEDKey`, `SUEnableAutomaticChecks` per Spec S01
- The private key exported and handed to the user (NOT committed)

**Tasks:**
- [ ] Run Sparkle's `generate_keys` (from the resolved package's artifacts: `find ~/Library/Developer/Xcode/DerivedData -path '*artifacts*sparkle*' -name generate_keys` after Step 1's resolution, or download the matching Sparkle release's `bin/`). It stores the private key in the login Keychain and prints the public key.
- [ ] Export the private key: `generate_keys -x sparkle_ed_private_key`; hand the file to the user to (a) store as GitHub secret `SPARKLE_ED_PRIVATE_KEY` and (b) back up in a password manager. Delete the local export after confirming. **User action; the plan cannot set repo secrets.**
- [ ] Add the three plist keys per Spec S01.
- [ ] Confirm `github.com/tugtool/tugtool` is public (anonymous `curl -sI https://github.com/tugtool/tugtool/releases` → 200); if private, switch `SUFeedURL` to the `tugtool.dev` host per Risk R04 before committing.

**Tests:**
- [ ] `just app-debug` still builds and runs; updater still inactive for the branch identity.

**Checkpoint:**
- [ ] `plutil -lint tugapp/Info.plist` passes
- [ ] `/usr/libexec/PlistBuddy -c "Print :SUPublicEDKey" tugapp/Info.plist` prints a non-empty base64 key

---

#### Step 3: Signing slot (4) + zip preservation in build-app.sh {#step-3}

**Depends on:** #step-1

**Commit:** `tugrust(self-update): sign Sparkle.framework and preserve the distribution zip`

**References:** [P02] zip is the archive, Spec S03, (#pipeline-facts, #r03-framework-signing)

**Artifacts:**
- `sign-bundle.sh` slot (4) implemented per Spec S03
- `build-app.sh` copies `build/staging/<AppName>.zip` to `products/Tug-<version>.zip` (stable, signed builds; skip on `--nightly` and `--skip-notarize` where no stapled zip exists)

**Tasks:**
- [ ] Implement Spec S03 in `tugrust/scripts/sign-bundle.sh`, replacing the reserved-slot comment block.
- [ ] In `build-app.sh`, after the notarize step and before DMG creation (or anywhere before the `rm -rf "$BUILD_DIR"` cleanup), copy the distribution zip into `$PRODUCTS_DIR` with the versioned name; echo the path alongside the DMG in the completion message.

**Tests:**
- [ ] `just dmg` (unsigned) still completes — slot (4) and the zip copy both no-op gracefully on the unsigned path.
- [ ] One full `just notarize` run: notarization passes with Sparkle.framework embedded; `products/Tug-<version>.zip` exists afterwards; `codesign --verify --deep --strict products-staged app` clean. (This is the R03 gate — do it now, not first in CI.)

**Checkpoint:**
- [ ] `just notarize` succeeds end to end; `ls products/` shows `Tug.dmg` and `Tug-<version>.zip`
- [ ] `codesign -dv --verbose=2 <staged app>/Contents/Frameworks/Sparkle.framework` shows the Developer ID identity

---

#### Step 4: Appcast script + stable release workflow {#step-4}

**Depends on:** #step-3

**Commit:** `ci(self-update): add the stable release workflow and appcast generation`

**References:** [P03] updates release, [P04] private key in CI, [P05] single-item appcast, [P08] stable CFBundleVersion, Spec S04, (#update-flow)

**Artifacts:**
- `tugrust/scripts/make-appcast.sh`
- `.github/workflows/release.yml`

**Tasks:**
- [ ] Write `make-appcast.sh` per Spec S04: locate/obtain `generate_appcast`, run it over a directory containing only the new zip with `--ed-key-file -` (private key on stdin) and the `updates` download-url-prefix; output `products/appcast.xml`.
- [ ] Write `release.yml` per Spec S04, cloning `nightly.yml`'s credential/keychain/cache steps; add the already-released-version guard; publish `v<version>` (DMG) and upsert `updates` (zip + appcast).
- [ ] Verify `make-appcast.sh` locally against Step 3's `products/Tug-<version>.zip` using a throwaway keypair; inspect the XML: one `<item>`, `sparkle:version` = the zip's `CFBundleVersion`, `sparkle:edSignature` present, `url` pointing under `releases/download/updates/`.

**Tests:**
- [ ] Local `make-appcast.sh` dry run as above (real `generate_appcast`, real zip — no mocks).
- [ ] `actionlint`-style sanity: the workflow YAML parses (`gh workflow view` after push, or a YAML lint locally).

**Checkpoint:**
- [ ] `tugrust/scripts/make-appcast.sh products-test-dir` emits a valid single-item `appcast.xml` (inspect per the task above)
- [ ] First real `workflow_dispatch` run of `release.yml` publishes `v<version>` + `updates` (user-triggered; may land after #step-6's local verification)

---

#### Step 5: Deck bulletin bridge + gentle reminders {#step-5}

**Depends on:** #step-1

**Commit:** `tugways(self-update): surface scheduled updates as a deck bulletin`

**References:** [P07] gentle-reminder bulletin, Spec S05, (#bridge-facts, #state-zone-mapping, #update-flow)

**Artifacts:**
- `tugdeck/src/lib/update-bridge.ts` + its `installUpdateBridge()` call in `tugdeck/src/main.tsx`
- Gentle-reminder implementation in `UpdateController`; `AppDelegate.pendingUpdateNotice` queue + flush; `MainWindow.bridgeUpdateAvailable` push; `checkForUpdates` handler (three-site pattern)
- `tests/app-test/update-bulletin.test.ts` with `@covers tugdeck/src/lib/update-bridge.ts`

**Tasks:**
- [ ] `update-bridge.ts`: install `onUpdateAvailable` via the `(w.__tugBridge ??= {})` pattern from `lib/maker-mode-bridge.ts`; fire `bulletin()` per Spec S05; action posts `checkForUpdates`. Import `bulletin` from `@/components/tugways/tug-bulletin` — compose the real component surface, never hand-roll toast DOM.
- [ ] `UpdateController`: `supportsGentleScheduledUpdateReminders = true`; for scheduled updates decline immediate showing (`standardUserDriverShouldHandleShowingScheduledUpdate` → `false`) and forward `(displayVersionString, versionString)` to `AppDelegate`; user-initiated checks keep the standard UI untouched.
- [ ] `AppDelegate`: queue the notice when `!frontendHasLoadedOnce` (flush next to `flushPendingOpenPaths()`), else push via `MainWindow.bridgeUpdateAvailable`.
- [ ] `MainWindow`: the three `checkForUpdates` handler edits (add / remove in `cleanupBridge()` / `case` in `userContentController(_:didReceive:)`); NSLog no-op when the updater is inactive.
- [ ] App-test: launch the app, `evaluateJavaScript("window.__tugBridge.onUpdateAvailable({version:'9.9.9',build:'99999'})")`, assert the bulletin text appears in the DOM; clicking its action must not throw (handler no-ops in the harness). Header carries `@covers`.
- [ ] `bunx vite build` — the new import must survive the production rollup, not just dev esbuild.

**Tests:**
- [ ] `just app-test-changed` (picks up `update-bulletin.test.ts` via `@covers`)
- [ ] `just app-test-covers-check`

**Checkpoint:**
- [ ] `bunx vite build` succeeds
- [ ] `just app-test-changed` passes including the new test

---

#### Step 6: Integration checkpoint — local end-to-end update {#step-6}

**Depends on:** #step-2, #step-3, #step-4, #step-5

**Commit:** `N/A (verification only)`

**References:** [P02] zip archive, [P05] single-item appcast, [P06] env override, Risk R01, (#success-criteria, #update-flow)

**Tasks:** {#integration-verification}
- [ ] Build version A: set a lower version (`tugrust/scripts/version.sh set 0.8.0` state as-is), `just notarize` → install `products/Tug.dmg`'s app into `/Applications` on this Mac (or the VM lab for a factory-fresh pass: `just lab-dmg`).
- [ ] Build version B: `tugrust/scripts/version.sh bump patch`, `just notarize` → keep `products/Tug-<B>.zip`; **revert the version bump afterwards** (the user owns whether a real bump lands).
- [ ] Generate a local appcast for B with `make-appcast.sh`. No key juggling needed: `generate_keys` (#step-2) stored the private key in this machine's login Keychain, and `generate_appcast` signs from the Keychain by default — so on the Mac that ran #step-2, the local appcast verifies against the committed `SUPublicEDKey` as-is (`make-appcast.sh` must only *require* stdin key material when `SPARKLE_ED_PRIVATE_KEY` is set, i.e. in CI).
- [ ] Serve: `python3 -m http.server 8000` in the directory holding `appcast.xml` + the zip; edit the appcast `url` to `http://localhost:8000/...` (`NSAllowsLocalNetworking`/localhost ATS exceptions in Info.plist already permit this).
- [ ] Launch installed A with `TUG_SPARKLE_FEED=http://localhost:8000/appcast.xml open -a Tug --env …` (or `launchctl setenv` / terminal launch of the bundle binary) → expect the deck bulletin for B; click Update… → Sparkle standard flow → Install & Relaunch.
- [ ] Verify after relaunch: About card shows B's version; `pgrep -fl tugcast|tmux` shows no orphaned children from A's instance (Risk R01); a second check reports "up to date".
- [ ] Verify "Check for Updates…" menu item appears (stable bundle ID) and drives the same flow directly.

**Tests:**
- [ ] The manual pass above, recorded in the ledger notes (this is the acceptance test; automation is out of scope per #test-non-goals).

**Checkpoint:**
- [ ] Installed app A self-updates to B and relaunches as B via the bulletin path, with clean child-process teardown

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** A DMG-installed release Tug.app that discovers new versions from GitHub, announces them with a deck bulletin, and installs + relaunches itself through Sparkle — plus the CI workflow that publishes each stable release with a signed appcast.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] Local end-to-end update pass complete (#step-6 checkpoint)
- [ ] `just notarize` produces a notarized bundle with Sparkle embedded + `products/Tug-<version>.zip` (#step-3 checkpoint)
- [ ] `release.yml` run publishes `v<version>` + `updates` with a valid signed appcast (#step-4 checkpoint; user-triggered)
- [ ] `just app-test-changed` green including `update-bulletin.test.ts`; `bunx vite build` green (#step-5 checkpoint)

**Acceptance tests:**
- [ ] #integration-verification manual pass
- [ ] `update-bulletin.test.ts` in the selective app-test run

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] Nightly self-update channel ([Q01])
- [ ] Delta updates (requires multi-item appcast; revisit [P05])
- [ ] Notarize the DMG wrapper itself (pre-existing follow-on in `build-app.sh`)
- [ ] Update preferences surface (automatic-install opt-in, `SUAutomaticallyUpdate`)

| Checkpoint | Verification |
|------------|--------------|
| Sparkle resolves + builds | `xcodebuild -resolvePackageDependencies`; `just app-debug` |
| Plist configured | `plutil -lint`; PlistBuddy prints `SUPublicEDKey` |
| Signed + notarized with framework | `just notarize`; `codesign --verify --deep --strict` |
| Appcast valid | `make-appcast.sh` local dry run inspection |
| Bulletin path | `just app-test-changed`; `bunx vite build` |
| End-to-end update | #integration-verification |
