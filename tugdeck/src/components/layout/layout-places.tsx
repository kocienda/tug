/**
 * layout-places.tsx — the drawing's places, as things you can read and press.
 *
 * The Layout section draws the deck once, at scale, and used to re-describe it
 * underneath in a row per place: a Stack/Split row per shared slot. The
 * reader's eye joined "Column 3" to the third block in the
 * picture on every read, and the row count grew with the deck. This is the
 * other half of that trade: the picture states every per-place ARRANGEMENT
 * fact and takes every arrangement gesture, and the rows below it keep the
 * questions the picture cannot ask — the deck-wide axes, and each sidebar
 * card's presence and side. The schematic is about stack versus split;
 * placement is the rows' question, asked once, in words.
 *
 * **A place wears what it is SET to, not what it is showing.** A slot's glyph
 * reads `columnModeOf` — the stored arrangement. The blocks under them are
 * honest about what is on screen, and
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
 * **A place wears ONE mark, and it is Stack | Split.** It is the one question a
 * glyph can answer at a glance, and it is the only one a place still has: a
 * rail is always divided ([B01]) and so wears no mark at all.
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
 * **Every part of the drawing is a target, too.** Beneath the marks stands one
 * invisible target per column block, per split member and per rail member, at
 * the spans `miniatureGeometry` gives the drawing. The drawing is chrome at
 * rest; a target draws nothing until the hand is on it, and then lights the
 * part under it ([B11]). What a press on one does is not decided here: the
 * target reports itself through `onTargetPointerDown`, and the card's gesture
 * hook acts. The targets are `aria-hidden` and carry no `layout-card-place-`
 * testid, so the keyboard cursor, which walks the marks, never lands on one.
 *
 * Presentational: props in, CSS out, no store reads and no state ([L06]). The
 * section resolves every fact from its own subscription and hands them down.
 *
 * @module components/layout/layout-places
 */

import "./layout-places.css";

import React, {
  memo,
  useCallback,
  useId,
  useLayoutEffect,
  useRef,
} from "react";

import { deepEqual } from "@/lib/deep-equal";

import {
  miniatureGeometry,
  slideExpression,
  type MiniatureFlowStrip,
  type MiniatureRails,
} from "@/components/layout/layout-miniature";
import type { MiniatureTarget } from "@/components/layout/miniature-gestures";
import { registerGauge } from "@/lib/imposer-gauges";
import {
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
  PlaceAllocation,
  SidebarSide,
} from "@/lib/layout-imposer";

/**
 * One place in the deck that has an arrangement of its own: a numbered slot.
 *
 * A rail is not one of them. It is always divided ([B01]), so there is nothing
 * about its arrangement for a mark to state or a press to change; the picture
 * still leaves it its width, and the marks over the field stay where the
 * drawing beneath puts the blocks.
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
  /** The arrangement the deck has stored for this place. */
  mode: ColumnMode;
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
  /** The focus group the section authors this stop into. */
  focusGroup?: string;
  /** Order within {@link focusGroup} — the picture's place in the walk. */
  focusOrder?: number;
  /**
   * Render as a preview layer's inert readout instead of the live instrument:
   * plain glyphs, no buttons, no focus stop, no pointer.
   */
  ghost?: boolean;
  /** Which slots the drawing divides, and into how many members — the same
   *  prop the drawing beneath was given, so the targets land on its members. */
  columnSplits?: Readonly<Record<number, number>>;
  /** The committed columns' own divisions, as the drawing was given them. */
  columnAllocations?: Readonly<Record<number, PlaceAllocation | null>>;
  /** Each overflowing column's committed slide, as a fraction of the run. */
  columnOffsets?: Readonly<Record<number, number>>;
  /** Each split column's member pane ids, top to bottom, keyed by slot. */
  columnMembers?: Readonly<Record<number, readonly string[]>>;
  /** The committed rails' own divisions, as the drawing was given them. */
  railAllocations?: Partial<Record<SidebarSide, PlaceAllocation | null>>;
  /** Each side's rail members, in rail order. */
  railMembers?: Partial<
    Record<SidebarSide, readonly { componentId: string; paneId: string }[]>
  >;
  /** A hand landed on one of the drawing's parts. */
  onTargetPointerDown?: (
    event: React.PointerEvent<HTMLElement>,
    target: MiniatureTarget,
  ) => void;
  /** The flow window's grip, when the strip outruns its band. Rendered over
   *  the targets and under the marks ([P05]). */
  windowGrip?: React.ReactNode;
}

