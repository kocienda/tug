<!-- brief-skeleton v1 -->

# Body visibility and the dormant tier

**Purpose:** A hidden body is a live page that keeps ingesting its session: the render bridge cuts batches by session, never by visibility, and nothing tells a page whether anyone can see it. This brief gives every body a visibility fact from the host, makes a body that has been hidden a while go dormant — process kept, ingest stopped, caught up on reveal — retires warm-every-workspace, and holds the terminated-rebuild path green. Stage 1 of `briefs/body-lifecycle-program-brief.md`.

---

## Purpose {#purpose}

The program brief's [B01] names the dormant tier and the user asked for it to be built: "we don't need to keep those cards lively in the front end for the whole time, but their background work must continue." The background work is tugcast's; what this stage stops is the page's work on behalf of nobody.

---

## Evidence {#evidence}

**[F01] Visibility is the host's fact and the page never hears it.** `BodyViewController.swift` decides what shows (`applyVisibility`: `visible && canShow`), hides a parked or folded body with `isHidden`, and keeps a sibling at opacity 0. Its reports to the shell (`host/declarations/lifecycle.ts`, `bodyStateToPage`) are `ready | painted | landed | beatsCancelled | failed | terminated`. The page reads `document.visibilityState` nowhere but a diagnostic (`lib/smart-scroll.ts:1767`). **(verified, read)**

**[F02] A page's session subscription is already per page.** tugcast routes session-scoped feeds and renders by each page's subscription (`feeds/render_bridge.rs`, `for_sessions`, `PageRegistry.sessions`; [D213]); the body re-scopes its connection when its own binding changes (`body-main.ts`, "a re-scope is a message to the worker, not a no-op"). An empty subscription is a page that receives nothing of any session. **(verified, read)**

**[F03] The catch-up primitives exist.** `request_replay` takes a `ReplayWindow` of `{lastTurns}` or `{turnRange: [from, to]}` (`tugproto/src/inbound.ts:262`), and `request_inflight` describes the turn in flight or the last finished for a page whose stores stood through a reconnect (`tugcode/src/session.ts:1972`). The store knows its last committed turn. **(verified, read)**

**[F04] Warm-every-workspace.** `spaces-store.ts` `warmParked()` warms every parked workspace once the shell asks (`deck-manager.ts:1289`), and `body-shell.ts` hands each warm workspace's mount kinds and unbound Session cards off to bodies while parked; a bound Session card waits for the visit, whose restore spawns its session. Nothing cools a workspace. **(verified, read)**

**[F05] The terminated-rebuild path was dead and is fixed.** Program brief [F04]: a reloaded body loaded into a hidden container never ran the frame callbacks `painted` waits on. The fix in `BodyViewController.swift` (a never-painted body is unhidden and transparent; the reload resets `shownOnce`) is on the tree with `tests/app-test/readings/at0749-body-evict-rebuild-reading.test.ts`, which is a reading, not a grounding row. `body-grounding/row-11-lifecycle.test.ts` is red on `main` since `7ee393cd9` for an unrelated reason: it reads the close confirm popover and the pane's close button in the shell's document, where neither stands since the chrome moved into the card's page. **(verified, measured and read)**

**[F06] The rebuild's cost is flat and small.** Program brief [F03]: kill → settled 470–500 ms at 50, 200 and 500 turns; replay 2–3 ms. So dormancy is not needed to make a reveal fast; it is needed to make a hidden body cost nothing while hidden. **(verified, measured)**

---

## Decisions {#decisions}

**[B01] The host tells every page whether it is shown, as a fact.** One new host → page message, `bodyVisibility` `{shown: boolean, since: number}`, sent on every change by `applyVisibility`, and a `shown` field on the harness's `bodies()` snapshot beside `visible`. Sibling counts as shown (it paints); hidden by `isHidden` is not. The page keeps it in a store every reader subscribes to ([L02], [L22]); it is host plumbing and crosses no pages, so it is not a bus store.

**[B02] Dormancy is the page's own act, from the fact and a clock.** A body hidden for `dormantAfterMs` (default 60 s; a setting in `.tugtool/config.toml` and the Layout card) goes dormant by itself: it empties its session subscription, tells its worker to park (no ingest, no parse, no publish), stills its loops through the motion breaker it already has, and withdraws any `card.surface` it holds. It keeps its DOM and stores. The shell is told through the existing `card.facts` (a `dormant: true` fact) so the masthead and the Cards rows can say so. No count of dormant bodies exists.

