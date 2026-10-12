<!-- brief-skeleton v1 -->

# The streaming reading, and the two leaks it will find

**Purpose:** Every motion reading on the user's deck was taken with nothing streaming, and the judder the user reports happens with three or four sessions streaming. This stage builds the reading for that condition, takes it, and closes two leaks already confirmed in the code: a `flushSync` that pierces the motion gate from every streaming block's animation frame, and a find index rebuilt on every snapshot.

Stage 1 of `briefs/main-thread-headroom-program-brief.md`.

---

## Purpose {#purpose}

The user, 2026-10-11:

> When Tug gets cooking on three or four sessions, and I try to move cards around by folding/unfolding them or switching their columns, we *still* get pauses and judders.

The gestures read clean on a quiet deck (`briefs/set-up-and-go-motion-brief.md` [F01]: longest mid-motion gap 17–31 ms). The condition the user describes has never been read. The instrument's own guidance says not to stream in the deck being read, so the reading of record excludes the defect.

---

## Evidence {#evidence}

**[F01] The streaming markdown block calls `flushSync` from its own animation frame.** `tugdeck/src/components/tugways/tug-markdown-block.tsx` coalesces a streaming row's deltas to one `requestAnimationFrame` per block (`:387`), reconciles, and then calls `announceAnnotated` (`:334`, `:442`), which calls the wrapped `flushSync` (`:143`) whenever an `onAnnotated` callback is supplied. The streaming assistant body always supplies one (`session-card-transcript.tsx:1214`, `annotation-portals.tsx:65`). **(verified, read from the code)**

**[F02] The wrapped `flushSync` drains every held tell whether or not the motion gate is closed.** `flushThrough` in `tugdeck/src/lib/gesture-scope.ts:529` calls `scope.drain()`; `drain` (`:250`) calls `runHeldAndQueued` unconditionally, where `release` (`:258`) runs it only when `motionHolds === 0`. So one streaming block's frame releases every React tell the motion gate was holding, synchronously, inside the frame the motion is painting. With N streaming blocks that is N drains per frame. This is the mechanism by which a sealed motion is unsealed by streaming, and it is by construction rather than by any one site's mistake. **(verified, read from the code; its cost under streaming is not measured)**

**[F03] The find index is rebuilt on every store snapshot, find open or not.** `session-card-transcript.tsx:2757` memoizes `buildTranscriptSearchSegments` on `codeSnapshot`, which is a fresh object on every publish (`code-session-store.ts:797`). The builder (`tugdeck/src/lib/transcript-search-index.ts:596`) walks every row; for a markdown row it calls `ensureParsed` and then `htmlToText`, which writes `innerHTML` on a scratch element per block (`:130`). The streaming row's text as read here is usually not the text the rAF parsed, so it misses the parse cache and parses the message again. **(verified, read from the code; not measured)**

**[F04] Streaming publishes on a per-session 16 ms timer.** `LIVE_NOTIFY_MIN_MS = 16` (`code-session-store.ts:191`); same-phase text deltas coalesce on a trailing `setTimeout` (`:2577`), everything else publishes synchronously (`:2586`). The timer is not aligned to the frame and each session has its own. **(verified, read from the code)**

**[F05] The settle instrument cannot see any of this.** The settle's sealed clause counts React commits, forced-layout chains and observer deliveries inside the window (`tugdeck/src/lib/motion-guard/settle-bar.ts:15`). It would count the drains from [F02] as commits, which is right. It records nothing about the rAF parse in [F01] or the index rebuild in [F03], which are plain tasks. The `--tasks` recorder in `tugtool deck motion settle` records tasks, and the `--sample` arm files native samples by phase, so the instruments exist; what does not exist is a way to run them with sessions streaming on a controlled deck. **(verified, read from the code and `tugrust/crates/tugtool/src/commands/deck_motion_settle.rs`)**

**[F06] The harness can stream into a session card.** `app.startTugcode({ mode: "stub" })` replays a `TugcodeTranscript` whose turns emit `assistant_text` and other outbound frames when a user message arrives (`tests/app-test/_harness/client.ts:1572`). Whether the stub paces its outputs at a token cadence or emits a turn's outputs at once is not established here; a streaming arm needs a paced emission. **(verified that the door exists; pacing unverified)**

**[F07] The one streaming reading on record.** `briefs/real-transcript-motion-readings.md` (The streaming floor): 41 updates/s over the floor and 280 ms/s of main thread held with one session mid-turn, worst gap 56 ms, at 11,422 elements; the same deck with its turn open but idle read 18 updates/s and 99 ms/s. One session's streaming held the main thread for about 180 ms of every second. **(verified, measured 2026-10-06)**

