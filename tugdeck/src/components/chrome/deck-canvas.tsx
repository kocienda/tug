/**
 * DeckCanvas — canvas shell with responder chain support and TugPane rendering
 * from `DeckState`.
 *
 * Registers as root responder "deck-canvas" via `useResponder`. Handles
 * canvas-level actions: `cycleCard`, `resetLayout`, `showSettings`,
 * `showComponentGallery`. As a root node (`parentId` null) DeckCanvas is the
 * default first responder so canvas shortcuts work right after mount.
 *
 * `DeckCanvas` receives `DeckState` and stable callbacks from `DeckManager`
 * via the `DeckManagerContext` store (`useSyncExternalStore`, [D01], [D04]).
 * Maps `deckState.panes` to `TugPane` components. Z-index follows stack
 * order. `showComponentGallery` uses show-only semantics ([D05], [D06], [D07]).
 *
 * The canvas div with grid background is provided by `#deck-container` in
 * index.html. Deck actions include `cycleCard`, `resetLayout`, `showSettings`,
 * and `showComponentGallery`.
 */

import React, { memo, useCallback, useMemo, useEffect, useRef, useLayoutEffect } from "react";
import { useSyncExternalStore } from "@/lib/gesture-scope";
import {
  contentBoxHeight,
  endStillCrossing,
  markStillCrossing,
} from "@/lib/fold-crossing";
import {
  getTugTiming,
} from "@/components/tugways/scale-timing";
import { pageZoomFactor, pageZoomStore } from "@/lib/page-zoom-store";
import { ZoomReadout } from "./zoom-readout";
import { useResponder } from "@/components/tugways/use-responder";
import { useResponderChain } from "@/components/tugways/responder-chain-provider";
import type { ActionEvent } from "@/components/tugways/responder-chain";
import { TUG_ACTIONS } from "@/components/tugways/action-vocabulary";
import { mayDeferCommit, transferFocusForActivation } from "@/focus-transfer";
import {
  deckTrace,
  type SpaceEpochReason,
} from "@/deck-trace";
import {
  revealSidebarCard,
  toggleSidebarCard,
  toggleSidebarRail,
} from "@/sidebar-toggle";
import { CANVAS_BACKGROUND_ATTRIBUTE } from "@/gesture-interpreter";
import { DRAG_MOVE_THRESHOLD_PX } from "@/lib/press-travel";
import {
  TugPane,
  type ArrivingSeat,
  type SidebarStackStanding,
  type TugPaneProps,
} from "./tug-pane";
import { CardHost } from "./card-host";
import { CanvasOverlayRoot } from "./canvas-overlay-root";
import { OpenQuicklyOverlay } from "./open-quickly-overlay";
import { UpdateTug } from "@/components/tugways/update-tug";
import { UpdatePill } from "./update-pill";
import { DeckCommitBeacon } from "./deck-commit-beacon";
import { TugSlot } from "@/components/tugways/tug-slot";
import { usePaneFocusController } from "./pane-focus-controller";
import { usePaneOcclusionController } from "./pane-occlusion-controller";
import { canvasDeck, canvasDeckEqual } from "./canvas-deck-fields";
import { useStoreDerived } from "@/lib/use-store-derived";
import {
  buildZIndexMap,
  CARD_ZINDEX_BASE,
  MARGIN_CAP_ZINDEX,
  RAIL_SEAM_ZINDEX,
  RAIL_SHADOW_ZINDEX,
  SIDEBAR_PANE_ZINDEX_MAX_RANK,
  usePaneRaise,
} from "./pane-stacking";
import { useSettleEngine } from "./settle-engine";
import {
  RailWidthGestureContext,
  useRailWidthDraft,
} from "./rail-width-draft";
import {
  RAIL_TRAVEL_ATTR,
  railTravelOf,
  type RailTravelBand,
} from "@/lib/rail-width";
import {
  getRegistration,
  getStackSizePolicy,
} from "@/card-registry";
import { toggleCardFold } from "@/lib/card-fold";
import { JOTS_CARD_ID } from "@/lib/jots-card-id";
import { ARCS_CARD_ID } from "@/lib/arcs-card-id";
import { CARDS_CARD_ID } from "@/lib/cards-card-id";
import type { IDeckManagerStore } from "@/deck-manager-store";
import { cardsSpaceVerbRequest } from "@/components/cards/cards-space-verb-request";
import { OVERVIEW_CARD_ID } from "@/lib/overview-card-id";
import { getJotsStore } from "@/lib/jots-store";
import {
  bullseyePaneIdOf,
  columnDrawsSplit,
  deckColumnsOf,
  deckFlowStrip,
  deckVacancyExtent,
  type DeckColumn,
  findSidebarPanes,
  isSidebarParked,
  isUnboundMember,
  placeMembers,
  type PlaceRuns,
  sidebarRailsOf,
  type SidebarRail,
} from "@/deck-store-selectors";
import type { SlotStackEntry } from "@/deck-store-selectors";
import { stepCardRing } from "@/lib/card-ring";
import type { DeckState, TugPaneState } from "@/layout-tree";
import { standingDeck, withDepartingStanding } from "@/lib/departing";
import { useDeckManager } from "@/deck-manager-context";
import { cardDragCoordinator } from "@/card-drag-coordinator";
import { copySelectionAsPlainText } from "@/lib/copy-as-plain-text";
import { openFileInCard } from "@/lib/open-file-in-card";
import { revealPathInFinder } from "@/lib/os-open";
import {
  isDictionaryLookupRequest,
  lookUpInDictionary,
} from "@/lib/dictionary-lookup";
import { openOpenQuickly } from "@/lib/open-quickly-store";
import { clearRecentDocuments } from "@/lib/recent-documents";
import { subscribeScrollPhase } from "@/lib/scroll-phase-bridge";
import { takeFlowFromSettle } from "@/lib/settle-take";
import { allocateUntitledNumber } from "@/lib/untitled-naming";
import {
  IMPOSER_SETTLE_END,
} from "@/lib/settle-notice";
import {
  SPACE_EPOCH_BOUND_MS,
  spaceEpochDeadlineMs,
  spaceEpochClosed,
} from "@/lib/space-settled";
import {
  classifySpaceSwitchFrames,
  SPACE_SWITCH_FRAME_WINDOW_MS,
} from "@/lib/space-switch-frames";
import { dispatchCommand } from "@/command-dispatch";
import {
  attachLayoutSelectionToDeck,
  cardsSelectionStore,
} from "@/components/cards/cards-selection-store";
import { shrinkCardsState } from "@/components/cards/cards-escape";
import { contentCardsInLayoutSelection } from "@/lib/layout-selection";
import {
  flashCardPane,
  flashSlot,
} from "@/lib/flash-pane-border";
import {
  isFocusDirection,
  resolveDirectionalFocus,
  type FocusTravelSpan,
} from "@/lib/directional-focus";
import {
  enumerateDropZones,
  type DropZone,
  type DropZoneSet,
  type DropZoneHost,
} from "@/lib/drop-zones";
import {
  getDropZoneHost,
  registerDropZoneHost,
} from "@/lib/drop-zone-host-registry";
import { indicateDropZone } from "@/lib/drop-zone-indicator";
import {
  publishColumnOffset,
  publishDragFrame,
  publishDragZone,
  publishFlowOffset,
  type GaugeRect,
} from "@/lib/imposer-gauges";
import type { Rect } from "@/snap";
import { tugDevLogStore } from "@/lib/tug-dev-log-store/tug-dev-log-store";
import "./slot-vacancy.css";
import {
  writeCanvasFlowOffset,
  writeLayerFlowOffset,
} from "./flow-offset";
import {
  SHOWN_PANE_FRAMES,
  SPACE_LAYER_CLASS,
  SPACE_SHOWN_ATTRIBUTE,
  SPACE_SWITCHING_ATTRIBUTE,
  SpaceLayerShownContext,
  type SpaceLayerShownSource,
} from "./space-layer";
import { registerColumnSeamDrag } from "./column-seam-drag";
import {
  stillHiddenLayerLoops,
  stillLoopOnStart,
} from "./space-layer-loops";
import { motionBreaker } from "@/lib/motion-guard/breaker";
import { mark as perfMark } from "@/lib/perf-marks";
import "./space-layer.css";
import "./rail-vacancy.css";
import "./margin-cap.css";
import "./rail-shadow.css";
import {
  sidebarSide,
  withEveryHideCleared,
  isContentWidth,
  resolvePlacement,
  resolveContentWidthPx,
  clampSlot,
  columnOffsetProperty,
  type PlaceAllocation,
  type PlaceMember,
  columnSeamProperty,
  columnStripProperty,
  placeSharesFromHeights,
  railOffsetProperty,
  imposeStyle,
  isColumnMoveTarget,
  isSidebarSide,
  type ColumnMemberPlacement,
  type ColumnMode,
  slotCount,
  DEFAULT_CONTENT_WIDTH,
  IMPOSITION_GAP_PX,
  RESIZE_RETUNE_QUIET_MS,
  FLOW_STRIP_PROPERTY,
  clampFlowOffset,
  FLOW_WHEEL_HUMP_PX,
  FLOW_STOP_NEAR_PX,
  flowNextStop,
  flowCenterOffset,
  imposeSidebarStyle,
  railSeamProperty,
  railStripProperty,
  cascadedHeights,
  seamDragBounds,
  stripCoordinatesOf,
  impositionGapBottomPx,
  RAIL_EDGE_INSET_PX,
  RAIL_EDGE_INSET,
  RAIL_GAP_BOTTOM,
  railGapBottomPx,
  RAIL_SEAM_PX,
  RAIL_TREATMENT,
  RAIL_TREATMENT_ATTRIBUTE,
  railSpanInset,
  sidebarWidthProperty,
  impositionResizeSlot,
  type SidebarSide,
} from "@/lib/layout-imposer";

// ---- DeckCanvasProps ----

/**
 * Empty props: deck state is read from `DeckManagerContext`.
 *
 * deckState, onCardMoved, onStackClosed, and onStackActivated are removed --
 * DeckCanvas reads them from the DeckManagerContext store via
 * useSyncExternalStore. No props remain.
 */
export interface DeckCanvasProps {}

/**
 * How deep a column's seam sweep reaches, per slot.
 *
 * A rail borrows {@link SIDEBAR_PANE_ZINDEX_MAX_RANK} for its sweep, because a
 * rail's members are z-ranked and that number already bounds them. A slot has
 * no z-rank ceiling to borrow, so the bound is stated here: it is the deepest
 * column the split UI will ever put seams in, and the sweep removes every index
 * from the live seam count up to it so a column going three members to two
 * cannot leave seam 1 standing for a frame to pin itself against.
 *
 * Deliberately generous — nothing enforces a member limit, and an over-long
 * sweep costs a handful of `removeProperty` calls on a property that is not
 * there, while a short one leaves a live lie in the CSS.
 */
const COLUMN_SEAM_MAX_INDEX = 9;

/** Every slot the sweep clears, whatever the current kind: the largest
 *  arrangement's slot count, so dropping from six-up to three-up removes the
 *  seams of the columns the deck no longer has. */
const COLUMN_SEAM_MAX_SLOT = slotCount("six-up") - 1;

/** The offsets a deck with no overflowing column has. A shared constant rather
 *  than a fresh `{}` per render, so the memos reading it are not re-run by an
 *  identity that changes for no reason. */
const EMPTY_COLUMN_OFFSETS: Readonly<Record<number, number>> = Object.freeze({});
const NO_DEPARTING: ReadonlySet<string> = new Set();

/** The rail-offsets record's twin of {@link EMPTY_COLUMN_OFFSETS}, and a
 *  frozen singleton for the same reason. */
const EMPTY_RAIL_OFFSETS: Readonly<Partial<Record<SidebarSide, number>>> =
  Object.freeze({});

/** How long the strip waits after the last wheel event before it commits where
 *  it came to rest ([P11]). A wheel has no release to commit on, so quiet is
 *  the only end it has: long enough that the pauses inside one flick are not
 *  read as three gestures, short enough that the store is caught up by the
 *  time a hand reaches for anything else. */
const FLOW_WHEEL_IDLE_MS = 180;

/** How many of a wheel gesture's last deltas decide the direction its release
 *  settles toward. Few enough that a reversal at the end of a swipe is read
 *  as one; more than one so a single stray delta is not. */
const FLOW_WHEEL_RECENT_DELTAS = 3;

/** How far back a lift looks to measure the hand's speed. Long enough to
 *  span several deltas at display cadence, short enough that a hand which
 *  stopped before it lifted reads as stopped. */
const FLOW_WHEEL_VELOCITY_MS = 80;

/** How many timed deltas the gesture keeps — enough to cover the velocity
 *  window at display cadence, and the direction's few at its tail. */
const FLOW_WHEEL_RING = 8;

/** How long a wheel gesture that saw the fingers touch waits, with no delta
 *  and no lift, before it ends anyway. Such a gesture ends on the host's
 *  `lifted` edge, not on a quiet — fingers resting mid-swipe are not a
 *  release — so this is only the guard against a lift that never arrives. */
const FLOW_WHEEL_LIFT_GUARD_MS = 1000;

/**
 * Every member of every place, keyed by PANE ID — the map the drop-zone
 * engine allocates its tiles from.
 *
 * The engine keys everything by pane, so a rail member is re-keyed
 * here from its componentId, at the same boundary its shares are: this is the
 * one place that can see both names for a member. The weight each member
 * carries is immaterial — the engine re-reads it from the place's own shares
 * for whichever candidate order it is allocating.
 */
function placeMembersByPaneId(
  state: DeckState,
  rails: readonly SidebarRail[],
): ReadonlyMap<string, PlaceMember> {
  const map = new Map<string, PlaceMember>();
  for (const rail of rails) {
    const railMembers = placeMembers(
      state,
      "rail",
      rail.members.map((member) => member.componentId),
      state.imposition.rails?.[rail.side]?.shares,
    );
    railMembers.forEach((member, index) => {
      const paneId = rail.members[index].paneId;
      map.set(paneId, { ...member, id: paneId });
    });
  }
  for (const column of deckColumnsOf(state, null)) {
    for (const member of placeMembers(
      state,
      "column",
      column.members,
      state.imposition.columns?.[column.slot]?.shares,
    )) {
      map.set(member.id, member);
    }
  }
  return map;
}

/** The runs of a caller that is asking about membership or mode alone — a
 *  place with no run has no allocation, and asking for one would measure the
 *  canvas for an answer nobody reads. */
const UNMEASURED_RUNS: PlaceRuns = { rail: null, column: null };

/**
 * Where a lateral focus run entered, and the card it last landed on ([B06]).
 *
 * Module scope rather than a store, because nothing renders from it: it is the
 * travel's own memory, read by one handler and written by the same one.
 *
 * **It needs no invalidation, and that is the design.** The memory is only in
 * force while the keyboard still stands where the travel left it, so every event
 * the brief lists as a reset — a click, a ring step, a slot assign, a card
 * closing — moves the first responder somewhere else and the goal is ignored on
 * the next read. A card closing takes its id with it, so a stale entry cannot
 * even be matched. The one thing that survives is a click landing back on the
 * same card, which is a focus change that changed no focus, and holding the line
 * through it is the friendlier answer anyway.
 */
let focusTravelRun: { cardId: string; goal: FocusTravelSpan } | null = null;

/**
 * How tall a seam's hit strip is. Wider than the 5px gap it sits in, because a
 * 5px target is under every pointing-comfort floor the deck holds elsewhere;
 * the cost is that it takes about 2.5px off each neighbour's edge, and on the
 * lower member that edge is title bar. The seam is the smaller and more precise
 * target of the two, so it is the one that gets the help.
 */
const RAIL_SEAM_HIT_PX = 10;

/**
 * Which place a seam divides. The deck has two kinds — a side's rail and a
 * numbered slot's column — and the seam between two members is the same object
 * in both: the same drag, the same clamp, the same equalize, over a different
 * custom property and a different commit.
 */
type SeamPlace =
  | { kind: "rail"; side: SidebarSide }
  | { kind: "column"; slot: number };

/** The custom property carrying seam `index` of `place`. */
function seamPropertyOf(place: SeamPlace, index: number): string {
  return place.kind === "rail"
    ? railSeamProperty(place.side, index)
    : columnSeamProperty(place.slot, index);
}

/** The custom property carrying strip coordinate `index` of `place` — the
 *  overflowing twin of {@link seamPropertyOf}, and the property an overflowing
 *  seam drag writes. */
function stripPropertyOf(place: SeamPlace, index: number): string {
  return place.kind === "rail"
    ? railStripProperty(place.side, index)
    : columnStripProperty(place.slot, index);
}

/** The custom property carrying how far `place`'s strip has slid up behind its
 *  run. Read by an overflowing seam so the handle rides the strip it divides. */
function offsetPropertyOf(place: SeamPlace): string {
  return place.kind === "rail"
    ? railOffsetProperty(place.side)
    : columnOffsetProperty(place.slot);
}

/** Where `place`'s run begins, in px: a rail keeps the rail edge inset at its
 *  top and a column keeps the card gap — the same distinction the imposer's
 *  member pins draw. */
function placeRunTopPx(place: SeamPlace): number {
  return place.kind === "rail" ? RAIL_EDGE_INSET_PX : IMPOSITION_GAP_PX;
}

/** Where `place`'s run ends, in px from the foot: a rail keeps the strip's
 *  clearance and a column keeps the bottom gap. */
function placeRunBottomPx(place: SeamPlace): number {
  return place.kind === "rail" ? railGapBottomPx() : impositionGapBottomPx();
}

/** The air two of `place`'s members keep between them, in px: a rail's
 *  members meet at nothing, a column's at the card gap. */
function placeSeamPx(place: SeamPlace): number {
  return place.kind === "rail" ? RAIL_SEAM_PX : IMPOSITION_GAP_PX;
}

/**
 * The heights `allocation` would have if boundary `index` stood at `value` —
 * the drag's whole arithmetic, and the one place the property's unit is read
 * back out of.
 *
 * The boundary is put where the hand left it and the strip is differenced: the
 * `n + 1` coordinates become `n` heights, each the distance to the next
 * coordinate less the seam standing in it.
 *
 * A SHARED place's drag is **zero-sum** — the run it divides is fixed, so
 * every pixel one member gains another gives up — but it is not confined to
 * the two members either side of `index`. When the neighbour it is pushing
 * reaches its own floor and the hand keeps going, the members beyond it give
 * up their slack in turn, nearest first. A rail whose middle card is pinned
 * at its floor would otherwise stop the sash dead while room stood free two
 * cards further down, which is what the hand reads as a sash that has jammed.
 * {@link cascadedHeights} is the arithmetic; this is only its unit.
 *
 * A FLOWING place's is not, and that is the settled answer rather than an
 * oversight ([B08]). It is not zero-sum at all: every coordinate below the
 * boundary moves with it, so the member above the seam takes the whole of the
 * drag and the strip lengthens by it. The alternative — trading against the
 * member below, as a shared place
 * does — would make lengthening one card cost its neighbour a height the
 * neighbour declared it needs, and in flow a declared height is the whole of
 * what a member stands at.
 *
 * `value` arrives in the property's own unit, so a shared place's fraction is
 * turned back into a strip coordinate first — the exact inverse of what the
 * gesture wrote, so the round trip is the identity the fixed point needs.
 */
function draggedHeights(
  allocation: PlaceAllocation,
  members: readonly PlaceMember[],
  index: number,
  value: number,
): readonly number[] {
  const count = allocation.ids.length;
  const strip = [...allocation.tops, allocation.stripLength];
  const seam = allocation.seam;
  if (allocation.standing !== "overflow") {
    // A shared place's boundary is stated as a fraction of the run; read back
    // out, it is the height the hand is asking of the member above — which is
    // the one thing {@link cascadedHeights} takes, and the round trip is the
    // identity because the gesture wrote the fraction from that same height.
    return cascadedHeights(
      allocation,
      members,
      index,
      value * allocation.run + seam / 2 - seam - (allocation.tops[index] ?? 0),
    );
  }
  const shift = value - strip[index + 1];
  for (let i = index + 1; i < strip.length; i += 1) strip[i] += shift;
  const heights: number[] = [];
  for (let i = 0; i < count; i += 1) {
    heights.push(strip[i + 1] - strip[i] - (i < count - 1 ? seam : 0));
  }
  return heights;
}

interface PlaceSeamProps {
  place: SeamPlace;
  /** Which gap this is: the boundary between members `index` and `index + 1`. */
  index: number;
  /**
   * The place's own horizontal pins, straight from the imposer — the rail's
   * pin for a rail, the slot's anchor for a column. Resolved by the caller
   * rather than here so the seam reads the SAME expression its frames do
   * (including, on a flow deck, the strip position and viewport offset) rather
   * than a second expression that says the same thing.
   */
  frameStyle: React.CSSProperties;
  /**
   * How the place divides its run right now — the heights the seam sits
   * between, the strip coordinates it writes when the place overflows, and the
   * standing the whole gesture forks on. The LIVE one: a commit reads it again
   * rather than trusting the pointer-down snapshot, so a seam dragged while the
   * window was resizing still commits against the division on screen.
   */
  allocation: PlaceAllocation;
  /**
   * Every member of the place — floors and stored weights, in the place's own
   * order. The drag's bounds are a function of these and nothing else, so the
   * clamp a hand meets is the same rule the allocator would apply to the
   * height it left behind.
   */
  members: readonly PlaceMember[];
  /**
   * The pane id of every member of the place, in the same order. The two this
   * seam divides are `[index]` and `[index + 1]`, and they are the frames the
   * drag is positioning.
   */
  memberPaneIds: readonly string[];
  /**
   * The boundary the hand moved and where it left it, in the property's own
   * unit — a fraction of the run while the place shares it, strip px while it
   * overflows. One value rather than the whole array, because the array the
   * commit needs is the LIVE one and only this entry came from the gesture.
   */
  onCommit: (place: SeamPlace, index: number, value: number) => void;
  /**
   * A column seam's {@link RAIL_TRAVEL_ATTR} — what its `frameStyle`'s `left`
   * is a function of, so a rail width preview carries it with the frames it
   * divides. A rail seam has none; the preview pins it with its rail.
   */
  railTravel?: string;
  /** The seam of a PARKED rail: mounted, hidden (`data-rail-parked`), and
   *  inert, so the show that stands its rail again mounts nothing. */
  parked?: boolean;
}

/**
 * The boundary between two split members, and the handle that moves it.
 *
 * Positioned from the SAME properties the frames are — its horizontal pins are
 * the imposer's own output, handed in — so a seam cannot drift from the run it
 * divides.
 *
 * It does **not** participate in the settle: that walks `.tug-pane[data-pane-id]`
 * frames and a seam is not one, so on a mode flip it appears at its final
 * position while the frames tween to meet it. A seam is a boundary rather than
 * a card, and a boundary that slides is a fourth moving thing to track.
 *
 * The drag shares the rail width drag's grammar (`rail-width-draft.ts`) —
 * pointer capture, a move-threshold latch, zoom-corrected deltas, and the
 * record and the preview changing hands in one task at the release so no
 * frame reads a stale value — with **one deliberate divergence: no occlusion
 * bracket.** That bracket exists to keep a frame passing over another from
 * being stamped `data-occluded` mid-gesture. A seam drag resizes two members
 * that stay tiled: no frame ever passes over another, and there is nothing for
 * the bracket to keep visible. (The reorder drag needs one for exactly the
 * reason this does not.)
 */
