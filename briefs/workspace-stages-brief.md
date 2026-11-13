<!-- brief-skeleton v1 -->

# Workspace stages: the host owns a workspace's picture, a switch is one native cut onto skeletons, and the rail is the window's

**Purpose:** Round after round of work on workspace switching has not produced a switch that is fast, glitch-free and steady in the Workspaces card. This brief records why the current architecture cannot get there and the architecture that replaces it.

---

## Purpose {#purpose}

The user's report, after the latest fix:

> We're making *round after round* of hacks on the Workspace system, switching workspaces, the Workspaces sidebar card... and ***we are not achieving the goals I have for fast, responsive, and glitch-free*** management and switching of workspaces. We need to back up, look at our direction afresh, and take a new tack.

The goals, in the user's words:

- Fast switching of workspaces, with no undue delays, since the work can be based on cheap-to-render *skeletons* of the workspace's cards and content.
- No visual delays or glitches as workspaces switch, and no leaking of the departing workspace's content into the newly arriving one.
- No jumping, hopping, or scroll repositioning in the Workspaces sidebar card.

The instruction was to take nothing about the current architecture for granted.

---

## Evidence {#evidence}

**[F01] Nobody owns the frame.** A switch's picture is assembled from the shell page (canvas and grid), one page per card, and host layers, each presenting on its own clock. The switch is made to look atomic by coordination: a held window picture, a 100 ms bar, a 300 ms horizon, a placement latch, host-drawn faces, park covers, and since `b1d67a659` a transient host ground. The machinery is about 15,800 lines across `tugapp/Sources/Body*.swift`, `tugdeck/src/lib/body-*.ts`, `tugdeck/src/lib/card-placement.ts` and `tugdeck/src/body/`. More than fifty briefs under `briefs/` concern the body lifecycle or workspace switching. **(verified: line count and listing read from the tree)**

**[F02] On the user's deck the shell's switched frame is seconds late.** The live instance's log (`release-main`, `tugapp.log.2026-11-13`), running the build with the host ground, holds 27 switches on which the ground stood. The shell's own frame arrived in under 300 ms on 4, in 2.8–3.1 s on 12, and not within the 3 s ground horizon on 11. On the build before it, 17 of 25 holds ended at the 300 ms horizon with `shell_ms=none`. The shell's placement message arrives on time (about 30 ms) in every case. **(verified: read from the log)**

**[F03] The shell's main thread is blocked for about three seconds at each switch on the user's deck.** A passive recorder of main-thread and frame gaps over 100 ms was armed in the live shell page and read after the user's next switches. The two switches inside its window (14:51:37Z and 14:54:34Z) each show one main-thread gap, 3,200 ms and 3,084 ms, ending where the host logged the shell's frame or the ground's horizon. The shell posts its placement about 30 ms after the gesture and then runs nothing for three seconds. **(verified: two switches)**

**[F03a] What blocks it is the host's own snapshot of the shell.** A stack sample of the shell's web process, taken across a live switch (15:06:20Z, hold serial 30, ground lifted at the horizon): for the whole of the sample the main thread sits in one frame, `WebPage::takeSnapshot` → `WebImage::createImageBufferBackendHandle` → `RemoteImageBufferProxy::flushDrawingContext` → `IPC::Semaphore::waitFor`, a timed wait on the GPU process. That snapshot is the switch hold's question "has the shell rendered?": `askShell` in `tugapp/Sources/BodyFaceHandOver.swift` calls `snapshotShell` for a one-pixel rect, with `afterScreenUpdates`, once per switch. The shell is not slow to draw; it is stopped by the instrument that asks whether it has drawn, until WebKit's wait gives up about three seconds later. This is why the length is nearly constant (2.8–3.2 s across 14 switches). The GPU process in the same sample is idle: some seventy rendering work queues, nearly all waiting. **(verified: one sampled switch; the same frame for all 3,504 samples)**

