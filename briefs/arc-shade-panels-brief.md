# Arc shade panels

**Purpose:** The arc shade's body is a free canvas of four cards the user can drag, expand and tidy. Replace it with four fixed panels in a 2×2 grid, as the `arc-panels` spike shows them, so the idea-to-arc ladder reads in one fixed order and nothing has to be arranged.

---

## Purpose {#purpose}

The arc shade landed (`4871d4b37`) with a canvas: Idea, Sketch, Brief and Arc as movable, expandable cards joined by measured connectors, with a Tidy button and saved positions. Looking at it in use, the user asked to drop that:

> I think we should move away from the resizable/movable assets. Instead, let's make a 2×2 set of panels, where the progresssion goes from 1. top-left → 2. top-right ⏎ 3. bottom-left → 4. bottom-right.

The `arc-panels` spike (`1dd6b3a75`) worked the shape out over five rounds. The notes that shaped it, in the user's words:

- "I like *Pressed panel is larger*."
- "Each panel should have a progress dot! It should pulse when that phase is active!"
- "Obviously, the design can't have buttons smashing into the content ever."
- "Hide all the buttons except for STOP/RESUME in the arc chip if the chip isn't the active one."
- "Make this spike card *look like the actual app resources*, with all the detail and nuance, so that when I approve, I know what I'm getting."
- "We need some solution that keeps these buttons on one row. Let's make all the buttons other than STOP/RESUME be icons only and expand to icon+label only when I hover. That way, there's only ever two buttons max with icon+label."

The spike is approved as the design. This brief is about bringing it into the shipping arc shade.

---

## Evidence {#evidence}

**[F01] The shipping body is a canvas with its own geometry and persistence.** `tugdeck/src/components/tugways/cards/session-arc-canvas.tsx` (339 lines) and `session-arc-canvas.css` (256) implement drag, expand, a `ResizeObserver` and SVG connectors. `tugdeck/src/lib/arc-canvas-geometry.ts` (178, with `__tests__/arc-canvas-geometry.test.ts`) computes placement, and `tugdeck/src/lib/use-arc-canvas-state.ts` (56) persists positions to the tugbank domain `dev.tugapp.arc-canvas` and exports `tidyArcCanvas`. The shade's header in `session-arc-shade.tsx` carries a Tidy button that calls it. **(verified)**

**[F02] The canvas's caller is small and holds everything that is not layout.** `session-arc-shade-content.tsx` (149 lines) reads the session fields and the arc fact, hosts the verbs through `useArcPopoverVerbs`, and hands `SessionArcCanvas` four card descriptions: Idea and Sketch as `NOT_RECORDED`, Brief from `fact.documents.brief` (`ArcBriefDetail`, `ArcBriefHeadings`), and Arc as `ArcPopoverContent` at full size. With no arc it renders `SessionArcShadeHint` and no canvas. Discard's confirm is anchored by the selector `[data-slot="session-arc-canvas-card"][data-rung="arc"]` and, inside it, `[data-slot="arc-verb-row"]`. **(verified)**

**[F03] The spike composes the shipping parts, with fixtures shaped like the wire.** `tugdeck/src/spikes/spike-arc-panels.tsx` renders the shade's own header classes, `ArcBriefDetail`, `ArcBriefHeadings`, `ArcPopoverContent`, `TugProgressIndicator` and `TugPushButton`, and imports `session-arc-shade.css` and `session-arc-canvas.css` for their styles and `--tugx-arc-canvas-*` variables. What it adds of its own is in `spike-arc-panels.css`: the grid, a panel's frame and three bands, and the seams. **(verified)**

**[F04] The one-row verb mode already ships.** `ArcVerbRow` has a third `labels` mode, `lead-only`: the row does not wrap, the lead verb keeps its word, and every other verb rests as an icon and opens to icon plus label on hover or keyboard focus. `ArcPopoverContent` passes it through as `verbLabels`, default `shown`. Both landed in `1dd6b3a75`; nothing in the app passes `lead-only` yet. **(verified)**

**[F05] The grid's shares cannot be animated.** Motion audit rule 6 refuses a transition on a layout property, and a transition on `grid-template-columns` failed `just lint-audit` in the spike. The spike's share change snaps. **(verified)**

**[F06] The popup list assumes a popover's width.** `ArcPopoverContent`'s list carries a minimum width (420 px, through `.session-arc-popover`) and a capped scroller height. The spike overrides both inside the Arc panel so the list fills the panel and its scroller takes the height left. Not seen rendered at narrow widths. **(read from the code; the fit is unverified by eye)**

**[F07] The canvas is named in tests, docs and decisions.** App-tests `at0860-arc-canvas.test.ts` (drags and positions), `at0861`, `at0473`, `at0475`, `at0525` and `at0627` reference canvas slots. `tuglaws/design-decisions.md` D234 describes the canvas. `docs/features.md` ("The arc shade") and `docs/glossary.md` ("Arc shade") describe drag and Tidy, and `OPERATOR_RETRIEVE_INSTRUCTIONS` in `tugrust/crates/tugcast/src/feeds/overview_agent.rs` names both headings. `theme-pairings.ts` carries the canvas's pairings. **(verified)**

**[F08] Nothing records an arc's idea or sketch yet.** Both cards ship as "Nothing recorded for this arc yet". The brief that would fill them, `briefs(arc-shade): Capture idea and sketch at arc start` (`8efd67ce6`), has not been walked. The spike's Sketch points list, its Source floor and the Brief panel's "Open Arc" floor are fixture content with no shipping source. **(verified)**

**[F09] The spike assumes about 620 px of width.** Its stand-in shade sets `min-width: 620px`. How the 2×2 behaves on a narrower Session card has not been tried. **(verified that it is untried)**

