<!-- brief-skeleton v1 -->

# The body lifecycle's fourth fixups: an ask that owns its turns, a guard word that survives a failed page, and the endings written where they count

**Purpose:** The third fixups arc (`9da7ffce2`) named every catch-up ask, gave covers one owner and the guard word a durable home, and said the dropped assertions out loud. A fourth 360° audit on `main` at `9ac7e1467` found the host clean for the first time, the shell clean bar one seam, and the catch-up carrying a narrower version of the fault each earlier round fixed: the ask id solved the inferred drop, and a flat list of held turns reintroduced an ordering fault one level down. It also found the red rows' endings written in an arc step commit the squash left off `main`. This brief carries every finding, most important first, and is meant to be the last of this program.

---

## Purpose {#purpose}

The user asked, "One more time.... hopefully the last time.... Do we need to make fixups? Or, can we move on from here with confidence that the codebase is in good shape?" The answer: one more small round, scoped to exactly what follows, and then the program is closed without another full audit.

The standing rules this brief answers to: no dead code and no behaviour that exists for tests; a decision reversed is said in the open where it was made; a failing test has three endings, "known red" and "cause not identified" are not among them, and an ending lives on `main` or it is not an ending; a real fault with a fix gets fixed.

---

## Evidence {#evidence}

Baseline on `main` at `9ac7e1467`: tugdeck `tsc` clean; 11,729 tugdeck, 1,004 tugcode and 4,985 Rust tests pass. No app-test was run; the ledger was read directly. Another live session held 12 uncommitted edits during the audit; HEAD was audited.

### The catch-up's ask record

**[F01] A late answer puts a newer turn ahead of an older held tail.** `heldFor` is one flat list for all `heldTurns` (`tugdeck/src/lib/code-session-store/reducer.ts:443-449`, `:1555-1556`), not per-turn as the join message claims ("each held turn records the asks it waits on"). `handleTurnComplete` stamps every non-held turn of an open catch-up with `before: heldTurns[0]` (`:4393-4394`) and the engine inserts it ahead of that id (`session-engine.ts:1308-1312`). Probe: ask A lapses with tail 3 held → reveal, ask B (window after 3) lapses with tail 5 held → `heldTurns [3, 5]`, `heldFor [A, B]` → B's late answer carrying 4 and 5 whole ⇒ transcript `[0, 1, 4, 3, 5]`. Turn 4 lands before 3. Any card that lapses twice before an answer. **(verified, probed and read)**

**[F02] A send queued while `asked` is written to a session that just died.** `endCatchUpWithTheSession` (`reducer.ts:1580-1598`) calls `endCatchUpUnanswered`, which replays the held frames through `reduce` (`:1544-1547`) *before* the `resume_failed`/`session_state_errored` handler runs; a held `turn_complete` is a turn boundary, and `handleTurnComplete` flushes the queued head unconditionally (`:4475-4490`). The `sessionIsGone` guard the third brief's [B01] added (`:1508-1530`) sits in `sendWhatWaitedOnTheCatchUp` and is never consulted on this path. Probe: `catchUp → send → wake_started + tail → resume_failed` ⇒ `send-frame: 1, queued: 0, phase: submitting`; the prompt reaches tugcast's `request_replay.skipped reason=errored` and is lost. `catch-up.test.ts:925` queues no send; `:1002` covers only the `open` stage. **(verified, probed and read)**

**[F03] An answer to an ask already let go re-bases the window.** `askNamed` returns null for an ask removed from `asks` — answered by a later ask (`owed = slice(at + 1)`, `reducer.ts:509-510`) or cleared by `endCatchUpWithTheSession` (`:1588`). On a settled card such a bracket is entered as an ordinary read (`handleReplayStarted`, `:6650-6665`: neither `answersCatchUp` nor `aheadOfAsk`) and its close takes the reported window. Probe: A lapses, B asked and answered, then A's bracket `{7, 9, hasOlder}` ⇒ `replayWindow 2 → 7` while the transcript holds 2–8. Reachable: tugcast `push_front`s every `request_replay` during `Spawning` (`session.rs:951`), so two asks queued in one spawn window reach tugcode in reverse; a B that closes before tugcode reads A answers A late. `catch-up.test.ts:913` asserts the re-base as intended — the test enshrines the hole. **(verified, probed; reachability by reading)**

