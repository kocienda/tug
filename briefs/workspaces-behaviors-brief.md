<!-- brief-skeleton v1 -->

# Workspaces behaviors: the press, the mark, and the card that went blank

**Purpose:** Three things are wrong with the workspaces surface `workspaces-refine` landed as `f5c8d7d54`. A press on an inactive workspace switches to it before the pointer moves, so nothing in a parked workspace can be dragged. The active workspace is marked with a dot, which the house reserves for activity. And a card moved into a workspace that is not on screen comes up with no visible content, and nothing the user does brings it back.

---

## Purpose {#purpose}

The user, testing the landed feature in the Release app:

> When I interact with the Workspaces card, it processes my mouse interactions *on mouse down*. This prevents any possibility of dragging the cards from one workspace to another workspace that isn't active already.
>
> The active workspace isn't indicated in a sufficiently-visible manner. You've given me more dots, where the pulsing-dots design concept is meant to be used for activity, not selection.
>
> Changing a card to a different workspace made its content *disappear*! [...] Nothing I could do would bring back the content in the card I had. I had to close that session, which unbound the arc, then open a new session card and rebind. As soon as I did that and then moved that card to another workspace (which wasn't visible), the content disappeared again, and I could never bring it back.

The third is the serious one: it lost the user an arc-bound session twice in a row. All three need fixing.

---

## Evidence {#evidence}

**[F01] Selection and activation commit at pointerdown in `TugListView`, and the Workspaces card maps both to a workspace switch** — `tug-list-view.tsx`'s cell `pointerDownCb` commits the row's selection on the press and, for a plain pick, calls `delegate.onSelect(index)` right there. The Cards card's delegate (`cards-card.tsx`, the `activate` closure) dispatches `activate-space` for a workspace header and `focus-session-card` for a card row, and `focus-session-card` (`action-dispatch.ts`) calls `activateSpace` when the card lives in a parked workspace. So any press on a parked workspace's header or row switches workspaces on mousedown. **(verified, read out of the code)**

**[F02] The list only defers selection to the click when the press was claimed by a carry, and a parked workspace's rows arm no carry** — `pointerDownCb` checks `e.defaultPrevented`: a `useBlockReorder` arm cancels the pointerdown, so selection waits for the click that only arrives if the gesture stayed a click. The pane row cell passes `onPointerDown` only when `spaceActive` is true, and `onRowPointerDown` refuses a row whose `spaceId` is not the active workspace a second time, citing `[P09]`'s "read-only view". The active workspace's rows and every workspace header do arm, which is why those defer correctly. **(verified)**

**[F03] The active mark is a text glyph** — `cards-space-header.tsx` renders `●` for the active workspace and `○` for the rest inside `.cards-header-glyph`, toned accent and subtle by `cards-card.css`. `tuglaws/entity-presentation.md` states the house rule: a session's dot carries a phase and pulses; a dot is an activity mark. The Window menu marks the same fact with a checkmark (`rebuildWindowSpaceList` in `AppDelegate.swift` sets `item.state = space.active ? .on : .off`). **(verified)**

**[F04] The blank card's whole DOM is present and laid out; its body computes to opacity 0** — inspected live on the user's Release instance through tugcast's loopback `/api/eval` (the `diag/eval` opt-in was set for the inspection and revoked afterwards). With the card's workspace shown, the pane measured 675×1176, the body 673×1085, the transcript's scroll height 12244, every tool block a non-zero height, the composer 46px tall, and `.session-card` computed `opacity: 0` from an inline `style="...; opacity: 0;"`. No animation was attached to the element. The healthy session card beside it had no inline opacity and computed 1. **(verified, measured)**

**[F05] The inline opacity is written by `SessionCardBody`'s first-mount fade, and the fade's completion cannot land on an element with no box** — `session-card.tsx` (the "First-mount fade-in" effect) sets `el.style.opacity = "0"` synchronously and opens a `TugAnimator` group animating opacity 0 → 1, relying on the group's `commitStyles()` to write the final value. `tug-animator.ts` wraps `commitStyles()` in a `try { } catch { /* target detached; nothing to commit */ }` and then cancels the animation. `commitStyles()` throws `InvalidStateError` for an element that is not being rendered, and a card mounted into a hidden workspace layer sits under `.tug-space-layer { display: none }` (`space-layer.css`). So the animation finishes, the commit throws, the swallow cancels the animation, and the hand-written `opacity: 0` is the element's state from then on. Nothing later touches it: switching workspaces changes the layer's `display`, and no code re-runs the fade. The effect skips itself only when the store is replaying or cold-restoring, which is why a card in the middle of a restore is spared and a live one is not. **(verified: the writer read out of the code; the resulting state measured live; clearing the inline opacity restored the user's card on the spot)**

**[F06] The same class has a milder sibling in the composer** — the live card's editor carried `--tugx-editor-line-box: 14px` where the healthy card's carried `30px`. `line-box-metric.ts` publishes the measurement from CodeMirror's measure cycle and, by design, re-measures only on a reconfigure or a document change, never on a geometry change. A composer that first measures inside a hidden layer settles on the estimate and keeps it until the user types. **(verified, measured live)**

**[F07] The harness did not reproduce the blank** — seven throwaway app-test probes moved a session card through the store method, the real spine menu, and the user's own layout blob, into parked, visited-and-hidden, one-up and two-up destinations, with a resumed fixture and with a `new`-mode synthetic binding, then switched there and measured. Every one came back with the body visible and the tool blocks, entries and composer at real heights. The mechanism in `[F05]` depends on a WAAPI animation finishing while the target has no box; the probes did not assert the inline opacity directly, and the difference between the harness's motion environment and the user's was not pinned down. A reproducing test must assert the inline `opacity` on `.session-card` after a hidden mount and a switch, not the layout. **(verified that it did not reproduce; the reason is inference)**

