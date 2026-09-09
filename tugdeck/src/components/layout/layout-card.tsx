/**
 * layout-card.tsx — the **Layout** card: the deck's layout picker.
 *
 * Every layout decision the deck has is made here, and the card asks them in
 * the two kinds they actually come in.
 *
 * **Deck-wide questions are rows.** **Cards** says how many the arrangement
 * holds; **Layout** says how a slot resolves into a place — `Fit`, where the
 * cards share the band and crowd when it is narrow, or `Flow`, where they keep
 * their width and the deck runs past the edge; and **Card Width** says how
 * wide they read. Under them, one row per REGISTERED sidebar card answers the
 * one question the picture cannot: `Off · Left · Right` — whether the card is
 * on the deck at all, and where. It cannot live on the drawing because the
 * drawing draws what is on screen, and a hidden card is exactly what is not;
 * its row is the one door that shows it. These row counts are fixed at boot
 * (the axes are enumerable, the registry is a boot step), so the card's
 * height never moves as cards do.
 *
 * **Arrangement questions are asked on the drawing.** Whether a slot or a rail
 * stacks or splits is a fact about a place the picture is already drawing — so
 * it is stated and changed there, by {@link LayoutPlaces}, and the schematic's
 * whole vocabulary is stack versus split. Placement is not the picture's
 * question: which side a card holds is asked once, in words, by its row above,
 * because the row can also say "not on the deck at all" and the picture cannot
 * press what it does not draw. This card used to re-describe every per-place
 * fact in a row of its own — one per side, one per shared slot, up to thirteen
 * rows under a picture that had just drawn every one of them — so the reader's
 * eye joined "Column 3" to the third block on every read, the count grew with
 * the deck, and the panel's height moved as cards did. The marks cost none of
 * that and scale sideways for free.
 *
 * The trade also closed a trap. The column rows were gated on a slot holding
 * two or more cards, on the argument that a column of one is already unsplit —
 * but membership churn PRESERVES an arrangement (`columnDrawsSplit`), so a slot
 * set to split and standing one card deep was invisible everywhere and
 * reachable from nowhere until a second card arrived and it resurfaced. A mark
 * is cheap enough to give every place the drawing draws, so every one of them
 * has one — every slot the kind defines, and every occupied side.
 *
 * All of it writes the deck's `imposition` record — so "which side does a rail
 * hold, if it is on the deck at all" and "how wide is a Session card" are
 * layout questions answered beside the other layout questions rather than in
 * an app-wide preference somewhere else. The
 * sidebar side of it stays **registry-driven**: the cards that registered
 * `layoutRole: "sidebar"` are what the overlay offers, in registration order,
 * and a third one appears by registering with nothing to add in this file.
 *
 * The Cards axis has no *off*. One-up is the quietest arrangement rather than
 * the absence of one — a single anchor, which a card occupies only by being put
 * there — so the deck always stands under an imposition and every row's slot
 * picker is live from the first frame.
 *
 * The card draws the deck **once**: the plan at the top states the current
 * answers as a heading, and under that heading stands a scale picture of the
 * deck ({@link LayoutMiniature}). Every control below is a compact segmented group
 * (`TugChoiceGroup`) that writes the plan. The picture-per-option idiom this
 * replaced spent a full deck drawing on every option and asked the eye to
 * diff them; here the options are words and numerals, and the *plan* is where
 * an option shows what it would do — standing the movement CURSOR on a segment
 * swaps the plan for that option's arrangement, drawn tentative (hollow
 * blocks) rather than committed (filled). A pointer asks for nothing: it moves
 * across controls on its way to the one it means, and a drawing that answered
 * every control it passed over restated the card's largest element while
 * the reader was only travelling. Pressing is how a hand changes the plan.
 *
 * The drawing itself is a readout and takes no pointer (`pointer-events: none`)
 * — it is drawn in chrome neutrals rather than the control palette, and the
 * hand that tries it finds nothing to press. What answers a hand is the places
 * overlay standing over it, which is a separate element for exactly that
 * reason: the picture states, the marks act, and the two never argue about
 * which one a click was meant for.
 *
 * The previews are pre-rendered: React renders one hidden plan layer per
 * offerable option from the same store read as the committed layer, and the
 * cursor observer only toggles DOM attributes to choose which layer shows. A
 * preview is ephemeral appearance, so no React state is involved in showing
 * one ([L06]); the layers themselves are semantic data — drawings of the
 * store's candidate arrangements — and re-render when the store moves.
 *
 * Laws: [L02] the imposition record enters React through `useSyncExternalStore`
 * on the deck store; [L03] the card's content declaration is a
 * `useLayoutEffect`; [L06] preview visibility is DOM attributes toggled in
 * event handlers and a `MutationObserver`, never React state; [L11] every
 * control emits `selectValue` through the responder chain, which this card
 * turns into `set-imposition` / `set-imposition-layout` / `set-content-width` /
 * `set-sidebar-side` / `set-rail-mode` dispatches; [L19] every control is a `TugChoiceGroup` and
 * every caption a `TugLabel`, composed rather than hand-rolled; [L30] the card never touches
 * the deck store — it goes through the command funnel like any other door.
 *
 * @module components/layout/layout-card
 */

import "./layout-card.css";

import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";

import { LayoutMiniature } from "@/components/layout/layout-miniature";
import type {
  MiniatureFlowSlot,
  MiniatureRails,
} from "@/components/layout/layout-miniature";
import { LayoutPlaces } from "@/components/layout/layout-places";
import { FlowStrip } from "@/components/layout/flow-strip";
import type { FlowStripTravel } from "@/components/layout/flow-strip";
import { raiseCard } from "@/focus-transfer";
import { miniatureGeometry } from "@/components/layout/layout-miniature";
import { flashSlot } from "@/lib/flash-pane-border";
import type { TugSlotState } from "@/components/tugways/tug-slot";
import type { LayoutPlace } from "@/components/layout/layout-places";
import { dispatchCommand } from "@/command-dispatch";
import { getAllRegistrations } from "@/card-registry";
import { getDeckStore } from "@/lib/deck-store-registry";
import {
  CONTENT_WIDTH_LABELS,
  CONTENT_WIDTH_PRESETS,
  CONTENT_WIDTH_PX,
  IMPOSITION_KINDS,
  isContentWidth,
  isImpositionKind,
  isColumnMode,
  columnModeOf,
  columnLayoutOf,
  isImpositionLayout,
  impositionLayout,
  isRailMode,
  isPlaceLayout,
  railLayoutOf,
  isSidebarSide,
  railModeOf,
  sidebarSide,
  clampSlot,
  slotCount,
  DEFAULT_CONTENT_WIDTH,
  DEFAULT_IMPOSITION_KIND,
  DEFAULT_SIDEBAR_SIDE,
  type ContentWidth,
  type DeckImposition,
  type ImpositionKind,
  type ColumnMode,
  type ImpositionLayout,
  type PlaceLayout,
  type RailMode,
  type SidebarSide,
  type PlaceAllocation,
} from "@/lib/layout-imposer";
import {
  deckColumnsOf,
  deckFlowStrip,
  deckSlotStrip,
  type DeckColumn,
  railAllocationOf,
} from "@/deck-store-selectors";
import type { DeckState } from "@/layout-tree";
import { CARDS_CARD_ID } from "@/lib/cards-card-id";
import { TugLabel } from "@/components/tugways/tug-label";
import { TugChoiceGroup } from "@/components/tugways/tug-choice-group";
import type { TugChoiceItem } from "@/components/tugways/tug-choice-group";
import { useResponder } from "@/components/tugways/use-responder";
import type { ActionEvent } from "@/components/tugways/responder-chain";
import { TUG_ACTIONS } from "@/components/tugways/action-vocabulary";
import { useCardAppetite } from "@/lib/card-appetite-store";
import { CARD_TITLE_BAR_HEIGHT } from "@/components/chrome/tug-pane";
import { LAYOUT_CARD_ID } from "@/lib/layout-card-id";

