<!-- devise-skeleton v4 -->

## App-Release Recipes {#app-release-recipes}

**Purpose:** One definitive version number with a single writer and a mechanical drift check, plus a `just`-driven release workflow: prep locally with gates, push one tag, and CI builds, tests, and publishes the stable release and its Sparkle feed.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main (via a dash worktree) |
| Last updated | 2026-07-27 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

The release machinery mostly exists — `tugrust/scripts/version.sh` propagates the workspace version, `.github/workflows/release.yml` builds a signed + notarized DMG and publishes a two-tag release (`v<version>` carrying `Tug.dmg`, rolling `updates` carrying `Tug-<version>.zip` + `appcast.xml`), and `tugrust/scripts/make-appcast.sh` generates the signed feed. But no stable release has ever been cut, nothing is wired to `just`, and the version story has real defects: `MARKETING_VERSION = 0.5.19` sits stale in `tugapp/Tug.xcodeproj/project.pbxproj` (inert only because `INFOPLIST_FILE = Info.plist` holds literals today), `.claude-plugin/plugin.json` carries a version `version.sh` never writes, `version.sh set` runs `cargo generate-lockfile` which re-resolves the entire dependency graph (measured: 149 third-party packages would move on the next bump), and `release.yml` runs zero tests before shipping.

This phase locks the version model — `tugrust/Cargo.toml` `[workspace.package].version` is the source of truth, `version.sh` is the only writer, `version.sh check` proves every site agrees — and layers the release gesture on top: `just release-prep` (gate + bump, never commits), user commits and pushes, `just release` (push exactly one tag), tag-triggered CI (gate + build + publish), `just release-status` (observe). A `just update-rig` recipe captures the local Sparkle end-to-end procedure proven during the quit-hardening [Q02] diagnosis, so updater-experience work has a one-command inner loop.

#### Strategy {#strategy}

- Fix the version substrate first (single writer, xcconfig-fed Xcode, workspace-scoped lockfile update, drift check), because every recipe leans on it.
- `just` owns the local half — decide, bump, verify, trigger, observe. CI owns the build. Nothing locally built is ever a release artifact.
- Files are truth; the tag is the trigger. CI hard-fails if the tag and the tree disagree, so a checked-out tag always describes itself.
- `release-prep` gates *then* bumps, and never commits — the bump diff is small and the user's eyes belong on it. Committing and pushing are the user's acts.
- `just ci` gates twice: locally inside `release-prep` for fast feedback, and as steps in `release.yml` so a tag pushed from anywhere can't ship red.
- Every guard fails loudly with a named reason; no recipe silently "fixes" state.

#### Success Criteria (Measurable) {#success-criteria}

