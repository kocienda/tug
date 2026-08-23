/**
 * layouts-section.tsx — the Lens **Layout** section: the deck's layout picker.
 *
 * Every layout decision the deck has is made here, and the section asks them in
 * the two kinds they actually come in.
 *
 * **Deck-wide questions are rows.** Three of them, and only three: **Cards**
 * says how many the arrangement holds; **Layout** says how a slot resolves into
 * a place — `Fit`, where the cards share the band and crowd when it is narrow,
 * or `Flow`, where they keep their width and the deck runs past the edge; and
 * **Card Width** says how wide they read. They are enumerable and they are
 * about the whole deck, which is what the segmented-row idiom is good at.
 *
 * **Per-place questions are asked on the drawing.** Which edge a sidebar card
 * holds, and whether a slot or a rail stacks or splits, are facts about a place
 * the picture is already drawing — so they are stated and changed there, by
 * {@link LayoutPlaces}. This section used to re-describe each of them in a row
 * of its own: one per registered sidebar card, one per side, one per shared
 * slot, up to thirteen rows under a picture that had just drawn every one of
 * them. The reader's eye joined "Column 3" to the third block on every read,
 * the count grew with the deck, and the panel's height moved as cards did. The
 * marks cost none of that and scale sideways for free.
 *
 * The trade also closed a trap. The column rows were gated on a slot holding
 * two or more cards, on the argument that a column of one is already unsplit —
 * but membership churn PRESERVES an arrangement (`columnDrawsSplit`), so a slot
 * set to split and standing one card deep was invisible everywhere and
 * reachable from nowhere until a second card arrived and it resurfaced. A mark
 * is cheap enough to give every occupied place, so every occupied place has
 * one.
 *
 * All of it writes the deck's `imposition` record — so "where is the Lens" and
 * "how wide is a Session card" are layout questions answered beside the other
 * layout questions rather than in an app-wide preference somewhere else. The
 * sidebar side of it stays **registry-driven**: the cards that registered
 * `layoutRole: "sidebar"` are what the overlay offers, in registration order,
 * and a third one appears by registering with nothing to add in this file.
 *
 * The Cards axis has no *off*. One-up is the quietest arrangement rather than
 * the absence of one — a single anchor, which a card occupies only by being put
 * there — so the deck always stands under an imposition and every row's slot
 * picker is live from the first frame.
 *
 * The section draws the deck **once**: the plan at the top states the current
 * answers as a heading, and under that heading stands a scale picture of the
 * deck ({@link LayoutMiniature}). Every control below is a compact segmented group
 * (`TugChoiceGroup`) that writes the plan. The picture-per-option idiom this
 * replaced spent a full deck drawing on every option and asked the eye to
 * diff them; here the options are words and numerals, and the *plan* is where
 * an option shows what it would do — resting a pointer on a segment, or
 * standing the movement cursor on it, swaps the plan for that option's
 * arrangement, drawn tentative (hollow blocks) rather than committed (filled).
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
 * hover/cursor handlers only toggle DOM attributes to choose which layer
 * shows. A preview is ephemeral appearance, so no React state is involved in
 * showing one ([L06]); the layers themselves are semantic data — drawings of
 * the store's candidate arrangements — and re-render when the store moves.
 *
 * Laws: [L02] the imposition record enters React through `useSyncExternalStore`
 * on the deck store; [L03] the section's content declaration is a
 * `useLayoutEffect`; [L06] preview visibility is DOM attributes toggled in
 * event handlers and a `MutationObserver`, never React state; [L11] every
 * control emits `selectValue` through the responder chain, which this section
 * turns into `set-imposition` / `set-imposition-layout` / `set-content-width` /
 * `set-sidebar-side` / `set-rail-mode` dispatches; [L19] every control is a `TugChoiceGroup` and
 * every caption a `TugLabel`, composed rather than hand-rolled; [L30] the section never touches
 * the deck store — it goes through the command funnel like any other door.
 *
 * @module components/lens/sections/layouts-section
 */

import "./layouts-section.css";