/** The card's focus group — every stop it offers lives here.
 *
 *  A card owns one group and every control inside it declares an order in
 *  that group, which is what makes the arrows step from row to row. The old rail card
 *  handed each band its own group; a card is the band now, so the group is a
 *  constant rather than a prop. */
const LAYOUT_FOCUS_GROUP = "layout-card";

/** Stable `event.sender` per group, so the card's one `selectValue` handler
 *  can tell the axes apart. A sidebar group's sender carries the componentId it
 *  moves, which is how one handler serves however many sidebar cards register. */
const KIND_SENDER_ID = "layout-card-kind";
const LAYOUT_SENDER_ID = "layout-card-layout";
const WIDTH_SENDER_ID = "layout-card-width";
const SIDE_SENDER_PREFIX = "layout-card-side:";

/**
 * The Layout card's appetite, box by box ([B01], [B02]).
 *
 * The card used to declare one number for the whole of itself, and that number
 * described the plate alone: it named the title bar, the drawing and the preset
 * strip, and said nothing about the caption above the drawing or the control
 * rows below it — which are most of the card. A rail that honoured it as a
 * ceiling therefore cut the rows off, which is exactly what it was asked to do.
 *
 * So the comfort height is the PLATE — everything above the first control row,
 * because the picture is the card's job and the rows under it may scroll — and
 * the natural height is that plus the rows, which is the only part that varies:
 * three deck-wide rows and one per registered sidebar card. Every term below
 * names the rule in `layout-card.css` it comes from, and none of them measures
 * anything at run time — a card that measured its own drawing to decide the box
 * the drawing is laid out in is the metric loop the previous brief's [B03]
 * refuses.
 */

/** `.layouts-section`'s own `padding: 6px 8px 8px`, block only. */
const LAYOUT_SECTION_PADDING_PX = 6 + 8;

/** `.layouts-plan-summary`: the caption at `--tugx-header-title-size` /
 *  `--tugx-header-title-lh` over the note at `--tug-font-size-sm` /
 *  `--tug-line-height-normal`, `--tug-space-sm` between them. */
const LAYOUT_CAPTION_PX = 42;

/** `.layouts-plan-layer`'s `gap: var(--tug-space-lg)`, which stands the summary
 *  off the drawing. */
const LAYOUT_SUMMARY_GAP_PX = 12;

/** The drawing: `--tugx-layouts-plan-mini-width` at `.layout-mini`'s
 *  `aspect-ratio: 16 / 10`. Both numbers are stated together in
 *  `layout-card.css`, beside the width knob, so tuning the width moves this. */
const LAYOUT_MINI_WIDTH_PX = 300;
const LAYOUT_DRAWING_PX = (LAYOUT_MINI_WIDTH_PX * 10) / 16;

/** `.layouts-plate`'s own `gap: 4px`, between the drawing and its legend. */
const LAYOUT_PLATE_GAP_PX = 4;

/** The preset strip: `.flow-strip`, one line of numbered segments inside its
 *  own `padding-inline: 3px` box and transparent border. */
const LAYOUT_STRIP_PX = 19;

/** `.layouts-section`'s `gap: 10px`, between the plate and the first control
 *  row. It belongs to comfort because it is air the plate has to stand in. */
const LAYOUT_SECTION_GAP_PX = 10;

/** One control row's pitch: the row's own 28px control against
 *  `.layouts-section-rows`'s `row-gap: 6px`. */
const LAYOUT_ROW_PITCH_PX = 28 + 6;

/** The rows that are there whatever the registry holds: Cards, Layout and Card
 *  Width. Every other row is one registered sidebar card. */
const LAYOUT_DECK_ROWS = 3;

/** Comfort: the plate, and nothing below it. */
const LAYOUT_COMFORT_HEIGHT_PX = Math.ceil(
  CARD_TITLE_BAR_HEIGHT +
    LAYOUT_SECTION_PADDING_PX +
    LAYOUT_CAPTION_PX +
    LAYOUT_SUMMARY_GAP_PX +
    LAYOUT_DRAWING_PX +
    LAYOUT_PLATE_GAP_PX +
    LAYOUT_STRIP_PX +
    LAYOUT_SECTION_GAP_PX,
);

/** Natural: comfort plus every control row the card will draw. */
function layoutNaturalHeightPx(sidebarCount: number): number {
  return (
    LAYOUT_COMFORT_HEIGHT_PX +
    LAYOUT_ROW_PITCH_PX * (LAYOUT_DECK_ROWS + sidebarCount)
  );
}
const RAIL_SENDER_PREFIX = "layout-card-rail:";
const COLUMN_SENDER_PREFIX = "layout-card-column:";

/** Ids of the captions, so each group can point `aria-labelledby` at its own
 *  `TugLabel`. */
const KIND_CAPTION_ID = "layout-card-kind-caption";
const LAYOUT_CAPTION_ID = "layout-card-layout-caption";
const WIDTH_CAPTION_ID = "layout-card-width-caption";

/** The three rows' focus orders. Distinct, and declared rather than defaulted,
 *  because they are separate stops: sharing an order would give two groups one
 *  focus key ([Q12]) between them, and the engine resolves a key to exactly one
 *  stop — so the other would be unreachable by any addressed placement. Being
 *  separately ordered is also what makes them separate rows of this card's arrow
 *  plane, so a vertical arrow steps from one group to the next.
 *
 *  Three is the whole list, and fixed. The per-place rows this card used to
 *  grow — one per sidebar card, one per side, one per shared slot — needed
 *  their orders computed from a running count, and that arithmetic is gone with
 *  them: those questions are asked on the drawing now.
 *
 *  A fourth stood here for a while: the slot window, how many places a Cards
 *  row draws around its card's own. It was the odd one — every other row
 *  states a DECK fact, and that one stated how the Cards card draws a fact — and the
 *  window settled at five, which is where it stays. The preference and the
 *  `set-slot-window` action it dispatched are untouched, so the size is still
 *  switchable; what is gone is a row asking the reader to choose in a card
 *  otherwise entirely about the deck. */
const LAYOUTS_KIND_FOCUS_ORDER = 0;
const LAYOUTS_LAYOUT_FOCUS_ORDER = 1;
const LAYOUTS_WIDTH_FOCUS_ORDER = 2;

/** The first sidebar row's order; each further registered card takes the next.
 *  These rows are the registry's size, which is fixed at boot — they list every
 *  sidebar card the deck HAS, open or not, because a hidden card's row is the
 *  one door that shows it. The deck-wide rows above never move. */
const LAYOUTS_FIRST_SIDEBAR_ROW_FOCUS_ORDER = 3;

/** The picture's own stop. One stop for the whole drawing rather than one per
 *  mark: a stop per affordance would make Tab crawl the picture, and the marks
 *  are items within it exactly as a segmented group's segments are items within
 *  it. The order is a sort key rather than a count, so it is set past every row
 *  the card can grow — two stops sharing an order would share one focus key
 *  ([Q12]) and the engine resolves a key to exactly one stop, leaving the other
 *  unreachable by any addressed placement. */
const LAYOUTS_PLACES_FOCUS_ORDER = 20;


/** User-facing label for each kind. */
const KIND_LABELS: Record<ImpositionKind, string> = {
  "one-up": "One Up",
  "two-up": "Two Up",
  "three-up": "Three Up",
  "four-up": "Four Up",
  "five-up": "Five Up",
  "six-up": "Six Up",
};

/** The two sides, in the order the control offers them. */
const SIDES: readonly SidebarSide[] = ["left", "right"];

/** The two geometry modes, in the order the control offers them — fit first,
 *  because it is what the deck has always done and what an unchosen deck is. */
