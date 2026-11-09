<!-- brief-skeleton v1 -->

# Workspace skeletons: a switch shows the finished workspace as skeletons, and the real cards land on it as one picture

**Purpose:** A workspace switch must show the arriving workspace at once, every card in its place as a skeleton that visibly covers its own loading, and then replace the skeletons with the real cards in one picture. No card pops in on its own, nothing is painted over the skeletons, and the skeletons are seen seldom because parked workspaces are made ready ahead of the switch.

---

## Purpose {#purpose}

The user, 2026-11-08:

> I want to add a new facility where we save the complete card structure of each workspace. The idea here is that we can then quickly and hopefully immediately restore a skeletonized version of a workspace when we switch to it, and show an app-modal sheet as we turn that skeleton into the real cards.

And after an arc built a sheet that buried the skeletons and removed the hold that made the switch one picture, then was reverted:

> SKELETONS for the workspaces that cover their loading time. NO FLASHING. NO LONG DELAYS. SKELETONS!

Three things are asked for, in this order of priority. The skeletons: the arriving workspace drawn whole in its first frame, each pane carrying the card's own chrome with its content box standing in for content not yet there, and that picture staying up for as long as the card takes. No flashing: the real cards replace their skeletons together, never one by one, and nothing arrives over, under or between them. No long delays: the skeletons are on screen at the cut, the real cards land the moment they are all ready, and a parked workspace's cards are made ready before the user asks for them so that the skeletons are rarely seen at all.

---

## Evidence {#evidence}

**[F01] The card structure of every workspace is already saved, and the shell's cut is already immediate.** `putLayout` in `tugdeck/src/layout-persistence.ts` writes every space's panes and cards to tugbank, `loadBootLayout` seeds every space before the first render, and a visited workspace stays mounted while the canvas hides its layer (`tuglaws/state-preservation.md`, moment 7). The swap commit in `activateSpace` (`tugdeck/src/deck-manager.ts`) measured 4 to 8 ms on every switch read, and the shell paints within a frame or two (`briefs/workspace-switch-cheap-brief.md` [F01], [F02]). The structure is not what is slow. **(verified, read; the timings are from the earlier brief)**

**[F02] A skeleton already exists for every arriving card, in two layers.** The shell's stand-in (`tugdeck/src/components/chrome/body-stand-in.tsx`) draws the card's own chrome with the same `PaneChrome` the page draws, from the deck's facts, with its content box lidded in the pane's surface. The host draws a face from that stand-in's display list (`tugapp/Sources/BodyFaceHandOver.swift`) and stands it in the same `CATransaction` that hides the departing views, so the first switched frame shows the arriving chrome and no hole (`briefs/switch-hand-over-brief.md` [B02], [B03]). Where the host holds the card's last frame, the face is that frame instead (`covers`, `tugapp/Sources/BodyLifecycle.swift`). **(verified, read)**

**[F03] The skeleton says nothing about loading.** `briefs/workspace-create-flash-brief.md` [B02] and [B03] decided that a lidded content box wears the deck's `TugProgressWave` after a delay of about two frames, and that the stand-in and the host's face carry the wave's rest frame. It was not built: `TugProgressWave` is referenced only from `tug-progress-indicator.tsx` and `tug-progress-wave.tsx`, and the body's chrome frame (`tugdeck/src/body/body-chrome-frame.tsx`) and the stand-in store carry no indicator. A skeleton standing two seconds today is a still, blank box, which reads as a stuck app rather than a loading one. **(verified, grep)**

**[F04] The set reveal already lands the real cards as one picture, and its horizon is where the cascade comes back.** `BodyRevealSet` (`tugapp/Sources/BodyHandOver.swift`) holds each faced card's paint until every member has content-painted, then lands them in one transaction; a member counts only at its content paint. Its horizon is 2000 ms from the hand-over, and past it painted cards show as they come. Today's release log (`tugapp.log.2026-11-08`, 22:51) shows `hand-over past its horizon serial=6` then `reveal set past its horizon waiting=4`: a switch that waited the full horizon with four pages still unpainted, after which those four cascaded. **(verified, code and log)**

