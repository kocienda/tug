# The compaction run settles by derivation, not by witnessing an edge

**Purpose:** A `/compact` the wheel sent finished, the arc resumed and ran a whole implement turn, and the Compacting sheet and its scrim stayed up over the card for eleven minutes. The run's settle depends on a listener personally seeing the turn go idle, and a card that slept through the turn's end never sees that.

---

## Purpose {#purpose}

The user's report, over a screenshot of the `silly-home` card at 15:04 on 2026-10-29: "`@session:tug/silly-home` was running tests *and* compacting at the same time? That shouldn't happen." The card showed a Bash block running `just app-test …` beneath a modal **Compacting** sheet with a barber-pole bar and a Cancel button. After the investigation: "The compact seems to have happened and the arc resumed — just nothing ever took down the Compacting sheet and scrim. This is the bit we need to tease out. The state management needs work here. Can't get out-of-phase here."

Claude Code was not compacting during the tests. The compaction had finished eight minutes earlier. The sheet was the leftover of a run the deck had opened and never closed.

---

## Evidence {#evidence}

**[F01] The compaction itself was ordinary and finished at 14:56:09.** — The implement session's transcript (`3b2be3be-05fa-4aee-8cdd-626fdc382334.jsonl`) carries a `compact_boundary` at 14:56:09.028 with `trigger: "manual"`, `preTokens: 605470`, `durationMs: 48294`, preceded by the `/compact` command echo queued at 14:55:20.735 and followed by the wheel's next prompt (`/tugplug:arc-implement … resume Step 5`) at 14:56:14.577. The tugcast log (`instances/release-main/Logs/tugcast.log.2026-10-29`) shows `arc.prompt kind=prompt:compact` at 14:55:20.728 and the compact turn's `turn_complete` journal row at 14:56:09.459. **(verified)**

**[F02] The turn under the sheet in the screenshot was the implement turn, not the compaction.** — The sheet's card showed `TIME 7m 58s` and `CONTEXT 215.1K`; 14:56:14 + 7m58s ≈ 15:04:12, two seconds before the `just app-test` call the transcript records at 15:04:14, and 215K is the post-compaction window. **(verified)**

**[F03] The card was hidden from 14:50:52 to 15:02:51 and went dormant in the middle of the compaction.** — The release deck's trace ring (`__deckTrace.dump()`, read through `tugtool deck motion enable --instance release-main` and closed after) records `restore.space_pass` with `space_card_count: 1` at 14:50:52 and `space_card_count: 2` at 15:02:51. A hidden body goes dormant after `DORMANT_AFTER_MS` = 300 000 ms (`tugdeck/src/lib/body-visibility-store.ts:44`; `tugapp/Sources/BodyLifecycle.swift:87`), so the card slept at about 14:55:52 — after the wheel's `/compact` reached it at 14:55:20 (hidden but awake), and before the compaction ended at 14:56:09. A dormant body is "scoped to nothing" (`tugdeck/src/body/body-main.ts:668`); it hears no frames. **(verified: the timestamps are measured; the dormancy moment is the hide time plus the constant.)**

**[F04] The reveal's catch-up delivered the compact turn's end and the next turn's opener in one bracket, 60 ms long.** — tugcast log: `request_replay.dispatched reload_reason="catch-up"` at 15:02:51.993, `merger.replay_bracket_open` at 15:02:52.061, `turn_complete during replay with an open turn bracket` at 15:02:52.065, `perf.replay_forward frames=293 ms=32`, `merger.replay_bracket_close` at 15:02:52.119. **(verified)**

**[F05] The store notifies once per batch, so a bracket that carries two transitions shows a listener only the last state.** — `CodeSessionStore.applyStructure` sets `_notifyPending`; `endOfBatch` (`tugdeck/src/lib/code-session-store.ts:2132`) notifies once; `applySessionBatch` (`tugdeck/src/lib/ingest/session-patch.ts:143`) calls `endOfBatch` once per mirror per batch, and the host paces batches to the display period. Inside the catch-up bracket, `handleReplayStarted` nulls `pendingTurn` (the "clear pendingTurn defensively" branch in `tugdeck/src/lib/code-session-store/reducer.ts`), the compact turn commits, the implement turn's in-flight snapshot re-opens `pendingTurn`, and `replay_complete`'s chain-link-13 branch lands the card in `streaming` — all before any subscriber runs. **(verified by reading the code)**