/**
 * The flow window's grip: four thin bands standing on the bracket's frame,
 * which take a drag that slides the band along the strip.
 *
 * Only the frame takes the hand. The grip's own box is `pointer-events: none`,
 * so a press in the middle of the window still lands on the block beneath it —
 * the window is a statement about what is in view, and its interior belongs to
 * the cards it frames.
 *
 * It stands where the drawing's bracket stands — the same `miniatureWindowRect`
 * — and rides the same `flow-offset` gauge with the same slide expression, so
 * it tracks a scrub, a wheel or its own drag without rendering.
 */
export function MiniatureWindowGrip({
  leftPct,
  widthPct,
  fraction,
  onPointerDown,
}: {
  leftPct: number;
  widthPct: number;
  fraction: number;
  onPointerDown?: (event: React.PointerEvent<HTMLElement>) => void;
}): React.ReactElement {
  const ref = useRef<HTMLSpanElement | null>(null);
  // [L03] — the gauge writes onto this element per frame; it is claimed in a
  // layout effect and released with it.
  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return;
    return registerGauge("flow-offset", el);
  }, []);
  return (
    <span
      ref={ref}
      className="layout-places-window"
      data-testid="layout-card-window-grip"
      aria-hidden="true"
      style={
        {
          left: `${leftPct}%`,
          width: `${widthPct}%`,
          "--mini-slide-x": slideExpression("flow-offset", fraction, 100),
        } as React.CSSProperties
      }
    >
      {(["left", "right", "top", "bottom"] as const).map((edge) => (
        <span
          key={edge}
          className="layout-places-window-edge"
          data-edge={edge}
          onPointerDown={onPointerDown}
        />
      ))}
    </span>
  );
}

/** The glyph a place's stored arrangement wears. Nothing is ever marked lit:
 *  the glyph is naming the arrangement, not a position within it. */
function PlaceGlyph({ mode }: { mode: ColumnMode }): React.ReactElement {
  return mode === "split" ? <SplitGlyph lit={null} /> : <StackGlyph lit={null} />;
}

