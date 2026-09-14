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
import { memberFloorForSheetPanel } from "@/lib/sheet-reservation";
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
 * The natural height of the Choose Session panel, in pixels — the picker's own
 * box plus the sheet's top margin, which is the number the SHEET reports when
 * it measures ([B03]).
 *
 * A Session card with no session behind it is nothing but the Choose Session
 * picker it exists to raise, and the 600px floor in `sizePolicy` below is what
 * a TRANSCRIPT and a composer need — neither of which is on screen yet. So the
 * unbound form declares its own policy, the same way the folded form does, and
 * this is the one measurement that policy rests on.
 *
 * **This is the panel's height, not the member's.** What the member under it
 * needs is {@link memberFloorForSheetPanel} of this, and that sum is the
 * deck's — the title bar and the clip's drop, the clamp's gap against the
 * canvas, less the gap the imposition already leaves under a column's last
 * member. The card knows its panel and nothing else about the box around it,
 * which is what keeps the opening bid and the sheet's own measured reservation
 * denominating one quantity instead of two.
 *
 * The terms, read off the built app rather than off the stylesheet, WITH THE
 * SESSIONS LIST AT ITS CAP. The list is `max-height: 14.5rem` and every row has
 * a 3.5rem floor, so on any project with more than three sessions the list
 * stands at that cap and the picker is as tall as it ever gets. That is the
 * picker this number has to hold: a card pinned at the height of a shorter
 * list opens with the Choose Session header cut off above the path field and
 * the action row cut off below the list, and the sheet's clamp scrolls the
 * rest. A project with fewer sessions opens with air under the list, and air
 * is the price of a constant the arrival can know before `addCard` commits.
 *
 * The two terms this number is: `542`, the panel's own box with the list at
 * its cap — its `scrollHeight` plus its two 1px borders — and `12`, the
 * `--tugx-sheet-space-a` top margin, Choose Session keeping the sheet's
 * default TOP anchor (`modal-rest-line.ts` exempts it) whose rule is
 * `margin: space-a auto 0`. `at0569`'s diagnostics print exactly this sum as
 * the sheet's own reading over a seeded five-session project.
 *
 * The member height this resolved to was 444 once, over a panel box of 368 —
 * the picker as every app-test sees it on a fresh per-instance `sessions.db`,
 * with exactly one row ("New session") in its list. It was measured honestly
 * against the wrong picker, and no test could say so while the tests measured
 * the same one. The list's cap is 174px above the one-row list, and so is this.
 *
 * MEASURED, not derived: `at0569` opens the picker in the built app over a
 * seeded list at the cap and fails if the panel clips at this height, which is
 * what would catch a picker that outgrows it — a taller cap, a taller action
 * row, a wider path field that wraps. Nothing measures the picker at RUNTIME to
 * find this number ([P02]): a measured height arrives a commit after the card
 * does and re-targets the settle mid-beat, which is the judder this constant
 * exists to remove.
 *
 * One state is KNOWINGLY outside it: the picker re-presented after a failed
 * resume carries an inline notice above the form (`SessionProjectPickerForm`'s
 * `notice`), and a panel already at the cap plus a notice is taller than this
 * number holds, so the clamp scrolls it. That is a transient state on a
 * conditional element, and carrying it here would be permanent air under every
 * picker that never sees one. Left as air-versus-scroll for whoever decides it
 * matters; the `at0569` assertions above are the fit with no notice up.
 */
export const SESSION_UNBOUND_PANEL_HEIGHT_PX = 554;

/**
 * The member floor an unbound Session card declares, in pixels ([P02]) — its
 * panel's natural height through the deck's own chrome arithmetic.
 *
 * Derived rather than written: the sum has one home
 * ({@link memberFloorForSheetPanel}) and the sheet's measured reservation goes
 * through the same one, which is what makes the opening bid and the
 * measurement that supersedes it the same quantity.
 */
export const SESSION_UNBOUND_HEIGHT_PX = memberFloorForSheetPanel(
  SESSION_UNBOUND_PANEL_HEIGHT_PX,
);

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
    // While this card is unbound it is its picker and nothing else, so what it
    // NEEDS is the picker's height rather than the transcript's floor ([P02]).
    // A floor and no ceiling, which is the one way this form differs from the
    // folded one above ([B01], [B04]): the card asks for the picker's height
    // and takes more where its column has more to give.
    unboundSizePolicy: {
      min: { width: CONTENT_WIDTH_SLIM_PX, height: SESSION_UNBOUND_HEIGHT_PX },
      preferred: {
        width: CONTENT_WIDTH_COMFY_PX,
        height: SESSION_UNBOUND_HEIGHT_PX,
      },
    },
    engineKind: "em",
  });
}
