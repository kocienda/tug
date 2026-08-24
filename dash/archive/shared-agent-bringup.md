<!-- devise-skeleton v4 conformant -->

## SharedAgent Bringup — remote Haiku jobs replace the local model {#shared-agent-bringup}

**Purpose:** Replace the on-device qwen model with a `SharedAgent` — an app-scoped pool of persistent, job-constrained, headless `claude` workers on Haiku riding the user's Claude Code subscription — serving the two local-model features (pulse intent summaries, shell-command arbitration), then remove the entire local-model stack (catalog, downloader, MLX runtime, Configure Tug download step), reclaiming ~2.4 GB of resident memory and 2.28 GB of disk.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-08-06 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

Tug currently ships one local model — `qwen3-4b-instruct-2507-4bit`, a 2.28 GB MLX pack (the sole `CATALOG` entry in `tugrust/crates/tugcast/src/local_model.rs`) — loaded by `MLXLocalModelBackend` in Tug.app (`tugapp/Sources/LocalModelBackend.swift`). It serves exactly two features: (1) **pulse intent summaries** — the session-overview headline emitted by `tugrust/crates/tugcast/src/feeds/session_overview.rs`, and (2) **shell-command arbitration** — the classify verdict that decides whether a `maybe`/`unknown`-band composer line means the shell or means Claude (`tugdeck/src/components/tugways/tug-prompt-entry.tsx`). The resident cost is ~2.4 GB (the "IOAccelerator" line in vmmap is the model weights), which the 2026-07 perf/memory work showed is better spent on sessions and app headroom. Haiku is also simply a stronger model than a 4-bit Qwen3-4B, so both features should improve.

The remote path already has all its prerequisites in this codebase: every production Claude invocation goes through the auth-scrubbed `claude_command()` seam (`tugrust/crates/tugcast/src/feeds/claude_auth.rs`) on the user's subscription auth; the scribe (`tugrust/crates/tugcast/src/scribe.rs`) is a working one-shot headless `claude -p` worker with a test-seam spawner trait; and the retired PULSE v1 daemon (`dash/archive/pulse.md`, `dash/archive/pulse-2.md`) documents the persistent-Haiku-daemon posture (exact `claude-haiku-4-5`, `MAX_THINKING_TOKENS=0`, auth-env scrub) this plan revives.

`SharedAgent` is deliberately **not** a "do anything with this model" construct. It is a model operated against a fixed table of named jobs — each job with fixed instructions and bounds — so callers request a job by name, never an arbitrary prompt. A future Sonnet-based `SharedAgent` is a second instantiation of the same type with a different spec, not new architecture.

#### Strategy {#strategy}

- Build the `SharedAgent` machinery first (pool + persistent stream-json worker + job table) behind a spawner-trait test seam, fully unit-tested with a fake spawner before any caller migrates.
- Migrate the two callers one at a time: session overview first (background, latency-tolerant, lowest risk), then shell classify (blocking, latency-critical, its own step with its own app-test coverage — never folded into another step).
- The deck's classify path moves off the WKScriptMessage bridge onto the tugcast control socket, next to the `shell_grammar` verb it already partners with.
- Only after both features run on the `SharedAgent` does removal begin — then it is wholesale: tugcast catalog/downloader/requester, the entire Swift local-model stack and MLX package dependencies, the deck bridge/store, and Configure Tug's on-device-AI step.
- Worker count is a runtime resource-management policy (start at 1, grow to a small cap under contention, reap on idle), invisible to call sites.
- Every existing fallback behavior is preserved bit-for-bit in direction: doubt and failure degrade to the pre-model behavior (line goes to Claude; no headline; backoff).

#### Success Criteria (Measurable) {#success-criteria}

- Pulse intent summaries render on the PULSE strip with no local model installed, produced by Haiku via the `SharedAgent` (verify: fresh instance with no `models/` dir shows headlines; tugcast log lines `shared agent call` with `task=summarize`).
- Shell arbitration routes `maybe`/`unknown`-band lines through Haiku with the 2 s submit budget intact (verify: reworked at0280 posture test passes; manual check that `ls -la` routes to shell and prose goes to Claude in a debug app).
- `rg -i "local.?model|mlx|qwen" tugrust/ tugapp/Sources/ tugdeck/src/` returns no production hits after the removal steps (archives and this plan excepted).
- Tug.app launch-time resident memory drops by roughly the model weight (~2.3 GB) on a machine that previously had the pack installed (verify: vmmap IOAccelerator region before/after).
- Configure Tug shows no on-device-AI step; the wizard is Claude install → sign-in → projects folder → first session (verify: reworked Configure Tug app-test).
- `cargo nextest run` green, `bunx vite build` green, `just app-test-changed` green at every step boundary.

#### Scope {#scope}

1. New `shared_agent` module in tugcast: job table, persistent worker, pool, config, telemetry.
2. Migration of `session_overview.rs` from `LocalModelRequester` to the `SharedAgent` handle.
3. New `shell_classify` request/response verb on the shell feed; deck classify store rerouted onto it; WKScriptMessage local-model bridge retired.
4. Wholesale removal of the local-model stack across tugcast, Tug.app (Swift + MLX packages), and tugdeck.
5. Configure Tug simplification: the on-device-AI step and its copy/progress plumbing removed.
6. Test migration: unit tests for the pool, reworked at0280 posture test, on-demand real-claude worker test, model-eval harness repointed.

#### Non-goals (Explicitly out of scope) {#non-goals}

