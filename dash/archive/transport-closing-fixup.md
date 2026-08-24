<!-- devise-skeleton v4 -->

## Transport-Closing Resilience {#transport-closing-fixup}

**Purpose:** Make a WebSocket transport close a survivable, self-healing event: stop tugcast from killing healthy-but-quiet wires, stop the deck from locking every card behind a red error banner, and make session restore retry until it succeeds so a long-running turn can be left unattended.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-08-02 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

A couple of times a day, every Session card in the deck simultaneously drops its session and shows the red **Connection lost — transport closed** banner. The banner locks the card body (`inert`), its only affordance is Dismiss, and in the worst case the cards never come back on their own. This makes it unsafe to start a long-running turn and walk away from the machine — which is precisely when it happens, because walking away is the trigger condition.

The investigation that produced this plan found the trigger and the wound to be different things, and both to be ours. **One correction before you read further:** this plan originally treated the heartbeat policy as *the* trigger. It is *a* trigger — a real one, still worth the fix below — but `tugcast` also crashes several times a day with a `SIGBUS` that produces the identical symptom, and the original log check could not have found it. Read [#crashes-are-a-second-cause](#crashes-are-a-second-cause) before drawing conclusions about cause from anything in this section. The **trigger** described here is `tugcast`'s heartbeat policy: the router closes the client socket after 45 s without an explicit `FeedId::HEARTBEAT` frame, and `last_heartbeat` is refreshed by *nothing else* — not CONTROL, not CODE_INPUT, not any other inbound traffic. The deck sends that heartbeat from a `window.setInterval`, which stops running when the machine sleeps. A quiet, perfectly healthy wire therefore gets killed while the user is away from the keyboard. See [#incident-evidence](#incident-evidence) for the log timeline that shows exactly this, including a close at 08:35:19Z followed by a 4½-hour gap and an instant successful reconnect at 13:12:06Z when the page resumed.

Be precise about the suspension mechanism, because it determines what is worth fixing: a merely *occluded* WKWebView still runs its timers — background windows clamp DOM timers to ~1 s granularity rather than suspending them, so a 15 s heartbeat interval keeps firing. The multi-hour gaps in the logs are **system sleep**, not occlusion. Do not go hunting an occlusion bug; there isn't one.

The **wound** is what the deck does with that close. Three separate mechanisms compound: the reducer stamps a card-locking `lastError` on every non-idle card ([#teardown-cascade](#teardown-cascade)); the reconnect path destroys every card's services bag *before* attempting to restore, so any card whose restore fails or times out is left dumped at the picker with no automatic retry; and queued user messages are silently discarded. On top of that, the host app has no `webViewWebContentProcessDidTerminate` handler, so a WebContent jetsam produces the same user-visible symptom with genuinely zero recovery. This phase fixes the trigger where we control it, and makes the recovery path robust enough that the closes we *cannot* prevent — system sleep will always suspend the page — become a brief, self-healing blip instead of a lost afternoon.

#### Strategy {#strategy}

- **Separate trigger from wound, and fix the wound first.** We cannot prevent every close (sleep, jetsam, a genuinely dropped wire), so the recovery path is the load-bearing fix. Steps are ordered so that even if the heartbeat work were abandoned, the deck would still self-heal.
- **Transport loss is a transient, not a card error.** The `transportState` axis already exists ([D01] in [`dash/archive/tugplan-tide-connection-health.md`](archive/tugplan-tide-connection-health.md#d01-transport-state-separate)) and already drives a non-blocking "Reconnecting…" bulletin. Let that own the condition and stop minting a locking banner for it.
- **Restore retries until it succeeds.** The single highest-value change: a failed or timed-out reconnect restore currently drops the card to the picker forever. Bounded automatic retry converts "dumped" into "slow".
- **Loosen the server's liveness definition rather than just lengthening the timer.** Any inbound frame is proof of life; that alone removes the busy-session case, and a longer timeout covers the idle case.
- **Instrument every close with a cause.** We can name the trigger for the incidents in the logs, but not all of them. A structured close-cause record makes the next occurrence unambiguous rather than another investigation.
- **Prep the file so the next reader can grep it.** `tugdeck/src/connection.ts` is byte-for-byte invisible to `grep` ([#grep-blindness](#grep-blindness)); fix that before asking anyone to work in it.

#### Success Criteria (Measurable) {#success-criteria}

- A deck page suspended for ≥ 10 minutes and then resumed rebinds every card without any card reaching the picker (verify: leave the release app with ≥ 3 open session cards, lock the screen 10 min, unlock; every card shows its transcript and a live submit arrow).
- A transport close never produces the `error`-variant banner for `cause === "transport_closed"` (verify: `bun test` on the reducer + banner-spec suites asserting `deriveSessionCardBannerSpec` returns `{kind:"none"}` after a `transport_close`, and that `lastError` is not stamped with `transport_closed`).
- `tugcast` does not close a socket whose client sent *any* frame within the timeout window (verify: `cargo nextest run -p tugcast` covering the "inbound CONTROL frame refreshes liveness" case).
- A restore that is rejected or times out is retried automatically at least twice with backoff before the card falls to the picker, and a retry never double-spawns a session that bound late (verify: unit coverage of the retry scheduler + `restore.retry_scheduled` / `restore.retry_skipped_already_bound` lines in `tugcast.log`).
- Messages queued during a turn survive a transport close **and the rebind that follows it**, arriving in the rebuilt card (verify: the end-to-end app-test in [#step-9](#step-9) — a reducer-only assertion does not count, since the store that holds the queue is disposed moments later).
- A dead server is still detected within ~60 s while the page is active (verify: unit coverage of the probe-and-grace watchdog — threshold at 45 s plus a 10 s grace, not the 180 s server window).
- A killed WebContent process reloads the page automatically (verify: `kill` the `Tug.app` WebContent child from Activity Monitor; the window reloads and re-resumes rather than going blank).
- `grep` finds symbols in `tugdeck/src/connection.ts` at all (verify: `grep -c "intentionalClose" tugdeck/src/connection.ts` returns a non-zero count — today it returns nothing, because the file reads as binary. The exact count rises as later steps add references; only non-zero is meaningful).

#### Scope {#scope}

1. `tugcast` router heartbeat policy: refresh liveness on any inbound frame; raise the timeout.
2. `TugConnection` reconnect correctness: clear the `intentionalClose` latch on connect; probe before the watchdog condemns a wire; send a heartbeat immediately on page wake; record a structured close cause.
3. `CodeSessionStore` reducer: stop stamping a locking `lastError` for transport close; clear any stale transport error on recovery.
4. `session-restore.ts`: bounded automatic retry (re-query before re-spawn) for rejected and timed-out restores.
5. Queued sends survive both the transport close and the services-bag rebind that follows.
6. `MainWindow`: `webViewWebContentProcessDidTerminate` → reload.
7. Prep: restore `connection.ts` to a greppable text file.

#### Non-goals (Explicitly out of scope) {#non-goals}

- Removing the server-side heartbeat timeout entirely — deferred to [Q01](#q01-drop-server-timeout); this phase raises and loosens it.
- Making reconnect restore non-destructive (keeping the services bag alive across a reconnect instead of disposing and rebuilding). That would revisit [D04] of the connection-health plan and interacts with the `_reconcile` same-session short-circuit described in [#teardown-cascade](#teardown-cascade); deferred to [Q02](#q02-nondestructive-restore).
- Reconciling a synthetic `transport_lost` turn against the turn the backend actually completed during the outage. Moot while restore disposes and rebuilds the store; see [Q03](#q03-transport-lost-reconciliation).
- The tungstenite frame-budget hardening found during investigation (unbounded `max_write_buffer_size`, `Frame::encode` not enforcing `MAX_PAYLOAD_SIZE`) — real but a different failure mode (memory growth, not a clean close). Listed in [#roadmap](#roadmap).
- Any change to tugcode's per-session crash/respawn supervision, which was verified to be correctly isolated: a dying tugcode cannot close the deck socket.

#### Dependencies / Prerequisites {#dependencies}

- No new crates or packages. Every change lands in existing files.
- Rust workspace builds with `-D warnings` (`tugrust/.cargo/config.toml`) — warnings are errors.
- The app-test harness for driving transport events already exists: `test-surface.ts` exposes `transportClose` / `transportReconnect` ops routed to `CodeSessionStore._simulateTransportForTest`, used today by `tests/app-test/at0084-session-lifecycle-coordination.test.ts`.

#### Constraints {#constraints}

- **Heartbeat constants are a matched pair.** `HEARTBEAT_TIMEOUT` in `tugrust/crates/tugcast/src/router.rs` and `HEARTBEAT_TIMEOUT_MS` in `tugdeck/src/connection.ts` are documented as needing to move in lockstep, and `router.rs`'s `test_heartbeat_constants` asserts the Rust values literally. Changing one without the other and without the test is a build break.
- **tugdeck laws.** `useSyncExternalStore` is the only route for external state [L02]; appearance changes go through CSS/DOM, never React state [L06]. The reducer stays pure (state + effect list) — no I/O added to `handleTransportClose`.
- **No `localStorage`.** Retry counters and close-cause records are in-memory or go through tugbank; never browser storage.
- **Verify tugdeck with a real production build.** The debug app loads the rollup bundle, so `bunx vite build` must pass before a tugdeck change is called done — an import that works under dev esbuild can hang the app at the splash screen.
- **App-tests are selective.** Use `just app-test-changed`; every new test must carry `@covers`.

#### Assumptions {#assumptions}

- The backend keeps working through a deck disconnect. Verified in the logs: `tugcode` is unaffected by client teardown, and `AgentSupervisor::on_client_disconnect` only drops the client-affinity entry — sessions keep streaming into their ledgers. Therefore a turn in flight during an outage usually *completes*, and its result is recovered by the post-reconnect JSONL replay.
- A reconnect restore rebuilds each card's transcript from JSONL, so client-side synthetic state (including a `transport_lost` turn entry) is discarded rather than duplicated. Established in [#teardown-cascade](#teardown-cascade).
- ~~The observed incidents are heartbeat-timeout closes, not tugcast crashes. Every `tugcast` exit in the last week of logs is a clean parent-requested shutdown; there are no panics.~~ **CORRECTED 2026-08-03 — this assumption was false.** See [#crashes-are-a-second-cause](#crashes-are-a-second-cause). Heartbeat-timeout closes are real and this phase's trigger fix still applies to them, but they are not the only cause, and on recent evidence not even the more frequent one.

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

This plan follows the standard devise conventions: explicit `{#anchor}` headings, kebab-case anchors, plan-local decisions labelled `[P01]`…, open questions `[Q01]`…, risks `R01`…, and `**References:**` lines citing artifacts and anchors rather than line numbers. `[D##]` citations refer to the archived connection-health and code-session-store plans, named inline where used.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Should the server close on heartbeat timeout at all? (DEFERRED) {#q01-drop-server-timeout}

**Question:** A suspended page is not a dead wire. TCP-level close detection plus the client's own watchdog already cover a genuinely dead peer. Does the server-side heartbeat timeout earn its keep, or should tugcast simply never close on quiet?

**Why it matters:** If the answer is "never close", the trigger disappears entirely rather than being made rarer. If some timeout is genuinely needed (leaked client tasks accumulating per-connection state), removing it trades one leak for another.

**Options (if known):**
- Keep a timeout, raise it, and refresh on any inbound frame (this phase's choice, [P03](#p03-liveness-any-frame)).
- Remove the timeout; rely on transport-level close and an idle-connection reaper keyed on something other than heartbeat.
- Keep 45 s but have the Swift host suppress the deck's suspension (a background-safe timer that pumps the heartbeat).

**Plan to resolve:** Ship [P03](#p03-liveness-any-frame), then watch `tugcast.log` for `Heartbeat timeout, closing connection` over a few weeks. If the count reaches zero, the timeout is harmless and the question closes; if closes persist on genuinely idle-but-alive pages, revisit removal.

**The counting method is confounded — do not read a zero as an answer.** ([#crashes-are-a-second-cause](#crashes-are-a-second-cause), added 2026-08-03.) `tugcast` is currently dying of `SIGBUS` several times a day, and a process that has crashed cannot emit the line being counted. A drop to zero could therefore mean the timeout stopped firing *or* that crashes are ending the connections first. Before treating the count as evidence, subtract the crash-restarts: a `tugcast starting` with no preceding shutdown marker, cross-checked against `~/Library/Logs/DiagnosticReports/tugcast-<ts>.ips` (mind the local-vs-UTC skew noted there). Cleanest is to resolve this only once the crash is fixed and the window is crash-free.

**Resolution:** DEFERRED — revisit after this phase ships *and* after the crash in [`dash/app-stability-brief.md`](app-stability-brief.md) is closed, using the close-cause telemetry from [P07](#p07-close-cause-record), which distinguishes a watchdog-forced close from a server-initiated one on the client side.

#### [Q02] Should reconnect restore stop being destructive-first? (DEFERRED) {#q02-nondestructive-restore}

**Question:** `cardSessionBindingStore.clearAll()` runs *before* any restore is attempted, disposing every card's services bag. Should the reconnect path instead re-bind in place and clear only bindings the server explicitly disowns?

**Why it matters:** Destructive-first is the mechanism that turns a partial restore failure into "all sessions dumped". Non-destructive restore would make a failed card the exception rather than the loss of everything. But it collides with `CardServicesStore._reconcile`, which short-circuits (`continue`) when a card's `tugSessionId` is unchanged — so re-binding the same session in place would *not* rebuild the store and *not* re-issue `request_replay`, leaving a stale transcript wired to a dead subscription. Fixing that means a new "rebind" signal distinct from "session changed".

**This is a standing [L23] violation, not a preference.** "Internal implementation operations must never lose, destroy, or cease to apply user-visible state" — and `clearAll()` disposing every card's transcript *before* any restore has been attempted is an internal implementation operation destroying user-visible state, by the plainest possible reading. [L23] offers two sanctioned mechanisms and this path uses neither: it is not minimal mutation (the stores come down), and it is not the [A9] capture-and-restore protocol (nothing is captured — the transcript is re-fetched from the server and simply lost if that fetch fails). The deferral below is a judgment about *sequencing*, not about whether the current design is lawful. It is not.

**Options (if known):**
- Keep clear-then-restore, add bounded retry (this phase's choice, [P04](#p04-restore-retry)).
- Add a `rebindGeneration` counter to the binding so `_reconcile` rebuilds on reconnect without a session change.
- Defer disposal until a card's restore has actually failed.

**Plan to resolve:** Ship the retry first and measure how often the retry is even needed. If retries are common, the destructive-first design is worth reworking; if they are rare, it is not. Either way the [L23] violation stands and needs its own phase — the measurement decides urgency, not whether.

**Resolution:** DEFERRED **with a deadline** — the retry in [P04](#p04-restore-retry) and the stash in [P08](#p08-preserve-queued-sends) are a safety net around the violation, not a repair of it. This phase makes the harm survivable; the next one should make it impossible. Do not let the net become the answer.

#### [Q03] Should a `transport_lost` turn be reconciled against the backend's real outcome? (DEFERRED) {#q03-transport-lost-reconciliation}

**Question:** The reducer commits a synthetic `transport_lost` turn entry when the wire drops mid-turn, but the backend usually finishes the turn. Should that entry be reconciled (suppressed or replaced) once replay delivers the real result?

**Why it matters:** A user who sees a "Lost" badge on work that actually completed distrusts the transcript.

**Plan to resolve:** Moot today, because the reconnect path disposes the store and rebuilds the transcript from JSONL — the synthetic entry never survives to be compared. It becomes live the moment [Q02](#q02-nondestructive-restore) is answered "non-destructive".

**Resolution:** DEFERRED — blocked on [Q02](#q02-nondestructive-restore).

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Longer server timeout leaks dead client connections | low | med | Liveness refreshes on any frame, so a truly dead peer still trips it; TCP close still tears down immediately | Growth in concurrent `client_id` values in the log |
| Client watchdog tears down a wire the server would have kept | med | high without the fix | Probe-and-grace ([P09](#p09-probe-and-grace)) proves the wire before closing; client threshold deliberately not raised | A close-cause record showing a failed probe on a server that was alive |
| Retry double-spawns a session that bound late | med | high without the fix | Re-query `list_card_bindings` before re-firing; timeout raised to 20 s to clear the boot cost | `restore.retry_skipped_already_bound` appearing frequently (means the timeout is still too tight) |
| Removing the transport error banner hides a genuine unreachable-agent state | med | low | The "Reconnecting…" bulletin plus the app-level disconnect banner both stay; `canSubmit` still gates the composer | User reports of a silently dead card |
| Retry loop hammers a server that is rejecting for a good reason | med | low | Bounded attempts with backoff; a rejection with a known gate token (`session_live_in_terminal`) is terminal and skips retry | `restore.retry_exhausted` appearing routinely |
| Heartbeat constant drift between Rust and TS | low | med | Both changed in the same step, with the Rust constant test updated in that step | `test_heartbeat_constants` failing |

**Risk R01: The banner change masks a real breakage class** {#r01-banner-masking}

- **Risk:** `transport_closed` is not the only cause routed through `lastError`; a change to the banner-spec that is too broad would also suppress `session_state_errored` and other genuine breakage.
- **Mitigation:**
  - Scope the change to `cause === "transport_closed"` only, at the reducer (do not stamp) rather than at the banner (do not render), so every other cause is untouched by construction.
  - Keep an explicit banner-spec test asserting that a `session_state_errored` cause still banners.
- **Residual risk:** A future cause that is also transient will need the same treatment; nothing here generalizes it.

**Risk R02: WebContent reload loses unsent composer text** {#r02-reload-loses-draft}

- **Risk:** Auto-reloading on WebContent termination discards whatever was typed but unsent, without the user asking for a reload.
- **Mitigation:**
  - The process is already dead when the handler runs — the text is gone regardless; the reload only restores a usable window.
  - Log the termination so the event is attributable rather than mysterious.
- **Residual risk:** Unavoidable in this failure mode; the real mitigation is the memory work tracked separately in `dash/transcript-dom-eviction.md`.

**Risk R03: Retry masks a persistent server-side rejection** {#r03-retry-masks-rejection}

- **Risk:** Automatic retry could turn a fast, legible "this session is open in a terminal" into three slow attempts and then the same message.
- **Mitigation:** Classify rejections — known terminal gate tokens (`session_live_in_terminal`, `session_live_elsewhere`) go straight to the picker without retry; only timeouts and unclassified errors retry.
- **Residual risk:** An unclassified-but-permanent backend error costs the full retry budget before surfacing.

---

### Design Decisions {#design-decisions}

#### [P01] Transport loss never mints a card-locking error (DECIDED) {#p01-transport-not-an-error}

**Decision:** `handleTransportClose` in `tugdeck/src/lib/code-session-store/reducer.ts` stops setting `lastError = {cause: "transport_closed", …}`. The `transportState = "offline"` transition, the phase transition for non-idle cards, and the synthetic `transport_lost` turn entry all stay exactly as they are.

**Rationale:**
- The banner is documented as reserved for genuine breakage and is the one surface allowed to lock the card (it sets `inert` on the pane body). A wire blip that self-heals in seconds does not qualify — the module docstring of `session-card-banner-spec.ts` says as much, listing "transport blips" among the transients that were deliberately moved to non-blocking bulletins. The `lastError` stamp is the last piece that never got moved.
- The condition is already fully represented without it: `projectNotices` in `transient-notice.ts` raises a "Reconnecting… / Lost the connection to the agent. Trying to reconnect." bulletin whenever `transportState === "offline"`, and `tug-banner-bridge.tsx` shows an app-level "Disconnected — reconnecting in Ns…" strip.
- Submit is already gated correctly and independently: `canSubmit` is `(phase === "idle" || phase === "errored") && transportState === "online"` (see [`tuglaws/turn-lifecycle.md`](../tuglaws/turn-lifecycle.md)). Removing `lastError` does not open the composer during an outage.
- Nothing on the recovery path clears `lastError` — not `transport_open`, not `transport_settled`, not `replay_complete`. Only a new successful turn or a Dismiss click does. So the stamp is not merely noisy, it is *sticky* in exactly the case where the wire never returns.

**Implications:**
- `deriveSessionCardBannerSpec` needs no change — with no `lastError` stamped, it returns `{kind: "none"}` on its own.
- `deriveColdRestoreActive` in `session-card-restore-gate.ts` returns `false` whenever `lastError !== null`, deliberately mounting the body so an error shows. Clearing the stamp lets the cold-restore placeholder work during a reconnect instead of being suppressed.
- Existing assertions in `code-session-store.errored.test.ts` and `code-session-store.transport-state.test.ts` that expect the `transport_closed` cause must be inverted.

#### [P02] Recovery clears a stale transport error (DECIDED) {#p02-recovery-clears-error}

**Decision:** `handleTransportOpen` and `handleTransportSettled` clear `lastError` when and only when its `cause === "transport_closed"`.

**Rationale:**
- Belt-and-braces for [P01](#p01-transport-not-an-error): any `transport_closed` error that predates this change (or arrives from a path not covered by the reducer edit) must not outlive the recovery that disproves it.
- It states the invariant positively — "a recovered transport has no transport error" — where a reader will look for it, rather than relying on the absence of a stamp elsewhere.

**Implications:**
- The clear is conditional on cause; a `session_state_errored` that happened to coincide with an outage survives the reconnect, which is correct.

#### [P03] Liveness is any inbound frame, and the timeout is raised (DECIDED) {#p03-liveness-any-frame}

**Decision:** In `tugrust/crates/tugcast/src/router.rs`, `last_heartbeat` is refreshed on **every** successfully decoded inbound frame, not only `FeedId::HEARTBEAT`; and `HEARTBEAT_TIMEOUT` is raised from 45 s to 180 s, with `HEARTBEAT_INTERVAL` left at 15 s.

**Rationale:**
- The current rule is indefensible on its face: a client actively sending CONTROL and CODE_INPUT frames is provably alive, yet gets closed because one specific frame type stopped arriving. Refreshing on any frame removes the entire busy-session class of closes.
- Raising the timeout covers the genuinely-idle-but-alive class — a backgrounded WKWebView whose timers are throttled. 180 s is twelve missed heartbeats: still unambiguous evidence of a dead wire, but wide enough to absorb throttling and a long main-thread stall.
- The check only runs on the 15 s interval tick, so the effective window is already coarse (45–60 s today, 180–195 s after). Naming that in the constant's doc comment prevents the next reader from believing the timer is precise.

**Implications:**
- `test_heartbeat_constants` in `router.rs` asserts both durations literally and must be updated in the same commit.
- The client's `HEARTBEAT_TIMEOUT_MS` **does not move with it** — see [P09](#p09-probe-and-grace), which corrects a mirroring assumption baked into that constant's doc comment.

#### [P09] The two heartbeat thresholds are independent; the client probes before closing (DECIDED) {#p09-probe-and-grace}

**Decision:** `HEARTBEAT_TIMEOUT_MS` in `tugdeck/src/connection.ts` stays at 45 s. The client watchdog stops force-closing the socket the instant the threshold is crossed; instead it sends a heartbeat and opens a grace window (`WATCHDOG_GRACE_MS`, 10 s). If any inbound frame arrives during the grace window the wire is declared healthy and the watchdog re-arms; if nothing arrives, it force-closes as before.

**Rationale:**
- **The two constants govern opposite directions and were never actually coupled.** The server's `HEARTBEAT_TIMEOUT` measures *client→server* silence; the client's `HEARTBEAT_TIMEOUT_MS` measures *server→client* silence, and its own doc comment derives it from the server's 15 s emit cadence ("45 s = three missed heartbeats"). The "must change in lockstep" line records a coincidence of numbers, not a dependency. Raising the client's threshold alongside the server's would triple the time the deck takes to notice a genuinely dead server while the page is active — the tugcast-restart case — in exchange for nothing.
- **But leaving the client at a bare 45 s force-close is also wrong once the server tolerates 180 s.** A 60-second sleep now wakes into a client that immediately tears down a wire the server still considers perfectly alive. With clear-then-restore ([#teardown-cascade](#teardown-cascade)), that self-inflicted close costs a full dispose-and-restore of every card — the deck would be manufacturing the exact incident this plan exists to prevent.
- Probing before closing resolves both: fast detection of a truly dead server (45 s + 10 s), and no teardown of a wire that is merely quiet. It also subsumes [P05](#p05-wake-heartbeat) — the wake pulse becomes one case of a single rule ("prove the wire before condemning it") rather than a second, separate mechanism.

**Implications:**
- Correct the `HEARTBEAT_TIMEOUT_MS` doc comment: it must no longer instruct the reader to move it with the server constant. State the direction each threshold measures.
- The watchdog needs one bit of state (grace window open, and the `lastFrameAt` value at which it opened) so it can tell "a frame arrived during grace" from "the tick just came round again".
- A wire killed after a failed grace probe is genuinely dead, which makes the close-cause record from [P07](#p07-close-cause-record) unambiguous for this path.

#### [P04] A failed reconnect restore re-queries before it re-spawns (DECIDED) {#p04-restore-retry}

**Decision:** In `tugdeck/src/lib/session-restore.ts`, a restore that times out (`RESTORE_TIMEOUT_MS`) or is rejected with an unclassified `SESSION_STATE errored` detail is retried automatically with bounded backoff — 3 attempts at roughly 2 s / 6 s / 15 s — before the card falls through to the picker notice. **Each retry begins by re-issuing `list_card_bindings` and re-firing `spawn_session` only for cards the fresh listing shows as genuinely unbound.** Rejections carrying a known terminal gate token (`session_live_in_terminal`, `session_live_elsewhere`) skip retry and go straight to the picker as they do today. `RESTORE_TIMEOUT_MS` is raised from 10 s to 20 s.

**Rationale:**
- This is the change that answers the user's actual complaint. Today the timeout backstop in `fireRestore` / `fireFreshSpawn` just clears the registry hold and lets the card fall to the picker, with the comment "the next reload retries" — i.e. the recovery plan is *the user restarts the app*. That is exactly the thing that makes walking away unsafe.
- A reconnect restore can fail for reasons that are transient by nature: tugcast is still rebinding its ledger, the tugcode subprocess is still booting, or the timeout simply lost a race. All of those succeed on a second attempt.
- **Re-query before re-spawn, because the timeout is not proof of failure.** A resume-mode spawn faces a documented 5–10 s tugcode boot against a 10 s timeout, so the timeout fires while the first spawn is *legitimately still in flight* more often than not. Blindly re-sending `spawn_session` would race a spawn that is about to succeed, and nothing in the supervisor's contract has been established to make a second concurrent spawn for the same session safe. `list_card_bindings` is authoritative about what actually landed server-side; asking it first turns a guess into a fact and makes the common case ("it worked, we were just impatient") cost one CONTROL round-trip instead of a duplicate spawn.
- Raising the first-attempt timeout to 20 s removes most of that race outright — 10 s never left margin above the boot cost it was meant to tolerate.
- Reaching into a live spawn to re-drive it would be the source→delegate inversion [L28] forbids. Subscribing to the authoritative listing and responding to what it publishes is the direction the law requires.
- Backoff bounded at 3 attempts keeps a genuinely broken session from looping forever and preserves the picker as the honest terminal state.

**Implications:**
- The retry scheduler needs a per-card attempt counter cleared on success — a module-scope `Map<string, number>` alongside the existing `restoreStartedAt` map, not React state and not `localStorage`.
- The retry path reuses the existing `list_card_bindings` request and its `subscribeToListCardBindingsOk` handler rather than adding a second listing mechanism.
- Each attempt emits a `restore.retry_scheduled` / `restore.retry_skipped_already_bound` / `restore.retry_exhausted` line through `logSessionLifecycle`, so the log distinguishes "retried" from "turned out to be fine".
- The picker's existing manual Retry button remains the escape hatch after exhaustion.
- Note for the implementer: `RESTORE_TIMEOUT_MS`'s doc comment claims the picker presents a `restore_timed_out` notice on timeout. It does not — the `fireFreshSpawn` timeout handler only clears the hold and logs. Fix the comment while you are in there; do not trust it.

#### [P05] The client sends a heartbeat immediately on wake (DECIDED) {#p05-wake-heartbeat}

**Decision:** `TugConnection` sends a heartbeat frame immediately when the page becomes visible again (`visibilitychange` → visible), in addition to the 15 s interval.

**Rationale:**
- On resume from suspension, the interval timer has been frozen; the next scheduled heartbeat may be up to a full interval away, and the server's clock has been running the whole time. Sending one at wake is the cheapest possible way to prove liveness at the exact moment the server is closest to giving up.
- It costs one empty frame per wake.

**Implications:**
- The client watchdog will still usually fire on wake, because `Date.now() - lastFrameAt` legitimately exceeds the threshold after a long suspension. That force-close is *correct* — the wire really is stale — and routes into the normal reconnect path. The wake heartbeat helps the case where the suspension was shorter than the watchdog threshold but longer than the server's tolerance.

#### [P06] `intentionalClose` is cleared on connect (DECIDED) {#p06-intentional-close-latch}

**Decision:** `TugConnection.connect()` sets `this.intentionalClose = false` at entry.

**Rationale:**
- `close()` sets the latch to `true` and nothing ever resets it. Any subsequent close after one explicit `close()` returns early from `onclose` and never schedules a reconnect — a permanently dead transport with no banner and no retry.
- No production caller hits it today, which is why this has not bitten yet; `forceReconnect` is the only imperative path in use. It is a latent version of the exact bug this plan exists to fix, and the fix is one line.

**Implications:**
- The flag becomes per-close-intent rather than per-instance, which is what its name always implied.

#### [P07] Every close records a structured cause (DECIDED) {#p07-close-cause-record}

**Decision:** `TugConnection.onclose` records a structured close record — code, reason, whether the watchdog fired, ms since the last inbound frame, and document visibility state — and logs it through `tugDevLogStore` so it is readable in the in-app dev panel and from `window.tugDevLog.getSnapshot()`.

**Rationale:**
- This investigation could name the trigger only because `tugcast` happened to log `Heartbeat timeout, closing connection`. The client side logs `console.log("tugdeck: WebSocket closed", code, reason)` and nothing about *why* — no visibility state, no staleness measurement. The next incident with a different cause would start from zero again.
- `tugDevLogStore` is the established runtime-state logging surface (never `console.warn`), and its snapshot is readable both from app-tests and from the running debug app.
- The staleness figure is the single most diagnostic number available: it distinguishes "the page was suspended" from "the server hung up on a live page" without any further instrumentation.

**Implications:**
- Feeds [Q01](#q01-drop-server-timeout)'s resolution with real data.
- No new store; `tugDevLogStore` already exists.

#### [P08] Queued sends survive a transport close *and the rebind that follows it* (DECIDED) {#p08-preserve-queued-sends}

**Decision:** Two changes, and both are required for either to matter. (a) `handleTransportClose` stops resetting `queuedSends: []` when it commits a `transport_lost` turn. (b) Queued sends are stashed **outside the services bag** — a module-scope `Map<cardId, QueuedSend[]>` in `session-restore.ts` — written when a transport close strands them and drained by `CardServicesStore._construct` into the freshly built store, then cleared.

**Rationale:**
- A queued send is a message the user typed and asked to deliver. Discarding it on a wire blip is silent data loss with no notification at all — worse than the banner, because nothing marks it. This is squarely [L23]: an internal implementation operation destroying user-visible state.
- **(a) alone is a no-op for users, and would ship a green test over a live bug.** The reconnect path disposes the store that holds the preserved queue milliseconds later ([#teardown-cascade](#teardown-cascade)), so a reducer test asserting `queuedSends.length === 2` would pass while the user's messages die with the bag. A success criterion that is measurable but not meaningful is worse than no criterion, because it retires the concern.
- Stashing outside the bag is the smallest thing that survives a rebind. `_construct` is already the seam where a fresh store is wired to a binding, and it already performs post-construction work there (the `request_replay` dispatch, `notifyResumeBindingLanded`).
- Everything else in the per-turn reset (`scratch`, `toolUseStartedAt`, `pendingApproval`, `pendingQuestion`, `pendingTurn`) genuinely belongs to the dead turn and is correctly cleared. `queuedSends` is the one member of that group that belongs to the *user*, not the turn.

**Implications:**
- The stash is keyed by `cardId`, not `tugSessionId`: the user queued the message *at a card*, and a card that resumes into a different session should still carry it.
- The stash must be cleared on drain and on explicit card close, so a queued message cannot resurface days later on an unrelated session. Bound its age — drop entries older than the app session.
- Re-seeded sends land in a card whose phase is `idle` after replay completes; the existing queue-flush path picks up the head from there. Verify the flush fires without a preceding `turn_complete`, since on this path there is no prior turn to complete.
- This is the one place the plan touches state that crosses the dispose boundary, which is exactly why it needs the [L23] framing rather than being filed as a nicety.

---

### Deep Dives {#deep-dives}

#### Incident evidence from the logs {#incident-evidence}

Logs live at `~/Library/Application Support/Tug/instances/release-main/Logs/tugcast.log.<YYYY-MM-DD>` (per-instance) and `~/Library/Application Support/Tug/Logs/…` (no instance id). Timestamps are UTC. `tugcode` has no log of its own — its stderr is forwarded into the tugcast log under the `tugcast::tugcode_stderr` target.

The 2026-08-02 instance log contains one clean incident:

| Time (UTC) | Event |
|---|---|
| 08:35:19 | `WARN tugcast::router: Heartbeat timeout, closing connection client_id=2` |
| 08:35 → 13:12 | no client events — the page's JS (including its reconnect timer) was suspended |
| 13:12:06 | `WebSocket upgrade accepted` / `Client connected client_id=3` / `Protocol handshake complete (v1)`, then `spawn.supervisor_recv` + `request_replay.dispatched` for every card — a complete, successful restore inside one second of the page waking |
| 13:15:57 | `tugcast starting session=cc-release-main` — a full app relaunch, three minutes later |

The last row is the tell: the automatic recovery at 13:12:06 *worked*, and the app was restarted by hand anyway three minutes later. That is the signature of a recovery the UI did not communicate.

The same `Heartbeat timeout, closing connection` line appears once each in the 2026-07-31 and 2026-08-01 instance logs — matching the reported "couple times a day" cadence. Cross-checks that came back clean:

- ~~**No tugcast crashes.** Every `tugcast` exit in the week's logs is preceded by `Control socket: shutdown requested by parent` and `shutdown requested with exit code 0`. No `panicked at`.~~ **WRONG — see [#crashes-are-a-second-cause](#crashes-are-a-second-cause) below.**
- **No tugcode-induced socket loss.** `tugcode` deaths are handled per-session by `run_session_bridge` (respawn with a crash budget); `AgentSupervisor::on_client_disconnect` only drops the client-affinity entry, so sessions survive a client disconnect entirely.
- **Client disconnect/reconnect pairs are routine and mostly benign** — the 2026-07-30 log shows a dozen disconnect → reconnect-2.3s-later pairs, each recovering.

#### tugcast crashes are a second, independent cause {#crashes-are-a-second-cause}

**Added 2026-08-03, correcting this plan's original reading of the logs.**

`tugcast` has been dying of `SIGBUS` (`EXC_BAD_ACCESS`, `FS pagein error: 22`) inside SQLite's memory-mapped WAL-index. Full analysis in [`dash/app-stability-brief.md`](app-stability-brief.md). A crashing `tugcast` drops the WebSocket, which produces *exactly* the symptom this plan was written about — every card losing its session at once.

**Why the original cross-check missed it, which is the part worth remembering.** It grepped for `panicked at` and for the absence of a clean-shutdown marker. A `SIGBUS` is not a panic and writes **no log line at all** — it leaves a *silent gap* in `tugcast.log.<date>`: a `tugcast starting` with no `SIGTERM received` / `shutdown requested` before it. Searching for evidence of a crash found nothing because a crash of this kind leaves no evidence in that file. The evidence lives in `~/Library/Logs/DiagnosticReports/tugcast-<ts>.ips`, which the original check never looked at.

Re-measured on `release-main` over 2026-07-29 → 08-03:

| Cause | Count |
|---|---|
| Crash-restarts (silent gap, no shutdown marker) | 9 |
| `Heartbeat timeout, closing connection` | 5 |

`.ips` crash reports exist on every day of that window (7 · 5 · 5 · 1 · 6 across all instances). Both mechanisms are real and of the same order; the heartbeat-timeout line is written *by* `tugcast`, so the process was alive when it fired — that close is genuinely distinct from a crash, not a crash in disguise.

**Gotcha for whoever measures this next:** `.ips` filenames are stamped in **local** time while `tugcast.log.<date>` buckets by **UTC**. A crash at 18:58 PDT lands in the next day's log file. Correlating the two without accounting for that will appear to show crashes with no matching restart.

**What this does and does not change for this phase.** Only [P03](#p03-liveness-any-frame) is heartbeat-specific. Every other decision here is cause-agnostic recovery — a crash-close runs the same `connectionDidClose` → `clearAll()` → restore cascade as a timeout-close, so [P01](#p01-transport-not-an-error), [P04](#p04-restore-retry), and [P08](#p08-preserve-queued-sends) apply to it unchanged. [P04](#p04-restore-retry) is arguably worth *more* under crashes: a `tugcast` restart has the supervisor rebinding its ledger while the deck is restoring, which is the transient race the retry exists to absorb.

One trade to hold consciously: [P01](#p01-transport-not-an-error) removes the red banner from a condition that, when its cause is a crash, is **not** self-healing in the way the decision's rationale assumes. The non-blocking surfaces all remain (the bulletin, the app-level strip, the `canSubmit` clamp, and the new close-cause record from [P07](#p07-close-cause-record)), so the condition is quieter rather than invisible — but until the crash is fixed, the alarm on it is deliberately dialled down.

#### The close taxonomy {#close-taxonomy}

Everything that can end the single deck WebSocket, since all sessions are multiplexed over it and any one of these drops all of them at once:

| Origin | Mechanism | Addressed here |
|---|---|---|
| Server heartbeat timeout | `router.rs` heartbeat tick arm → `teardown_client` | Yes — [P03](#p03-liveness-any-frame) |
| Client watchdog | `TugConnection.startWatchdog` force-closes when `Date.now() - lastFrameAt > HEARTBEAT_TIMEOUT_MS` | Partly — [P05](#p05-wake-heartbeat), and it stays as the correct stale-wire detector |
| Handshake rejection | `perform_handshake` sends `CLOSE_BAD_HANDSHAKE` / `CLOSE_VERSION_MISMATCH` / `CLOSE_HANDSHAKE_TIMEOUT`; the client `ws.close()`s on protocol or version mismatch | No — retries forever, correctly, though opaquely |
| Send failure | Any `socket.send()` error on a snapshot, stream frame, or lag replay | No |
| WebSocket protocol/IO error | inbound `Some(Err(e))` — includes an oversized inbound message against tungstenite's unconfigured 64 MiB default | No — see [#roadmap](#roadmap) |
| tugcast process exit | parent-death watchdog (polls `getppid()` every 2 s), duplicate-launch reclaim, CONTROL `relaunch`, SIGTERM from the host | No — the deck's unlimited backoff retry is the right answer |
| WebContent process death | jetsam / crash; no delegate handler exists | Yes — [#step-8](#step-8) |
| `intentionalClose` latch | `close()` sets it, `connect()` never clears it | Yes — [P06](#p06-intentional-close-latch) |

#### The teardown cascade: why "all sessions" {#teardown-cascade}

The reason a blip presents as *every* card dying, rather than one, is a chain of three per-card fan-outs:

1. **One socket, every session.** All sessions multiplex over the single `/ws` connection, so one close is a close for all of them.
2. **One close event, every store.** Each card's `CodeSessionStore` subscribes to `ConnectionLifecycle` at construction and translates `connectionDidClose` into its own `transport_close` dispatch. Every non-idle card therefore flips to `phase: "errored"` and (today) stamps `lastError` in the same tick.
3. **One reconnect, every services bag disposed.** On `connectionDidReconnect`, `main.tsx` calls `cardSessionBindingStore.clearAll()` and *then* `restoreSessions(deck, connection, {reason: "reconnect"})`. `clearAll` empties the binding map, which drives `CardServicesStore._reconcile` down its "dispose for vanished bindings" branch for **every** card — `codeSessionStore.dispose()`, `responseStore.dispose()`, and the rest of the bag. Transcripts included.

Step 3 is the destructive one, and it is unconditional and up-front. Restore then re-binds card by card: `list_card_bindings`, then per row either `fireRestore` (`spawn_session(mode=resume)`) when `has_jsonl || turn_count > 0 || is_alive`, or `fireFreshSpawn`. A card that gets neither a binding nor a rejection within `RESTORE_TIMEOUT_MS` (10 s) hits the timeout backstop, which clears the registry hold and lets the card fall to the picker — with no retry, on the stated assumption that "the next reload retries".

Two consequences follow, and they explain both shapes of the reported symptom:

- **When the wire returns:** every transcript vanishes at once (disposal), then reappears card by card as restores land. Any card whose restore is slow or rejected is left dumped at the picker permanently. This is "dumps all sessions".
- **When the wire does not return:** `clearAll` never runs, so the services survive — carrying the sticky `lastError` and its `inert` red banner on every card, indefinitely. This is "makes no attempt to reconnect", from the user's side of the glass: the connection layer *is* retrying (unlimited attempts, 2 s doubling to a 30 s cap), but every card looks terminally broken while it does.

Also worth knowing before editing the reducer: a fresh `CodeSessionStore` is constructed per binding, and `_reconcile` short-circuits (`continue`) when a card's `tugSessionId` is unchanged — the session-change branch is what forces a rebuild. This is precisely why `clearAll` exists, and precisely what makes [Q02](#q02-nondestructive-restore) non-trivial.

#### `connection.ts` is invisible to grep {#grep-blindness}

`tugdeck/src/connection.ts` contains one literal NUL byte, used as a composite map-key separator inside a template literal (roughly `` `${sessionKey}\0${type}` ``, written as a raw byte rather than an escape). It is committed — `git show HEAD:tugdeck/src/connection.ts` has it too.

The consequence is that `file` reports the file as `data`, and `grep` treats it as binary and **silently reports no matches**. `grep -n "intentionalClose" tugdeck/src/connection.ts` returns nothing; so does a repo-wide `grep -rl "new WebSocket"`. Reading the file with `Read`/`sed` works fine, which makes the failure especially deceptive: the symbol is right there, and every search says it does not exist.

The fix is to write the separator as the escape `\u0000` inside the template literal, which produces a byte-identical runtime string while making the source file plain text. This is [#step-1](#step-1) because every later step in this plan asks someone to search this file.

---

### Specification {#specification}

#### State Zone Mapping {#state-zone-mapping}

| State | Zone | Mechanism | Law |
|-------|------|-----------|-----|
| `lastError` (transport cause removed) | local-data | existing `CodeSessionStore` reducer field, read via `useSyncExternalStore` | [L02] |
| `queuedSends` preserved across close | local-data | existing reducer field; no new surface | [L02] |
| queued-send stash (per card, survives dispose) | local-data | module-scope `Map<string, QueuedSend[]>` in `session-restore.ts`; drained by `_construct`. Deliberately outside the services bag — that is the whole point ([L23]) | [L02], [L23] |
| restore attempt counter (per card) | local-data | module-scope `Map<string, number>` in `session-restore.ts`, alongside the existing `restoreStartedAt` map | [L02] |
| watchdog grace window | local-data (transport-internal) | two fields on `TugConnection`; never rendered, never crosses into React | [L02] |
| close-cause record | local-data (diagnostic) | `tugDevLogStore` entry; never `console.warn`, never `localStorage` | [L02] |
| "Reconnecting…" bulletin | structure | already derived by `projectNotices` from `transportState`; unchanged | [L02] |
| card `inert` lock | appearance | already a DOM attribute driven by the banner spec; removing the stamp removes the lock with no new mechanism | [L06] |

No new React state, no new store, and no new subscription are introduced by this plan.

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tests/app-test/atXXXX-transport-reconnect-recovery.test.ts` | End-to-end: drive a transport close + reconnect on a real card, assert no error banner and a live submit arrow. Number assigned at authoring time from the next free `at####`; must carry `@covers`. |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `handleTransportClose` | fn | `tugdeck/src/lib/code-session-store/reducer.ts` | Drop the `lastError` stamp ([P01](#p01-transport-not-an-error)); stop resetting `queuedSends` ([P08](#p08-preserve-queued-sends)) |
| `handleTransportOpen` | fn | `tugdeck/src/lib/code-session-store/reducer.ts` | Clear a `transport_closed` `lastError` ([P02](#p02-recovery-clears-error)) |
| `handleTransportSettled` | fn | `tugdeck/src/lib/code-session-store/reducer.ts` | Same clear, on the settle edge ([P02](#p02-recovery-clears-error)) |
| `connect` | method | `tugdeck/src/connection.ts` | Clear `intentionalClose` at entry ([P06](#p06-intentional-close-latch)) |
| `startHeartbeat` / new visibility handler | method | `tugdeck/src/connection.ts` | Send a heartbeat on `visibilitychange` → visible ([P05](#p05-wake-heartbeat)) |
| `startWatchdog` | method | `tugdeck/src/connection.ts` | Probe-and-grace instead of immediate force-close ([P09](#p09-probe-and-grace)) |
| `WATCHDOG_GRACE_MS` | const (new) | `tugdeck/src/connection.ts` | 10 000 — grace window after a probe ([P09](#p09-probe-and-grace)) |
| `_forceCloseForTest` | method (new) | `tugdeck/src/connection.ts` | Real `ws.close()` without the `intentionalClose` latch, so app-tests can drive the full lifecycle ([#step-9](#step-9)) |
| `connectionClose` | test-surface op (new) | `tugdeck/src/test-surface.ts` | Exposes `_forceCloseForTest` to the harness ([#step-9](#step-9)) |
| `onclose` handler | closure | `tugdeck/src/connection.ts` | Emit the structured close-cause record ([P07](#p07-close-cause-record)) |
| `HEARTBEAT_TIMEOUT_MS` | const | `tugdeck/src/connection.ts` | **Unchanged at 45 000**; doc comment corrected — it does *not* mirror the server ([P09](#p09-probe-and-grace)) |
| `HEARTBEAT_TIMEOUT` | const | `tugrust/crates/tugcast/src/router.rs` | 45 s → 180 s ([P03](#p03-liveness-any-frame)) |
| inbound-frame arm of `handle_client` | match arm | `tugrust/crates/tugcast/src/router.rs` | Refresh `last_heartbeat` for every decoded frame, not just `FeedId::HEARTBEAT` ([P03](#p03-liveness-any-frame)) |
| `test_heartbeat_constants` | test | `tugrust/crates/tugcast/src/router.rs` | Update both asserted durations |
| `fireRestore`, `fireFreshSpawn` | fn | `tugdeck/src/lib/session-restore.ts` | Route timeout through the retry scheduler ([P04](#p04-restore-retry)) |
| `installRegistrySubscriptions` | fn | `tugdeck/src/lib/session-restore.ts` | Classify `SESSION_STATE errored` details: terminal gate tokens → picker, others → retry ([P04](#p04-restore-retry)) |
| `scheduleRestoreRetry` | fn (new) | `tugdeck/src/lib/session-restore.ts` | Bounded backoff scheduler; re-queries `list_card_bindings` before re-spawning ([P04](#p04-restore-retry)) |
| `RESTORE_TIMEOUT_MS` | const | `tugdeck/src/lib/session-restore.ts` | 10 s → 20 s; doc comment corrected (it claims a picker notice the code never sets) |
| queued-send stash | `Map<string, QueuedSend[]>` (new) | `tugdeck/src/lib/session-restore.ts` | Per-card, survives the services-bag dispose ([P08](#p08-preserve-queued-sends)) |
| `_construct`, `_dispose` | method | `tugdeck/src/lib/card-services-store.ts` | Drain the stash into a fresh store; capture into it before disposing ([P08](#p08-preserve-queued-sends)) |
| `webViewWebContentProcessDidTerminate(_:)` | method (new) | `tugapp/Sources/MainWindow.swift` | `WKNavigationDelegate` conformance already declared; reload and log |

---

### Documentation Plan {#documentation-plan}

- [ ] Update [`tuglaws/turn-lifecycle.md`](../tuglaws/turn-lifecycle.md) to state that transport loss is a `transportState` condition with a bulletin, never a `lastError` banner.
- [ ] Note the any-frame liveness rule and the 180 s window in the `HEARTBEAT_TIMEOUT` doc comment in `router.rs`, including that the check only runs on the 15 s tick (so the real window is 180–195 s).
- [ ] Record the restore-retry policy (attempts, backoff, terminal-token classification) in the module docstring of `session-restore.ts`.

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit (reducer)** | Drive the real reducer through `transport_close` / `transport_open` / `transport_settled` and assert state | [P01](#p01-transport-not-an-error), [P02](#p02-recovery-clears-error), [P08](#p08-preserve-queued-sends) |
| **Unit (Rust)** | Assert heartbeat constants and that a non-heartbeat inbound frame refreshes liveness | [P03](#p03-liveness-any-frame) |
| **Unit (connection)** | Probe-and-grace watchdog: probe on threshold, re-arm on a frame, close on grace expiry | [P09](#p09-probe-and-grace) |
| **Unit (restore)** | Attempt counter and backoff schedule; re-query-before-respawn; terminal-token classification | [P04](#p04-restore-retry) |
| **App-test** | Real card, real store, real DOM, **real socket close**: close → reconnect → restore → no banner, transcript back, queued sends delivered, submit live | Integration, [#step-9](#step-9) |
| **Manual** | Screen-lock suspension and a WebContent `kill` — neither is reachable from the harness | [#step-8](#step-8), [#step-9](#step-9) |

Existing suites that must be updated rather than duplicated: `tugdeck/src/lib/code-session-store/__tests__/code-session-store.errored.test.ts`, `…/code-session-store.transport-state.test.ts`, and `…/reducer.transport-downtime.test.ts` all assert current transport-close behavior. `tests/app-test/at0084-session-lifecycle-coordination.test.ts` drives `transportClose` through the `driveSession` harness verb and asserts the resulting overlay — check whether its expectations move.

#### What stays out of tests {#test-non-goals}

- **No mock `TugConnection`.** Transport events are driven through the real `ConnectionLifecycle` (`notifyConnectionDidClose` / `notifyConnectionDidOpen`), the existing `_simulateTransportForTest` hook, or the new real-close op from [#step-9](#step-9) — per the connection-health plan's established convention.
- **Do not verify the recovery path with `_simulateTransportForTest`.** It dispatches into a single store's reducer and touches neither `clearAll` nor `restoreSessions`, so it can produce a green test for a broken recovery. It is the right tool for the reducer contract and the wrong tool for everything else in this plan.
- **No simulated WKWebView suspension.** The harness cannot throttle timers the way a real occluded window does; the suspension path is verified manually via screen lock.
- **No WebContent-jetsam automation.** Killing the content process from a test would race the harness's own RPC bridge; verified manually.
- **No test asserting a specific reconnect wall-clock.** Backoff timing is environment-dependent; assert the *schedule* (attempt counts and ordering), not elapsed milliseconds.

---

### Execution Steps {#execution-steps}

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Make `connection.ts` greppable | done | `5ea768bce` |
| #step-2 | Reconnect-latch fix + close-cause diagnostics | done | `39839cdac` |
| #step-3 | Server: any-frame liveness, longer window | done | `01140d945` |
| #step-4 | Client: probe before condemning the wire | done | `f382fb18d` |
| #step-5 | Reducer: transport loss is not a card error | done | `dc558b06b` |
| #step-6 | Queued sends survive the close and the rebind | done | `f9ebdc988` |
| #step-7 | Restore: bounded retry, re-query before re-spawn | done | `429216adf` |
| #step-8 | Host: recover from WebContent termination | done | `466957e7d` |
| #step-9 | Integration checkpoint | done | `e3720a1c2` |

---

#### Step 1: Make `connection.ts` greppable {#step-1}

**Commit:** `tugdeck(connection): escape the NUL map-key separator so the file reads as text`

**References:** (#grep-blindness), (#strategy)

**Artifacts:**
- `tugdeck/src/connection.ts` — one character changed; no behavior change.

**Tasks:**
- [ ] Locate the composite map-key template literal that joins a session key and a message type with a raw NUL byte (used to key the `lastPayloadByType` replay cache).
- [ ] Replace the raw NUL with the escape sequence `\u0000` inside the template literal. The runtime string is byte-identical; only the source encoding changes.
- [ ] Confirm no other non-text bytes remain in the file.

**Tests:**
- [ ] No new tests — behavior is unchanged by construction. The checkpoint is the proof.

**Checkpoint:**
- [ ] `file tugdeck/src/connection.ts` reports `Unicode text, UTF-8 text` (not `data`)
- [ ] `grep -c "intentionalClose" tugdeck/src/connection.ts` returns `2`
- [ ] `cd tugdeck && bunx tsc --noEmit`
- [ ] `cd tugdeck && bunx vite build`

---

#### Step 2: Reconnect-latch fix + close-cause diagnostics {#step-2}

**Depends on:** #step-1

**Commit:** `tugdeck(connection): clear the intentionalClose latch on connect and record a structured close cause`

**References:** [P06](#p06-intentional-close-latch), [P07](#p07-close-cause-record), (#close-taxonomy)

**Artifacts:**
- `tugdeck/src/connection.ts` — latch reset in `connect()`; structured close record emitted from `onclose`.

**Tasks:**
- [ ] Set `this.intentionalClose = false` at the top of `connect()`, with a comment naming the failure it prevents (a close after an explicit `close()` never reconnecting).
- [ ] In the `onclose` handler, assemble a close record: close code, close reason, whether the watchdog force-closed this wire, ms since the last inbound frame (`Date.now() - lastFrameAt`), and `document.visibilityState`.
- [ ] Emit it via `tugDevLogStore` (the established runtime-log surface — never `console.warn`). Keep the existing `console.log` line or fold it in, but the dev-log entry is the one that must carry the fields.
- [ ] Set a flag when the watchdog initiates a close so the record can distinguish a watchdog force-close from a server-initiated one.

**Tests:**
- [ ] Unit: after `close()` followed by a fresh `connect()` and a subsequent unexpected close, a reconnect is scheduled (asserts the latch no longer sticks).

**Checkpoint:**
- [ ] `cd tugdeck && bun test`
- [ ] `cd tugdeck && bunx tsc --noEmit`
- [ ] `cd tugdeck && bunx vite build`
- [ ] In the running debug app, Opt-Cmd-/ → Log tab shows a close record with a staleness figure after a manual `window.tugdeck.reconnect()`

---

#### Step 3: Server — any-frame liveness, longer window {#step-3}

**Depends on:** #step-1

**Commit:** `tugcast(router): treat any inbound frame as proof of life and widen the heartbeat window`

**References:** [P03](#p03-liveness-any-frame), [Q01](#q01-drop-server-timeout), (#incident-evidence), (#close-taxonomy)

**Artifacts:**
- `tugrust/crates/tugcast/src/router.rs` — liveness refresh moved ahead of the feed-id dispatch; `HEARTBEAT_TIMEOUT` raised; constant test updated; doc comment expanded.

**Tasks:**
- [ ] In `handle_client`'s inbound-message arm, refresh `last_heartbeat` immediately after a frame decodes successfully — before the `FeedId::HEARTBEAT` / `FeedId::CONTROL` branch — so every frame type counts as proof of life.
- [ ] Leave the `FeedId::HEARTBEAT` branch in place for its debug log; it no longer carries the liveness responsibility alone.
- [ ] Raise `HEARTBEAT_TIMEOUT` from 45 s to 180 s. Leave `HEARTBEAT_INTERVAL` at 15 s.
- [ ] Expand the constant's doc comment: any inbound frame refreshes liveness; the check runs only on the 15 s interval tick, so the effective window is 180–195 s.
- [ ] Update `test_heartbeat_constants` to assert the new durations.

**Tests:**
- [ ] Rust unit: a decoded non-heartbeat inbound frame (e.g. CONTROL) refreshes the liveness instant — a client that sends only CONTROL traffic is never closed.
- [ ] Rust unit: `test_heartbeat_constants` asserts 15 s / 180 s.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast`
- [ ] `cd tugrust && cargo build` (warnings are errors — must be clean)

---

#### Step 4: Client — probe before condemning the wire {#step-4}

**Depends on:** #step-2, #step-3

**Commit:** `tugdeck(connection): probe with a heartbeat before the watchdog force-closes, and pulse on wake`

**References:** [P09](#p09-probe-and-grace), [P05](#p05-wake-heartbeat), [P03](#p03-liveness-any-frame), (#close-taxonomy)

**Artifacts:**
- `tugdeck/src/connection.ts` — probe-and-grace watchdog; a `visibilitychange` heartbeat pulse; corrected doc comments on both heartbeat constants.

**Tasks:**
- [ ] **Leave `HEARTBEAT_TIMEOUT_MS` at 45 000.** It measures server→client silence against the server's 15 s emit cadence and is unrelated to the server-side timeout raised in [#step-3](#step-3). Leave `HEARTBEAT_INTERVAL_MS` at 15 000 and `WATCHDOG_TICK_MS` at 5 000.
- [ ] Rewrite the `HEARTBEAT_TIMEOUT_MS` doc comment, which currently instructs the reader to move it in lockstep with the server constant. State plainly which direction each threshold measures and that they are independent.
- [ ] Add `WATCHDOG_GRACE_MS = 10_000`.
- [ ] Convert the watchdog from "threshold crossed → `ws.close()`" to probe-and-grace: on crossing the threshold, send a heartbeat frame, record the `lastFrameAt` value at that moment, and open a grace window. On a subsequent tick, if `lastFrameAt` has advanced, the wire is healthy — close the grace window and re-arm. If the grace window has been open longer than `WATCHDOG_GRACE_MS` with no advance, force-close as before.
- [ ] Set the watchdog-initiated flag from [#step-2](#step-2) only on the real force-close, so the close-cause record distinguishes a failed probe from a server-initiated close.
- [ ] Add a `visibilitychange` listener, registered alongside the heartbeat timers and torn down with them ([L27]), that sends one heartbeat frame when `document.visibilityState` becomes `visible` and the socket is open.
- [ ] Comment why the pulse exists: on wake from sleep the interval timer was frozen while the server's clock kept running, so the next scheduled beat may arrive after the server has already given up.

**Tests:**
- [ ] Unit: crossing the threshold sends a heartbeat and does **not** close the socket.
- [ ] Unit: an inbound frame during the grace window re-arms the watchdog and leaves the socket open.
- [ ] Unit: no inbound frame within `WATCHDOG_GRACE_MS` force-closes, and the close record carries the watchdog flag.
- [ ] Unit: a visibility transition to `visible` on an open connection sends exactly one heartbeat frame; a transition while closed sends none.

**Checkpoint:**
- [ ] `cd tugdeck && bun test`
- [ ] `cd tugdeck && bunx tsc --noEmit`
- [ ] `cd tugdeck && bunx vite build`

---

#### Step 5: Reducer — transport loss is not a card error {#step-5}

**Depends on:** #step-1

**Commit:** `tugdeck(session-store): stop minting a card-locking error for transport loss`

**References:** [P01](#p01-transport-not-an-error), [P02](#p02-recovery-clears-error), Risk [R01](#r01-banner-masking), (#teardown-cascade)

**Artifacts:**
- `tugdeck/src/lib/code-session-store/reducer.ts` — `handleTransportClose` no longer stamps `lastError`; `handleTransportOpen` and `handleTransportSettled` clear a `transport_closed` one.
- Updated assertions in the three existing transport suites.

**Tasks:**
- [ ] In `handleTransportClose`, remove the `lastError: {cause: "transport_closed", …}` stamp from the non-idle return. Keep `phase: "errored"`, `transportState: "offline"`, `wakeTrigger: null`, the preflight/echo/downtime bookkeeping, and the `transport_lost` transcript commit exactly as they are.
- [ ] Replace the block comment so it explains the new contract: the offline `transportState` and the "Reconnecting…" bulletin own the condition; the banner is reserved for breakage that does not self-heal.
- [ ] In `handleTransportOpen` and `handleTransportSettled`, clear `lastError` when its `cause === "transport_closed"` and leave every other cause untouched.
- [ ] Update assertions in `code-session-store.errored.test.ts` and `code-session-store.transport-state.test.ts` that currently expect the `transport_closed` cause.
- [ ] Check `reducer.transport-downtime.test.ts` — its downtime-accounting assertions should be unaffected, but it drives the same handlers.

**Tests:**
- [ ] Reducer: after `transport_close` from a non-idle phase, `lastError === null` and `transportState === "offline"`.
- [ ] Banner spec: given a post-close snapshot, `deriveSessionCardBannerSpec` returns `{kind: "none"}`.
- [ ] Banner spec (guard for [R01](#r01-banner-masking)): a `session_state_errored` cause still returns `{kind: "error"}`.
- [ ] Reducer: a pre-existing `transport_closed` error is cleared by `transport_settled`; a `session_state_errored` error survives it.

**Checkpoint:**
- [ ] `cd tugdeck && bun test`
- [ ] `cd tugdeck && bunx tsc --noEmit`
- [ ] `cd tugdeck && bunx vite build`

---

#### Step 6: Queued sends survive the close and the rebind {#step-6}

**Depends on:** #step-5

**Commit:** `tugdeck(session-store): carry queued sends across a transport close and the rebind that follows`

**References:** [P08](#p08-preserve-queued-sends), [Q02](#q02-nondestructive-restore), (#teardown-cascade), [L23]

**Artifacts:**
- `tugdeck/src/lib/code-session-store/reducer.ts` — `queuedSends` removed from the per-turn reset in `handleTransportClose`.
- `tugdeck/src/lib/session-restore.ts` — a module-scope `Map<cardId, QueuedSend[]>` stash with write, drain, and clear.
- `tugdeck/src/lib/card-services-store.ts` — `_construct` drains the stash into the fresh store.

**Tasks:**
- [ ] Remove `queuedSends: []` from the `perTurnReset` object built when a `transport_lost` turn is committed. Leave every other member of the reset (`scratch`, `toolUseStartedAt`, `pendingApproval`, `pendingQuestion`, `prevPhase`, `pendingTurn`, telemetry, pause-segment closure) in place.
- [ ] Comment the asymmetry: the rest of the reset belongs to the dead turn; the queue belongs to the user.
- [ ] Add the per-card stash keyed by `cardId`. Write to it when a card's services are disposed with a non-empty `queuedSends` — read the queue off the store before `dispose()` in `CardServicesStore._dispose`, so the stash captures whatever survived the reducer change above.
- [ ] Drain the stash in `_construct`, seeding the fresh store's queue, and clear the entry on drain. Place the drain alongside the existing post-construction work (`request_replay` dispatch, `notifyResumeBindingLanded`).
- [ ] Clear a card's stash entry on explicit card close so a queued message cannot resurface on an unrelated later session.
- [ ] Verify the queue-flush path fires for a re-seeded queue arriving at a post-replay `idle`. The existing flush is driven from a successful `turn_complete`; on this path there is no prior turn, so confirm the head is actually sent (and fix the gap if it is not — a stash that never drains is worse than no stash).

**Tests:**
- [ ] Reducer: with two queued sends and a turn in flight, a `transport_close` leaves `queuedSends.length === 2`.
- [ ] Reducer: the `transport_lost` transcript commit still happens, and `pendingTurn` is still cleared.
- [ ] Unit: dispose-with-queue then construct-for-same-card seeds the fresh store with the same sends and empties the stash.
- [ ] Unit: an explicit card close clears the stash; a later construct for that card seeds nothing.

**Checkpoint:**
- [ ] `cd tugdeck && bun test`
- [ ] `cd tugdeck && bunx tsc --noEmit`
- [ ] `cd tugdeck && bunx vite build`

---

#### Step 7: Restore — bounded automatic retry {#step-7}

**Depends on:** #step-5

**Commit:** `tugdeck(session-restore): retry a failed reconnect restore before dropping the card to the picker`

**References:** [P04](#p04-restore-retry), Risk [R03](#r03-retry-masks-rejection), [Q02](#q02-nondestructive-restore), (#teardown-cascade)

**Artifacts:**
- `tugdeck/src/lib/session-restore.ts` — a `scheduleRestoreRetry` helper, a per-card attempt counter, rejection classification, and lifecycle logging.

**Tasks:**
- [ ] Raise `RESTORE_TIMEOUT_MS` from 10 s to 20 s, and correct its doc comment: it claims a `restore_timed_out` picker notice that the timeout handler never sets.
- [ ] Add a module-scope `Map<string, number>` of per-card restore attempts, sitting alongside the existing `restoreStartedAt` map. Clear a card's entry when its binding lands (the same place `sessionRestoreRegistry._clear` runs on success).
- [ ] Add `scheduleRestoreRetry(cardId, …)`: if attempts remain (3 total), increment the counter and `setTimeout` at the backoff for that attempt (≈2 s / 6 s / 15 s). On exhaustion, fall through to today's behavior (picker notice).
- [ ] **The retry body re-queries first.** On fire, send `list_card_bindings` and wait for the ack via the existing `subscribeToListCardBindingsOk` handler. If the listing shows the card already bound, the original spawn landed late — clear the retry, log `restore.retry_skipped_already_bound`, and stop. Only if the card is genuinely absent from the listing re-fire the spawn (`fireRestore` for resume-mode, `fireFreshSpawn` otherwise).
- [ ] Route the timeout backstops in `fireRestore` and `fireFreshSpawn` through the scheduler instead of only clearing the hold. Replace the "the next reload retries" comment, which is no longer the recovery plan.
- [ ] In `installRegistrySubscriptions`, classify the `SESSION_STATE errored` detail: the known terminal gate tokens handled by `resumeRejectionMessage` (`session_live_in_terminal`, `session_live_elsewhere`) go straight to `pickerNoticeStore` with no retry; any other detail schedules a retry.
- [ ] Log `restore.retry_scheduled` (card id, session id, attempt, delay), `restore.retry_skipped_already_bound`, and `restore.retry_exhausted` through `logSessionLifecycle`, matching the existing `restore.server_rejected` / `restore.fresh_spawn_timed_out` lines.
- [ ] Ensure a card cancelled by the user, or one whose binding arrives while a retry is pending, cancels its pending retry timer ([L27] — every armed timer has a release).

**Tests:**
- [ ] Unit: a timed-out restore schedules attempt 1; three failures exhaust the budget and produce exactly one picker notice.
- [ ] Unit: a retry whose `list_card_bindings` ack shows the card already bound fires no spawn and clears the retry.
- [ ] Unit: a retry whose listing shows the card absent re-fires the spawn exactly once.
- [ ] Unit: a `session_live_in_terminal` rejection produces a picker notice immediately with zero retries scheduled.
- [ ] Unit: a binding arriving while a retry is pending cancels the timer and resets the counter.

**Checkpoint:**
- [ ] `cd tugdeck && bun test`
- [ ] `cd tugdeck && bunx tsc --noEmit`
- [ ] `cd tugdeck && bunx vite build`
- [ ] `just app-test-changed`

---

#### Step 8: Host — recover from WebContent termination {#step-8}

**Depends on:** #step-1

**Commit:** `tugapp(mainwindow): reload the deck when the WebContent process is terminated`

**References:** [P07](#p07-close-cause-record), Risk [R02](#r02-reload-loses-draft), (#close-taxonomy)

**Artifacts:**
- `tugapp/Sources/MainWindow.swift` — a `webViewWebContentProcessDidTerminate(_:)` implementation.

**Tasks:**
- [ ] Implement `webViewWebContentProcessDidTerminate(_ webView: WKWebView)` in the `WKNavigationDelegate` section, next to the existing `didFail` / `didFailProvisionalNavigation` handlers. `MainWindow` already declares `WKNavigationDelegate` conformance, so this is purely additive.
- [ ] `NSLog` the termination distinctly — this event is currently completely invisible, and distinguishing it from a transport close is the whole point.
- [ ] Reload the page (`webView.reload()`, falling back to `loadURL` with the last URL if `webView.url` is nil). The deck re-resumes from JSONL on load, so a reload is a full recovery.
- [ ] Guard against a reload loop: if a termination arrives within a few seconds of the previous one, log and stop rather than reloading again.

**Tests:**
- [ ] Manual: with several cards open, kill the `Tug.app` WebContent child process; the window reloads and cards re-resume rather than going blank. (Not harness-automatable — see [#test-non-goals](#test-non-goals).)

**Checkpoint:**
- [ ] The app builds and launches
- [ ] Console shows the termination log line and a subsequent successful reload after a manual WebContent kill

---

#### Step 9: Integration Checkpoint {#step-9}

**Depends on:** #step-4, #step-6, #step-7, #step-8

**Commit:** `N/A (verification only)`

**References:** [P01](#p01-transport-not-an-error), [P03](#p03-liveness-any-frame), [P04](#p04-restore-retry), (#success-criteria), (#incident-evidence)

**Tasks:**
- [ ] **Add a test-surface op that drives a *real* close.** The existing `transportClose` op calls `CodeSessionStore._simulateTransportForTest`, which dispatches straight into one store's reducer — it never touches `ConnectionLifecycle`, `cardSessionBindingStore.clearAll()`, or `restoreSessions`, so it cannot exercise any of the recovery work in this plan. `forceReconnect()` is not a substitute: it early-returns when `state === CONNECTED`. Add a `connectionClose` op backed by a new `TugConnection._forceCloseForTest()` that calls `ws.close()` **without** setting the `intentionalClose` latch, so the full lifecycle runs: close → `connectionDidClose` → reconnect → `connectionDidReconnect` → `clearAll` → restore.
- [ ] Author `tests/app-test/atXXXX-transport-reconnect-recovery.test.ts` (next free `at####`) with a `@covers` header naming `tugdeck/src/lib/code-session-store/reducer.ts`, `tugdeck/src/lib/session-restore.ts`, `tugdeck/src/lib/card-services-store.ts`, and `tugdeck/src/connection.ts`. Drive the new `connectionClose` op against a card with a transcript, then assert after recovery: no error banner in the DOM, the card body is not `inert`, the transcript is repopulated, and the submit control is live again.
- [ ] Keep one assertion on the store-level path too (the existing `transportClose` op) so the reducer contract from [#step-5](#step-5) stays pinned independently of the wire.
- [ ] Verify `tests/app-test/at0084-session-lifecycle-coordination.test.ts` still passes — it drives `transportClose` and asserts the resulting overlay, so its expectations may need to move with [P01](#p01-transport-not-an-error).
- [ ] Manual suspension run: release app, ≥ 3 open session cards with transcripts, lock the screen for 10+ minutes, unlock. Every card must show its transcript and a live submit arrow, with no red banner.
- [ ] Read `~/Library/Application Support/Tug/instances/release-main/Logs/tugcast.log.<today>` after the suspension run and confirm no `Heartbeat timeout, closing connection` line was produced.

**Tests:**
- [ ] The new app-test passes
- [ ] `at0084` passes unchanged or with justified updated expectations

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run`
- [ ] `cd tugdeck && bun test`
- [ ] `cd tugdeck && bunx tsc --noEmit && bunx vite build`
- [ ] `just app-test-changed`

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** A deck that survives an unattended machine: quiet wires are not killed, a close that does happen shows a self-healing "Reconnecting…" bulletin instead of locking every card behind a red banner, restores retry until they succeed, queued messages survive, and a killed WebContent process reloads itself.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] No `transport_closed` `lastError` is ever stamped, and any stale one clears on recovery (`bun test` on the reducer and banner-spec suites)
- [ ] Any inbound frame refreshes server-side liveness; the window is 180 s (`cargo nextest run -p tugcast`)
- [ ] A rejected or timed-out restore retries up to 3 times with backoff before the picker, re-querying before it re-spawns (unit tests + `restore.retry_scheduled` / `restore.retry_skipped_already_bound` in the log)
- [ ] Queued sends survive the close *and* the rebind, arriving in the rebuilt card (app-test, not a reducer-only assertion)
- [ ] A dead server is still detected within ~60 s while the page is active (probe-and-grace unit tests)
- [ ] A 10-minute screen-lock suspension produces zero dumped cards and zero heartbeat-timeout log lines (manual run in [#step-9](#step-9))
- [ ] A WebContent kill reloads the window (manual run in [#step-8](#step-8))
- [ ] `file tugdeck/src/connection.ts` reports UTF-8 text

**Acceptance tests:**
- [ ] `tests/app-test/atXXXX-transport-reconnect-recovery.test.ts`
- [ ] `tests/app-test/at0084-session-lifecycle-coordination.test.ts`
- [ ] `tugdeck/src/lib/code-session-store/__tests__/code-session-store.transport-state.test.ts`
- [ ] `tugdeck/src/lib/code-session-store/__tests__/code-session-store.errored.test.ts`

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] Resolve [Q01](#q01-drop-server-timeout) — drop the server heartbeat timeout entirely if the telemetry says it never fires usefully.
- [ ] Resolve [Q02](#q02-nondestructive-restore) — non-destructive reconnect restore, which needs a rebind signal that survives `_reconcile`'s same-session short-circuit.
- [ ] Resolve [Q03](#q03-transport-lost-reconciliation) — reconcile synthetic `transport_lost` turns against the backend's real outcome.
- [ ] Configure the WebSocket upgrade's tungstenite budgets in `router.rs` (`max_message_size`, `max_write_buffer_size` — currently the unbounded default, a memory-growth path under a slow client and a large `replay_batch`).
- [ ] Enforce `MAX_PAYLOAD_SIZE` in `Frame::encode` in `tugcast-core`, which today enforces it only on `decode`.
- [ ] Replace the `lock().unwrap()` pairs on the router's client-ownership path with poison-tolerant handling — a single panic there would poison the mutex for every subsequent connection.
- [ ] Surface a distinct message for a handshake-rejection close, which today retries silently forever against a version-mismatched server.

| Checkpoint | Verification |
|------------|--------------|
| Transport loss no longer banners | `cd tugdeck && bun test` (reducer + banner-spec suites) |
| Any-frame liveness, 180 s window | `cd tugrust && cargo nextest run -p tugcast` |
| Restore retries before the picker | Unit tests + `restore.retry_scheduled` in `tugcast.log` |
| Queued sends survive | `cd tugdeck && bun test` (reducer suite) |
| End-to-end reconnect recovery | `just app-test-changed` |
| Suspension survival | Manual 10-minute screen-lock run ([#step-9](#step-9)) |
| WebContent recovery | Manual process kill ([#step-8](#step-8)) |
