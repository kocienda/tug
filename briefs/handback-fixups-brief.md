<!-- brief-skeleton v1 -->

# Hand-back fixups: one latch, one identity, a green gate

**Purpose:** The workspace-switch hand-back arc (`28633f4be`) landed the right architecture, but an audit of the joined code found a red push gate, a production path that still renders a mid-turn message twice, and two places where tugcast's turn latch drifts from the row that carries it. This brief records the audit's findings and the fixes decided, so one arc can close them before anything else builds on `turn_active`.

---

## Purpose {#purpose}

The user asked for an audit of the implementation joined from session `furry-mere`: "Give your assessment on the code quality, coherence, the technical choices, and the implementation strategies. Do you see holes, pitfalls, weaknesses, or limitations?" and "Do we need to make fixups? Or, can we move on from here with confidence that the codebase is in good shape?"

They also raised one matter the arc left alone: "tugcast's stuck-turn reaper (`reap_stuck_turn`) can clear the latch without updating the session row. ... A later row update could make it read busy again, though."

The audit ran three independent reads (tugcast Rust; tugcode, tugproto and tugdeck; the Swift host and app-tests), cross-checked the top findings against the code, and ran the fast CI lane on main. The answer was: fixups first, then move on. This brief is the list.

---

## Evidence {#evidence}

**[F01] Main fails `just ci` at its first step.** `lint-rust` is red because `cargo fmt --all -- --check` reports diffs in ten tugcast files: `actions.rs`, `feeds/agent_bridge.rs`, `feeds/agent_supervisor/control/{rows,session,telemetry}.rs`, `feeds/agent_supervisor/{ledger_entry,mod,recorder}.rs`, `pages.rs`, `router.rs`. The arc's test ledger shows it never ran `lint-rust`. Every other lane is green on main at `28633f4be`: lint-ts, lint-audit, rust (4035), tugdeck (11743), tugcode (1007), tugproto, swift (171), app-test-logic (247), standalone. **(verified: ran the lanes)**

**[F02] Production's mid-turn snapshot opener carries no submission id, so a reveal mid-turn still renders the prompt twice.** `emitInflightTurnFromActiveTurn` in `tugcode/src/session.ts` writes `add_user_message` with `content` and `promptUuid` only; `ActiveTurn` in `tugcode/src/active-turn.ts` holds no submission id, though `session.ts` has `msg.submission_id` in hand where the turn is constructed. The reducer's dedupe (`scratchHoldsSubmission` in `tugdeck/src/lib/code-session-store/reducer.ts`) keys on `submissionId` alone and never on `promptUuid`. On a catch-up during a live turn, `replay-runner.ts` leaves the dangling turn open (`synthesizeDanglingTerminal: inflight === null` is false), the JSONL pass emits the opener with `submissionId` set from the user entry's uuid, then the snapshot emits a second opener without one. The reviewer executed the reducer on that sequence and got two user messages; with the id on the snapshot opener, one. **(verified: code read; reducer execution by the reviewer; not reproduced in the app)**

**[F03] The app-test that covers [F02]'s scenario runs on a stub that was given the property production lacks.** `tests/app-test/body-grounding/row-47-handback-one-message.test.ts` is bound to the streaming stub, whose `openerFields` in `tugcode/src/stub-replay.ts` carries `submissionId` on its snapshot opener, and it `@covers` `stub-replay.ts`, not `replay-runner.ts` or `session.ts`. It counts store entries via `userMessageTexts`, not rendered rows. **(verified)**

**[F04] `reap_stuck_turn` clears the entry latch and leaves the ledger's copy standing.** `LedgerEntry::reap_stuck_turn` (`ledger_entry.rs`) sets `turn_active = false` and returns `()`. Its callers, `BusyProbe::busy_session_ids` (`agent_supervisor/mod.rs`) and `session_snapshot` (`feeds/arc_runner.rs`), hold no recorder; `BusyProbe` holds only the ledger. `SessionLedger::turn_latches` is read at push time by every `session_updated` builder (`recorder.rs` `broadcast_row`, `control/rows.rs`, `control/telemetry.rs`, `observer.rs`, `mod.rs`), so after a reap `is_quiet` says idle while the row says busy, and any later push re-busies a card the deck's horizon had idled. The deck's `latchOf` returns `turn_active && state === "live"` and `onLatch(true)` flips a non-working reading to working. It self-heals only at the next turn edge on that segment, `mark_closed`, `mark_failed`, or a `session_init` naming the id. The reap is reachable only for a turn with no claude child silent past `JOB_REAP_HORIZON` (30 min), in practice a resumed segment whose spawn never came up. **(verified: code read)**

