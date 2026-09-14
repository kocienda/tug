/**
 * registerSessionCard — registers the "dev" card type with the card registry.
 *
 * Split out of `session-card.tsx` so that file stays a component-only React Fast
 * Refresh boundary: a `.tsx` exporting a registration function alongside its
 * components is "mixed" and non-accepting. This shim is `.tsx` because the
 * content factory JSX-renders `<SessionCardContent>`; it exports no component, so
 * it is transparent and does not itself need to be a boundary. `main.tsx`
 * imports `registerSessionCard` from here.
 *
 * @module components/tugways/cards/session-card-registration
 */

import { registerCard } from "@/card-registry";
import {
  CONTENT_WIDTH_COMFY_PX,
  CONTENT_WIDTH_SLIM_PX,
} from "@/lib/layout-imposer";
import { FeedId } from "@/protocol";
import { SessionCardContent } from "./session-card";

/**
 * The height a folded Session card stands at, in pixels ([P04]).
 *
 * The two bands of the folded form add up here: the masthead tier at
 * `SESSION_MASTHEAD_HEIGHT` (88) plus its 1px bottom rule, and the 53px the
 * card body needs for the Z2 status row alone. It was 173 while the form
 * carried a Show Transcript bar under Z2; retiring that band into a control at
 * Z2's leading edge ([B03], [B04]) is what took 29px off the tier, and a 900px
 * run now holds six folded cards where it held five.
 * MEASURED, not derived: `at0552` reads the built app's own numbers and fails
 * if Z2 overhangs the frame or leaves air under it, which is what caught the
 * plan's starting 160 — the spike's 159 was measured without the pane frame
 * around it — and what settled this number one pixel at a time.
 *
 * Pinned rather than a floor: it is BOTH `min.height` and `max.height` in the
 * folded policy, which is what makes `TugPane` place the frame at the tier
 * instead of filling its run, and what makes a wall of folded cards pack.
 *
 * It moved with the tier and back again: the masthead's description took a
 * LOOSE type setting for one arc and the tier grew 14px to hold the pair in a
 * band a commit pill is whole in, so the folded form grew by the same 14. Then
 * the pill left the description line, the tier gave the 14 back, and so did
 * this. Z2's band was untouched throughout.
 */
export const SESSION_FOLDED_HEIGHT_PX = 144;

/**
 * The height an UNBOUND Session card stands at, in pixels ([P02]).
 *
 * A Session card with no session behind it is nothing but the Choose Session
 * picker it exists to raise, and the 600px floor in `sizePolicy` below is what
 * a TRANSCRIPT and a composer need — neither of which is on screen yet. So the
 * unbound form declares its own exact height, the same way the folded form
 * declares its own policy, and `addCard` pins it for as long as the card is
 * unbound.
 *
 * The terms, read off the built app rather than off the stylesheet:
 *
 * - `37` — the pane's title bar (36, `--tug-chrome-height` in `tug-pane.tsx`)
 *   and the 1px the sheet's clip drops below it (`.tug-sheet-clip`'s
 *   `top: calc(chrome-height + 1px)`).
 * - `12` — `--tugx-sheet-space-a`, the panel's top margin. Choose Session keeps
 *   the sheet's default TOP anchor (`modal-rest-line.ts` exempts it), whose
 *   rule is `margin: space-a auto 0`.
 * - `368` — the picker panel's own box: its `scrollHeight` plus its two 1px
 *   borders. `at0569`'s diagnostics print the SHEET's reading of this, which is
 *   the same number plus the 12px margin above.
 * - `32` — `SHEET_CANVAS_GAP`. This is the term that is not about the panel at
 *   all, and the one an arithmetic answer misses. `tug-sheet.tsx`'s top-anchor
 *   clamp caps the panel against the CANVAS bottom rather than the frame's, so
 *   a card sitting at the foot of a split column has to carry that gap inside
 *   its own height or the clamp cuts the panel short — which is precisely what
 *   429 did, by the 14px `at0569` measured before this number moved.
 *
 * 37 + 12 + 368 + 32 = 449, less the 5px the imposition already leaves under
 * the column's last member, which the clamp's canvas reading gets for free.
 *
 * MEASURED, not derived: `at0569` opens the picker in the built app and fails
 * if the panel clips at this height, which is what would catch a picker that
 * outgrows it — another row in the list, a taller action row, a wider path
 * field that wraps. Nothing measures the picker at RUNTIME to find this number
 * ([P02]): a measured height arrives a commit after the card does and re-targets
 * the settle mid-beat, which is the judder this constant exists to remove.
 */
