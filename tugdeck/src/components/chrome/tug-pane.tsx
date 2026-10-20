/**
 * TugPane — pane chrome and frame: title bar, tabs, content area,
 * drag/resize, z-order, and responder integration.
 *
 * Responsibilities:
 * - Absolutely-positioned `.tug-pane` at position/size from `stackState`
 * - Chrome — title bar, accessory / tab bar, content portal target — drawn
 *   by `PaneChrome` from a model this frame builds, with verbs into the deck
 * - Drag: RAF appearance-zone mutation during, `onCardMoved` commit on end
 * - Resize: 8 handles, clamped to min-size, `onCardMoved` on end
 *
 * Pane activation (bring-to-front on pointer-down) is driven by the
 * document-level capture-phase listener in `pane-focus-controller.ts`
 * — not by any React handler on this frame. The frame's own
 * `data-focused` attribute is also written by that module, not
 * rendered from a prop here.
 *
 * [D03] TugPane chrome, [D06] appearance-zone drag
 *
 * @module components/chrome/tug-pane
 */

import "../tugways/tug-pane.css";
import React, {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { heldResizeObserver, useSyncExternalStore } from "@/lib/gesture-scope";
import { bodyCardsStore } from "@/lib/body-cards-store";
import { bodyFollowFrame, bodyFrameLanded } from "@/lib/body-placement";
import type { CardState, DeckState, TugPaneState } from "@/layout-tree";
import type { SlotStackEntry } from "@/deck-store-selectors";
import type { CardMeta, CardSizePolicy, LayoutRole } from "@/card-registry";
import { DEFAULT_SIZE_POLICY, cardKindName, getRegistration } from "@/card-registry";
import { computeSnap, computeResizeSnap } from "@/snap";
import type { Rect, SnapResult } from "@/snap";
import {
  FLOW_STEP_TWEEN_MS,
  autoscrollDelta,
  autoscrollKey,
  flowStepArmed,
  flowStepDecision,
  flowStepTarget,
  pickLiveZone,
  type AutoscrollTarget,
  type DropZone,
  type DropZoneHost,
  type FlowStepState,
} from "@/lib/drop-zones";

/** One strip a drag has scrolled, and where it left it. */
interface AutoscrollRun {
  target: AutoscrollTarget;
  offset: number;
}

/** A click in flight: the flow offset travelling from `from` to `to` over
 *  `FLOW_STEP_TWEEN_MS`, one write per frame on the gesture's own rAF. */
interface FlowStepTween {
  from: number;
  to: number;
  startedAt: number;
}
import { flashCardPane } from "@/lib/flash-pane-border";
import { layoutPxOf, pageZoomFactor } from "@/lib/page-zoom-store";
import { animate } from "@/components/tugways/tug-animator";
import { useResponder } from "@/components/tugways/use-responder";
import type { ActionEvent } from "@/components/tugways/responder-chain";
import { TUG_ACTIONS } from "@/components/tugways/action-vocabulary";
import {
  PaneChrome,
  TugPaneFrameContext,
  type PaneChromeModel,
  type PaneChromeVerbs,
} from "./pane-chrome";
import { CARD_TITLE_BAR_HEIGHT, type CardTitleBarHandle } from "./card-title-bar";
import { plainEqual } from "@/lib/plain-equal";
import { CHROME_IN_BODY_ATTRIBUTE, chromeInBody } from "@/lib/chrome-placement";
import { useDeckManager } from "@/deck-manager-context";
import type { MovePaneOptions } from "@/deck-manager-store";
import {
  fitEdgeRate,
  fitImposedLeft,
  fitWidthForEdge,
  flowResizeShift,
  slotHeightAfterDrag,
} from "@/lib/keep-slot-resize";
import { startColumnSeamDrag } from "./column-seam-drag";
import {
  imposeStyle,
  travelFraction,
  FLOW_STRIP_PROPERTY,
  type ColumnMemberPlacement,
  imposeSidebarStyle,
  type PinnedFrame,
  type ColumnMode,
  type PlaceStanding,
  type SidebarSide,
  IMPOSITION_GAP_PX,
  readSettleMs,
  type ImposedPlacement,
  DEFAULT_CONTENT_WIDTH,
  resolveContentWidthPx,
  type ContentWidth,
} from "@/lib/layout-imposer";
import { adoptColumnProperties } from "./place-properties";
import { motionKeyframes, velocityAlongTravel } from "@/lib/imposer-motion";
import { DRAG_MOVE_THRESHOLD_PX } from "@/lib/press-travel";
import { cardTitleStore } from "@/lib/card-title-store";
import {
  GESTURE_EPISODE_WINDOW_MS,
  beginResizeEpisode,
} from "@/lib/resize-episode";
import { composePaneTitleBarText } from "@/lib/pane-title";
import {
  arrangePlace,
  closeTab,
  fillPaneHeight,
  selectTab,
  setPaneWidth,
  togglePaneBullseye,
} from "@/lib/pane-verbs";
import {
  commitFreeMove,
  commitResizeEnd,
  commitZoneDrop,
  dragOutcomeOf,
  freeDropOutcomeOf,
} from "@/lib/card-gesture-commit";
import {
  keepSlotGripsOf,
  paneCardFoldOf,
  paneClosableOf,
  paneConfirmsCloseOf,
  railGripsOf,
  type ResizeEdge,
} from "@/lib/pane-chrome-projection";
import {
  cardModalHoldStore,
  isCardHeld,
} from "@/lib/card-modal-hold-store";
import {
  getCardCloseGuard,
  type CardCloseDecision,
} from "@/lib/card-close-guard";
import { closeGuardWalk } from "@/lib/close-guard-walk";
import {
  cardWaivesCloseConfirm,
  readCardCloseAdvice,
  type CardCloseAdvice,
} from "@/lib/card-close-advice";
import * as paneContentRegistry from "@/components/chrome/pane-content-registry";
import * as paneFrameRegistry from "@/components/chrome/pane-frame-registry";
import * as paneRootRegistry from "@/components/chrome/pane-root-registry";
import {
  captureFocusForDragStart,
  mayDeferCommit,
  transferFocusForActivation,
} from "@/focus-transfer";
import { paneOcclusionGesture } from "@/components/chrome/pane-occlusion-controller";
import { panePlaceFactsOf, placeFactsFor, placeSource } from "./pane-place-facts";
import { useCardFoldFocus } from "@/components/chrome/card-fold-glyph";
import {
  paneCanvasOf,
} from "@/components/chrome/space-layer";
import {
  clearGuideElements,
  measureGuideEdgeOffsets,
  snapshotCardRects,
  syncGuideElements,
} from "@/components/chrome/snap-guides";
import { useRailWidthGesture } from "@/components/chrome/rail-width-draft";
import { holdShellKeyboard } from "@/lib/shell-keyboard-hold";
import { registerRailEdgeDriver } from "@/lib/rail-edge-registry";
import { takeFrameFromSettle } from "@/lib/settle-take";
import {
  RAIL_REFLOW_ATTR,
  RAIL_TRAVEL_ATTR,
  railTravelOf,
} from "@/lib/rail-width";

// ===========================================================================
// The chrome's names, where their importers have always read them
// ===========================================================================

export {
  CARD_TITLE_BAR_HEIGHT,
  MASTHEAD_HEIGHT,
  SESSION_MASTHEAD_HEIGHT,
} from "./card-title-bar";
export { TugPaneFrameContext, TugPanePortalContext } from "./pane-chrome";

// ===========================================================================
// Dirty context (card content consumes it)
// ===========================================================================

export const CardDirtyContext = createContext<(() => void) | null>(null);

/**
 * Returns a stable `markDirty` callback from `CardDirtyContext`, or a no-op
 * outside a provider. Card content uses this to participate in the pane's
 * debounced auto-save path alongside scroll/selection listeners.
 */
export function useCardDirty(): () => void {
  const markDirty = useContext(CardDirtyContext);
  return markDirty ?? noop;
}

function noop(): void {}

// ---------------------------------------------------------------------------
// Canvas padding for resize clamping
//
// Resize handles are hard-clamped to the canvas edges with this padding.
// Dragging uses the relaxed Finder-style rules below instead.
// ---------------------------------------------------------------------------

const CANVAS_PADDING = 2;

// ---------------------------------------------------------------------------
// Finder-style title bar visibility constraints (drag only)
//
// When dragging, cards may overhang canvas edges, but enough of the title bar
// must remain visible and grabbable. Modeled after macOS Finder window
// constraining.
// ---------------------------------------------------------------------------

/** Minimum horizontal px of title bar visible when card overhangs left/right. */
const TITLE_BAR_VISIBLE_MIN_X = 100;

/** Minimum vertical px of title bar visible when card overhangs bottom. */
const TITLE_BAR_VISIBLE_MIN_Y = CARD_TITLE_BAR_HEIGHT;

/**
 * How stale the last pointer sample may be and still count as the hand's
 * motion at the release, in milliseconds.
 *
 * A drop inherits the hand's velocity ([P05] of
 * `arc/layout-imposer-polish.md`), and the question that answers is "how
 * fast was the hand going as it opened" — not "how fast was it going at some
 * point during the drag". Four display frames is long enough to survive a
 * dropped frame and short enough that a hand which paused before letting go
 * reads, correctly, as stopped.
 */
const RELEASE_VELOCITY_WINDOW_MS = 68;

/**
 * Freeze an imposed frame into free pixel geometry at the rect it currently
 * shows, and hand back that rect in canvas coordinates.
 *
 * An imposed frame is positioned by CSS pins (`left`/`right` against the rail
 * inset, `top`/`bottom` against the canvas), which the drag and resize
 * machines' per-frame writes would fight. Both gestures release the pane from
 * its slot at the moment they become a move — not at pointer-down — by
 * converting it here: the DOM keeps showing exactly what the user was looking
 * at, and the commit that follows carries `evictSlot`, so React re-renders in
 * free mode consistent with the DOM.
 *
 * Seeding the gesture from this measurement rather than from `position` matters
 * — an imposed pane's stored position holds stale last-known values, so a
 * gesture seeded from state would teleport the frame on its first move.
 */
function releaseImposedFrame(
  frame: HTMLElement,
  canvas: DOMRect | null,
): { x: number; y: number; width: number; height: number } {
  const zoom = pageZoomFactor();
  const rect = frame.getBoundingClientRect();
  const released = {
    x: (rect.left - (canvas ? canvas.left : 0)) / zoom,
    y: (rect.top - (canvas ? canvas.top : 0)) / zoom,
    width: rect.width / zoom,
    height: rect.height / zoom,
  };
  frame.style.right = "";
  frame.style.bottom = "";
  frame.style.left = `${released.x}px`;
  frame.style.top = `${released.y}px`;
  frame.style.width = `${released.width}px`;
  frame.style.height = `${released.height}px`;
  return released;
}

/**
 * What a slot-keeping width resize needs to know at pointer-down.
 *
 * In fit: the slot's travel fraction, the width the frame stands at, and the
 * imposer's own `left` expression at a given width — which the gesture writes
 * at pointer-up, so the frame is handed back to the slot already wearing the
 * pin React is about to render.
 *
 * In flow: only the width. The card's left edge is the running sum of the
 * slots before it, so it has nowhere to go; the right edge follows the hand
 * and the slots after it travel with it, read from the deck's strip.
 *
 * In either, a member of a split column carries its place in the column: its
 * height is its share of the run, so an inner top or bottom edge is the seam
 * it borders, and the drag is the seam's own (`column-seam-drag.ts`).
 *
 * And in either, a card alone or stacked in its slot carries its height
 * style: the bottom edge sets the height the card stands at from the top of
 * its run, and `heightStyle` is the frame's vertical pins at a given height —
 * `undefined` filling the run — so the gesture hands the frame back already
 * wearing what React will render.
 */
type KeepSlotResize =
  | {
      layout: "fit";
      fraction: number;
      width: number;
      imposedLeft: (width: number) => string;
      column?: KeepSlotColumn;
      heightStyle?: KeepSlotHeightStyle;
    }
  | {
      layout: "flow";
      width: number;
      column?: KeepSlotColumn;
      heightStyle?: KeepSlotHeightStyle;
    };

/** A slotted frame's vertical pins at `height`, or filling its run. */
type KeepSlotHeightStyle = (
  height: number | undefined,
) => Pick<CSSProperties, "top" | "bottom" | "height" | "maxHeight">;

/** A split column member's address: its slot, and where it stands among the
 *  column's `count` members. Seam `index - 1` is above it, seam `index` below. */
interface KeepSlotColumn {
  slot: number;
  index: number;
  count: number;
}

/** Height of the title bar chrome inside `.tug-pane-body` (below the outer frame). */
const HEADER_HEIGHT_PX = 28;
const DEFAULT_MIN_CONTENT: { width: number; height: number } = { width: 100, height: 60 };

// Frozen empties for the chrome model, so a pane with no tab set or no grip
// hands `PaneChrome` the same identity every render.
const NO_TABS: readonly CardState[] = [];
const NO_GRIPS: readonly ResizeEdge[] = [];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Where a pane stands on the rail it shares — the side, the rail's arrangement,
 * and this pane's place in it. Resolved by `DeckCanvas`, which is the only
 * party that can see a rail's other members.
 *
 * In a **stack** every member takes the same geometry — one gap below the
 * canvas top, the deeper gap above its bottom — and z-order decides which you
 * see; `memberIndex` then means only where the member sits in the picker's
 * list. In a **split** the index IS geometry: it names the member's share of
 * the run, and the frame pins itself to the seams either side of it.
 */
export interface SidebarStackStanding {
  /** The deck edge the rail holds. */
  side: SidebarSide;
  /** Which sidebar card this pane is, as the arrangement record names it —
   *  the key an order or a height weight is stored under. */
  componentId: string;
  /** How many cards stand on the rail — what tells the title bar it is in a
   *  stack worth offering a picker for. */
  count: number;
  /** This pane's place in the rail's vertical order, top to bottom. */
  memberIndex: number;
  /**
   * How the rail's members stand against one another — the allocation's own
   * answer, resolved by the canvas because it is a fact about the run the
   * whole rail was allocated against rather than about this pane. A rail of
   * one reads `"shared"`: it divides nothing.
   */
  standing: PlaceStanding;
  /**
   * The overflowing rail's strip coordinates, `n + 1` of them, resolved by the
   * canvas from the same allocation the `standing` came from — the `var()`
   * fallbacks this member's frame stands at before the properties land. Absent
   * while the rail shares its run.
   */
  strip?: readonly number[];
}

/**
 * Props for the TugPane component (frame + pane chrome).
 */
export interface TugPaneProps {
  /** Window position, size, id, and width preset from DeckState. */
  stackState: TugPaneState;
  /** Default metadata for the window (from card registration). */
  meta: CardMeta;
  /**
   * The active card's registered layout role. Companion to {@link meta}: a
   * single-card pane has no `cards` array to resolve a registration from, so
   * the caller — which already holds that registration — hands the role down.
   * A stacked pane resolves it from its own active card instead. `"sidebar"`
   * is what puts the pane in the rail chrome tier.
   */
  layoutRole?: LayoutRole;
  /**
   * The active card's registry id, handed down for the same reason as
   * {@link layoutRole}: a single-card pane has no `cards` array to read it
   * from. The fold's title-bar door reads it ([B06]).
   */
  activeComponentId?: string;
  /**
   * Minimum content area size (below title bar + accessory).
   * Total min-size = header + accessory + this region.
   */
  minContentSize?: { width: number; height: number };
  /** Top accessory when single-tab; ignored when multi-tab tab bar is shown. */
  accessory?: React.ReactNode | null;
  /** All cards in this window; when length > 1, the tab bar is shown. */
  cards?: readonly CardState[];
  /**
   * Active card id for merge hit-testing and tab chrome.
   * Defaults to `stackState.activeCardId` when omitted.
   */
  activeCardId?: string;
  /** Title prefix when multi-tab: `"${cardTitle}: ${title}"`. */
  cardTitle?: string;
  /** Families for the [+] type picker (multi-tab). */
  acceptedFamilies?: readonly string[];
  /** Close the window or last card (from title bar). */
  onClose?: () => void;
  /** Called on drag-end or resize-end (structure-zone commit). */
  onCardMoved: (
    id: string,
    position: { x: number; y: number },
    size: { width: number; height: number },
    opts?: MovePaneOptions,
  ) => void;
  /**
   * This pane's place in the imposition chain, when it holds a slot. Resolved
   * by `DeckCanvas`, which is the only vantage point that can see every
   * slotted pane's width at once — a pane cannot work out its own offset down
   * the chain from its own state. Absent for a free pane and for a rail pane.
   */
  placement?: ImposedPlacement;
  /**
   * True while this pane stands in bullseye — centered in the band at the
   * comfy width, over the full vertical run, with every other pane receded.
   *
   * A presentation over whichever geometry mode the pane already holds, not a
   * fourth mode: it takes precedence over both derived modes while it lasts,
   * and the pane's stored `position` / `size` / `slot` / `widthPreset` are
   * untouched throughout, so leaving bullseye restores nothing — nothing was
   * disturbed. Resolved by `DeckCanvas`, which owns the deck state the
   * posture lives in.
   */
  bullseye?: boolean;
  /**
   * Set while ANOTHER pane stands in bullseye and this one is a content pane
   * — so this pane gets out of the way. The value is the bullseyed pane's
   * PRE-bullseye centre as a CSS length expression: this pane leaves by the
   * left edge if it sits left of that line and by the right edge if it sits
   * right of it.
   *
   * Sorting around the bullseyed card rather than around the canvas centre is
   * what makes crossings impossible: each pane leaves by the side it was
   * already on, so nothing slides through the card arriving at the centre.
   *
   * Set on content panes only. Rails keep their pins and recede in place: a
   * rail that left the deck would take the band's insets with it, moving the
   * bullseyed card the moment the posture began.
   *
   * Like {@link bullseye} itself this writes nothing — the stored
   * `position` / `size` are untouched and the pane slides straight back on
   * exit. Resolved by `DeckCanvas`, which owns the deck state.
   */
  bullseyeExit?: string;
  /**
   * The deck's content-width preset in pixels — the width an ordinary card
   * opens at in this arrangement. Deck state, so `DeckCanvas` resolves it.
   *
   * Only a size-locked pane reads it, and only to size its SLOT: About is 320
   * wide by registration, but the slot it stands in is the one every other
   * card in the arrangement gets, and About is centred inside that. A pane
   * that takes its own width for its slot ignores this entirely.
   */
  contentWidthPx?: number;
  /**
   * Whether an edge resize of this pane, if it is imposed, keeps its slot —
   * the deck's resize rule, resolved by `DeckCanvas` from the imposition.
   * Absent reads as false, which is the old behaviour: a resize releases.
   */
  resizeKeepsSlot?: boolean;
  /**
   * Raise the pane a stack-picker row names. Wired in `DeckCanvas`, which is
   * where the store lives; the pane and its title bar only report the choice.
   */
  onRevealPane?: (entry: SlotStackEntry) => void;
  /**
   * File this pane's active card into another workspace. Wired in
   * `DeckCanvas` to `moveCardToSpace`; the pane and its title bar only report
   * the choice, the same shape {@link onRevealPane} above takes. The
   * workspace list the menu offers is the title bar's own read off the store
   * — see {@link CardTitleBarProps.onMoveToSpace}.
   */
  onMoveToSpace?: (spaceId: string) => void;
  /**
   * Set only on a pane standing in a rail: where that rail stands and where
   * this pane stands on it. A rail is imposed as the strip's fixed end rather
   * than a link in its chain, so its panes take a pin instead of a `placement`:
   * resizable only on the deck-facing edge, and excluded from snap and merge.
   * Resolved by `DeckCanvas` — the pane carries no marker of its own ([P04]).
   */
  sidebarStack?: SidebarStackStanding;
  /**
   * Set only on a PARKED rail member — a sidebar card whose rail was hidden
   * whole — to the side it is parked on. The frame stays mounted at its
   * pinned box, with `data-rail-parked` (the stylesheet hides it and skips
   * its contents' layout) and `inert`, and stands in no rail: it takes no
   * `sidebarStack`, so nothing reads it as a member. A show clears it and the
   * same frame stands again, with nothing to mount.
   */
  railParked?: SidebarSide;
  /**
   * Set only on a DEPARTING pane — closed, but kept mounted for the one
   * settle that carries it out. The frame wears `data-departing` and `inert`:
   * out of every shown-frame query, out of the keyboard and (by the
   * stylesheet) out of hit-testing, while the settle fades it where it stood.
   * The settle's land is the commit that unmounts it.
   */
  departing?: boolean;
  /**
   * Set only on a pane standing in a SPLIT slot: which slot, which position in
   * its column, and how many members divide the run.
   *
   * The content-side twin of the `sidebarStack` member fields, and resolved by
   * `DeckCanvas` for the same reason — a pane cannot see its slot's other
   * occupants, and a member's index is a fact about the column rather than
   * about the pane. Absent on a stacked slot, on a column of one, on a free
   * pane, and on a rail, all of which take the undivided run.
   */
  columnMember?: ColumnMemberPlacement;
  /**
   * The arrangement the pane's slot is SET to, for a pane standing in one.
   *
   * Not derivable from {@link columnMember}, and that is the whole point:
   * `columnMember` is geometry and is absent from a column of one, while a
   * slot split while it holds a single card is split from the moment the verb
   * commits. The badge names the arrangement, so it reads this; the frame
   * reads `columnMember`, which still says the lone member takes the whole
   * run. Absent on a free pane and on a rail, neither of which stands in a
   * column at all.
   */
  columnMode?: ColumnMode;
  /**
   * The pane is ARRIVING: appended to its column but not yet part of its
   * division, drawn hidden at the seat it will take so its content can lay
   * out and report its height while nothing the user sees moves ([B01],
   * [B08]). Resolved by `DeckCanvas` from `DeckState.arriving`, like every
   * other structural fact the frame stamps, and absent on every pane that is
   * standing.
   *
   * The value is the SEAT. `"bottom"` is a newcomer to a split column with
   * standing members: it draws at the run's bottom at its stack-policy floor,
   * overlapping the neighbour that will shrink to make room when it is
   * revealed. `"run"` is a newcomer with nothing to overlap — a stacked
   * column, or a slot it has to itself — which takes the undivided run
   * exactly as it will once revealed.
   *
   * Projected onto the frame as `data-arriving` and `visibility: hidden`
   * ([B02]): the frame lays out, its sheet measures, and nothing can focus
   * or click it. The settle skips a marked frame the way it skips a pending
   * arrival, so the commit that appends the pane moves nothing, and the
   * commit that clears the mark is the one its arrive beat plays on.
   */
  arriving?: ArrivingSeat;
  /**
   * Set on a pane hosting a sidebar card, pinned or not. Separate from
   * {@link sidebarStack}, which says only where a PINNED rail stands: a rail
   * dragged off its pin is an ordinary free pane for geometry purposes but is
   * still a rail, and the one thing that stays true either way is that it
   * hosts a singleton card and never accepts a merge.
   */
  isSidebarPane?: boolean;
  /**
   * Called when a card drag ends over another card's tab bar ([D45]).
   *
   * Receives the source card id, the target card id, and the insertion index
   * within the target's tab array. The active tab of the source card is merged
   * into the target card at insertIndex.
   *
   * Wired in DeckCanvas to `moveCardToPane`. When this prop is not provided,
   * card drag always falls back to onCardMoved (no merge behaviour).
   */
  onCardMerged?: (sourceCardId: string, targetCardId: string, insertIndex: number) => void;
  /**
   * The canvas's half of the drop-zone drag ([P09]): what places this pane may
   * land in, how the live one is shown, and how a release commits.
   *
   * Absent for a pane on a canvas with no arrangement to land in, in which case
   * the gesture is the ordinary free drag it has always been.
   */
  dropZones?: DropZoneHost;
  /** CSS z-index for stacking order. */
  zIndex: number;
  /**
   * Size policy for this card type. Enforces min as a floor (content-reported
   * min cannot go below this) and max as a ceiling during resize.
   * Falls back to DEFAULT_SIZE_POLICY when omitted.
   */
  sizePolicy?: CardSizePolicy;
  /**
   * The pane wears its folded form ([P01], [P03]) — masthead, the Z2
   * status row and the fold control at its trailing edge, with the
   * transcript and the composer folded away.
   *
   * Projected onto the frame as `data-folded`, which is the whole of how
   * the form is worn: every visual difference is a CSS rule under
   * `.tug-pane[data-folded="true"]` ([L06]), and the card reads the same
   * flag off the deck store for the handful of things CSS cannot do.
   *
   * Resolved by `DeckCanvas` from the pane's own state, like every other
   * structural fact the frame stamps.
   */
  folded?: boolean;
}

/** Where an arriving pane draws while it is hidden — see
 *  {@link TugPaneProps.arriving}. */
export type ArrivingSeat = "bottom" | "run";

/**
 * A resolved `left` value as a term usable inside a CSS math expression.
 *
 * React writes a bare number as `px`; the imposer writes a `calc()` string.
 * Nesting a `calc()` inside another calculation is legal — it reads as
 * parenthesised — so both forms compose into the bullseye-exit clamp without
 * the caller having to know which mode produced the pin. Anything else (an
 * absent or non-length value, which no geometry mode emits) falls back to
 * `0px` rather than producing an invalid expression that would drop the whole
 * declaration.
 */
function cssLength(value: CSSProperties["left"]): string {
  if (typeof value === "number") return `${value}px`;
  if (typeof value === "string" && value.length > 0) return value;
  return "0px";
}

/**
 * Write a slotted frame's vertical pins inline, exactly as React would render
 * them: an absent pin is cleared rather than left standing, so a frame handed
 * back at the pins React already holds is a frame React need not touch.
 */
function writeHeightPins(
  frame: HTMLElement,
  pins: Pick<CSSProperties, "top" | "bottom" | "height" | "maxHeight">,
): void {
  const length = (value: CSSProperties["top"]): string =>
    value === undefined || value === "" ? "" : cssLength(value);
  frame.style.top = length(pins.top);
  frame.style.bottom = length(pins.bottom);
  frame.style.height = length(pins.height);
  frame.style.maxHeight = length(pins.maxHeight);
}

// ---------------------------------------------------------------------------
// TugPane
// ---------------------------------------------------------------------------

/** `memo`'s comparator for {@link TugPane}: every prop by {@link plainEqual}. */
export function tugPanePropsEqual(
  prev: TugPaneProps,
  next: TugPaneProps,
): boolean {
  const keys = new Set<string>([...Object.keys(prev), ...Object.keys(next)]);
  const a = prev as unknown as Record<string, unknown>;
  const b = next as unknown as Record<string, unknown>;
  for (const key of keys) {
    if (!plainEqual(a[key], b[key])) return false;
  }
  return true;
}

/**
 * The pane frame, memoized on its props by value ({@link tugPanePropsEqual}).
 * A deck commit that did not touch this pane costs it no render.
 */
export const TugPane = memo(TugPaneImpl, tugPanePropsEqual);

/**
 * TugPane — positions, drags, resizes, and hosts a window's cards on the canvas.
 */
function TugPaneImpl({
  stackState,
  meta,
  layoutRole,
  activeComponentId,
  minContentSize: minContentSizeProp,
  accessory = null,
  cards,
  activeCardId: activeCardIdFromProps,
  cardTitle,
  acceptedFamilies,
  onClose,
  onCardMoved,
  sizePolicy: sizePolicyProp,
  onCardMerged,
  dropZones,
  zIndex,
  placement,
  contentWidthPx,
  resizeKeepsSlot = false,
  onRevealPane,
  onMoveToSpace,
  sidebarStack,
  railParked,
  departing = false,
  isSidebarPane = false,
  bullseye = false,
  bullseyeExit,
  columnMember,
  columnMode,
  arriving,
  folded = false,
}: TugPaneProps) {
  const sidebarSide = sidebarStack?.side;
  // The seat a PARKED rail member last stood at. Parked, the frame is in no
  // rail and takes no `sidebarStack`, but its title bar is hidden with it and
  // has nothing to redraw: handing the bar the seat it stood at keeps its
  // props — the badge's arrangement, the absent width control — exactly what
  // they were, so the show that stands it again renders no bar and mounts no
  // control. A member restored parked, never seen standing, has no seat to
  // keep and is drawn from its pin alone.
  const lastSeatRef = useRef<SidebarStackStanding | undefined>(sidebarStack);
  if (sidebarStack !== undefined) lastSeatRef.current = sidebarStack;
  const barSeat =
    sidebarStack ?? (railParked !== undefined ? lastSeatRef.current : undefined);
  const barSide = barSeat?.side ?? railParked;
  // A split rail's member takes its share of the run instead of the whole of
  // it. Passed to the imposer rather than resolved here — the pins are its
  // arithmetic, and a rail of one is stacked geometry whatever the mode says,
  // so a side split while only one card stands on it looks exactly as it did.
  const railSplit =
    sidebarStack !== undefined &&
    sidebarStack.count > 1;
  const railMember =
    railSplit && sidebarStack !== undefined
      ? {
          member: {
            side: sidebarStack.side,
            index: sidebarStack.memberIndex,
            count: sidebarStack.count,
            standing: sidebarStack.standing,
            ...(sidebarStack.strip === undefined
              ? {}
              : { strip: sidebarStack.strip }),
          },
        }
      : undefined;
  const { id, position, size } = stackState;
  // Two derived geometry modes, both placed by `lib/layout-imposer.ts`.
  //
  // Pinned — a rail card, while it is standing at its side. It holds that side
  // at a fixed pin and keeps its own width, so it exposes only its deck-facing
  // resize edge and is excluded from merge. It is DRAGGABLE, and dragging it
  // is exactly how it stops being pinned: the commit releases it, `sidebarSide`
  // arrives undefined on the next render, and it becomes a free pane in the
  // deck like any other.
  //
  // Imposed — a slotted pane. It derives its position from its slot's anchor
  // and its height from the canvas, instead of from `position`. Its width is
  // still its own; the imposer never touches it.
  //
  // The two are mutually exclusive, which the deck-state invariant already
  // guarantees (a rail pane never carries a slot); the check here keeps the
  // render honest against a hand-built state. A free pane is neither and uses
  // its stored `position`/`size`. Every mode still owns its geometry [L09].
  const pinned = sidebarSide !== undefined;
  const imposed = !pinned && placement !== undefined;
  // All three place the frame by CSS pins rather than by stored pixels, so all
  // three need the same two things at gesture time: a freeze of the live rect
  // before the first move, and an `evictSlot` on the commit that follows. A
  // bullseyed pane's stored rect is stale for exactly the reason the other
  // two's are — the frame is somewhere the store never said — so a drag on one
  // without this would jump it to that stale position at the threshold
  // crossing. Read from a ref so the drag and resize machines' `useCallback`
  // identities do not churn with the arrangement.
  const derivedRef = useRef(pinned || imposed || bullseye);
  derivedRef.current = pinned || imposed || bullseye;
  // The facts a slot-keeping width resize reads at pointer-down — refreshed
  // every render beside the imposed style they mirror, and null whenever an
  // edge resize of this pane releases it instead.
  const keepSlotResizeRef = useRef<KeepSlotResize | null>(null);
  const activeCardId = activeCardIdFromProps ?? stackState.activeCardId;

  // Ref to the frame DOM element for appearance-zone style mutations.
  const frameRef = useRef<HTMLDivElement>(null);

  // Resolved size policy: use prop or fall back to DEFAULT_SIZE_POLICY.
  const sizePolicy = sizePolicyProp ?? DEFAULT_SIZE_POLICY;

  // Min-size reported by chrome + accessory measurement, floored to sizePolicy.min.
  const [minSize, setMinSize] = useState<{ width: number; height: number }>({
    width: sizePolicy.min.width,
    height: sizePolicy.min.height,
  });

  // Latest minSize held in a ref so resize closure always sees current value
  // without needing to be re-created every time minSize state updates.
  const minSizeRef = useRef(minSize);
  minSizeRef.current = minSize;

  // Max-size from policy (undefined = unbounded). Held in a ref so the resize
  // closure always reads the current value without re-creation.
  const maxSizeRef = useRef(sizePolicy.max);
  maxSizeRef.current = sizePolicy.max;

  const stackId = id;
  const minContentSize = minContentSizeProp ?? DEFAULT_MIN_CONTENT;
  const store = useDeckManager();

  // `data-stack-depth`: how many panes share this pane's place. Written from
  // the deck rather than rendered from a prop, because the depth moves on
  // every member when one member comes or goes, and a prop for it re-rendered
  // each survivor's frame for a number no layout reads ([L06]). Read from the
  // deck that holds the pane, so a hidden workspace's frames keep theirs.
  useLayoutEffect(() => {
    const source = placeSource(store);
    const write = (): void => {
      const el = frameRef.current;
      if (el === null) return;
      el.dataset.stackDepth = String(placeFactsFor(source.getSnapshot(), stackId).slotStack.length);
    };
    write();
    return source.subscribe(write);
  }, [store, stackId]);

  const [cardEl, setCardEl] = useState<HTMLDivElement | null>(null);
  // Frame element exposed via TugPaneFrameContext and bridged through
  // `pane-frame-registry` for consumers (card content) that live
  // outside the pane's React tree. The same DOM node is also tracked
  // through frameRef.current for direct DOM access in drag/resize
  // handlers; the callback ref keeps both in sync. State (not just
  // the ref) is required so React-tree consumers re-render when the
  // frame mounts. [D19]
  const [frameEl, setFrameEl] = useState<HTMLDivElement | null>(null);
  const frameRefCallback = useCallback((el: HTMLDivElement | null) => {
    frameRef.current = el;
    setFrameEl(el);
  }, []);
  // The slot this frame reads its column's seams, offset and strip from. They
  // stand on the frame itself rather than on an ancestor
  // (`place-properties.ts`), so a frame that comes to stand in a slot adopts
  // the slot's standing values before paint — its `var()` fallback is the
  // equal division, not the one the hand set.
  const imposedSlot =
    imposed && placement !== undefined && !bullseye ? placement.slot : null;
  useLayoutEffect(() => {
    const el = frameRef.current;
    if (el === null || imposedSlot === null) return;
    adoptColumnProperties(el, imposedSlot);
  }, [imposedSlot]);
  // The content element the card's host portals into. State, not a ref: the
  // pane renders it in its chrome or in its stand-in, a different element
  // each, and the registry must follow the one that is mounted.
  const [contentEl, contentRef] = useState<HTMLDivElement | null>(null);

  const cardsRef = useRef(cards);
  cardsRef.current = cards;
  const activeCardIdRef = useRef(activeCardId);
  activeCardIdRef.current = activeCardId;

  const performSelectCard = useCallback(
    (newCardId: string) => {
      // Route the intra-pane tab switch through `transferFocusForActivation`
      // Tab row: this is row 1 of the
      // activation trigger taxonomy: tab click within a pane.
      //
      // The helper's five-step body subsumes the previous explicit
      // save + setActiveCardInPane pair: step 1 saves the outgoing
      // bag (skipped for null / same-card / outgoingWillBeDestroyed),
      // step 2 invokes `commitMutation` inside `flushSync` so the
      // incoming card's `display: none` flips to `display: contents`
      // before resolution, steps 3–5 resolve / gate / focus.
      //
      // The `flushSync` sandwich is load-bearing here: tab clicks
      // dispatch through React's synthetic event system, so without
      // it `setActiveCardInPane`'s `notify()` would be batched and
      // step 5's `.focus()` would land on a still-`display:none`
      // element (silent failure). See [AT0001] closure
      // gate.
      selectTab(store, stackId, newCardId);
    },
    [store, stackId],
  );

  useLayoutEffect(() => {
    if (contentEl === null) return;
    paneContentRegistry.register(stackId, contentEl);
    return () => {
      paneContentRegistry.unregister(stackId);
    };
  }, [stackId, contentEl]);

  useLayoutEffect(() => {
    if (!cardEl) return;
    paneRootRegistry.register(stackId, cardEl);
    return () => {
      paneRootRegistry.unregister(stackId);
    };
  }, [stackId, cardEl]);

  // Bridge the frame element through `pane-frame-registry` so card
  // content rendered via `CardPortal` (which lives outside the pane's
  // React tree) can subscribe and re-provide `TugPaneFrameContext` at
  // the card-host position. Without this bridge, pane-modal surfaces
  // inside card content would fall back to `document.body` and lose
  // per-pane stacking. [D19, D20]
  useLayoutEffect(() => {
    if (!frameEl) return;
    paneFrameRegistry.register(stackId, frameEl);
    return () => {
      paneFrameRegistry.unregister(stackId);
    };
  }, [stackId, frameEl]);

  // Imperative handle on the title bar so the chain-action close path
  // can route through the same confirm popover the X button opens.
  // Wired below into the `TUG_ACTIONS.CLOSE` responder.
  const titleBarRef = useRef<CardTitleBarHandle>(null);

  // Chain-action close (Cmd-W via TUG_ACTIONS.CLOSE). Browser-standard
  // "close the active tab" semantics: multi-tab → remove the active
  // card with no confirm (one of N tabs is recoverable). Single-tab →
  // delegate to the title bar's `requestClose()`, which honours the
  // pane's `confirmClose` policy: opens the popover when the active
  // card opts in, closes immediately otherwise. This keeps Cmd-W and
  // the X button symmetric: a pane that confirms on click also
  // confirms on key, and a pane that doesn't never traps Cmd-W behind
  // a guard.
  const handleChromeClose = useCallback(() => {
    const currentCards = cardsRef.current;
    const currentActiveId = activeCardIdRef.current;
    if (currentCards && currentCards.length > 1 && currentActiveId) {
      // Multi-tab: Cmd-W removes only the active card. Honour that
      // card's own `confirmClose` policy — pop a single-card confirm
      // before discarding an opt-in card (e.g. the Session card), remove
      // immediately otherwise. (The whole-pane "Close N Tabs?" guard
      // belongs to the X button and the close-all command, not to the
      // single-tab close Cmd-W performs here.)
      const activeCard = currentCards.find((c) => c.id === currentActiveId);
      const reg = activeCard ? getRegistration(activeCard.componentId) : undefined;
      const needsConfirm =
        reg?.defaultMeta.confirmClose === true &&
        !cardWaivesCloseConfirm(currentActiveId);
      titleBarRef.current?.requestCloseWith({
        needsConfirm,
        message: `Close ${cardKindName(reg?.defaultMeta)}?`,
        confirmLabel: "Close",
        onConfirm: () => store.removeCard(stackId, currentActiveId),
      });
    } else {
      titleBarRef.current?.requestClose();
    }
  }, [store, stackId]);

  // Title-bar X close. Always closes the entire pane. CardTitleBar
  // is responsible for surfacing the confirm popover before calling
  // this — by the time we get here the user has already confirmed,
  // or Option-clicked the X to skip the confirmation outright.
  const handleTitleBarClose = useCallback(() => {
    onClose?.();
  }, [onClose]);

  // Close All Card Tabs (TUG_ACTIONS.CLOSE_ALL — File ▸ Close All Card Tabs,
  // ⌥⌘W). Closes the entire focused pane (every hosted tab). The
  // confirm rule is per-card: pop the "Close N Tabs?" guard only when at
  // least one hosted card opts into `confirmClose`, close immediately
  // otherwise. This differs from the X button, whose multi-tab close
  // always confirms — the menu command is a deliberate gesture, the X a
  // single stray-click target. The Swift menu enables the item only for
  // a multi-card focused pane; the `count > 1` copy guards the rare
  // stray dispatch onto a single-card pane.
  const handleCloseAll = useCallback(() => {
    const currentCards = cardsRef.current;
    const count = currentCards?.length ?? 1;
    const anyConfirms = !!currentCards?.some(
      (c) =>
        getRegistration(c.componentId)?.defaultMeta.confirmClose === true &&
        !cardWaivesCloseConfirm(c.id),
    );
    titleBarRef.current?.requestCloseWith({
      needsConfirm: anyConfirms,
      message:
        count > 1
          ? `Close ${count} Tabs?`
          : `Close ${cardKindName(
              currentCards?.[0]
                ? getRegistration(currentCards[0].componentId)?.defaultMeta
                : undefined,
            )}?`,
      confirmLabel: count > 1 ? "Close All" : "Close",
      onConfirm: () => onClose?.(),
      // Every hosted card dies with the pane — visit each dirty one.
      guardScope: "pane",
    });
  }, [onClose]);

  const { ResponderScope, responderRef } = useResponder({
    id: stackId,
    kind: "card",
    actions: {
      [TUG_ACTIONS.CLOSE]: (_event: ActionEvent) => handleChromeClose(),
      [TUG_ACTIONS.CLOSE_ALL]: (_event: ActionEvent) => handleCloseAll(),
      // The X button, aimed from elsewhere — today the Cards card's pane row. It
      // delegates to the same `requestClose()` the chrome close goes through,
      // so a remote close box inherits the X's whole policy rather than a
      // second, weaker one: every hosted card's save guard runs, and a
      // multi-tab pane still asks "Close N Tabs?" before anything dies.
      [TUG_ACTIONS.CLOSE_PANE]: (_event: ActionEvent) => {
        titleBarRef.current?.requestClose();
      },
      // Same shape as CLOSE_PANE: the pane answers the chain by calling an
      // imperative handle on the title bar, which owns the transient UI.
      [TUG_ACTIONS.REVEAL_STACK]: (_event: ActionEvent) => {
        titleBarRef.current?.revealStack();
      },
      // The depth pair: switch within the slot's stack without reading
      // anything. Nothing transient is put on screen, so neither reaches the
      // title bar.
      //
      // NEXT raises the LAST entry: `slotStack` is topmost-first, so that is
      // the pane buried longest, raised through the same `onRevealPane` the
      // picker's rows go through — one raise policy for both. Raising the
      // bottom-most is what makes repeated presses a ring rather than a
      // two-pane ping-pong — every raise sends the outgoing front pane one
      // place back, so a depth-N slot is home again after N presses and the
      // user can count instead of look. It is also what ⌘` does with
      // windows. The raise moves the first responder to the pane that came
      // up, so the *next* press is answered by that pane reading its own
      // freshly-ordered stack.
      [TUG_ACTIONS.NEXT_STACK_CARD]: (_event: ActionEvent) => {
        const slotStack = panePlaceFactsOf(store.getSnapshot(), stackId).slotStack;
        if (slotStack.length <= 1) return;
        const buried = slotStack[slotStack.length - 1];
        if (buried) onRevealPane?.(buried);
      },
      // PREVIOUS is NEXT's exact inverse: this pane leaves the front by
      // going all the way to the back (`sendPaneBehind` the bottom member),
      // fronting the entry beneath it — a true rotation, where raising the
      // second-from-top instead would ping-pong. Focus rides
      // `transferFocusForActivation` like every other activation path.
      [TUG_ACTIONS.PREVIOUS_STACK_CARD]: (_event: ActionEvent) => {
        const slotStack = panePlaceFactsOf(store.getSnapshot(), stackId).slotStack;
        if (slotStack.length <= 1) return;
        const next = slotStack[1];
        const bottom = slotStack[slotStack.length - 1];
        if (!next || !bottom) return;
        transferFocusForActivation({
          outgoingCardId: store.getFirstResponderCardId(),
          incomingCardId: next.cardId,
          store,
          commitMutation: () => {
            store.sendPaneBehind(stackId, bottom.paneId);
            store.activateCard(next.cardId);
          },
          deferCommit: mayDeferCommit(store, next.cardId),
        });
      },
      [TUG_ACTIONS.SELECT_TAB]: (event: ActionEvent) => {
        if (typeof event.value !== "string") return;
        performSelectCard(event.value);
      },
      [TUG_ACTIONS.CLOSE_TAB]: (event: ActionEvent) => {
        if (typeof event.value !== "string") return;
        // The tab × is the one close gesture that can name a card other than
        // the active one, so its hold and its guard are asked of ITS target
        // rather than of whatever is front.
        closeTab(store, stackId, event.value);
      },
      [TUG_ACTIONS.ADD_TAB]: (event: ActionEvent) => {
        if (typeof event.value !== "string") return;
        store.addCardToPane(stackId, event.value);
      },
      // No FIND handler here on purpose. A registered no-op would make
      // the native Edit ▸ Find item validate as enabled (the menu pulls
      // `chain.validateAction(FIND)`) while doing nothing — a live
      // shortcut to a stub. Find enables only where a surface really
      // implements it (e.g. the code view's search session); everywhere
      // else it stays disabled until a real find lands.
    },
  });

  const hasMultipleCards = cards !== undefined && cards.length > 1;
  const activeCard =
    hasMultipleCards && activeCardId
      ? cards!.find((c) => c.id === activeCardId)
      : undefined;
  const activeCardRegistration = activeCard
    ? getRegistration(activeCard.componentId)
    : undefined;

  const effectiveMeta: CardMeta = activeCardRegistration
    ? activeCardRegistration.defaultMeta
    : meta;

  // Rail-ness follows the ACTIVE card's registration, the same way the
  // masthead and the title do. It reads `layoutRole` — what the card IS — and
  // not `sidebarSide`, which says only where a rail currently stands: a
  // released rail card is still a tool, and its livery should not blink when it
  // leaves its pin. `activeCardRegistration` resolves only for a stacked pane,
  // so a single-card pane falls back to the role its caller resolved from the
  // same registration, exactly as `effectiveMeta` falls back to `meta`.
  const effectiveLayoutRole: LayoutRole | undefined = activeCardRegistration
    ? activeCardRegistration.layoutRole
    : layoutRole;
  const isRail = effectiveLayoutRole === "sidebar";

  // The fold's door on the title bar ([B06]), for every content card that does
  // not author its own folded form. Read off `cards` for a stacked pane and
  // the caller's `activeComponentId` for a single one.
  const foldCardComponentId =
    cards?.find((c) => c.id === activeCardId)?.componentId ??
    activeComponentId ??
    null;
  const cardFold = paneCardFoldOf(isRail, foldCardComponentId);
  const readFirstResponderCardId = useCallback(
    () => store.getFirstResponderCardId(),
    [store],
  );

  // Per-card title override (cardTitleStore) — the name a card takes once its
  // identity resolves: a Text card's filename, the Session card's bound
  // project path. It REPLACES the registry title rather than prefixing it
  // (`lib/pane-title.ts` owns that rule), so a card with a name of its own is
  // called by it and nothing else. Subscription is keyed on the active card so
  // a card swap repaints the title without prop drill.
  const activeCardTitleOverride = useSyncExternalStore(
    cardTitleStore.subscribe,
    useCallback(
      () => cardTitleStore.get(activeCardId ?? null),
      [activeCardId],
    ),
  );

  // The active card's masthead request ([P14]: chrome follows the frontmost
  // tab, so a stacked Session card behind another tab contributes nothing
  // here). The payload object is stable while unchanged, so this is a
  // legitimate `useSyncExternalStore` snapshot.
  const activeCardMasthead = useSyncExternalStore(
    cardTitleStore.subscribe,
    useCallback(
      () => cardTitleStore.getMasthead(activeCardId ?? null),
      [activeCardId],
    ),
  );

  // Whether the frontmost card's content is a body placed beneath this page,
  // which the pane must let show through.
  const activeCardIsBody = useSyncExternalStore(
    bodyCardsStore.subscribe,
    useCallback(
      () => activeCardId !== undefined && activeCardId !== null && bodyCardsStore.has(activeCardId),
      [activeCardId],
    ),
  );

  // The active card draws the pane's chrome in its own page, so this frame
  // renders as its stand-in. Keyed on the active card: a Text tab brought
  // forward in the same pane is the shell's to draw again. A body that failed
  // has no page to draw it, and its placard stands in the shell's chrome.
  const activeBodyFailed = useSyncExternalStore(
    bodyCardsStore.subscribe,
    useCallback(
      () => activeCardId !== undefined && activeCardId !== null && bodyCardsStore.stateOf(activeCardId) === "failed",
      [activeCardId],
    ),
  );
  const standIn = activeCardIsBody && !activeBodyFailed && chromeInBody(foldCardComponentId);
  // The keyboard across a fold goes to the glyph the title bar draws: a
  // stand-in's card draws it in its own page, which moves the keyboard there
  // (`body-root.tsx`).
  useCardFoldFocus(
    activeCardId ?? null,
    foldCardComponentId,
    folded,
    cardFold && !standIn,
    readFirstResponderCardId,
  );

  // Which hosted card, if any, is held by a modal run — the same shape as
  // `resolveCloseGuard` below and read at the same moment, live at close time
  // ([L07]). `"pane"` scans every hosted card because the gestures carrying
  // that scope take all of them: a background tab compacting is as good a
  // reason to refuse as the front one is.
  const resolveModalHold = useCallback(
    (scope: "active" | "pane"): string | null => {
      const holds = cardModalHoldStore.getSnapshot();
      const activeId = activeCardIdRef.current;
      if (scope === "active") {
        return isCardHeld(holds, activeId) ? (activeId ?? null) : null;
      }
      const ids = [
        ...(activeId ? [activeId] : []),
        ...(cardsRef.current ?? [])
          .map((c) => c.id)
          .filter((id) => id !== activeId),
      ];
      return ids.find((id) => isCardHeld(holds, id)) ?? null;
    },
    [],
  );

  // Resolve the close decision for a close gesture, live at close time;
  // the refs keep it correct between renders as cards and activation
  // change. `"active"` consults only the active card (single-card close);
  // `"pane"` composes every hosted card's guard — background tabs stay
  // mounted (`display: none`), so their stores are live and their guards
  // registered. The composite VISITS each card that needs a decision
  // (activates it before prompting) so the user chooses looking at the
  // buffer in question; any `"cancel"` aborts the whole close.
  const resolveCloseGuard = useCallback(
    (scope: "active" | "pane"): CardCloseDecision | null => {
      const activeId = activeCardIdRef.current;
      if (scope === "active") {
        const guard = activeId ? getCardCloseGuard(activeId) : null;
        return guard ? guard.run : null;
      }
      const ids = [
        ...(activeId ? [activeId] : []),
        ...(cardsRef.current ?? [])
          .map((c) => c.id)
          .filter((id) => id !== activeId),
      ];
      // The walk itself is shared with the workspace delete ([P05]), which
      // owes the user the same per-card sheets over a different set of
      // cards. A `null` here still means "nothing was asked", which is what
      // keeps a multi-tab pane's "Close N Tabs?" stray-click protection.
      //
      // `activeCardIdRef` is read INSIDE the callback rather than captured,
      // so the walk sees the activations it has itself performed.
      return closeGuardWalk(
        ids,
        performSelectCard,
        (id) => activeCardIdRef.current === id,
      );
    },
    [performSelectCard],
  );

  // The composition rule itself lives in `lib/pane-title.ts`, because this is
  // not the only surface that names a pane — the slot-stack picker and the
  // Window menu's pane list name the same panes, and a second copy of this
  // arithmetic is how they came to disagree with the title bar.
  const displayTitle = composePaneTitleBarText({
    metaTitle: effectiveMeta.title,
    paneTitle: cardTitle,
    titleOverride: activeCardTitleOverride,
  });

  // The tab bar stands in the accessory's place on a pane of several cards
  // (`PaneChrome` draws it), so either one is an accessory to measure.
  const hasAccessory = hasMultipleCards || accessory != null;
  const accessoryRef = useRef<HTMLDivElement>(null);
  const [accessoryHeight, setAccessoryHeight] = useState(0);

  useLayoutEffect(() => {
    const el = accessoryRef.current;
    if (!el) {
      setAccessoryHeight(0);
      return;
    }
    // Observer-only, for the two reasons the title bar's controls-width
    // effect gives: a synchronous rect read here is a forced layout inside
    // the commit, and a ResizeObserver under a hidden workspace layer is
    // silent until the layer is shown and then delivers before the first
    // shown frame paints. The height it reports is the tab bar's real one
    // whether the pane is on screen or parked — a hidden pane is laid out
    // ([B02]) — so nothing here is a reading about an ancestor's `display`.
    // Held by the motion gate: a frame whose width tweens resizes the
    // accessory at every frame, and only its height is wanted.
    const ro = heldResizeObserver(() => {
      // A rect is viewport px; the height feeds a layout min-height.
      setAccessoryHeight(layoutPxOf(el.getBoundingClientRect().height));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [hasAccessory]);

  // ---------------------------------------------------------------------------
  // onMinSizeChange — content-reported minimum drives resize clamp
  // ---------------------------------------------------------------------------

  const handleMinSizeChange = useCallback(
    (newSize: { width: number; height: number }) => {
      // Enforce policy min as floor: content cannot report a min below the policy.
      setMinSize({
        width: Math.max(newSize.width, sizePolicy.min.width),
        height: Math.max(newSize.height, sizePolicy.min.height),
      });
    },
    [sizePolicy.min.width, sizePolicy.min.height],
  );

  const totalMinWidth = minContentSize.width;
  const totalMinHeight = HEADER_HEIGHT_PX + accessoryHeight + minContentSize.height;

  useEffect(() => {
    handleMinSizeChange({
      width: totalMinWidth,
      height: totalMinHeight,
    });
  }, [handleMinSizeChange, totalMinWidth, totalMinHeight]);

  // ---------------------------------------------------------------------------
  // Drag system
  //
  // The drag mechanic is a three-phase state machine:
  //
  //   1. START (handleDragStart): snapshot all state, set up pointer capture,
  //      build caches for snap/merge hit-testing, attach move/up listeners.
  //
  //   2. FRAME (applyDragFrame, called via rAF from onPointerMove): compute
  //      clamped position, apply snap or free-drag, hit-test tab bars for
  //      merge feedback. All DOM mutations are appearance-zone.
  //
  //   3. END (onPointerUp): commit final position to store, handle merge-on-drop,
  //      clean up listeners and state.
  //
  // All drag state lives in refs — zero React re-renders during drag.
  //
  // Two drag modes (determined per-frame in applyDragFrame):
  //   - Free drag: no modifier. Position = clamped pointer delta.
  //   - Snap mode: Option held. Position snapped to other card edges.
  //
  // Merge: dragging over another card's tab bar highlights the drop target.
  // Releasing on the tab bar merges this card's active tab into the target.
  // ---------------------------------------------------------------------------

  // Whether a drag gesture is currently active.
  const dragActive = useRef(false);
  // Pending rAF handle; null when no frame is scheduled.
  const dragRafId = useRef<number | null>(null);
  // Client-space pointer coordinates captured at pointer-down.
  const dragStartPointer = useRef({ x: 0, y: 0 });
  // Canvas-relative card position captured at pointer-down.
  const dragStartPosition = useRef({ x: 0, y: 0 });
  // Whether the pointer has travelled far enough to make this a move rather
  // than a click. Until it has, the gesture commits nothing.
  const dragMoved = useRef(false);
  // Whether the press that opened this gesture held the command key. Read only
  // in the no-travel branch of `onPointerUp`, where a Cmd-click resolves as
  // "reveal this pane's stack" — a Cmd-drag latches `dragMoved` and never
  // reaches it.
  const dragStartedWithMeta = useRef(false);
  // Canvas bounding rect snapshotted at drag-start; used for all clamping.
  const dragCanvasBounds = useRef<DOMRect | null>(null);
  // Most recent client-space pointer coordinates from onPointerMove.
  const latestDragPointer = useRef({ x: 0, y: 0 });
  /**
   * The previous pointer sample and when it arrived — the two numbers a
   * release velocity is made of.
   *
   * A drop's landing inherits the hand ([P05] of
   * `arc/layout-imposer-polish.md`): a card let go while still moving
   * toward its zone arrives carrying that motion instead of stopping dead and
   * starting again. Two samples are enough — the estimate only has to know how
   * fast the hand was going at the instant it opened, and a longer window
   * would average away the flick it is trying to catch.
   */
  const previousDragPointer = useRef<{
    x: number;
    y: number;
    at: number;
  } | null>(null);

  // Track the tab bar element currently highlighted as a merge drop target.
  // Appearance-zone only: set/cleared via data-drop-target attribute. [D45, Rule 4]
  const dragDropTargetEl = useRef<HTMLElement | null>(null);

  // The zone drag in flight, or null for a gesture that has nowhere to land —
  // a free pane, an unimposed deck, a canvas with no host. `live` is the one
  // indicated zone, which is never null while the drag is a zone drag ([P09]).
  const zoneDragRef = useRef<{
    zones: readonly DropZone[];
    live: DropZone | null;
    /** The place the card started on, kept for the whole gesture: a release
     *  back onto it commits nothing, and a drop that commits nothing is the one
     *  the landing has to animate itself. */
    origin: DropZone | null;
    /** The frame's own rect at the latch, in canvas layout px, before any
     *  transform — what the engine measures a place from when this card is
     *  the place's sole member, since a frame in flight defines nothing. */
    startRect: Rect;
  } | null>(null);
  // Whether ⌘ was held at the most recent frame. Read like `latestAltKey` and
  // for the same reason — the modifier's meaning is decided by where the hand
  // is now, not by where it was at pointer-down ([P13]).
  const latestMetaKey = useRef(false);
  const dropZonesRef = useRef(dropZones);
  dropZonesRef.current = dropZones;
  // A zone drop whose frame is still wearing the transform the hand left it
  // on, waiting to be carried into the tile the indicator promised. `from` is
  // where the frame stood on screen at the release — measured before the
  // commit, because that is the last moment the old arrangement is real, and it
  // is the only rect a landing can honestly start from.
  const pendingZoneDropRef = useRef<{
    el: HTMLElement;
    from: DOMRect;
    /** The card whose landing mark the store is holding for this frame. */
    cardId: string;
    /** The hand's speed at the release, in CSS px/s, for the landing to
     *  inherit. `{x: 0, y: 0}` for a release the hand had stopped moving on. */
    releaseVelocity: { x: number; y: number };
  } | null>(null);
  // Every strip this gesture has scrolled, and where it left each one. Held per
  // strip rather than as one number because a drag can cross from one
  // overflowing column to another, and each keeps what the hand did to it.
  // Written imperatively during the gesture; committed once at its end.
  const autoscrolledRef = useRef(new Map<string, AutoscrollRun>());
  // The timestamp of the last frame that advanced the clock, or null between
  // gestures. Elapsed time is what makes the travel the same for a given hold
  // however the frames happen to fall.
  const autoscrollClockRef = useRef<number | null>(null);
  // The flow click's memory: which trigger edge is armed and when each last
  // fired, and the click in flight if one is. Both are cleared with the runs
  // in `commitAutoscroll`, which every path that ends the gesture reaches.
  const flowStepRef = useRef<FlowStepState>(flowStepArmed());
  const flowTweenRef = useRef<FlowStepTween | null>(null);
  // The tab-bar rects the gesture snapshotted at its latch, kept so a
  // re-enumeration mid-autoscroll can be handed the same ones. Re-querying them
  // would be a different snapshot in the middle of one gesture.
  const zoneTabBarsRef = useRef<ReadonlyMap<string, Rect>>(new Map());

  /**
   * Carry a dropped frame from where the hand left it into the place the
   * commit gave it — a FLIP, and the reason a drop is a landing rather than a
   * jump.
   *
   * **Every drop animates, including the one that commits nothing.** A release
   * on the card's own position is still a release onto a zone ([P09]), and the
   * card has still travelled under the hand; letting that one snap home while
   * every other drop glides would say the gesture had been ignored. So the
   * distance is measured rather than assumed: whatever the commit did or did
   * not change, the frame crosses from the release rect to the resting one.
   *
   * The frame keeps `data-gesture` until the landing finishes, which is what
   * holds the imposer's own settle off it — the settle carries every OTHER
   * frame the commit moved, and this one is already being carried.
   *
   * Reading `--tugx-imposer-settle-duration` rather than the constant means the
   * landing is retuned by the same override that retunes the settle: one knob
   * for how fast cards move, and the drop is not the exception to it.
   */
  const landZoneDrop = useCallback(() => {
    const pending = pendingZoneDropRef.current;
    if (pending === null) return;
    pendingZoneDropRef.current = null;
    const { el, from, cardId, releaseVelocity } = pending;
    el.style.transform = "";
    const to = el.getBoundingClientRect();
    const zoom = pageZoomFactor();
    const dx = (from.left - to.left) / zoom;
    const dy = (from.top - to.top) / zoom;
    if (dx === 0 && dy === 0) {
      el.removeAttribute("data-gesture");
      el.removeAttribute("data-pointer-owned");
      bodyFrameLanded(el);
      store.noteCardDidLand(cardId);
      return;
    }
    // The `landing` recipe, seeded with whatever the hand was still doing at
    // the release. The travel is from where the frame sits back to zero, so
    // the vector the velocity is projected onto is the negative of the FLIP's
    // inverse offset — the direction the card is about to go.
    const curve = motionKeyframes("landing", {
      nominalMs: readSettleMs(el),
      initialVelocity: velocityAlongTravel(releaseVelocity, {
        x: -dx,
        y: -dy,
      }),
    });
    const landing = animate(
      el,
      curve.progress.map((p, i) => ({
        offset: i / (curve.progress.length - 1),
        // The curve walks the inverse offset away; an overshoot carries the
        // frame past its place and the spring brings it back.
        transform: `translate(${(1 - p) * dx}px, ${(1 - p) * dy}px)`,
      })),
      {
        // Raw ms: TugAnimator scales by getTugTiming() itself.
        duration: curve.durationMs,
        // The physics is in the keyframes, so the easing is the keyword that
        // keeps the effect accelerable (`lib/pane-flip.ts` says why).
        easing: "linear",
        // No retained effect after the tween ends ([D6]).
        fill: "none",
        key: "zone-drop-landing",
      },
    );
    // The body under the frame rides the landing with it: the tween writes
    // the transform and nothing commits, so the placer is told each frame
    // where the frame now stands, and once more at rest.
    let landed = false;
    const carryBody = (): void => {
      if (landed) return;
      bodyFollowFrame(el);
      requestAnimationFrame(carryBody);
    };
    requestAnimationFrame(carryBody);
    const done = () => {
      landed = true;
      el.removeAttribute("data-gesture");
      el.removeAttribute("data-pointer-owned");
      bodyFrameLanded(el);
      // After the marks come off: the reveal this releases arms a settle,
      // and the settle must see this frame as one it may carry.
      store.noteCardDidLand(cardId);
    };
    landing.finished.then(done, done);
  }, [store]);

  /**
   * Land the drop on the commit that gave the frame its new place ([L03] — a
   * layout effect, so it runs after the DOM is updated and before anything is
   * painted or measured against it).
   *
   * A layout effect rather than a frame callback because the thing being waited
   * for is a React commit, and rAF's timing against one is a browser detail
   * rather than a contract ([L05]). A drop that commits nothing renders
   * nothing, so it never reaches here — `onPointerUp` lands that one itself.
   */
  useLayoutEffect(() => {
    landZoneDrop();
  });

  /**
   * Snapshot all `.tug-tab-bar[data-pane-id]` elements at drag-start (excluding
   * our own pane). Used for hit-testing during drag and on pointer-up. [D45]
   */
  const dragTabBarCache = useRef<Array<{ paneId: string; rect: DOMRect; el: HTMLElement }>>([]);

  // Snap-related refs [D01, D03, D04]
  // Canvas-relative rects of all other cards, snapshotted at drag-start for computeSnap. [D04]
  const dragOtherRects = useRef<{ id: string; rect: Rect }[]>([]);
  // Active snap guide DOM elements; cleared on drop and on each rAF if guides change. [D03]
  const dragGuideEls = useRef<HTMLElement[]>([]);
  // Whether alt key is held during drag.
  const latestAltKey = useRef(false);
  // Snap result computed in the last rAF; read in onPointerUp to finalise snapped position. [D01]
  const lastSnapResult = useRef<SnapResult | null>(null);

  /**
   * Set a tab bar element as the current drag drop target (appearance-zone).
   * Clears the previous target before applying the new one. [D45, Rule 4]
   */
  function setDragDropTarget(el: HTMLElement | null): void {
    if (dragDropTargetEl.current === el) return;
    if (dragDropTargetEl.current) {
      dragDropTargetEl.current.removeAttribute("data-card-drag-target");
    }
    dragDropTargetEl.current = el;
    if (el) {
      el.setAttribute("data-card-drag-target", "true");
    }
  }

  /**
   * Compute insertion index for a merge into a target tab bar's tab array,
   * based on pointer X coordinate vs tab midpoints. Uses the same approach
   * as TabDragCoordinator.computeReorderIndex. [D45]
   */
  function computeMergeInsertIndex(barEl: HTMLElement, pointerX: number): number {
    const tabEls = barEl.querySelectorAll<HTMLElement>('.tug-tab:not([data-overflow="hidden"])');
    if (tabEls.length === 0) return 0;
    for (let i = 0; i < tabEls.length; i++) {
      const rect = tabEls[i].getBoundingClientRect();
      if (pointerX < rect.left + rect.width / 2) return i;
    }
    return tabEls.length;
  }

  const handleDragStart = useCallback(
    (event: React.PointerEvent) => {
      // Drag-start focus save. The pane
      // title bar is not focusable, so WebKit's mousedown default
      // would normally blur whatever element inside the active
      // card has focus. Saving the active card's bag in capture
      // phase — before the blur lands — preserves `bag.focus` and
      // `bag.domSelection` so the helper can restore them after
      // the gesture (drop, cancel, or even no-op release).
      // The save is unconditional: cheap, idempotent with the
      // subsequent debounced save.
      const currentActiveCardId = activeCardIdRef.current;
      if (currentActiveCardId) {
        captureFocusForDragStart({
          sourceCardId: currentActiveCardId,
          store,
        });
      }

      if (!frameRef.current) return;
      const frame: HTMLDivElement = frameRef.current!;

      // Capture pointer on the frame element for reliable move/up tracking outside bounds.
      frame.setPointerCapture(event.nativeEvent.pointerId);

      // Disable height transition during drag so the collapse animation does not
      // conflict with pointer-driven position updates. [D07, chrome.css]
      frame.setAttribute("data-gesture", "true");
      // `data-gesture` says a hand is on the frame: the lifted livery, the
      // suspended height transition, the held completion repaint. It does NOT
      // say the frame positions itself — that is `data-pointer-owned`, written
      // only once the drag latches (below), because a press that never
      // travels keeps the imposer's geometry and the settle must still carry
      // it. A commit landing inside the press — the click's reveal — would
      // otherwise find the frame wearing a mark that means "skip me" and cut
      // it while every neighbour crossed.

      // === PHASE 1: SNAPSHOT ===
      // Capture all state needed for the drag gesture. Everything below runs
      // once at pointer-down and is read (not written) during the drag.

      // Snapshot canvas bounds and drag start state once.
      dragCanvasBounds.current =
        paneCanvasOf(frame)?.getBoundingClientRect() ?? null;
      dragActive.current = true;
      dragStartPointer.current = { x: event.clientX, y: event.clientY };

      // A derived pane (a pinned rail, an imposed card) is released from whatever
      // was deriving its geometry by MOVING it, not by being touched: the
      // release waits for the pointer to travel (see `releaseImposedFrame`,
      // called from the first frame past the threshold). Until then the pane
      // still belongs to the arrangement, so a click on a rail's title bar —
      // to focus it, or to start a gesture and think better of it — leaves it
      // pinned where it was.
      dragMoved.current = false;
      // Whether the press that started this gesture was meta-modified. A
      // Cmd-drag on a title bar is meaningful today and must survive: for a
      // free pane it is the Mac convention of moving a background window
      // without raising it, and for an imposed pane the drag is how it is
      // evicted from its slot. So Cmd does not decide anything on the way
      // down — the decision waits for the gesture's ending, and the no-travel
      // branch in `onPointerUp` below IS that ending, already written.
      dragStartedWithMeta.current = event.metaKey;
      dragStartPosition.current = { x: position.x, y: position.y };
      latestDragPointer.current = { x: event.clientX, y: event.clientY };
      // A fresh grab has no history, so a release without a single move
      // inherits nothing — which is right: that hand never moved.
      previousDragPointer.current = null;

      // Build tab bar cache for merge hit-testing. [D45]
      // Snapshot all .tug-tab-bar[data-pane-id] elements (excluding this pane).
      dragTabBarCache.current = [];
      const barEls = document.querySelectorAll<HTMLElement>(".tug-tab-bar[data-pane-id]");
      barEls.forEach((el) => {
        const paneId = el.getAttribute("data-pane-id");
        if (!paneId || paneId === id) return;
        // A rail never accepts a merge — skip its tab bar as a drop
        // target.
        if (el.closest(".tug-pane[data-sidebar-pane]")) return;
        dragTabBarCache.current.push({ paneId, rect: el.getBoundingClientRect(), el });
      });

      // Snapshot other card rects at drag-start for snap computation. [D04]
      // Convert to canvas-relative coordinates by subtracting canvas bounds offset.
      // All snap geometry runs in layout space; the deck root's View › Zoom
      // transform requires dividing the rect measurements by the zoom factor.
      // Read once per gesture.
      const dragZoom = pageZoomFactor();
      const dragGuideEdgeOffsets = measureGuideEdgeOffsets(frame, dragZoom);
      const canvasBounds = dragCanvasBounds.current;
      dragOtherRects.current = snapshotCardRects(canvasBounds, id, dragZoom);

      // Initialize drag state.
      latestAltKey.current = false;
      lastSnapResult.current = null;

      /** The canvas point the pointer is over, in the layout space every drop
       *  zone's rect is measured in. */
      function pointerOnCanvas(client: { x: number; y: number }) {
        const canvas = dragCanvasBounds.current;
        return {
          x: (client.x - (canvas?.left ?? 0)) / dragZoom,
          y: (client.y - (canvas?.top ?? 0)) / dragZoom,
        };
      }

      /**
       * Latch the drag into zone mode, or answer null for a gesture with
       * nowhere to land — a free pane, an unimposed deck, an unpinned sidebar
       * card, or a canvas with no host.
       *
       * A PINNED sidebar card does land somewhere: its rail's positions are
       * zones like any other ([P11]), which is what let the corridor retire.
       */
      function beginZoneDrag(): {
        zones: readonly DropZone[];
        live: DropZone | null;
        origin: DropZone | null;
        startRect: Rect;
      } | null {
        const host = dropZonesRef.current;
        if (host === undefined) return null;
        const tabBars = new Map<string, Rect>();
        for (const entry of dragTabBarCache.current) {
          const canvas = dragCanvasBounds.current;
          tabBars.set(entry.paneId, {
            x: (entry.rect.left - (canvas?.left ?? 0)) / dragZoom,
            y: (entry.rect.top - (canvas?.top ?? 0)) / dragZoom,
            width: entry.rect.width / dragZoom,
            height: entry.rect.height / dragZoom,
          });
        }
        zoneTabBarsRef.current = tabBars;
        // The latch runs before the first transform is written, so this is
        // the frame where the arrangement put it — the one rect of its own
        // the dragged card can vouch for once it is moving.
        const canvas = dragCanvasBounds.current;
        const seated = frame.getBoundingClientRect();
        const startRect: Rect = {
          x: (seated.left - (canvas?.left ?? 0)) / dragZoom,
          y: (seated.top - (canvas?.top ?? 0)) / dragZoom,
          width: seated.width / dragZoom,
          height: seated.height / dragZoom,
        };
        const set = host.enumerate(id, tabBars, startRect);
        if (set.zones.length === 0) return null;
        return { zones: set.zones, live: set.origin, origin: set.origin, startRect };
      }

      /**
       * Advance whatever strip the pointer is holding at the edge of, and
       * answer whether anything moved.
       *
       * On the gesture's own rAF ([D135] — no second clock), and imperatively:
       * the offset goes onto its custom property and nowhere near the store
       * (Spec S03), so the strip follows the hand at no measuring cost. The
       * number commits once, at the drop or the cancel, and it commits with
       * `landing: "cut"` — the strip is already drawn there, so the settle
       * declines instead of measuring and tweening the column's other members
       * under the user's hand ([B01], [B03]). Per frame is a cost choice now
       * rather than the only way to say what the commit means.
       *
       * Rescheduling itself while it is advancing is what makes a HELD pointer
       * keep scrolling: the drag's frames are otherwise driven by pointermove,
       * and a hand that has stopped moving posts none.
       */
      function advanceAutoscroll(pointer: { x: number; y: number }): boolean {
        const host = dropZonesRef.current;
        if (host === undefined) return false;
        const now = performance.now();
        const last = autoscrollClockRef.current;
        autoscrollClockRef.current = now;
        const target = host.autoscrollTargetFor(pointer, id);
        if (target === null) return false;
        if (target.kind === "flow") return advanceFlowClick(target, pointer, now);
        if (last === null) return false;

        const key = autoscrollKey(target);
        const running = autoscrolledRef.current.get(key);
        const standing = running?.offset ?? target.offset;
        const delta = autoscrollDelta({
          pointer: target.axis === "y" ? pointer.y : pointer.x,
          bandStart: target.bandStart,
          bandEnd: target.bandEnd,
          elapsedMs: now - last,
        });
        if (delta === 0) return false;

        // Keep the clock alive while the hand holds, whether or not the strip
        // still has anywhere to go — a strip pinned at its end that stopped
        // scheduling frames would never notice the hand moving off the edge.
        scheduleDragFrame();
        const next = Math.min(Math.max(0, standing + delta), target.maxOffset);
        if (next === standing) return false;
        autoscrolledRef.current.set(key, { target, offset: next });
        host.applyScroll(target, next);
        return true;
      }

      /**
       * The flow strip's own branch: a click, not a rate.
       *
       * Crossing the band's trigger edge — the rail's inner edge when a rail
       * stands there, the canvas edge otherwise — steps the strip one slot
       * toward the hand, with hysteresis (`flowStepDecision`), and the step
       * names the first slot past that edge and the least travel that shows
       * it whole (`flowStepTarget`). The travel is interpolated here, on the
       * same rAF the rate used ([D135]), one `applyScroll` per frame, so
       * `autoscrollCompensation` reads the moving offset and the card stays
       * in hand. A CSS transition on the property would move the strip on a
       * clock the compensation cannot see.
       *
       * A click that fires while one is in flight names its slot from where
       * the flight LANDS, so a slow repeat under a held hand walks the strip
       * a slot at a time rather than re-naming the slot already on its way.
       * The tween then restarts from where the strip is drawn this frame.
       */
      function advanceFlowClick(
        target: AutoscrollTarget,
        pointer: { x: number; y: number },
        now: number,
      ): boolean {
        const host = dropZonesRef.current;
        if (host === undefined) return false;
        const key = autoscrollKey(target);
        const running = autoscrolledRef.current.get(key);
        const standing = running?.offset ?? target.offset;

        const decided = flowStepDecision({
          pointer: pointer.x,
          bandStart: target.bandStart,
          bandEnd: target.bandEnd,
          state: flowStepRef.current,
          now,
        });
        flowStepRef.current = decided.state;
        if (decided.direction !== 0 && target.strip !== undefined) {
          const landing = flowTweenRef.current?.to ?? standing;
          const named = flowStepTarget({
            strip: target.strip,
            band: target.bandEnd - target.bandStart,
            offset: landing,
            direction: decided.direction,
          });
          if (named !== null && named.offset !== landing) {
            flowTweenRef.current = { from: standing, to: named.offset, startedAt: now };
          }
        }

        // Keep the frames coming while the hand is outboard of an edge or a
        // click is in flight: the drag's frames are otherwise driven by
        // pointermove, and a hand that has stopped moving posts none — so the
        // slow repeat and the tween's remaining frames need the schedule.
        const outboard = pointer.x > target.bandEnd || pointer.x < target.bandStart;
        const tween = flowTweenRef.current;
        if (outboard || tween !== null) scheduleDragFrame();
        if (tween === null) return false;

        const progress = Math.min(1, (now - tween.startedAt) / FLOW_STEP_TWEEN_MS);
        // Ease out: the strip leaves quickly and settles, the way a click
        // reads rather than a slide.
        const eased = 1 - (1 - progress) ** 3;
        const next = Math.min(
          Math.max(0, tween.from + (tween.to - tween.from) * eased),
          target.maxOffset,
        );
        if (progress >= 1) flowTweenRef.current = null;
        if (next === standing) return false;
        autoscrolledRef.current.set(key, { target, offset: next });
        host.applyScroll(target, next);
        return true;
      }

      /** Commit every strip this gesture scrolled — one store write each, at
       *  the end. Real state, so a cancel commits them too: the card goes home
       *  and the view stays where the hand took it. */
      function commitAutoscroll(): void {
        const host = dropZonesRef.current;
        for (const run of autoscrolledRef.current.values()) {
          host?.commitScroll(run.target, run.offset);
        }
        autoscrolledRef.current.clear();
        autoscrollClockRef.current = null;
        flowStepRef.current = flowStepArmed();
        flowTweenRef.current = null;
      }

      /** The tab bar element a tab-bar zone names, for the indication it has
       *  always used ([P10]). */
      function tabBarElementOf(paneId: string): HTMLElement | null {
        return (
          dragTabBarCache.current.find((entry) => entry.paneId === paneId)?.el ??
          null
        );
      }

      /**
       * One frame of a zone drag: the frame follows the pointer on a transform,
       * and the indication follows the pointer to the nearest zone.
       *
       * The transform is why `left`/`top` are never written here — an imposed
       * pane's are calc pins over the live band, and a pixel write would fight
       * them for the rest of the gesture.
       *
       * With ⌘ held the card is being freed ([P13]): no zone is live and the
       * indicator goes away, but the frame still travels on its transform, so
       * the conversion to free pixels can wait for the drop. Option's snap
       * guides do not draw during that stretch — they position against
       * `left`/`top`, which this frame is deliberately not writing.
       */
      /**
       * How far the dragged frame's own base has slid out from under it.
       *
       * An imposed frame's `left`/`top` is a calc that SUBTRACTS its strip's
       * offset (`columnMemberPins`, `flowMemberPins`), so a strip advancing
       * by d moves every member on it — the dragged one included — back by d.
       * The drag's transform is pointer-relative and knows nothing about
       * that, so without this the card creeps out of the hand for as long as
       * the autoscroll runs.
       *
       * Each entry's `target.offset` is where its strip stood when the drag
       * first reached it and never moves after (autoscroll writes the CSS
       * property, never the store — Spec S03), so `offset - target.offset` is
       * the whole travel since the grab. Summed per axis because one drag can
       * scroll a column and the flow band on different axes.
       */
      /**
       * How fast the hand was moving when it opened, in CSS px/s.
       *
       * Taken from the last pointer move and the release itself, using the
       * events' own timestamps rather than a clock read here — the release
       * may be dispatched a frame after the move that preceded it, and the
       * gap between them is the denominator.
       *
       * Zero when there is no previous sample (a press and release with no
       * travel) or when the two share a timestamp (which would divide by
       * nothing). A stale sample is treated as a stop: a hand that paused
       * before letting go has no momentum to give, and inheriting a velocity
       * from 200ms ago would throw a card that was sitting still.
       */
      function releaseVelocity(e: PointerEvent): { x: number; y: number } {
        const previous = previousDragPointer.current;
        if (previous === null) return { x: 0, y: 0 };
        const dt = e.timeStamp - previous.at;
        if (dt <= 0 || dt > RELEASE_VELOCITY_WINDOW_MS) return { x: 0, y: 0 };
        // Client px/s, projected onto a travel stated in layout px.
        return {
          x: ((e.clientX - previous.x) / dt / dragZoom) * 1000,
          y: ((e.clientY - previous.y) / dt / dragZoom) * 1000,
        };
      }

      function autoscrollCompensation(): { dx: number; dy: number } {
        let dx = 0;
        let dy = 0;
        for (const run of autoscrolledRef.current.values()) {
          const travelled = run.offset - run.target.offset;
          if (run.target.axis === "y") dy += travelled;
          else dx += travelled;
        }
        return { dx, dy };
      }

      function applyZoneDragFrame(state: {
        zones: readonly DropZone[];
        live: DropZone | null;
        startRect: Rect;
      }): void {
        const pointer = latestDragPointer.current;
        const start = dragStartPointer.current;
        // Advance first, then place the frame: the compensation has to be
        // read AFTER this frame's scroll, or the card lags the strip by one
        // frame for the whole hold.
        const scrolled =
          !latestMetaKey.current && advanceAutoscroll(pointerOnCanvas(pointer));
        const slide = autoscrollCompensation();
        frame.style.transform = `translate(${
          (pointer.x - start.x) / dragZoom + slide.dx
        }px, ${(pointer.y - start.y) / dragZoom + slide.dy}px)`;
        // Where the frame now stands, published once per frame to whoever is
        // drawing the deck elsewhere ([P08]). After the transform write and
        // before the zone work, so an instrument's ghost and the canvas's own
        // indication are answering the same frame.
        dropZonesRef.current?.gaugeDragFrame(frame);
        // And the body beneath it, which only the shell can tell the host
        // about: the content moves with the chrome rather than standing where
        // the last commit left it.
        bodyFollowFrame(frame);
        if (latestMetaKey.current) {
          state.live = null;
          autoscrollClockRef.current = null;
          dropZonesRef.current?.indicate(null);
          setDragDropTarget(null);
          return;
        }
        if (scrolled) {
          // The strip moved, so every tile moved with it. Re-measure rather
          // than translate the cached rects: the browser has already reflowed
          // against the property this frame wrote, and reading it back is the
          // one answer that cannot drift from what the user is looking at.
          state.zones =
            dropZonesRef.current?.enumerate(id, zoneTabBarsRef.current, state.startRect)
              .zones ?? state.zones;
        }
        state.live = pickLiveZone(state.zones, pointerOnCanvas(pointer), state.live);
        dropZonesRef.current?.indicate(state.live);
        setDragDropTarget(
          state.live?.kind === "tab-bar"
            ? tabBarElementOf(state.live.paneId)
            : null,
        );
      }

      // === PHASE 2: FRAME (rAF callback) ===
      // Called once per animation frame during drag. Computes position,
      // applies snap or free-drag, hit-tests merge.
      // All mutations are appearance-zone (direct DOM, no React state).
      function applyDragFrame() {
        dragRafId.current = null;
        if (!dragActive.current) return;

        // Below the threshold this is still a click, and a click moves nothing.
        if (!dragMoved.current) {
          const start = dragStartPointer.current;
          const travelled = Math.hypot(
            latestDragPointer.current.x - start.x,
            latestDragPointer.current.y - start.y,
          );
          if (travelled < DRAG_MOVE_THRESHOLD_PX) return;
          dragMoved.current = true;
          // The frame is the drag's from here, so a settle still carrying it
          // gives it up first ([L32]). The drag measures from the pointer's
          // start, so the distance the settle had yet to carry the frame
          // moves the start with it, and the pane stays where the hand found
          // it rather than jumping to where the slide was taking it.
          const stood = takeFrameFromSettle(frame);
          dragStartPointer.current = {
            x: start.x - stood.dx,
            y: start.y - stood.dy,
          };
          // From here the pointer writes `left`/`top` every frame, and the
          // settle and the cut detector must leave the frame alone.
          frame.setAttribute("data-pointer-owned", "true");
          // The move is about to expose whatever this frame was covering,
          // without a store commit; reveal every occluded pane before the
          // first moved paint and hold hides until the gesture ends.
          //
          // Unconditional, in BOTH modes. The bracket is not about the rail's
          // footprint — it is about frames covering each other, which is
          // precisely what a reorder does transiently as the dragged member
          // translates over its sibling. Left to itself the occlusion
          // controller would arm its hide timer and stamp a fully covered
          // sibling `data-occluded` under the user's hand, since a paused
          // pointer with no tween running is exactly the quiescent state it
          // waits for. It also keeps the drop's unconditional `end()` paired.
          paneOcclusionGesture.begin();
          // One latch for every arrangeable pane, content and rail alike
          // ([P11]). A rail member's places are its rail's positions and a
          // content card's are the content-side vocabulary; which it gets is
          // the engine's to answer, and the gesture no longer has to know.
          const zoneSet = beginZoneDrag();
          if (zoneSet !== null) {
            // A zone drag never releases the frame. The pane keeps its derived
            // geometry for the whole gesture and travels on a transform, so a
            // release that lands on a zone — which is every unmodified release
            // ([P09]) — has nothing to undo. Only a ⌘-freed drop converts, and
            // it converts at the drop, where the decision is actually made.
            zoneDragRef.current = zoneSet;
            dropZonesRef.current?.indicate(zoneSet.live);
          } else if (derivedRef.current) {
            // Now it is a move. A derived pane converts to free pixel geometry
            // here, at the moment the gesture becomes one.
            const released = releaseImposedFrame(frame, dragCanvasBounds.current);
            dragStartPosition.current = { x: released.x, y: released.y };
          }
        }

        // Zone mode owns the rest of the frame: the pane is still derived, so
        // its travel is a transform and its `left`/`top` stay the
        // arrangement's — a pixel write would fight the calc pins.
        const zoneDrag = zoneDragRef.current;
        if (zoneDrag !== null) {
          applyZoneDragFrame(zoneDrag);
          return;
        }

        // Always solo card clamping.
        const pos = clampedPosition(
          latestDragPointer.current,
          dragStartPointer.current,
          dragStartPosition.current,
          dragCanvasBounds.current,
          { width: frame.offsetWidth, height: frame.offsetHeight },
          dragZoom,
        );

        if (latestAltKey.current) {
          // Snap mode: Option held. [D01]
          const movingRect: Rect = {
            x: pos.x,
            y: pos.y,
            width: frame.offsetWidth,
            height: frame.offsetHeight,
          };
          const snapResult = computeSnap(
            movingRect,
            dragOtherRects.current.map((r) => r.rect),
            undefined,
            -IMPOSITION_GAP_PX,
          );
          lastSnapResult.current = snapResult;
          if (snapResult.x !== null) {
            pos.x = snapResult.x;
          }
          if (snapResult.y !== null) {
            pos.y = snapResult.y;
          }
          // Render snap guides via DOM manipulation. [D03]
          const container = paneCanvasOf(frame);
          if (container) {
            syncGuideElements(dragGuideEls, snapResult.guides, container, dragGuideEdgeOffsets);
          }
        } else {
          // Free drag: no snap modifier. Clear guides and snap result.
          lastSnapResult.current = null;
          clearGuideElements(dragGuideEls);
        }

        frame.style.left = `${pos.x}px`;
        frame.style.top = `${pos.y}px`;
        bodyFollowFrame(frame);

        // Hit-test tab bars for drop target visual feedback. [D45, Rule 4]
        const cx = latestDragPointer.current.x;
        const cy = latestDragPointer.current.y;
        let found: HTMLElement | null = null;
        for (const entry of dragTabBarCache.current) {
          const r = entry.rect;
          if (cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom) {
            found = entry.el;
            break;
          }
        }
        setDragDropTarget(found);
      }

      // === POINTER HANDLERS ===
      function onPointerMove(e: PointerEvent) {
        previousDragPointer.current = {
          ...latestDragPointer.current,
          at: e.timeStamp,
        };
        latestDragPointer.current = { x: e.clientX, y: e.clientY };
        latestAltKey.current = e.altKey;
        latestMetaKey.current = e.metaKey;
        if (dragRafId.current === null) {
          dragRafId.current = requestAnimationFrame(applyDragFrame);
        }
      }

      /**
       * Take the gesture's listeners off and stop its clock — everything an
       * ending has to do whatever kind of ending it is.
       *
       * Shared by the drop and the two cancels so they cannot drift: a cancel
       * path that forgot one listener would leave a dead gesture answering the
       * pointer, which is the failure mode that makes cancel paths worth
       * writing at all.
       */
      function endGestureListeners(pointerId: number | null): void {
        dragActive.current = false;
        if (dragRafId.current !== null) {
          cancelAnimationFrame(dragRafId.current);
          dragRafId.current = null;
        }
        frame.removeEventListener("pointermove", onPointerMove);
        frame.removeEventListener("pointerup", onPointerUp);
        frame.removeEventListener("pointercancel", onPointerCancel);
        window.removeEventListener("keydown", onGestureKeyDown, true);
        window.removeEventListener("keyup", onGestureKeyUp, true);
        if (pointerId !== null && frame.hasPointerCapture(pointerId)) {
          frame.releasePointerCapture(pointerId);
        }
      }

      /**
       * End the gesture with nothing committed: the card goes home, the
       * indication goes away, and the arrangement is exactly what it was.
       *
       * Both cancel paths land here — Escape and `pointercancel` (a system
       * gesture or a scroll takeover claiming the pointer). Neither existed
       * before this: the pane drag registered `pointermove` and `pointerup` and
       * nothing else, so an interrupted gesture left `data-gesture`, the
       * occlusion bracket, and any preview transforms behind it.
       *
       * One unwind covers every drag in the deck, which is what unifying rails
       * onto the engine bought ([P11]): there is no second drag grammar left
       * with its own preview state for a cancel to have to know about.
       */
      function cancelDrag(pointerId: number | null): void {
        if (!dragActive.current) return;
        endGestureListeners(pointerId);

        zoneDragRef.current = null;
        dropZonesRef.current?.indicate(null);
        dropZonesRef.current?.gaugeDragFrame(null);
        // A cancel takes back the MOVE, not the view. The strip the hand
        // scrolled to is where the user is now looking, and rewinding it would
        // undo something they did not ask to undo.
        commitAutoscroll();

        frame.style.transform = "";
        frame.removeAttribute("data-gesture");
        frame.removeAttribute("data-pointer-owned");
        bodyFrameLanded(frame);
        clearGuideElements(dragGuideEls);
        setDragDropTarget(null);
        for (const entry of dragTabBarCache.current) {
          entry.el.removeAttribute("data-card-drag-target");
        }
        dragTabBarCache.current = [];

        // The bracket is only open if the gesture ever latched into a move.
        if (dragMoved.current) paneOcclusionGesture.end();

        dragMoved.current = false;
        dragStartedWithMeta.current = false;
        dragOtherRects.current = [];
        latestAltKey.current = false;
        latestMetaKey.current = false;
        lastSnapResult.current = null;
      }

      /**
       * Escape cancels, and the key goes no further.
       *
       * Capture phase and `stopImmediatePropagation` because the Cards card's
       * `CANCEL_DIALOG` responder is also listening for Escape, and a cancelled
       * drag that additionally collapsed that card's selection would be one
       * keypress doing two unrelated things. `card-drag-coordinator.ts` swallows
       * it the same way for the tab drag, and `tugways/block-reorder.ts`'s comment
       * names this gesture as the same case.
       */
      function onGestureKeyDown(e: KeyboardEvent) {
        if (!dragActive.current) return;
        latestMetaKey.current = e.metaKey;
        if (e.key !== "Escape") {
          scheduleDragFrame();
          return;
        }
        e.preventDefault();
        e.stopImmediatePropagation();
        cancelDrag(null);
      }

      // ⌘ is read on its own edges as well as the pointer's, so letting go of
      // it brings the indication back without waiting for the hand to move.
      function onGestureKeyUp(e: KeyboardEvent) {
        if (!dragActive.current) return;
        latestMetaKey.current = e.metaKey;
        scheduleDragFrame();
      }

      function onPointerCancel(e: PointerEvent) {
        cancelDrag(e.pointerId);
      }

      function scheduleDragFrame(): void {
        if (dragRafId.current === null) {
          dragRafId.current = requestAnimationFrame(applyDragFrame);
        }
      }

      // === PHASE 3: DROP ===
      // Pointer released. Commit final position to store, handle merge,
      // clean up listeners and reset all drag state.
      /**
       * One pointer-up is one gesture, so it is one store notification.
       *
       * A release does several mutations — `commitAutoscroll` writes every
       * strip the drag scrolled, the zone commit moves the pane, and
       * `movePaneToSlot` raises the arriving card on its way through
       * `transferFocusForActivation`. Left unbatched, each of those told
       * the canvas separately, and the canvas arms its settle once per
       * telling: an autoscrolled release armed twice, and a cross-slot drop
       * notified three times. The card is making ONE journey, so the deck
       * hears about it once, at the end, over the final arrangement.
       *
       * The batch also makes the landing's First measurement safer than it
       * was: `pendingZoneDropRef`'s `from` rect is read while the old
       * arrangement is still on screen, and now nothing can have rendered
       * between the commit and the read.
       */
      function onPointerUp(e: PointerEvent) {
        store.batchGesture(() => endPaneDrag(e));
      }

      function endPaneDrag(e: PointerEvent) {
        if (!dragActive.current) return;
        endGestureListeners(e.pointerId);

        // Re-enable height transition now that the drag gesture is complete. [D07]
        //
        // A gesture that ENDS on a zone keeps the attribute a little longer:
        // the commit below arms a settle, and the settle must skip this frame —
        // it already rests at its final visual position, and both of the
        // settle's passes would measure it through the inline transform that
        // puts it there. The choice is made on how the gesture ENDS, never on
        // how it latched: a ⌘-freed drop is a free drag by then and drops its
        // attribute exactly where every other drag does.
        const zoneState = zoneDragRef.current;
        // ⌘ at the release is what frees the card ([P13]), and the conversion
        // to free pixels happens below rather than the moment the key went
        // down: the key is readable up to the last instant, so deciding earlier
        // would make a modifier tapped and released mid-drag irreversible.
        const zoneDrop = latestMetaKey.current ? null : zoneState;
        zoneDragRef.current = null;
        dropZonesRef.current?.indicate(null);
        dropZonesRef.current?.gaugeDragFrame(null);
        // Ahead of the zone commit below, so the settle that animates the
        // landing is the arrangement change's rather than the offset's. This
        // one moves no frame: CSS has been drawing the number all along.
        commitAutoscroll();
        if (zoneDrop === null) {
          frame.removeAttribute("data-gesture");
          frame.removeAttribute("data-pointer-owned");
        }

        // Remove snap guides immediately on drop. [D03]
        // Must happen before any early return (e.g. merge) to prevent guide leaks.
        clearGuideElements(dragGuideEls);

        // Clear drop target highlight before committing. [D45, Rule 4]
        setDragDropTarget(null);
        // Belt-and-suspenders: clear attribute on all cached bar elements.
        for (const entry of dragTabBarCache.current) {
          entry.el.removeAttribute("data-card-drag-target");
        }

        // How the gesture ends is read off the release, by the same decision
        // a host-tracked drag ends by (`card-gesture-commit.ts`). The DOM work
        // below — the frame's transform, the landing, the tab-bar insert
        // index — is this pane's alone.
        const outcome = dragOutcomeOf({
          moved: dragMoved.current,
          startedWithMeta: dragStartedWithMeta.current,
          metaAtRelease: latestMetaKey.current,
          zone: zoneState,
          pointer: pointerOnCanvas({ x: e.clientX, y: e.clientY }),
        });

        // The pointer never travelled, so this was a click on the title bar.
        // Nothing was moved, nothing merges, and nothing is committed — in
        // particular a derived pane keeps the slot or the pin it started with.
        if (outcome.kind === "click") {
          // ...and if it was a Cmd-click, that click means "show me what is
          // behind this pane". The same handle the ⌘R chord calls, so there is
          // one opener with several callers rather than several openers. The
          // gesture interpreter's own meta branch already suppressed
          // activation for this press, which is exactly right: the picker
          // opens without raising the pane it was clicked on.
          if (outcome.revealStack) {
            titleBarRef.current?.revealStack();
          }
          dragStartedWithMeta.current = false;
          dragOtherRects.current = [];
          latestAltKey.current = false;
          lastSnapResult.current = null;
          return;
        }
        dragStartedWithMeta.current = false;

        // Close the occlusion bracket opened at the move latch; the commit
        // below (or the merge's store mutation) recomputes from final
        // geometry through the controller's store subscription.
        paneOcclusionGesture.end();

        // A zone drop lands where the indicator said it would.
        //
        // The frame keeps its drag transform and `data-gesture` across the
        // commit, and `landZoneDrop` carries it from there into the place the
        // commit gave it. The settle skips it for that whole crossing, which is
        // the division of labour: the settle carries every OTHER frame the
        // commit moved, and this one is being carried by its own landing. That
        // is what makes a drop an arrangement change rather than a jump.
        //
        // A refusal is an outcome, not a silence ([P09]). The frame goes home,
        // the pane flashes, and nothing is left hanging at a zone that never
        // took it.
        if (outcome.kind !== "free") {
          if (outcome.kind === "zone-merge") {
            // The one zone whose commit was already written: the merge keeps
            // its own insert index and its own verb ([P10]).
            const barEl = tabBarElementOf(outcome.zone.paneId);
            if (onCardMerged && activeCardId && barEl !== null) {
              frame.style.transform = "";
              frame.removeAttribute("data-gesture");
              frame.removeAttribute("data-pointer-owned");
              onCardMerged(id, outcome.zone.paneId, computeMergeInsertIndex(barEl, e.clientX));
              dragTabBarCache.current = [];
              dragOtherRects.current = [];
              latestAltKey.current = false;
              latestMetaKey.current = false;
              lastSnapResult.current = null;
              return;
            }
          }
          // The landing mark goes on BEFORE the commit, so the reveal the
          // commit schedules waits for the landing as well as for the settle.
          // Every path below lands — a taken drop on the commit's render, a
          // drop onto its own place inline, a refusal inline — and the
          // landing clears it on every path out.
          const landingCardId = activeCardIdRef.current ?? id;
          const committed =
            outcome.kind === "zone-home"
              ? (store.noteCardWillLand(landingCardId), false)
              : commitZoneDrop(store, dropZonesRef.current ?? null, id, landingCardId, outcome.zone);
          // The release rect, measured while the old arrangement is still the
          // one on screen: this is where the frame visually is, and the
          // landing has to start there whatever the commit does next.
          pendingZoneDropRef.current = {
            el: frame,
            from: frame.getBoundingClientRect(),
            cardId: landingCardId,
            releaseVelocity: releaseVelocity(e),
          };
          if (committed) {
            // A drop onto the card's own position commits nothing, so nothing
            // renders and the layout effect never runs. It is still a drop, and
            // it still animates ([P09]) — landed here, inline, rather than left
            // waiting on a commit that is not coming.
            if (outcome.kind === "zone" && outcome.onOrigin) {
              landZoneDrop();
            }
          } else {
            // Home is a place too. A refused release animates back by the same
            // landing a taken one animates in by, so the gesture ends in motion
            // either way and the flash says which of the two it was.
            landZoneDrop();
            flashCardPane(store, activeCardIdRef.current ?? id);
          }
          dragTabBarCache.current = [];
          dragOtherRects.current = [];
          latestAltKey.current = false;
          latestMetaKey.current = false;
          lastSnapResult.current = null;
          return;
        }

        // ⌘ frees the card ([P13]). The transform that carried it becomes its
        // free geometry here, in this order — `releaseImposedFrame` measures a
        // transform-inclusive rect and does not clear the transform, so banking
        // the offset into `left`/`top` and leaving the translate on top of it
        // would double the frame's travel, exactly as it would at the rail
        // corridor's exit.
        if (outcome.freedFromZone) {
          const released = releaseImposedFrame(frame, dragCanvasBounds.current);
          frame.style.transform = "";
          dragStartPosition.current = { x: released.x, y: released.y };
        }

        // Hit-test tab bars for merge on drop. [D45]
        let mergeTarget: { paneId: string; insertIndex: number } | null = null;
        if (onCardMerged && activeCardId) {
          const cx = e.clientX;
          const cy = e.clientY;
          for (const entry of dragTabBarCache.current) {
            const r = entry.rect;
            if (cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom) {
              mergeTarget = { paneId: entry.paneId, insertIndex: computeMergeInsertIndex(entry.el, cx) };
              break;
            }
          }
        }
        dragTabBarCache.current = [];

        const drop = freeDropOutcomeOf({
          mergeTarget,
          // The final clamped position; the snap the last frame computed with
          // Option held, if any, wins on its axis.
          position: clampedPosition(
            { x: e.clientX, y: e.clientY },
            dragStartPointer.current,
            dragStartPosition.current,
            dragCanvasBounds.current,
            { width: frame.offsetWidth, height: frame.offsetHeight },
            dragZoom,
          ),
          snap: lastSnapResult.current,
          size: { width: frame.offsetWidth, height: frame.offsetHeight },
          // A dragged pane leaves its slot: the explicit gesture wins, and the
          // dropped rect becomes its free geometry. Resize never passes this.
          derived: derivedRef.current,
        });

        if (drop.kind === "merge") {
          onCardMerged?.(id, drop.targetPaneId, drop.insertIndex);
        } else {
          frame.style.left = `${drop.position.x}px`;
          frame.style.top = `${drop.position.y}px`;
          bodyFrameLanded(frame);
          commitFreeMove(onCardMoved, id, drop);
        }

        // Reset all drag state.
        dragOtherRects.current = [];
        latestAltKey.current = false;
        lastSnapResult.current = null;
      }

      frame.addEventListener("pointermove", onPointerMove);
      frame.addEventListener("pointerup", onPointerUp);
      // The two endings the pane drag never had (Spec S03).
      //
      // On WINDOW, in capture, and that is not interchangeable with `document`.
      // The responder chain's own key listener is a window-capture listener
      // (`responder-chain-provider.tsx`), and capture descends outward-in — so
      // a document-capture listener runs AFTER it and never sees a key the
      // chain stopped. `tugways/block-reorder.ts` and `card-drag-coordinator.ts`
      // register their drags' Escape the same way, for the same reason — the
      // tab drag's sat on `document` once, and the chain's act-dispatch stage
      // swallowed its Escape, so an aborted tab drag committed on release.
      frame.addEventListener("pointercancel", onPointerCancel);
      window.addEventListener("keydown", onGestureKeyDown, true);
      window.addEventListener("keyup", onGestureKeyUp, true);
    },
    // position.x/y captured into dragStartPosition at drag-start; id, onCardMoved,
    // onCardMerged, activeCardId, and store are stable or handled via closure capture.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- drag-start values, per the note above
    [id, onCardMoved, onCardMerged, activeCardId, position.x, position.y, store],
  );

  // ---------------------------------------------------------------------------
  // Resize system
  //
  // Same three-phase pattern as drag: snapshot at start, rAF frame updates,
  // commit on pointer-up. Supports 8 edge/corner handles, min-size clamping,
  // and snap-to-edge.
  // ---------------------------------------------------------------------------

  // Snap guide DOM elements for resize (separate from drag guides). [D03]
  const resizeGuideEls = useRef<HTMLElement[]>([]);

  const handleResizeStart = useCallback(
    (edge: ResizeEdge, event: React.PointerEvent) => {
      // Pane activation (including the metaKey-held no-activate
      // nuance) is handled by `pane-focus-controller.ts`'s
      // document-level capture-phase pointerdown listener, which
      // fires before this handler. No per-handle activation call
      // is needed.
      event.stopPropagation();

      if (!frameRef.current) return;
      const frame: HTMLDivElement = frameRef.current!;

      // A slot-keeping width resize: the frame stays imposed, and the dragged
      // edge is solved against the imposer's own rule so it stays under the
      // pointer and the frames the gesture draws are the ones the commit
      // draws. Resolved here, before anything is captured, because an edge the
      // arrangement pins is not a handle at all — the render withholds it, and
      // this refuses the one case the render cannot see: a fit card wider than
      // the band, whose left edge stands at the band's start.
      const keepSlot = keepSlotResizeRef.current;
      // A split member's inner top or bottom edge is the seam it borders, and
      // the press is handed to the seam's own drag — nothing of this machine
      // runs, so nothing here captures the pointer or writes the frame.
      if (keepSlot?.column !== undefined && (edge === "n" || edge === "s")) {
        const { slot, index } = keepSlot.column;
        startColumnSeamDrag(
          slot,
          edge === "n" ? index - 1 : index,
          event.nativeEvent.pointerId,
          event.clientY,
        );
        return;
      }
      let keepSlotDrag: {
        side: "left" | "right";
        fraction: number;
        bandStart: number;
        bandWidth: number;
        startEdgeX: number;
        imposedLeft: (width: number) => string;
      } | null = null;
      // The flow half: the deck as it stood at pointer-down, which the strip
      // is re-asked against at every frame; every slotted frame and the `left`
      // React gave it, so a slot the drag moves is moved from its own pin and
      // a slot it leaves is handed straight back; and the element carrying the
      // strip's length, which every frame's offset clamp reads.
      let flowKeepSlotDrag: {
        startWidth: number;
        state: DeckState;
        frames: Map<string, { el: HTMLElement; left: string }>;
        stripHost: HTMLElement | null;
      } | null = null;
      // The height half: a card alone or stacked in its slot, whose bottom
      // edge sets the height it stands at from the top of its run. Measured
      // here, once — the run by laying the frame out at its fill pins for one
      // read, the start by its own.
      let heightKeepSlotDrag: {
        style: KeepSlotHeightStyle;
        runHeight: number;
        startHeight: number;
      } | null = null;
      if (keepSlot?.heightStyle !== undefined && edge === "s") {
        const saved = {
          top: frame.style.top,
          bottom: frame.style.bottom,
          height: frame.style.height,
          maxHeight: frame.style.maxHeight,
        };
        writeHeightPins(frame, keepSlot.heightStyle(undefined));
        const runHeight = frame.offsetHeight;
        writeHeightPins(frame, saved);
        heightKeepSlotDrag = {
          style: keepSlot.heightStyle,
          runHeight,
          startHeight: frame.offsetHeight,
        };
      } else if (keepSlot !== null && keepSlot.layout === "flow") {
        if (edge !== "e") return;
        const state = store.getSnapshot();
        const canvas = paneCanvasOf(frame);
        const frames = new Map<string, { el: HTMLElement; left: string }>();
        for (const pane of state.panes) {
          if (pane.slot === undefined) continue;
          const el =
            pane.id === id
              ? frame
              : canvas?.querySelector<HTMLElement>(
                  `.tug-pane[data-pane-id="${CSS.escape(pane.id)}"]`,
                );
          if (el) frames.set(pane.id, { el, left: el.style.left });
        }
        let stripHost = frame.parentElement;
        while (
          stripHost !== null &&
          stripHost.style.getPropertyValue(FLOW_STRIP_PROPERTY) === ""
        ) {
          stripHost = stripHost.parentElement;
        }
        flowKeepSlotDrag = {
          startWidth: keepSlot.width,
          state,
          frames,
          stripHost,
        };
      } else if (keepSlot !== null) {
        const side = edge === "e" ? "right" : edge === "w" ? "left" : null;
        const band = store.getBandEdges();
        if (side === null || band === null) return;
        const bandWidth = band.end - band.start;
        if (fitEdgeRate(side, keepSlot.fraction, bandWidth, keepSlot.width) === 0) {
          return;
        }
        const startLeftX = fitImposedLeft(
          keepSlot.fraction,
          band.start,
          bandWidth,
          keepSlot.width,
        );
        keepSlotDrag = {
          side,
          fraction: keepSlot.fraction,
          bandStart: band.start,
          bandWidth,
          startEdgeX: side === "left" ? startLeftX : startLeftX + keepSlot.width,
          imposedLeft: keepSlot.imposedLeft,
        };
      }

      frame.setPointerCapture(event.nativeEvent.pointerId);

      // Disable height transition during resize. [D07, chrome.css]
      frame.setAttribute("data-gesture", "true");

      // Hold the reader's place across the drag. Opened at pointer-down
      // rather than at the move latch, because this is the last moment
      // the pre-gesture layout is on screen — a gesture that turns out to
      // be a click closes it having changed nothing.
      const scrollEpisode = beginResizeEpisode(frame, GESTURE_EPISODE_WINDOW_MS);

      const startX = event.clientX;
      const startY = event.clientY;

      // Snapshot canvas bounds and other card rects for resize snapping. [D04]
      // Snap geometry runs in layout space; divide visual measurements by zoom.
      const resizeZoom = pageZoomFactor();
      const resizeGuideEdgeOffsets = measureGuideEdgeOffsets(frame, resizeZoom);
      const resizeCanvasBounds =
        paneCanvasOf(frame)?.getBoundingClientRect() ?? null;

      // A resize that does not keep the slot releases an imposed pane from
      // it, exactly as dragging does — and on the same terms: only once the
      // pointer has travelled far enough for the gesture to be a resize
      // rather than a click. Until the
      // latch below sets, nothing here has written to the frame, so the
      // release's measurement at latch time sees the same rect it would have
      // seen at pointer-down.
      let resizeMoved = false;
      let released: { x: number; y: number; width: number; height: number } | null = null;
      let startLeft = position.x;
      let startTop = position.y;
      let startW = size.width;
      let startH = size.height;
      const resizeOtherCardRects = snapshotCardRects(resizeCanvasBounds, id, resizeZoom);
      const resizeOtherRects = resizeOtherCardRects.map((r) => r.rect);

      const latestResizePointer = { x: startX, y: startY };
      let latestResizeModifier = event.nativeEvent.altKey;
      let resizeRafId: number | null = null;
      let resizeActive = true;

      /**
       * Answer whether the gesture has become a resize, latching it the first
       * time the pointer travels past the threshold. A derived pane converts to
       * free pixel geometry at that moment, and the machine re-seeds from the
       * measurement rather than from stale stored geometry.
       */
      function latchResizeMove(pointer: { x: number; y: number }): boolean {
        if (resizeMoved) return true;
        const travelled = Math.hypot(pointer.x - startX, pointer.y - startY);
        if (travelled < DRAG_MOVE_THRESHOLD_PX) return false;
        resizeMoved = true;
        // The resize owns the frame from here; a settle carrying it lets go.
        takeFrameFromSettle(frame);
        frame.setAttribute("data-pointer-owned", "true");
        // A shrinking edge exposes what this frame was covering, without a
        // store commit; reveal occluded panes now and hold hides until the
        // gesture ends.
        paneOcclusionGesture.begin();
        // A slot-keeping resize leaves the frame imposed: its pins stand, and
        // only `left` and `width` are written while the hand holds it.
        if (
          derivedRef.current &&
          keepSlotDrag === null &&
          flowKeepSlotDrag === null &&
          heightKeepSlotDrag === null
        ) {
          const frozen = releaseImposedFrame(frame, resizeCanvasBounds);
          released = frozen;
          startLeft = frozen.x;
          startTop = frozen.y;
          startW = frozen.width;
          startH = frozen.height;
        }
        return true;
      }

      function computeAndApplyResize(pointer: { x: number; y: number }, snapModifier: boolean): {
        left: number; top: number; width: number; height: number;
      } {
        const r = resizeDelta(
          pointer,
          { x: startX, y: startY },
          startLeft,
          startTop,
          startW,
          startH,
          edge,
          minSizeRef.current,
          resizeCanvasBounds,
          maxSizeRef.current,
          resizeZoom,
        );

        // Apply snap-to-edge if modifier is held. [D01]
        if (snapModifier) {
          // Build the set of edges being actively resized (absolute canvas coords).
          const resizingEdges: { top?: number; bottom?: number; left?: number; right?: number } =
            {};
          if (edge.includes("n")) resizingEdges.top = r.top;
          if (edge.includes("s")) resizingEdges.bottom = r.top + r.height;
          if (edge.includes("w")) resizingEdges.left = r.left;
          if (edge.includes("e")) resizingEdges.right = r.left + r.width;

          // Pass borderWidth=1 so adjacent-edge resize snaps overlap by 1px for border collapse. [D56]
          const snapResult = computeResizeSnap(resizingEdges, resizeOtherRects, -IMPOSITION_GAP_PX);

          // Apply snapped values back to the rect, clamped to minSize.
          let { left, top, width, height } = r;
          if (snapResult.left !== undefined) {
            const newW = Math.max(minSizeRef.current.width, left + width - snapResult.left);
            left = left + width - newW;
            width = newW;
          }
          if (snapResult.right !== undefined) {
            width = Math.max(minSizeRef.current.width, snapResult.right - left);
          }
          if (snapResult.top !== undefined) {
            const newH = Math.max(minSizeRef.current.height, top + height - snapResult.top);
            top = top + height - newH;
            height = newH;
          }
          if (snapResult.bottom !== undefined) {
            height = Math.max(minSizeRef.current.height, snapResult.bottom - top);
          }

          // Render resize snap guides. [D03]
          const container = paneCanvasOf(frame);
          if (container) {
            syncGuideElements(resizeGuideEls, snapResult.guides, container, resizeGuideEdgeOffsets);
          }

          return { left, top, width, height };
        } else {
          clearGuideElements(resizeGuideEls);
          return r;
        }
      }

      /**
       * The width that puts the dragged edge under `pointer`, in the slot. No
       * snap: ⌥ snaps a free rect to its neighbours, and a slotted card's
       * edges are the arrangement's, not the hand's to align.
       */
      function keepSlotWidth(pointer: { x: number; y: number }): number {
        const drag = keepSlotDrag!;
        return fitWidthForEdge(
          drag.side,
          drag.startEdgeX + (pointer.x - startX) / resizeZoom,
          drag.fraction,
          drag.bandStart,
          drag.bandWidth,
          minSizeRef.current.width,
          maxSizeRef.current?.width ?? Infinity,
        );
      }

      /**
       * The slot height under `pointer`: the bottom edge one for one with the
       * hand, the top standing at the run's, inside the card's floor and the
       * run. The run is the ceiling — a card cannot stand taller than the
       * slot it stands in — and reaching it is the clear ([B04b]).
       */
      function slotDragHeight(pointer: { x: number; y: number }): number {
        const drag = heightKeepSlotDrag!;
        return Math.min(
          drag.runHeight,
          Math.max(
            minSizeRef.current.height,
            drag.startHeight + (pointer.y - startY) / resizeZoom,
          ),
        );
      }

      /**
       * The flow width under `pointer`: the right edge one for one with the
       * hand, inside the card's bounds. The left edge never moves, so the
       * width is the start width plus the travel.
       */
      function flowKeepSlotWidth(pointer: { x: number; y: number }): number {
        const drag = flowKeepSlotDrag!;
        return Math.min(
          maxSizeRef.current?.width ?? Infinity,
          Math.max(
            minSizeRef.current.width,
            drag.startWidth + (pointer.x - startX) / resizeZoom,
          ),
        );
      }

      /**
       * Draw the flow deck at width `w`: this frame's width, every slot the
       * strip moves shifted from its own pin by the strip's own answer, every
       * slot it does not handed back its pin, and the strip's length where the
       * offset clamps read it. The strip is the canvas's own, so the commit
       * re-lays out exactly this.
       */
      function applyFlowKeepSlot(w: number): void {
        const drag = flowKeepSlotDrag!;
        const strip = flowResizeShift(drag.state, id, w);
        frame.style.width = `${w}px`;
        if (strip === null) return;
        for (const [paneId, { el, left }] of drag.frames) {
          const dx = strip.shifts.get(paneId) ?? 0;
          el.style.left = dx === 0 ? left : `calc(${left} + ${dx}px)`;
        }
        drag.stripHost?.style.setProperty(
          FLOW_STRIP_PROPERTY,
          `${strip.stripWidth}px`,
        );
      }

      function applyResizeFrame() {
        resizeRafId = null;
        if (!resizeActive) return;
        if (!latchResizeMove(latestResizePointer)) return;
        if (heightKeepSlotDrag !== null) {
          frame.style.bottom = "auto";
          frame.style.maxHeight = "";
          frame.style.height = `${slotDragHeight(latestResizePointer)}px`;
          return;
        }
        if (flowKeepSlotDrag !== null) {
          applyFlowKeepSlot(flowKeepSlotWidth(latestResizePointer));
          return;
        }
        if (keepSlotDrag !== null) {
          const w = keepSlotWidth(latestResizePointer);
          frame.style.left = `${fitImposedLeft(keepSlotDrag.fraction, keepSlotDrag.bandStart, keepSlotDrag.bandWidth, w)}px`;
          frame.style.width = `${w}px`;
          return;
        }
        const r = computeAndApplyResize(latestResizePointer, latestResizeModifier);
        frame.style.left = `${r.left}px`;
        frame.style.top = `${r.top}px`;
        frame.style.width = `${r.width}px`;
        frame.style.height = `${r.height}px`;
      }

      function onPointerMove(e: PointerEvent) {
        latestResizePointer.x = e.clientX;
        latestResizePointer.y = e.clientY;
        latestResizeModifier = e.altKey;
        if (resizeRafId === null) {
          resizeRafId = requestAnimationFrame(applyResizeFrame);
        }
      }

      function onPointerUp(e: PointerEvent) {
        if (!resizeActive) return;
        resizeActive = false;
        if (resizeRafId !== null) {
          cancelAnimationFrame(resizeRafId);
          resizeRafId = null;
        }
        frame.removeEventListener("pointermove", onPointerMove);
        frame.removeEventListener("pointerup", onPointerUp);
        frame.releasePointerCapture(e.pointerId);

        // Re-enable height transition now that the resize gesture is complete. [D07]
        frame.removeAttribute("data-gesture");
        frame.removeAttribute("data-pointer-owned");

        // The pointer never travelled, so this was a click on a resize handle.
        // Nothing was resized and nothing is committed — in particular a
        // derived pane keeps the slot or the pin it started with. The handles
        // overhang the frame into the imposition gap, so a stray click on the
        // seam between two imposed cards is easy to make; committing here
        // would evict a card from its slot at a pixel-identical rect, and the
        // arrangement would only visibly break at the next canvas change.
        if (!latchResizeMove({ x: e.clientX, y: e.clientY })) {
          clearGuideElements(resizeGuideEls);
          scrollEpisode.end();
          return;
        }

        // Close the occlusion bracket opened at the move latch.
        paneOcclusionGesture.end();

        if (heightKeepSlotDrag !== null) {
          // Dragged to the run's end, the card fills its run again and the
          // field is deleted ([B04b]); short of it, the height is written.
          // Either way the frame is handed back wearing the pins React is
          // about to render, so the commit moves nothing.
          const next = slotHeightAfterDrag(
            slotDragHeight({ x: e.clientX, y: e.clientY }),
            heightKeepSlotDrag.runHeight,
          );
          writeHeightPins(frame, heightKeepSlotDrag.style(next ?? undefined));
          commitResizeEnd(onCardMoved, id, { position, size }, { kind: "height", slotHeight: next });
          scrollEpisode.end();
          return;
        }

        if (flowKeepSlotDrag !== null) {
          // The strip at the final width is the strip the commit lays out, so
          // every frame already stands where React is about to pin it; a
          // moved slot's `left` is overwritten by the render that moves its
          // strip place, and an unmoved one already wears its own pin.
          const w = flowKeepSlotWidth({ x: e.clientX, y: e.clientY });
          applyFlowKeepSlot(w);
          commitResizeEnd(onCardMoved, id, { position, size }, { kind: "width", width: w });
          scrollEpisode.end();
          return;
        }

        if (keepSlotDrag !== null) {
          // Hand the frame back to its slot wearing the pin React is about to
          // render for this width, so the commit moves nothing — the card is
          // already where the imposer puts it ([B04]).
          const w = keepSlotWidth({ x: e.clientX, y: e.clientY });
          frame.style.left = keepSlotDrag.imposedLeft(w);
          frame.style.width = `${w}px`;
          // The width menu's commit: a raw width, no eviction, one write and
          // no rail retune ([B03]). Position and height are the stored ones,
          // which an imposed frame does not read.
          commitResizeEnd(onCardMoved, id, { position, size }, { kind: "width", width: w });
          scrollEpisode.end();
          return;
        }

        // Compute final resize with snap applied first, THEN clear guides. [D03]
        const r = computeAndApplyResize({ x: e.clientX, y: e.clientY }, e.altKey);
        clearGuideElements(resizeGuideEls);
        frame.style.left = `${r.left}px`;
        frame.style.top = `${r.top}px`;
        frame.style.width = `${r.width}px`;
        frame.style.height = `${r.height}px`;

        // Under the "releases" rule a resized pane leaves its slot, on the
        // same footing as a dragged one.
        commitResizeEnd(onCardMoved, id, { position, size }, {
          kind: "free",
          rect: { x: r.left, y: r.top, width: r.width, height: r.height },
          evictSlot: released !== null,
        });

        // After the final geometry is written, so the last anchor lands
        // against the size the pane keeps.
        scrollEpisode.end();
      }

      frame.addEventListener("pointermove", onPointerMove);
      frame.addEventListener("pointerup", onPointerUp);
    },
    // minSizeRef.current is always current; position/size are start values read at resize-start.
    [id, onCardMoved, position.x, position.y, size.width, size.height, store],
  );

  // Deck-facing-edge resize for a pinned rail: the EMITTER half of the rail
  // width drag. The width is the RAIL's, not this pane's — same-side cards
  // share one rail — so everything the drag does to the deck is done by the
  // rail width draft `DeckCanvas` owns (`rail-width-draft.ts`): the bounds,
  // the snap, the live preview, its rollback, and the one `setRailWidth` that
  // commits every member of the side ([L10], [L32]). This handler translates
  // the pointer into that draft's four calls and writes nothing else: no
  // arrangement property, no canvas lookup, no clamp.
  //
  // What it does own is the press itself — the pointer capture, its own
  // listeners, and `data-gesture` on this frame — and it gives every one of
  // them back on every way out: a release, a `pointercancel`, a lost capture,
  // Escape, and the pane unmounting mid-drag. All but the release cancel the
  // draft, which puts the deck back where the record says it stands ([L08],
  // [L27]). Under the move threshold the press is a click: the draft is
  // cancelled having written nothing, and nothing commits.
  const railWidthGesture = useRailWidthGesture();
  const endRailWidthPressRef = useRef<(() => void) | null>(null);
  useLayoutEffect(() => () => endRailWidthPressRef.current?.(), []);
  const handleSidebarResizeStart = useCallback(
    (event: React.PointerEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const frame = frameRef.current;
      // The edge renders only on a mounted rail frame inside a deck that
      // provides the gesture, so none of these can be missing at a press. One
      // that is is a broken pane, and says so ([L31]).
      if (frame === null || sidebarSide === undefined || railWidthGesture === null) {
        throw new Error("rail edge pressed outside a mounted rail in a deck canvas");
      }
      endRailWidthPressRef.current?.();

      const pointerId = event.pointerId;
      const startClientX = event.clientX;
      let moved = false;
      const latch = (clientX: number): boolean => {
        if (!moved && Math.abs(clientX - startClientX) >= DRAG_MOVE_THRESHOLD_PX) {
          moved = true;
        }
        return moved;
      };

      // The listeners come off BEFORE the capture is released, so a release's
      // own `lostpointercapture` is not read as the system taking the pointer.
      // The press holds the keyboard in this page for its length: its Escape
      // listens on this `window`, and a body card holding the keyboard would
      // take the key into its own page, where nothing cancels the drag.
      let releaseKeyboard = (): void => {};
      const endPress = (): void => {
        endRailWidthPressRef.current = null;
        releaseKeyboard();
        frame.removeEventListener("pointermove", onPointerMove);
        frame.removeEventListener("pointerup", onPointerUp);
        frame.removeEventListener("pointercancel", onCancel);
        frame.removeEventListener("lostpointercapture", onCancel);
        window.removeEventListener("keydown", onKeyDown, true);
        frame.removeAttribute("data-gesture");
        if (frame.hasPointerCapture(pointerId)) frame.releasePointerCapture(pointerId);
      };
      const onPointerMove = (e: PointerEvent): void => {
        if (latch(e.clientX)) railWidthGesture.change(e.clientX, e.clientY, e.altKey);
      };
      const onPointerUp = (e: PointerEvent): void => {
        endPress();
        if (latch(e.clientX)) railWidthGesture.commit(e.clientX, e.altKey);
        else railWidthGesture.cancel();
      };
      const onCancel = (): void => {
        endPress();
        railWidthGesture.cancel();
      };
      const onKeyDown = (e: KeyboardEvent): void => {
        if (e.key !== "Escape") return;
        e.preventDefault();
        e.stopPropagation();
        onCancel();
      };

      // The draft opens before the press takes anything, so a draft that
      // refuses a broken deck throws with no capture, mark or listener left
      // holding the pointer over nothing ([L31]).
      railWidthGesture.begin({
        side: sidebarSide,
        frame,
        clientX: startClientX,
        clientY: event.clientY,
      });
      frame.setPointerCapture(pointerId);
      frame.setAttribute("data-gesture", "resize");
      frame.addEventListener("pointermove", onPointerMove);
      frame.addEventListener("pointerup", onPointerUp);
      frame.addEventListener("pointercancel", onCancel);
      frame.addEventListener("lostpointercapture", onCancel);
      window.addEventListener("keydown", onKeyDown, true);
      releaseKeyboard = holdShellKeyboard();
      endRailWidthPressRef.current = onCancel;
    },
    [sidebarSide, railWidthGesture],
  );

  // The same drag, pressed in a rail card's own page: the host tracks the
  // pointer and the shell's gesture handler drives the draft through this
  // driver, opened against this stand-in's frame (`rail-edge-registry.ts`).
  // The host owns the press and its Escape, so this owns only the frame's
  // `data-gesture` mark, and gives the draft back if the pane goes mid-drag.
  useLayoutEffect(() => {
    if (sidebarSide === undefined || railWidthGesture === null) return;
    let open = false;
    const end = (): void => {
      open = false;
      frameRef.current?.removeAttribute("data-gesture");
    };
    const release = registerRailEdgeDriver(id, {
      begin: (clientX, clientY) => {
        const frame = frameRef.current;
        if (frame === null) return;
        railWidthGesture.begin({ side: sidebarSide, frame, clientX, clientY });
        open = true;
        frame.setAttribute("data-gesture", "resize");
      },
      change: (clientX, clientY, altKey) => railWidthGesture.change(clientX, clientY, altKey),
      commit: (clientX, altKey) => {
        end();
        railWidthGesture.commit(clientX, altKey);
      },
      cancel: () => {
        end();
        railWidthGesture.cancel();
      },
    });
    return () => {
      release();
      if (open) {
        end();
        railWidthGesture.cancel();
      }
    };
  }, [id, sidebarSide, railWidthGesture]);


  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  // Persisted size can predate the current floor — a card kind
  // raised its policy `min`, or a wider sibling joined the stack, so
  // the stored width/height may sit below `minSize`. Clamp the
  // rendered frame up to the floor: the pane paints at its true
  // minimum immediately, and the next move or resize commits the
  // corrected size back to the store.
  const renderWidth = Math.max(size.width, minSize.width);
  // …and a CEILING as well as a floor, because the policy can now bound one
  // axis alone ([P04]). A folded pane's stored height is the open card's —
  // nothing rewrites it, and nothing should: showing the card again must put
  // it back at the size it was. So the ceiling is what makes a FREE folded
  // pane paint at its tier rather than at the 620px box it remembers. An
  // unbounded axis carries `Infinity`, where the clamp is a no-op.
  const frameHeight = Math.min(
    Math.max(size.height, minSize.height),
    sizePolicy.max?.height ?? Infinity,
  );

  // A card whose policy pins an axis — `min === max`, which is how a
  // registration says "exactly one correct size" — is PLACED by the imposition
  // rather than sized by it: no resize handle offers to change that dimension,
  // so the imposer must not change it either. The declaration is already in the
  // registry, so nothing new has to be declared to opt in. A policy with no
  // `max` is unbounded above and therefore never pinned.
  //
  // The pinned axes travel together into `imposeStyle`, which needs both to
  // separate the slot from the frame: the slot is an ordinary content card's
  // box, and the pinned card is centred inside it (see `PinnedFrame`).
  const widthPinned = sizePolicy.max?.width === sizePolicy.min.width;
  const heightPinned = sizePolicy.max?.height === sizePolicy.min.height;
  const pinnedFrame: PinnedFrame | undefined =
    widthPinned || heightPinned
      ? {
          ...(widthPinned ? { width: renderWidth } : {}),
          ...(heightPinned ? { height: frameHeight } : {}),
          // A folded card reads from the top of its slot; About floats in
          // the middle of one. Both are height-pinned, and this is the whole
          // of the difference ([P04]).
          ...(folded ? { anchor: "start" as const } : {}),
        }
      : undefined;
  // A width-pinned card's slot is the deck's content width, not its own — but
  // never narrower than the card, or the slot would sit inside the frame.
  const slotWidth =
    widthPinned && contentWidthPx !== undefined
      ? Math.max(contentWidthPx, renderWidth)
      : renderWidth;
  // The height a card's bottom edge gave it in its slot ([B06]). Read where
  // the card stands alone or stacked in its slot, and nowhere else: a split
  // column's heights are its shares, a height-pinned card's height is its
  // own, and a bullseye, a rail, or a newcomer not yet seated has no slot run
  // to stand in. Anchored at the top of the run, the way a folded card is — a
  // row in a wall — and never taller than the run, which a window made
  // shorter since the drag would otherwise push the card off its bottom.
  const slotHeightApplies =
    imposed &&
    placement !== undefined &&
    columnMember === undefined &&
    !heightPinned &&
    !bullseye &&
    sidebarSide === undefined &&
    arriving === undefined;
  const slotHeightStyle: KeepSlotHeightStyle | undefined =
    slotHeightApplies && placement !== undefined
      ? (height) => {
          const fill = imposeStyle(placement, slotWidth, pinnedFrame);
          const pins = (style: CSSProperties) => ({
            top: style.top,
            bottom: style.bottom,
            height: style.height,
            maxHeight: style.maxHeight,
          });
          if (height === undefined) return pins(fill);
          return pins({
            ...imposeStyle(placement, slotWidth, {
              ...pinnedFrame,
              height,
              anchor: "start",
            }),
            maxHeight: `calc(100% - ${cssLength(fill.top)} - ${cssLength(fill.bottom)})`,
          });
        }
      : undefined;
  const heldSlotHeight = slotHeightApplies ? stackState.slotHeight : undefined;
  // Bullseye's width is `comfy`, held between the stack's own bounds by the
  // same `resolveContentWidthPx` call the width doors make — not a fourth
  // number and not a second opinion about width ([D130]).
  const bullseyeWidth = resolveContentWidthPx(
    DEFAULT_CONTENT_WIDTH,
    sizePolicy.min.width,
    sizePolicy.max?.width,
  );

  // The width control, on content-role panes only: a rail takes its width from
  // the allocator, so a preset there would be overwritten by the next solve.
  // Dispatched as a command rather than called on the store ([L30]).
  const handleSetWidth = useCallback(
    (preset: ContentWidth) => setPaneWidth(id, preset),
    [id],
  );

  // The Fill Height row's act: the pane-addressed command, as the width rows
  // take theirs ([L30]).
  const handleFillHeight = useCallback(() => fillPaneHeight(id), [id]);

  // The target button's act, on the same path the width control takes: the
  // pane-addressed command, naming this pane rather than "the pane I am in"
  // ([L30]). The press lands after the title bar's own activation, so by the
  // time the command runs this pane is the selection and the derived accessor
  // can read the posture back.
  const handleToggleBullseye = useCallback(() => togglePaneBullseye(id), [id]);

  // The arrange verbs the stack badge offers, on the same path the width
  // control takes: dispatched as registered commands rather than threaded back
  // through `DeckCanvas` as two more props ([L30]). The title bar keeps
  // rendering from props alone and the pane owns the dispatch.
  //
  // Only a COLUMN has them. A rail is always divided and its sashes are the
  // hand's ([B01], [B03]), so its badge offers its members and nothing else.
  // The slot is read at press time through a ref, so the callback is one
  // identity for the pane's life. Keyed on the placement it was a new title
  // bar prop on every pane at every activation and close; keyed on the slot it
  // still was one on every pane a slot move re-seated, and the bar body — its
  // buttons, tooltips and poppers — re-rendered inside the gesture's set-up to
  // hand the badge a verb it had not been pressed with.
  const placementSlotRef = useRef(placement?.slot);
  placementSlotRef.current = placement?.slot;
  const handleArrangePlace = useCallback(
    (verb: "split" | "stack" | "equalize") => {
      const slot = placementSlotRef.current;
      if (slot === undefined) return;
      arrangePlace(slot, verb);
    },
    [],
  );

  const closable = paneClosableOf(effectiveMeta);

  // Pane-close confirmation policy. Multi-card panes always confirm —
  // closing the pane discards every hosted tab at once, so the guard is
  // unconditional. Single-card panes follow the active card's opt-in
  // (`confirmClose: true` in its registration). Defaults to no
  // confirm for single-card panes whose card type doesn't opt in.
  //
  // A SIDEBAR card confirms too, whatever its registration says, and for a
  // reason no card type can state about itself: a rail card is a singleton
  // the deck keeps ONE of, so closing it is not "close this pane" but "put
  // this tool away" — and the X sits inches from the rail's resize edge and
  // its stack badge, on a bar the reader is already pointing at for other
  // reasons. It is the pane most likely to be shut by a stray click and the
  // one whose closing is least visible afterwards. Rail-ness follows the
  // active card's `layoutRole`, so a rail card released from its pin still
  // asks (`isRail`) — it is the same tool wherever it stands.
  const paneConfirmClose = paneConfirmsCloseOf({
    cardCount: cards?.length ?? 1,
    meta: effectiveMeta,
    isRail,
  });

  // …unless the one card in a single-card pane says it is holding nothing
  // (an empty Session card). Resolved at close time, not here: the card
  // fills up without the pane re-rendering. A multi-card pane keeps its
  // guard unconditionally — that one is about discarding N tabs at once.
  const soleCardId = (cards?.length ?? 1) > 1 ? null : (cards?.[0]?.id ?? activeCardId);
  const resolveCloseAdvice = useCallback(
    (): CardCloseAdvice | null =>
      soleCardId === null ? null : readCardCloseAdvice(soleCardId),
    [soleCardId],
  );

  const rootRefCallback = useCallback(
    (el: HTMLDivElement | null) => {
      setCardEl(el);
      responderRef(el);
    },
    [responderRef],
  );

  // Three geometry modes, and one presentation over them. A pinned sidebar
  // holds one side of the canvas a gap in, runs the canvas height less a gap
  // top and the deeper gap at the bottom, and takes only its width from the
  // store. An imposed pane pins to its place in the imposition chain over the
  // same vertical run, also taking only its width from the store — unless it
  // is size-locked, in which case the slot is an ordinary content card's box
  // and the pane is centred inside it. A free pane uses its stored
  // left/top/width/height. [L06]/[L09]
  //
  // Bullseye is not a fourth mode: it is a presentation that supersedes
  // whichever mode the pane holds, for as long as the pane holds focus, and
  // it writes nothing — so the branch below it is what the frame returns to
  // on exit, unchanged. It comes first because that supersession is the whole
  // point. Precedence over imposed is the feature (a slotted card bullseyes
  // to the centre and returns to its slot); precedence over pinned is
  // defensive only, since a rail can never be bullseyed. The placement is
  // one-up — `travelFraction` already answers 0.5 for `count < 2`, so
  // "centred in the band" is the imposer's existing definition rather than
  // new centring math.
  const modeStyle: CSSProperties = bullseye
    ? // Bullseye supersedes the column: a bullseyed pane is centred in the band
      // at the comfy width, taking the whole run, and returns to its share of
      // the split on exit.
      imposeStyle({ slot: 0, count: 1 }, bullseyeWidth, pinnedFrame)
    : sidebarSide !== undefined
      ? imposeSidebarStyle(sidebarSide, renderWidth, railMember)
      : railParked !== undefined
        ? imposeSidebarStyle(railParked, renderWidth)
      : imposed && placement !== undefined
        ? arriving === "bottom"
          ? // The seat a newcomer will take ([B08]): the bottom of the run at
            // the stack's floor, at the column's width. It is not a member of
            // the division yet, so `columnMember` is absent and the run is the
            // undivided one; the overlap with the member above is invisible
            // because the frame is hidden.
            imposeStyle(placement, slotWidth, {
              ...pinnedFrame,
              height: minSize.height,
              anchor: "end",
            })
          : slotHeightStyle !== undefined && heldSlotHeight !== undefined
            ? {
                ...imposeStyle(placement, slotWidth, pinnedFrame),
                ...slotHeightStyle(heldSlotHeight),
              }
            : imposeStyle(placement, slotWidth, pinnedFrame, {
                member: columnMember,
              })
        : {
            left: position.x,
            top: position.y,
            width: renderWidth,
            height: frameHeight,
          };
  // What this frame's imposed `left` is a function of, stamped beside it so a
  // rail width preview can carry the frame by transform instead of
  // re-resolving the deck's styles every frame (`rail-width-draft.ts`). The
  // same placement and slot width the `imposeStyle` call above took.
  const railTravel = bullseye
    ? railTravelOf({ slot: 0, count: 1 }, bullseyeWidth)
    : sidebarSide === undefined && imposed && placement !== undefined
      ? railTravelOf(placement, slotWidth)
      : undefined;

  // A slot-keeping resize, when the deck's rule says so and this pane is a
  // card standing in its slot. Its frame stays imposed through the whole
  // gesture, so the edges it offers are the ones the arrangement lets move. In
  // fit: a left edge only where the slot has travel to give up, a right edge
  // only where it is not the last slot's. In flow: the right edge alone — the
  // left is the running sum of the slots before it. A width-locked card offers
  // neither. Never a corner, and a top or bottom only where it borders a seam
  // in a split column that shares its run: the column's outer edges are the
  // run's, and an overflowing column's seams do not move.
  const keepSlotColumn: KeepSlotColumn | undefined =
    columnMember !== undefined &&
    columnMember.count > 1 &&
    columnMember.standing === "shared"
      ? {
          slot: columnMember.slot,
          index: columnMember.index,
          count: columnMember.count,
        }
      : undefined;
  const keepSlotResize: KeepSlotResize | null =
    !resizeKeepsSlot ||
    !imposed ||
    placement === undefined ||
    bullseye ||
    arriving !== undefined
      ? null
      : placement.flow !== undefined
        ? {
            layout: "flow",
            width: renderWidth,
            column: keepSlotColumn,
            heightStyle: slotHeightStyle,
          }
        : {
            layout: "fit",
            fraction: travelFraction(placement),
            width: renderWidth,
            imposedLeft: (width: number) =>
              String(
                imposeStyle(placement, width, pinnedFrame, {
                  member: columnMember,
                }).left,
              ),
            column: keepSlotColumn,
            heightStyle: slotHeightStyle,
          };
  keepSlotResizeRef.current = keepSlotResize;
  const resizeEdges: readonly ResizeEdge[] = keepSlotGripsOf(
    keepSlotResize === null
      ? null
      : {
          layout: keepSlotResize.layout,
          fraction: keepSlotResize.layout === "fit" ? keepSlotResize.fraction : 0,
          column: keepSlotResize.column,
          heightHeld: keepSlotResize.heightStyle !== undefined,
          widthPinned,
        },
  );
  // Whether this rail member's content follows a width drag live or waits
  // for the hand to rest — the registration's call, stamped where the draft
  // that holds it can read it (`rail-width-draft.ts`).
  const railReflow =
    sidebarStack !== undefined
      ? getRegistration(sidebarStack.componentId)?.railReflow
      : undefined;

  // Another pane is in bullseye, so this one leaves the canvas by the
  // horizontal edge it is already nearest. Overrides `left` alone: the
  // vertical run, the width, and the mode's other pins all stand, so the pane
  // slides straight out and straight back.
  //
  // THIS PANE'S SIDE IS READ FROM `modeStyle.left`, its ACTUAL resolved pin,
  // never from `position.x`. For an imposed pane the stored position is a
  // last-known value the imposer has long since superseded — a three-up deck
  // can have all three panes stored at nearly the same x while sitting left,
  // centre, and right on screen — so deciding from it sent every card out the
  // same side. `modeStyle.left` is a number for a free pane and the imposer's
  // `calc()` for a slotted one, and both compose here.
  //
  // THE LINE IT IS COMPARED AGAINST is the bullseyed pane's own former
  // centre, handed down in `bullseyeExit` — not the canvas centre. Panes left
  // of the bullseyed card leave leftward and panes right of it leave
  // rightward, so no pane ever crosses the card arriving at the middle. The
  // canvas centre was the first cut and it produced exactly that crossing:
  // bullseye the leftmost card of a three-up and the middle card, still left
  // of the canvas centre, slid left THROUGH it.
  //
  // The comparison itself stays in CSS rather than being resolved here: both
  // terms are length expressions over the live insets, and evaluating them at
  // render would mean measuring, which is the observation [L06] keeps out of
  // the geometry path. A clamp does it instead — the inner term is this
  // pane's centre minus that line, negative on one side and positive on the
  // other, and multiplying by a large number saturates it into one bound or
  // the other. The 1px bias breaks an exact tie toward the left, which would
  // otherwise resolve to 0 and leave the pane sitting on screen.
  //
  // BOTH BOUNDS PARK THE PANE JUST PAST ITS OWN EDGE — one gap beyond, not a
  // whole canvas away. That symmetry is about the MOTION, not the resting
  // place: the frame animates out on the FLIP settle, and a left bound of
  // `-100%` would send a left-leaving pane a full canvas-width further than a
  // right-leaving one travels, so the two would cross at visibly different
  // speeds over the same duration. Equal travel, equal read.
  //
  // The win over measuring: this re-resolves on a window resize for free,
  // like every other pin the imposer emits, and the right bound stays a
  // percentage — the form that lets the settle cross rather than cut ([D121]).
  const exitStyle: CSSProperties =
    bullseyeExit === undefined
      ? {}
      : {
          left: `clamp(${-(renderWidth + IMPOSITION_GAP_PX)}px, (${cssLength(modeStyle.left)} + ${renderWidth / 2}px - ${bullseyeExit} - 1px) * 10000, calc(100% + ${IMPOSITION_GAP_PX}px))`,
        };

  // The grips. A pinned sidebar exposes only its deck-facing edge (east for a
  // left-side rail, west for a right-side one), which drags the RAIL's width.
  // A pane whose resize releases it exposes all eight, imposed or not: it
  // leaves its slot, so there is no edge it needs to be protected from. A
  // pane whose resize keeps its slot exposes only the edges the arrangement
  // lets move (`resizeEdges`).
  //
  // `barSide`: a PARKED member keeps its rail edge, as its bar keeps its seat
  // — the frame is inert and hidden, and swapping its one edge for a free
  // pane's eight would be a mount the show pays for.
  //
  // A rail standing in bullseye exposes no edge at all (`railGripsOf`). Its
  // one handle measures from the deck edge the rail is pinned to, and the
  // frame would not be standing there. Defensive now rather than reachable: a
  // rail no longer bullseyes — `DeckManager.toggleBullseye` refuses one — but
  // this is geometry reading a posture field, and a stale id it read as true
  // would hand the user a handle onto nothing. Outside a deck canvas there is
  // no draft to drive, so there is no edge either — a handle the hand can grip
  // and nothing answers is the silence [L31] forbids.
  const grips: readonly ResizeEdge[] =
    barSide !== undefined
      ? railWidthGesture === null
        ? NO_GRIPS
        : railGripsOf(barSide, bullseye)
      : resizeEdges;

  const chromePlace: PaneChromeModel["placeArrangement"] =
    barSeat !== undefined || barSide !== undefined
      ? {
          // A rail is always divided, so the badge draws the band and lists
          // the side's members — and offers no arrangement verb ([B02]).
          //
          // `"stack"` for a side standing ONE card deep: the mode here is how
          // the place is standing rather than what it is set to, and a rail of
          // one divides nothing — so its badge reads the count, exactly as a
          // slot of one does, rather than a band letter naming a division that
          // is not there.
          mode: ((barSeat?.count ?? 1) > 1 ? "split" : "stack") as ColumnMode,
          kind: "rail",
        }
      : placement !== undefined
        ? {
            // A content pane standing in a slot — sharing it or not. A slot is
            // a place at depth one, so a card alone in its column still has
            // the badge's door to "Split Vertically".
            //
            // The mode is read off `columnMode` — the arrangement the slot is
            // SET to — rather than off `columnMember`, which is geometry and
            // is absent from a column of one. Reading the geometry left the
            // badge on `1` after the user split a slot holding a single card:
            // the act had committed, the picture could not show it, and the
            // only surface that could say so said nothing until a neighbour
            // arrived. The band letter is the report that the verb landed,
            // and "Stack" below it is then the way back.
            //
            // The band and the count are not here: the badge reads them from
            // the deck (`placePaneId`), so a close moves no survivor's bar.
            mode: columnMode ?? ("stack" as ColumnMode),
            kind: "column",
          }
        : null;

  const chromeModel: PaneChromeModel = {
    paneId: stackId,
    title: displayTitle,
    icon: effectiveMeta.icon,
    closable,
    confirmClose: paneConfirmClose,
    role: isRail ? "sidebar" : "content",
    tabs: cards ?? NO_TABS,
    activeCardId,
    acceptedFamilies,
    cardCount: cards?.length ?? 1,
    cardKind: cardKindName(effectiveMeta),
    grips,
    railGrip: barSide !== undefined,
    // The width control, on content-role panes only: a rail takes its width
    // from the allocator.
    width: barSide === undefined ? { preset: stackState.widthPreset ?? null } : null,
    fillHeight:
      barSide === undefined && slotHeightApplies
        ? { fills: heldSlotHeight === undefined }
        : null,
    placeArrangement: chromePlace,
    placePaneId: stackId,
    // Neither bullseye nor the move control is a rail's.
    bullseye: isRail ? null : bullseye,
    // The bar draws the fold only for a card that folds through it; a card
    // that owns its folded form (the Session card) is handed `false`
    // throughout, so its fold does not re-render the bar.
    folded: cardFold && folded,
    cardFold,
  };

  const chromeVerbs: PaneChromeVerbs = {
    onClosePane: handleTitleBarClose,
    onSetWidth: handleSetWidth,
    onFillHeight: handleFillHeight,
    onArrangePlace: handleArrangePlace,
    onToggleBullseye: handleToggleBullseye,
    onMoveToSpace,
    onRevealStackEntry: onRevealPane,
    onDragStart: handleDragStart,
    onResizeStart:
      barSide !== undefined
        ? (_edge, event) => handleSidebarResizeStart(event)
        : handleResizeStart,
    resolveCloseGuard,
    resolveModalHold,
    resolveCloseAdvice,
  };

  return (
    <div
      ref={frameRefCallback}
      className="tug-pane"
      data-testid="tug-pane"
      data-pane-id={id}
      // The chrome tier this pane wears. CSS turns it into
      // `--tugx-pane-chrome-height`, which every in-pane surface seating below
      // the title bar measures against — the scrim, the sheet's clip, the
      // banner. A custom property rather than a measured number, so the 72↔36
      // swap is one cascade and not four subscriptions ([L06]).
      {...(activeCardMasthead !== null ? { "data-masthead": "true" } : {})}
      // WHICH masthead, because the two tiers are different heights: a
      // Session card's stands one line taller than a document's in every
      // form, folded or open ([B04]), and that line is the description run's
      // second one. A pane fact for the same reason `data-role` below is one
      // — the height is published from up here, and `:has()` does not
      // invalidate on a descendant's attribute changing, so the bar's own
      // stamp cannot be read from the pane.
      {...(activeCardMasthead !== null
        ? {
            "data-masthead-kind":
              activeCardMasthead.kind === "session-masthead"
                ? "session"
                : "card",
          }
        : {})}
      // The folded form ([P03]). It no longer moves the chrome tier — the
      // Session card's masthead is the taller one whether or not the card is
      // folded — but every other surface that seats below the title bar
      // still reads it.
      {...(folded ? { "data-folded": "true" } : {})}
      // The frontmost card is a body: chrome and content paint nothing, so
      // the body view beneath shows through ([L06]: an attribute, not state).
      {...(activeCardIsBody ? { "data-body-card": "true" } : {})}
      // The active card draws the chrome in its own page: this frame is the
      // arrangement's stand-in, laid out and read, painting nothing ([L06]).
      {...(standIn ? { [CHROME_IN_BODY_ATTRIBUTE]: "" } : {})}
      // What the host carries the card in its hand by (`placeCards`): the
      // edges the arrangement offers, whether the pane is free, and its floor.
      {...(standIn
        ? {
            "data-grips": grips.join(" "),
            "data-min-width": String(minSize.width),
            "data-min-height": String(minSize.height),
            ...(pinned || imposed || bullseye ? {} : { "data-free": "" }),
          }
        : {})}
      // The rail tier, stamped here as well as on the bar so the height is a
      // pane fact: the scrim, the sheet clip, and the banner all seat below a
      // 32px bar. CSS cannot read the bar's own attribute from up here —
      // `:has()` does not invalidate on a descendant attribute change.
      {...(isRail ? { "data-role": "sidebar" } : {})}
      {...(isSidebarPane ? { "data-sidebar-pane": "" } : {})}
      // Parked: its rail hidden whole. Hidden and skipped by the stylesheet,
      // inert to pointer and keyboard, and out of every shown-frame query.
      {...(railParked !== undefined
        ? { "data-rail-parked": railParked, inert: true }
        : {})}
      // Departing: closed, and carried out by the settle on this very frame.
      // Inert, and out of every shown-frame query, until the land unmounts it.
      {...(departing ? { "data-departing": "", inert: true } : {})}
      // `data-rail-side` is NOT the same bit: it carries which edge a rail is
      // pinned to, and a released rail has rail chrome with no side.
      {...(sidebarSide !== undefined ? { "data-rail-side": sidebarSide } : {})}
      {...(railTravel !== undefined ? { [RAIL_TRAVEL_ATTR]: railTravel } : {})}
      {...(railReflow === "pause" ? { [RAIL_REFLOW_ATTR]: railReflow } : {})}
      // A member of a rail that is currently divided rather than stacked — the
      // sibling bit to `data-rail-side`, and what the seam elements and the reorder
      // drag find their fellow members by.
      {...(railSplit ? { "data-rail-split": "" } : {})}
      // Which card of the rail this frame is, so a reorder can name its
      // members the way the record does — by componentId, not by pane id.
      {...(railSplit && sidebarStack !== undefined
        ? {
            "data-rail-member": sidebarStack.componentId,
            // And where it stands, top to bottom, plus whether it is the
            // LAST member — a fact the pane has and the stylesheet needs,
            // since an index alone cannot say it. The panel treatment draws
            // a rail's hairlines only where they mark a boundary with
            // something else: no member draws a top rule, every member with
            // a member below it draws a bottom one, and the last draws none,
            // so the window's own edges carry no rule.
            "data-rail-member-index": String(sidebarStack.memberIndex),
            ...(sidebarStack.memberIndex === sidebarStack.count - 1
              ? { "data-rail-member-last": "" }
              : {}),
          }
        : {})}
      // A member of a column that is currently divided rather than stacked — the
      // content-side sibling of `data-rail-split`, and what the column seams
      // and the split UI find their fellow members by. Suppressed under
      // bullseye, which supersedes the column and takes the whole run.
      {...(columnMember !== undefined && !bullseye
        ? {
            "data-column-split": "",
            "data-column-member": String(columnMember.index),
          }
        : {})}
      {...(imposed && placement !== undefined && !bullseye
        ? { "data-imposed": String(placement.slot) }
        : {})}
      {...(bullseye ? { "data-bullseye": "" } : {})}
      // Arriving: appended but not yet divided, drawn hidden at its seat
      // ([B01], [B02]). The attribute is what the settle reads to skip the
      // frame, and the stylesheet-free `visibility` below is what keeps it
      // laying out while nothing can see, focus, or click it.
      {...(arriving !== undefined ? { "data-arriving": arriving } : {})}
      style={{
        position: "absolute",
        ...modeStyle,
        ...exitStyle,
        ...(arriving !== undefined ? { visibility: "hidden" as const } : {}),
        zIndex,
        boxSizing: "border-box",
        // Expose the pane's minimum width to descendants via CSS custom
        // property. `wide` TugSheets size relative to this floor rather
        // than the pane's (potentially much larger) live width, so a
        // wide sheet stays a predictable size instead of sprawling on a
        // big card. [L06]
        ["--tug-pane-min-width" as string]: `${sizePolicy.min.width}px`,
      }}
    >
      {standIn ? (
        // The stand-in keeps the root and content elements the card's host
        // finds by the pane's id, filling the frame, so the body's placeholder
        // measures the frame itself (`body-placement.ts`). No chrome: the
        // card's page draws it.
        <TugPaneFrameContext value={frameEl}>
          <div
            ref={rootRefCallback}
            className="tug-pane-chrome"
            data-slot="tug-pane"
            data-pane-id={stackId}
          >
            <ResponderScope>
              <div
                ref={contentRef}
                className="tug-pane-content"
                data-testid="tug-pane-content"
              />
            </ResponderScope>
          </div>
        </TugPaneFrameContext>
      ) : (
        <PaneChrome
          model={chromeModel}
          masthead={activeCardMasthead}
          verbs={chromeVerbs}
          frameEl={frameEl}
          rootEl={cardEl}
          rootRef={rootRefCallback}
          titleBarRef={titleBarRef}
          accessoryRef={accessoryRef}
          contentRef={contentRef}
          accessory={accessory}
          ResponderScope={ResponderScope}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Geometry helpers (pure functions, testable in isolation)
// ---------------------------------------------------------------------------

/**
 * Compute drag position with Finder-style constraining.
 *
 * The card may overhang any edge, but enough of its title bar must stay
 * visible and grabbable:
 * - Top: title bar top stays at or below y = 0 (cannot move above canvas).
 * - Bottom: at least TITLE_BAR_VISIBLE_MIN_Y of the title bar stays visible.
 * - Left/Right: at least TITLE_BAR_VISIBLE_MIN_X of the title bar stays visible.
 *
 * The envelope always contains where the card STARTED. A card can rest
 * outside it — the window shrank, a layout put it there — and the first
 * frame of a drag must not yank it into view: a grab moves a card by the
 * hand's travel and nothing else. So on each axis the bound is relaxed to the
 * start position when the start lies beyond it; the card can come inward
 * freely and can never be pushed further out than it already was.
 */
function clampedPosition(
  pointer: { x: number; y: number },
  startPointer: { x: number; y: number },
  startPosition: { x: number; y: number },
  canvasBounds: DOMRect | null,
  frameSize: { width: number; height: number },
  zoom = 1,
): { x: number; y: number } {
  // startPosition/frameSize are layout pixels; pointer is visual (client) pixels.
  // Convert the pointer delta to layout space so the card tracks the cursor 1:1
  // at any zoom, and clamp against layout-space canvas extents.
  let x = startPosition.x + (pointer.x - startPointer.x) / zoom;
  let y = startPosition.y + (pointer.y - startPointer.y) / zoom;

  if (canvasBounds) {
    const canvasWidth = canvasBounds.width / zoom;
    const canvasHeight = canvasBounds.height / zoom;
    // Left/right: card can hang off either side, but TITLE_BAR_VISIBLE_MIN_X must stay visible.
    const minX = Math.min(startPosition.x, -(frameSize.width - TITLE_BAR_VISIBLE_MIN_X));
    const maxX = Math.max(startPosition.x, canvasWidth - TITLE_BAR_VISIBLE_MIN_X);
    x = Math.max(minX, Math.min(x, maxX));
    // Top: title bar stays at or below CANVAS_PADDING (matches resize top constraint).
    // Bottom: at least TITLE_BAR_VISIBLE_MIN_Y of title bar stays visible.
    const minY = Math.min(startPosition.y, CANVAS_PADDING);
    const maxY = Math.max(startPosition.y, canvasHeight - TITLE_BAR_VISIBLE_MIN_Y);
    y = Math.max(minY, Math.min(y, maxY));
  }

  return { x, y };
}

/**
 * Compute new bounding rect after resizing on the given edge.
 *
 * Width and height are clamped to minSize (floor) and maxSize (ceiling).
 * When canvasBounds is provided, the resulting rect is hard-clamped so the
 * card cannot extend beyond the canvas edges (accounting for CANVAS_PADDING).
 * Unlike drag (which uses relaxed Finder-style rules), resize is rigid.
 */
function resizeDelta(
  pointer: { x: number; y: number },
  startPointer: { x: number; y: number },
  startLeft: number,
  startTop: number,
  startW: number,
  startH: number,
  edge: ResizeEdge,
  minSize: { width: number; height: number },
  canvasBounds?: DOMRect | null,
  maxSize?: { width: number; height: number },
  zoom = 1,
): { left: number; top: number; width: number; height: number } {
  // start*/sizes are layout pixels; pointer is visual (client) pixels. Convert
  // the pointer delta to layout so the edge tracks the cursor 1:1 at any zoom.
  const dx = (pointer.x - startPointer.x) / zoom;
  const dy = (pointer.y - startPointer.y) / zoom;

  let left = startLeft;
  let top = startTop;
  let width = startW;
  let height = startH;

  if (edge.includes("e")) {
    width = Math.max(minSize.width, startW + dx);
    if (maxSize) width = Math.min(maxSize.width, width);
  }
  if (edge.includes("w")) {
    let newW = Math.max(minSize.width, startW - dx);
    if (maxSize) newW = Math.min(maxSize.width, newW);
    left = startLeft + (startW - newW);
    width = newW;
  }
  if (edge.includes("s")) {
    height = Math.max(minSize.height, startH + dy);
    if (maxSize) height = Math.min(maxSize.height, height);
  }
  if (edge.includes("n")) {
    let newH = Math.max(minSize.height, startH - dy);
    if (maxSize) newH = Math.min(maxSize.height, newH);
    top = startTop + (startH - newH);
    height = newH;
  }

  // Hard-clamp to canvas bounds so the card cannot be resized past any canvas edge.
  if (canvasBounds) {
    const maxRight = canvasBounds.width / zoom - CANVAS_PADDING;
    const maxBottom = canvasBounds.height / zoom - CANVAS_PADDING;

    // Clamp right edge: prevent card from extending past canvas right.
    if (left + width > maxRight) {
      if (edge.includes("e")) {
        width = Math.max(minSize.width, maxRight - left);
      } else if (edge.includes("w")) {
        left = Math.max(CANVAS_PADDING, left);
        width = startLeft + startW - left;
        if (width < minSize.width) {
          width = minSize.width;
          left = startLeft + startW - width;
        }
      }
    }
    // Clamp left edge.
    if (left < CANVAS_PADDING) {
      const rightEdge = left + width;
      left = CANVAS_PADDING;
      width = Math.max(minSize.width, rightEdge - left);
    }

    // Clamp bottom edge: prevent card from extending past canvas bottom.
    if (top + height > maxBottom) {
      if (edge.includes("s")) {
        height = Math.max(minSize.height, maxBottom - top);
      } else if (edge.includes("n")) {
        top = Math.max(CANVAS_PADDING, top);
        height = startTop + startH - top;
        if (height < minSize.height) {
          height = minSize.height;
          top = startTop + startH - height;
        }
      }
    }
    // Clamp top edge.
    if (top < CANVAS_PADDING) {
      const bottomEdge = top + height;
      top = CANVAS_PADDING;
      height = Math.max(minSize.height, bottomEdge - top);
    }
  }

  return { left, top, width, height };
}
