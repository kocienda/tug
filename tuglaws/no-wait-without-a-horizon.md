# No Wait Without a Horizon

*The long form of [L33]. Every wait on another process carries a deadline, a named terminal state, and a user exit; and no app-wide modal depends on anything outside the deck. What follows is worked examples rather than exhortation — each one names a defect shape Tug actually shipped, the code it lived in, and the horizon that closed it.*

## The reviewer's test

> *If the thing you are waiting on never answers, what does the user see, and what can they do?*

If the answer is "a spinner, and nothing", the wait fails. That is the whole of the law at the bar of review, and it is deliberately asked about the **user's** experience rather than the code's: a wait can be correct in every line and still produce a window nobody can use, because the correctness of a wait is a property of what it degrades into.

Three things make an answer pass.

- **A deadline.** The wait ends whether or not the answer comes, and it is event-armed rather than polled: the event that starts the wait arms the timer, the event that ends the wait cancels it, and nothing asks at an interval.
- **A named terminal state.** The end says *which* wait failed. "Stop unanswered" and "Restore stalled" are different states with different exits; both rendered as a stopped spinner, they are the same unreadable non-event, and a report about either arrives with nothing in it.
- **A user exit.** Something to press. Force Stop, Retry, Show Log, a composer that still takes text. A named failure with no affordance is a wall with a label on it.

Two of the three is not compliance. The three defects that opened this document's arc each had exactly one of the three, and each read to the user as the app having died.

## Why it is a law and not a habit

Three independent reports arrived from one flight with bad wifi — a Stop that did nothing behind a dead stop button, a restore that hung forever behind an app-wide modal, and an app that would not start. A fourth of the same shape was already written up in `briefs/arc-stop-resume-brief.md`. None of the four was a wait on the network: the deck talks to tugcast over loopback and that link is healthy at 35,000 feet. In every case Tug was waiting on **itself**, and the bad network only supplied the conditions that exposed a wait nobody had bounded.

That is the generalization worth having. A wait with no horizon is not a rare failure that a better network hides; it is a defect that is invisible until something is slow, and then it is the only thing the user can see.

## The worked examples

### A receipt with no consumer

**Shape.** One side emits a terminal frame; the other side drops it at a guard it never learned about; the wait it was supposed to end runs forever.

tugcode's interrupt-escalation ladder force-terminates a wedged claude and writes `turn_cancelled` to say so. The deck did not carry that type in `KNOWN_CODE_OUTPUT_TYPES`, so the frame was discarded at the wire guard and the only clearer of `interruptInFlight` was `turn_complete` — which, for a claude that had just been killed, was never coming. The ladder worked perfectly and the card froze anyway.

**The horizon.** `handleTurnCancelled` in `tugdeck/src/lib/code-session-store/reducer.ts` commits the in-flight turn as interrupted through the same `buildTurnEntry` path a normal end takes. A recovery cancel — one the user did not ask for — renders quietly rather than claiming they stopped something.

**The rule it yields.** A frame type added on one side of a wire is not shipped until the other side has a handler. A receipt whose only consumer is a `default:` branch is not a receipt.

### A flag with one clearer

**Shape.** A state flag is set on one path and cleared on one other, and the code has six ways to reach a terminal state.

`interruptInFlight` was cleared at `turn_complete` and nowhere else, so any of the several routes into `phase: "errored"` left it set — a card reading "Interrupting" with no frame in the world able to end it.

**The horizon.** `enterErrored` in the same reducer is now the one sanctioned way to enter that phase, and it returns the whole terminal slice: phase, wake bracket, the interrupt flags, the open interrupt segment. All six handlers route through it. `reducer.terminal-clears-interrupt.test.ts` is exhaustive by construction — a `Record` keyed on the closed union of `lastError` causes, so a new terminal cause without a row stops the file compiling.

**The rule it yields.** A flag with more than one way in needs one chokepoint out, and the chokepoint is typed so a new way in cannot forget it.

### An inbound verb that can return without emitting

**Shape.** A handler takes a request, finds it has nothing to act on, logs, and returns. The caller is still waiting.

