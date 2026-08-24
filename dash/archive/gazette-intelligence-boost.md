## Gazette Intelligence Boost {#gazette-intelligence-boost}

**Purpose:** Make the Gazette's Operator reliably answer topical questions ("what was the recent commit where we tried to regularize tooltip colors and presentation?") from the facts library, the channel, and git — by fixing the index vocabulary, the ranking, and the query path that today lose answers the ledger demonstrably holds.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-08-15 |

---

### Review Record {#review-record}

**Round 1 — 2026-08-15, opus.** Reviewed `plan:0e037794375d9747`. Lint: 0 errors, 1 warning (fixed — this section is what PL023 wanted).
Oriented on: the whole document, this being the first round on a plan that has never been reviewed and is not yet tracked in git.
Applied: **migration sequencing** — Spec S03's step order was authored against an imagined `open()` and contradicted the real `bootstrap_schema`, which runs drift-guards → `migrate_*` ALTERs → one `execute_batch` → post-batch work; a drop placed after the batch would never be followed by a create, so the spec is now phased (A–D) into that structure and #bootstrap-order records it for the implementer. **Law [LR5] corollary** (`tuglaws/ledger-reliability.md`) — the spec's shape probes and `DROP TABLE`s were unqualified, and on a connection with `changes` attached an unqualified name resolves into the attachment when the local table is absent; every FTS name is now `main.`-qualified, matching the existing `main.file_events` guard. [LR5]'s shared-schema ban was cross-checked and is honored: `sessions.db` is per-instance and an FTS index is derivable state, the `turn_telemetry`-class carve-out. **Trigger survival** — `CREATE TRIGGER IF NOT EXISTS` cannot replace an existing trigger, so the batch would have left old two-column sync triggers writing into a three-column index; the drop is now explicit, with a risk row and an insert-after-migration test. **Silent excerpt regression** — `search_facts` selects `snippet(facts_fts, -1, …)`, and `-1` means auto-select, so the new `tokens` column would start supplying excerpts the Operator quotes into answers; pinned to the `text` column, moved into Step 2 (the step that creates the hazard, not Step 3), and given a content assertion, since the three excerpt tests that exist only check non-empty/is-string and would all stay green. **Crash window** — keying the FTS rebuild to "index dropped" alone would strand trigger-written garbage forever if the process died mid-backfill; the condition is now "dropped **or** backfill updated ≥1 row", with backfill and rebuild named as an inseparable pair. **Existing machinery** ([P03] axis) — the bespoke `sqlite_master` DDL-text probe is replaced by the `table_columns` / `rebuild_table_if_schema_drifted` idiom that already ships, with the one documented reason it needs a variant (triggers). **Dependency honesty** — Step 7 mutates the `OperatorContext` literal Step 6 introduces, so it now declares `#step-6`; the "four construction sites" claim was verified against `main.rs` and the two `operator.rs` test sites. Also verified and left alone: `scripted_haiku_pool` is `pub(crate)` in `#[cfg(test)] mod test_support` and documented for exactly this cross-module use, so Step 7's test plan stands.
Deferred: nothing. Every finding was settleable from the code or the laws, so no question was raised to the user and no `[Q##]` was added; [Q01] remains the plan's only open question, deliberately deferred at authoring time with its findings and successor path recorded.

---

### Phase Overview {#phase-overview}

#### Context {#context}

