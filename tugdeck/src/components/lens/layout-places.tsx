/**
 * layout-places.tsx — the drawing's places, as things you can read and press.
 *
 * The Layout section draws the deck once, at scale, and used to re-describe it
 * underneath in a row per place: a Left/Right group per sidebar card, a rail
 * row per side, a Stack/Split row per shared slot. The reader's eye joined
 * "Column 3" to the third block in the picture on every read, and the row count
 * grew with the deck. This is the other half of that trade: the picture states
 * every per-place fact and takes every per-place gesture, and the rows below it
 * keep only the three questions that are about the deck as a whole.
 *
 * **A place wears what it is SET to, not what it is showing.** A slot's glyph
 * reads `columnModeOf` and a side's reads `railModeOf` — the stored
 * arrangement. The blocks under them are honest about what is on screen, and
 * the two come apart at exactly one card: membership churn preserves an
 * arrangement (`columnDrawsSplit`), so a slot set to split and standing one
 * card deep draws as one undivided block. Before this overlay that stored split
 * was invisible on every surface and unreachable from the Lens — the column
 * rows were gated on `members.length > 1` — so it sat there until a second card
 * arrived and it resurfaced as a surprise. A one-member place therefore keeps
 * its glyph, dimmed to say there is nothing to arrange right now, and stays
 * pressable so the arrangement can be put back.
 *
 * **The geometry is not this component's opinion.** It replicates the drawing's
 * own flex row — the same padding, the same gap, the same rail flex-basis — and
 * places its parts from `miniatureGeometry`, the arithmetic the drawing itself
 * consumes. Positioning by fractions of the whole frame instead would be off by
 * the padding and the gaps at every size.
 *
 * **It stands outside the plan's layers, on purpose.** The layers swap by
 * `display`, so an overlay parked inside the committed one would vanish the
 * instant its own hover raised a preview, un-hover itself, come back, and
 * oscillate. Anchored to the plan's box it stays under the pointer while the
 * drawing beneath it auditions the change.
 *
 * Presentational: props in, CSS out, no store reads and no state ([L06]). The
 * section resolves every fact from its own subscription and hands them down.
 *
 * @module components/lens/layout-places
 */

import "./layout-places.css";

import React, {
  useCallback,
  useId,
  useLayoutEffect,
  useRef,
} from "react";
import { ArrowLeftRight } from "lucide-react";

import {
  miniatureGeometry,
  type MiniatureRails,
} from "@/components/lens/layout-miniature";
import { LadderGlyph, StackGlyph } from "@/components/tugways/tug-column-badge";
import { TugIconButton } from "@/components/tugways/tug-icon-button";
import { TUG_ACTIONS } from "@/components/tugways/action-vocabulary";
import { useControlDispatch } from "@/components/tugways/use-control-dispatch";
import { useItemGroupKeyboard } from "@/components/tugways/use-item-group-keyboard";
import type {
  ColumnMode,
  ContentWidth,
  FlowSlotExtent,
  ImpositionKind,
  ImpositionLayout,
  RailMode,
  SidebarSide,
} from "@/lib/layout-imposer";

/**
 * One place in the deck that has an arrangement of its own: a numbered slot, or
 * a side's rail.
 *
 * `mode` is the STORED arrangement and `members` is what actually stands there.
 * Both are carried because the glyph needs the first and the dimming needs the
 * second, and deriving either from the other is exactly the conflation this
 * overlay exists to undo.
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
  /** How many cards stand here. One means nothing to arrange — yet. */
  members: number;
  /** What to call it out loud: "Column 3", "Left rail". */
  label: string;
  /** The preview axis this place's proposals are drawn under —
   *  `columnmode:<slot>` or `railmode:<side>`, the ids the plan's layers carry. */
  previewAxis: string;
  /** The sender id the section's responder routes this place's presses by. */
  senderId: string;
}