**[F04] The spawn re-arm is unbounded.** `handleSessionSpawnState` (`reducer.ts:8023-8027`) re-arms the deadline on every `spawning` *and* `live` frame while `asked`; probe: 50 flapping frames ⇒ 50 arms, stage still `asked`. A session that respawns faster than 5 s keeps the catch-up, and the `canSubmit`-blocking queue, alive until `session_state_errored`. **(verified, probed)**

**[F05] A dropped or lost ask is never told, and its record leaks.** `drop_queued_replays` (`session.rs:1174`, on reset) and a frame written to a closed socket (`transport_close` while `asked`: stage stays `asked`, no `catch_up` timer cancel) are silent. The deadline covers the wait, but the ask stays in `asks` until some later ask is answered — one small record per unanswered ask, otherwise never pruned. While `asked`, the reconnect's unnamed full-resume bracket is shadowed inert (probe: 8 turns discarded), and recovery rests on `askAgainIfBehind` (`:531-554`). **(verified, probed; the leak is by reading)**

**[F06] Exits with no test.** `transport_close` while `asked`; a send queued while `asked` then `resume_failed` ([F02]); `session_unknown`/`session_not_owned` in either stage (their causes are not in `sessionIsGone`, so a deadline flush goes to a session tugcast has forgotten); a spawn flap past one re-arm ([F04]); two held tails ([F01]). Everything else — every named exit, the single-tail replacement, the refused reveal, `keepsWindow` on the ask — is tested as a guarantee. **(verified, read)**

**[F07] Leftovers and misleading names.** `keepsWindow` lives on both `CatchUpState` (`reducer.ts:406`) and `CatchUpAsk` (`:486`); the state copy is a cache set at open. The `behind`/`reask` docs (`:388-399`) still describe the inferred drop ("tugcode may have dropped the ask"). `events.ts:1349` ("deduped against what the card holds") predates replacement. `heldTurnsAnswering` (`:518`) is all-or-nothing over a shared list — its name promises a per-ask selection it cannot make. `catchUp()` (`code-session-store.ts:1288`) reads `asking` from the pre-dispatch mirror; correct in process, and the comment above says the mirror can trail. **(verified, read)**

**[F08] What holds.** The ask id is minted in one place, crosses deck → tugcast (live and front-queued, tested) → tugcode, and is echoed on every close including aborted, timeout, exited and the exception backstop; the stub echoes it; an unnamed bracket is read as unasked. A single held tail is replaced in place and ordered correctly; the window keeps its start. `lapsed` is gone and `keepsWindow` rides the ask; a refused reveal asks nothing. **(verified, read and probed)**

### The guard word

**[F09] A `failed` body report erases the kept guard word in memory and strands the durable copy.** `body-shell.ts:1711-1712` (`case "failed"`) calls `bus.detach` then `bus.forgetCard(cardId)` while the card stays a body card. `bus/shared-store.ts:359-362` deletes every card-scoped entry on a forgotten card, owner or not — `card.guardAsks` (shell-owned, no `clearOnDetach`) included. A dirty Text card evicted under critical pressure, revealed, whose page fails to come up: `keptWords.asks()` reads the initial `false`, so the shell's held guard reports no decision and `askCloseDecision(cardId, false)` runs under `CLOSE_DECISION_MS` instead of a person horizon; the next page's guard still finds the dirty buffer, so the sheet comes up — and times out to the "didn't answer" banner. `closed()` → `keep(false)` sees `false` and returns without a DELETE (`kept-guard-word.ts:51`), so the durable `true` outlives the card until the next boot's sweep. **(verified, read)**

