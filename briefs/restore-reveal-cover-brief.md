# Restore Reveal Cover

**Purpose:** Since the app-modal restore sheet was removed, a relaunch shows a deck that looks ready to use. It isn't: the whole app blocks while each Session card reloads. The deck should say it is busy for exactly as long as it is busy, and no longer.

---

## Purpose {#purpose}

In the user's words: "the removal of the app-modal sheet on startup *appears* to make the app livelier, but actually doesn't, since the whole app/deck seems to block on session cards as they reload. This means that the app looks ready to go, but it isn't. We shouldn't lie/deceive like this, eh?"

Removing the modal fixed a real defect: one card's lost frame could hold the whole app. It also threw away the one true thing the modal said. During a restore there are stretches when the app answers nothing, and the chrome keeps painting its last frame through them.

---

## Evidence {#evidence}

**[F01] The startup sheet was `TugRestoreGate`, added in `aea9ef608` and deleted in `d68b0cba4`.** It was an undismissable `AlertDialog` at the deck root, folded across every live card by `restore-gate-store.ts`. Its only close was `replay_complete`, a frame from the relay. `f698c79a8` gave it a silence deadline, and `d68b0cba4` then deleted it outright under [L33]'s second clause: "no app-wide modal may depend on anything outside the deck" (`tuglaws/no-wait-without-a-horizon.md`, "An app-wide modal whose close depends on the wire"). **(verified)** — read from git history and the law.

**[F02] The deletion's own note concedes that the modal was right about the reveal.** Here the reveal means a card's first render of its restored transcript. `tugdeck/src/components/tugways/cards/session-card-restore-gate.ts:21-56` says that mounting, laying out and measuring a reconstructed transcript "is one uninterruptible task on the single main thread every card ... shares". It adds that the app "*looks* live while it drops every keystroke on the floor", and that chunking the reveal "was tried and rejected — a transcript filling in behind the user flashes and hops". It names the successor: "armed immediately before the body's first paint and disarmed on the commit after it ... If a hang is ever reported *inside* the reveal, that is the shape to build." The user's report is that report. **(verified)** — read from the code.

**[F03] The native splash does not cover session restore.** `frontendReady` is posted at `tugdeck/src/main.tsx` right after `restoreSessions` is fired, without waiting for it. The host lifts its splash on that message (`tugapp/Sources/MainWindow.swift`, `revealWebView`). So everything a restore does on the main thread happens in front of a deck that already looks ready. **(verified)** — read from the code.

**[F04] Each restoring card has two kinds of main-thread work, and they differ in who paces them.**
- *Ingest:* `CodeSessionStore.routeFrame` (`tugdeck/src/lib/code-session-store.ts:2040-2056`) unwraps each `replay_batch` and dispatches every inner frame synchronously. The wire paces it, one batch at a time.
- *Reveal:* `TugListView` is not mounted during the first replay (`session-card-transcript.tsx`, `listMounted = replayEverCompleted || !deriveColdRestoreActive(s)`). It mounts once at `replay_complete` as a single windowed commit, then settles heights until `onFirstSettle`. Here the deck paces itself, in one task.

A boot restores every active-workspace card in parallel, so reveals can land back to back. **(verified)** that the paths exist. Which of the two holds the time the user is seeing is measured at [F07]: the reveal.

**[F05] No signal folds readiness across cards.** Each card has its own signals: `sessionRestoreRegistry` entry clearing, `transportState`, `deriveColdRestoreActive`, `replayEverCompleted`, and `TugListView`'s `onFirstSettle`. `restorePassGate` covers the whole deck but only means the bindings pass resolved. The only fold across cards was `restore-gate-store.ts`, which is deleted. **(verified)** — read from the code.

**[F06] The quiet-or-bound rule has precedent.** `tugdeck/src/lib/arrival-reveal.ts` (`arrivalRevealDue`) and `tugdeck/src/lib/space-settled.ts` both close a hold on the first of two things: the deck going quiet, or a bound running out. **(verified)** — read from the code.

