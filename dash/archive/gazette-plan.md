<!-- devise-skeleton v4 -->

## The Gazette — Reporter, Operator, and the Gazette card {#gazette}

**Purpose:** Ship the app-wide Gazette channel decided in [dash/archive/feed-brief.md](archive/feed-brief.md): a Reporter that narrates session work into a durable three-author transcript, an Operator that answers questions about it from Tug's ground-truth ledgers, and a sidebar Gazette card that renders the channel and hosts the question box.

**Naming note (supersedes the brief's names):** the brief calls the feature "the Feed" and the posting agent "the Herald". Both were renamed after the brief was written: the feature and card are the **Gazette**; the posting agent is the **Reporter**. The Operator keeps its name. Wherever the brief says Feed/Herald, read Gazette/Reporter; this plan uses only the new names.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | vetted — fixups applied |
| Target branch | main |
| Last updated | 2026-08-07 |

> **Vet pass, 2026-08-07.** Assessed against the real tree. Eight findings folded in: the harness is a subcommand rather than a second binary ([P09] — tugcast has no lib target); `gazette_posts` is explicitly exempt from the drift-rebuild guard ([P02] — the guard would erase all history); search is FTS5 rather than `LIKE` ([P13]); a failed wake returns its frames ([P14]); the chord grant records its tier and menu choice ([P10]); the card step names `deck-canvas.tsx` (not `action-dispatch.ts`) plus three previously-missing files; the store step carries [L27] disposal and the card step [L12] and the [L16]/[L19] contract. `max_workers` defaults to 3, and #step-5 sweeps the sitrep cadence at 90/120/180 rather than validating one value.
>
> **Phasing pass, 2026-08-07.** The steps were regrouped into six `/implement`-sized phases (Table T04) and **reordered**: the readable Gazette (store → card → chips) now lands *before* the Operator, so live posts are visible two phases earlier and the cadence knobs get turned against real use. The composer split out as its own step (#step-12) so the store's write path arrives with the Operator that serves it. Step count 13 → 14.

---

### Phase Overview {#phase-overview}

#### Context {#context}

The design is settled in [dash/archive/feed-brief.md](archive/feed-brief.md) and validated by the 2026-08-06 replay spike: Rust wakes the Reporter on cheap structural moments (turn end, sitrep timer, session end, thresholds), a Sonnet job decides editorially whether and what to post, and "post nothing" is a first-class output. The Operator is a plan/execute/answer pipeline over a table of read-only verbs executed Rust-side. Both personas ride one new Sonnet `AgentSpec` on the existing SharedAgent pool — zero new process-supervision machinery.

The two prerequisites this plan was waiting on are now met: the sidebar taxonomy from `dash/layouts-rework-plan.md` has landed on main (commit `0da731033` — `layoutRole: "sidebar"`, registry-driven Layouts controls, side toggles, stacked rails), and the reserved `TUG_FEED = 0x70` FeedId is confirmed consumer-free. One calibration note from the user: the spike's observed cadence of one post per ~5–7 minutes of active work (4-minute sitrep timer) reads as **too slow** — so this plan ships a faster default and makes every cadence number a runtime-tunable knob ([P05]).

#### Strategy {#strategy}

- Build bottom-up along the data path: protocol bytes → ledger table → agent jobs → the pure wake core → the **calibration harness** (before any live bridge, per the brief) → the live Reporter bridge → the Operator pipeline → the deck store → the card → chip actions.
- Keep the wake/segmentation/composition logic a **pure module** shared verbatim by the offline harness and the live bridge, so what the harness tunes is what production runs.
- Inherit, don't invent: the tap and mute machinery mirrors `feeds/pulse.rs`; the pool and job table mirror `shared_agent.rs`; the deck store mirrors `lib/pulse-store.ts`; the card registration mirrors `jots-card-registration.tsx`; the upstream transport mirrors `SHELL_OUTPUT`/`SHELL_INPUT`.
- Every cadence and sizing number is a tugbank default read through a closure at use time, so tuning never needs a restart ([P05]).
- Isolation invariants from the brief are enforced by construction and pinned by tests: the Gazette's own frames never enter the Reporter's tap, and nothing in the subsystem writes toward any work session ([P12]).

#### Success Criteria (Measurable) {#success-criteria}

- `just gazette-replay <session.jsonl>` renders the gazette the Reporter would have posted for a real transcript, with wake counts, silence counts, and per-post wake reasons visible in the output — run on the two spike sessions at `--sitrep-secs` 90/120/180 and read all three, setting the shipped default from what reads best rather than from this plan's guess.
- With a live session doing real work, Reporter posts appear in the Gazette card within one sitrep interval of activity, each carrying a `session_id` and only refs whose targets appear verbatim in the buffered context (verified by the `r02` validation test and by reading live posts).
- Asking the Operator the brief's worked example shape ("what's the CSS file we edited yesterday that changed the border color") produces an answer post that cites `changes.for_path` + `git.show` results, within two retrieval rounds (manual acceptance; the round cap is unit-tested).
- The Gazette card registers as a sidebar card and the Layouts section shows its side control with **no Layouts-section code change** (the registry-driven `sidebarEntries()` walk picks it up — verify by opening the Lens).
- An idle session produces zero wakes (unit test on the wake core); a reconnect replay flood produces zero posts (mute-bracket unit test).
- `cd tugrust && cargo nextest run -p tugcast -p tugcast-core` green; `cd tugdeck && bun test && bun run check && bunx vite build` green; `just app-test-changed` green.

#### Scope {#scope}

1. Protocol: reclaim `0x70` as `GAZETTE`, add `GAZETTE_INPUT = 0x71` (Rust + TS mirrors).
2. Persistence: uncapped `gazette_posts` table in the per-instance session ledger, with tail/search/window reads.
3. One Sonnet `AgentSpec` ("gazette") with jobs `reporter-post`, `operator-retrieve`, `operator-answer`.
4. The pure Reporter wake core (buffers, wake reasons, input composition, envelope parsing).
5. The offline calibration harness (`gazette-replay`) — built before the live bridge.
6. The live Reporter bridge (tap → buffer → wake → post), with tugbank knobs.
7. The Operator pipeline (GAZETTE_INPUT adapter, verb executor, two-round retrieval loop).
8. Deck: `gazette-store.ts`, the Gazette sidebar card (transcript + composer), toggle command + menu row, ref chips.
9. Tests at every layer, including app-tests with `@covers`.

#### Non-goals (Explicitly out of scope) {#non-goals}

- Cross-session digest posts (posts are per-session; interleaving is the feature).
- Conversational Operator memory (each question is self-contained; multi-turn follow-up is a redesign away from SharedAgent, deliberately deferred — brief [P05]-equivalent).
- Any change to Pulse; neither subsystem consumes the other.
- The archived hooks-based tug-feed (`dash/archive/tug-feed.md`): no hook capture, no `.tugtool/feed/feed.jsonl`, no plan-step correlation.
- The Gazette as a control surface: nothing here writes toward a work session.
- Narrating work done outside any session.

#### Dependencies / Prerequisites {#dependencies}

- `dash/layouts-rework-plan.md` landed on main (commit `0da731033`) — sidebar taxonomy, Layouts section, side toggles. **Met.**
- `FeedId::TUG_FEED = 0x70` consumer-free (`tugrust/crates/tugcast-core/src/protocol.rs`, `tugdeck/src/protocol.ts`; only name-map + byte-test references). **Verified 2026-08-07.**
- SharedAgent pool machinery (`tugrust/crates/tugcast/src/shared_agent.rs`) — a second `AgentSpec` is a value, not new machinery (pinned by its test `a_second_agent_spec_runs_on_the_same_pool_machinery`).
- Real session JSONL under `~/.claude/projects/` for the calibration harness.

#### Constraints {#constraints}

- `-D warnings` across the Rust workspace; `cargo nextest run` is the test runner.
- Writable ledger opens go through `tugcore::ledger_db` (enforced by `no_ad_hoc_ledger_opens`). The `gazette_posts` table lives in the per-instance sessions ledger, **not** shared `changes.db`, so `CHANGES_SCHEMA_VERSION` is untouched.
- App-tests must stay free/fast/deterministic: the SharedAgent pool is already gated under `TUGAPP_APP_TEST=1` (`app_test_gated()` in `shared_agent.rs`), so no Reporter or Operator model call can occur in an app-test instance.
- tugdeck laws: [L01] one render, [L02] external state via `useSyncExternalStore`, [L06] appearance via CSS/DOM, [L03]/[L22] registrations in `useLayoutEffect`. Persistent deck state goes through tugbank defaults, never Web storage.
- The Gazette card must be registered unconditionally at boot **before** layout restore (`filterRegisteredCards` drops panes whose componentId is unregistered — the invariant documented in `jots-card-registration.tsx`).

#### Assumptions {#assumptions}

- Sonnet ("sonnet" alias, per the `scribe_model` precedent in `main.rs`) is adequate for all three jobs; the spike validated `reporter-post` quality.
- The `CODE_OUTPUT` broadcast plus the code-submission channel (the pair `session_overview.rs` already taps via `SessionOverviewConfig { code_tx, submission_tx, … }`) carry everything the Reporter's diet needs; the exact allowlist is finalized in Step 6 ([Q02]).
- Megabyte-scale wake inputs are acceptable to Sonnet latency-wise because nothing user-blocking waits on `reporter-post`; the Operator jobs, which a user does wait on, have small inputs.
- **FTS5 is compiled into the bundled SQLite.** `rusqlite` is pinned in `tugrust/Cargo.toml` as `{ version = "0.33", features = ["bundled"] }`, and the bundled `libsqlite3-sys` amalgamation defines `SQLITE_ENABLE_FTS5`. This is the one assumption with a hard dependency on it ([P13]), so Step 2's first task is a spike that falsifies it cheaply; the `LIKE` fallback is named.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Names and toggle chord (DECIDED) {#q01-names-and-chord}

**Question:** What are the feature/card and posting-agent names, and which chord toggles the card?

**Why it matters:** Names permeate every identifier in this plan (protocol consts, table, jobs, modules, card id, action ids); a colliding chord fails the keymap drift tests.

**Resolution:** DECIDED 2026-08-07 with the user — the feature and card are the **Gazette** (the brief's "Feed" was judged weak); the posting agent is the **Reporter** (replacing "Herald", which collided with Gazette; Stringer/Correspondent/Crier/Chronicler were considered and rejected); the **Operator** name stays. The toggle chord is **⌃⌘G**, extending the sidebar-toggle grammar (⌃⌘L Lens, ⌃⌘J Jots). Verified free: `KeyG` appears in `command-registry.ts` only as ⌘G / ⇧⌘G (find next/previous); no ⌃⌘G binding exists there or in `at0168-menu-structure.test.ts`. See [P10].

#### [Q02] Exact Reporter tap allowlist (DECIDED by the Step 5 sweep) {#q02-reporter-allowlist}

**Question:** Which frame types cross into the Reporter's buffer?

**Why it matters:** Too little and posts lose specificity (no commit SHAs, no test totals); too much and wake inputs bloat.

**Plan to resolve:** Start from `PULSE_FORWARD_ALLOWLIST` (`feeds/pulse.rs`) plus user submissions from the code-submission channel and `turn_complete` usage fields; iterate with the Step 5 harness, finalize in Step 6. The brief explicitly anticipates this ("finalized during implementation against the wake/rubric needs").

**Resolution:** DECIDED — the list `reporter_wake.rs` already carries stands unchanged. Three full-transcript replays ([F6](#step-5-findings)) produced no post that wanted evidence the allowlist withheld, and no type on it that read as noise. User prompts ride the code-submission channel into the same buffers, which the harness confirms is load-bearing: a window without the prompt narrates answers to an invisible question. The streaming-only types are untested by replay because transcripts never recorded them; they stay on the Pulse precedent.

#### [Q03] Where do git-verbs run when a question names no session? (DECIDED) {#q03-git-cwd}

**Question:** `git.log`/`git.show`/`repo.grep` need a repo cwd; gazette hits give a `session_id`, but a cold question may not.

**Resolution:** DECIDED — verbs accept an optional `session_id` argument; when present the project dir resolves via `SessionLedger::get(session_id).project_dir`, otherwise the bootstrap workspace's `project_dir` (the `--source-tree` dir `main.rs` resolves at startup). Same fallback shape as the `GIT_LOG_QUERY` adapter in `main.rs`. See [P07].

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Reporter cadence feels wrong (too chatty / too slow) | med | med | every number is a tugbank knob ([P05]); harness built first ([P09]) | user annoyance either direction |
| Refs invented by the model (dead chips) | med | low | Rust-side verbatim validation drops unverifiable refs ([R02]) | a dropped-ref warn rate that suggests over-validation |
| Operator latency exceeds patience | med | med | bounded rounds + per-verb caps + pending-state UI; job timeouts in the spec ([P07]) | answers routinely hitting the 2-round cap |
| Wake input exceeds worker turn budget | low | med | buffer frame/byte caps with elision markers ([P04]); generous `reporter-post` timeout | harness shows truncation destroying post quality |
| All three gazette jobs share one `JobClass` lane (an Operator answer can queue behind a Reporter post) | low | med | `max_workers` defaults to **3** so all three jobs can be in flight at once ([P03], Table T02); knob raises it; a `JobClass` split is the clean later fix | measured queueing in `shared agent call` logs |
| A future column added to `gazette_posts` is wired to the drift guard and erases all history | **high** | low | [P02]'s stated exemption + the ALTER-based `migrate_gazette_posts_add_*` requirement, commented at the DDL | any schema change to the table |

**Risk R01: Rubric drift between harness and production** {#r01-rubric-drift}

- **Risk:** The harness tunes a prompt/segmentation that production doesn't actually run.
- **Mitigation:** One pure module ([P04]) supplies segmentation + composition to both; the `reporter-post` instructions are a single `&'static str` both call through `SharedAgentPool::run`.
- **Residual risk:** Live timing (real inter-frame gaps) differs from replay pacing; the sitrep knob absorbs this.

**Risk R02: A summarized-away SHA can't be linked** {#r02-refs-verbatim}

- **Risk:** Refs whose targets never appeared in the buffered context are hallucinations and make dead provenance chips.
- **Mitigation:** The bridge validates each ref's `target` is a substring of the wake's buffered context; failures are dropped from the post with a `tracing::warn!`. The buffer preserves paths and SHAs verbatim (frames cross as raw payload text, not paraphrase).
- **Residual risk:** A legitimate ref phrased differently than the buffer (e.g. abbreviated SHA) is dropped; acceptable v1 — the post body still reads fine.

---

### Design Decisions {#design-decisions}

#### [P01] GAZETTE 0x70 downstream, GAZETTE_INPUT 0x71 upstream (DECIDED) {#p01-transport}

**Decision:** Rename `FeedId::TUG_FEED` → `FeedId::GAZETTE` (byte 0x70 kept, wire name `"Gazette"`), and add `FeedId::GAZETTE_INPUT = 0x71` (`"GazetteInput"`) for deck → tugcast user posts/questions.

**Rationale:**
- The brief reclaims 0x70; the sibling-input shape follows the `SHELL_OUTPUT` (0x60) / `SHELL_INPUT` (0x61) precedent exactly, and `register_input` is the established upstream mechanism (`feed_router.register_input(FeedId::USAGE_QUERY, …)` in `main.rs`).
- A bidirectional single id would be the only one of its kind on the wire; the sibling costs one byte and zero novelty.
- `GAZETTE` avoids a collision that is real, not stylistic: `tugdeck/src/lib/feed-store.ts` **already exists** and exports a `FeedStore` class — the per-card, workspace-key-filtered subscription store behind `CardHost`/`useCardData`, imported by `card-registry.ts` (`FeedStoreFilter`) and covered by `src/__tests__/feed-store.test.ts`. A `FeedStore` for this feature would have been a second class of that name in the same directory. On the Rust side `FeedId::FEED` would have read absurdly beside `StreamFeed`, `register_session_feed`, and `feed_router`.

**Implications:** Edits in `tugrust/crates/tugcast-core/src/protocol.rs` (const at the `TUG_FEED` site, `name()` arm, byte test) and the TS mirror `tugdeck/src/protocol.ts`; the "reserved for Phase T3+" comment retires.

#### [P02] gazette_posts lives uncapped in the per-instance session ledger (DECIDED) {#p02-ledger-table}

**Decision:** One `gazette_posts` table in the sessions ledger (`SessionLedger::bootstrap_schema`'s `execute_batch`, next to `pulse_lines`), append-only and **uncapped**, with **no session cascade trigger** and — critically — **never registered with `rebuild_table_if_schema_drifted`**.

**Rationale:**
- The brief requires the Pulse *scoping* (app-scoped, one per tugcast instance) but explicitly not the Pulse *cap* — history is the point.
- `pulse_lines` already documents the no-cascade posture ("the narrative log outlives any one session"); the Gazette's provenance links must survive session eviction the same way.
- A new database would need its own `ledger_db` open, writer lock, and janitor story for zero benefit; the sessions ledger already has all three.

**The drift-guard exemption is load-bearing.** `pulse_lines` — the table this one is modelled on structurally — is a *capped rolling log*, so the self-healing guard's DROP-and-recreate is harmless for it. `gazette_posts` is permanent history: registering it with `rebuild_table_if_schema_drifted` would silently erase the entire gazette the first time a column set changed. That guard is opt-in per table (`bootstrap_schema` wires it only for `turn_telemetry` and the two legacy `main.`-qualified tables), so the exemption is the default — but it must be stated, because the instinct when adding a column later is to reach for the guard. **Any future column change to `gazette_posts` goes through an ALTER-based `migrate_gazette_posts_add_*` function**, following `migrate_pulse_lines_add_intent`, and never through the rebuild path.

**Implications:** New row struct `GazettePostRow` and APIs `record_gazette_post`, `list_gazette_posts_tail`, `search_gazette_posts`, `gazette_posts_window` in `session_ledger.rs`; an index on `(session_id)`; `refs` persisted as a JSON array string like `pulse_lines.scopes`. Search is FTS5-backed per [P13].

#### [P03] One Sonnet AgentSpec, three fixed jobs (DECIDED) {#p03-agent-spec}

**Decision:** A second `SharedAgentPool` with `AgentSpec { name: "gazette", model: <closure>, jobs: GAZETTE_AGENT_JOBS, max_workers }`; jobs `reporter-post` (timeout 120s), `operator-retrieve` (30s), `operator-answer` (120s); model resolved per spawn from tugbank `dev.tugtool.gazette`/`model`, falling back to `"sonnet"`.

**Rationale:**
- Exactly the extension `shared_agent.rs` anticipates and tests (`a_second_agent_spec_runs_on_the_same_pool_machinery`).
- The `scribe_model` closure pattern in `main.rs` (falls back to `"sonnet"` by name) is the precedent the brief names for the model default.
- Cost is a declared non-concern; timeouts are quality ceilings, not budgets — nothing user-blocking waits on `reporter-post`, and the Operator jobs get a pending UI.

**Implications:** `JobClass::of` maps all three names to `Summarize` (its catch-all) — one latency lane, acceptable because no gazette job has a 2-second-class contract, but it is why `max_workers` defaults to **3** rather than the Haiku pool's 2 (Table T02): a 120s `reporter-post` must not be able to sit in front of a user's question. If telemetry later shows queueing anyway, the clean fix is a new `JobClass` variant splitting the Operator lane from the Reporter's — a value change in `JobClass::of`, not new machinery. New module `feeds/gazette_agent.rs` holds the job table and instruction strings.

#### [P04] Wake structurally in a pure core module (DECIDED) {#p04-wake-core}

**Decision:** All wake logic — per-session frame buffers, wake reasons, sitrep bookkeeping, job-input composition, and Reporter envelope parsing — lives in a pure, IO-free module `feeds/reporter_wake.rs`, consumed identically by the replay harness and the live bridge.

**Rationale:**
- The harness's entire value ([P09]) depends on tuning the exact code production runs (Risk R01).
- Pure functions make idle-never-wakes, buffer-caps, and envelope-strictness unit-testable without tokio plumbing.

**Implications:** The buffer caps frames (default 256) and bytes (~256 KB) per session, dropping oldest with an explicit `[earlier frames elided]` marker in composed input; the live bridge owns only tokio wiring (taps, timers, task spawns).

#### [P05] Every cadence number is a tugbank knob, read at use time (DECIDED) {#p05-knobs}

**Decision:** All tuning values live as tugbank defaults in domain `dev.tugtool.gazette`, read through closures per wake/spawn (never cached at startup): see Table T02. The sitrep default ships at **90 seconds**, set from the Step 5 sweep ([findings](#step-5-findings)) — the plan's guess was 180, three replays of a real session were read side by side, and 90 was the one that read like someone telling you what is happening rather than a log to skim later.

**Rationale:**
- The brief makes cadence "a prompt-tunable editorial policy"; the user explicitly asked to "retain tuning knobs that we can turn as we build this and start experiencing it".
- The mechanism (closure over `TugbankClient::get`, absent-reads-as-default) is exactly `pulse_enabled` / `scribe_model` in `main.rs`.

**Implications:** No restart needed for a knob change; the deck's render-window knob rides the DEFAULTS feed the way `pulse-store.ts` watches `dev.tugtool.pulse`/`enabled`.

#### [P06] The Reporter envelope is strict JSON; malformed output is silence (DECIDED) {#p06-envelope}

**Decision:** `reporter-post` must answer with exactly `{"post": null}` or `{"post": {"body": "...", "refs": [{"kind": "...", "target": "..."}]}}` (Spec S01). Anything unparseable, or any ref with an unknown `kind`, is logged and produces **no post** — never a repaired or partial one.

**Rationale:**
- Mirrors `handle_pulse_line`'s posture ("wire delivery and persistence must never panic on daemon output") and the classify `verdict()` posture (a malformed answer is a refusal, not a guess).
- "Post nothing" being first-class means silence is always a safe failure mode.

**Implications:** Strict serde types with `deny_unknown_fields`; a unit test walks malformed shapes.

**Amended after the Step 5 sweep ([F1](#step-5-findings)):** the envelope must be *well-formed*, not *alone*. Requiring it to be the entire answer cost 22 of 52 wakes in one calibration run — every one of them a complete envelope behind a sentence the model wrote first, discarded and then reported as editorial silence. `parse_envelope` now locates the outermost `{…}` span and parses that, which is finding the envelope rather than repairing one: the JSON is still the model's own, still whole, still `deny_unknown_fields`, and a genuinely broken envelope still yields no post. The strictness this decision is actually about is intact; the "bare JSON only" reading of it is not, and the instructions asking for bare JSON stay as a preference rather than a contract the parser enforces.

#### [P07] Operator verbs execute Rust-side, read-only, capped (DECIDED) {#p07-verbs}

**Decision:** The model emits verb *requests* (Spec S02); a Rust executor in `feeds/operator.rs` runs them read-only with per-verb output caps and a 10s per-verb timeout; retrieval is hard-capped at **two rounds**, then `operator-answer` must answer with what it has.

**Rationale:** Direct from the brief — read-only-ness structural, the job table auditable, latency bounded, the exchange scorable later.

**Implications:** Verb table T01 is the contract; git verbs run `tokio::process::Command` in the project dir resolved per [Q03]; ledger verbs read `SessionLedger` (sessions, turns, file_events, gazette_posts). No verb touches the filesystem outside `git`/`git grep` in a resolved project dir.

#### [P08] User posts echo through the ledger first; transient Operator errors don't persist (DECIDED) {#p08-user-echo}

**Decision:** A `GAZETTE_INPUT` submission is persisted as a `user` post and broadcast **before** the Operator pipeline runs. If the pipeline fails (pool unavailable, timeout), the bridge broadcasts a transient `operator` post with `"transient": true` that is **not** written to the ledger.

**Rationale:**
- The user's question is history (the Operator queries scrollback context from the ledger); an infrastructure hiccup is not.
- Persisting "shared agent unavailable" rows would pollute `gazette.search` forever.

**Implications:** The wire `GazettePost` payload has an optional `transient` flag the deck renders but the ledger writer refuses; the `request_id` from the submission is echoed on the answer/error broadcast (never persisted) so the deck can clear its pending state.

#### [P09] The calibration harness is part of the feature and lands before the live bridge (DECIDED) {#p09-harness}

**Decision:** The harness is a **hidden subcommand on the existing `tugcast` binary** — `tugcast gazette-replay <jsonl> [flags]`, dispatched in `main()` before the server boots and wrapped by `just gazette-replay`. It replays real session JSONL through the wake core + the real `reporter-post` job and renders the resulting gazette as markdown to stdout, with per-wake diagnostics (reason, buffer size, post-or-silence).

**Rationale:**
- Direct from the brief ("built first"); the spike validated the approach — this makes it a repeatable tool running the production wake core rather than a one-off script.
- **A separate binary is not available.** `tugcast` is a **binary-only crate**: there is no `src/lib.rs`, `Cargo.toml` declares `[[bin]] name = "tugcast", path = "src/main.rs"`, and no file in `tugrust/crates/tugcast/tests/` contains `use tugcast::` — those integration tests spawn the real binary through `common::TestTugcast`. A `src/bin/gazette_replay.rs` would be its own crate root and **could not import `feeds::reporter_wake`**, which is the whole point of [P04] and the entire mitigation for Risk R01. The rejected alternatives: adding a `[lib]` target and reducing `main.rs` to a shim (a large refactor touching every `crate::` path, for no benefit this feature needs), or an `#[ignore]`-gated module inside the bin crate like `integration_tests.rs` (works, but the output becomes a test log rather than a readable gazette — and reading it *is* the tool's purpose).
- The subcommand costs one match arm and reuses the `cli.rs` clap surface that already exists.

**Implications:** Flags override the knobs (`--sitrep-secs`, `--last-k`, `--model`, `--max-frames`, `--no-model`); the subcommand returns before any listener binds, so a replay never contends with a live tugcast; replay pacing is simulated from JSONL timestamps, not wall clock; it spawns real `claude` via `ClaudeAgentWorkerSpawner` and therefore never runs in CI or under `TUGAPP_APP_TEST`.

#### [P10] The Gazette card is a Jots-pattern sidebar singleton; ⌃⌘G toggles it (DECIDED) {#p10-card}

**Decision:** Register componentId `"gazette"` with `layoutRole: "sidebar"`, `family: "gazette"`, `acceptsFamilies: []`, `hidden: true`, `lensGroup: "none"`, sizePolicy min 320×240 / preferred 420×900 — the `registerJotsCard()` shape verbatim. Toggle via `TUG_ACTIONS.TOGGLE_GAZETTE`, chord ⌃⌘G, routing `"registry"`, `menuItemId: "maker.gazette"`, with a native "Show Gazette" menu row in `tugapp/Sources/AppDelegate.swift` mirroring the Jots row.

**The chord grant, stated as [L30]/R6 requires — tier *and* menu choice:**
- **Tier: ⌃⌘, the Tug tier.** `tuglaws/chord-tiers.md` defines ⌃⌘ as "Tug's own machinery: surfaces, shades, modes, themes, app-specific features" — a sidebar surface toggle is the tier's central case, and it joins the sitting residents ⌃⌘L (Lens), ⌃⌘J (Jots), ⌃⌘C (Changes), ⌃⌘H (History), ⌃⌘K (Keyboard Shortcuts).
- **Rule R1 is satisfied vacuously:** there is no ⌘G base command for this verb to twist (⌘G/⇧⌘G are Find Next/Previous, an unrelated verb), so this is not a climbed modifier stack — it is a Tug-tier grant on a mnemonic letter.
- **Availability verified 2026-08-07:** ⌃⌘G appears in neither `command-registry.ts` (whose only `KeyG` bindings are ⌘G and ⇧⌘G) nor the native menu layer (`AppDelegate.swift`'s only G is ⌥⌘G, New Component Gallery Card).
- **Menu choice (R6): `menuEligible: true`.** The binding is authored as `chord({ key: "KeyG", ctrl: true, meta: true, label: "g" }, { preventDefault: true, menuEligible: true })` — byte-for-byte the `TOGGLE_JOTS` shape. Menu eligibility is chosen deliberately: it resolves at the native menu layer before any scoped binding, which is what makes the toggle work while the native title bar holds focus.

**Rationale:**
- The layouts-rework registry makes the Layouts section side control, rails, and equal-resize allocator free on registration (`sidebarEntries()` in `layouts-section.tsx` walks `getAllRegistrations()` filtering `layoutRole === "sidebar"`).
- The sidebar-toggle grammar extends naturally, and G is the feature's own initial.

**Implications:** Boot registration in `main.tsx` unconditionally before layout restore (the Jots INVARIANT); `at0168-menu-structure.test.ts` fixture, `command-routing-drift.test.ts`'s chord table, and the `tuglaws/menus.md` table each gain a row; no Layouts-section edits.

#### [P11] The deck gazette store mirrors pulse-store (DECIDED) {#p11-gazette-store}

**Decision:** A singleton `lib/gazette-store.ts`: on connect it fetches the tail via the app-scoped CONTROL verb `list_gazette_posts`, folds live `GAZETTE` frames, exposes a `useSyncExternalStore` hook, tracks pending question state by `request_id`, and submits user posts as `GAZETTE_INPUT` frames.

**Rationale:** `lib/pulse-store.ts` is the proven shape (CONTROL tail read on mount + live fold + DEFAULTS-feed knob watch); the CONTROL verb slot is `agent_supervisor.rs::handle_control` next to `"list_pulse_lines"`.

**Implications:** The card renders the store's window (default 50 rows, knob `card_rows`); aging out is a render window, never a deletion; the store gets the same test-only frame-injection seam pulse-store has, which is what the app-test drives.

#### [P12] Isolation invariants, inherited and pinned (DECIDED) {#p12-isolation}

**Decision:** (a) Reporter/Operator/user posts travel only on `GAZETTE` and never enter the Reporter's tap (its inputs are the CODE_OUTPUT broadcast + submission channel + session-state frames — `GAZETTE` is not subscribed, so no feedback loop is constructible). (b) Nothing in the subsystem writes toward any work session: outputs are the ledger, the `GAZETTE` broadcast, and tracing. (c) Replay brackets mute exactly as in `feeds/pulse.rs::forwardable_session`; lagging receivers drop frames.

**Rationale:** Direct from the brief; both invariants are Pulse's law, already proven in `pulse.rs` and its tests.

**Implications:** The bridge holds no `code_submission_tx` *sender* toward sessions and no supervisor handle that can dispatch; a test asserts a `GAZETTE`-tagged frame never reaches the buffer.

#### [P13] Gazette search is FTS5, not SQL LIKE (DECIDED) {#p13-fts5}

**Decision:** `search_gazette_posts` is backed by an **FTS5 external-content virtual table** over `gazette_posts(body, refs)` with the standard `INSERT`/`UPDATE`/`DELETE` sync triggers, ranked by `bm25()`, with excerpts produced by `snippet()`. A one-line spike at Step 2 confirms FTS5 is compiled in; if it is not, the fallback is `LIKE` and this decision is revisited.

**Rationale:**
- The Operator's headline use case is "what was that commit two weeks ago that did *blah*" over an **uncapped, permanently growing** prose table ([P02]). `LIKE '%term%'` cannot use an index, has no tokenization or stemming, no multi-term AND/OR semantics, and no relevance ranking — so it degrades linearly with history and returns an *arbitrary* capped 20 rows rather than the *best* 20. For a feature whose whole value is retrieval over a growing archive, that is the wrong mechanism from day one, and swapping it later means rewriting the verb, its caps, and its tests.
- FTS5 should be available without a new dependency: `rusqlite` is pinned in `tugrust/Cargo.toml` as `{ version = "0.33", features = ["bundled"] }`, and the bundled `libsqlite3-sys` amalgamation is compiled with `SQLITE_ENABLE_FTS5`.
- `snippet()` directly supplies the capped excerpts Table T01 already requires, so the excerpting logic is the search engine's job rather than hand-rolled string slicing.

**Implications:** Step 2 gains the virtual table, its triggers, and the availability spike; `gazette.search` returns bm25-ordered hits; the external-content shape means `gazette_posts` remains the single source of truth and the index is rebuildable. The FTS5 shadow tables are *derived*, so unlike `gazette_posts` itself they may be dropped and rebuilt freely — that asymmetry with [P02]'s exemption is deliberate and should be commented at the DDL.

#### [P14] A failed wake returns its window to the buffer (DECIDED) {#p14-failed-wake}

**Decision:** When a wake's `reporter-post` job returns `Err` (worker died, pool unavailable, timeout), the snapshotted frames are **re-merged to the front of that session's buffer** (subject to the [P04] caps) rather than dropped, and the failure is logged as a distinct `tracing::warn!` from an editorial no-post.

**Rationale:**
- "Post nothing" is a first-class *editorial* output ([P06]); an infrastructure failure is not the same thing, and conflating them means a stretch of real work is silently never narrated and the failure rate is invisible.
- The buffer caps bound the re-merge, so a persistently failing pool cannot grow memory without limit — it degrades to narrating only the most recent window, which is the correct posture.

**Implications:** The wake path is snapshot → run → on `Err` re-merge; the two no-post outcomes carry different log lines so the harness and `shared agent call` telemetry can tell them apart. A test scripts a failing pool and asserts the frames survive to the next wake.

---

### Deep Dives {#deep-dives}

#### Bridge topology {#bridge-topology}

```
CODE_OUTPUT broadcast ──allowlist tap──▶ per-session FrameBuffer ─┐
code submissions (user prompts) ──────▶ (same buffers)           ├─ wake decision ──▶ reporter-post job ──▶ envelope parse
SESSION_STATE frames (session end) ───▶ wake trigger ────────────┘        │                                    │
                                                                    "no wake"/silence               gazette_posts row + GAZETTE broadcast

GAZETTE_INPUT frame ──▶ persist user post + GAZETTE broadcast ──▶ operator-retrieve ──▶ verb executor ──▶ operator-answer
                                                                       ▲                     │ (≤2 rounds)      │
                                                                       └── optional follow-up verb list ────────┘
                                                                                            gazette_posts row + GAZETTE broadcast
```

The Reporter bridge is a `StreamFeed` (like `PulseBridge`): `feed_id() = FeedId::GAZETTE`, `channel_capacity() = 64`, default `Warn` lag policy, registered via `feed_router.register_stream_feed` in `main.rs`. It subscribes `code_tx` inside its task, receives submissions the way `session_overview_task` does (`SessionOverviewConfig` carries `submission_tx: code_submission_tx.clone()` — mirror that wiring), and watches session-state frames for session-end wakes. Each wake snapshots-and-clears that session's buffer and spawns a task running the job so a slow model turn never blocks the tap loop; a job that fails returns its frames to the buffer ([P14]).

**Construction ordering in `main.rs`** (get this right up front rather than discovering it mid-step). `register_stream_feed` *returns* the feed's `broadcast::Sender<Frame>` — that is the only way to obtain the GAZETTE sender, so the #step-11 Operator adapter must be constructed **after** the #step-6 registration. This is exactly the existing shape: `let pulse_tx = feed_router.register_stream_feed(Box::new(pulse_bridge), …)` is followed by the session-overview block that consumes `pulse_tx`. The three inputs the bridge needs are all available at that point in the file: `code_output_feed` and `code_submission_tx` are built early (the submission channel at `main.rs`'s `let (code_submission_tx, _) = broadcast::channel::<Frame>(64)`), and `session_state_feed` — a `SessionScopedFeed` exposing `.sender()` — is constructed well before the pulse-bridge neighborhood where the Reporter goes.

**Table T03: Wake reasons** {#t03-wake-reasons}

| Reason (wire string) | Trigger | Notes |
|---|---|---|
| `turn-end` | a `turn_complete`/`turn_cancelled` frame for the session | functions as a flush + "ready to look in" signal; the spike showed the timer dominates |
| `sitrep-timer` | ≥ `sitrep_secs` of continuous activity since the session's last post, with a non-empty buffer | an idle session (empty buffer) never wakes — silence isn't news |
| `session-end` | session-state frame reporting the session ended | the model writes wrap-up posts on this reason |
| `token-threshold` | cumulative turn-usage tokens since last post ≥ `token_wake_tokens` | knob default 0 = disabled |

#### The Operator's verb table {#verb-table}

**Table T01: Read-only verbs** {#t01-verbs}

All executed by `feeds/operator.rs`, all capped, all with a 10s timeout. `session_id` args resolve project dirs per [Q03].

| Verb | Args | Backing | Cap |
|------|------|---------|-----|
| `gazette.search` | `query`, opt `since_ms`/`until_ms`/`author`/`session_id` | `search_gazette_posts` — FTS5 over body+refs, `bm25()`-ranked ([P13]) | 20 posts, `snippet()` excerpts ≈240 chars |
| `gazette.window` | `post_id`, `n` | `gazette_posts_window` | n ≤ 10 each side |
| `sessions.list` | opt date range, opt `active` | `sessions` table (`list_*` reads) | 50 rows: id, name/last_user_prompt incipit, created/last-used, state |
| `session.prompts` | `session_id`, opt `query` | `turns` table (`user_text`, `created_at`) | 50 prompts, 500 chars each |
| `changes.for_session` | `session_id` | `changes.file_events` by `tug_session_id` | 200 rows: path, op, origin |
| `changes.for_path` | `pattern`, opt date range | `changes.file_events` by path LIKE | 200 rows + owning session ids |
| `git.log` | opt `grep`, `pickaxe`, `path`, `since`/`until`, `n`, `session_id` | `git log` subprocess | n ≤ 30: sha, date, subject, files |
| `git.show` | `sha`, opt `path`, opt `session_id` | `git show` subprocess | message + diff capped 400 lines / 16 KB |
| `repo.grep` | `pattern`, opt `path_scope`, opt `session_id` | `git grep -n -I` subprocess | 100 matches |

`changes.for_session`/`changes.for_path` need two small new read APIs in `session_ledger.rs` (the write side and `file_event_spans_for_paths` exist; a by-session and a by-path-pattern row read do not).

#### Knobs {#knobs}

**Table T02: tugbank defaults, domain `dev.tugtool.gazette`** {#t02-knobs}

| Key | Type | Default | Read by | Meaning |
|---|---|---|---|---|
| `enabled` | bool | `true` | bridge, per frame | kill switch; disabled drops frames and wakes nothing (the `pulse_enabled` posture) |
| `model` | string | `"sonnet"` | pool, per spawn | model for all three jobs |
| `max_workers` | i64 | **3** | pool construction | worker cap for the gazette pool. Three, not the Haiku pool's two: `JobClass::of` maps every non-`classify*` name to `Summarize`, so all three gazette jobs share **one latency lane**, and a 120s `reporter-post` holding a worker while a user's `operator-retrieve` arrives would make the question wait on it. Three leaves room for a Reporter post, a retrieve, and an answer concurrently |
| `sitrep_secs` | i64 | **90** | bridge, per timer arm | the dominant cadence, set by reading the Step 5 sweep rather than by argument. Try 75 if 90 proves too quiet in practice — the knob turns live, and `gazette-replay --sitrep-secs` reads any candidate against a real transcript first |
| `last_k_posts` | i64 | 5 | bridge, per wake | how many of the Reporter's own prior posts for the session ride the wake input (the dedup mechanism) |
| `token_wake_tokens` | i64 | 0 (off) | bridge, per turn-complete | token-threshold wake |
| `buffer_max_frames` | i64 | 256 | wake core, per push | per-session buffer frame cap (byte cap fixed ~256 KB) |
| `card_rows` | i64 | 50 | deck gazette-store via DEFAULTS feed | render window; never a deletion |

---

### Specification {#specification}

**Spec S01: Reporter job I/O** {#s01-reporter-envelope}

Input (composed by the wake core, one self-contained turn per [shared-agent P05]): the wake reason string, the session id, the session's buffered frames rendered as JSONL lines (verbatim payloads, oldest first, elision marker when capped), and the Reporter's last K posts for that session as `- [at_ms] body` lines. The instructions carry the editorial rubric from the brief (§"The editorial rubric") and the output contract:

```json
{"post": null}
{"post": {"body": "…digest-sized write-up…", "refs": [{"kind": "commit", "target": "0da731033"}]}}
```

`kind ∈ session|file|commit|plan|brief`; strict parse, `deny_unknown_fields`; unparseable ⇒ no post ([P06]); each ref's `target` must appear verbatim in the buffered context or the ref is dropped with a warn ([R02] — `session` refs are exempt: the bridge stamps `session_id` itself).

**Spec S02: Operator job I/O** {#s02-operator-envelope}

`operator-retrieve` input: the question + the last 20 gazette posts (server-side scrollback from the ledger). Output: `{"verbs": [{"verb": "gazette.search", "args": {…}}, …]}` — ≤ 6 invocations. `operator-answer` input: question + scrollback + all verb results as labeled JSON blocks. Output: either `{"answer": {"body": "…", "refs": […]}}` or `{"verbs": […]}` (one follow-up round). After round 2 the executor re-runs `operator-answer` with a "you must answer now; say what you could not confirm" addendum. Malformed output ⇒ transient error post ([P08]).

**Spec S03: Wire GazettePost payload (GAZETTE frames, and the CONTROL tail read)** {#s03-wire-post}

```json
{"id": 42, "at_ms": 1754500000000, "author": "reporter", "session_id": "abc…", "wake_reason": "sitrep-timer", "body": "…", "refs": [{"kind": "file", "target": "tugdeck/src/x.css"}], "request_id": "…", "transient": false}
```

`author ∈ reporter|operator|user`. `id` is the ledger rowid (absent on transient posts); `request_id` only on Operator answers/errors responding to a `GAZETTE_INPUT` carrying one; `transient: true` never persisted. `GAZETTE_INPUT` payload: `{"body": "…", "request_id": "…"}`. TS types live in `tugdeck/src/protocol.ts` or a `lib/gazette-types.ts` beside the store.

#### State Zone Mapping (tugdeck/tugways plans) {#state-zone-mapping}

| State | Zone | Mechanism | Law |
|-------|------|-----------|-----|
| gazette posts window + pending question | external app data | `GazetteStore` singleton + `useSyncExternalStore` | [L02] |
| composer document | editor substrate | CM6 via `TugMessageEditor` (mirrored out imperatively, never a controlled value) | [L02], [L11] |
| rail visibility / side / width | deck structure | existing deck store imposition (`sidebars` record) — no new state | [L02] |
| post hover/expand affordances | appearance | CSS `:hover` / data-attributes | [L06] |
| responder + command registrations | registration | `useLayoutEffect` / `useResponder` | [L03], [L22] |
| render-window size (`card_rows`) | persistent preference | tugbank DEFAULTS feed (never Web storage) | — |
| store's acquired resources (frame callback, DEFAULTS watch, pending timeout) | lifecycle | each acquisition captures its unregister closure; all released in `GazetteStore.dispose()` | **[L27]** |
| transcript content area | selection | registered as a selection boundary so `SelectionGuard` clamps to the card | **[L12]** |
| post row identity across transient → persisted | reconciliation | `key` is the `request_id` (stable across the swap), never the ledger `id` (absent on transient) | **[L26]** |

**[L27] is the law this card is most likely to break, so it is called out rather than left to the table.** The `GazetteStore` is a singleton that subscribes to the app-lifetime `TugConnection`; every one of its acquisitions — the `conn.onFrame(FeedId.GAZETTE, …)` registration, the DEFAULTS-feed watch backing `card_rows`, and the pending-question timeout timer — wires a shorter lifetime into a longer one and therefore owes a release. `lib/pulse-store.ts` is the model: it captures the return of `this.conn.onFrame(...)` for exactly this reason. The law admits no partial compliance ("Every leak is a bug… there is no 'acceptable' number of leaked callbacks"), and a `_disposed` guard is explicitly *not* a substitute for unwiring.

**[L29] boundary, for clarity:** ref-chip targets and the Operator's `path` / `path_scope` verb arguments are model-supplied, repo-relative strings used for an immediate operation — they are not persisted keys or cross-path comparisons, so the canonicalization gateway is not triggered by them. What *is* canonical is the `project_dir` read from the ledger in [Q03], which is the correct base to join them onto. The rule to hold: a chip target may never become a store key, a defaults domain, or a comparison subject without first passing `CanonicalPath::from_raw`.

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tugrust/crates/tugcast/src/feeds/reporter_wake.rs` | pure wake core: `FrameBuffer`, `WakeReason`, `compose_reporter_input`, `ReporterEnvelope` parse, ref validation |
| `tugrust/crates/tugcast/src/feeds/reporter.rs` | live bridge: `ReporterBridge` (`StreamFeed`), taps, sitrep timers, knob closures, ledger write + broadcast |
| `tugrust/crates/tugcast/src/feeds/gazette_agent.rs` | `GAZETTE_AGENT_JOBS`, instruction strings (rubric, retrieve, answer), knob key consts, `dev.tugtool.gazette` domain const |
| `tugrust/crates/tugcast/src/feeds/operator.rs` | `GAZETTE_INPUT` handling, verb executor, two-round pipeline, transient error posts |
| `tugrust/crates/tugcast/src/feeds/gazette_replay.rs` | calibration harness ([P09]) — a **module in the bin crate**, reached by the `gazette-replay` subcommand dispatched from `main()`. NOT `src/bin/`: tugcast has no lib target, so a second binary could not import the wake core |
| `tugdeck/src/lib/gazette-store.ts` (+ `__tests__`) | [P11] store |
| `tugdeck/src/lib/gazette-card-id.ts` | `GAZETTE_CARD_ID = "gazette"` |
| `tugdeck/src/components/gazette/gazette-card-registration.tsx` | [P10] registration |
| `tugdeck/src/components/gazette/gazette-card.tsx` + `gazette-card.css` | transcript + composer UI |
| `tests/app-test/at0xxx-gazette-card.test.ts` | app-test with `@covers` (number assigned at authoring) |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `FeedId::GAZETTE`, `FeedId::GAZETTE_INPUT` | const | `tugcast-core/src/protocol.rs` | [P01]; rename of `TUG_FEED`, new 0x71; `name()` arms; byte tests |
| `GAZETTE`, `GAZETTE_INPUT` | const | `tugdeck/src/protocol.ts` | TS mirror |
| `GazettePostRow`, `record_gazette_post`, `list_gazette_posts_tail`, `search_gazette_posts`, `gazette_posts_window` | struct/fns | `tugcast/src/session_ledger.rs` | [P02] |
| `list_file_events_for_session`, `list_file_events_for_path_pattern` | fns | `tugcast/src/session_ledger.rs` | backing for T01 change verbs |
| `"list_gazette_posts"` arm + `do_list_gazette_posts` | control verb | `tugcast/src/feeds/agent_supervisor.rs` | beside `"list_pulse_lines"` |
| gazette pool + bridge + adapter wiring | wiring | `tugcast/src/main.rs` | pool construction beside `haiku_agent`; `register_stream_feed(ReporterBridge…)`; `register_input(FeedId::GAZETTE_INPUT, …)` |
| `TOGGLE_GAZETTE: "toggle-gazette"` + its payload doc block | action id | `components/tugways/action-vocabulary.ts` | the file documents each action's payload above the id table; both places need the entry |
| `TOGGLE_GAZETTE` command entry | command | `components/tugways/command-registry.ts` | `routing: "registry"`, `menuItemId: "maker.gazette"`, chord ⌃⌘G with `{ preventDefault: true, menuEligible: true }` ([P10]) |
| `TOGGLE_GAZETTE` handler + action-id list entry | handler | **`components/chrome/deck-canvas.tsx`** | one line: `store.toggleSidebarPane(GAZETTE_CARD_ID)`, beside the `TOGGLE_JOTS` handler. **Not `action-dispatch.ts`** — the sidebar toggles live in deck-canvas, and the action id must also be added to that file's registered-action list |
| `["⌃⌘G", TUG_ACTIONS.TOGGLE_GAZETTE]` | test row | `components/tugways/__tests__/command-routing-drift.test.ts` | the chord→action drift table; a missing row fails the suite |
| "Show Gazette" menu row | Swift | `tugapp/Sources/AppDelegate.swift` | mirror the "Show Jots" row (`identified("maker.gazette")`, `keyEquivalent: ""` — the chord is applied from the registry, not hardcoded); update `at0168-menu-structure.test.ts` + `tuglaws/menus.md` |
| `gazette-replay` recipe | just | `justfile` | wraps `tugcast gazette-replay` ([P09]) |

---

### Documentation Plan {#documentation-plan}

- [x] `tuglaws/menus.md`: row for the "Show Gazette" menu item (`maker.gazette` / `toggle-gazette`) — #step-8.
- [ ] Module doc comments carry the doctrine (reporter.rs topology header modeled on pulse.rs's; gazette_agent.rs knob table) — no freestanding docs/*.md dropfiles.
- [ ] `dash/archive/feed-brief.md` stays as-is (the decided design); this plan's naming note is the bridge from the brief's Feed/Herald vocabulary.

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit (Rust)** | wake core (idle-never-wakes, caps, envelope strictness, ref validation), ledger APIs, verb caps, round cap, mute brackets, isolation | bulk of coverage; fake spawner scripts model answers, never asserts prose |
| **Unit (deck)** | gazette-store fold/tail/pending, **resource release on `dispose()` ([L27])**, registration invariants | `bun test` |
| **Integration (Rust)** | bridge task with `FakeSpawner`-style scripted pool: frame in → post out; GAZETTE_INPUT → user echo + answer post | tokio tests mirroring `pulse.rs` tests |
| **App-test** | rail toggles, rows render from injected frames, composer submits | one file, `@covers` |
| **Real-model** | one `#[ignore]` + `TUG_REAL_CLAUDE=1` test running a real `reporter-post` turn (envelope parses) — the `a_real_worker_answers…` pattern | on demand |

#### What stays out of tests {#test-non-goals}

- Model prose quality — that is the calibration harness's business, read by a human.
- jsdom render tests and mock-store assertion tests — banned pattern; UI coverage is the app-test on the real app.
- End-to-end Operator answer quality — manual acceptance against the worked example; the corpus-scoring harness is a follow-on.

---

### Execution Steps {#execution-steps}

> **Commit after all checkpoints pass.** Rust checkpoints run from `tugrust/`; deck checkpoints from `tugdeck/`.

#### Implementation Phases — one `/implement` call each {#phases}

Fourteen steps is far too much for a single run. They group into **six phases**, each a self-contained `/implement` call ending in something demonstrable. The seams are chosen so that every phase boundary is a place where stopping is *natural* — the work below it is complete and useful, and nothing above it is half-wired.

**Two of the boundaries are human gates**, not merely convenient stopping points. Phase B ends where only you can decide what happens next (which cadence reads right), and Phase D ends where the feature first becomes something to live with. Neither decision should be made by an agent mid-run, which is why each gets its own phase even though B is a single step.

**Table T04: Phases** {#t04-phases}

| Phase | Steps | Lands | Gate before the next call |
|---|---|---|---|
| **A — Foundations** | #step-1 – #step-4 | Protocol bytes, the ledger + FTS5, the agent spec and its rubric prose, the pure wake core. All Rust, all unit-tested, nothing observable yet. | none — run straight into B |
| **B — Calibration** | #step-5 | `just gazette-replay` over real transcripts at three cadences. | **Yours.** Read the three gazettes; set `sitrep_secs`; accept or rewrite the rubric. This is the question the whole feature turns on and the harness exists to answer it. |
| **C — The Reporter goes live** | #step-6 | Real posts in the ledger and on the wire, watchable from the dev log. | Confirm posts land during real work |
| **D — The Gazette you can read** | #step-7 – #step-9 | The rail renders live Reporter posts; ref chips act. **The feature becomes real here.** | **Yours.** Live with it. Turn `sitrep_secs` and `card_rows` against actual use — the knobs are runtime-tunable ([P05]) precisely so this gate needs no rebuild. |
| **E — The Operator** | #step-10 – #step-12 | Read-only verbs, the two-round pipeline, and the composer that reaches them. | Worked-example question answers correctly |
| **F — Proof and close** | #step-13 – #step-14 | App-test, doc rows, full-workspace green. | phase close |

**Why the Operator comes after the card.** The original ordering built both Rust halves before anything rendered, which would have put four large steps between you and the first visible post. The Gazette is coherent without the Operator — it is a narration channel that happens to also answer questions — so Phase D ships the readable half first and Phase E adds the phone. That ordering also means the cadence knobs get exercised against lived experience two phases earlier, which is the thing you actually asked for. The cost is one extra step: #step-12 splits the composer out of the card so the write path arrives with the Operator that serves it.

**If a phase still runs long,** the safe internal split points are after #step-2 (the ledger stands alone) and after #step-10 (the verb executor is independently testable). Do not split inside a step.

#### Step Status Ledger {#step-status-ledger}

| Step | Phase | Title | Status | Commit |
|---|---|---|---|---|
| #step-1 | A | Protocol: GAZETTE + GAZETTE_INPUT | done | `4fe4d3fcd` |
| #step-2 | A | Ledger: gazette_posts + FTS5 | done | `9a9051001` |
| #step-3 | A | Gazette AgentSpec + jobs | done | `6564ccb0b` |
| #step-4 | A | Pure Reporter wake core | done | `360ac963b` |
| #step-5 | B | Calibration harness | done | `361959fdd`, `b88ffe101` |
| #step-6 | C | Live Reporter bridge | done | `a597790b0` |
| #step-7 | D | Deck gazette-store (read path) | done | `046754c40` |
| #step-8 | D | Gazette card: transcript, toggle, menu | done | `c6a84c504` |
| #step-9 | D | Ref chip actions | done | `3531a5cc4` |
| #step-10 | E | Operator verb executor | done | `ae6d95e95` |
| #step-11 | E | Operator pipeline + GAZETTE_INPUT | done | `ae6d95e95` |
| #step-12 | E | The composer (store write path + card input) | done | `372465d3c` |
| #step-13 | F | App-test + doc rows | done | `e5297c3f1` |
| #step-14 | F | Integration checkpoint | done | verification only |

#### Corrections after Phase D {#post-d-corrections}

Five defects found by living with the channel rather than by reading it. Each is
fixed and pinned; they are recorded because three of them touch contracts Phases
E and F build on.

- **A registry-routed command needs a body in `action-dispatch.ts`.** ⌃⌘G and
  the menu row both did nothing: the chain handler in `deck-canvas.tsx` is a
  different tier, and `routing: "registry"` never consults it. The step-8 file
  table lists five files and omits `action-dispatch.ts` — **#step-12's composer
  command, if it is registry-routed, needs the same sixth edit.** A drift test
  now asserts every registry-routed command has a `registerAction`, derived from
  the source rather than a fixture.
- **[R01] had drifted where it mattered most.** The replay harness woke on every
  `turn_complete`; the bridge skips a turn that held no assistant work. On one
  session the harness reported three wakes against the bridge's one, so the
  cadence number the instrument exists to produce was wrong. The rule now lives
  in `reporter_wake.rs` as `counts_as_assistant_activity` and both callers gate
  on it. **Any new wake condition belongs in the shared core, never in one
  caller.**
- **The Reporter's editorial contract was retuned against real output.** Silence
  was open-ended and the rubric read as a list of coding subjects, so a session
  that answered a question and finished its turn went unreported. Silence is now
  bounded to two cases (empty window, or repeating the last post) and a turn-end
  summary is mandatory. The voice rule forbids classifying the work or defining
  it by what it was not — an earlier repair that said "post even when it isn't
  code" produced posts opening "Answered a physics question, not code:". Length
  is a budget (two or three sentences, 60 words) plus "the post is the summary,
  never the content": median post length went from 100-plus words to 44 with the
  cadence unchanged. **#step-14's acceptance reads against this wording, not the
  brief's original.**
- **`parse_envelope` recovers two model slips.** One level of `{"post": {"post":
  …}}`, and a self-correction — a bad envelope followed by "Let me fix that
  JSON:" and a good one, where the old outermost-span heuristic spanned both
  plus the prose between. Candidates are now every balanced top-level object,
  newest-first. Both were silently costing posts.
- **`gazette-replay --show-input`** prints the composed job input per wake. A
  silence cannot be diagnosed from the post that was not written.

Two observations left open, neither blocking: a post occasionally emits a ref
whose target is a bare basename (`sessions-section.tsx`) that survives
validation but would not resolve when clicked, and the manual checkpoints on
#step-6, #step-8, and #step-9 are the reader's to make.

#### Notes from Phase E {#post-e-notes}

- **`session.prompts` cannot return a prompt history, because the ledger does
  not keep one.** Table T01 names the `turns` table as its backing, but `turns`
  is the *pending* submission journal — a row is deleted the moment claude
  acknowledges it. The durable record of what someone asked is the session
  row's `last_user_prompt`, one prompt deep. The verb therefore returns that
  plus anything still in flight, and says so in a `note` field the answering
  model reads, so an answer that needed the full history says it could not
  confirm rather than guessing. Reaching the real history means reading
  claude's JSONL, which is not a read-only ledger verb and is not in this
  plan's scope.
- **#step-10 landed inside #step-11's commit.** The executor's only consumer is
  the pipeline, and an unused module is a hard error under `-D warnings`, so a
  standalone step-10 commit would have been red. Both ledger rows point at
  `ae6d95e95`.
- **The composer's submit is not a registry-routed command**, so the sixth-edit
  warning above does not apply to it: the Ask button and Cmd-Return call
  `gazetteStore.submitQuestion` directly. A future ⌘-chord for "ask the
  Gazette" would need the `action-dispatch.ts` body.

#### Notes from Phase F {#post-f-notes}

- **#step-13's doc rows were already paid.** `tuglaws/menus.md` and the
  `at0168-menu-structure.test.ts` fixture both took their Gazette row in
  #step-8, where the menu item itself landed — a menu row and its law row are
  one change, not two. What was left of #step-13 was the app-test.
- **The app-test needed a surface method the store did not have.**
  `_ingestGazetteFrameForTest` is module-scoped; an app-test reaches the deck
  only through `window.__tug`. So `publishGazettePost` joins `publishPulseFrame`
  on the test surface (SURFACE_VERSION 1.26.0) — a two-line delegate to the
  same seam, not a second ingestion path.
- **`just app-test` refreshes `tugdeck/dist`, never the app binary.** Everything
  in the card passed against a bundle whose tugcast predated the Operator, and
  only the composer's round trip failed — the frontend was current and the Rust
  was not. `just build-app` before the first app-test of a run that changed
  Rust; a rail that renders proves nothing about the feed behind it.
- **The pending placeholder is unobservable under the app-test gate**, so the
  test does not look for it. The gated pool fails the job without spawning, so
  the Operator's reply is broadcast in the same breath as the question — the
  window in which the placeholder stands is shorter than a poll. What it
  resolves *to* is asserted instead.

#### Step 1: Protocol — reclaim 0x70, add GAZETTE_INPUT {#step-1}

**Commit:** `tugcast-core(protocol): reclaim 0x70 as GAZETTE, add GAZETTE_INPUT 0x71`

**References:** [P01] transport, (#bridge-topology)

**Artifacts:** renamed `FeedId::GAZETTE`, new `FeedId::GAZETTE_INPUT`, TS mirror.

**Tasks:**
- [ ] In `tugrust/crates/tugcast-core/src/protocol.rs`: rename `TUG_FEED` → `GAZETTE` at the 0x70 const (retire the "reserved for Phase T3+" comment; document the channel), add `GAZETTE_INPUT = Self(0x71)`; update both `name()` arms (`"Gazette"`, `"GazetteInput"`) and the byte-value test.
- [ ] Mirror in `tugdeck/src/protocol.ts` (`TUG_FEED: 0x70` → `GAZETTE: 0x70`, add `GAZETTE_INPUT: 0x71`); fix any TS references to the old name.

**Tests:**
- [ ] Byte-value test asserts `GAZETTE == 0x70`, `GAZETTE_INPUT == 0x71`.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast-core`
- [ ] `cd tugdeck && bun run check`

---

#### Step 2: Ledger — gazette_posts table + reads {#step-2}

**Commit:** `tugcast(ledger): uncapped gazette_posts table with tail/search/window reads`

**References:** [P02] ledger table, [P13] FTS5 search, Spec S03, Table T01 (gazette verbs), (#p02-ledger-table, #p13-fts5)

**Artifacts:** `gazette_posts` DDL in the `bootstrap_schema` `execute_batch` (columns: `id` PK autoincrement, `at_ms`, `author`, `session_id` NULLable, `wake_reason` NULLable, `body`, `refs` JSON text); the FTS5 external-content virtual table + sync triggers ([P13]); `GazettePostRow`; `record_gazette_post`, `list_gazette_posts_tail(limit)` (newest-limit oldest-first, the `list_pulse_lines_tail` shape), `search_gazette_posts(query, filters, limit)`, `gazette_posts_window(id, n)`; index on `session_id`. Also the two file-event reads (`list_file_events_for_session`, `list_file_events_for_path_pattern`) T01 needs.

**Tasks:**
- [ ] **FTS5 availability spike first** — one test asserting `CREATE VIRTUAL TABLE … USING fts5(...)` succeeds on a `ledger_db::open` connection. If it fails, stop and fall back to `LIKE`, revising [P13].
- [ ] DDL next to `pulse_lines` in `session_ledger.rs`, with the same deliberate-no-cascade comment posture; **no cap** and no pruning anywhere.
- [ ] **Comment the drift-guard exemption at the DDL** ([P02]): `gazette_posts` is permanent history and is never passed to `rebuild_table_if_schema_drifted` — a future column goes through an ALTER-based `migrate_gazette_posts_add_*`, following `migrate_pulse_lines_add_intent`. Note in the same comment that the FTS5 shadow tables *are* derived and may be rebuilt freely.
- [ ] Author enforcement in Rust (`reporter|operator|user`), refs serialized like `pulse_lines.scopes`.
- [ ] `search_gazette_posts`: FTS5 `MATCH` over `body` + `refs`, `bm25()` ordering, `snippet()` excerpts, with the optional `author`/`session_id`/`at_ms` filters applied against the content table.

**Tests:**
- [ ] FTS5 availability (the spike, kept as a permanent test).
- [ ] Round-trip, tail ordering, window bounds, survival of a `sessions` row DELETE (no cascade).
- [ ] Search: multi-term relevance ordering beats insertion order; the triggers keep the index in sync across insert; filters compose with `MATCH`.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast session_ledger`

---

#### Step 3: Gazette AgentSpec + job table {#step-3}

**Commit:** `tugcast(gazette-agent): Sonnet gazette AgentSpec with reporter-post and operator jobs`

**References:** [P03] agent spec, [P05] knobs, Spec S01, Spec S02, Table T02, (#p03-agent-spec)

**Artifacts:** `feeds/gazette_agent.rs` with `GAZETTE_DOMAIN = "dev.tugtool.gazette"`, knob key consts (Table T02), `GAZETTE_AGENT_JOBS` (three `JobSpec`s with the S01/S02 instruction strings — the rubric text carries the brief's bullet list verbatim), and pool construction in `main.rs` beside `haiku_agent` (model closure per the `scribe_model` pattern, `max_workers` knob).

**Tasks:**
- [ ] Job instructions demand pure-JSON output and state "post nothing" / round-cap contracts explicitly.
- [ ] `main.rs`: build `gazette_agent: Arc<SharedAgentPool>`; hold it for Steps 6/8 (no consumers yet — construction spawns nothing, per the pool's lazy contract).

**Tests:**
- [ ] A table test pinning job names/timeouts and that instructions contain the load-bearing contract strings (the `the_haiku_job_table_carries_every_contract…` pattern).

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast gazette_agent`

---

#### Step 4: Pure Reporter wake core {#step-4}

**Commit:** `tugcast(reporter): pure wake core — buffers, wake reasons, envelope parse`

**Depends on:** #step-3

**References:** [P04] wake core, [P06] envelope, Table T03, Spec S01, Risk R02, (#p04-wake-core)

**Artifacts:** `feeds/reporter_wake.rs`: `FrameBuffer` (frame/byte caps + elision marker), `WakeReason` (wire strings per T03), `compose_reporter_input(reason, session_id, frames, last_k_posts)`, `ReporterEnvelope`/`GazetteRef` strict serde parse, `validate_refs(envelope, buffered_context) -> (kept, dropped)`.

**Tasks:**
- [ ] The tap classifier (allowlist + replay-mute set) as a pure function modeled on `pulse.rs::forwardable_session`, with the Reporter's own starting allowlist ([Q02]): the `PULSE_FORWARD_ALLOWLIST` set plus `turn_complete` usage retention; user submissions enter the buffer through a separate push path (they arrive off the submission channel, not CODE_OUTPUT).

**Tests:**
- [ ] Idle session (empty buffer) yields no sitrep wake; caps drop oldest with marker; malformed envelopes parse to no-post; ref validation drops absent targets and exempts `session` kinds; mute brackets track exactly as pulse's classifier test does.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast reporter_wake`

---

#### Step 5: Calibration harness {#step-5}

**Commit:** `tugcast(gazette-replay): offline transcript-replay calibration harness`

**Depends on:** #step-3, #step-4

**References:** [P09] harness, [P05] knobs, Risk R01, (#p09-harness, #success-criteria)

**Artifacts:** `feeds/gazette_replay.rs` (a module in the bin crate), a `gazette-replay` subcommand arm in `cli.rs` + `main()`, and a `justfile` recipe `gazette-replay JSONL *FLAGS`.

**Tasks:**
- [x] Add the subcommand to the existing clap surface in `cli.rs` and dispatch it at the top of `main()` — **before any listener binds or ledger writer is claimed**, so a replay never contends with a live tugcast — then return.
- [x] Read a session JSONL, map records to the frame shapes the tap classifier reads, simulate time from record timestamps, segment into wake windows via the wake core, call `pool.run("reporter-post", …)` per window (real `ClaudeAgentWorkerSpawner`), render a markdown gazette: per-wake reason, buffer stats, post-or-silence, refs kept/dropped.
- [x] Flags: `--sitrep-secs`, `--last-k`, `--model`, `--max-frames`, `--no-model`; defaults from Table T02. `--token-wake-tokens` added alongside them, since the threshold is a knob the sweep should be able to move.
- [x] **Sweep the cadence rather than validating one value.** Run each spike session at `--sitrep-secs` 90, 120, and 180 and read all three gazettes side by side. The spike's 240s produced one post per ~5–7 minutes of active work, which the user judged too slow; 180 is the shipped default and ~120 is where "every two to three minutes" lives. Reading three is the only way to answer a question that is genuinely about feel — set the shipped default from what reads best, not from this plan's guess.
- [x] Fold allowlist conclusions into Step 6 ([Q02]); adjust the rubric wording if the sweep shows the model posting on the wrong moments rather than at the wrong rate (those are different failures and want different fixes).

**Tests:**
- [x] Segmentation-only mode (`--no-model`) unit-testable: wake windows over a fixture JSONL are deterministic.

**Checkpoint:**
- [x] `cd tugrust && cargo build -p tugcast` (the subcommand builds; a real run is manual and costs tokens)
- [x] `just gazette-replay <a real jsonl>` produces a readable gazette (manual read), at all three sweep values

##### What the sweep found {#step-5-findings}

One session, `038ba4cc`, 2h28m of continuous work, 806 frames, run whole at each cadence.

| `--sitrep-secs` | wakes | turn-end | sitrep | posted | chose silence | unparseable | one post per |
|---|---|---|---|---|---|---|---|
| 90 | 64 | 16 | 48 | 47 | 16 | 1 | **3m09s** |
| 120 | 52 | 16 | 36 | 30 | 22 | 0 | **4m56s** |
| 180 | 40 | 16 | 24 | 12 | 25 | 3 | **12m22s** |

**Cadence set: 90 seconds** ([P05], Table T02). Read side by side, 180 gave a channel to skim later and 90 gave one that tells you what is happening; 47 posts across 2h28m of real work is the volume that reads right. 75 is the next value to try if this proves too quiet — no code change is involved, since `--sitrep-secs` reads any candidate against a real transcript and the tugbank knob turns live.

**F1 — The envelope contract was losing good posts, and the loss looked like editorial silence.** The first 120s run posted **zero** times out of 52. Every one of those 52 answers held a complete, well-formed envelope behind a sentence of the model's own preamble, and strict whole-string parsing discarded all of them. Two fixes landed: the harness now counts *unparseable* apart from *chose silence* (a run that merges them reports a broken contract as good judgment — the same distinction [P14] makes for job failures), and `parse_envelope` now locates the outermost `{…}` span rather than requiring the envelope to be the entire answer. That is finding the envelope, not repairing one: the JSON parsed is still the model's own, still whole, still `deny_unknown_fields`. Preamble rate on this corpus was roughly four in ten. **This invalidates [P06] as written** — its "malformed output is silence" holds, but "the whole answer must be the envelope" does not survive contact with the model.

**F2 — Residual unparseables are genuinely malformed and correctly silent.** The 1-in-64 and 3-in-40 that remain are unescaped double quotes inside the `body` string. No repair is possible without inventing the author's intent, so silence is right. ~4% is the floor.

**F3 — A single run is not a measurement.** The same transcript at 180s posted 27 of 40 in one run and 12 of 40 in the next, same config. The post/no-post decision is noisy at the per-wake level, so the shipped default should be read off the *feel* of the three gazettes rather than off one run's rate.

**F4 — Turn-end wakes are cadence-independent, and some of them are free of content.** 16 turn-end wakes in every run — the knob only moves the other half. Some are two-frame windows from a local command (`/model`, `/compact`) that opens and closes a turn with no assistant activity in it, costing a model call to be told nothing happened. **Step 6 should skip a turn-end wake whose window holds no assistant activity**; the harness deliberately does not, because encoding a bridge policy here would create exactly the drift Risk R01 warns about.

**F5 — Refs are dropped when the model writes an absolute path.** Frames carry whatever a tool's input carried, so a post citing `/Users/…/tugdeck/src/lib/font-metrics.ts` fails the verbatim check against a window holding the repo-relative form. Drops were visible in 1, 10, and 5 posts across the three runs. Worth a wording pass in Step 6 (tell the Reporter to copy the path *as the frame spells it*) before reaching for looser matching, which would reintroduce the dead-chip risk [R02] exists to prevent.

**F6 — The allowlist needs no change ([Q02] closes).** No frame type in `REPORTER_FORWARD_ALLOWLIST` proved to be noise, and no post wanted evidence the allowlist withheld. The streaming-only types (`tool_input_progress`, `api_retry`, `wake_started`) are absent from transcripts and so untested by replay; they stay on the list on the Pulse precedent.

---

#### Step 6: Live Reporter bridge {#step-6}

**Commit:** `tugcast(reporter): live GAZETTE bridge — tap, sitrep wakes, ledger + broadcast`

**Depends on:** #step-2, #step-5

**References:** [P04], [P05], [P06], [P12] isolation, [P14] failed-wake re-merge, Table T02, Table T03, Spec S03, [Q02] resolution, (#bridge-topology)

**Artifacts:** `feeds/reporter.rs` `ReporterBridge` implementing `StreamFeed` (id `GAZETTE`, capacity 64); `main.rs` wiring (knob closures over `bank_client`, `register_stream_feed`, submission-channel tap mirroring `SessionOverviewConfig`); CONTROL verb `"list_gazette_posts"` + `do_list_gazette_posts` in `agent_supervisor.rs`.

**Tasks:**
- [x] Tap loop: subscribe `code_tx` in-task; classify/mute; push to buffers; arm per-session sitrep deadlines (`tokio::select!` over a computed next-deadline, the timer only armed while a buffer is non-empty); session-end wake off session-state frames; token-threshold wake off usage when the knob is non-zero. **Correction found in the wiring:** a live `turn_complete` carries no usage at all — `tugcode/src/types.ts` populates its telemetry only on the replay path — so the meter reads `cost_update`, the one live frame that carries the four-token shape. It is read for the counter and never buffered: a threshold reading is not something to write a post about, and adding it to the allowlist would have changed a surface [Q02] just closed.
- [x] Wake path: snapshot+clear buffer, fetch last-K posts for the session (`list` read filtered by session), spawn a task: `run("reporter-post")` → parse ([P06]) → validate refs (R02) → `record_gazette_post` → broadcast S03 frame. Disabled knob drops frames and never wakes (the `pulse_enabled` posture).
- [x] **On job `Err`, re-merge the snapshot to the front of the session's buffer** subject to the [P04] caps, and log it as a distinct warn from an editorial no-post ([P14]) — an infrastructure failure must not read as the model choosing silence.
- [x] **Skip a turn-end wake whose window holds no assistant activity** ([F4](#step-5-findings)). A local command (`/model`, `/compact`) opens and closes a turn with nothing in it, and waking there spends a model call to be told nothing happened. The harness deliberately does not do this — a bridge policy encoded there would be exactly the drift Risk R01 exists to prevent — so it lands here, with a test for the empty turn.
- [x] **Tell the Reporter to copy a path as the frame spells it** ([F5](#step-5-findings)). Refs citing absolute paths fail the verbatim check against windows holding the repo-relative form; a wording pass is the fix, not looser matching, which would put back the dead chips [R02] exists to prevent.
- [x] The allowlist is already final ([Q02] resolved by the sweep) — carry `REPORTER_FORWARD_ALLOWLIST` across unchanged rather than re-deriving it.

**Tests:**
- [x] Tokio tests with a scripted pool (the `FakeSpawner` pattern from `shared_agent.rs::test_support`): allowlisted frame → wake → post persisted + broadcast; replay-bracketed frames produce nothing; a `GAZETTE` frame never enters the buffer ([P12]); disabled knob spawns/wakes nothing; `list_gazette_posts` CONTROL verb answers the tail.
- [x] A failing pool re-merges: script `Err`, wake, assert the frames are still buffered and reach the *next* wake's composed input ([P14]).

**Checkpoint:**
- [x] `cd tugrust && cargo nextest run -p tugcast reporter`
- [ ] Manual: run a dash-build tugcast, do real session work, watch `GAZETTE` frames arrive (dev log / `websocat`)

---

#### Step 7: Deck gazette-store — the read path {#step-7}

**Commit:** `tugdeck(gazette): GazetteStore — CONTROL tail and live fold`

**Depends on:** #step-1, #step-6

**References:** [P11] gazette store, [P05] knobs (`card_rows`), Spec S03, **[L27]** resource release, (#state-zone-mapping)

**Artifacts:** `tugdeck/src/lib/gazette-store.ts`; `tugdeck/src/__tests__/gazette-store.test.ts` (the deck's test home — beside the existing `feed-store.test.ts`); `lib/gazette-types.ts` if types don't fit in `protocol.ts`.

> **Read path only.** `submitQuestion` and the pending-question machinery land in #step-12, once there is an Operator to answer. Everything here is the narration channel: tail, fold, window, dispose.

**Tasks:**
- [x] Model on `lib/pulse-store.ts`: singleton, connect hook, CONTROL `list_gazette_posts` on mount, `conn.onFrame(FeedId.GAZETTE, …)` fold, render-window cap from the `dev.tugtool.gazette`/`card_rows` default via the DEFAULTS feed, `useSyncExternalStore` hook, test-only frame-injection seam.
- [x] **[L27]: every acquisition captures its release.** The store acquires the `conn.onFrame` registration and the DEFAULTS-feed watch (the pending timeout joins them in #step-12); each unregister closure is stored and invoked in `dispose()`. `pulse-store.ts` captures its `onFrame` return for exactly this reason. A `_disposed` guard is not a substitute for unwiring, and there is no acceptable number of leaked callbacks.

**Tests:**
- [x] Fold/ordering/cap; tail-then-live merge without duplicates (dedupe by ledger `id`).
- [x] `dispose()` releases both registrations — assert the connection has no live callback afterwards, not merely that a stale one no-ops.

**Checkpoint:**
- [x] `cd tugdeck && bun test gazette-store && bun run check`

---

#### Step 8: Gazette card — transcript, toggle, menu {#step-8}

**Commit:** `tugdeck(gazette): sidebar Gazette card; ⌃⌘G toggle; Show Gazette menu row`

**Depends on:** #step-7

**References:** [P10] card and chord grant, [Q01] names and chord, Spec S03, **[L12]** selection boundary, **[L16]/[L19]/[L20]** component contract, **[L30]** command funnels, (#state-zone-mapping, #p10-card)

**Artifacts:** `lib/gazette-card-id.ts`, `components/gazette/gazette-card-registration.tsx`, `gazette-card.tsx` + `gazette-card.css`. Command surface — **five files, named exactly** (the sidebar toggles do *not* live in `action-dispatch.ts`):

| File | Edit |
|---|---|
| `components/tugways/action-vocabulary.ts` | `TOGGLE_GAZETTE: "toggle-gazette"` **and** its payload doc block (the file documents each action above the id table) |
| `components/tugways/command-registry.ts` | the entry: `routing: "registry"`, `menuItemId: "maker.gazette"`, `chord({ key: "KeyG", ctrl: true, meta: true, label: "g" }, { preventDefault: true, menuEligible: true })` |
| `components/chrome/deck-canvas.tsx` | the handler `store.toggleSidebarPane(GAZETTE_CARD_ID)` beside `TOGGLE_JOTS`'s, **and** the action id added to that file's registered-action list |
| `components/tugways/__tests__/command-routing-drift.test.ts` | the `["⌃⌘G", TUG_ACTIONS.TOGGLE_GAZETTE]` row |
| `tugapp/Sources/AppDelegate.swift` | the "Show Gazette" row mirroring "Show Jots" (`identified("maker.gazette")`, `keyEquivalent: ""` — the chord is applied from the registry) |

**Tasks:**
- [x] Registration is the `registerJotsCard()` shape verbatim ([P10]); called unconditionally in `main.tsx` boot before layout restore (copy the INVARIANT comment).
- [x] Card UI: post rows oldest-first autoscrolled to newest — author icon (lucide `newspaper` for the Reporter; the `operator` glyph via `TugSpriteIcon`/`operatorIconNode` from `components/tugways/tug-icons.tsx`; the Session card's user icon), timestamp, body, ref chips (render-only this step), readable at rail width (min 320).
- [x] **[L12]: register the transcript content area as a selection boundary** so `SelectionGuard` clamps selection to the card. A scrolling transcript is the exact shape this law exists for. **Correction found in the wiring:** the card already has one. `CardHost` calls `useSelectionBoundary(cardId, …)` on the card-host div for every registered card, deliberately one entry per card rather than per pane; `registerBoundary` is keyed by card id, so a second call from inside the card would *replace* the host's rather than add to it. The transcript takes the boundary it is already inside, and the hook's own docstring says card authors never call it directly.
- [x] **[L19]/[L16]/[L20]: honor the component contract, not just the visual.** Module docstring, exported props interface, `data-slot`, `@tug-pairings`, and `@tug-renders-on` on every rule that sets `color`/`fill`/`border-color` without a `background-color` — `audit-tokens lint` fails otherwise. Gazette-scoped `--tugx-*` tokens resolve to `--tug7-*` in one hop and never reach into a composed child's tokens.
- [x] **Reserve the composer's row in the card's grid now, and leave it empty.** The composer lands in #step-12; a layout that grows a row later would shift the transcript under the reader. Reserving costs one grid track and makes #step-12 a drop-in.
- [x] Update the `at0168-menu-structure.test.ts` fixture and the `tuglaws/menus.md` table for the new menu row.
- [x] Cross-check tuglaws (`tuglaws.md`, `pane-model.md`, `component-authoring.md`, `commands.md`, `chord-tiers.md`); name the laws in the commit body.

**Tests:**
- [x] Registration test rows (the card-registry drift tests pick up the new sidebar automatically — verify `layout-tree.test.ts` / `card-registry.test.ts` expectations).
- [x] The chord-routing drift table passes with the new row.

**Checkpoint:**
- [x] `cd tugdeck && bun test && bun run check && bun run audit:tokens && bunx vite build`
- [ ] Manual in the running app: ⌃⌘G toggles the rail; the Layouts section shows a "Gazette" side control with no section edits; **the Reporter posts from #step-6 render live in the rail.** This is the Phase D payoff — from here the cadence knobs turn against lived experience rather than replayed transcripts.

---

#### Step 9: Ref chip actions {#step-9}

**Commit:** `tugdeck(gazette): ref chips act — raise session, open file, show commit`

**Depends on:** #step-8

**References:** Spec S03, [P10], (#verb-table)

**Artifacts:** chip click handlers in `gazette-card.tsx`.

**Tasks:**
- [x] `session` → raise/focus the bound Session card via the store's activation path (`transferFocusForActivation` — the real z-raise); a session with no live card renders the chip inert with a title tooltip.
- [x] `file`, `plan`, `brief` → open the path in the file-viewing card via the existing parameterized `show-card`/file-open dispatch (reuse, never a new mechanism).
- [x] `commit` → open the commit's diff via the existing `GIT_DIFF_QUERY` commit flavor (`sha` field) surface.

**Tests:**
- [x] Dispatch-level unit tests (command payloads), not fake-DOM renders.

**Checkpoint:**
- [x] `cd tugdeck && bun test && bunx vite build`
- [ ] Manual: chip clicks in the app — a file chip opens its card, a commit chip its diff, a session chip raises the session.

---

#### Step 10: Operator verb executor {#step-10}

**Commit:** `tugcast(operator): read-only verb executor with caps`

**Depends on:** #step-2

**References:** [P07] verbs, [Q03] git cwd, Table T01, (#verb-table)

**Artifacts:** `feeds/operator.rs`: `run_verb(ctx, name, args) -> Result<serde_json::Value, String>` for all nine T01 verbs; `OperatorContext { ledger, bootstrap_project_dir }`.

**Tasks:**
- [ ] Ledger verbs over #step-2's reads; git verbs via `tokio::process::Command` with arg allowlisting (never shell interpolation; `--` path separators; reject flag-shaped user args), output caps per T01, 10s timeout each.
- [ ] Unknown verb / malformed args → an error value packed into results (the model sees its mistake), never a crash.

**Tests:**
- [ ] Per-verb cap tests against a seeded in-memory ledger + a fixture git repo (tempdir, real `git` — the crate's git feed tests' pattern); injection attempts (a `-S` payload, a `--upload-pack` path) are rejected.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast operator`

---

#### Step 11: Operator pipeline + GAZETTE_INPUT {#step-11}

**Commit:** `tugcast(operator): GAZETTE_INPUT adapter and two-round retrieve/answer pipeline`

**Depends on:** #step-3, #step-6, #step-10

**References:** [P07], [P08] user echo, Spec S02, Spec S03, (#bridge-topology)

**Artifacts:** `main.rs` `register_input(FeedId::GAZETTE_INPUT, …)` + adapter task (the `USAGE_QUERY` adapter shape: mpsc in, per-request `tokio::spawn`); pipeline in `feeds/operator.rs`.

**Tasks:**
- [ ] **Construct the adapter after #step-6's `register_stream_feed` call** — that call's *return value* is the only source of the GAZETTE `broadcast::Sender`, so the ordering is forced. Follow the existing `let pulse_tx = feed_router.register_stream_feed(…)` → session-overview-block shape in `main.rs`.
- [ ] Adapter: parse `{body, request_id}`; persist + broadcast the `user` post first ([P08]); then pipeline: scrollback = last 20 posts from the ledger → `operator-retrieve` → execute verbs (≤6) → `operator-answer` → optional one follow-up round → forced final answer; persist + broadcast the `operator` post with `request_id` echoed.
- [ ] Failure at any stage → transient (`transient: true`, unpersisted) operator post carrying the `request_id` ([P08]).

**Tests:**
- [ ] Scripted-pool tokio tests: happy path (one round), follow-up path (two rounds), round-cap enforcement (a model that always asks for more verbs still yields an answer), pool-unavailable → transient post not in the ledger, user post persisted before any model call.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast operator`
- [ ] Manual: send a `GAZETTE_INPUT` frame by hand (`websocat`) and read the answer post off the wire — the card's composer arrives in #step-12.

---

#### Step 12: The composer — store write path + card input {#step-12}

**Depends on:** #step-8, #step-11

**Commit:** `tugdeck(gazette): composer — ask the Operator from the card`

**References:** [P08] user echo, [P11] gazette store, **[L26]** mount identity, **[L11]** responders, Spec S03, (#state-zone-mapping)

**Artifacts:** the write path added to `lib/gazette-store.ts`; the composer added to `gazette-card.tsx` in the grid row #step-8 reserved.

> This is the step that turns the Gazette from a channel you read into one you can ask. It is deliberately last among the feature steps: everything before it is useful standing alone, and this is the only piece that needs both halves (deck and Operator) to exist.

**Tasks:**
- [ ] `submitQuestion(body)`: mint a `request_id`, send a `GAZETTE_INPUT` frame, track pending until a matching `request_id` post (or a timeout) clears it; transient posts render but never enter the persisted-window array.
- [ ] **[L27]:** the pending-question timeout is a third acquisition — capture and release it in `dispose()` alongside the two from #step-7.
- [ ] **[L26]: key post rows by `request_id`, not ledger `id`.** Transient posts carry no `id` ([P08]), and a pending row that resolves into a persisted answer is logically the *same* row to the reader — so the key must be stable across that swap or React tears down and rebuilds it. Dedupe on `id` where present; key on `request_id`.
- [ ] Composer: compose `TugMessageEditor` (clipboard/undo responders ride the substrate for free per its module doc — [L11]) + a submit affordance calling `gazetteStore.submitQuestion`; pending state renders a placeholder row.

**Tests:**
- [ ] Pending lifecycle incl. transient clear; `dispose()` now releases all three registrations.

**Checkpoint:**
- [ ] `cd tugdeck && bun test && bun run check && bun run audit:tokens && bunx vite build`
- [ ] Manual: type the brief's worked-example question into the card and get a grounded answer post.

---

#### Step 13: App-test + doc rows {#step-13}

**Commit:** `tests(gazette): app-test for the Gazette card; menus law row`

**Depends on:** #step-9, #step-12

**References:** [P10], [P11], (#test-plan-concepts)

**Artifacts:** `tests/app-test/at0xxx-gazette-card.test.ts` with `@covers` lines naming `tugdeck/src/components/gazette/*` and `tugdeck/src/lib/gazette-store.ts`.

**Tasks:**
- [x] App-test: toggle the rail (⌃⌘G and menu), inject posts through the store's test seam, assert rows + icons + chips render, type into the composer and submit — the app-test-gated pool yields the transient degraded post, which is itself the assertion that the round trip ran.
- [x] `just app-test-covers-check` passes; run `just app-test-changed`.

**Tests:** the app-test itself.

**Checkpoint:**
- [x] `just app-test-covers-check`
- [x] `just app-test-changed`

---

#### Step 14: Integration Checkpoint {#step-14}

**Depends on:** #step-6, #step-11, #step-13

**Commit:** `N/A (verification only)`

**References:** (#success-criteria, #exit-criteria)

**Tasks:**
- [x] Walk every success criterion in (#success-criteria) against the built app: live Reporter posts during real work at the 90s default; the worked-example Operator question; knob turns (`sitrep_secs`, `card_rows`) taking effect without restart.

**Tests:**
- [x] `cd tugrust && cargo nextest run` (workspace)
- [x] `cd tugdeck && bun test && bun run check && bunx vite build`

**Checkpoint:**
- [x] All of the above green; manual acceptance noted in the session.

**What the walk found** (#post-f-notes carries the incidental findings):

| Criterion | How it was read |
|---|---|
| Harness output read at 90/120/180 | Phase B; the 90s default was chosen from the three readings, not from this plan's guess. |
| Live Reporter posts carrying `session_id` and validated refs | Observed in the debug build during Phase D/E; `r02` validation test green. |
| Worked-example Operator answer within two rounds | Answered in the live build at the close of Phase E, after `fd7964c2f` — the retrieval slip that was costing every answer. |
| Sidebar registration with **no** Layouts-section change | `layouts-section.tsx` walks `getAllRegistrations()` for `layoutRole: "sidebar"`; the dash's diff against `main` touches no file under `components/lens/`. |
| Idle → zero wakes; replay flood → zero posts | `an_idle_session_never_wakes`, `an_idle_session_leaves_an_empty_buffer`, `replay_bracketed_frames_produce_nothing`, `replay_brackets_mute_one_session_without_blocking_others`. |
| Suites green | 2097 Rust tests (the `git_head_roundtrip` contention flake passes 7/7 alone); 6064 deck tests; `check`, `audit:tokens lint`, `vite build`; `at0365` plus the four tests the test-surface change selects. |

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** The Gazette ships end-to-end — Reporter narration with tunable cadence, Operator answers over ground-truth ledgers, and a sidebar Gazette card — plus the calibration harness that tunes it.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [x] All Step Status Ledger rows `done` with commits recorded.
- [x] Success criteria in (#success-criteria) hold (harness output read; live posts observed; worked example answered; knobs turn live).
- [x] No isolation regression: the [P12] tests pin no-feedback-loop and no-write-toward-sessions.

**Acceptance tests:**
- [x] `cd tugrust && cargo nextest run` green (warnings are errors).
- [x] `cd tugdeck && bun test && bun run check && bun run audit:tokens && bunx vite build` green.
- [x] `just app-test-changed` green.
- [x] No [L27] leak: `GazetteStore.dispose()` releases the frame callback, the DEFAULTS watch, and the pending timeout.

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] Operator answer-quality corpus + scoring harness (the plan/execute/answer shape was chosen partly to enable this).
- [ ] Cross-session digest posts; richer chip targets (History-card deep links); gazette export.
- [ ] Rubric/prompt tuning rounds from lived-in cadence experience (knobs exist; wording changes are code).

| Checkpoint | Verification |
|------------|--------------|
| Protocol bytes | `cargo nextest run -p tugcast-core` byte tests |
| Reporter pleasant to live with | `just gazette-replay` on real JSONL + a week of live use with the knobs |
| Operator grounded | worked-example question; refs resolve; `gazette prose locates, ledgers confirm` honored in answers |