**[F05] The load behind the skeleton is the body pages, and nearly every first visit of the day is cold.** Each card is its own `WKWebView` page. The lane makes pages two at a time (`BodyLane.width = 2`, `tugapp/Sources/BodyLane.swift`), each page fetching the deck's whole module graph, and eight cold pages painted over about 1.45 s on the user's deck; a create's five rail cards over about 1.6 s (`briefs/workspace-switch-finished-picture-brief.md` [F04]). A hidden body goes dormant after five minutes and gives up its process after two hours (`BodyLifecycle.dormantAfter`, `evictAfter`); a parked workspace's cards are never made ahead since `warmParked` was retired (`briefs/body-lifecycle-program-brief.md` [B05]); and the user relaunches most days. Today's log shows whole workspaces going `dormant=yes` at 17:46 and 22:59 and coming back `dormant=no` on the return. **(verified, code and log)**

**[F06] What a made-ahead body costs.** A WebContent process is 53 MB at creation, the warm spare 146 to 148 MB, a Session body 205 to 244 MB with a transcript in it (`briefs/body-lifecycle-program-brief.md` [F06]). Pressure eviction takes hidden bodies oldest-first on a memory warning and every hidden body on critical, and is unchanged by anything here. **(verified, read from the earlier brief and `BodyLifecycle.swift`)**

**[F07] The reverted arc shows what not to build.** `dc92f4ead`, reverted and then reset away, removed the set hold and painted an opaque canvas-coloured sheet with a barber pole over the whole canvas between the rails. The sheet hid the skeletons entirely, the rail cards swapped from face to page one at a time, a Session card counted as shown at its chrome frame so the sheet could drop on a blank content box, and the sheet itself appeared and vanished on switches landing between roughly 100 and 300 ms. Every check that passed it was a harness check with the made-ahead path off by default; nobody looked at a switch in the app. **(verified, read from the arc's audit and the user's report)**

---

## Decisions {#decisions}

**[B01] The skeleton is the finished workspace, drawn whole in the first frame, and it is the thing on screen for the whole load.** Every arriving pane shows the card's own chrome with its content box standing in for content not yet painted, at the card's final place and size, from the first switched frame. This is [F02]'s stand-in and face, named as the target rather than a mechanism: nothing is drawn over it, nothing replaces it until the real cards are ready, and it is the picture the user sees for as long as the workspace takes. Where the host holds the card's last frame it stands that instead, since a card's own last picture is a better skeleton than its chrome alone, and the swap to the live page changes almost nothing. Saving a second copy of the structure buys nothing: [F01] says it is there and restored at once.

**[B02] The skeleton shows that it is loading.** The lidded content box wears the deck's own `TugProgressWave`, centered, after a delay of about two display frames so a card that paints at once never shows it and a card that takes a second shows it steadily. This is `briefs/workspace-create-flash-brief.md` [B02] and [B03], now built on the stand-in, on the body page's own lid, and on the host's drawn face as its rest frame: the face stands only until the shell's frame is on screen, after which the shell's stand-in beneath it carries the live animation. The indicator is on each skeleton and nowhere else. The sheet, the barber pole over the canvas, and any surface standing between the user and the skeletons are what [F07] built and are out. The wave is the glyph the app already loads under, which the user has said works just fine.

**[B03] The real cards land on the skeletons as one picture, and the set hold stays.** `BodyRevealSet` is the mechanism and is kept: a card's paint is held until every faced card of the switch has content-painted, then all land in one transaction. A member counts at its content paint and never at its chrome paint, which is already the rule and is pinned by a judge. The hold is not a wait the user watches, since the skeletons are the picture meanwhile; it is what makes the landing one event. Removing it is what brought the cascade back in [F07], and this decision protects it.

**[B04] Past the horizon, the painted cards land together once, and each straggler lands on its own skeleton when it paints.** The horizon stays near its recorded value, two seconds today, picked by the arc from the lane's recorded cold set times. At the horizon the cards that have painted land as one, and a card that has not keeps its skeleton with its wave until it paints, then lands alone. That landing is a loading card finishing, not a flash: its skeleton has been visibly loading the whole time, and nothing around it moves. The horizon's release is the one place a card may land apart from the set, and it exists so a page that never paints holds nothing for ever ([L33]).