*Amended by the body-lifecycle fixups (2026-10-21).* `dormantAfterMs` is not a `.tugtool/config.toml` setting and never was one in the code: it lives in tugbank (`dev.tugapp.body-dormancy`, beside `evictAfterMs`), where every Layout-card setting lives, and the Layout card's Rest row is its door. A project file is the wrong home for how this window treats a hidden page, so this decision is amended to match the code rather than the code to match it ([D219]).

*Amended again, 2026-10-22.* There is no door. `4f3c12e34` removed the Rest row, and the body-lifecycle second fixups removed the tugbank key: the delay is the constant `DORMANT_AFTER_MS` (60 s) in `lib/body-visibility-store.ts`, and only the app-test harness shortens it, through `__tug.bodyDelays`. Nor does the worker park: no park exists. A dormant body's subscription is empty, so tugcast sends it nothing and its ingest worker, hearing nothing, idles with its model kept.

**[B03] A reveal catches up from the last committed turn, and shows under the lid only if it must.** On `shown`, a dormant body re-scopes its subscription and asks `request_replay` with `{turnRange: [lastCommitted + 1, end]}`, or `request_inflight` when the session's turn count has not moved; it leaves dormant when the bracket closes. The host shows a revealed body by the rule it has: a painted body is shown at once. Whether the frames between the show and the bracket's close read as an arrival is the stage's reading against row 1's bar; the lid is used only if that reading says the bare DOM shows stale content for more than a frame.

*Amended by the body-lifecycle fixups (2026-10-21).* The catch-up asks `request_replay` with `{afterTurn: {msgIds, heldTurns}}` — the card's newest turns named by msg-id, which tugcode places in its own coordinates — rather than an index the card reconstructs, which overshot by a lineage's ancestors; there is no `request_inflight` branch, because a turn in flight rides the catch-up's bracket as tugcode's snapshot. The shipped code also dropped the in-flight cycle of a card that slept mid-turn, and reset a card that slept inside a bracket to idle; neither was ever decided here, and both are reversed. A card that slept mid-turn keeps its cycle until the catch-up's bracket opens and supersedes it with the bracket's own account of the turn — committed if it ended, the snapshot if not — so a catch-up that never answers leaves the turn standing. A card that slept inside a bracket is never reset: it asks for that bracket's window again, the new bracket is taken as the open one's completion (its repeats dedupe by msg-id), and the window is the one the bracket reports, or the one the card held when the bracket was itself a catch-up.

The order is reversed too: the body asks first and re-scopes after, and the store sets aside every turn frame the session sends between the ask and the bracket's opener, since a body scoped to nothing hears no acknowledgement and a live turn's end heard first would be committed as its tail. A card whose session the ledger shows closed or failed does not ask, and wakes at once; the page's own backstop is gone, so the store's deadline is the one horizon.

**[B04] Warm-every-workspace is retired.** `warmParked()` and the hand-off of a parked workspace's cards go. A parked workspace's cards are bodies only once the workspace has been shown; on the first visit they arrive as any card arrives ([B07] of `every-card-a-body-brief.md`'s row 1, under the lid); when the workspace is parked again they go dormant by [B02], and later evicted by stage 2. The first visit's cost is read on record.

**[B05] The terminated path gets its grounding row.** A row in `body-grounding/`: a Session body with a draft and a resumed transcript has its WebContent process killed; the body is back `ready`, `visible` and settled within the arrival bound, with its draft and its last turns. `row-11-lifecycle` is repaired in the same step to read the close popover and the pane's close button in the card's page, as `_bodies.ts`'s `popoverPresent` already allows, so the lifecycle row is green rather than carried.

**[B06] The dormant body's cost is read and recorded.** The stage's reading: a body resumed on 500 turns, hidden, dormant for a minute while its session streams three more turns through the stub feed — resident size at rest, CPU over the minute, and the reveal's catch-up time and frames. That number, against [F06] and the program's [F06], is what stage 2 sets the eviction time from.

---

## Open Questions {#open-questions}

- **Does the worker park or stop?** Parking keeps the Worker's model in memory for an instant catch-up; stopping frees it and makes the reveal a fuller replay. Read in [B06]; park unless the Worker's share of the resident size is most of it.

---

## Non-goals {#non-goals}

- **Evicting anything.** Stage 2's.
- **A dormant tier for the shell or the overlay.** They are always shown.
- **Changing what a dormant card shows.** Stage 3's.
- **A hidden fact on the bus.** Visibility is between the host and one page; a bus store would make every page a reader of every other page's visibility for no reader.

---

## Exit {#exit}

**An arc.** In order: the visibility message and the harness field, with a unit test on the host parity fixture; the page's visibility store and the dormant clock; the subscription drop and the worker's park, with the catch-up on reveal and its rows; warm-every-workspace retired with its row; the terminated row and the `row-11` repair; the reading of [B06] written into the program brief's record.
