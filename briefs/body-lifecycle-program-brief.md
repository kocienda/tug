<!-- brief-skeleton v1 -->

# Body lifecycle: bodies the deck lets go of while their sessions work on

**Purpose:** Every card is a WebContent process the deck keeps for the card's whole life, and nothing is ever let go of: a parked workspace's cards, a folded card, an inactive tab all stand as live pages receiving every delta of their sessions. The user wants the Safari model — a card is never refused, a hidden card's page may be given up, and the work the card stands for goes on where it lives — with the restore path bringing a card back when it is next looked at. This brief is the index: the model, the invariants every stage holds, the reading that sized it, and the stages.

---

## Purpose {#purpose}

The user, 2026-10-21: "Clearly, browser apps like Safari employ a model similar to ours, and can handle dozens and dozens (hundreds?) of tabs. The issue there is that pages get parked. We can do that too, but only partially. It's *essential* that a user can set up a series of sessions, kick off some work, and then switch their attention (and perhaps the active workspace) to something else. Now, we don't need to keep those cards lively in the front end for the whole time, but their *background work* must continue. We can use something like the *restore/resume* interface to *catch up* a card that was cooking away in the background for a long time and then brought to the front again after a time. There *must not* be an arbitrary count to cards."

Three calls made in the same conversation: build the dormant tier as well as eviction; keep a pane's inactive tabs painting until memory pressure; and measure the rebuild before deciding the thresholds.

---

## Evidence {#evidence}

**[F01] The session is already independent of the body.** The orphan sweep (`reap_orphan_bridges`, `tugrust/crates/tugcast/src/feeds/agent_supervisor/mod.rs:4759`) spares every session a deck's seating report names. That report (`deck_seatings`) is sent by the shell alone (`tugdeck/src/main.tsx:581`, `lib/deck-seatings-reporter.ts`) from `cardSessionBindingStore`, and `card.binding` is a shell-owned store (`bus/declarations/relays.ts:51`). A destroyed body drops none of it: the seating stands, the bridge stays `Live`, `claude` runs on and the JSONL grows. The sweep's 60 s settle (`BRIDGE_ORPHAN_SETTLE`) is about pages, not seated sessions. **(verified, read)**

**[F02] The catch-up is the restore path, and it exists.** A new page binds with intent `restore`, the restore pass sends `spawn_session(mode=resume)`, and for an entry `Live` under the same card that is a reconnect, not a respawn: the conflict check (`spawn.rs:741–770`) refuses a resume only when a *different* card holds the session on a live client. The page then asks `request_replay`; tugcode replays the JSONL inside a `replay_started`/`replay_complete` bracket, windowed to the last `DEFAULT_REPLAY_WINDOW_TURNS = 10` turns (`tugdeck/src/protocol.ts:104`), with the rest loaded on demand; `request_inflight` is the lighter answer for a page that already holds the committed turns. A body's `ready` waits past `phase === "replaying"` (`body/body-main.ts`, `signalReadyWhenQuiet`). **(verified, read)**

**[F03] The rebuild is cheap, and flat in the session's length.** `tests/app-test/readings/at0749-body-evict-rebuild-reading.test.ts`, 2026-10-21, M4 Max: a JSONL of 50, 200 and 500 turns of prose markdown seeded where tugcode reads it, resumed into a Session body, the body's WebContent process killed, the host's reload timed. Kill → `ready` 419–463 ms, → `visible` the same frame, → replay settled 470–500 ms; the replay's own wall 2–3 ms over 43 frames at every length, because it is windowed. The first bind's resume → settled was 194–211 ms. Resident size of the body 227–244 MB before and after at every length. **(verified, measured)**

**[F04] A terminated body never came back visible until this reading.** The host's reload after `webContentProcessDidTerminate` (`tugapp/Sources/BodyViewController.swift`) set `painted = false` and left `shownOnce = true`, so `applyVisibility` hid the container with `isHidden`; the new page's `painted` is said after two `requestAnimationFrame`s, which a hidden WKWebView never runs. The body reached `ready` and was never shown. Fixed in the same reading: a body that is not yet painted is unhidden and transparent, as a page never shown is, and the reload resets `shownOnce`. No app-test covered the terminated path before `at0749`; `at0738-body-fallback`, `row-01-arrival-cold` and `row-01-arrival-warm` are green after the fix. **(verified, reproduced and fixed)**

**[F05] Nothing is ever let go of today.** `destroy` runs only on close and on a body's failure. `warmParked()` (`tugdeck/src/spaces-store.ts:219`) warms every parked workspace at once and nothing cools one (`activate` moves warm → mounted only), so every card of every workspace is a live process from launch. The host hides a parked or folded body with `isHidden`, which throttles WebKit's timers and rendering updates, and keeps a pane's inactive tabs painting at opacity 0 for an instant switch; but the render bridge cuts batches per page's *session* subscription, never its visibility, so a hidden body receives every delta, its worker ingests it and its DOM grows. The host's state reports (`ready | painted | landed | beatsCancelled | failed | terminated`) carry no `hidden`/`shown`, so nothing page-side can go quiet by itself. **(verified, read)**

