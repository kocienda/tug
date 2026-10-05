/**
 * layout-places.tsx — the drawing's places, as things you can read and press.
 *
 * Two components, one on the picture and one under it.
 *
 * **{@link LayoutPlaces} stands on the drawing** and makes every part of it a
 * target: one invisible target per column block, per split member and per
 * rail member, at the spans `miniatureGeometry` gives the drawing. The drawing
 * is chrome at rest; a target draws nothing until the hand is on it, and then
 * lights the part under it. What a press does is not decided here: the target
 * reports itself through `onTargetPointerDown`, and the card's gesture hook
 * acts. Each target also carries the card's own hover — what it is, whose
 * session it is, where it stands, and what a press does — built by the section
 * through `tipFor`, so this file stays free of the stores that answer it.
 *
 * **{@link LayoutPlaceToggles} stands under the numbered strip** and holds each
 * slot's stack/split toggle, one under each number. The toggles used to stand
 * at the foot of each block, on the drawing — where the place is, but where
 * they competed with everything else a block tried to say, and once the blocks
 * began to wear the card's face there was nothing left for the mark to stand
 * on. Under the strip the eye runs number → arrangement down one vertical, at
 * the strip's own geometry, so each toggle still lands under the block it
 * belongs to.
 *
 * **A toggle wears what its slot is SET to, not what it is showing.** A slot's
 * glyph reads `columnModeOf` — the stored arrangement. The blocks are honest
 * about what is on screen, and the two come apart below two cards: membership
 * churn preserves an arrangement (`columnDrawsSplit`), so a slot set to split
 * and standing one card deep draws as one undivided block. Every slot therefore
 * wears its glyph at one weight, whatever stands in it, and stays pressable so
 * the arrangement can be put back.
 *
 * **A toggle is a button, and it behaves like one.** It answers a hand the way
 * every other control does and does not audition: its answer is a two-state
 * toggle whose effect is the glyph itself, and pressing it again undoes it.
 * Its words state what is, then what the press does.
 *
 * **The geometry is not this file's opinion.** The overlay replicates the
 * drawing's own flex row and the toggle row replicates the strip's, and both
 * place their parts from `miniatureGeometry` — the arithmetic the drawing and
 * the strip themselves consume.
 *
 * **The overlay stands outside the plan's layers, on purpose.** The layers swap
 * by `display`, so an overlay parked inside the committed one would vanish the
 * instant a row's cursor raised a preview. Anchored to the plan's box it stays
 * put, and stands its targets down while a preview shows.
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
import { TugTooltip } from "@/components/tugways/tug-tooltip";
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
 * about its arrangement for a toggle to state or a press to change.
 *
 * `mode` is the STORED arrangement — deliberately not derived from what stands
 * there, which is exactly the conflation the toggles exist to undo.
 */
export interface LayoutPlace {
  /** Stable key — `col-<slot>`. Also the toggle's testid. */
  key: string;
  /** Which numbered slot this is. */
  slot?: number;
  /** The arrangement the deck has stored for this place. */
  mode: ColumnMode;
  /** What to call it out loud: "Column 3". */
  label: string;
  /** The sender id the section's responder routes this place's presses by. */
  senderId: string;
}

/** How long a target waits before it answers a hover. Shorter than the app's
 *  label default: a reader scanning a picture of their deck is asking "what is
 *  this one", card after card, and a near-second delay per card made the
 *  scan a wait. */
const TARGET_TIP_DELAY_MS = 450;

export interface LayoutPlacesProps {
  /** The arrangement to place against — the same props the drawing was given. */
  kind: ImpositionKind | null;
  rails?: MiniatureRails;
  width?: ContentWidth;
  layout?: ImpositionLayout;
  /** The deck's band, in px — the same one the drawing beneath measures
   *  against, so the targets land on the blocks. */
  band?: number;
  /** The live places, when the drawing beneath is drawing them. */
  flow?: MiniatureFlowStrip | null;
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
  /**
   * The hover for one part: what card stands there and what a press on it
   * does. Called at render with the target's identity, and expected to return
   * an element whose subscriptions live inside it — the bubble mounts its
   * content only while it is open, so a closed tooltip costs nothing. `null`
   * gives the part no tooltip.
   */
  tipFor?: (target: MiniatureTarget) => React.ReactNode;
  /** The flow window's grip, when the strip outruns its band. Rendered over
   *  the targets ([P05]). */
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

/**
 * One target, wearing its card's hover when the section has one to give.
 *
 * The tooltip wraps the target element itself (Radix `asChild`), so the hover
 * area is exactly the part the hand lit, and its pointerdown still reaches the
 * gesture hook — the bubble's own press handling composes with it and closes
 * the bubble as a drag or a press begins.
 */
function Target({
  tip,
  children,
}: {
  tip: React.ReactNode;
  children: React.ReactElement;
}): React.ReactElement {
  if (tip === null || tip === undefined) return children;
  return (
    <TugTooltip
      content={tip}
      variant="entity"
      side="top"
      delayDuration={TARGET_TIP_DELAY_MS}
    >
      {children}
    </TugTooltip>
  );
}

/**
 * LayoutPlaces — the deck's parts, as targets standing on the deck's picture.
 */
export function LayoutPlaces({
  kind,
  rails = {},
  width,
  layout = "fit",
  band,
  flow = null,
  columnSplits,
  columnAllocations,
  columnOffsets,
  columnMembers,
  railAllocations,
  railMembers,
  onTargetPointerDown,
  tipFor,
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

  /** A target's pointerdown, naming what it stands on. */
  const pressOf =
    (target: MiniatureTarget) =>
    (event: React.PointerEvent<HTMLElement>): void =>
      onTargetPointerDown?.(event, target);

  /** A side's width, held at the drawing's basis, so the field's targets only
   *  land on the blocks if the picture's own flex row is replicated whole. It
   *  holds one target per member the drawing draws and the deck can name. */
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
        {basis.members
          .filter((span) => span.index < members.length)
          .map((span) => {
            const paneId = members[span.index].paneId;
            const target: MiniatureTarget = { kind: "rail", side, paneId };
            return (
              <Target key={paneId} tip={tipFor?.(target)}>
                <span
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
                  onPointerDown={pressOf(target)}
                />
              </Target>
            );
          })}
      </span>
    );
  };

