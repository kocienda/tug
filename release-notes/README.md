# Release notes

One file per released version, named `<version>.md` — `0.8.0.md`, `0.9.0.md` —
holding the markdown a person reads about that version, wherever they read it.

## Where it is read

Three readers, none of whom reads this repository. Write for them: what changed
for the person using the app, at a length that follows the release, not a commit
log.

**The update wizard.** `tugrust/scripts/make-appcast.sh` stages
`release-notes/<version>.md` into the scratch directory beside
`Tug-<version>.zip` under the archive's own stem, which is the whole of
`generate_appcast`'s convention for finding release notes. The notes are
embedded in the appcast rather than linked, so the wizard has them the moment
the item is parsed — no second fetch, and nothing to fail separately from the
update itself. From there they arrive as `SUAppcastItem.itemDescription`, land
in the `available` snapshot, cross the bridge, and are rendered by the deck's own
markdown renderer. The appcast only ever describes the newest version, so
rewriting an old file changes nothing here.

**The GitHub release page.** `scripts/release_body.py` composes the versioned
release's body from the file: the notes without their heading, then the install
lines and the `Built from commit` line. The release workflow runs it for each
new release. `scripts/backfill-release-notes.py` runs it over the releases
already out, printing a dry run unless given `--apply`, which is how a rewritten
old file reaches its page.

**The Help ▸ Release Notes card.** The app bundle carries every file here, and
tugcast assembles them newest first into one document. The Overview answers from
that document too.

## Where it comes from

`tugrust/scripts/version.sh set` and `version.sh bump` seed an empty file here
for the version they set, so the reminder arrives with the bump. Seeding never
overwrites a file that already exists.

`scripts/release.py` — the release script, reached as `just release` — is what
fills the seed in. It hands one tool-less `claude -p` call the commits since
the last release together with `scripts/release-notes-prompt.md`, which carries
the doctrine above, and writes the reply under the `# Tug <version>` heading.
The model is never given a tool and never touches the tree, and the draft step
runs **only while the file is still the seed**, so notes a person has written
are never drafted over.

A release with nothing for a reader gets one fixed line, which the prompt gives
the model for that case: "Internal release work. Nothing changes in the app."

`scripts/redraft-release-notes.py` is the same prompt and the same call for a
version already out, over the range between the `Built from commit` lines of its
release and the one before it. It writes to a directory it is given, never over
these files, so a redraft is compared against what is here before any of it
lands.

The draft is a draft. The script prints it and offers to open it in
`$EDIT_OPENER` before going on, rereading the file at the commit row so a tune
made there is the one that ships; `just release-notes` opens it in `$VISUAL`
or `$EDITOR` at any other time. Editing and confirming is a person's job, and
`just bless` refuses to release while the seed is still in the file.

## When it is missing

Nothing breaks. `make-appcast.sh` warns on stderr and generates the feed
anyway, and the wizard shows the version and its controls with no notes above
them. The release workflow composes its body without them, and the help card
skips the version. An absent changelog never blocks an update.