**[F06] What a body costs.** A WebContent process is 53 MB at creation, the warm spare 146–148 MB, a Session body streaming 205–223 MB (stage 3 of the per-card program), 227–244 MB after a 500-turn resume ([F03]). Twenty Session bodies at streaming cost are about 4 GB; a parked workspace adds its whole card count. **(verified, measured)**

**[F07] Stage 5's cap was never built.** `briefs/every-card-a-body-brief.md` [B06] specified unloading hidden bodies past a budget given as a live-body count and a resident-memory ceiling, set in `.tugtool/config.toml` and shown in the Layout card. No cap, count or ceiling exists in `lib/body-shell.ts` or the host. **(verified, read)**

---

## Decisions {#decisions}

**[B01] The Safari model, by tiers of visibility and age.** A card record is never refused and never counted. Its body is one of four tiers, and the tier is decided by what the user can see and how long ago they could see it:

- **Shown** — the pane's active card. A full body, as now.
- **Sibling** — an inactive tab in a shown pane. Kept painting at opacity 0 so a tab switch is instant, as now, until memory pressure says otherwise.
- **Dormant** — hidden for more than a short time: a parked workspace's card, a folded card, a card scrolled out of a stack. The process stays; the page stops ingesting. It drops its session subscription in tugcast (the per-page subscription of [D213] is the lever), parks its worker and keeps its DOM. On reveal it asks for a windowed replay from where it stopped and shows under the lid. Memory goes flat; the session is untouched.
- **Evicted** — dormant for longer, or any hidden body under memory pressure. The host saves the state bag, destroys the view, and the card's record, seating and session stand. On reveal it is an arrival from the spare, under the lid, with the replay of [F02]. This is stage 5's [B06] shape with the count removed.

Four tiers rather than two because the user asked for dormant to be built: it is the tier that keeps a workspace switch and a tab switch feeling instant, at no process cost, and [F03] says eviction's rebuild is cheap enough that the dormant → evicted threshold is a memory question, not a latency one.

**[B02] Two triggers, and no count anywhere.** *Time hidden*: a hidden body goes dormant after minutes and evicted after longer, both settings with defaults the stage briefs name from [F03] and [F06]. *Memory pressure*: the host listens to `DispatchSource.makeMemoryPressureSource`; on *warning* it evicts dormant bodies oldest-hidden first, on *critical* every hidden body, siblings included. Pressure is what bounds the deck on a day fifty cards are open, and it bounds by what the machine says rather than by a number guessed in advance. A count of cards or bodies is not a setting, not a default and not a diagnostic threshold.

**[B03] Never evicted: a shown card.** Only a shown card is exempt by rule. A card whose session has a pending ask (a permission, a question) does not need one: `sessionAsk` is a request declared with `redeliver`, which re-sends it when the card's body next attaches, so an evicted body with a pending ask shows the dialog again on reveal. The dormant stage confirms that with a row rather than assuming it.

**[B04] The background work is the session, and the catch-up is the restore path, unchanged.** No new replay mechanism, no transcript cache in the shell, no second copy of the session's state. A dormant body catches up by the replay window it already has (`ReplayWindow` as `{turnRange}` from its last committed turn); an evicted body catches up as a relaunch does. What changes is only when a body is asked to, and that the host and the page agree about visibility.

**[B05] Warm-every-workspace goes.** A parked workspace's cards start dormant, or evicted if the workspace has not been shown for long, by the same tiers as any hidden card; a workspace visit reveals them under the lid, held to the arrival bar (`body-grounding` row 1: no frame of canvas). Warming all parked workspaces at launch is what makes every card a live process from the first second, and it was a stopgap for a visit's first paint that the lid already covers.

**[B06] The reading first, and it is on record.** [F03] was taken before anything in this program was decided, as the user asked, and the thresholds in the stage briefs cite it. Each stage adds its rows to `tests/app-test/body-grounding/` and its reading to this brief's record. The user's aged deck is read with the program on before any default is set from a harness number alone.

**[B07] The terminated path is the eviction path's rehearsal, and it is green now.** [F04]'s fix lands with this brief's reading; the lifecycle stage adds the grounding row for it (a body's process killed, the body back visible with its draft and transcript) so the path eviction rides is held green on its own.

---

## Open Questions {#open-questions}

- **What does a dormant body still cost at rest?** *Read in stage 1 (the record):* about 550 MB resident for a 500-turn body, unchanged by dormancy, and under 1% CPU while its session streams. Hidden and awake, the same body spends 6.8%. That memory against [F06]'s streaming cost is what sets the dormant → evicted time.
- **Does a dormant body's reveal need the lid?** *Read in stage 1:* yes. A body that slept mid-turn stood 4–6 display periods between being shown and its catch-up landing, more than a frame, so it wears the content lid from sleep to wake.
- **What does the overlay do about a dormant card's surface?** A card that goes dormant with a popover escaping its box has an `overlay.surfaces` entry; dormancy should withdraw it as a move does. *Decided in stage 1:* a body that sleeps withholds its surface mirror, which withdraws the entry, and resends what it held when it wakes.

---