import React, {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";
import { Columns3 } from "lucide-react";

import { registerLensSection } from "@/components/lens/lens-section-registry";
import type { LensSectionHost } from "@/components/lens/lens-section-registry";
import { setSectionContent } from "@/components/lens/lens-section-content";
import { LayoutMiniature } from "@/components/lens/layout-miniature";
import type { MiniatureRails } from "@/components/lens/layout-miniature";
import { LayoutPlaces } from "@/components/lens/layout-places";
import type {
  LayoutPlace,
  LayoutRailMember,
} from "@/components/lens/layout-places";
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
  isImpositionLayout,
  impositionLayout,
  isRailMode,
  isSidebarSide,
  railModeOf,
  sidebarSide,
  slotCount,
  DEFAULT_CONTENT_WIDTH,
  DEFAULT_IMPOSITION_KIND,
  DEFAULT_SIDEBAR_SIDE,
  type ContentWidth,
  type DeckImposition,
  type FlowSlotExtent,
  type ImpositionKind,
  type ColumnMode,
  type ImpositionLayout,
  type RailMode,
  type SidebarSide,
} from "@/lib/layout-imposer";
import {
  deckColumnsOf,
  deckFlowStrip,
  type DeckColumn,
} from "@/deck-store-selectors";
import type { DeckState } from "@/layout-tree";
import { LENS_CARD_ID } from "@/lib/lens-card-id";
import { TugLabel } from "@/components/tugways/tug-label";
import { TugChoiceGroup } from "@/components/tugways/tug-choice-group";
import type { TugChoiceItem } from "@/components/tugways/tug-choice-group";
import { useResponder } from "@/components/tugways/use-responder";
import type { ActionEvent } from "@/components/tugways/responder-chain";
import { TUG_ACTIONS } from "@/components/tugways/action-vocabulary";

/** This section's kind — its key in the section registry and section order. */
const SECTION_KIND = "layouts";

/** Stable `event.sender` per group, so the section's one `selectValue` handler
 *  can tell the axes apart. A sidebar group's sender carries the componentId it
 *  moves, which is how one handler serves however many sidebar cards register. */
const KIND_SENDER_ID = "lens-layouts-kind";
const LAYOUT_SENDER_ID = "lens-layouts-layout";
const WIDTH_SENDER_ID = "lens-layouts-width";
const SIDE_SENDER_PREFIX = "lens-layouts-side:";
const RAIL_SENDER_PREFIX = "lens-layouts-rail:";
const COLUMN_SENDER_PREFIX = "lens-layouts-column:";

/** Ids of the captions, so each group can point `aria-labelledby` at its own
 *  `TugLabel`. */
const KIND_CAPTION_ID = "lens-layouts-kind-caption";
const LAYOUT_CAPTION_ID = "lens-layouts-layout-caption";
const WIDTH_CAPTION_ID = "lens-layouts-width-caption";

/** The three rows' focus orders. Distinct, and declared rather than defaulted,
 *  because they are separate stops: sharing an order would give two groups one
 *  focus key ([Q12]) between them, and the engine resolves a key to exactly one
 *  stop — so the other would be unreachable by any addressed placement. Being
 *  separately ordered is also what makes them separate rows of the Lens's arrow
 *  plane, so a vertical arrow steps from one group to the next.
 *
 *  Three is the whole list, and fixed. The per-place rows this section used to
 *  grow — one per sidebar card, one per side, one per shared slot — needed
 *  their orders computed from a running count, and that arithmetic is gone with
 *  them: those questions are asked on the drawing now. */
const LAYOUTS_KIND_FOCUS_ORDER = 0;
const LAYOUTS_LAYOUT_FOCUS_ORDER = 1;
const LAYOUTS_WIDTH_FOCUS_ORDER = 2;

/** The picture's own stop. One stop for the whole drawing rather than one per
 *  mark: a stop per affordance would make Tab crawl the picture, and the marks
 *  are items within it exactly as a segmented group's segments are items within
 *  it. The order is a sort key rather than a count, so it is set past every row
 *  the section can grow — two stops sharing an order would share one focus key
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

/** The two arrangements a shared rail can stand under, in the order the control
 *  offers them — stack first, because stack is the default. */
const RAIL_MODES: readonly RailMode[] = ["stack", "split"];

const RAIL_MODE_LABELS: Record<RailMode, string> = {
  stack: "Stack",
  split: "Split",
};

/** The caption for a side's rail row. */
const RAIL_CAPTIONS: Record<SidebarSide, string> = {
  left: "Left Rail",
  right: "Right Rail",
};

/** The two arrangements a shared slot can stand under, in the order the control
 *  offers them — the same two words a rail takes, over the other kind of place. */
const COLUMN_MODES: readonly ColumnMode[] = ["stack", "split"];

const COLUMN_MODE_LABELS: Record<ColumnMode, string> = {
  stack: "Stack",
  split: "Split",
};

