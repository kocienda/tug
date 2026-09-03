# Code Signing on macOS — Apple Developer ID + Inside-Out Signing

*The signing pipeline that gives `Tug.app` a stable designated requirement across rebuilds (so TCC Accessibility grants persist), why the app-test harness depends on it, and the procedures + failure modes you need to know. Read this before changing anything in `Justfile`'s `build-app` / `app-test` recipes, in `tugrust/scripts/sign-bundle.sh`, in `scripts/setup-dev-signing.sh`, or in the bundle's entitlements / signing settings.*

> **Platform scope.** This document is **macOS-only**. The whole pipeline is structured around Apple's TCC database, the `security` CLI, the `codesign` tool, Xcode's build settings, macOS Accessibility (AX) permissions, and `notarytool`. None of it has a meaningful analogue on Linux or Windows.

*Cross-references: `[D##]` → decisions from the *multi-instance* work. This document is the durable reference.*

---

## Why we sign at all

The app-test harness drives `Tug.app` through trusted hardware events — `CGEvent.post`-backed clicks, drags, key presses. WebKit's `isTrusted` paths only fire for trusted events, and posting trusted events requires the macOS **Accessibility (AX) grant**: System Settings → Privacy & Security → Accessibility, with `Tug.app` toggled on.

The AX grant is not a one-time global thing. macOS's TCC (Transparency, Consent, Control) database keys grants on the **bundle's designated requirement (DR)** — a string that includes the bundle identifier *and* fingerprints of the signing certificate chain. Two binaries with the same DR are interchangeable as far as TCC is concerned. Two with different DRs require a fresh user grant.

**The problem.** Xcode Debug builds default to **ad-hoc signing**, which produces a per-build `cdhash` DR. Different signature → different DR → AX grant invalidated → `CGEvent.post` silently no-ops → every app-test scenario fails with confusing attribution. In a tight test-edit-test loop, the developer would have to re-grant Accessibility every minute.

**The fix.** Sign the bundle with an **Apple Developer ID Application certificate** ([D11]). The DR for a Developer-ID-signed bundle has the shape:

```
identifier "<bundle-id>" and anchor apple generic and certificate 1[…] /* exists */ and certificate leaf[…] /* exists */ and certificate leaf[subject.OU] = <TEAMID>
```

This DR is **structural** — it references the Apple intermediate cert and the team ID rather than a single leaf hash. The team-issued cert can be re-issued (e.g., on annual renewal) and the DR's *shape* stays the same; only the leaf-cert-specific bytes change. TCC matches on the structural pattern, so the AX grant survives cert rotation. This is the architectural improvement over the prior self-signed `Tug Dev` model, where every cert regeneration produced a wholly new DR.

---

## The app-test identity (`TUG_FORCE_BUNDLE_ID`)

The DR depends on exactly one thing that changes between worktrees: the `CFBundleIdentifier`. It is **path-independent and cdhash-independent** — a rebuild at a different filesystem path keeps the AX grant as long as the bundle ID (and team ID) are unchanged. That is precisely why the tight test-edit-test loop on `main` never re-prompts.

But the multi-instance scheme ([D10]/[D19], `assign-bundle-id.sh`) deliberately derives the bundle ID from the git branch: a worktree on branch `foo` builds `dev.tugapp.app.debug-foo`. That is a **new bundle ID → new DR → new TCC entry that has never been granted AX**. macOS cannot pop the grant dialog in an unattended session, so a long-running `tugplug:arc-implement` job that builds in a worktree and runs app-tests dies at the harness's AX preflight. The OS isn't the blocker — the per-branch identity is.

**The fix: pin a single, stable app-test identity — and make it the default.** `TUG_FORCE_BUNDLE_ID` short-circuits the branch mapping in both `assign-bundle-id.sh` (the xcodebuild build phase that stamps `CFBundleIdentifier`) and `bundle-id-from-cwd.sh` (the resolver that quit/launch/instance logic consults), using its value verbatim. The `build-app` and `app-test` recipes **default** it to `dev.tugapp.app.apptest` (`: "${TUG_FORCE_BUNDLE_ID:=…}"`), so every app-test — interactive or unattended, main or worktree — already runs under the granted identity with no env-var prefix to remember. Because the DR is path-independent, the grant given once carries across every worktree. It does **not** carry across a change to the identity itself: the DR is keyed on the `CFBundleIdentifier`, so renaming the app's reverse-DNS prefix retires every grant at once and each identity has to be granted again at its new name. `just app-test-grant` is that gesture, and it is the one interactive step an otherwise unattended arc cannot take for itself.

