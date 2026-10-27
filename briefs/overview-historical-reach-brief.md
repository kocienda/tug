<!-- brief-skeleton v1 -->

# Overview Historical Reach

**Purpose:** The Overview promises "Ask Tug about your work, recent or historical", and the Operator behind it cannot see past a few days of one ledger, cannot page, cannot state where its record ends, and cannot read a transcript. Make the promise true against the records Tug already keeps.

---

## Purpose {#purpose}

The user asked the Overview "What's the oldest session you can refer to?" and got the newest session in the roster, a claim that "all the sessions I can see are from Oct 27, 2026", and two lookups before August that "came back empty" and were read as proof that nothing older existed. When pushed, the Operator named a 50-session limit. The user's response:

> WHY do we have this when I am *explicitly asking* about historical sessions? Can't we look back further? Don't we have a ledger? Aren't these sessions possibly still on disk as JSON? I think we really need to do a better job of living up to the Overview claim that you can ask about your historical work!

The user also asked whether moving the Overview to Sonnet would help. It is already on Sonnet ([F07]); the failure is in what the model is handed, not in the model.

---

## Evidence {#evidence}

**[F01] `sessions.list` is a wall, not a page** — `tugrust/crates/tugcast/src/feeds/operator.rs` caps the verb at `SESSIONS_LIMIT = 50`, and `SessionLedger::list_sessions_recent` orders by `last_used_at DESC` with no cursor, no `oldest` order, no filter on `created_at`, and no total. The pre-verb roster (`SESSIONS_ROSTER_LIMIT = 12`) is the same ordering. `facts.list` is the same shape at `FACTS_LIST_LIMIT = 30`. "Which session started first" is unanswerable by construction: the only way to reach the oldest row is to guess `until_ms` brackets inside a two-round cap. **(verified)**

**[F02] The Operator reads one ledger, and that ledger's deep facts are six days old** — `OperatorContext.ledger` is the instance's `SessionLedger` (`boot/supervisor.rs`). On the live `release-main` instance: 198 session rows back to 2026-09-19 (revived by the index repair), 34 of them used on 2026-10-27, but `session.spawned`, `session.resumed`, `prompt` and `commit` facts begin 2026-10-21, the instance's birth; `shell` facts begin 2026-09-29. So "spawn facts before August" was always going to be empty, and the roster of 12 most recently used sessions was what made every visible session "from Oct 27". Measured with `just db-inspect` on a copy. **(verified)**

**[F03] Nothing tells the model where the record ends** — `OPERATOR_RETRIEVE_INSTRUCTIONS` and `OPERATOR_ANSWER_INSTRUCTIONS` (`feeds/overview_agent.rs`) supply a `NOW:` line and describe `sessions.list` as "the roster below, gone deeper and further back", with no horizon. An empty page therefore reads as absence, which is the same confident-wrong shape the horizon clause for `git.log` was written to stop. **(verified)**

**[F04] Deeper records exist on the machine and the Operator reads none of them** — measured on 2026-10-27:

| Source | Rows | Reach | Operator reads it |
|---|---|---|---|
| `release-main` ledger `sessions` | 198 | since 2026-09-19 | newest 50 only |
| `session_index.db` (every instance) | 1078 | since 2026-09-21 | no |
| `prompt_history.db` (full prompt text, session id, project path) | 4360 | since 2026-07 (one 2023 import row) | no |
| ledger `external_scan_cache` | 1240 | since 2026-09-19 | no |
| transcripts under `~/.claude/projects` | 4957 files, 4 GB; 1209 in the tug dir | rolling 30 days | no |

The prompt verb `session.prompts` reads the 698 `prompt` facts since 2026-10-21 and otherwise falls back to a session row's single `last_user_prompt`. `prompt_history.db` holds every prompt since July, machine-wide, with no retention policy by design (`CLAUDE.md`). **(verified)**

**[F05] Claude Code sweeps transcripts at 30 days** — `~/.claude/settings.json` sets no `cleanupPeriodDays`, so the default of 30 applies, and `~/.claude/.last-cleanup` was stamped 2026-10-27T21:35Z. The oldest transcript on disk is from 2026-09-20. The JSON "still on disk" is a window that slides forward daily. **(verified: settings and stamp read; the 30-day default is Claude Code's documented behaviour, not measured here)**

**[F06] About half the transcripts on disk are Tug's own noise** — the two largest transcript directories are the shared-agent home (1728 files: the Overview's Haiku and Sonnet workers) and `tugrust/target/tug-test-data/.../shared-agent` (497), with 200 further `apptest`/`var-folders` stub directories. None is the user's work, and a naive "oldest transcript" sweep would name one. **(verified)**

**[F07] The Overview already runs on Sonnet** — `overview_agent::DEFAULT_MODEL` is the `sonnet` alias for both the Operator's retrieve and answer jobs, overridable through the Overview model setting. Only the search ladder's last rung and the classifiers run on `claude-haiku-4-5`. A model change addresses nothing in [F01]–[F04]. **(verified)**

**[F08] A bounded transcript reader already exists** — `tugcore::session_transcript` (`read`, `select`, `render`) backs `tugtool session show --last/--turn/--grep`, opens the JSONL read-only, and renders user turns, assistant text and one-line tool summaries without thinking or tool output. `tugcore::session_finder` resolves a uuid or callsign to its file across instances. The Operator has no verb over either. **(verified)**

