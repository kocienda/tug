<!-- brief-skeleton v1 -->

# Workspace switch: a card that has painted never arrives as a blank pane

**Purpose:** Switching workspaces often flashes the arriving workspace's cards. The flash is a host-drawn skeleton standing over a card whose session did something while its workspace was hidden, and this brief records the cause and the rule that replaces it.

---

## Purpose {#purpose}

The user's report, 2026-11-21:

> We're (unfortunately) back to... flashing when switching workspaces…. again. The destination workspace's cards often flash! Can't have this!

The stages architecture (`briefs/workspace-stages-brief.md`, landed `369d83290` and `5fe3f7bf5`) made the cut itself a single native transaction. What flashes is what the cut shows for each arriving card.

---

## Evidence {#evidence}

**[F01] The cut is fast and atomic.** Every `stage cut` line in the live instance's host log (`release-main`, `tugapp.log.2026-11-14` through `2026-11-21`) reports 0.5–0.7 ms, 6–7 ms at worst. **(verified: read from the log)**

**[F02] More than half of all cuts land with a skeleton in the arriving workspace.** Of the 749 cuts in those eight logs, 416 (56%) showed at least one skeleton, 289 (39%) at least one last frame, and 180 (24%) were all live. **(verified: counted from the `live=`, `last_frame=`, `skeleton=` fields)**

**[F03] A stale card loses its last frame and falls to a skeleton.** `noteStale` in `tugapp/Sources/BodyViewController.swift` calls `lifecycle.covers.dropParked(cardId)` at a hidden page's `bodyStale`, and `StagePicture.choose` in `tugapp/Sources/BodyStages.swift` returns `.lastFrame` only when `hasLastFrame && !stale`, else `.skeleton`. This is [B07] of `briefs/workspace-stages-brief.md` working as written. **(verified: read from the code)**

**[F04] What makes a Session card stale is its own session's phase.** `window.__tugBodyStale` was read from the live card pages through the loopback eval door (opened, read, closed). Every hidden Session card with a turn running that had gone stale named one moved part, `deckCards.activity`: cards `58614d6b`, `9db049ee` and `9d4a5ebf`. `activity` is the session phase key the page itself reports to the shell (`tugdeck/src/bus/declarations/deck.ts`), echoed back in its own `deckCards` entry, which `drawnParts` in `tugdeck/src/body/body-staleness.ts` takes whole. **(verified: three cards, one reading)**

**[F05] The pattern repeats at every departure.** In the log, card `dc1ea489` is parked about 1.2 s after each cut away from its workspace, says stale one to eight seconds later, and is the one skeleton at the next cut back (cuts at 01:59:22, 03:03:15 and 03:06:47 UTC on 2026-11-21, each followed by `park cover` then `stale`). The week holds 775 `stale` marks. **(verified: read from the log)**

**[F06] The skeleton stands until the page has woken and held still.** A page shown again while not current waits for three quiet frames, 120 ms at most (`SHOWN_QUIET_FRAMES`, `SHOWN_QUIET_MAX_MS` in `tugdeck/src/body/body-main.ts`), before it says `painted` and its picture comes down. How long a skeleton actually stands on the user's deck was not measured: the host logs nothing when a picture comes down. **(code read; the dwell not measured)**

**[F07] A parked page is hidden with `isHidden`, so it stops painting.** `applyVisibility` hides a body that has been shown once by its container's `isHidden`, "so WebKit throttles a parked or folded body". Siblings and pages made ahead are hidden by opacity instead and keep painting. A parked page's layer is therefore behind whenever its DOM moved, whatever the staleness signature says. **(verified: read from the code)**

