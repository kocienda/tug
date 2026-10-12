<!-- brief-skeleton v1 -->

# The ingest Worker's failure story

**Purpose:** The deck now waits on a Worker for every frame of every session, and the Worker has no failure story. A Worker that fails to load or throws leaves a deck with no banner, no reconnect and no fallback; one throwing applier aborts a whole batch and strands every acknowledgement; two settle waits have no deadline; the Worker is never released. This brief closes those holes and the fold cost found beside them.

Fixup to stage 3 of `briefs/main-thread-headroom-program-brief.md` (`briefs/ingest-worker-brief.md`, landed as `9714b6f37`).

---

## Purpose {#purpose}

The 2026-10-12 audit of the five headroom stages found the ingest Worker to be a sound data path with no failure story. The user, on the audit: "Please write a brief (or briefs) to plug all these holes." This is the one for the Worker.

The laws it answers to: [L27] (every acquisition returns its release), [L31] (a gesture produces the act or a visible reason, never silence), [L33] (no wait without a horizon: a deadline, a named terminal state, a user exit).

---

## Evidence {#evidence}

**[F01] A Worker that fails is silent.** `WorkerIngestChannel` (`tugdeck/src/lib/ingest/ingest-channel.ts:103-123`) sets `onmessage` and nothing else: no `onerror`, no `onmessageerror`. `TugConnection` starts with `socketOpen = false` and a disconnected state and never notifies it (`tugdeck/src/connection.ts:265-271`); the banner shows only on a callback (`tug-banner-bridge.tsx:47`). If the module Worker fails to load, or `host.handle()` throws uncaught in `scope.onmessage` (`tugdeck/src/lib/workers/ingest-worker.ts:133-140`; `requireSocket()` at `ingest-host.ts:337` throws on a `send` before `init`), the page hears nothing, every `trySend` is dropped at debug level, and every session card stays in whatever transport state it last had. No fallback to the in-process host exists in production (`connection.ts:340-342` chooses by option only). **(verified, read from the code)**

**[F02] One throwing applier aborts the batch and strands every acknowledgement.** `applySessionBatch` (`tugdeck/src/lib/ingest/session-patch.ts:118-131`) runs its patches under one `try/finally`; `PropertyStore.set` (`tugdeck/src/lib/property-store.ts:262-264`) does not isolate listeners. A throw in any observer escapes, and the later patches for other sessions, the `frame` patches and the `ack` are lost, so `_ackedSeq` never advances and `whenSettled()` hangs. **(verified, read from the code)**

**[F03] Two of three settle waits have no horizon.** `whenSettled()` (`tugdeck/src/lib/code-session-store.ts:1917-1922`) resolves on ack or dispose only. `teardown.ts:258-264` wraps it in `TERMINATION_INTERRUPT_AWAIT_MS`. `card-services-store.ts:442-443` (the held-swap hand-over) and `:869-872` (stash then dispose) await it bare; on a dead Worker the hand-over never completes, the old store is never disposed, and the queued sends are lost. **(verified, read from the code)**

**[F04] The Worker is never released.** `TugConnection` has no `dispose()`; `close()` posts `close` but never calls `channel.dispose()` (`connection.ts:761-773`), and `close()` calls `ensureChannel()`, which would spawn a Worker to close it. `teardown.ts` never touches the connection. [L27]. **(verified, read from the code)**

**[F05] Worker-side errors never reach the page's dev log.** Five `console.error` sites in `ingest-host.ts` (`:298`, `:496`, `:517`, `:536`, `:551`) log inside the Worker. `dev-log-port.ts` exists to carry exactly these to the page's dev log and session lifecycle log, and is not used there. **(verified, read from the code)**

**[F06] Replay folding is quadratic in the turn being built.** `mergeStructure` (`ingest-host.ts:718-723`) concatenates per-event splices, and each folded event's splice carries a fresh copy of the growing current turn (`session-engine.ts:1110-1135`). A 250-event fold over a turn of k messages clones O(250·k) message objects across the thread boundary and runs 250 splices on the page. **(verified, read from the code; not measured)**

**[F07] Wire state is held with the wire during a motion hold.** `wire-state` and `disconnect-state` are in `IMMEDIATE_KINDS`, but `note()` is suppressed while held (`ingest-host.ts:646-649`), so the page's `socketOpen` mirror and the banner lag up to the cap (`MIN_HOLD_CAP_MS = 1000`, `:98`), and sends posted in that window are dropped in the Worker with a debug line. **(verified, read from the code)**

**[F08] Small residue.** The link object is built twice (`connection.ts:686-716` against `session-link.ts:96-142`). `IngestInitControl.motionEnabled` is posted (`connection.ts:350`) and never read (`ingest-host.ts:227-229`). `flushSubscription(force)` is always `false`. Comments at `ingest-host.ts:33` and `ingest-channel.ts:61` still say "until the engines move to the Worker". `openInProcessSession` is reachable from production options when a `timerSource` is passed (`connection.ts:682-683`). Page-side guards (`code-session-store.ts:1732-1736`, `:1357`, `:1383`, `:1408`) read a mirror one hop stale, so Escape within a frame of Enter interrupts rather than cancels the queued send. **(verified, read from the code)**