**[F03b] Why the GPU process does not answer that flush is not known, and other snapshots share the path.** The wait is quick on the first one or two switches of a launch and times out on nearly every later one, and it never times out in the harness, so something on a long-lived, many-page deck leaves the snapshot's image buffer unanswered. The host takes page snapshots through the same WebKit call in two more places: a card's frame for a cover or a parked last frame (`snapshotFrame` in `tugapp/Sources/BodyViewController.swift`), which is the 8,000-a-day loop of [F07], and the shutdown freeze. The day's log holds 32 parked-frame snapshots that failed or did not answer inside their two-second deadline, and each of those may have stopped its page the same way; that was not sampled. Ruled out along the way: the theme flip (`at0813`), a theme per workspace with sessions streaming (`at0815`, third round: main-thread gap max 22 ms), the ground-colour read `b1d67a659` added (1 ms on the live shell at rest), and the shell's DOM (298 elements). **(the unanswered flush's cause not established)**

**[F04] Streaming sessions do not slow a switch in the harness.** `tests/app-test/readings/at0815-switch-under-streams-reading.test.ts`: four workspaces, 30 cards, four stub sessions, twelve switches a round. Idle: hold median 58 ms, max 74 ms, shell main-thread gap max 18 ms. All four streaming at about 40 updates a second each: hold median 50 ms, max 74 ms, gap max 16 ms. The host ground was needed on none of the 24. **(verified)**

**[F05] The live shell is idle at rest.** Read passively through `tugtool deck motion rest` and `frames` on the live instance: 0 rendering updates a second, worst main-thread gap 3 ms, 240 of 240 window frames delivered. How many sessions were mid-turn at that moment was not recorded. **(verified, one reading)**

**[F06] The user's deck.** Five workspaces, each with its own theme (`ironclad`, `collier`, `sloop`, `barque`, `caravel`), each with its own five rail cards (Overview, Jots, Dashes, Workspaces, Layout); 20 Session cards and 4 Text cards; 50 card pages on tugcast's sockets; the shell page subscribed to every session's feed. **(verified: `tugtool deck pages`, and the saved layout read through `tugbank`)**

**[F07] The host's background work is the per-workspace rail duplicates.** The log for the day holds about 8,000 `park cover` lines (a hidden card's last frame retaken), 33 GB of bitmap bytes. By card kind: Workspaces 3,929 (49%), Layout 3,624 (45%), Session 267 (3%), everything else 182. The eight most-retaken cards are exactly the Workspaces and Layout cards of the four hidden workspaces. **(verified)**

**[F08] The retakes are driven by any change to any card anywhere on the deck.** The mechanism, read from the code: a hidden page keeps the signature of what it drew when it was hidden (`tugdeck/src/body/body-staleness.ts`), and `noteDrawnStoreApplied` in `tugdeck/src/body/body-main.ts` posts `bodyStale` again at every later move of that signature. The host's `noteStale` (`tugapp/Sources/BodyViewController.swift`) queues a fresh last frame on every one of those posts, and logs `stale` only on the first, which is why 7,553 retakes show 193 marks. For a kind that follows the whole deck the signature holds the entire `deckCards` replica and both arrangement stores, so a move in any card's entry in any workspace moves it. Read from two hidden live pages (a Workspaces card and a Layout card), the parts that had moved were `deckCards` and `arrangement`, 2.5 s before the read with no switch in between. Which field of a card's entry moves while a session runs was not read. 85% of the retakes happen more than ten seconds from any switch, and 5,549 fire less than 100 ms after the one before. **(mechanism and moved parts verified; the moving field not read)**

**[F08a] The loop has a standing cost.** At rest on the live deck, with no switch in progress, the app's GPU process was at 28% of a core (one `ps` reading). The harness does not reproduce the loop: its stub sessions leave the retakes at about six per switch, streaming or idle ([F04]), which is consistent with the stubs not moving their cards' deck entries. **(one reading; the link to the stubs is inference)**

**[F09] The Workspaces card is N copies made to look like one.** Each workspace holds its own Workspaces card, so a switch swaps one page for another and then reproduces the departed one's scroll position and cursor in the arrived one (`6a45d5b90`, `42a3b488c`, `ebbaa029a`). The jumping the user reports is the cost of that reproduction. **(verified: read from the commits and `tugdeck/src/components/cards/cards-card.tsx`)**

**[F10] Skeletons are a fallback today.** The switch tries to show real pages and covers the ones that are not ready (`briefs/workspace-skeletons-brief.md`). The cheap picture is not the base the switch is built on. **(verified: read from that brief and `tugapp/Sources/BodyFaceHandOver.swift`)**

**[F11] Four of the five rail kinds are deck-global already; Layout is the workspace's.** Read from each card's data source. Arcs (`dashes`) lists every arc from the account-wide changeset store; only its Bind, Unbind and Replay target follows the key card on screen. Jots is one machine-wide document. Overview is the app-scoped post ledger, and its draft is already held by the shell because per-card copies brought deleted drafts back. Workspaces (`cards`) lists every workspace and card; its folds, filter and selection are already in shared stores, and the active workspace only changes which rows are dimmed and can act. Layout reads and writes the active workspace's own deck: its imposition, panes and slots (`tugdeck/src/components/layout/layout-card.tsx`, through `getDeckView()`). **(verified: read from the code)**

