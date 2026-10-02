# Rail Width Drag

**Purpose:** Dragging a sidebar rail's edge to resize it gives little to no feedback — only the rail's shadow strip follows the hand — and the handler that does it breaks several tuglaws. The drag should be a deck-owned, cancellable mutation transaction that performs great, with feedback that was designed.

---

## Purpose {#purpose}

The user, resizing a rail on the factory deck: "This now shows *little to no feedback*, and certainly not something that was designed: all I see is the disconnected shadow for the rail. This must be *way* better." And on reading how the drag works — a per-rAF write of a CSS variable from inside `TugPane` — "gives off a ***horrid*** code smell. Is this resize being done in a tuglaws-compliant fashion?"

It is not. The drag is broken for the user, and the reason it broke is structural: the pane writes state another layer owns.

---

## Evidence {#evidence}

**[F01] The drag writes a variable no pane frame reads.** `handleSidebarResizeStart` (`tugdeck/src/components/chrome/tug-pane.tsx:4533`) writes `--tug-sidebar-width-<side>` once per animation frame onto the canvas root found by `paneCanvasOf(frame)` (`tug-pane.tsx:4669`). Since `8a4fd3687` (workspace switch as a cut), `writeArrangementVariables` (`tugdeck/src/components/chrome/deck-canvas.tsx:2068`) also writes that variable — and `--tug-imposer-inset-<side>`, which resolves `var()` against it — onto every `.tug-space-layer` wrapper (`deck-canvas.tsx:2224`), and every pane frame renders inside a wrapper. The frames inherit the wrapper's copy, so the rail, its sibling members and the content cards do not move until pointer-up. Only elements that are direct canvas children follow the hand — chiefly the rail shadow strip (`deck-canvas.tsx:8160-8195`). Read from the code **(verified)**; the visible symptom matches the user's report.

**[F02] Two writers own one property.** `DeckCanvas` writes the arrangement variables in its layout effects; `TugPane` writes the same property from its gesture. When `DeckCanvas` changed where the variable lives, the pane's write went dead with no error. The handler's docblock (`tug-pane.tsx:4542-4552`) still asserts "one property write feeds all three … live", and its pointer-up comment asserts "`DeckCanvas` writes the same number back, so there is no frame where the deck reads the pre-gesture width" — both false now **(verified)**.

**[F03] The commit writes one pane's width; the rail is as wide as its widest member.** Pointer-up calls `onCardMoved` → `DeckManager.movePane` (`tugdeck/src/deck-manager.ts`, `movePane`), which writes `size.width` on the dragged pane only and mirrors it to `sidebarWidthStore`. `sidebarRailsOf` (`deck-canvas.tsx:505-536`) and `_flowBandEdges` (`deck-manager.ts`) take a side's width as the max of its members' `paneRenderWidthOf`. Narrowing a multi-member rail therefore most likely snaps back to the widest sibling on release. Read from the code; **not reproduced** — an app-test narrowing a three-member rail would confirm it.

**[F04] There is no cancel path.** The handler registers only `pointermove` and `pointerup` (`tug-pane.tsx:4715-4716`). No `pointercancel`, no `lostpointercapture`, no Escape. A drag whose capture is lost leaves the listeners attached, `data-gesture` and `data-pointer-owned` set on the frame, the `paneOcclusionGesture` bracket open, and the resize scroll episodes open **(verified)**.

**[F05] The gesture derives its own limits beside the allocator's.** It clamps to the dragged card's `sizePolicy.min.width` and `window.innerWidth − RAIL_MIN_GUTTER_PX` (80). The allocator owns the rail's real bounds: the side's members' floors and the slim ceiling (675) of [D128]/[D136]. A sibling with a larger floor can be dragged under it, and the hand can exceed the ceiling the allocator would never grant **(verified)**.

**[F06] The handle has no designed affordance.** `.tug-pane-resize-e/-w` (`tugdeck/styles/chrome.css:145-153`) is an invisible 8px hit strip with `cursor: ew-resize`: no hover, no active, no limit state **(verified)**.

**[F07] The allocator does not run on a hand drag.** `retuneSidebarAllocation` runs on a Layout-card click, a chain-membership change ([D136]/[D140]) and the settled canvas-resize observer — not on a rail drag's commit **(verified)**. This is correct ([D183]: sashes belong to the hand) and is recorded so the rework does not add it.

**[F08] A lawful model already exists next door.** The vertical seam drag (`PlaceSeam`, `deck-canvas.tsx:1145-1560`) is owned by `DeckCanvas`, pins each member frame's px height directly during the gesture, and publishes fractions only at release **(verified)**. `flow-offset.ts` writes a non-inherited offset onto exactly the frames that read it.

**[F09] No test covers a live rail width drag or a multi-member width commit.** `at0303` drags a left rail to its floor and asserts the end state only; `at0543` covers vertical sashes only. App-test windows that are covered run no animation frames, so live geometry is not observable there without a visible window **(verified)**.

---

## Decisions {#decisions}

**[B01] The rail width drag is an [L08] mutation transaction whose draft is a side's width.** The user can end it with a value never committed (cancel), so the preview is appearance-zone DOM work and only the commit crosses into state. The per-frame rAF loop stays — [L13] names gesture frame loops as exactly what rAF is for. The defect was never the rAF; it is who writes and what is written.

