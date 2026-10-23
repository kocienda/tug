<!-- brief-skeleton v1 -->

# The body lifecycle's closing tail: the catch-up's recovery paths, a bounded wait, and a ledger that says what it ran

**Purpose:** Five 360° audits have run over the body lifecycle program. The fifth, on `main` at `3d8f5a3a6`, found the host clean for the second round running, the shell and the bus clean, the guard word the card's, and the documents saying nothing the code contradicts. What it found is five edges in the catch-up's recovery paths and the ledger's wording — narrow, self-healing on the next replay or reveal, none losing work or hanging a visible card. This brief carries them as one short tail. It is the program's last document: after it lands, no further audit is owed, and the next reading of this code comes from the rows of whatever feature next touches it.

---

## Purpose {#purpose}

The user: "Brief the closing tail. Once I implement, I'll take your word that we won't need to come back here and audit again."

The word given: these are the remaining findings, each with a fix the size of a guard or a carried field and a reducer test; nothing here reaches into the ask record, the body state, the cover owner or the bus primitives, all of which held as written. The standing rules this brief answers to are unchanged: no dead code and no behaviour for tests; a decision reversed is said where it was made; a failing row's ending lives on `main` with the runs it rests on; a real fault with a fix gets fixed.

---

## Evidence {#evidence}

Baseline on `main` at `3d8f5a3a6`: tugdeck `tsc` clean; 11,742 tugdeck tests with one red outside this program (`selection-persistence-greps.test.ts`, a grep guard tripped by `atom-decoration.ts` from `4fa43f7db`); 1,004 tugcode and 4,985 Rust tests pass; the host-parity fixture is regenerated. No app-test was run; the ledger was read directly.

### The catch-up's recovery paths

**[F01] An ask that lapses under a running bracket is never recovered.** `moveCatchUp(state, "none")` (`tugdeck/src/lib/code-session-store/reducer.ts:1546-1556`) carries `asks`, `letGo`, the windows, `lastBracket` and `asleep` into the new state and drops `behind`; `askAgainIfBehind` (`:626-639`) requires `stage === "asked"`. So: ask A → an unnamed bracket X is already running (a cold-boot read, the reconnect's resume) → X is shadowed inert with `behind = {askId: null}` (`:6789`) → the 5 s deadline passes before X closes → stage `none`, `behind` null → X's close re-asks nothing. X's turns were discarded by the shadow, A stays in `asks` for the store's life (`asks` is uncapped), and the transcript is stale until the next replay. Reachable on any reveal onto a session whose running bracket outlives `CATCH_UP_DEADLINE_MS`. The `behind` doc (`:399-413`) and `effects.ts:60-70` say the in-flight drop is caught "once"; it is caught only inside the deadline. **(verified, read and probed)**

**[F02] A delivered answer to the user's own turn is discarded when the session dies.** `send` → `submitting` → the reveal asks → the turn's `assistant_text` and `turn_complete` are held → `resume_failed` + `session_state_errored`: `endCatchUpWithTheSession` (`:1697-1717`) lets the held frames go unreduced, so `committedMsgIds` lacks the turn, `pendingTurn` stays set, `scratch` holds one entry, and the card shows an un-ended cycle in `errored`. Before the fourth join the held `turn_complete` committed it; the hazard the fourth brief's [B03] closed was the queue flush that rode the commit, not the commit. The answer is recoverable only by a later replay of that session. **(verified, probed)**

**[F03] The sixteen-tombstone cap turns an evicted id's bracket into an ordinary read.** `withLetGo` slices to sixteen (`:560-562`); eighteen lapsed asks with the eighteenth answered pass seventeen over, the oldest is evicted, and its late bracket enters as a plain read: transcript `[0, 1, 2, 5, 6, 7]`, window re-based to 5. Needs seventeen unanswered asks with a bracket still in flight for the oldest; the docs (`:459-466`) do not say what an evicted id's bracket does. **(verified, probed; reachability improbable)**

**[F04] An ask made on a closed wire is recorded as owed with a frame that never left.** `handleBeginCatchUp` (`:8104-8133`) does not consult `transportState`; `body-main.ts:385` calls `catchUp()` unguarded; `connection.ts:677` drops the frame at `trySend`. Stage `asked`, deadline armed; `endCatchUpWithTheWire` (`:8206`) passes through because the wire is already offline, so the fourth brief's [B04] "a `transport_close` lets it go" never fires for it. Recovery is the reconnect's resume read — shadowed inert, discarded, its close re-asked through `askAgainIfBehind` (store-level probe: two asks sent) — so two reads for one reveal, or [F01] if the resume read outlives 5 s. tugcode's own `replay_in_flight` drop (`tugcode/src/replay-runner.ts:418-424`) still only logs; tugcast tells only queue drops (`session.rs:1174`, `spawn.rs:632`, `mod.rs:1696-1708`). **(verified, probed; live reachability by reading)**

**[F05] Two exits untested; two docs overclaim.** `transport_close` inside an open bracket (probed correct, untested) and a wire `error` while `asked` (no exit; stage stays `asked` until the deadline, and the deadline flush sends — `wire_error` is not in `sessionIsGone`, which is right since the session is there). `endCatchUpUnanswered` (`:1655-1657`) records a committed turn on every owed ask, not "every ask whose window it falls inside" as the fourth brief's [B01] and the `heldTurns` doc (`:505-514`) say; harmless, since older asks have older windows. `dispose` leaves `stage === "asked"` and `asks` populated on the dead store; timers are cleared, so inert, and the fourth brief's "pruned on dispose" was not done. A reader cannot learn from the types that `behind` is forgotten at the deadline or that `asks` is uncapped. **(verified, read)**

### The guard word

**[F06] A hung guard-word PUT blocks a card's revive for ever.** `body-shell.ts:1692-1696` adds the card to `wordsWriting` and removes it only in `.then`; `reviveWanted` (`:1769`) skips the card while it is there. `putGuardWord` (`settings-api.ts:729-736`) chains a bare `fetch` with no timeout; `writeGuardWord`/`deleteDefault` catch rejections, so a rejected PUT settles and does not poison the chain, but a fetch that never settles — tugbank stalled, not dead — leaves the card `evicted` with no Reload affordance (`setBodyReloader` serves `failed` only). A second eviction of a card whose first PUT failed writes nothing (`keep` short-circuits on the store's `true`), so the word is in memory only and never retried. **(verified, read; the stall is inference)**