**[F07] On a cold multi-card restore the reveal holds about four-fifths of the blocked main thread, and ingest about a seventh.** The reading ([B06]) is a harness probe, landed nowhere. Five Session cards, one per pane, each resumed a large real transcript (14–37 MB JSONL, 342–2,655 replayed frames) through the genuine `spawn_session(resume)` chain, all fired in one task. A rAF recorder was armed first, and a probe patch timed every `routeFrame` (its synchronous body, plus the microtask tail that carries React's sync flush), every first list commit, and every `onFirstSettle`.
- *Whole run:* 4.6 s of wall time and 14 frames over 50 ms, worth 1,726 ms past the frame budget. The reveal commits came to 1,039 ms and their settles to 376 ms, together 1,415 ms or 82%. Ingest came to 237 ms (14%), and other work to 74 ms.
- *Ingest:* `routeFrame`'s own synchronous work totalled 24 ms across all five cards. With React's flush it came to 393 ms. Its long frames are the first four, 56–117 ms each, in the 300 ms after the spawns fire, while every card binds and paints its `Z0` progress. No later replay batch makes a long frame, because the wire paces them.
- *Reveal:* each card's first list commit is one task of 82–288 ms, growing with the replayed content though only 16–20 rows are windowed. Its `onFirstSettle` follows within 90–320 ms, with a 62–136 ms settle frame directly behind the commit. So one card's reveal is a single busy stretch of roughly 150–450 ms that runs from commit to first settle.
- *Spacing:* the five reveals landed at 1.06, 1.33, 1.86, 2.25 and 2.69 s after the spawns. Each started as its own replay completed, and the deck was live for 100–400 ms between them.

The release deck's own trace confirms the single-card shape read-only: one restoring card, 1,339 frames, 11 ms of ingest dispatch inside an 84 ms window, then a 267 ms replay-to-commit and an 802 ms settle. **(verified)** — measured on 2026-10-07.

---

## Decisions {#decisions}

**[B01] Restore gets an app-wide busy cover, and its lifetime is the deck's own work, never a wait on the wire.** The cover is up only while the main thread is committed to restore work it owns. That is a reveal, and ingest too if [B06] finds it heavy. A card waiting on its relay costs the main thread nothing, so the deck really is live then. That card's own `Z0` restore strip already says it is loading, and that is honest. This answers both halves of the history. The modal was right that the reveal makes the whole app unresponsive ([F02]). It was wrong that a frame from another process could hold the app ([F01]). A cover with no wire in its close keeps the first and cannot repeat the second.

**[B02] A deck-level queue runs the reveals, and the cover rides the queue.**
- *Queue:* when a card's replay completes, its reveal is enqueued instead of running inline. The queue arms the cover, waits for it to actually composite (a double rAF), then runs the queued reveals one per task. The key card goes first.
- *Release:* the cover lifts on the first frame after the queue empties, with a linger of about one frame budget, so reveals a few frames apart sit under one appearance.
- *A reveal ends at its settle, not its commit* (from [F07]). The commit task is followed straight away by a settle frame of 62–136 ms, so an admitted reveal stays in flight until its card's `onFirstSettle`. The queue counts as empty only when nothing is queued and nothing is in flight. A card removed or errored while in flight leaves the queue the same way a queued one does, so a card that dies cannot hold the cover.

A cover armed by each card separately would blink at boot, when several replays complete close together. The queue is also what makes "before first paint" true: the cover has to be on screen before the uninterruptible task starts, or it never shows.

**[B03] Only deck-owned events close the cover: a commit, a frame, an empty queue.** Every arm is followed by a synchronous task that ends, and every disarm is the frame after it. A relay that dies mid-replay leaves its card in its own error banner (the existing `replay_stalled` / `replay_bracket_timeout` path) and never enqueues a reveal, so it cannot hold the cover. This is how the cover satisfies [L33] rather than being an exception to it. The law forbids an app-wide modal that depends on anything outside the deck, and this one depends on nothing outside it.

*Two horizons, both in the deck's own time* (settled while building the rule; [L33] asks every wait for one, and [F06] is the precedent). An admitted reveal whose settle never comes, such as a list that never reports a height, stops holding the cover after `REVEAL_SETTLE_BOUND_MS` (2000 ms). That is more than double the slowest settle measured at [F07]. An armed cover whose two frames never arrive, as in an occluded window with rAF suspended, admits its reveals anyway after `COVER_COMPOSITE_BOUND_MS` (100 ms), so a hidden window's cards are not kept behind their restore strips. The rule reads both bounds off the `now` of a frame or task the deck runs, and never off the wire. The store that drives it keeps one deadline timer at the nearer of the two bounds, because a window whose frames have stopped has no other task to carry that `now`: without it, the composite bound could never fire in the very case it exists for.

**[B04] The cover lifts between reveals even while other cards are still on the wire.** One cover held until every card has restored would have to wait on the wire again, or put a timer back, and that is the construction [L33] removed. When the deck is live, it is shown live.

**[B05] The cover inerts the deck, says "Restoring sessions…" with the titles of the cards being revealed, and shows no count.** Inerting costs the user nothing, because input during the reveal is lost anyway, and it makes the loss visible instead of silent. A count ("2 of 5") would promise something the cover doesn't keep, since it lifts while cards are still restoring ([B04]). The native menu bar is not frozen: switching `appModalOpen` on and off for each reveal is churn, and a menu action waits in the queue until the task ends.

*The cover catches the pointer; it does not set `inert`* (settled while building it). Setting `inert` on a subtree that holds focus blurs the focused element, so a restore would hand the deck back with the composer the user was in no longer focused. That breaks the one thing the cover promises, which is to say "busy" and change nothing else. The purpose of inerting was to keep input from silently landing on a deck that cannot take it. A full-deck surface that takes every pointer event does that for clicks, and `aria-busy` says it to assistive technology. Keystrokes typed during the reveal queue behind the task, as they always have.

**[B06] The first act is a reading that splits the main-thread time between ingest and reveal.** It is a cold relaunch with four or five restoring cards, with a long-task and rAF recorder armed before `restoreSessions` runs. It comes from the app-test harness, and from the release deck's trace read-only on the user's deck. [B02] is built on the reveal. If ingest ([F04]) turns out to hold a significant share, ingest gets its own answer: yielding between batches, which is safe because nothing is painted yet. Its `routeFrame` is wire-paced in any case, so it is not folded under the cover. Without this reading, the cover could be built over the wrong task.

*Ingest yielding is not built* (from [F07]). Yielding between `replay_batch` frames in `routeFrame` would split work that is already small and already split. Across five large transcripts, `routeFrame`'s own synchronous work came to 24 ms in total, and the largest single batch, with React's flush, ran 82–288 ms only because the card's reveal commit rode its microtask tail. That is reveal time, and the queue now moves it out of the ingest task. The wire already paces the batches, so no replay batch after the first 300 ms made a long frame. The four long frames that did land early, 56–117 ms each, are every card binding and painting its `Z0` progress at once in the frames after the spawns. That is mount work, not ingest, and yielding between batches would not touch it. If a later reading shows ingest growing, `perf.replay_ingest`'s `dispatchMs` is the number to watch.

**[B07] The note and the law change in the same change as the cover.** The "Nothing today needs that" paragraph in `session-card-restore-gate.ts` becomes false and is rewritten to point at the queue. `tuglaws/no-wait-without-a-horizon.md` gains the permitted shape beside the forbidden one: an app-wide cover whose close is the deck's own work. That way the next reader who sees an app-wide modal under [L33] can tell why this one stands. An unexplained exception to a law is the next deletion's target.

---

## Open Questions {#open-questions}

- ~~**How much of the freeze is ingest?**~~ **Answered by [F07]:** about a seventh, and almost none of it is `routeFrame` itself. The reveal holds the time. The arc's centre stays the cover, and ingest yielding is not built (see [B06]).

---

## Non-goals {#non-goals}

- **Bringing back `TugRestoreGate`, or a softened version of it.** A version with a Cancel button, a timeout, or a deadline keeps a frame from another process in its close. `tuglaws/no-wait-without-a-horizon.md` already rejects that construction, and this brief does not reopen it.
- **Holding the native splash until restore finishes.** That would wait on the wire behind a surface with no exit, which is the same defect one layer down.
- **Chunking the reveal so input can interleave.** It was tried and rejected because the transcript flashes and hops as it fills in ([F02]).
- **A launch-long cover across every card.** See [B04].
- **Freezing the menu bar under the cover.** See [B05].

---

## Exit {#exit}

An arc. Its first steps, in order:

1. **The reading ([B06]).** Record a cold multi-card boot and attribute the main-thread time between `routeFrame` ingest and the first `TugListView` commit and settle. Its result decides how much of what follows is built.
2. **The reveal queue and cover ([B02]–[B05]).** A deck-level queue receives each card's first list mount at `replay_complete`, arms a deck-root cover, waits until it composites, runs the reveals with the key card first, and releases one frame after the queue empties. A pure module holds the arm, linger and release rule, with unit tests, after `arrival-reveal.ts`.
3. **Ingest yielding, only if step 1 calls for it.**
4. **The note and the law ([B07]).**
5. **An app-test.** A cold relaunch with several restoring cards. It asserts that the cover is present across each reveal and absent while cards only wait on the wire, and that a card whose relay goes silent never holds the cover.
