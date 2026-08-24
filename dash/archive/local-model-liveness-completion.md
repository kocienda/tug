## Local Model Liveness — Completion {#local-model-liveness-completion}

**Purpose:** Make the PULSE headline actually follow the work, then make the local-model path observable and bounded — a Swift file logger so the app can write where we already read, one structured line per inference request from both transports, per-task ceilings that mean something, and a batch analyzer that answers "is it fast enough, how often does it fail" from accumulated real usage.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-07-28 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

`dash/archive/local-model-liveness-brief.md` closed the PULSE two-level display work with five unchecked items. They amount to one complaint: the local-model path is unmeasured and unbounded, so nobody can say whether it is fast enough or how often it fails, even after using it all day. The brief also retired the fixed-corpus eval genre for headline *quality* — that decision stands and this plan does not reopen it.

Two things changed since the brief was written on 2026-07-28, and both narrow the work:

- **`CLASSIFY_TIMEOUT` already exists.** `tugrust/crates/tugcast/src/local_model.rs` now carries a 2s classify ceiling separate from the shared 10s `REQUEST_TIMEOUT`, unified with the deck's `LOCAL_MODEL_TIMEOUT_MS` and the composer's `VERDICT_SUBMIT_WAIT_MS` (both 2000). The brief's "split the per-task timeout" item is therefore half done: `summarize` still rides the shared transport deadline, and that half remains.
- **`tests/model-eval/` exists.** `just model-eval` drives the real path end to end — frozen digest → `tugutil host tell local_model_summarize` → live app → resident model → `headline_register` → the tugcast log. The brief's open question about which layer to drive a liveness test from is answered by a harness that already works.

The blocking discovery is about *where* measurement has to happen. The deck's shell-routing classify — the latency-critical task, the one with a person waiting — never touches tugcast. It posts over the `localModel` `WKScriptMessageHandler` (`tugapp/Sources/MainWindow.swift`) straight into Swift. Instrumenting tugcast's requester would leave that task reading zero forever. The only seam that sees both transports is `LocalModelService.handle` in `tugapp/Sources/LocalModelService.swift`, which `LocalModelBackend.swift` documents as the common decode target for the WebKit bridge and the control socket alike.

Swift's problem is that it logs with `NSLog`, which goes to Console and never reaches `tugcast.log.<date>` where `just logs-debug` reads. That is not a fact of nature — it is a missing facility. `InstanceConfig.logDir` already resolves the per-instance `Logs/` directory and currently has no readers. This plan gives Swift a real file logger there.

One more thing changed after the plan was first drafted, and it comes first in the work. The PULSE headline turned out to be *semantically* frozen: alive, inferring every 30–60 seconds, and saying the same thing for half an hour. The cause is a sentence in the summarize prompt instructing the model to report the session's lifetime goal rather than what is happening now, which contradicts the locked doctrine in the pulse-display gallery card. A headline that never moves is a liveness defect in the plainest sense, and there is little point measuring the turnaround of a feature that is not doing its job — so [#step-1] fixes it before any instrumentation lands. The evidence and the reasoning are in [#frozen-headline].

#### Strategy {#strategy}

- **Make the headline move before measuring how fast it arrives.** A constant headline is the liveness failure that matters most, and it is a prompt and digest problem, not an instrumentation one ([P10], [P11]).
- **Give Swift the ability to write to our log next.** Everything else in this plan is a log line, so the facility comes before the content ([P01]).
- **Instrument at the one seam that sees everything.** `LocalModelService.handle` covers both transports and every task ([P03]).
- **Record two perspectives, because they answer different questions.** Swift knows what inference cost; the caller knows whether it gave up waiting. Neither can see the other's fact ([P05]).
- **Write for batch analysis, not live aggregation.** No counters in memory, no dashboards. Structured lines that accumulate across days, and a script that reads them when there is enough to read ([P06]).
- **Keep thresholds provisional and say so.** Ship the brief's proposed numbers as starting shape, and let the analyzer be the thing that eventually moves them ([Q01]).
- **The liveness test is one digest through the harness that already works.** No new plumbing ([P08]).

#### Success Criteria (Measurable) {#success-criteria}

