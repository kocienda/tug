# Session references

A prompt can name another session. It arrives as a backticked marker — `` `@session:<project>/<callsign>` `` — and it means: *the session whose callsign is `<callsign>`, in the project whose directory ends in `<project>`*. The user put it there by placing a session atom, the same way they place a file or a commit.

**A callsign is a name, not an address.** It is minted per Tug instance and is unique only inside one, so you cannot resolve it by pattern-matching or by guessing which session it must be. Everything you need to act on it is given to you.

## The reference block

A message carrying any session reference ends with one block that resolves each of them:

```text
<!-- tug:session-refs -->
Session references in this message (read one with the command shown; do not guess at what a reference means):
- @session:eucit/curly-apple — uuid 0f3c1e5a-…, project /u/src/eucit, verdict: elsewhere — read: tugtool session show 0f3c1e5a-…
- @session:tug/odd-kiln — verdict: absent — this session is not on this machine
```

One line per distinct reference. The `uuid` is what every command below takes. The block is plumbing: it is addressed to you, the user does not see it, and there is no reason to quote it back.

## The verdicts

- **`here`** — the session belongs to the Tug instance you are running under.
- **`elsewhere`** — it is on this machine, recorded by another instance or in a project this one has not opened. It reads exactly the same way; the distinction is about which ledger holds it, not about whether you can read it.
- **`absent`** — nothing on this machine matches. Say so plainly: the session is not on this machine. Do not guess at what it might have been about, do not infer its content from its callsign, and do not substitute a different session that looks similar. An unfindable reference is a fact to report, not a gap to fill.
- **`unverified`** — the client had not heard back when it sent the message. Run `tugtool session find` to settle it rather than assuming either way.

## The commands

```bash
tugtool session find <uuid-or-reference>      # here | elsewhere | absent
tugtool session show <uuid>                   # the transcript, as markdown turns
tugtool session show <uuid> --last 5          # the last 5 turns
tugtool session show <uuid> --turn 12         # one turn
tugtool session show <uuid> --grep <pattern>  # turns matching a pattern
```

`show` prints a header — title, project, uuid, verdict, turn count, last update — and then the turns: each user message, and each assistant reply with its text and a one-line summary per tool call. Thinking blocks and tool output are not included.

`find` exits 0 for `here` and `elsewhere`, 3 for `absent`, and 1 when the reference is not one it can parse. `show` exits 3 on `absent` too, so a script can branch on it.

Both take a uuid, a leading 8 characters of one, a bare callsign, or the full `<project>/<callsign>` reference. Prefer the uuid the block gave you: it is the one spelling that cannot be ambiguous.

## Reading is reading

Neither command writes anything, resumes anything, or touches the session it reads. A transcript on disk is opened read-only and left exactly as it was found, so reading another session never disturbs whoever is working in it. A session is a record you may consult, never one you may continue on the user's behalf.

Narrow before you read whole. A long session's transcript is large, and `--last`, `--turn` and `--grep` exist so that answering a question about one does not mean pulling all of it into the conversation. Read the header first; it tells you how many turns there are.
