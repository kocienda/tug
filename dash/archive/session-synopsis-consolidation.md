# Session synopsis consolidation — one ask, one sentence {#session-synopsis-consolidation}

**Purpose:** The session-description pipeline becomes what a fresh design would build: one SharedAgent ask producing the one sentence users actually see — the description line on every session row — with the vestigial headline half deleted rather than renamed. The pulse-side "overview" vocabulary ceases to exist, which dissolves the grep collision the narration-channel rename (`189564171`) left behind without coining a new word.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-08-17 |

---

### Review Record {#review-record}

<!-- Appended by /tugplug:plan-review; one paragraph per round, never rewritten. -->

**Round 1 — 2026-08-17, fable.** Reviewed `plan:22e1aea912b276a5`. Lint: 0 errors, 0 warnings.
Oriented on: the whole document (first round), against `session_overview.rs`, `shared_agent.rs`, `session_ledger.rs`, `actions.rs`, `agent_supervisor.rs`, the deck chain, and `tests/model-eval/`.
Applied: sequencing — Step 1 as written deleted `headline_register_report` and `EMIT_FLOOR` while `shared_agent.rs`'s `request_summary` and its timeout asserts still referenced them, so the workspace would not have compiled between Steps 1 and 3; the register fn now survives Step 1 pub with its path updated and dies in Step 3 with its last caller, and the asserts retune to the now-`pub` `SYNOPSIS_MIN_INTERVAL` in Step 1 (both recorded as explicit cross-file-coupling tasks). Technical choice — the trigger spec carried the headline's burst/idle cadence forward, but under the 60s debounce `IDLE_PERIOD` (20s, ≥1 beat) is always already satisfied when a window opens, making the thresholds vacuous; [P02]/S01 simplified to derived due-ness (`new_beats > 0` or a pending settle refresh, no new flag), `Cadence` reduced to an injectable `Clocks {min_interval, settle_after}`, and `fire_asap` moved to the delete list. Migration hazard — S03 promised removing the stale `pulse-overview` key, but the `carry_legacy_defaults_forward` template is copy-only and no delete path is established; softened to copy-only with the orphan named in the docblock. Completeness — `score.py` added to Step 5's task list. Tuglaws: deck work is pure deletion, no new state ([L02] unaffected, State Zone Mapping records the empty set); [D132]'s rewrite is Step 6's subject; the banned test shapes are absent.
Deferred: nothing — [Q01] (the PULSE gate) was asked and decided during authoring ([P04]).

---

### Phase Overview {#phase-overview}

#### Context {#context}

`tugrust/crates/tugcast/src/feeds/session_overview.rs` (6,686 lines) runs **two** SharedAgent asks. The frequent `summarize` ask (cadence: `BURST_BEATS` 8 / `IDLE_PERIOD` 20s / `EMIT_FLOOR` 8s) produces a per-stretch **headline** whose every output is dead: the PULSE `kind:"overview"` frame folds into `tugdeck/src/lib/pulse-store.ts` maps with **zero** `.tsx` readers; the `pulse_overviews` ledger table exists solely to restore into those dead maps via `list_pulse_lines_ok`'s `overviews` array; and the deck's `SharedAgentTenant` type over `PULSE_OVERVIEW_KEY` has zero consumers outside its own file. The renderers died in two landed plans — `dash/archive/session-identity.md` [P06] replaced the Lens's headline line with the description, and [D132] retired the Z2 `SessionPulseStrip` — and nobody swept the feed.

The headline's only *live* functions today are structural accidents: (a) its emit completion is what triggers `take_synopsis_job` ("the description rides the emit's CADENCE"), and (b) `state.last_headline` is one parameter of `compose_synopsis_digest`. The once-a-minute `synopsis` ask (`SYNOPSIS_MIN_INTERVAL` 60s) writes the sessions-ledger `synopsis` column, is pushed via `session_updated`, read by `tugdeck/src/lib/session-synopsis-store.ts`, and rendered as the description line — the subsystem's one visible product. The consolidation makes the synopsis ride the activity machinery directly and deletes everything that existed only to produce or carry the invisible sentence.

#### Strategy {#strategy}

- **Backend first, deck second.** The emitter stops producing `kind:"overview"` frames before the deck's parse for them is deleted — the reverse order would fold in-flight overview frames as beat lines (the deck's `parsePulseFrame` treats an absent `kind` as a beat).
- **Rewire before deleting.** The synopsis trigger and digest are rewired inside the same step that deletes the headline path, so the module never has a beat where the description has no trigger. `-D warnings` then enumerates every orphaned symbol.
- **Delete, don't rename, the dead deck chain.** Zero consumers means removal, not preservation ([[feedback: unchecked registry → delete it]] is the standing doctrine).
- **Storage drops rather than migrates.** `pulse_overviews` is a latest-per-scope *cache* whose restore consumer is being deleted; a drop migration replaces the rename the observer commit needed for permanent history.
- **The eval retargets at the sentence users read.** `just model-eval` was the headline's quality harness; it becomes the synopsis's, which makes it more valuable, not less.
- **Preserve visible behavior except where named.** The description updates on the same occasions it does today. Exactly two deliberate deltas, both decided in this plan: the PULSE kill switch stops gating the description ([P04]), and the settle refresh becomes reliable instead of best-effort ([P02]).

#### Success Criteria (Measurable) {#success-criteria}

- Exactly one SharedAgent job serves the session description: `rg -n '"summarize"|"summarize_done"' tugrust/crates` returns nothing; `HAIKU_AGENT_JOBS` carries `synopsis` and no summarize entries. (grep + `cargo nextest run`)
- The vestige gate passes: the greps in Spec S06 return only the blessed survivors (the drop migration and the defaults carry-forward, each with a deletable-when docblock). (Spec S06 commands)
- Every symbol in Table T01's "delete" rows has zero remaining references outside `dash/`. (`rg` per symbol)
- The trigger preserves the update occasions: paused-time unit tests pin (a) sustained activity marks a session due and the ask fires when the 60s debounce opens, (b) a settled session gets exactly one refresh per stretch, (c) a due-but-debounced session **defers** rather than being swallowed. (`cargo nextest run -p tugcast session_synopsis`)
- A ledger holding a populated `pulse_overviews` table opens clean, the table and its trigger are gone afterward, and a second open is a no-op. (migration unit test)
- `cd tugrust && cargo nextest run` green; `cd tugdeck && bunx vite build` and `bun test` green; `just app-test-changed` green (with `just build-app` first — the app bundle does not rebuild itself).

#### Scope {#scope}

1. `feeds/session_overview.rs` → `feeds/session_synopsis.rs`: the synopsis becomes the module's only model ask; the headline emit path, reask, collapse ask, PULSE output, and ledger cache write are deleted.
2. `session_ledger.rs`: the `pulse_overviews` table, trigger, row type, and verbs are dropped via an idempotent named migration; `feeds/agent_supervisor.rs` stops assembling the `overviews` array.
3. `shared_agent.rs` + `actions.rs`: the `summarize`/`summarize_done` jobs, `request_summary`, and their socket verbs die; a `shared_agent_synopsis` verb replaces them for the eval; the tenant key renames `pulse-overview` → `synopsis` with a one-shot carry-forward.
4. The deck: the dead pulse-overview chain in `protocol.ts`, `action-dispatch.ts`, `pulse-store.ts` (+ its tests), `shared-agent-store.ts`, and `tugcode/src/pulse/types.ts` is deleted.
5. `tests/model-eval/`: retargeted at the synopsis; the retrospective lane retires.
6. `tuglaws/design-decisions.md`, `tests/app-test/at0280-shared-agent-absent.test.ts` prose, and small stragglers.