**[F06] The run's watcher settles only on an edge it must witness.** — `beginCompactionRun` (`tugdeck/src/components/tugways/cards/session-compaction-run.tsx:148`) subscribes a closure holding `sawActive`, `sawInk`, `interrupted`, `canceled`, and settles only when a notify arrives with `snap.activeTurn === null` after one with it non-null. After the catch-up the one notify it received showed `activeTurn` as the implement turn, so it returned at the `if (active !== null)` branch and kept waiting. It settled at 15:07:29 when the implement turn ended (tugcast: `turn_complete` row at 15:07:28.996, the wheel's next prompt at 15:07:34.106 — a five-second gap the awake card did see), read `sawInk` as true from the replayed `compact_summary` having moved `compactionSeed`, and called `succeed`; the card's outcome effect (`session-card.tsx:3498`) then cleared the run and the sheet's own watch (`compaction-progress-sheet.tsx:94`) closed it. **(verified by reading the code; the 15:07:29 close is an inference from it that the user can confirm.)**

**[F07] The same strand is reachable with no dormancy at all.** — Any batch carrying a `turn_complete` and the next turn's opener produces the same single notify. The wheel prompts its seated session five seconds after a turn ends today (14:56:09 → 14:56:14; 15:07:29 → 15:07:34), which is many display periods, so the live path currently escapes — by cadence, not by design. **(inference from [F05]; a unit test delivering both frames in one `applySessionBatch` would confirm it.)**

**[F08] Nothing tests a wheel `/compact` settling.** — `at0480-arc-compacts-seated-stage.test.ts` is gated on `TUG_REAL_CLAUDE=1` and `tugtool apptest history` answers `no-history` for it; it asserts the wheel's delivery and deliberately not the compaction's settle. No test imports `useCompactionRun` or `session-compaction-run`. `catch-up.test.ts` ("keeps the cycle it slept through until the bracket supersedes it with the turn, committed", line 293) proves the store's half of the sequence and never looks at the run. **(verified)**

**[F09] A replayed compact turn carries its compaction events.** — tugcode's replay emits a `compact_boundary` frame for the JSONL's `system/compact_boundary` record (`tugcode/src/replay.ts:1449`) and a `compact_summary` for the summary record (`tugcode/src/replay.ts:1607`), so the reducer sees the same ink on a catch-up as it does live. **(verified)**

---

## Decisions {#decisions}

**[B01] The run's settle is a derivation over the current snapshot, never an edge a listener must witness.** This is the same fault [B03] of the fold-door brief fixed for the cover — a thing that is *true while other things are true* had been written as a thing that *happens at a moment* — applied to the half the fold work left alone. State recomputed from the snapshot cannot be out of phase; state accumulated in a listener's closure is out of phase every time one batch carries two transitions ([F05]). The watcher stays (it has to run on each notify), but it computes the outcome fresh each time from the snapshot and the run, and it computes it once at subscribe time too, so a run already settled before anyone looked settles on the first read.

**[B02] A run knows the turn it was opened for.** `CompactionProgress` carries the compact turn's `turnKey`. The wheel path reads it off the active turn whose leading atom is `compact`; the typed path takes it when its own submission opens the turn. "Is this run still in flight" is then one comparison — `activeTurn?.turnKey === run.turnKey` — and every other question is asked of that turn's committed entry. A run with no turn key is not a run the derivation can answer, so the key is not optional.

**[B03] The reducer marks a compact turn's committed entry as a compaction.** The `compact_boundary` and `compact_summary` handlers already land in a `pendingTurn`; the entry that turn commits as carries the mark (the boundary's facts, or a `compacted` flag), live and on replay alike ([F09]). The derivation reads the mark off the transcript rather than the ephemeral `compactionSeed` reference or a `source: "compact"` note found by scanning scratch, so a store rebuilt from a replay — an evicted body, a reload — answers the same as the one that streamed it.