### The host's residue

**[F07] Log accuracy and a slow set.** A not-live covered body dropped from the solve is still sent `solve: true` (`BodyBeatsRunner.swift:256-261`); when its page later answers, `crossingSolved` (`:519-531`) finds it absent from `awaited` and logs "solved after its plan started" even while the plan is still waiting on other cards. `isLive` is `.ready || .evicting` (`BodyState.swift:65`), so a `.bound` page is dropped too and its `crossingSplit` never recorded. `landedSolving` (`card-placement.ts:1022, 1571`) is cleared only by the next plan or a `crossingOf` read that finds no mirror; no destroy path touches it, so a card closed while in it leaves its id for the shell's life (ids are unique; no wrong answer, a slow set). `(.bind, .ready)` now tells a self-reloaded visible page `shown: false` at bind and `true` at paint, one dormant→shown round and a catch-up ask it did not do before (cosmetic; the cover-at-new-paint fix is right). **(verified, read)**

**[F08] `holdSelectionThroughFocus` can override a user's own caret-to-0.** `state-preservation.ts:316-339` treats any `selectionchange` that leaves the state collapsed at 0 on the same doc, inside `FOCUS_COLLAPSE_WINDOW_MS` (300 ms) of a refocus, as WebKit's placement and snaps back to `held`. A click at the document start or ⌘↑ inside that window is undone. Bounded; the listener and timer self-clean. `paintMirrorAsActive` (`:293-298`) dispatches a selection transaction even when unchanged, so update listeners run on every activate. **(verified, read)**

### What holds