**[F05] `/clear` mid-turn strands a stale `true` in `turn_latches` for the discarded segment.** `do_reset_session` in `control/session.rs` clears `entry.claude_session_id` and then cancels; the relay's outcome path in `agent_bridge.rs` sets `turn_active = false` and calls `publish_turn_latch`, which finds no claude id and records nothing. The old row stays `live` with its latch set. Bounded: no card reads that row after `/clear`, and a later resume clears it at `session_init`. **(inferred from code order; not reproduced)**

**[F06] The deck's thirty-minute horizon ignores a known latch.** `armHorizon` and `onHorizon` in `tugdeck/src/lib/bodiless-facts-store.ts` never consult `latchOf(entry.row)`, and `follow` returns early when the row object is unchanged, so a latched turn quiet for `WORKING_HORIZON_MS` reads idle until tugcast pushes a new row. B06 of the hand-back brief made the latch the one source; when the horizon fires it contradicts it. The reverse, wedging busy, cannot happen: a `turn_active: false` push ends the reading in `onLatch`. **(verified: code read and store tests)**

**[F07] `declareDormant` can mark tugcast without telling the page.** In `tugapp/Sources/BodyViewController.swift` the tugcast tell runs unconditionally and the page send is behind `body.state == .bound || body.life.isLive`. The window is narrow, since the clock is armed only after bind, and a later rebind heals it because `reportVisibility` sends `dormant: declaredDormant && !shown`. **(verified: code read)**

**[F08] None of the three row-47 app-tests proves the host-declared path.** `app.bodyDelays({ dormantAfterMs })` in `tugdeck/src/test-surface.ts` shortens both the page's clock and the host's, so whichever fires first puts the page to sleep, and every assertion reads page-side state (`bodyDormancy().dormant`, `userMessageTexts`, `sessionRowFacts`, the Cards row dot). B05's claim, that sleep lands when WebKit froze the page's timer, is covered only by Rust unit tests in `actions.rs`, `pages.rs` and `router.rs`. **(verified)**

**[F09] Three smaller gaps in the tests and docs.** Row 47 is absent from `tests/app-test/body-grounding/README.md`, which the top-level README calls the registry of rows. `row-47-handback-busy-latch.test.ts` samples for up to 15 s after the catch-up, on top of launch, spawn, park and dormancy, which can cross the 20 s file budget on a slow stream (recorded times are 8 to 13 s). Release-main's `turns` table holds two pending rows journaled before the arc whose tugcast-minted ids never reached claude, so `injectPendingRowSynthetics` will re-emit them on every replay until their sessions next complete a turn. **(verified: covers lint, ledger history, a `db-inspect` copy)**

**[F10] Four nits worth a comment or a one-line guard, not a design change.** `submission_id_of` in `agent_supervisor/mod.rs` re-mints on any non-lowercase-hyphenated id instead of lowercasing, which would defeat the deck's dedupe if the deck ever minted differently. A duplicate `submission_id` fails `insert_pending_turn` on the journal's primary key and is refused with a CONTROL error rather than treated as already journaled. `mintTurnKey`'s non-UUID fallback in `session-engine.ts` is withheld from claude by `isSubmissionId` with no log. `extractSubmissionIds` in `journal.ts` takes `source_uuid` from every `queued_command` while `replay.ts` renders only prompt-mode ones. **(verified: code read; none reachable today)**

**[F11] What the audit confirmed sound.** The latch is enforced on every push builder by the `build_session_updated_frame` signature; CONTROL is not a session-scoped feed, so a dormant body still hears row pushes; the catch-up's in-band withdraw in `router.rs` runs before the ask reaches the supervisor; segment rotation moves the latch off the retired id; the bracket snapshot is taken only at 0 to 1 and spent only at 1 to 0; tugcast restart reads every row idle, which is correct since no child outlives tugcast; claude honours the stdin uuid end to end (seen live in the release-main log and JSONL on 2026-10-26). No tuglaw is violated: no React component is touched; L27, L28, L33, L37 and L39 hold. **(verified)**

---

## Decisions {#decisions}

