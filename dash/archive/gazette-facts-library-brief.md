# The Facts-Library — a durable fact base under the Gazette

This brief is the decided design for the **facts-library**: a permanent, structured store of facts about the work done through Tug — prompts, commits, shell commands, test runs, session lifecycle — recorded as it happens, queryable by the Operator, and fed to the Reporter. It is the next phase of the Gazette ([dash/gazette-plan.md](gazette-plan.md)), and it exists because of what a 2026-08-12 audit of the ledgers found: the Gazette's doctrine is *"gazette prose locates, ledgers confirm"* — and the ledgers mostly cannot confirm.

**Naming note:** the store is the **facts-library** (the newsroom's own name for its archive — the people who work in one call it the library). The ledger table is `facts`; the recording module is the librarian's desk, `feeds/facts_library.rs`. Never "morgue" in code or docs.

## Why: what the audit found

The Reporter and the Operator see complementary halves that never meet.

- **The Reporter is a transcript observer with amnesia.** Its buffer receives everything — every `tool_use` with full input (including Bash command text), every `tool_result` (including test output), user prompts, compact boundaries, subagent lifecycle — and discards it at every wake. The only durable residue is the ~44-word post.
- **The Operator is a ledger observer over thin ledgers.** Behind its nine verbs, the ground truth decays:
  - **Prompts are not stored.** `turns` is a pending journal (rows deleted on ack); `sessions.last_user_prompt` is one prompt, 256 chars, overwritten. `session.prompts` already ships a note apologizing for this.
  - **Session lifecycle has no event log.** `sessions` is a mutable current-state row: resume is indistinguishable from spawn, clear is `closed`→`pending` with no record, compaction and rename are written nowhere. The row is hard-deleted at 20-per-workspace / 90 days, cascading `file_events`, `turn_telemetry`, and metadata away with it — `changes.for_path` quietly loses answers as sessions age out.
  - **Shell is split down the middle.** Session-card `$` exchanges are stored verbatim in `shell_exchanges.db` (command, output, exit code, cwd; capped 500/session) — but no Operator verb reads them. Claude's Bash commands are parsed for attribution and discarded; the command text persists nowhere Tug owns.
  - **Commits have no table.** The `Tug-Session:` trailer is the only durable session↔commit join; the `CommitReceipt` (sha, files, numstat) is built at commit time and thrown away after the wire broadcast.
  - **Test runs leave no trace at all.** `TUG_APPTEST_JSON` is an ephemeral Justfile feature; nextest/bun runs write nothing.

The only permanent records in the system today: `gazette_posts` (lossy prose), `minted_tags` (identity only), and git itself. The Gazette already carved out the persistence posture this feature needs — `gazette_posts` is uncapped, append-only, survives session eviction, and is never drift-rebuilt ([P02] in the gazette plan). The facts-library extends that exact posture from prose to structure.

## The facts-library

One new table in the per-instance sessions ledger, beside `gazette_posts`, with the identical [P02] posture — append-only, uncapped, no session cascade, **never registered with `rebuild_table_if_schema_drifted`**, future columns via ALTER-based `migrate_facts_add_*` only:

```
facts(id INTEGER PRIMARY KEY AUTOINCREMENT,
      at_ms INTEGER NOT NULL,
      kind TEXT NOT NULL,
      session_id TEXT,           -- NULLable: some facts are app-scoped
      subject TEXT,              -- the fact's headline handle: a sha, a command incipit, a session name
      payload TEXT NOT NULL)     -- JSON, small and structured; never tool outputs, never file bodies
```

plus an FTS5 external-content index over a rendered text form (the `gazette_posts_fts` shape, [P13]), and indexes on `(kind, at_ms)` and `(session_id, at_ms)`. Rows are facts, not blobs — tens to low hundreds per working day — so uncapped is genuinely cheap.

**Home: the per-instance sessions ledger.** The Operator already reads it, the writer and janitor exist, and `gazette_posts` set the precedent. Shared `changes.db` was considered and rejected: it would bump `CHANGES_SCHEMA_VERSION` and raise cross-instance write questions for no v1 benefit.

## Fact kinds (v1)

Every kind is derivable from events already crossing tugcast. Recording happens at the sites that own each event — the supervisor, the agent bridge, the shell feed, the changeset commit path — **not** in the Reporter bridge. The facts-library accumulates whether or not the Gazette card is open.

| Kind | Source (exists today) | Payload |
|------|-----------------------|---------|
| `prompt` | the agent-bridge relay that already captures `user_message` for `last_user_prompt` | full prompt text (uncapped — prompts are small and the full text is the point) |
| `session.spawned` / `session.resumed` | `record_spawn` (whether the row already exists distinguishes the two) | workspace, project_dir, name/tag |
| `session.closed` / `session.errored` / `session.reset` / `session.renamed` | the supervisor's canonical state constructor + the rename control | state, detail, old/new name |
| `session.compacted` | the `compact_boundary` frame | trigger (auto/manual), pre/post tokens |
| `commit` | the `CommitReceipt` at the changeset commit path | sha, branch, message, files, numstat |
| `shell` | shell-feed settle (the `$` route) **and** the bridge's Bash `tool_use`/`tool_result` pair it already parses for attribution | command verbatim, ok/err, cwd, route (`user`\|`claude`) — output stays where it lives today |
| `test_run` | classification of `shell` facts for the runners we own | runner, verdict, pass/fail/skip totals |

**Every Bash command is captured** — not just file-touching or test-shaped ones. "What did we run" is exactly the Operator's business, and a command is one small row.

**`test_run` is the only kind needing new logic**: a timid classifier in the `shell_ops` spirit — recognize `cargo nextest`, `bun test`, `just app-test` (and the `VERDICT:` line its report prints, plus nextest's and bun's summary lines); parse the totals from the settled output tail; refuse to guess on anything else. `Unclassifiable` is a first-class outcome, exactly as `ParseOutcome::Unparseable` is.

**Fact classifiers are pure functions in a shared module.** The replay harness (below) must synthesize the same facts from transcript JSONL that the live recorders write, so the classification and payload-composition logic lives in one pure module both sides call — the same anti-drift posture [R01] imposed on the wake core, and for the same reason: what the harness calibrates must be what production runs.

## The Gazette is never disabled — sessions can be private

Superseding the `enabled` kill switch in the gazette plan's Table T02: **the Gazette subsystem always runs.** Closing the card hides the rail; it does not stop the Reporter, the recorders, or the library. What varies is *access*: a session may be marked **private**, and a private session is invisible to the whole subsystem —

- no facts recorded for it (the recorders check the flag at the owning sites),
- no frames enter the Reporter's buffer for it (no narration, no wakes),
- Operator verbs exclude it: its gazette posts and facts never appear in `facts.search`, `gazette.search`, `sessions.list`, `session.prompts`, `changes.for_session` results.

Privacy is per-session, held on the session row, toggleable at spawn or later. **v1 is from-now-on**: marking a session private stops new recording; facts and posts recorded while it was public remain. A retroactive scrub (delete a session's facts and posts on demand) is a legitimate follow-on — deletion-for-privacy does not violate the append-only posture, which exists to prevent *accidental* loss — but it is deliberately not in v1.

The `enabled` knob retires. If a break-glass switch proves necessary during bring-up it survives only as an undocumented tugbank escape hatch, not a product surface.

Non-goal held from the parent plan: recording facts is not a control surface — nothing here writes toward any work session, and the isolation invariants ([P12]) are untouched.

## Operator: the library desk

Two new verbs join the existing nine, executed by the same read-only, capped, 10s-timeout machinery ([P07]):

| Verb | Args | Backing | Cap |
|------|------|---------|-----|
| `facts.search` | `query`, opt `kind`/`session_id`/`since_ms`/`until_ms` | FTS5 over the rendered fact text, `bm25()`-ranked, filters against the content table | 30 facts, snippet excerpts |
| `facts.window` | `fact_id`, `n` | rowid window | n ≤ 20 each side |

And one free win over data that already exists: **`shell.history`** — a verb over `shell_exchanges.db` (`command`, `exit_code`, `cwd`, timestamps, capped output excerpt), filterable by session and time. The database is already written verbatim on every settle; it has simply never been read by the Operator.

`session.prompts` is repaired rather than replaced: it reads `prompt` facts (full history, permanent) plus the pending journal, and its apologetic `note` retires for sessions whose history postdates the library.

This closes the worked examples the audit found unanswerable: "what did I ask in that session yesterday" (`facts.search kind=prompt`), "what tests failed this morning" (`facts.search kind=test_run`), "when did I last clear that session" (`kind=session.reset`), "what did we commit Tuesday" (`kind=commit` — with git still the confirming source). And because facts survive session eviction, the Operator's memory stops decaying with the 20-session cap.

## Reporter: implications land in the same phase

Changing the fact base without re-reading the Reporter against it is not an option — the two ship together.

- **The composed wake input gains one labeled section**: `SETTLED FACTS SINCE YOUR LAST POST` — commits landed, test verdicts, session lifecycle events for the session, rendered as one line each. This touches `compose_reporter_input` and the rubric wording, **not** the frame allowlist ([Q02] stays closed) and not the wake logic. It hands the Reporter exactly the SHAs and totals its rubric wants to cite, from settled ground truth rather than whatever survived the 256 KB buffer.
- **Ref validation gains a second corpus.** Today a ref's target must appear verbatim in the buffered context ([R02]); a commit SHA that arrived via the facts section rather than the buffer must validate too. Validation extends to *buffer ∪ the facts lines composed into this wake's input* — still verbatim, still dropping what appears in neither, so the dead-chip guarantee is intact.
- **The calibration harness is re-run before the new diet ships.** `gazette-replay` synthesizes facts from the transcript through the shared classifier module, composes the same enriched input, and the three-cadence read from the gazette plan's Step 5 is repeated. The rubric was tuned against a facts-free diet; whether the facts section changes what the Reporter chooses to say (it should cite more and summarize less) is a question answered by reading, not by argument.
- **Dedup improves for free**: the last-K-posts mechanism stays, but a commit the Reporter already narrated is now visible as both a prior post and a fact, and the rubric can say "a fact you already posted about is not news twice."

## What stays out

- **No transcript mirror.** Claude's JSONL is already the full transcript; duplicating it into a ledger is a second source of truth. If prompt-level facts prove insufficient, the honest future design is a read-only `transcript.grep` verb over the JSONL files — a different feature, deliberately not this one.
- **No change to `changes.db`** — no new tables, no retention change, `CHANGES_SCHEMA_VERSION` untouched. `file_events` keeps serving the Changes card; the durable file-history story is `commit` facts plus git, which is what survives anyway.
- **No Pulse involvement.** Pulse is derived narrative, same class as gazette prose — never a fact source.
- **No fact rows for tool outputs or file contents.** The library stores facts about work, not the work's bytes.
- **No cross-instance library.** Per-instance, like the gazette itself.

## Verification items (for `/devise`)

- The private flag's storage (a `sessions` column vs. elsewhere) and its UI affordance (session card menu row? spawn option?) — including how the recorders read it cheaply on the hot paths.
- Whether the Bash `tool_use`/`tool_result` pairing site in the agent bridge (the attribution map keyed by `tool_use_id`) is the right place to emit the `shell` fact, or whether the fact should record at `tool_use` time with the outcome patched in a second row — leaning pair-at-result, one row, matching how attribution already waits for the pair.
- `test_run` totals-parsing coverage: the three runners' summary formats, and what a truncated `tool_result` (`output_truncated`) does to the tail parse — an unparseable tail records the run with `verdict: "unknown"`, never a guessed count.
- The rendered-text form the FTS index carries per kind (what makes `prompt` vs `commit` vs `shell` facts *findable* — e.g. a commit fact's text is sha + subject + file list).
- Whether `session.spawned`/`resumed` facts should also record the workspace key so `facts.search` can scope by project the way `sessions.list` does.
- The facts section's size cap in the composed wake input (it must never crowd the frame window it supplements).

## Phasing sketch

1. **The library** — table + FTS + `record_fact` + the shared classifier module, unit-tested; nothing observable yet.
2. **The recorders** — prompt, lifecycle, commit, shell (both routes), test_run, each at its owning site; private-flag checks; facts visibly accumulating (inspect via `just db-inspect`).
3. **The desk** — `facts.search`, `facts.window`, `shell.history`; `session.prompts` repaired; worked examples answered in the live app.
4. **The Reporter's new diet** — harness synthesis, the re-calibration read, the composed-input section, ref-validation extension; cadence/rubric adjusted from the reading.
5. **Privacy surface + proof** — the toggle UI, app-test, docs.

Each phase is independently useful; the Reporter phase is deliberately gated on a human read of the harness output, exactly as the gazette plan's Phase B was.
