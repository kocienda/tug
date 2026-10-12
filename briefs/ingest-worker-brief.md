<!-- brief-skeleton v1 -->

# The ingest Worker: the wire, the reducer, the pacing and the hold leave the main thread

**Purpose:** Every WebSocket frame lands on the main thread, is decoded there, reduced there, and fanned out there to four or more stores per session card. This stage moves the socket, the framing, the decode, the pure reducer and the publish cadence into a Worker, so the main thread receives one frame-paced batch of view-model patches per frame and nothing at all while a motion is in flight.

Stage 3 of `briefs/main-thread-headroom-program-brief.md`; builds on stage 2's structural-versus-streaming split.

---

## Purpose {#purpose}

The user, 2026-10-11: "The clear imperative seems to be: *work must move off the main thread*." This is the first stage that does so for the stream itself. It establishes the shape the program's end state needs, the page as a view process that receives patches, and it moves the motion hold out of the page's event loop, where no `flushSync` can reach it.

---

## Evidence {#evidence}

**[F01] The socket, the framing and the decode are on the main thread.** `tugdeck/src/connection.ts:351` opens the WebSocket with `binaryType = "arraybuffer"`; `absorbBytes` (`:882`) and `drainFrames` (`:908`) peel length-prefixed frames with two `slice` copies per frame (`:935`), re-copying the remaining buffer for each frame in a batched message; `dispatch` (`:952`) calls every callback registered for the feed synchronously. `defaultDecode` in `lib/feed-store.ts:78` runs `TextDecoder` and `JSON.parse`, shared across stores by a `WeakMap` cache (`:52`). **(verified, read from the code)**

**[F02] Each session card registers at least four CODE_OUTPUT consumers.** A `CodeSessionStore` has FeedStores over CODE_OUTPUT, SESSION_STATE and CONTROL (`code-session-store.ts:623`), filtered by `tug_session_id` (`:2010`); `card-services-store.ts:601` adds three more over CODE_OUTPUT for skills, hooks and side-question; `use-card-feed-store.ts:46` adds one more filtered on `workspace_key`. With N cards, every CODE_OUTPUT frame runs through at least 4N callbacks, each paying a filter on the cached decode. **(verified, read from the code)**

**[F03] The reducer is pure.** `tugdeck/src/lib/code-session-store/reducer.ts` is about 8,000 lines with no DOM reference; `reduce()` takes state and event and returns state and effects (`code-session-store.ts:2480`, `:2807`). It is portable to a Worker as it stands. **(verified, read from the code)**

**[F04] The sparkline already runs on a Worker with an OffscreenCanvas.** `tug-sparkline.tsx:120` and `lib/workers/sparkline-render-worker.ts`, plus `lib/workers/image-downsample-worker.ts` and pdf.js. The Vite worker build and the Worker lifecycle pattern exist in this codebase. **(verified, read from the code)**

**[F05] The WebSocket API is available inside a Worker.** Dedicated Workers may open a WebSocket, and `ArrayBuffer`s transfer between threads without copying. **(standard platform behaviour; to be confirmed on the shipped WebKit by the arc's first spike)**

**[F06] The motion hold lives in the page's event loop and is pierced from inside it.** Stage 1 [F02] and [B03]: the hold is a set of callbacks in `gesture-scope.ts`, and any `flushSync` on the main thread can drain it. A hold that lives in another thread, where the frames are buffered before they are posted, cannot be drained by anything the page does. **(verified for the mechanism)**

**[F07] Stage 2 made the stream a `PropertyStore` write and the structure a snapshot.** Under stage 2 [B01], the main thread needs two things from the Worker per session: a streaming text write per frame and a structural patch when structure changes. That is a small, nameable protocol. **(a dependency on stage 2 landing as decided)**

**[F08] 63 selector subscriptions read the session store on the main thread.** Stage 2 [F02]. Whatever the Worker emits, the main-thread store's read API must stay stable for them, or the stage touches 23 files it has no reason to touch. **(verified, read from the code)**

---

## Decisions {#decisions}

**[B01] One Worker owns the socket, the framing, the decode, the reducer and the publish cadence.** It opens the WebSocket to tugcast, peels frames once without re-copying the tail, decodes once, routes to a per-session reducer by `tug_session_id`, and holds the authoritative session state. The main thread holds a mirror.

**[B02] The Worker posts one batch per display frame, covering every session.** It coalesces on its own clock to the display period and posts one message carrying every session's streaming text writes and any structural patches since the last post. The main thread applies the batch in one task: `PropertyStore` writes for text, snapshot replacement for structure. N streaming sessions cost the main thread one task per frame. The Worker's clock is a finisher in [D7]'s sense: armed by a frame arriving, stopped when none is pending.

**[B03] The motion hold moves to the Worker.** The main thread posts `motion-open` when the settle engine closes the gate and `motion-closed` when it releases, and the Worker buffers batches between them. The buffer carries the gate's existing cap (`settle-plan.ts` `holdCapMs`) so a page whose frames are suspended still gets its data ([L23], [L32]). The page-side gate in `gesture-scope.ts` stays for local actions and observer deliveries; what leaves it is the wire. Nothing on the main thread can drain a buffer it does not hold.

**[B04] The main-thread store keeps its read API.** `CodeSessionStore.getSnapshot`, `subscribe` and the `PropertyStore` paths read exactly as today; what changes is that they are fed by the Worker's batches instead of by a local reducer. [F08] is why: the 63 readers and the react-door lint do not move. Local actions that today reduce synchronously (a user's own send, a rewind) post to the Worker and are reflected in the next batch; where a local action needs an immediate echo for responsiveness, the main thread applies an optimistic write the batch confirms.

