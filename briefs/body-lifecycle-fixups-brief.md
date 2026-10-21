<!-- brief-skeleton v1 -->

# Body lifecycle fixups: what the audit of the three arcs found, and every fix

**Purpose:** The three body-lifecycle arcs (`377e703dd` dormancy, `c921c6591` eviction, `196ce0485` user surface) landed the right architecture, but an audit of the joined code found defects that lose a user's turns, leave a card wrong on screen, or leak the memory eviction exists to free, and a set of smaller faults and document contradictions. This brief records every finding and decides every fix, most important first, so one arc closes them all before anything builds on the tiers.

---

## Purpose {#purpose}

The user, 2026-10-21, after the three arcs joined: "let's audit the implementation work … Do you see holes, pitfalls, weaknesses, or limitations? … Determine if the changes are actually good, not just the plan in the abstract … Do we need to make fixups?" The answer was yes, and then: "brief this. all fixes included. most important ones first."

The audit's baseline: `main` type-checks clean, the deck's unit suite is green (11,568 tests, 806 files), every host message is declared and typed with a Swift twin, the bus carries no new kind and no page-crossing singleton, and L01/L02/L06/L22/L26/L27 hold across all three arcs. What follows is what is wrong inside that.

---

## Evidence {#evidence}

**[F01] A card asleep mid-replay is reset to idle on reveal.** `handleBeginCatchUp` (`tugdeck/src/lib/code-session-store/reducer.ts`) treats every phase but `idle` and `errored` as a cycle slept through, and resets it — `replaying` included. A body that goes dormant with a bracket open loses the bracket's tail (its subscription is gone), and a terminated body reloaded while parked goes dormant at once, since the host's `since` predates the reload (`BodyViewController.reportVisibility`). On reveal the store is forced idle with a partial transcript and possibly a null `replayWindow`, and the catch-up asks from a near-zero index and appends old turns after the tail. **(verified, read)**