function PlaceSeam({
  place,
  index,
  frameStyle,
  allocation,
  members,
  memberPaneIds,
  onCommit,
  railTravel,
  parked = false,
}: PlaceSeamProps): React.ReactElement {
  const allocationRef = useRef(allocation);
  allocationRef.current = allocation;
  const membersRef = useRef(members);
  membersRef.current = members;
  const memberPaneIdsRef = useRef(memberPaneIds);
  memberPaneIdsRef.current = memberPaneIds;

  const seamRef = useRef<HTMLDivElement | null>(null);

  // The drag, for a press already in progress — the seam's own, or one a
  // column member's inner edge hands over (`column-seam-drag.ts`).
  const beginDrag = useCallback(
    (seam: HTMLElement, pointerId: number, startClientY: number) => {
      const container = seam.parentElement;
      if (container === null) return;

      const zoom = pageZoomFactor();
      // The division the gesture starts from, and the run it is stated against
      // — the allocator's own, never a re-measure of the container. A seam
      // measuring its own run would be a second opinion about a number the
      // allocation already carries, and the two would disagree the moment a
      // rounding differed.
      const start = allocationRef.current;
      const run = start.run;
      const seamPx = placeSeamPx(place);
      const startTop = start.tops[index] ?? 0;
      const startHeight = start.heights[index] ?? 0;
      if (!(run > 0) || start.heights.length < 2) return;

      // How far this seam may travel, as the range of the upper member's
      // HEIGHT: the allocator's own bounds, so a drag can never write a height
      // the allocator would refuse to give back ([P10]). They fork by regime
      // rather than by axis — an overflowing strip is as long as it needs to
      // be, a shared run with no discretionary pool left cannot move at all —
      // and a collapsed range is legal ([Q01]): the clamp simply holds the
      // height where it stands, which is what "nothing to trade" looks like to
      // a hand.
      const { lower, upper } = seamDragBounds(
        start,
        membersRef.current,
        index,
      );
      const overflowing = start.standing === "overflow";
      // Where the height the hand is setting is published: the boundary BELOW
      // the upper member, which a shared place spells as a fraction of the run
      // and an overflowing one as the strip coordinate of the next member's
      // top. One boundary, two units.
      const property = overflowing
        ? stripPropertyOf(place, index + 1)
        : seamPropertyOf(place, index);
      const valueOf = (height: number): number =>
        overflowing
          ? startTop + height + seamPx
          : (startTop + height + seamPx / 2) / run;

      seam.setPointerCapture(pointerId);
      seam.setAttribute("data-gesture", "seam");
      // The place's members are the hand's for the duration — the two this
      // seam divides always, and, when the drag cascades past a floor, the
      // ones beyond them as well. They resize under it every frame with
      // nothing animating them, which is the same thing a dragged frame does
      // and wants the same mark. A settle landing mid-drag must skip them for
      // the reason it skips any
      // pointer-owned frame (motion on top of a pointer lags the pointer),
      // and the cut detector must read their motion as a hand placing them
      // rather than as the imposer failing to carry them ([F05], [B05]).
      //
      // Every member rather than only the ones a given drag will reach: which
      // those are is a function of how far the hand travels, and a mark
      // handed out mid-gesture would arrive after the settle that needed it.
      // A member that never moves is carried zero distance, which costs
      // nothing.
      //
      // Index-aligned with the allocation, because the hold below gives each
      // frame its OWN largest height rather than one number for the place.
      const divided = [...memberPaneIdsRef.current]
        .map((id, member) => {
          const el =
            id === undefined
              ? null
              : document.querySelector<HTMLElement>(
                  `.tug-pane[data-pane-id="${id}"]`,
                );
          return el === null ? null : { member, el };
        })
        .filter((m): m is { member: number; el: HTMLElement } => m !== null);
      for (const { el } of divided) el.setAttribute("data-pointer-owned", "true");

      // And the drag is a STILL CROSSING whose clock is the hand ([B01]). The
      // divided members' interiors are laid out once, at the largest height
      // this drag can reach, and held there for its length: the frame's edge
      // then clips or reveals a picture that is already drawn, instead of
      // dirtying the whole subtree sixty times a second. It is the settle's
      // own hold, reused rather than a second mechanism written — the same
      // mark, the same held-height property, the same pane-level rule — so a
      // card declaring `data-still-anchor="bottom"` keeps its bottom-hung
      // picture here for free.
      //
      // The largest height a member can reach is read off the two ENDS of the
      // drag's range, through the same cascade `publish` writes: the ask is
      // monotonic in the pointer, so a member's extreme over the gesture is at
      // one end or the other. Under `overflow` the bounds collapse and every
      // member's largest height is the one it already stands at, which is the
      // honest answer — an overflowing place's seam cannot move.
      //
      // The hold is stated as a CONTENT-box height because that is what the
      // pane's rule resolves against, and the chrome around a content box is
      // fixed for the gesture, so the delta carries across unchanged. One rect
      // per frame at pointer-down, none per animation frame.
      const atLower = cascadedHeights(start, membersRef.current, index, lower);
      const atUpper = cascadedHeights(start, membersRef.current, index, upper);
      const heldContentHeightOf = (member: number, el: HTMLElement): number => {
        const standing = start.heights[member] ?? 0;
        const largest = Math.max(
          atLower[member] ?? standing,
          atUpper[member] ?? standing,
          standing,
        );
        return (contentBoxHeight(el) ?? 0) + (largest - standing);
      };
      // The crossing this gesture opened on each member, by its own id. Kept
      // because the release below must close THIS hold and no other: a
      // crossing the imposer opened — a card arriving in the rail, a fold, the
      // seam's own double-click equalize — is live on these very panes for the
      // length of its tween, and a press on the seam inside that window would
      // otherwise take an unguarded `endStillCrossing` straight through it.
      // The interior would go back to `height: 100%` of a box still travelling
      // and re-flow for the rest of the sweep, which is the cost [B01] exists
      // to remove, on the panes it exists to remove it from. The imposer's own
      // completion already closes by id for this reason; only its end-of-window
      // sweeps release unguarded, and they are sweeps.
      const heldIds = new Map<HTMLElement, number>();
      const beginHold = (): void => {
        for (const { member, el } of divided) {
          const held = heldContentHeightOf(member, el);
          if (held > 0) heldIds.set(el, markStillCrossing(el, held));
        }
      };
      // Idempotent, and run on every exit the mark has ([B03], [L27]): a hold
      // that outlives its gesture is a card propped open for the rest of the
      // session ([L23]). Idempotent by the map rather than by the attribute —
      // a press that never latched has nothing in it and releases nothing.
      const releaseHold = (): void => {
        for (const { el } of divided) {
          const id = heldIds.get(el);
          if (id === undefined) continue;
          heldIds.delete(el);
          endStillCrossing(el, id);
        }
      };

      // WHERE the per-frame write lands is the cost ([B04] of
      // `sash-drag-pinned`, and the reading behind it). The fractions the
      // frames read at rest are custom properties on the deck container, and
      // a custom property is inherited: writing one dirties the computed
      // style of every descendant of the container, so a drag that published
      // a fraction per frame had the engine recalculating style for the
      // whole deck — three transcripts, a rail — sixty times a second. That
      // reading was 31ms a frame on a working deck against 1ms at rest, and it
      // did not move when the divided cards grew by half, which is what says
      // it was the deck's style and not the cards' paint.
      //
      // So for the length of the gesture the members and the seams are
      // pinned INLINE, in px, on the elements themselves. `top` and `height`
      // are not inherited; a write to one dirties one element's style and
      // lays out one frame whose interior is held at a definite height, and
      // nothing below or beside it hears about it. The fractions are published
      // once, at the release, in the same task the inline pins come off in,
      // so the frames read the same geometry from the record they read from
      // before the hand touched them and no frame paints in between.
      //
      // `offsetTop` / `offsetHeight` rather than a client rect: they are in
      // the layout's own px, which is the unit the allocation is in, at every
      // zoom. One read per element at the latch, none per frame.
      //
      // An overflowing place is not pinned this way: its bounds collapse
      // ([Q01]) and the boundary cannot move, so the one strip coordinate is
      // published as before and the drag is a clamp.
      interface Pinned {
        el: HTMLElement;
        member: number;
        top0: number;
        height0: number;
        savedTop: string;
        savedHeight: string;
      }
      interface PinnedSeam {
        el: HTMLElement;
        boundary: number;
        top0: number;
        savedTop: string;
      }
      const pinned: Pinned[] = [];
      const pinnedSeams: PinnedSeam[] = [];
      const seamSelector =
        place.kind === "rail"
          ? `.tug-place-seam[data-rail-seam^="${place.side}:"]`
          : `.tug-place-seam[data-column-seam^="${place.slot}:"]`;
      const seamAttr = place.kind === "rail" ? "data-rail-seam" : "data-column-seam";
      const beginPins = (): void => {
        if (overflowing) return;
        for (const { member, el } of divided) {
          pinned.push({
            el,
            member,
            top0: el.offsetTop,
            height0: el.offsetHeight,
            savedTop: el.style.top,
            savedHeight: el.style.height,
          });
        }
        for (const el of container.querySelectorAll<HTMLElement>(seamSelector)) {
          const stamp = el.getAttribute(seamAttr) ?? "";
          const boundary = Number(stamp.slice(stamp.lastIndexOf(":") + 1));
          if (!Number.isInteger(boundary)) continue;
          pinnedSeams.push({ el, boundary, top0: el.offsetTop, savedTop: el.style.top });
        }
      };
      // Every pin handed back exactly as it was found — the calc() the frame
      // reads at rest — so a React render that sees the same string writes
      // nothing and the frame is standing on the record again. Idempotent: a
      // press that never latched pinned nothing and restores nothing.
      const releasePins = (): void => {
        for (const p of pinned.splice(0)) {
          p.el.style.top = p.savedTop;
          p.el.style.height = p.savedHeight;
        }
        for (const s of pinnedSeams.splice(0)) s.el.style.top = s.savedTop;
      };
      // The place as the hand is holding it, written on the elements: each
      // member's top and height, and each boundary's seam, from the same
      // cascade the release publishes through.
      const pin = (height: number): void => {
        const heights = cascadedHeights(start, membersRef.current, index, height);
        const tops: number[] = [];
        let top = 0;
        for (let k = 0; k < heights.length; k += 1) {
          tops.push(top);
          top += heights[k] + seamPx;
        }
        for (const p of pinned) {
          const dTop = (tops[p.member] ?? 0) - (start.tops[p.member] ?? 0);
          const dHeight =
            (heights[p.member] ?? 0) - (start.heights[p.member] ?? 0);
          p.el.style.top = `${p.top0 + dTop}px`;
          p.el.style.height = `${p.height0 + dHeight}px`;
        }
        for (const s of pinnedSeams) {
          const below = s.boundary + 1;
          const dTop = (tops[below] ?? 0) - (start.tops[below] ?? 0);
          s.el.style.top = `${s.top0 + dTop}px`;
        }
      };

      let latestY = startClientY;
      let moved = false;

      const latch = (clientY: number): boolean => {
        if (moved) return true;
        if (Math.abs(clientY - startClientY) < DRAG_MOVE_THRESHOLD_PX) {
          return false;
        }
        moved = true;
        return true;
      };

      // The height the pointer is asking for, clamped into the range the
      // allocator will honour. `seamDragBounds` never returns an inverted range
      // — it reports the height standing where it is instead — so a clamp is
      // the whole of it, and a collapsed range holds the current height rather
      // than snapping anywhere.
      const computeHeight = (): number => {
        const next = startHeight + (latestY - startClientY) / zoom;
        return Math.min(upper, Math.max(lower, next));
      };

      // Where the division the hand is holding is published, at the RELEASE.
      // An overflowing place writes the one boundary it moved; a shared one
      // writes EVERY seam, because a cascade moves the boundaries below the
      // one under the pointer too, and a frame still reading its old seam
      // would overlap the member that had just given room up.
      //
      // On the shown layer too, not the canvas alone. The layer carries its
      // own copy of every arrangement variable and its frames inherit from it,
      // so a write to the canvas alone put every member back at the division
      // the layer last rendered — the pre-gesture one — the moment the pins
      // came off, and the commit's settle then carried them from there to
      // where the hand had left them: a snap back and a slide forward at
      // every release. `applyScroll` meets the same shadow the same way.
      const shownLayer = container.querySelector<HTMLElement>(
        `.${SPACE_LAYER_CLASS}[${SPACE_SHOWN_ATTRIBUTE}]`,
      );
      const setArrangement = (name: string, value: string): void => {
        container.style.setProperty(name, value);
        shownLayer?.style.setProperty(name, value);
      };
      const publish = (height: number): void => {
        if (overflowing) {
          setArrangement(property, `${Math.round(valueOf(height))}px`);
          return;
        }
        const heights = cascadedHeights(
          start,
          membersRef.current,
          index,
          height,
        );
        let top = 0;
        for (let k = 0; k < heights.length - 1; k += 1) {
          top += heights[k];
          setArrangement(
            seamPropertyOf(place, k),
            String((top + seamPx / 2) / run),
          );
          top += seamPx;
        }
      };

      // Straight from the pointer handler, with no animation-frame hop: a
      // property write is cheap, style resolves once per rendering update
      // however many writes precede it, and the hop had no case where it
      // gained a frame and one where it could lose one ([B04]).
      const onPointerMove = (e: PointerEvent): void => {
        latestY = e.clientY;
        const wasMoved = moved;
        if (!latch(latestY)) return;
        // At the latch, before the first write: the one layout the interior
        // takes is the one at the held height, and every frame after it moves
        // only the frame's edge.
        if (!wasMoved) {
          beginHold();
          beginPins();
        }
        const height = computeHeight();
        if (overflowing) publish(height);
        else pin(height);
      };

      const onPointerUp = (e: PointerEvent): void => {
        seam.removeEventListener("pointermove", onPointerMove);
        seam.removeEventListener("pointerup", onPointerUp);
        seam.removeEventListener("pointercancel", onPointerCancel);
        seam.releasePointerCapture(e.pointerId);
        seam.removeAttribute("data-gesture");
        latestY = e.clientY;
        try {
          if (!latch(latestY)) return;
          const height = computeHeight();
          // The record and the pins change hands in one task: the fractions
          // go on the container and the inline px come off the frames before
          // anything paints, so the commit re-renders at this division and
          // the inset effect writes the same number back. There is no frame
          // where a member reads the pre-gesture seam.
          publish(height);
          releasePins();
          // Released BEFORE the commit, the way every other gesture machine
          // releases it ([P11]).
          //
          // It is tempting to hold the mark through the commit — the members
          // are already drawn at their new heights, so the settle would only
          // carry them from where they are to where they already are. But the
          // settle reads the mark TWICE, at two different moments, and the
          // pointerup handler only spans the first. The arm (the First pass)
          // runs synchronously inside the commit and skips a pointer-owned
          // frame, leaving it with no First rect; the Last pass runs later,
          // from the layout effect of the render the commit caused, by which
          // time this handler has returned and the mark is gone. A frame with
          // no First rect and no mark is what the Last pass calls an ARRIVAL,
          // so both members were being held at `opacity: 0` and faded back up
          // — the two cards the hand had just been holding flashing to
          // invisible at the release.
          //
          // Clearing first costs the redundant zero-distance carry and buys
          // the frames a First rect equal to their Last, which is the honest
          // description of what the release did: nothing moved, because the
          // hand had already moved it.
          for (const { el } of divided) el.removeAttribute("data-pointer-owned");
          // The hold comes off with the mark, and for the same reason: the
          // interior takes its one layout at the final height here, before the
          // commit re-renders at it.
          releaseHold();
          onCommit(place, index, valueOf(height));
        } finally {
          // And on EVERY path out, which is what the `finally` is for. A press
          // that never travelled commits nothing and returns above; a mark left
          // standing there would exempt both members from every settle for the
          // rest of the session, and the seam's own double-click equalize is
          // two such presses — so the leak would land first on the gesture that
          // most needs its members carried. Idempotent against the release
          // above, which is the path that matters.
          for (const { el } of divided) el.removeAttribute("data-pointer-owned");
          releasePins();
          releaseHold();
        }
      };

      // A gesture the system takes away never sees a `pointerup`, so the mark
      // has no other way off. Nothing commits — a cancelled drag is not a
      // placement — but the members stop being the hand's, because a mark that
      // outlives the listener meant to clear it is a frame the settle skips
      // for the rest of the session. The pins come off the same way, and the
      // frames stand where the record says.
      const onPointerCancel = (): void => {
        seam.removeEventListener("pointermove", onPointerMove);
        seam.removeEventListener("pointerup", onPointerUp);
        seam.removeEventListener("pointercancel", onPointerCancel);
        seam.removeAttribute("data-gesture");
        for (const { el } of divided) el.removeAttribute("data-pointer-owned");
        releasePins();
        releaseHold();
      };

      seam.addEventListener("pointermove", onPointerMove);
      seam.addEventListener("pointerup", onPointerUp);
      seam.addEventListener("pointercancel", onPointerCancel);
    },
    [place, index, onCommit],
  );

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      beginDrag(event.currentTarget, event.pointerId, event.clientY);
    },
    [beginDrag],
  );

  // A column's seam is also the drag behind its members' inner edges: under
  // the keep-slot rule a member's top or bottom edge that borders this seam
  // starts this very gesture rather than one of its own.
  // Registered by the seam's address alone and read through a ref, because
  // `place` is a fresh object every render and a registration keyed on it
  // would come off and go back on at every one.
  const beginDragRef = useRef(beginDrag);
  beginDragRef.current = beginDrag;
  const columnSlot = place.kind === "column" ? place.slot : undefined;
  useLayoutEffect(() => {
    if (columnSlot === undefined) return;
    return registerColumnSeamDrag(columnSlot, index, (pointerId, clientY) => {
      const seam = seamRef.current;
      if (seam !== null) beginDragRef.current(seam, pointerId, clientY);
    });
  }, [columnSlot, index]);

  // A double-click on a COLUMN seam divides the slot equally again — the one
  // arithmetic a place has that is not the hand's own division. A rail's seam
  // does nothing on a double-click: its sashes are the hand's, and nothing but
  // the hand moves one ([B03]).
  const handleDoubleClick = useCallback(() => {
    if (place.kind === "rail") return;
    dispatchCommand(TUG_ACTIONS.EQUALIZE_COLUMN, { slot: place.slot });
  }, [place]);

  // Only the vertical placement is the seam's own, and it is the same
  // expression the frames either side of it read — forked the way their pins
  // are. A shared place states the boundary as a fraction of the run; an
  // overflowing one states it as the strip coordinate of the lower member's
  // top, less the half-seam the boundary sits in the middle of, slid by the
  // strip's own offset. That last term is what makes a sash on an overflowing
  // place ride the strip it divides instead of standing still while the members
  // scroll behind it.
  const runTop = placeRunTopPx(place);
  const runExtent = `(100% - ${runTop}px - ${placeRunBottomPx(place)}px)`;
  const strip = stripCoordinatesOf(allocation);
  const centre =
    strip === undefined
      ? `calc(${runTop}px + var(${seamPropertyOf(place, index)}, ` +
        `${(index + 1) / allocation.ids.length})` +
        ` * ${runExtent})`
      : `calc(${runTop}px + var(${stripPropertyOf(place, index + 1)}, ` +
        `${Math.round(strip[index + 1] ?? 0)}px) - ${placeSeamPx(place) / 2}px` +
        ` - min(var(${offsetPropertyOf(place)}, 0px), max(0px, ` +
        `var(${stripPropertyOf(place, allocation.ids.length)}, ` +
        `${Math.round(strip[allocation.ids.length] ?? 0)}px) - ${runExtent})))`;

  return (
    <div
      ref={seamRef}
      className="tug-place-seam"
      data-testid={
        place.kind === "rail" ? "tug-rail-seam" : "tug-column-seam"
      }
      {...(place.kind === "rail"
        ? { "data-rail-seam": `${place.side}:${index}` }
        : { "data-column-seam": `${place.slot}:${index}` })}
      {...(railTravel !== undefined ? { [RAIL_TRAVEL_ATTR]: railTravel } : {})}
      {...(parked && place.kind === "rail" ? { "data-rail-parked": place.side } : {})}
      role="separator"
      aria-orientation="horizontal"
      onPointerDown={handlePointerDown}
      onDoubleClick={handleDoubleClick}
      style={{
        ...frameStyle,
        position: "absolute",
        top: `calc(${centre} - ${RAIL_SEAM_HIT_PX / 2}px)`,
        bottom: "auto",
        height: `${RAIL_SEAM_HIT_PX}px`,
        zIndex: RAIL_SEAM_ZINDEX,
        cursor: "row-resize",
      }}
    />
  );
}

// ---- DeckCanvas ----

/**
 * Which workspace a verb acts on: the one its payload names, or — when it
 * names none — the ACTIVE one ([P02]). That default is what lets the Window
 * menu fire the same verb the card's `···` does, and it is written once here
 * rather than four times in the handlers.
 *
 * `null` when the payload names a workspace the deck does not hold, or when
 * there is no active workspace to fall back to; the caller does nothing.
 */
function targetSpaceId(
  store: IDeckManagerStore,
  raw: unknown,
): string | null {
  const snapshot = store.getSpacesSnapshot();
  if (typeof raw === "string") {
    if (!snapshot.spaces.some((s) => s.id === raw)) {
      console.warn(`workspace verb: no space with id "${raw}"`);
      return null;
    }
    return raw;
  }
  return snapshot.activeSpaceId ?? null;
}

/**
 * The actions DeckCanvas genuinely implements (its actions-map keys).
 *
 * DeckCanvas's `canHandle: () => true` is a *dispatch* last-resort so
 * chain-action buttons stay enabled in practice ([D08]); it must NOT make
 * `validateAction` answer true for every action, or every menu item gated
 * on `chain.validateAction(...)` would light up the moment any card is
 * focused (the chain always reaches this root). `validateAction` below
 * affirms only the canvas's real capabilities; everything else falls
 * through as disabled — keep this set in sync with the actions map.
 */
const DECK_CANVAS_VALIDATED_ACTIONS: ReadonlySet<string> = new Set([
  // The lateral card ring crosses pane boundaries, so the canvas — the one
  // responder that can see every pane — owns both directions outright.
  TUG_ACTIONS.PREVIOUS_TAB,
  TUG_ACTIONS.NEXT_TAB,
  TUG_ACTIONS.SHOW_SETTINGS,
  TUG_ACTIONS.SHOW_KEYBOARD_SHORTCUTS,
  TUG_ACTIONS.SHOW_DEVTOOLS,
  TUG_ACTIONS.TOGGLE_JOTS,
  TUG_ACTIONS.TOGGLE_OVERVIEW,
  TUG_ACTIONS.TOGGLE_RAIL,
  TUG_ACTIONS.NEW_JOT,
  TUG_ACTIONS.SHOW_COMPONENT_GALLERY,
  TUG_ACTIONS.ADD_CARD_TO_ACTIVE_PANE,
  TUG_ACTIONS.CLOSE,
  TUG_ACTIONS.CLOSE_ALL,
  TUG_ACTIONS.OPEN_FILE,
  TUG_ACTIONS.REVEAL_IN_FINDER,
  TUG_ACTIONS.LOOK_UP_IN_DICTIONARY,
  TUG_ACTIONS.MOVE_TO_SLOT,
  TUG_ACTIONS.GO_TO_SLOT,
  TUG_ACTIONS.FOCUS_CARD,
  TUG_ACTIONS.NUDGE_SLOT,
  TUG_ACTIONS.TOGGLE_COLUMN_SPLIT,
  TUG_ACTIONS.MOVE_IN_COLUMN,
  TUG_ACTIONS.SET_PANE_WIDTH,
  TUG_ACTIONS.TOGGLE_BULLSEYE,
  TUG_ACTIONS.TOGGLE_CARD_FOLD,
  TUG_ACTIONS.NEW_TEXT_CARD,
  TUG_ACTIONS.OPEN_QUICKLY,
  TUG_ACTIONS.CLEAR_RECENT_DOCUMENTS,
  TUG_ACTIONS.FOCUS_PANE,
  TUG_ACTIONS.ACTIVATE_SPACE,
  // The four workspace verbs ([P02]). They validate here for the same reason
  // they are answered here: the Window menu's rows are gated on the chain's
  // answer, and the chain always reaches this root.
  TUG_ACTIONS.NEW_SPACE,
  TUG_ACTIONS.RENAME_SPACE,
  TUG_ACTIONS.DUPLICATE_SPACE,
  TUG_ACTIONS.DELETE_SPACE,
]);

/**
 * One mounted workspace's standing in the canvas ([B06]).
 *
 * `deck` is the live `deckState` for the shown layer and the parked record
 * off the spaces snapshot for every other. Nothing here reads a deck out of
 * the store in a render body — see the memo that builds these.
 */
interface SpaceLayer {
  spaceId: string;
  shown: boolean;
  deck: DeckState;
}

/** What `imposeStyle` places a frame by — a slot anchor, with its flow strip position when the deck flows. */
type PanePlacement = Parameters<typeof imposeStyle>[0];

/**
 * Everything a workspace's panes are ARRANGED BY, derived from its deck and
 * nothing else — the rails and their allocation, the columns and theirs, the
 * flow strip, every per-pane placement, and the maps the pane render reads.
 *
 * It exists as one value rather than a dozen memos because a hidden
 * workspace layer needs it too. A hidden layer keeps its layout ([B02]), and
 * a layer laid out without its arrangement is laid out WRONG: every parked
 * pane stood at its free rect, the whole workspace was re-imposed in the
 * commit that revealed it, and the departing one was re-laid out back to its
 * free rects, unpainted. That re-arrangement was the largest late write a
 * switch made, and the source of every geometry re-read the arriving panes
 * paid — a transcript pinning its scroll against a viewport that had just
 * changed height, a clamp measuring a frame that had just moved. With each
 * layer arranged from its own deck a switch moves nothing: the arriving panes
 * are already standing where they will be shown, and the departing ones stay
 * where they were.
 *
 * The shown layer's arrangement is derived from the live `deckState`; a
 * hidden layer's from the parked record on the spaces snapshot, cached by
 * that record's identity ({@link arrangementOfParkedDeck}). A parked deck is
 * the relaunch shape — `parkedDeck` strips the strip offsets, the bullseye
 * and the arrival marks — so a parked layer stands as it would after a
 * restart, and `_resolveShownArrangement` re-solves it against the canvas in
 * the swap commit, which is where a window resized while it was parked is
 * corrected: in the commit that shows it, with nothing left to arm.
 */
interface LayerArrangement {
  readonly sidebarPaneIds: ReadonlySet<string>;
  readonly sidebarRails: ReturnType<typeof sidebarRailsOf>;
  readonly flowStrip: ReturnType<typeof deckFlowStrip>;
  readonly flowOffset: number;
  readonly deckColumns: ReturnType<typeof deckColumnsOf>;
  readonly columnOffsets: NonNullable<DeckState["columnOffsets"]>;
  readonly railOffsets: NonNullable<DeckState["railOffsets"]>;
  readonly columnMemberByPaneId: ReadonlyMap<string, ColumnMemberPlacement>;
  readonly columnModeByPaneId: ReadonlyMap<string, ColumnMode>;
  readonly arrivingSeatByPaneId: ReadonlyMap<string, ArrivingSeat>;
  readonly railWidthOf: (side: SidebarSide) => number;
  readonly vacantRails: readonly { side: SidebarSide; style: React.CSSProperties }[];
  readonly stackByPaneId: ReadonlyMap<string, SidebarStackStanding>;
  /** The side each PARKED rail member is parked on — its rail hidden whole.
   *  Such a pane is in no rail (`stackByPaneId` lacks it) and keeps its frame
   *  mounted, hidden, at its pinned box. */
  readonly parkedRailSideByPaneId: ReadonlyMap<string, SidebarSide>;
  /** The sides whose rail is PARKED — hidden whole, its members on the deck. */
  readonly parkedRailSides: ReadonlySet<SidebarSide>;
  /** The rails as they would stand with every hide's memory cleared: the
   *  standing rails, plus each parked side's. A parked side's chrome — its
   *  shadow, its seams, the vacancy held open opposite it — is drawn from
   *  these, hidden, so the show that stands it again mounts none of it. */
  readonly pictureRails: readonly SidebarRail[];
  /** {@link vacantRails} reckoned over {@link pictureRails}: the held-open
   *  edges the deck would draw were every parked rail standing. */
  readonly pictureVacantRails: readonly { side: SidebarSide; style: React.CSSProperties }[];
  readonly sortedStacks: readonly TugPaneState[];
  readonly zIndexMap: ReturnType<typeof buildZIndexMap>;
  readonly hostStackIdByCardId: ReadonlyMap<string, string>;
  readonly cardsById: ReadonlyMap<string, DeckState["cards"][number]>;
  readonly impositionKind: DeckState["imposition"]["kind"];
  readonly placementFor: (pane: TugPaneState) => PanePlacement | undefined;
  readonly contentWidthPx: number;
  readonly bullseyePaneId: string | null;
  readonly bullseyeAnchorCentre: string | undefined;
  /** The panes the shown deck is carrying out, rendered `departing` at the
   *  place they stood ({@link deriveShownArrangement}). Empty on every other
   *  arrangement. */
  readonly departingPaneIds: ReadonlySet<string>;
}

/**
 * The held-open deck edge: one tile for the side with no rail while the other
 * side has one, at the rail's anchor and the width a rail card landing there
 * would take.
 */
function railVacanciesOf(
  rails: readonly SidebarRail[],
): { side: SidebarSide; style: React.CSSProperties }[] {
  if (rails.length !== 1) return [];
  const standing = rails[0];
  const side: SidebarSide = standing.side === "left" ? "right" : "left";
  return [
    {
      side,
      style: imposeSidebarStyle(side, standing.width, {
        widthProperty: sidebarWidthProperty(standing.side),
      }),
    },
  ];
}

/**
 * Derive a deck's arrangement. Pure over its inputs. A pane's place in its
 * run — the badge's count, band and picker rows — is not here: the badge
 * reads it itself (`pane-place-facts.ts`), so a member coming or going
 * re-renders no other member's frame.
 */
