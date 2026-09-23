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

import React, { useCallback, useMemo, useState, useEffect, useRef, useSyncExternalStore, useLayoutEffect } from "react";
import { animate, type TugAnimation } from "@/components/tugways/tug-animator";
import {
  beginResizeEpisode,
  type ResizeEpisodeHandle,
} from "@/lib/resize-episode";
import {
  contentBoxHeight,
  adoptFoldCrossing,
  adoptStillCrossing,
  endFoldCrossing,
  endStillCrossing,
  markFoldCrossing,
  markStillCrossing,
} from "@/lib/fold-crossing";
import {
  getTugTiming,
  getTugZoom,
  isTugMotionEnabled,
} from "@/components/tugways/scale-timing";
import { useResponder } from "@/components/tugways/use-responder";
import { useResponderChain } from "@/components/tugways/responder-chain-provider";
import type { ActionEvent } from "@/components/tugways/responder-chain";
import { TUG_ACTIONS } from "@/components/tugways/action-vocabulary";
import { applyBagFocus, transferFocusForActivation } from "@/focus-transfer";
import { deckTrace, type CommitLanding } from "@/deck-trace";
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
} from "./tug-pane";
import { CardHost } from "./card-host";
import { CanvasOverlayRoot } from "./canvas-overlay-root";
import { OpenQuicklyOverlay } from "./open-quickly-overlay";
import { UpdateOverlay } from "./update-overlay";
import { DeckCommitBeacon } from "./deck-commit-beacon";
import { TugSlot, type TugSlotState } from "@/components/tugways/tug-slot";
import { usePaneFocusController } from "./pane-focus-controller";
import { usePaneOcclusionController } from "./pane-occlusion-controller";
import {
  getAllRegistrations,
  getRegistration,
  getStackSizePolicy,
  isSidebarCard,
} from "@/card-registry";
import { JOTS_CARD_ID } from "@/lib/jots-card-id";
import { ARCS_CARD_ID } from "@/lib/arcs-card-id";
import { CARDS_CARD_ID } from "@/lib/cards-card-id";
import type { IDeckManagerStore } from "@/deck-manager-store";
import { cardsSpaceVerbRequest } from "@/components/cards/cards-space-verb-request";
import { OVERVIEW_CARD_ID } from "@/lib/overview-card-id";
import { getJotsStore } from "@/lib/jots-store";
import {
  bullseyePaneIdOf,
  columnAllocationOf,
  columnDrawsSplit,
  deckColumnsOf,
  deckFlowStrip,
  deckVacancyExtent,
  type DeckColumn,
  findSidebarPanes,
  isUnboundMember,
  paneRenderWidthOf,
  placeMembers,
  placeSeamFractions,
  placeAllocationTerm,
  type PlaceRuns,
  railAllocationOf,
  railMembersOf,
} from "@/deck-store-selectors";
import type { SlotStackEntry } from "@/deck-store-selectors";
import { stepCardRing } from "@/lib/card-ring";
import { cardTitleStore } from "@/lib/card-title-store";
import { paneTitleBarTextFor } from "@/lib/pane-title";
import type { DeckState, TugPaneState } from "@/layout-tree";
import { useDeckManager } from "@/deck-manager-context";
import { cardDragCoordinator } from "@/card-drag-coordinator";
import { selectionGuard } from "@/components/tugways/selection-guard";
import { copySelectionAsPlainText } from "@/lib/copy-as-plain-text";
import { openFileInCard } from "@/lib/open-file-in-card";
import { revealPathInFinder } from "@/lib/os-open";
import {
  isDictionaryLookupRequest,
  lookUpInDictionary,
} from "@/lib/dictionary-lookup";
import { openOpenQuickly } from "@/lib/open-quickly-store";
import { clearRecentDocuments } from "@/lib/recent-documents";
import { allocateUntitledNumber } from "@/lib/untitled-naming";
import { cardServicesStore } from "@/lib/card-services-store";
import { useCardLifecycle } from "@/lib/card-lifecycle";
import {
  MAX_FLIP_SCALE_DISTORTION,
  BEAT_ORDER,
  beatLaunchVelocity,
  flipDelta,
  planSettleBeats,
  scaleDistortion,
  springSettleKeyframes,
  type BeatKind,
  type HeldTerms,
  type InterruptedBeat,
  type SettleBeat,
} from "@/lib/pane-flip";
import { dispatchImposerSettleEnd } from "@/lib/settle-notice";
import {
  motionDurationMs,
  motionKeyframes,
  velocityAt,
  type MotionCurve,
  type MotionRecipe,
} from "@/lib/imposer-motion";
import { dispatchCommand } from "@/command-dispatch";
import {
  attachLayoutSelectionToDeck,
  cardsSelectionStore,
} from "@/components/cards/cards-selection-store";
import { shrinkCardsState } from "@/components/cards/cards-escape";
import { contentCardsInLayoutSelection } from "@/lib/layout-selection";
import { flashCardPane, flashSlot } from "@/lib/flash-pane-border";
import {
  isFocusDirection,
  resolveDirectionalFocus,
  type FocusTravelSpan,
} from "@/lib/directional-focus";
import {
  enumerateDropZones,
  type DropZoneHost,
} from "@/lib/drop-zones";
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
  SHOWN_PANE_FRAMES,
  SPACE_CROSSING_ATTRIBUTE,
  SPACE_LAYER_ATTRIBUTE,
  SPACE_LAYER_CLASS,
  SpaceLayerShownContext,
} from "./space-layer";
import "./space-layer.css";
import "./rail-vacancy.css";
import "./margin-cap.css";
import "./rail-shadow.css";
import {
  isSidebarPinned,
  sidebarSide,
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
  IMPOSITION_SETTLE_MS,
  readSettleMs,
  PANE_ENTER_RISE_PX,
  RESIZE_RETUNE_QUIET_MS,
  FLOW_OFFSET_PROPERTY,
  FLOW_STRIP_PROPERTY,
  clampFlowOffset,
  flowCenterOffset,
  effectiveRailOrder,
  imposeSidebarStyle,
  impositionLayout,
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

// ---- Card z-index base ----

/**
 * Z-index base for cards. Card at index i in deckState.cards gets
 * z-index CARD_ZINDEX_BASE + i.
 */
const CARD_ZINDEX_BASE = 1;

/**
 * Z-index BAND for sidebar panes — the rails. A rail must sit ABOVE every free
 * pane (tiny array-order z, 1..N) so it is never occluded by a card, yet
 * strictly BELOW the canvas-overlay base (`--tug-z-overlay-base` = 9000) into
 * which every popup/menu/tooltip — including a rail card's own `…` menu and
 * its popovers — portals. A naive "always on top" z above 9000 would bury
 * those popups behind the rail. 8999 is the tier the former dev-panel overlay
 * used, and the band is the nine values below it.
 *
 * It has to be a band rather than the single value it was when one card was the
 * only rail: **same-side sidebars stand front-to-back**, so the two of them have
 * to be orderable against each other. Within the band they take the deck's own
 * z-order — array position, the thing `activateCard` moves — which is what makes
 * the title bar's stack picker able to bring the covered one forward. One fixed
 * value for every rail would have pinned whichever card happened to hold it on
 * top forever, and with two identical rects that is a card you can never reach.
 */
const SIDEBAR_PANE_ZINDEX_BASE = 8990;

/**
 * Z for the margin caps — the two elements covering the five pixels a rail
 * stands off the window edge and therefore cannot cover itself.
 *
 * It has to be ABOVE every free card, because covering a card travelling out
 * past the band edge is the whole job, and free cards take a tiny array-order
 * z (1..N). And it has to be strictly BELOW the rail band, because the rail is
 * what actually occludes the card and a cap painting over a rail's own margin
 * edge would put canvas ground on top of chrome. One below the band's base is
 * both, with no arithmetic over the deck's card count. [B02]
 */
const MARGIN_CAP_ZINDEX = SIDEBAR_PANE_ZINDEX_BASE - 1;

/**
 * Z for the rail shadows, deliberately the margin cap's own layer: above
 * every free card and strictly below the rail band. The shadow's whole job is
 * to darken the card sliding under it, so it must outrank cards; and it must
 * stay below the rails so a rail's own ink is never shaded by the panel it
 * belongs to.
 */
const RAIL_SHADOW_ZINDEX = MARGIN_CAP_ZINDEX;

/**
 * The registry key a side's shadow strip settles under. The strip is not a
 * pane, but it is held, measured, carried and handed back exactly as a frame
 * is — it is the depth of the rail beside it, and a shadow that moves on any
 * clock but its rail's has come away from the panel. The prefix is what lets
 * `arm` find the strips' entries among the frames'.
 */
const RAIL_SHADOW_TWEEN_PREFIX = "rail-shadow:";
function railShadowTweenKey(side: SidebarSide): string {
  return `${RAIL_SHADOW_TWEEN_PREFIX}${side}`;
}

/**
 * How far a rail standing at `rect` must travel to clear `side`'s edge of the
 * canvas — negative for a left rail, positive for a right one.
 *
 * Measured to the CONTAINER's edge rather than taken as the frame's own width,
 * because a rail stands one `RAIL_EDGE_INSET` in from that edge and a slide
 * short by the inset would leave a sliver parked against the window. Past the
 * edge it is clipped, which is what makes the disappearance the edge's doing
 * rather than an opacity's.
 */
function railTravelPx(rect: DOMRect, side: SidebarSide, canvas: DOMRect): number {
  return side === "left"
    ? -(rect.right - canvas.left)
    : canvas.right - rect.left;
}

/**
 * A deck's pane z-order: focus order for the free panes, the band for the rails.
 *
 * Taken out of the shown workspace's memo because a HIDDEN workspace needs the
 * same answer now. It used to need none — every pane of a workspace nobody was
 * looking at could take one flat value, because `display: none` paints none of
 * them. Then the switch dissolve put the departing workspace on screen, opaque
 * and on top, for a beat ([B09]): flat, its own rail would have been painted
 * over by whichever of its own cards happened to sort after it, and the first
 * frame of the dissolve — the one that is supposed to be indistinguishable
 * from the last frame before it — would have restacked the workspace the
 * reader was looking at a moment ago.
 */
function buildZIndexMap(
  panes: readonly { id: string }[],
  sidebarPaneIds: ReadonlySet<string>,
): Map<string, number> {
  // Rails are ranked among themselves, in the deck's own array order, so a
  // raise inside the band actually moves one in front of the other.
  const railRank = new Map<string, number>();
  for (const pane of panes) {
    if (sidebarPaneIds.has(pane.id)) railRank.set(pane.id, railRank.size);
  }
  const map = new Map<string, number>();
  panes.forEach((pane, i) => {
    const rank = railRank.get(pane.id);
    map.set(
      pane.id,
      rank === undefined
        ? CARD_ZINDEX_BASE + i
        : SIDEBAR_PANE_ZINDEX_BASE +
          Math.min(rank, SIDEBAR_PANE_ZINDEX_MAX_RANK),
    );
  });
  return map;
}

/** The most rails the band can order before it would collide with the overlay
 *  base. Far past any real deck; the clamp is here so it cannot ever collide.
 *
 *  Eight rather than nine: 8999, the top of the ten values under the overlay
 *  base, is `--tug-z-space-crossing` now — the tier the DEPARTING workspace
 *  stands at for the length of one switch ([B09]). It has to clear the
 *  ARRIVING workspace's rails, because a rail band that reached 8999 would
 *  have painted the incoming rail strip over the departing one at the instant
 *  of the commit, which is the pop the crossfade exists to remove. No deck has
 *  ever stood two rails a side, let alone nine. */
const SIDEBAR_PANE_ZINDEX_MAX_RANK = 8;

/**
 * The seam between two split rail members, level with the frontmost rank a rail
 * can reach and still strictly below every popup.
 *
 * It has to be stated rather than left to document order, because the seam's
 * hit strip is wider than the 5px gap it sits in and therefore overlaps each
 * neighbouring frame by about 2.5px. Below the band, a press in that overlap
 * would land on the frame instead and the seam would be undraggable along the
 * edges that matter most.
 */
const RAIL_SEAM_ZINDEX = SIDEBAR_PANE_ZINDEX_BASE + SIDEBAR_PANE_ZINDEX_MAX_RANK;

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

/** One member of a side's rail, in the rail's own vertical order: the order the
 *  imposition records, falling back to registration order — never z-order. */
interface SidebarRailMember {
  componentId: string;
  paneId: string;
}

/**
 * A side's rail: the pinned sidebar panes standing on it, the width they share,
 * and how they stand against one another.
 *
 * They divide the run at `seams`, always, and every one is visible ([B01]).
 */
interface SidebarRail {
  side: SidebarSide;
  width: number;
  members: readonly SidebarRailMember[];
  /** Where the gaps fall, as fractions of the run: `members.length - 1`
   *  values. */
  seams: readonly number[];
  /** How the rail divides its run among its members, or `null` on a canvas
   *  with no measured run. */
  allocation: PlaceAllocation | null;
}

/**
 * The rails standing on the deck's edges, at most one per side — the picture
 * the band is inset from, and the order each side's members stand in.
 *
 * Same-side cards share ONE rail, so a side contributes one width however many
 * cards stand on it: the widest member's render width, since a rail narrower
 * than a member would run the chain under the edge that member paints.
 *
 * The componentIds are sorted into **registration** order before the
 * imposition's stored order is applied. That is `effectiveRailOrder`'s caller
 * contract, and it cannot be met by accident: `findSidebarPanes` walks
 * `state.panes`, the array `activateCard` reorders, so handing its order
 * straight in would make a split rail with no stored order follow the last
 * raise — click the lower member and the two would swap places. Registration is
 * a boot step, so the order this sorts into is fixed for the session.
 */
function sidebarRailsOf(
  state: DeckState,
  runs: PlaceRuns,
): readonly SidebarRail[] {
  const paneById = new Map(state.panes.map((pane) => [pane.id, pane]));
  const rails: SidebarRail[] = [];
  for (const side of ["left", "right"] as const) {
    const order = railMembersOf(state, side);
    if (order.length === 0) continue;
    let width = 0;
    const members: SidebarRailMember[] = [];
    for (const { componentId, paneId } of order) {
      const pane = paneById.get(paneId);
      if (pane === undefined) continue;
      width = Math.max(width, paneRenderWidthOf(state, pane));
      members.push({ componentId, paneId: pane.id });
    }
    if (members.length === 0) continue;
    const shares = state.imposition.rails?.[side]?.shares;
    const allocation = railAllocationOf(state, side, runs.rail);
    rails.push({
      side,
      width,
      members,
      allocation,
      seams:
        placeSeamFractions(
          allocation,
          members.map((member) => member.componentId),
        ),
    });
  }
  return rails;
}

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
 * Everything the imposer reads, as one string: the imposition record, which
 * pane holds which slot, and the pinned rail's width. Two decks with the same
 * signature put every derived frame in the same place, so a change to it is
 * exactly the set of moments the deck should cross to a new arrangement rather
 * than cut.
 *
 * The pane terms are sorted, so the signature is blind to the panes array's
 * ORDER — which is z-order, and z-order moves nothing: `imposeRect` reads a
 * pane's slot, its width, and the span, never its place in the array. Order
 * sensitivity here would make every pane activation — a click on a title bar —
 * arm a settle window with no frame to move in it, holding session
 * notifications for the length of a motion that never happens.
 *
 * The rail widths are terms because the space allocator can change them with
 * the arrangement otherwise untouched — a settled window resize re-solves them
 * and nothing else — and every imposed frame moves when they do. Without the
 * terms that motion would cut. They change on a rail edge drag too, which arms
 * a window whose tweens are all no-ops: the drag wrote the width live, so each
 * frame's first and last rects are the same one.
 *
 * A pane's own WIDTH is a term for the same reason: `imposeRect` reads it, so a
 * width preset — the deck-wide one from the Layouts section, or one card's from
 * its title bar — moves every seam in the chain and resizes the panes it lands
 * on. It is the one arrangement input a pointer also writes: a hand-dragged
 * edge changes it too, and arms a window whose tweens are the same no-ops a
 * rail drag's are, for the same reason.
 *
 * A pane's FOLDED flag is a term, and the frame's stored height is still
 * not one. The two facts belong together. A stored height moves only when a
 * pointer is already writing the frame live, so a term for it would arm
 * windows full of no-ops; but folding is an arrangement gesture in every
 * sense that matters here — it re-pins the frame from the open card's tier to
 * the folded one ([P04]), and in a split column it re-allocates every
 * sibling — and the Last pass has always been willing to interpolate a real
 * height delta.
 *
 * Without the term the fold armed nothing except where some OTHER term
 * happened to move: a split column's allocation changes, so a wall folded on
 * the settle's clock, while the same card on a free pane or alone in a stacked
 * slot cut. The free pane looked animated only because `.tug-pane` carries the
 * [D07] window-shade ease, a 100ms snap underneath a 400ms interior collapse;
 * the stacked slot, whose height the imposer writes as geometry with no
 * transition, did not even have that. One gesture drew three different ways
 * depending on where the card happened to be standing.
 *
 * The flag rather than the resolved height, because the flag is what the
 * gesture writes and the height is what the layout derives from it: a term
 * reading the derived value would have to be recomputed here against the size
 * policy, the slot, and the column's allocation — three answers this function
 * does not otherwise need — and would go wrong exactly when one of them
 * changed. The frame's real before-and-after height is measured by the First
 * and Last passes, which is where a height belongs.
 *
 * The rail terms are read through `sidebarRailsOf`, which orders its members by
 * the imposition and by registration — never by the panes array. Until a rail
 * could be split that ordering was z-derived, which made this function's
 * documented z-blindness false of the rail term: activating a rail member
 * reordered `state.panes`, changed the term, and armed a settle window with no
 * frame to move in it. The same fix that keeps a split rail's members from
 * trading places on a click is what finally makes the claim above true here.
 *
 * A side's MODE and its ALLOCATED HEIGHTS are terms because both move frames: a
 * mode flip changes every member's height, and a seam drag changes two. The
 * heights are rounded to the pixel so sub-pixel allocation arithmetic cannot
 * arm a settle nobody can see — and they are the heights themselves rather
 * than the weights behind them, because that is what the frames are pinned at:
 * a rail crossing between sharing its run and stacking a strip moves every
 * member without any weight changing at all. A seam drag's own commit arms a
 * window whose tweens are all no-ops — the drag wrote the properties live, so
 * each frame's first and last rects are the same one — which is the
 * coexistence the rail width terms already have.
 *
 * A side's OFFSET is a term for the reason a column's is: past two members a
 * rail stops dividing and starts scrolling, and a reveal that slides its strip
 * moves every member's `top` while side, width, mode and order all hold still.
 *
 * The bullseye term is the DERIVED id, not the raw field, because that is
 * what the render path places from. Entering and leaving bullseye re-places
 * and re-widths a frame — a one-up placement at comfy on the way in, the
 * pane's own mode and width on the way out — which is exactly the kind of
 * moment the settle exists for. Reading the raw field would miss every
 * focus-shaped exit: clicking another pane ends bullseye through the
 * derivation with the field untouched, and that exit would cut rather than
 * cross. Deriving also keeps activation from arming a pointless window — the
 * term only moves while bullseye is actually on, which is exactly when there
 * is a frame to move.
 */
function arrangementSignature(state: DeckState, runs: PlaceRuns): string {
  const panes = state.panes
    // A pane still marked ARRIVING is no term of the arrangement, on the same
    // rule that keeps it out of its column's division ([B08]) and out of the
    // strip: it is drawn hidden at the seat it will take, so nothing about it
    // is on screen to cross to. With a term here the HIDDEN commit changed the
    // signature and armed a settle of its own — a whole arm, with First rects
    // measured and a beat launched over frames that had nowhere to go — a
    // commit before the arrival the reader actually watches. Its term appears
    // when its mark clears, which is the reveal, which is the one settle an
    // arrival is.
    .filter((pane) => state.arriving?.[pane.id] !== true)
    .map(
      (pane) =>
        `${pane.id}:${pane.slot ?? ""}:${pane.size.width}:${
          pane.folded === true ? "m" : ""
        }`,
    )
    .sort();
  const bullseye = bullseyePaneIdOf(state) ?? "";
  const rails = sidebarRailsOf(state, runs)
    .map(
      (rail) =>
        `${rail.side}:${rail.width}:${rail.members
          .map((m) => m.componentId)
          .join("+")}:${placeAllocationTerm(rail.allocation)}:${Math.round(
          state.railOffsets?.[rail.side] ?? 0,
        )}`,
    )
    .join(";");
  // The layout MODE is a term of its own, and the offset does not cover it.
  // Toggling fit↔flow moves every pane's `left` while kind, slots, widths,
  // rails and bullseye all hold still — and at rest the offset is 0 on both
  // sides of the toggle, so without this term the signature would not move,
  // no settle would arm, and the mode flip would CUT: the one gesture flow
  // exists to offer ([P10]).
  const layout = impositionLayout(state.imposition);
  // The offset, rounded to the pixel it is written at. Sub-pixel churn is not
  // an arrangement change, and the property carries the rounded value anyway.
  const flow = `${layout}:${Math.round(state.flowOffset ?? 0)}`;
  // A slot's MODE and its ALLOCATED HEIGHTS are terms for exactly the reasons a
  // rail's are: a split flip changes every member's height, and a seam drag
  // changes two. The pane terms above would not cover either — a flip moves no
  // pane between slots and changes no stored width, so without this the one
  // gesture the feature exists for would CUT.
  //
  // The MEMBER ORDER is a term too, and it is not redundant with the pane
  // terms: reordering a split column swaps two frames' vertical pins while
  // every pane keeps its slot and its width, so the sorted pane list is
  // identical either side of the move.
  //
  // And the OFFSET is a term for the reason flow's is: an overflowing column
  // reveals a member by sliding its strip, which moves every member's `top`
  // while slot, width and order all hold still. Rounded to the pixel it is
  // written at, so a reveal that computes no move arms nothing ([P12]).
  const columns = deckColumnsOf(state, runs.column)
    .filter((column) => column.mode === "split")
    .map(
      (column) =>
        `${column.slot}:${column.members.join("+")}:${placeAllocationTerm(
          column.allocation,
        )}:${Math.round(state.columnOffsets?.[column.slot] ?? 0)}`,
    )
    .join(";");
  return `${state.imposition.kind ?? ""}|${flow}|${bullseye}|${rails}|${columns}|${panes.join(",")}`;
}

/**
 * Capture a frame's own inline value for `property` and return the hand-back.
 *
 * The settle's size and fade tweens ride real properties, and TugAnimator
 * commits an animation's final value into `el.style` on completion — a baked
 * pixel length where React rendered `auto` or a `calc()` would freeze the
 * frame against the live expressions its geometry keeps reading (a seam drag,
 * a window resize). The restorer runs in the settle's completion handler,
 * after that commit lands.
 */
function inlineRestorer(
  el: HTMLElement,
  property: "width" | "height" | "opacity",
): () => void {
  const prev = el.style.getPropertyValue(property);
  return () => {
    if (prev === "") el.style.removeProperty(property);
    else el.style.setProperty(property, prev);
  };
}

/**
 * Take the settle's marks off the container — after ONE forced style flush.
 *
 * The flush is the whole of this function, and it is not a tidiness: the
 * settle's LAST write is the inline residue coming off its frames, and that
 * write lands in the same task as these marks. `chrome.css` stands the frame's
 * window-shade `transition: height` down for exactly the length of this window
 * (`[data-imposer-settling] .tug-pane`) so no second clock runs on a height
 * the settle is tweening — but a style recalc that sees the hand-back also
 * sees the marks gone, so the transition it resolves against is the LIVE one
 * and it arms on the hand-back itself.
 *
 * What that looked like is the fold: the frame is held inline at its open
 * height for the crossing's length ([B01] of `three-beat-settle` holds every
 * size term at First until its beat runs), the tween carries the edge down to
 * the tier, and the hand-back then walks the frame from the one to the other
 * on the shade's own 100ms — a card that has finished folding flashing back to
 * full height and collapsing a second time, after the settle was over.
 *
 * Reading a layout property flushes style and layout, so the hand-back is
 * resolved while the stand-down still stands: the frame settles at its
 * committed height with no transition to arm, and taking the marks off after
 * changes no property anybody can transition. One flush per settle, at a
 * moment nothing else is pending.
 */
function endSettleMarks(el: HTMLElement): void {
  void el.offsetHeight;
  el.removeAttribute("data-imposer-settling");
  el.removeAttribute("data-imposer-beat");
}

/** One pane's in-flight settle: its tweens and the inline residue they owe back. */
interface SettleTween {
  el: HTMLElement;
  anims: TugAnimation[];
  restores: Array<() => void>;
}

/**
 * How long after a crossfade's tweens should have finished the beat is torn
 * down anyway ([L32] clause 2).
 *
 * A margin rather than the bare duration because the deadline is the net, not
 * the clock: it must never fire while the fade is still on screen, and it must
 * fire soon enough that a stranded layer is a blink rather than a state. One
 * frame of slack at 60Hz is about 16ms; this is generous over that and still
 * inside the length of the beat it guards.
 */
const SPACE_CROSSFADE_DEADLINE_MARGIN_MS = 120;

/**
 * The recipe each beat of a settle plays on. The move beat IS the crossing —
 * the settle the whole choreography is measured against — and the two resize
 * beats have recipes of their own in `lib/imposer-motion.ts`.
 *
 * The two outer beats are fades and share `divide-join`: a frame appearing in
 * a place or leaving one is carried by opacity rather than by travel, so what
 * it needs from a recipe is a window rather than a spring. A column mode flip
 * is not one of them — it is a cover, not a fade ([B02] of
 * `briefs/column-flip-cover-brief.md`), so its survivor rides the fused beat
 * and its other members hold still.
 */
const BEAT_RECIPE: Record<BeatKind, MotionRecipe> = {
  depart: "divide-join",
  // The fused beat IS the crossing, for the move beat's reason: it is the one
  // motion the settle is measured against, and a settle that carries an
  // arrival or a departure runs its whole geometry on that one clock ([P08]).
  room: "crossing",
  shrink: "shrink",
  move: "crossing",
  grow: "grow",
  arrive: "divide-join",
};

/**
 * Write what a beat holds still onto the frame's inline style: the constant
 * transform a resize beat wears while the move has not yet run, and the First
 * size of an axis whose grow beat is still to come. Inline rather than a
 * keyframe, so a move beat's effect stays transform-only and accelerated. The
 * settle's restorers and `clearFlip` take every one of these off at the end.
 */
function applyHolds(frame: HTMLElement, held: HeldTerms): void {
  if (held.transform !== undefined) {
    const { dx, dy, sx } = held.transform;
    const move = `translate(${dx}px, ${dy}px)`;
    frame.style.transform = sx === 1 ? move : `${move} scaleX(${sx})`;
  }
  if (held.width !== undefined) frame.style.width = `${held.width}px`;
  if (held.height !== undefined) frame.style.height = `${held.height}px`;
}

/**
 * How tall a seam's hit strip is. Wider than the 5px gap it sits in, because a
 * 5px target is under every pointing-comfort floor the deck holds elsewhere;
 * the cost is that it takes about 2.5px off each neighbour's edge, and on the
 * lower member that edge is title bar. The seam is the smaller and more precise
 * target of the two, so it is the one that gets the help.
 */
const RAIL_SEAM_HIT_PX = 10;

/**
 * Which of `rail`'s members stands in front of the others — the one a STACK
 * shows, and the one a split's own picker checkmarks.
 *
 * Read off `state.panes` because that array's order IS the deck's z-order (the
 * thing `activateCard` moves), and the rail band's z-indices are packed from
 * it. Reading the rendered `z-index` back instead would answer the same
 * question one commit later; this way an arming settle sees the order the
 * commit it is crossing already wrote.
 */
function railFrontmostPaneId(
  state: DeckState,
  rail: SidebarRail,
): string | undefined {
  const ids = new Set(rail.members.map((member) => member.paneId));
  let frontmost: string | undefined;
  for (const pane of state.panes) if (ids.has(pane.id)) frontmost = pane.id;
  return frontmost;
}

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
 * The drag follows `handleSidebarResizeStart` member for member — pointer
 * capture, a move-threshold latch, one rAF-applied `setProperty` per frame,
 * zoom-corrected deltas, and the property left as the gesture set it so no
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
}: PlaceSeamProps): React.ReactElement {
  const allocationRef = useRef(allocation);
  allocationRef.current = allocation;
  const membersRef = useRef(members);
  membersRef.current = members;
  const memberPaneIdsRef = useRef(memberPaneIds);
  memberPaneIdsRef.current = memberPaneIds;

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      const seam = event.currentTarget;
      const container = seam.parentElement;
      if (container === null) return;

      const zoom = getTugZoom() || 1;
      const startClientY = event.clientY;
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

      seam.setPointerCapture(event.pointerId);
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
      const divided = [...memberPaneIdsRef.current]
        .filter((id): id is string => id !== undefined)
        .map((id) =>
          document.querySelector<HTMLElement>(
            `.tug-pane[data-pane-id="${id}"]`,
          ),
        )
        .filter((el): el is HTMLElement => el !== null);
      for (const el of divided) el.setAttribute("data-pointer-owned", "true");

      let latestY = startClientY;
      let rafId: number | null = null;
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

      // Where the division the hand is holding is published. An overflowing
      // place writes the one boundary it moved; a shared one writes EVERY
      // seam, because a cascade moves the boundaries below the one under the
      // pointer too, and a frame still reading its old seam would overlap the
      // member that had just given room up.
      const publish = (height: number): void => {
        if (overflowing) {
          container.style.setProperty(
            property,
            `${Math.round(valueOf(height))}px`,
          );
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
          container.style.setProperty(
            seamPropertyOf(place, k),
            String((top + seamPx / 2) / run),
          );
          top += seamPx;
        }
      };

      const apply = (): void => {
        rafId = null;
        if (!latch(latestY)) return;
        publish(computeHeight());
      };

      const onPointerMove = (e: PointerEvent): void => {
        latestY = e.clientY;
        if (rafId === null) rafId = requestAnimationFrame(apply);
      };

      const onPointerUp = (e: PointerEvent): void => {
        if (rafId !== null) {
          cancelAnimationFrame(rafId);
          rafId = null;
        }
        seam.removeEventListener("pointermove", onPointerMove);
        seam.removeEventListener("pointerup", onPointerUp);
        seam.removeEventListener("pointercancel", onPointerCancel);
        seam.releasePointerCapture(e.pointerId);
        seam.removeAttribute("data-gesture");
        latestY = e.clientY;
        try {
          if (!latch(latestY)) return;
          const height = computeHeight();
          // The property stays as the gesture left it: the commit re-renders at
          // this fraction and the inset effect writes the same number back, so
          // there is no frame where a member reads the pre-gesture seam.
          publish(height);
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
          for (const el of divided) el.removeAttribute("data-pointer-owned");
          onCommit(place, index, valueOf(height));
        } finally {
          // And on EVERY path out, which is what the `finally` is for. A press
          // that never travelled commits nothing and returns above; a mark left
          // standing there would exempt both members from every settle for the
          // rest of the session, and the seam's own double-click equalize is
          // two such presses — so the leak would land first on the gesture that
          // most needs its members carried. Idempotent against the release
          // above, which is the path that matters.
          for (const el of divided) el.removeAttribute("data-pointer-owned");
        }
      };

      // A gesture the system takes away never sees a `pointerup`, so the mark
      // has no other way off. Nothing commits — a cancelled drag is not a
      // placement — but the members stop being the hand's, because a mark that
      // outlives the listener meant to clear it is a frame the settle skips
      // for the rest of the session.
      const onPointerCancel = (): void => {
        if (rafId !== null) {
          cancelAnimationFrame(rafId);
          rafId = null;
        }
        seam.removeEventListener("pointermove", onPointerMove);
        seam.removeEventListener("pointerup", onPointerUp);
        seam.removeEventListener("pointercancel", onPointerCancel);
        seam.removeAttribute("data-gesture");
        for (const el of divided) el.removeAttribute("data-pointer-owned");
      };

      seam.addEventListener("pointermove", onPointerMove);
      seam.addEventListener("pointerup", onPointerUp);
      seam.addEventListener("pointercancel", onPointerCancel);
    },
    [place, index, onCommit],
  );

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
      className="tug-place-seam"
      data-testid={
        place.kind === "rail" ? "tug-rail-seam" : "tug-column-seam"
      }
      {...(place.kind === "rail"
        ? { "data-rail-seam": `${place.side}:${index}` }
        : { "data-column-seam": `${place.slot}:${index}` })}
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