**[F02] The catch-up's start index is wrong for any session with a lineage.** `CodeSessionStore.catchUp` (`code-session-store.ts:1214–1222`) computes `next = firstLoadedTurnIndex + _transcript.length` and asks `turnRange: [next − 1, ∞)`. tugcode's `turnRange` is in the tip's coordinates and ancestors are loaded whole and never windowed (`tugcode/src/replay-runner.ts:592–603`); the card's transcript holds the lineage prefix and nothing in tugdeck subtracts it (no `lineage` in the store or reducer). On an arc-staged or relocated session `next` overshoots by the ancestor turn count, tugcode clamps to the end, the bracket comes back empty, the catch-up "succeeds", and the missed turns never appear. Row 35 resumes a fresh session and cannot see it. **(verified: the coordinate mismatch is read; the empty bracket is inferred from the runner's clamp)**

**[F03] Bodies never shown can neither go dormant nor be evicted by time or warning.** `reportVisibility` reads `shown = !container.isHidden` (`BodyViewController.swift:741`), and a body hidden before its first showing is hidden by opacity, not `isHidden` (`applyVisibility`'s never-shown branch). It reports `shown: true`, never arms the clock, is refused by `evictable(siblings: false)`, and only critical pressure can take it. A pane folded at launch, or a card bound behind another before its first paint, holds its process indefinitely. **(verified, read)**

**[F04] The covers can undo the memory the eviction freed.** `covers[cardId]` keeps a full-resolution `CGImage` per evicted card in the host process until that card's next body is made or the card is closed (`evict`, `standCover`, `destroy`). A card evicted and never revisited holds roughly 10–25 MB at 2× for the life of the process; nothing caps, downsizes or ages the covers. Under `critical` every eviction's `takeSnapshot` runs at once, which makes each sleeping WebContent paint — allocating when memory is shortest. **(verified, read)**

**[F05] A closed session's card reveals under an opaque lid for five seconds.** `catchUp` sends `request_replay` regardless of whether the session has a subprocess; the supervisor queues a request for an entry with none (`agent_supervisor/mod.rs`, `entry.queue.push`), so no bracket comes and `catchingUp` falls only at `CATCH_UP_DEADLINE_MS` (5 s), or at `catchUpCard`'s 10 s backstop if the store was disposed. The dormant lid (`body-page.css`) stands the whole time with no reason shown. Finished sessions parked in a workspace are the common case. The queued request also fires on the session's next spawn, a stale replay later. **(verified, read)**

**[F06] A declined time eviction is never re-armed.** The `evictDue` work item clears itself and returns when `evictable` is false — a save that did not answer, the page shown mid-save, a gesture — and nothing re-arms it until visibility next changes (`armEviction`). One slow save and that body is never released by the clock. **(verified, read)**

**[F07] A parked card whose session dies mid-turn reads "working" for ever.** `onLedger` (`tugdeck/src/lib/bodiless-facts-store.ts:118–127`) ends a turn only when `last_used_at` moves past the mark, and never reads `row.state`; `record_turn` stamps only `WHERE state = 'live'` (`session_ledger.rs`). A session that exits, errors or is reaped while its card is dormant or evicted leaves the Cards and Overview dot turning with no horizon. `last_used_at` is also stamped by `set_turn_count`, rewinds and revives, so the header's "at every live turn's end" is incomplete. **(verified, read)**

**[F08] Live frames can shadow the catch-up bracket.** `installBodyDormancy`'s `catch-up` act calls `rescope()` before `catchUp()` writes `request_replay`; tugcast routes live deltas from the re-scope, and tugcode suppresses live emission only once it handles the request. A live frame that takes the reducer out of idle first makes `replay_started` a shadow (`handleReplayStarted`), and a shadow keeps only the snapshot on the premise that a live card already holds everything — false for a dormant card — so committed turns missed while dormant are dropped. Row 35 covers one turn that ended while dormant, not a turn streaming at reveal with finished turns behind it. **(suspected; the order is read, the race is not reproduced)**

**[F09] The page's catch-up backstop fires unconditionally.** `catchUpCard` (`body/body-main.ts`) calls `finish` at `CATCH_UP_DEADLINE_MS * 2` whatever the store is doing, so a slow bracket wakes the page and lifts the lid mid-bracket, against the reducer's own timer cancel and the commit's "only its own close ends it". **(verified, read)**

**[F10] A card closed during an eviction can be removed twice and leak its cover.** `destroy(save: true)` clears the card's cover entry then waits on its own `saveState`; an eviction's snapshot callback landing in between writes the cover back, removes the body and notifies `evicted`; `destroy`'s callback then removes it again and `bodyDidGoAway` fires twice. **(verified path; a narrow race)**

**[F11] A failed snapshot shows the floor.** When `takeSnapshot` fails — a view hidden with `isHidden` may refuse one; the "still answers a snapshot" comment is untested for that case — the shell still marks the card revived and places it visible from the hand-off (`card-placement.ts`, `revivedNow`), the host's `canShow` falls back to `painted`, and the pane shows the floor until the page paints, against the eviction brief's [B03]. The snapshot has no deadline either: a hung completion leaves `evicting` true for ever. A cover is taken at the old size and stretched by `contentsGravity = .resize` if the pane changed. **(verified that it can happen; impact inferred)**

**[F12] The warning's pacing times from the save, not the process going.** `settle` runs `done` in a `defer` when the save settles, before the async snapshot and `remove`, so `pendingWarningStep` and `evictOldestHidden`'s comments ("a beat after the last one's process went") are wrong. **(verified, read)**

**[F13] `heldForThePaint` keeps the old `z`.** A departing view held one paint keeps its stacking; the `takenBy` exemption matches exact rects only, so on a switch a departing view overlapping an arriving one may sit over it for about two paints. **(suspected)**

**[F14] A card whose page was never made gets no derived facts, and the derived facts' turn count is never shown.** `bodiless()` follows only a dormant, evicted or already-followed card, so a card in a never-shown workspace falls back to `idle`; `turnCount` and `lastUsedAt` are computed with no production reader, yet `follow()` notifies on their change, republishing `deck.cards` on every ledger tick for nothing. `WORKING_KEYS` is exported and used only inside its module. **(verified, read)**

**[F15] The documents contradict each other.** `[L09]` was amended to name the stand-in as the one paint the shell makes for a card; `[D216]` still says the shell "paints only its own" and a Pane is "nothing drawn", `shell-and-bodies.md` still says "no clip and no painted child", and no `[D##]` records dormancy, eviction, the cover or the stand-in. `at0747`'s no-hole census passes only because it samples after every page has painted; during an arrival it would flag the stand-in's boxes. **(verified, read)**

**[F16] Decisions were changed in commit messages rather than briefs.** Dormancy [B03] asked for `[lastCommitted+1, end]` or `request_inflight` when nothing moved; the code sends overlap-by-one, has no `request_inflight` branch, and forcibly drops the in-flight cycle — a decision nowhere written. The user-surface brief's [B06] required the fold and stack-scroll rows against both tiers; they were dropped in a commit message. Dormancy [B04] retired `parkedKey` and with it [B24] of the bodies migration's first-visit picker claim; row 26's new "waits for the body to rest after its picker's floor drops" is the trace. The dormant and evict delays live in tugbank (`dev.tugapp.body-dormancy`) rather than `.tugtool/config.toml` as [B02] said. **(verified, read)**

**[F17] Smaller faults.** `withholdBodySurface` is a no-op when no mirror exists yet, so a mirror made while dormant is never withheld; `dormant-after-pref.ts` says the body "parks its worker" and no park exists (the worker starves); `writeDormantAfterMs` hand-rolls the `/api/defaults` PUT eleven other files also hand-roll; `BodyPressure.Level` duplicates `PressureLevel` in Swift; `parseEvictAfterMs` aliases the dormant parser; the Layout card's reading spans carry `aria-labelledby` with no role; `remove` does not hand the keyboard back when the removed body held it, and a revived body hidden by opacity never had `isHidden`, so `applyVisibility`'s keyboard re-take may not fire; a shell reload brings every evicted card's process back at once (`destroyAll` → restore pass), undocumented; `ACCEPTED_FANOUT` in `select-tests.ts` legitimizes `body-shell.ts` (24) and `BodyViewController.swift` (27) selecting past `MAX_SELECTED` on every touch. **(verified, read)**

**[F18] Tests looser than their names.** Row 42's "a warning keeps the spare" runs with nothing hidden, so the warning has nothing to take and the assertion holds trivially. Row 44 passes a pane with up to half the canvas showing (`FLOOR_SHARE_MAX = 0.5`) and a title band with 1% ink. No row covers a failed snapshot, a close during an eviction, a never-shown body parked, a session dying while dormant, a lineage session's catch-up, a bracket open at sleep, or a turn streaming at reveal with finished turns behind it. **(verified, read)**

---

## Decisions {#decisions}

Most important first; the order is the arc's.

**[B01] The catch-up asks by what the card holds, not by an index it reconstructs.** `request_replay`'s window gains a form that names the last committed turn the card holds — its msg-id, with the ledger's turn count beside it — and tugcode resolves that against the tip's JSONL, returning the turns after it, whole, in the one bracket. The index form stays for backward paging, where it is right. This closes [F02] outright, makes [F08]'s shadow harmless (a bracket that carries every turn after the named one has nothing to be shadowed out of) and keeps working through lineage, relocation and any future windowing, because the card never has to know tugcode's coordinates. A card holding no turn asks from the start.

**[B02] A sleeping card is never reset; the bracket is finished or re-asked.** `begin_catch_up` leaves `replaying` alone: a card that slept with a bracket open re-asks the same window on reveal and the reducer treats the new bracket as the old one's completion, keeping the loaded window's start. The in-flight cycle of a card that slept mid-turn is not dropped; the catch-up's bracket is entered with the cycle standing and tugcode's inflight snapshot supersedes it by msg-id, as a reconnect's does. The decision the commit took silently — drop the cycle — is reversed here, in writing. Closes [F01] and the unwritten half of [F16].

**[B03] The catch-up is sent before the subscription is restored, and only to a live session.** `installBodyDormancy`'s `catch-up` act writes `request_replay` first and re-scopes after tugcode has acknowledged it (the `replay_started` of the bracket, or a new `replay_queued` ack), so no live frame can precede the bracket; and a card whose session the ledger shows closed, errored or idle (`sessions.state` the shell already holds, projected to the body in its facts) skips the ask and wakes at once. The 5 s deadline stays only for a live session whose tugcode does not answer, and the 10 s page backstop goes: the store's own deadline is the one horizon, and the page follows `catchingUp` alone. Closes [F05], [F08], [F09]. A queued `request_replay` on a dead entry is dropped by tugcast rather than kept for the next spawn.

**[B04] Visibility is what the user can see, and the host says so for every body.** `reportVisibility` reports `shown` as the body being placed visible with opacity 1 — a sibling at opacity 0 is `shown: true` by [B01] of the program brief, a never-shown body hidden by opacity is `shown: false` — by reading `body.visible && canShow || body.sibling` rather than `!isHidden`. Every never-shown hidden body then goes dormant and is evicted by the clock and by warnings like any other. Closes [F03].

**[B05] A cover is a bounded, aged, downsampled picture, and never taken under critical pressure.** The cover is taken at the view's backing scale capped to the pane's point size at 1× (a card's last frame is a placeholder, not a document), held in an aged map that drops any cover older than `evictAfterMs` or beyond a resident budget the host reads from its own footprint, and `critical` skips the snapshot entirely: an evicted card under critical comes back under the shell's stand-in (`body-stand-in.tsx`), which [F11] needs anyway. Closes [F04]; the failed-snapshot and no-cover cases of [F11] become one path.

**[B06] No cover is no floor.** When a revived body has no cover, the shell does not mark it `revivedNow`; the stand-in chrome and its lidded content box stand until the page paints, as for any arrival, and the host shows the container only on `painted`. `takeSnapshot` gets a deadline (`saveDeadline`) after which the eviction proceeds coverless, so `evicting` can never stick. A cover is drawn at its own aspect over the pane's surface colour rather than stretched. Closes [F11].

**[B07] Every declined eviction re-arms, and a close during one wins.** A time eviction that is declined re-arms from now for `evictAfterMs` (or a shorter retry for an unanswered save); a warning episode re-asks a declined body at its next step after the same delay. `destroy` sets `evicting` false and a tombstone the eviction's callbacks check before touching the body or the covers, so a closed card is removed once and holds no cover. The warning's next step is scheduled from the eviction's completion, not from the save, and the comments say what the code does. Closes [F06], [F10], [F12].

**[B08] A bodiless card's phase follows the session's state, with a horizon.** `bodiless-facts-store` reads `row.state` beside `last_used_at`: a row that is `closed`, `errored` or `idle` ends a turn whatever the stamp, and a `working` reading older than the ledger's longest live turn (`session_ledger` carries turn durations) falls to `idle` with a dev-log line. The header names every writer of `last_used_at`. A card in a never-shown workspace is followed from the ledger alone (its facts are null, its session is known), so its dot turns. The unread `turnCount` and `lastUsedAt` are deleted with their notifications; `WORKING_KEYS` is unexported. Closes [F07], [F14].

**[B09] The documents agree, and the decisions are on record.** One `[D##]` in `design-decisions.md` records the tiers, the cover, the stand-in and the two settings' home (tugbank, which is where every Layout-card setting lives — [B02] of the dormancy brief is amended, not the code); `[D216]`'s "paints only its own" and `shell-and-bodies.md`'s "no painted child" are amended to name the stand-in as the one exception and to cite `[L09]`; `at0747`'s census samples during an arrival as well as after it, and accepts the stand-in's boxes by their `data-body-stand-in` mark and nothing else. The program brief's record carries this arc's row. Closes [F15].

**[B10] The rows that were dropped are decided, and the loose ones are tightened.** The fold row (14) and the stack-scroll rows run against a dormant and an evicted card; the finding that no body is hidden at those gestures is written into the user-surface brief as the reason the rows are one case each, not dropped. [B24] of the bodies migration is amended to say the first-visit picker is claimed after the switch, and row 26 says why it waits. Row 42's warning case hides a body first; row 44's floor share drops to the composite tolerance `row 1` uses and its title band to the ink the real title draws. New rows: a bracket open at sleep ([B02]), a lineage session's catch-up ([B01]), a turn streaming at reveal with finished turns behind it ([B03]), a never-shown body parked ([B04]), a session dying while dormant ([B08]), a failed snapshot ([B06]), a close during an eviction ([B07]). Closes [F16], [F18].

**[B11] The small faults go in the same arc.** `withholdBodySurface` remembers the withheld state so a mirror made while dormant is withheld on creation; `dormant-after-pref.ts` says what happens (the worker starves; nothing parks); the two prefs share one parser and write through the tugbank client's own PUT with the other eleven call sites left for a later sweep; Swift's `BodyPressure.Level` is the one `PressureLevel`; the reading spans get a role; `remove` hands the keyboard to the window's shell-named owner when the removed body held it, and a revived body takes it on `painted` when the shell names it; a shell reload restoring every evicted card is documented beside `destroyAll` and left as is (a reload is a relaunch); `ACCEPTED_FANOUT` stays, with the two files' selections read once more after this arc to see whether `@covers` lines can narrow them. Closes [F13] by stacking a held view beneath every arriving one, and [F17].

---

## Open Questions {#open-questions}

- **Does tugcode's inflight snapshot supersede a standing cycle cleanly by msg-id?** [B02] assumes a reconnect's path does this already (`emitInflightTurnFromActiveTurn`); the arc's first step reads it and, if a held cycle and a snapshot can both commit, adds the dedupe there rather than dropping the cycle.
- **The cover's resident budget.** [B05] names one without a number; the arc reads the host's footprint with twenty covers at 1× and sets it from that, in the record.

---

## Non-goals {#non-goals}

- **Re-deciding the tiers, the triggers or the no-count rule.** The program brief stands; this arc repairs the implementation.
- **A new replay mechanism.** [B01] adds one window form to a verb that exists.
- **Sweeping the eleven hand-rolled `/api/defaults` PUTs.** Named for a later arc.
- **Changing what a dormant or evicted card shows.** The user-surface brief's [B01]–[B05] stand; [B06] here only makes the no-cover case meet them.

---

## Exit {#exit}

**An arc**, in the decisions' order: [B01] and [B02] first (the two that lose turns), then [B03], [B04], [B05]/[B06] together, [B07], [B08], [B09], [B10], [B11]. Each closes its findings with the rows [B10] names, and the program brief's record takes the arc's row at the join.
