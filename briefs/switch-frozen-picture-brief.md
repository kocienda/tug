# The departing workspace is a picture: freeze its frames for the dissolve

**Purpose:** A workspace switch paints the workspace being left on top of the one arriving and dissolves it off. During that beat the departing cards are drawn in the wrong places — a right-rail Workspaces card at the left edge, a slotted session card at a stale free position — so the middle of every switch is a spray of mis-placed cards.

---

## Purpose {#purpose}

The user's report, going from the `eucit` workspace to `Main` in this app:

> The inter-workspace switch is *completely wrong* in terms of how it animates. It spews *incorrectly-placed* cards during the crossfade. … Nothing explains the animation-middle state here with incorrectly-placed sidebar cards. It's just wrong.

Three screenshots: `eucit` at rest (one session card in slot 2 of Three Up · Slim, Workspaces and Layout cards pinned on the right rail), the mid-dissolve frame, and `Main` at rest (four session cards, a left rail of Arcs/Jots/Overview, Workspaces and Layout on the right). In the middle frame the departing `eucit` Workspaces card stands at the canvas's left edge at a taller size than it had, and the `eucit` session card's body shows through at x≈10 rather than at its slot. The Layout card is not visible at all.

---

## Evidence {#evidence}

**[F01] A hidden layer's panes are rendered with every arrangement prop withheld.** In the layer render of `tugdeck/src/components/chrome/deck-canvas.tsx` (around line 6900), `placement`, `sidebarStack`, `columnMember`, `slotStack`, `arriving` and `contentWidthPx` are all spelled `layer.shown ? … : undefined`. The comment beside `placement` says why: "A hidden one has no imposition to stand in — its panes come back through these same props the moment it is shown." That is correct for a layer that is `display: none`, and wrong for the one layer that is not. **(verified, read out of the code)**

**[F02] The outgoing layer loses those props in the same commit that starts the dissolve.** `DeckManager.activateSpace` (`tugdeck/src/deck-manager.ts`, ~1341 onward) parks the outgoing deck, swaps `deckState`, moves `activeSpaceId` and notifies once, landing `"cut"`. In that one React commit the outgoing wrapper drops `data-space-shown` and its panes drop every prop in [F01]. The crossfade layout effect (`deck-canvas.tsx` ~6147 onward) then finds that wrapper by `data-space-layer`, writes `data-space-crossing`, and tweens its opacity. It never touches a frame. **(verified, read out of the code)**