tugcode's `handleInterrupt` had two such paths: no claude process, and a live claude with no turn open.

**The horizon.** `InterruptNoop` in `tugcode/src/types.ts`, written through one private `emitInterruptNoop` in `tugcode/src/session.ts`, carrying which of the two it was. The deck clears its per-interrupt flags on it and deliberately touches neither the phase nor the transcript, because by construction there was no turn to end.

**The rule it yields.** Every inbound verb answers. "Nothing to do" is an answer and has to be sent; a log line is a note to the developer, not a reply to the user.

### A deadline anything can reset

**Shape.** The wait has a horizon, but the horizon is a silence timer that any traffic re-arms — so traffic that is not progress buys unlimited time.

The restore bracket's only deadline was re-armed by every wire frame, including the `api_retry` chatter of a claude retrying an API it could not reach. The bracket therefore never expired. This is the verified mechanism of the reported restore hang, and it is the subtlest shape on this list: the code contained a deadline, and the deadline was worthless.

**The horizon.** Two, where there was one. `replaySilenceEffect` re-arms only for a frame in `BRACKET_FRAME_TYPES`, so retry chatter no longer holds the silence deadline open; and `REPLAY_BRACKET_DEADLINE_MS` caps the bracket absolutely, armed once on entering `replaying` and never re-armed, ending in `replay_bracket_timeout` — a cause distinct from `replay_stalled`, so a report can tell a bracket that went quiet from one that never finished.

**The rule it yields.** A silence deadline is re-armed by progress, never by traffic, and it is not a substitute for an absolute cap. Ask of every re-arm: *could something that is not progress reach this line?*

### An app-wide modal whose close depends on the wire

**Shape.** One component's wait is staged as a surface covering the whole window, and the thing that lifts it is a frame from another process.

`TugRestoreGate` mounted over the entire deck while any card replayed, reading "Restoring 1 session — 10 of 10 turns", and lifted on the bracket closing. With the bracket unbounded (above), the whole application was unusable — every other card, every non-session card, and the way out — because one card was quiet.

**The horizon.** The gate, its CSS and its store are deleted. Restoring is a state of one card: `session-card-restore-gate.ts` reads it per card, and a stalled restore lands its named state on that card's own pane banner while every other card stays fully live. The app-test that covers it drives three panes — one replaying and silent, one taking real clicks and keystrokes and a submit, one a gallery input — and asserts zero app-modals in the DOM.

**The rule it yields.** This is [L33]'s second clause and it is the one that generalizes furthest. A wait is staged at the granularity of the thing that is waiting. A softened modal — one with a Cancel button, or a timeout — was considered and rejected: it keeps the construction in which one card's trouble is everybody's.

### An unbounded `await` on another process's bookkeeping

**Shape.** `await someInternalPromise` with no race, on the path a user gesture takes.

tugcode's `handleUserMessage` awaited a cold-boot readiness gate and a respawn loop, both bare. A submit that arrived while either was wedged simply never came back.

**The horizon.** Both are raced against `SEND_HORIZON_MS` in `tugcode/src/session.ts`, emitting `send_ready_timeout` or `send_respawn_timeout` and returning without touching the claude process. The respawn loop takes one deadline for the whole loop rather than one per iteration — a gate that clears and is immediately replaced would otherwise buy a fresh horizon every pass, which is the same defect as the re-armed silence timer wearing a different hat.

**The rule it yields.** Bound the promises you own and can see the state of. It is deliberately *not* a licence to bound the far side's silence: an earlier spawn watchdog that treated claude's quiet as failure killed healthy sessions, and its removal stands.

### A spinner with one exit

**Shape.** A launch screen whose only transition is success.

The splash cleared when the WebView revealed, and had no other ending. A launch that stalled anywhere — resolving PATH, starting tugcast, loading the interface — showed a spinner forever, with nothing named and nothing to press.

