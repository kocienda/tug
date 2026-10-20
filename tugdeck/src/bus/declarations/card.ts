/**
 * What the shell and one body tell each other about the body's card.
 *
 * The shell's: `card.context` is the card's place in the shell's deck
 * (`cardContextFor` in `lib/body-shell.ts`). `card.crossing` is the crossing
 * its pane stands under, which moves with every mark a fold or settle
 * writes, so it travels apart from the context and never resends it.
 * `card.railHold` holds a rail card's content at a width while a rail width
 * drag moves its frame. `card.inspected` says a devtools card follows the card, and
 * `devtools.inspection` is what a devtools card is shown of the card it
 * follows.
 *
 * The card's, set by its body (`body/body-publisher.ts`) and read in the
 * shell with `getFor`: what the card shows the chrome (`card.facts`), what
 * the chrome asks of it synchronously at gesture time (`card.holds`), the
 * room it asks for (`card.reservations`), the surface it raises past its
 * content box, its first painted frame, its cold restore, its content
 * reading, its keyboard-focus paint, and its session inspection. The ones
 * a page holds only while it stands clear when the shell detaches the card;
 * the rest stand until the reloaded page replaces them.
 *
 * The orders a reader relies on are declared with `after`, not left to
 * declaration order: `card.painted` goes after `card.facts`, so a body that
 * attaches sends its facts first (and the shell's paint gate waits for the
 * facts besides), and `card.context` goes after `card.crossing`, so a body
 * reads its crossing before its context.
 *
 * A card's move and resize reach its body as counts in its context
 * (`geometry`), which the body's deck fires its lifecycle events from as
 * they rise: the same place the card learns its fold and its key state.
 *
 * @module bus/declarations/card
 */

import type { CardIdentityFacts } from "../../card-registry";
import type { CardMastheadPayload } from "../../lib/card-title-store";
import type { CrossingMirror } from "../../lib/fold-crossing";
import type { PaneTitleBarItem } from "../../lib/pane-title-bar-items-store";
import type { TelemetryInspection } from "../../lib/telemetry-inspection-store";
import { arr, bool, literal, nullable, num, obj, opaque, optional, rec, str } from "../codec";
import { defineSharedStore } from "../shared-store";

/** A card's place in the shell's deck, as its body reads it. */
export interface CardContextValue {
  folded: boolean;
  arriving: boolean;
  firstResponderCardId: string | null;
  layerShown: boolean;
  spaceId: string | null;
  /**
   * The deck edge a rail card stands pinned to. Absent for a card that is not
   * a pinned rail — a content card, or a rail dragged loose — which paints
   * the content surface; a pinned rail paints the rail's own.
   */
  railSide?: "left" | "right";
  /**
   * Present, and true, on a parked workspace's card that the workspace's
   * arrival will make key: its parked deck's first responder. A body treats
   * it as key for activation — an unbound Session card raises its picker
   * there, so a first visit finds it presented and claimed — without the
   * shell naming it first responder, which stays the shown workspace's.
   * Absent for every other card.
   */
  parkedKey?: true;
  /**
   * How many moves and resizes the shell's deck has committed for the card
   * since its body attached. A body fires `cardDidResize`, then `cardDidMove`,
   * for each that rose over the context before; the first context a page
   * reads sets the baseline and fires nothing.
   */
  geometry: CardGeometryCounts;
}

/** The counts of a card's committed moves and resizes, as `card.context` carries them. */
export interface CardGeometryCounts {
  moves: number;
  resizes: number;
}

/** No move and no resize yet. */
export const NO_CARD_GEOMETRY: CardGeometryCounts = { moves: 0, resizes: 0 };

/**
 * A rail width drag's hold on a card whose content cannot reflow in a frame
 * (`railReflow: "pause"`): lay the content out as if its frame stood `width`
 * layout px wide, anchored to the rail's outer edge (`side`), while the frame
 * itself follows the hand. The shell moves it to the frame's width when the
 * hand rests and clears it at the release (`rail-width-draft.ts`).
 */
export interface CardRailHold {
  side: "left" | "right";
  width: number;
}

export const cardRailHold = defineSharedStore<CardRailHold | null>({
  key: "card.railHold",
  owner: "shell",
  scope: { card: true },
  codec: nullable(obj({ side: literal("left", "right"), width: num })),
  initial: null,
});

/** The context before the shell's has arrived: an unfolded card, nobody key, its layer hidden. */
export const NO_CARD_CONTEXT: CardContextValue = {
  folded: false,
  arriving: false,
  firstResponderCardId: null,
  layerShown: false,
  spaceId: null,
  geometry: NO_CARD_GEOMETRY,
};