/**
 * One sidebar card standing on an edge — a place of a different kind: what is
 * arrangeable about it is not how it stacks but which side it holds.
 *
 * The drawing's rails are counts (`MiniatureRails`), which is all a picture
 * needs and less than a control needs, so the overlay is given the cards
 * themselves. The affordances are laid out as EQUAL shares of the strip
 * whatever the rail is drawing beneath: a stacked rail's members are
 * near-congruent slivers offset by a three-percent peek, which is a fine
 * picture of a stack and an impossible press target.
 */
export interface LayoutRailMember {
  /** Which registered sidebar card this is. */
  componentId: string;
  /** Its own name — what the affordance is called out loud. */
  title: string;
  /** The edge it holds now. Pressing sends it to the other one. */
  side: SidebarSide;
  /** The sender id the section's responder routes this card's press by. */
  senderId: string;
  /** The preview axis its proposals are drawn under. */
  previewAxis: string;
}

export interface LayoutPlacesProps {
  /** The arrangement to place against — the same props the drawing was given. */
  kind: ImpositionKind | null;
  rails?: MiniatureRails;
  width?: ContentWidth;
  layout?: ImpositionLayout;
  /** The live flow strip, when the drawing beneath is drawing one. */
  flow?: { bandPx: number; extents: readonly FlowSlotExtent[] } | null;
  /** Every slot that holds a card, whatever its arrangement. */
  columns: readonly LayoutPlace[];
  /** Every occupied side. */
  railPlaces: readonly LayoutPlace[];
  /** Every sidebar card, with the edge it currently holds. */
  railMembers: readonly LayoutRailMember[];
  /** The focus group the section authors this stop into. */
  focusGroup?: string;
  /** Order within {@link focusGroup} — the picture's place in the walk. */
  focusOrder?: number;
}

/** The other of the two edges — where pressing this member would send it. */
function otherSide(side: SidebarSide): SidebarSide {
  return side === "left" ? "right" : "left";
}

/**
 * The cards on one side, each a press that sends it to the other edge.
 *
 * Equal shares of the strip's height, top to bottom in registration order —
 * see {@link LayoutRailMember} for why the drawing's own member geometry is not
 * reused. The mode mark keeps the strip's foot, so the members leave it room.
 */
function RailMembers({
  members,
}: {
  members: readonly LayoutRailMember[];
}): React.ReactElement | null {
  if (members.length === 0) return null;
  return (
    <span className="layout-places-rail-members">
      {members.map((member) => {
        const destination = otherSide(member.side);
        return (
          <span
            key={member.componentId}
            className="layout-places-rail-member"
            data-place={`side-${member.componentId}`}
            data-preview-axis={member.previewAxis}
          >
            <TugIconButton
              icon={<ArrowLeftRight />}
              aria-label={`${member.title} — move to the ${destination} edge`}
              title={`${member.title} — move to the ${destination} edge`}
              size="2xs"
              emphasis="ghost"
              senderId={member.senderId}
              dispatch={{
                action: TUG_ACTIONS.SELECT_VALUE,
                sender: member.senderId,
                value: destination,
                phase: "discrete",
              }}
              data-testid={`lens-layouts-place-side-${member.componentId}`}
              data-choice-value={destination}
              data-sender={member.senderId}
            />
          </span>
        );
      })}
    </span>
  );
}

/** The glyph a place's stored arrangement wears. Nothing is ever marked lit:
 *  the glyph is naming the arrangement, not a position within it. */
function PlaceGlyph({ mode }: { mode: ColumnMode | RailMode }): React.ReactElement {
  return mode === "split" ? <LadderGlyph lit={null} /> : <StackGlyph lit={null} />;
}

