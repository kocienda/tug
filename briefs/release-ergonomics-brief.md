<!-- brief-skeleton v1 -->

# Release ergonomics

**Purpose:** Tug's release pipeline is complete and lives entirely in CI, but nothing local connects a version bump to the button that ships it — so the steps between are held in the user's head, and the one that gets skipped is writing the release notes. Give the pipeline a `just` surface, and give it a blessing gate that answers "would I be happy to have shipped this?" before anything is dispatched.

---

## Purpose {#purpose}

The ask, after walking the pipeline together: *"Help me to get (back) up to speed with how I make a release, bump the version number of the app and its components, and then experience how I get the update notification in the app. Start by giving me a breakdown of the workflow I need to use, and how I might think about putting together a repeatable set of steps I can use to **bless** a release and then make one. I think we already have some `just` commands, but I want to build out the support and ease-of-use here."*

The non-modal update work has just landed (`b8d3043e2`), so an update now announces itself as a pill and a popover rather than a Sparkle window. That raises the value of actually cutting releases, and it raises the cost of cutting a bad one: the popover renders the release notes in front of the user, where an unwritten changelog is visible rather than merely absent.

---

## Evidence {#evidence}

**[F01] The release pipeline is complete and runs in CI** — `.github/workflows/release.yml` is `workflow_dispatch`-only and does the whole job: reads the version from `tugrust/Cargo.toml`, refuses a version already published, builds an ephemeral keychain, runs `tugrust/scripts/build-app.sh` to produce a signed and notarized `products/Tug.dmg` plus the stapled `products/Tug-<version>.zip`, runs `tugrust/scripts/make-appcast.sh` over that zip with the Sparkle EdDSA key, and publishes two tags from one run — `v<version>` carrying the DMG for first-install, and a rolling `updates` tag carrying every archive plus `appcast.xml`. `SUFeedURL` in `tugapp/Info.plist` points at the rolling tag, so the URL baked into every build never moves. **(verified)**

**[F02] Every credential the workflow needs is already configured** — `gh secret list` shows all seven: `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_ID`, `APPLE_TEAM_ID`, `DEVELOPER_ID_NAME`, `NOTARY_PASSWORD`, `SPARKLE_ED_PRIVATE_KEY`. Nothing is blocked on provisioning. **(verified)**

**[F03] No stable release has ever been published** — `gh release list` returns exactly one row, `nightly`. There is no `updates` tag and no `v*` tag. The consequence is structural rather than incidental: Sparkle offers an update only when a newer `CFBundleVersion` appears in a feed an already-installed app is polling, so the first `Stable Release` run **seeds** the feed and notifies nobody. Seeing the pill from the real feed takes two published releases and an install of the first. **(verified)**

**[F04] There is no local `just` surface for any of it** — `just --list` carries `notarize`, `dmg`, `lab-dmg` and the `lab-*` VM recipes, and **zero** recipes named for version, release, appcast, or blessing. The version bump is a bare script path to remember (`tugrust/scripts/version.sh bump patch`), appcast generation is another (`tugrust/scripts/make-appcast.sh`), and the release itself is a button on github.com. Nothing connects them. **(verified)**

**[F05] `release-notes/0.8.0.md` is still the seeded stub, and nothing checks** — `0.8.0` is the current version across `tugrust/Cargo.toml`, both `package.json` files and `tugapp/Info.plist`, and its notes file holds a heading and an instructional HTML comment. `tugrust/scripts/version.sh` seeds the file on every `set`/`bump` and never overwrites one; `release-notes/README.md` states that filling it in is a person's job. Neither `make-appcast.sh` nor `release.yml` distinguishes a stub from real notes — a release today embeds the placeholder in the appcast and the popover renders it. **(verified)**

**[F06] The only pre-release guard is server-side and arrives late** — `release.yml`'s "Reject an already-published version" step greps the `updates` release's assets for `Tug-<version>.zip` and fails the run. It is the right check in the wrong place: it fires after the workflow has been queued, and it is the *only* thing standing between a dispatch and a bad release. Nothing verifies a clean tree, that `HEAD` is on `main`, that `HEAD` is pushed, or that CI is green on the commit about to be built. CI builds from the checked-out ref, so an unpushed bump releases the wrong bytes with no complaint. **(verified)**

