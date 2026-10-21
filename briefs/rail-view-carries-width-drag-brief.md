# The host carries a rail's width drag in a rail-level view

**Purpose:** Dragging a sidebar rail's edge is broken under per-card web views: the members lag the hand and do not move together. The host should own one view per shown rail, hold the members inside it, and carry the edge drag from the pointer the way it already carries a card.

---

## Purpose {#purpose}

The user's report: "Dragging a sidebar rail is broken. Feels like we need to make each of the sidebar rails a subview of a rail-level outer view so this outer view can take on the dragging and all the sidebar cards themselves drag all at once because they're contained."

The drag in question is the rail's deck-facing edge drag, the one width change a rail makes (`tugdeck/src/components/chrome/rail-width-draft.ts`, pinned by `at0677`–`at0680`). Since every card became its own web view ([D214], [D216]), the rail's members are host views placed from the shell's stand-ins, and the edge drag is the one card gesture the host does not carry.

---

## Evidence {#evidence}

**[F01] The host does not carry a rail edge drag; the shell's draft does, by a round trip.** The gesture tracker's `carriesView` is false for the `rail` kind (`tugapp/Sources/BodyViewController.swift`, `Gesture.carriesView`): each pointer step is only reported to the shell's page. The shell's draft then writes px pins and translates on the stand-ins inside a rAF, the placer wakes on those style writes and re-measures every stand-in on the far side of the next paint (`watchArrangementWrites`, `tugdeck/src/lib/card-placement.ts`), posts `placeCards`, and the host sets each member's container frame. Two host↔page hops, a rAF and a paint stand between the pointer and the first view moving. A move or resize of one card pays none of this: the host steps the tracker and moves the container in the same event (`track`, `move`). **(verified, read out of the code)**

**[F02] A width drag is a resize of every member, not a move.** On a left rail the members' left edges stay and their right edges follow the hand; on a right rail the left edges follow and the widths change. Either way each member's WKWebView is resized per placement, and each page repaints at its new size asynchronously in its own process. The content cards beside the rail only translate. **(verified, read out of `rail-width-draft.ts` and the placement path)**

**[F03] The shell already distinguishes members that cannot reflow per frame.** A registration's `railReflow: "pause"` (the Overview, `overview-card-registration.tsx`) is stamped on the stand-in as `data-rail-reflow`; the draft holds that member at its last laid-out width, anchored to the rail's outer edge and clipped by its frame, and reflows it once the hand has rested `RAIL_REFLOW_PAUSE_MS` (80 ms, `tugdeck/src/lib/rail-width.ts`). Under per-card views the body's content is in another page, so the shell's hold can only clip the stand-in; the web view itself is sized by the placement. **(verified, read out of the code)**

**[F04] The host already ports the deck's clamp and snap for the gestures it carries.** `CardGeometry.swift` ports `computeSnap`, `computeResizeSnap`, `clampedPosition` and `resizeDelta` so a host-carried card lands where a shell-carried one would. The rail width's own bounds and diminishing returns (`railWidthLimits`, `aimRailWidth`, `tugdeck/src/lib/rail-width.ts`) are not ported. **(verified)**

**[F05] The lag and the members' disagreement were not frame-recorded in this conversation.** The diagnosis is read from the path in [F01] and [F02], not from a composite. The reading that would confirm it is `at0678-rail-width-drag-frames` with a composite read by colour of member edges against the pointer, since a DOM rect cannot see a web view lagging its chrome (`briefs/body-view-grounding-brief.md` [F14]). **(inference, not measured)**

---

## Decisions {#decisions}

**[B01] The host owns one rail view per shown rail, and the members' containers are its subviews.** The shell names each card's rail membership in `placeCards`: the side, the member's order on it, and its reflow policy. From that the host builds a `RailView` per shown rail inside the host view, reparents the members' containers into it, and lays the rail view's frame as the union of its members' views. A card lifted out of a rail by a drag is reparented back to the host view at the press, as a press already takes a card out of its beats. Stacking keeps the deck's order: a rail's members are stacked among themselves inside the rail view and the rail view is ordered among the other containers by `sortContainers`. This is the user's shape: the container is what makes the members one thing to move and one thing to clip.

