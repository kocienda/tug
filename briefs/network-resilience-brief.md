# Network Resilience: Tug Stays Lively on a Bad or Absent Network

**Purpose:** On a slow, flaky, or absent network Tug hangs in three places — interrupt, session restore, and launch — and leaves the user with no way out. Tug must behave like a web browser does offline: unable to do its main job, and still responsive, truthful, and never blocking.

---

## Purpose {#purpose}

The report, from a flight with spotty wifi:

> Can't interrupt when on a bad network connection (like I was on an airplane); Can't load a session on a bad network. Hangs *forever*.; App does not even start without a network.

And the standard the fix is held to:

> I understand that this is a pervasively-networked app. It's kind of like a web browser in this way—you can't do much unless you can load network resources. That said, think about how a web browser stays lively, doesn't hang, and doesn't block me, even when it *can't do its main job of loading web pages when the network is down or slow to respond*. Tug needs to act that way too. We can't just fail, or leave the user hanging.

Two screenshots accompanied it. One shows an app-wide modal, "Restoring 1 session — Tug is rebuilding your transcripts. Just a moment.", with its progress bar complete at "10 of 10 turns" and the state strip reading "Restoring", never closing. The other shows the state strip reading "Interrupting" with the turn timer stopped at 6m 42s while a Bash tool block's own timer reads 8m 03s and is still spinning; the stop button is drawn and inert.

Working on an airplane, and anywhere else the connection is unreliable, is a necessary feature, not an edge case.

---

## Evidence {#evidence}

Three read-only traces were run, one per failure. Findings marked **(verified)** were re-read directly out of the code after the trace reported them. Findings marked **(traced)** come from a delegated read of the code with the line references given; they were not independently re-read, and a line number may have drifted. Findings marked **(inference)** say what would confirm them.

The through-line: **none of the three failures is a wait on the network.** The deck talks to tugcast over loopback, and that link stays healthy on a plane. In each case Tug is waiting on itself, and the bad network only supplies the conditions that expose the unbounded wait.

### Interrupt

**[F01] The interrupt escalation ladder exists and works.** `tugcode/src/session.ts` `handleInterrupt` (~`:7807`) sends a stream-json `control_request{subtype:"interrupt"}` and arms `armInterruptEscalation` (~`:4416`). If the turn has not ended within `INTERRUPT_ACK_GRACE_MS = 2000`, `forceTerminateAndRespawn("interrupt_unacked")` runs: `killAndCleanup({escalate:true})` sends SIGINT to the process group, waits `FORCE_TERMINATE_SIGINT_GRACE_MS = 1500`, sends SIGKILL, sweeps the group, then `respawnResume()` respawns claude with `--resume` and writes a synthetic `session_init`. A wedged claude is dead roughly 3.5 s after Stop is pressed. **(traced)**

**[F02] The ladder's receipt has no consumer in the deck.** The kill path ends the turn with a `turn_cancelled` frame (`tugcode/src/session.ts:7518`, `:7566`). `grep -rn "turn_cancelled" tugdeck/src` returns nothing. The frame is absent from `KNOWN_CODE_OUTPUT_TYPES` (`tugdeck/src/lib/code-session-store.ts:285`) and is therefore discarded at the guard `if (!KNOWN_CODE_OUTPUT_TYPES.has(ev.type)) return null;` (`:1909`) — no dispatch, no log. tugcast forwards the payload unchanged. **(verified)**

**[F03] `interruptInFlight` has no deadline and one practical clearer.** `handleInterrupt` CASE B (`tugdeck/src/lib/code-session-store/reducer.ts` ~`:1428`) sets `interruptInFlight: true` and emits the frame; no timer is scheduled. The flag is cleared only by `resetPerTurnTelemetry()`, reached in this state only through `handleTurnComplete` — that is, only by a `turn_complete` frame, which is what the *healthy* path sends when claude services its own stdin. On a good network claude always answers inside 2 s, which is why the defect stayed hidden. **(traced)**