**[B01] Every write to `turn_active` records and publishes, through one function.** Both drifts ([F04], [F05]) come from a writer that cleared the entry without recording. `reap_stuck_turn` returns whether it dropped the latch, and both callers call `publish_turn_latch` after releasing the entry guard, which means `BusyProbe` is handed the recorder where it is built. `do_reset_session` records `set_turn_active(cleared_id, false)` through the recorder in the block that captures the cleared id. Then the remaining direct writers are routed through one entry point that writes the entry, records the set and broadcasts, so the next writer is safe by construction. The invariant, not the two patches, is the deliverable.

**[B02] The snapshot opener carries the submission id.** `ActiveTurn` gains the id from `msg.submission_id` where the turn is constructed, and `emitInflightTurnFromActiveTurn` emits it beside `promptUuid`. A reducer test covers the exact sequence of [F02]: JSONL opener with id, then snapshot opener with the same id, one user message. The reducer keeps keying on `submissionId` alone; `promptUuid` is the rewind anchor and stays that.

**[B03] The one-message app-test exercises production's snapshot path, or says plainly that it does not.** Either the test runs against real tugcode where the snapshot is production's, or its `@covers` and its docblock name the stub as the thing under test and a tugcode unit test owns the production path. A test that proves a property the product lacks is worse than none.

**[B04] The horizon defers to a known latch.** When `onHorizon` would flip a reading idle and `latchOf(row)` is true, it re-arms instead. The horizon stays, as the hand-back brief said, a safety net for a row from an older tugcast or a latch nothing will ever clear.

**[B05] `declareDormant` is all-or-nothing.** The host marks tugcast only when it can also tell the page, or it re-sends the page's half at `ready`. Either way the two halves of the declaration cannot diverge, and the rebind heal in `reportVisibility` becomes a second line rather than the only one.

**[B06] One app-test proves the host-declared path alone.** It shortens `dormantAfterMs` on the host only, leaves the page's clock long, and reads the host's `bodies dormant` log line or tugcast's dormant registry. This is the one assertion B05 of the hand-back brief needed and did not get.

**[B07] Format the Rust, register row 47, size the busy-latch cap under the budget, and sweep the two stale rows.** `cargo fmt` lands first, alone, so the gate is green before anything else. Row 47 goes in the body-grounding README. The busy-latch sampling cap is sized so launch plus spawn plus park plus dormancy plus the cap stays under 20 s. The two pre-arc pending rows in release-main's `turns` table are removed once by hand; no bridge code for a zero install base.

**[B08] The four nits in [F10] get a line each, not a design.** Lowercase instead of re-mint in `submission_id_of`; treat a duplicate `submission_id` as already journaled and forward; log when `mintTurnKey` falls back; a comment at `extractSubmissionIds` naming the asymmetry with `replay.ts`. Each is a guard against a future caller, written where that caller would look.

---

## Open Questions {#open-questions}

- Whether a card that already holds the live turn enters the catch-up bracket or shadows it ([F02]). The reviewer's reducer execution assumed it enters, via `supersedesCycle` clearing scratch; the snapshot opener's `inflightSnapshot` marker exists for the shadow case. The fix in [B02] is right either way, but the reducer test in [B02] should assert both entries so the answer is written down.

---

## Non-goals {#non-goals}

- **Reworking the latch's storage.** In-memory `turn_latches` beside the rows is correct: a tugcast restart must read every row idle. Persisting it would make a restart lie.
- **Keying the reducer's dedupe on `promptUuid`.** It is the rewind anchor, carried on the live `prompt_anchor` frame, and absent on older sessions. One identity means one field.
- **A compatibility bridge for pre-arc pending rows.** Two rows on one machine; the install base is zero.
- **Retrying a dropped control-socket tell.** The connection is nil only across a tugcast death, after which `redeclareDormancy` re-sends every standing mark; no lost-mark case was constructed.
- **Re-litigating the hand-back architecture.** The audit found it sound ([F11]); this arc tightens its writers and its evidence.

---

## Exit {#exit}

An arc, in this order:

1. `cargo fmt` on the ten files, alone, so main's gate is green ([B07]).
2. The snapshot opener's submission id, with its reducer test and the honest `@covers` on the one-message app-test ([B02], [B03]).
3. The latch invariant: reaper and `/clear` publish, then the single write path ([B01]), with a unit test in `ledger_entry.rs` for a reap that publishes.
4. The horizon's deference to the latch ([B04]) and the all-or-nothing `declareDormant` ([B05]).
5. The host-declared app-test, the README row, the busy-latch cap, the stale-row sweep and the four nits ([B06], [B07], [B08]).