**[B02] `DeckCanvas` is the only writer of the draft; `TugPane` only emits the gesture.** [L10]: `DeckCanvas` maps state to panes and owns the arrangement variables, so it alone knows where they live. `TugPane` translates pointer input into begin / change / commit / cancel for a side and writes no arrangement variable, climbs to no canvas, and clamps nothing. This removes the dual-writer class of [F02] rather than patching the one write.

**[B03] The rollback belongs to the party that wrote the draft.** [L32]'s one-owner clause: whatever `DeckCanvas` pins or translates during the draft, it restores on cancel and supersedes on commit, in code that runs whether or not anything else succeeded.

**[B04] The commit is one side-level operation.** A `DeckManager` operation (working name `setRailWidth(side, px)`) writes every member of the side, mirrors the reopen width for each to `sidebarWidthStore` ([L23]), and notifies once. Per [D128] same-side cards share one width, so the data now says what the arrangement says, and [F03]'s snap-back cannot happen.

**[B05] Cancel is real and releases everything.** `pointercancel`, `lostpointercapture` and Escape each roll the draft back via the DOM and release every acquisition made at pointer-down — listeners, attributes, the occlusion bracket, the scroll episodes ([L27], [L08]).

**[B06] Limits are read from the allocator, one derivation.** The floor is the largest floor among the side's members; the ceiling is the allocator's. The gesture reads them; it does not recompute them ([L28]'s spirit).

**[B07] Preview cost is graded by what actually moves.** The rail's edge and shadow move by transform (compositor only). The flow content strip moves by `translateX(Δ)`, written where the frames read it, as `flow-offset.ts` does. The side's member frames are pinned to a px width per frame, with `contain: layout` keeping reflow inside the rail — the `PlaceSeam` pattern of [F08]. Under fit layout, content cards translate live and their widths settle once at release. The variable is **not** written onto the layer wrapper during the drag: an inherited custom property changed there restyles every card in the deck, transcripts included, every frame.

**[B08] Release has nothing left to move.** Because the preview put everything where it belongs, the commit only writes state; no FLIP tween fires. `data-pointer-owned` is lifted after the commit's write, not before, so the settle never reads the release as a jump. The one motion at release is the spring back from a limit ([B09]).

**[B09] Feedback is designed, in four states.** Hover: after ~120 ms a 2px accent line on the rail edge. Grab: the line brightens and the rail border takes the accent, so the rail reads as held. Limits: past floor or ceiling the edge follows with diminishing returns and tints toward caution, then springs back on release — a dead stop reads as a bug. Option-held snap guides stay as they are. Tokens follow [L15]/[L20].

**[B10] Performance is proven with a pre-armed frame recorder.** A rAF recorder armed before pointer-down (the settle-frames row clocks too late) drives a scripted drag across a three-member left rail including Overview, and asserts p95 frame time under 8.3 ms with every frame over 16 ms recorded. It runs on a visible window. A separate end-state app-test narrows a three-member rail and asserts every member lands at the new width.

---

## Open Questions {#open-questions}

- **Expensive rail content: live reflow, or reflow on pause?** Overview's first frame has measured ~125 ms. Recommended: the rail's frame and surface track the hand while its content stays anchored to the outer edge, clipped, and reflows on an ~80 ms pause and at release — with live reflow kept for any member that fits the frame budget. Needs the user's call; the [B10] recorder would show which members need it.
- **A width readout near the pointer?** A small pill fading ~400 ms after release. Recommended against: the content strip moving under the hand is the readout. The user's call.
- **Which soft stops, if any?** Candidates: the member's preferred width, the opposite rail's width (match the sides by feel), the slim ceiling; ~6px magnetic catch, Option bypasses. The user's call.

---

## Non-goals {#non-goals}

- **Writing the width variable onto the shown layer wrapper as the fix.** It is one line and it would restore live motion, but it keeps two writers of one property ([F02]) and pays a whole-deck style recalculation per frame ([B07]). Rejected.
- **Running the allocator on a hand drag.** [D183]: the hand owns a rail's sashes; [F07] records that it does not run today, and this work keeps it that way.
- **Changing vertical seam drags or free-pane resizes.** `PlaceSeam` is the model, not the subject; the generic eight-handle resize is a different gesture.
- **Moving the rAF off the gesture.** [L13] sanctions it; removing it was never the fix.

---

## Exit {#exit}

An arc. The ownership fix lands before any feedback, because polishing feedback on the current wiring repeats [F02].

First steps, in order:

1. Pin the defects with tests that fail today: a three-member rail narrowed and every member checked ([F03]); a drag whose capture is lost and every acquisition checked released ([F04]).
2. The side-level commit in `DeckManager` ([B04]) and allocator-read limits ([B06]).
3. Move the draft into `DeckCanvas` as the single writer with its own rollback ([B02], [B03]); reduce `handleSidebarResizeStart` to an emitter with real cancel ([B05]); correct the stale docblocks.
4. The graded preview ([B07]) and nothing-left-to-move release ([B08]), proven by the pre-armed recorder ([B10]).
5. The designed feedback ([B09]), shaped by the answers to the open questions.