## Non-goals {#non-goals}

- **A count of cards, bodies or workspaces.** The user's rule. Not a setting, not a default, not a cap.
- **Keeping hidden bodies live to avoid the catch-up.** [F03] priced the catch-up at under half a second flat in the session's length; the cost that grows is memory, and keeping everything live is what this program ends.
- **A transcript cache in the shell or the host.** The JSONL and tugcode's replay are the record; a second copy would drift from it.
- **Sharing one WebContent process across bodies.** Private API, and [B10] of the per-card program.
- **Stage 5's live-body count and resident-memory ceiling as settings.** Superseded by [B02]: pressure and time, not numbers.

---

## Exit {#exit}

Three arcs, one per brief, in this order:

| Stage | Brief | Lands |
|---|---|---|
| 1 | `briefs/body-visibility-and-dormancy-brief.md` | A visibility fact from host to page; the dormant tier (subscription drop, worker park, windowed catch-up on reveal); warm-every-workspace retired; the terminated-rebuild row |
| 2 | `briefs/body-eviction-under-pressure-brief.md` | Eviction by time hidden and by memory pressure; the state bag saved and the view destroyed; the reveal as an arrival under the lid; asks redelivered; the record |
| 3 | `briefs/body-lifecycle-user-surface-brief.md` | What the user sees of a dormant or evicted card: its chrome and facts, the Overview and Cards rows, the Layout card's Bodies row, a workspace switch, and the one notice a cold reveal may show |

**Record.** One row per stage at its join.

| Stage | Joined | Reading | Notes |
|---|---|---|---|
| before | 2026-10-21 | kill → ready 419–463 ms, → visible same frame, → settled 470–500 ms; replay 2–3 ms / 43 frames at 50, 200 and 500 turns; body 227–244 MB before and after | `at0749`, harness, M4 Max; terminated path fixed to be visible at all ([F04]) |
| 1 | 2026-10-21 | Body of 500 stub turns: 225 MB empty, 536 MB full at rest. While a turn streamed, it used 6.8% CPU hidden and awake (20 s) and 0.73% dormant (60 s). RSS held at 550 MB across the dormant minute. Reveal: shown 13 ms and awake with the missed turn in 59 ms after the switch; the page's longest frame gap was 36 ms (2.2 periods). First visit to a never-shown workspace: shown 112 ms after the switch. Terminated rebuild: settled 552 ms after the kill. | `at0750`, `row-36`, `row-37`, harness, M4 Max. Dormancy stops the work, not the memory. The worker parks: the 500 turns add 312 MB to the body, held across its DOM, store and worker, so stopping the worker alone frees part of that and leaves the DOM; the memory is eviction's to free, at a rebuild of about half a second. |
| 2 | 2026-10-21 | Evicted sibling back under its last frame, cold: chosen → painted 666 ms, settled 770 ms, no frame of floor. Hidden past `evictAfterMs` (1500 ms in the row): gone 1608–1659 ms after hidden, the spare kept, back warm in 221 ms with its draft. A pending ask across an eviction: the caller stays blocked, the dialog stands again 519 ms after the tab is chosen, and the answer releases it. A folded card under critical pressure: shown on 15 of 15 readings across 1.5 s. The user's deck, read only, running stage 1: 26 page processes holding 6.6 GB of WebKit footprint (75–509 MB each) on a 128 GB M4 Max at about 80 GB resident. The kernel's pressure level read normal, and the 4.5 h of retained log carried no system warning. WebKit's own relief ran 15 times, each in one process, minutes apart. | `row-38`, `row-39`, `row-40`, `row-41`, `row-42`, harness, M4 Max; the deck reading from `ps`, `sysctl` and `/usr/bin/log`. No count gates anything. A warning keeps the spare and critical takes it: the deck has not yet met a warning, and the spare's 146–148 MB is what keeps the next arrival at 109–148 ms rather than 419–463 ms. A warning frees memory by taking hidden bodies, each worth more than the spare. |
| fixups | 2026-10-21 | Covers: twenty covers of a 640 × 480 pane at one point a pixel are 25.3 MB of pixels (100.7 MB at 2×) and moved `phys_footprint` 1.4 MB as CoreGraphics images, against 26.7 MB for the same bytes malloc'd, so the budget counts pixel bytes and is 32 MB. An eviction whose snapshot never answers goes on at its deadline: gone 3040 ms after hidden for a 1000 ms delay and a 2000 ms deadline, and back under its stand-in, shown → painted 335 ms, no frame of floor. A card closed while its eviction waits is removed by the close; the eviction is abandoned and reports nothing. A dormant card's dot stills 52 ms after its session is closed mid-turn, with no turn's end stamped. | `row-35` (lineage, open bracket, streaming, never shown), `row-38` (no cover, close evicting), `row-43` (closed), `at0747` through an arrival, harness, M4 Max; `briefs/body-lifecycle-fixups-brief.md`. The audit's findings closed: no reveal loses turns, a never-shown body sleeps and is evicted, covers are bounded, declined evictions re-arm, and a bodiless card's dot follows its session's state with a thirty-minute horizon. [D219] records the whole. |
