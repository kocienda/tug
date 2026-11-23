# Arc, sketch and docket references

A prompt can name an arc, a sketch or a docket. Each arrives as a backticked marker the user put there by placing an atom, the same way they place a session, a file or a commit:

- `` `@arc:<project>/<name>` `` means *the arc called `<name>` in the checkout whose directory ends in `<project>`*. An arc is a unit of work with its own branch, its brief and plan, its rounds, and how it ended.
- `` `@sketch:<id>` `` means *the sketch whose id is the eight hex characters `<id>`*. A sketch is the converged shape of a conversation, kept as numbered versions under that id.
- `` `@docket:<id>` `` means *the docket whose id is the eight hex characters `<id>`*. A docket is a named list the user keeps to gather one line of work: the arcs, sketches, briefs, sessions and commits filed on it, grouped into threads.

**An arc name is a name, not an address.** It is unique only inside one checkout's arc log, and only for one generation of it: a name discarded and opened again is two arcs. A sketch id and a docket id are unique on the machine, but each store lives in one checkout, and a docket's name is not unique at all. So you cannot resolve any of them by guessing, and everything you need to act on one is given to you.

## The reference blocks

A message carrying an arc reference ends with one block that resolves each of them, a message carrying a sketch reference with another, and a message carrying a docket reference with a third, after any session block and in that order:

```text
<!-- tug:arc-refs -->
Arc references in this message (read one with the command shown; do not guess at what a reference means):
- @arc:tug/gpu-wedge — project /u/src/tug, created 2026-11-22T14:59:33.128Z, fate: joined a34061901, verdict: here — read: tugtool arc show gpu-wedge --created 2026-11-22T14:59:33.128Z
- @arc:eucit/fold-rail — project /u/src/eucit, fate: live, verdict: elsewhere — read: tugtool arc show fold-rail --project /u/src/eucit
- @arc:tug/nope — verdict: absent — no arc of this name is recorded for that project
```

```text
<!-- tug:sketch-refs -->
Sketch references in this message (read one with the command shown; do not guess at what a reference means):
- @sketch:3f9a1c2e — project /u/src/tug, arc gpu-wedge, versions 3, verdict: here — read: tugtool sketch show 3f9a1c2e
- @sketch:00ff00ff — verdict: absent — this sketch is not on this machine
```

```text
<!-- tug:docket-refs -->
Docket references in this message (read one with the command shown; do not guess at what a reference means):
- @docket:5c2e81a0 — "GPU wedge", project /u/src/tug, threads 4, verdict: here — read: tugtool docket show 5c2e81a0
- @docket:77aa1234 — "Old line", project /u/src/eucit, threads 1, retired, verdict: elsewhere — read: tugtool docket show 77aa1234
- @docket:00ff00ff — verdict: absent — this docket is not on this machine
```

One line per distinct reference. An arc line names the checkout, the generation's start when it is known (`created`), and its fate: `live`, `joined <sha>`, or `discarded`. A sketch line names the checkout that holds it, the arc it belongs to when it has one, and how many versions it has. A docket line names the docket in quotes, the checkout that holds it, how many threads it gathers, and `retired` when the user has retired it. Run the command the line gives: it already carries the `--created` and `--project` the reference needs.

The blocks are plumbing: they are addressed to you, the user does not see them, and there is no reason to quote them back. When you name an arc in your own prose, write its bare name in backticks; a sketch, its id; a docket, its name, with its id beside it when the name could be ambiguous.

## The verdicts

- **`here`** — the arc, sketch or docket belongs to the project you are working in.
- **`elsewhere`** — it is on this machine, in another checkout. It reads the same way; the command carries the checkout for you.
- **`absent`** — nothing on this machine matches. Say so plainly: no such arc is recorded for that project, or the sketch or docket is not on this machine. Do not guess at what it was about, do not infer its content from its name, and do not substitute a different arc, sketch or docket that looks similar. An unfindable reference is a fact to report, not a gap to fill.
- **`unverified`** — the client had not heard back when it sent the message. Run the `check:` command the line gives to settle it rather than assuming either way.

## The commands

```bash
tugtool arc show <name>                          # the arc's record: fate, rounds, documents
tugtool arc show <name> --created <start>        # one generation of a reused name
tugtool arc show <name> --project <dir>          # an arc in another checkout
tugtool arc show <name> --document brief         # one document's bytes: brief, plan, tasks or sketch
tugtool sketch show <id>                         # the latest version of a sketch
tugtool sketch show <id> --version 2             # one version
tugtool sketch show <id> --versions              # the list of versions
tugtool docket list                              # this checkout's dockets, newest first
tugtool docket list --all                        # retired dockets too
tugtool docket show <id>                         # a docket and each of its threads
```

`arc show` answers for a live arc from its branch and documents, and for one that has ended from the arc archive, where its brief, plan and sketch were kept when it joined or was discarded. An arc joined before documents were archived has no documents to read, and `arc show` says so; its join commit is still named, and `git show` reads it.

`sketch show` and `docket show` look under every checkout on the machine, so they need no `--project`. Each exits 3 when the id is not on this machine. A docket's threads are derived when it is read: each line of `docket show` names the thread's sketch, brief, arc, sessions and commits, and those are references you read with the commands above.

## Reading is reading

None of these commands writes anything, resumes anything, or touches the arc, sketch or docket it reads. An arc is a record you may consult, never one you may continue, join or discard on the user's behalf; a sketch is a version you may read, never one you may rewrite because it was cited; a docket is the user's list, which you may read but never file on, rename or retire for them.

Narrow before you read whole. Read the record first; it tells you which documents there are, and `--document` reads one of them.