**[F10] The eviction's PUT is fire-and-forget.** `settings-api.ts:707-719` PUTs without awaiting and `body-shell.ts:664` discards the promise; a crash between the `evicted` report and the PUT landing loses the word, which the docblock admits "costs only a deadline". A PUT `true` and an immediate Option-close's DELETE are two unordered fetches; a late PUT leaves a durable `true` for a closed card, swept at the next boot. **(verified, read)**

**[F11] The third brief's [B08] said "persisted beside the binding"; the join made a separate card-keyed domain** `dev.tugapp.deck.guardasks` (`settings-api.ts:32`, in `CARD_KEYED_DOMAINS` so the startup sweep prunes it). Reasonable, and the brief carries no amendment. A save-mode flip manual → automatic on an evicted card with a word leaves `heard` never clearing (`kept-guard-word.ts:61`); the close still resolves (`body-verbs.ts:167-170`), only the chrome's "asks" is wrong. **(verified, read)**

### The host

**[F12] A covered body whose page is not yet bound is awaited by the solve to the guard.** `canShow` (`BodyViewController.swift:246-249`) is true for any covered body, `.loading`/`.connected` included (the lane stands the cover before hello: `BodyLane.swift:149`). Plan intake (`BodyBeatsRunner.swift:118-121`) accepts it and `coverForCrossing`'s `.standing` branch (`:237-246`) sends `bodyCrossing(solve)` to a page with no JS and leaves the body in `solve.awaited`; only `.keepsPage` calls `dropFromSolve` (`:304-309`). The plan starts only when the 250 ms guard runs out (`startPlan(timedOut: true)`, `:465`). Fold a card brought back under its cover before its cold page binds; the new fold row binds the page first and does not see it. **(path verified; trigger by reading)**

**[F13] A re-kept cover is aged by its first keeping's timer.** `BodyCovers.swift:112-130` arms a timer keyed on `takenAt`; a cover stood over a body and evicted again before the page paints is re-kept with its original `takenAt` (`BodyLifecycle.swift:347-351`), so the first timer drops it at the original deadline. A stand-in arrival instead of a cover. **(verified, read)**

**[F14] `(.bind, .evicting)` and `(.bind, .ready)` keep a stale `painted`.** `BodyState.swift:86-87` moves to `.bound` without resetting `painted`/`shownOnce` (contrast `.reload`, `:109-112`); a page that says hello again then posts `painted`, which `(.paint, .bound)` refuses, so `didPaint` returns before the cover take-down and `canShow` shows the fresh page before its first frame. A flash; `testAPageBoundAgainMidEvictionAbandonsTheEviction` (`BodyStateTests.swift:127`) does not assert `painted`. **(verified, read)**

**[F15] Two warning step chains after warning → normal → warning inside one eviction's 2 s.** `BodyLifecycle.swift:164-182, 264-281`: a level change clears `pendingWarningStep` but not `warningStepping`; a non-repeated warning calls `evictOldestHidden` while the earlier step's `done` is pending, both `done`s schedule a step, the second overwrites the first's reference without cancelling it. Two evictions per beat for the rest of the episode. **(verified, read)**

**[F16] What holds.** One cover owner: one `Stand` per body, two `addSubview`s of a cover view and the second reuses `body.cover`; later-of-paint-and-land take-down, cancel and destroy covered; `painted` gated before any crossing snapshot; standing covers counted in `bytes`; the eviction path reads the generation before its snapshot. `clockArms`/`clockFalls` are the only arming gate; `(.bind, .evicting)` abandons cleanly; repeated warning continues its episode; `BodyLane.make` reports `failed` and the shell retries bounded. No leak, no test-only code, no env door. **(verified, read)**

### The red rows