/**
 * The crossing the card's pane stands under — a fold, a settle's height
 * tween, a sash drag — written into the card's body so it holds its card
 * root through it, as the shell holds an in-document card's. `card.context`
 * names it in `after`, so a body that attaches reads its crossing first.
 */
export const cardCrossing = defineSharedStore<CrossingMirror | null>({
  key: "card.crossing",
  owner: "shell",
  scope: { card: true },
  codec: nullable(
    obj({
      still: nullable(num),
      settled: bool,
      width: bool,
      heightFree: bool,
      fold: nullable(num),
      held: rec(str),
    }),
  ),
  initial: null,
});

export const cardContext = defineSharedStore<CardContextValue>({
  key: "card.context",
  owner: "shell",
  scope: { card: true },
  after: [cardCrossing],
  codec: obj({
    folded: bool,
    arriving: bool,
    firstResponderCardId: nullable(str),
    layerShown: bool,
    spaceId: nullable(str),
    railSide: optional(literal("left", "right")),
    parkedKey: optional(opaque((v: unknown): v is true => v === true, true)),
    geometry: obj({ moves: num, resizes: num }),
  }),
  initial: NO_CARD_CONTEXT,
});

// ---- The card's own ----

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A card's masthead, as `cardTitleStore` holds one: anything with a `kind`. */
export const cardMasthead = opaque(
  (v: unknown): v is CardMastheadPayload => isRecord(v) && typeof v.kind === "string",
  { kind: "document-masthead" } as unknown as CardMastheadPayload,
);

/** What a card holds, as a live identity resolver answers it. */
export const cardIdentity = opaque(
  (v: unknown): v is CardIdentityFacts => isRecord(v) && typeof v.title === "string",
  { title: "" },
);

/** What a card shows the chrome about itself. */
export interface CardFactsValue {
  title: string;
  masthead: CardMastheadPayload | null;
  /** The session phase key `useSessionPhase` computes (`SessionPhaseKey`), or null with no session. */
  activity: string | null;
  /** What the card holds, as its own page's live identity resolver answers, or null. */
  identity: CardIdentityFacts | null;
  /** The controls the card contributes to its pane's title bar, each enabled as its own chain answers. */
  titleBar: PaneTitleBarItem[] | null;
  /** Whether the card's session is mid-turn. */
  canInterrupt: boolean;
  /** Whether the card's session has been compacted. */
  compacted: boolean;
}

export const cardFacts = defineSharedStore<CardFactsValue | null>({
  key: "card.facts",
  owner: "card",
  scope: { card: true },
  codec: nullable(
    obj({
      title: str,
      masthead: nullable(cardMasthead),
      activity: nullable(str),
      identity: nullable(cardIdentity),
      titleBar: nullable(
        arr(
          opaque((v: unknown): v is PaneTitleBarItem => isRecord(v) && typeof v.commandId === "string", {
            commandId: "",
          }),
        ),
      ),
      canInterrupt: bool,
      compacted: bool,
    }),
  ),
  initial: null,
});

/** What the chrome asks of the card synchronously at gesture time, and what holds it. */
export interface CardHoldsValue {
  /** The card's close advice: true when a close need not confirm. */
  waive: boolean;
  /** The card's fold guard: true when a fold may proceed. */
  guarded: boolean;
  /** Whether the card's close guard would ask, or null when it registered none. */
  closeGuardAsks: boolean | null;
  /** The modal run holding the card — `/compact` in flight — or null. */
  modalHold: { reason: string; admitsFold: boolean } | null;
  /** Whether a chord capture is armed in the card, which parks the host's menu bar. */
  captureArmed: boolean;
}

/** The holds before the card's page has said: the answers an in-shell card gives. */
export const NO_CARD_HOLDS: CardHoldsValue = {
  waive: false,
  guarded: true,
  closeGuardAsks: null,
  modalHold: null,
  captureArmed: false,
};

export const cardHolds = defineSharedStore<CardHoldsValue>({
  key: "card.holds",
  owner: "card",
  scope: { card: true },
  clearOnDetach: true,
  codec: obj({
    waive: bool,
    guarded: bool,
    closeGuardAsks: nullable(bool),
    modalHold: nullable(obj({ reason: str, admitsFold: bool })),
    captureArmed: bool,
  }),
  initial: NO_CARD_HOLDS,
});