**[F04] The stuck state offers no exit.** While `interruptInFlight` is true the submit button renders mode `stopping` — the stop glyph, `disabled: true` (`lifecycle-state.ts` ~`:200`, `tug-prompt-entry-submit-button.ts` ~`:88`). Escape and ⌘. are deliberately unregistered (`tug-prompt-entry.tsx` ~`:3150`). `canSubmit` is false because phase is still `tool_work`. Session ▸ Stop remains enabled and re-fires a useless interrupt. There is no deck-side force stop: the `stop_all_work` verb is fully implemented in tugcode (`session.ts` ~`:4315`, answered with `stop_all_work_done`) but its only producer is tugcast's arc machinery. The user's one real exit is closing the card. **(traced)**

**[F05] The flag survives an error.** `handleWireError` and `handleSessionStateErrored` set `phase: "errored"` and leave `interruptInFlight` set; `session-phase-visual.ts` (~`:145`) tests the flag before the phase, so the strip keeps reading "Interrupting" over a dead session. A second, independent latch. **(traced)**

**[F06] tugcode has two silent early returns on interrupt.** `handleInterrupt` returns with only a console log when `claudeProcess` is null (~`:7808`), and arms no escalation when `activeTurn === null` (~`:7830`). In either case the deck waits forever for a receipt nobody will send. **(traced)**

**[F07] The screenshot matches the dropped-receipt reading.** `deriveInflightActiveMs` (`code-session-store/telemetry.ts` ~`:816`) pauses the turn clock from `interruptInFlightSegmentStartedAt` while the tool clock runs on. Turn 6m 42s against tool 8m 03s puts the Stop press 81 s before the capture, with the card frozen since. That the escalation fired in this incident is **(inference)** — no log was captured — but it is the only reading consistent with the code: a honored interrupt produces `turn_complete`, which the deck handles.

**[F08] Three documents assert the deck handles `turn_cancelled`.** `tuglaws/wheel.md:57` and `briefs/protocol-error-hardening-brief.md` ([F06]/[B03] there) state that the deck "already renders" it quietly; `tuglaws/design-decisions.md` (D19, ~`:324`) rests the absence of any in-flight interrupt indicator on "interrupt is instant from the user's POV". The only deck code that ever handled the frame was the archived conversation card, removed in `a2d213f99`. The belief is the root of the bug. **(traced)**

**[F09] Quit inherits the same defect.** `interruptLiveSessions` (`tugdeck/src/deck-manager.ts` ~`:6514`) waits `TERMINATION_INTERRUPT_AWAIT_MS = 5000` for `phase ∈ {idle, errored}` — correctly sized to contain tugcode's ladder, and never satisfied, because the ladder's receipt is dropped. Every escalated interrupt is reported unacknowledged at quit. **(traced)**

### Restore

**[F10] Transcript replay is local and completed.** `runReplay` (`tugcode/src/session.ts` ~`:5200`) reads `~/.claude/projects/<dir>/<id>.jsonl` itself and streams it; it touches neither the network nor the claude process, and is capped by `REPLAY_HARD_TIMEOUT_MS = 10_000`. Resume writes a synthetic `session_init` before claude spawns, and nothing in the restore path awaits claude's init, auth, or MCP connects. "10 of 10 turns" means the replay's content arrived. **(traced)**

**[F11] The only exit from Restoring is one frame, and its backstop can be starved.** `deriveColdRestoreActive` (`session-card-restore-gate.ts` ~`:63`) stays true while `phase === "replaying"`; the phase ends only on `replay_complete` or a non-null `lastError`. The sole manufacturer of that error is `REPLAY_SILENCE_DEADLINE_MS = 15_000`, and `replaySilenceEffect` (`reducer.ts:931-949`) re-arms it on **any** wire frame for the session — its docstring: "It measures silence, never duration: every frame restarts it." The wrapper passes `origin === "wire"` for every ingested frame (`code-session-store.ts:2195`). A claude retrying a dead API emits `api_retry` frames more often than every 15 s; any such chatter holds the deadline open indefinitely. The deadline's own sizing comment assumes the only frame that can arrive in a bracket is the replay's next one. **(verified)**