**[F17] The endings are not on `main`.** The arc step commit `0ea2bb5cd` ("Give each red row its ending") records them: `row-17-crossing-split`, `row-28-deck-facts`, `row-10-workspace-kinds-away` and `at0024` "fixed before the base, green 3/3 alone" with no fix named; `row-25` changed (same guarantee); `row-33` fixed in code; `row-01-arrival-cold` "1/3 red on base (a dark frame, slow body), 9/9 green alone on the arc tree, **cause not identified**". The squash kept only the three code changes; `main`'s commit, `tests/app-test/body-grounding/README.md` and the brief carry none of the others, and nothing names a batch size. Row 1's ending is none of the four. **(verified, `git show 0ea2bb5cd`, README grep)**

**[F18] The join misstates the batch-of-25 result.** Run 8906 (`f1e12a702`, 25 files) had three reds: `row-44-switch-first-visit`, `row-33-arrangement`, `at0140-cycle-session-card` (0/5). Rows 44 and 33 were green alone straight after; `at0140` was red alone twice more (2/4, 2/4), then edited and green once. "Two were red, both green alone straight after" drops `at0140`. Every "on the base" run is `dirty=1` at an arc sha (`f1e12a702` landed 16:42:23, first "base" run 16:44:17), so the ledger cannot distinguish a probe run from an arc-tree run, and row 33's promised reverse-diff probe is recorded nowhere. **(verified, ledger)**

**[F19] Rows with thin evidence on the final shape.** `row-38-evicted-guarded`: red alone at 16:20 during the reload leg's development, then green only in batches; no alone-green on its final shape. `row-33-arrangement`: 15 alone runs in 12 minutes (10 F / 5 P) before 3 greens, then red in the 25-batch and green alone — still batch-sensitive after its fix, no contention finding written. `row-25`: one green alone after its change. Nothing but the five row-35 files ran on the final tree. **(verified, ledger)**

**[F20] The fold row proves its bar from the cover account, not pixels.** `row-38-evicted-fold.test.ts:124-129` asserts `wasCovered`, `cover === "standing"`, `snapshotMs === null`, `restored`, `covered: false` after land; it reads no frame, while README `:106` marks its Session column ✓. Its target search (`:107-112`) is a tight loop with no sleep. **(verified, read)**

### Small

**[F21]** `closeRefusalStore.isRefused` (`close-refusal-store.ts:43`) has no product caller after `card-host.tsx:710` moved to `reasonOf`; only `close-decision.test.ts` reads it. `tugtool apptest history` strips `./` and `tests/app-test/` (`apptest_ledger.rs:363-366`) and still answers `no-history` for an absolute path. `body-stand-in.tsx:112` reads `deckCards.getSnapshot()` inside the memo — consistent within the render, [L02]-impure in letter. **(verified)**

### Laws

L01, L03, L06, L09, L22, L26, L27, L39, D215, D217 and D219 hold on every touched file. L02: holds, one letter-impure read ([F21]). L31: improved (a detach now shows a reason); [F09] reopens one wrong-banner case.

---

## Decisions {#decisions}

Most important first.

**[B01] An ask owns its turns.** `CatchUpState.asks` becomes the one record: `{id, window, keepsWindow, heldTurns}`, and `heldTurns`/`heldFor` leave the state. A turn held at a deadline is recorded on every ask owed at that moment whose window it falls inside. A bracket answering ask X replaces, in place, exactly the held turns recorded on X and puts the turns the card never saw ahead of the *earliest* of those; held turns recorded on other asks keep their place; a bracket for an ask made after a tail stood lets that tail go. `heldTurnsAnswering` goes, replaced by a per-ask lookup. Closes [F01]; a reducer test drives two lapsed asks with two tails and asserts `[0, 1, 2, 3, 4, 5]` once each with the window's start unchanged.

*Amended by the closing-tail brief's [B04]:* a turn held at a deadline is recorded on **every ask owed at that moment**, not only those whose window it falls inside — `endCatchUpUnanswered` never compared windows. That is the same set in practice, since every owed ask was made before the turn ended and an older ask asked for an older window, which holds it; the code's docs and this decision now say so. "Pruned on dispose" is now done: the store's `dispose` empties the catch-up, its owed asks and its let-go ids with it.