/** The room the card asks of its pane: a sheet's floor, and the opening bid of an arriving card. */
export interface CardReservationsValue {
  sheetPx: number | null;
  openingBidPx: number | null;
}

export const cardReservations = defineSharedStore<CardReservationsValue>({
  key: "card.reservations",
  owner: "card",
  scope: { card: true },
  codec: obj({ sheetPx: nullable(num), openingBidPx: nullable(num) }),
  initial: { sheetPx: null, openingBidPx: null },
});

/**
 * A surface a body asks to have drawn over the deck: one that stands
 * outside its card's content box, which is all a body's viewport is. The
 * body keeps rendering it, hidden, and the overlay draws `html` — the
 * surface's content as the body rendered it — in a panel of `className`
 * hung off the line at `lineY`, centred on `anchorX`. Coordinates are the
 * body's viewport points. `scroll` is where each scroller in the content
 * stood when it was first drawn, by its child-index path. The shell hears it
 * as `card.surface` and relays it, with the card's rest geometry, as
 * `overlay.surfaces`.
 */
export interface CardSurface {
  title: string;
  className: string;
  growth: "up" | "down";
  anchorX: number;
  lineY: number;
  html: string;
  scroll: Array<{ path: number[]; top: number }>;
}

/** A {@link CardSurface} on the bus. */
export const cardSurfaceCodec = obj({
  title: str,
  className: str,
  growth: literal("up", "down"),
  anchorX: num,
  lineY: num,
  html: str,
  scroll: arr(obj({ path: arr(num), top: num })),
});

/** What the card raises past its content box — the Z2 placard — for the overlay to draw over the deck. */
export const cardSurface = defineSharedStore<CardSurface | null>({
  key: "card.surface",
  owner: "card",
  scope: { card: true },
  clearOnDetach: true,
  codec: nullable(cardSurfaceCodec),
  initial: null,
});

/** The card's first frame of content has gone to the compositor, set after the facts it was drawn with. */
export const cardPainted = defineSharedStore<boolean>({
  key: "card.painted",
  owner: "card",
  scope: { card: true },
  after: [cardFacts],
  clearOnDetach: true,
  codec: bool,
  initial: false,
});

/** The card's cold restore while the restore gate holds it: the turns loaded and asked for. */
export const cardRestoreHold = defineSharedStore<{ turnsLoaded: number; turnsTarget: number } | null>({
  key: "card.restoreHold",
  owner: "card",
  scope: { card: true },
  clearOnDetach: true,
  codec: nullable(obj({ turnsLoaded: num, turnsTarget: num })),
  initial: null,
});

/** A rail card's content height and what its scroller shows, for the shell's Resize Sidebars to Fit. */
export const cardContent = defineSharedStore<{ content: number; shown: number } | null>({
  key: "card.content",
  owner: "card",
  scope: { card: true },
  codec: nullable(obj({ content: num, shown: num })),
  initial: null,
});

/** Whether the card's page paints keyboard-focus mode, once its focus engine stands; null before. */
export const cardKbfPaint = defineSharedStore<boolean | null>({
  key: "card.kbfPaint",
  owner: "card",
  scope: { card: true },
  codec: nullable(bool),
  initial: null,
});

const inspection = nullable(
  opaque(
    (v: unknown): v is TelemetryInspection =>
      isRecord(v) && typeof v.cardId === "string" && isRecord(v.fields) && isRecord(v.state),
    { cardId: "", fields: {}, state: {} } as unknown as TelemetryInspection,
  ),
);

/** The card's session inspection, published while `card.inspected` says a devtools card follows it. */
export const cardInspection = defineSharedStore<TelemetryInspection | null>({
  key: "card.inspection",
  owner: "card",
  scope: { card: true },
  clearOnDetach: true,
  codec: inspection,
  initial: null,
});

// ---- The shell's, for the devtools card ----

/** Whether a devtools card follows the card, so it publishes its inspection. */
export const cardInspected = defineSharedStore<boolean>({
  key: "card.inspected",
  owner: "shell",
  scope: { card: true },
  codec: bool,
  initial: false,
});

/**
 * The inspection of the card a devtools card follows, or null when it follows
 * none that publishes. The shell sets the followed card's replica as it
 * stands, and a replica keeps its object until its value moves, so identity
 * is the change.
 */
export const devtoolsInspection = defineSharedStore<TelemetryInspection | null>({
  key: "devtools.inspection",
  owner: "shell",
  scope: { card: true },
  equals: (a, b) => a === b,
  codec: inspection,
  initial: null,
});