**[F03] A pane with no placement and no rail draws its stored free frame.** `TugPane`'s `modeStyle` (`tugdeck/src/components/chrome/tug-pane.tsx` ~4671–4698) falls through bullseye → pinned (`sidebarSide`, which is `sidebarStack?.side`) → imposed (`placement !== undefined`) → `{ left: position.x, top: position.y, width: renderWidth, height: frameHeight }`. The pane's own comment a few lines later calls that stored position "a last-known value the imposer has long since superseded". A rail card that loses `sidebarStack` stops being pinned altogether and lands wherever it was last dragged before it was ever on a rail. This is the frame in the middle screenshot. **(verified, read out of the code; consistent with the screenshot, where the session card's body sits at x≈10 and the Workspaces card at the left edge at a stale height)**

**[F04] Even a departing pane that kept its placement would be laid out against the arriving deck.** The imposer's frames are `calc()` chains over custom properties — `--tug-imposer-inset-*`, `--tug-sidebar-width-*`, `--tug-slot-*-seam-*`, `--tug-rail-*` — and the inset effect writes them on the **shared canvas container** for the shown deck (`deck-canvas.tsx` ~2788 onward, `tugdeck/src/lib/layout-imposer.ts` for the property names). During the beat those hold `Main`'s rails and columns. So the fix is not "keep the props": a live layer under the arriving deck's variables is still wrong, just differently. **(verified, read out of the code)**

**[F05] The design doc asserts the property the code does not keep.** `tugdeck/src/components/chrome/space-layer.css` says of the crossing rule: "The geometry survives the change because the box is the same box … nothing moves on the way out." The box is the same. The frames inside it are re-derived. **(verified)**

**[F06] The existing crossfade test cannot see this.** `tests/app-test/at0592-workspace-switch-crossfade.test.ts` asserts opacity, z-order, pointer inertness, attribute hand-back and inline residue. No leg compares where a departing frame stands during the beat against where it stood before the switch, and its two fixture workspaces share one arrangement (one-up, rail on the right). **(verified, read out of the test)**

---

## Decisions {#decisions}

**[B01] For the length of the dissolve, the departing workspace is a picture, not a live layer.** The crossing state is already defined as "shown enough to paint, inert to the pointer, and owed back" (`space-layer.ts`). Its frames should match that definition: a departing pane carries the pixel rect it was painted at when the switch committed, and no live arrangement at all. A picture cannot re-lay-out, which is also the property the quiet arc (`briefs/workspace-switch-quiet-brief.md`) had to suppress by hand when the layer was live: geometry commits under a dissolve are motion the reader did not ask for.

**[B02] The rects are measured before the switch commit, by the manager, at the moment it already owns.** `activateSpace` writes `data-space-switching` on the canvas *before* `notify` precisely because that is the one instant that precedes every layout effect in the arriving layer. The same instant is the last one at which the outgoing frames still stand where the user saw them: sweep `SHOWN_PANE_FRAMES`, read each frame's rect relative to the canvas container, and hold the map for the canvas to read imperatively during the beat. After the commit the frames have already been re-laid-out and the information is gone, so no effect in `DeckCanvas` can take the measurement itself.

**[B03] The rects are applied in the crossfade layout effect, as inline style on each departing frame, and restored through the same `restores` list as the opacity tween.** A layout effect runs before paint, so the wrong frame of [F03] is never painted. React does not fight the override: a hidden layer's `style` prop is identical from render to render, so its diff writes nothing to the DOM until the layer is shown again, and the effect's `teardown()` — reached by completion, deadline, the next switch and unmount alike — puts the inline values back. The debt is held to the same `[L32]` deadline the attribute already is.

**[B04] The freeze covers every departing frame, rail cards included, and nothing in the arriving layer.** The arriving workspace is opaque underneath from the first frame and is never touched; that is what makes shared pixels stand still, and it is unchanged here. Frames are frozen as a set by sweeping the outgoing layer, never by pane kind.

**[B05] Motion off freezes nothing.** With `isTugMotionEnabled()` false the effect writes no `data-space-crossing` today and the outgoing layer is `display: none` from the commit. The measurement in [B02] is skipped on the same condition, so a reduced-motion switch costs no rect sweep.

**[B06] at0592 gains a positional leg with two workspaces of different arrangements and rail sides.** Sample every departing frame's canvas-relative rect before the switch and at each sample of the beat; they must be equal, and `data-space-crossing` must never be observed on a layer whose frames differ from the pre-switch rects. The fixture's two workspaces must differ in imposition kind and rail side, or the leg proves nothing ([F06]).

---

## Open Questions {#open-questions}

- **Which frame attributes the picture must also carry.** For the beat a departing frame loses `data-imposed`, `data-column-member` and the pinned-rail attributes along with its props. Anything in `tug-pane.css` keyed on those — the one-sided rail shadow via `--tugx-rail-side` is the likely case, folded strips another — could read differently for the beat even with the rect frozen. Settled by reading `tug-pane.css` for selectors over those attributes at implementation time; if any change the painted pixels, the freeze carries those attributes as well.

---

## Non-goals {#non-goals}

- **Deriving the departing deck's own placements from `layer.deck` and shadowing the custom properties on the crossing layer's box.** It would work in principle — the crossing layer is a real box, so variables written on it would win — but it re-spells the inset effect's whole derivation for a second deck and keeps the departing layer live, which is the property that produced the geometry commits under a dissolve the quiet arc had to stand down. Rejected in favour of [B01].
- **Cloning the outgoing layer's DOM as the picture.** A deep clone of several transcripts per switch is the kind of cost the framerate complaints are about, and the live frames with baked rects are already the picture. Rejected.
- **Changing the dissolve's shape, timing, z-order or the `"cut"` landing.** All unchanged; at0592's existing legs remain the contract.
- **Keeping stored `position` in sync with imposed placements.** The stale free frame is a symptom here, not the disease: even an up-to-date free frame is not the frame the imposer painted.

---

## Exit {#exit}

An arc. First shape of the work, in the order it must land:

1. A measurement hook on `DeckManager.activateSpace` that sweeps `SHOWN_PANE_FRAMES` before `notify`, stores canvas-relative rects keyed by pane id, and exposes them to the canvas by a getter; skipped under reduced motion ([B02], [B05]).
2. The crossfade effect applies the rects as inline `left/top/width/height` on each departing frame when it writes `data-space-crossing`, and restores them in `teardown()` ([B03], [B04]).
3. `space-layer.css`'s crossing comment corrected to say the frames are frozen, not that they survive on their own ([F05]).
4. The new at0592 leg with two differently arranged workspaces ([B06]), plus the attribute check from the open question.