**[F12] The deck has no absolute cap on a replay bracket.** tugcast has one — `REPLAY_BRACKET_DEADLINE`, 120 s, reset only at `replay_started` (`agent_bridge.rs` ~`:896`, `:2185`), synthesizing `replay_complete{replay_timeout}`. The deck has only the re-armable silence timer. **(traced)**

**[F13] The restore modal is app-wide and undismissable.** `TugRestoreGate` (`tug-restore-gate.tsx`) is mounted at the deck root (`deck-manager.ts` ~`:2233`), renders an `AlertDialog` overlay with a trapped focus scope, suppresses Escape, and has no cancel and no timeout of its own; its JSDoc rests its safety on the silence deadline — "the gate can outlast the work by at most the deadline". `restoreGateStore` opens it for any live store in cold restore. One stuck card therefore freezes every other card, including non-session cards, and hides a transcript that is already mounted and painted behind it. **(traced)**

**[F14] `replay_complete` can be lost silently in four places.** CODE_OUTPUT overflow past the 1000-frame replay ring (`router.rs`, `main.rs` ~`:386`); a `request_replay` arriving while a prior replay is in flight, dropped with a log (`session.ts` ~`:5228`); a `request_replay` before session init, dropped with a `console.error` (`inbound-dispatch.ts` ~`:126`); `replay_started`/`replay_complete` arriving outside the expected phase, dropped with a `console.warn` (`reducer.ts` ~`:4869`, `:4923`). Which one fired in the reported incident is **not determined** — no log was captured. The missing absolute cap ([F12]) is the defect regardless of which.

**[F15] The hung-claude spawn watchdog was deliberately removed.** `session.ts` ~`:4632` records that a claude that runs but never emits leaves "a populated transcript that doesn't react to the first submit… the user's recourse is to close the card and reopen." `handleUserMessage` also awaits `claudeReadyPromise` with no timeout (~`:7616`). A bad network is a plausible producer of both. **(traced)**

### Launch

**[F16] Nothing in the release launch path requires the network.** tugcast binds `127.0.0.1`, the ready URL is `http://127.0.0.1:<port>/auth?…`, the WebSocket inherits that host, `tugdeck/index.html` carries no remote font, script, or CDN, and CSP is `default-src 'self'`. No DNS is performed. The one outbound connection at launch is Sparkle's appcast check, asynchronous and silent on failure. `localhost` as a hostname appears only in the maker/debug Vite proxy (`tugdeck/vite.config.ts` ~`:833`). **(traced)**

**[F17] The splash has one exit and no deadline.** Only `frontendReady` removes it (`MainWindow.swift` `revealWebView`, ~`:1105`). Every failure on the way there is log-only: `didFailProvisionalNavigation` only `NSLog`s (~`:1140`); tugcast exits are respawned forever with backoff capped at 30 s and nothing shown; `initTugmark(wasmUrl)` and `activateProductionTheme` in `tugdeck/src/main.tsx` are awaited with no timeout. Any stall anywhere presents identically: a spinner that never ends. **(traced)**

**[F18] PATH resolution blocks the main thread with no timeout.** On a cache miss, `resolveShellPATHViaLoginShell()` (`ProcessManager.swift:119-165`) runs `dscl` and then `<shell> -lic` — the user's full rc files — with `waitUntilExit()` on the main thread, after the splash is up. Any rc-file tool that touches the network stalls the app indefinitely. The cache (`~/Library/Application Support/Tug/shell-path.cache`) makes this a first-launch / new-identity / deleted-cache hazard. **(traced)**

**[F19] The setup wizard's only exits need a network.** `ConfigureTug` (`configure-tug.tsx` ~`:413`) is app-modal and required when `loggedIn === false`, and on first run while `loggedIn === null` ("probing") with no timeout. Its actions are Install (`curl … | bash`) and Sign in (browser OAuth). If the auth probe (`claude auth status --json`, `claude_auth.rs` ~`:90`, no timeout) reports logged-out offline — for instance because a token refresh needs the network — the app paints and is unusable. The probe returned `loggedIn: true` in ~135 ms with a valid stored login and proxies pointed at a dead port; behaviour with an **expired** token offline is **not determined**.