const LAYOUTS: readonly ImpositionLayout[] = ["fit", "flow"];

/** User-facing label for each mode. Named for what the CARDS do, not for the
 *  mechanism: under "Fit" they share the band and crowd; under "Flow" they keep
 *  their width and the deck runs past the edge. */
const LAYOUT_LABELS: Record<ImpositionLayout, string> = {
  fit: "Fit",
  flow: "Flow",
};

const SIDE_LABELS: Record<SidebarSide, string> = {
  left: "Left",
  right: "Right",
};

/** The caption for a side's rail row. */
const RAIL_CAPTIONS: Record<SidebarSide, string> = {
  left: "Left Rail",
  right: "Right Rail",
};

/** The caption for a slot's column row. One-based, matching the ⌘-digit chords
 *  and every other place the deck names a slot to the user. */
function columnCaption(slot: number): string {
  return `Column ${slot + 1}`;
}

/** A sidebar card the deck can place, as this card needs it. */
interface SidebarEntry {
  componentId: string;
  /** The card's own name — the caption for its position control. */
  title: string;
}

/**
 * Every card registered as a sidebar, in registration order.
 *
 * The registry is fixed by the time this card renders (registration is a
 * boot step), so this is a plain read rather than store-observed state — there
 * is no moment at which a card registers behind a rendered picker.
 */
function sidebarEntries(): SidebarEntry[] {
  const entries: SidebarEntry[] = [];
  for (const [componentId, registration] of getAllRegistrations()) {
    if (registration.layoutRole !== "sidebar") continue;
    entries.push({
      componentId,
      title: registration.defaultMeta.title || componentId,
    });
  }
  return entries;
}

/**
 * How many sidebar cards stand on each side, counted from `entries` — which
 * the caller filters to the OPEN cards, so the picture draws what is actually
 * on screen. An earlier version counted every registered card, which drew a
 * closed Jots standing on the rail: a resting lie, and one that got worse the
 * moment show/hide controls stood next to it.
 *
 * `override` adjusts one card for a preview's sake: a stated side places it
 * there whether or not it is in `entries` (the drawing of "show it here" /
 * "move it here"), and `side: null` removes it (the drawing of "hide it").
 */
function railsFor(
  imposition: DeckImposition,
  entries: readonly SidebarEntry[],
  override?: { componentId: string; side: SidebarSide | null },
): MiniatureRails {
  const rails: MiniatureRails = {};
  for (const entry of entries) {
    if (override !== undefined && override.componentId === entry.componentId) {
      continue;
    }
    const side = sidebarSide(imposition, entry.componentId);
    rails[side] = (rails[side] ?? 0) + 1;
  }
  if (override !== undefined && override.side !== null) {
    rails[override.side] = (rails[override.side] ?? 0) + 1;
  }
  return rails;
}

/** The deck's whole snapshot, or `null` before the store exists ([L02]). */
function useDeck(): DeckState | null {
  const deckStore = getDeckStore();
  return useSyncExternalStore(
    deckStore?.subscribe ?? (() => () => {}),
    deckStore !== null ? deckStore.getSnapshot : () => null,
    () => null,
  );
}

/** The componentIds of the sidebar cards that are OPEN — presence is the open
 *  state ([P02]), so this is a read of the deck's card list ([L02]). */
function useOpenSidebarIds(): ReadonlySet<string> {
  const deck = useDeck();
  return useMemo(
    () => new Set((deck?.cards ?? []).map((card) => card.componentId)),
    [deck],
  );
}

/** The deck's imposition record — every axis — straight from the store ([L02]). */
function useImposition(): DeckImposition {
  const deck = useDeck();
  return (
    deck?.imposition ?? {
      sidebars: { [CARDS_CARD_ID]: { side: DEFAULT_SIDEBAR_SIDE } },
    }
  );
}

/**
 * The deck's occupied slots and how each one is arranged.
 *
 * The one place this card reads PANES rather than the imposition alone, and
 * it has to: how many cards share a slot is a fact about membership, and the
 * overlay's marks dim on it.
 *
 * Every occupied slot is returned, whatever its membership. An earlier version
 * offered a column control only for a slot holding two or more cards, arguing
 * that a column of one is already unsplit and has nothing to restore. That was
 * false, and the way it was false is the whole reason this overlay exists:
 * membership churn deliberately preserves the arrangement
 * (`columnDrawsSplit`), so a slot set to split and standing one card deep keeps
 * `mode: "split"` — invisible on every surface and, under that gate,
 * unreachable from any surface. It sat there until a second card arrived and
 * resurfaced as a surprise. The rails avoided exactly this trap by never gating
 * their rows on membership; the columns walked into it.
 */
function useDeckColumns(): readonly DeckColumn[] {
  const deck = useDeck();
  const store = getDeckStore();
  return useMemo(
    () =>
      deck === null
        ? []
        : deckColumnsOf(deck, store?.getColumnRunHeight() ?? null),
    [deck, store],
  );
}

/**
 * How the committed deck's places actually divide their runs — what the
 * committed miniature draws its member spans from ([P09]).
 *
 * Only the committed drawing gets them: a proposal is an arrangement nobody
 * has stood in, so its members have no heights to read and the miniature draws
 * the anonymous division instead.
 */
function useCommittedAllocations(columns: readonly DeckColumn[]): {
  rails: Partial<Record<SidebarSide, PlaceAllocation | null>>;
  columns: Record<number, PlaceAllocation | null>;
} {
  const deck = useDeck();
  const store = getDeckStore();
  return useMemo(() => {
    const railRun = store?.getRailRunHeight() ?? null;
    const bySlot: Record<number, PlaceAllocation | null> = {};
    for (const column of columns) bySlot[column.slot] = column.allocation;
    return {
      rails:
        deck === null
          ? {}
          : {
              left: railAllocationOf(deck, "left", railRun),
              right: railAllocationOf(deck, "right", railRun),
            },
      columns: bySlot,
    };
  }, [deck, store, columns]);
}

/** The deck's live flow truth, in the numbers the committed miniature draws
 *  from — see {@link useCommittedFlow}. */
interface CommittedFlow {
  offsetPx: number;
  bandPx: number;
  stripPx: number;
  slots: readonly MiniatureFlowSlot[];
}

/**
 * What the COMMITTED drawing needs to be an instrument rather than a readout:
 * how far the strip has slid, how wide the band it slid under is, and what each
 * occupied slot's extent is. `null` whenever the deck is not in flow — fit has
 * no strip and no window, and its cards tile the band whatever they are wide.
 *
 * The strip comes from `deckFlowStrip`, the deck's ONE resolution of it ([P09]),
 * so the picture and the frames it pictures cannot part company. The band is
 * asked of the store because it is a measurement of the canvas rather than a
 * fact in the snapshot; the store owns that measurement, and a second one taken
 * off this card's own DOM would agree with the deck's only by luck.
 *
 * Recomputed with the snapshot ([L02]). A canvas resize re-imposes through the
 * settled-resize retune, which commits and re-renders everything subscribed —
 * so the band follows the window without anything watching it per frame.
 */
function useCommittedFlow(): CommittedFlow | null {
  const deck = useDeck();
  const store = getDeckStore();
  return useMemo(() => {
    if (deck === null || store === null) return null;
    const bandPx = store.getBandWidth();
    if (bandPx === null) return null;
    const strip = deckSlotStrip(deck, bandPx);
    if (strip === null) return null;
    // The strip's own positions and its own length, not a re-derivation of
    // either. `deckSlotStrip` resolves both ([P09]) under whichever layout the
    // deck is in, and a drawing that laid the slots out itself would have to
    // assume something the deck owns — the gap between two of them in flow, the
    // band the travel is taken across in fit. Assuming the first is how the
    // picture came to show a slot cut off that was fully on screen; assuming
    // the second is how the picture came to jump when the layout toggled.
    return {
      offsetPx: deck.flowOffset ?? 0,
      bandPx,
      stripPx: strip.width,
      slots: [...strip.extents]
        .sort(([a], [b]) => a - b)
        .map(([slot, width]) => ({
          slot,
          leftPx: strip.positions.get(slot) ?? 0,
          widthPx: width,
        })),
    };
  }, [deck, store]);
}

