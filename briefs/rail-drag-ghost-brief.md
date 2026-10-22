# The rail width drag as a ghost: nothing moves until the release

**Purpose:** Holding every rail member's page still through a width drag ([B03] of `briefs/rail-drag-in-live-resize-brief.md`) gives lock step, but a grow shows a blank strip of surface between the content and the moving edge, and the user finds it ridiculous and wrong. The drag should show *where the rail will stand* — a translucent ghost of its new footprint with the accent edge, and the readout — and move nothing until the release, which lands the width through the settle the deck already runs.

---

## Purpose {#purpose}

The user, after testing `56e03e48c` in a debug build: "I don't like the visual effect of utterly refusing to resize the content during the drag. The blank background in this case looks *ridiculous* and wrong. We need a different option. Either the drag is just a *ghost* or outline of the new dimension, or we run resizing the window content on a heartbeat/timer while the drag is active."

Settled in conversation: **the ghost**, as a translucent fill of the rail's new footprint with the accent edge, and the cards — the members and the content cards beside the rail — stay put while the drag is active.

---

## Evidence {#evidence}

**[F01] A page's new width is realised on its web process's clock, and nothing host-side changes that.** Established across two arcs: resizing member pages per frame put them out of step with each other and the hand (`1e62251d5`); AppKit's live-resize protocol, through the view door and the window door, did not engage WebKit's synchronized commit for a view inside a still window (`rail-drag-in-live-resize-brief.md`, the [B02] reading: the host's write never waited, no run near the bar). The only things in step with the hand are layers the host owns. **(verified, measured in both arcs)**

**[F02] A heartbeat resize is [F01] on a timer.** Each tick asks three processes to repaint at a new width; each lands on its own clock, so at every tick the members fall out of step for a frame or two and catch up, and between ticks the content is either clipped or has the strip. A tick slow enough for every page to settle first trails the hand by ~100 ms. It makes the strip rarer and adds a stutter cadence; it removes nothing. **(inference from [F01]; not measured, and the ghost makes measuring it unnecessary)**

**[F03] The deck already lands a rail width change through a settle whose beats hide the repaint.** `setRailWidth` commits the width; the imposer's settle plans each moved card's beats and the host runs them (`runPlan`) as Core Animation on the container's layer, with the page pinned at its landing size and clipped by the track as it moves (`crossingReady`, `endCrossing` in `tugapp/Sources/BodyViewController.swift`). A rail toggle and a jot opening carry rail members this way today (`at0501`, `at0676`). The rail drag's release is the one moment anything changes under the ghost, and it is the moment this machinery was built for. **(verified, read out of the code)**

**[F04] What `56e03e48c` landed that the ghost keeps, and what it does not.** Keeps: the `RailView` per shown rail with members laid out inside it; the host's rail arithmetic (`RailWidthTracker`: limits, give, Option snap) and the aim on every report; the shell previewing at the host's aim; `PlaceCardsGate` holding the moving cards out of `placeCards`; the readout in the overlay (`overlay.indication.readout`); `onRailEdge`, by which each member's page tells the host its surface, edge colours and width, and the gutter shadow; `RailEdgeView`, which draws an edge in those colours; the display-link spring on the shell's curve (`CardGeometry.cubicBezier`). Does not keep: the per-frame rail-view frame write and its `resizeSubviews` carry, `RailCrossing` and the page pin at press size, the page mask at the deck-facing edge, the surface strip, `onRailLand` and the hold-until-painted deadline, and the shell draft's per-frame preview of pins, seams, shadow and carried translates, since under the ghost the shell's stand-ins stand still too. **(verified, read out of `56e03e48c`)**

**[F05] The draft's "release moves nothing" doctrine was written for a drag that previewed.** `rail-width-draft.ts`'s docblock and the settle's `data-pointer-owned` skip exist so a previewed drag's commit measures the members already standing where it lands. Under the ghost the members have not moved when the commit runs, so the settle *must* carry them, and the mark must come off before the commit for that to happen. **(verified, read out of the code)**

---

## Decisions {#decisions}

**[B01] During the drag, nothing on the deck moves: not a member, not its page, not the content cards beside the rail, not the shell's stand-ins.** The hand moves one thing, the ghost ([B02]). This is the user's call, made over the heartbeat ([F02]): a drag that moves nothing is in lock step because there is nothing to fall out of step, and nothing mid-drag is half-done. The cost accepted with it is that the content's wrap at the new width is not previewed; the ghost promises a footprint, not a layout.

**[B02] The ghost is a host-drawn layer: a translucent fill of the rail's new footprint with the accent edge on its deck-facing side.** The rail view owns it, above its members, and the gesture writes its frame per step from the aim — the rail's outer edge fixed, the deck-facing edge at the shown width, the full height of the rail's members' union. The fill is the accent at a low alpha and the edge is the border in the held colour, or the limit colour past a limit, as `RailEdgeView` draws it today; the page's `onRailEdge` answer grows the fill colour so the ghost is theme-correct. A host layer is in step with the hand by construction ([F01]); the overlay page would be one shell frame behind, and the one thing the ghost is for is being exactly where the hand is. The readout rides the overlay beside the pointer as now.

**[B03] The release commits the width, and the settle carries every card.** At the release the ghost goes, `data-pointer-owned` comes off the members ([F05]), the placer's hold is released, and `setRailWidth` commits; the imposer's settle plans the members' and the chain cards' beats and the host runs them with the crossing's pin and clip ([F03]), so each page's one repaint at its new width is hidden under the track rather than shown on its own clock. The release is the one motion of the gesture, and it is the deck's own settle motion, not a second animation written for the drag. A press that never travelled commits nothing and removes the ghost.

**[B04] A release past a limit springs the ghost, then commits.** The host's display-link spring steps the ghost's edge from the give back to the limit on the shell's curve, and the commit runs when it lands, with the readout reading the limit. The members do not move until then. Cancel — Escape, a lost window, a member removed — removes the ghost and commits nothing; there is nothing to restore.

**[B05] The shell's draft becomes latch, readout and commit.** It keeps opening at the first travelled report, marking the members held, driving the readout from the aim, and committing at the release; it writes no pins, no seams, no shadow and no carried translates while the hand is down, and `RAIL_REFLOW_PAUSE_MS`, the pause policy and `card.railHold` stay gone. The placer's hold stays, since the gesture's reports still arrive and nothing should post mid-drag.

**[B06] The verdict: every frame with the hand down shows the ghost where the host drew it and no card moved; the release lands by the settle.** `at0678` reads a composite burst by colour: each member's deck-facing edge stands at its press position within 1 device px on every frame with the hand down; the ghost's edge stands at the host's reported shown edge within 1 device px; the first chain card does not move. After the release, the settle lands every member and the chain card at the committed width and the host snapshot shows every page at that width. `at0679-rail-width-drag-pin` is deleted: there is no pin. `at0680` reads the readout in the overlay and the spring on the ghost's edge. And the debug build goes in the user's hand before the join, as the supplement requires of a body change.

---

## Open Questions {#open-questions}

None that the code cannot answer. The ghost's alpha and whether its fill carries the rail's rounded corners are reads off the debug build in the user's hand ([B06]), not decisions to make in prose.

---

## Non-goals {#non-goals}

- **The heartbeat.** [F02]. Considered and rejected by the user in favour of the ghost.
- **Ghosting the content cards beside the rail.** Settled with the user: the chain cards stay put and show no hint of their new edge; a second ghost clutters the deck for a card whose travel is a consequence, not a choice.
- **A live-reflowing preview of any kind, per frame or at a rest.** [F01]. Every form of it has been tried.
- **A snapshot of each member stretched to the new width.** Rejected in the previous brief; the ghost supersedes the reason it was tempting.
- **An edge-line-only ghost.** The user chose the fill: at 120 px of travel a lone line reads as a guide, not a size.
- **The seam drag between members and the member-out-of-rail drag.** Unchanged.

---

## Exit {#exit}

An arc. The order the work wants:

1. Unwind the crossing from `56e03e48c` ([F04]): the page pin, mask, strip, `onRailLand`, the rail view's per-step frame write, and the draft's per-frame preview; keep the rail view, the aim, the placer hold, the readout, `onRailEdge` and `RailEdgeView`.
2. The ghost ([B02]): `RailEdgeView` becomes the ghost layer the rail view owns above its members, filled and edged from the page's colours, placed per step from the aim; the spring steps it ([B04]); cancel removes it.
3. The release through the settle ([B03], [B05]): the mark off before the commit, the hold released, the settle carrying members and chain cards with the crossing's pin and clip.
4. The verdict ([B06]): `at0678` re-pointed, `at0679-pin` deleted, `at0680` re-read, then the debug build in the user's hand before the join.
