/**
 * layout-places.tsx — the drawing's places, as things you can read and press.
 *
 * The Layout section draws the deck once, at scale, and used to re-describe it
 * underneath in a row per place: a rail row per side, a Stack/Split row per
 * shared slot. The reader's eye joined "Column 3" to the third block in the
 * picture on every read, and the row count grew with the deck. This is the
 * other half of that trade: the picture states every per-place ARRANGEMENT
 * fact and takes every arrangement gesture, and the rows below it keep the
 * questions the picture cannot ask — the deck-wide axes, and each sidebar
 * card's presence and side. The schematic is about stack versus split;
 * placement is the rows' question, asked once, in words.
 *
 * **A place wears what it is SET to, not what it is showing.** A slot's glyph
 * reads `columnModeOf` and a side's reads `railModeOf` — the stored
 * arrangement. The blocks under them are honest about what is on screen, and
 * the two come apart below two cards: membership churn preserves an
 * arrangement (`columnDrawsSplit`), so a slot set to split and standing one
 * card deep draws as one undivided block. Before this overlay that stored split
 * was invisible on every surface and unreachable from any of them — the column
 * rows were gated on `members.length > 1` — so it sat there until a second card
 * arrived and it resurfaced as a surprise. Every place therefore wears its
 * glyph at one weight, whatever stands under it, and stays pressable so the
 * arrangement can be put back. An earlier cut whispered the places with fewer
 * than two cards; two tints in one picture read as a rendering fault before
 * they read as a distinction, and the distinction was about membership, which
 * is not what a mark is for.
 *
 * **A mark is a button, and it behaves like one.** It answers a hand the way
 * every other control does — its own hover and its own press — and it does not
 * audition. The deck-wide rows swap the whole plan on hover because their
 * answers are hard to picture from a word (`Comfy`, `Flow`) and a wrong guess
 * costs a re-imposition; a mark's answer is a two-state toggle whose effect is
 * the glyph itself, and pressing it again undoes it. Auditioning it bought
 * nothing and cost the picture its composure: the marks stand a few pixels
 * apart, so a pointer crossing from one to the next raised a layer, dropped
 * back, and raised the next — the whole section strobing as the hand moved.
 *
 * **A mark's words state what is, then what the press does.** The glyph names
 * the stored arrangement to the eye; the tooltip names it in words and then
 * says what clicking changes — because a control whose label only names its
 * consequence leaves the reader to infer the present, and the present is the
 * harder half to read off a small glyph.
 *
 * **A split place wears TWO marks, and the second one is its layout.** Split
 * and stack answer "is this place divided"; fit and flow answer "does the
 * division fill the run, or run past it" ([B04]) — and the second question is
 * only asked of a place the first one already divided, so a stacked place
 * wears one mark and a split one wears the pair. They read together as
 * `Split · Fit`, which is why they stand side by side in one mark rather than
 * anywhere else on the card ([B09], [B10]): the layout is a fact about a
 * place's arrangement, and this is where a place's arrangement is decided.
 *
 * Each is the same two-state toggle the mode mark has always been, which is
 * the reason there are two of them rather than one three-state cycle: the
 * whole argument above for a mark behaving like a button rests on pressing it
 * again undoing it, and a cycle through three answers does not.
 *
 * **The geometry is not this component's opinion.** It replicates the drawing's
 * own flex row — the same padding, the same gap, the same rail flex-basis — and
 * places its parts from `miniatureGeometry`, the arithmetic the drawing itself
 * consumes. Positioning by fractions of the whole frame instead would be off by
 * the padding and the gaps at every size.
 *
 * **It stands outside the plan's layers, on purpose.** The layers swap by
 * `display`, so an overlay parked inside the committed one would vanish the
 * instant a row's hover raised a preview, and reappear when it cleared.
 * Anchored to the plan's box it stays put while the drawing beneath it
 * auditions a row's answer.
 *
 * **Ghost mode is the preview's copy of this readout.** A preview layer passes
 * `ghost`, and the overlay renders the same marks with no buttons, no focus
 * stop, and no pointer: it shows where the marks WOULD stand under that
 * layer's arrangement, which is what stops a row's preview from moving the
 * deck under a legend still standing at the committed geometry. The ghost
 * takes no events at all — the live overlay beneath keeps the hover that
 * raised the preview.
 *
 * Presentational: props in, CSS out, no store reads and no state ([L06]). The
 * section resolves every fact from its own subscription and hands them down.
 *
 * @module components/layout/layout-places
 */

