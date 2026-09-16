<!-- brief-skeleton v1 -->

# Workspaces card: the press that switches too early, and the mark that is a dot

**Purpose:** In the Workspaces card, a press on an inactive workspace's row or header switches to that workspace before the pointer has moved, so nothing in a parked workspace can be dragged. And the active workspace is marked with a dot, which the house reserves for activity, not selection.

---

## Purpose {#purpose}

The user, testing the surface `workspaces-refine` landed as `f5c8d7d54`:

> When I interact with the Workspaces card, it processes my mouse interactions *on mouse down*. This prevents any possibility of dragging the cards from one workspace to another workspace that isn't active already.
>
> The active workspace isn't indicated in a sufficiently-visible manner. You've given me more dots, where the pulsing-dots design concept is meant to be used for activity, not selection.

The two are separable from the content-visibility defect reported in the same breath, which has its own brief (`workspaces-content-visibility-brief.md`) and its own reckoning. This one is the Workspaces card's own behaviour and look.

---

## Evidence {#evidence}

**[F01] Selection and activation commit at pointerdown in `TugListView`, and the Workspaces card maps both to a workspace switch** — `tug-list-view.tsx`'s cell `pointerDownCb` commits the row's selection on the press and, for a plain pick, calls `delegate.onSelect(index)` right there. The Cards card's delegate (`cards-card.tsx`, the `activate` closure) dispatches `activate-space` for a workspace header and `focus-session-card` for a card row, and `focus-session-card` (`action-dispatch.ts`) calls `activateSpace` when the card lives in a parked workspace. So any press on a parked workspace's header or row switches workspaces on mousedown. **(verified, read out of the code)**

**[F02] The list defers selection to the click only when the press was claimed by a carry, and a parked workspace's rows arm no carry** — `pointerDownCb` checks `e.defaultPrevented`: a `useBlockReorder` arm cancels the pointerdown, so selection waits for the click, which only arrives if the gesture stayed a click; a drag swallows its own trailing click. The pane row cell passes `onPointerDown` only when `spaceActive` is true, and `onRowPointerDown` refuses a row whose `spaceId` is not the active workspace a second time, citing `[P09]`'s "read-only view". The active workspace's rows and every workspace header do arm, which is why those defer correctly today. **(verified)**

**[F03] Dragging from the active workspace into a parked one already works** — `at0580`'s drag leg carries a row from the active workspace onto another workspace's header with real pointer events and asserts the move. The gap is one-directional: out of a parked workspace, nothing can start. **(verified, by the existing test)**

**[F04] The active mark is a text glyph** — `cards-space-header.tsx` renders `●` for the active workspace and `○` for the rest inside `.cards-header-glyph`, toned accent and subtle by `cards-card.css`. `tuglaws/entity-presentation.md` states the house rule: a session's dot carries a phase and pulses; a dot is an activity mark. The Window menu marks the same fact with a checkmark (`rebuildWindowSpaceList` in `AppDelegate.swift` sets `item.state = space.active ? .on : .off`). **(verified)**

---

## Decisions {#decisions}

**[B01] Every card row arms a carry, whichever workspace it lives in.** The arm is what makes the list defer selection to the click, so this one change is also what moves the switch from mousedown to a completed click: a press that travels becomes a drag and selects nothing, and a press that stays a click switches exactly as it does today. The pane row cell passes its pointerdown handler for every row, and `onRowPointerDown` stops refusing parked rows. The in-workspace reorder for a parked workspace is safe to allow with it, because `getVisibleOrder` is already scoped to one group in one workspace, so a committed order can never span two. `[P09]`'s "read-only view" is retired as a rule about the carry; the parked rows' quieter tone stays, as a reading of where the user is rather than a refusal.

**[B02] The workspace switch is a click, at both doors.** A header press already arms and therefore already defers; `[B01]` gives rows the same. No timer, no drag threshold of the list's own, no second mechanism: the deferral the list already has for a claimed press is the whole design.

**[B03] The active workspace is marked with a check, not a dot, and the name carries the accent.** A check is the mark the Window menu already uses for the same fact, so one fact has one mark at both doors, and it is not a glyph the house associates with a phase. The active header's name takes the accent tone so the row still reads at a glance without the glyph column; parked headers show nothing in that column rather than a hollow ring. The glyph column keeps its width so names do not shift when the mark moves.

**[B04] The `[P09]` doctrine lines are rewritten, not deleted.** The move still does not follow the card (`workspaces-refine` `[B04]`). What changes is that a parked workspace's rows are draggable and reorderable, and the comment in `cards-card.tsx` and the dimming rule in `cards-card.css` say so.

---

## Non-goals {#non-goals}

- **A wash over the active workspace's block as the mark.** Rejected on `[D122]`'s own record: an area mark tints every row it covers, and the block already needs its wash for the drop target.
- **The list's selection fill on the active header.** The layout selection already uses that fill on card rows; a header that is permanently "selected" would read as part of the selection and confuse the slot and width verbs that act on it.
- **Anything about what a card looks like after it arrives in another workspace.** That is the content-visibility brief's ground.

---

## Exit {#exit}

**An arc.** Two independent pieces:

1. Every card row arms a carry per `[B01]`; the switch becomes a click as a consequence; `[P09]`'s wording and the dimming rule per `[B04]`. `at0580` and `at0587` grow legs that press a parked row, travel a few pixels, and assert no switch happened, and one that drags a parked row onto the active workspace's block and asserts the move.
2. The check mark per `[B03]`, with `at0585`'s header assertions updated.