**[B04] The outcome function is pure and lives beside the store.** `compactionOutcome(run, snapshot)` returns `null` while `run.turnKey` is the active turn; `succeeded` when the key's committed entry carries the compaction mark; `canceled` when that entry ended `interrupted`; `failed` with `lastError` when it ended `error`, or when the key is neither active nor committed with the mark. It takes no closure state and is unit-testable without React.

**[B05] No run outlives its turn, checked where the run is read.** The card's outcome effect (`session-card.tsx:3498`) reacts today only to a terminal `outcome`. It also applies the derivation to an open run on every snapshot it renders against, so a run whose turn is gone from both the active slot and the in-flight snapshot is settled by the first render that sees it — the case of a body evicted and rebuilt, where the watcher's closure no longer exists.

**[B06] Cancel stays an act; its correction becomes a derivation.** `onCancel` still interrupts the turn and settles the run `canceled` at the gesture — that is something done, not something observed. The "compaction finished before it could be canceled" caution is derived: a run that was canceled whose entry commits with the compaction mark earns it, however that commit arrived.

**[B07] The unit test delivers the bracket as one batch.** A test that emits one frame per `dispatchDecoded` passes today and proves nothing, because each frame is its own batch and the gap is visible. The test feeds the compact turn's commit and the next turn's in-flight snapshot through `applySessionBatch` as one batch (the path `tugdeck/src/connection.ts:599` takes), so the single-notify shape of [F04] is what is asserted over.

**[B08] The app-test uses the harness's shortened dormancy and fixture Claude.** `harnessBodyDelays` already lets a test shorten `dormantAfterMs`. One app-test starts a `/compact`, switches spaces, waits past the shortened delay, lets the turn end, switches back, and asserts the cover is down once the catch-up closes. `at0480`'s real-Claude gate is not needed for this and is not touched.

---

## Open Questions {#open-questions}

None that this brief can settle by reading the code. Whether the sheet came down at about 15:07:29 as [F06] predicts is a fact the user holds; it changes nothing in the decisions either way.

---

## Non-goals {#non-goals}

- **Hearing frames while dormant.** Sleeping is correct and the catch-up is the right way back; the fix is that waking must be enough. A body kept on the wire to avoid this bug would re-buy the memory and work dormancy exists to stop.
- **Changing how the cover rises, folds, or holds the card.** The run × fold derivation and the run's modal hold ([B01]–[B06] of the fold-door and fold-face briefs) are right and are what this brief extends to the settle.
- **Changing the wheel's `/compact` delivery in tugcast, or its prompt cadence.** The five-second gap is why the live path escapes today ([F07]); it is not a guarantee and the deck must not depend on it.
- **The replayed wheel opener's origin.** After a catch-up the implement turn's `#u` row may read as `origin: "user"` rather than `"wheel"`, since it is rebuilt from the JSONL. Cosmetic and separate.
- **A timer or a poll on the run.** A run that gives up after N seconds hides this class of fault instead of removing it, and "no polling in the product" holds.

---

## Exit {#exit}

An arc. The shape, in the order it must land:

1. The pure outcome function ([B04]) and the entry mark ([B03]) in the reducer, with the one-batch unit test ([B07]) written red first against the exact sequence of [F03]–[F05]: wheel `/compact` notice → run begins → `went_dormant` → `begin_catch_up` → one bracket carrying the compact turn committed with its boundary and summary plus the next wheel turn's in-flight snapshot → `replay_complete`; assert the run is `succeeded` before the next turn ends. Beside it the no-dormancy twin ([F07]), the late-look case (subscribe after the turn ended; settles on first read), and the rebuilt-store case (a fresh store holding the committed compact turn and a run carrying its key settles at once).
2. `useCompactionRun` rewritten on the derivation ([B01], [B02], [B06]) and the card's read-side invariant ([B05]); the closure flags go.
3. The dormancy app-test ([B08]), run once as the verdict.