**Resolved in implementation, under [B04].** Three facts cross with the action or the patch rather than being read back across the boundary: a load-previous names its target turns on its `begin_load_previous` event; a `run_progress` report carries whether its call is a running background job, which the engine reads from its own jobs ledger; and a replayed message's image bytes travel as an `atom-bytes` effect for the card's bytes store, whose thumbnails the page bakes. A dropped `File` reaches the engine as a structured clone, so the mirror keeps the objects the drop produced and the slot the prompt entry reads carries those.

**[B05] The 4N fan-out collapses to one route per frame.** The Worker routes each CODE_OUTPUT frame once by session and type to the stores that want it, and the per-card skills, hooks and side-question stores receive their frames as part of the session's batch. The `workspace_key`-filtered store ([F02]) is read for whether it ever receives a CODE_OUTPUT frame, and removed if it does not.

**[B06] Replay and restore go through the same path.** A session resume replays its ledger through the Worker's reducer, and the replay fold (`REPLAY_FOLD_FLUSH_THRESHOLD`) becomes the Worker's business; the main thread sees the folded batches. A restored session and a live one are the same protocol.

**Resolved in implementation, under [B06].** The fold defers the notify, not the state, as it always did: a folded event still posts its structure, marked `fold`, which the mirror merges without publishing. A snapshot already read stays pinned until the fold flushes, and one not yet read shows the merged state. Consecutive folded patches merge in the host, so a replay still crosses as one patch per flush. The transcript diff finds an eviction before it compares prefix and suffix, so the cap's steady state — one turn evicted as one is appended — leaves every turn between with its identity ([R01]).

**[B07] The protocol is typed once in tugproto.** The Worker-to-main batch and the main-to-Worker control messages are declared in `tugproto` beside the wire types, with a parity test, in the shape `briefs/protocol-parity-and-outbound-frames-brief.md` set. Stage 5 reuses this protocol for patches that come from tugcast, so it is designed as a patch protocol rather than a Worker detail: a batch is a list of `(session, kind, payload)` patches, and the sender is not named in it.

**[B08] The reading of record is stage 1's streaming arm, before and after.** The numbers this stage moves: main-thread busy time per second with three sessions streaming, from `tugtool deck motion rest` and the `--tasks` recorder; the count of tasks per second on the main thread attributable to ingest; and the sealed clause on every gesture under streaming, which this stage should take to zero commits and zero drains inside the window.

**[B09] The Worker is a correctness-neutral move.** Every reducer unit test runs unchanged against the reducer in its new home. The store's wire-driven tests (`store-base-and-reducer-cap`'s small-capped store, the decode guards from `deck-boundary-decode-guards`) run through the Worker. A behaviour that depended on synchronous reduction in the receiving task is found by those tests and given an explicit path, never a timing assumption.

---

## Open Questions {#open-questions}

- **Does any main-thread reader need the reduced state in the same task the frame arrived?** Error routing and controller recomputes run as non-React listeners today (`tuglaws/animation-doctrine.md` #residency). Under [B02] they run one frame later. The arc reads each non-React listener and names any that cannot wait; the expectation is none.
- **How does the Worker learn the display period?** It has no `requestAnimationFrame`. The main thread posts the period once and on change, or the Worker uses a fixed 16.7 ms and the main thread applies on its next frame. The arc's first spike decides; either is a finisher.
- **Where does the dev-mode deep-freeze live?** `feed-store.ts:64` freezes decoded frames in dev and test builds. Structured-clone across the thread boundary makes the frozen object a copy; the freeze moves to the Worker's output or is dropped as redundant.
- **Shared or dedicated Worker?** One deck is one page, so a dedicated Worker is enough. A SharedWorker buys nothing until there are two documents, which is [B07] of the program brief's escape and not this stage.

---

## Non-goals {#non-goals}

- **Parsing markdown in the Worker.** It needs sanitization, which needs a DOM or a Rust sanitizer; stage 5 settles it. This stage moves the wire and the reducer only.
- **Changing tugcast's wire.** The Worker speaks the protocol tugcast speaks today. Coalescing and backpressure at tugcast are stage 5.
- **Moving React or any rendering into the Worker.** The Worker owns state and cadence; the page owns the DOM.
- **A SharedArrayBuffer or cross-origin isolation.** Structured clone and transferable `ArrayBuffer`s are enough at these sizes, and isolation would change `performance.now()` resolution and the eval door's behaviour for every instrument.

---

## Exit {#exit}

**An arc.** The shape: a spike proving the WebSocket in a Worker against tugcast on the shipped WebKit; the patch protocol in tugproto with its parity test; the reducer moved and its tests running in the Worker; the main-thread store rebuilt as a mirror behind its existing API; the frame-paced batch; the motion hold in the Worker with its cap; the fan-out collapse; replay through the Worker. Each lands with the streaming arm read, and the arc joins with the user's deck read under streaming and written into the program brief's record.