  /** One target per unsplit block, one per split member, in a run that clips
   *  as the drawing's run does ([P05]). Slot order is paint order, so where fit
   *  laps two blocks the target on top is the card the reader can see. */
  const targets = (
    <span className="layout-places-run">
      {geometry.blocks.map((block) => {
        if (block.members === undefined) {
          const target: MiniatureTarget = { kind: "block", slot: block.slot };
          return (
            <Target key={block.slot} tip={tipFor?.(target)}>
              <span
                className="layout-places-target"
                data-target="block"
                data-slot={block.slot}
                data-testid={`layout-card-target-block-${block.slot}`}
                aria-hidden="true"
                style={{
                  left: `${block.leftPct}%`,
                  width: `${block.widthPct}%`,
                }}
                onPointerDown={pressOf(target)}
              />
            </Target>
          );
        }
        const ids = columnMembers?.[block.slot] ?? [];
        const slide = block.overflow
          ? (columnOffsets?.[block.slot] ?? 0) * 100
          : 0;
        return block.members.map((member) => {
          const paneId = ids[member.index];
          if (paneId === undefined) return null;
          const target: MiniatureTarget = {
            kind: "member",
            slot: block.slot,
            paneId,
          };
          return (
            <Target key={`${block.slot}:${paneId}`} tip={tipFor?.(target)}>
              <span
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
                onPointerDown={pressOf(target)}
              />
            </Target>
          );
        });
      })}
    </span>
  );

  return (
    <span
      className="layout-places"
      data-layout={layout}
      data-testid="layout-card-places"
    >
      {rail("left")}
      <span className="layout-places-field">
        {targets}
        {windowGrip}
        {/* Every slot's block, empty or not, drawing nothing and taking no
            pointer: it is the part a drag's zone for that slot stands on —
            `use-miniature-gestures` measures each slot's landing from it, so
            an empty slot, which has no target, still has a place to offer. */}
        {geometry.blocks.map((block) => (
          <span
            key={block.slot}
            className="layout-places-block"
            data-slot={block.slot}
            aria-hidden="true"
            style={{
              left: `${block.leftPct}%`,
              width: `${block.widthPct}%`,
            }}
          />
        ))}
      </span>
      {rail("right")}
    </span>
  );
}

/* ---------------------------------------------------------------------------
 * The toggles, under the strip
 * ---------------------------------------------------------------------------*/

/** The glyph a place's stored arrangement wears. Nothing is ever marked lit:
 *  the glyph is naming the arrangement, not a position within it. */
function PlaceGlyph({ mode }: { mode: ColumnMode }): React.ReactElement {
  return mode === "split" ? <SplitGlyph lit={null} /> : <StackGlyph lit={null} />;
}

/** The other of the two arrangements — what pressing this toggle would set. */
function otherMode(mode: ColumnMode): ColumnMode {
  return mode === "split" ? "stack" : "split";
}

/**
 * A place's whole story, for its tooltip: what it is set to now, then what the
 * press does.
 */
function describePlace(place: LayoutPlace): string {
  const now = place.mode === "split" ? "split" : "stacked";
  const does = place.mode === "split" ? "stack" : "split";
  return `${place.label} is ${now} — click to ${does}`;
}

/**
 * One place's toggle: what the place is set to, and the press that sets it to
 * the other thing.
 *
 * The press does not command anything itself. It emits `selectValue` up the
 * responder chain carrying the PROPOSED arrangement and the sender id the
 * section's own responder already routes ([L11]), so the toggle slots into a
 * funnel that was already there ([L30]). Carrying the proposal rather than the
 * current value is what makes one control enough for a two-valued fact.
 *
 * Memoized on its props BY VALUE: the section rebuilds `columns` whenever the
 * arrangement moves, and a toggle compared by identity re-rendered on every
 * change to any column, inside the settle the change was animating through.
 */
