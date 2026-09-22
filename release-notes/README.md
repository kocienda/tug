# Release notes

One file per released version, named `<version>.md` — `0.8.0.md`, `0.9.0.md` —
holding the markdown a person reads when Tug offers them that update.

## Where it goes

`tugrust/scripts/make-appcast.sh` stages `release-notes/<version>.md` into the
scratch directory beside `Tug-<version>.zip` under the archive's own stem, which
is the whole of `generate_appcast`'s convention for finding release notes. The
notes are embedded in the appcast rather than linked, so the update popover has
them the moment the item is parsed — no second fetch, and nothing to fail
separately from the update itself.

From there they arrive as `SUAppcastItem.itemDescription`, land in the
`available` snapshot, cross the bridge, and are rendered by the deck's own
markdown renderer in the popover. Write markdown for that reader: a few
sentences or a short list about what changed, not a commit log.

## Where it comes from

`tugrust/scripts/version.sh set` and `version.sh bump` seed an empty file here
for the version they set, so the reminder arrives with the bump. Seeding never
overwrites a file that already exists. `/write-release-notes` in the Session card
writes the first draft from the commits since the last release — for the
reader who does not read this repository, not as a commit log — and
`just release-notes` opens it. Editing and confirming that draft is a person's
job, and `just bless` refuses to release while the seed is still in the file.

## When it is missing

Nothing breaks. `make-appcast.sh` warns on stderr and generates the feed
anyway, and the popover shows the version and its controls with no notes above
them. An absent changelog never blocks an update.
