<!-- brief-skeleton v1 -->

# Main-thread headroom: the program

**Purpose:** With three or four sessions streaming, folding a card or moving it between columns still pauses and judders. The cause is structural: one window, one WKWebView, one document, one WebContent main thread, shared by every session's work and every gesture's motion. This brief names the stages that move work off that thread and shrink what is left on it, in the order they build on each other, and names where the program may stop.

---

## Purpose {#purpose}

The user, 2026-10-11:

> When Tug gets cooking on three or four sessions, and I try to move cards around by folding/unfolding them or switching their columns, we *still* get pauses and judders. My goal is that this *never ever* happens, that we provide full frame rates *no matter what work the app is doing*. I mean, come on, we have a super computer here.

On the diagnosis that one document on one main thread is the crux:

> This turns out to have been a poor architectural decision for the app. … we need to start teasing this apart so we can create more headroom in the app. The clear imperative seems to be: *work must move off the main thread*.

And on scope:

> Brief this into as many separate brief documents and arcs as seems prudent, safe, and achievable. Stage the work so that the later work builds on the earlier. At some point, we may decide to stop.

This document is the index. Each stage has its own brief with its own evidence, decisions and exit. The stage briefs are:

1. `briefs/streaming-motion-reading-brief.md` — read the gestures under streaming, and close the two leaks already confirmed in the code.
2. `briefs/react-off-the-stream-path-brief.md` — React learns of structural change only; a token costs React nothing.
3. `briefs/ingest-worker-brief.md` — the WebSocket, the decode, the reducer, the pacing and the motion hold move to a Worker.
4. `briefs/population-ceiling-brief.md` — the document is bounded by the viewport, not by history.
5. `briefs/tugcast-renders-brief.md` — markdown, highlighting and search leave the page for tugcast.

---

## Evidence {#evidence}

**[F01] The app is one document on one thread.** `tugapp/Sources/AppDelegate.swift:304` creates one `MainWindow`; `MainWindow.swift:597` creates one WKWebView; `tugdeck/index.html:22` has one `deck-container` and one module entry. There are no iframes (DOMPurify forbids them, `tugdeck/src/lib/markdown/dompurify-instance.ts:48`). Every session card, the Overview, the rails, every store and every gesture run on the one WebContent main thread. **(verified, read from the code)**

**[F02] A frame's main-thread time splits into script and engine, and they need different cures.** Script is ingest, reducers, markdown parsing, React commits and forced layout. Engine is style resolution, layout, the compositing walk and paint. The compositing walk is priced by what is mounted, not what moves: about 6 ms per style-changing frame at 23,000 elements, 5 ms at 22,858 (`briefs/compositing-walk-readings.md` [F01]). Moving script to a Worker does not touch engine time. Shrinking the document does not touch script time. **(verified for the walk's price; the split is the standard event-loop model)**

**[F03] The motion hold covers React tells and nothing else.** `tugdeck/src/lib/gesture-scope.ts` holds every wrapped `useSyncExternalStore` tell while the motion gate is closed. Ingest, `JSON.parse`, the reducer, the streaming markdown reconcile, DOMPurify, Lezer highlighting and the find-index rebuild run outside it. **(verified, read from the code)**

**[F04] The wrapped `flushSync` drains every held tell regardless of the motion gate.** `flushThrough` calls `scope.drain()` (`gesture-scope.ts:529`), and `drain` runs `runHeldAndQueued` unconditionally (`:250`), where `release` checks `motionHolds === 0` first (`:258`). The streaming markdown block calls that `flushSync` from its own `requestAnimationFrame` to mount annotation portals (`tugdeck/src/components/tugways/tug-markdown-block.tsx:143`, `:334`, `:442`). With a session streaming, every parked React commit lands synchronously inside the animation frame, once per streaming block per frame. **(verified, read from the code; not yet measured)**

**[F05] The find index is rebuilt on every snapshot whether or not find is open.** `SessionTranscriptHost` memoizes `buildTranscriptSearchSegments` on the whole store snapshot (`tugdeck/src/components/tugways/cards/session-card-transcript.tsx:2757`), and `getSnapshot` is a new object per publish. The builder walks every row and round-trips every block through `innerHTML` on a scratch element (`tugdeck/src/lib/transcript-search-index.ts:130`). Its cost grows with the transcript, not the delta. **(verified, read from the code; not yet measured)**

**[F06] Streaming publishes on per-session timers, not on the frame.** Each `CodeSessionStore` coalesces same-phase text deltas on its own 16 ms `setTimeout` (`tugdeck/src/lib/code-session-store.ts:191`, `:2577`). Each publish re-renders the whole-snapshot subscribers: `SessionCardBody` (`session-card.tsx:2204`), `TugPromptEntry`, the telemetry renderers and `TugListView`, which rebuilds a wrapper per row. Four sessions are four unaligned timers. **(verified, read from the code)**

**[F07] Every streaming delta re-parses the whole message on the main thread.** `ensureParsed` misses by design on a streaming row because its text changes per delta (`tug-markdown-block.tsx:352`), and the parse runs WASM `lex_blocks` and `parse_blocks_to_html` over the full text, a byte-to-char map, and DOMPurify over every block (`tugdeck/src/lib/markdown/parse-markdown-to-sanitized-blocks.ts:242`). The incremental reconciler then rewrites only changed blocks. **(verified, read from the code)**