**[F09] The tests cover the happy path.** `real-worker.test.ts` is genuinely cross-thread and covers handshake, split frames, routing, decode guards, the cap and a hold. Nothing tests Worker load failure, an uncaught throw, reconnect during a hold, a slow page (the Worker's `postMessage` queue is unbounded), a `send` before `init`, or a throwing mirror applier. **(verified, read from the tests)**

---

## Decisions {#decisions}

**[B01] A dead Worker is a named, visible, recoverable state.** `WorkerIngestChannel` installs `onerror` and `onmessageerror`; either, and an uncaught throw in the Worker's `onmessage`, becomes a `wire-state closed` with a distinct disconnect reason ("ingest worker failed"), so the banner the deck already has shows it in words. `TugConnection` notifies its initial disconnected state at construction so a Worker that never answers is a visible disconnect rather than a quiet one. Recovery is the in-process host: `InProcessIngestChannel` already exists and runs the same `IngestHost`, so on Worker failure the connection rebuilds its channel in-process once and reconnects. That is the [L33] deadline, named state and user exit (the banner's reconnect) in one mechanism, and it is read on the page: a dev-log line and a session-lifecycle event name the fall-back.

**[B02] A batch applies every patch it can, and the acknowledgement always lands.** `applySessionBatch` catches per patch, reports through the dev log, and continues; `PropertyStore.set` adopts the `notifyCatching` shape the store base already has. A patch that throws is one row's defect, never another session's lost frame or a stranded `whenSettled()`.

**[B03] Every settle wait carries the teardown's budget.** `whenSettled()` gains a bounded form, and the hand-over and the stash race it against the same budget `teardown.ts` uses; on timeout they proceed on the mirror as it stands and log that they did. A wait that cannot end is the shape [L33] forbids, and the fix is at the two callers, not a longer hang.

**[B04] The connection owns and releases its Worker.** `TugConnection.dispose()` releases the gate observer and the visibility listener, posts `close`, terminates the channel and nulls it; `close()` never creates a channel; `teardown.ts` calls `dispose()`. [L27].

**[B05] The Worker logs through the port it was given.** Every `console.error` in `ingest-host.ts` and `session-engine.ts` goes through `dev-log-port`, so an engine throw on a wire frame is visible to the person debugging the page.

**[B06] A fold is one diff at flush.** While folded, the engine does not post per event; at flush it diffs once against the posted baseline (`_postedState`, `_postedTranscript`), so a replay costs the page one structure patch per flush of size proportional to what changed, and the clone across the boundary is linear in the turn rather than quadratic. `replay-fold.test.ts` gains the assertion on patch count and on the cloned message count.

**[B07] Wire state bypasses the motion hold.** `wire-state` and `disconnect-state` are page state, not pixels: they post through a hold, so the banner never lags the socket. Sends posted while the socket is closed are queued or refused with a reason, never dropped at debug level.

**[B08] The residue goes.** One `makeLink`; the dead `motionEnabled` field and the always-false `force` parameter removed; the two stale comments corrected; the in-process path unreachable from production options; the hop-stale guards moved into the reducer so the engine decides (post `pop_interactive`, as `send()` already does).

**[B09] The tests cover the failure story.** Cross-thread tests for Worker load failure and uncaught throw (fall-back observed on the page), reconnect during a hold, a throwing mirror applier (ack still lands), a `send` before `init`, and a slow page under sustained batches (queue bounded or observed). The worker import fence becomes an allow-list of Worker-safe roots with a per-statement import regex, and sees dynamic `import()`.

---

## Open Questions {#open-questions}

- **Should the in-process fall-back be permanent for the session, or retried as a Worker on the next reconnect?** Permanent is simpler and the failure is rare; the arc decides and the dev-log line says which happened.
- **What bounds the Worker's `postMessage` queue when the page is slow?** Either the Worker observes the page's acknowledgement of the last batch before posting the next, or the queue depth is a reading the test asserts. The arc measures a slow page first.

---

## Non-goals {#non-goals}

- **Changing the patch protocol or the batch cadence.** Both are sound and are stage 5's substrate.
- **Moving React or rendering into the Worker.**
- **A second Worker, or a SharedWorker.** One deck is one page.

---

## Exit {#exit}

**An arc.** The shape: the failure path first ([B01], [B02], [B03], [B04]) with its tests, since those are the holes a reviewer blocks on; then the port ([B05]) and the fold diff ([B06]); then the hold bypass ([B07]) and the residue ([B08]); the fence and the remaining tests ([B09]) last. Read with the ingest unit suites and `at0725`, `at0726` unchanged, and one hand-run on the user's deck of killing the Worker (through the eval door) to see the banner name it and the deck recover.