function deriveLayerArrangement(
  deck: DeckState,
  placeRuns: PlaceRuns,
): LayerArrangement {
  const panes = deck.panes;
  const cards = deck.cards;
  const imposition = deck.imposition;

  // Every pane hosting a sidebar card, pinned or dragged loose. They share the
  // z-band above the free panes: a rail must never be occluded by a card, and
  // that is a property of being a rail rather than of any one card on it.
  const sidebarPaneIds = new Set(
    findSidebarPanes(deck).map(({ pane }) => pane.id),
  );
  // The rails standing on the deck's edges, and the stack membership each
  // sidebar pane derives its frame from. A closed or unpinned sidebar card
  // holds no side and is absent: the arrangement spans what its rail is not
  // taking, which when nothing is pinned is the whole canvas.
  const sidebarRails = sidebarRailsOf(deck, placeRuns);
  const flowStrip = deckFlowStrip(deck);
  const flowOffset = deck.flowOffset ?? 0;
  const deckColumns = deckColumnsOf(deck, placeRuns.column);
  const columnOffsets = deck.columnOffsets ?? EMPTY_COLUMN_OFFSETS;
  const railOffsets = deck.railOffsets ?? EMPTY_RAIL_OFFSETS;

  const columnMemberByPaneId = new Map<string, ColumnMemberPlacement>();
  for (const column of deckColumns) {
    if (!columnDrawsSplit(column)) continue;
    const strip = stripCoordinatesOf(column.allocation);
    column.members.forEach((paneId, index) => {
      columnMemberByPaneId.set(paneId, {
        slot: column.slot,
        index,
        count: column.members.length,
        standing: column.allocation?.standing ?? "shared",
        ...(strip === undefined ? {} : { strip }),
      });
    });
  }
  const columnModeByPaneId = new Map<string, ColumnMode>();
  for (const column of deckColumns) {
    for (const paneId of column.members) columnModeByPaneId.set(paneId, column.mode);
  }
  const arrivingSeatByPaneId = new Map<string, ArrivingSeat>();
  {
    const marks = deck.arriving;
    const kind = imposition.kind;
    if (marks !== undefined && kind !== undefined) {
      for (const pane of panes) {
        if (marks[pane.id] !== true) continue;
        if (pane.slot === undefined) continue;
        const slot = clampSlot(kind, pane.slot);
        const column = deckColumns.find((c) => c.slot === slot);
        arrivingSeatByPaneId.set(
          pane.id,
          column !== undefined &&
            column.mode === "split" &&
            column.members.length > 0
            ? "bottom"
            : "run",
        );
      }
    }
  }
  const railWidthOf = (side: SidebarSide): number =>
    sidebarRails.find((rail) => rail.side === side)?.width ?? 0;
  const vacantRails = railVacanciesOf(sidebarRails);
  const stackByPaneId = new Map<string, SidebarStackStanding>();
  for (const rail of sidebarRails) {
    const strip = stripCoordinatesOf(rail.allocation);
    rail.members.forEach((member, index) => {
      stackByPaneId.set(member.paneId, {
        side: rail.side,
        componentId: member.componentId,
        count: rail.members.length,
        memberIndex: index,
        standing: rail.allocation?.standing ?? "shared",
        ...(strip === undefined ? {} : { strip }),
      });
    });
  }

  const parkedRailSideByPaneId = new Map<string, SidebarSide>();
  for (const { componentId, pane } of findSidebarPanes(deck)) {
    if (isSidebarParked(deck, componentId)) {
      parkedRailSideByPaneId.set(pane.id, sidebarSide(imposition, componentId));
    }
  }
  const parkedRailSides = new Set(parkedRailSideByPaneId.values());
  let pictureRails: readonly SidebarRail[] = sidebarRails;
  if (parkedRailSides.size > 0) {
    pictureRails = sidebarRailsOf({ ...deck, imposition: withEveryHideCleared(imposition) }, placeRuns);
  }
  const pictureVacantRails = railVacanciesOf(pictureRails);

  // Stable ID order: no DOM reordering on focus change. Z-index from the
  // store's array position (first = lowest), rails above every free pane.
  const sortedStacks = [...panes].sort((a, b) => a.id.localeCompare(b.id));
  const zIndexMap = buildZIndexMap(panes, sidebarPaneIds);

  const hostStackIdByCardId = new Map<string, string>();
  for (const s of panes) {
    for (const cid of s.cardIds) hostStackIdByCardId.set(cid, s.id);
  }
  const cardsById = new Map<string, (typeof cards)[number]>();
  for (const c of cards) cardsById.set(c.id, c);

  // Where each imposed pane stands. In FLOW that is exactly what it is: a
  // slot's place is the running sum of every occupied slot before it, and the
  // strip position rides down on the placement itself, so no pane ever
  // re-derives deck-wide geometry from its own props ([P09]).
  const impositionKind = imposition.kind;
  const placementFor = (pane: TugPaneState): PanePlacement | undefined => {
    if (impositionKind === undefined || pane.slot === undefined) {
      return undefined;
    }
    const placement = resolvePlacement(impositionKind, pane.slot);
    const stripLeft = flowStrip?.positions.get(placement.slot);
    return stripLeft === undefined
      ? placement
      : { ...placement, flow: { stripLeft } };
  };
  // The width an ordinary card opens at in this arrangement — the
  // arrangement's number, not any one card's; read only by a size-locked pane
  // to size the SLOT it is centred in.
  const contentWidthPx = resolveContentWidthPx(
    imposition.contentWidth ?? DEFAULT_CONTENT_WIDTH,
    0,
  );

  // The pane standing in bullseye, and where it WAS before it took the
  // posture — its centre, as a CSS length expression, in the frames
  // container's coordinates. The other content panes are sorted around that
  // line so each leaves by the side it was already on and no crossing is
  // possible by construction.
  const bullseyePaneId = bullseyePaneIdOf(deck);
  const bullseyeAnchorCentre = ((): string | undefined => {
    if (bullseyePaneId === null) return undefined;
    const pane = panes.find((p) => p.id === bullseyePaneId);
    if (pane === undefined) return undefined;
    const railStanding = stackByPaneId.get(pane.id);
    if (railStanding !== undefined) {
      const railWidth = railWidthOf(railStanding.side);
      const half = `var(${sidebarWidthProperty(railStanding.side)}, ${railWidth}px) / 2`;
      return railStanding.side === "left"
        ? `calc(${RAIL_EDGE_INSET_PX}px + ${half})`
        : `calc(100% - ${RAIL_EDGE_INSET_PX}px - ${half})`;
    }
    const placement = placementFor(pane);
    const left =
      placement === undefined
        ? `${pane.position.x}px`
        : String(imposeStyle(placement, pane.size.width).left ?? "0px");
    return `calc(${left} + ${pane.size.width / 2}px)`;
  })();

  return {
    sidebarPaneIds,
    sidebarRails,
    flowStrip,
    flowOffset,
    deckColumns,
    columnOffsets,
    railOffsets,
    columnMemberByPaneId,
    columnModeByPaneId,
    arrivingSeatByPaneId,
    railWidthOf,
    vacantRails,
    stackByPaneId,
    parkedRailSideByPaneId,
    parkedRailSides,
    pictureRails,
    pictureVacantRails,
    sortedStacks,
    zIndexMap,
    hostStackIdByCardId,
    cardsById,
    impositionKind,
    placementFor,
    contentWidthPx,
    bullseyePaneId,
    bullseyeAnchorCentre,
    departingPaneIds: NO_DEPARTING,
  };
}

/**
 * The SHOWN deck's arrangement, which is the one deck that can be carrying a
 * pane out.
 *
 * The store publishes a closed pane, its cards and a `departing` mark for one
 * settle (`lib/departing.ts`), and the canvas draws that pane where it stood
 * so the settle can run its `depart` beat on the real frame. Two arrangements
 * answer that:
 *
 * - the STANDING one, over the deck without the departing panes, which is
 *   where every survivor goes: they take the room the close gave up;
 * - the PICTURE, over the deck as if the departing panes still stood, which is
 *   where each departing pane is drawn — its placement, its column band, its
 *   rail seat.
 *
 * The collections come from the picture for EVERY pane while anything
 * departs: the frames to render (so the departing one renders at all), the
 * cards and their hosts (so its content is not unmounted at frame one), and
 * the z-map. That last one cannot be split per pane: `buildZIndexMap` ranks
 * by array position, so a standing map gives the survivor that took the
 * closed pane's position the same `zIndex` the picture gives the departing
 * pane. Survivors' relative order is the same in both maps.
 *
 * Identity with {@link deriveLayerArrangement} when nothing departs.
 */
function deriveShownArrangement(
  deck: DeckState,
  placeRuns: PlaceRuns,
): LayerArrangement {
  const standing = deriveLayerArrangement(standingDeck(deck), placeRuns);
  const marks = deck.departing;
  if (marks === undefined) return standing;
  const picture = deriveLayerArrangement(withDepartingStanding(deck), placeRuns);
  const departing = new Set(Object.keys(marks));
  const theirs = <V,>(
    ours: ReadonlyMap<string, V>,
    pictured: ReadonlyMap<string, V>,
  ): ReadonlyMap<string, V> => {
    const merged = new Map(ours);
    for (const paneId of departing) {
      merged.delete(paneId);
      const value = pictured.get(paneId);
      if (value !== undefined) merged.set(paneId, value);
    }
    return merged;
  };
  return {
    ...standing,
    sidebarPaneIds: picture.sidebarPaneIds,
    columnMemberByPaneId: theirs(standing.columnMemberByPaneId, picture.columnMemberByPaneId),
    columnModeByPaneId: theirs(standing.columnModeByPaneId, picture.columnModeByPaneId),
    stackByPaneId: theirs(standing.stackByPaneId, picture.stackByPaneId),
    parkedRailSideByPaneId: theirs(
      standing.parkedRailSideByPaneId,
      picture.parkedRailSideByPaneId,
    ),
    placementFor: (pane) =>
      departing.has(pane.id) ? picture.placementFor(pane) : standing.placementFor(pane),
    sortedStacks: picture.sortedStacks,
    zIndexMap: picture.zIndexMap,
    hostStackIdByCardId: picture.hostStackIdByCardId,
    cardsById: picture.cardsById,
    departingPaneIds: departing,
  };
}

/**
 * A parked deck's arrangement, cached by the record's identity. A parked
 * record is immutable — `parkedDeck` mints one at the switch away and nothing
 * touches it until the workspace returns — so its arrangement is derived once
 * per record per run height, however many times the canvas renders in
 * between.
 */
const parkedArrangements = new WeakMap<
  DeckState,
  { rail: PlaceRuns["rail"]; column: PlaceRuns["column"]; value: LayerArrangement }
>();
function arrangementOfParkedDeck(
  deck: DeckState,
  placeRuns: PlaceRuns,
): LayerArrangement {
  const hit = parkedArrangements.get(deck);
  if (
    hit !== undefined &&
    hit.rail === placeRuns.rail &&
    hit.column === placeRuns.column
  ) {
    return hit.value;
  }
  const value = deriveLayerArrangement(deck, placeRuns);
  parkedArrangements.set(deck, {
    rail: placeRuns.rail,
    column: placeRuns.column,
    value,
  });
  return value;
}

/**
 * Write the custom properties an arrangement's `calc()` chains resolve
 * against — rail widths and insets, rail and column seams, strip coordinates,
 * overflow offsets, the flow strip — onto `el`.
 *
 * Called on the CANVAS for the shown deck, where the seams, caps and drop
 * zones outside every layer read them, and on EVERY layer wrapper for that
 * layer's own deck. A wrapper carries its own copy so a hidden layer's frames
 * resolve their placement against their own rails rather than the shown
 * deck's ([B02]): a custom property inherits through the hidden wrapper's box
 * and through the shown wrapper's `display: contents` alike. The shown
 * wrapper's values equal the canvas's, so nothing is written on a switch.
 *
 * `columnRun` is the column run's measured height, for the offset gauge; the
 * gauges themselves (`publish*`) are the deck's and are published by the
 * canvas alone.
 */
function writeArrangementVariables(
  el: HTMLElement,
  a: LayerArrangement,
  columnRun: number | null,
  publish: boolean,
): void {
  for (const side of ["left", "right"] as const) {
    const width = a.railWidthOf(side);
    el.style.setProperty(sidebarWidthProperty(side), `${width}px`);
    el.style.setProperty(
      `--tug-imposer-inset-${side}`,
      width === 0
        ? "0px"
        : railSpanInset(`var(${sidebarWidthProperty(side)})`),
    );
    const rail = a.sidebarRails.find((r) => r.side === side);
    const railOverflows = rail?.allocation?.standing === "overflow";
    const seams = railOverflows ? [] : (rail?.seams ?? []);
    seams.forEach((fraction, index) => {
      el.style.setProperty(railSeamProperty(side, index), String(fraction));
    });
    for (
      let index = seams.length;
      index <= SIDEBAR_PANE_ZINDEX_MAX_RANK;
      index += 1
    ) {
      el.style.removeProperty(railSeamProperty(side, index));
    }
    if (railOverflows) {
      el.style.setProperty(
        railOffsetProperty(side),
        `${Math.round(a.railOffsets[side] ?? 0)}px`,
      );
    } else {
      el.style.removeProperty(railOffsetProperty(side));
    }
    const railStrip = stripCoordinatesOf(rail?.allocation) ?? [];
    railStrip.forEach((coordinate, index) => {
      el.style.setProperty(
        railStripProperty(side, index),
        `${Math.round(coordinate)}px`,
      );
    });
    for (
      let index = railStrip.length;
      index <= SIDEBAR_PANE_ZINDEX_MAX_RANK + 1;
      index += 1
    ) {
      el.style.removeProperty(railStripProperty(side, index));
    }
  }
  const overflowing = (column: DeckColumn): boolean =>
    column.allocation?.standing === "overflow";
  const seamsBySlot = new Map(
    a.deckColumns.map((column) => [
      column.slot,
      overflowing(column) ? [] : column.seams,
    ]),
  );
  const offsetBySlot = new Map(
    a.deckColumns
      .filter(overflowing)
      .map((column) => [column.slot, a.columnOffsets[column.slot] ?? 0]),
  );
  const stripBySlot = new Map(
    a.deckColumns.map((column) => [
      column.slot,
      stripCoordinatesOf(column.allocation) ?? [],
    ]),
  );
  for (let slot = 0; slot <= COLUMN_SEAM_MAX_SLOT; slot += 1) {
    const seams = seamsBySlot.get(slot) ?? [];
    seams.forEach((fraction, index) => {
      el.style.setProperty(columnSeamProperty(slot, index), String(fraction));
    });
    for (
      let index = seams.length;
      index <= COLUMN_SEAM_MAX_INDEX;
      index += 1
    ) {
      el.style.removeProperty(columnSeamProperty(slot, index));
    }
    const offset = offsetBySlot.get(slot);
    if (offset === undefined) {
      el.style.removeProperty(columnOffsetProperty(slot));
    } else {
      el.style.setProperty(
        columnOffsetProperty(slot),
        `${Math.round(offset)}px`,
      );
    }
    const columnStrip = stripBySlot.get(slot) ?? [];
    columnStrip.forEach((coordinate, index) => {
      el.style.setProperty(
        columnStripProperty(slot, index),
        `${Math.round(coordinate)}px`,
      );
    });
    for (
      let index = columnStrip.length;
      index <= COLUMN_SEAM_MAX_INDEX + 1;
      index += 1
    ) {
      el.style.removeProperty(columnStripProperty(slot, index));
    }
    if (publish) {
      publishColumnOffset(
        slot,
        offset === undefined || columnRun === null || columnRun <= 0
          ? null
          : offset / columnRun,
      );
    }
  }
  // The strip's LENGTH stays a property on `el`, inherited and read by every
  // reader's clamp: it changes only on a commit that re-lays the strip out.
  // The OFFSET does not inherit ([D204]); `flow-offset.ts` writes it on the
  // readers alone — the canvas's own vacancies and seams plus the shown
  // layer's frames when `el` is the canvas, this layer's frames when it is
  // a layer, shown or not.
  if (a.flowStrip === null) {
    el.style.removeProperty(FLOW_STRIP_PROPERTY);
  } else {
    el.style.setProperty(FLOW_STRIP_PROPERTY, `${a.flowStrip.width}px`);
  }
  const offset = a.flowStrip === null ? null : Math.round(a.flowOffset);
  if (publish) writeCanvasFlowOffset(el, offset);
  else writeLayerFlowOffset(el, offset);
}

/**
 * One workspace layer: the wrapper `space-layer.css` keys on, carrying its
 * own deck's arrangement variables so its frames stand where that deck puts
 * them whether or not the layer is shown ([B02]). The attribute is the whole
 * of what a switch changes on it; the variables are the layer's own and do
 * not move on a switch.
 */
function SpaceLayerWrapper({
  spaceId,
  shown,
  arrangement,
  columnRun,
  children,
}: {
  spaceId: string;
  shown: boolean;
  arrangement: LayerArrangement;
  columnRun: number | null;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return;
    writeArrangementVariables(el, arrangement, columnRun, false);
  }, [arrangement, columnRun]);
  return (
    <div
      ref={ref}
      className="tug-space-layer"
      data-space-layer={spaceId}
      {...(shown ? { "data-space-shown": "" } : {})}
    >
      {children}
    </div>
  );
}

/**
 * The callbacks `LayerPanes` hands each `TugPane`, made once per stack and
 * kept: a memoized pane compares its props, and a closure minted per render
 * never compares equal.
 */
interface StackCallbacks {
  readonly onClose: () => void;
  readonly onMoveToSpace: (spaceId: string) => void;
  readonly onCardMerged: (
    sourceStackId: string,
    targetStackId: string,
    insertIndex: number,
  ) => void;
}

/**
 * One workspace's panes and card hosts, from its own deck and its own
 * arrangement — the whole of what a layer renders under its wrapper.
 *
 * **Memoized, and the memo holds for every workspace that STAYS parked
 * ([B02]).** The canvas re-renders on every store commit, and a switch is one;
 * without a boundary here that render reached every pane and every card host
 * of every mounted workspace, shown or not, the same whether the arriving
 * workspace held twelve cards or one. A parked layer's props are all stable:
 * its deck is the record the store holds for it, its arrangement is cached
 * per deck (`arrangementOfParkedDeck`), it takes no handlers a hidden pane
 * could reach, and the store is a singleton. So a layer that is parked before
 * and after a commit is skipped whole — read off the fiber tree, every prop
 * identical across a switch.
 *
 * What it does NOT skip is the two layers a switch changes hands between:
 * `shown` flips, `onRevealPane` and `dropZones` come and go with it, the
 * leaving deck is `parkedDeck`'s fresh copy and the arriving one is the
 * store's re-solve, so both arrangements are minted new and both render
 * whole. On a three-workspace deck that is most of the render phase, and the
 * boundary is worth the one layer of six that stayed parked; a deck with
 * more workspaces gets more of it. Letting the switching pair bail out too
 * needs identity kept through parking and re-solving, and handlers given to
 * every layer and inert when hidden, the shape `onMoveToSpace` already
 * takes — `briefs/workspace-switch-cheap-readings.md` has the numbers.
 *
 * The workspace list the title bar's move control needs is deliberately NOT
 * a prop: threaded through here it changed on every switch and broke the
 * boundary for every layer at once. The bar reads it off the store itself.
 *
 * **The boundary is instrumented, and the instrument is armed by kind.** The
 * layout effect below has no dependency list, so it runs once per commit of
 * THIS component — never for a commit the memo bailed out of — and when the
 * `layer-render` trace kind is armed it records one row per commit, keyed by
 * `spaceId`. A test that switches between two workspaces on a deck with a
 * third mounted reads those rows and asserts the third's count is zero; that
 * is the one number that says the memo boundary held, and it cannot flap. At
 * rest the effect is one `isKindEnabled` read per commit of a layer that
 * rendered anyway, and it records nothing.
 */
const LayerPanes = memo(function LayerPanes({
  spaceId,
  shown,
  deck,
  arr,
  store,
  onRevealPane,
  dropZones,
}: {
  spaceId: string;
  shown: boolean;
  deck: DeckState;
  arr: LayerArrangement;
  store: IDeckManagerStore;
  onRevealPane: TugPaneProps["onRevealPane"];
  dropZones: DropZoneHost | undefined;
}) {
  useLayoutEffect(() => {
    if (!deckTrace.isKindEnabled("layer-render")) return;
    deckTrace.record({ kind: "layer-render", spaceId, shown });
  });
  // Whether THIS layer is the shown one, as of the last commit, for the
  // handlers below to ask at call time. Every pane takes the same handlers
  // whether its layer is shown or not, and the hidden ones are made inert
  // HERE rather than by withholding them: a handler handed over on show and
  // taken back on hide is a prop that changes on every pane of both layers at
  // every switch, and the swap commit re-rendered all of them — every frame,
  // every title bar — to hand over four functions a hidden pane cannot reach
  // anyway ([B02]: no pointer, no focus).
  const shownRef = useRef(shown);
  useLayoutEffect(() => {
    shownRef.current = shown;
  }, [shown]);
  const onRevealPaneRef = useRef(onRevealPane);
  useLayoutEffect(() => {
    onRevealPaneRef.current = onRevealPane;
  }, [onRevealPane]);
  const revealIfShown = useCallback((entry: SlotStackEntry) => {
    if (shownRef.current) onRevealPaneRef.current?.(entry);
  }, []);
  // One callback set per stack, made once and kept for the store's life.
  // `TugPane` is memoized on its props, and a closure minted per render is a
  // prop that never compares equal — so with these inline, every pane
  // re-rendered on every deck commit, and a fold of one card paid the render
  // of eleven frames and six session cards before its first frame could
  // paint. Each closure closes over `store` and the stack's id, both fixed
  // for as long as the pane is keyed by that id; what varies — the stack's
  // active card — is read off the snapshot when the callback runs.
  const stackCallbacks = useMemo(
    () => new Map<string, StackCallbacks>(),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- a fresh cache per deck manager
    [store],
  );
  const callbacksFor = (stackId: string): StackCallbacks => {
    let entry = stackCallbacks.get(stackId);
    if (entry === undefined) {
      entry = {
        onClose: () => {
          if (!shownRef.current) return;
          store.handlePaneClosed(stackId);
        },
        // The pane's ACTIVE card is what moves — the one the title bar is
        // naming. [B04]: the move does not follow the card, so nothing here
        // touches the active workspace.
        onMoveToSpace: (spaceId) => {
          const stack = store
            .getSnapshot()
            .panes.find((s) => s.id === stackId);
          if (stack === undefined) return;
          store.moveCardToSpace(stack.activeCardId, spaceId);
        },
        onCardMerged: (sourceStackId, targetStackId, insertIndex) => {
          if (!shownRef.current) return;
          // Resolve the active card id from the source stack at commit time.
          const snapshot = store.getSnapshot();
          const sourceStack = snapshot.panes.find(
            (s) => s.id === sourceStackId,
          );
          if (!sourceStack) return;
          store.moveCardToPane(
            sourceStackId,
            sourceStack.activeCardId,
            targetStackId,
            insertIndex,
          );
        },
      };
      stackCallbacks.set(stackId, entry);
    }
    return entry;
  };
  return (
    <>
      {/* TugPanes: one per pane in this workspace's deck.
          Rendered in stable ID order (no DOM reordering on focus change).
          Z-index from store array position (first = lowest). Panes whose
          active card's componentId is unregistered are skipped with a
          warning. */}
      {arr.sortedStacks.map((stackState) => {
        const activeCard = arr.cardsById.get(stackState.activeCardId);
        const fallbackCard =
          activeCard ?? arr.cardsById.get(stackState.cardIds[0]);
        const componentId = fallbackCard?.componentId;
        if (!componentId) {
          console.warn(
            `[DeckCanvas] stack "${stackState.id}" has no active card -- skipping render.`,
          );
          return null;
        }

        const registration = getRegistration(componentId);
        if (!registration) {
          console.warn(
            `[DeckCanvas] stack "${stackState.id}" references unregistered componentId "${componentId}" -- skipping render.`,
          );
          return null;
        }

        const callbacks = callbacksFor(stackState.id);

        const stackCards = stackState.cardIds
          .map((cid) => arr.cardsById.get(cid))
          .filter((c): c is NonNullable<typeof c> => c !== undefined);
        const hasMultipleCards = stackCards.length > 1;

        return (
          <TugPane
            key={stackState.id}
            stackState={stackState}
            meta={registration.defaultMeta}
            layoutRole={registration.layoutRole}
            activeComponentId={componentId}
            // A pane is one box shared by every tab in the stack, so
            // its resize floor must clear the widest card kind it
            // hosts — not just the active tab. `getStackSizePolicy`
            // takes the element-wise max of the stack's mins.
            sizePolicy={getStackSizePolicy(
              stackCards.map((c) => c.componentId),
              // A folded pane is sized by the folded policy ([P04]):
              // the open card's 600px floor is what its transcript and
              // composer need, and a wall cannot pack while every member
              // still claims it.
              //
              // And an UNBOUND pane is sized by the unbound policy ([B04],
              // [D195]), on the same fact `placeMembers` reads, so the frame's
              // resize floor and the column's member floor are one answer
              // rather than two. The unbound policy's height floor is zero, and
              // `TugPane` floors its chrome-measured `minSize` to
              // `sizePolicy.min` — so what stands is the chrome's own
              // measurement rather than a collapsed frame. The hidden arriving
              // seat is untouched by this: it comes from the `arriving` prop,
              // resolved from `DeckState.arriving`, not from `minSize`.
              {
                folded: stackState.folded === true,
                unbound: isUnboundMember(deck, stackState.id),
              },
            )}
            zIndex={
              arr.zIndexMap.get(stackState.id) ?? CARD_ZINDEX_BASE
            }
            // Every placement below is THIS layer's own, shown or not.
            // A hidden pane resolves it against its own wrapper's
            // inset variables — `SpaceLayerWrapper` writes them from
            // the same arrangement — so it stands where its deck puts
            // it and not where the shown deck's rails would. What a
            // hidden layer does NOT take is interaction: no drop zones,
            // no close, no reveal, no move menu.
            placement={arr.placementFor(stackState)}
            bullseye={arr.bullseyePaneId === stackState.id}
            // Every OTHER content pane leaves the canvas while bullseye
            // holds — receding a card that is still sitting there is not
            // what "distraction-free" means. Rails are excluded and stay at
            // their pins: a rail leaving would take the band's insets with
            // it, and the bullseyed card would jump the moment the posture
            // began.
            bullseyeExit={
              arr.bullseyePaneId !== null &&
              arr.bullseyePaneId !== stackState.id &&
              !arr.sidebarPaneIds.has(stackState.id)
                ? arr.bullseyeAnchorCentre
                : undefined
            }
            contentWidthPx={arr.contentWidthPx}
            resizeKeepsSlot={impositionResizeSlot(deck.imposition) === "keep"}
            columnMember={arr.columnMemberByPaneId.get(stackState.id)}
            columnMode={arr.columnModeByPaneId.get(stackState.id)}
            arriving={arr.arrivingSeatByPaneId.get(stackState.id)}
            // The pane's own field ([P01]) rather than `paneFoldedOf` over
            // the deck state: the selector exists for readers holding a state
            // and an id, and this one is already holding the pane.
            folded={stackState.folded === true}
            onRevealPane={revealIfShown}
            // Given to EVERY layer, shown or not, because the title bar
            // renders its move control on the handler's presence and a
            // bar that gains a control on show is a bar that changes
            // width on show. A hidden pane cannot reach it — no pointer,
            // no focus ([B02], `at0641`) — so the handler is inert there.
            //
            onMoveToSpace={callbacks.onMoveToSpace}
            sidebarStack={arr.stackByPaneId.get(stackState.id)}
            railParked={arr.parkedRailSideByPaneId.get(stackState.id)}
            departing={arr.departingPaneIds.has(stackState.id)}
            isSidebarPane={arr.sidebarPaneIds.has(stackState.id)}
            onCardMoved={store.handlePaneMoved}
            onClose={callbacks.onClose}
            dropZones={dropZones}
            onCardMerged={callbacks.onCardMerged}
            activeCardId={stackState.activeCardId}
            cards={hasMultipleCards ? stackCards : undefined}
            cardTitle={hasMultipleCards ? stackState.title : undefined}
            acceptedFamilies={
              hasMultipleCards ? stackState.acceptsFamilies : undefined
            }
          />
        );
      })}

      {/* Flat card-content list: every card of THIS workspace is mounted
          exactly once and routes its DOM via portal into its host stack's
          content div. React keys by cardId so React preserves component
          identity when a card moves between stacks (detach / merge).
          Non-active cards render with `display: none` so they stay alive
          without affecting layout. Content factories and contexts live in
          CardHost; see card-host.tsx. */}
      {deck.cards.map((card) => {
        const hostStackId = arr.hostStackIdByCardId.get(card.id);
        if (!hostStackId) return null;
        const hostStack = deck.panes.find((s) => s.id === hostStackId);
        return (
          <CardHost
            key={card.id}
            cardId={card.id}
            hostStackId={hostStackId}
            componentId={card.componentId}
            isActive={hostStack?.activeCardId === card.id}
          />
        );
      })}
    </>
  );
});