**The horizon.** `splashDeadlineMs` in `tugapp/Sources/MainWindow.swift`, armed when the splash mounts and cancelled in the reveal — no polling of `isHidden`. On expiry, and immediately on a navigation failure or a tugcast past its respawn threshold, `mountLaunchFailure` swaps the spinner for a screen naming the stalled stage, with **Retry** and **Show Log**. The WebView is untouched, so a late page still reveals over the top; Retry re-runs the stage and re-arms the deadline, so a second stall produces the screen again.

**The rule it yields.** All three parts, visible at once: the deadline, the stage's name, and two things to press. It is also why the launch laps go to `tugapp.log` — the next report of this kind arrives carrying its own evidence.

### A blocking subprocess on a latency path

**Shape.** `waitUntilExit()` on a child whose runtime is somebody else's rc files.

Resolving the login shell's PATH ran `/usr/bin/dscl` and then the user's shell to completion. A shell that blocks — a slow directory server, an rc file that waits on a network mount — blocked the launch behind it with no bound at all.

**The horizon.** `tugapp/Sources/ShellPathResolver.swift` replaces the blocking wait with a termination handler signalling a semaphore the caller waits on with a deadline, terminating the child on expiry; each subprocess gets its own `shellPathResolveTimeoutMs`, so a wedged directory server cannot spend the shell's budget. On expiry the caller falls back to the cached PATH, then the inherited one, then a hardcoded default — and the resolver takes its warn sink as an argument, so there is no way to fall back silently. A PATH that came from a fallback is never cached, because the fast path trusts a present cache and would otherwise make every later launch believe an answer the shell never gave.

**The rule it yields.** A fallback is part of the horizon, and a silent fallback is half a defect: the wait ended, and nobody can tell that it did.

### A required modal whose actions need the thing that is missing

**Shape.** A setup surface holds the app until a question is answered, and every way to answer it requires the network.

`ConfigureTug` read an unanswered auth probe as "signed out" and held the whole app behind a sign-in button that could not possibly work offline.

**The horizon.** The derivations moved into `configure-tug-copy.ts` where they are pure and pinned. `deriveProbingHold` bounds the first-run hold at `CONFIGURE_TUG_PROBE_DEADLINE_MS`, past the probe's own deadline, and treats a failed probe as an answer rather than as silence. `deriveConfigureTugRequired` lets go of the app when the wizard cannot make its claim. And `deriveFirstRunComplete` gates the `setup-seen` write on a definite signed-in reading rather than on the wizard no longer being required — dropping the requirement is how the offline case gets out of the way, and writing `setup-seen` on it would permanently retire a first run the user never completed. The login row says what Tug does not know instead of claiming the user is signed out, and keeps its button, because that button is the only retry.

**The rule it yields.** Relaxing a hold and recording the hold as satisfied are different acts. A surface that steps aside must not also write down that it succeeded.

### A state with no name (the ambient case)

**Shape.** The wait has a deadline and an exit, and no vocabulary — so a card that is waiting on a network looks exactly like a card that is thinking hard.

**The horizon.** A `stalled` lifecycle overlay raised from claude's own retry announcements, classified on a machine-readable `category` rather than on display copy, with stream silence past `STREAM_SILENCE_STALL_MS` as its second arm. The strip reads "Waiting for network", with the retry count when claude supplied one. Stop stays live throughout — a disabled stop button over work that will not end is the defect the whole arc began from — and the absence of any submit-mode change is pinned by a table in the lifecycle tests. A prompt submitted into that state is held rather than refused, on the queue that already survives quit, released by a proving event and never by a probe.

**The rule it yields.** Naming the state is not decoration; it is the difference between a report that says "it hung" and one that says which wait failed. And a named bad state does not remove affordances — it explains them.

## Findings

The audit [L33] prescribes was run over the deck's stores and their `await`s, tugcast's press and wait paths, and tugcode's inbound verbs. What follows is what remains open. Each names the brief that owns it; none is fixed here, and a finding recorded against a brief is worth more than a sweep that changes files nobody asked to have changed.

### Closed while this was being written — `arcPressStore`

`briefs/arc-stop-resume-brief.md`'s [F17] recorded that the arc-transport press had no horizon: `tugdeck/src/lib/arc-press-store.ts` released a pending press only on an `_ok` or `_err` frame, so a frame nobody answered left a permanently greyed control, and a refusal carrying no session id was dropped rather than spoken.