**[F20] The actual cause of the reported launch failure is not determined.** Candidates, in order: an OS-level stall outside the repo (Gatekeeper/OCSP on a fresh bundle, a PAC auto-proxy fetch before the loopback load, a network-bound `dscl`); [F18]; [F19]; on a debug build, the Vite path's 10 s "load it anyway" branch (`AppDelegate.swift` ~`:397`). Whether the failing build was release or debug is unknown. What settles it: launch with the network off, then `sample Tug` and `log show --predicate 'process == "Tug"' --last 5m | grep -E 'LAUNCH|Navigation failed'`. The launch lap instrumentation goes to the unified log, not to `tugapp.log`.

### Network awareness

**[F21] Nothing in the stack knows the network's state.** No `NWPathMonitor`, `navigator.onLine`, or reachability check exists in `tugdeck/src`, `tugapp/Sources`, or `tugrust/crates`. The only "offline" the deck knows is its own loopback WebSocket, which stays `online` on a plane — so no overlay or bulletin ever fires. **(traced)**

**[F22] The truthful signals already exist and are under-consumed.** `api_retry` frames fold into `CodeSessionState.apiRetry`, and `classifyApiRetry` (`cards/api-retry.ts` ~`:76`) already carries a "Connection lost" classification driven by `NETWORK_ERROR_TOKENS`, shown today only as a transient bulletin that any stream event clears. `lastStreamEventAt` / `maxStreamGapMs` measure stream silence and are read only by the devtools telemetry inspector. The `transport_down` overlay (`lifecycle-state.ts` ~`:176`) is the existing pattern for a state orthogonal to the base lifecycle. **(traced)**

**[F23] The deck already has the right timer construction.** `ScheduleTimerEffect` / `CancelTimerEffect` (`code-session-store/effects.ts` ~`:112`) are named, re-entrancy-safe, and driven through an injectable `TimerSource` so tests advance time deterministically. `replay_silence` and `connection.ts`'s probe-then-condemn watchdog are both event-armed timers on the thing watched, not polls. **(traced)**

**[F24] The same unbounded-wait shape exists one layer up.** `briefs/arc-stop-resume-brief.md` [F17] — "The press has no horizon": `arcPressStore` releases only on an `_ok`/`_err` frame. No brief, law, or note anywhere in `briefs/`, `tuglaws/`, or `tugplug/` addresses offline operation, degraded networks, or a liveness indicator for a live turn. The design space is unwritten. **(traced)**

---

## Decisions {#decisions}

**[B01] The governing model is the browser's: the chrome never waits on the content.** Four properties define it and every decision below is an instance of one: stop is a local act; every wait ends in a named state with a retry; one surface never blocks another; the network's state is always visible. This is the standard the user set, and it is what makes the work one arc rather than three bug fixes.

**[B02] The deck handles `turn_cancelled`.** It is added to `KNOWN_CODE_OUTPUT_TYPES` and given a reducer handler that ends the turn as an interrupted turn, clears `interruptInFlight`, and honours `is_recovery` — a recovery cancel renders quietly, as the wheel law already claims. This is the verified root cause of the stuck interrupt ([F02]) and also repairs quit ([F09]). The documents in [F08] are corrected to describe what the code now does.

**[B03] `interruptInFlight` cannot outlive the turn it belongs to.** Entering `errored` clears it ([F05]), so the strip can never read "Interrupting" over a dead session. A flag whose clearer is a single frame type is the defect pattern; every terminal transition clears it.

**[B04] tugcode answers every interrupt.** The two silent early returns ([F06]) each write a receipt — the deck is told there was no process or no turn to stop, and settles. An inbound verb that can return without emitting is a silent early return, and the deck cannot put a deadline on every one of them instead.