import "./layout-places.css";

import React, {
  useCallback,
  useId,
  useLayoutEffect,
  useRef,
} from "react";

import {
  miniatureGeometry,
  type MiniatureFlowStrip,
  type MiniatureRails,
} from "@/components/layout/layout-miniature";
import {
  PlaceFitGlyph,
  PlaceFlowGlyph,
  SplitGlyph,
  StackGlyph,
} from "@/components/tugways/tug-column-badge";
import { TugIconButton } from "@/components/tugways/tug-icon-button";
import { TUG_ACTIONS } from "@/components/tugways/action-vocabulary";
import { useControlDispatch } from "@/components/tugways/use-control-dispatch";
import { useItemGroupKeyboard } from "@/components/tugways/use-item-group-keyboard";
import type {
  ColumnMode,
  ContentWidth,
  ImpositionKind,
  ImpositionLayout,
  PlaceLayout,
  RailMode,
  SidebarSide,
} from "@/lib/layout-imposer";

/**
 * One place in the deck that has an arrangement of its own: a numbered slot, or
 * a side's rail.
 *
 * `mode` is the STORED arrangement — deliberately not derived from what stands
 * there, which is exactly the conflation this overlay exists to undo. How many
 * cards a place holds is not carried at all: the mark states the arrangement
 * and nothing else, at one weight for every place.
 */
export interface LayoutPlace {
  /** Stable key — `col-<slot>` or `rail-<side>`. Also the affordance's testid. */
  key: string;
  /** Which numbered slot this is, for a column place. */
  slot?: number;
  /** Which edge this is, for a rail place. */
  side?: SidebarSide;
  /** The arrangement the deck has stored for this place. */
  mode: ColumnMode | RailMode;
  /** The layout the deck has stored for this place — meaningful only under
   *  split, and stored either way ([B05]), so the mark that reads it is drawn
   *  only when the place is divided. */
  layout: PlaceLayout;
  /** What to call it out loud: "Column 3", "Left rail". */
  label: string;
  /** The sender id the section's responder routes this place's presses by. */
  senderId: string;
}

export interface LayoutPlacesProps {
  /** The arrangement to place against — the same props the drawing was given. */
  kind: ImpositionKind | null;
  rails?: MiniatureRails;
  width?: ContentWidth;
  layout?: ImpositionLayout;
  /** The deck's band, in px — the same one the drawing beneath measures
   *  against, so the marks land on the blocks. */
  band?: number;
  /** The live places, when the drawing beneath is drawing them. */
  flow?: MiniatureFlowStrip | null;
  /** Every slot the kind defines, occupied or not — the drawing draws the
   *  empty ones too, and a drawn block with no mark reads as a hole in the
   *  instrument. An empty slot's stored arrangement is as real as a
   *  one-card slot's, and its mark is the door back to it. */
  columns: readonly LayoutPlace[];
  /** Every occupied side. */
  railPlaces: readonly LayoutPlace[];
  /** The focus group the section authors this stop into. */
  focusGroup?: string;
  /** Order within {@link focusGroup} — the picture's place in the walk. */
  focusOrder?: number;
  /**
   * Render as a preview layer's inert readout instead of the live instrument:
   * plain glyphs, no buttons, no focus stop, no pointer.
   */
  ghost?: boolean;
}

/** The glyph a place's stored arrangement wears. Nothing is ever marked lit:
 *  the glyph is naming the arrangement, not a position within it. */
function PlaceGlyph({ mode }: { mode: ColumnMode | RailMode }): React.ReactElement {
  return mode === "split" ? <SplitGlyph lit={null} /> : <StackGlyph lit={null} />;
}

/** The glyph a split place's stored LAYOUT wears: a division that ends at the
 *  foot of the run, or one that runs past it. */
function PlaceLayoutGlyph({ layout }: { layout: PlaceLayout }): React.ReactElement {
  return layout === "flow" ? <PlaceFlowGlyph /> : <PlaceFitGlyph />;
}

/** The other of the two arrangements — what pressing this mark would set. */
function otherMode(mode: ColumnMode | RailMode): ColumnMode | RailMode {
  return mode === "split" ? "stack" : "split";
}

/** The other of the two layouts — what pressing the layout mark would set. */
function otherLayout(layout: PlaceLayout): PlaceLayout {
  return layout === "flow" ? "fit" : "flow";
}