/** The other of the two arrangements — what pressing this mark would set. */
function otherMode(mode: ColumnMode): ColumnMode {
  return mode === "split" ? "stack" : "split";
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
 *
 * It is memoized on its props BY VALUE. Every `LayoutPlaces` on
 * the Layout card — the live instrument and each preview — rebuilds its
 * `columns` whenever the arrangement moves, so a mark compared by identity
 * re-rendered on every change to any column: dividing one column re-rendered
 * all eighty-four marks, their glyphs and their buttons, three times over
 * inside the settle the division was animating through. Compared by value, a
 * mark renders when its own place changed.
 */
const PlaceMark = memo(function PlaceMark({
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
  return (
    <span
      className="layout-places-mark"
      data-place={place.key}
      data-mode={place.mode}
    >
      {ghost ? (
        <span className="layout-places-ghost-glyph" aria-hidden="true">
          <PlaceGlyph mode={place.mode} />
        </span>
      ) : (
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
      )}
    </span>
  );
}, deepEqual);

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
  focusGroup,
  focusOrder = 0,
  ghost = false,
  columnSplits,
  columnAllocations,
  columnOffsets,
  columnMembers,
  railAllocations,
  railMembers,
  onTargetPointerDown,
  windowGrip,
}: LayoutPlacesProps): React.ReactElement {
  const geometry = miniatureGeometry({
    kind,
    rails,
    width,
    layout,
    band,
    flow,
    columnSplits,
    columnAllocations,
    railAllocations,
  });

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

  /** Every affordance, in reading order — which is DOM order: the slots, left
   *  to right. */
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
  const marksSignature = columns.map((c) => `${c.key}:${c.mode}`).join(",");
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
  const columnOf = (slot: number): LayoutPlace | undefined =>
    columns.find((place) => place.slot === slot);

  /** A target's pointerdown, naming what it stands on. */
  const pressOf =
    (target: MiniatureTarget) =>
    (event: React.PointerEvent<HTMLElement>): void =>
      onTargetPointerDown?.(event, target);

  /** A side's width, held at the drawing's basis — the rail carries no mark,
   *  and the field's marks only land on the blocks if the picture's own flex
   *  row is replicated whole. It holds one target per member the drawing
   *  draws and the deck can name. */
  const rail = (side: SidebarSide): React.ReactElement | null => {
    const basis = geometry.rails[side];
    if (basis === undefined) return null;
    const members = railMembers?.[side] ?? [];
    return (
      <span
        className="layout-places-rail"
        data-side={side}
        data-overflow={basis.overflow ? "" : undefined}
        style={{ flexBasis: `${basis.basisPct}%` }}
      >
        {ghost
          ? null
          : basis.members
              .filter((span) => span.index < members.length)
              .map((span) => {
                const paneId = members[span.index].paneId;
                return (
                  <span
                    key={paneId}
                    className="layout-places-target"
                    data-target="rail"
                    data-side={side}
                    data-pane-id={paneId}
                    data-testid={`layout-card-target-rail-${side}-${span.index}`}
                    aria-hidden="true"
                    style={{
                      top: `${span.topPct}%`,
                      height: `${span.spanPct}%`,
                    }}
                    onPointerDown={pressOf({ kind: "rail", side, paneId })}
                  />
                );
              })}
      </span>
    );
  };

  /** One target per unsplit block, one per split member — beneath the marks,
   *  in a run that clips as the drawing's run does ([P05]). Slot order is
   *  paint order, so where fit laps two blocks the target on top is the card
   *  the reader can see. */
  const targets = ghost ? null : (
    <span className="layout-places-run">
      {geometry.blocks.map((block) => {
        if (block.members === undefined) {
          return (
            <span
              key={block.slot}
              className="layout-places-target"
              data-target="block"
              data-slot={block.slot}
              data-testid={`layout-card-target-block-${block.slot}`}
              aria-hidden="true"
              style={{
                left: `${block.leftPct}%`,
                width: `${block.widthPct}%`,
              }}
              onPointerDown={pressOf({ kind: "block", slot: block.slot })}
            />
          );
        }
        const ids = columnMembers?.[block.slot] ?? [];
        const slide = block.overflow
          ? (columnOffsets?.[block.slot] ?? 0) * 100
          : 0;
        return block.members.map((member) => {
          const paneId = ids[member.index];
          if (paneId === undefined) return null;
          return (
            <span
              key={`${block.slot}:${paneId}`}
              className="layout-places-target"
              data-target="member"
              data-slot={block.slot}
              data-pane-id={paneId}
              data-testid={`layout-card-target-member-${block.slot}-${member.index}`}
              aria-hidden="true"
              style={{
                left: `${block.leftPct}%`,
                width: `${block.widthPct}%`,
                top: `${member.topPct - slide}%`,
                height: `${member.spanPct}%`,
              }}
              onPointerDown={pressOf({
                kind: "member",
                slot: block.slot,
                paneId,
              })}
            />
          );
        });
      })}
    </span>
  );

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
        {targets}
        {ghost ? null : windowGrip}
        {geometry.blocks.map((block) => {
          const place = columnOf(block.slot);
          // Every slot draws its block, empty or not: the block is the part a
          // drag's zone for that slot stands on. Only a place carries a mark.
          return (
            <span
              key={block.slot}
              className="layout-places-block"
              data-slot={block.slot}
              style={{
                left: `${block.leftPct}%`,
                width: `${block.widthPct}%`,
              }}
            >
              {place === undefined ? null : (
                <PlaceMark
                  place={place}
                  senderId={place.senderId}
                  ghost={ghost}
                />
              )}
            </span>
          );
        })}
      </span>
      {rail("right")}
    </span>
  );
}
