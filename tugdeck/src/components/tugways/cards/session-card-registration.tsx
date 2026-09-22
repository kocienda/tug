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
import type { CardIdentityFacts } from "@/card-registry";
import { cardSessionBindingStore } from "@/lib/card-session-binding-store";
import {
  CONTENT_WIDTH_COMFY_PX,
  CONTENT_WIDTH_SLIM_PX,
} from "@/lib/layout-imposer";
import {
  sessionDisplayTitleForBinding,
  sessionDisplayTitleFor,
  sessionIdentityLineFor,
  sessionIdentityLineForBinding,
} from "@/lib/session-identity";
import { spaceBindingsLedgerStore } from "@/lib/space-bindings-ledger-store";
import { FeedId } from "@/protocol";
import { SessionCardContent } from "./session-card";
import { sessionPickerPanel } from "./session-picker-panel";
import { sessionPickerQuiet } from "./session-picker-quiet";

/**
 * What a MOUNTED Session card is seated on — the live binding the
 * `spawn_session_ok` ack writes.
 *
 * A card receives a binding only when it mounts, which is exactly why the
 * parked resolver below exists: a workspace nobody has activated mounts no
 * cards, so this answers `null` for every card in one.
 */
function liveSessionIdentity(cardId: string): CardIdentityFacts | null {
  const binding = cardSessionBindingStore.getBinding(cardId);
  if (binding === undefined) return null;
  return {
    title: sessionDisplayTitleForBinding(binding),
    secondary: sessionIdentityLineForBinding(binding),
    tugSessionId: binding.tugSessionId,
    projectDir: binding.projectDir,
  };
}

/**
 * What the bindings ledger remembers this card is seated on ([F02], [P08]).
 *
 * The boot `list_card_bindings_ok` frame lists EVERY card id the ledger knows
 * rather than only the active deck's, precisely so it can answer for a
 * workspace nobody has opened — and the Cards card read all of that for a
 * single `N live` boolean while the row above it drew as a generic `session`
 * cell with a close × where its identity should be.
 *
 * The ids are the whole of the fix ([B04]). The name, tag and synopsis stores
 * are already seeded for every card at boot by the same frame's handler, keyed
 * by the row's line — so handing back the session id and the project dir is
 * enough for the identity projection to compose the same title and Line a
 * bound card gets, with no round trip and no second description ladder.
 */
function parkedSessionIdentity(cardId: string): CardIdentityFacts | null {
  const row = spaceBindingsLedgerStore.get(cardId);
  if (row === undefined) return null;
  const context = { projectDir: row.project_dir };
  return {
    title: sessionDisplayTitleFor(row.session_id, context),
    secondary: sessionIdentityLineFor(row.session_id, context),
    tugSessionId: row.session_id,
    projectDir: row.project_dir,
  };
}

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

export function registerSessionCard(): void {
  registerCard({
    componentId: "session",
    contentFactory: (cardId) => <SessionCardContent cardId={cardId} />,
    defaultMeta: { title: "", icon: "MessageSquareText", closable: true, confirmClose: true },
    cardsGroup: "sessions",
    identity: { live: liveSessionIdentity, parked: parkedSessionIdentity },
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
    // needs across is the picker's width and what it needs down is whatever
    // the picker turns out to be ([P06]). The width is declared here; the
    // height is not declared anywhere, because the card arrives HIDDEN and its
    // sheet reports its own height before the reveal ([B01]). A number written
    // here would be a second answer that disagreed with the sheet's the moment
    // the picker's content changed.
    unboundWidthPolicy: {
      min: CONTENT_WIDTH_SLIM_PX,
      preferred: CONTENT_WIDTH_COMFY_PX,
    },
    // The opening form, built by the very factory the live sheet calls
    // ([P01]). Declaring it is what makes this card arrive hidden and reveal
    // at its picker's own height ([B01]). No handlers: a form declared for its
    // box has nothing to open or cancel.
    openingForm: (cardId) => sessionPickerPanel({ cardId }),
    // What the hidden card waits on before it is revealed ([B03]): the
    // picker's listing settling or filling its cap, and its rows' synopses.
    arrivalQuiet: () => sessionPickerQuiet(),
    engineKind: "em",
  });
}
