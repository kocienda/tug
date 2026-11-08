<!-- brief-skeleton v1 -->

# Workspace switch latency: warm the parked bodies, and show a bounded sheet over a cold cut

**Purpose:** The flash fixes made a workspace switch quiet by holding what it shows until every page has painted. The hold is now the thing the user feels: a switch that is one cut in the shell waits up to two seconds for its bodies, and nearly every first visit of the day is cold. The user wants the switch immediate, the wait honest and short, and the cold case rare.

---

## Purpose {#purpose}

The user, 2026-11-08:

> We've done some work recently to improve the presentation of workspaces and how we handle switching them. On the good side, we no longer have nearly the flashes we used to. However, this has come at a cost of far too many delays and way too much latency.

The idea as first put: save the complete card structure of each workspace so a skeletonized workspace can be restored immediately on a switch, with an app-modal sheet standing while the skeleton becomes the real cards. The sketch that followed found the skeleton already exists and the latency lives elsewhere, and the user settled the three points it left open: parked workspaces are to be warmed again, the sheet is to be modal over the arriving canvas rather than the window, and it says only that the workspace is being restored, with a barber pole.

---

## Evidence {#evidence}

**[F01] The card structure of every workspace is already persisted, and a parked workspace is already mounted.** `putLayout` in `tugdeck/src/layout-persistence.ts` writes every space's panes and cards to tugbank on a 500 ms debounce, and `loadBootLayout` seeds every space before the first render. Within a run a visited workspace stays mounted and the canvas hides its layer; `activateSpace` in `tugdeck/src/deck-manager.ts` neither captures nor replays (`tuglaws/state-preservation.md` moment 7). A second saved copy of the structure would restore nothing the shell does not already hold. **(verified, read)**

**[F02] The shell's cut is already immediate.** The swap commit measures 4 to 8 ms on every switch read (`space-switch-timing`, `briefs/workspace-switch-cheap-brief.md` [F01]), and the shell's first frame lands within one or two display periods. **(verified, measured in earlier briefs; not re-measured here)**

**[F03] The skeleton the idea asks for is the faces.** On a switch the shell draws a stand-in in each arriving pane and the host stands a face over it inside the one hand-over transaction: the card's last frame where it holds a cover, a titled blank face where it holds none (`briefs/switch-hand-over-brief.md` [B02], [B03]; `tugapp/Sources/BodyFaceHandOver.swift`). The skeletonized workspace is on screen at the cut today. **(verified, read)**

**[F04] The latency is in the bodies, not the shell.** Each card is its own `WKWebView` page. A cold page is made by the lane two at a time (`BodyLane.width = 2`, `tugapp/Sources/BodyLane.swift`), and eight cold pages paint over about 1.45 s on the user's deck; a create's five rail cards over about 1.6 s (`briefs/workspace-switch-finished-picture-brief.md` [F04]). Every page fetches the deck's whole module graph through the one connection pool, which is why width does not change the total. **(verified, log and code, read from the earlier brief)**

**[F05] The set reveal is the hold the user feels.** `BodyRevealSet` in `tugapp/Sources/BodyHandOver.swift` keeps every faced card's paint back until all members have content-painted, then lands them in one transaction, with a 2000 ms horizon from the hand-over. Today's release log (`tugapp.log.2026-11-08`, 22:51) shows `hand-over past its horizon serial=6` and `reveal set past its horizon waiting=4`: a switch that waited the full two seconds and still had four pages unpainted. The hold was chosen to replace a cascade ([B04] of the finished-picture brief); it answered the flash by spending the user's time. **(verified, code and log)**

**[F06] Nearly every first visit is cold, because of the lifecycle and the daily relaunch.** A hidden body goes dormant after five minutes and gives up its process after two hours (`BodyLifecycle.dormantAfter`, `evictAfter`, `tugapp/Sources/BodyLifecycle.swift`). A parked workspace's cards start dormant or evicted and are never warmed: `warmParked` was retired by `briefs/body-lifecycle-program-brief.md` [B05]. The user quits and relaunches most days, so each workspace's first switch each day pays [F04] in full. Today's log shows the pattern: bursts of `dormant=yes` for a whole workspace at 17:46 and 22:59, and `dormant=no` for the same cards on the return. **(verified, code and log)**