/** The caption for a slot's column row. One-based, matching the ⌘-digit chords
 *  and every other place the deck names a slot to the user. */
function columnCaption(slot: number): string {
  return `Column ${slot + 1}`;
}

/** A sidebar card the deck can place, as this section needs it. */
interface SidebarEntry {
  componentId: string;
  /** The card's own name — the caption for its position control. */
  title: string;
}

/**
 * Every card registered as a sidebar, in registration order.
 *
 * The registry is fixed by the time any Lens section renders (registration is a
 * boot step), so this is a plain read rather than store-observed state — there
 * is no moment at which a card registers behind a rendered Layouts section.
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

/** How many sidebar cards stand on each side. `override` places one card on a
 *  stated side regardless of the imposition — the rails a side preview draws. */
function railsOf(
  imposition: DeckImposition,
  sidebars: readonly SidebarEntry[],
  override?: { componentId: string; side: SidebarSide },
): MiniatureRails {
  const rails: MiniatureRails = {};
  for (const entry of sidebars) {
    const side =
      override !== undefined && override.componentId === entry.componentId
        ? override.side
        : sidebarSide(imposition, entry.componentId);
    rails[side] = (rails[side] ?? 0) + 1;
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

/** The deck's imposition record — every axis — straight from the store ([L02]). */
function useImposition(): DeckImposition {
  const deck = useDeck();
  return (
    deck?.imposition ?? {
      sidebars: { [LENS_CARD_ID]: { side: DEFAULT_SIDEBAR_SIDE } },
    }
  );
}

/**
 * The deck's occupied slots and how each one is arranged.
 *
 * The one place this section reads PANES rather than the imposition alone, and
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
 * unreachable from the Lens. It sat there until a second card arrived and
 * resurfaced as a surprise. The rails avoided exactly this trap by never gating
 * their rows on membership; the columns walked into it.
 */
function useDeckColumns(): readonly DeckColumn[] {
  const deck = useDeck();
  return useMemo(() => (deck === null ? [] : deckColumnsOf(deck)), [deck]);
}

/** The deck's live flow truth, in the three numbers the committed miniature
 *  draws from — see {@link useCommittedFlow}. */
interface CommittedFlow {
  offsetPx: number;
  bandPx: number;
  extents: readonly FlowSlotExtent[];
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
 * off the Lens's own DOM would agree with the deck's only by luck.
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
    const strip = deckFlowStrip(deck);
    if (strip === null) return null;
    const bandPx = store.getFlowBandWidth();
    if (bandPx === null || bandPx <= 0) return null;
    return {
      offsetPx: deck.flowOffset ?? 0,
      bandPx,
      extents: [...strip.extents]
        .sort(([a], [b]) => a - b)
        .map(([slot, width]) => ({ slot, width })),
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

/** Live collapsed summary: the active kind's label. The side is not summarized
 *  — the band has room for one fact and the arrangement is it. */
function LayoutsCollapsedSummary(): React.ReactElement {
  const { kind } = useImposition();
  return <>{KIND_LABELS[kind ?? DEFAULT_IMPOSITION_KIND]}</>;
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
  return layout === "flow" ? `${cards} — the deck scrolls` : cards;
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
}

/** The caption's values, with a muted separator between them and the first
 *  carrying the weight — the AI mixer's readout, worn by the Lens. */
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

function LayoutsSectionBody({
  host,
}: {
  host: LensSectionHost;
}): React.ReactElement {
  const imposition = useImposition();
  const kind = imposition.kind ?? DEFAULT_IMPOSITION_KIND;
  const contentWidth = imposition.contentWidth ?? DEFAULT_CONTENT_WIDTH;
  const layout = impositionLayout(imposition);
  const sidebars = sidebarEntries();
  const rails = railsOf(imposition, sidebars);
  const railModes: Partial<Record<SidebarSide, RailMode>> = {
    left: railModeOf(imposition, "left"),
    right: railModeOf(imposition, "right"),
  };
  // Every side that carries a rail at all — counted from the registrations the
  // miniature draws from rather than from what is open, so the picture and the
  // marks standing on it cannot disagree about how many cards a side holds.
  //
  // The overlay marks each of these and takes a press on each, so each needs
  // both of its proposals drawn: a side holding one card can still be SET to
  // split, and the picture has to be able to state what pressing it would do.
  const occupiedSides = SIDES.filter((side) => (rails[side] ?? 0) > 0);
  // The slots that can be arranged at all: two or more cards standing in one
  // place. A slot with one card is already unsplit, so it gets no row (see
  // `useDeckColumns`).
  const columns = useDeckColumns();
  // The committed drawing alone gets the live strip; every preview layer below
  // draws at rest ([P06]).
  const committedFlow = useCommittedFlow();
  const committedColumnOffsets = useCommittedColumnOffsets();
  // The arrangeable places, for the overlay that draws them on the picture.
  // Each carries its STORED arrangement and how many cards actually stand
  // there: the glyph is drawn from the first and dimmed by the second, and the
  // two come apart at exactly one card — which is the whole reason a place one
  // card deep still gets a mark.
  const columnPlaces: LayoutPlace[] = columns.map((column) => ({
    key: `col-${column.slot}`,
    slot: column.slot,
    mode: column.mode,
    members: column.members.length,
    label: columnCaption(column.slot),
    previewAxis: `columnmode:${column.slot}`,
    senderId: `${COLUMN_SENDER_PREFIX}${column.slot}`,
  }));
  const railPlaces: LayoutPlace[] = SIDES.filter(
    (side) => (rails[side] ?? 0) > 0,
  ).map((side) => ({
    key: `rail-${side}`,
    side,
    mode: railModes[side] ?? "stack",
    members: rails[side] ?? 0,
    label: RAIL_CAPTIONS[side],
    previewAxis: `railmode:${side}`,
    senderId: `${RAIL_SENDER_PREFIX}${side}`,
  }));
  // The sidebar cards themselves, with the edge each currently holds. The
  // drawing's rails are counts, which is all a picture needs; a control needs
  // to know WHICH card it would move.
  const railMembers: LayoutRailMember[] = sidebars.map((entry) => ({
    componentId: entry.componentId,
    title: entry.title,
    side: sidebarSide(imposition, entry.componentId),
    senderId: `${SIDE_SENDER_PREFIX}${entry.componentId}`,
    previewAxis: `side:${entry.componentId}`,
  }));
  /** Which slots the miniature draws divided, and into how many shares. */
  const columnSplits: Record<number, number> = {};
  for (const column of columns) {
    if (column.mode === "split" && column.members.length > 1) {
      columnSplits[column.slot] = column.members.length;
    }
  }

  // Every control reports selection by dispatching `selectValue` up the
  // responder chain ([L11]) — there are no change callbacks — so the section
  // hosts one responder and routes by sender.
  const { ResponderScope, responderRef } = useResponder({
    id: "lens-layouts-section",
    actions: {
      [TUG_ACTIONS.SELECT_VALUE]: (event: ActionEvent) => {
        const value = event.value;
        if (typeof value !== "string") return;
        const sender = event.sender;
        if (typeof sender === "string" && sender.startsWith(RAIL_SENDER_PREFIX)) {
          const side = sender.slice(RAIL_SENDER_PREFIX.length);
          if (isSidebarSide(side) && isRailMode(value)) {
            dispatchCommand(TUG_ACTIONS.SET_RAIL_MODE, { side, mode: value });
          }
          return;
        }
        if (
          typeof sender === "string" &&
          sender.startsWith(COLUMN_SENDER_PREFIX)
        ) {
          const slot = Number(sender.slice(COLUMN_SENDER_PREFIX.length));
          if (Number.isInteger(slot) && slot >= 0 && isColumnMode(value)) {
            dispatchCommand(TUG_ACTIONS.SET_COLUMN_MODE, { slot, mode: value });
          }
          return;
        }
        if (typeof sender === "string" && sender.startsWith(SIDE_SENDER_PREFIX)) {
          if (isSidebarSide(value)) {
            dispatchCommand(TUG_ACTIONS.SET_SIDEBAR_SIDE, {
              componentId: sender.slice(SIDE_SENDER_PREFIX.length),
              side: value,
            });
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

  // The picker is always present and always focusable, so the section is
  // always a navigable stop for the Cmd-L seed and the Tab walk.
  useLayoutEffect(() => {
    setSectionContent(host.focusGroup, { navigable: true, populated: true });
    return () =>
      setSectionContent(host.focusGroup, {
        navigable: false,
        populated: false,
      });
  }, [host.focusGroup]);

  // ---- The plan's preview switch ([L06]) ----
  //
  // Which layer shows is DOM attributes on the plan, toggled here: the layer
  // whose id matches gets `data-plan-active`, and the plan carries
  // `data-previewing` whenever one does (which is what hides the committed
  // layer). No React state — a preview is visible-only and lives exactly as
  // long as the pointer or cursor that asked for it.
  const planRef = useRef<HTMLDivElement | null>(null);
  const rowsRef = useRef<HTMLDivElement | null>(null);
  const figureRef = useRef<HTMLDivElement | null>(null);

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

  // The keyboard cursor previews the same way the pointer does: the engine
  // marks the ringed group `data-key-view-kbd` and the cursor segment
  // `data-key-cursor`, so an observer on those attributes resolves the
  // cursored segment to its preview id whenever either moves. Deferred
  // commit ([P24]) then reads: arrows audition arrangements in the plan,
  // Space makes one real.
  // Watched over the figure as well as the rows, because the picture is a stop
  // too: its marks carry the same `data-choice-value` a row's segments carry, so
  // an arrow that lands on one resolves through the same `previewIdOf` and
  // raises the same layer. One recompute across both roots — whichever of them
  // holds the ringed group is the one that answers, and only one can.
  useLayoutEffect(() => {
    const roots = [rowsRef.current, figureRef.current].filter(
      (el): el is HTMLDivElement => el !== null,
    );
    if (roots.length === 0) return;
    const recompute = () => {
      for (const root of roots) {
        const cursored = root.querySelector(
          "[data-key-view-kbd] [data-key-cursor][data-choice-value]",
        );
        if (cursored !== null) {
          setPreview(previewIdOf(cursored));
          return;
        }
      }
      setPreview(null);
    };
    const observer = new MutationObserver(recompute);
    for (const root of roots) {
      observer.observe(root, {
        subtree: true,
        attributes: true,
        attributeFilter: ["data-key-cursor", "data-key-view-kbd"],
      });
    }
    return () => observer.disconnect();
  }, [setPreview]);

  // ---- The layers: the committed plan and every offerable answer ----

  const committedCaption = [
    KIND_LABELS[kind],
    CONTENT_WIDTH_LABELS[contentWidth],
    ...(layout === "flow" ? [LAYOUT_LABELS[layout]] : []),
  ];

  // Every layer below draws the deck's CURRENT column arrangement unless it is
  // itself a column proposal — a preview changes one axis and states what the
  // others would keep. Folded in once, after the list, rather than repeated in
  // each literal.
  const layers: PlanLayer[] = [
    ...IMPOSITION_KINDS.map((k) => ({
      previewId: `kind:${k}`,
      caption: [KIND_LABELS[k], CONTENT_WIDTH_LABELS[contentWidth]],
      note: planNote(k, contentWidth, layout),
      kind: k,
      rails,
      railModes,
      width: contentWidth,
      layout,
    })),
    ...LAYOUTS.map((mode) => ({
      previewId: `layout:${mode}`,
      caption: [KIND_LABELS[kind], LAYOUT_LABELS[mode]],
      note: planNote(kind, contentWidth, mode),
      kind,
      rails,
      railModes,
      width: contentWidth,
      layout: mode,
    })),
    ...CONTENT_WIDTH_PRESETS.map((preset) => ({
      previewId: `width:${preset}`,
      caption: [KIND_LABELS[kind], CONTENT_WIDTH_LABELS[preset]],
      note: planNote(kind, preset, layout),
      kind,
      rails,
      railModes,
      width: preset,
      layout,
    })),
    ...sidebars.flatMap((entry) =>
      SIDES.map((side) => ({
        previewId: `side:${entry.componentId}:${side}`,
        caption: [`${entry.title} ${SIDE_LABELS[side]}`],
        // The arrangement is unchanged by a rail moving sides, so the note
        // stands as it is: the caption says what the preview would change,
        // the note what it would leave alone.
        note: planNote(kind, contentWidth, layout),
        kind,
        rails: railsOf(imposition, sidebars, {
          componentId: entry.componentId,
          side,
        }),
        railModes,
        width: contentWidth,
        layout,
      })),
    ),
    ...occupiedSides.flatMap((side) =>
      RAIL_MODES.map((mode) => ({
        previewId: `railmode:${side}:${mode}`,
        caption: [`${RAIL_CAPTIONS[side]} ${RAIL_MODE_LABELS[mode]}`],
        // Splitting a rail divides that side's run and leaves the cards'
        // band exactly as it was, so the note says what stands.
        note: planNote(kind, contentWidth, layout),
        kind,
        rails,
        railModes: { ...railModes, [side]: mode },
        width: contentWidth,
        layout,
      })),
    ),
  ].map((layer) => ({ ...layer, columnSplits }));

  // And one per column proposal: the slot divided, or made whole again. Every
  // occupied slot, not just the shared ones — a slot standing one card deep can
  // still be SET to split, and both of its proposals draw the same picture with
  // different captions, which is the honest statement that what would change is
  // the arrangement rather than what is on screen.
  for (const column of columns) {
    for (const mode of COLUMN_MODES) {
      layers.push({
        previewId: `columnmode:${column.slot}:${mode}`,
        caption: [
          `${columnCaption(column.slot)} ${COLUMN_MODE_LABELS[mode]}`,
        ],
        // Splitting a column divides that slot's run and leaves every card's
        // band exactly as it was, so the note says what stands.
        note: planNote(kind, contentWidth, layout),
        kind,
        rails,
        railModes,
        width: contentWidth,
        layout,
        columnSplits: {
          ...columnSplits,
          ...(mode === "split"
            ? { [column.slot]: column.members.length }
            : { [column.slot]: 1 }),
        },
      });
    }
  }

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

  return (
    <ResponderScope>
      <div
        className="layouts-section"
        data-testid="lens-layouts-section"
        ref={responderRef as (el: HTMLDivElement | null) => void}
      >
        {/* The figure: the drawing, and the places standing on it. They are
            siblings rather than nested because the drawing is `aria-hidden` —
            it is a picture of facts stated in words elsewhere — and an
            `aria-hidden` ancestor cannot be undone by a descendant, so an
            overlay inside it would hide its own buttons from assistive
            technology. The wrapper is what the overlay positions against.

            The pointer handlers live here, not on the drawing: hovering a mark
            shows the proposal it would commit, exactly as hovering a row's
            segment does. */}
        <div
          className="layouts-figure"
          ref={figureRef}
          onPointerOver={(event) =>
            setPreview(previewIdOf(event.target as Element))
          }
          onPointerLeave={() => setPreview(null)}
          onClick={() => setPreview(null)}
        >
        <div
          className="layouts-plan"
          data-testid="lens-layouts-plan"
          ref={planRef}
          aria-hidden="true"
        >
          <div className="layouts-plan-layer" data-plan-layer="committed">
            <div className="layouts-plan-summary">
              <PlanCaption values={committedCaption} />
              <span className="layouts-plan-note">
                {planNote(kind, contentWidth, layout)}
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
              slotExtents={committedFlow?.extents}
              columnOffsets={committedColumnOffsets ?? undefined}
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
              <LayoutMiniature
                kind={layer.kind}
                rails={layer.rails}
                railModes={layer.railModes}
                width={layer.width}
                layout={layer.layout}
                columnSplits={layer.columnSplits}
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
          flow={
            committedFlow === null
              ? null
              : {
                  bandPx: committedFlow.bandPx,
                  extents: committedFlow.extents,
                }
          }
          columns={columnPlaces}
          railPlaces={railPlaces}
          railMembers={railMembers}
          focusGroup={host.focusGroup}
          focusOrder={LAYOUTS_PLACES_FOCUS_ORDER}
        />
        </div>

        <div
          className="layouts-section-rows"
          ref={rowsRef}
          onPointerOver={(event) =>
            setPreview(previewIdOf(event.target as Element))
          }
          onPointerLeave={() => setPreview(null)}
          onClick={() => setPreview(null)}
        >
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
              focusGroup={host.focusGroup}
              focusOrder={LAYOUTS_KIND_FOCUS_ORDER}
              aria-labelledby={KIND_CAPTION_ID}
              data-testid="lens-layouts-kind"
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
              focusGroup={host.focusGroup}
              focusOrder={LAYOUTS_LAYOUT_FOCUS_ORDER}
              aria-labelledby={LAYOUT_CAPTION_ID}
              data-testid="lens-layouts-layout"
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
              focusGroup={host.focusGroup}
              focusOrder={LAYOUTS_WIDTH_FOCUS_ORDER}
              aria-labelledby={WIDTH_CAPTION_ID}
              data-testid="lens-layouts-width"
            />
          </div>

        </div>
      </div>
    </ResponderScope>
  );
}

/** Register the Layouts section. Called once at boot from `main.tsx`. */
export function registerLayoutsSection(): void {
  registerLensSection({
    kind: SECTION_KIND,
    title: "Layout",
    glyph: <Columns3 size={14} />,
    collapsedSummary: () => <LayoutsCollapsedSummary />,
    body: (host) => <LayoutsSectionBody host={host} />,
  });
}
