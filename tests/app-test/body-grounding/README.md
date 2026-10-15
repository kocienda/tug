# The body view grounding bar

One file per row of the bar in `briefs/body-view-grounding-brief.md` ([B02]).
A row is green when its test passes **on the app's own path** and a reading on
the real app, with the body switch on, agrees. The switch is the tugbank setting
`dev.tugapp.deck` / `bodies`; the Layout card's Bodies row writes it, and a test
launches with `TUG_BODY_VIEWS=1`.

## The path these tests take

- **Keys go through the session tap with the app active.** Every file here
  launches `foreground: true` and declares `@foreground`, so `nativeKey` and
  `nativeType` post to the session event tap after activating the app and
  making its window key — the route the user's keyboard takes, through AppKit's
  key-equivalent scan and the first responder's page. The pid mode the rest of
  the corpus runs in is never evidence for a chord.
- **Menu commands are performed, not dispatched.** `app.performMenuItem(id)`
  finds the real `NSMenuItem`, validates it as AppKit does at open, and sends
  its action through `NSApp.sendAction`, so validation, the action and
  `sendControl` all run.
- **The effect is asserted where it should land.** A body's DOM, the shell's
  store, the pasteboard, the host's body snapshot — never the delivery of an
  event. `lab.dispatch`, DOM `keydown` synthesis and a `sendControl` from the
  test are not evidence for a keyboard or menu row.
- **Frames are compared by surface colour.** A composite window capture is read
  against the body's own surface colour and the shell's chrome colour, never an
  ink share, which the canvas grid satisfies through an empty placeholder. A
  row that must hold at *every* frame arms `app.captureBurst` over the rect —
  the composited window every 16–33 ms, cropped and written as PNGs — and
  classes each frame's pixels with `_frames.ts`: the pane surface (the lid, or
  the body on it), the canvas floor (the host's, beneath the bodies), its grid
  line, the bare window background,
  or content. An open hole with nothing beneath it is canvas-coloured paint
  with none of the floor's grid in it.

## The rows

| File | Row |
|---|---|
| `probe-tap.test.ts` | The path itself: one character through the activated tap lands in a body's composer; one menu item performed takes effect in the body. |
| `row-01-arrival.test.ts` | ⌘N: a new card arrives with nothing of the canvas, grid or an older pane showing through the hole at any frame, cold and warm. |
| `row-02-drag.test.ts` | A card drags as one piece: masthead, frame and content together under the pointer, landing together. |
| `row-03-departure.test.ts` | A card departs as one piece, and the hole closes with it. |
| `row-04-slide.test.ts` | A slide (flow, Go to slot, bullseye, sidebar show/hide, fit) moves each card as one piece: a slide that only moves the card is carried by the host; one that changes its size keeps the interim, hide at the beat's start and show at the land. |
| `row-05-chords.test.ts` | Every chord in the keyboard files works from a body and from the shell. |
| `row-06-menus.test.ts` | Every Swift menu command works with a body first responder, including the ones validating against the first responder's undo manager. |
| `row-07-focus.test.ts` | Activating a card makes its body first responder; typing goes there and nowhere else; the shell's surfaces take and return focus; closing the key card hands focus on. |
| `row-08-sheets.test.ts` | The Changes shade, the history view and the find bar open, list, scroll and close from a body. |
| `row-09-fold.test.ts` | Fold hides the body; the unfold shows it with no peek. |
| `row-10-workspace.test.ts` | A workspace switch shows and places every arriving body and hides every departing one, with no frame showing a body in the wrong place. |
| `row-11-lifecycle.test.ts` | Close, close all, reload and quit: no body outlives its card; every page saves and terminates under the deadline. |
| `row-12-composer.test.ts` | Z2, the composer, paste of text and images, and the picker-to-body handoff. |
| `row-13-arc-tracking.test.ts` | An arc bound to a body's session reads in that body's Z2 and on the shell's masthead and Arcs card. The stores a body attaches are enumerated by `tugdeck/src/body/__tests__/body-stores.test.ts`. |
| `row-14-beats-move.test.ts` | A gesture that only moves body cards (the flow slide out and back, a cross-column stack move) carries each body with its chrome on the host: the lid stays lifted, the content box never shows the floor, the presented container tracks the placeholder, the render server advances it every tick, and it lands on the placeholder to the pixel. |
| `row-15-skew.test.ts` | The skew between a carried body and its chrome on composite frames, read by a stripe in the body's page against the title bar's edge: noted at an offset of 0 (the median sets the shipped offset), and within two frames of travel at the shipped offset, at rest and with three bodies streaming. |
| `row-16-back-pane-cut.test.ts` | A body carried across a Text card behind it: the back pane's cut moves with the body on the plan's clock, so no frame in motion shows the Text card's ink inside the body; the shell's gap rows over the motion are noted. |
| `row-17-crossing.test.ts` | Bullseye, a column split and a new card beside the body card (⌘N's action) carry it with its chrome, to a new size where the box changes: `crossingReady` within a display period of the first moving beat, the content box and its bottom strip never the floor, the transcript pinned to its bottom before and after, and the container's top corners square. |
| `row-19-streams.test.ts` | A body streams through the shell's settle: every body applies a batch between the motion gate's close and open, and none is parked, across a flow slide and a cross-column stack move. |
| `row-20-drag-hole.test.ts` | A body card dragged across a Text card, the drag cancelled, or the card carried there by a settle, leaves no hole in the Text card at rest: every pane's cut is the landed deck's. |
| `row-21-edges.test.ts` | A body card's side edges are the pane's border and nothing else, read beside a Text card's at zoom 0.8, 0.9 and 1.0, with each card key. |
| `row-22-compaction-cover.test.ts` | A body's Compacting cover rests on the rest line above Z2, as the in-document card's does, not at the top of the transcript. |
| `row-23-tab-edge.test.ts` | A body card's walk runs off its edge into the shell and comes back, by Tab and ⇧Tab and by the View menu's Next and Previous Keyboard Focus, with the body holding the keyboard at every step. |
| `row-24-focus-through-motion.test.ts` | The key body keeps the keyboard through a settle that carries it on the host, and what is typed during the motion lands in it. |
| `row-25-in-card-surfaces.test.ts` | The completion popup, the composer's context menu and the route badge's report draw whole inside the body, where its DOM says they are. |
| `row-26-deck-scope-surfaces.test.ts` | What a body raises past its content box the shell draws: the Z2 placard over the deck, its buttons reaching the body, and `/logout`'s confirm. |
| `row-27-drop-into-body.test.ts` | A drag over a body is the body's: a file from outside the window and a jot from the Jots card both land in its composer, and the shell's page takes no drop. |
| `row-28-deck-facts.test.ts` | A body follows the focus-ring modality live, and the shell's held modifiers land on its root, with the shell key, the body key and across a hand-off. |
| `row-29-voiceover-order.test.ts` | VoiceOver reads the shell, then each showing body in deck order, whichever pane stands in front. |
| `floor-host.test.ts` | The host draws the canvas floor: its colour and grid match the page's own by composite at zoom 0.8, 1.0 and 1.25, and it never shows before the window's reveal. |

A row's file lands with the step that builds the row; a file not yet here is a
row not yet green.