**[B02] A bracket for an ask that was let go is shadowed, never entered.** A let-go ask leaves a tombstone (its id, pruned when the catch-up ends with nothing owed or on dispose) so that `askNamed` can tell "an ask this card made and let go" from "an ask this card never made"; a bracket naming a tombstoned id is shadowed inert and its close re-bases nothing. An unnamed bracket on a settled card stays an ordinary read. Closes [F03]; `catch-up.test.ts:913` is reversed in the open — its new assertion is that the window keeps its start — and a test drives the `Spawning` reversed-order case.

**[B03] Session death ends the catch-up before any held frame moves, and nothing is sent to a gone session.** `endCatchUpWithTheSession` lets the held frames go without reducing them — the session that would have answered is gone, so a held tail cannot be completed and a turn boundary cannot be claimed from it — and runs the handler on a catch-up already at `none`. `sessionIsGone` gains `session_unknown` and `session_not_owned`, and every flush site, `handleTurnComplete`'s included, consults it. A queued send on a gone session stays queued and is surfaced as the composer's "session ended" state, which the rebind path already sends from. Closes [F02]; reducer tests drive a send queued in `asked` then each of the four death causes and assert no `send-frame` and the send still queued.

*Amended by the closing-tail brief's [B02]:* the held frames are now **reduced** on session death, not let go. Letting them go discarded an answer the wire had already delivered — a `send` whose `assistant_text` and `turn_complete` were held behind the reveal's ask left the turn uncommitted and the cycle un-ended in `errored`. The hazard this decision closed was the queue flush riding the commit, not the commit itself, so `endCatchUpWithTheSession` reduces the held frames under `sessionGoing`, which `sessionIsGone` reads, and every flush site and the steering pickup therefore send nothing to the session that died. The queue still stays queued for the card's next session.

**[B04] The spawn re-arm is bounded, and a lost ask is let go.** The deadline is re-armed once per spawn, from the first `spawning` frame after the ask, never from `live`; a second `spawning` without an intervening answer is a flap and ends the catch-up as its deadline would. A `transport_close` while `asked` ends the catch-up the same way (the ask cannot be answered on a wire that closed), and tugcast's `drop_queued_replays` sends `request_replay_dropped {askId}` so a reset ends it at once rather than at the deadline. An ask ended any of these ways is pruned from `asks`, with a tombstone per [B02]. Closes [F04], [F05]; reducer tests drive the flap, the close and the drop.