The DR's path-independence is also what lets app-test bundles **fork per worktree**: `derived-data-path.sh` keys forced-identity builds on the worktree slug (`DerivedData/Tug-apptest-<wtslug>`), so every worktree holds its own physical `Tug-apptest.app` — different code, disjoint build dirs, no cross-worktree clobbering — while all of them carry the same bundle id and the same `Tug Dev` signature and therefore satisfy the **same** DR. N bundles, one grant. Verify after a build with `codesign -dr - <bundle>`: the `designated =>` string must be byte-identical across worktrees.

`dev.tugapp.app.apptest` is a dedicated identity used **only** by the headless harness — it never collides with an interactive `app-debug` / `app-release` instance, and a `tccutil reset` against it touches nothing else. There is **no** "run tests under the `…app.debug` identity" path: app-tests and the interactive debug instance are fully separate identities (and separate ports, sockets, tmux servers, and data dirs). The forced build also stamps both name keys — `CFBundleName` and `CFBundleDisplayName` — to the product name `Tug-apptest`, so the entry is identifiable in System Settings, which lists by `CFBundleName` and would otherwise show every variant as an identical `Tug` row.

**There is no scripted way to grant Accessibility on a non-MDM Mac** — the system TCC database is SIP-protected and `tccutil` only resets. Exactly one human gesture is required, but only *once, ever*, because the DR is path-independent: every future worktree build with the same forced ID inherits the grant.

```sh
# One-time, from any checkout. Builds the pinned-ID app, reveals it in
# Finder, and opens the Accessibility pane:
just app-test-grant
#   → DRAG the Finder-revealed Tug.app into the list (do NOT use "+"),
#     then toggle "Tug-apptest" ON.

# Thereafter, any worktree (unattended or not) — no env var needed:
just app-test                                 # one command: build-if-needed + run; no dialog
just app-test-build at0001-...                # force a rebuild first (after Swift/Rust changes)
```

`app-test` itself does not rebuild Swift, so the pinned ID is baked in at **`build-app` time** — that's when it lands in the bundle's `Info.plist` and is sealed into the DR. Both recipes default the ID to `dev.tugapp.app.apptest`, so the build and the run can't disagree. As a safety net, `app-test` reads the built bundle's `CFBundleIdentifier`, prints it (`==> app-test bundle id: …`), and warns if it doesn't match the identity being driven.

### The grant dance: hard-won specifics

These cost real time the first time through. Read them before granting.

1. **The harness prompt records a *denial*, not nothing.** The preflight calls `AXIsProcessTrustedWithOptions(prompt: true)`, which surfaces the system dialog — but the harness SIGKILLs the app the instant the check returns `false`, so the request resolves as **denied** and is written to TCC as `auth_value = 0`. A denied entry will not re-prompt and cannot be toggled on from a stale row. If you ever ran the harness against an un-granted identity, **reset it before trying to grant**:
   ```sh
   tccutil reset Accessibility dev.tugapp.app.apptest
   ```
   This is also why `just app-test-grant` exists: it never runs the harness, so it never poisons the entry with a denial.

2. **Add by DRAG, not "+".** The "+" file picker defaults to `/Applications` and Spotlight will happily offer any of the dozen stale `Tug.app` copies in DerivedData — pick the wrong one and you grant the wrong (or a defunct) identity. `just app-test-grant` reveals the *correct* bundle in Finder; drag that exact app into the list.