**[F12] What differs between the per-workspace copies today is view state.** Scroll position for all five kinds (the card-host bag is keyed by card id), the Arcs card's expanded rows, the Jots filter text, and the Arcs card's memory of the last key card. **(verified: read from the code)**

**[F13] A rail card re-skins in about four frames.** `tests/app-test/readings/at0816-rail-reskin-reading.test.ts`: a workspace's theme flipped between `ironclad` and `sloop` six times, window frames read every 16 ms. Each of the five rail cards' panes reached its settled colours a median of 62 ms and at most 81 ms after the flip; the shell's own canvas did in 33 ms. That time includes the shell relaying the theme to each page, which is today's path. The rail cards on the harness deck are nearly empty, so a long Workspaces list or Overview transcript may take longer; that was not read. **(verified on an empty rail)**

---

## Decisions {#decisions}

**[B01] The host owns a workspace's picture, and a switch involves no web process.** The current design fails because correctness depends on several processes agreeing on timing ([F01]), and one of them is seconds late on the user's deck for a reason nobody has found ([F02], [F03]). A switch that reads nothing from any page cannot be made late by one. This is the decision the rest follow from.

**[B02] Each workspace is a stage.** A stage is a native container holding the workspace's ground and its cards' views at their frames. It is kept composed while hidden and updated when the layout changes, never at a switch. A switch hides one stage and shows another in a single `CATransaction`.

**[B03] The host draws the canvas and grid, always.** Each stage draws its own ground natively in its workspace's colours, on the shell's lattice. The shell page stops drawing pixels beneath cards. This reverses the decision `tests/app-test/body-grounding/floor-host.test.ts` guards ("the canvas beneath the cards is the shell's own, pixel for pixel"), deliberately: that test is rewritten or removed with the reversal named in the commit, not re-pointed quietly. The transient ground of `b1d67a659` becomes the standing one.

**[B04] Every card always has a host-held picture.** In order of preference: its live page when the page is current; its last frame when the page has reported no drawn change since the frame was taken; otherwise a skeleton the host draws from layout data (frame, title bar, kind, theme colours). The host never needs a page's answer to have something correct to show.

**[B05] The whole skeleton structure lands as one picture, and each card loads into its own skeleton as it can.** The user's call. The cut's frame is complete: ground and every card's place. After it, each card's real page replaces its own skeleton independently; no card waits on another.

**[B06] A card whose page is already current is shown live in the cut's own frame.** This is the brief's reading of [B05], stated to the user and not objected to: a warm switch should not blink through skeletons for cards that are ready. If skeletons are wanted first in every case, this decision changes and nothing else does.

**[B07] Nothing is retaken in the background.** A card's last frame is kept when it parks. A hidden page says it is stale once, the host records that and takes no snapshot, and the card falls back to its skeleton at the next cut. The page's repeat of `bodyStale` at every later move, and the host's retake on each ([F08]), are removed. Hidden pages cause no host snapshot work.

**[B07a] A page's staleness is judged by what that page draws.** Today a kind that follows the whole deck is stale when any card's entry anywhere moves ([F08]). With the rail shared ([B09]) no hidden page follows the whole deck, so a workspace card's signature is its own entry and its own context, and a session running in one card cannot make another card stale.

**[B07b] The host never snapshots a live page on a path the user is waiting on.** A WebKit snapshot stops the page's main thread until the GPU process answers, and on the user's deck that answer can take three seconds ([F03a], [F03b]). So no switch, reveal or cut asks a page for a snapshot or waits on one. A page says it has drawn by posting a message from its own frame callback, which costs it nothing. The one snapshot that remains is a card's last frame taken as it parks ([B07]), after the cut, one card at a time, where a slow answer delays nothing on screen; if that snapshot does not answer, the card has no last frame and shows its skeleton.

**[B08] The host is the authority on the active workspace.** A click in the Workspaces card or a chord reaches the host, which cuts at once. The shell is told and catches up; its model, theme and arrangement may lag the picture without anyone seeing it.

**[B09] Sidebar rails are shared across all workspaces.** The user's call: "I know this kinda sucks in its way, but we need to get on firm ground here." One set of rail cards belongs to the window and lives outside the stages. A switch never touches it, so the Workspaces list has no scroll position to reproduce ([F09]) and the duplicates of [F07] do not exist. Which rail cards are open, their sides, order and widths become one window-level setting; at migration it is taken from the active workspace. Rails per workspace may be reopened later and are out of scope here.

