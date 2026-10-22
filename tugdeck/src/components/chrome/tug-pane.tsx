/**
 * TugPane — the shell's stand-in for a pane: its frame, laid out and read,
 * painting nothing.
 *
 * Every card draws its pane's chrome in its own page — title bar, tab bar,
 * grips, border, shadow — and the host moves that view whole. What stays in
 * the shell is the arrangement's model of the pane:
 *
 * - An absolutely-positioned `.tug-pane` at the geometry its mode resolves —
 *   pinned to a rail, imposed in a slot, free at its stored rect, or in
 *   bullseye — which the imposer, the drop zones and the settle read, and
 *   which the placer measures to place the card's view.
 * - The data attributes the shell's stylesheets, queries and the host read:
 *   which edges the hand may resize from (`data-grips`), the floor
 *   (`data-min-*`), whether the pane is free, and its standing in a rail or a
 *   column.
 * - The pane's place in the responder chain, answering the verbs that are the
 *   deck's (tab selection, the slot's depth ring) and handing the close and
 *   reveal verbs to the card's page, which draws the confirm and the picker.
 *
 * It drags, resizes and snaps nothing: the host carries a card in its hand
 * and the shell's half of the gesture is `lib/host-card-gesture.ts`.
 *
 * Pane activation (bring-to-front on pointer-down) is driven by the
 * document-level capture-phase listener in `pane-focus-controller.ts`, and
 * the frame's `data-focused` attribute is written by that module, not
 * rendered from a prop here.
 *
 * @module components/chrome/tug-pane
 */