- The headline names the current stretch of work and changes when the work changes — verify by driving one session through two visibly different stretches and reading both headlines out of `just logs-debug`, and by the summarized-to-emitted ratio improving materially on the 47:16 baseline in [#frozen-headline].
- The headline's register survives the rewrite — verify `just model-eval` still scores 12/12 across all five checks.
- Swift writes to `<instance>/Logs/tugapp.log.<UTC-date>` in a format the same parser reads as `tugcast.log.*` — verify by launching `just app-debug` and confirming the file exists with a well-formed init line.
- Every inference request produces exactly one service-side line carrying `task`, `transport`, `outcome`, and `elapsed_ms` — verify by typing one shell-shaped line into the composer (bridge classify) and running `just model-eval` (socket summarize), then confirming both appear.
- A `summarize` that exceeds its own ceiling fails at that ceiling, not at 10s — verify with the unit test in `#step-4` and by the constant's value.
- `headline_register` reports whether it changed, budget-trimmed, or clipped the answer, and the emitter logs all three — verify by unit test plus a live emit.
- `just model-liveness` exits 0 with a naming skip message on a machine with no pack installed, and exits 0 after a real answer on one with a pack — verify both by temporarily pointing the pack probe at an empty directory.
- `just model-stats` reads accumulated logs and reports per-task outcome counts, duration percentiles, and normalizer work rate — verify against the logs this plan's own development produces.
- `just logs-debug` shows today's log after 5pm Pacific — verify by running it in the evening (it currently fails, see [#utc-date-bug]).

#### Scope {#scope}

1. The summarize prompt's subject and the digest's recency structure, so the headline tracks the current stretch of work.
2. A Swift file-logging facility writing into the per-instance `Logs/` directory, in tuglog's line format.
3. Service-side instrumentation of every local-model request at `LocalModelService.handle`.
4. Caller-side instrumentation in tugcast's `LocalModelRequester::request`, plus a `summarize` ceiling and per-task slow thresholds.
5. Normalizer work-rate reporting from `headline_register`.
6. An on-demand liveness smoke test that skips cleanly without a pack.
7. A batch analyzer over accumulated logs, exposed as a `just` recipe.
8. Fixing the UTC/local date bug in the three log-tailing recipes.

#### Non-goals (Explicitly out of scope) {#non-goals}

- **Any groundedness or quality eval over a fixture set.** Retired by the brief; daily usage is the groundedness. `tests/model-eval` scores *register*, not correctness, and that distinction holds.
- **Dev-panel Telemetry integration.** Deferred with rationale in [P07].
- **Deck-side (TypeScript) timeout instrumentation.** A bridge classify that overruns is inferable from the Swift line plus the known 2000ms deadline; a third logging surface is not worth it ([P05]).
- **Migrating the app's existing `NSLog` calls** to the new facility. The facility is general, but a sweep is separate work.
- **In-memory counters, live rollups, or a metrics endpoint.** [P06].
- **Setting the final thresholds.** They need real usage; the plan ships the instrument and leaves [Q01] open by design.
- **CI coverage of the live model path.** Needs a downloaded pack and real hardware; on-demand is the honest form.
- **Reopening the headline's register.** [#step-1] changes what the headline is *about*, not how it is worded. The verb-first, six-word, no-article rules and their eight examples stay byte-identical, and `just model-eval` guards them (Risk R03).
- **Re-scoring the model catalog** against the new `summarize` wording. The catalog's overview scores were already stale against two prior rewrites and are deliberately not maintained; the `LocalModelPrompts` docblock says why.
- **Rebalancing prompts against tool lines in the digest.** [#step-1] adds a recency split, not a new budget. `MAX_TOOL_LINES` and `MAX_PROMPTS` keep their values; the ratio question stays in [#roadmap].

#### Dependencies / Prerequisites {#dependencies}

- A downloaded local-model pack under `~/Library/Application Support/Tug/models/<id>/tug-manifest.json` for the liveness test and any live verification. Two are installed on the author's machine (`qwen3-4b-instruct-2507-4bit`, `ternary-bonsai-8b-2bit`).
- `tests/model-eval/` (landed in `ff4d1f061`) — `run.py`, `score.py`, `verbs.txt`, `corpus/`.
- The `pulse-overview` tenant switch left absent or true in the `dev.tugtool.local-model` tugbank domain (absent reads as enabled on all three of deck, Rust, and Swift).

#### Constraints {#constraints}

- **Warnings are errors** in the Rust workspace (`-D warnings` via `tugrust/.cargo/config.toml`).
- **The classify path must not get slower.** Any instrumentation on it emits *after* the reply is returned, never before ([P04]).
- **`tugapp` has no XCTest target.** Swift correctness is verified by building, by app-tests, and by observing real log output — steps are written accordingly.
- **Two processes must not write one log file.** tugcast's `tracing_appender` owns rotation of `tugcast.log.*`; a second writer would race it ([P02]).
- **`LocalModelPrompts` strings are frozen by default** per the rule in `LocalModelService.swift` — editing one invalidates the catalog's recorded scores for every entry at once. This plan breaks that freeze exactly once, for `summarize`'s subject sentence, as the deliberate act the rule exists to require ([P10]). `classify` and `generate` are untouched.

#### Assumptions {#assumptions}

- `tracing_appender::rolling::daily` names files by **UTC** date. Evidence: on 2026-07-28 at 17:36 PDT the live file was `tugcast.log.2026-07-29`. The Swift logger matches this so both files roll together.
- One line per request is a sustainable volume. Classify fires at most once per composer debounce; summarize is floored at 15s per session by `EMIT_FLOOR`.
- Availability probes are frequent (every window focus, via `LocalModelStore.refreshAvailability`) and cheap, so they log at `debug` rather than `info` ([P03]).

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] The real turnaround thresholds (DEFERRED BY DESIGN) {#q01-real-thresholds}

**Question:** What should `summarize`'s slow threshold and ceiling actually be, and is classify's 1s slow threshold right?

**Why it matters:** The brief's numbers are explicitly "shape, not measurement". A ceiling set too low turns a working feature into a failing one; set too high it never fires and the timeout means nothing.

**Options (if known):** The brief proposes ~3s slow / ~6s ceiling for summarize and ~1s for classify. Measured on 2026-07-28 against `ternary-bonsai-8b-2bit`: summarize round-trip median **1263ms** over the 12-digest eval corpus (digests 2.5–3.6k chars), and classify **~535ms** typical on the shell corpus. Both sit comfortably inside the proposed bounds.

**Plan to resolve:** Ship the proposed numbers, accumulate real lines, then run `just model-stats` over a week of genuine use and set them from the observed distribution. This is the explicit request behind this plan: *"write logs we can examine in batch mode later, after we have some real usage to study."*

**Resolution:** DEFERRED — the instrument ships in [#step-4] and [#step-7]; the numbers are set in a follow-on once there is data. Recorded in [#roadmap].

#### [Q02] Log retention for `tugapp.log.*` (OPEN) {#q02-log-retention}

**Question:** Should the new Swift log prune old files, and after how long?

**Why it matters:** `tugcast.log.*` files go back to 2026-05-28 in the author's `debug-main` instance with no pruning, so the precedent is "keep everything". Batch analysis over a long window is easier with retention, but the directory grows without bound.

**Options (if known):** Match tugcast (no pruning); prune beyond N days in the Swift logger; prune from a `just` recipe.

**Resolution:** OPEN — deliberately match tugcast's behavior (no pruning) for this phase, so the new file behaves exactly like the one beside it and analysis has the longest possible window. Revisit if the directory becomes a problem.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Instrumentation slows the classify path | high | low | Emit after the reply; measure with `just model-eval` before/after | Classify median rises above ~600ms |
| A `summarize` ceiling set too low breaks working headlines | med | low | 6s is ~5x the measured 1263ms median; the emitter already treats failure as back-off, not breakage | Timeout outcomes appear in `just model-stats` |
| Two writers race the log directory | high | low | Separate filename, separate rotation ([P02]) | Any interleaved or truncated line |
| Log volume grows unpleasantly | low | med | One line per request; availability at debug | Directory size becomes noticeable |
| Rewriting the summarize prompt regresses the register | med | med | Only the subject sentence changes; `just model-eval` scores register before and after | Any of the five register checks drops below 12/12 |

**Risk R01: The classify path is on a person's critical path** {#r01-classify-latency}

- **Risk:** Adding a synchronous file write inside `handle` would add I/O to the 2s budget the whole shell-routing feature depends on.
- **Mitigation:**
  - The metric line is emitted after the reply value is computed, and the logger's write is dispatched to a serial background queue rather than performed inline ([P04]).
  - `just model-eval` gives a before/after latency read on the same corpus, so the cost is measured rather than assumed.
- **Residual risk:** A queue backed up by an unrelated flood could delay a metric line's write. That loses a measurement, never an answer.

**Risk R02: Swift's log format drifting from tugcast's** {#r02-format-drift}

- **Risk:** The analyzer parses both files with one regex; a format mismatch silently drops half the data.
- **Mitigation:**
  - The format is pinned in [Spec S01](#s01-log-line-format) and asserted by the analyzer's own parse test against a captured sample of each file.
  - The analyzer reports how many lines it parsed per file, so a zero is visible rather than silent.
- **Residual risk:** A future change to tugcast's `fmt::layer()` configuration would break both together, which the parse test catches.

**Risk R03: The prompt rewrite costs the register that was just won** {#r03-register-regression}

- **Risk:** `LocalModelPrompts.summarize` is a single string, and a small quantized model responds to its whole shape. Editing the sentence that sets the subject could disturb the register rules that took verb-first from 1/12 to 12/12 and sentence case from 5/12 to 12/12.
- **Mitigation:**
  - The edit is scoped to the opening two lines. The rules block and all eight examples are left byte-identical ([P10]).
  - `just model-eval` scores exactly the five register properties over twelve digests and is run before and after ([#step-1]'s checkpoint). It is a direct guard, not a proxy.
  - The examples are all imperative-verb-first, so they reinforce the register independently of what the opening sentence asks the headline to be *about*.
- **Residual risk:** The register could hold on the twelve fixed corpus digests and drift on live sessions. The normalizer's work rate ([#step-6]) is the standing read that would show it, and the normalizer imposes the form in Rust regardless of what the model answers.

---

### Design Decisions {#design-decisions}

#### [P01] Swift gets a real file logger, not a control-socket relay (DECIDED) {#p01-swift-file-logger}

**Decision:** Add `tugapp/Sources/TugLog.swift`, a small logging facility that writes to `InstanceConfig.logDir` in tuglog's line format, and use it for local-model instrumentation.

**Rationale:**
- The alternative considered was having Swift report metrics up the existing `ProcessManager.sendControl(action:params:)` channel for tugcast to log. That routes a logging concern through an IPC channel, makes the app's observability depend on tugcast being connected, and adds a control verb whose only purpose is to reach a file the app can open directly.
- `InstanceConfig.logDir` already exists and resolves the per-instance `Logs/` directory. It currently has no readers in Swift — the facility is the missing half, not the directory.
- `NSLog` is not an immovable constraint. It writes to Console, which is not where anyone reads Tug's logs, and that is a gap worth closing generally rather than working around once.

**Implications:**
- The app gains a general logging facility; local-model metrics are its first client. Migrating existing `NSLog` call sites is explicitly out of scope ([#non-goals]).
- The facility must be safe to call from any actor/queue, so it serializes writes internally.

#### [P02] A separate file, in the same directory, in the same format (DECIDED) {#p02-separate-file}

**Decision:** Swift writes `tugapp.log.<UTC-date>`, beside `tugcast.log.<UTC-date>`, rolling daily by UTC date, with lines matching [Spec S01](#s01-log-line-format).

**Rationale:**
- Appending to `tugcast.log.*` from a second process would race `tracing_appender`'s rotation and buffering. Two writers, one rotating, is a corruption pattern.
- Same directory and same format is what makes them *one* log for reading purposes: `just logs-debug` tails both, and the analyzer parses both with one regex.
- UTC rotation matches tugcast so the two files roll at the same instant and a day's data is never split across a boundary in one file but not the other.

**Implications:**
- `just logs-debug` and `just logs-release` tail two files ([#step-3]).
- The analyzer takes a directory, not a file.

#### [P03] `LocalModelService.handle` is the instrumentation seam (DECIDED) {#p03-handle-seam}

**Decision:** Rename the existing body of `handle(_:)` to `perform(_:)` and make `handle(_:)` a thin instrumented wrapper that times the call and emits one line.

**Rationale:**
- It is the only place that sees both transports. `MainWindow.swift` (WebKit bridge, deck classify) and `ProcessManager.swift` (control socket, tugcast summarize + diagnostic classify) are its only two callers, and `LocalModelBackend.swift` documents `LocalModelRequest` as the common decode target for exactly this reason.
- Instrumenting tugcast's requester alone would leave production shell-routing classify — the task the brief most wants bounded, because a person is waiting on it — permanently invisible.
- A wrapper changes no call sites and cannot miss a `return` path, which a scatter of inline timers would.

**Implications:**
- Every request kind flows through, including `.availability` and `.prewarm`. Availability logs at `debug` because it fires on every window focus and performs no inference; the rest log at `info`.
- The wrapper needs the transport, which the caller knows and the request does not. `LocalModelRequest` gains a `transport` field set at each of the two call sites.

#### [P04] The metric is emitted after the answer, never before (DECIDED) {#p04-emit-after-answer}

**Decision:** `handle` computes the reply, captures the elapsed time, and emits the line after the value is in hand; the logger's actual file write happens on a serial background queue.

**Rationale:**
- Classify sits between Return and the line going somewhere, with a 2s budget unified across the deck bridge, the composer wait, and tugcast. Measurement that costs latency defeats the thing it measures.
- Nothing downstream reads the metric line, so there is no ordering requirement that would justify a synchronous write.

**Implications:**
- `TugLog` buffers on a serial queue and flushes there. A crash can lose the last few lines, which is an acceptable trade for never adding I/O to the critical path.

#### [P05] Two perspectives are recorded, because neither can see the other's fact (DECIDED) {#p05-two-perspectives}

**Decision:** Emit a service-side line from Swift (what inference cost) and a caller-side line from tugcast's `LocalModelRequester::request` (what the caller waited for, and whether it gave up).

**Rationale:**
- Swift finishes eventually and never learns that its caller timed out — from the service's side a slow success and a timeout look identical.
- tugcast sees the timeout but not why: it cannot distinguish a slow model from a busy queue from a wedged app.
- The gap between the two durations *is* the transport and queueing cost, which is only knowable by having both.
- Deck-side (TypeScript) observation is deliberately not added: a bridge classify that overran its 2000ms deadline is inferable from the service-side `elapsed_ms` plus the known deadline, which the analyzer applies.

**Implications:**
- Two line shapes in [Spec S01](#s01-log-line-format), distinguished by message text, correlated by `task` and time rather than by a shared id (adding a correlation id to the wire protocol is not worth it for this).

#### [P06] Written for batch analysis; no live aggregation (DECIDED) {#p06-batch-not-live}

**Decision:** Emit per-request lines only. No in-memory counters, no periodic rollup lines, no metrics endpoint. Aggregation is a script (`just model-stats`) run over accumulated files whenever there is enough data.

**Rationale:**
- Directly requested: *"Let's write logs we can examine in batch mode later, after we have some real usage to study."*
- A rollup emitted every N minutes answers "what happened recently", which is the wrong window for a question about whether a feature is fast enough in daily use.
- Per-request lines are strictly more informative than any rollup computed from them, and the aggregation can be rewritten without redeploying the app.

**Implications:**
- Field names are a contract the analyzer depends on; they are pinned in [Spec S01](#s01-log-line-format).
- Answering "how often does it fail" requires running the analyzer, not reading the log directly. That is the intended workflow.

#### [P07] No dev-panel Telemetry integration in this phase (DECIDED) {#p07-no-dev-panel}

**Decision:** The numbers surface as structured log lines read via `just logs-debug` and `just model-stats`. The dev panel's Telemetry tab is not extended.

**Rationale:**
- The brief said to prefer tracing "unless the panel turns out to be nearly free". It is not. `TelemetryInspector` is card-scoped and turn-scoped: it reads `cardServicesStore.getServices(cardId)` and projects a single card's session state. Local-model metrics are process-scoped and span every card.
- Surfacing them there means a new store, a new tugcast→deck channel, and a new tab section whose data has no card to hang from — a feature in its own right, for a question a `grep` answers today.

**Implications:**
- Promotion to the panel stays available later and is listed in [#roadmap].

#### [P08] The liveness test rides the existing eval harness (DECIDED) {#p08-liveness-in-model-eval}

**Decision:** Implement the liveness smoke test as `tests/model-eval/liveness.py`, exposed as `just model-liveness`, sharing the runner's plumbing via a new `tests/model-eval/harness.py`.

**Rationale:**
- The brief left the driving layer open and suggested the CONTROL `local_model_summarize` action was worth looking at first. It is exactly what `tests/model-eval/run.py` already uses, proven across a full corpus.
- The Rust-integration-test option cannot work as a `cargo test`: it needs a live Tug.app on the other end of the control socket.
- The app-test option cannot reach the model path usefully — app-tests run against a transient replay-session workspace, and the emitter's cadence floor (15s) plus the model load exceed what an app-test should hold open.
- Liveness and register-scoring are the same family of question ("is the live model doing its job"), so they belong in the same directory with the same entry style.

**Implications:**
- `run.py`'s `log_path` / `answers` / `ask` move to `harness.py`; `run.py` imports them. This is a refactor with no behavior change, verified by re-running `just model-eval`.
- The test skips, not fails, when no pack is installed — a test that fails on a machine without a model is one people learn to ignore.

#### [P09] Classify keeps its 2s ceiling and gains a 1s slow threshold (DECIDED) {#p09-classify-ceiling-stays}

**Decision:** `CLASSIFY_TIMEOUT` stays at 2s. The brief's proposed ~1s classify ceiling becomes a *slow threshold* instead.

**Rationale:**
- 2s is not one constant but three, unified deliberately: `CLASSIFY_TIMEOUT` (tugcast), `LOCAL_MODEL_TIMEOUT_MS` (`tugdeck/src/lib/local-model-bridge.ts`), and `VERDICT_SUBMIT_WAIT_MS` (`tug-prompt-entry.tsx`). Lowering one silently makes it the real deadline and the other two unreachable — the exact defect that made the bridge's old 1500ms value the true budget.
- Measured classify is ~535ms, so a 1s threshold flags genuine drift while 2s remains the point past which waiting is worse than guessing Claude.

**Implications:**
- The brief's provisional table is amended here rather than followed literally; [#turnaround-table] records both.

#### [P10] The headline names the current phase, read against the goal (DECIDED) {#p10-current-phase}

**Decision:** `LocalModelPrompts.summarize` stops asking for the session's lifetime goal and starts asking for the current stretch of work, read against what the user asked for. The register rules in the rest of the prompt are untouched.

**Rationale:**
- The locked doctrine in `tugdeck/src/components/tugways/cards/gallery-pulse-display.tsx` defines the intent level as *"the model's reading of the goal **and what is going on now**, at a high level."* The shipped prompt says *"the goal, **not** the latest single action."* Those are opposites, and the prompt is the one that drifted.
- A headline that reports only the lifetime goal is *correct* to be constant, because the goal is constant. Liveness was instructed out of existence rather than lost to a bug — see [#frozen-headline] for the log evidence.
- The register is not the problem and is not being reopened. Verb-first went from 1/12 to 12/12 and sentence case from 5/12 to 12/12 on the current wording; only the sentence naming the *subject* changes.
- "The latest single action" remains correctly excluded — that is the activity level's job, already shipped on both surfaces. The headline sits between the single tool call and the lifetime goal, which is exactly the level the gallery card calls "at a high level".

**Implications:**
- The freeze rule in the `LocalModelPrompts` docblock is not waived; this is the deliberate act it exists to require. The docblock records the rewrite, as it already does for the two before it.
- The catalog's recorded overview scores were already stale against two prior rewrites and are explicitly not being refreshed; the docblock says why.
- `tests/model-eval` becomes the regression guard rather than a casualty: it scores register, register is unchanged, so a drop in its score means the edit reached further than intended (Risk R03).

#### [P11] The digest marks what is recent (DECIDED) {#p11-digest-recency}

**Decision:** `compose_digest` gains a third section separating tool lines that arrived since the last overview from the standing background, and takes a `recent_tools: usize` count to make the split.

**Rationale:**
- Asking for "now" is useless if the digest cannot express which lines are now. Today all 40 tool lines arrive under one undifferentiated heading in arrival order, with nothing marking the boundary the model is being asked to find.
- The data is not the shortfall — measured across the twelve corpus digests, the tool half outweighs the prompt half 2–3:1 in every real session (`app-self-update` 2217 vs 628 characters, `splash-screen-stall` 1995 vs 640). The freshest material is already the bulk of what the model reads. It is unlabeled, not absent.
- The count is carried rather than a timestamp because the emitter already has it for free: `SessionState` sees every beat and knows exactly how many tool lines it has recorded since it last committed a tick.
- Three sections is the ceiling. A small quantized model given four or five headings starts answering about the headings; the prompt-half stays one list.

**Implications:**
- `compose_digest`'s signature changes, so `corpus_digests_are_what_compose_digest_produces` fails until the corpus is regenerated. That test exists precisely to catch this, and the corpus JSONs gain a `recent_tools` field.
- The `last_digest` dedupe gains real teeth: an idle session now produces an identical digest and skips the inference entirely, where today the rolling deque made the digest differ by one line and paid for a re-summary that produced the same headline.

---

### Deep Dives {#deep-dives}

#### The headline was frozen by its own prompt {#frozen-headline}

The symptom reported was that the PULSE's first part is written once and then never changes. The emitter is not stuck, and neither is the transport or the deck. Reading `release-main`'s `tugcast.log.2026-07-29` on 2026-07-28, one session (`4eb21996`) produced **15 summarize calls in 31 minutes**, each a real inference at ~1.5s, each delivered:

```
01:11  Fix local-model bring up work
01:12  Fix local-model bring up work      (and four more identical)
01:18  Fix local model pulse silence
01:23  Fix local-model bring up work      (back again)
01:24  Fix local-model liveness issues
01:41  Fix local-model liveness work
01:42  Fix local-model liveness pulse
01:42  Fix local-model liveness overview
```

Half an hour spanning plan authoring, validator runs, Swift reading and corpus scoring, and the line says `Fix local-model …` throughout, moving only by a synonym in the last slot. Across both live sessions that day: **47 inferences, 16 emits** — two thirds of every inference discarded by the `last_headline` dedupe. That ratio is the measurable signature of the defect and the number [#step-1]'s checkpoint moves.

Everything downstream checks out and needs no change:

- `pulse-store.ts` `foldOverview` replaces the entry for every named scope outright — newest wins, no monotonic beat gate, no dedupe of its own.
- The emitter's own `session overview: emitted receivers=1` lines confirm delivery.
- The cadence gate is firing freely: 15 ticks in 31 minutes against a 15s floor.

The cause is one sentence in `LocalModelPrompts.summarize`: *"Say what the session is DOING overall — the goal, not the latest single action."* It was added during the headline-register rewrite that fixed the label-headline problem, and it instructs the model to ignore recency. A line reporting only the lifetime goal is correct to be constant. [P10] replaces the sentence; [P11] gives the digest the recency structure that makes the replacement answerable.

#### Where each request is actually visible {#request-visibility}

The two transports and what each layer can observe:

```
deck composer ──WKScriptMessageHandler "localModel"──▶ LocalModelService.handle ──▶ MLX
  (classify)      MainWindow.swift                       ▲                            │
  2000ms budget                                          │                            │
                                                         │                            ▼
tugcast emitter ──control socket──▶ ProcessManager ──────┘        reply ──────────────┘
  (summarize)      LocalModelRequester::request
  ceiling per task
```

| Fact | Deck | tugcast | Swift service |
|---|---|---|---|
| Bridge classify happened at all | yes | **no** | yes |
| Socket summarize happened | no | yes | yes |
| What inference cost | no | partly (includes transport) | **yes** |
| Whether the caller gave up | yes (bridge) | yes (socket) | **no** |

The two **no**s in the Swift column and the **no** in tugcast's classify row are why [P05] records both sides, and why [P03] puts the service-side seam in Swift rather than tugcast.

#### The UTC date bug in the log recipes {#utc-date-bug}

`just logs-debug`, `just logs-release`, and `just tail-replay` all compute `DATE="$(date +%Y-%m-%d)"` — the **local** date — and then open `tugcast.log.$DATE`. `tracing_appender::rolling::daily` names by **UTC**. West of Greenwich the two disagree for the last hours of every day: at 17:36 PDT on 2026-07-28 the live file was `tugcast.log.2026-07-29`, and the recipe printed `no log for debug-main … has the instance run today?` against a running instance.

The same defect bit this plan's own author in `tests/model-eval/run.py`, where it was fixed by selecting the newest file by mtime rather than computing a date at all. The recipes take the same fix, which also removes the question of which timezone the appender uses.

`tail-replay` carries a second, separate defect: it reads the legacy single-instance path `~/Library/Application Support/Tug/Logs/` rather than the per-instance directory, so it has not followed a real instance since multi-instance landed. It is fixed alongside.

#### Why `headline_register` has to report rather than just return {#normalizer-reporting}

`headline_register` in `tugrust/crates/tugcast/src/feeds/session_overview.rs` is a pure `&str -> String`. It applies, in order: quote stripping, filler-opener stripping, leading-article stripping, whitespace collapse, terminal-period removal, `trim_to_word_budget` (6 words, cutting at the earliest joiner), then `clip` (56 chars).

The brief wants the *work rate* — how often it changed the string at all, and how often it had to clip — because [Q01] of the display plan leans on it: *"if clipping is common at 56 the model is not in register."* A `String` return cannot express that.

The measurement already has a first reading. On 2026-07-28, `just model-eval` over 12 digests showed 3 answers needing the normalizer, **all three of them word-budget trims and none of them character clips**. The longest normalized headline was 41 characters against a 56-char budget. That suggests the word budget now binds before the character budget ever does, which would resolve the display plan's [Q01] — but one run of 12 is not the evidence to close it on, which is precisely why this becomes a standing measurement.

Distinguishing `trimmed` from `clipped` is therefore the point: they are different failures. A trim means the model wrote a parts list; a clip means it wrote prose.

---

### Specification {#specification}

**Spec S01: Log line format** {#s01-log-line-format}

Both files use tuglog's `fmt::layer()` default shape, which the analyzer parses with one regex:

```
<ISO8601-UTC>  <LEVEL> <target>: <message> <field>=<value> <field>=<value>
```

Example of an existing tugcast line:

```
2026-07-29T00:23:31.570476Z  INFO tugcast::feeds::session_overview: session overview: emitted session=9cabadbf beat=1 receivers=1
```

**Service-side line** (Swift, `tugapp.log.*`), target `tugapp::local_model`, message `local model request`:

| Field | Values | Notes |
|---|---|---|
| `task` | `classify` \| `summarize` \| `generate` \| `prewarm` \| `availability` | From `LocalModelRequest.Kind` |
| `transport` | `bridge` \| `socket` | Set by the caller ([P03]) |
| `outcome` | `ok` \| `refused` \| `not_resident` \| `error` | `not_resident` is classify's fast-fail |
| `elapsed_ms` | integer | Wall time inside `perform` |
| `input_chars` | integer | Prompt/text length |
| `output_chars` | integer | Answer length; 0 when not `ok` |
| `model` | string | Resident pack id, or `none` |
| `slow` | `true` | **Present only when over the task's slow threshold** |

`availability` logs at `debug`; every other task at `info`.

**Caller-side line** (Rust, `tugcast.log.*`), target `tugcast::local_model`, message `local model call`:

| Field | Values | Notes |
|---|---|---|
| `task` | `classify` \| `summarize` \| `generate` | The `task` string sent on the wire |
| `outcome` | `ok` \| `refused` \| `timed_out` \| `dropped` \| `unavailable` | `timed_out` is the fact only this side knows |
| `elapsed_ms` | integer | Wall time around the whole request, including transport |
| `slow` | `true` | Present only when over the task's slow threshold |

**Normalizer fields**, added to the emitter's existing `session overview: summarized` line in `session_overview.rs`:

| Field | Values | Notes |
|---|---|---|
| `normalized` | `true` \| `false` | The register function changed the string at all |
| `trimmed` | `true` \| `false` | The word budget cut a tail |
| `clipped` | `true` \| `false` | The 56-char budget clipped |

**Table T01: Turnaround bounds** {#turnaround-table}

| Task | Slow threshold | Ceiling | Where the ceiling lives | Status |
|---|---|---|---|---|
| `classify` | 1s (new) | 2s (existing) | `CLASSIFY_TIMEOUT`, mirrored by `LOCAL_MODEL_TIMEOUT_MS` and `VERDICT_SUBMIT_WAIT_MS` | Ceiling already landed; keep ([P09]) |
| `summarize` | 3s (new) | 6s (new) | `SUMMARIZE_TIMEOUT`, new in `local_model.rs` | This plan |
| `generate` | — | 10s | `REQUEST_TIMEOUT`, unchanged | Fallback for any task without its own |

All four new numbers are provisional per [Q01]. `summarize`'s 6s ceiling is chosen to sit well under `EMIT_FLOOR` (15s in `session_overview.rs`) so the emitter's cadence stays designed rather than inference-bound.

**Spec S02: Liveness smoke test contract** {#s02-liveness-contract}

`just model-liveness [INSTANCE]`, default instance `debug-main`.

Preconditions, each producing a **skip with exit 0** and a naming message:

1. No pack installed — no `~/Library/Application Support/Tug/models/*/tug-manifest.json`. Message names Tug ▸ **Set Up Tug…** as the way to get one.
2. No running instance — the id is absent from `tugutil host instance list` output. The raw `$TMPDIR/tug-instances.json` is deliberately **not** read: the registry's doctrine (`tugcore/src/registry.rs`) is that dead entries are pruned at read time through the library — "live" means `kill(pid, 0) == 0` — so a crashed instance leaves a stale entry in the file that only the library-mediated read filters out. Parsing the raw JSON would see that entry, conclude the instance is up, and turn a should-skip into a spurious failure. Message names `just app-debug`.

The check itself: send one corpus digest (`tests/model-eval/corpus/one-line-goal.digest.txt`) through `tugutil host tell local_model_summarize` and read the answer from the log.

**Fails (exit 1) only on:** no answer within the timeout; an empty headline; an answer slower than the `summarize` ceiling from [Table T01](#turnaround-table).

**Reports but does not fail on:** the normalizer having had to change the answer. Per the brief — *"if the normalizer had to fix it, that is worth seeing, not failing on."*

**Asserts nothing about what the headline says.** That is the owner's eye.

**Spec S03: Digest shape** {#s03-digest-shape}

`compose_digest(prompts, tools, recent_tools)` composes at most three labeled sections, in this order, each a `- ` bulleted list. `recent_tools` is clamped to `tools.len()`; the trailing `recent_tools` entries are *recent*, the rest are *background*.

```
What the user asked for:
- <prompt 1>            ← oldest first, newest last; existing behavior, 240-char clip
- <prompt 2>

What the session has been doing:
- <background tool line>    ← tools[..tools.len() - recent_tools]

What it is doing right now:
- <recent tool line>        ← tools[tools.len() - recent_tools..]
```

Rules:

- A section with no entries is **omitted entirely**, heading and all — the existing rule for the prompt and tool halves, extended to the split. `recent_tools == tools.len()` (a session's first overview) therefore yields no background section; `recent_tools == 0` yields no *right now* section.
- Sections are separated by a blank line; no line appears in more than one section.
- Both halves empty still returns `None`. Prompts-only and tools-only both still compose. These are existing guarantees and this change must not touch them.
- The prompt half stays one list. Marking the newest prompt would be a fourth heading, and three is the ceiling ([P11]).

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tugapp/Sources/TugLog.swift` | Swift file-logging facility writing to `InstanceConfig.logDir` ([P01], [P02]) |
| `tests/model-eval/harness.py` | Shared plumbing extracted from `run.py` ([P08]) |
| `tests/model-eval/liveness.py` | The on-demand liveness smoke test ([Spec S02](#s02-liveness-contract)) |
| `tests/model-eval/analyze.py` | Batch analyzer over accumulated logs ([P06]) |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `TugLog` | enum | `tugapp/Sources/TugLog.swift` | `info`/`debug`/`warn`/`error`; serial write queue ([P04]) |
| `TugLog.field(_:_:)` | fn | `tugapp/Sources/TugLog.swift` | Builds `key=value` pairs in [Spec S01](#s01-log-line-format) order |
| `LocalModelRequest.transport` | property | `tugapp/Sources/LocalModelBackend.swift` | `bridge` \| `socket`, set at both call sites ([P03]) |
| `LocalModelService.perform(_:)` | fn | `tugapp/Sources/LocalModelService.swift` | The former body of `handle(_:)` |
| `LocalModelService.handle(_:)` | fn | `tugapp/Sources/LocalModelService.swift` | Instrumented wrapper ([P03], [P04]) |
| `SUMMARIZE_TIMEOUT` | const | `tugrust/crates/tugcast/src/local_model.rs` | 6s ([Table T01](#turnaround-table)) |
| `SUMMARIZE_SLOW` / `CLASSIFY_SLOW` | const | `tugrust/crates/tugcast/src/local_model.rs` | 3s / 1s |
| `LocalModelRequester::request` | fn | `tugrust/crates/tugcast/src/local_model.rs` | Emits the caller-side line ([P05]) |
| `LocalModelPrompts.summarize` | const | `tugapp/Sources/LocalModelService.swift` | Opening two lines rewritten; register rules untouched ([P10]) |
| `compose_digest` | fn | `tugrust/crates/tugcast/src/feeds/session_overview.rs` | Gains `recent_tools: usize`; three-section output ([Spec S03](#s03-digest-shape)) |
| `SessionState.tools_since_emit` | field | `tugrust/crates/tugcast/src/feeds/session_overview.rs` | Tool beats since the last committed tick ([P11]) |
| `HeadlineReport` | struct | `tugrust/crates/tugcast/src/feeds/session_overview.rs` | `text`, `normalized`, `trimmed`, `clipped` |
| `headline_register_report` | fn | `tugrust/crates/tugcast/src/feeds/session_overview.rs` | New; `headline_register` becomes a wrapper over it |
| `model-liveness` / `model-stats` | recipe | `Justfile` | New entries beside `model-eval` |
| `logs-debug` / `logs-release` / `tail-replay` | recipe | `Justfile` | Newest-file selection ([#utc-date-bug]) |

---

### Documentation Plan {#documentation-plan}

- [ ] `tests/model-eval/README.md` — document the three-section digest and the corpus `recent_tools` field ([#step-1]); add the liveness check and the analyzer, and say plainly that register-scoring, liveness, and turnaround are three different questions sharing one harness.
- [ ] `tugapp/Sources/LocalModelService.swift` — the `LocalModelPrompts` docblock records the `summarize` rewrite and what it changed (the subject, not the register), keeping the freeze rule's audit trail intact ([P10]).
- [ ] `tugrust/crates/tugcast/src/feeds/session_overview.rs` — `compose_digest`'s docblock states the three sections and what `recent_tools` means ([Spec S03](#s03-digest-shape)).
- [ ] `dash/archive/local-model-liveness-brief.md` — tick the work items this plan closes and add a pointer to this plan for the ones it deliberately leaves open ([Q01], [P07]).
- [ ] `tugapp/Sources/TugLog.swift` module docblock — where it writes, why it is a separate file from `tugcast.log` ([P02]), and that it is general rather than local-model-specific.
- [ ] `tugrust/crates/tugcast/src/local_model.rs` — the timeout constants' docblock states which bound is a transport deadline and which is a performance budget.

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit (Rust)** | `headline_register_report`'s three flags; timeout constants' relationships | `cargo nextest run -p tugcast` |
| **Unit (Python)** | The analyzer's line parser against captured real lines from both files | `python3 tests/model-eval/analyze.py --self-test` |
| **On-demand live** | Liveness; register scoring; turnaround | `just model-liveness`, `just model-eval` |
| **Manual observation** | Swift log lines appearing for both transports | Type into the composer; run `just model-eval`; read the log |

#### What stays out of tests {#test-non-goals}

- **Headline quality / groundedness** — retired by the brief; daily usage is the groundedness. `tests/model-eval` scores register only.
- **Swift unit tests** — `tugapp` has no XCTest target; the logger is verified by observing real output, which is also the only thing that proves the file path and format are right.
- **CI coverage of the live model path** — needs a pack and real hardware.
- **Fake-DOM / RTL tests and mock-store assertion tests** — banned in this repo, and nothing here needs them.
- **A test that the analyzer's *numbers* are correct** — it is a reporting tool over real data; its parser is tested, its arithmetic is not worth pinning.

---

### Execution Steps {#execution-steps}

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Make the headline track the current phase | done | `de2416c24` |
| #step-2 | Swift file logger | done | `da9340fd7` |
| #step-3 | Fix the log-tailing recipes | done | `21742af6a` |
| #step-4 | Instrument the Swift service seam | done | `095b6eb63` |
| #step-5 | Summarize ceiling + caller-side line | done | `62ab5914f` |
| #step-6 | Normalizer work-rate reporting | done | `ae1527599` |
| #step-7 | Liveness smoke test | done | `532000130` |
| #step-8 | Batch analyzer | done | `452f0af04` |
| #step-9 | Integration checkpoint | done | `db61f95c6` |

---

#### Step 1: Make the headline track the current phase {#step-1}

**Commit:** `tugcast(pulse-headline): let the headline follow the work instead of the goal`

**References:** [P10] Headline names the current phase, [P11] The digest marks what is recent, [Spec S03](#s03-digest-shape), (#frozen-headline), Risk R03

**Artifacts:**
- `tugapp/Sources/LocalModelService.swift` — `LocalModelPrompts.summarize` and the type docblock above `enum LocalModelPrompts`
- `tugrust/crates/tugcast/src/feeds/session_overview.rs` — `compose_digest`, `SessionState`, `session_overview_task`
- `tests/model-eval/corpus/*.json` and `tests/model-eval/corpus/*.digest.txt`
- `tests/model-eval/README.md`

**Tasks:**
- [ ] In `LocalModelPrompts.summarize`, replace the opening pair of lines — currently `You write the headline for a live coding session. Say what the session is DOING overall — the goal, not the latest single action.` — with wording that asks for the current stretch of work read against the user's goal, and that says explicitly the headline is expected to change as the work moves on ([P10]). **Change nothing else in the string**: the register rules below it (verb-first, six words, no articles, no `and`, sentence case, the eight examples) are what took verb-first from 1/12 to 12/12 and are not in question ([#frozen-headline]).
- [ ] Update the `summarize` paragraph of the docblock above `enum LocalModelPrompts` to record this as the third rewrite and say what it changed — the subject, not the register. The freeze rule stated in that docblock still holds and is the reason this is a deliberate edit rather than a drive-by.
- [ ] Add `tools_since_emit: usize` to `SessionState`. Increment it in `record` for `SessionBeat::Tool` only; reset it to 0 in `session_overview_task` at the same place `new_frames` resets, so it counts tool lines accumulated since the last committed tick.
- [ ] Change `compose_digest(prompts: &[String], tools: &[String])` to `compose_digest(prompts: &[String], tools: &[String], recent_tools: usize)`, emitting the three-section shape in [Spec S03](#s03-digest-shape). `recent_tools` is clamped to `tools.len()` by the function, so a caller can pass a count larger than the deque without producing a wrong split.
- [ ] Pass `state.tools_since_emit` at the call site. Read it before the `await` on `summarize`, alongside the existing `state.tools` clone — the map is re-borrowed after the await and the pre-await values are the ones the digest was built from.
- [ ] Keep the `last_digest` dedupe exactly as it is. It now does real work: an idle session produces an empty *right now* section and therefore an unchanged digest, which skips the inference entirely rather than paying for a headline that cannot have changed.
- [ ] Add a `recent_tools` number to each `tests/model-eval/corpus/*.json` fixture. For the six real-session entries set it to the trailing slice that represents one tick's worth of work (5–10 lines); for the six synthetic entries choose whatever exercises the entry's point, including `0` for `conversation-only` and the full count for `tools-without-prompts`.
- [ ] Read it in `corpus_digests_are_what_compose_digest_produces` — the test already parses each fixture as a `serde_json::Value` with a local `strings(key)` helper, so this is one `body["recent_tools"].as_u64()` beside it, defaulting to 0 when absent.
- [ ] Regenerate the frozen digests with `TUG_REGENERATE_DIGESTS=1 cargo nextest run -p tugcast corpus_digests` and commit them. The `corpus_digests_are_what_compose_digest_produces` test **will fail before this** — that is the pin working, not a defect, and regenerating is the intended response.
- [ ] Update `tests/model-eval/README.md` to describe the three-section digest, so the corpus fixture format is documented where the corpus lives.

**Tests:**
- [ ] Unit test: `compose_digest` with `recent_tools` between 1 and `tools.len()` emits all three sections, with the recent lines appearing **only** in the third and the background lines only in the second — no line is repeated across sections.
- [ ] Unit test: `recent_tools == tools.len()` (a session's first overview) emits no background section, and `recent_tools == 0` emits no *right now* section.
- [ ] Unit test: `recent_tools` greater than `tools.len()` is clamped rather than panicking.
- [ ] Unit test: prompts-only and tools-only inputs still compose, and the both-empty case still returns `None` — the existing guarantees this step must not break.
- [ ] Unit test: `tools_since_emit` counts `Tool` beats and ignores `Turn` beats.
- [ ] `corpus_digests_are_what_compose_digest_produces` green against the regenerated corpus.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast` green.
- [ ] `just model-eval` still scores 12/12 on register — verb-first, within budget, no article, no `and`, sentence case. This is the guard on Risk R03: the step changes the headline's *subject*, and any drop here means it changed the register too.
- [ ] Drive one real session through two visibly different stretches of work (read some files, then run a build) and confirm from `just logs-debug` that the emitted headline names each in turn, rather than restating the session's opening goal both times.
- [ ] Over that run, the ratio of `session overview: summarized` lines to `session overview: emitted` lines is materially better than the 47:16 recorded in [#frozen-headline] — most inferences should now produce a line worth sending.

---

#### Step 2: Swift file logger {#step-2}

**Commit:** `tugapp(logging): give Swift a real log file beside tugcast's`

**References:** [P01] Swift file logger, [P02] Separate file same format, [P04] Emit after the answer, [Spec S01](#s01-log-line-format), [Q02] Log retention, (#context)

**Artifacts:**
- `tugapp/Sources/TugLog.swift`

**Tasks:**
- [ ] Add `TugLog` writing to `InstanceConfig.logDir` (already defined in `tugapp/Sources/InstanceConfig.swift` as `<data-dir>/Logs/`, currently with no Swift readers). Create the directory if absent.
- [ ] Filename `tugapp.log.<YYYY-MM-DD>` using the **UTC** date, matching `tracing_appender::rolling::daily` ([P02]). Re-check the date on each write so a long-running app rolls at midnight UTC.
- [ ] Emit lines in [Spec S01](#s01-log-line-format)'s format: ISO8601-UTC timestamp with microseconds and trailing `Z`, two spaces, right-aligned 5-char level, space, target, `: `, message, then `key=value` pairs.
- [ ] Levels `debug`/`info`/`warn`/`error`, with a threshold read once from the `TUG_LOG` environment variable, defaulting to `info` — mirroring tuglog's `RUST_LOG` handling.
- [ ] Serialize writes on a private serial `DispatchQueue` and dispatch asynchronously, so no caller ever waits on file I/O ([P04]).
- [ ] Open the file handle once and append; do not re-open per line.
- [ ] No pruning of old files, matching tugcast ([Q02]).
- [ ] Register the target as `tugapp::<subsystem>` so the analyzer's regex treats both files identically.
- [ ] Log one init line at startup (`log_file=<path>`), mirroring tuglog's `tuglog initialized`, so the file is never zero-length and its path is self-documenting.

**Tests:**
- [ ] No Swift unit test is possible (no XCTest target, see [#test-non-goals]); the checkpoint is observation of real output.

**Checkpoint:**
- [ ] `just app-debug` builds and launches with no warnings.
- [ ] `ls "$HOME/Library/Application Support/Tug/instances/debug-main/Logs/"` shows a `tugapp.log.<date>` whose date matches the newest `tugcast.log.*`.
- [ ] The init line parses with the same regex as a `tugcast.log` line — confirm by eye that the timestamp, level, and target columns align with a tugcast line.

---

#### Step 3: Fix the log-tailing recipes {#step-3}

**Depends on:** #step-2

**Commit:** `tug(logs): select the newest log file instead of guessing today's date`

**References:** [P02] Separate file same format, (#utc-date-bug)

**Artifacts:**
- `Justfile` — `logs-debug`, `logs-release`, `tail-replay`

**Tasks:**
- [ ] Replace `DATE="$(date +%Y-%m-%d)"` and the `$LOG` construction in all three recipes with selection of the **newest** `tugcast.log.*` by modification time, removing the timezone question entirely ([#utc-date-bug]).
- [ ] `logs-debug` and `logs-release` tail both `tugcast.log.*` and `tugapp.log.*` (newest of each), so one command shows the whole system ([P02]). Tail the app log only if it exists, so a build predating [#step-2] still works.
- [ ] Fix `tail-replay` to read the per-instance directory via `bash tugrust/scripts/instance-id-from-cwd.sh debug` — it currently reads the legacy single-instance path `~/Library/Application Support/Tug/Logs/` and has not followed a real instance since multi-instance landed.
- [ ] Keep each recipe's existing "no log yet" message and non-zero exit when nothing matches.

**Tests:**
- [ ] None (shell recipes); the checkpoint is the test.

**Checkpoint:**
- [ ] `just logs-debug` streams live output — and specifically does so when the local date and UTC date differ (after 17:00 Pacific), which is the failing case today.
- [ ] `just logs-debug` shows lines from both `tugcast` and `tugapp` targets.
- [ ] `just tail-replay` finds the running debug instance's log rather than the legacy path.

---

#### Step 4: Instrument the Swift service seam {#step-4}

**Depends on:** #step-2

**Commit:** `tugapp(local-model): record every inference request from both transports`

**References:** [P03] Handle seam, [P04] Emit after the answer, [P05] Two perspectives, [Spec S01](#s01-log-line-format), [Table T01](#turnaround-table), Risk R01, (#request-visibility)

**Artifacts:**
- `tugapp/Sources/LocalModelBackend.swift` — `LocalModelRequest.transport`
- `tugapp/Sources/LocalModelService.swift` — `handle` / `perform`
- `tugapp/Sources/MainWindow.swift`, `tugapp/Sources/ProcessManager.swift` — set the transport

**Tasks:**
- [ ] Add a `transport` enum (`bridge`, `socket`) to `LocalModelRequest` in `LocalModelBackend.swift`. The request itself cannot know it; the caller does ([P03]).
- [ ] Set it at both call sites: `MainWindow.swift` (the `localModel` `WKScriptMessageHandler` case, which is the deck's classify) sets `.bridge`; `ProcessManager.swift` (the control-socket `local_model_request` handler) sets `.socket`. These are the only two callers of `handle`.
- [ ] Rename the existing body of `LocalModelService.handle(_:)` to `perform(_:)`, unchanged.
- [ ] Add a new `handle(_:)` that records a start instant, awaits `perform`, and emits one `local model request` line per [Spec S01](#s01-log-line-format). Emit **after** the reply value exists ([P04]).
- [ ] Derive `outcome` from the reply: `ok` when `reply.ok`; `not_resident` when the error is classify's `"local model not resident"` fast-fail; `refused` when the model answered but produced no usable label (`"classification did not name a label"`); `error` otherwise.
- [ ] Add `slow=true` only when past the task's slow threshold from [Table T01](#turnaround-table) — 1s classify, 3s summarize. Absent means not slow, which keeps the common line short.
- [ ] Log `availability` at `debug` and everything else at `info` — availability fires on every window focus via `LocalModelStore.refreshAvailability` and performs no inference.
- [ ] Record `model` from the resident pack id (`MLXLocalModelBackend.residentId()`), or `none`.

**Tests:**
- [ ] No Swift unit test possible; verification is live observation of both transports.

**Checkpoint:**
- [ ] `just app-debug` builds with no warnings.
- [ ] Typing a PATH-shaped line into the composer (e.g. `ls`) produces a line with `task=classify transport=bridge` — this is the traffic tugcast can never see ([#request-visibility]).
- [ ] `just model-eval` produces lines with `task=summarize transport=socket`.
- [ ] `just model-eval`'s reported median latency is not materially worse than before the change (Risk R01) — the pre-change reading on `ternary-bonsai-8b-2bit` was 1263ms.

---

#### Step 5: Summarize ceiling and the caller-side line {#step-5}

**Commit:** `tugcast(local-model): give summarize its own ceiling and record what callers wait for`

**References:** [P05] Two perspectives, [P09] Classify ceiling stays, [Table T01](#turnaround-table), [Spec S01](#s01-log-line-format), [Q01] Real thresholds

**Artifacts:**
- `tugrust/crates/tugcast/src/local_model.rs`

**Tasks:**
- [ ] Add `SUMMARIZE_TIMEOUT` (6s) and switch `LocalModelRequester::summarize` off `REQUEST_TIMEOUT`. Leave `REQUEST_TIMEOUT` (10s) as the fallback for `generate` and any future task, and state in its docblock that it is a *transport deadline*, not a performance budget.
- [ ] Add `SUMMARIZE_SLOW` (3s) and `CLASSIFY_SLOW` (1s).
- [ ] Leave `CLASSIFY_TIMEOUT` at 2s and note in its docblock that it is one of three constants that must agree — `LOCAL_MODEL_TIMEOUT_MS` in `tugdeck/src/lib/local-model-bridge.ts` and `VERDICT_SUBMIT_WAIT_MS` in `tugdeck/src/components/tugways/tug-prompt-entry.tsx` ([P09]).
- [ ] Emit the `local model call` line from `LocalModelRequester::request` on every outcome, including the timeout and channel-dropped arms ([Spec S01](#s01-log-line-format)). This is the only place `timed_out` is knowable ([P05]).
- [ ] Remove the now-redundant ad-hoc `elapsed_ms` from `request_classification` in the same file if the caller-side line subsumes it; keep `request_summary`'s `raw=`/`headline=` pair, which serves a different purpose (prompt-drift detection).

**Tests:**
- [ ] Unit test asserting the ordering invariant the bounds depend on: `CLASSIFY_SLOW < CLASSIFY_TIMEOUT < SUMMARIZE_SLOW < SUMMARIZE_TIMEOUT < REQUEST_TIMEOUT`, and `SUMMARIZE_TIMEOUT < EMIT_FLOOR` so the emitter's cadence stays designed rather than inference-bound.
- [ ] Unit test that a `summarize` whose reply never arrives resolves as a timeout — drive `LocalModelRequester` with a channel nobody answers, as the existing requester tests in this file already do.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast` green.
- [ ] `just model-eval` still completes, with `local model call` lines carrying `task=summarize outcome=ok elapsed_ms=…`.

---

#### Step 6: Normalizer work-rate reporting {#step-6}

**Commit:** `tugcast(pulse-headline): report what the register normalizer had to do`

**References:** [Spec S01](#s01-log-line-format), (#normalizer-reporting), [Q01] Real thresholds

**Artifacts:**
- `tugrust/crates/tugcast/src/feeds/session_overview.rs`

**Tasks:**
- [ ] Add `HeadlineReport { text, normalized, trimmed, clipped }`.
- [ ] Add `headline_register_report(raw: &str) -> HeadlineReport`, moving the existing body into it: `normalized` is `text != raw.trim()`, `trimmed` is set when `trim_to_word_budget` shortened the string, `clipped` is set when `clip` shortened it *after* trimming.
- [ ] Keep `headline_register(raw: &str) -> String` as a thin wrapper returning `.text`, so every existing call site and unit test is untouched.
- [ ] Have the emitter's `session overview: summarized` line carry `normalized`, `trimmed`, and `clipped` alongside the existing `raw` and `headline` fields.
- [ ] Have `request_summary` in `local_model.rs` carry the same three fields, so the diagnostic verb and the emitter report identically.

**Tests:**
- [ ] Unit test: a headline already in register reports `normalized=false, trimmed=false, clipped=false`.
- [ ] Unit test: `"Author command-line calculator with makefile and readme"` reports `trimmed=true, clipped=false` — the live failure the word budget was built for.
- [ ] Unit test: a headline within six words but over 56 characters reports `clipped=true, trimmed=false` — the two budgets fire independently.
- [ ] Unit test: `"The download resume path"` reports `normalized=true` from article stripping alone, with neither budget firing.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast` green.
- [ ] `just model-eval` shows the three fields on real answers, with at least one `trimmed=true` (the `parts-list-tail` corpus entry reliably produces one).

---

#### Step 7: Liveness smoke test {#step-7}

**Depends on:** #step-5

**Commit:** `tugcast(model-eval): add an on-demand liveness check for the live model path`

**References:** [P08] Liveness in model-eval, [Spec S02](#s02-liveness-contract), [Table T01](#turnaround-table)

**Artifacts:**
- `tests/model-eval/harness.py` (new), `tests/model-eval/liveness.py` (new), `tests/model-eval/run.py` (refactored), `Justfile`

**Tasks:**
- [ ] Extract `log_path`, `answers`, and `ask` from `tests/model-eval/run.py` into `tests/model-eval/harness.py` unchanged, and import them back into `run.py`. `log_path` already selects the newest log by mtime — keep that, it is the fix for [#utc-date-bug] on the Python side.
- [ ] Add `liveness.py` implementing [Spec S02](#s02-liveness-contract).
- [ ] Pack detection: glob `~/Library/Application Support/Tug/models/*/tug-manifest.json`. The stamp file is the presence probe — a directory without it is a partial download, per `LocalModelStore` in `tugapp/Sources/LocalModelBackend.swift`.
- [ ] Instance detection: run `tugutil host instance list` and look for the requested instance id in its output — never parse `$TMPDIR/tug-instances.json` directly, which can hold stale entries for crashed instances that only the library-mediated read prunes ([Spec S02](#s02-liveness-contract)).
- [ ] Both preconditions **skip with exit 0** and a message naming the remedy — Tug ▸ **Set Up Tug…** for a missing pack, `just app-debug` for a missing instance.
- [ ] Fail (exit 1) only on: no answer within the timeout, an empty headline, or an elapsed time over `SUMMARIZE_TIMEOUT`.
- [ ] Report the normalizer's verdict from the `raw=`/`headline=` pair without failing on it.
- [ ] Add the `model-liveness INSTANCE="debug-main"` recipe to the `Justfile`, beside `model-eval`, with a comment saying it is on-demand and needs a pack.

**Tests:**
- [ ] The check is itself the test; its skip paths are exercised in the checkpoint.

**Checkpoint:**
- [ ] `just model-liveness` passes against a running instance with a pack.
- [ ] Temporarily pointing the pack glob at an empty directory makes it print the skip message and exit 0 — verify with `echo $?`.
- [ ] Stopping the instance (`just stop-debug`) makes it skip with the instance message and exit 0.
- [ ] `just model-eval` still works after the `harness.py` refactor — same 12 rows, unchanged behavior.

---

#### Step 8: Batch analyzer {#step-8}

**Depends on:** #step-4, #step-5, #step-6

**Commit:** `tugcast(model-eval): summarize accumulated local-model logs in batch`

**References:** [P06] Batch not live, [Spec S01](#s01-log-line-format), [Table T01](#turnaround-table), [Q01] Real thresholds, Risk R02

**Artifacts:**
- `tests/model-eval/analyze.py` (new), `Justfile`, `tests/model-eval/README.md`

**Tasks:**
- [ ] Add `analyze.py` reading every `tugapp.log.*` and `tugcast.log.*` in an instance's `Logs/` directory, with an optional `--since YYYY-MM-DD` window.
- [ ] Parse both files with one regex per [Spec S01](#s01-log-line-format), extracting the trailing `key=value` pairs into a dict.
- [ ] Report, per task: attempts, outcome counts, `elapsed_ms` p50 / p90 / max, the count over the slow threshold, and the count over the ceiling.
- [ ] Report the normalizer work rate: what fraction of summarize answers were `normalized`, `trimmed`, and `clipped` — the standing read on whether the prompt is in register (#normalizer-reporting).
- [ ] Report the headline change rate per session: `session overview: emitted` lines over `session overview: summarized` lines. This is the standing read on whether the headline is still tracking the work — it was 16/47 when the headline was frozen ([#frozen-headline]), and a return toward that ratio means the subject has drifted back to the lifetime goal.
- [ ] For bridge classify, apply the deck's known 2000ms deadline to report how many answers arrived too late to be used, since the deck's own give-up is not logged ([P05]).
- [ ] Print how many lines were parsed from each file, so a format drift shows as a zero rather than as silence (Risk R02).
- [ ] Add `--self-test` running the parser over a small set of captured real lines from both files, checked into the script as literals.
- [ ] Add the `model-stats INSTANCE="debug-main"` recipe to the `Justfile`.
- [ ] Update `tests/model-eval/README.md` to cover liveness, stats, and the three distinct questions the directory now answers.

**Tests:**
- [ ] `python3 tests/model-eval/analyze.py --self-test` parses every captured sample line, including one with `slow=true` present and one with it absent.

**Checkpoint:**
- [ ] `just model-stats` produces a report over the logs accumulated while implementing this plan.
- [ ] The report's parsed-line counts are non-zero for both files.
- [ ] `python3 tests/model-eval/analyze.py --self-test` passes.

---

#### Step 9: Integration checkpoint {#step-9}

**Depends on:** #step-3, #step-7, #step-8

**Commit:** `N/A (verification only)`

**References:** [P03] Handle seam, [P05] Two perspectives, [P06] Batch not live, [P10] Headline names the current phase, [Spec S01](#s01-log-line-format), (#success-criteria)

**Tasks:**
- [ ] Drive one real turn in a session card so a bridge classify and a socket summarize both occur.
- [ ] Confirm the headline has kept following the work across the whole implementation run — the logs from building this plan are themselves the sample, and `just model-stats` reports the change rate over them ([#step-1], [#frozen-headline]).
- [ ] Confirm both perspectives are present for the socket path: a `local model request` line from `tugapp` and a `local model call` line from `tugcast` for the same summarize.
- [ ] Confirm the bridge classify appears in `tugapp` only — the asymmetry [P05] exists for.
- [ ] Tick the closed items in `dash/archive/local-model-liveness-brief.md` and point its remaining items at this plan.

**Tests:**
- [ ] `cd tugrust && cargo nextest run -p tugcast` green.
- [ ] `cd tugdeck && bun test` green and `bunx tsc --noEmit` clean (the deck is untouched, so this is a no-regression check).
- [ ] `just app-test-changed` green for whatever the diff selects.

**Checkpoint:**
- [ ] `just model-liveness` passes.
- [ ] `just model-eval` passes with no register regression against the 12-digest corpus.
- [ ] `just model-stats` reports both tasks with non-zero attempts.
- [ ] `just logs-debug` shows both targets interleaved.

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** The local-model path writes one structured line per request from both transports into a log Swift can finally write to, bounded by per-task ceilings that mean something, with an on-demand liveness check and a batch analyzer that turns accumulated real usage into an answer about speed and failure rate.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] The headline follows the work: one session driven through two different stretches yields two different headlines, and `just model-eval` still scores 12/12 on register.
- [ ] Swift writes `tugapp.log.<UTC-date>` beside `tugcast.log.*`, in the same format (`just logs-debug` shows both).
- [ ] Every inference request emits a service-side line; classify over the WebKit bridge — invisible to tugcast — is included (`task=classify transport=bridge` present after typing in the composer).
- [ ] `summarize` fails at its own 6s ceiling rather than the shared 10s transport deadline (`SUMMARIZE_TIMEOUT` exists; ordering unit test green).
- [ ] Timeouts are recorded from the caller's side, where they are the only observable fact (`local model call` with `outcome=timed_out` is reachable).
- [ ] `headline_register` reports `normalized` / `trimmed` / `clipped`, and both the emitter and the diagnostic verb log all three.
- [ ] `just model-liveness` passes with a pack and skips cleanly with exit 0 without one.
- [ ] `just model-stats` reports outcome counts, duration percentiles, and normalizer work rate from accumulated logs.
- [ ] `just logs-debug` works in the evening Pacific, when local and UTC dates differ.

**Acceptance tests:**
- [ ] `cd tugrust && cargo nextest run -p tugcast`
- [ ] `python3 tests/model-eval/analyze.py --self-test`
- [ ] `just model-liveness` and `just model-eval`

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] **Set the real thresholds** from a week of accumulated data ([Q01]). This is the reason the analyzer exists and cannot be done at implementation time.
- [ ] **Close the display plan's [Q01]** (the 56-char headline budget) once the normalizer work rate has real volume behind it — the first reading suggests the six-word budget binds before the character budget ever does (#normalizer-reporting).
- [ ] **Promote the numbers to the dev panel** if reading logs proves too indirect ([P07]).
- [ ] **Migrate the app's existing `NSLog` calls** to `TugLog` now that a real facility exists.
- [ ] **Digest budget balance** — up to 40 tool lines against as few as two prompts lets tool shape outweigh the stated goal (the `app-self-update` corpus entry demonstrates it: 2217 characters of activity against 628 of goal). [#step-1] gives the tool half a recency split but leaves `MAX_TOOL_LINES` and `MAX_PROMPTS` where they are. Whether those numbers are right is a separate question, answerable once the change rate from [#step-8] has volume behind it.

| Checkpoint | Verification |
|------------|--------------|
| The headline moves with the work | two stretches, two headlines; `just model-eval` still 12/12 |
| Swift can write to our log | `tugapp.log.<date>` exists and `just logs-debug` shows it |
| Both transports measured | `transport=bridge` and `transport=socket` lines both present |
| Ceilings mean something | ordering unit test green; `SUMMARIZE_TIMEOUT` in force |
| Normalizer rate visible | `normalized`/`trimmed`/`clipped` on summarize lines |
| Liveness provable on demand | `just model-liveness` |
| Batch answerable later | `just model-stats` over accumulated logs |