/**
 * A place's whole story, for its tooltip: what it is set to now, then what the
 * press does. Membership stays out of it — the dimmed weight already carries
 * "nothing standing under this yet", and a count in the sentence reads as an
 * apology for the arrangement rather than a statement of it.
 */
function describePlace(place: LayoutPlace): string {
  const now = place.mode === "split" ? "split" : "stacked";
  const does = place.mode === "split" ? "stack" : "split";
  return `${place.label} is ${now} — click to ${does}`;
}

/**
 * The layout mark's own story, in the same shape: what the run is doing now,
 * then what the press does. `fits` and `scrolls` rather than the words `fit`
 * and `flow`, because the tooltip is the one place there is room to say what
 * the two answers actually come to ([B09]) — the glyph beside it is already
 * carrying the name.
 */
function describeLayout(place: LayoutPlace): string {
  const now = place.layout === "flow" ? "scrolls" : "fits its run";
  const does = place.layout === "flow" ? "fit" : "flow";
  return `${place.label} ${now} — click to ${does}`;
}

/**
 * One place's mark: what the place is set to, and the press that sets it to the
 * other thing.
 *
 * The press does not command anything itself. It emits `selectValue` up the
 * responder chain carrying the PROPOSED arrangement and the sender id the
 * section's own responder already routes ([L11]) — the same ids the mixer rows
 * used, so the overlay slots into a funnel that was already there rather than
 * growing a second one beside it ([L30]).
 *
 * Carrying the proposal rather than the current value is what makes one control
 * enough for a two-valued fact: the press is always "make it the other thing",
 * so the same element goes each way and there is no segmented pair to keep in
 * sync with the glyph.
 */
function PlaceMark({
  place,
  senderId,
  ghost = false,
}: {
  place: LayoutPlace;
  /** The sender the section's responder routes this place by. */
  senderId: string;
  ghost?: boolean;
}): React.ReactElement {
  const proposed = otherMode(place.mode);
  const proposedLayout = otherLayout(place.layout);
  return (
    <span
      className="layout-places-mark"
      data-place={place.key}
      data-mode={place.mode}
      data-place-layout={place.mode === "split" ? place.layout : undefined}
    >
      {ghost ? (
        <>
          <span className="layout-places-ghost-glyph" aria-hidden="true">
            <PlaceGlyph mode={place.mode} />
          </span>
          {place.mode === "split" && (
            <span className="layout-places-ghost-glyph" aria-hidden="true">
              <PlaceLayoutGlyph layout={place.layout} />
            </span>
          )}
        </>
      ) : (
        <>
          <TugIconButton
            icon={<PlaceGlyph mode={place.mode} />}
            aria-label={describePlace(place)}
            title={describePlace(place)}
            size="sm"
            emphasis="ghost"
            senderId={senderId}
            dispatch={{
              action: TUG_ACTIONS.SELECT_VALUE,
              sender: senderId,
              value: proposed,
              phase: "discrete",
            }}
            data-testid={`layout-card-place-${place.key}`}
            data-choice-value={proposed}
            data-sender={senderId}
          />
          {place.mode === "split" && (
            // One sender for both marks: the value says which question is
            // being answered, because the two vocabularies do not overlap and
            // the section's responder can tell a mode word from a layout one
            // without a second routing prefix to keep in step with this one.
            <TugIconButton
              icon={<PlaceLayoutGlyph layout={place.layout} />}
              aria-label={describeLayout(place)}
              title={describeLayout(place)}
              size="sm"
              emphasis="ghost"
              senderId={senderId}
              dispatch={{
                action: TUG_ACTIONS.SELECT_VALUE,
                sender: senderId,
                value: proposedLayout,
                phase: "discrete",
              }}
              data-testid={`layout-card-place-${place.key}-layout`}
              data-choice-value={proposedLayout}
              data-sender={senderId}
            />
          )}
        </>
      )}
    </span>
  );
}

/**
 * LayoutPlaces — the deck's arrangeable places, drawn over the deck's picture.
 */