/**
 * Each overflowing column's slide, as a fraction of the run — the vertical
 * half of what the committed drawing is told, and `null` when no column is
 * overflowing or the canvas has no run to measure against.
 *
 * A fraction rather than pixels for the reason the miniature's prop is one:
 * the drawing's field is the run at another scale, and the fraction is the one
 * number that crosses the scale change intact. Recomputed with the snapshot
 * ([L02]).
 */
function useCommittedColumnOffsets(): Readonly<
  Record<number, number>
> | null {
  const deck = useDeck();
  const store = getDeckStore();
  return useMemo(() => {
    const offsets = deck?.columnOffsets;
    if (deck === null || store === null || offsets === undefined) return null;
    const run = store.getColumnRunHeight();
    if (run === null) return null;
    const fractions: Record<number, number> = {};
    for (const [slot, px] of Object.entries(offsets)) {
      fractions[Number(slot)] = px / run;
    }
    return Object.keys(fractions).length === 0 ? null : fractions;
  }, [deck, store]);
}

/**
 * Everything the {@link FlowStrip} under the plan needs, or `null` when the
 * deck has no numbered places at all — a free deck, whose plan draws one block
 * and has nothing to number.
 *
 * The strip stands under fit as much as under flow; what the layout decides is
 * whether there is anywhere to TRAVEL, which is `travel` and nothing else. It
 * comes from `deckFlowStrip`, the deck's ONE resolution of it ([P09]) — the
 * same call {@link useCommittedFlow} makes for the picture — so the numbers and
 * the picture cannot part company.
 *
 * `states` is where the reader's own card is marked, and it is the one place
 * on the strip the accent is spent. `activePaneId` is the reading of "in"
 * that matters: it is what the pane chrome draws its active title bar from,
 * so the strip and the card agree about which card that is without either
 * asking the other. Not bullseye — that is a POSTURE a card is put into,
 * absent almost always, and a mark that only appeared during one would say
 * nothing the bullseye had not already said louder.
 *
 * **When the active pane holds no slot, the mark falls back to the FRONTMOST
 * pane that does**, and that fallback is what makes the instrument usable
 * where it now lives. In the canvas the strip could say "you are in no slot"
 * honestly, because a reader standing in a rail was a rare state. Standing in
 * a rail is not rare — pressing the strip itself activates this card's pane —
 * so a mark derived from the live active pane alone went blank the instant a
 * hand touched the thing it was marking on. The frontmost slotted pane is the
 * card the reader was in before they stepped into the panel, which is what
 * they mean by "my card" while they are looking at the picture of the deck.
 * Panes are z-ordered by array position, end highest, so the frontmost is the
 * last one carrying a slot.
 *
 * A deck with no slotted pane at all marks nothing, which is the honest
 * picture: there is no card in the arrangement to be in.
 */
function useStripInstrument(): {
  count: number;
  states: readonly TugSlotState[] | undefined;
  travel: FlowStripTravel | null;
} | null {
  const deck = useDeck();
  const store = getDeckStore();
  return useMemo(() => {
    if (deck === null || store === null) return null;
    const kind = deck.imposition.kind;
    if (kind === undefined) return null;
    const count = slotCount(kind);
    // Flow's half, and only flow's: `deckFlowStrip` is null under fit by
    // construction ([P09]), and a fit deck's band is the whole of it. Absent
    // here is what tells the strip there is nowhere to travel — it is not asked
    // which layout is on, because "is there travel" is the fact the gestures
    // actually turn on and the layout is only how it came to be true.
    const strip = deckFlowStrip(deck);
    const band = store.getBandWidth();
    const travel =
      strip === null || band === null || band <= 0
        ? null
        : { strip, band, offset: deck.flowOffset ?? 0 };
    const active = deck.panes.find((p) => p.id === deck.activePaneId);
    const standing =
      active?.slot !== undefined
        ? active
        : [...deck.panes].reverse().find((p) => p.slot !== undefined);
    const marked =
      standing?.slot === undefined
        ? undefined
        : clampSlot(kind, standing.slot);
    return {
      count,
      travel,
      states:
        marked === undefined
          ? undefined
          : Array.from({ length: count }, (_, slot) =>
              slot === marked ? "filled" : "rest",
            ),
    };
  }, [deck, store]);
}

/**
 * What an arrangement COMES TO, in plain words — the note under the caption.
 *
 * The caption names the answers (`Three Up · Slim`); this says what they mean
 * on screen, in the same voice the AI mixer's channel descriptions use. It is
 * the only place the width presets' actual measures are stated, so the note
 * earns its line rather than paraphrasing the caption: `Slim` is a name, `675
 * px` is the fact behind it.
 *
 * The card count is a DIGIT, matching the Cards control's own segments (`1 2 3
 * 4 5 6`) rather than the caption's spelled-out kind — the note reads as a
 * reading of the controls, which is what it is.
 */
function planNote(
  kind: ImpositionKind,
  width: ContentWidth,
  layout: ImpositionLayout = "fit",
  flowingRails: readonly SidebarSide[] = [],
): string {
  const slots = slotCount(kind);
  const px = CONTENT_WIDTH_PX[width];
  const cards =
    slots === 1
      ? `1 card at a time, ${px} px wide`
      : `${slots} cards side by side, ${px} px each`;
  // What the modes actually differ about, said once: fit spends the crowding
  // on overlap, flow spends it on the right edge. The clause is on flow only —
  // fit is the deck the reader already knows, and a note that explained both
  // would make the familiar answer look like a new choice.
  //
  // A flowing RAIL earns the same clause on the same terms ([B09]): the note's
  // tail names every thing on screen that scrolls, and a deck and a rail can
  // both be flowing at once, so the scrollers are listed rather than chosen
  // between. The band comes first because it is the larger thing.
  const scrollers = [
    ...(layout === "flow" ? ["the deck"] : []),
    ...flowingRails.map((side) => `the ${side} rail`),
  ];
  if (scrollers.length === 0) return cards;
  const named =
    scrollers.length === 1
      ? scrollers[0]
      : `${scrollers.slice(0, -1).join(", ")} and ${scrollers[scrollers.length - 1]}`;
  return `${cards} — ${named} scroll${scrollers.length === 1 ? "s" : ""}`;
}

/** One plan layer: a drawing, the caption naming it, and the note under it. */
interface PlanLayer {
  /** `axis:value` — the id a hovered/cursored segment resolves to. */
  previewId: string;
  /** The caption's values, in order — rendered with the separator between
   *  them, so the punctuation is the stylesheet's rather than the string's. */
  caption: readonly string[];
  /** What those values come to — see {@link planNote}. */
  note: string;
  kind: ImpositionKind;
  rails: MiniatureRails;
  /** How each side's rail is arranged in this drawing. */
  railModes: Partial<Record<SidebarSide, RailMode>>;
  width: ContentWidth;
  /** Which geometry this drawing stands under. */
  layout: ImpositionLayout;
  /** Which slots this drawing divides, and into how many shares. */
  columnSplits: Record<number, number>;
  /**
   * The marks this layer's drawing wears — the places overlay again, inert,
   * at THIS arrangement's geometry and modes. Without it a preview moved the
   * deck under a set of marks that stayed at the committed positions, so the
   * picture auditioned a change while its own legend flatly contradicted it.
   */
  ghost: {
    columns: readonly LayoutPlace[];
    railPlaces: readonly LayoutPlace[];
  };
}