**[F07] A cover's snapshot is a cost of its own on a crossing.** `a crossing's cover stands` lines in today's log carry `snapshot_ms` of 58.8, 104.6 and 205.8 for single cards at 1122×3272 and 1122×1644 pixels. Not the subject of this brief, but it is on the switch's path and belongs in the reading. **(verified, log)**

**[F08] What a warm body costs.** A WebContent process is 53 MB at creation, the warm spare 146 to 148 MB, a Session body streaming 205 to 223 MB and 227 to 244 MB after a 500-turn resume (`briefs/body-lifecycle-program-brief.md` [F06]). Warming every parked card is a memory cost of roughly 150 MB per card at rest, before any transcript. The pressure trigger that evicts hidden bodies oldest-first on a memory warning and every hidden body on critical is already in place and is unchanged by anything here. **(verified, read from the earlier brief and `BodyLifecycle.swift`)**

**[F09] The launch's own loading surface is the shape the user trusts.** The restore gate (`TugRestoreGate`) stands over the deck during a cold session restore, reads "Restoring…", and lifts on a bounded horizon; `tuglaws/no-wait-without-a-horizon.md` records it as the one standing exception to the rule against an app-wide modal that waits on the wire, "the honest surface" over a cold restore. The user has said of it: "we have a loading interface that includes progress indication, and that works just fine" (`briefs/workspace-create-flash-brief.md`). **(verified, read)**

**[F10] The law forbids a new app-wide modal that waits on another process.** [L33]'s second clause, as held in `tuglaws/no-wait-without-a-horizon.md`: the restore gate is a recorded exception, not a licence. A sheet over the arriving canvas alone is not app-wide and leaves the sidebar's live cards usable. **(verified, read)**

---

## Decisions {#decisions}

**[B01] Nothing new is saved, and the skeleton is the faces.** The persisted structure [F01] and the hand-over's faces [F03] already give a switch its immediate skeleton. The work is on what happens after the cut, not on restoring the cut faster. What would revisit this: a reading showing the shell's own cut above one frame on the user's deck, which no reading has.

**[B02] Parked workspaces' bodies are warmed again, into the dormant tier, hidden.** This reopens [B05] of `briefs/body-lifecycle-program-brief.md` and the non-goals of the create and finished-picture briefs, on the user's direction: "we must. If the skeletons are sufficiently cheap, there's no real cost to be worried about here." Those rejections were made when the fault was the flash; the fault now is the wait, and [F06] says the common case is the cold one. The shape: after launch, once the shown workspace's pages have painted and the lane is idle, the lane makes pages for every parked workspace's cards, hidden and declared dormant as they paint, in the order the user is likeliest to switch to (most recently shown workspace first, then the Workspaces card's order). The same happens for a workspace evicted by time: it is re-warmed when the lane is next idle, so time eviction stops making a workspace cold for good. Pressure eviction stays exactly as it is [F08]: it is the governor that keeps warming honest, and a machine short of memory gets the cold path. The acceptance is a reading, not an assertion: resident memory at rest with every workspace warm on the user's deck, and the switch's paint time on a workspace that was warmed and never visited this run.

**[B03] The set reveal's hold goes, and a sheet over the arriving canvas takes its place.** The hold in `BodyRevealSet` is removed. On a switch whose arriving bodies have not all content-painted, the shell raises a modal sheet over the arriving workspace's canvas, not the window: the sidebar's cards and the window's chrome stay live, which is what [F10] asks and what the user chose. Pages land behind the sheet as they paint; the sheet drops when the last faced card has content-painted, or at its horizon. Two waits over one load would be the cascade's cousin, so the hold and the sheet are not both kept.

**[B04] A warm switch never shows the sheet.** The sheet is armed at the cut and raised only if the faced set is still unpainted after a grace of roughly 150 ms, a number for the arc to pick from the warm switch's recorded paint times and record. A switch onto warm bodies lands under the grace and shows a cut and nothing else. Without the grace every switch would flash a sheet for a frame, which is the flash the earlier arcs removed.

**[B05] The sheet says "Restoring workspace…" with a barber pole, and nothing more.** No workspace name, no row per card, no count. The user chose this over a per-card account. The barber pole is a live indeterminate indicator, drawn by the shell in CSS so it animates while the host is busy standing pages, and it is subject to the motion doctrine's tripwires like any other running animation. The restore gate [F09] is its model in posture; it is a separate surface, because it waits on the host's paint facts and not on the wire, and because its scope is the canvas and not the deck.

**[B06] The sheet has a horizon and a user exit.** It stands no longer than a bound the arc takes from the lane's recorded cold set times, two seconds today, and past it the faces come down to whatever has painted, with unpainted cards left on their faces as they are today. A click on the sheet dismisses it early to the same state. This is [L33] applied to the one surface the user can see during a switch; a sheet that could outlive the lane's slowest set would be the hold under another name.

**[B07] Lane width widens for a switch burst.** While a switch's faced set has unpainted members, the lane may load more than two pages at once. [F04] says the total is the same at any width and the first pages come sooner at a narrow one; with a sheet standing, what matters is when the last page lands, and the recorded six-at-once total of 4.8 s against two-at-a-time's 5.5 s says a wider burst lands the set sooner. The width is the arc's to pick from a reading on the user's deck. Outside a switch burst the lane's width and the spare's timing are untouched.

**[B08] The body page's module graph is cut down, separately measured.** Every page fetches the deck's whole graph [F04]. A body-only entry that loads what a body needs shortens every cold case, warm or not, and shortens the warming in [B02]. It is in this brief because it is the lever that works when the others cannot (first launch, pressure eviction), and it is separately measured because its payoff is a number the arc should know before spending on it.

**[B09] The reading comes first and the judges fail on today's build.** Before anything changes: a frame and timing recording of a cold switch on the user's deck shape, from gesture to last page painted, and the resident memory at rest with every workspace warm against today's. Then judges in the harness: a switch onto warm bodies shows no sheet and paints within the grace; a cold switch shows the sheet within the grace plus one frame and drops it on the last content paint; the sheet drops at its horizon when a page never paints; the sidebar's cards take a click while the sheet stands. Every new test carries `@covers` and stays under the corpus's 20 s budget.

---

## Open Questions {#open-questions}

- **Whether warming every workspace fits in memory on the user's deck.** [F08] puts it at roughly 150 MB per card at rest; four workspaces of several cards each is on the order of gigabytes. The pressure trigger is the backstop, but a deck that lives at the warning level would evict and re-warm in a loop. Settled by the memory reading in [B09]; if it does not fit, the fallback is warming the most recently shown parked workspace only, which the arc records as a decision if it is taken.

- **What "idle" is for the lane to start warming.** The spare already waits a second after the last bound body's ready. Whether warming should wait for the shown workspace's catch-up brackets to close as well, so it never competes with a streaming session, is a reading the arc takes from `tugcast.log` on the user's deck.

---

## Non-goals {#non-goals}

- **Saving a second copy of the card structure to tugbank.** It is already there [F01], and the shell restores from it immediately [F02].
- **An app-modal sheet over the whole window.** Rejected by [F10] and by the user's choice; it would block the sidebar's live cards for a wait that concerns only the arriving canvas.
- **A per-card account on the sheet.** The user chose the one line and the barber pole over rows or counts.
- **Keeping the set reveal's hold beside the sheet.** Two waits over one load.
- **A progress glyph on a face.** Removed 2026-10-27 (`e6c94ec2b`): a host-drawn face cannot animate, and a still glyph read as stuck. The barber pole lives on the shell's sheet, which can.
- **Changing the dormant or eviction clocks.** Dormancy at five minutes and time eviction at two hours stay; [B02] re-warms after a time eviction rather than preventing it.
- **The cover snapshot's cost [F07].** On the switch's path and worth a reading, but not this work.

---

## Exit {#exit}

An arc. The first act is [B09]'s reading on today's build and the judges written red. Then [B03] and [B04] together, since removing the hold without the sheet would bring the cascade back, with [B05] and [B06] as the sheet's shape. Then [B07], the lane's burst width, read against the sheet's standing time. Then [B02], warming, gated on the memory reading and settling the first open question. [B08] last, measured on its own, because its payoff is the number that decides how much of it to do. Order matters between the sheet and the warming: the sheet is what the user sees on the cold switches that remain, so it has to be right before warming makes them rare and hard to observe.
