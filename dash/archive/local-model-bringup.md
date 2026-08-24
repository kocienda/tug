<!-- devise-skeleton v4 -->

## Local-Model Bring-Up — Apple Foundation Models for Shell Routing and Pulse Overviews {#local-model-bringup}

**Purpose:** Power two features with Apple's on-device Foundation Models framework (macOS 26+): model-assisted shell/prompt disambiguation in the Session card's prompt entry, and a high-level "overview" line in the Pulse strip. Zero model acquisition — the OS ships and maintains the model; on machines below macOS 26 or without Apple Intelligence, both surfaces behave exactly as today.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft — **deferred until Golden Gate adoption** (see #timing) |
| Target branch | dash worktree |
| Last updated | 2026-07-26 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

The Bonsai evaluation (`dash/local-model-investigations.md`) established the through-line: small local models excel at short-context bounded work (classification, digest→headline) and fail at long-context comprehension (scribe stays Sonnet, untouchable). Two features fit the strength zone: **shell-line disambiguation** — the heuristic classifier on main is parked off (`AUTO_SHELL_DETECTION_ENABLED = false` in `tugdeck/src/lib/shell-line-classifier.ts`) explicitly "until a model classifier can judge intent" — and a **Pulse part-one overview** line above the existing verbatim beat.

An earlier revision of this plan brought those features up on a third-party model (Ternary-Bonsai-8B via mlx-swift). That approach was **rejected on cost**: ~80% of it was acquisition infrastructure — a 2 GB resumable download, a TugSetup step, tugapp's first SPM dependency, a 2–3 GB resident service with lifecycle management, model-upgrade plumbing — carrying two marginal features. Cloud (Haiku) was also rejected: too slow for the ~250 ms classify budget, and continuous pulse-cadence calls burn the user's Claude-subscription quota on ambience.

**Apple's Foundation Models framework deletes the entire acquisition problem.** Since macOS 26, `import FoundationModels` exposes the system's on-device ~3B language model behind a Swift API: no download, no weights to host or verify, no SPM dependency (it's a system framework), no resident RAM Tug owns, no upgrade treadmill — and it is private and offline by construction, with **guided generation** (`@Generable` types with constrained decoding) that makes malformed classify output structurally impossible. Both tasks sit squarely in a 3B's strength zone per the eval's own conclusion; whether *this* 3B clears the quality bars is the plan's front-loaded spike, with a STOP rule.

#### Timing — why this plan is parked {#timing}

Adopting FoundationModels ties these two features (not Tug generally — the deployment target stays 13.0) to **macOS 26+**. The owner skipped the Tahoe (26) release deliberately and intends to evaluate **Golden Gate** (the successor release) before moving. This plan is written to be implementable *then*, with today's facts baked in:

- The build machine already runs **Xcode 26.3 on Sequoia 15.6** — the macOS 26 SDK and `FoundationModels` headers are compilable *now*. All code in this plan is written under `#if canImport(FoundationModels)` + `@available(macOS 26.0, *)` guards, so it builds with the current toolchain and is inert at runtime below 26.
- The **spike (Step 1) requires real macOS 26+ hardware with Apple Intelligence enabled**. Apple Intelligence does not function inside virtual machines — the Tart VM lab (`/Volumes/Lab-A`) **cannot** run it. Until a physical machine runs 26+, Step 1 cannot execute, and Step 1 gates everything.
- Nothing else in the plan decays while parked: every cited file/symbol is on main today; re-verify anchors against the tree before implementing (standard practice for a shelved plan).

#### Strategy {#strategy}

- **Spike first, with a STOP rule.** Step 1 runs the eval's 26-line classify corpus and six pulse-digest fixtures against the system model on real 26+ hardware. Below bar ⇒ halt; the features stay parked and the Bonsai record remains the fallback reference.
- **Availability is the gate; flags are kill switches.** `SystemLanguageModel.default.availability` (Swift-side) is the single truth for "can we infer"; per-feature tugbank flags default ON because there is no acquisition cost and the OS-level Apple Intelligence switch is the real consent surface ([P04] — default flagged for owner review, [Q05]).
- **No TugSetup involvement, no downloads, no control-frame vocabulary for acquisition.** The deck learns availability by asking the host over the existing WKWebView bridge; tugcast learns it by asking and being refused (back-off). `actions.rs::dispatch_action` is untouched.
- **The Session card never blocks on inference.** Heuristic bands route the certain cases instantly; the model decides only the ambiguous middle, pre-consulted on a typing debounce with a hard 250 ms submit budget ([P08], Spec S05).
- **PulseVoice (part two) is untouched.** The overview is a new tugcast emitter broadcasting `kind:"overview"` pulse frames; the tugpulse daemon and its wire tap are not modified ([P09]).
- **Strict enhancement.** macOS < 26, Apple Intelligence off, model not ready, flag off, headless tugcast, browser deck, app-tests — in every such state both surfaces are byte-identical to today's main ([P10]).

#### Success Criteria (Measurable) {#success-criteria}

- Spike: ≥ 25/26 on the classify corpus with guided-generation output, each call ≤ 400 ms warm; all six pulse digests produce accurate, preamble-free headlines ≤ 3 s each; no framework throttling observed at the planned cadences (Step 1 harness, real hardware).
- With the model available and flags on: typing `make the button bigger` routes to Claude, `make test` routes to shell; unambiguous lines never issue a model call (assertable in unit tests of the band logic).
- With the model available: an active session's Pulse strip shows a stable overview line above the live beat within ~30 s of turn activity.
- On this Sequoia machine (model structurally unavailable): both surfaces render and behave exactly as current main — pinned by the Step 8 app-test.
- `cd tugrust && cargo nextest run`, `just test-ts`, `cd tugdeck && bunx vite build`, `just app-debug`, `just app-test-changed` green at every step boundary.

#### Scope {#scope}

1. Spike: system-model quality + latency + throttling on the two tasks (real 26+ hardware).
2. Tug.app: `LocalModelService` on FoundationModels (availability, guided classify, summarize) + the `localModel` WKWebView bridge endpoint.
3. tugdeck: local-model store (flags + availability) + bridge client.
4. tugdeck: shell disambiguation — heuristic bands + async model tiebreak, un-parking the feature.
5. tugcast + Tug.app: summarize round-trip over the control socket.
6. tugcast + tugdeck: Pulse part-one overview (digest, cadence, `kind:"overview"` frame, two-line strip).

#### Non-goals (Explicitly out of scope) {#non-goals}

- Scribe changes of any kind — commit drafting stays on Sonnet; no code path may silently route it locally.
- Third-party models, model downloads, mlx-swift, llama.cpp, Python — the entire acquisition problem is out.
- Raising Tug's deployment target (stays 13.0) or requiring macOS 26 for anything outside these two features.
- TugSetup changes of any kind.
- A settings surface for the flags ([Q03] deferred — the `tugbank` CLI / defaults PUT is the v1 writer).
- Ledger persistence for overview lines ([Q04] deferred).
- The larger Pulse/Lens multi-session redesign — this plan lands only the overview line it will build on.
- Apple's server-tier Private Cloud Compute model — on-device only.

#### Dependencies / Prerequisites {#dependencies}

- **Hard:** a physical Mac on macOS 26+ (Golden Gate) with Apple Intelligence enabled, for the spike and all live verification. Not satisfiable in the Tart VM lab (Apple Intelligence is unavailable in VMs).
- Xcode with the macOS 26+ SDK — **already satisfied** (Xcode 26.3 on the build machine).
- A dash worktree (user-created) for implementation.

#### Constraints {#constraints}

- **WARNINGS ARE ERRORS** across the Rust workspace (`tugrust/.cargo/config.toml`).
- All FoundationModels code behind `#if canImport(FoundationModels)` + `@available(macOS 26.0, *)`; the app must keep building and running on macOS 13–15 unchanged.
- The on-device model's context window is small (~4 K tokens) — the overview digest budget must respect it (Spec S04 caps well under).
- No localStorage/sessionStorage/IndexedDB; persistent deck state via tugbank `/api/defaults/<domain>/<key>`.
- Deck work obeys tuglaws ([L01], [L02], [L06], [L07], [L24]); the State Zone Mapping below is normative.
- App-tests selective (`just app-test-changed`); every new test carries `@covers`. bun, never npm; `bunx vite build` before declaring tugdeck work done.
- Only the user commits on main; implementation commits on the dash via `tugutil dash commit`.

#### Assumptions {#assumptions}

- FoundationModels needs no special entitlement and works from a signed GUI app (verify in spike; the framework is public API).
- Guided generation with a two-case `@Generable` enum yields deterministic SHELL/PROMPT labels at temperature 0 (constrained decoding guarantees well-formedness; the spike measures accuracy).
- Foreground app usage at our cadences (a few classify calls while typing; ≤ 4 summaries/min across sessions) stays under any framework rate limiting — the spike observes this explicitly ([Q02]).
- The control socket, CONTROL plumbing, and tugbank DEFAULTS subscriptions behave as they do on main today.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Does the system model clear the quality bars on the two tasks? (OPEN) {#q01-system-model-quality}

**Question:** The eval's 26/26 classify and clean headlines were measured on Bonsai-8B variants; the Apple on-device model (~3B, quantized) has never run these tasks.

**Why it matters:** Below bar ⇒ the features stay parked; there is no cheaper engine left (Bonsai rejected on infrastructure cost, Haiku on latency/quota).

**Plan to resolve:** Step 1 spike on real hardware; guided generation for classify; the frozen prompts from `~/bonsai-eval/classify_8b.py` / `pulse_8b.py` adapted to `LanguageModelSession` instructions.

**Resolution:** OPEN — Step 1 is the gate. STOP rule: classify < 25/26 or hallucinated/preambled headlines after one round of prompt tightening ⇒ halt and report.

#### [Q02] Framework throttling / rate limits at our cadences (OPEN) {#q02-framework-throttling}

**Question:** Does FoundationModels throttle sustained foreground use (typing-debounce classify bursts; up to ~4 summarize calls/min across active sessions)?

**Why it matters:** Silent throttling would degrade both features unpredictably; we need the envelope before wiring cadences.

**Plan to resolve:** Step 1 includes a sustained-cadence soak (30 min of mixed classify+summarize at planned rates) and records observed behavior.

**Resolution:** OPEN — resolved by Step 1; cadence constants in Spec S04 adjust to findings.

#### [Q03] Settings surface for the feature flags (DEFERRED) {#q03-settings-reentry}

**Resolution:** DEFERRED. Flags default ON ([P04]) and the OS's Apple Intelligence switch is the primary consent; a Tug-side toggle rides the future settings/Lens work. V1 writer is the `tugbank` CLI or a PUT to `/api/defaults/dev.tugtool.local-model/<key>`.

#### [Q04] Overview lines in the pulse ledger (DEFERRED) {#q04-overview-ledger}

**Resolution:** DEFERRED — v1 overviews are broadcast-only; a freshly connected deck waits ≤ one cadence tick (~30 s of activity) for its first overview. Revisit with the Pulse redesign, which will want overview history anyway.

#### [Q05] Default-ON shell routing (OPEN — owner review) {#q05-default-on-shell}

**Question:** [P04] defaults `shell-routing` to ON (lighting up wherever Apple Intelligence is available). The Bonsai revision made the whole feature opt-in via TugSetup because opting in meant a 2 GB download; that cost is gone, but auto-routing still changes typing behavior the user didn't explicitly request.

**Why it matters:** Wrong default = either a surprising behavior change (ON) or a feature nobody discovers (OFF, with no settings surface yet).

**Options:**
- ON — the visible `→ shell` attribution + one-click "send to Claude instead" make it discoverable and undoable.
- OFF until a settings surface exists.

**Resolution:** OPEN — decided by the owner at implementation time; the plan is written default-ON and flipping is a one-constant change in Step 4.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| System model below quality bar (R01) | high | med | Spike gate with STOP rule | Step 1 results |
| Framework throttling at cadence (R02) | med | low–med | Spike soak; cadence constants adjustable; refusal back-off already designed | Step 1 soak |
| macOS-26 tie / Golden Gate never adopted (R03) | high | — | Deliberate: the plan is parked until adoption; nothing is built speculatively | owner's OS decision |
| Apple changes model behavior across OS updates (R04) | med | med | Guided generation pins output *shape*; keep the spike harness re-runnable as a regression check after OS updates | any post-update misbehavior |
| Misroute prose to shell (R05) | med | low | Asymmetric bands (Spec S05): unsure+no-verdict ⇒ Code; visible auto-route attribution with one-click undo | user misroute reports |

**Risk R04: OS-update model drift** {#r04-model-drift}

- **Risk:** The system model is Apple's to update; a macOS point release could shift classify accuracy or headline style under us.
- **Mitigation:** the spike harness (Step 1 artifact, kept in `~/bonsai-eval/` beside the Bonsai harnesses) re-runs in minutes after any OS update; guided generation makes output *format* drift impossible — only accuracy can move, and the bands bound its blast radius.
- **Residual risk:** a genuine accuracy regression would need prompt re-tuning or temporarily flipping the flags off — both cheap.

---

### Design Decisions {#design-decisions}

#### [P01] The spike is a hard gate, on real hardware (DECIDED) {#p01-spike-gate}

**Decision:** Step 1 runs before any integration work, on a physical macOS 26+ machine with Apple Intelligence enabled, and the plan halts if quality or latency misses the bar.

**Rationale:**
- The system model has never run these tasks; "3B-class task shape fits" is an inference, not a measurement.
- Apple Intelligence does not run in VMs — the Tart lab cannot substitute, so the spike also defines the plan's earliest possible start date.

**Implications:**
- Steps 2+ depend on #step-1 transitively; the Step Status Ledger makes the gate visible to `/tugplug:implement`.
- Spike findings (scores, latencies, throttling, final prompts) are written back into this document ([Q01]/[Q02] resolutions).

#### [P02] Runtime = FoundationModels system framework, availability-gated (DECIDED) {#p02-runtime-foundation-models}

**Decision:** Inference runs in Tug.app via `import FoundationModels` (`SystemLanguageModel.default` + `LanguageModelSession`), wrapped in `#if canImport(FoundationModels)` + `@available(macOS 26.0, *)`; the deployment target stays **13.0**.

**Rationale:**
- Zero acquisition infrastructure: no download, no SPM dependency (system framework — at most a weak-linked framework reference in the pbxproj, not a package), no resident memory Tug owns, no upgrade plumbing; private and offline by construction.
- Xcode 26.3 is already the build toolchain, so this compiles today and is inert below macOS 26.

**Implications:**
- `SystemLanguageModel.default.availability` is the single availability truth (`.available` / `.unavailable(reason:)` — device ineligible, Apple Intelligence not enabled, model assets not ready).
- Below-26 builds of the service compile to a stub that always reports unavailable (the `#if canImport` else-branch), so all callers exercise the degradation path on today's machines.

#### [P03] No third-party weights; the Bonsai path is shelved, not deleted (DECIDED) {#p03-no-third-party}

**Decision:** Tug ships no model weights. The Bonsai/mlx-swift approach (previous revision of this plan) is superseded; its durable record stays in `dash/local-model-investigations.md` and this file's history.

**Rationale:**
- The acquisition infrastructure (downloader, TugSetup step, first SPM dep, RAM lifecycle) was ~80% of that plan's weight, carried by two marginal features — rejected by the owner on cost.
- If Apple's model fails the spike, reopening Bonsai is a deliberate decision, not a fallback this plan performs.

**Implications:**
- No manifest, no models directory, no download control vocabulary, no `reqwest`, no TugSetup changes; `actions.rs::dispatch_action` is untouched.

#### [P04] Per-feature tugbank kill switches, default ON (DECIDED — default flagged [Q05]) {#p04-feature-flags}

**Decision:** Domain `dev.tugtool.local-model`, keys `shell-routing` and `pulse-overview` (`Value::Bool`), read default-**ON** when absent — the repo's standard kill-switch shape (the `dev.tugtool.pulse`/`enabled` pattern: absent ⇒ enabled, live-flipped via DEFAULTS-frame subscription).

**Rationale:**
- With zero acquisition cost, the OS-level Apple Intelligence switch is the real consent gate; Tug-side flags exist to turn a misbehaving feature off, not to gate an investment.
- Default-ON for `shell-routing` is the one contestable call — recorded as [Q05] for owner review; flipping the default is one constant.

**Implications:**
- Constants declared in parallel Rust + TS: `LOCAL_MODEL_DOMAIN = "dev.tugtool.local-model"`, `SHELL_ROUTING_KEY = "shell-routing"`, `PULSE_OVERVIEW_KEY = "pulse-overview"`.
- No settings UI in scope ([Q03]); the `tugbank` CLI / defaults PUT is the writer.

#### [P05] Availability flows from Swift; tugcast learns by refusal (DECIDED) {#p05-availability-flow}

**Decision:** The deck queries availability over the bridge (`task:"availability"`, cached in the local-model store, re-queried on window focus and after any classify error); tugcast never tracks availability — its summarize requests are simply refused (`ok:false, error:"unavailable"`) and the overview emitter backs off (60 s, doubling to 10 min while refusals continue, reset on success).

**Rationale:**
- One source of truth (the Swift host, the only process that can ask the framework); no new push channels or probe vocabulary.
- The refusal/back-off shape costs nothing and covers headless tugcast for free.

**Implications:**
- `useLocalModelReady()` in the deck = flag ON && availability `available`; below-26 hosts and browser-dev answer unavailable via the stub/absent-handler paths with no special cases.

#### [P06] Classify IPC = WKWebView script-message bridge (DECIDED) {#p06-classify-ipc}

**Decision:** A new `localModel` script-message handler in `tugapp/Sources/MainWindow.swift` (registered beside `clipboardRead` etc.), request/reply correlated by `requestId`, replies via `window.__tugBridge?.onLocalModelResult?.(…)`.

**Rationale:**
- The classify caller is deck code; the bridge is the direct channel, and `(w.__tugBridge ??= {})` request/reply is the established deck-side pattern (`native-path-picker.ts`, `os-export.ts`, `maker-mode-bridge.ts`).

**Implications:**
- New deck module `tugdeck/src/lib/local-model-bridge.ts` (Spec S02): pending map, 1500 ms timeouts, hard null-path when `window.webkit?.messageHandlers?.localModel` is absent (browser dev, app-tests).

#### [P07] Summarize IPC = UDS control socket, supervisor-sourced identity (DECIDED) {#p07-summarize-ipc}

**Decision:** tugcast requests overview summaries over the existing control socket: a tugcast→app `local_model_request` line via the app-bound drain channel, answered by a new `ControlMessage::LocalModelResult` variant (Spec S03). The overview emitter receives session identity from the supervisor at wiring time.

**Rationale:**
- The digest inputs are tugcast-side; the model is Swift-side; the socket already connects exactly these two (`tugrust/crates/tugcast/src/control.rs` ↔ `tugapp/Sources/ControlSocket.swift` / `ProcessManager.handleControlMessage`).
- The app-bound drain channel already exists: `main.rs` creates `mpsc::channel::<String>(4)` over `writer.into_inner()` and clones its sender into `run_recv_loop` — a summarize requester takes another clone.
- **Identity (load-bearing):** the tug-session→claude-session mapping lives in `AgentSupervisor`'s **in-memory** session map; the `SessionResolver` closure `draft_engine.rs` uses is built inline over it (the `try_lock` closure in the draft-request handler) and is unreachable from a bare `main.rs` task. The emitter is constructed with (a) a `SessionResolver` over an `Arc` clone of that map (same `try_lock`-degrade shape) and (b) `SessionRow.project_dir` from the SQLite `SessionLedger`. Unresolvable identity ⇒ skip the tick.

**Implications:**
- Headless tugcast (no socket, e.g. `just dev`) answers unavailable immediately — overview silently absent, per [P10].
- 10 s request timeout tugcast-side; pending map of oneshot senders resolved in `run_recv_loop`.

#### [P08] Shell routing: heuristic bands + async model tiebreak, never blocking (DECIDED) {#p08-shell-bands}

**Decision:** Refactor the submit-time classifier into three bands (Spec S05): **shell** and **prompt** route instantly on heuristic certainty; **unsure** (first token is a PATH executable but the heuristic refuses) is decided by a cached/awaited model verdict with a hard 250 ms submit budget — no verdict in time ⇒ Code. Pre-consult on a 300 ms typing debounce. Live only when `useLocalModelReady()` holds; otherwise byte-identical to today's parked behavior.

**Rationale:**
- Preserves the asymmetric-cost doctrine written into `shell-line-classifier.ts` (prose at the shell error-barfs; a command at Claude degrades gracefully) — the model only ever *adds* shell routes to lines the heuristic declined.
- Guided generation (a `@Generable` two-case enum) makes the verdict structurally well-formed; only accuracy is at stake, and the spike measures that.

**Implications:**
- `AUTO_SHELL_DETECTION_ENABLED` is deleted; both entry points gate on caller-supplied availability (read via refs/singletons per [L07], never per-keystroke React state).
- New pure export `bandShellLine(text, commands): "shell" | "prompt" | "unsure"`; `classifyShellLine` becomes the compatibility wrapper (`band === "shell"`).

#### [P09] Pulse part-one is a new tugcast emitter; `kind:"overview"` frames (DECIDED) {#p09-overview-component}

**Decision:** New module `feeds/session_overview.rs` taps the CODE_OUTPUT broadcast (own replay-mute brackets mirroring `forwardable_session` in `feeds/pulse.rs`), builds per-session digests, requests summaries over [P07] on a cadence, and broadcasts PulseLine-shaped frames with optional `kind:"overview"` on the PULSE feed. The tugpulse daemon, `PulseVoice`, and the forward allowlist are untouched.

**Rationale:**
- The pulse wire tap deliberately mutes user messages; goal prompts must come from the session JSONL — the `scribe::session_prompts_since` path (JSONL = ledger `claude_projects_root()` + `encode_claude_project_name(project_dir)` + `<claude_id>.jsonl`, per `draft_engine.rs::session_user_prompts`).

**Implications:**
- `parsePulseFrame` (`tugdeck/src/protocol.ts`) and `PulseLine` (`tugcode/src/pulse/types.ts`) gain optional `kind`; absent ⇒ beat (backward compatible; tugcode never emits it).
- `pulse-store.ts` tracks latest overview per scope, separate from beat history; `session-pulse-strip.tsx` renders it as a first line.
- Overviews are not ledgered in v1 ([Q04]).

#### [P10] Strict enhancement: every consumer degrades to today (DECIDED) {#p10-graceful-degradation}

**Decision:** macOS < 26, Apple Intelligence disabled, model not ready, flag off, headless tugcast, browser deck, app-test runs — in every such state, shell routing and the Pulse strip behave byte-identically to current main. No user-facing error ever originates from model unavailability.

**Implications:**
- The below-26 stub service, the absent-bridge null path, and the socket refusal back-off are the three degradation legs; the Step 8 app-test pins the deck-visible outcome on this (Sequoia) machine, where the model is structurally unavailable — the degradation path is the *only* path testable before Golden Gate, which is exactly why it gets the automated pin.

#### [P11] Session and generation discipline (DECIDED) {#p11-generation-discipline}

**Decision:** `LocalModelService` uses short-lived, single-purpose `LanguageModelSession`s (fresh session per request, task-specific `instructions`), temperature 0, guided generation for classify (`@Generable enum ShellVerdict { case shell, prompt }` via `respond(to:generating:)`), plain-text with a small `maximumResponseTokens` for summarize, and `prewarm()` on the classify path when the prompt entry gains focus.

**Rationale:**
- Fresh sessions avoid context accumulation toward the ~4 K window and cross-request bleed; the framework manages model residency itself — no lazy-load/idle-unload machinery for Tug to own (a whole decision from the Bonsai revision deleted).
- Constrained decoding eliminates output-parsing failure modes entirely for classify.

**Implications:**
- The frozen prompts port from the Step 1 spike as Swift string constants with a source comment naming the harness file.
- Digest budget (Spec S04) caps well under the context window.

---

### Deep Dives {#deep-dives}

#### End-to-end flows {#e2e-flows}

**Classify (typing):** prompt-entry updateListener detects an unsure-band draft on a 300 ms debounce (reusing the existing cheap pre-gates: single line, ≤ 256 chars, atom-free) → `requestClassify(text)` → `postMessage` on `localModel` → `MainWindow` dispatch → `LocalModelService.classify` (guided enum, temp 0) → `onLocalModelResult` → verdict cached keyed on exact draft text. Submit: band `shell` ⇒ existing auto-route path (`shellStore.exec(text, {origin:"auto"})` + history push, unchanged); `prompt` ⇒ Code; `unsure` ⇒ cached verdict, else await in-flight ≤ 250 ms, else Code.

**Availability:** deck store queries `task:"availability"` at bridge attach, on window focus, and after any classify error; Swift answers from `SystemLanguageModel.default.availability` (stubbed unavailable below 26). tugcast never asks — its requests get refused and the emitter backs off.

**Overview (session activity):** `session_overview` accumulates per-session `tool_use` digests from its own `code_tx` subscription → cadence fires (Spec S04) → goal prompts from session JSONL via supervisor-provided identity ([P07]) → digest prompt → `local_model_request` over the socket → `LocalModelResult` → PULSE broadcast `{type:"pulse", kind:"overview", text, scopes:[tug_session_id], beat, at}` → `pulse-store` latest-overview-per-scope → strip renders it above the beat line.

#### Control-socket extension details {#control-socket-extension}

Today: app→tugcast deserializes as `ControlMessage` (`control.rs`, serde `tag="type"`, snake_case: `Tell`/`Shutdown`/`DevMode`); tugcast→app lines are hand-built JSON written by the drain task fed from the `mpsc::channel::<String>(4)` in `main.rs`. Swift: `ControlSocketConnection.send(_ dict:)` writes newline JSON; `ProcessManager.handleControlMessage` switches on `type` (`ready`, `dev_mode_result`, `shutdown`, `tell`). Extension: (1) a small handle struct in tugcast holding a clone of the drain sender + `Arc<Mutex<HashMap<String, oneshot::Sender<LocalModelReply>>>>`; (2) `ControlMessage::LocalModelResult { id, ok, text: Option<String>, error: Option<String> }` routed in `run_recv_loop` to the pending map; (3) Swift `case "local_model_request"` → service call off-main (`Task { … }`) → `connection.send(["type":"local_model_result", "id": id, …])`.

#### FoundationModels integration notes {#foundation-models-notes}

- Availability: `SystemLanguageModel.default.availability` — switch `.available` / `.unavailable(let reason)`; reasons include device ineligibility, Apple Intelligence not enabled, and model assets not ready (transient after enablement/updates — treat as unavailable, re-query later).
- Classify: `let session = LanguageModelSession(instructions: CLASSIFY_INSTRUCTIONS)`; `try await session.respond(to: line, generating: ShellVerdict.self, options: .init(temperature: 0))` — constrained decoding guarantees one of the two enum cases.
- Summarize: plain `respond(to:)` with `GenerationOptions(temperature: 0, maximumResponseTokens: ~48)`; clip to 110 chars deck-side regardless.
- `prewarm()` hides first-call model-load latency; call it when the prompt entry focuses (classify path) — cheap, idempotent.
- All of the above lives inside `#if canImport(FoundationModels)` with an `@available(macOS 26.0, *)` implementation class; the `#else` / below-26 branch is a stub whose every call answers unavailable. `MainWindow`/`ProcessManager` call through a thin protocol so call sites carry no availability annotations.
- Errors worth distinct handling: context-window-exceeded (should be impossible at our budgets — log loudly if seen) and guardrail refusals (the framework can decline content — treat as null verdict / skipped tick, never surfaced to the user).

#### Task prompts {#task-prompts}

The validated Bonsai-era prompts live in `~/bonsai-eval/classify_8b.py` (SHELL/PROMPT over one line) and `~/bonsai-eval/pulse_8b.py` (compact digest → one headline; tightening line: terse headline ≤ ~10 words, no preamble). Step 1 adapts them to `instructions:`-style phrasing for `LanguageModelSession`, re-validates, and freezes the final strings into this document's [Q01] resolution; Step 2 ports them verbatim into `LocalModelService`.

---

### Specification {#specification}

**Spec S01: Feature flags** {#s01-feature-flags}

Domain `dev.tugtool.local-model`; keys `shell-routing`, `pulse-overview`; `Value::Bool`; absent/unreadable ⇒ **true** (kill-switch convention, matching the `PULSE_ENABLED_DOMAIN` reader shape in `feeds/pulse.rs` / `main.rs`). Rust consts in `feeds/session_overview.rs`; TS consts in `local-model-store.ts`; deck subscribes to DEFAULTS frames filtered on the domain for live flips (the `pulse-store.ts` pattern).

**Spec S02: Bridge messages** {#s02-bridge-messages}

Deck→Swift on handler `localModel`: `{requestId: string, task: "classify", text: string}` or `{requestId, task: "availability"}`. Swift→deck: `window.__tugBridge?.onLocalModelResult?.({requestId, ok: bool, verdict?: "shell"|"prompt", availability?: "available"|"unavailable", error?: string})`. Deck client `local-model-bridge.ts`: `requestClassify(text) => Promise<"shell"|"prompt"|null>` (null on 1500 ms timeout / missing handler / `ok:false`), `requestAvailability() => Promise<boolean>`; module-scope pending map; `(w.__tugBridge ??= {})` sink registration at module init.

**Spec S03: Control-socket summarize messages** {#s03-socket-summarize}

tugcast→app: `{"type":"local_model_request","id":string,"task":"summarize","prompt":string}`. app→tugcast: `{"type":"local_model_result","id":string,"ok":bool,"text":string|null,"error":string|null}` as `ControlMessage::LocalModelResult`. tugcast timeout 10 s. Swift answers `ok:false, error:"unavailable"` when availability fails (including the below-26 stub); tugcast treats refusal as absence and backs off (60 s doubling to 10 min while refusals continue, reset on success).

**Spec S04: Overview emission** {#s04-overview-emission}

Frame: `{"type":"pulse","kind":"overview","text":headline,"scopes":[tug_session_id],"beat":n,"at":ms}` on `FeedId::PULSE`. Cadence per session: ≥ 8 forwarded `tool_use` frames since last emit OR 30 s elapsed with ≥ 1 new frame; hard floor 15 s; skip when digest unchanged or headline identical. Gating: `pulse-overview` flag (S01) AND `dev.tugtool.pulse`/`enabled` (the strip hides entirely when pulse is off — never spend inference on invisible lines) AND not in refusal back-off. Digest: up to 10 user prompts (≤ 1500 chars) via `scribe::session_prompts_since(&jsonl, 0, 10, 1_500)` with identity per [P07]; plus last ≤ 40 `tool_use` entries as `name(short-target)` lines (target = the input's path/command field, ~60 chars); total budget deliberately ≪ the model's ~4 K context. Unresolvable identity ⇒ skip tick. Headline clipped to 110 chars (PulseLine doctrine).

**Spec S05: Shell-routing bands** {#s05-shell-bands}

`bandShellLine(text, commands): "shell" | "prompt" | "unsure"` refactored from `classifyShellLine`'s body: after the existing shape gates (length ≤ 400, no leading `/`/`#`) and env-assign skip — first token neither a PATH executable nor path-shaped ⇒ `"prompt"`; trailing `?` ⇒ `"prompt"`; all vetoes passed (current-logic true) ⇒ `"shell"`; PATH-executable first token but vetoed (bare ambiguous opener; stopword without strong signal; ≥ 8 tokens without strong signal) ⇒ `"unsure"`. `classifyShellLine` = wrapper (`band === "shell"`). Both entry points take caller-supplied availability (from `useLocalModelReady()` via the existing ref plumbing in `tug-prompt-entry.tsx`); `autoShellOpener`'s logic is unchanged (unambiguous openers only) behind the same gate. Verdict cache: plain `Map<string, "shell"|"prompt">`, cap 32, cleared on submit/clear.

#### State Zone Mapping (tugdeck/tugways plans) {#state-zone-mapping}

| State | Zone (appearance / local-data / structure) | Mechanism | Law |
|-------|--------------------------------------------|-----------|-----|
| flags + availability snapshot | external state | new `local-model-store.ts` (module singleton) + `useSyncExternalStore`; tugbank DEFAULTS subscription + bridge availability queries | [L02], [L24] |
| classify verdict cache + pending map | local-data (non-render) | module-scope `Map` in `local-model-bridge.ts` / refs in `tug-prompt-entry.tsx` — never React state (must not re-render per keystroke) | [L06], [L07] |
| overview line per scope | external state | `pulse-store.ts` extension (`latestOverviewForScope`) | [L02] |
| two-line strip layout | appearance | CSS in `session-pulse-strip` (no reserved empty row when overview absent) | [L06] |

---

### Compatibility / Migration / Rollout {#rollout}

- **Compatibility:** deployment target unchanged (13.0); `kind` on pulse frames is optional and ignored by older parsers; control-socket and bridge vocabularies purely additive; tugcode inbound allowlist untouched (no new client→tugcode messages).
- **Rollout:** features light up only where Apple Intelligence is available; per-feature kill switches (S01) flip live without relaunch. Rollback = flip flags off; full rollback = revert the dash.
- **OS updates:** after any macOS update on the host, re-run the spike harness as a regression check (Risk R04).

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tugapp/Sources/LocalModelService.swift` | [P11] service: availability, guided classify, summarize, prewarm; `#if canImport` stub below macOS 26 |
| `tugdeck/src/lib/local-model-store.ts` | flags + availability snapshot, `useLocalModel()`, `useLocalModelReady()` |
| `tugdeck/src/lib/local-model-bridge.ts` | Spec S02 client: `requestClassify`, `requestAvailability`, pending map, sink |
| `tugrust/crates/tugcast/src/feeds/session_overview.rs` | [P09] emitter: digest, cadence, summarize round-trip, PULSE broadcasts |
| `tests/app-test/at0xxx-local-model-absent.test.ts` | degradation pin (typing-level; never submits a turn) |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `LOCAL_MODEL_DOMAIN` / `SHELL_ROUTING_KEY` / `PULSE_OVERVIEW_KEY` | const | `session_overview.rs` + `local-model-store.ts` (parallel decl) | S01; absent ⇒ true |
| `ShellVerdict` | `@Generable` enum | `LocalModelService.swift` | two cases; constrained decoding |
| `case "localModel"` + reply | handler | `tugapp/Sources/MainWindow.swift` | S02; registered beside `clipboardRead` |
| `case "local_model_request"` | handler | `tugapp/Sources/ProcessManager.swift::handleControlMessage` | S03 |
| `ControlMessage::LocalModelResult` | enum variant | `tugrust/crates/tugcast/src/control.rs` | S03; pending-map routing in `run_recv_loop` |
| `bandShellLine` | fn | `tugdeck/src/lib/shell-line-classifier.ts` | S05; `AUTO_SHELL_DETECTION_ENABLED` deleted |
| `PulseLine.kind?: "overview"` | field | `tugcode/src/pulse/types.ts`, `tugdeck/src/protocol.ts` (`parsePulseFrame`), `pulse-store.ts` | [P09]; absent ⇒ beat |
| `latestOverviewForScope` | fn/selector | `tugdeck/src/lib/pulse-store.ts` | strip's first line |

---

### Documentation Plan {#documentation-plan}

- [ ] Update `dash/local-model-investigations.md` status line to note the Apple-runtime pivot and point here.
- [ ] Record spike results ([Q01]/[Q02] resolutions, frozen prompts) in this document during Step 1.

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit (Rust, nextest)** | control-message serde; cadence/digest logic (identity injected as closures); gate truth table; refusal back-off | Steps 5–6 |
| **Unit (TS, bun test)** | band table (26-line corpus + parked-off motivating cases); wrapper equivalence; bridge timeout/absent-handler null paths; store frame folding; `parsePulseFrame` kind passthrough; overview/beat store separation | Steps 3–4, 7 |
| **App-test (selective)** | degradation pin on this (model-unavailable) machine | Step 8 |
| **Spike harness (not CI)** | model quality, latency, throttling; re-run after OS updates | Step 1, then regression |

#### What stays out of tests {#test-non-goals}

- Model output quality in CI — spike-validated on real hardware; CI never runs inference (and CI machines may lack Apple Intelligence entirely).
- Mocked-LLM UI flows — banned; the deck's decision logic is tested as pure functions with verdicts injected as arguments.
- Live two-line strip behavior — requires an available model; manual verification on Golden Gate hardware (Step 9), while the *absent* rendering gets the automated pin.
- Swift service internals — no XCTest scaffolding in tugapp; exercised end-to-end in Step 9 and structurally by the build.

---

### Execution Steps {#execution-steps}

> **Commit after all checkpoints pass.** Step 1 is the [P01] gate — it requires physical macOS 26+ hardware with Apple Intelligence enabled and cannot run before then. Below bar ⇒ STOP and report; do not proceed to Step 2.

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Spike — system-model quality, latency, throttling | pending (blocked on macOS 26+ hardware) | — |
| #step-2 | LocalModelService + bridge endpoint (tugapp) | pending | — |
| #step-3 | Deck local-model store + bridge client | pending | — |
| #step-4 | Shell disambiguation integration | pending | — |
| #step-5 | Control-socket summarize round-trip | pending | — |
| #step-6 | Overview emitter (tugcast) | pending | — |
| #step-7 | Overview rendering (deck) | pending | — |
| #step-8 | Degradation pin app-test | pending | — |
| #step-9 | Integration checkpoint — full feature matrix | pending | — |

#### Step 1: Spike — system-model quality, latency, throttling {#step-1}

**Commit:** `plan(local-model): record FoundationModels spike results (Q01, Q02)`

**References:** [P01], [P11], [Q01], [Q02], (#task-prompts, #foundation-models-notes, #success-criteria)

**Artifacts:**
- A small Swift CLI harness added to `~/bonsai-eval/` (outside the repo, beside the Bonsai harnesses) running: the 26-line classify corpus via guided `ShellVerdict` generation; the six pulse digests; a 30-minute mixed-cadence soak.
- [Q01]/[Q02] resolutions in this document: scores, per-call latencies, load/prewarm behavior, any throttling, the frozen `instructions` strings.

**Tasks:**
- [ ] Build and run on physical macOS 26+ hardware with Apple Intelligence enabled (NOT the Tart lab — Apple Intelligence is unavailable in VMs).
- [ ] Adapt the Bonsai-era prompts (#task-prompts); one round of prompt tightening allowed on the headline task per eval precedent; freeze finals.
- [ ] Record everything under [Q01]/[Q02]; flip their Resolutions.

**Tests:**
- [ ] The harness is the test; raw outputs recorded with the scores.

**Checkpoint:**
- [ ] Classify ≥ 25/26 at ≤ 400 ms warm; six accurate preamble-free headlines ≤ 3 s; no throttling at planned cadences. **Below bar ⇒ STOP the plan and report.**

---

#### Step 2: LocalModelService + bridge endpoint (tugapp) {#step-2}

**Depends on:** #step-1

**Commit:** `tugapp(local-model): FoundationModels service + localModel bridge endpoint`

**References:** [P02], [P05], [P06], [P11], Spec S02, (#foundation-models-notes)

**Artifacts:**
- `tugapp/Sources/LocalModelService.swift`: protocol + `@available(macOS 26.0, *)` implementation (`#if canImport(FoundationModels)`) + always-unavailable stub; availability, `classify` (guided enum, temp 0), `summarize` (temp 0, capped tokens), `prewarm`; frozen Step 1 prompts as constants with harness-source comments.
- `MainWindow.swift`: `contentController.add(self, name: "localModel")` beside existing registrations; dispatch case calling the service off-main; JSON-escaped reply via `evaluateJavaScript("window.__tugBridge?.onLocalModelResult?.(…)")` (follow the existing reply helpers' escaping pattern); malformed payloads answer `ok:false`.

**Tasks:**
- [ ] Implement; verify the app still builds and runs identically on this Sequoia machine (stub path).

**Tests:**
- [ ] Build is the structural test (no XCTest in tugapp); the sub-26 bridge answer (`availability:"unavailable"`) is verifiable here and now from the debug-app console.

**Checkpoint:**
- [ ] `just app-debug` green from clean; debug-app console: `availability` query answers `unavailable` on this machine; on 26+ hardware, `classify("make test")` ⇒ `shell`.

---

#### Step 3: Deck local-model store + bridge client {#step-3}

**Depends on:** #step-2

**Commit:** `tugways(local-model): flags + availability store and host bridge client`

**References:** [P04], [P05], [P10], Spec S01, Spec S02, (#state-zone-mapping)

**Artifacts:**
- `local-model-bridge.ts` per Spec S02 (pending map, timeouts, `(w.__tugBridge ??= {})` sink, absent-handler null path).
- `local-model-store.ts`: S01 flag reads with live DEFAULTS-subscription flips (the `pulse-store.ts` pattern, default ON); availability queried at attach / window focus / after classify errors; `useLocalModel()`, per-feature ready selectors (`shellRoutingReady`, `pulseOverviewEnabled`); store attach wired where `attachPulseStore` is wired in deck bootstrap.

**Tasks:**
- [ ] Implement both modules.

**Tests:**
- [ ] bun test: default-ON flag reads; availability folding; bridge timeout ⇒ null; absent handler ⇒ null (no throw).

**Checkpoint:**
- [ ] `just test-ts` && `cd tugdeck && bunx vite build`

---

#### Step 4: Shell disambiguation integration {#step-4}

**Depends on:** #step-3

**Commit:** `tugways(shell-routing): heuristic bands + async on-device tiebreak, un-parked behind availability`

**References:** [P08], [P10], [Q05], Spec S05, Risk R05, (#e2e-flows, #state-zone-mapping)

**Artifacts:**
- `shell-line-classifier.ts`: `bandShellLine` per Spec S05; `classifyShellLine` as wrapper; `AUTO_SHELL_DETECTION_ENABLED` deleted; entry points take caller-supplied availability.
- `tug-prompt-entry.tsx`: 300 ms debounce pre-consult (existing pre-gates reused: single line, ≤ 256 chars, atom-free), verdict cache (cap 32, cleared on submit/clear), submit band logic with ≤ 250 ms unsure-await falling back to Code; live-typing chip gate flipped from the deleted constant to `shellRoutingReady` via ref plumbing (the `pathCommandsStoreRef` pattern); auto-routed history push and `origin:"auto"` attribution byte-identical.

**Tasks:**
- [ ] Implement; honor [Q05]'s decided default at implementation time (one constant).

**Tests:**
- [ ] bun test: band table over the eval's 26-line corpus + the parked-off motivating cases (`write a poem`, `apply the patch` ⇒ unsure — never shell without a verdict); wrapper equivalence; cache cap/clear semantics as pure-helper tests.

**Checkpoint:**
- [ ] `just test-ts` && `cd tugdeck && bunx vite build`
- [ ] On this machine (unavailable): typing/submitting behaves exactly as main. On 26+ hardware: `make test` ⇒ shell, `make the button bigger` ⇒ Claude.

---

#### Step 5: Control-socket summarize round-trip {#step-5}

**Depends on:** #step-2

**Commit:** `tugcast+tugapp(local-model): summarize request/reply over the control socket`

**References:** [P07], Spec S03, (#control-socket-extension)

**Artifacts:**
- `control.rs`: `ControlMessage::LocalModelResult` + serde test (the `test_control_message_tell_deserialization` pattern); pending-map handle struct + `request_local_model_summary(prompt) -> oneshot` over a clone of the `main.rs` drain sender; 10 s timeout; headless (no socket) ⇒ immediate unavailable.
- `ProcessManager.swift`: `case "local_model_request"` → service off-main → `connection.send(["type":"local_model_result", …])`.

**Tasks:**
- [ ] Implement both sides.

**Tests:**
- [ ] nextest: `LocalModelResult` deserialization; pending-map resolve/timeout with a stubbed channel.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast`; `just app-debug` green.

---

#### Step 6: Overview emitter (tugcast) {#step-6}

**Depends on:** #step-5

**Commit:** `tugcast(pulse): session overview emitter — digest, cadence, on-device summarize`

**References:** [P07], [P09], [P10], Spec S01, Spec S03, Spec S04, (#e2e-flows)

**Artifacts:**
- `feeds/session_overview.rs`: per-session accumulator over its own `code_tx` subscription (replay-mute brackets mirroring `forwardable_session`); cadence + gates per Spec S04 (`pulse-overview` flag reader per S01 + the `pulse/enabled` reader shape reused from `main.rs` + refusal back-off); digest composer; summarize via the Step 5 handle; PULSE broadcasts; module one-way (outputs = broadcast + tracing only, the pulse bridge's isolation doctrine).
- `main.rs` wiring beside the pulse bridge task, constructed with identity handles per [P07]: `SessionResolver` over an `Arc` clone of the supervisor's in-mem session map (the `try_lock` shape) + the SQLite `SessionLedger` handle for `SessionRow.project_dir`; unresolvable identity skips the tick silently.

**Tasks:**
- [ ] Implement per specs.

**Tests:**
- [ ] nextest: cadence trigger table (8-frames / 30 s / 15 s floor / unchanged-skip); digest composition from fixture frames + fixture JSONL (resolver + project-dir injected as test closures); replay-bracket muting; frame shape (`kind:"overview"`, single scope, clipped text); gate truth table; back-off doubling/reset.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast`

---

#### Step 7: Overview rendering (deck) {#step-7}

**Depends on:** #step-6

**Commit:** `tugways(pulse): render the overview line above the live beat`

**References:** [P09], [P10], Spec S04, (#state-zone-mapping)

**Artifacts:**
- `protocol.ts::parsePulseFrame` + payload type: optional `kind` passthrough; `tugcode/src/pulse/types.ts::PulseLine` documents the field (tugcode never emits it; the type is the wire contract).
- `pulse-store.ts`: overviews stored separately (latest per scope; never entering beat `lines`/history/cleared-watermark machinery); `latestOverviewForScope` + hook.
- `session-pulse-strip.tsx` + CSS: overview as first line above the stage line; absent ⇒ single-line layout identical to today (no reserved empty row); beat-line min-dwell/queue design untouched; overview swaps instant.

**Tasks:**
- [ ] Implement.

**Tests:**
- [ ] bun test: `parsePulseFrame` kind passthrough + absent default; store separation; selector scope rules matching `latestLineForScope` semantics (session's own + `"app"`-wide + unscoped).

**Checkpoint:**
- [ ] `just test-ts` && `cd tugdeck && bunx vite build`

---

#### Step 8: Degradation pin app-test {#step-8}

**Depends on:** #step-4, #step-7

**Commit:** `test(app-test): pin model-unavailable degradation for local-model surfaces`

**References:** [P10], Spec S04, Spec S05, (#test-non-goals)

**Artifacts:**
- `tests/app-test/at0xxx-local-model-absent.test.ts` with `@covers` for `local-model-store.ts`, `session-pulse-strip.tsx`, `tug-prompt-entry.tsx`: on a model-unavailable instance (any pre-26 machine, and CI), the strip renders single-line and typing `make ` / `git ` never auto-inserts the `!shell` chip. **Typing-level only — never submits a turn** (a real send into a replay-backed harness session is out of bounds; submit-time semantics live in Step 4's pure-function suite).

**Tasks:**
- [ ] Write the test; `just app-test-covers-check` green.

**Tests:**
- [ ] `just app-test-changed`

**Checkpoint:**
- [ ] Suite green on this (Sequoia) machine — which exercises the exact degradation path shipping to every pre-Golden-Gate user.

---

#### Step 9: Integration checkpoint — full feature matrix {#step-9}

**Depends on:** #step-8

**Commit:** `N/A (verification only)`

**References:** [P10], (#success-criteria)

**Tasks:**
- [ ] On 26+ hardware with Apple Intelligence: live session shows an overview within ~30 s of activity; shell matrix (`make test` ⇒ shell, `make the button bigger` ⇒ Claude, `git status` instant-shell with no model call); flags flip both features off live without relaunch (DEFAULTS subscription); Apple Intelligence toggled off at OS level ⇒ both surfaces degrade to main behavior on next availability re-query.
- [ ] On this Sequoia machine: everything byte-identical to main.

**Tests:**
- [ ] `cd tugrust && cargo nextest run` && `just test-ts` && `cd tugdeck && bunx vite build` && `just app-test-changed`

**Checkpoint:**
- [ ] Full matrix passes on both machines.

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** Shell disambiguation and a Pulse overview line powered by the OS's on-device model — zero acquisition infrastructure, private and offline, lighting up automatically where Apple Intelligence is available and invisible everywhere else.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] Spike recorded and above bar ([Q01]/[Q02] resolved here).
- [ ] Both features live on Golden Gate hardware; both surfaces byte-identical to main wherever the model is unavailable (Step 9 matrix + Step 8 pin).
- [ ] Deployment target still 13.0; app builds and runs unchanged on macOS 13–15.
- [ ] Scribe untouched (no diff under `scribe.rs` or its callers).
- [ ] `cargo nextest run`, `just test-ts`, `bunx vite build`, `just app-debug`, `just app-test-changed` green.

**Acceptance tests:**
- [ ] Step 4 band-table unit suite.
- [ ] Step 6 cadence/digest/gate unit suite.
- [ ] Step 8 app-test degradation pin.

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] Settings surface for the flags ([Q03]).
- [ ] Overview persistence + history ([Q04]).
- [ ] The larger Pulse/Lens multi-session redesign building on the overview line.
- [ ] Further on-device tenants (session titles, lens ranking, dedup) — the task-shaped service API is ready for them.
- [ ] Re-run the spike harness after each macOS update (Risk R04) — cheap, manual, worth ritualizing.

| Checkpoint | Verification |
|------------|--------------|
| Spike gate | Step 1 recorded results vs Success Criteria bars |
| Degradation parity | Step 8 app-test + Step 9 Sequoia-side matrix |
| Live behavior | Step 9 Golden-Gate-side matrix |
| Workspace health | `cargo nextest run` / `just test-ts` / `bunx vite build` / `just app-debug` / `just app-test-changed` |