import "../tugways/tug-pane.css";
import React, {
  createContext,
  memo,
  useCallback,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { useSyncExternalStore } from "@/lib/gesture-scope";
import { bodyCardsStore } from "@/lib/body-cards-store";
import type { CardState, TugPaneState } from "@/layout-tree";
import type { SlotStackEntry } from "@/deck-store-selectors";
import type { CardSizePolicy, LayoutRole } from "@/card-registry";
import { DEFAULT_SIZE_POLICY, getRegistration } from "@/card-registry";
import { TAB_BAR_HEIGHT_PX } from "@/lib/drop-zones";
import { useResponder } from "@/components/tugways/use-responder";
import type { ActionEvent } from "@/components/tugways/responder-chain";
import { TUG_ACTIONS } from "@/components/tugways/action-vocabulary";
import { TugPaneFrameContext } from "./pane-chrome";
import { plainEqual } from "@/lib/plain-equal";
import { useDeckManager } from "@/deck-manager-context";
import {
  imposeStyle,
  travelFraction,
  type ColumnMemberPlacement,
  imposeSidebarStyle,
  type PinnedFrame,
  type PlaceStanding,
  type SidebarSide,
  impositionGapPx,
  type ImposedPlacement,
  DEFAULT_CONTENT_WIDTH,
  resolveContentWidthPx,
} from "@/lib/layout-imposer";
import { adoptColumnProperties } from "./place-properties";
import { cardTitleStore } from "@/lib/card-title-store";
import { selectTab, closeTab } from "@/lib/pane-verbs";
import {
  keepSlotGripsOf,
  railGripsOf,
  type ResizeEdge,
} from "@/lib/pane-chrome-projection";
import { commandForCard } from "@/bus/declarations/verbs";
import * as paneContentRegistry from "@/components/chrome/pane-content-registry";
import * as paneFrameRegistry from "@/components/chrome/pane-frame-registry";
import * as paneRootRegistry from "@/components/chrome/pane-root-registry";
import {
  mayDeferCommit,
  transferFocusForActivation,
} from "@/focus-transfer";
import { panePlaceFactsOf, placeFactsFor, placeSource } from "./pane-place-facts";
import { useRailWidthGesture } from "@/components/chrome/rail-width-draft";
import {
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

/**
 * The pane's floor, from the model: the title bar's height, the tab bar's on
 * a pane of several cards, and the content's minimum below them, never under
 * the size policy's own floor. Computed rather than measured, because the
 * chrome these heights describe is drawn in the card's page.
 */
const HEADER_HEIGHT_PX = 28;
const MIN_CONTENT_PX: { width: number; height: number } = { width: 100, height: 60 };

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
  /** How many cards stand on the rail. */
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
 * Props for the TugPane component (the pane's stand-in frame).
 */
export interface TugPaneProps {
  /** Window position, size, id, and width preset from DeckState. */
  stackState: TugPaneState;
  /**
   * The active card's registered layout role. A single-card pane has no
   * `cards` array to resolve a registration from, so the caller — which
   * already holds that registration — hands the role down. A stacked pane
   * resolves it from its own active card instead. `"sidebar"` is what stamps
   * the rail's chrome tier on the frame.
   */
  layoutRole?: LayoutRole;
  /** All cards in this window; set when there are several. */
  cards?: readonly CardState[];
  /**
   * The active card's id. Defaults to `stackState.activeCardId` when omitted.
   */
  activeCardId?: string;
  /** Close the pane: the one close the shell makes itself, for a card no page stands for. */
  onClose?: () => void;
  /**
   * This pane's place in the imposition chain, when it holds a slot. Resolved
   * by `DeckCanvas`, which is the only vantage point that can see every
   * slotted pane's width at once. Absent for a free pane and for a rail pane.
   */
  placement?: ImposedPlacement;
  /**
   * True while this pane stands in bullseye — centered in the band at the
   * comfy width, over the full vertical run, with every other pane receded.
   *
   * A presentation over whichever geometry mode the pane already holds, not a
   * fourth mode: it takes precedence over both derived modes while it lasts,
   * and the pane's stored `position` / `size` / `slot` / `widthPreset` are
   * untouched throughout, so leaving bullseye restores nothing.
   */
  bullseye?: boolean;
  /**
   * Set while ANOTHER pane stands in bullseye and this one is a content pane
   * — so this pane gets out of the way. The value is the bullseyed pane's
   * PRE-bullseye centre as a CSS length expression: this pane leaves by the
   * left edge if it sits left of that line and by the right edge if it sits
   * right of it, so nothing slides through the card arriving at the centre.
   * Rails keep their pins and recede in place.
   */
  bullseyeExit?: string;
  /**
   * The deck's content-width preset in pixels — the width an ordinary card
   * opens at in this arrangement. Only a size-locked pane reads it, and only
   * to size its SLOT: About is 320 wide by registration, but the slot it
   * stands in is the one every other card in the arrangement gets.
   */
  contentWidthPx?: number;
  /**
   * Whether an edge resize of this pane, if it is imposed, keeps its slot —
   * the deck's resize rule, resolved by `DeckCanvas` from the imposition.
   * Absent reads as false: a resize releases.
   */
  resizeKeepsSlot?: boolean;
  /** Raise the pane a slot-stack entry names: the depth ring's raise. */
  onRevealPane?: (entry: SlotStackEntry) => void;
  /**
   * Set only on a pane standing in a rail: where that rail stands and where
   * this pane stands on it. Resolved by `DeckCanvas` — the pane carries no
   * marker of its own ([P04]).
   */
  sidebarStack?: SidebarStackStanding;
  /**
   * Set only on a PARKED rail member — a sidebar card whose rail was hidden
   * whole — to the side it is parked on. The frame stays mounted at its
   * pinned box, with `data-rail-parked` and `inert`, and stands in no rail.
   */
  railParked?: SidebarSide;
  /**
   * Set only on a DEPARTING pane — closed, but kept mounted for the one
   * settle that carries it out. The frame wears `data-departing` and `inert`
   * until the settle's land unmounts it.
   */
  departing?: boolean;
  /**
   * Set only on a pane standing in a SPLIT slot: which slot, which position in
   * its column, and how many members divide the run. Absent on a stacked
   * slot, on a column of one, on a free pane, and on a rail.
   */
  columnMember?: ColumnMemberPlacement;
  /**
   * The pane is ARRIVING: appended to its column but not yet part of its
   * division, drawn hidden at the seat it will take ([B01], [B08]). The value
   * is the SEAT: `"bottom"` at the run's bottom at the floor, `"run"` the
   * undivided run. Projected onto the frame as `data-arriving` and
   * `visibility: hidden` ([B02]), which the settle reads to skip the frame.
   */
  arriving?: ArrivingSeat;
  /**
   * Set on a pane hosting a sidebar card, pinned or not: a rail dragged off
   * its pin is still a rail, and never accepts a merge.
   */
  isSidebarPane?: boolean;
  /** CSS z-index for stacking order. */
  zIndex: number;
  /**
   * Size policy for this card type: min as the floor, max as the ceiling.
   * Falls back to DEFAULT_SIZE_POLICY when omitted.
   */
  sizePolicy?: CardSizePolicy;
  /**
   * The pane wears its folded form ([P01], [P03]). Projected onto the frame
   * as `data-folded`, which surfaces seated below the title bar still read.
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
 * the caller having to know which mode produced the pin. Anything else falls
 * back to `0px` rather than producing an invalid expression that would drop
 * the whole declaration.
 */
function cssLength(value: CSSProperties["left"]): string {
  if (typeof value === "number") return `${value}px`;
  if (typeof value === "string" && value.length > 0) return value;
  return "0px";
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
 * TugPane — positions a pane's stand-in frame and answers its chain verbs.
 */
function TugPaneImpl({
  stackState,
  layoutRole,
  cards,
  activeCardId: activeCardIdFromProps,
  onClose,
  sizePolicy: sizePolicyProp,
  zIndex,
  placement,
  contentWidthPx,
  resizeKeepsSlot = false,
  onRevealPane,
  sidebarStack,
  railParked,
  departing = false,
  isSidebarPane = false,
  bullseye = false,
  bullseyeExit,
  columnMember,
  arriving,
  folded = false,
}: TugPaneProps) {
  const sidebarSide = sidebarStack?.side;
  // A PARKED member keeps its rail edge: the frame is inert and hidden, and
  // swapping its one edge for a free pane's eight would be a change the show
  // pays for.
  const barSide = sidebarSide ?? railParked;
  // A split rail's member takes its share of the run instead of the whole of
  // it. Passed to the imposer rather than resolved here — the pins are its
  // arithmetic, and a rail of one is stacked geometry whatever the mode says.
  const railSplit = sidebarStack !== undefined && sidebarStack.count > 1;
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
  // at a fixed pin and keeps its own width, so it offers only its deck-facing
  // resize edge.
  //
  // Imposed — a slotted pane. It derives its position from its slot's anchor
  // and its height from the canvas, instead of from `position`. Its width is
  // still its own.
  //
  // The two are mutually exclusive, which the deck-state invariant already
  // guarantees; the check here keeps the render honest against a hand-built
  // state. A free pane is neither and uses its stored `position`/`size`.
  // Every mode owns its geometry [L09].
  const pinned = sidebarSide !== undefined;
  const imposed = !pinned && placement !== undefined;
  const activeCardId = activeCardIdFromProps ?? stackState.activeCardId;

  const frameRef = useRef<HTMLDivElement>(null);
  const sizePolicy = sizePolicyProp ?? DEFAULT_SIZE_POLICY;
  const stackId = id;
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
  // `pane-frame-registry` for consumers that live outside the pane's React
  // tree. State (not just the ref) so React-tree consumers re-render when the
  // frame mounts. [D19]
  const [frameEl, setFrameEl] = useState<HTMLDivElement | null>(null);
  const frameRefCallback = useCallback((el: HTMLDivElement | null) => {
    frameRef.current = el;
    setFrameEl(el);
  }, []);
  // The slot this frame reads its column's seams, offset and strip from. They
  // stand on the frame itself rather than on an ancestor
  // (`place-properties.ts`), so a frame that comes to stand in a slot adopts
  // the slot's standing values before paint.
  const imposedSlot =
    imposed && placement !== undefined && !bullseye ? placement.slot : null;
  useLayoutEffect(() => {
    const el = frameRef.current;
    if (el === null || imposedSlot === null) return;
    adoptColumnProperties(el, imposedSlot);
  }, [imposedSlot]);
  // The content element the card's host portals into.
  const [contentEl, contentRef] = useState<HTMLDivElement | null>(null);

  const cardsRef = useRef(cards);
  cardsRef.current = cards;
  const activeCardIdRef = useRef(activeCardId);
  activeCardIdRef.current = activeCardId;

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

  // Bridge the frame element through `pane-frame-registry` so card content
  // rendered via `CardPortal` (which lives outside the pane's React tree) can
  // re-provide `TugPaneFrameContext` at the card-host position. [D19, D20]
  useLayoutEffect(() => {
    if (!frameEl) return;
    paneFrameRegistry.register(stackId, frameEl);
    return () => {
      paneFrameRegistry.unregister(stackId);
    };
  }, [stackId, frameEl]);

  // The active card's masthead request ([P14]). The payload object is stable
  // while unchanged, so this is a legitimate `useSyncExternalStore` snapshot.
  const activeCardMasthead = useSyncExternalStore(
    cardTitleStore.subscribe,
    useCallback(
      () => cardTitleStore.getMasthead(activeCardId ?? null),
      [activeCardId],
    ),
  );

  // A card whose body failed has no page to draw its chrome or to answer its
  // close: the shell closes it itself, and its placard (`card-host.tsx`)
  // stands in the frame's content.
  const activeBodyFailed = useSyncExternalStore(
    bodyCardsStore.subscribe,
    useCallback(
      () => activeCardId !== undefined && activeCardId !== null && bodyCardsStore.stateOf(activeCardId) === "failed",
      [activeCardId],
    ),
  );
  const activeBodyFailedRef = useRef(activeBodyFailed);
  activeBodyFailedRef.current = activeBodyFailed;

  // The close and reveal verbs, aimed at this pane from the chain — ⌘W, File
  // ▸ Close All Card Tabs, the Cards card's close box, the reveal chord. The
  // card's page draws the title bar that asks first and the picker that
  // reveals, so the verb goes there, to the active card, and runs on its
  // chain exactly as a press of its own close box does. A card no page stands
  // for is closed here, asking nothing: nothing it held is left to lose.
  const forwardToCard = useCallback(
    (action: string, failed: () => void): void => {
      const cardId = activeCardIdRef.current;
      if (cardId === undefined || cardId === null) return;
      if (activeBodyFailedRef.current) {
        failed();
        return;
      }
      commandForCard.dispatch({ id: action }, { card: cardId });
    },
    [],
  );
  const closeFailedCard = useCallback(() => {
    const currentCards = cardsRef.current;
    const currentActiveId = activeCardIdRef.current;
    if (currentCards !== undefined && currentCards.length > 1 && currentActiveId) {
      store.removeCard(stackId, currentActiveId);
    } else {
      onClose?.();
    }
  }, [store, stackId, onClose]);
  const closeFailedPane = useCallback(() => onClose?.(), [onClose]);

  const { ResponderScope, responderRef } = useResponder({
    id: stackId,
    kind: "card",
    actions: {
      [TUG_ACTIONS.CLOSE]: (_event: ActionEvent) => forwardToCard(TUG_ACTIONS.CLOSE, closeFailedCard),
      [TUG_ACTIONS.CLOSE_ALL]: (_event: ActionEvent) => forwardToCard(TUG_ACTIONS.CLOSE_ALL, closeFailedPane),
      [TUG_ACTIONS.CLOSE_PANE]: (_event: ActionEvent) => forwardToCard(TUG_ACTIONS.CLOSE_PANE, closeFailedPane),
      [TUG_ACTIONS.REVEAL_STACK]: (_event: ActionEvent) => forwardToCard(TUG_ACTIONS.REVEAL_STACK, noop),
      // The depth pair: switch within the slot's stack without reading
      // anything.
      //
      // NEXT raises the LAST entry: `slotStack` is topmost-first, so that is
      // the pane buried longest, raised through the same `onRevealPane` the
      // picker's rows go through — one raise policy for both. Raising the
      // bottom-most is what makes repeated presses a ring rather than a
      // two-pane ping-pong: a depth-N slot is home again after N presses. The
      // raise moves the first responder to the pane that came up, so the
      // *next* press is answered by that pane reading its own freshly-ordered
      // stack.
      [TUG_ACTIONS.NEXT_STACK_CARD]: (_event: ActionEvent) => {
        const slotStack = panePlaceFactsOf(store.getSnapshot(), stackId).slotStack;
        if (slotStack.length <= 1) return;
        const buried = slotStack[slotStack.length - 1];
        if (buried) onRevealPane?.(buried);
      },
      // PREVIOUS is NEXT's exact inverse: this pane leaves the front by
      // going all the way to the back (`sendPaneBehind` the bottom member),
      // fronting the entry beneath it — a true rotation. Focus rides
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
      // The intra-pane tab switch, row 1 of the activation trigger taxonomy
      // (`transferFocusForActivation`, inside `selectTab`).
      [TUG_ACTIONS.SELECT_TAB]: (event: ActionEvent) => {
        if (typeof event.value !== "string") return;
        selectTab(store, stackId, event.value);
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
      // No FIND handler here on purpose: a registered no-op would make the
      // native Edit ▸ Find item validate as enabled while doing nothing.
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
  // Rail-ness follows the ACTIVE card's registration. It reads `layoutRole` —
  // what the card IS — and not `sidebarSide`, which says only where a rail
  // currently stands: a released rail card is still a tool.
  const effectiveLayoutRole: LayoutRole | undefined = activeCardRegistration
    ? activeCardRegistration.layoutRole
    : layoutRole;
  const isRail = effectiveLayoutRole === "sidebar";

  // The floor, from the model ({@link HEADER_HEIGHT_PX}).
  const minSize = {
    width: Math.max(MIN_CONTENT_PX.width, sizePolicy.min.width),
    height: Math.max(
      HEADER_HEIGHT_PX + (hasMultipleCards ? TAB_BAR_HEIGHT_PX : 0) + MIN_CONTENT_PX.height,
      sizePolicy.min.height,
    ),
  };

  const rootRefCallback = useCallback(
    (el: HTMLDivElement | null) => {
      setCardEl(el);
      responderRef(el);
    },
    [responderRef],
  );

  // ---------------------------------------------------------------------------
  // Geometry
  // ---------------------------------------------------------------------------

  // Persisted size can predate the current floor — a card kind raised its
  // policy `min`, or a wider sibling joined the stack. Clamp the rendered
  // frame up to the floor: the pane stands at its true minimum immediately,
  // and the next move or resize commits the corrected size back to the store.
  const renderWidth = Math.max(size.width, minSize.width);
  // …and a CEILING as well as a floor, because the policy can bound one axis
  // alone ([P04]). A folded pane's stored height is the open card's, and the
  // ceiling is what makes a FREE folded pane stand at its tier rather than at
  // the box it remembers. An unbounded axis carries `Infinity`.
  const frameHeight = Math.min(
    Math.max(size.height, minSize.height),
    sizePolicy.max?.height ?? Infinity,
  );

  // A card whose policy pins an axis — `min === max` — is PLACED by the
  // imposition rather than sized by it, and offers no grip on that axis. The
  // pinned axes travel together into `imposeStyle`, which separates the slot
  // from the frame: the slot is an ordinary content card's box, and the
  // pinned card is centred inside it (see `PinnedFrame`).
  const widthPinned = sizePolicy.max?.width === sizePolicy.min.width;
  const heightPinned = sizePolicy.max?.height === sizePolicy.min.height;
  const pinnedFrame: PinnedFrame | undefined =
    widthPinned || heightPinned
      ? {
          ...(widthPinned ? { width: renderWidth } : {}),
          ...(heightPinned ? { height: frameHeight } : {}),
          // A folded card reads from the top of its slot; About floats in
          // the middle of one ([P04]).
          ...(folded ? { anchor: "start" as const } : {}),
        }
      : undefined;
  // A width-pinned card's slot is the deck's content width, not its own — but
  // never narrower than the card.
  const slotWidth =
    widthPinned && contentWidthPx !== undefined
      ? Math.max(contentWidthPx, renderWidth)
      : renderWidth;
  // The height a card's bottom edge gave it in its slot ([B06]). Read where
  // the card stands alone or stacked in its slot, and nowhere else: a split
  // column's heights are its shares, a height-pinned card's height is its
  // own, and a bullseye, a rail, or a newcomer not yet seated has no slot run
  // to stand in. Anchored at the top of the run, and never taller than it.
  const slotHeightApplies =
    imposed &&
    placement !== undefined &&
    columnMember === undefined &&
    !heightPinned &&
    !bullseye &&
    sidebarSide === undefined &&
    arriving === undefined;
  const heldSlotHeight = slotHeightApplies ? stackState.slotHeight : undefined;
  // Bullseye's width is `comfy`, held between the stack's own bounds by the
  // same `resolveContentWidthPx` call the width doors make ([D130]).
  const bullseyeWidth = resolveContentWidthPx(
    DEFAULT_CONTENT_WIDTH,
    sizePolicy.min.width,
    sizePolicy.max?.width,
  );

  // Three geometry modes, and one presentation over them. A pinned sidebar
  // holds one side of the canvas; an imposed pane pins to its place in the
  // imposition chain — or, size-locked, is centred in an ordinary card's
  // slot; a free pane uses its stored left/top/width/height. [L06]/[L09]
  //
  // Bullseye is not a fourth mode: it supersedes whichever mode the pane
  // holds, for as long as the pane holds focus, and writes nothing — so the
  // branch below it is what the frame returns to on exit, unchanged.
  const modeStyle: CSSProperties = bullseye
    ? imposeStyle({ slot: 0, count: 1 }, bullseyeWidth, pinnedFrame)
    : sidebarSide !== undefined
      ? imposeSidebarStyle(sidebarSide, renderWidth, railMember)
      : railParked !== undefined
        ? imposeSidebarStyle(railParked, renderWidth)
      : imposed && placement !== undefined
        ? arriving === "bottom"
          ? // The seat a newcomer will take ([B08]): the bottom of the run at
            // the stack's floor, at the column's width. The overlap with the
            // member above is invisible because the frame is hidden.
            imposeStyle(placement, slotWidth, {
              ...pinnedFrame,
              height: minSize.height,
              anchor: "end",
            })
          : heldSlotHeight !== undefined
            ? heldSlotHeightStyle(placement, slotWidth, pinnedFrame, heldSlotHeight)
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
  // re-resolving the deck's styles every frame (`rail-width-draft.ts`).
  const railTravel = bullseye
    ? railTravelOf({ slot: 0, count: 1 }, bullseyeWidth)
    : sidebarSide === undefined && imposed && placement !== undefined
      ? railTravelOf(placement, slotWidth)
      : undefined;

  // The edges a resize may take. A pane whose resize keeps its slot offers
  // only the edges the arrangement lets move (`keepSlotGripsOf`): in fit a
  // left edge where the slot has travel to give up and a right edge where it
  // is not the last slot's; in flow the right edge alone; a width-locked card
  // neither; never a corner; and a top or bottom only where it borders a seam
  // of a split column sharing its run, or where the pane holds a height. A
  // pane whose resize releases it offers all eight.
  const keepsSlot = resizeKeepsSlot && imposed && placement !== undefined && !bullseye && arriving === undefined;
  const resizeEdges: readonly ResizeEdge[] = keepSlotGripsOf(
    !keepsSlot || placement === undefined
      ? null
      : {
          layout: placement.flow !== undefined ? "flow" : "fit",
          fraction: placement.flow !== undefined ? 0 : travelFraction(placement),
          column:
            columnMember !== undefined && columnMember.count > 1 && columnMember.standing === "shared"
              ? { index: columnMember.index, count: columnMember.count }
              : undefined,
          heightHeld: slotHeightApplies,
          widthPinned,
        },
  );
  // A rail member offers its deck-facing edge, which drags the RAIL's width,
  // and none while it stands in bullseye (`railGripsOf`). Outside a deck
  // canvas there is no draft to drive, so there is no edge either — a handle
  // nothing answers is the silence [L31] forbids.
  const railWidthDrafted = useRailWidthGesture() !== null;
  const grips: readonly ResizeEdge[] =
    barSide !== undefined
      ? railWidthDrafted
        ? railGripsOf(barSide, bullseye)
        : NO_GRIPS
      : resizeEdges;

  // Another pane is in bullseye, so this one leaves the canvas by the
  // horizontal edge it is already nearest. Overrides `left` alone, so the
  // pane slides straight out and straight back.
  //
  // The side is read from `modeStyle.left`, the ACTUAL resolved pin, never
  // from `position.x`, which for an imposed pane is a last-known value the
  // imposer has long since superseded. It is compared against the bullseyed
  // pane's own former centre (`bullseyeExit`), not the canvas centre, so no
  // pane crosses the card arriving at the middle. The comparison stays in
  // CSS: a clamp saturates this pane's centre less that line into one bound
  // or the other, re-resolving on a window resize for free, and the 1px bias
  // breaks an exact tie toward the left. Both bounds park the pane just past
  // its own edge, so the two directions travel equally far.
  const exitStyle: CSSProperties =
    bullseyeExit === undefined
      ? {}
      : {
          left: `clamp(${-(renderWidth + impositionGapPx())}px, (${cssLength(modeStyle.left)} + ${renderWidth / 2}px - ${bullseyeExit} - 1px) * 10000, calc(100% + ${impositionGapPx()}px))`,
        };

  return (
    <div
      ref={frameRefCallback}
      className="tug-pane"
      data-testid="tug-pane"
      data-pane-id={id}
      // The chrome tier the active card wears. CSS turns it into
      // `--tugx-pane-chrome-height`, which every in-pane surface seating below
      // the title bar measures against ([L06]).
      {...(activeCardMasthead !== null ? { "data-masthead": "true" } : {})}
      // WHICH masthead, because the two tiers are different heights ([B04]).
      {...(activeCardMasthead !== null
        ? {
            "data-masthead-kind":
              activeCardMasthead.kind === "session-masthead"
                ? "session"
                : "card",
          }
        : {})}
      // The folded form ([P03]), which surfaces seated below the title bar
      // still read.
      {...(folded ? { "data-folded": "true" } : {})}
      // The card is a view the host stands over this page, and draws the
      // pane's chrome in its own page: this frame is the arrangement's
      // stand-in, laid out and read, painting nothing ([D216], [L06]).
      data-body-card="true"
      // What the host carries the card in its hand by (`placeCards`): the
      // edges the arrangement offers, whether the pane is free, and its floor.
      data-grips={grips.join(" ")}
      data-min-width={String(minSize.width)}
      data-min-height={String(minSize.height)}
      {...(pinned || imposed || bullseye ? {} : { "data-free": "" })}
      // The rail tier, stamped as a pane fact: the scrim, the sheet clip, and
      // the banner all seat below a 32px bar.
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
      // `data-rail-side` carries which edge a rail is pinned to; a released
      // rail has rail chrome with no side.
      {...(sidebarSide !== undefined ? { "data-rail-side": sidebarSide } : {})}
      {...(railTravel !== undefined ? { [RAIL_TRAVEL_ATTR]: railTravel } : {})}
      // A member of a rail that is currently divided rather than stacked —
      // what the seam elements and the reorder drag find their fellow members
      // by.
      {...(railSplit ? { "data-rail-split": "" } : {})}
      // Which card of the rail this frame is, by componentId as the record
      // names it, where it stands top to bottom, and whether it is the LAST
      // member — a fact an index alone cannot say.
      {...(railSplit && sidebarStack !== undefined
        ? {
            "data-rail-member": sidebarStack.componentId,
            "data-rail-member-index": String(sidebarStack.memberIndex),
            ...(sidebarStack.memberIndex === sidebarStack.count - 1
              ? { "data-rail-member-last": "" }
              : {}),
          }
        : {})}
      // A member of a column that is currently divided rather than stacked —
      // what the column seams find their fellow members by. Suppressed under
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
      // Arriving: appended but not yet divided, laid out hidden at its seat
      // ([B01], [B02]). The attribute is what the settle reads to skip the
      // frame.
      {...(arriving !== undefined ? { "data-arriving": arriving } : {})}
      style={{
        position: "absolute",
        ...modeStyle,
        ...exitStyle,
        ...(arriving !== undefined ? { visibility: "hidden" as const } : {}),
        zIndex,
        boxSizing: "border-box",
        // The pane's minimum width, for descendants sized against the floor
        // rather than the live width. [L06]
        ["--tug-pane-min-width" as string]: `${sizePolicy.min.width}px`,
      }}
    >
      {/* The root and content elements the card's host finds by the pane's
          id, filling the frame, so the body's placeholder measures the frame
          itself (`card-placement.ts`). */}
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
    </div>
  );
}

/**
 * A slotted frame standing at a held height: the imposer's fill for its slot,
 * with the vertical pins of the same slot at `height` anchored to the run's
 * top, and never taller than the run — a window made shorter since the drag
 * would otherwise push the card off its bottom.
 */
function heldSlotHeightStyle(
  placement: ImposedPlacement,
  slotWidth: number,
  pinnedFrame: PinnedFrame | undefined,
  height: number,
): CSSProperties {
  const fill = imposeStyle(placement, slotWidth, pinnedFrame);
  const held = imposeStyle(placement, slotWidth, { ...pinnedFrame, height, anchor: "start" });
  return {
    ...fill,
    top: held.top,
    bottom: held.bottom,
    height: held.height,
    maxHeight: `calc(100% - ${cssLength(fill.top)} - ${cssLength(fill.bottom)})`,
  };
}