/** The caption's values, with a muted separator between them and the first
 *  carrying the weight — the AI mixer's readout, worn here. */
function PlanCaption({
  values,
}: {
  values: readonly string[];
}): React.ReactElement {
  return (
    <span className="layouts-plan-caption">
      {values.map((value, index) => (
        <React.Fragment key={value}>
          {index > 0 && (
            // The spaces live in the text, not in a margin, so the caption
            // reads correctly when it is taken as a string.
            <span className="layouts-plan-caption-sep"> · </span>
          )}
          <span className="layouts-plan-caption-value">{value}</span>
        </React.Fragment>
      ))}
    </span>
  );
}

/**
 * The preview id a segment stands for, or `null` when the element is not a
 * previewable segment. The already-active segment resolves to `null` on
 * purpose: hovering the current answer shows the committed plan, not a
 * tentative copy of it.
 */
function previewIdOf(el: Element | null): string | null {
  const segment = el?.closest("[data-choice-value]") ?? null;
  if (segment === null) return null;
  if (segment.getAttribute("data-state") === "active") return null;
  const row = segment.closest("[data-preview-axis]");
  if (row === null) return null;
  return `${row.getAttribute("data-preview-axis")}:${segment.getAttribute(
    "data-choice-value",
  )}`;
}

/** The Layout card's props. The card id is the pane's, and the card has no
 *  use for it: every fact it reads is the deck's own, and every act it takes
 *  goes through the command funnel ([L30]). */
export interface LayoutContentProps {
  /** The Layout card's id. */
  cardId: string;
}