**[B05] Stop settles on the deck's own clock.** An `interrupt_silence` timer, built exactly like `replay_silence` ([F23]), is armed when CASE B sets `interruptInFlight` and cancelled by any turn end. It is sized just past tugcode's ladder (2 s + 1.5 s + respawn) — about 6 s. When it fires the deck declares the turn ended locally with a named cause, and the composer is usable again. With [B02] and [B04] in place this timer should never fire; it exists because the whole failure was a receipt that was supposed to be impossible to lose.

**[B06] A stalled stop becomes Force Stop.** If the interrupt deadline fires, the stop button does not go inert — it becomes Force Stop and sends the existing `stop_all_work` verb, which tugcode already implements and answers ([F04]). No new tugcode machinery. The rule it serves: the control the user just pressed is never the control that gets disabled.

**[B07] The app-wide restore modal is removed; restore blocks only its own card.** "Restoring" is a state of one card. Other cards, and non-session cards, stay fully live. Turns are readable as they land. This is a clean removal, not a softened modal with a Cancel button added: the install base is zero, and a modal whose safety rests on a timer ([F13]) is the wrong construction, not a mis-tuned one. Tests that pin `TugRestoreGate` as app-blocking are this arc's to rewrite, because this arc is the decision that changes them.

**[B08] The deck caps a replay bracket absolutely.** A second timer is armed at `replay_started` and is never re-armed, mirroring tugcast's `REPLAY_BRACKET_DEADLINE` semantics ([F12]). And the silence timer is re-armed only by frames that belong to the bracket (`replay_batch`, `replay_*`, and the turn frames it carries), never by unrelated live output ([F11]). Either alone closes the reported hang; both are wanted, because the silence timer's sizing argument is only true once unrelated frames stop counting.

**[B09] Reading never depends on claude being alive; only sending does.** A restored transcript is local data ([F10]) and is readable the moment it arrives. Whether claude came up affects the composer, not the transcript. The send path gets a bounded wait and a named failure in place of the unbounded `claudeReadyPromise` await and the removed spawn watchdog ([F15]).

**[B10] The splash gets a deadline and a failure screen.** After about 10 s without `frontendReady`, the spinner is replaced by a screen that says which stage stalled, with Retry and Show Log. `didFailProvisionalNavigation`, a tugcast that keeps exiting, and a stalled `initTugmark` or theme load all route to it rather than to `NSLog` alone ([F17]). The launch laps are also written to `tugapp.log`, so the next report of this kind arrives with its own evidence ([F20]).

**[B11] PATH resolution leaves the main thread and gets a timeout.** On timeout the app proceeds with the cached or default PATH and says so in the log ([F18]). A user's rc files are not Tug's to wait on.

**[B12] `ConfigureTug` gets an offline state.** When its required actions cannot succeed, it says so — "can't sign in right now" — and lets the user through to existing sessions for reading. The first-run "probing" hold gets a deadline. The auth probe gets a timeout ([F19]).

**[B13] Network state is shown, and the primary signal is what claude reports, not what the OS reports.** A `stalled` overlay — orthogonal to the base lifecycle, in the manner of `transport_down` — is driven by the `api_retry` "Connection lost" classification and by stream silence measured from `lastStreamEventAt` ([F22]). The state strip reads, for example, "Waiting for network — retry 3 of 10", and Stop stays live throughout. `NWPathMonitor` in the Swift host feeds the deck as a **hint only**: captive and airplane wifi report the path as satisfied while nothing gets through, so it can never be the signal that says things are fine.

**[B14] A prompt submitted while offline is queued, not refused.** Decided by the user. The prompt enters a visible "held" state and is sent when the network returns. Refusing would make the user the retry loop, which is the opposite of [B01].

**[B15] Everything here is event-armed; nothing polls.** Deadlines are timers armed by the event that starts the wait and cancelled by the event that ends it ([F23]). The held queue ([B14]) is released by an event — an `NWPathMonitor` transition or a stream event proving the path — never by a periodic probe of the network. This is standing project doctrine, restated because a "check whether we're back online" timer is the obvious wrong implementation.