**[F08] Every user-deck reading to date was taken with nothing streaming.** `briefs/real-transcript-motion-readings.md` (The streaming floor) records 41 updates/s and 280 ms/s of main thread held with one session mid-turn, against 18 updates/s and 99 ms/s with the same deck's turn open but idle, and notes "no other session was streaming". The 2026-10-06 rails, sidebar and fit readings were taken on a deck with no session streaming by instruction. The workspace-switch brief discarded a run because a neighbour was streaming. The condition the user describes is the one the readings exclude. **(verified, from the readings' own text)**

**[F09] The mid-motion frame is clean on a quiet deck.** `briefs/set-up-and-go-motion-brief.md` [F01]: every gesture's longest gap before the land was 17–31 ms on the user's deck with nothing streaming. The gestures are correct; what they lack is a thread. **(verified, measured 2026-10-05)**

**[F10] The host owns no lever on frame delivery.** The host sets one WebKit internal feature (`TemporaryTileCohortRetentionEnabled=0`, overridable through `TUG_WK_FEATURES`, `MainWindow.swift:15`), a transparent web view, and nothing else; no display link, no frame timing, and no per-frame host-to-web traffic. **(verified, read from the code)**

---

## Decisions {#decisions}

**[B01] The program has two levers and both pull: move script off the main thread, and shrink the document the engine walks.** [F02] is why neither alone reaches the goal. Stages 1, 2, 3 and 5 are the first lever. Stage 4 is the second. A stage that moves script and leaves engine time where it was is a stage, not the program.

**[B02] The end state is a view process.** The page applies frame-paced, render-ready patches and handles gestures. Everything else, ingest, reduction, parsing, highlighting and indexing, runs in a Worker or in tugcast. Every stage is judged by whether it moves the page toward that shape, and no stage may add work to the page's main thread that the shape would later have to remove.

**[B03] The stages land in order, and each is a place to stop.** The order is reading, React off the stream, ingest Worker, population ceiling, tugcast renders. Each stage's brief carries its own before-and-after reading on the user's deck under streaming, so what the program has bought is known at every stop. The user has said the program may stop; a stage that lands green and reads well on the user's deck is a complete outcome whether or not the next one opens.

**[B04] Every reading in this program is taken under streaming.** [F08] is the methodological defect under every prior reading, and stage 1 exists to fix it before anything is built against it. The streaming arm from stage 1 is the reading of record for stages 2 through 5; a quiet-deck reading is recorded beside it as context, never as the verdict.

**[B05] Set-up-and-go stands, and nothing in this program moves work from a gesture's set-up into its motion.** `briefs/set-up-and-go-motion-brief.md` [B01] through [B05] are the shape every gesture keeps. This program gives that shape the thread it was designed for. The height-by-translation ruling and the standing [D9] hits are not reopened by any stage.

**[B06] No private API in the shipping host.** `briefs/motion-never-on-the-main-thread-brief.md` [B02] holds. The `TUG_WK_FEATURES` hook may be used to read a WebKit internal feature on the user's deck as a measurement; nothing in the program ships against one.

**[B07] Host-side pane composition is the recorded escape, not a stage.** One WKWebView per card with host-owned geometry is the only design under which another session's work cannot touch a gesture at all, and `tuglaws/animation-doctrine.md` (#containment) already records it as the fallback. It breaks cross-card drag, portals, selection and the harness, and costs a WebContent process per card. It is written here so it is not re-derived, and it opens only if stage 4's ceiling cannot hold on the user's deck after stages 1 through 3 land.

**[B08] Stage 5 is the deep form of stage 3 and may be skipped.** tugcast rendering markdown natively replaces the page-side parse behind the same block-hash patch protocol stage 3 establishes. If stages 1 through 4 read clean under streaming on the user's deck, stage 5 is a choice about where the parse lives, not a defect to fix.

---

## Open Questions {#open-questions}

- **How much of the judder is script and how much is engine, under streaming, on the user's deck?** Nothing has measured it; [F08]. Stage 1's streaming arm with `--tasks` and `--sample` answers it, and the answer sets how much stage 4 is worth relative to stages 2, 3 and 5.
- **Does the program stop after stage 3 or stage 4?** The user's call, made on the readings. The program is written so either is a whole outcome.

---

## Non-goals {#non-goals}

- **A host-side process meter, or any private API in the shipping host.** [B06].
- **Reopening height by translation or the [D9] standing hits.** Benched twice and ruled; [B05].
- **Rendering the transcript to canvas.** It discards selection, find, accessibility and copy for a cost that stages 4 and 5 remove without it.
- **Auto-demoting motion on a reading.** The product does not take the user's animations away; `tuglaws/animation-doctrine.md` guard 4.
- **Per-card web views as a stage.** [B07].

---

## Exit {#exit}

**Five arcs, one per stage brief, opened in order.** This program brief spawns no arc of its own; it is the index the stage briefs cite and the record of the order and the stop points. The first gesture is `/arc streaming-motion-reading @briefs/streaming-motion-reading-brief.md`. Each later stage opens after the one before it has joined and its reading is written into this program's record, below.

### Record {#record}

| Stage | Joined | Reading on the user's deck under streaming |
|---|---|---|
| 1. streaming-motion-reading | | |
| 2. react-off-the-stream-path | | |
| 3. ingest-worker | | |
| 4. population-ceiling | | |
| 5. tugcast-renders | | |
