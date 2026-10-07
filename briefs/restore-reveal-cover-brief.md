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

A boot restores every active-workspace card in parallel, so reveals can land back to back. **(verified)** that the paths exist. **Not measured:** which of the two holds the time the user is seeing. The note at [F02] and the 255 ms → 7.5 s figure for mounting the list during ingest point at the reveal, but no recording of a cold multi-card boot separates the two.

**[F05] No signal folds readiness across cards.** Each card has its own signals: `sessionRestoreRegistry` entry clearing, `transportState`, `deriveColdRestoreActive`, `replayEverCompleted`, and `TugListView`'s `onFirstSettle`. `restorePassGate` covers the whole deck but only means the bindings pass resolved. The only fold across cards was `restore-gate-store.ts`, which is deleted. **(verified)** — read from the code.

**[F06] The quiet-or-bound rule has precedent.** `tugdeck/src/lib/arrival-reveal.ts` (`arrivalRevealDue`) and `tugdeck/src/lib/space-settled.ts` both close a hold on the first of two things: the deck going quiet, or a bound running out. **(verified)** — read from the code.

---

## Decisions {#decisions}

**[B01] Restore gets an app-wide busy cover, and its lifetime is the deck's own work, never a wait on the wire.** The cover is up only while the main thread is committed to restore work it owns. That is a reveal, and ingest too if [B06] finds it heavy. A card waiting on its relay costs the main thread nothing, so the deck really is live then. That card's own `Z0` restore strip already says it is loading, and that is honest. This answers both halves of the history. The modal was right that the reveal makes the whole app unresponsive ([F02]). It was wrong that a frame from another process could hold the app ([F01]). A cover with no wire in its close keeps the first and cannot repeat the second.

**[B02] A deck-level queue runs the reveals, and the cover rides the queue.**
- *Queue:* when a card's replay completes, its reveal is enqueued instead of running inline. The queue arms the cover, waits for it to actually composite (a double rAF), then runs the queued reveals one per task. The key card goes first.
- *Release:* the cover lifts on the first frame after the queue empties, with a linger of about one frame budget, so reveals a few frames apart sit under one appearance.

A cover armed by each card separately would blink at boot, when several replays complete close together. The queue is also what makes "before first paint" true: the cover has to be on screen before the uninterruptible task starts, or it never shows.

**[B03] Only deck-owned events close the cover: a commit, a frame, an empty queue.** Every arm is followed by a synchronous task that ends, and every disarm is the frame after it. A relay that dies mid-replay leaves its card in its own error banner (the existing `replay_stalled` / `replay_bracket_timeout` path) and never enqueues a reveal, so it cannot hold the cover. This is how the cover satisfies [L33] rather than being an exception to it. The law forbids an app-wide modal that depends on anything outside the deck, and this one depends on nothing outside it.

**[B04] The cover lifts between reveals even while other cards are still on the wire.** One cover held until every card has restored would have to wait on the wire again, or put a timer back, and that is the construction [L33] removed. When the deck is live, it is shown live.

**[B05] The cover inerts the deck, says "Restoring sessions…" with the titles of the cards being revealed, and shows no count.** Inerting costs the user nothing, because input during the reveal is lost anyway, and it makes the loss visible instead of silent. A count ("2 of 5") would promise something the cover doesn't keep, since it lifts while cards are still restoring ([B04]). The native menu bar is not frozen: switching `appModalOpen` on and off for each reveal is churn, and a menu action waits in the queue until the task ends.

**[B06] The first act is a reading that splits the main-thread time between ingest and reveal.** It is a cold relaunch with four or five restoring cards, with a long-task and rAF recorder armed before `restoreSessions` runs. It comes from the app-test harness, and from the release deck's trace read-only on the user's deck. [B02] is built on the reveal. If ingest ([F04]) turns out to hold a significant share, ingest gets its own answer: yielding between batches, which is safe because nothing is painted yet. Its `routeFrame` is wire-paced in any case, so it is not folded under the cover. Without this reading, the cover could be built over the wrong task.

**[B07] The note and the law change in the same change as the cover.** The "Nothing today needs that" paragraph in `session-card-restore-gate.ts` becomes false and is rewritten to point at the queue. `tuglaws/no-wait-without-a-horizon.md` gains the permitted shape beside the forbidden one: an app-wide cover whose close is the deck's own work. That way the next reader who sees an app-wide modal under [L33] can tell why this one stands. An unexplained exception to a law is the next deletion's target.

---

## Open Questions {#open-questions}

- **How much of the freeze is ingest?** [B06] settles it. If ingest dominates, the arc's centre moves from the cover to yielding between batches, and the cover may shrink to the reveal alone or be unnecessary.

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
