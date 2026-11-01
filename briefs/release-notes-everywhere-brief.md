# Release Notes Everywhere

**Purpose:** Tug writes release notes for every version and shows them in only one place, the update popover. The notes should be good, and they should be readable on the GitHub release page, from the site's index page, and from inside the app.

---

## Purpose {#purpose}

As asked: "We need better release notes in our release page on github. Need to link to that right next to the System requirements link on the index page. We need to build release notes into the app (let's make a new Help menu option in the app that opens a text/markdown card). Of course, we *have* these release notes... we're just not showing them and integrating them in all the places we should."

And then, on the content: "Can we *retroactively go back* and add better, more relevant and complete release notes for the whole 0.8.X series? I see no reason why we couldn't. The content is all there in git."

Separately, the stated minimum macOS version disagrees with itself. The user settled the fact: "The minimum supported version is Sequoia. We support that, and Tahoe, and Golden Gate. Please make the macOS version numbers come out right."

---

## Evidence {#evidence}

**[F01] `release-notes/<version>.md` has one reader today.** `tugrust/scripts/make-appcast.sh` embeds the file in the appcast, and the update popover renders it. Nothing else reads it. `release-notes/README.md` describes this path. **(verified)**

**[F02] Every GitHub release shows boilerplate instead of notes.** `.github/workflows/release.yml` hardcodes the `body:` of the versioned release to the install lines plus `Built from commit <sha>`. `gh release view v0.8.22` shows exactly that. The 23 published `v0.8.*` releases carry no notes. **(verified)**

**[F03] `Built from commit <sha>` is load-bearing.** `built_from()` in `scripts/release.py` parses that line out of the release body to find what a release was built from. Any new body has to keep it. **(verified)**

**[F04] The site's index page has no notes link.** It lives in a separate repository: `/u/src/tug-site/src/pages/tug/index.astro:201` holds the System requirements button, beside the `Version · date` line, and `SITE.releases` in `src/lib/site.ts` already holds `https://github.com/kocienda/tug/releases`. In this repository, `README.md` has "See all releases" under Download; its "System requirements" is a heading, not a link. **(verified)**

**[F05] The help card already does what a notes card needs.** `HelpDoc` in `tugrust/crates/tugcast/src/help_docs.rs` names three documents, served at `GET /api/help/{name}` and rendered read-only in `tugdeck/src/components/tugways/cards/help-card.tsx`, with Find and anchors, one card per document (`tugdeck/src/lib/open-help-in-card.ts`). The Help menu items are in `tugapp/Sources/MenuBarBuilder.swift:800-808`, and `show-card` with a `help` component is in `tugdeck/src/action-dispatch.ts:1370`. **(verified)**

**[F06] `HelpDoc::ALL` also feeds the Operator and the semantic index.** It is read in `tugrust/crates/tugcast/src/feeds/operator.rs:2370` and `:2459` and in `tugrust/crates/tugcast/src/semantic/ingest.rs:305`. `help_outline` in `operator.rs` matches per document, and `operator.rs:7437` asserts "only the three documents". The "exactly three" wording is also in `help_docs.rs:4` and `docs/glossary.md:81`. Tests naming the menu items are `tugapp/TugTests/MenuBarBuilderTests.swift` and `tests/app-test/at0758-help-menu-opens-help-cards.test.ts`. **(verified)**

**[F07] Help documents reach the bundle through an Xcode phase.** The shell script in `tugapp/Tug.xcodeproj/project.pbxproj` copies `docs/features.md`, `recipes.md` and `glossary.md` to `Contents/Resources/docs/`, and fails the build if one is missing. `tugrust/crates/tugcast/src/resources.rs` resolves that directory, falling back to the checkout's `docs/`. **(verified)**

**[F08] Someone who skips versions sees only the newest notes.** The release workflow's own text says `appcast.xml` "always describes the newest version". The same fact means rewriting old notes changes no popover. **(verified from the workflow's text; the appcast itself was not read.)**

**[F09] The history can carry a rewrite, and the ranges are exact.** Each of the 23 releases has a `Built from commit` line matching its tag, measured with `gh release view` against `git rev-list`. **(verified)** Commits and body bytes per range, against the notes' size:

| Version | Commits | Commit-body bytes | Notes bytes |
|---|---|---|---|
| 0.8.1 | 3 | 935 | 26 |
| 0.8.2 | 12 | 5,724 | 933 |
| 0.8.3 | 1 | 90 | 52 |
| 0.8.4 | 6 | 9,887 | 935 |
| 0.8.5 | 1 | 223 | 1,135 |
| 0.8.6 | 3 | 3,631 | 1,122 |
| 0.8.7 | 2 | 538 | 227 |
| 0.8.8 | 1 | 199 | 272 |
| 0.8.9 | 3 | 865 | 224 |
| 0.8.10 | 1 | 177 | 303 |
| 0.8.11 | 39 | 64,993 | 1,482 |
| 0.8.12 | 5 | 5,848 | 455 |
| 0.8.13 | 2 | 709 | 135 |
| 0.8.14 | 2 | 734 | 162 |
| 0.8.15 | 24 | 30,864 | 1,191 |
| 0.8.16 | 165 | 225,321 | 1,724 |
| 0.8.17 | 40 | 55,845 | 1,850 |
| 0.8.18 | 40 | 50,682 | 1,076 |
| 0.8.19 | 388 | 547,970 | 6,044 |
| 0.8.20 | 88 | 123,382 | 1,848 |
| 0.8.21 | 40 | 60,878 | 1,514 |
| 0.8.22 | 2 | 443 | 90 |

