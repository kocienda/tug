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

**[F03] The cause of [F02] is not known.** It is not the theme flip (`tests/app-test/readings/at0813-switch-canvas-grid-reading.test.ts`: about 10 ms of commit cost, no horizons). It does not reproduce on a harness deck shaped like the user's. A passive recorder of main-thread and frame gaps over 100 ms (`window.__swProbe`) was armed in the live shell page on 2026-11-13 and has not yet been read; it is gone when the app restarts. Whether the shell's main thread is blocked for those seconds, or its frame is stuck further down the rendering path, is what that reading would say. **(not established)**

**[F04] Streaming sessions do not slow a switch in the harness.** `tests/app-test/readings/at0815-switch-under-streams-reading.test.ts`: four workspaces, 30 cards, four stub sessions, twelve switches a round. Idle: hold median 58 ms, max 74 ms, shell main-thread gap max 18 ms. All four streaming at about 40 updates a second each: hold median 50 ms, max 74 ms, gap max 16 ms. The host ground was needed on none of the 24. **(verified)**

**[F05] The live shell is idle at rest.** Read passively through `tugtool deck motion rest` and `frames` on the live instance: 0 rendering updates a second, worst main-thread gap 3 ms, 240 of 240 window frames delivered. How many sessions were mid-turn at that moment was not recorded. **(verified, one reading)**

**[F06] The user's deck.** Five workspaces, each with its own theme (`ironclad`, `collier`, `sloop`, `barque`, `caravel`), each with its own five rail cards (Overview, Jots, Dashes, Workspaces, Layout); 20 Session cards and 4 Text cards; 50 card pages on tugcast's sockets; the shell page subscribed to every session's feed. **(verified: `tugtool deck pages`, and the saved layout read through `tugbank`)**

**[F07] The host's background work is the per-workspace rail duplicates.** The log for the day holds about 8,000 `park cover` lines (a hidden card's last frame retaken), 33 GB of bitmap bytes. By card kind: Workspaces 3,929 (49%), Layout 3,624 (45%), Session 267 (3%), everything else 182. The eight most-retaken cards are exactly the Workspaces and Layout cards of the four hidden workspaces. **(verified)**

**[F08] The retakes are a loop, and they do not follow session activity.** The 7,553 Workspaces and Layout retakes came from 193 `stale` marks, and 5,549 of them fire less than 100 ms after the one before. 85% happen more than ten seconds from any switch. Retakes per minute are flat across quiet and busy minutes of tugcast's log, though that activity measure (log lines per minute) is crude. What triggers the loop was not found; `ebbaa029a` makes a move of the shared list anchor or cursor mark every parked Workspaces page stale, which is the likely source. **(counts verified; the trigger is inference)**

**[F09] The Workspaces card is N copies made to look like one.** Each workspace holds its own Workspaces card, so a switch swaps one page for another and then reproduces the departed one's scroll position and cursor in the arrived one (`6a45d5b90`, `42a3b488c`, `ebbaa029a`). The jumping the user reports is the cost of that reproduction. **(verified: read from the commits and `tugdeck/src/components/cards/cards-card.tsx`)**

**[F10] Skeletons are a fallback today.** The switch tries to show real pages and covers the ones that are not ready (`briefs/workspace-skeletons-brief.md`). The cheap picture is not the base the switch is built on. **(verified: read from that brief and `tugapp/Sources/BodyFaceHandOver.swift`)**

---

## Decisions {#decisions}

**[B01] The host owns a workspace's picture, and a switch involves no web process.** The current design fails because correctness depends on several processes agreeing on timing ([F01]), and one of them is seconds late on the user's deck for a reason nobody has found ([F02], [F03]). A switch that reads nothing from any page cannot be made late by one. This is the decision the rest follow from.

**[B02] Each workspace is a stage.** A stage is a native container holding the workspace's ground and its cards' views at their frames. It is kept composed while hidden and updated when the layout changes, never at a switch. A switch hides one stage and shows another in a single `CATransaction`.