Both halves are closed, by that brief's own arc rather than by this one. `PRESS_HORIZON_MS` (45 s — the server's stop ceiling plus margin, so a healthy slow stop is never called dead) releases the press and speaks "no answer"; `refuse` falls back to the card the press was made from, which is why `press` carries that id at all. It is recorded here because the law's first audit should show its worked-through case, and because the division of labour is the point: the finding was written up under the law and fixed under the brief that owned the surface.

### Open — tugcode's inbound dispatch, two shapes

An inventory of every inbound verb that can return without emitting was banked in this arc's own documents rather than in `tuglaws/`, since it is a work list rather than doctrine. Two shapes, neither closed:

- **The registry's optional chain.** Thirteen verbs in `tugcode/src/inbound-dispatch.ts` are written `sessionManager?.handleX(...)`, so a frame arriving before session init does nothing and says nothing. The window is narrow, and the fix is one guard in `dispatchInbound` rather than thirteen — the cheapest item on the list.
- **The per-handler no-process bail.** In `tugcode/src/session.ts`, `handleToolApproval` and `handleQuestionAnswer` each have two paths that log and return with nothing on the wire, leaving an approval or question dialog open with no frame able to close it. That is the worst outcome in the inventory: a card the user cannot use. `handleStopTask` leaves a job row showing a job the user asked to stop. `handleSideQuestion` is the pattern to copy — its bail already emits a synthetic answer.

These belong to a brief about tugcode's inbound contract, which does not exist yet. Until one does, the inventory is the record.

### Open — deck stores that wait on a host or supervisor reply with no deadline

Each of these parks a `resolve` in a pending map and hands the promise to a caller; nothing releases it if the answer never comes.

- `tugdeck/src/lib/native-path-picker.ts` (`pickPath`) and `tugdeck/src/lib/os-export.ts` (`exportSession`) wait on a host panel. The host answers when the panel closes, so the exposure is a dropped message rather than a slow user — but the failure mode is a save or export flow that never returns and never says why.
- `tugdeck/src/lib/maker-mode-bridge.ts` (`getSettings`) pushes its resolver onto an array with no key and no bound.
- `tugdeck/src/lib/session-ledger-store.ts` (`trashSession`) resolves only on the matching ok/err frame.

None of these is this arc's: this arc bounded the waits the three reports named. They want a brief of their own — the shape is one helper, since every one of them is the same pending-map-plus-deadline pattern the bounded stores in the same directory already implement.

`tugdeck/src/lib/session-state-changes-reader.ts` is deliberately *not* on this list. It waits without a deadline and says so in its own docstring, with the argument: the supervisor answers every well-formed request and the bus is process-local, so a caller wanting a deadline can race the promise itself. That is an argued exemption rather than an oversight, which is the form [L33] asks a deliberate unbounded wait to take.

### Open — `claude auth login` is awaited with no bound

`tugrust/crates/tugcast/src/feeds/claude_auth.rs`'s `login()` awaits the `claude auth login` child to completion. The CLI blocks on its own localhost OAuth callback, so the child exiting is genuinely the completion signal — but a user who abandons the browser leaves a child that may never exit. The user-visible horizon exists and is on the deck side (`SIGN_IN_TIMEOUT_MS` in `configure-tug.tsx`), which satisfies the law's test; what remains is the orphaned child on the host, which is a tidiness question for whichever brief next touches auth.

### Open — the relaunch fallback wait

`tugrust/crates/tugcast/src/control.rs` waits on the relaunch child unbounded on the path where no progress socket connected. It is a developer path, the least severe thing found, and it is recorded so the next reader does not have to find it twice.

## Related

- [L31] — a user gesture produces either the act or a visible reason. The gesture-shaped half of the same concern; [L33] is about the waiting that follows one.
- [L32] — a mechanism that decides visibility fails toward visible. Its deferred-reveal clause is [L33] applied to appearance.
- [L23] — internal operations never destroy user-visible state. What the held-prompt queue rests on.