/**
 * DeckCanvas — plain function component (no `forwardRef`).
 *
 * Renders the responder-chain root and, per mounted workspace, one wrapper
 * holding a TugPane per entry in that workspace's deck ([B06]). Exactly one
 * wrapper is shown; the rest carry no `data-space-shown` and are
 * `display: none`, which is how a workspace switch became a style change
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
  // ---- Store subscription ([D04]) ----
  // Named `store` (not `manager`) to avoid collision with the ResponderChainManager
  // variable below.
  const store = useDeckManager();
  const deckState = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const panes = deckState.panes;
  const cards = deckState.cards;
  const imposition = deckState.imposition;
  // Per-card title overrides are not deck state, so the deck subscription
  // above cannot see one land. The slot-stack picker names its rows with the
  // title bar's own text, which folds an override in, so it needs this too.
  const cardTitleVersion = useSyncExternalStore(
    cardTitleStore.subscribe,
    cardTitleStore.version,
  );
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
        layers.push({ spaceId, shown: true, deck: deckState });
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
        deck: deckState,
      });
    }
    return layers;
  }, [spacesSnapshot, deckState]);
  // Every pane hosting a sidebar card, pinned or dragged loose. They share the
  // z-band above the free panes: a rail must never be occluded by a card, and
  // that is a property of being a rail rather than of any one card on it.
  const sidebarPaneIds = useMemo(
    () => new Set(findSidebarPanes(deckState).map(({ pane }) => pane.id)),
    [deckState],
  );
  // The rails standing on the deck's edges, and the stack membership each
  // sidebar pane derives its frame from. A closed or unpinned sidebar card
  // holds no side and is absent: the arrangement spans what its rail is not
  // taking, which when nothing is pinned is the whole canvas.
  // The runs the deck's two kinds of place divide, measured off the store —
  // the one pair every allocation on this canvas is derived against ([P06]).
  // Read at render rather than stored: a run is a measurement, and the store
  // is the one reader of it.
  const placeRuns: PlaceRuns = {
    rail: store.getRailRunHeight(),
    column: store.getColumnRunHeight(),
  };
  const sidebarRails = sidebarRailsOf(deckState, placeRuns);
  // The strip, when the deck is in flow — the deck's ONE resolution of it
  // ([P09]). Declared up here rather than beside the placements memo it feeds
  // because the inset effect below publishes its width, and the effect order
  // in this file is load-bearing.
  const flowStrip = useMemo(() => deckFlowStrip(deckState), [deckState]);
  const flowOffset = deckState.flowOffset ?? 0;
  // The occupied slots and how each one's panes stand — the deck's ONE reading
  // of its columns ([P11]). Declared here for the same reason the strip is: the
  // inset effect below publishes the seam fractions, and the effect order in
  // this file is load-bearing.
  const deckColumns = useMemo(
    () => deckColumnsOf(deckState, placeRuns.column),
    [deckState, placeRuns.column],
  );
  // How far each overflowing column has slid its strip up behind the run
  // ([P12]) — the vertical twin of `flowOffset`, and per-slot because each
  // column scrolls on its own. Published by the inset effect below.
  const columnOffsets = deckState.columnOffsets ?? EMPTY_COLUMN_OFFSETS;
  // And the same number per SIDE, for the rails that overflow ([P12]).
  const railOffsets = deckState.railOffsets ?? EMPTY_RAIL_OFFSETS;
  // Each member's standing in its column, for the panes that have one. Only a
  // SPLIT column of two or more contributes: a stacked column and a column of
  // one take the undivided run, which is the frame they had before a slot could
  // be divided at all.
  const columnMemberByPaneId = useMemo(() => {
    const map = new Map<string, ColumnMemberPlacement>();
    for (const column of deckColumns) {
      if (!columnDrawsSplit(column)) continue;
      const strip = stripCoordinatesOf(column.allocation);
      column.members.forEach((paneId, index) => {
        map.set(paneId, {
          slot: column.slot,
          index,
          count: column.members.length,
          standing: column.allocation?.standing ?? "shared",
          ...(strip === undefined ? {} : { strip }),
        });
      });
    }
    return map;
  }, [deckColumns]);
  // And the arrangement each member's column is SET to, which is a different
  // question from the one above: membership never destroys an arrangement, and
  // a slot split while it holds one card is split from that moment even though
  // its lone member goes on taking the undivided run. The badge in a pane's
  // cluster names the arrangement — so it reads THIS map, and reads the
  // placement above only for the band index and the depth ([D121]).
  const columnModeByPaneId = useMemo(() => {
    const map = new Map<string, ColumnMode>();
    for (const column of deckColumns) {
      for (const paneId of column.members) map.set(paneId, column.mode);
    }
    return map;
  }, [deckColumns]);
  // The seat each ARRIVING pane draws at while it is hidden ([B08]). A
  // marked pane is left out of `deckColumns` by construction, so its column
  // here is the standing members' column: split with someone standing, and
  // the newcomer sits at the run's bottom over the neighbour that will
  // shrink; otherwise — a stacked column, or a slot it has to itself — it
  // takes the undivided run, which is the frame it will have once revealed.
  const arrivingSeatByPaneId = useMemo(() => {
    const map = new Map<string, ArrivingSeat>();
    const marks = deckState.arriving;
    const kind = deckState.imposition.kind;
    if (marks === undefined || kind === undefined) return map;
    for (const pane of deckState.panes) {
      if (marks[pane.id] !== true) continue;
      if (pane.slot === undefined) continue;
      const slot = clampSlot(kind, pane.slot);
      const column = deckColumns.find((c) => c.slot === slot);
      map.set(
        pane.id,
        column !== undefined &&
          column.mode === "split" &&
          column.members.length > 0
          ? "bottom"
          : "run",
      );
    }
    return map;
  }, [deckState, deckColumns]);
  const railWidthOf = (side: SidebarSide): number =>
    sidebarRails.find((rail) => rail.side === side)?.width ?? 0;
  // The held-open deck edge ([B10]). A side with no rail has no frame the
  // drop-zone engine could read a zone from, so while exactly one rail
  // stands — the only shape in which a rail card can be in the air over an
  // empty side — a tile stands at the other side's anchor, at the width the
  // dragged card's own rail takes. That is the standing rail's width: with
  // one rail on the deck, every rail card in the air came from it, and the
  // tile reads that rail's live width property so a width drag moves it in
  // the same reflow. Nothing in the imposition remembers a width for an
  // empty side (a rail's width is its widest member's, [F08]), so there is
  // no stored width to prefer over the card's own.
  const vacantRails: { side: SidebarSide; style: React.CSSProperties }[] = [];
  if (sidebarRails.length === 1) {
    const standing = sidebarRails[0];
    const side: SidebarSide = standing.side === "left" ? "right" : "left";
    vacantRails.push({
      side,
      style: imposeSidebarStyle(side, standing.width, {
        widthProperty: sidebarWidthProperty(standing.side),
      }),
    });
  }
  // Each member's standing on its rail: which side, how many share it, how they
  // stand against one another, and where this one is in that order. The pane
  // renders its own frame from these ([L09]) — a split member's pins are its
  // index's share of the run.
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

  // ---------------------------------------------------------------------------
  // Stable render order
  // ---------------------------------------------------------------------------
  // Stacks are rendered in a stable order (sorted by ID) so that focusCard
  // reordering the store array only changes z-index values -- React never
  // calls insertBefore to move DOM nodes. This preserves the browser's
  // pointer->click event sequence when clicking interactive elements on
  // unfocused stacks: the synchronous pane-activation path on pointerdown
  // updates z-index before click fires, so the stack is already focused.
  //
  // Z-index comes from each stack's position in the *store* array (focus
  // order), not from the stable render order.

  const { sortedStacks, zIndexMap } = useMemo(() => {
    const sorted = [...panes].sort((a, b) => a.id.localeCompare(b.id));
    return { sortedStacks: sorted, zIndexMap: buildZIndexMap(panes, sidebarPaneIds) };
  }, [panes, sidebarPaneIds]);

  // A slot is a stack: every pane holding it, the last one topmost ([D121]).
  // The membership is derived here rather than stored, and here rather than in
  // the pane, for the same reason `placement` is — a pane cannot see its
  // slot's other occupants from its own state. Entries arrive at the title bar
  // display-resolved, so the picker needs no store access.
  //
  // Keyed on `panes`/`cards` rather than on the whole deck snapshot so a pane's
  // `slotStack` prop — and therefore the picker's `items` array — keeps a
  // stable identity across renders that changed neither.
  const slotStackByPaneId = useMemo(() => {
    // A picker row shows the title bar's own text, which folds in the live
    // override a card publishes on `cardTitleStore`. That store is not the
    // deck, so the memo above would never see an override land — subscribing
    // to its revision is what makes a Session card that has just bound to a
    // project rename its row as well as its title bar. [L02]
    void cardTitleVersion;
    const cardsForTitles = new Map(cards.map((c) => [c.id, c]));
    // A pane stands in a stack when it shares a PLACE with other panes, and the
    // deck has two kinds of place: a numbered slot, and a side's rail. Both are
    // front-to-back stacks of full-size panes, so both get the same badge and
    // the same picker — the rail was the one that had to be taught, because a
    // rail's members are found through the imposition rather than off the pane.
    // Membership and mode only, so the places' runs are beside the point and
    // no allocation is asked for.
    const rails = sidebarRailsOf(deckState, UNMEASURED_RUNS);
    const railSideOf = new Map<string, SidebarSide>();
    for (const { componentId, pane } of findSidebarPanes(deckState)) {
      if (!isSidebarPinned(imposition, componentId)) continue;
      railSideOf.set(pane.id, sidebarSide(imposition, componentId));
    }
    const byPlace = new Map<string, TugPaneState[]>();
    for (const pane of panes) {
      const railSide = railSideOf.get(pane.id);
      const place =
        railSide !== undefined
          ? `rail:${railSide}`
          : pane.slot === undefined
            ? undefined
            : `slot:${pane.slot}`;
      if (place === undefined) continue;
      const members = byPlace.get(place);
      if (members) members.push(pane);
      else byPlace.set(place, [pane]);
    }
    const paneById = new Map(panes.map((pane) => [pane.id, pane]));
    const map = new Map<string, readonly SlotStackEntry[]>();
    for (const [place, members] of byPlace.entries()) {
      // A SPLIT rail's rows are a different list from a stack's, because the
      // question they answer is different. In a stack the rows are a depth
      // order and the check marks the one card you can actually see. In a
      // split nothing is occluded: the rows read top to bottom, the order the
      // eye reads the rail in, and the check marks the FOCUSED member — the
      // pane the deck would act on — with nothing checked when focus rests
      // outside the rail. Checking the topmost there would be a claim about
      // z-order dressed up as a claim about what you are looking at.
      const splitRail = rails.find(
        (rail) => `rail:${rail.side}` === place,
      );
      const ordered =
        splitRail === undefined
          ? // Topmost first, matching the host menu-state convention.
            [...members].reverse()
          : splitRail.members
              .map((member) => paneById.get(member.paneId))
              .filter((pane): pane is TugPaneState => pane !== undefined);
      const entries: SlotStackEntry[] = ordered.map((pane, i) => {
        // A row is a miniature of the title bar it stands for, so it takes
        // both of that title bar's parts from the same places the title bar
        // does: the icon off the active card's registration, and the title
        // through the one composer in `lib/pane-title.ts`. Resolved here
        // rather than in the pane because the title bar renders its picker
        // from props alone and reaches for neither a registry nor a store.
        const activeCard = cardsForTitles.get(pane.activeCardId);
        const icon = activeCard
          ? getRegistration(activeCard.componentId)?.defaultMeta.icon
          : undefined;
        return {
          paneId: pane.id,
          cardId: pane.activeCardId,
          title: paneTitleBarTextFor(pane, cardsForTitles),
          ...(icon === undefined ? {} : { icon }),
          selected:
            splitRail === undefined
              ? i === 0
              : pane.id === deckState.activePaneId,
        };
      });
      for (const pane of members) map.set(pane.id, entries);
    }
    return map;
  }, [panes, cards, cardTitleVersion, deckState, imposition]);

  // Build a cardId → hostStackId map so `CardHost` can look up its
  // host stack without re-scanning the stacks array on every render.
  const hostStackIdByCardId = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of panes) {
      for (const cid of s.cardIds) map.set(cid, s.id);
    }
    return map;
  }, [panes]);

  // Build a cardId → CardState map once per render. Consumed by the stack
  // render loop (active-card lookup, componentId resolution) and by the
  // card render loop. Hoisted out of `.map()` so the Map isn't rebuilt per
  // stack.
  const cardsById = useMemo(() => {
    const map = new Map<string, typeof cards[number]>();
    for (const c of cards) map.set(c.id, c);
    return map;
  }, [cards]);

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
      [TUG_ACTIONS.NEW_SPACE]: () => {
        store.createSpace();
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
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

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
  // the chain rides read ONE number. A width drag rewrites that one property
  // (`TugPane`'s `handleSidebarResizeStart`) and the whole arrangement
  // re-resolves in the browser's next reflow: the rail grows off its own pinned
  // edge and the cards re-impose live under the moving edge, which is the same
  // response the deck already gives a window resize.
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
    for (const side of ["left", "right"] as const) {
      const width = railWidthOf(side);
      el.style.setProperty(sidebarWidthProperty(side), `${width}px`);
      el.style.setProperty(
        `--tug-imposer-inset-${side}`,
        width === 0
          ? "0px"
          : railSpanInset(`var(${sidebarWidthProperty(side)})`),
      );
      // Both sides are written on every pass, and every index past the current
      // gap count is removed rather than left standing. A rail going three
      // members to two would otherwise leave seam 1 behind, and a frame reading
      // it would be pinned to a seam that is no longer anywhere.
      //
      // An overflowing rail reads no seams and a shared one reads no offset, so
      // the two writes are exclusive by construction — the same discipline the
      // columns below keep, and for the same reason: a side crossing the
      // boundary in either direction must not leave a stale number a frame
      // could still pin itself against.
      const rail = sidebarRails.find((r) => r.side === side);
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
      // The other half of that exclusivity: the offset stands only while the
      // side overflows, and is swept the moment it stops.
      if (railOverflows) {
        el.style.setProperty(
          railOffsetProperty(side),
          `${Math.round(railOffsets[side] ?? 0)}px`,
        );
      } else {
        el.style.removeProperty(railOffsetProperty(side));
      }
      // The strip coordinates ride with the offset, for the same reason and on
      // the same terms: an overflowing member's frame pins to the coordinate
      // above it and the one below it, so a side that stops overflowing must
      // not leave one standing. There are `n + 1` of them for `n` members —
      // every top, then the strip's own end, which the offset clamp reads — so
      // the sweep runs one index further than the seams' does.
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
    // The column seams, written per slot and swept the same way the rails' are:
    // every index past a column's live seam count is removed, and every slot
    // the largest arrangement could have is visited whether or not it currently
    // holds panes. A column that lost a member — or a whole slot that emptied,
    // or a kind change that took the slot away — would otherwise leave a seam
    // property standing for a frame to pin itself against.
    // An overflowing column reads no seams and a shared one reads no offset,
    // so the two writes are exclusive by construction: a slot publishes one or
    // the other, and whichever it is not is swept away in the same pass. That
    // is what keeps a column crossing the boundary in either direction from
    // holding a stale number a frame could still pin itself against.
    const overflowing = (column: DeckColumn): boolean =>
      column.allocation?.standing === "overflow";
    const seamsBySlot = new Map(
      deckColumns.map((column) => [
        column.slot,
        overflowing(column) ? [] : column.seams,
      ]),
    );
    const offsetBySlot = new Map(
      deckColumns
        .filter(overflowing)
        .map((column) => [column.slot, columnOffsets[column.slot] ?? 0]),
    );
    const stripBySlot = new Map(
      deckColumns.map((column) => [
        column.slot,
        stripCoordinatesOf(column.allocation) ?? [],
      ]),
    );
    const columnRun = store.getColumnRunHeight();
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
      // The slot's strip coordinates, on the rails' terms exactly: written for
      // an overflowing column, swept for a sharing one, and swept one index
      // past the seams because `n` members make `n + 1` coordinates.
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
      // The gauge channel carries the same number to instruments outside the
      // canvas ([P08]). It rides the COMMITTED write as well as the per-frame
      // one so a gauge and the deck agree at rest, not only mid-gesture, and
      // it is a fraction of the run for the reason the whole channel is
      // fractional: the miniature's field is this run at another scale.
      publishColumnOffset(
        slot,
        offset === undefined || columnRun === null || columnRun <= 0
          ? null
          : offset / columnRun,
      );
    }
    // Both flow properties are written together or removed together: a strip
    // width standing without an offset (or the reverse) would clamp one frame
    // against a viewport the other does not believe in. In fit they are absent
    // and `imposeStyle`'s fit expression never reads them.
    if (flowStrip === null) {
      el.style.removeProperty(FLOW_OFFSET_PROPERTY);
      el.style.removeProperty(FLOW_STRIP_PROPERTY);
    } else {
      el.style.setProperty(FLOW_OFFSET_PROPERTY, `${Math.round(flowOffset)}px`);
      el.style.setProperty(FLOW_STRIP_PROPERTY, `${flowStrip.width}px`);
    }
    const flowBand = store.getBandWidth();
    publishFlowOffset(
      flowStrip === null || flowBand === null || flowBand <= 0
        ? null
        : flowOffset / flowBand,
    );
    // `railWidthOf` and both seam sweeps read `sidebarRails` and `deckColumns`,
    // which `railSummary` summarises — the widths, modes, and fractions in it
    // are exactly what this effect writes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    const observer = new ResizeObserver(() => {
      if (!seenInitial) {
        seenInitial = true;
        return;
      }
      if (retuneTimerRef.current !== null) {
        window.clearTimeout(retuneTimerRef.current);
      }
      retuneTimerRef.current = window.setTimeout(() => {
        retuneTimerRef.current = null;
        store.retuneSidebarAllocation();
      }, RESIZE_RETUNE_QUIET_MS);
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
      if (retuneTimerRef.current !== null) {
        window.clearTimeout(retuneTimerRef.current);
        retuneTimerRef.current = null;
      }
    };
  }, [store]);

  // ---------------------------------------------------------------------------
  // Settling into a new arrangement
  // ---------------------------------------------------------------------------
  // A change to the ARRANGEMENT moves derived frames without anyone touching
  // them: a rail crossing to the other side, an N-up swap, the pin coming
  // back, a card sent to another slot. The frames cross to their new places
  // rather than cutting, and the crossing is FLIP: React commits the final
  // geometry in one layout pass, and each moved frame is then tweened by a
  // transform that starts at the inverse of the move and ends at nothing.
  // Appearance only, written straight to the DOM, never through React state
  // ([L06]); the motion itself goes through TugAnimator ([L13]).
  //
  // FLIP rather than a transition on `left`/`top`/`width` because transitioning
  // layout properties re-runs layout for every moving frame on every frame of
  // the motion. A transform tween in the accelerated form (`lib/pane-flip.ts`
  // holds the rules) costs one compositing walk when it starts, one when it
  // ends, and nothing in between — see
  // `arc/jul30-perf-brief.md#i1-sparkline-exception`.
  //
  // The trigger is a signature over exactly what the imposer reads — the
  // record, plus which pane holds which slot. Watching the record alone would
  // make a slot assignment animate or cut depending on whether it happened to
  // land inside some earlier change's window, and a gesture that sometimes
  // crosses and sometimes jumps is worse than one that always jumps.
  //
  // The work is split across a store subscriber and a layout effect because
  // FLIP needs both sides of the commit. A store subscriber runs BEFORE the
  // re-render it causes, so it is the only place that can see where the frames
  // are now (First); the layout effect runs after the commit and before paint,
  // so it is where they can be measured in their new places (Last). Nothing is
  // painted between the two, which is what makes the inversion invisible.
  //
  // The timing lives in one place: `IMPOSITION_SETTLE_MS` reaches CSS as
  // `--tugx-imposer-settle-duration` and the resolved value is read back, so an
  // override on the container retimes the tween and the attribute together.
  // What `animate()` is handed is that RAW number, because TugAnimator scales
  // its own durations by `getTugTiming()`; the window timer is handed the
  // scaled product, so the two can never disagree.
  const arrangement = arrangementSignature(deckState, placeRuns);
  const arrangementRef = useRef(arrangement);
  const settleTimerRef = useRef<number | null>(null);
  /**
   * Re-arms the settle's window sweep — the timer that takes the settling
   * mark off and snaps whatever is still in flight. `arm` writes it and arms
   * the sweep at the crossing's nominal; the Last pass re-arms it once it
   * knows the choreography, whose window is the sum of its beats and can be
   * longer than any one recipe's. Takes SCALED milliseconds.
   */
  const settleSweepRef = useRef<((windowMs: number) => void) | null>(null);
  /**
   * Releases the session stores' notification hold, once per settle, and
   * records which clock did it. The settle's own completion is the release
   * on the normal path — after the final beat's last tween, on the far side
   * of every frame's residue, fold crossing and resize episode ([B04] of
   * `three-beat-settle`); the window sweep and the unmount are the guards
   * behind it. `settleReleasedRef` is what makes the three one release:
   * whichever fires first releases, and the others find nothing to do.
   */
  const settleReleaseRef = useRef<
    ((source: "completion" | "sweep" | "unmount") => void) | null
  >(null);
  const settleReleasedRef = useRef(true);
  /**
   * Which launch the running choreography belongs to. A beat's completion
   * launches the next beat, and a retarget that landed in between has already
   * cancelled, restored and re-planned every frame — so a chain that outlives
   * its launch must stop rather than put a stale beat on a frame another
   * settle now owns. Bumped by every Last pass that launches.
   */
  const settleGenerationRef = useRef(0);
  /** Where each non-gesturing frame sat before the commit, by pane id. */
  const settleFirstRectsRef = useRef<Map<string, DOMRect>>(new Map());
  /**
   * The fold facts each frame carried before the commit, by pane id — whether
   * it was folded, and how tall its content box was.
   *
   * Kept apart from `settleFirstRectsRef` because the rect map is read by the
   * departure ghosts and by `flipDelta`, and neither has anything to do with
   * the fold. These two are read once, by the tween pass, to decide whether a
   * frame is crossing the fold and what height to hold its interior at
   * ([B04] of `session-fold-still-interior`).
   *
   * The content height is the box's, not the frame's, because that is the box
   * the held interior overflows; the difference between the two is chrome that
   * the fold does not move.
   */
  const settleFirstFoldsRef = useRef<
    Map<string, { folded: boolean; contentHeight: number | null }>
  >(new Map());
  /**
   * Which edge each frame stood pinned to before the commit, by pane id —
   * `data-rail-side`, read at arm and absent for every frame that is not a
   * rail.
   *
   * Read by the depart beat alone, and read there because that is the one
   * question a ghost cannot answer for itself: the pane it stands for has
   * already left the deck, so the side it stood on is only knowable from the
   * near side of the commit. An arriving rail is not in this map and does not
   * need to be — its own frame is in the document and carries the attribute.
   */
  const settleFirstRailSidesRef = useRef<Map<string, SidebarSide>>(new Map());
  /**
   * Where each side's rail shadow stood before the commit, by side.
   *
   * The shadow strip is the canvas's, not the pane's ([D183]'s one-per-side
   * rule), so a departing rail unmounts it and there is nothing left to
   * animate — the same problem the pane ghost solves, one element over. This
   * is what a shadow ghost is planted from, and it is read on the near side of
   * the commit for the same reason every other First fact is.
   */
  const settleFirstRailShadowsRef = useRef<Map<SidebarSide, DOMRect>>(
    new Map(),
  );
  /**
   * The tweens running on each frame, by pane id — DOM zone, never React
   * state. At most two per settle: the one effect carrying every geometry term
   * the frame crosses ([D135] — move and size share a clock or a pinned edge
   * is not pinned), and a hold when a column mode flip commits it behind the
   * survivor.
   */
  /**
   * The tweens a settle has in flight, by pane.
   *
   * `restores` rides along with them because a cancelled tween's inline residue
   * has to be handed back on the SAME tick as the cancel. TugAnimator commits
   * an animation's final value into `el.style` when it finishes — and
   * `snap-to-end` finishes it — so a frame whose tween is retargeted mid-flight
   * is left wearing a baked pixel `width`/`height` from the arrangement it was
   * leaving. The completion handler that would normally take those back runs a
   * microtask later, and a microtask is long enough to paint: the frame renders
   * once at a stale size against fresh `calc()` geometry, which is a flash on
   * exactly the gesture that is already the most confusing one to watch.
   */
  const settleTweensRef = useRef<Map<string, SettleTween>>(new Map());
  /**
   * Every departure ghost standing right now, by the pane it stands for.
   *
   * The one owner of a ghost's lifetime, and the reason it exists is that
   * there used not to be one. A ghost was held in the `departures` array of
   * one Last pass's closure and taken away by that chain's `depart` beat
   * landing — which is a guarantee only for a chain that reaches its beat. A
   * retarget landing between the plant and the launch returns out of `runBeat`
   * before anything is launched, so no completion ever runs, so the tile
   * stands in the document for the life of the canvas. One per close
   * interrupted at exactly the wrong moment, and nothing in the deck would
   * ever notice: a ghost carries nothing and answers to nothing, which is
   * what makes it safe and also what makes a stranded one invisible.
   *
   * So a ghost is registered the moment it is planted and removed BY NAME at
   * every way out of a settle — the `depart` beat's landing, the window sweep,
   * a retarget's `arm`, and the canvas unmount ([B05]). A ghost is in none of
   * the records `arm` walks: it stands for a pane that has already left the
   * deck, so it has no First rect, no frame, and no later pass will ever
   * collect it again. This map is the only thing that can hand it back.
   *
   * `launched` is what makes the retarget's exit precise rather than blunt.
   * A ghost whose `depart` fade is in flight already has a landing coming that
   * runs UNCONDITIONAL on the generation, so `arm` leaves it to fade out as
   * the reader is watching it do. A ghost whose fade never launched has
   * nothing coming for it at all, and that is the one `arm` takes. Sweeping
   * both would cut a departure's fade the instant a second close landed
   * beside it — two cards closed in one gesture is an ordinary thing to do,
   * and each of them is owed its own ghost for its own beat ([B06]).
   */
  const departureGhostsRef = useRef<
    Map<string, { ghost: HTMLElement; launched: boolean }>
  >(new Map());
  /**
   * Take standing ghosts away. Idempotent, and safe to call from a path that
   * has already been swept — the map is the record, and an empty one is the
   * answer that nothing is standing.
   *
   * `which` says how far it reaches. `"all"` is for the paths where nothing
   * is coming for anything — the window sweep and the canvas unmount. `"unlaunched"`
   * is the retarget's, and takes only the ghosts whose fade never started.
   */
  const removeDepartureGhosts = useCallback(
    (which: "all" | "unlaunched"): void => {
      for (const [paneId, entry] of [...departureGhostsRef.current]) {
        if (which === "unlaunched" && entry.launched) continue;
        entry.ghost.remove();
        departureGhostsRef.current.delete(paneId);
      }
    },
    [],
  );
  const removeDepartureGhostsRef = useRef(removeDepartureGhosts);
  removeDepartureGhostsRef.current = removeDepartureGhosts;
  /**
   * The hold plan for the columns whose mode flipped this settle, computed
   * when the settle arms and consumed by the Last pass.
   *
   * A column mode flip is a cover, not a fade ([B02] of
   * `briefs/column-flip-cover-brief.md`). Exactly one member — the
   * **survivor** — moves, and it moves as one fused beat, because its
   * translate and its height change are the same edge (Stack Column from the
   * bottom tile: the top edge rises to the column top and the bottom edge
   * stays), and playing them in sequence opens an interval in which the
   * survivor has left one tile and not yet claimed the other ([B01]). Every
   * other member is **covered**: committed behind the survivor, animating
   * nothing, wearing `data-imposer-covered` so the cut census can read a move
   * it could not see. On a stack the covered members are also **held**:
   * each keeps its old tile inline until the survivor has grown over it,
   * because the commit has already moved it to the full run and letting that
   * landing show would be the card sliding across the column. On a split
   * nothing is held — a revealed member is simply at its tile behind the
   * survivor, uncovered as the survivor retreats ([F06]).
   *
   * Every hold and every cover is released at the beat chain's one completion
   * and never on a clock of its own ([B03]): a hold that ends before the
   * survivor has covered the frame is the frame reappearing.
   *
   * The survivor is the column's **z-frontmost** member, because that is the one
   * a stack actually shows: stacked members all draw the same rect and z-order
   * alone decides which of them you see. Picking by column order instead would
   * animate the top tile into the full run while the card the stack goes on to
   * display is a different one entirely — the growth would belong to a frame
   * that ends up hidden, and the visible card would arrive by a cut.
   *
   * The survivor is therefore not always the top tile, and on the way out of a
   * split it may have to travel: a frontmost BOTTOM member crosses up to the
   * run's top as it grows. That is a real translate plus a real height tween —
   * no smear either way ([D135]) — so the correct card being the moving one
   * costs nothing but the motion the eye was already expecting.
   */
  const settleHoldPlanRef = useRef<{
    /** One per flipped column: plans a fused beat. */
    survivors: Set<string>;
    /** Every other member of a flipped column: covered until the chain's end. */
    covered: Set<string>;
    /** The covered members leaving a tile (a stack): held at it inline. */
    held: Set<string>;
  }>({ survivors: new Set(), covered: new Set(), held: new Set() });
  /** Each column's mode as of the last settle, keyed by slot, so a mode flip is
   *  detectable when the next one arms. A rail keeps no such record: it is
   *  always divided ([B01]), so its mode never flips. */
  const prevColumnModesRef = useRef<Map<number, ColumnMode> | null>(null);
  /** The raw (unscaled) settle duration read back for the current gesture. */
  const settleDurationRef = useRef(IMPOSITION_SETTLE_MS);
  /**
   * What a velocity-matched retarget needs ([P04]), across beats.
   *
   * `settleBeatRef` is the beat the running settle is on — its kind, when it
   * launched, and the velocity it was launched with — written by the Last
   * pass as each beat starts and cleared when the settle finishes. `arm`
   * reads the interrupted velocity off THAT beat's recipe at that beat's
   * elapsed time, never off the crossing regardless of which beat was up,
   * and leaves it in `settleLaunchRef` with the kind it belongs to; the Last
   * pass consumes it and resets it, so a settle that was NOT interrupted
   * always launches from rest. The velocity goes only to the replacement
   * choreography's beat of the same kind — `beatLaunchVelocity` in
   * `lib/pane-flip.ts` says why the other kinds launch from rest ([B06]).
   *
   * One record for the whole settle rather than one per frame, because every
   * frame in a beat rides the same curve — they were all launched together
   * and interrupted together.
   */
  const settleLaunchRef = useRef<InterruptedBeat | null>(null);
  const settleBeatRef = useRef<{
    kind: BeatKind;
    launchedAt: number;
    initialVelocity: number;
    /** Every tween this beat launched, so an arm can ask whether it is over. */
    anims: readonly TugAnimation[];
    /**
     * Land the beat: take off what it held and leave every frame exactly
     * where the beat put it. Idempotent, and the ONE place that work lives —
     * the beat's own completion handler calls it a promise hop after the
     * tweens end, and `arm` calls it first when it finds the tweens already
     * over. That second door is load-bearing: under `fill: none` an effect
     * stops contributing the instant its time is up, but the promise that
     * takes the hold off lands in the NEXT rendering update. A commit landing
     * in between — a close pressed as the arrival finishes — reads a frame
     * whose screen shows the end pose and whose DOM says the start pose.
     * `commitStyles()` writes what the DOM says, and the frame cuts a card's
     * width to a place it was already standing ([P08]).
     */
    land: () => void;
  } | null>(null);
  /**
   * The open resize episode on each frame, by pane id — DOM zone, never React
   * state.
   *
   * A settle that changes a frame's width re-wraps everything inside it, and
   * the `scrollTop` a scroller was left at names different content afterwards.
   * The episode brackets that: armed with the OLD geometry still on screen, so
   * each scroller captures what the user is looking at before it moves, and
   * ended once the new geometry has settled.
   */
  const settleEpisodesRef = useRef<Map<string, ResizeEpisodeHandle>>(new Map());

  // Hold every session card's notifications for the length of the
  // gesture, and release them on the same edges the tweens land on.
  //
  // A React commit landing INSIDE the window is not merely one more
  // commit: measured on release, the settle alone cost 343 walk samples
  // and a commit stream alone 654, but the two together cost 1809 —
  // 81% above their sum, with median frame delivery going 17ms to 20ms
  // and four times the dropped frames
  // (`arc/jul30-perf-brief.md#s5-imposer`). A commit while a
  // transform animation is running dirties compositing with the
  // animation's extent already reserved, which forces exactly the
  // recompute that reservation exists to avoid.
  //
  // Nothing is dropped — the events reduce and run their effects as
  // they arrive, and only the React notification waits, flushing once
  // at release. The cap is the store's own guard against a holder that
  // never comes back; release below is what normally ends it.
  const holdSessions = useCallback((capMs: number) => {
    cardServicesStore.forEachCodeSessionStore((store) => {
      store.holdNotifications(capMs);
    });
  }, []);
  const releaseSessions = useCallback(() => {
    cardServicesStore.forEachCodeSessionStore((store) => {
      store.releaseNotifications();
    });
  }, []);

  // The lifecycle, on a ref so the settle's effects do not re-key on it. The
  // canvas renders inside `CardLifecycleContext.Provider` (see the provider
  // list in `DeckManager`'s `reactRoot.render`), so this is non-null in the
  // app and null in a fixture that mounts the canvas alone.
  const cardLifecycle = useCardLifecycle();
  const cardLifecycleRef = useRef(cardLifecycle);
  cardLifecycleRef.current = cardLifecycle;

  /**
   * The frames that are ARRIVING — held invisible by a Last pass and not yet
   * launched into their arrive beat.
   *
   * A frame is arriving until its arrive beat runs, and a retarget in between
   * does not change that. Without this record it did: `arm` measured the held
   * frame's First rect like any other, so the replacement Last pass read it as
   * TRAVELLING — it had a First rect now — planned no arrive beat, ran the
   * unfused shrink/move/grow chain because nothing was arriving any more, and
   * the retarget's own restorers had already taken the opacity hold off, so
   * the card popped in at full opacity a beat before the room was made. One
   * arrangement change landing inside the arrival window was enough: three
   * motions and a pop where the contract is two ([P08]).
   *
   * So `arm` skips a pending frame — no First rect, no restore, no cancel —
   * and the Last pass finds it exactly as an arrival again: still held, still
   * owed its beat, and enough to keep the replacement settle fused. Entries
   * leave when their arrive beat launches, and the whole set is emptied when a
   * settle releases, since nothing is pending past the end of the settle.
   */
  const pendingArrivalsRef = useRef<Set<string>>(new Set());

  /**
   * Fire `cardDidArrive` for every card the deck holds that is still marked
   * arriving — the UNCONDITIONAL DRAIN, and the whole of [R01]'s answer.
   *
   * A mark is made in `addCard` and is meant to be cleared by the arrive beat
   * ending. The beat is not guaranteed to run. `arm` measures a First rect for
   * an arriving frame like any other, so a second arrangement change landing
   * inside the settle re-reads that frame as TRAVELLING rather than arriving —
   * it has a First rect now — and no arrive beat will ever be planned for it.
   * The card is on screen and still, and the caller waiting on its arrival
   * waits forever: a picker that never opens, a deck that never travels.
   *
   * So the drain is called from every place a settle can end rather than from
   * the one that normally ends it — the completion, both early returns, the
   * window sweep, and the unmount. It is idempotent (`notifyCardDidArrive`
   * clears the mark before firing, and the one-shot subscribers unsubscribe
   * themselves), so calling it from five places costs nothing and reasoning
   * about which place owns a given arrival costs a defect.
   */
  const drainArrivals = useCallback(() => {
    const lifecycle = cardLifecycleRef.current;
    if (lifecycle === null) return;
    // Off the store rather than the rendered snapshot: the drain runs from
    // timers and teardowns, and what it wants is the panes the deck holds NOW.
    for (const pane of store.getSnapshot().panes) {
      for (const cardId of pane.cardIds) {
        lifecycle.notifyCardDidArrive(cardId);
      }
    }
  }, [store]);
  const drainArrivalsRef = useRef(drainArrivals);
  drainArrivalsRef.current = drainArrivals;

  // Drop a frame's tween registration and, crucially, the inline `transform`
  // TugAnimator leaves on it — along with the `transform-origin` the tween was
  // anchored by, which is the settle's to write and the settle's to take away.
  //
  // TugAnimator commits an animation's final value into `el.style` when it
  // completes — unconditionally, whatever `fill` says, and `cancel()` in
  // snap-to-end mode takes the same path. Here that final value is
  // `translate(0px, 0px)`, and React will never remove it: `transform` is not
  // among the style keys TugPane renders, and React only clears keys it set
  // itself. A frame left wearing any transform is a containing block for its
  // `position: fixed` descendants — and TugSheet portals into the frame, while
  // completion popups, alerts, and banners all position from viewport
  // coordinates — so the residue would offset every one of them by the pane's
  // origin, and only after the first arrangement change. Removing it is not
  // tidiness; it is what keeps the frame's geometry the store's to own ([L09]).
  //
  // The size and fade tweens leave residue of their own — a committed pixel
  // length where React rendered `auto` or a `calc()`, a committed opacity —
  // and each settle's completion handler hands those back itself, because it
  // is the one holder of the values it displaced. This function owns only
  // what every settle writes the same way.
  //
  // Idempotent by construction, because it runs more than once per frame: the
  // completion handler, the window sweep, and effect teardown all call it, and
  // a cancelled tween's handler lands a microtask later — after a replacement
  // settle may already have been registered, which is why the registry entry
  // is only dropped when it still belongs to the settle that finished.
  const clearFlipRef = useRef(
    (paneId: string, el: HTMLElement, anims: readonly TugAnimation[]): void => {
      const entry = settleTweensRef.current.get(paneId);
      if (entry?.anims === anims) {
        settleTweensRef.current.delete(paneId);
      }
      el.style.removeProperty("transform");
      el.style.removeProperty("transform-origin");
      // The cover a column mode flip put on a revealed member — committed
      // behind its survivor, uncovered as the survivor retreats. It comes
      // off with the survivor's release, and here so that every path that
      // ends a settle (the sweep, a retarget's cancel, teardown) takes it
      // off too: a mark that outlived its settle would blind the cut census
      // to that frame for good.
      el.removeAttribute("data-imposer-covered");
    },
  );

  // First, and the arming. A LAYOUT effect, not a passive one ([L03]): this
  // registers the store subscriber that measures every frame's outgoing
  // geometry, and a subscription that lands after paint is a subscription that
  // was not there for whatever the mount raced. An arrangement change committed
  // in that gap arms nothing, and the frames it moves cut — the one defect on
  // this surface that only ever shows up on a fresh mount, which is exactly
  // where it is hardest to see.
  useLayoutEffect(() => {
    const clearFlip = clearFlipRef.current;
    // **A canvas inherits no residue.** An exit ghost stands outside React's
    // tree and a rail shadow's slide writes an inline transform, so neither is
    // anything a re-render can take back — and a canvas that comes up over a
    // previous one's leavings shows them for the rest of its life. That is the
    // ordinary case under HMR, where the module is replaced and the DOM is
    // not: a stripe stranded by the code being edited stays on screen through
    // every update that fixes it, which reads as the fix not working.
    //
    // Swept at MOUNT for that reason, against the document rather than against
    // the records — the records belong to the instance that just went away.
    {
      const canvas = containerRef.current;
      if (canvas !== null) {
        for (const ghost of canvas.querySelectorAll(".tug-pane-exit-ghost")) {
          ghost.remove();
        }
        for (const strip of canvas.querySelectorAll<HTMLElement>(
          ".tug-rail-shadow",
        )) {
          if (strip.hasAttribute("data-exit-ghost-for")) {
            strip.remove();
          } else {
            strip.style.removeProperty("transform");
            strip.style.removeProperty("opacity");
          }
        }
      }
    }
    const releaseSettle = (
      source: "completion" | "sweep" | "unmount",
    ): void => {
      if (settleReleasedRef.current) return;
      settleReleasedRef.current = true;
      releaseSessions();
      deckTrace.record({ kind: "settle-release", source });
      pendingArrivalsRef.current.clear();
    };
    settleReleaseRef.current = releaseSettle;
    // The window sweep. Every tween should have finished and swept itself by
    // the time this fires; the sweep is what guarantees no frame keeps the
    // inline residue if one didn't. Armed by `arm` at the crossing's nominal
    // and re-armed by the Last pass at the choreography's total, so it can
    // never fire in the middle of a beat and snap every frame to its end. It
    // no longer carries the release on the normal path — the settle's own
    // completion does — so the release here is the guard for a settle whose
    // completion never landed.
    const scheduleSweep = (windowMs: number): void => {
      const el = containerRef.current;
      if (el === null) return;
      if (settleTimerRef.current !== null) {
        window.clearTimeout(settleTimerRef.current);
      }
      settleTimerRef.current = window.setTimeout(() => {
        settleTimerRef.current = null;
        for (const [paneId, entry] of [...settleTweensRef.current]) {
          for (const anim of entry.anims) anim.cancel("snap-to-end");
          // The residue, handed back HERE rather than left to the cancelled
          // tweens' own completions: those land a microtask later, on the far
          // side of the marks below, and a height handed back there would arm
          // the shade transition the marks are standing down (see
          // {@link endSettleMarks}). Idempotent — the completion hands back
          // the same captured value again and writes nothing new.
          for (const restore of entry.restores) restore();
          clearFlip(paneId, entry.el, entry.anims);
          // Same sweep for the fold mark: a crossing whose completion handler
          // never landed would leave the interior held and the card waiting on
          // an end that is not coming. Unguarded by id, because the window is
          // over and no crossing of any vintage should outlive it. The still
          // crossing too: a fold's end takes it off, but most held frames
          // were never folding.
          endFoldCrossing(entry.el);
          endStillCrossing(entry.el);
        }
        // After the frames, so the flush inside carries their hand-back.
        endSettleMarks(el);
        // Every ghost this window was still carrying. The sweep is the net for
        // a settle whose completion never landed, and a ghost is the one thing
        // in a settle that no later pass can ever collect ([B05]).
        removeDepartureGhostsRef.current("all");
        // Paired with the marks coming off, here as at every other point they
        // do: "the settle is over" and "the notice went out" are one
        // condition, and a sheet clamped against a frame this sweep just
        // snapped is owed the same measure a completion would have earned it.
        dispatchImposerSettleEnd(el);
        releaseSettle("sweep");
        // Same sweep, for the same reason: an episode the Last pass never
        // reached (no tween on that frame, a window with no animation clock
        // at all) closes here rather than waiting for its own net.
        for (const [, handle] of settleEpisodesRef.current) handle.end();
        settleEpisodesRef.current.clear();
        // Outside every guard above, because the window is over: an arrival
        // still marked here has no beat coming for it, whoever owns the marks.
        drainArrivalsRef.current();
      }, windowMs);
    };
    settleSweepRef.current = scheduleSweep;
    prevColumnModesRef.current = new Map(
      deckColumnsOf(store.getSnapshot(), null).map((c) => [c.slot, c.mode]),
    );
    const arm = (landing: CommitLanding): void => {
      const el = containerRef.current;
      if (el === null) return;
      const state = store.getSnapshot();
      const next = arrangementSignature(state, {
        rail: store.getRailRunHeight(),
        column: store.getColumnRunHeight(),
      });
      if (next === arrangementRef.current) {
        // Nothing the imposer reads moved. Recorded rather than passed over,
        // because "the subscriber ran and found nothing" and "the subscriber
        // never ran" are the same silence otherwise, and only one of them is
        // a defect ([B06]).
        deckTrace.record({
          kind: "settle-arm",
          signature: next,
          panes: 0,
          armed: false,
          landing,
          outcome: "unchanged",
        });
        return;
      }
      arrangementRef.current = next;

      // The commit said the frames are already drawn where it puts them — a
      // per-frame writer catching the store up after the fact ([B01]). There
      // is nothing to carry, so this arm takes the new arrangement as its
      // baseline and launches no settle. It is the whole of what the landing
      // buys: the settle used to have to infer this from proxies, and the only
      // way for a writer to say it was to stay out of the store entirely
      // ([F03]).
      //
      // The mode records still advance, for the same reason they advance under
      // reduced motion: they are the shore the NEXT flip is read against, and
      // one left behind by a cut would read that flip against the wrong one.
      if (landing === "cut") {
        prevColumnModesRef.current = new Map(
          deckColumnsOf(state, null).map((column) => [column.slot, column.mode]),
        );
        deckTrace.record({
          kind: "settle-arm",
          signature: next,
          panes: 0,
          armed: false,
          landing,
          outcome: "declined",
        });
        return;
      }

      // The beat this arm interrupts and the velocity it was carrying, in
      // travels per second. Null when it interrupts nothing, which is the
      // ordinary case now that a release is one commit ([P01]).
      let interrupted: InterruptedBeat | null = null;

      // A retarget: past the signature guard, so this runs only when the
      // arrangement really moved. A ghost whose depart fade never launched has
      // nothing coming for it — the chain that owned it returns out of
      // `runBeat` on the generation check and no completion ever runs, so the
      // tile would stand for the life of the canvas ([B05], [F04]). One whose
      // fade IS in flight keeps it: its landing is unconditional, and cutting
      // it would take the departure off the screen mid-fade.
      removeDepartureGhostsRef.current("unlaunched");

      // First: where every frame the imposer may move is right now. A running
      // tween's transform is included in the rect, which is the point — a
      // second arrangement change mid-motion starts its tween from where the
      // eye actually is. Cancelling comes after the measurement, and is safe at
      // any moment because the tween's last keyframe is no transform at all:
      // there is no wrong pose to snap to.
      // Under reduced motion there will be no tween: the layout snap IS the
      // settle. Measuring would force a layout for rects nobody reads, and
      // holding would defer session notifications against a commit-during-
      // animation cost that cannot arise without an animation — so both are
      // skipped, while cancelling any straggler tween stays unconditional.
      const motion = isTugMotionEnabled();
      const firstRects = settleFirstRectsRef.current;
      firstRects.clear();
      const firstFolds = settleFirstFoldsRef.current;
      firstFolds.clear();
      const firstRailSides = settleFirstRailSidesRef.current;
      firstRailSides.clear();
      const firstRailShadows = settleFirstRailShadowsRef.current;
      firstRailShadows.clear();
      // Open the episodes here, on the near side of the commit, because this
      // is the last moment the old layout is still on screen — a scroller
      // cannot say what the user is looking at once the content has already
      // re-wrapped. Unconditional on `motion`: reduced motion still changes
      // the width, it just changes it in one step, and a step the eye cannot
      // follow is exactly the one worth anchoring.
      const episodes = settleEpisodesRef.current;
      for (const [, handle] of episodes) handle.end();
      episodes.clear();
      // The episode's own safety net is sized from the window it brackets.
      // Read once: the custom property survives from the previous settle, and
      // falls back to the constant before the first one has written it.
      const episodeWindowMs = readSettleMs(el) * getTugTiming();
      // A beat whose tweens are already over is landed HERE, before any
      // frame is measured. Its effects stopped contributing the instant their
      // time was up (`fill: none`), but the handler that takes the holds off
      // runs a promise hop later, in the next rendering update — so a commit
      // landing in that window finds every frame of the beat with the end
      // pose on screen and the START pose in its inline style. Measured like
      // that, First equals Last, the Last pass plans nothing, and the whole
      // beat's worth of frames cut a card's width to where they already were.
      // `playState` answers "finished" from the timeline alone, so the
      // question is answerable synchronously and the record on
      // `settleBeatRef` says what landing means for each kind of beat.
      const beatUp = settleBeatRef.current;
      if (
        beatUp !== null &&
        beatUp.anims.length > 0 &&
        beatUp.anims.every((anim) => anim.raw.playState === "finished")
      ) {
        beatUp.land();
      }
      // The frames this arm carries, in DOM order, each beside the settle it
      // interrupted — collected by a pass that HOLDS and MEASURES, and a
      // second pass below that hands the residue back.
      //
      // The split is what the two writes cost. `hold-at-current` is
      // `commitStyles()` — the running pose written into inline style — and
      // it is layout-neutral by construction: the value it writes is the one
      // already on screen. A RESTORER is the opposite: it puts back the value
      // the frame had before the settle, and a width handed back re-lays out
      // every frame beside it in the strip. Interleaved, that write landed
      // between one frame's `getBoundingClientRect` and the next one's.
      const armed: Array<{
        paneId: string;
        frame: HTMLElement;
        running: SettleTween | undefined;
      }> = [];
      for (const frame of el.querySelectorAll<HTMLElement>(
        SHOWN_PANE_FRAMES,
      )) {
        // A pane the pointer positions writes its own `left`/`top` every
        // frame; motion on top of a pointer lags the pointer. The mark is
        // `data-pointer-owned`, not `data-gesture`: the latter goes on at the
        // press, and a press that never travels leaves the frame the
        // imposer's, so a commit landing during it — the click's reveal —
        // must still carry the frame rather than cut it.
        if (frame.hasAttribute("data-pointer-owned")) continue;
        const paneId = frame.getAttribute("data-pane-id");
        if (paneId === null) continue;
        // Still arriving: not on screen as far as this settle is concerned,
        // so it has no First rect to measure and nothing to hand back yet.
        // The Last pass finds it as an arrival again ([P08]).
        if (pendingArrivalsRef.current.has(paneId)) continue;
        // Hidden and arriving — appended to its column but not yet part of
        // its division ([B01]). Not on screen either, for the same reasons:
        // no First rect, no restore, no cancel. The commit that clears the
        // mark leaves the attribute off the new DOM, so the Last pass of THAT
        // settle finds the frame with no First rect and plays its arrival.
        if (frame.hasAttribute("data-arriving")) continue;
        // A frame caught mid-settle is HELD BEFORE it is measured, and that
        // order is the whole of this branch.
        //
        // It is not snapped to the end it never reached — `hold-at-current`
        // is `commitStyles()` and then a cancel, so the pose the tween is
        // showing this instant becomes the frame's own inline style, and the
        // velocity it was carrying is handed to the beat of the same kind
        // this arm is about to launch, so the card continues rather than
        // stopping and starting again ([P04]). A frame caught mid-resize is
        // held at the size the eye has too, and its First rect is that size,
        // so it is re-planned from where it is.
        //
        // Measuring FIRST is what this used to do, on the reasoning that the
        // rect is measured through the running transform and the hold leaves
        // that transform exactly as measured. The first half of that is not
        // reliable: an accelerated transform lives on the compositor, and
        // `getBoundingClientRect` reads the style the main thread last
        // resolved — which, for a frame whose inline style still carries the
        // START pose of the tween now playing over it, is that start pose
        // rather than the pose on screen. One frame per gesture read that
        // way: its First came back equal to its Last, the Last pass planned
        // no tween for it, and it CUT to its new place while every frame
        // beside it glided — the close-during-an-arrival jump ([P08]).
        //
        // `commitStyles()` is exactly the repair, because it resolves the
        // animation's current value itself rather than asking layout what it
        // thinks. Measuring after it reads a pose that is inline, resolved,
        // and the one on screen. The hand-back stays in the second pass: it
        // writes a value the frame does NOT have, which is a relayout, and a
        // relayout between two frames' measurements is a First rect nobody saw.
        const running = settleTweensRef.current.get(paneId);
        if (running !== undefined) {
          const beat = settleBeatRef.current;
          if (interrupted === null && beat !== null) {
            // Read once: every frame in a beat rides the same curve, and the
            // velocity is the beat's own recipe at the beat's own elapsed
            // time, off the spring it was actually launched with.
            interrupted = {
              kind: beat.kind,
              velocity: velocityAt(
                BEAT_RECIPE[beat.kind],
                {
                  nominalMs: settleDurationRef.current,
                  initialVelocity: beat.initialVelocity,
                },
                performance.now() - beat.launchedAt,
              ),
            };
          }
          deckTrace.record({
            kind: "settle-retarget",
            paneId,
            mode: "matched",
            beat: beat?.kind ?? null,
          });
          for (const anim of running.anims) anim.cancel("hold-at-current");
        }
        if (motion) firstRects.set(paneId, frame.getBoundingClientRect());
        // The fold's near side. Read for every frame rather than only the
        // ones that turn out to cross, because which frames those are is not
        // knowable until the Last pass has the other side: `data-folded` is an
        // attribute read, and the content rect costs nothing extra in a loop
        // that has already flushed layout for the frame's own rect above.
        if (motion) {
          firstFolds.set(paneId, {
            folded: frame.hasAttribute("data-folded"),
            contentHeight: contentBoxHeight(frame),
          });
        }
        // The edge, for the ghost this frame may leave behind. Read for every
        // frame for `firstFolds`' reason — which ones depart is not knowable
        // until the Last pass — and it is one attribute read.
        if (motion) {
          const side = frame.getAttribute("data-rail-side");
          if (side === "left" || side === "right") {
            firstRailSides.set(paneId, side);
          }
        }
        armed.push({ paneId, frame, running });
      }

      // The shadow strips, once rather than per frame: there is one per SIDE,
      // and a rail's members all cast the same one.
      //
      // A strip is HELD BEFORE IT IS MEASURED, for the frames' reason above,
      // and by the same hold: the strip is the depth of the rail beside it,
      // so a rail caught mid-slide and re-planned from the pose the eye has
      // needs its strip held and measured at the pose the eye has too, or the
      // Last pass plans the two different journeys and the shadow comes away
      // from its panel. A strip still HELD for an arrive beat that has not
      // launched (no anims) is left exactly as a pending arrival is: not on
      // screen, nothing to hand back, and the Last pass holds it again. An
      // entry whose strip has left the document is a record of nothing.
      const armedStrips: Array<{
        key: string;
        strip: HTMLElement;
        running: SettleTween;
      }> = [];
      for (const [key, entry] of [...settleTweensRef.current]) {
        if (!key.startsWith(RAIL_SHADOW_TWEEN_PREFIX)) continue;
        if (!entry.el.isConnected) settleTweensRef.current.delete(key);
      }
      if (motion) {
        for (const strip of el.querySelectorAll<HTMLElement>(
          "[data-rail-shadow]",
        )) {
          const side = strip.getAttribute("data-rail-shadow");
          if (side !== "left" && side !== "right") continue;
          const running = settleTweensRef.current.get(railShadowTweenKey(side));
          if (
            running !== undefined &&
            running.el === strip &&
            running.anims.length > 0
          ) {
            for (const anim of running.anims) anim.cancel("hold-at-current");
            armedStrips.push({
              key: railShadowTweenKey(side),
              strip,
              running,
            });
          }
          firstRailShadows.set(side, strip.getBoundingClientRect());
        }
      }

      // Second pass: the episodes, and the frames caught mid-settle. Every
      // write below — a restored width, a cleared transform, an episode's
      // begin event — happens after the last measurement above. The residue
      // still goes back on the SAME tick as the cancel that earned it, which
      // is what the registry's own doc asks for; it goes back a few lines
      // later in that tick, and nothing paints in between.
      for (const { paneId, frame, running } of armed) {
        episodes.set(paneId, beginResizeEpisode(frame, episodeWindowMs));
        if (running !== undefined) {
          // The `snap-to-end` the hold above replaces committed the tween's
          // FINAL value into inline style instead, and the microtask that took
          // it back was long enough to paint — one frame at a stale size
          // against fresh calc geometry, which is the flash the census counts.
          for (const restore of running.restores) restore();
          clearFlip(paneId, frame, running.anims);
        }
      }
      // The strips' residue goes back on the same tick, after the last
      // measurement, for the frames' reason.
      for (const { key, strip, running } of armedStrips) {
        for (const restore of running.restores) restore();
        clearFlip(key, strip, running.anims);
      }

      // A column whose mode flipped moves the one member the stack shows and
      // holds every other one behind it — `settleHoldPlanRef` says why the
      // survivor is the z-frontmost rather than the top tile. Skipped under
      // reduced motion with the rest of the choreography, but the mode record
      // always advances — a stale record would read the next flip against
      // the wrong shore.
      const holdPlan = settleHoldPlanRef.current;
      holdPlan.survivors.clear();
      holdPlan.covered.clear();
      holdPlan.held.clear();
      // A COLUMN whose mode flipped gets the cover choreography: the frame the
      // stack actually shows is the z-frontmost member, not the top of the
      // column's order, so that is the one that moves and every other one
      // is covered. Picking the top member instead would grow a frame that
      // ends up hidden while the card the stack goes on to display arrived by
      // a cut.
      //
      // A rail has no such flip — it is always divided ([B01]).
      const columns = deckColumnsOf(state, null);
      const prevColumnModes = prevColumnModesRef.current;
      if (motion && prevColumnModes !== null) {
        for (const column of columns) {
          const prevMode = prevColumnModes.get(column.slot);
          if (prevMode === undefined || prevMode === column.mode) continue;
          if (column.members.length < 2) continue;
          const members = new Set(column.members);
          let survivor: string | undefined;
          for (const pane of state.panes) {
            if (members.has(pane.id)) survivor = pane.id;
          }
          if (survivor !== undefined) holdPlan.survivors.add(survivor);
          for (const paneId of column.members) {
            if (paneId === survivor) continue;
            holdPlan.covered.add(paneId);
            if (column.mode === "stack") holdPlan.held.add(paneId);
          }
        }
      }
      prevColumnModesRef.current = new Map(
        columns.map((column) => [column.slot, column.mode]),
      );

      // The census closes the arm. `panes` is the number of frames this
      // settle will carry; `armed` is false when the signature changed but
      // nothing will tween — reduced motion, or a deck whose every frame is
      // gesture-owned — which is what separates "nothing moved" from "the
      // move went uncarried".
      deckTrace.record({
        kind: "settle-arm",
        signature: next,
        panes: firstRects.size,
        armed: motion && firstRects.size > 0,
        landing,
        outcome: motion && firstRects.size > 0 ? "carried" : "unarmed",
      });
      tugDevLogStore.debug("arrival", "settle ARM", {
        panes: firstRects.size,
        armed: motion && firstRects.size > 0,
        landing,
      });
      // Handed to the beat of the same kind the Last pass builds. The beat
      // that was running is over either way: its frames are held and
      // re-planned, and nothing is on a beat until the Last pass starts one.
      settleLaunchRef.current = interrupted;
      settleBeatRef.current = null;

      el.style.setProperty(
        "--tugx-imposer-settle-duration",
        `${IMPOSITION_SETTLE_MS}ms`,
      );
      el.setAttribute("data-imposer-settling", "");
      const settleMs = readSettleMs(el);
      settleDurationRef.current = settleMs;
      const windowMs = settleMs * getTugTiming();

      // The cap is generous against the window it guards — it is a
      // wedge guard, not a second clock, and firing it early would
      // reintroduce the very commit the hold is here to keep out. Sized
      // here against the crossing's nominal; the Last pass re-holds against
      // the choreography's total once it knows the beats.
      if (motion) {
        settleReleasedRef.current = false;
        holdSessions(Math.max(2 * windowMs, 1000));
      }

      // Generous against the window it guards, like the hold's cap: the
      // sweep is a wedge guard behind the settle's own completion, and one
      // armed at exactly the crossing's duration would win the race with the
      // last tween's `finished` by a frame and release from the wrong clock.
      scheduleSweep(Math.max(2 * windowMs, 1000));
    };
    const unsubscribe = store.subscribe(arm);
    return () => {
      unsubscribe();
      settleSweepRef.current = null;
      settleReleaseRef.current = null;
      if (settleTimerRef.current !== null) {
        window.clearTimeout(settleTimerRef.current);
      }
      // Unmounting mid-gesture leaves neither a running tween nor a
      // transform — nor a card whose notifications nobody will release.
      releaseSettle("unmount");
      settleBeatRef.current = null;
      settleLaunchRef.current = null;
      for (const [paneId, entry] of [...settleTweensRef.current]) {
        for (const anim of entry.anims) anim.cancel("snap-to-end");
        clearFlip(paneId, entry.el, entry.anims);
        endFoldCrossing(entry.el);
        endStillCrossing(entry.el);
      }
      for (const [, handle] of settleEpisodesRef.current) handle.end();
      settleEpisodesRef.current.clear();
      settleFirstRectsRef.current.clear();
      settleFirstFoldsRef.current.clear();
      settleHoldPlanRef.current.survivors.clear();
      settleHoldPlanRef.current.covered.clear();
      settleHoldPlanRef.current.held.clear();
      // The canvas is coming down and a ghost is not React's to unmount — it
      // was appended to the container outside the tree ([L06]), so it would
      // otherwise go only when the container itself does.
      removeDepartureGhostsRef.current("all");
      // Nothing is left to run an arrive beat, so nothing is left to clear a
      // mark. A caller still waiting would wait past the canvas itself.
      drainArrivalsRef.current();
      containerRef.current?.removeAttribute("data-imposer-settling");
      containerRef.current?.removeAttribute("data-imposer-beat");
      // No settle-end notice here, and that is the one place the pairing does
      // not hold. This is the arm effect's teardown: the canvas is coming
      // down, every sheet listening on it is coming down with it, and the
      // notice's only answer is a clamp measure against a container that is
      // about to leave the document.
    };
  }, [store, holdSessions, releaseSessions]);

  // Last, and the tween. Declared AFTER the inset effect above, and that order
  // is load-bearing: React runs layout effects in declaration order, and the
  // inset effect writes the `--tug-imposer-inset-*` values every imposed
  // frame's `left` calc resolves against. Measuring Last before the fresh
  // insets land would tween every rail side flip from a stale delta.
  useLayoutEffect(() => {
    const el = containerRef.current;
    const firstRects = settleFirstRectsRef.current;
    const firstFolds = settleFirstFoldsRef.current;
    const firstRailSides = settleFirstRailSidesRef.current;
    const firstRailShadows = settleFirstRailShadowsRef.current;
    // Every episode this commit does not go on to hand a tween is finished
    // here: the new geometry is in the DOM, so ending lands each anchor
    // against the layout the user is about to see. The tweened ones are
    // ended by their own completion below, after the inline residue is
    // handed back.
    const endEpisode = (paneId: string): void => {
      const handle = settleEpisodesRef.current.get(paneId);
      if (handle === undefined) return;
      settleEpisodesRef.current.delete(paneId);
      handle.end();
    };
    const endAllEpisodes = (): void => {
      for (const [, handle] of settleEpisodesRef.current) handle.end();
      settleEpisodesRef.current.clear();
    };
    if (el === null || firstRects.size === 0) {
      firstRects.clear();
      firstFolds.clear();
      firstRailSides.clear();
      firstRailShadows.clear();
      endAllEpisodes();
      // A settle with nothing to carry is over the moment it is read: the
      // hold taken at arm comes off now, on the settle's own clock, rather
      // than at the sweep — unless a settle an earlier pass launched is still
      // running, in which case the marks and the hold are its own and this
      // pass has nothing to end.
      if (settleTweensRef.current.size === 0) {
        el?.removeAttribute("data-imposer-settling");
        el?.removeAttribute("data-imposer-beat");
        if (el !== null) dispatchImposerSettleEnd(el);
        settleReleaseRef.current?.("completion");
      }
      // OUTSIDE that guard, unlike the marks above it. Those are conditional
      // because they may belong to an earlier pass still running, which will
      // take them off itself. An arrival marked and never drained is stranded
      // whoever owns the marks, and this pass has nothing that will run a beat.
      drainArrivalsRef.current();
      return;
    }
    // Reduced motion: the layout has already snapped, and that IS the settle.
    // The check is made here rather than left to TugAnimator, which would
    // strip the spatial keyframes and substitute an opacity fade — a flash on
    // every frame, all of which already sit where they belong.
    //
    // The episodes still close here, and closing them is the whole of the
    // preservation on this path: no tween ran, so there was nothing to
    // re-anchor per frame, and the one apply at the end is exact.
    if (!isTugMotionEnabled()) {
      firstRects.clear();
      firstFolds.clear();
      firstRailSides.clear();
      firstRailShadows.clear();
      endAllEpisodes();
      if (settleTweensRef.current.size === 0) {
        el.removeAttribute("data-imposer-settling");
        el.removeAttribute("data-imposer-beat");
        dispatchImposerSettleEnd(el);
        settleReleaseRef.current?.("completion");
      }
      // Outside the guard, for the reason the other early return states: under
      // reduced motion no beat runs at all, so nothing else will ever clear a
      // mark this pass found standing.
      drainArrivalsRef.current();
      return;
    }
    const clearFlip = clearFlipRef.current;
    const duration = settleDurationRef.current;
    const holdPlan = settleHoldPlanRef.current;
    /**
     * The frames this settle committed behind a flipped column's survivor —
     * the hold plan's `covered`, with what each one holds and hands back.
     * Released together at the chain's one completion ([B03]); the doc on
     * `settleHoldPlanRef` says why.
     */
    const covered: Array<{
      paneId: string;
      frame: HTMLElement;
      anims: TugAnimation[];
      restores: Array<() => void>;
    }> = [];
    // The choreography, for this settle. The move beat IS the crossing;
    // `shrink` and `grow` are the resize beats' shorter windows, and
    // `divide-join` is the one the outer fades run on. All are stated
    // relative to `duration` — the one tunable — in `lib/imposer-motion.ts`,
    // and no call site here picks a curve of its own ([P02] of
    // arc/layout-imposer-polish.md).
    //
    // A retarget hands the interrupted beat's velocity to the beat of the
    // SAME kind here — a move's to the move, a shrink's to the shrink — and
    // every other beat launches from rest ([B06]), so a frame caught
    // mid-settle carries on rather than stopping and restarting, and a card
    // that was closing up is never thrown across the deck at that speed.
    const launch = settleLaunchRef.current;
    settleLaunchRef.current = null;
    // The three beats' curves. A settle that carries a size term runs as up to
    // three beats in a fixed order — shrink, move, grow — each on its own
    // recipe, so that at any instant exactly one kind of thing is moving.
    // Built lazily, because the everyday settle has no resize beat and a
    // curve nobody plays is a spring solved for nothing.
    const beatCurves: Partial<Record<BeatKind, MotionCurve>> = {};
    const beatCurve = (kind: BeatKind): MotionCurve => {
      const cached = beatCurves[kind];
      if (cached !== undefined) return cached;
      const built = motionKeyframes(BEAT_RECIPE[kind], {
        nominalMs: duration,
        initialVelocity: beatLaunchVelocity(kind, launch),
      });
      beatCurves[kind] = built;
      return built;
    };
    const crossing = beatCurve("move");
    const fadeCurve = motionKeyframes("divide-join", { nominalMs: duration });
    /**
     * The frames this settle carries by beats, in the order the pass found
     * them. `next` is the index of the beat this frame has not yet run; the
     * `anims` array is the SAME one registered in `settleTweensRef`, and each
     * beat pushes into it, so a retarget mid-choreography cancels whatever is
     * actually in flight and `clearFlip`'s identity check still holds.
     */
    interface Choreographed {
      paneId: string;
      frame: HTMLElement;
      beats: SettleBeat[];
      next: number;
      anims: TugAnimation[];
      restores: Array<() => void>;
      /**
       * The frame's own inline size values as REACT rendered them, keyed by
       * axis — the same closures `restores` holds, reachable one at a time.
       *
       * A beat hands its axis back the moment it ends, and what it hands back
       * has to be the committed value rather than nothing: the imposer writes
       * its hold onto the very property React rendered the frame's height
       * into, so `removeProperty` there takes React's number away with the
       * hold and leaves the frame standing at its content's own height until
       * the settle's completion restores it. On a fold that is the folded card
       * at its OPEN floor for the whole of the move beat.
       */
      handBack: { width?: () => void; height?: () => void };
      crossingId: number | null;
      /** The still crossing's id — set on every frame with a height term, folding or not. */
      stillCrossingId: number | null;
    }
    const choreography: Choreographed[] = [];
    /**
     * The frames arriving in this settle, and the ghosts standing in for the
     * panes leaving it — collected by the passes below and launched by the
     * chain's outer beats ([P05]).
     *
     * Neither is a `Choreographed`: a `SettleBeat` is a partition of one
     * frame's FLIP terms, and these two have none — an arrival has no First
     * rect to invert and a departure has no Last one. They are collected as
     * what they are and the chain gives each its beat.
     */
    const arrivals: Array<{
      paneId: string;
      frame: HTMLElement;
      restores: Array<() => void>;
    }> = [];
    const departures: Array<{
      paneId: string;
      ghost: HTMLElement;
    }> = [];
    /**
     * The rails that left, which do NOT ride the depart beat.
     *
     * A rail's exit is launched the moment its ghost is planted, on a clock of
     * its own, because the beat is not reachable for it: hiding the sidebars
     * is a run of commits in ONE turn — a record, then a close per member, per
     * side — and every commit's `arm` sweeps the ghosts whose beat has not
     * launched yet. A beat that launches on a microtask always loses that
     * race, so every rail but the last one closed vanished without travelling.
     * Launching at the plant is what makes each rail's exit its own, however
     * many commits follow it.
     */
    const railDepartures: Array<{
      paneId: string;
      ghost: HTMLElement;
      side: SidebarSide;
    }> = [];
    /**
     * The shadow strips of the sides whose rails are ALL arriving, held
     * invisible with their rails and slid in on the arrive beat.
     */
    const arrivingStrips: Array<{
      key: string;
      strip: HTMLElement;
      side: SidebarSide;
      restores: Array<() => void>;
    }> = [];
    // This launch. Every completion below — a fade's, an entrance's, the
    // beat choreography's — checks it before touching anything, because a
    // retarget that landed in between has already cancelled, restored and
    // re-planned every frame, and a later Last pass owns them now.
    const generation = ++settleGenerationRef.current;
    // ONE release for the whole settle, on the settle's own clock: the hold
    // taken at arm comes off when the last of this pass's completions has
    // landed — after the final beat's last tween, never from the window
    // timer — so the one publish lands on settled geometry ([B04]).
    let outstanding = 0;
    const finish = (): void => {
      // The settle is over: the marks come off here, on the settle's own
      // clock, and the sweep behind it finds nothing left to do. Through
      // {@link endSettleMarks}, because the restores ran a few statements ago
      // and the window has to outlast the style recalc that sees them.
      endSettleMarks(el);
      // The settle's own clock announcing its own end. Every sheet up on this
      // canvas measures its clamp here, and nowhere in between ([P07]).
      dispatchImposerSettleEnd(el);
      settleReleaseRef.current?.("completion");
      // Every card the deck holds that is still marked has arrived, whether or
      // not an arrive beat is what brought it: this is the moment the settle
      // is over, and the drain is what makes the event unmissable ([R01]).
      drainArrivalsRef.current();
    };
    const settled = (): void => {
      outstanding -= 1;
      if (outstanding === 0 && settleGenerationRef.current === generation) {
        finish();
      }
    };
    const settleOpts = {
      // Raw ms: TugAnimator scales by getTugTiming() itself.
      duration: crossing.durationMs,
      // No retained effect after the tween ends ([D6]).
      fill: "none",
      composite: "replace",
      // Cancelled by the arm above, which reads progress and velocity off the
      // curve before it does — holding where the eye is, never snapping to an
      // end the frame never reached ([P04]).
      slotCancelMode: "hold-at-current",
    } as const;
    // Which frames this pass actually found. Whatever `arm` measured and this
    // loop never reaches has left the DOM during the commit, which is the only
    // notice a departing pane gives: by the time an effect could run on it,
    // there is no element to run one on.
    const survivors = new Set<string>();
    // Whether this settle carries an arrival or a departure, answered BEFORE
    // anything is planned, because every frame's plan depends on it ([P08]).
    //
    // The pass below discovers both while it walks — a frame with no First
    // rect is arriving, and a First rect with no survivor departed — but by
    // then the first frames have already been planned, and a settle cannot
    // fuse half its frames. Both questions are answerable from what is
    // already in hand: the frames in the DOM now, and the rects `arm`
    // measured. So they are asked here, on one walk of each, and the answer
    // is one boolean for the whole settle.
    //
    // `data-pointer-owned` is excluded on the arrival side for the reason the
    // walk below states: a zone drop has no First rect and is not arriving.
    for (const frame of el.querySelectorAll<HTMLElement>(
      SHOWN_PANE_FRAMES,
    )) {
      const paneId = frame.getAttribute("data-pane-id");
      if (paneId !== null) survivors.add(paneId);
    }
    const hasArrival = Array.from(
      el.querySelectorAll<HTMLElement>(SHOWN_PANE_FRAMES),
    ).some(
      (frame) =>
        !frame.hasAttribute("data-pointer-owned") &&
        !frame.hasAttribute("data-arriving") &&
        !firstRects.has(frame.getAttribute("data-pane-id") ?? ""),
    );
    const hasDeparture = Array.from(firstRects.keys()).some(
      (paneId) => !survivors.has(paneId),
    );
    // One gesture, one beat. An arrival's or a departure's room is made or
    // given up once, and the deck reads as making it once rather than as a
    // survivor shrinking, then sliding, then a newcomer appearing ([P08]).
    // The everyday arrangement change — neither arriving nor departing — is
    // never fused and keeps its shrink/move/grow partition exactly.
    const fused = hasArrival || hasDeparture;
    const traveled: Array<Record<string, number | string>> = [];
    for (const frame of el.querySelectorAll<HTMLElement>(
      SHOWN_PANE_FRAMES,
    )) {
      const paneId = frame.getAttribute("data-pane-id");
      if (paneId === null) continue;
      survivors.add(paneId);
      // A pointer-owned frame is never the settle's to carry, whatever the
      // First pass knew about it. Checked before the entrance test because a
      // zone drop is the case where the two collide: the arm skipped the
      // frame (no First rect, exactly like an arrival), but it is not
      // arriving — it is mid-landing under `zone-drop-landing`, and an
      // entrance played here replaces that landing's transform, snapping the
      // card to its tile and fading it in for no reason. The drag or the
      // landing owns its geometry, and its own episode owns the scroll
      // under it.
      if (frame.hasAttribute("data-pointer-owned")) {
        endEpisode(paneId);
        continue;
      }
      // A frame still hidden and arriving is not this settle's either: it
      // has no First rect because `arm` skipped it, and it is not arriving
      // in the settle's sense until the commit that clears its mark. Nothing
      // to plan, nothing to hold, and no episode was opened on it.
      if (frame.hasAttribute("data-arriving")) continue;
      const firstRect = firstRects.get(paneId);
      if (firstRect === undefined) {
        // A frame that was not on screen when this settle armed: it is
        // arriving, not travelling. FLIP has nothing to say about it — there
        // is no First rect to invert — but the promise the settle keeps for
        // every other frame is that a card never changes places in one frame,
        // and a card that materializes at full opacity has broken it just as
        // plainly as one that jumped. So it enters under its own effect,
        // played at the geometry the commit already gave it: a fade up and a
        // short rise, which reads as arriving without pretending it came from
        // anywhere in particular.
        //
        // Reaching this branch at all means a settle is genuinely in flight —
        // the guard above returns when no First rects were measured, which is
        // the mount case, so a deck restoring at launch does not fade every
        // card in.
        //
        // Its own slot key, because this is not the geometry effect and must
        // not cancel one: a frame can arrive into a settle that is also moving
        // its neighbours, and the two effects belong to different frames.
        // The entrance bakes an opacity on its way out, exactly as the
        // geometry effect bakes a width — so it is handed back the same way,
        // and by the same restorer a cancel would run.
        //
        // The entrance is now the chain's LAST beat rather than an effect
        // launched alongside it ([P05]), so what happens here is the opening
        // pose and nothing else: the frame is held invisible until its arrive
        // beat comes round, which is the same rule `applyHolds` states for an
        // axis whose grow beat is still to come. Registered in
        // `settleTweensRef` with an empty `anims` array so `arm`, the sweep and
        // the unmount teardown all hand the opacity back — a frame left wearing
        // the hold would be a card nobody can see.
        //
        // No `outstanding += 1` here: the chain accounts for the arrive beat,
        // and counting it twice would leave the settle's hold outstanding
        // forever.
        // A frame this settle found still ARRIVING — held invisible by the
        // settle a retarget just replaced, its arrive beat never launched —
        // keeps the restorer that knows the opacity it had before any hold.
        // Capturing a fresh one here would record the hold itself as the
        // value to hand back, and the card would end its arrival invisible.
        const prior = settleTweensRef.current.get(paneId);
        const restores =
          prior !== undefined && pendingArrivalsRef.current.has(paneId)
            ? prior.restores
            : [inlineRestorer(frame, "opacity")];
        pendingArrivalsRef.current.add(paneId);
        frame.style.opacity = "0";
        settleTweensRef.current.set(paneId, {
          el: frame,
          anims: [],
          restores,
        });
        arrivals.push({ paneId, frame, restores });
        continue;
      }
      const lastRect = frame.getBoundingClientRect();
      traveled.push({
        paneId,
        firstY: Math.round(firstRect.top),
        firstH: Math.round(firstRect.height),
        lastY: Math.round(lastRect.top),
        lastH: Math.round(lastRect.height),
      });
      const anims: TugAnimation[] = [];
      const restores: Array<() => void> = [];
      // The fold crossing this frame opened, if it is crossing at all. Read by
      // the completion handler, which is the only thing that may close it, and
      // only by this id: a cancelled tween's handler lands after a replacement
      // settle has already re-marked the frame.
      let crossingId: number | null = null;
      let stillCrossingId: number | null = null;
      if (holdPlan.covered.has(paneId)) {
        // A member a column mode flip committed behind its survivor. It does
        // not travel and it does not fade ([B02] of
        // `briefs/column-flip-cover-brief.md`): a stack is the survivor
        // covering its neighbours and a split is the survivor uncovering
        // them, and z-order already puts the survivor in front. Nothing on
        // the frame animates; it wears the cover, and the mark rides the
        // settle's own registry so a retarget cancels it through the same
        // door as everything else.
        //
        // On a split the frame is at its tile, which the commit has already
        // put it at behind the survivor's held full run — the stacked rect it
        // was measured at was never a pose the user saw — so there is nothing
        // to hold. On a stack it is HELD: the commit has already moved it to
        // the full run it will occupy behind the survivor, and letting that
        // landing show would be the card sliding across the column, so it
        // keeps the tile it is leaving as a static inverse. One inline write,
        // so nothing interpolates, for exactly the survivor's crossing: the
        // chain's completion takes it off with the cover. The snap to the
        // full run at release lands under the survivor, which is what the
        // cover tells the census.
        if (holdPlan.held.has(paneId)) {
          const { dx, dy } = flipDelta(firstRect, lastRect);
          frame.style.transformOrigin = "0 0";
          restores.push(inlineRestorer(frame, "height"));
          applyHolds(frame, {
            transform: { dx, dy, sx: 1 },
            height: firstRect.height,
          });
        }
        frame.setAttribute("data-imposer-covered", "");
        settleTweensRef.current.set(paneId, { el: frame, anims, restores });
        covered.push({ paneId, frame, anims, restores });
        continue;
      } else {
        const { dx, dy, sx } = flipDelta(firstRect, lastRect);
        // Whether the width change is small enough to ride the transform
        // as a raster smear, or crosses by real geometry ([D135]).
        // Height never smears: the gestures that change it halve or double
        // it, which no cap admits, so any height delta is a real term.
        //
        // Both axes are floored at half a pixel, so a measurement that came
        // back a hair different is not a size change. Without the floor a rail
        // mode flip — which does not touch width at all — can still read
        // `sx !== 1` off sub-pixel rounding and pick up a `scaleX` term for a
        // deformation of about one ten-millionth: invisible, but it is a frame
        // being told to do something it does not have to.
        const widthChanges = Math.abs(firstRect.width - lastRect.width) >= 0.5;
        const heightTweens = Math.abs(firstRect.height - lastRect.height) >= 0.5;
        const widthSmears =
          widthChanges && scaleDistortion(sx) <= MAX_FLIP_SCALE_DISTORTION;
        const widthTweens = widthChanges && !widthSmears;
        // A FOLD CROSSING: the frame's `data-folded` differs between the two
        // sides of the commit and its height is a real term. That pair is the
        // whole of the detection ([B04] of `session-fold-still-interior`) —
        // the imposer already holds both sides, so nothing is cached, nothing
        // is watched, and nothing inside the card is measured.
        //
        // The held height is the LARGER of the two content heights, which is
        // the open one in both directions: First on the fold in, Last on the
        // unfold ([F06]). The card is laid out once at that height and the
        // content box clips it, so no top inside the card moves while the
        // edge sweeps ([B01]).
        //
        // Marked before the tween starts and taken off in the completion
        // handler below, which is also where the crossing's end is announced
        // — the imposer's spring is the crossing's only clock ([B03], [B05]).
        const firstFold = firstFolds.get(paneId);
        if (
          heightTweens &&
          firstFold !== undefined &&
          firstFold.folded !== frame.hasAttribute("data-folded")
        ) {
          const lastContentHeight = contentBoxHeight(frame);
          const heldHeight = Math.max(
            firstFold.contentHeight ?? 0,
            lastContentHeight ?? 0,
          );
          if (heldHeight > 0) crossingId = markFoldCrossing(frame, heldHeight);
        }
        // A crossing this settle did not open, on a frame it is taking over.
        // The edge has not stopped — this settle is carrying the rest of the
        // same travel — so the crossing continues, under an id belonging to
        // the tween that will actually finish it. Without this the cancelled
        // tween's completion would close it here, with the whole rest of the
        // travel still to come, and the card would land in its terminal form
        // mid-sweep. Every deck change that shares a window with a fold is
        // this case, which is most of them in a wall.
        if (crossingId === null && heightTweens) {
          crossingId = adoptFoldCrossing(frame);
        }
        // A STILL CROSSING: the height term alone. The fold's argument never
        // depended on the fold — a subtree held at one definite height is not
        // dirtied by its frame's tween — so every frame whose height is a
        // real term is held at the larger of its two content heights, by the
        // same two reads the fold uses and nothing inside the card. A stack
        // or a split marks its survivor, a join or a leave every member whose
        // tile resizes; a covered member carries no height term and never
        // reaches here.
        //
        // One mark call covers all three cases. A fold above has already set
        // this mark, and a retarget finds one standing: both are re-marks,
        // which take a fresh id — so the cancelled tween's completion cannot
        // release it — and never lower the height already held, which is what
        // makes First measured mid-tween safe to pass.
        if (heightTweens) {
          const stillHeight = Math.max(
            firstFold?.contentHeight ?? 0,
            contentBoxHeight(frame) ?? 0,
          );
          stillCrossingId =
            stillHeight > 0
              ? markStillCrossing(frame, stillHeight)
              : adoptStillCrossing(frame);
        }
        // A frame that did not move and did not change size gets no animation
        // at all.
        if (dx === 0 && dy === 0 && !widthChanges && !heightTweens) {
          endEpisode(paneId);
          continue;
        }
        // Captured BEFORE `applyHolds` writes this settle's holds, so what
        // each one hands back is React's committed value and not a hold —
        // `arm` has already run any in-flight settle's restores, so nothing
        // older is standing on these properties either.
        const handBack: { width?: () => void; height?: () => void } = {};
        if (widthTweens) {
          handBack.width = inlineRestorer(frame, "width");
          restores.push(handBack.width);
        }
        if (heightTweens) {
          handBack.height = inlineRestorer(frame, "height");
          restores.push(handBack.height);
        }
        // The beats this frame runs — shrink, move, grow, skipping any it has
        // nothing for — so that no beat carries a size term and a translate
        // together ([B01] of `three-beat-settle`). A frame with no size term
        // plans to exactly one move beat carrying today's terms, which is the
        // stack move, unchanged ([B02]).
        const beats = planSettleBeats(
          {
            dx,
            dy,
            sx: widthSmears ? sx : 1,
            width: widthTweens ? [firstRect.width, lastRect.width] : undefined,
            height: heightTweens
              ? [firstRect.height, lastRect.height]
              : undefined,
          },
          // Fused per frame, not per settle: a column mode flip's survivor
          // rides one `room` beat because its move and its height change are
          // one edge ([B01] of `briefs/column-flip-cover-brief.md`), while every
          // other frame this settle carries keeps its shrink/move/grow plan.
          { fused: fused || holdPlan.survivors.has(paneId) },
        );
        if (beats.length === 0) {
          endEpisode(paneId);
          continue;
        }
        // The scale anchors the frame's top-left corner, which is the corner
        // `dx` and `dy` were measured from. Set for every settle that carries a
        // transform, scaling or not, so the property has one value and one
        // owner rather than depending on which kind of gesture wrote it last;
        // `clearFlip` takes it off with the transform.
        const moves = dx !== 0 || dy !== 0 || widthSmears;
        if (moves) {
          frame.style.transformOrigin = "0 0";
        }
        // The opening pose, written now, before this commit paints: the frame
        // is committed at Last, and until its move beat runs it must stand at
        // First — a constant translate (and smear), held inline — and until
        // its grow beat runs a growing axis must stay at its First size. It
        // is the frame's, not its first beat's: the beats launch below, after
        // every frame is planned, and a beat is all frames' together, so a
        // frame whose own first beat is the move or the grow waits in this
        // pose while its neighbours make room.
        // The RULE, in both directions: every size term this frame's FIRST
        // beat carries is held at its First value until that beat runs,
        // alongside the inverse transform.
        //
        // It used to hold a GROWING axis only, and that was correct for one
        // reason and one only — the shrink beat was the settle's first beat,
        // so a shrinking axis had nothing to wait through and could be left
        // at the Last size the commit already gave it. That is no longer
        // true. With `room` in {@link BEAT_ORDER} the fused beat is not first
        // whenever a departure is present, so in the combined settle
        // (`["depart","room","arrive"]`) a survivor whose height shrinks
        // would stand at its shrunken size from the launch and the beat would
        // then animate a height from Last to Last.
        //
        // Reading the planned beats is necessary but not sufficient, which is
        // why the direction asymmetry goes with it: what matters is not which
        // way an axis moves but whether its beat has run, and until it has,
        // the frame belongs at First.
        const firstBeat = beats[0];
        applyHolds(frame, {
          ...(moves ? { transform: { dx, dy, sx: widthSmears ? sx : 1 } } : {}),
          // What the first beat itself holds — the axis whose own beat is
          // later still — and what the first beat ANIMATES, held at its start
          // until it does. A beat never holds an axis it animates, so the two
          // spreads can never fight over one property, and together they are
          // every size term the frame carries.
          ...(firstBeat?.held.width !== undefined
            ? { width: firstBeat.held.width }
            : {}),
          ...(firstBeat?.held.height !== undefined
            ? { height: firstBeat.held.height }
            : {}),
          ...(firstBeat?.terms.width !== undefined
            ? { width: firstBeat.terms.width[0] }
            : {}),
          ...(firstBeat?.terms.height !== undefined
            ? { height: firstBeat.terms.height[0] }
            : {}),
        });
        settleTweensRef.current.set(paneId, { el: frame, anims, restores });
        choreography.push({
          paneId,
          frame,
          beats,
          next: 0,
          anims,
          restores,
          handBack,
          crossingId,
          stillCrossingId,
        });
        continue;
      }
    }
    // The shadow strips, planned AFTER every frame so the answer to "did this
    // side's rail survive?" is in hand. A strip is the rail's depth, and it
    // moves exactly as the rail does or it is not that — every case below is
    // one way of keeping the two on one clock.
    //
    // A side whose rails are ALL arriving — none survived the commit with a
    // First rect — is a rail sliding in from its edge. The commit drew the
    // strip at home, where it would stand alone through every beat before the
    // arrive while the rail is still held invisible: that is the stripe seen
    // standing in the middle of a card a beat before the rail comes in. So
    // the strip is held invisible WITH the rail, and slides in on the arrive
    // beat on the rail's own number. A side whose strip moved between First
    // and Last while a rail survived — the rail was caught mid-slide and
    // re-planned from where it was — is a strip travelling with its rail's
    // move, and it is choreographed like a frame: held at First, carried on
    // the side's beat, its transform taken off when the beat lands. A side
    // whose rails all left has no live strip; its ghost is planted below with
    // the rail's. React writes neither opacity nor transform on a strip, so
    // handing either back is taking it off.
    const railArrivingSides = new Set<SidebarSide>();
    for (const { frame } of arrivals) {
      const side = frame.getAttribute("data-rail-side");
      if (side === "left" || side === "right") railArrivingSides.add(side);
    }
    for (const frame of el.querySelectorAll<HTMLElement>(SHOWN_PANE_FRAMES)) {
      const paneId = frame.getAttribute("data-pane-id");
      if (paneId === null || !firstRects.has(paneId)) continue;
      const side = frame.getAttribute("data-rail-side");
      if (side === "left" || side === "right") railArrivingSides.delete(side);
    }
    for (const strip of el.querySelectorAll<HTMLElement>("[data-rail-shadow]")) {
      const side = strip.getAttribute("data-rail-shadow");
      if (side !== "left" && side !== "right") continue;
      const key = railShadowTweenKey(side);
      const restores = [
        (): void => {
          strip.style.removeProperty("opacity");
        },
        (): void => {
          strip.style.removeProperty("transform");
        },
      ];
      if (railArrivingSides.has(side)) {
        strip.style.opacity = "0";
        settleTweensRef.current.set(key, { el: strip, anims: [], restores });
        arrivingStrips.push({ key, strip, side, restores });
        continue;
      }
      const firstRect = firstRailShadows.get(side);
      if (firstRect === undefined) continue;
      const dx = firstRect.left - strip.getBoundingClientRect().left;
      if (Math.abs(dx) < 0.5) continue;
      const beats = planSettleBeats({ dx, dy: 0, sx: 1 }, { fused });
      if (beats.length === 0) continue;
      const anims: TugAnimation[] = [];
      strip.style.transformOrigin = "0 0";
      applyHolds(strip, { transform: { dx, dy: 0, sx: 1 } });
      settleTweensRef.current.set(key, { el: strip, anims, restores });
      choreography.push({
        paneId: key,
        frame: strip,
        beats,
        next: 0,
        anims,
        restores,
        handBack: {},
        crossingId: null,
        stillCrossingId: null,
      });
    }
    // The departures. A pane `arm` measured that no longer has a frame closed
    // during this commit, and its last rect is the one thing still known about
    // it — so the ghost goes exactly there, fades, and is taken away. Planted
    // on the container rather than the frames' parent chain so nothing it
    // outlives can strand it.
    //
    // The fade is the chain's FIRST beat now ([P05]) rather than an effect
    // launched alongside it, so this pass plants the ghost and collects it; the
    // depart beat fades it and takes it away. The room a closing pane gives up
    // is therefore given up before any survivor moves into it.
    for (const [paneId, rect] of firstRects) {
      if (survivors.has(paneId)) continue;
      endEpisode(paneId);
      const ghost = document.createElement("div");
      ghost.className = "tug-pane-exit-ghost";
      ghost.setAttribute("data-exit-ghost-for", paneId);
      ghost.style.left = `${rect.left}px`;
      ghost.style.top = `${rect.top}px`;
      ghost.style.width = `${rect.width}px`;
      ghost.style.height = `${rect.height}px`;
      el.appendChild(ghost);
      // Registered the instant it is planted, so every exit below can hand it
      // back by name. A departure whose pane somehow departs twice replaces
      // its own entry, which is the right record of one pane, one ghost.
      // A rail's ghost counts as launched from the instant it is planted,
      // because it is: the slide below starts on this same tick, and the
      // sweep must leave it to travel.
      const railSide = firstRailSides.get(paneId);
      departureGhostsRef.current.set(paneId, {
        ghost,
        launched: railSide !== undefined,
      });
      if (railSide === undefined) departures.push({ paneId, ghost });
      else railDepartures.push({ paneId, ghost, side: railSide });
    }
    // A rail leaves by the edge it stands on, and it takes its SHADOW with
    // it. The shadow is one strip per side drawn by the canvas rather than by
    // any pane ([D183]), so a departing rail unmounts it outright and it would
    // blink out while the panel it is the depth of slides away — a panel and
    // its depth are one object as the eye reads them. The strip's ghost is
    // planted only where the side is now EMPTY: a rail losing one of two
    // members keeps its live strip, which must not be doubled.
    //
    // Every ghost on a side travels the RAIL's distance, never its own. The
    // strip stands ten pixels inboard, so measuring it against the edge
    // separately would give it a longer journey and the two would drift apart
    // over the crossing.
    if (railDepartures.length > 0) {
      const canvasRect = el.getBoundingClientRect();
      const travelBySide = new Map<SidebarSide, number>();
      for (const { ghost, side } of railDepartures) {
        if (travelBySide.has(side)) continue;
        travelBySide.set(
          side,
          railTravelPx(ghost.getBoundingClientRect(), side, canvasRect),
        );
      }
      const leaving: Array<{ key: string; node: HTMLElement; px: number }> =
        railDepartures.map(({ paneId, ghost, side }) => ({
          key: paneId,
          node: ghost,
          px: travelBySide.get(side) ?? 0,
        }));
      for (const [side, px] of travelBySide) {
        if (el.querySelector(`[data-rail-shadow="${side}"]`) !== null) continue;
        const rect = firstRailShadows.get(side);
        if (rect === undefined) continue;
        const ghost = document.createElement("div");
        ghost.className = `tug-rail-shadow tug-rail-shadow--${side}`;
        const key = `rail-shadow:${side}`;
        ghost.setAttribute("data-exit-ghost-for", key);
        ghost.style.position = "fixed";
        ghost.style.left = `${rect.left}px`;
        ghost.style.top = `${rect.top}px`;
        ghost.style.width = `${rect.width}px`;
        ghost.style.height = `${rect.height}px`;
        ghost.style.zIndex = String(RAIL_SHADOW_ZINDEX);
        el.appendChild(ghost);
        // In the same registry the pane ghosts are in, so the canvas
        // teardown's "take them all" sweep reaches these too — and launched,
        // for the reason its rail's is.
        departureGhostsRef.current.set(key, { ghost, launched: true });
        leaving.push({ key, node: ghost, px });
      }
      // On its own clock and its own completion, unconditional on the settle
      // generation: a ghost stands for a pane that has already left the deck,
      // so nothing later will ever collect it and nothing it could interrupt
      // is still watching.
      //
      // **`snap-to-end`, and a landing on BOTH outcomes.** The settle's own
      // `hold-at-current` is wrong for a ghost twice over: it REJECTS
      // `finished`, so a landing hung on the resolve alone never runs, and it
      // commits the mid-slide pose to inline style — which strands the tile in
      // the document, parked in the middle of the deck, wearing the transform
      // it was cancelled at. A ghost has no restorer and no later pass, so
      // that stripe would stand for the life of the canvas. Snapping to the
      // end is also the honest answer: the end is off the edge.
      for (const { key, node, px } of leaving) {
        const slide = animate(
          node,
          { transform: ["translateX(0px)", `translateX(${px}px)`] },
          {
            ...settleOpts,
            duration: fadeCurve.durationMs,
            easing: "ease-out",
            slotCancelMode: "snap-to-end",
            key: `rail-exit:${key}`,
          },
        );
        const collect = (): void => {
          const entry = departureGhostsRef.current.get(key);
          if (entry === undefined) return;
          entry.ghost.remove();
          departureGhostsRef.current.delete(key);
        };
        void slide.finished.then(collect, collect);
      }
    }
    // The beats. Every frame's shrink tweens together; on their joint
    // completion every frame's move tweens; then every frame's grow tweens —
    // and a beat no frame has a term in is skipped, so the everyday stack move
    // is one move beat and nothing else ([B01], [B02]). Each beat's keyframes
    // are cut from that beat's terms alone on that beat's recipe, and the
    // container names the running beat in `data-imposer-beat` so a sampled
    // frame can be read against the beat it belongs to.
    if (choreography.length + arrivals.length + departures.length > 0) {
      tugDevLogStore.debug("arrival", "settle LAST → beats", {
        fused,
        arrivals: arrivals.map((a) => a.paneId),
        departures: departures.length,
        traveled,
      });
      outstanding += 1;
      const present = (kind: BeatKind): Choreographed[] =>
        choreography.filter((c) => c.beats[c.next]?.kind === kind);
      // The sweep's window is the choreography's whole window — the sum of
      // the non-empty beats' — never the crossing's nominal alone, which would
      // fire mid-choreography and snap every frame to its end. The store
      // hold's cap is re-sized against the same total, for the same reason:
      // a cap that fired mid-choreography would publish into a beat.
      //
      // A kind counts when some frame has a beat of it OR — for the outer two,
      // which no frame plans — when anything is arriving or departing. Leaving
      // them out of the sum would size the window to the middle three alone and
      // fire the sweep and the hold's cap mid-choreography.
      const launched = BEAT_ORDER.filter((kind) => {
        if (kind === "depart") return departures.length > 0;
        if (kind === "arrive") return arrivals.length > 0;
        return choreography.some((c) => c.beats.some((b) => b.kind === kind));
      });
      const totalMs = launched.reduce(
        (sum, kind) => sum + motionDurationMs(BEAT_RECIPE[kind], duration),
        0,
      );
      if (totalMs > crossing.durationMs) {
        const totalWindowMs = totalMs * getTugTiming();
        settleSweepRef.current?.(Math.max(2 * totalWindowMs, 1000));
        holdSessions(Math.max(2 * totalWindowMs, 1000));
      }
      const runBeat = (kind: BeatKind): Promise<void> => {
        // A retarget landed between beats: `arm` has already cancelled,
        // restored and re-planned every frame, and a later Last pass owns
        // them now. Nothing here is this chain's to touch.
        if (settleGenerationRef.current !== generation) {
          return Promise.resolve();
        }
        const launches = present(kind);
        // The outer two are not planned beats, so they are launched from what
        // the passes above collected rather than from `present`.
        if (kind === "depart" || kind === "arrive") {
          const fadeOpts = {
            ...settleOpts,
            // A fade is `divide-join`: carried by opacity rather than by
            // travel, so its window is that recipe's and its easing is the
            // plain one the recipe states — there is no position to spring.
            duration: fadeCurve.durationMs,
            easing: "ease-out",
          } as const;
          // A RAIL returns by the edge it stands on, and that is the one
          // entrance in the deck that is a slide rather than a fade: a left
          // rail is a panel pinned to the left edge, so it comes back in
          // moving right, and the right rail is its mirror. A card in the band
          // has no edge of its own and keeps the fade — it is not travelling
          // from anywhere, it is beginning to be here ([D135]). The way OUT is
          // not here at all: a rail's exit is launched where its ghost is
          // planted, for the race the `railDepartures` comment states.
          const canvasRect = el.getBoundingClientRect();
          // **One travel per side, and the shadow takes the pane's** — the
          // exit's rule, for the exit's reason.
          const railTravelBySide = new Map<SidebarSide, number>();
          const travelFor = (el2: HTMLElement, side: SidebarSide): number => {
            const known = railTravelBySide.get(side);
            if (known !== undefined) return known;
            const px = railTravelPx(el2.getBoundingClientRect(), side, canvasRect);
            railTravelBySide.set(side, px);
            return px;
          };
          const slideIn = (px: number) => ({
            // Opaque for the whole crossing, against the `opacity: 0` hold the
            // Last pass wrote: the card is travelling in from outside the
            // window rather than materializing, so there is nothing for a fade
            // to say. `land` takes the hold off when the slide arrives.
            opacity: [1, 1],
            transform: [`translateX(${px}px)`, "translateX(0px)"],
          });
          const fades: TugAnimation[] =
            kind === "depart"
              ? departures.map(({ ghost }) =>
                  animate(ghost, { opacity: [1, 0] }, {
                    ...fadeOpts,
                    key: "imposer-exit-ghost",
                  }),
                )
              : arrivals.map(({ frame }) => {
                  const attr = frame.getAttribute("data-rail-side");
                  const side = isSidebarSide(attr) ? attr : undefined;
                  return animate(
                    frame,
                    side === undefined
                      ? {
                          opacity: [0, 1],
                          transform: [
                            `translateY(${PANE_ENTER_RISE_PX}px)`,
                            "translateY(0px)",
                          ],
                        }
                      : slideIn(travelFor(frame, side)),
                    { ...fadeOpts, key: "imposer-enter" },
                  );
                });
          // The arriving sides' strips, after the frames so the positional
          // pairing below — `arrivals[i]` to `fades[i]` — is untouched. Each
          // is the LIVE strip the Last pass held invisible with its rail, and
          // it rides the rail's own number — one travel per side, the exit's
          // rule for the exit's reason — on the rail's own keyframes, so the
          // two cannot be a pixel apart on any frame of the crossing.
          //
          // Registered on its own entry, as a frame's slide is on the frame's:
          // a retarget's `arm` holds it where it is and measures it there, the
          // sweep hands it back, and `land` takes the hold off with the rails'.
          // Nothing here snaps to an end or lands on its own — a strip that
          // snapped home while its rail was held mid-slide would be the shadow
          // standing away from the panel that this whole passage forbids.
          if (kind === "arrive") {
            for (const { key, strip, side } of arrivingStrips) {
              const px = railTravelBySide.get(side);
              if (px === undefined) continue;
              const slide = animate(strip, slideIn(px), {
                ...fadeOpts,
                key: "imposer-enter-rail-shadow",
              });
              settleTweensRef.current.get(key)?.anims.push(slide);
              fades.push(slide);
            }
          }
          if (fades.length === 0) return Promise.resolve();
          el.setAttribute("data-imposer-beat", kind);
          if (kind === "depart") {
            // The fades are running, so each of these ghosts now has a landing
            // coming that is unconditional on the generation. That is what
            // lets a retarget's `arm` leave them alone and take only the ones
            // nothing will ever collect.
            for (const { paneId } of departures) {
              const entry = departureGhostsRef.current.get(paneId);
              if (entry !== undefined) entry.launched = true;
            }
          }
          // What the fade leaves behind when it lands, once. A departure's
          // ghost stood in for a pane that no longer exists, so there is
          // nothing to hand anything back to: it goes. An arrival's opacity
          // hold comes off for the move and grow beats' reason: `fill: none`
          // means the effect's end value is the underlying inline style, and
          // a frame left wearing the hold would snap back to invisible.
          let landed = false;
          const land = (): void => {
            if (landed) return;
            landed = true;
            if (kind === "depart") {
              // Through the ref rather than through this closure's array: the
              // ref is the owner, and a removal that bypassed it would leave
              // an entry naming a node no longer in the document.
              for (const { paneId } of departures) {
                const entry = departureGhostsRef.current.get(paneId);
                if (entry === undefined) continue;
                entry.ghost.remove();
                departureGhostsRef.current.delete(paneId);
              }
              return;
            }
            for (const { frame } of arrivals) {
              frame.style.removeProperty("opacity");
            }
            for (const { strip } of arrivingStrips) {
              strip.style.removeProperty("opacity");
              strip.style.removeProperty("transform");
            }
          };
          settleBeatRef.current = {
            kind,
            launchedAt: performance.now(),
            initialVelocity: beatLaunchVelocity(kind, launch),
            anims: fades,
            land,
          };
          // An arriving frame's fade is registered on its own entry so a
          // retarget cancels what is actually in flight, exactly as a planned
          // beat's tween is.
          if (kind === "arrive") {
            for (const [i, { paneId }] of arrivals.entries()) {
              pendingArrivalsRef.current.delete(paneId);
              const entry = settleTweensRef.current.get(paneId);
              const anim = fades[i];
              if (entry !== undefined && anim !== undefined) {
                entry.anims.push(anim);
              }
            }
          }
          return Promise.allSettled(fades.map((anim) => anim.finished)).then(
            () => {
              if (kind === "depart") {
                // Unconditional on the generation, and the only thing in this
                // chain that is. Every other frame here is still on screen and
                // still registered in `settleTweensRef`, so a retarget's `arm`
                // cancels its tween, runs its restorers, and a later Last pass
                // owns it. A ghost is in neither: it stands for a pane that has
                // already left the deck, so `arm` never looks at it and no
                // later pass will ever collect it again — a departed pane has
                // no First rect to be measured from. Returning here without
                // removing it would strand the tile in the document for the
                // life of the canvas, one per close interrupted mid-fade.
                land();
                return;
              }
              if (settleGenerationRef.current !== generation) return;
              land();
            },
          );
        }
        if (launches.length === 0) return Promise.resolve();
        el.setAttribute("data-imposer-beat", kind);
        const curve = beatCurve(kind);
        const anims: TugAnimation[] = [];
        const launchedBeats: Array<[Choreographed, SettleBeat]> = [];
        for (const c of launches) {
          const beat = c.beats[c.next];
          c.next += 1;
          launchedBeats.push([c, beat]);
          applyHolds(c.frame, beat.held);
          const anim = animate(
            c.frame,
            springSettleKeyframes(beat.terms, curve.progress),
            {
              ...settleOpts,
              duration: curve.durationMs,
              // A keyword easing, because the curve rides in the keyframe
              // offsets — `lib/pane-flip.ts` says why a sampled `linear()`
              // cannot be used here.
              easing: "linear",
              key: "imposer-flip",
            },
          );
          c.anims.push(anim);
          anims.push(anim);
        }
        // The hold this beat replaced comes off when the beat LANDS, not at
        // the settle's completion. TugAnimator commits an effect's value at
        // its end, and under `fill: none` that value is the underlying inline
        // style — the opening pose — so a frame left wearing it would snap
        // back to its hold for the length of the next beat.
        //
        // How it comes off differs by property, and that is the whole of the
        // care here. A TRANSFORM is the imposer's own and nothing underlies
        // it, so it is removed. An AXIS is not: React renders the frame's
        // committed size into the same inline property the hold was written
        // over, so removing it takes React's number away too and drops the
        // frame to whatever its content makes of it — for a folded card, its
        // OPEN floor, held there for every beat between its own and the
        // settle's completion. So an axis is HANDED BACK (`handBack`) rather
        // than removed: the beat ended at the committed size, which is
        // exactly the value React rendered, so the write leaves the frame
        // where the beat put it and the frame keeps a height for the rest of
        // the settle.
        //
        // Idempotent, because it has two callers: the completion handler
        // below, a promise hop after the tweens end, and `arm`, which lands
        // the beat itself when a commit finds the tweens already over — the
        // record on `settleBeatRef` says why that door exists.
        let landed = false;
        const land = (): void => {
          if (landed) return;
          landed = true;
          for (const [c, beat] of launchedBeats) {
            // Stated as a rule over what the beat ANIMATED rather than as a
            // list of kinds: a beat ends at the value it animated to, which
            // is identity for a transform and the committed size for an
            // axis, so every property this beat carried can be settled here
            // and leave the frame exactly where the beat put it. The fused
            // `room` beat carries all three at once, which a per-kind list
            // could only have covered by naming it in both branches.
            if (
              beat.terms.dx !== 0 ||
              beat.terms.dy !== 0 ||
              (beat.terms.sx ?? 1) !== 1
            ) {
              c.frame.style.removeProperty("transform");
            }
            if (beat.terms.width !== undefined) {
              c.handBack.width?.();
            }
            if (beat.terms.height !== undefined) {
              c.handBack.height?.();
            }
          }
        };
        // The beat the settle is on, for the arm that may interrupt it: it
        // reads the velocity off this recipe at the time since this launch,
        // and lands the beat itself if the launch is already over.
        settleBeatRef.current = {
          kind,
          launchedAt: performance.now(),
          initialVelocity: beatLaunchVelocity(kind, launch),
          anims,
          land,
        };
        // `allSettled` because `finished` rejects under hold-at-current — the
        // retarget's cancel — and the generation check on the far side is
        // what tells that apart from a beat that landed. TugAnimator resolves
        // `finished` after committing, so a completion here always runs on
        // the far side of the residue it takes back.
        return Promise.allSettled(anims.map((anim) => anim.finished)).then(
          () => {
            if (settleGenerationRef.current !== generation) return;
            land();
          },
        );
      };
      void BEAT_ORDER.reduce(
        (chain, kind) => chain.then(() => runBeat(kind)),
        Promise.resolve(),
      )
        .then(() => {
          if (settleGenerationRef.current !== generation) return;
          // The settle's one completion, after the final beat's last tween,
          // in this order ([B04]): every frame's inline residue handed back
          // and its transform taken off; then every frame's fold crossing
          // ended — guarded by id, so an interrupted settle does not close
          // the one that replaced it — so the card can land what CSS cannot
          // write ([B05]); then every frame's resize episode ended, after the
          // restorers so the final anchor is read against the geometry the
          // frame actually keeps; and then, through `settled`, the stores'
          // hold released, so the one publish and the one pin land on
          // settled geometry.
          for (const c of choreography) {
            for (const restore of c.restores) restore();
            clearFlip(c.paneId, c.frame, c.anims);
          }
          // The arrivals take the same three, in the same order, because the
          // arrive beat replaced the effect that used to do this in its own
          // completion handler. An arriving frame has no fold crossing — it was
          // not on screen to open one — so it joins at the restore and the
          // episode, not in the crossing loop between them.
          for (const { paneId, frame, restores } of arrivals) {
            for (const restore of restores) restore();
            clearFlip(paneId, frame, settleTweensRef.current.get(paneId)?.anims ?? []);
          }
          for (const { key, strip, restores } of arrivingStrips) {
            for (const restore of restores) restore();
            clearFlip(key, strip, settleTweensRef.current.get(key)?.anims ?? []);
          }
          // The covered members' holds and marks come off here and nowhere
          // earlier: the survivor has covered a retiring member, or retreated
          // off a revealed one, only when the chain is done ([B03]).
          for (const c of covered) {
            for (const restore of c.restores) restore();
            clearFlip(c.paneId, c.frame, c.anims);
          }
          for (const c of choreography) {
            if (c.crossingId !== null) endFoldCrossing(c.frame, c.crossingId);
            if (c.stillCrossingId !== null) {
              endStillCrossing(c.frame, c.stillCrossingId);
            }
          }
          for (const c of choreography) endEpisode(c.paneId);
          for (const { paneId } of arrivals) endEpisode(paneId);
          for (const { paneId } of covered) endEpisode(paneId);
          settleBeatRef.current = null;
          settled();
        });
    } else {
      // No chain to ride, so nothing is coming to release these: the survivor
      // never moved, and a hold with no release would be a frame left standing
      // at a tile the deck no longer has.
      for (const c of covered) {
        for (const restore of c.restores) restore();
        clearFlip(c.paneId, c.frame, c.anims);
        endEpisode(c.paneId);
      }
    }
    // Nothing this pass launched is left to finish — a settle whose every
    // frame was gesture-owned, or moved nowhere — so the hold comes off now
    // rather than at the sweep.
    if (outstanding === 0) finish();
    firstRects.clear();
    firstFolds.clear();
    firstRailSides.clear();
    firstRailShadows.clear();
    holdPlan.survivors.clear();
    holdPlan.covered.clear();
    holdPlan.held.clear();
  }, [arrangement]);

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
  const impositionKind = deckState.imposition.kind;
  const placementFor = useCallback(
    (pane: TugPaneState) => {
      if (impositionKind === undefined || pane.slot === undefined) {
        return undefined;
      }
      const placement = resolvePlacement(impositionKind, pane.slot);
      const stripLeft = flowStrip?.positions.get(placement.slot);
      return stripLeft === undefined
        ? placement
        : { ...placement, flow: { stripLeft } };
    },
    [impositionKind, flowStrip],
  );

  // The width an ordinary card opens at in this arrangement. Resolved with no
  // per-pane bounds — this is the arrangement's number, not any one card's —
  // and read only by a size-locked pane, to size the SLOT it is centred in.
  const contentWidthPx = resolveContentWidthPx(
    deckState.imposition.contentWidth ?? DEFAULT_CONTENT_WIDTH,
    0,
  );

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
    const held = new Set(
      deckState.panes
        .filter((pane) => pane.slot !== undefined)
        .map((pane) => clampSlot(impositionKind, pane.slot as number)),
    );
    const reserved = deckVacancyExtent(deckState);
    const tiles: { slot: number; style: React.CSSProperties }[] = [];
    for (let slot = 0; slot < slotCount(impositionKind); slot += 1) {
      if (held.has(slot)) continue;
      const placement = resolvePlacement(impositionKind, slot);
      const stripLeft = flowStrip?.positions.get(slot);
      tiles.push({
        slot,
        style: imposeStyle(
          stripLeft === undefined
            ? placement
            : { ...placement, flow: { stripLeft } },
          reserved,
        ),
      });
    }
    return tiles;
  }, [impositionKind, deckState, flowStrip]);

  // The pane standing in bullseye, derived once per render and handed down as
  // a boolean per pane. Read here rather than in each pane because the answer
  // is deck state — which pane holds the first responder — and a pane cannot
  // see that from its own props.
  const bullseyePaneId = bullseyePaneIdOf(deckState);

  // Where the bullseyed pane WAS before it took the posture — its centre, as
  // a CSS length expression, in the frames container's coordinates.
  //
  // This is the line the other content panes are sorted around: everything
  // left of it leaves by the left edge, everything right of it by the right.
  // Sorting around the CANVAS centre instead was the first cut and it let
  // cards cross the bullseyed card on their way out — bullseye the leftmost
  // card of a three-up and the middle card, still left of the canvas centre,
  // would slide left THROUGH the card that was arriving there. Sorting around
  // the bullseyed card's own former place makes crossings impossible by
  // construction: each pane leaves by the side it was already on.
  //
  // It is the pane's PRE-bullseye anchor deliberately, not its bullseyed one.
  // Bullseye writes nothing, so the pane still carries its slot and its
  // stored position, and `placementFor` still answers with the placement it
  // will return to — which is exactly the reference the user's eye used
  // before the gesture started.
  //
  // A bullseyed RAIL is anchored at its pin on the deck's edge, not at its
  // stored `position.x` — which for a pinned pane is the same superseded
  // last-known value an imposed pane's is, and would put the line the other
  // panes sort around wherever the rail last happened to be dragged. Its
  // width is the RAIL's (the widest member's), because that is the box the
  // band is already inset by and the box the rail returns to.
  const bullseyeAnchorCentre = ((): string | undefined => {
    if (bullseyePaneId === null) return undefined;
    const pane = deckState.panes.find((p) => p.id === bullseyePaneId);
    if (pane === undefined) return undefined;
    const railStanding = stackByPaneId.get(pane.id);
    if (railStanding !== undefined) {
      // Written out rather than taken from `imposeSidebarStyle`, whose `left`
      // is a calc over `--tugx-rail-side` — a property that rail's own frame
      // declares on itself. Read from any other pane it would resolve to
      // nothing. The width term is the live rail property with the
      // React-known width as its fallback, the same pairing every rail
      // expression uses, so a drag moves this line in the same reflow.
      const railWidth = railWidthOf(railStanding.side);
      const half = `var(${sidebarWidthProperty(railStanding.side)}, ${railWidth}px) / 2`;
      return railStanding.side === "left"
        ? `calc(${RAIL_EDGE_INSET_PX}px + ${half})`
        : `calc(100% - ${RAIL_EDGE_INSET_PX}px - ${half})`;
    }
    // Through `placementFor`, so on a flow deck this line is the FLOW left —
    // strip position and viewport offset — rather than the fit anchor. That is
    // the one part of bullseye flow touches ([P10]): the bullseyed pane's own
    // geometry is unchanged (still centred one-up, still offset-free, above),
    // but the line the OTHERS sort around has to be where they actually stand,
    // or the sort that makes crossings impossible sorts around a place nothing
    // is and they cross on the way out.
    const placement = placementFor(pane);
    const left =
      placement === undefined
        ? `${pane.position.x}px`
        : String(imposeStyle(placement, pane.size.width).left ?? "0px");
    return `calc(${left} + ${pane.size.width / 2}px)`;
  })();

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
      const zoom = getTugZoom() || 1;
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
      const zoom = getTugZoom() || 1;
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
    return {
      enumerate(draggedPaneId, tabBars, draggedAtStart) {
        const canvas = containerRef.current;
        if (canvas === null) return { zones: [], origin: null };
        const zoom = getTugZoom() || 1;
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
          band: store.getBandEdges(),
          // The runs are the deck's own measurement rather than a sum of the
          // frames above: a frame in flight is one of those frames, and the
          // store is the one reader a hand cannot move.
          runs: {
            column: store.getColumnRunHeight(),
            rail: store.getRailRunHeight(),
          },
          draggedAtStart,
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
      },

      indicate(zone) {
        // A tab bar indicates through the attribute it has always indicated
        // through, which the gesture stamps itself — showing the outline there
        // too would be two answers to one question ([P10]).
        const rect =
          zone === null || zone.kind === "tab-bar" ? null : zone.rect;
        indicateDropZone(containerRef.current, rect);
        // Instruments away from the canvas hear the same answer ([P08]): a
        // place being offered, or none. A tab bar publishes none, so the
        // miniature's highlight and the canvas outline say the same thing.
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
        const canvas = containerRef.current;
        if (canvas !== null) {
          if (frame === null) canvas.removeAttribute("data-carrying");
          else {
            canvas.setAttribute(
              "data-carrying",
              frame.getAttribute("data-role") === "sidebar" ? "rail" : "card",
            );
          }
        }
      },

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
            const zoom = getTugZoom() || 1;
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
            const zoom = getTugZoom() || 1;
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
        const property =
          target.kind === "column"
            ? columnOffsetProperty(target.slot ?? 0)
            : target.kind === "rail"
              ? railOffsetProperty(target.side ?? "left")
              : FLOW_OFFSET_PROPERTY;
        el.style.setProperty(property, `${Math.round(offset)}px`);
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

  // ---------------------------------------------------------------------------
  // The switch is one dissolve
  // ---------------------------------------------------------------------------
  // A workspace switch lands as a cut ([P11]): both sets of frames are already
  // drawn where the commit puts them, the settle declines it, and nothing
  // moves. What is left is the JOIN between two still pictures, and this is
  // it — the workspace being left painted OVER the one arriving for the length
  // of one `divide-join` window, and dissolved off it.
  //
  // One layer moves, not two. The arriving workspace is opaque underneath from
  // the first frame and is never touched; only the departing wrapper's own
  // opacity is tweened, 1 to 0. That is what makes anything the two workspaces
  // share appear not to move at all: where the picture is the same on both
  // sides, `t·C + (1−t)·C` is `C` at every instant. Fading both at once — a
  // true crossfade — put two partial pictures over canvas ground and showed
  // the ground between them, which is the blank this replaced.
  //
  // The tween rides the WRAPPER rather than the frames under it, which is the
  // other half of the same argument: one opacity composites the departing deck
  // as a single picture, where N of them would have let its own overlapping
  // panes show through each other on the way out. `space-layer.css` gives the
  // wrapper the box and the z-index that makes that possible.
  //
  // Everything here is DOM: an attribute on the outgoing wrapper and one
  // opacity tween on it, no React state, nothing that renders ([L06]). The
  // wrapper is `display: none` at rest, so the beat is a debt from the moment
  // it is opened, and `[L32]` is the law that names what that debt costs if it
  // is not paid: the departing workspace painted over the arriving one forever,
  // opaque, at the top of the canvas, taking no pointer. Hence four separate
  // ways for the beat to land, all of them the same idempotent `teardown` — the
  // completion of the tween, a deadline, the next switch, and the effect's own
  // cleanup.
  const crossfadeRef = useRef<{
    generation: number;
    anims: TugAnimation[];
    restores: Array<() => void>;
    deadline: number | null;
  }>({ generation: 0, anims: [], restores: [], deadline: null });
  /** The workspace the last commit was showing — the one a switch fades OUT. */
  const previousSpaceIdRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    const activeSpaceId = spacesSnapshot.activeSpaceId;
    const previousSpaceId = previousSpaceIdRef.current;
    previousSpaceIdRef.current = activeSpaceId;
    const state = crossfadeRef.current;

    /**
     * End whatever beat is in flight, and leave no residue ([B09]).
     *
     * Unconditional and idempotent: it bumps the generation first, so any
     * landing still to arrive for the beat it just ended is a no-op, and it
     * strips the attribute by sweeping for it rather than by remembering which
     * element wore it — the only reading that is still right after a layer has
     * been unmounted underneath a beat.
     *
     * `hold-at-current` rather than `snap-to-end` is the load-bearing choice:
     * it commits the interpolated value into `el.style` SYNCHRONOUSLY, so the
     * restorers below run after the commit and take it off. `snap-to-end`
     * commits in a microtask, which would land the baked opacity after the
     * hand-back and freeze a frame at whatever the tween had reached.
     */
    const teardown = (): void => {
      state.generation += 1;
      if (state.deadline !== null) {
        window.clearTimeout(state.deadline);
        state.deadline = null;
      }
      const anims = state.anims;
      state.anims = [];
      for (const anim of anims) anim.cancel("hold-at-current");
      const restores = state.restores;
      state.restores = [];
      for (const restore of restores) restore();
      const el = containerRef.current;
      if (el !== null) {
        for (const layer of el.querySelectorAll<HTMLElement>(
          `.${SPACE_LAYER_CLASS}[${SPACE_CROSSING_ATTRIBUTE}]`,
        )) {
          layer.removeAttribute(SPACE_CROSSING_ATTRIBUTE);
        }
      }
    };
    teardown();

    const root = containerRef.current;
    // Four ways there is nothing to fade, and every one of them writes nothing
    // at all rather than opening a beat that would have to be closed. The last
    // is a workspace that was DELETED rather than switched away from: its
    // layer left with it, and there is no picture to cross from.
    if (root === null || previousSpaceId === null) return;
    if (previousSpaceId === activeSpaceId) return;
    if (!isTugMotionEnabled()) return;
    const layerOf = (spaceId: string): HTMLElement | null =>
      root.querySelector<HTMLElement>(
        `.${SPACE_LAYER_CLASS}[${SPACE_LAYER_ATTRIBUTE}="${CSS.escape(spaceId)}"]`,
      );
    const outgoing = layerOf(previousSpaceId);
    if (outgoing === null) return;

    // The wrapper's OWN subtree, scoped. `SHOWN_PANE_FRAMES` cannot answer
    // here — it excludes anything inside a layer without `data-space-shown`,
    // which is exactly the layer being dissolved — and widening it is not the
    // answer either: its nine readers all mean "the panes on screen", and a
    // layer on its way out is not one of them.
    //
    // Only the OUTGOING side is counted now, because only it is animated: a
    // departing workspace with no frames has no picture to dissolve, and
    // opening a beat for it would put an empty box over the canvas for a few
    // hundred ms and then take it away again.
    const outgoingFrames = outgoing.querySelectorAll(".tug-pane[data-pane-id]");
    if (outgoingFrames.length === 0) return;

    // On top, painted, and inert. The panes under it have boxes again, at the
    // same absolute positions they had a frame ago — the wrapper's box is the
    // canvas container's box — and the whole layer takes no pointer.
    outgoing.setAttribute(SPACE_CROSSING_ATTRIBUTE, "");

    // The deck's one clock. `divide-join` is the recipe every fade on this
    // canvas already runs on — the settle's own depart and arrive beats — so
    // a switch dissolves over the same length and shape
    // rather than a curve this call site picked for itself.
    const curve = motionKeyframes("divide-join", {
      nominalMs: settleDurationRef.current,
    });
    const generation = state.generation;
    let outstanding = 0;
    const land = (): void => {
      outstanding -= 1;
      if (outstanding === 0 && state.generation === generation) teardown();
    };
    // Taken BEFORE the tween: TugAnimator commits a final value into
    // `el.style` on completion, so the residue is owed back whichever way this
    // beat ends.
    state.restores.push(inlineRestorer(outgoing, "opacity"));
    const anim = animate(
      outgoing,
      { opacity: [1, 0] },
      {
        // Raw ms: TugAnimator scales by getTugTiming() itself.
        duration: curve.durationMs,
        easing: "ease-out",
        // `fill: "none"` is where [P08] lives. Nothing in this effect writes
        // an inline hide anywhere, so an animation that never launches leaves
        // a visible layer rather than a hidden one — and the visible one is
        // the DEPARTING workspace, which the teardown below takes off in the
        // same turn. The arriving workspace is opaque underneath either way,
        // so the worst a failed launch can do is a cut.
        fill: "none",
        key: "space-dissolve",
      },
    );
    state.anims.push(anim);
    outstanding += 1;
    anim.finished.then(land, land);

    // The deadline [L32] clause 2 asks for. A completion handler is not on its
    // own an end state: a layer unmounted mid-beat takes its animations with
    // it and no `.finished` ever settles, which would strand the attribute —
    // and with it a `display: contents` wrapper over the workspace the user is
    // looking at. Scaled by the same factor TugAnimator scales the tween by,
    // so a slowed-down deck is not cut short by its own safety net.
    const deadlineMs =
      curve.durationMs * getTugTiming() + SPACE_CROSSFADE_DEADLINE_MARGIN_MS;
    state.deadline = window.setTimeout(() => {
      state.deadline = null;
      if (state.generation === generation) teardown();
    }, deadlineMs);

    return () => teardown();
  }, [spacesSnapshot.activeSpaceId]);

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
  const wheelGestureRef = useRef<{ offset: number; timer: number | null }>({
    offset: 0,
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
      const state = store.getSnapshot();
      const strip = deckFlowStrip(state);
      const band = store.getBandWidth();
      if (strip === null || band === null || band <= 0) return;
      if (scrollableAncestor(event.target)) return;
      event.preventDefault();
      // Picked up from the store on the first event of a gesture and carried in
      // the ref after that, so a commit landing mid-gesture cannot rewind the
      // hand. Clamped every frame with the store's own arithmetic, so the frame
      // never shows an overshoot the commit would reject.
      const standing =
        gesture.timer === null ? (state.flowOffset ?? 0) : gesture.offset;
      gesture.offset = clampFlowOffset(standing + delta, strip.width, band);
      previewFlowOffset(gesture.offset);
      if (gesture.timer !== null) window.clearTimeout(gesture.timer);
      gesture.timer = window.setTimeout(() => {
        gesture.timer = null;
        commitFlowOffset(gesture.offset);
      }, FLOW_WHEEL_IDLE_MS);
    };

    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      el.removeEventListener("wheel", onWheel);
      if (gesture.timer !== null) {
        window.clearTimeout(gesture.timer);
        gesture.timer = null;
      }
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
      {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions */}
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
      {vacantRails.map((vacancy) => (
        <div
          key={`rail-vacancy:${vacancy.side}`}
          className="tug-rail-vacancy"
          data-vacant-rail={vacancy.side}
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
          shadows they share the canvas with. Hidden, it is `display: none`.
          Both rules are in space-layer.css, keyed on `data-space-shown`
          ([L06]); this body writes the attribute and nothing else.

          A hidden workspace's panes take no interaction: no drop zones, no
          close, no reveal, no move menu. They are mounted so their cards stay
          alive, and nothing more. */}
      {spaceLayers.map((layer) => {
        const layerCardsById = layer.shown
          ? cardsById
          : new Map(layer.deck.cards.map((c) => [c.id, c] as const));
        const layerStacks = layer.shown
          ? sortedStacks
          : [...layer.deck.panes].sort((a, b) => a.id.localeCompare(b.id));
        const layerSidebarPaneIds = layer.shown
          ? sidebarPaneIds
          : new Set(findSidebarPanes(layer.deck).map(({ pane }) => pane.id));
        // A hidden workspace is ranked too — `buildZIndexMap` says why: it is
        // painted, opaque and on top, for the beat it is being dissolved off.
        const layerZIndexMap = layer.shown
          ? zIndexMap
          : buildZIndexMap(layer.deck.panes, layerSidebarPaneIds);
        const layerHostStackIdByCardId = layer.shown
          ? hostStackIdByCardId
          : new Map(
              layer.deck.panes.flatMap((p) =>
                p.cardIds.map((cid) => [cid, p.id] as const),
              ),
            );
        return (
          <div
            key={layer.spaceId}
            className="tug-space-layer"
            data-space-layer={layer.spaceId}
            {...(layer.shown ? { "data-space-shown": "" } : {})}
          >
            {/* The one fact a card in here may need about its own standing:
                whether the workspace it is mounted in is on screen. Read by
                anything that acts on a BROADCAST rather than on the responder
                chain — see the context's own doc. */}
            <SpaceLayerShownContext.Provider value={layer.shown}>
            {/* TugPanes: one per pane in this workspace's deck.
                Rendered in stable ID order (no DOM reordering on focus change).
                Z-index from store array position (first = lowest). Panes whose
                active card's componentId is unregistered are skipped with a
                warning. */}
            {layerStacks.map((stackState) => {
              const activeCard = layerCardsById.get(stackState.activeCardId);
              const fallbackCard =
                activeCard ?? layerCardsById.get(stackState.cardIds[0]);
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

              /**
               * onClose wrapper: when the closed stack matches
               * Close-button handler: delegates to store. No gallery-stack bookkeeping
               * needed — show-component-gallery re-derives the gallery stack from
               * the live snapshot on every dispatch.
               */
              const handleClose = () => {
                store.handlePaneClosed(stackState.id);
              };

              const stackCards = stackState.cardIds
                .map((cid) => layerCardsById.get(cid))
                .filter((c): c is NonNullable<typeof c> => c !== undefined);
              const hasMultipleCards = stackCards.length > 1;

              return (
                <TugPane
                  key={stackState.id}
                  stackState={stackState}
                  meta={registration.defaultMeta}
                  layoutRole={registration.layoutRole}
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
                      unbound: isUnboundMember(layer.deck, stackState.id),
                    },
                  )}
                  zIndex={
                    layerZIndexMap.get(stackState.id) ?? CARD_ZINDEX_BASE
                  }
                  // Every placement below is the SHOWN workspace's. A hidden
                  // one has no imposition to stand in — its panes come back
                  // through these same props the moment it is shown, which is
                  // the commit that also reveals them.
                  placement={layer.shown ? placementFor(stackState) : undefined}
                  bullseye={layer.shown && bullseyePaneId === stackState.id}
                  // Every OTHER content pane leaves the canvas while bullseye
                  // holds — receding a card that is still sitting there is not
                  // what "distraction-free" means. Rails are excluded and stay at
                  // their pins: a rail leaving would take the band's insets with
                  // it, and the bullseyed card would jump the moment the posture
                  // began.
                  bullseyeExit={
                    layer.shown &&
                    bullseyePaneId !== null &&
                    bullseyePaneId !== stackState.id &&
                    !layerSidebarPaneIds.has(stackState.id)
                      ? bullseyeAnchorCentre
                      : undefined
                  }
                  contentWidthPx={layer.shown ? contentWidthPx : undefined}
                  slotStack={
                    layer.shown ? slotStackByPaneId.get(stackState.id) : undefined
                  }
                  columnMember={
                    layer.shown
                      ? columnMemberByPaneId.get(stackState.id)
                      : undefined
                  }
                  columnMode={
                    layer.shown ? columnModeByPaneId.get(stackState.id) : undefined
                  }
                  arriving={
                    layer.shown
                      ? arrivingSeatByPaneId.get(stackState.id)
                      : undefined
                  }
                  // The pane's own field ([P01]) rather than `paneFoldedOf` over
                  // the deck state: the selector exists for readers holding a state
                  // and an id, and this one is already holding the pane.
                  folded={stackState.folded === true}
                  onRevealPane={layer.shown ? handleRevealPane : undefined}
                  spaces={spacesSnapshot.spaces}
                  activeSpaceId={spacesSnapshot.activeSpaceId}
                  onMoveToSpace={
                    layer.shown
                      ? (spaceId) => {
                          // The pane's ACTIVE card is what moves — the one the
                          // title bar is naming. [B04]: the move does not follow
                          // the card, so nothing here touches the active
                          // workspace.
                          store.moveCardToSpace(stackState.activeCardId, spaceId);
                        }
                      : undefined
                  }
                  sidebarStack={
                    layer.shown ? stackByPaneId.get(stackState.id) : undefined
                  }
                  isSidebarPane={layerSidebarPaneIds.has(stackState.id)}
                  onCardMoved={store.handlePaneMoved}
                  onClose={layer.shown ? handleClose : undefined}
                  dropZones={layer.shown ? dropZoneHost : undefined}
                  onCardMerged={
                    layer.shown
                      ? (sourceStackId, targetStackId, insertIndex) => {
                          // Resolve the active card id from the source stack at
                          // commit time.
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
                        }
                      : undefined
                  }
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
            {layer.deck.cards.map((card) => {
              const hostStackId = layerHostStackIdByCardId.get(card.id);
              if (!hostStackId) return null;
              const hostStack = layer.deck.panes.find((s) => s.id === hostStackId);
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
            </SpaceLayerShownContext.Provider>
          </div>
        );
      })}

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
      {sidebarRails.flatMap((rail) => {
        const allocation = rail.allocation;
        if (allocation === null || allocation.ids.length < 2) return [];
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
          rail at all. Each paints the body's own ground, grid and all, so it
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
            style={{ width: `${bare}px`, zIndex: MARGIN_CAP_ZINDEX }}
            {...{ [CANVAS_BACKGROUND_ATTRIBUTE]: "" }}
          />
        );
      })}
      {/* The rail shadows: one strip per railed side, standing in the gutter
          off the rail's inner edge. It is the rail's z-order made visible —
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
          for the falloff and its reasoning. */}
      {(["left", "right"] as const).map((side) => {
        // The same `railWidthOf` the inset effect reads, so the shadow and
        // the band can never disagree about where the rail's inner edge is.
        // No rail on this side, nothing to cast a shadow.
        if (railWidthOf(side) === 0) return null;
        const innerEdge =
          `calc(${RAIL_EDGE_INSET} + var(${sidebarWidthProperty(side)}, 0px))`;
        return (
          <div
            key={`rail-shadow:${side}`}
            className={`tug-rail-shadow tug-rail-shadow--${side}`}
            data-rail-shadow={side}
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
      {/* Deck-global update surface, on one anchor at the window's top
        * centre. Renders nothing while the host has nothing to say, and
        * nothing it renders ever takes focus; portals into the overlay root
        * above. */}
      <UpdateOverlay />
      </div>
    </ResponderScope>
  );
}