export function LayoutPlaces({
  kind,
  rails = {},
  width,
  layout = "fit",
  band,
  flow = null,
  columns,
  railPlaces,
  focusGroup,
  focusOrder = 0,
  ghost = false,
}: LayoutPlacesProps): React.ReactElement {
  const geometry = miniatureGeometry({ kind, rails, width, layout, band, flow });

  // ---- One stop, a cursor over its places ([P24] deferred commit) ----
  //
  // The picture is ONE stop in the Tab walk, not one per mark: a stop per
  // affordance would make Tab crawl the drawing, and the same rule already
  // holds for every segmented row in this section. Arrows move a cursor over
  // the marks — appearance projected straight to the DOM, no re-render ([L06])
  // — and Space commits the one under it. The cursor wears the mark's own
  // hover appearance, which is the whole of what standing on a mark means: the
  // press is what changes the deck, here as under the pointer.
  //
  // A ghost registers nothing: it is a drawing of marks, not marks.
  const rootId = useId();
  const rootRef = useRef<HTMLSpanElement | null>(null);
  const { dispatch } = useControlDispatch();

  /** Every affordance, in reading order — which is DOM order: the left rail's
   *  arrangement, the slots left to right, then the right rail's. */
  const affordances = useCallback((): Element[] => {
    const root = rootRef.current;
    if (root === null) return [];
    return Array.from(
      root.querySelectorAll('[data-testid^="layout-card-place-"]'),
    );
  }, []);

  /**
   * Commit whatever the cursor is standing on.
   *
   * The element carries both halves of its own act — the sender that routes it
   * and the value it proposes — so this needs no table mapping marks to
   * commands, and the keyboard and the pointer cannot come to disagree about
   * what a given mark does.
   */
  const commitAt = useCallback(
    (element: Element | null) => {
      const sender = element?.getAttribute("data-sender");
      const value = element?.getAttribute("data-choice-value");
      if (sender === null || sender === undefined) return;
      if (value === null || value === undefined) return;
      dispatch({
        action: TUG_ACTIONS.SELECT_VALUE,
        sender,
        value,
        phase: "discrete",
      });
    },
    [dispatch],
  );

  const { attachRoot, onKeyDown, syncItems } = useItemGroupKeyboard({
    id: rootId,
    group: focusGroup ?? "",
    order: focusOrder,
    register: !ghost && focusGroup !== undefined,
    collectItems: affordances,
    initialIndex: () => 0,
    onSelect: (element) => commitAt(element),
  });

  // The mark set changes with the deck — a slot gains a card, a side empties —
  // so the cursor's range is re-read whenever the drawing does.
  const marksSignature = `${columns.map((c) => `${c.key}:${c.mode}:${c.layout}`).join(",")}|${railPlaces
    .map((r) => `${r.key}:${r.mode}:${r.layout}`)
    .join(",")}`;
  useLayoutEffect(() => {
    syncItems();
  }, [marksSignature, syncItems]);

  const setRootRef = useCallback(
    (node: HTMLSpanElement | null) => {
      rootRef.current = node;
      attachRoot(node);
    },
    [attachRoot],
  );
  const railOf = (side: SidebarSide): LayoutPlace | undefined =>
    railPlaces.find((place) => place.side === side);
  const columnOf = (slot: number): LayoutPlace | undefined =>
    columns.find((place) => place.slot === slot);

  const rail = (side: SidebarSide): React.ReactElement | null => {
    const basis = geometry.rails[side];
    const place = railOf(side);
    if (basis === undefined || place === undefined) return null;
    return (
      <span
        className="layout-places-rail"
        style={{ flexBasis: `${basis.basisPct}%` }}
      >
        <PlaceMark place={place} senderId={place.senderId} ghost={ghost} />
      </span>
    );
  };

  return (
    <span
      className={ghost ? "layout-places layout-places-ghost" : "layout-places"}
      data-layout={layout}
      data-testid={
        ghost ? "layout-card-places-ghost" : "layout-card-places"
      }
      ref={ghost ? undefined : setRootRef}
      tabIndex={!ghost && focusGroup !== undefined ? 0 : undefined}
      onKeyDown={ghost ? undefined : onKeyDown}
    >
      {rail("left")}
      <span className="layout-places-field">
        {geometry.blocks.map((block) => {
          const place = columnOf(block.slot);
          if (place === undefined) return null;
          return (
            <span
              key={block.slot}
              className="layout-places-block"
              style={{
                left: `${block.leftPct}%`,
                width: `${block.widthPct}%`,
              }}
            >
              <PlaceMark place={place} senderId={place.senderId} ghost={ghost} />
            </span>
          );
        })}
      </span>
      {rail("right")}
    </span>
  );
}