export function LayoutContent(
  _props: LayoutContentProps,
): React.ReactElement {
  const imposition = useImposition();
  const kind = imposition.kind ?? DEFAULT_IMPOSITION_KIND;
  const contentWidth = imposition.contentWidth ?? DEFAULT_CONTENT_WIDTH;
  const layout = impositionLayout(imposition);
  const sidebars = sidebarEntries();
  // What the card would like of its rail's run ([B02]). Comfort is the plate —
  // the picture is the card's job and the rows beneath it may scroll — and
  // natural is the plate plus every control row, which is the three deck-wide
  // ones and one per registered sidebar card. `sidebarEntries()` reads the
  // registry, which is fixed at boot, so this is a pure function of state and
  // the section's height does not move as cards come and go.
  useCardAppetite(
    LAYOUT_CARD_ID,
    LAYOUT_COMFORT_HEIGHT_PX,
    layoutNaturalHeightPx(sidebars.length),
  );
  // The open ones are what the picture draws and what the overlay marks;
  // the full registry is what the sidebar rows list, because a hidden card's
  // row is the door that shows it.
  const openSidebarIds = useOpenSidebarIds();
  const openSidebars = sidebars.filter((entry) =>
    openSidebarIds.has(entry.componentId),
  );
  const rails = railsFor(imposition, openSidebars);
  const railModes: Partial<Record<SidebarSide, RailMode>> = {
    left: railModeOf(imposition, "left"),
    right: railModeOf(imposition, "right"),
  };
  // …and each side's layout, which the mark reads beside the mode and the
  // note reads to say which thing scrolls ([B09]).
  const railLayouts: Partial<Record<SidebarSide, PlaceLayout>> = {
    left: railLayoutOf(imposition, "left"),
    right: railLayoutOf(imposition, "right"),
  };
  // Every occupied slot, whatever its membership (see `useDeckColumns` for
  // why one card deep still counts).
  const columns = useDeckColumns();
  // The committed places' own divisions, for the committed drawing alone.
  const committedAllocations = useCommittedAllocations(columns);
  // The sides whose run actually scrolls — read off the side's own STANDING
  // rather than off the layout it stores, because those are different facts
  // and this note is about the one on screen. A flowing rail stands as a strip
  // by choice; a fitting one whose floors do not fit its run stands as one by
  // arithmetic, and it reads as flowing on every face until a member leaves or
  // the window grows ([B07]). A stacked or empty side has no allocation at all
  // and so is never named: neither divides anything, and neither scrolls.
  const flowingRails: SidebarSide[] = SIDES.filter(
    (side) => committedAllocations.rails[side]?.standing === "overflow",
  );
  // The committed drawing alone gets the live strip; every preview layer below
  // draws at rest ([P06]).
  const committedFlow = useCommittedFlow();
  // The numbered strip that stands under the plan — the deck's arrangement as
  // something you can read a place off and press.
  const stripInstrument = useStripInstrument();
  // The plan's own geometry, handed to the strip whole: the room the rails
  // take, and where every block stands in what is left. The strip replicates
  // the drawing's flex row and places its segments at the drawing's own rects,
  // so a segment lands under the block that is the same card — by construction
  // rather than by two derivations agreeing. A second derivation would be off
  // by the padding, the gap, the flow scale and the seam at every size, which
  // is the drift `miniatureGeometry` exists to make impossible.
  const stripGeometry = useMemo(() => {
    const geometry = miniatureGeometry({
      kind,
      rails,
      width: contentWidth,
      layout,
      band: committedFlow?.bandPx,
      flow:
        committedFlow === null
          ? null
          : {
              bandPx: committedFlow.bandPx,
              stripPx: committedFlow.stripPx,
              slots: committedFlow.slots,
            },
    });
    const basis: Partial<Record<SidebarSide, number>> = {};
    for (const side of SIDES) {
      const rail = geometry.rails[side];
      if (rail !== undefined) basis[side] = rail.basisPct;
    }
    // Indexed by slot, because the strip draws one segment per place the kind
    // defines and the drawing's blocks carry their own slot. A place the
    // drawing does not draw gets no span and the segment stands undrawn.
    const spans: ({ left: number; width: number } | undefined)[] = Array.from(
      { length: slotCount(kind) },
      () => undefined,
    );
    for (const block of geometry.blocks) {
      if (block.slot < 0 || block.slot >= spans.length) continue;
      spans[block.slot] = {
        left: block.leftPct / 100,
        width: block.widthPct / 100,
      };
    }
    return { basis, spans };
  }, [kind, rails, contentWidth, layout, committedFlow]);

  // The strip's two writes, and the only place this card touches the deck
  // store rather than the command funnel. That is deliberate and narrow: a
  // scrub is per-frame appearance, which has no command to be ([L06]), and
  // the commit that follows it has to land the exact number the previews were
  // drawing. Both go through the store's own one writer ([P11]), so this card's
  // strip and the canvas's wheel cannot come to different answers.
  const previewFlow = useCallback((offset: number): void => {
    getDeckStore()?.previewFlowOffset(offset);
  }, []);

  // Go to slot N — one verb, two arrangements, and the arrangement decides
  // what going there is rather than whether the press does anything.
  //
  // With a `center` the deck TRAVELS: the place may be off the band, so the
  // band comes to it. Without one there is nowhere to travel — every place is
  // already on screen — so going to it is the raise: the card standing there
  // comes forward and takes the responder chain, exactly as a click on the
  // card itself would. An empty place raises nothing and that is not a
  // failure; the ring below still answers.
  //
  // And the arrival is ANSWERED either way. The slot the gesture NAMED is what
  // the deck rings — the pane's ring if a card stands there, the vacancy
  // badge's if the place is held open — which is the same answer the Center
  // Card chord gives, so a place named by hand and a place named by chord
  // reply in the same voice.
  const goToSlot = useCallback((slot: number, center: number | null): void => {
    const store = getDeckStore();
    if (store === null) return;
    if (center !== null) {
      store.setFlowOffset(center);
    } else {
      const pane = store.getSnapshot().panes.find((p) => p.slot === slot);
      if (pane !== undefined) raiseCard(store, pane.activeCardId);
    }
    flashSlot(store, slot);
  }, []);
  const committedColumnOffsets = useCommittedColumnOffsets();
  // The arrangeable places, for the overlay that draws them on the picture:
  // EVERY slot the kind defines, occupied or not, each carrying its STORED
  // arrangement. An arrangement outlives its membership all the way to zero,
  // so an empty slot can still hold a split, and the drawing draws the empty
  // block either way — a block with no mark reads as a hole in the instrument
  // rather than as a fact about the deck. Membership is deliberately not
  // passed down: the mark states the arrangement and nothing else, at one
  // weight for every place.
  const occupiedColumnOf = (slot: number): DeckColumn | undefined =>
    columns.find((column) => column.slot === slot);
  const columnPlaces: LayoutPlace[] = Array.from(
    { length: slotCount(kind) },
    (_, slot) => ({
      key: `col-${slot}`,
      slot,
      mode: occupiedColumnOf(slot)?.mode ?? columnModeOf(imposition, slot),
      layout: columnLayoutOf(imposition, slot),
      label: columnCaption(slot),
      senderId: `${COLUMN_SENDER_PREFIX}${slot}`,
    }),
  );
  /** The rail places a given pair of rail counts and modes comes to — used for
   *  the live overlay and again for every preview layer's ghost, so the two
   *  cannot disagree about what an occupied side is. */
  const railPlacesFor = (
    counts: MiniatureRails,
    modes: Partial<Record<SidebarSide, RailMode>>,
  ): LayoutPlace[] =>
    SIDES.filter((side) => (counts[side] ?? 0) > 0).map((side) => ({
      key: `rail-${side}`,
      side,
      mode: modes[side] ?? "stack",
      layout: railLayouts[side] ?? "fit",
      label: RAIL_CAPTIONS[side],
      senderId: `${RAIL_SENDER_PREFIX}${side}`,
    }));
  const railPlaces: LayoutPlace[] = railPlacesFor(rails, railModes);
  /** Which slots the miniature draws divided, and into how many shares. */
  const columnSplits: Record<number, number> = {};
  for (const column of columns) {
    if (column.mode === "split" && column.members.length > 1) {
      columnSplits[column.slot] = column.members.length;
    }
  }

  // Every control reports selection by dispatching `selectValue` up the
  // responder chain ([L11]) — there are no change callbacks — so the card
  // hosts one responder and routes by sender.
  const { ResponderScope, responderRef } = useResponder({
    id: "layout-card-section",
    actions: {
      [TUG_ACTIONS.SELECT_VALUE]: (event: ActionEvent) => {
        const value = event.value;
        if (typeof value !== "string") return;
        const sender = event.sender;
        if (typeof sender === "string" && sender.startsWith(RAIL_SENDER_PREFIX)) {
          const side = sender.slice(RAIL_SENDER_PREFIX.length);
          if (!isSidebarSide(side)) return;
          if (isRailMode(value)) {
            dispatchCommand(TUG_ACTIONS.SET_RAIL_MODE, { side, mode: value });
          } else if (isPlaceLayout(value)) {
            // The same sender carries both of a place's questions, told apart
            // by which vocabulary the value is in — `split`/`stack` against
            // `fit`/`flow`, which do not overlap. A second sender prefix would
            // be one more thing for the overlay and this responder to agree
            // about, for no fact the value does not already carry.
            dispatchCommand(TUG_ACTIONS.SET_RAIL_LAYOUT, { side, layout: value });
          }
          return;
        }
        if (
          typeof sender === "string" &&
          sender.startsWith(COLUMN_SENDER_PREFIX)
        ) {
          const slot = Number(sender.slice(COLUMN_SENDER_PREFIX.length));
          if (!Number.isInteger(slot) || slot < 0) return;
          if (isColumnMode(value)) {
            dispatchCommand(TUG_ACTIONS.SET_COLUMN_MODE, { slot, mode: value });
          } else if (isPlaceLayout(value)) {
            dispatchCommand(TUG_ACTIONS.SET_COLUMN_LAYOUT, { slot, layout: value });
          }
          return;
        }
        if (typeof sender === "string" && sender.startsWith(SIDE_SENDER_PREFIX)) {
          const componentId = sender.slice(SIDE_SENDER_PREFIX.length);
          // The sidebar rows say Off / Left / Right. A side on a hidden card
          // sets the side FIRST and then shows it, so the card appears where
          // the press said rather than appearing and hopping.
          if (value === "off") {
            dispatchCommand(TUG_ACTIONS.SET_SIDEBAR_OPEN, {
              componentId,
              open: false,
            });
          } else if (isSidebarSide(value)) {
            dispatchCommand(TUG_ACTIONS.SET_SIDEBAR_SIDE, {
              componentId,
              side: value,
            });
            if (!openSidebarIds.has(componentId)) {
              dispatchCommand(TUG_ACTIONS.SET_SIDEBAR_OPEN, {
                componentId,
                open: true,
              });
            }
          }
          return;
        }
        if (sender === WIDTH_SENDER_ID) {
          if (isContentWidth(value)) {
            dispatchCommand(TUG_ACTIONS.SET_CONTENT_WIDTH, { preset: value });
          }
          return;
        }
        if (sender === LAYOUT_SENDER_ID) {
          if (isImpositionLayout(value)) {
            dispatchCommand(TUG_ACTIONS.SET_IMPOSITION_LAYOUT, {
              layout: value,
            });
          }
          return;
        }
        if (sender === KIND_SENDER_ID && isImpositionKind(value)) {
          dispatchCommand("set-imposition", { kind: value });
        }
      },
    },
  });

  // ---- The plan's preview switch ([L06]) ----
  //
  // Which layer shows is DOM attributes on the plan, toggled here: the layer
  // whose id matches gets `data-plan-active`, and the plan carries
  // `data-previewing` whenever one does (which is what hides the committed
  // layer). No React state — a preview is visible-only and lives exactly as
  // long as the pointer or cursor that asked for it.
  const planRef = useRef<HTMLDivElement | null>(null);
  const rowsRef = useRef<HTMLDivElement | null>(null);

  const setPreview = useCallback((id: string | null) => {
    const plan = planRef.current;
    if (plan === null) return;
    let matched = false;
    for (const layer of plan.querySelectorAll("[data-plan-preview-id]")) {
      const on = id !== null && layer.getAttribute("data-plan-preview-id") === id;
      layer.toggleAttribute("data-plan-active", on);
      matched = matched || on;
    }
    plan.toggleAttribute("data-previewing", matched);
  }, []);

  // ---- The pointer does not preview ----
  //
  // Hovering a segment once raised that answer's layer in the drawing, on a
  // hover-intent clock — a beat before raising, a hold before dropping — to
  // keep a pointer crossing the rows from strobing the picture. The clock did
  // stop the strobe; it could not stop the thing underneath it, which is that
  // a pointer travelling to the control it means to press passes over three or
  // four others on the way, and the drawing answered every one of them. The
  // card's biggest, most detailed element restated itself repeatedly while
  // the reader was doing nothing but moving their hand toward a target.
  //
  // So the pointer states nothing. The drawing shows the deck as committed,
  // and a pointer changes it by pressing — which is the same rule the drawing
  // itself already obeys ("a statement of what the deck is doing"). The
  // KEYBOARD still auditions, because a movement cursor is not travel: it is
  // always ON a mark, it arrives one deliberate key at a time, and the arrows
  // are how a reader compares arrangements before Space makes one real ([P24]).
  //
  // The keyboard cursor previews the same way the pointer does: the engine
  // marks the ringed group `data-key-view-kbd` and the cursor segment
  // `data-key-cursor`, so an observer on those attributes resolves the
  // cursored segment to its preview id whenever either moves. Deferred
  // commit ([P24]) then reads: arrows audition arrangements in the plan,
  // Space makes one real.
  // Only the rows are watched. The picture is a stop too, but a mark is a
  // button rather than an audition, so a cursor standing on one asks the plan
  // for nothing — and the ring LEAVING a row still clears whatever that row
  // was auditioning, because losing `data-key-view-kbd` is itself a mutation
  // here.
  useLayoutEffect(() => {
    const root = rowsRef.current;
    if (root === null) return;
    const recompute = () => {
      const cursored = root.querySelector(
        "[data-key-view-kbd] [data-key-cursor][data-choice-value]",
      );
      setPreview(cursored === null ? null : previewIdOf(cursored));
    };
    const observer = new MutationObserver(recompute);
    observer.observe(root, {
      subtree: true,
      attributes: true,
      attributeFilter: ["data-key-cursor", "data-key-view-kbd"],
    });
    return () => observer.disconnect();
  }, [setPreview]);

  // ---- The layers: the committed plan and every offerable answer ----

  const committedCaption = [
    KIND_LABELS[kind],
    CONTENT_WIDTH_LABELS[contentWidth],
    ...(layout === "flow" ? [LAYOUT_LABELS[layout]] : []),
  ];

  // Every layer draws the deck's CURRENT column arrangement — a preview changes
  // one axis and states what the others would keep. Folded in once, after the
  // list, rather than repeated in each literal.
  //
  // The base ghost: the committed marks restated. Deck-wide previews (layout,
  // width) change no place, so their ghosts are the marks as they stand — at
  // the LAYER's geometry, which is the whole point: the marks travel with the
  // blocks they annotate.
  const baseGhost = { columns: columnPlaces, railPlaces };

  const layers: PlanLayer[] = [
    ...IMPOSITION_KINDS.map((k) => ({
      previewId: `kind:${k}`,
      caption: [KIND_LABELS[k], CONTENT_WIDTH_LABELS[contentWidth]],
      note: planNote(k, contentWidth, layout, flowingRails),
      kind: k,
      rails,
      railModes,
      width: contentWidth,
      layout,
      // A different kind reshuffles which cards share which slot, and that
      // redistribution is the imposer's to make — so the ghost claims nothing
      // about columns and keeps only the rails, which a kind change leaves
      // alone.
      ghost: { columns: [], railPlaces },
    })),
    ...LAYOUTS.map((mode) => ({
      previewId: `layout:${mode}`,
      caption: [KIND_LABELS[kind], LAYOUT_LABELS[mode]],
      note: planNote(kind, contentWidth, mode, flowingRails),
      kind,
      rails,
      railModes,
      width: contentWidth,
      layout: mode,
      ghost: baseGhost,
    })),
    ...CONTENT_WIDTH_PRESETS.map((preset) => ({
      previewId: `width:${preset}`,
      caption: [KIND_LABELS[kind], CONTENT_WIDTH_LABELS[preset]],
      note: planNote(kind, preset, layout, flowingRails),
      kind,
      rails,
      railModes,
      width: preset,
      layout,
      ghost: baseGhost,
    })),
    // One per registered sidebar card and side — registered, not open,
    // because the sidebar rows preview showing a hidden card. The layer's
    // rails place that card on the stated side whether or not it is open now,
    // and its ghost members do the same.
    ...sidebars.flatMap((entry) =>
      SIDES.map((side) => ({
        previewId: `side:${entry.componentId}:${side}`,
        caption: [`${entry.title} ${SIDE_LABELS[side]}`],
        // The arrangement is unchanged by a rail moving sides, so the note
        // stands as it is: the caption says what the preview would change,
        // the note what it would leave alone.
        note: planNote(kind, contentWidth, layout, flowingRails),
        kind,
        rails: railsFor(imposition, openSidebars, {
          componentId: entry.componentId,
          side,
        }),
        railModes,
        width: contentWidth,
        layout,
        // The rail marks travel with the placement: the destination side gains
        // one and the origin may lose its rail outright.
        ghost: {
          columns: columnPlaces,
          railPlaces: railPlacesFor(
            railsFor(imposition, openSidebars, {
              componentId: entry.componentId,
              side,
            }),
            railModes,
          ),
        },
      })),
    ),
    // And one per card for Off: the deck without it. For a card already
    // hidden this layer never shows — Off is then the active segment, and the
    // active answer previews as the committed plan — but building it
    // unconditionally keeps the list one shape.
    ...sidebars.map((entry) => {
      const counts = railsFor(imposition, openSidebars, {
        componentId: entry.componentId,
        side: null,
      });
      return {
        previewId: `side:${entry.componentId}:off`,
        caption: [`${entry.title} Off`],
        note: planNote(kind, contentWidth, layout, flowingRails),
        kind,
        rails: counts,
        railModes,
        width: contentWidth,
        layout,
        ghost: {
          columns: columnPlaces,
          railPlaces: railPlacesFor(counts, railModes),
        },
      };
    }),
  ].map((layer) => ({ ...layer, columnSplits }));

  // There is deliberately no layer per ARRANGEMENT proposal — no
  // `columnmode:<slot>:<mode>`, no `railmode:<side>:<mode>`. A layer exists to
  // be auditioned, and the marks that would raise those do not audition: a
  // mark is a two-state toggle whose effect is the glyph it wears, so hovering
  // one to see what it would do shows a picture the reader can already read
  // off the mark, and the marks stand close enough together that raising a
  // layer per crossing made the card strobe as the hand moved. The rows
  // still audition, because `Comfy` and `Flow` are words whose effect on the
  // deck is genuinely hard to picture.

  // ---- The rows: one compact segmented group per axis ----

  const kindItems: TugChoiceItem[] = IMPOSITION_KINDS.map((k) => ({
    value: k,
    label: String(slotCount(k)),
    "aria-label": KIND_LABELS[k],
    tooltip: KIND_LABELS[k],
  }));

  const layoutItems: TugChoiceItem[] = LAYOUTS.map((mode) => ({
    value: mode,
    label: LAYOUT_LABELS[mode],
  }));

  const widthItems: TugChoiceItem[] = CONTENT_WIDTH_PRESETS.map((preset) => ({
    value: preset,
    label: CONTENT_WIDTH_LABELS[preset],
  }));

  // One row per registered sidebar card: Off, or a side — show/hide and
  // placement as one question, because "where is it" and "is it there at all"
  // are the same axis with a zero. Tooltips state what is before what the
  // press would do.
  const sidebarRowItems = (entry: SidebarEntry): TugChoiceItem[] => {
    const open = openSidebarIds.has(entry.componentId);
    const side = sidebarSide(imposition, entry.componentId);
    return [
      {
        value: "off",
        label: "Off",
        tooltip: open ? `Hide ${entry.title}` : `${entry.title} is hidden`,
      },
      ...SIDES.map((s) => ({
        value: s,
        label: SIDE_LABELS[s],
        tooltip: !open
          ? `Show ${entry.title} on the ${s} edge`
          : side === s
            ? `${entry.title} is on the ${s} edge`
            : `Move ${entry.title} to the ${s} edge`,
      })),
    ];
  };

  return (
    <ResponderScope>
      <div
        className="layouts-section"
        data-testid="layout-card-section"
        ref={responderRef as (el: HTMLDivElement | null) => void}
      >
        {/* The figure: the drawing, and the places standing on it. They are
            siblings rather than nested because the drawing is `aria-hidden` —
            it is a picture of facts stated in words elsewhere — and an
            `aria-hidden` ancestor cannot be undone by a descendant, so an
            overlay inside it would hide its own buttons from assistive
            technology. The wrapper is what the overlay positions against.

            No pointer handlers here, and nothing watching for a cursor: the
            marks are buttons rather than auditions, so neither the hand nor the
            ring asks the plan for anything while it is on the picture. */}
      {/* The plate: the drawing and its legend, as one block. They are held
          together here rather than left to the card's own rhythm because
          the strip is the plan's legend and reads as one thing with it — the
          air between them has to be smaller than the air between the plate
          and the rows below. */}
      <div className="layouts-plate">
      <div className="layouts-figure">
        <div
          className="layouts-plan"
          data-testid="layout-card-plan"
          ref={planRef}
          aria-hidden="true"
        >
          <div className="layouts-plan-layer" data-plan-layer="committed">
            <div className="layouts-plan-summary">
              <PlanCaption values={committedCaption} />
              <span className="layouts-plan-note">
                {planNote(kind, contentWidth, layout, flowingRails)}
              </span>
            </div>
            <LayoutMiniature
              kind={kind}
              rails={rails}
              railModes={railModes}
              width={contentWidth}
              layout={layout}
              columnSplits={columnSplits}
              committed
              flowOffsetPx={committedFlow?.offsetPx}
              flowBandPx={committedFlow?.bandPx}
              flowStripPx={committedFlow?.stripPx}
              flowSlots={committedFlow?.slots}
              columnOffsets={committedColumnOffsets ?? undefined}
              railAllocations={committedAllocations.rails}
              columnAllocations={committedAllocations.columns}
            />
          </div>
          {layers.map((layer) => (
            <div
              className="layouts-plan-layer"
              data-plan-preview-id={layer.previewId}
              key={layer.previewId}
            >
              <div className="layouts-plan-summary">
                <PlanCaption values={layer.caption} />
                <span className="layouts-plan-note">{layer.note}</span>
              </div>
              {/* A proposal carries no places — nobody has stood the deck
                  under it — but it carries the BAND, because the band is a
                  measurement of the window and a preview does not change the
                  window. Without it a proposal would be drawn against a
                  nominal band and the committed drawing against the real one,
                  and the picture would jump on hover for the same reason it
                  used to jump on a layout toggle.

                  A rail preview is the one layer that would really move the
                  band, and it is drawn against the committed one anyway: what
                  the allocator would answer for a rail set nobody has stood
                  under is not knowable without running it. */}
              <LayoutMiniature
                kind={layer.kind}
                rails={layer.rails}
                railModes={layer.railModes}
                width={layer.width}
                layout={layer.layout}
                columnSplits={layer.columnSplits}
                flowBandPx={committedFlow?.bandPx}
              />
              {/* The layer's own marks, inert, at the layer's geometry — the
                  live overlay steps back while a preview shows, so the ghost
                  is the only legend on the auditioned drawing. */}
              <LayoutPlaces
                kind={layer.kind}
                rails={layer.rails}
                width={layer.width}
                layout={layer.layout}
                band={committedFlow?.bandPx}
                columns={layer.ghost.columns}
                railPlaces={layer.ghost.railPlaces}
                ghost
              />
            </div>
          ))}
        </div>

        {/* The places, over whichever layer is showing — anchored to the figure
            rather than mounted inside a layer, because the layers swap by
            `display` and a mark inside the committed one would vanish the
            moment its own hover raised a preview, un-hover itself, and
            oscillate. */}
        <LayoutPlaces
          kind={kind}
          rails={rails}
          width={contentWidth}
          layout={layout}
          band={committedFlow?.bandPx}
          flow={
            committedFlow === null
              ? null
              : {
                  bandPx: committedFlow.bandPx,
                  stripPx: committedFlow.stripPx,
                  slots: committedFlow.slots,
                }
          }
          columns={columnPlaces}
          railPlaces={railPlaces}
          focusGroup={LAYOUT_FOCUS_GROUP}
          focusOrder={LAYOUTS_PLACES_FOCUS_ORDER}
        />
      </div>

      {/* The strip: the plan's legend, at the plan's own geometry. The
          picture above draws which places there are and which of them the
          band is over; only this says WHICH place is which, and only this
          takes a press. It stands beside the figure rather than inside it
          because the places overlay is anchored to the figure's bottom edge,
          and a sibling inside it would put the marks on the numbers.

          Mounted whenever the plan has numbered places to legend — under fit
          as much as under flow, so the panel does not reflow under the very
          control that was pressed to change the layout. What the layout
          changes is what a press DOES, which is `travel`. */}
      {stripInstrument !== null ? (
        <FlowStrip
          count={stripInstrument.count}
          spans={stripGeometry.spans}
          rails={stripGeometry.basis}
          states={stripInstrument.states}
          travel={stripInstrument.travel}
          onPreview={previewFlow}
          onGoTo={goToSlot}
        />
      ) : null}
      </div>

        <div className="layouts-section-rows" ref={rowsRef}>
          <div className="layouts-section-row" data-preview-axis="kind">
            <TugLabel
              id={KIND_CAPTION_ID}
              size="md"
              emphasis="proposal"
              className="layouts-section-caption"
            >
              Cards
            </TugLabel>
            <TugChoiceGroup
              items={kindItems}
              value={kind}
              senderId={KIND_SENDER_ID}
              size="xs"
              sidePadding="xs"
              reselect
              focusGroup={LAYOUT_FOCUS_GROUP}
              focusOrder={LAYOUTS_KIND_FOCUS_ORDER}
              aria-labelledby={KIND_CAPTION_ID}
              data-testid="layout-card-kind"
            />
          </div>

          <div className="layouts-section-row" data-preview-axis="layout">
            <TugLabel
              id={LAYOUT_CAPTION_ID}
              size="md"
              emphasis="proposal"
              className="layouts-section-caption"
            >
              Layout
            </TugLabel>
            <TugChoiceGroup
              items={layoutItems}
              value={layout}
              senderId={LAYOUT_SENDER_ID}
              size="xs"
              sidePadding="xs"
              reselect
              focusGroup={LAYOUT_FOCUS_GROUP}
              focusOrder={LAYOUTS_LAYOUT_FOCUS_ORDER}
              aria-labelledby={LAYOUT_CAPTION_ID}
              data-testid="layout-card-layout"
            />
          </div>

          <div className="layouts-section-row" data-preview-axis="width">
            <TugLabel
              id={WIDTH_CAPTION_ID}
              size="md"
              emphasis="proposal"
              className="layouts-section-caption"
            >
              Card Width
            </TugLabel>
            <TugChoiceGroup
              items={widthItems}
              value={contentWidth}
              senderId={WIDTH_SENDER_ID}
              size="xs"
              sidePadding="xs"
              reselect
              focusGroup={LAYOUT_FOCUS_GROUP}
              focusOrder={LAYOUTS_WIDTH_FOCUS_ORDER}
              aria-labelledby={WIDTH_CAPTION_ID}
              data-testid="layout-card-width"
            />
          </div>

          {sidebars.map((entry, index) => {
            const captionId = `layout-card-sidebar-caption-${entry.componentId}`;
            const open = openSidebarIds.has(entry.componentId);
            return (
              <div
                className="layouts-section-row"
                data-preview-axis={`side:${entry.componentId}`}
                key={entry.componentId}
              >
                <TugLabel
                  id={captionId}
                  size="md"
                  emphasis="proposal"
                  className="layouts-section-caption"
                >
                  {entry.title}
                </TugLabel>
                <TugChoiceGroup
                  items={sidebarRowItems(entry)}
                  value={
                    open ? sidebarSide(imposition, entry.componentId) : "off"
                  }
                  senderId={`${SIDE_SENDER_PREFIX}${entry.componentId}`}
                  size="xs"
                  sidePadding="xs"
                  reselect
                  focusGroup={LAYOUT_FOCUS_GROUP}
                  focusOrder={LAYOUTS_FIRST_SIDEBAR_ROW_FOCUS_ORDER + index}
                  aria-labelledby={captionId}
                  data-testid={`layout-card-sidebar-${entry.componentId}`}
                />
              </div>
            );
          })}
        </div>
      </div>
    </ResponderScope>
  );
}