**[F08] The tool-block header heights recover on their own** — the hidden card carried `--tugx-block-header-height: 0px` on all 78 of its tool blocks while hidden, and every one read a real height once shown, because `block-chrome.tsx` measures through a `ResizeObserver` rather than once. Measurements that observe survive a hidden mount; measurements that run once do not. **(verified, measured live)**

**[F09] The audit had named this class and left it** — the `workspaces-refine` audit report flagged that card content first-mounting into a hidden layer measures with no boxes and that only `TugPane`'s own measurements were armed on the shown transition, and deferred it as belonging with the eviction-policy question `[Q01]`. It was the right call for the audit's scope and the wrong prediction of consequence. **(verified, from the arc's own record)**

---

## Decisions {#decisions}

**[B01] Every card row arms a carry, whichever workspace it lives in.** The arm is what makes the list defer selection to the click, so this one change is also what moves the switch from mousedown to a completed click: a press that travels becomes a drag and selects nothing, and a press that stays a click switches exactly as it does today. The pane row cell passes its pointerdown handler for every row, and `onRowPointerDown` stops refusing parked rows. The in-workspace reorder for a parked workspace is safe to allow with it, because `getVisibleOrder` is already scoped to one group in one workspace, so a committed order can never span two. `[P09]`'s "read-only view" is retired as a rule about the carry; the parked rows' quieter tone stays, as a reading of where the user is rather than a refusal.

**[B02] The workspace switch is a click, at both doors.** A header press already arms and therefore already defers; `[B01]` gives rows the same. No timer, no drag threshold of the list's own, no second mechanism: the deferral the list already has for a claimed press is the whole design.

**[B03] The active workspace is marked with a check, not a dot, and the name carries the accent.** A check is the mark the Window menu already uses for the same fact, so one fact has one mark at both doors, and it is not a glyph the house associates with a phase. The active header's name takes the accent tone so the row still reads at a glance without the glyph column; parked headers show nothing in that column rather than a hollow ring. The glyph column keeps its width so names do not shift when the mark moves.

**[B04] A card's entrance never leaves the element's state in the animation's hands.** The fade in `SessionCardBody` writes the start state by hand and depends on `commitStyles()` for the end state, and `[F05]` is what that dependency costs. The fix is in the caller, not the animator: the fade's completion writes the end state itself (clears the inline opacity) whether or not `commitStyles()` succeeded, and the fade does not run at all when the card's layer is not shown, read through `useSpaceLayerShown()`, because there is no picker exit to share a beat with in a workspace nobody is looking at. The animator's swallow stays as it is; it is correct for the detached-element case it was written for, and a caller that hand-writes a start state owns the end state.

**[B05] One-shot measurements taken by card content arm on the shown transition, or observe.** `[F08]` shows the observing measurements survive a hidden mount and `[F06]` shows a one-shot one does not. The composer's line-box metric re-measures when its layer becomes shown, the same transition `TugPane`'s own measurements already key on (`851756ed4`). The arc audits `tugdeck/src/components/tugways/` for other mount-time reads that write a CSS variable or an inline style once, and treats each the same way: observe, or re-arm on show.

**[B06] The reproduction lives in the harness before the fix does.** The test for `[F05]` moves a live session card into a visited, hidden workspace, switches there, and asserts the inline `opacity` on `.session-card` is not `"0"` and the computed opacity is `1`, alongside the transcript and composer heights. It runs with motion enabled if that is what it takes to see the animation finish under `display: none`; a test that passes only because the fade never played proves nothing. `at0580` grows the same assertion on its existing legs.

**[B07] The `[P09]` and `[B04]`-of-`workspaces-refine` doctrine lines are rewritten, not deleted.** The move still does not follow the card. What changes is that a parked workspace's rows are draggable and reorderable, and the comment in `cards-card.tsx` and the dimming rule in `cards-card.css` say so.

---

## Non-goals {#non-goals}

- **A wash over the active workspace's block as the mark.** Rejected on `[D122]`'s own record: an area mark tints every row it covers, and the block already needs its wash for the drop target.
- **The list's selection fill on the active header.** The layout selection already uses that fill on card rows; a header that is permanently "selected" would read as part of the selection and confuse the slot and width verbs that act on it.
- **Changing `tug-animator`'s `commitStyles()` swallow.** It is right for a detached element. The defect is a caller that hand-writes a state and then trusts the animation to undo it.
- **Unmounting cards in hidden workspaces to avoid the class.** `[B06]` of `workspaces-refine` keeps visited workspaces mounted so a switch costs a style recalculation, and that decision stands. The class is content that measures once at mount; the answer is in the content, not in giving up the mount.
- **An eviction or memory policy for mounted workspaces.** Still `[Q01]` of `workspaces-refine`, still deferred.

---

## Exit {#exit}

**An arc.** The first steps, in the order they should land:

1. The reproducing app-test for `[F05]`, red first: a live session card moved into a visited, hidden workspace, then shown, asserting the body's inline and computed opacity and the composer's line-box metric.
2. `SessionCardBody`'s fade per `[B04]`: skip when the layer is not shown, and write the end state on completion regardless of the commit.
3. The composer's line-box metric re-armed on the shown transition per `[B05]`, then the sweep of `tugways/` for other one-shot mount measurements.
4. Every card row arms a carry per `[B01]`; the switch becomes a click as a consequence; `[P09]`'s wording and the dimming rule per `[B07]`. `at0580` and `at0587` grow legs that press a parked row, move a few pixels, and assert no switch happened.
5. The check mark per `[B03]`, with `at0585`'s header assertions updated.

Step 1 before step 2 is the one ordering that matters. The rest are independent.
