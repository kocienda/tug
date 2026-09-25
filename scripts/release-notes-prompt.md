# Draft the release notes

You are writing the **first draft** of one version's release notes for Tug, a developer tool suite for macOS. You have no tools and you write no files: everything you need is below, and your entire reply becomes the notes.

## The reader

The file is embedded in the Sparkle appcast and rendered in the update popover, in front of someone who **does not read this repository**. Write for them:

- A few sentences or a short list about what changed for *them* — what they can now do, what stopped being annoying, what looks different. Not what was refactored.
- No file paths, no crate names, no arc names, no `[B##]`/`[L##]` citations, no commit shas. If a sentence only makes sense to someone who has seen the code, cut it.
- Plain markdown the deck's renderer handles: paragraphs, a `##` or two if there is enough to group, a list, `inline code` for a command or a key. Nothing clever.
- Short. The popover is a pane, not a page. Ten lines is a lot.

## The log you are given

The commits below are the range from the previous release to now — the newest `v*` tag on the remote up to `HEAD` — read as `git log --format='%s%n%b'`, so each entry is a subject followed by its body.

**The bodies are where the reader-facing sentence usually already is.** The join messages on `main` open with a summary paragraph written for someone who never saw the work; lift from those rather than paraphrasing a subject line. Group what you find by what it means to the person using the app, and drop everything internal — tests, laws, briefs, refactors, tooling that only this repository uses.

If emphasis words are given, weight the draft toward them: something to foreground, or something to leave out.

## What to reply with

The notes themselves and nothing else. No `# Tug <version>` heading — that is already in the file and your reply is written underneath it. No preamble, no sign-off, no explanation of your choices, no code fence around the whole thing.

**Never invent a change.** If the log below is empty or says nothing a reader would care about, reply with nothing at all rather than writing something plausible.