**[F08] The deck trace records no settle row unless recording is switched on.** `ALWAYS_RECORDED_KINDS` in `tugdeck/src/deck-trace.ts:1252` holds no settle kind; `settle-frames` and `settle-land` arm only through `tugtool deck motion record on`. So when the user sees a judder on their deck, nothing recorded it. **(verified, read from the code)**

---

## Decisions {#decisions}

**[B01] `tugtool deck motion settle` gains a streaming arm, and it is the reading of record for this program.** The arm binds three session cards on the harness deck to the stub tugcode and drives them to stream at a token cadence while the gesture is driven, on both the slice and whale transcript arms (`tests/app-test/real-transcript-fixture.ts`). Same bars as today: no gap over one display period inside the motion and a one-frame land. The `--tasks` recorder and `--sample` run under it so the first reading says how much of the judder is script and how much is engine. If the stub does not pace its emissions ([F06]), the arm gives it a cadence; a burst is not streaming.

**[B02] The user's deck is read under streaming, before and after, with the same verb.** The reading is taken with three real sessions mid-turn on the user's release deck. The quiet-deck reading is taken beside it as context. This reverses the standing instruction to read only a quiet deck; that instruction was right for reading a gesture's own cost and wrong for reading the defect the user reports.

**[B03] `flushSync` drains gesture-pending tells and never motion-held ones.** The split in `gesture-scope.ts` already exists in `release`; `drain` takes the same rule. A `flushSync` inside a closed motion gate flushes its own body and the tells the pointer scope was holding for the paint, and leaves the motion's held tells for the gate's release. The focus-transfer contract ([gesture-task-without-react-brief] [B04]) is unaffected: it flushes its own mutation, which is the body, not the hold.

**[B04] The streaming reconcile and its announce defer while motion is held.** `TugMarkdownBlock`'s rAF flush checks `isMotionHeld()` and re-arms for the gate's release instead of reconciling; the gate's release runs the deferred reconcile once with the store's current text. The content pop at release is the one the doctrine already accepts (`tuglaws/animation-doctrine.md` #accepted-snaps). Under reduced motion no gate closes and nothing changes.

**[B05] The find index is built only when find is open, and otherwise not at all.** The memo keys on the find session's open state and on the snapshot only while open. Find's correctness on open is unchanged: the first open builds the index for the whole loaded window as it does today. An incremental index is stage 5's concern.

**[B06] Every streaming store publishes on one frame-aligned tick.** The per-session 16 ms timers ([F04]) become one `requestAnimationFrame`-aligned publish shared by every `CodeSessionStore`, so N sessions cost React one commit per frame rather than N. The structural publishes (phase, tool result, errors) stay synchronous. This is the smallest form of what stage 3 builds in the Worker, and doing it here lets stage 3 be read against it.

**[B07] One row is recorded always: a frame over one period inside a motion window.** The settle engine already runs a rAF sampler when recording is on; the always-on form is the cheapest possible, a timestamp per frame while the settling mark is on and one trace row when a gap exceeds a period, with the gesture and the gap. It costs one `performance.now()` per frame during a settle and nothing at rest, which is inside [D1]. "Sometimes drops frames" becomes a row in `tugtool deck motion` with a time on it.

**[B08] Nothing here is designed before [B01]'s reading is taken.** [F02], [F03] and [F04] are read from the code. The arc's first act is the arm and the reading; the fixes in [B03] through [B06] land after it and are read against it, each as its own probe so its share is known.

---

## Open Questions {#open-questions}

- **Does the stub tugcode pace its emissions?** Read `tugcode/src/stub-replay.ts`. If not, the arm adds a per-output delay option; the shape is the arc's.
- **What share of the streaming floor is each leak?** [F07] gives 180 ms/s for one streaming session with no gesture. Whether [F02], [F03] or the parse in stage 5's brief is the bulk decides how much stages 2 and 5 are worth. The probes under [B08] answer it.
- **Is there a streaming case where the deferred reconcile ([B04]) must not wait?** A reader following a stream while folding another card sees the followed card pause for the length of the fold. That is the accepted pop. If the user reads it as a stall, the answer is a shorter gate, not a reconcile inside it.

---

## Non-goals {#non-goals}

- **Moving any work to a Worker.** Stage 3. This stage reads and plugs; it does not re-architect.
- **Taking React out of the stream path.** Stage 2. [B06] aligns React's commits; it does not remove them.
- **An incremental find index.** Stage 5, where text extraction leaves the page.
- **Loosening any settle bar.** The bars are the asks' bars.
- **Reading a quiet deck as the verdict.** [B02].

---

## Exit {#exit}

**An arc.** Its first act is the streaming arm and the first reading on both the harness and the user's deck, with `--tasks` and `--sample`, written into the program brief's record. Then, each as its own probe-read step against that baseline: the `flushSync` split, the deferred reconcile, the index-on-open, the shared frame tick, and the always-on gap row. The arc joins with the streaming reading taken again on the user's deck and the delta recorded.