The ask record: one tail owed to two asks is replaced once by the first answer, stripped from the second's list, deduped by the second, and the window keeps its start; `askNamed` runs before `wasLetGo` and an id is never in both; `answering` clears on every open→none; `sessionIsGone` is consulted at all seven flush sites; the ghost row's ✕ restores the text to the composer and the queue survives a rebind through `exportQueuedSends`/`seedQueuedSends` without a double send; tugcast publishes `spawning` from one site per spawn, so the once-per-spawn re-arm is sound; the engine sends the ask from its own reduction. The bus: `forgetPage` keeps every shell-owned card store and says each dropped envelope; `forgetCard` only on destroy; a late `failed` for a gone card is fenced. The host: the drop-from-solve is applied to the `PlanSolve` before it is registered; `retaken` re-stamps and the old timer finds no match; `(.bind, *)` brings the cover down at the new paint; `WarningSteps` runs one chain through either level sequence; a taken spare arms its clock at the take; the split crossing cover is a second view of the one `Stand`, not a second owner. The documents: the third brief's [B08] amendment, the README's record section, [D221]. No test-only product code; no dead code; L01, L03, L06, L09, L22, L26, L27, L31, L39, D215, D217 and D219 hold on every touched file, and L02's one bend is an idempotent ref write inside the stand-in's `getSnapshot`.

### The ledger

**[F09] Two README claims the ledger does not bear out.** "Run alone three times on a clean `main` HEAD (`dirty=0`)" for rows 17-split, 28 and 10 (`tests/app-test/body-grounding/README.md:131-134`): runs 8962–8970 are at `56ba8fecd`, an arc commit, on the arc worktree, `dirty=0` — honest runs, wrong tree named. at0024's final 4/4 (9021–9028) is at `8da77caad` `dirty=1`, the blur fix uncommitted. "Lifecycle rows 35–46 ran together on the final tree" (`:190-195` and the join's Verified paragraph): run 8999 is at `c56dae0d8`; after it `8da77caad` and `a657229b6` changed `tug-text-editor.tsx` and `state-preservation.ts`, which a restored Session draft runs through (row 38-evicted, row 39 with its draft), and the replay moved the base to `05f38929f`; `git diff --stat c56dae0d8 3d8f5a3a6` is 17 files. Nothing has run on `main` since the join. **(verified, ledger)**

**[F10] Smaller mismatches.** Row 1's contention finding says "batches of 6 to 70"; the ledger has reds at batch sizes 2 (×2), 4 (×2), 6, 16, 20, 21 and 42–70 (since 10-20: alone 17 P / 1 F, batch 56 P / 23 F); its bar is restated — paint-within-burst is no longer bounded (`_row-01.ts:289-305`; a body painting at 29 s passes under `BODY_READY_MS`) — which the README says plainly, and the probe is waived with a reason (no last-green/first-red pair exists). Row 33 "red alone 4 of 9 at `60b605be7`" is 2 F / 2 P alone, 6 of 9 counting batches, and all at `dirty=1` before `389770768`. Row 17-split "green alone from `97a58cd2a` on" omits a batch-9 red at that sha. Row 10-away's cited `50beb0243` never ran it; its reds are at `c0417b7aa`. The fold row's `awaited === false` (`row-38-evicted-fold.test.ts:139`) can fail and did (red alone ×4 at `1574f3ad7` before the drop landed), but its target search falls back to any covered body, so a page already bound at the fold makes the assertion trivially true with only a `note` saying which case ran; it has one alone-green on its final shape. **(verified, ledger and read)**

---

## Decisions {#decisions}

**[B01] A bracket that outlives the deadline is the catch-up's answer, and `behind` survives the deadline.** `moveCatchUp(…, "none")` carries `behind` as it carries `asks`; `askAgainIfBehind` runs on a `replay_complete` for the bracket `behind` names whether the stage is `asked` or `none`, so an ask that lapsed under a running read is re-asked when that read closes. Better: a running unnamed bracket met while `asked` is adopted — entered as the catch-up's own with `answering` set and the ask's `keepsWindow` — rather than shadowed, since it is a read of the same session that began before the ask and carries at least what the ask wanted; the deck then needs no re-ask at all. The door picks the adoption if the window arithmetic is clean (the running bracket's window must cover the ask's), the carried `behind` otherwise. Either way an ask let go this way is tombstoned, `asks` is pruned, and the `behind` and `effects.ts` docs say exactly when the drop is caught. Closes [F01], and most of [F04]'s second half; a reducer test drives a running bracket that closes after the deadline and asserts the turns land once and the window keeps its start.