**[F10] At least one version's notes are attached to the wrong release.** The whole `v0.8.4..v0.8.5` range is `d06c2f62f`, a version bump whose message calls it a no-op release to exercise the update flow, yet `release-notes/0.8.5.md` describes an Install and Relaunch fix and a new step in the update dialog. Which release actually carried that work was not established. Other thin ranges with longer notes (`0.8.8`, `0.8.10`) were not checked. **(verified for 0.8.5)**

**[F11] Several notes say nothing to a reader.** `0.8.1` is "Test release". `0.8.3` is "Bumped version to test in-app download." `0.8.13` and `0.8.14` are differently worded "internal tooling" sentences. `0.8.22` is "This log contains only an internal script fix with no reader-facing effect." **(verified)**

**[F12] The drafting pipeline produces that last sentence.** `scripts/release-notes-prompt.md` tells the model to reply with nothing when the log has nothing a reader would care about, but `scripts/release.py` stops on an empty reply. That the contradiction is what pushes the model to write a sentence about the log is inference from the two texts and the `0.8.22` output. The notes' first line also becomes the release commit's subject, as in `af08d9f8c`. **(contradiction verified; causation inferred)**

**[F13] The macOS version is stated three ways.** `tugapp/Info.plist` has `LSMinimumSystemVersion` 15.0. `tugapp/Tug.xcodeproj/project.pbxproj:632` and `:686` set `MACOSX_DEPLOYMENT_TARGET = 14.0`. Macos 14 Sonoma is what `README.md:19`, `docs/features.md:9`, `DEVELOPING.md:21` and `:32`, and the site's `src/pages/tug/index.astro:329` tell people. `tugapp/Sources/MainWindow.swift:1465` has an `#available(macOS 14.0, *)` check. **(verified)**

**[F14] The deck has its own stricter floor within Sequoia.** `tugdeck/src/lib/macos-support.ts:42` lists 15.6 for the 15 line, so a 15.0–15.5 machine launches but counts as below the floor. What that floor gates was not investigated. `tugrust/scripts/fetch-tmux.sh` pins 13.0 for its own build. **(verified that the values exist)**

---

## Decisions {#decisions}

**[B01] Every 0.8.x release from `0.8.1` on gets redrafted from git.** The ranges are exact [F09], some existing notes are wrong [F10] or empty [F11], and the rewrite cannot reach an old popover [F08], so the risk is confined to text the user reads before it is published. The result lands as one commit, so `git diff` shows old against new and good existing text can survive.

**[B02] `0.8.0` stays as written.** Its range is the whole project, and it reads fine as a first-release statement.

**[B03] Drafts describe the net change for a reader of the previous version.** A bug introduced and fixed inside one range never reached anyone, so it is not a fix. This is the rule that keeps a commit log from overstating a release.

**[B04] Notes describe the release as it was, without hindsight.** A feature removed later keeps its original entry, because the notes are a history rather than a description of today's app.

**[B05] Length scales with the release.** A no-op gets one line, and a large release gets grouped `##` sections. This replaces the "ten lines is a lot" rule in `scripts/release-notes-prompt.md`, because the user asked for complete notes and the notes now have readers beyond the popover. "Complete" never means padded, and "never invent a change" stays.

**[B06] A release with nothing for a reader gets one fixed line: "Internal release work. Nothing changes in the app."** The prompt gives this line for that case instead of asking for an empty reply, which removes the contradiction in [F12]. It applies to `0.8.1`, `0.8.3`, `0.8.13`, `0.8.14` and `0.8.22`, unless the search for misplaced work [F10] gives one of them real content.

**[B07] Redrafting reuses the release pipeline's drafting call.** A redraft script uses `scripts/release-notes-prompt.md` and the same tool-less `claude -p` call, one version at a time, over the range between `Built from commit` lines. Session trailers are stripped, and the largest ranges (`0.8.19`, `0.8.16`) may be cut to subjects and each join message's opening paragraph to fit one call. The model never touches the tree, which is the guarantee the release script already makes.

**[B08] The user reads every redrafted note before anything is published.** The drafts are drafts, as `release-notes/README.md` already says of every draft. The GitHub backfill follows that reading and never precedes it.