On 2026-08-15 the user asked the Gazette: *"what was the recent commit where we tried to regularize tooltip colors and presentation?"* The Operator answered that it could not pin down the commit. The answer exists in every layer the Operator can reach: git holds `ac462ba3a` ("tugways(entity-tips): unify commit hover into a real TugTooltip", 2026-08-13, 27 files, the commit that created `dash/tooltip-cleanups-brief.md`); the facts library holds it as a `commit` fact (id 6291 in the release-main ledger) *and* holds the prompt that started the work; the channel holds four Reporter posts narrating the session. The investigation (this plan's ancestry) reproduced each failure against the live release ledger:

1. **Vocabulary.** `facts_fts` uses FTS5's default unicode61 tokenizer, which holds `TugTooltip` as the single token `tugtooltip`. `MATCH 'tooltip'` and even `MATCH 'tooltip*'` do not match the one commit fact that answers the question (verified directly: fact 6291 matches `'tugtooltip'` only). Tug's own naming convention — Tug-prefixed CamelCase components, kebab-case files, `at0365`-style test ids — systematically defeats its own index.
2. **Ranking and budget.** `MATCH 'tooltip'` returns 39 facts; the top 30 by raw `bm25()` (the `FACTS_SEARCH_LIMIT` page) are 28 `shell` facts — the greps the tooltip session itself ran — plus one `prompt` and one `session.renamed`. A `commit` fact can never win a "which commit" question against dozens of shell commands that literally contain the query word.
3. **Fragile query, no recovery.** The natural phrase query `'tooltip colors'` matches **zero** facts (FTS5 implicit AND). An empty result costs the model its round; with `MAX_RETRIEVAL_ROUNDS = 2` one mis-aimed first round is fatal. The Operator's closing line — "I'd need a search scoped to 'tooltip' in the commit history" — wished for `git.log`'s `grep` argument, which it already has.
4. **No observability.** The log records only `shared agent call task=operator-retrieve outcome=ok elapsed_ms=…`. The verbs and arguments the model chose are not logged anywhere; the incident could only be reconstructed by inference.

This plan fixes all four, in the layer order that matters: index vocabulary (with its migration), ranking and result budgeting, deterministic Rust-side query recovery, instruction teaching, and per-verb logging — closed out by replaying the original question against a copy of the real ledger and requiring the right commit.

#### Strategy {#strategy}

- Fix the data layer first: a sub-word `tokens` column in both FTS indexes makes plain-English queries match CamelCase/kebab-case/path vocabulary at all. Everything downstream assumes this exists.
- Rank with intent: weight `subject` above `text` above `tokens`, and budget the result page across fact kinds in Rust so one noisy kind (`shell`) cannot spend the whole page.
- Recover deterministically, not heroically: when a sanitized query returns zero rows, the *system* retries with relaxed and sub-word-expanded variants before the model ever sees an empty result. Model rounds are precious (two, by design); Rust retries are free.
- Reach past vocabulary with the model we already have: a last-resort Haiku expansion rung turns a question with no shared words into candidate search terms, buying most of what semantic recall would buy without a new model asset ([P09], [Q01]).
- Teach the model what is now true: retrieve/answer instructions gain the FTS semantics, the kind-aiming rule, and the "recent commit about X is `git.log grep=X`" pattern; the pinning tests move with them.
- Land observability with the first commit (per-verb INFO logging), so every later step of this plan is diagnosable while it is being built.
- Verify against reality: a new hidden `tugcast operator-ask` subcommand runs the real pipeline against a named ledger copy, and the exit criterion is the original question answered with `ac462ba3a`.

#### Success Criteria (Measurable) {#success-criteria}

- `facts.search` with query `tooltip` against a ledger containing fact 6291's text returns that commit fact on the first page (unit test on a seeded ledger; manual check against a release-ledger copy).
- `facts.search` with the phrase query `tooltip colors` returns non-empty results (the recovery ladder relaxes it) and the result JSON says what query was actually used (unit test).
- A search page is never all one kind when other kinds matched: with 35 matching `shell` facts and 2 matching `commit` facts seeded, the page contains both `commit` facts (unit test).
- Every executed verb produces one INFO log line naming the verb, its args, ok/err, and elapsed time (log inspection during the closing replay).
- `tugcast operator-ask --db <copy> "what was the recent commit where we tried to regularize tooltip colors and presentation?"` answers with `ac462ba3a` (closing verification, real model, real ledger copy).
- A pre-migration ledger (no `tokens` column, old FTS shape) opens cleanly, backfills, rebuilds its FTS, and answers the vocabulary queries above (migration unit test).
- A query sharing **no** token with the record it should find returns rows via the [P09] expansion rung, and returns the honest empty result when the pool is absent (unit test with a scripted Haiku pool — `scripted_haiku_pool` already exists in `shared_agent.rs`'s test module — plus a `haiku: None` case).

#### Scope {#scope}

1. Sub-word tokenization: a normalizer, a `tokens` column on `facts` and `gazette_posts`, both FTS tables re-shaped to index it, and the self-healing migration that gets existing ledgers there.
2. Ranking: bm25 column weights and kind-diversity result budgeting in `facts.search`; column weights in `gazette.search`.
3. Query hygiene and recovery: sanitize model-written FTS queries, and on empty results retry with a deterministic relaxation ladder, in `facts.search` and `gazette.search`.
4. A last-resort model expansion rung on that ladder, served by the existing Haiku pool ([P09], Spec S06).
5. Operator instruction updates (retrieve and answer) plus their pinning tests.
6. Per-verb INFO logging in the Operator pipeline.
7. `tugcast operator-ask` — a hidden CLI subcommand to run the Operator pipeline against a named ledger, for verification and future calibration.

#### Non-goals (Explicitly out of scope) {#non-goals}

- Vector/embedding retrieval — deferred with findings and a named successor path in [Q01]. [P09]'s expansion rung is model-mediated *lexical* recall, not a vector space, and shipping it does not make this plan a semantic-search plan.
- Reviving on-device inference ([Q01] establishes it is gone; [P09] deliberately needs nothing local).
- Raising `MAX_RETRIEVAL_ROUNDS` (see [P05]).
- FTS over `shell_exchanges.db` — `shell.history` keeps its substring search.
- Changing the Operator's model, timeouts, worker caps, or scrollback size.
- Any tugdeck/frontend change — the Gazette card renders answers; nothing about rendering changes.
- Backfilling facts for work that predates the facts library (the library starts 2026-08-12; older history is git's to answer, which is what the `git.log grep` teaching is for).

#### Dependencies / Prerequisites {#dependencies}

- rusqlite 0.33 with the `bundled` feature (workspace `tugrust/Cargo.toml`) — SQLite ≥ 3.45, so FTS5 external-content tables, the `'rebuild'` command, and `bm25()` column weights are all available.
- The existing self-healing migration idiom in `session_ledger.rs` (idempotent `ALTER TABLE … ADD COLUMN` with the `is_duplicate_column` helper near the bottom of the file).
- A copy of the release-main ledger for the closing verification (`just db-inspect` produces one; the copy path is what `operator-ask --db` takes).
- The Haiku agent pool (`HAIKU_AGENT_JOBS` / `SharedAgentPool` in `shared_agent.rs`), already constructed in `main.rs`, for [P09]'s expansion rung. Nothing new is stood up — a second `AgentSpec` would be, and is not wanted here.

#### Constraints {#constraints}

- **Warnings are errors** (`-D warnings` via `tugrust/.cargo/config.toml`).
- **Never open live ledger DBs with foreign SQLite**; the closing verification runs against a *copy*. Writable ledger opens go through `tugcore::ledger_db` (enforced by the `no_ad_hoc_ledger_opens` test) — `operator-ask` opens its ledger the same way `SessionLedger::open` always does.
- `sessions.db` is per-instance and uses **self-healing idempotent migrations on open** — there is no migrations table and no version bump for it (that regime belongs to the shared `changes.db` only). All schema work in this plan must be idempotent and safe to run on every open.
- The Operator's model-facing error strings are read by a model, not a human log — keep that voice in anything new that returns `Err(String)`.
- Instruction strings are pinned by tests in `gazette_agent.rs` (`the_job_table_carries_every_contract_the_gates_depend_on` and neighbors); wording changes must move the pins in the same commit.

#### Assumptions {#assumptions}

- The facts corpus stays small enough (tens of thousands of rows) that overfetch-then-budget in Rust and full FTS rebuilds on migration are cheap. The release-main ledger is ~20 MB with ~9.6k facts after three days; even 100× that rebuilds in seconds.
- Sonnet remains the Operator model (`DEFAULT_MODEL = "sonnet"` in `gazette_agent.rs`); nothing in this plan depends on a smarter model, and that is deliberate — the data layer should carry the weight.

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

This plan follows `tuglaws/devise-skeleton.md`: explicit `{#anchor}` on every cited heading, kebab-case anchors without phase numbers, two-digit stable labels (`[P01]`, `[Q01]`, `S01`, `R01`), `**References:**` lines citing labels and anchors (never line numbers), and `**Depends on:**` lines carrying `#step-N` anchors.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Embedding-based retrieval as a second recall channel (DEFERRED) {#q01-embedding-retrieval}

**Question:** Should the facts library also carry a vector index so questions match facts by meaning rather than by shared vocabulary?

**Why it matters:** Sub-word tokenization ([P01]) and the relaxation ladder ([P04]) fix *vocabulary* mismatch — different spellings of the same word. They cannot fix *concept* mismatch. "Where did we fix the thing that made the cards flash" shares no token with any record of that work, and no amount of splitting or OR-relaxation manufactures one. If the Gazette's bar is answering questions phrased the way a person actually thinks, some semantic recall channel is eventually required.

**What was established while devising this plan (2026-08-15), so it is not re-derived later:**

- **There is no Anthropic embeddings API, and the `claude` CLI has no embedding surface.** `claude --help` exposes `agents`, `auth`, `mcp`, `plugin`, `project`, `setup-token`, `update`, `ultrareview`, `doctor`, `gateway`, `import` — nothing returning a vector. Anthropic's own embeddings documentation exists to redirect to Voyage AI. Embeddings therefore mean a *separate model*, always; the only question is which one and where it runs.
- **Tug no longer ships an on-device inference runtime.** No llama.cpp / GGUF / MLX code remains in `tugrust/crates` or `tugapp/Sources`; `shared_agent.rs` and `main.rs` reference the on-device backend in the past tense ("the idle unload the on-device backend **used**", a path that "**used to** run on the on-device pack"), the local-model plans live in `dash/archive/`, and the only remnant is an unused asset at `~/Library/Application Support/Tug/models/qwen3-4b-instruct-2507-4bit`. A local embedding model means *reviving* on-device inference, not reusing it.
- **The third-party API route is rejected on data-egress grounds, not cost.** Voyage/OpenAI/Google/Cohere embeddings cost pennies per million tokens, but embedding the facts library means transmitting every prompt the user has typed and every command they have run to a vendor. The library is the complete record of their work. This would be the first place Tug sends user data outside Anthropic, and it is not a decision to make as a sub-step of a search-ranking plan.

**Options (if known):**
- Local embedding model (bge-small / nomic-embed class, a few hundred MB) plus a revived inference runtime, a `fact_embeddings` table of f32 blobs, and brute-force cosine over the small corpus (no vector index needed at this scale).
- Third-party embeddings API — **rejected**, per the data-egress finding above.
- Model-mediated query expansion using the Haiku pool that already ships — adopted for this plan as [P09], and the reason this question stays deferred rather than becoming the next plan by default.

**Plan to resolve:** Ship this plan, including [P09] expansion. Then use the instruments this plan builds — the [P06] per-verb logs and the `operator-ask` question suite ([P08], Spec S05) — to collect real questions that still miss. If misses persist after expansion, devise a successor plan for local embeddings with that question suite as its eval gate.

**Resolution:** DEFERRED — with a named successor path and a concrete resolution instrument, not an open-ended "revisit someday". The deferral rests on three findings above (no Anthropic embeddings, no surviving local runtime, third-party egress rejected) plus [P09], which attacks the same failure using infrastructure that ships today.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Migration bug corrupts an FTS index on a live ledger | med | low | FTS is derivable state: the last resort is always drop + `'rebuild'` from the content table; Spec S03 phases the work into `bootstrap_schema`'s real order and rebuilds a dropped index before backfilling into it, so the live triggers never fire against entries that are not there | any `MATCH` error or missing-row report after upgrade |
| A stale two-column trigger survives the migration | high | med | `CREATE TRIGGER IF NOT EXISTS` cannot replace one, so Spec S03 phase A drops all three explicitly; Step 2 pins it with an insert-after-migration test | a fact inserted post-upgrade not findable by sub-word |
| Excerpts silently become normalizer output | med | high without the fix | `snippet()` pinned to `text` in the same step that adds the column, plus a content assertion (#snippet-column) | any answer quoting token soup |
| New ranking degrades queries that worked | med | low | Weights are modest (4/2/1); kind budgeting only caps a kind when others matched; unit tests pin both the old wins and the new | a real question where the right fact is present but off-page |
| Recovery ladder returns noise for genuinely unanswerable queries | low | med | Every relaxed result carries a `note` naming the query actually used, so the answering model knows the match is loose | answers citing loose matches as exact |
| Instruction-pin tests drift from wording | low | med | Pins updated in the same commit as wording ([P07]); the existing test style asserts substrings, not full text | `cargo nextest` failure |
| `operator-ask` misused against a live ledger | med | low | The subcommand is hidden, takes an explicit `--db` path, and its help text says "point this at a copy"; it never writes | — |
| Expansion rung adds latency to failing searches | low | med | Fires only on a doubly-empty result, at most once per verb call, inside `VERB_TIMEOUT` (10 s) with a 6 s job ceiling; any error or timeout degrades to the empty result | expansion appearing in the p50 path rather than the tail |
| Expansion returns plausible-but-wrong rows | med | med | Every expanded result carries `query_used` and a note saying the terms were model-suggested, so the answering model can see the match is indirect ([P09]) | answers citing expansion hits as direct evidence |

**Risk R01: FTS rebuild cost on open** {#r01-fts-rebuild-cost}

- **Risk:** The one-time migration (backfill + `'rebuild'` of two FTS tables) slows instance startup on large ledgers.
- **Mitigation:** It runs once per ledger (the stale-shape check is cheap and false afterwards); the release ledger's ~9.6k facts backfill and rebuild in well under a second; the work happens on `open` before the server accepts connections, which is where every existing self-healing migration already runs.
- **Residual risk:** A ledger orders of magnitude larger pays a one-time seconds-long open. Acceptable.

---

### Design Decisions {#design-decisions}

#### [P01] Sub-word vocabulary via a normalized `tokens` column, not a trigram tokenizer (DECIDED) {#p01-tokens-column}

**Decision:** Keep unicode61 on the existing indexed columns and add a third indexed column, `tokens`, holding a normalized sub-word bag derived at write time (Spec S01). Both `facts_fts` and `gazette_posts_fts` gain it.

**Rationale:**
- The trigram tokenizer would give substring matching but makes every multi-word MATCH a literal substring search (`'tooltip colors'` would still miss), muddies bm25 into trigram-frequency ranking, and degrades `snippet()` output. The failure being fixed is *vocabulary*, not substring-ness.
- A derived column keeps word-level AND/OR/phrase semantics, keeps `snippet()` on the human-readable columns, and lets `bm25()` weight the derived vocabulary *below* the authored text ([P03]).
- Write-time derivation costs one pure-function call per fact/post insert; the corpus is small and append-mostly.

**Implications:**
- `facts` and `gazette_posts` each gain a nullable `tokens TEXT` column; the FTS tables and their three sync triggers are re-declared to carry it; existing ledgers migrate per Spec S03.
- `record_fact_tx` (session_ledger.rs, the single INSERT path for facts) and the gazette-post insert path compute `tokens` from the same strings they store.
- The normalizer is a public pure function so tests and the backfill share it (Spec S01).

#### [P02] The normalizer emits only derived words, lowercase, deduped (DECIDED) {#p02-normalizer-emits-derived}

**Decision:** `subword_tokens` emits only sub-words that are *not* already whole unicode61 tokens of the input — the originals are already indexed by the `subject`/`text`/`body` columns; duplicating them would double-count in bm25.

**Rationale:**
- The `tokens` column exists to add vocabulary, not to re-weight existing vocabulary.
- Deduping keeps the column small and the index honest.

**Implications:**
- `TugTooltip` contributes `tug tooltip`; `tooltip` alone (already a token wherever it appears in prose) contributes nothing.
- The function is deterministic and order-stable so backfill and insert produce identical bytes for identical input.

#### [P03] Ranking: bm25 column weights plus kind-diversity budgeting in Rust (DECIDED) {#p03-ranking}

**Decision:** `search_facts` orders by `bm25(facts_fts, 4.0, 2.0, 1.0)` (subject, text, tokens) and overfetches `3 × limit` rows, then a Rust budgeter enforces kind diversity per Spec S02 before returning `limit` rows. `search_gazette_posts` orders by `bm25(gazette_posts_fts, 2.0, 1.0, 1.0)` (body, refs, tokens) with no kind budgeting (posts have no kinds).

**Rationale:**
- `subject` is the headline handle (a sha, a command incipit, a name) — a hit there is almost always what the question meant; weighting it up is the cheapest precision win.
- bm25 cannot know a `commit` fact outranks 28 `shell` facts for a "which commit" question; no static weight fixes that without breaking "which command" questions. Diversity budgeting sidesteps the guess: every matching kind gets on the page, and an explicit `kind` filter disables the budgeter entirely.
- Budgeting in Rust (not SQL) keeps the SQL simple and the policy unit-testable.

**Implications:**
- `search_facts` gains no new SQL clauses beyond the weights; the budgeter is a pure function over the overfetched rows (Spec S02).
- When the budgeter drops rows, the verb's JSON says so (a `note` naming the capped kind and how many were dropped) — no silent truncation.

#### [P04] Query hygiene and an empty-result relaxation ladder, Rust-side (DECIDED) {#p04-query-recovery}

**Decision:** `facts.search` and `gazette.search` sanitize the model's query into a safe FTS5 MATCH expression, run it, and on zero rows walk a deterministic relaxation ladder (Spec S04) before returning. The result JSON always names the query that actually produced the rows.

**Rationale:**
- A model round is the scarcest resource in the pipeline (two rounds, hard cap); a Rust retry costs microseconds. The system should never hand the model an empty page when a relaxed query has rows.
- Sanitization (quoting terms) also retires the "FTS5 says what it disliked" failure mode for the common case — a model writing natural language should never syntax-error the index.

**Implications:**
- New pure functions (sanitize, relax, expand — Spec S04) with unit tests; `gazette_search`/`facts_search` in `operator.rs` call them.
- The verb keeps returning `Err` only for arguments that are wrong in kind (missing query, bad types), not for query *content*.

#### [P05] `MAX_RETRIEVAL_ROUNDS` stays at 2 (DECIDED) {#p05-rounds-stay-two}

**Decision:** The round cap does not change.

**Rationale:**
- The observed failure was not round starvation; it was round *waste* — empty results from a fixable index and query path. [P01]–[P04] make round one land.
- A third round adds 5–10 s of model latency to exactly the questions that are already slow, and the answer instructions already teach answering with what is known.

**Implications:**
- If logged verb rounds ([P06]) later show recovered queries still routinely needing a third round, that is the trigger to revisit — recorded here so the decision isn't reopened by accident.

#### [P06] Every executed verb logs one INFO line (DECIDED) {#p06-verb-logging}

**Decision:** The Operator pipeline logs, per executed verb: verb name, compact args JSON (capped), ok/err, elapsed ms, and a result-size hint (row count where the verb returns a `count`, else byte length).

**Rationale:**
- The 2026-08-15 incident was unreconstructable — only `shared agent call task=operator-retrieve outcome=ok` exists in the log. One line per verb makes every future miss a five-minute read instead of archaeology.
- INFO, not DEBUG: the volume is at most `MAX_VERBS_PER_ROUND × MAX_RETRIEVAL_ROUNDS = 12` lines per question, and questions are user-initiated.

**Implications:**
- Lands in Step 1 so the rest of the plan is observable while being built.
- Args are logged after the argument gate reads them, capped at ~300 chars — never a place where a huge pasted string floods the log.

#### [P07] Instructions teach the index they now have (DECIDED) {#p07-instruction-updates}

**Decision:** `OPERATOR_RETRIEVE_INSTRUCTIONS` gains three teachings — (a) FTS queries are AND-of-terms: prefer one distinctive word, add `kind` when the question names a kind of thing ("which commit" → `kind: "commit"`); (b) identifiers are findable by their parts (`tooltip` finds `TugTooltip`); (c) "recent commit about X" is `git.log` with `grep`, and commits older than ~20 are unreachable without `grep`/`since`. `OPERATOR_ANSWER_INSTRUCTIONS` gains one: before writing that a lookup you needed does not exist, re-read the verb list — if a verb could have answered it, ask for it (first round) or name it plainly as the follow-up the reader could ask (forced round).

**Rationale:**
- The transcript shows the model wishing for `git.log grep` while holding it. One sentence at the decision point is worth more than a syntactically documented argument.
- The recovery ladder ([P04]) makes single-word queries safe; the instructions should steer toward them so recovery is the backstop, not the norm.

**Implications:**
- The pinning tests in `gazette_agent.rs` assert the new load-bearing substrings in the same commit.

#### [P08] `tugcast operator-ask` is the verification harness (DECIDED) {#p08-operator-ask}

**Decision:** A hidden CLI subcommand runs the real Operator pipeline — real ledger, real verbs, real model — against an explicit `--db` path and prints the answer plus every verb round (Spec S05).

**Rationale:**
- "Replay today's question" must be a command, not a hope. The Reporter already has this shape (`tugcast gazette-replay`, hidden, calibration-only); the Operator gets the matching instrument.
- Point-at-a-copy keeps the live-ledger rule intact and makes the closing verification repeatable from any checkout.

**Implications:**
- `cli.rs` grows a second `Command` variant (the enum currently has exactly one, `GazetteReplay`, destructured with `let` in `main.rs` — that destructuring becomes a `match`).
- The subcommand constructs `OperatorContext` directly (ledger from `--db`, `bootstrap_project_dir` from `--project-dir`, no shell ledger unless `--shell-db` is given) and drives the same `answer()` path the feed uses.

#### [P09] Model-mediated query expansion on the Haiku pool, as the ladder's last rung (DECIDED) {#p09-query-expansion}

**Decision:** When the relaxation ladder ([P04], Spec S04) still has zero rows after its lexical rungs, `facts.search` and `gazette.search` ask the existing **Haiku** agent pool for candidate search terms and try once more with them. A new `expand_query` job joins `HAIKU_AGENT_JOBS` in `shared_agent.rs`.

**Rationale:**
- It attacks the concept-mismatch failure of [Q01] with infrastructure that ships **today**: `HAIKU_AGENT_JOBS` already carries `classify`, `classify_with_grammar`, `summarize`, `summarize_done`, `synopsis` on warm, persistent workers with a reviewed job table. No new model asset, no revived runtime, no new data egress — the facts already travel to Anthropic when the Operator answers.
- It is not true semantic recall (no vector space, no similarity ranking), but it converts an unanswerable-by-vocabulary question into answerable-by-vocabulary terms — "the thing that made the cards flash" → `flicker, repaint, transition, animation` — and the lexical index this plan is already fixing does the rest.
- It fires only where the alternative is returning nothing, so its cost lands exclusively on questions that are currently failing.

**Implications:**
- `OperatorContext` gains `haiku: Option<Arc<SharedAgentPool>>`. It is an `Option` because two of the four construction sites are tests and one is the new CLI (Spec S05); `None` means the rung is skipped and the empty result returns honestly, exactly as today. The production site is `main.rs`, which already holds the pool.
- The verb executor becomes model-touching for the first time. That is bounded deliberately: the rung runs at most **once per verb call**, only on a doubly-empty result, under the existing `VERB_TIMEOUT` of 10 s, and its own job timeout is `SUMMARIZE_TIMEOUT` (6 s) via `JobClass::of`'s catch-all `Summarize` lane — a failed or slow expansion degrades to the empty result rather than failing the verb. The 6 s ceiling sits inside the 10 s one with room for the two lexical rungs that already ran, but the margin is thin by construction: raising the expansion job's timeout without raising `VERB_TIMEOUT` would turn graceful degradation into verb timeouts.
- Expansion terms are model-written strings that reach an FTS query, so they pass through `sanitize_fts_query` (Spec S04) like any other query text — never interpolated raw.
- The result JSON names the expansion explicitly (`query_used` plus a note saying the terms were model-suggested), so the answering model never mistakes a loose expansion match for a direct hit.

---

### Deep Dives {#deep-dives}

#### Where everything lives today {#code-map}

All paths relative to `tugrust/crates/tugcast/src/`.

- **`feeds/operator.rs`** — the whole Operator: verb executor (`run_verb`, `dispatch`, per-verb functions `gazette_search`/`facts_search`/`facts_list`/…), the caps block (`SEARCH_LIMIT = 20`, `FACTS_SEARCH_LIMIT = 30`, `GIT_LOG_DEFAULT_N = 20`, `GIT_LOG_MAX_N = 30`), the argument gate (`plain_arg`, `path_arg`, `sha_arg`), `OperatorContext`, and the pipeline (`answer()` — retrieve turn, verb loop `for request in requests { run_verb(…) }`, answer turn, `MAX_RETRIEVAL_ROUNDS = 2`, `MAX_VERBS_PER_ROUND = 6`). Its test module holds a fixture that builds an `OperatorContext` over a temp ledger — new verb tests belong there.
- **`feeds/gazette_agent.rs`** — the three job specs and their instruction strings: `REPORTER_POST_INSTRUCTIONS`, `OPERATOR_RETRIEVE_INSTRUCTIONS` (the verb list the model reads, including `git.log — optionally grep, pickaxe …`), `OPERATOR_ANSWER_INSTRUCTIONS`; `DEFAULT_MODEL = "sonnet"`; the pinning tests (`the_job_table_carries_every_contract_the_gates_depend_on` and the per-job tests around it, which assert instruction substrings and pin `VERB_NAMES` against the retrieve text).
- **`session_ledger.rs`** — schema init (one large SQL block executed on open; `gazette_posts_fts` DDL with columns `body, refs`, `content='gazette_posts'`; `facts_fts` DDL with columns `subject, text`, `content='facts'`; three sync triggers each, named `<table>_fts_insert/delete/update`), the self-healing migrations (idempotent `ALTER TABLE … ADD COLUMN` calls, the `is_duplicate_column` helper), `search_facts` (bm25 order, `FactSearchFilter`, `snippet(facts_fts, -1, …)`), `search_gazette_posts` (bm25 order, `snippet(gazette_posts_fts, 0, …)`), `record_fact_tx` (the single INSERT path for facts; `NewFact { at_ms, kind, session_id, subject, text, payload, dedupe_key }`), and the gazette post insert path.
- **`feeds/facts_library.rs`** — `FactKind`, `render_text` (composes the one-line `text` every fact stores — where `TugTooltip` vocabulary enters facts), `render_detail`, `PROMPT_TEXT_CAP`.
- **`cli.rs`** — `Command` enum (single variant `GazetteReplay(GazetteReplayArgs)`, `#[command(hide = true)]`); **`main.rs`** dispatches it with `let cli::Command::GazetteReplay(args) = command;` (a `let` destructure that must become a `match` when a second variant lands).

#### The vocabulary failure, precisely {#vocabulary-failure}

Fact 6291's text: `commit ac462ba3a1ae "tugways(entity-tips): unify commit hover into a real TugTooltip" — 27 file(s)`. unicode61 splits on non-alphanumeric only; `TugTooltip` is one token. Verified against the release ledger: the fact matches `MATCH 'tugtooltip'`, does not match `MATCH 'tooltip'`, does not match `MATCH 'tooltip*'` (prefix search extends a token rightward; it cannot start mid-token). The same failure shape covers `tugways(entity-tips)` (`entity` and `tips` *do* split — parens and hyphen are separators — so kebab and punctuation are partially survivable; CamelCase is the systematic hole), `at0365` (letter/digit boundary does not split), and any `useSomeHook`/`TugListView` name in prose. Gazette post bodies carry the same vocabulary inside backticks, so `gazette_posts_fts` needs the same treatment.

#### `bootstrap_schema`'s three phases, and why Spec S03 is shaped around them {#bootstrap-order}

`SessionLedger::open` → `open_full` → `configure` → **`bootstrap_schema`**, which runs in a fixed order that the migration must slot into rather than replace:

1. **Drift guards** — `rebuild_table_if_schema_drifted(conn, "turn_telemetry", …)` and the same call for `"main.file_events"`. These DROP a table whose on-disk column set no longer matches the expected one, so the CREATE below rebuilds it fresh.
2. **The `migrate_*` ALTERs** — a dozen self-healing column adds (`migrate_sessions_add_name`, `migrate_gazette_posts_add_elapsed_ms`, …), each reading `table_columns` first and no-op'ing on a fresh or already-migrated database.
3. **One large `conn.execute_batch(…)`** carrying every `CREATE TABLE IF NOT EXISTS`, `CREATE VIRTUAL TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, and `CREATE TRIGGER IF NOT EXISTS`. Post-batch work follows it (`migrate_instance_file_events_to_changes`, `migrate_instance_changeset_drafts_to_changes`).

Three consequences, each of which a plan that ignored this structure would get wrong:

- **The batch runs exactly once, and nothing re-runs it.** A drop performed *after* the batch is never followed by a create, so the index would simply be gone until the next process start. The FTS drop therefore belongs in phase 1, not in a migration step of its own.
- **A column add must precede the batch** to be visible to the `CREATE`s and to any later phase, which is why `tokens` joins the phase-2 family rather than being ALTERed ad hoc.
- **Anything needing the FTS tables to exist must run after the batch**, which is where the backfill and rebuild go — the post-batch region that already hosts the two `migrate_instance_*` calls.

#### The `snippet()` column argument is load-bearing, and adding a column silently breaks it {#snippet-column}

`search_facts` currently selects `snippet(facts_fts, -1, '', '', '…', 32)`. The `-1` means *auto-select the best-matching column*. Today that ranges over `subject` and `text`, both human-readable. The moment `tokens` becomes column 2, `-1` may choose it, and the excerpt the Operator reads — and quotes into an answer — becomes normalizer output like `tug tooltip action` instead of the sentence it came from.

Nothing in the suite would catch this: the only excerpt assertions that exist are `assert!(!hits[0].excerpt.is_empty(), "snippet() cut an excerpt")` in `session_ledger.rs` and two `assert!(…["excerpt"].is_string())` checks in `operator.rs`. Token soup is non-empty and is a string, so all three stay green while the answers degrade.

The fix is to pin the argument to the `text` column (index 1) in the same commit that adds the column — **Step 2, not Step 3** — and to add an assertion on excerpt *content*. `search_gazette_posts` already passes an explicit `0` (`body`) and needs no change; that asymmetry is why only one of the two is affected.

#### Why overfetch-then-budget instead of SQL-side kind weighting {#why-budget-in-rust}

A SQL `CASE`-multiplier on bm25 per kind would need a per-question notion of which kind matters — which is the model's knowledge, not the ledger's. Diversity budgeting needs no such guess: it guarantees representation, not precedence. The overfetch factor 3 is enough because the budgeter only needs to *find* minority-kind rows, and bm25 with the [P03] weights already pulls subject-hits (commits by sha, commands by incipit) toward the front. With 39 total matches and `limit 30`, overfetching 90 fetches all of them; budget math only bites when matches exceed 3× the page, where a capped kind has dozens of rows on the page already.

---

### Specification {#specification}

**Spec S01: The sub-word normalizer** {#s01-normalizer}

New module `search_tokens.rs` (crate `tugcast`), pure functions, no I/O:

```rust
/// The normalized sub-word bag for one or more source strings.
pub fn subword_tokens(sources: &[&str]) -> String
```

Rules, applied per unicode61-style token (split input on any non-alphanumeric):

1. **CamelCase humps** split: `TugTooltip` → `tug`, `tooltip`; `TugActionTooltip` → `tug`, `action`, `tooltip`; `useSyncExternalStore` → `use`, `sync`, `external`, `store`. An all-caps run followed by a capitalized word splits at the boundary (`HTTPServer` → `http`, `server`).
2. **Letter/digit boundaries** split: `at0365` → `at`, `0365`.
3. Everything emitted is **lowercased**.
4. Emit a sub-word only if it is **not identical** (case-insensitively) to the whole source token it came from ([P02]) — `tooltip` from prose emits nothing; `Tooltip` as a standalone capitalized word emits nothing (its lowercase is the token unicode61 already indexes, which is case-folded by FTS5 anyway).
5. **Dedupe** across the whole output, preserve first-seen order, join with single spaces.
6. Drop sub-words shorter than 2 characters; cap the output at 2048 characters (cut at a whole sub-word).

Inputs per row: for a fact, `[subject.unwrap_or(""), text]`; for a gazette post, `[body, refs]` (refs is the stored JSON string; its paths and shas are exactly the vocabulary worth splitting).

**Spec S02: Kind-diversity budgeting for `facts.search`** {#s02-kind-budget}

Applied only when the caller passed no `kind` filter. Over the overfetched, bm25-ordered rows:

1. Walk rows in rank order, appending to the page, but once a single kind holds `KIND_PAGE_CAP = 12` rows, skip further rows of that kind while any other kind still has unpicked matches.
2. After the walk, if the page is short of `limit` and skipped rows remain, fill from them in rank order.
3. If any rows were skipped and not refilled, append to the verb's JSON: `"note": "results capped for balance: N more shell fact(s) matched; pass kind: \"shell\" to see them"` (kind and count computed, wording fixed).

The cap value 12 of a 30-row page lets a genuinely shell-heavy question stay shell-heavy while guaranteeing ≥18 rows of room for other kinds. Pure function: `budget_by_kind(rows: Vec<FactSearchHit>, limit: usize) -> (Vec<FactSearchHit>, Option<String>)` in `operator.rs`, unit-tested without a database.

**Spec S03: The migration, exactly ordered** {#s03-migration}

Runs inside `SessionLedger::bootstrap_schema`, before the server accepts work. Idempotent; every step is a no-op on an already-migrated ledger. **The step order below is not a suggestion — it is dictated by `bootstrap_schema`'s existing three-phase structure**, which the implementer must place these into rather than appending a new sequence (see #bootstrap-order for that structure and why it forces this):

**Phase A — before the `execute_batch`, beside the existing drift guards:**

1. **Stale-shape check + drop.** For each of `main.facts_fts` and `main.gazette_posts_fts`: read its columns and, if `tokens` is absent, `DROP TRIGGER` its three sync triggers and then `DROP TABLE` the index. Model this on the existing `rebuild_table_if_schema_drifted` / `table_columns` helpers — `table_columns` uses `PRAGMA table_info`, which reports an FTS5 virtual table's columns correctly — but it needs its own small helper because `rebuild_table_if_schema_drifted` drops the *table only*, and here the triggers must go too (see the next point).
   - **Every name must be `main.`-qualified.** [LR5]'s corollary in `tuglaws/ledger-reliability.md`: a shape probe or `DROP TABLE` on a connection with an attached database resolves into the attachment when the local table is absent. `bootstrap_schema` already does this for `main.file_events`; the FTS drops must too.
   - **The triggers must be dropped explicitly.** `CREATE TRIGGER IF NOT EXISTS` does **not** replace an existing trigger, so an old two-column `facts_fts_insert` would survive the batch and keep writing two columns into a three-column index — a silently half-populated `tokens` column with no error anywhere.
   - Dropping is legal here and not a shared-schema violation: `sessions.db` is per-instance and an FTS index is derivable state, which is exactly the carve-out [LR5] grants (`turn_telemetry`-class rebuildable caches).

**Phase B — with the existing `migrate_*_add_*` calls, still before the batch:**

2. `migrate_facts_add_tokens` and `migrate_gazette_posts_add_tokens`, following the established idiom exactly (`table_columns`, bail when the table is absent, `ALTER TABLE … ADD COLUMN tokens TEXT` otherwise). The `is_duplicate_column` helper remains the guard for the concurrent-loser case.

**Phase C — the `execute_batch` itself:**

3. The batch's `CREATE TABLE IF NOT EXISTS` gains `tokens TEXT` on both base tables; its `CREATE VIRTUAL TABLE IF NOT EXISTS` declares the three-column indexes (facts: `subject, text, tokens`; posts: `body, refs, tokens`); its six `CREATE TRIGGER IF NOT EXISTS` statements carry `new.tokens` / `old.tokens`. Because Phase A dropped any stale index and its triggers, these `IF NOT EXISTS` statements are what recreates them — nothing re-runs the batch later, which is why the drop cannot happen after it.

**Phase D — after the batch, where `migrate_instance_file_events_to_changes` already runs:**

4. **Rebuild first, for each index Phase A dropped.** `INSERT INTO facts_fts(facts_fts) VALUES('rebuild')` (and the posts equivalent) — FTS5 discards the index and re-derives every row from the content table.
5. **Then backfill.** `SELECT id, subject, text FROM facts WHERE tokens IS NULL`, compute `subword_tokens`, `UPDATE facts SET tokens = ?1 WHERE id = ?2`; likewise `gazette_posts (id, body, refs)`. Wrap it in one transaction.

   **This order is not interchangeable, and the reverse corrupts the database.** Phase A dropped the index; Phase C recreated it *empty* while bringing the sync triggers back to life. Backfilling into that state fires the update trigger, which issues an external-content `'delete'` against an index entry that does not exist, and SQLite answers `database disk image is malformed` — observed on the first migration test run, which is how this was found. Rebuilding first puts the index in step with the content table, after which the triggers keep it there: `old.tokens` is genuinely what was indexed, so every `UPDATE` deletes an entry that is really present and writes the new one.

   Rebuilding first also closes the crash window more simply than a "did the backfill move a row" flag can. The backfill is scoped by `tokens IS NULL`, so a process that dies mid-backfill leaves a *consistent* index over a partly-filled column, and the next open finishes the remaining rows through the live triggers — no drop, no second rebuild, and no state where garbage entries can be stranded permanently.

Fresh databases hit none of the special paths: the base tables carry `tokens` from `CREATE TABLE`, the FTS DDL is new-shape, Phase A finds nothing to drop, the backfill finds no NULLs, and no rebuild runs. Insert paths (`record_fact_tx`'s `INSERT OR IGNORE INTO facts (…)`, which grows from seven bound parameters to eight, and the gazette post insert) always write `tokens`, so NULLs never reappear.

**Spec S04: Query sanitize and the relaxation ladder** {#s04-query-ladder}

Pure functions in `search_tokens.rs` (they share the normalizer), applied by `facts_search` and `gazette_search` in `operator.rs`:

- `sanitize_fts_query(raw: &str) -> Option<String>` — split `raw` on whitespace; strip characters FTS5 treats as syntax except a trailing `*` (kept for prefix queries, e.g. sha prefixes); double-quote each term; rejoin with spaces (implicit AND). `None` when nothing survives. A raw query that *is* already advanced syntax (contains `"` or ` OR ` or ` AND ` or `NEAR(`) passes through untouched — the model is allowed to be precise; sanitize exists for natural language.
- The ladder, on zero rows from the sanitized query:
  1. **OR-relax** (≥2 terms only): same quoted terms joined with `OR`.
  2. **Sub-word expand:** each term becomes `("term" OR "sub" OR "words")` using `subword_tokens` on the term itself (so a query for `TugTooltip` finds facts whose *tokens* column has `tug tooltip`, and a query for `tooltip` — which expands to nothing — keeps its own term); rungs 1's OR join across terms.
  3. **Model expansion** ([P09], Spec S06): ask the Haiku pool for candidate terms and run one more OR query built from them. Skipped entirely when `OperatorContext.haiku` is `None` or the job errors or times out.
  4. Zero rows after every rung: return the empty result honestly.
- Every response gains `"query_used"`: the expression that produced the rows, and — when a rung fired — `"note": "no facts matched the full query; showing matches for any term"` (wording per rung, fixed strings).
- A pass-through advanced query that FTS5 rejects still returns the FTS5 error as today (the model wrote syntax; it reads its own mistake). A sanitized query cannot syntax-error.

**Spec S06: The `expand_query` Haiku job** {#s06-expand-query}

A new `JobSpec` in `HAIKU_AGENT_JOBS` (`shared_agent.rs`), following that table's existing shape (`name`, `instructions`, `timeout`, `slow`):

- `name: "expand_query"`, `timeout: SUMMARIZE_TIMEOUT` (6 s), `slow: Some(Duration::from_secs(3))`. `JobClass::of` maps every non-classify name to the `Summarize` lane by its catch-all arm, so no change is needed there — but the plan records it so the implementer does not go looking.
- **Input:** the user's question, plus the fixed fact-kind vocabulary (`prompt`, `session.spawned`, `session.resumed`, `session.closed`, `session.errored`, `session.reset`, `session.renamed`, `session.compacted`, `commit`, `shell`, `test_run`) and two or three example fact texts so the model composes against the corpus's real register — the same teaching device `OPERATOR_RETRIEVE_INSTRUCTIONS` already uses.
- **Instructions** ask for the words that would *appear in the record* of the work described, not synonyms of the question: a commit subject, a filename fragment, a command name. State plainly that this is a search-term generator, that terms are OR-ed, and that 3–8 single words is the useful range.
- **Output:** strict JSON, `{"terms": ["flicker", "repaint", "transition"]}`, with `{"terms": []}` as a first-class answer meaning "nothing better to suggest" — the same silence-is-an-answer posture as `{"post": null}` in `REPORTER_POST_INSTRUCTIONS`. An unparseable turn is treated as `[]`.
- Terms are sanitized through `sanitize_fts_query` before they touch SQL and capped at 8.
- Pinned by the existing `the_haiku_job_table_carries_every_contract_the_gates_depend_on` test in `shared_agent.rs`, extended to assert the JSON shape and the empty-terms contract.

**Spec S05: `tugcast operator-ask`** {#s05-operator-ask}

```
tugcast operator-ask --db <path/to/sessions.db copy> --project-dir <repo> [--shell-db <path>] [--model <alias>] [--show-rounds] "<question>"
```

- Hidden (`#[command(hide = true)]`), like `gazette-replay`; help text states it is a calibration/verification instrument and must be pointed at a *copy* of a live ledger.
- Opens the ledger read-write through the normal `SessionLedger::open` (the copy makes that safe; the pipeline itself never writes facts), builds `OperatorContext` with `shell_ledger: None` unless `--shell-db` is given, runs the same retrieve → verbs → answer pipeline the feed runs (factoring the pipeline's entry so the feed and the CLI share it — the answer path currently lives on the feed's struct in `operator.rs`), and prints: each round's verb requests and result counts (`--show-rounds` prints full result JSON), then the answer body and refs.
- Exit 0 on an answer, 1 on a pipeline error. The [P06] log lines fire as normal.
- Model resolution follows `gazette_agent.rs` defaults; `--model` overrides for the run only (the `gazette-replay` pattern).

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tugrust/crates/tugcast/src/search_tokens.rs` | `subword_tokens`, `sanitize_fts_query`, the relaxation-ladder helpers (Spec S01, S04) + unit tests |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `subword_tokens` | fn | `search_tokens.rs` | Spec S01 |
| `sanitize_fts_query` | fn | `search_tokens.rs` | Spec S04 |
| `relax_or`, `expand_subwords` | fn | `search_tokens.rs` | Spec S04 ladder rungs |
| `budget_by_kind` | fn | `feeds/operator.rs` | Spec S02 |
| `facts_search`, `gazette_search` | fn (modify) | `feeds/operator.rs` | sanitize + ladder + budget + `query_used`/`note` fields |
| `answer` / pipeline entry | fn (modify/factor) | `feeds/operator.rs` | per-verb INFO logging ([P06]); factored so the CLI shares it ([P08]) |
| `search_facts` | fn (modify) | `session_ledger.rs` | bm25 weights `4,2,1`; overfetch `3 × limit` (caller passes the bigger limit); `snippet()` pinned to the `text` column in Step 2 (#snippet-column) |
| `migrate_facts_add_tokens`, `migrate_gazette_posts_add_tokens` | fn | `session_ledger.rs` | Spec S03 phase B; the established `migrate_*_add_*` idiom |
| FTS stale-shape drop helper | fn | `session_ledger.rs` | Spec S03 phase A; modeled on `rebuild_table_if_schema_drifted` but drops triggers too, `main.`-qualified |
| `search_gazette_posts` | fn (modify) | `session_ledger.rs` | bm25 weights `2,1,1` |
| `record_fact_tx` | fn (modify) | `session_ledger.rs` | write `tokens` |
| gazette post insert path | fn (modify) | `session_ledger.rs` | write `tokens` |
| schema init + migration | SQL/fn (modify) | `session_ledger.rs` | Spec S03: columns, new FTS DDL, triggers, stale-shape check, backfill, rebuild |
| `OPERATOR_RETRIEVE_INSTRUCTIONS`, `OPERATOR_ANSWER_INSTRUCTIONS` | const (modify) | `feeds/gazette_agent.rs` | [P07] wording + moved pins |
| `Command::OperatorAsk`, `OperatorAskArgs` | enum variant / struct | `cli.rs` | Spec S05; `main.rs` `let`-destructure becomes `match` |
| `expand_query` JobSpec + instructions | const (add) | `shared_agent.rs` | Spec S06; joins `HAIKU_AGENT_JOBS`; `JobClass::of` catch-all already routes it |
| `OperatorContext.haiku` | field (add) | `feeds/operator.rs` | `Option<Arc<SharedAgentPool>>` ([P09]); populated at the `main.rs` site, `None` in tests and the CLI |
| `expand_via_model` | fn | `feeds/operator.rs` | Ladder rung 3: calls the pool, parses `{"terms": […]}`, sanitizes, caps at 8 |

---

### Documentation Plan {#documentation-plan}

- [ ] Module docs on `search_tokens.rs` explaining the vocabulary problem in one paragraph (the `TugTooltip` example) so the next reader knows why the column exists.
- [ ] `session_ledger.rs` schema comments updated where the FTS DDL changes (the existing comment style documents intent inline).
- [ ] No tuglaws/roadmap doc changes — behavior is internal to the Gazette.

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit** | Normalizer, sanitizer, ladder, budgeter — pure functions, exhaustive edges | Steps 1, 3, 4 |
| **Integration (real SQLite)** | Seeded temp ledgers through the real `SessionLedger` — migration sequencing, FTS matching, ranking; the existing operator-fixture style | Steps 2, 3, 4 |
| **Contract** | Instruction pins in `gazette_agent.rs` and `shared_agent.rs`; `VERB_NAMES` vs instructions | Steps 5, 7 |
| **Scripted-agent** | The expansion rung driven by `scripted_haiku_pool` — the project's existing seam for agent-dependent logic; asserts routing and parsing, never model prose | Step 7 |
| **Live replay (manual, real model)** | `operator-ask` against a release-ledger copy — the closing verification | Step 8 |

#### What stays out of tests {#test-non-goals}

- Model behavior (whether Sonnet chooses good verbs, whether Haiku suggests good terms) — not deterministically testable; the live replay observes it, the logs ([P06]) make regressions diagnosable. The expansion tests assert routing, parsing, and degradation, never the quality of the terms.
- Mocked FTS or mocked ledger reads — banned shape; every index test runs real SQLite through `SessionLedger`.
- App-tests — no deck-visible behavior changes; the Gazette card renders whatever the answer post says.

---

### Execution Steps {#execution-steps}

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Normalizer module + per-verb logging | done | `7c3450471` |
| #step-2 | Schema: tokens columns, FTS reshape, migration | done | `7c3450471` |
| #step-3 | Ranking weights + kind-diversity budgeting | done | `59347546d` |
| #step-4 | Query sanitize + relaxation ladder | done | `f0318beb5` |
| #step-5 | Instruction updates + pins | done | `facb53677` |
| #step-6 | `tugcast operator-ask` | done | `7b4654b54` |
| #step-7 | Haiku query-expansion rung | done | `f26fdd2a8` |
| #step-8 | Integration checkpoint: replay the question | done | `7603b7050` |

#### Step 1: Normalizer module + per-verb logging {#step-1}

**Commit:** `tugcast(gazette-vocab): add sub-word normalizer and per-verb operator logging`

**References:** [P01] tokens column, [P02] derived-only emission, [P06] verb logging, Spec S01, (#vocabulary-failure, #code-map)

**Artifacts:**
- `tugrust/crates/tugcast/src/search_tokens.rs` with `subword_tokens` (Spec S01) and its unit tests; module registered in the crate.
- One `tracing::info!` per executed verb in `feeds/operator.rs`'s pipeline loop (`for request in requests { let outcome = run_verb(…) }`): verb name, args as compact JSON capped at 300 chars, ok/err, elapsed ms, result-size hint.

**Tasks:**
- [ ] Implement `subword_tokens` per Spec S01 rules 1–6.
- [ ] Add the INFO log line around `run_verb` in the pipeline loop, timing each call.

**Tests:**
- [ ] `TugTooltip` → `tug tooltip`; `TugActionTooltip` → `tug action tooltip`; `useSyncExternalStore` → `use sync external store`; `HTTPServer` → `http server`.
- [ ] `at0365-gazette-card.test.ts` yields `at 0365` among its sub-words (letter/digit + separators).
- [ ] Plain prose (`unify commit hover into a real`) emits nothing ([P02] rule 4).
- [ ] Dedupe, ordering stability, the 2-char floor, and the 2048 cap cutting at a whole sub-word.

**Checkpoint:**
- [ ] `cd /Users/kocienda/Mounts/u/src/tugtool/tugrust && cargo nextest run -p tugcast search_tokens`
- [ ] `cd /Users/kocienda/Mounts/u/src/tugtool/tugrust && cargo build -p tugcast`

---

#### Step 2: Schema — tokens columns, FTS reshape, migration {#step-2}

**Depends on:** #step-1

**Commit:** `tugcast(gazette-vocab): index sub-word tokens in facts_fts and gazette_posts_fts, with self-healing migration`

**References:** [P01] tokens column, Spec S01, Spec S03, Risk R01, [LR5] corollary (schema-qualified drops, `tuglaws/ledger-reliability.md`), (#code-map, #vocabulary-failure, #bootstrap-order, #snippet-column)

**Artifacts:**
- `tokens TEXT` on `facts` and `gazette_posts` (base DDL + idempotent ALTER), three-column FTS tables and triggers, the stale-shape drop, backfill, and conditional rebuild — all in `session_ledger.rs`, placed into `bootstrap_schema`'s existing phases per Spec S03 and #bootstrap-order.
- `record_fact_tx` and the gazette post insert path compute and store `tokens` via `subword_tokens`.
- `search_facts`'s `snippet()` argument pinned to the `text` column (#snippet-column).

**Tasks:**
- [ ] Add `tokens` to both base-table `CREATE TABLE` blocks; add `migrate_facts_add_tokens` / `migrate_gazette_posts_add_tokens` beside the existing `migrate_*_add_*` family (Spec S03 phase B).
- [ ] Re-declare both FTS tables and all six triggers with the third column inside the `execute_batch` (phase C).
- [ ] Add the phase-A stale-shape drop beside the existing drift guards: `main.`-qualified per [LR5]'s corollary, dropping the three triggers **and** the index, modeled on `rebuild_table_if_schema_drifted`.
- [ ] Add the phase-D rebuild + backfill after the batch, in that order — rebuild each index Phase A dropped before backfilling into it (Spec S03 phase D; the reverse order corrupts the database).
- [ ] Wire `subword_tokens` into both insert paths (`record_fact_tx` grows to eight bound parameters).
- [ ] Change `snippet(facts_fts, -1, …)` to pin the `text` column — required *in this step*, because the third column is what breaks it (#snippet-column).

**Tests:**
- [ ] Fresh ledger: a fact whose text contains `TugTooltip` matches `MATCH 'tooltip'` via `search_facts` (the headline regression — the exact fact-6291 text as fixture).
- [ ] Gazette post with `TugTooltip` in the body matches `gazette.search 'tooltip'`.
- [ ] Migration: build a ledger with the *old* schema shape (create old-DDL FTS + rows in a temp db within the test, the way existing migration tests seed old shapes), reopen through `SessionLedger::open`, assert the stale path ran: `tokens` populated, `MATCH 'tooltip'` finds the `TugTooltip` fact, and FTS `'integrity-check'` passes.
- [ ] Migration leaves no stale trigger: after reopening the old-shape ledger, insert a new fact and assert it is findable by a sub-word — proving the recreated three-column trigger is the one that fired, not a surviving two-column one.
- [ ] Reopen an already-migrated ledger: no rebuild (assert via unchanged FTS content and no error), NULL-free `tokens`.
- [ ] Excerpt content, not just presence: a `search_facts` hit's excerpt contains prose from the fact's `text`, and contains no bare normalizer output — the assertion the three existing `is_empty`/`is_string` checks cannot make (#snippet-column).

**Checkpoint:**
- [ ] `cd /Users/kocienda/Mounts/u/src/tugtool/tugrust && cargo nextest run -p tugcast session_ledger`
- [ ] `cd /Users/kocienda/Mounts/u/src/tugtool/tugrust && cargo nextest run -p tugcast`

---

#### Step 3: Ranking weights + kind-diversity budgeting {#step-3}

**Depends on:** #step-2

**Commit:** `tugcast(gazette-rank): weight fact subjects in bm25 and budget search pages across kinds`

**References:** [P03] ranking, Spec S02, (#why-budget-in-rust, #code-map)

**Artifacts:**
- `search_facts` orders by `bm25(facts_fts, 4.0, 2.0, 1.0)`; `search_gazette_posts` by `bm25(gazette_posts_fts, 2.0, 1.0, 1.0)`.
- `facts_search` in `operator.rs` overfetches `3 × FACTS_SEARCH_LIMIT`, applies `budget_by_kind` (Spec S02) when no `kind` filter was passed, and emits the balance `note` when rows were dropped.

**Tasks:**
- [ ] Add the weight arguments to both ORDER BY clauses.
- [ ] Implement `budget_by_kind` as a pure function; call it from `facts_search`; thread the `note`.

**Tests:**
- [ ] `budget_by_kind` unit: 35 shell + 2 commit matches, limit 30 → both commits on the page, shell capped at 12 then refilled to 30, note names `shell` and the dropped count.
- [ ] `budget_by_kind` unit: single-kind result set passes through untouched, no note.
- [ ] Ledger integration: seed 35 shell facts and 2 commit facts all containing `tooltip`; `facts.search` (no kind) returns both commit facts; with `kind: "commit"` returns exactly the 2, no note.
- [ ] Subject weighting: a fact whose *subject* is the sha outranks a fact whose *text* merely mentions it, for a sha-prefix query.

**Checkpoint:**
- [ ] `cd /Users/kocienda/Mounts/u/src/tugtool/tugrust && cargo nextest run -p tugcast operator`
- [ ] `cd /Users/kocienda/Mounts/u/src/tugtool/tugrust && cargo nextest run -p tugcast`

---

#### Step 4: Query sanitize + relaxation ladder {#step-4}

**Depends on:** #step-2

**Commit:** `tugcast(gazette-recover): sanitize operator search queries and relax empty results in Rust`

**References:** [P04] query recovery, Spec S04, Spec S01, (#code-map, #context)

**Artifacts:**
- `sanitize_fts_query`, `relax_or`, `expand_subwords` in `search_tokens.rs`; `facts_search` and `gazette_search` run the ladder and return `query_used` + rung `note`.

**Tasks:**
- [ ] Implement Spec S04's sanitize (with the advanced-syntax pass-through) and both rungs.
- [ ] Wire the ladder into both search verbs; keep FTS5 errors surfacing only for pass-through advanced queries.

**Tests:**
- [ ] Sanitize unit: `tooltip colors` → `"tooltip" "colors"`; `ac462ba*` keeps its trailing star; `weird (chars) -here` cannot syntax-error; already-quoted / `OR` queries pass through verbatim.
- [ ] Ladder ledger test: corpus where `tooltip colors` matches nothing but `tooltip` matches — the verb returns the `tooltip` rows with `query_used` = the OR form and the rung-1 note.
- [ ] Ladder ledger test: query `TugTooltip` against a fact indexed only via sub-words — rung 2 finds it.
- [ ] Genuinely unanswerable query returns an empty result with no invented rows and no note beyond honesty (`count: 0`).

**Checkpoint:**
- [ ] `cd /Users/kocienda/Mounts/u/src/tugtool/tugrust && cargo nextest run -p tugcast search_tokens operator`
- [ ] `cd /Users/kocienda/Mounts/u/src/tugtool/tugrust && cargo nextest run -p tugcast`

---

#### Step 5: Instruction updates + pins {#step-5}

**Depends on:** #step-3, #step-4

**Commit:** `tugcast(gazette-teach): teach the operator FTS aiming, kind filters, and git.log grep for older commits`

**References:** [P07] instruction updates, [P05] rounds stay two, (#code-map, #context)

**Artifacts:**
- The three [P07] teachings in `OPERATOR_RETRIEVE_INSTRUCTIONS`; the one [P07] addition to `OPERATOR_ANSWER_INSTRUCTIONS`; pinning tests in `gazette_agent.rs` updated in the same commit.

**Tasks:**
- [ ] Write the retrieve additions: single-distinctive-word queries + `kind` aiming; sub-word findability; "recent commit about X" → `git.log grep=X`, and the >20-commit horizon without `grep`/`since`.
- [ ] Write the answer addition: re-read the verb list before claiming a lookup was impossible.
- [ ] Extend the pinning tests to assert the new load-bearing substrings.

**Tests:**
- [ ] `cargo nextest run -p tugcast gazette_agent` — pins green, including the existing `VERB_NAMES`-vs-instructions pin.

**Checkpoint:**
- [ ] `cd /Users/kocienda/Mounts/u/src/tugtool/tugrust && cargo nextest run -p tugcast gazette_agent`

---

#### Step 6: `tugcast operator-ask` {#step-6}

**Depends on:** #step-1

**Commit:** `tugcast(operator-ask): hidden CLI to run the operator pipeline against a ledger copy`

**References:** [P08] operator-ask, Spec S05, [P06] verb logging, (#code-map)

**Artifacts:**
- `Command::OperatorAsk(OperatorAskArgs)` in `cli.rs` (hidden); `main.rs`'s single-variant `let`-destructure becomes a `match`; the pipeline entry in `feeds/operator.rs` factored so feed and CLI share it; round + answer printing per Spec S05.

**Tasks:**
- [ ] Add the variant, args struct, and help text (including the point-at-a-copy warning).
- [ ] Factor the `answer()` pipeline behind a constructor the CLI can build (`OperatorContext` from `--db` / `--project-dir` / optional `--shell-db`).
- [ ] Print rounds (verb, args, count) and the final answer body + refs; `--show-rounds` prints result JSON; exit codes per Spec S05.

**Tests:**
- [ ] CLI parse test in `cli.rs`'s existing test module: the variant parses with `--db`, `--project-dir`, a question, and stays hidden from help.
- [ ] The factored pipeline entry compiles for both callers (the feed's existing operator tests keep passing — that is the regression proof).

**Checkpoint:**
- [ ] `cd /Users/kocienda/Mounts/u/src/tugtool/tugrust && cargo nextest run -p tugcast`
- [ ] `cd /Users/kocienda/Mounts/u/src/tugtool/tugrust && cargo build -p tugcast`

---

#### Step 7: Haiku query-expansion rung {#step-7}

**Depends on:** #step-4, #step-6

**Commit:** `tugcast(gazette-expand): ask haiku for search terms when a search finds nothing`

**References:** [P09] query expansion, [Q01] embedding deferral, Spec S06, Spec S04, Risk table (#risks), (#code-map)

**Artifacts:**
- `expand_query` `JobSpec` + instructions in `HAIKU_AGENT_JOBS` (`shared_agent.rs`), per Spec S06.
- `OperatorContext.haiku: Option<Arc<SharedAgentPool>>`, populated at the `main.rs` construction site and left `None` at the two test sites and the `operator-ask` site.
- `expand_via_model` in `operator.rs` as ladder rung 3, wired into both search verbs with `query_used` + the model-suggested note.

**Tasks:**
- [ ] Add the `expand_query` JobSpec and write its instructions per Spec S06 (JSON out, `{"terms": []}` as a first-class answer, 3–8 single words, terms that would appear *in the record*).
- [ ] Add the `haiku` field to `OperatorContext` and populate it at the production site (`main.rs`); leave `None` at the other three — the verb fixture and the `PipelineHarness` in `operator.rs`'s test module, and the `operator-ask` site Step 6 introduced (which is why this step depends on #step-6).
- [ ] Implement `expand_via_model`: call the pool, parse, treat unparseable as `[]`, sanitize every term through `sanitize_fts_query`, cap at 8, build the OR query, run it once.
- [ ] Extend `the_haiku_job_table_carries_every_contract_the_gates_depend_on` to pin the new job's output contract.

**Tests:**
- [ ] Scripted-pool test: a corpus where the question shares no token with the target fact; the scripted pool returns terms that do match; the verb returns the fact with `query_used` and the model-suggested note.
- [ ] `haiku: None` returns the honest empty result and never blocks (the degradation contract).
- [ ] A pool error, a timeout, and an unparseable turn each degrade to the empty result rather than failing the verb.
- [ ] Expansion does not fire when an earlier rung already found rows (assert the scripted pool was never called).
- [ ] Terms containing FTS syntax are sanitized, not interpolated raw.

**Checkpoint:**
- [ ] `cd /Users/kocienda/Mounts/u/src/tugtool/tugrust && cargo nextest run -p tugcast operator shared_agent`
- [ ] `cd /Users/kocienda/Mounts/u/src/tugtool/tugrust && cargo nextest run -p tugcast`

---

#### Step 8: Integration checkpoint — replay the question {#step-8}

**Depends on:** #step-2, #step-3, #step-4, #step-5, #step-6, #step-7

**Commit:** `N/A (verification only)`

**References:** [P08] operator-ask, Spec S05, (#success-criteria, #context)

**Tasks:**
- [ ] Copy the release ledger safely: `just db-inspect "/Users/kocienda/Library/Application Support/Tug/instances/release-main/sessions.db" "SELECT 1"` prints the temp-copy path it created; copy that `sessions.db` (with `-wal`/`-shm` already checkpointed into it) to a scratch path. Opening the copy also exercises the Spec S03 migration on real data.
- [ ] Run: `tugcast operator-ask --db <copy> --project-dir /Users/kocienda/Mounts/u/src/tugtool --show-rounds "what was the recent commit where we tried to regularize tooltip colors and presentation?"`
- [ ] Confirm the answer names `ac462ba3a` (the Aug 13 `tugways(entity-tips)` commit) or presents it as the leading candidate with correct evidence; confirm one INFO line per executed verb appeared.
- [ ] Run two control questions against the same copy to check nothing regressed to noise: a shell question ("what did we run to check theme contrast?") and a session question ("which session was the tooltip work in?").
- [ ] Run one **concept-mismatch** question whose wording shares no vocabulary with the record (e.g. "when did we work on making the app feel less sluggish while typing" against the typing-lag work) to exercise the [P09] rung end to end, and record the terms it produced — that observation is the first datum for [Q01]'s eventual resolution.

**Tests:**
- [ ] `cd /Users/kocienda/Mounts/u/src/tugtool/tugrust && cargo nextest run` (full workspace, warnings-as-errors).

**Checkpoint:**
- [ ] The replay answers with `ac462ba3a`; the verb rounds show the recovery/ranking layers doing the work (visible via `--show-rounds` and the [P06] log lines).

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** A Gazette Operator that finds what the user is asking about — sub-word-indexed facts and posts, kind-balanced search pages, deterministic query recovery, a model-mediated expansion rung for questions that share no vocabulary with the record, instructions that aim the verbs, a log line per verb, and a CLI that proves it on the real ledger.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] `MATCH 'tooltip'` finds the `TugTooltip` commit fact through `facts.search` (unit + replay).
- [ ] Migration verified on a real pre-migration ledger copy (Step 8 opens one) and on synthetic old-shape fixtures (Step 2 tests).
- [ ] The 2026-08-15 question, replayed via `operator-ask` against the release-ledger copy, answers `ac462ba3a`.
- [ ] Every executed verb logs one INFO line (observed during the replay).
- [ ] `cargo nextest run` green across the workspace; `just build-app` succeeds so the release instance can pick the change up.

**Acceptance tests:**
- [ ] Step 2's fact-6291 fixture test (the headline regression, pinned forever).
- [ ] Step 3's budget tests; Step 4's ladder tests; Step 5's instruction pins.

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] [Q01] local embedding retrieval, if logged misses show lexical + recovery + [P09] expansion still failing — with the `operator-ask` question suite as its eval gate, and reviving on-device inference as its real cost.
- [ ] Revisit `MAX_RETRIEVAL_ROUNDS = 2` per [P05]'s trigger.
- [ ] A periodic `operator-ask` question suite as a calibration instrument (the `gazette-replay` pattern, for answers).

| Checkpoint | Verification |
|------------|--------------|
| Vocabulary fixed | Step 2 tests + Step 8 replay |
| Ranking balanced | Step 3 tests |
| Recovery deterministic | Step 4 tests |
| Model taught | Step 5 pins |
| Concept-mismatch reachable | Step 7 scripted-pool tests + the Step 8 control question |
| Observable | [P06] lines during Step 8 |
| Question answered | `operator-ask` names `ac462ba3a` |