- `just version` prints the version and exits 0 only when all declaration sites agree; corrupting any one site (e.g. hand-editing `tugdeck/package.json`) makes it exit non-zero naming that site.
- `grep -c "MARKETING_VERSION\|CURRENT_PROJECT_VERSION" tugapp/Tug.xcodeproj/project.pbxproj` returns 0; the same grep over `tugapp/Version.xcconfig` returns 2.
- A `version.sh bump patch` changes only: `tugrust/Cargo.toml`, `tugrust/Cargo.lock` (workspace-member entries only — zero third-party packages), `tugcode/package.json`, `tugdeck/package.json`, `.claude-plugin/plugin.json`, `tugapp/Version.xcconfig`. Verified by `git diff --stat` and the lock-diff guard.
- A Debug or Release build's *built* `Info.plist` carries `CFBundleShortVersionString` equal to `version.sh show` and `CFBundleVersion` equal to `major*10000 + minor*100 + patch` (verified by `tests/build-info/test-info-plist.sh`).
- `build-app.sh` aborts if the staged bundle's `CFBundleShortVersionString` is empty or differs from the workspace version.
- `release.yml` triggered by tag `v0.9.9` against a tree whose version is `0.8.1` fails at the guard step before any build work (verifiable by reading the workflow logic; live-fire is the user's first release).
- A tag-triggered run restores branch identity before building: the workflow's rebrand step precedes the build step, and the local detached→`main` transition is proven in a throwaway clone (Step 6). A tag that is not an ancestor of `origin/main` fails the guard before any build work.
- `update-rig.sh` contains no hardcoded bundle id (`grep -c 'dev\.tugtool\.app'` → `0`) and prints the domain it clears.
- `just release` refuses when: the tree is dirty, HEAD ≠ `origin/main`, `version.sh check` fails, or the tag already exists — each with a distinct message.
- `git tag -l 'v*'` lists nothing locally after tag hygiene (84 stale unpushed `v0.7.*`-era tags deleted); `origin` still has only tags pushed deliberately.
- `just update-rig` takes a built DMG to a live localhost Sparkle feed and a launched app pointed at it in one command.

#### Scope {#scope}

1. `version.sh` rework: plugin.json coverage, `Version.xcconfig` emission, workspace-scoped lockfile update with a diff guard, `check` subcommand, stop writing `Info.plist`.
2. Xcode version plumbing: `Version.xcconfig` as `baseConfigurationReference`, `Info.plist` variable references, pbxproj literal deletion.
3. Build-time guards: `build-app.sh` staged-plist assertion; `tests/build-info/test-info-plist.sh` version asserts.
4. Justfile recipes: `version`, `version-set`, `version-bump`, `release-prep`, `release`, `release-status`, `update-rig`.
5. `release.yml`: tag trigger, tag↔version guard, `version.sh check`, lint + test gate before the build.
6. Tag hygiene: delete the stale local `v*` tags; single-tag push discipline.
7. `update-rig.sh`: the local Sparkle feed rehearsal as a script.

#### Non-goals (Explicitly out of scope) {#non-goals}

- Release notes in the appcast (`resources/release-notes/<version>.md` → HTML → `generate_appcast` embedding). Deliberately deferred to the follow-on updater-experience plan; the user did not opt it into this phase.
- Cutting the first stable release. That is the user's act, and it additionally requires the `SPARKLE_ED_PRIVATE_KEY` repository secret (currently unset — `gh secret list` shows Apple credentials only).
- Nightly-channel Sparkle feed or nightly workflow changes beyond keeping `nightly.yml` working unchanged.
- Homebrew tap / other distribution channels (`TAP_GITHUB_TOKEN` exists but is untouched here).
- Changing the `CFBundleVersion` scheme (`major*10000 + minor*100 + patch` stays; it is monotonic and derivable from the version alone, per the rationale in the `release.yml` header comment).

#### Dependencies / Prerequisites {#dependencies}

- `gh` CLI authenticated (used by `release-prep`, `release`, `release-status`).
- For `update-rig`: a Sparkle EdDSA private key in the login Keychain (from `generate_keys`; already present on the dev machine — it signed the quit-hardening [Q02] rig feed) and a Developer ID cert for the initial `build-app.sh` signing pass.
- For the first real release (user's act, not this plan): `SPARKLE_ED_PRIVATE_KEY` set as a GitHub Actions secret.

#### Constraints {#constraints}

- **ONLY THE USER CAN COMMIT TO GIT** (CLAUDE.md); the implement skill commits on the dash worktree only. Tag creation/push happens exclusively inside `just release`, run by the user.
- Tag deletion (Step 6) mutates the repo's shared refs — tags live in the common git dir, so deleting from the dash worktree deletes them for every checkout. The step calls this out; the user can veto at implement time.
- **WARNINGS ARE ERRORS** — `-D warnings` via `tugrust/.cargo/config.toml`.
- No freestanding docs dropfiles: workflow documentation lives in Justfile recipe comments and workflow-file header comments, matching the existing convention (see the `app-debug` / `reap` comment blocks).
- `version.sh` must keep working with only stock macOS tooling (bash, sed, PlistBuddy, python3) plus cargo — it runs on CI runners and dev machines alike.

#### Assumptions {#assumptions}

- Xcode substitutes `$(MARKETING_VERSION)`-style build settings in `Info.plist` string values processed via `INFOPLIST_FILE` — this is the stock app-template pattern. Verified by the Step 2 checkpoint against a real build before anything depends on it.
- Every downstream reader of a version-bearing plist reads the *built* bundle's copy, post-substitution: `build-app.sh` (`$STAGING_APP/Contents/Info.plist`), `capture-build-info.sh`, `assign-bundle-id.sh`, `tests/build-info/test-info-plist.sh`, `AppDelegate.swift` (runtime `info["CFBundleShortVersionString"]`). `version.sh` is the only reader of the *source* plist, and it stops needing to be. (Investigated this session; re-verify with the Step 2 grep task.)
- The 84 local `v*` tags are unpushed: `git ls-remote --tags origin` shows only `nightly`.

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

This plan follows the devise-skeleton v4 conventions: explicit `{#anchor}` on every cited heading, `[P##]` for plan-local decisions, `[Q##]` open questions, `S##` specs, `T##` tables, `R##` risks, `**Depends on:**` lines citing `#step-N` anchors, and rich `**References:**` lines. No line-number citations.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Does Info.plist build-setting substitution cover CFBundleVersion? (DECIDED) {#q01-plist-substitution}

**Question:** Will `$(MARKETING_VERSION)` / `$(CURRENT_PROJECT_VERSION)` in `tugapp/Info.plist` be substituted into the built bundle's plist for this project's manual `INFOPLIST_FILE = Info.plist` setup (no `GENERATE_INFOPLIST_FILE`)?

**Why it matters:** If substitution didn't run, every bundle would ship literal `$(...)` strings — Sparkle version comparison and the About panel would both break.

**Resolution:** DECIDED (see [P02]) — this is the stock Xcode app-template pattern (new projects ship exactly `CFBundleShortVersionString = $(MARKETING_VERSION)` with a plain `INFOPLIST_FILE`). The Step 2 checkpoint proves it against a real build (`tests/build-info/test-info-plist.sh` asserts the built values) before any later step depends on it.

#### [Q02] Where does `update-rig` get its app? (DECIDED) {#q02-rig-app-source}

**Question:** The rig needs a complete, runnable Release bundle (Rust binaries + tugdeck dist assembled in — a bare `xcodebuild` product is not runnable). Build one, or extract one?

**Resolution:** DECIDED (see [P09]) — extract from `products/Tug.dmg` via `hdiutil`, building it first with `tugrust/scripts/build-app.sh --skip-notarize` when absent or when `--fresh` is passed. This reuses the one canonical bundle assembler instead of duplicating its steps, and works identically for signed and unsigned DMGs.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Missing/empty xcconfig yields a blank-version bundle | high | low | `build-app.sh` staged-plist guard ([P05]); `test-info-plist.sh` asserts | any bundle with empty `CFBundleShortVersionString` |
| Tag checkout ships a `detached-<sha8>` bundle identity | high | high without the fix | ancestor guard + `git checkout -B main` before the build (Spec S07 rung 4, #build-identity-on-tag-checkout); Step 6 asserts the built id | any change to `capture-build-info.sh` / `assign-bundle-id.sh` branch handling |
| Stale local tags fire 84 releases on a `git push --tags` | high | low | delete them (Step 6); `just release` pushes exactly one tag by name, never `--tags` ([P07]) | any accidental multi-tag push |
| `plugin.json` sed misses a format drift | med | low | `version.sh check` verifies the value after every write, so a silent miss becomes a loud failure | plugin.json reformatted |
| CI gate lengthens release runs (~10 min extra) | low | high | accepted — a stable release is rare and must not ship red ([P08]) | release cadence increases sharply |
| `cargo update --workspace` behavior changes across cargo versions | med | low | the lock-diff guard ([P04]) fails the bump rather than letting third-party movement through | guard fires on a legit bump |

**Risk R01: pbxproj hand-edit breaks the project file** {#r01-pbxproj-edit}

- **Risk:** The pbxproj is hand-maintained (synthetic `AA…` object IDs); a malformed edit makes Xcode reject the project.
- **Mitigation:** The edit is three small, specified changes (file ref, two `baseConfigurationReference` lines, four deletions) per Spec S03; the Step 2 checkpoint runs a real `xcodebuild` build immediately.
- **Residual risk:** None meaningful once a build succeeds.

**Risk R02: update-rig collides with the user's real installed Tug** {#r02-rig-collision}

- **Risk:** The rig clears Sparkle defaults for whatever bundle id its extracted app carries. Built from `main`, that id **is** `dev.tugtool.app` — the same domain a real installed Tug uses.
- **Mitigation:** The rig derives the domain from the extracted app's plist and prints it before clearing (Spec S06 rung 9), so the developer always sees which identity is affected; it requires an interactive terminal and is a rehearsal tool, not automation. Run from a dash worktree, the id is `dev.tugtool.app.release-<slug>` and a real installed copy is untouched.
- **Residual risk:** A rig run from a `main` checkout resets `SULastCheckTime` / `SUHasLaunchedBefore` for a real installed Tug — acceptable; both regenerate on its next launch and neither carries user data.

---

### Design Decisions {#design-decisions}

#### [P01] Cargo.toml is the source of truth; version.sh is the only writer (DECIDED) {#p01-single-writer}

**Decision:** `tugrust/Cargo.toml` `[workspace.package].version` is the definitive version. `tugrust/scripts/version.sh` is the only thing that writes it or any derived site, and `version.sh check` mechanically proves all sites agree.

**Rationale:**
- Cargo requires a literal in `Cargo.toml`; nothing can derive it at build time without codegen, so "one file everywhere" is impossible — "one writer + one checker" is the strongest achievable invariant.
- Drift (the stale `0.5.19`, the uncovered `plugin.json`) came from sites having no writer and no checker; closing both closes the class of bug.

**Implications:**
- Six declaration sites, all owned: `tugrust/Cargo.toml` (truth), `tugcode/package.json`, `tugdeck/package.json`, `.claude-plugin/plugin.json`, `tugapp/Version.xcconfig` (both values), and `tugapp/Info.plist` (as variable references only — see [P02]).
- Hand-editing a version anywhere becomes a `just version` / CI failure, not a latent bug.

#### [P02] Xcode versions flow through a generated Version.xcconfig (DECIDED) {#p02-xcconfig}

**Decision:** `version.sh` generates `tugapp/Version.xcconfig` (committed; two lines: `MARKETING_VERSION`, `CURRENT_PROJECT_VERSION`). It is wired as `baseConfigurationReference` on the Tug target's Debug and Release configurations. `Info.plist` holds `$(MARKETING_VERSION)` / `$(CURRENT_PROJECT_VERSION)`; the four literal `MARKETING_VERSION` / `CURRENT_PROJECT_VERSION` settings are deleted from the pbxproj.

**Rationale:**
- Zero version literals remain in any hand-edited Xcode file, which is what makes drift structurally impossible rather than merely checked.
- xcconfig regeneration is trivially scriptable; PlistBuddy-editing a checked-in plist on every bump (the current scheme) leaves the pbxproj literals live ammunition.

**Implications:**
- `version.sh` stops PlistBuddy-writing `tugapp/Info.plist` entirely.
- A missing xcconfig would blank the version — hence the [P05] build guard.
- The project has no xcconfig today and no `baseConfigurationReference` anywhere, so the wiring is purely additive (Spec S03).

#### [P03] CFBundleVersion stays `major*10000 + minor*100 + patch` (DECIDED) {#p03-bundle-version}

**Decision:** Keep the existing computed integer (0.8.0 → 800), emitted into `Version.xcconfig` as `CURRENT_PROJECT_VERSION`.

**Rationale:**
- Monotonic across semver bumps and derivable from the version alone — no CI history dependence (the `release.yml` header already records this rationale for rejecting run numbers).

**Implications:**
- `version.sh check` recomputes and verifies it; nightly's `TUG_BUILD_NUMBER` stamping of the *built* plist is unaffected.

#### [P04] Lockfile updates are workspace-scoped with a diff guard (DECIDED) {#p04-lockfile}

**Decision:** Replace `cargo generate-lockfile` in `version.sh` with `cargo update --workspace --offline`, followed by a guard that fails the bump if the `Cargo.lock` diff touches anything but workspace-member version lines.

**Rationale:**
- `generate-lockfile` discards and re-resolves the whole graph; measured on 2026-07-27: 149 third-party packages would move (including removals — `wit-bindgen` 0.51→0.57, `wasmparser` dropped). A version bump must never be a dependency bump.
- Measured with the replacement on a real 0.8.0→0.8.1 bump: 12 insertions, 12 deletions, every one a workspace crate's own `version =` line; zero third-party movement.
- `--offline` guarantees no registry fetch can sneak resolution changes in.

**Implications:**
- Guard per Spec S02: the `git diff -U0 tugrust/Cargo.lock` may contain only `+version =` / `-version =` lines (plus hunk headers); any `name`, `source`, `checksum`, or `dependencies` line change aborts with the diff printed.

#### [P05] Builds fail loudly on a blank or mismatched version (DECIDED) {#p05-build-guard}

**Decision:** `build-app.sh` asserts, after staging assembly and before nightly stamping, that the staged plist's `CFBundleShortVersionString` equals the workspace version and `CFBundleVersion` equals the computed integer; `tests/build-info/test-info-plist.sh` asserts the same on the Debug path.

**Rationale:**
- Under [P02], a missing xcconfig or broken substitution yields a blank version; without a guard, Sparkle would compare against nothing and the failure would surface at update time on a user's machine.

**Implications:**
- The guard runs before the nightly `TUG_BUILD_NUMBER` stamp (which legitimately rewrites both keys afterward).

#### [P06] Files are truth; the tag is the trigger (DECIDED) {#p06-tag-trigger}

**Decision:** `release.yml` gains `on: push: tags: ['v*']` (keeping `workflow_dispatch` as an escape hatch). The first guard: on tag-triggered runs, the tag must equal `v$(version.sh show)` at that SHA, or nothing builds. Releases are **main-ancestor-only**: the tag commit must be an ancestor of `origin/main`, and the tag checkout is rebranded to local `main` before the build so the bundle-identity build phases resolve `(release, main)` (see #build-identity-on-tag-checkout).

**Rationale:**
- Tag-as-truth would require CI to rewrite `Cargo.toml`, making `git checkout v0.8.1` describe itself as 0.8.0. Files-as-truth keeps every checkout honest; the guard keeps the tag honest.
- The tag pins exactly which bytes shipped, and re-releasing identical code under a new number (marketing renumber) is one mechanical bump commit + one tag.
- A tag checkout is a detached HEAD, and this repo derives its `CFBundleIdentifier` from the build-time branch ([D10]/[D19]). Rebranding is what keeps the shipped identity `dev.tugtool.app`; the ancestor guard is what makes the rebrand truthful rather than a spoof.

**Implications:**
- `workflow_dispatch` runs skip both tag guards (no tag ref) but keep the existing already-published rejection.
- A failed run re-runs from the Actions UI at the same tag.
- **Stable releases can only be cut from commits that are on `main`.** A tag on a side branch fails the ancestor guard before any build work.
- The checkout step needs full history (`fetch-depth: 0`) — the default shallow clone cannot answer `git merge-base --is-ancestor`.

#### [P07] `just release` pushes exactly one tag, by name (DECIDED) {#p07-single-tag}

**Decision:** `just release` creates and pushes `refs/tags/v<version>` explicitly; `--tags` is never used anywhere in the release path. The stale local `v*` tags are deleted (Step 6).

**Rationale:**
- With [P06], every `v*` tag push is a live trigger; 84 stale local tags were one `git push --tags` away from 84 release runs.

**Implications:**
- Tag deletion is repo-global (shared git common dir across worktrees) — flagged in Constraints and Step 6.

#### [P08] `release-prep` gates then bumps, and never commits; `ci` gates twice (DECIDED) {#p08-prep-never-commits}

**Decision:** `just release-prep` runs every guard and the full local gate (`just ci` + `bunx vite build`) against the *clean* tree, then bumps, prints the diff, and stops. The user commits and pushes. `release.yml` independently runs lint + tests before building.

**Rationale:**
- User decision (2026-07-27): prep does not commit — the bump diff deserves the user's eyes; committing is the user's act (consistent with the repo's git policy).
- User decision (2026-07-27): the ci gate runs both locally (fast feedback) and in CI (a tag pushed from anywhere can't ship red). Today `release.yml` runs zero tests.

**Implications:**
- Gate order in `release-prep`: cheap guards → expensive gates → bump last, so the tree stays clean while `ci` runs.

#### [P09] `update-rig` extracts its app from products/Tug.dmg (DECIDED) {#p09-rig-from-dmg}

**Decision:** `update-rig.sh` obtains its runnable Release bundle by mounting `products/Tug.dmg` (building it via `build-app.sh --skip-notarize` when absent or `--fresh`), then stages old/new copies per Spec S06.

**Rationale:**
- `build-app.sh` is the only canonical bundle assembler (Rust binaries, tugdeck dist, tmux, signing); duplicating its steps in the rig would drift. The DMG is its stable output regardless of signing mode.
- The quit-hardening [Q02] diagnosis proved the rig procedure end-to-end (ad-hoc-signed staged copy, localhost feed, `TUG_SPARKLE_FEED` override, both driver-delegate callbacks observed); this decision just packages it.

**Implications:**
- The rig ad-hoc re-signs *both* old and new copies so the code-signing identities match; EdDSA (login-Keychain key via `make-appcast.sh`'s local mode) covers authenticity.

---

### Deep Dives {#deep-dives}

#### Current version-declaration sites and their readers {#version-sites}

**Table T01: Version sites before → after** {#t01-version-sites}

| Site | Today (0.8.0 era) | After this plan | Writer |
|------|-------------------|-----------------|--------|
| `tugrust/Cargo.toml` `[workspace.package] version` | literal `0.8.0` | **source of truth** (literal, required by cargo) | `version.sh` |
| `tugrust/Cargo.lock` (12 workspace-member entries) | follows Cargo.toml | follows, via `cargo update --workspace --offline` | `version.sh` |
| `tugcode/package.json` | literal | written | `version.sh` (already) |
| `tugdeck/package.json` | literal | written | `version.sh` (already) |
| `.claude-plugin/plugin.json` | literal, **uncovered** | written | `version.sh` (new) |
| `tugapp/Info.plist` `CFBundleShortVersionString` / `CFBundleVersion` | literals `0.8.0` / `800` | `$(MARKETING_VERSION)` / `$(CURRENT_PROJECT_VERSION)` | nobody (static) |
| `tugapp/Version.xcconfig` | *does not exist* | `MARKETING_VERSION` + `CURRENT_PROJECT_VERSION` | `version.sh` (new) |
| `tugapp/Tug.xcodeproj/project.pbxproj` | stale `MARKETING_VERSION = 0.5.19`, `CURRENT_PROJECT_VERSION = 1` (×2 configs) | **deleted** | nobody |

Readers verified this session: `build-app.sh` reads `VERSION` from `tugrust/Cargo.toml` and the *staged* plist; `capture-build-info.sh` and `assign-bundle-id.sh` write the *built* plist (`$TARGET_BUILD_DIR/$CONTENTS_FOLDER_PATH/Info.plist`) — all downstream of Xcode substitution, so [P02] breaks none of them. `version.sh` is the only writer of the source plist today, and stops being one. `tugcode` does not read its package.json version at runtime (transcript `tugcodeVersion` values are data, not derived from the package).

#### Release flow end-to-end {#release-flow}

**Table T02: The release gesture** {#t02-release-flow}

| Actor | Step | What happens |
|-------|------|--------------|
| user | `just release-prep patch` | guards (Spec S04) → `just ci` + `bunx vite build` on the clean tree → `version.sh bump patch` → prints diff + next steps |
| user | review, commit, `git push` | the bump commit lands on `main` (user-only act) |
| user | `just release` | guards (Spec S05) → `git tag v<v>` → `git push origin refs/tags/v<v>` → waits on the CI run |
| CI | `release.yml` (tag push) | tag↔version guard → `version.sh check` → lint + tests → signed/notarized build → appcast → publish `v<v>` + `updates` |
| user | `just release-status` | latest runs, published releases, and what the live appcast advertises |

The existing `release.yml` safety net stays: the "Reject an already-published version" step (checks `Tug-$VERSION.zip` against the `updates` release assets) remains the last line of defense for both trigger paths.

#### Build identity on a tag checkout {#build-identity-on-tag-checkout}

This repo derives the shipped `CFBundleIdentifier` from the **branch present at build time**, so a detached checkout silently changes the product's identity. The chain, all of it real code that runs inside `xcodebuild`:

1. `actions/checkout` on a tag ref leaves a **detached HEAD**. (A `workflow_dispatch` run checks out branch `main`, which is why today's dispatch-only workflow never hits this.)
2. `tugrust/scripts/capture-build-info.sh` runs `git rev-parse --abbrev-ref HEAD`; on detached HEAD that returns `HEAD`, and the script substitutes `BuildBranch = detached-<sha8>`.
3. `tugrust/scripts/assign-bundle-id.sh` maps `(BuildProfile, BuildBranch)` per [D10]/[D19]. Only `(release, main)` yields `dev.tugtool.app`; anything else falls to the slug branch → `dev.tugtool.app.release-detached-<sha8>`.
4. `tugrust/scripts/sign-bundle.sh` signs with that id, baking it into the designated requirement.

Shipping that would hand every installed copy an "update" to a **different bundle identity** — breaking designated-requirement continuity and the TCC/Accessibility grant the whole identity scheme exists to preserve (`tuglaws/code-signing-mac.md`).

**The fix is `git checkout -B main HEAD` before the build**, guarded by an ancestor check so the local branch name is true rather than a spoof (Spec S07 rung 4). Two things this deliberately does *not* do:

- **Not `TUG_FORCE_BUNDLE_ID`.** That env var is the app-test path's hook; `capture-build-info.sh` keys `BuildProfile` off it (`${TUG_FORCE_BUNDLE_ID##*.}`), so forcing `dev.tugtool.app` would set `BuildProfile = "app"` and corrupt every downstream identity that reads the profile.
- **Not a `ref:` pin on `actions/checkout`.** Checking out `main` by name would build whatever `main` points at *now*, not the tagged commit — the tag would stop pinning the bytes, which is the entire point of [P06].

The same identity chain is why `update-rig.sh` must read its defaults domain from the extracted bundle (Spec S06 rung 9) instead of assuming `dev.tugtool.app`.

#### The update-rig lineage {#update-rig-lineage}

The procedure was performed by hand during the quit-hardening plan's [Q02] diagnosis (dash/quit-hardening.md): a release-configuration bundle, a staged version-bumped copy, ad-hoc re-signing, `ditto` zip, `make-appcast.sh` signing from the login Keychain, URL rewrite to localhost, `python3 -m http.server`, launch with `TUG_SPARKLE_FEED`, clearing `SULastCheckTime`/`SUHasLaunchedBefore` between runs. It proved the driver-delegate callbacks fire in release configuration and that only `appcast.xml` is fetched when the user defers. Spec S06 is that procedure, made repeatable. `UpdateController.swift` reads the override via `feedOverrideEnvVar = "TUG_SPARKLE_FEED"`.

---

### Specification {#specification}

**Spec S01: `version.sh` command surface** {#s01-version-sh}

```
version.sh show                     # print current version (unchanged)
version.sh set <M.m.p>              # write all sites, update lock, run check
version.sh bump major|minor|patch   # increment, then set
version.sh check                    # verify all sites agree; exit non-zero naming each disagreeing site
```

`do_set` becomes: validate format → sed `tugrust/Cargo.toml` → sed `tugcode/package.json` + `tugdeck/package.json` → sed `.claude-plugin/plugin.json` → write `tugapp/Version.xcconfig` (full-file rewrite from a heredoc) → `cargo update --workspace --offline` + lock guard (Spec S02) → run `check` → print the version. The PlistBuddy writes to `tugapp/Info.plist` are **removed**. Note `plugin.json` is single-line JSON with no space after the colon (`"version":"0.8.0"`) while the package.jsons have one (`"version": "0.8.0"`); the sed must handle both patterns or use one per file.

`check` verifies, reporting every failure (not just the first):
1. `tugrust/Cargo.toml` version matches `^[0-9]+\.[0-9]+\.[0-9]+$`.
2. `tugcode/package.json`, `tugdeck/package.json`, `.claude-plugin/plugin.json` versions all equal it.
3. `tugapp/Version.xcconfig` has `MARKETING_VERSION = <version>` and `CURRENT_PROJECT_VERSION = <computed>`.
4. `tugapp/Info.plist` `CFBundleShortVersionString` is literally `$(MARKETING_VERSION)` and `CFBundleVersion` is literally `$(CURRENT_PROJECT_VERSION)` (PlistBuddy `Print` returns the unsubstituted source values).
5. `tugapp/Tug.xcodeproj/project.pbxproj` contains no `MARKETING_VERSION` or `CURRENT_PROJECT_VERSION` lines.

**Spec S02: Cargo.lock diff guard** {#s02-lock-guard}

After `cargo update --workspace --offline`, run `git -C "$REPO_ROOT" diff -U0 -- tugrust/Cargo.lock` and assert every changed line (lines starting `+`/`-`, excluding `+++`/`---` file headers and `@@` hunk headers) matches `^[+-]version = "`. Any changed `name =`, `source =`, `checksum =`, or `dependencies` line means third-party movement: print the full diff, restore nothing (leave the tree for inspection), and exit 1. Measured baseline: a clean patch bump produces exactly 12 `+`/12 `-` version lines (the 12 workspace member entries).

**Spec S03: pbxproj + Info.plist wiring** {#s03-pbxproj}

Three edits to `tugapp/Tug.xcodeproj/project.pbxproj` (hand-maintained file with synthetic `AA…` object IDs — follow the existing ID style):

1. Add to the `PBXFileReference` section (alongside the `Info.plist` entry): a new reference with an unused ID (e.g. `AA0000020000000000000019`), `lastKnownFileType = text.xcconfig; path = Version.xcconfig; sourceTree = "<group>";`. Add its ID to the root `PBXGroup`'s `children` (the group whose children start with the `Info.plist` reference).
2. In the **two target-level** `XCBuildConfiguration` blocks — the ones containing `INFOPLIST_FILE = Info.plist` (target Debug and Release; *not* the project-level pair, which have no `INFOPLIST_FILE`) — add `baseConfigurationReference = AA0000020000000000000019 /* Version.xcconfig */;` immediately after `isa = XCBuildConfiguration;`.
3. Delete the `MARKETING_VERSION = 0.5.19;` and `CURRENT_PROJECT_VERSION = 1;` lines from both of those blocks (four lines total).

`tugapp/Info.plist`: replace the literal `CFBundleShortVersionString` string with `$(MARKETING_VERSION)` and `CFBundleVersion` with `$(CURRENT_PROJECT_VERSION)`.

`tugapp/Version.xcconfig` (initial content, thereafter regenerated by `version.sh`):

```
MARKETING_VERSION = 0.8.0
CURRENT_PROJECT_VERSION = 800
```

**Spec S04: `just release-prep <level-or-version>` guard ladder** {#s04-release-prep}

Argument: `major`|`minor`|`patch` (→ `version.sh bump`) or explicit `M.m.p` (→ `version.sh set`). In order, each failing with a named reason:

1. Current branch is `main`; working tree clean (`git status --porcelain` empty).
2. `git fetch origin` succeeds and HEAD equals `origin/main` (no unpushed/unpulled divergence — the bump must land on what CI will see).
3. `gh auth status` succeeds.
4. `gh secret list` contains `SPARKLE_ED_PRIVATE_KEY` (warn-and-continue if absent — the bump is still valid work; the release itself will hard-fail in CI, and the message says exactly that and how to set the secret).
5. Compute the target version; assert tag `v<target>` exists neither locally (`git tag -l`) nor on origin (`git ls-remote --tags origin`), and `Tug-<target>.zip` is not among the `updates` release assets (`gh release view updates --json assets`; a missing `updates` release passes).
6. `just ci` (lint + Rust + TS tests) on the clean tree.
7. `bunx vite build` in `tugdeck/` (per the standing rule: dev-esbuild-clean imports can still fail the production rollup).
8. `version.sh bump <level>` / `set <version>`.
9. Print `git diff --stat`, the new version, and next steps: *review the diff, commit (your act), `git push`, then `just release`*.

**Spec S05: `just release` and `just release-status`** {#s05-release}

`just release`:
1. Branch `main`, tree clean, `git fetch origin`, HEAD == `origin/main` (the tag must point at a pushed commit).
2. `version.sh check` passes; let `V=$(version.sh show)`.
3. Tag `v$V` exists neither locally nor on origin.
4. `git tag "v$V"` then `git push origin "refs/tags/v$V"` — exactly one tag, by name, never `--tags` ([P07]).
5. Poll `gh run list --workflow=release.yml --json databaseId,headSha,status` (up to ~90 s) for a run whose `headSha` equals the tag's commit; then `gh run watch <id> --exit-status` so the recipe's exit code is the release's.

`just release-status`:
1. Print `version.sh show` and the last 3 `release.yml` runs (`gh run list --workflow=release.yml --limit 3`).
2. Print `gh release view updates --json assets --jq '.assets[].name'` (or "no updates release yet").
3. `curl -fsSL https://github.com/tugtool/tugtool/releases/download/updates/appcast.xml` → print the advertised `sparkle:shortVersionString` / `sparkle:version` and whether `sparkle:edSignature` is present; a 404 prints "no feed published yet".

**Spec S06: `update-rig.sh`** {#s06-update-rig}

New file `tugrust/scripts/update-rig.sh`, wrapped by `just update-rig [fresh]`. Interactive rehearsal (requires a tty), rig dir `/tmp/tug-update-rig` (literal path — the hook environment rejects `rm -rf` on variable operands, so cleanup uses the literal):

1. Ensure `products/Tug.dmg` exists; build with `tugrust/scripts/build-app.sh --skip-notarize` if absent or if `fresh` was passed.
2. Mount the DMG read-only (`hdiutil attach -nobrowse -readonly`), copy `Tug.app` to the rig dir as the **old** app, detach.
3. Copy old → **new**; on the new copy, PlistBuddy-bump `CFBundleShortVersionString` to `<current>+patch` and `CFBundleVersion` to the corresponding computed integer.
4. Ad-hoc re-sign **both** copies (`codesign --force --deep -s -`) so their signing identities match ([P09]); EdDSA covers authenticity.
5. `ditto -c -k --keepParent` the new app → `Tug-<bumped>.zip` in a feed subdir.
6. `tugrust/scripts/make-appcast.sh <zip> <feed-dir>/appcast.xml` — no `SPARKLE_ED_PRIVATE_KEY` in the environment, so it signs from the login Keychain (its documented local mode).
7. `sed` the appcast's download URL prefix (`https://github.com/tugtool/tugtool/releases/download/updates/`) → `http://localhost:8000/`.
8. Serve the feed dir: `python3 -m http.server 8000` (background, PID recorded; killed on exit trap).
9. Print then clear Sparkle state. The defaults domain is **read from the extracted app**, never hardcoded:
   ```bash
   RIG_BUNDLE_ID="$(plutil -extract CFBundleIdentifier raw "$RIG_OLD_APP/Contents/Info.plist")"
   echo "==> clearing Sparkle state for $RIG_BUNDLE_ID"
   defaults delete "$RIG_BUNDLE_ID" SULastCheckTime 2>/dev/null || true
   defaults delete "$RIG_BUNDLE_ID" SUHasLaunchedBefore 2>/dev/null || true
   ```
   A DMG built from a dash worktree carries `(release, <branch>)` → `dev.tugtool.app.release-<slug>` per [D10]/[D19], **not** `dev.tugtool.app` — and implement runs on a dash worktree, so the literal would silently clear the wrong domain (see #build-identity-on-tag-checkout for the same identity chain on the CI side).
10. Launch the **old** app's binary directly with the override: `TUG_SPARKLE_FEED=http://localhost:8000/appcast.xml <rig>/old/Tug.app/Contents/MacOS/Tug`, foreground. The developer watches the update flow; Ctrl-C tears down (kills the server; rig dir left for inspection, removed on the next run).

The `NSAppTransportSecurity` localhost exception already in `Info.plist` permits the http:// feed.

**Spec S07: `release.yml` changes** {#s07-release-yml}

1. Trigger: add `push: tags: ['v*']` alongside the existing `workflow_dispatch`.
2. Checkout step: add `fetch-depth: 0`. The default shallow clone cannot answer `git merge-base --is-ancestor` (rung 4).
3. New step after "Read release version": **Verify the tag matches the tree** — if `github.ref_type == 'tag'`, assert `github.ref_name == "v$VERSION"`, else `::error` naming both and exit 1 ([P06]). Dispatch runs skip this.
4. New step, tag-triggered runs only: **Verify the tag is on main, and restore the branch identity** ([P06], #build-identity-on-tag-checkout):
   ```bash
   git fetch --no-tags origin main
   if ! git merge-base --is-ancestor HEAD origin/main; then
     echo "::error::Tag ${{ github.ref_name }} is not an ancestor of origin/main. Stable releases are cut from main only."
     exit 1
   fi
   git checkout -B main HEAD
   ```
   The rebrand must run **before** the build step, because `capture-build-info.sh` reads the branch at build time. Without it the detached checkout yields `BuildBranch = detached-<sha8>` and `assign-bundle-id.sh` stamps `dev.tugtool.app.release-detached-<sha8>`. Do **not** use `TUG_FORCE_BUNDLE_ID` for this — `capture-build-info.sh` would then derive `BuildProfile` from the forced id's last component (`"app"`) instead of `"release"`.
5. New step: run `tugrust/scripts/version.sh check` (the runner has no `just`; call the script directly).
6. Gate steps in the same job (cache reuse), after the bun cache and before the keychain step: install `cargo-nextest` (`taiki-e/install-action@v2` with `tool: nextest`); `bun install --frozen-lockfile` in `tugdeck/` and `tugcode/`; then `cargo clippy --workspace --all-targets -- -D warnings`, `cargo fmt --all -- --check`, `cargo nextest run --workspace` (all in `tugrust/`), `bun test` in `tugdeck/` and `tugcode/` — mirroring the `just ci` recipe ([P08]).
7. Everything from the keychain step on is unchanged, including the already-published rejection.

**Spec S08: Justfile version recipes** {#s08-just-version}

- `just version`: `tugrust/scripts/version.sh show` then `…/version.sh check` (prints the version; exits non-zero on drift).
- `just version-set <M.m.p>` / `just version-bump <level>`: thin wrappers over `version.sh set` / `bump`. Comment blocks note these change files without committing.
- Placement: a new "Release surface" section after the `notarize` recipe, using the repo's comment-block style (`#!/usr/bin/env bash` + `set -euo pipefail` bodies, like `dmg-background`).

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tugapp/Version.xcconfig` | The two Xcode version settings; generated by `version.sh`, committed |
| `tugrust/scripts/update-rig.sh` | Local Sparkle feed rehearsal (Spec S06) |

#### Symbols / files to modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `do_set`, `do_bump`, new `do_check` | bash fn | `tugrust/scripts/version.sh` | Spec S01; drop PlistBuddy, add plugin.json + xcconfig + lock guard |
| `bundle_version` | bash fn | `tugrust/scripts/version.sh` | unchanged, reused by `check` and xcconfig emission |
| target Debug/Release configs | pbxproj | `tugapp/Tug.xcodeproj/project.pbxproj` | Spec S03: base config ref + literal deletion |
| `CFBundleShortVersionString`, `CFBundleVersion` | plist keys | `tugapp/Info.plist` | become `$(MARKETING_VERSION)` / `$(CURRENT_PROJECT_VERSION)` |
| staged-plist guard | bash | `tugrust/scripts/build-app.sh` | [P05]; before the `TUG_BUILD_NUMBER` stamping block |
| version asserts | bash | `tests/build-info/test-info-plist.sh` | built plist version == Cargo.toml version, non-empty |
| `version`, `version-set`, `version-bump`, `release-prep`, `release`, `release-status`, `update-rig` | recipes | `Justfile` | Specs S04, S05, S08 |
| triggers + guards + gate | workflow | `.github/workflows/release.yml` | Spec S07 |

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Round-trip (scratch bump)** | Prove `version.sh set/bump/check` writes every site and only those sites | Step 1/2 checkpoints: bump to a scratch version, `check`, inspect `git diff`, restore with `git checkout` |
| **Real-build assertion** | Prove Xcode substitution + guards against a real bundle | `tests/build-info/test-info-plist.sh` (existing harness, extended) |
| **Guard refusal** | Prove each recipe guard fires with its named message | Step 8: drive `release` / `release-prep` in deliberately bad states |
| **Rig end-to-end** | Prove `update-rig` reaches a live feed + launched app | Step 7 checkpoint, interactive |

#### What stays out of tests {#test-non-goals}

- No mocked `gh`, no fake GitHub API, no simulated workflow runs — banned-pattern-adjacent and low value; the workflow guard logic is plain bash verified by reading and by the first real release.
- No automated live-fire of `release.yml` — cutting a release is the user's act and needs the `SPARKLE_ED_PRIVATE_KEY` secret; the tag↔version guard is exercised the first time the user releases.
- No app-test — nothing here touches the deck or app behavior at runtime (the rig is an interactive developer tool, not a test).

---

### Execution Steps {#execution-steps}

> **Commit after all checkpoints pass.** This rule applies to every step below.

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | version.sh rework + Xcode version plumbing | pending | — |
| #step-2 | Build-time version guards | pending | — |
| #step-3 | Justfile version recipes | pending | — |
| #step-4 | `just release-prep` | pending | — |
| #step-5 | `just release` + `just release-status` | pending | — |
| #step-6 | release.yml: tag trigger, guards, ci gate + tag hygiene | pending | — |
| #step-7 | update-rig script + recipe | pending | — |
| #step-8 | Integration checkpoint | pending | — |

#### Step 1: version.sh rework + Xcode version plumbing {#step-1}

**Commit:** `release(version): single-writer version.sh, xcconfig-fed Xcode versions, workspace-scoped lock update`

**References:** [P01] single writer, [P02] xcconfig, [P03] bundle version, [P04] lockfile, Spec S01, Spec S02, Spec S03, Table T01, (#version-sites)

**Artifacts:**
- Reworked `tugrust/scripts/version.sh` (plugin.json coverage, xcconfig emission, `check` subcommand, lock guard, no plist writes)
- New `tugapp/Version.xcconfig`; converted `tugapp/Info.plist`; cleaned `tugapp/Tug.xcodeproj/project.pbxproj`

**Tasks:**
- [ ] Rework `version.sh` per Spec S01 (including the plugin.json sed-format note) and Spec S02.
- [ ] Create `tugapp/Version.xcconfig` with the current version's values per Spec S03.
- [ ] Convert `tugapp/Info.plist`'s two version keys to variable references per Spec S03.
- [ ] Make the three pbxproj edits per Spec S03.
- [ ] Re-verify no other script PlistBuddy-writes the *source* plist (`grep -rn "tugapp/Info.plist" tugrust/scripts/`).

**Tests:**
- [ ] Scratch round-trip: `version.sh bump patch` → `version.sh check` exits 0 → `git diff --stat` lists exactly `tugrust/Cargo.toml`, `tugrust/Cargo.lock`, `tugcode/package.json`, `tugdeck/package.json`, `.claude-plugin/plugin.json`, `tugapp/Version.xcconfig` → lock diff is version-lines-only → restore all six with `git checkout --`.
- [ ] Negative: hand-edit `tugdeck/package.json` to a wrong version → `check` exits non-zero naming that file → restore.

**Checkpoint:**
- [ ] `tugrust/scripts/version.sh check` exits 0 on the restored tree.
- [ ] `grep -c "MARKETING_VERSION\|CURRENT_PROJECT_VERSION" tugapp/Tug.xcodeproj/project.pbxproj` → `0`; same grep on `tugapp/Version.xcconfig` → `2`.
- [ ] `xcodebuild -project tugapp/Tug.xcodeproj -scheme Tug -configuration Debug build` succeeds (proves the pbxproj still parses and the xcconfig wires in; resolves [Q01] in the built product checked next step).

---

#### Step 2: Build-time version guards {#step-2}

**Depends on:** #step-1

**Commit:** `release(version): staged-plist version guard in build-app.sh + built-plist asserts`

**References:** [P05] build guard, [Q01] plist substitution, Spec S03, (#version-sites)

**Artifacts:**
- Guard block in `tugrust/scripts/build-app.sh`; version asserts in `tests/build-info/test-info-plist.sh`

**Tasks:**
- [ ] In `build-app.sh`, immediately before the `TUG_BUILD_NUMBER` stamping block, assert the staged plist's `CFBundleShortVersionString` is non-empty and equals `$VERSION`, and `CFBundleVersion` equals `major*10000 + minor*100 + patch`; fail with both values printed.
- [ ] Extend `tests/build-info/test-info-plist.sh` to assert the built plist's `CFBundleShortVersionString` equals the `tugrust/Cargo.toml` version and is not a literal `$(…)` string.

**Tests:**
- [ ] `bash tests/build-info/test-info-plist.sh` passes (this is the [Q01] proof: real build, substituted values).

**Checkpoint:**
- [ ] `bash tests/build-info/test-info-plist.sh` exits 0 and its output shows the real version, not `$(MARKETING_VERSION)`.

---

#### Step 3: Justfile version recipes {#step-3}

**Depends on:** #step-1

**Commit:** `release(just): version / version-set / version-bump recipes`

**References:** [P01] single writer, Spec S08, (#release-flow)

**Artifacts:**
- `version`, `version-set`, `version-bump` recipes in a new "Release surface" Justfile section

**Tasks:**
- [ ] Add the three recipes per Spec S08, with comment blocks in the repo's style.

**Tests:**
- [ ] `just version` prints the version and exits 0; after a scratch hand-edit of `.claude-plugin/plugin.json` it exits non-zero; restore.

**Checkpoint:**
- [ ] `just version` exits 0 on the clean tree.

---

#### Step 4: `just release-prep` {#step-4}

**Depends on:** #step-3

**Commit:** `release(just): release-prep — gate ladder + bump, never commits`

**References:** [P08] prep never commits, Spec S04, Table T02, (#release-flow)

**Artifacts:**
- `release-prep` recipe implementing the Spec S04 ladder

**Tasks:**
- [ ] Implement the nine-rung ladder exactly per Spec S04, each failure naming its rung; the secret check warns-and-continues.
- [ ] Final output: `git diff --stat`, the new version, and the three next steps (review/commit/push → `just release`).

**Tests:**
- [ ] With a deliberately dirty tree, `just release-prep patch` refuses at rung 1 without running `ci`.
- [ ] On the clean tree: full run through the bump, then restore the six files with `git checkout --`.

**Checkpoint:**
- [ ] Both tests above behave as specified (the clean run's gate legitimately takes minutes — `just ci` + `bunx vite build`).

---

#### Step 5: `just release` + `just release-status` {#step-5}

**Depends on:** #step-3

**Commit:** `release(just): release — single-tag push + run watch; release-status`

**References:** [P06] tag trigger, [P07] single tag, Spec S05, Table T02

**Artifacts:**
- `release` and `release-status` recipes

**Tasks:**
- [ ] Implement both per Spec S05. `release` never uses `--tags`; the push is `refs/tags/v$V` by name.
- [ ] `release-status` degrades gracefully: missing `updates` release and 404 appcast each print a plain "not yet" line, exit 0.

**Tests:**
- [ ] `just release` on a HEAD that diverges from `origin/main` (e.g. one local scratch commit on a temp branch, or by asserting against a fabricated compare) refuses at the pushed-HEAD rung without creating any tag; `git tag -l` unchanged.
- [ ] `just release-status` runs green today, reporting the nightly-only state ("no updates release yet" / "no feed published yet").

**Checkpoint:**
- [ ] Refusal test above leaves zero new tags locally and on origin.
- [ ] `just release-status` exits 0.

---

#### Step 6: release.yml — tag trigger, guards, ci gate + tag hygiene {#step-6}

**Depends on:** #step-1

**Commit:** `release(ci): tag-triggered stable release with tag↔version guard and test gate`

**References:** [P06] tag trigger, [P07] single tag, [P08] ci gates twice, Spec S07, (#release-flow)

**Artifacts:**
- Modified `.github/workflows/release.yml`; deleted stale local tags

**Tasks:**
- [ ] Apply the seven Spec S07 changes, including `fetch-depth: 0` and the ancestor-guard + `git checkout -B main HEAD` step placed **before** the build step.
- [ ] **Tag hygiene (repo-global; flagged in #constraints — user may veto):** delete all local `v*` tags (`git tag -l 'v*' | xargs git tag -d`; ~84, all unpushed — verified `git ls-remote --tags origin` shows only `nightly`). Do **not** touch the `nightly` tag or anything on origin.
- [ ] Update the `release.yml` header comment to document the tag trigger, the files-are-truth rule, and the main-ancestor-only + rebrand requirement (cite #build-identity-on-tag-checkout).

**Tests:**
- [ ] `actionlint` (if installed) or `gh workflow view` parses the workflow; otherwise a YAML parse via `python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/release.yml'))"`.
- [ ] **Identity-trap proof, in a throwaway clone so no live worktree is touched:** `git clone --no-hardlinks . /tmp/tug-tagcheck` → `git -C /tmp/tug-tagcheck checkout --detach HEAD` → assert `git rev-parse --abbrev-ref HEAD` prints `HEAD` (the trap: `capture-build-info.sh` would derive `detached-<sha8>`) → `git -C /tmp/tug-tagcheck checkout -B main HEAD` → assert it now prints `main` (the fix). Remove `/tmp/tug-tagcheck` (literal path).
- [ ] Ancestor guard: in that same clone, `git merge-base --is-ancestor HEAD origin/main` exits 0 for the cloned HEAD; a commit made on a scratch branch off an older base exits non-zero.
- [ ] Read-through: the tag guard step references `github.ref_type`/`github.ref_name`; the rebrand step precedes "Build signed DMG and update archive"; the gate steps mirror `just ci`'s commands exactly (`lint` + `test-rust` + `test-ts` recipe bodies).

**Checkpoint:**
- [ ] Workflow file parses; both identity-trap assertions above hold; `git tag -l 'v*'` prints nothing; `git ls-remote --tags origin` still shows only `nightly`.

---

#### Step 7: update-rig script + recipe {#step-7}

**Depends on:** #step-1

**Commit:** `release(rig): update-rig — one-command local Sparkle rehearsal`

**References:** [P09] rig from dmg, [Q02] rig app source, Spec S06, (#update-rig-lineage)

**Artifacts:**
- New `tugrust/scripts/update-rig.sh`; `update-rig` Justfile recipe

**Tasks:**
- [ ] Implement Spec S06 end-to-end, exit trap killing the feed server, literal `/tmp/tug-update-rig` paths for cleanup.
- [ ] Rung 9 reads `CFBundleIdentifier` from the extracted app and echoes it before clearing — no hardcoded `dev.tugtool.app` anywhere in the script (Risk R02, #build-identity-on-tag-checkout).
- [ ] Recipe comment documents prerequisites (login-Keychain Sparkle key, Developer ID for the initial DMG build) and the R02 caveat, stating that the domain cleared depends on the branch the DMG was built from.

**Tests:**
- [ ] Interactive run: `just update-rig` from an existing `products/Tug.dmg` (or a fresh `--skip-notarize` build) reaches a running old-version app; the served `appcast.xml` advertises the bumped version with an `edSignature`; the app's update check hits `GET /appcast.xml` in the server log.
- [ ] The bundle id the rig prints matches `plutil -extract CFBundleIdentifier raw` on the extracted app — and, when run from a dash worktree, is the `dev.tugtool.app.release-<slug>` form rather than the bare distribution id.

**Checkpoint:**
- [ ] The interactive run above: app launches, feed serves, update offer appears (or the gentle-reminder bulletin path engages, matching the quit-hardening [Q02] observations).
- [ ] `grep -c 'dev\.tugtool\.app' tugrust/scripts/update-rig.sh` → `0`.

---

#### Step 8: Integration Checkpoint {#step-8}

**Depends on:** #step-2, #step-4, #step-5, #step-6, #step-7

**Commit:** `N/A (verification only)`

**References:** [P01]–[P09], Specs S01–S08, (#success-criteria, #release-flow)

**Tasks:**
- [ ] Walk every Success Criteria bullet and record the verifying command + result in the plan.
- [ ] One full local dress rehearsal: `just release-prep patch` end-to-end (gates + bump) → inspect the diff → restore; `just release` refusal on the un-pushed state; `just version` green; `just release-status` green.

**Tests:**
- [ ] All step-level tests re-run green after the final state (at minimum: `version.sh check`, `test-info-plist.sh`, `just version`).

**Checkpoint:**
- [ ] Every #success-criteria bullet verified or explicitly recorded as user-deferred (the live tag-triggered release).

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** A locked version model (one truth, one writer, one checker, zero Xcode literals) and a complete `just`-driven release gesture — `release-prep` → user commit/push → `release` → tag-triggered gated CI → `release-status` — plus a one-command local Sparkle rehearsal rig.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] All #success-criteria bullets pass their stated verifications.
- [ ] `just --list` shows the seven new recipes with one-line docs.
- [ ] The quit-hardening-era by-hand rig procedure is fully captured in `update-rig.sh` (nothing lives only in a transcript).

**Acceptance tests:**
- [ ] Step 8's dress rehearsal transcript recorded in the Step Status Ledger notes.

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] **The first stable release** — user's act: set `SPARKLE_ED_PRIVATE_KEY` (`gh secret set`), run `just release-prep patch`, commit, push, `just release`. This live-fires the tag guard and the whole pipeline for the first time.
- [ ] Release notes in the appcast (`resources/release-notes/<version>.md` → `generate_appcast` description embedding) — the follow-on updater-experience plan.
- [ ] Notarized stable-identity update consent pass (carried from dash/quit-hardening.md).
- [ ] Nightly Sparkle channel, if ever wanted.

| Checkpoint | Verification |
|------------|--------------|
| Version model locked | `version.sh check`; pbxproj grep = 0; scratch-bump diff = exactly six files |
| Builds guarded | `test-info-plist.sh`; `build-app.sh` guard present before stamping |
| Release gesture complete | Step 8 dress rehearsal |
| Shipped identity preserved on tag builds | Step 6 throwaway-clone detached→`main` proof; rebrand step precedes the build step |
| Rig captured | `just update-rig` interactive run |
