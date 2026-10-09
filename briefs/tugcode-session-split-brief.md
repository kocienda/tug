<!-- brief-skeleton v1 -->

# Split tugcode's `session.ts` by concern, inject the spawner, and name the process lifecycle

**Purpose:** `tugcode/src/session.ts` is 9.5k lines holding spawn configuration, JSONL journal reading, stream-json event mapping, the per-turn state machine, process lifecycle, replay, and rewind in one file and mostly one class. Its test file reaches into privates 223 times because there is no injectable spawner, and the process lifecycle is nine booleans rather than one state.

---

## Purpose {#purpose}

Item 29 of `briefs/audit-punch-list.md`:

> 29. Split `session.ts` by concern, inject the spawner, and replace the eight mode booleans with one phase enum. The 223 private pokes in its test file are the measure of the current coupling.

Behaviour is held fixed. The stream-json protocol, the IPC frames, and the lifecycle decisions do not change; what changes is where the code lives and how tests reach it.

---

## Evidence {#evidence}

**[F01] Seven concerns, already in contiguous ranges** — by reading the top-level declarations: binary and plugin resolution plus arg and env building (98–160, 211–256, 971–1190); JSONL journal reading, truncation, and subagent transcripts (344–970); stream-json to IPC mapping (`routeTopLevelEvent` 1646–2381, `mapStreamEvent` 2465–2703, and the `build*Message` helpers between 1277 and 1570); `ActiveTurn` (2900–3478); `SessionManager` (3479 to end of file) containing process lifecycle (`spawnClaude` 4178, `killAndCleanup` 4263, `forceTerminateAndRespawn` 4433, `startStderrReader` 5195, `runStdoutDrain` 6463), replay (`runReplay` 5515–6243, `cancelReplay` 5424), and rewind (`handleSessionRewind` 8594, `applyConversationRewind` 8720). **(verified)**

**[F02] `SessionManager` is 100 methods and 59 fields** — nine of the fields are booleans describing the process: `claudeStdoutEofObserved`, `eofReattachAttempted`, `claudeReceivedInput`, `isShuttingDown`, `replayActive`, `isInWake`, `sessionInitSeen`, `initializeHandshakeAcked`, `forceTerminateInProgress`. **(verified)**

**[F03] Tests reach around the class** — `src/__tests__/session.test.ts` is 5,196 lines with 223 `as any` or `as unknown as` casts; nine of them replace `spawnClaude` on an instance to feed a fake child. The `ClaudeSubprocess` type (line 3470) is the shape they fake. There is no constructor parameter for the spawner. **(verified)**

**[F04] Twelve timer sites in the file** — `setTimeout`/`setInterval`, each hand-cleared on its own path. **(verified by grep)**

**[F05] Pure code dominates the first 2,900 lines** — the journal functions, the event mapping, and the message builders take data and return data; `ActiveTurn` is a self-contained class. None of them needs the manager to be tested, and several already are, through `replay.test.ts` and `context-breakdown.test.ts`. **(verified by reading signatures)**

---

## Decisions {#decisions}

**[B01] Seven modules, extracted in the order of least coupling: `spawn-config.ts`, `journal.ts`, `event-mapping.ts`, `active-turn.ts`, then `claude-process.ts`, `replay-runner.ts`, `rewind.ts`.** The first four are moves of pure code and exported classes; `session.ts` re-exports them so no importer changes. The last three are extracted from `SessionManager` as collaborators it constructs: `ClaudeProcess` owns spawn, the kill ladder, the stderr reader, the stdout drain, and respawn; `ReplayRunner` owns `runReplay` and `cancelReplay`; `Rewind` owns the rewind and retraction verbs. The manager keeps message identity, the active-turn handoff, and the inbound dispatch.

**[B02] The spawner is a constructor option.** `SessionManager` takes `spawner?: (args: string[], env: Record<string, string>) => ClaudeSubprocess`, defaulting to the real `Bun.spawn` wrapper. Every test that today assigns `(manager as any).spawnClaude` passes the fake through the option instead, and the count of private pokes in `session.test.ts` is the arc's gauge: it goes down every step and the spawner-related ones reach zero.

**[B03] The process lifecycle becomes one `phase` field on `ClaudeProcess`, and only the flags that describe the process join it.** `spawning`, `handshaking`, `running`, `draining`, `terminating`, `dead` replace `sessionInitSeen`, `initializeHandshakeAcked`, `claudeStdoutEofObserved`, `isShuttingDown`, `forceTerminateInProgress`, and `claudeReceivedInput`. `replayActive` and `isInWake` are modes orthogonal to the process and stay booleans on the manager; `eofReattachAttempted` is a one-shot latch and stays. Every transition goes through one `setPhase(next)` that logs through `logSessionLifecycle`, which is how the arc proves the enum tells the same story the booleans did.

**[B04] Timers live in one `TimerSet` on the manager, cleared in `killAndCleanup`.** Twelve hand-cleared timers are twelve chances to leak one across a respawn; a set with `clearAll()` makes the cleanup a single line the kill path cannot forget.

**[B05] `session.test.ts` is split along the same module boundaries, in the same steps.** Each extracted module gets its tests from the monolith, and the monolith shrinks with the source. A step that moves code and leaves its tests is not done.

**[B06] Order: the four pure modules first, then the spawner injection, then the three collaborators, then the phase enum.** Pure moves prove the layout; the spawner injection is what makes the collaborator extraction testable without private pokes; the phase enum is last because it is the one step that rewrites logic rather than moving it, and it should land on the smallest `ClaudeProcess` the earlier steps can produce.

---

## Open Questions {#open-questions}

- Whether `replayActive` and `isInWake` can ever both be true. If reading the code during the collaborator step shows they cannot, they become a second small enum on the manager; if they can, they stay as decided in [B03]. Either answer is recorded in the arc's log, not guessed here.

---

## Non-goals {#non-goals}

- **Typing the stream-json wire.** Item 16; the event-mapping module moves with its `Record<string, unknown>` casts intact.
- **Moving outbound frame types into `tugproto`.** Item 14.
- **The capped line splitter and stdin backpressure.** Its own brief (`tugcode-line-splitter-brief.md`); if that arc lands first, the splitter moves into `claude-process.ts` with the readers, and if it lands after, it finds them there.
- **Any change to the kill ladder, the quiesce budget, or the respawn backoff.** The audit read them as sound.

---

## Exit {#exit}

An arc. Steps as ordered in [B06]: four pure-module extractions with their tests; the spawner option with the nine test sites converted; `ClaudeProcess`, `ReplayRunner`, and `Rewind` extracted one per step with their tests; the `TimerSet`; and last the phase enum with a transition-log test that replays the existing lifecycle fixtures and asserts the same sequence of `logSessionLifecycle` events. `bun test` in `tugcode/` is each step's verdict; the `@covers`-derived app-test selection for `tugcode/` runs once after the last step.