3. **The Settings UI lies — trust the DB.** System Settings lists apps by display name, collapses identically-named/identically-iconed rows, and caches stale names. Every variant carries its own name — `Tug-apptest`, `Tug-debug`, `Tug` — but the list caches whatever name a bundle wore when it was first added, so a row can still read `Tug` long after the bundle behind it was renamed, and adding or removing one can *appear* to make another "disappear". None of that reflects the database. The system TCC store is readable (it needs Full Disk Access, which Terminal/iTerm usually have) — verify the real state directly:
   ```sh
   sqlite3 -separator ' | ' "/Library/Application Support/com.apple.TCC/TCC.db" \
     "select client, auth_value from access \
      where service='kTCCServiceAccessibility' and client like 'dev.tugapp%';"
   # auth_value: 2 = allowed, 0 = denied. This is the source of truth.
   ```
   Writing to that DB requires SIP disabled (don't); `tccutil reset` + drag-to-grant is the supported path.

4. **The identities and what each is for** (all granted independently, all persist by DR across rebuilds):
   | Bundle ID | Display name | Needs AX for |
   |---|---|---|
   | `dev.tugapp.app.apptest` | `Tug-apptest` | **all** app-tests — `build-app` / `app-test` default to this identity (no env-var prefix). It is the only identity tests ever run under. |
   | `dev.tugapp.app.debug` | `Tug-debug` | interactive `just app-debug`. **Never** runs app-tests. |
   | `dev.tugapp.app` | `Tug` | release/main interactive build (does not need AX for normal use) |

**Caveat — serial only.** All app-test runs now share one identity. Two *concurrent* app-test runs in different worktrees would contend on that identity (LaunchServices / TCC / instance coordination). A single `implement` job runs its app-tests serially, so this is a non-issue there. The parallel case needs the MDM/PPPC route below.

**When this isn't enough — MDM PPPC.** A PPPC (Privacy Preferences Policy Control) configuration profile can pre-authorize `kTCCServiceAccessibility` with no user interaction, and its code requirement can be **structural by team ID** (`anchor apple generic and certificate leaf[subject.OU] = Z67582R5Y8`) — granting AX to *any* team-signed bundle, every per-branch ID included, with full parallel support. The catch: Accessibility PPPC grants only take effect when the profile is delivered via **MDM to an enrolled device** — a hand-installed profile won't grant AX. That's the only path that escapes the per-branch identity entirely; reach for it if/when concurrent app-tests across worktrees become a requirement.

### Clearing what the old `dev.tugtool` prefix left behind

The app's reverse-DNS prefix used to be `dev.tugtool`, and this subsection is the one place in the tree where those identities are still typed on purpose: naming what is being cleared is the whole point of it. Everything below is optional. Nothing under the old prefix is consulted by anything any more, so a machine that never runs a line of it works exactly as well as one that does — the reason to bother is that the old TCC rows sit in the Accessibility list under the same display names as the new ones, which makes the list harder to read the next time you have to grant something.

The TCC rows first. They are keyed on the bundle identifier, so the retired identities each hold their own entry, and a `reset` against one touches nothing else:

```sh
tccutil reset Accessibility dev.tugtool.app.apptest
tccutil reset Accessibility dev.tugtool.app.debug
tccutil reset Accessibility dev.tugtool.app
tccutil reset Accessibility dev.tugtool.app.dev
```

The last of those is older than the prefix: `dev.tugtool.app.dev` was the `(development, main)` shorthand [D19] retired, and its row has been orphaned since. A machine that ever built an interactive bundle in a worktree also holds a `dev.tugtool.app.debug-<slug>` or `dev.tugtool.app.release-<slug>` row per branch, which nothing can enumerate for you — read the list and reset what you recognise.

Then the WebKit caches, which are per-bundle-identifier directories and are pure disk:

```sh
rm -rf ~/Library/Caches/dev.tugtool.app*
```

The stale LaunchServices registrations need nothing: they point at DerivedData bundles that a `just build-app` under the new identity has already replaced, and `lsregister` prunes a registration whose bundle is gone on its own schedule.

**Do not reset anything under `dev.tugapp`.** Those are the live identities, and `dev.tugapp.app.apptest` in particular holds the one hand-granted Accessibility grant every unattended app-test run depends on — resetting it costs another trip through [the grant dance](#the-grant-dance-hard-won-specifics).

---

## The architecture (six moving parts)

| Component | Responsibility |
|---|---|
| `scripts/setup-dev-signing.sh` | One-shot per machine. **Verifies** that the Apple Developer ID Application cert is installed in the login keychain. Prints actionable instructions if it isn't. No openssl, no .p12, no provisioning — the cert is installed once via Xcode → Settings → Accounts → Manage Certificates → "+" → "Developer ID Application". |
| `Tug.xcodeproj`'s build settings | `CODE_SIGN_STYLE = Automatic`, `ENABLE_HARDENED_RUNTIME = YES`. xcodebuild signs ad-hoc by default. We deliberately do **not** override the project's signing identity at the pbxproj level. |
| `tugrust/scripts/sign-bundle.sh` | The canonical signer. Walks the bundle inside-out — signing Rust helpers (default hardened runtime, no custom entitlements), the Swift debug dylibs (Debug builds only — must share the loading binary's team ID under hardened runtime), `tugcode` (bun-compiled, permissive entitlements per [D16]), then sealing the outer `.app` with `Tug.entitlements`. Never uses `--deep` for signing; `--deep` remains valid for verification. |
| `tugapp/Tug.entitlements` | The outer Swift binary's entitlements. Minimal — currently just `com.apple.security.cs.allow-unsigned-executable-memory` (left over from pre-hardened-runtime WKWebView assumptions; can be re-evaluated). |
| `tugapp/tugcode.entitlements` | The five bun-required permissive entitlements applied to the bun-compiled `tugcode` binary only: `allow-jit`, `allow-unsigned-executable-memory`, `disable-executable-page-protection`, `allow-dyld-environment-variables`, `disable-library-validation`. Per [D16]. |
| `Justfile` `build-app` / `app-test` recipes | Re-sign post-xcodebuild via `sign-bundle.sh`. Capture the bundle's DR into `.tugtool/code-sign-fingerprint`. `app-test` reads the sentinel before re-signing and skips when the bundle's current DR already matches (the steady-state case). Each build variant uses its own `-derivedDataPath` (`derived-data-path.sh`, keyed on `PRODUCT_NAME`) so the app-test bundle and a live `app-debug` bundle never share one DerivedData and never clobber each other's `.app`. |
| `tugrust/scripts/derived-data-path.sh` | Resolves the per-variant Xcode DerivedData path for the cwd's build identity (parallel to `product-name-from-cwd.sh`). Xcode's default DerivedData is shared per-project — all `Tug`-scheme builds land in one directory and, being the same target, evict each other's product. Per-variant `-derivedDataPath` isolates the build outputs. |

The fingerprint sentinel at `.tugtool/code-sign-fingerprint` is now **belt-and-suspenders** ([D11]). Under Developer ID + hardened runtime, the DR is stable across rebuilds anyway, so the sentinel rarely fires. It still catches the case where the user re-issues their Developer ID cert (e.g., on renewal) and the new cert produces a different DR string.

---

## Inside-out signing (the order matters)

Per Apple's macOS 13+ guidance, any bundle with heterogeneous nested binaries must be signed **inside-out**. `sign-bundle.sh` enforces the order:

```
1. Rust helpers          (tugcast, tug, tugexec, tugrelaunch, tugbank)
                         — no custom entitlements

2. Swift debug dylibs    (Tug.debug.dylib, __preview.dylib — Debug builds only)
                         — no custom entitlements; must share the outer
                           binary's team ID or hardened runtime refuses
                           to load them

3. tugcode               (bun-compiled)
                         — entitlements: tugapp/tugcode.entitlements
                           (the 5 bun-permissive entitlements)

4. [reserved]            — future Sparkle.framework or other nested
                           frameworks slot in here

5. Outer Tug.app         (the Swift Tug binary + bundle wrapper)
                         — entitlements: tugapp/Tug.entitlements
                         — this is the final seal; records every
                           nested signature beneath it
```

Every step uses `--force --options runtime --timestamp`. `--options runtime` engages the hardened runtime; `--timestamp` requests a secure timestamp from Apple's timestamp server (needed for notarization). `--deep` is **banned for signing** in this codebase — it would apply the same entitlements file (or no entitlements) to every nested binary, which is exactly wrong for step (3).

`--deep` is allowed for *verification*: `codesign --verify --deep --strict` walks the whole bundle and confirms every nested signature checks out against the outer seal.

---

## Procedures

### First-time setup (per machine, ~5 minutes)

```sh
# 1. Install the Developer ID Application cert in Xcode (one-click flow):
#    Xcode → Settings → Accounts → (your Apple ID) → (team) → Manage
#    Certificates → "+" → "Developer ID Application".
#
# 2. Verify the install:
just setup-dev-signing

# 3. Build + smoke-test:
just build-app
just app-test-smoke         # first run pops the AX grant dialog
```

When the AX grant dialog appears, click "Open System Settings" and toggle `Tug.app` on under Privacy & Security → Accessibility. Subsequent runs work without prompting because every build signs with the same Developer ID identity → same DR → the grant persists.

### Day-to-day flow

```sh
just build-app    # when Swift / Rust / tugdeck-dist sources changed
just app-test     # full sweep, or `just app-test <files...>`
```

`just app-test` runs `bun run build` to refresh `tugdeck/dist` on every invocation. Swift changes still need `just build-app`.

### Decommissioning (rare)

```sh
just teardown-dev-signing
```

Clears the fingerprint sentinel. Does **not** touch the Developer ID cert in your login keychain — that's your Apple-issued identity, not project-scoped. To remove the cert, use Keychain Access manually.

### Onboarding without `setup-dev-signing`

A contributor who just wants to read or edit the source — without running the test harness — does **not** need a Developer ID cert. They can:

- Build via Xcode IDE or `xcodebuild` directly (ad-hoc signature; works fine for non-test runs). Hardened runtime stays on but ad-hoc signing produces a bundle that won't satisfy the recipe's DR sentinel check.
- Run `just app-test` with `APP_TEST_SKIP_RESIGN=1` to skip the re-sign step. CGEvent-dependent tests will fail (no AX grant against ad-hoc DR), but tests that don't need AX — `harness-smoke/smoke.test.ts`, `version-handshake.test.ts`, etc. — will pass.

---

## Spec: the fingerprint sentinel

**Path:** `.tugtool/code-sign-fingerprint` (gitignored).

**Format:** UTF-8 plain text, single line, the bundle's designated requirement string verbatim, as emitted by:

```sh
codesign -d -r- "$APP_DIR" 2>&1 \
    | sed -nE 's/^#?[[:space:]]*designated[[:space:]]+=>[[:space:]]+(.*)$/\1/p' \
    | head -1
```

The `sed` pattern tolerates two forms: `designated => identifier "…" and …` (Developer-ID-signed) and `# designated => cdhash H"…"` (ad-hoc). The leading `#?` makes the `#` optional.

A representative DR for a Developer-ID-signed bundle:

```
identifier "dev.tugapp.app.apptest" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] /* exists */ and certificate leaf[field.1.2.840.113635.100.6.1.13] /* exists */ and certificate leaf[subject.OU] = Z67582R5Y8
```

**Lifecycle:**
- Captured at the end of `build-app`, after `codesign --verify --strict` confirms the bundle is valid. Atomic write: temp file in the same dir + `mv`.
- Compared at the start of `app-test`, before the per-invocation re-sign decision.
- `app-test` writes nothing to the sentinel — only `build-app` does.

**Decision matrix in `app-test`:**

| Sentinel exists? | Bundle DR == saved DR? | Action |
|---|---|---|
| Yes | Yes | Skip the re-sign entirely. Print `==> Re-sign skipped (bundle DR matches sentinel)`. |
| Yes | No | Fall through to the re-sign branch. After re-sign, re-extract DR; if still mismatched, print a 4-line `[warn]` block (drift). |
| No | (can't compare) | Fall through to the re-sign branch. No drift warn possible until the next `build-app` writes the sentinel. |

Under Developer ID signing the DR is stable, so the skip path is the common case. The skip-on-match optimization also avoids the unnecessary work of re-signing 5+ binaries every test invocation.

---

## What can break the AX grant (failure modes)

The AX grant survives across ordinary rebuilds because the DR stays stable under Developer ID. It breaks when something perturbs the DR shape or the TCC database itself.

1. **Developer ID cert re-issued.** A new cert produces a leaf-level different DR (though the structural shape stays). TCC grants are leaf-sensitive in some macOS versions; you may need to re-grant once. The fingerprint sentinel detects this on the next `build-app`.
2. **`Tug.app` bundle moved or renamed.** TCC also keys grants on bundle path / identifier; relocating the build product will invalidate the grant.
3. **`CFBundleIdentifier` changes** (e.g., a worktree on a non-main branch produces `dev.tugapp.app.debug-<slug>` per [D10]/[D19]). Each `(profile, branch)` identity is a distinct LaunchServices app with its own TCC entry. First launch of a new identity prompts; subsequent launches of the same identity don't. For unattended worktree app-tests where no one can answer the prompt, pin the identity with `TUG_FORCE_BUNDLE_ID` — see ["The app-test identity"](#the-app-test-identity-tug_force_bundle_id).
4. **Bare `xcodebuild` between runs** (or an Xcode IDE Build click). Re-signs ad-hoc with a fresh `cdhash` → wholly different DR. `app-test`'s per-invocation re-sign restores Developer ID transparently — but only if the cert is still installed.
5. **macOS major upgrade.** A major version bump can occasionally wipe TCC entries. Diagnoses as a one-shot re-grant requirement.
6. **Manual revoke** in System Settings → Privacy & Security → Accessibility, untoggling `Tug.app`.

---

## Diagnosis checklist (when AX is broken)

When `just app-test` starts failing with `AccessibilityPermissionMissingError` or every CGEvent-backed test silently no-ops, walk these in order. (This list also lives in [`tests/app-test/README.md`](../tests/app-test/README.md) for the test-author audience.)

1. **Confirm the Developer ID cert is still installed:**
   ```sh
   security find-identity -v -p codesigning | grep "Developer ID Application"
   ```
   Empty → run `just setup-dev-signing` for instructions on installing via Xcode, then `just build-app`.

2. **Confirm the bundle's DR matches the sentinel:**
   ```sh
   APP_DIR="$(xcodebuild -project tugapp/Tug.xcodeproj -scheme Tug \
       -configuration Debug -destination 'platform=macOS,arch=arm64' \
       -showBuildSettings 2>/dev/null \
       | awk '/ BUILT_PRODUCTS_DIR /{print $3}')/Tug.app"
   diff <(codesign -d -r- "$APP_DIR" 2>&1 \
       | sed -nE 's/^#?[[:space:]]*designated[[:space:]]+=>[[:space:]]+(.*)$/\1/p' \
       | head -1) \
        .tugtool/code-sign-fingerprint
   ```
   Empty diff → fingerprint is fresh. Non-empty → drift; the AX grant may be invalidated.

3. **Confirm Accessibility shows `Tug.app` and is enabled:** open System Settings → Privacy & Security → Accessibility. If `Tug.app` isn't listed, run `just app-test harness-smoke/smoke-native.test.ts` once to trigger the system grant dialog.

4. **If the grant is stale and re-toggling doesn't work, reset and re-grant:**
   ```sh
   tccutil reset Accessibility dev.tugapp.app.debug    # for debug-main
   ```
   Then run `just app-test harness-smoke/smoke-native.test.ts` to trigger the dialog fresh. Substitute the actual `CFBundleIdentifier` from `Info.plist` if you're on a non-main branch.

5. **Last resort — bypass the re-sign entirely:**
   ```sh
   APP_TEST_SKIP_RESIGN=1 just app-test
   ```
   Useful when diagnosing whether the re-sign step itself is the culprit. CGEvent-dependent tests will fail; protocol-only smoke tests will pass.

---

## Design decisions

These came from the *multi-instance* work. The most relevant are:

- **[D11]** — Apple Developer ID + notarization + hardened runtime. All builds (debug and release) sign with the Developer ID Application certificate. Notarization is release-only.
- **[D16]** — Per-binary entitlements; inside-out signing replaces `--deep`. The bash-coded contract in `sign-bundle.sh` is the single source of signing truth.

Cross-cutting decisions worth knowing:

### `--force --options runtime --timestamp` on every codesign invocation

- `--force` — replaces existing signatures (xcodebuild's ad-hoc, or a prior Developer ID sig from a previous run).
- `--options runtime` — engages the hardened runtime sandbox. Without it, the bundle won't notarize and the platform's modern protections don't apply.
- `--timestamp` — requests a secure timestamp from Apple's TSA. Required for notarization; without it, notary submission fails.

### `--deep` is FORBIDDEN for signing; valid for verification

`--deep` applies the same entitlements (or no entitlements) to every nested binary. Wrong for our bundle shape — tugcode needs permissive JIT entitlements; the Rust helpers and outer Swift binary do not. The inside-out script in `sign-bundle.sh` enumerates each binary explicitly. Verification (`codesign --verify --deep --strict`) is fine; it walks the bundle and *checks* signatures, doesn't replace them.

### Do *not* set `CODE_SIGN_IDENTITY = "Developer ID Application: …"` in `project.pbxproj`

The Xcode project keeps `CODE_SIGN_STYLE = Automatic` (which produces ad-hoc signatures from xcodebuild). The "overwrite-after-xcodebuild" approach via `sign-bundle.sh` stays. Reasons:

- pbxproj edits are awkward — Xcode rewrites the file on its own schedule; manual edits can get reformatted, conflict on merge, or behave unpredictably across Xcode versions.
- The post-xcodebuild re-sign already works correctly and is the place where per-binary entitlements get applied.
- Putting a specific identity in pbxproj would force every contributor through the Xcode-Settings-Accounts setup for *any* build — including non-test debugging via Xcode IDE.

---

## Notarization (release builds only)

Release builds destined for distribution must be **notarized** by Apple before macOS Gatekeeper will accept them on a clean machine. A notarized bundle has Apple's notary ticket stapled into it; first launch on the user's Mac doesn't need an internet round-trip to Apple's servers.

The pipeline:

```
just notarize        →  build-app.sh           →  sign-bundle.sh    (inside-out signing)
                                                 ↓
                                                 notarize.sh       (submit + wait + staple)
                                                 ↓
                                                 hdiutil create    (DMG)
```

`tugrust/scripts/notarize.sh` is the canonical notarizer. It packs the bundle via `ditto -c -k --keepParent`, submits to Apple's notary service with `--wait --timeout 30m` (typical wait: 5-15 min; ceiling: 30 min), staples the ticket via `xcrun stapler staple`, validates via `xcrun stapler validate`, and confirms Gatekeeper acceptance via `spctl --assess --type execute --verbose`.

Auth uses the `tug-notary` keychain profile (see #apple-prereqs below), not inline `APPLE_ID` / `TEAM_ID` / `NOTARY_PASSWORD` env vars. The profile stores the credentials in the user's login keychain once; the script references it by name. Never put the app-specific password in command history, env files, or CI logs.

On CI there is no login keychain, so the nightly workflow creates an ephemeral one, provisions the same `tug-notary` profile into it via `notarytool store-credentials`, and destroys it at the end of the job. `notarize.sh` reads `TUG_NOTARY_KEYCHAIN` to find it; unset — every developer machine — means the login keychain and unchanged behavior. The profile therefore remains the only auth mechanism the script knows about, on every machine.

The one place credentials appear in an environment is that single provisioning step, populated from masked repository secrets. No other step in the job sees them: the build step, which runs cargo, bun, xcodebuild and a from-source tmux build, receives a keychain *path* and nothing else. Widening that exposure — passing the password to the build, or writing it to a file the build can read — is a regression, not a convenience.

### Failure modes

On notary failure, `notarize.sh` extracts the submission UUID from `notarytool`'s tee log and surfaces an actionable hint:

```
xcrun notarytool log <UUID> --keychain-profile tug-notary
```

It also attempts to fetch the log inline (best effort — fails silently if notary never recorded the submission). The most common rejection causes:

- **Missing hardened-runtime flag** on a nested binary. `sign-bundle.sh` always uses `--options runtime` so this shouldn't happen, but a regression there would surface as a notary rejection within a minute of submission.
- **Missing secure timestamp**. `--timestamp` is required; same as above, `sign-bundle.sh` always sets it.
- **Disallowed entitlement**. Apple's notary allows the five tugcode permissive entitlements ([D16]); future additions must be checked against Apple's hardened-runtime entitlement reference.

### Gatekeeper quarantine test (canonical end-user verification)

The most realistic test of "would a real user be able to launch this from a downloaded DMG?" is to apply the quarantine xattr to a fresh copy of the notarized bundle, then `open` it:

```sh
# Copy the notarized bundle to a clean location.
cp -R build/staging/Tug.app /tmp/Tug-quarantine-test.app

# Apply the quarantine xattr that Safari/Mail/AirDrop attach to
# downloaded files. The exact value doesn't matter much; the
# presence of the attribute triggers Gatekeeper's full assessment
# on first launch.
xattr -w com.apple.quarantine '0181;00000000;;' /tmp/Tug-quarantine-test.app

# Launch. Gatekeeper should accept silently; macOS should NOT show
# the "downloaded from internet, can't verify" dialog.
open /tmp/Tug-quarantine-test.app
```

The launch is the test. If macOS shows a security dialog ("you can't open this app because the developer cannot be verified" or similar), notarization didn't take or the staple wasn't applied. Inspect via:

```sh
xcrun stapler validate /tmp/Tug-quarantine-test.app
spctl --assess --type execute --verbose /tmp/Tug-quarantine-test.app
```

`spctl` should report `source=Notarized Developer ID` (NOT `source=Unnotarized Developer ID`).

## What we deliberately don't do (yet)

- **No notarization on debug builds.** Notarization is release-only ([D11]); debug builds skip the 5-30 minute notary round-trip. `build-app.sh --skip-notarize` opts out for fast iteration.
- **No App Sandbox.** Tug doesn't enable `com.apple.security.app-sandbox`. Required for Mac App Store distribution; optional for Developer ID. Out of scope; may be revisited if/when MAS becomes interesting.
- **No CI integration for app-test.** The AX grant requires an interactive macOS session; CI runners that don't have AX access can't run the AT-suite.
- **No multi-user keychain coordination.** Single-user-per-machine assumption.

---

## Files in scope

| File | Role |
|---|---|
| `scripts/setup-dev-signing.sh` | Verifies the Developer ID cert is installed; prints install instructions if not. |
| `tugrust/scripts/sign-bundle.sh` | Canonical inside-out signer. Single source of signing truth. |
| `tugrust/scripts/notarize.sh` | Submits to Apple notary, staples ticket, verifies Gatekeeper. Release path only. |
| `tugrust/scripts/build-app.sh` | Production / release build pipeline; calls `sign-bundle.sh` then `notarize.sh`. |
| `Justfile` `build-app` recipe | Dev build pipeline; calls `sign-bundle.sh`; captures sentinel. |
| `Justfile` `app-test` recipe | DR + sentinel comparison; defensive re-sign; `APP_TEST_SKIP_RESIGN=1` opt-out. |
| `Justfile` `teardown-dev-signing` recipe | Clears the sentinel. |
| `tugapp/Tug.entitlements` | Outer Swift binary entitlements (minimal). |
| `tugapp/tugcode.entitlements` | bun-permissive entitlements for the `tugcode` binary. |
| `.tugtool/code-sign-fingerprint` | Drift-detection sentinel. Gitignored. Written by `build-app`. |
| `tests/app-test/README.md` | Test-author-facing version of the diagnosis checklist. |

---

## Cross-references

- [`tests/app-test/README.md`](../tests/app-test/README.md) — test-author-facing usage + failure-mode diagnosis.
- [`scripts/setup-dev-signing.sh`](../scripts/setup-dev-signing.sh) — the per-machine verifier.
- [`tugrust/scripts/sign-bundle.sh`](../tugrust/scripts/sign-bundle.sh) — heavy comments explaining each phase.