- The future Sonnet-based `SharedAgent` feature (the architecture must allow it; this plan does not build it).
- Migrating the scribe (`scribe.rs`) or the merge ladder onto the `SharedAgent` pool — they stay on their one-shot spawner (a candidate follow-on, see #roadmap).
- Prompt-cache prefix tuning and cost telemetry dashboards (follow-on, tuned from real telemetry).
- Any change to the tugpulse daemon (`feeds/pulse.rs` + `tugcode/src/pulse/`) — it is model-free and unrelated despite the name.
- tugbank migrations for orphaned `dev.tugtool.local-model` keys left in user banks (harmless residue; absent-reads-enabled means the new domain starts clean).

#### Dependencies / Prerequisites {#dependencies}

- `claude` CLI installed and signed in (already a hard prerequisite of the whole app — Configure Tug steps 1–2).
- The claude CLI's streaming-input mode (`--input-format stream-json --output-format stream-json`) — already exercised daily by tugcode (`tugcode/src/session.ts::buildClaudeArgs`).
- Access to `claude-haiku-4-5` on the user's subscription (already true; PULSE v1 ran on it).

#### Constraints {#constraints}

- **Warnings are errors** (`-D warnings` via `tugrust/.cargo/config.toml`).
- **Auth-scrub invariant:** every worker spawn must go through `claude_command()` in `feeds/claude_auth.rs` (or replicate its `AUTH_ENV_VARS` scrub), keeping the four synchronized scrub sites' contract; the `multi_session_real_claude.rs` apiKeySource assertion enforces it.
- **The timeout triad:** classify's 2 s ceiling exists in three constants that must agree — `CLASSIFY_TIMEOUT` (Rust), `LOCAL_MODEL_TIMEOUT_MS` (deck bridge), `VERDICT_SUBMIT_WAIT_MS` (`tug-prompt-entry.tsx`). This plan relocates the Rust and bridge constants but the triad discipline (cross-referencing comments at each site) must survive.
- **App-tests must never spend user tokens:** app-test instances must not reach a real Haiku (see [P08]).
- The claude CLI cannot set `max_tokens`/temperature per turn — output bounds are enforced by job instructions plus caller-side normalization, exactly as the existing Rust gates (`headline_register_report`, `ground_headline`, `verdict` parsing) already do.

#### Assumptions {#assumptions}

- A warm Haiku round trip for a ≤10-token answer lands in ~300–800 ms, inside the 2 s classify budget; the typing-debounce prewarm cache absorbs most submit-time waits regardless.
- A persistent worker process (`claude` in streaming-input mode) idles cheaply enough (~100–300 MB RSS, one process) that pool-of-one is a clear net win over 2.4 GB of weights.
- Offline/unauthenticated states degrade to the already-designed "no model" posture and need no new UI.

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

This plan follows the devise-skeleton conventions: explicit `{#anchor}` headings (kebab-case, no phase numbers); stable two-digit labels — plan-local decisions `[P01]` (never `[D##]`, which cites the global `tuglaws/design-decisions.md`), open questions `[Q01]`, specs `S01`, tables `T01`, risks `R01`; execution steps carry `**Depends on:**` lines referencing `#step-N` anchors and `**References:**` lines citing plan artifacts, never line numbers.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Exact CLI worker-isolation posture (OPEN → resolve in Step 1) {#q01-worker-isolation-posture}

**Question:** The full isolation argv/env/cwd posture for a streaming-input worker, covering four sub-questions: (a) which flag set makes the worker answer text-only, never invoking tools (`--disallowedTools`, `--allowedTools` with an empty set, permission mode, or a combination); (b) confirmation that the neutral cwd + `--strict-mcp-config` posture from [P13] actually excludes project `CLAUDE.md`/settings/MCP; (c) whether streaming-input mode needs a session flag at all (`buildClaudeArgs` in `tugcode/src/session.ts` permits zero session flags, but every production path passes one — verify a flagless spawn behaves); (d) where the worker's session transcript lands on disk (expected: `~/.claude/projects/<encoded neutral dir>/`) so [P13]'s picker-pollution claim is confirmed, not assumed.

**Why it matters:** A classify turn that wanders into a Bash tool call is slow, wrong, and a safety hazard; an unisolated worker contaminates its prompts with project config and litters the session picker. PULSE v1 solved the tool half (its daemon answered text-only); the archive documents the posture but flag names drift across CLI versions.

**Plan to resolve:** Spike in Step 1 against the installed CLI: run the candidate argv from the neutral cwd with a job prompt that baits tool use, confirm the result frame is text-only, confirm the transcript lands under the neutral encoded dir, and confirm a repo-specific `CLAUDE.md` instruction placed in a decoy cwd does not leak into answers. Record the chosen argv + cwd posture in `shared_agent.rs` with a comment naming the CLI version it was verified against.

**Resolution:** RESOLVED in Step 1 by spike against claude **2.1.222**, from an empty neutral cwd. (a) `--disallowedTools '*'` — the init frame reports `tools: []` and the answer comes back text-only in one turn; without it, the same tool-baiting turn invoked Bash and took two turns. (b) Confirmed: a decoy `CLAUDE.md` demanding a token got it appended when the worker ran from that directory, and the same turn from the neutral cwd came back bare even when the prompt explicitly invited it; `--strict-mcp-config` with no `--mcp-config` leaves no MCP servers. (c) No session flag is needed — a flagless streaming-input spawn works and the CLI mints its own session id. (d) Transcripts land at `~/.claude/projects/<encoded cwd>/<session-id>.jsonl`, confirming [P13]'s picker-pollution claim. Posture recorded in `shared_agent.rs` beside the spawn, naming the verified CLI version.

Two measurements from the same spike, recorded because they set constants: a cold first turn costs **2327 ms** (more than classify's entire budget — the decisive argument for warm workers), and warm turns run **867–989 ms**, above the 300–800 ms this plan assumed. `CLASSIFY_SLOW` is therefore 1500 ms rather than 1 s, since a 1 s mark would fire on roughly half of all calls and retire the `slow=true` rate as the drift signal the latency risk is read by.

#### [Q02] Prompt-cache prefix tuning (DEFERRED) {#q02-prompt-cache}

**Question:** Should job instructions be arranged as a stable prefix (per PULSE v1's ≥4096-token cache-prefix rule) to cut per-turn cost?

**Why it matters:** Cost and TTFT on high-frequency classify calls.

**Resolution:** DEFERRED — ship self-contained per-turn prompts first ([P05]), measure via the `shared agent call` telemetry, tune in a follow-on. The job-table design keeps instructions stable per job, so the option stays open.

#### [Q03] Fate of the model-eval harness (`tests/model-eval/`) (DECIDED — see [P07]) {#q03-model-eval}

**Question:** The eval harness (`harness.py`, `classify.py`, `analyze.py`) drives the CONTROL verbs `local_model_classify` / `local_model_summarize`. Retire or repoint?

**Resolution:** DECIDED — keep the observability verbs under new names ([P07]); repoint the harness's action names in Step 7. Scoring corpora stay valid (same tasks, same verdict/headline shapes).

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Warm-worker classify misses the 2 s budget | med | low | Job-class affinity ([P12]) keeps classify off the summarize worker's queue; debounce prewarm cache; degrade-to-Claude is the designed miss path; slow-mark telemetry | `slow=true` rate on `task=classify` above a few % |
| Haiku paraphrases and trips the `ground_headline` gate more than qwen did | med | med | Extractive phrasing in the summarize JobSpecs; refusal-rate measurement in #step-3; the gate's one re-ask with correction | refusal rate above the local-model baseline |
| Worker turns spend user subscription quota | med | med | Kill switches per tenant; recycle caps; debounce is the throttle knob | user reports /usage pressure |
| Stream-json protocol drift across claude CLI versions | med | low | Same frame shapes tugcode/scribe already parse; on-demand real-claude test | real-claude test failure after CLI update |
| Deletion sweep breaks an unnoticed consumer | high | low | Removal ordered after migration + integration checkpoint; `rg` sweeps in checkpoints; core-tier app-test run at the end | any red checkpoint |

**Risk R01: Cross-session content mixes in one worker conversation** {#r01-cross-session-bleed}

- **Risk:** A persistent worker accretes turns from many sessions; earlier digests could contaminate later headlines/verdicts.
- **Mitigation:** Self-contained turns ([P05]) instruct the model to answer only from the current message; turn-count recycling ([P04]) bounds conversation length; the existing `ground_headline` gate in `session_overview.rs` refuses headlines whose words aren't in the digest.
- **Residual risk:** Subtle drift inside a recycle window — acceptable, observable via the raw-vs-normalized log line that already exists for this purpose.

**Risk R02: Offline regression** {#r02-offline}

- **Risk:** The local model worked offline; the `SharedAgent` does not.
- **Mitigation:** None needed by design — offline degrades to the "no model installed" posture (no headlines; unknown-band lines to Claude), an already-designed, already-tested state (the at0280 posture).
- **Residual risk:** Real feature loss for offline work, accepted in the conversation that produced this plan.

---

### Design Decisions {#design-decisions}

#### [P01] SharedAgent is job-constrained, never free-form (DECIDED) {#p01-job-constrained}

**Decision:** A `SharedAgent` is constructed from an `AgentSpec` containing a fixed table of named `JobSpec`s (instructions, timeout, slow-mark, output contract); callers invoke `run(job_name, input)` — there is no API accepting an arbitrary prompt.

**Rationale:**
- The construct's purpose is operating a model against specific prompts to carry out specific jobs, not a general-purpose model handle.
- Fixed per-job instructions keep behavior auditable, testable against corpora, and prompt-cache-friendly ([Q02]).

**Implications:**
- Adding a capability = adding a `JobSpec`, reviewed like any contract change.
- The future Sonnet agent is `AgentSpec { model: "claude-sonnet-…", jobs: […] }` — a second value, zero new architecture.

#### [P02] One app-scoped pool; worker count is runtime policy (DECIDED) {#p02-pool-policy}

**Decision:** One `SharedAgentPool` per `AgentSpec`, app-scoped in tugcast, lazily spawning workers up to a small cap (default 2) and reaping them on idle. Callers hold a handle and never see workers. Dispatch respects job-class affinity ([P12]).

**Rationale:**
- Workers must be **persistent**: a cold `claude` process spawn is ~1–2 s, which alone exceeds classify's entire 2 s budget — this is the decisive argument for a pool of warm workers over the existing one-shot scribe pattern.
- Measured traffic is tiny: session overview enforces one emit in flight process-wide (`session_overview.rs` `in_flight`) with an 8 s per-session floor; classify is 8-output-token calls mostly absorbed by the deck's verdict cache.
- Per-session workers were rejected in design: each claude process is ~100–300 MB RSS, so 8 sessions × 1 worker respends the memory this plan reclaims.
- Worker count and reap policy make scale a resource-management issue, not a code-architecture issue.

**Implications:**
- Job acquisition queues briefly only behind a same-class worker ([P12]); the per-job timeout still bounds the caller's wait.
- Pool telemetry (queue depth, growth events, class of each spawn) rides the existing tracing pattern.

#### [P12] Workers carry job-class affinity; classify never queues behind summarize (DECIDED) {#p12-job-class-affinity}

**Decision:** Each worker is assigned a job class at spawn — the class of the job that triggered it (`classify` vs `summarize`/`summarize_done`) — and `run` dispatches only to a worker of the matching class, spawning one (subject to the cap and the respawn debounce) when none exists. Jobs queue only behind a busy worker of their own class.

**Rationale:**
- The two classes have different latency contracts (2 s vs 6 s). Reactive growth cannot rescue a classify that arrives while the sole worker is mid-summarize: the rescue spawn costs more than classify's whole budget, so the classify silently degrades and shell routing "just doesn't work sometimes." Summarize occupancy is frequent (8 s emit floor across all sessions), so the collision is routine, not rare.
- Within a class, queueing is harmless: classify calls are serialized by typing, and summarize is already one-in-flight by design.
- Affinity keeps the "one pool, scale as resource policy" framing while making the latency contract honest — lanes per class now, N-per-lane later if telemetry ever asks for it.

**Implications:**
- In steady state the pool runs one worker per class actually in use; `max_workers` (Spec S04) caps the total across classes.
- Idle reap applies per worker, so a machine with no shell-candidate typing carries no classify worker.
- Unit tests must pin: a classify arriving during a scripted-slow summarize gets a fresh same-class worker (or an immediate spawn), never the busy summarize worker's queue.

#### [P13] Workers run isolated: neutral cwd, no project config, no MCP (DECIDED) {#p13-worker-isolation}

**Decision:** Workers run with cwd set to a Tug-owned neutral directory (`tugcore::instance::base_data_dir()/shared-agent/`, created at spawn, containing no `CLAUDE.md`), with `--strict-mcp-config` (and no MCP servers), and with the tool-suppression posture from [Q01].

**Rationale:**
- **Session-picker pollution:** the external-session scanner (`tugrust/crates/tugcast/src/external_sessions.rs`) unions the picker's `list_sessions` with the on-disk reality under `~/.claude/projects/<encoded-cwd>/`, and its exclusion rules (cwd mismatch, sessionId/filename mismatch) would *not* exclude a worker transcript whose cwd genuinely is a user project directory — a 40-turn worker conversation would surface in the picker as a real session. A neutral cwd keeps worker transcripts under an encoded directory no project query ever reads.
- **Config contamination:** a worker rooted in a user repo inherits that repo's `CLAUDE.md`, settings, and MCP servers — prepending hundreds of instruction lines to every 8-token classify (latency, tokens) and steering behavior with rules written for interactive sessions.
- Tugplug's hooks are `PreToolUse`-only (`tugplug/hooks/hooks.json`), so with tool use suppressed no Tug hook can fire on a worker turn — no additional hook isolation is needed.

**Implications:**
- The isolation argv/cwd posture is part of [Q01]'s spike and is recorded beside the spawn code.
- The neutral directory is fixed and Tug-owned, so no user-supplied path is resolved and [L29]'s canonicalization gateway is not in play.
- Worker transcript files still accumulate under `~/.claude/projects/` for the neutral dir; the recycle cap bounds their count, and cleanup of old worker transcripts is a follow-on (#roadmap).

#### [P03] Model ids are pinned full ids; Haiku spec is `claude-haiku-4-5` (DECIDED) {#p03-pinned-model}

**Decision:** `AgentSpec.model` carries the full model id (`claude-haiku-4-5`), never a bare alias, overridable via tugbank (`dev.tugtool.shared-agent`/`model`) resolved per spawn through a closure, mirroring the scribe-model pattern in `main.rs`.

**Rationale:**
- Bare aliases drift (the repo's bare-model-ids-on-resume lesson); PULSE v2's decision record explicitly pinned "exact `claude-haiku-4-5`".
- The closure-not-value pattern means a settings change applies on the next worker spawn without restart.

#### [P04] Recycle by turn count and idle; lazy spawn with debounce (DECIDED) {#p04-recycle}

**Decision:** Workers are lazily spawned on first job, recycled after `MAX_TURNS_PER_WORKER = 40` turns, reaped after `IDLE_REAP_SECS = 300` idle (mirroring the MLX backend's 300 s idle unload), with a `RESPAWN_MIN_INTERVAL` of 5 s (mirroring `feeds/pulse.rs`). Constants are generous starting points, tuned from telemetry.

**Rationale:**
- Bounds context growth (cost + [R01]) and gives the "reap after usage, replace fresh" hygiene from the design conversation.
- The first job after a reap pays the cold start inside its own timeout and degrades on a miss — the exact shape of today's "model not resident → fast-fail, warm in background" behavior.

#### [P05] Every job turn is self-contained (DECIDED) {#p05-self-contained}

**Decision:** Each turn sent to a worker carries the complete job instructions plus input; no turn depends on conversation history, and instructions direct the model to answer only from the current message.

**Rationale:**
- Makes recycling free (any turn can be a worker's first) and caps [R01].

#### [P06] The fallback lattice is preserved verbatim in direction (DECIDED) {#p06-fallback}

**Decision:** All existing degradation behavior carries over unchanged: classify failure/timeout/refusal → line goes to Claude (only an explicit `shell` verdict that survives `vetoesShellVerdict` routes); summarize failure → no headline plus the existing 60 s→600 s process-wide backoff in `session_overview.rs`; agent disabled/unavailable → byte-for-byte the no-model build behavior.

**Rationale:**
- This lattice is the reason the swap is low-risk; it is already designed, implemented, and pinned by at0280.

**Implications:**
- The reworked posture test ([P09]) pins the same three claims with the new forcing mechanism.

#### [P07] Observability CONTROL verbs survive under new names (DECIDED) {#p07-observability-verbs}

**Decision:** The harness-facing CONTROL verbs `local_model_summarize` / `local_model_summarize_done` / `local_model_classify` (in `actions.rs`) are replaced by `shared_agent_summarize` / `shared_agent_summarize_done` / `shared_agent_classify` with the same result-broadcast shapes, including the raw-vs-normalized headline report through `headline_register_report`.

**Rationale:**
- The socket-reachable question ("what does the model actually say about this line?") is how prompts get evaluated and how drift is caught; `tests/model-eval/` depends on it ([Q03]).

#### [P08] App-test instances never reach a real worker (DECIDED) {#p08-apptest-gate}

**Decision:** The pool refuses to spawn when the app-test marker is present (the Swift service's `TUGAPP_APP_TEST=1` gate moves to tugcast; the implementer verifies the env var reaches the tugcast process, which is spawned by the app and inherits its environment). Under the gate every job returns the unavailable error, i.e. the designed degraded posture.

**Rationale:**
- App-tests must be free, fast, and deterministic; a replay-backed harness session must never spend subscription tokens.
- Mirrors the existing `resolveRoute()` app-test gate pinned by at0280.

#### [P09] Deck classify rides the shell feed, not a WebKit bridge (DECIDED) {#p09-socket-classify}

**Decision:** Shell arbitration moves onto the tugcast websocket as a `shell_classify` request/response verb in `feeds/shell.rs`, beside the `shell_grammar` verb it already partners with; the WKScriptMessage `localModel` bridge (`local-model-bridge.ts`, `MainWindow.swift` decode) is deleted.

**Rationale:**
- With the model runtime gone from Tug.app, the Swift hop serves nothing; tugcast owns the `SharedAgent`.
- `shell_grammar` proves the pattern: request id + text up, graded frame back, store resolves parked promises with its own timeout.

**Implications:**
- Deck readiness for shell routing becomes: tenant switch on AND transport up (a failed or slow call degrades anyway per [P06]) — replacing `useLocalModelReady`.
- This is the latency-sensitive, user-visible step; it stays its own execution step with its own tests ([#step-5]).

#### [P10] Config domain `dev.tugtool.shared-agent`; absent reads enabled (DECIDED) {#p10-config-domain}

**Decision:** New tugbank domain `dev.tugtool.shared-agent` with keys `pulse-overview` and `shell-routing` (per-tenant kill switches, `Value::Bool`, absent/non-bool = enabled — the repo's kill-switch convention), `model` (full-id override), and `max_workers`. The `dev.tugtool.local-model` domain is retired with the stack; an explicit old opt-out does not carry over (acceptable: absent = enabled starts the new domain clean, and the switch is one click).

#### [P11] Removal is wholesale, ordered after migration (DECIDED) {#p11-wholesale-removal}

**Decision:** Once both callers run on the `SharedAgent` and the integration checkpoint passes, the local-model stack is removed completely — tugcast module, Swift service/backends/MLX packages, deck bridge/store, Configure Tug step — never left as a dormant fallback.

**Rationale:**
- Half-maintained backends rot (decided in the design conversation); the download/verify/resume/staging-lock apparatus exists only to serve the Configure Tug step being removed.

---

### Deep Dives {#deep-dives}

#### Current call-site inventory {#current-call-sites}

**Pulse intent summaries** (`tugrust/crates/tugcast/src/feeds/session_overview.rs`): the emitter composes a digest in Rust (`compose_digest` / `compose_retrospective_digest`; caps `MAX_ACTIVITY_LINES 24`, `MAX_PROMPT_CHARS 1500`) and calls `requester.summarize(digest)` / `summarize_done(digest)` from a spawned task — one in flight process-wide, `EMIT_FLOOR` 8 s per session, `SUMMARIZE_TIMEOUT` 6 s / slow-mark 3 s. Instructions currently live in Swift (`LocalModelPrompts.summarize` / `summarizeRetrospective`, `LocalModelService.swift`); output is gated by `headline_register_report` (≤56 chars, register rules) and `ground_headline` (word-grounding with one re-ask), then broadcast as a `{"type":"pulse","kind":"overview",…}` frame. Failure arms a 60 s→600 s backoff. Wiring: `main.rs` builds `SessionOverviewConfig` with `local_model: Arc<SharedLocalModelState>` and a tenant closure over `local_model::tenant_enabled(PULSE_OVERVIEW_KEY)`.

**Shell arbitration** (`tugdeck/src/components/tugways/tug-prompt-entry.tsx`, submit path): precondition `isShellCandidate` → grade via `shellGrammarStore.requestWithin(text, GRADE_SUBMIT_WAIT_MS=150)` → `modelCallForBand` (`shell-line-classifier.ts`: `no`→skip, `yes`→run, `maybe`→ask-with-grammar, `unknown`→ask) → `requestClassify(text, grammar)` raced against `VERDICT_SUBMIT_WAIT_MS = 2000` → only an explicit `"shell"` verdict surviving `vetoesShellVerdict` routes to shell. A typing debounce pre-warms `ShellVerdictCache` (cap 32, keyed with/without grammar) so the submit wait is usually ~0. Transport today: `local-model-bridge.ts` → WKScriptMessage `localModel` → `LocalModelService.handle()`; instructions `LocalModelPrompts.classify` / `classifyWithGrammar` (8 output tokens, temp 0). A parallel socket path for observability exists via CONTROL `local_model_classify` → `LocalModelRequester::classify` (`CLASSIFY_TIMEOUT` 2 s, slow-mark 1 s).

#### SharedAgent worker protocol {#worker-protocol}

A worker is one `claude` child in streaming-input mode, spawned via `claude_command()` (auth scrub included) with cwd = the neutral directory from [P13] and argv:

```
--input-format stream-json --output-format stream-json --verbose --model <spec.model()>
--strict-mcp-config  <+ the tool-suppression and session-flag posture resolved by Q01>
```

env additions: `MAX_THINKING_TOKENS=0` (the PULSE v1 daemon posture). Each worker carries a job-class affinity ([P12]) set at spawn. One job turn = write one `{"type":"user","message":{"role":"user","content":[{"type":"text","text":"<instructions>\n\n<input>"}]}}` line to stdin; read stdout lines until the `{"type":"result",…}` frame for that turn; the `result` string is the answer (the same frame shapes `scribe.rs` and tugcode already parse). `kill_on_drop(true)`; stderr piped and tail-captured for error detail (the `stderr_tail` pattern from `agent_bridge.rs`). Worker death mid-turn resolves the in-flight job as an error (degrade per [P06]) and marks the worker for replacement, subject to the 5 s respawn debounce.

#### Latency contract {#latency-contract}

| Job | Ceiling | Slow-mark | Blocking? |
|---|---|---|---|
| `classify` | 2 s (triad, unchanged) | 1.5 s | Yes — between Return and routing; debounce cache absorbs most |
| `summarize` / `summarize_done` | 6 s (unchanged, under the 8 s emit floor) | 3 s | No — background task, one in flight |

The `record()` telemetry pattern from `LocalModelRequester` carries over verbatim as `shared agent call` log lines (`task`, `outcome`, `elapsed_ms`, `slow`), plus pool events (spawn, recycle, reap, growth).

#### Removal inventory {#removal-inventory}

**Table T01: What gets deleted, and where** {#t01-removal-inventory}

| Surface | Items |
|---|---|
| tugcast Rust | `src/local_model.rs` entirely (catalog, downloader, staging lock, stamp, `LocalModelRequester`, CONTROL verbs, tests); `main.rs` wiring (`reconcile_catalog_ranks`, `resume_partial_download`, `set_requester`, `ctl_local_model`, `mod local_model`); `actions.rs` `local_model_*` arms + `local_model` field on the action context; `control.rs` `ControlMessage::LocalModelResult` + routing; `feed_router.local_model` state |
| Tug.app Swift | `LocalModelService.swift`, `LocalModelBackend.swift`, `FoundationModelsBackend.swift`; `MainWindow.swift` `localModel` WKScriptMessage decode; `ProcessManager.swift` `local_model_request` socket decode + `LocalModelResult` reply; `AppDelegate.swift` references; `Tug.xcodeproj/project.pbxproj` MLX package products (`MLXLLM`, `MLXLMCommon`, the `mlx-swift-examples` XCRemoteSwiftPackageReference) |
| tugdeck TS | `lib/local-model-bridge.ts`; `lib/local-model-store.ts` (download/progress/inventory/availability; tenant-switch reads move to a small `shared-agent-store`); Configure Tug step 3 (`configure-tug.tsx` `handleAddLocalAi`/decline/cancel handlers and the on-device-AI row, `configure-tug-copy.ts` `localAiOfferDetail`/`localAiProgressValue`/pack-size copy, `settings-api.ts` `putLocalModelDeclined`); `SETUP_DECLINED_KEY` and the `dev.tugtool.local-model` domain constants |
| Tests | `local_model.rs` unit tests (with the module); at0280 rewritten (see [#step-5]); `tests/model-eval/` action names repointed ([P07]) |

Grep patterns for the sweep checkpoints: `local_model`, `localModel`, `local-model`, `LocalModel`, `MLX`, `mlx`, `qwen`, `hf_repo`, `tug-manifest`.

---

### Specification {#specification}

**Spec S01: Job table for the Haiku SharedAgent** {#s01-job-table}

| Job name | Input | Output contract | Timeout / slow | Ported from |
|---|---|---|---|---|
| `classify` | line text, optional grammar synopsis | exactly one label: `shell` or `prompt`; anything else = refusal (error) | 2 s / 1.5 s | `LocalModelPrompts.classifyCore` + `classify` + `classifyWithGrammar` (`LocalModelService.swift`) |
| `summarize` | composed digest | one present-tense headline line, ≤56 chars target (Rust gates still normalize) | 6 s / 3 s | `LocalModelPrompts.summarize` |
| `summarize_done` | retrospective digest | one past-tense headline line | 6 s / 3 s | `LocalModelPrompts.summarizeRetrospective` |

Prompt porting note: the Swift prompts were written for a 4-bit Qwen3-4B (heavy few-shot scaffolding, 8-token stop budgets). Port the *contracts*, then simplify for Haiku where scaffolding exists only to prop up the weak model; keep the label-set and headline-register requirements verbatim so the Rust gates (`verdict` parsing in the classify store, `headline_register_report`, `ground_headline`) stay valid. The `generate` task (`LocalModelPrompts.generate`, 256 tokens) has no production caller and is dropped, not ported.

**Spec S02: Rust API surface (`tugrust/crates/tugcast/src/shared_agent.rs`)** {#s02-rust-api}

```rust
pub struct JobSpec { pub name: &'static str, pub instructions: &'static str, pub timeout: Duration, pub slow: Option<Duration> }
pub struct AgentSpec { pub name: &'static str, pub model: Arc<dyn Fn() -> String + Send + Sync>, pub jobs: &'static [JobSpec], pub max_workers: usize }

/// Test seam (the ScribeSpawner / ChildSpawner pattern): production impl spawns
/// the persistent claude child; fakes script turn outcomes.
pub trait AgentWorkerSpawner: Send + Sync + 'static { /* spawn() -> worker handle with a run_turn(text) -> Result<String,String> future */ }

pub struct SharedAgentPool { /* workers, queue, recycle bookkeeping */ }
impl SharedAgentPool {
    pub fn new(spec: AgentSpec, spawner: Arc<dyn AgentWorkerSpawner>) -> Arc<Self>;
    /// The whole caller API: named job + input, bounded by the job's timeout.
    /// Unknown job name is a programming error (panic in debug, error in release).
    pub async fn run(&self, job: &str, input: String) -> Result<String, String>;
    /// classify carries the optional grammar; the pool substitutes it into the
    /// job instructions (the {{GRAMMAR}} slot, as the Swift service did).
    pub async fn run_classify(&self, text: String, grammar: Option<String>) -> Result<String, String>;
}
```

Recycle constants (`MAX_TURNS_PER_WORKER = 40`, `IDLE_REAP_SECS = 300`, `RESPAWN_MIN_INTERVAL = 5 s`) live beside the pool with a comment marking them provisional-pending-telemetry ([P04]). The app-test gate ([P08]) is checked at spawn time.

**Spec S03: `shell_classify` wire verb** {#s03-shell-classify-verb}

Rides the shell feed (`feeds/shell.rs`), mirroring the real `shell_grammar` pattern exactly — session-scoped feed, `tug_session_id` on every frame, correlation by echoing the request content (not an opaque id):

- Request (deck → tugcast): `{ "type": "shell_classify", "tug_session_id": "<sid>", "line": "<text>", "grammar": "<synopsis>" | null }`
- Response (tugcast → deck, one SHELL_OUTPUT frame on the asking session's `SessionScopedFeed`): `{ "type": "shell_classify", "tug_session_id": "<sid>", "line": "<same text>", "with_grammar": bool, "ok": bool, "verdict": "shell" | "prompt" | null, "error": "<detail>" | null }`

The echoed `line` plus `with_grammar` is the correlation key — the same shape the deck's verdict cache already keys on (`ShellVerdictCache` keys with/without grammar separately), so the store resolves parked resolvers by exact match, exactly as `ShellGrammarStore` resolves grades by echoed `line`. Replies are scoped by `tug_session_id` so one session's verdicts can never resolve another session's parked request (the `shell_grammar_replies_are_scoped_to_the_asking_session` test in `feeds/shell.rs` is the precedent to copy).

tugcast handles the request by calling `pool.run_classify` on a spawned task (never blocking the socket loop) and emitting the response frame via the same `emit`/`SessionScopedFeed` path `emit_shell_grammar` uses; verdict parsing (single-label-or-refusal) happens tugcast-side so the deck sees only `shell`/`prompt`/null.

The deck side, `shell-classify-store.ts`, is **one instance per Session card session**, sharing the card's existing `SHELL_OUTPUT` `FeedStore` (no new feed) exactly as `ShellGrammarStore` does: the constructor's `subscribe` returns the unregister closure held as `_unsubscribeFeed`, and `dispose()` invokes it — the [L27] acquisition/release contract, byte-for-byte the sibling store's shape. It carries its own `CLASSIFY_REQUEST_TIMEOUT_MS = 2000` (a triad member, cross-referenced comments) and resolves every failure — no transport, no reply in time, malformed frame, `ok:false` — to `null`.

**Spec S04: Configuration schema (`dev.tugtool.shared-agent`)** {#s04-config-schema}

| Key | Type | Default (absent) | Meaning |
|---|---|---|---|
| `pulse-overview` | Bool | enabled | tenant switch for intent summaries |
| `shell-routing` | Bool | enabled | tenant switch for shell arbitration |
| `model` | String | `claude-haiku-4-5` | full-id override, read per spawn |
| `max_workers` | Int | 2 | total worker cap across job classes ([P12]) |

#### State Zone Mapping (tugdeck/tugways plans) {#state-zone-mapping}

| State | Zone (appearance / local-data / structure) | Mechanism | Law |
|-------|--------------------------------------------|-----------|-----|
| classify verdicts + in-flight requests | local-data | `shell-classify-store.ts`, one instance per session sharing the card's SHELL_OUTPUT `FeedStore`; composer reads imperatively at submit (as `shell-grammar-store` does today); feed subscription released in `dispose()` | [L02], [L22], [L27] |
| shell-routing readiness (tenant switch + transport) | local-data | `shared-agent-store.ts` + `useSyncExternalStore` hook (replaces `useLocalModelReady`) | [L02] |
| Configure Tug step list (on-device-AI row removed) | structure | pure derivation from existing stores; no new state | [L02]/[L24] |

No appearance-zone state is added; no `root.render`, focus, or registration changes ([L01], [L03] untouched).

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tugrust/crates/tugcast/src/shared_agent.rs` | pool, worker, job table, spawner trait, config reads, telemetry |
| `tugdeck/src/lib/shell-classify-store.ts` | socket-backed classify request store (replaces bridge classify) |
| `tugdeck/src/lib/shared-agent-store.ts` | tenant switches + readiness for the deck |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `JobSpec`, `AgentSpec`, `AgentWorkerSpawner`, `SharedAgentPool` | structs/trait | `shared_agent.rs` | Spec S02 |
| `HAIKU_AGENT_JOBS` | const table | `shared_agent.rs` | Spec S01 prompts ported from `LocalModelPrompts` |
| `SessionOverviewConfig.local_model` → `shared_agent` | field | `feeds/session_overview.rs` | handle swap, call sites `summarize`/`summarize_done` |
| `shell_classify` request/response | verb | `feeds/shell.rs` | Spec S03 |
| `shared_agent_summarize` / `_summarize_done` / `_classify` | CONTROL verbs | `actions.rs` | [P07], replaces `local_model_*` observability verbs |
| `SHARED_AGENT_DOMAIN`, key consts | consts | `shared_agent.rs` + `shared-agent-store.ts` | Spec S04, two mirrors (no Swift mirror needed) |

---

### Documentation Plan {#documentation-plan}

- [x] `CLAUDE.md`: checked — it never documented the model, and nothing local-model-shaped landed there. No change.
- [x] `tuglaws/design-decisions.md`: the candidate global decision proposed below (#candidate-decision) was **promoted by the user after the join** and now lives there as **[D127]**, under a new `## Model Work` section. The draft below is kept as the record of what was proposed; D127 is the authority.
- [x] `dash/archive/pulse.md` and `dash/archive/pulse-2.md` are this design's daemon-posture ancestors: the persistent-Haiku-worker shape, the exact `claude-haiku-4-5` pin, and the `MAX_THINKING_TOKENS=0` env all come from PULSE v1/v2. Whoever revisits worker policy should read them first.
- [x] Fixed the stale scribe doc comment at `feeds/agent_supervisor.rs` that said `haiku` while the code defaults `sonnet`.

#### Candidate global design decision (promoted — now [D127]) {#candidate-decision}

> **Aux model work runs on SharedAgents over the user's subscription, never on a bundled model.**
>
> Tug's non-conversational model work — headline summaries, shell arbitration, and whatever comes next — runs on a job-constrained pool of persistent headless `claude` workers authenticated by the user's own Claude Code subscription. Tug does not ship, download, or host model weights.
>
> *Why:* an on-device pack cost ~2.4 GB resident and 2.28 GB on disk to run a model weaker than the one the user is already paying for; the download apparatus existed only to feed it; and a half-maintained second inference backend rots. The subscription is already a hard prerequisite of the whole app, so the remote path adds no new dependency.
>
> *Cost accepted:* these features stop working offline, degrading to their designed absent posture.

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit (Rust, fake spawner)** | pool policy: queueing, growth, recycle at turn cap, idle reap, respawn debounce, timeout mapping, classify label parsing, app-test gate | Step 1 |
| **Integration (Rust, fake spawner)** | session_overview emits through the pool; backoff on failure; CONTROL verbs round-trip | Steps 3, 2 |
| **Real-claude (on-demand)** | one worker spawn + one real classify + one real summarize turn against the live CLI, following the `multi_session_real_claude.rs` on-demand gating pattern | Step 6 |
| **App-test** | reworked at0280 posture (agent-absent = no headline run, no routing chips, no Lens goal line); Configure Tug wizard without the AI step | Steps 5, 9 |

#### What stays out of tests {#test-non-goals}

- Model prose quality — never asserted in automated tests (the scribe convention); prompt quality is the eval harness's job (`tests/model-eval/`, human-read).
- Live classify round-trips in app-tests — forbidden by [P08]; the submit-time logic is covered as pure logic in `shell-line-classifier.test.ts` (existing) and the wire verb by Rust integration tests with a fake spawner.
- The positive (agent-present) path in any app-test — structurally impossible under [P08], stated in the at0280 rework's docblock; covered instead by the on-demand real-claude test and the Rust fake-spawner suites.
- jsdom/mock-store render tests — banned pattern.

---

### Execution Steps {#execution-steps}

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | SharedAgent core: pool, worker, job table | done | `8cbd37bf1` (folded with #step-2) |
| #step-2 | Wire the Haiku agent into tugcast + CONTROL verbs | done | `8cbd37bf1` |
| #step-3 | Migrate session overview onto the SharedAgent | done | `bf7bd6d31` |
| #step-4 | `shell_classify` verb in the shell feed | done | `abaaab091` |
| #step-5 | Deck reroute: classify over the socket, posture test rework | done | `efe1172ec` |
| #step-6 | Integration checkpoint: both features on Haiku | done | `e3d02fd56` |
| #step-7 | Remove the tugcast local-model module | done | `d85233a1c` |
| #step-8 | Remove the Swift stack and MLX packages | done | `e2bc075be` |
| #step-9 | Remove deck remnants + Configure Tug simplification | done | `fb4e31940` |
| #step-10 | Final sweep, docs, core-tier verification | done | `f7436e837` |

#### Step 1: SharedAgent core: pool, worker, job table {#step-1}

**Commit:** `tugcast(shared-agent): add job-constrained SharedAgentPool with persistent claude workers`

**References:** [P01] job-constrained, [P02] pool policy, [P03] pinned model, [P04] recycle, [P05] self-contained, [P08] app-test gate, [P12] job-class affinity, [P13] worker isolation, [Q01] worker-isolation posture, Spec S01, Spec S02, (#worker-protocol, #latency-contract)

**Artifacts:**
- `tugrust/crates/tugcast/src/shared_agent.rs` (new): `JobSpec`, `AgentSpec`, `AgentWorkerSpawner`, `SharedAgentPool`, `HAIKU_AGENT_JOBS`, recycle constants, `shared agent call` telemetry, `SHARED_AGENT_DOMAIN` config reads.
- Production spawner impl using `claude_command()` (make it `pub(crate)`-reachable from `shared_agent.rs`; it is `pub(crate)` in `feeds/claude_auth.rs` today) with the streaming-input argv and `MAX_THINKING_TOKENS=0` env.

**Tasks:**
- [ ] Implement per #worker-protocol; parse stream-json result frames exactly as `scribe.rs` does (`stream_event` deltas ignored; `result` frame is the answer).
- [ ] Implement [P12] dispatch: workers carry the class of the job that spawned them; `run` never hands a job to a worker of the other class.
- [ ] Implement [P13] isolation: create `base_data_dir()/shared-agent/` at spawn, set it as cwd, pass `--strict-mcp-config`.
- [ ] Port and Haiku-simplify the three job prompts from `LocalModelPrompts` in `tugapp/Sources/LocalModelService.swift` per Spec S01, including the `{{GRAMMAR}}` substitution for classify; phrase the summarize prompts explicitly extractively (use only words from the digest) so the `ground_headline` gate keeps passing — a fluent model paraphrases where a weak one copies.
- [ ] Resolve [Q01] (all four sub-questions): spike against the installed CLI from the neutral cwd — text-only result on a tool-baiting prompt, transcript location, session-flag posture, `CLAUDE.md`-leak check; record argv + cwd + verified CLI version in a comment.
- [ ] Implement the [P08] gate: `TUGAPP_APP_TEST=1` in the environment ⇒ `run` returns `Err("shared agent unavailable under app-test")` without spawning. (Env propagation is already verified: `ProcessManager.swift` seeds the tugcast child env from `ProcessInfo.processInfo.environment`, so the harness variable is inherited — state this in the gate's comment.)

**Tests:**
- [ ] Fake-spawner unit tests: single-worker serialization within a class; a classify arriving during a scripted-slow summarize gets a fresh same-class worker, never the summarize worker's queue ([P12]); growth to `max_workers` and never past it; recycle at turn 40 (fresh worker gets turn 41); idle reap per worker; respawn debounce; per-job timeout produces `Err` and the caller-side `record` outcome; classify label parsing (one label ok; zero or two labels = refusal); app-test gate; a second two-job dummy `AgentSpec` instantiates against the same pool machinery (the future-Sonnet exit criterion).

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast shared_agent`
- [ ] [Q01] spike transcript demonstrates: text-only result from a tool-baiting prompt, transcript under the neutral encoded dir, no `CLAUDE.md` leak.

---

#### Step 2: Wire the Haiku agent into tugcast + CONTROL verbs {#step-2}

**Depends on:** #step-1

**Commit:** `tugcast(shared-agent): instantiate the Haiku agent, add shared_agent_* observability verbs`

**References:** [P02] pool policy, [P03] pinned model, [P07] observability verbs, [P10] config domain, Spec S04, (#s02-rust-api)

**Artifacts:**
- `main.rs`: one `SharedAgentPool` built at startup (lazy — no worker until first job) with the model closure over `dev.tugtool.shared-agent`/`model` defaulting `claude-haiku-4-5`, following the `scribe_model` closure pattern already in `main.rs`.
- `actions.rs`: `shared_agent_summarize` / `shared_agent_summarize_done` / `shared_agent_classify` CONTROL verbs mirroring the existing `local_model_*` verb bodies (including the `headline_register_report` raw-vs-normalized log line and result broadcasts), now calling the pool. The `local_model_*` verbs remain untouched this step.

**Tasks:**
- [ ] Thread the pool handle to the actions context (alongside, not replacing, the `local_model` field for now).
- [ ] Fix the stale `haiku` doc comment near `ScribeContext` in `feeds/agent_supervisor.rs` (code defaults `sonnet`).

**Tests:**
- [ ] Rust integration test: dispatch `shared_agent_classify` with a fake-spawner pool; assert the broadcast shape matches the old verb's.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast`

---

#### Step 3: Migrate session overview onto the SharedAgent {#step-3}

**Depends on:** #step-2

**Commit:** `tugcast(session-overview): emit intent headlines through the Haiku SharedAgent`

**References:** [P05] self-contained, [P06] fallback, [P10] config domain, Spec S01, Risk R01, (#current-call-sites)

**Artifacts:**
- `feeds/session_overview.rs`: `SessionOverviewConfig.local_model` replaced by a pool handle; the emit path calls `pool.run("summarize"| "summarize_done", digest)`; digest composition, register/grounding gates, backoff, cadence all unchanged.
- `main.rs`: overview tenant closure reads `dev.tugtool.shared-agent`/`pulse-overview` (same absent-reads-enabled helper shape as `local_model::tenant_enabled`, relocated to `shared_agent.rs`).

**Tasks:**
- [ ] Keep `SUMMARIZE_TIMEOUT`-vs-`EMIT_FLOOR` doc invariant (ceiling stays under the 8 s floor — now stated where the JobSpec timeout lives).
- [ ] Existing session_overview tests: swap their requester stub for a fake-spawner pool; behavior assertions unchanged (failure arms backoff, success resets, grounding refusal not emitted).
- [ ] Measure the `ground_headline` refusal rate before and after the model swap (the refusal path already logs; compare a real session hour on each side). The gate refuses headlines whose words aren't in the digest, and a fluent model paraphrases where a weak one copies — if refusals rise, tighten the extractive phrasing in the summarize JobSpecs (Step 1's porting task) rather than loosening the gate.

**Tests:**
- [ ] Existing `session_overview` test suite green against the pool.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast session_overview`
- [ ] Manual: debug app with no local model installed shows PULSE headlines; tugcast log shows `shared agent call` `task=summarize`.

---

#### Step 4: `shell_classify` verb in the shell feed {#step-4}

**Depends on:** #step-2

**Commit:** `tugcast(shell): add shell_classify request/response verb backed by the SharedAgent`

**References:** [P09] socket classify, [P06] fallback, Spec S03, (#current-call-sites)

**Artifacts:**
- `feeds/shell.rs`: `shell_classify` request decode + spawned-task handler + response frame emit on the asking session's `SessionScopedFeed`, patterned on the `shell_grammar` request → `emit_shell_grammar` pair in the same file; verdict parsing tugcast-side (label-or-null).

**Tasks:**
- [ ] Never block the socket loop: handler runs on `tokio::spawn`; response frame echoes `tug_session_id`, `line`, and `with_grammar` per Spec S03.
- [ ] Every failure shape (pool error, timeout, refusal) emits `ok:false, verdict:null` — one degraded shape for the deck.

**Tests:**
- [ ] Rust tests with a fake-spawner pool: request → response correlation by echoed line + `with_grammar`; scripted `shell` verdict; scripted refusal → `verdict:null`; **replies are scoped to the asking session** (copy the `shell_grammar_replies_are_scoped_to_the_asking_session` pattern in the same file).

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast shell`

---

#### Step 5: Deck reroute: classify over the socket, posture test rework {#step-5}

**Depends on:** #step-4

**Commit:** `tugways(shell-routing): classify over the shell feed via SharedAgent, retire the bridge path`

**References:** [P09] socket classify, [P06] fallback, [P08] app-test gate, Spec S03, Spec S04, (#state-zone-mapping, #latency-contract)

This is the latency-sensitive, user-visible step — kept deliberately separate, with its own coverage, per the design conversation.

**Artifacts:**
- `tugdeck/src/lib/shell-classify-store.ts` (new, Spec S03 deck side): one instance per Session card session sharing the card's SHELL_OUTPUT `FeedStore`, `_unsubscribeFeed` released in `dispose()` per [L27] — instantiate and dispose exactly where `ShellGrammarStore` is instantiated and disposed today.
- `tugdeck/src/lib/shared-agent-store.ts` (new: tenant switches over `dev.tugtool.shared-agent`, readiness = switch AND transport).
- `tug-prompt-entry.tsx`: `requestClassify` and the debounce prewarm repointed at the new store; `useLocalModelReady("shell-routing")` replaced by the new readiness hook; `ShellVerdictCache`, `vetoesShellVerdict`, `GRADE_SUBMIT_WAIT_MS`, `VERDICT_SUBMIT_WAIT_MS`, and the submit sequencing untouched.
- Timeout-triad comments updated at all three (now: `classify` JobSpec timeout in `shared_agent.rs`, `CLASSIFY_REQUEST_TIMEOUT_MS` in `shell-classify-store.ts`, `VERDICT_SUBMIT_WAIT_MS` in `tug-prompt-entry.tsx`) — each names the other two.
- `tests/app-test/at0280-local-model-absent.test.ts` → renamed `at0280-shared-agent-absent.test.ts`: same three claims (no headline run on the strip; typing PATH-executable lines leaves plain text, no chips; no Lens goal line). **The forcing mechanism is [P08] itself** — the agent is unavailable in every app-test instance, so the absent posture needs no tugbank seeding (do not seed the kill switches: that would let the test pass for a reason other than the one it claims). The header docblock states the coverage limitation honestly: no app-test can exercise the positive path, by design; the positive path is covered by the on-demand real-claude test (#step-6) and the pure-logic classifier suite. `@covers` lines updated to the new store files.

**Tasks:**
- [ ] Delete the classify usage from `local-model-bridge.ts` call sites (the bridge file itself dies in #step-9).
- [ ] Confirm under [P08] that an app-test instance's classify path resolves null without any socket round trip reaching a worker.
- [ ] [L27] check: walk the new store's acquisitions (feed subscription, any timers for parked-resolver expiry) and confirm each has a release invoked on `dispose()`.

**Tests:**
- [ ] Existing `shell-line-classifier.test.ts` pure-logic suite green (unchanged mapping).
- [ ] Reworked at0280 green.

**Checkpoint:**
- [ ] `bunx vite build` (from `tugdeck/`)
- [ ] `just app-test-changed`
- [ ] Manual in the debug app: type `git status` → routes to shell; type prose starting with a PATH word (`make it pretty`) → goes to Claude; pull the network → both degrade to Claude routing without UI jank.

---

#### Step 6: Integration checkpoint: both features on Haiku {#step-6}

**Depends on:** #step-3, #step-5

**Commit:** `N/A (verification only)`

**References:** [P06] fallback, [P08] app-test gate, (#success-criteria, #latency-contract)

**Tasks:**
- [ ] Verify both features run with the MLX pack physically deleted from `models/` (the local stack is now dead code in the live path).
- [ ] Add the on-demand real-claude test: one worker spawn, one real classify (`ls -la` → `shell`), one real summarize (short digest → non-empty headline), following the on-demand gating of `tugrust/crates/tugcast/tests/multi_session_real_claude.rs`.
- [ ] Read `shared agent call` telemetry from a real session hour: classify q50 within budget, `slow=true` rare.

**Tests:**
- [ ] On-demand real-claude test passes when explicitly invoked.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run`
- [ ] `just app-test` (core tier — this phase touched load-bearing composer routing)

---

#### Step 7: Remove the tugcast local-model module {#step-7}

**Depends on:** #step-6

**Commit:** `tugcast(local-model): remove the local model catalog, downloader, and requester`

**References:** [P11] wholesale removal, [P07] observability verbs, [Q03] model-eval, Table T01, (#removal-inventory)

**Artifacts:**
- Deletions per Table T01's tugcast row: `local_model.rs`, `main.rs` wiring, `actions.rs` `local_model_*` arms + context field, `control.rs` `LocalModelResult` + routing, router state.
- `tests/model-eval/` scripts repointed at the `shared_agent_*` verb names ([P07]).

**Tasks:**
- [ ] `rg -n "local_model|LocalModel" tugrust/` returns nothing after the pass.

**Tests:**
- [ ] Workspace builds warning-clean; remaining suites green.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run`

---

#### Step 8: Remove the Swift stack and MLX packages {#step-8}

**Depends on:** #step-7

**Commit:** `tugapp(local-model): remove the MLX runtime, model service, and bridge decode`

**References:** [P11] wholesale removal, Table T01, (#removal-inventory)

**Artifacts:**
- Deletions per Table T01's Swift row: the three backend/service files, `MainWindow.swift` `localModel` message-handler decode, `ProcessManager.swift` `local_model_request`/`LocalModelResult` socket handling, `AppDelegate.swift` references, and the `MLXLLM`/`MLXLMCommon` products + `mlx-swift-examples` package reference in `Tug.xcodeproj/project.pbxproj`.

**Tasks:**
- [ ] Build Tug.app; confirm binary/app size drops with the MLX frameworks gone.
- [ ] `rg -in "localmodel|mlx" tugapp/` returns nothing.

**Tests:**
- [ ] App launches; sessions, PULSE headlines, and shell routing all work (they no longer touch Swift for any of this).

**Checkpoint:**
- [ ] App build succeeds; `just app-test-changed`

---

#### Step 9: Remove deck remnants + Configure Tug simplification {#step-9}

**Depends on:** #step-8

**Commit:** `tugways(configure-tug): retire the on-device AI step and the local-model store/bridge`

**References:** [P11] wholesale removal, [P10] config domain, Table T01, (#state-zone-mapping)

**Artifacts:**
- Deletions per Table T01's tugdeck row: `local-model-bridge.ts`, `local-model-store.ts`, Configure Tug step 3 (the on-device-AI row, `handleAddLocalAi`/cancel/decline handlers, `localAiOfferDetail`/`localAiProgressValue` and pack-size copy in `configure-tug-copy.ts`, `putLocalModelDeclined` in `settings-api.ts`, `SETUP_DECLINED_KEY`).
- `configure-tug.tsx` header docblock rewritten: the wizard is now install → sign-in → projects folder → first session; the "both middle steps gate" paragraph updated (only the projects-folder gate remains).

**Tasks:**
- [ ] Update or rework the Configure Tug app-test coverage for the four-step wizard (find the covering test via `just app-test-select` after the edit).
- [ ] `rg -n "local-model|localModel|LocalModel" tugdeck/` returns nothing.

**Tests:**
- [ ] Reworked Configure Tug app-test green; at0280 (reworked in #step-5) still green.

**Checkpoint:**
- [ ] `bunx vite build`
- [ ] `just app-test-changed`

---

#### Step 10: Final sweep, docs, core-tier verification {#step-10}

**Depends on:** #step-9

**Commit:** `tugcast(shared-agent): finish the local-model retirement — docs and sweep`

**References:** [P11] wholesale removal, (#documentation-plan, #success-criteria, #exit-criteria)

**Tasks:**
- [ ] Repo-wide sweep with the #removal-inventory grep patterns (`qwen`, `mlx`, `hf_repo`, `tug-manifest`, `local.?model`) — production code clean; archives/roadmap references acceptable.
- [ ] Documentation Plan items; note in this plan's ledger that `dash/archive/pulse.md`/`pulse-2.md` are the daemon-posture ancestors.
- [x] Propose (do not self-commit) the candidate global design decision for `tuglaws/design-decisions.md`. Proposed at #candidate-decision; promoted by the user after the join as [D127].

**Tests:**
- [ ] Full workspace + frontend verification.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run`
- [ ] `bunx vite build`
- [ ] `just app-test` (core tier)

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** Pulse intent summaries and shell-command arbitration run on a Haiku `SharedAgent` over the user's Claude Code subscription; the on-device model stack is gone from the codebase, the app, and Configure Tug.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] Both features work with no `models/` directory on disk (manual + reworked at0280).
- [ ] No production reference to the local model remains (`rg` sweeps in #step-7/#step-8/#step-9/#step-10 checkpoints).
- [ ] Configure Tug is a four-step wizard (app-test).
- [ ] `SharedAgentPool` supports a second `AgentSpec` instantiation without modification (demonstrated by a unit test constructing a two-job dummy spec).
- [ ] Core tier green; `cargo nextest run` green; `bunx vite build` green.

**Acceptance tests:**
- [ ] Reworked `at0280-shared-agent-absent.test.ts`.
- [ ] On-demand real-claude worker test (one classify, one summarize).

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] The Sonnet-based `SharedAgent` feature (second `AgentSpec`).
- [ ] Migrate the scribe / merge ladder onto the pool machinery (one-shot job kind).
- [ ] Cleanup of accumulated worker transcripts under `~/.claude/projects/<encoded neutral dir>/` ([P13] — recycle bounds growth per worker; a reaper bounds it over time).
- [ ] Prompt-cache prefix tuning from telemetry ([Q02]); recycle-constant tuning ([P04]).
- [ ] Cost/usage visibility for shared-agent traffic in the /usage surface.

| Checkpoint | Verification |
|------------|--------------|
| SharedAgent core | `cargo nextest run -p tugcast shared_agent` |
| Both features on Haiku | #step-6 (real-claude test + core tier) |
| Stack removed | #step-10 sweeps + core tier |