**[B16] "No wait without a horizon" becomes a law.** Every wait on another process has a deadline, a named terminal state, and a user exit; and no app-wide modal may depend on anything outside the deck. It is written into `tuglaws/` and followed by an audit for the same shape elsewhere, starting with `arcPressStore` ([F24]). Three independent instances in one report, plus one already written up in another brief, is a pattern, and a pattern left unnamed recurs.

---

## Open Questions {#open-questions}

- **What releases a held prompt when the session is idle?** With no turn in flight there are no `api_retry` frames, so the only available event is `NWPathMonitor` — the signal [B13] says cannot be trusted to mean "fine". The likely shape is optimistic: hold only when the path is unsatisfied or a stall overlay is already up, otherwise send and let the turn's own retries report. This needs settling before the held queue is built, because it decides whether "held" is a state a prompt enters at submit or one it can fall back into.
- **What happens to a prompt whose turn exhausts its retries?** claude's SDK gives up after `max_retries` (default 10). By then the user message is already in claude's transcript, so automatically re-sending it risks a duplicate turn. Either the prompt returns to the composer as a draft, or it returns to "held" and re-sends — and the second needs a way to know the first attempt left no assistant content. Settled by reading what `--resume` does with a user message that has no reply.
- **Does a held prompt survive quit?** Leaning yes — as the card's persisted draft, since a user who closes the laptop on a plane expects the words to be there on landing — but it interacts with the question above and with how `queuedSends` is persisted today.
- **What actually stalled the reported launch?** [F20]. Needs one offline launch captured on the user's machine; this cannot be reproduced from inside a session that itself runs over the network. It gates how much of [B10]–[B12] is cure and how much is only diagnosis.
- **Does the claude CLI service an interrupt while inside its own API retry backoff?** Not determinable from this repo; tugcode's comments assume it does not. It does not change any decision — the ladder handles both answers — but it decides whether the 2 s ack grace is routinely hit offline, and so how often the user sees the recovery path.

---

## Non-goals {#non-goals}

- **Offline AI.** No local model, no cached responses. With no network claude cannot answer, and Tug says so plainly.
- **Making the claude CLI more resilient.** Its retry policy, backoff, and interrupt handling are upstream. Tug bounds its own waits around the CLI and does not reach into it.
- **A softened restore modal.** Adding a Cancel button or a timeout to `TugRestoreGate` was considered and rejected ([B07]): it keeps the construction in which one card's trouble blocks the whole deck.
- **Reachability as the source of truth.** Driving the offline indicator from `NWPathMonitor` or a connectivity probe was rejected ([B13]): it reports airplane wifi as up, and a probe is a poll ([B15]).
- **Refusing prompts while offline.** Rejected by the user in favour of queuing ([B14]).
- **An interrupt priority lane in tugcast.** `dispatch_one` awaits a bounded channel send, so an interrupt can in principle queue behind content frames. No evidence it has ever mattered; left alone unless the audit under [B16] finds otherwise.
- **Fixing the arc press horizon here.** [F24] is named by the audit in [B16] and fixed under its own brief, `briefs/arc-stop-resume-brief.md`.

---

## Exit {#exit}

**An arc.** The work orders itself by how much is already known:

First, the two verified defects, which are small and close two of the three reports: the deck handles `turn_cancelled` and clears `interruptInFlight` on every terminal transition ([B02], [B03]); tugcode answers every interrupt ([B04]); the deck caps the replay bracket and narrows the silence timer's re-arm ([B08]). Each is provable with the injectable `TimerSource` and a wedged-claude fixture — and the interrupt fix wants a test that drives the real kill ladder, since the healthy path is exactly what hid the bug.

Then the two constructions that change what the user sees: the interrupt deadline and Force Stop ([B05], [B06]), and the removal of the app-wide restore modal in favour of a per-card state ([B07], [B09]).

Then launch ([B10]–[B12]), beginning with writing the launch laps to `tugapp.log` and capturing one offline launch, so the rest is aimed at the real cause rather than the likeliest one.

Then the ambient state and the held queue ([B13], [B14]), which depend on the first two open questions being answered.

Last, the law and its audit ([B16]) — last because the arc's own fixes are the law's worked examples.