#### Non-goals (Explicitly out of scope) {#non-goals}

- The narration channel's Overview/Observer names — untouched. After this plan, a bare grep for "overview" returns only that subject.
- The beat/commentator machinery — `feeds/pulse.rs`, tugcode's pulse emitters, `PulseLineEntry`, the dwell queue, the recent-pulses popover. Only the `kind:"overview"` discriminant dies.
- `session-synopsis-store.ts`, the [D132] description ladder, and every renderer of the description — the living half keeps its names and its behavior.
- Any change to what the description *says* or its visible cadence beyond the two deltas named in Strategy. Re-tuning `SYNOPSIS_MIN_INTERVAL`, the wording of `SYNOPSIS_INSTRUCTIONS` beyond the one section S02 requires, or the description's display is a later campaign.
- Re-architecting where the SharedAgent runs or which model serves it.

#### Dependencies / Prerequisites {#dependencies}

- None beyond `main` as it stands. The SharedAgent infrastructure (`SharedAgentPool`, `HAIKU_AGENT_JOBS`, the app-test spawn gate) stays as-is.

#### Constraints {#constraints}

- **WARNINGS ARE ERRORS** (`tugrust/.cargo/config.toml`) — every orphaned symbol must be deleted in the same step that orphans it.
- App-tests: selective only (`just app-test-changed`); the corpus **refuses to run from a dash worktree**, so app-test checkpoints run after the dash lands (or from `main`), as recorded per step. A Rust change needs `just build-app` before any app-test can see it.
- Never point `sqlite3` at live ledgers; use `just db-inspect`.
- tugdeck changes are verified with `cd tugdeck && bunx vite build` (the debug app loads the prod rollup bundle).
- bun, never npm. In a worktree, use absolute paths — the shell cwd reverts between calls.
- No plan-step numbers in durable artifacts; no AI attribution in commits.

#### Assumptions {#assumptions}

