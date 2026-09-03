# `dev.tugtool` → `dev.tugapp` — the app's reverse-DNS identity

**Status:** settled, unbuilt. Every decision below is answered; this is ready to
hand to `/arc` once its one precondition is met.

Tug's reverse-DNS prefix is `dev.tugtool`. It names two very different things:
the **bundle identity** macOS knows the app by, and the **tugbank domains** every
persisted preference is filed under. Both become `dev.tugapp`, the domain the
project actually owns. This is the survey of what carries the old name, what
breaks when it changes, and the order to change it in.

Out of scope: the `tugtool` **CLI** keeps its name. This is about the app's
identity string, not the binary.

## Decisions

- **[B1] Take the stutter: `dev.tugapp.app`.** One substitution rule, and
  `assign-bundle-id.sh`'s `<prefix>.<profile>-<slug>` grammar is untouched.
- **[B2] Every installed copy re-downloads by hand.** Sparkle cannot carry an
  identifier change; this is accepted, and it is the reason to do it now.
- **[B3] `dev.tug.prompt-atoms` moves too**, to `dev.tugapp.prompt-atoms`, in
  this same change.
- **[B4] `gazette` is a retired name and leaves the tree with the identifier.**
  The domain is `dev.tugapp.overview`; the Gazette-era compatibility shims go
  with it. See [The gazette sweep](#the-gazette-sweep).

## The precondition

**Grant Accessibility to `dev.tugapp.app.apptest` before the arc starts.** The
change rewrites the `Justfile`'s `TUG_FORCE_BUNDLE_ID` default, so the implement
stage builds in its worktree under a brand-new identity with a brand-new
designated requirement and no AX grant — and `launchTugApp`'s preflight throws
`AccessibilityPermissionMissingError` in a session where nobody can answer the
system dialog. Build one bundle at the new id, launch it interactively, answer
the prompt. Then the arc runs clean.

## The census

`405` occurrences across `157` files, spelling `56` distinct identifiers. Two
families:

**Bundle identity — `dev.tugtool.app` and its six variants.** `dev.tugtool.app`
(release), `.debug`, `.apptest`, `.dev` (legacy), `.nightly`, and the derived
`.debug-<slug>` / `.release-<slug>` per-branch identities. Authored in
`tugapp/Info.plist`, `tugapp/Tug.xcodeproj/project.pbxproj`,
`tugrust/scripts/assign-bundle-id.sh`, `tugrust/scripts/bundle-id-from-cwd.sh`,
`tugrust/scripts/capture-build-info.sh`, `tugapp/Sources/UpdateController.swift`
(the self-update gate), `tugrust/crates/tugcore/src/registry.rs`,
`tugrust/crates/tugtool/src/commands/tell.rs`, the `Justfile`
(`TUG_FORCE_BUNDLE_ID` defaults), and the `tests/build-info/` shell suite.

**Tugbank domains — ~40 of them.** `dev.tugtool.app` doubles as the app-preferences
domain; then `deck.cardstate`, `deck.layout`, `deck.state`, `deck.theme`,
`deck.focused`, `layout`, `cards`, `dev`, `dev.diff-view`, `dev.shade-height`,
`keymap`, `models`, `model`, `effort`, `permission-mode`, `text-card`,
`image-card`, `pdf-card`, `editor`, `transcript`, `find`, `lens`, `overview`,
`gazette` (a retired alias — deleted, not renamed), `pulse`, `shared-agent`, `changeset`,
`prompt.history`, `settings-card`, `side-questions`, `pending-context`,
`slot-window`, `tugways.split-pane`, `tugways.pinned-panel`, `dev-panel`,
`ai-config`, `tuglog`, `test`/`test.bloat`. Referenced from `tugdeck/src`
(52 files, `settings-api.ts` densest), `tugrust/crates/tugcast` (the Rust-side
constants in `defaults.rs`, `pulse.rs`, `shared_agent.rs`, `overview_agent.rs`),
`tugapp/Sources/TugConfig.swift`, `tugcode/src/session.ts`, and 61 app-tests.

**Every one of the 405 changes.** There is no set of files that keeps the old
name because of what it is — no fixture, no corpus, no law. The identifier
changed; a file still spelling `dev.tugtool` afterwards is a file we missed. Three
of them need a second step after the substitution, and that is all:

- `tests/model-eval/corpus/*.json` — some tool strings are truncated
  mid-identifier (`dev.tugtoo`, `dev.tugtool.app.deb`), so a `dev\.tugtool`
  pattern silently misses them. Sweep `dev\.tugtoo(l)?` → `dev.tugapp` to catch
  both. Then regenerate the paired `.digest.txt` files with
  `TUG_REGENERATE_DIGESTS=1 cargo nextest run -p tugcast corpus_digests` rather
  than editing them — they are produced by the shipping composer and pinned by
  `corpus_digests_are_what_compose_digest_produces`, so a hand edit fails that
  test.
- `tugrust/crates/tugtool/tests/corpus/stacked_rename/` — sweep the fixture and
  update `note.md`, which pins the fixture's bytes to `68e7d5a27`. The oracle
  test compares two temp dirs laid out from the same fixture, so it passes
  either way; the note is the thing that has to stop being wrong.
- `tuglaws/*.md` — swept like everything else, then read once for the sentences
  that assert something the rename made false. `code-signing-mac.md` promises
  that one app-test AX grant carries across every worktree "forever"; that
  sentence needs the exception this change introduces, and no substitution
  writes it.

## What happens to installed copies

Changing `CFBundleIdentifier` is not a rename to macOS; it is a **different app**.
Three consequences, in descending order of pain:

**Sparkle refuses a bundle-identifier change.** `UpdateController` gates
self-update on `Bundle.main.bundleIdentifier == "dev.tugtool.app"`, and Sparkle
itself validates that the downloaded bundle's identifier matches the host's. An
appcast serving a `dev.tugapp.app` build to an installed `dev.tugtool.app` will
not install. Every existing install becomes a manual re-download. At today's
install count that is probably fine — **but it is the reason to do this now
rather than later**, and it should be an explicit call, not a discovery.

**Every TCC grant is void.** Accessibility is keyed on bundle ID + designated
requirement. The app-test identity `dev.tugtool.app.apptest` — the one grant that
[code-signing-mac.md](../tuglaws/code-signing-mac.md#the-app-test-identity-tug_force_bundle_id)
exists to protect, because it is what lets unattended arcs run app-tests across
every worktree — becomes `dev.tugapp.app.apptest`, ungranted. **A human must
grant it once, interactively, before any unattended app-test run works again.**
Same for `dev.tugapp.app.debug`. This is the single hardest-to-recover step and
it belongs at the front of the plan, not the end.

**Orphans, all harmless.** `~/Library/Caches/dev.tugtool.app.*` (WebKit),
LaunchServices registrations for the old identities, and stale TCC rows. Cleanup
is a documented `tccutil reset Accessibility dev.tugtool.app.apptest` plus an
`rm -rf` of the caches; nothing breaks if it is skipped.

**Not affected:** the data directory. `tugcore::instance::data_dir()` keys off
`~/Library/Application Support/Tug/` and `TUG_INSTANCE_ID`, never the bundle ID,
so `tugbank.db`, `sessions.db`, `changes.db`, and the logs all stay put across
the rename. Only the *domain strings inside* tugbank move.

## The tugbank migration

The domain rewrite is durable data, so it needs a real migration rather than a
constant edit. `tugbank-core` has the slot: `schema.rs` is at
`CURRENT_SCHEMA_VERSION = 1` with an empty `run_migrations`, and every open —
per-instance `Tug/instances/<id>/tugbank.db` and legacy `~/.tugbank.db` alike —
goes through `Store::open` → `migrate_schema`. So:

**Schema v2: rewrite every domain whose name starts `dev.tugtool.`.** Not a
per-domain carry-forward like `carry_legacy_defaults_forward` in
`overview_agent.rs` — that shape is right for one renamed channel and wrong for
forty. One prefix rule covers every domain including ones nobody remembers.

`entries.domain` is a foreign key to `domains(name)` with `ON DELETE CASCADE`
and **no** `ON UPDATE CASCADE`, and `foreign_keys` is ON, so the migration is a
three-step inside the existing transaction: insert the renamed rows into
`domains`, `UPDATE entries SET domain = 'dev.tugapp.' || substr(domain, 13)`,
delete the old `domains` rows. A renamed domain that already exists (it
shouldn't, on a v1 database) keeps the newer row's generation and skips the
copy — same "a value written since the rename wins" rule the overview carry-
forward uses.

Generation counters advance, which is correct: every DEFAULTS subscriber should
see the new domains as changed on first boot after the migration.

Once this lands, the deck/Rust/Swift constants can be flipped wholesale, because
no reader will ever see the old names again.

## Order of work

1. **Grant the new app-test identity first.** Build one throwaway bundle at
   `dev.tugapp.app.apptest`, launch it interactively, answer the AX prompt. Until
   this is done, nothing after step 6 can be verified and no unattended arc can
   run app-tests at all. See [The precondition](#the-precondition).
2. **Tugbank schema v2** — the prefix migration plus its unit tests (a seeded v1
   database with entries across several domains, migrated, read back). Ships
   alone, ahead of any constant change: an old build reading a migrated database
   finds nothing, so this step and step 3 land together or the migration is
   inert-but-harmless if step 3 slips.
3. **Domain constants** — `tugdeck/src` (52 files), `tugcast` (the four
   `*_DOMAIN` constants and the inline literals in `main.rs`, `defaults.rs`,
   `cli.rs`), `TugConfig.swift`, `tugcode/src/session.ts`. Mechanical; every one
   is a literal `dev.tugtool.` prefix. `tugtool file edit` with
   `sub /dev\.tugtoo(l)?/ 'dev.tugapp' all` across the whole file list.
4. **The gazette deletions** — `overview_agent.rs`'s legacy domain and
   carry-forward, `session_ledger.rs`'s `gazette_posts` migration and its two
   seeded-schema tests, `serialization.ts`'s rename entry, and the re-pointed
   `component-id-rename.test.ts`. Lands with step 3, because the prefix
   substitution is what would otherwise rename the legacy domain into
   `dev.tugapp.gazette`.
5. **The pasteboard type** — `dev.tug.prompt-atoms` → `dev.tugapp.prompt-atoms`
   in `MainWindow.swift`, `tug-text-editor.tsx`, `tug-session-identity.tsx`, the
   spike, and the four app-tests that name it (`at0043`, `at0376`, `at0474`,
   `at0477`).
6. **Bundle identity** — `Info.plist`, `project.pbxproj`, the three
   `tugrust/scripts/*bundle-id*.sh`, `UpdateController.swift`'s
   `stableBundleIdentifier`, `registry.rs`, `tell.rs`, the `Justfile`'s
   `TUG_FORCE_BUNDLE_ID` defaults, and `tests/build-info/`.
7. **Tests and fixtures** — 61 app-tests carry domain literals, mostly through
   `setTugbankValue`; `_harness/tugbank-helpers.ts` is the one shared file.
   `at0387` asserts the printed bundle-id banner verbatim. The `stacked_rename`
   fixture and its `note.md`; the `model-eval` corpus and its regenerated
   digests. Then the core tier, then a targeted `just app-test` selection over
   the persistence tests (`at0010`, `at0024`–`at0027`, `at0037`, `at0042`,
   `at0279`, `at0413`).
8. **Prose** — the seven `tuglaws/` files, swept and then read. Two passages in
   `code-signing-mac.md` need a hand: the promise that one app-test AX grant
   carries across every worktree forever, which now has an exception, and
   `design-decisions.md` [D129]'s record of the deleted `stackChord` key, whose
   sentence should say the key is gone rather than name it under a prefix it
   never wore.
9. **Cleanup note** — a short section in `code-signing-mac.md` giving the
   `tccutil reset` / cache-removal incantations. This is the one place the old
   string is *typed fresh* rather than left behind: the whole point of the
   section is naming the identities being cleared.

## The pasteboard type

`dev.tug.prompt-atoms` — the private pasteboard type in
`tugapp/Sources/MainWindow.swift`, `tugdeck/src/components/tugways/tug-text-editor.tsx`,
and `tugdeck/src/components/tugways/tug-session-identity.tsx` — is a third
reverse-DNS name under a *fourth* prefix. It becomes `dev.tugapp.prompt-atoms`
[B3]. The type is ephemeral, so the whole cost is that an atom copied from an
old build does not paste as a chip into a new one; a plain-text paste is the
fallback and already works. The spike copy at
`tugdeck/src/spikes/spike-session-identity.tsx` carries the literal too.

## The gazette sweep

`gazette` is the retired name for **Overview**, and it leaves with the identifier
[B4]. Four sites, and they are not all the same kind of thing.

**Delete — Gazette-era shims whose own comments say they are deletable.**

- `tugrust/crates/tugcast/src/feeds/overview_agent.rs` — `LEGACY_OVERVIEW_DOMAIN`
  (`dev.tugtool.gazette`) and `carry_legacy_defaults_forward`, which the prefix
  substitution would otherwise turn into a legacy alias wearing a new name. Its
  doc comment already says "deletable once no installation predates the rename."
  The live domain is untouched and becomes `dev.tugapp.overview`.
- `tugrust/crates/tugcast/src/session_ledger.rs` — `migrate_gazette_posts_to_overview_posts`,
  `rename_gazette_posts_within_transaction`, its call site in the open path, and
  the two tests that seed a pre-rename schema (the `gazette_posts` table, its FTS
  shadow, and its three triggers). The guard returns early on any database opened
  once since the rename, so on a live machine this code has been a no-op for a
  while.

**Delete — `tugdeck/src/serialization.ts`'s `gazette: "overview"` entry.** Clean
break. A layout arranged before the Overview rename and not opened since loses
its Overview card on first launch, and the pane it was alone in goes with it;
that is accepted. The entry's neighbour `dev: "session"` stays — this decision is
about the retired name, not about `RENAMED_COMPONENT_IDS`, whose doc comment
("this table only grows") remains true of every other entry.

**Re-point, do not delete, `tugdeck/src/__tests__/overview-card-rename.test.ts`.**
It is the only coverage of `migrateComponentId`'s fan-out — the card table, the
`sidebars` record, the rail `order`, and the rail `shares` weights, four places a
saved layout can name a card and four call sites in `serialization.ts`. Its blob
already spells its second card `"session"`, so the file never exercised
`dev: "session"` at all; deleting it would leave the one surviving entry with no
test anywhere. Rewrite the fixture to a pre-rename Session card (`"dev"`) and
keep every assertion. Rename the file to `component-id-rename.test.ts`, since it
was never really about the Overview.

**Leave — `tests/app-test/at0422-filter-forward.test.ts:71`.** The word appears
in a comment explaining why the fixture says `gazebo`: a past global rename ate
the literal substring the per-keystroke assertion depends on. It is a warning
against exactly this kind of sweep, not a use of the retired name.

The one consequence worth stating: a machine that has not opened Tug since the
Overview rename loses its Gazette-era overview posts and that domain's defaults.
Given [B2] that is coherent — but note that a re-download does not clear
`~/Library/Application Support/Tug/`, so "predates the rename" is about last
launch, not about install date.

## What this does not do

No user-visible string changes: `CFBundleName` is already `Tug`, the product is
`Tug.app`, and the display names (`Tug (apptest)`) are unaffected. No change to
the `tugtool` CLI, the crate names, the repo layout, or the appcast URL
(`github.com/kocienda/tug/releases/…`), which is keyed on the GitHub repo rather
than the bundle. `TugConfig.isValidSourceTree`'s "tugtool source tree" comments
are about the checkout, not the app, and stay.