/** The other of the two arrangements — what pressing this mark would set. */
function otherMode(mode: ColumnMode | RailMode): ColumnMode | RailMode {
  return mode === "split" ? "stack" : "split";
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
 * Carrying the proposal rather than the current value is also what makes the
 * hover preview work without a new mechanism: `previewIdOf` resolves a
 * `data-preview-axis` ancestor plus this element's `data-choice-value`, and
 * since the value is always the arrangement NOT in force, the layer it finds is
 * always the change rather than a tentative copy of what is already true.
 */
function PlaceMark({
  place,
  senderId,
}: {
  place: LayoutPlace;
  /** The sender the section's responder routes this place by. */
  senderId: string;
}): React.ReactElement {
  const proposed = otherMode(place.mode);
  return (
    <span
      className="layout-places-mark"
      data-place={place.key}
      data-mode={place.mode}
      // Nothing to arrange while one card stands here — said by weight rather
      // than by absence, because the arrangement is still real and still the
      // one a second card would land under, and pressing it is how it is put
      // back.
      data-dim={place.members > 1 ? undefined : ""}
      data-preview-axis={place.previewAxis}
    >
      <TugIconButton
        icon={<PlaceGlyph mode={place.mode} />}
        aria-label={`${place.label} — ${proposed}`}
        title={`${place.label} — ${proposed}`}
        size="2xs"
        emphasis="ghost"
        senderId={senderId}
        dispatch={{
          action: TUG_ACTIONS.SELECT_VALUE,
          sender: senderId,
          value: proposed,
          phase: "discrete",
        }}
        data-testid={`lens-layouts-place-${place.key}`}
        data-choice-value={proposed}
        data-sender={senderId}
      />
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
  flow = null,
  columns,
  railPlaces,
  railMembers,
  focusGroup,
  focusOrder = 0,
}: LayoutPlacesProps): React.ReactElement {
  const geometry = miniatureGeometry({ kind, rails, width, layout, flow });

  // ---- One stop, a cursor over its places ([P24] deferred commit) ----
  //
  // The picture is ONE stop in the Tab walk, not one per mark: a stop per
  // affordance would make Tab crawl the drawing, and the same rule already
  // holds for every segmented row in this section. Arrows move a cursor over
  // the marks — appearance projected straight to the DOM, no re-render ([L06])
  // — and Space commits the one under it. Because a mark carries the
  // arrangement NOT in force, an arrow that lands on one raises that
  // arrangement's preview through the section's existing switch, so the
  // keyboard auditions exactly the way the pointer does.
  const rootId = useId();
  const rootRef = useRef<HTMLSpanElement | null>(null);
  const { dispatch } = useControlDispatch();

  /** Every affordance, in reading order — which is DOM order: the left rail's
   *  cards then its arrangement, the slots left to right, then the right rail's. */
  const affordances = useCallback((): Element[] => {
    const root = rootRef.current;
    if (root === null) return [];
    return Array.from(
      root.querySelectorAll('[data-testid^="lens-layouts-place-"]'),
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
    register: focusGroup !== undefined,
    collectItems: affordances,
    initialIndex: () => 0,
    onSelect: (element) => commitAt(element),
  });

  // The mark set changes with the deck — a slot gains a card, a sidebar moves
  // edges — so the cursor's range is re-read whenever the drawing does.
  const marksSignature = `${columns.map((c) => `${c.key}:${c.mode}`).join(",")}|${railPlaces
    .map((r) => `${r.key}:${r.mode}`)
    .join(",")}|${railMembers.map((m) => `${m.componentId}:${m.side}`).join(",")}`;
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
        <RailMembers
          members={railMembers.filter((member) => member.side === side)}
        />
        <PlaceMark place={place} senderId={place.senderId} />
      </span>
    );
  };

  return (
    <span
      className="layout-places"
      data-testid="lens-layouts-places"
      ref={setRootRef}
      tabIndex={focusGroup !== undefined ? 0 : undefined}
      onKeyDown={onKeyDown}
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
              <PlaceMark place={place} senderId={place.senderId} />
            </span>
          );
        })}
      </span>
      {rail("right")}
    </span>
  );
}
