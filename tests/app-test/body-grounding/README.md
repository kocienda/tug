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
  the body on it), the canvas floor, its grid line, the bare window background,
  or content. An open hole with nothing beneath it is canvas-coloured paint
  with none of the floor's grid in it.

## The rows

| File | Row |
|---|---|
| `probe-tap.test.ts` | The path itself: one character through the activated tap lands in a body's composer; one menu item performed takes effect in the body. |
| `row-01-arrival.test.ts` | ⌘N: a new card arrives with nothing of the canvas, grid or an older pane showing through the hole at any frame, cold and warm. |
| `row-02-drag.test.ts` | A card drags as one piece: masthead, frame and content together under the pointer, landing together. |
| `row-03-departure.test.ts` | A card departs as one piece, and the hole closes with it. |
| `row-04-slide.test.ts` | A slide (flow, Go to slot, bullseye, sidebar show/hide, fit) moves each card as one piece; the interim is hide at the beat's start, show at the land. |
| `row-05-chords.test.ts` | Every chord in the keyboard files works from a body and from the shell. |
| `row-06-menus.test.ts` | Every Swift menu command works with a body first responder, including the ones validating against the first responder's undo manager. |
| `row-07-focus.test.ts` | Activating a card makes its body first responder; typing goes there and nowhere else; the shell's surfaces take and return focus; closing the key card hands focus on. |
| `row-08-sheets.test.ts` | The Changes shade, the history view and the find bar open, list, scroll and close from a body. |
| `row-09-fold.test.ts` | Fold hides the body; the unfold shows it with no peek. |
| `row-10-workspace.test.ts` | A workspace switch shows and places every arriving body and hides every departing one, with no frame showing a body in the wrong place. |
| `row-11-lifecycle.test.ts` | Close, close all, reload and quit: no body outlives its card; every page saves and terminates under the deadline. |
| `row-12-composer.test.ts` | Z2, the composer, paste of text and images, and the picker-to-body handoff. |
| `row-13-arc-tracking.test.ts` | An arc bound to a body's session reads in that body's Z2 and on the shell's masthead and Arcs card. The stores a body attaches are enumerated by `tugdeck/src/body/__tests__/body-stores.test.ts`. |

A row's file lands with the step that builds the row; a file not yet here is a
row not yet green.