- The dead-chain finding holds as verified 2026-08-17: `usePulseOverview`, `latestPulseOverviewForScope`, `PulseOverviewEntry`, `pulseOverviews`, `foldPulseOverview`, `EMPTY_PULSE_OVERVIEWS`, `OVERVIEW_APP_SCOPE`, `PulseOverviewWireRow` have zero importers outside `pulse-store.ts`/`protocol.ts`/`action-dispatch.ts` and their own tests; nothing passes `headline=` to `TugPulse` outside `gallery-pulse-display.tsx`; `test-surface.ts`'s `publishPulseFrame` has zero callers. **Step 1 re-verifies before deleting; if any leg fails, stop and re-scope.**
- `tugapp/` (Swift) has zero references to the pulse-overview surface (verified by grep 2026-08-17).
- The `synopsis` ledger write path (`record_synopsis` → `build_session_updated_frame` push → `session-synopsis-store.ts`) is healthy and needs no change.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Does the description keep the PULSE kill-switch gate? (DECIDED) {#q01-pulse-gate}

**Question:** Today the synopsis inherits three gates from the headline machinery it rides: the `pulse-overview` tenant switch, the `dev.tugtool.pulse` PULSE switch, and refusal back-off ([D132] called the inheritance deliberate). With the headline gone, does the PULSE switch still gate the description?

**Why it matters:** Keeping it leaves a non-PULSE feature dark under a PULSE switch — the exact half-by-mistake coupling this plan removes. Dropping it changes visible behavior for a user who explicitly disabled PULSE: their sessions start getting descriptions.

**Resolution:** DECIDED (see [P04]) — asked 2026-08-17; the user chose **drop it**. The tenant switch and back-off alone gate the description; [D132] is updated to record the decoupling as deliberate.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Description quality regresses without the distilled headline input | med | med | S02 feeds the same evidence (raw activity lines) under the same heading; register + grounding unchanged; retargeted `just model-eval` measures it | Descriptions read worse after landing |
| The trigger rewrite changes update occasions | med | low | S01 pins occasions with paused-time unit tests (activity, settle, debounce-defers) | A session's description reads stale or strobes |
| The eval corpus migration degrades the eval's signal | low | med | Keep the twelve-digest structure; hand-migrate evidence under the S02 headings; re-baseline on first run | `just model-eval` scores swing wildly vs. history |
| An in-flight `kind:"overview"` frame folds as a beat during the transition | low | low | Step ordering: the emitter stops emitting (Step 1) before the deck parse dies (Step 4); deck and tugcast ship in one app bundle, so no deployed skew exists | n/a — ordering guarantee |

**Risk R01: The synopsis digest loses the current-stretch signal** {#r01-digest-signal}

- **Risk:** `last_headline` was a *distilled* summary of the current stretch; replacing it with raw activity lines could make the model weigh stale prompts over live work.
- **Mitigation:** The activity lines go under the same `SESSION_PRESENT_HEADING` ("Where it stands right now (background, not the subject)"), newest-first, bounded by `SYNOPSIS_ACTIVITY_LINES`; `SYNOPSIS_INSTRUCTIONS` is reworded in the same step to describe the section's new shape; the grounding gate now has *more* digest vocabulary to ground against, not less.
- **Residual risk:** Prompt quality is empirical; the retargeted eval is the standing measure, and `SYNOPSIS_ACTIVITY_LINES` is the tuning knob.

**Risk R02: The settle refresh mis-fires** {#r02-settle-refresh}

- **Risk:** The collapse machinery being replaced was subtle (epoch guards, once-per-stretch marking, refusal-loop prevention); a naive port re-asks forever on an idle session or never refreshes at all.
- **Mitigation:** S01 keeps the exact discipline: refresh marked spent **when the model is asked** (not on success), once per settled stretch via the surviving `settle_refreshed` flag, cleared by any beat; the `barrier_epoch` guard survives on the outcome path.
- **Residual risk:** None beyond ordinary implementation error; the paused-time tests in Step 1 are written against these exact properties.

---

### Design Decisions {#design-decisions}

#### [P01] The synopsis is the subsystem's only model ask; the headline is deleted, not renamed (DECIDED) {#p01-one-ask}

**Decision:** The per-stretch headline — its `summarize`/`summarize_done` asks, its PULSE frame, its ledger cache, its deck chain — is removed. The synopsis pipeline is the module.

**Rationale:**
- The headline's renderer was retired twice ([D132]'s strip retirement; `session-identity` [P06]) and nobody swept the feed; its sentence has gone nowhere visible since. Its two remaining functions — cadence gating and one digest line — are structural accidents this plan re-homes ([P02], [P03]).
- Renaming dead code preserves an accident. Deleting it also dissolves the "overview" grep collision without coining anything: the survivor already has its name (`synopsis` in storage and stores, "description" in the [D132] UI ladder).
- The SharedAgent does strictly less inference for the same visible output: the ~8s-floor ask disappears; the ~60s ask remains.

**Implications:**
- `feeds/session_overview.rs` → `feeds/session_synopsis.rs`; every "overview" spelling on the pulse side dies (Table T01).
- The description no longer waits for a headline emit to be allowed to update.
- `just model-eval` must retarget or it ships broken ([P07]).

#### [P02] The trigger is "the session moved", and due-ness defers rather than being swallowed (DECIDED) {#p02-trigger}

**Decision:** A session is synopsis-due when it has any new beat since its last ask, or a pending settle refresh; a due session's ask fires through the existing queue / single in-flight slot / back-off machinery when the 60s debounce window is open. Due-ness is inherent in the surviving counters — no new flag — and persists until an ask actually goes to the model.

**Rationale:**
- "An emit having happened is what says the session moved" — but the emit was just the cadence conditions plus a model call. And under a 60s pacer the cadence's burst/idle distinction is vacuous: `IDLE_PERIOD` (20s, ≥1 beat) is always satisfied by the time a 60s window opens, so every session with any beat emitted, and therefore synopsis-checked, anyway. "Any new beat since the last ask" is the whole condition — `BURST_BEATS`, `IDLE_PERIOD`, `EMIT_FLOOR`, `FORCED_EMIT_FLOOR`, and the `fire_asap` fast path all existed to pace the 8-second headline and die with it.
- Today the post-settle synopsis can be **silently swallowed**: `take_synopsis_job` runs once, after the collapse emit, and returns `None` inside the debounce window — the session then never gets its final description update because an idle session produces no further emits. Persistent due-ness fixes this without changing any visible occasion: the refresh arrives when the window opens instead of never.
- Reusing the single in-flight slot and back-off means a refusing model is backed off from the *only* ask — today synopsis failures bypass back-off entirely, which was tolerable only because the headline lane was absorbing the refusals.

**Implications:**
- `SessionState`: `collapsed`/`activity_since_collapse` survive renamed (`settle_refreshed`/`activity_since_settle`); `last_digest`, `last_headline`, `beat`, `asked_since_emit`, `activity_since_emit`, and `fire_asap` die with their consumers (`human_act` keeps its barrier-crossing and resume semantics — only the fast-fire flag goes).
- `Cadence` is replaced by an injectable `Clocks { min_interval, settle_after }` (the struct existed for paused-time test steering, which the tests still need); `SYNOPSIS_MIN_INTERVAL` is the only pacing.
- The debounce stays marked-on-ask: the outcome reports whether the model was asked, and a job that composed no digest un-marks (Spec S01).

#### [P03] The synopsis digest carries the activity cut in place of the headline (DECIDED) {#p03-digest}

**Decision:** `compose_synopsis_digest`'s `headline` parameter is replaced by the newest activity lines, rendered under the same `SESSION_PRESENT_HEADING`, bounded by a new `SYNOPSIS_ACTIVITY_LINES` constant (8).

**Rationale:**
- The headline was a pre-summarization pass over evidence the loop already holds (`state.activity`); with no display to serve, the synopsis model can read the evidence itself — one inference instead of two.
- The heading survives verbatim because `SYNOPSIS_INSTRUCTIONS` names each heading, and "a heading the wording does not name is a section the model has no instruction about" (the module's own doctrine).

**Implications:**
- `SYNOPSIS_INSTRUCTIONS` in `shared_agent.rs` is reworded where it describes that section — it now receives activity lines, not a one-line summary.
- Activity lines are already clipped at record time (`MAX_TARGET_CHARS` 60 / `MAX_SAID_CHARS` 100), so the digest stays bounded.
- The JSONL prompt refresh moves into the synopsis job (it lived in `run_emit`): refresh cache → compose → ask, with the cache restored via the outcome under the existing `barrier_epoch` guard.

#### [P04] The PULSE kill switch stops gating the description (DECIDED) {#p04-gates}

**Decision:** `Gates` becomes `{ tenant_enabled, backing_off }`; the `pulse_enabled` closure and the module's `pulse_tx` are removed. Decided by the user 2026-08-17 ([Q01]).

**Rationale:**
- The PULSE gate's rationale was "never spend inference on invisible lines" — the description is not PULSE ink; it renders in the masthead, Lens, and picker regardless of PULSE.
- [D132] blessed the inheritance only as a consequence of riding the headline's machinery; with the machinery gone, keeping the gate would be a new decision, and it would be the wrong one.

**Implications:**
- A user with `dev.tugtool.pulse` off starts receiving descriptions — a deliberate, recorded behavior change ([D132] update in Step 6).
- The module produces **no PULSE output at all**; `main.rs` stops wiring `pulse_tx` and the pulse-enabled closure into it.

#### [P05] The tenant key renames `pulse-overview` → `synopsis`, carried forward once (DECIDED) {#p05-tenant-key}

**Decision:** `PULSE_OVERVIEW_KEY = "pulse-overview"` becomes `SYNOPSIS_KEY = "synopsis"` in the `dev.tugtool.shared-agent` domain, with a one-shot startup carry-forward copying an existing `pulse-overview` value to `synopsis` when `synopsis` is unset.

**Rationale:**
- The switch is a live user setting; a silent rename re-enables the tenant for anyone who switched it off (absent reads as enabled).
- The precedent is `carry_legacy_defaults_forward` in `feeds/overview_agent.rs` (the observer rename's domain carry-forward): copy once, new-key-wins, docblock naming the deletion condition.

**Implications:**
- The carry-forward runs beside the existing `carry_legacy_defaults_forward` call at tugcast startup, and its docblock states it may be deleted once no installation predates this release.
- The deck's `PULSE_OVERVIEW_KEY` and the `SharedAgentTenant` union's second member are deleted (zero consumers), not renamed — the deck never reads this switch.

#### [P06] `pulse_overviews` drops; the migration is a drop, not a rename (DECIDED) {#p06-drop-table}

**Decision:** A named idempotent migration (`migrate_drop_pulse_overviews`) drops the `pulse_overviews` table and its `pulse_overviews_cascade_delete_on_session` trigger. `PulseOverviewRow`, `record_pulse_overview`, `list_pulse_overviews`, and their test are deleted.

**Rationale:**
- The table is a latest-per-scope **cache** whose sole stated purpose — "lets a card come back from a relaunch still wearing its headline" — restores into a deck map this plan deletes. Unlike `gazette_posts` (permanent history, renamed by `ALTER TABLE`), nothing here is worth carrying: the cost of loss was always one blank line until the next emit, and after this plan there is no consumer at all.
- `sessions.db` migrates by named idempotent `migrate_*` functions called from `bootstrap_schema` (no version constant — that regime belongs to the shared `changes.db` only).

**Implications:**
- `DROP TRIGGER IF EXISTS` + `DROP TABLE IF EXISTS`, called from `bootstrap_schema` after the existing migration calls; docblock names the deletion condition (once no installation predates this release).
- `list_pulse_lines_ok` in `feeds/agent_supervisor.rs` stops assembling its `overviews` array. The deck's restore read tolerates the array's absence (`Array.isArray` guard), so the backend can land before the deck deletion.

#### [P07] `model-eval` retargets at the synopsis; the retrospective lane retires (DECIDED) {#p07-model-eval}

**Decision:** `just model-eval` scores the synopsis: `run.py` extracts `SYNOPSIS_INSTRUCTIONS`, drives a new `shared_agent_synopsis` socket verb (replacing `request_summary` / `shared_agent_summarize`), and scores against the synopsis register (72-char budget). `just model-eval-done` and the `corpus/*.done.txt` fixtures are deleted. `liveness.py` and `analyze.py` retune to the `synopsis` task and the `session synopsis:` log lines.

**Rationale:**
- Kept as-is the harness ships broken: its verb and its log lines cease to exist after Step 3. Deleting it entirely would discard the only quality measure for the one sentence users now read.
- The retrospective lane measured the collapse's past-tense ask, which no longer exists.

**Implications:**
- The twelve corpus digests are hand-migrated to the synopsis digest shape (the S02 headings); scores re-baseline on first run.
- `README.md` and the Justfile recipe comments are rewritten to name the synopsis as the subject.
- `model-classify` and its lane are untouched.

#### [P08] Register machinery unifies under the synopsis's name (DECIDED) {#p08-register}

**Decision:** `headline_register_report` dies with its two callers (`run_emit`, `request_summary`); `HeadlineReport` renames to `RegisterReport`; `synopsis_register_report` and the grounding gate (`ground_headline` → `ground_synopsis`) survive. `GroundingMode` collapses to a single mode (the `Retrospective` variant and its past-tense exemption die with the collapse ask). Headline-only constants (`MAX_HEADLINE_CHARS`, `TAIL_JOINERS` and the joiner trim, `GROUNDING_CORRECTION`, the `Reask` machinery) die; anything the synopsis register actually uses survives.

**Rationale:**
- The register rules were shared by construction ("The register rules are the headline's verbatim" — [D132]); the survivor keeps the rules under the surviving subject's name.
- The reask was the headline's grounding-rescue lane; the synopsis has never had one (a refused synopsis skips and re-asks a minute later), and this plan does not add one.

**Implications:**
- Register tests in the module that pin *shared* rules move to the synopsis register's test set; headline-only tests (budget-56 clipping, joiner trims, past-tense exemption) are deleted.
- `SUMMARIZE_TIMEOUT`/`SUMMARIZE_SLOW` in `shared_agent.rs` (shared by the `synopsis` and `expand_query` jobs) rename to `SENTENCE_TIMEOUT`/`SENTENCE_SLOW` so no `summarize` spelling survives.

---

### Deep Dives {#deep-dives}

#### How the renderers died, and why the feed survived {#death-history}

For the [D132] update in Step 6, and so nobody rebuilds the chain: `dash/archive/pulse-improvements.md` built both renderers — the card strip's bright headline run and a Lens intent line, both fed by `usePulseOverview`. `dash/archive/session-identity.md` [P06] then replaced the Lens line with the description, and [D132] retired the Z2 `SessionPulseStrip` and had `tug-session-row.tsx` deliberately withhold `TugPulse`'s `headline` level ("the description above already says what the session is for"). Each removal was locally correct; neither swept the producing feed, the store chain, the ledger cache, or the eval harness. The headline kept running because its emit completion had been made the synopsis's trigger and its text one digest line — load-bearing by accident, invisible by design.

#### The two-ask flow today, and the one-ask flow after {#flow}

**Today:** CODE_OUTPUT/CODE_INPUT taps → `SessionState` accumulators → sweep (2s tick) evaluates `Cadence::fires` (+ `fire_asap` forced path, + `collapse_due` retrospective arm) → queue → single in-flight `run_emit` (JSONL prompt refresh → `compose_digest`/`compose_retrospective_digest` → `summarize`/`summarize_done` ask → `headline_register_report` → `ground_headline`, reask on refusal) → `apply_emit_outcome` (PULSE `overview_frame` broadcast + `record_pulse_overview` write + `last_headline`) → **then** `take_synopsis_job` (60s debounce, resolver-or-skip) → detached `run_synopsis` (`compose_synopsis_digest` with `last_headline`; previous read from ledger; `synopsis` ask; `synopsis_register_report`; `ground_headline`; `record_synopsis`; `session_updated` push).

**After:** the same taps and accumulators → sweep marks `synopsis_due` (burst / idle-with-beats / human act / settle) → queue → single in-flight synopsis job (JSONL prompt refresh → `compose_synopsis_digest` with the activity cut → previous from ledger → `synopsis` ask → `synopsis_register_report` → `ground_synopsis` → `record_synopsis` → `session_updated` push) → outcome restores the cache under the `barrier_epoch` guard, feeds back-off, marks the settle refresh spent. No PULSE output, no ledger cache, no second ask.

#### What the headline contributed, and where each piece goes {#headline-contributions}

| Contribution | Today | After |
|---|---|---|
| "The session moved" signal | Emit completion gates `take_synopsis_job` | The cadence conditions mark `synopsis_due` directly ([P02]) |
| Current-stretch evidence | `last_headline` line in the synopsis digest | Newest `SYNOPSIS_ACTIVITY_LINES` activity lines, same heading ([P03]) |
| Settle tense-switch ("what it did") | `summarize_done` retrospective emit | One reliable synopsis refresh per settled stretch ([P02]) |
| Refusal back-off | Emits feed process-wide back-off; synopsis bypasses it | The synopsis feeds it — it is the only ask ([P02]) |
| Quality measurement | `just model-eval` scores headlines | Retargeted at the synopsis ([P07]) |

---

### Specification {#specification}

**Spec S01: The synopsis trigger** {#s01-trigger}

State, per session (surviving `SessionState` unless noted):

- **Due-ness is derived, not stored**: a session is due when `new_beats > 0` (any beat since the last ask — `new_beats` zeroes when an ask spawns, so the counter itself is the sticky flag), or when a settle refresh is pending (`settled_at` crossed `settle_after` with `activity_since_settle > 0` and `!settle_refreshed`). No burst/idle thresholds survive ([P02] — vacuous under the 60s pacer).
- `last_synopsis: Option<Instant>` — the debounce clock, unchanged semantics: an ask fires only when `None` or ≥ `SYNOPSIS_MIN_INTERVAL` ago. **Marked when the model is asked**; a job whose in-job digest composes to `None` reports `asked: false` in its outcome and the mark is restored, so an empty session never burns a window (its beats were consumed at spawn, so it re-dues on its next beat).
- `settle_refreshed: bool` (rename of `collapsed`) + `activity_since_settle` (rename of `activity_since_collapse`): once per settled stretch, marked when the settle-triggered ask reaches the model, cleared by any beat — the exact discipline the collapse had, minus the model-facing tense switch.
- `barrier_epoch`: unchanged. An outcome carrying an older epoch restores only the cache's read position (with `cache.barrier()`), exactly as `apply_emit_outcome` does today.

Dispatch: the sweep pushes due-and-debounce-open sessions onto the existing queue; `spawn_next`'s shape survives (single in-flight slot; a back-off arming mid-queue drains it with due-ness intact — due sessions are re-queued on the first allowed sweep). The resolver (`config.identity.resolver`) is consulted at job-take, before the debounce is marked; `None` leaves the session due for the next sweep (no fallback row key — the [D132] discipline, verbatim). `config.ledger` absent ⇒ never due-spawned.

Gates ([P04]): `Gates { tenant_enabled, backing_off }`. The `pulse_enabled` closure, `pulse_tx`, and their `main.rs` wiring are removed.

**Spec S02: The synopsis digest** {#s02-digest}

`compose_synopsis_digest(opening, arc, recent_ask, activity: &[String], previous)` — the `headline: Option<&str>` parameter is replaced by the activity slice. Composition order and headings unchanged: `SESSION_RECENT_HEADING` (current ask, clip 240) → `SESSION_ARC_HEADING` (prior asks, newest first, dedup'd against opening/recent) → `SESSION_OPENING_HEADING` (clip 240) → `SESSION_PRESENT_HEADING` carrying the newest `SYNOPSIS_ACTIVITY_LINES` (= 8, new const beside `MAX_ACTIVITY_LINES`) activity lines as `- ` bullets, newest last (chronological within the section) → `SESSION_PREVIOUS_HEADING` (appended in-job from the ledger row, clip 240, unchanged). The emptiness guard is unchanged: `None` when opening, arc, and recent are all absent — activity alone never asks (prompts are the evidence's better half, and a session with no human act has nothing to describe).

The prompt refresh moves in-job: the job takes the `PromptCache` (`std::mem::take`, as `EmitJob` does today), refreshes from the JSONL on `spawn_blocking`, composes, and returns the cache in its outcome. `pending_ask` rides along exactly as in `run_emit` (append when the cache doesn't carry it; report `caught_up_ask` when it does).

`SYNOPSIS_INSTRUCTIONS` (`shared_agent.rs`) is reworded where it describes the present section: it now receives raw activity lines (tool targets, `said:` heads, `$` commands), not a distilled sentence. Change only that section's description; the ask, register rules, and output contract are untouched.

**Spec S03: The tenant-key carry-forward** {#s03-tenant-carry}

`SYNOPSIS_KEY: &str = "synopsis"` replaces `PULSE_OVERVIEW_KEY` in `shared_agent.rs`; `main.rs`'s tenant closure reads it. A one-shot startup carry-forward — modeled on `carry_legacy_defaults_forward` in `feeds/overview_agent.rs` and invoked beside it — copies `dev.tugtool.shared-agent`/`pulse-overview` to `synopsis` **only when `synopsis` is unset** (new-key-wins). Follow the template's copy-only behavior: the stale `pulse-overview` key is left in place (a harmless orphan in a defaults store — do not grow a delete API for it), and the docblock says so alongside the deletion condition: the carry-forward and the orphan may both go once no installation predates this release. Only an explicit `false` matters (absent reads enabled), so the carry-forward's failure mode is a re-enabled tenant, which the copy exists to prevent.

**Spec S04: The drop migration** {#s04-drop-migration}

`migrate_drop_pulse_overviews(conn)` in `session_ledger.rs`: `DROP TRIGGER IF EXISTS pulse_overviews_cascade_delete_on_session; DROP TABLE IF EXISTS pulse_overviews;` — one `execute_batch`, no transaction gymnastics (both statements are idempotent and the table is a cache; the `BEGIN IMMEDIATE` guard the gazette rename needed protected a data-carrying rename, which this is not). Called from `bootstrap_schema` after the existing `migrate_*` calls. The `CREATE TABLE pulse_overviews` block and its trigger leave the bootstrap DDL in the same commit. Docblock names the deletion condition (once no installation predates this release). Unit test: create a ledger with the old DDL and a row, open through `bootstrap_schema`, assert the table and trigger are gone and a second open succeeds.

**Spec S05: The retargeted eval** {#s05-eval}

- `shared_agent.rs`: `request_summary(agent, cat, prompt, retrospective)` → `request_synopsis(agent, cat, prompt)` — runs the `synopsis` job, logs via `synopsis_register_report`, broadcasts `{"action": "shared_agent_synopsis_result", ...}` with the same ok/text/error shape.
- `actions.rs`: the `"shared_agent_summarize" | "shared_agent_summarize_done"` arm becomes `"shared_agent_synopsis"`.
- `tests/model-eval/harness.py`: already composes `shared_agent_{task}`; callers pass `synopsis`.
- `run.py`: extracts `SYNOPSIS_INSTRUCTIONS` (same const-extraction mechanism, new name); the `--retrospective` flag, the done-lane fixtures (`corpus/*.done.txt`), and the past-tense half of `verbs.txt` handling are deleted; scoring reads the synopsis register's rules — 72-char budget (`MAX_SYNOPSIS_CHARS`), no joiner-trim lane.
- `analyze.py`: log-line subjects move from `session overview: summarized|emitted|headline reask` to `session synopsis: written|refused|ask failed`; the reask column dies.
- `liveness.py`: drives the `synopsis` task; the ceiling named in its prose is the `synopsis` job's.
- Corpus: the twelve frozen digests are hand-migrated to the S02 shape (same underlying evidence, restated under `SESSION_*` headings with a bulleted present section).
- Justfile: `model-eval` recipe comment rewritten (subject: the description; run after touching `SYNOPSIS_INSTRUCTIONS` or the synopsis register); `model-eval-done` recipe deleted; `model-stats`/`model-liveness` comments retuned.
- `README.md`: the four-question table becomes three (register, classify-gate, liveness) plus stats; the headline vocabulary is replaced by the description's.

**Spec S06: The vestige gate** {#s06-vestige-gate}

Run from the repo root; **scope excludes `dash/`** (plans and archives are history) and `tests/model-eval/__pycache__`:

```bash
rg -in 'pulse_overview|pulse-overview|pulseoverview|usePulseOverview|overview_frame|session_overview' \
   tugrust tugdeck/src tugcode/src tugapp tugproto tests tuglaws Justfile CLAUDE.md
rg -n '"summarize"|"summarize_done"|shared_agent_summarize|SUMMARIZE_INSTRUCTIONS|SUMMARIZE_DONE_INSTRUCTIONS|request_summary' \
   tugrust tugdeck/src tugcode/src tests Justfile
rg -n 'kind.*"overview"|"overview".*kind' tugdeck/src tugcode/src tugrust/crates/tugcast/src/feeds
rg -n 'session overview' tugrust tugdeck/src tests
```

Allowed survivors, exactly: `migrate_drop_pulse_overviews` and its docblock in `session_ledger.rs`; the tenant carry-forward and its docblock (Spec S03). Everything else the greps return is a miss. (Narration-channel spellings — `overview_posts`, `OverviewPostWire`, `list_overview_posts`, `overview-store`, `overview-card` — do not match these patterns; that is the point of the patterns.)

#### State Zone Mapping (tugdeck/tugways plans) {#state-zone-mapping}

The deck work is pure deletion — no new state enters the deck. The surviving description path (`session-synopsis-store.ts`, subscribed via `useSyncExternalStore` [L02]) is untouched.

| State | Zone (appearance / local-data / structure) | Mechanism | Law |
|-------|--------------------------------------------|-----------|-----|
| *(none added; `pulseOverviews` map and `usePulseOverview` hook removed)* | — | — | [L02] unaffected |

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tugrust/crates/tugcast/src/feeds/session_synopsis.rs` | `git mv` of `session_overview.rs` — the consolidated pipeline |

**Table T01: Symbol fates** {#t01-symbol-fates}

| Symbol | Location | Fate |
|--------|----------|------|
| `session_overview_task`, `SessionOverviewConfig` | `session_synopsis.rs` | rename → `session_synopsis_task`, `SessionSynopsisConfig`; `pulse_tx` + `pulse_enabled` fields removed ([P04]) |
| `relay_code_input`, `SessionIdentity`, `SessionResolver` wiring | `session_synopsis.rs`, `main.rs` | keep (module path updates) |
| `SessionState.{activity, new_beats, open, beaten, prompts, pending_ask, last_seen, barrier_epoch, last_synopsis}` | `session_synopsis.rs` | keep |
| `SessionState.{last_digest, last_headline, beat, asked_since_emit, activity_since_emit}` | `session_synopsis.rs` | delete |
| `SessionState.collapsed`, `.activity_since_collapse` | `session_synopsis.rs` | rename → `settle_refreshed`, `activity_since_settle` |
| `SessionState.synopsis_due` | `session_synopsis.rs` | **new** (Spec S01) |
| `Cadence` | `session_synopsis.rs` | replace with injectable `Clocks { min_interval, settle_after }` ([P02]) |
| `BURST_BEATS`, `IDLE_PERIOD`, `EMIT_FLOOR`, `FORCED_EMIT_FLOOR`, `SessionState.fire_asap` | `session_synopsis.rs` | delete ([P02]); the `EMIT_FLOOR` timeout asserts in `shared_agent.rs` retune to `SYNOPSIS_MIN_INTERVAL` in Step 1 |
| `SYNOPSIS_MIN_INTERVAL` | `session_synopsis.rs` | keep; becomes `pub` (the shared_agent timeout assert reads it) |
| `SYNOPSIS_ACTIVITY_LINES` | `session_synopsis.rs` | **new** = 8 ([P03]) |
| `Gates` | `session_synopsis.rs` | shrink to `{tenant_enabled, backing_off}` ([P04]) |
| `EmitJob`/`EmitOutcome`/`run_emit`/`spawn_next`/`apply_emit_outcome` | `session_synopsis.rs` | become the synopsis job/outcome/run/spawn/apply (Deep Dive #flow); `may_reask`, `retrospective`, `headline` fields die |
| `take_synopsis_job`, `run_synopsis`, `SynopsisJob` | `session_synopsis.rs` | fold into the job path above (compose moves in-job, Spec S02) |
| `compose_digest`, `compose_retrospective_digest`, `STANDING_GOAL_HEADING`, `CURRENT_ASK_HEADING`, `ACTIVITY_HEADINGS`, `RETROSPECTIVE_HEADING` | `session_synopsis.rs` | delete (the summarize ask's input) |
| `compose_synopsis_digest`, `SESSION_*_HEADING` consts | `session_synopsis.rs` | keep; `headline` param → `activity` slice (Spec S02) |
| `overview_frame` | `session_synopsis.rs` | delete |
| `MAX_HEADLINE_CHARS`, `TAIL_JOINERS`, joiner trim | `session_synopsis.rs` | delete in Step 1 ([P08]) |
| `headline_register_report` | `session_synopsis.rs` | **survives Step 1** (pub; its last caller is `request_summary` in `shared_agent.rs` — only its module path updates); deleted in Step 3 with that caller ([P08]) |
| `HeadlineReport` | `session_synopsis.rs` | rename → `RegisterReport` |
| `synopsis_register_report`, `MAX_SYNOPSIS_CHARS` | `session_synopsis.rs` | keep |
| `ground_headline`, `GroundingMode`, `GroundingVerdict` | `session_synopsis.rs` | `ground_synopsis`; `GroundingMode` deleted (single mode); past-tense exemption dies ([P08]) |
| `Reask`, `GROUNDING_CORRECTION` | `session_synopsis.rs` | delete |
| `IDLE_COLLAPSE_AFTER` | `session_synopsis.rs` | rename → `SETTLE_REFRESH_AFTER` |
| `pulse_overviews` table + trigger, `PulseOverviewRow`, `record_pulse_overview`, `list_pulse_overviews`, `pulse_overviews_replace_in_place_and_cascade` | `session_ledger.rs` | delete; `migrate_drop_pulse_overviews` **new** (Spec S04) |
| `overviews` array in `list_pulse_lines_ok` | `feeds/agent_supervisor.rs` | delete |
| `JobSpec` entries `summarize`, `summarize_done`; `SUMMARIZE_INSTRUCTIONS`, `SUMMARIZE_DONE_INSTRUCTIONS` | `shared_agent.rs` | delete |
| `SUMMARIZE_TIMEOUT`, `SUMMARIZE_SLOW` | `shared_agent.rs` | rename → `SENTENCE_TIMEOUT`, `SENTENCE_SLOW` ([P08]) |
| `request_summary` | `shared_agent.rs` | → `request_synopsis` (Spec S05) |
| `"shared_agent_summarize" \| "shared_agent_summarize_done"` arm | `actions.rs` | → `"shared_agent_synopsis"` |
| `PULSE_OVERVIEW_KEY` | `shared_agent.rs` | → `SYNOPSIS_KEY = "synopsis"` + carry-forward (Spec S03) |
| `PulseOverviewWireRow`, `ListPulseLinesOk.overviews`, `kind?: "overview"` parse + `PulseLineWire.kind` | `tugdeck/src/protocol.ts` | delete |
| `overviews` restore branch + `PulseOverviewWireRow` import | `tugdeck/src/action-dispatch.ts` | delete |
| `PulseOverviewEntry`, `pulseOverviews`, `foldPulseOverview`, restore fold, `latestPulseOverviewForScope`, `usePulseOverview`, `EMPTY_PULSE_OVERVIEWS`, `OVERVIEW_APP_SCOPE` | `tugdeck/src/lib/pulse-store.ts` | delete (+ their tests in `pulse-store.test.ts`) |
| `PULSE_OVERVIEW_KEY`, `SharedAgentTenant`'s second member | `tugdeck/src/lib/shared-agent-store.ts` | delete; the union narrows to `typeof SHELL_ROUTING_KEY` |
| `PulseLine.kind` | `tugcode/src/pulse/types.ts` | delete (tugcode never sets it; verify no reader first) |
| `publishPulseFrame` doc comment | `tugdeck/src/test-surface.ts` | keep the helper (beat injection); drop the overview shape from its doc |
| `model-eval` files | `tests/model-eval/` | retarget per Spec S05 |

---

### Documentation Plan {#documentation-plan}

- [ ] `tuglaws/design-decisions.md`: rewrite the [D132]-area paragraphs that say the synopsis "rides the headline's machinery" / "inherits the headline's gates"; record the consolidation as a decision carrying the death history (Deep Dive #death-history), the PULSE-gate decoupling ([P04]), and a *do not rebuild the headline chain* marker; update the shared-agent decision paragraph that names `feeds/session_overview.rs`.
- [ ] `tests/model-eval/README.md` per Spec S05.
- [ ] `tests/app-test/at0280-shared-agent-absent.test.ts` header prose: module name and the claim wording ("overview" → the description), no behavioral change.
- [ ] Justfile recipe comments per Spec S05.

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit (Rust, paused-time)** | The trigger's occasions, debounce-defers, settle once-per-stretch, barrier guard, digest composition | Step 1 — the module's existing paused-clock test style |
| **Unit (Rust, ledger)** | The drop migration on populated and empty ledgers, idempotence | Step 2 |
| **Unit (Rust, fake-spawner)** | The synopsis job through a fake SharedAgent; register + grounding on the answer | Step 1/3 — the existing `shared_agent.rs`/module suites |
| **Unit (deck)** | `pulse-store` beat behavior survives the deletion untouched | Step 4 — existing tests minus the deleted overview cases |
| **App-test (existing)** | `at0280` — the agentless posture: no headline ink, no description invented | Integration — via `just app-test-changed` |

#### What stays out of tests {#test-non-goals}

- **No new app-test.** The positive synopsis path spends subscription tokens, which no app-test may do; it is covered by the Rust fake-spawner suites and measured on demand by `just model-eval` (Spec S05). `at0280` already pins the agentless negative.
- **No mock-store or fake-DOM tests** — banned shapes; the deck change is deletion, proven by the compiler, `bunx vite build`, and the surviving suite.
- **No test pinning `SYNOPSIS_ACTIVITY_LINES = 8`** or other tuning values — reflexive constant-pins are churn, not coverage.

---

### Execution Steps {#execution-steps}

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | The synopsis becomes the module's only ask | done | `43c5fa87e` |
| #step-2 | The ledger cache drops | done | `cbc770663` |
| #step-3 | The SharedAgent sheds the summarize lanes | done | `aa939a0f5` |
| #step-4 | The deck deletes the dead chain | done | `d1d498a4e` |
| #step-5 | model-eval scores the sentence users read | done | `04ab4fe53` |
| #step-6 | The laws and the stragglers | done | `31538680e` |
| #step-7 | Integration checkpoint | done | `dc70c5bea` |

#### Step 1: The synopsis becomes the module's only ask {#step-1}

**Commit:** `tugcast(synopsis): the description pipeline is the module's only model ask`

**References:** [P01] one ask, [P02] trigger, [P03] digest, [P04] gates, [P08] register, Spec S01, Spec S02, Table T01, (#flow, #headline-contributions)

**Artifacts:**
- `feeds/session_overview.rs` → `feeds/session_synopsis.rs` (`git mv`), rewired per Deep Dive #flow; `feeds/mod.rs` and `main.rs` follow.

**Tasks:**
- [ ] Re-verify the dead-chain finding (Assumptions): `rg -n 'usePulseOverview|latestPulseOverviewForScope|PulseOverviewEntry\b' tugdeck/src --glob '*.tsx'` must return nothing; `rg -n 'headline=' tugdeck/src --glob '*.tsx'` must hit only `tug-pulse.tsx` internals and `gallery-pulse-display.tsx`; `rg -ln 'publishPulseFrame' tests/` must return nothing. Any hit ⇒ stop, report, re-scope.
- [ ] `git mv` the module; rename the task/config per Table T01; update `feeds/mod.rs`, `main.rs` (drop `pulse_tx` and the pulse-enabled closure from the config wiring — [P04]).
- [ ] Implement Spec S01: derived due-ness (`new_beats > 0` or a pending settle refresh); debounce marked-on-ask with un-mark on a no-digest outcome; queue/slot/back-off reuse; resolver-at-take; `barrier_epoch` guard on the outcome; `Cadence` → `Clocks`.
- [ ] Implement Spec S02: compose moves in-job with the JSONL refresh; `compose_synopsis_digest` takes the activity slice; add `SYNOPSIS_ACTIVITY_LINES`; reword the present-section description in `SYNOPSIS_INSTRUCTIONS` (`shared_agent.rs`).
- [ ] Delete the headline path per Table T01: `run_emit`'s summarize ask and reask, `overview_frame`, the `record_pulse_overview` call, `compose_digest`/`compose_retrospective_digest` and their headings, headline-only register constants, `GroundingMode`, `Reask`, the cadence constants, dead `SessionState` fields. `-D warnings` enforces completeness.
- [ ] **Cross-file couplings this step must carry** (or `tugrust` does not compile): `shared_agent.rs` calls `crate::feeds::session_overview::headline_register_report` inside `request_summary` — keep that fn alive (pub) and update its module path, deleting it only in Step 3 with its caller; the two `shared_agent.rs` timeout asserts read the module's `EMIT_FLOOR` — retune them to the now-`pub` `SYNOPSIS_MIN_INTERVAL` here.
- [ ] Retune the module's tests: port the trigger/collapse suites to the S01 semantics (paused-time, steered via `Clocks`); move shared register tests under the synopsis register; delete headline-only tests; keep the digest tests updated to the S02 signature. Note: `shared_agent.rs` still compiles with its summarize jobs this step — only the module's own calls to them are gone.

**Tests:**
- [ ] Paused-time: sustained beats mark due; the ask fires when the debounce opens; a due-but-debounced session defers and fires later (never swallowed).
- [ ] Paused-time: a settled stretch gets exactly one refresh; any beat re-arms; a refused model marks the refresh spent (no re-ask loop).
- [ ] The digest test: activity lines under `SESSION_PRESENT_HEADING`, emptiness guard unchanged, previous-section append unchanged.
- [ ] Fake-spawner: a synopsis answer lands in `record_synopsis` and pushes `session_updated`; a failure feeds back-off.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast`
- [ ] `rg -n 'overview' tugrust/crates/tugcast/src/feeds/session_synopsis.rs` returns nothing.

---

#### Step 2: The ledger cache drops {#step-2}

**Depends on:** #step-1

**Commit:** `tugcast(synopsis): drop the pulse_overviews cache and its restore tail`

**References:** [P06] drop table, Spec S04, Table T01

**Artifacts:**
- `migrate_drop_pulse_overviews` in `session_ledger.rs`; the table's DDL, trigger, row type, verbs, and test removed; `list_pulse_lines_ok` in `feeds/agent_supervisor.rs` loses its `overviews` array.

**Tasks:**
- [ ] Add `migrate_drop_pulse_overviews` per Spec S04, called from `bootstrap_schema` after the existing `migrate_*` calls, docblock naming the deletion condition.
- [ ] Remove the `CREATE TABLE pulse_overviews` block and its trigger from the bootstrap DDL; delete `PulseOverviewRow`, `record_pulse_overview`, `list_pulse_overviews`, and `pulse_overviews_replace_in_place_and_cascade`.
- [ ] In `feeds/agent_supervisor.rs`, stop assembling `overviews` in the `list_pulse_lines_ok` response (the deck's `Array.isArray` guard tolerates absence until Step 4).

**Tests:**
- [ ] Migration unit test: old-DDL ledger with a populated `pulse_overviews` row opens clean; table and trigger absent afterward; second open is a no-op.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast`
- [ ] `rg -n 'pulse_overview' tugrust/crates` hits only the migration and its docblock.

---

#### Step 3: The SharedAgent sheds the summarize lanes {#step-3}

**Depends on:** #step-1

**Commit:** `tugcast(synopsis): one sentence lane on the shared agent, and the tenant key follows`

**References:** [P05] tenant key, [P07] model-eval, [P08] register, Spec S03, Spec S05, Table T01

**Artifacts:**
- `shared_agent.rs` without summarize jobs; `request_synopsis` + the `shared_agent_synopsis` verb; `SYNOPSIS_KEY` with its carry-forward.

**Tasks:**
- [ ] Delete the `summarize`/`summarize_done` `JobSpec` entries and `SUMMARIZE_INSTRUCTIONS`/`SUMMARIZE_DONE_INSTRUCTIONS`; rename `SUMMARIZE_TIMEOUT`/`SUMMARIZE_SLOW` → `SENTENCE_TIMEOUT`/`SENTENCE_SLOW`.
- [ ] `request_summary` → `request_synopsis` per Spec S05; the `actions.rs` arm becomes `"shared_agent_synopsis"`; delete `headline_register_report` (this was its last caller — Table T01).
- [ ] `PULSE_OVERVIEW_KEY` → `SYNOPSIS_KEY = "synopsis"`; `main.rs` tenant closure follows; add the carry-forward per Spec S03 beside the existing `carry_legacy_defaults_forward` invocation.
- [ ] Retune `shared_agent.rs` tests: pool tests that used `"summarize"` as their exemplar job switch to `"synopsis"`; the PAST-TENSE instruction assert dies; the timeout asserts become `job("synopsis").timeout < session_synopsis::SYNOPSIS_MIN_INTERVAL` (now `pub`).

**Tests:**
- [ ] Job-table test: `HAIKU_AGENT_JOBS` carries `classify`, `classify_with_grammar`, `synopsis`, `expand_query` — no summarize entries.
- [ ] Carry-forward unit test: old key `false` + new key absent ⇒ new key `false`; new key present ⇒ untouched (copy-only, per Spec S03).

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run`
- [ ] `rg -n '"summarize"|summarize_done|request_summary|PULSE_OVERVIEW_KEY' tugrust` returns nothing.

---

#### Step 4: The deck deletes the dead chain {#step-4}

**Depends on:** #step-1, #step-2

**Commit:** `tugdeck(synopsis): delete the dead pulse-overview chain`

**References:** [P01] one ask, Table T01, (#death-history)

**Artifacts:**
- `protocol.ts`, `action-dispatch.ts`, `pulse-store.ts` (+ tests), `shared-agent-store.ts`, `tugcode/src/pulse/types.ts`, `test-surface.ts` doc — all per Table T01.

**Tasks:**
- [ ] Delete per Table T01: `PulseOverviewWireRow`, `ListPulseLinesOk.overviews`, the `kind` parse and `PulseLineWire.kind`; the `action-dispatch.ts` restore branch and import; every `pulse-store.ts` overview symbol, the snapshot field, both folds, and the hook; the overview cases in `pulse-store.test.ts`; `PULSE_OVERVIEW_KEY` and the `SharedAgentTenant` narrowing in `shared-agent-store.ts`.
- [ ] `tugcode/src/pulse/types.ts`: verify no reader of `PulseLine.kind` (`rg -n '\.kind' tugcode/src`), then delete the field and its doc.
- [ ] `test-surface.ts`: keep `publishPulseFrame` (beat injection), drop the overview shape from its doc comment.
- [ ] Sweep doc comments in the touched files for "overview" in the pulse sense (`pulse-store.ts` module header, `protocol.ts` PULSE section) — the narration channel's mentions stay.

**Tests:**
- [ ] The surviving `pulse-store.test.ts` (beats, history, dwell, restore of beat lines) green, unchanged in behavior.

**Checkpoint:**
- [ ] `cd tugdeck && bunx vite build && bun test`
- [ ] `rg -in 'pulseoverview|pulse-overview|usePulseOverview' tugdeck/src tugcode/src` returns nothing.

---

#### Step 5: model-eval scores the sentence users read {#step-5}

**Depends on:** #step-3

**Commit:** `model-eval(synopsis): the eval scores the description`

**References:** [P07] model-eval, Spec S05

**Artifacts:**
- `tests/model-eval/` retargeted; `model-eval-done` and the done-corpus gone; Justfile and README rewritten.

**Tasks:**
- [ ] Retarget `run.py`, `score.py`, `analyze.py`, `liveness.py`, and the corpus per Spec S05; delete the `--retrospective` lane and `corpus/*.done.txt`.
- [ ] Justfile: delete `model-eval-done`; rewrite the `model-eval` / `model-stats` / `model-liveness` comments.
- [ ] Rewrite `README.md` per Spec S05.

**Tests:**
- [ ] `python3 -m py_compile tests/model-eval/*.py` (the harness needs a running instance; compile is the offline bar — a live `just model-eval` run is the Iterate-phase gesture, on the dash build).

**Checkpoint:**
- [ ] `rg -n 'summarize|headline' tests/model-eval Justfile` returns nothing pulse-side (the classify lane and unrelated Justfile text are exempt; judge each hit).

---

#### Step 6: The laws and the stragglers {#step-6}

**Depends on:** #step-1, #step-4

**Commit:** `tuglaws(synopsis): the description stands alone, and the record says why`

**References:** [P04] gates, Deep Dive #death-history, Documentation Plan, (#q01-pulse-gate)

**Artifacts:**
- `tuglaws/design-decisions.md` updated; `at0280` prose; `shell-verdict-veto.test.ts` fixture string.

**Tasks:**
- [ ] `design-decisions.md`: rewrite the [D132]-area paragraphs per the Documentation Plan — the synopsis rides the activity machinery directly; the PULSE-gate decoupling is deliberate ([P04]); the headline chain's death history and a *do-not-rebuild* marker; the shared-agent paragraph's module path.
- [ ] `at0280-shared-agent-absent.test.ts`: header prose — module name `session_synopsis.rs`, "overview" wording → the description; claims and assertions unchanged.
- [ ] `shell-verdict-veto.test.ts`: the fixture command string names `session_synopsis`.
- [ ] Sweep `tuglaws/` for other pulse-side mentions: `rg -n 'session_overview|pulse.overview' tuglaws/` and fix each.

**Tests:**
- [ ] `cd tugdeck && bun test` (the veto suite); `at0280` runs in Step 7's app-test pass.

**Checkpoint:**
- [ ] `rg -in 'session_overview|pulse-overview|pulse_overview' tuglaws tests/app-test` returns nothing.

---

#### Step 7: Integration checkpoint {#step-7}

**Depends on:** #step-1, #step-2, #step-3, #step-4, #step-5, #step-6

**Commit:** `N/A (verification only)`

**References:** Spec S06, (#success-criteria, #exit-criteria)

**Tasks:**
- [ ] Full Rust suite; full deck build + suite; the vestige gate (Spec S06), judging every hit against the allowed-survivor list.
- [ ] `just build-app`, then `just app-test-changed` — the deck files changed here resolve through `@covers` (at0280 among them). The corpus refuses a dash worktree: run this from the base checkout after the dash lands, or record it as the landing's first act; do not bypass the gate.

**Tests:**
- [ ] All prior steps' suites, together.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run`
- [ ] `cd tugdeck && bunx vite build && bun test`
- [ ] Spec S06's greps return only the blessed survivors.
- [ ] `just app-test-changed` green (post-landing if on a worktree).

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** One model ask produces the session description; every trace of the pulse-side headline/overview — code, wire, storage, switch, eval, and law prose — is deleted or deliberately carried forward with a stated expiry, and a bare grep for "overview" names only the narration channel.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] `HAIKU_AGENT_JOBS` has no summarize entries; `session_synopsis.rs` contains one `agent.run` call site (`"synopsis"`). (grep)
- [ ] The vestige gate (Spec S06) passes with exactly the two blessed survivors. (grep)
- [ ] `cargo nextest run` green; `bunx vite build` + `bun test` green; `just app-test-changed` green after `just build-app`. (commands)
- [ ] The paused-time trigger tests pin activity-due, settle-once, and debounce-defers. (`cargo nextest run -p tugcast session_synopsis`)
- [ ] The drop migration test passes on a populated old-DDL ledger. (`cargo nextest run -p tugcast`)
- [ ] [D132]'s prose describes the consolidated shape and records the PULSE-gate decoupling. (read)

**Acceptance tests:**
- [ ] On the dash build, with the release instance's ledger copied via `just db-inspect`: descriptions still update during live work and after a session settles (Iterate-phase observation, plus `just model-eval` on demand).

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] Tune `SYNOPSIS_ACTIVITY_LINES` / `SYNOPSIS_INSTRUCTIONS` wording against retargeted `just model-eval` scores.
- [ ] Retire the two carry-forwards (the drop migration, the tenant-key copy) once no installation predates this release — each docblock names the condition.
- [ ] Whether `SYNOPSIS_MIN_INTERVAL` (60s) is right now that the description no longer waits on emits — revisit only on evidence of staleness or strobing.

| Checkpoint | Verification |
|------------|--------------|
| One ask | grep per #exit-criteria |
| No vestige | Spec S06 |
| Behavior preserved | paused-time suites + Iterate-phase observation |
