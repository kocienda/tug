# A dragged rail card leaves the band alone

**Purpose:** Dragging a sidebar card from one rail to the other lights the empty content slots' numbered badges and autoscrolls the content strip, as if the card could land in the band. It cannot, and the band should stay inert. The mirror is true of a content card over a rail.

---

## Purpose {#purpose}

The report, in the user's words:

> When I drag a sidebar card from one rail on one side of the deck/canvas to the other rail on the other side, it treats the content card area in the middle as a potential drop zone (of sorts), in that I see the numeric slot for empty content card slots, and content card slots *scroll* to the end and move cards offscreen as if my drag is autoscrolling the content card area. This is just wrong when I'm dragging a *sidebar card*.

A sidebar card is a rail member. The only places it can land are positions in a rail, and the drop-zone engine already says so. Two things beside the engine — the held-open places' visibility and the autoscroll — do not know which kind of card is in the air, and both answer for the wrong kind.

---

## Evidence {#evidence}

**[F01] The drop-zone engine already confines a rail card to the rails** — `enumerateDropZones` in `tugdeck/src/lib/drop-zones.ts` finds the dragged pane's own rail first, and when it has one, enumerates only `rail-index` zones (each rail's positions plus the empty side's vacancy) and returns before the slot walk. A content card, conversely, is offered `column-index`, `slot` and `tab-bar` zones and never a `rail-index`. The vocabulary already draws the line this brief wants drawn everywhere else. **(verified)**

**[F02] The carry marker has no kind** — `gaugeDragFrame` in `tugdeck/src/components/chrome/deck-canvas.tsx` writes a bare `data-carrying` attribute on the canvas when a frame starts travelling and removes it when the gesture retires. Three CSS rules read it by presence alone: `slot-vacancy.css` shows every empty slot's numbered badge under `[data-carrying]`; `rail-vacancy.css` shows the empty deck edge's hairline ring under `[data-carrying]`; and `tug-pane.css` fills in every seated rail member's border under `[data-carrying]` with the stated reason that "every rail place is somewhere the drop could land". So a rail drag lights the slot badges it can never land in, and a content drag rings a rail edge it can never land in. **(verified)**

**[F03] The autoscroll target ignores what is being dragged** — `autoscrollTargetFor(pointer, draggedPaneId)` in `deck-canvas.tsx` asks overflowing rails, then overflowing columns, then unconditionally returns the flow strip when the deck is in flow and the strip is wider than the band. The dragged pane id is used only to pick a seated member to measure a band from, never to decide which strips are askable. A rail card carried across the band therefore reaches the flow branch and scrolls the content strip — the scroll-to-the-end in the report. The mirror holds: a content card over an overflowing rail scrolls that rail. **(verified)**

**[F04] Both readers already have what they need to know the kind** — the pane element stamps `data-role="sidebar"` on a rail member (`tug-pane.tsx`), and the frame handed to `gaugeDragFrame` is that element. The canvas holds `sidebarPaneIds`, a set of every pane hosting a sidebar card, and `autoscrollTargetFor` is handed the dragged pane id. No new plumbing is required to answer "rail or card?" at either site. **(verified)**

**[F05] Free drags are already outside this** — the gesture in `tug-pane.tsx` runs no zones and no autoscroll when `enumerate` returns an empty set (a free pane or an unpinned sidebar card). Only arrangeable cards reach the two readers above. **(verified)**

**[F06] The existing app-tests assert the marker by presence** — `at0465-empty-slot` and `at0539-rail-drop-empty-side` check `data-carrying` with `closest("[data-carrying]")` and `hasAttribute("data-carrying")`. Giving the attribute a value keeps both true. **(verified)**

---

## Decisions {#decisions}

**[B01] A place reacts to a drag only when the drag could land in it.** This is one sentence and it is the whole rule. The drop-zone vocabulary ([F01]) already states which places a card can land in; the held-open places' visibility and the autoscroll strips are two more readers of the same fact and must draw the line where the vocabulary draws it. A reader that shows a place, or scrolls a strip, the card cannot land in is lying about the drop.

**[B02] The carry marker carries the kind: `data-carrying="rail"` or `data-carrying="card"`.** `gaugeDragFrame` reads the kind off the frame's own `data-role` ([F04]) and writes it as the attribute's value. Same verb, same set and clear paths, no new lifecycle. The values reuse the pane's existing role vocabulary rather than inventing a new one. Presence-only readers keep working ([F06]); the rules that care about the kind select on the value.

**[B03] The three carry-keyed CSS rules key on the kind.** The slot badge shows under `[data-carrying="card"]`; the rail vacancy ring shows under `[data-carrying="rail"]`; the panel-treatment border fill in `tug-pane.css` shows under `[data-carrying="rail"]`, because its own comment gives its reason as "every rail place is somewhere the drop could land", which is only true of a rail card.

**[B04] `autoscrollTargetFor` asks only the strips the dragged card can land in.** It decides once whether the dragged pane is a rail member — the same membership the enumerator reads — and then asks rails for a rail card, or columns then the flow strip for a content card. The branches that do not apply are skipped, not reordered; the rail-before-column-before-flow order is kept for the cards it still applies to.

**[B05] The mirror bugs are fixed in the same change.** A content card ringing an empty rail edge, and a content card scrolling an overflowing rail, are the same defect read from the other side ([F02], [F03]). A half-applied principle is a new inconsistency, and the fix for each is the same edit at the same site.

**[B06] Both directions get an app-test.** One drags a sidebar card across the band on a flow deck whose strip overflows, and asserts the flow offset never moves and no slot badge is shown. Its mirror drags a content card over an overflowing rail and asserts the rail offset never moves and the rail vacancy ring is not shown. Each carries `@covers` for `deck-canvas.tsx` and the CSS it reads.

---

## Non-goals {#non-goals}

- **Making a rail card droppable in the band, or a content card in a rail.** That would be a change to the drop vocabulary ([P10]) and is a different piece of work. This brief takes the vocabulary as it stands and makes the other readers agree with it.
- **Deriving the kind from the zone set instead of the frame.** Having `enumerate` return a kind and threading it through the gesture would work, but the frame already says what it is and the canvas already knows its rail members ([F04]); a second channel for a fact two readers can already read is plumbing for nothing.
- **Reworking the autoscroll engine.** `autoscrollDelta`, the per-strip offset runs, and the commit path in `tug-pane.tsx` are untouched. Only the question of which strip is being asked about changes.
- **Rendering the held-open places conditionally in React.** Their visibility is a DOM attribute read by CSS ([L06]) and stays so; the change is to the attribute's value and the selectors, not to what is mounted.

---

## Exit {#exit}

**An arc.** The shape is small and the order is fixed by dependency:

1. `gaugeDragFrame` writes the kind as the value of `data-carrying` ([B02]).
2. The three CSS rules select on that value ([B03]).
3. `autoscrollTargetFor` gates its strips on rail membership ([B04]).
4. The two app-tests ([B06]), plus a run of `just app-test-changed` to confirm `at0465` and `at0539` still hold ([F06]).

Steps 1 and 3 are independent of each other; step 2 depends on 1; step 4 comes last.
