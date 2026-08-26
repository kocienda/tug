# Corpus fixtures

Each directory here is one real edit the model made to a repo file from Bash, lifted from a Claude Code session transcript for this checkout, paired with the rev that expresses it.

- `cmd.sh` — the original command, verbatim. Where the transcript's line continued into something that only *displayed* the result (`&& sed -n …`, `&& grep -n …`, `&& bunx tsc`), only the editing half is kept: the fixture is about the edit.
- `note.md` — which transcript the command came from, and which commit the content is pinned at.
- `program.rev` — the rev.
- everything else — the real file content the command ran against, at its real path, pinned from git history at a commit where the command's anchors match.

`rev_corpus.rs` runs the command in one temp dir and `tugrev` in another and asserts the results are byte-identical. The oracle is the real interpreter, so a rev that silently diverges from what the command actually did fails here.

**Platform: macOS (BSD `sed`, `awk`, and the system `python3`/`perl`).** A fixture whose oracle depended on BSD-only syntax (`[[:<:]]`) would be rewritten to a portable equivalent or dropped — never made to pass by weakening the assertion. A missing interpreter fails the tier rather than skipping it.

Two shapes the plan named are not here, because this corpus does not contain them: a multi-file `perl -pi` (every `perl -pi` call in the deduplicated corpus names one file) and a `perl -0777` *edit* (the only `-0777` calls are read-only `-ne` scanners). The language properties they stood for are covered by real commands all the same — `multi_file_sub` for one expression across several files, and `cross_line_replacement` for a substitution whose text spans lines.