**[F07] The local rehearsal loop works and is four manual steps around a script that does the hard part** — `tests/update/local-appcast.sh <app> [port]` clones a built bundle, bumps its version to `<version>-local`, re-signs inside-out through `tugrust/scripts/sign-bundle.sh`, archives it, generates a signed appcast carrying `tests/update/local-release-notes.md`, rewrites the enclosure URL to `127.0.0.1`, and serves it — then prints the `TUG_SPARKLE_FEED` launch line. The friction is around it: the script takes an app path the user has to dig out of DerivedData, `just app-release` has already launched the bundle that now needs quitting and relaunching under the env var, and nothing names which build to point it at. **(verified)**

**[F08] The re-sign in the rehearsal loop is load-bearing, not hygiene** — `generate_appcast` runs Apple's code-signing checks over a whole bundle before it will put the archive in a feed, and rewriting `Info.plist` breaks the seal. `local-appcast.sh` therefore needs a Developer-ID-signed input; `just app-release` supplies one, because it calls `sign-bundle.sh` after `xcodebuild`. That build also rewrites the bundle identifier from the cwd, so it is not `dev.tugapp.app` — which does not matter, because `TUG_SPARKLE_FEED` bypasses the bundle-identity gate in `UpdateController`. **(verified)**

**[F09] `CFBundleVersion` is derived, monotonic, and deliberately not a CI counter** — `version.sh` computes `major*10000 + minor*100 + patch`, so `0.8.0` is `800`. `release.yml` documents why it does not set `TUG_BUILD_NUMBER` the way `nightly.yml` does: Sparkle compares `CFBundleVersion`, and a CI run number would make update ordering depend on CI history rather than on the tag. **(verified)**

---

## Decisions {#decisions}

**[B01] Six recipes, each a thin wrapper over machinery that already exists.** `version`, `version-bump`, `release-notes`, `bless`, `release`, `update-rehearse`, plus `appcast` for the rare local feed generation. Nothing here reimplements a build, a signature, a notarization, or a feed — `build-app.sh`, `make-appcast.sh`, `version.sh`, `sign-bundle.sh` and `local-appcast.sh` are all correct and stay the implementations. What is being built is the surface that makes them findable and connects them in the order a release actually goes. A recipe that grew logic of its own would be a second release path to keep in agreement with the first.

**[B02] `bless` is local, read-only, and fast.** It never builds, never signs, never pushes, and never takes more than a few seconds. Everything it checks is something CI either cannot check or checks too late to be useful [F06]. That constraint is what makes it a habit rather than a ceremony: a gate that took twenty minutes would be run once and then skipped, which is the state the pipeline is in today.

**[B03] What `bless` checks, and what it prints.** The version reads consistently across `tugrust/Cargo.toml`, `tugcode/package.json`, `tugdeck/package.json` and `tugapp/Info.plist` (both `CFBundleShortVersionString` and the derived `CFBundleVersion` [F09]); a notes file exists for that version and is neither empty nor the seeded stub [F05]; the working tree is clean; `HEAD` is on `main`; `HEAD` is pushed and equal to `origin/main`; no `v<version>` tag and no `Tug-<version>.zip` asset already exist on the remote [F06]; and CI is green on `HEAD`. On success it prints the release it is blessing — version, bundle version, commit, and a preview of the notes — so the last thing seen before a dispatch is the thing being shipped. On failure it names exactly what is wrong and exits non-zero.

**[B04] The stub check is a real check, not a length heuristic.** `version.sh`'s seed is a known string — a `# Tug <version>` heading and the instructional HTML comment it writes. `bless` fails a notes file that still contains that comment, or that has no prose outside the heading. This is the single check with the most value in it [F05], and it is the one a word-count rule would get wrong in both directions.

**[B05] `just release` dispatches the CI workflow; it does not release locally.** It runs `bless`, confirms, then `gh workflow run` on `release.yml` and follows with `gh run watch`. CI is the reproducible path and the one whose credential handling has been thought about [F01] [F02]; a second local path would be a second thing to keep correct, and its only advantage — cutting a release while Actions is down — is a contingency that has never arisen and can be met by running the scripts by hand, which is what today already is. Revisit if Actions availability becomes a real constraint rather than a hypothetical one.

