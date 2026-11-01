# Draft the release notes

You are writing the **first draft** of one version's release notes for Tug, a developer tool suite for macOS. You have no tools and you write no files: everything you need is below, and your entire reply becomes the notes.

## The readers

The notes have three readers, and none of them reads this repository: the update wizard, in front of someone deciding whether to take this version; the version's release page on GitHub; and the Help ▸ Release Notes card, where they sit among the notes of every other version. Write for them:

- Say what changed for *them*: what they can now do, what stopped being annoying, what looks different. Not what was refactored.
- No file paths, no crate names, no arc names, no `[B##]`/`[L##]` citations, no commit shas. If a sentence only makes sense to someone who has seen the code, cut it.
- Plain markdown the deck's renderer handles: paragraphs, `##` sections, lists, `inline code` for a command or a key. Nothing clever.
- Let the length follow the release. A small release is a sentence or two. A large one is grouped `##` sections, with a line for every change a reader would notice. Complete never means padded: nothing goes in to make a release look bigger than it was.
- Open with a plain sentence, before any heading or list, that says what the release is about. It becomes the subject of the release commit, so it has to stand on its own.

## The log you are given

The commits below are the range from the previous release to this one, read as `git log --format='%s%n%b'`, so each entry is a subject followed by its body.

**The bodies are where the reader-facing sentence usually already is.** The join messages on `main` open with a summary paragraph written for someone who never saw the work; lift from those rather than paraphrasing a subject line. Group what you find by what it means to the person using the app, and drop everything internal — tests, laws, briefs, refactors, tooling that only this repository uses.

**Describe the net change, for someone running the previous version.** A bug introduced and fixed inside this range never reached anyone, so it is not a fix. A feature added and then reworked inside this range is one feature, described as it stands at the end of the range.

**Describe this release as it was.** Later releases are none of your concern: nothing here is written with hindsight, and a feature some later version removes still gets its entry.

If emphasis words are given, weight the draft toward them: something to foreground, or something to leave out.

## What to reply with

The notes themselves and nothing else. No `# Tug <version>` heading — that is already in the file and your reply is written underneath it. No preamble, no sign-off, no explanation of your choices, no code fence around the whole thing.

**Never invent a change.** If the log says nothing a reader would care about, reply with exactly this line and nothing else, rather than writing something plausible or remarking on the log:

Internal release work. Nothing changes in the app.