**[F08] Two smaller sources give the same blank pane.** The week holds 125 `no frame for a parked card's last frame` warnings, each leaving a card with no frame for its whole hidden period, and 110 evictions, after which a page loads from scratch (235–437 ms to `ready` in today's log after a relaunch). **(verified: counted from the log)**

**[F09] `activity` has been in the deck entry since `e554059a7` (2026-10-20).** The flash is not a regression in the signature; it is [B07]'s fallback meeting sessions that run while hidden, and it began with the stages landing on 2026-11-13. **(verified: `git log -S`)**

**[F10] Whether the last-frame-to-live swap is itself visible is not known.** The 289 cuts with a last frame end in a swap onto the live page. The log cannot say whether the two pictures differed. **(not established)**

---

## Decisions {#decisions}

**[B01] A card that has painted, and whose shape and skin have not changed, never shows a blank pane.** A skeleton is the right picture for a card with nothing to show or whose frame would be wrong. For a card whose content merely moved it replaces a nearly right picture with an empty one, and that is the flash ([F02], [F03]). This is the rule the rest follow from.

**[B02] `bodyStale` says what moved, and the host sorts it into content or shape.** The page already computes the moved parts for `__tugBodyStale`; the message carries them. A content move (`deckCards.activity`, the title, key state) leaves the last frame older but not wrong, and the frame is kept. A shape or skin move (`cardTheme`, `paneChrome`, zoom, folded) would make the frame wrong, and it is dropped as today. A page still says stale once per hidden period, so a content move followed by a shape move must not be lost: the page says stale again when the class rises from content to shape.

*2026-11-21, revised at the policy's landing:* `paneChrome` is not shape whole. The judge showed a session starting a turn moves three parts, not one: `deckCards.activity`, `deckCards.waivesClose` and `paneChrome`, the last through the pane's close-asks record (what a close gesture asks while a turn runs). With `paneChrome` classed shape the frame was still dropped and the card still a skeleton, which is the flash this decision exists to end. So the signature takes the pane's chrome one part per field, as it does the context and the card's entry, and the classing splits it: `title`, `icon`, `close`, `spaces` and `ownSpaceId` are content (the card's name, and fields that draw nothing on a still picture); every other field of the chrome (tabs, place, width, grips, fold glyph, slot) is shape.

**[B03] The policy prefers an older frame to a blank one.** `StagePicture.choose` returns `.lastFrame` whenever a frame is kept, and `.skeleton` only when none is. This reverses [B07] of `briefs/workspace-stages-brief.md` ("the card falls back to its skeleton at the next cut") for content moves. The policy tests that assert the old fallback change in the open, with the reversal named in the commit, and that brief is amended in the same change.

*2026-11-21, at the policy's landing:* [D230] in `tuglaws/design-decisions.md` carried the same fallback in its order of preference ("its last frame when the page has said nothing moved since the frame was taken"), so it is amended in the same change beside the stages brief. A frame is treated as wrong, and not shown, only when the card's page said a shape or skin move at or after the frame was taken; a frame taken after such a move stands.

**[B04] A parked page keeps painting until it goes dormant.** For the first five minutes (`dormantAfter`) a parked card is hidden by its stage's opacity, not `isHidden`, as siblings and made-ahead pages already are ([F07]). Its layer is current at the cut, so it shows live with no picture and no swap. [B03] alone still shows the old transcript and then the new one about 100 ms later, which may read as a hop; this removes it for short absences. The cost is that hidden streaming sessions render as if visible. It lands only after a reading under `tests/app-test/readings/at0815-switch-under-streams-reading.test.ts` shows the cut and the shell's main thread unharmed; if the reading is bad, this decision is dropped and the others stand.

*2026-11-21, the reading:* `tests/app-test/readings/at0815-switch-under-streams-reading.test.ts` with parked pages painting, twelve switches a round. The reading now times the stage cut where [F04] of `briefs/workspace-stages-brief.md` timed the hold. Idle: cut median 11 ms, max 13 ms, shell main-thread gap max 17 ms. Four sessions streaming: cut median 1 ms, max 9 ms, gap max 11 ms. A theme per workspace: cut median 28 ms, max 48 ms, gap max 19 ms. Every figure is inside [F04]'s (hold median 50–58 ms, gap max under 25 ms), so the decision lands. A parked page is hidden by its container's opacity inside its hidden stage, gives up the keyboard as a hidden view does, and is hidden by `isHidden` once it is declared dormant; a `bodyStale` from it changes no picture and only records when it was said, which is what makes the dormancy frame of [B05] be taken. The judge shows the card `live` at the cut. The harness's stub sessions do not move their cards' deck entries, so the cost of many real sessions rendering while parked was not read here.

**[B05] A page going dormant has its last frame taken at that moment.** It is still painted and current then, so the frame is good. A return after a long absence shows that frame, and the session's catch-up draws in place on the live page.

**[B06] A failed park snapshot is retried once.** One miss today costs the card its frame for the whole hidden period ([F08]). The retry runs after the cut, one card at a time, as the first attempt does ([B07b] of the stages brief still holds: no snapshot on a path the user waits on).

*2026-11-21, at their landing:* the dormant clock asks for the frame through the same queue the cut's frames use, and the page is told to sleep when that card's turn ends, so the declaration can trail the clock by the cut's quiet and one snapshot. No frame is taken when the one kept is already as new as the page (the page has said stale at no point in this hidden period; one said at all means later moves went unsaid) or under critical memory pressure; the card sleeps at once. A missed snapshot goes to the back of the queue for one more try, and a card waiting to sleep waits out that retry. The app-test is `tests/app-test/at0864-dormant-card-last-frame.test.ts`.

**[B07] A judge defines done, and the host logs each picture's dwell.** A new app-test: a stub session moves `activity` in a parked workspace, the test cuts back and samples window frames, and no frame may show a skeleton for that card. The host logs a line when a picture comes down, with its kind and how long it stood, so the next report can be read from the log ([F06], [F10]).

*2026-11-21, at the judge's landing:* the judge is `tests/app-test/at0863-stale-card-cut-picture.test.ts`. It declares `@covers` for `tugapp/Sources/BodyStages.swift` and `tugdeck/src/body/body-staleness.ts` only: `tugapp/Sources/BodyViewController.swift` is a hub at its recorded fan-out of 30 families and the covers lint refuses a rise, so a change to that file alone names the judge by hand. The dwell line is `picture down card=… kind=… ms=…`, written when a picture that stood on screen is taken down or its card stops being shown.

---

## Open Questions {#open-questions}

- **Does the last-frame-to-live swap read as a hop ([F10])?** It is a judgement of the eye on the user's own deck, made on the first build with [B03]. [B04] is the answer for short absences; for long ones the swap is what is left, and whether it needs more is decided then.

---

## Non-goals {#non-goals}

- **Holding the cut until arriving pages have painted.** It would arrive live, but the cut would wait on web processes, which is the design the stages brief replaced ([B01], [B12] there).
- **Retaking a hidden card's frame whenever it goes stale.** That is the background retake loop the stages brief removed ([F07], [F08] there), and a running session is behind again a moment later.
- **Dropping `activity` from the staleness signature alone.** The page would be judged current and shown live with a layer that is behind ([F07]); the fix would rest on an accident rather than a rule.
- **Cold pages after an eviction or a relaunch.** A page with nothing painted has only a skeleton to show; that is not this flash.
- **Changing the dormancy clock.** Five minutes stays; [B05] covers what lies past it.

---

## Exit {#exit}

**An arc.** The raw material for its steps, in the order they must land:

1. The judge of [B07], red on today's tree, and the dwell log line.
2. `bodyStale` carrying its moved parts and the host's two classes ([B02]).
3. The policy change and the kept frame ([B03]), with the old fallback's tests changed in the open and `briefs/workspace-stages-brief.md` amended.
4. The dormancy frame and the one retry ([B05], [B06]).
5. The `at0815` reading with parked pages painting, then [B04] if it passes.