/**
 * DeckCanvas — plain function component (no `forwardRef`).
 *
 * Renders the responder-chain root and, per mounted workspace, one wrapper
 * holding a TugPane per entry in that workspace's deck ([B06]). Exactly one
 * wrapper is shown; the rest carry no `data-space-shown` and are
 * hidden — laid out but unpainted, unreachable and still ([B02]) — which is
 * how a workspace switch became a style change
 * rather than an unmount of every card on one side and a mount of every card
 * on the other.
 *
 * State is read from DeckManagerContext via useSyncExternalStore -- no
 * deckState prop. The variable `store` holds the IDeckManagerStore instance;
 * `manager` continues to hold the ResponderChainManager (unchanged).
 *
 * The canvas itself stays a SINGLETON and everything singleton about it lives
 * outside the wrappers: the responder-chain root, `cardDragCoordinator.init`,
 * `DeckCommitBeacon`, the overlay root, the seams, the caps and the shadows.
 * Those are the deck's, not any one workspace's ((#canvas-shape)).
 */
export function DeckCanvas(_props: DeckCanvasProps) {
  perfMark("tug:canvas-render");
  // ---- Store subscription ([D04]) ----
  // Named `store` (not `manager`) to avoid collision with the ResponderChainManager
  // variable below.
  const store = useDeckManager();
  // The canvas draws the deck, so it reads the PICTURE — the standing deck
  // with every departing pane composed back in for the settle that carries
  // it out — and derives the standing deck from it for everything else. The
  // picture is what renders frames and hosts and what the settle plans over;
  // every selector, effect and law in this body reads `deckState`, which
  // holds no departing pane.
  const pictureStore = useMemo(
    () => ({ subscribe: store.subscribe, getSnapshot: store.getPicture }),
    [store],
  );
  // Every field but `CANVAS_UNREAD_FIELDS` commits; a window focus or blur,
  // which moves only `hasFocus`, does not.
  const picture = useStoreDerived(pictureStore, canvasDeck, canvasDeckEqual);
  const deckState = standingDeck(picture);
  const panes = deckState.panes;
  // Whether a layout selection stands — read as a boolean, so the canvas
  // re-renders when the set goes empty or non-empty and not on every change
  // within it. The root responder's `CANCEL_DIALOG` entry is registered off
  // this bit and nothing else reads it ([L02]).
  const hasLayoutSelection = useSyncExternalStore(
    cardsSelectionStore.subscribe,
    () => cardsSelectionStore.getSnapshot().ids.length > 0,
  );
  // The level ABOVE the deck: the workspace list and which one is active.
  // `subscribe` above fires for changes inside a deck and never for the list,
  // so the spine's Move to Workspace menu needs its own subscription ([L02]).
  // Every pane's title bar takes the same snapshot — the list is a fact about
  // the window, not about any one pane.
  const spacesSnapshot = useSyncExternalStore(
    store.subscribeSpaces,
    store.getSpacesSnapshot,
  );
  // One shown-ness source per workspace, made once and kept for the store's
  // life, so the context value under a layer never changes and a switch
  // re-renders only the readers that subscribed to the transition — see
  // `SpaceLayerShownContext`. The answer is the same fact the layer list
  // below is built on: a layer is shown when it is the active workspace.
  const layerShownSources = useMemo(
    () => new Map<string, SpaceLayerShownSource>(),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- a fresh cache per deck manager
    [store],
  );
  const layerShownSourceFor = (spaceId: string): SpaceLayerShownSource => {
    let source = layerShownSources.get(spaceId);
    if (source === undefined) {
      source = {
        spaceId,
        get: () => store.getSpacesSnapshot().activeSpaceId === spaceId,
        subscribe: store.subscribeSpaces,
      };
      layerShownSources.set(spaceId, source);
    }
    return source;
  };
  // The mounted workspaces, in the list's order, each with the deck its
  // wrapper renders ([B06], (#canvas-shape)). The ACTIVE one's deck is the
  // live `deckState` — it is the deck every selector, effect and law in this
  // file is written against, and the snapshot deliberately does not carry a
  // copy of it. Every other mounted workspace's deck is the parked record on
  // the snapshot, read through the store hook above rather than by a
  // `store.getSpaceDeck(id)` call in this body, which [L02] forbids.
  //
  // A host with no spaces store to answer — a unit harness, a boot before the
  // first snapshot — reports no mounted ids at all, and gets the one layer it
  // has always had.
  const spaceLayers = useMemo<SpaceLayer[]>(() => {
    const layers: SpaceLayer[] = [];
    for (const spaceId of spacesSnapshot.mountedSpaceIds) {
      if (spaceId === spacesSnapshot.activeSpaceId) {
        layers.push({ spaceId, shown: true, deck: picture });
        continue;
      }
      const parked = spacesSnapshot.mountedDecks.get(spaceId);
      if (parked === undefined) continue;
      layers.push({ spaceId, shown: false, deck: parked });
    }
    if (!layers.some((layer) => layer.shown)) {
      layers.unshift({
        spaceId: spacesSnapshot.activeSpaceId,
        shown: true,
        deck: picture,
      });
    }
    return layers;
  }, [spacesSnapshot, picture]);
  // The shown deck's arrangement — one derivation the whole body reads from,
  // and the same one every hidden layer takes from its own parked deck in the
  // render below. `placeRuns` are the canvas's measured run heights, the same
  // for every layer because every layer stands in the same canvas.
  const placeRuns: PlaceRuns = {
    rail: store.getRailRunHeight(),
    column: store.getColumnRunHeight(),
  };
  const shownArrangement = useMemo(
    () => deriveShownArrangement(picture, placeRuns),
    // `placeRuns` is minted per render; its two numbers are the dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `placeRuns` is minted per render; its two numbers are the dependency
    [picture, placeRuns.rail, placeRuns.column],
  );
  const {
    sidebarRails,
    flowStrip,
    flowOffset,
    deckColumns,
    columnOffsets,
    railOffsets,
    railWidthOf,
    vacantRails,
    parkedRailSides,
    pictureRails,
    pictureVacantRails,
    impositionKind,
    placementFor,
    bullseyePaneId,
  } = shownArrangement;

  // ---------------------------------------------------------------------------
  // Visual focus
  // ---------------------------------------------------------------------------
  // Pane focus appearance (the `data-focused` attribute on each pane frame)
  // is owned by `pane-focus-controller.ts` — a DOM-authority hook that
  // subscribes to the store and writes `data-focused` directly, bypassing
  // React state and props. See that module's docstring for the contract
  // (L06, L10, L22).
  //
  // `deckRootRef` is the element the controller scopes its DOM queries to.
  // It's merged onto the same div that carries `responderRef` below.

  const deckRootRef = useRef<HTMLDivElement | null>(null);
  usePaneFocusController(deckRootRef);
  usePaneOcclusionController(deckRootRef);
  usePaneRaise(deckRootRef, store);

  // ---------------------------------------------------------------------------
  // Refs for cycleCard closure (registered once on mount via useResponder)
  // ---------------------------------------------------------------------------
  // cycleCard is captured at mount time and never re-registered. All mutable
  // state it accesses must be via refs or stable values.

  const panesRef = useRef<readonly TugPaneState[]>(panes);
  panesRef.current = panes;

  // The responder chain manager — used by the last-resort `close` handler below
  // to route to the active pane when the first responder has fallen up to the
  // canvas root (e.g. a card/pane closed and nothing re-promoted a card).
  const manager = useResponderChain();
  const managerRef = useRef(manager);
  managerRef.current = manager;

  /**
   * containerRef: ref to the positioning wrapper div that card frames and snap guides
   * are rendered into. [D03]
   */
  const containerRef = useRef<HTMLDivElement | null>(null);
  // The rail width drag's draft: this canvas owns the arrangement properties
  // the drag previews, so it is the one writer of them for the gesture's
  // length and the one party that rolls them back ([L10], [L32]). A rail's
  // edge handle only emits the gesture into it. It reads the flow strip as
  // this render arranged it, because a flow card's travel under the rail is
  // clamped by the strip's length and the offset standing over it.
  const flowTermsRef = useRef<RailTravelBand["flow"]>(null);
  flowTermsRef.current =
    flowStrip === null
      ? null
      : { offset: Math.round(flowOffset), strip: flowStrip.width };
  const readFlowTerms = useCallback(() => flowTermsRef.current, []);
  const railWidthDraft = useRailWidthDraft(containerRef, store, readFlowTerms);

  // Hook order: useDeckManager -> useSyncExternalStore -> useRef ->
  //             usePaneFocusController -> useRequiredResponderChain ->
  //             useCallback -> useResponder ->
  //             useEffect (cardDragCoordinator init) -> useEffect (initial focused card restore) ->
  //             useLayoutEffect (startup overlay fade-out) ->
  //             useLayoutEffect (selection highlight sync)

  // Re-activate a card when the deck is deselected (canvas-background click
  // cleared `activePaneId`). Targets the topmost pane's active card. Returns
  // true when it acted, false when a card is already active (so the normal
  // navigation handlers run). Shared by the three card / pane nav actions,
  // which all land here while deselected (the chain first responder is the
  // deck-canvas root).
  const reactivateWhenDeselected = (): boolean => {
    if (store.getSnapshot().activePaneId !== undefined) return false;
    const s = panesRef.current;
    if (s.length === 0) return false;
    const incomingCardId = s[s.length - 1].activeCardId; // topmost pane
    transferFocusForActivation({
      outgoingCardId: null,
      incomingCardId,
      store,
      commitMutation: () => store.activateCard(incomingCardId),
      deferCommit: mayDeferCommit(store, incomingCardId),
    });
    return true;
  };

  // Register DeckCanvas as the root responder node.
  // Action handlers close over stable values only: refs, React state setters,
  // store instance (stable singleton), and the manager singleton.
  // DeckCanvas auto-becomes first responder on mount because parentId is null
  // and no first responder is set yet.
  const { ResponderScope, responderRef } = useResponder({
    id: "deck-canvas",
    /**
     * canHandle: () => true makes DeckCanvas a last-resort responder.
     *
     * DeckCanvas claims to handle all actions so that chain-action buttons
     * remain visible and enabled in practice (the chain walk always reaches
     * deck-canvas). Dispatch still checks the actions map -- unregistered
     * actions are safe no-ops. Unhandled dispatches are logged to console
     * for development debugging.
     *
     * [D08] DeckCanvas last-resort responder
     */
    canHandle: () => true,
    /**
     * Capability query (used by `chain.validateAction`, e.g. the native
     * menu's edit/find enablement) must reflect what DeckCanvas actually
     * does, not the `canHandle` dispatch catch-all. Affirm only the
     * canvas's own actions; everything else is "not handled here" so the
     * walk reports the action as unavailable when nothing real handles it.
     */
    validateAction: (action) => DECK_CANVAS_VALIDATED_ACTIONS.has(action),
    actions: {
      // Previous / Next Card: one step around the lateral card ring — every
      // tab of every visible pane ([D08]-adjacent by necessity: only this
      // root sees all panes, so the pane deliberately does not register
      // these). On a deselected deck the step has no starting point, so
      // both re-activate the topmost card instead.
      //
      // Route through `transferFocusForActivation` so the keystroke path
      // matches the click-driven activation taxonomy (SAVE outgoing →
      // commit → resolve incoming → focus transfer). A raw
      // `store.activateCard(nextId)` flips the composite first-responder
      // bit but skips the focus-transfer step, leaving the caret in the
      // now-inactive card. `activateCard` both raises the target's pane
      // and makes the target its pane's active tab, so the one call
      // serves the within-pane and cross-pane steps alike.
      [TUG_ACTIONS.PREVIOUS_TAB]: (_event: ActionEvent) => {
        if (reactivateWhenDeselected()) return;
        const nextId = stepCardRing(
          store.getSnapshot(),
          store.getFirstResponderCardId(),
          -1,
        );
        if (nextId === null) return;
        transferFocusForActivation({
          outgoingCardId: store.getFirstResponderCardId(),
          incomingCardId: nextId,
          store,
          commitMutation: () => store.activateCard(nextId),
          deferCommit: mayDeferCommit(store, nextId),
        });
      },
      [TUG_ACTIONS.NEXT_TAB]: (_event: ActionEvent) => {
        if (reactivateWhenDeselected()) return;
        const nextId = stepCardRing(
          store.getSnapshot(),
          store.getFirstResponderCardId(),
          1,
        );
        if (nextId === null) return;
        transferFocusForActivation({
          outgoingCardId: store.getFirstResponderCardId(),
          incomingCardId: nextId,
          store,
          commitMutation: () => store.activateCard(nextId),
          deferCommit: mayDeferCommit(store, nextId),
        });
      },
      // ⌘1..⌘9 — put the selected card at slot N of the active
      // imposition. The canvas owns the layout tree, so it owns this;
      // the chord walks past the focused card and its pane to get here.
      // Every gate below is a silent return, never a warn: the digit row
      // is bound in full, and a number the current arrangement doesn't
      // have is a chord the user simply hasn't configured. `assign-slot`
      // does the work, so the keyboard and the Cards card's SlotPicker share
      // one path (detach-from-tab-group, raise, clamp, persist).
      [TUG_ACTIONS.MOVE_TO_SLOT]: (event: ActionEvent) => {
        if (typeof event.value !== "number") return;
        const deck = store.getSnapshot();
        const kind = deck.imposition.kind;
        if (kind === undefined) return;
        if (event.value < 1 || event.value > slotCount(kind)) return;
        // The layout selection, not the first responder. With the keyboard in
        // the Cards card the first responder IS that card — a rail — so reading
        // it alone refused every slot chord typed while the Cards list had
        // focus, which is exactly when one is most likely to be typed.
        const cardIds = contentCardsInLayoutSelection(store);
        if (cardIds.length === 0) return;
        dispatchCommand("assign-slot", { cardIds, slot: event.value - 1 });
      },
      // ⌃⌘1..⌃⌘6 — take the reader to slot N. The digit row's other reading:
      // ⌘n sends the card to a place, this sends the reader there, and nothing
      // about the arrangement changes. So it resolves no selection and asks no
      // pane anything — the deck's strip and the deck's band are the whole
      // input, which is why an empty slot is as reachable as a full one now
      // that a vacancy holds its room.
      //
      // It commits without previewing, which is the one caller `setFlowOffset`
      // is built for: the store lands a number CSS was not already drawing and
      // the settle tweens the crossing, so a named place is traveled to rather
      // than jumped to. Silent returns throughout, like every other chord the
      // canvas owns — under fit there is no strip, and a digit past the
      // arrangement's slots is a chord the user simply has not configured.
      //
      // And the arrival is ANSWERED. The band moving is the only thing the
      // gesture does, and on a deck of near-identical cards a reader who typed
      // ⌃⌘4 has no way to tell which of the two now on screen is the four they
      // asked for. `flashSlot` says which — the pane's ring if a card stands
      // there, the vacancy badge's if the place is empty, which is the same
      // answer `assign-slot` gives when a card is sent somewhere. It runs on
      // this frame rather than after the settle: the flash outlasts the tween
      // several times over, so it is already burning when the card arrives.
      [TUG_ACTIONS.GO_TO_SLOT]: (event: ActionEvent) => {
        if (typeof event.value !== "number") return;
        const state = store.getSnapshot();
        const strip = deckFlowStrip(state);
        const band = store.getBandWidth();
        if (strip === null || band === null || band <= 0) return;
        const slot = event.value - 1;
        const stripLeft = strip.positions.get(slot);
        if (stripLeft === undefined) return;
        store.setFlowOffset(
          flowCenterOffset({
            stripLeft,
            extent: strip.extents.get(slot) ?? 0,
            stripWidth: strip.width,
            band,
          }),
        );
        flashSlot(store, slot);
      },
      // ⌥⌘←/→/↑/↓ — hand the keyboard to the card that is spatially in that
      // direction ([D184]). The canvas owns it for the reason it owns the
      // lateral ring: only this root sees every pane, so only it can reckon
      // across them.
      //
      // It reads the FIRST RESPONDER rather than the layout selection, unlike
      // every other geometry verb here, and the difference is the verb's: those
      // arrange a card the user has named, this moves the keyboard, so where
      // the keyboard is IS the source. The geometry is
      // `lib/directional-focus.ts` — nothing about the rule lives in this
      // handler, which does the four things around it instead.
      //
      // Arrival goes through `transferFocusForActivation`, the click path's own
      // taxonomy (SAVE outgoing → commit → resolve incoming → focus transfer),
      // never a raw `activateCard`: that flips the composite first-responder bit
      // and skips the transfer, leaving the caret in the card the reader just
      // left. **The travel that brings an off-band target into view ([B08]) is
      // that commit's own**, not a second move made here: `activateCard`
      // reveals what it raises, sliding the flow band, the target's column and
      // its rail each by the least that shows the member ([P12]) and spreading
      // all three into the SAME commit as the raise, so the settle animates
      // them together ([P10]). A centering pass afterwards would be a second
      // arrangement change a beat later, and the wrong rule besides — centering
      // is what a reader who named a slot by number means, and this reader
      // named a direction. Then the arrival flashes, which is the answer Go to
      // Slot gives and for the same reason: on a deck of near-identical cards,
      // focus moving is not by itself visible enough to say which card it
      // moved to.
      //
      // A refusal is VISIBLE ([B09]): at the arrangement's edge the pane the
      // reader is standing in flashes, which is the receipt a refused
      // `move-in-column` already gives. A chord that does nothing and says
      // nothing cannot be told from one that never arrived ([P08]).
      [TUG_ACTIONS.FOCUS_CARD]: (event: ActionEvent) => {
        if (!isFocusDirection(event.value)) return;
        if (reactivateWhenDeselected()) return;
        const sourceCardId = store.getFirstResponderCardId();
        if (sourceCardId === null) return;
        // The line this run is travelling, if it is still the run that left the
        // keyboard here. Any other focus change makes the ids disagree and the
        // run starts fresh from this card's own band.
        const goal =
          focusTravelRun?.cardId === sourceCardId ? focusTravelRun.goal : null;
        const target = resolveDirectionalFocus(
          store.getSnapshot(),
          {
            rail: store.getRailRunHeight(),
            column: store.getColumnRunHeight(),
          },
          sourceCardId,
          event.value,
          goal,
        );
        if (target === null) {
          flashCardPane(store, sourceCardId);
          return;
        }
        focusTravelRun = { cardId: target.cardId, goal: target.goal };
        transferFocusForActivation({
          outgoingCardId: sourceCardId,
          incomingCardId: target.cardId,
          store,
          commitMutation: () => store.activateCard(target.cardId),
          deferCommit: mayDeferCommit(store, target.cardId),
        });
        flashCardPane(store, target.cardId);
      },
      // ⌥⇧⌘[ / ⌥⇧⌘] — move the layout selection one slot along the
      // arrangement. The canvas owns it for the same reason it owns ⌘1..9,
      // and it resolves the same selection, so the two verbs cannot disagree
      // about what they are acting on: one names a slot, the other names a
      // direction. The arithmetic and the group clamp live behind
      // `nudge-slot-selection`, which is where the refusal flash is decided.
      [TUG_ACTIONS.NUDGE_SLOT]: (event: ActionEvent) => {
        if (event.value !== -1 && event.value !== 1) return;
        if (store.getSnapshot().imposition.kind === undefined) return;
        const cardIds = contentCardsInLayoutSelection(store);
        if (cardIds.length === 0) return;
        dispatchCommand("nudge-slot-selection", {
          cardIds,
          delta: event.value,
        });
      },
      // ⌃⌘/ — split or re-stack the slot the layout selection stands in. The
      // canvas owns it because a slot is a fact about the arrangement and not
      // about a card: the chord resolves the same selection ⌘1..9 and the
      // nudge pair do, takes its FIRST card (a split names one place, and a
      // multi-card selection spanning two slots has no single answer), and
      // asks that card's pane which slot it stands in.
      [TUG_ACTIONS.TOGGLE_COLUMN_SPLIT]: () => {
        const state = store.getSnapshot();
        if (state.imposition.kind === undefined) return;
        const cardIds = contentCardsInLayoutSelection(store);
        if (cardIds.length === 0) return;
        const host = state.panes.find((p) => p.cardIds.includes(cardIds[0]));
        if (host?.slot === undefined) return;
        const slot = clampSlot(state.imposition.kind, host.slot);
        const column = deckColumnsOf(state, null).find((c) => c.slot === slot);
        // A slot one card deep is NOT refused. Splitting it is a legal act
        // that commits `mode: "split"` and arms the place for the next card
        // to land into — the same act the pane badge's own menu has always
        // performed, and the badge saying "press to split it" while the chord
        // flashed a refusal was one surface calling the other a liar.
        //
        // The only refusal left is a slot that holds no column at all, which
        // `deckColumnsOf` answers for. It stays VISIBLE — the pane flashes —
        // because a chord that does nothing and says nothing is
        // indistinguishable from one that never arrived ([P08]).
        if (column === undefined) {
          tugDevLogStore.debug(
            "toggle-column-split",
            "the selection's card stands in no column",
            { slot, cardId: cardIds[0] },
          );
          flashCardPane(store, cardIds[0]);
          return;
        }
        dispatchCommand(TUG_ACTIONS.SET_COLUMN_MODE, {
          slot,
          mode: column.mode === "split" ? "stack" : "split",
        });
      },
      // ⌃⌘↑/↓ and ⌃⇧⌘↑/↓ — move the resolved card within its own column. What
      // "up" means is the store's to decide, not the chord's: split, it is the
      // member order; stacked, it is z. Refusal at an edge flashes the pane,
      // which is the same receipt the nudge pair gives.
      [TUG_ACTIONS.MOVE_IN_COLUMN]: (event: ActionEvent) => {
        if (!isColumnMoveTarget(event.value)) return;
        const state = store.getSnapshot();
        if (state.imposition.kind === undefined) return;
        const cardIds = contentCardsInLayoutSelection(store);
        if (cardIds.length === 0) return;
        const host = state.panes.find((p) => p.cardIds.includes(cardIds[0]));
        if (host === undefined) return;
        if (!store.moveInColumn(host.id, event.value)) {
          flashCardPane(store, cardIds[0]);
        }
      },
      // View ▸ Slim / Comfy / Wide — put the selected card's pane at a named
      // width. The canvas owns this for the same reason it owns ⌘1..9: the
      // command walks past the focused card and its pane to the one responder
      // that can name which pane the selection is in. `set-card-width` does the
      // work, so the View menu and the title bar's width popup share one path
      // (clamp to the stack's bounds, stamp the preset). The row no longer
      // carries a chord — ⌃⌘1..6 centers a slot now.
      // Silent returns throughout — a rail has no preset to set, and a
      // deselected deck has no pane to set it on.
      [TUG_ACTIONS.SET_PANE_WIDTH]: (event: ActionEvent) => {
        if (!isContentWidth(event.value)) return;
        const cardIds = contentCardsInLayoutSelection(store);
        if (cardIds.length === 0) return;
        dispatchCommand(TUG_ACTIONS.SET_CARD_WIDTH, {
          cardIds,
          preset: event.value,
        });
      },
      // ⌃⌘B — put the selected card's pane in bullseye, or take it out. The
      // canvas owns it for the same reason it owns the width row: it is the
      // one responder that can name which pane the selection is in, and the
      // chord walks past the focused card and its pane to get here. Having
      // named it, it hands off to the pane-addressed `set-bullseye` rather
      // than reaching the store itself — the shape SET_PANE_WIDTH →
      // SET_CARD_WIDTH already has, and what lets the title bar's target
      // button, this chord, and View ▸ Bullseye land on one path.
      // Silent returns throughout, matching the width handler: a chord on a
      // deselected deck should do nothing, not warn and not beep. A rail is
      // no longer among the returns — it takes the posture like any other
      // pane, with its place on the edge reserved while it holds it.
      [TUG_ACTIONS.TOGGLE_BULLSEYE]: (_event: ActionEvent) => {
        const deck = store.getSnapshot();
        const cardId = store.getFirstResponderCardId();
        if (cardId === null) return;
        const pane = deck.panes.find((p) => p.cardIds.includes(cardId));
        if (!pane) return;
        dispatchCommand(TUG_ACTIONS.SET_BULLSEYE, { paneId: pane.id });
      },
      // ⌃⌘Y, View ▸ Fold Card, and the Session card's Z2 control ([B05]).
      // The fold is the key card's pane's, and the canvas answers it for the
      // reason it answers bullseye: it is the one responder every walk
      // reaches, wherever the keyboard is. That includes a portaled surface —
      // a compacting card's cover, whose Cancel holds the key view and whose
      // responder parent is not the pane — which `getKeyCard()` resolves
      // back to its pane through the keyboard focus. The first responder's
      // card is the fallback for a walk with no key card to name. The card's
      // own guard runs inside the toggle.
      [TUG_ACTIONS.TOGGLE_CARD_FOLD]: (_event: ActionEvent) => {
        const deck = store.getSnapshot();
        const keyPaneId = managerRef.current?.getKeyCard() ?? null;
        const responderCardId = store.getFirstResponderCardId();
        const pane =
          deck.panes.find((p) => p.id === keyPaneId) ??
          (responderCardId === null
            ? undefined
            : deck.panes.find((p) => p.cardIds.includes(responderCardId)));
        if (pane === undefined) return;
        toggleCardFold(pane.activeCardId);
      },
      // open-file / reveal-in-finder — deck-level file-reference
      // actions dispatched by context menus on transcript file refs.
      // The chain payload carries the absolute path as `value`; the
      // richer `{ path, line }` form arrives via `dispatchCommand`, which
      // walks the chain to this same handler. Both shapes converge on
      // `openFileInCard` (path-keyed Text-card reuse).
      // Two callers, two shapes: a context-menu item names a path and
      // nothing else, while the host's File ▸ Open… and the transcript's
      // file references carry a line range to jump to.
      [TUG_ACTIONS.OPEN_FILE]: (event: ActionEvent) => {
        const target = event.value;
        if (typeof target === "string") {
          if (target === "") return;
          openFileInCard(store, target);
          return;
        }
        if (typeof target !== "object" || target === null) return;
        // The card the gesture was made in, which a new card is placed from
        // ahead of the first responder. A batch names ONE origin for every
        // reference in it, so the list fans out from the card that asked
        // rather than composing through each card it has just opened.
        const rawOrigin = (target as { originCardId?: unknown }).originCardId;
        const origin = typeof rawOrigin === "string" ? rawOrigin : null;
        // One reference, or a list of them. A list is a single gesture —
        // `/ref 1-5` — and it has to arrive as one dispatch: opening a card
        // re-seats the first responder, so a second chain dispatch in the
        // same tick would walk a card whose responders have not mounted yet
        // and die unhandled.
        const one = (ref: unknown): void => {
          if (typeof ref !== "object" || ref === null) return;
          const { path, line, endLine, columns } = ref as {
            path?: unknown;
            line?: unknown;
            endLine?: unknown;
            columns?: unknown;
          };
          if (typeof path !== "string" || path.trim() === "") {
            console.warn("open-file: missing or invalid path", ref);
            return;
          }
          const span =
            Array.isArray(columns) &&
            typeof columns[0] === "number" &&
            typeof columns[1] === "number"
              ? ([columns[0], columns[1]] as const)
              : undefined;
          openFileInCard(
            store,
            path,
            typeof line === "number" ? line : undefined,
            typeof endLine === "number" ? endLine : undefined,
            span,
            origin,
          );
        };
        const { targets } = target as { targets?: unknown };
        if (Array.isArray(targets)) {
          for (const ref of targets) one(ref);
          return;
        }
        one(target);
      },
      // An untitled manual buffer — no file exists until the first Save,
      // so the draft id is the card's identity until then.
      [TUG_ACTIONS.NEW_TEXT_CARD]: (_event: ActionEvent) => {
        const newId = store.addCard("text", {
          draftId: crypto.randomUUID(),
          untitled: true,
          untitledNumber: allocateUntitledNumber(),
          anchor: { line: 1, ch: 0 },
          scrollTop: 0,
        });
        if (newId === null || store.getFirstResponderCardId() === newId) return;
        transferFocusForActivation({
          outgoingCardId: store.getFirstResponderCardId(),
          incomingCardId: newId,
          store,
          commitMutation: () => store.activateCard(newId),
        });
      },
      [TUG_ACTIONS.OPEN_QUICKLY]: (_event: ActionEvent) => {
        openOpenQuickly();
      },
      [TUG_ACTIONS.CLEAR_RECENT_DOCUMENTS]: (_event: ActionEvent) => {
        clearRecentDocuments();
      },
      // Escape's last-resort meaning while a layout selection stands: drop it.
      //
      // The selection is deck state, not the Cards card's — it is what the next
      // layout verb acts on, and it outlives both the gesture that made it and
      // the keyboard's presence in that card. A plain click on a Cards row
      // FRONTS the card it names, which takes the keyboard out of the rail
      // entirely; the Cards card's own responder is then off the chain, and without
      // this entry the standing selection had no key that could take it back.
      //
      // Registered CONDITIONALLY, and that is the whole safety argument: an
      // unconditional entry on the root responder would mark every Escape in
      // the app handled (the chain has no way for a handler to decline), which
      // is why that responder was content-local in the first place. The
      // key is present only while there is a set to clear, so every other
      // Escape in the app walks off the root exactly as it did before.
      //
      // Sited at the root, it is also the LAST thing to see the press: a sheet,
      // a popover, a live drag's document listener, and the engine's own Escape
      // ladder all resolve ahead of the chain, so this can only spend an Escape
      // nothing else wanted.
      ...(hasLayoutSelection
        ? {
            [TUG_ACTIONS.CANCEL_DIALOG]: (_event: ActionEvent) => {
              // The same table the Cards card's own responder runs, so the answer to
              // Escape does not change with where the keyboard happens to be
              // standing — which was the whole complaint. `shrinkCardsState`
              // takes the filter rung first if there is one; the focus-out rung
              // cannot be reached from here, since this entry is registered
              // only while a selection stands.
              shrinkCardsState();
            },
          }
        : {}),
      // Through `transferFocusForActivation` rather than `activateCard`
      // alone: a menu pick has to fire the full outgoing-save → commit →
      // incoming-focus transition, not just reorder z.
      [TUG_ACTIONS.FOCUS_PANE]: (event: ActionEvent) => {
        const paneId = (event.value as { paneId?: unknown } | undefined)?.paneId;
        if (typeof paneId !== "string") {
          console.warn("focus-pane: missing or invalid paneId", event.value);
          return;
        }
        const pane = store.getSnapshot().panes.find((s) => s.id === paneId);
        if (pane === undefined) {
          console.warn(`focus-pane: no pane with id "${paneId}"`);
          return;
        }
        const incomingCardId = pane.activeCardId;
        transferFocusForActivation({
          outgoingCardId: store.getFirstResponderCardId(),
          incomingCardId,
          store,
          commitMutation: () => store.activateCard(incomingCardId),
          deferCommit: mayDeferCommit(store, incomingCardId),
        });
      },
      // Answered HERE, at the chain root, for the reason `focus-pane` above
      // is: the Window menu can fire it while a Session card holds focus and
      // the Workspaces card is not even open, so a handler on that card would
      // make the menu row work only when it happened to be focused ([P11]).
      [TUG_ACTIONS.ACTIVATE_SPACE]: (event: ActionEvent) => {
        const spaceId = (event.value as { spaceId?: unknown } | undefined)
          ?.spaceId;
        if (typeof spaceId !== "string") {
          console.warn("activate-space: missing or invalid spaceId", event.value);
          return;
        }
        const known = store
          .getSpacesSnapshot()
          .spaces.some((s) => s.id === spaceId);
        if (!known) {
          console.warn(`activate-space: no space with id "${spaceId}"`);
          return;
        }
        store.activateSpace(spaceId);
      },
      // The four workspace verbs, answered HERE for the reason `activate-space`
      // above is ([P02]): the Window menu can fire any of them while a Session
      // card holds focus and the Workspaces card is not even open, so a handler
      // on that card would make the menu row work only when the card happened
      // to be focused.
      //
      // Each takes an OPTIONAL `spaceId`. Present, it is the row a right-click
      // or a `···` landed on; absent, the verb means the ACTIVE workspace,
      // which is the target the menu names. `targetSpaceId` below is that one
      // rule, written once.
      // New is Rename's second path run on the workspace it just made: a new
      // workspace is one you are about to name, so the Workspaces card comes
      // forward — opened if it is closed — with the new header's field open
      // and its default name selected. Escape keeps that name; nothing here
      // undoes the creation.
      [TUG_ACTIONS.NEW_SPACE]: () => {
        const spaceId = store.createSpace();
        revealSidebarCard(store, CARDS_CARD_ID);
        cardsSpaceVerbRequest.request("rename", spaceId);
      },
      [TUG_ACTIONS.RENAME_SPACE]: (event: ActionEvent) => {
        const payload = event.value as
          | { spaceId?: unknown; name?: unknown }
          | undefined;
        const spaceId = targetSpaceId(store, payload?.spaceId);
        if (spaceId === null) return;
        // With a name it commits outright; without one it opens the header's
        // inline field, which is the one place a workspace name is typed
        // ([P03]) — so this half reveals the Workspaces card and hands the
        // verb to it through the request store ([P08]). The menu item and the
        // `···` both send no name, so both take the second path.
        if (typeof payload?.name === "string") {
          store.renameSpace(spaceId, payload.name);
          return;
        }
        revealSidebarCard(store, CARDS_CARD_ID);
        cardsSpaceVerbRequest.request("rename", spaceId);
      },
      [TUG_ACTIONS.DUPLICATE_SPACE]: (event: ActionEvent) => {
        const spaceId = targetSpaceId(
          store,
          (event.value as { spaceId?: unknown } | undefined)?.spaceId,
        );
        if (spaceId === null) return;
        store.duplicateSpace(spaceId);
      },
      [TUG_ACTIONS.DELETE_SPACE]: (event: ActionEvent) => {
        const spaceId = targetSpaceId(
          store,
          (event.value as { spaceId?: unknown } | undefined)?.spaceId,
        );
        if (spaceId === null) return;
        // Same hand-off as the rename, and for the same reason: the confirm
        // popover is anchored to a header row and is the one place a workspace
        // delete is answered ([P03]). Whether a confirm opens at all is the
        // card's decision and stays exactly where it was.
        revealSidebarCard(store, CARDS_CARD_ID);
        cardsSpaceVerbRequest.request("delete", spaceId);
      },
      [TUG_ACTIONS.REVEAL_IN_FINDER]: (event: ActionEvent) => {
        if (typeof event.value !== "string" || event.value === "") return;
        revealPathInFinder(event.value);
      },
      // Look Up in Dictionary — the selection a text surface's context menu
      // sampled, handed to the host's `showDefinition`. It lives at the root
      // for the same reason Reveal in Finder does: the verb carries
      // everything it needs on the event, so the surface that offers it has
      // nothing left to contribute, and every text surface in the deck gets
      // one handler instead of five.
      [TUG_ACTIONS.LOOK_UP_IN_DICTIONARY]: (event: ActionEvent) => {
        if (!isDictionaryLookupRequest(event.value)) return;
        lookUpInDictionary(event.value);
      },
      [TUG_ACTIONS.SHOW_SETTINGS]: (_event: ActionEvent) => {
        // ⌘, — open (or raise) the Settings singleton card. This
        // handler is why the keybinding owns the chord in-app: with the
        // WKWebView first responder, the web layer captures ⌘, before
        // AppKit's menu ever sees it, so the menu's key equivalent can't
        // be relied on — the chord must do its work here. Same
        // find-or-create-then-focus-claim shape as the gallery action
        // (and the focus-correct sibling of the native menu's
        // `show-card settings` → `showSingletonCard` path).
        const snapshot = store.getSnapshot();
        const settingsCard = snapshot.cards.find(
          (c) => c.componentId === "settings",
        );
        const incomingCardId = settingsCard
          ? settingsCard.id
          : store.addCard("settings");
        if (incomingCardId === null) return;
        transferFocusForActivation({
          outgoingCardId: store.getFirstResponderCardId(),
          incomingCardId,
          store,
          commitMutation: () => store.activateCard(incomingCardId),
          deferCommit: mayDeferCommit(store, incomingCardId),
        });
      },
      [TUG_ACTIONS.SHOW_KEYBOARD_SHORTCUTS]: (_event: ActionEvent) => {
        // Open (or raise) the Keyboard Shortcuts singleton card. Same
        // find-or-create-then-focus-claim shape as SHOW_SETTINGS. Dispatched
        // by the app menu's item and by the Cards card.
        const snapshot = store.getSnapshot();
        const keyboardCard = snapshot.cards.find(
          (c) => c.componentId === "keyboard",
        );
        const incomingCardId = keyboardCard
          ? keyboardCard.id
          : store.addCard("keyboard");
        if (incomingCardId === null) return;
        transferFocusForActivation({
          outgoingCardId: store.getFirstResponderCardId(),
          incomingCardId,
          store,
          commitMutation: () => store.activateCard(incomingCardId),
          deferCommit: mayDeferCommit(store, incomingCardId),
        });
      },
      [TUG_ACTIONS.SHOW_DEVTOOLS]: (_event: ActionEvent) => {
        // ⌥⌘/ — open (or raise) the DevTools singleton card (Log +
        // Telemetry). Same find-or-create-then-focus-claim shape as
        // SHOW_SETTINGS.
        const snapshot = store.getSnapshot();
        const devtoolsCard = snapshot.cards.find(
          (c) => c.componentId === "devtools",
        );
        const incomingCardId = devtoolsCard
          ? devtoolsCard.id
          : store.addCard("devtools");
        if (incomingCardId === null) return;
        transferFocusForActivation({
          outgoingCardId: store.getFirstResponderCardId(),
          incomingCardId,
          store,
          commitMutation: () => store.activateCard(incomingCardId),
          deferCommit: mayDeferCommit(store, incomingCardId),
        });
      },
      // Show Jots / Show Cards / Show Overview — the three-state sidebar
      // shortcut over one CARD: show-and-activate a hidden rail, activate a
      // showing one, hide the rail that already holds the keyboard
      // ({@link toggleSidebarCard}). Menu rows with no default chord since the
      // rails took the keyboard; the `toggle-*` control actions run the same
      // performer, so the row and any rebinding cannot drift apart.
      [TUG_ACTIONS.TOGGLE_JOTS]: (_event: ActionEvent) => {
        toggleSidebarCard(store, JOTS_CARD_ID);
      },
      [TUG_ACTIONS.TOGGLE_ARCS]: (_event: ActionEvent) => {
        toggleSidebarCard(store, ARCS_CARD_ID);
      },
      [TUG_ACTIONS.TOGGLE_CARDS]: (_event: ActionEvent) => {
        toggleSidebarCard(store, CARDS_CARD_ID);
      },
      [TUG_ACTIONS.TOGGLE_OVERVIEW]: (_event: ActionEvent) => {
        toggleSidebarCard(store, OVERVIEW_CARD_ID);
      },
      // ⌃⌘← / ⌃⌘→ — the same ladder over the RAIL rather than over a card:
      // show the side and focus its frontmost member, focus that member, hide
      // the side ({@link toggleSidebarRail}). The canvas owns it for the reason
      // it owns the column verbs — a side is a property of the deck, and no
      // card can name one.
      [TUG_ACTIONS.TOGGLE_RAIL]: (event: ActionEvent) => {
        if (!isSidebarSide(event.value)) return;
        toggleSidebarRail(store, event.value);
      },
      // ⌘J — capture in one gesture: reveal the Jots rail if it is hidden,
      // then open a fresh jot's editor. The reveal takes the same
      // show-then-activate transfer an activation uses, with keyboard modality so
      // the landing is visibly ringed; `createJot` runs after the transfer so
      // the row it opens mounts into a card that already holds focus, and the
      // editor's own descend claim lands the caret ([L03] registration order).
      [TUG_ACTIONS.NEW_JOT]: (_event: ActionEvent) => {
        const incomingCardId = store.showSidebarPane(JOTS_CARD_ID);
        if (incomingCardId === null) return;
        transferFocusForActivation({
          outgoingCardId: store.getFirstResponderCardId(),
          incomingCardId,
          store,
          commitMutation: () => store.activateCard(incomingCardId),
          deferCommit: mayDeferCommit(store, incomingCardId),
          modality: "keyboard",
        });
        getJotsStore().createJot(null);
      },
      /**
       * show-component-gallery — find or create the gallery card ([D05], [D07]).
       *
       * Show-only semantics ([D07]): the gallery card is never closed by this
       * action. Derives the gallery stack from the live snapshot on every
       * dispatch (walk `cards` for a `gallery-buttons` card, look up its host
       * stack) so detach / merge / close operations stay in sync without a
       * separate tracking ref. If no gallery card exists, create one and
       * activate its seeded card.
       */
      [TUG_ACTIONS.SHOW_COMPONENT_GALLERY]: (_event: ActionEvent) => {
        const snapshot = store.getSnapshot();
        const galleryCard = snapshot.cards.find(
          (c) => c.componentId === "gallery-buttons",
        );
        const galleryStack = galleryCard
          ? snapshot.panes.find((st) => st.cardIds.includes(galleryCard.id))
          : undefined;

        if (galleryStack) {
          // Phase E.11 Step 4i D9b — runtime activation routed
          // through `transferFocusForActivation` so the chain action
          // fires SAVE outgoing → commit → `applyBagFocus` on
          // incoming. Raw `activateCard` would flip the composite
          // first responder but skip the focus claim.
          const incomingCardId = galleryStack.activeCardId;
          transferFocusForActivation({
            outgoingCardId: store.getFirstResponderCardId(),
            incomingCardId,
            store,
            commitMutation: () => store.activateCard(incomingCardId),
            deferCommit: mayDeferCommit(store, incomingCardId),
          });
        } else {
          // No gallery card anywhere — create one and activate its seed.
          const newCardId = store.addCard("gallery-buttons");
          if (newCardId) {
            transferFocusForActivation({
              outgoingCardId: store.getFirstResponderCardId(),
              incomingCardId: newCardId,
              store,
              commitMutation: () => store.activateCard(newCardId),
            });
          }
        }
      },
      // add-card-to-active-pane: Add a new "hello" card to the active pane
      // (last in array). Reads cardsRef so the closure never goes stale.
      // If no cards exist, this is a no-op. The componentId "hello" is
      // intentionally hardcoded because it is the only registered card
      // type in Phase 5; parameterized componentId dispatch is deferred
      // until payload support is added.
      // [D06] Add-tab action uses DeckManager + responder chain
      // [D09] Add-tab routed as DeckCanvas responder action
      [TUG_ACTIONS.ADD_CARD_TO_ACTIVE_PANE]: (_event: ActionEvent) => {
        const s = panesRef.current;
        if (s.length === 0) return;
        const activePaneId = s[s.length - 1].id; // topmost pane (z-order)
        store.addCardToPane(activePaneId, "hello");
      },
      // Last-resort `close` ([D08]). `close` is normally handled by the active
      // pane (an innermost-first walk from a card reaches the pane before the
      // canvas). It only reaches the canvas root when the first responder has
      // fallen up to "deck-canvas" — a card/pane closed and the next active card
      // never reclaimed the first responder (no `focusin` on a non-text card).
      // Route it to the topmost pane so Cmd-W is never dropped on the frontmost
      // card, regardless of the first-responder restoration state.
      [TUG_ACTIONS.CLOSE]: (_event: ActionEvent) => {
        const m = managerRef.current;
        const s = panesRef.current;
        if (m === null || s.length === 0) return;
        const activePaneId = s[s.length - 1].id; // topmost pane (z-order)
        m.sendToTarget(activePaneId, { action: TUG_ACTIONS.CLOSE, phase: "discrete" });
      },
      // Last-resort `close-all` ([D08]), symmetric with the `close`
      // backstop above. Route File ▸ Close All Card Tabs to the topmost pane
      // even when the first responder has stranded on the canvas, so the
      // command is never dropped on the frontmost pane.
      [TUG_ACTIONS.CLOSE_ALL]: (_event: ActionEvent) => {
        const m = managerRef.current;
        const s = panesRef.current;
        if (m === null || s.length === 0) return;
        const activePaneId = s[s.length - 1].id; // topmost pane (z-order)
        m.sendToTarget(activePaneId, { action: TUG_ACTIONS.CLOSE_ALL, phase: "discrete" });
      },
      // Copy as Plain Text ([D08] last-resort). Plain Copy operates on the
      // live document selection wherever it lives — in Tug.app ⌘C routes to
      // WebKit's native `copy:`, not the responder chain — so Copy as Plain
      // Text reads that same selection directly here at the root rather than
      // per surface. The walk always reaches the canvas (dispatch consults
      // only the actions map, never an intervening `canHandle`), so this one
      // handler covers every text-bearing surface: transcript, markdown /
      // code views, terminal output, the prompt editor, and native inputs.
      [TUG_ACTIONS.COPY_AS_PLAIN_TEXT]: (_event: ActionEvent) => {
        copySelectionAsPlainText();
      },
    },
  });

  // Provide the coordinator with the store reference so it can call
  // reorderTab / detachTab / mergeTab on drop. [D07]
  //
  // useEffect runs after the first render (after mount), which is always
  // before any user interaction, so the coordinator is ready before any
  // tab drag can be attempted. Re-initialization is safe: init() only
  // overwrites the stored IDeckManagerStore reference; no cleanup needed.
  useEffect(() => {
    cardDragCoordinator.init(store);
  }, [store]);

  // Phase 5f: Focused card restoration after app reload ([D03]).
  //
  // On mount, read store.initialFocusedCardId (populated by the DeckManager
  // constructor from the tugbank-fetched focusedCardId). If the card still
  // exists in the deck, call `store.activateCard(id)` — the single entry
  // point that updates z-order, promotes the responder-chain key card, and
  // notifies lifecycle observers (selection guard, session-card focus, etc.).
  // Then clear the field so this only fires once on mount.
  //
  // Empty deps array: runs once on mount. The store is a stable singleton.
  useEffect(() => {
    const focusedCardId = store.initialFocusedCardId;
    if (!focusedCardId) return;

    // Clear immediately so subsequent re-mounts (HMR, StrictMode) do not re-fire.
    store.initialFocusedCardId = undefined;

    const snapshot = store.getSnapshot();
    const cardExists = snapshot.cards.some(
      (c) => c.id === focusedCardId,
    );
    if (!cardExists) return;

    // On mount, route through `activateCard` — `_flipFirstResponder`
    // treats the layout blob's `activePaneId` as the pre-existing
    // composite bit and delivers initial-sync to late-mounting
    // lifecycle subscribers via `observeCardDidActivate`'s
    // subscribe-time read of the current focused card.
    store.activateCard(focusedCardId);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- activates the restored focused card once, at mount

  // Fade out the startup overlay once DeckCanvas has committed its first render.
  //
  // useLayoutEffect fires after React commits DOM mutations but before the browser
  // paints, so the browser composites the React content and the first frame of the
  // overlay fade in a single paint — no visible transition between "overlay covers
  // everything" and "React content is visible". This is the onContentReady pattern
  // (Rules 11-12, D78, D79) applied at viewport scope.
  //
  // The overlay is removed from the DOM after the TugAnimator animation completes.
  // The `if (!overlay) return` guard handles rapid HMR reloads where the overlay
  // may already be absent. [D02]
  // Startup overlay removed — the native window background (set from tugbank)
  // provides visual continuity while the WebView is hidden. The WebView is
  // revealed by frontendReady after the theme and layout are fully applied.

  // SelectionGuard highlight sync is handled by the guard's own
  // subscription to the card lifecycle (installed via
  // `selectionGuard.attach(lifecycle)` in ResponderChainProvider).
  // The deck-canvas no longer drives it from a focused-card effect;
  // the lifecycle's wildcard observer + initial-sync covers every
  // activation path without a coupled react-side effect.

  // ---------------------------------------------------------------------------
  // Layout-imposer span insets
  // ---------------------------------------------------------------------------
  // The band imposed panes are placed across is the canvas minus the rail on
  // the side it holds — slotted positions are never under it, though a free
  // pane may still be dragged there. The two insets reach CSS as custom
  // properties on the frames' own containing block, so an imposed frame's
  // `calc()` tracks a window resize or a rail width drag with no JavaScript at
  // all ([L06]). This is why a resize costs the deck nothing while it is
  // happening: the browser does the reflow, and no code here runs per frame.
  //
  // The one exception is the settled-resize observer below, which runs no
  // geometry of its own and only after the canvas has stopped moving. The live
  // path stays pure CSS, and it must stay that way — nothing else may be hung
  // off that observer.
  //
  // A side's inset is its rail's width plus one gap, because a rail is itself
  // imposed a gap off the canvas edge — its near edge is that far in. Both
  // sides are written on every pass, so a side that loses its rail is reset to
  // zero rather than left carrying the inset it had. The width is the one the
  // frame will actually PAINT at, raised to the stack's size floor exactly as
  // `TugPane`'s `renderWidth` and the placements memo below do; packing on a
  // stored width below the floor would run the chain under the rail's real
  // edge. `resolveSpan` adds the identical gap per occupied side, so the
  // numeric twin and the CSS agree by construction ([P05]).
  //
  // Each width is published as its side's `sidebarWidthProperty` and the insets
  // are written as expressions over it, so a rail frame's own pin and the band
  // the chain rides read ONE number. A rail width drag does NOT preview
  // through it: the property is inherited, so a write per frame would restyle
  // every card in the deck. The drag's draft (`rail-width-draft.ts`) moves
  // each element by its own cheapest write instead, and writes this number
  // once, at the release, on the canvas and the shown layer's wrapper — the
  // same value this effect then writes again. No pane writes it.
  //
  // The SEAMS of a split rail ride here too, and for the same reason: a split
  // member's vertical pins are fractions of the run, so the fractions are the
  // one number a seam drag rewrites and a window resize re-resolves for free.
  // They belong in THIS effect rather than one of their own because the effect
  // order in this file is load-bearing — this one is declared before the
  // settle's Last-measure effect, so the properties are on the container before
  // any frame is measured against them.
  //
  // The FLOW viewport rides here too, for the third time the same reason: the
  // offset and the strip's length are two numbers a frame's `left` reads
  // through `var()`, so a reveal rewrites them and every frame re-resolves in
  // the next reflow — and the clamp `imposeStyle` writes over them is what
  // answers a window resize with no JS in the loop at all.
  //
  // The COLUMN seams ride here too, for the fourth time the same reason a rail's
  // do: a split column's member pins are fractions of the run, so the fractions
  // are the one number a seam drag rewrites and a window resize re-resolves for
  // free.
  //
  // NOTE the dependency: this effect is keyed on the SUMMARY STRING below, not
  // on the values, so anything it writes has to be in the summary or the write
  // never re-runs. The flow and column terms are appended for exactly that
  // reason.
  const railSummary = `${sidebarRails
    .map(
      (rail) =>
        `${rail.side}:${rail.width}:${rail.seams
          .map((f) => f.toFixed(4))
          .join("+")}:${Math.round(railOffsets[rail.side] ?? 0)}:${(
          stripCoordinatesOf(rail.allocation) ?? []
        )
          .map((c) => Math.round(c))
          .join("+")}`,
    )
    .join(";")}|${flowStrip === null ? "" : `${flowStrip.width}:${Math.round(flowOffset)}`}|${deckColumns
    .map(
      (column) =>
        `${column.slot}:${column.mode}:${column.seams
          .map((f) => f.toFixed(4))
          .join("+")}:${Math.round(columnOffsets[column.slot] ?? 0)}:${(
          stripCoordinatesOf(column.allocation) ?? []
        )
          .map((c) => Math.round(c))
          .join("+")}`,
    )
    .join(";")}`;
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    writeArrangementVariables(el, shownArrangement, store.getColumnRunHeight(), true);
    const flowBand = store.getBandWidth();
    publishFlowOffset(
      flowStrip === null || flowBand === null || flowBand <= 0
        ? null
        : flowOffset / flowBand,
    );
    // Keyed on the summary rather than on `arrangement`: the arrangement is
    // re-derived on every deck commit and most commits move none of these
    // numbers, and a style write that changes nothing is still a style write.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the summary, per the note above
  }, [railSummary]);

  // ---------------------------------------------------------------------------
  // Layout selection reconciliation
  // ---------------------------------------------------------------------------
  // The layout selection is the Cards card's to build and the deck's to honor, so it
  // is reconciled here rather than in that card: the canvas is mounted for as
  // long as there is a deck, and the Cards card is not. Pruning closed cards out of
  // the set and collapsing it when the user fronts something else both need to
  // happen whether the Cards card is on screen or closed away.
  // [L03] — a subscription registered in a layout effect, torn down with it.
  useLayoutEffect(() => attachLayoutSelectionToDeck(store), [store]);

  // ---------------------------------------------------------------------------
  // Settled-resize re-tune
  // ---------------------------------------------------------------------------
  // A new canvas width is a new band, and the rail width that made the chain
  // tile evenly at the old one may not at the new one. So the space allocator
  // gets a third moment beside the Layout card's pick: the canvas came to rest at a
  // size it was not at before — because the user dragged the window edge, or
  // because the OS resized it (a display change, a space move).
  //
  // Both are the same event as far as the deck is concerned, and neither is
  // observed WHILE it happens: the timer restarts on every observation and only
  // its expiry asks the store to re-tune, so a drag of the window edge runs the
  // pure-CSS path throughout and re-tunes once, when the hand stops. Observing
  // the container rather than `window` also catches host chrome that resizes
  // the canvas without a window resize event.
  //
  // `ResizeObserver` reports the current size as soon as it starts observing.
  // That one is swallowed — a deck that re-tuned as it appeared would rearrange
  // itself under the user at the worst possible moment, before they had touched
  // anything ([L03]: registration and its cleanup live in a layout effect; the
  // timer is a ref, not React state).
  const retuneTimerRef = useRef<number | null>(null);
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let seenInitial = false;
    // A View › Zoom step resizes the deck root to the window ÷ the factor, so
    // the canvas's layout size moves and a zoom re-tunes too. The re-tune
    // lands RESIZE_RETUNE_QUIET_MS after the zoom's relayout, and it can move
    // rails; held here, the step does not settle until it lands, so the
    // readout covers the re-tune as well rather than leaving to show the
    // rails move a beat later.
    let releaseZoomHold: (() => void) | null = null;
    const releaseHold = (): void => {
      releaseZoomHold?.();
      releaseZoomHold = null;
    };
    const observer = new ResizeObserver(() => {
      if (!seenInitial) {
        seenInitial = true;
        return;
      }
      if (retuneTimerRef.current !== null) {
        window.clearTimeout(retuneTimerRef.current);
      }
      // Taken only while a zoom is in flight: a hold taken while settled is a
      // no-op, and keeping that no-op would refuse the real hold to a zoom
      // that lands inside a plain resize's quiet window.
      if (releaseZoomHold === null && pageZoomStore.isZooming()) {
        releaseZoomHold = pageZoomStore.hold();
      }
      retuneTimerRef.current = window.setTimeout(() => {
        retuneTimerRef.current = null;
        store.retuneSidebarAllocation();
        releaseHold();
      }, RESIZE_RETUNE_QUIET_MS);
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
      if (retuneTimerRef.current !== null) {
        window.clearTimeout(retuneTimerRef.current);
        retuneTimerRef.current = null;
      }
      releaseHold();
    };
  }, [store]);

  // ---------------------------------------------------------------------------
  // Settling into a new arrangement
  // ---------------------------------------------------------------------------
  // The settle is `settle-engine.ts`'s. It is called here, where it has always
  // run, so its hooks and effects keep the place in this body they had.
  const { pendingArrivalsRef, settleCommitSeqRef } = useSettleEngine({
    store,
    deckState: picture,
    placeRuns,
    containerRef,
    shownArrangement,
    deriveArrangement: deriveShownArrangement,
  });

  // Where each imposed pane sits.
  //
  // In FIT a slot's anchor is a pure function of the kind and the slot — no
  // pane's place depends on any other's, and the rail's side moves the band's
  // edges rather than the numbering — so this is a per-pane lookup rather than
  // a chain resolved from a vantage point that sees them all. Resolved here
  // only because the canvas is where the kind is already in hand.
  //
  // In FLOW that is exactly what it is: a slot's place is the running sum of
  // every occupied slot before it. This memo is the deck's ONE vantage point
  // ([P09]) — it walks every pane once per commit either way — and the strip
  // position it resolves rides down on the placement itself, so no pane ever
  // re-derives deck-wide geometry from its own props.
  //
  // `impositionKind`, `placementFor` and `contentWidthPx` are the shown
  // arrangement's, destructured above; every hidden layer reads the same
  // three off its own.

  /**
   * The slots of the arrangement no pane stands in, each with the frame style
   * the card landing there would take.
   *
   * A held-open slot is a place, and a place with nothing in it still has to
   * BE somewhere: the strip reserves its width and the frames leave its gap,
   * so the deck already has a card-shaped hole at that anchor. This makes the
   * hole a real box.
   *
   * Two things turn on it being an element rather than an arithmetic answer.
   * It is what the reader sees — a place waiting for a card, rather than a gap
   * that reads as a rendering fault. And it is what the drop engine MEASURES:
   * `drop-zones.ts` has advertised an empty anchor as one of its four zone
   * kinds since it shipped, and that branch has been unreachable the whole
   * time because the measurement walks panes and an empty slot has none. The
   * alternative was to re-solve the anchor in TypeScript from the kind, the
   * rail widths and the band — a second derivation of geometry the CSS
   * `calc()` chain owns, which is the one thing this module does not do.
   *
   * Width is `deckVacancyExtent` — the deck's one reading of what a held-open
   * place reserves, which is the same number `deckFlowStrip` puts in the strip
   * and the allocator scores against. Three derivations of it would agree only
   * by luck, and the one that showed would be this one.
   */
  const vacantSlots = useMemo(() => {
    if (impositionKind === undefined) return [];
    // Over the picture: a departing pane still holds its slot until it lands,
    // so the vacancy appears with the unmount rather than under the fade.
    const held = new Set(
      picture.panes
        .filter((pane) => pane.slot !== undefined)
        .map((pane) => clampSlot(impositionKind, pane.slot as number)),
    );
    const reserved = deckVacancyExtent(deckState);
    const tiles: {
      slot: number;
      style: React.CSSProperties;
      railTravel: string;
    }[] = [];
    for (let slot = 0; slot < slotCount(impositionKind); slot += 1) {
      if (held.has(slot)) continue;
      const placement = resolvePlacement(impositionKind, slot);
      const stripLeft = flowStrip?.positions.get(slot);
      const placed =
        stripLeft === undefined ? placement : { ...placement, flow: { stripLeft } };
      tiles.push({
        slot,
        style: imposeStyle(placed, reserved),
        railTravel: railTravelOf(placed, reserved),
      });
    }
    return tiles;
  }, [impositionKind, picture, deckState, flowStrip]);

  // `bullseyePaneId` and `bullseyeAnchorCentre` are the shown arrangement's,
  // destructured above. The pane standing in bullseye is deck state — which
  // pane holds the first responder — so the canvas derives it once and hands
  // each pane a boolean; the anchor centre is the line the other content
  // panes sort around on their way out, so each leaves by the side it was
  // already on and no crossing is possible by construction ([P10] for what
  // flow does to it).


  // Raise the pane a stack-picker row names. The same path `assignCardToSlot`
  // takes for its raise, and for the same reason: a bare `activateCard` flips
  // the first responder but skips the focus transfer, so the outgoing card
  // never saves its focus bag and the incoming one never receives its focus
  // claim — no caret until the user clicks into it. Picking the row that is
  // already front is a same-bit refresh, which `activateCard` treats as a
  // no-op that still refreshes the persisted pointer; no special case needed.
  const handleRevealPane = useCallback(
    (entry: SlotStackEntry) => {
      transferFocusForActivation({
        outgoingCardId: store.getFirstResponderCardId(),
        incomingCardId: entry.cardId,
        store,
        commitMutation: () => store.activateCard(entry.cardId),
        deferCommit: mayDeferCommit(store, entry.cardId),
      });
    },
    [store],
  );

  // A seam drag's commit: the ONE boundary the hand moved, put back into the
  // place's live division and converted to the HEIGHTS it means and then to the
  // weights the record stores.
  //
  // The array is read here rather than handed in from the gesture, because the
  // array a pointer-down snapshot holds is a division that may have moved under
  // the drag — a resize, a settle, a member arriving. Only the dragged entry is
  // the hand's; every other boundary is whatever the place says it is at the
  // moment of the release.
  //
  // Two conversions rather than one because a weight is no longer a share of
  // the run ([P04]) — it is a share of the discretionary pool, which is what
  // the run has left once the floors are fed. Only a height
  // can be read off a seam, and only the members' floors can say what share of the
  // pool that height took, so the fractions become px first and the imposer's
  // own inverse takes it from there. That inverse is the allocator's fixed
  // point ([P10]): allocating from what it returns reproduces the heights the
  // hand left, so the commit re-renders at the pixel the hand let go of.
  //
  // The commit arms a settle whose tweens are all no-ops: the drag wrote the
  // property live, so each frame's first and last rects are the same one. Same
  // coexistence a rail edge drag already has.
  const railMembersRef = useRef(sidebarRails);
  railMembersRef.current = sidebarRails;
  const deckColumnsRef = useRef(deckColumns);
  deckColumnsRef.current = deckColumns;
  const deckStateRef = useRef(deckState);
  deckStateRef.current = deckState;
  const handleSeamCommit = useCallback(
    (place: SeamPlace, index: number, value: number) => {
      // One handler for both places, because one component raises both. The
      // fork is the record the weights land in and the ids they are keyed by —
      // componentIds on a rail, pane ids in a column — and nothing else.
      const state = deckStateRef.current;
      if (place.kind === "rail") {
        const rail = railMembersRef.current.find((r) => r.side === place.side);
        if (rail === undefined || rail.allocation === null) return;
        const ids = rail.members.map((member) => member.componentId);
        const members = placeMembers(
          state,
          "rail",
          ids,
          state.imposition.rails?.[place.side]?.shares,
        );
        store.setRailShares(
          place.side,
          placeSharesFromHeights(
            members,
            draggedHeights(rail.allocation, members, index, value),
            rail.allocation.run,
            rail.allocation.seam,
          ),
        );
        return;
      }
      const column = deckColumnsRef.current.find((c) => c.slot === place.slot);
      if (column === undefined || column.allocation === null) return;
      const members = placeMembers(
        state,
        "column",
        column.members,
        state.imposition.columns?.[place.slot]?.shares,
      );
      store.setColumnShares(
        place.slot,
        placeSharesFromHeights(
          members,
          draggedHeights(column.allocation, members, index, value),
          column.allocation.run,
          column.allocation.seam,
        ),
      );
    },
    [store],
  );

  // The corridor drag's commit: the order the hand left the rail in.
  /**
   * The canvas's half of the drop-zone drag ([P09], Spec S03).
   *
   * It lives here rather than in the pane because every verb needs the whole
   * deck: which slots the arrangement has, which panes stand in them, which
   * rails are up, and where they all are on this canvas. A pane knows only
   * where the pointer is.
   *
   * The measuring is deliberately DOM-first. The arrangement's geometry is
   * resolved in CSS — slot pins are calc expressions over the live band, member
   * pins clamp an offset in `min()` — so the browser is the authority on where
   * a frame actually is, and re-deriving it in JS would be a second opinion
   * that drifts the moment a rail moves ([L09]).
   */
  const dropZoneHost: DropZoneHost = useMemo(() => {
    /** A client rect in canvas coordinates — the space every zone is stated
     *  in, and the space the gauge fractions are taken against. */
    const canvasRectOf = (rect: DOMRect): Rect | null => {
      const canvas = containerRef.current;
      if (canvas === null) return null;
      const zoom = pageZoomFactor();
      const box = canvas.getBoundingClientRect();
      return {
        x: (rect.left - box.left) / zoom,
        y: (rect.top - box.top) / zoom,
        width: rect.width / zoom,
        height: rect.height / zoom,
      };
    };
    /**
     * A canvas-space rect as fractions of the canvas box — the gauge channel's
     * unit ([P08]). An instrument drawing the deck at another scale multiplies
     * these straight into its own; it never has to learn what this canvas
     * measures, which is the whole reason the channel is fractional.
     */
    const canvasFractionOf = (rect: Rect | null): GaugeRect | null => {
      const canvas = containerRef.current;
      if (canvas === null || rect === null) return null;
      const zoom = pageZoomFactor();
      const box = canvas.getBoundingClientRect();
      const width = box.width / zoom;
      const height = box.height / zoom;
      if (width <= 0 || height <= 0) return null;
      return {
        x: rect.x / width,
        y: rect.y / height,
        width: rect.width / width,
        height: rect.height / height,
      };
    };
    /**
     * Measure the canvas and enumerate — one body for the canvas's own drag
     * and for a remote one. `draggedAtStart` is the rect the gesture
     * snapshotted at its start, or `"measured"` for a remote drag, whose frame
     * never moved: it is read from the same pass that measures every pane, so
     * there is no second query. `clipToBand: false` leaves the band out, for a
     * picture that draws the whole strip.
     */
    const measureAndEnumerate = (
      draggedPaneId: string,
      tabBars: ReadonlyMap<string, Rect>,
      draggedAtStart: Rect | "measured",
      { clipToBand }: { clipToBand: boolean },
    ): DropZoneSet => {
      const canvas = containerRef.current;
      if (canvas === null) return { zones: [], origin: null };
      const zoom = pageZoomFactor();
      const canvasRect = canvas.getBoundingClientRect();
      const toCanvas = (rect: DOMRect): Rect => ({
        x: (rect.left - canvasRect.left) / zoom,
        y: (rect.top - canvasRect.top) / zoom,
        width: rect.width / zoom,
        height: rect.height / zoom,
      });
      const state = store.getSnapshot();
      const panes = new Map<string, Rect>();
      for (const el of canvas.querySelectorAll<HTMLElement>(
        SHOWN_PANE_FRAMES,
      )) {
        const paneId = el.getAttribute("data-pane-id");
        if (paneId === null) continue;
        panes.set(paneId, toCanvas(el.getBoundingClientRect()));
      }
      const startRect =
        draggedAtStart === "measured"
          ? panes.get(draggedPaneId)
          : draggedAtStart;
      if (startRect === undefined) return { zones: [], origin: null };
      // A slot's rect is the union of what stands in it — one pane's frame
      // for a lone card or a stack, the whole divided run for a split column.
      // Read off the members rather than re-solved, for the reason above.
      const slots = new Map<number, Rect>();
      const kind = state.imposition.kind;
      if (kind !== undefined) {
        for (const pane of state.panes) {
          if (pane.slot === undefined) continue;
          const rect = panes.get(pane.id);
          if (rect === undefined) continue;
          const slot = clampSlot(kind, pane.slot);
          const standing = slots.get(slot);
          if (standing === undefined) {
            slots.set(slot, rect);
            continue;
          }
          const top = Math.min(standing.y, rect.y);
          const bottom = Math.max(
            standing.y + standing.height,
            rect.y + rect.height,
          );
          slots.set(slot, {
            x: Math.min(standing.x, rect.x),
            y: top,
            width: Math.max(standing.width, rect.width),
            height: bottom - top,
          });
        }
        // The held-open places. A slot with no pane in it has nothing above
        // to measure, and `drop-zones.ts` has advertised an empty anchor as
        // one of its four zone kinds since it shipped — a branch that has
        // been unreachable the whole time, because a missing rect makes the
        // slot advertise nothing. The vacancy tile is what closes that: it
        // stands at the anchor and the width a card landing there would
        // take, so the tile IS the promise the indicator draws.
        //
        // Read off the DOM like everything else here, and for the same
        // reason: the alternative is re-solving the anchor from the kind,
        // the rail widths and the band, which is a second derivation of
        // geometry the CSS `calc()` chain owns and can drift from.
        for (const el of canvas.querySelectorAll<HTMLElement>(
          ".tug-slot-vacancy[data-vacant-slot]",
        )) {
          const slot = Number(el.getAttribute("data-vacant-slot"));
          if (!Number.isInteger(slot) || slots.has(slot)) continue;
          slots.set(slot, toCanvas(el.getBoundingClientRect()));
        }
      }
      // The held-open deck edge, read the same way: the tile IS the promise
      // the indicator draws for a side with no rail ([B10]).
      const railVacancies: Partial<Record<SidebarSide, Rect>> = {};
      for (const el of canvas.querySelectorAll<HTMLElement>(
        ".tug-rail-vacancy[data-vacant-rail]",
      )) {
        const side = el.getAttribute("data-vacant-rail");
        if (!isSidebarSide(side)) continue;
        railVacancies[side] = toCanvas(el.getBoundingClientRect());
      }
      // The rails, read once: the engine needs their membership, their
      // shares and their floors, and three readings of one rail would
      // agree only by luck.
      const railsForZones = sidebarRailsOf(state, UNMEASURED_RUNS);
      return enumerateDropZones(state, draggedPaneId, {
        slots,
        panes,
        tabBars,
        // The band's edges, so a content card's places are clipped to
        // what the reader can see: a slot tile that has slid under a rail
        // measures at its true rect and would otherwise be offered there.
        // A remote drag asks for none: its picture draws the whole strip.
        band: clipToBand ? store.getBandEdges() : null,
        // The runs are the deck's own measurement rather than a sum of the
        // frames above: a frame in flight is one of those frames, and the
        // store is the one reader a hand cannot move.
        runs: {
          column: store.getColumnRunHeight(),
          rail: store.getRailRunHeight(),
        },
        draggedAtStart: startRect,
        railVacancies,
        // Every member of every place, by pane id: the engine allocates its
        // tiles from these, and it keys everything by pane, so a rail member
        // is re-keyed here beside its shares — the one boundary that can see
        // both names for a member.
        members: placeMembersByPaneId(state, railsForZones),
        rails: railsForZones.map((rail) => {
          // The engine keys everything by pane id; the rail's stored shares
          // are keyed by componentId, so they re-key here, at the one place
          // that can see both names for a member.
          const stored = state.imposition.rails?.[rail.side]?.shares;
          const shares: Record<string, number> = {};
          if (stored !== undefined) {
            for (const member of rail.members) {
              const weight = stored[member.componentId];
              if (weight !== undefined) shares[member.paneId] = weight;
            }
          }
          return {
            side: rail.side,
            members: rail.members.map((member) => member.paneId),
            shares,
          };
        }),
      });
    };
    const outline = (zone: DropZone | null): void => {
      // A tab bar indicates through the attribute it has always indicated
      // through, which the gesture stamps itself — showing the outline there
      // too would be two answers to one question ([P10]).
      const rect = zone === null || zone.kind === "tab-bar" ? null : zone.rect;
      indicateDropZone(containerRef.current, rect);
    };
    const carry = (kind: "rail" | "card" | null): void => {
      const canvas = containerRef.current;
      if (canvas === null) return;
      if (kind === null) canvas.removeAttribute("data-carrying");
      else canvas.setAttribute("data-carrying", kind);
    };
    return {
      enumerate(draggedPaneId, tabBars, draggedAtStart) {
        return measureAndEnumerate(draggedPaneId, tabBars, draggedAtStart, {
          clipToBand: true,
        });
      },

      enumerateRemote(draggedPaneId) {
        return measureAndEnumerate(draggedPaneId, new Map(), "measured", {
          clipToBand: false,
        });
      },

      outline,

      indicate(zone) {
        outline(zone);
        // Instruments away from the canvas hear the same answer ([P08]): a
        // place being offered, or none. A tab bar publishes none, so the
        // miniature's highlight and the canvas outline say the same thing.
        const rect =
          zone === null || zone.kind === "tab-bar" ? null : zone.rect;
        publishDragZone(canvasFractionOf(rect));
      },

      gaugeDragFrame(frame) {
        // Measured off the DOM for the same reason the zones are: the frame is
        // travelling on a transform the browser has already resolved, and its
        // own box is the only answer that cannot drift from what the user sees.
        publishDragFrame(
          frame === null
            ? null
            : canvasFractionOf(canvasRectOf(frame.getBoundingClientRect())),
        );
        // The canvas says a card is in the air, which is what the held-open
        // places read to show themselves, and the VALUE says which kind is in
        // the air: `"rail"` for a sidebar card, `"card"` for a content card.
        // A place reacts to a drag only when the drag could land in it ([B01]),
        // and the kind is what each rule selects on to know. It is read off the
        // travelling frame's own `data-role`, which the pane already stamps
        // `"sidebar"` on a rail member — the frame says what it is, so no
        // second channel is needed to carry the fact ([B02]).
        //
        // A DOM write, never React state
        // ([L06]): it turns on the frames of a drag, and re-rendering the deck
        // to change the appearance of an empty slot is a re-render for nothing.
        //
        // This verb is the right hook because it is already the drag's
        // lifecycle — it is called with a frame when one starts travelling and
        // with null when the gesture retires, by every path that ends one.
        carry(
          frame === null
            ? null
            : frame.getAttribute("data-role") === "sidebar"
              ? "rail"
              : "card",
        );
      },

      carry,

      commit(zone, draggedPaneId) {
        const state = store.getSnapshot();
        const pane = state.panes.find((p) => p.id === draggedPaneId);
        if (pane === undefined) return false;
        switch (zone.kind) {
          case "slot": {
            // The origin. A release that landed where it started is a gesture
            // that succeeded at doing nothing, not a refusal.
            if (
              pane.slot !== undefined &&
              state.imposition.kind !== undefined &&
              clampSlot(state.imposition.kind, pane.slot) === zone.slot
            ) {
              return true;
            }
            return store.movePaneToSlot(draggedPaneId, zone.slot).ok;
          }
          case "column-index": {
            const column = deckColumnsOf(state, null).find(
              (c) => c.slot === zone.slot,
            );
            if (column === undefined) return false;
            if (!column.members.includes(draggedPaneId)) {
              return store.movePaneToSlot(
                draggedPaneId,
                zone.slot,
                zone.index,
              ).ok;
            }
            const order = column.members.filter((id) => id !== draggedPaneId);
            order.splice(zone.index, 0, draggedPaneId);
            store.setColumnOrder(zone.slot, order, draggedPaneId);
            return true;
          }
          case "rail-index": {
            // A rail is keyed by card TYPE, not by pane: a member's place
            // survives its card being closed and reopened, which a pane id
            // could never do. The zone counts positions, so the mapping back to
            // componentIds happens here, where the rail's own reading is.
            const rails = sidebarRailsOf(state, UNMEASURED_RUNS);
            const from = rails.find((r) =>
              r.members.some((m) => m.paneId === draggedPaneId),
            );
            const dragged = from?.members.find((m) => m.paneId === draggedPaneId);
            if (from === undefined || dragged === undefined) return false;
            if (from.side !== zone.side) {
              // Crossing the deck: side and both orders in one commit, so the
              // gesture arms one settle and the card lands where the zone
              // said rather than at the side's default position first.
              store.moveSidebarToRail(dragged.componentId, zone.side, zone.index);
              return true;
            }
            const order = from.members
              .filter((m) => m.paneId !== draggedPaneId)
              .map((m) => m.componentId);
            order.splice(zone.index, 0, dragged.componentId);
            store.setRailOrder(zone.side, order);
            return true;
          }
          // The merge is the gesture's own to commit, through `onCardMerged`
          // with the insert index it hit-tests along the bar ([P10]).
          case "tab-bar":
            return true;
        }
      },

      autoscrollTargetFor(pointer, draggedPaneId) {
        const canvas = containerRef.current;
        if (canvas === null) return null;
        const state = store.getSnapshot();

        // Which strips are even askable is a fact about the card in the air,
        // decided once, here. A rail card can only land in a rail and a
        // content card can only land in a column or the band, and a strip a
        // card cannot land in must not move under it ([B01], [B04]) — a rail
        // card carried across the band used to reach the flow branch below and
        // scroll the content strip to its end, and a content card held over an
        // overflowing rail used to scroll the rail.
        //
        // Membership is read the way the engine reads it — `sidebarRailsOf`
        // over the same snapshot, which is the expression `enumerate` above
        // hands `enumerateDropZones` as `measured.rails`. One source for
        // "is this a rail card?" is what keeps the two from disagreeing.
        const railCard = sidebarRailsOf(state, UNMEASURED_RUNS).some((rail) =>
          rail.members.some((member) => member.paneId === draggedPaneId),
        );

        // A rail first, and for the reason a column comes before the band: a
        // pointer inside an overflowing rail's run is asking about that rail.
        // Rails are asked about before columns because a rail's band is the
        // deck's edge, which no column occupies — the two cannot both claim a
        // pointer, and asking in a fixed order keeps that a fact rather than a
        // coincidence. The order is untouched by the gate above; the branches
        // that cannot apply are skipped, not reordered.
        const railRun = store.getRailRunHeight();
        if (railCard && railRun !== null) {
          for (const rail of sidebarRailsOf(state, { rail: railRun, column: null })) {
            const allocation = rail.allocation;
            if (allocation === null || allocation.standing !== "overflow") {
              continue;
            }
            // The band is read off a member that STAYED PUT: the dragged
            // card's frame carries its drag transform, so a place read
            // through it walks off with the hand ([B07]). An overflowing place
            // has at least two members — the floors of one always fit — so
            // there is always a seated one to read.
            const seated =
              rail.members.find((m) => m.paneId !== draggedPaneId) ??
              rail.members[0];
            const first = canvas.querySelector<HTMLElement>(
              `.tug-pane[data-pane-id="${seated.paneId}"]`,
            );
            if (first === null) continue;
            const zoom = pageZoomFactor();
            const canvasRect = canvas.getBoundingClientRect();
            const rect = first.getBoundingClientRect();
            const left = (rect.left - canvasRect.left) / zoom;
            const width = rect.width / zoom;
            if (pointer.x < left || pointer.x > left + width) continue;
            return {
              kind: "rail",
              side: rail.side,
              axis: "y",
              bandStart: RAIL_EDGE_INSET_PX,
              bandEnd: RAIL_EDGE_INSET_PX + railRun,
              offset: state.railOffsets?.[rail.side] ?? 0,
              maxOffset: Math.max(0, allocation.stripLength - railRun),
            };
          }
        }

        // A rail card has now been offered every rail there is. The column and
        // the band are not places it can land, so it is asking about nothing.
        if (railCard) return null;

        // A column first: it is the narrower question, and a pointer inside an
        // overflowing column's run is asking about that column rather than
        // about the band it happens to sit in.
        const run = store.getColumnRunHeight();
        if (run !== null) {
          for (const column of deckColumnsOf(state, run)) {
            const allocation = column.allocation;
            if (allocation === null || allocation.standing !== "overflow") {
              continue;
            }
            // Off a seated member, for the reason the rail's is ([B07]).
            const seated =
              column.members.find((id) => id !== draggedPaneId) ??
              column.members[0];
            const first = canvas.querySelector<HTMLElement>(
              `.tug-pane[data-pane-id="${seated}"]`,
            );
            if (first === null) continue;
            const zoom = pageZoomFactor();
            const canvasRect = canvas.getBoundingClientRect();
            const rect = first.getBoundingClientRect();
            const left = (rect.left - canvasRect.left) / zoom;
            const width = rect.width / zoom;
            if (pointer.x < left || pointer.x > left + width) continue;
            return {
              kind: "column",
              slot: column.slot,
              axis: "y",
              bandStart: IMPOSITION_GAP_PX,
              bandEnd: IMPOSITION_GAP_PX + run,
              offset: state.columnOffsets?.[column.slot] ?? 0,
              maxOffset: Math.max(0, allocation.stripLength - run),
            };
          }
        }

        // The band's true edges rather than the bare gap: under a left rail
        // the band begins past the rail's inset, and a trigger measured from
        // the gap fires in the middle of the deck.
        const edges = store.getBandEdges();
        const strip = deckFlowStrip(state);
        if (edges === null || strip === null) return null;
        const band = edges.end - edges.start;
        return {
          kind: "flow",
          axis: "x",
          bandStart: edges.start,
          bandEnd: edges.end,
          offset: state.flowOffset ?? 0,
          maxOffset: Math.max(0, strip.width - band),
          strip,
        };
      },

      applyScroll(target, offset) {
        const el = containerRef.current;
        if (el === null) return;
        if (target.kind === "flow") {
          writeCanvasFlowOffset(el, Math.round(offset));
        } else {
          const property =
            target.kind === "column"
              ? columnOffsetProperty(target.slot ?? 0)
              : railOffsetProperty(target.side ?? "left");
          const value = `${Math.round(offset)}px`;
          el.style.setProperty(property, value);
          // The shown layer carries its own copy of every arrangement
          // variable, and its frames inherit from it rather than from the
          // canvas — so a write here alone moves the canvas's seams and
          // leaves every frame standing at the committed offset until the
          // drop re-renders the layer. The flow offset reaches its readers
          // through `writeCanvasFlowOffset` for the same reason.
          el.querySelector<HTMLElement>(
            `.${SPACE_LAYER_CLASS}[${SPACE_SHOWN_ATTRIBUTE}]`,
          )?.style.setProperty(property, value);
        }
        // The same number, in the same frame, to every instrument listening
        // ([P08]). The band the strip slides under is the target's own, so the
        // fraction is exact rather than re-measured off the DOM.
        const band = target.bandEnd - target.bandStart;
        if (band <= 0) return;
        if (target.kind === "column") {
          publishColumnOffset(target.slot ?? 0, offset / band);
        } else if (target.kind === "flow") {
          publishFlowOffset(offset / band);
        }
      },

      commitScroll(target, offset) {
        // `"cut"`: `applyScroll` has been writing this strip's custom property
        // every frame of the drag, so the deck is already drawn at this number
        // and there is nothing for the settle to carry ([B01], [B03]).
        if (target.kind === "column")
          store.setColumnOffset(target.slot ?? 0, offset, "cut");
        else if (target.kind === "rail")
          store.setRailOffset(target.side ?? "left", offset, "cut");
        else store.setFlowOffset(offset, "cut");
      },
    };
  }, [store]);

  // The host is reachable off the canvas, for a drag whose hand is on the
  // Layout miniature. Registered in a layout effect so it is there before any
  // event can ask for it ([L03]); cleared only if it is still this one.
  useLayoutEffect(() => {
    registerDropZoneHost(dropZoneHost);
    return () => {
      if (getDropZoneHost() === dropZoneHost) registerDropZoneHost(null);
    };
  }, [dropZoneHost]);

  // ---------------------------------------------------------------------------
  // The switch is a cut, and what it leaves behind is the epoch
  // ---------------------------------------------------------------------------
  // A workspace switch lands as a cut ([B01]): both sets of frames are already
  // drawn where the commit puts them, the settle declines it, and nothing moves.
  // Nothing is painted over anything and nothing is faded — the reader sees the
  // arriving workspace in the first frame the browser serves after the click
  // task ends. Tried live against every crossfade variant the sketch built, the
  // pure cut was the one the user called "better, by a lot" ([F08]).
  //
  // What the cut does NOT answer is how long the arriving workspace goes on
  // ARRIVING. Geometry a hidden layer could not take — a composer's line box, a
  // pane bar's controls width, a sheet's clamps — lands in the commits after the
  // swap, and a pane whose rect moves in those frames must not be animated to
  // its new place: the reader gestured at a workspace, not at that pane ([B05]).
  // `data-space-switching` is the mark that stands the imposer down over that
  // window, `DeckManager` writes it inside the swap commit, and this effect is
  // what owes it back.
  //
  // So this effect is now one thing: the rule for when the epoch closes.
  // `space-settled.ts` decides it over three facts — two watched and one
  // counted — and the gate below is what gathers them. Everything here is DOM:
  // one attribute on the container, no React state, nothing that renders ([L06]).
  //
  // **The mark has ONE writer now, and that is what re-shaped this effect.**
  // While the cover existed this body stripped the mark unconditionally on entry
  // and then re-asserted it for the length of the hold, so two owners wrote it
  // across two consecutive windows. With no hold there is nothing to re-assert
  // it, and an entry sweep would strip the mark in the very commit that OPENED
  // the epoch — ending it before it began and handing every late re-arm straight
  // to the imposer. So the entry path drops the prior epoch's timers and never
  // touches the attribute, and the attribute comes off only on a path that ends
  // an epoch.
  //
  // It is a debt from the frame it is written ([L32]), and three paths pay it:
  // the gate closing, the bound, and the deadline standing behind both. The
  // effect's cleanup drops the machinery WITHOUT touching the mark, because on a
  // switch that cleanup runs after the next swap commit has already written it.
  const switchEpochRef = useRef<{
    generation: number;
    deadline: number | null;
    /**
     * The gate's own teardown, while an epoch is open.
     *
     * Held on the state object rather than in the effect's closure because
     * every path that ends an epoch has to close it, including the ones that
     * arrive from a LATER effect run — which has no reach into the earlier run's
     * variables. A gate left open holds a `ResizeObserver`, a frame callback and
     * a timer, all asking a question nothing can act on any more.
     */
    closeGate: (() => void) | null;
  }>({
    generation: 0,
    deadline: null,
    closeGate: null,
  });
  // Nothing loops in the dark, part two: a loop that STARTS under a hidden
  // layer is paused as it starts. The switch effect below handles the loops
  // that exist at the switch; this is for the card mounted into a parked
  // workspace, or the component whose loop begins on a store change while its
  // workspace is off screen. Delegated on the container because
  // `animationstart` bubbles and names its animation — see
  // `space-layer-loops.ts` for why this is not a stylesheet rule.
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (el === null) return;
    el.addEventListener("animationstart", stillLoopOnStart);
    return () => {
      el.removeEventListener("animationstart", stillLoopOnStart);
    };
  }, []);
  // And a rail hidden whole: its members park (`data-rail-parked`) rather
  // than close, so their loops are stilled in the commit that parks them and
  // resumed in the one that stands them again — the same pass, keyed on which
  // panes are parked.
  const parkedPaneKey = [...shownArrangement.parkedRailSideByPaneId.keys()].sort().join(" ");
  useLayoutEffect(() => {
    const root = containerRef.current;
    if (root !== null) stillHiddenLayerLoops(root);
  }, [parkedPaneKey]);
  // And part three: the motion switch thrown back. The pass resumes every loop
  // on its record whose layer is shown, demoted or not, so the off edge has
  // only one kind left to hand back: a loop whose resume a component's own
  // `animation-play-state: paused` declined. The stylesheet letting go cannot
  // resume a loop the Web Animations API paused, so the off edge runs the same
  // pass a workspace switch runs, and any declined resume is tried again ([L32]).
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (el === null) return;
    return motionBreaker.onResume(() => {
      stillHiddenLayerLoops(el);
    });
  }, []);

  /** The workspace the last commit was showing — the one a switch leaves. */
  const previousSpaceIdRef = useRef<string | null>(null);
  /**
   * The switch frame sampler's canceller, while one is running (Spec S01).
   *
   * On a ref rather than in the effect's closure because the sampler is armed
   * ABOVE the effect's early returns, and those paths run no cleanup — the next
   * switch and the canvas's unmount are what stop it there.
   */
  const switchFrameSamplerRef = useRef<(() => void) | null>(null);
  useEffect(() => () => switchFrameSamplerRef.current?.(), []);
  useLayoutEffect(() => {
    const activeSpaceId = spacesSnapshot.activeSpaceId;
    const previousSpaceId = previousSpaceIdRef.current;
    previousSpaceIdRef.current = activeSpaceId;
    const state = switchEpochRef.current;

    // ---- The switch's frame record ([P01], Spec S01). ---------------------
    //
    // Armed here, above every early return below, because each of those is a
    // switch that still painted: reduced motion, a deleted outgoing workspace
    // and an empty one all arrive and all pay the rebuild this record measures.
    // A sampler armed lower down would report only the switches that happened
    // to open a cover.
    //
    // `performance.now()` read here IS the swap commit: this is a layout effect
    // on the commit that swapped the layers, still inside the click task, so no
    // frame can have been served yet. It is NOT the gesture, and the record's
    // first-paint number is measured from the gesture instead — the store's
    // stamp, taken as `activateSpace` was entered. Measured, this commit lands
    // about 75 ms after that stamp on a three-workspace deck, because React's
    // whole render of the canvas runs between the store's notify and the
    // commit it produces; a record that began here reported a third of the
    // freeze and called it the whole. `commitDelayMs` carries the difference.
    //
    // It reads nothing off the DOM and classifies nothing per tick — one
    // timestamp pushed, and one classification when the window closes. A probe
    // whose own cost lands inside the window it measures is measuring itself.
    //
    // **Gated on this kind being armed BY NAME, and that gate is load-bearing.**
    // `record` would drop the row anyway, but the LOOP would still have run —
    // 600 ms of rAF callbacks per switch, producing numbers nobody reads. That
    // is the per-frame JS the animation doctrine's [D1] bans, and it was
    // measured rather than reasoned about: ungated, this loop pushed `at0622`'s
    // move-beat gap bar from under two display frames to 2.12–2.29, and a
    // reverse-patch probe of these two files put it back under.
    //
    // The global `enable(true)` is NOT a narrow enough door, which is the second
    // half of the same finding: the settle app-tests turn tracing on to read the SETTLE's
    // frame record, so a global gate armed this sampler inside a test measuring
    // something else, and the red survived. `enableKind` is per-kind for exactly
    // this — an instrument that costs frames is armed by the reading that wants
    // it, never by a neighbour.
    if (
      deckTrace.isKindEnabled("space-switch-frames") &&
      previousSpaceId !== null &&
      previousSpaceId !== activeSpaceId
    ) {
      switchFrameSamplerRef.current?.();
      const armedAt = performance.now();
      const stampedAt = store.getSpaceSwitchStartedAt();
      // A stamp older than a few seconds belongs to some earlier switch — a
      // path that changed the active workspace without `activateSpace` would
      // leave one behind — and the commit is the honest origin then.
      const gestureAt =
        stampedAt !== null && armedAt - stampedAt < 5000 ? stampedAt : armedAt;
      const ticks: number[] = [];
      let sampleId: number | null = null;
      const stopSampler = (): void => {
        if (sampleId !== null) window.cancelAnimationFrame(sampleId);
        sampleId = null;
        if (switchFrameSamplerRef.current === stopSampler) {
          switchFrameSamplerRef.current = null;
        }
      };
      const sample = (t: number): void => {
        sampleId = null;
        ticks.push(t);
        if (t - armedAt < SPACE_SWITCH_FRAME_WINDOW_MS) {
          sampleId = window.requestAnimationFrame(sample);
          return;
        }
        stopSampler();
        deckTrace.record({
          kind: "space-switch-frames",
          ...classifySpaceSwitchFrames(activeSpaceId, armedAt, ticks, gestureAt),
        });
      };
      sampleId = window.requestAnimationFrame(sample);
      switchFrameSamplerRef.current = stopSampler;
    }

    /**
     * Drop the prior epoch's machinery, and touch the mark on no account.
     *
     * Bumps the generation first, so any landing still to arrive for the epoch
     * it just ended is a no-op. What it does NOT do is remove
     * `SPACE_SWITCHING_ATTRIBUTE`, and that omission is the whole correction of
     * this step: on a switch-driven run the swap commit has ALREADY written the
     * mark for the epoch now opening, so a sweep here would end that epoch in
     * the commit that opened it and every late re-arm would animate.
     */
    const releaseEpoch = (): void => {
      state.generation += 1;
      const closeGate = state.closeGate;
      state.closeGate = null;
      if (closeGate !== null) closeGate();
      if (state.deadline !== null) {
        window.clearTimeout(state.deadline);
        state.deadline = null;
      }
    };

    /**
     * Close the epoch: drop the machinery and pay the mark back ([L32]).
     *
     * Swept off the container by LOOKING rather than off a remembered element,
     * which is the only reading still right after a layer has been unmounted
     * underneath an epoch. Idempotent, and reached by the three paths that end
     * one — the gate going settled, the bound, and the deadline behind both.
     */
    const endEpoch = (): void => {
      releaseEpoch();
      const el = containerRef.current;
      if (el !== null) el.removeAttribute(SPACE_SWITCHING_ATTRIBUTE);
    };

    releaseEpoch();

    const root = containerRef.current;
    if (root === null) return;

    // Nothing loops in the dark ([B02]). A hidden layer keeps its layout and
    // its animations keep running on this engine, so the departing layer's
    // loops are paused here, in the commit that hides it, and the arriving
    // layer's are resumed in the one that shows it. Every run of this effect,
    // the first show included: a deck that boots with a parked workspace
    // already mounted has loops to still before any switch. Only infinite
    // loops, never a settle's tween — `space-layer-loops.ts` says why.
    stillHiddenLayerLoops(root);

    // ---- The stale pending arrival, swept ([P05]). ------------------------
    //
    // `pendingArrivalsRef` holds the pane ids a settle is keeping invisible
    // until their arrive beat comes round, and `arm`'s First pass skips every
    // id in it — a frame still arriving has no First rect to measure. The Last
    // pass then treats any shown frame with no First rect as an ARRIVAL: held
    // at inline `opacity: 0`, faded up as the chain's last beat.
    //
    // The set is cleared in exactly one place, `releaseSettle`, and `arm`'s
    // `"cut"` branch — the spelling a workspace switch commits under —
    // returns before it ever reaches one. So a card caught mid-arrival when
    // the user crosses to another workspace leaves its id in the set, and the
    // next arm back in that workspace reads frames that were on screen the
    // whole time as new arrivals and fades them in.
    //
    // **On the evidence, and what this does not claim.** at0621 stages that
    // precondition exactly — a card opened, a switch during its arrive beat, a
    // switch back — and the mass fade it recorded was NOT this: it was the
    // switch's own second commit arming a `"cross"` settle whose First pass
    // read the outgoing workspace and whose Last pass read the incoming one.
    // `SPACE_SWITCHING_ATTRIBUTE` is what closed that one. The stale id itself
    // is swept by the settle's window timer within about a second, so there is
    // no gesture this alone was observed to repair.
    //
    // It stands because the argument below holds without an observation: an
    // id nothing will ever collect is a hold nothing will ever hand back if
    // the window timer is the only thing that would have, and the window timer
    // is a wedge guard rather than a correctness path.
    //
    // A pending arrival for a pane that is NOT on screen is stale by
    // construction: the Last pass only ever walks `SHOWN_PANE_FRAMES`, so no
    // beat is ever coming for it. Dropping the id is therefore safe, and the
    // restorers have to run with it — they are what hands back the inline
    // `opacity: "0"` the hold wrote, and an id dropped without them leaves the
    // frame invisible rather than merely faded.
    //
    // ABOVE the three early returns below, and that placement is the point: a
    // stale pending arrival is stale whether or not a dissolve is opening, and
    // reduced motion, a deleted outgoing workspace and an empty one are
    // exactly the paths on which the id would otherwise be stranded.
    if (previousSpaceId !== null && previousSpaceId !== activeSpaceId) {
      const onScreen = new Set<string>();
      for (const frame of root.querySelectorAll<HTMLElement>(
        SHOWN_PANE_FRAMES,
      )) {
        const paneId = frame.getAttribute("data-pane-id");
        if (paneId !== null) onScreen.add(paneId);
      }
      for (const [paneId, pending] of [...pendingArrivalsRef.current]) {
        if (onScreen.has(paneId)) continue;
        pendingArrivalsRef.current.delete(paneId);
        for (const restore of pending.restores) restore();
      }
    }

    // Two ways there is no epoch to run, and each writes nothing at all rather
    // than opening one that would have to be closed. `previousSpaceId === null`
    // is the first show: `DeckManager` writes the mark only in `activateSpace`,
    // which needs a workspace to leave, so there is nothing outstanding there.
    //
    // Both close rather than plainly return, and this is the ONE place an
    // unconditional sweep is right — it is the exact complement of the path the
    // sweep would be fatal on. A real epoch only ever opens on a run where the
    // workspace CHANGED, so neither of these two can be ending one; what they
    // can do is find a mark that a swap wrote and that no gate was ever armed
    // for, which without this would stand forever with the imposer down under it
    // ([L32]). Removing the old unconditional entry teardown is what opened that
    // gap, so it is closed here rather than left to the deadline.
    if (previousSpaceId === null || previousSpaceId === activeSpaceId) {
      endEpoch();
      return;
    }

    // ---- The gate that closes the epoch (Spec S02). ------------------------
    //
    // Three sources, composed by `spaceEpochClosed` and gathered here. Two are
    // watched rather than polled; the third is counted, because "silent for N
    // consecutive frames" has no event to listen for.
    //
    // **Armed on every switch, with no reduced-motion or empty-layer escape.**
    // The cover's gate sat below an `isTugMotionEnabled()` return and an
    // outgoing-frames count, because both were reasons not to dissolve. Neither
    // is a reason not to close an epoch: the mark is written by the swap commit
    // whatever the motion setting says, so a path that returned before arming
    // would leave it standing with nothing left to take it off — the imposer
    // stood down on that canvas forever, which is the exact [L32] failure the
    // mark's own doc comment warns about.
    //
    // **And this is where [L32] bites hardest.** Between the swap commit and the
    // gate firing NOTHING is animating, so there is no `.finished` to land on
    // and the only things that can end the epoch are the bound and the deadline.
    // Hence the deadline is armed below over the whole window rather than
    // re-armed when the gate fires.
    const epochStart = performance.now();
    let lastCommitSeq = settleCommitSeqRef.current;
    let silentFrames = 0;
    let resizedSinceFrame = false;
    let frameId: number | null = null;
    let boundTimer: number | null = null;
    let fired = false;
    const generation = state.generation;

    // Source one: a pane frame under the ARRIVING layer changing box. The
    // recording says this is the only source that produced visible motion, so
    // it is what `silentFrames` is silent about.
    //
    // A `WeakMap` of last-seen boxes rather than swallowing the first callback:
    // `ResizeObserver` delivers an initial observation per target and may batch
    // them across deliveries, so "ignore the first callback" is a guess about
    // batching. "Ignore a box we have not seen before" is not.
    const seenBoxes = new WeakMap<Element, string>();
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const box = `${Math.round(entry.contentRect.width)}x${Math.round(
          entry.contentRect.height,
        )}`;
        const was = seenBoxes.get(entry.target);
        seenBoxes.set(entry.target, box);
        if (was !== undefined && was !== box) resizedSinceFrame = true;
      }
    });
    const shown = root.querySelector<HTMLElement>(
      `.${SPACE_LAYER_CLASS}[${SPACE_SHOWN_ATTRIBUTE}]`,
    );
    if (shown !== null) {
      observer.observe(shown);
      for (const frame of shown.querySelectorAll<HTMLElement>(
        ".tug-pane[data-pane-id]",
      )) {
        observer.observe(frame);
      }
    }

    const closeGate = (): void => {
      observer.disconnect();
      root.removeEventListener(IMPOSER_SETTLE_END, onSettleEnd);
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
        frameId = null;
      }
      if (boundTimer !== null) {
        window.clearTimeout(boundTimer);
        boundTimer = null;
      }
    };

    const fire = (reason: SpaceEpochReason): void => {
      if (fired) return;
      fired = true;
      if (state.closeGate === closeGate) state.closeGate = null;
      closeGate();
      // An epoch that was superseded has nothing left to record: a later switch
      // has already bumped the generation and owns the mark now, and recording
      // this one's span would attribute it to the wrong switch.
      if (state.generation !== generation) return;
      deckTrace.record({
        kind: "space-epoch",
        toSpaceId: activeSpaceId,
        epochMs: Math.round(performance.now() - epochStart),
        epochReason: reason,
      });
      endEpoch();
    };

    /**
     * Re-ask the rule. Never assumes a source firing means the epoch is over —
     * every source is a reason to ASK, and `spaceEpochClosed` is the only thing
     * that answers.
     */
    const evaluate = (): void => {
      if (fired) return;
      if (
        spaceEpochClosed({
          // Source two: the canvas's own settling mark, read rather than
          // remembered, so a settle that ended by any of its several paths is
          // seen the same way.
          settled: !root.hasAttribute("data-imposer-settling"),
          silentFrames,
          // The bound has its own timer and its own call to `fire`; asking
          // about it here would mean a second clock disagreeing with the first.
          boundElapsed: false,
        })
      ) {
        fire("settled");
      }
    };

    function onSettleEnd(): void {
      evaluate();
    }
    root.addEventListener(IMPOSER_SETTLE_END, onSettleEnd);

    // The frame counter, and the one thing here that is a loop. It runs ONLY
    // while the gate is open and is cancelled with it, so the canvas is not left
    // with a rAF pump nobody reads.
    //
    // Source three rides it: `settleCommitSeqRef` moving means a commit landed
    // since the last frame, which the recording says a rect watch alone would
    // miss in the gaps of a first show's commit train.
    const tick = (): void => {
      frameId = null;
      const seq = settleCommitSeqRef.current;
      if (seq !== lastCommitSeq || resizedSinceFrame) {
        lastCommitSeq = seq;
        resizedSinceFrame = false;
        silentFrames = 0;
      } else {
        silentFrames += 1;
      }
      evaluate();
      if (!fired) frameId = window.requestAnimationFrame(tick);
    };
    frameId = window.requestAnimationFrame(tick);

    boundTimer = window.setTimeout(() => {
      boundTimer = null;
      fire("bound");
    }, SPACE_EPOCH_BOUND_MS);

    state.closeGate = closeGate;

    // The deadline [L32] clause 2 asks for. The bound's own `setTimeout` is the
    // ordinary end, and this stands behind it: a canvas unmounted and remounted,
    // or a dropped timer, would otherwise strand the mark and leave the imposer
    // stood down on a deck the reader is working in. No tween length in it any
    // more — there is no tween — so it is the bound plus a margin, scaled the
    // way TugAnimator scales, so a slowed-down deck is not cut short by its own
    // safety net.
    const deadlineMs = spaceEpochDeadlineMs(getTugTiming());
    state.deadline = window.setTimeout(() => {
      state.deadline = null;
      if (state.generation === generation) endEpoch();
    }, deadlineMs);

    // The cleanup drops the machinery and leaves the mark alone. On a switch it
    // runs AFTER the next swap commit has written the mark for the next epoch,
    // so sweeping here would strip a debt that is not this run's to pay; on a
    // real unmount the container is going away with it.
    return () => releaseEpoch();
  }, [spacesSnapshot.activeSpaceId, store, settleCommitSeqRef, pendingArrivalsRef]);

  // ---------------------------------------------------------------------------
  // Scrolling the flow strip
  // ---------------------------------------------------------------------------
  // Three gestures move the strip — the rail's thumb, a click on one of its
  // numbered segments, and a horizontal (or shift-vertical) wheel anywhere on
  // the canvas — and all three come through this pair ([P11]). One per-frame
  // writer and one commit, which is what makes them one gesture family rather
  // than three implementations that agree by luck: the same clamp, the same
  // property, the same channel, and the same one-write-at-the-end rule the
  // autoscroll already obeys ([P01], [P12]).
  //
  // `previewFlowOffset` is the per-frame half, and it is the STORE's: the
  // Layout card's strip scrubs the same quantity onto the same element, so the one
  // writer lives where both callers can reach it ([P11]). This binds it for
  // the canvas's own gestures.
  const previewFlowOffset = useCallback(
    (offset: number): void => {
      store.previewFlowOffset(offset);
    },
    [store],
  );

  // And the commit: the store catches up with what the deck has been showing.
  // It changes no geometry — CSS was already drawing this number — except when
  // the caller is a segment click, which hands it a number the deck was NOT
  // showing and lets the settle animate the crossing.
  //
  // `named` is the slot the gesture NAMED, when it named one. A strip click
  // and a scrub's release both point at a place, so both get the same answer
  // the chord gets: the thing standing there is rung. The wheel names nothing —
  // it is a continuous drag on the band rather than a choice of destination —
  // so it passes no slot and rings nothing, which is why this is a parameter
  // rather than something derived from where the offset landed.
  const commitFlowOffset = useCallback(
    (offset: number, named?: number): void => {
      store.setFlowOffset(offset);
      if (named !== undefined) flashSlot(store, named);
    },
    [store],
  );

  // The wheel. Registered on the canvas itself in a layout effect ([L03]) and
  // non-passive, because acting on the event means taking it — otherwise the
  // page would pan under a deck that just scrolled its strip.
  //
  // It listens in the BUBBLE phase deliberately: a card's own scroller is
  // nearer the pointer and gets the event first, and this handler declines
  // whenever the target chain crosses something that can still scroll the way
  // the wheel is pointing. Skimming a transcript sideways must not slide the
  // deck (the routing conventions in `use-outer-scroll-on-modifier-wheel.ts`).
  //
  // Accumulation lives in a ref and the gesture ends on an idle timeout, which
  // is the only end a wheel has — there is no "up" to commit on.
  //
  // A trackpad does have an "up": Tug.app forwards its phase edges over the
  // scroll-phase bridge, and `phase` follows them. `tracking` is a gesture the
  // strip follows 1:1. `released` is the stretch after the fingers lifted:
  // the gesture has already ended — on the `lifted` edge, or on `momentum` if
  // that arrived first — and committed its stop, and every delta macOS keeps
  // sending on the hand's behalf is taken and draws nothing, so the settle is
  // the only motion from the lift to the landing. It lasts until the next
  // `touched` or the quiet. `touched` marks a gesture that saw the fingers go
  // down; its quiet is only a guard against a lift that never arrives. A
  // gesture with no edge at all — a mouse wheel, a synthetic event — ends on
  // the idle quiet exactly as before.
  //
  // A touch while the release slide is still running catches the strip: the
  // settle hands it over at the pose on screen, the gesture opens there with
  // its hump already cleared — a hand catching a moving strip has committed
  // to moving it — and the strip tracks 1:1 from that frame ([B06]).
  //
  // `held` is the gesture's hump ([B02]): the sum of the deltas taken since
  // the gesture opened, standing only until it passes `FLOW_WHEEL_HUMP_PX`.
  // While it stands the strip draws nothing — a resting hand's pixel of
  // wobble is taken (so nothing else scrolls) and moves nothing. The first
  // event past it draws the sum LESS the hump, so the strip continues from
  // where it stood rather than lurching the whole sum at once, and from there
  // every delta tracks 1:1. It is null once cleared, and a pause inside the
  // swipe does not re-arm it: only the idle end of the gesture does, by
  // opening the next one held. A gesture that never clears it ends on the
  // same idle and commits nothing, because nothing was drawn.
  //
  // `recent` is the last few deltas with their timestamps, newest last. Its
  // tail is the direction the hand was LAST moving, which is what the release
  // settles toward ([B03]) — the net of the swipe would send a hand that
  // reversed back the way it came. On a lift the whole ring is the hand's
  // speed, which the release slide launches at.
  const wheelGestureRef = useRef<{
    phase: "idle" | "tracking" | "released";
    touched: boolean;
    offset: number;
    held: number | null;
    recent: { delta: number; t: number }[];
    timer: number | null;
  }>({
    phase: "idle",
    touched: false,
    offset: 0,
    held: null,
    recent: [],
    timer: null,
  });
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (el === null) return;
    const gesture = wheelGestureRef.current;

    const scrollableAncestor = (target: EventTarget | null): boolean => {
      let node = target instanceof Element ? target : null;
      while (node !== null && node !== el) {
        if (node.scrollWidth - node.clientWidth > 1) {
          const overflow = getComputedStyle(node).overflowX;
          if (overflow === "auto" || overflow === "scroll") return true;
        }
        node = node.parentElement;
      }
      return false;
    };

    // The release ([B03], [B04]): the hand's offset settles on to the next
    // stop in the direction it was last moving. The strip and band are read
    // again here rather than carried from the last event — a commit
    // mid-gesture may have re-laid the strip, and the stops are the strip's.
    // A hand already on a stop (within the near slack) commits exactly that
    // stop as a cut, so the frames stand still and the store catches up by at
    // most the slack; one with a stop ahead commits the stop, and the settle
    // slides there from the drawn offset. A gesture that never cleared its
    // hump drew nothing and commits nothing.
    //
    // `velocity` is the hand's speed at a lift, in offset px per second, and
    // rides the commit to the settle; the quiet passes none, its hand having
    // already stopped.
    const endGesture = (velocity: number | null): void => {
      const cleared = gesture.held === null;
      gesture.held = null;
      if (!cleared) return;
      const now = store.getSnapshot();
      const stripNow = deckFlowStrip(now);
      const bandNow = store.getBandWidth();
      if (stripNow === null || bandNow === null || bandNow <= 0) {
        commitFlowOffset(gesture.offset);
        return;
      }
      const direction = gesture.recent
        .slice(-FLOW_WHEEL_RECENT_DELTAS)
        .reduce((sum, r) => sum + r.delta, 0);
      const stop = flowNextStop({
        strip: stripNow,
        band: bandNow,
        offset: gesture.offset,
        direction,
        // A lift's speed lets a quick swipe skip slots; the quiet's hand has
        // already stopped and lands on the next stop.
        velocity: velocity ?? undefined,
      });
      if (Math.abs(stop - gesture.offset) <= FLOW_STOP_NEAR_PX) {
        store.setFlowOffset(stop, "cut");
      } else {
        if (velocity !== null) store.setDrawnFlowVelocity(velocity);
        commitFlowOffset(stop);
      }
    };

    // The hand's speed now, in offset px per second: the deltas inside the
    // window, over the time from the oldest of them to now. A hand that
    // stopped before it lifted has nothing in the window and reads zero.
    const handVelocity = (): number => {
      const now = performance.now();
      const inWindow = gesture.recent.filter(
        (r) => now - r.t <= FLOW_WHEEL_VELOCITY_MS,
      );
      if (inWindow.length < 2) return 0;
      const span = now - inWindow[0].t;
      if (span <= 0) return 0;
      const travel = inWindow.slice(1).reduce((sum, r) => sum + r.delta, 0);
      return (travel / span) * 1000;
    };

    const clearTimer = (): void => {
      if (gesture.timer === null) return;
      window.clearTimeout(gesture.timer);
      gesture.timer = null;
    };

    // The quiet. A tracking gesture with no edge ends on it; one that saw the
    // fingers touch waits the longer lift guard; a released stretch simply
    // closes, since its gesture already ended at the lift.
    const armQuiet = (): void => {
      clearTimer();
      const ms =
        gesture.phase === "tracking" && gesture.touched
          ? FLOW_WHEEL_LIFT_GUARD_MS
          : FLOW_WHEEL_IDLE_MS;
      gesture.timer = window.setTimeout(() => {
        gesture.timer = null;
        const tracking = gesture.phase === "tracking";
        gesture.phase = "idle";
        gesture.touched = false;
        if (tracking) endGesture(null);
      }, ms);
    };

    const onWheel = (event: WheelEvent): void => {
      // Shift+vertical is the mouse's horizontal: a wheel with one axis says
      // sideways by holding the modifier, a trackpad says it with deltaX. A
      // mostly-vertical trackpad swipe carries a little deltaX with it, so the
      // dominant axis decides — otherwise scrolling a card would drift the
      // deck sideways.
      const horizontal =
        event.deltaX !== 0 && Math.abs(event.deltaX) > Math.abs(event.deltaY);
      const delta = horizontal
        ? event.deltaX
        : event.shiftKey && event.deltaX === 0
          ? event.deltaY
          : 0;
      if (delta === 0) return;
      // After the lift, every delta is macOS's momentum: taken, so the page
      // does not pan, and drawn nowhere, so the settle is the only motion.
      if (gesture.phase === "released") {
        event.preventDefault();
        armQuiet();
        return;
      }
      const state = store.getSnapshot();
      const strip = deckFlowStrip(state);
      const band = store.getBandWidth();
      if (strip === null || band === null || band <= 0) return;
      if (scrollableAncestor(event.target)) return;
      event.preventDefault();
      // A gesture opens held, with its offset picked up from the store on its
      // first event and carried in the ref after that, so a commit landing
      // mid-gesture cannot rewind the hand. Clamped every frame with the
      // store's own arithmetic, so the frame never shows an overshoot the
      // commit would reject.
      if (gesture.phase === "idle") {
        gesture.phase = "tracking";
        gesture.offset = state.flowOffset ?? 0;
        gesture.held = 0;
        gesture.recent = [];
      }
      // Timed on the clock the lift reads, at the moment the deck takes the
      // delta — not `event.timeStamp`, whose origin WebKit does not promise
      // matches `performance.now()`.
      gesture.recent.push({ delta, t: performance.now() });
      if (gesture.recent.length > FLOW_WHEEL_RING) gesture.recent.shift();
      let travel = delta;
      if (gesture.held !== null) {
        gesture.held += delta;
        if (Math.abs(gesture.held) < FLOW_WHEEL_HUMP_PX) {
          travel = 0;
        } else {
          travel = gesture.held - Math.sign(gesture.held) * FLOW_WHEEL_HUMP_PX;
          gesture.held = null;
        }
      }
      if (travel !== 0) {
        gesture.offset = clampFlowOffset(
          gesture.offset + travel,
          strip.width,
          band,
        );
        previewFlowOffset(gesture.offset);
      }
      armQuiet();
    };

    // The touch that catches a running slide. The settle holds the strip
    // where the eye has it and answers that offset; the gesture opens there,
    // tracking with no hump, and the store is caught up to it as a cut —
    // the frames are already there — so the next lift's commit is a change
    // from the caught place rather than a no-op against the slide's stop.
    // Until the hand moves, the slide's own direction stands as the hand's,
    // so a hand that lifts without moving is still carried on, never back;
    // the seed is timed out of the velocity window, so it adds no speed.
    const catchSlide = (): void => {
      const stop = store.getSnapshot().flowOffset ?? 0;
      const caught = takeFlowFromSettle(el);
      if (caught === null) return;
      const live = Math.round(caught);
      gesture.phase = "tracking";
      gesture.offset = live;
      gesture.held = null;
      gesture.recent =
        live === stop ? [] : [{ delta: Math.sign(stop - live), t: -Infinity }];
      previewFlowOffset(live);
      store.setFlowOffset(live, "cut");
    };

    // The host's phase edges. `touched` ends a released stretch — the next
    // delta opens a fresh gesture — and marks the gesture as one that ends on
    // the lift, catching the strip if a slide is still carrying it.
    // `lifted`, or `momentum` when it beats a late lift, ends a
    // tracking gesture at once and swallows what follows. An edge for a
    // gesture the deck never took (the deltas went to a card's own scroller)
    // moves nothing here, so that card keeps its momentum.
    const unsubscribe = subscribeScrollPhase((edge) => {
      if (edge === "touched") {
        if (gesture.phase === "released") {
          clearTimer();
          gesture.phase = "idle";
        }
        gesture.touched = true;
        if (gesture.phase === "idle") catchSlide();
        if (gesture.phase === "tracking") armQuiet();
        return;
      }
      if (gesture.phase !== "tracking") {
        if (gesture.phase === "idle") gesture.touched = false;
        return;
      }
      gesture.phase = "released";
      gesture.touched = false;
      endGesture(handVelocity());
      armQuiet();
    });

    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      el.removeEventListener("wheel", onWheel);
      unsubscribe();
      clearTimer();
      gesture.phase = "idle";
      gesture.touched = false;
    };
  }, [store, previewFlowOffset, commitFlowOffset]);

  // Merge `deckRootRef` (pane-focus-controller's query scope) and
  // `responderRef` (responder-chain wiring) onto the same element.
  // `useCallback` with `[responderRef]` keeps the callback identity
  // stable across renders because `useResponder` returns a stable
  // ref callback. Same pattern as `rootRefCallback` in tug-pane.tsx.
  const setDeckRef = useCallback(
    (el: HTMLDivElement | null) => {
      deckRootRef.current = el;
      responderRef(el);
    },
    [responderRef],
  );

  return (
    <ResponderScope>
      {/*
       * Responder root wrapper: filters all pointerdowns below through
       * this element's data-responder-id so the chain's document-level
       * promotion resolves "deck-canvas" as the ancestor responder
       * when a click lands on the canvas background or any card
       * without its own data-responder-id. Card-level responders
       * inside containerRef win via innermost-first DOM walk.
       */}
      {/*
        * `overflow: clip` is the deck's "the page is not a scroller" law, not a
        * styling choice. A pane parked so its frame reaches past a window edge
        * overflows this box; because `#deck-container` is unpositioned, that
        * overflow resolves against the viewport and lands in `<body>`'s scroll
        * box, which `globals.css` makes invisible (`overflow: hidden`) but NOT
        * unscrollable. Anything that walks ancestor scrollports — a stray
        * `scrollIntoView`, a browser focus reveal — can then scroll the page,
        * which slides the whole deck under the window with no scrollbar, no
        * wheel target, and no gesture that returns it.
        *
        * `clip` (not `hidden`) is the operative word: it clips at the same box
        * but forms no scroll container at all, so the range never exists to be
        * spent. Panes are already clipped at the window edge by the window
        * itself, so nothing that was visible before is lost.
        */}
      <div ref={setDeckRef} style={{ position: "absolute", inset: 0, overflow: "clip" }}>
      {/*
        * DeckCommitBeacon: zero-output React commit observer. Mounted
        * once at the deck root so every React commit of the deck tree
        * emits a `commit-tick` event into the deck trace. See
        * deck-commit-beacon.tsx for the rationale.
        */}
      <DeckCommitBeacon />
      {/*
        * containerRef wrapper: positioning context for card frames, snap guides,
        * and SVG flash elements. Fills the full canvas area (position:absolute, inset:0).
        * [D03]
        *
        * It also carries the canvas-background marker. Every pane renders as a
        * child of this element, so a pointerdown whose target IS this element
        * struck bare canvas — a deliberate deselect. The gesture interpreter
        * matches on target identity, not containment, so a click that merely
        * misses every pane (a portal gap, an overlay seam, geometry below the
        * fold) does not deselect.
        */}
      <div
        ref={containerRef}
        style={{ position: "absolute", inset: 0 }}
        {...{ [CANVAS_BACKGROUND_ATTRIBUTE]: "" }}
        {...{ [RAIL_TREATMENT_ATTRIBUTE]: RAIL_TREATMENT }}
        {...(bullseyePaneId !== null ? { "data-bullseye": "" } : {})}
      >
      {/* The held-open places: one tile per slot of the arrangement no card
          stands in, at the anchor and the width a card landing there would
          take, with a numbered badge centered in it. First in the container,
          so every pane paints over them. Inert to the pointer — the tile is a
          drawing and a measurement, and a drop lands on it through the
          drop-zone engine, which reads its box rather than its events. */}
      {vacantSlots.map((vacancy) => (
        <div
          key={`vacancy:${vacancy.slot}`}
          className="tug-slot-vacancy"
          data-vacant-slot={vacancy.slot}
          {...{ [RAIL_TRAVEL_ATTR]: vacancy.railTravel }}
          aria-hidden="true"
          style={vacancy.style}
        >
          {/* The badge: the place's own number, in the slot vocabulary the
              strip and the masthead already name places with. The exemplar
              form, so it is a drawing rather than a control — nothing here
              responds to a pointer. */}
          <TugSlot number={vacancy.slot + 1} size="md" />
        </div>
      ))}
      {/* The held-open deck edge: one tile for the side with no rail while
          the other side has one, at the rail's anchor and the width a rail
          card landing there would take. Inert and empty — a measurement the
          drop-zone engine reads, and a hairline while a card is in the air. */}
      {/* A vacancy only the PICTURE has — the one a parked rail would hold
          open — is drawn too, hidden and without `data-vacant-rail`, so the
          drop-zone engine never reads it and the show mounts nothing. One
          array, so a vacancy turning real keeps its element. */}
      {pictureVacantRails
        .filter((v) => !vacantRails.some((real) => real.side === v.side))
        .map((vacancy) => ({ vacancy, parked: true }))
        .concat(vacantRails.map((vacancy) => ({ vacancy, parked: false })))
        .map(({ vacancy, parked }) => (
          <div
            key={`rail-vacancy:${vacancy.side}`}
            className="tug-rail-vacancy"
            {...(parked
              ? { "data-rail-parked": vacancy.side }
              : { "data-vacant-rail": vacancy.side })}
            aria-hidden="true"
            style={vacancy.style}
          />
        ))}
      {/* One wrapper per MOUNTED workspace ([B06], (#canvas-shape)).

          The shown wrapper renders exactly what this canvas has always
          rendered, from the live `deckState`; every other mounted workspace
          renders its parked deck off the spaces snapshot. Both go through the
          same code below so a switch changes props rather than tree shape —
          that is the whole mechanism. A wrapper keyed by workspace id and a
          pane keyed by pane id means React reconciles both sides of a switch
          in place, so no `CardHost` unmounts and none mounts, and a session's
          transcript is at the same scroll offset because nothing was ever
          torn down to be replayed.

          The wrapper is `display: contents` while shown — it has no box at
          all, so the panes lay out against `containerRef` exactly as before,
          with no new stacking context between them and the seams, caps and
          shadows they share the canvas with. Hidden, it is a box the size of
          the canvas, `visibility: hidden` with its contents skipped ([B02]).
          Both rules are in space-layer.css, keyed on `data-space-shown`
          ([L06]); this body writes the attribute and nothing else.

          A hidden workspace's panes take no interaction: no drop zones, no
          close, no reveal, no move menu. They are mounted so their cards stay
          alive, and nothing more. They are HANDED the same handlers as the
          shown layer's, and `LayerPanes` makes each inert at call time while
          its layer is hidden — withholding them changed a prop on every pane
          at every switch. */}
      <RailWidthGestureContext.Provider value={railWidthDraft}>
      {spaceLayers.map((layer) => {
        // Each layer is arranged from its OWN deck ([B02]): the shown one
        // from the live `deckState`, a hidden one from its parked record. A
        // hidden pane therefore stands exactly where it will be shown, and a
        // switch moves nothing — see `LayerArrangement`.
        const arr = layer.shown
          ? shownArrangement
          : arrangementOfParkedDeck(layer.deck, placeRuns);
        return (
          <SpaceLayerWrapper
            key={layer.spaceId}
            spaceId={layer.spaceId}
            shown={layer.shown}
            arrangement={arr}
            columnRun={placeRuns.column}
          >
            {/* The one fact a card in here may need about its own standing:
                whether the workspace it is mounted in is on screen. Read by
                anything that acts on a BROADCAST rather than on the responder
                chain — see the context's own doc. */}
            <SpaceLayerShownContext.Provider value={layerShownSourceFor(layer.spaceId)}>
            {/* The layer's panes and card hosts, behind the memo boundary
                that keeps a parked workspace out of the switch's render. */}
            <LayerPanes
              spaceId={layer.spaceId}
              shown={layer.shown}
              deck={layer.deck}
              arr={arr}
              store={store}
              onRevealPane={handleRevealPane}
              dropZones={dropZoneHost}
            />
            </SpaceLayerShownContext.Provider>
          </SpaceLayerWrapper>
        );
      })}
      </RailWidthGestureContext.Provider>

      {/* One seam per gap of every split rail: the boundary between two
          members, and the handle that moves it. Rendered here rather than by
          either neighbour because a seam belongs to the rail, not to a card —
          and because the two frames it divides must not disagree about where
          it is.

          A sash stands between EVERY pair of members, in both standings. An
          overflowing rail used to offer none, on the reading that a place which
          had stopped dividing had no division to drag — but a strip's members
          still stand against one another, and the drag there is simply
          zero-sum in px rather than in fractions of a run ([B06], [P04]). The
          handle is the same object either way; only the property it writes
          changes. */}
      {pictureRails.flatMap((rail) => {
        const allocation = rail.allocation;
        if (allocation === null || allocation.ids.length < 2) return [];
        // A PARKED rail's seams stay mounted, hidden, for its show.
        const parked = parkedRailSides.has(rail.side);
        const ids = rail.members.map((member) => member.componentId);
        const members = placeMembers(
          deckState,
          "rail",
          ids,
          deckState.imposition.rails?.[rail.side]?.shares,
        );
        return allocation.ids.slice(1).map((_id, index) => (
          <PlaceSeam
            key={`rail:${rail.side}:${index}`}
            place={{ kind: "rail", side: rail.side }}
            index={index}
            frameStyle={
              imposeSidebarStyle(rail.side, rail.width) as React.CSSProperties
            }
            allocation={allocation}
            members={members}
            memberPaneIds={rail.members.map((member) => member.paneId)}
            onCommit={handleSeamCommit}
            parked={parked}
          />
        ));
      })}
      {/* And one per gap of every split COLUMN. Its horizontal pins are the
          slot's own — through `placementFor`, so on a flow deck the seam rides
          the strip with the frames it divides rather than standing at a fit
          anchor nothing is at. */}
      {deckColumns.flatMap((column) => {
        // A sash between every pair, in both standings — the rail's rule above,
        // for the reason a rail and a column are the same kind of place.
        const allocation = column.allocation;
        if (allocation === null || allocation.ids.length < 2) return [];
        const pane = panes.find((p) => p.id === column.members[0]);
        const placement = pane === undefined ? undefined : placementFor(pane);
        if (placement === undefined) return [];
        // The column's width is its widest member's, the same extent the strip
        // reads — a seam narrower than the widest frame would stop short of the
        // edge it divides.
        const width = Math.max(
          ...column.members.map(
            (paneId) =>
              panes.find((p) => p.id === paneId)?.size.width ?? 0,
          ),
        );
        const members = placeMembers(
          deckState,
          "column",
          column.members,
          deckState.imposition.columns?.[column.slot]?.shares,
        );
        return allocation.ids.slice(1).map((_id, index) => (
          <PlaceSeam
            key={`column:${column.slot}:${index}`}
            place={{ kind: "column", slot: column.slot }}
            index={index}
            frameStyle={imposeStyle(placement, width)}
            railTravel={railTravelOf(placement, width)}
            allocation={allocation}
            members={members}
            memberPaneIds={column.members}
            onCommit={handleSeamCommit}
          />
        ));
      })}
      {/* The margin caps: what no rail can cover, and nothing else. A flow
          card's ink stops at the band's edge by occlusion rather than by a
          cut — the rail is opaque and outranks every free card, so a card
          travelling toward one crosses the gutter in plain sight and then
          disappears behind it. The cap is only for the strip a rail leaves
          bare, because a cap wide enough to reach the band would BE the cut:
          painting ground over a card at the band edge is the razor again in
          another material, and the card would never be seen arriving at the
          rail at all. Each paints the deck root's own ground, grid and all, so it
          reads as canvas rather than as a stripe; each takes the press so no
          card the user cannot see receives it; and each carries the
          canvas-background marker so the press it took still deselects, which
          is what a press there does today. See margin-cap.css for the whole
          argument. [B02] [B03] [B04] */}
      {(["left", "right"] as const).map((side) => {
        // A pinned rail keeps the rail edge inset off the window and covers
        // every pixel inboard of it, so what it leaves bare is that inset —
        // nothing at all while a panel stands flush. A side with no rail
        // leaves the band's own gap. The same `railWidthOf` the inset effect
        // reads, so the cap and the band can never disagree about whether a
        // rail stands there.
        const bare =
          railWidthOf(side) > 0 ? RAIL_EDGE_INSET_PX : IMPOSITION_GAP_PX;
        // Nothing bare, no cap. An element of no width is not harmless here:
        // it is a claim in the DOM that something is being covered, and the
        // pin in at0454 reads these by their boxes.
        if (bare === 0) return null;
        return (
          <div
            key={`margin-cap:${side}`}
            className={`tug-margin-cap tug-margin-cap--${side}`}
            data-margin-cap={side}
            aria-hidden="true"
            style={
              {
                width: `${bare}px`,
                // The right cap phases its grid from it (margin-cap.css).
                "--tugx-margin-cap-width": `${bare}px`,
                zIndex: MARGIN_CAP_ZINDEX,
              } as React.CSSProperties
            }
            {...{ [CANVAS_BACKGROUND_ATTRIBUTE]: "" }}
          />
        );
      })}
      {/* The rail shadows: one strip per side, standing in the gutter off the
          rail's inner edge. It is the rail's z-order made visible —
          the panel is above every content card, and a card travelling toward
          it passes under this before it goes behind the panel, so the gutter
          reads as depth rather than as air between two cards.

          Drawn HERE rather than by the pane, and that is the whole point of
          the element. A strip drawn per rail member is only as continuous as
          the member frames are, and it broke at every seam of a split rail —
          against the panel's own law, which says the members touch at one
          hairline so a rail reads as one flush surface from window top to
          foot. One element per side has no seam in it to break at. It spans
          the rail RUN rather than the window, so it stops at the rail's foot
          instead of running on beside the maker strip. See rail-shadow.css
          for the falloff and its reasoning.

          The strip ALWAYS stands, on every side, railed or not. A side whose
          rail is parked keeps it hidden (`data-rail-parked`) and a side with
          no rail keeps it hidden and empty (`data-rail-empty`), so a rail
          that leaves carries its own strip out with it rather than having a
          stand-in planted inside the settle ([D9]). */}
      {(["left", "right"] as const).map((side) => {
        // The same `railWidthOf` the inset effect reads, so the shadow and
        // the band can never disagree about where the rail's inner edge is.
        // No rail on this side, nothing to cast a shadow: the strip stands
        // hidden, parked for a parked rail's show or empty, and its inner
        // edge resolves to the edge inset while the width variable is zero.
        const parked = railWidthOf(side) === 0 && parkedRailSides.has(side);
        const empty = railWidthOf(side) === 0 && !parked;
        const innerEdge =
          `calc(${RAIL_EDGE_INSET} + var(${sidebarWidthProperty(side)}, 0px))`;
        return (
          <div
            key={`rail-shadow:${side}`}
            className={`tug-rail-shadow tug-rail-shadow--${side}`}
            data-rail-shadow={side}
            {...(parked ? { "data-rail-parked": side } : {})}
            {...(empty ? { "data-rail-empty": side } : {})}
            aria-hidden="true"
            style={{
              ...(side === "left" ? { left: innerEdge } : { right: innerEdge }),
              top: RAIL_EDGE_INSET,
              bottom: RAIL_GAP_BOTTOM,
              zIndex: RAIL_SHADOW_ZINDEX,
            }}
          />
        );
      })}
      </div>
      {/*
        * CanvasOverlayRoot: single deck-level container for popup-class
        * overlays (completion menus, popovers, etc.). Mounted as a
        * SIBLING of containerRef — not a descendant — so no pane's
        * `overflow: hidden` clips the overlay. The root is
        * position-fixed; pointer-events: none on the root, opt-in
        * pointer-events: auto on its children. See
        * canvas-overlay-root.tsx for the full contract. [D01, D07, D09]
        */}
      <CanvasOverlayRoot />
      {/* Deck-global Open Quickly popup (File ▸ Open Quickly). Renders
        * nothing until opened; portals into the overlay root above. */}
      <OpenQuicklyOverlay />
      {/* UpdateTug — the app-modal update wizard. Renders nothing until one of
        * its two doors raises it: the host's reveal count, or a pill click. */}
      <UpdateTug />
      {/* The one modeless piece of the update feature: an update exists, top
        * centre of the window, with an x. Shows only while an update is live
        * and the wizard is closed; clicking it opens the wizard. */}
      <UpdatePill />
      {/* The factor a View › Zoom step is going to, raised as the step is
        * applied and let go once it settles. See zoom-readout.tsx. */}
      <ZoomReadout />
      </div>
    </ResponderScope>
  );
}
