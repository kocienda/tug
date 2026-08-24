<!-- devise-skeleton v4 -->

## Facts-Library Access — the Operator gets the run of the archive {#facts-library-access}

**Purpose:** Give the Gazette's Operator full command of the facts-library it already has: a clock and a session roster in its composed turns, a browse verb (`facts.list`) beside the search verb, a curated per-kind `detail` projection so the facts' recorded depth reaches the model, and instructions that teach all of it. The brief is [dash/facts-library-access-brief.md](facts-library-access-brief.md); this plan implements its P1–P6 whole.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-08-13 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

The facts-library shipped whole ([dash/archive/gazette-facts-library-brief.md](archive/gazette-facts-library-brief.md)): recorders at every owning site, FTS over rendered fact text, the desk's first verbs. A 2026-08-13 read of the access story found the Operator set up as a search tool over what is actually a structured, browsable, time-ordered record — and asked to follow rules it was never given the inputs for. Concretely: `compose_retrieve_input` (`tugrust/crates/tugcast/src/feeds/operator.rs`) hands the model only `QUESTION` + `RECENT GAZETTE POSTS`, so it has no *now* for the epoch-ms verb args and no session ids for the verbs that want them; `facts.search` requires an FTS query, so the library cannot be browsed by kind × session × time at all; `fact_json` withholds the payload, so a commit fact's file list is recorded but unreachable; `sessions_list` omits `tag` and `synopsis`, so the answer rule "name a session by its project and callsign" names data no verb supplies; and the retrieve instructions never show what a rendered fact line looks like, so FTS queries are composed blind.

The verb machinery itself is sound and stays untouched: read-only structurally, per-verb caps, `plain_arg` flag-refusal, errors returned as model-readable text, privacy exclusion inside the SQL via `not_private!`, and the prompt↔executor verb list pinned by `the_verb_table_matches_the_instructions`. Every change here rides that machinery.

#### Strategy {#strategy}

- Fix situational awareness first (clock, roster) — everything else reads better through it, and it is pure compose-function + instruction work with no schema surface.
- Add breadth second: the `facts.list` verb over a new all-optional-filter ledger read, leaving the Reporter wake's `list_facts_for_session_since` untouched.
- Add depth third: a per-kind `detail` projection composed in `facts_library.rs` beside `render_text`, so the projection and the canonical rendering evolve together; `sessions.list` gains `tag`/`synopsis` in the same stroke.
- Instructions catch up in the same step as each capability, pinned by the existing contract-test doctrine in `gazette_agent.rs` ("the string Rust prints is the string the model was told about").
- Nothing Reporter-side changes: the wake diet, `FACTS_SECTION_MAX`, ref validation are all out of scope.
- Close with an integration read: full tugcast test suite plus a worked-examples checklist for the user's live read (a human read, exactly as the library brief's Reporter phase was).

#### Success Criteria (Measurable) {#success-criteria}

- Every `operator-retrieve` and `operator-answer` turn begins with a `NOW:` line carrying epoch ms and a human local rendering (unit test on both compose functions).
- Every `operator-retrieve` and `operator-answer` turn carries a `SESSIONS (newest first):` roster with full session uuids, callsigns, and states, rendered from the privacy-excluding `list_sessions_recent` read (unit test; empty-ledger case renders `(no sessions)`).
- `facts.list` with **zero arguments** returns the newest 30 facts, newest-first; each of `kind`, `session_id`, `since_ms`, `until_ms` narrows it (unit tests per filter).
- A `commit` fact returned by any fact verb carries its file list in `detail`; a `test_run` fact carries its totals; a `prompt` fact carries up to 500 chars of prompt text (unit tests per kind).
- `sessions.list` results carry `tag` and `synopsis` (unit test).
- The retrieve instructions contain `facts.list`, the search-vs-list division sentence, and at least three verbatim example fact renderings; the contract tests in `gazette_agent.rs` pin all of it (test assertions).
- `cd tugrust && cargo nextest run -p tugcast` green with zero warnings.

#### Scope {#scope}

1. `NOW:` line in both Operator compose functions, injected as an argument.
2. `SESSIONS` roster section in both compose functions, rendered from `list_sessions_recent`.
3. New ledger read `list_facts` (all filters optional, `until_ms` added, newest-first) + new verb `facts.list`.
4. `render_detail` per-kind payload projection in `facts_library.rs`; `fact_json` serves it from every fact verb.
5. `sessions_list` JSON gains `tag` and `synopsis`.
6. `OPERATOR_RETRIEVE_INSTRUCTIONS` / `OPERATOR_ANSWER_INSTRUCTIONS` updates + contract-test pins.

#### Non-goals (Explicitly out of scope) {#non-goals}

- No raw payload passthrough — `detail` is a curated, capped projection ([P04]).
- No third retrieval round — `MAX_RETRIEVAL_ROUNDS` stays 2 ([P08]).
- No new FTS surface — `facts.list` is a plain filtered SELECT; bm25 ranking untouched.
- No Reporter changes — wake composition, facts section, ref validation all untouched.
- No new fact kinds, no recorder changes.
- No privacy posture changes — every new read carries the same in-SQL exclusion.
- No deck/tugdeck changes — this plan is entirely tugcast-side.

#### Dependencies / Prerequisites {#dependencies}

- The facts-library as shipped: `facts` table + FTS, `feeds/facts_library.rs`, the desk verbs in `feeds/operator.rs`, the job table in `feeds/gazette_agent.rs`.
- `chrono = "0.4"` — already a workspace dep (`tugrust/Cargo.toml`) and already in tugcast's `Cargo.toml` (`chrono = { workspace = true }`), default features (clock included).

#### Constraints {#constraints}

- **Warnings are errors** (`-D warnings` via `tugrust/.cargo/config.toml`).
- The Reporter wake's callers of `list_facts_for_session_since` must be behaviorally untouched.
- All new SQL over `facts`/`sessions` must carry the `not_private!` exclusion (facts reads) or the `private = 0` predicate (`list_sessions_recent` already has it).
- Instruction strings and the Rust that renders their named sections must stay pinned to each other by contract tests, following `the_job_table_carries_every_contract_the_gates_depend_on` in `gazette_agent.rs`.

#### Assumptions {#assumptions}