export const SESSION_UNBOUND_HEIGHT_PX = 444;

export function registerSessionCard(): void {
  registerCard({
    componentId: "session",
    contentFactory: (cardId) => <SessionCardContent cardId={cardId} />,
    defaultMeta: { title: "", icon: "MessageSquareText", closable: true, confirmClose: true },
    cardsGroup: "sessions",
    cardFeedIds: [
      FeedId.CODE_INPUT,
      FeedId.CODE_OUTPUT,
      FeedId.SESSION_SIDEBAND,
      FeedId.FILETREE,
    ],
    sizePolicy: {
      // The width floor is set by the Z2 status row, the card's widest
      // fixed-content surface. Post-diet that row is five cells at
      // 14/13/13/15/13ch of its own 10px font (≈ 354px of cell content, ≈ 414px
      // with each cell's padding), four 16px gaps, and 16px of row padding on
      // each side — ≈ 564px measured in the built app, which is what makes the
      // 675px slim preset viable with room to spare. The floor IS the slim
      // preset: a card that could go narrower than the narrowest width the deck
      // offers would have a floor no gesture can reach, and one that could not
      // reach slim would make the preset a lie on the card the diet was for.
      // `getStackSizePolicy` lifts the hosting pane's resize floor to this value
      // (or higher, if a wider card shares the pane), so the instrument readout
      // never clips. The height floor must fit the prompt entry (the fixed 200px
      // text area + its toolbar/indicator rows) AND leave the transcript its
      // minimum (`--session-transcript-min`), so the entry never crowds the
      // transcript out even at the smallest card size.
      min: { width: CONTENT_WIDTH_SLIM_PX, height: 600 },
      // The card opens at the deck's content width (`takesContentWidth` below);
      // this width is the fallback for a path with no deck to ask, and it is
      // comfy because comfy is what a deck with no recorded preference is at.
      // The height intentionally exceeds many laptop canvases; `addCard` clamps
      // height to 90% of the live canvas at creation, so on a smaller screen the
      // card opens at canvas * 0.9 instead of pushing past the viewport.
      preferred: { width: CONTENT_WIDTH_COMFY_PX, height: 1200 },
    },
    // The folded form is a different card for sizing ([P04]): the 600px
    // floor above is what the TRANSCRIPT and the composer need, and neither is
    // on screen here. The width policy is unchanged — a folded card is as
    // wide as its slot — so `max.width` is declared unbounded rather than
    // omitted, which `CardSizePolicy` requires and which leaves `widthPinned`
    // false where a finite width would have pinned it.
    foldedSizePolicy: {
      min: { width: CONTENT_WIDTH_SLIM_PX, height: SESSION_FOLDED_HEIGHT_PX },
      max: {
        width: Number.POSITIVE_INFINITY,
        height: SESSION_FOLDED_HEIGHT_PX,
      },
      preferred: {
        width: CONTENT_WIDTH_COMFY_PX,
        height: SESSION_FOLDED_HEIGHT_PX,
      },
    },
    takesContentWidth: true,
    // While this card is unbound it is its picker and nothing else, so it
    // stands at the picker's height rather than at the transcript's floor
    // ([P02]). `addCard` pins it; the binding commit drops the pin ([P04]).
    unboundExactHeightPx: SESSION_UNBOUND_HEIGHT_PX,
    engineKind: "em",
  });
}