**[B09] The release workflow composes the GitHub body from the notes.** `release.yml` moves from `body` to `body_path`: the notes without their `# Tug x.y` heading (the release title already says it), a rule, then the install lines and `Built from commit <sha>` [F03]. Missing notes do not block a release, matching the appcast.

**[B10] The 23 existing releases are backfilled with `gh release edit`.** A one-off script puts each version's notes above its existing body, leaving the commit line and assets alone, and is safe to re-run. It changes public pages, so it shows a dry run before it writes anything.

**[B11] `Release notes` links to `/releases`, beside System requirements on the site and beside "See all releases" in the README.** The whole history is what a reader wants there, and `SITE.releases` already holds the URL [F04]. The site link uses the same `tug-link` style.

**[B12] Help ▸ Release Notes opens a help card, as a fourth `HelpDoc`.** The user said "a text/markdown card". The help card is that for a read-only document [F05], whereas a Text card is an editor, which is wrong for a file inside the app bundle. The menu item goes after Glossary, in the same group.

**[B13] tugcast assembles the document on read, with no generated file.** The Xcode phase copies `release-notes/*.md` to `Resources/docs/release-notes/`. `HelpDoc::read` sorts newest first by version, skips the README and any unfilled seed, adds a `# Release Notes` title, and demotes each `# Tug x.y` to `##` and its sections to `###`. Dev builds read the checkout the same way, so nothing can go stale and the assembly is one tested implementation. Each release's notes are in the commit its build comes from, so an app always has its own.

**[B14] The Operator reads the release notes as a help document.** This follows from [B12] and [F06], and it means Overview can answer "what changed in 0.8.21?". `just operator-eval` runs afterward, as the project asks of any change to what the Operator retrieves from.

**[B15] The update popover gets an "All release notes" link that opens the card.** It is the answer for someone who skipped versions [F08].

**[B16] The prompt learns its new readers.** `scripts/release-notes-prompt.md` and `release-notes/README.md` today describe only the popover. Both describe the GitHub page and the help card too.

**[B17] The macOS floor is macOS 15 Sequoia everywhere.** The user settled this. `MACOSX_DEPLOYMENT_TARGET` goes to 15.0 in both places, `Info.plist` stays, and the `#available(macOS 14.0, *)` check in `MainWindow.swift:1465` comes out. `README.md`, `docs/features.md` and the site say "macOS 15 Sequoia or later, including macOS 26 Tahoe and macOS 27 Golden Gate"; `DEVELOPING.md` says macOS 15. `0.8.0.md` already says macOS 15. Raising the target can surface deprecation warnings, and the Swift app has to build clean.

**[B18] Content lands first.** The backfill publishes the notes, so the rewrite and the user's reading come before it. The site and GitHub change when pushed and deployed. The in-app card and the rewritten notes reach users with the next release.

---

## Open Questions {#open-questions}

- **How does the popover handle a long note?** `0.8.19`'s 6 KB is the longest shipped, but nothing here read how the popover lays that out. [B05] makes long notes more likely, so this has to be read from the code or the running app, and if it does not scroll well, that gets fixed as part of this work.
- **Where did the work in `0.8.5`'s notes actually ship?** It takes reading the neighbouring ranges, `0.8.4` and `0.8.6` first, and the same check on `0.8.8` and `0.8.10`. The answer changes what those files say, and possibly what the fixed-line list in [B06] holds.

---

## Non-goals {#non-goals}

- **Dates in the card.** Notes files carry none and the bundle has no git, and GitHub shows them already. The user agreed.
- **Opening the notes on their own after an update.** The update pill stays the only prompt. The user agreed.
- **A notes page on the site.** The link goes to GitHub, as asked.
- **Moving `Update Feed` or `Nightly Build` in the release list.** They sit at the bottom, under `0.8.0`, and stay there. The user agreed.
- **A Text card for the notes.** See [B12].
- **A notes file generated at build time.** See [B13]: it would be a second copy, and one a dev build's checkout fallback would not have.
- **Redrafting `0.8.0`.** See [B02].
- **Changing the 15.6 floor in `macos-support.ts` or the 13.0 pin in `fetch-tmux.sh`.** Both are existing behaviour with their own reasons [F14], and neither is a statement of what Tug supports.

---

## Exit {#exit}

An arc. Its first steps have a required order on the content side, and the rest are independent of each other:

1. Fix the prompt [B05, B06, B16] and write the redraft script [B07].
2. Redraft `0.8.1` through `0.8.22` under [B03, B04], settling the `0.8.5` question, and hand them to the user to read [B08].
3. After that reading: the workflow change [B09] and the backfill's dry run [B10], which waits for the user's go-ahead before it writes to GitHub.

Independent of those: the fourth `HelpDoc` with its assembly, menu item, Operator arm and popover link [B12–B15]; the macOS floor [B17]; and the links [B11].

The site's two changes are in `/u/src/tug-site`, a separate repository with its own deploy, so an arc worktree of this checkout does not reach them. They are separate, small edits that the arc has to name rather than assume.