**[B02] Held frames are reduced on session death with the queue flush suppressed.** `endCatchUpWithTheSession` reduces the held frames under a flag that `handleTurnComplete` and every flush site read as "no send", then runs the death handler. A completed answer the wire delivered is committed; the user's cycle ends; nothing is written to the gone session. The fourth brief's [B03] is amended to say the frames are reduced, not let go, and why. Closes [F02]; the reducer test for `send → reveal → held tail → resume_failed` asserts the turn committed, the cycle ended and no `send-frame`.

**[B03] No ask on a closed wire.** `handleBeginCatchUp` refuses when `transportState !== "online"` and the body's `catchUp()` reads the refusal; the reconnect's resume read serves as the catch-up through [B01]'s adoption. tugcode emits `replay_dropped {ask_id}` on its `replay_in_flight` drop as tugcast does for a queue drop, so the deck ends that ask at once rather than at the deadline. Closes [F04]; reducer tests drive the offline reveal and the in-flight drop.

**[B04] The tombstone cap and the dispose are said and done.** `letGo`'s doc says an evicted id's bracket is an ordinary read and why sixteen is enough (the cap bounds a card's unanswered asks, which [B01] and [B03] now prune); `dispose` empties `asks` and `letGo`. `endCatchUpUnanswered`'s doc and the fourth brief's [B01] say a held turn is recorded on every owed ask, not by window. Tests for `transport_close` inside an open bracket and a wire `error` while `asked`. `CatchUpState`'s header says that `asks` is pruned by [B01]/[B03] and what `behind` survives. Closes [F03], [F05].

**[B05] The guard word's write is bounded.** The `evicted` handler races the PUT against a deadline (the same `CLOSE_DECISION_MS` order of magnitude; one constant beside it) and revives the card on the earlier of the write landing or the deadline, logging a late write; a card whose PUT failed is retried on its next eviction (`keep` compares against the durable copy's last known state, not the store's `true`). Closes [F06]; `kept-guard-word.test.ts` gains the never-settling PUT.

**[B06] The host's residue.** A body dropped from the solve is not sent `solve: true`, so its later answer is a plain `crossingReady` and the "solved after its plan started" warn fires only for a body the plan awaited; `.bound` counts as live for the solve (its JS is up) so its split is recorded. `landedSolving` is cleared on the card's destroy beside `inFlight`. `(.bind, .ready)` keeps `seen` so a self-reloaded visible page is told `shown: true` at bind, not `false` then `true`. `holdSelectionThroughFocus` yields to a `selectionchange` that arrives with a user gesture in flight (a `mousedown`/`keydown` seen since the refocus), and `paintMirrorAsActive` dispatches only when the selection changed. Closes [F07], [F08].

**[B07] The ledger record says what it ran, and the final tree is run.** The README's record names the worktree and sha for every cited run, so "clean `main`" is written only where `base_root` is `main`'s checkout and `dirty=0`; row 1's batch sizes list every red's batch; rows 33, 17-split and 10's sentences are corrected to the ledger's counts and shas. The lifecycle rows 35–46, at0024 and the fold row run once on this arc's final tree (`dirty=0`, after the last edit) and are recorded; the fold row names the case it ran in its assertion, not a `note` — it fails when the page was already bound at the fold, since that is not the case the row exists for. Closes [F09], [F10].

---

## Open Questions {#open-questions}

- **[B01]'s adoption versus the carried `behind`.** Adoption is the simpler machine (no re-ask, one read) and the cleaner story for a reader; it depends on the running bracket's window covering the ask's, which a cold-boot read always does and a load-previous read may not. The door decides from the window check in `handleReplayStarted`; if a running bracket's window can fall short of the ask's, carry `behind` and re-ask.

---

## Non-goals {#non-goals}

- **Another 360° audit after this arc.** The program is closed when this lands; five audits have converged, and the ask record, the body state, the cover owner and the bus primitives all held as written in the fifth.
- **A cap on `asks` as a safety net.** [B01] and [B03] prune it; a cap would hide a leak instead of closing it.
- **Re-pointing any row.** [B07] corrects the record's sentences to the ledger; no assertion moves.

---

## Exit {#exit}

**An arc.** In order: [B01] and [B03] (the two recovery paths, decided together since [B03] leans on [B01]'s adoption, with their reducer tests red first); [B02] (held frames reduced under a suppressed flush, with its test and the amendment); [B04] (the docs, the dispose, the two exit tests); [B05]; [B06]; [B07] last, since its runs on the final tree judge everything above and close the record.