**[B10] The rail follows the active workspace's theme.** The user's call. On a switch between workspaces of different themes, a rail card is a live page that cannot re-skin in the cut's frame, so it gets a host-drawn skeleton in the arriving theme until its re-skinned frame lands — the mechanism of [B04] and [B05], no second one. The cost is a brief rail blink on cross-theme switches only; its length is to be measured, not assumed.

**[B10a] The Layout card re-scopes to the arriving workspace after the cut, as a live page.** It is the one rail kind whose content is the workspace's ([F11]). It already reads the active deck, so in a shared rail it follows the switch with no new mechanism; what it shows changes a moment after the cut. On a same-theme switch that change is drawn in place, with no skeleton: the card's frame, title and rows keep their positions and only the values move. On a cross-theme switch it is under the skeleton of [B10] anyway. The other four kinds show the same content before and after ([F11]) and do not change at a cut.

**[B10b] A shared rail card has one view state.** One scroll position, one set of expanded rows, one filter per rail card, where there were as many as workspaces ([F12]). At migration the active workspace's copy is the one kept. The shared list anchor and cursor stores that kept N Workspaces cards in step (`6a45d5b90`, `42a3b488c`, `ebbaa029a`) have nothing left to synchronise and go with the duplicates.

**[B11] The switch machinery this replaces is deleted.** The switch hold, the held window picture, the face hand-over, the transient ground, switch-time park-cover retakes and the placement's switch latch go. Make-ahead stays as an optimisation that makes more cards current at the cut; correctness does not depend on it.

**[B12] One judge defines the architecture.** Stall the shell page and every card page for two seconds, then switch. Every window frame must be wholly the departed workspace or wholly the arrived one (skeletons allowed), within two display frames of the gesture, and the rail must not move. The current design cannot pass it; the new one must before anything else is claimed.

---

## Open Questions {#open-questions}

- **Why does the GPU process leave a snapshot's flush unanswered on a long-lived deck ([F03b])?** [B07b] takes every snapshot off the paths the user waits on, and [B07] cuts their number from thousands a day to one per parked card, so the design no longer depends on the answer. It is still worth one look inside the arc, because a parked-frame snapshot that stops a hidden page for three seconds delays that page's catching up. A sample of the GPU process and of a hidden page across a parked-frame snapshot on the user's deck would say whether the page is stopped and what the GPU process is waiting for.
- **Does a four-frame rail skeleton read as a flash ([B10], [F13])?** The length is measured: about 60 ms, 80 ms at worst, on an empty rail. Whether a skeleton standing that long on every cross-theme switch is acceptable is a judgement of the eye, not a measurement, and it is the user's. It is made on the first build that has the shared rail, on the user's own five-theme deck. If it reads as a flash, the window-level rail theme recorded under Non-goals is the fallback to bring back.

---

## Non-goals {#non-goals}

- **Rails per workspace.** Set aside by [B09] until the user reopens it.
- **A rail with one window-level theme.** Considered: it never blinks, but a dark rail can sit beside a light workspace. The user chose the workspace's theme ([B10]).
- **All cards landing as one picture.** Considered and rejected: the slowest card would hold back every other.
- **Further fixes to the hold, faces, covers or ground.** Each earlier round added a cover for a timing mismatch ([F01]). No more of them.
- **Making sessions cheaper as a switch fix.** Streaming does not slow the switch in any measurement here ([F04], [F05]).
- **Finding the late shell frame's cause before starting.** The design does not depend on it ([B01]).

---

## Exit {#exit}

**An arc.** The raw material for its steps, in the order they must land:

1. The judge of [B12], red on today's tree: stalled shell, stalled pages, window frames read at the cut, rail position read across it.
2. Host-drawn ground per workspace as the standing canvas ([B03]), with `floor-host.test.ts` reversed in the open.
3. Stages: one native container per workspace, composed while hidden, with a host-drawn skeleton for every card from layout data pushed at layout change ([B02], [B04]).
4. The cut: host-originated, one transaction, current cards live and the rest skeletons, each card loading into its own ([B05], [B06], [B08]).
5. The shared rail: one set of rail cards outside the stages, the arrangement migrated to a window-level setting, the cross-theme re-skin under a skeleton ([B09], [B10]).
6. Deletion of the replaced machinery and the tests that judged it, each ended as fixed, changed or deleted ([B11]), and the end of background retakes ([B07]).
