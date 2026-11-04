# Operator Session Atoms Without the Roster

**Purpose:** The Operator answered a question about a five-day-old session by telling the user its project dir "isn't on the roster" and that it borrowed the project name from a brief's path. The session was never lost. The Operator lacked one field, and it described its workaround in the answer.

---

## Purpose {#purpose}

The user asked the Operator: *"What was the recent session where we added support for custom glyphs for the mac keyboard modifier keys?"* The answer opened:

> The session that wired in the custom key glyphs was `tug/sandy-snail`, on Nov 1. Its project dir isn't on the roster, so I took `tug` from the brief's path under `/Users/kocienda/Mounts/u/src/tug`.

The user's reaction: *"WTF does these even mean... 'not on the roster'? It's a recent session. What's the 'roster' anyway? This is bad and confusing. We shouldn't be telling the user about any of this. We should just find the damned session."*

There are two faults. The Operator could not name a session it had found without guessing. And it told the user about its own internal bookkeeping in a word the user has never been shown.

---

## Evidence {#evidence}

**[F01] "Roster" is the Operator's prompt section, capped at 12 sessions.** Every Operator turn carries a `SESSIONS (newest first):` section. It lists the workspace's 12 most recently used sessions, each with its callsign, full uuid, state, project dir and title. The cap is `SESSIONS_ROSTER_LIMIT = 12` and the rows come from `roster_rows`, both in `tugrust/crates/tugcast/src/feeds/operator.rs` (lines 1170 and 3257). The word "roster" appears only in the prompt and the code. **(verified)**

**[F02] The atom rule reads the project from the roster line alone.** The prompt in `tugrust/crates/tugcast/src/feeds/overview_agent.rs:520` tells the model to write a session as `` `<project>/<callsign>` ``, "where <project> is the LAST path segment of that session's project dir on the roster line". It names no other source for the project. **(verified)**

**[F03] Semantic search hits on sessions carry no `project_dir`.** `semantic_hit_json` (`operator.rs:2745`) sets `session_id`, and `callsign` via `semantic_callsign`, on transcript, fact and post hits. It copies `project_dir` only for document hits. So a session found through `search.semantic` arrives with a callsign and no project. **(verified, read from the code)**

**[F04] Other verbs return bare session ids.** `post_json`, `fact_json`, the shell-history rows and the file-change rows (`operator.rs` around lines 337, 553, 902 and 1793) carry `session_id` and nothing else about the session. The prompt's fallback is "put a name to it with `session.transcript` and `last 1`" (`overview_agent.rs:423`), which spends a verb round to learn two strings. **(verified)**

**[F05] The session was here all along.** `tugtool session find tug/sandy-snail` returns `here 7d7399ee-88b6-4895-bdaf-20b00d533ffa /Users/kocienda/Mounts/u/src/tug`. It is in this instance's ledger and project. It was off the roster only because twelve sessions had been used since Nov 1. **(verified)**

**[F06] The guess happened to be right.** `tug` is the right last segment here, so the app resolved the atom. For a project whose briefs live under a different directory name, the same guess would produce an atom the app cannot resolve, and the answer would quietly show plain text. *(inference from [F02]–[F03]; not reproduced)*

---

## Decisions {#decisions}

**[B01] Every session a verb result names arrives with its `callsign` and `project_dir`.** This is done once, at the verb boundary. One pass over each verb's result adds the two fields to every object carrying a `session_id`, resolved through the same lookup `session.transcript` uses (`locate_transcript`) and memoized for the turn. Patching each verb's row builder separately is ruled out. [F03] and [F04] show that per-verb fields drift: the semantic verb remembered the callsign and forgot the project. A boundary pass also covers any verb added later without anyone remembering to do it. Rows that already carry the fields are left as they are.

**[B02] The atom rule takes the project from wherever the session's `project_dir` appears.** The prompt's rule in `overview_agent.rs:520` changes from "on the roster line" to "on the roster line or on any result row that carries it". The "put a name to it with `session.transcript` and `last 1`" advice at line 423 is dropped, because [B01] makes it unnecessary. The roster stays what it is: a preamble that saves a lookup, not the only source of names.

**[B03] An answer never describes how the Operator found something.** The prompt gains a voice rule. The answer states what it found. It never names its own sections or mechanics ("roster", "HORIZON", "verb", "result row", "I took X from Y"), and it never explains how it got a session's name. When a session truly cannot be located, the answer says plainly that it couldn't find that session. It does not describe the search. The rule is backed by a test that pins the wording, like the existing `never present the newest sessions on the roster` assertion at `overview_agent.rs:933`.

**[B04] The decoration does not name a session the roster would refuse to list.** A `session_id` that `locate_transcript` cannot resolve, or that belongs to a session the roster withholds ([B06] in the Operator's own doctrine: private, worker and app-test sessions), gets no callsign or project from the boundary pass. The pass adds names. It must not become a way around the privacy rules the roster and `refuse_if_private` already enforce.

**[B05] The fix is pinned in unit tests over the verb boundary, not by a model eval alone.** Three tests: a `search.semantic` transcript hit, a `facts.search` row and a `posts` row for a session outside the 12 newest each come back with `callsign` and `project_dir`; and a private session's row comes back without them. `just operator-eval` makes real model calls and is outside `just ci`. It is a useful extra read after the prompt change, but it is not the guard.

---

## Non-goals {#non-goals}

- **Raising `SESSIONS_ROSTER_LIMIT`.** Any cap has a 13th session. The roster limit is about the size of the preamble ([Q02] in the code), and the fault is that a name depends on it at all.
- **Renaming "roster" in the code or the prompt.** The word is fine as an internal name. [B03] keeps it out of answers, which is the only place the user meets it.
- **Changing what the app does with an unresolvable atom.** When `<project>/<callsign>` doesn't resolve, the app shows plain text. That is correct. The fix here is to stop handing it guesses.

---

## Exit {#exit}

An arc, in `tugcast` only. Rough order of the first steps:

1. The boundary pass of [B01] and [B04] in `operator.rs`, with the tests of [B05].
2. The prompt edits of [B02] and [B03] in `overview_agent.rs`, with the wording test.
3. One `just operator-eval` read once both have landed.
