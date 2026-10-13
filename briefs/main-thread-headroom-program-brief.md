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

The 2026-10-12 audit of the five landed stages found the architecture sound and the asks unmet, and spawned five more briefs. Four are fixups to the stages above and one is the stage the readings now point at:

- `briefs/ingest-worker-failure-story-brief.md` — stage 3's failure story: a dead Worker named and recovered, batches that always acknowledge, bounded waits, the Worker released.
- `briefs/rendered-html-second-barrier-brief.md` — stage 5's depth: a page-side barrier on rendered HTML, a tighter CSP, a wider corpus, a bounded render stage.
- `briefs/population-ceiling-cold-paths-brief.md` — stage 4's cold paths: no full mount at open, reveal or mid-settle; a ceiling bar that can fail.
- `briefs/motion-record-honesty-brief.md` — unperturbed readings, a two-beat gap row, and the laws that name the Worker, the patch protocol and the render feed.
- `briefs/engine-time-in-the-motion-brief.md` — stage 6: the first frame after the commit and the height crossing, the two engine costs left inside the motion.

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

**[B03] The stages land in order, and each is a place to stop.** The order is reading, React off the stream, ingest Worker, population ceiling, tugcast renders. Each stage's brief carries its own before-and-after reading on the user's deck under streaming, so what the program has bought is known at every stop. From stage 4 on, each stage's record also carries one aged reading of the user's deck (`tugtool deck motion layers` and `walk` as found, with its uptime), and they accumulate in the Aging table of `compositing-walk-readings.md` (#aging-reading). The user has said the program may stop; a stage that lands green and reads well on the user's deck is a complete outcome whether or not the next one opens.

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
| 1. streaming-motion-reading | | Baseline, one probe per fix, and the after-reading below, all 2026-10-11. The harness after-reading is taken; on the user's deck nothing was streaming at either reading and the deck runs `main`, so the user's-deck streaming after-reading is owed once the stage joins. |
| 2. react-off-the-stream-path | | Baseline and after-reading on the harness, 2026-10-11, below: at rest with three streams, React fell from 125 commits/s and at least 199 ms/s to 24 commits/s and 22 ms/s. The user's-deck streaming reading is owed once the stage joins, as stage 1's is. |
| 3. ingest-worker | | Baseline and after-reading on the harness, 2026-10-12, below: at rest with three streams, main-thread tasks carrying wire data fell from 119/s to 44.9/s, now posted by the ingest Worker, with React's rest census unchanged, and no ingest batch was applied inside any motion. The user's deck was read quiet, since nothing was streaming text, and it runs `main`; the user's-deck streaming after-reading is owed once the stage joins, as stages 1 and 2 recorded. |
| 4. population-ceiling | | Before and after on the harness, 2026-10-12 (`compositing-walk-readings.md` #aging-reading). Before: fresh 5,422 elements and a 4.97 ms mean walk, aged 15,913 elements (1,424 stacking contexts, all 150 Overview posts mounted) and 5.60 ms. After: fresh 4,209 and 4.27 ms, aged 6,960 elements (538 stacking contexts, 11 of 150 posts mounted at one stacking context each, evicting transcripts peaking at 6 of 16 rows through a fold and a split) and 5.10 ms. The ceiling is the aged mean walk within the fresh one plus 1.33 ms, the fresh reading's own spread, and `at0727` asserts it with the Overview's mounted count, no full transcript mount through a reflowing settle, and every moving settle sealed. The user's deck still runs `main` and was read as found twice, up 1 h 18 min (30,097 elements, 5.58 ms) and up 2 h 22 min (38,056 elements, 147 posts all mounted, 7.23 ms with a spread of 12.57). Since the join the user's deck runs this stage's code (`0f74f891d`), read as found up 6 h 07 min: 29,496 elements (1,721 stacking contexts), 21 Overview posts mounted, 4.17 ms with a spread of 2.28. A parked Overview pane still holds 10,998 elements. The stage's cold paths (`briefs/population-ceiling-cold-paths-brief.md`) take a harness reading of 6,870 elements aged and an aged walk 1.10 ms over fresh. Their reading of record is the two empty "cold paths" rows of the aging table: fresh after the first relaunch onto a build carrying them, and aged after a working day with sessions streaming. Both are owed after that arc joins. |
| 5. tugcast-renders | | Baseline and after-reading on the harness, 2026-10-12, below: at rest with three streams, the page's live-turn row parses fell from 109.5 per second to 0, since streamed rows now draw from tugcast's renders, and the `RENDERED` feed that replaced them carries 52.6 frames and 105 KB per second. React's rest census, the motion gaps and the sealed wire did not move. The user's deck was read quiet, since only one session was mid-turn and none streaming text, and it runs `main`. The user's-deck streaming after-reading is owed once the stage joins, as stages 1–3 recorded. |

#### Stage 1 baseline — 2026-10-11

Taken with `tugtool deck motion settle --streaming <n> --sample` at the arc's base (`afe1d74b5`) plus the instrument. Every gap is in ms; the bar for every row is the asks' bar — no gap over one display period inside the motion, and a one-frame land — and every row below misses it.

**Harness, three sessions streaming.** `at0725-streaming-settle-reading`: a four-up deck whose moved card `c1` resumes a real transcript, and whose other three cards stream a stubbed turn through tugcast's real feed at one word per 25 ms. The verb ran with `--tasks` too, so its React times are perturbed upward. Two drives per gesture; slice `c1` is 1,511 elements in a 2,573-element document, whale `c1` 2,085 in 3,147.

| Arm | Gesture | Floor before the drives | Lead | Longest gap | React in the window | Commits in the window | WebContent main thread: busy, of which script |
|---|---|---|---|---|---|---|---|
| slice | fold | 59 updates/s, 231 ms/s busy | 35, 14 | 36, 46 | 123, 141 | 47, 46 | 502 of 933 samples; script 297 (59%) |
| slice | slot | 34 updates/s, 154 ms/s busy | 15, 8 | 58, 50 | 170, 144 | 49, 45 | 492 of 935; script 274 (56%) |
| whale | fold | 58 updates/s, 210 ms/s busy | 35, 14 | 47, 46 | 127, 152 | 47, 52 | 500 of 925; script 290 (58%) |
| whale | slot | 30 updates/s, 119 ms/s busy | 16, 12 | 44, 51 | 165, 155 | 48, 48 | 483 of 938; script 263 (54%) |

What the streaming adds is visible in the motion's own commit list: a `SessionCardBody` commit of 280–860 performed fibers lands every 15–35 ms from the first beat to the land, on every drive. Those are the streaming cards' publishes reaching React inside a motion the gate was meant to seal — the drains [F02] of the stage brief names and the per-session timer its [F04] names. Compositing (48–82 samples), style (19–43) and layout (33–37) trail script by a wide margin on WebContent; the Tug host and the GPU process are each under 7% busy.

**User's release deck, nothing streaming.** `release-main`, 19,838 elements and 1,277 stacking contexts, visible. No session was in a turn when the reading ran (three idle, one `waking`), so the streaming reading could not be taken; this is what was readable. The deck was not at rest — 16–21 updates/s against a budget of 10 — so it was read with `--streaming 0`, which reads the floor rather than refusing it. `--tasks` was not used, because its first run reloads the page and this was the user's live deck; the React columns are therefore absent.

| Gesture | Floor | Settle window | Lead | Longest gap (motion) | Land frame | WebContent main thread: busy, by phase |
|---|---|---|---|---|---|---|
| fold | 16 updates/s, 81 ms/s busy | 1,125, 1,094 ms | 16, 14 | 211 (211), 165 (138) | 47, 32 | 248 of 1,021; compositing 70, style 57, script 15 |
| slot | 20 updates/s, 100 ms/s busy | 1,296, 1,103 ms | 52, 33 | 327 (213), 200 (88) | 213, 27 | 276 of 1,020; style 81, compositing 76, script 17 |

The two readings disagree about where the time goes, and the disagreement is the finding. On a 3k-element harness deck with three streams, a gesture's frames are lost mostly to script: the streams' commits landing inside the motion. On the user's 20k-element deck with nothing streaming, the frames are lost mostly to style and compositing, at gaps three to six times the harness's and windows twice as long. The streaming reading on the user's deck is the one that says how the two compound, and it is owed by the after-reading.

#### Stage 1 probe: the `flushSync` drain gated — 2026-10-11

The same harness arm, read again with only the drain fix in: the wrapped `flushSync` no longer drains the tells a closed motion gate holds (`tugdeck/src/lib/gesture-scope.ts`, `drain`). Nothing else changed, so the delta is this fix's share.

| Arm | Gesture | Floor before the drives | Lead | Longest gap | React in the window | Commits in the window | WebContent main thread: busy, of which script |
|---|---|---|---|---|---|---|---|
| slice | fold | 50 updates/s, 192 ms/s busy | 32, 21 | 34, 37 | 45, 51 | 21, 15 | 478 of 949; script 261 (55%) |
| slice | slot | 65 updates/s, 287 ms/s busy | 16, 9 | 54, 36 | 34, 43 | 5, 16 | 481 of 960; script 276 (57%) |
| whale | fold | 49 updates/s, 198 ms/s busy | 37, 11 | 37, 49 | 39, 53 | 19, 16 | 462 of 951; script 264 (57%) |
| whale | slot | 30 updates/s, 119 ms/s busy | 18, 26 | 40, 43 | 37, 40 | 7, 10 | 478 of 957; script 261 (55%) |

The drain was the route the streams' commits took into the motion. The `SessionCardBody` commits are gone from every motion's commit list; what is left inside the motion is at most three 21-fiber `SessionTelemetryStatusRow2` commits, and the rest of the window's commits land at its release. React time in the window falls by two thirds, from 123–170 ms to 34–53 ms, and commits in the window from 45–52 to 5–21. The frames do not follow: the longest gaps are 34–54 ms against 36–58, and script's share of WebContent's busy samples is unchanged at 55–57%. So the React commits were not the bulk of what holds the main thread under streaming. The script the samples still see is not React's commits; the candidates are the plain tasks the next probes remove, the streaming blocks' rAF parse and reconcile ([B04]) and the find index's rebuild ([B05]), and their readings say which it is.

#### Stage 1 probe: the streaming reconcile deferred while motion is held — 2026-10-11

The same arm again, with the drain fix and now the streaming blocks' deferral (`tugdeck/src/lib/markdown/streaming-flush.ts`): a streaming block's frame that finds the motion gate closed reconciles nothing and runs one reconcile, with the store's current text, at the gate's release.

| Arm | Gesture | Floor before the drives | Lead | Longest gap | React in the window | Commits in the window | WebContent main thread: busy, of which script |
|---|---|---|---|---|---|---|---|
| slice | fold | 56 updates/s, 213 ms/s busy | 33, 11 | 38, 36 | 45, 57 | 14, 17 | 513 of 1,043; script 282 (55%) |
| slice | slot | 63 updates/s, 303 ms/s busy | 17, 23 | 37, 42 | 43, 40 | 7, 10 | 514 of 1,050; script 293 (57%) |
| whale | fold | 35 updates/s, 125 ms/s busy | 41, 13 | 41, 43 | 43, 59 | 13, 19 | 516 of 1,044; script 301 (58%) |
| whale | slot | 67 updates/s, 319 ms/s busy | 14, 30 | 41, 44 | 40, 41 | 5, 10 | 527 of 1,054; script 313 (59%) |

The worst gap comes down and the spread closes: 36–44 ms across all eight drives, against 34–54 with the drain fix alone and 36–58 at the baseline. The floor of the range does not move, so every drive still misses the one-period bar, its worst gap two periods or more. React's columns are unchanged from the drain probe, as they should be: the reconcile is DOM work, not a commit. The WebContent column cannot show this fix's share, because the sampler covers the whole drive, about 1.6 s, of which the motion is 330–490 ms; the streams reconcile freely in the rest of it, so script's share of the drive stays at 55–59%. What the bar is read against is the motion's own gaps, and those say the reconcile was part of the stall and not the bulk of what is left.

#### Stage 1 probe: the find index built only while find is open — 2026-10-11

The same arm again, with the two fixes above and now the find index keyed on the find bar's open state (`tugdeck/src/components/tugways/cards/session-card-transcript.tsx`): with the bar closed, a store publish rebuilds nothing. This reading ran as the last file of a 45-file batch rather than an 8-file one.

| Arm | Gesture | Floor before the drives | Lead | Longest gap | React in the window | Commits in the window | WebContent main thread: busy, of which script |
|---|---|---|---|---|---|---|---|
| slice | fold | 52 updates/s, 201 ms/s busy | 36, 13 | 39, 39 | 51, 50 | 22, 16 | 507 of 1,040; script 272 (54%) |
| slice | slot | 63 updates/s, 321 ms/s busy | 17, 14 | 51, 43 | 43, 46 | 9, 12 | 466 of 1,055; script 272 (58%) |
| whale | fold | 44 updates/s, 193 ms/s busy | 37, 11 | 38, 51 | 49, 61 | 24, 17 | 491 of 1,038; script 287 (58%) |
| whale | slot | 65 updates/s, 333 ms/s busy | 18, 23 | 54, 42 | 44, 43 | 7, 10 | 504 of 1,046; script 269 (53%) |

On this deck the fix reads as nothing: gaps of 38–54 ms against 36–44 with the reconcile deferral, the floor's busy time and script's share inside their run-to-run spread. That is what the harness deck predicts rather than evidence that the rebuild is cheap. The rebuild walks the rows of the card whose store published, and the three streaming cards here hold one turn each, so their index is a handful of rows; the card with the long transcript, `c1`, is the one the gestures move and it does not stream. On the user's deck a streaming card is usually a long session, and there the per-publish walk is over every loaded row. The after-reading on the user's deck under streaming is where this fix's share shows, if it has one. One cost the fix leaves in place, as [B05] scoped it: the transcript host still subscribes to the session snapshot with find closed, and that snapshot is now read by nothing but the find memo, so the host still re-renders on every publish to learn that it has nothing to build.

#### Stage 1 probe: one frame-aligned publish tick for every streaming store — 2026-10-11

The same arm again, with the three fixes above and now the shared publish tick (`tugdeck/src/lib/live-publish-tick.ts`): every store's coalesced text publish rides one `requestAnimationFrame`, with a 50 ms deadline behind it for an occluded window, instead of each store's own 16 ms timer. Read in a 14-file batch.

| Arm | Gesture | Floor before the drives | Lead | Longest gap | React in the window | Commits in the window | WebContent main thread: busy, of which script |
|---|---|---|---|---|---|---|---|
| slice | fold | 56 updates/s, 332 ms/s busy | 35, 10 | 48, 31 | 42, 41 | 14, 11 | 533 of 1,039; script 257 (48%) |
| slice | slot | 61 updates/s, 410 ms/s busy | 13, 10 | 39, 44 | 35, 43 | 5, 10 | 478 of 1,047; script 245 (51%) |
| whale | fold | 49 updates/s, 327 ms/s busy | 36, 8 | 38, 43 | 42, 51 | 14, 9 | 492 of 1,049; script 290 (59%) |
| whale | slot | 48 updates/s, 365 ms/s busy | 14, 5 | 43, 31 | 45, 36 | 7, 9 | 487 of 1,050; script 258 (53%) |

The motion reads a little better and the floor a little worse. Inside the window the longest gaps are 31–48 ms, and 31 is the lowest any reading has shown (the drain probe's lowest was 34), and commits in the window fall to 5–14 against 7–24 on the find-index probe. Before the drives, the floor's busy time rose on all four rows, to 327–410 ms/s against 125–333 on every earlier reading, at the same 48–61 updates/s. The tick runs every store's React render inside the frame callback, where the per-store timers ran them between frames, so the floor's frame-time accounting may now be charging them to the frames; that is a reading of the mechanism, not a measurement, and the user's-deck reading will say whether the floor rose there too. Script's share of the drive ranges 48–59%, the widest spread of any reading, so it carries nothing here.

#### Stage 1 after-reading — 2026-10-11

The same harness arm with all four fixes and the always-recorded gap row in, on the arc's final tree, read alone (one file, both transcript arms).

| Arm | Gesture | Floor before the drives | Lead | Longest gap | React in the window | Commits in the window | WebContent main thread: busy, of which script |
|---|---|---|---|---|---|---|---|
| slice | fold | 54 updates/s, 316 ms/s busy | 32, 16 | 36, 45 | 39, 51 | 11, 14 | 460 of 958; script 227 (49%) |
| slice | slot | 59 updates/s, 356 ms/s busy | 14, 8 | 42, 41 | 47, 31 | 9, 8 | 468 of 970; script 216 (46%) |
| whale | fold | 66 updates/s, 401 ms/s busy | 38, 6 | 38, 38 | 37, 45 | 13, 9 | 490 of 946; script 259 (53%) |
| whale | slot | 62 updates/s, 383 ms/s busy | 14, 7 | 52, 39 | 41, 35 | 9, 10 | 474 of 963; script 229 (48%) |

Against the baseline, React's time inside the motion fell from 123–170 ms per drive to 31–51, and the commits in the window from 45–52 to 8–14. The longest gap did not follow: 36–52 ms against 36–58, and every row still misses the bar, which is no gap over one display period (16.7 ms here) inside the motion. The always-recorded `settle-gap` row agrees from inside the product: six late frames per arm across its four drives, each 29–51 ms against a learned period of 16–17 ms, two in the set-up and four in the `move` beat.

**Which leak was the bulk.** The `flushSync` drain, by a wide margin, and only of what React did. Gating it alone took React in the window from 123–170 to 34–53 ms and the commits from 45–52 to 5–21: about three quarters of React's time in the motion, and nearly all of the `SessionCardBody` commits the baseline listed. The deferred reconcile, the find index and the shared publish tick each moved React time and the gaps by no more than the run-to-run spread on this deck; the tick moved the commits from 7–24 to 5–14 and raised the floor's busy time, which this reading repeats (316–401 ms/s against 125–333 on every reading before the tick). The find index's share cannot show on this harness, whose streaming cards hold one turn each.

**What it says to stages 2 and 5.** React is no longer what fills the motion: 31–51 ms of React in a 330–470 ms window, while script is still about half of WebContent's busy samples across the drives, as it was at the baseline (46–53% now, 54–59% then). The script that remains under streaming is mostly outside React's commits — the wire ingest, the reducer and the markdown parse the streams keep running — which is stage 3's and stage 5's ground rather than stage 2's. Stage 2's remaining win inside the motion is bounded by the 31–51 ms left; its win at rest, against the floor's 316–401 ms/s busy, is not bounded by this reading.

**User's release deck, quiet, read again.** `release-main`, 18,663 elements and 1,290 stacking contexts, visible. One session was mid-turn and none streaming text, so `--streaming 3` refused and the deck was read with `--streaming 0` as the baseline was; `--tasks` again left off, since it reloads the live deck. The deck runs `main`, which carries none of this stage's fixes, so this is a second reading of the baseline's code and says how far the user's deck moves between readings.

| Gesture | Floor | Settle window | Lead | Longest gap (motion) | Land frame | WebContent main thread: busy, by phase |
|---|---|---|---|---|---|---|
| fold | 16 updates/s, 92 ms/s busy | 1,103, 1,093 ms | 17, 16 | 199 (199), 155 (63) | 50, 33 | 239 of 1,022; compositing 89, style 50, script 21 |
| slot | 23 updates/s, 113 ms/s busy | 1,094, 1,099 ms | 51, 24 | 179 (75), 182 (63) | 48, 44 | 260 of 1,022; compositing 86, style 60, script 13 |

The user's deck tells the baseline's story again: gaps of 155–199 ms, a land of 33–50, and the time in compositing and style with script at 13–21 samples. The harness and the user's deck still disagree about where the time goes, and this stage's fixes act only on the harness's half of it. Whether they matter on the user's deck turns on the streaming reading there, which needs sessions streaming text on a deck that carries the fixes; it is owed after the join, and `tugtool deck motion gaps` will show the late frames on that deck without anybody having armed a recorder.

#### Stage 2 after-reading — 2026-10-11

`at0725-streaming-settle-reading`, slice arm, on the arc's final tree (`71723dbe6`), read alone. The whale arm skips on a machine without the whale snapshot. The baseline is the same file at the arc's base (`466d95e3d`, stage 1 joined), taken before any of this stage's changes. Both are on the stage-1 harness deck: four cards four-up, three streaming a stubbed turn at one word per 25 ms. The number this stage moves is the rest census: commits React makes over 4 s with the three streams running and no gesture.

| Rest, three streams | Commits/s | React ms/s | Fibers performed/s | Most-performed components |
|---|---|---|---|---|
| baseline | 125 | at least 199 (261 of 503 timed) | 33,000 | `ResponderScope`, `Popper`, `Presence`, `TugProgressIndicator2`, `TugPushButton2`, `TugButton2`, about 900/s each |
| after | 23.7 | 21.7 (83 of 95 timed) | 1,760 | `Popper`, `PopperProvider`, `Presence`, `PopperAnchor` at 288/s; `TugTooltip` at 144/s |

| Reading | Floor before the drives | Lead | Longest gap | React in the window | Commits in the window | Largest commit | WebContent main thread |
|---|---|---|---|---|---|---|---|
| quiet fold, before | — | 35, 16 | 35, 39 | 17, 35 | 3, 3 | 454–455 performed | not sampled |
| quiet fold, after | — | 34, 17 | 34, 31 | 19, 30 | 3, 3 | 336–337 performed | not sampled |
| fold, three streams, before | 42–56 updates/s, 309–325 ms/s busy | 8, 10 | 32, 35 | 32, 43 | 11, 12 | 454–455 performed | busy 408 of 961; script 212 (52%) |
| fold, three streams, after | 19 updates/s, 102 ms/s busy | 12, 13 | 32, 57 | 27, 39 | 10, 7 | 336–337 performed | busy 317 of 1,059; script 94 (30%) |
| slot, three streams, before | 42–56 updates/s, 309–325 ms/s busy | 17, 11 | 49, 40 | 44, 38 | 7, 12 | 882–893 performed | busy 433 of 952; script 201 (46%) |
| slot, three streams, after | 34 updates/s, 148 ms/s busy | 19, 13 | 42, 49 | 36, 30 | 3, 3 | 766–777 performed | busy 297 of 1,053; script 82 (28%) |

Two drives each; times in ms. The always-recorded `settle-gap` row saw eight late frames across the run, 27–54 ms each against a 17 ms period, four in the set-up and four in the `move` beat, as at the baseline.

**At rest the stage did what it set out to do.** A streamed token costs React no commit: the commits/s fell fivefold, React's time per second about ninefold and the fibers performed per second nearly twentyfold. What remains is card content, not the stream: the tooltip and popper subtrees of controls inside the card body, mostly the telemetry status row, re-rendering on its structural publishes and its 1 Hz tick. The floor before the drives fell with it, from 309–325 ms/s busy to 102–148, and script's share of WebContent's busy samples across the drives fell from 46–52% to 28–30%.

**Inside the motion the gaps did not move.** The longest gaps read 31–57 ms against 32–49 at the baseline. The 57 is one drive, with three 21-fiber `SessionTelemetryStatusRow2` commits inside its motion. Every row still misses the one-period bar. React in the window was 31–51 ms after stage 1 and reads 19–39 now, which is inside the run-to-run spread. The largest commit is a quarter smaller on the fold and an eighth smaller on the slot move, because the title bar no longer re-renders for either, but it lands at the gesture's start rather than inside the motion, so it shortens the lead's work rather than the gaps. What fills the motion's gaps is not React's: stage 1 found the same, and with React's rest work gone, compositing, layout and style (71, 48–49 and 25–29 samples) are now nearly as large as script (82–94). That is stage 3's and stage 4's ground.

#### Stage 3 after-reading — 2026-10-12

`at0725-streaming-settle-reading`, slice arm, on the arc's final tree (`bd1ceb307`), read alone. The baseline is the same file at the arc's base (`aa0316a97`, stage 2 joined) with only the ingest-task counter added, taken before anything moved. Both are on the stage-1 harness deck: four cards four-up, three streaming a stubbed turn at one word per 25 ms. At the baseline the socket, the decode and every session's reducer ran on the page's main thread; after, they run in the ingest Worker, which posts the page one batch per display period and holds the wire while a settle's motion gate is closed.

| Rest, three streams | Wire tasks/s on the main thread | Commits/s | React ms/s | Fibers performed/s |
|---|---|---|---|---|
| baseline | 119 (`onmessage`, main thread) | 25.2 | 18.7 | 2,023 |
| after | 44.9 (batches from the Worker) | 22.9 | 18.9 | 1,891 |

| Reading | Floor before the drives | Lead | Longest gap | React in the window | Commits in the window | Ingest batches applied inside the motion | WebContent main thread |
|---|---|---|---|---|---|---|---|
| quiet fold, before | — | 23, 16 | 29, 28 | 16, 26 | 3, 3 | not recorded | not sampled |
| quiet fold, after | — | 31, 16 | 31, 34 | 18, 33 | 3, 3 | 0, 0 | not sampled |
| fold, three streams, before | 15 updates/s, 101 ms/s busy | 14, 13 | 35, 43 | 28, 46 | 12, 7 | not recorded | busy 302 of 1,047; script 70 (23%) |
| fold, three streams, after | 18 updates/s, 95 ms/s busy | 13, 11 | 37, 34 | 33, 34 | 9, 8 | 0, 0 | busy 296 of 1,045; script 72 (24%) |
| slot, three streams, before | 34 updates/s, 143 ms/s busy | 16, 14 | 41, 53 | 32, 33 | 3, 4 | not recorded | busy 334 of 1,073; script 70 (21%) |
| slot, three streams, after | 39 updates/s, 160 ms/s busy | 19, 13 | 43, 44 | 37, 34 | 3, 8 | 0, 0 | busy 291 of 1,029; script 52 (18%) |

Two drives each; times in ms. The `ingest-batch` trace row did not exist at the baseline, so its column reads only after. The always-recorded `settle-gap` row saw seven late frames at each reading, three in the set-up and four in the `move` beat: 28–52 ms at the baseline and 34–44 after, against a 17 ms period.

**The wire left the main thread, and the hold works.** The page's wire tasks fell from 119 per second, one per WebSocket message, to 44.9, one per batch the Worker posts; that is under the arc's bar of 65, one per display period at 60 Hz plus the local actions' acknowledgments. In every motion, streaming or quiet, no ingest batch was applied: the Worker holds what the streams produce until the gate opens, or until its own cap if the gate never does. What still commits inside a streaming motion is three 21-fiber `SessionTelemetryStatusRow2` commits per drive, as at stages 1 and 2, and with no batch applied in the motion they cannot have come from the wire. The rest census did not regress when the reducer moved across the thread: 22.9 commits/s against 25.2, inside the run-to-run spread, which says the field-level patches keep the snapshot fields' identity as the in-process store did.

**The frames did not follow, on this deck.** The longest gaps read 34–44 ms with three streams against 35–53 at the baseline, and every drive still misses the one-period bar. The worst drive came down by 9 ms, which is inside the run-to-run spread every earlier reading showed. Script's share of WebContent's busy samples across the drives is 18–24% against 21–23%, and the busy count is flat at 291–296 of about 1,040 against 302–334. So on this harness the reduction and decode were not what held the main thread under streaming: three stubbed streams at one word per 25 ms, whose sessions hold one turn each, cost the main thread little to reduce. What the busy samples carry is compositing, layout and style (63–84, 49–58 and 30–39 samples), which is stage 4's ground. The case this stage was built for is a long session streaming quickly on a large deck, where each event's reduction and publish run against a transcript of hundreds of turns, and only the user's deck under streaming can say what moving that off the main thread is worth.

**User's release deck, quiet.** 35,932 elements and 2,894 stacking contexts, visible: nearly twice the population of stage 1's reading, of which an Overview card and its parked twin are 11,070 elements each. One session was mid-turn and none was streaming text, so `--streaming 3` refused and the deck was read with `--streaming 0`, as stages 1 and 2 were; `--tasks` was left off, since it reloads the live deck. The deck runs `main`, which carries none of this stage's changes, so this is a reading of the code this stage replaces. The samplers stop WebContent to read its stacks, so the frame numbers carry their perturbation, as stage 1's did.

| Gesture | Floor | Settle window | Lead | Longest gap (motion) | Land frame | WebContent main thread: busy, by phase |
|---|---|---|---|---|---|---|
| fold | 5 updates/s | 861, 428 ms | 170, 7 | 170 (62), 140 (45) | 62, 45 | 351 of 1,106; compositing 90, ipc 55, style 42, layout 37, script 21 |
| slot | 14 updates/s | 1,017, 1,009 ms | 459, 75 | 459 (78), 331 (46) | 78, 46 | 438 of 1,101; style 146, compositing 108, layout 46, script 26 |

The user's deck tells stage 1's story again, larger: the frames are lost before the motion begins (leads of 170 and 459 ms on the first drive of each gesture), and inside it to compositing and style, with script at 21–26 samples. None of that is wire work. Whether this stage matters on the user's deck turns on the streaming reading there, on a deck that carries the Worker, and it is owed once the stage joins.

#### Stage 5 baseline — 2026-10-12

`at0725-streaming-settle-reading`, slice arm, at the arc's base (`c391e67a6`, stages 1–4 joined) with only the row-parse split added to the rest census, read alone. The deck is stage 1's: four cards four-up, three streaming a stubbed turn at one word per 25 ms. The number this stage is sure to move is new in the census: the page's markdown row parses per second, split into rows of a turn in flight at either end of the 4 s window (`turn.${turnKey}.…` identities) and every other row.

| Rest, three streams | Row parses/s, live-turn rows | Row parses/s, other rows | Wire tasks/s on the main thread | Commits/s | React ms/s | Fibers performed/s |
|---|---|---|---|---|---|---|
| baseline | 109.5 (3 live turns) | 0 | 55.3 (batches from the Worker) | 21.4 | 22.7 | 1,759 |

| Reading | Floor before the drives | Lead | Longest gap | React in the window | Commits in the window | Ingest batches applied inside the motion | WebContent main thread |
|---|---|---|---|---|---|---|---|
| quiet fold | — | 34, 13 | 34, 37 | 18, 32 | 3, 3 | 0, 0 | not sampled |
| fold, three streams | 14 updates/s, 97 ms/s busy | 18, 13 | 38, 28 | 36, 28 | 11, 8 | 0, 0 | busy 282 of 980; script 61 (22%) |
| slot, three streams | 36 updates/s, 141 ms/s busy | 25, 10 | 39, 45 | 37, 30 | 6, 6 | 0, 0 | busy 272 of 939; script 60 (22%) |

Two drives each; times in ms. The always-recorded `settle-gap` row saw eight late frames, four in the set-up at 27–38 ms and four in the `move` beat at 38–45 ms, against a 17 ms period.

**Every streamed word costs the page a whole-message parse.** 109.5 parses per second across three streams is about 36 per stream, one per word the stub emits at its 25 ms cadence: each streaming flush re-parses, re-sanitizes and re-hashes its message's whole text, and no restored or static row parsed at all over the window. That rate is what this stage takes to zero. The rest of the reading matches stage 3's after-reading within its spread, so it is the base the stage is read against rather than a finding: the gaps are 28–45 ms, every drive misses the one-period bar, no ingest batch lands inside a motion, and script is 22% of WebContent's busy samples with compositing, layout and style beside it. As stage 3 found, the harness's streams hold one short turn each, so the parse each word pays here is the cheapest it will ever be; a long message streaming on the user's deck pays it over the whole message each word.

#### Stage 5 after-reading — 2026-10-12

`at0725-streaming-settle-reading`, slice arm, on the arc's tree after its find and highlighting rounds (`4afbe6e80` plus the census's new assertion), read alone. The deck is the baseline's: four cards four-up, three streaming a stubbed turn at one word per 25 ms. Now tugcast parses each streaming assistant message, sanitizes and highlights it, and sends the changed blocks on `RENDERED` paced to the display. The page draws those rows from the records and parses none of them. For this one run, a temporary tally in the ingest Worker counted the `RENDERED` frames and their bytes. It was applied with `tugtool file probe` and is not in the tree.

| Rest, three streams | Row parses/s, live-turn rows | Row parses/s, other rows | Wire tasks/s on the main thread | Commits/s | React ms/s | Fibers performed/s |
|---|---|---|---|---|---|---|
| baseline | 109.5 (3 live turns) | 0 | 55.3 (batches from the Worker) | 21.4 | 22.7 | 1,759 |
| after | 0 (3 live turns) | 0 | 56.3 (batches from the Worker) | 22.2 | 21.2 | 1,766 |

| `RENDERED` at rest, three streams | Frames/s | Bytes/s | Bytes per frame | Session renders/s |
|---|---|---|---|---|
| after | 52.6 | 105.4 KB | 2,051 | 110.4 |

| Reading | Floor before the drives | Lead | Longest gap | React in the window | Commits in the window | Ingest batches applied inside the motion | WebContent main thread |
|---|---|---|---|---|---|---|---|
| quiet fold, before | — | 34, 13 | 34, 37 | 18, 32 | 3, 3 | 0, 0 | not sampled |
| quiet fold, after | — | 40, 16 | 40, 32 | 18, 30 | 3, 3 | 0, 0 | not sampled |
| fold, three streams, before | 14 updates/s, 97 ms/s busy | 18, 13 | 38, 28 | 36, 28 | 11, 8 | 0, 0 | busy 282 of 980; script 61 (22%) |
| fold, three streams, after | 22 updates/s, 71 ms/s busy | 14, 15 | 39, 37 | 31, 36 | 10, 10 | 0, 0 | busy 249 of 930; script 49 (20%) |
| slot, three streams, before | 36 updates/s, 141 ms/s busy | 25, 10 | 39, 45 | 37, 30 | 6, 6 | 0, 0 | busy 272 of 939; script 60 (22%) |
| slot, three streams, after | 31 updates/s, 110 ms/s busy | 19, 13 | 49, 43 | 45, 35 | 5, 10 | 0, 0 | busy 242 of 926; script 32 (13%) |

Two drives each; times in ms. The always-recorded `settle-gap` row saw eight late frames, as at the baseline: four in the set-up at 26–39 ms and four in the `move` beat at 40–49 ms, against a 17 ms period.

**The streamed row's parse is gone from the page.** Live-turn row parses fell from 109.5 per second to 0, and `at0725` now asserts the zero. tugcast pays for the parse instead, on a core the page does not use. Measured in release at the render stage, `render_blocks` takes a median of 0.23 ms for a 4 KB message, 2.08 ms at 32 KB and 8.14 ms at 128 KB, re-parsing and re-sanitizing the whole message each tick (find's rendered text is read from every block) and highlighting only the blocks whose hashes are new. Streamed code fences arrive already highlighted in the shared `tug-syn-*` classes, and a fence tugcast stamped never reaches the page's Lezer highlighter. Find over assistant text and expanded thinking is answered by tugcast from the text it keeps. The page projects those units only when tugcast holds nothing for one or does not answer.

**The feed costs about 105 KB a second, uncompressed.** That is 52.6 frames a second, about one per display period, at about 2 KB each, and each frame bundles 2.1 sessions' renders on average. That is the size the plan expected: the streaming tail block is resent on each tick, and only the blocks that changed travel. Over loopback that is no reason to compress.

**The rest census and the motion did not move, and on this deck they were not expected to.** Commits, React time and fibers at rest are within the baseline's spread, since a streamed row's draw was never a React commit. The longest gaps read 32–49 ms against 28–45. Every drive still misses the one-period bar, and no ingest batch lands inside a motion. Script's share of WebContent's busy samples fell, from 22% to 20% on the fold and to 13% on the slot move, and the busy floor before the fold's drives fell from 97 ms/s to 71. Both are in the direction of the parse leaving, but the spread is too wide to claim them. Compositing, layout and style (54–67, 34–39 and 26–31 samples) still carry the busy time inside the motion. As every stage has found, the harness's streams hold one short turn each, so the parse removed here was the cheapest it could be. The case this stage was built for is a long message streaming on the user's deck, where the page re-parsed the whole message on every word.

**What still runs the page parse, and why.** The parse retires only where every path is served, and the restore path is not. A restored (replayed) row is never rendered by tugcast: replay is indexed rather than rendered, so a resumed transcript does not cost a burst of renders on every handshake. Restored rows therefore parse once on the page, through the shared parse cache. That accounts for the 0 "other" row parses at rest, since they parsed at restore and not again. The page parse also serves static `initialText` blocks, `TugMarkdownView`, the beat line, transcript copy HTML, find's projection of user bodies and notes, and any streamed row whose record is missing or stale, which is the fallback branch in `chooseRenderedBlocks`. `tugmark-wasm` and DOMPurify stay for those paths. A later arc can render restored rows in tugcast if a reading of the user's deck shows restore paints costing frames.

**User's release deck, quiet.** 16,360 elements and 1,087 stacking contexts. Only one session was mid-turn, and none was streaming text, so `--streaming 3` refused and the deck was read with `--streaming 0`, as stages 1–3 were. `--tasks` was left off, since it reloads the live deck. The deck runs `main`, which carries none of this stage's changes, so this is a reading of the code this stage replaces. The samplers stop WebContent to read its stacks, so the frame numbers carry their perturbation.

| Gesture | Floor | Settle window | Lead | Longest gap (motion) | Land frame | WebContent main thread: busy, by phase |
|---|---|---|---|---|---|---|
| fold | 9 updates/s, 34 ms/s busy | 465, 390 ms | 16, 15 | 150 (150), 88 (29) | 150, 29 | 154 of 1,007; compositing 32, style 29, script 18, layout 13 |
| slot | 17 updates/s, 74 ms/s busy | 841, 835 ms | 82, 66 | 153 (153), 166 (35) | 53, 35 | 270 of 1,000; style 72, compositing 52, script 39, layout 27 |

Since stage 3's reading the deck has shrunk from 35,932 elements to 16,360. The first drive of each gesture still loses one frame of 150 ms or more, and style and compositing still lead the busy samples, with script third or fourth. Whether this stage matters there turns on the streaming reading, on a deck that carries tugcast's renders, and that reading is owed once the stage joins.