- Sonnet (the Gazette pool's model) reliably uses an in-prompt `NOW` reference for epoch arithmetic once given one — the calibration read (deliverables) confirms.
- The composed retrieve turn with roster + examples stays well inside the job's practical input budget; Spec S02 caps the roster to bound it (Risk R01).

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

This plan follows the devise-skeleton v4 conventions: explicit `{#anchor}` on every cited heading, `[P##]` for plan-local decisions, `[Q##]` open questions, `Spec S##`, `Table T##`, `Risk R##`, `**Depends on:**` lines with `#step-N` anchors, and `**References:**` lines on every step. No line-number citations.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Human time rendering without a timezone name (RESOLVED) {#q01-time-rendering}

**Question:** How should the `NOW:` line and roster timestamps render local time, given chrono's `%Z` on `Local` prints a numeric offset (e.g. `-07:00`), not a zone name like `PDT`?

**Why it matters:** A format that promises a zone name chrono can't supply either panics into workarounds or ships a confusing hybrid.

**Resolution:** DECIDED (see [P01]) — render the offset, not a name: `Thursday, August 13, 2026, 2:41 pm (UTC-07:00)`. The model needs an unambiguous reference, not a locale-perfect one.

#### [Q02] Roster size and membership (RESOLVED) {#q02-roster-size}

**Question:** How many sessions ride the roster, and which?

**Resolution:** DECIDED (see Spec S02) — the 12 most recently used non-private sessions, all states, newest-first (`list_sessions_recent(None, None, false, 12)`). Active-first ordering was considered and rejected: `last_used_at DESC` already floats live sessions, and a second sort key complicates the rendering for no observed gain. `sessions.list` remains the verb for going deeper.

#### [Q03] Does `detail` ride `facts.window`'s worst case? (RESOLVED) {#q03-window-detail}

**Question:** `facts.window` can return 41 rows (`n=20` each side plus the hit). Does every row carry `detail`, and is the size math safe?

**Resolution:** DECIDED — yes, uniformly; every fact verb serves the same row shape ([P04]). Uniformity beats a special-cased thinner window row, and the caps in Table T01 bound each row.

The ceiling is **per round × rounds**, not per verb call. `OperatorPipeline::answer` accumulates into one `results` vec across both rounds and re-renders the whole vec each time (`rendered = render_results(&results)`), so round two's answer input carries round one's rows again — now fattened with `detail` — alongside its own. The true worst case is therefore up to `MAX_VERBS_PER_ROUND × MAX_RETRIEVAL_ROUNDS` (12) fact verbs' results in one input, not one 41-row window. Still bounded, and each row is capped, but the honest number is a dozen verbs' worth: comparable to a handful of `git.show`s (16 KB each) rather than to one. Accepted — the accumulation predates this plan and is what makes a second round *cumulative* rather than amnesiac, which is the property worth keeping. Measured rather than assumed in #step-7; revisit only if that measurement or the live read shows result bloat (Risk R02).

#### [Q04] Where does the prompt-detail cap constant live? (RESOLVED) {#q04-prompt-cap-home}

**Question:** `PROMPT_MAX_CHARS: usize = 500` lives in `operator.rs` (serving `session.prompts`); the `prompt` detail projection wants the same cap but is composed in `facts_library.rs`.

**Resolution:** DECIDED — the cap moves to `facts_library.rs` as `pub const PROMPT_TEXT_CAP: usize = 500`, and `operator.rs`'s `session_prompts` adopts it (delete the local `PROMPT_MAX_CHARS`, import the shared one). The existing `session_prompts_truncates_each_prompt` test keeps it honest.

The name matters, and `DETAIL_PROMPT_CAP` was the wrong one. The two uses are not one meaning: `session.prompts` is a verb whose entire product *is* prompt text, while `detail.text` is an incidental field on a fact row. What they share is a number and a subject — *how much of a prompt is enough to recognize it* — not a purpose. Naming the constant after the detail projection would make one of its two callers read as a stowaway, and would invite tuning the projection to silently retune the prompt-history verb. `PROMPT_TEXT_CAP` names the subject both agree on, and its doc-comment says the sharing is deliberate: if the two ever want different numbers, that is a split, not a drift.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Composed retrieve turn grows past a useful input budget | med | low | Roster capped at 12 lines with per-field truncation (Spec S02); examples are 3 short lines | The live read shows degraded verb selection |
| `detail` bloats verb results | med | low | Per-kind caps (Table T01); elisions are visible counts, never silent | A real answer turn's input visibly dominated by detail |
| Instruction / composer drift | med | med | Every new section header and instruction clause pinned by contract tests (existing doctrine) | Any pin assertion deleted without a replacement |

**Risk R01: Prompt growth** {#r01-prompt-growth}

- **Risk:** NOW + roster + examples fatten every retrieve/answer turn, paying tokens on questions that need none of it.
- **Mitigation:** Roster hard-capped (12 lines, truncated fields); NOW is one line; examples are three lines in the static instructions (paid once per job, not per section).
- **Residual risk:** A dozen roster lines ride turns about questions the channel alone could answer. Accepted: the discovery round they save is worth more.

**Risk R02: Detail bloat** {#r02-detail-bloat}

- **Risk:** 30–41 fact rows × per-kind detail could displace the question in the answer turn's input — and results accumulate across rounds ([Q03]), so a second round re-renders the first round's fattened rows alongside its own.
- **Mitigation:** Table T01 caps every unbounded field (file lists, prompt text, message lines); everything else in a payload is small scalars. The accumulated two-round answer input is measured directly in #step-7 rather than reasoned about.
- **Residual risk:** Worst-case inputs are large but bounded, and comparable to a handful of existing `git.show` results.

---

### Design Decisions {#design-decisions}

#### [P01] The clock is composed Rust-side and injected as an argument (DECIDED) {#p01-clock-injected}

**Decision:** Both compose functions gain a `now_ms: i64` parameter and print, as their first line, `NOW: <epoch_ms> — <human local rendering>` where the human form is `%A, %B %-d, %Y, %-I:%M %P` plus the numeric UTC offset, e.g. `NOW: 1786572090962 — Thursday, August 13, 2026, 2:41 pm (UTC-07:00)`.

**Rationale:**
- Epoch ms first because that is the unit of every `since_ms`/`until_ms` verb arg and every `at_ms` in results; the human form second because it is what the answer job's prose-time rule ("yesterday at 4:12pm", never raw epoch ms) converts *to* — a rule that is uncomputable without a *today*.
- Injected rather than read inside the compose functions so they stay pure and unit-testable with a fixed timestamp.
- Numeric offset, not a zone name: chrono's `%Z` on `Local` renders the offset — a zone-name promise is one chrono cannot keep ([Q01]).

**Implications:**
- `compose_retrieve_input` and `compose_answer_input` signatures change; the two call sites in `OperatorPipeline::answer` pass `now_ms()` (the module's existing helper).
- A `render_now_line(now_ms: i64) -> String` helper converts via `chrono::Local.timestamp_millis_opt(now_ms)`, falling back to the bare epoch number if the conversion fails.
- Both instruction strings name the `NOW:` line and what it is for; contract tests pin the name.

#### [P02] The session roster rides both turns (DECIDED) {#p02-roster-both-turns}

**Decision:** A `SESSIONS (newest first):` section (Spec S02) is composed once per question in `OperatorPipeline::answer` and rides both the retrieve turn and every answer turn.

**Rationale:**
- Retrieve: questions that name a session by project or topic resolve to an id *before* the first verb is chosen — round one does retrieval instead of discovery, which matters because round two is `forced`.
- Answer: the voice rule "name a session by its project and callsign, never a bare UUID" becomes satisfiable even when no `sessions.list` verb ran.
- Composed once and reused, like `scrollback` already is in `answer`.

**Implications:**
- A roster read failure degrades to a `(sessions unavailable)` line and never fails the question — the same posture as the Reporter wake's "a facts read must never cost a wake".
- The roster is **not** added to the ref-validation corpus: `validate_refs` already exempts Session refs, and file/commit refs must still come from verb results or scrollback, so the roster cannot become a hallucination laundering surface.

#### [P03] `facts.list` is a separate verb, time-ordered; `facts.search` stays relevance-ranked (DECIDED) {#p03-facts-list-verb}

**Decision:** Add a `facts.list` verb — all arguments optional (`kind`, `session_id`, `since_ms`, `until_ms`), newest-first, capped at 30 — backed by a new ledger read `list_facts`; `facts.search` is unchanged.

**Rationale:**
- The two orderings are different tools: `bm25` answers "find facts about X", recency answers "what happened". A query-optional search that silently switches sort order is a trap for the model choosing it.
- The teachable division ("search finds, list browses") goes verbatim into the instructions.
- `list_facts_for_session_since` stays untouched — it requires a session, lacks `until_ms`, and returns oldest-first for the wake composer; generalizing it in place would risk the wake's callers for no gain.

**Implications:**
- New `SessionLedger::list_facts` with the `not_private!` exclusion, `ORDER BY at_ms DESC, id DESC LIMIT ?`, every filter `?N IS NULL OR`-guarded (the `list_sessions_recent` filter idiom).
- `VERB_NAMES`, the dispatch table, and the instruction verb list all gain the entry; `the_verb_table_matches_the_instructions` enforces the instruction half automatically.

#### [P04] Depth is a curated per-kind `detail` projection beside `render_text` (DECIDED) {#p04-detail-projection}

**Decision:** `fact_json` keeps `text` as the one canonical rendering and gains a `detail` object: a per-kind projection of the payload (Table T01), composed by a new `render_detail(kind, payload)` in `facts_library.rs`, served uniformly by `facts.list`, `facts.search`, and `facts.window`.

**Rationale:**
- `fact_json`'s payload omission is principled — the library brief's [P02] (one rendering everywhere) and the kilobyte prompt payload are both real. A *curated projection* honors both: `text` stays canonical, and only capped, named fields cross the wire.
- The projection lives beside `render_text` so rendering and projection evolve together — the same anti-drift posture that put them in one module.
- Closes the observed detour: "which files were in that commit" currently spends a verb on `git.show` re-fetching what the payload already holds; `git.show` returns to being the confirming source for diffs and messages.

**Implications:**
- `FactKind` gains a `parse` inverse of `as_str` (round-trip tested) so `render_detail` can dispatch from `FactRow.kind: String`.
- Elisions are visible (a count field), never silent.
- The answer instructions gain one sentence: `detail` fields are exact; cite from them.
- **The refs that sentence invites will validate.** `validate_refs` checks against `format!("{scrollback}{rendered}")`, and `rendered` is the verb results — so a path or sha the model reads out of `detail` is, by construction, in the corpus its ref is checked against. Widening the corpus is not a loosening here: the corpus is *what the model was shown*, and `detail` is shown. Without it, "which files were in that commit" could only be cited after a `git.show` round put those paths in `rendered` — the detour closes at the ref end as well as at the retrieval end.

#### [P05] The roster carries full session uuids (DECIDED) {#p05-roster-full-uuids}

**Decision:** Roster lines spell the full 36-char session uuid, never an 8-char prefix.

**Rationale:**
- Verb args (`session_id`) and the answer's session-stamp gate (`sole_ledger_session` requires a full uuid via `is_session_uuid`) both need the full id; a prefix in the roster would make the model reconstruct — exactly the class of error ref validation exists to catch.

**Implications:**
- Roster lines are long; the per-field caps in Spec S02 keep them one line each.

#### [P06] `sessions.list` results gain `tag` and `synopsis` (DECIDED) {#p06-sessions-list-tag}

**Decision:** `sessions_list`'s JSON adds `tag` (the minted callsign, nullable) and `synopsis` (the rolling description, nullable), read off the `SessionRow` fields already in hand.

**Rationale:**
- The answer voice rule names sessions "by project and callsign" — currently data no verb supplies.
- `synopsis` answers "which session was the one about X" directly.

**Implications:**
- `synopsis` is truncated to the existing `INCIPIT_CHARS` (120) so fifty sessions stay a list, not a wall.

#### [P07] Instruction changes are pinned by contract tests (DECIDED) {#p07-instruction-pins}

**Decision:** Every new named section (`NOW:`, `SESSIONS (newest first):`), the search-vs-list sentence, the example renderings, and the `detail` clause get assertions in `gazette_agent.rs`'s contract tests, and the composer-side headers are `pub const`s the tests reference — the exact pattern of `FACTS_SECTION_HEADER`.

**Rationale:**
- "The string Rust prints is the string the model was told about" is the module's standing doctrine; a section the composer prints under a header the model was never told about is half wasted.

**Implications:**
- New `pub const NOW_HEADER` / `SESSIONS_HEADER` in `operator.rs`, referenced by both the composers and the `gazette_agent.rs` tests.

#### [P08] `MAX_RETRIEVAL_ROUNDS` stays 2 (DECIDED) {#p08-two-rounds}

**Decision:** No third round. The roster exists to make two rounds enough.

**Rationale:**
- Rounds are latency someone is watching; the observed waste was discovery, not depth.

**Implications:**
- Revisit only if the live read shows well-fed rounds still starving real questions; that is a knob decision for a future plan, not this one.

---

### Deep Dives {#deep-dives}

#### The Operator pipeline as it stands {#operator-pipeline-today}

All in `tugrust/crates/tugcast/src/feeds/operator.rs`:

- `OperatorContext { ledger: Arc<SessionLedger>, shell_ledger: Option<Arc<ShellLedger>>, bootstrap_project_dir: PathBuf }`.
- `OperatorPipeline { ctx, pool, gazette_tx }` — `handle(question, request_id)` persists/broadcasts the user's question first, then calls `answer(&question)`.
- `answer` reads `list_gazette_posts_tail(SCROLLBACK_POSTS /* 20 */)` → `render_scrollback`, runs the `operator-retrieve` job on `compose_retrieve_input(question, &scrollback)`, parses verbs (`parse_verbs`; unreadable ⇒ empty list and answer from the channel alone), executes up to `MAX_VERBS_PER_ROUND` (6) per round via `run_verb`, renders results (`render_results`), and runs `operator-answer` on `compose_answer_input(question, &scrollback, &rendered, forced)` for up to `MAX_RETRIEVAL_ROUNDS` (2) rounds; the final round is `forced`.
- On success, refs are validated against `format!("{scrollback}{rendered}")` via `reporter_wake::validate_refs` — the roster deliberately stays out of this corpus ([P02]).
- Current `compose_retrieve_input`: `format!("QUESTION:\n{question}\n\nRECENT GAZETTE POSTS:\n{scrollback}")`. Current `compose_answer_input`: optional forced-preamble, then QUESTION / RECENT GAZETTE POSTS / VERB RESULTS sections.
- `fact_json` serializes `id, at_ms, kind, session_id, subject, text` — payload deliberately absent (doc-comment cites the library's one-rendering posture).
- `sessions_list` serializes `session_id, incipit, project_dir, created_at_ms, last_used_at_ms, turn_count, state` from `list_sessions_recent(since, until, active, SESSIONS_LIMIT /* 50 */)` — whose SQL already excludes `private = 1` rows.
- Verb caps live at the top of the file: `FACTS_SEARCH_LIMIT = 30`, `FACTS_WINDOW_MAX_N = 20`, `SEARCH_LIMIT = 20`, `INCIPIT_CHARS = 120`, `PROMPT_MAX_CHARS = 500`, etc. `truncate(s, cap)` in this module is char-counting and appends `…`.
- The verbs↔instructions pin: `the_verb_table_matches_the_instructions` iterates `VERB_NAMES` asserting each appears in the `operator-retrieve` instructions.

#### The ledger reads behind it {#ledger-reads-today}

All in `tugrust/crates/tugcast/src/session_ledger.rs`:

- `FactRow { id: i64, at_ms: i64, kind: String, session_id: Option<String>, subject: Option<String>, text: String, payload: String }` — payload is the recorder's JSON, always present.
- `list_facts_for_session_since(session_id, kind, since_ms, limit)` — session **required**, no `until_ms`, inner `DESC LIMIT` then outer re-sort **ASC** (the wake wants oldest-first). Feeds every Reporter wake; do not touch.
- `facts_window(id, n)` — `id BETWEEN ?1-?2 AND ?1+?2`, ASC.
- `search_facts(query, filter, limit)` — FTS5 MATCH over `facts_fts(subject, text)`, `ORDER BY bm25(facts_fts) ASC`, filters via `FactSearchFilter { kind, session_id, since_ms, until_ms }`.
- Every facts read splices `not_private!("facts.session_id")` into its WHERE — the new `list_facts` must too.
- `list_sessions_recent(since_ms, until_ms, active_only, limit)` — `ORDER BY last_used_at DESC`, `private = 0` in SQL, returns full `SessionRow` including `tag`, `root_tag`, `tag_lineage`, `synopsis`, `name`, `name_user_set`.

#### `render_text` formats the examples must quote {#render-text-formats}

From `facts_library.rs::render_text` — the instructions' example lines (Spec S05) must match these shapes verbatim, because FTS matches against this text:

- prompt: `prompt: "why is the brio wash so pale"`
- shell: `$ just app-test at0365-gazette-card.test.ts → ok` (or `→ err`)
- test_run: `tests: nextest — passed (302 passed, 0 failed)`
- commit: `commit 3f16971ba0de "tugways(transcript-copy): route native ⌘C through onCopy substitution" — 4 file(s)` (12-char sha, first message line, file count)
- compaction: `context compacted (auto): 180000 → 12000 tokens`
- lifecycle: `session spawned in /path`, `session renamed "old" → "new"`, `session cleared`, etc.

#### Payload shapes per kind (what `render_detail` projects from) {#payload-shapes}

From the builders in `facts_library.rs` (`prompt_fact`, `commit_fact`, `shell_fact`/`ShellFact`, `test_run_fact`/`TestRunFact`, `compact_fact`, session lifecycle builders): `prompt` carries `text` (uncapped); `commit` carries `sha`, `branch`, `message` (full), `files` (array of paths), numstat fields as recorded; `shell` carries `command` (to the recorder's cap), `route` (`user`|`claude`), `ok`, `exit_code`, `cwd`; `test_run` carries `runner`, `verdict`, `passed`/`failed`/`skipped` (optional ints) and **nothing else** — the command that produced it lives on the paired `shell` fact (same dedupe suffix via `test_run_key`), which is where a question about the command should go; `session.compacted` carries `trigger`, `pre_tokens`/`post_tokens` (optional); lifecycle kinds carry small scalars (`project_dir`, `old`/`new`, `detail`). A field absent from a payload is projected as absent — never a stand-in default (the `render_text` rule: "a zero that means 'claude didn't say' is a lie with a number on it").

---

### Specification {#specification}

**Spec S01: The NOW line** {#s01-now-line}

First line of both composed turns:

```
NOW: <epoch_ms> — <Weekday>, <Month> <D>, <YYYY>, <h>:<mm> <am|pm> (UTC<±HH:MM>)
```

Rendered by `render_now_line(now_ms: i64) -> String` in `operator.rs` using `chrono::Local`. If `timestamp_millis_opt` does not yield a single valid local time, the line degrades to `NOW: <epoch_ms>` — never panics, never omits the epoch. The literal prefix `NOW: ` is `pub const NOW_HEADER: &str = "NOW: "` so the contract tests pin the same string the composer prints ([P07]).

**Spec S02: The SESSIONS roster** {#s02-sessions-roster}

A section in both composed turns, after the NOW line and before `QUESTION:`:

```
SESSIONS (newest first):
- <tag|"untagged"> <full-uuid> [<state>] <project_dir> — "<title-or-incipit>" — <synopsis> — last used <Mon D, h:mm am|pm>
```

- Header: `pub const SESSIONS_HEADER: &str = "SESSIONS (newest first):"` ([P07]).
- Membership: `list_sessions_recent(None, None, false, SESSIONS_ROSTER_LIMIT /* = 12 */)` ([Q02]) — private sessions already excluded in its SQL.
- Per-line fields: `tag` verbatim or the literal `untagged`; the **full** uuid ([P05]); `state` as `SessionRow.state.as_str()`; `project_dir` verbatim; title = `name` or `last_user_prompt` (the `sessions_list` incipit rule), truncated to `INCIPIT_CHARS`; synopsis truncated to `INCIPIT_CHARS`, omitted (with its ` — ` separator) when `None`; last-used rendered local via the same chrono path as S01, short form.
- Rendered by `render_session_roster(rows: &[SessionRow]) -> String` — a pure function over already-fetched rows, unit-testable without a ledger. It emits `SESSIONS_HEADER` itself, and an empty slice renders the header followed by `(no sessions)`.
- A **read error** is the caller's case, not the renderer's: `render_session_roster` never sees an `Err`, so `OperatorPipeline::answer` emits `SESSIONS_HEADER` followed by `(sessions unavailable)` itself and proceeds with the question ([P02]). Both sites reference the one `SESSIONS_HEADER` const, so the model is never shown a section under a header it was not told about ([P07]).

**Spec S03: The `facts.list` verb** {#s03-facts-list}

| | |
|---|---|
| Args | all optional: `kind` (one of the eleven kind strings), `session_id`, `since_ms`, `until_ms` |
| Backing | new `SessionLedger::list_facts(kind, session_id, since_ms, until_ms, limit)` — plain SELECT, `not_private!` exclusion, `ORDER BY at_ms DESC, id DESC`, `LIMIT` |
| Cap | `FACTS_LIST_LIMIT: usize = 30` |
| Result | `{ "facts": [<fact_json rows, newest first>], "count": N }` — same row shape as every fact verb, including `detail` once Step 5 lands |
| Errors | none beyond arg-type errors: an unknown `kind` returns zero rows rather than an error (it is a filter value, not a schema key) |

Instruction sentence (verbatim, pinned): `facts.search answers "find facts about X" (best matches first); facts.list answers "what happened" (newest first). Reach for facts.list when the question is a time or a session, not a topic. Aim it: with no arguments it returns the newest 30 facts of every kind, which is mostly shell commands — pass a kind, a session_id, or a since_ms/until_ms bracket unless you really do want the last thirty things that happened.`

The aiming clause earns its length. The fact base is dominated by `shell` and `prompt` rows, so a bare `facts.list` is a firehose that answers "what happened" literally and uselessly — and a model that spends its one narrow verb slot on it has burned a round. Teaching *when* to reach for the verb without teaching *how to aim it* is half an instruction.

**Spec S04: The `detail` projection** {#s04-detail-projection}

`pub fn render_detail(kind: FactKind, payload: &serde_json::Value) -> Option<serde_json::Value>` in `facts_library.rs`, per Table T01. `fact_json` calls it via the new `FactKind::parse(&fact.kind)`; an unparseable kind or an unparseable payload JSON yields `None`, and `fact_json` omits the `detail` key entirely — never an empty object. Absent payload fields are absent in the projection (see #payload-shapes).

**Table T01: `detail` fields and caps per kind** {#t01-detail-caps}

| Kind | `detail` fields | Caps |
|------|-----------------|------|
| `commit` | `sha`, `branch`, `message_first_line` (full first line, uncollapsed by `TEXT_CAP`), `files` (paths), `files_elided` (count, only when elided) | files capped at `DETAIL_FILES_CAP = 40` paths |
| `test_run` | `runner`, `verdict`, `passed`, `failed`, `skipped` | none needed (small scalars) |
| `shell` | `command`, `route`, `ok`, `exit_code`, `cwd` | command as recorded (recorder already caps) |
| `prompt` | `text` | `PROMPT_TEXT_CAP = 500` chars, char-counting `truncate` ([Q04]) |
| `session.compacted` | `trigger`, `pre_tokens`, `post_tokens` | none |
| `session.spawned` / `.resumed` | `project_dir` | none |
| `session.closed` / `.errored` | `detail` | none |
| `session.renamed` | `old`, `new` | none |
| `session.reset` | *(no detail — `None`)* | — |

**Spec S05: Instruction additions** {#s05-instruction-additions}

`OPERATOR_RETRIEVE_INSTRUCTIONS`:
- `facts.list` row in the verb list with its args, adjacent to `facts.search`.
- The search-vs-list sentence from Spec S03, verbatim.
- Three example fact renderings, verbatim from #render-text-formats (one shell, one test_run, one commit), introduced as "fact text looks like this — compose your queries against these words".
- A short paragraph naming the `NOW:` line ("the current time; verb time arguments are epoch milliseconds — compute them from NOW") and the `SESSIONS (newest first):` roster ("the sessions the questions are usually about; use their ids in verb arguments instead of spending a verb discovering them").

`OPERATOR_ANSWER_INSTRUCTIONS`:
- Names the same two sections; the prose-time rule gains "compute reader times from the NOW line".
- One sentence on `detail`: "fact results may carry a detail object; its fields are exact — cite files, totals, and shas from it".

All of the above pinned in `gazette_agent.rs`'s contract tests ([P07]).

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

None — every change lands in existing modules.

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `list_facts` | fn (new) | `session_ledger.rs` | all-optional filters + `until_ms`, newest-first, `not_private!` |
| `FactKind::parse` | fn (new) | `feeds/facts_library.rs` | inverse of `as_str`, round-trip tested |
| `render_detail` | fn (new) | `feeds/facts_library.rs` | Spec S04 / Table T01 |
| `PROMPT_TEXT_CAP`, `DETAIL_FILES_CAP` | const (new) | `feeds/facts_library.rs` | 500 / 40 |
| `PROMPT_MAX_CHARS` | const (delete) | `feeds/operator.rs` | replaced by `PROMPT_TEXT_CAP` ([Q04]) |
| `NOW_HEADER`, `SESSIONS_HEADER` | const (new, pub) | `feeds/operator.rs` | pinned by gazette_agent tests |
| `SESSIONS_ROSTER_LIMIT`, `FACTS_LIST_LIMIT` | const (new) | `feeds/operator.rs` | 12 / 30 |
| `render_now_line` | fn (new) | `feeds/operator.rs` | Spec S01 |
| `render_session_roster` | fn (new) | `feeds/operator.rs` | Spec S02, pure over `&[SessionRow]` |
| `facts_list` | fn (new) | `feeds/operator.rs` | Spec S03 verb executor |
| `VERB_NAMES` | const (modify) | `feeds/operator.rs` | + `"facts.list"` (and `dispatch` arm) |
| `fact_json` | fn (modify) | `feeds/operator.rs` | + `detail` via `render_detail` |
| `sessions_list` | fn (modify) | `feeds/operator.rs` | + `tag`, `synopsis` ([P06]) |
| `compose_retrieve_input` | fn (modify) | `feeds/operator.rs` | + `now_ms`, `roster` params; NOW + SESSIONS sections |
| `compose_answer_input` | fn (modify) | `feeds/operator.rs` | same |
| `OperatorPipeline::answer` | fn (modify) | `feeds/operator.rs` | roster read + threading |
| `OPERATOR_RETRIEVE_INSTRUCTIONS` | const (modify) | `feeds/gazette_agent.rs` | Spec S05 |
| `OPERATOR_ANSWER_INSTRUCTIONS` | const (modify) | `feeds/gazette_agent.rs` | Spec S05 |

---

### Documentation Plan {#documentation-plan}

- [ ] Module doc-comments carry the design where the code lives (the crate's convention): `render_detail`'s header states the projection-not-payload posture; `fact_json`'s doc-comment is updated in #step-5; `list_facts` documents its newest-first contrast with `list_facts_for_session_since`.
- [ ] No freestanding docs — the brief and this plan are the durable record; `dash/facts-library-access-brief.md` is archived by the user at landing per the roadmap convention.

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit** | compose/render functions with fixed inputs; ledger reads against in-memory ledgers seeded through the production builders | S01, S02, S03 semantics, T01 caps |
| **Contract** | instruction strings pinned against the constants Rust prints; verb list pinned against executors | every S05 clause ([P07]) |
| **Integration** | `run_verb` against a seeded fixture (the module's existing `fixture()` pattern with a real temp git repo) | `facts.list` end to end, `detail` on every fact verb |

#### What stays out of tests {#test-non-goals}

- Live model behavior (whether Sonnet actually computes times or picks `facts.list` well) — that is the human calibration read in #deliverables, not a unit-testable property.
- App-tests — nothing here has a deck-visible surface; the Gazette card renders posts the same either way. Rust-layer coverage is the whole story (per the transient-workspace precedent).
- `chrono::Local`'s correctness — we test our formatting with fixed timestamps, not the system tz database.

---

### Execution Steps {#execution-steps}

> **Commit after all checkpoints pass.** Run tests as `cd tugrust && cargo nextest run -p tugcast` (warnings are errors; the workspace enforces `-D warnings`).

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | The clock | done | `3b311407c` |
| #step-2 | The session roster | done | `049827a9e` |
| #step-3 | The `list_facts` ledger read | done | `3461aaec8` (folded with #step-4) |
| #step-4 | The `facts.list` verb | done | `3461aaec8` |
| #step-5 | The `detail` projection | done | `f10b03ace` |
| #step-6 | `sessions.list` gains tag + synopsis; answer instructions learn `detail` | done | `4ff98ac02` |
| #step-7 | Integration checkpoint | done | `eadf1fed4` |

---

#### Step 1: The clock {#step-1}

**Commit:** `gazette(operator-clock): stamp NOW on both composed turns`

**References:** [P01] clock injected, [P07] instruction pins, Spec S01, (#operator-pipeline-today, #q01-time-rendering)

**Artifacts:**
- `NOW_HEADER`, `render_now_line` in `feeds/operator.rs`; both compose functions take `now_ms: i64` and open with the NOW line; both instruction strings in `feeds/gazette_agent.rs` explain it.

**Tasks:**
- [ ] Add `pub const NOW_HEADER: &str = "NOW: "` and `render_now_line(now_ms: i64) -> String` per Spec S01 (chrono `Local.timestamp_millis_opt`; on ambiguity/failure degrade to `NOW: <epoch_ms>`).
- [ ] Change `compose_retrieve_input(now_ms: i64, question: &str, scrollback: &str)` and `compose_answer_input(now_ms: i64, question: &str, scrollback: &str, results: &str, forced: bool)` to open with the NOW line (after the forced-preamble in the answer case, so the LAST-ROUND warning stays first).
- [ ] Thread `now_ms()` from the two call sites in `OperatorPipeline::answer`.
- [ ] Add the NOW paragraph to `OPERATOR_RETRIEVE_INSTRUCTIONS` and `OPERATOR_ANSWER_INSTRUCTIONS` (Spec S05), including "verb time arguments are epoch milliseconds — compute them from NOW".

**Tests:**
- [ ] `render_now_line` with a fixed timestamp: contains the epoch number and a `(UTC` offset; starts with `NOW_HEADER`.
- [ ] Both compose functions with a fixed `now_ms`: output starts with (or, when `forced`, contains before `QUESTION:`) the NOW line.
- [ ] In `gazette_agent.rs`'s contract test: both instruction strings contain `crate::feeds::operator::NOW_HEADER` and the epoch-milliseconds clause.

**Checkpoint:**
- [ ] `cd /Users/kocienda/Mounts/u/src/tugtool/tugrust && cargo nextest run -p tugcast` — green, no warnings.

---

#### Step 2: The session roster {#step-2}

**Depends on:** #step-1

**Commit:** `gazette(operator-roster): ride a session roster on both composed turns`

**References:** [P02] roster both turns, [P05] full uuids, [P07] instruction pins, Spec S02, [Q02], (#ledger-reads-today)

**Artifacts:**
- `SESSIONS_HEADER`, `SESSIONS_ROSTER_LIMIT`, `render_session_roster` in `feeds/operator.rs`; roster threaded through both compose functions; instruction paragraphs.

**Tasks:**
- [ ] Add `pub const SESSIONS_HEADER: &str = "SESSIONS (newest first):"` and `SESSIONS_ROSTER_LIMIT: usize = 12`.
- [ ] Add `render_session_roster(rows: &[SessionRow]) -> String` per Spec S02: per-line `tag|untagged`, full uuid, `[state]`, project_dir, quoted title-or-incipit (truncate to `INCIPIT_CHARS`), synopsis when present (truncate to `INCIPIT_CHARS`), last-used local short form; `(no sessions)` for an empty slice.
- [ ] In `OperatorPipeline::answer`, read `list_sessions_recent(None, None, false, SESSIONS_ROSTER_LIMIT)` once per question; on `Err`, log a `warn!` and render the header + `(sessions unavailable)` — the question proceeds ([P02]).
- [ ] Thread the rendered roster into both compose functions (`roster: &str` param), placed after the NOW line and before `QUESTION:`.
- [ ] Do **not** add the roster to the `validate_refs` corpus (`format!("{scrollback}{rendered}")` stays as is) — [P02]'s implication.
- [ ] Add the SESSIONS paragraph to both instruction strings (Spec S05): use roster ids in verb args instead of spending a verb on discovery; name sessions in prose by callsign/title, ids belong in refs.

**Tests:**
- [ ] `render_session_roster` on seeded `SessionRow`s: full uuid present, tag verbatim, `untagged` fallback, synopsis omitted cleanly when `None`, truncation at `INCIPIT_CHARS`, empty slice renders `(no sessions)`.
- [ ] Compose-function test: roster section appears between NOW and `QUESTION:` in both turns.
- [ ] Contract test: both instruction strings contain `SESSIONS_HEADER`.
- [ ] A roster rendered from a ledger holding one private and one public session contains only the public one (drives `list_sessions_recent`'s existing exclusion through the new path).

**Checkpoint:**
- [ ] `cd /Users/kocienda/Mounts/u/src/tugtool/tugrust && cargo nextest run -p tugcast` — green, no warnings.

---

#### Step 3: The `list_facts` ledger read {#step-3}

**Commit:** `tugcast(session-ledger): list_facts — the all-optional, newest-first facts read`

**References:** [P03] separate verb, Spec S03, (#ledger-reads-today)

**Artifacts:**
- `SessionLedger::list_facts` in `session_ledger.rs`; `list_facts_for_session_since` untouched.

**Tasks:**
- [ ] Add `pub fn list_facts(&self, kind: Option<&str>, session_id: Option<&str>, since_ms: Option<i64>, until_ms: Option<i64>, limit: usize) -> Result<Vec<FactRow>, LedgerError>`: plain SELECT over `facts` with each filter `(?N IS NULL OR …)`-guarded (the `list_sessions_recent` idiom), the `not_private!("facts.session_id")` splice, `ORDER BY at_ms DESC, id DESC`, `LIMIT`. Newest-first output — no outer re-sort (contrast with `list_facts_for_session_since`, which re-sorts ASC for the wake composer).

**Tests:**
- [ ] Zero filters returns the newest `limit` facts, newest-first (seed more than `limit` through the production builders, the desk tests' `seed_fact` pattern).
- [ ] Each of `kind`, `session_id`, `since_ms`, `until_ms` narrows independently; `since`+`until` bracket a window.
- [ ] Facts of a private session are excluded (seed, mark private, list).

**Checkpoint:**
- [ ] `cd /Users/kocienda/Mounts/u/src/tugtool/tugrust && cargo nextest run -p tugcast` — green, no warnings.

---

#### Step 4: The `facts.list` verb {#step-4}

**Depends on:** #step-3

**Commit:** `gazette(operator-facts-list): browse the fact base by kind, session, and time`

**References:** [P03] facts.list verb, [P07] instruction pins, Spec S03, Spec S05, (#render-text-formats)

**Artifacts:**
- `facts_list` executor, `FACTS_LIST_LIMIT`, `VERB_NAMES` + dispatch entries in `feeds/operator.rs`; verb row, division sentence, and example renderings in `OPERATOR_RETRIEVE_INSTRUCTIONS`.

**Tasks:**
- [ ] Add `FACTS_LIST_LIMIT: usize = 30` and `fn facts_list(ctx, args)` reading the four optional args (`opt_str`/`opt_i64`), calling `ledger.list_facts`, returning `{ "facts": [...], "count": N }` via `fact_json`.
- [ ] Add `"facts.list"` to `VERB_NAMES` and the `dispatch` match. Update `VERB_NAMES`'s doc-comment — it says "the retrieval instructions list the same **twelve**", which becomes thirteen and which `-D warnings` cannot catch.
- [ ] Instructions: the `facts.list` verb row beside `facts.search`; the search-vs-list sentence **including its aiming clause**, verbatim from Spec S03; the three example renderings verbatim from #render-text-formats, introduced per Spec S05.

**Tests:**
- [ ] `run_verb("facts.list", {})` on a seeded fixture returns newest-first, capped at `FACTS_LIST_LIMIT`.
- [ ] `kind` + `since_ms` narrow through the verb layer; an unknown `kind` returns zero rows, not an error.
- [ ] Contract tests: `the_verb_table_matches_the_instructions` passes (automatic once the instruction row lands); new assertions pin the division sentence, its aiming clause, and at least one example rendering line.

**Checkpoint:**
- [ ] `cd /Users/kocienda/Mounts/u/src/tugtool/tugrust && cargo nextest run -p tugcast` — green, no warnings.

---

#### Step 5: The `detail` projection {#step-5}

**Depends on:** #step-4

**Commit:** `gazette(facts-detail): project each fact's recorded depth into verb results`

**References:** [P04] detail projection, Spec S04, Table T01, [Q03], [Q04], (#payload-shapes)

**Artifacts:**
- `FactKind::parse`, `render_detail`, `PROMPT_TEXT_CAP`, `DETAIL_FILES_CAP` in `feeds/facts_library.rs`; `fact_json` gains `detail`; `session_prompts` adopts `PROMPT_TEXT_CAP`.

**Tasks:**
- [ ] Add `FactKind::parse(s: &str) -> Option<FactKind>` as the exact inverse of `as_str`.
- [ ] Add `pub const PROMPT_TEXT_CAP: usize = 500;` (doc-comment: two deliberate callers, one subject — see [Q04]) and `pub const DETAIL_FILES_CAP: usize = 40;`.
- [ ] Add `pub fn render_detail(kind: FactKind, payload: &serde_json::Value) -> Option<serde_json::Value>` per Table T01: absent payload fields absent in the projection; commit `files` capped at `DETAIL_FILES_CAP` with `files_elided` only when elided; prompt `text` truncated char-wise to `PROMPT_TEXT_CAP`; `session.reset` returns `None`. **No `command` on `test_run`** — the payload has none (#payload-shapes).
- [ ] In `fact_json` (`feeds/operator.rs`): parse `fact.payload` and `fact.kind`; on both succeeding and `render_detail` returning `Some`, add the `detail` key; otherwise omit it entirely. Update the fn's doc-comment — the one-rendering posture holds for `text`; `detail` is the curated projection, not the payload.
- [ ] Replace `PROMPT_MAX_CHARS` in `operator.rs` with `facts_library::PROMPT_TEXT_CAP` at its `session_prompts` use sites and in the `session_prompts_truncates_each_prompt` test ([Q04]).

**Tests:**
- [ ] `FactKind::parse` round-trips every variant against `as_str`.
- [ ] `render_detail` per kind: commit files + cap + `files_elided`; test_run totals; shell exit_code/route/cwd; prompt cap at `PROMPT_TEXT_CAP`; compaction tokens; absent fields absent; `session.reset` → `None`.
- [ ] Through the verb layer: `facts.list`, `facts.search`, and `facts.window` rows for a seeded commit fact all carry `detail.files`; a fact row with garbage payload JSON serves no `detail` key and no error.

**Checkpoint:**
- [ ] `cd /Users/kocienda/Mounts/u/src/tugtool/tugrust && cargo nextest run -p tugcast` — green, no warnings.

---

#### Step 6: `sessions.list` gains tag + synopsis; answer instructions learn `detail` {#step-6}

**Depends on:** #step-5

**Commit:** `gazette(operator-sessions): serve callsign and synopsis; answers cite detail`

**References:** [P06] sessions.list fields, [P07] instruction pins, Spec S05, (#operator-pipeline-today)

**Artifacts:**
- `sessions_list` JSON with `tag` + `synopsis`; the `detail` sentence in `OPERATOR_ANSWER_INSTRUCTIONS`.

**Tasks:**
- [ ] In `sessions_list`, add `"tag": row.tag` and `"synopsis": row.synopsis.as_deref().map(|s| truncate(s, INCIPIT_CHARS))` to the serialized object.
- [ ] Add the `detail` sentence to `OPERATOR_ANSWER_INSTRUCTIONS` per Spec S05.

**Tests:**
- [ ] `sessions.list` on a fixture whose session has a tag and a synopsis serves both; a legacy row without them serves nulls.
- [ ] Contract test pins the `detail` sentence in the answer instructions.

**Checkpoint:**
- [ ] `cd /Users/kocienda/Mounts/u/src/tugtool/tugrust && cargo nextest run -p tugcast` — green, no warnings.

---

#### Step 7: Integration checkpoint {#step-7}

**Depends on:** #step-1, #step-2, #step-4, #step-5, #step-6

**Commit:** `N/A (verification only)`

**References:** (#success-criteria), Spec S01–S05, Risk R01

**Tasks:**
- [ ] Re-read `OPERATOR_RETRIEVE_INSTRUCTIONS` and `OPERATOR_ANSWER_INSTRUCTIONS` end to end for coherence — the sections now named (NOW, SESSIONS), the verb table with `facts.list`, the examples, the detail clause — and confirm no stale sentence contradicts the new surface. Two specifically: the "Strategy that works" paragraph steers toward `git.show` to *confirm* a commit, which `detail` partly obsoletes for file lists (`git.show` stays the confirming source for diffs and message bodies — say that rather than leaving the old steer unqualified); and the division sentence must read correctly beside it rather than as a competing strategy.
- [ ] Compose one full retrieve input against an in-memory ledger seeded with a dozen sessions and a few dozen facts; eyeball the assembled turn's size and shape in a test that prints it (Risk R01's measurement).
- [ ] Compose the **accumulated second-round answer input** — the turn `detail` actually rides ([Q03]): render two rounds' worth of fact-verb results into one `results` vec the way `answer` does (a `facts.window` at `n = FACTS_WINDOW_MAX_N` over seeded commit facts, plus a full `facts.list`, then a second round on top), and print its length. This is Risk R02's measurement, and the retrieve turn cannot stand in for it — `detail` never appears there.

**Tests:**
- [ ] A composed-turn snapshot-style assertion: NOW line, SESSIONS section, QUESTION, RECENT GAZETTE POSTS appear in order in the retrieve input; NOW/SESSIONS/QUESTION/POSTS/VERB RESULTS in the answer input — and, with `forced`, the LAST-ROUND preamble still ahead of the NOW line.
- [ ] The accumulated-input measurement above, asserted as a ceiling rather than only printed, so a later cap change that blows it up fails a test instead of a live read.

**Checkpoint:**
- [ ] `cd /Users/kocienda/Mounts/u/src/tugtool/tugrust && cargo nextest run -p tugcast` — the whole crate green, no warnings.
- [ ] `cd /Users/kocienda/Mounts/u/src/tugtool/tugrust && cargo build` — clean.

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** The Operator's turns carry a clock and a session roster; the fact base is browsable (`facts.list`) as well as searchable; every fact verb serves per-kind depth (`detail`); `sessions.list` serves callsigns and synopses; and the instructions teach all of it, pinned by contract tests.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] All success criteria in #success-criteria verified by the named tests (`cargo nextest run -p tugcast`).
- [ ] The Step Status Ledger shows every step `done` with its commit.

**Acceptance tests:**
- [ ] The composed-turn ordering test (#step-7).
- [ ] The per-kind `detail` tests (#step-5) and per-filter `facts.list` tests (#step-3, #step-4).

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] **The live worked-examples read** (a human read, post-merge): ask the live Operator "what did I ask yesterday", "what tests failed this morning", "when did I last clear that session", "what did we commit Tuesday", "what happened in session X this morning", "every test run yesterday" — watching which verbs it now picks and whether prose times/callsigns land. Instruction tuning that reading demands is a follow-on commit, not a phase gate.
- [ ] Revisit `MAX_RETRIEVAL_ROUNDS` ([P08]) only if that read shows well-fed rounds still starving real questions.
- [ ] A retroactive-scrub privacy follow-on remains deferred from the library brief; nothing here changes its standing.

| Checkpoint | Verification |
|------------|--------------|
| Whole-crate green | `cd tugrust && cargo nextest run -p tugcast` |
| Clean build | `cd tugrust && cargo build` |