**[B05] Every exit has a test, and the names say what the code does.** Tests for every path in [F06]. `CatchUpState.keepsWindow` goes (the ask's is the one); the `behind`/`reask` docs say the re-ask is a named ask's deadline, not an inference; `events.ts:1349` says replacement; `catchUp()` reads the reducer's refusal from the dispatch result rather than the mirror. Closes [F06], [F07].

**[B06] A shell-owned card store survives a forgotten card.** `bus.forgetCard` deletes a card-scoped entry only when the page owns it; a shell-owned store (`card.guardAsks`, and any other with `owner: "shell"` and `scope: {card: true}`) keeps its value across `failed`, as it does across `evicted`. `seedCard` after a `failed` re-sends what the shell owns. The eviction's PUT is awaited by the `evicted` handler before it reports the card revivable (it is one write, and the cost of losing it is a lost confirm); a PUT and a DELETE for one card are serialised through one per-card promise chain. The save-mode flip clears `heard` when the page publishes `closeGuardAsks: null` for a card with a standing word. The third brief's [B08] is amended: the word lives in its own card-keyed domain, pruned by the sweep, and why. Closes [F09], [F10], [F11]; `kept-guard-word.test.ts` gains the `failed` case and the mode flip, and row 38-guarded gains a failed-page leg.

**[B07] The solve never awaits a page that cannot answer.** `coverForCrossing`'s `.standing` branch calls `dropFromSolve` when `!body.life.isLive`, keeping the cover; the plan starts without waiting on it. A re-kept cover takes a fresh `takenAt` (`finish` re-stamps it), so it gets a whole delay. `(.bind, *)` resets `painted` and `shownOnce` as `.reload` does, and the mid-eviction rebind test asserts it. A level change cancels the standing warning step (`warningStepping` cleared with `pendingWarningStep`), so one chain runs per episode. Closes [F12]–[F15]; Swift unit tests for each, and the fold row gains a leg that folds before the page binds.

**[B08] Every red row's ending lives on `main`, with its evidence.** The body-grounding README gains, per row, its ending and the runs it rests on (alone count, batch sizes, sha): rows 17-split, 28, 10 and at0024 either name the commit that fixed them (found by `git log` over the files their failures read) or are run alone three times on a clean `main` HEAD (`dirty=0`) and recorded as green there; row 1 gets a real ending — a reverse-diff probe of the landings between its last green and its first red, read against the "dark frame, slow body" failure, and the defect fixed or the row's bar restated for a slow cold arrival with the reason; `at0140`'s three reds are said and its popover read is run alone three times on its final shape; rows 33 and 38-guarded are run alone three times on their final shape and recorded; the "two were red" sentence is corrected in the README's record. A row still batch-sensitive after its fix is recorded as such with the batch sizes — a written contention finding is an ending, a sentence in a step commit is not. Every lifecycle row 35–46 runs once on the final tree (`dirty=0`) and is recorded. The fold row reads frames: its bar is the row-44 judge over the fold's frames, or the README's Session column is un-ticked and says the bar is the cover account. Closes [F17]–[F20].

**[B09] The small faults.** `closeRefusalStore.isRefused` goes. `apptest history` canonicalises an absolute path under the checkout to the report's spelling. `body-stand-in.tsx`'s memo takes `deckCards` through the hook it already has. Closes [F21].

---

## Open Questions {#open-questions}

- **[B03]'s "nothing is sent to a gone session" needs a surface for the queued prompt.** The composer already shows a session-ended state after `resume_failed`; whether the queued text is restored into the composer (so the user sees it and sends again) or held in the queue for the rebind is the one product choice here. Restoring it is the more honest default — a queue the user cannot see is the [L31] silence case — and the brief records that as the choice unless the door hears otherwise.
- **[B04]'s `request_replay_dropped` is a new tugcast → deck frame.** The alternative is letting the deadline cover a reset, which it does today at a 5 s cost and a leaked record; the frame is small and the reset path is the one place tugcast knows. If the wire cost is judged too high for one case, [B04]'s pruning on `transport_close` and the flap bound still land, and the reset case keeps its deadline.

---

## Non-goals {#non-goals}

- **Another audit of the host.** It came back clean; [B07] is four small edges.
- **A redesign of the catch-up.** [B01] is the design the sub-state always implied — the ask record owning its turns — not a new one.
- **Re-pointing a red row.** [B08]'s endings are a fix, an honest change, a deletion, or a written contention finding with batch sizes on `main`.
- **A fifth 360° audit.** After this arc lands, the program is closed; the next reading of this code is whatever the next feature's own rows say.

---

## Exit {#exit}

**An arc.** In order: [B01] and [B02] (the ask record and the tombstone, with their reducer tests — the two-tail case and the reversed-order case first, red before the change); [B03] (session death before any held frame moves, and the gone-session guard at every flush); [B04] and [B05] (the bounds, the dropped-ask frame, the exit tests, the names); [B06] (the shell-owned store across `failed`, the awaited PUT, the amendment); [B07] (the four host edges, with their Swift tests and the fold leg); [B09]; [B08] last — the endings on `main`, the alone runs on the final tree, the fold row's frames — since its runs judge everything above.