**[B06] `bless` blocks inside `just release`, with a `--force` escape.** A gate that warns is a gate that is read past. The escape exists because a checklist this young will be wrong about something, and the right answer to a wrong check is to ship anyway and fix the check — not to delete the gate. `just bless` on its own stays a pure query, so the escape is only ever needed on the composed gesture.

**[B07] `update-rehearse` is the loop that matters first, and it resolves its own paths.** One command: build a signed Release bundle if one is not current, resolve its path rather than asking for it, stand up the local feed through `local-appcast.sh`, and print or run the `TUG_SPARKLE_FEED` launch [F07] [F08]. This is the only way to see the pill before two releases exist [F03], so it is what turns the just-landed update work from something that passed its tests into something that has been watched.

**[B08] `version-bump` ends by saying what to write next.** The seeded notes file is the step that gets skipped [F05], so the bump names the path it just created and says the release is not ready until it is written. `release-notes` opens that file in `$EDITOR`. The two recipes and `bless`'s stub check are three reinforcements of one thing, deliberately, because it is the failure this whole brief is most concerned with.

**[B09] The recipes stay in the `Justfile` and claim nothing about the standalone contract.** This is checkout-only machinery — it reads `tugrust/scripts/`, `.github/workflows/`, and the repository's own remote. Nothing here belongs in `tugplug/`, and `just tugplug-lint` is not in question.

---

## Open Questions {#open-questions}

- **Should `bless` require CI green on `HEAD`, or merely report it?** Reporting is the softer default and avoids a release blocked on an unrelated flaky job; requiring it is the stricter reading of "would I be happy to have shipped this." The answer depends on how reliably `ci.yml` passes on `main` today, which a few runs of `gh run list` over recent history would settle better than an argument.

- **What does `update-rehearse` do about the already-running instance?** `just app-release` builds *and* launches, so the bundle the rehearsal wants is one the user must quit before relaunching under `TUG_SPARKLE_FEED` [F07]. Whether the recipe should quit it (through `quit-tug-bundle.sh`, which the repository already has), build without launching, or simply print the instruction, is a call about how much a convenience recipe should be allowed to do to a running app.

---

## Non-goals {#non-goals}

- **A local end-to-end release path.** [B05] — a second implementation of signing, notarizing, appcast generation and asset upload, kept in agreement with the CI one. The scripts are already runnable by hand for the contingency this would serve.

- **Changing `release.yml`, `build-app.sh`, `make-appcast.sh` or `version.sh`.** [B01] — the pipeline is correct. The one thing a recipe might be tempted to fix in CI is the late arrival of the already-published check [F06], and `bless` answers that locally instead, which is better placed and costs nothing in the workflow.

- **A stub guard in CI.** The notes check belongs where it can be acted on in five seconds [B02]. Adding it to `release.yml` as well would fail a run forty minutes in to tell the user something `bless` said before they pressed anything.

- **A nightly update feed.** `UpdateController` records that the nightly identity has no feed of its own, and `nightly.yml` publishes no appcast. Giving the nightly channel self-update is separate work with its own questions about channel selection, and nothing here depends on it.

- **Automating the release notes from the commit log.** `release-notes/README.md` already decided this: the notes are addressed to someone who does not read this repository. The recipes make writing them easy to reach and hard to forget; they do not write them.

- **A tag-triggered release.** `release.yml` is `workflow_dispatch` on purpose, and a push-to-tag trigger would move the decision to ship into a `git push` — the opposite of what a blessing gate is for.

---

## Exit {#exit}

**An arc.** The work has a natural order, and the first piece is the one with the most value in it:

1. `bless`, built first and run against `0.8.0` as it stands — it should immediately report the stub [F05], which is the one thing genuinely between the current tree and a release.
2. `version`, `version-bump` and `release-notes` — the small surface around the bump, including the "write this next" hand-off [B08].
3. `update-rehearse` — the loop that lets the just-landed pill be watched without publishing anything [B07] [F03].
4. `release` — `bless`, confirm, `gh workflow run`, `gh run watch` [B05] [B06].
5. `appcast` — the thin wrapper, last, because it is the rarest.

Each recipe is independently useful the moment it exists, so there is no integration step waiting at the end. The proof that the set works is the user's own: cut `0.8.0`, install it, bump to `0.8.1`, cut that, and watch the pill arrive.