---

## Decisions {#decisions}

**[B01] The Operator is handed the horizon beside `NOW:`.** A `HORIZON:` line reports, per source, the oldest session start, the oldest prompt, the oldest fact, and the session count. An empty result then reads against a known edge, and "nothing before August" becomes "the record begins on Sep 19" in one round. This is the smallest change and the one that fixes the answer the user actually received ([F02], [F03]). The retrieve and answer instructions say what the line is and that absence past the horizon is the record's edge, not the work's.

**[B02] `sessions.list` becomes a page: `order`, a cursor, and a `total`.** `order` takes newest or oldest, by start time or by last use; a cursor carries the walk across rounds; `total` says how many match the filter. The 50-row cap and the 12-row roster stay, because a page with a cursor is bounded context rather than a wall, while a raised cap would put the whole table into every answer that touches the verb ([F01]). `facts.list` gets the same `order` and cursor.

**[B03] `sessions.list` reads the union the picker sees, and the prompt verbs read `prompt_history.db`.** Ledger rows plus `external_scan_cache` plus `session_index.db` across every instance, de-duplicated by session id and folded by line the way the picker folds them; a row's source travels with it so the answer can say which ledger knew it. `session.prompts` reads `prompt_history.db` first and the `prompt` facts second, so a session's prompts reach back to July rather than to Oct 21 ([F04]). Every open is read-only, through `tugcore::ledger_db` where a Tug ledger is involved, and a missing file or table is an empty answer.

**[B04] A `session.transcript` verb comes online in this arc, not a later one.** The user's call. It takes `session_id` plus `last`, `turn`, or `grep`, resolves the file through `tugcore::session_finder`, renders through `tugcore::session_transcript`, and is capped like `repo.read` (`READ_MAX_LINES`, `READ_MAX_BYTES`), with the header's turn count always returned so the model knows what it abridged ([F08]). A session whose transcript the sweep has taken answers with that fact rather than an error, and the ledger's own record for it still stands. The verb is read-only and never resumes, touches or writes a session.

**[B05] Default scope is the asking workspace's sessions and projects; a cross-project or cross-workspace question is answered across the machine.** The roster, the horizon, and a bare `sessions.list` are scoped to the instance's ledger and its project dirs. A question that names another project, a session outside the workspace, or says "everywhere", "all projects", "any workspace" widens the same verbs to the union in [B03] across every instance, and the answer says it did. The user's words: "by default, the Overview should work against the current workspace session and projects. However, if the user asks a cross-project or cross-workspace question, we should do our level-best to answer it."

**[B06] Tug's own sessions are excluded from the history surface.** Sessions whose project dir is the shared-agent home (under the instance's data dir or under a `target/tug-test-data` tree) and sessions recorded by an `apptest-*` instance are filtered at the union, so neither the roster, the horizon, nor a transcript lookup ever offers one as the user's work ([F06]).

**[B07] Tug does not step beyond what Claude Code does with transcripts for now.** No offer to set `cleanupPeriodDays`, no copying of transcripts into the instance dir, no durable per-turn digest of transcripts. Tug's own ledgers and indexes are the durable record, and the transcript verb reads whatever Claude Code still has ([F05]). The user's call; what would reopen it is a user asking for a session the sweep has taken and finding Tug's record of it too thin.

**[B08] No model change.** Both Operator personas already run on Sonnet ([F07]). The Overview model setting stays as the knob it is.

---

## Open Questions {#open-questions}

- **Does `prompt_history.db`'s `session_id` map one-to-one onto ledger and index session ids?** It is the Claude session id the deck submitted under, so it should, but a segment split or a forked session may leave prompts under an id the index knows only as an ancestor. `session_lineage` in the same database is the likely bridge. The step that wires [B03] reads both before relying on the join.

---

## Non-goals {#non-goals}

- **Raising the 50-row cap.** It puts the whole session table into the answering model's context and leaves [F02]–[F05] untouched; a cursor is the page.
- **Changing the Overview's model.** Already Sonnet ([F07]).
- **Touching `~/.claude/settings.json` or copying transcripts.** Rejected for now by [B07].
- **Indexing Tug's own worker and app-test transcripts.** They are machine activity, excluded by [B06].
- **A machine-wide default scope.** Rejected by [B05]; the machine is reachable on request, not by default.
- **Resuming, writing to, or otherwise touching a session the transcript verb reads.** Reading is reading, as `tugtool session show` already holds.

---

## Exit {#exit}

**An arc.** The shape that falls out of the decisions, in the order they depend on each other:

1. The horizon line and the instruction text that reads it ([B01]), with the pinned-instruction tests in `overview_agent.rs` extended to cover it.
2. `order`, cursor, and `total` on `sessions.list` and `facts.list` ([B02]), with the ledger queries and verb tests.
3. The union read for sessions and the `prompt_history.db` read for prompts, with the shared-agent and `apptest-*` exclusion and the per-row source ([B03], [B06]), scoped by the workspace default and widened on a cross-project question ([B05]).
4. The `session.transcript` verb over `tugcore::session_finder` and `tugcore::session_transcript`, capped like `repo.read`, added to `VERB_NAMES` and both instruction lists ([B04]).
5. A replay through `tugtool operator-ask` of the question that started this: "What's the oldest session you can refer to?" should name the 2026-09-19 session with its callsign, say where each source's record begins, and never report an empty page as absence.
