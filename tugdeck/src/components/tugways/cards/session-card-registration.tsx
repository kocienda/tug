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
 * `MASTHEAD_FOLDED_HEIGHT` (88) plus its 1px bottom rule, and the 53px the
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
 */
export const SESSION_FOLDED_HEIGHT_PX = 144;

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
    engineKind: "em",
  });
}