**[B02] The host carries the rail edge drag directly from the pointer, as it carries a move or resize.** The `rail` kind becomes a carried gesture. Each `track` step sets the rail view's frame from the pointer in the same CATransaction, with the width's floor, slim ceiling and diminishing returns ported to Swift beside the clamps already there ([F04]), and the members laid out inside it anchored to the rail's outer edge: a left rail grows at its right edge, a right rail at its left. The content cards beside the rail translate by the same delta in that transaction, so the whole deck moves in one frame set and nothing waits on the shell. The release reports the final width to the shell as the gesture's end does today, and the shell commits `setRailWidth` for every member. Cancel puts the rail view and the translated containers back to their frames at the press.

**[B03] The pause hold lives in the host.** A member whose policy is `pause` keeps its web view at the width it last laid out at, anchored to the rail's outer edge and clipped by the rail view, while the hand moves; once the hand has rested `RAIL_REFLOW_PAUSE_MS` the host resizes it to the standing width, one reflow while nothing else moves, and the release lets it go with the rest. A member whose policy is `live` is resized every step. This is [F03]'s rule moved to the party that now sizes the view. It is also the one real limit of per-card views: a page repaints at a new size asynchronously, so a live member can still show a stale frame, and the hold is the mitigation rather than the container.

**[B04] The shell's draft keeps running the shell's own geometry, and the placer posts nothing for what the host holds.** The stand-ins, the split rail's seams, the shadow strip and the drop bands still follow the hand in the shell, so the shell's chrome and the host's views agree at every rest. During the gesture the placer skips the rail's members and the translated content cards, as it skips a card in the host's hand today, and the host ignores a placement for them until the gesture ends. The release's commit posts the landing placement, which the host adopts since the views already stand there, so the release moves nothing ([B08] of the draft's doctrine still holds).

**[B05] The verdict is read by colour, in the host.** The width-drag frame test and the commit-and-cancel test are re-pointed at the host-carried gesture: the frame cost bar stays, and a composite reads each member's edge and the chain's first card against the pointer's position, admitting the two display frames of pipeline latency [F14] of the grounding brief measured. A DOM-rect assertion in the shell proves nothing about where the web views stand.

---

## Open Questions {#open-questions}

- **Whether the Overview's hold should clip or scale.** Clipping at the rail's edge is what the shell does today; a host could instead scale the held view's layer to the moving width for the drag's length. Clipping is the decision unless the composite shows a bare strip at the growing edge that reads worse than stretched content. A design spike on the real binary would settle it, if the clip reads badly.

---

## Non-goals {#non-goals}

- **Translating the outer view as the drag.** A width drag changes the members' widths, so a container the host only translates still leaves every member to be resized, and on a left rail there is nothing to translate. The container is for layout and clipping ([B01]), not a drag handle.
- **Holding the whole rail still until the release.** Considered as a cheaper first cut, applying the pause hold to every member. Rejected for the full shape: a live member's chrome should follow the hand, and the hold is per policy ([B03]).
- **Per-frame `placeCards` during the drag.** Posting the placement every frame instead of after the paint would shorten the round trip but keep it, and would make the placer the per-frame follower [B06] of the placement doctrine forbids.
- **The rail's seams and the card-within-rail drag.** A sash drag between two members and a member dragged out of or across a rail are separate gestures with their own tests (`at0543`, `at0538`, `at0549`) and are not changed here beyond reparenting at the press ([B01]).

---

## Exit {#exit}

An arc. The order the work wants:

1. The placement names rail membership and reflow policy, and the host builds the rail views and reparents the members, with no change to the drag. The deck must look and stack the same, and the body placement, settle and drop tests stay green.
2. The host carries the `rail` gesture: the ported width bounds, the rail view's frame from the pointer, the members anchored to the outer edge, the chain translated, cancel restored. The shell's draft stops posting for what the host holds and the release lands by the commit.
3. The pause hold in the host, with the rest interval.
4. The verdict: `at0677`–`at0680` re-pointed at the host-carried gesture and the composite reading of [B05].
