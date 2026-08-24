<!-- devise-skeleton v4 -->

## The Facts-Library — a durable fact base under the Gazette {#facts-library}

**Purpose:** Ship the **facts-library** decided in [dash/gazette-facts-library-brief.md](gazette-facts-library-brief.md): a permanent, structured store of facts about the work done through Tug (prompts, session lifecycle, commits, shell commands, test runs), recorded at the sites that own each event, queryable by the Operator through new verbs, fed to the Reporter as settled context — plus the per-session privacy flag that replaces the Gazette's `enabled` kill switch.

**Naming note:** the store is the **facts-library** (never "morgue"); the ledger table is `facts`; the shared pure module is `feeds/facts_library.rs`.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | vetted — fixups applied |
| Target branch | main |
| Last updated | 2026-08-12 |

> **Second vet pass, 2026-08-12.** Re-verified the first pass's eight findings against the tree — all eight hold at the lines they imply ([P11]'s held mutex at `record_spawn`'s `conn.transaction_with_behavior(Immediate)`, [P06]'s `declared_ops_for_command`-gated `pending_cmds` plus the `cargo build → None` pin, `shell_dispatcher_task`'s ledger-less signature, the `changes.`-attached `file_events` that makes `NOT EXISTS` necessary, and the deck's exhaustive `Record<LocalCommandName, …>`). Three new fixups folded in. **The `ENABLED_KEY` checkpoint was self-falsifying:** `feeds/pulse.rs`'s `PULSE_ENABLED_KEY` contains the string, so a bare grep failed a correct deletion — both greps are now `-w`. **The harness could not have synthesized `session.compacted`:** `translate_transcript` gates on `kind != "assistant" && kind != "user"` and so drops the `system`/`subtype: "compact_boundary"` record entirely, so #step-8 now carries the translator arm and its pin, and `post_tokens` is documented as optional at both the payload and the rendering. **The spawned-vs-resumed reading for scan-adopted sessions is now decided** in [P11] rather than left for #step-3 to guess: an adoption records `spawned` (first appearance in *this* ledger) and is not reclassified from the `external_scan_cache` seed.
>
> **First vet pass, 2026-08-12.** Assessed against the real tree; eight findings folded in. Three were defects that would have bitten mid-build: the Claude-route shell capture cannot reuse the attribution maps, because `pending_cmds` only admits commands `declared_ops_for_command` parses as file operations and `open_bash` only opens for live in-repo calls — so builds and test runs, the entire `test_run` source, are absent from both ([P06] now mandates a new unfiltered map, with a `cargo nextest` regression test in #step-4); `record_fact` called from inside `record_spawn` would deadlock on the non-reentrant ledger mutex ([P11] adds the `_tx` form, and notes `record_spawn` already computes the spawned-vs-resumed disposition); and `feeds/shell.rs` has no `SessionLedger` handle at all, so #step-4 threads one through `shell_dispatcher_task`. Also folded in: the privacy exclusion must be `NOT EXISTS` rather than a join, since `changes.db` is machine-global and other-instance rows have no local `sessions` row; privacy gained a resting display (the flag rides `build_session_updated_frame` to a chip marker) because a transient ack alone leaves the mode invisible after reload; [Q01] now states the [L30] posture explicitly (no `SLASH_BRIDGES` row — `btw`/`join` are the precedent); `validate_refs` takes a slice of corpora rather than a concatenation; and [P07] states that a `test_run` verdict comes from the parsed summary, never from `is_error` or `exit_code`.

---

### Phase Overview {#phase-overview}

#### Context {#context}

The Gazette's doctrine is *"gazette prose locates, ledgers confirm"* — and a 2026-08-12 audit found the ledgers mostly cannot confirm. The Reporter sees everything (full `tool_use` inputs including Bash command text, full `tool_result` outputs, prompts, compact boundaries) and discards it at every wake; its only durable residue is the ~44-word post. The Operator reads durable ledgers, but they are thin: prompts are not stored (`turns` is a pending journal deleted on ack; `sessions.last_user_prompt` is one overwritten 256-char snippet — the `session.prompts` verb in `feeds/operator.rs` ships a `note` apologizing for exactly this); session lifecycle has no event log (`sessions` is a mutable current-state row, hard-deleted at 20-per-workspace / 90 days, cascading `file_events` and telemetry away with it); Session-card `$` commands are stored verbatim in `shell_exchanges.db` but **no verb reads them**; Claude's Bash commands are parsed for attribution (`tugchanges-core::shell_ops` via `feeds/attribution.rs`) and the command text discarded; commits leave no ledger row (the `CommitReceipt` is built at commit time in `feeds/changeset.rs::run_changeset_commit` and thrown away after the `changeset_commit_ok` broadcast — only a synthetic `/commit` shell-ledger row and the `Tug-Session:` git trailer survive); test runs leave nothing anywhere.

The only permanent records today are `gazette_posts` (lossy prose), `minted_tags` (identity), and git. `gazette_posts` already carved out the persistence posture this feature needs — uncapped, append-only, no session cascade, never drift-rebuilt (gazette plan [P02]) — and this plan extends that exact posture from prose to structure. Three user decisions from the brief govern the design: **every** Bash command is captured; the Gazette is **never disabled** (the `enabled` knob retires; a per-session **private** flag is the access control); and the Reporter's diet changes ship **in the same plan**, re-calibrated through `gazette-replay`, never deferred.

#### Strategy {#strategy}

- Bottom-up along the data path: the `facts` table + FTS → the pure classifier/rendering module → the recorders at their owning sites → the Operator's library verbs → privacy → the Reporter's new diet → the calibration re-read.
- One pure module (`feeds/facts_library.rs`) holds every classifier and every rendered-text form, consumed identically by the live recorders and the `gazette-replay` harness — the same anti-drift posture the gazette plan's [R01] imposed on the wake core, for the same reason: what the harness calibrates must be what production runs.
- One rendering per fact, used twice: the `text` column feeds both the FTS index and the Reporter's `SETTLED FACTS` input section, so search and narration can never describe the same fact differently.
- Recorders are unconditional (no enabled gate) and idempotent (a nullable `dedupe_key` with `INSERT OR IGNORE`, mirroring `file_events`' PK idempotency), because the agent-bridge relay re-streams replayed frames on resume and a fact must land exactly once.
- Privacy is enforced at three choke points — write time (recorders), wake time (the Reporter), query time (the verbs) — never per-frame, so no hot path gains a DB read.
- The Reporter re-calibration is a human gate, exactly as the gazette plan's Phase B was: the new diet ships only after the harness output is read.

#### Success Criteria (Measurable) {#success-criteria}

- After a working session with prompts, Claude Bash commands, a `$` command, a test run, and a `/commit`, `just db-inspect sessions.db "SELECT kind, subject FROM facts ORDER BY id"` shows `prompt`, `session.*`, `shell`, `test_run`, and `commit` rows with correct subjects — and re-opening the same session (resume replay) adds **zero** duplicate rows.
- The Operator answers "what did I ask in that session earlier" from `facts.search kind=prompt` (full text, not a 256-char snippet), "what tests failed today" from `test_run` facts, and "what shell commands ran" from `shell.history` — each verified live with the built app.
- A session marked `/private` produces no new facts, no Reporter posts, and disappears from `sessions.list` / `session.prompts` / `changes.for_session` / `facts.search` results (unit tests + live check); marking it public again resumes recording from that moment. **Its chip shows the private marker, and still shows it after a reload** — the state is legible without retyping the command.
- A Claude-run `cargo nextest run` (a command no attribution map admits) produces both a `shell` and a `test_run` fact — the [P06] regression check that the new unfiltered map is really being used.
- The `enabled` knob is gone: `grep -rnw ENABLED_KEY tugrust/crates/tugcast/src` returns nothing, and the Reporter narrates with no tugbank row present. **The `-w` is required, not cosmetic:** `feeds/pulse.rs` declares `PULSE_ENABLED_KEY`, which contains `ENABLED_KEY` as a substring, so a bare `grep` reports failure after a perfectly correct deletion.
- `just gazette-replay <session.jsonl>` composes wake inputs carrying a `SETTLED FACTS SINCE YOUR LAST POST` section synthesized through the same `facts_library` classifiers, and the re-read at the shipped cadence is done by a human before #step-9 closes.
- A ref whose target appears only in the facts section (not the frame buffer) validates and renders as a live chip; a target in neither is still dropped (unit test).
- `cd tugrust && cargo nextest run -p tugcast` green; `cd tugdeck && bun test && bun run check && bunx vite build` green; `just app-test-changed` green.

#### Scope {#scope}

1. Ledger: uncapped `facts` table + FTS5 index + `dedupe_key` idempotency in the per-instance sessions ledger; `sessions.private` column + migration.
2. The pure `feeds/facts_library.rs` module: fact kinds, payload composition, rendered text, the shell/test-run classifiers.
3. Recorders at owning sites: prompt + compact (agent bridge), lifecycle (supervisor + `record_spawn` disposition), commit (changeset commit path), shell both routes, `test_run` derivation.
4. The always-on posture: retire the `enabled` knob from `gazette_agent.rs`, `reporter.rs`, `main.rs`.
5. Operator: `facts.search`, `facts.window`, `shell.history` verbs; `session.prompts` repaired; instruction strings + pinning tests updated.
6. Privacy: `set_session_private` CONTROL verb, verb/wake/write exclusions, the `/private` composer command in tugdeck.
7. Reporter: the `SETTLED FACTS` input section, the two-corpus ref validation, harness synthesis, the calibration re-read.

#### Non-goals (Explicitly out of scope) {#non-goals}

- No transcript mirror — Claude's JSONL stays the only full transcript; a `transcript.grep` verb is a different future feature.
- No change to shared `changes.db` — no new tables, no retention change, `CHANGES_SCHEMA_VERSION` untouched.
- No Pulse involvement — derived narrative is never a fact source.
- No fact rows for tool outputs or file contents — facts about work, never the work's bytes (the 200-byte `file_event_spans` heads and `shell_exchanges.output` stay where they live).
- No retroactive privacy scrub — v1 privacy is from-now-on; deletion-on-demand is a named follow-on.
- No cross-instance library; no deck rendering of facts (the card shows posts; facts are the Operator's and Reporter's ground truth).
- No new FeedId — facts never ride the wire; privacy rides CONTROL.

#### Dependencies / Prerequisites {#dependencies}

- The Gazette shipped end-to-end (`dash/gazette-plan.md`, all steps done) — the `gazette_posts` table, `feeds/reporter_wake.rs`, `feeds/reporter.rs`, `feeds/operator.rs`, `feeds/gazette_agent.rs`, `feeds/gazette_replay.rs` all exist on main.
- FTS5 confirmed compiled-in (the permanent probe test in `session_ledger.rs` creates and drops an fts5 table).
- `shell_exchanges.db` written verbatim on every `$`-route settle (`shell_ledger.rs::record_exchange`, called from `feeds/shell.rs` on `exchange_complete`).

#### Constraints {#constraints}

- `-D warnings`; `cargo nextest run` is the runner; writable ledger opens via `tugcore::ledger_db` (`no_ad_hoc_ledger_opens`).
- `facts` lives in the per-instance sessions ledger — **never** registered with `rebuild_table_if_schema_drifted`; future columns via ALTER-based `migrate_facts_add_*` only ([P01]).
- App-tests stay model-free: the SharedAgent pool is gated under `TUGAPP_APP_TEST=1`; recorders write no model traffic so they run everywhere.
- tugdeck: the `/private` command adds no persistent deck state; anything that did would go through tugbank defaults, never Web storage.
- Never point `sqlite3` at live ledgers; verify with `just db-inspect`.

#### Assumptions {#assumptions}

- Fact volume is small (tens to low hundreds of rows per working day), so uncapped-forever is cheap; prompts are the largest payloads and are capped at 16 KB with an elision marker.
- The agent-bridge relay's line inspection (the same fast-path that matches `"type":"tool_use"` for attribution) is cheap enough to also match `compact_boundary` — it already string-matches every outbound line.
- `record_spawn` can report whether the row pre-existed (it is a single UPSERT today; the disposition is one `SELECT 1` inside the same lock).

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Privacy affordance (DECIDED) {#q01-privacy-affordance}

**Question:** Where does the user mark a session private?

**Resolution:** DECIDED 2026-08-12 with the user — a **composer slash command**, `/private`, toggling the flag for the composer's session. It joins `LOCAL_SLASH_COMMANDS` in `tugdeck/src/lib/slash-commands.ts` and the session card's exhaustive `RUN_SLASH_COMMAND` handler map (adding the entry forces the handler via `Record<LocalCommandName, …>`). No menu row, no spawn-time option in v1.

**[L30] posture, stated so it is not rediscovered as a suspected violation.** `command-registry.ts` carries a `SLASH_BRIDGES` table that mints one `CommandEntry` per bridged slash command — its own title, its own `menuItemId`, a native Swift menu row, optionally a chord — all dispatching the single `RUN_SLASH_COMMAND` action with a different `name`. **`/private` deliberately gets no `SLASH_BRIDGES` row**, because the user chose a composer command specifically *over* a menu row. That is not a law bypass: the law is satisfied by `RUN_SLASH_COMMAND` already being a registry entry invoked through the funnel, and the precedent is direct — `btw`, `join`, `shell`, `model`, and `logout` all live in `LOCAL_SLASH_COMMANDS` with no bridge row. Do not add one; a bridge would put back the menu item the decision declined.

#### [Q02] Does the facts section change what the Reporter says? (DECIDED) {#q02-diet-recalibration}

**Question:** The rubric was tuned against a facts-free diet; the `SETTLED FACTS` section hands the Reporter SHAs and test totals it previously only saw if they survived the 256 KB buffer. Does it now cite more and summarize less, or does the section distract it?

**Why it matters:** The gazette's cadence and voice were set by reading, not argument; a diet change unread is a regression waiting to be noticed in production.

**Plan to resolve:** #step-9 runs `just gazette-replay` on a real transcript with facts synthesis on, at the shipped 90s cadence, and a human reads it against the same transcript's facts-free run. Rubric wording adjustments land there if the reading demands them.

**Resolution:** DECIDED 2026-08-12 by the #step-9 read. **The section earns its place, the rubric needed no wording change, and the read found one defect worth fixing.**

The read: `ae5483a7-6664-486f-8da9-25560722973a.jsonl` (5h03m, 380 frames, a real Changes/Project-Diff feature session), replayed twice at the shipped 90s cadence — once with facts, once with `--no-facts`. Segmentation is identical by construction (19 wakes: 5 turn-end, 14 sitrep), so the diet is the only variable. **`--no-facts` is new**, added for this read: the baseline had to come from the same binary, or the diet would not have been the only thing that changed between the two runs.

- **It cites more, and more exactly.** Facts-run posts name test totals off the settled counts (`bun test (6019 passed, 0 failed)`, `6032 unit tests pass`) and the app-test files by name. The facts-free run cites numbers too — this session ran its suites inside the window — but takes them from tool output the byte cap can drop, and it produced one near-miss (`6019 unit tests all pass` over a window that also held a later count). The facts column cannot drift that way: the number in the section is the number the classifier parsed.
- **It does not crowd — it tightens.** Posts got *shorter*: 781 words over 16 posts (≈49 each) with facts, 1067 over 18 (≈59) without, against a 60-word budget. The section hands the model the specifics, so it spends fewer words reconstructing them from tool output.
- **Dedup improved, as [P10] predicted.** 16 posted / 2 silent with facts, 18 posted / 1 silent without. The extra silence is a wake whose facts were all things the previous post had already announced — the "not news twice" clause working.
- **One unparseable envelope** in the facts run (a doubled `{"post": {"post": …}}` nesting, wake 2, over a small section). One in 19, no analogue in the facts-free run, and not a failure mode the section plausibly causes — the answer was well-formed prose inside a wrongly-nested wrapper. Recorded rather than acted on; the harness already separates it from editorial silence, which is what makes a rising rate visible.
- **The defect the read found:** Claude Code spells a local slash command as a *user message* (`<command-name>/model</command-name>`, `<command-args>…`) and echoes its result back as `<local-command-stdout>…`. Both were landing as `prompt` facts, so every wake carried two lines of machinery in place of what the person asked, and `session.prompts` would have answered "what did I ask" with `/model` and its own confirmation. Fixed as a pure predicate — `facts_library::is_local_command_bookkeeping` — gated at both the live recorder in `agent_bridge.rs` and the harness synthesis, so the refusal is one rule rather than two spellings of one. Re-read after the fix: the sections carry prompts only.

**No `REPORTER_POST_INSTRUCTIONS` wording changed.** The facts paragraph as written produced the intended behavior on first reading — cited subjects verbatim, did not re-announce, did not lead with the section — and cadence knobs stay untouched by this plan.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Resume replay double-records facts | high | high | `dedupe_key` UNIQUE + `INSERT OR IGNORE` ([P03]); replay-path recorders must supply a key, pinned by a replay test | any duplicate row observed |
| A future `facts` column wired to the drift guard erases all history | high | low | [P01]'s stated exemption + ALTER-only migration rule commented at the DDL, exactly as `gazette_posts` | any schema change to the table |
| Giant pasted prompts bloat the ledger | low | med | prompt payload capped 16 KB with elision marker; `text` rendering capped ([S02]) | ledger growth complaints |
| test_run classifier misreads a runner's output | med | med | timid posture: known runners only, `verdict: "unknown"` on an unparseable tail, never a guessed count ([P07]) | wrong totals in an Operator answer |
| Privacy check races a wake in flight | low | low | wake-time check discards the buffered window of a private session before composing; recorders check at write time | a private session's post appearing |
| Facts section crowds the frame window | med | low | section capped at 20 facts / 4 KB, oldest dropped with a marker ([S03]); [Q02]'s read confirms | truncated windows in `--show-input` |

**Risk R01: Two renderings of the same fact drift apart** {#r01-render-drift}

- **Risk:** FTS indexes one wording while the Reporter reads another, so search and narration disagree about what a fact says.
- **Mitigation:** There is only one rendering — `facts_library::render_text` writes the `text` column, and both FTS and `SETTLED FACTS` consume that column ([P02]).
- **Residual risk:** A rendering improvement changes only new rows; acceptable — old rows stay searchable by their own wording.

**Risk R02: The relay hot path slows under recording** {#r02-hot-path}

- **Risk:** Fact writes on the agent-bridge relay path add latency to frame forwarding.
- **Mitigation:** Facts are event-rate (per prompt, per Bash settle, per compact), never frame-rate; each write is one `INSERT OR IGNORE` on the same ledger the relay already writes `file_events` to, and it is best-effort (a failed write warns, never gates the forward — the `record_user_prompt` posture).
- **Residual risk:** None worth naming; `file_events` already proved this shape.

---

### Design Decisions {#design-decisions}

#### [P01] The facts table takes the gazette_posts posture verbatim (DECIDED) {#p01-facts-posture}

**Decision:** One `facts` table in the per-instance sessions ledger (`SessionLedger::bootstrap_schema`'s `execute_batch`, beside `gazette_posts`), append-only, **uncapped**, **no session cascade**, **never registered with `rebuild_table_if_schema_drifted`**; future columns via ALTER-based `migrate_facts_add_*` only, following `migrate_pulse_lines_add_intent`. The FTS shadow tables are derived and freely rebuildable — the same asymmetry `gazette_posts` documents.

**Rationale:**
- Permanence is the point: facts must survive the 20-per-workspace / 90-day session eviction that guts every other history surface, exactly as `gazette_posts` does.
- The sessions ledger already has the writer lock, the integrity gate, and the Operator's read handle; shared `changes.db` would bump `CHANGES_SCHEMA_VERSION` and raise cross-instance write questions for no v1 benefit.

**Implications:** DDL comment restating the exemption (copy the `gazette_posts` comment's structure); indexes on `(kind, at_ms)` and `(session_id, at_ms)`; the drift-guard wiring in `bootstrap_schema` is not touched.

#### [P02] One rendering per fact, used by FTS and the Reporter both (DECIDED) {#p02-one-rendering}

**Decision:** Every fact stores a one-line `text` rendering produced by `facts_library::render_text(kind, subject, payload)`. The FTS index covers `(subject, text)`; the Reporter's `SETTLED FACTS` section prints `- [at_ms] <text>` lines from the same column.

**Rationale:** Search and narration describing the same fact differently is a drift bug by construction; a single stored rendering makes it impossible (Risk R01).

**Implications:** `record_fact` computes and stores `text` at write time; the harness's synthesized facts render through the identical function.

#### [P03] Recorders are idempotent via dedupe_key (DECIDED) {#p03-idempotency}

**Decision:** `facts.dedupe_key` is a nullable TEXT with a UNIQUE index; `record_fact` uses `INSERT OR IGNORE`. Recorders on replayable paths **must** supply a key; live-only paths may pass `NULL`.

**Rationale:** The agent-bridge relay processes replayed frames on resume (that is how `file_events` back-fills, with `origin = "replay"` and PK idempotency). A `shell` or `session.compacted` fact recorded from that stream would otherwise duplicate on every resume. Back-fill is *desirable* — a resumed session's pre-tugcast history becomes facts — and the key is what makes it safe.

**Implications:** Keys per kind: `shell:<session>:<tool_use_id>` (Claude route), `compact:<session>:<frame timestamp>`, `test:<same suffix as its shell fact>`, `commit:<sha>`; `$`-route shell and lifecycle facts are live-only and pass `NULL`. A replay test drives the same frame pair twice and asserts one row.

See also [P11], which governs *how* a recorder writes when the caller already holds the ledger lock.

#### [P04] Facts flow unconditionally; the enabled knob retires (DECIDED) {#p04-always-on}

**Decision:** Recorders have no enable gate. The `ENABLED_KEY` knob is deleted from `feeds/gazette_agent.rs`; the `enabled` closure is removed from `ReporterBridgeConfig` (`feeds/reporter.rs`) and its three call sites (`handle_code_frame`, `handle_submission_frame`, `wake`); `main.rs` drops the `gazette_enabled` closure. Replay-mute bookkeeping stays exactly as is (it tracks the wire, not any toggle).

**Rationale:** User decision in the brief: the Gazette is never truly disabled — closing the card hides the rail; privacy is the access control. A break-glass, if ever needed, is a follow-on escape hatch, not a shipped surface.

**Implications:** The bridge test that scripts the disabled knob is removed; the mute-while-disabled comment in `reporter_wake.rs::forwardable_session`'s doc is reworded (mute still tracks the wire — the *reason* clause about the toggle goes).

#### [P05] Privacy: a sessions column, enforced at three choke points (DECIDED) {#p05-privacy}

**Decision:** `sessions.private INTEGER NOT NULL DEFAULT 0`, added by a self-healing `migrate_sessions_add_private` (the `migrate_sessions_add_name_user_set` shape) and defined in the CREATE TABLE for fresh DBs. Enforcement:

- **Write time:** `record_fact` refuses (silently, `Ok`) when the fact names a session whose row is private; app-scoped facts (`session_id = NULL`) always record.
- **Wake time:** the Reporter's `wake()` in `feeds/reporter.rs` reads the flag once per wake (wakes are rare); a private session's taken window is discarded — no job, no post. Frames still buffer (bounded by the existing caps) so a session made public again narrates only from that point.
- **Query time:** `sessions.list`, `session.prompts`, `changes.for_session`, `changes.for_path`, `facts.search`, `facts.window`, and `shell.history` exclude sessions whose row is currently private; `gazette.search` is not filtered — posts written while public are channel history per the brief's from-now-on rule.

**The exclusion is `NOT EXISTS`, never a join — this is a correctness requirement, not a style choice.** `changes.file_events` lives in the machine-global shared `changes.db` while `sessions` is per-instance, so a file event belonging to *another instance's* session has **no local `sessions` row at all**. An `INNER JOIN sessions` would silently drop those legitimate rows from `changes.for_path`, quietly shrinking the Operator's answers. The correct predicate is `AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.session_id = <row's session id> AND s.private = 1)` — an absent row reads as not-private and stays in the results.

The toggle is a `set_session_private { tug_session_id, private }` CONTROL verb in `feeds/agent_supervisor.rs::handle_control` (beside `"rename_session"`), answered by a `set_session_private_ok` broadcast; the deck's `/private` command sends it ([Q01]).

**Rationale:** Per-frame checks would put a DB read on the hottest path in the crate; the three choke points cover every exit the subsystem has. From-now-on semantics are the brief's decided v1.

**Implications:** No new FeedId; the flag lives where every enforcement site already holds a ledger handle. A `session.private` toggle records **no fact** (recording the act of hiding would leak the hiding).

**Privacy is a resting state, so it must have a resting display.** A transient ack is not enough: after a reload the mode would be invisible, and a session silently not being narrated with nothing on screen to say why is precisely the kind of resting lie this codebase refuses. Two consequences, both required:

- **`private` rides the session row to the deck.** It joins `SessionRow` and the `session_updated` push payload (`build_session_updated_frame` in `feeds/agent_supervisor.rs`) alongside `name`/`tag`. Without this the deck cannot know the flag exists, let alone display it.
- **The Z4B session chip shows it.** A private session's chip carries a persistent marker (the same chip that renders name and tag), so the state is legible whenever the card is. The `/private` ack bulletin stays as the confirmation of the *transition*; the chip is the record of the *state*.

#### [P06] Every Bash command is a shell fact, on a NEW unfiltered relay map (DECIDED) {#p06-bash-capture}

**Decision:** Claude-route `shell` facts ride a **new relay-local map of their own** — `pending_shell_facts: HashMap<String, PendingShellFact>` in `agent_bridge.rs`'s relay, populated on **every** Bash `tool_use` (command text + timestamp, keyed by `tool_use_id`) and consumed at its `tool_result` to record `{command, ok: !is_error, route: "claude"}` with the [P03] key. `$`-route facts are emitted in `feeds/shell.rs` beside the existing `record_exchange` call on `exchange_complete`: `{command, exit_code, cwd, route: "user"}`.

**The existing attribution maps must NOT be reused, and this is the decision's whole point.** Both are *filtered* in ways that exclude exactly the commands this feature exists to capture:

- `pending_cmds` receives a Bash call **only when `declared_ops_for_command` returns `Some`** — file-operation commands. `cargo build` returns `None`, pinned by a test in `feeds/attribution.rs`. Every build, every test run, every `git log` is absent from it.
- `open_bash` opens a bracket only for a **live, in-repo** call (`if in_replay { None } else { ensure_repo_root(...) }`), so replayed and non-repo commands never appear.

Hooking either map would mean `test_run` facts essentially never fire from the Claude route — a silent hole in [P07], since a test run is never a file-op command. The new map is unconditional: insert on every Bash `tool_use` regardless of parse outcome, repo-ness, or replay state.

**Rationale:** User decision: every command, both routes. The `tool_use`→`tool_result` pair is still the right *shape* — the command text and its outcome are both in hand only there — and it is the existing maps' filtering, not the pairing idea, that is unusable. The `$` settle site is where an exchange is authoritative and already writes `shell_exchanges`.

**Implications:** Output is never in the payload — `shell_exchanges.db` and the transcript own output. `bash_command_for_tool` (`feeds/attribution.rs`) is still the right extractor for the command text; it is the map, not the extractor, that is new. The map is size-capped with oldest eviction like `PendingCalls`, and is **never cleared on `turn_complete`** — a subagent's pair can straddle a turn boundary, the same reason `pending_calls` is not cleared there.

#### [P07] test_run facts derive from shell facts via a timid classifier (DECIDED) {#p07-test-classifier}

**Decision:** `facts_library::classify_test_run(command, output_tail) -> Option<TestRunFact>` recognizes exactly three runners — `cargo nextest` (its `Summary [...] N tests run: N passed, N failed` line), `bun test` (its `N pass / N fail` summary), and `just app-test*` (the report's `VERDICT:` line plus the result table's totals) — parsing verdict and totals from the settled output's tail. Anything else returns `None`; a recognized runner with an unparseable tail (including one behind `output_truncated`) records `verdict: "unknown"` with no counts. The recorder calls it wherever a shell fact is recorded, and a hit records a second fact with the paired [P03] key.

**The verdict comes from the parsed summary, never from the tool call's success.** On the Claude route `tool_result.is_error` reports whether the *tool invocation* failed, not whether the tests passed — a red suite is a perfectly successful Bash call, and on the `$` route a non-zero `exit_code` accompanies a legitimately-parsed failing run. So `ok`/`exit_code` inform the `shell` fact only; the `test_run` verdict is whatever the summary line says, and `"unknown"` when no summary could be read.

**Rationale:** The `shell_ops` posture — recognize what we own, refuse to guess — is the house grammar for reading commands; a guessed pass count is worse than an honest unknown.

**Implications:** The classifier is pure and lives in `facts_library.rs` so the harness synthesizes identical `test_run` facts from transcript `tool_use`/`tool_result` pairs ([P09]). Output tails reach it from `tool_result.output` (Claude route) and the exchange's `output` (`$` route).

#### [P08] Commit facts from the CommitReceipt at the commit path (DECIDED) {#p08-commit-facts}

**Decision:** In `feeds/agent_supervisor.rs`, at the `changeset_commit` success arm where the receipt is in hand (the same block that writes the synthetic `/commit` shell-ledger row), record a `commit` fact: subject = the sha, payload = `{sha, message, files, numstat}`, dedupe key `commit:<sha>`, session_id from the request when present.

**Rationale:** The receipt is built and discarded here today; this is the one durable moment that knows sha, message, and file list together without re-running git.

**Implications:** Commits made outside Tug's landing gestures are not facts (git remains their record); dash-lane `tugutil dash commit` commits are likewise out of v1 — the Operator reaches them through `git.log` as today.

#### [P09] Classifiers and renderings are pure and shared with the harness (DECIDED) {#p09-shared-module}

**Decision:** `feeds/facts_library.rs` is IO-free: `FactKind`, the payload structs, `render_text`, `classify_test_run`, and `synthesize_facts_from_frames` (the transcript-side derivation the harness uses). The live recorders and `feeds/gazette_replay.rs` both call it; nothing fact-shaped is computed anywhere else.

**Rationale:** The gazette plan's [R01] lesson, verbatim: the harness once drifted from the bridge on the wake rule and reported three wakes against the bridge's one. The re-calibration read ([Q02]) is only meaningful if the harness's facts are the production facts.

**Implications:** Harness synthesis covers what transcripts carry — `prompt` (from `user_message` records where present), `shell`/`test_run` (from Bash `tool_use`/`tool_result` pairs), `session.compacted` (from `compact_boundary`) — and states in its output which kinds were synthesized; `commit` and lifecycle facts are absent from replay and that asymmetry is printed, not hidden.

**`session.compacted` is the one kind the translator cannot yet feed, and #step-8 must extend it.** `translate_transcript` (`feeds/gazette_replay.rs`) maps **only** `user` and `assistant` records — its `if kind != "assistant" && kind != "user" { continue; }` gate drops everything else before any block walk. The JSONL's compaction marker is a **`system`** record with `subtype: "compact_boundary"` (the shape `tugcode/src/session.ts` reads when it scans a transcript on resume), so it is discarded today and no amount of work inside `synthesize_facts_from_frames` can recover it. The existing `is_compact_summary` handling is not this: it skips the compaction *summary* record, not the boundary. #step-8 therefore adds a `compact_boundary` arm to the translator that emits a `ReplayFrame` carrying `trigger` / `pre_tokens` / `post_tokens` off the record's `compact_metadata`, matching the live wire's payload. Without that arm, `session.compacted` belongs in the live-only column of the printed asymmetry — pick the arm; do not quietly claim the kind.

**`post_tokens` is optional everywhere it comes from.** tugcode emits the field only when claude supplied it (`...(postTokens !== undefined ? …)`), so both the live recorder and the harness will see boundaries with a pre count and no post count. `render_text` for the compact kind renders the pair when both are present and degrades to the pre count alone otherwise — never a `0` standing in for an absent number.

#### [P10] The Reporter's wake input gains a SETTLED FACTS section; refs validate against two corpora (DECIDED) {#p10-reporter-diet}

**Decision:** `compose_reporter_input` (`feeds/reporter_wake.rs`) takes a new `facts: &[FactLine]` parameter and renders, between the prior-posts section and the activity section:

```
SETTLED FACTS SINCE YOUR LAST POST:
- [at_ms] <text>
```

(or `(none)`), capped at 20 facts / 4 KB, oldest dropped with `[earlier facts elided]`. The bridge fetches facts for the session newer than the newest prior post's `at_ms` (all facts when there are no priors) via a new `list_facts_for_session_since` ledger read.

**Ref validation takes a slice of corpora, not one concatenated string.** `validate_refs(refs, buffered_context: &str)` today does `buffered_context.contains(&r.target)`; the new signature is `validate_refs(refs, corpora: &[&str])`, keeping a ref when **any one** corpus contains its target verbatim. The bridge passes `&[&buffer.rendered(), &facts_section]`. Concatenating instead would admit a target that spans the join between the two — absurd for a path or sha, but it is a free class of false positive to eliminate, and separate corpora also make the failure log able to say which surface a ref came from. `session`-kind refs stay exempt as today; a target in neither corpus is still dropped.

**Rationale:** User decision: the fact base and the Reporter change together. The section touches neither the frame allowlist (gazette [Q02] stays closed) nor the wake logic; it hands the Reporter exactly the SHAs and totals its rubric wants to cite from settled ground truth, and improves dedup for free (a commit is visible as both a prior post and a fact).

**Implications:** `REPORTER_POST_INSTRUCTIONS` (`feeds/gazette_agent.rs`) gains a paragraph explaining the section (facts are settled ground truth; cite their subjects verbatim; a fact you already posted about is not news twice), pinned by the contract test. The harness composes the same section from synthesized facts ([P09]) and `--show-input` prints it. [Q02]'s read gates the ship.

#### [P11] record_fact has a transaction-taking inner form; the ledger mutex is not reentrant (DECIDED) {#p11-lock-reentrancy}

**Decision:** `record_fact` ships as two functions: `record_fact_tx(&Transaction, &NewFact) -> Result<Option<i64>>` doing the actual work, and a thin public `record_fact(&self, &NewFact)` that acquires `self.db.lock()` and delegates. **Any caller that already holds the ledger lock calls the `_tx` form.**

**Rationale:**
- `SessionLedger.db` is a `std::sync::Mutex<Connection>`, which is **not reentrant**. `record_spawn` holds it across an IMMEDIATE transaction for its whole body, so calling the public `record_fact` from inside it would deadlock tugcast on **every session spawn** — a hang rather than an error, and one that no unit test of either function alone would catch.
- The same hazard waits for any future recorder invoked from inside a ledger method, so the rule is stated once here rather than rediscovered per site.

**Implications:** #step-3's `session.spawned`/`session.resumed` facts are written with `record_fact_tx` inside `record_spawn`'s existing transaction, which also makes the fact and the session row atomic. Recorders that call from *outside* the ledger (the relay, the shell settle, the supervisor arms) use the public form. The write-time privacy check ([P05]) lives in the `_tx` form so both paths enforce it within one connection acquisition.

**A convenience already in hand:** `record_spawn` needs no pre-existence probe — it already reads `SELECT created_at, tag FROM sessions WHERE session_id = ?1` into `existing` before its UPSERT, so `existing_created_at.is_some()` **is** the spawned-vs-resumed disposition and the step spends no extra query.

**What that disposition means for an adopted session, decided here so #step-3 does not have to guess.** `record_spawn` also seeds from `external_scan_cache`, so a session Tug discovered by the scan and is adopting has **no `sessions` row** yet carries real prior history (a seeded `turn_count`, `last_user_prompt`, `created_at`, and often a minted tag). `existing_created_at.is_some()` therefore calls that adoption `session.spawned`, not `session.resumed`. **That is the intended reading:** the fact records the session's first appearance *in this ledger*, which is the first moment this instance can say anything true about it, and the `{workspace_key, project_dir, name}` payload describes exactly that moment. Do not reach for `seed_created_at`/`scanned_tag` to reclassify adoptions as resumes — an adopted session's pre-Tug history is the transcript's to tell, not the fact base's, and a `resumed` fact with no prior `spawned` fact in the same ledger would be the more confusing record.

---

### Deep Dives {#deep-dives}

#### Recording sites, named {#recording-sites}

| Fact | Site | The hook that exists today |
|---|---|---|
| `prompt` | `feeds/agent_bridge.rs`, relay input branch | the `parse_user_message_text` capture that feeds `record_user_prompt` — the plan adds a `record_fact` beside it with the **full** text (16 KB cap) keyed by `tug_session_id` (in scope), not the claude id |
| `session.spawned` / `session.resumed` | `SessionLedger::record_spawn` | the UPSERT already runs under the lock; add a pre-existence check and record the disposition as the fact kind |
| `session.closed` / `session.errored` | supervisor `do_close_session` / the errored publish sites, and `agent_bridge`'s crash sites | record beside each `build_session_state_frame(..., "closed"/"errored", ...)` publish; `demote_live_to_closed` (startup crash-recovery) records with `detail: "startup-demote"` |
| `session.reset` | supervisor `do_reset_session` | one fact for the reset; its internal closed→pending pair does **not** also record `closed` |
| `session.renamed` | supervisor `do_rename_session` | payload carries old and new name |
| `session.compacted` | `feeds/agent_bridge.rs`, outbound relay scan | the same line-inspection fast path that string-matches `"type":"tool_use"` for attribution also matches `"type":"compact_boundary"`; payload = trigger, pre/post tokens; [P03] key from the frame timestamp |
| `commit` | supervisor `changeset_commit` success arm | [P08] |
| `shell` (claude) + `test_run` | `feeds/agent_bridge.rs`, the **new** `pending_shell_facts` map's pair settle — **not** `pending_cmds`/`open_bash`, which are filtered | [P06], [P07] |
| `shell` (user) + `test_run` | `feeds/shell.rs` settle; both shell sites call `classify_test_run` | [P06], [P07] |

**`feeds/shell.rs` has no `SessionLedger` today.** `shell_dispatcher_task(input_rx, output, ledger: Option<Arc<ShellLedger>>, agent, cancel)` reaches only the shell ledger, so the `$`-route settle site cannot write a fact as the code stands. #step-4 threads an `Option<Arc<SessionLedger>>` parameter through `shell_dispatcher_task` → `run_dispatcher` → the settle site, and passes `Arc::clone(&ledger)` at the `main.rs` spawn call. Mechanical, but it is a signature change in three places and a step that does not expect it will stall.

Every recorder is best-effort: a failed write is a `warn!`, never a gate on the forward/settle it rides.

#### What the Operator gains {#operator-gains}

`OperatorContext` grows `shell_ledger: Option<Arc<ShellLedger>>` (wired in `main.rs` from the same handle the shell dispatcher gets). `session.prompts` is repaired in place: it reads `prompt` facts for the session (full history, permanent) plus the pending journal, and drops its apologetic `note` when fact rows exist — sessions predating the library keep the note. The three new verbs are pinned against `VERB_NAMES` and the retrieve instructions by the existing two-list test.

---

### Specification {#specification}

**Spec S01: facts DDL** {#s01-facts-ddl}

```sql
CREATE TABLE IF NOT EXISTS facts (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    at_ms      INTEGER NOT NULL,
    kind       TEXT NOT NULL,
    session_id TEXT,              -- NULL for app-scoped facts
    subject    TEXT,              -- headline handle: a sha, a command incipit, a name
    text       TEXT NOT NULL,     -- the one-line rendering ([P02])
    payload    TEXT NOT NULL,     -- small structured JSON; never outputs or file bodies
    dedupe_key TEXT               -- [P03]; NULL on live-only paths
);
CREATE INDEX IF NOT EXISTS facts_kind_at ON facts(kind, at_ms);
CREATE INDEX IF NOT EXISTS facts_session_at ON facts(session_id, at_ms);
CREATE UNIQUE INDEX IF NOT EXISTS facts_dedupe ON facts(dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(subject, text, content='facts', content_rowid='id');
-- + the three sync triggers, the gazette_posts_fts shape verbatim
```

Rust surface in `session_ledger.rs`: `FactRow`, `record_fact(&NewFact) -> Result<Option<i64>>` (`None` = deduped), `list_facts_for_session_since(session_id, since_ms, limit)`, `search_facts(query, &FactSearchFilter, limit)` (bm25 + snippet, the `search_gazette_posts` shape), `facts_window(id, n)`.

**Spec S02: fact kinds — payload and rendering** {#s02-fact-kinds}

**Table T01: Fact kinds** {#t01-fact-kinds}

| kind | subject | payload | rendered `text` (shape) |
|---|---|---|---|
| `prompt` | first 80 chars | `{text}` (≤16 KB, elision-marked) | `prompt: "<first ~200 chars>"` |
| `session.spawned` / `.resumed` | tag or session id | `{workspace_key, project_dir, name}` | `session spawned in <project_dir>` |
| `session.closed` / `.errored` | tag or session id | `{detail}` | `session closed` / `session errored (<detail>)` |
| `session.reset` | tag or session id | `{}` | `session cleared` |
| `session.renamed` | new name | `{old, new}` | `session renamed "<old>" → "<new>"` |
| `session.compacted` | trigger | `{trigger, pre_tokens?, post_tokens?}` | `context compacted (<trigger>): <pre> → <post> tokens`; both counts are optional (claude often sends no `post_tokens`) — render what is present, never a `0` for an absent count |
| `commit` | sha | `{sha, message, files, numstat}` | `commit <sha12> "<subject line>" — <n> file(s)` |
| `shell` | command incipit (80) | `{command, route, ok, exit_code?, cwd?}` | `$ <command ≤200> → ok` / `→ err` |
| `test_run` | runner | `{runner, verdict, passed?, failed?, skipped?}` | `tests: <runner> — <verdict> (<p> passed, <f> failed)` |

**Spec S03: verb I/O** {#s03-verbs}

**Table T02: New verbs** {#t02-new-verbs}

| Verb | Args | Backing | Cap |
|---|---|---|---|
| `facts.search` | `query`, opt `kind`/`session_id`/`since_ms`/`until_ms` | `search_facts` FTS5, bm25-ranked | 30 facts, snippet excerpts |
| `facts.window` | `fact_id`, `n` | `facts_window` | n ≤ 20 each side |
| `shell.history` | opt `session_id`/`since_ms`/`until_ms`/`query` (substring on command) | `shell_exchanges.db` via a new `ShellLedger::search_exchanges` | 50 rows; output excerpt ≤ 240 chars |

All three: 10s timeout, error-as-value, privacy exclusion ([P05]), argument gates reused from `operator.rs`.

**Spec S04: the SETTLED FACTS section** {#s04-facts-section}

Rendered by `compose_reporter_input` between prior posts and activity ([P10]); cap 20 facts / 4 KB; oldest dropped behind `[earlier facts elided]`; `(none)` when empty. The section's exact rendered string is part of the ref-validation corpus.

#### State Zone Mapping (tugdeck/tugways plans) {#state-zone-mapping}

| State | Zone | Mechanism | Law |
|-------|------|-----------|-----|
| `/private` command match + dispatch | none (stateless route) | `LOCAL_SLASH_COMMANDS` entry + `RUN_SLASH_COMMAND` handler sending CONTROL | [L30] — the funnel is `RUN_SLASH_COMMAND`, already a registry row; no `SLASH_BRIDGES` entry ([Q01]) |
| the ack row ("session is now private") | transcript ink | the same pane-bulletin notice `/rename`'s ack uses in `session-card.tsx` | [L02] via existing stores |
| **private is/isn't set** (the resting state) | external app data | the `private` field on the pushed session row, read through the existing session store's `useSyncExternalStore` face and rendered as a Z4B chip marker | **[L02]** — never a local `useState` mirror of a server fact |

No new deck store and no new persistent preference; nothing touches Web storage. The one genuinely new piece of deck state is the private flag, and it is server-owned data arriving on the `session_updated` push — so it enters React the same way every other session-row field does, never as component state set from a command's response.

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tugrust/crates/tugcast/src/feeds/facts_library.rs` | [P09]: `FactKind`, payload structs, `render_text`, `classify_test_run`, `synthesize_facts_from_frames` — pure, IO-free |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `facts` DDL + FTS + triggers | schema | `session_ledger.rs` `bootstrap_schema` | Spec S01; posture comment per [P01] |
| `migrate_sessions_add_private` | fn | `session_ledger.rs` | the `migrate_sessions_add_name_user_set` shape; also add `private` to the CREATE TABLE and `SessionRow` |
| `NewFact`, `FactRow`, `record_fact_tx`, `record_fact`, `list_facts_for_session_since`, `search_facts`, `facts_window`, `FactSearchFilter`, `FactSearchHit` | struct/fns | `session_ledger.rs` | Spec S01; `_tx` form is mandatory for held-lock callers ([P11]); write-time privacy lives in `_tx` |
| `set_session_private` fn + privacy read helper | fns | `session_ledger.rs` | one UPDATE + one SELECT |
| `private` column on `SessionRow` + `build_session_updated_frame` payload | field | `session_ledger.rs`, `feeds/agent_supervisor.rs` | [P05] resting display — without the push the deck cannot show the state |
| `record_spawn` fact write | fn change | `session_ledger.rs` | uses `record_fact_tx` inside its existing transaction ([P11]); disposition is the already-read `existing_created_at` |
| prompt + compact recorders | wiring | `feeds/agent_bridge.rs` | sites named in (#recording-sites); [P03] keys |
| `pending_shell_facts` map + Bash pair recorder | struct/wiring | `feeds/agent_bridge.rs` | **new, unfiltered** ([P06]) — beside `pending_calls`/`pending_cmds`, never reusing them |
| lifecycle + commit recorders | wiring | `feeds/agent_supervisor.rs` | `do_close_session`, `do_reset_session`, `do_rename_session`, errored publishes, `changeset_commit` arm |
| `$`-route shell + test_run recorder | wiring | `feeds/shell.rs` | beside `record_exchange` — **requires** a new `Option<Arc<SessionLedger>>` param on `shell_dispatcher_task`/`run_dispatcher` + the `main.rs` call site |
| `ENABLED_KEY` removal | deletion | `feeds/gazette_agent.rs`, `feeds/reporter.rs`, `main.rs` | [P04]; `ReporterBridgeConfig.enabled` field goes |
| `facts.search` / `facts.window` / `shell.history` + `VERB_NAMES` rows | fns | `feeds/operator.rs` | Table T02; `OperatorContext.shell_ledger` added; privacy joins on the ledger verbs |
| `ShellLedger::search_exchanges` | fn | `shell_ledger.rs` | filtered read for `shell.history` |
| retrieve/answer instruction updates + `REPORTER_POST_INSTRUCTIONS` facts paragraph | consts | `feeds/gazette_agent.rs` | pinned by the existing contract tests |
| `compose_reporter_input` facts param, `FactLine`, `validate_refs(refs, &[&str])` | fns | `feeds/reporter_wake.rs` | [P10]; corpora as a slice, not a concatenation |
| wake-time privacy check + facts fetch | wiring | `feeds/reporter.rs` `wake()` | [P05], [P10] |
| facts synthesis + `SETTLED FACTS` in replay output | wiring | `feeds/gazette_replay.rs` | [P09]; synthesized-kinds note printed |
| `"set_session_private"` CONTROL arm + `do_set_session_private` | verb | `feeds/agent_supervisor.rs` | beside `"rename_session"`; `set_session_private_ok` ack |
| `/private` entry + handler | TS | `tugdeck/src/lib/slash-commands.ts`, `components/tugways/cards/session-card.tsx` | [Q01]; exhaustive map forces the handler |

---

### Documentation Plan {#documentation-plan}

- [ ] Module doc on `facts_library.rs` carries the doctrine (one rendering, timid classifiers, harness parity) — no freestanding docs/*.md dropfiles.
- [ ] The `facts` DDL comment carries the [P01] posture and the [P03] key registry per kind.
- [ ] `dash/gazette-facts-library-brief.md` stays as the decided design; this plan is its execution.

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit (Rust)** | ledger round-trips, dedupe, FTS ranking/filters, classifier tables (runner outputs → verdicts), render_text shapes, privacy at all three choke points, two-corpus ref validation, facts-section caps | bulk of coverage |
| **Integration (Rust)** | relay-driven recording (the `drive_relay` test pattern in `agent_bridge.rs`): frames in → facts out, replayed twice → one row; bridge wake with facts section via scripted pool | tokio tests |
| **Unit (deck)** | `/private` match + handler dispatch payload | `bun test` |
| **Real-model** | none new — the existing `#[ignore]` real-claude reporter test covers the envelope; prose quality is #step-9's human read | — |

#### What stays out of tests {#test-non-goals}

- Model prose quality under the new diet — that is the #step-9 calibration read, by a human.
- jsdom render tests and mock-store assertions — banned; the `/private` ack rendering rides existing covered paths.
- Cross-runner test-output archaeology — the classifier recognizes three runners; unrecognized output is `None` by contract, not a coverage gap.

---

### Execution Steps {#execution-steps}

> **Commit after all checkpoints pass.** Rust checkpoints run from `tugrust/`; deck checkpoints from `tugdeck/`.
>
> Phases for `/implement` sizing: **A** #step-1–#step-2 (the library, pure and stored), **B** #step-3–#step-5 (recorders + always-on), **C** #step-6 (the desk), **D** #step-7 (privacy, both sides), **E** #step-8–#step-9 (the Reporter's diet; #step-9 ends in a human gate), **F** #step-10 (proof).

#### Step Status Ledger {#step-status-ledger}

> **A build-order constraint the plan did not anticipate, recorded so the remaining steps expect it.** `tugcast` is a **bin-only crate** with `-D warnings`, so `dead_code` is a hard error: a `pub` API with no consumer in the binary fails `cargo build` *and* `cargo nextest run` (which builds the bin target too). The bottom-up steps therefore cannot each be independently green — #step-1's write path has no caller until #step-3, and its read side has none until #step-6/#step-8. Two consequences, both applied:
>
> - **Each ledger API lands with its first consumer**, not all at once in #step-1. `record_fact`/`record_fact_tx`/`NewFact` shipped with the recorders; `search_facts`, `facts_window`, `list_facts_for_session_since`, `FactRow`, `FactSearchFilter`, `FactSearchHit` belong to #step-6/#step-8; `set_session_private`/`is_session_private` to #step-7. The DDL, the migration, and `SessionRow.private` shipped in the first commit as planned.
> - **#step-1 through #step-4 landed as one commit**, with the [P09] half of #step-8 (the `compact_boundary` translator arm and `synthesize_facts_from_frames`' harness call) folded in — it was the last unconsumed surface, and the tree could not build without it.
>
> Two other deliberate departures, both improvements on the sites the plan named:
>
> - **Lifecycle facts ride the durable transition, not the publish.** `session.closed` / `session.errored` record inside `LedgerSessionsRecorder::mark_closed` / `mark_failed` rather than beside each `build_session_state_frame(..., "closed"/"errored", …)` publish. There are seven such publish sites and exactly one durable transition apiece, so this records once per real event instead of once per broadcast. `do_reset_session` still records its own fact (it transitions no ledger row, so no `closed` fact fires beside it), and `demote_live_to_closed` records per demoted row with `detail: "startup-demote"`.
> - **`facts_for_test`** (a `#[cfg(test)]` reader on `SessionLedger`) is what the recorder tests in other modules assert through, since the typed read verbs land later. It compiles out of the production binary.

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Ledger: facts table, FTS, private column | done | `f339f57e0` (with #step-2–#step-4) |
| #step-2 | The pure facts_library module | done | `f339f57e0` |
| #step-3 | Recorders: prompt, lifecycle, compact | done | `f339f57e0` |
| #step-4 | Recorders: shell both routes, test_run, commit | done | `f339f57e0` |
| #step-5 | Always-on: retire the enabled knob | done | `a7d6001f7` |
| #step-6 | Operator: facts.search, facts.window, shell.history | done | `a7e30f7cc` |
| #step-7 | Privacy: CONTROL verb, exclusions, /private | done | `03fcaa087` |
| #step-8 | Reporter diet: facts section + two-corpus refs + harness | done | `f339f57e0` ([P09] half) + `5b7c6a8d3` |
| #step-9 | Calibration re-read (human gate) | done | see [Q02]; `--no-facts` + the bookkeeping-prompt fix |
| #step-10 | Integration checkpoint | done — automated gates green; live acceptance is the vetting pass on the `(debug, tugdash/gazette-facts-library)` instance | — |

#### Step 1: Ledger — facts table, FTS, private column {#step-1}

**Commit:** `tugcast(ledger): uncapped facts table with FTS5, dedupe, and sessions.private`

**References:** [P01] posture, [P02] one rendering, [P03] idempotency, [P05] privacy column, Spec S01, (#s01-facts-ddl)

**Artifacts:** the Spec S01 DDL in `bootstrap_schema`'s `execute_batch` beside `gazette_posts`, with the [P01] posture comment; `NewFact`/`FactRow` and the five APIs; `migrate_sessions_add_private` + `private` in the sessions CREATE TABLE and `SessionRow`; `set_session_private` + a privacy read helper.

**Tasks:**
- [ ] DDL + triggers, modeled character-for-character on the `gazette_posts_fts` block (external content, delete/update command rows).
- [ ] `record_fact_tx(&Transaction, &NewFact)` does the work; public `record_fact(&self, …)` acquires the lock and delegates ([P11] — the mutex is **not** reentrant and `record_spawn` holds it). Computes nothing (the caller passes rendered `text` — the pure module owns rendering); `INSERT OR IGNORE` on `dedupe_key`; returns `Ok(None)` when deduped; refuses (silently `Ok(None)`) when `session_id` names a private row ([P05] write-time, enforced in the `_tx` form so both paths get it).
- [ ] `search_facts` mirrors `search_gazette_posts` (MATCH + bm25 + snippet + content-table filters for kind/session/time).
- [ ] `list_facts_for_session_since(session_id, since_ms, limit)` oldest-first — the #step-8 wake read.
- [ ] Migration + column, the `migrate_sessions_add_name_user_set` shape exactly.

**Tests:**
- [ ] Round-trip all kinds; dedupe (same key twice → one row, `None` second); tail/window/filters; FTS relevance beats insertion order; triggers stay in sync.
- [ ] Facts survive a `sessions` row DELETE (no cascade); private write refusal; migration idempotence on a pre-column DB.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast session_ledger`

---

#### Step 2: The pure facts_library module {#step-2}

**Depends on:** #step-1

**Commit:** `tugcast(facts-library): pure fact kinds, renderings, and the test-run classifier`

**References:** [P02], [P07] classifier, [P09] shared module, Spec S02, Table T01, (#s02-fact-kinds)

**Artifacts:** `feeds/facts_library.rs`: `FactKind`, payload structs, `render_text`, `classify_test_run`, `synthesize_facts_from_frames`, the [P03] key builders, the prompt/text caps.

**Tasks:**
- [ ] `render_text` per Table T01; caps (subject 80, text ~240, prompt payload 16 KB with elision marker) as module consts. The compact rendering degrades on a missing `post_tokens` (and on a missing `pre_tokens`) rather than printing a stand-in zero ([P09]).
- [ ] `classify_test_run` for the three runners ([P07]): parse `cargo nextest`'s summary line, `bun test`'s pass/fail line, the app-test report's `VERDICT:` + totals; recognized-but-unparseable → `verdict: "unknown"`; everything else `None`.
- [ ] `synthesize_facts_from_frames`: derive `prompt`/`shell`/`test_run`/`session.compacted` facts from transcript-shaped frames, returning which kinds it could synthesize. `prompt`/`shell`/`test_run` come from shapes `translate_transcript` already emits (`user_message`, `tool_use`/`tool_result`); **`session.compacted` does not — the translator drops `system` records today and #step-8 adds the arm that emits it ([P09])**. Write the compact branch against the live wire's payload (`trigger`/`pre_tokens`/`post_tokens`) so it needs no change when that arm lands.

**Tests:**
- [ ] Rendering table test (every kind), including a compact fact with no `post_tokens` (renders the pre count alone, no zero); classifier table test with real captured summary tails per runner, plus truncated-tail → unknown and `cargo build` → `None`.
- [ ] Synthesis over a fixture frame list produces the same facts the live recorders would (assert against hand-built expectations using the same key builders).

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast facts_library`

---

#### Step 3: Recorders — prompt, lifecycle, compact {#step-3}

**Depends on:** #step-2

**Commit:** `tugcast(facts): record prompts, session lifecycle, and compactions`

**References:** [P03], [P05] write-time, Table T01, (#recording-sites)

**Artifacts:** recorder calls at the sites named in (#recording-sites); `record_spawn` disposition change.

**Tasks:**
- [ ] Prompt: beside the `parse_user_message_text` capture in `agent_bridge.rs`'s relay input branch — full text through the module's cap, keyed by `tug_session_id`, best-effort.
- [ ] `record_spawn` records `session.spawned`/`session.resumed` **via `record_fact_tx` inside its existing transaction** ([P11]) — calling the public `record_fact` there deadlocks. No new probe is needed: `existing_created_at.is_some()` (already read before the UPSERT) is the disposition. A scan-adopted session (no `sessions` row, but an `external_scan_cache` seed) records `session.spawned` — first appearance in *this* ledger, per [P11]; do not reclassify it from the seed.
- [ ] Closed/errored/reset/renamed at the supervisor `do_*` sites; `demote_live_to_closed` records with `detail: "startup-demote"`; reset records once (no double `closed`).
- [ ] Compact: the outbound relay scan matches `"type":"compact_boundary"`, parses trigger/pre/post, records with the frame-timestamp [P03] key.

**Tests:**
- [ ] `drive_relay`-pattern integration: a `user_message` yields a `prompt` fact with full text; a replayed `compact_boundary` batch driven twice yields one fact.
- [ ] Ledger-level: spawn→resume sequence yields one `spawned` + one `resumed`; a `record_spawn` over an `external_scan_cache`-seeded id with no `sessions` row yields `spawned` (the adoption reading in [P11]); reset yields exactly one `session.reset`.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast agent_bridge session_ledger`

---

#### Step 4: Recorders — shell both routes, test_run, commit {#step-4}

**Depends on:** #step-2

**Commit:** `tugcast(facts): record every shell command, test runs, and commits`

**References:** [P06] bash capture, [P07] classifier, [P08] commit facts, [P03], Table T01, (#recording-sites)

**Artifacts:** the new `pending_shell_facts` map + its pair handling in `agent_bridge.rs`; the `$` settle recorder in `feeds/shell.rs` **plus the `SessionLedger` parameter threaded to reach it**; the commit recorder in the `changeset_commit` success arm (`agent_supervisor.rs`).

**Tasks:**
- [ ] Claude route: add `pending_shell_facts` beside `pending_calls`/`pending_cmds` — insert on **every** Bash `tool_use` (`bash_command_for_tool` for the text), consume at its `tool_result`. **Do not hook `pending_cmds` or `open_bash`** ([P06]): both are filtered and would drop every build and test command. Record `shell` with `route: "claude"`, `ok` from `is_error`, key `shell:<session>:<tool_use_id>`; run `classify_test_run(command, result_tail)` and record the paired `test_run` on a hit.
- [ ] Thread `Option<Arc<SessionLedger>>` through `shell_dispatcher_task` → `run_dispatcher` → the settle site, and pass it at the `main.rs` spawn call (the `$` route has no session-ledger handle today — see (#recording-sites)).
- [ ] `$` route: beside `record_exchange`, record `shell` with `route: "user"` + exit_code + cwd (NULL key), and the classifier over the exchange output.
- [ ] Commit: in the success arm holding the `CommitReceipt`, record per [P08] with key `commit:<sha>`.

**Tests:**
- [ ] **`cargo nextest run` on the Claude route records both a `shell` and a `test_run` fact.** This is the regression test for [P06]: a non-file-op command never enters the attribution maps, so a run that reuses them produces neither fact and this test is what catches it.
- [ ] Replayed Bash batch driven twice → one `shell` fact; an `is_error` result records `ok: false`.
- [ ] A `just app-test` exchange output with a `VERDICT:` line records both `shell` and `test_run` facts; a `cargo build` records `shell` only (recognized-runner gate).
- [ ] A failing suite (`cargo nextest` summary reporting failures, tool call successful) records `verdict: "failed"` — the verdict comes from the summary, not from `is_error`/`exit_code` ([P07]).
- [ ] The commit arm records a fact whose subject is the receipt sha (unit test at the supervisor level with a seeded ledger, the existing changeset-test pattern).

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast agent_bridge shell agent_supervisor`

---

#### Step 5: Always-on — retire the enabled knob {#step-5}

**Depends on:** #step-3, #step-4

**Commit:** `tugcast(gazette): the Gazette is never disabled — retire the enabled knob`

**References:** [P04], (#p04-always-on)

**Artifacts:** deletions in `feeds/gazette_agent.rs` (`ENABLED_KEY`), `feeds/reporter.rs` (`ReporterBridgeConfig.enabled` + its three checks), `main.rs` (`gazette_enabled` closure).

**Tasks:**
- [ ] Remove the field and every check; reword the mute-set doc comments in `reporter_wake.rs`/`reporter.rs` (mute tracks the wire; the toggle clause goes).
- [ ] Remove the disabled-knob bridge test; confirm no other consumer of `ENABLED_KEY` (grep the workspace **whole-word** — `feeds/pulse.rs`'s unrelated `PULSE_ENABLED_KEY` matches a substring grep and would read as a survivor).

**Tests:**
- [ ] Existing bridge suite green without the knob; a compile-time absence check is the deletion itself under `-D warnings`.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast reporter && ! grep -rnw "ENABLED_KEY" crates/tugcast/src` (`-w` mandatory — `PULSE_ENABLED_KEY` is a substring match)

---

#### Step 6: Operator — facts.search, facts.window, shell.history {#step-6}

**Depends on:** #step-1

**Commit:** `tugcast(operator): the library desk — facts.search, facts.window, shell.history; session.prompts repaired`

**References:** [P09] via search parity, Spec S03, Table T02, (#operator-gains)

**Artifacts:** three verbs in `feeds/operator.rs` + `VERB_NAMES` rows; `OperatorContext.shell_ledger`; `ShellLedger::search_exchanges`; `session.prompts` repair; retrieve-instruction updates in `gazette_agent.rs`; `main.rs` wiring of the shell-ledger handle.

**Tasks:**
- [ ] Verbs per Table T02, reusing `opt_str`/`opt_i64`/`plain_arg` and the error-as-value posture; `shell.history` output excerpts capped 240 chars.
- [ ] `session.prompts`: read `prompt` facts (oldest-first, existing PROMPTS_LIMIT), keep the pending-journal merge, drop the `note` when fact rows exist.
- [ ] `OPERATOR_RETRIEVE_INSTRUCTIONS` gains the three verbs with one-line strategy guidance ("facts are ground truth for prompts, shell commands, test results, lifecycle; shell.history reads verbatim command history"); the two-list pinning test extends.

**Tests:**
- [ ] Per-verb cap/filter tests over a seeded ledger; `shell.history` over a seeded shell ledger; `session.prompts` with and without facts (note present only without).
- [ ] The instructions/`VERB_NAMES` parity test covers twelve verbs.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast operator gazette_agent`

---

#### Step 7: Privacy — CONTROL verb, exclusions, /private {#step-7}

**Depends on:** #step-1, #step-6

**Commit:** `tugcast+tugdeck(gazette): private sessions — /private toggles a session out of the Gazette`

**References:** [P05], [Q01], Spec S03 privacy row, (#p05-privacy, #state-zone-mapping)

**Artifacts:** `"set_session_private"` CONTROL arm + `do_set_session_private` + `set_session_private_ok` ack in `agent_supervisor.rs`; `private` on `SessionRow` and in the `session_updated` push (`build_session_updated_frame`); wake-time check in `reporter.rs::wake` (discard the taken window of a private session); query-time exclusions in `operator.rs`'s ledger verbs; the `/private` entry in `tugdeck/src/lib/slash-commands.ts` + handler in `session-card.tsx` (CONTROL send + ack notice, the `/rename` shape); the Z4B chip's private marker.

**Tasks:**
- [ ] CONTROL verb beside `"rename_session"`, parse + UPDATE + ack; no fact recorded for the toggle ([P05]). Mirror the action name into `tugdeck/src/protocol.ts` beside `CONTROL_ACTION_RENAME_SESSION`.
- [ ] **Push the flag:** add `private` to `SessionRow` and to `build_session_updated_frame`'s payload, so the deck can render a resting state rather than only a transient ack ([P05]).
- [ ] Wake-time: `wake()` reads the flag once per wake; private → take-and-drop the window, clear `armed_at`, no job.
- [ ] Query-time: `sessions.list`, `session.prompts`, `changes.for_session`, `changes.for_path`, `facts.search`, `facts.window`, `shell.history` exclude currently-private sessions **via `NOT EXISTS`, never a join** ([P05] — an inner join drops other-instance rows from `changes.for_path`); `gazette.search` untouched.
- [ ] Deck: `LOCAL_SLASH_COMMANDS` entry (the exhaustive `Record<LocalCommandName, …>` in `session-card.tsx` forces the handler) — **no `SLASH_BRIDGES` row** ([Q01]); ack renders as the same notice row `/rename` uses; the session chip carries a persistent private marker fed by the pushed flag.

**Tests:**
- [ ] Rust: private write refusal (already #step-1) + wake-discard (scripted-pool bridge test: frames, mark private, turn end → no job spawned, buffer empty) + each verb's exclusion.
- [ ] Rust: `changes.for_path` still returns a file event whose `tug_session_id` has **no** local `sessions` row (the other-instance case the `NOT EXISTS` formulation protects).
- [ ] Deck: `slash-commands.test.ts` match rows; handler dispatch payload unit test.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast reporter operator agent_supervisor`
- [ ] `cd tugdeck && bun test slash-commands && bun run check && bunx vite build`

---

#### Step 8: Reporter diet — facts section, two-corpus refs, harness synthesis {#step-8}

**Depends on:** #step-2, #step-3, #step-4, #step-5

**Commit:** `tugcast(reporter): the SETTLED FACTS wake section, fact-backed refs, harness parity`

**References:** [P10], [P09], Spec S04, Risk R01, (#s04-facts-section, #q02-diet-recalibration)

**Artifacts:** `compose_reporter_input` facts param + `FactLine` + section rendering with caps; `validate_refs` two-corpus signature; the bridge's `list_facts_for_session_since` fetch in `wake()`; `REPORTER_POST_INSTRUCTIONS` facts paragraph + contract-test pins; `gazette_replay.rs` synthesis (via `synthesize_facts_from_frames`) + **the `compact_boundary` arm on `translate_transcript`** + `SETTLED FACTS` in `--show-input` + a synthesized-kinds note in the report header.

**Tasks:**
- [ ] Section per Spec S04 (20 facts / 4 KB, `[earlier facts elided]`, `(none)`).
- [ ] `validate_refs(refs, corpora: &[&str])` — a slice, **not** a concatenated string ([P10]); the bridge passes the rendered buffer and the rendered facts section as two entries.
- [ ] Bridge: fetch facts newer than the newest prior post's `at_ms` (all facts when no priors), map to `FactLine`, pass through; fetch failure warns and composes `(none)` — a facts read must never cost a wake.
- [ ] Instructions paragraph ([P10]) with pins in the contract test (section header string; "a fact you already posted about is not news twice").
- [ ] **Translator arm ([P09]):** `translate_transcript`'s `kind != "assistant" && kind != "user"` gate drops the `system`/`subtype: "compact_boundary"` record that carries compaction, so add a branch above it emitting a `compact_boundary` `ReplayFrame` with `trigger`/`pre_tokens`/`post_tokens` read from `compact_metadata` (all optional). Without this the harness can never synthesize a `session.compacted` fact and the kind must move to the live-only column.
- [ ] Harness: synthesize per [P09]; print which kinds were synthesized and which are live-only so the reader knows the asymmetry.

**Tests:**
- [ ] Compose: section renders/caps/elides; empty → `(none)`.
- [ ] Refs: a sha present only in the facts section validates; present in neither corpus drops.
- [ ] Bridge integration (scripted pool): a wake's composed input carries facts recorded since the last post; `--no-model` replay of a fixture JSONL shows the section deterministically.
- [ ] Translator: a fixture JSONL carrying a `system`/`compact_boundary` record yields a `compact_boundary` frame and, through synthesis, a `session.compacted` fact — the pin on the arm above, since every other synthesized kind would pass without it.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast reporter_wake reporter gazette_replay gazette_agent`

---

#### Step 9: Calibration re-read (human gate) {#step-9}

**Depends on:** #step-8

**Commit:** `N/A unless the read demands rubric changes — then tugcast(gazette-agent): rubric adjustments from the facts-diet read`

**References:** [Q02], [P10], (#q02-diet-recalibration)

**Tasks:**
- [ ] Run `just gazette-replay <a real session jsonl>` at the shipped 90s cadence with facts synthesis, and read it beside the same transcript's pre-facts gazette.
- [ ] Judge: does the Reporter cite fact subjects (SHAs, test totals) it previously missed? Does the section distract or crowd? Adjust `REPORTER_POST_INSTRUCTIONS` wording only if the reading demands it — cadence knobs stay untouched by this plan.
- [ ] Record the verdict in this plan (resolve [Q02]).

**Tests:**
- [ ] The contract test pins any wording that changed.

**Checkpoint:**
- [ ] **Human:** the gazette under the new diet reads at least as well as before, and [Q02] is marked DECIDED with a sentence of findings.

---

#### Step 10: Integration Checkpoint {#step-10}

**Depends on:** #step-5, #step-6, #step-7, #step-9

**Commit:** `N/A (verification only)`

**References:** (#success-criteria, #exit-criteria)

**Tasks:**
- [ ] Walk every success criterion in (#success-criteria) against the built app (`just build-app` first — the app bundle is not refreshed by app-test runs): live facts accumulating across a real work session, the three worked Operator questions, `/private` end-to-end, resume-replay dedupe, no `ENABLED_KEY` survivor.

**Tests:**
- [ ] `cd tugrust && cargo nextest run` (workspace)
- [ ] `cd tugdeck && bun test && bun run check && bunx vite build`
- [ ] `just app-test-changed`

**Checkpoint:**
- [ ] All of the above green; manual acceptance noted in the session.

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** The facts-library ships end-to-end — durable structured facts recorded at their owning sites, three new Operator verbs plus a repaired `session.prompts`, per-session `/private` replacing the enabled knob, and a Reporter whose wake input carries settled facts, re-calibrated against a real transcript.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] All Step Status Ledger rows `done` with commits recorded; [Q02] resolved with findings.
- [ ] Success criteria in (#success-criteria) hold (facts accumulate + dedupe; worked questions answered; privacy enforced at all three choke points; refs validate against facts; knob gone).
- [ ] Isolation intact: the gazette plan's [P12] tests still pin no-feedback-loop and no-write-toward-sessions; facts add no write path toward any session.

**Acceptance tests:**
- [ ] `cd tugrust && cargo nextest run` green (warnings are errors).
- [ ] `cd tugdeck && bun test && bun run check && bunx vite build` green.
- [ ] `just app-test-changed` green.

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] Retroactive privacy scrub (delete a session's facts and posts on demand).
- [ ] `transcript.grep` over Claude JSONL — the honest design for full-transcript questions.
- [ ] Dash-lane and external commit facts; richer `test_run` runners as they join the house.
- [ ] A break-glass tugbank escape hatch, only if bring-up shows one is needed.

| Checkpoint | Verification |
|------------|--------------|
| Facts durable + idempotent | `just db-inspect` after a real session; replay test |
| The desk answers | the three worked questions in the live app |
| Privacy real | `/private` then: no facts, no posts, no verb rows |
| Diet read | #step-9 human gate recorded in [Q02] |