---

## Decisions {#decisions}

**[B01] The arc shade's body is four fixed panels in a 2×2 grid, in reading order.** 1 Idea top-left, 2 Sketch top-right, 3 Brief bottom-left, 4 Arc bottom-right. There is no drag, no expand, no Tidy and no saved position. The order is the ladder, so it is fixed; arranging it was work the user did not want.

**[B02] A panel is three bands.** A header (progress dot, number, name) on one line, a body that scrolls inside the panel, and an optional floor under the body and outside its scrolling. A button lives only in a floor or in the Arc panel's own verb row. This is the structural answer to buttons meeting content: the two are in different bands and the panel clips to its box.

**[B03] The pressed panel takes the larger share.** Its column and its row take 3fr against 2fr. With nothing pressed, the active rung is the large one. The change snaps, per [F05].

**[B04] The press is a DOM attribute, not React state.** The grid carries `data-focus`, and CSS sets the shares from it and hides the Arc panel's non-lead verbs ([L06]). The spike switches the verb set in render; the shipping version does it in the sheet so a press re-renders nothing.

**[B05] Keyboard focus counts as a press.** Focus entering a panel enlarges it, so the verbs hidden in a small Arc panel are reachable without a pointer.

**[B06] The pressed panel is not saved.** It is per card and returns to the active rung when the shade is raised again. With positions gone there is nothing else to persist, so `use-arc-canvas-state.ts` and the `dev.tugapp.arc-canvas` domain are deleted with no migration; there are no installs to carry.

**[B07] Every panel has a progress dot.** `TugProgressIndicator`, `pulsing-dot`: `completed` for a done rung, `stopped` for an empty seat, `running` for the active rung, and `paused` for the active rung of a stopped arc. The dot pulses only on the phase that is live.

**[B08] Seams are grid tracks.** A short arrow across each row and a return from panel 2 down to panel 3, solid when the two rungs are linked and dotted when not. They replace the measured SVG connectors and the `ResizeObserver`, and because they are tracks they never sit over a panel. The link states are the ones `session-arc-shade-content.tsx` computes today.

**[B09] The Arc panel is `ArcPopoverContent` as it is, with `verbLabels="lead-only"`.** It fills the panel edge to edge with the overrides in [F06]. When it holds the larger share it shows the whole row: the lead verb with its word, the rest as icons that open on hover or focus. When it does not, only the next-move verb (Stop, Resume or Join) shows. No arc construct's look changes; the user's instruction was that the panels show the app's own resources.

**[B10] The canvas is renamed to panels throughout.** `session-arc-canvas.tsx/.css` are replaced by `session-arc-panels.tsx/.css`, slots and `--tugx-arc-canvas-*` variables become `…-panel…`, the pairings move with them, and the confirm anchor in `session-arc-shade-content.tsx` follows the new slot. A file called canvas that holds a grid would mislead every later reader.

**[B11] Only the layout ships; the spike's fixture content does not.** Idea and Sketch stay the empty seat they are today ([F08]). The Sketch points, the Source floor, "Open Arc", and the stage and share switchers stay behind. The "even" share is a spike control; the app ships [B03] only.

**[B12] Tests, docs and the decision record move in the same arc.** `at0860` is rewritten to assert what the panels promise: the order, the dot states, that a press enlarges, that a small Arc panel shows one verb, and that a floor never overlaps its body. The other app-tests in [F07] take selector updates and keep their guarantees. The geometry test is deleted with the geometry. D234 is amended to say the canvas was replaced and why; `docs/features.md`, the glossary and the Operator's retrieve instructions are reworded.

**[B13] Both spikes are deleted on graduation.** `spike-arc-panels.*` and `spike-arc-shade.*` and their registry lines go, and the spike count pin in `card-taxonomy.test.ts` moves with them.

---

## Open Questions {#open-questions}

- **What does the grid do on a narrow Session card?** The spike assumes about 620 px ([F09]). The lean is one column of four in the same order below a threshold, with the pressed panel taller, but nobody has looked at it. It wants a look in the spike, or in the shade itself early in the arc, before the threshold and the narrow layout are fixed.

---

## Non-goals {#non-goals}

- **Recording an arc's idea or sketch.** That is the capture brief's work (`8efd67ce6`). These panels are the seats it will fill.
- **Keeping drag, expand or Tidy as an option.** Rejected by the user; a second layout mode would keep all the code this removes.
- **Animating the share change.** Refused by the motion audit ([F05]), and easing grid tracks re-lays-out four panels a frame.
- **Changing how the verb row, the lifecycle block, the ledger or the brief detail look.** The panels compose them unchanged ([B09]). The `on-hover` and `shown` label modes and their callers are untouched.
- **An "even" layout.** Tried in the spike; the user preferred the pressed panel larger.
- **Changing the no-arc state.** With no arc the shade still shows `SessionArcShadeHint`.

---

## Exit {#exit}

**An arc.** Roughly, in an order that keeps the shade working at each step:

1. Lift the grid, `Panel`, the seams and the dot mapping from the spike into `session-arc-panels.tsx/.css` under the new names, with the press as `data-focus` ([B04], [B05]) and the verb hiding in CSS.
2. Point `session-arc-shade-content.tsx` at the panels, pass `verbLabels="lead-only"`, and move the confirm anchor.
3. Remove the canvas: its component and sheet, the geometry module and test, the persistence hook, and the Tidy button.
4. Settle the narrow-card layout by looking at it.
5. Rewrite `at0860`, update the other app-tests' selectors, move the pairings, and reword D234, the feature doc, the glossary and the Operator's instructions.
6. Delete the two spikes.