**[B03] The host draws the canvas and grid, always.** Each stage draws its own ground natively in its workspace's colours, on the shell's lattice. The shell page stops drawing pixels beneath cards. This reverses the decision `tests/app-test/body-grounding/floor-host.test.ts` guards ("the canvas beneath the cards is the shell's own, pixel for pixel"), deliberately: that test is rewritten or removed with the reversal named in the commit, not re-pointed quietly. The transient ground of `b1d67a659` becomes the standing one.

**[B04] Every card always has a host-held picture.** In order of preference: its live page when the page is current; its last frame when the page has reported no drawn change since the frame was taken; otherwise a skeleton the host draws from layout data (frame, title bar, kind, theme colours). The host never needs a page's answer to have something correct to show.

**[B05] The whole skeleton structure lands as one picture, and each card loads into its own skeleton as it can.** The user's call. The cut's frame is complete: ground and every card's place. After it, each card's real page replaces its own skeleton independently; no card waits on another.

**[B06] A card whose page is already current is shown live in the cut's own frame.** This is the brief's reading of [B05], stated to the user and not objected to: a warm switch should not blink through skeletons for cards that are ready. If skeletons are wanted first in every case, this decision changes and nothing else does.

**[B07] Nothing is retaken in the background.** A card's last frame is kept when it parks. A page that changes while hidden marks its frame stale, and the card falls back to its skeleton at the next cut. Hidden pages cause no host snapshot work, which ends the loop of [F07] and [F08].

**[B08] The host is the authority on the active workspace.** A click in the Workspaces card or a chord reaches the host, which cuts at once. The shell is told and catches up; its model, theme and arrangement may lag the picture without anyone seeing it.

**[B09] Sidebar rails are shared across all workspaces.** The user's call: "I know this kinda sucks in its way, but we need to get on firm ground here." One set of rail cards belongs to the window and lives outside the stages. A switch never touches it, so the Workspaces list has no scroll position to reproduce ([F09]) and the duplicates of [F07] do not exist. Which rail cards are open, their sides, order and widths become one window-level setting; at migration it is taken from the active workspace. Rails per workspace may be reopened later and are out of scope here.

**[B10] The rail follows the active workspace's theme.** The user's call. On a switch between workspaces of different themes, a rail card is a live page that cannot re-skin in the cut's frame, so it gets a host-drawn skeleton in the arriving theme until its re-skinned frame lands — the mechanism of [B04] and [B05], no second one. The cost is a brief rail blink on cross-theme switches only; its length is to be measured, not assumed.

**[B11] The switch machinery this replaces is deleted.** The switch hold, the held window picture, the face hand-over, the transient ground, switch-time park-cover retakes and the placement's switch latch go. Make-ahead stays as an optimisation that makes more cards current at the cut; correctness does not depend on it.

**[B12] One judge defines the architecture.** Stall the shell page and every card page for two seconds, then switch. Every window frame must be wholly the departed workspace or wholly the arrived one (skeletons allowed), within two display frames of the gesture, and the rail must not move. The current design cannot pass it; the new one must before anything else is claimed.

---

## Open Questions {#open-questions}

- **Which rail cards show workspace-scoped content?** Not checked for Dashes, Jots, Overview and Layout. A shared rail card that shows only the current workspace's content must re-scope after the cut, in a live page, and whether that update needs the skeleton treatment of [B10] depends on how visible it is. Reading each card's data source settles it.
- **What makes the user's shell frame seconds late ([F03])?** [B01] makes the switch independent of the answer, but the shell still has to catch up, and a three-second lag in its model would be felt in whatever reads it. Reading the armed recorder after a few live switches, or re-arming it, settles whether the main thread is blocked.
- **What triggers the retake loop ([F08])?** [B07] and [B09] remove the loop's subjects, so the question matters only if the same trigger also costs the pages themselves.
- **How long is the cross-theme rail blink ([B10])?** A measurement on a five-theme deck. If it reads as a flash on every switch, the window-level rail theme recorded under Non-goals is the fallback to bring back to the user.

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
