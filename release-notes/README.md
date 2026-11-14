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

**The Help > Release Notes card.** The app bundle carries every file here, and
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

## The Claude Code floor

`capabilities/FLOOR` is the oldest Claude Code this version of Tug runs
against. It is one line of plain text, and it is the only place the number is
written: the deck is built with it, and `make-appcast.sh` writes it onto the
appcast item, which is how a Tug that is already installed learns what the
next version needs before it installs it. A user under the floor is asked to
update Claude Code before Tug will install the update, and a user who reaches
the new Tug under it some other way is held at Configure Tug until they do.

So every raise is a forced Claude Code update for somebody, and the rule is
narrow on purpose:

- **Raise it only when Tug starts depending on something a newer Claude Code
  introduced** — a wire shape, a flag, a behaviour the code now assumes. A
  report of breakage on a version inside the supported range is the other
  reason. Being behind the newest release is not one: between the floor and
  the newest capture the user is left alone, and nothing nags them.
- **Never raise it past `capabilities/LATEST`.** That file is the version of
  the newest capture, so a floor above it is a floor nothing was ever captured
  or tested against.
- **Say it in the notes.** When the floor differs from the previous release's,
  this version's file has to name the new one with the words
  `Claude Code <version>` — for example "This version needs Claude Code
  2.1.300 or later; Tug offers the update before it installs." It is the one
  line of a release that tells a person the update will change something
  outside Tug.

There is no ceiling. A Claude Code newer than the newest capture runs, and the
blocks that might have drifted say so on themselves.

`just bless` holds the last two. It prints the floor beside the newest capture
on every run, fails when the floor is above the capture, and fails when the
floor moved since the previous `v*` tag and the notes do not name it.

## When it is missing

Nothing breaks. `make-appcast.sh` warns on stderr and generates the feed
anyway, and the wizard shows the version and its controls with no notes above
them. The release workflow composes its body without them, and the help card
skips the version. An absent changelog never blocks an update.