**[B05] A switch never shows a frame of anything but the departed workspace, the skeletons, or the finished workspace.** No canvas in a pane, no departed card over an arriving one, no card drawn in another workspace's theme, no content box blanked after it has painted, and no indicator flickering for a frame. The judges of the finished-picture and hand-over arcs already hold most of this (`_row-44.ts`, `_row-10.ts`) and stay as they are; what is new is pinned beside them ([B08]).

**[B06] Parked workspaces' pages are made ahead, hidden, into the dormant tier, so the skeletons are seldom seen.** This reopens `briefs/body-lifecycle-program-brief.md` [B05] and the non-goals of the create and finished-picture briefs, on the user's direction: the skeletons are cheap and this is what makes a switch land at once on the common day. After launch, once the shown workspace's pages have painted and the lane is idle, the lane makes pages for every parked workspace's cards, hidden, declared dormant as they paint, most recently shown workspace first. A workspace whose pages time eviction has taken is made again when the lane is next idle. Pressure eviction is the governor ([F06]) and stays as it is; a machine short of memory gets the skeletons. Acceptance is a reading: resident memory at rest with every workspace made ahead on the user's deck, and a switch onto a workspace made ahead and not yet visited this run painting with no skeleton seen.

**[B07] The lane widens for a switch.** While a switch has unpainted skeletons the lane may load more than two pages at once: the recorded six-at-once total was 4.8 s against two-at-a-time's 5.5 s, and with the set landing as one, the last page is the one that matters. The width is the arc's to pick from a reading on the user's deck; outside a switch the lane and the spare are untouched.

**[B08] A reading first, judges red on today's build, and the app looked at before anything joins.** First, a frame and timing recording of a cold switch on a deck shaped like the user's, gesture to set landing, and today's resident memory at rest. Then judges in the harness, each red before its fix: the skeleton's wave appears after the delay and not before; the host's face carries the wave's rest frame; no faced page shows before the set lands or the horizon passes; at the horizon the painted cards land in one frame; a switch onto pages made ahead shows no stand-in at all; and every judge runs with the made-ahead path on, since [F07]'s checks ran with it off. Every new test carries `@covers` and stays under the corpus's 20 s budget. And because a change you can see needs someone to look at it, the arc builds the app and records a real switch on a real-shaped deck, with the frames in the arc's record, before its join is offered.

---

## Open Questions {#open-questions}

- **Whether every workspace made ahead fits in memory on the user's deck.** [F06] puts a made-ahead card at roughly 150 MB at rest, more with a transcript; four workspaces of several cards is on the order of gigabytes. Settled by the memory reading in [B08]. If it does not fit, the fallback is the most recently shown parked workspace only, recorded as a decision if taken.

- **What idle is for the lane to start making pages ahead.** The spare waits a second after the last bound body's ready. Whether making ahead should also wait for the shown workspace's catch-up brackets to close, so it never competes with a streaming session, is read from `tugcast.log` on the user's deck.

---

## Non-goals {#non-goals}

- **A sheet, modal or otherwise, over the arriving canvas or the window.** Built in [F07] and reverted. It hides the skeletons, which are the point, and it cannot both show them and hide a cascade.
- **Removing or weakening the set hold.** [F07] again. The hold is what makes the landing one picture.
- **Counting a card painted at its chrome frame.** A member counts at content paint only ([B03]); the other reading drops the picture onto a blank box.
- **Saving a second copy of the card structure.** It is in tugbank and restored at once ([F01]).
- **A per-card loading account anywhere.** Each skeleton carries its own wave; there is no list, count or name.
- **Changing the dormant or eviction clocks.** They stay; [B06] makes pages again after a time eviction rather than preventing it.
- **The cover snapshot's cost.** `snapshot_ms` of 59 to 206 ms per crossing card in today's log is on the switch's path and worth a reading of its own, not this one.

---

## Exit {#exit}

An arc. The first act is [B08]'s reading and its judges written red with the made-ahead path on. Then [B02], the wave on the skeleton, which is the smallest change with the largest effect on how the wait reads. Then [B04], the horizon's landing, and the content-paint judge of [B03]. Then [B07], the lane's switch width, read against the set's landing time. Then [B06], making parked pages ahead, gated on the memory reading. The last act before the join is offered is the recorded look at a real switch in the built app.