const PlaceMark = memo(function PlaceMark({
  place,
}: {
  place: LayoutPlace;
}): React.ReactElement {
  const proposed = otherMode(place.mode);
  return (
    <span
      className="layout-places-mark"
      data-place={place.key}
      data-mode={place.mode}
    >
      <TugIconButton
        icon={<PlaceGlyph mode={place.mode} />}
        aria-label={describePlace(place)}
        title={describePlace(place)}
        size="xs"
        emphasis="ghost"
        senderId={place.senderId}
        dispatch={{
          action: TUG_ACTIONS.SELECT_VALUE,
          sender: place.senderId,
          value: proposed,
          phase: "discrete",
        }}
        data-testid={`layout-card-place-${place.key}`}
        data-choice-value={proposed}
        data-sender={place.senderId}
      />
    </span>
  );
}, deepEqual);

export interface LayoutPlaceTogglesProps {
  /** Every slot the kind defines, occupied or not — an empty slot's stored
   *  arrangement is as real as a one-card slot's, and its toggle is the door
   *  back to it. */
  columns: readonly LayoutPlace[];
  /** Each slot's span across the field, as fractions of it — the strip's own
   *  `spans`, so a toggle stands under its number. */
  spans: readonly ({ left: number; width: number } | undefined)[];
  /** What each side's rail takes of the row, in percent — the strip's own
   *  `rails`, so the field is the strip's field. */
  rails?: Partial<Record<SidebarSide, number>>;
  /** The deck's layout. In fit the toggles stand at each span's leading edge,
   *  the one part of a lapped card that is always visible. */
  layout?: ImpositionLayout;
  /** The focus group the section authors this stop into. */
  focusGroup?: string;
  /** Order within {@link focusGroup}. */
  focusOrder?: number;
}

/**
 * LayoutPlaceToggles — each slot's stack/split toggle, in a row under the
 * numbered strip.
 *
 * **One stop, a cursor over its toggles ([P24] deferred commit).** The row is
 * ONE stop in the Tab walk, not one per toggle — a stop per affordance would
 * make Tab crawl the row, and the same rule holds for every segmented row in
 * this card. Arrows move a cursor over the toggles, projected straight to the
 * DOM ([L06]), and Space commits the one under it.
 */
export function LayoutPlaceToggles({
  columns,
  spans,
  rails,
  layout = "fit",
  focusGroup,
  focusOrder = 0,
}: LayoutPlaceTogglesProps): React.ReactElement {
  const rootId = useId();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const { dispatch } = useControlDispatch();

  /** Every toggle, in reading order — which is DOM order: the slots, left to
   *  right. */
  const affordances = useCallback((): Element[] => {
    const root = rootRef.current;
    if (root === null) return [];
    return Array.from(
      root.querySelectorAll('[data-testid^="layout-card-place-"]'),
    );
  }, []);

  /**
   * Commit whatever the cursor is standing on. The element carries both
   * halves of its own act — the sender that routes it and the value it
   * proposes — so the keyboard and the pointer cannot come to disagree about
   * what a given toggle does.
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
    register: focusGroup !== undefined,
    collectItems: affordances,
    initialIndex: () => 0,
    onSelect: (element) => commitAt(element),
  });

  // The toggle set changes with the deck — the kind gains a slot — so the
  // cursor's range is re-read whenever the row does.
  const marksSignature = columns.map((c) => `${c.key}:${c.mode}`).join(",");
  useLayoutEffect(() => {
    syncItems();
  }, [marksSignature, syncItems]);

  const setRootRef = useCallback(
    (node: HTMLDivElement | null) => {
      rootRef.current = node;
      attachRoot(node);
    },
    [attachRoot],
  );

  return (
    <div
      ref={setRootRef}
      className="layout-place-toggles"
      data-layout={layout}
      data-testid="layout-card-toggles"
      role="group"
      aria-label="Column arrangements"
      tabIndex={focusGroup !== undefined ? 0 : undefined}
      onKeyDown={onKeyDown}
    >
      {rails?.left !== undefined ? (
        <span
          className="layout-place-toggles-rail"
          style={{ flexBasis: `${rails.left}%` }}
          aria-hidden="true"
        />
      ) : null}
      <span className="layout-place-toggles-field">
        {columns.map((place) => {
          const span =
            place.slot === undefined ? undefined : spans[place.slot];
          if (span === undefined) return null;
          return (
            <span
              key={place.key}
              className="layout-place-toggles-cell"
              style={{
                left: `${span.left * 100}%`,
                width: `${span.width * 100}%`,
              }}
            >
              <PlaceMark place={place} />
            </span>
          );
        })}
      </span>
      {rails?.right !== undefined ? (
        <span
          className="layout-place-toggles-rail"
          style={{ flexBasis: `${rails.right}%` }}
          aria-hidden="true"
        />
      ) : null}
    </div>
  );
}
